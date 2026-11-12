# -*- coding: utf-8 -*-
"""数据库只读查询技能（db-query）—— 让豆芽能查库里的事实数据。

设计取向（安全是第一性原理，这个技能敢存在的唯一理由是安全）
------------------------------------------------------------------
老板要求「数据库直连」。真实风险是「一次误操作能毁数据」，因此本技能是**受控只读版**，
把安全性当成功能的一部分来交付，而不是事后补丁：

① SQL 白名单守卫（``guard_sql``）
   - 只放行**单条** ``SELECT`` / ``WITH … SELECT``（含前置括号形态）；其余一律拒绝。
   - 词法级归一化后判定，不是「按分号拆字符串取第一段」那种可被绕过的做法：
     先剥离注释与字符串/标识符字面量，再对骨架做「首词 + 黑名单关键词 + 敏感系统表」三重判定；
     显式拒绝 MySQL 的**可执行注释** ``/*! … */``（服务端会当真执行其内容）。
   - 拒绝多语句、``INTO OUTFILE`` / ``INTO DUMPFILE`` / ``LOAD_FILE`` / ``SLEEP`` / ``BENCHMARK`` 等。

② 资源护栏
   - 行数上限（默认 200，硬上限 2000），采用「最多读 limit+1 行再收手」来判定是否截断；
   - 客户端套接字超时 + 尽力开启服务端 ``max_execution_time``（MariaDB 为 ``max_statement_time``）；
   - 单结果集线上字节上限、单单元格字符上限、总输出字符上限，避免撑爆上下文。

③ 双保险（守卫之外的纵深防御）
   - 握手能力位**绝不包含** ``CLIENT_MULTI_STATEMENTS`` ⇒ 服务端自己就会拒绝多语句；
   - 尽力 ``SET SESSION TRANSACTION READ ONLY`` ⇒ 会话级只读，写操作在服务端被挡；
   - 结果集首包为 ``0xfb``（LOCAL INFILE）时直接拒绝，避免被诱导读服务端文件。

④ 凭据安全（本项目铁律）
   - 密码只存在于本进程内存：不走命令行、不写临时文件、不进日志/输出/报告；
   - 输出里只出现**掩码后的连接目标**（IPv4 末段打码）、表名、行数、以及原样回显的 SQL。

⑤ 诚实红线
   - 连不上 / 认证失败 / 库不存在 / SQL 被拒 / 0 行 —— 全部如实返回，绝不静默降级成「看起来成功」，
     更不编造数据。

实现说明：本技能**自包含**（与项目内 deploy-* / ssh-exec 一致），不 import 任何其它技能。
打包 runtime 里**没有** pymysql / mysql-connector-python / mariadb，且不允许往 runtime 装包，
因此这里用 Python 标准库实现了一个**最小可用的 MySQL 客户端协议**（握手 / 认证 / COM_QUERY / 结果集解析），
如需访问仅内网可达的库，则用 paramiko 的 ``direct-tcpip`` 通道建立 SSH 隧道（paramiko 打包 runtime 内已有）。
"""

import hashlib
import os
import re
import socket
import struct
import time

# --------------------------------------------------------------------------- #
# 常量：护栏默认值与硬上限
# --------------------------------------------------------------------------- #

DEFAULT_LIMIT = 200
HARD_MAX_LIMIT = 2000
DEFAULT_TIMEOUT_MS = 30000
MAX_TIMEOUT_MS = 60000
MIN_TIMEOUT_MS = 1000

MAX_CELL_CHARS = 200          # 单个单元格最长字符数（超出截断并标注）
MAX_WIRE_BYTES = 2000000      # 单结果集最多读取的线上字节数（超出即判截断）
MAX_OUTPUT_CHARS = 200000     # 返回文本总长上限（防撑爆大模型上下文）

# 内部兜底 deadline：manifest.timeoutMs 是 180000ms，这里 150s 主动收尾，
# 避免被进程级 SIGKILL 硬杀后连错误信息都拿不到。
INTERNAL_DEADLINE_SEC = 150

# --------------------------------------------------------------------------- #
# 1) SQL 白名单守卫
# --------------------------------------------------------------------------- #

# 命中即拒绝的语句/子句关键词（在「去注释、去字面量」后的骨架上按词匹配，大小写无关）。
#
# 说明：这是**黑名单**，但不作为唯一防线 —— 首词必须 SELECT/WITH、多语句必须拒绝、
# 且服务端没开 MULTI_STATEMENTS + 会话只读，四层叠加。
_DENY_KEYWORDS = frozenset("""
INSERT UPDATE DELETE DROP TRUNCATE ALTER CREATE GRANT REVOKE REPLACE RENAME
LOAD OUTFILE DUMPFILE INFILE INTO CALL EXECUTE PREPARE DEALLOCATE
HANDLER LOCK UNLOCK BEGIN COMMIT ROLLBACK SAVEPOINT
ANALYZE OPTIMIZE REPAIR FLUSH KILL SHUTDOWN RESET PURGE
INSTALL UNINSTALL START STOP SIGNAL XA DO USE SET PROCEDURE
""".split())

# 命中即拒绝的函数名（数据外泄 / 拖库 / 长期占用连接）。
# LOAD_FILE：用 SELECT 读服务端任意文件；SLEEP/BENCHMARK：拿 SELECT 做 DoS。
_DENY_FUNCTIONS = frozenset("""
LOAD_FILE SLEEP BENCHMARK GET_LOCK RELEASE_LOCK
MASTER_POS_WAIT SOURCE_POS_WAIT WAIT_FOR_EXECUTED_GTID_SET
""".split())

