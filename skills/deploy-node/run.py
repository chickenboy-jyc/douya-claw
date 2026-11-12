# Node 服务部署技能：本地打包 → 上传 → 远端解压 → 备份/回滚 → 依赖安装 → pm2 托管 → 健康检查
# 自包含实现：不 import 任何其它技能，仅依赖 paramiko + Python 标准库。
import hashlib
import json
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
NPM_LOG_DEFAULT = "/tmp/douya_npm.log"


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


def _short(text, n=1500):
    """截取字符串尾部 n 个字符，用于回显日志。"""
    text = (text or "").strip()
    return text[-n:] if len(text) > n else text


def _join(head, evidence):
    """拼接「结论首行 + 证据列表」。"""
    if not evidence:
        return head
    return head + "\n\n证据：\n" + "\n".join("· " + e for e in evidence)


def _last_code(text):
    """从 curl -w '%{http_code}' 输出中提取末尾 HTTP 状态码。"""
    t = (text or "").strip()
    t3 = t[-3:]
    return t3 if t3.isdigit() else "000"


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


# ---------------------------------------------------------------- 空闲端口自动探测
#
# 背景（老板投诉的真实根因）：「端口那么多他偏要我去开个 8080」——旧实现里 app_port 一旦缺省，
# 技能就直接跳过 nginx 反向代理，把「你要监听哪个端口」抛回给用户。实际上「监听哪个端口」**不是
# 用户需求**，是部署细节，应由技能自己决定。故此处探测远端当前已监听的端口，自动挑一个空闲的。
#
# 红线：**绝不瞎猜**。当 `ss`/`netstat` 都取不到输出、或输出无法解析时，返回 None，让调用方退回
# 「不自动选端口」的原行为（宁可如实跳过，也不伪造一个端口造成假成功）。

def _parse_listen_ports(text):
    """从 `ss`/`netstat` 的监听列表输出解析出所有已监听的 TCP 端口号集合。

    兼容两类格式：
      · ss -ltn(H)：每行形如 `LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*`
      · netstat -ltn：每行形如 `tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN`
    取「本机地址:端口」里的端口：端口是行内「以冒号开头、随后是 1–5 位数字、且紧跟空白或行尾」的那一段，
    因而对 IPv4（`127.0.0.1:8080`）、`*:22`、IPv6（`[::]:80`）都成立。只保留 1–65535 的合法端口。
    解析不出任何端口时返回空集合（调用方据此判定「探测失败」，绝不瞎猜）。
    """
    ports = set()
    for line in (text or "").splitlines():
        for m in re.finditer(r":(\d{1,5})(?=\s|$)", line):
            try:
                n = int(m.group(1))
            except Exception:
                continue
            if 1 <= n <= 65535:
                ports.add(n)
    return ports


def _pick_free_port(client, lo=3000, hi=3999):
    """在远端区间 [lo, hi] 内挑第一个未被监听的端口；探测失败时返回 None。

    依次尝试 `ss -ltnH`（无表头）→ `ss -ltn`（带表头）→ `netstat -ltn`，取第一个有非空输出的结果。
    若三者都为空 / 输出无法解析出任何已监听端口 → 返回 None（**不瞎猜**，由调用方退回原「跳过」行为）。
    若区间内每个端口都已被监听 → 也返回 None。
    """
    out = ""
    for cmd in ("ss -ltnH 2>/dev/null", "ss -ltn 2>/dev/null", "netstat -ltn 2>/dev/null"):
        try:
            o, _ = _exec(client, cmd, timeout=20)
        except Exception:
            o = ""
        if (o or "").strip():
            out = o
            break
    used = _parse_listen_ports(out)
    if not used:
        return None
    for p in range(lo, hi + 1):
        if p not in used:
            return p
    return None


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


def _npm_install_global(client, remote_dir, deadline, pkg, evidence, what):
    """npm install -g 安装全局包（如 pm2）。返回 (ok, note)。"""
    evidence.append("自动安装依赖：开始 npm install -g %s（后台执行，轮询日志）" % pkg)
    ok, rc, tail, to = _run_bg(client, remote_dir, "npm install -g " + pkg, deadline,
                               log_path=LOG_PATH_DEFAULT)
    if to:
        note = "npm install -g %s 超时（内部 deadline 到达）" % pkg
        evidence.append("自动安装依赖：" + note)
        return False, note
    if not ok:
        note = "npm install -g %s 失败（rc=%s）：%s" % (pkg, rc, _short(tail, 400))
        evidence.append("自动安装依赖：" + note)
        return False, note
    evidence.append("自动安装依赖：%s 安装完成" % what)
    return True, "%s 已安装" % what


# ---------------------------------------------------------------- nginx 反向代理

# 域名安全闸门：与 deploy-static 完全一致（同一 regex、同一非法字符集），
# 因为两者都把这个域名原样写进 nginx 配置文件（由 nginx 以 root 加载），
# 含 `;`/换行/`{`/`}`/`#` 等字符可注入 nginx 指令。
_DOMAIN_RE = r"^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$"
_DOMAIN_BAD_CHARS = " \t\r\n;{}#"

# nginx 配置备份目录：**必须落在任何会被 nginx `include` 扫到的目录之外**（conf.d / sites-enabled /
# nginx.conf 同级 *.conf）。旧实现把备份写成 `<conf>.bak-<ts>` 留在 conf.d 内，既是污染配置目录，
# 又因「成功路径从不删除自己刚建的备份」导致每成功部署一次就永久累积一个文件（只增不减、不自愈）。
# 注：该常量与 deploy-static 各存一份（技能目录互相独立），改一处务必同步改另一处。
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


# ---------------------------------------------- nginx 子路径挂载（反向代理 proxy_pass）
#
# 背景：deploy-node 原先只会「新开一个独立站点」（conf.d/douya-node-<safe>.conf）。
# 当用户想把 Node 服务挂到一个**已被占用的域名**（如 api.example.com）的子路径（如 /miaomiao/）下时，
# 新开独立站点做不到（同一域名会被另一个 server 块抢走 / 语义错位）。本段实现「挂到已有站点的子路径」：
#   定位承载该域名的 server 块 → 幂等插入带标记的 location（proxy_pass 反向代理）→ 备份 → nginx -t → 失败回滚。
#
# 标记格式与 deploy-static 侧完全一致，将来可统一清理：
#     # >>> douya subpath begin: /miaomiao/ <<<
#     location ^~ /miaomiao/ { ...proxy_pass... }
#     # >>> douya subpath end: /miaomiao/ <<<

_SUBPATH_BEGIN_PREFIX = "# >>> douya subpath begin: "
_SUBPATH_BEGIN_SUFFIX = " <<<"
_SUBPATH_END_PREFIX = "# >>> douya subpath end: "
_SUBPATH_END_SUFFIX = " <<<"

# 通用标记块正则：匹配「同一条 url_path 的 begin...end」整段（含行尾换行）。
# begin 与 end 的 path 必须一致（反向引用 (?P=path)），因此不同 url_path 的块互不误伤。
# 行尾用 \r?\n 以兼容 CRLF 配置；DOTALL 让 .*? 跨行匹配到最近的同 path end 标记。
_SUBPATH_BLOCK_RE = re.compile(
    r"[ \t]*" + re.escape(_SUBPATH_BEGIN_PREFIX) + r"(?P<path>\S+)" +
    re.escape(_SUBPATH_BEGIN_SUFFIX) + r"[ \t]*\r?\n"
    r".*?"
    r"[ \t]*" + re.escape(_SUBPATH_END_PREFIX) + r"(?P=path)" +
    re.escape(_SUBPATH_END_SUFFIX) + r"[ \t]*\r?\n?",
    re.DOTALL)

# location 的修饰符集合（比较路径操作数时要跳过它们）。
_LOC_MODIFIERS = ("=", "^~", "~*", "~")


