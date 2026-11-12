/**
 * 企业深度画像服务。
 *
 * 背景：/api/geo/company-analyze 的质量强依赖入参。实测（见 probe_out/analyze_matrix_report.json）：
 *   - 只传 company_name      → 返回全「暂未查到」，媒体推荐退化为按名字面匹配（上游货源 → 生活消费）
 *   - 传 company_name + industry + brand_desc + products + target_audience
 *                            → 返回真实企业画像（上游货源 → 康健苗苗集团旗下口腔 B2B），
 *                              媒体推荐给出健康医疗 / IT科技 / 工业贸易 三类及理由
 * 因此本服务负责：1) 组装完整入参 2) 规整返回结构 3) 识别「占位垃圾值」以便前端降级。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * T11③ 改造（2026-09）：企业公开信息「真检索化」
 * ────────────────────────────────────────────────────────────────────────────
 * 老板要求「等联网修好再自动抓」——让豆芽联网把企业公开信息抓进来。但过去的链路有一个
 * 隐患：后端 /api/geo/company-analyze **是否真上过网无法证伪**（很可能也是"看起来联网"的假象）。
 * 故本文件新增**真检索优先**路径：
 *   analyzeCompanyGrounded → fetchWebSearch（主进程直连 tavily/bocha，真网页）
 *                          → 把检索原文注入 prompt → chatOnce 基于资料抽出结构化画像；
 *   analyzeCompany 改为：① 真检索优先；② 失败才降级到既有 geo-analyze；③ 两条来源都如实标注
 *   （走 describeSource，未确证联网时绝不写「联网检索」）。
 *
 * 合规红线（与 webCandidates 同一产品哲学，硬约束）：
 *   · 抓到的内容**绝不自动写库** —— 本文件是纯服务，只返回 profile + 可溯源 sources + candidates，
 *     「候选 → 用户勾选确认 → 才入库」由调用方（marketingStore 的建档/刷新，用户点击触发）决定；
 *   · 来源可溯源 —— 每条来源指向真实 URL（profile.sources / results[].url），事实带 [n] 角标；
 *   · 检索失败**不静默降级成"看起来像联网"** —— 如实返回 ok:false 或未联网文案。
 */

import { fetchWebSearch, chatOnce } from '../api.js';
import { extractJSON } from './projectAI.js';
import { buildGroundedPrompt } from './webSearch.js';
import {
  getCachedWebSearchHealth,
  describeSource,
  describeSourceWithCount,
  SOURCE_KINDS,
} from './webSearchHealth.js';

