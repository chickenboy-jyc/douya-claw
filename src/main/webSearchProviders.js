/**
 * webSearchProviders.js —— 主进程「真实联网检索」的 provider 实现（纯 Node，可单测）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么要这个模块（背景）
 * ────────────────────────────────────────────────────────────────────────────
 * 产品里的 searchWeb() 走的是内网 LLM 网关的 enable_search 参数，但该网关
 * **静默忽略**这个参数（详见 src/renderer/services/webSearchHealth.js 顶部注释）——
 * 也就是说，那条链路「从来没真的上过网」。结果是经营诊断 11 维 / 竞品分析 / GEO 曝光
 * 把模型凭训练记忆的推断标成「来源：联网检索」，是假标签。
 *
 * 本模块提供**真·检索**：直连第三方搜索 API（Tavily / 博查），拿到真实网页结果，
 * 交给上层（webSearch.js 的 searchWebGrounded）注入 prompt，让模型「有据可查」地作答。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * provider 链式降级（顺序固定）
 * ────────────────────────────────────────────────────────────────────────────
 *   1) 配了 tavilyApiKey         → tavily-key      （Authorization: Bearer <key>）
 *   2) 否则 / 或 tavily 无果      → tavily-keyless  （X-Tavily-Access-Mode: keyless，免 key）
 *   3) tavily 失败或确实无结果，
 *      且配了 bochaApiKey        → bocha           （国内可直连，需 key）
 * 每次返回都记录**实际生效的 provider**，供来源文案使用。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 红线（本模块严格遵守）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 不引入任何第三方 npm 依赖，只用 Node 内置 fetch / AbortController；
 *   · apiKey **只在主进程**使用，绝不写进返回值（返回值里不含任何 key 字段）；
 *   · 严格区分「失败」与「确实没搜到」：
 *       网络错 / HTTP 非 2xx / 解析失败  → ok:false + error；
 *       HTTP 200 但结果为空数组          → ok:true, results:[]（这是"真没查到"，不是失败）；
 *   · 超时用「AbortController 取消 + Promise.race 兜底」双保险，保证即使注入的
 *     fetch 不理会 signal 也不会挂起。
 *
 * 为什么单独成模块（而不是全写在 backend.js 里）：backend.js 顶部 require 了
 * skills/connectors/experts/stt 等重依赖（部分触及 electron），在纯 node 单测里没法直接
 * require。provider 逻辑抽到这里后，可用 createRequire 直接加载并注入假 fetch 做单测，
 * 与 backend.js 现有的 handleXxx 路由风格并存（路由仍在 backend.js 注册，不另起一套）。
 */

/**
 * @typedef {Object} WebSearchResult
 * @property {string} title         标题
 * @property {string} url           原文链接
 * @property {string} content       摘要/正文片段
 * @property {number|undefined} score   相关性分数（provider 提供时）
 * @property {string} publishedDate 发布时间（provider 提供时，可能为空串）
 * @property {string} siteName      站点名（provider 提供时；tavily 无此字段则从域名推断）
 */

/**
 * @typedef {Object} WebSearchOutcome
 * @property {boolean} ok
 * @property {string} provider      实际生效（或最后尝试）的 provider 名
 * @property {number} elapsedMs
 * @property {WebSearchResult[]} results
 * @property {string} error         失败原因（ok:true 时为 ''）
 */

/** 默认检索条数。 */
const DEFAULT_COUNT = 5;
/** 条数上限（防滥用 / 防把 prompt 撑爆）。 */
const MAX_COUNT = 20;
/** 查询词长度上限。 */
const MAX_QUERY_LEN = 500;
/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 12000;

/** Tavily 检索端点。 */
const TAVILY_URL = 'https://api.tavily.com/search';
/** 博查检索端点（国内）。 */
const BOCHA_URL = 'https://api.bochaai.com/v1/web-search';

/**
 * 清洗查询词：非字符串 → ''；去控制字符 → 压空白 → 截断到上限。
 * @param {unknown} raw
 * @returns {string} 合法查询词；不合法时为空串
 */
function sanitizeSearchQuery(raw) {
  if (typeof raw !== 'string') return '';
  // 去掉 C0/C1 控制字符与 DEL（含 \n \t \r 等），统一换成空格后再压空白
  let s = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_QUERY_LEN) s = s.slice(0, MAX_QUERY_LEN);
  return s;
}

