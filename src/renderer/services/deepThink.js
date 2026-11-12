/**
 * deepThink —— 公司画像中枢（Company Brain Hub）的「深度思考」编排服务。
 *
 * 职责：用户首次建档 / 添加企业时做一次「深度思考」，产出结构化 brain 持久化，
 *       后续 GEO / 竞品分析 / 平台账号矩阵 / 活动策划只读不重算，消除重复劳动。
 *
 * 流程（按序）：
 *   1. analyzeCompany(geoProxy, assetToAnalyzeInput(asset)) 拿联网画像（profile）；
 *   2. inferCompanyType(asset, company) 推断 businessModel（b2b/b2c/unknown）；
 *   3. groundedSearch（真检索：Tavily/bocha provider 链）拿网页资料 → 只对资料支撑到的竞品标 'web'；
 *      检索不到不冒称联网，降级为 'industry'（行业经验假设 · 未联网核实），宁缺毋滥；
 *   4. chatOnce 内网模型推导运营洞察 / 活动建议 / 平台账号 / 内容角度 / 营销策略；
 *   5. 组装 brain 并 normalizeBrain 返回。
 *
 * ⚠️ 真实性铁律（写进代码，UI 展示必须遵守）：
 *   - 竞品的 source 必须由**本次真检索的直接证据**决定：真拿到网页资料才可标 'web'；
 *     没拿到资料一律标 'industry'（行业经验假设 · 未联网核实），绝不用网关的联网开关参数冒充联网。
 *   - 洞察 / 活动 / 账号建议是「行业经验（假设）」，UI 展示时要标「AI 建议，需运营审核」。
 *
 * brain 字段唯一权威：src/renderer/config/companyBrain.js（本文件不重定义字段）。
 */

import { chatOnce as apiChatOnce, geoProxy as apiGeoProxy } from '../api.js';
import {
  BRAIN_STATUS,
  BUSINESS_MODEL,
  COMPETITOR_TYPES,
  PLATFORM_KEYS,
  SOURCE_LEVELS,
  emptyBrain,
  normalizeBrain,
} from '../config/companyBrain.js';
import {
  analyzeCompany,
  assetToAnalyzeInput,
} from './companyProfile.js';
import { inferCompanyType } from './geoExposure.js';
import { extractJSON } from './projectAI.js';
import { buildAIContext } from './contextBuilder.js';
import { groundedSearch, groundedHealth } from './groundedWebSearch.js';
// 2026-09-21：竞品候选的上游护栏 —— 自家品牌 / 旗下 IP 绝不能被当成竞品候选
// （它们会经「一键采用全部」写进 asset.competitors，成为对比矩阵的一行）。
import { collectSelfBrandNames, excludeSelfBrands, selfBrandPromptLines } from './selfBrandGuard.js';

/**
 * 四主体 key（活动建议 subject 的唯一合法取值，与 companyStore.COMPANY_TYPES 对齐）。
 * 红线：manufacturer/clinic/doctor/platform 四值，brain 层不得混用其它值。
 */
const SUBJECT_KEYS = ['manufacturer', 'clinic', 'doctor', 'platform'];

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function asArr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * 企业简报：把 asset + profile + company 组装成给 AI 看的中文描述，供各步 Prompt 复用。
 * @param {object} p { company, asset, profile, businessModel }
 * @returns {string[]}
 */
function buildCompanyBrief({ company, asset, profile, businessModel }) {
  const a = asset || {};
  const c = company || {};
  const p = profile || {};
  const modelLabel =
    businessModel === 'b2b' ? '企业/机构客户（B2B）' : businessModel === 'b2c' ? '个人消费者（B2C）' : '未明确（需先判断客户是机构还是个人）';
  const lines = [];
  lines.push('公司名称：' + (asStr(a.companyName) || asStr(c.name) || '（未提供）'));
  if (asStr(a.industry)) lines.push('所属行业：' + asStr(a.industry));
  const brief = asStr(a.profile) || asStr(p.summary) || asStr(a.brandDesc) || '';
  if (brief) lines.push('品牌/企业简介：' + brief);
  if (asStr(a.products)) lines.push('产品/服务：' + asStr(a.products));
  const selling = asArr(a.coreSellingPoints).concat(asArr(p.coreKeywords));
  if (selling.length) lines.push('核心卖点/关键词：' + [...new Set(selling.map(asStr).filter(Boolean))].join('、'));
  const customers = asArr(a.targetCustomers).concat(asArr(p.audience));
  if (customers.length) lines.push('目标客户：' + [...new Set(customers.map(asStr).filter(Boolean))].join('、'));
  const facts = asArr(a.brandFacts).concat(asArr(p.brandFacts));
  if (facts.length) lines.push('已确认事实：' + [...new Set(facts.map(asStr).filter(Boolean))].join('、'));
  lines.push('客户类型：' + modelLabel);
  if (c.type) lines.push('企业主体类型：' + asStr(c.type));
  return lines;
}

