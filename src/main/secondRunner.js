'use strict';
/**
 * secondRunner —— 「卡住时换人干」里的**那个"人"**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、它要解决的问题（老板原话）
 * ══════════════════════════════════════════════════════════════════════════
 *   「如果几个 Agent 使用相同模型、相同上下文、相同判断方式，它们可能只是集体犯同一个错误。」
 *   「尤其是替补 Agent：它必须知道前任尝试过什么、为什么失败、哪些办法不能再用。」
 *
 * 本仓现状（2026-02-16 查证，改动前）：
 *   · `handoffBrief.js` 已经把「换手时该给哪一页纸」做好了，也已接线（backend.js 里注入一条 system）；
 *     但它注入的是**同一个执行实例的对话**——信息变了，**人没变**；
 *   · 工单上早就印着「并行模式：开启（双方案对比）」，却**零个消费者**（见 backend.js 那段注释的
 *     自查记录）——第二个执行者根本不存在，只是纸上印着一行字。
 *   ⇒ 本轮补的就是那"第二个人"：**另一个 taskId、另一个模型（能拿到的话）、更小的工具集、
 *     只带交接单的全新上下文**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、为什么是「有界递归子运行」而不是抽一个工具执行器
 * ══════════════════════════════════════════════════════════════════════════
 *   本仓**没有**可复用的单次工具执行函数（`executeTool` / `runTool` / `callTool` / `execToolCall`
 *   全仓零命中）—— 工具执行是主循环里内联的一大段。要抽出执行器就得把主循环拆开，
 *   爆炸半径远大于收益。所以第二实例**递归调用 `runAgentLoopInner` 自己**：
 *   它天然拥有完整的"模型→工具→回灌"能力、自己一份失败账本、自己的 taskEntry 与叫停入口。
 *   代价是必须把它的**输入**（payload）和**出口**（res）都做成受控的：
 *     · 入口：`planDelegation()` 产出的一份 payload 补丁（见下）；`delegateDepth` 做深度闸；
 *     · 出口：`createDelegateSink()` —— 一个假 res，吞掉所有字节，但**留下它说过的话**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、纪律（写在这里，因为它是最容易被后来人做坏的部分）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **不许假装独立**。拿不到第二个模型时仍然允许跑（它相对现状仍是增量），但模式必须是
 *      `same-model-degraded`，且**用户侧文案必须写明「同一模型、独立性有限」**。
 *      把同一模型说成"独立实例"= 本轮要消灭的那种假读数。
 *   ② **不许假执行**。没有真的起第二实例时，调用方**一个"已双路执行"的字都不许发**
 *      （`planDelegation` 返回 `action:'skip'` 时，调用方只能记 trace，不许发 phase）。
 *   ③ **不许另起判据**。第二实例内部跑的是同一个 `runAgentLoopInner` ⇒ 同一套
 *      `classifyToolFailure` / `createRetryLedger` / `createRecoveryExecutor`。
 *      本模块**只决定"给它什么"**（模型、工具、初始上下文），绝不做"前任失败了什么"的判断 ——
 *      那是 `handoffBrief.buildHandoffFromSeeded` 的职责，本模块只接收它产出的文本。
 *   ④ **必须有界**。深度闸 `DELEGATE_MAX_DEPTH`、轮数闸 `DELEGATE_MAX_TURNS`、
 *      工具闸（必须严格变小才允许起）—— 三条都过了才 `action:'run'`。
 *
 * 纯函数 + 一个假 res 工厂，零 Electron 依赖 ⇒ `scripts/smoke/unit-second-runner.mjs` 能直接 require。
 */

// ===================== 一、常量（集中在一处，别散落字符串） =====================

const { buildHandoffFromSeeded, handoffBriefText, redactSecrets } = require('./handoffBrief');

/**
 * 第二执行实例的独立性档位。
 *   `independent`          —— 拿到了**与主执行者不同**的模型。这才是字面意义的"换人"。
 *   `same-model-degraded`  —— 拿不到第二模型（或配了同一个）。**允许跑**，但必须如实标注
 *                             「同一模型、独立性有限」：它换的是上下文与工具集，不是脑子。
 */
const DELEGATE_MODE = {
  INDEPENDENT: 'independent',
  SAME_MODEL_DEGRADED: 'same-model-degraded',
};

/** 第二实例的 taskId 后缀。**必须与主 taskId 不同**，否则主实例 finally 里的
 *  `runningTasks.delete(taskId)` 会把第二实例从"可叫停"表里删掉（它就再也停不下来了）。 */
const DELEGATE_TASK_SUFFIX = '-r2';

/** 深度闸：`payload.delegateDepth >= 1` 时不再起第二实例 ⇒ 最多两层，不递归爆炸。 */
const DELEGATE_MAX_DEPTH = 1;

/**
 * 轮数闸：替补是"再来一次机会"，不是"再来一整个任务"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 这个常量与「两个窗口」的数值关系（改它之前必须读完这段）
 * ══════════════════════════════════════════════════════════════════════════
 * backend 的窗口是**按本任务自己的 MAX_TURNS 推**出来的，不是独立常量：
 *   · `MAX_TURNS`          = `payload.maxTurns`（替补就是本值 6）
 *   · `STUCK_AFTER_TURNS`  = `max(4, floor(MAX_TURNS × STUCK_TURN_RATIO))`，`STUCK_TURN_RATIO=0.5`
 *   · replan 短窗 `shortWin` = `max(4, floor(STUCK_AFTER_TURNS × 0.6))`
 *
 * 取 6 时：`STUCK_AFTER_TURNS = max(4, 3) = 4`，`shortWin = max(4, 2) = 4` ⇒ **两窗相等**。
 * 后果（2026-02-16 独立验收实测，不是推演）：两窗相等时 `wrapUpReason` 先返回 `'stuck'`，
 * replan 闸被 `!wuReason` 短路 ⇒ **替补自己那一层永远不会再起第三层**。
 *   ⇒ 「最多两层」当前不是靠 `DELEGATE_MAX_DEPTH` 挡住的，而是靠**卡住收尾先触发**。
 *     深度闸是第二道（在这条路径上永远到不了的）保险 —— 它仍然必须留着，
 *     因为窗口关系可以被 `DOUYA_MAX_TURNS` / 未来调参改掉。
 *
 * 🔴 三条踩空方式（门禁 R14 钉住前两条）：
 *   ① 把它调大（比如 24）⇒ 替补可以烧掉一整个任务的预算，"再来一次机会"变成"再来一遍全部"；
 *   ② 把它调小到 `shortWin` 以下（< 5）⇒ 替补还没走到"能换方法"的那一轮就被收尾掐断，
 *      起了等于没起（白烧模型调用）；
 *   ③ 把它调成非整数/负数 ⇒ `Math.min` 之后 `maxTurns2` 会退化成 2，同上。
 * 门禁断言：`maxTurns2 ≤ DELEGATE_MAX_TURNS`、`DELEGATE_MAX_TURNS ≤ 6`、
 *           `DELEGATE_MAX_TURNS ≥ shortWin + 1`（都要能让"改大/改小"的变异转红）。
 */
const DELEGATE_MAX_TURNS = 6;

/**
 * 把外部传进来的 `delegateDepth` 归一成「非负整数」。
 *
 * 🔴 为什么必须归一（独立验收实测出的可达洞）：`payload` 来自 `/api/chat` 的 body，**外部可控**。
 *   原来 `planDelegation` 直接 `Number(i.depth) || 0`：
 *     · `depth = -1` ⇒ 通过深度闸（`-1 >= 1` 为假）⇒ 起替补，且补丁里写 `delegateDepth: 0`
 *       ⇒ 内层 `isInternalRun = (0 >= 1) = false` ⇒ 替补会被当成**主任务**：
 *       认领项目账（projectStore.begin）、进 taskStream 的"可续跑"清单、被写进 tasks.json ——
 *       即"内部子运行"该有的隔离**全都失效**；
 *     · `depth = 1.7` ⇒ `1.7 >= 1` 为真 ⇒ 本该拦住却按浮点比较侥幸拦住，行为不可推理。
 *   ⇒ 归一化（取整 + 下界 0）**只此一处**，`isInternalRun` 与深度闸都必须用它，
 *     不许在 backend 里再写一遍 `Number(x) >= 1`（那会立刻产生两套口径）。
 *
 * @param {unknown} v 任意输入（undefined / 字符串 / 负数 / 浮点）
 * @returns {number} 非负整数（拿不到有效数字 ⇒ 0）
 */
function normalizeDelegateDepth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** 第二实例结论回灌主对话时的最大字符数（只回摘要，不回全文）。 */
const DELEGATE_SUMMARY_MAX = 1200;

/**
 * 第二实例**不许**拿到的工具：搜索类。
 *
 * 为什么去掉搜索：触发第二实例的前提是「连续几轮只有操作、没有新证据」（见 backend 的 replan 闸）。
 * 那种局面下**再搜一遍**正是前任已经证明无效的那一类动作；替补该做的是"换一条动手的路"，
 * 而不是把调研再来一遍。留着搜索 = 让它原地补一遍前任走过的弯路。
 * ⚠️ 名字用的是技能 id（`skills/<id>/`），不是 PHASE_OF 里的下划线形态。
 */
const DELEGATE_DENY_TOOLS = new Set([
  'file-search',
  'web-fetch',
  'shop-search',
  'mmm-shop-search',
]);

/**
 * 元工具（"跟用户来回"的那几个）第二实例一律不给。
 *
 * 理由：第二实例是**替补**，用户不在它这一侧（它连的不是用户的连接，没人能回答它的选择题）。
 * 让它调 `request_material` / `clarify_requirements` 只会挂起到超时，白烧预算。
 * `META_TOOL_NAMES` 的**唯一真源**在 backend（由 `META_TOOLS` 派生）；这里不另抄一份表 ——
 * 调用方把真实名单传进来，本模块只做并集。
 */
