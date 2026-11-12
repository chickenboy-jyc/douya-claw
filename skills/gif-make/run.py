# 生成 GIF 小动画技能：多图合成 / 文字移动动画
import json
import os

from PIL import Image, ImageDraw, ImageFont


def _load_font(size=48):
    for fp in ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/arial.ttf"]:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                pass
    return ImageFont.load_default()


def _resolve(ws, p):
    return p if os.path.isabs(p) else os.path.join(ws, p)


def main(params):
    frames_raw = (params.get("frames") or "").strip()
    text = (params.get("text") or "").strip()
    output = (params.get("output") or "").strip() or "animation.gif"
    try:
        duration = int(float(params.get("duration") or 200))
    except Exception:
        duration = 200

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    if not output.lower().endswith(".gif"):
        output += ".gif"
    out_full = output if os.path.isabs(output) else os.path.join(ws, output)

    try:
        if frames_raw:
            # 方式1：多张图片合成 GIF
            paths = json.loads(frames_raw)
            if not isinstance(paths, list) or len(paths) < 2:
                return "错误：frames 需要至少 2 张图片的路径数组"
            images = []
            for p in paths:
                full = _resolve(ws, str(p))
                if not os.path.exists(full):
                    return "错误：图片不存在：" + full
                images.append(Image.open(full))
            # 统一尺寸到第一张
            base = images[0].convert("RGBA")
            frames = []
            for im in images[1:]:
                im2 = im.convert("RGBA").resize(base.size)
                frames.append(im2)
            base.save(out_full, save_all=True, append_images=frames, duration=duration, loop=0, disposal=2)
            return "已生成 GIF 动画：%s（%d 帧）" % (out_full, len(images))

        elif text:
            # 方式2：文字从左滑到右的循环动画
            W, H = 500, 200
            font = _load_font(48)
            N = 12
            tmp = Image.new("RGB", (10, 10))
            d = ImageDraw.Draw(tmp)
            bbox = d.textbbox((0, 0), text, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            y = (H - th) // 2
            frames = []
            for i in range(N):
                x = int((W + tw) * i / (N - 1)) - tw  # 从 -tw 滑到 W
                img = Image.new("RGB", (W, H), (30, 30, 34))
                dr = ImageDraw.Draw(img)
                dr.text((x, y), text, font=font, fill=(10, 132, 255))
                frames.append(img)
            frames[0].save(out_full, save_all=True, append_images=frames[1:], duration=duration, loop=0)
            return "已生成文字动画：%s（%d 帧）" % (out_full, N)

        else:
            return "错误：请提供 frames（图片路径数组 JSON）或 text（文字）"
    except Exception as e:
        return "生成失败：" + str(e)
