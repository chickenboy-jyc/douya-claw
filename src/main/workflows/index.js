/**
 * workflows —— 任务工作流的**注册表**，也是"这次该走哪套工作流"的**唯一选择入口**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 两条纪律（写在最前面，因为这两条一破，后面所有门禁都会失去意义）
 *
 * ① **本文件只回答「这次请求该走哪套任务工作流」，不做行为模式分类。**
 *    「该不该直接回答 / 先出方案 / 直接执行 / 只做诊断」是**另一个维度**，
 *    由 `src/main/intentGate.js` 的 `classifyIntent` 负责。
 *    两件事容易被混成一件（它们都从同一句用户原话里抽信号），但混在一起后
 *    任何一侧调整判据都会悄悄改变另一侧的行为 —— 所以这里**不许**出现
 *    "是不是在问问题""要不要先给方案"这类判断，也不许为了少写一个函数
 *    让同一个正则同时承担两种语义。
 *
 * ② **注册顺序 = 匹配优先级；通用兜底必须排在最后。**
 *    `selectWorkflow` 按数组顺序逐个试 `match()`，第一个非 null 即胜出。
 *    兜底（`general-v1`，`lifecycle: 'none'`）的 `match` 恒非 null ⇒
 *    它一旦排到专用工作流前面，后面所有专用工作流就**永远选不中**。
 *    新增工作流的插入位置：兜底**之前**、按"越专用越靠前"排。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 注册项契约（每个 `require('./xxx')` 的导出对象）：
 *   · `workflowId`  string   稳定 id，进 trace / 运行记录，事后据此复现"当时按什么判的"
 *   · `version`     number   标准版本；**改了判据必须换版本**（同 id 不同标准 = 无法复现）
 *   · `lifecycle`   'full' | 'none'
 *        'full' —— 这是一套**完整可执行**的工作流：本项自己就是 cfg（stages /
 *                  requiredStages / requiredChecks / repairPolicy …），`backend.js`
 *                  会为它建控制器、开跨请求状态、做收尾验收。
 *        'none' —— 只有"选择"这个动作，没有生命周期（兜底即此）。
 *   · `match(text, ctx) → object|null`
 *        非 null = 命中（返回值即本次识别出的 spec，可为 `{}`）；null = 未命中。
 *        ★ `match` 抛错一律**按未命中处理**（本文件 try/catch 成 null），
 *          绝不向上抛：识别是增益，不是单点故障源 —— 一条正则写错不该让整个请求死掉。
 *
 * 返回形状（`selectWorkflow`）：
 *   `{ workflowId, version, lifecycle, spec, cfg, entry, lifecycleRaw }`
 *     · `cfg`      —— `lifecycle === 'full'` 时就是注册项本身（可直接喂 `workflowRunner`）；
 *                     `'none'` 时为 **null**，刻意不把"没有标准"包装成"一份空标准"
 *                     （空 cfg 会让 `evaluate()` 立刻判"全部阶段完成"，见 general-v1 头注）。
 *     · `spec`     —— 命中的 `match` 的返回值（`'none'` 项下仅作观测信息，无消费者）。
 *     · `entry`    —— **选中的注册对象本身**（2026-10-25 新增）：**任何 lifecycle 都给**。
 *                     与 `cfg` 的分工见 `selectWorkflow` 里那段头注：「能不能执行」vs
 *                     「是哪套工作流、它声明了什么」。判据类声明（如 `regenKind`）从这里取。
 *     · `lifecycleRaw` —— 归一化**之前**的原始声明（缺失 ⇒ null）。
 *   一个都没命中 ⇒ 返回 **null**（调用方据此 no-op）。
 */

'use strict';

/**
 * 注册表。★ 顺序即优先级，兜底（general-v1）必须在最后。
 * 注意：这里的 `require` 都是**顶层**的，所以被注册的模块在加载期**不许**反向 require 本文件
 *      或 `../workflowRunner`（会成环）。需要对方能力时用函数体内的惰性 `require`。
 */
