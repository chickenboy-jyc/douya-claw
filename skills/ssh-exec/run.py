# SSH 连接服务器技能：执行命令 / 上传 / 下载文件（凭证临时传入）
import os

import paramiko


def _resolve(ws, p):
    return p if os.path.isabs(p) else os.path.join(ws, p)


def _clip(text, limit=6000):
    """超长文本保留头部约 60% 与尾部约 40%，中间插入省略提示。

    部署日志的关键结论常在尾部，而执行上下文在头部，因此不再简单从尾部截断。
    """
    if len(text) <= limit:
        return text
    head_len = int(limit * 0.6)
    tail_len = limit - head_len
    omitted = len(text) - head_len - tail_len
    return text[:head_len] + "\n…（中间省略 %d 字符）…\n" % omitted + text[-tail_len:]


def main(params):
    action = (params.get("action") or "exec").strip().lower()
    host = (params.get("host") or "").strip()
    username = (params.get("username") or "").strip()
    password = params.get("password") or ""
    if not host or not username:
        return "错误：请提供 host（服务器地址）和 username（用户名）"
    try:
        port = int(float(params.get("port") or 22))
    except Exception:
        port = 22

    # 认证方式：显式 key_path 优先于密码。
    # 关闭 agent / look_for_keys 以免自动翻用户 ~/.ssh（既不可预期也不安全），
    # 需要密钥时必须显式提供 key_path。
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    key_path = (params.get("key_path") or "").strip()
    key_full = None
    if key_path:
        key_full = _resolve(ws, key_path)
        if not os.path.isfile(key_full):
            return ("错误：私钥文件不存在：%s（key_path 支持相对工作区或绝对路径；"
                    "如不使用密钥请留空该参数）" % key_full)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        if key_full:
            client.connect(
                host,
                port=port,
                username=username,
                key_filename=key_full,
                timeout=15,
                allow_agent=False,
                look_for_keys=False,
            )
        else:
            client.connect(
                host,
                port=port,
                username=username,
                password=password,
                timeout=15,
                allow_agent=False,
                look_for_keys=False,
            )
    except Exception as e:
        client.close()
        return "连接失败：" + str(e)

    try:
        if action == "exec":
            command = (params.get("command") or "").strip()
            if not command:
                return "错误：exec 需要 command"
            # 单条命令超时（秒），默认 600，clamp 到 [1, 600]。
            # 注意：0 是合法输入（应 clamp 到 1），不能用 `or 600` 否则会被误当成缺省。
            raw_timeout = params.get("timeout")
            if raw_timeout is None or (isinstance(raw_timeout, str) and raw_timeout.strip() == ""):
                cmd_timeout = 600
            else:
                try:
                    cmd_timeout = int(float(raw_timeout))
                except Exception:
                    cmd_timeout = 600
            cmd_timeout = max(1, min(600, cmd_timeout))
            try:
                stdin, stdout, stderr = client.exec_command(command, timeout=cmd_timeout)
                out = stdout.read().decode("utf-8", "replace")
                err = stderr.read().decode("utf-8", "replace")
            except Exception as e:
                # paramiko 的 socket 超时在 Python 3.10+ 表现为 TimeoutError（socket.timeout 的别名）
                if isinstance(e, TimeoutError) or "timed out" in str(e).lower():
                    return ("命令执行超过 %d 秒被中断。长任务建议拆小，"
                            "或用 nohup 放到后台跑再轮询日志。" % cmd_timeout)
                return "执行命令失败：" + str(e)
            result = out if out.strip() else "(无输出)"
            if err.strip():
                result += "\n[stderr]\n" + err
            return _clip(result)

        elif action == "upload":
            local = (params.get("local_path") or "").strip()
            remote = (params.get("remote_path") or "").strip()
            if not local or not remote:
                return "错误：upload 需要 local_path 和 remote_path"
            local_full = _resolve(ws, local)
            if not os.path.exists(local_full):
                return "错误：本地文件不存在：" + local_full
            sftp = client.open_sftp()
            sftp.put(local_full, remote)
            sftp.close()
            return "已上传：%s → %s" % (local_full, remote)

        elif action == "download":
            remote = (params.get("remote_path") or "").strip()
            local = (params.get("local_path") or "").strip()
            if not remote or not local:
                return "错误：download 需要 remote_path 和 local_path"
            local_full = _resolve(ws, local)
            os.makedirs(os.path.dirname(local_full), exist_ok=True) if os.path.dirname(local_full) else None
            sftp = client.open_sftp()
            sftp.get(remote, local_full)
            sftp.close()
            return "已下载：%s → %s" % (remote, local_full)

        else:
            return "错误：action 只支持 exec/upload/download"
    except Exception as e:
        return "操作失败：" + str(e)
    finally:
        try:
            client.close()
        except Exception:
            pass
