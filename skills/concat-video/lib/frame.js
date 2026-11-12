'use strict';
/**
 * frame.js —— action=frame：在指定时间点抽一帧存成 PNG，**返回绝对路径**。
 *
 * 为什么不是返回 base64：实测 `preview_frame` 不带 output 时会把 PNG 内联成 base64 塞进
 * JSON（320×180 就有 2 万字符，整帧能到几 MB）。那既撑爆返回文本，也没法给用户看。
 * 带 `output` 参数时 Concat 直接写文件，并把宽高回给调用方 —— 于是一次调用同时拿到
 * 「文件路径」和「它自称的尺寸」，可以立刻比对是不是真按要的尺寸出的图。
 */

const path = require('path');

const { openSession } = require('./mcp');
const { resolveAny, ensureDir, isDir, isFile, workspace, stamp, safeSlug } = require('./paths');
const { readPngInfo } = require('./png');
const { fmtBytes } = require('./format');

const FRAME_PARENT = 'concat-frames';

/**
 * @param {object} params
 * @param {{deadline?:number}=} _opts 预留（抽帧不参与长任务时限编排，单次 preview_frame 自己带超时）
 * @returns {Promise<string>}
 */
async function runFrame(params, _opts) {
  const p = params && typeof params === 'object' ? params : {};
  const rawProject = String(p.project || '').trim();
  if (!rawProject) {
    return '错误：frame 要一个工程目录。用 project="concat-video/我的片子"（render 的返回里有「工程目录」这一行）。';
  }
  const projDir = resolveAny(rawProject);
  if (!isDir(projDir)) return '错误：工程目录不存在：' + projDir;
  if (!isFile(path.join(projDir, 'concat.json'))) {
    return '错误：这个目录里没有 Concat 工程（缺 concat.json）：' + projDir;
  }

  const t = p.time === undefined || p.time === null || p.time === '' ? 0 : Number(p.time);
  if (!Number.isFinite(t) || t < 0) {
    return '错误：time 要是非负的秒数（收到「' + String(p.time) + '」）。比如 time=1.5 表示第 1.5 秒。';
  }

  let outAbs = String(p.output || '').trim() ? resolveAny(p.output) : '';
  if (!outAbs) {
    const dir = path.join(workspace(), FRAME_PARENT);
    try {
      ensureDir(dir);
    } catch (e) {
      return '错误：抽帧目录建不出来：' + dir + '（' + (e && e.message ? e.message : e) + '）';
    }
    outAbs = path.join(dir, safeSlug(path.basename(projDir), 'frame') + '-' + String(t).replace('.', '_') + 's-' + stamp() + '.png');
  } else {
    try {
      ensureDir(path.dirname(outAbs));
    } catch (e) {
      return '错误：抽帧目录建不出来：' + path.dirname(outAbs) + '（' + (e && e.message ? e.message : e) + '）';
    }
    if (!/\.png$/i.test(outAbs)) outAbs += '.png';
  }

  const opened = await openSession();
  if (!opened.ok) return opened.message;
  const session = opened.session;
  let didOpen = false;
  try {
    const op = await session.call('project_open', { path: projDir });
    if (!op.ok) {
      return '错误：打不开工程「' + projDir + '」：' + op.message +
        '\n（Concat 窗口里正开着同一个工程时也会这样，先关掉窗口再试。）';
    }
    didOpen = true;

    // 顺便读一次时间线：既确认时间点是否超出片长，也拿到工程尺寸
    const tl = await session.call('timeline_read', { path: projDir });
    const tlData = tl.ok ? tl.data : null;
    const timeline = (tlData && tlData.timeline) || {};
    const project = (tlData && tlData.project) || {};
    const dur = Number(timeline.duration) || 0;
    const lines = [];
    if (dur > 0 && t > dur + 0.001) {
      return '错误：这条片子总长只有 ' + dur + ' 秒，第 ' + t + ' 秒已经在片尾之后，抽不出画面。\n' +
        '请把 time 改成 0 ~ ' + dur + ' 之间的值。';
    }

    const args = { path: projDir, time: t, output: outAbs };
    const pf = await session.call('preview_frame', args, { timeoutMs: 180000 });
    if (!pf.ok) {
      return '错误：抽帧失败（第 ' + t + ' 秒）：' + pf.message;
    }
    const info = readPngInfo(outAbs);
    if (!info.ok) {
      return '错误：Concat 说抽帧成功了，但产物不像有效 PNG：' + info.error + '\n文件：' + outAbs +
        '（' + fmtBytes(info.bytes) + '）';
    }
    const claimedW = pf.data && pf.data.width ? Number(pf.data.width) : 0;
    const claimedH = pf.data && pf.data.height ? Number(pf.data.height) : 0;
    const sizeNote = claimedW && claimedH
      ? (claimedW === info.width && claimedH === info.height
        ? '尺寸与 Concat 回报一致'
        : '注意：Concat 回报 ' + claimedW + '×' + claimedH + '，实际 PNG 是 ' + info.width + '×' + info.height)
      : '（Concat 没回报尺寸）';

    lines.push('已生成预览帧：' + outAbs + '（第 ' + t + ' 秒，' + info.width + '×' + info.height + '，' +
      fmtBytes(info.bytes) + '，' + sizeNote + '）');
    lines.push('工程：' + projDir + (project.width ? '（' + project.width + '×' + project.height + '）' : '') +
      (dur ? '，片长 ' + dur + ' 秒' : ''));
    lines.push('这个 PNG 可以直接打开看：标题、字幕、画中画、转场是否真的合成对了。');
    return lines.join('\n');
  } catch (e) {
    return '错误：抽帧过程中出现了没预料到的问题：' + (e && e.message ? e.message : String(e));
  } finally {
    if (didOpen) {
      // 只读：不保存（抽帧不改任何东西）
      try {
        await session.call('project_close', { path: projDir, save: false });
      } catch {
        /* 收尾失败不覆盖主错误 */
      }
    }
    await session.close();
  }
}

module.exports = { runFrame };