const REGISTRY = [
  require('./pptx-v1'),    // 专用工作流：PPT / 演示文稿（lifecycle:'full'，判据仍在 workflowRunner）
  require('./general-v1'), // 通用兜底：**必须最后**（lifecycle:'none'，不建控制器）
];

/**
 * lifecycle 归一：'full' / 'none' 原样返回，其余（缺失 / 拼错 / 任何别的值）返回 **'unknown'**。
 *
 * ★ 为什么把 'unknown' 单独分出来（2026-10-24，审查者 P0-② 实测）：
 *   原来这里写成 `v === 'full' ? 'full' : 'none'`，于是一条 `lifecycle: 'ful'`（少一个 l）
 *   的注册项会被**静默**当成兜底 —— 只要它的 `match` 命中，整个请求就被吞成 no-op，
 *   并且**挡住它后面所有注册项（含真兜底）**，零错误零警告。
 *   实测现场：`picked={workflowId:'demo-typo-v1', lifecycle:'none', cfg:null}`、
 *   `general-v1` 再也选不到、`console.warn` 一次都没响。
 *   这类"配置写错 ⇒ 全产品静默降级"是最难查的一类故障，所以归一化的**结果**要能把
 *   "配置错了"与"人家就是这么声明的"分开，由 `selectWorkflow` 决定怎么处置（见下）。
 *
 * ⚠️ 归一的**行为**没变：`'unknown'` 在 `selectWorkflow` 里仍然按 `'none'` 处置（不建控制器）。
 *   这一版只加了"能被看见"，没有改任何选择/生命周期的语义。
 */
function normalizeLifecycle(v) {
  if (v === 'full') return 'full';
  if (v === 'none') return 'none';
  return 'unknown';
}

/**
 * 已经警告过的 workflowId（每个只警告一次）。
 *
 * 为什么必须去重：非 PPT 请求**每一轮**都会走到 `selectWorkflow`，兜底项每轮都命中。
 * 不去重的话一条配置错误会把日志刷成几千行，最后没人看得见真正的那一行。
 * 只按 id 去重（不按 lifecycle 值）：同一个工作流反复写错是同一个问题，报一次就够。
 */
const WARNED = new Set();

/** workflowId 归一：非字符串一律空串（宁可空着，也不编一个 id 进运行记录）。 */
function normalizeId(v) {
  return typeof v === 'string' ? v : '';
}

