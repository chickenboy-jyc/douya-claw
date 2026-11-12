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
  CUSTOM_GOAL_KEY,
  DEFAULT_SUBJECT,
  DOCTOR_IDENTITY_STORAGE_KEY,
  buildDoctorIdentityLabel,
} from '../config/activitySubjects.js';
import { hasGoal } from '../config/activityGoals.js';
import { getKpis, buildFunnel, updateCoefficientHistory, REVERSE_ASSUMPTION_NOTE } from '../config/activityMetrics.js';
import { BUDGET_DISCLAIMER } from '../config/activityBudget.js';

/**
 * activityStore —— 「🎯 AI 活动总监」Activity Engine 数据层（设计文档 §14.1 第 10 条 / T06）。
 *
 * 职责：Activity / DoctorIdentity 的 CRUD、七步向导 draft 持久化、生命周期状态流转、复盘落库。
 * 三个 localStorage 集合（全部 douya- 前缀，读入必经 normalize 补默认字段，兼容旧数据）：
 * - douya-activities         Activity[]                  （按 companyId 隔离，落 companyId + projectId 可空）
 * - douya-doctor-identities  DoctorIdentity[]            （§1.4 轻量附属身份，不新建 Company）
 * - douya-activity-draft     { [companyId]: wizardDraft } （§5.4 刷新不丢进度，保存/放弃后清除）
 *
 * 与 companyStore 的关系：**本 store 不 import useCompany**（与 dailyOpsStore 一致），
 * companyId 一律由调用方显式传入，避免 Provider 挂载顺序耦合。
 *
 * ── 红线约束（实现自检点，改动本文件前必读）─────────────────────────────
 * 【红线 1｜四主体严格隔离】manufacturer / clinic / doctor / platform 的 goalKey 与 KPI 字段
 *   在落库前逐一校验归属：goalKey 必须 hasGoal(subjectType, goalKey)（或 custom），
 *   review.actual 的 key 必须属于 KPI_DICT[subjectType]，跨主体字段一律丢弃。
 *   因此结构上不可能出现「给厂家渲染门诊指标」「给医生套企业招商」「给平台套患者获客」的字段路径。
 * 【红线 2｜不存编造的点估计】reverseGoal / budget 只存「建议区间 + 策划假设」标注：
 *   normalize 强制 assumption:true、reverseGoal.assumptionNote、budget.disclaimer 常在；
 *   funnel.stages[].actual 只能由复盘录入，禁止用 target 回填（buildFunnel 出厂即 actual:null）。
 * 【红线 3｜第一版不做任何自动化】无自动邀约 / 发微信 / 投放 / 成交 / 多 Agent 相关字段，
 *   本 store 不预留 autoSend / autoInvite / agentTask 一类字段，禁止后续「先占个位」。
 * ──────────────────────────────────────────────────────────────────
 */

/** Activity 集合 key。 */
export const ACTIVITIES_KEY = 'douya-activities';
/** 七步向导 draft key（§5.4，内层按 companyId 分桶）。 */
export const ACTIVITY_DRAFT_KEY = 'douya-activity-draft';
/** DoctorIdentity 集合 key（复用 activitySubjects 的常量，避免两处写死字符串）。 */
export const DOCTOR_IDENTITIES_KEY = DOCTOR_IDENTITY_STORAGE_KEY;

/**
 * 创建向导七步（§5.1，wizard.step 的唯一事实源）。
 * @type {Array<{key:string, idx:number, label:string}>}
 */
export const WIZARD_STEPS = [
  { key: 'subject', idx: 1, label: '这次活动是谁在办？' },
  { key: 'goal', idx: 2, label: '这次活动主要想解决什么问题？' },
  { key: 'direction', idx: 3, label: 'AI 推荐 3 个活动方向' },
  { key: 'pick', idx: 4, label: '选定一个方向' },
  { key: 'reverse', idx: 5, label: '倒推活动目标' },
  { key: 'campaign', idx: 6, label: '制定活动战役（前/中/后）' },
  { key: 'output', idx: 7, label: '生成方案版 + 执行版' },
];
/** 七步 key 数组（顺序即流转顺序）。 */
export const WIZARD_STEP_KEYS = WIZARD_STEPS.map((s) => s.key);

/** 活动生命周期（§5.1，创建完成后生效；第一版只有这四态）。 */
export const ACTIVITY_STATUS = {
  preparing: '筹备中',
  warming: '预热中',
  ongoing: '进行中',
  ended: '已结束',
};

/**
 * 生命周期流转白名单（§5.2 状态机）。
 * 主线：preparing → warming → ongoing → ended；允许跳过预热（小活动常见）与回退一步（纠正误操作）。
 * 注意：设计文档 §5.1 未定义 paused / archived，故本 store **不实现暂停与归档**，不自造状态。
 */
export const ACTIVITY_STATUS_TRANSITIONS = {
  preparing: ['warming', 'ongoing'],
  warming: ['ongoing', 'preparing'],
  ongoing: ['ended', 'warming'],
  ended: ['ongoing'],
};

/** 活动形式（§5.3 Step 2）。 */
export const ACTIVITY_FORMS = { offline: '线下', online: '线上', hybrid: '线上线下结合' };

