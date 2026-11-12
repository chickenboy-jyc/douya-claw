'use strict';
/**
 * transitions.js —— 转场：把「人话名字」翻成 Concat 的包 id。
 *
 * 为什么需要这一层：Concat 的转场 id 是打包产物名（`concat.fade-black` / `concat.iris` /
 * `concat.zoom-transition`），模型几乎不可能一次猜对；写错了 Concat 只会回一句
 * "unknown effect"，用户看到的就是"转场没生效"。所以这里给一张**实测存在**的映射表
 * （本机 concat 0.2.9 的 `effects_list` 里 22 个 transition 包），错了能立刻指出可用值。
 *
 * 真源校验：不认识的名字不静默忽略，也不瞎猜 —— 直接报错并把可用名字列出来。
 */

/** 人话名 → Concat 包 id（取自本机 effects_list 的 kind='transition'） */
const TRANSITION_ALIASES = {
  'fade-black': 'concat.fade-black',
  'fade-white': 'concat.fade-white',
  dissolve: 'concat.dissolve',
  'blur-dissolve': 'concat.blur-dissolve',
  'zoom-transition': 'concat.zoom-transition',
  zoom: 'concat.zoom-transition',
  'zoom-blur': 'concat.zoom-blur-transition',
  iris: 'concat.iris',
  cube: 'concat.cube',
  spin: 'concat.spin',
  swirl: 'concat.swirl',
  slide: 'concat.slide',
  push: 'concat.push',
  'whip-pan': 'concat.whip-pan',
  marquee: 'concat.marquee',
  stadium: 'concat.stadium',
  'clock-wipe': 'concat.clock-wipe',
  'linear-wipe': 'concat.linear-wipe',
  'shape-wipe': 'concat.shape-wipe',
  'rgb-split-wipe': 'concat.rgb-split-wipe',
  'light-leak': 'concat.light-leak-transition',
  'film-burn': 'concat.film-burn',
  glitch: 'concat.glitch-transition',
  'glitch-transition': 'concat.glitch-transition',
};

const TRANSITION_HINTS = Object.keys(TRANSITION_ALIASES).join(' / ');

/**
 * @param {string} name 人话名或完整包 id
 * @returns {{ok:true, id:string} | {ok:false, message:string}}
 */
function resolveTransition(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return { ok: false, message: '转场 id 是空的。' };
  if (s === 'none' || s === 'null') return { ok: true, id: '' };
  if (s.indexOf('concat.') === 0) return { ok: true, id: s };
  const key = s.toLowerCase();
  if (TRANSITION_ALIASES[key]) return { ok: true, id: TRANSITION_ALIASES[key] };
  return {
    ok: false,
    message: '不认识的转场「' + s + '」。可用：' + TRANSITION_HINTS +
      '；也可以直接写 Concat 的包 id（形如 concat.xxx）。',
  };
}

module.exports = { resolveTransition, TRANSITION_ALIASES, TRANSITION_HINTS };