const DELEGATE_FALLBACK_META = [
  'workflow_plan',
  'request_plan_ack',
  'clarify_requirements',
  'request_material',
  'pick_local_files',
];

// ===================== 二、模型：两种模式，如实标注 =====================

/**
 * 决定第二实例用哪个模型、以及它的独立性档位。
 *
 * 取值顺序：`payload.delegateModel` → `cfg.delegateModel` → `process.env.DOUYA_DELEGATE_MODEL`。
 * 全是空 ⇒ 退回主模型 + `same-model-degraded`（**不是失败**，是如实降级）。
 *
 * @param {{mainModel?:string, payloadModel?:string, cfgModel?:string, envModel?:string}} o
 * @returns {{model:string, mode:string, reason:string}}
 *   reason ∈ 'distinct-model' | 'same-as-main' | 'no-delegate-model'
 */
function resolveDelegateModel(o) {
  const i = (o && typeof o === 'object') ? o : {};
  const main = String(i.mainModel || '').trim();
  const cand = String(i.payloadModel || i.cfgModel || i.envModel || '').trim();
  if (cand && cand !== main) {
    return { model: cand, mode: DELEGATE_MODE.INDEPENDENT, reason: 'distinct-model' };
  }
  if (cand && main && cand === main) {
    // 配了个跟主模型一模一样的 ⇒ 它就是"换个名字的同一颗脑子"，不许算独立。
    return { model: cand, mode: DELEGATE_MODE.SAME_MODEL_DEGRADED, reason: 'same-as-main' };
  }
  return { model: main, mode: DELEGATE_MODE.SAME_MODEL_DEGRADED, reason: 'no-delegate-model' };
}

// ===================== 三、工具子集：必须严格变小 =====================

/** 取工具定义里的函数名（兼容 `{function:{name}}` 与裸字符串两种形态）。 */
function toolNameOf(t) {
  if (typeof t === 'string') return t;
  if (t && t.function && typeof t.function.name === 'string') return t.function.name;
  return '';
}

/**
 * 从主实例的工具表里挑出第二实例可用的子集。
 *
 * 去掉两类：① 搜索类（`DELEGATE_DENY_TOOLS`）；② 元工具（调用方传入的真实名单 + 兜底名单）。
 * **不做白名单**：技能表是插件式增长的，写死白名单会让新技能在替补里静默消失。
 *
 * @param {Array} tools 主实例的 `[...payload.tools, ...META_TOOLS]`
 * @param {Array<string>} metaNames 调用方传进来的元工具真名（backend 的 META_TOOL_NAMES）
 * @returns {{tools:Array, dropped:Array<string>}}
 */
function pickDelegateTools(tools, metaNames) {
  const list = Array.isArray(tools) ? tools : [];
  const meta = new Set(
    (Array.isArray(metaNames) ? metaNames : []).concat(DELEGATE_FALLBACK_META)
      .map((n) => String(n || '').trim()).filter(Boolean)
  );
  const out = [];
  const dropped = [];
  for (const t of list) {
    const name = toolNameOf(t);
    if (!name) continue;
    if (DELEGATE_DENY_TOOLS.has(name) || meta.has(name)) { dropped.push(name); continue; }
    out.push(t);
  }
  return { tools: out, dropped };
}

/** 工具名集合（门禁/断言用：`tools2 ⊂ tools` 必须能算出来）。 */
function toolNameSet(tools) {
  const s = new Set();
  for (const t of (Array.isArray(tools) ? tools : [])) {
    const n = toolNameOf(t);
    if (n) s.add(n);
  }
  return s;
}

/**
 * `sub` 是否 `super` 的**真子集**（元素都在 super 里，且**严格更少**）。
 * 严格的"更少"是硬条件：数量相同就不是"缩小的工具子集"，那就没有理由声称它变了。
 */
