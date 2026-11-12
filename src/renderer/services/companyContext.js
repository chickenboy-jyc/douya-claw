/**
 * companyContext —— 统一「公司资料读取入口」（纯函数，只读，无 React）。
 *
 * ── 为什么需要它（2026-10-11 第 5 层「公司上下文贯通任务」）────────────────────
 * 现状：企业长期知识的**唯一读入口**是 `useCompanyKnowledge().getKnowledge(cid)` ——
 * 它是一个 **React Hook 里的回调**，只有组件能调。于是纯 service / 能力层 / 未来 Agent
 * 拿不到公司资料，只能由调用方把 `company / asset / knowledge` 三个对象**逐个手工传进**
 * `buildAIContext`。实测各调用点传的段数并不一致（有的只传 knowledge、有的不传 asset/project），
 * 同一家公司因此在不同模块被"理解"成不同的样子 —— 这正是「每个模块各自理解一次」的结构性根因。
 *
 * 本文件把「读哪几个键、按什么口径归一化、每条信息可信到什么程度」收敛成**一个纯函数**，
 * 供非组件代码复用。**不新建数据库**：读取源全部是既有 store 的既有持久化键。
 *
 * ── 读取源与归属（唯一真源，本文件只读不写）──────────────────────────────────
 *   douya-companies / douya-current-company → store/companyStore（公司主数据 + 当前企业 id）
 *   douya-marketing-assets                  → store/marketingStore（营销资产）
 *       ⚠️ 另有 store/assetStore 的 `douya-assets`，那是「内容资产/素材」计数用的**另一份**，
 *          两者概念不同、键不同，不要互相替代（本文件只读前者，与 App.jsx 的 `asset` 同源）。
 *   douya-company-knowledge                 → store/companyKnowledgeStore（profile/facts/rules/memories）
 *   douya-company-brain                     → config/companyBrain（公司画像中枢，自带来源分级）
 *   douya-company-checkup                   → services/companyCheckup（企业体检结论，**AI 假设层**）
 *   douya-promo-calendar                    → services/promoCalendar（活动档期/促销日历，第 5 层第 4 步）
 *       ⚠️ 该键**没有记录时**会回落到 `data/promoCalendarSeed`（老板提供的截图录入档期），
 *          且只对 PROMO_SEED_ALIASES 命中的企业生效 —— store 有记录则种子不参与。
 *
 * ── 三级来源分级（第 5 层硬要求：信息进了上下文 ≠ 自动变成事实）────────────────
 *   confirmed   已确认事实   —— 用户自己填写/确认过的（档案、企业事实、品牌规则、长期记忆、营销资产）
 *   public      公开来源整理 —— 有出处的公开检索结果，且**联网状态已确证**（探针 available === true）
 *   unconfirmed 尚未确认     —— AI 推断 / 行业经验假设 / 体检结论 / 联网状态未确证的 web 结果
 * 判据与 contextBuilder 的 `brainSourceLabel` **逐字同口径**：未确证联网时绝不写「联网检索」。
 *
 * ── ⚠️ 与 store 的时序差异（诚实边界）─────────────────────────────────────────
 * 本文件从 **localStorage** 读，读到的是**上一次已落盘**的值。
 * 会话内刚编辑、尚未落盘的内容请走 React 侧 `getKnowledge()`（它读内存 map，见
 * companyKnowledgeStore.jsx:395 注释「保证当次会话内即时读到最新回流数据」）。
 * 两者**归一化口径相同**（本文件直接复用 store 的 `normalizeKnowledge`），**时序不同**。
 */

