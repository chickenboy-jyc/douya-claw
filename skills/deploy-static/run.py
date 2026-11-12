# 静态网站部署技能：本地打包 → 上传 → 远端解压 → 备份/回滚 → 回读校验（可选 nginx 配置）
# 自包含实现：不 import 任何其它技能，仅依赖 paramiko + Python 标准库。
import hashlib
import os
import posixpath
import re
import shlex
import shutil
import tempfile
import time

import paramiko

# 内部 deadline：进程级兜底为 manifest.timeoutMs(900000ms=15min)，
# 这里设 12min，到点主动收尾返回可读错误，避免被进程级 SIGKILL 硬杀。
INTERNAL_DEADLINE_SEC = 12 * 60
POLL_INTERVAL_SEC = 3
LOG_PATH_DEFAULT = "/tmp/douya_deploy.log"


# ---------------------------------------------------------------- 基础工具

def _workspace():
    """返回工作区根目录（Electron 注入 AGENT_WORKSPACE，缺省用 HOME）。"""
    return os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")


def _resolve(ws, p):
    """相对工作区路径解析为绝对路径。"""
    return p if os.path.isabs(p) else os.path.join(ws, p)


def _to_bool(v):
    """把各种真值写法统一为 bool。"""
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on", "是", "真")


def _resolve_spa_wanted(spa_mode):
    """spa_mode 归一化的**唯一实现**（子路径路线与独立站点路线共用）。

    缺省（None）/ 空串 / 纯空白 一律视同「未提供」→ True；其余写法统一走 `_to_bool`。
    这是本文件里 spa_mode 归一化的单一真源，切勿在别处复制该表达式——测试用「变异锚点
    唯一命中」守卫防假过，重复实现会让守卫失效。
    """
    if spa_mode is None or str(spa_mode).strip() == "":
        return True
    return _to_bool(spa_mode)


def _short(text, n=1500):
    """截取字符串尾部 n 个字符，用于回显日志。"""
    text = (text or "").strip()
    return text[-n:] if len(text) > n else text


def _join(head, evidence):
    """拼接「结论首行 + 证据列表」。"""
    if not evidence:
        return head
    return head + "\n\n证据：\n" + "\n".join("· " + e for e in evidence)


# ---------------------------------------------------------------- SSH 连接

def _connect(params):
    """建立 SSH 连接，成功返回 (client, None)，失败返回 (None, 中文错误串)。

    优先使用 key_path 指定的私钥；否则使用密码。
    始终关闭 agent 与本地密钥自动探测（look_for_keys/allow_agent=False）。
    """
    host = (params.get("host") or "").strip()
    username = (params.get("username") or "").strip()
    password = params.get("password") or ""
    key_path = (params.get("key_path") or "").strip()
    try:
        port = int(float(params.get("port") or 22))
    except Exception:
        port = 22

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs = dict(port=port, username=username, timeout=15,
                  allow_agent=False, look_for_keys=False)
    try:
        if key_path:
            key_full = _resolve(_workspace(), key_path)
            if not os.path.exists(key_full):
                return None, "错误：私钥文件不存在：" + key_full
            kwargs["key_filename"] = key_full
        else:
            kwargs["password"] = password
        client.connect(host, **kwargs)
    except Exception as e:
        try:
            client.close()
        except Exception:
            pass
        return None, "连接失败：" + str(e)
    return client, None


def _exec(client, command, timeout=30):
    """执行一条远端命令，返回 (stdout, stderr) 文本。"""
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return out, err


# ------------------------------------------------------- 后台执行 + 轮询日志

def _parse_rc(text):
    """从日志尾部解析最后一条 DOUYA_RC=<code> 的退出码。"""
    idx = text.rfind("DOUYA_RC=")
    if idx == -1:
        return None
    seg = text[idx + len("DOUYA_RC="):].strip().splitlines()
    if not seg:
        return None
    digits = "".join(ch for ch in seg[0] if ch.isdigit())
    return int(digits) if digits else None


def _run_bg(client, remote_dir, cmd, deadline, log_path=LOG_PATH_DEFAULT,
            poll=POLL_INTERVAL_SEC):
    """后台 nohup 执行长命令并轮询日志，绝不单条 exec 死等。

    cmd 会在 remote_dir 下以 sh -c 运行，结束时写入 DOUYA_RC=<退出码>。
    返回 (ok, rc, tail, timed_out)。timed_out=True 表示到达内部 deadline。
    """
    payload = cmd + "\nprintf 'DOUYA_RC=%s\\n' \"$?\""
    # 注意：必须把 ( cd && exec nohup ) 整体重定向后再 & 后台，
    # 否则 & 的优先级低于 &&，后台子 shell 会前台等待 nohup 结束、长期占用 SSH 通道。
    launch = ("( cd %s && exec nohup sh -c %s ) > %s 2>&1 < /dev/null & echo BGPID:$!" %
              (shlex.quote(remote_dir), shlex.quote(payload), shlex.quote(log_path)))
    try:
        out, _ = _exec(client, launch, timeout=20)
    except Exception as e:
        return False, None, "启动后台命令失败：" + str(e), False

    pid = ""
    for tok in out.split():
        if tok.startswith("BGPID:"):
            pid = "".join(ch for ch in tok.split("BGPID:", 1)[1] if ch.isdigit())
    if not pid:
        return False, None, "启动后台命令失败：未取得后台 PID（输出：%s）" % out.strip()[:200], False

    ps_cmd = "ps -p %s > /dev/null 2>&1 && echo ALIVE || echo GONE" % pid
    tail_cmd = "tail -c 3000 %s" % shlex.quote(log_path)
    tail = ""
    while time.time() < deadline:
        time.sleep(poll)
        alive = True
        try:
            aout, _ = _exec(client, ps_cmd, timeout=15)
            alive = "ALIVE" in aout
        except Exception:
            alive = True  # 网络抖动，保守认为仍存活，继续轮询
        try:
            tout, _ = _exec(client, tail_cmd, timeout=15)
            if tout:
                tail = tout
        except Exception:
            pass
        rc = _parse_rc(tail)
        if rc is not None:
            return (rc == 0), rc, tail, False
        if not alive:
            return False, None, tail, False
    return False, None, tail, True


# ---------------------------------------------------------------- 目标校验 / 回读

# 远端目标目录安全闸门。
# 本技能用 `mv <remote_dir> <remote_dir>.bak-<时间戳>` 的方式实现“备份”——这是对整个目录做搬迁。
# 若 remote_dir 落在系统目录上，这一 mv 就是**不可逆的系统破坏**（且 rollback 依赖同一个已损坏的环境，救不回来）。
# 因此这里是一道拒绝清单：只放行明确的“站点根”类路径（/www/x、/var/www/x、/home/u/www、/opt/app、/data/x、/srv/x 等）。
#
# 注意：这些常量两个技能各有一份（技能目录互相独立，不共享模块），改一处务必同步改另一处。
_DENY_ANY_DEPTH = ("etc", "bin", "sbin", "lib", "lib64", "boot", "dev", "proc", "sys", "run", "root")
_DENY_TOPLEVEL = ("usr", "var", "home", "opt", "tmp", "srv", "mnt", "media", "proc", "sys")
_DENY_PREFIX = ("/usr/local", "/usr/bin", "/usr/lib", "/usr/share", "/var/lib", "/var/log", "/var/run")


