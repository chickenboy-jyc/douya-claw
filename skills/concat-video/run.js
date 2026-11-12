'use strict';
/**
 * skills/concat-video/run.js —— 技能入口（本项目约定：run.js 导出 async run(params, ctx)）。
 *
 * ── 这个技能为什么不把 Concat 的 45 个工具全暴露给模型 ────────────────────
 * 实测：豆芽现有 47 个技能的 schema 已经吃掉约 11,900 token/轮，
 * 而模型在 149 次调用里只用到 11 个技能。再往里塞 45 个 MCP 工具只会让"选错工具"变多。
 * 所以对外只有 4 个高层 action，内部由本技能编排十几次 MCP 调用：
 *
 *   probe    本机有没有 Concat、什么版本、什么模式（没装时给下载/安装引导，不崩）
 *   render   吃一份「剪辑单」JSON：建工程 → 导素材 → 多泳道铺片段（含切片头/长度/位移/淡入淡出/
 *            转场/关键帧）→ 标题 → 字幕 → 导出 mp4 → 抽一帧自检
 *   inspect  读已有工程的时间线，返回**人话**（不是原始 JSON）
 *   frame    在指定时间点抽一帧，存 PNG 返回**绝对路径**
 *
 * ── 返回约定（与仓库其它技能一致）──────────────────────────────────────
 *   正常：一段中文文本，里面带**绝对路径**（后端会正则扒路径做成果卡，见 backend.js extractPaths）。
 *   失败：以「错误：」开头的一段中文，说清卡在哪一步、下一步怎么办。**绝不抛异常**给宿主。
 *
 * ── 进程回收 ──────────────────────────────────────────────────────────
 *   每个 action 内部都用 try/finally 关掉 MCP 会话（关 stdin → SIGTERM → SIGKILL），
 *   否则会把 concat.exe 留成孤儿进程（门禁 scripts/smoke/unit-concat-skill.mjs 会查残留）。
 */

const { formatProbe, probeConcat } = require('./lib/probe');
const { runRender } = require('./lib/render');
const { runInspect } = require('./lib/inspect');
const { runFrame } = require('./lib/frame');

const ACTIONS = ['probe', 'render', 'inspect', 'frame'];

/** 留给收尾（保存/关工程/关进程）的时间，从宿主给的 timeoutMs 里预留出来 */
const RESERVE_MS = 25000;

/**
 * 本次调用还剩多少时间可用。
 *
 * ctx.timeoutMs 由 src/main/skills.js 按 manifest.timeoutMs 注入（本技能 600000）。
 * 纯 node 里跑单测时没有 ctx，就退回 540000（9 分钟）—— 仍然比默认 60 秒宽松得多，
 * 因为导出 4K 几分钟是常态。
 *
 * @param {object|undefined} ctx
 * @returns {number} 绝对时间戳（ms）
 */
function computeDeadline(ctx) {
  const now = Date.now();
  const budget = ctx && Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : 540000;
  return now + Math.max(60000, budget - RESERVE_MS);
}

/**
 * 技能入口。
 * @param {object} params 参数（渲染层声明为 string，这里一律自己强转）
 * @param {object=} ctx 技能上下文（本技能只用 timeoutMs）
 * @returns {Promise<string>}
 */
async function run(params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  const rawAction = p.action === undefined || p.action === null ? '' : String(p.action).trim().toLowerCase();
  const deadline = computeDeadline(ctx);

  if (!rawAction) {
    return '错误：缺少 action。\n' +
      '· 想知道本机装没装 Concat：action="probe"\n' +
      '· 要出一段片子：action="render" + plan="<剪辑单 JSON>"\n' +
      '· 要看已有工程的时间线：action="inspect" + project="<工程目录>"\n' +
      '· 要抽一帧看画面：action="frame" + project="<工程目录>" + time=1.5';
  }
  if (ACTIONS.indexOf(rawAction) < 0) {
    return '错误：action 只能是 probe / render / inspect / frame 之一（收到「' + rawAction + '」）。\n' +
      '· probe=查装没装 · render=按剪辑单出片 · inspect=读时间线 · frame=抽一帧';
  }

  try {
    if (rawAction === 'probe') {
      // probe 只用一次握手，不需要长时限
      const r = await probeConcat();
      return formatProbe(r);
    }
    if (rawAction === 'render') {
      return await runRender(p, { deadline });
    }
    if (rawAction === 'inspect') {
      return await runInspect(p, { deadline, project: p.project, structured: false });
    }
    return await runFrame(p, { deadline });
  } catch (e) {
    // 最外层兜底：任何没预料到的异常都要变成可读文本，绝不让宿主看到裸栈
    const msg = e && e.message ? String(e.message) : String(e);
    const code = e && e.code ? '（code=' + String(e.code) + '）' : '';
    return '错误：视频精剪技能内部出错了' + code + '：' + msg + '\n' +
      '这不是"素材/参数"的问题，是技能自己的缺陷，请把这句话报给开发者。';
  }
}

module.exports = { run, computeDeadline, ACTIONS, RESERVE_MS };