// ⚠️ 归一化函数从**纯模型文件**取，不从 `store/companyKnowledgeStore.jsx` 取 ——
//    后者是 React 文件，一旦 import 进来，本文件在 Node 侧就直接 `Unknown file extension ".jsx"`，
//    于是 `services/contextBuilder.js`（本仓有单测走 Node 直跑）也不能安全依赖它。
//    模型文件与 store **同一份实现**（store 只是 import 后 re-export），口径不会分叉。
import { KNOWLEDGE_KEY, normalizeKnowledge, emptyKnowledge } from '../store/companyKnowledgeModel.js';
import { BRAIN_KEY, normalizeBrain, hasBrain, SOURCE_LEVELS } from '../config/companyBrain.js';
import { getCachedWebSearchHealth } from './webSearchHealth.js';
// 三维「外部数据源」在 getKnowledge 里是**读取时挂载**的（见 companyKnowledgeStore.jsx:434-437），
// 本文件必须挂同一套，否则分级表里声明了 timeline/goals/plan 却读到空 ⇒ 表在说谎。
import { loadTimeline } from './companyTimeline.js';
import { loadGoals } from './companyGoal.js';
import { loadPlanNodes } from './planBrief.js';
// 第九维「活动档期（促销日历）」——与上三者同为「外部数据源，读取时挂载」。
// 依赖方向 companyContext → promoCalendar（单向）；promoCalendar **不**反向依赖本文件，无环。
import { loadPromoRecords } from './promoCalendar.js';

/** 公司主数据键（= companyStore.COMPANIES_KEY / CURRENT_COMPANY_KEY）。 */
const COMPANIES_KEY = 'douya-companies';
/** 当前企业 id（= companyStore.CURRENT_COMPANY_KEY；值是 JSON 序列化的 **id 字符串**）。 */
const CURRENT_COMPANY_KEY = 'douya-current-company';
/** 营销资产（= marketingStore.ASSETS_MAP_KEY，形如 { [companyId]: asset }）。 */
const ASSETS_MAP_KEY = 'douya-marketing-assets';
/** 企业体检结论（= companyCheckup / checkupBrief 的 CHECKUP_KEY，**不进四类知识**）。 */
const CHECKUP_KEY = 'douya-company-checkup';

/** 三级来源分级。 */
export const SOURCE_TIER = {
  CONFIRMED: 'confirmed',
  PUBLIC: 'public',
  UNCONFIRMED: 'unconfirmed',
};

/** 分级 → 中文抬头（给 prompt / UI 用；未确认级必须带劝告，不能只写"未确认"三个字）。 */
export const TIER_LABEL = {
  confirmed: '已确认事实',
  public: '公开来源整理',
  unconfirmed: '尚未确认（AI 推断/行业假设，勿当事实）',
};

/**
 * 字段 → 分级。**静态归属表**：某个数据来自哪个键，就只可能是那一级，
 * 不允许"因为进了上下文就升格"。
 * 动态分级的只有 brain（逐条按 item.source 走 `gradeSource`）与 checkup。
 */
const FIELD_TIER = {
  company: SOURCE_TIER.CONFIRMED,       // 公司主数据：用户建档时填的
  asset: SOURCE_TIER.CONFIRMED,         // 营销资产：用户确认过的
  profile: SOURCE_TIER.CONFIRMED,       // 企业档案（品牌定位/产品/卖点/客户/竞品）
  facts: SOURCE_TIER.CONFIRMED,         // 企业事实
  rules: SOURCE_TIER.CONFIRMED,         // 品牌规则/禁区
  memories: SOURCE_TIER.CONFIRMED,      // 企业长期记忆
  timeline: SOURCE_TIER.CONFIRMED,      // 档案时间轴（真实发生过的事实）
  goals: SOURCE_TIER.CONFIRMED,         // 企业目标（用户设定）
  plan: SOURCE_TIER.CONFIRMED,          // 已排方案（豆芽排、用户可见的日历节点）
  promos: SOURCE_TIER.CONFIRMED,        // 活动档期（已录入的促销日历：日期是业务方给的事实）
  brain: SOURCE_TIER.UNCONFIRMED,       // 画像中枢：逐条另判，缺 source 一律不升级
  checkup: SOURCE_TIER.UNCONFIRMED,     // 体检结论：AI 假设层
};

/**
 * 字段槽位 → 中文名。**给模型和用户看**的那一套（`describePresentTiers` 用）。
 * 为什么不让模型读英文槽位键（company / asset / profile …）：那是**内部记账用的名字**，
 * 拼进 prompt 对模型是噪声，也让人看不懂「已确认事实：profile、facts」到底指什么。
 * 判定逻辑（谁属于哪一级）不在这里 —— 那仍然只有 `gradeFields` 一份实现。
 */