/** 后端的占位话术 */
const PLACEHOLDER_WORDS = /暂未查到|暂无法查到|未查到|暂无公开|无公开信息|尚未查到|暂未获取/g;
/** 「我没法回答」类话术 */
const UNCERTAIN_WORDS = /无法(推断|确定|获取|判断|核实)?|未能(推断|确定|获取)?|信息缺失|不明确|建议(先|提供|补充|确认)?|需进一步|以便(进一步|进行)?|请提供/g;
/**  punctuation & whitespace */
const PUNCT_RE = /[，。；、,.;\s:：（）()\-—《》“"'`~!！?？\[\]【】|]/g;
/** 检索过程 / 不确定话术（子句级）：这些句子不代表企业事实，应整句剥离 */
const UNCERTAIN_CLAUSE_RE = /暂未查到|暂无法查到|未查到|暂无公开|无公开信息|尚未查到|暂未获取|可能为|误写|别名|待核验|待补充|待确认|需进一步核实|信息缺失|信息不足|无法确认|无法核实/;

/**
 * 把文本按句切分，剔除含「暂未查到 / 可能为 / 误写 / 别名 / 待核验」等检索过程话术的句子，
 * 只保留确证信息。用于清洗 AI 深度搜索返回的 summary / 事实，
 * 避免「暂未查到XX，可能为误写或别名」这类检索过程描述污染企业画像。
 * @param {unknown} text 待清洗文本
 * @returns {string} 清洗后的文本
 */
export function stripUncertain(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  const sentences = raw.split(/(?<=[。；;！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.filter((s) => !UNCERTAIN_CLAUSE_RE.test(s));
  return kept.join('');
}

/**
 * 判断一段文本是否为后端的「占位/无法回答」内容。
 * @param {unknown} value 待判定值
 * @returns {boolean} true 表示为无信息占位内容
 */
export function isPlaceholderText(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return true;
  // 以「暂未查到」开头 → 整条就是「查不到某物」，无事实价值，判占位。
  if (/^(暂未查到|暂无法查到|未查到|暂无公开|无公开信息|尚未查到|暂未获取)/.test(raw)) return true;
  // 命中「暂未查到」类占位话术：剥掉占位词与标点后若几乎无实质信息才判占位；
  // 剩余有实质内容（如「暂未查到上市信息，其品牌归属康健苗苗集团」）不算占位。
  if (raw.match(PLACEHOLDER_WORDS)) {
    const stripped = raw.replace(PLACEHOLDER_WORDS, '').replace(PUNCT_RE, '');
    return stripped.length < 6;
  }
  // 命中「无法确定 / 信息缺失」类话术：一律判占位。
  if (raw.match(UNCERTAIN_WORDS)) return true;
  // 其余（含「种植 / 正畸 / 隐形矫正 / 洗牙 / 美白」等 2-4 字短中文核心卖点）均为有效内容。
  return false;
}

/**
 * 把后端任意形态（字符串 / 数组 / 对象数组）转成干净的字符串数组，并剔除占位项。
 * @param {unknown} value 后端原值
 * @returns {string[]} 清洗后的字符串数组
 */
export function toStrList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value.slice() : [value];
  const out = [];
  for (const item of arr) {
    if (item == null) continue;
    let s;
    if (typeof item === 'string') {
      s = item.trim();
    } else if (typeof item === 'object') {
      s = String(item.text ?? item.value ?? item.name ?? item.title ?? item.keyword ?? '').trim();
    } else {
      s = String(item).trim();
    }
    if (!s) continue;
    // 先剥离「暂未查到 / 误写 / 待核验」等检索过程子句，再判占位
    const cleaned = stripUncertain(s);
    if (!cleaned || isPlaceholderText(cleaned)) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/** 背景类事实 */
const RE_BACKGROUND = /集团|旗下|母公司|全资|控股|成立|总部|位于|创始人|归属于|分拆|隶属|收购|并购/;
/** 规模类事实 */
const RE_SCALE = /规模|融资|轮投资|注册资本|员工|团队|营收|市值|覆盖|合作品牌|网点|门店|渠道|用户(量|数)|注册用户|年销售额|出货/;
/** 产品类事实 */
const RE_PRODUCT = /产品|服务|平台|系统|方案|商城|APP|App|工具|耗材|器械|设备|软件|SaaS|供应链|采购|电商|解决|业务|主营/;

/**
 * 把扁平的 brand_facts 按「背景 / 产品 / 规模」粗分，便于 UI 分块展示。
 * 仅做展示分组，不改动原始事实内容。
 * @param {string[]} facts 已清洗的事实列表
 * @returns {{background: string[], product: string[], scale: string[], other: string[]}}
 */
export function groupFacts(facts) {
  const grouped = { background: [], product: [], scale: [], other: [] };
  for (const f of facts) {
    if (RE_BACKGROUND.test(f)) grouped.background.push(f);
    else if (RE_SCALE.test(f)) grouped.scale.push(f);
    else if (RE_PRODUCT.test(f)) grouped.product.push(f);
    else grouped.other.push(f);
  }
  return grouped;
}

/**
 * 规整后端 analysis 为统一画像对象。
 * @param {object|null} raw 后端返回的 analysis 对象
 * @returns {object|null} 规整后的画像；无有效信息时返回 null
 */
export function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const summaryRaw = raw.supplemented_desc ?? raw.supplement_desc ?? raw.summary ?? raw.brand_desc ?? '';
  const summary = isPlaceholderText(summaryRaw) ? '' : stripUncertain(summaryRaw);

  const coreKeywords = toStrList(raw.core_keywords ?? raw.keywords);
  const audience = toStrList(raw.target_audience ?? raw.audience);
  const insights = toStrList(raw.industry_insights ?? raw.industry_insight ?? raw.insight);
  const brandFacts = toStrList(raw.brand_facts ?? raw.facts);

  // 全部为空 → 后端没查出任何东西，视为无画像
  if (!summary && !coreKeywords.length && !audience.length && !insights.length && !brandFacts.length) {
    return null;
  }

  return {
    summary,
    brandFacts,
    coreKeywords,
    audience,
    insights,
    facts: groupFacts(brandFacts),
    raw,
  };
}

/**
 * 从建档输入抽检索词（企业公开信息）：公司名 + 行业 + 关键属性词。
 * @param {{companyName?:string, industry?:string}} input
 * @returns {string}
 */
export function buildCompanyQuery(input) {
  const name = String((input && input.companyName) || '').trim();
  const industry = String((input && input.industry) || '').trim();
  const parts = [name];
  if (industry) parts.push(industry);
  parts.push('公司 成立时间 法定代表人 融资 业务');
  return parts.filter(Boolean).join(' ');
}

/**
 * 组装「基于实检资料抽结构化画像」的 prompt：
 * 先复用 buildGroundedPrompt 注入检索原文 + 诚实兜底要求，再追加 JSON 输出契约。
 * JSON 字段名与后端 analysis 对齐（snake_case），这样 normalizeAnalysis 可原样复用。
 * @param {object} input 建档输入
 * @param {Array<{title:string,url:string,content:string}>} results 真实检索结果
 * @returns {string}
 */
export function buildCompanySearchPrompt(input, results) {
  const name = String((input && input.companyName) || '').trim();
  const question =
    `请依据上述网页资料，整理「${name}」的企业公开信息，覆盖：企业概况（成立时间/所在地/法定代表人等）、` +
    '业务板块与主营产品/服务、融资/规模、品牌矩阵（旗下子品牌或产品线）、主要竞品、品牌调性、' +
    '目标客户的典型痛点、可查到的典型案例。' +
    '每条事实请用 [序号] 标注其来源资料；资料未覆盖的项不要编造。';
  const base = buildGroundedPrompt(question, results);
  return (
    base +
    '\n\n【输出格式】只返回一个 JSON 对象，不要 markdown 代码围栏、不要任何解释文字：\n' +
    '{ "summary": "一句话企业概况（可带 [n] 角标）",\n' +
    '  "brand_facts": ["每条一条公开事实，能带 [n] 角标就带上"],\n' +
    '  "core_keywords": ["核心业务/卖点关键词"],\n' +
    '  "target_audience": ["目标客户人群"],\n' +
    '  "industry_insights": ["行业观察（可留空数组）"],\n' +
    '  "products": ["主营产品 / 服务"],\n' +
    '  "competitors": ["同行业主要竞争对手（公开资料里可查到的）"],\n' +
    '  "brand_tone": "品牌调性（如 专业 / 亲和 / 高端），没把握留空串",\n' +
    '  "customer_pains": ["目标客户的典型痛点"],\n' +
    '  "success_cases": ["公开资料里提到的典型案例"] }\n' +
    '查不到的字段给空数组或空串，禁止编造。'
  );
}

/**
 * 真检索优先的企业画像：真实检索 → 注入原文 → 模型基于资料抽结构化画像。
 *
 * 返回结构（additive，供 analyzeCompany 与调用方消费）：
 *   { ok, profile, error, grounded, provider, results, sources, elapsedMs }
 *   · ok:false               → 检索失败 / 无可用资料（error 说明原因，**不静默降级**）；
 *   · ok:true + grounded:true → 画像基于真实网页资料，profile.sources 为可溯源 URL；
 *   · grounded 恒 = results.length > 0。
 *
 * @param {object} input 建档输入 {companyName, industry, brandDesc, products, audience}
 * @param {object} [opts]
 * @param {number} [opts.count]      检索条数
 * @param {number} [opts.temperature] 生成温度（默认 0.1，偏事实）
 * @param {string} [opts.query]      显式检索词
 * @param {(q:string,o?:object)=>Promise<object>} [opts.fetchFn] 可注入检索实现（默认 fetchWebSearch）
 * @param {(messages:Array,ctx?:object,o?:object)=>Promise<object>} [opts.chatFn] 可注入补全实现（默认 chatOnce）
 * @returns {Promise<object>}
 */
export async function analyzeCompanyGrounded(input, opts = {}) {
  const companyName = String((input && input.companyName) || '').trim();
  if (!companyName) {
    return { ok: false, profile: null, error: '请填写公司名称', grounded: false, provider: '', results: [], sources: [], elapsedMs: 0 };
  }
  const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : fetchWebSearch;
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const query = String(opts.query || '').trim() || buildCompanyQuery(input);
  const count = typeof opts.count === 'number' && opts.count > 0 ? opts.count : 6;

  // ---- 1) 真实检索 ----
  let searchRes;
  try {
    searchRes = await fetchFn(query, { count });
  } catch (e) {
    return { ok: false, profile: null, error: '在线检索失败：' + ((e && e.message) || String(e)), grounded: false, provider: '', results: [], sources: [], elapsedMs: 0 };
  }
  const results = Array.isArray(searchRes && searchRes.results) ? searchRes.results : [];
  const provider = (searchRes && searchRes.provider) || 'none';
  const elapsedMs = typeof (searchRes && searchRes.elapsedMs) === 'number' ? searchRes.elapsedMs : 0;

  if (!searchRes || searchRes.ok !== true) {
    return { ok: false, profile: null, error: (searchRes && searchRes.error) || '在线检索失败', grounded: false, provider, results: [], sources: [], elapsedMs };
  }
  if (results.length === 0) {
    // 检索成功但确实没结果：如实标注未联网（无从得到有出处的信息），不静默降级。
    return { ok: false, profile: null, error: '在线检索未返回可用资料', grounded: false, provider, results: [], sources: [], elapsedMs };
  }

  // ---- 2) 注入原文 → 模型抽结构化画像 ----
  const prompt = buildCompanySearchPrompt(input, results);
  let ai;
  try {
    ai = await chatFn([{ role: 'user', content: prompt }], null, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.1,
      reasoningEffort: 'none',
    });
  } catch (e) {
    return { ok: false, profile: null, error: '生成失败：' + ((e && e.message) || String(e)), grounded: true, provider, results, sources: sourceUrls(results), elapsedMs };
  }
  const text = ai && ai.ok === true && ai.content ? String(ai.content) : '';
  if (!text.trim()) {
    return { ok: false, profile: null, error: (ai && ai.error) || '模型未返回内容', grounded: true, provider, results, sources: sourceUrls(results), elapsedMs };
  }

  // ---- 3) 解析 JSON（解析不出则把整段当 summary，仍算 grounded）----
  const parsed = extractJSON(text) || { summary: text };
  const profile = normalizeAnalysis(parsed);
  if (!profile) {
    return { ok: false, profile: null, error: '检索到资料但未能抽出有效企业画像', grounded: true, provider, results, sources: sourceUrls(results), elapsedMs };
  }
  profile.sources = sourceUrls(results);
  profile.provider = provider;
  profile.grounded = true;
  return { ok: true, profile, error: '', grounded: true, provider, results, sources: sourceUrls(results), elapsedMs };
}

/**
 * 去重提取检索结果的 URL 列表（可溯源）。
 * @param {Array<{url?:string}>} results
 * @returns {string[]}
 */
export function sourceUrls(results) {
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    const u = String((r && r.url) || '').trim();
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * 调用 /api/geo/company-analyze 获取企业深度画像（T11③ 起：真检索优先 + 如实降级）。
 *
 * 兼容：签名与返回值对既有调用方（marketingStore / deepThink）**完全向后兼容**——
 *   `{ok, profile, error, degraded}` 四个既有字段语义不变；新增字段均为附加。
 *
 * provider 顺序：
 *   1) 真检索（analyzeCompanyGrounded，真网页）→ ok 时 source 用 describeSourceWithCount 标注「实检 N 条」；
 *   2) 失败 → 降级到 /api/geo/company-analyze（既有链路）；其 source 用探针缓存如实标注，
 *      **未确证联网时绝不写「联网检索」**。
 *
 * @param {(path: string, method?: string, body?: object) => Promise<object>} geoProxy GEO 代理函数
 * @param {{companyName: string, industry: string, brandDesc: string, products: string, audience: string, goal?: string}} input 用户输入
 * @param {object} [opts] { prefer:'grounded'|'legacy', fetchFn, chatFn, count, query }（可注入，供单测）
 * @returns {Promise<{ok: boolean, profile: object|null, error: string, degraded: boolean, source: string, grounded: boolean, provider: string, results: Array, sources: string[]}>}
 */
export async function analyzeCompany(geoProxy, input, opts = {}) {
  const companyName = String(input.companyName || '').trim();
  if (!companyName) {
    return { ok: false, profile: null, error: '请填写公司名称', degraded: true, source: '', grounded: false, provider: '', results: [], sources: [] };
  }

  // ---- 1) 真检索优先 ----
  let groundedRes = null;
  if (opts.prefer !== 'legacy') {
    try {
      groundedRes = await analyzeCompanyGrounded(input, opts);
    } catch (e) {
      groundedRes = { ok: false, profile: null, error: '在线检索异常：' + ((e && e.message) || String(e)), grounded: false, provider: '', results: [], sources: [] };
    }
    if (groundedRes && groundedRes.ok && groundedRes.profile) {
      const n = groundedRes.results.length;
      const health = { available: true, webApi: true, provider: groundedRes.provider, probeCount: n };
      return {
        ok: true,
        profile: groundedRes.profile,
        error: '',
        degraded: false,
        // 有真实检索直接证据 → 允许写「联网检索」，并带 provider 与实检条数。
        source: describeSourceWithCount(SOURCE_KINDS.WEB, health, n),
        grounded: true,
        provider: groundedRes.provider,
        results: groundedRes.results,
        sources: groundedRes.sources,
      };
    }
  }

  // ---- 2) 降级：既有 /api/geo/company-analyze ----
  const payload = {
    company_name: companyName,
    // 后端真实消费的字段名（与 App.jsx 的 GEO 向导保持一致）
    industry: String(input.industry || '').trim(),
    brand_desc: String(input.brandDesc || '').trim(),
    products: String(input.products || '').trim(),
    target_audience: String(input.audience || '').trim(),
  };
  // 投放目标作为补充上下文，后端忽略也无害
  if (String(input.goal || '').trim()) payload.goal = String(input.goal).trim();

  // 降级来源文案：用探针缓存如实标注。geo-analyze 是否真联网无法直接证实 →
  // 未确证时 describeSource 会返回「模型分析（联网状态未确认）」，绝不谎称「联网检索」。
  const legacySource = describeSource(SOURCE_KINDS.WEB, getCachedWebSearchHealth());

  let res;
  try {
    res = await geoProxy('/api/geo/company-analyze', 'POST', payload);
  } catch (e) {
    return {
      ok: false, profile: null, error: '深度分析接口不可用：' + e.message, degraded: true,
      source: legacySource, grounded: false, provider: 'geo-analyze', results: [], sources: [],
    };
  }
  if (!res || res.ok === false) {
    return {
      ok: false,
      profile: null,
      error: (res && res.error) || '深度分析接口返回失败',
      degraded: true,
      source: legacySource, grounded: false, provider: 'geo-analyze', results: [], sources: [],
    };
  }

  const profile = normalizeAnalysis(res.analysis || res.data || res);
  if (!profile) {
    return {
      ok: false,
      profile: null,
      error: 'AI 未检索到该企业的公开信息',
      degraded: true,
      source: legacySource, grounded: false, provider: 'geo-analyze', results: [], sources: [],
    };
  }
  return {
    ok: true, profile, error: '', degraded: false,
    source: legacySource, grounded: false, provider: 'geo-analyze', results: [], sources: [],
  };
}

/**
 * 组装 /api/geo/media-recommend 请求体。
 * 优先使用 AI 画像字段，缺失时回落到用户手工填写内容。
 * @param {{companyName: string, industry: string, brandDesc: string, goal: string}} input 用户输入
 * @param {object|null} profile AI 画像
 * @returns {object} media-recommend 请求体
 */
export function buildRecommendPayload(input, profile) {
  const summary = profile && profile.summary ? profile.summary : String(input.brandDesc || '').trim();
  return {
    company_name: String(input.companyName || '').trim(),
    industry: String(input.industry || '').trim(),
    brand_desc: summary,
    core_keywords: profile && profile.coreKeywords ? profile.coreKeywords : [],
    target_audience: profile && profile.audience ? profile.audience : [],
    goal: String(input.goal || '').trim(),
  };
}

/**
 * 把 AI 分析结果（analysis）映射为营销资产的 AI 派生字段。
 * analysis 既可以是后端原始 analysis（snake_case），也可以是 normalizeAnalysis 的规整结果（camelCase）。
 * 竞品 / 专家资源 / 成功案例 / 痛点 / 禁区 / 合规词库为 P0 手填字段，这里固定返回空，由调用方合并保留。
 * @param {object|null} analysis AI 分析结果
 * @param {{companyName: string, industry: string, brandDesc: string, products: string, audience: string}} input 建档输入
 * @returns {object} 营销资产的部分字段（camelCase）
 */
export function analysisToAsset(analysis, input) {
  let profile;
  if (
    analysis &&
    (analysis.coreKeywords !== undefined ||
      analysis.brandFacts !== undefined ||
      analysis.summary !== undefined)
  ) {
    // 已是 normalizeAnalysis 的规整结果
    profile = analysis;
  } else {
    profile = normalizeAnalysis(analysis);
  }
  const a = profile || {};
  const summary = a.summary || String((input && input.brandDesc) || '').trim();
  return {
    profile: summary,
    products: String((input && input.products) || '').trim(),
    coreSellingPoints: Array.isArray(a.coreKeywords) ? a.coreKeywords.slice() : [],
    targetCustomers: Array.isArray(a.audience) ? a.audience.slice() : [],
    brandFacts: Array.isArray(a.brandFacts) ? a.brandFacts.slice() : [],
    marketingStrategy:
      Array.isArray(a.insights) && a.insights.length ? a.insights.join('\n') : '',
    brandTone: '',
    competitors: [],
    expertResources: [],
    successCases: [],
    customerPains: [],
    contentTaboos: [],
    complianceWords: [],
  };
}

/**
 * 由营销资产组装 company-analyze 入参（camelCase）。
 * @param {object} asset 营销资产（marketingStore 的 asset）
 * @returns {{companyName: string, industry: string, brandDesc: string, products: string, audience: string}}
 */
export function assetToAnalyzeInput(asset) {
  const a = asset || {};
  const audience = Array.isArray(a.targetCustomers)
    ? a.targetCustomers.join('、')
    : String(a.targetCustomers || '').trim();
  return {
    companyName: String(a.companyName || '').trim(),
    industry: String(a.industry || '').trim(),
    brandDesc: String(a.profile || '').trim(),
    products: String(a.products || '').trim(),
    audience,
  };
}

/**
 * 由营销资产组装 media-recommend 请求体（snake_case wire 格式）。
 * 与 buildRecommendPayload 保持同一口径，供媒体发文 / GEO 向导 Step7 复用。
 * @param {object} asset 营销资产
 * @param {string} [goalLabel] 当前营销目标文案
 * @returns {object} media-recommend 请求体
 */
export function assetToRecommendPayload(asset, goalLabel, companyNameFallback) {
  const a = asset || {};
  return {
    company_name: String(a.companyName || companyNameFallback || '').trim(),
    industry: String(a.industry || '').trim(),
    brand_desc: String(a.profile || '').trim(),
    core_keywords: Array.isArray(a.coreSellingPoints) ? a.coreSellingPoints.slice() : [],
    target_audience: Array.isArray(a.targetCustomers) ? a.targetCustomers.slice() : [],
    goal: String(goalLabel || '').trim(),
  };
}

// ============================================================================
// 同名 / 近似企业主体消歧（0.21.14 · 老板需求 4「经常理解错企业」）
// ============================================================================
/**
 * 【为什么需要这一层】
 * 老板原话：「企业大脑现在比较难用 经常理解错企业，需要有一个确认，比如我输入苗苗 他会出现
 * 很多苗苗企业 要确定到底是哪个苗苗」。
 *
 * 机制性原因：过去「AI 深度建档」是**直接拿用户输入的名字**去 analyzeCompany，
 * 中间没有「同名企业消歧」这一步。输入「苗苗」时，检索结果里混着好几家不同工商主体
 * （杭州的、天津的、做器械的、做诊所的…），模型只能猜一家、或把几家的信息混成一家 ——
 * 于是下游每一个模块都建立在一个不存在（或不对）的公司上。
 *
 * 本段只负责**取候选**：真实检索 → 注入原文 → 让模型抽「企业主体候选」结构化字段；
 * 模型不响应时退化为「按检索到的网页标题列出」（仍是真数据、带 URL）。
 * 与 webCandidates 同一合规红线：**不写库、不编造、失败不静默成空**；
 * 「用户单选确认 → 才建档」由 UI（CompanyEntityPicker + AssetPanel）决定。
 */

/** 候选上限：一批同名/近名主体通常 2-6 家，8 条足够，避免刷屏。 */
const MAX_ENTITY_CANDIDATES = 8;
/** 主体名最长长度，超过按噪声丢弃（模型偶尔会回一整句解释）。 */
const MAX_ENTITY_NAME_LEN = 60;

/** 去掉空白/标点并转小写，用于「这条结果里提到它了吗」的宽松比对。 */
function looseKey(v) {
  return String(v == null ? '' : v).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * 单字段净化：先剥离「暂未查到 / 可能为 / 待核验」等检索过程子句，再判占位。
 * @param {unknown} v 原值
 * @returns {string} 净化后的字段值（无有效内容时为空串）
 */
function cleanEntityField(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  const cleaned = stripUncertain(raw);
  if (!cleaned || isPlaceholderText(cleaned)) return '';
  return cleaned;
}

/** 取 URL 的 host（用于「来源：xxx.com」角标，不给用户看长 URL）。 */
function hostOf(url) {
  const u = String(url || '').trim();
  const m = u.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : '';
}

/**
 * 组装「同名企业主体消歧」检索词（企业名 + 行业 + 消歧关键词）。
 * @param {{companyName?:string, industry?:string}} [input]
 * @returns {string}
 */
export function buildCompanyEntityQuery(input = {}) {
  const name = String((input && input.companyName) || '').trim();
  const industry = String((input && input.industry) || '').trim();
  return [name, industry, '公司 工商全称 注册地 成立时间 同名 相似企业'].filter(Boolean).join(' ');
}

/**
 * 组装「从实检资料里抽出企业主体候选」的 prompt。
 * @param {{companyName?:string, industry?:string}} input 建档输入
 * @param {Array<{title:string,url:string,content:string}>} results 真实检索结果
 * @returns {string}
 */
export function buildCompanyEntityPrompt(input, results) {
  const name = String((input && input.companyName) || '').trim();
  const industry = String((input && input.industry) || '').trim();
  const question =
    `请从上一步检索到的网页资料里，找出「${name}」可能指的**企业主体**：同名或名称高度相近、` +
    `${industry ? `尤其是「${industry}」行业的` : ''}互不相同的工商主体，每一家单独一条。` +
    '每条必须给出：工商全称、所在地（省/市）、所属行业、一句话简介、这份资料在检索结果里的序号。' +
    '只依据上述资料，资料里没有的字段留空字符串；不要用记忆补全，不要编造不存在的公司。';
  const base = buildGroundedPrompt(question, results);
  return (
    base +
    '\n\n【输出格式】只返回一个 JSON 对象，不要 markdown 代码围栏、不要任何解释文字：\n' +
    '{ "candidates": [ { "name": "企业工商全称", "region": "所在地（省/市）", ' +
    '"industry": "所属行业", "brief": "一句话简介", "source": 1 } ] }\n' +
    `最多 ${MAX_ENTITY_CANDIDATES} 条；source 填你在上面资料里看到的序号（整数），没有依据填 0。` +
    '查不到任何企业主体时返回 { "candidates": [] }。'
  );
}

/**
 * 规整单个候选：净化每个字段、绑定来源（有 URL 才算「已确证」）。
 *
 * 来源绑定顺序：① 模型给的资料序号 → ② 名称在实检结果标题/摘要里的宽松匹配 →
 * ③ 都绑不上 ⇒ verified:false，UI 必须显式标「来源未确证」。
 *
 * @param {object} raw 模型返回的一条候选
 * @param {Array<{title?:string,url?:string,content?:string}>} results 真实检索结果
 * @returns {{name:string, region:string, industry:string, brief:string, sourceUrl:string,
 *            sourceTitle:string, verified:boolean, sourceNote:string}|null}
 */
export function normalizeEntityCandidate(raw, results = []) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const name = cleanEntityField(o.name ?? o.companyName ?? o.company_name ?? o.title ?? '');
  if (!name || name.length > MAX_ENTITY_NAME_LEN) return null;

  const list = Array.isArray(results) ? results : [];
  const pickAt = (i) => (i >= 1 && i <= list.length ? list[i - 1] : null);

  let hit = pickAt(Number(o.source) || Number(o.source_index) || 0);
  if (!hit) {
    // 模型没给序号（或给错）：按名字反查实检结果，宁可判「未确证」也不乱挂来源。
    const key = looseKey(name);
    hit = list.find((r) => {
      const blob = looseKey([r && r.title, r && r.content, r && r.snippet].join(' '));
      return key.length >= 2 && blob.includes(key);
    }) || null;
  }

  const sourceUrl = String((hit && hit.url) || '').trim();
  const sourceTitle = String((hit && hit.title) || '').trim();
  return {
    name,
    region: cleanEntityField(o.region ?? o.city ?? o.location ?? o.area),
    industry: cleanEntityField(o.industry ?? o.industry_name ?? o.sector),
    brief: cleanEntityField(o.brief ?? o.desc ?? o.description ?? o.note ?? o.summary),
    sourceUrl,
    sourceTitle,
    verified: !!sourceUrl,
    sourceNote: sourceUrl ? `来源：${hostOf(sourceUrl) || sourceUrl}` : '来源未确证（无网页出处）',
  };
}

/**
 * 解析模型返回文本为候选数组（extractJSON 优先，兼容直接数组 / {candidates} / {items}）。
 * @param {string} text 模型返回文本
 * @param {Array<{title?:string,url?:string,content?:string}>} results 真实检索结果
 * @returns {Array<object>} 规整后的候选（去重、限量）
 */
export function parseEntityCandidates(text, results = []) {
  const parsed = extractJSON(String(text == null ? '' : text));
  let arr = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.candidates)) arr = parsed.candidates;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) arr = parsed.items;
  if (!Array.isArray(arr)) return [];

  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const cand = normalizeEntityCandidate(item, results);
    if (!cand) continue;
    const key = looseKey(cand.name);
    if (key && seen.has(key)) continue;
    seen.add(key);
    out.push(cand);
    if (out.length >= MAX_ENTITY_CANDIDATES) break;
  }
  return out;
}