function isStrictSubset(sub, sup) {
  const a = toolNameSet(sub);
  const b = toolNameSet(sup);
  if (a.size >= b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

// ===================== 四、初始上下文：只带交接单 =====================

/**
 * 为第二实例组装交接单 —— **走的是同一个纯函数** `buildHandoffFromSeeded`。
 *
 * 为什么这里还要一层（而不是让 backend 直接调）：
 *   backend 里已经有一个交接单组装点（续跑注入那次），`unit-handoff-brief` 的 F6 把
 *   「backend 里 `buildHandoffFromSeeded(` 只许出现一次」钉成硬断言 —— 它防的是
 *   "多处各拼一份 strategies 数组 ⇒ 同一种失败被讲成两种说法"。
 *   第二实例**确实**需要再组装一次，因为它与主实例的上下文**不同**：
 *     · 主实例那次传 `hasToolHistory: conversation.some(role==='tool')` —— 它看得见那些失败过程时，
 *       交接单就该闭嘴（往已知信息里兑水）；
 *     · 第二实例的上下文是全新的、**一条 tool 消息都没有** ⇒ `hasToolHistory` 恒为 false，
 *       这正是"该把前任的账交给它"的情形。
 *   ⇒ 两处的**语义判据不同，实现同一份**。所以把第二处的组装放在本模块里（能被单测直接跑），
 *     而不是在 backend 里再抄一遍分拣逻辑。措辞仍全部由 `handoffBrief` 产出。
 *
 * @param {{
 *   seeded?: Array<object>, actionsAll?: Array<string>, actionLabel?: Record<string,string>,
 *   kindLabel?: (k:string)=>string, actionOf?: (k:string)=>string, trigger?: string
 * }} o
 * @returns {{brief: object|null, text: string, reason: string, forbidden: Array<string>}}
 *   任何异常都退化成"无交接"（brief=null/text=''），绝不抛 —— 交接单是增益，不是单点故障源。
 */
function buildDelegateHandoff(o) {
  const i = (o && typeof o === 'object') ? o : {};
  try {
    /**
     * ★★ 2026-02-16（独立验收受控实测）：把**替补手里真正有哪些工具**传下去。
     *
     * 不传的后果（实测）：账本 3 条 file-search×2 / web-fetch×2 / file-write×2，
     * 交接单点名 3 条，而替补只有 [file-write, file-read, shell-exec] ⇒
     * **3 条里 2 条是纯噪声**，且正好是 `DELEGATE_DENY_TOOLS` 明确剔掉的那一族。
     * 于是交接单里大半是"替补无法重放、也无法换个条件再试"的空话 ——
     * 从"恒 0 字"变成"几百字里有大半用不上"，那不叫修好。
     *
     * 传下去之后，`handoffBrief` 会把不可用的条目**改口**（不说"别再用"，而说
     * "这条路你手里没有 ⇒ 说明你打算怎么绕"）：用它提要求，而不是用它禁止。
     * 条目本身**仍然来自账本**（本模块不新增任何失败判定）。
     */
    const availNames = Array.isArray(i.delegateTools)
      ? i.delegateTools.map((t) => toolNameOf(t)).filter(Boolean)
      : (Array.isArray(i.availableTools) ? i.availableTools.map((x) => String(x || '').trim()).filter(Boolean) : undefined);
    const built = buildHandoffFromSeeded({
      seeded: Array.isArray(i.seeded) ? i.seeded : [],
      // ★ 这是**事实**不是开关：第二实例的上下文里没有任何 tool 消息（它只拿到一条种子消息）。
      hasToolHistory: false,
      availableTools: availNames,
      actionsAll: i.actionsAll,
      actionLabel: i.actionLabel,
      kindLabel: i.kindLabel,
      actionOf: i.actionOf,
      /**
       * ★ 「前任列进计划但没做完的事」**原样透传**（`openFailures()` 的产物）。
       *
       * 本模块**不替它造假数据**：拿不到就是 undefined ⇒ `handoffBrief` 当空数组处理 ⇒ 整段不出现。
       * 为什么这条纪律必须写在这里：替补是"另一颗脑子"，它对"还剩什么没做"没有任何自己的信息源 ——
       * 一旦这里塞一句"请自行判断还差什么"之类的占位文案，模型会把它当成事实继续编。
       * 真实数据的组装点在 backend（与本轮的文件边界无关），本模块只保留通路。
       */
      unfinished: i.unfinished,
      trigger: i.trigger,
    });
    const brief = (built && built.brief) ? built.brief : null;
    // ★ 正文一律经由具名出口 `handoffBriefText` 取，**不**在这里拼、也不 trim/截断：
    //   trace 里记的全文必须与第二实例真正看到的逐字一致（见 handoffBrief 头注的纪律）。
    const text = brief ? handoffBriefText(brief) : '';
    const forbidden = (brief && Array.isArray(brief.forbidden))
      ? brief.forbidden.map((f) => String((f && f.tool) || '')).filter(Boolean) : [];
    /** 已证伪、但**替补手里没有**这个工具的条目（要求"绕开"，不是禁令）。 */
    const outOfReach = (brief && Array.isArray(brief.outOfReach))
      ? brief.outOfReach.map((f) => String((f && f.tool) || '')).filter(Boolean) : [];
    const tried = (brief && Array.isArray(brief.tried)) ? brief.tried : [];
    return {
      brief, text, forbidden, outOfReach,
      reason: (built && built.reason) ? String(built.reason) : 'unknown',
      // ★ 读数（供 trace / 门禁）：条目总数里有多少是替补**真的能重放**的。
      items: Array.isArray(i.seeded) ? i.seeded.length : 0,
      usable: forbidden.length + tried.filter((x) => x && x.usable !== false).length,
      unusable: outOfReach.length + tried.filter((x) => x && x.usable === false).length,
    };
  } catch (e) {
    return { brief: null, text: '', reason: 'build-failed: ' + String((e && e.message) || e), forbidden: [], outOfReach: [], items: 0, usable: 0, unusable: 0 };
  }
}

/**
 * 拼第二实例的**唯一**一条初始消息。
 *
 * 边界（不许违反）：
 *   · **不带**前任的 messages 历史、不带 tool 消息、不带工具结果 —— 那是"同一上下文"，
 *     正是老板点名要避免的"集体犯同一个错"；
 *   · 交接单正文由调用方传入（来源必须是 `handoffBrief.handoffBriefText`），本模块**只拼接**，
 *     一个字都不改写 —— 否则 trace 里记的全文与替补真正看到的就不是同一份；
 *   · 第一句必须让它知道"这是替补接手，不是用户新提的需求"，否则它会把交接单当用户指令去确认。
 *
 * 【本轮新增的两段：验收标准 / 工作区指纹】
 *   `acceptance` 与 `workspace` 都由调用方（backend）用真实数据算好传进来，本模块只排版：
 *   · **验收标准**：不传 / 空数组 ⇒ **整段不出现**（不许留一个空标题，那会让模型自己瞎猜标准）；
 *   · **工作区指纹**：不传 ⇒ 整段不出现；传了（哪怕文件列不出来）⇒ 段在，缺的部分如实写"未知"。
 *   两段都不参与任何判断 —— 替补拿到的是"事实"，不是"要求它承认的事实"。
 *
 * @param {{goal?:string, handoffText?:string, mode?:string, droppedTools?:Array<string>,
 *          acceptance?:Array<string>,
 *          workspace?:{workspace?:string, branch?:string,
 *                      items?:Array<{path?:string,size?:number,mtime?:string}>}}} o
 *   `goal` 允许是多行（`composeDelegateGoal` 的产物：项目最初的要求 + 本次这一轮的要求），
 *   本函数**只 trim 首尾**，不动内部换行 —— 那两个来源必须分行才读得清。
 * @returns {string}
 */
function buildDelegateSeedText(o) {
  const i = (o && typeof o === 'object') ? o : {};
  const goal = String(i.goal || '').trim();
  const handoff = String(i.handoffText || '').trim();
  const dropped = (Array.isArray(i.droppedTools) ? i.droppedTools : []).map((x) => String(x || '').trim()).filter(Boolean);
  const degraded = String(i.mode || '') === DELEGATE_MODE.SAME_MODEL_DEGRADED;
  // ★ 验收标准：只收非空字符串，且数量有上限（`delegateAcceptanceLines` 已限过一次，这里再兜一次）。
  const acceptance = (Array.isArray(i.acceptance) ? i.acceptance : [])
    .map((x) => String(x || '').trim()).filter(Boolean).slice(0, DELEGATE_ACCEPT_MAX_ITEMS);
  const fp = (i.workspace && typeof i.workspace === 'object') ? i.workspace : null;

  const L = [];
  L.push('（替补执行任务说明 —— 这是系统交给你的任务，不是用户新提的需求，不要向用户确认。）');
  L.push('【原任务目标】' + (goal || '（目标未记录）'));
  L.push('【你的处境】上一个执行者在这件事上卡住了：连续多轮只有动作、没有新证据。'
    + '你没有它的对话历史，也没拿到它的工具调用过程 —— 你只拿到这一页交接单。');
  if (degraded) {
    // ★ 这句是给**模型**看的诚实说明，不是免责声明：同一颗脑子必须被明确告知，
    //   否则它会以为自己天然带来了"另一个视角"。
    L.push('【关于独立性】本次你与主执行者使用的是**同一个模型**，独立性有限：'
      + '你能带来的差异来自"更小的工具集 + 只带交接单的干净上下文"，不是来自不同的判断能力。'
      + '所以**不要**假装你是另一套判断体系；请把差异落在"换一条没走过的动手路径"上。');
  } else {
    L.push('【关于独立性】你与主执行者使用的是**不同的模型**，请用你自己的判断走一条它没走过的路。');
  }
  if (dropped.length) {
    L.push('【本次你没有的工具】' + dropped.join('、')
      + '（搜索类与"跟用户来回"的元工具已被移除：前任已经把调研走过一遍，你的任务是**动手换路**，不是再搜一遍；'
      + '你这一侧也没有用户在等你提问，提问只会挂起。）');
  }
  // ── 【验收标准】排在这里：紧跟在"目标"之后、"处境"之前 ──
  //   为什么紧跟目标：目标说"做什么"，验收说"做到什么算完"，两者必须挨着读；
  //   插在交接单后面就会被"前任的失败账"淹没，而验收才是替补收尾时唯一必须对齐的东西。
  if (acceptance.length) {
    L.push('【验收标准】（收尾时会按下面这几条**逐项真检查**，不看你自己说"已完成"）');
    acceptance.forEach((x, k) => L.push('   ' + (k + 1) + '. ' + x));
  }
  if (fp) {
    // 整段过一遍脱敏：路径/分支理论上不该有凭据，但这一段会被拼进模型 prompt，
    // 「理论上不该」不是门禁 —— 统一走 handoffBrief.redactSecrets（唯一真源）。
    const filtered = !!fp.filteredByTaskStart;
    const lines = ['【工作区与产物指纹】（你要动手的位置；'
      + (filtered ? '清单里只列**本次任务开始之后**改过的文件' : '清单里只列这个目录里最近改过的文件')
      + '，它不是"本次任务的产物清单"，也不是"已经做完了"的证据）'];
    /**
     * ★ 这里**不印工作区的绝对路径**（P3）。
     *
     * 真实读数：`AGENT_WORKSPACE = C:\Users\<本机用户名>\douya-claw-workspace` ——
     *   这一段会被拼进发往模型网关的 prompt，把本机用户名一起送出去毫无必要，
     *   而替补真正需要的只是"相对这个工作区的路径"。
     *   段首留一句"已省略"，是为了让模型知道**存在**一个工作区、只是路径没给，
     *   而不是以为"根本没有工作区"（后者会让它自己编一个目录去写）。
     */
    lines.push('  工作区：<已省略本机绝对路径>（下面都是相对这个工作区的路径）');
    // 分支：拿到就写名字；拿不到写 DELEGATE_BRANCH_UNKNOWN（「未探测（工作区不是 git 仓库）」）——
    // 绝不写成含糊的"未知"：那会让人以为"分支存在只是没读出来"，进而去猜分支名。
    lines.push('  分支：' + (String(fp.branch || '').trim() || DELEGATE_BRANCH_UNKNOWN));
    const items = (Array.isArray(fp.items) ? fp.items : [])
      .filter((x) => x && typeof x === 'object' && String(x.path || '').trim())
      .slice(0, DELEGATE_FP_MAX_ITEMS);
    if (items.length) {
      lines.push('  最近改动（' + items.length + ' 个，按修改时间从新到旧'
        + (filtered ? '；只含本次任务开始之后动过的' : '') + '）：');
      for (const it of items) {
        const size = Number(it.size) > 0 ? Number(it.size) : 0;
        lines.push('   - ' + String(it.path).trim() + '（' + size + ' B，'
          + (String(it.mtime || '').trim() || '修改时间未知') + '）');
      }
    } else if (filtered) {
      /**
       * 过滤后为空是**最常见**的真实情况（本次任务还没写盘 / 工作区里全是上一个任务的文件）。
       * 这时必须说清"是过滤掉了"，否则读的人会以为"工作区是空的"而误判起点。
       * 顺带把"被过滤掉多少"如实说出来 —— 这一句是任务隔离被守住的**证据**。
       */
      lines.push('  最近改动：（本次任务开始后工作区没有新文件'
        + (Number(fp.seen) > 0 ? '；同一工作区内另有 ' + Number(fp.seen) + ' 个**本次之前**的文件（含子目录里的一层），未列出（不属于本次任务）' : '')
        + '）');
    } else {
      lines.push('  最近改动：这个工作区里没有读到普通文件（可能还没产出，或目录不存在）');
    }
    L.push(redactSecrets(lines.join('\n')));
  }
  if (handoff) {
    L.push('');
    L.push(handoff);
  } else {
    L.push('');
    L.push('【交接单】本次没有可交接的失败账（没有已证伪的方法）—— 请直接按目标换一条**没走过**的动手路径。');
  }
  L.push('');
  L.push('【立即开始】直接动手，先说一句你打算走哪条路，然后立刻调用工具执行。不要再提问、不要再规划一轮。');
  return L.join('\n');
}

// ===================== 五、用户侧文案（如实，不许吹） =====================

/**
 * 起第二实例时给用户看的 phase 文案。
 *
 * 硬约束（门禁 R6 钉住）：
 *   · `same-model-degraded` 的文案**必须**含「独立性有限」；
 *   · 两种模式都**不许**出现「独立实例」以外的夸大说法，尤其不许出现「并行」「双路」「双方案」——
 *     本轮只有**一条**执行路径（替补是接替，不是同时跑两路），说"并行"就是回到那个前科。
 *
 * @param {string} mode DELEGATE_MODE.*
 * @param {string} model2
 * @returns {string}
 */
function delegatePhaseLabel(mode, model2) {
  const m = String(model2 || '').trim() || '未知模型';
  if (String(mode || '') === DELEGATE_MODE.INDEPENDENT) {
    return '卡住了 ⇒ 已交给第二个执行实例（模型 ' + m + '），它只带交接单重新想办法';
  }
  return '卡住了 ⇒ 已交给第二个执行实例（与主执行者同一模型，独立性有限），它只带交接单重新想办法';
}

/** 短档位名（写进 trace / 回灌主对话的说明里，别让用户看到内部枚举值）。 */
function delegateModeLabel(mode) {
  return String(mode || '') === DELEGATE_MODE.INDEPENDENT ? '不同模型' : '同一模型、独立性有限';
}

// ===================== 六、一处决策：起不起、给什么 =====================

/**
 * 决定"这一次要不要起第二实例、起的话给它什么"。
 *
 * 这是**唯一**的决策点：backend 只负责读输入、调这里、按 `action` 执行。
 * 所有闸门都在这里，好处是它们能**被单独跑**（本仓有过 `highRiskParallel` 零消费者的前科）。
 *
 * 闸门顺序（任一不过 ⇒ `action:'skip'` + 如实 reason）：
 *   ⓪ 任务号缺失：`no-task-id`
 *   ① 深度闸：`normalizeDelegateDepth(depth) >= DELEGATE_MAX_DEPTH` ⇒ 'depth-limit'（不超过两层）
 *   ② 工具闸·空集：裁剪后一件工具都不剩 ⇒ 'no-tools-left'
 *      （`isStrictSubset([], X)` 数学上成立 ⇒ 不单独挡会放一个空手上阵的替补过去）
 *   ③ 工具闸：子集不是**真子集** ⇒ 'tools-not-shrinkable'（不缩小就等于没换条件）
 *   ④ 轮数闸：`maxTurnsLeft < 2` ⇒ 'no-turns-left'（连说一句话的机会都没有，起了也是白烧）
 *
 * @param {{
 *   taskId?:string, goal?:string, tools?:Array, metaNames?:Array<string>,
 *   mainModel?:string, delegateModel?:{payloadModel?:string, cfgModel?:string, envModel?:string},
 *   depth?:number, turn?:number, maxTurnsLeft?:number,
 *   handoffText?:string, handoffReason?:string,
 *   acceptance?:Array<string>,
 *   workspace?:{workspace?:string, branch?:string, items?:Array<object>}
 * }} o
 *   `goal` 由调用方用 `composeDelegateGoal()` 算好（原始需求 + 本轮要求两个来源），
 *   本函数**不**自己去猜"哪一句才是目标"。
 *   `acceptance` = `delegateAcceptanceLines(requiredChecks)` 的产物（空 ⇒ 不留段）。
 *   `workspace`  = `workspaceFingerprint(AGENT_WORKSPACE)` 的产物（不传 ⇒ 不留段）。
 * @returns {{action:'run', mode:string, modeLabel:string, model2:string, modelReason:string,
 *            taskId2:string, depth:number, tools2:Array, droppedTools:Array<string>,
 *            seedText:string, maxTurns2:number, phaseLabel:string, handoffChars:number,
 *            handoffReason:string, goalChars:number, acceptChars:number,
 *            fingerprintCount:number, payloadPatch:object}
 *          | {action:'skip', reason:string}}
 */
function planDelegation(o) {
  const i = (o && typeof o === 'object') ? o : {};
  const taskId = String(i.taskId || '').trim();
  if (!taskId) return { action: 'skip', reason: 'no-task-id' };

  // ★ 深度先归一化再判（见 normalizeDelegateDepth 头注：`depth:-1` 原本能绕过深度闸，
  //   且让内层 isInternalRun=false ⇒ 认领项目账 / 进续跑清单）。**不许**在这里用原始值。
  const depth = normalizeDelegateDepth(i.depth);
  if (depth >= DELEGATE_MAX_DEPTH) return { action: 'skip', reason: 'depth-limit' };

  const picked = pickDelegateTools(i.tools, i.metaNames);
  // ★ 空工具集 ⇒ 不起。为什么必须单独挡：`isStrictSubset([], X)` 在数学上**成立**（空集是任何
  //   集合的真子集），于是"严格变小"这一条会放一个**一件工具都没有**的替补过去 ——
  //   它只能说话、不能动手，跑一轮纯烧预算，而"换条动手的路"这个目的一个字都做不到。
  //   这个洞是 `unit-turn-axis-symmetry` 的真实场景抓到的：那儿的主实例 `tools: []`（只有 META），
  //   裁剪后正好是空集。
  if (!picked.tools.length) return { action: 'skip', reason: 'no-tools-left' };
  if (!isStrictSubset(picked.tools, i.tools)) return { action: 'skip', reason: 'tools-not-shrinkable' };

  const maxTurnsLeft = Number.isFinite(Number(i.maxTurnsLeft)) ? Number(i.maxTurnsLeft) : 0;
  if (maxTurnsLeft < 2) return { action: 'skip', reason: 'no-turns-left' };

  const d = (i.delegateModel && typeof i.delegateModel === 'object') ? i.delegateModel : {};
  const mm = resolveDelegateModel({
    mainModel: i.mainModel,
    payloadModel: d.payloadModel,
    cfgModel: d.cfgModel,
    envModel: d.envModel,
  });

  const handoffText = String(i.handoffText || '');
  /**
   * ★ 三类事实在这里**只用不再加工**：验收标准与工作区指纹由调用方给，
   *   本函数只把它们递给 `buildDelegateSeedText`，并顺手把"给了多少"算成读数
   *   （trace 要的是数字，不是再存一遍正文）。
   */
  const acceptance = Array.isArray(i.acceptance)
    ? i.acceptance.map((x) => String(x || '').trim()).filter(Boolean).slice(0, DELEGATE_ACCEPT_MAX_ITEMS)
    : [];
  const workspace = (i.workspace && typeof i.workspace === 'object') ? i.workspace : null;
  const seedText = buildDelegateSeedText({
    goal: i.goal,
    handoffText,
    mode: mm.mode,
    droppedTools: picked.dropped,
    acceptance,
    workspace,
  });

  const maxTurns2 = Math.max(2, Math.min(DELEGATE_MAX_TURNS, Math.floor(maxTurnsLeft)));
  const taskId2 = taskId + DELEGATE_TASK_SUFFIX;

  return {
    action: 'run',
    mode: mm.mode,
    modeLabel: delegateModeLabel(mm.mode),
    model2: mm.model,
    modelReason: mm.reason,
    taskId2,
    depth: depth + 1,
    tools2: picked.tools,
    droppedTools: picked.dropped,
    seedText,
    maxTurns2,
    phaseLabel: delegatePhaseLabel(mm.mode, mm.model),
    handoffChars: handoffText.length,
    handoffReason: String(i.handoffReason || ''),
    /**
     * ★ 本轮补的三类事实各自"给了多少"（trace 读数，**不**存正文）。
     *   goalChars        = 目标文本字数（含"项目最初/这一轮"两个来源）；
     *   acceptChars      = 验收标准各条字数之和（0 ⇒ 种子消息里根本没有那一段）；
     *   fingerprintCount = 产物指纹条目数（0 ⇒ 只有"目录里没读到文件"这句实话）。
     */
    goalChars: String(i.goal || '').length,
    acceptChars: acceptance.reduce((n, x) => n + x.length, 0),
    fingerprintCount: (workspace && Array.isArray(workspace.items))
      ? workspace.items.filter((x) => x && typeof x === 'object' && String(x.path || '').trim()).length
      : 0,
    /**
     * 交给 `runAgentLoopInner` 的 payload 补丁。调用方按 `{...payload, ...payloadPatch}` 拼。
     *   · `taskId`    必须换（见 DELEGATE_TASK_SUFFIX 的理由）；
     *   · `delegateDepth` 递增 ⇒ 深度闸生效；
     *   · `messages`  只有一条（全新上下文，不带前任历史）；
     *   · `maxTurns`  收窄本轮数上限；
     *   · `killOnDisconnect:false` —— 第二实例的 res 是假的，永远不会触发 close；
     *     显式写 false 是为了万一将来换成真连接，也不会"一断就把替补杀掉"；
     *   · `unattended:true` —— **必须**。它的 res 是 sink，前端永远收不到 `confirm` /
     *     `material` / `clarify` 事件 ⇒ 一旦走到 `waitConfirm(…, 300000)`，就没人能回答，
     *     第二实例会白等 5 分钟才超时（而那不是"用户拒绝"，是"这一侧没有用户"）。
     *     既有 `unattended` 分支的语义正好是这件事：**不挂起 + 如实记账 + 记"未执行"**，
     *     所以复用它，而不是新造一个"别等确认"的开关（新开关 = 新的一条假绿通道）。
     *     ⚠️ 注意 file-write / shell-exec / file-read **不在** CONFIRM_TOOLS 里（它们是 auto 档），
     *     所以这个标记不会把替补真正要用的那三件工具也挡掉。
     *   · `noMetaTools:true` —— **必须**。内层跑的是同一个 `runAgentLoopInner`，它在组装请求体时
     *     会 `[...payload.tools, ...META_TOOLS]` 把元工具**又加回来**（实测：补丁里 3 个工具，
     *     模型实际看到 7 个，多出 workflow_plan / request_material / clarify_requirements /
     *     pick_local_files）。这会让"缩小的工具集"这条承诺在运行时**不成立**，
     *     且 trace 里 `tools2=3` 是**低报**。⇒ 内层必须尊重这个开关（backend 4626 附近）。
     *   · `skipResumeState:true` —— **必须**。内层若不跳过「跨请求任务状态」注入，它的上下文里
     *     就会出现【跨请求任务状态：已完成 4 步 shell-exec…】，而种子文案又写着"你没拿到它的工具
     *     调用过程" ⇒ **同一份上下文里两句话互相打脸**。二选一：既然本轮这 6 条 P1 的前提是
     *     "全新上下文"，就跳过注入（连"内部子运行不该进续跑清单"这件事也才真正闭合）。
     */
    payloadPatch: {
      taskId: taskId2,
      delegateDepth: depth + 1,
      model: mm.model,
      tools: picked.tools,
      messages: [{ role: 'user', content: seedText }],
      maxTurns: maxTurns2,
      killOnDisconnect: false,
      unattended: true,
      noMetaTools: true,
      skipResumeState: true,
    },
  };
}

// ===================== 七、假 res：吞字节，但留下它说过的话 =====================

/**
 * 造一个"看似 SSE 连接、实际什么都不写"的 res，给递归子运行当出口。
 *
 * 为什么需要它：`runAgentLoopInner` 会 `res.writeHead(...)` / `res.on('close', ...)` /
 * `res.write('data: {...}\n\n')` / `res.end()`。少实现一个方法，真跑时就抛
 * —— 而这条路径平时不会跑到（要"卡住"才触发）⇒ 漏掉的代价是"线上第一次卡住时才炸"。
 * 所以方法**按主循环的实际用法列全**（2026-02-16 逐个 grep `res.` 核过）：
 *   `writeHead` / `write` / `end` / `on` / `writableEnded` / `destroyed`
 *   外加 taskStream 侧会摸的 `headersSent`（见 backend 的 `/api/*` 分支）与常见 header 方法。
 *
 * 顺带做一件正事：**把事件留住**。`taskStream.push` 写的就是
 * `'data: ' + JSON.stringify(ev) + '\n\n'`，所以从写进来的字节里能还原出事件对象，
 * 于是替补最后说了什么、产出了哪些文件，都能在这里被**读**到 —— 这是"结论回灌主对话"
 * 与"替补的产出算进这次任务"的唯一来源，不是靠猜。
 *
 * @returns {{res:object, getText:()=>string, getDeliverables:()=>Array<object>,
 *            getEvents:()=>Array<object>, eventCount:()=>number}}
 */
function createDelegateSink() {
  const events = [];
  let current = '';   // 最近一次工具调用**之后**的模型文本（那才是它的结论）
  let lastSaid = '';  // 上一次被工具调用截断前说的话
  let deliverableItems = [];  // 最后一次 `deliverables` 事件里的条目（替补真的写出来的文件）

  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (events.length < 500) events.push(ev);
    // 替补产出：主循环每次产物变化都会推一条 deliverables（含 items 与 workspace）。
    // 取**最后一条**：那是它收尾时看到的完整清单，不是中途的快照。
    if (ev.type === 'deliverables' && Array.isArray(ev.items)) {
      deliverableItems = ev.items.slice();
      return;
    }
    const ch = ev.choices;
    if (Array.isArray(ch) && ch[0] && ch[0].delta && typeof ch[0].delta.content === 'string') {
      current += ch[0].delta.content;
      return;
    }
    // 工具调用 ⇒ 前面那段话只是过程说明，不是结论；把游标挪到"最近一次工具调用之后"。
    if (ev.__tool__) {
      if (current) lastSaid = current;
      current = '';
    }
  };

  const consume = (chunk) => {
    if (chunk == null) return;
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const body = s.slice(5).trim();
      if (!body) continue;
      try { onEvent(JSON.parse(body)); } catch { /* 不是 JSON 的一律忽略，绝不让旁路抛 */ }
    }
  };

  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    statusCode: 200,
    writeHead() { res.headersSent = true; return res; },
    setHeader() { return res; },
    getHeader() { return ''; },
    removeHeader() { return res; },
    flushHeaders() { /* 没有对端，无需 flush */ },
    write(chunk) { consume(chunk); return true; },
    end() { res.writableEnded = true; return res; },
    on() { return res; },
    once() { return res; },
    off() { return res; },
    addListener() { return res; },
    removeListener() { return res; },
    emit() { return false; },
    destroy() { res.destroyed = true; return res; },
  };

  return {
    res,
    getText: () => String(current || lastSaid || ''),
    getDeliverables: () => deliverableItems.slice(),
    getEvents: () => events.slice(),
    eventCount: () => events.length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 八、交接单之外的另外三类事实（2026-02-16 接线）
// ════════════════════════════════════════════════════════════════════════════
/**
 * 【为什么要有这一节，而不是在 backend 里就地拼字符串】
 *
 * 上一版交接单只讲"前任失败过什么"，替补接手时**另外三类事实一条都没有**：
 *   ① **项目最初的要求** —— backend 只传 `clip(lastUserText, 300)`，那是"这一轮用户说的最后一句话"。
 *      多轮任务里它常常是「继续」「还是不行，再改一下」这种反馈 ⇒ 替补拿到的"目标"根本不是目标。
 *   ② **验收标准** —— 一条都没有。于是替补不知道"做成什么样才算做完"，
 *      只能按自己的想象收尾（本仓的老毛病：把自述当验收）。
 *   ③ **工作区 / 分支 / 产物指纹** —— 一条都没有。替补甚至不知道自己在哪个目录动手、
 *      那里已经有什么文件。
 * 这三类都是**纯粹的事实转写**（取数 + 截断 + 排版），没有一处需要判断力 ⇒
 * 放在本模块（纯 node、可被单测直接跑），backend 只负责"把真实数据递进来"。
 *
 * 纪律（与 handoffBrief 同一条）：
 *   · **只转写，不编造**：取不到就返回空/`'未知'`，绝不写一句"请自行判断"之类的占位文案
 *     （模型会把占位文案当成事实继续编）。
 *   · **不抛**：任何一个函数在畸形输入下都必须给出可用的返回值 ——
 *     它们是增益，不是单点故障源（替补给不齐料也必须能起）。
 */

/** 「项目最初的要求」的最大字数。**下界 300**：不许比原来那个 `clip(lastUserText, 300)` 更短。 */
const DELEGATE_ORIGIN_MAX = 600;
/** 「本次这一轮的要求」的最大字数（与原 `clip(lastUserText, 300)` 逐字同长）。 */
const DELEGATE_TURN_MAX = 300;
/** 验收标准最多给几条（再多就会把种子消息压垮，而交接单还有 6000 字 cap 要和别人分享）。 */
const DELEGATE_ACCEPT_MAX_ITEMS = 5;
/** 单条验收标准的最大字数（`requiredChecks[i].label` 本身就是一句人话，这里只防极端长句）。 */
const DELEGATE_ACCEPT_ITEM_MAX = 160;
/** 产物指纹最多列几个（任务书写死 8：再多就不是"指纹"而是 `ls`）。 */
const DELEGATE_FP_MAX_ITEMS = 8;
/** 扫目录时最多 stat 多少个**候选文件**（防止工作区里有几万个文件时把主流程拖慢）。 */
const DELEGATE_FP_SCAN_MAX = 200;

/**
 * 分支**拿不到**时的如实文案。
 *
 * ⚠️ 不许只写「未知」：那两个字既可能是"没探测"，也可能是"探测了但不是 git 仓库"，
 *   还可能是"读了但格式不认识" —— 三种情况对读的人含义完全不同。
 *   本机真实读数（`AGENT_WORKSPACE = C:\Users\<用户>\douya-claw-workspace`，**不是** git 仓库）：
 *   那里永远拿不到分支 ⇒ 若只写"未知"，替补会以为"分支存在只是没读出来"，进而去猜分支名。
 */
const DELEGATE_BRANCH_UNKNOWN = '未探测（工作区不是 git 仓库）';

/**
 * 未完成事项每条 `brief` 的最大字数。
 *
 * ⚠️ **必须与 `deliveryProtocol.STEP_SUMMARY_BRIEF_MAX`（60）一致**：本模块不能 require
 *   `deliveryProtocol`（会绕进 backend 的依赖环，且变异体加载器只认 `./` 相对路径），
 *   所以这里是**同一口径的第二份实现**。为了不让它漂移，门禁 `R28a3` 拿同一份 doneLog
 *   同时调 `summarizeSteps()` 与本模块，断言**前 8 条逐字相等** ——
 *   口径一旦漂移，那条断言立刻转红，而不是靠注释提醒。
 */
const DELEGATE_STEP_BRIEF_MAX = 60;

/**
 * 单行化 + 截断 —— 与 backend 的 `clip()` **逐字同口径**（去换行、压空白、超长加 `…`）。
 *
 * 为什么在这里再实现一份：本模块不许 require backend（backend require 了本模块，成环）。
 * 调用方仍可注入自己的 `clip`（`composeDelegateGoal({clip})`），那时以注入的为准 ⇒ 不产生两套口径。
 *
 * @param {unknown} s 任意输入
 * @param {number} n 上限（无效值 ⇒ 300）
 * @returns {string}
 */
function clipLine(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const max = (Number.isFinite(Number(n)) && Number(n) > 0) ? Math.floor(Number(n)) : DELEGATE_TURN_MAX;
  return t.length > max ? (t.slice(0, max) + '…') : t;
}

/**
 * 把「项目最初的要求」与「本次这一轮的要求」拼成一段**能分辨来源**的目标文本。
 *
 * 【为什么必须是两个来源、而且必须分行】
 *   多轮任务的 `lastUserText` 经常是「继续」「还是不行」这类**反馈**，不是需求本身。
 *   只把它当目标 ⇒ 替补接手时看到的"原任务目标"是「继续」——它当然做不对。
 *   两个来源都写、且各自带标签，替补才知道"要交的是最初那个东西，这次要解决的是这一处"。
 *
 * 三种退化形态（都必须如实，不许硬凑两行）：
 *   · 只有这一轮 ⇒ 只写这一行；只有最初 ⇒ 只写那一行；
 *   · 两者**字面相同**（首轮任务最常见）⇒ 合成一行，但**两个标签都保留**
 *     （「项目最初的要求（也就是本次这一轮的要求）：…」）——
 *     合成后若把某个标签弄丢，读的人就分不清"这是原始需求还是本轮反馈"。
 *
 * @param {{originText?:string, turnText?:string, clip?:(s:unknown,n:number)=>string,
 *          originMax?:number, turnMax?:number}} [o]
 * @returns {string} 空串 = 两个来源都没有（调用方原样透传，不许自己编目标）
 */
function composeDelegateGoal(o) {
  const i = (o && typeof o === 'object') ? o : {};
  const clip = typeof i.clip === 'function' ? i.clip : clipLine;
  // ★ 下界 300：任务书明确要求"不要截得比 300 还短"（原来那个 `clip(lastUserText, 300)` 就是 300）。
  const originMax = Math.max(DELEGATE_TURN_MAX, Number(i.originMax) > 0 ? Math.floor(Number(i.originMax)) : DELEGATE_ORIGIN_MAX);
  const turnMax = Math.max(DELEGATE_TURN_MAX, Number(i.turnMax) > 0 ? Math.floor(Number(i.turnMax)) : DELEGATE_TURN_MAX);
  let origin = '';
  let turn = '';
  try { origin = String(clip(i.originText, originMax) || '').trim(); } catch { origin = ''; }
  try { turn = String(clip(i.turnText, turnMax) || '').trim(); } catch { turn = ''; }
  if (!origin && !turn) return '';
  if (!turn) return '项目最初的要求：' + origin;
  if (!origin) return '本次这一轮的要求：' + turn;
  if (origin === turn) return '项目最初的要求（也就是本次这一轮的要求）：' + origin;
  return '项目最初的要求：' + origin + '\n本次这一轮的要求：' + turn;
}

/**
 * 从工作流的**结构化验收契约**（`wfSel.entry.requiredChecks`）里挑出"能说成人话"的几条。
 *
 * 【为什么是 requiredChecks，而不是模型自述的"已完成"】
 *   本仓对验收的口径只有一处是真源：工作流注册项上的 `requiredChecks` ——
 *   收尾时引擎会**逐项真跑**它（`workflowRunner.evaluate`）。所以"对外承诺的验收口径"就是它。
 *   模型自述的"已完成"是**被验收对象**，把它当验收标准是循环论证（本仓的老病）。
 *
 * 【为什么只取 must + 最多 5 条】
 *   交接单正文有 6000 字 cap，要和禁令/试过/未试方向分享预算；
 *   而 `must` 项才是"判不合格"的那几条 —— 把 should 也全列出来只会稀释重点。
 *
 * 【取数纪律】
 *   · 条目没有 `label` 也没有 `id` ⇒ 说不成人话 ⇒ **跳过**（不拿 `run.toString()` 凑数）；
 *   · 空数组 / 非数组 / 抛错 ⇒ 返回 `[]`（调用方据此不留空段，见 `buildDelegateSeedText`）。
 *
 * @param {Array<{id?:string, severity?:string, label?:string}>} checks `requiredChecks`
 * @param {{max?:number, itemMax?:number}} [opt]
 * @returns {string[]} 形如 `[必须] 交付物确实存在、可读、非空（…）`
 */
function delegateAcceptanceLines(checks, opt) {
  try {
    const o = (opt && typeof opt === 'object') ? opt : {};
    const max = Math.min(DELEGATE_ACCEPT_MAX_ITEMS,
      Math.max(1, Number(o.max) > 0 ? Math.floor(Number(o.max)) : DELEGATE_ACCEPT_MAX_ITEMS));
    const itemMax = Math.max(40, Number(o.itemMax) > 0 ? Math.floor(Number(o.itemMax)) : DELEGATE_ACCEPT_ITEM_MAX);
    const list = Array.isArray(checks) ? checks : [];
    const must = [];
    const rest = [];
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const id = String(c.id || '').trim();
      const label = String(c.label || '').trim();
      // 两者都空 ⇒ 这条既没有标识也没有人话，交出去等于给替补一行噪声。
      if (!id && !label) continue;
      const sev = String(c.severity || '').trim().toLowerCase();
      const prefix = (sev === 'must') ? '[必须] ' : (sev ? '[' + sev + '] ' : '');
      /**
       * 只有 `id`、没有 `label` 的条目：**保留，但必须标出来**。
       *   · 丢掉它 ⇒ 引擎收尾时会真跑这条检查（它可能是 `must`），而替补完全不知道它的存在；
       *   · 原样印 `general_deliverable_present` ⇒ 对模型只是一串符号，它会当成噪声忽略。
       *   ⇒ 用 id 顶上，并加一句**事实说明**（不是编造）：这条只有标识符、没有描述。
       */
      const text = label
        ? label
        : (id + '（该验收项只有标识符、没有描述）');
      const line = prefix + clipLine(text, itemMax);
      if (sev === 'must') must.push(line); else rest.push(line);
    }
    // must 排前面：它们是"判不合格"的那几条，替补该先看。
    return must.concat(rest).slice(0, max);
  } catch {
    return [];
  }
}

