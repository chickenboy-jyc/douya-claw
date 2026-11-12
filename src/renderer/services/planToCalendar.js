/**
 * planToCalendar —— 把「经营方向模板」摊平成带真实日期的日历节点（纯函数）。
 *
 * 性质：纯映射 + 结构生成。不 import React / store，可被 node 直接测试。
 *
 * 职责边界（老板定调）：
 *   企业录入后，豆芽自动给一整套方案，方案以「带日期的节点」形式铺到日历上，
 *   用户直接在日历上改（改期 / 改名 / 删 / 加）。本文件只负责「模板 → 节点数组」，
 *   不负责持久化（由 monthlyPlanStore 负责）、不负责 UI（由 CalendarView 负责）。
 *
 * 诚实红线：
 *   - 模板里没有的信息不编造：不编 KPI、不编预算、不编具体日期。
 *   - 节点日期只能由 startDate + 偏移推导；偏移由模板 expectedPeriodDays 决定。
 *   - 模板里的数量（deliveryPlan.content/media/case）是「豆芽建议」，节点 note 必须
 *     显式标注「建议」，不得包装成承诺。
 *
 * 节点形态严格对齐 monthlyPlanStore：
 *   Node = { id, date:'YYYY-MM-DD', endDate?, title, type, note }
 */

import { PLAN_NODE_TYPES, classifyPlanType } from './monthlyPlanDirector.js';
import { getDirections, getDirectionByKey } from '../config/directionCatalog.js';

/** 动作能力（capability）→ 中文释义（用于 note 里说清楚这条在做什么）。 */
const CAPABILITY_LABEL = {
  content: '内容',
  media: '媒体',
  geo: 'GEO 内容',
  activity: '活动',
};

/** 每个方向整体摊平的节奏跨度下限（天），避免模板周期过短导致节点重叠。 */
const MIN_PERIOD_DAYS = 7;

/** 一个线下活动节点默认跨越的天数（结构默认，非事实；仅用于日历里体现「跨天」）。 */
const OFFLINE_ACTIVITY_SPAN = 2;