/**
 * 降级取候选：模型没给出结构化结果时，直接按**实检网页标题**列出企业主体。
 *
 * 为什么这样也算数、且不算编造：每一条都绑在一条真实检索结果（URL）上，
 * 名字是从网页标题里切出来的，用户可以点开核对。宁可给「未归并的原始标题」，
 * 也不给「模型记忆里的公司」——后者正是「理解错企业」的来源。
 *
 * @param {Array<{title?:string,url?:string,content?:string}>} results 真实检索结果
 * @param {string} seed 用户输入的企业名
 * @returns {Array<object>} 候选
 */
export function deriveCandidatesFromResults(results, seed) {
  const list = Array.isArray(results) ? results : [];
  const seedKey = looseKey(seed);
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const title = String((r && r.title) || '').trim();
    if (!title) continue;
    // 标题里常见的分隔符：「公司名 ｜ 官网」「公司名-企查查」「公司名_工商信息」
    const seg = title.split(/[｜|—–_\-:：·\n]/).map((s) => s.trim()).filter(Boolean)[0] || title;
    const name = cleanEntityField(seg.slice(0, MAX_ENTITY_NAME_LEN));
    if (!name) continue;
    // 有同类关键词的优先；完全没有 seed 字样的结果也保留（可能是简称/别名）。
    const key = looseKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const regionMatch = title.match(/[（(]([^（()）]{2,8})[）)]/);
    const content = String((r && (r.content || r.snippet)) || '').trim();
    out.push({
      name,
      region: cleanEntityField(regionMatch ? regionMatch[1] : ''),
      industry: '',
      brief: cleanEntityField(content.slice(0, 90)),
      sourceUrl: String((r && r.url) || '').trim(),
      sourceTitle: title,
      verified: !!String((r && r.url) || '').trim(),
      sourceNote: r && r.url ? `来源：${hostOf(r.url) || r.url}` : '来源未确证（无网页出处）',
      // 标记：这条是从网页标题直接列出的，没做主体归并（UI 会提示用户自己核对）
      derived: true,
      seedMatched: !!seedKey && key.includes(seedKey),
    });
    if (out.length >= MAX_ENTITY_CANDIDATES) break;
  }
  // seed 命中的排前面（更可能是同一家），其余保序。
  out.sort((a, b) => Number(b.seedMatched) - Number(a.seedMatched));
  return out;
}

