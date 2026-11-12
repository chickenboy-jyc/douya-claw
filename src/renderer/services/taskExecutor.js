/**
 * services/taskExecutor.js —— 统一 AI 执行入口（阶段四核心）。
 *
 * executeTask(task, opts) 走完整链路：
 *   Task → 读 Project → 读 Company → 四层 Context → 识别 Capability → 权限校验 →
 *   buildPrompt → execute → validate → 写入 Task（review）→ 生成 Asset。
 *
 * 与旧 projectAI.executeTaskWithAI 的区别：
 *  - 能力不再由组件指定，而是经 resolveCapabilityForType 从 task_type / 项目类型唯一派生；
 *  - 增加了 canUseCapability 业务路由 + 「建设中」能力拦截；
 *  - 结果校验 + 自动落库 Asset（按 capability.assetType，按 taskId 去重）；
 *  - 通过 onStage / onProgress 回调暴露真实执行阶段（不显示假进度）。
 *
 * 阶段五「可观测流水线」改造：
 *  - 8 个阶段抽成模块级常量 STAGES，UI 可直接枚举渲染时间轴；
 *  - 新增 opts.onProgress(event)：每步开始发 running、结束发 done/failed，带 elapsedMs；
 *  - 新增 opts.signal（AbortController.signal）：每个 await 边界检查，取消后还原任务为 todo；
 *  - 返回体带 runId / stages[] / summary{}，供「这次 AI 替你做了什么」结果卡使用。
 */

import { buildAIContext } from './contextBuilder.js';
import { resolveCapabilityForType, getCapability, canUseCapability } from '../capabilities/registry.js';
import { companyTypeLabel } from '../config/companyTypeConfig.js';

/**
 * 执行的 8 个阶段（顺序即执行顺序，UI 时间轴直接枚举本常量）。
 * @type {Array<{key:string, label:string}>}
 */
export const STAGES = [
  { key: 'prepare', label: '准备任务' },
  { key: 'context', label: '读取企业 / 项目上下文' },
  { key: 'resolve', label: '识别能力' },
  { key: 'execute', label: '调用 AI 执行' },
  { key: 'validate', label: '校验结果' },
  { key: 'writeback', label: '写入任务（待审核）' },
  { key: 'asset', label: '生成项目资产' },
  { key: 'finish', label: '完成' },
];

const STAGE_INDEX = STAGES.reduce((m, s, i) => {
  m[s.key] = i;
  return m;
}, {});

/** 生成一次执行的 runId（便于日志/结果卡定位，UI 只展示后 6 位）。 */
export function makeRunId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 取消哨兵错误：由外层 catch 识别并还原任务状态。 */
function makeAbortError(message) {
  const e = new Error(message || '已取消执行');
  e.__cancelled = true;
  return e;
}

function isAbortError(e) {
  return !!(e && e.__cancelled === true);
}

/** 让任意 Promise 可被 AbortSignal 中断（未传 signal 时原样返回，零开销）。 */
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(makeAbortError());
    };
    const done = (fn) => (v) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(done(resolve), done(reject));
  });
}

/** 毫秒 → 人类可读（<1000ms 显示 ms，否则显示 s）。 */
export function formatMs(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? Math.round(n) + 'ms' : (n / 1000).toFixed(1) + 's';
}

/**
 * 阶段进度上报器：维护 stages 快照 + 发 onProgress / onStage（向后兼容）。
 * onProgress event 结构：
 *   { runId, index(1-based), total, key, label, status:'running'|'done'|'failed'|'cancelled',
 *     elapsedMs, detail }
 */
function createReporter(opts, runId) {
  const stages = STAGES.map((s) => ({ key: s.key, label: s.label, status: 'pending', elapsedMs: 0, detail: '' }));
  let activeKey = null;
  let activeStart = 0;

  function emit(key, status, detail) {
    const i = STAGE_INDEX[key];
    if (i == null) return;
    const st = stages[i];
    st.status = status;
    if (detail != null) st.detail = String(detail);
    if (status === 'running') {
      st.elapsedMs = 0;
      activeKey = key;
      activeStart = Date.now();
    } else {
      st.elapsedMs = status === 'done' || status === 'failed' || status === 'cancelled'
        ? Math.max(0, Date.now() - activeStart)
        : st.elapsedMs;
      if (activeKey === key) activeKey = null;
    }
    if (typeof opts.onProgress === 'function') {
      try {
        opts.onProgress({
          runId,
          index: i + 1,
          total: stages.length,
          key,
          label: st.label,
          status,
          elapsedMs: st.elapsedMs,
          detail: st.detail || '',
        });
      } catch {
        /* 忽略 UI 回调异常，不阻断执行 */
      }
    }
    // 向后兼容：旧调用方只关心「当前在做什么」这一句文案
    if (typeof opts.onStage === 'function' && status === 'running') {
      try {
        opts.onStage(st.detail ? st.label + '：' + st.detail : st.label);
      } catch {
        /* 忽略 */
      }
    }
  }

  return {
    stages,
    /** 开始某阶段（可带补充说明，如能力名）。 */
    begin(key, detail) {
      emit(key, 'running', detail);
    },
    /** 正常结束某阶段。 */
    done(key, detail) {
      emit(key, 'done', detail);
    },
    /** 某阶段失败。 */
    fail(key, detail) {
      emit(key, 'failed', detail);
    },
    /** 取消：把当前进行中的阶段标记为 cancelled。 */
    abort(detail) {
      if (activeKey) emit(activeKey, 'cancelled', detail || '已取消');
    },
    /** 把 pending 阶段全部标记为跳过（提前 return 时用）。 */
    skipRest(detail) {
      for (const s of stages) {
        if (s.status === 'pending') {
          s.status = 'skipped';
          s.detail = detail || '未执行';
        }
      }
    },
  };
}

