/**
 * companyGoal —— 企业目标（方向盘）数据层（P1，纯函数 + localStorage 边界）。
 *
 * 定位：企业目标是整条经营主线的最顶端（方向盘），回答「今年/这一阶段/这个月，
 * 企业最想让什么发生变化」。它不是「营销目标」的别名，而是更宏观的目标陈述 +
 * 目标类别 + 时间有效性，AI 据此才真正「懂你要干什么」。
 *
 * 设计依据（2026-09-10 架构定稿 v2）：
 *   - 企业目标 = 系统方向盘（首登核心，AI 定制 / 填已有）。
 *   - 目标带 validFrom / validTo（时间知识），区别于「企业是什么」这类长期知识。
 *   - 计划周期（年度/季度/月度）= 用户选的时间尺度，不是三个功能。
 *
 * 性质：纯常量 + 纯函数（不 import React / 其它业务模块），仅在文件底部提供 localStorage 读写。
 * 存储独立 key：`douya-company-goals`（不污染四类知识 KNOWLEDGE_KEY / 时间轴 TIMELINE_KEY）。
 *
 * 数据结构：{ [companyId]: Goal[] }
 *   Goal = { id, statement, category, categoryLabel, source('ai'|'user'), period,
 *            validFrom, validTo, createdAt, updatedAt }
 * 旧目标不物理删除：新目标写入时，旧的按 validTo 标记失效（保留历史，供时间档案对比）。
 */

const GOALS_KEY = 'douya-company-goals';
const GOALS_MAX = 24; // 单企业最多保留的历史目标数

/** 目标类别（方向盘三选 + 自定义）。 */
export const GOAL_CATEGORIES = {
  sales: { key: 'sales', label: '提升销售', desc: '营收 / 成交 / 业绩增长', question: '今年营收或成交想增长到多少？' },
  customer: { key: 'customer', label: '扩大客户规模', desc: '新客 / 客户数 / 线索增长', question: '今年想新增多少客户或线索？' },
  brand: { key: 'brand', label: '提升品牌影响力', desc: '声量 / 口碑 / 行业认知', question: '今年想让品牌在行业里达到什么声量？' },
  custom: { key: 'custom', label: '自定义目标', desc: '其他经营目标', question: '用一句话描述你的目标' },
};

/** 计划周期（时间尺度，非三个功能）。 */
export const PLAN_PERIODS = {
  yearly: { key: 'yearly', label: '年度计划', question: '今年企业要去哪里？' },
  quarterly: { key: 'quarterly', label: '季度计划', question: '这一阶段重点突破什么？' },
  monthly: { key: 'monthly', label: '月度计划', question: '这个月具体要完成什么？' },
};

