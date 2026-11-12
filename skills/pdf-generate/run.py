# 生成 PDF 技能（支持中文）
import json
import os

from fpdf import FPDF


def _find_cjk_font():
    for fp in ["C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/msyh.ttf",
               "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/msyh.ttc"]:
        if os.path.exists(fp):
            return fp
    return None


def main(params):
    title = (params.get("title") or "").strip() or "未命名文档"
    raw = params.get("sections") or "[]"
    filename = (params.get("filename") or "").strip() or (title + ".pdf")

    try:
        sections = json.loads(raw)
    except Exception:
        return "错误：sections 参数不是合法 JSON"
    if not isinstance(sections, list):
        return "错误：sections 必须是数组"

    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    out = os.path.join(ws, filename)

    try:
        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        font_path = _find_cjk_font()
        if font_path:
            pdf.add_font("cjk", "", font_path, uni=True)
            pdf.set_font("cjk", size=12)
        else:
            pdf.set_font("Helvetica", size=12)

        pdf.add_page()
        pdf.set_font("cjk" if font_path else "Helvetica", size=20)
        pdf.multi_cell(0, 12, title)
        pdf.ln(4)

        for s in sections:
            if isinstance(s, str):
                pdf.set_font("cjk" if font_path else "Helvetica", size=12)
                pdf.multi_cell(0, 8, s)
                pdf.ln(2)
                continue
            if not isinstance(s, dict):
                continue
            heading = (s.get("heading") or "").strip()
            paragraphs = s.get("paragraphs") or []
            if isinstance(paragraphs, str):
                paragraphs = [paragraphs]
            if heading:
                pdf.set_font("cjk" if font_path else "Helvetica", size=14)
                pdf.multi_cell(0, 9, heading)
                pdf.ln(2)
            pdf.set_font("cjk" if font_path else "Helvetica", size=12)
            for p in paragraphs:
                pdf.multi_cell(0, 8, str(p))
                pdf.ln(1)
            pdf.ln(3)

        pdf.output(out)
        return "已生成 PDF：%s（%d 个小节）" % (out, len(sections))
    except Exception as e:
        return "生成失败：" + str(e)
