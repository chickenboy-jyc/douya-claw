# TTS 语音合成脚本：用 edge-tts 把文字合成为 mp3
# 用法：python tts_voice.py <输出mp3路径> [voice]
# 文字从 stdin 读取（避免命令行参数长度限制）
import sys
import asyncio

import edge_tts


async def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "out.mp3"
    voice = sys.argv[2] if len(sys.argv) > 2 else "zh-CN-XiaoxiaoNeural"
    text = sys.stdin.read().strip()
    if not text:
        return
    tts = edge_tts.Communicate(text, voice)
    await tts.save(out)


if __name__ == "__main__":
    asyncio.run(main())