const FIELD_CN = {
  company: '企业主数据',
  asset: '营销资产',
  profile: '企业档案',
  facts: '企业事实',
  rules: '品牌规则/禁区',
  memories: '企业长期记忆',
  timeline: '档案时间轴',
  goals: '企业目标',
  plan: '已排方案',
  promos: '活动档期',
  brain: '画像中枢',
  checkup: '体检结论',
};

/** 读 localStorage JSON（容错：非浏览器 / 被禁用 / 解析失败一律回退）。 */
function readJSON(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** 非空数组才算有（与 contextBuilder.pickList 同口径：空数组视为无）。 */
function nonEmptyList(v) {
  return Array.isArray(v) && v.length > 0;
}

/**
 * 该值是否**实际有内容**（递归看对象里的每个值）。
 * 用来区分「槽位存在」与「这次真的有数据」——二者是分级抬头会不会撒谎的分水岭。
 * 空串 / 空数组 / 只含空值的对象一律算无；数字 0 与 false 算有（它们是被明确填过的值）。
 */
function hasContent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.some((x) => hasContent(x));
  if (typeof v === 'object') return Object.values(v).some((x) => hasContent(x));
  return true;
}

/**
 * 单条 brain 信息的来源分级。
 * 与 contextBuilder 的 `brainSourceLabel` 同口径：web 类事实**只有探针确证联网**才敢算「公开来源」。
 * @param {string} source brain 里该条的 source（user / industry / web）
 * @param {object|null} [health] 联网探针缓存（可注入，便于单测；缺省读 live 缓存）
 * @returns {string} SOURCE_TIER 之一
 */
export function gradeSource(source, health) {
  if (source === SOURCE_LEVELS.USER) return SOURCE_TIER.CONFIRMED;
  if (source === SOURCE_LEVELS.WEB) {
    const h = health === undefined ? getCachedWebSearchHealth() : health;
    // 未确证联网 ⇒ 只能是 unconfirmed。**绝不因为"字段名叫 web"就升格成公开来源。**
    return h && h.available === true ? SOURCE_TIER.PUBLIC : SOURCE_TIER.UNCONFIRMED;
  }
  // industry / 未知 / 缺失 ⇒ 未确认
  return SOURCE_TIER.UNCONFIRMED;
}

/**
 * 字段槽位 → 分级结果。**全仓唯一实现**：`readCompanyContext`（读盘口径）与
 * `describePresentTiers`（送模型口径）都走这一个，避免"两套分级判据"悄悄分叉
 * ——那正是第 5 层要拦的东西（同一份资料，两个模块理解成两个可信度）。
 *
 * 静态槽位查 `FIELD_TIER`；只有 brain 是动态的（逐条按 item.source 判，整块取"最差"）。
 * @param {object|null} brain 画像中枢（任意来源，内部会 normalize）
 * @param {object|null} [health] 联网探针缓存（可注入；缺省读 live 缓存）
 * @returns {Record<string,string>} 每个槽位 → SOURCE_TIER 之一（**无条件**列全，是槽位表）
 */
export function gradeFields(brain, health) {
  const tiers = { ...FIELD_TIER };
  if (brain) {
    const b = normalizeBrain(brain);
    const items = []
      .concat(b.competitors || [], b.operatingInsights || [], b.activitySuggestions || [])
      .concat(b.platformAccounts || []);
    // brain 里只要**存在一条没到 confirmed 的**，整块就不能标成已确认事实。
    const worst = items.reduce((acc, it) => {
      const t = gradeSource(it && it.source, health);
      if (t === SOURCE_TIER.UNCONFIRMED) return SOURCE_TIER.UNCONFIRMED;
      if (t === SOURCE_TIER.PUBLIC && acc === SOURCE_TIER.CONFIRMED) return SOURCE_TIER.PUBLIC;
      return acc;
    }, SOURCE_TIER.CONFIRMED);
    tiers.brain = items.length === 0 ? SOURCE_TIER.UNCONFIRMED : worst;
  }
  return tiers;
}

