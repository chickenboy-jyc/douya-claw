'use strict';

/**
 * 多 Agent 集群优化资产的**可核对登记表**（A1~A6 / B1~B3 / C1）。
 *
 * ============================ 这个模块存在的理由 ============================
 * 老板给了一份「总目录索引」，最后一句写着：
 *
 *   「统一入口：所有内容最终都以 A1~A6、B1~B3 为准，其余口头沟通不做权威来源。」
 *
 * 「以……为准」如果是靠一段文档来保证，那它保证不了任何事 —— 文档不会红。
 * 本仓已经反复付过这个代价：`itemsMissing` 落了 trace 没人读、`designCoverage`
 * 采集了没人消费、`acceptanceToTerminal` 写了零调用点。**「写了」和「生效」是两件事。**
 *
 * 所以这张表的作用是：把「索引里说这项定稿了」变成「代码里能验证这项定稿了」。
 * 它**不是**又一份文档 —— 它的每一条都会被 `unit-asset-registry` 机械核对：
 *   · 标 `implemented` ⇒ 承载文件必须真实存在，**且**守护门禁必须在测试链里；
 *   · 标 `missing`    ⇒ **不许**偷偷存在承载文件（做了没登记 = 登记表已过期）；
 *   · 标 `engine-only`/`partial` ⇒ 必须写明缺哪一块（`gap` 不许为空）。
 *
 * ============================ 一条必须先说破的事实 ============================
 * 【本产品是**单体 persona** 架构，没有 A2~A6 那 7 个 Agent。】
 *
 * 索引里每份提示词的「粘贴位置」写的都是「5 号 / 6 号 / 4 号 / 7·8 号的 System Prompt」。
 * 而本产品的 prompt 组装是**按上下文场景**注入，不是**按角色**分发。
 * 实测（`scripts/tmp-probe/_probe-sysinject.mjs`，门禁 R6d/R6e 把数字钉住）：
 *   `src/main` 全目录共 **24 处** `role:'system'` 注入
 *   （`backend.js` 22 + `agentReview.js` 1 + `memorySummary.js` 1），
 *   注入的 content **全是具名常量或具名函数**：
 *     `DOUYA_PERSONA_PROMPT`（豆芽人设）/ `callNameMsg` / `projectPrompt(..)` /
 *     `ambiguityPrompt(..)` / `_snapTxt` / `expert.systemPrompt`（购物助手这类**业务身份**）/
 *     `designMolds.buildMoldBrief(..)`（设计模具，**按任务类型选择注入**）/ `handoffBriefText(..)`（续跑交接单）
 *     / 「本机文件产物怎么截图自检」（**按技能在位与否注入**）/ 「单轨拼接 vs 多轨精剪」（**按技能在位与否注入**）……
 *
 * 【2026-11-03 从 18/20 改成 20/22 的两处，逐条说明它们为什么是"场景提示"而不是"角色槽位"】
 *   ① `designMolds.buildMoldBrief({kinds})` —— 设计任务的**结构候选 + 数值规格**。
 *      入参 `kinds` 来自本次请求的任务类型判定，**不是角色编号**；四个 kind 是产出物类型
 *      （网页 / 海报 / 长图 / PPT），与"谁来说这段话"无关。
 *   ② `handoffBriefText(brief)` —— 续跑时把**上一次运行**的失败账交给这一次运行。
 *      它讲的是"上一任撞了哪堵墙"，不含任何身份设定；`brief` 由失败账本现算，不是查表。
 *   ⇒ 两处都增加了"注入点数"，但都没有引入"按角色分发 prompt"。
 *      R6c（角色路由关键词）与 R6f（按角色查表）仍然反向守着，两条都没被触发。
 *
 * 【2026-11-08 从 20/22 改成 22/24 的两处，逐条说明它们为什么是"场景提示"而不是"角色槽位"】
 *   ⚠️ 先说清这次的真因：这两处不是"新发现的注入点"，是**门禁一直看不见的两个**。
 *      `unit-asset-registry` 的 R6d/R6e 要先剥注释再数 `role:'system'`，而它的剥注释函数
 *      原来的顺序是「先剥块注释、再剥行注释」。backend.js 里有几行**行注释**含 `/ws/*` 字面量
 *      （讲只读静态路由那段），`/ws/*` 里的 `/*` 被当成块注释起点，正则一路吞到下一个
 *      块注释结束符（几百行之后），把中间 4 个真实注入点一起吃掉了 ⇒ 读数 18。
 *      ⇒ 现象是「backend 少了 2 个注入点」，真相是「判据自己看不见」。剥注释顺序已修，
 *        并加了 R6i/R6j/R6k 三条常驻自证把这个形态钉住。
 *  ① `546793fd`（11-07 05:36）`fix(产物自检): 补上「本机文件产物怎么自检」的提示` ——
 *     内容是「本机文件产物怎么截图验收」：`/ws/<相对路径>` 这条只读静态路由怎么用、
 *     为什么不许绕 `file://`、为什么不许自己起 http-server、端口怎么拼。
 *     门控是 `if (skills.some(s => s.id === 'browser-verify'))` —— 按**技能在位与否**分发，
 *     不是"谁来说这段话"。它解决的是"复检永远跑不成、任务永远到不了 COMPLETE"这个死循环。
 *  ② `29d84e8e`（11-07 05:58）`feat(视频): concat-video 接进提示层与成果卡` ——
 *     内容是「单轨拼接用 media-edit、多轨精剪用 concat-video」的分流规则，
 *     外加"没装就引导安装、不要反复 probe"。
 *     门控是 `if (skills.some(s => s.id === 'concat-video'))`，同样按**技能在位与否**分发。
 *   ⇒ 两处都是**场景提示**，没有一处是角色 prompt 槽位：都没有"角色"的概念，
 *     也没有拿 `role`/`roleName` 作下标查表。R6c 与 R6f 仍然反向守着，两条都没被触发。
 *
 *   **没有一处**是拿 `role` / `roleName` / `agent` 作下标去查 prompt 表选出来的，
 *   也没有角色进程、角色路由、角色切换（R6c / R6f 反向守着）。
 *
 * ⚠️ 我一度把这里写成「组装路径只有两处、就是一行 unshift」—— 那是错的。
 *    探针实测 18 处；错在把「存在那一行」当成了「只有那一行」。
 *    ⚠️ 后面这个「18」本身也是错的（2026-11-08 更正）：18 是**门禁剥注释吞掉真实代码后**
 *    的读数，真实值是 22（见上面那段）。也就是说我当时不仅把「存在那一行」当成了
 *    「只有那一行」，还用了**一把坏尺子**去量 —— 两件事叠在一起，才让"看起来只有 18 处"
 *    显得像实测结论。教训：判据的读数也要有自证（R6i/R6j/R6k 就是补这个）。
 *    同理，「grep 角色编号只命中 B1~B3 的注释」也不准：实际还命中 3 处**字符串**——
 *    `taskTicket.js:632` 的工单文本（引用资产名）、`userDialog.js:282+` 的老板原文话术、
 *    以及本文件自己的 ASSETS 表。这也说明**「文案里出现角色名」不能用来判「实现了角色」**。
 *
 * ⇒ 这不是"漏了 7 个文件"，而是那 7 个 prompt **假设了一个本产品不存在的架构**。
 *   硬写 7 个 .js 导出 7 段字符串，等于造 7 个永远没人读的死常量 ——
 *   那比现在更糟，因为它会让登记表显示 `implemented`，而实际一句话都不会生效。
 *
 * ⇒ 本表的处理方式：把 A2~A4 记成 `engine-only`（**引擎在、角色 prompt 不在**），
 *   A6 记成 `missing`。诚实标出来，谁要推进就知道缺口在哪。
 *
 * ============================ 边界 ============================
 * 本模块**纯数据 + 纯函数，零 IO**。文件存不存在、门禁在不在链里，
 * 由调用方通过 `auditRegistry` 注入的 `exists` / `isGuarded` 提供 ——
 * 这样判定逻辑可单测，IO 集中在门禁里。
 */

