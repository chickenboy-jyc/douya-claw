'use strict';
/**
 * browser-verify —— 「真实浏览器验收」技能入口。
 *
 * 解决的问题：deploy-static / deploy-node 目前的"验证"只是 curl 看 HTTP 状态码，
 * **站点返回 200 不等于用户能用**（可能白屏、按钮点了没反应、控制台一堆报错）。
 * 本技能改成真的用浏览器打开、点一遍、填一遍、截图、收集控制台报错与失败请求，
 * 最后给出结构化 PASS/FAIL 结论。
 *
 * 运行形态：本项目 JS 技能由主进程 `require()` 后在 **Electron 主进程内**执行
 * （见 src/main/skills.js:43-53, 141-152），因此这里用到的只有 Node 标准库 +
 * child_process 拉起系统浏览器，**不新增任何依赖、不下载任何浏览器**。
 *
 * 返回：**结构化 JSON 字符串**。硬失败（参数非法 / 浏览器不可用 / 执行崩溃）时，
 * 会在 JSON 前面加一行 `错误：…`，与本项目「错误串」约定一致，保证上游/用户一眼能看出
 * 这**不是**一次成功。
 *
 * 诚实红线：浏览器起不来 ⇒ `verified:false` + `ok:false` + `错误：` 前缀；
 * 绝不允许把"没验证成"写成"通过"，也绝不把 HTTP 200 当成通过依据。
 */

const { validateUrl } = require('./lib/urls');
const { normalizeParams } = require('./lib/params');
const { runVerification } = require('./lib/verify');
const { buildReport, hardFailReport } = require('./lib/verdict');

/**
 * 可注入依赖版本（单测用；生产走默认依赖）。
 * @param {object} params 原始 params
 * @param {object} [deps] 依赖覆盖
 * @returns {Promise<string>}
 */
async function runWithDeps(params, deps) {
  const raw = params && typeof params === 'object' ? params : {};

  // ① 目标地址校验（安全红线：只允许 http/https）
  const v = validateUrl(raw.url);
  if (!v.ok) {
    const rep = hardFailReport({ url: String(raw.url == null ? '' : raw.url), reason: 'invalid_url', detail: v.reason });
    return '错误：' + v.reason + '\n' + JSON.stringify(rep, null, 2);
  }

  // ② 其余参数归一化（actions / 布尔 / 超时；类型全部强转 —— 参数在渲染层被声明为 string）
  const norm = normalizeParams(raw);
  if (!norm.ok) {
    const rep = hardFailReport({ url: v.url, reason: 'invalid_params', detail: norm.reason });
    return '错误：' + norm.reason + '\n' + JSON.stringify(rep, null, 2);
  }

  // ③ 执行（verify 内部已保证不抛异常；这里再兜一层，防止依赖注入实现抛错）
  let evidence;
  try {
    evidence = await runVerification(norm, deps);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const rep = hardFailReport({ url: v.url, reason: 'verify_crashed', detail: '浏览器验证执行失败：' + msg });
    return '错误：浏览器验证执行失败：' + msg + '\n' + JSON.stringify(rep, null, 2);
  }

  const report = buildReport(evidence, { url: v.url, target: v });

  if (!report.verified) {
    // ④ 根本没检查成 —— 必须显式报错，绝不静默降级成"通过"
    return '错误：' + report.error + '\n' + JSON.stringify(report, null, 2);
  }

  return JSON.stringify(report, null, 2);
}

/**
 * 技能入口（本项目约定：run.js 导出 async run(params, ctx)）。
 * @param {object} params
 * @param {object} [_ctx] 技能上下文（本技能不需要）
 * @returns {Promise<string>}
 */
async function run(params, _ctx) {
  return runWithDeps(params, undefined);
}

module.exports = { run, runWithDeps };