/**
 * 检索「同名 / 近似企业主体」候选（真检索优先，模型抽取结构化字段，失败退化为标题列表）。
 *
 * 返回语义（与 fetchWebCandidates 同构的诚实三态）：
 *   · ok:false                    → 输入缺失 / 检索失败 / 检索到资料但抽不出主体（error 说明原因）；
 *   · ok:true + candidates:[]     → 检索成功但确实没有可用主体（调用方必须显式降级手填）；
 *   · ok:true + candidates:[...]  → 每条都带 verified（是否有网页出处）与 sourceNote。
 *
 * @param {{companyName?:string, industry?:string}} input 检索主体
 * @param {object} [opts] { fetchFn, chatFn, query, count, temperature }（可注入，供单测）
 * @returns {Promise<{ok:boolean, candidates:Array<object>, verified:boolean, provider:string,
 *                    source:string, note:string, error:string, results:Array}>}
 */
export async function findCompanyEntities(input = {}, opts = {}) {
  const seed = String((input && input.companyName) || '').trim();
  const empty = { ok: false, candidates: [], verified: false, provider: '', source: '', note: '', error: '', results: [] };
  if (!seed) return { ...empty, error: '请先填写企业名称' };

  const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : fetchWebSearch;
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const query = String(opts.query || '').trim() || buildCompanyEntityQuery(input);
  const count = typeof opts.count === 'number' && opts.count > 0 ? opts.count : 8;

  // ---- 1) 真实检索 ----
  let searchRes;
  try {
    searchRes = await fetchFn(query, { count });
  } catch (e) {
    return { ...empty, error: '在线检索失败：' + ((e && e.message) || String(e)) };
  }
  const results = Array.isArray(searchRes && searchRes.results) ? searchRes.results : [];
  const provider = (searchRes && searchRes.provider) || 'none';
  if (!searchRes || searchRes.ok !== true) {
    return { ...empty, provider, error: (searchRes && searchRes.error) || '在线检索失败' };
  }
  if (results.length === 0) {
    return { ...empty, provider, error: '在线检索未返回可用资料' };
  }
  const source = describeSourceWithCount(
    SOURCE_KINDS.WEB,
    { available: true, webApi: true, provider, probeCount: results.length },
    results.length,
  );

  // ---- 2) 注入原文 → 模型抽结构化主体 ----
  let candidates = [];
  let note = '';
  try {
    const ai = await chatFn([{ role: 'user', content: buildCompanyEntityPrompt(input, results) }], null, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.1,
      reasoningEffort: 'none',
    });
    const text = ai && ai.ok === true && ai.content ? String(ai.content) : '';
    if (text.trim()) candidates = parseEntityCandidates(text, results);
    else note = (ai && ai.error) || '模型未返回内容';
  } catch (e) {
    note = '模型调用异常：' + ((e && e.message) || String(e));
  }

  // ---- 3) 模型没给出 → 退化为「按实检网页标题列出」（真数据、带 URL）----
  let derived = false;
  if (!candidates.length) {
    candidates = deriveCandidatesFromResults(results, seed);
    derived = candidates.length > 0;
    if (derived) note = (note ? note + '；' : '') + '以下按检索到的网页标题列出，未做主体归并，请核对全称后再确认。';
  }
  if (!candidates.length) {
    return {
      ok: false, candidates: [], verified: false, provider, source, note,
      error: '检索到资料但没能识别出企业主体', results,
    };
  }
  return {
    ok: true,
    candidates,
    verified: candidates.some((c) => c.verified),
    provider,
    source,
    note,
    error: '',
    derived,
    results,
  };
}

