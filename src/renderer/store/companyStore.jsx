import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { resolveCapability } from '../services/capabilityResolver.js';

/**
 * 多企业 + 多项目 + 任务 数据层（阶段四 P0：定死数据模型字段）。
 * 五层模型：账号 → 工作空间（第一版默认单实例）→ 企业 → 项目 → 任务。
 * 企业含 type（manufacturer | clinic），决定厂家/门诊两套路由。
 * 角色 role（admin | operator | viewer）挂在「账号↔企业」关系上（第一版存于 Company.role，
 * 单账号本地先行），不写死在账号。
 * 所有数据 localStorage 持久化，key 用 douya- 前缀避免冲突；旧数据读入时归一化补默认字段。
 */

export const COMPANIES_KEY = 'douya-companies';
export const CURRENT_COMPANY_KEY = 'douya-current-company';
export const PROJECTS_KEY = 'douya-projects';
export const CURRENT_PROJECT_KEY = 'douya-current-project';
export const TASKS_KEY = 'douya-tasks';
export const CURRENT_TASK_KEY = 'douya-current-task';
export const MEMBERS_KEY = 'douya-members';
export const WORKSPACE_MEMBERS_KEY = 'douya-workspace-members';
export const WORKSPACES_KEY = 'douya-workspaces';
export const CURRENT_WORKSPACE_KEY = 'douya-current-workspace';
export const ACCOUNT_KEY = 'douya-account';

// 老版本单企业资产 / 目标 key（迁移用）
const LEGACY_ASSET_KEY = 'douya-marketing-asset';
const LEGACY_GOAL_KEY = 'douya-marketing-goal';

/** 默认工作空间（首次迁移时兜底；之后可自由新建/切换/删除多个工作空间）。 */
export const DEFAULT_WORKSPACE = { id: 'workspace-default', name: '我的工作空间' };

/**
 * 企业类型（五主体底座）。
 * 五种主体：manufacturer 口腔厂家 / clinic 口腔门诊 / doctor 口腔医生 / dealer 经销商 / platform 口腔平台。
 * key 为企业 type 唯一事实源，组件禁止重写枚举。
 * ⚠️ doctor 必须保留在白名单内（首登不出卡，但一旦移出白名单，存量 doctor 企业会被静默判成 manufacturer）。
 */
export const COMPANY_TYPES = {
  manufacturer: '口腔厂家',
  clinic: '口腔门诊',
  doctor: '口腔医生',
  dealer: '经销商',
  platform: '口腔平台',
};
/**
 * 企业类型合法 key 数组（顺序即 UI 展示顺序）。
 * ⚠️ 这是 normalizeCompanyType 的**归一化白名单**（5 值）。首登「选身份」卡面**不复用**本数组，
 * 而用 companyTypeConfig.FIRST_RUN_TYPE_KEYS（4 值，不含 doctor）；
 * doctor 必须原位保留，否则存量 doctor 企业会被静默降级为厂家（数据破坏级）。
 */
export const COMPANY_TYPE_KEYS = ['manufacturer', 'clinic', 'doctor', 'dealer', 'platform'];
/**
 * 归一化企业类型：五值白名单，非法/空值兜底 manufacturer。
 * 旧数据零影响：已存在的 manufacturer / clinic / doctor 原值原样保留，语义不变。
 * @param {unknown} type 待校验类型
 * @returns {'manufacturer'|'clinic'|'doctor'|'dealer'|'platform'}
 */
export function normalizeCompanyType(type) {
  return COMPANY_TYPE_KEYS.includes(type) ? type : 'manufacturer';
}
/** 企业状态（激活 / 停用 / 暂停；默认激活）。 */
export const COMPANY_STATUS = { active: '运营中', inactive: '已停用', paused: '已暂停' };
/** 角色（第一版仅三种）。 */
export const ROLES = { admin: '管理员', operator: '运营', viewer: '查看' };
/** 项目状态五态。 */
export const PROJECT_STATUS = { draft: '草稿', active: '进行中', paused: '已暂停', completed: '已完成', archived: '已归档' };
/** 任务状态五态。 */
export const TASK_STATUS = { todo: '待办', doing: '进行中', review: '待审核', done: '已完成', cancelled: '已取消' };
/** 任务优先级。 */
export const TASK_PRIORITY = { low: '低', medium: '中', high: '高', urgent: '紧急' };

/**
 * 任务状态流转校验表（唯一事实源）：
 * todo→doing→review→done；AI 成功只推进到 review，review→done 仅人工。
 * cancelled 仅允许从 todo/doing/review 进入，且可重开回 todo。
 */
export const TASK_TRANSITIONS = {
  todo: ['doing', 'cancelled'],
  doing: ['review', 'todo', 'cancelled'],
  review: ['done', 'doing', 'cancelled'],
  done: ['todo'],
  cancelled: ['todo'],
};

/** 生成简短唯一 id。 */
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

// ---- 归一化：旧数据补齐新字段，避免历史 localStorage 缺字段导致渲染/逻辑报错 ----

function asArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}
function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function normalizeCompany(c) {
  const base = c && typeof c === 'object' ? c : {};
  const mem = base.memory && typeof base.memory === 'object' ? base.memory : {};
  return {
    id: asStr(base.id),
    name: asStr(base.name) || '未命名企业',
    type: normalizeCompanyType(base.type),
    role: ['admin', 'operator', 'viewer'].includes(base.role) ? base.role : 'admin',
    workspaceId: asStr(base.workspaceId) || DEFAULT_WORKSPACE.id,
    status: ['active', 'inactive', 'paused'].includes(base.status) ? base.status : 'active',
    // 企业营销大脑（CompanyMemory）：长期事实 / 禁区限制，随企业走，注入 AI 上下文
    memory: {
      facts: asArray(mem.facts),
      restrictions: asArray(mem.restrictions),
    },
    createdAt: base.createdAt || Date.now(),
  };
}