def _norm_url_path(raw):
    """归一化子路径参数。返回三态：

      ""   —— 未提供 / 空（走原有「新建独立站点」逻辑，行为一字不变）；
      None —— 格式非法（含空白、; { } # 引号 反斜杠，或净化后仍不合法）→ 调用方跳过并如实说明；
      其它 —— 规范化路径，如 "/miaomiao/"（前置 /、折叠重复 /、强制尾 /）。
    """
    if raw is None:
        return ""
    p = raw if isinstance(raw, str) else str(raw)
    p = p.strip()
    if p == "":
        return ""
    bad = set(" \t\r\n;{}#'\"\\")
    if any(c in bad for c in p):
        return None
    if not p.startswith("/"):
        p = "/" + p
    p = re.sub(r"/+", "/", p)
    if not p.endswith("/"):
        p = p + "/"
    if not re.match(r"^/[A-Za-z0-9._~\-/]*$", p):
        return None
    return p


def _is_word_char(c):
    """nginx 词法中的「词字符」（字母数字下划线）。"""
    return c.isalnum() or c == "_"


def _scan_kinds(text):
    """逐字符扫描 nginx 配置，返回与 text 等长的 kinds 数组。

    每个字符标注：
      'c' —— 普通代码字符（含引号定界符本身、空白）；
      'q' —— 引号内的字符（单/双引号字符串内容）；
      '#' —— nginx 注释字符（从 # 到行尾）。
    用途：括号计数只看 'c'；注释与字符串里的 { } # ; 一律不参与语法判定。
    """
    n = len(text)
    kinds = ["c"] * n
    i = 0
    while i < n:
        ch = text[i]
        if ch == "#":
            while i < n and text[i] != "\n":
                kinds[i] = "#"
                i += 1
            continue
        if ch == '"' or ch == "'":
            quote = ch
            i += 1
            while i < n:
                if text[i] == "\\" and quote == '"' and i + 1 < n:
                    kinds[i] = "q"
                    kinds[i + 1] = "q"
                    i += 2
                    continue
                if text[i] == quote:
                    break
                kinds[i] = "q"
                i += 1
            i += 1
            continue
        i += 1
    return kinds


def _find_server_blocks(text):
    """定位全部 `server { ... }` 块，返回按出现顺序排列的 [(open_idx, close_idx), ...]。

    open_idx 是 server 块 `{` 的位置，close_idx 是其配对 `}` 的位置。
    算法：注释 / 引号感知的逐字符扫描维护 {} 深度；遇到 `server` 关键字（词边界）后
    紧随的 `{` 视为块开始，其配对 `}` 视为块结束。深度不归零的残缺块不返回（调用方据此保守跳过）。
    """
    kinds = _scan_kinds(text)
    n = len(text)
    blocks = []
    depth = 0
    pending = None  # 位于 'server' 关键字之后的索引（等待其后的 '{'）
    stack = []      # [(open_index, depth_at_open)]
    i = 0
    while i < n:
        if kinds[i] != "c":
            i += 1
            continue
        ch = text[i]
        if ch in " \t\r\n":
            i += 1
            continue
        if _is_word_char(ch):
            j = i
            while j < n and kinds[j] == "c" and _is_word_char(text[j]):
                j += 1
            if text[i:j] == "server" and (i == 0 or not _is_word_char(text[i - 1])):
                pending = j
            else:
                pending = None
            i = j
            continue
        if ch == "{":
            depth += 1
            if pending is not None and text[pending:i].strip() == "":
                stack.append((i, depth))
            pending = None
            i += 1
            continue
        if ch == "}":
            if stack and stack[-1][1] == depth:
                op, _d = stack.pop()
                blocks.append((op, i))
            pending = None
            depth -= 1
            i += 1
            continue
        pending = None
        i += 1
    blocks.sort()
    return blocks


def _read_tokens_until_semi(text, kinds, i):
    """从索引 i 起读取 token，直到代码态的 `;` 为止。返回 (tokens, i_at_semicolon)。"""
    n = len(text)
    tokens = []
    buf = []
    while i < n:
        if kinds[i] == "c":
            c = text[i]
            if c == ";":
                break
            if c in " \t\r\n":
                if buf:
                    tokens.append("".join(buf))
                    buf = []
                i += 1
                continue
            if c == '"' or c == "'":
                quote = c
                if buf:
                    tokens.append("".join(buf))
                    buf = []
                j = i + 1
                content = []
                while j < n:
                    if text[j] == "\\" and quote == '"' and j + 1 < n:
                        content.append(text[j + 1])
                        j += 2
                        continue
                    if text[j] == quote:
                        break
                    content.append(text[j])
                    j += 1
                tokens.append("".join(content))
                i = j + 1
                continue
            buf.append(c)
            i += 1
            continue
        if kinds[i] == "q":
            buf.append(text[i])
        i += 1
    if buf:
        tokens.append("".join(buf))
    return tokens, i


def _find_server_name_tokens(text, kinds, open_idx, close_idx):
    """提取 server 块 [open_idx+1, close_idx) 内所有 server_name 指令的 token 列表。"""
    n = close_idx
    i = open_idx + 1
    depth = 1
    tokens = []
    while i < n:
        if kinds[i] != "c":
            i += 1
            continue
        ch = text[i]
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            depth -= 1
            i += 1
            continue
        if _is_word_char(ch):
            j = i
            while j < n and kinds[j] == "c" and _is_word_char(text[j]):
                j += 1
            if depth == 1 and text[i:j] == "server_name":
                toks, i = _read_tokens_until_semi(text, kinds, j)
                tokens.extend(toks)
                continue
            i = j
            continue
        i += 1
    return tokens


def _match_server_name(server_name, domain):
    """判断单个 server_name token 是否匹配目标域名。

    · `_` 是 nginx 的「任意/默认」通配，不算匹配（避免把默认站点当成本域名站点）；
    · `*.api.example.com` 形式匹配其子域（标准 nginx 语义，不匹配裸域 api.example.com）；
    · 其余按精确（大小写不敏感）比较。
    """
    sn = (server_name or "").strip().lower()
    d = (domain or "").strip().lower()
    if not sn or not d:
        return False
    if sn == "_":
        return False
    if sn == d:
        return True
    if sn.startswith("*."):
        suffix = sn[1:]  # '.api.example.com'
        return d.endswith(suffix) and len(d) > len(suffix)
    return False


def _read_location_operand(text, kinds, i):
    """从索引 i 起读取一条 location 指令的 token，直到 `{` 或 `;`。返回 (tokens, i)。"""
    n = len(text)
    toks = []
    buf = []
    while i < n:
        if kinds[i] == "c":
            c = text[i]
            if c in " \t\r\n":
                if buf:
                    toks.append("".join(buf))
                    buf = []
                i += 1
                continue
            if c in "{;":
                break
            buf.append(c)
            i += 1
            continue
        if kinds[i] == "q":
            buf.append(text[i])
        i += 1
    if buf:
        toks.append("".join(buf))
    return toks, i


def _location_operand(toks):
    """从 location 的 token 列表里取出「路径操作数」（跳过 = / ^~ / ~ / ~* 修饰符）。"""
    for t in toks:
        if t not in _LOC_MODIFIERS:
            return t
    return None


def _find_location_operands(region):
    """找出 region 文本里所有 location 指令的路径操作数。"""
    kinds = _scan_kinds(region)
    n = len(region)
    ops = []
    i = 0
    while i < n:
        if kinds[i] != "c":
            i += 1
            continue
        ch = region[i]
        if _is_word_char(ch):
            j = i
            while j < n and kinds[j] == "c" and _is_word_char(region[j]):
                j += 1
            if region[i:j] == "location" and (i == 0 or not _is_word_char(region[i - 1])):
                toks, i = _read_location_operand(region, kinds, j)
                op = _location_operand(toks)
                if op is not None:
                    ops.append(op)
                continue
            i = j
            continue
        i += 1
    return ops


