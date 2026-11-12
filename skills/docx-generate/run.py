# 生成 Word 技能
# 约定：def main(params) -> str，结果回填给模型。
# 依赖 python-docx（已装进 python-runtime）。
import json
import os

from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn


ACCENT = RGBColor(0x0A, 0x84, 0xFF)
INK = RGBColor(0x1D, 0x1D, 0x1F)
SUB = RGBColor(0x6E, 0x6E, 0x73)


def _set_cn_font(run, name="微软雅黑"):
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)


def main(params):
    title = (params.get("title") or "").strip() or "未命名文档"
    raw = params.get("sections") or "[]"
    filename = (params.get("filename") or "").strip() or (title + ".docx")

    try:
        sections = json.loads(raw)
    except Exception:
        return "错误：sections 参数不是合法 JSON，请传 [{\"heading\":\"...\",\"paragraphs\":[...]}] 数组"
    if not isinstance(sections, list):
        return "错误：sections 必须是数组"

    if not filename.lower().endswith(".docx"):
        filename += ".docx"
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    out = os.path.join(ws, filename)

    doc = Document()
    # 页边距适度收紧，更接近正式文档排版
    for sec in doc.sections:
        sec.top_margin = Cm(2.2)
        sec.bottom_margin = Cm(2.2)
        sec.left_margin = Cm(2.4)
        sec.right_margin = Cm(2.4)

    # 主标题：居中、蓝、加大
    h = doc.add_paragraph()
    h.alignment = WD_ALIGN_PARAGRAPH.CENTER
    hr = h.add_run(title)
    hr.bold = True
    hr.font.size = Pt(22)
    hr.font.color.rgb = ACCENT
    _set_cn_font(hr)
    h.paragraph_format.space_after = Pt(18)

    for s in sections:
        if isinstance(s, str):
            p = doc.add_paragraph(str(s))
            p.paragraph_format.line_spacing = 1.5
            continue
        if not isinstance(s, dict):
            continue
        heading = (s.get("heading") or "").strip()
        paragraphs = s.get("paragraphs") or []
        bullets = s.get("bullets") or []

        if heading:
            hd = doc.add_paragraph()
            hdr = hd.add_run(heading)
            hdr.bold = True
            hdr.font.size = Pt(15)
            hdr.font.color.rgb = ACCENT
            _set_cn_font(hdr)
            hd.paragraph_format.space_before = Pt(14)
            hd.paragraph_format.space_after = Pt(8)

        if isinstance(paragraphs, str):
            paragraphs = [paragraphs]
        if isinstance(bullets, str):
            bullets = [bullets]

        for t in paragraphs:
            p = doc.add_paragraph()
            r = p.add_run(str(t))
            r.font.size = Pt(11)
            r.font.color.rgb = INK
            _set_cn_font(r)
            p.paragraph_format.line_spacing = 1.5
            p.paragraph_format.space_after = Pt(6)

        for b in bullets:
            p = doc.add_paragraph(style="List Bullet")
            r = p.add_run(str(b))
            r.font.size = Pt(11)
            r.font.color.rgb = INK
            _set_cn_font(r)
            p.paragraph_format.line_spacing = 1.4
            p.paragraph_format.space_after = Pt(4)

    doc.save(out)
    return "已生成 Word：%s（%d 个小节）" % (out, len(sections))
