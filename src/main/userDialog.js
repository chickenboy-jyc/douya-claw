'use strict';

/**
 * 6 号「用户对接 Agent」的话术引擎。
 *
 * ============================ 为什么要有这个模块 ============================
 * 老板给的是一份**话术文本模板**（开场白标准版/精简版 + 6 个流转节点 + 禁句清单）。
 * 如果照抄成一段提示词塞给模型，会有三个必然发生的问题：
 *
 *   ① **模型挑最省事的那个节点。** 六段话术里，「达标汇报」最省力、最讨好，
 *      「打回补设计」最得罪人、「探测到硬壁垒」最麻烦。只要节点由模型自选，
 *      它就会长期偏向 4/5，2/6 近乎不出现 —— 而 2 和 6 恰恰是这套机制的**全部价值**。
 *   ② **话术与工单会漂。** 话术里写「后续满足【xxx条件】可升级」，xxx 来自工单第 9 项。
 *      分开维护 ⇒ 工单改了话术不改 ⇒ 用户看到一句空的升级承诺。
 *   ③ **重复打扰。** 开场白第 1 问已经问了「是否允许降级」。遇到硬壁垒时，
 *      如果模型又想不起来用户答过什么，就会再弹一次 A/B —— 用户会当场炸。
 *
 * 所以这一层的分工是：**话术文本照抄老板的，节点选择由状态机械推导。**
 * `pickNode` 是纯函数，输入是「工单 + 验收结论」，它不看模型心情。
 *
 * ============================ 一条必须先说的真话 ============================
 * 【开场白第 1 问「是否允许降级」，只有「不允许」这个答案会改变任何行为。】
 *   验收侧唯一的用法是 `acceptanceChecklist.js:426`：
 *     `else if (level !== MAIN && c.allowDegrade === false) ⇒ 判违规降级`
 *   ⇒ `true` 与 `undefined` 在代码里**完全等价**。
 * 这不是缺陷（默认就该允许合理降级），但如果有人以为「问过了所以收集到信息了」，
 * 那是自欺：**答「允许」等于没答**。真正有信息量的只有「不允许」这一句。
 * 这条写在这里，是为了让将来的人别把精简版的 `allowDegrade: true` 当成用户授权。
 *
 * ============================ 边界 ============================
 * 纯函数、零 IO、零副作用。不发请求、不读盘、不写盘。
 * 它只回答两件事：「现在该说哪段话」「这段话该填什么数据」。
 */

// ============================ 一、节点 ============================

/**
 * 六个流转节点。编号沿用老板模板（0 是开场白，不在原模板编号里但必须先有）。
 *
 * `expectsReply` 是**实质信息**：等用户说话的节点必须等，不许「我先按默认做了」。
 * 自动播报的节点（达标/降级汇报）不问问题，否则用户每收一次交付都要回一句废话。
 */
const NODES = {
  OPENING: 'opening',               // 0 开场：收集三项偏好
  PLAN_CONFIRM: 'plan-confirm',     // 1 三层目标已产出，等用户选档
  DEGRADE_ASK: 'degrade-ask',       // 2 探测到硬壁垒（询问 A/B 或告知已降级）
  DESIGN_CONFIRM: 'design-confirm', // 3 创作类设计推演已产出，等确认再开发
  DONE_DEGRADED: 'done-degraded',   // 4 降级达标汇报
  DONE_PASS: 'done-pass',           // 5 达标汇报
  BOUNCE_DESIGN: 'bounce-design',   // 6 创作类被打回，要求补设计
};

/** 节点 → 是否等用户回话。汇报类不等（但也不封锁后续追问）。 */
const EXPECTS_REPLY = {
  [NODES.OPENING]: true,
  [NODES.PLAN_CONFIRM]: true,
  [NODES.DEGRADE_ASK]: true,
  [NODES.DESIGN_CONFIRM]: true,
  [NODES.DONE_DEGRADED]: false,
  [NODES.DONE_PASS]: false,
  [NODES.BOUNCE_DESIGN]: false,
};