/** 数字左侧补零到两位。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 把任意输入（Date / 'YYYY-MM-DD' / 空）规整为当天的本地 Date。 */
function resolveStartDate(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  if (typeof v === 'string' && /^\d{4}-\d{1,2}-\d{1,2}/.test(v)) {
    const parts = v.slice(0, 10).split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Date → 'YYYY-MM-DD'（本地时区）。 */
function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 在给定日期上加减天数，返回新的当天 Date（不修改入参）。 */
function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * 把 count 个节点均匀铺到 [0, spanDays] 上，返回严格递增、互不重复的偏移天数。
 * 保证首个为 0、末个为跨度终点；count 较大时不会把多个节点压在同一天。
 */
function distributeOffsets(count, spanDays) {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const span = Math.max(Math.round(spanDays) || 0, count - 1);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    let d = Math.round((span * i) / (count - 1));
    if (i > 0 && d <= offsets[i - 1]) d = offsets[i - 1] + 1;
    offsets.push(d);
  }
  return offsets;
}

/**
 * 组装某方向的「有序投放槽」——只描述「有哪些节点、什么类型、什么语义」，
 * 具体落哪天由 distributeOffsets 统一分配，保证同一天不堆叠。
 */
function buildSlots(direction) {
  const actions = Array.isArray(direction.actions) ? direction.actions : [];
  const dp = direction.deliveryPlan || {};
  const slots = [];

  // 起点：对齐目标与节奏
  slots.push({
    kind: 'kickoff',
    title: `启动：${direction.name}`,
    type: 'monthly',
  });

  // 执行任务：按模板给定顺序（梳理 → 生成 → 传播 …）
  actions.forEach((a) => {
    const title = (a && a.title) || '执行任务';
    slots.push({
      kind: 'action',
      title,
      capability: (a && a.capability) || 'content',
      type: classifyPlanType(title),
    });
  });

  // 传播产出节奏：内容 / 媒体 / 案例（数量为模板建议，note 显式标注「建议」）
  const content = Number(dp.content) || 0;
  const media = Number(dp.media) || 0;
  const caseCount = Number(dp.case) || 0;
  if (content > 0) {
    slots.push({ kind: 'delivery', phase: 'content', count: content, title: '内容产出：持续产出内容资产', type: 'monthly' });
  }
  if (media > 0) {
    slots.push({ kind: 'delivery', phase: 'media', count: media, title: '媒体传播：把曝光落到具体渠道', type: 'monthly' });
  }
  if (caseCount > 0) {
    slots.push({ kind: 'delivery', phase: 'case', count: caseCount, title: '案例沉淀：整理案例用于背书与转化', type: 'monthly' });
  }

  // 收尾：对照市场监测维度复盘
  slots.push({
    kind: 'review',
    title: '阶段复盘：对照市场监测回看进展',
    type: 'monthly',
  });

  return slots;
}

/**
 * 为单个槽生成「给用户看的、具体的」note —— 说清这条为什么安排在这个时间点。
 *
 * @param {Object} slot 槽描述
 * @param {Object} ctx  { direction, period, offset, index, total }
 */
function noteForSlot(slot, ctx) {
  const { direction, period, offset, index, total } = ctx;
  const dayNo = offset + 1; // 周期内第几天（1-based）
  const pos = total > 1 ? `（整条链第 ${index + 1}/${total} 步）` : '';

  if (slot.kind === 'kickoff') {
    return `「${direction.name}」的起点${pos}。先把目标与节奏对齐，之后按模板预计的 ${period} 天周期逐段推进。`;
  }
  if (slot.kind === 'action') {
    const cap = CAPABILITY_LABEL[slot.capability] || '内容';
    return `承接上一步的 ${cap} 动作${pos}，安排在周期第 ${dayNo} 天前后；顺序与模板给定的执行顺序一致，先做梳理再做产出。`;
  }
  if (slot.kind === 'delivery') {
    if (slot.phase === 'content') {
      return `内容产出节奏${pos}：模板建议本方向产出约 ${slot.count} 篇内容（数量为豆芽建议，可自行调整），落在中段持续产出。`;
    }
    if (slot.phase === 'media') {
      return `媒体传播节奏${pos}：模板建议约 ${slot.count} 次媒体投放（数量为豆芽建议，可自行调整），安排在中后段把曝光落到渠道。`;
    }
    return `案例沉淀节奏${pos}：模板建议整理约 ${slot.count} 个案例（数量为豆芽建议，可自行调整），放在后段用于背书与转化。`;
  }
  if (slot.kind === 'review') {
    return `周期收尾${pos}：第 ${period} 天前后对照模板的市场监测维度回看进展，据此决定是否进入下一轮。`;
  }
  return '';
}

/**
 * 把「一个经营方向的模板」摊平成带真实日期的日历节点数组。
 *
 * @param {string} directionKey DIRECTION_KEYS 之一（如 'growth'）
 * @param {Object} [opts]
 * @param {string|Date} [opts.startDate] 起点日期（缺省取今天）
 * @param {string} [opts.companyType] 主体类型（manufacturer/clinic/doctor/platform，缺省 manufacturer）
 * @returns {Array<{id:string,date:string,endDate?:string,title:string,type:string,note:string}>}
 */
export function flattenDirectionToNodes(directionKey, opts = {}) {
  const companyType = opts.companyType || 'manufacturer';
  const startDate = resolveStartDate(opts.startDate);
  const direction = getDirectionByKey(companyType, directionKey);
  if (!direction) return [];

  const period = Math.max(Math.round(Number(direction.expectedPeriodDays)) || 30, MIN_PERIOD_DAYS);
  const slots = buildSlots(direction);
  const offsets = distributeOffsets(slots.length, period);

  return slots.map((slot, index) => {
    const date = addDays(startDate, offsets[index]);
    const node = {
      // 稳定唯一串：同一方向重复生成时 id 不变，便于 mergeNodes 幂等去重
      id: `cal-${direction.key}-${index}`,
      date: toISO(date),
      title: slot.title,
      type: PLAN_NODE_TYPES[slot.type] ? slot.type : 'monthly',
      note: noteForSlot(slot, { direction, period, offset: offsets[index], index, total: slots.length }),
    };
    // 线下活动类节点在日历上体现「跨天」（结构默认，非事实）
    if (node.type === 'offline_activity') {
      node.endDate = toISO(addDays(date, OFFLINE_ACTIVITY_SPAN));
    }
    return node;
  });
}

/**
 * 取某主体的全部经营方向，各自摊平后合并返回（用于「一次性给整套方案」）。
 * 为避免不同方向的首个节点都堆在同一天，每个方向起点依次错开 3 天
 * （仍严格由 startDate + 偏移推导，不引入模板外的信息）。
 *
 * @param {string} companyType manufacturer/clinic/doctor/platform
 * @param {Object} [opts] { startDate }
 * @returns {Array<Node>}
 */
export function flattenAllDirections(companyType, opts = {}) {
  const type = companyType || 'manufacturer';
  const baseStart = resolveStartDate(opts.startDate);
  const directions = getDirections(type);
  const merged = [];
  directions.forEach((direction, idx) => {
    const staggeredStart = addDays(baseStart, idx * 3);
    const nodes = flattenDirectionToNodes(direction.key, {
      ...opts,
      companyType: type,
      startDate: staggeredStart,
    });
    merged.push(...nodes);
  });
  return merged;
}

/** AI 方案节点 id 前缀：用于与模板节点（cal-{key}-{i}）/ 手动节点（cal-manual-*）区分。 */
const AI_NODE_ID_PREFIX = 'cal-ai-';

/**
 * 把「AI 生成的 30 天逐日计划」（opsPlan.generateMonthlyPlan 的产物）摊平成
 * 与 flattenDirectionToNodes **同构**的、带真实日期的日历节点数组（纯函数）。
 *
 * 入参 days：[{ day, title, taskType, priority, desc }]，day 是周期内第几天（1-based），
 * 同一天可能有多条（day 重复）。日期只由 startDate + (day-1) 推导，不引入其它事实。
 *
 * 诚实红线（与模板路径一致）：
 *   - note 只能来自 AI 给的 desc，且必须显式标注「这是豆芽按目标排的建议」，
 *     严禁编造 desc 里没有的数字 / KPI / 具体日期 / 渠道。
 *
 * @param {Array<{day:number,title:string,taskType?:string,priority?:string,desc?:string}>} days
 * @param {Object} [opts] { startDate }
 * @returns {Array<{id:string,date:string,title:string,type:string,note:string}>}
 */
export function daysToNodes(days, opts = {}) {
  if (!Array.isArray(days)) return [];
  const startDate = resolveStartDate(opts.startDate);

  return days
    .map((d, index) => ({ d, index }))
    .filter(({ d }) => d && typeof d.title === 'string' && d.title.trim())
    .map(({ d, index }) => {
      const day = Math.max(1, Math.round(Number(d.day)) || 1);
      const title = d.title.trim();
      const desc = typeof d.desc === 'string' ? d.desc.trim() : '';
      const type = classifyPlanType(title);
      return {
        // cal-ai- 前缀是硬要求：既保证同一天多条也不撞 id，又让 AI 方案不被
        // directionsInNodes 的方向 key 白名单误判（见 missingDirections 的反向逻辑）。
        id: `${AI_NODE_ID_PREFIX}${day}-${index}`,
        date: toISO(addDays(startDate, day - 1)),
        title,
        type: PLAN_NODE_TYPES[type] ? type : 'monthly',
        note: desc ? `豆芽按目标排的建议：${desc}` : '豆芽按目标排的建议，可自行调整',
        _day: day,
        _index: index,
      };
    })
    // 稳定排序：先比 day 升序，同一天保持原数组顺序（用原始 index 兜底，保证稳定）
    .sort((a, b) => (a._day - b._day) || (a._index - b._index))
    .map(({ _day, _index, ...node }) => node);
}

/**
 * 判断一组日历节点里是否含「AI 排的方案」节点（id 以 `cal-ai-` 开头）。
 *
 * 用途：directionsInNodes 只认模板方向 key，AI 方案节点不在白名单里会被当成
 * 「一个方向都没铺」，从而误触发「把另外 N 个方向也铺上」——把模板节点混进 AI 方案。
 * UI 用本函数抑制那个按钮，避免这种割裂。
 *
 * @param {Array<{id:string}>} nodes
 * @returns {boolean}
 */
export function hasAiNodes(nodes) {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((n) => n && typeof n.id === 'string' && n.id.startsWith(AI_NODE_ID_PREFIX));
}

/**
 * 从现有节点里推断「已经铺过哪些经营方向」。
 *
 * 依据：flattenDirectionToNodes 生成的 id 恒为 `cal-{directionKey}-{index}`（见上方）。
 * 为避免把用户手动新增的节点（cal-manual-* / cal-u-* 等）误判成方向，
 * 这里用该主体类型的方向 key 白名单做二次校验，只有命中白名单才计入。
 *
 * @param {Array<Node>} nodes 现有节点
 * @param {string} [companyType] 主体类型（缺省 manufacturer）
 * @returns {Set<string>} 已铺过的 directionKey 集合
 */
export function directionsInNodes(nodes, companyType) {
  const type = companyType || 'manufacturer';
  const known = new Set(getDirections(type).map((d) => d.key));
  const done = new Set();
  const list = Array.isArray(nodes) ? nodes : [];
  for (const n of list) {
    if (!n || typeof n.id !== 'string') continue;
    const m = /^cal-(.+)-(\d+)$/.exec(n.id);
    if (m && known.has(m[1])) done.add(m[1]);
  }
  return done;
}

/**
 * 取「还没铺到日历上的经营方向」——用于「把另外 N 个方向也铺上」这个增量动作。
 * 已铺的方向（含用户改过的）不会被返回，因此不会覆盖用户内容。
 *
 * @param {string} companyType 主体类型
 * @param {Array<Node>} nodes 现有节点
 * @returns {Array<Object>} 未铺的方向模板数组
 */
export function missingDirections(companyType, nodes) {
  const type = companyType || 'manufacturer';
  const done = directionsInNodes(nodes, type);
  return getDirections(type).filter((d) => !done.has(d.key));
}

/**
 * 按 id 去重合并节点数组（幂等）。
 * 已存在的 id 保留 existing 里的版本（即用户改过的内容不被覆盖）；incoming 里新 id 才追加。
 *
 * @param {Array<Node>} existing 现有节点（可为空）
 * @param {Array<Node>} incoming 新生成节点
 * @returns {Array<Node>} 合并后的新数组（不修改入参）
 */
export function mergeNodes(existing, incoming) {
  const base = Array.isArray(existing)
    ? existing.filter((n) => n && n.id).map((n) => ({ ...n }))
    : [];
  const seen = new Set(base.map((n) => n.id));
  const add = Array.isArray(incoming) ? incoming : [];
  for (const n of add) {
    if (!n || !n.id || seen.has(n.id)) continue;
    seen.add(n.id);
    base.push({ ...n });
  }
  return base;
}

/**
 * 用新一批生成结果替换「上一轮 AI 方案」节点（模板节点与用户手动节点一律保留）。
 *
 * 为什么必须替换而不是 mergeNodes：AI 节点 id 恒为 cal-ai-{day}-{index}，
 * 两次生成只要日期位置相同就撞 id，mergeNodes 会为「保护用户改动」跳过它们，
 * 导致「重新给一套方案」按钮调了 AI 却什么都不变（哑点击）。
 *
 * @param {Array<Node>} existing 现有节点（可为空）
 * @param {Array<Node>} incoming 本次新生成的 AI 节点
 * @returns {Array<Node>} 去掉旧 AI 节点后并入新节点的数组（不修改入参）
 */
export function replaceAiNodes(existing, incoming) {
  const base = (Array.isArray(existing) ? existing : []).filter(
    (n) => !(n && typeof n.id === 'string' && n.id.startsWith(AI_NODE_ID_PREFIX)),
  );
  return mergeNodes(base, incoming);
}

export default {
  flattenDirectionToNodes,
  flattenAllDirections,
  daysToNodes,
  hasAiNodes,
  replaceAiNodes,
  mergeNodes,
  directionsInNodes,
  missingDirections,
};
