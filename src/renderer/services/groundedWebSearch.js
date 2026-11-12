/**
 * groundedWebSearch.js —— 「真检索 + 基于实检资料作答」在各调用点的统一薄封装。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要它（T16 背景）
 * ────────────────────────────────────────────────────────────────────────────
 * 产品里原先多处「要联网」的功能（首登企业识别、企业大脑重学、竞品分析、知识 AI 资讯、
 * 联网找候选、GEO 曝光）都走 `searchWeb()`（api.js）→ 内网 LLM 网关的 `enable_search`。
 * 而该网关**静默忽略** enable_search（详见 webSearchHealth.js 顶部注释）—— 即「根本没上网」，
 * 下游却把结果标成「联网检索」。
 *
 * 现成的真检索件是 `webSearchGrounded()`（webSearch.js）：先 fetchWebSearch 拿真网页 → 注入 prompt
 * → 让模型基于资料作答 → 返回 grounded 标记。本模块**不新造检索机制**，只是把它的三件套
 * （① 显式构造精炼 query 避免长 prompt 被截断成 200 字检索词；② 调用；③ 由**本次检索的直接证据**
 * 生成诚实来源文案）收敛成可复用、可注入（单测传假 fetchFn/chatFn）、可反向控制的几个函数，
 * 供各调用点复用，避免每处各写各的、又各漏一处。
 *
 * 诚实红线（与 webSearchGrounded / describeSource 完全一致，绝不放松）：
 *   · 检索失败（ok:false）→ 调用方必须如实报错或显式降级，且降级来源标「未联网」；
 *   · 检索成功但 0 条     → 视为**没拿到资料**（不是「联网了但没查到」的宽松文案）；
 *   · 只有真拿到 ≥1 条    → 才允许来源出现「联网检索（X 实检 N 条）」。
 *
 * @typedef {{ok:boolean, content:string, data:object|Array|null, grounded:boolean, provider:string,
 *            results:Array, source:string, error:string, elapsedMs:number, raw:object}} GroundedSearch
 */
import { searchWebGrounded } from './webSearch.js';
import { extractJSON } from './projectAI.js';
import { describeSource, describeSourceWithCount, SOURCE_KINDS } from './webSearchHealth.js';

/** 去空白字符串（非字符串一律）。 */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 由「一次真检索的返回」推出用于来源标注的 health（**直接证据**，比再跑一次探针更准）。
 *
 * @param {object} res webSearchGrounded 的返回（含 ok / results / provider）
 * @returns {{available:boolean|null, webApi:boolean, provider:string, probeCount:number}}
 */
export function groundedHealth(res) {
  const results = Array.isArray(res && res.results) ? res.results : [];
  const provider = (res && res.provider) || 'none';
  if (results.length > 0) {
    return { available: true, webApi: true, provider, probeCount: results.length };
  }
  // 端点可达但 0 条 → 未确证拿到外部资料（available:null，绝不当 true）。
  if (res && res.ok === true) {
    return { available: null, webApi: false, provider, probeCount: 0 };
  }
  // 检索失败 → 已确证未联网。
  return { available: false, webApi: false, provider, probeCount: 0 };
}

/**
 * 由「一次真检索的返回」生成诚实来源文案。
 * 拿到资料 → 「联网检索（X 实检 N 条）」；失败 → 「未联网 · 模型推断」；未确证 → 「模型分析（联网状态未确认）」。
 * @param {object} res webSearchGrounded 的返回
 * @param {string} [kind] SOURCE_KINDS（默认 WEB）
 * @returns {string}
 */
export function groundedSource(res, kind = SOURCE_KINDS.WEB) {
  const h = groundedHealth(res);
  const n = h.available === true ? h.probeCount : 0;
  return describeSourceWithCount(kind, h, n);
}

