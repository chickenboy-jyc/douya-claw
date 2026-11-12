/**
 * agentRuntime.js —— 「可替换 AgentLoop」的边界（运行底座 P1，**阶段 1**）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这是**阶段 1 边界**，不是重构
 * ═══════════════════════════════════════════════════════════════════════
 *   `runAgentLoop(payload, cfg, skills, res, retBox?)` 那 5451 行主循环
 *   （`runAgentLoopInner`）一个字节都不改。
 *   本文件只是一层薄包壳：把「谁来执行这一轮任务」从「宿主直接调一个具体函数」
 *   变成「宿主调一个可替换的接口」。调用点从 `await runAgentLoop(...)` 改成
 *   `await agentRuntime.run(request)`，返回值暂不消费 ⇒ 阶段 1 **零行为变化**。
 *
 *   ★ **请求上下文（`cfg` / `skills` / `res`）仍由宿主提供**：本层不创建、不解释、
 *     也不持久化它们；`signal` 只在 request 形状里占位，阶段 1 不消费。
 *   ★ **将来接 Harness 只需换 impl + 加一层参数适配，调用方不改**：
 *     `setImpl(harnessImpl, 'harness')` 换掉执行体，若 Harness 的入参形状不同，
 *     在 impl 内做一次 `request → harnessArgs` 的适配即可；`handleChat` 与
 *     `module.exports.agentRuntime` 的调用契约不变。这也是本层存在的唯一理由。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 纪律
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **不吞异常**：impl 抛错原样抛出，让调用方看得见；读 trace 失败才降级为 `[]`。
 *   ② **不伪造证据**：`events` 取自 `taskTrace.read(taskId).events`（P0 已保证带 seq）；
 *      读不到 / 抛错 / 没有记录 ⇒ 一律 `[]`，**如实空**，不补一条假事件、不拿 taskId 冒充。
 *   ③ **纯 CJS、纯 Node 可 require**：不依赖 Electron 运行时，方便门禁在进程内注入替换。
 */

const taskTrace = require('./taskTrace');

/**
 * 调用契约（导出给门禁逐条断言，避免"口径写在注释里、代码里另有一套"）。
 *
 * @type {Readonly<{implSignature:string, requestShape:string[], required:string[],
 *                  resultShape:string[], eventsFallback:string, boundary:string}>}
 */
const RUNTIME_CONTRACT = Object.freeze({
  implSignature: 'runAgentLoop(payload, cfg, skills, res, retBox?) => { acceptance }',
  requestShape: ['sessionId', 'taskId', 'payload', 'cfg', 'skills', 'res', 'signal', 'retBox'],
  required: ['payload', 'res', 'taskId'],
  resultShape: ['acceptance', 'events', 'runtime'],
  eventsFallback: 'taskTrace.read(taskId).events；读不到或抛错 ⇒ []（如实空，不伪造）',
  boundary: '阶段 1：请求上下文仍由宿主提供；接 Harness 只需换 impl + 参数适配，调用方不改',
});

/**
 * 读一次任务的 trace 事件。**失败一律返回空数组**，不抛、不编造。
 *
 * @param {string} taskId
 * @returns {Array<object>}
 */
function readEvents(taskId) {
  try {
    const rd = taskTrace.read(taskId);
    return Array.isArray(rd && rd.events) ? rd.events : [];
  } catch {
    return [];
  }
}

/**
 * 校验收到的请求。缺必填字段**抛错**，不静默降级 —— 静默降级会让
 * "换了个 impl 少收一个参数"这种事故在几个月后才以难查的现场暴露。
 *
 * @param {object} request
 */
function assertRequest(request) {
  const r = request && typeof request === 'object' ? request : {};
  for (const key of RUNTIME_CONTRACT.required) {
    const v = r[key];
    if (v === undefined || v === null) {
      throw new Error('agentRuntime.run: 缺少必填字段 ' + key + '（RUNTIME_CONTRACT.required）');
    }
  }
  if (!r.payload || typeof r.payload !== 'object') {
    throw new TypeError('agentRuntime.run: payload 必须是对象');
  }
  if (!r.res || typeof r.res !== 'object') {
    throw new TypeError('agentRuntime.run: res 必须是对象');
  }
  // ⚠️ 不强制 taskId 非空：宿主在 `payload.taskId` 缺省时传空串（内层会自己 genId，
  //    本层不替它生成、也不改写 payload —— 那是行为变化）。空串 ⇒ readEvents 读到 []，
  //    如实空，不伪造。缺 key（undefined/null）才在上面的 required 循环里抛错。
}

/**
 * 建一个可替换的 AgentLoop 运行时。
 *
 * @param {{impl:Function, name?:string}} options
 * @returns {{run:(request:object)=>Promise<{acceptance:*, events:Array<object>, runtime:string}>,
 *            setImpl:(impl:Function, name?:string)=>string, currentName:()=>string}}
 */
function createAgentRuntime(options) {
  const o = options || {};
  if (typeof o.impl !== 'function') {
    throw new TypeError('createAgentRuntime: impl 必须是函数');
  }
  let currentImpl = o.impl;
  let currentName = String(o.name || 'unnamed');

  return {
    /**
     * 跑一轮任务。**不消费返回值的调用方也不会因此改变行为**（阶段 1 的零行为变化靠这条）。
     *
     * @param {{sessionId?:string, taskId:string, payload:object, cfg:*, skills:*, res:object, signal?:*,
     *          retBox?:{acceptance:*, usedTokens?:number, toolsSeen?:string[]}}} request
     * @returns {Promise<{acceptance:*, events:Array<object>, runtime:string}>}
     */
    async run(request) {
      assertRequest(request);
      // impl 的异常原样抛出（纪律①）：不包 try/catch，不转换成"软失败"。
      // ★ 阶段 2：`retBox` 作为第 5 个实参**原样透传**（缺省 undefined ⇒ 薄壳自建）。
      //   为什么必须透传：替补第二实例（backend.js 的 `retBox2`）要读 `acceptance` / `usedTokens` /
      //   `toolsSeen`，而这些只有内层能写。不走这条边界就得直调 `runAgentLoopInner` —— 那正好是
      //   「又是一个没人管的第二执行者」这个洞。透传之后两个实例走同一条边界，可替换性不再漏一处。
      const ret = await currentImpl(request.payload, request.cfg, request.skills, request.res, request.retBox);
      const acceptance = ret && typeof ret === 'object' && 'acceptance' in ret ? ret.acceptance : null;
      return {
        acceptance,
        events: readEvents(request.taskId),
        runtime: currentName,
      };
    },

    /**
     * 真的换掉内部 impl（「可替换」的落点），返回**旧**实现名。
     *
     * @param {Function} nextImpl
     * @param {string=} name
     * @returns {string} 旧实现名
     */
    setImpl(nextImpl, name) {
      if (typeof nextImpl !== 'function') {
        throw new TypeError('agentRuntime.setImpl: impl 必须是函数');
      }
      const oldName = currentName;
      currentImpl = nextImpl;
      currentName = String(name || 'unnamed');
      return oldName;
    },

    /** @returns {string} 当前实现名。 */
    currentName() {
      return currentName;
    },
  };
}

module.exports = { createAgentRuntime, RUNTIME_CONTRACT };
