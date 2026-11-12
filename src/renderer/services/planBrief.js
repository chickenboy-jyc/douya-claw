/**
 * planBrief —— 已排方案（日历节点）事实层：读「豆芽给用户排的整套方案」+ 拼给 AI 的事实文本。
 *
 * 背景（2026-09-11 P1 闭环）：
 *   豆芽会给用户自动排一整套带日期的方案，铺在「今天做什么」日历上（monthlyPlanStore 持久化，
 *   key `douya-monthly-plans`）。但这套方案此前既不进企业档案、也不注入 AI —— 豆芽给用户排了
 *   25 个节点，下次对话时却完全不知道自己排过什么。本文件补上这一环：把「已排方案」当作
 *   与时间轴（companyTimeline）/ 目标（companyGoal）对称的档案维度，读出来拼给 AI。
 *
 * 性质：纯常量 + 纯函数（不 import React / store），仅在文件底部提供 localStorage 只读边界。
 * 存储 key 复用 monthlyPlanStore 的 `douya-monthly-plans`（本文件只读，不写；写入由 store 负责）。
 * 结构对齐 monthlyPlanStore：{ [companyId]: { nodes: Node[], updatedAt } }
 *   Node = { id, date:'YYYY-MM-DD', endDate?, title, type, note }
 *
 * 与 buildTimelineFacts 同风格：只给事实（排了什么、什么时候），不写「请结合…判断…」这类
 * 给 AI 的祈使句 —— 避免把写给 AI 的指令当内容贴给用户看（历史 bug 教训）。
 */

import { PLAN_NODE_TYPES, classifyPlanType } from './monthlyPlanDirector.js';

/** localStorage key（与 monthlyPlanStore.MONTHLY_PLANS_KEY 一致；此处导出便于测试与调用方复用）。 */
export const PLAN_KEY = 'douya-monthly-plans';

/** 时间窗口默认参数：往前看 pastDays 天、往后看 horizonDays 天。 */
const DEFAULT_PAST_DAYS = 7;
const DEFAULT_HORIZON_DAYS = 90;
/** 窗口内最多列出的节点条数。 */
const DEFAULT_MAX_ITEMS = 24;

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 读取 localStorage（容错：非浏览器环境 / 被禁用返回 null）。 */
function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

/** Date → 'YYYY-MM-DD'（本地时区）。 */
function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 规整 now（Date / number / 字符串）；非法或缺失回落到当前时间。 */
function resolveNow(now) {
  if (now instanceof Date) return Number.isNaN(now.getTime()) ? new Date() : now;
  if (typeof now === 'number' || typeof now === 'string') {
    const d = new Date(now);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  return new Date();
}

/** 归一化单个日历节点（丢弃脏字段，保结构稳定）。 */
export function normalizePlanNode(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: asStr(r.id),
    date: asStr(r.date),
    endDate: asStr(r.endDate),
    title: asStr(r.title),
    type: asStr(r.type),
    note: asStr(r.note),
  };
}

/** 节点 type → 中文标签：优先用节点自带 type（命中 PLAN_NODE_TYPES），否则按标题 classify。 */
function nodeTypeLabel(node) {
  const rawType = asStr(node && node.type);
  const key = PLAN_NODE_TYPES[rawType] ? rawType : classifyPlanType((node && node.title) || '');
  return PLAN_NODE_TYPES[key] || PLAN_NODE_TYPES.monthly;
}

/**
 * 读某企业的日历方案节点（归一化，按 date 升序）。
 * 无数据 / 公司无方案 / 结构非法 / 异常一律返回 []。纯读，不写。
 * @param {string|number} companyId
 * @returns {Array<{id:string,date:string,endDate:string,title:string,type:string,note:string}>}
 */
export function loadPlanNodes(companyId) {
  const cid = asStr(companyId);
  const st = storage();
  if (!cid || !st) return [];
  try {
    const raw = st.getItem(PLAN_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw);
    const entry = all && typeof all === 'object' && !Array.isArray(all) ? all[cid] : null;
    const nodes = entry && Array.isArray(entry.nodes) ? entry.nodes : [];
    return nodes
      .map(normalizePlanNode)
      .filter((n) => n.date && n.title)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * 日历方案 → 给 AI 的事实文本。
 * 只给事实（排了什么、什么时候、什么类型），不给指令式引导语 —— 与 buildTimelineFacts 同风格。
 * 时间窗口：只取 [今天 - pastDays, 今天 + horizonDays] 之间的节点，避免陈年节点也塞进去。
 * 无有效节点（或窗口内为空）返回 ''（零注入，保证没有方案时 AI 上下文一字不变）。
 *
 * @param {Array} nodes loadPlanNodes 产物（或 k.plan）
 * @param {{now?:Date|number|string, pastDays?:number, horizonDays?:number, maxItems?:number}} [opts]
 * @returns {string}
 */
export function buildPlanContext(nodes, opts = {}) {
  const list = (Array.isArray(nodes) ? nodes : [])
    .map(normalizePlanNode)
    .filter((n) => n.date && n.title);
  if (list.length === 0) return '';

  const now = resolveNow(opts.now);
  const pastDays = Number.isFinite(opts.pastDays) ? Number(opts.pastDays) : DEFAULT_PAST_DAYS;
  const horizonDays = Number.isFinite(opts.horizonDays) ? Number(opts.horizonDays) : DEFAULT_HORIZON_DAYS;
  const maxItems =
    Number.isFinite(opts.maxItems) && Number(opts.maxItems) > 0 ? Math.floor(Number(opts.maxItems)) : DEFAULT_MAX_ITEMS;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(today);
  from.setDate(from.getDate() - pastDays);
  const to = new Date(today);
  to.setDate(to.getDate() + horizonDays);
  const fromIso = toISO(from);
  const toIso = toISO(to);

  const sorted = list.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const inWindow = sorted.filter((n) => n.date >= fromIso && n.date <= toIso);
  if (inWindow.length === 0) return '';

  const head =
    `【已排方案（日历）】豆芽此前为该企业排好的一套执行方案，用户可能已在日历上做过增删改；` +
    `共 ${sorted.length} 项，其中近期 ${inWindow.length} 项：`;

  const shown = inWindow.slice(0, maxItems);
  const lines = shown.map((n) => `- ${n.date} ${n.title}（${nodeTypeLabel(n)}）`);
  const rest = inWindow.length - shown.length;
  const body = rest > 0 ? lines.concat(`（窗口内还有 ${rest} 项未列出）`).join('\n') : lines.join('\n');

  return `${head}\n${body}`;
}

export default {
  PLAN_KEY,
  normalizePlanNode,
  loadPlanNodes,
  buildPlanContext,
};
