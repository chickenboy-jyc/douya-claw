'use strict';
/**
 * 豆芽记忆 2.0 · 旁路编排器（B 阶段收口）
 * ============================================================================
 * 本模块回答一个问题：**记忆处理失败时，用户任务会不会跟着失败？**
 * 答案必须是「不会」，而且这必须是**可反控证明**的，不是一句承诺。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * R5（设计总纲）：记忆是旁路，失败绝不能让用户任务失败。
 * ────────────────────────────────────────────────────────────────────────────
 * 老板钉扎第一条（2026-10-05）：
 *     主任务 = 完成 / memory extractor = 超时
 *     ⇒ 最终仍必须：任务 = COMPLETE、memory = 本轮未更新
 *     **不能反过来。**
 *
 * 实现手段（三层，缺一不可）：
 *   ① **超时熔断**：记忆阶段有硬超时（默认 1500ms）。超时 ⇒ 放弃本轮记忆，不等待。
 *      为什么必须有：记忆可能触发 LLM 调用（抽取/调和），而 LLM 会慢甚至挂住。
 *      没有超时 ⇒ 用户任务被一个旁路功能无限期拖住。
 *   ② **异常吞噬**：记忆阶段任何 throw 都被捕获、只记日志，**绝不向上传播**。
 *      与既有 `injectResumeState`（backend.js:842-848）同构。
 *   ③ **结果隔离**：编排器返回 **任务结果原样 + 记忆状态单独一栏**。
 *      调用方拿到的 `taskResult` 与"有没有记忆层"完全无关 ⇒ 结构上就不可能被影响。
 *
 * ⚠️ 三个「绝不」：
 *   · 绝不把记忆失败计入任务失败账本（不污染 unresolvedSteps / 完成判定）
 *   · 绝不因记忆失败而触发重试（不与熔断器、重试策略耦合）
 *   · 绝不让记忆写入与主产出争抢同一事务（档案坏了不能连累交付物）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * B 阶段扩展（2026-10-05）：「生成对话记忆」开关
 * ────────────────────────────────────────────────────────────────────────────
 * 设计稿 12 节顶部有「生成对话记忆 [开启]」这个开关。它的语义边界必须说清：
 *
 *   ★ 开关**只关抽取**，**绝不关 Secret 门**（设计稿第 537 行：Secret 拦截是
 *     「产品级硬规则，**不提供"用户自行决定"的开关**」）。
 *     关掉记忆后抽取器根本不跑 ⇒ Secret 门没有被绕过的可能（它本来就没被调用），
 *     而不是"跳过了一道本该执行的检查"。
 *
 *   ⇒ 所以本函数的 `enabled:false` 分支**在候选进入 Secret 门之前就返回** ——
 *     顺序不能反：先过门再判开关 ⇒ 就变成"开关能影响门"，语义就错了。
 */

const { filterMemoryCandidates, memorySecretGate, GATE_VERDICT } = require('./memorySecretGate');

/** 记忆阶段默认硬超时（ms）。超时即放弃本轮记忆，绝不拖延主任务。 */
const MEMORY_PHASE_TIMEOUT_MS = Number(process.env.DOUYA_MEMORY_TIMEOUT_MS) || 1500;

/** 记忆处理结果的三种状态（与任务状态**完全独立**）。 */
const MEMORY_STATUS = Object.freeze({
  UPDATED: 'UPDATED',           // 本轮有记忆被更新
  NO_CHANGE: 'NO_CHANGE',       // 跑完了，但没有值得记的
  SKIPPED: 'SKIPPED',           // 本轮未更新（超时 / 出错 / 关闭）—— 不是失败
});

/**
 * 记忆处理的**原因码**（供调用方与门禁钉住"为什么没更新"）。
 *
 * ★ 为什么必须单独存在（而不是只看 status）：
 *   SKIPPED 一个状态盖住了三种完全不同的原因 —— 用户关掉了 / 超时了 / 出错了。
 *   三者在 UI 上的文案、在排障时的含义、在门禁里的期望值**都不同**。
 *   只判 `status === 'SKIPPED'` 会踩仓库里那条红线：
 *   **否定式断言在"恰好为空/恰好被跳过"时恒真** ⇒ 分不清"因为开关关了所以没写"
 *   和"因为没数据所以没写"。⇒ 钉 reason。
 */
const MEMORY_REASON = Object.freeze({
  OK: 'ok',                                 // 正常跑完
  MEMORY_DISABLED: 'memory_disabled',       // ★ 用户关闭了「生成对话记忆」
  NO_CANDIDATES: 'no_candidates',           // 抽取器没产出任何候选
  TIMEOUT: 'timeout',                       // 记忆阶段超时（旁路熔断）
  ERROR: 'error',                           // 记忆阶段抛异常（已吞噬）
});


