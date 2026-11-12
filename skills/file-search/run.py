# 搜索文件技能：按文件名或内容搜索
import fnmatch
import os

TEXT_EXTS = {".txt", ".md", ".csv", ".json", ".py", ".js", ".html", ".css", ".log", ".xml", ".yml", ".yaml", ".ts", ".jsx", ".tsx"}


def main(params):
    pattern = (params.get("pattern") or "").strip()
    content_kw = (params.get("content") or "").strip()
    if not pattern and not content_kw:
        return "错误：请提供 pattern（文件名匹配）或 content（内容关键词）"

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    matched = []

    for root, dirs, files in os.walk(ws):
        # 跳过隐藏目录和 node_modules 等大目录
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", ".git")]
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, ws)
            if pattern and not fnmatch.fnmatch(name, pattern) and pattern.lower() not in name.lower():
                continue
            if content_kw:
                ext = os.path.splitext(name)[1].lower()
                if ext not in TEXT_EXTS:
                    continue
                try:
                    with open(full, "r", encoding="utf-8", errors="ignore") as f:
                        if content_kw not in f.read():
                            continue
                except Exception:
                    continue
            matched.append(rel)

    if not matched:
        return "没有找到匹配的文件"
    if len(matched) > 50:
        return "找到 %d 个文件（仅显示前 50 个）：\n%s\n…" % (len(matched), "\n".join(matched[:50]))
    return "找到 %d 个文件：\n%s" % (len(matched), "\n".join(matched))