function normalizeProject(p) {
  const base = p && typeof p === 'object' ? p : {};
  // 状态五态：draft/active/paused/completed/archived；旧值 done 归一化为 completed
  let status = base.status;
  if (status === 'done') status = 'completed';
  if (!['draft', 'active', 'paused', 'completed', 'archived'].includes(status)) status = 'active';
  return {
    id: asStr(base.id),
    companyId: asStr(base.companyId),
    name: asStr(base.name) || '未命名项目',
    goalId: base.goalId == null ? null : asStr(base.goalId),
    type: asStr(base.type),
    status,
    description: asStr(base.description),
    period: asStr(base.period),
    periodStart: asStr(base.periodStart || base.period_start),
    periodEnd: asStr(base.periodEnd || base.period_end),
    budget: asStr(base.budget),
    channels: asArray(base.channels),
    kpi: asStr(base.kpi),
    audience: asStr(base.audience),
    product: asStr(base.product),
    sellingPoints: asArray(base.sellingPoints),
    memory: asArray(base.memory),
    createdBy: asStr(base.createdBy || base.created_by),
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || base.createdAt || Date.now(),
  };
}

function normalizeTask(t) {
  const base = t && typeof t === 'object' ? t : {};
  const priority = ['low', 'medium', 'high', 'urgent'].includes(base.priority) ? base.priority : 'medium';
  return {
    id: asStr(base.id),
    projectId: asStr(base.projectId),
    title: asStr(base.title) || '未命名任务',
    status: ['todo', 'doing', 'review', 'done', 'cancelled'].includes(base.status) ? base.status : 'todo',
    taskType: asStr(base.taskType || base.task_type),
    priority,
    description: asStr(base.description),
    goal: asStr(base.goal),
    requirements: asStr(base.requirements),
    outputFormat: asStr(base.outputFormat),
    // capability 派生单一来源：未显式传 capability 时由 taskType 派生（旧数据继续用显式 capability）
    capability: asStr(base.capability) || resolveCapability(asStr(base.taskType || base.task_type)),
    assigneeId: asStr(base.assigneeId || base.assignee_id),
    dueAt: asStr(base.dueAt || base.due_at),
    aiOutput: base.aiOutput == null ? (base.ai_output == null ? null : base.ai_output) : base.aiOutput,
    aiInput: base.aiInput == null ? (base.ai_input == null ? null : base.ai_input) : base.aiInput,
    aiProcess: base.aiProcess == null ? (base.ai_process == null ? null : base.ai_process) : base.aiProcess,
    parentId: base.parentId == null ? (base.parent_id == null ? null : asStr(base.parent_id)) : asStr(base.parentId),
    notes: asArray(base.notes),
    createdBy: asStr(base.createdBy || base.created_by),
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || base.createdAt || Date.now(),
  };
}

/** 企业成员（CompanyMember，本地先行）：账号↔企业 关系 + 角色（角色属于 Membership，不写在 User 上）。 */
function normalizeMember(m, fallbackUserId) {
  const base = m && typeof m === 'object' ? m : {};
  return {
    id: asStr(base.id),
    companyId: asStr(base.companyId),
    userId: asStr(base.userId) || fallbackUserId || 'self',
    name: asStr(base.name) || '未命名成员',
    role: ['admin', 'operator', 'viewer'].includes(base.role) ? base.role : 'viewer',
    createdAt: base.createdAt || Date.now(),
  };
}

/** 工作空间成员（WorkspaceMember）：账号↔工作空间 关系 + 角色。 */
function normalizeWorkspaceMember(m, fallbackUserId) {
  const base = m && typeof m === 'object' ? m : {};
  return {
    id: asStr(base.id),
    workspaceId: asStr(base.workspaceId),
    userId: asStr(base.userId) || fallbackUserId || 'self',
    role: ['admin', 'operator', 'viewer'].includes(base.role) ? base.role : 'admin',
    createdAt: base.createdAt || Date.now(),
  };
}

/** 账号（Account）：当前登录用户（来源 douya-auth-user），只保留最基础信息，不写 role/companyId。 */
function normalizeAccount(a) {
  const base = a && typeof a === 'object' ? a : {};
  return {
    id: asStr(base.id) || 'self',
    name: asStr(base.name) || asStr(base.username) || '我',
    username: asStr(base.username) || asStr(base.name) || '',
    avatar: asStr(base.avatar) || '',
    createdAt: base.createdAt || Date.now(),
    updatedAt: base.updatedAt || Date.now(),
  };
}

/** 工作空间（Workspace）：账号下的一组企业，代运营/团队隔离边界。 */
function normalizeWorkspace(w) {
  const base = w && typeof w === 'object' ? w : {};
  return {
    id: asStr(base.id),
    name: asStr(base.name) || '未命名工作空间',
    ownerId: asStr(base.ownerId),
    createdAt: base.createdAt || Date.now(),
  };
}

function loadCompanies() {
  const arr = loadJSON(COMPANIES_KEY, []);
  return (Array.isArray(arr) ? arr : []).map(normalizeCompany);
}
function loadProjects() {
  const arr = loadJSON(PROJECTS_KEY, []);
  return (Array.isArray(arr) ? arr : []).map(normalizeProject);
}
function loadTasks() {
  const arr = loadJSON(TASKS_KEY, []);
  return (Array.isArray(arr) ? arr : []).map(normalizeTask);
}
function loadMembers(userId) {
  const arr = loadJSON(MEMBERS_KEY, []);
  return (Array.isArray(arr) ? arr : []).map((m) => normalizeMember(m, userId));
}
function loadWorkspaceMembers(userId) {
  const arr = loadJSON(WORKSPACE_MEMBERS_KEY, []);
  return (Array.isArray(arr) ? arr : []).map((m) => normalizeWorkspaceMember(m, userId));
}
function loadAccount() {
  let a = loadJSON(ACCOUNT_KEY, null);
  if (!a || typeof a !== 'object') {
    const u = loadJSON('douya-auth-user', null);
    a = u && typeof u === 'object' ? u : null;
  }
  return normalizeAccount(a);
}
function loadWorkspaces() {
  const arr = loadJSON(WORKSPACES_KEY, null);
  if (Array.isArray(arr) && arr.length > 0) {
    return arr.map(normalizeWorkspace);
  }
  // 旧数据无工作空间：兜底为默认工作空间
  return [normalizeWorkspace(DEFAULT_WORKSPACE)];
}

