'use strict';
/**
 * paths.js —— 工作区路径的唯一口径。
 *
 * 约定（与 skills/file-write、skills/package-app 一致）：
 *   工作区 = process.env.AGENT_WORKSPACE || ~/douya-claw-workspace
 *   相对路径一律按工作区解析；绝对路径原样保留（用户可能指到自己的素材目录）。
 *
 * Concat 侧的硬约束：它只允许写到 `concat_version` 报的 writesUnder 之下
 * （本机实测 = \\?\C:\Users\<用户>），工作区正好在里面。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE = (process.env.AGENT_WORKSPACE && String(process.env.AGENT_WORKSPACE).trim())
  || path.join(os.homedir(), 'douya-claw-workspace');

/** @returns {string} 工作区绝对路径 */
function workspace() {
  return WORKSPACE;
}

/** @param {string} p @returns {boolean} */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p @returns {boolean} */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 任意路径 → 绝对路径（相对路径按工作区解析）。
 * @param {string} p
 * @returns {string}
 */
function resolveAny(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  if (path.isAbsolute(s)) return path.normalize(s);
  return path.resolve(WORKSPACE, s);
}

/**
 * 确保目录存在（递归）。失败会抛，由调用方翻译成可读错误。
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 时间戳，用于默认工程名/默认产物名：20261107-153012 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/**
 * 把用户给的名字变成能当文件夹名的 slug。
 *
 * 保留中文（本机是中文 Windows，产物名带中文是常态，实测 Concat 完全吃得下），
 * 只清掉 Windows 不允许的字符与首尾空白/点号（结尾的点在 Windows 上会被静默吞掉，
 * 导致"建的目录"和"以为建的目录"不一致）。
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function safeSlug(name, fallback) {
  let s = String(name == null ? '' : name);
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[.\s]+$/, '');
  if (s.length > 48) s = s.slice(0, 48).trim();
  if (!s) return String(fallback || ('concat-' + stamp()));
  return s;
}

/**
 * 在 parent 下取一个**不存在**的目录名（绝不删除既有内容）。
 * @param {string} parent
 * @param {string} slug
 * @returns {string} 绝对路径
 */
function uniqueDir(parent, slug) {
  const base = String(slug || 'concat');
  for (let i = 1; i <= 50; i += 1) {
    const name = i === 1 ? base : base + '-' + i;
    const cand = path.join(parent, name);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(parent, base + '-' + stamp());
}

module.exports = {
  workspace,
  isFile,
  isDir,
  resolveAny,
  ensureDir,
  stamp,
  safeSlug,
  uniqueDir,
};
