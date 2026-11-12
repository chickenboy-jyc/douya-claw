import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/**
 * dailyOpsStore —— 第六阶段「日常运营工作台」数据层。
 *
 * 两个独立集合，均按「企业」隔离（companyId），localStorage key 前缀 douya-：
 * - DailyTask（日常运营任务）：与 Project Task 分开，默认不绑定项目（projectId 可空）。
 * - Community（社群）：运营人员维护的微信群/患者群/经销商群等。
 *
 * 与 Project Task 的边界：Project Task 是「项目制、有明确周期目标」的工作；
 * DailyTask 是「每天/每周重复发生」的运营动作，两者可关联但不互相依赖。
 */

export const DAILY_TASKS_KEY = 'douya-daily-tasks';
export const COMMUNITIES_KEY = 'douya-communities';

/** DailyTask.type 枚举。 */
export const DAILY_TASK_TYPES = {
  moments: '朋友圈',
  community: '社群',
  social_post: '小红书/社媒',
  article: '公众号文章',
  video: '视频',
  event: '社群活动',
  layout: '内容排版',
  other: '其他',
};

/** DailyTask.status 统一五态。 */
export const DAILY_TASK_STATUS = {
  todo: '待办',
  doing: '进行中',
  review: '待审核',
  done: '已完成',
  skipped: '已跳过',
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
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

/** 归一化 DailyTask：补默认字段，兼容 snake_case。 */
export function normalizeDailyTask(t) {
  const base = t && typeof t === 'object' ? t : {};
  return {
    id: asStr(base.id),
    companyId: asStr(base.companyId || base.company_id),
    projectId: base.projectId == null && base.project_id == null ? null : asStr(base.projectId || base.project_id),
    type: Object.prototype.hasOwnProperty.call(DAILY_TASK_TYPES, base.type) ? base.type : (base.type || 'other'),
    title: asStr(base.title) || '未命名任务',
    channel: asStr(base.channel),
    scheduledAt: asStr(base.scheduledAt || base.scheduled_at),
    status: Object.prototype.hasOwnProperty.call(DAILY_TASK_STATUS, base.status) ? base.status : 'todo',
    content: base.content == null ? null : base.content,
    assetId: base.assetId == null ? null : asStr(base.assetId),
    createdBy: asStr(base.createdBy || base.created_by),
    createdAt: base.createdAt || base.created_at || Date.now(),
    updatedAt: base.updatedAt || base.updated_at || base.createdAt || Date.now(),
  };
}

/** 归一化 Community。 */
export function normalizeCommunity(c) {
  const base = c && typeof c === 'object' ? c : {};
  return {
    id: asStr(base.id),
    companyId: asStr(base.companyId || base.company_id),
    name: asStr(base.name) || '未命名社群',
    type: asStr(base.type),
    audience: asStr(base.audience || base.target_audience),
    positioning: asStr(base.positioning),
    topics: asArray(base.topics),
    notes: asStr(base.notes),
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || base.createdAt || Date.now(),
  };
}

const DailyTasksContext = createContext(null);
const CommunitiesContext = createContext(null);

export function DailyOpsProvider({ children }) {
  const [dailyTasks, setDailyTasks] = useState(() =>
    (Array.isArray(loadJSON(DAILY_TASKS_KEY, [])) ? loadJSON(DAILY_TASKS_KEY, []) : []).map(normalizeDailyTask),
  );
  const [communities, setCommunities] = useState(() =>
    (Array.isArray(loadJSON(COMMUNITIES_KEY, [])) ? loadJSON(COMMUNITIES_KEY, []) : []).map(normalizeCommunity),
  );

  useEffect(() => {
    try { localStorage.setItem(DAILY_TASKS_KEY, JSON.stringify(dailyTasks)); } catch { /* 忽略写失败 */ }
  }, [dailyTasks]);

  useEffect(() => {
    try { localStorage.setItem(COMMUNITIES_KEY, JSON.stringify(communities)); } catch { /* 忽略写失败 */ }
  }, [communities]);

  // ---------- DailyTask ----------
  const addDailyTask = useCallback((input) => {
    const t = normalizeDailyTask({ ...(input || {}), id: input && input.id ? input.id : uid(), createdAt: Date.now(), updatedAt: Date.now() });
    setDailyTasks((prev) => [...prev, t]);
    return t;
  }, []);

  const updateDailyTask = useCallback((id, patch) => {
    setDailyTasks((prev) => prev.map((t) => (t.id === id ? normalizeDailyTask({ ...t, ...(patch || {}), updatedAt: Date.now() }) : t)));
  }, []);

  const removeDailyTask = useCallback((id) => {
    setDailyTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const setDailyTaskStatus = useCallback((id, status) => {
    setDailyTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: status || 'todo', updatedAt: Date.now() } : t)));
  }, []);

  /** 按归属查询：companyId 必填，projectId 可空（null 表示不筛），可选 status/type 过滤。 */
  const listDailyTasks = useCallback(({ companyId, projectId, status, type } = {}) => {
    let list = dailyTasks;
    if (companyId) list = list.filter((t) => t.companyId === companyId);
    if (projectId != null) list = list.filter((t) => t.projectId === projectId);
    if (status) list = list.filter((t) => t.status === status);
    if (type) list = list.filter((t) => t.type === type);
    return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [dailyTasks]);

  // ---------- Community ----------
  const addCommunity = useCallback((input) => {
    const c = normalizeCommunity({ ...(input || {}), id: input && input.id ? input.id : uid(), createdAt: Date.now(), updatedAt: Date.now() });
    setCommunities((prev) => [...prev, c]);
    return c;
  }, []);

  const updateCommunity = useCallback((id, patch) => {
    setCommunities((prev) => prev.map((c) => (c.id === id ? normalizeCommunity({ ...c, ...(patch || {}), updatedAt: Date.now() }) : c)));
  }, []);

  const removeCommunity = useCallback((id) => {
    setCommunities((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const listCommunities = useCallback(({ companyId } = {}) => {
    let list = communities;
    if (companyId) list = list.filter((c) => c.companyId === companyId);
    return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [communities]);

  const tasksValue = useMemo(
    () => ({ dailyTasks, addDailyTask, updateDailyTask, removeDailyTask, setDailyTaskStatus, listDailyTasks }),
    [dailyTasks, addDailyTask, updateDailyTask, removeDailyTask, setDailyTaskStatus, listDailyTasks],
  );
  const communitiesValue = useMemo(
    () => ({ communities, addCommunity, updateCommunity, removeCommunity, listCommunities }),
    [communities, addCommunity, updateCommunity, removeCommunity, listCommunities],
  );

  return (
    <DailyTasksContext.Provider value={tasksValue}>
      <CommunitiesContext.Provider value={communitiesValue}>{children}</CommunitiesContext.Provider>
    </DailyTasksContext.Provider>
  );
}

export function useDailyTasks() {
  const ctx = useContext(DailyTasksContext);
  if (!ctx) throw new Error('useDailyTasks 必须在 <DailyOpsProvider> 子树内使用');
  return ctx;
}

export function useCommunities() {
  const ctx = useContext(CommunitiesContext);
  if (!ctx) throw new Error('useCommunities 必须在 <DailyOpsProvider> 子树内使用');
  return ctx;
}

export default DailyOpsProvider;