/** 节点 → 中文名（给 trace / 门禁失败信息用，不用英文常量对账）。 */
const NODE_LABEL = {
  [NODES.OPENING]: '开场收集偏好',
  [NODES.PLAN_CONFIRM]: '三层目标待确认',
  [NODES.DEGRADE_ASK]: '硬壁垒降级确认',
  [NODES.DESIGN_CONFIRM]: '设计推演待确认',
  [NODES.DONE_DEGRADED]: '降级达标汇报',
  [NODES.DONE_PASS]: '达标汇报',
  [NODES.BOUNCE_DESIGN]: '创作被打回补设计',
};

// ============================ 二、偏好收集 ============================

/** 话术版本。标准版逐项问；精简版走固定默认。 */
const DIALOG_MODES = {
  STANDARD: 'standard', // 逐项问用户
  BRIEF: 'brief',       // 按固定默认，只提示「不一致现在说」
};

/** 偏好来源。`user` = 用户真答过；`default-policy` = 走的默认规则，**不是授权**。 */
const PREF_SOURCE = {
  USER: 'user',
  DEFAULT: 'default-policy',
};

/**
 * 把「用户对开场白的回答」变成工单第 2 项的三个偏好。
 *
 * ★★ 三态纪律（与 `taskTicket.createTicket` 一致，不许破）：
 *   `allowDegrade` 只有 true / false / **null** 三种取值。
 *   用户没表态 ⇒ **必须 null**，绝不能默认成 false —— false 会造出「用户禁止降级」
 *   这条根本不存在的指示，进而让验收在正常降级时判「违背用户明确指示」。
 *
 * ★★ 精简版的默认值带 `source: 'default-policy'` 标记，**不是** `source: 'user'`：
 *   它影响不了验收结论（true 等价于 null），但必须能事后说清「这条是谁定的」。
 *   一旦将来验收侧要区分「用户授权」和「我们自己默认」，这个标记就是唯一的依据。
 *
 * @param {{allowDegrade?:boolean|null, skeletonOnly?:boolean, highRiskParallel?:boolean, note?:string}} answers
 *        用户的原话归一到这三项。解析用户自然语言不是本模块的事（那是模型/上层的事），
 *        本模块只接收**已经归一好的**布尔或 null。
 * @param {string} mode DIALOG_MODES 之一
 * @returns {{allowDegrade:boolean|null, skeletonOnly:boolean, highRiskParallel:boolean,
 *            note:string, source:string, asked:string[]}}
 */
function collectPreferences(answers, mode) {
  const a = (answers && typeof answers === 'object') ? answers : {};
  const m = mode === DIALOG_MODES.BRIEF ? DIALOG_MODES.BRIEF : DIALOG_MODES.STANDARD;
  const asked = [];

  if (m === DIALOG_MODES.BRIEF) {
    // 精简版的默认规则（老板原文）：
    //   ✅ 允许降级 · ❌ 不要最简骨架 · ❌ 不主动要求更严格的独立复核
    //   （老板原文写的是"默认关闭并行"；并行能力本仓不存在，故这里只作为"意向"默认 false）
    // allowDegrade 是 true 但**来源是默认策略**，不是用户授权。
    asked.push('brief-defaults');
    return {
      allowDegrade: true,
      skeletonOnly: false,
      highRiskParallel: false,
      note: String(a.note || ''),
      source: PREF_SOURCE.DEFAULT,
      asked,
    };
  }

  // 标准版：逐项看用户答了什么。**没答的留 null，不许替他答。**
  asked.push('allowDegrade', 'skeletonOnly', 'highRiskParallel');
  const tri = typeof a.allowDegrade === 'boolean' ? a.allowDegrade : null;
  return {
    allowDegrade: tri,
    // skeletonOnly 只有用户明确说要骨架才是 true；没答 ≠ 要骨架。
    skeletonOnly: a.skeletonOnly === true,
    // ⚠️ 字段名 `highRiskParallel` **故意不改**（尽管它现在已经不承诺并行了）：
    //   ① 它是工单第 2 项的结构字段，改名会同时打断 `taskTicket.createTicket` / `renderTicket` /
    //      既有多条 smoke 断言与已落盘的工单 JSON —— 收益是零，代价是一串连带改动；
    //   ② 本轮的修法是"把表述改如实"，不是"把字段删掉"。
    //   ③ **看到这个字段名的人请注意：它不控制任何并行执行。** 全仓对它**零个行为消费者**
    //      （没有 if 分支、没有调度、没有并发、没有预算分配读它）；第二个执行实例
    //      `secondRunner.js` 是**顺序接替**，不是并行、也不是"两份方案择优"。
    //      它的真实语义只剩一个：**用户"要不要更严格的独立复核"的意向记录**。
    //   默认仍是 false（老板原文：会消耗更多算力 ⇒ 不主动替用户开）。
    highRiskParallel: a.highRiskParallel === true,
    note: String(a.note || ''),
    source: (tri === null && a.skeletonOnly !== true && a.highRiskParallel !== true)
      ? PREF_SOURCE.DEFAULT : PREF_SOURCE.USER,
    asked,
  };
}