// ============================ 一、状态 ============================

/**
 * 资产落地状态。四档，互斥。
 *
 * ⚠️ 为什么不搞「完成度百分比」：百分比可以调，四档不能。
 *   一个能靠"我觉得做了 80%"通过的登记表，最后一定会被填成 100%。
 */
const ASSET_STATUS = {
  /** 有代码承载 **且** 有门禁在测试链里守着。这是唯一能说"定稿"的状态。 */
  IMPLEMENTED: 'implemented',
  /** 引擎（纯函数模块）在，但索引说的那个"角色"不在——没有对应的 prompt / 编排。 */
  ENGINE_ONLY: 'engine-only',
  /** 一部分落地了，一部分没有。`gap` 必须逐条写明缺什么。 */
  PARTIAL: 'partial',
  /** 完全没有。**不许有任何承载文件存在**，否则登记表已过期。 */
  MISSING: 'missing',
};

const STATUS_LABEL = {
  [ASSET_STATUS.IMPLEMENTED]: '已落地（有代码 + 有守护门禁）',
  [ASSET_STATUS.ENGINE_ONLY]: '仅引擎（无对应角色 prompt / 编排）',
  [ASSET_STATUS.PARTIAL]: '部分落地',
  [ASSET_STATUS.MISSING]: '未落地',
};

