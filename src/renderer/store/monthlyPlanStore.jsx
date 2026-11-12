/**
 * monthlyPlanStore —— 「月度计划（带真实日期节点）」数据层（localStorage 持久化，按企业隔离）。
 *
 * 设计依据：docs 月度计划需求（2026-09-10）。
 *
 * 数据模型（MonthlyPlanEntry，按企业存储）：
 *   { [companyId]: { nodes: Node[], updatedAt } }
 * Node = { id, date:'YYYY-MM-DD', endDate?, title, type?, note }
 *
 * 风格参考 directionStore.jsx：Provider + localStorage + 按企业隔离。
 */

import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';

const MONTHLY_PLANS_KEY = 'douya-monthly-plans';
// 「该企业是否已经被自动铺过一次方案」——按企业持久化。
// 必须持久化（不能用组件内 useRef）：TodayOps 带 key={companyId} 会在切模块/切企业时 remount，
// useRef 会重置，导致「用户把节点删光 → 切走再切回 → 整套方案自动复活」。老板要求删了就是删了。
const AUTO_PLANNED_KEY = 'douya-plan-autogen';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
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

/**
 * 节点归一化。**是白名单** —— 只有这里列出的字段会被持久化，其它一律丢弃。
 *
 * ⚠️ 加字段前必读：`saveNodes` / `addNode` / `updateNode` 三处写路径全都过这个函数，
 * 所以「调用方写了个新字段」不等于「字段存进去了」。新增字段必须同时加到这里。
 *
 * `taskId` 的由来：第一屏「今天这 N 件」把日历节点与项目任务合并展示，靠 `node.taskId`
 * 判断该节点是否已被「让豆芽做」变成了任务，从而**去重**（否则同一件事在首屏出现两遍）。
 * 它曾经不在白名单里 → 回写被静默丢弃 → 去重完全失效（2026-09-11 修复）。
 */
function normalizeNode(n) {
  const base = (n && typeof n === 'object') ? n : {};
  return {
    id: asStr(base.id) || uid(),
    date: asStr(base.date),
    endDate: asStr(base.endDate),
    title: asStr(base.title),
    type: asStr(base.type),
    note: asStr(base.note),
    taskId: asStr(base.taskId),
  };
}

function persist(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* 配额/隐私模式异常时静默，状态仍保留在内存 */
  }
}

const MonthlyPlanContext = createContext(null);

export function MonthlyPlanProvider({ children }) {
  const [plans, setPlans] = useState(() => loadJSON(MONTHLY_PLANS_KEY, {}));
  const [autoPlanned, setAutoPlanned] = useState(() => loadJSON(AUTO_PLANNED_KEY, {}));

  const getPlan = useCallback((companyId) => {
    if (!companyId) return [];
    const entry = plans[companyId];
    if (!entry || !Array.isArray(entry.nodes)) return [];
    return entry.nodes.map(normalizeNode);
  }, [plans]);

  const saveNodes = useCallback((companyId, nodes) => {
    if (!companyId) return;
    const arr = Array.isArray(nodes) ? nodes.map(normalizeNode) : [];
    setPlans((prev) => {
      const next = { ...prev, [companyId]: { nodes: arr, updatedAt: new Date().toISOString() } };
      persist(MONTHLY_PLANS_KEY, next);
      return next;
    });
  }, []);

  const addNode = useCallback((companyId, node) => {
    if (!companyId) return null;
    const norm = normalizeNode(node);
    setPlans((prev) => {
      const prevNodes = prev[companyId] && Array.isArray(prev[companyId].nodes) ? prev[companyId].nodes : [];
      const next = { ...prev, [companyId]: { nodes: [...prevNodes, norm], updatedAt: new Date().toISOString() } };
      persist(MONTHLY_PLANS_KEY, next);
      return next;
    });
    return norm;
  }, []);

  const removeNode = useCallback((companyId, id) => {
    if (!companyId || !id) return;
    setPlans((prev) => {
      const prevNodes = prev[companyId] && Array.isArray(prev[companyId].nodes) ? prev[companyId].nodes : [];
      const next = { ...prev, [companyId]: { nodes: prevNodes.filter((n) => n.id !== id), updatedAt: new Date().toISOString() } };
      persist(MONTHLY_PLANS_KEY, next);
      return next;
    });
  }, []);

  /**
   * 该企业是否已经「自动铺过一次」方案。
   * 一旦为 true，TodayOps 的自动铺排 effect 永不再触发（即使用户把节点全删光）。
   * 用户仍可通过「让豆芽给一套方案」按钮手动重铺。
   */
  const hasAutoPlanned = useCallback((companyId) => {
    if (!companyId) return false;
    return autoPlanned[companyId] === true;
  }, [autoPlanned]);

  /** 标记该企业已自动铺过方案（持久化，跨 remount / 重启有效）。 */
  const markAutoPlanned = useCallback((companyId) => {
    if (!companyId) return;
    setAutoPlanned((prev) => {
      if (prev[companyId] === true) return prev;
      const next = { ...prev, [companyId]: true };
      persist(AUTO_PLANNED_KEY, next);
      return next;
    });
  }, []);

  /**
   * 局部更新一个节点（日历上「改期 / 改名 / 改说明 / 改类型」用）。
   * id 不可被 patch 覆盖；patch 只合并进匹配到的那个节点，其余节点原样保留。
   */
  const updateNode = useCallback((companyId, id, patch) => {
    if (!companyId || !id) return;
    const safePatch = patch && typeof patch === 'object' ? patch : {};
    setPlans((prev) => {
      const prevNodes = prev[companyId] && Array.isArray(prev[companyId].nodes) ? prev[companyId].nodes : [];
      const nextNodes = prevNodes.map((n) =>
        n && n.id === id ? normalizeNode({ ...n, ...safePatch, id: n.id }) : n,
      );
      const next = { ...prev, [companyId]: { nodes: nextNodes, updatedAt: new Date().toISOString() } };
      persist(MONTHLY_PLANS_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ plans, getPlan, saveNodes, addNode, updateNode, removeNode, hasAutoPlanned, markAutoPlanned }),
    [plans, getPlan, saveNodes, addNode, updateNode, removeNode, hasAutoPlanned, markAutoPlanned],
  );

  return <MonthlyPlanContext.Provider value={value}>{children}</MonthlyPlanContext.Provider>;
}

export function useMonthlyPlan() {
  const ctx = useContext(MonthlyPlanContext);
  if (!ctx) throw new Error('useMonthlyPlan 必须在 MonthlyPlanProvider 内使用');
  return ctx;
}

export default {
  MONTHLY_PLANS_KEY,
  AUTO_PLANNED_KEY,
  MonthlyPlanProvider,
  useMonthlyPlan,
};