def _norm_loc_path(op):
    """把一个 location 操作数归一化成可比较路径（去 ^ / $ 锚点、前置 /、折叠 //、强制尾 /）。

    这样 `location /finance`、`location = /finance/`、`location ^~ /finance/`、`location ~ ^/finance/`
    都会被归一化成 `/finance/`，从而与 url_path 正确比对（任务要求这些等价形式都算冲突）。
    """
    s = (op or "").strip()
    if s.startswith("^"):
        s = s[1:]
    if s.endswith("$"):
        s = s[:-1]
    if not s.startswith("/"):
        return None
    s = re.sub(r"/+", "/", s)
    if not s.endswith("/"):
        s += "/"
    return s


def _subpath_block_text(url_path, app_port):
    """生成子路径挂载的标记块文本（以单个 \\n 结尾，保证「整段移除」可精确还原原文）。

    proxy_pass 结尾的 `/` 是**关键**：它把请求里的 `/miaomiao/` 前缀剥掉再转发
    （/miaomiao/api/state → /api/state）。少了它，应用会收到多一层前缀而路由全对不上。
    `^~` 前缀必须保留：压过对方配置里的 `location ~* \\.(js|css)$` 之类正则与兜底 `location /`。
    """
    lines = [
        _SUBPATH_BEGIN_PREFIX + url_path + _SUBPATH_BEGIN_SUFFIX,
        "location ^~ " + url_path + " {",
        "    proxy_pass http://127.0.0.1:%d/;" % int(app_port),
        "    proxy_http_version 1.1;",
        "    proxy_set_header Host $host;",
        "    proxy_set_header X-Real-IP $remote_addr;",
        "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
        "    proxy_set_header X-Forwarded-Proto $scheme;",
        "    proxy_set_header Upgrade $http_upgrade;",
        '    proxy_set_header Connection "upgrade";',
        "    proxy_read_timeout 300s;",
        "}",
        _SUBPATH_END_PREFIX + url_path + _SUBPATH_END_SUFFIX,
    ]
    return "\n".join(lines) + "\n"


def _iter_subpath_blocks(text):
    """返回文本内全部豆芽标记块，形如 [(path, match), ...]。"""
    return [(m.group("path"), m) for m in _SUBPATH_BLOCK_RE.finditer(text)]


def _strip_all_subpath_blocks(text):
    """移除文本内**全部**豆芽标记块（用于冲突检测与「移除插入段后还原」校验）。"""
    return _SUBPATH_BLOCK_RE.sub("", text)


def _strip_subpath_blocks_for(text, url_path):
    """仅移除**指定 url_path** 的豆芽标记块（用于幂等替换：同路径整块换新，其它路径保留）。"""
    rx = re.compile(
        r"[ \t]*" + re.escape(_SUBPATH_BEGIN_PREFIX) + re.escape(url_path) +
        re.escape(_SUBPATH_BEGIN_SUFFIX) + r"[ \t]*\r?\n"
        r".*?"
        r"[ \t]*" + re.escape(_SUBPATH_END_PREFIX) + re.escape(url_path) +
        re.escape(_SUBPATH_END_SUFFIX) + r"[ \t]*\r?\n?",
        re.DOTALL)
    return rx.sub("", text)


def _plan_subpath_in_file(text, domain, url_path, app_port):
    """给定**单个配置文件全文**，规划子路径挂载（纯函数，便于离线单测）。

    返回 dict：
      status = 'no_match' —— 本文件无承载该域名的 server 块；
             | 'conflict' —— 该 url_path 已被非豆芽的 location 占用（或括号不配平）→ 跳过，不改动；
             | 'edit'     —— 可挂载，new_text 为新全文。
      matched            —— 命中的 server 块数；
      conflict_op        —— 冲突的 location 操作数（status=conflict 时）；
      new_text / inserted_lines / block_text（status=edit 时）。
    """
    blocks = _find_server_blocks(text)
    kinds = _scan_kinds(text)
    matched = []
    for (op, cl) in blocks:
        names = _find_server_name_tokens(text, kinds, op, cl)
        if any(_match_server_name(nm, domain) for nm in names):
            matched.append((op, cl))
    if not matched:
        return {"status": "no_match", "matched": 0}
    # 冲突检测：摘掉豆芽标记块后，剩余 location 里是否存在与 url_path 等价的路径。
    for (op, cl) in matched:
        region = text[op + 1:cl]
        stripped = _strip_all_subpath_blocks(region)
        for operand in _find_location_operands(stripped):
            if _norm_loc_path(operand) == url_path:
                return {"status": "conflict", "matched": len(matched),
                        "conflict_op": operand}
    block_text = _subpath_block_text(url_path, app_port)
    new_text = text
    inserted_lines = []
    # 从靠后的 server 块往前改，避免前面的索引失效。
    for (op, cl) in sorted(matched, key=lambda b: b[0], reverse=True):
        region = new_text[op + 1:cl]
        cleaned = _strip_subpath_blocks_for(region, url_path)  # 幂等：同路径旧块整块换新
        new_text = new_text[:op + 1] + cleaned + new_text[cl:]
        cl2 = cl + (len(cleaned) - len(region))
        nl = new_text.rfind("\n", op, cl2)
        ins = nl + 1 if nl >= 0 else cl2  # 插在收尾 `}` 所在行之前
        new_text = new_text[:ins] + block_text + new_text[ins:]
        inserted_lines.append(new_text.count("\n", 0, ins) + 1)
    inserted_lines.sort()
    return {"status": "edit", "matched": len(matched), "new_text": new_text,
            "inserted_lines": inserted_lines, "block_text": block_text}


def _list_includable_confs(client):
    """列出「会被 include 的」nginx 配置文件绝对路径（sites-enabled/* + conf.d/*.conf）。

    明确排除：sites-available/、*.bak*、*~、*.orig、*.save、backups/、sites-backup/ 等
    （这台机器上有一大堆备份，绝不能误伤）。只保留常规文件（-f，跟随符号链接）。
    """
    cmd = ("( for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do "
           "[ -f \"$f\" ] && echo \"$f\"; done ) 2>/dev/null")
    out, _ = _exec(client, cmd, timeout=30)
    files = []
    for line in (out or "").splitlines():
        p = line.strip()
        if not p or not p.startswith("/"):
            continue
        low = posixpath.basename(p).lower()
        if low.endswith("~") or ".bak" in low or low.endswith(".orig") or low.endswith(".save"):
            continue
        if p not in files:
            files.append(p)
    return files


def _read_remote_text(client, path):
    """读取远端文本文件全文（优先 SFTP，失败回退 cat）。"""
    try:
        sftp = client.open_sftp()
        try:
            f = sftp.open(path, "r")
            try:
                data = f.read()
            finally:
                f.close()
        finally:
            sftp.close()
        if isinstance(data, bytes):
            return data.decode("utf-8", "replace")
        return data
    except Exception:
        out, _ = _exec(client, "cat " + shlex.quote(path), timeout=60)
        return out


def _remote_md5(client, path):
    """取远端文件 md5（失败返回空串）。"""
    out, _ = _exec(client, "md5sum %s 2>/dev/null | awk '{print $1}'" % shlex.quote(path),
                   timeout=30)
    m = re.search(r"[0-9a-fA-F]{32}", out or "")
    return m.group(0).lower() if m else ""