/**
 * 工作区 / 分支 / 产物指纹 —— **廉价、只读、绝不抛、绝不起子进程**。
 *
 * 【为什么必须自己实现，而且必须这么保守】
 *   · 本机 `spawnSync git` 有已知的**假失败**问题（任务书点名）⇒ 分支只许读 `.git/HEAD` 这个文本文件；
 *   · 「产物指纹」只需要回答"这个目录里最近改动了哪几个文件"，**不递归爬全盘**：
 *     **下潜一层**（顶层 + 每个子目录内一层，`DEPTH_MAX = 1`），用 `opendirSync` 流式读，
 *     stat 次数有硬上限（`DELEGATE_FP_SCAN_MAX`），到顶立刻停 —— 见函数体内那段长注释；
 *   · 这一段跑在"卡住 → 起替补"的路径上：**它慢一秒，用户就多等一秒**，
 *     所以任何一步失败都立刻降级成空，**绝不能让替补起不来**。
 *
 * 【为什么 `fs` / `path` 是**函数内**才 require，而不是文件顶部】
 *   本模块被门禁用 `new Function(...)` 在内存里加载变异体（见 `unit-second-runner` 的 R8），
 *   那种加载方式注入的 `require` 只认 `./` 相对路径 —— 顶部写 `require('node:fs')`
 *   会让**整份变异体加载失败**，于是那条反控证明的就不是"实现被改坏"，而是"加载器不认这个模块名"。
 *   延迟到函数体内 require 有两个额外好处：模块加载更轻（backend 启动时就要 require 本文件），
 *   以及"这一段的依赖出问题"只影响这一段自己（永远不至于让替补起不来）。
 *
 * 【红线】这里只输出**路径 / 字节数 / mtime**。不许把 `process.env` 里的任何值、
 *   任何 token / 连接串往这里写 —— 指纹段是会被拼进模型 prompt 的。
 *
 * @param {{workspace?:string, max?:number, scanMax?:number, taskStartedAt?:number}} [o]
 *   `taskStartedAt` = **本次任务的开始时间**（毫秒）。给了就只保留 `mtime >= taskStartedAt` 的文件。
 *   不给 / 非法 ⇒ 不过滤（老调用方与门禁夹具照旧），但**读数里会如实标 `filteredByTaskStart:false`**，
 *   免得读的人以为"这 8 个都是本次产物"。
 * @returns {{workspace:string, branch:string, branchKnown:boolean,
 *            items:Array<{path:string,size:number,mtime:string}>,
 *            seen:number, filteredByTaskStart:boolean, taskStartedAt:number}}
 *   `branch` 拿不到 ⇒ `DELEGATE_BRANCH_UNKNOWN`（**不猜**，也不写成含糊的"未知"）。
 *   `items[i].path` **一定是相对工作区的路径**（分隔符统一成 `/`）—— 绝不出现盘符或本机用户名。
 *   `seen` = **枚举到的普通文件数**（顶层 + **一层**子目录内，隐藏项不算），是**候选**，
 *     受 `scanMax`（默认 `DELEGATE_FP_SCAN_MAX` = 200 次 stat）截断 ⇒ 它是**下限**：
 *     · **不是**"工作区文件总数"—— 它是"预算之内数到了多少个"；
 *     · **不是** `items.length`（后者还被开始时间过滤 + 8 条配额砍过）。
 *     为什么要把这层写清：下潜一层之后**同一个**工作区从这个数 50 变成 177 —— 文件没变多，
 *     变的是"数的方式"。trace / 日志里的分母都按这个口径读（见 backend 那行 `指纹=…条/候选…条`）。
 */