# 凭证/权限类系统表：只读也可能读到不该被对话带出来的东西，直接拒绝。
_SENSITIVE_TABLES = (
    r"user|global_priv|db|tables_priv|columns_priv|procs_priv|roles_mapping|"
    r"servers|func|plugin|ssl|password_history|user_attributes|"
    r"user_privileges|schema_privileges|table_privileges|column_privileges"
)
_SENSITIVE_RE = re.compile(
    r"(?:mysql|information_schema)\s*`?\s*\.\s*`?\s*(?:" + _SENSITIVE_TABLES + r")\b",
    re.IGNORECASE,
)

# 语句结束分号判定：只允许结尾那一个（且其后只有空白）。
_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")
_BACKTICK_RE = re.compile(r"`[^`]*`")


class SqlRejected(Exception):
    """SQL 未通过只读守卫。message 面向用户，需说明拒绝原因。"""


def _scan_literals(sql):
    """词法扫描：剥离注释与字面量，返回可做关键词判定的「骨架串」。

    规则（与 MySQL 词法对齐，尽量不产生「我们以为在字符串里、服务端却当成语句」的偏差）：
      · ``/* … */`` 块注释 → 空格；但 ``/*! … */`` 是**可执行注释**（服务端会执行其中内容）→ 直接拒绝；
      · ``--`` 行注释：MySQL 要求 ``--`` 后跟空白或行尾，否则是减号运算；
      · ``#`` 行注释 → 空格；
      · ``'…'`` / ``"…"`` 字符串字面量 → 空格（其中的分号/关键词不再参与判定，避免误判）；
      · ``` `…` ``` 标识符 → 原样保留（内容里的关键词不是关键词，但保留内容便于识别敏感系统表）。

    :raises SqlRejected: 出现未闭合的注释/引号、或可执行注释 ``/*!``。
    """
    out = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]

        # 块注释
        if ch == "/" and i + 1 < n and sql[i + 1] == "*":
            end = sql.find("*/", i + 2)
            if end < 0:
                raise SqlRejected("SQL 里有未闭合的块注释 /*")
            inner = sql[i + 2:end]
            if inner.startswith("!"):
                raise SqlRejected(
                    "SQL 里有 MySQL 可执行注释 /*! … */（服务端会执行其中内容，属绕过手段）"
                )
            out.append(" ")
            i = end + 2
            continue

        # -- 行注释（MySQL 语义：-- 之后必须是空白或行尾）
        if ch == "-" and i + 1 < n and sql[i + 1] == "-":
            nxt = sql[i + 2:i + 3]
            if nxt == "" or nxt in (" ", "\t", "\r", "\n", "\f", "\v"):
                nl = sql.find("\n", i + 2)
                i = n if nl < 0 else nl + 1
                out.append(" ")
                continue
            out.append(ch)
            i += 1
            continue

        # # 行注释
        if ch == "#":
            nl = sql.find("\n", i + 1)
            i = n if nl < 0 else nl + 1
            out.append(" ")
            continue

        # 字符串 / 标识符
        if ch in ("'", '"', "`"):
            j, content = _scan_quoted(sql, i, ch)
            if ch == "`":
                # 标识符：保留反引号与内容（把 `` `` `` / `` \` `` 归一为单引号字符，便于后续正则匹配）
                safe = content.replace("``", "`").replace("\\`", "`")
                safe = safe.replace("`", "'")
                out.append("`" + safe + "`")
            else:
                out.append(" ")
            i = j
            continue

        out.append(ch)
        i += 1
    return "".join(out)


def _scan_quoted(sql, start, quote):
    """从 ``start``（指向起始引号）扫描一个字面量，返回 (下一个位置, 原始内容)。

    同时支持反斜杠转义与双写引号转义（MySQL 两种都认）。未闭合 → 拒绝。
    """
    i = start + 1
    n = len(sql)
    while i < n:
        ch = sql[i]
        if ch == "\\":
            i += 2
            continue
        if ch == quote:
            if i + 1 < n and sql[i + 1] == quote:
                i += 2
                continue
            return i + 1, sql[start + 1:i]
        i += 1
    raise SqlRejected("SQL 里有未闭合的引号（%s）" % quote)


def _first_keyword(skeleton):
    """骨架串里第一个「词」（跳过前置空白与左括号），大写返回；无词返回空串。"""
    s = skeleton.strip()
    while s.startswith("("):
        s = s[1:].lstrip()
    m = _WORD_RE.match(s)
    return m.group(0).upper() if m else ""