/**
 * 归一化条数：非法 / <=0 → 默认 5；否则夹在 [1, 20]。
 * @param {unknown} n
 * @returns {number}
 */
function normalizeCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, Math.floor(v)));
}

/**
 * 归一化超时：非法 / <=0 → 默认 12000。
 * @param {unknown} ms
 * @returns {number}
 */
function normalizeTimeout(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(v);
}

/**
 * 从 URL 推断站点名（去掉 www. 前缀）。tavily 不返回站点名时兜底。
 * @param {string} url
 * @returns {string}
 */
function siteFromUrl(url) {
  try {
    const h = new URL(String(url || '')).hostname.replace(/^www\./i, '');
    return h || '';
  } catch {
    return '';
  }
}

/**
 * 带超时的 fetch：AbortController 负责真正中断网络，Promise.race 负责兜底
 * （即使注入的 fetch 实现不理会 signal，也不会把调用方挂死）。
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {object} opts
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(fetchImpl, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const req = Promise.resolve().then(() => fetchImpl(url, { ...opts, signal: ctrl.signal }));
  // 超时先返回时，真正的 fetch 之后可能仍以 AbortError 拒绝 → 提前吞掉，避免 unhandledRejection
  req.catch(() => {});
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try { ctrl.abort(); } catch { /* 注入实现可能无 abort */ }
      reject(new Error('检索超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
  return Promise.race([req, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Tavily 检索。
 * @param {object} p
 * @param {string} p.query
 * @param {number} p.count
 * @param {string} [p.freshness] 天数（正整数）时映射为 Tavily 的 days
 * @param {string} p.apiKey 有 key → key 模式；空 → keyless 模式
 * @param {Function} p.fetchImpl
 * @param {number} p.timeoutMs
 * @returns {Promise<WebSearchResult[]>} 成功返回结果数组（可为空）；失败抛异常
 */
async function searchTavily({ query, count, freshness, apiKey, fetchImpl, timeoutMs }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  else headers['X-Tavily-Access-Mode'] = 'keyless';
  const body = { query, max_results: count };
  const days = Number(freshness);
  if (Number.isFinite(days) && days > 0) body.days = Math.floor(days);
  const res = await fetchWithTimeout(fetchImpl, TAVILY_URL, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  if (!res || !res.ok) {
    throw new Error('tavily HTTP ' + (res ? res.status : '无响应'));
  }
  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error('tavily 返回解析失败');
  }
  const list = j && Array.isArray(j.results) ? j.results : [];
  return list.map((r) => ({
    title: String((r && r.title) || '').trim(),
    url: String((r && r.url) || '').trim(),
    content: String((r && r.content) || '').trim(),
    score: typeof (r && r.score) === 'number' ? r.score : undefined,
    publishedDate: String((r && r.published_date) || '').trim(),
    siteName: siteFromUrl(r && r.url),
  })).filter((r) => r.url || r.title || r.content);
}

/**
 * 博查 AI 检索（国内，需 key）。
 * @param {object} p
 * @param {string} p.query
 * @param {number} p.count
 * @param {string} [p.freshness] 透传给博查（noLimit/oneDay/oneWeek/oneMonth/oneYear）
 * @param {string} p.apiKey
 * @param {Function} p.fetchImpl
 * @param {number} p.timeoutMs
 * @returns {Promise<WebSearchResult[]>} 成功返回结果数组（可为空）；失败抛异常
 */
async function searchBocha({ query, count, freshness, apiKey, fetchImpl, timeoutMs }) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
  const body = {
    query,
    count,
    summary: true,
    freshness: typeof freshness === 'string' && freshness.trim() ? freshness.trim() : 'noLimit',
  };
  const res = await fetchWithTimeout(fetchImpl, BOCHA_URL, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  if (!res || !res.ok) {
    throw new Error('bocha HTTP ' + (res ? res.status : '无响应'));
  }
  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error('bocha 返回解析失败');
  }
  const pages = j && j.data && j.data.webPages && Array.isArray(j.data.webPages.value) ? j.data.webPages.value : [];
  return pages.map((r) => ({
    title: String((r && r.name) || '').trim(),
    url: String((r && r.url) || '').trim(),
    content: String((r && (r.summary || r.snippet)) || '').trim(),
    score: typeof (r && r.score) === 'number' ? r.score : undefined,
    publishedDate: String((r && r.datePublished) || '').trim(),
    siteName: String((r && r.siteName) || '').trim() || siteFromUrl(r && r.url),
  })).filter((r) => r.url || r.title || r.content);
}

/**
 * 跑一次真实联网检索（provider 链式降级）。
 *
 * @param {object} p
 * @param {string} p.query            查询词（会做清洗校验）
 * @param {number} [p.count]          条数，默认 5，上限 20
 * @param {string|number} [p.freshness] 时效（tavily 用天数；bocha 用枚举字符串）
 * @param {number} [p.timeoutMs]      单次请求超时，默认 12000
 * @param {string} [p.tavilyApiKey]   配了走 tavily-key，否则 tavily-keyless
 * @param {string} [p.bochaApiKey]    配了才作为降级 provider
 * @param {Function} [p.fetchImpl]    可注入的 fetch（默认全局 fetch；单测注入假实现）
 * @returns {Promise<WebSearchOutcome>}
 */
async function runWebSearch({
  query,
  count,
  freshness,
  timeoutMs,
  tavilyApiKey = '',
  bochaApiKey = '',
  fetchImpl,
} = {}) {
  const t0 = Date.now();
  const q = sanitizeSearchQuery(query);
  const n = normalizeCount(count);
  const ms = normalizeTimeout(timeoutMs);
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;

  if (!q) {
    return { ok: false, provider: 'none', elapsedMs: 0, results: [], error: '检索关键词无效（必须是非空字符串）' };
  }

  const tavilyProvider = tavilyApiKey ? 'tavily-key' : 'tavily-keyless';
  const errors = [];
  let lastProvider = tavilyProvider;

  // ---- 1) tavily（key 或 keyless）----
  try {
    const results = await searchTavily({
      query: q,
      count: n,
      freshness,
      apiKey: tavilyApiKey || '',
      fetchImpl: doFetch,
      timeoutMs: ms,
    });
    if (results.length > 0) {
      return { ok: true, provider: tavilyProvider, elapsedMs: Date.now() - t0, results, error: '' };
    }
    // HTTP 200 但确实无结果：不是失败。若配了 bocha 再试一次，否则如实返回空结果。
    if (!bochaApiKey) {
      return { ok: true, provider: tavilyProvider, elapsedMs: Date.now() - t0, results: [], error: '' };
    }
    errors.push(tavilyProvider + '：检索无结果');
  } catch (e) {
    errors.push(tavilyProvider + '：' + ((e && e.message) || String(e)));
  }

  // ---- 2) bocha 降级（仅当配了 key）----
  if (bochaApiKey) {
    lastProvider = 'bocha';
    try {
      const results = await searchBocha({
        query: q,
        count: n,
        freshness,
        apiKey: bochaApiKey,
        fetchImpl: doFetch,
        timeoutMs: ms,
      });
      return { ok: true, provider: 'bocha', elapsedMs: Date.now() - t0, results, error: '' };
    } catch (e) {
      errors.push('bocha：' + ((e && e.message) || String(e)));
    }
  }

  // ---- 3) 全部失败 ----
  return {
    ok: false,
    provider: lastProvider,
    elapsedMs: Date.now() - t0,
    results: [],
    error: errors.length ? errors.join('；') : '所有检索 provider 均不可用',
  };
}

/**
 * 生成「检索 provider 就绪情况」日志文案（**绝不含 key 本身**，只说已配置/未配置）。
 * @param {{tavilyApiKey?:string, bochaApiKey?:string}} cfg
 * @returns {string}
 */
function describeProviders(cfg = {}) {
  const tavily = cfg.tavilyApiKey ? '已配置(key)' : 'keyless(免key)';
  const bocha = cfg.bochaApiKey ? '已配置(key)' : '未配置';
  return '联网检索 provider: tavily=' + tavily + '，bocha=' + bocha;
}

module.exports = {
  sanitizeSearchQuery,
  normalizeCount,
  normalizeTimeout,
  searchTavily,
  searchBocha,
  runWebSearch,
  describeProviders,
  // 常量导出（供单测断言上限等）
  DEFAULT_COUNT,
  MAX_COUNT,
  MAX_QUERY_LEN,
  DEFAULT_TIMEOUT_MS,
  TAVILY_URL,
  BOCHA_URL,
};