/**
 * 槽位分级表 → 逐条 provenance（保持 2026-10-11 第 92 步的既有结构，勿改字段名）。
 * @param {Record<string,string>} tiers
 * @returns {Array<{field:string,tier:string,label:string}>}
 */
export function toProvenance(tiers) {
  return Object.entries(tiers).map(([field, tier]) => ({
    field,
    tier,
    label: TIER_LABEL[tier] || tier,
  }));
}

/**
 * 解析「这次要读哪家公司」。
 * 优先级：显式传入的 id > 当前企业（douya-current-company）> 无。
 * @param {string|number} [explicitId]
 * @returns {{companyId: string, resolvedFrom: 'explicit'|'current'|'none'}}
 */
export function resolveCompanyId(explicitId) {
  const s = asStr(explicitId).trim();
  if (s) return { companyId: s, resolvedFrom: 'explicit' };
  const cur = readJSON(CURRENT_COMPANY_KEY, null);
  // store 写的是 JSON 序列化的 id 字符串；这里同时容忍对象形态（{id}），避免读法随存储形态静默失配。
  const id = asStr(cur && typeof cur === 'object' ? cur.id : cur).trim();
  if (id) return { companyId: id, resolvedFrom: 'current' };
  return { companyId: '', resolvedFrom: 'none' };
}

/** 从公司主数据里按 id 取公司对象。 */
function pickCompany(companyId) {
  if (!companyId) return null;
  const list = readJSON(COMPANIES_KEY, []);
  if (!Array.isArray(list)) return null;
  return list.find((c) => c && asStr(c.id) === companyId) || null;
}

/** 取某企业的营销资产（marketingStore 的 map 形态）。 */
function pickAsset(companyId) {
  if (!companyId) return null;
  const map = readJSON(ASSETS_MAP_KEY, {});
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const a = map[companyId];
  return a && typeof a === 'object' ? a : null;
}

/** 取某企业的画像中枢（brain map 形态）。 */
function pickBrain(companyId) {
  if (!companyId) return null;
  const map = readJSON(BRAIN_KEY, {});
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const b = map[companyId];
  return b && typeof b === 'object' ? b : null;
}

/** 取某企业的体检结论。 */
function pickCheckup(companyId) {
  if (!companyId) return null;
  const map = readJSON(CHECKUP_KEY, {});
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const c = map[companyId];
  return c && typeof c === 'object' ? c : null;
}

/** 「这家公司在上下文里缺什么」检查表：字段 → 判定"有"的谓词 + 中文名。 */
const MISSING_CHECKS = [
  ['公司名称', (k, c) => !!asStr(c && c.name)],
  ['主营产品', (k) => !!asStr(k.profile && k.profile.products)],
  ['品牌定位/调性', (k) => !!asStr(k.profile && k.profile.brandPositioning)],
  ['核心卖点', (k) => nonEmptyList(k.profile && k.profile.coreSellingPoints)],
  ['目标客户', (k) => nonEmptyList(k.profile && k.profile.targetCustomers)],
  ['竞品名单', (k) => nonEmptyList(k.profile && k.profile.competitors)],
  ['企业事实', (k) => nonEmptyList(k.facts)],
  ['品牌规则/禁区', (k) => nonEmptyList(k.rules)],
];

/**
 * 统一读取某公司的全部资料（只读）。
 *
 * @param {string|number} [companyId] 显式企业 id；不传则走「当前企业」。
 * @param {object} [opts]
 * @param {object|null} [opts.health] 联网探针缓存（可注入，便于单测）
 * @returns {{
 *   companyId: string, resolvedFrom: 'explicit'|'current'|'none',
 *   company: object|null, asset: object|null, knowledge: object,
 *   brain: object|null, checkup: object|null,
 *   tiers: Record<string,string>, provenance: Array<{field:string,tier:string,label:string}>,
 *   missing: string[], hasAny: boolean
 * }} 无 id / 无公司 / 无数据时字段为 null 或空集合，**绝不返回 undefined**。
 */
