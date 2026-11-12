/**
 * directionStore —— 「经营方案」数据层（localStorage 持久化，按企业隔离）。
 *
 * 设计依据：docs/First-run-SQP-经营方案-v1.md（2026-09-10）、
 *          docs/IA设计定稿-20260912-信息架构重排.md §5.1（2026-09-12）。
 *
 * 数据模型（Direction）：
 *   id / companyId / name / key / summary / expectedPeriodDays
 *   status('active'|'paused') / campaignIds[] / deliveryPlan{content,media,case}
 *   actions[] / monitor[] / createdAt / activatedAt / pausedAt
 *   planSteps[]    —— 引导执行的阶段清单（新增，2026-09-12）
 *   planProgress{} —— 勾选完成态 { [checklistItemId]: true }（新增，2026-09-12）
 *
 * 历史不丢（红线）：换方向 = 旧 Direction 转 paused，保留历史；新方向 status=active。
 *   Direction 是一级对象，Campaign 是它下面的执行对象（campaignIds 关联）。
 *
 * 单写者约定：本 store 只有一个写入方（经营方案页），走普通 setState + 落盘 useEffect，
 *   不需要 activityStore / campaignStore 那套 commit* 出口（不引入新范式）。
 */

import React, { createContext, useContext, useMemo, useState, useCallback, useEffect } from 'react';
import { syncConclusionToKnowledge } from './companyKnowledgeStore.jsx';

