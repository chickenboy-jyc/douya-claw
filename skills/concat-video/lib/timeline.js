'use strict';
/**
 * timeline.js —— 把 `timeline_read` 返回的 JSON 翻译成「人和模型都读得懂」的文字。
 *
 * 为什么必须翻译：`timeline_read` 的原始返回是一坨 JSON（本机实测 6 秒 3 元素的小工程就有
 * 1.5 KB，稍大的工程动辄几十 KB）。原样塞回给模型既烧 token 又不解决问题 ——
 * 模型真正想知道的是「这条片子有几段画面、多长、标题写的是什么、哪条泳道在上层」。
 *
 * 层叠顺序（实测，非文档）：`timeline.tracks` 数组里**越靠后越在上层**。
 * 实测证据：T1 放甲（红）、T2 放乙（蓝，缩到 40% 移到右上），抽帧后右上角是蓝色 (33,67,204)、
 * 左侧仍是红色 (204,33,34) ⇒ T2 盖住了 T1。
 */

const { fmtSeconds } = require('./format');

const KIND_LABEL = {
  video: '画面',
  text: '文字',
  audio: '声音',
  image: '图片',
  soundLayer: '音效层',
  effectLayer: '特效层',
};

/** @param {string} k @returns {string} */
function kindLabel(k) {
  return KIND_LABEL[String(k || '')] || String(k || '元素');
}

/**
 * @param {*} data timeline_read 的 structuredContent
 * @param {{maxClips?:number}=} opts
 * @returns {{ok:boolean, text:string, stats:object}}
 */
function describeTimeline(data, opts) {
  const o = opts || {};
  const maxClips = Number.isFinite(o.maxClips) && o.maxClips > 0 ? o.maxClips : 60;
  const d = data && typeof data === 'object' ? data : null;
  if (!d) return { ok: false, text: '没读到工程内容（Concat 返回为空）。', stats: {} };

  const project = d.project || {};
  const timeline = d.timeline || {};
  const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  const media = Array.isArray(d.media) ? d.media : [];

  const lines = [];
  lines.push('工程：' + (project.name || '未命名') + ' · ' + (project.width || '?') + '×' + (project.height || '?') +
    ' @' + (project.fps || '?') + 'fps · 时间线「' + (timeline.name || 'Timeline 1') + '」总长 ' + fmtSeconds(timeline.duration || 0));

  if (media.length) {
    const items = media.slice(0, 12).map((m) => {
      const bits = [m.id, m.name || ''];
      if (m.duration) bits.push(fmtSeconds(m.duration));
      if (m.width && m.height) bits.push(m.width + '×' + m.height);
      bits.push(m.hasAudio ? '有声音' : '无声音');
      return bits.join(' ');
    });
    lines.push('素材库（' + media.length + '）：' + items.join('；') + (media.length > 12 ? '；… 还有 ' + (media.length - 12) + ' 个' : ''));
  }

  if (tracks.length) {
    lines.push('泳道（' + tracks.length + ' 条，列表越靠后越在上层）：' +
      tracks.map((t, i) => t.id + '#' + (i + 1)).join('、'));
  }

  if (!clips.length) {
    lines.push('时间线上还没有任何元素。');
    return { ok: true, text: lines.join('\n'), stats: { clips: 0, tracks: tracks.length, media: media.length, duration: timeline.duration || 0 } };
  }

  // 按开始时间排序（Concat 已排过，这里再兜一次，防止不同版本顺序不同）
  const sorted = clips.slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  lines.push('元素（' + sorted.length + ' 个，按时间顺序）：');
  const shown = sorted.slice(0, maxClips);
  for (let i = 0; i < shown.length; i += 1) {
    const c = shown[i];
    const bits = [];
    bits.push(String(i + 1) + '. [' + kindLabel(c.kind) + ']');
    const label = c.text ? ('「' + String(c.text).slice(0, 40) + '」') : (c.name || c.id || '');
    bits.push(label);
    bits.push('泳道 ' + (c.track || '?'));
    bits.push(fmtSeconds(c.start || 0) + '→' + fmtSeconds(c.end || 0));
    if (c.sourceStart) bits.push('源起点 ' + fmtSeconds(c.sourceStart));
    if (c.speed && Number(c.speed) !== 1) bits.push('速度 x' + c.speed);
    if (c.opacity !== undefined && Number(c.opacity) !== 1) bits.push('不透明度 ' + c.opacity);
    if (c.volume !== undefined && Number(c.volume) !== 1) bits.push('音量 ' + c.volume);
    if (c.fadeIn) bits.push('淡入 ' + fmtSeconds(c.fadeIn));
    if (c.fadeOut) bits.push('淡出 ' + fmtSeconds(c.fadeOut));
    if (c.scale !== undefined && Number(c.scale) !== 1) bits.push('缩放 ' + c.scale);
    if (c.offsetX || c.offsetY) bits.push('位移 ' + (c.offsetX || 0) + ',' + (c.offsetY || 0));
    if (Array.isArray(c.keyframed) && c.keyframed.length) bits.push('关键帧：' + c.keyframed.join('/'));
    lines.push('  ' + bits.join(' · '));
  }
  if (sorted.length > shown.length) {
    lines.push('  … 还有 ' + (sorted.length - shown.length) + ' 个元素没列出（只显示前 ' + shown.length + ' 个）。');
  }

  const kinds = {};
  for (const c of sorted) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  const statText = Object.keys(kinds).map((k) => kindLabel(k) + ' ' + kinds[k]).join('、');

  return {
    ok: true,
    text: lines.join('\n'),
    stats: {
      clips: sorted.length,
      tracks: tracks.length,
      media: media.length,
      duration: timeline.duration || 0,
      kinds,
      summary: statText,
    },
  };
}

module.exports = { describeTimeline, kindLabel, KIND_LABEL };
