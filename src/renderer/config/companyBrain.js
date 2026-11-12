/**
 * 🧠 公司画像中枢（Company Brain Hub）—— brain 数据结构的唯一权威定义。
 *
 * 背景：用户在首次建档 / 添加企业时做「一次深度思考」，AI 产出结构化 brain 持久化，
 *       后续 GEO / 竞品分析 / 平台账号矩阵 / 活动策划只读不重算，消除重复劳动。
 *
 * 铁律（防字段漂移，同活动重构的教训）：
 *   1. brain 的所有字段名以本文件为准，消费方不得手写 key，统一走 normalizeBrain。
 *   2. 竞品 / 账号 / 洞察每条必须带 reason/why + 来源分级 source（web=联网检索 /
 *      industry=行业经验假设 / user=用户已填），无依据宁缺毋滥。
 *   3. 独立存储 key：douya-company-brain（不并入 douya-company-knowledge 四类知识）。
 */

/** brain 持久化 key（按 companyId 隔离：{ [companyId]: brain }）。 */
export const BRAIN_KEY = 'douya-company-brain';

/** brain 状态。 */
export const BRAIN_STATUS = {
  NONE: 'none', // 从未深度思考
  RUNNING: 'running', // 思考中（前端可展示 loading）
  READY: 'ready', // 成功
  DEGRADED: 'degraded', // 降级（部分产出，如联网失败只给了行业经验）
};

/** 商业模式。 */
export const BUSINESS_MODEL = {
  B2B: 'b2b',
  B2C: 'b2c',
  UNKNOWN: 'unknown',
};

/** 竞品类型。 */
export const COMPETITOR_TYPES = {
  DIRECT: 'direct', // 直接竞品
  SUBSTITUTE: 'substitute', // 替代品
  CROSS: 'cross', // 跨界/潜在竞品
};

/** 来源分级（真实性铁律）。 */
export const SOURCE_LEVELS = {
  WEB: 'web', // 联网检索到的事实
  INDUSTRY: 'industry', // 行业经验（假设，需标注）
  USER: 'user', // 用户已填
};

/** 平台账号建议优先级。 */
export const PRIORITY_LEVELS = {
  HIGH: 'high',
  MID: 'mid',
  LOW: 'low',
};

/** 平台 key（与 platformOnboardingCatalog.js 的 PLATFORM_ONBOARDING[].id 对齐）。 */
export const PLATFORM_KEYS = [
  'meituan', // 美团
  'douyin', // 抖音
  'kuaishou', // 快手
  'amap', // 高德
  'tencentmap', // 腾讯地图
  'shipinhao', // 视频号
  'xiaohongshu', // 小红书
];

/**
 * 返回一个空的 brain 对象（结构权威，字段不可增删）。
 * @returns {object}
 */
export function emptyBrain() {
  return {
    generatedAt: 0,
    status: BRAIN_STATUS.NONE,
    degraded: false,
    // —— 画像增强 ——
    businessModel: BUSINESS_MODEL.UNKNOWN,
    brandTone: '',
    customerSegments: [], // [{ name, pain, decisionChain }]
    // —— 竞品推荐（解决「每次手选」）——
    competitors: [], // [{ name, type, reason, source }]
    // —— 平台账号建议（解决「建议建什么账号」）——
    platformAccounts: [], // [{ platformKey, should, why, priority }]
    // —— 运营洞察 + 活动建议（解决「AI 比用户更懂运营」）——
    operatingInsights: [], // [{ title, why, expect }]
    activitySuggestions: [], // [{ subject, goalKey, templateKey, why }]
    // —— 内容 + 策略 ——
    contentAngles: [], // string[]
    marketingStrategy: '',
  };
}

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asArr(v) {
  return Array.isArray(v) ? v : [];
}

function normSegment(s) {
  if (!s || typeof s !== 'object') return null;
  const name = asStr(s.name).trim();
  if (!name) return null;
  return { name, pain: asStr(s.pain).trim(), decisionChain: asStr(s.decisionChain).trim() };
}

function normCompetitor(c) {
  if (!c || typeof c !== 'object') return null;
  const name = asStr(c.name).trim();
  if (!name) return null;
  const type = Object.values(COMPETITOR_TYPES).includes(c.type) ? c.type : COMPETITOR_TYPES.DIRECT;
  const source = Object.values(SOURCE_LEVELS).includes(c.source) ? c.source : SOURCE_LEVELS.INDUSTRY;
  return { name, type, reason: asStr(c.reason).trim(), source };
}