const DIRECTIONS_KEY = 'douya-directions';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadJSON(key, fallback) {
  try {
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

/** 归一化单个引导动作（PlanAction）：{ id, title, deliverable, execModule }。 */
function normalizePlanAction(a, stepId, idx) {
  const o = a && typeof a === 'object' ? a : {};
  const id = asStr(o.id) || `${stepId || 'step'}-a${idx + 1}`;
  return {
    id,
    title: asStr(o.title),
    deliverable: asStr(o.deliverable),
    execModule: asStr(o.execModule),
  };
}

/** 归一化单个引导阶段（PlanStep）：{ id, title, goal, actions[] }。 */
function normalizePlanStep(s, idx) {
  const o = s && typeof s === 'object' ? s : {};
  const id = asStr(o.id) || `step-${idx + 1}`;
  return {
    id,
    title: asStr(o.title),
    goal: asStr(o.goal),
    actions: (Array.isArray(o.actions) ? o.actions : []).map((a, i) => normalizePlanAction(a, id, i)),
  };
}

/** 归一化 planSteps：非数组 → []；丢弃既无标题又无动作的空阶段。 */
function normalizePlanSteps(v) {
  return (Array.isArray(v) ? v : [])
    .map((s, i) => normalizePlanStep(s, i))
    .filter((s) => s.title || s.actions.length > 0);
}

/** 归一化 planProgress：只保留值为真的键，键一律转字符串（防 JSON 往返后类型漂移）。 */
function normalizePlanProgress(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const k of Object.keys(v)) {
    if (v[k]) out[String(k)] = true;
  }
  return out;
}

function normalizeDirection(d) {
  const base = (d && typeof d === 'object') ? d : {};
  return {
    id: asStr(base.id) || uid(),
    companyId: asStr(base.companyId),
    name: asStr(base.name),
    key: asStr(base.key),
    summary: asStr(base.summary),
    expectedPeriodDays: Number(base.expectedPeriodDays) || 0,
    // 诊断化（用户 2026-09-10 定调「运营方案要指出问题/怎么优化/多久达标」）
    problems: Array.isArray(base.problems) ? base.problems : [],
    optimization: Array.isArray(base.optimization) ? base.optimization : [],
    targetCycleDays: Number(base.targetCycleDays) || 0,
    status: base.status === 'paused' ? 'paused' : 'active',
    campaignIds: Array.isArray(base.campaignIds) ? base.campaignIds.filter((x) => typeof x === 'string') : [],
    deliveryPlan: (base.deliveryPlan && typeof base.deliveryPlan === 'object') ? { ...base.deliveryPlan } : null,
    actions: Array.isArray(base.actions) ? base.actions : [],
    monitor: Array.isArray(base.monitor) ? base.monitor : [],
    // 引导执行（2026-09-12 老板第 3 条：方案要「一步步引导完成」）
    planSteps: normalizePlanSteps(base.planSteps),
    planProgress: normalizePlanProgress(base.planProgress),
    createdAt: asStr(base.createdAt),
    activatedAt: asStr(base.activatedAt),
    pausedAt: asStr(base.pausedAt),
  };
}

const DirectionContext = createContext(null);

export function DirectionProvider({ children }) {
  const [directions, setDirections] = useState(() => loadJSON(DIRECTIONS_KEY, []).map(normalizeDirection));

  // 写盘：与 campaignStore 同款约定。
  // 【为什么必须显式写】此前本 store 只 setState、从不落盘 → 用户选完经营方向后
  // 一旦刷新/重启就丢了（而日历节点在 monthlyPlanStore 里是落盘的，于是出现
  // 「日历上还留着 cal-brand-* 节点，但经营方向对象不见了」的数据不一致）。
  // 因为首登的 onDone 把 directionKey 通过信号传给了 TodayOps、铺排走的是
  // douya-monthly-plans，所以这个丢失长期被掩盖 —— 没有测试会发现。
  // 【2026-09-12】planProgress（checklist 勾选态）也走这条 effect 落盘，刷新不丢。
  useEffect(() => {
    try {
      localStorage.setItem(DIRECTIONS_KEY, JSON.stringify(directions));
    } catch {
      /* 忽略写失败（隐私模式 / 配额） */
    }
  }, [directions]);

  const listDirections = useCallback(({ companyId } = {}) => {
    if (!companyId) return [];
    return directions.filter((d) => d.companyId === companyId);
  }, [directions]);

  const getDirection = useCallback((id) => directions.find((d) => d.id === id) || null, [directions]);

  const getActiveDirection = useCallback((companyId) => {
    if (!companyId) return null;
    return directions.find((d) => d.companyId === companyId && d.status === 'active') || null;
  }, [directions]);

  const createDirection = useCallback((dir) => {
    const norm = normalizeDirection({ ...dir, id: dir && dir.id ? dir.id : uid() });
    setDirections((prev) => [...prev, norm]);
    // 阶段E：经营方向回流企业档案（memories），让 AI 记住「公司当前经营方向 + 问题诊断」
    if (norm.companyId) {
      const content = [
        norm.summary,
        norm.problems && norm.problems.length ? '问题：' + norm.problems.join('；') : '',
        norm.optimization && norm.optimization.length ? '优化：' + norm.optimization.join('；') : '',
      ].filter(Boolean).join('。');
      syncConclusionToKnowledge(norm.companyId, { label: '经营方向', name: norm.name, content });
    }
    return norm;
  }, []);

  const updateDirection = useCallback((id, patch) => {
    setDirections((prev) => prev.map((d) => (d.id === id ? normalizeDirection({ ...d, ...(patch || {}), id: d.id, companyId: d.companyId }) : d)));
  }, []);

  /** 换方向：旧 active → paused（历史保留），新方向 active。 */
  const activateDirection = useCallback((companyId, id) => {
    setDirections((prev) => prev.map((d) => {
      if (d.companyId !== companyId) return d;
      if (d.id === id) return { ...d, status: 'active', activatedAt: new Date().toISOString(), pausedAt: '' };
      if (d.status === 'active') return { ...d, status: 'paused', pausedAt: new Date().toISOString() };
      return d;
    }));
  }, []);

  /**
   * 勾选 / 取消勾选引导 checklist 的某一项（老板第 3 条：一步步引导完成）。
   *
   * 契约（IA 定稿 §4.5 #5）：updatePlanProgress(directionId, { stepId, done })。
   * 兼容 `itemId` / `id` 两种字段名；`stepId` 指 checklist 条目的 id（= 动作 id）。
   * 写盘由既有落盘 useEffect（上方）承担 —— 刷新/重启不丢。
   *
   * @param {string} directionId 目标方向 id
   * @param {{stepId?:string, itemId?:string, id?:string, done?:boolean}} patch
   */
  const updatePlanProgress = useCallback((directionId, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const itemId = asStr(p.stepId) || asStr(p.itemId) || asStr(p.id);
    if (!directionId || !itemId) return;
    const done = p.done === undefined ? true : !!p.done;
    setDirections((prev) => prev.map((d) => {
      if (d.id !== directionId) return d;
      const progress = { ...(d.planProgress || {}) };
      if (done) progress[itemId] = true;
      else delete progress[itemId];
      return { ...d, planProgress: progress };
    }));
  }, []);

  /** 挂载 Campaign 到方向。 */
  const attachCampaign = useCallback((directionId, campaignId) => {
    setDirections((prev) => prev.map((d) => {
      if (d.id !== directionId) return d;
      if (d.campaignIds.includes(campaignId)) return d;
      return { ...d, campaignIds: [...d.campaignIds, campaignId] };
    }));
  }, []);

  const value = useMemo(() => ({
    directions,
    listDirections,
    getDirection,
    getActiveDirection,
    createDirection,
    updateDirection,
    activateDirection,
    updatePlanProgress,
    attachCampaign,
  }), [directions, listDirections, getDirection, getActiveDirection, createDirection, updateDirection, activateDirection, updatePlanProgress, attachCampaign]);

  return <DirectionContext.Provider value={value}>{children}</DirectionContext.Provider>;
}

export function useDirection() {
  const ctx = useContext(DirectionContext);
  if (!ctx) throw new Error('useDirection 必须在 DirectionProvider 内使用');
  return ctx;
}

export default {
  DIRECTIONS_KEY,
  DirectionProvider,
  useDirection,
  normalizeDirection,
};
