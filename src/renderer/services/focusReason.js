/**
 * focusReason —— 「今天做什么」第一屏每条的「为什么现在做」AI 解释（带缓存）。
 *
 * 性质：AI 编排 + 本地缓存。不 import React、不修改入参、不读组件状态。
 *       localStorage 访问全部在函数内部做 `typeof localStorage` 防御，
 *       因此可在 node 环境直接单测（见 scripts/smoke/unit-focus-reason.mjs）。
 *
 * 职责边界（产品定调，见 docs/今天做什么-重构方案-v1.md §3.3 方案 A）：
 *   第一屏列出「今天这 N 件」后，每件要有一句「为什么现在做」。日历节点结构里没有
 *   reason 字段、note 只是「豆芽按目标排的建议」这句套话，不足以回答「为什么」。
 *   故由 AI 把「今天这 N 件 + 企业档案 + 目标 + 时间轴」读一遍，逐条给理由。
 *   结果按「日期 + 条目 key 集合」缓存，当天 + 同一批条目不重复调 AI。
 *
 * 诚实红线：
 *   - 理由必须从企业画像推导、引用具体信息；禁止「因为要增长 / 因为重要 / 提升品牌」等套话。
 *   - AI 失败 / 返回不可解析 / 一条有效理由都没有 → 如实返回 { ok:false }，**不编造理由**。
 *   - 只采信「入参 items 里真实存在的 key」；模型编出来的 key、空 reason 一律丢弃。
 *
 * 契约：
 *   generateFocusReasons(params, opts) → { ok:true, reasons, brief, fromCache } | { ok:false, error }
 *     brief = { goal, outcome, why } | null   ← 2026-09-11 新增「这批要达成什么」的整体交代
 *   buildFocusFingerprint(items, today) → `${today}::${keys.join('|')}`   （纯函数）
 *   readReasonCache(companyId, fingerprint) → { [key]:string } | null     （纯读，不抛）
 *   readFocusCache(companyId, fingerprint) → { reasons, brief } | null     （纯读，不抛）
 *   writeReasonCache(companyId, fingerprint, reasons, brief?) → boolean    （不抛）
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';

/** localStorage key：按企业隔离的「为什么」缓存。 */
export const FOCUS_REASON_STORAGE_KEY = 'douya-focus-reasons';

/**
 * reason 必须从企业画像推导的硬性约束（沿用 smartToday.REASON_RULE 的精神，措辞更狠）。
 * 导出只为可被单测/文档引用，不参与别的逻辑。
 */
export const REASON_RULE = [
  '每条「reason（为什么现在做）」只能从当前企业画像中推导，且必须点名引用至少一个具体信息：',
  '行业 / 主体类型、主打产品或核心卖点、目标客户、竞品动作、当前营销目标，或该条目自身的类型与说明。',
  '正面例子：「你是口腔厂家，主打种植体、目标客户是民营门诊，而竞品正主推数字化方案，所以今天先产出这条内容占位」。',
  '严禁输出「因为要增长」「因为重要」「提升品牌」「为了扩大影响力」「增强竞争力」这类放之四海而皆准的空泛理由；',
  '也禁止「这是个好机会」「有助于发展」「为后续打基础」等无法落到本企业的套话。',
  '若企业画像里确实缺少支撑这条理由的信息，就如实写「企业画像中缺少 X 信息，暂无法给出具体理由」，不要编。',
].join('');

/**
 * 批次（brief）三问的硬性约束。
 *
 * 用户诉求（2026-09-11）：
 *   「今天这 N 件 / 豆芽已按你的目标排好，你只确认 / 这期间的目标是什么，是不是要告知啊；
 *     达成的结果是什么；要有引导，为什么你要做这些事情，结合经营诊断和企业大脑来分析。」
 * 即：逐条理由之外，用户还要一个**整体交代** —— 这批事为哪个目标服务、做完能换到什么、凭什么现在做。
 * 导出只为可被单测/文档引用，不参与别的逻辑。
 */