/**
 * 真检索核心：调 webSearchGrounded → 归一返回结构（含解析出的 JSON data 与诚实 source）。
 *
 * 永不抛：webSearchGrounded 自身已 try/catch；此处再兜一层，异常一律成 ok:false。
 *
 * @param {string} question 要回答的问题（会被注入到 grounded prompt 末尾）
 * @param {object} [opts] { query, context, temperature, count, freshness, timeoutMs, fetchFn, chatFn }
 * @returns {Promise<GroundedSearch>}
 */
export async function groundedSearch(question, opts = {}) {
  let res;
  try {
    res = await searchWebGrounded(question, opts);
  } catch (e) {
    res = {
      ok: false, content: '', results: [], provider: 'none', grounded: false,
      error: '联网检索异常：' + ((e && e.message) || String(e)), elapsedMs: 0,
    };
  }
  const content = res && res.ok === true && typeof res.content === 'string' ? res.content : '';
  const data = content ? extractJSON(content) : null;
  return {
    ok: !!(res && res.ok === true && content),
    content,
    data,
    grounded: !!(res && res.grounded === true),
    provider: (res && res.provider) || 'none',
    results: Array.isArray(res && res.results) ? res.results : [],
    source: groundedSource(res, SOURCE_KINDS.WEB),
    error: (res && res.error) || '',
    elapsedMs: (res && typeof res.elapsedMs === 'number') ? res.elapsedMs : 0,
    raw: res || null,
  };
}

// ==================== 调用点 3/2：企业公开信息（Onboarding Step4 / 企业大脑「重新了解企业」） ====================

/**
 * 构造「企业公开信息」检索词（公司名 + 行业 + 关键属性词，精炼避免被截断）。
 * @param {{companyName?:string, industry?:string}} input
 * @returns {string}
 */
export function buildCompanyIntroQuery(input = {}) {
  const name = str(input.companyName);
  const industry = str(input.industry);
  return [name, industry, '公司 主营业务 产品 定位 公开信息'].filter(Boolean).join(' ');
}

/**
 * 真检索「某企业的公开信息」，让模型用 3-6 句话概括（基于实检资料，资料少就诚实说明）。
 *
 * @param {{companyName?:string, industry?:string, question?:string}} input
 * @param {object} [opts] { query, temperature, fetchFn, chatFn }
 * @returns {Promise<{ok:boolean, text:string, source:string, grounded:boolean, provider:string, results:Array, error:string, elapsedMs:number}>}
 */
export async function searchCompanyIntro(input = {}, opts = {}) {
  const name = str(input.companyName);
  const question = str(input.question) || (
    `请结合检索到的公开资料，用 3-6 句话说明「${name}」：这是一家什么公司、主营业务/产品、目标客户、核心卖点、在行业中的定位与差异化。` +
    '只依据上述资料作答；公开信息很少就诚实说明「公开信息较少」，不要编造。'
  );
  const query = str(opts.query) || buildCompanyIntroQuery(input);
  const r = await groundedSearch(question, {
    ...opts,
    query,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
  });
  return {
    ok: r.ok,
    text: r.content,
    source: r.source,
    grounded: r.grounded,
    provider: r.provider,
    results: r.results,
    error: r.error,
    elapsedMs: r.elapsedMs,
  };
}

// ==================== 调用点 1：首登「品牌归属」判断 ====================

/**
 * 构造「品牌归属」检索词。
 * @param {{companyName?:string}} input
 * @returns {string}
 */
export function buildBrandAttributionQuery(input = {}) {
  const name = str(input.companyName);
  return [name, '品牌 母公司 集团 公司主体 归属'].filter(Boolean).join(' ');
}

/**
 * 品牌归属判断的问题（要求模型只返回 JSON）。
 * @param {{companyName?:string, descBits?:string}} input
 * @returns {string}
 */
