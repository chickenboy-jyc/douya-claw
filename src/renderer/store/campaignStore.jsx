import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ACTIVITY_SUBJECTS,
  DEFAULT_SUBJECT,
} from '../config/activitySubjects.js';
import { syncConclusionToKnowledge } from './companyKnowledgeStore.jsx';

/**
 * campaignStore —— 「营销专项」Campaign Engine 数据层（设计文档 docs/营销专项-设计定稿.md v3）。
 *
 * 定位（v3 §0 强卡）：营销专项 ≠ 活动策划页、≠ AI 项目管理工具。
 * 结构 = 为什么现在打 → 这场仗要改变什么 → 豆芽准备怎么打 → 豆芽正在推进（它自己做 / 需要你决定）→ 结果怎么样。
 *
 * 与 activityStore 的关系：**完全独立**，不 import useActivity，不共享集合。
 * 七步「活动总监」降级为「高级设置」，其 Activity 模型继续由 activityStore 管，本 store 只管 Campaign。
 * 复用点：4 主体模型（ACTIVITY_SUBJECTS）、normalize 工具模式、douya- 前缀 localStorage。
 *
 * ── 红线约束（v3，实现自检点）─────────────────────────────────────────
 * 【红线 1｜AI 假设永远带标签】brief.assumptions 是 AI 推导的假设，UI 必须渲染「AI假设」标签，
 *   不得在后续页面把假设写成事实（v3 §0.1 全产品可信度机制）。
 * 【红线 2｜数据诚实】无真实数据写「暂无数据」，不编造；结果三层（业务/声势/传播）分离，
 *   「发了 6 篇内容」是传播计划不是业务结果（v3 §6.2 结果 ≠ 计划）。
 * 【红线 3｜每动作回答为什么】CampaignAction.why 必填，无法解释因果的动作不落库（v3 §6.6）。
 * 【红线 4｜复盘沉淀】reviewed 态必须带 review（结果 → 学到什么 → 进企业大脑，v3 §8）。
 * ──────────────────────────────────────────────────────────────────
 */

export const CAMPAIGNS_KEY = 'douya-campaigns';

/**
 * 专项生命周期（v3 §8）：5 态。
 * planning（规划中，一句话生成后老板确认前）→ preparing（筹备）→ ongoing（进行）→ ended（收尾）→ reviewed（已复盘）。
 */
export const CAMPAIGN_STATUS = {
  planning: '规划中',
  preparing: '筹备中',
  ongoing: '进行中',
  ended: '已结束',
  reviewed: '已复盘',
};

/** 生命周期流转白名单（v3 §8 状态机）。reviewed 为终态。 */
export const CAMPAIGN_STATUS_TRANSITIONS = {
  planning: ['preparing'],
  preparing: ['ongoing', 'planning'],
  ongoing: ['ended', 'preparing'],
  ended: ['reviewed', 'ongoing'],
  reviewed: [],
};

/** 专项类型（v3 §4，7 类，可扩展）。 */
export const CAMPAIGN_TYPES = {
  expo: '展会营销',
  launch: '新品上市',
  academic: '学术活动',
  content: '内容传播',
  crisis: '舆情应对',
  channel: '渠道招商',
  patient: '患者获客',
};

/** 动作责任人（v3 §6.4 + 豆芽执行协议：豆芽判断+执行 / 需要老板决定）。 */
export const CAMPAIGN_ACTION_OWNER = { douya: '豆芽', boss: '需要你决定' };
/** 动作状态。 */
export const CAMPAIGN_ACTION_STATUS = { todo: '待办', doing: '进行中', done: '已完成', blocked: '阻塞' };

/** 决策状态（v3 §6.4「需要你决定」）。 */
export const CAMPAIGN_DECISION_STATUS = { pending: '待确认', resolved: '已确认' };

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
function asStrArr(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x) : [];
}
function asObjList(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').map((x) => ({ ...x })) : [];
}
function asPlainObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function asNumOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** 主体白名单：非法/空值兜底 DEFAULT_SUBJECT，不猜测。 */
function normalizeSubjectType(v) {
  const key = asStr(v);
  return Object.prototype.hasOwnProperty.call(ACTIVITY_SUBJECTS, key) ? key : DEFAULT_SUBJECT;
}
function normalizeStatus(v) {
  const key = asStr(v);
  return Object.prototype.hasOwnProperty.call(CAMPAIGN_STATUS, key) ? key : 'planning';
}
function normalizeType(v) {
  const key = asStr(v);
  return Object.prototype.hasOwnProperty.call(CAMPAIGN_TYPES, key) ? key : '';
}
/** 偏离等级白名单（驾驶舱排序信号，none = 无可靠基线，不升档）。 */
function normalizeDeviation(v) {
  const key = asStr(v);
  return ['high', 'mid', 'low', 'none'].indexOf(key) >= 0 ? key : 'none';
}
/** 业务影响白名单。 */
function normalizeImpact(v) {
  const key = asStr(v);
  return ['high', 'mid', 'low'].indexOf(key) >= 0 ? key : 'mid';
}