// ============================ 三、节点推导 ============================

/**
 * 该说哪段话 —— **纯推导，不由模型自选**。
 *
 * 优先级顺序本身就是纪律，改动前先读注释：
 *
 *   ① 验收已有结论 ⇒ 优先播报终态。
 *      理由：验收是既成事实。哪怕用户还没确认上一个节点，事实已经发生了，
 *      藏着不说去走流程，等于骗人。
 *   ② FAIL 且是创作类设计缺失 ⇒ 打回补设计（节点 6）。
 *   ③ FAIL 其他 ⇒ **不许直接对用户说「失败」**（那是禁句）。
 *      转成：允许降级 + 有硬壁垒 ⇒ 走节点 2；否则走节点 6 的通用打回形态。
 *      ★ 这是老板模板的一个真空档：节点 4/5/6 覆盖了降级/达标/打回，
 *        没有「普通失败」的汇报话术，而禁句清单又不许说「做不完」。
 *        唯一的自洽解法是 **FAIL 不是终态话术**，得先降级或打回。这里就这么处理。
 *   ④ 创作类 + 设计已产出 + 未确认 ⇒ 节点 3（老板的硬约束：确认后才编码）。
 *   ⑤ 硬壁垒 + 需降级 ⇒ 节点 2（询问或告知，见 `degradeMode`）。
 *   ⑥ 三层目标齐了但 level 未确认 ⇒ 节点 1。
 *   ⑦ 兜底 ⇒ 节点 0。
 *
 * @param {{ticket?:object, acceptance?:object, designReady?:boolean,
 *          designConfirmed?:boolean, planConfirmed?:boolean}} input
 * @returns {{node:string, why:string}}
 */