/** version 归一：非有限数字一律 0（不编版本号）。 */
function normalizeVersion(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 选工作流：按注册顺序试 `match`，第一个非 null 胜出。
 *
 * @param {string} text 用户原话（`null`/`undefined` 一律当空串：空串时专用工作流不会命中）
 * @param {object} [ctx] 上下文（附件、taskId …；原样转交 `match`，本层不解释）
 * @returns {{workflowId:string, version:number, lifecycle:'full'|'none', spec:object,
 *            cfg:object|null, entry:object, lifecycleRaw:(string|undefined|null)}|null}
 */
function selectWorkflow(text, ctx) {
  const t = String(text == null ? '' : text);
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  for (let i = 0; i < REGISTRY.length; i += 1) {
    const entry = REGISTRY[i];
    // 结构不合法的注册项**跳过**（不抛）：注册表是选择器，不是断言器；
    // 它坏了应该是"这套工作流没被选上"，不该是"整个请求起不来"。
    if (!entry || typeof entry !== 'object' || typeof entry.match !== 'function') continue;
    let spec = null;
    try {
      spec = entry.match(t, c);
    } catch (e) {
      spec = null;   // ★ 纪律：match 抛错 = 未命中（见文件头契约）
    }
    if (!spec) continue;
    const lcRaw = normalizeLifecycle(entry.lifecycle);
    const workflowId = normalizeId(entry.workflowId);
    // ★ 配置错了要**响**（见 normalizeLifecycle 头注的实测现场）。
    //   为什么这里用 console.warn 且**不加** debug 开关：这不是调试信息，是"产品被降级了"的告警，
    //   默认就得能被看见（与 backend.js 里那些 DOUYA_DEBUG_* 决策日志不同性质）。
    if (lcRaw === 'unknown' && !WARNED.has(workflowId)) {
      WARNED.add(workflowId);
      try {
        console.warn('[workflow] ' + (workflowId || '(无 id)') + ' 的 lifecycle 声明非法（'
          + JSON.stringify(entry.lifecycle) + '），按 none 处置 —— 它会被选中但不会建立生命周期。'
          + '这几乎肯定是配置错误：合法值只有 \'full\' / \'none\'。');
      } catch { /* 日志失败绝不影响选择 */ }
    }
    const lifecycle = lcRaw === 'full' ? 'full' : 'none';   // ← 行为保持：unknown 仍按 none
    return {
      workflowId,
      version: normalizeVersion(entry.version),
      lifecycle,
      spec,
      cfg: lifecycle === 'full' ? entry : null,
      /**
       * ★ 选中的**注册对象本身**（2026-10-25 新增）。与 `cfg` 的区别是本次契约切口的核心：
       *   · `cfg`   = "能不能执行"：只有 'full' 才给（一份可执行契约：stages/requiredChecks…）；
       *   · `entry` = "是哪套工作流、它声明了什么"：**任何 lifecycle 都给**。
       *   分开的理由：'none' 的项没有可执行契约（`cfg:null` 是对的），但它**仍然有身份** ——
       *   它一样可以声明 `regenKind` 这类判据。以前调用方只有 `cfg` 一个入口，
       *   于是"取不到 cfg"被当成"没有工作流判据" ⇒ 退回全局 PPT 判据。
       *   有了 `entry`，判据来源与"建不建生命周期控制器"彻底解耦。
       * ⚠️ `entry` 是**加载期那个对象本身**（不是拷贝）：各工作流用 `this` 取配置
       *   （见 pptx-v1.match 头注），拷贝会把"识别用的 cfg"与"交出去的 cfg"分成两份。
       */
      entry,
      /** 归一化**之前**的原始声明（缺失 ⇒ null）。给观测/门禁用：能分辨"写错"与"没写"。 */
      lifecycleRaw: entry.lifecycle === undefined ? null : entry.lifecycle,
    };
  }
  return null;
}

/**
 * 注册了什么（给门禁 / 观测 / 事后审计用；**不参与选择**）。
 *
 * ★ `lifecycle` 保持只返回 `'full' | 'none'`：`normalizeLifecycle` 现在会返回 `'unknown'`，
 *   但这里**必须**继续把它折成 `'none'` —— 否则 `list()` 的取值域会从两值变成三值，
 *   任何按两值判的消费者（门禁、观测、后续工作流）都会在"配置写错"时看到新值而误判。
 *   想知道"写错了没有"请读 `lifecycleRaw`（原始声明，缺失为 null）。
 *
 * @returns {Array<{workflowId:string, version:number, lifecycle:'full'|'none', lifecycleRaw:(string|undefined|null)}>} 顺序 = 匹配优先级
 */
function list() {
  return REGISTRY
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.match === 'function')
    .map((entry) => ({
      workflowId: normalizeId(entry.workflowId),
      version: normalizeVersion(entry.version),
      // unknown ⇒ 'none'（行为同 selectWorkflow），另用 lifecycleRaw 暴露原始值
      lifecycle: normalizeLifecycle(entry.lifecycle) === 'full' ? 'full' : 'none',
      lifecycleRaw: entry.lifecycle === undefined ? null : entry.lifecycle,
    }));
}

module.exports = {
  selectWorkflow,
  list,
  /** 注册表本体（只读用途：门禁核对"顺序/条数"用；**不许**在别处直接遍历它做选择） */
  WORKFLOWS: REGISTRY,
};