def _apply_subpath_nginx(client, domain, url_path, app_port, ts, evidence):
    """把 Node 服务挂到「已被占用的域名」的子路径下（反向代理）。

    返回 (status, note)：
      'edit'     —— 已插入并生效；
      'conflict' —— 路径已被他人 location 占用 / 无法备份 / 测试失败已回滚 → 跳过（站点仍已部署）；
      'no_match' —— 未找到承载该域名的 server 块 → 调用方改为新建独立站点（保持既有行为）。
    """
    files = _list_includable_confs(client)
    evidence.append("子路径挂载：扫描会被 include 的配置 %d 个（%s）" %
                    (len(files), "、".join(posixpath.basename(f) for f in files) or "无"))
    if not files:
        return "no_match", "未找到任何会被 include 的 nginx 配置文件"
    plans = []
    conflicts = []
    for path in files:
        try:
            content = _read_remote_text(client, path)
        except Exception as e:
            evidence.append("子路径挂载：读取 %s 失败（%s），跳过该文件" % (path, e))
            continue
        plan = _plan_subpath_in_file(content, domain, url_path, app_port)
        if plan["status"] == "no_match":
            continue
        if plan["status"] == "conflict":
            conflicts.append((path, plan.get("conflict_op", "")))
            continue
        plans.append({"path": path, "before": content, "plan": plan})
    if conflicts:
        path, op = conflicts[0]
        note = ("已跳过 nginx 子路径挂载：路径 %s 已被现有配置占用（%s 中已存在 `location %s`），"
                "为避免覆盖他人设置未做任何改动（站点已正常部署）。" % (url_path, path, op))
        evidence.append(note)
        return "conflict", note
    if not plans:
        return "no_match", "未在任何会被 include 的配置里找到声明域名 %s 的 server 块" % domain
    return _perform_subpath_edits(client, plans, url_path, domain, app_port, ts, evidence)


def _perform_subpath_edits(client, plans, url_path, domain, app_port, ts, evidence):
    """落盘子路径挂载：备份 → 写 → nginx -t → 失败回滚并报警 → 通过才 reload。

    改的是**他人的生产配置**，故成功后**保留**备份（便于人工回滚），不删。
    """
    # 1) 逐个备份（备份落在 conf.d / sites-enabled 之外，绝不参与 nginx 加载）。
    for item in plans:
        path = item["path"]
        item["md5_before"] = _remote_md5(client, path)
        bak = _nginx_bak_path(path, ts)
        _exec(client, "mkdir -p %s 2>/dev/null || true" % shlex.quote(_NGINX_BAK_DIR), timeout=20)
        bout, _ = _exec(client, "cp -f %s %s && echo BK_OK || echo BK_FAIL" %
                        (shlex.quote(path), shlex.quote(bak)), timeout=30)
        if "BK_OK" not in bout:
            note = "已跳过 nginx 子路径挂载：无法备份 %s（cp 失败），未做任何改动" % path
            evidence.append(note)
            return "conflict", note
        item["bak"] = bak
    evidence.append("子路径挂载：已备份 %d 个配置到 %s（保留，便于人工回滚）" %
                    (len(plans), _NGINX_BAK_DIR))

    # 2) 写新内容。
    try:
        for item in plans:
            path = item["path"]
            new_text = item["plan"]["new_text"]
            local = os.path.join(tempfile.gettempdir(),
                                 "douya_node_subpath_%s_%s" %
                                 (ts, posixpath.basename(path).replace("/", "_")))
            with open(local, "w", encoding="utf-8", newline="") as f:
                f.write(new_text)
            try:
                sftp = client.open_sftp()
                try:
                    sftp.put(local, path)
                finally:
                    sftp.close()
            finally:
                try:
                    os.remove(local)
                except Exception:
                    pass
            item["md5_after"] = _remote_md5(client, path)
            item["md5_reconstructed"] = hashlib.md5(
                _strip_all_subpath_blocks(new_text).encode("utf-8")).hexdigest()

        # 3) nginx -t；失败 → 回滚 → 复检 → 报警。
        tout, terr = _exec(client, "nginx -t 2>&1", timeout=30)
        tcomb = tout + terr
        if "successful" not in tcomb.lower():
            for item in plans:
                _exec(client, "cp -f %s %s" % (shlex.quote(item["bak"]), shlex.quote(item["path"])),
                      timeout=30)
                item["md5_restored"] = _remote_md5(client, item["path"])
            t2out, t2err = _exec(client, "nginx -t 2>&1", timeout=30)
            restore_ok = "successful" in (t2out + t2err).lower()
            note = "nginx 子路径配置测试未通过，已回滚（nginx -t 原始输出：%s）" % _short(tcomb, 300)
            evidence.append(note)
            evidence.append("子路径挂载：回滚后 nginx -t = %s" % ("通过" if restore_ok else "仍失败"))
            if not restore_ok:
                evidence.append(
                    "⚠️ 严重：回滚后 nginx -t 仍未通过，原配置可能已被破坏，请人工介入！备份位于：" +
                    "、".join(it["bak"] for it in plans))
            for item in plans:
                same = item.get("md5_restored") == item.get("md5_before")
                evidence.append("子路径挂载：%s 回滚 md5 %s（回滚后=%s，原=%s）" %
                                (item["path"], "一致" if same else "不一致",
                                 item.get("md5_restored"), item.get("md5_before")))
            return "conflict", note

        # 4) 通过才 reload。
        rout, rerr = _exec(client, "nginx -s reload 2>&1 || systemctl reload nginx 2>&1", timeout=40)
        evidence.append("子路径挂载：nginx -t 通过，已 reload（输出：%s）" %
                        (_short(rout + rerr, 200) or "(无输出)"))
    except Exception as e:
        for item in plans:
            _exec(client, "cp -f %s %s" % (shlex.quote(item["bak"]), shlex.quote(item["path"])),
                  timeout=30)
        _exec(client, "nginx -t 2>&1", timeout=30)
        note = "nginx 子路径挂载出错，已尝试回滚：" + str(e)
        evidence.append(note)
        return "conflict", note

    # 5) 证据：插入位置 + 三值 md5 + 备份路径。
    for item in plans:
        inserted = "、".join(str(n) for n in item["plan"]["inserted_lines"])
        recon_ok = item.get("md5_reconstructed") == item.get("md5_before")
        evidence.append("子路径挂载：%s 命中 %d 个 server 块，插入第 %s 行；"
                        "插入前 md5=%s，插入后 md5=%s，移除插入段后 md5=%s（%s）" %
                        (item["path"], item["plan"]["matched"], inserted,
                         item.get("md5_before"), item.get("md5_after"),
                         item.get("md5_reconstructed"),
                         "== 插入前 ✔" if recon_ok else "≠ 插入前"))
        evidence.append("子路径挂载：备份保留于 " + item["bak"])
    note = ("nginx 子路径挂载已生效：https://%s%s → http://127.0.0.1:%d/"
            "（反向代理，proxy_pass 尾斜杠已剥前缀）" % (domain, url_path, app_port))
    return "edit", note