/** 索引里的三组。`A`=角色提示词，`B`=验收/工单/话术，`C`=流程。 */
const ASSET_GROUPS = {
  A: '角色提示词',
  B: '验收与协作工具',
  C: '调度流转',
};

// ============================ 二、资产表 ============================

/**
 * 十项资产。字段约定：
 *   id        索引里的编号（A1/A2/…/C1），报告里逐条引用它，别用中文长名当 key
 *   name      索引里的名字（逐字）
 *   group     A / B / C
 *   pasteAt   索引里写的「粘贴位置」。**照抄**，因为这是待核对的事实之一 ——
 *             本产品多数没有这个槽位，抄下来才能让缺口看得见
 *   roleSlot  **本产品有没有这个角色的 prompt 槽位**（布尔，必填）
 *             true  = 真有一个独立的 system prompt 位置（目前只有 A1 算：豆芽人设本身）
 *             false = 本产品没有这个角色进程/prompt，功能由 main 进程里的纯函数模块承担
 *             ⚠️ 这个字段和 status 是**两件不同的事**：
 *                A5「4 号验收」的功能是完整落地的（判定/读数/接线/门禁/变异反控全齐），
 *                但本产品没有「4 号」这个 Agent ⇒ status=implemented + roleSlot=false。
 *                把 status 降成 engine-only 反而是贬低 —— 那会让人以为功能也没做完。
 *   status    ASSET_STATUS 之一
 *   carriers  承载文件（相对仓库根）。IMPLEMENTED/ENGINE_ONLY/PARTIAL 必须非空且真实存在
 *   guards    守护门禁（`scripts/smoke/*.mjs` 的文件名，含 .mjs）。IMPLEMENTED 必须非空且在链里
 *   evidence  具体落在哪个函数/章节（让人能一眼找到，不用全文件读一遍）
 *   gap       缺什么。ENGINE_ONLY/PARTIAL 必填（门禁会断言非空）
 *   note      其他必须说清的话
 */
