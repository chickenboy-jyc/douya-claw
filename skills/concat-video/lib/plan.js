'use strict';
/**
 * plan.js —— 「剪辑单」的解析与校验。
 *
 * 设计原则（这一条比字段表更重要）：**剪辑单的一个字段，必须对应某个 MCP 工具的一个参数**，
 * 不允许出现"看起来能用、其实没人消费"的字段。字段名一律用 Concat schema 里的原名
 * （start / duration / in / scale / offsetX / offsetY / opacity / fadeIn / fadeOut / fontSize …），
 * 因为那些名字是 Concat 自己从 API 类型生成的，改个更"好看"的名字只会让映射变模糊。
 *
 * 形状（全部字段可选，除 media / text）：
 * {
 *   "name": "项目名",                        → project_create.name（文件夹名）
 *   "video": { "width":1280, "height":720, "fps":30 },   → project_create.video{width,height,rateNum,rateDen}
 *   "tracks": [                              → 每条 = 一条泳道（数组顺序 = 叠放顺序，先写的在下层）
 *     { "type":"video",                      → video / audio（audio 只影响提示文案，走同一套 clip_add）
 *       "clips": [ {
 *         "media":"a.mp4",                   → media_import.file
 *         "start":0,                         → clip_add.start（秒，时间线上的位置）
 *         "in":0,                            → clip_trim(edge=start, delta=in)（源里从第几秒开始）
 *         "duration":3,                      → clip_trim(edge=end, delta=…)
 *         "scale":1, "offsetX":0, "offsetY":0, "rotation":0,  → clip_transform
 *         "opacity":1, "fadeIn":0, "fadeOut":0, "volume":1,    → clip_update.patch
 *         "transition": { "id":"fade-black", "duration":0.6 }, → clip_update.patch.transitionIn
 *         "keyframes": [ { "property":"scale", "at":0, "value":1, "ease":[0,0,1,1] } ] → keyframe_set
 *       } ] }
 *   ],
 *   "titles":   [ { "text":"标题", "start":0, "duration":3, "offsetY":-0.3, "fontSize":0.1, … } ] → title_add
 *   "captions": [ { "text":"字幕", "start":0.5, "end":2.5 } ]                                  → captions_add
 *   "captionStyle": { "offsetY":0.32, "fontSize":0.05, … }                                     → captions_add.style/offsetY
 *   "export":  { "output":"out.mp4", "crf":20, "preset":"medium", "codec":"h264", "width":… }   → export_start
 *   "preview": { "time":1.0, "width":640, "height":360 } | false                                → preview_frame
 *   "project": "concat-video/复用已有工程"                                                       → project_open
 * }
 */

const { fmtSeconds } = require('./format');

const DEFAULT_VIDEO = { width: 1280, height: 720, fps: 30 };
const KEYFRAME_PROPS = [
  'scale', 'offsetX', 'offsetY', 'rotation', 'opacity', 'volume',
  'maskX', 'maskY', 'maskWidth', 'maskHeight', 'maskRotation', 'maskRoundness', 'maskFeather',
];

/** @param {*} v @returns {number|null} */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {*} v @returns {string} */
function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * 把 fps 拆成 rateNum/rateDen（Concat 用的是分数帧率，29.97 这种要写成 30000/1001）。
 * @param {number} fps
 * @returns {{rateNum:number, rateDen:number}}
 */
function fpsToRate(fps) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return { rateNum: 30, rateDen: 1 };
  if (Number.isInteger(f)) return { rateNum: f, rateDen: 1 };
  return { rateNum: Math.round(f * 1000), rateDen: 1000 };
}

/**
 * 解析剪辑单。**不抛异常**：所有问题收进 errors，一次说清（模型最怕"改一处报一处"）。
 * @param {string|object} raw
 * @returns {{ok:boolean, plan:object|null, errors:string[]}}
 */
