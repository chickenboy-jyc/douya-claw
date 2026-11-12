/**
 * companyTimeline —— 企业档案「时间段追踪」数据层（阶段一）。
 *
 * 目标：企业档案不止有静态四类知识（profile / facts / rules / memories），还要有「时间维度」——
 * 按月记录「企业做了什么（events）+ 关键指标（metrics）」，让 AI 能对比「上月 vs 本月」，
 * 说明变化含义，持续了解企业。
 *
 * 设计依据（2026-09-10）：用户明确「给企业档案做补充（按照时间段）… 上个月做了什么、这个月
 * 变了说明什么问题，持续的了解你的企业」「诊断后的内容也会学习到企业档案里面，并且是按照时间段的」。
 *
 * 性质：纯常量 + 纯函数（不 import React / store / 其它业务模块），只在文件底部提供 localStorage 读写边界。
 * 存储独立 key：`douya-company-timeline`（不污染四类知识 KNOWLEDGE_KEY，与 brain 独立 key 同理）。
 *
 * 数据结构：
 *   { [companyId]: [ { period:'YYYY-MM', metrics:{[dimensionId]:Metric}, events:[Event], ... } ] }
 *   Metric = { label, value(number|null), display(string|null), note(string), capturedAt }
 *   Event  = { label, kind, at }
 *
 * 两条写入入口（由调用方触发，非自动）：
 *   recordMetric —— 诊断结果（AI 搜索曝光等关键指标）按月覆盖写（同 dimensionId 覆盖，取本月最新）
 *   recordEvent  —— 做了什么（营销专项 / 经营方向 / 结论类产物）按月累计追加（去重）
 *
 * 读取 / 对比：loadTimeline → comparePeriods → buildTimelineText（注入 AI 上下文）。
 */

const TIMELINE_KEY = 'douya-company-timeline';

/** 最多保留的月份数（超出丢最旧，防无限膨胀）。 */
export const PERIOD_MAX_MONTHS = 24;
/** 单期最多事件数。 */
export const EVENTS_MAX = 60;
/** 单期最多指标数。 */
export const METRICS_MAX = 40;

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

/** 当前月份 key，如 '2026-09'（本地时间）。 */
export function currentPeriod(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 月份平移，如 shiftPeriod('2026-09', -1) → '2026-08'。 */
export function shiftPeriod(period, deltaMonths = 0) {
  const p = asStr(period);
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (!m) return '';
  let year = Number(m[1]);
  let month = Number(m[2]) - 1; // 0-based
  const total = year * 12 + month + (Number(deltaMonths) || 0);
  year = Math.floor(total / 12);
  month = total % 12;
  if (month < 0) { month += 12; year -= 1; }
  return `${year}-${pad2(month + 1)}`;
}

/** 上一月。 */
export function previousPeriod(period) {
  return shiftPeriod(period, -1);
}

/** 归一化单条 metric（丢弃脏字段，保结构稳定）。 */
export function normalizeMetric(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const value = asNum(r.value);
  return {
    label: asStr(r.label),
    value,
    display: r.display != null ? String(r.display) : (value != null ? String(value) : null),
    note: asStr(r.note),
    capturedAt: asStr(r.capturedAt) || new Date().toISOString(),
  };
}

/** 归一化单条 event。 */
export function normalizeEvent(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    label: asStr(r.label),
    kind: asStr(r.kind),
    at: asStr(r.at) || new Date().toISOString(),
  };
}

/** 归一化单期 entry（幂等）。 */
export function normalizeEntry(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const metrics = {};
  if (r.metrics && typeof r.metrics === 'object') {
    Object.keys(r.metrics)
      .slice(0, METRICS_MAX)
      .forEach((k) => {
        const m = normalizeMetric(r.metrics[k]);
        if (m.label || m.display != null || m.value != null) metrics[k] = m;
      });
  }
  const events = Array.isArray(r.events)
    ? r.events.map(normalizeEvent).filter((e) => e.label)
    : [];
  return {
    period: asStr(r.period),
    metrics,
    events,
    recordedAt: asStr(r.recordedAt) || new Date().toISOString(),
    updatedAt: asStr(r.updatedAt) || new Date().toISOString(),
  };
}

// ==================== 纯函数：期条目操作（不碰 localStorage，便于测试） ====================

/** 在 entries 里找某期（不存在返回 null）。 */
export function findPeriodEntry(entries, period) {
  const list = Array.isArray(entries) ? entries : [];
  return list.find((e) => e && e.period === period) || null;
}

/** 追加 / 覆盖一个 metric 到 entry（返回新 entry，不改原对象）。 */
export function upsertMetric(entry, metric) {
  const e = normalizeEntry(entry);
  const m = normalizeMetric(metric);
  const key = asStr(metric && metric.dimensionId) || m.label || 'metric';
  const metrics = { ...e.metrics };
  metrics[key] = { ...m, label: m.label || key };
  const keys = Object.keys(metrics);
  if (keys.length > METRICS_MAX) {
    keys.slice(0, keys.length - METRICS_MAX).forEach((k) => delete metrics[k]);
  }
  return { ...e, metrics, updatedAt: new Date().toISOString() };
}