/**
 * 构造「竞品发现」检索词：公司名 + 行业 + 产品 + 画像摘要（精炼，避免长 prompt 被检索端
 * 截断成 200 字检索词 —— 与 groundedWebSearch 各调用点同一护栏）。
 * @param {object} p { company, asset, profile }
 * @returns {string}
 */
function buildCompetitorDiscoverQuery({ company, asset, profile }) {
  const a = asset || {};
  const c = company || {};
  const p = profile || {};
  const name = asStr(a.companyName) || asStr(c.name);
  const industry = asStr(a.industry);
  const products = asStr(a.products);
  const summary = asStr(p.summary).slice(0, 40);
  return [name, industry, products, summary, '竞品 主要企业 同行 品牌'].filter(Boolean).join(' ');
}

/**
 * 步骤 3：真检索找竞品。真实铁律——source 由本次检索的直接证据决定：
 *   真拿到网页资料 → 'web'；没拿到 → 'industry'（行业经验假设 · 未联网核实）。绝不硬盖章 'web'。
 *
 * 2026-09-21 缺陷修复（老板实测：「上游货源是康健苗苗下面的 上面都说了 还会把上游货源做成竞品」）：
 *   本步骤是**竞品名单的上游生产者** —— 它产出的候选会被「一键采用全部」写进 asset.competitors
 *   （CompetitorAnalysis.jsx adoptAllAi），再变成对比矩阵的一行。
 *   此前它的检索词是「… 竞品 主要企业 同行 品牌」、约束里只说「必须是资料里出现的」，
 *   **没有排除本企业自己的品牌** ⇒ 检索命中的自家矩阵页（康健苗苗官网里的上游货源）会把子品牌
 *   变成候选竞品，一路污染到矩阵。
 *   现补：① prompt 明确排除自有品牌；② 候选落库前 excludeSelfBrands 硬剔（留痕在 degraded 提示里不算，
 *   剔了谁由返回值 selfBrandDropped 带到调用方可观测）。
 *
 * @param {object} p { company, asset, profile, businessModel, ctx, chatFn, fetchFn, selfBrands }
 * @returns {Promise<{competitors:Array, failed:boolean, degraded:boolean, selfBrandDropped:string[]}>}
 */
