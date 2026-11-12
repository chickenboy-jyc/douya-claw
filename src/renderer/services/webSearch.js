/**
 * webSearch.js —— 「真实检索 + 让模型基于检索原文作答」的业务封装（有据可查）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 与 searchWeb()（api.js）的区别（这是本模块存在的全部理由）
 * ────────────────────────────────────────────────────────────────────────────
 * searchWeb() 走的是内网 LLM 网关的 enable_search，而该网关**静默忽略**这个参数
 * （详见 webSearchHealth.js 顶部注释）—— 于是模型只是凭训练记忆作答，
 * 下游却把结果标成「联网检索」。这是假标签。
 *
 * searchWebGrounded() 换了一条**真的会联网**的路：
 *   ① 先调 fetchWebSearch（主进程直连 tavily/bocha）拿到**真实网页结果**；
 *   ② 把检索原文按清晰格式**注入 prompt**；
 *   ③ 再让模型「严格基于这些资料」作答；
 *   ④ 返回 grounded 标记 —— results 非空才为 true，如实反映「到底有没有拿到外部资料」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 诚实红线（调用方必须遵守）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 检索失败 → 返回 { ok:false, grounded:false, error }，**绝不静默降级成纯模型调用**
 *     （降级与否由调用方决定，调用方需要知道真相才能诚实标注来源）；
 *   · 检索成功但确实无结果 → grounded:false，且不会让调用方误以为「联网了但没查到」文案可以放松；
 *   · grounded 只在 results.length > 0 时为 true。
 *
 * @typedef {{title:string, url:string, content:string, score?:number, publishedDate?:string, siteName?:string}} WebSearchResult
 * @typedef {{ok:boolean, content:string, results:WebSearchResult[], provider:string, grounded:boolean, error:string, elapsedMs:number}} GroundedResult
 */
import { chatOnce, fetchWebSearch } from '../api.js';

/** question 过长时截断出的检索词长度（避免把整段长文丢给搜索 API）。 */
const QUERY_HEAD = 200;

/**
 * 抽检索词：优先用显式 opts.query；否则用 question（过长则截断到 QUERY_HEAD 字）。
 * @param {string} question
 * @param {string} [explicit] 调用方显式传入的检索词
 * @returns {string}
 */
export function deriveQuery(question, explicit) {
  const e = typeof explicit === 'string' ? explicit.trim() : '';
  if (e) return e;
  const q = typeof question === 'string' ? question.trim() : '';
  return q.length > QUERY_HEAD ? q.slice(0, QUERY_HEAD) : q;
}

/**
 * 把检索原文组装成「有据可查」的 prompt。
 *
 * 格式（固定，便于模型稳定遵循，也便于测试断言注入内容）：
 *   【以下是通过搜索引擎实检到的网页资料，请严格基于这些资料作答】
 *   [1] 标题
 *   URL: ...
 *   摘要: ...
 *   [2] ...
 *   【要求】只依据上述资料作答；资料不足以回答的部分，明确写「检索到的资料未覆盖」。
 *   问题：<question>
 *
 * @param {string} question 原始问题（注入 prompt 末尾，让模型回答它）
 * @param {WebSearchResult[]} results 检索原文
 * @returns {string}
 */
export function buildGroundedPrompt(question, results) {
  const list = Array.isArray(results) ? results : [];
  const lines = ['【以下是通过搜索引擎实检到的网页资料，请严格基于这些资料作答】'];
  list.forEach((r, i) => {
    const title = String((r && r.title) || '').trim() || '(无标题)';
    const url = String((r && r.url) || '').trim();
    const content = String((r && r.content) || '').trim();
    lines.push(`[${i + 1}] ${title}`);
    if (url) lines.push(`URL: ${url}`);
    lines.push(`摘要: ${content || '(无摘要)'}`);
    lines.push('');
  });
  lines.push('【要求】只依据上述资料作答；资料不足以回答的部分，明确写「检索到的资料未覆盖」。');
  lines.push('回答时如需引用，请在句末用 [序号] 标注来源（例如 [1]）。');
  lines.push('');
  lines.push('问题：' + String(question == null ? '' : question));
  return lines.join('\n');
}