def guard_sql(sql):
    """只读守卫：判定 SQL 是否可执行。

    :param str sql: 原始 SQL 文本。
    :returns: ``(ok: bool, sql_to_run: str, reason: str)``。
        ok=True 时 ``sql_to_run`` 是**真正发给数据库**的语句（去掉结尾分号与首尾空白），
        ok=False 时 ``reason`` 说明拒绝原因。
    """
    if not isinstance(sql, str):
        return False, "", "sql 参数必须是字符串"
    if "\x00" in sql:
        return False, "", "SQL 含 NUL 字节"
    if not sql.strip():
        return False, "", "SQL 为空"

    try:
        skeleton = _scan_literals(sql)
    except SqlRejected as e:
        return False, "", str(e)

    # —— 多语句判定：骨架里只允许出现一个分号，且必须在结尾 ——
    if ";" in skeleton:
        positions = [idx for idx, c in enumerate(skeleton) if c == ";"]
        if len(positions) > 1 or skeleton[positions[0] + 1:].strip() != "":
            return False, "", "检测到多条语句（只允许单条 SELECT）"

    # —— 关键词扫描：先剥掉反引号标识符内容，避免把「列名叫 delete」误当关键词 ——
    words_skeleton = _BACKTICK_RE.sub(" ", skeleton).upper()
    tokens = _WORD_RE.findall(words_skeleton)

    # 首词必须是 SELECT 或 WITH（WITH … SELECT 的写形态由下面的黑名单兜住）
    first = _first_keyword(skeleton)
    if first not in ("SELECT", "WITH"):
        return False, "", "只允许 SELECT 查询（含 WITH … SELECT），实际以 %s 开头" % (first or "空语句")

    for tok in tokens:
        if tok in _DENY_KEYWORDS:
            return False, "", "包含被禁止的关键词 %s（写操作/管理语句/子句）" % tok
        if tok in _DENY_FUNCTIONS:
            return False, "", "包含被禁止的函数 %s（可用于读服务端文件或做资源耗尽攻击）" % tok

    # —— 敏感系统表（凭证/权限）—— 反引号写法也要挡住 ——
    if _SENSITIVE_RE.search(skeleton):
        return False, "", "禁止查询 MySQL 凭证/权限类系统表"

    # 真正发给数据库的语句：去掉结尾分号与首尾空白（服务端不需要分号）
    to_run = sql.strip()
    if to_run.endswith(";"):
        to_run = to_run[:-1].rstrip()
    if not to_run:
        return False, "", "SQL 为空"
    return True, to_run, ""


# --------------------------------------------------------------------------- #
# 2) 最小 MySQL 客户端协议（标准库实现，无第三方驱动）
# --------------------------------------------------------------------------- #

CLIENT_LONG_PASSWORD = 1
CLIENT_LONG_FLAG = 4
CLIENT_CONNECT_WITH_DB = 8
CLIENT_PROTOCOL_41 = 512
CLIENT_TRANSACTIONS = 8192
CLIENT_SECURE_CONNECTION = 32768
CLIENT_MULTI_STATEMENTS = 1 << 16   # 故意永不置位（服务端据此拒绝多语句）
CLIENT_MULTI_RESULTS = 1 << 17
CLIENT_PLUGIN_AUTH = 1 << 19
CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 1 << 21

# utf8mb4_general_ci
_CHARSET_UTF8MB4 = 45


class MySQLError(Exception):
    """MySQL 协议层/服务端返回的错误，message 面向用户。"""


def _lenenc_bytes(b):
    """把 bytes 编码为 MySQL 长度编码字符串（用于握手响应里的认证数据）。"""
    n = len(b)
    if n < 0xFB:
        return bytes((n,)) + b
    if n < 0x10000:
        return b"\xfc" + struct.pack("<H", n) + b
    if n < 0x1000000:
        return b"\xfd" + struct.pack("<I", n)[:3] + b
    return b"\xfe" + struct.pack("<Q", n) + b


def _lenenc_int(buf, pos):
    """解码长度编码整数，返回 (值或 None, 新位置)。"""
    if pos >= len(buf):
        raise MySQLError("结果包被截断（读长度编码整数越界）")
    first = buf[pos]
    if first < 0xFB:
        return first, pos + 1
    if first == 0xFB:
        return None, pos + 1
    if first == 0xFC:
        return int.from_bytes(buf[pos + 1:pos + 3], "little"), pos + 3
    if first == 0xFD:
        return int.from_bytes(buf[pos + 1:pos + 4], "little"), pos + 4
    if first == 0xFE:
        return int.from_bytes(buf[pos + 1:pos + 9], "little"), pos + 9
    raise MySQLError("非法的长度编码整数首字节 0x%02x" % first)


def _lenenc_str(buf, pos):
    """解码长度编码字符串，返回 (bytes 或 None, 新位置)。"""
    n, pos = _lenenc_int(buf, pos)
    if n is None:
        return None, pos
    if pos + n > len(buf):
        raise MySQLError("结果包被截断（字符串长度越界）")
    return buf[pos:pos + n], pos + n


def _parse_err_packet(pkt):
    """解析 ERR 包，返回 (错误码, SQLSTATE, 错误信息)。"""
    code = int.from_bytes(pkt[1:3], "little") if len(pkt) >= 3 else 0
    pos = 3
    state = ""
    if len(pkt) > 3 and pkt[3:4] == b"#":
        state = pkt[4:9].decode("ascii", "replace")
        pos = 9
    msg = pkt[pos:].decode("utf-8", "replace") if pos < len(pkt) else ""
    return code, state, msg


