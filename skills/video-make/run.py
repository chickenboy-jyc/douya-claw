# 生成视频技能：多张图片合成 MP4/GIF
import json
import os

import imageio.v2 as imageio
import numpy as np


def _resolve(ws, p):
    return p if os.path.isabs(p) else os.path.join(ws, p)


def main(params):
    raw = params.get("frames") or "[]"
    output = (params.get("output") or "").strip() or "video.mp4"
    try:
        fps = int(float(params.get("fps") or 10))
    except Exception:
        fps = 10

    try:
        paths = json.loads(raw)
    except Exception:
        return "错误：frames 不是合法 JSON 数组"

    if not isinstance(paths, list) or len(paths) < 2:
        return "错误：frames 需要至少 2 张图片的路径数组"

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    out = output if os.path.isabs(output) else os.path.join(ws, output)

    try:
        frames = []
        for p in paths:
            full = _resolve(ws, str(p))
            if not os.path.exists(full):
                return "错误：图片不存在：" + full
            frames.append(np.asarray(imageio.imread(full)))

        # 统一尺寸到第一张（避免 ffmpeg 因尺寸不一致报错）
        h, w = frames[0].shape[:2]
        norm = [f if f.shape[:2] == (h, w) else np.asarray(_resize(f, w, h)) for f in frames]

        imageio.mimsave(out, norm, fps=fps)
        return "已生成视频：%s（%d 帧，%d fps）" % (out, len(frames), fps)
    except Exception as e:
        return "生成失败：" + str(e)


def _resize(arr, w, h):
    from PIL import Image
    return Image.fromarray(arr).resize((w, h))