/** 追加一个 event 到 entry（去重 + 上限裁剪）。 */
export function appendEvent(entry, event) {
  const e = normalizeEntry(entry);
  const ev = normalizeEvent(event);
  if (!ev.label) return e;
  if (e.events.some((x) => x.label === ev.label)) return e;
  let events = e.events.concat(ev);
  if (events.length > EVENTS_MAX) events = events.slice(events.length - EVENTS_MAX);
  return { ...e, events, updatedAt: new Date().toISOString() };
}

/**
 * 对比两期：metricChanges（同指标变化）+ newMetrics（本月新增）+ removedMetrics（上月有本月无）
 * + 两期 events。纯函数，供 buildTimelineText 与 UI 复用。
 */
export function comparePeriods(entries, curPeriod, prevPeriod) {
  const list = Array.isArray(entries) ? entries : [];
  const cur = findPeriodEntry(list, curPeriod);
  const prev = findPeriodEntry(list, prevPeriod);
  const curMetrics = cur ? cur.metrics : {};
  const prevMetrics = prev ? prev.metrics : {};

  const metricChanges = [];
  const newMetrics = [];
  const removedMetrics = [];
  const keys = new Set([...Object.keys(curMetrics), ...Object.keys(prevMetrics)]);
  keys.forEach((k) => {
    const c = curMetrics[k];
    const p = prevMetrics[k];
    if (c && p) {
      const label = c.label || p.label || k;
      let delta = null;
      let direction = 'unknown';
      if (c.value != null && p.value != null) {
        delta = c.value - p.value;
        direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      }
      metricChanges.push({
        dimensionId: k,
        label,
        prevValue: p.value,
        prevDisplay: p.display,
        currValue: c.value,
        currDisplay: c.display,
        delta,
        direction,
        prevNote: p.note,
        currNote: c.note,
      });
    } else if (c && !p) {
      newMetrics.push({ dimensionId: k, label: c.label || k, value: c.value, display: c.display, note: c.note });
    } else {
      removedMetrics.push({ dimensionId: k, label: p.label || k, value: p.value, display: p.display, note: p.note });
    }
  });

  return {
    current: cur,
    previous: prev,
    metricChanges,
    newMetrics,
    removedMetrics,
    currentEvents: cur ? cur.events : [],
    previousEvents: prev ? prev.events : [],
  };
}

/** 方向箭头（数值可比时）。 */
function arrow(direction) {
  return direction === 'up' ? '↑' : direction === 'down' ? '↓' : direction === 'flat' ? '→' : '';
}

/**
 * 内部共用拼装：把两期对比整理成「事实行」列表（不含任何给 AI 的指令）。
 * buildTimelineText（给 AI 看，含 head/foot）与 buildTimelineFacts（给用户看，纯事实）共用同一份
 * 事实行，避免两处复制粘贴导致口径漂移。
 * @returns {{curPeriod:string, prevPeriod:string, cmp:object, lines:string[]}|null} 无数据返回 null
 */
function timelineFactsPieces(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const curPeriod = asStr(opts.current) || currentPeriod(opts.now || new Date());
  const prevPeriod = asStr(opts.previous) || previousPeriod(curPeriod);
  if (!curPeriod || !prevPeriod) return null;

  const cmp = comparePeriods(list, curPeriod, prevPeriod);
  if (!cmp.current && !cmp.previous) return null;

  const lines = [];

  const metricLines = [];
  cmp.metricChanges.forEach((m) => {
    const pd = m.prevDisplay != null ? String(m.prevDisplay) : '—';
    const cd = m.currDisplay != null ? String(m.currDisplay) : '—';
    metricLines.push(`- ${m.label}：${pd} → ${cd} ${arrow(m.direction)}`.replace(/\s+$/, ''));
  });
  cmp.newMetrics.forEach((m) => {
    const d = m.display != null ? String(m.display) : '—';
    metricLines.push(`- ${m.label}：本月 ${d}（上月无记录）`);
  });
  cmp.removedMetrics.forEach((m) => {
    const d = m.display != null ? String(m.display) : '—';
    metricLines.push(`- ${m.label}：上月 ${d}（本月暂无）`);
  });
  if (metricLines.length) lines.push('· 关键指标变化：\n' + metricLines.join('\n'));

  if (cmp.currentEvents.length) {
    lines.push('· 本月做了什么：\n' + cmp.currentEvents.map((e) => `  - ${e.label}`).join('\n'));
  }

  if (lines.length === 0) return null;
  return { curPeriod, prevPeriod, cmp, lines };
}

/**
 * 把两期对比拼成给 AI 看的中文时间轴文本（事实层，不含判断）。
 * 含「【企业时间轴】…」标题 + 事实行 + 给 AI 的引导语（foot）。contextBuilder 依赖此输出，勿改行为。
 * @param {Array} entries loadTimeline 产物（或 k.timeline）
 * @param {{now?:Date|number, current?:string, previous?:string}} opts
 */