def _parse_handshake(pkt):
    """解析服务端初始握手包（protocol version 10）。"""
    pos = 1
    end = pkt.find(b"\x00", pos)
    if end < 0:
        raise MySQLError("握手包格式异常（服务端版本字符串未终止）")
    server_version = pkt[pos:end].decode("utf-8", "replace")
    pos = end + 1
    if pos + 4 + 8 + 1 > len(pkt):
        raise MySQLError("握手包被截断")
    connection_id = int.from_bytes(pkt[pos:pos + 4], "little")
    pos += 4
    auth1 = pkt[pos:pos + 8]
    pos += 8
    pos += 1  # filler
    if pos + 2 > len(pkt):
        raise MySQLError("握手包被截断（能力位缺失）")
    cap_lo = int.from_bytes(pkt[pos:pos + 2], "little")
    pos += 2
    if pos >= len(pkt):
        # 极老的协议：没有 4.1 段的字段
        return {
            "server_version": server_version,
            "connection_id": connection_id,
            "capabilities": cap_lo,
            "scramble": auth1,
            "auth_plugin": "mysql_native_password",
        }
    charset = pkt[pos]
    pos += 1
    status = int.from_bytes(pkt[pos:pos + 2], "little") if pos + 2 <= len(pkt) else 0
    pos += 2
    cap_hi = int.from_bytes(pkt[pos:pos + 2], "little") if pos + 2 <= len(pkt) else 0
    pos += 2
    capabilities = cap_lo | (cap_hi << 16)
    auth_len = pkt[pos] if pos < len(pkt) else 0
    pos += 1
    pos += 10  # reserved

    auth2 = b""
    if capabilities & CLIENT_SECURE_CONNECTION:
        n2 = max(13, auth_len - 8)
        auth2 = pkt[pos:pos + n2]
        pos += n2
    scramble = (auth1 + auth2).rstrip(b"\x00")[:20]

    plugin = "mysql_native_password"
    if capabilities & CLIENT_PLUGIN_AUTH and pos < len(pkt):
        end = pkt.find(b"\x00", pos)
        if end < 0:
            end = len(pkt)
        candidate = pkt[pos:end].decode("utf-8", "replace")
        if candidate:
            plugin = candidate

    return {
        "server_version": server_version,
        "connection_id": connection_id,
        "capabilities": capabilities,
        "charset": charset,
        "status": status,
        "scramble": scramble,
        "auth_plugin": plugin,
    }


def _native_password_token(password, scramble):
    """mysql_native_password：SHA1(pw) XOR SHA1(scramble + SHA1(SHA1(pw)))。"""
    if not password:
        return b""
    pw = password.encode("utf-8")
    h1 = hashlib.sha1(pw).digest()
    h2 = hashlib.sha1(h1).digest()
    h3 = hashlib.sha1(scramble + h2).digest()
    return bytes(a ^ b for a, b in zip(h1, h3))


def _sha2_password_token(password, scramble):
    """caching_sha2_password 快速认证：SHA256(pw) XOR SHA256(SHA256(SHA256(pw)) + scramble)。"""
    if not password:
        return b""
    pw = password.encode("utf-8")
    h1 = hashlib.sha256(pw).digest()
    h2 = hashlib.sha256(h1).digest()
    h3 = hashlib.sha256(h2 + scramble).digest()
    return bytes(a ^ b for a, b in zip(h1, h3))


def _auth_token(plugin, password, scramble):
    """按认证插件生成首次握手响应里的认证数据。"""
    if plugin in ("mysql_native_password", "", None):
        return _native_password_token(password, scramble)
    if plugin == "caching_sha2_password":
        return _sha2_password_token(password, scramble)
    if plugin == "sha256_password":
        return b""  # 需要走完整认证（RSA 加密），由上层继续协商
    raise MySQLError(
        "不支持的认证插件：%s（请为该只读账号改用 mysql_native_password 或 caching_sha2_password）"
        % plugin
    )