def _valid_target(remote_dir):
    """校验远端目标目录是否安全，返回 (ok, 错误串)。

    拒绝规则（任一命中即拒）：
      1) 空 / 非绝对路径 / 含 `..` / 归一化后为盘根；
      2) 首层目录属于系统关键目录（任意深度都拒，如 /etc/nginx）；
      3) 归一化后只剩一层且属于系统顶层目录（如 /usr、/var —— 整体替换这些目录 = 灾难）；
      4) 命中前缀拒绝清单（如 /usr/local、/var/log）。
    """
    p = (remote_dir or "").strip().rstrip("/")
    if p in ("", "/", "."):
        return False, "错误：拒绝危险的 remote_dir（不允许根目录/当前目录）：" + str(remote_dir or "")
    if not p.startswith("/"):
        return False, "错误：remote_dir 必须是绝对路径（以 / 开头）：" + str(remote_dir or "")
    parts = [c for c in p.split("/") if c]
    if ".." in parts:
        return False, "错误：拒绝含 `..` 的 remote_dir：" + str(remote_dir or "")
    if parts and parts[0] in _DENY_ANY_DEPTH:
        return False, ("错误：拒绝把系统目录作为 remote_dir：" + str(remote_dir or "") +
                       "（本技能会整体搬迁目标目录做备份，指向系统目录会导致系统损坏）。"
                       "请改用站点目录，如 /www/你的站点/")
    if len(parts) == 1 and parts[0] in _DENY_TOPLEVEL:
        return False, ("错误：拒绝把系统顶层目录作为 remote_dir：" + str(remote_dir or "") +
                       "（本技能会整体搬迁目标目录做备份，整体替换该目录会导致系统损坏）。"
                       "请改用站点目录，如 /www/你的站点/")
    for prefix in _DENY_PREFIX:
        if p == prefix or p.startswith(prefix + "/"):
            return False, ("错误：拒绝把系统目录作为 remote_dir：" + str(remote_dir or "") +
                           "（本技能会整体搬迁目标目录做备份，指向系统目录会导致系统损坏）。"
                           "请改用站点目录，如 /www/你的站点/")
    return True, ""


def _count_local_files(root):
    """统计本地目录下的文件数量（不含目录）。"""
    n = 0
    for _, _, files in os.walk(root):
        n += len(files)
    return n


def _verify(client, remote_dir, key_file):
    """回读校验：远端文件数 + 关键文件是否存在。返回 (remote_count, has_key)。"""
    out, _ = _exec(client, "find %s -type f 2>/dev/null | wc -l" % shlex.quote(remote_dir),
                   timeout=60)
    digits = "".join(ch for ch in out if ch.isdigit())
    remote_count = int(digits) if digits else 0
    kout, _ = _exec(client, "test -f %s && echo YES || echo NO" %
                    shlex.quote(posixpath.join(remote_dir, key_file)), timeout=20)
    return remote_count, ("YES" in kout)


def _fail(host, remote_dir, reason, backed, bak, evidence):
    """构造失败结论（含 rollback 建议）。"""
    head = "❌ 部署失败：%s → %s（%s）" % (host, remote_dir, reason)
    if backed:
        head += "。建议执行 action=rollback 回滚到备份 " + bak
    else:
        head += "。远端未产生备份，rollback 不可用。"
    return _join(head, evidence)


# ------------------------------------------------------ 依赖自动安装（需显式授权）

def _pkg_manager(client):
    """探测远端包管理器。目前只支持 Debian/Ubuntu 系（apt-get），其他发行版返回空串。"""
    out, _ = _exec(client, "command -v apt-get >/dev/null 2>&1 && echo APT_OK || echo APT_MISSING",
                   timeout=20)
    return "apt" if "APT_OK" in out else ""


def _apt_install(client, deadline, pkgs, evidence, what):
    """apt-get 安装包。走后台 nohup + 轮询，绝不单条 exec 死等。返回 (ok, note)。"""
    if not _pkg_manager(client):
        note = ("远端不是 Debian/Ubuntu 系（未检测到 apt-get），本技能不做猜测式安装。"
                "请先手动安装 %s 后重试。" % what)
        evidence.append("自动安装依赖：" + note)
        return False, note
    evidence.append("自动安装依赖：开始 apt-get 安装 %s（后台执行，轮询日志）" % what)
    cmd = ("export DEBIAN_FRONTEND=noninteractive; "
           "(apt-get update -qq || true) && apt-get install -y -qq " + " ".join(pkgs))
    ok, rc, tail, to = _run_bg(client, "/tmp", cmd, deadline, log_path=LOG_PATH_DEFAULT)
    if to:
        note = "apt-get 安装 %s 超时（内部 deadline 到达）" % what
        evidence.append("自动安装依赖：" + note)
        return False, note
    if not ok:
        note = "apt-get 安装 %s 失败（rc=%s）：%s" % (what, rc, _short(tail, 400))
        evidence.append("自动安装依赖：" + note)
        return False, note
    evidence.append("自动安装依赖：%s 安装完成" % what)
    return True, "%s 已安装" % what


# ---------------------------------------------------------------- nginx

# nginx 配置备份目录：**必须落在任何会被 nginx `include` 扫到的目录之外**（conf.d / sites-enabled /
# nginx.conf 同级 *.conf）。旧实现把备份写成 `<conf>.bak-<ts>` 留在 conf.d 内，既是污染配置目录，
# 又因「成功路径从不删除自己刚建的备份」导致每成功部署一次就永久累积一个文件（只增不减、不自愈）。
_NGINX_BAK_DIR = "/var/backups/douya-nginx"

# 本技能产出的备份文件名模式：`douya-*.conf.bak-<时间戳>`，时间戳为「数字」或「数字-数字」。
# 真机教训：时间戳形如 `20260915-182036`（**含连字符**），用 isdigit() 判断会全部漏掉，
# 故这里明确允许连字符。正则锚定 `douya-` 前缀 + `.conf.bak-` + 数字/连字符，绝不误伤用户既有文件。
_NGINX_BAK_RE = re.compile(r"^douya-[A-Za-z0-9._-]*\.conf\.bak-[0-9][0-9-]*$")


def _is_douya_conf_bak(name):
    """判断一个目录项名是否是本技能生成的 nginx 配置备份（供残留自愈清理用）。

    命中：`douya-node-douya-pm2-idem.panyiqi.com.conf.bak-20260915-182036`（含连字符时间戳）、
          `douya-foo.conf.bak-20260915-182036`、`douya-foo.conf.bak-20260915`。
    不命中：用户既有文件 `niuxiaomiao.conf.bak`、当前生效配置本体 `douya-foo.conf`、`other.conf`。
    """
    return bool(_NGINX_BAK_RE.match(name or ""))


def _nginx_bak_path(conf_path, ts):
    """本次备份的绝对路径（写入 / 还原 / 清理三处共用同一变量，避免写死三遍）。

    放在 `_NGINX_BAK_DIR` 下、保留配置文件名 + `.bak-<ts>` 后缀，便于人肉辨认与回滚。
    """
    return posixpath.join(_NGINX_BAK_DIR, posixpath.basename(conf_path) + ".bak-" + ts)


def _consume_backup(client, bak_path):
    """成功路径：消费掉本次备份——只删本次这个**具体路径**（不扫目录、不用通配符）。

    返回供 evidence 拼接的清理结果说明；清理失败不影响部署成功（仅如实记录）。
    该命令**刻意收敛到唯一一处**：既是「写入 / 还原 / 清理三处共用同一变量」的落点，
    也让「成功路径必须消费本次备份」的常驻回归单测有唯一定点可锚——历史上两条成功路径
    （独立站点 / 子路径派生站点）各写一份字面量，曾使变异锚点命中 2 次而令回归误红。
    """
    cout, _ = _exec(client, "rm -f %s && echo RM_OK || echo RM_FAIL" % shlex.quote(bak_path),
                    timeout=20)
    if "RM_OK" in cout:
        return "，本次备份已清理"
    return "，本次备份清理失败（%s），可手动删除" % bak_path