export function buildTimelineText(entries, opts = {}) {
  const p = timelineFactsPieces(entries, opts);
  if (!p) return '';
  const head = `【企业时间轴】按月记录企业做了什么、关键指标怎么变（本月 ${p.curPeriod} vs 上月 ${p.prevPeriod}）：`;
  const body = p.lines.join('\n');
  const foot = '（请结合以上时间轴变化，判断这些变化说明了什么问题、接下来该调整哪些经营动作。）';
  return `${head}\n${body}\n${foot}`;
}

/**
 * 只给用户看的事实文本：关键指标变化（X：上月值 → 本月值 ↑/↓）+ 本月做了什么。
 * 不含「【企业时间轴】」标题、不含给 AI 的 foot 引导语 —— 用于企业大脑时间轴区块的事实对比展示，
 * 避免把「写给 AI 的指令」当内容贴给用户看。
 * @param {Array} entries loadTimeline 产物（或 k.timeline）
 * @param {{now?:Date|number, current?:string, previous?:string}} opts
 * @returns {string} 无数据返回空串
 */
export function buildTimelineFacts(entries, opts = {}) {
  const p = timelineFactsPieces(entries, opts);
  if (!p) return '';
  return p.lines.join('\n');
}

// ==================== localStorage 读写边界 ====================

/** 读某企业时间轴（归一化，按 period 降序）。 */
export function loadTimeline(companyId) {
  const cid = asStr(companyId);
  const st = storage();
  if (!cid || !st) return [];
  try {
    const raw = st.getItem(TIMELINE_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw);
    const list =
      all && typeof all === 'object' && !Array.isArray(all) && Array.isArray(all[cid])
        ? all[cid]
        : [];
    return list
      .map(normalizeEntry)
      .filter((e) => e.period)
      .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  } catch {
    return [];
  }
}

/** 写某企业时间轴（整体覆盖 + 上限裁剪）。 */
export function saveTimeline(companyId, entries) {
  const cid = asStr(companyId);
  const st = storage();
  if (!cid || !st) return false;
  try {
    const raw = st.getItem(TIMELINE_KEY);
    let all = {};
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) all = p;
    }
    const list = (Array.isArray(entries) ? entries : [])
      .map(normalizeEntry)
      .filter((e) => e.period)
      .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0))
      .slice(0, PERIOD_MAX_MONTHS);
    all[cid] = list;
    st.setItem(TIMELINE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录一条关键指标（诊断结果），写入当前月（同 dimensionId 覆盖，取本月最新）。
 * @returns {Array} 写回后的时间轴
 */
export function recordMetric(companyId, metric, opts = {}) {
  const cid = asStr(companyId);
  if (!cid) return null;
  const m = normalizeMetric(metric);
  if (!(m.label || m.display != null || m.value != null)) return null;
  const period = asStr(opts.period) || currentPeriod(opts.now || new Date());
  if (!period) return null;

  const entries = loadTimeline(cid);
  const payload = {
    dimensionId: asStr(metric && metric.dimensionId) || m.label,
    label: m.label,
    value: m.value,
    display: m.display,
    note: m.note,
    capturedAt: m.capturedAt,
  };
  const existing = findPeriodEntry(entries, period);
  if (existing) {
    const idx = entries.findIndex((e) => e.period === period);
    entries[idx] = upsertMetric(existing, payload);
  } else {
    entries.push(upsertMetric({ period, metrics: {}, events: [] }, payload));
  }
  saveTimeline(cid, entries);
  return loadTimeline(cid);
}

/**
 * 记录一条「做了什么」事件，写入当前月（累计，去重）。
 * @returns {Array} 写回后的时间轴
 */
export function recordEvent(companyId, event, opts = {}) {
  const cid = asStr(companyId);
  if (!cid) return null;
  const ev = normalizeEvent(event);
  if (!ev.label) return null;
  const period = asStr(opts.period) || currentPeriod(opts.now || new Date());
  if (!period) return null;

  const entries = loadTimeline(cid);
  const existing = findPeriodEntry(entries, period);
  if (existing) {
    const idx = entries.findIndex((e) => e.period === period);
    entries[idx] = appendEvent(existing, ev);
  } else {
    entries.push(appendEvent({ period, metrics: {}, events: [] }, ev));
  }
  saveTimeline(cid, entries);
  return loadTimeline(cid);
}

/** 直接读某企业时间轴并拼对比文本（便捷入口，供无需走 getKnowledge 的调用方）。 */
export function buildTimelineContext(companyId, opts = {}) {
  return buildTimelineText(loadTimeline(companyId), opts);
}

export default {
  PERIOD_MAX_MONTHS,
  EVENTS_MAX,
  METRICS_MAX,
  currentPeriod,
  shiftPeriod,
  previousPeriod,
  normalizeMetric,
  normalizeEvent,
  normalizeEntry,
  findPeriodEntry,
  upsertMetric,
  appendEvent,
  comparePeriods,
  buildTimelineText,
  buildTimelineFacts,
  loadTimeline,
  saveTimeline,
  recordMetric,
  recordEvent,
  buildTimelineContext,
};
