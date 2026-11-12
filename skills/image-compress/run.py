# 压缩图片技能：单张或目录批量压缩
import os

from PIL import Image

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _resolve(ws, p):
    return p if os.path.isabs(p) else os.path.join(ws, p)


def _compress_one(fp, out_dir, quality, max_width):
    im = Image.open(fp)
    if max_width and im.width > max_width:
        ratio = max_width / im.width
        im = im.resize((max_width, int(im.height * ratio)))
    ext = os.path.splitext(fp)[1].lower()
    name = os.path.basename(fp)
    if ext in (".jpg", ".jpeg"):
        # JPG 不支持透明
        if im.mode in ("RGBA", "P", "LA"):
            im = im.convert("RGB")
        im.save(os.path.join(out_dir, name), "JPEG", quality=quality, optimize=True)
    elif ext == ".png":
        im.save(os.path.join(out_dir, name), "PNG", optimize=True)
    elif ext == ".webp":
        im.save(os.path.join(out_dir, name), "WEBP", quality=quality)
    else:
        im.save(os.path.join(out_dir, name))
    return os.path.join(out_dir, name)


def main(params):
    p = (params.get("path") or "").strip()
    if not p:
        return "错误：请提供图片路径或目录"
    try:
        quality = int(float(params.get("quality") or 70))
    except Exception:
        quality = 70
    try:
        max_width = int(float(params.get("max_width") or 0)) or None
    except Exception:
        max_width = None

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = _resolve(ws, p)
    if not os.path.exists(full):
        return "错误：路径不存在：" + full

    try:
        if os.path.isdir(full):
            files = [os.path.join(full, f) for f in os.listdir(full)
                     if os.path.splitext(f)[1].lower() in IMG_EXTS]
            out_dir = _resolve(ws, params.get("output") or "") if params.get("output") else full
            os.makedirs(out_dir, exist_ok=True)
            results = []
            before = after = 0
            for fp in files:
                before += os.path.getsize(fp)
                results.append(_compress_one(fp, out_dir, quality, max_width))
            for fp in results:
                after += os.path.getsize(fp)
            return "已压缩 %d 张图片到 %s\n体积：%.1f KB → %.1f KB（省 %.0f%%）" % (
                len(files), out_dir, before / 1024, after / 1024,
                (1 - after / before) * 100 if before else 0)

        # 单张
        out_dir = os.path.dirname(full)
        name = os.path.splitext(os.path.basename(full))[0] + "_compressed" + os.path.splitext(full)[1]
        before = os.path.getsize(full)
        result = _compress_one(full, out_dir, quality, max_width)
        os.rename(result, os.path.join(out_dir, name))
        after = os.path.getsize(os.path.join(out_dir, name))
        return "已压缩：%s\n体积：%.1f KB → %.1f KB（省 %.0f%%）" % (
            os.path.join(out_dir, name), before / 1024, after / 1024,
            (1 - after / before) * 100 if before else 0)
    except Exception as e:
        return "压缩失败：" + str(e)