function pickNode(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const t = i.ticket || {};
  const acc = i.acceptance || null;
  const lv = normLevel(t.level);
  const type = normType(t.taskType);

  // ① 终态优先
  if (acc && acc.verdict) {
    const v = String(acc.verdict);
    if (v === 'DEGRADED') return { node: NODES.DONE_DEGRADED, why: '验收结论=降级达标，播报实际交付与边界' };
    if (v === 'PASS') return { node: NODES.DONE_PASS, why: '验收结论=达标，播报交付物清单' };
    if (v === 'FAIL') {
      // ② 创作类因设计缺失被打回
      const reasons = collectFailReasons(acc);
      const designIssue = type === 'creative'
        && (reasons.indexOf('refused-design') >= 0 || reasons.indexOf('fake-shell') >= 0
          || reasons.indexOf('nothing-at-all') >= 0);
      if (designIssue) {
        return { node: NODES.BOUNCE_DESIGN, why: '创作类被打回（缺设计推演/造假壳子），要求补齐后再验收' };
      }
      // ③ 普通 FAIL：不许直接说「失败」，转降级或通用打回
      const canDegrade = t.preference && t.preference.allowDegrade !== false;
      const hard = probeHard(t);
      if (hard && canDegrade && lv === 'main') {
        return { node: NODES.DEGRADE_ASK, why: 'FAIL + 外部硬壁垒 + 未禁止降级 ⇒ 转降级确认，不直接说失败' };
      }
      return { node: NODES.BOUNCE_DESIGN, why: 'FAIL 且无降级空间 ⇒ 转通用打回（禁句不许说「做不完」）' };
    }
    // TO_IMPROVE 不是终态：打回续跑，按创作/开发分别落
    if (v === 'TO_IMPROVE') {
      return { node: NODES.BOUNCE_DESIGN, why: '待优化 ⇒ 打回续跑（不是失败，也不是完成）' };
    }
  }

  // ④ 创作类设计确认
  if (type === 'creative' && i.designReady === true && i.designConfirmed !== true) {
    return { node: NODES.DESIGN_CONFIRM, why: '创作类已产出设计推演，按规则确认后才进编码' };
  }

  // ⑤ 硬壁垒降级
  if (probeHard(t) && lv === 'main') {
    return { node: NODES.DEGRADE_ASK, why: '探测到外部硬壁垒，主目标不可达 ⇒ 报进度 + 给选择' };
  }

  // ⑥ 三层目标待确认
  const goals = (t.goals && typeof t.goals === 'object') ? t.goals : {};
  const goalsFull = !!(goals.main && goals.main.text && goals.fallback && goals.fallback.text);
  if (goalsFull && i.planConfirmed !== true) {
    return { node: NODES.PLAN_CONFIRM, why: '三层目标已产出，等用户选从哪档启动探测' };
  }

  // ⑦ 兜底
  return { node: NODES.OPENING, why: '偏好尚未收集 / 尚未产出可确认的方案' };
}

/**
 * 节点 2 到底是「问 A/B」还是「告知已按你的授权切换」。
 *
 * ★★ 这是本模块防「重复打扰」的唯一机关。
 *   开场白第 1 问已经问过「是否允许降级」。用户答过，就**不许再问一遍**：
 *     · 答「允许」⇒ 直接降级 + 告知（说「按你的授权」），不再弹 A/B
 *     · 答「不允许」⇒ 只能继续硬磕，如实说风险，并把「要不要改主意」摆出来
 *     · 没表态（null）⇒ 这里才是唯一该弹 A/B 的地方
 *
 * @returns {{mode:string, reason:string}} mode ∈ ask / notice-auto / notice-forbidden
 */
function degradeMode(ticket) {
  const t = ticket || {};
  const pref = t.preference || {};
  const v = pref.allowDegrade;
  if (v === true) {
    return { mode: 'notice-auto', reason: '用户已授权降级 ⇒ 直接切保底并告知，不再重复问' };
  }
  if (v === false) {
    return { mode: 'notice-forbidden', reason: '用户明确不许降级 ⇒ 如实说只能硬磕与风险，并给出改主意入口' };
  }
  return { mode: 'ask', reason: '用户未表态 ⇒ 这是唯一该弹 A/B 的场景' };
}

// ============================ 四、渲染 ============================

/** 没数据时的占位。**绝不静默留空** —— 空着等于让用户以为「没有这回事」。 */
const MISSING = '（未提供）';

function val(s, fallback) {
  const t = String(s == null ? '' : s).trim();
  return t || (fallback || MISSING);
}

/**
 * 按节点渲染话术。
 *
 * 文本**照抄老板模板**，只把 xxx 换成真数据。改文案前先问：
 * 这句话是老板定的还是我编的？我编的不许往里加。
 *
 * @param {string} node NODES 之一
 * @param {object} ctx {ticket, acceptance, mode, designNote, bounces}
 * @returns {string}
 */
