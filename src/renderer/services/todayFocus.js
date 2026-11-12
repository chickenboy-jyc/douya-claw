/**
 * todayFocus —— 「今天做什么」第一屏的数据层（纯函数）。
 *
 * 性质：纯映射 + 分组排序。不 import React / store，不读 localStorage，不调 AI，
 *       不修改传入数组，可被 node 直接测试（见 scripts/smoke/unit-today-focus.mjs）。
 *
 * 职责边界（产品定调，见 docs/今天做什么-重构方案-v1.md）：
 *   一个日历节点（豆芽排的计划）被「让豆芽做」之后会变成任务 —— 二者是**同一件事的
 *   计划态与执行态**。第一屏要把这两套数据**合并成一张清单**，否则用户得看两处才能
 *   拼出「今天到底干什么」。本文件只负责「合并 + 分档 + 排序 + 截断」，不负责 UI。
 *
 * 诚实红线：
 *   - 节点日期非法（不是合法 'YYYY-MM-DD'）一律跳过，宁可不显示也不编造日期。
 *   - 任务没有日期概念，一律视为「今天该做」，不臆造排期。
 *   - 「豆芽排的」/「你建的」标签只说清来源，不把 AI 假设包装成已定事实。
 *
 * 契约（不可自行发挥，供 UI 层依赖）：
 *   FocusItem = { key, source, id, title, date, type, note, segment, label }
 *   pickTodayFocus({ nodes, tasks, today, days = 3, max = FOCUS_MAX })
 *     → { overdue, today, upcoming, items, total, hidden }
 */

/** 第一屏默认最多显示几条（超出折叠为「还有 N 件」）。 */
export const FOCUS_MAX = 5;

/** 段的固定先后顺序。items 展平、UI 渲染都以此为准。 */
export const FOCUS_SEGMENTS = ['overdue', 'today', 'upcoming'];

/** 「接下来」段的默认跨度（天），即 (today, today+days]。 */
const DEFAULT_DAYS = 3;

/** 来源标签。沿用全产品「AI 假设」标签口径。 */
const LABEL_FROM_AI = '豆芽排的';
const LABEL_FROM_USER = '你建的';

/** 任务缺类型时的兜底类型（与 planToCalendar 的默认口径一致）。 */
const DEFAULT_TASK_TYPE = 'content';

/** 节点缺类型时的兜底类型。 */
const DEFAULT_NODE_TYPE = 'monthly';

/** 优先级 → 排序档位（越小越靠前）。 */
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

/** 未知优先级排最后。 */
const UNKNOWN_PRIORITY_RANK = 4;

/** 数字左侧补零到两位。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date → 'YYYY-MM-DD'（本地时区）。 */
function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 判断值是否为「合法且补零的」'YYYY-MM-DD' 字符串。
 *
 * 严格到「必须是补零的 4-2-2 形式 + 该日期在日历上真实存在」，
 * 这样后续直接用字符串比较分档才安全（'2026-6-5' 之类一律视为非法）。
 */
function isValidISODate(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/** 对合法 'YYYY-MM-DD' 加减天数，返回新的 'YYYY-MM-DD'（不修改入参）。 */
function addDaysISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toISO(dt);
}

/** 值「存在且非空」（undefined / null / '' 视为无值）。 */
function hasValue(v) {
  return v !== undefined && v !== null && v !== '';
}

/** 把输入规整为非负整数；非法（NaN / 负数 / 非数）时返回 fallback。 */
function normalizeNonNegInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** 优先级的排序档位；未知档位排最后。 */
function priorityRank(p) {
  const r = PRIORITY_RANK[p];
  return typeof r === 'number' ? r : UNKNOWN_PRIORITY_RANK;
}

/** 全空结构（所有防御分支统一返回它）。 */
function emptyResult() {
  return { overdue: [], today: [], upcoming: [], items: [], total: 0, hidden: 0 };
}

/**
 * 段内排序比较器（稳定）：
 *   1) date 升序
 *   2) date 相同 → plan 排在 task 前面
 *   3) 同为 task → 按 priority 档位（unknown 最后）
 *   4) 再相同（含同为 plan）→ 保持传入数组的相对顺序（_order）
 */
function compareItems(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.source !== b.source) return a.source === 'plan' ? -1 : 1;
  if (a.source === 'task') {
    const d = priorityRank(a.priority) - priorityRank(b.priority);
    if (d !== 0) return d;
  }
  return a._order - b._order;
}

/** 去掉内部字段，产出契约规定的 FocusItem（副本，不复用内部对象）。 */
function toFocusItem(item) {
  return {
    key: item.key,
    source: item.source,
    id: item.id,
    title: item.title,
    date: item.date,
    type: item.type,
    note: item.note,
    segment: item.segment,
    label: item.label,
  };
}

