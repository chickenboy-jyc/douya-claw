# OCR 文字识别技能：rapidocr（中英文）
import os

from rapidocr_onnxruntime import RapidOCR


def main(params):
    p = (params.get("path") or "").strip()
    if not p:
        return "错误：请提供图片路径"
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = p if os.path.isabs(p) else os.path.join(ws, p)
    if not os.path.exists(full):
        return "错误：图片不存在：" + full

    try:
        ocr = RapidOCR()
        result, _ = ocr(full)
        if not result:
            return "（未识别到文字）"
        lines = []
        for item in result:
            if item and len(item) >= 2:
                lines.append(str(item[1]))
        text = "\n".join(lines).strip()
        return text or "（未识别到文字）"
    except Exception as e:
        return "识别失败：" + str(e)