function normPlatformAccount(p) {
  if (!p || typeof p !== 'object') return null;
  const platformKey = asStr(p.platformKey).trim();
  if (!platformKey) return null;
  const priority = Object.values(PRIORITY_LEVELS).includes(p.priority)
    ? p.priority
    : PRIORITY_LEVELS.MID;
  return {
    platformKey,
    should: p.should !== false, // 默认 true（建议创建）
    why: asStr(p.why).trim(),
    priority,
  };
}

function normInsight(i) {
  if (!i || typeof i !== 'object') return null;
  const title = asStr(i.title).trim();
  if (!title) return null;
  return { title, why: asStr(i.why).trim(), expect: asStr(i.expect).trim() };
}

function normActivitySuggestion(s) {
  if (!s || typeof s !== 'object') return null;
  const subject = asStr(s.subject).trim();
  if (!subject) return null;
  return {
    subject,
    goalKey: asStr(s.goalKey).trim(),
    templateKey: asStr(s.templateKey).trim(),
    why: asStr(s.why).trim(),
  };
}

/**
 * 归一化 brain（脏数据自然被过滤，字段名以本文件为准）。
 * @param {object|null} raw 任意来源的 brain
 * @returns {object} 结构完整的 brain（缺失字段回退空值）
 */
export function normalizeBrain(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const e = emptyBrain();
  return {
    generatedAt: typeof base.generatedAt === 'number' ? base.generatedAt : 0,
    status: Object.values(BRAIN_STATUS).includes(base.status) ? base.status : e.status,
    degraded: base.degraded === true,
    businessModel: Object.values(BUSINESS_MODEL).includes(base.businessModel)
      ? base.businessModel
      : e.businessModel,
    brandTone: asStr(base.brandTone).trim(),
    customerSegments: asArr(base.customerSegments).map(normSegment).filter(Boolean),
    competitors: asArr(base.competitors).map(normCompetitor).filter(Boolean),
    platformAccounts: asArr(base.platformAccounts).map(normPlatformAccount).filter(Boolean),
    operatingInsights: asArr(base.operatingInsights).map(normInsight).filter(Boolean),
    activitySuggestions: asArr(base.activitySuggestions).map(normActivitySuggestion).filter(Boolean),
    contentAngles: asArr(base.contentAngles).map((x) => asStr(x).trim()).filter(Boolean),
    marketingStrategy: asStr(base.marketingStrategy).trim(),
  };
}

/**
 * 判断 brain 是否有有效内容（是否已完成过一次深度思考）。
 * @param {object|null} brain 已归一化 brain
 * @returns {boolean}
 */
export function hasBrain(brain) {
  const b = normalizeBrain(brain);
  return (
    b.status === BRAIN_STATUS.READY ||
    b.status === BRAIN_STATUS.DEGRADED ||
    !!b.marketingStrategy ||
    b.competitors.length > 0 ||
    b.platformAccounts.length > 0 ||
    b.operatingInsights.length > 0 ||
    b.activitySuggestions.length > 0 ||
    b.contentAngles.length > 0
  );
}

/**
 * 竞品 → 营销资产 competitors 的扁平化（CompetitorAnalysis 读 asset.competitors）。
 * 每条保留 reason 供 UI 展示推荐理由，但资产字段只存竞品名（保持资产 schema 不变）。
 * @param {object|null} brain 已归一化 brain
 * @returns {string[]} 竞品名数组
 */
export function competitorsToAsset(brain) {
  const b = normalizeBrain(brain);
  return b.competitors.map((c) => c.name);
}

/**
 * 竞品推荐理由映射表：name → reason（供 CompetitorAnalysis 空态展示「AI 为什么推荐」）。
 * @param {object|null} brain 已归一化 brain
 * @returns {Record<string, string>}
 */
export function competitorReasons(brain) {
  const b = normalizeBrain(brain);
  const map = {};
  for (const c of b.competitors) map[c.name] = c.reason;
  return map;
}

export default {
  BRAIN_KEY,
  BRAIN_STATUS,
  BUSINESS_MODEL,
  COMPETITOR_TYPES,
  SOURCE_LEVELS,
  PRIORITY_LEVELS,
  PLATFORM_KEYS,
  emptyBrain,
  normalizeBrain,
  hasBrain,
  competitorsToAsset,
  competitorReasons,
};