async function thinkCompetitors({ company, asset, profile, businessModel, ctx, chatFn, fetchFn, selfBrands = [] }) {
  const brief = buildCompanyBrief({ company, asset, profile, businessModel });
  const briefLines = brief.map((l) => '- ' + l);
  // 自有品牌排除段（无自有品牌登记时为空数组 = 与改动前逐字一致）
  const selfLines = selfBrandPromptLines(selfBrands);
  const jsonContract = [
    '【输出 JSON 结构】',
    '{ "competitors": [ { "name": "竞品名", "type": "direct|substitute|cross", "reason": "推荐理由" } ] }',
    '只返回一个 JSON 对象，不要 markdown 围栏、不要任何解释文字。',
  ];

  // 变体 A：交给 groundedSearch 作为「问题」；buildGroundedPrompt 会在其前注入检索原文
  //   并附「只依据上述资料作答」，故这里只写问题与约束，不重复「只依据资料」指令。
  const questionGrounded = [
    '你是口腔医疗行业的情报分析师。请只为下面这家企业列出「真实存在的竞品候选」。',
    '',
    '【企业信息】',
    ...briefLines,
    ...(selfLines.length ? ['', ...selfLines] : []),
    '',
    '【约束】',
    '1. 竞品必须是**上面资料里明确出现**的企业/品牌/平台；资料里没出现的名称一律不要写。',
    '2. 资料里没有任何可认定为竞品的名称，就返回空数组，绝不凭记忆编造竞品名。',
    '3. type 只能取：direct（直接竞品）/ substitute（替代品）/ cross（跨界/潜在竞品）。',
    '4. reason 用 1-2 句写清楚「为什么它是这家企业的竞品」，只依据资料，不写疗效/排名/无依据数据。',
    '5. 不要输出 source 字段（来源由系统按检索证据统一标注，你不必也不得自报「联网可查」）。',
    ...(selfLines.length
      ? ['6. 「本企业自有品牌 / 旗下 IP」里列出的名字**一个都不许**出现在 competitors 里 —— 它们是本企业自己的门面，不是外部对手。']
      : []),
    ...jsonContract,
  ].join('\n');

  // 变体 B：真检索没拿到资料时的降级问题；不再声称任何联网，只求行业经验候选，
  //   由系统统一标 industry（未联网核实）。
  const questionFallback = [
    '你是口腔医疗行业的情报分析师。**你没有拿到实时联网资料**，请基于行业经验，为下面这家企业列出「可能的竞品候选」。',
    '',
    '【企业信息】',
    ...briefLines,
    ...(selfLines.length ? ['', ...selfLines] : []),
    '',
    '【约束】',
    '1. 只列口腔行业里真实存在、可被称为竞品的品牌/企业；不确定就不要写。',
    '2. type 只能取：direct / substitute / cross。',
    '3. reason 用 1-2 句写清判断依据（这是行业经验推测，不是联网核实结果）。',
    '4. 不要输出 source 字段（来源由系统统一标注为「未联网核实」）。',
    ...(selfLines.length
      ? ['5. 「本企业自有品牌 / 旗下 IP」里列出的名字**一个都不许**出现在 competitors 里。']
      : []),
    ...jsonContract,
  ].join('\n');

  // ---- 1) 真检索优先：先拿真网页资料；只有拿到资料，后面的候选才允许标「联网可查」----
  const query = buildCompetitorDiscoverQuery({ company, asset, profile });
  let res = null;
  try {
    res = await groundedSearch(questionGrounded, {
      query,
      context: ctx,
      temperature: 0.3,
      fetchFn,   // 未注入时由 groundedSearch 默认走 fetchWebSearch（真检索）
      chatFn,    // 复用同一补全函数；单测可注入全假实现
    });
  } catch {
    res = null;
  }
  const health = groundedHealth(res || { ok: false, results: [] });
  const grounded = health.available === true; // 真拿到 ≥1 条网页资料
  // groundedSearch 已把模型输出解析成 res.data，直接用，无需再 extractJSON(res.content)。
  let raw = res && res.data && Array.isArray(res.data.competitors) ? res.data.competitors : [];

  // ---- 2) 检索没拿到资料：走降级问题（questionFallback）拿行业经验候选，
  //         后面统一标 industry（未联网核实），不许标 web ----
  if (!grounded) {
    let fb = null;
    try {
      fb = await chatFn([{ role: 'user', content: questionFallback }], ctx, {
        temperature: 0.3,
        reasoningEffort: 'none', // 注意：不带联网开关参数（网关本就忽略，写了反而是自欺）
      });
    } catch {
      fb = null;
    }
    if (fb && fb.ok === true && fb.content) {
      const parsed = extractJSON(fb.content);
      raw = parsed && Array.isArray(parsed.competitors) ? parsed.competitors : [];
    } else {
      raw = [];
    }
  }
  // 来源由**本次检索的直接证据**决定，不由模型自报、不硬覆写。
  const source = grounded ? SOURCE_LEVELS.WEB : SOURCE_LEVELS.INDUSTRY;
  const seen = new Set();
  const normalized = raw
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const name = asStr(c.name);
      if (!name) return null;
      const type = Object.values(COMPETITOR_TYPES).includes(c.type) ? c.type : COMPETITOR_TYPES.DIRECT;
      const reason = asStr(c.reason);
      return {
        name,
        type,
        // 未联网核实时，reason 必须带可辨识前缀，让「这不是联网可查」在条目上就看得见
        //（不只靠来源角标）。
        reason: grounded
          ? reason
          : '未联网核实，以下为模型行业经验推断：' + (reason || '（模型未给出理由）'),
        source,
      };
    })
    .filter(Boolean)
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));

  // 2026-09-21：硬剔自家品牌 / 旗下 IP（prompt 已排除，这里再兜一道 —— 上游一旦污染，
  // 会经「一键采用全部」写进 asset.competitors 并成为对比矩阵的一行，代价由老板承担）。
  const { kept: competitors, dropped: selfBrandDropped } = excludeSelfBrands(normalized, selfBrands);

  // 检索失败 / 0 条：如实标未联网（source=industry）并让 brain 走 degraded。
  return { competitors, failed: false, degraded: !grounded, selfBrandDropped: selfBrandDropped.map((d) => d.name) };
}

/**
 * 步骤 4：内网模型推导运营洞察 / 活动建议 / 平台账号 / 内容角度 / 营销策略。
 * 这些是「行业经验（假设）」，UI 展示时必须标「AI 建议，需运营审核」。
 * @param {object} p { company, asset, profile, businessModel, ctx, chatFn }
 * @returns {Promise<{ok:boolean, failed:boolean, data:object}>}
 */