/** 复盘数据来源口径（§12.1 dataSourceNote，UI 强制展示）。 */
export const REVIEW_DATA_SOURCE_NOTE =
  'actual 为用户录入的实际数据；aiReview 为 AI 基于实际数据的分析，不是事实本身';

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
/** 可空数值：非法值一律 null（禁止用 0 冒充「没录入」）。 */
function asNumOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
/** 对象数组：过滤非对象元素，浅拷贝，防外部引用共享。 */
function asObjList(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').map((x) => ({ ...x })) : [];
}
function asPlainObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/** 主体白名单（红线 1）：非法/空值兜底 DEFAULT_SUBJECT，不猜测。 */
function normalizeSubjectType(v) {
  const key = asStr(v);
  return Object.prototype.hasOwnProperty.call(ACTIVITY_SUBJECTS, key) ? key : DEFAULT_SUBJECT;
}
function normalizeStatus(v) {
  const key = asStr(v);
  return Object.prototype.hasOwnProperty.call(ACTIVITY_STATUS, key) ? key : 'preparing';
}
function normalizeForm(v) {
  const key = asStr(v);
  return Object.prototype.hasOwnProperty.call(ACTIVITY_FORMS, key) ? key : '';
}

/**
 * 红线 1 的字段级实现：只保留属于该主体 KPI_DICT 的实际值 key，跨主体字段静默丢弃。
 * @param {string} subjectType 主体 key
 * @param {Object|null} actual 复盘录入的实际值
 * @returns {Object<string, number>} 过滤后的实际值
 */
function filterActualBySubject(subjectType, actual) {
  const src = asPlainObj(actual) || {};
  const allowed = getKpis(subjectType).map((k) => k.key);
  const out = {};
  allowed.forEach((key) => {
    const n = asNumOrNull(src[key]);
    if (n != null) out[key] = n;
  });
  return out;
}

/** 归一化 DoctorIdentity（§1.4）。 */
export function normalizeDoctorIdentity(d) {
  const base = asPlainObj(d) || {};
  const identity = {
    id: asStr(base.id) || uid(),
    companyId: asStr(base.companyId || base.company_id),
    name: asStr(base.name).trim(),
    title: asStr(base.title).trim(),
    affiliation: asStr(base.affiliation).trim(),
    note: asStr(base.note),
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || base.createdAt || Date.now(),
  };
  return { ...identity, label: buildDoctorIdentityLabel(identity) };
}

/** 归一化三段式战役（§11：pre / on / post 三个独立数组，post 弱化由 validateCampaign 校验）。 */
function normalizeCampaign(c) {
  const base = asPlainObj(c) || {};
  return { pre: asObjList(base.pre), on: asObjList(base.on), post: asObjList(base.post) };
}

/** 归一化倒推结果（红线 2：assumptionNote 与 assumption 标记必须常在）。 */
function normalizeReverseGoal(r) {
  const base = asPlainObj(r);
  if (!base) return null;
  return {
    ...base,
    chain: asObjList(base.chain),
    assumptionNote: asStr(base.assumptionNote) || REVERSE_ASSUMPTION_NOTE,
    assumption: true,
  };
}

/** 归一化预算（红线 2：只存建议比例/区间 + 免责声明，不存点估计效果）。 */
function normalizeBudget(b) {
  const base = asPlainObj(b);
  if (!base) return null;
  return {
    ...base,
    items: asObjList(base.items),
    disclaimer: asStr(base.disclaimer) || BUDGET_DISCLAIMER,
    assumption: true,
  };
}

/** 归一化漏斗（目标/实际两列并存；actual 缺省 null，禁止用 target 回填）。 */
function normalizeFunnel(f) {
  const base = asPlainObj(f);
  if (!base) return null;
  const fix = (list) => asObjList(list).map((s) => ({ ...s, actual: asNumOrNull(s.actual) }));
  return {
    ...base,
    stages: fix(base.stages),
    extraTargets: fix(base.extraTargets),
    optionalKpis: fix(base.optionalKpis),
    isTargetModel: true,
  };
}

/**
 * 归一化素材（§14.1 #18：素材全部是 AI 建议，落库即打标，UI 不得省略）。
 * 字段对齐 genMaterials 契约 { type, title, content, note }，确保落库后的素材能原样回显，
 * 不丢 type / title / note（note 缺失时统一补「AI 建议，需运营审核」）。
 */
function normalizeMaterial(m) {
  const base = asPlainObj(m) || {};
  return {
    key: asStr(base.key) || uid(),
    type: asStr(base.type),
    title: asStr(base.title),
    content: asStr(base.content),
    note: asStr(base.note) || 'AI 建议，需运营审核',
    aiSuggested: true,
    createdAt: base.createdAt || Date.now(),
  };
}

/**
 * 归一化复盘（§12.1）。
 * 严格分区：actual（用户录入）与 aiReview（AI 生成）是两个独立字段，永不合并。
 */