/**
 * 真实检索 + 让模型基于检索结果作答（有据可查）。
 *
 * @param {string} question 要回答的问题
 * @param {object} [opts]
 * @param {object} [opts.context]    传给 chatOnce 的上下文（企业画像等）
 * @param {number} [opts.temperature] 生成温度（默认 0.2，偏事实）
 * @param {number} [opts.count]      检索条数
 * @param {string|number} [opts.freshness] 时效
 * @param {number} [opts.timeoutMs]  检索超时
 * @param {string} [opts.query]      显式指定检索词（默认从 question 抽取）
 * @param {Function} [opts.fetchFn]  可注入的检索实现（默认 fetchWebSearch；单测注入假实现）
 * @param {Function} [opts.chatFn]   可注入的模型补全实现（默认 chatOnce；单测注入假实现）
 * @returns {Promise<GroundedResult>}
 */
export async function searchWebGrounded(question, opts = {}) {
  const q = typeof question === 'string' ? question.trim() : '';
  const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : fetchWebSearch;
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;

  if (!q) {
    return { ok: false, content: '', results: [], provider: 'none', grounded: false, error: '问题为空', elapsedMs: 0 };
  }

  const query = deriveQuery(q, opts.query);

  // ---- 1) 真实检索 ----
  let searchRes;
  try {
    searchRes = await fetchFn(query, {
      count: opts.count,
      freshness: opts.freshness,
      timeoutMs: opts.timeoutMs,
    });
  } catch (e) {
    return {
      ok: false,
      content: '',
      results: [],
      provider: 'none',
      grounded: false,
      error: '联网检索失败：' + ((e && e.message) || String(e)),
      elapsedMs: 0,
    };
  }

  const results = Array.isArray(searchRes && searchRes.results) ? searchRes.results : [];
  const provider = (searchRes && searchRes.provider) || 'none';
  const elapsedMs = typeof (searchRes && searchRes.elapsedMs) === 'number' ? searchRes.elapsedMs : 0;

  // ---- 2) 检索失败（ok !== true）→ 不静默降级，直接如实返回失败 ----
  if (!searchRes || searchRes.ok !== true) {
    return {
      ok: false,
      content: '',
      results: [],
      provider,
      grounded: false,
      error: (searchRes && searchRes.error) || '联网检索失败',
      elapsedMs,
    };
  }

  // ---- 3) 检索成功但确实无结果 → grounded:false（不调模型，避免让调用方误以为拿到了资料）----
  if (results.length === 0) {
    return { ok: true, content: '', results: [], provider, grounded: false, error: '', elapsedMs };
  }

  // ---- 4) 有真实结果 → 注入 prompt，让模型基于资料作答 ----
  const prompt = buildGroundedPrompt(q, results);
  let ai;
  try {
    ai = await chatFn(
      [{ role: 'user', content: prompt }],
      opts.context && typeof opts.context === 'object' ? opts.context : null,
      {
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
        reasoningEffort: 'none',
      }
    );
  } catch (e) {
    return {
      ok: false,
      content: '',
      results,
      provider,
      grounded: true,
      error: '生成失败：' + ((e && e.message) || String(e)),
      elapsedMs,
    };
  }

  if (!ai || ai.ok !== true || typeof ai.content !== 'string' || !ai.content.trim()) {
    return {
      ok: false,
      content: '',
      results,
      provider,
      grounded: true,
      error: (ai && ai.error) || '模型未返回内容',
      elapsedMs,
    };
  }

  return { ok: true, content: ai.content.trim(), results, provider, grounded: true, error: '', elapsedMs };
}

export default { searchWebGrounded, buildGroundedPrompt, deriveQuery };