function renderNode(node, ctx) {
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const t = c.ticket || {};
  const acc = c.acceptance || {};
  const goals = t.goals || {};

  if (node === NODES.OPENING) {
    const mode = c.mode === DIALOG_MODES.BRIEF ? DIALOG_MODES.BRIEF : DIALOG_MODES.STANDARD;
    // ⚠️ 下面两段**逐字照抄老板模板**，连「5号规划Agent」不加空格、「主Agent+替补」
    //   不加空格都保持原样。门禁会逐字比对 —— 一旦我"顺手美化"了，门禁就成了
    //   「证明我改写对了」，而不是「证明没偏离原文」。要改文案先改老板的模板。
    if (mode === DIALOG_MODES.BRIEF) {
      return [
        '收到需求，已开始标准化转译，提交给5号规划Agent进行任务拆解。',
        '默认规则：允许合理降级；非你明确说明的情况下，不接受最简模板交付；创作类任务强制先走设计推演。',
        '如果你的偏好和默认不一致，或者有额外特殊要求，现在可以补充说明。',
      ].join('\n');
    }
    return [
      '收到你的需求，我将启动集群调度流程。',
      '我会先把你的需求翻译为标准化工单，同步给5号规划Agent。',
      '先向你确认几项偏好，用于工单配置：',
      '1. 如果原版方案遇到外部硬限制（平台反爬、权限、付费、风控等），你是否允许降级交付？',
      '2. 本次任务是否只需要最简骨架，后续再来补充细节？',
      '> 【重要提示】如果是游戏、网页、PPT、UI、桌面宠物这类创作任务，默认要求先输出设计推演文档、补齐合理细节，不会直接交付通用模板。',
      // ★★ 2026-11-04 改文案（老板原话已不可能实现，如实说）：修前这里问的是
      //   「3. 是否开启高风险双路并行校验（主Agent+替补独立产出两份方案对比择优…）？」
      //   —— 这句话承诺的能力**全仓从未存在**：`highRiskParallel` 只是个 JSON 布尔字段，
      //   不是 flag、不是配置项，**零个行为消费者**（没有任何 if 分支 / 调度 / 并发 / 预算分配读它）；
      //   而第二个执行实例（`secondRunner.js`）是**顺序接替**，被门禁明令禁止自称"并行/双路/双方案"
      //   （`unit-second-runner` R6j/R6k）。问一句做不到的事，比不问更坏。
      //   ⇒ 改成"要不要更严格的独立复核"，并**在同一句里**说清本版本只记意向。
      '3. 本次是否需要更严格的独立复核（会额外消耗算力）？说明：本版本仅记录你的意向，不改变执行方式，也没有"两份方案同时产出择优"的能力。',
      '你可以直接回复：确认，或者补充额外要求。',
    ].join('\n');
  }

  if (node === NODES.PLAN_CONFIRM) {
    return [
      '【规划方案已产出】',
      '5号规划Agent已经拆解三层目标：',
      '🎯 主目标：' + val(goals.main && goals.main.text),
      '🧩 保底目标：' + val(goals.fallback && goals.fallback.text),
      '📌 临时目标：' + val(goals.temp && goals.temp.text),
      '每个版本的能力、风险、代价已标注。',
      '请确认：我们按哪个目标启动探测开发？',
      '如果没有指定，默认优先尝试【主目标】。',
    ].join('\n');
  }

  if (node === NODES.DEGRADE_ASK) {
    const dm = degradeMode(t);
    const barrier = firstBlockers(t);
    const fb = goals.fallback || {};
    const tp = goals.temp || {};
    const up = String(((t.upgradeCondition) || '')).trim();

    const head = [
      '【探测结果反馈】',
      // 老板原文是「：【xxx】」带方括号，别省掉
      '原定主目标存在不可突破的外部硬壁垒：【' + val(barrier) + '】',
    ];

    if (dm.mode === 'notice-auto') {
      // 用户开场已授权 ⇒ 告知，不再问 A/B（重复打扰是这套话术最容易翻车的地方）
      return head.concat([
        '你在开始时已经授权「遇到外部硬限制可以降级」，我按这个授权直接切到保底目标，不再让你重选。',
        '🧩 保底目标：' + val(fb.text),
        '✅ 能做到：' + val(fb.capability),
        '⚠️ 局限：' + val(fb.riskCost),
        '📌 升级回退条件：' + val(up, '（工单未写升级条件 —— 缺失，必须补）'),
        '如果改主意不接受降级，说一声我停。',
      ]).join('\n');
    }

    if (dm.mode === 'notice-forbidden') {
      // 用户明确不许降级 ⇒ 不许偷偷降，也不许说"没办法了"
      return head.concat([
        '你在开始时明确说过「不接受降级」，所以我不会切保底版本。',
        '现在只剩一条路：继续磕原版。风险是大概率长时间卡壳、最终可能依然拿不到。',
        '📌 另外还有一档更低的兜底：' + val(tp.text) + '（' + val(tp.capability) + '）',
        '你可以回复：继续硬磕 / 改主意接受降级 / 先拿兜底版本。',
      ]).join('\n');
    }

    // 未表态 ⇒ 唯一该弹 A/B 的场景
    return head.concat([
      '无法继续执行原版方案，现有两个选择：',
      'A：切换到保底目标交付，保留核心诉求，今天可以拿到可用成果，局限：' + val(fb.riskCost)
        + '；后续满足【' + val(up, '（工单未写升级条件 —— 缺失，必须补）') + '】可以升级回完整版',
      'B：不接受降级，持续硬磕原版，风险：大概率长时间卡壳，最终依然无法实现',
      '请选择你的方案。',
      '（如果你不想每次都被问，可以回复「以后默认允许降级」。）',
    ]).join('\n');
  }

  if (node === NODES.DESIGN_CONFIRM) {
    return [
      '【创作前置设计推演完成】',
      '已经完成设计方案文档：' + val(c.designNote, '风格定位、结构、交互逻辑、状态分支、反馈细节、边界处理'),
      '按规则，确认这份设计思路之后，才会进入编码/制作环节。',
      '你可以直接确认通过，或者提出修改意见。',
    ].join('\n');
  }

  if (node === NODES.DONE_DEGRADED) {
    const lim = acc.limits || {};
    const can = arr(lim.can);
    const cannot = arr(lim.cannot);
    return [
      '【验收报告｜降级达标】',
      '原定主目标：' + val(goals.main && goals.main.text),
      '卡点原因：' + val(firstBlockers(t)),
      '当前交付：' + val(arr(t.deliverables).join('、')),
      '✅ 能力范围：' + val(can.join('；')),
      '⚠️ 局限边界：' + val(cannot.join('；')),
      '📌 升级回退条件：' + val(t.upgradeCondition, '（工单未写升级条件 —— 缺失，必须补）'),
      '完整验收报告已同步归档。',
    ].join('\n');
  }

  if (node === NODES.DONE_PASS) {
    const lim = acc.limits || {};
    return [
      '【验收报告｜达标】',
      '已按约定目标完成交付，验收校验全部通过。',
      '✅ 交付物清单：' + val(arr(t.deliverables).join('、')),
      '⚠️ 已知限制：' + val(arr(lim.cannot).join('；'), '暂未发现'),
      '完整验收报告已归档。',
    ].join('\n');
  }

  if (node === NODES.BOUNCE_DESIGN) {
    const reasons = collectFailReasons(acc);
    const designBounce = reasons.indexOf('refused-design') >= 0
      || reasons.indexOf('fake-shell') >= 0
      || normType(t.taskType) === 'creative';
    if (designBounce) {
      return [
        '【验收反馈：需要补充设计】',
        '本次属于创作类任务，当前交付只有基础骨架，缺少设计推演与配套细节，不符合交付规范，已打回。',
        '要求：补充设计推演文档，补齐符合主题的合理细节，再重新提交验收。',
      ].join('\n');
    }
    // 非创作类被打回：照同一套「说清要求」的骨架，但不硬套「创作类」的措辞
    return [
      '【验收反馈：需要补充】',
      '本次交付未通过验收，已打回。',
      '不通过的原因：' + val(reasons.join('、'), '验收项未通过'),
      '要求：按上面列出的项逐条补齐后重新提交验收。',
    ].join('\n');
  }

  // 未知节点：报错比沉默好 —— 沉默会让调用方以为话已经说了
  throw new Error('未知话术节点：' + String(node));
}