function workspaceFingerprint(o) {
  const i = (o && typeof o === 'object') ? o : {};
  const dir = String(i.workspace || '').trim();
  const max = Math.min(DELEGATE_FP_MAX_ITEMS,
    Math.max(1, Number(i.max) > 0 ? Math.floor(Number(i.max)) : DELEGATE_FP_MAX_ITEMS));
  const scanMax = Math.max(max, Number(i.scanMax) > 0 ? Math.floor(Number(i.scanMax)) : DELEGATE_FP_SCAN_MAX);
  /**
   * ★ 按任务开始时间过滤（P3）。
   *
   * 为什么必须过滤：本机真实工作区是**所有任务共用的一个目录**（`AGENT_WORKSPACE`），
   *   实测它里面躺着上一个任务留下的 8 个 html（牙科设备介绍 / 业务方案 / xss 探针…）。
   *   不过滤 ⇒ 替补读到的"最近改动"**全是别人的文件**，任务隔离当场破掉，
   *   而且它极可能去改那些文件（那是最坏的一种"串任务"）。
   *
   * 边界（如实，不许假装）：过滤只能拿 `mtime` 比 —— 文件如果被"改了内容但把 mtime 写回旧值"
   *   （`cp -p` / `touch -d`）就骗得过这一层。这条的定位是"**别把上一个任务的产物当成这次的起点**"，
   *   不是"谁动过工作区的取证"。取证有专门的模块（artifactCustody / provenance）。
   */
  const startedAt = Number(i.taskStartedAt);
  const filterByStart = Number.isFinite(startedAt) && startedAt > 0;
  const out = {
    workspace: dir,
    branch: DELEGATE_BRANCH_UNKNOWN,
    branchKnown: false,
    items: [],
    seen: 0,
    filteredByTaskStart: filterByStart,
    taskStartedAt: filterByStart ? startedAt : 0,
  };
  if (!dir) return out;
  // ★ 延迟 require（理由见函数头注）。拿不到就当场降级 —— 指纹段是增益，不是前置条件。
  let fs = null;
  let nodePath = null;
  try {
    /* eslint-disable global-require */
    fs = require('node:fs');
    nodePath = require('node:path');
    /* eslint-enable global-require */
  } catch { return out; }
  try {
    // ── 分支：只读 `.git/HEAD`（`ref: refs/heads/xxx`），拿不到就如实写"未探测" ──
    try {
      const head = fs.readFileSync(nodePath.join(dir, '.git', 'HEAD'), 'utf8');
      const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(String(head));
      if (m && m[1]) {
        out.branch = String(m[1]).trim();
        out.branchKnown = true;
      } else {
        // worktree / detached HEAD：HEAD 里是一个裸 sha。只报前 7 位（够对上，又不像凭据）。
        const sha = String(head || '').trim().split(/\s+/)[0] || '';
        if (/^[0-9a-f]{7,40}$/i.test(sha)) {
          out.branch = 'detached@' + sha.slice(0, 7);
          out.branchKnown = true;
        }
      }
    } catch { /* 不是 git 仓库 / 没有读权限 ⇒ 保持"未探测"，**不为此起子进程** */ }

    /**
     * ── 产物指纹：顶层 + **只下潜一层**（子目录自身的名字不上榜、也不再往里走）──
     *
     * 【为什么必须下潜一层（2026-02-17，eng-handoff-p3 的实测）】
     *   本机真实工作区：顶层 50 个文件 + **23 个子目录**，而真实产物大量落在子目录里
     *   （`ai-clinic-report/`、`cds1013-ppt/`、`company-site/`…，一层内另有 130 个文件）。
     *   只扫顶层时，一个把产物写进 `out/` 的任务，交接时指纹段**一个字都不会有** ——
     *   而这一段存在的全部意义就是"告诉替补该去哪个位置动手"。
     *
     * 【为什么不是"递归"】
     *   深度**硬编码为 1**：顶层 → 子目录内一层就停，子目录的子目录不探（`DEPTH_MAX = 1`）。
     *   真实产物目录都是"任务名/产物文件"两段，再深的树不在这个工作区里出现过。
     *
     * 【为什么用 `opendirSync` 流式读，而不是 `readdirSync` 全量拿回再过滤】
     *   `readdirSync` 会**先把整个目录的条目全部读进内存**，预算是在那之后才生效的 ——
     *   23 个子目录里只要有一个几万文件的目录，预算一点用都没有，先吃满内存再说。
     *   `opendirSync` + `readSync()` 是逐条取，凑够 `scanMax` 次 stat 立刻停。
     *
     * 【预算口径】预算 = **`statSync` 的次数**（顶层文件算 1、子目录算 1、子目录内的文件算 1）。
     *   子目录按**目录自身 mtime 从新到旧**排序：预算不够时，丢的是最久没动过的目录。
     */
    const rows = [];
    let budget = scanMax;
    const DEPTH_MAX = 1;
    const isHidden = (n) => !n || n.startsWith('.');
    /**
     * ★ 路径一律**相对工作区**，分隔符统一成 `/`：
     *   绝对路径里带着本机用户名（`C:\Users\<真名>\…`），而这一段会被拼进发往模型网关的 prompt。
     *   用户名不是凭据，但它是**没必要外发**的本机信息；顺带让 Windows/Linux 两种读数长得一样，
     *   门禁里可以直接断言"不含盘符 / 不含工作区绝对路径"。
     */
    const pushFileRow = (full, fallbackRel) => {
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st || typeof st !== 'object') return;
      const mt = (st.mtime instanceof Date && !Number.isNaN(st.mtime.getTime())) ? st.mtime.toISOString() : '';
      let rel = '';
      try { rel = String(nodePath.relative(dir, full) || fallbackRel || ''); } catch { rel = String(fallbackRel || ''); }
      rel = rel.replace(/\\/g, '/');
      rows.push({ path: rel, size: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0, mtime: mt });
    };
    const direntFlags = (e) => {
      let isFile = false; let isDir = false;
      try {
        isFile = (typeof e.isFile === 'function') ? !!e.isFile() : false;
        isDir = (typeof e.isDirectory === 'function') ? !!e.isDirectory() : false;
      } catch { isFile = false; isDir = false; }
      return { isFile, isDir };
    };

    // ① 顶层：流式读，边读边 stat；子目录只登记（名字不进输出，仅用于排序）
    const subdirs = [];
    try {
      const top = fs.opendirSync(dir);
      try {
        while (budget > 0) {
          const e = top.readSync();
          if (!e) break;
          const name = String(e.name || '');
          // 隐藏项一律跳过：`.DS_Store` / `.cache` / `.git` 既不是产物，也不是用户想看的东西。
          if (isHidden(name)) continue;
          const flags = direntFlags(e);
          const full = nodePath.join(dir, name);
          if (flags.isFile) { budget -= 1; pushFileRow(full, name); continue; }
          if (flags.isDir && DEPTH_MAX >= 1) {
            let ms = 0; let okDir = false;
            try { const st = fs.statSync(full); ms = Number(st.mtimeMs) || 0; okDir = true; } catch { okDir = false; }
            if (!okDir) continue;
            budget -= 1;
            subdirs.push({ name, full, mtimeMs: ms });
          }
        }
      } finally { try { top.closeSync(); } catch { /* 关不掉不影响读数 */ } }
    } catch { /* 顶层读不动 ⇒ 空指纹（下面 kept 为空） */ }

    // ② 只下潜一层：子目录按目录 mtime 从新到旧，预算用尽即停
    /**
     * ★ 深度闸放在**这一个地方**：`DEPTH_MAX >= 1` 是"下不下潜"的唯一开关。
     *   门禁 `R28d9` 的电池就是把 `DEPTH_MAX` 从 1 改成 0 —— 子目录里的产物必须随之消失。
     *   如果这道闸散落在两处（登记子目录一处、遍历一处），改一个常量就打不红，等于没接线。
     */
    if (DEPTH_MAX >= 1) {
      subdirs.sort((a, b) => (b.mtimeMs - a.mtimeMs));
      for (const sd of subdirs) {
        if (budget <= 0) break;
        let dh = null;
        try { dh = fs.opendirSync(sd.full); } catch { continue; }
        try {
          while (budget > 0) {
            const e = dh.readSync();
            if (!e) break;
            const name = String(e.name || '');
            if (isHidden(name)) continue;
            const flags = direntFlags(e);
            // ★ 子目录的子目录**不探**（DEPTH_MAX = 1）；子目录名本身也不上榜。
            if (!flags.isFile) continue;
            budget -= 1;
            pushFileRow(nodePath.join(sd.full, name), sd.name + '/' + name);
          }
        } catch { /* 单个子目录读不动 ⇒ 跳过这一个，不影响别的 */ } finally {
          try { dh.closeSync(); } catch { /* 同上 */ }
        }
      }
    }
    /**
     * ★ `seen` 的口径 = **枚举到的普通文件数**（顶层 + 一层子目录内），受上面那份 stat 预算截断。
     *   它**不是**工作区文件总数，也**不是** `items.length`（后者还被开始时间过滤 + 8 条配额砍过）。
     *   下潜一层之后同一个工作区从 50 涨到 177 —— 文件没变多，是"数的方式"变了；
     *   谁把它当"产物暴涨"，就会去查一个不存在的 bug。
     */
    out.seen = rows.length;
    // ★ 只留本次任务开始之后动过的文件；开始时间拿不到 ⇒ 不过滤（读数里已经标明）。
    const kept = filterByStart ? rows.filter((r) => r.mtimeMs >= startedAt) : rows;
    kept.sort((a, b) => (b.mtimeMs - a.mtimeMs));
    out.items = kept.slice(0, max).map((r) => ({ path: r.path, size: r.size, mtime: r.mtime }));
    return out;
  } catch {
    // 目录不存在 / 读不动 / 任何意外 ⇒ 空指纹（这一段的失败**不许**影响替补启动）
    return Object.assign({}, out, { items: [] });
  }
}

