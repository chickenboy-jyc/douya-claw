import { useEffect, useState } from 'react';

/**
 * 全局后台任务 store：让「生成中」跨模块切换不丢失，且**多任务可并行**。
 *
 * 问题（0.21.15 老板需求 7「做东西有概率会卡死，而且不能多线程工作」）：
 *   ① 各模块的生成都写在组件内部 useState 里，一旦切到别的模块组件卸载、state 丢失；
 *   ② 旧版 startJob **没有超时兜底** —— 只要底层请求不返回（后端挂了 / 网络半开 / token 过期
 *      但连接没断），busy 就永久为 true，界面上的按钮就永久转圈，这就是老板说的「卡死」；
 *   ③ 旧版 startJob **没有并发保护** —— 同一个 key 再启动一次会直接覆盖上一次的状态：
 *      第一次跑完把 busy 置 false，而第二次其实还在跑 ⇒ 按钮提前变回可点，结果又互相覆盖。
 *
 * 方案：
 *   · 任务统一通过 startJob 提交，状态（busy/result/error/note）存到模块级单例 + localStorage，
 *     组件用 useBackgroundJob(key) 订阅 ⇒ 切模块不影响任务继续跑。
 *   · **并行**：不同 key 各自独立，互不阻塞（同一个 jobStore 里不同字段）。
 *   · **同 key 不并发**：上一个还在跑时再次 startJob 会被**明确拒绝**（code: JOB_BUSY），
 *     而不是静默覆盖 —— 调用方据此提示「上一个还在跑」，用户不会看到「两条结果打架」。
 *   · **超时兜底**：默认 DEFAULT_JOB_TIMEOUT_MS（120s，可用 opts.timeoutMs 覆盖）。
 *     到点强制落 error + busy:false ⇒ UI 一定能退出 loading，绝不让 busy 永久为 true。
 *     同时把 AbortSignal 传给 taskFn（`taskFn({ signal })`），让底层 fetch 能真被中断。
 *   · **runId 世代号**：只允许「当前这一次」写终态。清空 / 重跑后，上一次的迟到回调
 *     不会把状态复活，也不会覆盖新结果。
 */

const JOBS_KEY = 'douya-background-jobs';

/** 单个后台任务的默认兜底超时（毫秒）。可用 startJob(key, fn, { timeoutMs }) 覆盖。 */
export const DEFAULT_JOB_TIMEOUT_MS = 120000;

const listeners = new Set();
let jobStore = loadFromStorage();
/** 自增世代号：每次 startJob 领一个，只有持有最新号的那次可以写终态。 */
let runSeq = 0;

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(JOBS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
function persist() {
  try {
    // 只持久化非 busy 状态（busy 是瞬态的，刷新后应回到空闲；否则刷新会出现「假的在地跑」）
    const slim = {};
    for (const [k, v] of Object.entries(jobStore)) {
      slim[k] = { result: v.result, error: v.error, note: v.note, at: v.at };
    }
    localStorage.setItem(JOBS_KEY, JSON.stringify(slim));
  } catch { /* 忽略配额错误 */ }
}
function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 单个监听器异常不影响其他人 */ }
  }
}

/** 未命中时的默认状态（字段固定，避免调用方读到 undefined）。 */
function emptyJob() {
  return { busy: false, result: null, error: '', note: '', at: 0, startedAt: 0, runId: 0, timedOut: false };
}

/**
 * 读某个 job 的当前状态（组件外也可用）。
 * @param {string} key 任务键
 * @returns {{busy:boolean, result:any, error:string, note:string, at:number, startedAt:number, runId:number, timedOut:boolean}}
 */
export function getJobState(key) {
  const v = jobStore[key];
  return v ? { ...emptyJob(), ...v } : emptyJob();
}

/**
 * 这个 key 上是不是有任务正在跑。
 * 调用方在提交前用它做「上一个还在跑」的预检，比 catch 返回码更直观。
 * @param {string} key 任务键
 * @returns {boolean}
 */
export function isJobRunning(key) {
  return !!(jobStore[key] && jobStore[key].busy);
}

/** 当前正在跑的任务数量（供全局指示条 / 诊断用；不含已完成态）。 */
export function countRunningJobs() {
  return Object.values(jobStore).filter((v) => v && v.busy).length;
}

/**
 * 列出全部任务快照（供全局「豆芽正在后台做」指示条使用）。
 * 返回 [{ key, busy, result, error, note, at, ... }]，按 at 倒序（最近的在前）。
 * 纯读，不触发 emit；订阅请用 useBackgroundJobs()。
 */