/** 归一化初始 Brief（一句话意图 / 今日判断 / 市场回流带入，v3 §3）。 */
function normalizeBrief(b) {
  const base = asPlainObj(b) || {};
  return {
    intent: asStr(base.intent),
    problem: asStr(base.problem),
    evidence: asStrArr(base.evidence),
    suggestion: asStr(base.suggestion),
    source: asStr(base.source), // 'today_judgment' | 'market_momentum' | 'user'
    sourceChangeId: base.sourceChangeId == null ? null : asStr(base.sourceChangeId),
    // 红线 1：AI 推导的假设，显式列表，UI 必渲染「AI假设」标签
    assumptions: asStrArr(base.assumptions),
  };
}

/** 归一化 ① 为什么现在打（v3 §6.1：已确认事实 + 豆芽判断结论，数据诚实）。 */
function normalizeWhyNow(w) {
  const base = asPlainObj(w) || {};
  return { facts: asStrArr(base.facts), conclusion: asStr(base.conclusion) };
}

/** 归一化 ② 改变什么（v3 §6.2：业务结果 / 声势结果 / 传播计划，三层分离）。 */
function normalizeOutcomes(o) {
  const base = asPlainObj(o) || {};
  return {
    businessOutcome: asStr(base.businessOutcome),
    momentumOutcome: asStr(base.momentumOutcome),
    deliveryPlan: asStr(base.deliveryPlan),
  };
}

/** 归一化 ③ 阶段（v3 §6.3：带时间的阶段计划）。 */
function normalizeStage(s) {
  const base = asPlainObj(s) || {};
  return {
    key: asStr(base.key) || uid(),
    name: asStr(base.name),
    startDate: asStr(base.startDate),
    endDate: asStr(base.endDate),
    milestones: asStrArr(base.milestones),
  };
}

/** 归一化 ④ 动作（v3 §6.4 / §6.6：owner 明确 + why 必答）。 */
function normalizeAction(a) {
  const base = asPlainObj(a) || {};
  return {
    id: asStr(base.id) || uid(),
    title: asStr(base.title),
    owner: base.owner === 'boss' ? 'boss' : 'douya',
    status: Object.prototype.hasOwnProperty.call(CAMPAIGN_ACTION_STATUS, base.status) ? base.status : 'todo',
    why: asStr(base.why), // 红线 3：每个动作回答「为什么现在做」
  };
}

/** 归一化 ④ 决策（v3 §6.4「需要你决定」）。 */
function normalizeDecision(d) {
  const base = asPlainObj(d) || {};
  return {
    id: asStr(base.id) || uid(),
    title: asStr(base.title),
    status: base.status === 'resolved' ? 'resolved' : 'pending',
    result: asStr(base.result),
  };
}

/** 归一化 ⑤ 专项结果（v3 §6.5：执行进度 + 经营结果两层）。 */
function normalizeResults(r) {
  const base = asPlainObj(r) || {};
  return {
    executionDone: Math.max(0, asNumOrNull(base.executionDone) || 0),
    executionTotal: Math.max(0, asNumOrNull(base.executionTotal) || 0),
    businessOutcome: asStr(base.businessOutcome),
    momentumOutcome: asStr(base.momentumOutcome),
  };
}

/** 归一化 复盘（v3 §8：结果 → 学到什么 → 进企业大脑，红线 4）。 */
function normalizeReview(r) {
  const base = asPlainObj(r);
  if (!base) return null;
  return {
    learned: asStrArr(base.learned),
    intoBrain: asStrArr(base.intoBrain),
    generatedAt: asStr(base.generatedAt) || new Date().toISOString(),
  };
}

/**
 * 归一化 Campaign（v3 数据契约，字段以设计文档为唯一事实源）。
 */