export function buildBrandAttributionQuestion(input = {}) {
  const name = str(input.companyName) || '这家企业';
  const descBits = str(input.descBits);
  return (
    `请依据检索到的公开资料，判断「${name}」${descBits ? `（已知资料：${descBits}）` : ''}指的是下列哪一种：\n` +
    'A. 一家公司主体 / 母公司 / 集团本身（brandType = "company"）\n' +
    'B. 某个公司旗下的一个品牌 / 产品线（brandType = "brand"）\n' +
    '只返回一个 JSON 对象，不要 markdown 围栏、不要任何解释文字：\n' +
    '{"brandType":"company 或 brand","brandFocus":"若属于 B 则填那个品牌名，否则空字符串","brandParent":"若能确定其母公司/集团则填名称，否则空字符串","reason":"一句话说明你依据什么判断"}\n' +
    '即使不确定也必须给出一个最合理的判断，并在 reason 里写明不确定。不要编造不存在的母公司名称。'
  );
}

/**
 * 真检索判断品牌归属：检索 → 注入实检资料 → 模型给 JSON。
 *
 * 诚实语义：检索失败 / 0 条 → ok:false（调用方必须显式报「没判断出来」，不许当成功）；
 * 拿到资料但模型没给合法 JSON → ok:false；只有既拿到资料、又解析出对象才 ok:true。
 *
 * @param {{companyName?:string, descBits?:string, question?:string}} input
 * @param {object} [opts] { query, temperature, fetchFn, chatFn }
 * @returns {Promise<{ok:boolean, data:object|null, source:string, grounded:boolean, provider:string, results:Array, error:string}>}
 */
export async function judgeBrandAttribution(input = {}, opts = {}) {
  const question = str(input.question) || buildBrandAttributionQuestion(input);
  const query = str(opts.query) || buildBrandAttributionQuery(input);
  const r = await groundedSearch(question, {
    ...opts,
    query,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
  });
  const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : null;
  return {
    ok: !!(r.ok && data),
    data,
    source: r.source,
    grounded: r.grounded,
    provider: r.provider,
    results: r.results,
    error: r.ok ? '' : (r.error || '检索/解析未取得可用结果'),
  };
}

// ==================== 调用点 5：竞品分析 · 找同行（KI-009） ====================

/**
 * 构造「找同行」的检索词基底（竞品分析四题共用）。
 *
 * 【KI-009】老板原话：「先修查询条件：即使用户没有手动输入行业关键词，
 *   也要正确传递已知行业与赛道约束。」
 *
 * 旧实现在 `MarketMomentum.jsx` 里是这么拼的：
 *   `[keyword || baseName || industry, industry && keyword ? industry : '']`
 * 行业只在**填了关键词**时才进检索词。而输入框写着"可以留空"，留空是常态路径：
 *   主体取企业名、行业取空串 ⇒ 检索词退化成"关于这家公司的一切"，
 *   Q1「你的同行到底有谁？」捞回来的东西跟赛道无关 ⇒ 选错对象。
 * 更难受的是 Q1 的 prompt 里**带着**行业（`buildSelfBrief` 拼了 `行业：…`），
 * 于是模型看到行业、检索词没有行业，又被要求"只依据检索到的公开资料"作答。
 * ⇒ 病在检索条件，不在 prompt。
 *
 * 【2026-11-09 · 第四次投诉：全空路径还是没修】
 *   KI-009 只修了「行业有值」的情形。实测默认路径（企业画像没填 industry、
 *   关键词框留空 —— 输入框自己写着"不用先补资料"）会让本函数返回 ''，
 *   调用侧兜底 `base || baseName || industry` 也全空 ⇒ Q1 检索词退化成
 *   "同行 竞争对手 主要品牌"，真检索捞回一堆泛行业文章，跟用户赛道无关。
 *   现在补两道：
 *     ① 行业缺失时用**企业画像里的主营/目标客户**兜底（同一份画像，不新造数据源）；
 *     ② 全空时如实返回 ''，并由 `competitorQueryGap()` 明确告诉调用方"没有赛道约束" —
 *        让 UI 提示用户补一句，而不是发一条泛 query 假装查过了。
 *
 * @param {{keyword?:string, companyName?:string, industry?:string,
 *          products?:string, targetCustomers?:string}} input
 * @returns {string} 形如「康健苗苗 口腔医疗器械」；四者都空时返回 ''（无约束可用，不伪造）
 */
