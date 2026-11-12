# 处理音视频技能：基于 ffmpeg（imageio-ffmpeg 内置二进制）
import json
import os
import subprocess
import tempfile

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# 产物非空契约的下限：0 字节视为失败。
#
# ★ 为什么是 1，而不是"看起来合理"的 100 / 1024：
#   判「有没有产物」是**确定性**问题；判「产物够不够大」不归我们管。
#   设成一个看似聪明的阈值，将来合法的小产物（极短的音频片段、单帧图片）
#   会被误杀，而那种误杀在测试里极难发现（测试素材通常都比阈值大）。
#   ⇒ 只判"非空"，不判"够大"。
MIN_OUTPUT_BYTES = 1


def _resolve(ws, p):
    return p if os.path.isabs(p) else os.path.join(ws, p)


def _run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return False, (r.stderr or r.stdout or "未知错误")[-800:]
    return True, ""


def _make_tmp(out):
    """在 out 的**同一个目录**里建一个同扩展名的临时文件，返回它的路径。

    为什么必须同目录：跨盘/跨卷的 rename 不是原子操作，只有同目录才能保证
    「最终路径要么是旧内容、要么是完整的新内容」，不会出现半截文件。

    为什么保留原扩展名：ffmpeg 靠输出文件的**扩展名**挑封装格式（muxer）。
    改成 .tmp 会让它报 "Unable to find a suitable output format"，
    或按默认容器重新编码，产物就不是用户要的东西了。

    为什么用 mkstemp：路径唯一（同时处理同名文件不会互相覆盖），
    且用点开头的隐藏名 `.<原名>.part-<随机后缀>`，一眼能看出是中间态。
    mkstemp 会顺手把文件建出来（0 字节），ffmpeg 带 -y 会直接覆盖，无副作用。

    ⚠️ 与 `-y` 是**绑定关系**，改一处必须想清另一处（下面是实测，不是推测）：
       mkstemp 建出的这个 0 字节文件，全靠 ffmpeg 命令里的 `-y` 才被覆盖。
       去掉 `-y` 后实测（ffmpeg 7.1，非交互式 stdin）：
           File '...\\.out.mp4.part-xxxx.mp4' already exists. Overwrite? [y/N]
           Not overwriting - exiting
           Error opening output file ...              ← 但 **returncode == 0**
       也就是说它**不报失败**：`_run` 会判成功、临时文件仍是 0 字节，
       随后 `os.replace` 把 **0 字节文件**盖到最终路径上 —— 用户上一个成品被
       **静默换成空文件**。这比"每个 action 都失败"更糟，而且完全没有报错可看。
       ⇒ 想动 `-y` 之前，先把这里的"预建文件"改成"预建目录"（mkdtemp 拿目录，
         产物路径写成 `<目录>/<原名><扩展名>`），二者必须一起改。

    ⚠️ 已知残余：本函数建出的临时文件，在「进程被 OS 级杀掉」时**清不掉**。
       触发条件：用户按「停止」后上游走 `killProcessTree(pid)`（Windows 上是
       `taskkill /PID <pid> /T /F`），python 进程会被**直接终止**，
       没有机会跑任何 except / finally ⇒ `_discard(tmp)` 永远执行不到 ⇒
       输出目录里留下一个 `.<原名>.part-<随机后缀><扩展名>`。
       实测背景：树杀落定前 ffmpeg 还会再写约 890ms（父进程死后孙进程才被 /T 扫到），
       这段时间足够让临时文件长到有内容，所以它不是"0 字节可忽略"的那种垃圾。
       **但最终路径是干净的** —— 这是本函数与 `_run_to_target` 要保证的那一条，也确实保证了：
       原子改名只在成功路径上发生，进程被杀时改名根本没执行过。
       为什么接受这个残余（而不是不修）：
         · 它走点开头的隐藏名，不占最终路径、不影响用户拿到的成品；
         · 要清它得跨到 OS 层（树杀的同时同步删 python 侧的临时名），
           层次上不属于这个技能，硬做会把两层耦合在一起、且更难验。
       将来若要收（独立改动，别混进原子落盘这次）：
         在 `main()` 入口做一次"同目录陈旧清扫" —— 列出 `.<stem>.part-*`，
         按 mtime 超过 N 小时（比如 6h）的删掉；必须按 mtime 而不是"看到就删"，
         否则会把另一个正在跑的同名处理任务的临时文件误删。
    """
    out_dir = os.path.dirname(out) or "."
    stem, ext = os.path.splitext(os.path.basename(out))
    fd, tmp = tempfile.mkstemp(dir=out_dir, prefix="." + stem + ".part-", suffix=ext)
    os.close(fd)
    return tmp