def _cleanup_stale_nginx_baks(client, evidence):
    """清理本技能历史遗留的 nginx 备份（残留自愈）。

    范围严格限定：只删**文件名命中 `_is_douya_conf_bak`** 的项，逐条 `rm -f <具体路径>`，
    **绝不使用通配符整目录删除**，因此用户既有的 `niuxiaomiao.conf.bak` 等非 douya 文件永不受影响。
    扫描两个目录：老的 conf.d（历史遗留所在）与新的备份目录。任何清理失败只记 evidence，不影响部署。
    """
    removed = 0
    failed = 0
    for d in ("/etc/nginx/conf.d", _NGINX_BAK_DIR):
        try:
            out, _ = _exec(client, "ls -1 %s 2>/dev/null || true" % shlex.quote(d), timeout=30)
        except Exception:
            continue
        for name in [n.strip() for n in (out or "").splitlines() if n.strip()]:
            if not _is_douya_conf_bak(name):
                continue
            p = posixpath.join(d, name)
            try:
                rout, _ = _exec(client, "rm -f %s && echo RM_OK || echo RM_FAIL" % shlex.quote(p),
                                timeout=20)
                if "RM_OK" in rout:
                    removed += 1
                else:
                    failed += 1
            except Exception:
                failed += 1
    if removed or failed:
        evidence.append("nginx：清理历史遗留备份 %d 个%s" %
                        (removed, ("，%d 个清理失败（可手动删除）" % failed) if failed else ""))
    return removed


# ------------------------------------------------ 子路径部署（url_path）辅助
#
# 背景：既有实现只能「新开一个独立站点」（conf.d/douya-<域名>.conf，listen 80; server_name X; location /）。
# 当用户想把站点挂到**已被占用的域名**（如 api.example.com）的子路径（如 /miaomiao/）下时，既有实现无路可走，
# 只能把选择丢回用户。本节新增纯函数 + 两个执行函数，支持：
#   · 定位承载该 server_name 的**生效** server 块（sites-enabled/* + conf.d/*.conf，注释/引号感知扫描）；
#   · 在块内插入带固定标记的 `location ^~ /<path>/`（幂等：同名标记块整块替换，异名标记块保留）；
#   · 冲突检测（他人已占同路径 → 安全跳过）；花括号不配平等异常 → 宁可不改也不盲写；
#   · 备份 → 写 → nginx -t → 成功才 reload；失败立即从备份还原并复验，还原后仍失败则报警。
# 全部为纯函数，便于用构造的 nginx 配置文本做正/负样本 + 反向对照单测。

_SUBPATH_BEGIN_FMT = "# >>> douya subpath begin: %s <<<"
_SUBPATH_END_FMT = "# >>> douya subpath end: %s <<<"

# 匹配「成对」的豆芽标记行（用于摘除/识别本技能插入段）。路径 token 不含空白。
_MARKER_BEGIN_RE = re.compile(
    r"^[ \t]*#\s*>>>\s*douya subpath begin:\s*(\S+)\s*<<<[ \t]*$", re.M)
_MARKER_END_RE = re.compile(
    r"^[ \t]*#\s*>>>\s*douya subpath end:\s*(\S+)\s*<<<[ \t]*$", re.M)

# location 指令选择器（modifier 可选：= ^~ ~* ~）
_LOCATION_RE = re.compile(r"(?<![A-Za-z0-9_])location\s+([^;{}]*?)\s*\{")


def _md5_hex(text):
    """返回文本的 md5 十六进制（入参 str / bytes 均可）。"""
    data = text.encode("utf-8") if isinstance(text, str) else text
    return hashlib.md5(data).hexdigest()


def _norm_url_path(raw):
    """规范化用户传入的 url_path。

    返回 (ok, payload, is_empty)：
      · is_empty=True → url_path 未提供（payload=""），调用方应走既有「新建独立站点」逻辑；
      · ok=True       → payload 为规范化后的路径（补前导 /、去尾 /，形如 /miaomiao）；
      · ok=False      → payload 为中文错误说明。
    非法判定：含空白/换行/`; { } #`、含 `..`、非 [A-Za-z0-9._~/-]、或等于根路径 /。
    """
    s = "" if raw is None else str(raw).strip()
    if s == "":
        return True, "", True
    if any(c in s for c in " \t\r\n;{}#"):
        return False, ("url_path 含非法字符（空白、换行、; { } # ）：" + str(raw)), False
    if not s.startswith("/"):
        s = "/" + s
    s = s.rstrip("/")
    if s == "":
        return False, "url_path 不能是根路径 /（那会与站点首页冲突）", False
    if not re.match(r"^/[A-Za-z0-9._~/-]+$", s):
        return False, "url_path 只允许 [A-Za-z0-9._~/-]：" + str(raw), False
    if ".." in [seg for seg in s.split("/") if seg]:
        return False, "url_path 不得含 `..` 路径穿越：" + str(raw), False
    return True, s, False


def _subpath_disp(norm):
    """规范化路径的展示形态（补尾斜杠）：/miaomiao → /miaomiao/。"""
    return norm + "/"