/**
 * 生成「任务资产落库器」：按 taskId + type 去重（已存在则更新，否则新增）。
 * @returns {(assetType, task, content, {companyId, projectId}) => string|null} 返回资产 id
 */
export function createTaskAssetSaver({ addAsset, updateAsset, listAssets } = {}) {
  return function saveAsset(assetType, task, content, { companyId, projectId }) {
    if (!addAsset || !assetType || !companyId) return null;
    const existing = listAssets
      ? listAssets({ companyId, projectId, taskId: task && task.id }).filter((a) => a.type === assetType && a.taskId === (task && task.id))
      : [];
    const name = (task && task.title) || 'AI 输出';
    if (existing.length && updateAsset) {
      updateAsset(existing[0].id, { name, content });
      return existing[0].id;
    }
    const a = addAsset({
      type: assetType,
      companyId,
      projectId: projectId || null,
      taskId: (task && task.id) || null,
      name,
      content,
      tags: [],
    });
    return a ? a.id : null;
  };
}

/**
 * 把一次执行的阶段摘要写进 task.aiProcess，让「这次跑过什么」可在任务详情里回看。
 * @returns {string}
 */
export function buildProcessText({ runId, capabilityName, stages, totalMs, charCount }) {
  const line = stages
    .filter((s) => s.status !== 'pending' && s.status !== 'skipped')
    .map((s) => `${s.label}${s.status === 'done' ? '' : '（' + (s.status === 'failed' ? '失败' : s.status === 'cancelled' ? '已取消' : s.status) + '）'} ${formatMs(s.elapsedMs)}`)
    .join(' → ');
  return [
    `已按「${capabilityName || 'AI'}」能力生成（runId=${runId}，总耗时 ${formatMs(totalMs)}${charCount ? `，${charCount} 字` : ''}）`,
    line ? `阶段：${line}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 统一执行一个任务。
 * @param {object} task 任务对象（含 taskType）
 * @param {object} opts {
 *   company, project, workspace, asset, knowledge, goalLabel, role, workspaceRole,
 *   projectMaterials, updateTaskStatus, completeTaskByAI, saveAsset,
 *   onStage, onProgress, signal
 * }
 * @returns {Promise<{
 *   ok:boolean, content?:string, aiInput?:string, aiProcess?:string, assetId?:string|null,
 *   runId:string, stages:Array<{key,label,status,elapsedMs,detail}>,
 *   summary:{charCount,lines,assetName,assetType,totalMs,capabilityName},
 *   building?:boolean, cancelled?:boolean, error?:string
 * }>}
 */
export async function executeTask(task, opts = {}) {
  if (!task) return { ok: false, error: '任务不存在', runId: '', stages: [], summary: {} };

  const company = opts.company || null;
  const companyType = company && company.type ? company.type : 'manufacturer';
  const project = opts.project || null;
  const signal = opts.signal || null;

  const runId = makeRunId();
  const startedAt = Date.now();
  const rep = createReporter(opts, runId);

  const throwIfCancelled = () => {
    if (signal && signal.aborted) throw makeAbortError();
  };

  /** 统一失败出口：标记阶段失败 + 补齐返回体。 */
  const failAt = (key, error, extra) => {
    rep.fail(key, error);
    rep.skipRest('未执行（前序阶段失败）');
    return {
      ok: false,
      error: String(error || 'AI 执行失败'),
      runId,
      stages: rep.stages,
      summary: { capabilityName: (extra && extra.capabilityName) || '', totalMs: Date.now() - startedAt },
      ...(extra || {}),
    };
  };

  try {
    // 1. 准备：识别能力（显式 task_type 优先 → 项目类型 → chat）
    throwIfCancelled();
    rep.begin('prepare');
    const capId = resolveCapabilityForType(task.taskType || task.capability, companyType, project && project.type);
    const cap = getCapability(capId) || getCapability('chat');
    rep.done('prepare', cap.id);

    // 2. 业务路由校验
    throwIfCancelled();
    if (!canUseCapability(companyType, cap.id)) {
      return failAt('prepare', `当前企业类型（${companyTypeLabel(companyType)}）不可用能力「${cap.name}」`, { capabilityName: cap.name });
    }

    // 3. 建设中拦截（不伪造）
    if (cap.status === 'building') {
      return failAt('prepare', `能力「${cap.name}」正在建设中，暂未接入真实后端，不能生成结果`, { building: true, capabilityName: cap.name });
    }

    // 4. 组装四层上下文
    throwIfCancelled();
    rep.begin('context');
    const ctx = buildAIContext({
      workspace: opts.workspace,
      company,
      asset: opts.asset,
      knowledge: opts.knowledge,
      project,
      task,
      role: opts.role || 'admin',
      workspaceRole: opts.workspaceRole || 'admin',
      goalLabel: opts.goalLabel || '',
      projectMaterials: opts.projectMaterials,
    });
    rep.done('context', [
      company && company.name ? company.name : '',
      project && project.name ? project.name : '',
    ].filter(Boolean).join(' / ') || '无企业上下文');

    // 5. 推进到进行中 + 调用能力（唯一的长耗时 await，可被 signal 中断）
    throwIfCancelled();
    rep.begin('resolve', cap.name);
    if (opts.updateTaskStatus) opts.updateTaskStatus(task.id, 'doing');
    rep.done('resolve', cap.name);

    rep.begin('execute', cap.name);
    let res = null;
    try {
      res = await withAbort(Promise.resolve(cap.execute(task, ctx)), signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      return failAt('execute', (e && e.message) || 'AI 执行异常', { capabilityName: cap.name });
    }
    throwIfCancelled();
    if (!res || !res.ok) {
      return failAt('execute', (res && res.error) || 'AI 执行失败', { building: !!(res && res.building), capabilityName: cap.name });
    }
    rep.done('execute', (String(res.content || '').length || 0) + ' 字');

    // 6. 结果校验
    throwIfCancelled();
    rep.begin('validate');
    const v = cap.validate ? cap.validate(res.content) : { ok: true };
    if (v && v.ok === false) {
      return failAt('validate', v.error || '结果校验未通过', { capabilityName: cap.name });
    }
    rep.done('validate');

    const content = String(res.content || '');
    const charCount = content.length;
    const lines = content ? content.split(/\r?\n/).filter((l) => l.trim()).length : 0;

    // 7. 写入任务（AI 成功只到 review），并把 runId + 阶段摘要写进 aiProcess 便于回看
    throwIfCancelled();
    rep.begin('writeback');
    const aiProcess = buildProcessText({
      runId,
      capabilityName: cap.name,
      stages: rep.stages,
      totalMs: Date.now() - startedAt,
      charCount,
    });
    if (opts.completeTaskByAI) {
      opts.completeTaskByAI(task.id, {
        aiInput: res.aiInput || '',
        aiProcess,
        aiOutput: res.content,
      });
    }
    rep.done('writeback', '待审核');

    // 8. 生成资产（按 capability.assetType，taskId 去重）
    let assetId = null;
    const assetName = (task && task.title) || 'AI 输出';
    if (cap.assetType && opts.saveAsset && company) {
      throwIfCancelled();
      rep.begin('asset', cap.assetType);
      assetId = opts.saveAsset(cap.assetType, task, res.content, {
        companyId: company.id,
        projectId: project ? project.id : null,
      });
      rep.done('asset', assetName);
    } else {
      rep.skipRest('该能力不落资产');
    }

    rep.begin('finish');
    rep.done('finish');

    return {
      ok: true,
      content: res.content,
      aiInput: res.aiInput || '',
      aiProcess: aiProcess || (res.aiProcess || ''),
      assetId,
      runId,
      stages: rep.stages,
      summary: {
        charCount,
        lines,
        assetName: assetId ? assetName : '',
        assetType: assetId ? cap.assetType : '',
        totalMs: Date.now() - startedAt,
        capabilityName: cap.name,
      },
    };
  } catch (e) {
    if (isAbortError(e)) {
      rep.abort('已取消');
      rep.skipRest('未执行（已取消）');
      // 取消后把任务还原为 todo，避免卡在 doing
      if (opts.updateTaskStatus) {
        try { opts.updateTaskStatus(task.id, 'todo'); } catch { /* 忽略状态还原失败 */ }
      }
      return {
        ok: false,
        cancelled: true,
        error: '已取消执行，AI 已产生的内容不会保存',
        runId,
        stages: rep.stages,
        summary: { totalMs: Date.now() - startedAt },
      };
    }
    return failAt('execute', (e && e.message) || 'AI 执行异常');
  }
}

export default executeTask;