/**
 * 带超时地跑一个异步函数，并**提供权威的中止信号**给被调用方。
 *
 * ⚠️ 为什么不能只用 Promise.race（这是首版实现的真 bug，被 S3b 抓到）：
 *   `Promise.race([fn(), timeout])` 只能让**调用方**提前拿到超时结果，
 *   **拦不住 fn 已经启动的异步流程**。于是会出现：
 *     任务已返回、UI 显示"记忆本轮未更新"，但后台的写入还在跑 ——
 *     等它跑完，档案被**半途写入**（数据不一致），且资源被继续占用。
 *   这是典型的「假隔离」：表面没阻塞，实则副作用照样落地。
 *
 * 正确做法：把 `signal` 交给 fn，**要求它在每个副作用之前检查**。
 *   超时 ⇒ signal.aborted = true ⇒ fn 在下一步副作用前自行退出。
 *
 * ⇒ 约定：任何有副作用的 write 函数**必须**在写之前 `if (signal.aborted) return;`。
 *    本模块无法替它检查（副作用在它那边），但**提供了检查手段**，
 *    并且门禁用 S3b 断言**真的没有副作用落地**来钉死这条约定。
 *
 * @param {(signal:{aborted:boolean})=>Promise<any>} fn 接收 signal 的函数
 * @param {number} ms 超时毫秒
 * @returns {Promise<{ok:boolean, value?:any, error?:Error, timedOut?:boolean, aborted:boolean}>}
 */
function withTimeout(fn, ms) {
  const signal = { aborted: false };
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.aborted = true;          // ★ 通知被调用方：别再往下写了
      resolve({ ok: false, timedOut: true, aborted: true, error: new Error('memory phase timeout after ' + ms + 'ms') });
    }, ms);
    Promise.resolve()
      .then(() => fn(signal))
      .then(
        (value) => {
          if (settled) return;                 // 已超时 ⇒ 结果丢弃
          settled = true; clearTimeout(timer);
          resolve({ ok: true, value, aborted: false });
        },
        (error) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          resolve({ ok: false, error, aborted: false });
        }
      );
  });
}

/**
 * 记忆旁路编排器：**在任务完成之后**跑，且永远不改变任务结果。
 *
 * 调用形状（供 backend 接入时照抄）：
 *
 *     const taskResult = await runAgentLoop(...);          // 主任务，已完成
 *     const memoryOutcome = await runMemorySidePath({       // 旁路，失败也不影响上面
 *       candidates: collectCandidates(conversation),
 *       write: (passed) => reconciler.apply(passed),
 *     });
 *     return taskResult;                                    // ★ 原样返回，不看 memoryOutcome
 *
 * @param {{candidates?:Array, write?:Function, timeoutMs?:number, now?:Function, enabled?:boolean, owner?:string}} opts
 *        enabled 省略/非 false ⇒ 视为开启（默认开启：既有调用方不受影响）。
 *        ★ 只有**显式 `false`** 才关 —— 用 `enabled === false` 判定而不是 `!enabled`：
 *          后者会把 `undefined`（老调用方没传）当成"关闭"，等于**默认关掉所有人的记忆**，
 *          而且症状是静默的（记忆不再增长，没有任何报错）。
 * @returns {Promise<{status:string, reason:string, passedCount:number, rejectedCount:number,
 *                    rejected:Array, error?:string, timedOut?:boolean}>}
 *          —— 返回值**永远 resolve**，不 reject。调用方无需 try/catch。
 */
