# 批量重命名技能：match 匹配文件，改成 prefix_序号.ext
import glob
import os


def main(params):
    match = (params.get("match") or "").strip()
    prefix = (params.get("prefix") or "").strip()
    if not match or not prefix:
        return "错误：请提供 match（匹配模式）和 prefix（新前缀）"
    try:
        start = int(float(params.get("start") or 1))
    except Exception:
        start = 1

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    files = sorted(glob.glob(os.path.join(ws, match)))
    if not files:
        return "没有找到匹配 %s 的文件" % match

    renamed = []
    for i, fp in enumerate(files):
        ext = os.path.splitext(fp)[1]
        new_name = "%s_%d%s" % (prefix, start + i, ext)
        new_path = os.path.join(os.path.dirname(fp), new_name)
        # 避免重名冲突
        if os.path.exists(new_path) and os.path.abspath(new_path) != os.path.abspath(fp):
            return "错误：目标文件名冲突：%s 已存在，请换 prefix" % new_name
        os.rename(fp, new_path)
        renamed.append("%s -> %s" % (os.path.basename(fp), new_name))

    return "已重命名 %d 个文件：\n%s" % (len(renamed), "\n".join(renamed))