/**
 * 一次性初始化 + 老数据迁移（同步，避免首屏闪一下引导页）。
 * 规则：无企业但存在老单企业资产/目标 → 自动建「默认企业 + 默认项目」。
 */
function initCompanyState() {
  const account = loadAccount();
  const accountId = account.id || 'self';
  const companies = loadCompanies();
  const projects = loadProjects();
  const tasks = loadTasks();
  let members = loadMembers(accountId);
  let workspaces = loadWorkspaces();
  let workspaceMembers = loadWorkspaceMembers(accountId);
  let currentCompanyId = loadJSON(CURRENT_COMPANY_KEY, null);
  let currentProjectId = loadJSON(CURRENT_PROJECT_KEY, null);
  let currentTaskId = loadJSON(CURRENT_TASK_KEY, null);
  let currentWorkspaceId = loadJSON(CURRENT_WORKSPACE_KEY, null);

  // 归一化：currentWorkspaceId 不在 workspaces 里则兜底到第一个
  if (!currentWorkspaceId || !workspaces.some((w) => w.id === currentWorkspaceId)) {
    currentWorkspaceId = (workspaces[0] || normalizeWorkspace(DEFAULT_WORKSPACE)).id;
  }

  // 迁移：为每个工作空间补 ownerId（缺则归当前账号）+ 当前账号的 WorkspaceMember（缺则默认 admin）
  workspaces = workspaces.map((w) => (w.ownerId ? w : normalizeWorkspace({ ...w, ownerId: accountId })));
  for (const w of workspaces) {
    if (!workspaceMembers.some((m) => m.workspaceId === w.id && m.userId === accountId)) {
      workspaceMembers = workspaceMembers.concat(
        normalizeWorkspaceMember({ id: uid(), workspaceId: w.id, userId: accountId, role: 'admin', createdAt: Date.now() }, accountId),
      );
    }
  }

  // 迁移：为每个企业补当前账号的 CompanyMember（缺则取旧 Company.role 兜底，角色归属从 User 移到 Membership）
  for (const c of companies) {
    if (!members.some((m) => m.companyId === c.id && m.userId === accountId)) {
      members = members.concat(
        normalizeMember({ id: uid(), companyId: c.id, userId: accountId, name: account.name || '我', role: c.role || 'admin', createdAt: Date.now() }, accountId),
      );
    }
  }

  if (companies.length === 0) {
    const legacyAsset = loadJSON(LEGACY_ASSET_KEY, null);
    const legacyGoal = loadJSON(LEGACY_GOAL_KEY, null);
    const name = legacyAsset && legacyAsset.companyName ? String(legacyAsset.companyName) : '';
    if (name || legacyGoal) {
      const cid = uid();
      const pid = uid();
      const company = normalizeCompany({
        id: cid,
        name: name || '我的企业',
        type: 'manufacturer',
        role: 'admin',
        workspaceId: currentWorkspaceId,
        createdAt: Date.now(),
      });
      const project = normalizeProject({
        id: pid,
        companyId: cid,
        name: '默认项目',
        goalId: legacyGoal && legacyGoal.goalId ? String(legacyGoal.goalId) : null,
        createdAt: Date.now(),
      });
      const member = normalizeMember({ id: uid(), companyId: cid, userId: accountId, name: account.name || '我', role: 'admin', createdAt: Date.now() }, accountId);
      return { account, companies: [company], projects: [project], tasks, members: members.concat(member), workspaceMembers, workspaces, currentCompanyId: cid, currentProjectId: pid, currentTaskId, currentWorkspaceId };
    }
  }

  return { account, companies, projects, tasks, members, workspaceMembers, workspaces, currentCompanyId, currentProjectId, currentTaskId, currentWorkspaceId };
}

const CompanyContext = createContext(null);

/**
 * 企业/项目/任务 Provider。挂在根部，包裹 MarketingProvider。
 * 首次挂载时同步做老数据迁移 + 归一化。
 */
