/**
 * procEvidence.js —— 「这次执行到底发生了什么」的**结构化事实**（唯一真源）。
 * ★ 2026-11-09 新增（作者：审查方）。为什么必须存在这个文件，见 docs/PATCH-2026-11-09.md
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 要钉住的缺陷
 * ═══════════════════════════════════════════════════════════════════════
 *   现状：一次技能调用失败后，上层只拿到**一段中文文本**（`String(err)`），
 *   于是 toolProtocol.classifyToolFailure 只能靠正则猜「这是超时还是被拦」。
 *   后果（用户报告的原话）：「它说被危险操作拦下了，其实是进程被 SIGTERM 杀了。」
 *
 *   两者是完全不同的事件：
 *     · 被门控拦下  ⇒ 进程**根本没起**（riskGate 命中，spawned=false）
 *     · 超时被杀    ⇒ 进程起来了，被**我们自己的** timeout 杀掉（timedOut=true）
 *     · 被外部杀掉  ⇒ 进程起来了，被**别人**（杀软 / 系统 / 另一个实例的清理）杀掉
 *   三者在磁盘上必须长得不一样，否则事后无法归因、模型也只能编一个理由。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 纪律
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **纯函数、零 fs、零 require**：单测可直接断言，不需要摆环境。
 *   ② **只产事实，不产结论**：这里不写「应该重试 / 应该换模型」，
 *      只写 `{kind, proc}`；对策仍在 toolProtocol.recoveryStrategyFor（单一真源）。
 *   ③ **不改既有文案**：本模块只往 Error 对象上挂属性（err.kind / err.proc），
 *      `err.message` 一个字节都不动 ⇒ 所有依赖文案的既有门禁不受影响。
 *   ④ kind 取值**与 toolProtocol.KIND 对齐**，不新增第 16 类（那会打破
 *      「15 个 KIND 逐个断言」的不变量）。外部杀进程归 `runtime` + proc.termSignal。
 */

'use strict';

// 与 toolProtocol.KIND 里同名者刻意保持同一字符串，避免两张表漂移。
const PROC_KIND = Object.freeze({
  TIMEOUT: 'timeout',               // 我们自己的 timeout 杀的
  ABORTED: 'aborted',               // 用户点「停止」
  SPAWN_FAILED: 'spawn_failed',     // 进程没起来（ENOENT / 权限）
  TERMINATED: 'terminated',         // 被外部信号杀（不是超时、不是叫停）
});

/** 这几个 kind 是「进程级事实」，可以直接覆盖基于文案的猜测。 */
const PROC_KIND_VALUES = Object.freeze(
  Object.keys(PROC_KIND).reduce((acc, k) => acc.concat(PROC_KIND[k]), [])
);

/**
 * 把一个 Error（或任意值）翻译成结构化事实。
 *
 * @param {any} err 技能抛出的错误
 * @param {{skillId?:string, timeoutMs?:number}} [opts]
 * @returns {{kind:(string|null), proc:(object|null), source:string}|null}
 */
function fromError(err, opts) {
  const o = opts || {};
  if (!err || typeof err !== 'object') return null;

  // ① 执行层已经自己定性过（skills.js 的超时/中断错误）⇒ 直接采信，不再猜。
  if (typeof err.kind === 'string' && PROC_KIND_VALUES.indexOf(err.kind) !== -1) {
    return {
      kind: err.kind,
      proc: err.proc && typeof err.proc === 'object' ? err.proc : null,
      source: 'error.kind',
    };
  }

  const skillId = o.skillId || err.skillId || null;
  const code = err.code;

  // ② 进程根本没起来：ENOENT / EACCES 这类 spawn 期错误。
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    const kind = (code === 'ENOENT') ? 'environment_error' : 'permission_error';
    return {
      kind,
      proc: { spawned: false, spawnError: String(code), skillId },
      source: 'spawn',
    };
  }

  // ③ Node execFile 的超时：会置 killed=true 且 signal='SIGTERM'。
  //    注意：**只有 killed===true 才敢认定为"我们的超时"**——
  //    外部 SIGTERM 不会把 killed 置真（见 ④），这是两者的分水岭。
  if (err.killed === true) {
    return {
      kind: 'timeout',
      proc: {
        spawned: true, timedOut: true, killedByUs: true,
        termSignal: err.signal || null,
        timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : null,
        skillId,
      },
      source: 'killed-flag',
    };
  }

  // ④ AbortError：用户叫停（与超时严格区分）。
  if (err.name === 'AbortError' || code === 'ABORT_ERR') {
    return { kind: 'aborted', proc: { spawned: true, aborted: true, skillId }, source: 'abort' };
  }

  // ⑤ 进程起来了、但不是我们杀的：只记事实，kind 交给文案分类（它有 stderr 可用）。
  //    这是本模块最重要的产出——把「别人杀的」和「我们杀的」在 trace 上分开。
  const termSignal = err.signal || null;
  const exitCode = (typeof code === 'number') ? code : null;
  if (termSignal || exitCode !== null) {
    return {
      kind: null,
      proc: {
        spawned: true, timedOut: false, killedByUs: false,
        termSignal, exitCode, skillId,
      },
      source: 'exit',
    };
  }

  return null;
}

/**
 * 把 fromError 的结果挂到 Error 上（additive，不改 message）。
 * @returns {Error} 原对象，便于链式使用
 */
function attach(err, info) {
  if (!err || typeof err !== 'object' || !info) return err;
  try {
    if (info.kind) err.kind = info.kind;
    if (info.proc) err.proc = info.proc;
  } catch { /* 冻结对象等极端情况：忽略，绝不让取证影响执行 */ }
  return err;
}

/**
 * 把 riskGate 的判定结果压成 trace 友好的一行（放进 recordSkip / taskTrace）。
 * 存在的理由：现在 trace 里只有一句中文「危险操作（类别）」，没有 ruleId / level / targets，
 * 于是「被门控拦下」与「执行后被信号杀」在审计里长得一样。
 *
 * @param {object} riskInfo classifyRisk 的返回值
 * @returns {{hit:boolean, category:(string|null), level:(string|null), targets:string[]}}
 */
function fromGate(riskInfo) {
  const r = riskInfo && typeof riskInfo === 'object' ? riskInfo : {};
  const risky = r.risky === true;
  return {
    hit: risky,
    category: risky ? (r.category || null) : null,
    level: risky ? (r.level || null) : null,
    targets: risky && Array.isArray(r.targets) ? r.targets.slice(0, 6).map(String) : [],
  };
}

/**
 * 人话描述（只用于 trace / 日志，不参与判定）。
 * @param {{kind:string, proc:object}} info
 * @returns {string}
 */
function describe(info) {
  if (!info) return '';
  const p = info.proc || {};
  switch (info.kind) {
    case PROC_KIND.TIMEOUT:
      return '超时被杀（我方 timeout=' + (p.timeoutMs == null ? '?' : p.timeoutMs) + 'ms）';
    case PROC_KIND.ABORTED:
      return '用户叫停';
    case PROC_KIND.SPAWN_FAILED:
      return '进程未启动（' + (p.spawnError || '?') + '）';
    case PROC_KIND.TERMINATED:
      return '被外部信号终止（' + (p.termSignal || '?') + '，exitCode=' + (p.exitCode == null ? 'null' : p.exitCode) + '）';
    default:
      return '';
  }
}

module.exports = {
  PROC_KIND,
  PROC_KIND_VALUES,
  fromError,
  attach,
  fromGate,
  describe,
};
