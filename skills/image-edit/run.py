# 编辑图片技能：缩放/裁剪/旋转/灰度/格式转换/水印/亮度
import os

from PIL import Image, ImageDraw, ImageEnhance, ImageFont


def _load_font(size=24):
    for fp in ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/arial.ttf"]:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                pass
    return ImageFont.load_default()


def _to_int(v, default):
    try:
        return int(float(v))
    except Exception:
        return default


def main(params):
    p = (params.get("path") or "").strip()
    action = (params.get("action") or "").strip().lower()
    if not p:
        return "错误：请提供图片路径"
    if not action:
        return "错误：请提供 action（resize/crop/rotate/grayscale/convert/watermark/brightness）"

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = p if os.path.isabs(p) else os.path.join(ws, p)
    if not os.path.exists(full):
        return "错误：图片不存在：" + full

    try:
        im = Image.open(full)
        save_fmt = None  # None 表示保持原格式

        if action == "resize":
            w = _to_int(params.get("width"), 0)
            h = _to_int(params.get("height"), 0)
            if w and h:
                im = im.resize((w, h))
            elif w:
                im = im.resize((w, int(im.height * w / im.width)))
            elif h:
                im = im.resize((int(im.width * h / im.height), h))
            else:
                return "错误：resize 需要 width 或 height"

        elif action == "crop":
            l = _to_int(params.get("left"), 0)
            t = _to_int(params.get("top"), 0)
            r = _to_int(params.get("right"), im.width)
            b = _to_int(params.get("bottom"), im.height)
            im = im.crop((l, t, r, b))

        elif action == "rotate":
            angle = 90.0
            try:
                angle = float(params.get("angle") or 90)
            except Exception:
                pass
            im = im.rotate(angle, expand=True)

        elif action == "grayscale":
            im = im.convert("L")

        elif action == "convert":
            save_fmt = (params.get("format") or "png").strip().lower().lstrip(".")
            if save_fmt == "jpg":
                save_fmt = "jpeg"

        elif action == "watermark":
            text = (params.get("text") or "水印").strip()
            if im.mode != "RGBA":
                im = im.convert("RGBA")
            layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(layer)
            font = _load_font(max(16, im.width // 20))
            # 右下角水印
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            pos = (im.width - tw - 20, im.height - th - 20)
            draw.text(pos, text, font=font, fill=(255, 255, 255, 160))
            im = Image.alpha_composite(im, layer)

        elif action == "brightness":
            try:
                factor = float(params.get("factor") or 1.2)
            except Exception:
                factor = 1.2
            im = ImageEnhance.Brightness(im).enhance(factor)

        else:
            return "错误：不支持的 action：" + action + "（支持 resize/crop/rotate/grayscale/convert/watermark/brightness）"

        # 确定输出路径
        output = (params.get("output") or "").strip()
        if not output:
            base, _ = os.path.splitext(full)
            out_ext = ("." + save_fmt) if save_fmt else os.path.splitext(full)[1]
            output = base + "-edited" + out_ext
        out_full = output if os.path.isabs(output) else os.path.join(ws, output)

        # 保存：JPG 等不支持透明，需转 RGB
        if save_fmt == "jpeg" or out_full.lower().endswith((".jpg", ".jpeg")):
            if im.mode in ("RGBA", "P", "LA"):
                im = im.convert("RGB")
        im.save(out_full, format=(save_fmt or None))

        w, h = im.size
        return "已处理图片（%s）：%s（%d × %d）" % (action, out_full, w, h)
    except Exception as e:
        return "处理失败：" + str(e)