const ASSETS = [
  // ────────────────────────── A 组：角色提示词 ──────────────────────────
  {
    id: 'A1',
    name: '全局顶层公理',
    group: 'A',
    pasteAt: '所有 Agent 共用（提示词最顶部）',
    roleSlot: true,
    status: ASSET_STATUS.PARTIAL,
    carriers: ['src/main/douyaPersona.js', 'src/main/acceptanceChecklist.js', 'src/main/taskTicket.js'],
    guards: ['unit-acceptance-checklist.mjs', 'unit-task-ticket.mjs'],
    evidence: 'douyaPersona.js §四（重试止损）/§十六之二（三层目标降级）；'
      + 'acceptanceChecklist.js G1-1~G1-4（卡点区分/重试/降级合规/三层兜底）；'
      + 'taskTicket.js creative-needs-design-doc（创作类强制推演）',
    gap: '索引列的 6 条里，**「并行替补」没有任何实现** —— 全仓没有双路产出的编排。'
      + '其余 5 条（目标分层 / 重试止损 / 创作推演 / 手段≠目的 / 边界说明）都落在代码里。',
    note: '注意形态差异：索引设想的是「7 个 Agent 共用一段公理」，本产品是**单 persona 自带**这些规则。'
      + '规则内容一致，承载方式不同 —— 不影响生效，但影响「改一处全部生效」这个假设（这里确实是一处）。',
  },
  {
    id: 'A2',
    name: '5 号规划 Agent Prompt',
    group: 'A',
    pasteAt: '5 号 System Prompt',
    roleSlot: false,
    status: ASSET_STATUS.ENGINE_ONLY,
    carriers: ['src/main/taskTicket.js', 'src/main/userDialog.js'],
    guards: ['unit-task-ticket.mjs', 'unit-user-dialog.mjs'],
    evidence: 'taskTicket.js createTicket/validateTicket/moveLevel（三层目标拆解、降级决策、'
      + '旧工单归档）；userDialog.js pickNode 的 plan-confirm 分支（等用户选档）',
    gap: '**没有「5 号」这个角色**：没有规划 Agent 的 system prompt，也没有"派探测→判卡点→'
      + '定生效目标→同步广播"的编排。引擎（工单怎么建、怎么校、怎么降级）是齐的，'
      + '但谁来调用它、按什么顺序调用，目前靠主循环里的模型自觉。',
    note: '知识库沉淀（索引 A2 的最后一条）没有实现：本仓没有「同类需求优先读历史工单」的检索。',
  },
  {
    id: 'A3',
    name: '6 号翻译沟通 Agent Prompt',
    group: 'A',
    pasteAt: '6 号 System Prompt',
    roleSlot: false,
    status: ASSET_STATUS.ENGINE_ONLY,
    carriers: ['src/main/userDialog.js', 'src/main/agentReview.js'],
    guards: ['unit-user-dialog.mjs', 'unit-agent-review.mjs'],
    evidence: 'userDialog.js collectPreferences（偏好识别）/ renderNode（六段人话话术）/ '
      + 'findForbidden（禁原始日志堆砌、禁生硬失败结论）；'
      + 'agentReview.js buildAuditReport / reviewVerdictStatement（人话汇报）',
    gap: '**没有「6 号」这个角色**：话术引擎齐了，但「向用户提问并等回答」的暂停点不存在 —— '
      + 'backend 里 grep `awaitingUser|waitingForUser|pendingQuestion|needsUserReply` 零命中。'
      + '所以 7 个话术节点的**询问类 4 个（开场/选档/降级确认/设计确认）接不上**，'
      + '只有播报类 3 个（达标/降级达标/打回）技术上能自动播。',
    note: '这正是 userDialog.EXPECTS_REPLY 字段的真实用途：它标记了哪些节点现在能自动播、'
      + '哪些必须等架构支持，不只是文档。',
  },
  {
    id: 'A4',
    name: '1/2/3 号开发 Agent Prompt',
    group: 'A',
    pasteAt: '1/2/3 号 System Prompt',
    roleSlot: false,
    status: ASSET_STATUS.ENGINE_ONLY,
    carriers: ['src/main/acceptanceReadings.js', 'src/main/acceptanceChecklist.js', 'src/main/douyaPersona.js'],
    guards: ['unit-creative-design.mjs', 'unit-acceptance-checklist.mjs'],
    evidence: 'acceptanceReadings.js（TS 严格/any 计数/单文件行数/E2E 存在性/空壳信号 —— '
      + '但这些读的是**验收侧**）；acceptanceChecklist.js G3-1~G3-4 + G2-3（不造空壳）；'
      + 'douyaPersona.js §四（遇外部硬壁垒一次都别再试）',
    gap: '**约束是"验收时读"，不是"开发时就范"**：TS 规范 / 代码拆分 / E2E 现在只在交付后被'
      + '查出来，没有在编码时拦。索引要的「1/2/3 号以当前生效目标为准」也缺一环 ——'
      + '`level` 在生产路径上根本没人传给执行方（backend 无 goalLevel 状态）。',
    note: '「不造空壳」是唯一在两侧都有的：开发侧有 persona 禁令，验收侧有 G2-3 + shellSignals 读数。',
  },
  {
    id: 'A5',
    name: '4 号验收 Agent Prompt',
    group: 'A',
    pasteAt: '4 号 System Prompt',
    roleSlot: false,
    status: ASSET_STATUS.IMPLEMENTED,
    carriers: ['src/main/acceptanceChecklist.js', 'src/main/agentReview.js', 'src/main/acceptanceReadings.js'],
    guards: ['unit-acceptance-checklist.mjs', 'unit-agent-review.mjs', 'unit-agent-review-gate.mjs',
      'unit-creative-design.mjs'],
    evidence: 'acceptanceChecklist.js evaluateAcceptance（四态判定公式）/ acceptanceToTerminal / '
      + 'renderAcceptanceReport；agentReview.js auditTask（真调用）+ reviewVerdict（压制链）',
    gap: '',
    note: '这是十项里最完整的一项：判定、读数、接线、门禁、变异反控全齐。'
      + '唯一保留意见是「4 号」这个角色名在本产品不存在 —— 它是 main 进程里的一个纯函数模块，'
      + '不是独立 Agent。功能等价，形态不同。',
  },
  {
    id: 'A6',
    name: '7/8 号替补 Agent Prompt',
    group: 'A',
    pasteAt: '7/8 号 System Prompt',
    roleSlot: false,
    status: ASSET_STATUS.MISSING,
    carriers: [],
    guards: [],
    evidence: '',
    gap: '完全没有。索引说「接管先分卡点；代码 bug 重写，硬壁垒建议降级；并行时独立出方案」——'
      + '本仓既没有替补 Agent，也没有并行双路产出。A1 里缺的那条「并行替补」和这里是同一个缺口。',
    note: '这是十项里唯一的纯缺口。要真做，得先决定是「多进程编排」还是「同一模型跑两遍对比」，'
      + '两者的成本与判据完全不同。',
  },

  // ────────────────────────── B 组：验收与协作工具 ──────────────────────────
  {
    id: 'B1',
    name: '4 号验收自检清单',
    group: 'B',
    pasteAt: '4 号内部执行依据',
    roleSlot: true,
    status: ASSET_STATUS.IMPLEMENTED,
    carriers: ['src/main/acceptanceChecklist.js', 'src/main/acceptanceReadings.js'],
    guards: ['unit-acceptance-checklist.mjs', 'unit-creative-design.mjs'],
    evidence: 'acceptanceChecklist.js CHECKLIST（前置核验 + 四组 14 项）/ ACCEPT_VERDICTS 四态 / '
      + 'renderAcceptanceReport 报告模板；acceptanceReadings.js 机械读数层',
    gap: '',
    note: '索引 B1 说「前置核验（任务类型 / 生效目标 / 偏好）」—— 这三项现在由'
      + '`taskTicket.ticketToAcceptanceContext` 提供，不再靠验收模型自述。',
  },
  {
    id: 'B2',
    name: '5 号任务工单模板',
    group: 'B',
    pasteAt: '5 号生成、全体同步',
    roleSlot: true,
    status: ASSET_STATUS.IMPLEMENTED,
    carriers: ['src/main/taskTicket.js'],
    guards: ['unit-task-ticket.mjs'],
    evidence: 'taskTicket.js createTicket（11 项字段全落位）/ validateTicket（两档 severity）/ '
      + 'moveLevel（原地降级 + 归档）/ ticketToAcceptanceContext / renderTicket',
    gap: '',
    note: '索引列的字段与代码逐一对上了：原始需求、偏好、分类标签（含创作子类型）、三层目标、'
      + '当前生效目标、探测结论、交付清单、升级条件、调度分配、备注。',
  },
  {
    id: 'B3',
    name: '6 号对接启动话术',
    group: 'B',
    pasteAt: '6 号对外',
    roleSlot: true,
    status: ASSET_STATUS.IMPLEMENTED,
    carriers: ['src/main/userDialog.js'],
    guards: ['unit-user-dialog.mjs'],
    evidence: 'userDialog.js NODES（开场 + 六节点）/ renderNode（文本逐字照抄） / '
      + 'pickNode（节点由状态推导，不由模型自选）/ findForbidden（禁句清单）',
    gap: '',
    note: '开场白与精简版**逐行逐字**对齐原文（U2 断言，配反控）；节点选择是纯函数，'
      + '不是让模型挑最省事的那个。',
  },

  // ────────────────────────── C 组：流程 ──────────────────────────
  {
    id: 'C1',
    name: '全套调度流转流程',
    group: 'C',
    pasteAt: '5 号参考',
    roleSlot: false,
    status: ASSET_STATUS.MISSING,
    carriers: [],
    guards: [],
    evidence: '（部分相近能力在 userDialog.pickNode，见 note）',
    gap: '索引要的是「6→5→探测→开发→验收」这条**角色之间的**流转。'
      + '本仓的 `userDialog.pickNode` 只回答「现在该对用户说哪段话」，'
      + '**不驱动任何 Agent 之间的交接** —— 谁把工单交给谁、探测结果回填到哪、'
      + '降级后如何广播，这些都没有编排代码。',
    note: 'pickNode 与 C1 的关系容易看错：它读工单状态、产出"该说哪句话"，'
      + '属于 6 号的输出侧；C1 要的是驱动侧。两者方向相反，不能互相顶替。'
      + '所以这里没有把 pickNode 记成载体 —— 记上去会让登记表**虚高**。',
  },
];