export const BRIEF_RULE = [
  '除逐条理由外，还要给这批清单一个整体交代，回答三个问题：',
  '① goal（这期间的目标是什么）：一到两句，必须落在本企业真实的经营目标或经营短板上，不能是「提升品牌影响力」这种空话；',
  '② outcome（达成的结果是什么）：这批事做完，预计能看到什么**可验证的变化**（例如「知乎上出现 N 篇可被 AI 引用的问题回答」「竞品词下有自己的内容占位」）；',
  '禁止承诺任何具体数字指标（份额、营收、涨粉数、排名位次）——没发生过的事不许说成会发生；',
  '③ why（为什么是这几件）：把「经营诊断里偏弱的维度」与「企业档案里的事实」串起来解释，让老板看懂这批事的来由。',
  '若经营诊断或企业档案信息不足，就如实说「因为还没有经营诊断数据，这批主要按企业目标排」，不要编一个理由。',
].join('');

/** 字符串化 + trim；非字符串返回 ''。 */
function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** id 类字段：容忍数字，统一成非空字符串。 */
function idStr(v) {
  if (v === undefined || v === null || v === '') return '';
  return String(v).trim();
}

/** 数字左侧补零到两位。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地当天的 'YYYY-MM-DD'。 */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 从任意异常/值里取出可读的错误文本。 */
function errMsg(e) {
  if (e && typeof e === 'object') {
    const m = asStr(e.message);
    if (m) return m;
  }
  const s = asStr(e);
  return s || '未知错误';
}