/**
 * 从「日历节点（豆芽排的计划）」与「项目任务（已落地的执行）」合并出今天该做的清单。
 *
 * @param {Object} [params]
 * @param {Array<{id:string,date:string,endDate?:string,title:string,type?:string,note?:string,taskId?:string}>} [params.nodes] 日历节点
 * @param {Array<{id:string,title?:string,taskType?:string,type?:string,priority?:string,status?:string,description?:string}>} [params.tasks] 项目任务
 * @param {string} [params.today] 今天（'YYYY-MM-DD'，必填且必须合法）
 * @param {number} [params.days=3] 「接下来」段跨度（(today, today+days]）
 * @param {number} [params.max=FOCUS_MAX] items 最多返回几条
 * @returns {{overdue:Array, today:Array, upcoming:Array, items:Array, total:number, hidden:number}}
 */
export function pickTodayFocus(params = {}) {
  const source = params || {};
  const nodes = source.nodes;
  const tasks = source.tasks;
  const today = source.today;

  // 规则 1：入参防御 —— 任何非法入参都静默返回全空结构，绝不抛异常。
  if (!Array.isArray(nodes) || !Array.isArray(tasks) || !isValidISODate(today)) {
    return emptyResult();
  }

  const span = normalizeNonNegInt(source.days === undefined ? DEFAULT_DAYS : source.days, DEFAULT_DAYS);
  const limit = normalizeNonNegInt(source.max === undefined ? FOCUS_MAX : source.max, FOCUS_MAX);
  const todayPlus = addDaysISO(today, span);

  // 规则 4（前置）：记录「所有 node.taskId 的集合」，规则 6 判断 label 时要用。
  const planTaskIds = new Set();
  for (const node of nodes) {
    if (node && typeof node === 'object' && hasValue(node.taskId)) {
      planTaskIds.add(String(node.taskId));
    }
  }

  /** 三段的工作数组（元素是内部对象，带 _order，排序后再转成契约 FocusItem）。 */
  const overdue = [];
  const todayItems = [];
  const upcoming = [];

  // ===== 日历节点 → 分档 =====
  nodes.forEach((node, index) => {
    if (!node || typeof node !== 'object') return;
    // 规则 4：带 taskId 的节点已被「让豆芽做」变成任务，由任务行代表，这里不再出现。
    if (hasValue(node.taskId)) return;
    // 规则 2：日期非法 → 跳过，不进任何段。
    const date = node.date;
    if (!isValidISODate(date)) return;

    // 规则 3：用补零 ISO 字符串比较分档。
    let segment;
    if (date < today) segment = 'overdue';
    else if (date === today) segment = 'today';
    else if (date <= todayPlus) segment = 'upcoming';
    else return; // 超过「接下来」跨度 → 不进任何段

    const item = {
      key: `node:${node.id}`,
      source: 'plan',
      id: hasValue(node.id) ? String(node.id) : '',
      title: typeof node.title === 'string' ? node.title : '',
      date,
      type: hasValue(node.type) ? String(node.type) : DEFAULT_NODE_TYPE,
      note: typeof node.note === 'string' ? node.note : '',
      segment,
      label: LABEL_FROM_AI,
      _order: index,
    };
    if (segment === 'overdue') overdue.push(item);
    else if (segment === 'today') todayItems.push(item);
    else upcoming.push(item);
  });

  // ===== 项目任务 → 分档（规则 5：todo / doing 一律进 today）=====
  tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object') return;
    const status = task.status;
    if (status !== 'todo' && status !== 'doing') return;

    const tid = hasValue(task.id) ? String(task.id) : '';
    const fromPlan = tid !== '' && planTaskIds.has(tid);
    const rawType = hasValue(task.taskType) ? task.taskType : task.type;

    todayItems.push({
      key: `task:${task.id}`,
      source: 'task',
      id: tid,
      title: typeof task.title === 'string' ? task.title : '',
      date: today, // 任务没有日期概念 → 视为今天
      type: hasValue(rawType) ? String(rawType) : DEFAULT_TASK_TYPE,
      note: typeof task.description === 'string' ? task.description : '',
      segment: 'today',
      label: fromPlan ? LABEL_FROM_AI : LABEL_FROM_USER, // 规则 6
      priority: task.priority, // 仅内部用于排序，产出前会剔除
      _order: index,
    });
  });

  // 规则 7：段内稳定排序（不修改入参，排序的是本函数新建的数组）。
  overdue.sort(compareItems);
  todayItems.sort(compareItems);
  upcoming.sort(compareItems);

  const overdueOut = overdue.map(toFocusItem);
  const todayOut = todayItems.map(toFocusItem);
  const upcomingOut = upcoming.map(toFocusItem);

  // 规则 8：按 逾期 → 今天 → 接下来 展平并截断。
  const total = overdueOut.length + todayOut.length + upcomingOut.length;
  const items = [...overdueOut, ...todayOut, ...upcomingOut].slice(0, limit);
  const hidden = Math.max(0, total - items.length);

  return {
    overdue: overdueOut,
    today: todayOut,
    upcoming: upcomingOut,
    items,
    total,
    hidden,
  };
}

export default {
  FOCUS_MAX,
  FOCUS_SEGMENTS,
  pickTodayFocus,
};