export function readCompanyContext(companyId, opts = {}) {
  const resolved = resolveCompanyId(companyId);
  const cid = resolved.companyId;

  if (!cid) {
    return {
      companyId: '',
      resolvedFrom: 'none',
      company: null,
      asset: null,
      knowledge: { ...emptyKnowledge(), plan: [], promos: [] },
      brain: null,
      checkup: null,
      tiers: {},
      provenance: [],
      missing: [],
      hasAny: false,
    };
  }

  const company = pickCompany(cid);
  const asset = pickAsset(cid);
  const rawKnowledge = readJSON(KNOWLEDGE_KEY, {});
  const knowledge = {
    // 复用 store 的归一化函数 ⇒ 与 React 侧 getKnowledge 同一口径（不是"另一套读法"）。
    ...normalizeKnowledge(rawKnowledge && rawKnowledge[cid]),
    // 四维外部数据源与 getKnowledge 逐一同源（同一批 load* 函数、同一批键）。
    timeline: loadTimeline(cid),
    goals: loadGoals(cid),
    plan: loadPlanNodes(cid),
    checkup: pickCheckup(cid),
    // 第九维「活动档期」：与 getKnowledge 同一个 loadPromoRecords（同键、同归一化、同优先级）。
    promos: loadPromoRecords(cid),
  };
  const brain = pickBrain(cid);
  const checkup = knowledge.checkup;

  // 逐条来源分级：判据全在 `gradeFields`（唯一实现），本处只负责把"读到的 brain"交给它。
  // ⚠️ 这里是**槽位表口径**（无条件列全所有槽位），它与 `describePresentTiers`（只看这次真有内容的）
  //    是两个用途，不要合并：槽位表给诊断/UI 用（"这家公司该有哪些资料、各属哪级"），
  //    present 版给 prompt 用（"这次实际带了哪些、各属哪级"）。合并会让其中一边撒谎。
  const tiers = gradeFields(brain, opts.health);
  const provenance = toProvenance(tiers);

  /** 只保留**确实为空**的项；有数据的不进 missing（避免把已有资料说成缺）。 */
  const missing = MISSING_CHECKS.filter(([, has]) => !has(knowledge, company)).map(([name]) => name);

  const hasAny = !!(
    company ||
    asset ||
    hasBrain(brain) ||
    checkup ||
    nonEmptyList(knowledge.facts) ||
    nonEmptyList(knowledge.rules) ||
    nonEmptyList(knowledge.memories) ||
    asStr(knowledge.profile && knowledge.profile.products) ||
    asStr(knowledge.profile && knowledge.profile.summary)
  );

  return {
    companyId: cid,
    resolvedFrom: resolved.resolvedFrom,
    company,
    asset,
    knowledge,
    brain,
    checkup,
    tiers,
    provenance,
    missing,
    hasAny,
  };
}

/**
 * 把分级结果拼成一段**给人看也给模型看**的抬头，供 prompt 注入 / UI 提示。
 * 用法：只要这段在那里，模型就不会把「尚未确认」当成企业事实。
 * @param {object} ctx readCompanyContext 的返回
 * @returns {string} 形如 `【资料可信度】已确认事实：公司/档案/事实…；尚未确认：画像中枢/体检结论`
 */
export function describeTiers(ctx) {
  const c = ctx || {};
  const byTier = { confirmed: [], public: [], unconfirmed: [] };
  for (const p of Array.isArray(c.provenance) ? c.provenance : []) {
    if (byTier[p.tier]) byTier[p.tier].push(p.field);
  }
  const seg = [
    byTier.confirmed.length ? `已确认事实：${byTier.confirmed.join('、')}` : '',
    byTier.public.length ? `公开来源整理：${byTier.public.join('、')}` : '',
    byTier.unconfirmed.length ? `尚未确认（不得当事实引用）：${byTier.unconfirmed.join('、')}` : '',
  ].filter(Boolean);
  if (seg.length === 0) return '';
  return `【资料可信度】${seg.join('；')}`;
}