/** localStorage 是否可用（隐私模式 / node 环境可能没有，或缺 item 方法）。 */
function hasStorage() {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage !== null &&
      typeof localStorage.getItem === 'function' &&
      typeof localStorage.setItem === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * 读取整张缓存表 { [companyId]: { fingerprint, reasons, generatedAt } }。
 * 任何异常（JSON 坏、结构不对、storage 抛错）→ 返回空对象，不抛。
 */
function readAllCache() {
  if (!hasStorage()) return {};
  try {
    const raw = localStorage.getItem(FOCUS_REASON_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return obj;
  } catch {
    return {};
  }
}

/** 只保留「非空字符串」的 reason，返回干净副本；无有效项时返回 null。 */
function cleanReasons(reasons) {
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) return null;
  const out = {};
  for (const [k, v] of Object.entries(reasons)) {
    const key = asStr(k);
    const reason = asStr(v);
    if (key && reason) out[key] = reason;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 归一化批次交代（brief）。三项全部为空 → null（宁可没有，不要编）。
 * @returns {{goal:string,outcome:string,why:string}|null}
 */
export function cleanBrief(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return null;
  const goal = asStr(brief.goal);
  const outcome = asStr(brief.outcome);
  const why = asStr(brief.why);
  if (!goal && !outcome && !why) return null;
  return { goal, outcome, why };
}

/**
 * 生成第一屏条目的排序指纹（纯函数，不碰 localStorage）。
 * items 本身已按契约稳定有序，直接按 key 拼接即可。
 *
 * @param {Array<{key:string}>} items
 * @param {string} today 'YYYY-MM-DD'
 * @returns {string} `${today}::${keys.join('|')}`
 */
export function buildFocusFingerprint(items, today) {
  const t = asStr(today);
  if (!Array.isArray(items)) return `${t}::`;
  const keys = items.map((it) => (it && it.key !== undefined && it.key !== null ? String(it.key) : ''));
  return `${t}::${keys.join('|')}`;
}

/**
 * 读缓存（纯读，任何异常都不抛）。命中条件：companyId + fingerprint 都非空、
 * 存在对应条目、fingerprint 相同、reasons 是含至少一条非空理由的对象。
 *
 * @param {string} companyId
 * @param {string} fingerprint
 * @returns {Object|null} { [key]:string } 或 null（未命中）
 */
export function readReasonCache(companyId, fingerprint) {
  const hit = readFocusCache(companyId, fingerprint);
  return hit ? hit.reasons : null;
}

/**
 * 读整条缓存（逐条理由 + 批次交代）。命中条件同 readReasonCache。
 * 老缓存（2026-09-11 之前写入）没有 brief 字段 → brief 返回 null，UI 自行降级。
 *
 * @param {string} companyId
 * @param {string} fingerprint
 * @returns {{reasons:Object, brief:({goal,outcome,why}|null)}|null}
 */
export function readFocusCache(companyId, fingerprint) {
  const cid = idStr(companyId);
  const fp = asStr(fingerprint);
  if (!cid || !fp) return null;
  try {
    const all = readAllCache();
    const entry = all[cid];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (asStr(entry.fingerprint) !== fp) return null;
    const reasons = cleanReasons(entry.reasons);
    if (!reasons) return null;
    return { reasons, brief: cleanBrief(entry.brief) };
  } catch {
    return null;
  }
}

/**
 * 写缓存（不抛）。companyId / fingerprint 缺失或 reasons 无有效项时不写，返回 false。
 *
 * @param {string} companyId
 * @param {string} fingerprint
 * @param {Object} reasons { [key]:string }
 * @param {Object} [brief] 批次交代 { goal, outcome, why }（可选；全空则不写该字段）
 * @returns {boolean} 是否写入成功
 */
export function writeReasonCache(companyId, fingerprint, reasons, brief) {
  const cid = idStr(companyId);
  const fp = asStr(fingerprint);
  if (!cid || !fp || !hasStorage()) return false;
  const clean = cleanReasons(reasons);
  if (!clean) return false;
  try {
    const all = readAllCache();
    const entry = { fingerprint: fp, reasons: clean, generatedAt: Date.now() };
    const b = cleanBrief(brief);
    if (b) entry.brief = b;
    all[cid] = entry;
    localStorage.setItem(FOCUS_REASON_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 items 列成「key | 标题 | 日期 | 类型 | 原note」清单，让模型逐条对应。
 */
function formatItemsForPrompt(items) {
  return items.map((it) => {
    const key = it && it.key !== undefined && it.key !== null ? String(it.key) : '';
    const title = asStr(it && it.title) || '（无标题）';
    const date = asStr(it && it.date) || '—';
    const type = asStr(it && it.type) || '—';
    const note = asStr(it && it.note) || '—';
    return `${key} | ${title} | ${date} | ${type} | ${note}`;
  });
}

/** 组装「为什么现在做」。 */
function buildFocusReasonPrompt({ items, companyType, goalLabel, diagnosis }) {
  const lines = formatItemsForPrompt(items);
  return [
    '你是豆芽。用户在「今天做什么」页面看到下面这张今日清单，想知道两件事：',
    '（一）每一条为什么现在做；（二）这一整批到底为了什么 —— 这期间的目标是什么、做完能达成什么、为什么是这几件。',
    '请逐条给出一句「为什么现在做」，说人话、说具体，不要泛泛而谈；再另外给一段整体交代。',
    goalLabel ? `当前营销目标：${goalLabel}。` : '',
    companyType ? `当前企业主体类型：${companyType}。` : '',
    diagnosis ? `【经营诊断最新结果（豆芽此前跑的，可能为空）】\n${diagnosis}` : '【经营诊断最新结果】暂无（还没跑过经营诊断，不要说「诊断显示…」）',
    `清单（共 ${items.length} 条，每行格式：key | 标题 | 日期 | 类型 | 原有说明）：`,
    ...lines,
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{',
    '  "brief": { "goal": "这期间的目标是什么", "outcome": "达成的结果是什么", "why": "为什么是这几件" },',
    '  "reasons": [ { "key": "条目key（必须原样照抄上面清单里的 key）", "reason": "为什么现在做" } ]',
    '}',
    'key 必须与清单完全一致，不得新增、不得改写、不得遗漏任何一条。',
    BRIEF_RULE,
    REASON_RULE,
    '不得编造医疗疗效、数据、案例，或清单与企业画像之外的信息。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 生成第一屏条目的「为什么现在做」。
 *
 * @param {Object} [params]
 * @param {Array<{key:string,source:string,title:string,date:string,type:string,note:string}>} [params.items] todayFocus 产出的 FocusItem[]
 * @param {Object} [params.company] 企业对象（取 company.id 作缓存分区）
 * @param {string} [params.companyId] 企业 id（优先取 company.id，其次本字段）
 * @param {Object} [params.asset] 营销资产
 * @param {Object} [params.knowledge] 企业长期知识
 * @param {Object} [params.project] 当前项目
 * @param {string} [params.role] 角色（默认 admin）
 * @param {string} [params.goalLabel] 当前营销目标名
 * @param {string} [params.companyType] 主体类型
 * @param {string} [params.today] 指纹用日期（缺省取本地今天；仅用于缓存指纹）
 * @param {Object} [opts]
 * @param {Function} [opts.chatFn] 可注入的 AI 调用（默认 chatOnce），签名 (messages, ctx, opts)
 * @param {number} [opts.temperature] 温度（默认 0.4）
 * @returns {Promise<{ok:true,reasons:Object,fromCache:boolean}|{ok:false,error:string}>}
 */
export async function generateFocusReasons(params = {}, opts = {}) {
  const p = params || {};
  const items = p.items;

  // 规则 1：零成本短路 —— 无条目直接成功返回，绝不调 AI。
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, reasons: {}, brief: null, fromCache: false };
  }

  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const today = asStr(p.today) || asStr(opts.today) || localToday();
  const fingerprint = buildFocusFingerprint(items, today);
  const companyId = idStr(p.companyId) || idStr(p.company && p.company.id);

  // 规则 2：命中缓存 → 直接返回，不调 AI。
  const cached = companyId ? readFocusCache(companyId, fingerprint) : null;
  if (cached) {
    return { ok: true, reasons: cached.reasons, brief: cached.brief, fromCache: true };
  }

  // 规则 3：调 AI。
  const ctx = buildAIContext({
    company: p.company,
    asset: p.asset,
    knowledge: p.knowledge,
    project: p.project,
    role: p.role || 'admin',
    goalLabel: p.goalLabel || '',
  });
  const prompt = buildFocusReasonPrompt({
    items,
    companyType: p.companyType,
    goalLabel: p.goalLabel,
    diagnosis: asStr(p.diagnosis),
  });

  let res;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
      reasoningEffort: 'none',
    });
  } catch (e) {
    return { ok: false, error: `AI 调用失败：${errMsg(e)}` };
  }

  if (!res || res.ok !== true || !res.content) {
    return { ok: false, error: 'AI 未返回可用内容' };
  }

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'AI 返回内容无法解析为 JSON' };
  }

  // 兼容 { reasons: [...] } 与直接返回数组两种形态；其余一律判失败。
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.reasons) ? parsed.reasons : null;
  if (!list) {
    return { ok: false, error: 'AI 返回结构缺少 reasons 数组' };
  }

  // 规则 4：结果归一化 —— 只认入参 items 里存在的 key，且 reason 必须是非空字符串。
  const allowed = new Set(
    items.map((it) => (it && it.key !== undefined && it.key !== null ? String(it.key) : '')).filter(Boolean),
  );
  const reasons = {};
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const key = entry.key !== undefined && entry.key !== null ? String(entry.key) : '';
    if (!allowed.has(key)) continue; // 模型编出来的 key → 丢弃
    if (typeof entry.reason !== 'string') continue; // 非字符串 → 丢弃
    const reason = entry.reason.trim();
    if (!reason) continue; // 空 reason → 丢弃（宁可没有，不要编）
    reasons[key] = reason;
  }

  // 规则 5：一条有效理由都没有 → 失败，且不写缓存。
  if (Object.keys(reasons).length === 0) {
    return { ok: false, error: 'AI 未给出任何有效理由' };
  }

  // 批次交代（brief）是可选的：模型没给、给空、给坏 → null，UI 自行降级；不影响 reasons 成立。
  const brief = cleanBrief(parsed && !Array.isArray(parsed) ? parsed.brief : null);

  // 成功后写缓存（companyId 缺失时跳过分区缓存，避免跨企业串味）。
  if (companyId) {
    writeReasonCache(companyId, fingerprint, reasons, brief);
  }

  return { ok: true, reasons, brief, fromCache: false };
}

export default {
  FOCUS_REASON_STORAGE_KEY,
  REASON_RULE,
  BRIEF_RULE,
  generateFocusReasons,
  buildFocusFingerprint,
  readReasonCache,
  readFocusCache,
  writeReasonCache,
  cleanBrief,
};