export function buildCompetitorPeersQuery(input = {}) {
  const keyword = str(input.keyword);
  const name = str(input.companyName);
  const industry = str(input.industry);
  const products = str(input.products);
  const targetCustomers = str(input.targetCustomers);
  const subject = keyword || name;   // 主体：用户点名的关键词优先，否则企业名
  const parts = [];
  if (subject) parts.push(subject);
  // ★ 行业**始终**带上 —— 不再以"填了关键词"为前提。它是选对同行唯一可用的赛道约束。
  if (industry) parts.push(industry);
  // ★ 2026-11-09：行业没填时，用画像里的主营兜底。只挑一个（不叠加）——
  //   检索词过长会被 sanitizeSearchQuery 截断，叠三段等于后两段白写。
  else if (products) parts.push(products);
  // 主体与行业完全相同时去重（用户把行业名填进关键词框），别拼成「口腔 口腔」。
  const uniq = [];
  for (const p of parts) {
    if (!uniq.some((u) => u.toLowerCase() === p.toLowerCase())) uniq.push(p);
  }
  // 一个约束都没有时，把目标客户也算上（"诊所/医院"这类词对找同行是有效的赛道约束）。
  if (!uniq.length && targetCustomers) uniq.push(targetCustomers);
  return uniq.join(' ');
}

/**
 * 竞品检索的**赛道约束缺口**判定（唯一真源，供 UI 决定"要不要提示用户补一句"）。
 *
 * 为什么必须单独一个函数、而不是让调用侧 `!base` 自己判：
 *   `base` 为空有两个完全不同的原因，混起来就会说错话：
 *     ① 用户什么都没填（该提示他补行业）      → ok:false, needHint:true
 *     ② 用户填了但全是空白/纯标点（同上）      → ok:false, needHint:true
 *   而"有约束"时也不该提示（否则每次分析都挂一条噪音）。
 *
 * @param {{query?:string, keyword?:string, companyName?:string, industry?:string,
 *          products?:string, targetCustomers?:string}} input
 *        `query` 给了就直接用它判（调用点已经算过 base，不必重算第二遍 —— 重算等于两份真源）；
 *        否则按其余字段现算。
 * @returns {{ok:boolean, query:string, needHint:boolean, hint:string}}
 */
export function competitorQueryGap(input = {}) {
  const pre = str(input && input.query);
  const query = pre || buildCompetitorPeersQuery(input);
  const ok = !!query;
  return {
    ok,
    query,
    needHint: !ok,
    hint: ok ? '' : '还不知道你是做什么的，找回来的同行会跟你的赛道无关。'
      + '在「企业设置」补一句行业/主营，或在上面的关键词框填个品类，再点「分析」。',
  };
}

// ==================== 调用点 4：竞品对比 ====================

/**
 * 构造「竞品对比」检索词。
 *
 * 【0.21.9 · M1】原来这里是 `comps.slice(0, 4)` —— 只把**前 4 家**竞品拼进检索词。
 * 后果（老板体感"竞品分析还是不准确"的直接来源）：
 *   勾 6 家，第 5/6 家从没被检索过，矩阵那两行是模型按同行推断补齐的，
 *   而整表只有一个「联网检索（实检 N 条）」角标，用户根本看不出哪行没查 ——
 *   **勾得越多，真查过的比例越低**，而这时候整张表看起来最统一最有说服力。
 *
 * 现在取消截断：勾几家就查几家。注意这**不是**"改文案"，覆盖真的变了；
 * 调用侧另有 `matchCoveredCompetitors()` 按实检结果逐家判定有没有真查到，
 * 没查到的行会在矩阵里显式标「未检索，模型补全」（只改角标不改覆盖＝新的假绿）。
 *
 * @param {{companyName?:string, competitors?:Array|string}} input
 * @returns {string}
 */
export function buildCompetitorCompareQuery(input = {}) {
  const name = str(input.companyName);
  const comps = Array.isArray(input.competitors)
    ? input.competitors.map((c) => str(c)).filter(Boolean)
    : str(input.competitors).split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
  return [name, comps.join(' '), '竞品 对比 主要企业 行业地位'].filter(Boolean).join(' ');
}