/**
 * 把 `unresolvedSteps()` 给的**条目对象**逐条转成一句人话（`第N步 技能名：简述`）。
 *
 * 【为什么这里要有一份实现，而不是直接调 `deliveryProtocol.summarizeSteps()`】
 *   `summarizeSteps()` 会**顺手截到 8 条**（`STEP_SUMMARY_MAX_LINES`）。那是"给人看一眼"的
 *   摘要，不是"交接给替补"的清单 —— 拿它当上游数据源，12 条未完成会在**进入交接单之前**
 *   就被砍成 8 条，于是 `handoffBrief` 那边刚补的「另有 N 条」永远不触发
 *   （下游的纪律被上游提前截断架空了，一句话都不会说）。
 *   ⇒ 本函数**不截条数**，只做"对象 → 字符串"的形态转换；条数上限由 `handoffBrief.UNFINISHED_MAX`
 *     一处管（它会写「另有 N 条未展开」，那才是"不许静默丢"）。
 *
 * 【与 `stepLineOf` 的口径必须一致】
 *   文案格式、默认值（`未记录技能` / `没有留下失败原因`）、简述上限（60 字 + `…`）都与
 *   `deliveryProtocol.stepLineOf` 同口径。它没被导出（本模块也不能 require 它，见常量注释），
 *   所以这里是**第二份实现**；门禁 `R28a3` 用同一份 doneLog 同时跑两处，断言前 8 条逐字相等，
 *   口径一漂就红。
 *
 * @param {Array<object>} entries `openFailures()` 的返回值（`{step,skill,brief,ok,kind,resolved}`）
 * @returns {string[]} 条数与入参**有效条目数**相同（畸形条目跳过，不抛）
 */
