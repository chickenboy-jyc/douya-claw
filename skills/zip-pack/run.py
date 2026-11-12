# 压缩/解压技能
import os
import zipfile


def _resolve(ws, p):
    return p if os.path.isabs(p) else os.path.join(ws, p)


def main(params):
    action = (params.get("action") or "").strip().lower()
    path = (params.get("path") or "").strip()
    output = (params.get("output") or "").strip()
    if not action or not path:
        return "错误：请提供 action（zip/unzip）和 path"

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = _resolve(ws, path)
    if not os.path.exists(full):
        return "错误：路径不存在：" + full

    try:
        if action == "zip":
            out = _resolve(ws, output) if output else full + ".zip"
            if not out.lower().endswith(".zip"):
                out += ".zip"
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
                if os.path.isdir(full):
                    base = os.path.basename(full.rstrip("/\\")) or "."
                    for root, dirs, files in os.walk(full):
                        for f in files:
                            fp = os.path.join(root, f)
                            arc = os.path.join(base, os.path.relpath(fp, full))
                            zf.write(fp, arc)
                else:
                    zf.write(full, os.path.basename(full))
            return "已压缩：%s（%.1f KB）" % (out, os.path.getsize(out) / 1024)

        elif action == "unzip":
            out_dir = _resolve(ws, output) if output else os.path.splitext(full)[0]
            os.makedirs(out_dir, exist_ok=True)
            with zipfile.ZipFile(full, "r") as zf:
                names = zf.namelist()
                zf.extractall(out_dir)
            return "已解压 %d 个文件到：%s" % (len(names), out_dir)

        else:
            return "错误：action 只支持 zip/unzip"
    except Exception as e:
        return "操作失败：" + str(e)