export function normalizeCampaign(c) {
  const base = asPlainObj(c) || {};
  const id = asStr(base.id) || uid();
  const companyId = asStr(base.companyId || base.company_id);
  return {
    id,
    companyId,
    subjectType: normalizeSubjectType(base.subjectType),
    subjectLabel: asStr(base.subjectLabel),
    type: normalizeType(base.type),
    name: asStr(base.name).trim() || '未命名专项',
    // 专项整体时间范围（P2-E 高级设置基本信息；与 stages 各阶段时间互补，非替代）
    startDate: asStr(base.startDate),
    endDate: asStr(base.endDate),
    brief: normalizeBrief(base.brief),
    whyNow: normalizeWhyNow(base.whyNow),
    outcomes: normalizeOutcomes(base.outcomes),
    stages: asObjList(base.stages).map(normalizeStage),
    actions: asObjList(base.actions).map(normalizeAction),
    decisions: asObjList(base.decisions).map(normalizeDecision),
    results: normalizeResults(base.results),
    review: normalizeReview(base.review),
    status: normalizeStatus(base.status),
    // 经营信号（驾驶舱排序信号源，v3 驾驶舱 v1）：暂无可靠基线时 deviation='none' 不升档，数据诚实
    deviation: normalizeDeviation(base.deviation),
    businessImpact: normalizeImpact(base.businessImpact),
    criticalNodeAt: base.criticalNodeAt ? asStr(base.criticalNodeAt) : null,
    correctionRequiredHours: asNumOrNull(base.correctionRequiredHours) || 0,
    canAutoCorrect: base.canAutoCorrect !== false,
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || base.createdAt || Date.now(),
  };
}

const CampaignsContext = createContext(null);

