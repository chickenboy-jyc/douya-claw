# 生成 PPT 技能
# 约定：def main(params) -> str，结果回填给模型。
# 依赖 python-pptx（已装进 python-runtime）。
import json
import os
import sys
import datetime

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR


# 配色主题（苹果风蓝 + 深浅灰，统一协调）
ACCENT = RGBColor(0x0A, 0x84, 0xFF)      # 主蓝
ACCENT_DARK = RGBColor(0x00, 0x5E, 0xC9)  # 深蓝
INK = RGBColor(0x1D, 0x1D, 0x1F)          # 正文深灰
SUB = RGBColor(0x6E, 0x6E, 0x73)          # 次要灰
LIGHT = RGBColor(0xF5, 0xF7, 0xFA)        # 浅底


def _set_bar(shape, color):
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()


def main(params):
    title = (params.get("title") or "").strip() or "未命名演示"
    subtitle = (params.get("subtitle") or "").strip()
    author = (params.get("author") or "").strip()
    raw = params.get("slides") or "[]"
    filename = (params.get("filename") or "").strip() or (title + ".pptx")

    try:
        slides = json.loads(raw)
    except Exception:
        return "错误：slides 参数不是合法 JSON，请传 [{\"title\":\"...\",\"bullets\":[...]}] 数组"

    if not isinstance(slides, list):
        return "错误：slides 必须是数组"

    if not filename.lower().endswith(".pptx"):
        filename += ".pptx"

    # ===== 页数预算（可选参数 expected_pages）=====
    # 口径：本技能**无条件**在 slides 之前加 1 页封面，所以
    #     总页数 = len(slides) + 1   ⇔   正文条数 = 总页数 - 1
    # 给了 expected_pages 就必须**恰好**相等。不等则：
    #   ① 一个字节都不写盘（此时 prs 还没创建、prs.save() 一次都没调 ⇒ 不会覆盖旧文件、不留半成品）
    #   ② 在 stderr 说清「期望总页数 / 正文应为几张 / 实际传入几张」
    #   ③ 以非 0 退出码结束 —— 调用方据此判**失败**，而不是"看起来成功、产物却多一页"
    # ⚠️ 未传 expected_pages 时，本段**不产生任何新失败路径**，行为与加这段之前逐字一致。
    # 为什么必须非 0 退出而不是 return "错误：…"：技能返回值只是 stdout 文本，退出码仍是 0；
    #   src/main/skills.js 的 runPython 只在子进程 err 时才 reject（见 PY_BOOTSTRAP 头注）。
    raw_expected = params.get("expected_pages")
    expected_total = None
    if raw_expected is not None and str(raw_expected).strip() != "":
        try:
            expected_total = int(str(raw_expected).strip())
        except (TypeError, ValueError):
            sys.stderr.write(
                "错误：expected_pages 必须是整数（本次收到 %r）。"
                "它表示**总页数、含封面**；本技能会自动加 1 页封面 ⇒ 正文条数应为 expected_pages - 1。\n"
                % (raw_expected,)
            )
            raise SystemExit(1)
        if expected_total < 1:
            sys.stderr.write("错误：expected_pages 必须 >= 1（含封面），本次收到 %d。\n" % expected_total)
            raise SystemExit(1)
        actual_total = len(slides) + 1
        if actual_total != expected_total:
            sys.stderr.write(
                "错误：页数不符，未生成任何文件。期望总页数 %d 页（含封面）⇒ 正文应为 %d 张，"
                "实际传入 %d 张（照此生成会是 %d 页）。\n"
                "本技能在正文前**无条件**加 1 页封面，所以请把 slides 调整到恰好 %d 条后重试。\n"
                % (expected_total, expected_total - 1, len(slides), actual_total, expected_total - 1)
            )
            raise SystemExit(1)

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    out = os.path.join(ws, filename)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]  # 空白版式

    # ===== 封面页 =====
    cover = prs.slides.add_slide(blank)
    # 顶部主蓝装饰条
    bar = cover.shapes.add_shape(1, 0, 0, prs.slide_width, Inches(0.28))  # 1 = MSO_SHAPE.RECTANGLE
    _set_bar(bar, ACCENT)
    # 左下角浅色大色块点缀
    deco = cover.shapes.add_shape(1, Inches(0), Inches(5.2), Inches(13.333), Inches(2.3))
    _set_bar(deco, LIGHT)
    # 主标题
    tb = cover.shapes.add_textbox(Inches(1.1), Inches(2.1), Inches(11.1), Inches(1.8))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = title
    p.font.size = Pt(44)
    p.font.bold = True
    p.font.color.rgb = INK
    # 副标题
    if subtitle:
        stb = cover.shapes.add_textbox(Inches(1.15), Inches(3.9), Inches(11.0), Inches(0.8))
        stf = stb.text_frame
        stf.word_wrap = True
        sp = stf.paragraphs[0]
        sp.text = subtitle
        sp.font.size = Pt(20)
        sp.font.color.rgb = SUB
    # 底部信息（作者 + 日期）
    meta = []
    if author:
        meta.append(author)
    meta.append(datetime.date.today().strftime("%Y-%m-%d"))
    mb = cover.shapes.add_textbox(Inches(1.15), Inches(5.5), Inches(11.0), Inches(0.5))
    mp = mb.text_frame.paragraphs[0]
    mp.text = " · ".join(meta)
    mp.font.size = Pt(13)
    mp.font.color.rgb = SUB

    # ===== 内容页 =====
    total = len(slides)
    for i, item in enumerate(slides):
        if isinstance(item, dict):
            st = (item.get("title") or "").strip() or "（无标题）"
            bullets = item.get("bullets") or []
        elif isinstance(item, str):
            st = item.strip() or "（无标题）"
            bullets = []
        else:
            continue
        if isinstance(bullets, str):
            bullets = [bullets]

        slide = prs.slides.add_slide(blank)
        # 左侧蓝色竖条 + 页标题
        leftbar = slide.shapes.add_shape(1, Inches(0.55), Inches(0.55), Inches(0.14), Inches(1.0))
        _set_bar(leftbar, ACCENT)
        tb = slide.shapes.add_textbox(Inches(0.85), Inches(0.5), Inches(11.4), Inches(1.1))
        tf = tb.text_frame
        tf.word_wrap = True
        tp = tf.paragraphs[0]
        tp.text = st
        tp.font.size = Pt(30)
        tp.font.bold = True
        tp.font.color.rgb = INK
        # 标题下装饰线
        line = slide.shapes.add_shape(1, Inches(0.88), Inches(1.62), Inches(3.2), Inches(0.03))
        _set_bar(line, ACCENT_DARK)

        # 要点正文
        body = slide.shapes.add_textbox(Inches(0.95), Inches(2.0), Inches(11.3), Inches(4.7))
        btf = body.text_frame
        btf.word_wrap = True
        first = True
        for b in bullets:
            para = btf.paragraphs[0] if first else btf.add_paragraph()
            first = False
            para.text = "●  " + str(b)
            para.font.size = Pt(18)
            para.font.color.rgb = INK
            para.space_after = Pt(14)
            para.line_spacing = 1.25

        # 右下角页码（**物理页口径**：封面算第 1 页）
        # 为什么分子是 i + 2、分母是 total + 1：封面本身不带页脚，但它是文件里的第 1 页。
        #   旧写法 "%d / %d" % (i + 1, total) 用的是**正文序号 / 正文条数**，
        #   于是 4 条正文 + 1 封面 = 5 页的文件上，页脚写的是 "1 / 4"…"4 / 4"，
        #   与「文件共几页」自相矛盾（同一份 6 页的文件上会写成 "1 / 5"…"5 / 5"）——
        #   实测就是这么误导模型的（它以为总页数 5，于是删页"凑"到 5，把点名要的内容页删了）。
        pg = slide.shapes.add_textbox(Inches(11.6), Inches(6.85), Inches(1.4), Inches(0.4))
        pp = pg.text_frame.paragraphs[0]
        pp.text = "%d / %d" % (i + 2, total + 1)
        pp.font.size = Pt(12)
        pp.font.color.rgb = SUB
        pp.alignment = PP_ALIGN.RIGHT

    prs.save(out)
    return "已生成 PPT：%s（共 %d 页，含封面）" % (out, total + 1)