async function thinkInsights({ company, asset, profile, businessModel, ctx, chatFn }) {
  const brief = buildCompanyBrief({ company, asset, profile, businessModel });
  const prompt = [
    '你是口腔医疗行业的营销运营专家。基于下面这家企业的资料，做一次「运营策略深度思考」，产出结构化建议。',
    '',
    '【企业信息】',
    ...brief.map((l) => '- ' + l),
    '',
    '【绝对约束】',
    '1. activitySuggestions 的 subject 只能取这四值之一：manufacturer（口腔厂家）/ clinic（口腔门诊）/ doctor（口腔医生）/ platform（口腔平台）。',
    '2. platformAccounts 的 platformKey 只能从以下取值：' + PLATFORM_KEYS.join('/') + '；should=false 表示「不建议建」；每条必须带 why 与 priority（high/mid/low）。',
    '3. operatingInsights / activitySuggestions / platformAccounts 每条必须带 why（理由）。',
    '4. 这些产出都是「行业经验（假设）」，基于通用行业规律推导即可，严禁编造具体数据、疗效、排名、粉丝数等。',
    '5. 只返回一个 JSON 对象，不要 markdown 围栏、不要任何解释文字。',
    '',
    '【输出 JSON 结构】',
    '{',
    '  "operatingInsights": [ { "title": "洞察标题", "why": "为什么", "expect": "预期效果" } ],',
    '  "activitySuggestions": [ { "subject": "manufacturer|clinic|doctor|platform", "goalKey": "营销目标ID", "templateKey": "活动模板ID", "why": "为什么" } ],',
    '  "platformAccounts": [ { "platformKey": "meituan|douyin|...", "should": true, "why": "为什么", "priority": "high|mid|low" } ],',
    '  "contentAngles": [ "内容角度1", "内容角度2" ],',
    '  "marketingStrategy": "一段营销策略概述",',
    '  "brandTone": "品牌调性一句话",',
    '  "customerSegments": [ { "name": "人群名称", "pain": "痛点", "decisionChain": "决策链" } ]',
    '}',
  ].join('\n');

  let res = null;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, { temperature: 0.5 });
  } catch {
    res = null;
  }
  if (!res || res.ok !== true || !res.content) {
    return { ok: false, failed: true, data: {} };
  }
  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, failed: true, data: {} };
  }
  return { ok: true, failed: false, data: parsed };
}

/** 平台账号白名单过滤（红线：platformKey 只能取 PLATFORM_KEYS）+ 去重。 */
function whitelistAccounts(arr) {
  const seen = new Set();
  return asArr(arr)
    .filter((p) => p && typeof p === 'object' && PLATFORM_KEYS.includes(asStr(p.platformKey)))
    .filter((p) => (seen.has(asStr(p.platformKey)) ? false : (seen.add(asStr(p.platformKey)), true)));
}

/** 活动建议 subject 白名单过滤（红线：只能取四主体）+ 去重。 */
function whitelistSuggestions(arr) {
  return asArr(arr)
    .filter((s) => s && typeof s === 'object' && SUBJECT_KEYS.includes(asStr(s.subject)))
    .filter((s) => asStr(s.why)); // 红线：每条必须带 why
}

/**
 * 深度思考主入口：产出归一化 brain。
 * @param {object} params
 * @param {object} params.company Company 对象（id/name/type/role，见 companyStore）
 * @param {object} params.asset 营销资产（marketingStore 的 asset）
 * @param {object} [params.knowledge] 企业四类知识（companyKnowledgeStore 的 normalizeKnowledge 结果）
 * @param {(path:string, method?:string, body?:object)=>Promise<object>} [params.geoProxy] GEO 代理函数
 * @param {(messages:Array, context?:object, opts?:object)=>Promise<object>} [params.chatOnce] 补全函数
 * @param {Function} [params.fetchFn] 真检索实现（默认 fetchWebSearch；单测可注入假实现）
 * @returns {Promise<object>} 已 normalizeBrain 的 brain
 */