def _rsa_encrypt_password(pem, password, scramble):
    """非 TLS 下 caching_sha2_password / sha256_password 完整认证：RSA-OAEP(SHA1) 加密异或后的口令。"""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except Exception as e:  # pragma: no cover - 打包 runtime 内已有 cryptography
        raise MySQLError(
            "MySQL 8 的 caching_sha2_password 首次认证需要 RSA 加密，但运行环境缺少 cryptography 库：%s" % e
        )
    try:
        pub = serialization.load_pem_public_key(pem)
    except Exception as e:
        raise MySQLError("解析服务端 RSA 公钥失败：%s" % e)
    data = password.encode("utf-8") + b"\x00"
    if not scramble:
        raise MySQLError("认证随机数缺失，无法完成 RSA 加密认证")
    blob = bytes(a ^ b for a, b in zip(data, (scramble * (len(data) // len(scramble) + 1))))
    try:
        return pub.encrypt(
            blob,
            padding.OAEP(mgf=padding.MGF1(hashes.SHA1()), algorithm=hashes.SHA1(), label=None),
        )
    except Exception as e:
        raise MySQLError("RSA 加密密码失败：%s" % e)


class _PacketStream:
    """把「类 socket 传输层」（真 socket 或 paramiko Channel）包成 MySQL 包读取器。"""

    def __init__(self, sock):
        self._sock = sock
        self._buf = b""

    def _fill(self, need):
        while len(self._buf) < need:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise MySQLError("连接被对端关闭")
            self._buf += chunk

    def read_exact(self, n):
        if n <= 0:
            return b""
        self._fill(n)
        data = self._buf[:n]
        self._buf = self._buf[n:]
        return data

    def read_packet(self):
        """读一个 MySQL 包，返回 (sequence_id, payload)。"""
        header = self.read_exact(4)
        length = header[0] | (header[1] << 8) | (header[2] << 16)
        seq = header[3]
        return seq, (self.read_exact(length) if length else b"")


def _write_packet(sock, seq, payload):
    length = len(payload)
    header = bytes((length & 0xFF, (length >> 8) & 0xFF, (length >> 16) & 0xFF, seq & 0xFF))
    sock.sendall(header + payload)


def _parse_column_name(pkt):
    """从列定义包里取列名（第 5 个长度编码字符串）。"""
    pos = 0
    for _ in range(4):  # catalog / schema / table / org_table
        _, pos = _lenenc_str(pkt, pos)
    name, pos = _lenenc_str(pkt, pos)
    if name is None:
        return "?"
    return name.decode("utf-8", "replace")


def _parse_row(pkt, ncols):
    """解析一行文本协议数据，返回长度 ncols 的列表（None 表示 SQL NULL）。"""
    values = []
    pos = 0
    for _ in range(ncols):
        if pos >= len(pkt):
            values.append(None)
            continue
        if pkt[pos] == 0xFB:
            values.append(None)
            pos += 1
            continue
        raw, pos = _lenenc_str(pkt, pos)
        values.append(raw)
    return values


class MySQLClient:
    """最小可用的 MySQL 客户端：握手 → 认证 → COM_QUERY → 结果集解析。"""

    def __init__(self, sock, timeout_sec):
        self._sock = sock
        self._stream = _PacketStream(sock)
        self._seq = 0
        # 套接字级超时：read/recv 超时会抛 socket.timeout，由 main 统一转成可读错误。
        try:
            sock.settimeout(timeout_sec)
        except Exception:
            pass
        self.server_info = {}

    # ---------------------------------------------------------------- 包收发
    def _send(self, payload):
        _write_packet(self._sock, self._seq, payload)
        self._seq = (self._seq + 1) & 0xFF

    def _recv(self):
        seq, payload = self._stream.read_packet()
        self._seq = (seq + 1) & 0xFF
        return payload

    def _raise_if_err(self, pkt, what):
        if pkt and pkt[0] == 0xFF:
            code, state, msg = _parse_err_packet(pkt)
            raise MySQLError("%s（错误码 %d%s）：%s" % (what, code, (" " + state) if state else "", msg))

    # ---------------------------------------------------------------- 连接
    def connect(self, username, password, database):
        """完成握手与认证。"""
        pkt = self._recv()
        if not pkt or pkt[0] != 0x0A:
            raise MySQLError("服务端未返回 MySQL 握手包（该端口可能不是 MySQL，或前面有代理）")
        self.server_info = _parse_handshake(pkt)
        self._authenticate(username, password, database, self.server_info)

    def _authenticate(self, username, password, database, hs):
        caps = hs["capabilities"]
        plugin = hs["auth_plugin"]
        scramble = hs["scramble"]

        client_caps = (
            CLIENT_LONG_PASSWORD
            | CLIENT_LONG_FLAG
            | CLIENT_PROTOCOL_41
            | CLIENT_TRANSACTIONS
            | CLIENT_SECURE_CONNECTION
            | CLIENT_PLUGIN_AUTH
            | CLIENT_MULTI_RESULTS
            | CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
        )
        if database:
            client_caps |= CLIENT_CONNECT_WITH_DB
        # 只保留服务端也支持的能力位；CLIENT_MULTI_STATEMENTS 永不置位（纵深防御）。
        client_caps &= caps
        client_caps &= ~CLIENT_MULTI_STATEMENTS

        token = _auth_token(plugin, password, scramble)

        buf = bytearray()
        buf += struct.pack("<I", client_caps & 0xFFFFFFFF)
        buf += struct.pack("<I", 0)  # max packet size
        buf += bytes((_CHARSET_UTF8MB4,))
        buf += b"\x00" * 23
        buf += username.encode("utf-8") + b"\x00"
        if client_caps & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA:
            buf += _lenenc_bytes(token)
        elif client_caps & CLIENT_SECURE_CONNECTION:
            buf += bytes((len(token),)) + token
        else:
            buf += token + b"\x00"
        if client_caps & CLIENT_CONNECT_WITH_DB:
            buf += database.encode("utf-8") + b"\x00"
        if client_caps & CLIENT_PLUGIN_AUTH:
            buf += plugin.encode("utf-8") + b"\x00"

        self._send(bytes(buf))
        self._finish_auth(password, scramble, plugin)

    def _finish_auth(self, password, scramble, plugin):
        full_plugin = plugin if plugin else "mysql_native_password"
        while True:
            pkt = self._recv()
            if not pkt:
                raise MySQLError("认证阶段收到空包")
            head = pkt[0]

            if head == 0x00:  # OK
                return
            if head == 0xFF:  # ERR
                code, state, msg = _parse_err_packet(pkt)
                raise MySQLError(
                    "认证失败（错误码 %d%s）：%s" % (code, (" " + state) if state else "", msg)
                )
            if head == 0xFE:  # AuthSwitchRequest
                body = pkt[1:]
                end = body.find(b"\x00")
                if end < 0:
                    raise MySQLError("认证切换请求格式异常")
                new_plugin = body[:end].decode("utf-8", "replace")
                new_scramble = body[end + 1:].rstrip(b"\x00") or scramble
                scramble = new_scramble
                full_plugin = new_plugin
                if new_plugin == "mysql_native_password":
                    self._send(_native_password_token(password, scramble))
                    continue
                if new_plugin == "caching_sha2_password":
                    self._send(_sha2_password_token(password, scramble))
                    continue
                if new_plugin == "sha256_password":
                    self._send(b"")
                    continue
                raise MySQLError("不支持的认证插件：%s" % new_plugin)
            if head == 0x01:  # AuthMoreData
                more = pkt[1:]
                if not more:
                    raise MySQLError("认证附加数据为空")
                if more[0] == 0x03:  # fast auth success，后面还有 OK 包
                    continue
                if more[0] == 0x04:  # 需要完整认证
                    request_byte = 0x01 if full_plugin == "sha256_password" else 0x02
                    self._request_public_key(password, scramble, request_byte)
                    continue
                raise MySQLError("认证阶段收到未知附加数据 0x%02x" % more[0])
            raise MySQLError("认证阶段收到未知包 0x%02x" % head)

    def _request_public_key(self, password, scramble, request_byte):
        self._send(bytes((request_byte,)))
        pkt = self._recv()
        if not pkt:
            raise MySQLError("请求 RSA 公钥时收到空包")
        self._raise_if_err(pkt, "请求 RSA 公钥失败")
        if pkt[0] != 0x01:
            raise MySQLError("请求 RSA 公钥失败：服务端返回 0x%02x" % pkt[0])
        self._send(_rsa_encrypt_password(pkt[1:], password, scramble))

    # ---------------------------------------------------------------- 查询
    def query(self, sql, limit):
        """执行一条 SQL（仅由守卫放行的 SELECT），返回结果字典。

        注意：本方法**不做**安全判定；调用方必须先过 ``guard_sql``。
        """
        self._send(b"\x03" + sql.encode("utf-8"))  # COM_QUERY
        return self._read_result(limit)

    def _read_result(self, limit):
        started = time.time()
        pkt = self._recv()
        if not pkt:
            raise MySQLError("执行 SQL 后连接被对端关闭")
        head = pkt[0]

        self._raise_if_err(pkt, "MySQL 报错")
        if head == 0x00:  # OK：没有结果集
            return {
                "has_resultset": False,
                "columns": [],
                "rows": [],
                "truncated": False,
                "elapsed_ms": int((time.time() - started) * 1000),
            }
        if head == 0xFB:
            raise MySQLError("服务端要求发送本地文件（LOCAL INFILE），只读技能已拒绝")

        ncols, _ = _lenenc_int(pkt, 0)
        if not ncols:
            raise MySQLError("列数为 0，无法解析结果集")

        columns = []
        for _ in range(ncols):
            cpkt = self._recv()
            if not cpkt:
                raise MySQLError("读取列定义时连接被关闭")
            self._raise_if_err(cpkt, "读取列定义失败")
            columns.append(_parse_column_name(cpkt))

        # 列定义之后是中间 EOF（未启用 CLIENT_DEPRECATE_EOF）；若服务端未发，则把它当第一行。
        nxt = self._recv()
        first_row = None
        if not (nxt and nxt[0] == 0xFE and len(nxt) < 9):
            self._raise_if_err(nxt, "读取结果集失败")
            first_row = nxt

        rows = []
        truncated = False
        wire = 0
        if first_row is not None:
            rows.append(_parse_row(first_row, ncols))
            wire += len(first_row)

        while True:
            pkt = self._recv()
            if not pkt:
                raise MySQLError("结果集读取中途连接被关闭")
            self._raise_if_err(pkt, "读取数据失败")
            if pkt[0] == 0xFE and len(pkt) < 9:  # 结束 EOF
                break
            if len(rows) >= limit:
                # 还有下一行 ⇒ 说明被行数护栏截断；不再继续读，收手（随后 close 会中止传输）
                truncated = True
                break
            wire += len(pkt)
            if wire > MAX_WIRE_BYTES:
                truncated = True
                break
            rows.append(_parse_row(pkt, ncols))

        return {
            "has_resultset": True,
            "columns": columns,
            "rows": rows,
            "truncated": truncated,
            "elapsed_ms": int((time.time() - started) * 1000),
        }

    # ---------------------------------------------------------------- 会话加固
    def apply_readonly_session(self, timeout_ms):
        """尽力开启服务端侧的只读事务与语句超时，返回人类可读的说明列表。"""
        notes = []
        ok, msg = self._try_statement("SET SESSION TRANSACTION READ ONLY")
        notes.append("会话只读事务：已开启" if ok else "会话只读事务：未能开启（%s）" % msg)

        ok2, _ = self._try_statement("SET SESSION max_execution_time=%d" % int(timeout_ms))
        if ok2:
            notes.append("服务端语句超时：%d ms（已生效）" % int(timeout_ms))
        else:
            ok3, _ = self._try_statement(
                "SET SESSION max_statement_time=%.3f" % (timeout_ms / 1000.0)
            )
            if ok3:
                notes.append("服务端语句超时：%d ms（MariaDB max_statement_time 已生效）" % int(timeout_ms))
            else:
                notes.append(
                    "服务端语句超时：未能设置，仅依赖客户端 %d ms 套接字超时" % int(timeout_ms)
                )
        return notes

    def _try_statement(self, sql):
        """内部使用：执行一条加固语句（**绕过守卫**，仅限本模块硬编码的白名单语句）。"""
        try:
            self._send(b"\x03" + sql.encode("utf-8"))
            self._read_result(1)
            return True, ""
        except MySQLError as e:
            return False, str(e)

    def close(self):
        try:
            self._send(b"\x01")  # COM_QUIT
        except Exception:
            pass
        try:
            self._sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# 3) 传输层：直连 / SSH 隧道
# --------------------------------------------------------------------------- #

def _open_direct(host, port, timeout_sec):
    """直连数据库端口。"""
    try:
        sock = socket.create_connection((host, port), timeout=timeout_sec)
    except socket.gaierror as e:
        raise MySQLError("无法解析数据库地址 %s：%s" % (host, e))
    except ConnectionRefusedError:
        raise MySQLError(
            "数据库拒绝连接（%s:%d）——端口可能不对，或该端口未对当前网络放行" % (host, port)
        )
    except (socket.timeout, TimeoutError):
        raise MySQLError(
            "连接数据库 %s:%d 超时（%d ms）——可能被防火墙丢弃；若库只监听内网，请填 ssh_host 走 SSH 隧道"
            % (host, port, int(timeout_sec * 1000))
        )
    except OSError as e:
        raise MySQLError("连接数据库 %s:%d 失败：%s" % (host, port, e))
    sock.settimeout(timeout_sec)
    return sock


def _open_ssh_tunnel(params, db_host, db_port, timeout_sec):
    """经 SSH 跳板机建立 direct-tcpip 隧道，返回 (类 socket 通道, SSHClient)。"""
    try:
        import paramiko
    except Exception as e:  # pragma: no cover - 打包 runtime 内已有 paramiko
        raise MySQLError("需要 SSH 隧道，但运行环境缺少 paramiko：%s" % e)

    ssh_host = _s(params.get("ssh_host"))
    ssh_user = _s(params.get("ssh_username"))
    ssh_port = _int(params.get("ssh_port"), 22, 1, 65535)
    ssh_password = params.get("ssh_password")
    ssh_password = ssh_password if isinstance(ssh_password, str) else ""
    ssh_key_path = _s(params.get("ssh_key_path"))

    if not ssh_user:
        raise MySQLError("填了 ssh_host 就必须同时提供 ssh_username")

    key_full = None
    if ssh_key_path:
        ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
        key_full = ssh_key_path if os.path.isabs(ssh_key_path) else os.path.join(ws, ssh_key_path)
        if not os.path.isfile(key_full):
            raise MySQLError("SSH 私钥文件不存在：%s" % key_full)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        if key_full:
            client.connect(
                ssh_host, port=ssh_port, username=ssh_user, key_filename=key_full,
                timeout=timeout_sec, allow_agent=False, look_for_keys=False,
            )
        else:
            client.connect(
                ssh_host, port=ssh_port, username=ssh_user, password=ssh_password,
                timeout=timeout_sec, allow_agent=False, look_for_keys=False,
            )
    except Exception as e:
        try:
            client.close()
        except Exception:
            pass
        raise MySQLError("SSH 连接失败（%s:%d）：%s" % (ssh_host, ssh_port, e))

    try:
        chan = client.get_transport().open_channel(
            "direct-tcpip", (db_host, db_port), ("127.0.0.1", 0), timeout=timeout_sec
        )
    except Exception as e:
        try:
            client.close()
        except Exception:
            pass
        raise MySQLError(
            "SSH 隧道建立失败（%s → %s:%d）：%s（服务端可能禁用了 TCP 转发）"
            % (ssh_host, db_host, db_port, e)
        )
    chan.settimeout(timeout_sec)
    return chan, client


# --------------------------------------------------------------------------- #
# 4) 结果格式化
# --------------------------------------------------------------------------- #

def _mask_host(host):
    """连接目标脱敏：IPv4 末段打码；域名原样（域名不是口令，保留便于用户核对）。"""
    m = re.match(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$", host or "")
    if m:
        return "%s.%s.%s.*" % (m.group(1), m.group(2), m.group(3))
    return host or "?"


def _mask_target(host, port):
    return "%s:%s" % (_mask_host(host), port)


def _cell_text(value):
    """单元格 → 单行文本：NULL 显式标注，控制符转义，超长截断并标注。"""
    if value is None:
        return "NULL"
    text = value.decode("utf-8", "replace") if isinstance(value, (bytes, bytearray)) else str(value)
    text = text.replace("\r\n", "⏎").replace("\n", "⏎").replace("\r", "⏎").replace("\t", " ")
    text = text.replace("|", "\\|")
    if len(text) > MAX_CELL_CHARS:
        text = text[:MAX_CELL_CHARS] + "…(+%d字符)" % (len(text) - MAX_CELL_CHARS)
    return text


def _format_result(sql, route, database, notes, res, limit, timeout_ms):
    """把执行结果格式化成给大模型/用户看的文本（绝不含任何凭据）。"""
    lines = []
    lines.append("【数据库只读查询】")
    lines.append("连接：%s" % route)
    lines.append("默认库：%s" % (database or "(未指定，按 SQL 内的 库名.表名 解析)"))
    lines.append("护栏：最多 %d 行；查询超时 %d ms" % (limit, timeout_ms))
    for note in notes:
        lines.append("会话加固：%s" % note)
    lines.append("")
    lines.append("实际执行的 SQL（原样回显，供核对）：")
    lines.append(sql)
    lines.append("")

    if not res.get("has_resultset"):
        lines.append("结果：该语句没有返回结果集（只读守卫只放行 SELECT，正常不应出现此情况）。")
        return _clip_output("\n".join(lines))

    columns = res.get("columns") or []
    rows = res.get("rows") or []
    truncated = bool(res.get("truncated"))
    elapsed = int(res.get("elapsed_ms") or 0)

    lines.append("列（%d）：%s" % (len(columns), ", ".join(columns)))
    if truncated:
        lines.append(
            "返回：前 %d 行（实际行数更多，**已截断**）；耗时 %d ms。"
            "如需完整数据，请加 WHERE 条件收窄范围，或显式调大 limit（上限 %d）。"
            % (len(rows), elapsed, HARD_MAX_LIMIT)
        )
    else:
        lines.append("返回：%d 行；耗时 %d ms。" % (len(rows), elapsed))

    if not rows:
        lines.append("")
        lines.append("数据：0 行（查询成功执行，确实没有匹配的数据）。")
        return _clip_output("\n".join(lines))

    header = "| " + " | ".join(_cell_text(c) for c in columns) + " |"
    divider = "|" + "|".join(["---"] * len(columns)) + "|"
    lines.append("")
    lines.append("数据：")
    lines.append(header)
    lines.append(divider)
    for row in rows:
        cells = []
        for idx in range(len(columns)):
            cells.append(_cell_text(row[idx] if idx < len(row) else None))
        lines.append("| " + " | ".join(cells) + " |")
    if truncated:
        lines.append("…（后续行已省略）")
    return _clip_output("\n".join(lines))


def _clip_output(text):
    """整段输出裁剪：头 70% + 尾 30%，避免超长结果撑爆上下文。"""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    head = int(MAX_OUTPUT_CHARS * 0.7)
    tail = MAX_OUTPUT_CHARS - head
    return "%s\n…（输出过长，中间省略 %d 字符）…\n%s" % (
        text[:head], len(text) - head - tail, text[-tail:]
    )


def _one_line(text):
    """把 SQL 压成一行，便于塞进错误消息。"""
    return re.sub(r"\s+", " ", text or "").strip()


# --------------------------------------------------------------------------- #
# 5) 参数小工具
# --------------------------------------------------------------------------- #

def _s(value):
    """任意值 → 去空白字符串（None → 空串）。"""
    if value is None:
        return ""
    return value.strip() if isinstance(value, str) else str(value).strip()


def _int(value, default, low, high):
    """任意值 → 夹到 [low, high] 的整数；非法/缺省用 default（再夹一次）。"""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        num = default
    else:
        try:
            num = int(float(value))
        except Exception:
            num = default
    return max(low, min(high, num))


# --------------------------------------------------------------------------- #
# 6) 入口
# --------------------------------------------------------------------------- #

def main(params):
    """技能入口：由 bootstrap 单独加载并调用，返回字符串结果（不 print）。"""
    params = params or {}
    if not isinstance(params, dict):
        return "错误：参数格式不正确（应为对象）"

    # ---- 先过守卫，任何写操作/多语句在**建立连接之前**就被拒绝 ----
    ok, sql_to_run, reason = guard_sql(params.get("sql"))
    if not ok:
        return (
            "错误：SQL 被只读守卫拒绝——%s\n"
            "本技能只允许单条 SELECT（含 WITH … SELECT）：拒绝写操作、多语句、"
            "INTO OUTFILE/DUMPFILE、LOAD_FILE 等。" % reason
        )

    host = _s(params.get("host"))
    username = _s(params.get("username"))
    if not host:
        return "错误：请提供 host（数据库地址）"
    if not username:
        return "错误：请提供 username（数据库用户名）"

    database = _s(params.get("database"))
    port = _int(params.get("port"), 3306, 1, 65535)
    limit = _int(params.get("limit"), DEFAULT_LIMIT, 1, HARD_MAX_LIMIT)
    timeout_ms = _int(params.get("timeout_ms"), DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    password = params.get("password")
    password = password if isinstance(password, str) else ""
    timeout_sec = timeout_ms / 1000.0

    ssh_host = _s(params.get("ssh_host"))
    deadline = time.time() + INTERNAL_DEADLINE_SEC

    # ---- 建连 ----
    mysql = None
    ssh_client = None
    try:
        if ssh_host:
            ssh_port = _int(params.get("ssh_port"), 22, 1, 65535)
            route = "SSH 隧道 %s → %s" % (_mask_target(ssh_host, ssh_port), _mask_target(host, port))
            sock, ssh_client = _open_ssh_tunnel(params, host, port, timeout_sec)
        else:
            route = "直连 %s" % _mask_target(host, port)
            sock = _open_direct(host, port, timeout_sec)
    except MySQLError as e:
        return "错误：%s" % e
    except Exception as e:
        return "错误：建立连接失败——%s" % e

    try:
        if time.time() > deadline:
            return "错误：连接阶段即超时（超过内部 %ds 上限），请检查网络后重试。" % INTERNAL_DEADLINE_SEC

        mysql = MySQLClient(sock, timeout_sec)
        try:
            mysql.connect(username, password, database)
        except MySQLError as e:
            return "错误：数据库握手/认证失败——%s" % e
        except (socket.timeout, TimeoutError):
            return "错误：数据库握手/认证超时（> %d ms）。" % timeout_ms

        notes = mysql.apply_readonly_session(timeout_ms)

        try:
            res = mysql.query(sql_to_run, limit)
        except MySQLError as e:
            return "错误：SQL 执行失败——%s\n（SQL 原样回显：%s）" % (e, _one_line(sql_to_run))
        except (socket.timeout, TimeoutError):
            return (
                "错误：SQL 执行超时（> %d ms）已被中断。请加 WHERE 条件或更窄的时间范围后重试。\n"
                "（SQL 原样回显：%s）" % (timeout_ms, _one_line(sql_to_run))
            )
    except MySQLError as e:
        return "错误：%s" % e
    except (socket.timeout, TimeoutError):
        return "错误：与数据库通信超时（> %d ms）。" % timeout_ms
    except Exception as e:
        return "错误：查询过程异常——%s" % e
    finally:
        try:
            if mysql is not None:
                mysql.close()
        except Exception:
            pass
        try:
            if ssh_client is not None:
                ssh_client.close()
        except Exception:
            pass

    return _format_result(sql_to_run, route, database, notes, res, limit, timeout_ms)


if __name__ == "__main__":  # pragma: no cover - 仅供本地手测
    import json
    import sys
    print(main(json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}))