def _blank_comments_and_strings(text):
    """返回与 text **等长** 的副本：`#` 行注释内容与引号字符串内容以空格填充（换行保留）。

    目的：在副本上做花括号配对与关键字正则时，索引与原文一一对应，且不受注释/字符串内的
    `{ } # ;` 干扰。引号内的换行同样保留，以维持行结构与行号。
    """
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "#":
            j = i
            while j < n and text[j] != "\n":
                j += 1
            out.append(" " * (j - i))
            i = j
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(" ")
            i += 1
            while i < n:
                c = text[i]
                if c == "\\" and i + 1 < n:
                    out.append(" ")
                    out.append("\n" if text[i + 1] == "\n" else " ")
                    i += 2
                    continue
                if c == quote:
                    out.append(" ")
                    i += 1
                    break
                out.append("\n" if c == "\n" else " ")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _match_brace(clean, open_idx):
    """在（注释/字符串已抹白的）文本里，从 open_idx 处的 `{` 找配对 `}`；找不到返回 None。"""
    depth = 0
    for i in range(open_idx, len(clean)):
        c = clean[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
    return None


def _find_server_blocks(text):
    """定位配置全文里的所有 `server { ... }` 块。

    返回 (blocks, err)：blocks 为 list[dict]（键：open_idx / close_idx / line_open / line_close），
    err 非空表示存在**未闭合**的 server 块（花括号不配平），调用方应据此安全跳过（不做任何改动）。
    """
    clean = _blank_comments_and_strings(text)
    blocks = []
    for m in re.finditer(r"(?<![A-Za-z0-9_])server\s*\{", clean):
        open_idx = m.end() - 1
        close_idx = _match_brace(clean, open_idx)
        if close_idx is None:
            return None, "检测到未闭合的 server 块（{ 与 } 不配平）"
        blocks.append({
            "open_idx": open_idx,
            "close_idx": close_idx,
            "line_open": text.rfind("\n", 0, open_idx) + 1,
            "line_close": text.rfind("\n", 0, close_idx) + 1,
        })
    return blocks, ""


def _server_names_in_block(text, block):
    """解析某 server 块自身层级的 `server_name ... ;` 指令，返回 token 列表。

    以 server 关键字前不能是字母/数字/下划线/`$` 界定，避免误取 `$server_name` 变量。
    """
    body = text[block["open_idx"] + 1: block["close_idx"]]
    clean = _blank_comments_and_strings(body)
    names = []
    for m in re.finditer(r"(?<![A-Za-z0-9_$])server_name\b([^;]*);", clean):
        for tok in m.group(1).split():
            names.append(tok)
    return names


def _domain_matches(token, domain):
    """server_name 里的单个 token 是否匹配目标域名。

    · `_`（default_server 占位）不算匹配；
    · `*.api.example.com` 视为匹配 api.example.com 及其子域；
    · `~...` 正则 server_name 保守视为不匹配。
    """
    if not token or token == "_" or not domain:
        return False
    if token.startswith("~"):
        return False
    if token.startswith("*."):
        base = token[2:]
        return domain == base or domain.endswith("." + base)
    return token == domain


def _iter_location_selectors(body_text):
    """返回一段 nginx 文本里的 (modifier, path_or_regex) 列表（注释/字符串已抹白）。"""
    clean = _blank_comments_and_strings(body_text)
    sels = []
    for m in _LOCATION_RE.finditer(clean):
        sel = m.group(1).strip()
        mm = re.match(r"^(=|\^~|~\*|~)?\s*(.*)$", sel)
        sels.append((mm.group(1) or "", mm.group(2).strip()))
    return sels


def _selector_conflicts(mod, rest, norm):
    """判断现有 location 选择器与目标 url_path（norm）是否等价冲突。

    · 前缀类（无修饰符 / `=` / `^~`）：去掉尾斜杠后与 norm 相等即冲突；
    · 正则类（`~` / `~*`）：剥离 `^`/`$` 后取字面前缀，与 norm 相等即冲突；
    · 更宽的前缀（如 `location /`、`location ^~ /`）**不算**冲突——我们用 `^~` + 更长前缀正常胜出。
    """
    if mod in ("", "=", "^~"):
        return rest.rstrip("/") == norm
    r = rest.strip()
    if r.startswith("^"):
        r = r[1:]
    r = re.sub(r"\$$", "", r)
    if not r.startswith("/"):
        return False
    lit = re.match(r"^/[A-Za-z0-9._~/-]*", r)
    if not lit:
        return False
    return lit.group(0).rstrip("/") == norm


def _iter_marker_spans(text):
    """产出文本中所有（成对的）豆芽子路径标记块的行区间 [(start, end), ...]。"""
    spans = []
    for m in _MARKER_BEGIN_RE.finditer(text):
        em = _MARKER_END_RE.search(text, m.end())
        if not em:
            continue
        start = text.rfind("\n", 0, m.start()) + 1
        end = text.find("\n", em.end())
        end = len(text) if end == -1 else end + 1
        spans.append((start, end))
    return spans


def _strip_marker_spans(text):
    """摘除文本中所有豆芽子路径标记块，返回剩余文本（用于幂等校验与冲突判定）。"""
    spans = _iter_marker_spans(text)
    if not spans:
        return text
    out = []
    last = 0
    for (s, e) in sorted(spans):
        if s < last:
            continue
        out.append(text[last:s])
        last = e
    out.append(text[last:])
    return "".join(out)


def _find_marker_span(text, disp):
    """返回指定 url_path 标记块在 text 内的 (start, end) 行区间；不存在返回 (None, None)。"""
    b = _SUBPATH_BEGIN_FMT % disp
    bi = text.find(b)
    if bi == -1:
        return None, None
    start = text.rfind("\n", 0, bi) + 1
    e = _SUBPATH_END_FMT % disp
    ei = text.find(e, bi + len(b))
    if ei == -1:
        return None, None
    end = text.find("\n", ei)
    end = len(text) if end == -1 else end + 1
    return start, end


def _line_no(text, idx):
    """idx 处的 1 基行号。"""
    return text.count("\n", 0, idx) + 1


def _build_subpath_location(norm, remote_dir, has_index, spa_mode):
    r"""构造带固定标记的 location 块文本（含首尾标记行，末尾带换行）。

    · 同名场景（remote_dir 末段 == url_path 末段）→ `root` 指向父目录；
    · 不同名场景 → `alias` 指向 remote_dir（尾斜杠）。
    · 一律使用 `^~` 前缀，确保优先于站点既有的 `location ~* \.(js|css)$` 之类正则。
    · SPA 回退仅当远端存在 index.html；否则（或非 SPA）一律回退 `=404`。
      回退目标是 URL（`/<path>/index.html`），不是文件系统路径。
    """
    disp = _subpath_disp(norm)
    last_seg = norm.rsplit("/", 1)[-1]
    rd = (remote_dir or "").rstrip("/")
    rd_last = rd.rsplit("/", 1)[-1]
    spa_wanted = _resolve_spa_wanted(spa_mode)
    if spa_wanted and not has_index:
        spa_wanted = False
    lines = [_SUBPATH_BEGIN_FMT % disp,
             "    location ^~ %s {" % disp]
    if rd and rd_last == last_seg:
        lines.append("        root %s;" % (posixpath.dirname(rd) or "/"))
    else:
        lines.append("        alias %s/;" % rd)
    lines.append("        index index.html;")
    if spa_wanted:
        lines.append("        try_files $uri $uri/ %sindex.html;" % disp)
    else:
        lines.append("        try_files $uri $uri/ =404;")
    lines.append("    }")
    lines.append(_SUBPATH_END_FMT % disp)
    return "\n".join(lines) + "\n"


def _plan_file_subpath_edit(text, domain, norm, loc_block):
    """规划单个配置文件的子路径插入（纯计算，不改远端）。

    返回 dict：
      matched   —— 匹配 domain 的 server 块数；
      changed   —— 新文本（无改动时等于入参 text）；
      edits     —— [(行号, "insert"/"replace")]；
      conflicts —— [(行号, 既有选择器)]（他人在同一 server 块里已占用同路径）；
      skipped   —— True 表示该文件结构异常，未做任何改动（需安全跳过）；
      note      —— skipped 的原因说明。
    """
    disp = _subpath_disp(norm)
    blocks, err = _find_server_blocks(text)
    if blocks is None:
        return {"matched": 0, "changed": text, "edits": [], "conflicts": [],
                "skipped": True, "note": err}
    matched = [b for b in blocks
               if any(_domain_matches(t, domain) for t in _server_names_in_block(text, b))]
    if not matched:
        return {"matched": 0, "changed": text, "edits": [], "conflicts": [],
                "skipped": False, "note": ""}
    conflicts = []
    ops = []
    for b in matched:
        body = text[b["open_idx"] + 1: b["close_idx"]]
        body_nomark = _strip_marker_spans(body)
        hit = None
        for mod, rest in _iter_location_selectors(body_nomark):
            if _selector_conflicts(mod, rest, norm):
                hit = (mod + " " + rest).strip()
                break
        if hit is not None:
            conflicts.append((_line_no(text, b["line_close"]), hit))
            continue
        span = _find_marker_span(body, disp)
        if span[0] is not None:
            s, e = span
            ops.append((b["open_idx"] + 1 + s, b["open_idx"] + 1 + e, loc_block))
        else:
            ops.append((b["line_close"], b["line_close"], loc_block))
    if conflicts:
        return {"matched": len(matched), "changed": text, "edits": [],
                "conflicts": conflicts, "skipped": False, "note": ""}
    new_text = text
    edits = []
    for (s, e, payload) in sorted(ops, key=lambda o: o[0], reverse=True):
        new_text = new_text[:s] + payload + new_text[e:]
        edits.append((_line_no(text, s), "replace" if e > s else "insert"))
    edits.sort()
    return {"matched": len(matched), "changed": new_text, "edits": edits,
            "conflicts": [], "skipped": False, "note": ""}


def _list_live_nginx_confs(client):
    """列出会被 nginx include 的生效配置文件绝对路径：sites-enabled/* 全部 + conf.d/*.conf。"""
    out = []
    for d, pat in (("/etc/nginx/sites-enabled", "*"), ("/etc/nginx/conf.d", "*.conf")):
        o, _ = _exec(client,
                     "for f in %s/%s; do [ -f \"$f\" ] && printf '%%s\\n' \"$f\"; done "
                     "2>/dev/null || true" % (d, pat), timeout=20)
        for line in (o or "").splitlines():
            line = line.strip()
            if line and line not in out:
                out.append(line)
    return out


def _sftp_read_bytes(sftp, path):
    """经 SFTP 读取远端文件原始字节；失败返回 None。"""
    try:
        with sftp.open(path, "rb") as f:
            return f.read()
    except Exception:
        return None


def _apply_nginx_subpath(client, remote_dir, server_name, url_path, ts, evidence,
                         spa_mode=True, has_index=None):
    """url_path 有值时：把站点挂到承载 server_name 的既有生效 server 块的子路径下。

    返回 (ok, note)，语义与 _apply_nginx 一致：
      ok=True  未发生致命错误（可能已生效，也可能安全跳过——见说明文字）；
      ok=False 真正失败（写入后 nginx -t 未通过，已从备份还原）。
    server_name 此处即「目标域名」（_do_deploy 传入的是 `domain or host`）。
    """
    domain = (server_name or "").strip()
    norm = url_path
    disp = _subpath_disp(norm)
    loc_block = _build_subpath_location(norm, remote_dir, has_index, spa_mode)

    files = _list_live_nginx_confs(client)
    if not files:
        note = ("已跳过 nginx 配置：未能枚举到任何生效配置（sites-enabled/conf.d），"
                "无法定位承载 %s 的站点。" % domain)
        evidence.append(note)
        return True, note

    targets = []          # [(path, orig_text, new_text, edits)]
    conflicts = []        # ["<path>:<line>（已有 location X）"]
    unparsed = []         # 结构异常/编码异常、无法安全判定的文件
    matched_any = False

    sftp = client.open_sftp()
    try:
        for p in files:
            raw = _sftp_read_bytes(sftp, p)
            if raw is None:
                unparsed.append("%s（读取失败）" % p)
                continue
            try:
                text = raw.decode("utf-8")
            except Exception:
                unparsed.append("%s（非 UTF-8 文本）" % p)
                continue
            res = _plan_file_subpath_edit(text, domain, norm, loc_block)
            if res["skipped"]:
                unparsed.append("%s（%s）" % (p, res["note"]))
                continue
            if res["matched"]:
                matched_any = True
            for ln, sel in res["conflicts"]:
                conflicts.append("%s:%d（已有 location %s）" % (p, ln, sel))
            if res["changed"] != text and res["edits"]:
                targets.append((p, text, res["changed"], res["edits"]))
    finally:
        sftp.close()

    if conflicts:
        note = ("已跳过 nginx 配置：目标路径 %s 已被现有配置占用，为避免覆盖他人设置，"
                "本次未做任何改动。请换一个子路径后重试。冲突位置：" % disp) + "；".join(conflicts)
        evidence.append(note)
        return True, note

    if not targets and matched_any:
        note = "nginx 子路径 %s 已存在且与本次一致（幂等，无需改动，已跳过写入）。" % disp
        evidence.append(note)
        return True, note

    if not targets:
        if unparsed:
            note = ("已跳过 nginx 配置：未能安全判定承载 %s 的 server 块（宁可不改也不盲写）。详情："
                    % domain) + "；".join(unparsed)
            evidence.append(note)
            return True, note
        # 域名未被任何生效 server 块占用 → 新建站点配置（location 用 ^~ /path/）
        return _write_new_subpath_conf(client, remote_dir, server_name, norm, disp,
                                       loc_block, ts, evidence)

    # ---------------- 备份 → 写 → 验 → 回滚 ----------------
    _exec(client, "mkdir -p %s 2>/dev/null || true" % shlex.quote(_NGINX_BAK_DIR), timeout=20)
    _cleanup_stale_nginx_baks(client, evidence)
    backups = []
    for (p, _orig, _new, _edits) in targets:
        bak = _nginx_bak_path(p, ts)
        bout, _ = _exec(client,
                        "if [ -f %s ]; then cp %s %s && echo BACKED; else echo NEW; fi" %
                        (shlex.quote(p), shlex.quote(p), shlex.quote(bak)), timeout=30)
        backups.append((p, bak, ("BACKED" in bout)))

    sftp = client.open_sftp()
    try:
        for (p, _orig, new, _edits) in targets:
            with sftp.open(p, "wb") as f:
                f.write(new.encode("utf-8"))
    finally:
        sftp.close()

    tout, terr = _exec(client, "nginx -t 2>&1", timeout=30)
    if "successful" not in (tout + terr).lower():
        # 立即从备份还原（这些都是既有文件，备份必然存在）
        for (p, bak, existed) in backups:
            if existed:
                _exec(client, "cp -f %s %s" % (shlex.quote(bak), shlex.quote(p)), timeout=30)
        tout2, terr2 = _exec(client, "nginx -t 2>&1", timeout=30)
        restored_ok = "successful" in (tout2 + terr2).lower()
        head = "nginx 配置测试未通过，已从备份还原（未生效）。"
        if not restored_ok:
            head += "⚠️ 严重：还原后 nginx -t 仍失败，原配置可能已被破坏，请人工介入核验！"
        return False, head + ("（nginx -t 输出：%s）" % _short(tout + terr, 300))

    _exec(client, "nginx -s reload 2>&1 || systemctl reload nginx 2>&1", timeout=40)

    # 证据链：定位结果 + 逐文件「其余内容一字未改」自证 + 备份路径（保留供人工回滚）
    for (p, orig, new, edits) in targets:
        stripped_new = _strip_marker_spans(new)
        same = (stripped_new == _strip_marker_spans(orig))
        evidence.append(
            "nginx 子路径：%s 命中，插入位置 %s；插入前 md5=%s；插入后摘除本技能标记块后 md5=%s"
            "（其余内容一字未改校验：%s）" %
            (p,
             "、".join("第%d行(%s)" % (ln, act) for ln, act in edits),
             _md5_hex(orig), _md5_hex(stripped_new), "通过" if same else "不一致⚠"))
    evidence.append("nginx 子路径：备份保留于 " +
                    "、".join(bak for (_p, bak, _ex) in backups) + "（供人工回滚，未删除）")
    url = "https://%s%s" % (domain, disp)
    note = ("nginx 子路径已生效：%s 已挂到 %s 下（插入 %d 个 server 块），可访问 URL：%s"
            "（实际协议/端口以该站点 listen 为准）" % (disp, domain, len(targets), url))
    evidence.append(note)
    return True, note


def _write_new_subpath_conf(client, remote_dir, server_name, norm, disp, loc_block, ts, evidence):
    """url_path 有值、但域名未被任何生效 server 块占用 → 新建独立站点配置（location 用 ^~）。

    与既有「新建站点」写法保持一致，仅把 `location /` 换成带标记的 `location ^~ /<path>/`。
    """
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in server_name) or "site"
    conf_path = "/etc/nginx/conf.d/douya-%s.conf" % safe
    conf = ("# 由豆芽 deploy-static 生成：子路径 %s（域名 %s 原未被占用）\n"
            "server {\n"
            "    listen 80;\n"
            "    server_name %s;\n"
            "    index index.html;\n"
            "%s"
            "}\n" % (disp, server_name, server_name, loc_block))
    conf_local = os.path.join(tempfile.gettempdir(), "douya_nginx_sub_%s.conf" % ts)
    with open(conf_local, "w", encoding="utf-8") as f:
        f.write(conf)
    try:
        bak_path = _nginx_bak_path(conf_path, ts)
        _exec(client, "mkdir -p %s 2>/dev/null || true" % shlex.quote(_NGINX_BAK_DIR), timeout=20)
        _cleanup_stale_nginx_baks(client, evidence)
        bout, _ = _exec(client,
                        "if [ -f %s ]; then cp %s %s && echo BACKED; else echo NEW; fi" %
                        (shlex.quote(conf_path), shlex.quote(conf_path),
                         shlex.quote(bak_path)), timeout=30)
        existed = "BACKED" in bout
        sftp = client.open_sftp()
        try:
            sftp.put(conf_local, conf_path)
        finally:
            sftp.close()
        tout, terr = _exec(client, "nginx -t 2>&1", timeout=30)
        if "successful" not in (tout + terr).lower():
            if existed:
                _exec(client, "mv -f %s %s" %
                      (shlex.quote(bak_path), shlex.quote(conf_path)), timeout=30)
            else:
                _exec(client, "rm -f " + shlex.quote(conf_path), timeout=30)
            return False, ("nginx 配置测试未通过，已还原（nginx -t 输出：%s）"
                           % _short(tout + terr, 300))
        _exec(client, "nginx -s reload 2>&1 || systemctl reload nginx 2>&1", timeout=40)
        cleanup_note = ""
        if existed:
            cleanup_note = _consume_backup(client, bak_path)
        evidence.append("nginx：域名 %s 未被占用，已新建站点配置 %s（子路径 %s），"
                        "nginx -t 通过，已 reload%s" % (server_name, conf_path, disp, cleanup_note))
        return True, ("nginx 站点 %s 已生效（子路径 %s，域名 %s 原未被占用，按独立站点新建）"
                      % (conf_path, disp, server_name))
    finally:
        try:
            os.remove(conf_local)
        except Exception:
            pass