export function listJobs() {
  return Object.entries(jobStore)
    .map(([key, v]) => ({ ...emptyJob(), ...(v || {}), key }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * 写终态的唯一入口：只有「当前世代」的那一次运行才有资格写。
 * @param {string} key 任务键
 * @param {number} runId 本次运行的世代号
 * @param {object} patch 要写入的状态字段
 * @returns {boolean} 是否写入成功（false = 已被清空 / 已被更新的运行取代）
 */
function settle(key, runId, patch) {
  const cur = jobStore[key];
  if (!cur || cur.runId !== runId) return false;
  jobStore[key] = { ...cur, ...patch, runId };
  emit();
  persist();
  return true;
}

/**
 * 启动一个后台任务。
 *
 * @param {string} key 任务唯一键（如 `activity-plan-<companyId>`）
 * @param {(ctx:{signal:(AbortSignal|undefined), key:string}) => Promise<{ok:boolean, content?:string, result?:any, error?:string, note?:string}>} taskFn
 *        实际生成逻辑。参数可忽略（旧调用方无参写法照样工作）。
 *        - content：字符串结果（文案/报告等）
 *        - result：任意 JSON 可序列化值（数组/对象），结构化结果；优先于 content
 *        - note：自定义状态说明（不传则用「已完成 / 失败」）
 * @param {{timeoutMs?:number}} [opts] timeoutMs：本次任务的超时毫秒数
 * @returns {Promise<{ok:boolean, content?:string, result?:any, error?:string, note?:string, code?:string}>}
 *          与 taskFn 同构；被拒绝启动时返回 { ok:false, code:'JOB_BUSY'|'JOB_TIMEOUT'|'JOB_NO_KEY' }。
 */
export async function startJob(key, taskFn, opts = {}) {
  const jobKey = String(key == null ? '' : key).trim();
  if (!jobKey) return { ok: false, content: '', error: '后台任务缺少 key', code: 'JOB_NO_KEY' };
  if (typeof taskFn !== 'function') return { ok: false, content: '', error: '后台任务缺少执行函数', code: 'JOB_NO_FN' };

  // 同 key 不并发：明确拒绝，绝不静默覆盖上一次的运行
  if (isJobRunning(jobKey)) {
    return {
      ok: false,
      content: '',
      error: '上一个还在跑，等它出结果再点一次',
      code: 'JOB_BUSY',
    };
  }

  const runId = (runSeq += 1);
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_JOB_TIMEOUT_MS;
  const startedAt = Date.now();
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = ctrl ? ctrl.signal : undefined;

  jobStore[jobKey] = {
    ...(jobStore[jobKey] || {}),
    busy: true,
    error: '',
    note: '',
    result: null,
    at: startedAt,
    startedAt,
    runId,
    timedOut: false,
  };
  emit();

  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      // 到点：先中断底层请求，再让 race 落终态
      if (ctrl) { try { ctrl.abort(); } catch { /* 忽略 */ } }
      resolve({ __timedOut: true });
    }, timeoutMs);
  });

  try {
    const r = await Promise.race([
      Promise.resolve().then(() => taskFn({ signal, key: jobKey })),
      timeoutPromise,
    ]);

    if (r && r.__timedOut) {
      settle(jobKey, runId, {
        busy: false,
        result: null,
        error: `超过 ${Math.round(timeoutMs / 1000)} 秒没返回，已放弃（可以再点一次重试）`,
        note: '超时',
        at: Date.now(),
        timedOut: true,
      });
      return { ok: false, content: '', error: '后台任务超时', code: 'JOB_TIMEOUT' };
    }

    const hasResult = !!(r && r.result !== undefined && r.result !== null);
    const hasContent = !!(r && typeof r.content === 'string' && r.content.length > 0);
    const ok = !!(r && r.ok === true && (hasResult || hasContent));
    settle(jobKey, runId, {
      busy: false,
      result: hasResult ? r.result : (hasContent ? r.content : null),
      error: ok ? '' : ((r && r.error) || '生成失败'),
      note: ok ? ((r && r.note) || '已完成') : ((r && r.note) || '失败'),
      at: Date.now(),
      timedOut: false,
    });
    return r;
  } catch (e) {
    settle(jobKey, runId, {
      busy: false,
      result: null,
      error: '生成失败：' + ((e && e.message) || '未知错误'),
      note: '异常',
      at: Date.now(),
      timedOut: false,
    });
    return { ok: false, content: '', error: (e && e.message) || '未知错误' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 清除指定 job 的状态（重新生成前 / 用户点「清空」时调用）。
 * 同时把世代号作废：正在跑的那一次回来时不会把状态复活。
 * @param {string} key 任务键
 */
export function clearJob(key) {
  delete jobStore[key];
  persist();
  emit();
}

export function BackgroundJobsProvider({ children }) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return children;
}

/**
 * 订阅某个后台任务的状态。key 变化时自动切换订阅。
 * @param {string} key 任务键
 * @returns {{busy:boolean, result:any, error:string, note:string, at:number, startedAt:number, runId:number, timedOut:boolean}}
 */
export function useBackgroundJob(key) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return getJobState(key);
}

/**
 * 订阅「全部任务」快照 —— 供全局后台任务指示条使用。
 * 任何任务状态变化都会触发重渲染。
 * @returns {Array<{key:string, busy:boolean, result:any, error:string, note:string, at:number}>}
 */
export function useBackgroundJobs() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return listJobs();
}

export default BackgroundJobsProvider;
