'use strict';
/**
 * inspect.js —— action=inspect：读一个已存在的 Concat 工程，返回**结构化的文字描述**。
 *
 * 为什么返回文字而不是原样 JSON：调用方是模型和用户，不是程序。
 * `project_get` 的完整状态在小工程上就有十几 KB，直接吐出去既烧 token 也没信息量。
 * 需要机器可读时给 `structured` 参数（run.js 透传），默认给文字。
 *
 * 只读语义：打开工程 → 读时间线 → **不保存**关掉（save:false），所以 inspect 不会改动任何东西。
 */

const path = require('path');

const { openSession } = require('./mcp');
const { resolveAny, isDir, isFile } = require('./paths');
const { describeTimeline } = require('./timeline');
const { fmtSeconds } = require('./format');

/**
 * @param {object} params
 * @param {{project?:string, structured?:boolean}=} opts
 * @returns {Promise<string>}
 */
async function runInspect(params, opts) {
  const p = params && typeof params === 'object' ? params : {};
  const o = opts || {};
  const rawProject = String(p.project || o.project || '').trim();
  if (!rawProject) {
    return '错误：inspect 要一个工程目录。用 action=inspect + project="concat-video/我的片子"；\n' +
      '不记得路径就先 action=inspect 之前看上次 render 的返回里「工程目录」那一行。';
  }
  const projDir = resolveAny(rawProject);
  if (!isDir(projDir)) {
    return '错误：工程目录不存在：' + projDir;
  }
  if (!isFile(path.join(projDir, 'concat.json'))) {
    return '错误：这个目录里没有 Concat 工程（缺 concat.json）：' + projDir + '\n' +
      '工程是 render 建出来的那个文件夹，不是随便一个目录。';
  }

  const opened = await openSession();
  if (!opened.ok) return opened.message;
  const session = opened.session;
  let didOpen = false;
  try {
    const op = await session.call('project_open', { path: projDir });
    if (!op.ok) {
      return '错误：打不开工程「' + projDir + '」：' + op.message +
        '\n（如果 Concat 的窗口里正开着同一个工程，先把它关掉再试。）';
    }
    didOpen = true;
    const tl = await session.call('timeline_read', { path: projDir });
    if (!tl.ok) return '错误：读时间线失败：' + tl.message;
    const described = describeTimeline(tl.data, { maxClips: 60 });
    if (o.structured) {
      return JSON.stringify({
        ok: true,
        project: projDir,
        stats: described.stats,
        description: described.text,
        timeline: tl.data,
      }, null, 2);
    }
    const lines = [];
    lines.push('工程：' + projDir);
    lines.push('');
    lines.push(described.text);
    const st = described.stats || {};
    if (st.clips) {
      lines.push('');
      lines.push('一句话：' + st.clips + ' 个元素、' + st.tracks + ' 条泳道、总长 ' + fmtSeconds(st.duration) +
        '（列表顺序即层叠顺序，越靠后越在上层）。');
    }
    return lines.join('\n');
  } catch (e) {
    return '错误：读工程时出现了没预料到的问题：' + (e && e.message ? e.message : String(e));
  } finally {
    if (didOpen) {
      // 只读：不保存
      try {
        await session.call('project_close', { path: projDir, save: false });
      } catch {
        /* 收尾失败不覆盖主错误 */
      }
    }
    await session.close();
  }
}

module.exports = { runInspect };