def _apply_nginx(client, remote_dir, server_name, ts, evidence, spa_mode=True, has_index=None,
                 auto_install=False, deadline=None, url_path=None):
    """生成 nginx 站点配置 → 测试 → 通过才 reload。返回 (ok, 说明)。

    安全：server_name 与 remote_dir 会被原样写入 nginx 配置文件（该文件由 nginx 以 root 身份加载），
    含 `;`/换行/`{`/`}`/`#` 等字符可注入 nginx 指令。因此写入前先做参数校验；不合法则**跳过 nginx 配置**
    并在证据里说明原因（站点内容已上传成功，nginx 只是可选步，不应因此让整个部署失败）。

    spa_mode：是否按单页应用（前端 history 路由）处理 `location /`。
      · True（默认）→ `try_files $uri $uri/ /index.html;`：未命中的路径回退到 index.html，让前端路由接管，
        否则用户在任意子页面刷新（F5）会被 nginx 判为 404。
      · False → 保持纯静态多页站行为：`try_files $uri $uri/ =404;`。
      真值解析统一走本文件既有的 `_to_bool`（接受 true/1/yes/是 等写法）。
    has_index：远端是否已存在 index.html。调用方（_do_deploy）已通过 _verify 取得该信号时应直接传入，
      以避免多一次远端往返；传 None 时本函数会自行回读一次。若请求了 SPA 但远端无 index.html，
      回退目标本身不存在（且可能造成重写循环），此时强制退回 =404 并在证据里说明。

    返回值语义：ok=True 表示「未发生致命错误」（可能已生效，也可能被安全跳过，见说明文字）；
    ok=False 表示真正失败（已按既有逻辑还原配置）。
    特别注意：「远端未安装 nginx」属于**安全跳过**，返回 ok=True——站点文件已上传成功，
    仅仅是把结果当可选步处理、给出准确归因，**不应**因此把整个部署判定为失败（这与「nginx -t 失败」
    的真正致命错误不同，后者才返回 ok=False）。
    auto_install：默认 False。仅当其为 True（用户显式授权）且远端缺 nginx 时，才尝试 apt-get 安装；
      装包会修改用户的服务器环境，属越界动作，故默认绝不自动安装。
    deadline：内部 deadline（time.time() 口径）。缺省时兜底为 now+600s，供自动安装的后台轮询使用。
    """
    if deadline is None:
        deadline = time.time() + 600
    # server_name：必须是合法域名或 IP（首字符为字母/数字，后续字母/数字/点/连字符）。
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$", server_name or ""):
        note = ("已跳过 nginx 配置：server_name 不是合法域名/IP（只允许字母、数字、点、连字符，"
                "且以字母或数字开头）：" + str(server_name or ""))
        evidence.append(note)
        return True, note
    # web 根路径：不得含空白/`;`/`{`/`}`/`#`/换行（这些字符在路径中没有合理场景，且可注入 nginx 指令）。
    if (not remote_dir) or any(c in remote_dir for c in " \t\r\n;{}#"):
        note = ("已跳过 nginx 配置：remote_dir 含非法字符（空白、; { } # ）：" + str(remote_dir or ""))
        evidence.append(note)
        return True, note
    # url_path：可选。空/未提供 → url_empty=True，下方走既有「新建独立站点」逻辑（行为一字不变）；
    # 有值 → url_empty=False，改走「挂到已有域名子路径」路线。非法值 → 沿用「跳过不致命」语义（ok=True）。
    url_ok, url_norm, url_empty = _norm_url_path(url_path)
    if not url_ok:
        note = "已跳过 nginx 配置：" + url_norm
        evidence.append(note)
        return True, note
    # nginx 是否已安装：未安装时不再盲目写配置（否则 `nginx -t` 会因命令不存在而失败，
    # 误导用户去排查配置语法）。默认只给出准确归因，仅在显式授权时才自动安装。
    # 判定口径：**仅在远端明确回报 NGINX_MISSING 时才视为缺失**（fail-open）。理由：
    #   · 真实远端上该探测是一条 `if 装了就回 NGINX_OK，否则回 NGINX_MISSING` 的复合命令，
    #     装了必回 NGINX_OK、没装必回 NGINX_MISSING，不存在“无回显”；
    #   · 输出为空/异常只可能来自瞬时 SSH 抖动等非“未安装”情形，此时保守地沿用既有行为
    #     （照常写配置、由 nginx -t 兜底），避免把可用的部署误判为“已跳过”。
    chk, _ = _exec(client, "command -v nginx >/dev/null 2>&1 && echo NGINX_OK || echo NGINX_MISSING",
                   timeout=20)
    if "NGINX_MISSING" in chk:
        if not auto_install:
            note = ("已跳过 nginx 配置：远端未安装 nginx（站点文件已上传成功，但对外访问需要 nginx）。"
                    "请先安装 nginx 后重试，或设 auto_install=true 让豆芽自动安装。")
            evidence.append(note)
            return True, note
        iok, inote = _apt_install(client, deadline, ["nginx"], evidence, "nginx")
        if not iok:
            note = "已跳过 nginx 配置：远端未安装 nginx 且自动安装失败：" + inote
            evidence.append(note)
            return True, note
        chk2, _ = _exec(client, "command -v nginx >/dev/null 2>&1 && echo NGINX_OK || echo NGINX_MISSING",
                        timeout=20)
        if "NGINX_OK" not in chk2:
            note = "已跳过 nginx 配置：自动安装 nginx 后仍未检测到。"
            evidence.append(note)
            return True, note
        evidence.append("自动安装依赖：nginx 已可用，继续写入站点配置")
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in server_name) or "site"
    conf_path = "/etc/nginx/conf.d/douya-%s.conf" % safe
    # index.html 是否存在：优先复用调用方（_do_deploy）已通过 _verify 取得的信号，避免多一次远端往返；
    # 未提供（None）时才回读一次。
    if has_index is None:
        _, has_index = _verify(client, remote_dir, "index.html")
    # url_path 有值 → 走「挂到已有域名子路径」新路线；无 url_path 时下方逻辑**一字不变**（红线）。
    if not url_empty:
        return _apply_nginx_subpath(client, remote_dir, server_name, url_norm, ts, evidence,
                                    spa_mode=spa_mode, has_index=has_index)
    # SPA（前端 history 路由）需把未命中的路径回退到 /index.html，否则刷新子页面会 404。
    # 但若远端不存在 index.html，回退目标本身不存在（且可能造成重写循环），此时强制退回 =404。
    # 本函数签名默认 spa_mode=True；显式传 None / 空串 / 纯空白时按「默认开启」处理
    # （防御性：与签名语义一致，也与 _do_deploy 解析层的空串语义一致）。
    spa_wanted = _resolve_spa_wanted(spa_mode)
    if spa_wanted and not has_index:
        evidence.append("nginx：请求了 SPA 模式，但远端未检出 index.html，已回退为 =404"
                        "（回退到不存在的 index.html 无意义且可能造成循环）。")
        spa_wanted = False
    if spa_wanted:
        # 注：回退目标是本函数拼的常量 `/index.html`，非用户输入，不构成注入。
        location_line = "    location / { try_files $uri $uri/ /index.html; }\n"
    else:
        location_line = "    location / { try_files $uri $uri/ =404; }\n"
    conf = ("server {\n"
            "    listen 80;\n"
            "    server_name %s;\n"
            "    root %s;\n"
            "    index index.html;\n"
            "%s"
            "}\n" % (server_name, remote_dir, location_line))
    conf_local = os.path.join(tempfile.gettempdir(), "douya_nginx_%s.conf" % ts)
    with open(conf_local, "w", encoding="utf-8") as f:
        f.write(conf)
    try:
        # 备份路径变量化：写入 / 还原 / 清理三处共用；备份落在 conf.d 之外（不参与 nginx 加载）。
        bak_path = _nginx_bak_path(conf_path, ts)
        _exec(client, "mkdir -p %s 2>/dev/null || true" % shlex.quote(_NGINX_BAK_DIR), timeout=20)
        # 写配置前顺带清理本技能历史遗留备份（含老实现留在 conf.d 里的 .bak-<ts>）。
        _cleanup_stale_nginx_baks(client, evidence)
        bout, _ = _exec(client,
                        "if [ -f %s ]; then cp %s %s && echo BACKED; else echo NEW; fi" %
                        (shlex.quote(conf_path), shlex.quote(conf_path),
                         shlex.quote(bak_path)), timeout=30)
        existed = "BACKED" in bout
        sftp = client.open_sftp()
        try:
            sftp.put(conf_local, conf_path)
        finally:
            sftp.close()
        tout, terr = _exec(client, "nginx -t 2>&1", timeout=30)
        if "successful" not in (tout + terr).lower():
            # 测试失败 → 还原：从**新位置**取回备份写回 conf_path（备份随之被消费，故无需再删）。
            if existed:
                _exec(client, "mv -f %s %s" %
                      (shlex.quote(bak_path), shlex.quote(conf_path)), timeout=30)
            else:
                _exec(client, "rm -f " + shlex.quote(conf_path), timeout=30)
            return False, "nginx 配置测试未通过，已还原（nginx -t 输出：%s）" % _short(tout + terr, 300)
        _exec(client, "nginx -s reload 2>&1 || systemctl reload nginx 2>&1", timeout=40)
        # 成功路径：消费掉本次备份（只删本次这个**具体路径**，不扫目录/不用通配符；清理失败不影响部署）。
        cleanup_note = ""
        if existed:
            cleanup_note = _consume_backup(client, bak_path)
        evidence.append("nginx：已写入 %s，nginx -t 通过，已 reload%s" % (conf_path, cleanup_note))
        return True, "nginx 配置 %s 已生效（server_name=%s）" % (conf_path, server_name)
    finally:
        try:
            os.remove(conf_local)
        except Exception:
            pass