// ============================ 五、禁句 ============================

/**
 * 老板的禁止话术清单。前三条是**句式**，可机械判定；第四条是「日志原始堆砌」，
 * 用「是否存在连续多行无中文解释的英文堆栈/JSON」判 —— 不完美，但比不判强，
 * 且它只在**明显堆砌**时才红（宁可漏判，不要冤判正常的技术细节）。
 */
const FORBIDDEN = [
  { code: 'declare-fail', re: /这个任务失败|做不完|任务失败了|无法完成这个任务/, why: '老板禁句：不许直接宣布失败，要说清原本想做什么/遇到什么/有哪些路线' },
  { code: 'offer-skeleton', re: /(直接|先)给你(一个)?(能用的)?(最简|简易|基础)(版本|模板|骨架)/, why: '老板禁句：创作类不许直接丢最简模板' },
  { code: 'stuck-nothing', re: /(卡在|堵在)[^\n。]{0,30}(没办法|没辙|无解|到此为止|只能这样)/, why: '老板禁句：卡住不许说「没办法了」，要给可选路线' },
];

/**
 * 扫一段即将发给用户的文本，返回命中的禁句。
 *
 * ⚠️ 只用于**面向用户的最终文本**，不要拿去扫日志/内部 trace
 *   （那些地方本来就该有原始信息）。
 *
 * @param {string} text
 * @returns {Array<{code:string, hit:string, why:string}>}
 */
