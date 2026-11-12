'use strict';
/**
 * format.js —— 只放"把数字/字节翻译成中文人话"的小函数。
 * 单独成文件的原因：render / inspect / frame 三处都要用，重复实现会让三处读数口径不一致
 * （本仓有过同类前科：同一个"python 是谁"养了三套实现）。
 */

/** 秒 → "3 秒" / "2.4 秒"（去掉无意义的 .0） */
function fmtSeconds(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '未知时长';
  const r = Math.round(v * 100) / 100;
  return (Number.isInteger(r) ? String(r) : String(r)) + ' 秒';
}

/** 字节 → "176.5 KB" */
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '大小未知';
  if (v < 1024) return v + ' 字节';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 错误对象 → 一行文字（绝不再抛） */
function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  try { return JSON.stringify(e); } catch { return String(e); }
}

/**
 * stderr 尾部裁剪：只留最后几行，每行最多 240 字。
 * 为什么必须裁：Concat 的日志能一次刷几十行，原样塞进技能返回会淹没真正的错误。
 */
function tailText(lines, maxLines, maxChars) {
  const arr = Array.isArray(lines) ? lines.slice(-(maxLines || 6)) : [];
  const out = [];
  for (const l of arr) {
    const s = String(l == null ? '' : l).trim();
    if (!s) continue;
    out.push(s.length > (maxChars || 240) ? s.slice(0, maxChars || 240) + '…' : s);
  }
  return out.join(' | ');
}

module.exports = { fmtSeconds, fmtBytes, errText, tailText };