// ============================================================================
// 一键全量建档：画像 → 资产补丁 + 「已补齐 / 缺失」清单
// ============================================================================
/**
 * 建档完整度口径：13 项企业画像（与 marketingStore 的 schema 同源）。
 * 顺序 = 老板说的「尽可能完整」的检查顺序，也是 UI 清单的展示顺序。
 */
export const ASSET_COVERAGE_FIELDS = [
  { key: 'companyName', label: '企业全称' },
  { key: 'industry', label: '所属行业' },
  { key: 'profile', label: '企业画像' },
  { key: 'products', label: '主要产品' },
  { key: 'coreSellingPoints', label: '核心卖点' },
  { key: 'targetCustomers', label: '目标客户' },
  { key: 'competitors', label: '竞品' },
  { key: 'brandTone', label: '品牌调性' },
  { key: 'brandFacts', label: '品牌事实库' },
  { key: 'expertResources', label: '医生专家资源' },
  { key: 'successCases', label: '成功案例' },
  { key: 'customerPains', label: '客户痛点' },
  { key: 'complianceWords', label: '合规词库' },
];

/**
 * 单个字段是否「真的拿到了」（不是占位、不是空串）。
 * @param {object} asset 营销资产
 * @param {string} key 字段名
 * @returns {boolean}
 */