def _apply_node_nginx(client, domain, app_port, start_command, ts, evidence,
                      auto_install=False, deadline=None, url_path=""):
    """为 Node 应用生成 nginx 反向代理配置 → 测试 → 通过才 reload。返回 (ok, 说明)。

    背景：pm2 只让应用在本机 127.0.0.1:<app_port> 上监听，外部用户默认访问不到；
    需要一条 `listen 80 → proxy_pass http://127.0.0.1:<app_port>` 的反向代理把它“对外发布”。

    安全：domain 会被原样写入 nginx 配置（该文件由 nginx 以 root 身份加载），因此写入前做参数校验；
    不合法则**跳过**并在证据里说明原因（应用已由 pm2 跑起来，nginx 只是可选步，不应因此让整个部署失败）。

    模式：
      · url_path 为空 —— 原有行为：新建独立站点 conf.d/douya-node-<safe>.conf（一字不变）。
      · url_path 有值 —— 挂到「已被占用的域名」的子路径：定位承载该域名的 server 块，
        幂等插入带标记的 location（proxy_pass 反向代理）；域名未被占用时回退到新建独立站点。
        路径已被他人 location 占用 → 保守跳过（不改动），站点本身仍已部署。

    返回值语义：
      ok=True  —— 反向代理已生效（配置写入、nginx -t 通过、已 reload）。
      ok=False —— 未生效：被安全跳过（缺 app_port / 域名非法 / 远端未装 nginx / 子路径已被占用）
                  或配置测试失败已还原。这些情况均**不中断**部署流程，调用方只把说明文字展示给用户。
    """
    if deadline is None:
        deadline = time.time() + 600

    # 1) app_port 仍为 0：说明用户没指定、且技能自动探测空闲端口也失败（探测不到已监听端口）。
    #    此时退回原「跳过」行为——应用已经由 pm2 起好了，不因这一步中断整个部署。
    if not app_port:
        note = ("已跳过 nginx 反向代理：未能确定应用的监听端口"
                "（未显式指定，且自动探测远端已监听端口失败）")
        evidence.append(note)
        return False, note

    # 2) 域名校验（与 deploy-static 相同的 regex）：必须是合法域名/IP。
    if not re.match(_DOMAIN_RE, domain or ""):
        note = ("已跳过 nginx 反向代理：domain 不是合法域名/IP（只允许字母、数字、点、连字符，"
                "且以字母或数字开头）：" + str(domain or ""))
        evidence.append(note)
        return False, note

    # 2b) 非法字符再兜底（与 deploy-static 的路径校验同一字符集）：空白 / ; { } # / 换行。
    if any(c in domain for c in _DOMAIN_BAD_CHARS):
        note = ("已跳过 nginx 反向代理：domain 含非法字符（空白、; { } # ）：" + str(domain or ""))
        evidence.append(note)
        return False, note

    # 3) 远端是否装了 nginx —— 缺失时：默认只给出指引、绝不写入任何配置；
    #    仅当 auto_install=true（用户显式授权）才自动安装，装完复检通过再继续。
    chk, _ = _exec(client, "command -v nginx >/dev/null 2>&1 && echo NGINX_OK || echo NGINX_MISSING",
                   timeout=20)
    if "NGINX_OK" not in chk:
        if not auto_install:
            note = ("应用已通过 pm2 启动并监听 %d，但远端未安装 nginx，无法配置反向代理对外访问。"
                    "请先安装 nginx 后重试，或自行配置（也可设 auto_install=true 让豆芽自动安装）。" % app_port)
            evidence.append(note)
            return False, note
        iok, inote = _apt_install(client, deadline, ["nginx"], evidence, "nginx")
        if not iok:
            note = ("应用已通过 pm2 启动并监听 %d，但远端未安装 nginx 且自动安装失败：%s"
                    % (app_port, inote))
            evidence.append(note)
            return False, note
        chk2, _ = _exec(client, "command -v nginx >/dev/null 2>&1 && echo NGINX_OK || echo NGINX_MISSING",
                        timeout=20)
        if "NGINX_OK" not in chk2:
            note = ("应用已通过 pm2 启动并监听 %d，但自动安装 nginx 后仍未检测到，无法配置反向代理。"
                    % app_port)
            evidence.append(note)
            return False, note
        evidence.append("自动安装依赖：nginx 已可用，继续写入反向代理配置")

    # 3b) 子路径挂载（可选）—— 把服务挂到「已被占用的域名」的子路径下。
    #     红线：url_path 为空时完全不走这里，下面「新建独立站点」逻辑一字不变。
    norm_path = _norm_url_path(url_path)
    if norm_path is None:
        note = ("已跳过 nginx 子路径挂载：url_path 含非法字符或格式不正确：" + str(url_path))
        evidence.append(note)
        return False, note
    if norm_path:
        sub_status, sub_note = _apply_subpath_nginx(client, domain, norm_path,
                                                    app_port, ts, evidence)
        if sub_status == "edit":
            return True, sub_note
        if sub_status == "conflict":
            return False, sub_note
        # sub_status == "no_match"：域名未被既有配置承载 → 回退到新建独立站点（保持既有行为）。
        evidence.append("子路径挂载：域名 %s 未被既有配置承载（%s），改为新建独立站点配置"
                        % (domain, sub_note))

    # 4) 生成配置（safe 净化规则与 deploy-static 一致：非 [A-Za-z0-9.-_] 的字符替换为 _）。
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in domain) or "site"
    conf_path = "/etc/nginx/conf.d/douya-node-%s.conf" % safe
    conf = (
        "server {\n"
        "    listen 80;\n"
        "    server_name %s;\n"
        "    location / {\n"
        "        proxy_pass http://127.0.0.1:%d;\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_set_header Upgrade $http_upgrade;\n"
        "        proxy_set_header Connection \"upgrade\";\n"
        "        proxy_read_timeout 300s;\n"
        "    }\n"
        "}\n" % (domain, app_port))
    conf_local = os.path.join(tempfile.gettempdir(), "douya_node_nginx_%s.conf" % ts)
    with open(conf_local, "w", encoding="utf-8") as f:
        f.write(conf)

    # 5) 安全链：备份同名旧配置（放到 conf.d 之外）→ 上传 → nginx -t → 只有通过才 reload → 失败还原。
    #    修复：旧实现把备份 `cp <conf> <conf>.bak-<ts>` 放在 conf.d 内，且**成功路径从不删除自己刚建的备份**
    #    ⇒ 每成功部署一次就在 conf.d 永久累积一个文件（只增不减）。现在：备份移出配置目录，
    #    成功路径消费掉本次备份，写配置前顺带清理历史残留。
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
            # 测试失败 → 还原旧配置（从**新位置**取回备份写回 conf_path；备份随之被消费）。
            if existed:
                _exec(client, "mv -f %s %s" %
                      (shlex.quote(bak_path), shlex.quote(conf_path)), timeout=30)
            else:
                _exec(client, "rm -f " + shlex.quote(conf_path), timeout=30)
            note = "nginx 反向代理配置测试未通过，已还原（nginx -t 输出：%s）" % _short(tout + terr, 300)
            evidence.append(note)
            return False, note
        _exec(client, "nginx -s reload 2>&1 || systemctl reload nginx 2>&1", timeout=40)
        # 成功路径：消费掉本次备份（只删本次这个**具体路径**，不扫目录/不用通配符；清理失败不影响部署）。
        cleanup_note = ""
        if existed:
            cout, _ = _exec(client, "rm -f %s && echo RM_OK || echo RM_FAIL" % shlex.quote(bak_path),
                            timeout=20)
            cleanup_note = "，本次备份已清理" if "RM_OK" in cout else \
                "，本次备份清理失败（%s），可手动删除" % bak_path
        evidence.append("nginx：已写入 %s，nginx -t 通过，已 reload%s" % (conf_path, cleanup_note))
        note = "nginx 反向代理已生效（server_name=%s → http://127.0.0.1:%d）" % (domain, app_port)
        return True, note
    finally:
        try:
            os.remove(conf_local)
        except Exception:
            pass


# --------------------------------------------------- pm2 命令构造 / 同名进程自愈

# 背景（真机暴露的缺陷）：pm2 若把「整条启动命令」当 script，会同时建出两个同名进程——
#   pm2 start node server.js --name X
#     ⇒ pm_id=A: 把 `node` 当脚本的僵尸（ver=N/A，占不了端口）
#     ⇒ pm_id=B: 真正的应用（ver=版本号，exec=<脚本>）
# 第二次部署时 `pm2 restart X` 会把两个一起重启 ⇒ 僵尸永久累积、永不自愈；
# 且 `pm2 describe X | grep status` 只看到一个 online，旧校验发现不了。
# 因此这里一律改为「脚本优先」形态：把真正的脚本/入口交给 pm2，解释器与 node 标志交给 pm2 选项。

_PM2_JS_PKG_RUNNERS = ("npm", "yarn", "pnpm")


def _split_node_argv(rest):
    """把 `node <...>` 的后续 token 拆成 (node_flags, script, app_args)。

    规则：
      · 脚本之前的、以 '-' 开头的 token 视为 node 标志（如 --max-old-space-size=2048）；
      · 第一个非 '-' 开头的 token 视为脚本（真正的入口）；
      · 脚本之后的其余 token 视为应用参数。
    """
    flags = []
    script = ""
    app_args = []
    for tok in rest:
        if script == "":
            if tok.startswith("-"):
                flags.append(tok)
            else:
                script = tok
        else:
            app_args.append(tok)
    return flags, script, app_args