export function CompanyProvider({ children }) {
  const [state, setState] = useState(initCompanyState);
  const { account, companies, projects, tasks, members, workspaceMembers, workspaces, currentCompanyId, currentProjectId, currentTaskId, currentWorkspaceId } = state;

  // 持久化（任一字段变化即整体写回，保证原子一致）
  useEffect(() => {
    try {
      localStorage.setItem(COMPANIES_KEY, JSON.stringify(companies));
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
      localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
      localStorage.setItem(MEMBERS_KEY, JSON.stringify(members));
      localStorage.setItem(WORKSPACE_MEMBERS_KEY, JSON.stringify(workspaceMembers));
      localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
      if (currentCompanyId) localStorage.setItem(CURRENT_COMPANY_KEY, JSON.stringify(currentCompanyId));
      if (currentProjectId) localStorage.setItem(CURRENT_PROJECT_KEY, JSON.stringify(currentProjectId));
      if (currentTaskId) localStorage.setItem(CURRENT_TASK_KEY, JSON.stringify(currentTaskId));
      if (currentWorkspaceId) localStorage.setItem(CURRENT_WORKSPACE_KEY, JSON.stringify(currentWorkspaceId));
    } catch {
      /* 忽略写失败 */
    }
  }, [account, companies, projects, tasks, members, workspaceMembers, workspaces, currentCompanyId, currentProjectId, currentTaskId, currentWorkspaceId]);

  // ---- 派生 ----
  const workspace = useMemo(() => {
    return workspaces.find((w) => w.id === currentWorkspaceId) || workspaces[0] || normalizeWorkspace(DEFAULT_WORKSPACE);
  }, [workspaces, currentWorkspaceId]);

  /** 当前工作空间下的企业（多工作空间隔离边界）。 */
  const workspaceCompanies = useMemo(() => {
    const wid = workspace.id;
    return companies.filter((c) => c.workspaceId === wid);
  }, [companies, workspace]);

  const currentCompany = useMemo(() => {
    return workspaceCompanies.find((c) => c.id === currentCompanyId) || workspaceCompanies[0] || null;
  }, [workspaceCompanies, currentCompanyId]);

  /**
   * 有效当前企业 id —— 「当前企业」的唯一真源（对外导出值）。
   *
   * 为什么必须与 currentCompany 同口径兜底：currentCompanyId 可能失效（首次进入、
   * localStorage 键丢失/被清、企业被删、切到空白工作空间），此时 currentCompany 会兜底到
   * workspaceCompanies[0]，而 state.currentCompanyId 仍是 null / 旧值。凡是「按 companyId 取数」
   * 的消费方（营销资产 map、资产→知识库回流、活动草稿、企业列表勾选）拿 null 去读就会读空，
   * 表现是：首页与上下文里明明是 A 公司，A 公司的资料却整段不进入任务上下文。
   * 实测证据（第 5 层第 5 步）：douya-current-company 缺失时 /api/chat 的 context 掉「企业档案」
   * 槽位、产品数据整体缺失，而首页身份仍正确渲染为厂家。
   * 同类缺陷此前已在 ActivityWizard 内被单独绕开（改用它自己取 currentCompany.id），此处归一，
   * 让所有消费方不必各自兜底。
   */
  const effectiveCurrentCompanyId = currentCompany ? currentCompany.id : null;

  // 角色属于 Membership：当前账号在当前企业的角色，优先从 CompanyMember 读（同一用户不同公司角色独立），
  // 找不到时回退旧 Company.role（历史数据兼容），再兜底 admin。
  const currentRole = useMemo(() => {
    const cid = currentCompany && currentCompany.id;
    const uid = account && account.id;
    const m = members.find((x) => x.companyId === cid && x.userId === uid);
    if (m) return m.role;
    if (currentCompany && currentCompany.role) return currentCompany.role;
    return 'admin';
  }, [members, currentCompany, account]);

  /** 当前账号在当前工作空间的角色（WorkspaceMember）。 */
  const currentWorkspaceRole = useMemo(() => {
    const wid = workspace.id;
    const uid = account && account.id;
    const m = workspaceMembers.find((x) => x.workspaceId === wid && x.userId === uid);
    return m ? m.role : 'admin';
  }, [workspaceMembers, workspace, account]);

  /** 当前企业的成员列表（CompanyMember，本地先行）。 */
  const companyMembers = useMemo(() => {
    const cid = currentCompany && currentCompany.id;
    return members.filter((m) => m.companyId === cid);
  }, [members, currentCompany]);

  const companyProjects = useMemo(() => {
    const cid = currentCompany && currentCompany.id;
    return projects.filter((p) => p.companyId === cid);
  }, [projects, currentCompany]);

  const currentProject = useMemo(() => {
    return companyProjects.find((p) => p.id === currentProjectId) || companyProjects[0] || null;
  }, [companyProjects, currentProjectId]);

  /**
   * 有效当前项目 id —— 与 currentProject 同口径（同 currentCompany 的缺陷类）：
   * currentProjectId 可能是别的企业残留的 id（切公司后未清）或已失效值，此时 currentProject 会兜底到
   * 本企业首个项目；若消费方仍用原始 id，就会出现「项目选择器显示空白/选中他企业项目」的错位。
   */
  const effectiveCurrentProjectId = currentProject ? currentProject.id : null;

  const projectTasks = useMemo(() => {
    const pid = currentProject && currentProject.id;
    return tasks.filter((t) => t.projectId === pid);
  }, [tasks, currentProject]);

  const currentTask = useMemo(() => {
    return projectTasks.find((t) => t.id === currentTaskId) || null;
  }, [projectTasks, currentTaskId]);

  // 兜底修正：把 state 里的 currentCompanyId / currentProjectId 归一到「有效值」，
  // 使「内存 / context / localStorage」三处永久一致。否则只在内存正确、落盘仍是 null，
  // 刷新一次缺陷就复发（用户要求：刷新后身份与公司资料仍要正确）。
  useEffect(() => {
    setState((prev) => {
      if (prev.currentCompanyId === effectiveCurrentCompanyId && prev.currentProjectId === effectiveCurrentProjectId) {
        return prev; // 已一致：原样返回，避免多余重渲染
      }
      return { ...prev, currentCompanyId: effectiveCurrentCompanyId, currentProjectId: effectiveCurrentProjectId };
    });
  }, [effectiveCurrentCompanyId, effectiveCurrentProjectId]);

  /** 数据隔离派生：任务 → 项目 → 企业 的 join（Task 不落 companyId，由 projectId 派生）。 */
  const taskCompanyId = useCallback((task) => {
    if (!task) return null;
    const pid = task.projectId;
    const proj = projects.find((p) => p.id === pid);
    return proj ? proj.companyId : null;
  }, [projects]);

  /** 任务树（P1-4 子任务）：按 parentId 归组，roots 为顶级任务（无 parentId）。 */
  const taskTree = useMemo(() => {
    const childrenOf = {};
    const roots = [];
    for (const t of tasks) {
      const p = t.parentId || null;
      if (!childrenOf[p]) childrenOf[p] = [];
      childrenOf[p].push(t);
    }
    for (const t of tasks) {
      if (!t.parentId) roots.push(t);
    }
    return { roots, childrenOf };
  }, [tasks]);

  // ---- 方法 ----
  const createCompany = useCallback((name, type, role) => {
    const c = normalizeCompany({
      id: uid(),
      name: String(name || '').trim() || '未命名企业',
      type: normalizeCompanyType(type),
      role: ['admin', 'operator', 'viewer'].includes(role) ? role : 'admin',
      workspaceId: currentWorkspaceId || DEFAULT_WORKSPACE.id,
      createdAt: Date.now(),
    });
    const p = normalizeProject({
      id: uid(),
      companyId: c.id,
      name: '默认项目',
      goalId: null,
      createdAt: Date.now(),
    });
    // 角色归属 Membership：当前账号自动成为该企业的 CompanyMember（admin）
    const m = normalizeMember({
      id: uid(),
      companyId: c.id,
      userId: account && account.id ? account.id : 'self',
      name: (account && account.name) || '我',
      role: ['admin', 'operator', 'viewer'].includes(role) ? role : 'admin',
      createdAt: Date.now(),
    }, account && account.id);
    setState((prev) => ({
      ...prev,
      companies: [...prev.companies, c],
      projects: [...prev.projects, p],
      members: [...prev.members, m],
      currentCompanyId: c.id,
      currentProjectId: p.id,
      currentTaskId: null,
    }));
    return c;
  }, [currentWorkspaceId, account]);

  /**
   * 完整创建企业（第二阶段「首次登录 → 企业初始化」）：
   * 一次性建 企业 + 当前账号的 CompanyMember（角色归属 Membership）+ 基于目标的项目 + 首批建议任务。
   * 与 createCompany 的区别：支持 goalId（项目绑定目标）、projectName（按目标命名）、suggestedTasks（自动生成待办）。
   * @param {object} opts { name, type, role, goalId, projectName, suggestedTasks:[{title,capability}] }
   * @returns {{company:object, project:object}}
   */
  const createCompanyFull = useCallback((opts = {}) => {
    const name = String((opts && opts.name) || '').trim() || '未命名企业';
    const type = normalizeCompanyType(opts && opts.type);
    const role = ['admin', 'operator', 'viewer'].includes(opts && opts.role) ? opts.role : 'admin';
    const goalId = opts && opts.goalId ? String(opts.goalId) : null;
    const accountId = account && account.id ? account.id : 'self';
    const c = normalizeCompany({
      id: uid(),
      name,
      type,
      role,
      workspaceId: currentWorkspaceId || DEFAULT_WORKSPACE.id,
      createdAt: Date.now(),
    });
    const p = normalizeProject({
      id: uid(),
      companyId: c.id,
      name: String((opts && opts.projectName) || '').trim() || '默认项目',
      goalId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const m = normalizeMember(
      { id: uid(), companyId: c.id, userId: accountId, name: (account && account.name) || '我', role, createdAt: Date.now() },
      accountId,
    );
    const taskList = (Array.isArray(opts && opts.suggestedTasks) ? opts.suggestedTasks : [])
      .map((t) =>
        normalizeTask({
          id: uid(),
          projectId: p.id,
          title: String((t && t.title) || '').trim() || '未命名任务',
          status: 'todo',
          capability: (t && t.capability) || 'chat',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    setState((prev) => ({
      ...prev,
      companies: [...prev.companies, c],
      projects: [...prev.projects, p],
      members: [...prev.members, m],
      tasks: [...prev.tasks, ...taskList],
      currentCompanyId: c.id,
      currentProjectId: p.id,
      currentTaskId: null,
    }));
    return { company: c, project: p };
  }, [currentWorkspaceId, account]);

  const updateCompany = useCallback((id, patch) => {
    setState((prev) => ({
      ...prev,
      companies: prev.companies.map((c) => (c.id === id ? normalizeCompany({ ...c, ...patch }) : c)),
    }));
  }, []);

  /** 删除企业：级联删除其项目/任务/成员，并把当前指针切到剩余企业。 */
  const removeCompany = useCallback((id) => {
    setState((prev) => {
      const companies = prev.companies.filter((c) => c.id !== id);
      const cidSet = new Set(prev.projects.filter((p) => p.companyId === id).map((p) => p.id));
      const projects = prev.projects.filter((p) => p.companyId !== id);
      const tasks = prev.tasks.filter((t) => !cidSet.has(t.projectId));
      const members = prev.members.filter((m) => m.companyId !== id);
      const isCurrent = prev.currentCompanyId === id;
      const nextCompany = companies[0] || null;
      let currentProjectId = prev.currentProjectId;
      let currentTaskId = prev.currentTaskId;
      if (isCurrent) {
        currentProjectId = nextCompany ? (projects.find((p) => p.companyId === nextCompany.id) || {}).id || null : null;
        currentTaskId = null;
      }
      return { ...prev, companies, projects, tasks, members, currentCompanyId: isCurrent ? (nextCompany && nextCompany.id) || null : prev.currentCompanyId, currentProjectId, currentTaskId };
    });
  }, []);

  /** 改当前账号在某企业的角色（角色属于 Membership：更新当前账号的 CompanyMember，缺则补一条）。 */
  const updateCompanyRole = useCallback((id, role) => {
    const accountId = account && account.id ? account.id : 'self';
    const validRole = ['admin', 'operator', 'viewer'].includes(role) ? role : 'admin';
    setState((prev) => {
      const exists = prev.members.some((m) => m.companyId === id && m.userId === accountId);
      if (exists) {
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.companyId === id && m.userId === accountId ? normalizeMember({ ...m, role: validRole }, accountId) : m,
          ),
        };
      }
      const m = normalizeMember({ id: uid(), companyId: id, userId: accountId, name: account.name || '我', role: validRole, createdAt: Date.now() }, accountId);
      return { ...prev, members: [...prev.members, m] };
    });
  }, [account]);

  const addMember = useCallback((name, role) => {
    const cid = currentCompany && currentCompany.id;
    if (!cid) return null;
    const m = normalizeMember({
      id: uid(),
      companyId: cid,
      userId: account && account.id ? account.id : 'self',
      name: String(name || '').trim() || '未命名成员',
      role: ['admin', 'operator', 'viewer'].includes(role) ? role : 'viewer',
      createdAt: Date.now(),
    }, account && account.id);
    setState((prev) => ({ ...prev, members: [...prev.members, m] }));
    return m;
  }, [currentCompany, account]);

  const updateMemberRole = useCallback((id, role) => {
    setState((prev) => ({
      ...prev,
      members: prev.members.map((m) => (m.id === id ? normalizeMember({ ...m, role }) : m)),
    }));
  }, []);

  const removeMember = useCallback((id) => {
    setState((prev) => ({ ...prev, members: prev.members.filter((m) => m.id !== id) }));
  }, []);

  // ---- 账号（Account）----
  const setAccount = useCallback((user) => {
    const a = normalizeAccount(user && typeof user === 'object' ? user : {});
    setState((prev) => {
      const accountId = a.id || 'self';
      // 账号就绪后，为所有 workspace/company 补当前账号的成员关系（角色归属 Membership）
      let workspaceMembers = prev.workspaceMembers;
      for (const w of prev.workspaces) {
        if (!workspaceMembers.some((m) => m.workspaceId === w.id && m.userId === accountId)) {
          workspaceMembers = workspaceMembers.concat(
            normalizeWorkspaceMember({ id: uid(), workspaceId: w.id, userId: accountId, role: 'admin', createdAt: Date.now() }, accountId),
          );
        }
      }
      let members = prev.members;
      for (const c of prev.companies) {
        if (!members.some((m) => m.companyId === c.id && m.userId === accountId)) {
          members = members.concat(
            normalizeMember({ id: uid(), companyId: c.id, userId: accountId, name: a.name || '我', role: c.role || 'admin', createdAt: Date.now() }, accountId),
          );
        }
      }
      return { ...prev, account: a, members, workspaceMembers };
    });
  }, []);

  // ---- 多工作空间（Workspace）----
  const createWorkspace = useCallback((name) => {
    const w = normalizeWorkspace({
      id: uid(),
      name: String(name || '').trim() || '未命名工作空间',
      ownerId: account && account.id ? account.id : 'self',
      createdAt: Date.now(),
    });
    // 当前账号自动成为该工作空间的 WorkspaceMember（admin）
    const wm = normalizeWorkspaceMember({
      id: uid(),
      workspaceId: w.id,
      userId: account && account.id ? account.id : 'self',
      role: 'admin',
      createdAt: Date.now(),
    }, account && account.id);
    setState((prev) => ({
      ...prev,
      workspaces: [...prev.workspaces, w],
      workspaceMembers: [...prev.workspaceMembers, wm],
      currentWorkspaceId: w.id,
      currentCompanyId: null,
      currentProjectId: null,
      currentTaskId: null,
    }));
    return w;
  }, [account]);

  const switchWorkspace = useCallback((id) => {
    setState((prev) => {
      const ws = prev.workspaces.find((w) => w.id === id);
      if (!ws) return prev;
      const wsCompanies = prev.companies.filter((c) => c.workspaceId === id);
      const first = wsCompanies[0] || null;
      const firstProject = first ? prev.projects.find((p) => p.companyId === first.id) : null;
      return {
        ...prev,
        currentWorkspaceId: id,
        currentCompanyId: first ? first.id : null,
        currentProjectId: firstProject ? firstProject.id : null,
        currentTaskId: null,
      };
    });
  }, []);

  const renameWorkspace = useCallback((id, name) => {
    setState((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((w) => (w.id === id ? normalizeWorkspace({ ...w, name }) : w)),
    }));
  }, []);

  /** 删除工作空间：级联删除其下企业/项目/任务/成员，并把当前指针切到剩余工作空间。 */
  const removeWorkspace = useCallback((id) => {
    setState((prev) => {
      if (prev.workspaces.length <= 1) return prev; // 至少保留一个工作空间
      const workspaces = prev.workspaces.filter((w) => w.id !== id);
      const cidSet = new Set(prev.companies.filter((c) => c.workspaceId === id).map((c) => c.id));
      const companies = prev.companies.filter((c) => c.workspaceId !== id);
      const pidSet = new Set(prev.projects.filter((p) => cidSet.has(p.companyId)).map((p) => p.id));
      const projects = prev.projects.filter((p) => !cidSet.has(p.companyId));
      const tasks = prev.tasks.filter((t) => !pidSet.has(t.projectId));
      const members = prev.members.filter((m) => !cidSet.has(m.companyId));
      const workspaceMembers = prev.workspaceMembers.filter((m) => m.workspaceId !== id);
      const isCurrent = prev.currentWorkspaceId === id;
      const nextWs = workspaces[0] || null;
      let currentCompanyId = prev.currentCompanyId;
      let currentProjectId = prev.currentProjectId;
      let currentTaskId = prev.currentTaskId;
      if (isCurrent) {
        const nextCompany = nextWs ? companies.find((c) => c.workspaceId === nextWs.id) || null : null;
        currentCompanyId = nextCompany ? nextCompany.id : null;
        currentProjectId = nextCompany ? (projects.find((p) => p.companyId === nextCompany.id) || {}).id || null : null;
        currentTaskId = null;
      }
      return {
        ...prev,
        workspaces,
        companies,
        projects,
        tasks,
        members,
        workspaceMembers,
        currentWorkspaceId: isCurrent ? (nextWs && nextWs.id) || null : prev.currentWorkspaceId,
        currentCompanyId,
        currentProjectId,
        currentTaskId,
      };
    });
  }, []);

  const switchCompany = useCallback((id) => {
    setState((prev) => {
      const target = prev.companies.find((c) => c.id === id);
      if (!target) return prev;
      const firstProject = prev.projects.find((p) => p.companyId === id);
      return {
        ...prev,
        currentCompanyId: id,
        currentProjectId: firstProject ? firstProject.id : null,
        currentTaskId: null,
      };
    });
  }, []);

  const createProject = useCallback((name, goalId, extra) => {
    const cid = currentCompany && currentCompany.id;
    if (!cid) return null;
    const p = normalizeProject({
      id: uid(),
      companyId: cid,
      name: String(name || '').trim() || '未命名项目',
      goalId: goalId || null,
      ...(extra && typeof extra === 'object' ? extra : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setState((prev) => ({ ...prev, projects: [...prev.projects, p], currentProjectId: p.id, currentTaskId: null }));
    return p;
  }, [currentCompany]);

  const switchProject = useCallback((id) => {
    setState((prev) => ({ ...prev, currentProjectId: id, currentTaskId: null }));
  }, []);

  /** 更新项目字段（如 goalId / type / budget / kpi 等）。 */
  const updateProject = useCallback((id, patch) => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === id ? normalizeProject({ ...p, ...patch, updatedAt: Date.now() }) : p)),
    }));
  }, []);

  /** 给当前项目绑定营销目标（goalId）。 */
  const setProjectGoal = useCallback((goalId) => {
    const pid = currentProject && currentProject.id;
    if (!pid) return;
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === pid ? { ...p, goalId: goalId || null, updatedAt: Date.now() } : p)),
    }));
  }, [currentProject]);

  const addTask = useCallback((title, extra) => {
    const pid = currentProject && currentProject.id;
    if (!pid) return null;
    const t = normalizeTask({
      id: uid(),
      projectId: pid,
      title: String(title || '').trim() || '未命名任务',
      status: 'todo',
      ...(extra && typeof extra === 'object' ? extra : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setState((prev) => ({ ...prev, tasks: [...prev.tasks, t] }));
    return t;
  }, [currentProject]);

  /** 给指定项目建任务（不依赖 currentProject 闭包）。 */
  const addTaskToProject = useCallback((projectId, title, extra) => {
    const pid = projectId ? String(projectId) : '';
    if (!pid) return null;
    const t = normalizeTask({
      id: uid(),
      projectId: pid,
      title: String(title || '').trim() || '未命名任务',
      status: 'todo',
      ...(extra && typeof extra === 'object' ? extra : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setState((prev) => ({ ...prev, tasks: [...prev.tasks, t] }));
    return t;
  }, []);

  /** 给指定项目批量建任务（AI 助手生成任务清单后批量落库；capability 由 taskType 派生）。 */
  const addTasksToProject = useCallback((projectId, items) => {
    const pid = projectId ? String(projectId) : '';
    if (!pid) return [];
    const list = (Array.isArray(items) ? items : [])
      .map((it) => (it && typeof it === 'object' ? it : { title: it }))
      .filter((it) => String((it && it.title) || '').trim())
      .map((it) =>
        normalizeTask({
          id: uid(),
          projectId: pid,
          title: String((it && it.title) || '').trim() || '未命名任务',
          status: 'todo',
          taskType: asStr(it.taskType || it.task_type),
          priority: ['low', 'medium', 'high', 'urgent'].includes(it.priority) ? it.priority : 'medium',
          description: asStr(it.description),
          goal: asStr(it.goal),
          requirements: asStr(it.requirements),
          outputFormat: asStr(it.outputFormat),
          capability: asStr(it.capability),
          parentId: it.parentId == null ? null : asStr(it.parentId),
          notes: asArray(it.notes),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    if (list.length === 0) return [];
    setState((prev) => ({ ...prev, tasks: [...prev.tasks, ...list] }));
    return list;
  }, []);

  const updateTask = useCallback((id, patch) => {
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === id ? normalizeTask({ ...t, ...patch, updatedAt: Date.now() }) : t)),
    }));
  }, []);

  /** 给指定项目批量生成建议任务（不依赖 currentProject 闭包；透传 taskType/priority/description）。 */
  const seedProjectTasks = useCallback((projectId, tasks) => {
    const pid = projectId ? String(projectId) : '';
    if (!pid) return [];
    const list = (Array.isArray(tasks) ? tasks : [])
      .map((t) =>
        normalizeTask({
          id: uid(),
          projectId: pid,
          title: String((t && t.title) || '').trim() || '未命名任务',
          status: 'todo',
          taskType: asStr(t && (t.taskType || t.task_type)),
          priority: (t && ['low', 'medium', 'high', 'urgent'].includes(t.priority)) ? t.priority : 'medium',
          description: asStr(t && t.description),
          capability: asStr(t && t.capability),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    if (list.length === 0) return [];
    setState((prev) => ({ ...prev, tasks: [...prev.tasks, ...list] }));
    return list;
  }, []);

  /**
   * 任务状态流转（带 TASK_TRANSITIONS 校验，返回是否成功）。
   * todo→doing→review→done；非法跳转被拒绝（返回 false）。
   */
  const updateTaskStatus = useCallback((id, status) => {
    if (!['todo', 'doing', 'review', 'done', 'cancelled'].includes(status)) return false;
    const task = tasks.find((t) => t.id === id);
    if (!task) return false;
    if (task.status !== status && !(TASK_TRANSITIONS[task.status] || []).includes(status)) return false;
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === id ? normalizeTask({ ...t, status, updatedAt: Date.now() }) : t)),
    }));
    return true;
  }, [tasks]);

  /**
   * AI 完成任务：写 aiInput/aiProcess/aiOutput 并落到 review（AI 成功只到 review，review→done 仅人工）。
   * @param {string} id 任务 id
   * @param {object} aiResult { aiInput, aiProcess, aiOutput }
   */
  const completeTaskByAI = useCallback((id, aiResult) => {
    const r = aiResult && typeof aiResult === 'object' ? aiResult : {};
    setState((prev) => {
      const task = prev.tasks.find((t) => t.id === id);
      if (!task) return prev;
      return {
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === id
            ? normalizeTask({
                ...t,
                aiInput: r.aiInput == null ? null : r.aiInput,
                aiProcess: r.aiProcess == null ? null : r.aiProcess,
                aiOutput: r.aiOutput == null ? t.aiOutput : r.aiOutput,
                status: 'review',
                updatedAt: Date.now(),
              })
            : t,
        ),
      };
    });
  }, []);

  const setCurrentTask = useCallback((id) => {
    setState((prev) => ({ ...prev, currentTaskId: id || null }));
  }, []);

  const removeTask = useCallback((id) => {
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => t.id !== id),
      currentTaskId: prev.currentTaskId === id ? null : prev.currentTaskId,
    }));
  }, []);

  // ---- 批量（阶段四 P2 批量工作区）----
  /** 批量建任务：多行标题，一行一个任务，统一 capability。 */
  const addTasks = useCallback((titles, capability) => {
    const pid = currentProject && currentProject.id;
    if (!pid) return [];
    const list = (Array.isArray(titles) ? titles : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .map((title) =>
        normalizeTask({
          id: uid(),
          projectId: pid,
          title,
          status: 'todo',
          capability: capability || 'chat',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    if (list.length === 0) return [];
    setState((prev) => ({ ...prev, tasks: [...prev.tasks, ...list] }));
    return list;
  }, [currentProject]);

  /**
   * 批量改状态（带 TASK_TRANSITIONS 校验，与 updateTaskStatus 一致）。
   * 非法跳转的任务被跳过，返回实际成功变更的数量。
   */
  const batchUpdateTaskStatus = useCallback((ids, status) => {
    if (!['todo', 'doing', 'review', 'done', 'cancelled'].includes(status)) return 0;
    const idSet = new Set(ids || []);
    // 先基于当前 tasks 做合法校验（与 updateTaskStatus 同一规则），非法跳转跳过
    const validIds = tasks
      .filter((t) => idSet.has(t.id) && (t.status === status || (TASK_TRANSITIONS[t.status] || []).includes(status)))
      .map((t) => t.id);
    const validSet = new Set(validIds);
    if (validIds.length === 0) return 0;
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (validSet.has(t.id) ? normalizeTask({ ...t, status, updatedAt: Date.now() }) : t)),
    }));
    return validIds.length;
  }, [tasks]);

  /** 批量删除任务。 */
  const removeTasks = useCallback((ids) => {
    const idSet = new Set(ids || []);
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => !idSet.has(t.id)),
      currentTaskId: idSet.has(prev.currentTaskId) ? null : prev.currentTaskId,
    }));
  }, []);

  const value = useMemo(
    () => ({
      account,
      setAccount,
      companies,
      currentCompany,
      // 导出「有效值」而非 state 原始值：消费方从首帧起就拿到与 currentCompany 一致的企业 id。
      currentCompanyId: effectiveCurrentCompanyId,
      currentRole,
      currentWorkspaceRole,
      workspace,
      workspaces,
      currentWorkspaceId,
      workspaceCompanies,
      workspaceMembers,
      projects,
      companyProjects,
      currentProject,
      currentProjectId: effectiveCurrentProjectId,
      projectTasks,
      currentTask,
      currentTaskId,
      allTasks: tasks,
      taskTree,
      members,
      companyMembers,
      createCompany,
      createCompanyFull,
      updateCompany,
      updateCompanyRole,
      removeCompany,
      switchCompany,
      createWorkspace,
      switchWorkspace,
      renameWorkspace,
      removeWorkspace,
      createProject,
      switchProject,
      updateProject,
      setProjectGoal,
      addTask,
      addTaskToProject,
      addTasksToProject,
      updateTask,
      updateTaskStatus,
      completeTaskByAI,
      taskCompanyId,
      setCurrentTask,
      removeTask,
      seedProjectTasks,
      addTasks,
      batchUpdateTaskStatus,
      removeTasks,
      addMember,
      updateMemberRole,
      removeMember,
    }),
    [
      account, setAccount, companies, currentCompany, effectiveCurrentCompanyId, currentRole, currentWorkspaceRole,
      workspace, workspaces, currentWorkspaceId, workspaceCompanies, workspaceMembers,
      projects, companyProjects,
      currentProject, effectiveCurrentProjectId, projectTasks, currentTask, currentTaskId, tasks, taskTree, members, companyMembers,
      createCompany, createCompanyFull, updateCompany, updateCompanyRole, removeCompany, switchCompany,
      createWorkspace, switchWorkspace, renameWorkspace, removeWorkspace,
      createProject, switchProject, updateProject,
      setProjectGoal, addTask, addTaskToProject, addTasksToProject, updateTask, updateTaskStatus, completeTaskByAI,
      taskCompanyId, setCurrentTask, removeTask, seedProjectTasks,
      addTasks, batchUpdateTaskStatus, removeTasks,
      addMember, updateMemberRole, removeMember,
    ],
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error('useCompany 必须在 <CompanyProvider> 子树内使用');
  return ctx;
}

export default CompanyProvider;