# ---------------------------------------------------------------- deploy

def _do_deploy(client, params, deadline, host, username):
    """执行部署主流程。"""
    ws = _workspace()
    local_dir = (params.get("local_dir") or "").strip()
    remote_dir = (params.get("remote_dir") or "").strip()
    if not local_dir:
        return "错误：deploy 需要 local_dir（本地网站目录）"
    ok, msg = _valid_target(remote_dir)
    if not ok:
        return msg
    local_full = _resolve(ws, local_dir)
    if not os.path.isdir(local_full):
        return "错误：本地目录不存在：" + local_full
    # 反「打包整块盘」：os.path.dirname 对盘根返回自身（"/" → "/"、"C:\" → "C:\"）
    if os.path.dirname(os.path.normpath(local_full)) == os.path.normpath(local_full):
        return "错误：local_dir 不能是磁盘根目录：" + local_full
    # 反「空目录清空线上」：必须在上传前就拦住，否则远端旧版本已被 mv 走
    local_count = _count_local_files(local_full)
    if local_count == 0:
        return "错误：本地目录里没有任何文件，拒绝用它覆盖线上：" + local_full

    nginx_use = _to_bool(params.get("nginx_use"))
    # 依赖自动安装：默认关闭（缺省/空串/非真值 = False），只有显式 auto_install=true 才会改动远端系统。
    # 默认关闭是刻意的——装包会修改用户的服务器环境，属于需用户显式授权的越界动作。
    auto_install = _to_bool(params.get("auto_install"))
    # spa_mode 默认 True：绝大多数现代前端为 SPA（history 路由）；默认 False 等于默认让用户的网站
    # 在任意子页面刷新即 404。显式传 false/0/no/否 才关闭；真值解析统一走 _to_bool。
    spa_mode_raw = params.get("spa_mode")
    # 缺省（None）与空串/纯空白都视同「未提供」→ 默认 True。
    # 理由：模型填可选参数时常输出空串；若把空串判成 False，用户的站点会静默退回「刷新子页 404」，
    # 与 manifest 里「默认 true」的说明相反。
    spa_mode = (True if spa_mode_raw is None or str(spa_mode_raw).strip() == ""
                else _to_bool(spa_mode_raw))
    domain = (params.get("domain") or "").strip()
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = remote_dir.rstrip("/") + ".bak-" + ts
    log_path = LOG_PATH_DEFAULT

    evidence = []
    zip_path = None
    backed = False
    try:
        # 1) 备份旧内容（若远端目标目录已存在）
        parent = posixpath.dirname(remote_dir.rstrip("/")) or "/"
        cmd_bak = ("mkdir -p %s && if [ -d %s ]; then mv %s %s && echo BACKED_UP; "
                   "else echo NO_EXISTING; fi && mkdir -p %s" % (
                       shlex.quote(parent), shlex.quote(remote_dir), shlex.quote(remote_dir),
                       shlex.quote(bak), shlex.quote(remote_dir)))
        bout, _ = _exec(client, cmd_bak, timeout=60)
        backed = "BACKED_UP" in bout
        evidence.append("备份：" + (("已把旧目录移至 " + bak) if backed else "远端无旧目录，跳过备份"))

        # 2) 本地打包
        zip_base = os.path.join(tempfile.gettempdir(), "douya_static_" + ts)
        zip_path = shutil.make_archive(zip_base, "zip", local_full)
        remote_zip = "/tmp/douya_static_%s.zip" % ts
        size = os.path.getsize(zip_path)
        evidence.append("打包：本地 %d 个文件 → %s（%.1f KB）" %
                        (local_count, os.path.basename(zip_path), size / 1024.0))

        # 3) 上传
        sftp = client.open_sftp()
        try:
            sftp.put(zip_path, remote_zip)
        finally:
            sftp.close()
        evidence.append("上传：→ " + remote_zip)

        # 4) 远端解压（后台 + 轮询）
        unpack = ("if command -v unzip >/dev/null 2>&1; then unzip -o -q %s -d %s; "
                  "elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e %s %s; "
                  "else echo NO_UNZIP_TOOL; exit 3; fi") % (
                      shlex.quote(remote_zip), shlex.quote(remote_dir),
                      shlex.quote(remote_zip), shlex.quote(remote_dir))
        uok, urc, utail, uto = _run_bg(client, remote_dir, unpack, deadline, log_path=log_path)
        if uto:
            return _fail(host, remote_dir, "解压超时（内部 deadline 到达）", backed, bak, evidence)
        if not uok:
            evidence.append("解压输出：" + _short(utail))
            return _fail(host, remote_dir, "解压失败（rc=%s）" % urc, backed, bak, evidence)

        # 5) 清理远端 zip
        _exec(client, "rm -f " + shlex.quote(remote_zip), timeout=20)

        # 6) 回读校验
        remote_count, has_key = _verify(client, remote_dir, "index.html")
        evidence.append("回读校验：远端 %d 个文件（本地 %d）；index.html %s" %
                        (remote_count, local_count, "存在" if has_key else "缺失"))
        if remote_count == 0 or not has_key:
            return _fail(host, remote_dir,
                         "回读校验未通过（远端文件数=%d，index.html=%s）" %
                         (remote_count, "存在" if has_key else "缺失"), backed, bak, evidence)

        # 7) nginx（可选）
        nginx_note = ""
        if nginx_use:
            nok, nmsg = _apply_nginx(client, remote_dir, domain or host, ts, evidence,
                                     spa_mode=spa_mode, has_index=has_key,
                                     auto_install=auto_install, deadline=deadline,
                                     url_path=params.get("url_path"))
            if not nok:
                return _fail(host, remote_dir, nmsg, backed, bak, evidence)
            nginx_note = nmsg

        head = "✅ 静态网站部署成功：%s@%s → %s（远端 %d 文件，index.html 存在）" % (
            username, host, remote_dir, remote_count)
        if nginx_note:
            head += "；" + nginx_note
        return _join(head, evidence)
    except Exception as e:
        return _fail(host, remote_dir, "部署过程中出错：" + str(e), backed, bak, evidence)
    finally:
        try:
            if zip_path and os.path.exists(zip_path):
                os.remove(zip_path)
        except Exception:
            pass