def _pm2_start_body(app_name, start_command):
    """把用户给的 start_command 解析成「脚本优先」的 pm2 启动命令主体（不含 cd / pm2 save）。

    返回值形如 `pm2 start <script> --name X [--node-args="..."] [-- <app args>]`。覆盖形态：
      node server.js                           → pm2 start server.js --name X
      node --max-old-space-size=2048 server.js → pm2 start server.js --name X --node-args="--max-old-space-size=2048"
      npm start / yarn dev / pnpm run prod     → pm2 start npm --name X -- start
      单 token（run.sh / ./run.sh）             → pm2 start run.sh --name X
      其它运行时（python app.py）               → pm2 start python --name X --interpreter none -- app.py

    红线：严禁生成把解释器整串当 script 的旧形态（`pm2 start node server.js ...`）。
    解析不出可托管形态时抛 ValueError（调用方转成可读失败结论 + 指引），绝不退回旧形态。
    所有 path/token 一律经 shlex.quote。
    """
    parts = shlex.split(start_command or "")
    if not parts:
        # 兜底：等价于 npm start（沿用既有默认语义，仅换为不会产生僵尸的形态）。
        return "pm2 start npm --name %s -- start" % shlex.quote(app_name)

    prog = parts[0]
    rest = parts[1:]

    if prog in _PM2_JS_PKG_RUNNERS:
        # npm/yarn/pnpm：`--name` 必须在 `--` 之前，否则会被当成包管理器的参数，命名不可靠。
        body = "pm2 start %s --name %s" % (shlex.quote(prog), shlex.quote(app_name))
        if rest:
            body += " -- " + " ".join(shlex.quote(p) for p in rest)
        return body

    if prog in ("node", "nodejs"):
        flags, script, app_args = _split_node_argv(rest)
        if not script:
            raise ValueError(
                "无法托管启动命令：`%s` 未给出脚本入口。请把 start_command 改成可托管形态"
                "（脚本优先），例如 `node server.js`。" % start_command)
        body = "pm2 start %s --name %s" % (shlex.quote(script), shlex.quote(app_name))
        if flags:
            body += ' --node-args="%s"' % " ".join(shlex.quote(f) for f in flags)
        if app_args:
            body += " -- " + " ".join(shlex.quote(p) for p in app_args)
        return body

    if len(parts) == 1:
        # 单 token：脚本路径（run.sh / ./run.sh）——直接交给 pm2，不再前置任何解释器。
        return "pm2 start %s --name %s" % (shlex.quote(prog), shlex.quote(app_name))

    # 其它非 JS 运行时（python app.py 等）：用 `--interpreter none` 的直执行形态，
    # 把 parts[0] 当可执行文件、其余经 `--` 传参——绝不退回会把整串当 script 的旧形态。
    body = "pm2 start %s --name %s --interpreter none" % (
        shlex.quote(prog), shlex.quote(app_name))
    if rest:
        body += " -- " + " ".join(shlex.quote(p) for p in rest)
    return body


def _pm2_parse_jlist(text):
    """把 `pm2 jlist` 的 stdout 解析成 {app_name: [pm_id, ...]}；解析失败返回 None。

    容错：
      · 空 / 非 JSON / JSON 非数组 → None（调用方据此降级）；
      · 混入 `[PM2] Saving...` 之类噪声行时，逐行挑出形如 `[...]` 的 JSON 片段再解析；
      · 缺 name / pm_id 的条目跳过。
    """
    t = (text or "").strip()
    if not t:
        return None
    candidates = [t]
    for line in t.splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            candidates.append(s)
    for cand in candidates:
        try:
            data = json.loads(cand)
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        table = {}
        for item in data:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            pm_id = item.get("pm_id")
            if name is None or pm_id is None:
                continue
            table.setdefault(str(name), []).append(pm_id)
        return table
    return None


def _pm2_named_ids(client, app_name):
    """读 `pm2 jlist` 返回 (ok, ids)。

    ok=False 表示「进程表解析失败」（空串 / 非 JSON / 命令异常），调用方需降级处理；
    ok=True 时 ids 为该 app_name 下所有同名进程的 pm_id 列表（可能为空）。
    """
    try:
        out, _ = _exec(client, "pm2 jlist", timeout=40)
    except Exception:
        return False, []
    table = _pm2_parse_jlist(out)
    if table is None:
        return False, []
    return True, list(table.get(app_name, []))


def _pm2_start_or_restart_cmd(remote_dir, app_name, start_body, ok_list, ids, evidence,
                              port=None):
    """按同名进程数组装自愈启动命令，最后统一 `pm2 save`。

      · ok_list=False（进程表解析失败）→ 降级为旧的 `restart || start` 行为，并在 evidence 注明；
      · n == 0 → `pm2 start ...`；
      · n == 1 → `pm2 restart <app_name>`（保持「重启优先」语义，不停机）；
      · n > 1 → 先 `pm2 delete <id1> <id2> ...`（名字删除对同名多进程不可靠，按 id 精确认干净）再 start。

    port：技能自动挑中的端口（仅「用户未显式指定 app_port」时有值）。给了就用 `PORT=<port>` 前缀把
    端口通过环境变量注入 pm2（否则应用会继续监听它自己写死的端口，挑了也白挑）；restart 分支同时加
    `--update-env` 让 pm2 重读环境变量。port=None 时命令与旧实现**一字不变**（显式传 app_port 走这条）。
    """
    env_prefix = ("PORT=%d " % int(port)) if port else ""
    restart_cmd = ("%spm2 restart %s%s" %
                   (env_prefix, shlex.quote(app_name), " --update-env" if port else ""))
    start_cmd = env_prefix + start_body
    if not ok_list:
        evidence.append("pm2 自愈：进程表解析失败，已降级为 restart||start")
        action = "(%s || %s)" % (restart_cmd, start_cmd)
    elif not ids:
        evidence.append("pm2 自愈：未发现同名进程（n=0），执行 start")
        action = start_cmd
    elif len(ids) == 1:
        evidence.append("pm2 自愈：发现 1 个同名进程（pm_id=%s），执行 restart（不停机）" % ids[0])
        action = restart_cmd
    else:
        idlist = " ".join(shlex.quote(str(i)) for i in ids)
        evidence.append("pm2 自愈：发现 %d 个同名进程（pm_id=%s），先按 id 清理再 start" %
                        (len(ids), ",".join(str(i) for i in ids)))
        action = "pm2 delete %s && %s" % (idlist, start_cmd)
    return "cd %s && %s && pm2 save" % (shlex.quote(remote_dir), action)


# ---------------------------------------------------------------- deploy