export function isAssetFieldFilled(asset, key) {
  const v = asset ? asset[key] : undefined;
  if (Array.isArray(v)) return v.some((x) => !isPlaceholderText(x));
  if (typeof v === 'string') return !isPlaceholderText(v) && v.trim().length >= 2;
  return false;
}

/**
 * 算「已补齐 N 项 / 缺 M 项」清单。
 *
 * 为什么必须算这个：老板要的是「一键全部建掉，尽可能完整」。只报一句「建档成功」时，
 * 用户无法知道哪些资料拿到了、哪些还得自己补 —— 于是又回到「一个个表单手填」。
 * 这里的清单就是**显式的部分成功**：拿到哪些、还缺哪些，缺的一眼可见。
 *
 * @param {object} asset 建档后的完整资产（调用方需先把补丁合并进去）
 * @returns {{total:number, filledCount:number, missingCount:number,
 *            filled:Array<{key:string,label:string}>, missing:Array<{key:string,label:string}>,
 *            text:string}}
 */
export function buildAssetCoverage(asset) {
  const filled = [];
  const missing = [];
  for (const f of ASSET_COVERAGE_FIELDS) {
    if (isAssetFieldFilled(asset, f.key)) filled.push(f);
    else missing.push(f);
  }
  const total = ASSET_COVERAGE_FIELDS.length;
  let text;
  if (missing.length === 0) {
    text = `已补齐 ${total} 项（全部拿到）`;
  } else if (filled.length === 0) {
    text = `已补齐 0 项；缺 ${missing.length} 项（AI / 联网未取到资料，可手动补充）`;
  } else {
    text = `已补齐 ${filled.length} 项 / 缺 ${missing.length} 项：${missing.map((m) => m.label).join('、')}`;
  }
  return { total, filledCount: filled.length, missingCount: missing.length, filled, missing, text };
}