/** 归一化用于"这条结果里提到它了吗"的宽松比对：去空白/标点、转小写。 */
function looseName(v) {
  return str(v).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * 逐家判定「本次实检到底查到了哪几家」。
 *
 * 【0.21.9 · M1】为什么必须逐家判：整张表只有一个来源角标，而角标的数字是"检索结果条数"，
 * 不是"查过的竞品数"。用户勾 6 家、实检只覆盖 2 家时，角标写「实检 8 条」看起来像全查过了。
 * 这里把"结果里是否出现该竞品名（标题/摘要/URL）"作为**可证伪**的覆盖判据：
 *   · 命中 → covered（该行有实检依据）
 *   · 未命中 → uncovered（该行是模型补全，UI 必须标出来）
 * 判据刻意保守（只认名字真的出现在实检文本里），宁可多标"未检索"也不冒充查过。
 *
 * ★ 字段名坑（2026-11-06 修）：provider 归一化后的正文字段叫 **`content`**
 *   （`src/main/webSearchProviders.js:180` tavily / `:220` bocha），旧实现读的是 `snippet`
 *   —— 那个字段在归一化结果里**根本不存在**。于是「结果正文里有没有提到这家」这个判据
 *   永远只看得到标题和 URL：明明检索到了、摘要里全是这家，却被判成「未检索」
 *   ⇒ 覆盖率被系统性**低估**，「未获取到」的体感有一半是这么来的。
 *   现在两个都读（`content` 优先），旧的 `snippet` 形状照样兼容。
 *
 * @param {Array<{title?:string,url?:string,content?:string,snippet?:string}>} results 实检结果
 * @param {Array<string>} competitors 本次要对比的竞品名
 * @returns {{covered:string[], uncovered:string[]}}
 */
export function matchCoveredCompetitors(results, competitors) {
  const list = (Array.isArray(competitors) ? competitors : []).map((c) => str(c)).filter(Boolean);
  const blob = (Array.isArray(results) ? results : [])
    .map((r) => [str(r && r.title), str(r && r.url), str(r && r.content) || str(r && r.snippet)].join(' '))
    .join(' ');
  const hay = looseName(blob);
  const covered = [];
  const uncovered = [];
  for (const name of list) {
    const key = looseName(name);
    // 名字归一化后不足 2 字（如单字品牌）无法可靠匹配 ⇒ 保守算未覆盖，交给人工核验。
    if (key.length >= 2 && hay.includes(key)) covered.push(name);
    else uncovered.push(name);
  }
  return { covered, uncovered };
}

/**
 * 真检索做竞品对比：拿到实检资料后，让模型基于资料产出对比结论（prompt 由调用方给定）。
 *
 * @param {{question?:string, companyName?:string, competitors?:Array|string, context?:object}} input
 * @param {object} [opts] { query, temperature, fetchFn, chatFn }
 * @returns {Promise<{ok:boolean, content:string, data:object|null, source:string, grounded:boolean, provider:string, results:Array, error:string}>}
 */
export async function searchCompetitorCompare(input = {}, opts = {}) {
  const question = str(input.question);
  const query = str(opts.query) || buildCompetitorCompareQuery(input);
  const r = await groundedSearch(question, {
    ...opts,
    query,
    context: input.context,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
  });
  return {
    ok: r.ok,
    content: r.content,
    data: r.data,
    source: r.source,
    grounded: r.grounded,
    provider: r.provider,
    results: r.results,
    error: r.error,
  };
}

export default {
  groundedHealth,
  groundedSource,
  groundedSearch,
  buildCompanyIntroQuery,
  searchCompanyIntro,
  buildBrandAttributionQuery,
  buildBrandAttributionQuestion,
  judgeBrandAttribution,
  buildCompetitorPeersQuery,
  competitorQueryGap,
  buildCompetitorCompareQuery,
  matchCoveredCompetitors,
  searchCompetitorCompare,
};