def _discard(path):
    """尽力删掉临时文件；删不掉不影响错误返回（比如文件还被别的进程占着）。"""
    if not path:
        return
    try:
        os.remove(path)
    except Exception:
        pass


def _run_to_target(prefix, out):
    """跑 ffmpeg：产物先写临时文件，**成功之后**才原子改名到最终路径。

    参数：
      prefix: ffmpeg 参数列表（不含输出路径），本函数会把临时文件路径补在末尾。
      out:    最终输出路径。

    返回 (ok, err)，与 `_run` 同形，调用点的写法不用变。

    为什么不直接写 out（本函数存在的理由）：
      ffmpeg 直接往最终路径写时，中途失败、超时、或进程被外部中止，
      最终路径上都会留下一个**截断的坏文件** —— 它和正常产物同名同扩展名，
      用户看到的是「操作失败了」，却很容易把这个坏文件当成品继续用。

    失败时的规矩（重要，别改坏）：
      只清理**自己建的临时文件**，绝不碰 out。
      因为 out 很可能就是用户上一次成功处理出来的成品（重复处理同一路径时），
      失败时把它删掉，比留个坏文件更糟。
      ⇒ 失败路径只保证「out 保持原样」：本来不存在就还是不存在，
        本来有内容就还是那份内容（逐字节不变）。

    异常（含 `subprocess` 超时 180s 抛的 TimeoutExpired、被中止等）同样走清理分支，
    不会把异常里的临时文件漏在盘上。

    ★ 成功契约不只是「ffmpeg 返回 0」，还必须「产物非空」（MIN_OUTPUT_BYTES）。
      为什么必须有这一条（实测，不是推测）：
        ffmpeg 在"输出文件已存在、且没有 -y"时会打印
            File 'xxx' already exists. Overwrite? [y/N] Not overwriting - exiting
            Error opening output file xxx.
        然后 **returncode == 0**。也就是说它报了错、一个字节都没写，却说自己成功。
        若只信 returncode，接下来 os.replace 会把 **0 字节文件**盖到最终路径 ——
        用户上一个成品被静默换成空文件，界面上一个错误都看不到。
      这不是"-y 的问题"，是"用返回值代表产物"这种判据本身的问题：空输入、
      某些 muxer 错误路径同样可能 rc=0。⇒ 直接检查产物本身，别猜。

    三种失败必须能从文案上分开（别混成一句「失败」）：
      · ffmpeg 返回非 0        → 原样返回它的 stderr（含 ffmpeg 自己的诊断）
      · ffmpeg 说成功但没产物  → "产物为空（N 字节）：ffmpeg 报告成功但没写出内容。…"
      · 执行期间抛异常        → "执行异常：…"
    """
    tmp = None
    try:
        tmp = _make_tmp(out)
        ok, err = _run(prefix + [tmp])
        if not ok:
            _discard(tmp)
            return False, err
        # 成功契约的第二半：ffmpeg 说成功了，产物还得真的有内容（见函数头注的实测）
        try:
            size = os.path.getsize(tmp)
        except OSError:
            # 拿不到大小（文件被删/无权限）同样按"没有可用产物"处理，不放行
            size = -1
        if size < MIN_OUTPUT_BYTES:
            _discard(tmp)
            return False, (
                "产物为空（%d 字节）：ffmpeg 报告成功但没写出内容。"
                "常见原因：输入里没有有效流、输出格式不受支持、"
                "或在覆盖既有文件时被拒绝（缺 -y 会触发，且此时 ffmpeg 仍返回 0）。"
            ) % size
        # os.replace 在 Windows 上同样是原子替换；os.rename 在目标已存在时会直接失败
        os.replace(tmp, out)
        return True, ""
    except Exception as e:
        _discard(tmp)
        return False, "执行异常：" + str(e)