const CATEGORY_KEYS = Object.keys(GOAL_CATEGORIES);
const PERIOD_KEYS = Object.keys(PLAN_PERIODS);

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function asIso(v) {
  return typeof v === 'string' && v ? v : '';
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 生成目标 id（不引 uuid）。 */
function uid() {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前月份 key，如 '2026-09'（本地时间）。 */
export function currentMonth(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 月份平移，如 shiftMonth('2026-09', -1) → '2026-08'。 */
export function shiftMonth(period, delta = 0) {
  const p = asStr(period);
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (!m) return '';
  let year = Number(m[1]);
  let month = Number(m[2]) - 1;
  const total = year * 12 + month + (Number(delta) || 0);
  year = Math.floor(total / 12);
  month = total % 12;
  if (month < 0) { month += 12; year -= 1; }
  return `${year}-${pad2(month + 1)}`;
}

/**
 * 按计划周期推导目标的时间范围（validFrom / validTo，月份粒度）。
 *   yearly   → 当年 1 月 ~ 12 月
 *   quarterly→ 本季度首月 ~ 末月
 *   monthly  → 本月 ~ 本月
 * @returns {{validFrom:string, validTo:string}}
 */
export function periodRange(period, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(d.getTime())) return { validFrom: '', validTo: '' };
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-based
  const qStart = Math.floor((month - 1) / 3) * 3 + 1;
  const qEnd = qStart + 2;
  switch (period) {
    case 'yearly':
      return { validFrom: `${year}-01`, validTo: `${year}-12` };
    case 'quarterly':
      return { validFrom: `${year}-${pad2(qStart)}`, validTo: `${year}-${pad2(qEnd)}` };
    case 'monthly':
      return { validFrom: `${year}-${pad2(month)}`, validTo: `${year}-${pad2(month)}` };
    default:
      return { validFrom: '', validTo: '' };
  }
}

/** 从目标陈述识别类别（关键词规则，纯函数可测试）。默认 custom。 */
export function classifyGoalCategory(statement) {
  const t = String(statement || '');
  if (!t) return 'custom';
  const hit = (words) => words.some((w) => t.includes(w));
  if (hit(['营收', '销售', '成交', '业绩', '收入', 'GMV', '订单', '卖', '毛利', '利润'])) return 'sales';
  if (hit(['客户', '新客', '获客', '会员', '用户', '流量', '粉丝', '线索', '复购', '客户数'])) return 'customer';
  if (hit(['品牌', '声量', '口碑', '知名', '影响', '认知', '曝光', '声誉', '形象'])) return 'brand';
  return 'custom';
}

/** 归一化单条目标（幂等，脏字段过滤）。 */
export function normalizeCompanyGoal(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const statement = asStr(r.statement);
  const categoryRaw = asStr(r.category);
  const category = CATEGORY_KEYS.includes(categoryRaw) ? categoryRaw : classifyGoalCategory(statement);
  const period = PERIOD_KEYS.includes(asStr(r.period)) ? asStr(r.period) : 'yearly';
  const range = periodRange(period);
  return {
    id: asStr(r.id) || uid(),
    statement,
    category,
    categoryLabel: GOAL_CATEGORIES[category].label,
    source: asStr(r.source) === 'user' ? 'user' : 'ai',
    period,
    validFrom: asIso(r.validFrom) || range.validFrom,
    validTo: asIso(r.validTo) || range.validTo,
    createdAt: asIso(r.createdAt) || new Date().toISOString(),
    updatedAt: asIso(r.updatedAt) || new Date().toISOString(),
  };
}

/** 当前「有效」目标（validTo >= 当前月，取最新一条；无则 null）。 */
export function activeGoal(goals, now = new Date()) {
  const list = Array.isArray(goals) ? goals : [];
  const m = currentMonth(now);
  const actives = list
    .map(normalizeCompanyGoal)
    .filter((g) => g.statement)
    .filter((g) => !g.validTo || g.validTo >= m)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return actives[0] || null;
}

/**
 * 把企业目标拼成给 AI 看的「方向盘」文本（事实层，含时间范围）。
 * @param {Array} goals
 * @param {object} [opts] { now }
 */
export function buildGoalContext(goals, opts = {}) {
  const g = activeGoal(goals, opts.now || new Date());
  if (!g) return '';
  const range = g.validFrom && g.validTo ? `（${g.validFrom} ~ ${g.validTo}）` : '';
  const src = g.source === 'user' ? '老板已填' : '豆芽定制';
  return `【企业目标（方向盘）】\n- 目标：${g.statement} ${range}\n- 类别：${g.categoryLabel}（来源：${src}）\n- 计划周期：${PLAN_PERIODS[g.period].label}`;
}

// ==================== localStorage 读写边界 ====================

function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

/** 读某企业目标列表（归一化，按 updatedAt 降序）。 */
export function loadGoals(companyId) {
  const cid = asStr(companyId);
  const st = storage();
  if (!cid || !st) return [];
  try {
    const raw = st.getItem(GOALS_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw);
    const list =
      all && typeof all === 'object' && !Array.isArray(all) && Array.isArray(all[cid])
        ? all[cid]
        : [];
    return list
      .map(normalizeCompanyGoal)
      .filter((g) => g.statement)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  } catch {
    return [];
  }
}

/** 写某企业目标列表（整体覆盖 + 上限裁剪）。 */
export function saveGoals(companyId, goals) {
  const cid = asStr(companyId);
  const st = storage();
  if (!cid || !st) return false;
  try {
    const raw = st.getItem(GOALS_KEY);
    let all = {};
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) all = p;
    }
    const list = (Array.isArray(goals) ? goals : [])
      .map(normalizeCompanyGoal)
      .filter((g) => g.statement)
      .slice(0, GOALS_MAX);
    all[cid] = list;
    st.setItem(GOALS_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/**
 * 设定企业目标：新目标落库，旧的（仍在有效期的）按 validFrom 标记失效（保留历史）。
 * @returns {Array} 写回后的目标列表
 */
export function setCompanyGoal(companyId, goal, opts = {}) {
  const cid = asStr(companyId);
  if (!cid) return null;
  const g = normalizeCompanyGoal(goal);
  if (!g.statement) return null;

  const now = opts.now || new Date();
  const newFrom = g.validFrom || periodRange(g.period, now).validFrom;
  const list = loadGoals(cid);

  // 旧有效目标：validTo 收口到新目标 validFrom 之前（同月则直接失效），保留历史不删
  const closed = list.map((old) => {
    if (!old.validTo || old.validTo >= newFrom) {
      const cut = newFrom ? shiftMonth(newFrom, -1) : '';
      return { ...old, validTo: cut || old.validTo };
    }
    return old;
  });

  const next = [g, ...closed];
  saveGoals(cid, next);
  return loadGoals(cid);
}

export default {
  GOALS_KEY,
  GOALS_MAX,
  GOAL_CATEGORIES,
  PLAN_PERIODS,
  currentMonth,
  shiftMonth,
  periodRange,
  classifyGoalCategory,
  normalizeCompanyGoal,
  activeGoal,
  buildGoalContext,
  loadGoals,
  saveGoals,
  setCompanyGoal,
};