/**
 * 槽位 → "这次**实际有内容**吗"。与 `describePresentTiers` 配对使用。
 * 判据必须比 `MISSING_CHECKS` 宽（后者是给用户看的"你还没填什么"清单，只挑关键几项），
 * 这里要覆盖**全部**会有值进 prompt 的槽位，否则漏掉的那个槽位在抬头里凭空消失。
 */
const PRESENCE = {
  company: (s) => !!asStr(s.company && s.company.name),
  asset: (s) => hasContent(s.asset),
  profile: (s) => hasContent(s.knowledge && s.knowledge.profile),
  facts: (s) => nonEmptyList(s.knowledge && s.knowledge.facts),
  rules: (s) => nonEmptyList(s.knowledge && s.knowledge.rules),
  memories: (s) => nonEmptyList(s.knowledge && s.knowledge.memories),
  timeline: (s) => nonEmptyList(s.knowledge && s.knowledge.timeline),
  goals: (s) => nonEmptyList(s.knowledge && s.knowledge.goals),
  plan: (s) => nonEmptyList(s.knowledge && s.knowledge.plan),
  promos: (s) => nonEmptyList(s.knowledge && s.knowledge.promos),
  brain: (s) => hasBrain(s.brain),
  checkup: (s) => hasContent(s.checkup || (s.knowledge && s.knowledge.checkup)),
};

/**
 * 把分级拼成一段**给模型看**的抬头 —— 只报"这次实际带了内容"的槽位。
 *
 * ── 为什么不能直接用 `describeTiers(ctx)` ────────────────────────────────────
 * `describeTiers` 吃的是 `readCompanyContext` 的**槽位表**（无条件列全 11 个槽位）。
 * 只填了公司名的企业，那段抬头会写成「已确认事实：company、asset、profile、facts、rules、
 * memories、timeline、goals、plan」——**对着空槽位声称已有事实**，等于让模型以为资料齐全。
 * 这正是第 5 层要拦的"分级撒谎"，所以送 prompt 的这一路必须按 presence 过滤。
 *
 * ── 为什么可以信任它 ────────────────────────────────────────────────────────
 * 分级判据仍然只有 `gradeFields` 一份（本函数不判级，只挑"这次有的"）；
 * 本函数**不读 localStorage**（入参就是这次真正要用的那几段），
 * 所以显式传参路径的"对存储免疫"不受影响（第 93 步 unit-context-selfresolve 的 SR1b~SR1f 钉着这条）。
 *
 * @param {{company?:*,asset?:*,knowledge?:*,brain?:*,checkup?:*}} segments 本次实际使用的公司资料段
 * @param {object|null} [health] 联网探针缓存（可注入；缺省读 live 缓存）
 * @returns {string} 形如 `【资料可信度】已确认事实：企业档案、企业事实；尚未确认（不得当事实引用）：画像中枢`；
 *   一个槽位都没有内容时返回 ''（调用方据此不注入，保持改动前逐字一致）。
 */
export function describePresentTiers(segments, health) {
  const s = segments && typeof segments === 'object' ? segments : {};
  const tiers = gradeFields(s.brain, health);
  const byTier = { confirmed: [], public: [], unconfirmed: [] };
  for (const field of Object.keys(FIELD_TIER)) {
    const has = PRESENCE[field] ? PRESENCE[field](s) : false;
    if (!has) continue;
    const t = tiers[field] || SOURCE_TIER.UNCONFIRMED;
    if (byTier[t]) byTier[t].push(FIELD_CN[field] || field);
  }
  const seg = [
    byTier.confirmed.length ? `已确认事实（可直接引用）：${byTier.confirmed.join('、')}` : '',
    byTier.public.length ? `公开来源整理（引用需注明来源）：${byTier.public.join('、')}` : '',
    byTier.unconfirmed.length ? `尚未确认（不得当事实引用）：${byTier.unconfirmed.join('、')}` : '',
  ].filter(Boolean);
  if (seg.length === 0) return '';
  return `【资料可信度】${seg.join('；')}`;
}

export default {
  readCompanyContext,
  resolveCompanyId,
  gradeSource,
  gradeFields,
  toProvenance,
  describeTiers,
  describePresentTiers,
  SOURCE_TIER,
  TIER_LABEL,
};