def main(params):
    action = (params.get("action") or "").strip().lower()
    if not action:
        return "错误：请提供 action（trim/speed/extract-audio/convert/volume/compress/concat）"

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    output = (params.get("output") or "").strip()

    def default_out(ext):
        inp = (params.get("input") or "").strip()
        base = os.path.splitext(os.path.basename(inp))[0] if inp else "output"
        return os.path.join(ws, base + "_" + action + ext)

    try:
        if action == "concat":
            inputs_raw = params.get("inputs") or "[]"
            paths = json.loads(inputs_raw)
            if not isinstance(paths, list) or len(paths) < 2:
                return "错误：concat 需要 inputs 传至少 2 个文件的路径数组"
            if not output:
                return "错误：concat 需要 output 输出文件名"
            out = _resolve(ws, output)
            # 用 concat demuxer
            listfile = os.path.join(ws, "_concat_list.txt")
            with open(listfile, "w", encoding="utf-8") as f:
                for p in paths:
                    f.write("file '%s'\n" % _resolve(ws, str(p)).replace("\\", "/").replace("'", "\\'"))
            try:
                # 拼接同样走「临时文件 → 成功才原子改名」，直写 out 会留下截断的坏视频
                ok, err = _run_to_target(
                    [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", listfile, "-c", "copy"],
                    out,
                )
            finally:
                # 清单文件成功失败都要清掉，别在 ws 里留垃圾
                try:
                    os.remove(listfile)
                except Exception:
                    pass
            return ("已拼接视频：%s" % out) if ok else ("拼接失败：\n" + err)

        inp = (params.get("input") or "").strip()
        if not inp:
            return "错误：请提供 input 输入文件"
        full_in = _resolve(ws, inp)
        if not os.path.exists(full_in):
            return "错误：文件不存在：" + full_in

        if action == "trim":
            start = (params.get("start") or "0").strip()
            out = _resolve(ws, output) if output else default_out(".mp4")
            prefix = [FFMPEG, "-y", "-i", full_in, "-ss", start]
            if params.get("duration"):
                prefix += ["-t", params.get("duration")]
            prefix += ["-c", "copy"]

        elif action == "speed":
            f = params.get("factor") or "2.0"
            out = _resolve(ws, output) if output else default_out(".mp4")
            prefix = [FFMPEG, "-y", "-i", full_in, "-filter:v", "setpts=1/%s*PTS" % f, "-an"]

        elif action == "extract-audio":
            out = _resolve(ws, output) if output else os.path.splitext(full_in)[0] + ".mp3"
            prefix = [FFMPEG, "-y", "-i", full_in, "-vn", "-acodec", "libmp3lame", "-q:a", "2"]

        elif action == "convert":
            fmt = (params.get("format") or "mp4").strip().lower().lstrip(".")
            out = _resolve(ws, output) if output else os.path.splitext(full_in)[0] + "." + fmt
            prefix = [FFMPEG, "-y", "-i", full_in]

        elif action == "volume":
            f = params.get("factor") or "2.0"
            out = _resolve(ws, output) if output else default_out(".mp4")
            prefix = [FFMPEG, "-y", "-i", full_in, "-af", "volume=%s" % f, "-c:v", "copy"]

        elif action == "compress":
            out = _resolve(ws, output) if output else default_out(".mp4")
            prefix = [FFMPEG, "-y", "-i", full_in, "-crf", "28", "-preset", "fast"]

        else:
            return "错误：不支持的 action：" + action

        # 七个分支（含上面的 concat）全部走这里，没有分支能绕过「临时文件 → 原子改名」
        ok, err = _run_to_target(prefix, out)
        return ("已处理（%s）：%s" % (action, out)) if ok else ("处理失败：\n" + err)
    except Exception as e:
        return "处理失败：" + str(e)