export async function runDeepThink({ company, asset, knowledge, geoProxy, chatOnce, fetchFn } = {}) {
  const proxyFn = typeof geoProxy === 'function' ? geoProxy : apiGeoProxy;
  const chatFn = typeof chatOnce === 'function' ? chatOnce : apiChatOnce;
  const now = Date.now();

  // 统一 AI 上下文（企业 + 资产 + 四类知识），供 chatOnce 注入 system 消息
  const ctx = buildAIContext({ company, asset, knowledge });

  // ===== 1) 联网画像 =====
  const input = assetToAnalyzeInput(asset);
  let ares = null;
  try {
    ares = await analyzeCompany(proxyFn, input);
  } catch {
    ares = null;
  }
  const profileOk = !!(ares && ares.ok && ares.profile);
  const profile = profileOk ? ares.profile : null;
  let degraded = !profileOk; // 画像失败即降级

  // ===== 2) businessModel（无需 AI，确定性推导）=====
  const inferredType = inferCompanyType(asset, company);
  const businessModel =
    inferredType === 'b2b'
      ? BUSINESS_MODEL.B2B
      : inferredType === 'b2c'
        ? BUSINESS_MODEL.B2C
        : BUSINESS_MODEL.UNKNOWN;

  // ===== 3) 真检索找竞品 =====
  const selfBrands = collectSelfBrandNames({ company, asset, knowledge });
  const compRes = await thinkCompetitors({ company, asset, profile, businessModel, ctx, chatFn, fetchFn, selfBrands });
  const competitors = compRes.competitors;
  // 检索失败或未拿到资料（降级为 industry）都算 degraded，如实标记。
  if (compRes.failed || compRes.degraded) degraded = true;

  // ===== 4) 内网模型推导洞察/活动/账号/内容/策略 =====
  const insRes = await thinkInsights({ company, asset, profile, businessModel, ctx, chatFn });
  if (insRes.failed) degraded = true;
  const d = insRes.data || {};

  // ===== 5) 组装 brain =====
  const brain = emptyBrain();
  brain.generatedAt = now;
  brain.degraded = degraded;
  brain.businessModel = businessModel;
  // 画像增强字段：brandTone 优先 AI 推导，回退 asset；customerSegments 为 AI 推导（画像摘要/事实/关键词/人群已在 asset/knowledge，brain 不重复存）
  brain.brandTone = asStr(d.brandTone) || asStr(asset && asset.brandTone);
  brain.customerSegments = asArr(d.customerSegments).filter((s) => s && asStr(s.name));
  brain.competitors = competitors;
  brain.platformAccounts = whitelistAccounts(d.platformAccounts);
  brain.operatingInsights = asArr(d.operatingInsights).filter((i) => i && asStr(i.title) && asStr(i.why));
  brain.activitySuggestions = whitelistSuggestions(d.activitySuggestions);
  brain.contentAngles = asArr(d.contentAngles).map(asStr).filter(Boolean);
  brain.marketingStrategy = asStr(d.marketingStrategy);

  // 全失败判定：画像失败且所有增强字段全空 → 返回空 brain + DEGRADED
  const hasEnhanced =
    brain.competitors.length > 0 ||
    brain.platformAccounts.length > 0 ||
    brain.operatingInsights.length > 0 ||
    brain.activitySuggestions.length > 0 ||
    brain.contentAngles.length > 0 ||
    brain.customerSegments.length > 0 ||
    !!brain.marketingStrategy ||
    !!brain.brandTone;
  if (!profileOk && !hasEnhanced) {
    const empty = emptyBrain();
    empty.generatedAt = now;
    empty.status = BRAIN_STATUS.DEGRADED;
    empty.degraded = true;
    return normalizeBrain(empty);
  }

  brain.status = degraded ? BRAIN_STATUS.DEGRADED : BRAIN_STATUS.READY;
  return normalizeBrain(brain);
}

/** 去重 running 状态（同一 companyId 未完成时不重复跑）。 */
const __running = new Set();
/** 进行中的 promise（并发调用复用同一结果）。 */
const __pending = new Map();

/**
 * 去重包装：同一 companyId 已在进行中时返回该 in-flight promise（不重复触发），
 * 完成后自动清空 running 状态。fn 应返回 Promise<brain>。
 * @param {string|number} companyId
 * @param {() => Promise<object>} fn 实际执行深度思考的函数
 * @returns {Promise<object|null>}
 */
export function deepThinkOnce(companyId, fn) {
  const cid = String(companyId || '');
  if (!cid) return Promise.resolve(emptyBrain());
  if (__pending.has(cid)) return __pending.get(cid);
  if (__running.has(cid)) return Promise.resolve(null);
  __running.add(cid);
  const p = Promise.resolve()
    .then(() => (typeof fn === 'function' ? fn() : Promise.resolve(emptyBrain())))
    .finally(() => {
      __running.delete(cid);
      __pending.delete(cid);
    });
  __pending.set(cid, p);
  return p;
}

export default { runDeepThink, deepThinkOnce };