def _do_deploy(client, params, deadline, host, username):
    """执行 Node 服务部署主流程。"""
    ws = _workspace()
    local_dir = (params.get("local_dir") or "").strip()
    remote_dir = (params.get("remote_dir") or "").strip()
    if not local_dir:
        return "错误：deploy 需要 local_dir（本地 Node 项目目录）"
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

    app_name = (params.get("app_name") or "").strip() or "douya-app"
    start_command = (params.get("start_command") or "").strip() or "npm start"
    try:
        app_port = int(float(params.get("app_port") or 0))
    except Exception:
        app_port = 0
    # auto_port：本次端口是否由技能自动挑选（仅「用户未显式指定 app_port」时可能为 True）。
    # 为 True 时才向 pm2 注入 PORT 环境变量；用户显式传了 app_port 则走原路径、行为一字不变。
    auto_port = False
    # nginx 反向代理：域名缺省用 host 兜底；开关缺省（未提供/空串）为 True。
    # 默认开启是刻意的——不配代理这个技能对外部就是不可用的，默认关闭等于保持断链。
    domain = (params.get("domain") or "").strip()
    _raw_nginx = params.get("nginx_use")
    nginx_use = True if _raw_nginx is None or str(_raw_nginx).strip() == "" else _to_bool(_raw_nginx)
    # 依赖自动安装：默认关闭（缺省/空串 = False），只有显式 auto_install=true 才会改动远端系统。
    # 默认关闭是刻意的——装包会修改用户的服务器环境，属于需用户显式授权的越界动作。
    auto_install = _to_bool(params.get("auto_install"))
    ts = time.strftime("%Y%m%d-%H%M%S")
    bak = remote_dir.rstrip("/") + ".bak-" + ts

    evidence = []
    zip_path = None
    backed = False
    try:
        # 0a) 端口：用户未显式指定 app_port（0/空/非法）时，技能**自己挑一个空闲端口**，
        #     绝不把「你要监听哪个端口」抛回给用户（老板投诉的根因）。探测失败则如实退回原「跳过」行为。
        if not app_port:
            picked = _pick_free_port(client)
            if picked:
                app_port = picked
                auto_port = True
                evidence.append("端口：未指定 app_port，已自动探测并选用空闲端口 %d"
                                "（将通过 PORT 环境变量注入应用）" % app_port)
            else:
                evidence.append("端口：未指定 app_port 且无法探测远端已监听端口，"
                                "已退回原行为（不自动选端口、跳过 nginx 反向代理）")
        else:
            evidence.append("端口：使用用户显式指定的端口 %d" % app_port)

        # 0) 前置：远端是否有 npm（auto_install=true 时自动安装，默认仅报错）
        chk, _ = _exec(client, "command -v npm >/dev/null 2>&1 && echo NPM_OK || echo NPM_MISSING",
                       timeout=20)
        if "NPM_OK" not in chk:
            if not auto_install:
                return _fail(host, remote_dir,
                             "远端未安装 npm/node，无法部署 Node 服务"
                             "（如需豆芽自动安装，请在参数里设 auto_install=true）",
                             backed, bak, evidence)
            iok, inote = _apt_install(client, deadline, ["nodejs", "npm"], evidence, "nodejs/npm")
            if not iok:
                return _fail(host, remote_dir, "自动安装 node/npm 失败：" + inote,
                             backed, bak, evidence)
            chk2, _ = _exec(client, "command -v npm >/dev/null 2>&1 && echo NPM_OK || echo NPM_MISSING",
                            timeout=20)
            if "NPM_OK" not in chk2:
                return _fail(host, remote_dir, "自动安装后仍未检测到 npm，无法继续",
                             backed, bak, evidence)
            evidence.append("自动安装依赖：复检通过，npm 已可用")

        # 1) 备份旧内容
        parent = posixpath.dirname(remote_dir.rstrip("/")) or "/"
        cmd_bak = ("mkdir -p %s && if [ -d %s ]; then mv %s %s && echo BACKED_UP; "
                   "else echo NO_EXISTING; fi && mkdir -p %s" % (
                       shlex.quote(parent), shlex.quote(remote_dir), shlex.quote(remote_dir),
                       shlex.quote(bak), shlex.quote(remote_dir)))
        bout, _ = _exec(client, cmd_bak, timeout=60)
        backed = "BACKED_UP" in bout
        evidence.append("备份：" + (("已把旧目录移至 " + bak) if backed else "远端无旧目录，跳过备份"))

        # 2) 本地打包
        zip_base = os.path.join(tempfile.gettempdir(), "douya_node_" + ts)
        zip_path = shutil.make_archive(zip_base, "zip", local_full)
        remote_zip = "/tmp/douya_node_%s.zip" % ts
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
        uok, urc, utail, uto = _run_bg(client, remote_dir, unpack, deadline,
                                       log_path=LOG_PATH_DEFAULT)
        if uto:
            return _fail(host, remote_dir, "解压超时（内部 deadline 到达）", backed, bak, evidence)
        if not uok:
            evidence.append("解压输出：" + _short(utail))
            return _fail(host, remote_dir, "解压失败（rc=%s）" % urc, backed, bak, evidence)

        # 5) 清理远端 zip
        _exec(client, "rm -f " + shlex.quote(remote_zip), timeout=20)

        # 6) 回读校验（Node 项目以 package.json 为关键文件）
        remote_count, has_key = _verify(client, remote_dir, "package.json")
        evidence.append("回读校验：远端 %d 个文件（本地 %d）；package.json %s" %
                        (remote_count, local_count, "存在" if has_key else "缺失"))
        if remote_count == 0 or not has_key:
            return _fail(host, remote_dir,
                         "回读校验未通过（远端文件数=%d，package.json=%s）" %
                         (remote_count, "存在" if has_key else "缺失"), backed, bak, evidence)

        # 7) 安装依赖（最耗时步骤：后台 nohup + 轮询，绝不单条 exec 死等）
        evidence.append("依赖安装：已在后台执行 npm install --omit=dev，轮询日志中")
        nok, nrc, ntail, nto = _run_bg(client, remote_dir, "npm install --omit=dev",
                                       deadline, log_path=NPM_LOG_DEFAULT)
        if nto:
            return _fail(host, remote_dir, "npm install 超时（内部 deadline 到达）",
                         backed, bak, evidence)
        if not nok:
            evidence.append("npm 输出：" + _short(ntail))
            return _fail(host, remote_dir, "npm install 失败（rc=%s）" % nrc,
                         backed, bak, evidence)
        evidence.append("依赖安装完成：" + _short(ntail, 300))

        # 8) pm2 托管（auto_install=true 时自动安装，默认仅报错）
        pchk, _ = _exec(client, "command -v pm2 >/dev/null 2>&1 && echo PM2_OK || echo PM2_MISSING",
                        timeout=20)
        if "PM2_OK" not in pchk:
            if not auto_install:
                return _fail(host, remote_dir, "远端未安装 pm2，无法托管 Node 进程"
                             "（如需豆芽自动安装，请在参数里设 auto_install=true）",
                             backed, bak, evidence)
            gok, gnote = _npm_install_global(client, remote_dir, deadline, "pm2", evidence, "pm2")
            if not gok:
                return _fail(host, remote_dir, "自动安装 pm2 失败：" + gnote,
                             backed, bak, evidence)
            pchk2, _ = _exec(client, "command -v pm2 >/dev/null 2>&1 && echo PM2_OK || echo PM2_MISSING",
                             timeout=20)
            if "PM2_OK" not in pchk2:
                return _fail(host, remote_dir, "自动安装后仍未检测到 pm2，无法继续",
                             backed, bak, evidence)
            evidence.append("自动安装依赖：复检通过，pm2 已可用")

        # 8a) 启动形态：脚本优先（绝不把整条命令当 pm2 的 script，否则产生僵尸进程）。
        try:
            start_body = _pm2_start_body(app_name, start_command)
        except ValueError as e:
            return _fail(host, remote_dir, str(e), backed, bak, evidence)
        evidence.append("pm2 启动形态：" + start_body)

        # 8b) 自愈：读进程表统计同名进程 → 0/1/>1 三种分支（>1 先按 id 清理再 start）。
        #     auto_port=True 时把自动挑中的端口经 PORT 环境变量注入（restart 走 --update-env）。
        ok_list, ids = _pm2_named_ids(client, app_name)
        pm2_cmd = _pm2_start_or_restart_cmd(remote_dir, app_name, start_body,
                                            ok_list, ids, evidence,
                                            port=app_port if auto_port else None)
        pout, perr = _exec(client, pm2_cmd, timeout=180)
        evidence.append("pm2 启动输出：" + _short(pout + perr, 400))

        # 8c) 复检同名进程数：必须恰好 1（>1 = 僵尸残留，走失败路径并给清理指引）。
        ok_list2, ids2 = _pm2_named_ids(client, app_name)
        if ok_list2:
            evidence.append("pm2 进程数：%d（%s）" % (len(ids2), app_name))
        else:
            evidence.append("pm2 进程数：无法确定（进程表解析失败）")

        dout, _ = _exec(client, "pm2 describe %s 2>/dev/null | grep -iE 'status|exec cwd' | head -3"
                        % shlex.quote(app_name), timeout=40)
        online = "online" in dout.lower()
        evidence.append("pm2 状态：" + (_short(dout, 300) or "(未取到状态)"))

        # 9) 健康检查（本机 127.0.0.1:app_port，允许应用启动预热重试）
        healthy = False
        code = "000"
        if app_port:
            curl_cmd = ("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:"
                        + str(app_port) + "/ 2>/dev/null || echo 000")
            for _ in range(12):
                if time.time() > deadline:
                    break
                hout, _ = _exec(client, curl_cmd, timeout=15)
                code = _last_code(hout)
                if code[:1] in ("2", "3"):
                    healthy = True
                    break
                time.sleep(3)
            evidence.append("健康检查：http://127.0.0.1:%d/ → HTTP %s" % (app_port, code))
        else:
            evidence.append("健康检查：未提供 app_port，跳过 HTTP 探活")

        if not online:
            return _fail(host, remote_dir, "pm2 进程未处于 online 状态", backed, bak, evidence)
        if app_port and not healthy:
            if auto_port:
                # 如实记账：端口是我们自动挑的，若应用没在该端口监听，多半是启动命令不读 PORT 环境变量。
                return _fail(host, remote_dir,
                             "已自动选用端口 %d 并注入 PORT 环境变量，但应用未在该端口监听"
                             "（HTTP %s）——可能是启动命令未读取 PORT 环境变量，"
                             "请改用 `PORT=<你的端口>` 形态的启动命令或显式指定 app_port" % (app_port, code),
                             backed, bak, evidence)
            return _fail(host, remote_dir, "健康检查未通过（HTTP %s，期望 2xx/3xx）" % code,
                         backed, bak, evidence)
        # 复检：同名进程数必须恰好 1 —— >1 说明有僵尸残留（describe|grep status 只显示一个 online，发现不了）。
        if ok_list2 and len(ids2) > 1:
            return _fail(host, remote_dir,
                         "检测到 %d 个同名 pm2 进程（pm_id=%s），疑似僵尸进程残留" %
                         (len(ids2), ",".join(str(i) for i in ids2)) +
                         "；请执行 `pm2 delete %s` 清理后重试（本轮已按自愈逻辑尝试清理，仍未收敛）" %
                         " ".join(str(i) for i in ids2),
                         backed, bak, evidence)

        # 10) nginx 反向代理（默认开启）—— 让应用能从外部经 80 端口访问（80 → 127.0.0.1:app_port）
        #     不中断部署：此时应用已由 pm2 托管、健康检查已通过，nginx 只是“对外暴露”这一步。
        nginx_note = ""
        if nginx_use:
            _nok, nginx_note = _apply_node_nginx(client, domain or host, app_port,
                                                 start_command, ts, evidence,
                                                 auto_install=auto_install, deadline=deadline,
                                                 url_path=params.get("url_path"))

        head = "✅ Node 服务部署成功：%s@%s → %s（%s，pm2 已托管%s）" % (
            username, host, remote_dir, app_name,
            "，自动选用端口 %d、HTTP %s" % (app_port, code) if auto_port
            else ("，HTTP " + code if app_port else ""))
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
    """回滚：把最近一个 .bak-* 还原回 remote_dir，并重启 pm2 进程。"""
    remote_dir = (params.get("remote_dir") or "").strip()
    ok, msg = _valid_target(remote_dir)
    if not ok:
        return msg
    app_name = (params.get("app_name") or "").strip() or "douya-app"
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

    # 若 pm2 存在则重启进程，使回滚版本生效。
    # 注意：同名进程可能 >1（历史僵尸），`pm2 restart <name>` 会把僵尸一起重启 ⇒ 这里按 app_name
    # 找出 pm_id，只重启「应保留的那一个」（同名多进程时取最近创建的，最可能是在跑的应用）。
    restart_note = "（未检测到 pm2，跳过进程重启）"
    pchk, _ = _exec(client, "command -v pm2 >/dev/null 2>&1 && echo PM2_OK || echo PM2_MISSING",
                    timeout=20)
    if "PM2_OK" in pchk:
        ok_list, ids = _pm2_named_ids(client, app_name)
        if ok_list and ids:
            keep = max(ids)
            _exec(client, "cd %s && pm2 restart %s && pm2 save" %
                  (shlex.quote(remote_dir), shlex.quote(str(keep))), timeout=120)
            if len(ids) > 1:
                restart_note = ("已 pm2 restart pm_id=%s（app_name=%s）；检测到 %d 个同名进程，"
                                "仅重启保留项，其余为历史残留，建议 `pm2 delete` 清理" %
                                (keep, app_name, len(ids)))
            else:
                restart_note = "已 pm2 restart pm_id=%s（app_name=%s）" % (keep, app_name)
        elif ok_list and not ids:
            restart_note = "（未找到同名 pm2 进程，跳过重启）"
        else:
            # 进程表解析失败 → 降级为按名字重启（不阻塞回滚），并在说明中标注。
            _exec(client, "cd %s && (pm2 restart %s || true) && pm2 save" %
                  (shlex.quote(remote_dir), shlex.quote(app_name)), timeout=120)
            restart_note = "已 pm2 restart %s（进程表解析失败，按名字重启）" % app_name

    remote_count, has_key = _verify(client, remote_dir, "package.json")
    return _join(
        "✅ 回滚成功：%s → %s（远端 %d 文件，package.json %s）" %
        (bak, remote_dir, remote_count, "存在" if has_key else "缺失"),
        ["被替换的当前版本已移至 " + failed, restart_note, "操作者：%s@%s" % (username, host)])