function delegateStepLines(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    // 畸形条目（null / 字符串 / 缺字段）一律跳过：这份数据来自运行时，一个脏条目
    // 不该把整段「还没做完的事」毁掉。
    if (!s || typeof s !== 'object') continue;
    const rawNo = Number(s.step);
    const no = Number.isFinite(rawNo) && rawNo > 0 ? rawNo : (i + 1);
    const skill = String(s.skill || '').trim() || '未记录技能';
    let brief = String(s.brief || '').replace(/\s+/g, ' ').trim();
    if (!brief) brief = '没有留下失败原因';
    if (brief.length > DELEGATE_STEP_BRIEF_MAX) brief = brief.slice(0, DELEGATE_STEP_BRIEF_MAX) + '…';
    out.push('第' + no + '步 ' + skill + '：' + brief);
  }
  return out;
}

/**
 * ══ 替补接手时要带走的**全部事实**：一个纯函数算完，backend 只剩"把来源塞进来" ══
 *
 * 【为什么要有这一层（这是本轮返工的直接原因）】
 *   上一版把这四类事实的"取数 + 变换"**散在 backend 的三段代码里**，门禁只能靠 grep 源码
 *   字面量（`/unfinished:\s*unfinishedItems/`）来"证明接线"。实测两个变异体：
 *     · 在取数下一行插 `unfinishedItems = [];` ⇒ 功能已死，门禁 **326/0 全绿**；
 *     · 把 `acceptance:` / `workspace:` / `workspaceFingerprint(...)` 全部删掉 ⇒ ③④ 全死，**还是全绿**。
 *   grep 只能挡"变量改了名"，挡不住"值被换成常量""整行被删掉"。
 *   ⇒ 把这段逻辑抽成本函数：**入参是原始来源（日志 / 项目账 / 工作流契约 / 目录路径）**，
 *     出参是成品。这样门禁可以**真跑**它，并用变异体逐字段打红 —— 接线不再靠读源码相信。
 *
 * 【纪律】
 *   · **纯函数**：不读全局、不碰 `process`、不起子进程；唯一的外部接触是从 `i.workspace`
 *     这个目录里读文件（只读、有上限、失败即空）。
 *   · **不编造**：拿不到的字段给空值（`''` / `[]`），绝不写"请自行判断"这类占位文案。
 *   · **不抛**：任何一个来源畸形都降级成空，替补给不齐料也必须能起。
 *   · **不截条数**：未完成事项有几条给几条（见 `delegateStepLines` 头注）。
 *
 * @param {{
 *   openFailures?: (()=>Array<object>)|Array<object>,
 *   projectOrigin?: string, turnText?: string,
 *   requiredChecks?: Array<object>, workspace?: string, taskStartedAt?: number,
 *   clip?: (s:unknown, n:number)=>string, max?: number, scanMax?: number
 * }} input
 *   注意 `openFailures` 传的是**函数**（真源 `unresolvedSteps(taskEntry.doneLog)` 的调用方），
 *   不是已经过滤好的结果 —— 判据只有一份，本函数不重新判"哪些算未完成"。
 * @returns {{
 *   goal:string, acceptance:string[], unfinished:string[],
 *   workspace:object, fingerprint:{items:Array<object>, seen:number, filteredByTaskStart:boolean},
 *   openCount:number
 * }}
 *   `fingerprint.items` 与 `workspace.items` 是**同一个数组引用**（不是两份数据）：
 *   `workspace` 是交给 `planDelegation` 的整份对象，`fingerprint` 是给 trace / 门禁读的视图。
 *   ★ 返回值本身 + `unfinished` / `acceptance` / `workspace` / `fingerprint` **都已 `Object.freeze`**：
 *     下游只能读，改（清空/替换）会抛错或静默无效 —— 理由见函数末尾那段长注释。
 */