async function runMemorySidePath(opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : MEMORY_PHASE_TIMEOUT_MS;
  const candidates = Array.isArray(o.candidates) ? o.candidates : [];
  const write = typeof o.write === 'function' ? o.write : null;

  // ★★ 开关闸门 —— 必须放在 Secret 门**之前**（顺序即语义，见文件头 B 阶段扩展说明）。
  //   关掉记忆 ⇒ 抽取器不跑、Secret 门不被调用、write 一次都不进。
  //   ⚠️ 这里返回的是 SKIPPED 而不是"成功"，因为对用户来说"记忆本轮未更新"是事实；
  //      但 reason 必须如实写 memory_disabled，否则与"超时/出错"混为一谈。
  if (o.enabled === false) {
    return base(MEMORY_STATUS.SKIPPED, { reason: MEMORY_REASON.MEMORY_DISABLED });
  }

  // 没有任何候选 ⇒ 直接 NO_CHANGE，连超时计时器都不开。
  if (candidates.length === 0) {
    return base(MEMORY_STATUS.NO_CHANGE, { reason: MEMORY_REASON.NO_CANDIDATES });
  }

  const res = await withTimeout(async (signal) => {
    // ① 过 Secret 硬门（唯一入口）。拒收项在此**被移除**，后面的写入看不到它们。
    const filtered = filterMemoryCandidates(candidates);

    // ② 只有通过准入的才允许进入写入阶段。
    //
    //    ★ 这是「Extract 与 Write 彻底分开」的落实点（老板钉扎第二条）：
    //      Extractor 只能产出 candidates；能不能写、写什么，由这里决定。
    //      若 Extractor 产出垃圾/敏感候选，它们会在①被剔掉，**永远到不了 write**。
    //      所以"档案被污染"在结构上不可能发生 —— 不是靠约定，是靠数据流。
    if (write && filtered.passed.length > 0) {
      // signal 一并交给 write：超时后它必须在下一步副作用前自行退出，
      // 否则会出现"任务已返回、档案仍在后台被半途写入"的假隔离（S3b 钉死）。
      await write(filtered.passed, signal);
    }

    return {
      passedCount: filtered.passedCount,
      rejectedCount: filtered.rejectedCount,
      rejected: filtered.rejected,
      // ★ 只有**真的调用了 write** 才算写了一回。
      //   没传 write 却说"已更新"是假绿 ⇒ 必须是 NO_CHANGE（S6c 钉死）。
      wrote: !!(write && filtered.passed.length > 0 && !signal.aborted),
    };
  }, timeoutMs);

  // ③ 结果隔离：无论超时还是异常，都**不抛**，只反映在 memory 栏。
  if (!res.ok) {
    return base(MEMORY_STATUS.SKIPPED, {
      // ★ 超时与出错必须分开报 —— 两者在 UI 文案、排障方向、门禁期望值上全不同：
      //   超时 ⇒ 看 LLM 慢/挂住；出错 ⇒ 看代码缺陷。混成一个 reason 就没法分诊。
      reason: res.timedOut ? MEMORY_REASON.TIMEOUT : MEMORY_REASON.ERROR,
      passedCount: 0,
      rejectedCount: 0,
      rejected: [],
      timedOut: !!res.timedOut,
      error: res.error && res.error.message ? res.error.message : 'unknown',
    });
  }

  const v = res.value;
  return base(v.wrote ? MEMORY_STATUS.UPDATED : MEMORY_STATUS.NO_CHANGE, Object.assign({ reason: MEMORY_REASON.OK }, v));
}

function base(status, extra) {
  return Object.assign(
    {
      status,
      reason: '',
      passedCount: 0,
      rejectedCount: 0,
      rejected: [],
      timedOut: false,
      error: '',
    },
    extra || {}
  );
}

/**
 * 判断「这个 memory 结果是否应当影响任务终态」。
 *
 * 这是本模块最该被引用的一行 —— 把 R5 变成**可被断言的控制逻辑**：
 * 调用方要改任务终态前必须先问它，而它**恒为 false**。
 *
 * ⚠️ 为什么单独做成函数而不是写注释：注释管不住以后的人，
 *    而一个恒 false 的函数可以被门禁断言钉住（见 unit-memory-nonblocking.mjs）。
 *
 * @returns {boolean} 恒 false —— 记忆结果**永远不**影响任务终态
 */
function memoryAffectsTaskOutcome() {
  return false;
}

/**
 * 把记忆结果渲染成 UI 文案。
 * 刻意区分「没记忆更新」与「任务失败」—— 老板原话：memory = 本轮未更新，不是失败。
 */
function describeMemoryOutcome(outcome) {
  const o = outcome || {};
  switch (o.status) {
    case MEMORY_STATUS.UPDATED:
      return '记忆已更新（新增/确认 ' + o.passedCount + ' 条'
        + (o.rejectedCount ? '，拒收 ' + o.rejectedCount + ' 条敏感信息' : '') + '）';
    case MEMORY_STATUS.NO_CHANGE:
      return '本轮无需更新记忆';
    case MEMORY_STATUS.SKIPPED:
    default:
      // ★ 关闭态必须有**自己的**文案：说"处理超时/出错"是假话，用户只是把它关了。
      //   而"记忆本轮未更新"这句在三处都成立，所以它做兜底。
      if (o.reason === MEMORY_REASON.MEMORY_DISABLED) return '记忆已关闭（可在「设置 → 我的记忆」中开启）';
      if (o.timedOut) return '记忆本轮未更新（处理超时，不影响本次任务）';
      if (o.error) return '记忆本轮未更新（处理出错，不影响本次任务）';
      return '记忆本轮未更新';
  }
}

module.exports = {
  MEMORY_PHASE_TIMEOUT_MS,
  MEMORY_STATUS,
  MEMORY_REASON,
  withTimeout,
  runMemorySidePath,
  memoryAffectsTaskOutcome,
  describeMemoryOutcome,
  // 透传，便于调用方只 require 一个模块
  memorySecretGate,
  filterMemoryCandidates,
  GATE_VERDICT,
};