function parsePlan(raw) {
  const errors = [];
  let obj = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { ok: false, plan: null, errors: ['剪辑单是空的：plan 要么给 JSON 字符串，要么给对象。'] };
    try {
      obj = JSON.parse(s);
    } catch (e) {
      return {
        ok: false,
        plan: null,
        errors: ['剪辑单不是合法 JSON（' + (e && e.message ? e.message : '解析失败') + '）。'
          + '常见原因：中文引号、末尾多了逗号、字符串里的双引号没转义。'],
      };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, plan: null, errors: ['剪辑单必须是一个 JSON 对象。'] };
  }

  // ── video ────────────────────────────────────────────────────────────
  const vRaw = obj.video && typeof obj.video === 'object' ? obj.video : {};
  const width = num(vRaw.width) || DEFAULT_VIDEO.width;
  const height = num(vRaw.height) || DEFAULT_VIDEO.height;
  const fps = num(vRaw.fps) || DEFAULT_VIDEO.fps;
  if (width < 16 || width > 7680) errors.push('video.width 要在 16~7680 之间（收到 ' + width + '）。');
  if (height < 16 || height > 4320) errors.push('video.height 要在 16~4320 之间（收到 ' + height + '）。');
  if (fps <= 0 || fps > 240) errors.push('video.fps 要在 1~240 之间（收到 ' + fps + '）。');

  // ── tracks / titles / captions ───────────────────────────────────────
  const tracks = [];
  const titles = [];
  const captions = [];
  const trackList = Array.isArray(obj.tracks) ? obj.tracks : [];
  for (let ti = 0; ti < trackList.length; ti += 1) {
    const t = trackList[ti];
    const where = 'tracks[' + ti + ']';
    if (!t || typeof t !== 'object') {
      errors.push(where + ' 必须是对象。');
      continue;
    }
    const type = str(t.type).toLowerCase() || 'video';
    if (type === 'video' || type === 'audio') {
      const clipsRaw = Array.isArray(t.clips) ? t.clips : [];
      if (!clipsRaw.length) {
        errors.push(where + '（' + type + '）的 clips 是空的；空泳道没有意义，可以整条删掉。');
        continue;
      }
      const clips = [];
      for (let ci = 0; ci < clipsRaw.length; ci += 1) {
        const c = clipsRaw[ci];
        const cw = where + '.clips[' + ci + ']';
        if (!c || typeof c !== 'object') {
          errors.push(cw + ' 必须是对象。');
          continue;
        }
        const media = str(c.media || c.file || c.path);
        if (!media) {
          errors.push(cw + ' 缺 media（要一个视频/图片/音频文件路径，比如 "a.mp4"）。');
          continue;
        }
        const start = num(c.start);
        const inSec = num(c.in === undefined ? c.sourceStart : c.in);
        const duration = num(c.duration);
        if (start !== null && start < 0) errors.push(cw + '.start 不能是负数（收到 ' + start + '）；要放在片头就写 0。');
        if (inSec !== null && inSec < 0) errors.push(cw + '.in 不能是负数（收到 ' + inSec + '）。');
        if (duration !== null && duration <= 0) errors.push(cw + '.duration 必须是正数（收到 ' + duration + '）。');
        const kfs = [];
        const kfRaw = Array.isArray(c.keyframes) ? c.keyframes : [];
        for (let ki = 0; ki < kfRaw.length; ki += 1) {
          const kf = kfRaw[ki] || {};
          const prop = str(kf.property);
          const at = num(kf.at);
          const value = num(kf.value);
          if (KEYFRAME_PROPS.indexOf(prop) < 0) {
            errors.push(cw + '.keyframes[' + ki + '].property 只能是 ' + KEYFRAME_PROPS.join(' / ') + '（收到「' + prop + '」）。');
            continue;
          }
          if (at === null || at < 0 || at > 1) {
            errors.push(cw + '.keyframes[' + ki + '].at 是「片段内的比例」，取值 0~1（0=片段开头，1=片段结尾）。');
            continue;
          }
          if (value === null) {
            errors.push(cw + '.keyframes[' + ki + '].value 必须是数字。');
            continue;
          }
          const ease = Array.isArray(kf.ease) && kf.ease.length === 4
            ? kf.ease.map((x) => num(x)).filter((x) => x !== null)
            : null;
          kfs.push({
            property: prop,
            at,
            value,
            ease: ease && ease.length === 4 ? ease : null,
          });
        }
        let transition = null;
        if (c.transition) {
          const tr = typeof c.transition === 'string' ? { id: c.transition } : c.transition;
          const tid = str(tr.id || tr.name);
          const tdur = num(tr.duration);
          if (!tid) {
            errors.push(cw + '.transition 缺 id（比如 "fade-black" / "dissolve" / "concat.fade-black"）。');
          } else {
            transition = { id: tid, duration: tdur === null ? 0.6 : tdur };
            if (transition.duration <= 0) {
              errors.push(cw + '.transition.duration 必须是正数（收到 ' + tr.duration + '）。');
            }
          }
        }
        clips.push({
          media,
          start: start === null ? 0 : start,
          in: inSec === null ? 0 : inSec,
          duration,
          scale: num(c.scale),
          offsetX: num(c.offsetX),
          offsetY: num(c.offsetY),
          rotation: num(c.rotation),
          opacity: num(c.opacity),
          fadeIn: num(c.fadeIn),
          fadeOut: num(c.fadeOut),
          volume: num(c.volume),
          transition,
          keyframes: kfs,
        });
      }
      if (clips.length) tracks.push({ type, clips });
    } else if (type === 'titles' || type === 'text' || type === 'title') {
      // 兼容团队草案里的「文本泳道」写法：把泳道里的 titles 摊平到顶层
      const list = Array.isArray(t.titles) ? t.titles : (Array.isArray(t.clips) ? t.clips : []);
      for (const item of list) titles.push(item);
    } else if (type === 'captions' || type === 'subtitle' || type === 'subtitles') {
      const list = Array.isArray(t.captions) ? t.captions : [];
      for (const item of list) captions.push(item);
    } else {
      errors.push(where + '.type 只能是 video / audio / titles / captions（收到「' + type + '」）。');
    }
  }
  if (Array.isArray(obj.titles)) for (const item of obj.titles) titles.push(item);
  if (Array.isArray(obj.captions)) for (const item of obj.captions) captions.push(item);

  // ── titles 归一化 ────────────────────────────────────────────────────
  const normTitles = [];
  for (let i = 0; i < titles.length; i += 1) {
    const raw0 = titles[i];
    if (!raw0 || typeof raw0 !== 'object') {
      errors.push('titles[' + i + '] 必须是对象。');
      continue;
    }
    const text = str(raw0.text === undefined ? raw0.content : raw0.text);
    if (!text) {
      errors.push('titles[' + i + '].text 不能为空。');
      continue;
    }
    const start = num(raw0.start);
    const duration = num(raw0.duration);
    if (start !== null && start < 0) errors.push('titles[' + i + '].start 不能是负数。');
    if (duration !== null && duration <= 0) errors.push('titles[' + i + '].duration 必须是正数。');
    normTitles.push({
      text,
      start: start === null ? 0 : start,
      duration, // null → 交给 Concat 的默认（4 秒）
      offsetY: num(raw0.offsetY),
      fontSize: num(raw0.fontSize),
      color: str(raw0.color),
      fontWeight: num(raw0.fontWeight),
      align: str(raw0.align),
      background: str(raw0.background),
      strokeWidth: num(raw0.strokeWidth),
      strokeColor: str(raw0.strokeColor),
      fontFamily: str(raw0.fontFamily),
      italic: typeof raw0.italic === 'boolean' ? raw0.italic : null,
      opacity: num(raw0.opacity),
    });
  }

  // ── captions 归一化 ──────────────────────────────────────────────────
  const normCaptions = [];
  for (let i = 0; i < captions.length; i += 1) {
    const raw0 = captions[i];
    if (!raw0 || typeof raw0 !== 'object') {
      errors.push('captions[' + i + '] 必须是对象。');
      continue;
    }
    const text = str(raw0.text);
    const start = num(raw0.start);
    const end = num(raw0.end);
    if (!text) {
      errors.push('captions[' + i + '].text 不能为空。');
      continue;
    }
    if (start === null || end === null) {
      errors.push('captions[' + i + '] 要同时给 start 和 end（秒，如 start:0.5, end:2.5）。');
      continue;
    }
    if (start < 0) errors.push('captions[' + i + '].start 不能是负数。');
    if (end <= start) {
      errors.push('captions[' + i + '] 的 end 必须大于 start（收到 ' + start + ' → ' + end + '）。');
      continue;
    }
    normCaptions.push({ text, start, end });
  }

  // ── captionStyle ─────────────────────────────────────────────────────
  const csRaw = obj.captionStyle && typeof obj.captionStyle === 'object' ? obj.captionStyle : {};
  const captionStyle = {
    offsetY: num(csRaw.offsetY),
    fontSize: num(csRaw.fontSize),
    color: str(csRaw.color),
    fontWeight: num(csRaw.fontWeight),
    align: str(csRaw.align),
    background: str(csRaw.background),
    strokeWidth: num(csRaw.strokeWidth),
    strokeColor: str(csRaw.strokeColor),
  };

  // ── export ───────────────────────────────────────────────────────────
  const eRaw = obj.export && typeof obj.export === 'object' ? obj.export : {};
  const exportCfg = {
    output: str(eRaw.output || eRaw.path || ''),
    crf: num(eRaw.crf),
    preset: str(eRaw.preset),
    codec: str(eRaw.codec),
    width: num(eRaw.width),
    height: num(eRaw.height),
    rateNum: num(eRaw.rateNum),
    rateDen: num(eRaw.rateDen),
  };
  if (exportCfg.crf !== null && (exportCfg.crf < 0 || exportCfg.crf > 51)) {
    errors.push('export.crf 要在 0~51 之间（越小越清晰、文件越大；默认 20）。');
  }
  if (exportCfg.codec && ['h264', 'hevc', 'av1'].indexOf(exportCfg.codec) < 0) {
    errors.push('export.codec 只能是 h264 / hevc / av1（收到「' + exportCfg.codec + '」）。');
  }

  // ── preview ──────────────────────────────────────────────────────────
  let preview = null;
  if (obj.preview === false) {
    preview = false;
  } else if (obj.preview && typeof obj.preview === 'object') {
    const pRaw = obj.preview;
    const time = num(pRaw.time);
    preview = {
      time: time === null ? null : Math.max(0, time),
      width: num(pRaw.width),
      height: num(pRaw.height),
      output: str(pRaw.output),
    };
    if (preview.width !== null && preview.width > 8192) errors.push('preview.width 最大 8192。');
    if (preview.height !== null && preview.height > 8192) errors.push('preview.height 最大 8192。');
  }

  // ── 总检查：一条片子必须真有点东西 ───────────────────────────────────
  const hasVisual = tracks.some((t) => t.type === 'video');
  if (!tracks.length && !normTitles.length && !normCaptions.length) {
    errors.push('剪辑单里什么都没有：至少要给 tracks（画面/声音）、titles（标题）或 captions（字幕）之一。');
  }
  if (!hasVisual && normTitles.length === 0 && normCaptions.length === 0) {
    errors.push('只有声音轨道，没有画面也没有标题/字幕：Concat 能导出，但那会是一条黑屏片子。请确认这是你要的。');
  }

  if (errors.length) return { ok: false, plan: null, errors };

  const rate = fpsToRate(fps);
  const plan = {
    name: str(obj.name) || ('精剪-' + new Date().toISOString().slice(0, 10)),
    video: { width: Math.round(width), height: Math.round(height), fps, rateNum: rate.rateNum, rateDen: rate.rateDen },
    tracks,
    titles: normTitles,
    captions: normCaptions,
    captionStyle,
    export: exportCfg,
    preview,
    project: str(obj.project),
  };
  return { ok: true, plan, errors: [] };
}

/** 给人看的一句话摘要，用于结果文本（不进 MCP）。 */
function planSummary(plan) {
  const parts = [];
  let clipCount = 0;
  for (const t of plan.tracks) clipCount += t.clips.length;
  if (clipCount) parts.push(clipCount + ' 段画面/声音（' + plan.tracks.length + ' 条轨道）');
  if (plan.titles.length) parts.push(plan.titles.length + ' 个标题');
  if (plan.captions.length) parts.push(plan.captions.length + ' 条字幕');
  if (!parts.length) return '空剪辑单';
  const totalTrackDur = plan.tracks.reduce((acc, t) => {
    let m = 0;
    for (const c of t.clips) m = Math.max(m, (c.start || 0) + (c.duration || 0));
    return Math.max(acc, m);
  }, 0);
  const extra = totalTrackDur > 0 ? '，最长轨道约 ' + fmtSeconds(totalTrackDur) : '';
  return parts.join(' + ') + extra;
}

module.exports = { parsePlan, planSummary, DEFAULT_VIDEO, KEYFRAME_PROPS, fpsToRate };