function buildDelegatePacket(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const clip = typeof i.clip === 'function' ? i.clip : clipLine;

  // ── ① 未完成事项：真源是调用方的 openFailures()（= unresolvedSteps），这里只转形态 ──
  let openEntries = [];
  try {
    const got = (typeof i.openFailures === 'function')
      ? i.openFailures()
      : (Array.isArray(i.openFailures) ? i.openFailures : []);
    if (Array.isArray(got)) openEntries = got;
  } catch { openEntries = []; }
  const unfinished = delegateStepLines(openEntries);

  // ── ② 目标：项目最初的要求 + 本次这一轮的要求（两个来源，分行带标签）──
  let goal = '';
  try {
    goal = composeDelegateGoal({ originText: i.projectOrigin, turnText: i.turnText, clip });
  } catch { goal = ''; }

  // ── ③ 验收标准：工作流注册项的 requiredChecks（逐项真跑的契约，不是模型自述）──
  let acceptance = [];
  try {
    acceptance = delegateAcceptanceLines(i.requiredChecks);
  } catch { acceptance = []; }

  // ── ④⑤ 工作区 / 分支 / 产物指纹（只读、廉价、失败即空；路径一律相对）──
  let fp = null;
  try {
    fp = workspaceFingerprint({
      workspace: i.workspace, taskStartedAt: i.taskStartedAt, max: i.max, scanMax: i.scanMax,
    });
  } catch { fp = null; }
  const workspace = (fp && typeof fp === 'object') ? fp : {
    workspace: String(i.workspace || ''), branch: DELEGATE_BRANCH_UNKNOWN, branchKnown: false,
    items: [], seen: 0, filteredByTaskStart: false, taskStartedAt: 0,
  };

  /**
   * ★★【出口冻结：这四类事实构造完就"改不动"】（2026-02-17 第三次打回）
   *
   * 为什么不再加 grep：复核方实跑了**七种**等价写法去清空 `unfinished` ——
   *   整字段重绑 / `pop()` 循环 / `splice(0)` / 方括号 / `Reflect.set` / 解构别名，
   *   六种让上一版门禁 **381/0 全绿**。形态判据只能把门槛抬一格，下一种写法照样绕过去。
   * ⇒ 改成"**表达不出来**"：把返回值冻死。下游任何清空/替换**要么抛错、要么静默无效**，
   *   注入出去的值改不坏（`R26a8` 真跑这七种写法，只看"值还在不在"，不看源码形态）。
   *
   * ⚠️ 冻结的代价要自己承担，**不许为了测试变绿把 freeze 摘掉**。
   *   ★ **本仓是非严格模式**（`backend.js` 里 `'use strict'` 0 处、`package.json` 无 `type` 字段）⇒
   *     冻结后的写入**静默失败**（不抛错，只是没生效），不会给用户报错、也不会在 trace 里留痕。
   *     所以：**下游需要变换请先拷贝**（`[...arr].sort()` / `arr.slice().map(...)`），别就地改。
   *   全部消费点已核对（只有读，或先 filter/map/slice 出拷贝）：
   *     · `backend.js`：只读（直接引用进注入行 / trace / 控制台）；
   *     · `planDelegation`：`items.filter(...)`（拷贝）+ 读 `.length`；
   *     · `buildDelegateSeedText`：`items.filter(...).slice(...)`（拷贝）；
   *     · `handoffBrief`：`unfinished` 走 `map` + `slice`（拷贝）。
   *   ⇒ 将来谁要就地改，**先拷贝再改**（`[...arr]` / `arr.slice()`）。
   *
   * ⚠️ 冻不住的只有"**整变量重绑**"（`delegatePacket = Object.assign(…)`）：那是调用方那一层的事，
   *   由 `const` 单次赋值 + `R26a9` 挡。
   */
  const packet = {
    goal,
    acceptance,
    unfinished,
    workspace,
    // 视图（同一个 items 引用，故意不复制：两个数组迟早不同步，那就是第二个真源）
    fingerprint: {
      items: workspace.items,
      seen: Number(workspace.seen) || 0,
      filteredByTaskStart: !!workspace.filteredByTaskStart,
    },
    openCount: unfinished.length,
  };
  // 冻结顺序：先冻被引用的数组 / 内层对象，再冻外层（冻结外层**不会**连带冻结内层）。
  Object.freeze(packet.unfinished);
  Object.freeze(packet.acceptance);
  Object.freeze(packet.workspace.items);   // 与 `fingerprint.items` 是同一个数组，冻一次即可
  Object.freeze(packet.workspace);
  Object.freeze(packet.fingerprint);
  return Object.freeze(packet);
}

/**
 * 交接单**实际产出了哪几段**（trace 读数，只报布尔，不重复记全文）。
 *
 * 为什么要有它：交接单有五个可选段落，而"哪些段真的出现过"是统计
 * 「交接信息完整率」的唯一机械口径 —— trace 里再记一遍全文会撑爆上限
 * （全文已经在 `handoffChars` 那边有读数了）。
 *
 * @param {null|object} brief `buildHandoffBrief` / `buildDelegateHandoff` 的产物
 * @returns {{forbidden:boolean, outOfReach:boolean, tried:boolean, notTried:boolean, unfinished:boolean}}
 */
function handoffSectionsOf(brief) {
  const b = (brief && typeof brief === 'object') ? brief : null;
  const has = (k) => !!(b && Array.isArray(b[k]) && b[k].length > 0);
  return {
    forbidden: has('forbidden'),
    outOfReach: has('outOfReach'),
    tried: has('tried'),
    notTried: has('notTried'),
    unfinished: has('unfinished'),
  };
}

module.exports = {
  DELEGATE_MODE,
  DELEGATE_TASK_SUFFIX,
  DELEGATE_MAX_DEPTH,
  DELEGATE_MAX_TURNS,
  DELEGATE_SUMMARY_MAX,
  DELEGATE_DENY_TOOLS,
  DELEGATE_ORIGIN_MAX,
  DELEGATE_TURN_MAX,
  DELEGATE_ACCEPT_MAX_ITEMS,
  DELEGATE_FP_MAX_ITEMS,
  DELEGATE_BRANCH_UNKNOWN,
  DELEGATE_STEP_BRIEF_MAX,
  normalizeDelegateDepth,
  toolNameOf,
  toolNameSet,
  pickDelegateTools,
  isStrictSubset,
  resolveDelegateModel,
  composeDelegateGoal,
  delegateAcceptanceLines,
  workspaceFingerprint,
  delegateStepLines,
  buildDelegatePacket,
  handoffSectionsOf,
  buildDelegateHandoff,
  buildDelegateSeedText,
  delegatePhaseLabel,
  delegateModeLabel,
  planDelegation,
  createDelegateSink,
  /**
   * ★ 凭据脱敏函数**从这一个出口也转出去**（真源在 `handoffBrief.js`）。
   *   为什么不在这里重新实现：两套正则 = 两个真源，改一处漏一处就有泄漏风险。
   *   为什么要有这个出口：门禁与"回灌主对话"的调用方大多只 require `secondRunner`，
   *   让它们能直接拿到同一个函数，就不会有人"顺手写个小 sanitize"。
   */
  redactSecrets,
};