// ============================ 三、查询 ============================

/** 按 id 取一项。取不到返回 null（不抛 —— 调用方多半在遍历）。 */
function getAsset(id) {
  const s = String(id == null ? '' : id).trim().toUpperCase();
  for (const a of ASSETS) if (a.id === s) return a;
  return null;
}

/** 按状态筛。 */
function listByStatus(status) {
  const s = String(status == null ? '' : status);
  return ASSETS.filter((a) => a.status === s);
}

/**
 * 盘点摘要：各状态计数 + 一句话结论。
 * 报告里先给这个，别让人自己数。
 */
function summarise() {
  const by = {};
  for (const k of Object.keys(ASSET_STATUS)) by[ASSET_STATUS[k]] = 0;
  for (const a of ASSETS) by[a.status] = (by[a.status] || 0) + 1;
  const impl = by[ASSET_STATUS.IMPLEMENTED] || 0;
  return {
    total: ASSETS.length,
    by,
    headline: '十项资产：' + impl + ' 项已落地（有代码 + 有守护门禁）、'
      + (by[ASSET_STATUS.ENGINE_ONLY] || 0) + ' 项仅引擎（角色 prompt 不存在）、'
      + (by[ASSET_STATUS.PARTIAL] || 0) + ' 项部分落地、'
      + (by[ASSET_STATUS.MISSING] || 0) + ' 项未落地',
  };
}