/**
 * 把 AI 画像（normalizeAnalysis 结果或其 raw）映射成**营销资产补丁**（用于一键全量建档）。
 *
 * 与 analysisToAsset 的区别（为什么另起一个函数，而不是改它）：
 *   · analysisToAsset 会**返回全部 13 个键**（空的一律给空数组/空串），调用方 `{...prev, ...mapped}`
 *     时会把用户已经确认过的竞品 / 专家 / 案例**一并清空**（重新建档＝数据被抹掉）；
 *   · 本函数**只返回真正有值的键**，交给 `updateAsset(patch)` 合并，天然不覆盖已有内容
 *     ⇒ 「一键建档」可以反复点，不会把人工补的东西冲掉；
 *   · 同时吃 0.21.14 起 prompt 新要的 competitors / brand_tone / customer_pains / success_cases。
 *
 * 底线：所有文本都过 stripUncertain + isPlaceholderText，**不把模型瞎猜写成事实**
 * （「暂未查到」「可能为别名」这类检索过程话术不会进资产）。
 *
 * @param {object|null} profile analyzeCompany 返回的 profile（normalizeAnalysis 结果）
 * @param {{companyName?:string, industry?:string, brandDesc?:string, products?:string, audience?:string}} input 建档输入
 * @param {object|null} [entity] 用户确认的企业主体候选（来自 findCompanyEntities）
 * @returns {object} 资产补丁（只含非空字段）
 */