export function CampaignProvider({ children }) {
  const [campaigns, setCampaigns] = useState(() => loadJSON(CAMPAIGNS_KEY, []).map(normalizeCampaign));
  const campaignsRef = useRef(campaigns);

  /**
   * 提交 campaigns 的唯一出口（红线，改动本文件前必读）。
   *
   * campaignsRef 原本只在下面的 useEffect 里同步，而 effect 要等渲染提交后才跑。
   * 后果：`setCampaigns(...)` 之后的那次渲染里，listCampaigns / getCampaign 读到的
   * 还是**上一轮的旧数组**（营销专项新建 / 状态流转后列表不刷新、刚建的专项点不进去），
   * 要等别的原因再触发一次渲染才补上，用户得切模块再回来。
   *
   * 因此：**任何写 campaigns 的地方都必须走 commitCampaigns，禁止直接 setCampaigns**。
   * 签名与 useState 的 setter 一致（支持值 / updater 函数两种形式），可原地替换。
   */
  const commitCampaigns = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(campaignsRef.current) : updater;
    campaignsRef.current = next;
    setCampaigns(next);
    return next;
  }, []);

  useEffect(() => {
    campaignsRef.current = campaigns;
    try {
      localStorage.setItem(CAMPAIGNS_KEY, JSON.stringify(campaigns));
    } catch {
      /* 忽略写失败（隐私模式 / 配额） */
    }
  }, [campaigns]);

  // ---- 查询 ----
  const listCampaigns = useCallback(({ companyId, status } = {}) => {
    let list = campaignsRef.current;
    if (companyId) list = list.filter((c) => c.companyId === companyId);
    if (status) list = list.filter((c) => c.status === status);
    return list.slice().sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  }, []);

  const getCampaign = useCallback((id) => campaignsRef.current.find((c) => c.id === id) || null, []);

  // ---- CRUD ----
  const createCampaign = useCallback((payload) => {
    const src = asPlainObj(payload) || {};
    if (!asStr(src.companyId) || !asStr(src.subjectType)) return null;
    const now = Date.now();
    const c = normalizeCampaign({ ...src, id: uid(), status: src.status || 'planning', createdAt: now, updatedAt: now });
    commitCampaigns((prev) => [...prev, c]);
    // 阶段E：营销专项回流企业档案（memories），让 AI 记住「我们在打什么、为什么打、要改变什么」
    const content = [
      c.whyNow && c.whyNow.conclusion ? '为什么打：' + c.whyNow.conclusion : '',
      c.outcomes && c.outcomes.businessOutcome ? '要改变：' + c.outcomes.businessOutcome : '',
    ].filter(Boolean).join('。');
    syncConclusionToKnowledge(c.companyId, { label: '营销专项', name: c.name, content });
    return c;
  }, [commitCampaigns]);

  const updateCampaign = useCallback((id, patch) => {
    commitCampaigns((prev) =>
      prev.map((c) => (c.id === id ? normalizeCampaign({ ...c, ...(asPlainObj(patch) || {}), id: c.id, companyId: c.companyId, updatedAt: Date.now() }) : c)),
    );
  }, [commitCampaigns]);

  const deleteCampaign = useCallback((id) => {
    commitCampaigns((prev) => prev.filter((c) => c.id !== id));
  }, [commitCampaigns]);

  // ---- 生命周期（v3 §8，带流转白名单校验）----
  const setCampaignStatus = useCallback((id, status) => {
    if (!Object.prototype.hasOwnProperty.call(CAMPAIGN_STATUS, status)) return false;
    const c = campaignsRef.current.find((x) => x.id === id);
    if (!c) return false;
    if (c.status !== status && (CAMPAIGN_STATUS_TRANSITIONS[c.status] || []).indexOf(status) === -1) return false;
    commitCampaigns((prev) => prev.map((x) => (x.id === id ? { ...x, status, updatedAt: Date.now() } : x)));
    return true;
  }, [commitCampaigns]);

  /** 老板确认草案 → 筹备中（planning → preparing）。 */
  const confirmCampaign = useCallback((id) => setCampaignStatus(id, 'preparing'), [setCampaignStatus]);
  /** 开始执行（preparing → ongoing）。 */
  const startCampaign = useCallback((id) => setCampaignStatus(id, 'ongoing'), [setCampaignStatus]);
  /** 结束（ongoing → ended）。 */
  const endCampaign = useCallback((id) => setCampaignStatus(id, 'ended'), [setCampaignStatus]);

  /** 复盘（ended → reviewed + 落 review，红线 4：结果 → 学到什么 → 进企业大脑）。 */
  const reviewCampaign = useCallback((id, reviewPayload) => {
    const target = campaignsRef.current.find((c) => c.id === id);
    if (!target) return false;
    const review = normalizeReview(reviewPayload);
    if (!review) return false;
    commitCampaigns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, review, status: 'reviewed', updatedAt: Date.now() } : c)),
    );
    return true;
  }, [commitCampaigns]);

  // ---- 动作 / 决策 ----
  const upsertAction = useCallback((campaignId, action) => {
    const src = asPlainObj(action) || {};
    if (!asStr(src.title)) return false;
    const norm = normalizeAction(src);
    commitCampaigns((prev) =>
      prev.map((c) => {
        if (c.id !== campaignId) return c;
        const exists = c.actions.some((a) => a.id === norm.id);
        return { ...c, actions: exists ? c.actions.map((a) => (a.id === norm.id ? norm : a)) : [...c.actions, norm], updatedAt: Date.now() };
      }),
    );
    return true;
  }, [commitCampaigns]);

  const upsertDecision = useCallback((campaignId, decision) => {
    const src = asPlainObj(decision) || {};
    if (!asStr(src.title)) return false;
    const norm = normalizeDecision(src);
    commitCampaigns((prev) =>
      prev.map((c) => {
        if (c.id !== campaignId) return c;
        const exists = c.decisions.some((d) => d.id === norm.id);
        return { ...c, decisions: exists ? c.decisions.map((d) => (d.id === norm.id ? norm : d)) : [...c.decisions, norm], updatedAt: Date.now() };
      }),
    );
    return true;
  }, [commitCampaigns]);

  const value = useMemo(
    () => ({
      campaigns,
      listCampaigns,
      getCampaign,
      createCampaign,
      updateCampaign,
      deleteCampaign,
      setCampaignStatus,
      confirmCampaign,
      startCampaign,
      endCampaign,
      reviewCampaign,
      upsertAction,
      upsertDecision,
      CAMPAIGN_STATUS,
      CAMPAIGN_TYPES,
      CAMPAIGN_ACTION_OWNER,
      CAMPAIGN_ACTION_STATUS,
      CAMPAIGN_DECISION_STATUS,
    }),
    [
      campaigns,
      listCampaigns, getCampaign,
      createCampaign, updateCampaign, deleteCampaign,
      setCampaignStatus, confirmCampaign, startCampaign, endCampaign, reviewCampaign,
      upsertAction, upsertDecision,
    ],
  );

  return <CampaignsContext.Provider value={value}>{children}</CampaignsContext.Provider>;
}

export function useCampaign() {
  const ctx = useContext(CampaignsContext);
  if (!ctx) throw new Error('useCampaign 必须在 <CampaignProvider> 子树内使用');
  return ctx;
}

export default CampaignProvider;
