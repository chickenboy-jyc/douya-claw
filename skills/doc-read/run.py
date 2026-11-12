# 读取文档技能：统一读 txt/md/csv/json/docx/pdf/xlsx/pptx
import os

MAX = 8000  # 返回给模型的文本上限（截断避免超长）


def _truncate(txt):
    return txt if len(txt) <= MAX else txt[:MAX] + "\n…(内容过长已截断，可用 file-read 分次读)"


def _read_text(full):
    with open(full, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _read_docx(full):
    from docx import Document
    doc = Document(full)
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            parts.append(" | ".join((c.text or "") for c in row.cells))
    return "\n".join(parts)


def _read_pdf(full):
    from pypdf import PdfReader
    r = PdfReader(full)
    parts = []
    for i, page in enumerate(r.pages, 1):
        parts.append("--- 第%d页 ---\n%s" % (i, (page.extract_text() or "").strip()))
    return "\n\n".join(parts)


def _read_xlsx(full):
    from openpyxl import load_workbook
    wb = load_workbook(full, data_only=True)
    parts = []
    for sn in wb.sheetnames:
        ws = wb[sn]
        parts.append("=== 工作表 %s ===" % sn)
        for row in ws.iter_rows(values_only=True):
            parts.append("\t".join("" if c is None else str(c) for c in row))
    return "\n".join(parts)


def _read_pptx(full):
    from pptx import Presentation
    prs = Presentation(full)
    parts = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append("--- 第%d页 ---" % i)
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    t = "".join(run.text for run in para.runs)
                    if t.strip():
                        parts.append(t)
    return "\n".join(parts)


def main(params):
    p = (params.get("path") or "").strip()
    if not p:
        return "错误：请提供文件路径"
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = p if os.path.isabs(p) else os.path.join(ws, p)
    if not os.path.exists(full):
        return "错误：文件不存在：" + full

    ext = os.path.splitext(full)[1].lower()
    try:
        if ext in (".txt", ".md", ".csv", ".json", ".py", ".js", ".html", ".log", ".xml", ".yml", ".yaml"):
            txt = _read_text(full)
        elif ext == ".docx":
            txt = _read_docx(full)
        elif ext == ".pdf":
            txt = _read_pdf(full)
        elif ext == ".xlsx":
            txt = _read_xlsx(full)
        elif ext == ".pptx":
            txt = _read_pptx(full)
        else:
            return "错误：不支持的类型 " + ext + "（支持 txt/md/csv/json/docx/pdf/xlsx/pptx 等）"
        txt = txt.strip()
        if not txt:
            return "（文件为空或没有可提取的文本）"
        return _truncate(txt)
    except Exception as e:
        return "读取失败：" + str(e)