export function normalizeReview(r, ctx) {
  const base = asPlainObj(r);
  if (!base) return null;
  const meta = asPlainObj(ctx) || {};
  const subjectType = normalizeSubjectType(meta.subjectType);
  const ai = asPlainObj(base.aiReview || base.analysis);
  return {
    id: asStr(base.id) || uid(),
    activityId: asStr(base.activityId) || asStr(meta.activityId),
    companyId: asStr(base.companyId) || asStr(meta.companyId),
    actual: filterActualBySubject(subjectType, base.actual),
    cost: asNumOrNull(base.cost),
    actualNote: asStr(base.actualNote),
    aiReview: ai
      ? {
          good: asObjList(ai.good),
          problems: asObjList(ai.problems),
          causes: asObjList(ai.causes),
          improvements: asObjList(ai.improvements),
          generatedAt: asStr(ai.generatedAt) || new Date().toISOString(),
        }
      : null,
    dataSourceNote: asStr(base.dataSourceNote) || REVIEW_DATA_SOURCE_NOTE,
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || base.createdAt || Date.now(),
  };
}

/**
 * 归一化 Activity（§20.1 类图 + §5.3 各步输出契约）。
 *
 * 字段名以设计文档为唯一事实源（subjectType / goalCustomText / reverseGoal / planMd / execMd），
 * 同时读入时兼容简写别名（subject / goalText / reverse / planVersion / execVersion），旧数据零影响。
 */
export function normalizeActivity(a) {
  const base = asPlainObj(a) || {};
  const subjectType = normalizeSubjectType(base.subjectType || base.subject);
  // 红线 1：goalKey 必须属于该主体（或 custom），跨主体目标一律清空，防 KPI 串味
  const rawGoalKey = asStr(base.goalKey);
  const goalKey = rawGoalKey === CUSTOM_GOAL_KEY || hasGoal(subjectType, rawGoalKey) ? rawGoalKey : '';
  const id = asStr(base.id) || uid();
  const companyId = asStr(base.companyId || base.company_id);
  return {
    id,
    companyId,
    projectId: base.projectId == null && base.project_id == null ? null : asStr(base.projectId || base.project_id),
    name: asStr(base.name).trim() || '未命名活动',
    // Step 1 主体（§1.4：subjectIdentityId 仅 doctor 主体有值；subjectLabel 为展示快照）
    subjectType,
    subjectIdentityId: subjectType === 'doctor' && base.subjectIdentityId ? asStr(base.subjectIdentityId) : null,
    subjectLabel: asStr(base.subjectLabel),
    // Step 2 目标
    goalKey,
    goalCustomText: goalKey === CUSTOM_GOAL_KEY ? asStr(base.goalCustomText || base.goalText) : '',
    form: normalizeForm(base.form),
    formConfirmed: base.formConfirmed === true,
    templateKey: asStr(base.templateKey),
    // Step 3/4 方向推荐与选择
    directions: asObjList(base.directions || base.direction),
    pickedKey: asStr(base.pickedKey),
    pickedForm: normalizeForm(base.pickedForm),
    // Step 5 倒推 + 漏斗 + 预算（红线 2：全部带策划假设标注）
    reverseGoal: normalizeReverseGoal(base.reverseGoal || base.reverse),
    funnel: normalizeFunnel(base.funnel),
    budget: normalizeBudget(base.budget),
    // Step 6 战役
    campaign: normalizeCampaign(base.campaign),
    // Step 7 双版本（两份内容分字段存，不得混排）
    planMd: asStr(base.planMd || base.planVersion),
    execMd: asStr(base.execMd || base.execVersion),
    materials: (Array.isArray(base.materials) ? base.materials : []).map(normalizeMaterial),
    review: normalizeReview(base.review, { activityId: id, companyId, subjectType }),
    status: normalizeStatus(base.status),
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || base.createdAt || Date.now(),
  };
}

/** 空 draft（§5.4：七步各步已填数据 + 当前 step）。 */
function emptyDraft() {
  return {
    step: 'subject',
    activityId: null,
    brief: { title: '', reason: '', source: '', sourceChangeId: null, fromMomentum: false },
    subject: { subjectType: '', subjectIdentityId: null, subjectLabel: '' },
    goal: { goalKey: '', goalCustomText: '', form: '', formConfirmed: false },
    direction: { directions: [], templateKey: '' },
    pick: { pickedKey: '', pickedForm: '' },
    reverse: null,
    campaign: { pre: [], on: [], post: [] },
    output: { planMd: '', execMd: '' },
    updatedAt: Date.now(),
  };
}

/** 归一化 draft，字段名与 §5.3「输出（落 wizard draft）」列逐格对齐。 */
export function normalizeDraft(d) {
  const base = asPlainObj(d);
  if (!base) return null;
  const empty = emptyDraft();
  const subject = asPlainObj(base.subject) || {};
  const goal = asPlainObj(base.goal) || {};
  const direction = asPlainObj(base.direction) || {};
  const pick = asPlainObj(base.pick) || {};
  const output = asPlainObj(base.output) || {};
  const brief = asPlainObj(base.brief) || {};
  const subjectType = subject.subjectType ? normalizeSubjectType(subject.subjectType) : '';
  const rawGoalKey = asStr(goal.goalKey);
  return {
    step: WIZARD_STEP_KEYS.indexOf(asStr(base.step)) >= 0 ? asStr(base.step) : empty.step,
    activityId: base.activityId ? asStr(base.activityId) : null,
    brief: { title: asStr(brief.title), reason: asStr(brief.reason), source: asStr(brief.source), sourceChangeId: asStr(brief.sourceChangeId) || null, fromMomentum: brief.fromMomentum === true },
    subject: {
      subjectType,
      subjectIdentityId: subjectType === 'doctor' && subject.subjectIdentityId ? asStr(subject.subjectIdentityId) : null,
      subjectLabel: asStr(subject.subjectLabel),
    },
    goal: {
      // 红线 1：draft 阶段同样校验目标归属，防止「先选目标再改主体」留下串味残留
      goalKey: rawGoalKey === CUSTOM_GOAL_KEY || (subjectType && hasGoal(subjectType, rawGoalKey)) ? rawGoalKey : '',
      goalCustomText: asStr(goal.goalCustomText || goal.goalText),
      form: normalizeForm(goal.form),
      formConfirmed: goal.formConfirmed === true,
    },
    direction: { directions: asObjList(direction.directions), templateKey: asStr(direction.templateKey) },
    pick: { pickedKey: asStr(pick.pickedKey), pickedForm: normalizeForm(pick.pickedForm) },
    reverse: normalizeReverseGoal(base.reverse),
    campaign: normalizeCampaign(base.campaign),
    output: { planMd: asStr(output.planMd), execMd: asStr(output.execMd) },
    updatedAt: base.updatedAt || Date.now(),
  };
}

