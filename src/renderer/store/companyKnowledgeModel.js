/**
 * companyKnowledgeModel —— 企业长期知识（四类）的**纯数据模型**：归一化 / 空态 / 旗下 IP 归一化。
 *
 * ── 为什么从 companyKnowledgeStore.jsx 里拆出来（2026-10-11 第 5 层）─────────────
 * 原先 `normalizeKnowledge` / `emptyKnowledge` / `KNOWLEDGE_KEY` 都定义在 **.jsx** 里。
 * 于是任何想「按同一口径归一化企业知识」的**纯 service**，一旦 import 它们，就会把
 * React 与 JSX 拖进依赖图 —— 实测在 Node 侧直接 `import` 会抛
 * `Unknown file extension ".jsx"`（本仓 directionRecommend / planGuidance 等单测就是 **Node 直跑**
 * 的，不走打包），于是「统一读取入口」只能被迫再写一份归一化逻辑（= 第二套口径，正是要消灭的东西）。
 *
 * 拆法：把**纯函数**搬到这里（无 React、无 JSX、无副作用），`companyKnowledgeStore.jsx`
 * 从本文件 import 并**原样 re-export**，对外 API 一个不少、调用方一行不改；
 * `services/companyContext.js`（统一读取入口）改为从本文件取归一化函数。
 * 全部依赖只指向纯 .js ⇒ `services/contextBuilder.js` 可以安全依赖读取入口。
 *
 * ⚠️ 本文件里的函数体是**逐字搬移**，不改行为：`emptyKnowledge()` 仍然**不含 `plan`**
 *   （只有 `timeline/goals/checkup`），因为 `plan` 是 `getKnowledge` 读取时才挂载的第五维。
 */

/** 四类知识的持久化 key（= companyKnowledgeStore.KNOWLEDGE_KEY，形如 { [companyId]: {...} }）。 */
export const KNOWLEDGE_KEY = 'douya-company-knowledge';

export function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function asArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

export function normalizeKnowledge(k) {
  const base = k && typeof k === 'object' ? k : {};
  const profile = base.profile && typeof base.profile === 'object' ? base.profile : {};
  return {
    profile: {
      // 透传所有字段（onboarding 自定义字段如 shortName/city/website/wechat 等），已知字段归一化覆盖
      ...profile,
      brandPositioning: asStr(profile.brandPositioning || profile.brandTone || profile.brand_positioning),
      industry: asStr(profile.industry),
      products: asStr(profile.products),
      summary: asStr(profile.summary || profile.profile),
      coreSellingPoints: asArray(profile.coreSellingPoints || profile.core_selling_points),
      targetCustomers: asArray(profile.targetCustomers || profile.target_customers),
      competitors: asArray(profile.competitors),
      brandIps: Array.isArray(profile.brandIps) ? profile.brandIps.map(normalizeBrandIp).filter((ip) => ip.name) : [],
      brandMainAliases: Array.isArray(profile.brandMainAliases)
        ? profile.brandMainAliases.map((x) => asStr(x).trim()).filter(Boolean)
        : [],
      // 品牌归属类型（老板第 2 条）：用户建档时区分「母公司(company) / 某一个品牌(brand)」。
      // 输入厂家名不代表它就是一个品牌 —— 有可能用户要监控的是厂家旗下的某个品牌，故需显式记录。
      // 归属某个品牌时另记其所属母公司（brandParent），供经营诊断对准监控对象。
      brandType: asStr(profile.brandType),
      brandParent: asStr(profile.brandParent),
    },
    facts: asArray(base.facts),
    rules: asArray(base.rules),
    memories: asArray(base.memories),
  };
}

/** 空知识（兜底）。 */
export function emptyKnowledge() {
  return { ...normalizeKnowledge({}), timeline: [], goals: [], checkup: null };
}

// ==================== 旗下 IP / 子品牌（brandIps）====================
// 客户往往是品牌矩阵（母公司 + 多个子品牌/产品线 IP），公关危机必须逐个 IP 分别监控。
// 存在 profile.brandIps（profile 透传未知字段，故不需要动 companyStore 的白名单重建）。

/** 生成新 IP 的 id（不引入 uuid 依赖，够用即可）。 */
function newBrandIpId() {
  return `ip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 归一化单个「旗下 IP / 子品牌」。幂等：对已归一化对象再调用结果稳定（除 id 缺失时补新 id）。
 * @param {object|string} raw 原始值；字符串视为只有名称
 * @returns {{id:string, name:string, aliases:string[], note:string, enabled:boolean, createdAt:number}}
 */
export function normalizeBrandIp(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const name = typeof raw === 'string' ? raw : asStr(src.name);
  const rawAliases = src.aliases;
  const aliases = [];
  const pushAlias = (v) => {
    const s = asStr(v).trim();
    if (s && !aliases.includes(s)) aliases.push(s);
  };
  if (Array.isArray(rawAliases)) rawAliases.forEach(pushAlias);
  else if (typeof rawAliases === 'string') rawAliases.split(/[,，、;；\s]+/).forEach(pushAlias);

  const createdAt = Number(src.createdAt) > 0 ? Number(src.createdAt) : Date.now();
  return {
    id: asStr(src.id).trim() || newBrandIpId(),
    name: name.trim(),
    aliases,
    note: asStr(src.note).trim(),
    enabled: src.enabled !== false,
    createdAt,
  };
}