function findForbidden(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  for (const f of FORBIDDEN) {
    const m = s.match(f.re);
    if (m) out.push({ code: f.code, hit: m[0], why: f.why });
  }
  // 第四条：日志原始堆砌 —— 连续 ≥4 行以空白缩进的英文/符号、且整段没有中文解释
  const lines = s.split(/\r?\n/);
  let run = 0;
  let worst = 0;
  for (const ln of lines) {
    const t2 = ln.trim();
    const looksRaw = /^(at\s|Traceback|\{|\}|\[|"|'|[A-Za-z_$][\w.$]*\s*[:=(])/.test(t2);
    const hasCjk = /[\u4e00-\u9fa5]/.test(t2);
    if (t2 && looksRaw && !hasCjk) { run += 1; worst = Math.max(worst, run); }
    else run = 0;
  }
  if (worst >= 4) {
    out.push({
      code: 'raw-log-dump',
      hit: '连续 ' + worst + ' 行原始堆栈/JSON',
      why: '老板禁句：不许堆砌原始日志，要给「哪一句是关键、它是什么意思」',
    });
  }
  return out;
}

// ============================ 六、小工具 ============================

function arr(v) {
  if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x)).filter((x) => x.trim());
  if (v == null || v === '') return [];
  return [String(v)];
}

function normLevel(v) {
  const s = String(v == null ? '' : v);
  // 按**值**比，不按值当键查（这个坑在 taskTicket 里已经踩过一次）
  for (const k of ['main', 'fallback', 'temp']) if (k === s) return s;
  return 'main';
}

function normType(v) {
  const s = String(v == null ? '' : v);
  for (const k of ['dev', 'creative', 'research']) if (k === s) return s;
  return 'dev';
}

function probeHard(t) {
  const p = (t && t.probe) || {};
  return String(p.barrierKind || '') === 'hard-barrier';
}

function firstBlockers(t) {
  const p = (t && t.probe) || {};
  const b = arr(p.blockers);
  if (b.length) return b.join('、');
  const r = String(p.result || '').trim();
  return r || MISSING;
}

function collectFailReasons(acc) {
  const out = [];
  const push = (x) => { const s = String(x == null ? '' : x).trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  const fp = acc && acc.failed;
  if (Array.isArray(fp)) for (const it of fp) if (it && it.reason) push(it.reason);
  const hf = acc && acc.hardFailed;
  if (Array.isArray(hf)) for (const it of hf) if (it && it.reason) push(it.reason);
  if (acc && acc.reason) push(acc.reason);
  return out;
}

module.exports = {
  NODES,
  NODE_LABEL,
  EXPECTS_REPLY,
  DIALOG_MODES,
  PREF_SOURCE,
  FORBIDDEN,
  collectPreferences,
  pickNode,
  degradeMode,
  renderNode,
  findForbidden,
};