# ---------------------------------------------------------------- status

def _do_status(client, params, host, username):
    """查看远端目标目录与 pm2 进程现状。"""
    remote_dir = (params.get("remote_dir") or "").strip()
    ok, msg = _valid_target(remote_dir)
    if not ok:
        return msg
    app_name = (params.get("app_name") or "").strip() or "douya-app"
    base = remote_dir.rstrip("/")
    out, _ = _exec(client, "if [ -d %s ]; then echo DIR_EXISTS; else echo DIR_MISSING; fi" %
                   shlex.quote(remote_dir), timeout=30)
    if "DIR_EXISTS" not in out:
        return "ℹ️ 状态：%s@%s 上 %s 不存在（尚未部署）。" % (username, host, remote_dir)
    remote_count, has_key = _verify(client, remote_dir, "package.json")
    bout, _ = _exec(client, "ls -1dt %s.bak-* 2>/dev/null | head -5" % shlex.quote(base),
                    timeout=30)
    baks = [l.strip() for l in bout.strip().splitlines() if l.strip()]
    dout, _ = _exec(client, "pm2 describe %s 2>/dev/null | grep -iE 'status|restarts|uptime' | head -3"
                    % shlex.quote(app_name), timeout=40)
    # 反向代理配置探测（域名可能来自 domain 参数；缺省用 host 兜底，与部署时的取值一致）。
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_"
                   for ch in ((params.get("domain") or "").strip() or host)) or "site"
    nconf = "/etc/nginx/conf.d/douya-node-%s.conf" % safe
    ncout, _ = _exec(client, "test -f %s && echo CONF_EXISTS || echo CONF_MISSING" %
                     shlex.quote(nconf), timeout=20)
    ev = ["远端 %d 个文件；package.json %s" % (remote_count, "存在" if has_key else "缺失"),
          "可用备份数：%d" % len(baks)]
    for b in baks:
        ev.append("备份：" + b)
    ev.append("反向代理配置 %s：%s" % (nconf, "存在" if "CONF_EXISTS" in ncout else "不存在"))
    if dout.strip():
        ev.append("pm2 进程 %s：%s" % (app_name, _short(dout, 300)))
    else:
        ev.append("pm2 进程 %s：未找到或 pm2 未安装" % app_name)
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