# ---------------------------------------------------------------- rollback

def _do_rollback(client, params, host, username):
    """回滚：把最近一个 .bak-* 还原回 remote_dir。"""
    remote_dir = (params.get("remote_dir") or "").strip()
    ok, msg = _valid_target(remote_dir)
    if not ok:
        return msg
    base = remote_dir.rstrip("/")
    out, _ = _exec(client, "ls -1dt %s.bak-* 2>/dev/null | head -1" % shlex.quote(base),
                   timeout=30)
    bak = out.strip().splitlines()[0].strip() if out.strip() else ""
    if not bak:
        return "错误：未找到备份，无法回滚（期望存在 %s.bak-*）。" % base

    ts = time.strftime("%Y%m%d-%H%M%S")
    failed = base + ".failed-" + ts
    cmd = ("if [ -d %s ]; then mv %s %s; fi && mv %s %s && echo ROLLED_OK" % (
        shlex.quote(remote_dir), shlex.quote(remote_dir), shlex.quote(failed),
        shlex.quote(bak), shlex.quote(remote_dir)))
    rout, rerr = _exec(client, cmd, timeout=60)
    if "ROLLED_OK" not in rout:
        return "❌ 回滚失败：%s → %s（输出：%s %s）" % (
            bak, remote_dir, _short(rout, 200), _short(rerr, 200))
    remote_count, has_key = _verify(client, remote_dir, "index.html")
    return _join(
        "✅ 回滚成功：%s → %s（远端 %d 文件，index.html %s）" %
        (bak, remote_dir, remote_count, "存在" if has_key else "缺失"),
        ["被替换的当前版本已移至 " + failed, "操作者：%s@%s" % (username, host)])


