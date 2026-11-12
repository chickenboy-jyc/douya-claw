"""麦克风录音脚本（主进程调用，绕开浏览器麦克风，更稳）。

模式：
  --stream [--device N]   持续录制 16kHz/16bit/mono PCM 到 stdout，直到进程被 kill
  --list                  以 JSON 输出所有输入设备 [{index,name}]
  --test [N]              打开设备(默认N或系统默认) 0.6s，输出最大振幅(整数)到 stdout

设备选择：录音时若未用 --device 指定，则自动过滤掉扬声器/混音/映射器等伪设备，
按静音探测时的信号强度挑选最优麦克风，避免 PortAudio 默认设备选错导致录不到语音。
"""
import sys
import time
import argparse
import threading

import sounddevice as sd
import numpy as np

SAMPLE_RATE = 16000
CHANNELS = 1

# 明显不是麦克风的设备名关键词（扬声器/混音/映射器/输出）
NON_MIC_KEYWORDS = [
    '扬声器', 'speaker', '映射器', '主声音', '混音', '电脑扬声器',
    '2nd output', 'output', 'stereo mix',
]


def list_input_devices():
    devs = sd.query_devices()
    out = []
    for i, d in enumerate(devs):
        if d['max_input_channels'] > 0:
            out.append({'index': i, 'name': d['name']})
    return out


def is_real_mic(name):
    low = name.lower()
    return not any(k.lower() in low for k in NON_MIC_KEYWORDS)


def probe_level(idx, dur=0.25):
    """打开设备 dur 秒，返回 RMS（0~1）。失败返回 -1。"""
    try:
        buf = []

        def cb(indata, n, t, s):
            buf.append(indata.copy())

        with sd.InputStream(
            device=idx, samplerate=SAMPLE_RATE, channels=CHANNELS,
            dtype='int16', blocksize=1024, callback=cb,
        ):
            sd.sleep(int(dur * 1000))
        if not buf:
            return -1
        a = np.concatenate(buf).astype(np.float32) / 32768.0
        return float(np.sqrt(np.mean(a ** 2)))
    except Exception:
        return -1


def pick_input_device():
    """自动选麦克风：排除扬声器/混音等伪设备，并排除环境噪声异常高的热/环路设备，
    在剩余真麦克风中选环境最安静的一个（正常麦克风静音时近乎无声）。
    返回 (index, rms)；若无可用的真麦克风则返回 (None, 0.0) 回退系统默认。
    """
    devs = sd.query_devices()
    candidates = [i for i, d in enumerate(devs) if d['max_input_channels'] > 0]
    # 热/环路设备的环境噪声极大（如 HSD USB AUDIO 静音也有 ~13910 振幅），阈值过滤
    HOT_AMP = 1600  # 对应 RMS 约 0.05
    best = None
    best_rms = 1e9
    for i in candidates:
        if not is_real_mic(devs[i]['name']):
            continue
        rms = probe_level(i, dur=0.12)
        if rms < 0:
            continue
        amp = rms * 32768.0
        if amp > HOT_AMP:
            # 环境噪声过高，疑似扬声器/系统混音环路，跳过
            continue
        if rms < best_rms:
            best_rms = rms
            best = i
    if best is not None:
        return best, best_rms
    return None, 0.0


def stream_record(device=None):
    out = sys.stdout.buffer
    dev_name = None
    if device is not None:
        try:
            dev_name = sd.query_devices()[device]['name']
        except Exception:
            dev_name = None
    # 通知主进程当前使用的设备（前端展示用）
    print(f'DEVICE {device} {dev_name}', file=sys.stderr)
    sys.stderr.flush()

    stop = threading.Event()
    level_peak = 0
    last_print = time.time()

    def callback(indata, frames, audio_time, status):
        nonlocal level_peak, last_print
        if status:
            print(f'[mic] {status}', file=sys.stderr)
        out.write(indata.tobytes())
        out.flush()
        # 累加本块最大振幅，定期输出 LEVEL 供前端实时电平显示
        try:
            m = int(np.abs(indata).max())
        except Exception:
            m = 0
        if m > level_peak:
            level_peak = m
        now = time.time()
        if now - last_print >= 0.2:
            print(f'LEVEL {level_peak}', file=sys.stderr)
            sys.stderr.flush()
            level_peak = 0
            last_print = now

    try:
        kw = {}
        if device is not None:
            kw['device'] = device
        with sd.InputStream(
            samplerate=SAMPLE_RATE, channels=CHANNELS, dtype='int16',
            blocksize=2048, callback=callback, **kw,
        ):
            while not stop.wait(0.1):
                pass
    except Exception as e:
        print(f'[mic] fatal: {e}', file=sys.stderr)
        sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stream', action='store_true')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--test', action='store_true')
    ap.add_argument('--device', type=int, default=None)
    args = ap.parse_args()

    if args.list:
        print(list_input_devices().__str__() if False else __import__('json').dumps(list_input_devices(), ensure_ascii=False))
        return

    if args.test:
        idx = args.device
        lvl = probe_level(idx, dur=0.6) if idx is not None else probe_level(None, dur=0.6)
        # 输出最大振幅（整数）
        amp = 0
        try:
            buf = []

            def cb(indata, n, t, s):
                buf.append(indata.copy())

            with sd.InputStream(
                device=idx, samplerate=SAMPLE_RATE, channels=CHANNELS,
                dtype='int16', blocksize=1024, callback=cb,
            ):
                sd.sleep(600)
            if buf:
                amp = int(np.abs(np.concatenate(buf)).max())
        except Exception as e:
            print(f'[mic] test error: {e}', file=sys.stderr)
        print(str(amp))
        return

    if args.stream:
        stream_record(device=args.device)
        return

    # 默认行为：自动选设备并录音
    dev, _ = pick_input_device()
    stream_record(device=dev)


if __name__ == '__main__':
    main()