function loadActivities() {
  const arr = loadJSON(ACTIVITIES_KEY, []);
  return (Array.isArray(arr) ? arr : []).map(normalizeActivity);
}
function loadDoctorIdentities() {
  const arr = loadJSON(DOCTOR_IDENTITIES_KEY, []);
  return (Array.isArray(arr) ? arr : []).map(normalizeDoctorIdentity);
}
/** draft 存储为 { [companyId]: wizardDraft }（§5.4）。 */
function loadDrafts() {
  const obj = asPlainObj(loadJSON(ACTIVITY_DRAFT_KEY, {})) || {};
  const out = {};
  Object.keys(obj).forEach((cid) => {
    const d = normalizeDraft(obj[cid]);
    if (d) out[cid] = d;
  });
  return out;
}

const ActivitiesContext = createContext(null);

/**
 * 活动数据 Provider。挂在根部，与 CompanyProvider / MarketingProvider / DailyOpsProvider 同级。
 * 首次挂载同步读入 + 归一化，避免首屏空列表闪一下。
 */
export function ActivityProvider({ children }) {
  const [activities, setActivities] = useState(loadActivities);
  const [doctorIdentities, setDoctorIdentities] = useState(loadDoctorIdentities);
  const [drafts, setDrafts] = useState(loadDrafts);

  // 始终镜像最新 state，供方法同步读取（避免 useCallback 闭包拿到首次渲染的旧值，
  // 以及避免「在 setState updater 内算返回值」导致同步返回 null 的反模式）。
  const activitiesRef = useRef(activities);
  const doctorIdentitiesRef = useRef(doctorIdentities);
  const draftsRef = useRef(drafts);

  /**
   * 草稿「墓碑」：{ [companyId]: true }。
   *
   * 为什么需要：draft 被消费（保存为活动）或被丢弃之后，**在飞的 AI 生成**仍会 resolve 回来调
   * saveDraft（方向/战役/方案版/执行版四处都是「拿到结果就写 draft」）。那一下会把刚清掉的草稿
   * 又写回去 —— 草稿「复活」。后果是用户下次进向导被问「检测到未完成的草稿」，而那份草稿对应的
   * 活动其实早已落库，等于拿一份过期副本把用户拽回第 1 步。
   *
   * 真实取证（2026-09-12，真实模型通道 activity-wizard-flow 的 real 分支）：
   *   点「保存为活动」后 2.4s，draft.updatedAt 比保存时刻还新 → 草稿被迟到回写。
   * mock（即时返回）永远撞不到这个时间窗，所以这是只有真实模型才暴露的问题。
   *
   * 规则：drop 掉某个 cid 后立刻立碑 → saveDraft 见碑即拒；直到 beginDraft(cid) 显式开新一轮会话。
   * 红线：**任何新的向导入口都必须先调 beginDraft**，否则本轮的自动保存会被静默拒绝。
   */
  const draftTombRef = useRef({});

  /**
   * 提交 draft 的唯一出口（红线，改动本文件前必读）。
   *
   * 必须「先同步写 ref、再 setState」：
   * draftsRef 原本只在下面的 useEffect 里同步，而 effect 要等渲染提交后才跑。
   * 于是同一事件处理里连续写两次 draft 时，第二次读到的 draftsRef 还是旧值，
   * 会把第一次的写入整个覆盖掉。
   *
   * 真实故障（2026-09-11 用户实测）：ActivitySubjectStep.handleNext 先
   * switchDraftSubject(写主体) 再 saveDraft({ step:'goal' })，
   * 第二次基于旧 ref 合并 → 主体被冲回空 → Step 2 永远提示
   * 「请先在上一步选择「这次活动是谁在办？」」，向导死锁在第二步。
   *
   * 因此：**任何写 drafts 的地方都必须走 commitDrafts，禁止直接 setDrafts**。
   * @param {Object} next 完整 drafts 对象（{ [companyId]: wizardDraft }）
   * @returns {Object} 同一个对象（便于链式返回）
   */
  const commitDrafts = useCallback((next) => {
    draftsRef.current = next;
    setDrafts(next);
    return next;
  }, []);

  /**
   * 提交 activities 的唯一出口（红线，改动本文件前必读）。
   *
   * 与 commitDrafts 同一个坑、同一条修法：activitiesRef 原本只在下面的 useEffect 里同步，
   * 而 effect 要等渲染提交后才跑。于是「保存活动 → 立刻回到列表」这条路径上：
   *   setActivities(新数组) → 重渲染（子组件 useMemo 因 activities 身份变化而重算）
   *   → listActivities 读到的 activitiesRef.current **仍是旧数组** → 列表还是空的；
   *   随后 effect 才把 ref 换成新数组，但已经不会再触发渲染了。
   * 真实故障（2026-09-12 用户实测）：七步向导点「保存为活动」后落库成功、草稿也清了，
   * 但列表依旧显示「还没有活动」，必须切到别的模块再回来才看见刚建的活动。
   *
   * 因此：**任何写 activities 的地方都必须走 commitActivities，禁止直接 setActivities**。
   * 签名与 useState 的 setter 完全一致（支持值 / updater 函数两种形式），可原地替换。
   * @param {Array|Function} updater 新数组，或 (prev) => next
   * @returns {Array} 提交后的数组
   */
  const commitActivities = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(activitiesRef.current) : updater;
    activitiesRef.current = next;
    setActivities(next);
    return next;
  }, []);

  /** 同上：doctorIdentities 也有「列表读 ref、ref 等 effect」的同一类延迟，统一走这里写。 */
  const commitDoctorIdentities = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(doctorIdentitiesRef.current) : updater;
    doctorIdentitiesRef.current = next;
    setDoctorIdentities(next);
    return next;
  }, []);

  useEffect(() => {
    // ⚠️ 本 effect **只做持久化，禁止回灌 ref**（2026-10-20，改这里前必读）。
    //
    // 三份数据的 ref 一律由各自的 commit 函数同步维护（commitDrafts / commitActivities /
    // commitDoctorIdentities），它们都是「先写 ref、再 setState」。这里若再补一次
    // `draftsRef.current = drafts`，挂载期就会用**首渲染闭包里的旧 state** 把刚写进 ref 的新值
    // 覆盖掉，因为 React 的 effect 是**子先父后**：子组件 ActivityWizard 的自动落主体 effect
    // 先跑（saveDraft 写 ref），随后祖先 Provider 的这个 effect 才跑，用旧 drafts 覆盖之。
    //
    // 真实故障（2026-10-20，test:ui 5 条红）：manufacturer 企业进向导 → 自动落主体并跳到目标步，
    // 但 ActivityGoalStep 挂载时读到 subject 为空 → 渲染「请先在上一步选择…」→ 向导死锁在第二步。
    // 取证：`[WIZDBG] afterSave subject={...}` 紧接 `[GOALDBG] draftSubject= null`。
    //
    // 因此：ref 是「已被 commit 写入的最新值」，state 可能比它旧一个 commit —— 回灌只会更旧，
    // 绝不会更新。持久化仍然读 state（state 才是渲染视图，二者最终由 commit 收敛为同一份）。
    try {
      localStorage.setItem(ACTIVITIES_KEY, JSON.stringify(activities));
      localStorage.setItem(DOCTOR_IDENTITIES_KEY, JSON.stringify(doctorIdentities));
      localStorage.setItem(ACTIVITY_DRAFT_KEY, JSON.stringify(drafts));
    } catch {
      /* 忽略写失败（隐私模式 / 配额） */
    }
  }, [activities, doctorIdentities, drafts]);

  // ---- 查询 ----
  /** 按 companyId 隔离查询，可选按主体 / 状态过滤，按 updatedAt 倒序。 */
  const listActivities = useCallback(({ companyId, subjectType, status } = {}) => {
    let list = activitiesRef.current;
    if (companyId) list = list.filter((a) => a.companyId === companyId);
    if (subjectType) list = list.filter((a) => a.subjectType === subjectType);
    if (status) list = list.filter((a) => a.status === status);
    return list.slice().sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  }, []);

  const getActivity = useCallback((id) => activitiesRef.current.find((a) => a.id === id) || null, []);

  // ---- Activity CRUD ----
  /**
   * 新建活动。companyId + subjectType 必填（主体缺失时不猜测，直接拒绝）。
   * @param {Object} payload Activity 字段（字段名见 normalizeActivity）
   * @returns {Object|null} 新建的 Activity
   */
  const createActivity = useCallback((payload) => {
    const src = asPlainObj(payload) || {};
    if (!asStr(src.companyId) || !asStr(src.subjectType || src.subject)) return null;
    const now = Date.now();
    const a = normalizeActivity({ ...src, id: uid(), status: src.status || 'preparing', createdAt: now, updatedAt: now });
    commitActivities((prev) => [...prev, a]);
    return a;
  }, [commitActivities]);

  /**
   * 丢弃某企业的 draft（**唯一出口**）：先删数据，再立墓碑阻断在飞 AI 生成的迟到回写。
   * @param {string} cid 已规范化的企业 id
   */
  const dropDraft = useCallback((cid) => {
    if (!cid) return;
    if (draftsRef.current[cid]) {
      const next = { ...draftsRef.current };
      delete next[cid];
      commitDrafts(next);
    }
    draftTombRef.current = { ...draftTombRef.current, [cid]: true };
  }, [commitDrafts]);

  /**
   * 开新一轮向导会话：撤掉该企业的草稿墓碑，让 saveDraft 重新可写。
   * 向导挂载时、以及「经营动作建议」带 Brief 进向导前，都必须先调它。
   */
  const beginDraft = useCallback((companyId) => {
    const cid = asStr(companyId);
    if (!cid || !draftTombRef.current[cid]) return;
    const next = { ...draftTombRef.current };
    delete next[cid];
    draftTombRef.current = next;
  }, []);

  /**
   * 由 draft 落库为 Activity（Step 7 之后，§5.3：status=preparing），并清除该企业 draft（§5.4）。
   * @param {string} companyId 企业 id
   * @param {Object} [extra] { name, projectId, budget, funnel, templateKey }
   * @returns {Object|null} 新建的 Activity
   */
  const createActivityFromDraft = useCallback((companyId, extra) => {
    const cid = asStr(companyId);
    const draft = cid ? draftsRef.current[cid] : null;
    if (!cid || !draft || !draft.subject.subjectType) return null;
    const more = asPlainObj(extra) || {};
    const payload = {
      companyId: cid,
      subjectType: draft.subject.subjectType,
      subjectIdentityId: draft.subject.subjectIdentityId,
      subjectLabel: draft.subject.subjectLabel,
      goalKey: draft.goal.goalKey,
      goalCustomText: draft.goal.goalCustomText,
      form: draft.pick.pickedForm || draft.goal.form,
      formConfirmed: draft.goal.formConfirmed,
      templateKey: draft.direction.templateKey,
      directions: draft.direction.directions,
      pickedKey: draft.pick.pickedKey,
      pickedForm: draft.pick.pickedForm,
      reverseGoal: draft.reverse,
      // 漏斗由倒推结果派生（buildFunnel 出厂 actual 全 null，实际值只能复盘录入）
      funnel: more.funnel || (draft.reverse ? buildFunnel(draft.subject.subjectType, draft.reverse) : null),
      campaign: draft.campaign,
      planMd: draft.output.planMd,
      execMd: draft.output.execMd,
      ...more,
      status: 'preparing',
    };
    const created = createActivity(payload);
    // 走 dropDraft（而不是就地删）：草稿被消费后必须立碑，
    // 否则本步刚生成的方案版/执行版会在 1~3s 后把草稿写回来（见 draftTombRef）。
    if (created) dropDraft(cid);
    return created;
  }, [createActivity, dropDraft]);

  const updateActivity = useCallback((id, patch) => {
    commitActivities((prev) =>
      prev.map((a) => (a.id === id ? normalizeActivity({ ...a, ...(asPlainObj(patch) || {}), id: a.id, companyId: a.companyId, updatedAt: Date.now() }) : a)),
    );
  }, [commitActivities]);

  const deleteActivity = useCallback((id) => {
    commitActivities((prev) => prev.filter((a) => a.id !== id));
  }, [commitActivities]);

  /**
   * 复制活动：只复制「策划侧」内容，执行与结果侧全部重置
   * （status→preparing、review→null、funnel.actual 清空），否则会把上一场的实际数据当成本场结果。
   * @param {string} id 源活动 id
   * @returns {Object|null} 副本
   */
  const duplicateActivity = useCallback((id) => {
    // 读 ref 而不是闭包里的 activities：同一事件里连着两次写（如复制后立刻改状态）时，
    // 闭包里的 activities 还停在上一轮渲染，会拿到过期源数据。2026-09-12 统一。
    const src = activitiesRef.current.find((a) => a.id === id);
    if (!src) return null;
    const now = Date.now();
    const funnel = src.funnel
      ? {
          ...src.funnel,
          stages: src.funnel.stages.map((s) => ({ ...s, actual: null })),
          extraTargets: src.funnel.extraTargets.map((s) => ({ ...s, actual: null })),
          optionalKpis: src.funnel.optionalKpis.map((s) => ({ ...s, actual: null })),
        }
      : null;
    const copy = normalizeActivity({
      ...src,
      id: uid(),
      name: `${src.name}（副本）`,
      funnel,
      review: null,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
    });
    commitActivities((prev) => [...prev, copy]);
    return copy;
  }, [commitActivities]);

  /** 保存素材中心内容（全部标 aiSuggested，供 UI 渲染「AI 建议」标签）。 */
  const saveMaterials = useCallback((activityId, materials) => {
    commitActivities((prev) =>
      prev.map((a) =>
        a.id === activityId
          ? normalizeActivity({ ...a, materials: Array.isArray(materials) ? materials : [], updatedAt: Date.now() })
          : a,
      ),
    );
  }, [commitActivities]);

  // ---- 生命周期（§5.2）----
  /**
   * 状态流转（带 ACTIVITY_STATUS_TRANSITIONS 校验，非法跳转被拒绝）。
   * @returns {boolean} 是否成功
   */
  const setActivityStatus = useCallback((id, status) => {
    if (!Object.prototype.hasOwnProperty.call(ACTIVITY_STATUS, status)) return false;
    // 读 ref：流转校验必须基于「此刻真正的状态」，闭包 state 在同 tick 连续调用时会过期
    const a = activitiesRef.current.find((x) => x.id === id);
    if (!a) return false;
    if (a.status !== status && (ACTIVITY_STATUS_TRANSITIONS[a.status] || []).indexOf(status) === -1) return false;
    commitActivities((prev) => prev.map((x) => (x.id === id ? { ...x, status, updatedAt: Date.now() } : x)));
    return true;
  }, [commitActivities]);

  const startWarming = useCallback((id) => setActivityStatus(id, 'warming'), [setActivityStatus]);
  const startOngoing = useCallback((id) => setActivityStatus(id, 'ongoing'), [setActivityStatus]);
  const endActivity = useCallback((id) => setActivityStatus(id, 'ended'), [setActivityStatus]);

  // ---- 复盘（§12）----
  /**
   * 保存复盘：actual（用户录入）与 aiReview（AI 分析）分区落库，永不合并；
   * 同步把实际值写入 funnel 的 actual 列（目标列不动），并把状态推进到 ended。
   * @param {string} activityId 活动 id
   * @param {Object} payload { actual, analysis|aiReview, cost, actualNote }
   * @returns {boolean} 是否成功
   */
  const saveReview = useCallback((activityId, payload) => {
    const src = asPlainObj(payload) || {};
    const target = activitiesRef.current.find((a) => a.id === activityId);
    if (!target) return false;
    const prevReview = target.review;
    const merged = normalizeReview(
      {
        ...(prevReview || {}),
        ...src,
        // 实际值增量合并（分批录入不丢），跨主体 key 由 normalizeReview 内部过滤
        actual: { ...((prevReview && prevReview.actual) || {}), ...(asPlainObj(src.actual) || {}) },
        aiReview: src.aiReview || src.analysis || (prevReview ? prevReview.aiReview : null),
        id: (prevReview && prevReview.id) || uid(),
        createdAt: (prevReview && prevReview.createdAt) || Date.now(),
        updatedAt: Date.now(),
      },
      { activityId: target.id, companyId: target.companyId, subjectType: target.subjectType },
    );
    if (!merged) return false;
    const fill = (list) => list.map((s) => (merged.actual[s.key] == null ? s : { ...s, actual: merged.actual[s.key] }));
    const funnel = target.funnel
      ? {
          ...target.funnel,
          stages: fill(target.funnel.stages),
          extraTargets: fill(target.funnel.extraTargets),
          optionalKpis: fill(target.funnel.optionalKpis),
        }
      : null;
    commitActivities((prev) =>
      prev.map((a) => (a.id === activityId ? { ...a, review: merged, funnel, status: 'ended', updatedAt: Date.now() } : a)),
    );
    return true;
  }, [commitActivities]);

  /**
   * 复盘结果回流（§12.3）：由该企业已复盘活动的实际值算出 user_history 系数，供下次倒推使用。
   * 不额外落一份 localStorage —— 派生自 activities，避免出现第二份「历史数据」事实源。
   * @param {string} companyId 企业 id
   * @returns {Object} { [subject]: { [linkKey]: {min,max,avg,sampleSize} } }
   */
  const getCoefficientHistory = useCallback((companyId) => {
    const cid = asStr(companyId);
    let history = {};
    activities
      .filter((a) => (!cid || a.companyId === cid) && a.review && Object.keys(a.review.actual).length > 0)
      .sort((x, y) => (x.updatedAt || 0) - (y.updatedAt || 0))
      .forEach((a) => {
        // 按 subjectType 分桶累计：厂家的转化率永远不会污染门诊的系数（红线 1）
        history = updateCoefficientHistory(history, a.subjectType, a.review.actual).history;
      });
    return history;
  }, [activities]);

  // ---- DoctorIdentity（§1.4，按 companyId 隔离）----
  const listDoctorIdentities = useCallback((companyId) => {
    const cid = asStr(companyId);
    return doctorIdentities.filter((d) => !cid || d.companyId === cid);
  }, [doctorIdentities]);

  /**
   * 新增 / 更新医生身份（带 id 且存在则更新，否则新建）。
   * @param {string} companyId 所属企业（clinic / doctor 工作空间）
   * @param {Object} identity { id?, name, title, affiliation, note }
   * @returns {Object|null} 落库后的身份
   */
  const upsertDoctorIdentity = useCallback((companyId, identity) => {
    const cid = asStr(companyId);
    const src = asPlainObj(identity) || {};
    if (!cid || !asStr(src.name).trim()) return null;
    const existing = src.id ? doctorIdentities.find((d) => d.id === asStr(src.id)) : null;
    const next = normalizeDoctorIdentity({
      ...(existing || {}),
      ...src,
      companyId: cid,
      id: existing ? existing.id : uid(),
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
    });
    commitDoctorIdentities((prev) => (existing ? prev.map((d) => (d.id === next.id ? next : d)) : [...prev, next]));
    return next;
  }, [doctorIdentities, commitDoctorIdentities]);

  /**
   * 删除医生身份。已落库活动不做级联清理：activity.subjectLabel 是创建时的展示快照，
   * 删身份不应改写历史活动的主体署名。
   */
  const deleteDoctorIdentity = useCallback((id) => {
    commitDoctorIdentities((prev) => prev.filter((d) => d.id !== id));
  }, [commitDoctorIdentities]);

  // ---- wizard draft（§5.4，按 companyId 隔离）----
  const loadDraft = useCallback((companyId) => {
    const cid = asStr(companyId);
    return (cid && draftsRef.current[cid]) || null;
  }, []);

  /**
   * 保存 draft（按步骤桶浅合并，只传变化的那一步即可）。
   * @param {string} companyId 企业 id
   * @param {Object} patch { step?, subject?, goal?, direction?, pick?, reverse?, campaign?, output?, activityId? }
   * @returns {Object|null} 合并后的 draft
   */
  const saveDraft = useCallback((companyId, patch) => {
    const cid = asStr(companyId);
    const src = asPlainObj(patch) || {};
    if (!cid) return null;
    // 草稿已被消费 / 被丢弃：拒绝在飞 AI 生成的迟到回写（见 draftTombRef）。
    // 新一轮会话由 beginDraft 开碑。
    // 这里刻意留一条 warn：正常流程**不该**出现（每个向导入口都会先 beginDraft）。
    // 真出现了，就是有新的入口忘了开碑 —— 否则它只会表现为「改了没保存」，极难查。
    if (draftTombRef.current[cid]) {
      console.warn('[activityStore] saveDraft 被草稿墓碑拒绝（本轮草稿已消费）。若这是新一轮向导，说明入口漏调 beginDraft。', { companyId: cid, patch: Object.keys(src) });
      return null;
    }
    const old = draftsRef.current[cid] || emptyDraft();
    const merged = { ...old };
    Object.keys(src).forEach((k) => {
      const oldBucket = asPlainObj(old[k]);
      const newBucket = asPlainObj(src[k]);
      merged[k] = oldBucket && newBucket ? { ...oldBucket, ...newBucket } : src[k];
    });
    merged.updatedAt = Date.now();
    const saved = normalizeDraft(merged);
    commitDrafts({ ...draftsRef.current, [cid]: saved });
    return saved;
  }, [commitDrafts]);

  const clearDraft = useCallback((companyId) => {
    const cid = asStr(companyId);
    if (!cid) return;
    // 即便当前没有 draft 也要立碑：用户点「重新开始」时，上一轮的 AI 生成可能还在飞。
    dropDraft(cid);
  }, [dropDraft]);

  /**
   * 切换主体（§1.4 验收红线）：subjectType 变化时，goal / direction / pick / reverse / campaign / output
   * 全部清空（二次确认由 UI 负责），否则会造成 KPI 串味。
   * @param {string} companyId 企业 id
   * @param {Object} subject { subjectType, subjectIdentityId, subjectLabel }
   * @returns {Object|null} 重置后的 draft
   */
  const switchDraftSubject = useCallback((companyId, subject) => {
    const cid = asStr(companyId);
    const src = asPlainObj(subject) || {};
    const subjectType = normalizeSubjectType(src.subjectType);
    if (!cid || !asStr(src.subjectType)) return null;
    const old = draftsRef.current[cid] || emptyDraft();
    const keepSame = old.subject.subjectType === subjectType && old.subject.subjectIdentityId === (src.subjectIdentityId || null);
    const base = keepSame ? old : emptyDraft();
    const saved = normalizeDraft({
      ...base,
      activityId: old.activityId,
      step: keepSame ? old.step : 'goal',
      subject: {
        subjectType,
        subjectIdentityId: src.subjectIdentityId || null,
        subjectLabel: asStr(src.subjectLabel),
      },
      updatedAt: Date.now(),
    });
    commitDrafts({ ...draftsRef.current, [cid]: saved });
    return saved;
  }, [commitDrafts]);

  const value = useMemo(
    () => ({
      // 数据
      activities,
      doctorIdentities,
      drafts,
      // 查询
      listActivities,
      getActivity,
      // Activity CRUD
      createActivity,
      createActivityFromDraft,
      updateActivity,
      deleteActivity,
      duplicateActivity,
      saveMaterials,
      // 生命周期
      setActivityStatus,
      startWarming,
      startOngoing,
      endActivity,
      // 复盘
      saveReview,
      getCoefficientHistory,
      // 医生身份
      listDoctorIdentities,
      upsertDoctorIdentity,
      deleteDoctorIdentity,
      // draft
      loadDraft,
      saveDraft,
      clearDraft,
      beginDraft,
      switchDraftSubject,
      // 常量（UI 不重写枚举）
      WIZARD_STEPS,
      WIZARD_STEP_KEYS,
      ACTIVITY_STATUS,
      ACTIVITY_FORMS,
    }),
    [
      activities, doctorIdentities, drafts,
      listActivities, getActivity,
      createActivity, createActivityFromDraft, updateActivity, deleteActivity, duplicateActivity, saveMaterials,
      setActivityStatus, startWarming, startOngoing, endActivity,
      saveReview, getCoefficientHistory,
      listDoctorIdentities, upsertDoctorIdentity, deleteDoctorIdentity,
      loadDraft, saveDraft, clearDraft, beginDraft, switchDraftSubject,
    ],
  );

  return <ActivitiesContext.Provider value={value}>{children}</ActivitiesContext.Provider>;
}

export function useActivity() {
  const ctx = useContext(ActivitiesContext);
  if (!ctx) throw new Error('useActivity 必须在 <ActivityProvider> 子树内使用');
  return ctx;
}

/** 设计文档 §16.2 的命名别名（useActivities），与 useActivity 完全等价。 */
export const useActivities = useActivity;

export default ActivityProvider;