export function analysisToFullAsset(profile, input, entity) {
  const a = profile && typeof profile === 'object' ? profile : {};
  const raw = a.raw && typeof a.raw === 'object' ? a.raw : {};
  const ent = entity && typeof entity === 'object' ? entity : {};
  const inp = input && typeof input === 'object' ? input : {};
  const patch = {};

  const companyName = String(inp.companyName || '').trim() || String(ent.name || '').trim();
  if (companyName) patch.companyName = companyName;

  const industry = String(inp.industry || '').trim() || cleanEntityField(ent.industry);
  if (industry) patch.industry = industry;

  const summary =
    cleanEntityField(a.summary) ||
    cleanEntityField(raw.supplemented_desc) ||
    cleanEntityField(raw.supplement_desc) ||
    cleanEntityField(inp.brandDesc);
  if (summary) patch.profile = summary;

  const products =
    String(inp.products || '').trim() ||
    toStrList(raw.products ?? raw.main_products ?? raw.product_lines).join('、');
  if (products) patch.products = products;

  const selling = toStrList(a.coreKeywords ?? raw.core_keywords);
  if (selling.length) patch.coreSellingPoints = selling;

  const audience = toStrList(a.audience ?? raw.target_audience ?? inp.audience);
  if (audience.length) patch.targetCustomers = audience;

  const facts = toStrList(a.brandFacts ?? raw.brand_facts);
  if (facts.length) patch.brandFacts = facts;

  const competitors = toStrList(raw.competitors ?? raw.competitor_brands ?? raw.competitor);
  if (competitors.length) patch.competitors = competitors;

  const brandTone = cleanEntityField(raw.brand_tone ?? raw.brandTone ?? raw.tone);
  if (brandTone) patch.brandTone = brandTone;

  const pains = toStrList(raw.customer_pains ?? raw.pains ?? raw.pain_points);
  if (pains.length) patch.customerPains = pains;

  const cases = toStrList(raw.success_cases ?? raw.cases);
  if (cases.length) patch.successCases = cases;

  const experts = toStrList(raw.expert_resources ?? raw.experts);
  if (experts.length) patch.expertResources = experts;

  const compliance = toStrList(raw.compliance_words);
  if (compliance.length) patch.complianceWords = compliance;

  const insights = toStrList(a.insights ?? raw.industry_insights);
  if (insights.length) patch.marketingStrategy = insights.join('\n');

  return patch;
}

export default {
  isPlaceholderText,
  stripUncertain,
  toStrList,
  groupFacts,
  normalizeAnalysis,
  buildCompanyQuery,
  buildCompanySearchPrompt,
  analyzeCompanyGrounded,
  sourceUrls,
  analyzeCompany,
  buildRecommendPayload,
  analysisToAsset,
  assetToAnalyzeInput,
  assetToRecommendPayload,
  // 0.21.14 · 老板需求 4（同名企业消歧 + 一键全量建档）
  buildCompanyEntityQuery,
  buildCompanyEntityPrompt,
  normalizeEntityCandidate,
  parseEntityCandidates,
  deriveCandidatesFromResults,
  findCompanyEntities,
  ASSET_COVERAGE_FIELDS,
  isAssetFieldFilled,
  buildAssetCoverage,
  analysisToFullAsset,
};