# ---------------------------------------------------------------- status

def _do_status(client, params, host, username):
    """查看远端目标目录现状。"""
    remote_dir = (params.get("remote_dir") or "").strip()
    ok, msg = _valid_target(remote_dir)
    if not ok:
        return msg
    base = remote_dir.rstrip("/")
    out, _ = _exec(client, "if [ -d %s ]; then echo DIR_EXISTS; else echo DIR_MISSING; fi" %
                   shlex.quote(remote_dir), timeout=30)
    if "DIR_EXISTS" not in out:
        return "ℹ️ 状态：%s@%s 上 %s 不存在（尚未部署）。" % (username, host, remote_dir)
    remote_count, has_key = _verify(client, remote_dir, "index.html")
    bout, _ = _exec(client, "ls -1dt %s.bak-* 2>/dev/null | head -5" % shlex.quote(base),
                    timeout=30)
    baks = [l.strip() for l in bout.strip().splitlines() if l.strip()]
    dout, _ = _exec(client, "df -h %s 2>/dev/null | tail -1" % shlex.quote(remote_dir), timeout=30)
    ev = ["远端 %d 个文件；index.html %s" % (remote_count, "存在" if has_key else "缺失"),
          "可用备份数：%d" % len(baks)]
    for b in baks:
        ev.append("备份：" + b)
    if dout.strip():
        ev.append("磁盘：" + dout.strip())
    return _join("ℹ️ 状态：%s@%s → %s 已部署（远端 %d 文件）" %
                 (username, host, remote_dir, remote_count), ev)


# ---------------------------------------------------------------- 入口

def main(params):
    """技能入口：由 bootstrap 单独加载并调用。返回字符串结果（不 print）。"""
    params = params or {}
    deadline = time.time() + INTERNAL_DEADLINE_SEC
    action = (params.get("action") or "").strip().lower()
    if action not in ("deploy", "rollback", "status"):
        return "错误：action 只支持 deploy/rollback/status"
    host = (params.get("host") or "").strip()
    username = (params.get("username") or "").strip()
    if not host or not username:
        return "错误：请提供 host（服务器地址）和 username（用户名）"

    client, err = _connect(params)
    if err:
        return err
    try:
        if action == "status":
            return _do_status(client, params, host, username)
        if action == "rollback":
            return _do_rollback(client, params, host, username)
        return _do_deploy(client, params, deadline, host, username)
    except Exception as e:
        return "操作失败：" + str(e)
    finally:
        try:
            client.close()
        except Exception:
            pass
