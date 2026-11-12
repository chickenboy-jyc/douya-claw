# 识别图片技能：尺寸、格式、模式、文件大小 + **客观几何读数**（透明通道 / alpha 包围盒 / 贴边 / 四角像素）
#
# ────────────────────────────────────────────────────────────────────────────
# 为什么加几何读数（用户报障，2026-02）
# ────────────────────────────────────────────────────────────────────────────
#   用户原话：「agent 功能……根本不能闭环 而且连个桌宠都不会做」
#   具体现象：让 agent 把一张**全身**图抠成透明背景做桌宠形象，交付的图**只剩半身**。
#   它没发现的原因有两个，本文件负责第二个：
#     ① 它没法「看」自己产出的图（已由 skills/file-read 的图片分支补上视觉通道）；
#     ② 它也没法**量**这张图 —— 旧版本只返回尺寸/格式/模式/大小，
#        模型拿不到「背景到底有没有透明」「主体是不是被画布边缘切掉了」这类客观事实，
#        只能靠猜；而「猜」正是它敢交付半身图的直接原因。
#   ⇒ 本文件补的是**纯客观读数**：全部由 PIL 算出来，不经过任何模型，永远不会"看错"。
#
# ────────────────────────────────────────────────────────────────────────────
# 判据口径（写死在代码里，改口径 = 改产品行为）
# ────────────────────────────────────────────────────────────────────────────
#   · alpha 包围盒 = 非全透明像素的最小外接矩形（im.convert('RGBA').split()[3].getbbox()）；
#   · 主体占画布 = (x1-x0)/W 与 (y1-y0)/H，按 alpha 包围盒计（不是按不透明像素面积）；
#   · 贴边 = 包围盒的某条边距画布边缘 ≤ 1px（1px 容差吸收抗锯齿/取整误差）；
#   · 「主体」这个概念**只在真的存在透明区时才成立**：整幅不透明时包围盒恒等于整张画布，
#     那时说「主体贴边、可能被裁切」会把每一张普通照片都误报成被裁切 ⇒ 该提示只对
#     「有透明区且包围盒贴边」的图给出。这是与最初需求口径的一处收紧，理由记在这里。
import os

from PIL import Image

# 提示语是**能被 grep 到**的固定文案（门禁与日志都按这两句判读，改字要同步改门禁）
HINT_NO_ALPHA = "提示：这张图没有透明通道，用作桌宠/贴纸会带底色。"
HINT_TOUCH_EDGE = "提示：主体贴到画布边缘，可能被裁切（原图主体不完整）。"

# 包围盒贴边容差（像素）
EDGE_TOLERANCE = 1


def _pct(v):
    """比例 → 一位小数的百分比字符串。"""
    return "%.1f%%" % (float(v) * 100.0)


def _yes_no(flag):
    return "是" if flag else "否"


def _geometry_lines(im, w, h):
    """算出全部几何读数与提示语（纯客观，不调用任何模型）。"""
    out = []

    has_alpha = (im.mode in ("RGBA", "LA")) or ("transparency" in im.info)
    rgba = im.convert("RGBA")
    alpha = rgba.split()[3]
    width_channel, height_channel = alpha.size

    # 直方图前 255 桶 = alpha < 255 的像素数，即**带透明度的**像素（含 alpha=0 全透明与 1~254 半透明）；
    # 第 256 桶（hist[255]）= alpha == 255，即**完全不透明**的像素。
    # ⚠️ 这里曾经把前者标签写成「非全透明像素」，而「非全透明」按字面是 alpha > 0（= 后者）——
    #    标签与数值正好互补，数值对、意思反了。为什么一直没被发现：当时的门禁夹具是
    #    「上半不透明/下半全透明」（50% vs 50%），两个口径恰好相等，任何断言都区分不出来。
    #    现在改成**两个数一起报**（透明/半透明 X% · 完全不透明 Y%），结构性消灭这种误读。
    hist = alpha.histogram()
    total_px = width_channel * height_channel
    translucent_px = sum(hist[:255]) if len(hist) >= 256 else 0   # alpha < 255：带透明度
    opaque_px = max(0, total_px - translucent_px)                 # alpha == 255：完全不透明
    has_transparency = translucent_px > 0

    bbox = alpha.getbbox()

    out.append("透明通道：" + ("有" if has_alpha else "无"))
    if total_px > 0:
        out.append(
            "透明区："
            + ("有（透明/半透明 %s · 完全不透明 %s，按像素计）"
               % (_pct(translucent_px / float(total_px)), _pct(opaque_px / float(total_px)))
               if has_transparency else "无（整幅全不透明）")
        )
    else:
        out.append("透明区：无法计算（画布尺寸为 0）")

    if bbox is None:
        x0, y0, x1, y1 = 0, 0, 0, 0
        out.append("alpha 包围盒：无（整幅全透明，没有任何非透明像素）")
        cover_w = 0.0
        cover_h = 0.0
        touch = {"left": False, "right": False, "top": False, "bottom": False}
    else:
        x0, y0, x1, y1 = bbox
        out.append("alpha 包围盒：%d,%d,%d,%d（x0,y0,x1,y1）" % (x0, y0, x1, y1))
        cover_w = (float(x1 - x0) / w) if w else 0.0
        cover_h = (float(y1 - y0) / h) if h else 0.0
        touch = {
            "left": x0 <= EDGE_TOLERANCE,
            "right": x1 >= (w - EDGE_TOLERANCE),
            "top": y0 <= EDGE_TOLERANCE,
            "bottom": y1 >= (h - EDGE_TOLERANCE),
        }

    out.append("主体占画布：宽 %s / 高 %s（按 alpha 包围盒计）" % (_pct(cover_w), _pct(cover_h)))
    out.append(
        "主体贴边：left=%s right=%s top=%s bottom=%s"
        % (_yes_no(touch["left"]), _yes_no(touch["right"]), _yes_no(touch["top"]), _yes_no(touch["bottom"]))
    )

    corners = []
    if width_channel > 0 and height_channel > 0:
        for label, xy in (
            ("左上", (0, 0)),
            ("右上", (width_channel - 1, 0)),
            ("左下", (0, height_channel - 1)),
            ("右下", (width_channel - 1, height_channel - 1)),
        ):
            try:
                corners.append("%s(%d,%d,%d,%d)" % ((label,) + tuple(rgba.getpixel(xy))))
            except Exception:
                corners.append("%s(读不到)" % label)
    out.append("四角像素：" + (" ".join(corners) if corners else "读不到"))

    # ── 人话判断（照读数给结论，不许编） ──
    if (not has_alpha) or (opaque_px == total_px and total_px > 0):
        out.append(HINT_NO_ALPHA)
    if has_transparency and any(touch.values()):
        out.append(HINT_TOUCH_EDGE)

    return out


def main(params):
    p = (params.get("path") or "").strip()
    if not p:
        return "错误：请提供图片路径"
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = p if os.path.isabs(p) else os.path.join(ws, p)
    if not os.path.exists(full):
        return "错误：图片不存在：" + full
    try:
        with Image.open(full) as im:
            w, h = im.size
            fmt = im.format or os.path.splitext(full)[1].lstrip(".").upper()
            mode = im.mode
            size_kb = os.path.getsize(full) // 1024
            lines = [
                "尺寸：%d × %d 像素" % (w, h),
                "格式：%s" % fmt,
                "模式：%s" % mode,
                "文件大小：约 %d KB" % size_kb,
            ]
            lines.extend(_geometry_lines(im, w, h))
            return "\n".join(lines)
    except Exception as e:
        return "识别失败：" + str(e)