// ============================ 四、核对（纯函数，IO 由调用方注入） ============================

/**
 * 核对登记表与真实仓库是否一致。
 *
 * 【为什么 IO 要注入】本模块要能在门禁里对**真实文件**核对，也要能在单测里
 * 对**假想仓库**核对（比如造一个"标 implemented 但文件不存在"的登记项，
 * 验证判据真的会红）。把 `fs.existsSync` 写死进来，第二种就测不了了。
 *
 * @param {object} opts
 * @param {(rel:string)=>boolean} opts.exists     仓库内相对路径是否存在
 * @param {(name:string)=>boolean} opts.isGuarded  该门禁是否在测试链里（chain.txt / package.json）
 * @param {Array} [opts.assets]                    默认用本模块的 ASSETS（单测可注入假表）
 * @returns {{ok:boolean, issues:Array, notices:Array}}
 */
function auditRegistry(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const exists = typeof o.exists === 'function' ? o.exists : () => false;
  const isGuarded = typeof o.isGuarded === 'function' ? o.isGuarded : () => false;
  const list = Array.isArray(o.assets) ? o.assets : ASSETS;

  const issues = [];
  const notices = [];
  const add = (assetId, code, message) => issues.push({ assetId, code, message, severity: 'error' });
  const note = (assetId, code, message) => notices.push({ assetId, code, message, severity: 'notice' });

  const seen = {};
  for (const a of list) {
    const id = String(a.id || '');
    if (!id) { add('', 'no-id', '登记项缺 id'); continue; }
    if (seen[id]) add(id, 'dup-id', 'id 重复（同一份资产登记了两次）');
    seen[id] = true;

    const st = String(a.status || '');
    const statusOk = Object.keys(ASSET_STATUS).some((k) => ASSET_STATUS[k] === st);
    if (!statusOk) {
      add(id, 'bad-status', '状态「' + st + '」不在四档之内（不许自创状态，那会让统计失真）');
      continue;
    }

    const carriers = Array.isArray(a.carriers) ? a.carriers.filter(Boolean) : [];
    const guards = Array.isArray(a.guards) ? a.guards.filter(Boolean) : [];

    // ── 1. 承载文件必须真实存在 ──
    for (const c of carriers) {
      if (!exists(c)) add(id, 'carrier-missing', '登记的承载文件不存在：' + c);
    }

    // ── 2. 状态与实际情况必须自洽（**双向**，这是本表的核心价值）──
    if (st === ASSET_STATUS.IMPLEMENTED) {
      if (!carriers.length) add(id, 'impl-no-carrier', '标了已落地却没有承载文件');
      if (!guards.length) add(id, 'impl-no-guard', '标了已落地却没有守护门禁 —— '
        + '"定稿"必须有人守着，否则下次改坏没人知道');
      for (const g of guards) {
        if (!isGuarded(g)) add(id, 'guard-not-in-chain', '守护门禁不在测试链里：' + g
          + '（写了门禁但没人跑 = 等于没写）');
      }
    }

    if (st === ASSET_STATUS.MISSING) {
      // ★ 反向防漂移：登记成"未落地"，却偷偷有承载文件 ⇒ 做了没登记，本表已过期。
      //   没有这一条，这张表会慢慢烂成"当初的样子"，而代码早就往前走了。
      if (carriers.length) {
        add(id, 'missing-but-has-carrier',
          '标了未落地却登记了承载文件：' + carriers.join(',') + ' ⇒ 要么改状态，要么删掉这行');
      }
      for (const g of guards) {
        if (isGuarded(g)) add(id, 'missing-but-guarded',
          '标了未落地却已有门禁在链里：' + g + ' ⇒ 登记表已过期，请更新状态');
      }
    }

    if (st === ASSET_STATUS.ENGINE_ONLY || st === ASSET_STATUS.PARTIAL) {
      if (!carriers.length) add(id, 'partial-no-carrier', '标了「仅引擎/部分落地」却没有任何承载文件');
      if (!String(a.gap || '').trim()) {
        add(id, 'partial-no-gap', '标了「仅引擎/部分落地」却没写 gap —— '
          + '不写缺什么，这个状态就变成了永久免责声明');
      }
      // 有 gate 但不在链里 → 只提醒：partial 项的门禁可以只是相关性门禁，不一定是它的专属守卫
      for (const g of guards) {
        if (!isGuarded(g)) note(id, 'guard-not-in-chain', '登记的门禁不在链里：' + g);
      }
    }

    // ── 3. 索引里写的东西必须被如实记录 ──
    if (!String(a.pasteAt || '').trim()) {
      add(id, 'no-paste-at', '没记「粘贴位置」—— 而这正是缺口最容易藏身的地方（本产品多数没有这个槽位）');
    }
    if (!String(a.name || '').trim()) add(id, 'no-name', '没记名字');
  }

  return { ok: issues.length === 0, issues, notices };
}

module.exports = {
  ASSET_STATUS,
  STATUS_LABEL,
  ASSET_GROUPS,
  ASSETS,
  getAsset,
  listByStatus,
  summarise,
  auditRegistry,
};
