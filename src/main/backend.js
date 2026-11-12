const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
// 2026-10-23 起用于「进度账本」的证据指纹（验收动作的命令+入参+结果、产物内容）。
// 为什么必须用真 hash 而不是 `s.length`：判重是为了区分"重复操作"与"新证据"，
// 长度相同内容不同的是**新证据**，被判成重复就等于又造一个假的"没进展"。
const crypto = require('crypto');
// 子进程字节 → 文本的唯一真源（stderr 允许 GBK 回退，stdout→JSON 一律严格 utf-8，见该文件头部）
const { decodeOutput } = require('./childOutput');
const { scanSkills, runSkill, setConnectorManager } = require('./skills');
// 任务事件缓冲（断线不杀任务 + 重连补发，见该文件头部说明）
const taskStream = require('./taskStream');
// 文案合规预检（口腔医疗广告红线，纯本地规则，见该文件头部说明）
const compliance = require('./compliance');

// ══【任务类型工作流 · 2026-10-23】══════════════════════════════════════════════════
// 老板第六节原话：「关键是让 backend.js 真正执行它，而不是把它作为另一个提示词塞给模型。」
// 所以下面这些 require 是**执行依赖**，不是文案依赖：
//   workflowRunner 提供「识别任务类型 / 按证据推进阶段 / 对真文件逐项验收」四件事；
//   具体工作流的**标准本身**由 `./workflows` 注册表内部加载，本文件不再直接 require 任何具体工作流
//   （理由见下面 `const workflows = require('./workflows');` 那段：顶层一旦出现具体工作流的名字，
//     「换一套工作流只要注册」就变成假话）。
// 三个调用点（本文件内以「任务类型工作流」为标记）：
//   ① 任务开始：按用户原话判定走哪套 + 用真实证据推完 brief/outline/asset_inventory；
//   ② 产物落地：出现 .pptx 才允许标 build（没有真文件就永远到不了验收）；
//   ③ 收尾终审：evaluate 逐项跑真检查，结论**直接压到终态**（验收没过不许判 COMPLETE）。
// 非 PPT 任务 ⇒ 注册表选中 lifecycle:'none' 的兜底（general-v1）⇒ startWorkflowRun 返回 null
//   ⇒ 三处调用点全是 no-op，行为与修前逐字一致（判据仍是"是不是 PPT"，只是判据搬进了注册表：
//     本文件已经**不调用** detectWorkflow 了，要查"为什么这个任务没走工作流"请查
//     workflows/index.js 的 selectWorkflow + 各注册项的 match）。
const workflowRunner = require('./workflowRunner');
// 跨请求状态：只承载完成度，不写 tasks.json / task_end
const workflowState = require('./workflowState');
// 产物保管库：内容寻址的**只读副本** + 审计。它回答的问题与 taskTrace 不同 ——
// taskTrace 记「发生了什么」，custody 回答「这一版还能不能拿回来」。两者互不替代：
// 有台账不等于有原件（台账里写了一路径，文件本身可能已经被覆写掉了）。
const artifactCustody = require('./artifactCustody');
// 复杂应用的真实运行验收与同项目持续交付账：都只消费客观工具结果/真实文件元数据。
const { expectsRuntime, createRuntimeEvidence } = require('./runtimeEvidence');
const { createProjectLedger, projectPrompt, ambiguityPrompt, artifactsOf } = require('./projectLedger');
// 工作流注册表：**「这次该走哪套任务工作流」的唯一选择入口**（今天注册 pptx-v1 + general-v1 兜底）。
// 改造前这里是「顶层 require 某一个专用工作流配置」并把它当成全产品唯一的那套标准 ——
// 等于"豆芽只认识 PPT 这一种任务"。现在 `startWorkflowRun` 只问注册表一句"这次该走哪套"，
// 识别与选择职责回到 `src/main/workflows/index.js`（见那边的两条纪律：它只回答工作流选择，
// **不做**回答/方案/执行的行为模式分类 —— 那个在 intentGate.classifyIntent）。
const workflows = require('./workflows');
// snapshot() 注入实验（2026-10-27 解冻）：默认关，`DOUYA_SNAP_INJECT=1` 才生效。
// 把 `wfCtl.snapshot()` 的账本事实作为一条 system 消息交给模型（此前它只进 console 与 trace，
// 从没进过模型上下文）。开关关闭时本文件行为与改造前逐字一致 —— 未注入对照组不需要第二份代码。
// 纪律见 `./workflowSnapshotPrompt` 头注：只写事实、不写判决、不写推测、不参与任何判据。
const workflowSnapshotPrompt = require('./workflowSnapshotPrompt');
// 工作流配置一律由注册表给出（见 src/main/workflows/index.js），本文件不再直接 require 任何具体工作流。
// ★ 这条纪律要守住的地方不只是"加载哪套"（那是注册表），也包括**任何**从具体工作流里取常量的写法：
//   一旦这里重新 require 某个工作流模块去读它的 requiredChecks / stages，顶层就又出现了具体工作流的名字，
//   「换一套工作流只要注册」这句话立刻变成假的。需要标准 → 问控制器（`wfCtl.checks()`），
//   控制器没有 → 就是没有标准（走 no-checks-lenient），不许从别处借一份来冒充。
// 验收证据的**唯一**判据（「这条检查算不算证据」）。独立模块，纯函数，零 fs。
// 为什么单独成模块：这个判据已经错过两次（先是"任意 shell 命令算进度"，再是"命令+结果指纹"），
// 每次都是把「证据的身份」绑在了会被随手改写的命令文本上。判据必须能被单独钉住、单独变异。
const { gradeVerifyEvidence } = require('./evidenceQuality');

// 统一工具调用协议：参数解析 / 失败分类 / 重试账本 / 收尾前验证（纯函数，见该文件头部说明）
const {
  KIND,
  classifyToolFailure,
  // 失败「归属侧」判据（2026-10-22，老板第 3 条建议）：模型侧失败 / 工具侧失败分开处置。
  failureSide,
  // 「判了失败的结果，文本自己也得认得出是失败」（2026-10-22）：governToolResult 的失败出口必须过它，
  // 否则拼上处方后开头变成「【工具调用失败」，调用点再一判就成了"成功"。
  ensureFailureHead,
  normalizeToolArgs,
  createRetryLedger,
  recoveryDirective,
  verifyDeliverables,
  verificationDirective,
  honestStatusReport,
  createToolBreaker,
  breakerDirective,
  buildDeliveryGap,
  // ===== 恢复执行器（2026-10-05）：契约③/②的执法入口 =====
  createRecoveryExecutor,
  recoveryEvidenceGate,
  // ★ 2026-10-23：跨请求失败账本要写「下一条路该怎么走」，而"哪条路"的单一真源在这里。
  //   不许在 backend 里再养一张 kind→动作 的映射表 —— 两套表迟早漂移，
  //   而漂移的症状是"拦住它了、但给的下一步和失败类型对不上"，这种错没人会归因到表不同步上。
  recoveryStrategyFor,
  RECOVERY_ACTION_LABEL,
  // ★ 2026-02-16：跨请求「证伪」的**判定点**（老板原话：refuted 要记证据、适用范围/代码版本）。
  //   为什么判定点不写在下面那个 noteAttempt 块里：`governToolResult` 是 runAgentLoop 的内部闭包，
  //   依赖 Electron 运行时，单测里整装启动不了 ⇒ "够不够判证伪"这一半就永远钉不住。
  //   判定留在这个纯函数里（可单独跑、可单独变异），这里只负责把它产出的 one 原样交给 workflowState 落账。
  refuteDecision,
  // 成功出口要"按策略签名解除证伪"，签名口径必须与失败时**同一个**函数，否则两边永远对不上。
  toolCallSignature,
  // 交接单正文要按失败类型说人话（"环境跑不起来"而不是"environment_error"）——同一份词表，不另抄。
  kindLabel,
} = require('./toolProtocol');

// 交接单（2026-11-03）：续跑/换人时，"上任试过什么、为什么失败、哪些不许再用"压成一页纸。
// 为什么是独立模块而不是塞进 toolProtocol：它只做分拣与措辞，判定全部由调用方给；
// 反过来 import toolProtocol 会成环（熔断处要用它），Node 循环 require 会让一方拿到半截 exports。
// ⚠️ 这里记一次**同一处连错两次**，不藏：
//   第一次只写了 `buildHandoffFromSeeded`，注入处却调用 `handoffBriefText` —— 函数不存在。
//   第二次在 handoffBrief.js 里补了函数、`node --check` 也过，**却忘了加进这个解构** ——
//   于是还是 ReferenceError。`node --check` 抓不到（只是引用不是语法错），
//   完整链里的 `unit-no-undef` K3 抓到了（src/main/backend.js:5941 handoffBriefText）。
//   教训：改完要看**调用点所在文件**能不能真的拿到它，只验模块自己导出是不够的。
const { buildHandoffFromSeeded, handoffBriefText } = require('./handoffBrief');
// ★★ 2026-11-09【通用任务的跨请求失败账本】—— 「重做还犯一模一样的错」缺的那一半。
//   机制（`toolLedger.seed()` / `handoffBrief` / `recoveryExecutor`）**本来就在**，
//   问题只在数据源：唯一的数据源是 `wfCtl.attempts()`，而 `wfCtl` 只在命中工作流时存在。
//   ⇒ 修 bug / 改界面 / 重做一版这类通用任务，预热恒为 0 条，三道执法闸都以为"这是第一次用这个办法"。
//   本模块只补数据源，不新造判据、不新造文案（纪律：优先复用而非自研）。详见 repeatLedger.js 头注。
const repeatLedgerMod = require('./repeatLedger');
// 授权闸的**判定**（纯函数，唯一一处）。抽出来的理由见 decide.js 头注：
// 判据原本在 HTTP 路由闭包里，闭包单测启动不了 ⇒ "什么情况下该拦"永远没人监督。
// 本文件不依赖 electron，所以这里可以直接 require（gate 实例本身才是懒加载的）。
const { decideBlocked } = require('./license/decide');
// 第二执行实例（2026-02-16）：「卡住时换人干」里的**那个人**。
// 交接单解决了"接手的人看到什么"，但**人还是同一个**（同一个执行实例、同一个上下文里的同一次运行）。
// 本模块给的是第二个执行实例的**决策与材料**：换 taskId / 换模型（拿得到的话）/ 缩小工具集 /
// 只带交接单的全新上下文 / 假 res 出口。判定全在 `planDelegation` 这个纯函数里 ⇒ 门禁能单独跑。
// 纪律见模块头：拿不到第二模型时**允许跑但必须标注 `same-model-degraded`**，不许假装独立。
const {
  DELEGATE_MODE, DELEGATE_TASK_SUFFIX, DELEGATE_SUMMARY_MAX,
  planDelegation, createDelegateSink, delegateModeLabel, buildDelegateHandoff,
  normalizeDelegateDepth,
  // 交接单要说清"哪条路你手里没有"⇒ 必须先算一遍替补会拿到哪些工具（与 planDelegation 同源同参）。
  pickDelegateTools,
  // ★ 2026-02-16【替补接手要带走的四类事实】—— 上一版一条都没传，替补只知道"前任失败过什么"，
  //   不知道"还剩什么没做完 / 最初要做什么 / 做到什么算完 / 在哪个目录动手、那里已有什么"。
  //   ★★ 2026-11-04 返工：取数与变换**收进一个纯函数** `buildDelegatePacket`，本文件只注入来源。
  //      上一版这三段散在本文件里，门禁只能 grep 源码字面量 —— 独立验收插一句 `= []` 或整行删掉，
  //      功能已死而门禁 326/0 全绿。现在门禁可以**真跑**这个纯函数并用变异体逐字段打红。
  //   另外 `handoffSectionsOf` 只给 trace 出"哪几段真的产出了"的布尔读数。
  buildDelegatePacket, handoffSectionsOf,
} = require('./secondRunner');
// 设计模具库（2026-11-03）：把"要好看"落成可照抄的数值规格 + 多个结构不同的版面骨架。
const designMolds = require('./designMolds');

// 显式输出上限。★ 为什么必须显式给：实测**不给 max_tokens 时上游默认只给 8192 个输出 token**，
// 而 tool_call 的 arguments（例如一份完整 HTML 的 content）很容易超过它 ⇒ 参数被**截断在半截 JSON 上**
// ⇒ 旧代码 catch 后静默清空参数 ⇒ 技能只能报「请提供目标文件路径」（表象）⇒ 模型坚信自己给了参数、
//   原样重试 ⇒ 每一轮都在同一处被截断 ⇒ 任务卡死。
// 实测：同一任务给 32768 后 2/2 完整生成（completion_tokens=10679 > 8192，证明 8192 是默认值而非模型上限）。
// 若上游拒绝这个值，下面的 400 自愈会去掉它重试 —— 绝不会因为这一行把整轮请求打成 400。
const MAX_OUTPUT_TOKENS = Number(process.env.DOUYA_MAX_OUTPUT_TOKENS) > 0
  ? Number(process.env.DOUYA_MAX_OUTPUT_TOKENS)
  : 32768;

// ===== 「值得想多久」的档位 =====
// ★ 为什么不是"六档任选"：实测（2026-09-23，同一道多步难题 × 每档 3 次，max_tokens=32768，全部 finish_reason=stop）：
//     none   = 0     reasoning tokens
//     low    ≈ 7811  （区间 6856~8567，极差 1711）
//     medium ≈ 9488  （区间 8873~10590，极差 1717）
//     high   ≈ 10142 （区间 10037~10304，极差 267）
//     xhigh  ≈ 9245  （区间 9166~9382，极差 216）
//   读法：① low 与 high 的**区间不重叠** ⇒ 这两档真的能区分；
//        ② medium 与 high 区间重叠、xhigh 反而**比 high 少** ⇒ 高两档不可靠区分，且**不是单调递增**；
//        ③ 简单题上四档全部只剩 40~55 tokens（模型自己就不肯多想）⇒ 档位差异只在难题上显现。
//   ⇒ 本网关实际只有「关 / 省 / 足」三层可用，「六档精细调度」是**假精度**。
// ★ 诚实边界：上面只证明**消耗**有差别，**没证明 low 的答案质量够用**（探针答不了这个）。
//   所以默认仍是 'high'（现役行为零变化），把 low 做成环境变量旋钮，让真实任务去回答探针答不了的那个问题。
// ⚠️ 与 thinking 契约的关系：档位只影响"想多久"，不影响"有没有 reasoning_content"；
//    契约要求工具轮的 reasoning_content 原样回传，所以**仍必须第 0 轮锁定**，中途不许切换（见 wantThink 守卫）。
const ALLOWED_REASONING_EFFORT = ['low', 'medium', 'high'];
const REASONING_EFFORT = ALLOWED_REASONING_EFFORT.includes(process.env.DOUYA_REASONING_EFFORT)
  ? process.env.DOUYA_REASONING_EFFORT
  : 'high';

const { ConnectorManager } = require('./connectors');
const { getExpert, getExperts } = require('./experts');
const { volcanoRecognizeREST } = require('./stt_volcano');
const { DOUYA_PERSONA_PROMPT, buildCallNamePrompt } = require('./douyaPersona');
// 《结果交付与决策协作核心规范》里**可机械判定**的那部分（终点状态 / 半成品话术拦截 / 决策与阻塞报告）。
// 与人设层是一对：人设负责「劝」模型，这里负责「拦」模型 —— 只改一处等于没改。
const {
  TERMINAL,
  STATE,
  classifyTerminalState,
  terminalLabel,
  terminalStatement,
  detectBailOut,
  isLegitimateBlocked,
  bailOutDirective,
  // 【第四档终态 · 诊断可复现的机械判据】2026-02-16
  // `classifyBlockedDiagnosis` 回答一个问题：「这次 BLOCKED 给出的复现步骤，真的被跑过吗？」
  //   判据只认**本任务的执行记录**（同一条命令 ≥2 次、次次失败、输出一致），不认正文自述
  //   （"我已复现"这种话任何文本正则都拦不住 —— 所以判据不在文字里，见 deliveryProtocol §三·补）。
  // ★ 为什么必须在 backend 侧解构进来：在没有这一行之前，`BLOCKED_WITH_DIAGNOSIS` 是全仓
  //   **零产出**的死词表值 —— 词表加了、报告渲染加了、统计口径加了，但生产侧没人赋值它，
  //   于是"报 BLOCKED 且诊断可复现 ⇒ 算一次有效交付"这条口径在运行时根本不成立。
  // ★ 判据本体**只许有一份**（deliveryProtocol 里那份）。在这里复制一遍判定逻辑就会出现
  //   "门禁验的是 copy、跑的是另一份" —— 本仓反复踩过的坑，故这里只解构、不重写。
  classifyBlockedDiagnosis,
  // 证伪闸门（2026-09-23，人设「二十一：先证伪自己的第一判断」）：
  //   人设那条此前**只是文字**，零运行时强制 —— 模型把没验证过的归因说成结论，没人拦。
  //   下面两个函数被真的调用且**进了判定分支**（不是只放进给用户看的文案里）。
  detectCausalClaim,
  missingFalsificationParts,
  falsificationDirective,
  classifyVerificationFailure,
  verificationVerdictText,
  finalReport,
  nextState,
  // 2026-09-22 接线（老板提案第 2、3 条）：正文声称「已完成」与终态判定必须交叉核对。
  //   这是"信号读到"与"信号进控制逻辑"的区别 —— claimsCompletion 早就实现了，
  //   但 backend 一次都没调用过，等于没有。
  claimsCompletion,
  // 失败账本（2026-09-22）：销账 + 未闭环清单。完成门禁的直接输入，不是给人看的日志。
  recordStep,
  unresolvedSteps,
  // ★ 2026-02-16【交接单「还没做完的事」】：取数走 `openFailures()`（= `unresolvedSteps`，判据只一份），
  //   人话形态由 `secondRunner.delegateStepLines` 转 —— **不用** `summarizeSteps`：它会顺手截到 8 条，
  //   在上游先截断会让 `handoffBrief` 的「另有 N 条未展开」永远不触发
  //   （12 条静默变 8 条、再被渲染上限切到 6 条，一句话都不说）。条数上限只在 `UNFINISHED_MAX` 一处管。
  // ★ 2026-11-02：销账粒度从「技能名」改成「同一个目标」之后，**必须有人把目标带出来**。
  //   没有这一行，recordStep 的 target 永远为空 ⇒ 生产上只走保守兜底 ⇒ 用户报的
  //   「复查完了就没有后续了……不能闭环就根本不能用」原样还在（纯函数验得再严也没用）。
  deriveStepTarget,
  // ★ 2026-11-02③【成果卡去重】同一文件被写两次时，卡上会出现两张一样的卡。
  //   归一键与去重实现都放在 deliveryProtocol（纯函数，门禁 unit-artifact-card-dedupe 直接调真身）。
  dedupeArtifacts,
  artifactPathKey,
  // 结论证据与反证门（2026-09-24）：只回答「这条结论能不能成立」，**不产出任务终态**。
  //   它是给上面那条链**加的一层**（在 adjudicateTerminal 之前证明"我准备声称的事情是真的"），
  //   不是第四套状态机：终态词表仍是 TERMINAL，唯一入口仍是 adjudicateTerminal。
  //   下面两个符号被真的调用，且 verifyCompletionClaims 的结果**进了降级判定分支**。
  verifyCompletionClaims,
  claimGapStatement,
  // 真交付物判据（2026-10-21）：过程脚本（check_/gen_/serve_/cp_/patch_ 前缀，或 .js/.py/.ts/.css
  // 这类脚本类扩展名且用户这轮没要脚本）**不算**成果。它同时供三处口径使用：
  //   ① trackDeliverable 入账过滤（卡里不再堆 js）；
  //   ② 成果卡下发兜底（过滤后为空则退回原数组）；
  //   ③ deliverableClaimed / 成功收尾文案（有没有真东西，不看条目数）。
  // 判据本体在 deliveryProtocol 里，这里只调用 —— 不许在 backend 里再养一份平行规则。
  isRealArtifact,
} = require('./deliveryProtocol');
// 任务意图闸门（2026-09-23）：在**工具执行之前**判定「用户这一轮到底是要答案/诊断/方案，还是要动手」。
// 人设只能劝模型别乱执行，这里负责真的拦下来 —— 两类错误（识别错任务类型 vs 回答得蹩脚）
// 里，前者是执行策略救不回来的，所以必须由运行时兜底。
const {
  MODE: INTENT_MODE,
  MODE_LABEL: INTENT_MODE_LABEL,
  classifyIntent,
  isSkillAllowed,
  isExecutionAuthorized,
  gateDirective,
  lastRealUserText,
  // 短追问判据（2026-10-21）：「好了吗 / 什么时候好 / 继续 / 怎么样了」这类 ≤20 字的追问
  // 不是新的任务意图，而是**上一个任务的催促**。它逐字判定（长句一律 false），
  // 配合下面的 FOLLOW_UP_GRACE_MS 时间窗，才允许继承上一轮的执行授权。
  isShortFollowUp,
  FOLLOW_UP_GRACE_MS,
  // 只读技能清单（2026-10-21）：验收闸判断「有没有真的动过手」时要排除它们。
  // ★ 必须复用这一份，不许在 backend 里再养一份平行名单 —— 两套名单迟早漂移，
  //   而漂移的症状是"某个只读工具突然被当成生产动作、每次用都触发 2 次 AI 审查"，
  //   这种性能退化没人会归因到名单不同步上。
  READONLY_SKILLS,
  // ★ 2026-11-06【意图的唯一取值点】：本文件不再自己 `clip(lastUserText, 300)` 造一份
  //   只给验收看的"目标"。执行侧（项目账 origin）与验收侧从此读同一个函数的结果，
  //   见 intentGate.resolveTaskGoal 头注里那张两侧断点的对照表。
  TASK_GOAL_MAX_CHARS,
  resolveTaskGoal,
  // ★★ 2026-11-11【新建交付物授权门】：与 isExecutionAuthorized **不是一回事**，别互相替换。
  //   `isExecutionAuthorized` 管"这一轮能不能动手"（宽，含 default-execute 兜底档）；
  //   `isDeliveryAuthorized` 管"能不能凭这一轮造一个新文件"（严，只认有证据的授权）。
  //   事故来源：用户只回了一句"第一个是皇空8"，模型就凭 default-execute 造了个 7.6KB 交付物。
  isDeliveryAuthorized,
  planAuthGate,
  // ★★ 2026-11-11 夜：产出类技能的**唯一真源**从 intentGate 引入，本文件不再自己养字面量。
  //   原来这里有一份手写的 `PRODUCER_SKILLS`（成果卡登记表），授权门在 intentGate 里另有判据；
  //   两份迟早漂移，而漂移的症状是「门悄悄漏掉一个技能」—— 不报错、不告警，事故复盘时才发现。
  //   现在必须同名 import：成果卡点得开 ⇔ 归授权门管，两件事永远同步。
  PRODUCER_SKILLS,
  isProducerSkill,
} = require('./intentGate');
// ★★ 2026-11-11 夜【产出技能的落点解析】：15 个产出技能的路径字段形态各不相同，
//   统一由这个模块翻译成「会写到哪个绝对路径 / 该路径上是否已有文件」。
//   装在独立文件里的理由见该模块头注 —— 核心是**让门禁能直接调用它**（闭包里够不着）。
const { producerTarget } = require('./producerTarget');
// ★★ 2026-11-11【产物正文事实门】：判「**写出去的文件里**说了什么」，与聊天回复的措辞纪律分开。
//   0.21.31 事故的第二个漏洞就在这里：人设 §八 只管回复，模型在文件正文里把 9 条猜测写成「已核对」，
//   收尾门禁一个字都查不出来 —— 因为它从头到尾只读"它说了什么"，不读"它写出去的文件里说了什么"。
const { planContentClaimGate } = require('./contentClaimGuard');
// 真实联网检索 provider（tavily / bocha 链式降级）。抽成独立模块以便纯 node 单测注入假 fetch。
const { runWebSearch, describeProviders } = require('./webSearchProviders');
// 危险操作门控（G3）：按**命令形态**判定危险动作（递归放开权限 / 递归强删 / 改验收脚本 /
// 丢失未提交改动 / 删库）。纯函数、零 fs —— 判定与文案都在 riskGate.js，本文件只负责"拦"这个动作。
const { classifyRisk, isGateEnabled } = require('./riskGate');
// ★ 2026-11-09：「这一轮该不该打扰用户」的**唯一判据**（三档 SILENT/QUEUE/CONFIRM）。
//   改前是一个全局布尔 `unattended` —— 它对**所有任务**生效，于是复杂任务不问就开做、
//   需要授权时又静默跳过。现在 unattended 只影响 QUEUE 档（做+进待批队列），
//   命中不可逆类别时判定照旧是 CONFIRM（decide 里 hard 分支排在 explicitNoAsk 之前）。
const { decideForTask, createPendingQueue, TIER } = require('./gateTier');
// ★ 2026-11-09：进程级事实的单一真源（超时被杀 / 用户叫停 / 被外部信号杀 / 没起来）。
//   只被三处 catch 用来给 argsInfo 挂 `failure`，再原样传给 classifyToolFailure。
const procEvidence = require('./procEvidence');
// 看图（图像识别）provider：把图片编码成 dataURL 发多模态模型拿画面描述。抽成独立模块以便纯 node 单测。
const { describeImage, readImageAsDataUrl } = require('./visionProvider');
// 2026-10-18 第十六轮：Agent 双 AI 自检 + 复检 + 对话汇报（老板第 6 条）。
// 只对「工作」分区（payload.scope === 'work'）生效；普通对话不走这套流程。
const { AGENT_REVIEW_MAX_ROUNDS, shouldReviewTask, buildTraceReport, selfCheckTask, auditTask, buildAuditReport, reviewVerdict, reviewVerdictStatement } = require('./agentReview');
// 执行记录（trace）：旁路 JSONL，按 taskId 切分。2026-10-22 加。
// ★ 它解决的问题是「失败的真因在十几步之前，但事后什么都查不到」：
//   审计读数 —— 本文件 116 个 catch、0 个 rethrow、58 处失败后无信号；每次 LLM 调用的完整输入输出
//   只活在 conversation 局部变量里；每次工具调用的**参数**磁盘上零记录；8 条决策类日志全锁在
//   默认关闭的 DOUYA_DEBUG_* 后面。⇒ 默认运行时，一次失败任务事后能查到的信息 ≈ 0。
// ★ 纪律：trace 只记事实、不改变控制流、不抛（旁路）。判断仍归 toolProtocol/deliveryProtocol/agentReview，
//   在这里再判一次就是养第二套规则（本仓库反复踩过这个坑）。
const taskTrace = require('./taskTrace');
// 执行单元记账（阶段 2 · 卡 S2-5）：主循环里 11 个**可命名**执行单元的开始/结束。词汇与配对器在
// `loopUnitKinds.js`（那里的头注写了为什么它与会话域零交集），本文件只负责在真实现场上 begin/end ——
// 「未闭合能被点名」「因果只能来自 begin 的 seq」这些判据留在那个模块里，不在本文件再写一遍。
const loopUnitKinds = require('./loopUnitKinds');
// 运行底座 P1（阶段 1 边界）：可替换的 AgentLoop。纯 CJS，不依赖 Electron 运行时。
// ★ `runAgentLoop` 本体一个字节不改：这里只加一层包壳。函数声明有 hoist，所以模块级
//   这句能直接拿到 4772 行那个函数的引用；调用点（:2990）改走 `agentRuntime.run(request)`，
//   返回值暂不消费 ⇒ 阶段 1 零行为变化。细节与「将来接 Harness 怎么改」见 agentRuntime.js 头注。
const { createAgentRuntime } = require('./agentRuntime');
const agentRuntime = createAgentRuntime({ impl: runAgentLoop, name: 'legacy' });
// 技能「渐进披露」（2026-02-16）：47 个技能的 schema 全量 50,341 字节 / 约 11,900 tokens，
// 而 turn 循环**每轮原样重发**；11 个真实任务 160 轮 trace 里只调用了 11 个技能（149 次），
// 36 个技能从未被调用，核心 8 个覆盖 142/149 = 95.3% 的调用。
// ⇒ 默认只发「核心 8 个 + 元工具」，其余 39 个由 `find_skills` 按需披露（下一轮生效）。
// ★ 逻辑全在 lazyTools.js（纯函数）。本文件只做接线：本文件**不改判据**，
//   免得"哪些算核心、怎么匹配"变成两处各说一套（本仓库反复踩过：`\bslide\b`、W3c 那次）。
// ★ 2026-11-11 起**默认开启**（此前是"默认关闭"）。改的是出厂值，不是判据：
//     判据仍是 lazyTools.isLazyEnabled 的严格布尔（`=== true` 且未 noMetaTools）；
//     生产者是本文件 `handleChat` 里的 `lazyTools.resolveLazySwitch(payload, cfg)`，
//     优先级 = 请求体显式 > config.json > 环境变量/出厂值（DOUYA_LAZY_TOOLS=0 可关）。
//   ⚠️ 为什么原注释那句"默认关闭 ⇒ 行为一字不变"必须改掉：它记录的是**改前**的事实。
//     那一句之所以危险，是因为它恰好掩盖了真问题 —— 判据要求 `lazyTools === true`，
//     而全仓没有生产者 ⇒ 恒 undefined ⇒ "默认关闭"实际是"永远不会开"，
//     分层逻辑写完几个月一次都没执行过。留着这句等于留着"我们以为它在跑"的错觉。
//     门禁 scripts/smoke/unit-lazy-wiring.mjs 的 C 组专门钉"生产者存在且被调用"。
const lazyTools = require('./lazyTools');
// 长期记忆注入（A 阶段 #245）：把四层档案摘要成一段 system 文本，让豆芽「记得你是谁」。
// ★ 只注入、绝不写入 —— 写路径在 memoryStore，且必须经过 Secret 门 + Reconciler。
//   本模块即使被绕过也不可能污染档案（它 require 的 memoryStore 只用到读函数）。
const { injectUserMemory } = require('./memorySummary');
// 长期记忆**写入链路**（B 阶段 #252）：把「A 阶段造好却零引用」的四个模块真正接上。
//
// ★ 为什么必须接（否则 A 阶段的成果是空的）：
//   实测（2026-10-05）：memoryExtractor / memoryReconciler / memorySidePath /
//   memoryStore.commit 在 src/ 下**一个调用方都没有** ⇒ 档案永远是空的
//   ⇒ 注入侧再正确，注入的也是"什么都没有"。这正是仓库红线「写了 ≠ 接线」的复现。
//
// ★ 三条不可动摇的性质（与注入侧同构，见 memorySidePath.js 文件头）：
//   ① 走 memorySidePath 旁路：1.5s 硬超时 + 异常吞噬 + 结果隔离 ⇒ 记忆失败绝不让任务失败。
//   ② 抽取器无写权限：它只产出 candidates，能不能写由旁路编排器决定（结构边界，不是命名）。
//   ③ 开关只关抽取、**不关 Secret 门**（设计稿第 537 行：Secret 拦截是产品级硬规则）。
const { runMemorySidePath, memoryAffectsTaskOutcome, describeMemoryOutcome, MEMORY_STATUS } = require('./memorySidePath');
const { extractFromMessages, dedupeCandidates } = require('./memoryExtractor');
const { reconcile, toCommitChanges } = require('./memoryReconciler');
const memoryStore = require('./memoryStore');
// ★ 2026-11-06 账号维度的产物隔离（老板：「生图 生视频 要隔离 不要别的账号生的
//   豆芽另一个账号也能看到」）。主进程的 `/api/auth/login` 与 `/api/auth/profile`
//   都由本文件处理上游转发 —— 于是**主进程自己就能拿到账号**，不需要渲染层自报
//   （自报的话，渲染层一句谎话就能把产物写进别人的目录）。
//   这里只做两件事：把账号记进 `<dataDir>/current-account.json`，并通知主进程刷新产物目录。
const accountScope = require('./accountScope');

const PORT = Number(process.env.BACKEND_PORT) || 10119;

// ===========================================================================
// 本机回环安全闸（P0 · 2026-11-04）
// ===========================================================================
// 为什么要有（要钉住的缺陷）：`POST /api/skills/:id/run` 是**任务循环之外**的执行入口 ——
// 它不经过 runAgentLoop，因此不经过循环里那两道闸（riskGate 的 block 判定 / needsUserConfirm）。
// 而它原来对**任何**本机进程、以及**任何**网页都开着：本文件所有响应都无条件带
// `Access-Control-Allow-Origin: *`，预检还回 `Allow-Headers: *` ⇒ 一个远程网页只要 blind POST
// （`Content-Type: text/plain` 连预检都不触发）就能让本机跑任意技能，读不到响应并不影响副作用已发生。
//
// 三道独立闸，**任何一道不过都拒绝**（fail-closed）：
//   ① Origin 闸：请求若带 Origin，必须在下表白名单里；不在 ⇒ 403 且**一个 CORS 头都不给**。
//      注意 Origin 只对**浏览器**有约束力（非浏览器可任意伪造）⇒ 它挡的是网页，不是本机进程。
//   ② 能力令牌闸（仅 `/api/skills/:id/run`）：必须带 `X-Douya-Skill-Token`，值与
//      `dataDir/skill-run.token` 一致。网页读不到本机文件 ⇒ 这条才是真正挡住「任意网页」的那道。
//   ③ 危险操作闸（仅 `/api/skills/:id/run`）：命中 riskGate 的 block 档直接 403，**不进审批**
//      （本入口没有任务上下文，也没有审批生命周期，给不出"用户点了同意"这件事）。
//
// 诚实边界（不许当成 OS 隔离，也不许写成「挡住了所有网页」）：
//   · 本闸覆盖的是**跨域网页请求**：带 Origin 且不在白名单 ⇒ 403；不带 Origin 但
//     `sec-fetch-site: cross-site`（= `file://` 页面，见 isOriginlessCrossSiteBrowserRequest）⇒ 403。
//     打包态已实测生效（真 Electron 31.7.7 + app:// scheme 注册，`app://douya` 页面发跨源请求，
//     服务端收到的 origin 头逐字是 `app://douya`；同一测量里不设 ACAO 时页面侧 fetch 被拦成
//     TypeError: Failed to fetch，给 `*` 或回显都能读到 200 ⇒ 回显不是空转）。
//   · **不在覆盖范围内**：非浏览器进程（主进程 fetch / curl / 同机脚本）—— 它们不带 Origin、
//     也不带 `sec-fetch-site`，本闸对它们放行；能读 dataDir 的进程本来就能拿到能力令牌。
//     威胁模型是「跨源网页 / 远程站点 / 跨源脚本」，不是「同机恶意进程」。
//   · 白名单**不放** `null`：实测 `data:` 页面的 Origin 就是字符串 `null`，放进去等于对所有
//     `data:` / `srcdoc` / sandbox iframe 开门。
const APP_ORIGIN = 'app://douya';
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/** 这个 Origin 是不是「应用自己 / 本机回环页面」。空 Origin 一律 false。 */
function isTrustedLocalOrigin(origin) {
  if (!origin) return false;
  const o = String(origin).trim();
  if (o === APP_ORIGIN) return true;
  return LOOPBACK_ORIGIN_RE.test(o);
}

/**
 * 「浏览器发起的跨源请求，但没带 Origin」—— 只有 `file://` 页面会这样。
 *
 * 为什么必须单独识别（2026-11-04 实测，不是推测）：浏览器的**跨源**请求按 Fetch 规范
 * 一定带 `Origin`，唯一的例外是 `file://` 页面（Chromium 支持 `file://` fetch 但按
 * "opaque origin" 处理，不发 Origin 头，也不做 CORS 检查 ⇒ 能直接读到响应体）。
 *
 * 于是「没有 Origin ⇒ 放行」这条分支会被它整个绕过。而这条分支**又不能删**：
 * 仓内 20+ 个 unit-*.mjs 门禁全部用 Node 原生 `fetch` 打真后端，undici **不发 Origin**，
 * 删掉就把整条单测链打红。
 *
 * ★ 区分二者的头是 `sec-fetch-site`，而且**只能用它**：
 *     浏览器（含 file://）：`sec-fetch-site: cross-site` + `sec-fetch-mode: cors`
 *     Node 原生 fetch    ：`sec-fetch-site` **缺失** + `sec-fetch-mode: cors`
 *   ⇒ 用「有没有 sec-fetch-*」判会误杀 Node fetch；只用 `sec-fetch-site === 'cross-site'`
 *     才能既堵 file:// 又不伤门禁。
 *
 * ⚠️ 边界（不要写成更强的表述）：`same-origin` / `none` / 缺失一律放行 ——
 *   同源请求本来就不带 Origin，把它拦掉是错的；`none` 是用户发起（地址栏 / net.fetch）。
 */
function isOriginlessCrossSiteBrowserRequest(req) {
  if (req.headers.origin) return false;
  return String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site';
}

/**
 * 给响应加 CORS 头，并给出这次调用该不该继续。
 *
 * 四种情况：
 *   · 完全没有 Origin 头，且不是 `file://` 页面的跨源请求 ⇒ 不是浏览器的 CORS 请求
 *     （主进程 fetch / curl / 单测）：放行，**不发 CORS 头**。
 *     （★ 原来的代码在这里发 `*`，等于给所有网页发通行证；现在不发。）
 *   · 完全没有 Origin 头，但 `sec-fetch-site: cross-site` ⇒ **不放行**（`file://` 页面）。
 *     放过去等于本闸对本地 html 全开：它能打 `POST /api/config`（写盘密钥）、
 *     `POST /api/read-files`（按绝对路径读文件）、`POST /api/exec`（替用户点同意）。
 *   · Origin 在白名单 ⇒ 回显该 Origin + `Vary: Origin`（**绝不回 `*`**）。
 *   · Origin 不在白名单 ⇒ 不放行。⚠️ 只"不给头"不够：blind POST 的副作用不需要读响应也会发生，
 *     所以调用方必须**直接 403 拒绝请求本身**。
 */
function applyLocalCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    // file:// 页面：浏览器跨源请求却不带 Origin。放过去等于本闸对本地 html 全开。
    if (isOriginlessCrossSiteBrowserRequest(req)) {
      return { ok: false, cors: false, why: 'originless-cross-site' };
    }
    return { ok: true, cors: false };
  }
  if (!isTrustedLocalOrigin(origin)) return { ok: false, cors: false, why: 'origin-not-allowed' };
  res.setHeader('Access-Control-Allow-Origin', String(origin));
  res.setHeader('Vary', 'Origin');
  return { ok: true, cors: true };
}

// ── 能力令牌（仅 `/api/skills/:id/run`）───────────────────────────────────
// 来源优先级：环境变量 `DOUYA_SKILL_RUN_TOKEN` > `dataDir/skill-run.token`（存在则复用）> 新生成。
// 为什么复用而不是每次重启换新：外部集成把令牌配在配置里，一重启就失效等于逼它去读文件，
// 反而更脆。它落在用户的 dataDir 里，本机进程本来就能读 —— 换新并不能挡住本机进程。
let skillRunToken = null;

function initSkillRunToken(dataDir) {
  const fromEnv = String(process.env.DOUYA_SKILL_RUN_TOKEN || '').trim();
  if (fromEnv) { skillRunToken = fromEnv; return; }
  const p = path.join(dataDir, 'skill-run.token');
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t.length >= 32) { skillRunToken = t; return; }
  } catch { /* 首次启动：没有这个文件，正常 */ }
  const t = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(p, t, { mode: 0o600 });
  } catch { /* 落盘失败也要能跑：令牌留在内存，本次启动内有效 */ }
  skillRunToken = t;
}

/** 定长时间比较：避免用 `===` 比较令牌时的前缀泄露时序。长度不同直接 false。 */
function timingSafeEqualStr(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  if (!A.length || A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

// ===== 公关危机：本地爬虫（百度 site: 定向检索）=====
// 背景：豆芽工作台 /api/crisis/scan 实测无数据（total_found:0），故本地直连百度做
// 「品牌词 + 平台」定向抓取，作为 LLM 联网检索（主数据源）的补充证据。
// 百度有反爬：命中安全验证/验证码页或超时即标记 blocked，由前端降级到联网检索，不做验证码破解。
const PLATFORM_SOURCES = {
  xiaohongshu: { label: '小红书', domain: 'xiaohongshu.com' },
  tieba: { label: '百度贴吧', domain: 'tieba.baidu.com' },
  weibo: { label: '微博', domain: 'weibo.com' },
  weixin: { label: '微信公众号', domain: 'mp.weixin.qq.com' },
  zhihu: { label: '知乎', domain: 'zhihu.com' },
  douyin: { label: '抖音', domain: 'douyin.com' },
};

/** 负面词库：标题/摘要命中任一词即判为「疑似负面」。 */
const NEG_WORDS = [
  '投诉', '差评', '维权', '曝光', '欺骗', '骗', '虚假', '退款',
  '乱象', '违法', '立案', '处罚', '坑', '不满意', '举报', '黑名单', '欺诈', '纠纷',
];

/** 浏览器 UA 轮换池（每次请求随机取一个，降低被识别为爬虫的概率）。 */
const CRAWLER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];
/** 微信公众号专用 UA（微信内置浏览器）。 */
const WEIXIN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/7.0.15(0x17000f27)NetType/WIFI Language/zh_CN';

/** brand -> 上次扫描时间戳：同一品牌 30s 内不重复打百度（防反爬封禁）。 */
const crisisScanThrottle = new Map();
const CRISIS_THROTTLE_MS = 30000;

// ⑦ 流式「空闲」超时：上游在流中途卡死时 reader.read() 会永久 pending，而心跳（约 6s/次）仍在发
// ⇒ UI 永远显示「正在深度思考…」，永不超时（最恶劣的「永久假活」）。这里给「流式读取本身」加空闲超时：
// 超过 N 毫秒没有收到任何新 chunk 即视为上游卡死。**空闲语义**（每收到一个 chunk 就重置计时器），
// **不是整体时长上限** —— 正常的长生成可能远超 N 秒，绝不能误杀。
// 超时值可由 DOUYA_STREAM_IDLE_MS 注入（供单测，不必真等 120s）。
const STREAM_IDLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.DOUYA_STREAM_IDLE_MS);
  return v > 0 ? v : 120000;
})();

// ===== 工作流 Agent：阶段化 + 素材索要 + 确认门 =====
const pendingActions = new Map();   // actionId -> { resolve, timer }
const pendingMaterials = new Map(); // materialId -> { resolve, timer }
const pendingClarify = new Map();   // clarifyId -> { resolve, timer }
const pendingPlanAck = new Map();   // planAckId -> { resolve, timer }
const pendingPickFiles = new Map();  // pickFilesId -> { resolve, timer }
// 跨轮授权记账（2026-10-21）：owner -> 上次判过 EXECUTE 的时间戳。
// 只服务「短追问沿用授权」这一条，且受 FOLLOW_UP_GRACE_MS（30 分钟）限时 —— 不是永久授权。
// 为什么需要它：用户追问「好了吗」时该轮意图被判成 QUESTION（疑问句），于是 shell-exec 被拦，
//   agent 起不了本地服务去验证成品，只能回「还没好」——**越催越没权限把活干完**。
// 时间窗是第二道闸：上周让你部署过，今天再问「好了吗」不可能命中（间隔远超 30 分钟）。
const lastExecGrantedAt = new Map();
// 【2026-10-21 修】授权记账的 owner key：必须**命名空间化**，不能直接把 username 当 key。
//
// 修之前是 `String((payload && payload.username) || '')` 直接当 Map key，两个后果：
//   ① 空串是一个**有效 key**，于是「没有身份」和「身份恰好是空串」在 Map 里不可区分 ——
//      所有未登录会话挤进同一个桶。甲未登录时判过 EXECUTE，乙在同一进程里接着问「好了吗」
//      会继承到甲的授权（单机桌面端同一时刻通常只有一个人，所以后果不严重，但这是
//      「判据看不出差别」的典型：真出问题时没有任何读数能提示）。
//   ② username 前后带空格（`' 张三 '` 与 `'张三'`）会是两个桶 —— 该继承的继承不到。
//
// 修法**不是**「拿不到身份就拒绝继承」。这一点很关键，别好心改错：
//   `payload.username` 来自渲染层 `localStorage['douya-auth-user']`（api.js:142-149），
//   **未登录时就是空串**，而 backend.js:845 的注释写明「未登录 / 断网 / 退出应用」都是正常
//   使用状态。若在这里 fail-closed（空身份一律不继承），刚修好的「追问沿用授权」对未登录
//   用户会整体失效 —— 那正好复现本次要解决的「越催越没权限干活」。
//
// 所以用两个互不相交的前缀把命名空间分开：具名账号一律 `u:` 开头，匿名固定 `anon`。
//   · 任何真实 username 都落在 `u:` 里，永远撞不到 `anon`；
//   · 匿名桶仍然存在（未登录用户照样能继承），但它**不再与任何具名账号共享**。
function ownerKeyOf(payload) {
  const u = String((payload && payload.username) || '').trim();
  return u ? ('u:' + u) : 'anon';
}
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
// 元工具：让模型结构化地"先规划"和"向用户索要素材"（不依赖 skills 目录）
const META_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'workflow_plan',
      // ★ 2026-10-16 补尾句「调用后立即开始执行，不要停下来等用户确认计划。」
      //   为什么要补：「动手前先给出…」这句原本是配合旧版人设「先讲清楚让用户确认」的，
      //   人设现已改成「说完就做、不要等确认」，而工具描述在模型眼里的**即时影响力高于** system prompt
      //   的长期劝告 —— 留着旧口吻，模型会把 workflow_plan 当成一个"法定的停靠点"：
      //   亮完计划就停住，等用户说「开始吧」，于是又变成一轮"用户不答就不干活"。
      description: '动手前先给出本次任务的执行计划：要建哪些文件、各自功能、需要什么素材。调用一次即可，便于用户看到进度与范围。调用后立即开始执行，不要停下来等用户确认计划。',
      parameters: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' }, description: '计划步骤的简短列表' } },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_material',
      // ★ 2026-10-16 重写（老板原话「反复追问、用户不答就不干活」的**最大单点风险**就在这一行）。
      //   旧描述：'若完成任务需要用户提供素材（图片、数据、API 凭证、参考文件等），调用此工具向用户索要；
      //            会暂停并等待用户提交内容后继续。'
      //   三处致命问题，叠在一起就是一台"合法打断机"：
      //     ① 触发条件宽：「需要用户提供素材」几乎任何任务都能套上（缺个图标、缺份数据、缺张图）；
      //     ② **零克制语**：同文件 clarify_requirements 有一整段「技术路线不属于需求无法判断，由你自己定下来
      //        直接做」的克制语，request_material 一句都没有 ⇒ 模型没有任何"应该自己解决"的指令；
      //     ③ 明说「会暂停并等待」：等于告诉模型"这是个可以停下来的合法动作"，
      //        而工具描述对模型的即时影响力**高于** system prompt 的长期劝告。
      //   新描述只保留一个窄触发条件（凭据类 / 私有物），并把"能自己搞定的必须自己搞定"写成硬规矩。
      //   ⚠️ required 与 parameters 结构一个字都没动，只改 description 字符串；保持单行拼接，不引入换行符。
      description: '只有当「完成任务确实需要一份你拿不到的东西」时才调用本工具向用户索要；会暂停并等待用户提交内容后继续。'
        + '能自己找到的（联网搜索 / 项目里已有的文件 / 企业知识 / 上下文里已经给过的）和能自己推断的（文件命名、格式、目录结构、默认值、示例图、占位数据、测试用假数据），一律自己解决，不要索要 —— 每索要一次就打断用户一次。'
        + '真正必须由用户提供的只有「凭据类 / 私有物」：账号、API 密钥、登录凭证、只有他手上才有的原始素材（自家产品照、内部数据表、营业执照等）。'
        + '一次只要一样最关键的东西，一次问清；能用占位物先做下去的，先用占位物做，把「哪里需要你替换」写进收尾，不要因此停工。'
        + '同一个任务里不要连续索要超过一次；第二次想调用前，先回头确认能不能自己推断。',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string', description: '向用户说明需要什么素材' } },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clarify_requirements',
      description: '仅当需求真的无法判断（语音同音/谐音歧义、目标完全不明、关键参数缺失）时才调用本工具，用"选择题"方式向用户确认一次（1-3 个题，每题 2-4 个备选项）。会暂停等待用户选择后继续。全程最多确认 1 轮，绝不做二次确认；需求基本明确就直接开始动手，不要问。**注意：技术路线 / 实现方案的选择（例如"用子域名还是子路径"、"放根目录还是子目录"、"用 A 方案还是 B 方案"、"用哪个端口"、"目录 / 路径叫什么名字"）不属于"需求无法判断"，这类问题由你自己按"最省用户操作、风险我能兜底"的原则定下来直接做，不要拿来问用户。**',
      parameters: {
        type: 'object',
        properties: {
          context: { type: 'string', description: '一句话说明当前在澄清什么' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                q: { type: 'string', description: '问题（用自然语言，像同事请教，例如"你说的桌宠是指桌面宠物，还是桌边摆件？"）' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '2-4 个备选项。若来自语音/可能有谐音，请同时列出你理解的说法和常见同音字/谐音候选，让用户一键选择',
                },
                allowFree: { type: 'boolean', description: '是否允许用户额外自由输入（默认 false，尽量用选择题）' },
              },
              required: ['q', 'options'],
            },
            description: '澄清问题列表（1-3 个），每个题带备选项',
          },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pick_local_files',
      description: '当需要读取用户电脑上的本地文件（文档/表格/图片/代码等），而用户还没有主动上传时，调用此工具让用户从文件选择框里挑选文件；会暂停等待用户选择，选完自动把文件内容读进来供你继续。可同时选择多个文件。',
      parameters: {
        type: 'object',
        properties: {
          hint: { type: 'string', description: '一句话告诉用户你想让他挑什么文件（例如「请选一下你桌面上的那份报价单」）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_skills',
      // ★★ 2026-02-16【技能渐进披露】这是 39 个"非核心技能"的唯一入口。
      //
      //   为什么要它：47 个技能的 schema 表每轮重发要 ≈11,900 tokens，而实测 149 次调用里
      //   只有 11 个技能被用过（36 个从没被调用）。核心 8 个覆盖 95.3% ⇒ 其余 39 个改成
      //   「查了才给」。它们并没有消失：查到之后**下一轮**就变成可直接调用的工具。
      //
      //   这段描述里有三条是**承重的**，删任一条都会让模型退化成"反复查一下有什么"：
      //     ①「查到之后会在下一轮变成可直接调用的工具」—— 不说这句，模型会以为查到之后
      //        还得再调一次（或以为根本调不了，于是放弃）⇒ 一次任务白烧 2 轮；
      //     ②「不传参数 ⇒ 返回全部清单」—— 这是它一次拿到全貌的路径，不说就只剩逐词试；
      //     ③「不要为了看一下有什么反复调用」—— 每次调用都会改下一轮的工具表，
      //        反复调用等于反复 churn 上下文（这也是它被并行门控禁掉的原因，见 planParallel）。
      //   ⚠️ 描述与 parameters 保持单行拼接（不用模板字符串/换行），与同数组其它条目一致。
      description: '需要用到「核心工具之外」的技能时调用。'
        + '你默认只看到文件读写检索、命令执行、图片识别这几类基础技能；另外还有约 39 个专用技能'
        + '（做演示文稿、打包 exe、部署站点、查数据库、生成脑图、裁剪抠图等…）。'
        + '不传任何参数 ⇒ 返回全部技能的一句话清单；传 query ⇒ 只返回匹配的几条（命中的前 3 个自动披露）。'
        + '**查到的会在下一轮变成可直接调用的工具**，不需要再次调用本工具；不要为了"看一下有什么"反复调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想做什么，用几个关键词描述，例如 "做PPT" / "打包 exe" / "部署"（不传 ⇒ 返回全部清单）' },
          enable: { type: 'string', description: '逗号分隔的技能 id；给了就把这些直接披露出来（用于你已经知道 id 的情况）' },
        },
        required: [],
      },
    },
  },
];
// 元工具名集合（第四层并行门控用）：这些工具都要 `await wait*` 并改前端单值 state，与并行天然互斥。
// 由 META_TOOLS 派生，避免两处各写一份名单而漂移。
//
// ★ 2026-02-16 `find_skills` 加进 META_TOOLS 后，它**自动**流进这个集合 —— 两处派生结果都核对过、都是对的：
//   · `:planParallel` 的 `meta-tool` 分支会禁止它并行：它要改**下一轮**的工具表，
//     与"本轮多条并行"天然互斥（并行组里披露几个技能，下一轮的表就说不清是谁拉的）⇒ 禁止是对的；
//   · `pickDelegateTools` / `planDelegation` 会把它剔出第二实例：替补那侧没有用户在回答提问，
//     也没有人在它需要时帮它查技能；而且 `lazyTools.isLazyEnabled` 见到 `noMetaTools` 会整体关掉分层
//     ⇒ 替补拿全量表、不会残废（这条是承重的，别把 isLazyEnabled 里那一行删掉）。
const META_TOOL_NAMES = new Set(
  META_TOOLS.map((t) => (t && t.function && t.function.name) || '').filter(Boolean)
);

/**
 * 本轮工具调用里有多少次是「**真的动手做事**」（会改环境 / 产出东西）。
 *
 * 2026-10-21 新增，只服务一件事：验收闸（自检员 + 复检员）该不该启动。
 * 为什么不直接用「动过工具」（didToolCall）：只读工具也会把它置位。拿它当判据 ⇒
 * 用户随口问「这个文件里写了什么」也会多跑 2 次 LLM 调用，体感是"每句话都变慢"。
 *
 * ⚠️ 命名有两套，必须都认：`READONLY_SKILLS`（intentGate）用**连字符**
 * （`file-read` / `web-fetch`），而本文件下面的 `PHASE_OF` 用的是**下划线**
 * （`file_read` / `file_write`）。这两套在仓库里同时存在，只认其中一套就会把
 * 只读工具误算成生产动作 —— 症状是"读个文件也触发 AI 审查"，没人会归因到命名不一致。
 * 所以这里把下划线归一成连字符再查。
 *
 * @param {Array} toolCalls OpenAI 格式的 tool_calls 数组
 * @returns {number} 生产性调用次数
 */
function countProductive(toolCalls) {
  const norm = (s) => String(s || '').replace(/_/g, '-');
  let n = 0;
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = (tc && tc.function && tc.function.name) || '';
    if (!name) continue;
    if (META_TOOL_NAMES.has(name)) continue;
    if (READONLY_SKILLS.has(name) || READONLY_SKILLS.has(norm(name))) continue;
    n += 1;
  }
  return n;
}
// 工具名 -> 工作流阶段
const PHASE_OF = {
  workflow_plan: { phase: 'planning', label: '规划任务', progress: 12 },
  request_plan_ack: { phase: 'planning', label: '规划任务', progress: 12 },
  clarify_requirements: { phase: 'clarifying', label: '对齐需求', progress: 18 },
  file_list: { phase: 'locating', label: '定位工作区', progress: 30 },
  file_read: { phase: 'locating', label: '读取文件', progress: 30 },
  request_material: { phase: 'gathering', label: '索要素材', progress: 50 },
  file_write: { phase: 'building', label: '生成文件', progress: 70 },
  shell_exec: { phase: 'verifying', label: '运行验证', progress: 88 },
};
// 每个产出技能的具体动作标签（让用户在"执行中"时知道到底在干什么，而不是一句笼统的"执行中"）
const SKILL_ACTION = {
  // 2026-10-11：演示文稿**默认**走网页版（slides-generate，可截图自检、可发链接）；
  // ppt-generate 退为「明确要 .pptx 文件」时的备选。
  'slides-generate': '正在生成演示文稿',
  'ppt-generate': '正在生成 PPT 文件',
  'excel-generate': '正在生成 Excel 表格',
  'docx-generate': '正在生成 Word 文档',
  'pdf-generate': '正在生成 PDF',
  'chart-generate': '正在画图表',
  'data-analyze': '正在分析数据',
  'image-ocr': '正在识别图片文字',
  'image-edit': '正在处理图片',
  'image-info': '正在读取图片信息',
  'image-compress': '正在压缩图片',
  'gif-make': '正在合成动画',
  'video-make': '正在生成视频',
  'media-edit': '正在处理音视频',
  'project-scaffold': '正在搭建项目文件',
  'miniprogram-scaffold': '正在生成小程序',
  'web-fetch': '正在联网抓取网页',
  'doc-read': '正在读取文档',
  'file-write': '正在写文件',
  'file-read': '正在读文件',
  'file-list': '正在列目录',
  'file-search': '正在搜索文件',
  'file-rename': '正在批量重命名',
  'zip-pack': '正在压缩打包',
  'shop-search': '正在查询商品',
  'shop-order': '正在加入购物车',
  'ssh-exec': '正在连接服务器',
  'wechat-api': '正在调用微信接口',
};
function phaseOfTool(name) {
  if (PHASE_OF[name]) return PHASE_OF[name];
  if (name && name.indexOf('file-write') === 0) return PHASE_OF.file_write;
  if (name && name.indexOf('file-list') === 0) return PHASE_OF.file_list;
  if (name && name.indexOf('shell-exec') === 0) return PHASE_OF.shell_exec;
  if (name && name.indexOf('request_material') === 0) return PHASE_OF.request_material;
  if (name && name.indexOf('workflow_plan') === 0) return PHASE_OF.workflow_plan;
  return { phase: 'building', label: '执行中', progress: 70 };
}
function skillAction(name) {
  return SKILL_ACTION[name] || null;
}

// 分阶段温度：思考/规划阶段用中温让 reasoning 更充分展开，生成/收尾阶段中温
function tempForPhase(phase) {
  return 0.5; // 统一中温，让每一步的思考更完整（低温会让 reasoning 挤牙膏）
}

// 需用户确认的危险操作：这些技能会连外部服务器、改动远端环境，执行前必须让用户看到参数并确认。
//   · ssh-exec     —— 连服务器执行任意命令 / 上传文件（高风险，且 params 含明文密码）
//   · deploy-static / deploy-node —— 部署上线，改动线上环境
//   · db-query     —— 只读数据库查询，但**参数里带数据库密码、且能整库导出** ⇒ 属于必须用户拍板的能力
// 说明：file-write / shell-exec 仍走普通技能分支直接执行（本地工作区操作，牵动面大，保持原行为不动）。
// 命中一个当前不存在的技能名（如部署技能目录尚未就绪）没有副作用：叫这个名字的工具本来就不会被调用。
// 【0.21.10】工具授权分级 —— 按「可逆性」分档，取代原先「4 个名字平铺」的名单。
//   老板 2026-10-19 拍板：① 只读 / 只在本地产出物 ⇒ 全自动，不打扰；
//   ② 部署上线、发外部消息 ⇒ 第一次确认（同一 host 勾选后本任务内不再问）；
//   ③ 涉及账号 / 密钥 / 付款 / 远端任意命令 ⇒ 每次都确认，且**不给**「不再询问」选项。
//
// 为什么必须分档而不是继续平铺：员工反馈「agent 一跑起来就弹确认，很多人不知道该点哪个」。
// 平铺名单表达不出「哪些可以放心自动、哪些必须每次问」，只能一刀切 —— 要么烦、要么漏。
const AUTH_TIER_AUTO = 'auto';
const AUTH_TIER_CONFIRM = 'confirm';
const AUTH_TIER_ALWAYS = 'always';

/**
 * 名字级档位。**没列在这里的技能一律 auto** —— 44 个技能里绝大多数是只读或本地生成
 * （calculator / file-read / file-list / web-fetch / chart-generate / image-* / docx-* / pdf-* 等）。
 *
 * ⚠️ 兜底方向是「未收录 = 不确认」，所以这张表只放「确实要拦」的；
 *    一旦哪天新增了会写外部世界的技能却忘了登记，它就会被当成 auto 放过去。
 *    这条边界由 `unit-auth-tier` 的负控锁死：测试会遍历 skills/ 目录，
 *    对每个名字断言 authTierOf 的返回值必须等于一张**显式白名单**，多一个少一个都红。
 */
const AUTH_TIER_BY_TOOL = {
  // ② 一次确认：动外部环境，但可撤回 / 可重放
  'deploy-static': AUTH_TIER_CONFIRM,
  'deploy-node': AUTH_TIER_CONFIRM,
  'wechat-api': AUTH_TIER_CONFIRM,
  'shop-order': AUTH_TIER_CONFIRM,
  'mmm-shop-order': AUTH_TIER_CONFIRM,
  // ②-b 一次确认：**把活交给另一个 agent**（2026-11-11 加入，agent-delegate）
  //
  //     为什么它不在上面 ② 组的原义里：② 组的判据是「动外部环境，但可撤回 / 可重放」，
  //     而这条两头都不成立 —— 所以单列，别混进 ② 组把那条注释读成废话。
  //
  //     判定依据是**读它的真实副作用**，不是"听着像 AI 干活所以危险"：
  //       · 它自己一句都不写盘 —— `grep -c 'fs.writeFile|fs.mkdir|fs.unlink|fs.rm|copyFile'
  //         skills/agent-delegate/run.js` = **0**。真正改盘的是它起的**第二个 agent**
  //         （dshClient.createDshClient → cli.prompt，ACP over stdio）。
  //       · 出不去工作区 —— run.js:151 `cwd === WORKSPACE || cwd.startsWith(WORKSPACE + sep)`，
  //         越界直接返回错误。所以它不是「动外部环境」，② 组那条「部署上线 / 发外部消息」
  //         的动机在这儿不成立（也就没有"发布到哪台生产机"这种不可逆的外部后果）。
  //       · 但它改的是工作区里**任意**文件，而且是 manifest 自己写明的自主循环：
  //         「需要反复『改-跑-看错-再改』的调试」⇒ 同一个 task 跑两次结果不同，**不可重放**；
  //         这份源码副本 yet 没有 .git（`test -d .git` 失败）⇒ **不可撤回**。
  //       · 且是一次大额额度消耗：manifest `timeoutMs: 900000`（15 分钟）、
  //         默认 `model: deepseek-v4-pro`、默认 `effort: high`。
  //
  //     为什么是 confirm 而不是 auto —— 两边的失效代价**不对称**：
  //       · 误判 auto：一个不受用户控制的 agent 在工作区里改了 N 个文件，用户全程不知情，
  //         事后也没法撤回（无 VCS、无自动快照）。这是「事情已经发生了」级别的坏。
  //       · 误判 confirm：用户多点一次「确定」。这是「烦一下」级别的坏。
  //     可逆性优先 ⇒ 选代价不对称里便宜的那一侧。
  //
  //     为什么是 confirm 而不是 always：always 的字面含义是「每次都问、且不给『不再询问』」，
  //     它服务的是「账号 / 密钥 / 付款 / 远端任意命令」这类每次目标都可能换的东西。
  //     而委派的目标目录在一个任务里是稳定的，反复往同一个目录委派是正常用法 ——
  //     应该允许「同一目标勾选后本任务内不再问」，那正是 confirm 档的能力。
  'agent-delegate': AUTH_TIER_CONFIRM,
  // ③ 永远确认：明文密码 / 数据库密码 / 远端任意命令
  'ssh-exec': AUTH_TIER_ALWAYS,
  'db-query': AUTH_TIER_ALWAYS,
};

/**
 * 一技多能的技能按 action 细分 —— 同一个技能里 `list` 是只读、`delete` 是删数据。
 * 用名字级一刀切只有两个结果：要么把只读操作也拦下来（烦），要么把删除放过去（危险）。
 * 名字命中本表时，**action 级优先于名字级**。
 */
const AUTH_TIER_BY_ACTION = {
  'geo-company-register': {
    list: AUTH_TIER_AUTO, get: AUTH_TIER_AUTO,
    create: AUTH_TIER_CONFIRM, update: AUTH_TIER_CONFIRM,
    delete: AUTH_TIER_ALWAYS,
  },
  'geo-account-detect': {
    detect: AUTH_TIER_AUTO, list: AUTH_TIER_AUTO,
    scrape: AUTH_TIER_CONFIRM,
  },
  'wechat-api': {
    code2session: AUTH_TIER_AUTO, get_access_token: AUTH_TIER_AUTO,
    send_subscribe_message: AUTH_TIER_CONFIRM,
  },
};

/**
 * 解析这次调用该走哪一档。
 * @param {string} name 技能名
 * @param {object} [params] 调用参数（一技多能时据 action 细分）
 * @returns {'auto'|'confirm'|'always'}
 */
function authTierOf(name, params) {
  const byAction = AUTH_TIER_BY_ACTION[name];
  if (byAction) {
    const act = String((params && (params.action || params.type)) || '').trim().toLowerCase();
    if (act && byAction[act]) return byAction[act];
    // action 缺失或没登记：走该技能**最高**档 —— 不确定就问，绝不放行。
    const tiers = Object.values(byAction);
    if (tiers.includes(AUTH_TIER_ALWAYS)) return AUTH_TIER_ALWAYS;
    if (tiers.includes(AUTH_TIER_CONFIRM)) return AUTH_TIER_CONFIRM;
    return AUTH_TIER_AUTO;
  }
  return AUTH_TIER_BY_TOOL[name] || AUTH_TIER_AUTO;
}

/** 这次调用要不要弹确认（confirm 与 always 都弹，区别只在「能不能记住」）。 */
function needsUserConfirm(name, params) {
  return authTierOf(name, params) !== AUTH_TIER_AUTO;
}

/** always 档：每次都问，且不提供「不再询问」（否则「每次确认」形同虚设）。 */
function isAlwaysConfirm(name, params) {
  return authTierOf(name, params) === AUTH_TIER_ALWAYS;
}

/**
 * 需要用户确认的技能名集合（confirm ∪ always）。
 * 用途：① 前端 / 定时任务提示「这些技能不适合无人值守调度」；② 并行编排门控（命中则强制串行）。
 *
 * ⚠️ 它只是**名字级**的粗粒度视图。真正执行时一律走 needsUserConfirm(name, params)，
 *    因为 geo-company-register 的 list 不该弹、delete 必须弹，光看名字分不出来。
 */
const CONFIRM_TOOLS = new Set([
  ...Object.keys(AUTH_TIER_BY_TOOL).filter((n) => AUTH_TIER_BY_TOOL[n] !== AUTH_TIER_AUTO),
  ...Object.keys(AUTH_TIER_BY_ACTION),
]);

// 脱敏预览参数时使用的固定占位串（与真实值长度无关，避免通过长度泄漏信息）。
const MASKED_SECRET = '••••••';
// 键名命中即视为「凭据」：password / passwd / pwd / secret / token（大小写无关）。
const SECRET_KEY_RE = /pass|pwd|secret|token/i;
// 少量不含上述关键词、但语义上明确是凭据的精确键名（统一按小写比较）。
// `*_content` / `*_data` 一类是模型可能自行臆造、用来直接塞私钥正文的键名（不含 pass/pwd/secret/token，
// 漏掉就会把私钥明文印在确认弹窗上、可被截图）；技能的正式参数只有 `key_path`（路径，走下面豁免原样展示），
// 所以这里遮住「正文类」键名不会误伤任何合法用法。
const SECRET_KEY_EXACT = new Set([
  'apikey', 'api_key', 'private_key', 'access_key',
  'key_content', 'key_data', 'key_body', 'private_key_content', 'private_key_data',
  'ssh_key', 'ssh_private_key', 'id_rsa',
]);
// 豁免：以 _path / _file 结尾的键指向的是**文件路径**而非密钥内容，应原样展示给用户（脱敏反而看不懂要做什么）。
const SECRET_KEY_EXEMPT_RE = /(_path|_file)$/i;

/**
 * 脱敏「确认门」预览参数：把凭据类字段替换为固定占位串，**返回副本，仅供前端展示**。
 *
 * 为什么必须脱敏：ssh-exec 等技能的 params 里含明文 `password`。确认门的 confirm 事件会把
 * params 原样送给渲染进程，前端弹窗（App.jsx）会 `JSON.stringify(params)` 把密码打印出来 ⇒
 * 密码进入 UI 与渲染进程内存/日志，凭空多出一个泄漏面。
 * 为什么不能只在前端脱敏：在后端就换成脱敏副本，可保证密码**根本不进入渲染进程**（少一个泄漏面），
 * 且不依赖前端以后记得脱敏（前端一旦漏做，后端这层仍兜底）。
 *
 * 关键：这里只影响**展示**。真正执行技能时用的仍是**原始 params**（见下方 runSkill(manifest, params, cfg)），
 * 执行链路完全不受影响。
 *
 * 规则：
 *   · 入参非对象 / 为 null → 原样安全返回（不抛）；
 *   · 顶层键名匹配 /pass|pwd|secret|token/i，或精确等于 apikey/api_key/private_key/access_key → 值替换为 '••••••'；
 *   · 以 _path / _file 结尾的键**豁免**（如 key_path 是文件路径，应原样展示）；
 *   · 不改原对象（浅拷贝后逐键处理），嵌套对象不做递归（技能参数为顶层扁平结构）。
 *
 * @param {unknown} params 技能参数（原始对象）
 * @returns {unknown} 脱敏副本；非对象入参原样返回
 */
function maskSecrets(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const out = {};
  for (const key of Object.keys(params)) {
    const kLow = key.toLowerCase();
    const isSecret =
      !SECRET_KEY_EXEMPT_RE.test(key) &&
      (SECRET_KEY_RE.test(key) || SECRET_KEY_EXACT.has(kLow));
    out[key] = isSecret ? MASKED_SECRET : params[key];
  }
  return out;
}

/**
 * 确认门去重键：同一任务内对同一台服务器只问一次。host 缺失（如本地 shell 类技能）返回空串 = 永不去重。
 * 归一化：去空白 + 转小写；带 port 时并入键，避免同一 host 不同端口互相放行。
 *
 * 为什么归一化：模型可能把 host 写成 " 8.149.243.48 " 或 "A.com"，端口可能传数字 22 或字符串 "22"。
 * 若不做归一化，同一台服务器会因大小写/空白差异被当成两台，去重失效（用户仍被反复弹）。
 * 为什么 host 缺失返回空串：本地类技能（无远端主机）没有「服务器」概念，空串在调用处被判定为
 * 「不可去重」，保证这类技能每次照常弹窗，绝不误放行。
 *
 * @param {unknown} params 技能参数（原始对象）
 * @returns {string} 归一化后的服务器键；无 host 时返回 ''
 */
function confirmTargetKey(params) {
  if (!params || typeof params !== 'object') return '';
  const host = String(params.host || '').trim().toLowerCase();
  if (!host) return '';
  const port = String(params.port == null ? '' : params.port).trim();
  return port ? host + ':' + port : host;
}

/**
 * ⑥ 「技能结果是否为失败」的**单一真源**判据（tasks.json 记账 / 成果卡提取 共用）。
 *
 * 为什么必须抽出来：旧判据只认英文小写 `startsWith('error')`，但本项目失败文案是中文/符号
 * （`❌ 部署失败：…`、`错误：请提供 host`、`操作失败：…`）。后果极严重：一次**部署失败**在
 * tasks.json 的 `done[].ok` 里被记成 true → 被 buildTaskStateSummary() 当「已完成步骤」注入下一次
 * 「继续」→ 用户在**错误前提**上往下做；成果卡同理会把失败产物当成果。
 *
 * ★ 必须**锚定开头**（`^\s*`），**绝不用 includes** —— 否则「已完成 3 步，1 个文件失败但已重试成功」
 *   这类**整体成功**的结果会被误判为失败（负样本，防误伤的关键）。
 *
 * 覆盖前缀：英文 `error`/`Error`；中文/符号 `错误`、`❌`、`操作失败`、`部署失败`、`回滚失败`、`搜索失败`、`失败：`/`失败:`。
 *   `搜索失败` 是 web-fetch 的核心失败文案（run.js `return '搜索失败：' + e.message`，搜索链全挂时）：
 *   它开头是「搜」不是「失败」，若不在候选里会被**误判成成功** ⇒ 记错账、履历说「已完成」。
 *   ⚠️ 只收「搜索失败」这一条；「没有找到匹配的文件」（file-search/file-rename）是**正常空结果**，
 *   判成功才对，**不得**加进来。
 *
 * @param {unknown} result 技能返回文本
 * @returns {boolean} true 表示这是一条**失败**结果
 */
const FAILURE_RESULT_RE = /^\s*(?:error\b|Error\b|错误|❌|操作失败|部署失败|回滚失败|搜索失败|失败\s*[：:]|[\u4e00-\u9fa5A-Za-z0-9_ ]{1,12}(?:失败|错误|超时|不存在|无效|不允许|拒绝)(?= *[：:（(，,\n]| *$)|请\s*(?:先|你)?(?:提供|告诉|指定|输入|给出)|请\s*先[^，。\n]{0,12}?(?:连接|配置|设置|登录|授权|绑定))/;
function isFailureResult(result) {
  const s = String(result == null ? '' : result);
  // ★★ 2026-10-22：**空结果判失败**（修 fail-open 的最后一道口子）。
  //   修之前：`FAILURE_RESULT_RE` 是"锚定前缀"结构，空串谁也匹配不上 ⇒ 返回 false ⇒ 判**成功**。
  //   后果（静默、且方向最坏）：技能 stdout 为空（进程被 OOM 杀掉但 exit 0、脚本什么都没输出、
  //   上游返回 204）时，这次调用会被记成"已完成"：doneLog 加一步 ok、成果卡不计、熔断清零。
  //   用户看到的是一串"已完成"，而实际什么也没产出。
  //   为什么方向取"失败"：判失败最多是多报一次（用户看得见、账本可追、会触发重试与文案），
  //   判成功则是把"没有产出"永久写成"有产出"。宁可看得见的失败，不要看不见的成功。
  //   ⚠️ 不改正则本身：`^\s*` 锚定开头是上一条审计结论（防「…失败但已成功」被误判），
  //      改成正则分支会动到那条判据；"空串"是输入侧的边界，就该在入口处判。
  if (!s.trim()) return true;
  return FAILURE_RESULT_RE.test(s);
}

// 工作区根目录（与 file-write 技能保持一致）
const AGENT_WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');
// 这些技能产出的是"非自然语言"的原始回执（目录列表 / 文件内容 / 网页正文 / 命令日志），
// 不应作为大段文本甩给用户，只保留进度提示，让对话始终由模型用自然语言串起来。
const SILENT_TOOLS = new Set(['file-list', 'file-read', 'web-fetch', 'shell-exec']);

/* ═══════════════════════════════════════════════════════════════════════════
 * 产物保管（D 阶段）：接线用的**唯一**入口
 * ═══════════════════════════════════════════════════════════════════════════
 * 目标（老板原话）：「未经授权的覆写不能造成不可逆的成果损失；所有产物变化必须有
 *   可审计记录，原版本能够按需恢复。」custody 模块提供机制，这里负责让它真的被调用 ——
 *   `artifactCustody.js` 的门禁 353/0 但 `require` 命中 0 次，正是"机制做完了、没接上线"。
 *
 * 三个 `by` 值是**固定枚举**，语义必须与调用点匹配：
 *   · `landing-hook`      —— 产物真落地那一刻（file-write / 产出技能返回的路径）
 *   · `conclude-fallback` —— 收尾兜底：清单由磁盘证据补全（模型没报产物，是脚本写的文件）
 *   · `resume-precheck`   —— 续跑核对时，把"接线之前留下的产物"补登记进库
 * 拼错的 `by` **硬拒绝**（连事件都不落）：写错的枚举如果能进库，事后按
 * `by='landing-hook'` 筛出来的就不是"落地那一刻"，而是一条无法归类的记录。
 *
 * ⚠️ 保管范围：**只 `.pptx`**（本轮授权范围就是 PPTX）。
 *   其它产物（.docx/.html/.xlsx）本轮**不保管** —— 这是已知缺口，不是漏写；
 *   写成常量而不是散在各个 if 里，是为了第二阶段要扩的时候只改这一行。
 */
const CUSTODY_PROTECTED_EXT = ['.pptx'];
const CUSTODY_BY = ['landing-hook', 'conclude-fallback', 'resume-precheck'];
/**
 * @param {string} filePath 要保管的文件（绝对路径；相对路径会被 custody 按 not_found 拒）
 * @param {string} by 固定枚举之一，见上
 * @param {string} taskId 任务号，只进 safeCtx（≤64 字符）
 * @return {object|null} custody.keep 的返回值；不保管/被拒时为 null
 */
function custodyKeep(filePath, by, taskId) {
  try {
    if (!CUSTODY_BY.includes(by)) {
      console.error('[custody] 未知的 by=' + String(by) + '（只认 ' + CUSTODY_BY.join('/') + '）⇒ 拒绝保管');
      return null;
    }
    const p = String(filePath || '');
    if (!CUSTODY_PROTECTED_EXT.includes(path.extname(p).toLowerCase())) return null;
    const r = artifactCustody.keep(p, { by: String(by), taskId: String(taskId || '').slice(0, 64) });
    // 失败不许静默：保管失败意味着"这一版拿不回来"，必须留一行可查的痕迹。
    if (!r || !r.ok) {
      console.error('[custody] keep 失败 by=' + by + ' path=' + p + ' reason=' + ((r && r.reason) || 'unknown'));
    }
    return r;
  } catch (e) {
    console.error('[custody] keep 异常 by=' + by + '：' + ((e && e.message) || e));
    return null;
  }
}

// ===== 第四层：受控并行编排的显式常量（白名单 + 并发度）=====
// 受控并行白名单：**仅 web-fetch**。单条 3-12s，一轮两次（先搜关键词再抓正文）是常态，
// 串行 15-60s → 并行 4-15s，是当前收益/风险比最高的一处。
// ⚠️ 刻意不收录 file-read/file-list/image-info：它们本就毫秒-秒级，并行省不下时间却要扩散并发面；
// ⚠️ 更不收录 ssh-exec/deploy-*/db-query（确认门 + 秒级同名临时文件 + nginx conf 互踩 + 共享部署日志抢占）。
const PARALLEL_SAFE_TOOLS = new Set(['web-fetch']);
const PARALLEL_LIMIT = 2; // 并发度上限：web-fetch 走 DDG→Bing 爬虫兜底，3 并发有实测限流风险，2 是收益/稳定性平衡点

// 计划确认门控常量：多步骤纪律（复杂产出任务至少 N 步计划，回补上限 M 次）
const MIN_PLAN_STEPS = 3;
const MAX_PLAN_ACK_TRIES = 2;

// 可直接按文本读取的扩展名（无需走 python 解析）
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.py', '.js', '.jsx', '.ts', '.tsx', '.html', '.htm', '.css', '.scss', '.log', '.xml', '.yml', '.yaml', '.ini', '.conf', '.sh', '.bat', '.sql', '.java', '.go', '.c', '.cpp', '.h', '.rs', '.rb', '.php']);
// 需要 python 解析的 Office/文档扩展名（走 doc-read 技能）
const DOC_EXTS = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.pptx', '.ppt']);
// 图片扩展名（走 visionProvider 做「看图」；视觉失败时降级 image-ocr 读图中文字）
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.tiff', '.tif']);

/**
 * 「错误串 ≠ 正文」判据（**图片分支与文档分支共用**，保证两侧对称）。
 *
 * 背景：技能 run.py 用 `return "错误：…"` 返回失败（**不抛异常**）⇒ 子进程 exit 0 ⇒
 * skills.js 不 reject、`resolve(stdout.trim())` 把**错误串**当结果返回；若不在这一层拦住，
 * 它会被当作正文 push 进 `【文件：name】\n…`（与真实正文同前缀）并注入 prompt。
 *
 * 为什么**锚定全角冒号「：」**：与正文区分。若只写 `/^错误/`，图上/文里恰好写着
 * 「错误码 500 的含义」「不支持退款」这类**真实内容**会被整段误判为失败并丢弃。
 * 各技能实际错误串前缀（已逐行核对，全部带全角冒号）：
 *   skills/doc-read/run.py:65,69,84 → "错误：…"；:90 → "读取失败：…"
 *   skills/image-ocr/run.py:10,14   → "错误：…"；:28 → "识别失败：…"
 */
const ATTACH_ERR_RE = /^(错误：|读取失败：|识别失败：)/;

/**
 * 密钥/凭证类文件名：**绝不读取**。
 * 为什么必须有：`.env` 不在 TEXT_EXTS（backend.js:204），会落到「未知类型 → 按文本读」的
 * 兜底分支，导致 `.env` 明文进 prompt。开发模式的 readFiles 有 dotfile 防护，主对话侧此前没有。
 * @param {string} name 文件名（不含目录）
 * @returns {boolean}
 */
function isSecretFile(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  if (n === '.env' || n.startsWith('.env.')) return true; // .env / .env.local / .env.production …
  if (n === '.npmrc' || n === '.netrc' || n === '.git-credentials') return true;
  if (/\.(pem|key|p12|pfx)$/.test(n)) return true;         // 证书 / 私钥 / 密钥库
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(n)) return true;  // SSH 私钥
  return false;
}

/**
 * 把错误信息压成「安全、可对用户展示」的一行（**绝不许把整段 Python traceback 塞进 prompt**）。
 *   · 含 Python traceback → 只取**末行**（异常本体，如 `ImportError: No module named 'docx'`），
 *     丢弃所有 `File "C:\Users\…"` 帧（含本机用户名与内部绝对路径）；
 *   · 其余 → 取首个非空行；
 *   · 再抹掉残留盘符路径并截断到 max 字符。
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string} 单行、去路径、已截断的错误摘要（无内容时返回空串）
 */
function safeErrText(raw, max = 200) {
  const s = String(raw == null ? '' : raw).replace(/\r/g, '').trim();
  if (!s) return '';
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const isTraceback = /^Traceback \(most recent call last\):/.test(lines[0] || '');
  let pick = isTraceback ? (lines[lines.length - 1] || '') : (lines[0] || '');
  pick = pick.replace(/[A-Za-z]:\\[^\s"']+/g, '<路径>');
  pick = pick.replace(/(?:\/[\w.-]+){2,}/g, '<路径>');
  pick = pick.trim();
  return pick.length > max ? pick.slice(0, max) + '…' : pick;
}

/**
 * 解析**单个**附件为一段可注入 prompt 的文本（第四层从 resolveAttachments 内联循环抽出的纯函数）。
 *
 * 抽出来的唯一目的：让多附件可以**受控并行**（doc-read/视觉/OCR 都是秒级重活，串行会线性变慢）。
 * 本函数无任何共享可变状态，输入相同 ⇒ 输出相同，是并行最安全的一处；
 * 返回 null 表示该附件被跳过（无路径），调用方据此丢弃、不产生任何输出。
 *
 * @param {object} att 附件 {path,name}
 * @param {{docRead:object|undefined, ocr:object|undefined, describe:Function, cfg:object}} ctx
 * @returns {Promise<string|null>} 该附件的可读文本段；null = 跳过
 */
async function resolveOneAttachment(att, ctx) {
  if (!att || !att.path) return null;
  const { docRead, ocr, describe, cfg } = ctx;
  const p = String(att.path);
  const name = att.name || path.basename(p);
  const ext = path.extname(p).toLowerCase();
  // 安全：密钥/凭证类文件绝不读取（否则明文进 prompt，见 isSecretFile 注释）
  if (isSecretFile(name)) {
    return `【文件：${name}】出于安全考虑，豆芽不会读取密钥/凭证类文件（如 .env / *.pem / *.key / id_rsa）。如确需处理，请在对话里手动粘贴其非敏感内容。`;
  }
  try {
    let content = '';
    if (TEXT_EXTS.has(ext)) {
      content = fs.readFileSync(p, 'utf-8');
    } else if (DOC_EXTS.has(ext) && docRead) {
      // 旧版 Office 格式：doc-read/run.py 只支持 .docx/.pdf/.xlsx/.pptx，
      // 把 .xls/.ppt 挡在 runSkill 之前给出**具体**提示，别丢给 runSkill 再靠错误串兜底。
      if (ext === '.xls' || ext === '.ppt') {
        return `【文件：${name}】暂不支持旧版 ${ext} 格式，请在 Office 里另存为 ${ext === '.xls' ? '.xlsx' : '.pptx'} 后重试。`;
      }
      content = await runSkill(docRead, { path: p }, cfg);
      // ★ 错误串 ≠ 正文：doc-read/run.py 自己 except 后 `return "读取失败：" + str(e)`（run.py:90），
      //   进程 exit 0 ⇒ skills.js 不 reject ⇒ 这里 `content` 是**错误串**。若不拦，会被
      //   当作正文 push 进 `【文件：name】\n${content}`（与真实正文同前缀）并注入 prompt。
      const docStr = String(content || '').trim();
      if (ATTACH_ERR_RE.test(docStr)) {
        // 剥掉错误前缀再回显，避免「读取失败：…」这一串以任何形式出现在产出里
        const cause = safeErrText(docStr.replace(ATTACH_ERR_RE, ''), 120);
        return `【文件：${name}】这个文档本次没能读取（原因：文档解析组件不可用或格式不支持${cause ? ' —— ' + cause : ''}）。请如实告知用户「这个文件没能读取」并说明原因，建议改用可直接复制的文本或稍后重试。**不要编造文档内容。**`;
      }
    } else if (DOC_EXTS.has(ext) && !docRead) {
      return `【文件：${name}】无法读取（缺少文档解析组件）`;
    } else if (IMG_EXTS.has(ext)) {
      // 图片：视觉优先（真的「看」画面）→ OCR 兜底（读图中文字）→ 诚实失败（绝不编造）
      let visionText = '';
      let visionErr = '';
      try {
        const enc = readImageAsDataUrl(p);
        if (!enc.ok) visionErr = enc.error;
        else {
          const vr = await describe({ dataUrl: enc.dataUrl, cfg });
          if (vr && vr.ok && vr.text) visionText = vr.text;
          else visionErr = (vr && vr.error) || '未知原因';
        }
      } catch (e) {
        visionErr = e && e.message ? e.message : String(e);
      }

      if (visionText) {
        return `【文件：${name}】（图片｜豆芽已看到画面内容）\n${visionText}`;
      }
      // OCR 兜底：image-ocr 的 run.py 在**顶层** import rapidocr_onnxruntime，
      // 若打包 runtime 缺该依赖，runSkill 会直接 reject（而非返回「（未识别到文字）」）。
      // 因此这里必须自己兜异常，否则会漏到外层 catch 变成「读取失败：…」，
      // 丢掉下面那句更准确的诚实失败文案。
      let ocrText = '';
      let ocrErr = '';
      if (ocr) {
        try {
          ocrText = String((await runSkill(ocr, { path: p }, cfg)) || '').trim();
        } catch (e) {
          const em = (e && e.message) ? e.message : String(e);
          // 只留一行、去掉路径：e.message 可能是整段 Python traceback（含本机用户名+内部绝对路径），
          // 而下面 `原因：…` 会被模型转述给用户 ⇒ 绝不能把整个栈塞进去。
          ocrErr = '文字识别组件不可用：' + safeErrText(em);
        }
      }
      // run.py 内部异常会以「识别失败：…」字符串返回（不 reject），不能当 OCR 正文用。
      // 用与文档分支**同一个** ATTACH_ERR_RE（全角冒号锚定），避免误伤真实识别结果
      // （如图上写着「错误码 500 的含义」不能被当成失败丢掉）。
      const ocrFailed = ATTACH_ERR_RE.test(ocrText);
      if (ocrText && !ocrFailed && ocrText !== '（未识别到文字）') {
        return `【文件：${name}】（图片｜画面内容未能解析，以下为图中文字识别结果）\n${ocrText}`;
      }
      if (ocrFailed) ocrErr = safeErrText(ocrText);
      // 两个失败原因都保留（视觉为什么失败 + OCR 是否可用），便于用户/排障判断
      const reason = [visionErr, ocrErr].filter(Boolean).join('；') || '视觉识别不可用';
      return `【文件：${name}】这张图豆芽这次没能看清（原因：${reason}）。请如实告知用户「这张图我没能看清」并说明原因，请用户重新发一张更清晰的图、或直接用文字描述图里的内容。**绝对不要凭空编造画面内容。**`;
    } else if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
      return `【文件：${name}】暂不支持旧版 ${ext} 格式，请在 Office 里另存为 .docx/.xlsx/.pptx 后重试。`;
    } else {
      // 未知类型：尝试按文本读，失败再报错
      try { content = fs.readFileSync(p, 'utf-8'); }
      catch { return `【文件：${name}】不支持的类型 ${ext || '(无扩展名)'}`; }
    }
    content = String(content || '').trim();
    if (!content) {
      return `【文件：${name}】（文件为空或没有可提取的文字）`;
    }
    const truncated = content.length > 12000 ? content.slice(0, 12000) + '\n…(内容过长已截断，可让我用「读文件」分段细看)' : content;
    return `【文件：${name}】\n${truncated}`;
  } catch (e) {
    // 同样去路径/截断：runSkill reject 时 e.message 可能是整段 Python traceback
    return `【文件：${name}】读取失败：${safeErrText(e && e.message, 200) || '未知原因'}`;
  }
}

/**
 * 把用户上传/选择的本地文件解析成文本，供模型阅读。
 * 文本类直接读；Office/PDF 走 doc-read；图片走「视觉优先 → OCR 兜底 → 诚实失败」。
 * 返回一段拼接好的「文件内容」文本；无附件返回空串。
 *
 * 第四层：内部按 PARALLEL_LIMIT 受控并行（doc-read/视觉/OCR 皆秒级），
 * 结果**按下标回填**后仍按 attachments 原顺序拼接（顺序决定注入 prompt 的文本顺序，必须与输入一致）。
 *
 * @param {Array} attachments 附件数组（每项 {path,name}）
 * @param {Array} skills      已扫描的技能清单
 * @param {object} cfg        配置
 * @param {{describeImage?:Function}} [deps] 可注入依赖（单测缝：注入假的 describeImage）
 */
async function resolveAttachments(attachments, skills, cfg, deps = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  // 兜底反馈：用户明明拖了/选了文件，但一个有效路径都没拿到时，明确提示而不是静默"没收到"
  if (attachments.every((att) => !att || !att.path)) {
    return '【用户试图上传文件，但没拿到有效文件路径，可能是拖拽/选择失败，请提示用户重新拖一次或点📎按钮选择】';
  }
  const docRead = skills.find((s) => s.id === 'doc-read');
  const ocr = skills.find((s) => s.id === 'image-ocr');
  // 视觉识别实现：默认走 visionProvider，单测可注入假实现（不必联网/不必有真网关）
  const describe = deps.describeImage || describeImage;
  const ctx = { docRead, ocr, describe, cfg };
  // 手写 PARALLEL_LIMIT 槽位调度（零依赖）：每槽取下一个下标直到耗尽；结果按下标回填。
  const resolved = new Array(attachments.length).fill(null);
  let nextAtt = 0;
  const attWorker = async () => {
    while (true) {
      const i = nextAtt++;
      if (i >= attachments.length) return;
      try {
        resolved[i] = await resolveOneAttachment(attachments[i], ctx);
      } catch (e) {
        // 单个附件异常绝不能 reject 整组（否则一个坏文件会让全部附件都读不出）
        const a = attachments[i] || {};
        const nm = a.name || a.path || '(未知)';
        resolved[i] = `【文件：${nm}】读取失败：${safeErrText(e && e.message, 200) || '未知原因'}`;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_LIMIT, attachments.length) }, () => attWorker())
  );
  const parts = resolved.filter((s) => typeof s === 'string' && s.length > 0);
  if (parts.length === 0) {
    return '用户上传了 ' + attachments.length + ' 个文件但都没能读取内容，请告知用户具体哪个文件、什么原因（如格式不支持/文件为空）';
  }
  return parts.join('\n\n');
}

// ===== 成果持久化：把每次产出的文件写入 userData/deliverables.json，跨会话可查/可继续改 =====
let delivPath = null; // 在 startBackend 里指向 dataDir/deliverables.json

// ===== token 用量统计：按登录用户累计，写入 dataDir/token-usage.json =====
let usagePath = null; // 在 startBackend 里指向 dataDir/token-usage.json

// ===== 客户端用量自报（2026-09-20）=====
// 桌面端 AI 调用走内网网关（192.168.80.99:10003），公网运营后台看不到，故由客户端主动上报。
// 队列落盘 => 未登录/断网/退出应用都不丢；服务端按 access_token 归属用户（客户端传的 username 不作数）。
let usageQueue = [];        // 待上报事件（[{id,ts,model,pt,ct,src,ver}]）
let usageQueuePath = null;  // 在 startBackend 里指向 dataDir/usage-queue.json
let authTokenPath = null;   // 在 startBackend 里指向 dataDir/auth-token.json
let authTokenCache = '';    // 当前登录态 access_token（仅主进程持有，绝不回传渲染层）
let usageFlushTimer = null; // 待触发的上报定时器
let usageFlushAt = 0;       // 上面那个定时器的计划触发时刻（用于「有更早的就重排」）
let usageFlushing = false;  // 防重入
let usageBackoffUntil = 0;  // 失败退避截止时刻
let _appVersionCache = null;

// ===== 跨请求任务状态：写入 dataDir/tasks.json（按 owner 隔离），让「继续」时模型看得见进度 =====
let tasksPath = null; // 在 startBackend 里指向 dataDir/tasks.json

// ===== 长期记忆写入链路（B 阶段 #252）=====
/** 记忆档案的 dataDir（在 startBackend 里赋值）。为 null 时写入链路整体不跑。 */
let memoryDataDir = null;
/** 「生成对话记忆」开关文件路径（在 startBackend 里赋值）。 */
let desktopSettingsPath = null;
/**
 * 记忆开关缓存：{ at, value }，TTL 2s。
 *
 * ★ 为什么要缓存：本函数在**每轮对话结束**时被调用，而对话轮次是高频的。
 *   每次去 readFileSync + JSON.parse 是没必要的 IO；但**又不能长缓存** ——
 *   用户在设置里关掉开关后，必须很快生效（否则他关了半天豆芽还在记，属于"开关是假的"）。
 *   2s 是"关掉后下一轮就生效"与"不每轮读盘"之间的折中。
 * ⚠️ 读失败一律当**开启**（保守方向见函数注释）。
 */
let memoryEnabledCache = { at: 0, value: true };
const MEMORY_SWITCH_TTL_MS = 2000;

/**
 * 读「生成对话记忆」开关。
 *
 * ★ 默认值方向的取舍：**默认开启**。
 *   为什么不是"默认关闭更安全"：记忆是豆芽的核心能力（"越用越懂你"），
 *   如果因为读不到设置文件就静默关闭，用户遇到的是"它怎么什么都不记得"——
 *   而这是一个**没有任何报错**的故障，比误记一条更糟（误记可见、漏记不可见）。
 *   ⚠️ 但"默认开启"绝不是"忽略用户意愿"：只要**明确读到 false**，就必须关闭。
 *     判定用 `disk.memoryEnabled === false`（严格等于），不用 `!disk.memoryEnabled` ——
 *     否则按键缺失/值为 undefined 都会被当成"用户关掉了"，又变成一次静默降级。
 *
 * ★ 绝不关 Secret 门：本开关只决定"抽取器跑不跑"。
 *   抽取器不跑 ⇒ 没有任何候选进入 Secret 门 ⇒ 门没有被绕过（它本来就没被调用）。
 *   与"跳过了一道本该执行的检查"是完全不同的两件事。
 */
function memoryEnabled() {
  const now = Date.now();
  if (now - memoryEnabledCache.at < MEMORY_SWITCH_TTL_MS) return memoryEnabledCache.value;
  let value = true;
  try {
    if (desktopSettingsPath && fs.existsSync(desktopSettingsPath)) {
      const disk = JSON.parse(fs.readFileSync(desktopSettingsPath, 'utf8')) || {};
      if (disk.memoryEnabled === false) value = false;
    }
  } catch (e) {
    // 读失败 ⇒ 保持默认开启。绝不因为一个坏文件把用户的记忆静默关掉。
    console.error('[Memory] 读取记忆开关失败，按默认（开启）处理:', e && e.message);
    value = true;
  }
  memoryEnabledCache = { at: now, value };
  return value;
}

/** 清掉开关缓存（设置页写完后调用，让改动**立刻**生效，不用等 TTL）。 */
function invalidateMemorySwitch() {
  memoryEnabledCache = { at: 0, value: true };
}

/**
 * 上一轮抽取所看过的消息条数（按 owner 记录）。
 *
 * ★ 为什么必须有水位线，而不是"每轮把整个 conversation 重抽一遍"：
 *   ① 重复抽取 = 同一句话被反复计数 ⇒ `confirmedCount` 虚高 ⇒
 *      UI 上"它凭什么这么确信"显示 30 次，实际用户只说过一次。**记忆的证据链当场失效。**
 *   ② 每轮重抽整段 = 成本随对话长度线性增长，而记忆是旁路，不该有这种开销。
 *   ⇒ 只抽「上次之后新增的消息」。
 *
 * ⚠️ 为什么不落盘：这是**运行期优化**，不是事实。进程重启后从 0 开始，
 *   最坏情况是重抽一小段（Reconciler 的 CONFIRM 判定会吸收掉重复），不会产生错误记忆。
 *   落盘反而引入"水位线比档案新/旧"的不一致风险 —— 拿存储换性能在这里不划算。
 */
// ★ 2026-10-21 改结构：owner -> { len, convRef }。
//   只记长度是不够的 —— 见 runMemoryTurn 里「跨任务水位线」那段注释。
const memoryWatermark = new Map();   // owner -> { len: 已处理的消息条数, convRef: 那个 conversation 数组本身 }

/** 一轮结束后的记忆抽取（**旁路**：绝不影响任务结果）。 */
async function runMemoryTurn(conversation, owner) {
  // ★ 第一道闸：开关。放在最前面 —— 关掉之后连抽取都不跑，
  //   而不是"跑完再丢掉结果"（那样 Secret 门会被无谓调用，语义上像是"开关能影响门"）。
  if (!memoryEnabled()) {
    return { status: MEMORY_STATUS.SKIPPED, reason: 'memory_disabled', passedCount: 0, rejectedCount: 0, rejected: [] };
  }
  // 没有 owner 绝不跑：宁可这次不记，也不能把 A 的记忆写进 B 的档案（串账号）。
  if (!owner || !memoryDataDir) {
    return { status: MEMORY_STATUS.SKIPPED, reason: 'owner_required', passedCount: 0, rejectedCount: 0, rejected: [] };
  }

  // ★ 只取水位线之后的新增消息。首轮水位线为 0 ⇒ 全量（第一次要建立基础认知）。
  //
  // ★★ 2026-10-21 修 `memoryWatermark` 的**跨任务串水位线**（这条极隐蔽，且不修位置也会犯）：
  //   原写法 `seen = memoryWatermark.get(owner) || 0` 按 **owner** 记账，语义上假设
  //   "同一个 conversation 会被反复传进来"。但 `conversation` 在 backend.js 里是**每个任务
  //   新建的数组**（长度从 0 重新长），而上一个任务的长度留在 Map 里 ⇒
  //       任务 A 结束 conversation.length = 32 ⇒ watermark[owner] = 32
  //       任务 B 是新对话，长到 30 ⇒ conversation.slice(32) 恒为 [] ⇒ **B 的记忆一条都不抽**
  //   实测（scripts/tmp-probe/watermark-cross-task.mjs 的 B1）：
  //       n=0 status=NO_CHANGE reason=no_candidates
  //   而且它**不抛、不红、只在"同一个账号连着做第二个任务"时发生** —— 单任务测试永远看不到。
  //
  //   修法：判「传进来的是不是**同一个对话对象**」。不是同一个 ⇒ 这是新任务 ⇒ 水位线归零
  //   （回到"首轮全量"的既有设计），而不是拿上个任务的长度去截断它。
  //   ⚠️ 为什么不按 owner+taskId 记账：runMemoryTurn 的签名只有 (conversation, owner)，
  //      任务 ID 在这一层拿不到；而数组引用比较是**零改签名的**精确判据。
  //   ⚠️ 为什么留 convRef 不会泄漏：每个 owner 只保留**最近一个**对话数组的引用，
  //      上限 = owner 数 × 一个对话，且下次调用就被换掉。
  const wm = memoryWatermark.get(owner);
  const sameConv = !!(wm && wm.convRef === conversation);
  const seen = sameConv ? wm.len : 0;
  const fresh = conversation.slice(seen);
  memoryWatermark.set(owner, { len: conversation.length, convRef: conversation });
  if (!fresh.length) {
    return { status: MEMORY_STATUS.NO_CHANGE, reason: 'no_candidates', passedCount: 0, rejectedCount: 0, rejected: [] };
  }

  // ★ 抽取**只产候选、不写盘**（结构边界：抽取器不 require memoryStore、不知 dataDir）。
  //   所以这一步即便是"抽错了"也不会有任何副作用。
  let candidates = [];
  try {
    candidates = dedupeCandidates(extractFromMessages(fresh));
  } catch (e) {
    // 抽取失败 ⇒ 本轮记忆不更新。**绝不把主任务判失败**（R5）。
    console.error('[Memory] extract failed:', e && e.message);
    return { status: MEMORY_STATUS.SKIPPED, reason: 'error', error: e && e.message, passedCount: 0, rejectedCount: 0, rejected: [] };
  }

  const opts = { dataDir: memoryDataDir };

  // ★★ 外层必须是 memorySidePath：超时熔断 + 异常吞噬 + 结果隔离三层都在它里面。
  //    它保证「写入炸了/挂住了」时本函数**仍然正常返回**，主任务完全不受影响。
  const outcome = await runMemorySidePath({
    candidates,
    enabled: true,                      // 已过上面的开关闸，这里恒为 true
    owner,
    // ★ write 必须遵守"副作用前查 aborted"的约定（见 memorySidePath.withTimeout 注释），
    //   否则会出现"任务已返回、档案仍在后台被半途写入"的假隔离。
    write: async (passed, signal) => {
      // ① 读现状 → ② 调和（四判定 + 三条守卫）→ ③ 翻译成落盘指令 → ④ 落盘 + 记流水。
      const before = memoryStore.readAllLayers(owner, opts);
      if (!before.ok) throw new Error('read_failed:' + (before.errors || []).join(','));

      // ⚠️ 参数顺序是 **(候选, 现状)** —— 不是 (现状, 候选)。
      //    反了不会报错：reconcile 会把 layers 对象当成 candidates 数组（Array.isArray 为 false）
      //    ⇒ 空候选 ⇒ changes 为空 ⇒ commit 写 0 层、ledger 写 0 行，**静默什么也没发生**。
      //    这正是「参数顺序错却不报错」的典型形态，故在此显式留痕。
      const verdict = reconcile(passed, before.layers, { now: Date.now() });
      const plan = toCommitChanges(verdict);

      // ★ 副作用前最后一道 aborted 检查（超时后绝不写）。
      if (signal && signal.aborted) return;

      const res = memoryStore.commit({
        owner,
        changes: plan.changes,
        ledgerRows: plan.ledgerRows,
        dataDir: memoryDataDir,
      });
      // commit 不抛错，靠 ok 表达失败 —— 转成 throw 让旁路记成 SKIPPED（可见，不静默）。
      if (!res.ok) throw new Error('commit_failed:' + (res.errors || []).join(','));
      console.log('[Memory] committed ' + (res.applied || 0) + ' layer(s), '
        + (res.ledger || 0) + ' ledger row(s) for ' + owner);
    },
  });

  return outcome;
}

// 当前后端已加载的技能清单（startBackend 里赋值）。导出 getSkills() 供主进程/桌宠自行构造
// payload.tools（此前 skills 只是 startBackend 的局部变量，主进程拿不到技能表）。
let loadedSkills = [];
function getSkills() {
  return loadedSkills;
}

// 「进行中任务」注册表：taskId -> { aborted, abortReason, ctrl, done, ... }。
// 用于「用户叫停」：POST /api/abort 置 aborted=true；res.on('close') 作为前端断开的兜底。
const runningTasks = new Map();

// ---- 长度/条数上限（防 tasks.json 与注入摘要无限膨胀）----
const TASK_MAX_RECORDS = 200;      // tasks.json 最多保留的记录数
const TASK_MAX_OWNER_RECORDS = 20; // 单个 owner 最多保留的记录数
const TASK_GOAL_MAX = 200;         // goal 最长字符数
const TASK_BRIEF_MAX = 120;        // 每步 brief 最长字符数
const TASK_PLAN_MAX = 12;          // 计划步骤最多保留条数
const TASK_DONE_MAX = 20;          // 已完成步骤最多保留条数（只留最近 20）
const TASK_ARTIFACTS_MAX = 30;     // 产出文件最多保留条数
const TASK_ERR_MAX = 200;          // lastError 最长字符数
const TASK_SKIP_MAX = 30;          // 无人值守被跳过闸门最多记录条数
const TASK_SUMMARY_MAX = 1500;     // 注入给模型的摘要文本硬上限（字符）
// ★ 2026-09-24：逐轮轨迹（每轮工具数/成功数/失败数/产物数）最多保留的轮数。
//   为什么要有它：记录里原来**只有 usedTokens** ⇒ 撞轮数上限 / 原地打转时，
//   事后查 tasks.json 根本答不出"跑了几轮、第几轮开始只在重复动作"，
//   只能翻 console 日志靠猜。轮数轴与打转检测都**只能靠这个数组取证**。
//   被裁掉的老轮次不丢事实：总轮数另有 `turns` 字段兜底。
const TASK_TRACE_MAX = 40;

/** 读取全部任务状态记录（文件缺失/损坏一律返回 []，绝不抛）。 */
function readTaskRecords() {
  try {
    if (!tasksPath || !fs.existsSync(tasksPath)) return [];
    const arr = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
/** 落盘任务状态记录（无 tasksPath 时静默跳过，保证纯 node 单测不炸）。 */
function writeTaskRecords(items) {
  try {
    if (!tasksPath) return;
    fs.writeFileSync(tasksPath, JSON.stringify(items, null, 2));
  } catch (e) {
    console.error('[Backend] write tasks failed:', e.message);
  }
}
/**
 * 任务库路径测试缝。**只给门禁换盘用**，运行时代码一律不调。
 * 为什么必须有这个缝：`reapDanglingRuns()` 的判据是「读全库 → 改 running → 写回」，
 * 门禁若只能 grep 源码字面量，就挡不住"条件写反/写回时把别的记录一起改了"这类真事故
 * （本仓刚在 M2 申报上踩过一模一样的坑：正向还原把原有 17 条 hunk 全删了，门禁才发现）。
 * 缝的形式取"设置器 + 读取器"而不是导出 `tasksPath` 变量本身：
 * 导出变量拿到的是**值拷贝**，赋值改不到模块内部那个 let。
 */
const __taskStoreSeam = {
  setPath(p) { tasksPath = p; },
  getPath: () => tasksPath,
};
/** 单行化 + 截断（去掉换行，避免摘要里混入多行噪声）。 */
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
/** 把一条任务记录按上限裁剪，保证落盘/注入的字段都有限长度。 */
function trimTaskRecord(r) {
  const src = r || {};
  return {
    taskId: String(src.taskId || ''),
    owner: String(src.owner || ''),
    goal: clip(src.goal, TASK_GOAL_MAX),
    plan: (Array.isArray(src.plan) ? src.plan : []).slice(0, TASK_PLAN_MAX).map((x) => clip(x, TASK_BRIEF_MAX)),
    done: (Array.isArray(src.done) ? src.done : []).slice(-TASK_DONE_MAX).map((d) => ({
      step: Number(d && d.step) || 0,
      skill: clip(d && d.skill, 60),
      ok: !!(d && d.ok),
      brief: clip(d && d.brief, TASK_BRIEF_MAX),
    })),
    current: src.current
      ? { step: Number(src.current.step) || 0, skill: clip(src.current.skill, 60), status: clip(src.current.status, 40) }
      : null,
    artifacts: (Array.isArray(src.artifacts) ? src.artifacts : []).slice(-TASK_ARTIFACTS_MAX).map((p) => clip(p, 300)),
    lastError: clip(src.lastError, TASK_ERR_MAX),
    // 被跳过的闸门（诚实记账，上限 30 条）；usedTokens 供事后查账
    // ★ 2026-11-03：新增 key/count/lastAt 三个字段一并读回 —— 不然重启后续跑时
    //   「同一个闸门被拦几次」的计数会被抹成 1，而且老记录没有 key，去重就再也合并不上
    //   （等于修好一次对话里的重复，跨重启又漏回来）。老记录缺字段时按 count=1 处理。
    skippedGates: (Array.isArray(src.skippedGates) ? src.skippedGates : []).slice(-TASK_SKIP_MAX).map((g) => ({
      key: clip(g && g.key, 120) || (clip(g && g.gate, 40) + '\u0000' + clip(g && g.skill, 60)),
      gate: clip(g && g.gate, 40),
      skill: clip(g && g.skill, 60),
      target: clip(g && g.target, 200),
      count: Math.max(1, Number(g && g.count) || 1),
      at: Number(g && g.at) || Date.now(),
      lastAt: Number(g && g.lastAt) || Number(g && g.at) || Date.now(),
    })),
    usedTokens: Number(src.usedTokens) || 0,
    // ★ 第二执行实例的 token 份额（见 backend 里 delegateUsage 头注）：
    //   不带上它 ⇒ 落盘被裁掉 ⇒ 单任务成本又变成"只有外层那一半"。
    delegateTokens: Number(src.delegateTokens) || 0,
    // ★ 2026-09-24 补齐四条「资源轴 / 打转检测」取证字段（原来一条都没有 ⇒ 事后无法归因）：
    //   turns      本次任务实际跑了几轮（撞上限时 == maxTurns，是你问"为什么突然停下"的第一证据）
    //   toolCalls  累计工具调用次数（与 turns 一起才能算出"每轮调用数"这个打转指标）
    //   maxTurns   当次**实际生效**的轮数上限（上限已可配 ⇒ 不记下来就不知道 24 是不是真的）
    //   wrappedUp  轮数/预算轴的软收尾有没有真的进过（轮数出口原来连这个都不落盘）
    turns: Number(src.turns) || 0,
    toolCalls: Number(src.toolCalls) || 0,
    maxTurns: Number(src.maxTurns) || 0,
    wrappedUp: !!src.wrappedUp,
    // 收尾是哪条轴触发的：stuck（结果一直不动）/ turns / budget / both
    wrappedUpReason: clip(src.wrappedUpReason, 20),
    // 逐轮轨迹（只留最近 TASK_TRACE_MAX 轮）：t=轮号, tools=本轮工具数, ok/fail=本轮成功/失败步数,
    // arts=本轮结束时**累计**产物数（看"目标产物有没有在涨"）。判"原地打转"要靠它，不靠主观印象。
    turnTrace: (Array.isArray(src.turnTrace) ? src.turnTrace : []).slice(-TASK_TRACE_MAX).map((x) => ({
      t: Number(x && x.t) || 0,
      tools: Number(x && x.tools) || 0,
      ok: Number(x && x.ok) || 0,
      fail: Number(x && x.fail) || 0,
      skipped: Number(x && x.skipped) || 0,
      wrote: Number(x && x.wrote) || 0,
      // vf = 本轮「对**已有**交付物执行了几次验收动作」（shell-exec / ssh-exec，见 VERIFY_TOOLS）。
      // 结果轴必须靠它把「认真验收」和「原地造轮子」分开；白名单漏掉这一项
      // ⇒ 内存里算对了、落盘被裁掉，事后审计就看不到"它其实一直在验收"。
      vf: Number(x && x.vf) || 0,
      // ── 进度账本四维度（2026-10-23 三维 + 2026-11-11 第④维）。漏掉任何一个 ⇒ 落盘后读数归零 ⇒ 事后无法复核
      //    "为什么判打转"到底是真没进展、还是判据又判错了。
      newEv: Number(x && x.newEv) || 0,        // 本轮新增的有效验收证据条数（去重后）
      // 强/弱证据分开留痕：无工作流标准时（非 PPT 任务）退到宽判档，那种"进展"是弱证据。
      // 两者都算进展，但事后必须能回答"这次进展里有多少是宽判来的"。
      newEvWeak: Number(x && x.newEvWeak) || 0,
      artUpd: Number(x && x.artUpd) || 0,      // 已有产物被**有效更新**次数（同内容重写不算）
      // ④ 工程进度（2026-11-11）：非过程脚本的文件**新增 / 内容真变**次数。
      //   与 artUpd 的区别只在**入表口径**：这里不过 isRealArtifact（显示轴的窄口径会漏掉
      //   .gd/.tscn/.vue 这类工程源码）。漏掉这两个字段的后果与上面三行完全一样 ——
      //   内存里判对了、落盘被裁掉 ⇒ 事后复盘只看到"progressed=false"，无法分辨是真是假。
      codeNew: Number(x && x.codeNew) || 0,
      codeUpd: Number(x && x.codeUpd) || 0,
      issClosed: Number(x && x.issClosed) || 0,// 本轮关掉的未解决问题数
      issOpen: Number(x && x.issOpen) || 0,    // 本轮末仍未解决的宽度（便于看趋势）
      arts: Number(x && x.arts) || 0,
    })),
    status: clip(src.status, 20),
    updatedAt: Number(src.updatedAt) || Date.now(),
    // ★ 内部子运行的显式标记（判据见 isInternalTaskRecord）。留着它有两个用处：
    //   ① 磁盘上存量记录能被读侧一眼认出，不必只靠 `-r2` 后缀这条命名约定；
    //   ② 裁剪字段时若不带上它，写入侧的语义就被"trim 掉"了（本仓踩过"落盘被裁掉"的坑）。
    internal: src.internal === true,
  };
}
/**
 * 这条任务记录是不是「内部子运行」（= 第二执行实例）。
 *
 * 🔴 **写侧（upsertTaskRecord）与读侧（latestUnfinishedTask）必须共用本判据** ——
 *   不许在两处各写一份判断（同一件事两套口径是本仓最忌讳的）。
 *
 * ★★ 2026-02-16 独立验收实测出的真实污染（本轮 P1-1）：第二执行实例（taskId 带 `-r2`）
 *   跑完会在 tasks.json 里留下一条记录，`goal` = 内部种子文本前 200 字、`status=incomplete`。
 *   主任务改成 COMPLETE 之后，`latestUnfinishedTask` 反而选中了那条 `-r2` ⇒
 *   下一轮注入的【跨请求任务状态】把"任务目标"写成
 *   「（替补执行任务说明 —— 这是系统交给你的任务…」，并把替补那 4 步 `shell-exec：hi`
 *   当成"这个任务已完成的步骤" ⇒ 用户说"继续"时，模型接着去干一件**内部交接任务**。
 *   当时已经堵住了 projectLedger 与 taskStream.listActive()，**唯独漏了 tasks.json 这一路**。
 *
 * 判据取两个来源，任一命中即内部：
 *   · `taskId` 以 `-r2` 结尾（`DELEGATE_TASK_SUFFIX`，替补的唯一命名规则）；
 *   · 记录里显式 `internal === true`（留给将来"内部运行不叫 -r2 后缀"的形态，语义更直白）。
 *
 * @param {object|null} rec 一条任务记录（或待写记录）
 * @returns {boolean} true = 内部子运行，**不许**进 tasks.json、**不许**被当成"未完成任务"
 */
function isInternalTaskRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.internal === true) return true;
  const id = String(rec.taskId || '');
  if (!id) return false;
  return id.length > DELEGATE_TASK_SUFFIX.length && id.endsWith(DELEGATE_TASK_SUFFIX);
}
/** 新增/更新一条任务状态（按 taskId 去重），并按 owner/总量上限裁剪后落盘。 */
function upsertTaskRecord(rec) {
  const rec2 = trimTaskRecord(rec);
  // ★ 内部子运行**不落这一类盘**（它与"用户跨请求未完成的任务"不是同一种东西，见 isInternalTaskRecord）。
  //   判据只调那一个函数 —— 读侧 latestUnfinishedTask 用的是同一条。
  if (isInternalTaskRecord(rec2)) return;
  const all = readTaskRecords().filter((x) => x && x.taskId !== rec2.taskId);
  all.push(rec2);
  all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const byOwner = new Map();
  const kept = [];
  for (const r of all) {
    const key = r.owner || '';
    const n = byOwner.get(key) || 0;
    if (n >= TASK_MAX_OWNER_RECORDS) continue;
    byOwner.set(key, n + 1);
    kept.push(r);
  }
  writeTaskRecords(kept.slice(0, TASK_MAX_RECORDS));
}
/**
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★ 僵尸任务回收（2026-11-11）—— 「跑不完」里最误导人的那一种
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 【实测证据（老板本机 AppData/Roaming/douya-claw，2026-11-09）】
 *   tasks.json 里 `task_mw92uxzb_6dq7rj` 的 `status` 停在 **'running'**，只有 6 轮、
 *   11 个工具调用；对应的 `traces/task_mw92uxzb_6dq7rj.jsonl` **没有 `task_end` 事件**。
 *   也就是说进程在任务中途退出了（关窗 / 任务管理器 / 崩溃），终态一条都没写。
 *
 * 【它为什么比"报错"更伤人】
 *   ① 界面 / `/api/tasks` 显示"这个任务还在跑" —— 用户会一直等一个已经死掉的进程；
 *   ② `latestUnfinishedTask()` 用 `status !== 'done'` 判未完成 ⇒ 这条僵尸**永远**是
 *      "最近一条未完成任务" ⇒ `buildTaskStateSummary()` 每一轮都把它注进系统提示。
 *      实测后果：后续任务的系统提示里长期挂着「任务目标：不是godot的啊」这种半句话，
 *      而真正的新任务目标被它挤在后面 —— 这是「跑偏」的**第二个来源**（第一个在
 *      projectLedger.js 的续接判据，见那里的长注）。
 *
 * 【为什么在启动时收拾，而不是退出时收拾】
 *   正常退出可以挂 `before-quit`，但**崩溃 / 被杀 / 断电**根本没有机会执行任何代码 ——
 *   而僵尸恰恰主要来自这几种。唯一一定还会再被执行一次的地方，就是下一次启动。
 *   所以回收放在 `startBackend` 里，判据是"**新进程起来了 ⇒ 上一个进程里的 running 必然已死**"，
 *   这在单实例应用里是硬事实（同机双开会先撞 9300 行那个端口 bind 失败）。
 *
 * 【失败方向（想清楚再改）】
 *   只动 `status === 'running'` 这一种，别的一律不碰；写 `interrupted` 而不是 `done`
 *   （它确实没做完，冒充完成是本仓最重的一类谎）；`updatedAt` 保持原值，不改写成"刚刚"
 *   （那会把"什么时候停的"这条唯一的诊断线索抹掉）。
 *   重复调用是幂等的：改判之后状态不再是 running，第二次进来什么也不做。
 *
 * @returns {{scanned:number, reaped:number, ids:string[]}}
 */
function reapDanglingRuns() {
  const out = { scanned: 0, reaped: 0, ids: [] };
  const all = readTaskRecords();
  out.scanned = all.length;
  if (!all.length) return out;
  let touched = false;
  for (const r of all) {
    if (!r || r.status !== 'running') continue;
    r.status = 'interrupted';
    // 归因写清楚：不是用户停的（那是 aborted）、也不是执行报错（那是 error），
    // 而是"进程没能走到收尾"。三者混用会让事后查账查不出真因。
    r.abortReason = 'process-exit-before-finalize';
    if (!r.lastError) r.lastError = '上一次运行未正常收尾（进程在任务结束前退出），已按中断记账';
    r.current = Object.assign({}, r.current || {}, { status: 'interrupted' });
    out.reaped += 1;
    out.ids.push(String(r.taskId || ''));
    touched = true;
  }
  // 一条都没命中就不写盘 —— 避免每次启动都改一次 mtime，把"这文件什么时候变过"这条线索磨平。
  if (touched) writeTaskRecords(all);
  return out;
}
/** 取某 owner 最近一条「未完成」的任务（status !== 'done'）。owner 为空返回 null（防串账号）。 */
function latestUnfinishedTask(owner) {
  if (!owner) return null;
  // ★ 与 upsertTaskRecord **同一条**内部判定：即使磁盘上（旧版本写下的）已有 `-r2` 幽灵记录，
  //   这里也不会把它当成"用户未完成的任务"（见 isInternalTaskRecord 头注里的实测事故）。
  const list = readTaskRecords()
    .filter((r) => r && r.owner === owner && r.status !== 'done' && !isInternalTaskRecord(r));
  if (!list.length) return null;
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list[0];
}
/**
 * 构造「跨请求任务状态」system 消息文本（供 runAgentLoop 注入）。
 * 只针对本 owner 最近一条未完成任务；文本有硬上限（TASK_SUMMARY_MAX），防无限膨胀。
 * owner 为空 / 无未完成任务 → 返回 ''（不注入）。
 */
function buildTaskStateSummary(owner) {
  const t = latestUnfinishedTask(owner);
  if (!t) return '';
  const doneLines = (t.done || [])
    .map((d) => '  ' + d.step + '. ' + d.skill + '：' + (d.brief || '') + (d.ok ? '' : '（失败）'))
    .join('\n');
  const planLines = (t.plan || []).map((s, i) => '  ' + (i + 1) + ') ' + s).join('\n');
  const parts = [
    '【跨请求任务状态（你上一轮被打断/停下的任务，用户可能说「继续」）】',
    '任务目标：' + (t.goal || '(未记录)'),
  ];
  if (planLines) parts.push('原计划：\n' + planLines);
  parts.push('已完成：\n' + (doneLines || '  （还没有已完成步骤）'));
  if (t.current) parts.push('当前/停在：' + t.current.skill + '（' + (t.current.status || '') + '）');
  // ★ 规范 §11/§31：把状态机接到**续跑摘要**上。
  //   为什么这里必须有：用户说「继续」时，模型只看到"完成了哪几步"，不知道**自己停在流程的哪个阶段**，
  //   最常见的退化就是又从头执行一遍（原地打转的另一种形态）。明确"当前阶段 + 下一步该进入哪"才能避免。
  //   判据：停下的那一步是失败/错误 ⇒ 当前处于 ANALYZE（该先分析、再决定修还是换）；
  //        否则处于 EXECUTE（该继续往前走到 VERIFY）。
  //   ⚠️ 状态机**不允许** EXECUTE → EXECUTE，所以这里的下一步只可能是 RECOVER/VERIFY 之类，不会原地循环。
  {
    // ⚠️ 判据方向：**白名单**（只有 'done' 算成功），不是黑名单。
    //   改前是 /fail|error|incomplete|turn-limit/ —— 对 current.status 的真实取值穷举后漏判 4 种
    //   **早就在用**的状态（实测，非推测）：
    //     timeout          => 正则不匹配 => 被当成"正在执行阶段"
    //     aborted          => 同上
    //     budget-exceeded  => 同上
    //     stream-idle      => 同上
    //   即：用户叫停 / 超时 / 预算耗尽 / 流空闲 四种收尾，续跑摘要都会告诉模型"你正在正常往前走"。
    //   本轮新增的 'interrupted'（僵尸回收）只是第 5 个漏判，不是唯一问题。
    //   为什么白名单：黑名单的失败方向是"以后新增状态默认当成成功"——静默说错话、没人会发现；
    //   白名单的失败方向是"以后新增状态默认当成没成功"——最坏只是多走一步 ANALYZE 先看原因，
    //   而 ANALYZE 的下一步由 nextState 保证不会原地循环，不会卡死。
    //   写入侧的对应事实：current.status 只在 ok 分支被写成 'done'（见 task_progress 落账处
    //   `status: ok ? 'done' : 'failed'`），其余全是异常出口，所以 `!== 'done'` 是完备判据。
    //   保持 lastStatus 为空时仍按 EXECUTE：那是"任务还没落下第一步"的旧行为，
    //   本函数此刻连"当前/停在"那行都不会输出，不该在这一轮顺带改它的语义。
    const lastStatus = (t.current && t.current.status) || '';
    const failed = !!lastStatus && lastStatus !== 'done';
    const curState = failed ? STATE.ANALYZE : STATE.EXECUTE;
    const nx = nextState(curState, failed ? 'retryable' : 'ok');
    parts.push('当前阶段：' + curState + '（' + (failed ? '上一步没成功，正处于"先分析原因"阶段' : '正在执行阶段') + '）；下一步应进入：' + nx);
    parts.push('续跑时请据此推进：不要重复已完成的步骤，也不要因为在 ANALYZE 就停下不做了 —— 分析完要选一条路继续往下走。');
  }
  if (t.artifacts && t.artifacts.length) parts.push('已产出文件：\n' + t.artifacts.map((p) => '  - ' + p).join('\n'));
  if (t.lastError) parts.push('最近错误：' + t.lastError);
  parts.push('如果用户说「继续」，请从未完成处接着做，不要重复已完成的步骤；已产出的文件直接复用，不要重新生成。');
  const text = parts.join('\n');
  if (text.length <= TASK_SUMMARY_MAX) return text;
  const SUFFIX = '\n…（任务状态摘要已截断）';
  return text.slice(0, Math.max(0, TASK_SUMMARY_MAX - SUFFIX.length)) + SUFFIX;
}
/** 把任务状态摘要注入 conversation（在 compressContext + persona 之后调用，避免被压缩吃掉）。 */
function injectResumeState(conversation, owner) {
  try {
    const text = buildTaskStateSummary(owner);
    if (text) conversation.push({ role: 'system', content: text });
  } catch (e) {
    console.error('[Backend] inject resume state failed:', e.message);
  }
}
/**
 * 用户叫停：把某任务标记为 aborted、abort 掉它正在进行的上游请求，并唤醒它正在等待的闸门
 * （确认/素材/澄清/选文件），让 runAgentLoop 立刻（而不是等 300s 超时）走到中断收尾。
 * @returns {boolean} 是否命中一个进行中的任务
 */
function abortTask(taskId, reason) {
  const t = runningTasks.get(taskId);
  if (t) {
    t.aborted = true;
    t.abortReason = reason || 'user';
    if (t.ctrl) { try { t.ctrl.abort(); } catch { /* ignore */ } }
    // [LIFE-ABORT] 任务级：打断**正在执行的技能**（ctrl 只管上游请求；技能执行期 ctrl 为 null，单靠它会打空）
    if (t.lifeCtrl) { try { t.lifeCtrl.abort(); } catch { /* ignore */ } }
  }
  const wake = (map) => {
    for (const [id, e] of map) {
      if (e && (!taskId || e.taskId === taskId)) { map.delete(id); e.resolve(null); }
    }
  };
  // ★ 2026-02-16【第二执行实例必须能被同一次"停止"停掉】
  //   第二实例有自己的 taskId（`taskId + '-r2'`）和自己的 taskEntry —— 它由内部 `runningTasks.set` 注册。
  //   而用户点「停止」只会点到外层的 taskId ⇒ 不打这一枪，外层退出后替补还在后台烧预算，
  //   且**没有任何 UI 能停它**（它的连接是假 res，前端看不见）。
  //   判据用**同一个常量**（DELEGATE_TASK_SUFFIX），不在这里另写一遍 '-r2'。
  try {
    const prefix = String(taskId || '') + DELEGATE_TASK_SUFFIX;
    for (const [id, e] of runningTasks) {
      if (!id || id === taskId || !e) continue;
      if (!String(id).startsWith(prefix)) continue;
      e.aborted = true;
      if (!e.abortReason) e.abortReason = reason || 'user';
      if (e.ctrl) { try { e.ctrl.abort(); } catch { /* ignore */ } }
      if (e.lifeCtrl) { try { e.lifeCtrl.abort(); } catch { /* ignore */ } }
    }
  } catch { /* 连带叫停是增益，绝不因为它出错而让"停止"本身失败 */ }
  wake(pendingActions);
  wake(pendingMaterials);
  wake(pendingClarify);
  wake(pendingPickFiles);
  return !!t;
}

function readUsage() {
  try {
    const raw = require('fs').readFileSync(usagePath, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j.total === 'number') return j;
  } catch {}
  return { total: 0, prompt: 0, completion: 0, calls: 0, byUser: {} };
}

function writeUsage(u) {
  try { require('fs').writeFileSync(usagePath, JSON.stringify(u)); } catch {}
}

// 单任务 token 预算护栏：长任务/无人值守跑起来可能无限烧钱且无人察觉，故设一道硬上限。
// 命中即停止后续模型调用（并如实说明「因超出预算已停止」，绝不谎称完成）。
//
// ★ 2026-09-16 实测修正：原值 250000，理由是「25 万足以覆盖最复杂的多步任务」。该前提已被
//   **真机端到端压测证伪**（agent 自主修真实网页游戏的 bug，同任务同工具、只换文件大小）：
//     · 38KB（≈660 行）→ 读窗口 + 打补丁 + 复验，耗 222,758 token（占 25 万的 89%）→ 完成
//     · 60 / 120KB    → 卡在「预算耗尽、来不及收尾」→ 未完成
//     · 同一份 120KB 文件，只把预算抬到 90 万 → 耗 413,260 token → 完成并通过浏览器复验
//   ⇒ 失败主因是**预算**，不是读取截断：模型会自发用 `grep -n` + `sed -n 'A,Bp'` 读窗口，
//     并用 ssh-exec download + 带断言补丁，绕开 file-read 的 8000 字符与 ssh 输出的 6000 字符上限。
//   250000 会在「一张真实网页」这个量级上中途掐断，故默认抬到 60 万（覆盖实测 120KB 场景并留余量）。
//
//   注意：抬高上限**不增加正常任务的成本**（按实际消耗计费，上限只是闸门），只放行本该跑完的长任务；
//   代价是万一真跑飞，最多多烧到该上限。可用 config.json 的 `taskTokenBudget`（或环境变量
//   DOUYA_TASK_TOKEN_BUDGET）覆盖。
const DEFAULT_TASK_TOKEN_BUDGET = 600000;

/**
 * 🔴🔴 预算计量口径（2026-09-23 修「干一半就跳超预算停止」的**根因**）
 *
 * 【旧实现错在哪】每轮无条件累加 `pt + ct`，而 `pt` 是**整份 conversation 全量重发**的
 * prompt_tokens（代码里 `body.messages = conversation`）。于是同一个上下文被**反复计费**：
 *   第 n 轮的 pt ≈ 人设 + 对话，而对话每轮都在长 ⇒ Σpt 随轮次**平方增长**。
 * 实测后果：真实工作量只有约 2 万 token 的任务，跑十几轮就被记成 60 万 ⇒ **闸门在任务中途落下**，
 * 用户看到的就是「干一半就跳这个」。**这不是预算太小，是计量口径把"重读"当成了"干活"。**
 *
 * 【新口径】只把「这一轮**新产生**的内容」计入预算：
 *   · 命中缓存的部分（`prompt_cache_hit_tokens`）= 原文重读，按 **0** 计入闸门；
 *   · 未命中的 prompt 部分 = 真正新喂进去的内容，计入；
 *   · completion = 模型新生成的，计入。
 * 拿不到缓存字段时（网关没返回）退化为**增量法**：`max(0, pt - 上一轮 pt) + ct`，
 * 只算比上一轮**多出来**的那部分 —— 语义同样是「新增」，不会把重读重复计费。
 *
 * ⚠️ 记账与闸门**分开**：`billable` 是给成本台账的真实用量（含缓存命中），
 *     `work` 才是给闸门的增量。两者混用正是旧实现的错。
 *
 * 纯函数（无副作用、不读全局），单测可直接对真实代码求值。
 * @param {{promptTokens?:number, completionTokens?:number, cacheHitTokens?:number, lastPromptTokens?:number}} o
 * @returns {{work:number, billable:number, cacheHit:number, reused:number, method:'cache'|'delta'}}
 */
function computeTurnCost(o) {
  const src = o && typeof o === 'object' ? o : {};
  const pt = Math.max(0, Number(src.promptTokens) || 0);
  const ct = Math.max(0, Number(src.completionTokens) || 0);
  const hitRaw = Number(src.cacheHitTokens);
  const hasCache = Number.isFinite(hitRaw) && hitRaw >= 0 && pt > 0;
  if (hasCache) {
    // 命中量不可能超过 prompt 总量（上游异常时钳一下，避免算出负的新增）
    const hit = Math.min(hitRaw, pt);
    return { work: (pt - hit) + ct, billable: pt + ct, cacheHit: hit, reused: hit, method: 'cache' };
  }
  const lastPt = Number(src.lastPromptTokens);
  const delta = Number.isFinite(lastPt) && lastPt >= 0 ? Math.max(0, pt - lastPt) : pt;
  return { work: delta + ct, billable: pt + ct, cacheHit: 0, reused: Math.max(0, pt - delta), method: 'delta' };
}

/**
 * 软阈值：用到预算的这个比例就切「收尾模式」。
 * 为什么要软阈值而不是只用硬闸门 —— 硬闸门是**悬崖**：跨过去就掐断，
 * 于是任务总是在"差最后一步"的地方停（正是用户抱怨的形态）。
 * 进收尾模式后：不再启动新的重资产动作、压缩更激进、并要求模型**交出阶段性成果 + 缺口声明**。
 * 这样最坏情况也是"带着可用产出落地"，而不是"干到一半被切断"。
 */
const BUDGET_WRAPUP_RATIO = 0.75;
/**
 * ★ 轮数轴的软收尾阈值（2026-09-24）—— 让第二条资源轴与预算轴**同构**。
 * 为什么必须有：实测撞轮数上限时 **token 只用 21%**（钱还剩 79%、步数不让走了）。
 * 这证明缺的不是预算，而是「轮数轴没有自己的软收尾」⇒ 它仍是一道**悬崖**，
 * 而 token 轴一周前已经修过了（同一段代码注释自己写着："硬闸门是悬崖，跨过去就掐断，
 * 于是任务总是在'差最后一步'处停"）。对称化之后，轮数见底前也会进收尾模式
 * （交出阶段成果 + 缺口声明），最坏情况同样是"带着可用产出落地"。
 */
const TURN_WRAPUP_RATIO = 0.75;
/**
 * ★ 第三条轴：**结果轴**（2026-09-24）—— 「成功但没有进展」的软收尾阈值（占轮数上限的比例）。
 *
 * 为什么必须有：轮数轴和预算轴管的都是**资源**（步数、钱），而用户报的形态是**结果层不动**：
 *   「做 PPT 时连着产出 7 个 `_probe*.py`，数量在变，但目标没变」。
 *   ⚠️ 这种形态**任何基于失败的机制都抓不到**：每一次调用都"成功"，
 *   所以失败账本不记账、工具熔断（判据＝连续失败）永不触发。
 *
 * 判据是**三段客观量**，都不是猜模型动机：
 *   ① 锚点：用户自己说了要产出型成果（复用既有 WANTS_FILE_OUTPUT，且非只读请求）
 *   ② 活动量：窗口内每一轮都有工具调用（不是闲着，是**在动**）
 *   ③ 进度：窗口内 `deliverables` 零增长 —— 而 `isProcessScript` 早已把 `_probe.py`/`_patch.py`
 *      这类过程脚本挡在交付物之外（2026-09-17 实测"40 条里 33 条是过程脚本"）
 *      ⇒ "探针在涨、交付物恒为 0" 正是该形态的**客观签名**。
 *
 * 为什么取 0.5（先于轮数收尾 0.75 触发）：结果不动比资源见底更该先说实话。
 * 为什么动作是"进收尾模式"而不是继续劝：既有的一次性"防嘴炮"提示（antiMouthCannon）已经劝过一轮，
 *   到这里说明**劝无效** ⇒ 本仓既有教训原话：「追加提示是"劝"，而模型在重试循环里会忽略劝告」。
 */
const STUCK_TURN_RATIO = 0.5;

/** 取单任务 token 预算：cfg 覆盖优先，否则用默认值。注意 cfg.taskTokenBudget=0 代表「未设置」（非正数一律回落默认），判闸门必须过这个函数，别直接读 cfg。 */
function resolveTaskTokenBudget(cfg) {
  const v = Number(cfg && cfg.taskTokenBudget);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TASK_TOKEN_BUDGET;
}

// 累加一次 LLM 调用的 token（估算/真实都行），按用户名分账
function addUsage(username, promptTokens, completionTokens, opts) {
  const u = readUsage();
  const key = username || 'anonymous';
  u.total += promptTokens + completionTokens;
  u.prompt += promptTokens;
  u.completion += completionTokens;
  u.calls += 1;
  if (!u.byUser[key]) u.byUser[key] = { total: 0, prompt: 0, completion: 0, calls: 0 };
  u.byUser[key].total += promptTokens + completionTokens;
  u.byUser[key].prompt += promptTokens;
  u.byUser[key].completion += completionTokens;
  u.byUser[key].calls += 1;
  // 预算超限记账：便于事后查账（哪次任务、是谁、烧了多少）。只增不改，保留最近 50 条。
  if (opts && opts.budgetExceeded) {
    u.budgetExceeded = true;
    if (!Array.isArray(u.budgetEvents)) u.budgetEvents = [];
    u.budgetEvents.push({
      at: Date.now(),
      username: key,
      taskId: String(opts.taskId || ''),
      used: Number(opts.usedTokens) || 0,
      // 记账时记下**本次实际生效**的预算（调用方把 resolveTaskTokenBudget(cfg) 传进来），
      // 而不是写死默认值 —— 否则 config 覆盖后，台账里的 budget 会与实际闸门不符、事后无法查账。
      budget: Number(opts.budget) > 0 ? Number(opts.budget) : DEFAULT_TASK_TOKEN_BUDGET,
    });
    if (u.budgetEvents.length > 50) u.budgetEvents = u.budgetEvents.slice(-50);
  }
  writeUsage(u);
  // 客户端自报：把这条用量排进上报队列（异步、不阻塞、失败吞掉，见下方实现）
  // 注：pt+ct<=0 的调用（如预算超限占位）由 enqueueUsageReport 自行忽略。
  try {
    enqueueUsageReport({ model: (opts && opts.model) || '', pt: promptTokens, ct: completionTokens, src: (opts && opts.src) || '' });
  } catch { /* ignore */ }
}
// ==================== 客户端用量自报：实现 ====================
const USAGE_REPORT_PATH = '/api/usage/report';
const USAGE_QUEUE_MAX = 2000;   // 本地队列上限（超出丢最旧，防无限增长）
const USAGE_BATCH_MAX = 200;    // 单次上报条数（服务端上限 500）

/** 取应用版本号（只作上报标签，取不到就留空，绝不因此中断）。 */
function getAppVersionTag() {
  if (_appVersionCache !== null) return _appVersionCache;
  try {
    _appVersionCache = String(require('electron').app.getVersion() || '');
  } catch {
    _appVersionCache = '';
  }
  return _appVersionCache;
}

function _persistUsageQueue() {
  try {
    if (!usageQueuePath) return;
    fs.writeFileSync(usageQueuePath, JSON.stringify(usageQueue));
  } catch { /* 落盘失败不影响对话 */ }
}

function loadUsageQueue() {
  try {
    if (!usageQueuePath || !fs.existsSync(usageQueuePath)) return;
    const j = JSON.parse(fs.readFileSync(usageQueuePath, 'utf8'));
    if (Array.isArray(j)) usageQueue = j.filter((e) => e && typeof e === 'object').slice(-USAGE_QUEUE_MAX);
  } catch { /* 队列损坏就当作空 */ }
}

function loadAuthToken() {
  try {
    if (!authTokenPath || !fs.existsSync(authTokenPath)) return;
    const j = JSON.parse(fs.readFileSync(authTokenPath, 'utf8'));
    if (j && typeof j.token === 'string') authTokenCache = j.token;
  } catch { /* 读不到就当未登录 */ }
}

/**
 * 记住登录态 token（主进程侧）。渲染层每次启动都会带 token 找 /api/auth/profile 校验，
 * 顺手存一份 => 即使连接器里那份 token 已按 24h 过期，主进程也始终有可用的上报凭证。
 */
function rememberAuthToken(token) {
  const t = String(token || '').trim();
  if (!t) return;
  authTokenCache = t;
  try {
    if (authTokenPath) fs.writeFileSync(authTokenPath, JSON.stringify({ token: t, ts: Date.now() }));
  } catch { /* ignore */ }
  // 拿到（可能是刷新过的）token：立刻尝试把积压的用量补报上去
  if (usageQueue.length) scheduleUsageFlush(1500);
}

/** 排一条用量进队列（由 addUsage 调用，属记账路径 => 任何异常都必须吞掉）。 */
function enqueueUsageReport(ev) {
  const rawPt = Number(ev && ev.pt);
  const rawCt = Number(ev && ev.ct);
  // 严格校验：非有限数 / 负数一律**直接丢弃**，绝不静默改写（把 -5 洗成 0 再上报，事后无从察觉）
  if (!Number.isFinite(rawPt) || !Number.isFinite(rawCt) || rawPt < 0 || rawCt < 0) return;
  const pt = Math.round(rawPt);
  const ct = Math.round(rawCt);
  if (pt + ct <= 0) return;   // 没有量可报（服务端同样拒收 pt+ct<=0）
  usageQueue.push({
    id: 'd|' + Date.now().toString(36) + '|' + Math.random().toString(36).slice(2, 10),
    ts: Math.floor(Date.now() / 1000),
    model: String((ev && ev.model) || '').slice(0, 80),
    pt,
    ct,
    src: String((ev && ev.src) || '').slice(0, 40),
    // 调用方显式带 ver 就用它；否则退回应用版本号（非 electron 环境为空串，不影响上报）
    ver: String((ev && ev.ver) || getAppVersionTag()).slice(0, 20),
  });
  if (usageQueue.length > USAGE_QUEUE_MAX) usageQueue = usageQueue.slice(-USAGE_QUEUE_MAX);
  _persistUsageQueue();
  scheduleUsageFlush(3000);
}

/** 排一次上报（去抖：已有更早的待触发就不重排）。 */
function scheduleUsageFlush(delayMs) {
  const d = Math.max(200, Number(delayMs) || 3000);
  if (usageFlushTimer && usageFlushAt <= Date.now() + d) return;
  if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null; }
  usageFlushAt = Date.now() + d;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    usageFlushAt = 0;
    flushUsageReports().catch(() => { /* ignore */ });
  }, d);
  if (usageFlushTimer.unref) usageFlushTimer.unref();
}

/**
 * 把队列里的用量批量上报给 api.example.com。
 * 语义边界（务必分清）：
 *   · 未登录 / 退避中     -> 直接返回，**事件留在队列**（下次再来）；
 *   · HTTP 2xx            -> 从队列移除本批（已入库，服务端幂等）；
 *   · HTTP 400            -> 这批数据服务端不收（格式/脏数据），**移除**，否则会永久堵住队列；
 *   · HTTP 401/403 等     -> 凭证问题，**保留**事件，退避后重试；
 *   · 网络异常            -> **保留**事件，退避后重试。
 * 任何情况下都不向调用方抛出（记账路径绝不允许影响对话）。
 */
async function flushUsageReports() {
  if (usageFlushing || !usageQueue.length) return;
  if (Date.now() < usageBackoffUntil) return;
  const token = authTokenCache;
  if (!token) return;   // 未登录：留着，等登录后补报
  usageFlushing = true;
  const batch = usageQueue.slice(0, USAGE_BATCH_MAX);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try {
      resp = await fetch(DOUYA_BASE_URL + USAGE_REPORT_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ events: batch }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (resp.ok || resp.status === 400) {
      const sent = new Set(batch.map((e) => e.id));
      usageQueue = usageQueue.filter((e) => !sent.has(e.id));
      _persistUsageQueue();
      usageBackoffUntil = 0;
    } else {
      // 401/403（token 失效）退避 3 分钟，其它非 2xx 退避 1 分钟；数据一律保留
      usageBackoffUntil = Date.now() + ((resp.status === 401 || resp.status === 403) ? 180000 : 60000);
    }
  } catch {
    usageBackoffUntil = Date.now() + 60000;   // 断网/超时：退避重试，绝不丢
  } finally {
    usageFlushing = false;
    if (usageQueue.length) scheduleUsageFlush(usageQueue.length >= USAGE_BATCH_MAX ? 300 : 60000);
  }
}

/**
 * 测试专用（生产路径不调用）：注入落盘路径 / 复位运行时状态，便于纯 node 单测。
 * 返回复位后的队列长度，调用方据此断言「上一个用例没留下残留」。
 */
function __usageTestSeam(p) {
  if (p) {
    if (p.queuePath !== undefined) usageQueuePath = p.queuePath;
    if (p.tokenPath !== undefined) authTokenPath = p.tokenPath;
    if (p.token !== undefined) authTokenCache = String(p.token || '');
    if (p.resetQueue) usageQueue = [];
  }
  usageBackoffUntil = 0;
  usageFlushing = false;
  if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null; }
  usageFlushAt = 0;
  return usageQueue.length;
}

function __usageQueueSnapshot() {
  return usageQueue.slice();
}
// ==================== 客户端用量自报 END ====================

function readDeliverables(owner) {
  try {
    if (!delivPath || !fs.existsSync(delivPath)) return [];
    const arr = JSON.parse(fs.readFileSync(delivPath, 'utf8'));
    const list = Array.isArray(arr) ? arr : [];
    // 按账号严格隔离：传了 owner 就只返回 owner 完全匹配的记录；旧数据无 owner 字段则不展示给任何账号
    return owner ? list.filter((d) => d.owner === owner) : list;
  } catch {
    return [];
  }
}
function writeDeliverables(items) {
  try {
    if (!delivPath) return;
    fs.writeFileSync(delivPath, JSON.stringify(items, null, 2));
  } catch (e) {
    console.error('[Backend] write deliverables failed:', e.message);
  }
}
// 追加成果（按 path 去重，带 time 时间戳与 owner 归属），最多保留最近 200 条，按时间倒序落盘
function appendDeliverables(newItems, owner) {
  if (!Array.isArray(newItems) || newItems.length === 0) return readDeliverables(owner);
  const merged = readDeliverables().slice();
  const indexByPath = new Map(merged.map((d, i) => [d.path, i]));
  for (const it of newItems) {
    const p = it && it.path;
    if (!p) continue;
    const rec = { path: p, name: (it && it.name) || path.basename(p), time: Date.now(), owner: owner || '' };
    const i = indexByPath.get(p);
    if (i != null) merged[i] = rec;
    else { indexByPath.set(p, merged.length); merged.push(rec); }
  }
  merged.sort((a, b) => (b.time || 0) - (a.time || 0));
  const trimmed = merged.slice(0, 200);
  writeDeliverables(trimmed);
  return trimmed;
}

// 文件名清洗：去掉控制字符（乱码来源）与 Windows 非法文件名字符，防止成果名/路径出现乱码。
function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

// 各闸门都带 taskId：用户叫停时 abortTask 能精确唤醒该任务正在等待的闸门（而非等 300s 超时）。
function waitMaterial(id, timeoutMs, taskId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingMaterials.delete(id); resolve(null); }, timeoutMs);
    pendingMaterials.set(id, { taskId: taskId || '', resolve: (v) => { clearTimeout(timer); resolve(v); } });
  });
}
function waitPickFiles(id, timeoutMs, taskId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingPickFiles.delete(id); resolve(null); }, timeoutMs);
    pendingPickFiles.set(id, { taskId: taskId || '', resolve: (v) => { clearTimeout(timer); resolve(v); } });
  });
}
function waitConfirm(id, timeoutMs, taskId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingActions.delete(id); resolve(null); }, timeoutMs);
    pendingActions.set(id, { taskId: taskId || '', resolve: (v) => { clearTimeout(timer); resolve(v); } });
  });
}
function waitClarify(id, timeoutMs, taskId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingClarify.delete(id); resolve(null); }, timeoutMs);
    pendingClarify.set(id, { taskId: taskId || '', resolve: (v) => { clearTimeout(timer); resolve(v); } });
  });
}
function waitPlanAck(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingPlanAck.delete(id); resolve(null); }, timeoutMs);
    pendingPlanAck.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
  });
}

// ---- Windows 本地 SAPI 语音识别（兜底方案） ----
function runSapiRecognize(timeoutSec = 6) {
  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.SetInputToDefaultAudioDevice()
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$ev = New-Object System.Threading.ManualResetEvent($false)
$txt = $null
$r.add_SpeechRecognized({ $script:txt = $args[0].Result.Text; $ev.Set() })
$r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Single)
if ($ev.WaitOne(${timeoutSec}000)) { Write-Output $txt } else { Write-Output '' }
$r.RecognizeAsyncCancel(); $r.Dispose()
`.trim();

  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript,
    ], { windowsHide: true });
    let out = ''; let err = '';
    // 【解码分类：给人看 → GBK 回退】
    //   · stdout：SAPI 识别出的**语音文本**，最终会显示给用户 / 喂给模型 ⇒ 属"给人看的文案"，
    //     走 decodeOutput()。脚本里虽然已经 `[Console]::OutputEncoding = UTF8`，
    //     但那只是"这次输出是 UTF-8"；decodeOutput 在 UTF-8 合法时**原样返回 utf8**
    //     （平手取 utf8），所以这一步对现有正确行为零影响，只是把"万一不是 UTF-8"兜住。
    //   · stderr：本来就是错误文案，是本次乱码修复的正靶子。
    //     ⚠️ 不要在这里写裸 `d.toString()`：powershell 的 stderr 走的是控制台代码页，
    //     中文 Windows 上是 cp936，按 utf-8 解就是一串 U+FFFD。
    ps.stdout.on('data', (d) => { out += decodeOutput(d); });
    ps.stderr.on('data', (d) => { err += decodeOutput(d); });
    const timer = setTimeout(() => { try { ps.kill(); } catch {} }, (timeoutSec + 5) * 1000);
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !err) resolve(out.trim());
      else resolve(null); // 失败返回 null，上层尝试其他方案
    });
    ps.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// 归一化 baseURL：trim 并补全 http:// 协议前缀。
// 用户手填地址常漏掉协议（如 "192.168.80.99:10003/v1"），导致 fetch 报 "Failed to parse URL from ..."。
function normalizeBaseURL(u) {
  if (typeof u !== 'string') return u;
  let s = u.trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  // 用户/配置里可能把完整 endpoint 粘进来（.../v1/chat/completions），
  // 去掉尾部 /chat/completions，避免后面再拼一次造成双写（/chat/completions/chat/completions）
  s = s.replace(/\/+chat\/completions\/?$/, '');
  return s;
}

// 生成上游 LLM 请求头：内网模型网关（apiKey 为空）不发送 Authorization，公网 DeepSeek 带 Bearer。
function authHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = 'Bearer ' + apiKey;
  return h;
}

/**
 * 自建后端入口地址（登录 / GEO 代理 / 技能都走它）。
 *
 * 0.8.0 变更：从裸 IP `http://124.222.215.53` 统一改为正式域名 `https://api.example.com`。
 * 为什么必须一起改：桌面端登录用的是 **api.example.com 的账号**（`admin` 是旧实例的账号，
 * 在 api.example.com 上会被拒），登录拿到的 token 只对同一实例有效。
 * 只改登录、不改 GEO 代理 = 用户能登进来、但每个业务接口都 401。
 */
const DOUYA_BASE_URL = 'https://api.example.com';
/** 旧版本落盘的裸 IP → 一次性迁移到正式域名（老用户 config.json 里可能仍是旧值）。 */
function normalizeGeoBase(u) {
  const s = String(u == null ? '' : u).trim().replace(/\/+$/, '');
  if (!s) return DOUYA_BASE_URL;
  if (/^https?:\/\/124\.222\.215\.53$/i.test(s)) return DOUYA_BASE_URL;
  return s;
}

/**
 * 【0.21.10】默认模型口径 —— 老板 2026-10-19 亲口确认，别再自己「纠正」成更整齐的名字：
 *
 *   内网网关 192.168.80.99:10003：模型名就是 **deepseek-v4-pro-wb**，
 *     但网关背后路由到的是 **DeepSeek-V4.1-Flash** —— 名字里带 pro，实际是 flash。
 *     ⇒ 内网这个名**一个字都不许改**。改成 deepseek-v4-flash-wb 这种「看起来更对」的名字，
 *       网关会直接不认，每个请求 400，而症状只是「豆芽不回话」，极难查到模型名上。
 *   公网 api.deepseek.com：模型名 **deepseek-flash**（= V4.1-Flash 的 API 名）。
 *
 * 所以两边是「名不同、物相同」：内网 pro-wb ≡ 公网 flash。
 * 【同源纪律】渲染层有三份等价实现（App.jsx / OnboardingV2.jsx / renderer-pet/App.jsx
 * 的 normalizeModel），改这里的名字必须同步改那三处 —— 与 isPublicDeepSeek 的既有约定一致。
 */
const DEFAULT_MODEL_INTERNAL = 'deepseek-v4-pro-wb';
const DEFAULT_MODEL_PUBLIC = 'deepseek-flash';
/**
 * 旧默认值 → 新默认值。**只收公网的 deepseek-v4-pro**：那是真 pro，与老板要的 flash 不一致，
 * 需要迁一次。内网的 deepseek-v4-pro-wb **不在此表** —— 它本来就已经是 flash，
 * 把它「迁」成别的名字只会把网关吃不认的名字写进配置。
 */
const LEGACY_MODEL_TO_FLASH = {
  'deepseek-v4-pro': DEFAULT_MODEL_PUBLIC,
};
/**
 * 迁移标记。用 flash-v2 而非 flash-v1：0.21.10 开发期曾短暂写成 v1 并误把内网名改成
 * deepseek-v4-flash-wb，换 tag 保证那批机器会被重新纠正一次（见下方幽灵名纠正）。
 */
const MODEL_MIGRATION_TAG = 'flash-v2';
/**
 * 幽灵名：0.21.10 开发期误写进配置的内网模型名，**内网网关并不存在这个模型**。
 * 见到就纠正回 DEFAULT_MODEL_INTERNAL，且这一步**不受 modelMigrated 标记保护** ——
 * 它修的不是「用户的选择」，是一个根本不存在的名字。
 */
const GHOST_MODEL_INTERNAL = 'deepseek-v4-flash-wb';

function defaultConfig(dataDir) {
  const cfg = {
    baseURL: process.env.LLM_BASE_URL || 'http://192.168.80.99:10003/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || DEFAULT_MODEL_INTERNAL,
    enableSearch: process.env.LLM_ENABLE_SEARCH !== '0',
    asrApiKey: process.env.ASR_API_KEY || '',
    ttsApiKey: process.env.TTS_API_KEY || '',
    wxAppId: process.env.WX_APP_ID || '',
    wxAppSecret: process.env.WX_APP_SECRET || '',
    shopBaseURL: process.env.SHOP_BASE_URL || 'https://supplier.example.com',
    shopAccount: process.env.SHOP_ACCOUNT || '',
    shopPassword: process.env.SHOP_PASSWORD || '',
    shopApiKey: process.env.SHOP_API_KEY || '',
    shopProductUrl: process.env.SHOP_PRODUCT_URL || '',
    shopOrderUrl: process.env.SHOP_ORDER_URL || '',
    // 上游货源商城（supplier.example.com）配置：独立命名空间 mmm*，与 上游货源 的 shop* 严格分区，语义互不替代。
    // 注意三者是三样东西：mmmPassword（上游货源登录密码）≠ shopPassword（上游货源 商城密码）≠ shopApiKey（上游货源 登录凭证）。
    mmmBaseURL: process.env.MMM_BASE_URL || 'https://supplier.example.com',
    mmmAccount: process.env.MMM_ACCOUNT || '',
    mmmPassword: process.env.MMM_PASSWORD || '',
    mmmApiKey: process.env.MMM_API_KEY || '',
    geoBaseURL: normalizeGeoBase(process.env.GEO_BASE_URL || DOUYA_BASE_URL),
    geoAccount: process.env.GEO_ACCOUNT || '',
    geoPassword: process.env.GEO_PASSWORD || '',
    geoApiKey: process.env.GEO_API_KEY || '',
    // 真实联网检索（provider 链式降级）：key 只存主进程，绝不回传渲染层。
    tavilyApiKey: process.env.TAVILY_API_KEY || '',
    bochaApiKey: process.env.BOCHA_API_KEY || '',
    // 看图（视觉识别）模型：留空 = 用 visionProvider.DEFAULT_VISION_MODEL（deepseek-v4-pro-wb）。
    visionModel: process.env.LLM_VISION_MODEL || '',
    // 单任务 token 预算覆盖（可调）。留空/非法 = 用 DEFAULT_TASK_TOKEN_BUDGET。
    // 场景：真正的大文件改造（如 100KB+ 的前端代码修 bug）需要更长预算，
    // 实测约 0.4M token；默认 0.6M 已覆盖，但允许用户按自己成本承受度调整。
    taskTokenBudget: Number(process.env.DOUYA_TASK_TOKEN_BUDGET) || 0,
    // 技能「渐进披露」（工具分层）的**出厂值**。2026-11-11 由本人确认改为默认开。
    //
    // 为什么这一项必须存在（否则整条链是断的）：`lazyTools.isLazyEnabled` 要求
    //   `payload.lazyTools === true`，而 payload 是前端 JSON.parse 的原始请求体 ——
    //   全仓没有前端传这个字段。没有配置项兜底，开关就永远 undefined，
    //   分层逻辑写完也从不执行（这正是本仓 backend.js:2904 自己写下的反面教材）。
    //
    // 关掉的两个口子（任一即可）：`DOUYA_LAZY_TOOLS=0` 起进程，或 config.json 写
    //   `"lazyTools": false`。两个口子都要留：运维要能不碰配置文件临时关，
    //   用户要能在家里的机器上长期关。
    //
    // ⚠️ 只认字符串 '0' 为关（不是 truthy 判断）：`DOUYA_LAZY_TOOLS=false` /
    //   `=no` 在 shell 里都常见，但把"写了个非空字符串"当成"要开"更安全 ——
    //   写错时的失败方向是**保持出厂行为（开）**，而不是悄悄关掉省 token 但多绕几步。
    lazyTools: process.env.DOUYA_LAZY_TOOLS !== '0',
  };
  try {
    const f = require('path').join(dataDir, 'config.json');
    if (require('fs').existsSync(f)) {
      const j = JSON.parse(require('fs').readFileSync(f, 'utf8'));
      if (j.baseURL) cfg.baseURL = normalizeBaseURL(j.baseURL);
      if (j.apiKey) cfg.apiKey = j.apiKey;
      if (j.model) cfg.model = j.model;
      if (j.model) cfg.model = j.model;
      // 渐进披露开关：只认布尔。写错类型（"false" 字符串 / 0 / 1）一律当没写，
      // 落回环境变量/出厂值 —— 与 lazyTools.resolveLazySwitch 的同一条口径。
      if (typeof j.lazyTools === 'boolean') cfg.lazyTools = j.lazyTools;
      // 【0.21.10】默认模型口径修正（老板 2026-10-19：内网名就叫 pro-wb，实际就是 flash）。
      //
      // ① 幽灵名纠正 —— **与 tag 无关，每次启动都查**：开发期曾把内网名误写成
      //    deepseek-v4-flash-wb，网关不认这个名字。凡在 config 里见到它，一律纠正回真正的内网名。
      //    这一步不能受 modelMigrated 保护，否则那批机器会永久停在坏名字上。
      // ② 公网老默认 pro → flash 的一次性迁移，并写回 modelMigrated 标记：用户之后在设置里
      //    显式改回 deepseek-v4-pro 不会被下次启动覆盖（否则就是「保存了却不生效」那类 bug）。
      //    内网的 deepseek-v4-pro-wb **不迁** —— 它本来就是 flash，迁了等于把名字改错。
      // 写回失败不致命：内存里已经纠正过，下次启动会重试。
      if (cfg.model === GHOST_MODEL_INTERNAL) cfg.model = DEFAULT_MODEL_INTERNAL;
      const needsMigration = j.modelMigrated !== MODEL_MIGRATION_TAG;
      if (needsMigration) {
        const upgraded = LEGACY_MODEL_TO_FLASH[cfg.model];
        if (upgraded) cfg.model = upgraded;
      }
      const needWrite = needsMigration || (j.model !== undefined && j.model !== cfg.model);
      if (needWrite) {
        try {
          const mf = require('path').join(dataDir, 'config.json');
          const cur = JSON.parse(require('fs').readFileSync(mf, 'utf8'));
          if (cur.model !== cfg.model || cur.modelMigrated !== MODEL_MIGRATION_TAG) {
            cur.model = cfg.model;
            cur.modelMigrated = MODEL_MIGRATION_TAG;
            require('fs').writeFileSync(mf, JSON.stringify(cur, null, 2));
          }
        } catch (e) {
          console.error('[Backend] model migration write-back failed:', e.message);
        }
      }
      if (typeof j.enableSearch === 'boolean') cfg.enableSearch = j.enableSearch;
      if (j.asrApiKey) cfg.asrApiKey = j.asrApiKey;
      if (j.ttsApiKey) cfg.ttsApiKey = j.ttsApiKey;
      if (j.wxAppId) cfg.wxAppId = j.wxAppId;
      if (j.wxAppSecret) cfg.wxAppSecret = j.wxAppSecret;
      if (j.shopBaseURL) cfg.shopBaseURL = j.shopBaseURL;
      if (j.shopAccount) cfg.shopAccount = j.shopAccount;
      if (j.shopPassword) cfg.shopPassword = j.shopPassword;
      if (j.shopApiKey) cfg.shopApiKey = j.shopApiKey;
      if (j.shopProductUrl) cfg.shopProductUrl = j.shopProductUrl;
      if (j.shopOrderUrl) cfg.shopOrderUrl = j.shopOrderUrl;
      // 上游货源商城：与 shop* 同款「有值才覆盖」写法
      if (j.mmmBaseURL) cfg.mmmBaseURL = j.mmmBaseURL;
      if (j.mmmAccount) cfg.mmmAccount = j.mmmAccount;
      if (j.mmmPassword) cfg.mmmPassword = j.mmmPassword;
      if (j.mmmApiKey) cfg.mmmApiKey = j.mmmApiKey;
      if (j.geoBaseURL) cfg.geoBaseURL = normalizeGeoBase(j.geoBaseURL);
      if (j.geoAccount) cfg.geoAccount = j.geoAccount;
      if (j.geoPassword) cfg.geoPassword = j.geoPassword;
      if (j.geoApiKey) cfg.geoApiKey = j.geoApiKey;
      if (j.tavilyApiKey) cfg.tavilyApiKey = j.tavilyApiKey;
      if (j.bochaApiKey) cfg.bochaApiKey = j.bochaApiKey;
      if (j.visionModel) cfg.visionModel = j.visionModel;
      // 单任务 token 预算：只接受正数，其余忽略（防手改 config 写成 0/负数/字符串把闸门关死）
      const b = Number(j.taskTokenBudget);
      if (Number.isFinite(b) && b > 0) cfg.taskTokenBudget = b;
    }
  } catch (e) {
    console.error('[Backend] load config.json failed:', e.message);
  }
  return cfg;
}

// 把配置写回本机 config.json（供设置界面保存 API/火山 key 用）
function saveConfig(dataDir, patch) {
  const f = require('path').join(dataDir, 'config.json');
  let existing = {};
  try {
    if (require('fs').existsSync(f)) {
      existing = JSON.parse(require('fs').readFileSync(f, 'utf8'));
    }
  } catch (e) {
    existing = {};
  }
  const merged = { ...existing, ...patch };
  require('fs').writeFileSync(f, JSON.stringify(merged, null, 2));
  return merged;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ===== 公关危机本地爬虫辅助（P0-4）=====

function crisisSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 平台之间的随机延迟 1500~3000ms：百度连续请求会触发反爬，必须节流。 */
function crisisRandDelay() {
  return crisisSleep(1500 + Math.floor(Math.random() * 1501));
}

/** 去掉 HTML 标签与实体，规整空白，得到纯文本。 */
function stripCrawlTags(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ');
  t = t.replace(/&amp;/g, '&');
  t = t.replace(/&lt;/g, '<');
  t = t.replace(/&gt;/g, '>');
  t = t.replace(/&quot;/g, '"');
  t = t.replace(/&#39;/g, "'");
  t = t.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  t = t.replace(/&[a-zA-Z]+;/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * 解析百度搜索结果页 HTML。
 * 命中安全验证/验证码页或页面过短 → blocked:true（反爬），items 为空。
 * 品牌词未命中（百度偶发返回汉字拆分的垃圾结果）的条目直接丢弃。
 * @param {string} html 结果页 HTML
 * @param {string} brand 品牌词
 * @param {number} maxPer 该平台最多保留条数
 * @returns {{blocked: boolean, items: Array<{title:string, summary:string, url:string, negative:boolean}>}}
 */
function parseBaiduResults(html, brand, maxPer) {
  const raw = String(html == null ? '' : html);
  // 反爬识别：安全验证 / 验证码页 / 页面异常短（正常结果页远大于 3000 字符）
  if (!raw || raw.length < 3000 || /安全验证|wappass|SeccodeSubmit/.test(raw)) {
    return { blocked: true, items: [] };
  }
  const blocks = raw.split(/<div[^>]*class="[^"]*result[^"]*"/).slice(1);
  const items = [];
  for (const block of blocks) {
    if (items.length >= maxPer) break;
    const m = block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const url = String(m[1] || '').trim();
    const title = stripCrawlTags(m[2]);
    if (!title) continue;
    let summary = '';
    const am = block.match(/<[^>]*class="[^"]*(?:c-abstract|content-right)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i);
    if (am) summary = stripCrawlTags(am[1]);
    const text = title + ' ' + summary;
    if (brand && !text.includes(brand)) continue;
    const negative = NEG_WORDS.some((w) => text.includes(w));
    items.push({ title, summary, url, negative });
  }
  return { blocked: false, items };
}

/**
 * 抓取单个平台：百度 site: 定向检索「品牌词 + 平台域名 + 负面词」。
 * 单个平台失败（超时/网络错/被反爬）不抛错，统一返回 blocked:true，由调用方继续下一个平台。
 */
async function scanBaiduPlatform(brand, platformKey, cfg, maxPer) {
  const query = `${brand} site:${cfg.domain} ${NEG_WORDS.slice(0, 5).join(' OR ')}`;
  const targetURL = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query) + '&rn=10';
  const ua = platformKey === 'weixin'
    ? WEIXIN_UA
    : CRAWLER_UAS[Math.floor(Math.random() * CRAWLER_UAS.length)];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const upstream = await fetch(targetURL, {
      method: 'GET',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ctrl.signal,
    });
    const html = await upstream.text();
    return parseBaiduResults(html, brand, maxPer);
  } catch {
    return { blocked: true, items: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注入 system 消息：先注入「企业/项目/任务上下文」（contextBuilder 生成，前端随请求带过来），
 * 再注入专家 systemPrompt（人设/能力级，一字不改）。两层都插入到 messages 最前面。
 */
function injectExpertSystemMessage(payload) {
  const messages = Array.isArray(payload.messages)
    ? payload.messages.map((m) => ({ role: m.role, content: m.content }))
    : [];

  const systemMessages = [];

  // 企业 → 项目 → 任务 上下文（阶段四 contextBuilder）
  if (payload.context && typeof payload.context === 'object') {
    const ctxText = payload.context.text;
    if (typeof ctxText === 'string' && ctxText.trim()) {
      systemMessages.push({ role: 'system', content: ctxText });
    }
  }

  // 专家人设/能力 Prompt
  if (payload.expert) {
    const expert = getExpert(payload.expert);
    if (expert) {
      systemMessages.push({ role: 'system', content: expert.systemPrompt });
    }
  }

  // 新注入的上下文/专家始终放在最前（即使历史里已带 system，也以最新注入优先）
  return [...systemMessages, ...messages];
}

/**
 * 粗估 messages 的 token 数（用于判断是否需要压缩上下文）。
 * 中文约 1 字符 ≈ 1 token，英文/数字约 4 字符 ≈ 1 token，这里取 1.5 字符 ≈ 1 token 的保守中值，
 * 再加每条消息约 4 token 的结构开销。
 */
function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : '';
    total += Math.ceil(c.length / 1.5) + 4;
  }
  return total;
}

/**
 * 调用上游 LLM 把较早的对话历史压缩成一段中文摘要。
 * 失败时抛出异常，由调用方决定退化策略（丢弃较早历史）。
 */
async function summarizeHistory(historyText, payload, cfg) {
  const baseURL = normalizeBaseURL(payload.baseURL || cfg.baseURL);
  const apiKey = payload.apiKey || cfg.apiKey;
  const model = payload.model || cfg.model;
  const upstreamURL = baseURL.replace(/\/+$/, '') + '/chat/completions';

  const resp = await fetch(upstreamURL, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你是对话历史压缩器。请把下面的对话压缩成一段简洁的中文摘要，保留：用户的目标与需求、已完成的事项、关键决定与结论、待办事项、以及后续对话可能需要的关键上下文。直接输出摘要正文，不要任何解释或前缀。',
        },
        { role: 'user', content: historyText },
      ],
      stream: false,
      temperature: 0.2,
      max_tokens: 500,
      reasoning_effort: 'none',
    }),
  });

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch {}
    throw new Error('summarize HTTP ' + resp.status + ' ' + detail.slice(0, 200));
  }

  const data = await resp.json();
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('summarize empty result');
  }
  return content.trim();
}

// ===== thinking（深度思考）模式契约守卫 =====
// 实测契约（2026-09-15 查证 DeepSeek 官方 thinking 模式文档 + 多起真实事故）：
//   「两个 user 消息之间，如果模型进行了工具调用，则中间 assistant 的 reasoning_content 需参与
//     上下文拼接，并在后续所有 user 交互轮次中必须原样回传给 API。」
// 违反时上游返回 400：The reasoning_content in the thinking mode must be passed back to the API.
// 本机网关（192.168.80.99:10003）是异构上游池，只有部分通道会做这项校验 —— 故表现为「经常报错」
// 而非每次必报（实测 35 次定向探测全 200，无法本地复现）。因此必须做结构性保证：
// 不以「本机跑一次没报错」作为安全判据。
const REASONING_CONTRACT_RE = /reasoning_content[\s\S]{0,120}?must be passed back|content\[\]\.thinking[\s\S]{0,120}?must be passed back/i;

/** 该错误文本是否为 thinking 契约类 400（DeepSeek 的 reasoning_content 版 / Claude 的 content[].thinking 版都算）。 */
function isReasoningContractError(text) {
  return REASONING_CONTRACT_RE.test(String(text || ''));
}

/**
 * 判断对话里是否存在「带 tool_calls 却没有可用 reasoning_content」的 assistant 轮。
 * 这种轮一旦在 thinking 模式下回传，就会触发上面那条契约。
 * 注意：空串同样算「不可用」—— 空串只是字段占位，不是真实推理，不能当作合规回传。
 */
function hasReasoningLossyToolTurn(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 &&
      (typeof m.reasoning_content !== 'string' || m.reasoning_content === '')
  );
}

// ===== 深度思考（thinking）判定：多信号综合 =====
// 背景（2026-09-15 修复）：原实现只用一条 DEEP_THINK_HINTS 正则去「猜用户措辞」决定是否深度思考，
// 导致 agent 任务里最高频的跟进指令（继续 / 再试一下 / 修一下 / 部署 / 上线 / 看下有没有问题 …）
// 全部漏检 → 掉进零思考（reasoning_effort:'none'）→ 真 agent 任务被迫「不带脑子干活」。
// 这里把判定升级为**多信号综合**：任一信号命中即开思考；纯闲聊/纯查询（无任何信号）不开，
// 以保证「闲聊不被拖慢」（实测 high ≈ 11.1s / none ≈ 2.1s，慢 6~8 倍）。
// 所有信号均在本地同步完成：零网络、零模型调用、零 I/O（只在内存里判字符串）。
//
// ⚠️ 判定必须在一个请求的**第 0 轮**就算对并锁定（见 runAgentLoop 内的注释与 hasReasoningLossyToolTurn 守卫）：
//    thinking 契约要求工具轮 assistant 的 reasoning_content 原样回传；若第 0 轮判 none 又调了工具，
//    该轮 assistant 天生没有 reasoning_content，之后各轮会被守卫永久关闭，无法中途「补开」。

/**
 * 信号③（降级为加分项）——动作/产物关键词：用户明确要「做一件事/产出」。
 * 沿用原 DEEP_THINK_HINTS（尽量不改变既有行为），但从「唯一依据」降级为「多信号之一」。
 */
const DEEP_THINK_HINTS = /(帮我)?(做|生成|写|画|建|改|创建|制作|开发|编写|设计|搭|弄|分析|统计|整理|汇总|翻译|总结|查|算|列|比较|评估|诊断|规划|测算)(一个|一份|个|篇|张|份)?|(网页|网站|PPT|ppt|Excel|excel|Word|word|文档|报告|方案|海报|图片|视频|程序|脚本|代码|小程序|图表|表格|简历|周报|日报|大纲|清单|对比|评测|调研|需求)/;

/**
 * 信号④——短促跟进指令/纠偏话术：agent 任务里最高频、且旧关键词正则**全部漏检**的一类。
 * 这些句子本身往往不含动作名词，但语义上明确是「继续/修正某个进行中的任务」。
 * 覆盖：「继续 / 再试一下 / 修一下这个bug / 部署 / 上线吧 / 看下有没有问题 /
 *        这些数据你处理下 / 重新来一遍 / 你看着办」（旧版全部零思考）。
 */
const FOLLOW_UP_HINTS = /(继续|接着|再试|重试|重新(来|做|开始|生成|弄|试)|再来一?[遍次]|重做|修一?[下个]|改一?[下个]|调整一?下|优化一?下|部署|上线|发布|打包|测一?[下试]|测试|检查|查一?下|看一?[下眼]|处理一?下|弄一?[下上]|搞定|收尾|完善|补一?[全下]|你看着办|按你(说的|意思|判断|想法))/;

/** 取本次请求最后一条用户消息的纯文本（content 可能是 string，也可能是多模态数组）。 */
function lastUserTextOf(payload) {
  const list = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const u = list[list.length - 1] || {};
  const c = u.content || '';
  return typeof c === 'string' ? c : JSON.stringify(c);
}

// ===================== 跨轮「已经问过」的判据（2026-10-16）=====================
// 事故原话：「豆芽反复追问，用户不答它就不干活」。
// 根因之一：`clarifyCalls` / `materialCalls` 都是 **runAgentLoop 内的单轮局部变量**，
//   用户每说一句话就开新一轮 runAgentLoop，两个计数**归零** ⇒ 模型可以无限次重新问。
// 所以「问过没有」必须有一个**比单轮局部量活得更久**的判据：conversation 数组本身。
//   它来自 `payload.messages`（compressContext(injectExpertSystemMessage(payload))），
//   随会话历史传递，能看到上一轮问出的那条 tool 消息。
//
// ⚠️⚠️ 边界警告（2026-10-16 团队评审记录，**别把它当成"跨轮持久判据"**）：
//   下面的 helper 依赖 conversation 里那两条 tool 消息**仍然存在**。
//   而 conversation 进 runAgentLoop 时已经过 `compressContext` 压缩 ——
//   一旦那两条消息被压缩/裁剪掉，判据会**静默失效**：
//     · 不会抛错、不会打日志、也不会有任何测试转红；
//     · 唯一的表现就是**退化成"每轮重新问一遍"** —— 也就是这次要修的那个病又回来了。
//   所以定位要准确：它是「**会话历史可见期内**的判据」，不是真正持久的标记。
//   若要根治，正确方向是在 tasks.json 里给每个任务挂 `clarifyAnswered` / `materialGiven` 字段
//   （per-task 外挂标记），而不是继续在这里加前缀匹配。本轮评估后**未做**该改动（改数据结构风险大于收益），
//   已记录为已知缺口 —— 半年后如果又出现"反复追问"，先查这里是不是被压缩吃掉了。
//
// ⚠️ 判据一律用 **startsWith 前缀匹配**，不用 includes —— 这些文字（"用户提供的素材" 等）
//    完全可能出现在别处的正文/引用里，includes 会误伤成"已经问过"，把该问的挡掉。
// ⚠️ 这些前缀必须与下面真正 push 的那两条 content **逐字一致**；改文案时两处一起改，
//    否则判据会静默失效（失效后不会报错，只会退化成"每轮重新问一遍"——正是这次要修的病）。
const CLARIFY_ANSWERED_PREFIX = '[用户回答需求澄清]';       // clarify_requirements 拿到真实答复
const CLARIFY_TIMEOUT_PREFIX = '用户未回答需求澄清';        // clarify_requirements 超时/取消
const MATERIAL_GIVEN_PREFIX = '用户提供的素材：';            // request_material 拿到非空素材
const MATERIAL_SKIPPED_PREFIX = '用户跳过提供素材';          // request_material 用户点了「跳过」

/**
 * 会话历史里是否已有「以某个前缀开头的 tool 消息」。
 * @param {Array} conversation 完整对话数组（含历史轮）
 * @param {string} prefix 前缀，逐字匹配
 * @returns {boolean}
 */
function conversationHasToolPrefix(conversation, prefix) {
  const list = Array.isArray(conversation) ? conversation : [];
  const p = String(prefix || '');
  if (!p) return false; // 空前缀等于"永远命中"，必须挡掉（否则一次都不问）
  for (const m of list) {
    if (!m || m.role !== 'tool') continue;
    const c = typeof m.content === 'string' ? m.content : '';
    if (c.startsWith(p)) return true;
  }
  return false;
}

/** 信号①——历史里是否已有「模型调过工具」的助手轮 ⇒ 正处于一个进行中的 agent 任务。 */
function hasToolActivity(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  );
}

/**
 * 综合所有信号，返回命中的信号名列表（便于单测逐条断言与线上诊断）。
 * ① history-tools：进行中的 agent 任务（历史/本次请求内已有工具调用）
 * ② attachments ：本次带附件（用户给了素材要处理）
 * ③ keyword     ：动作/产物关键词（DEEP_THINK_HINTS，加分项）
 * ④ followup    ：短促跟进指令（FOLLOW_UP_HINTS）
 */
function thinkSignals(payload, messages) {
  const signals = [];
  if (hasToolActivity(messages)) signals.push('history-tools');
  if (payload && Array.isArray(payload.attachments) && payload.attachments.length > 0) signals.push('attachments');
  const text = lastUserTextOf(payload);
  if (DEEP_THINK_HINTS.test(text)) signals.push('keyword');
  if (FOLLOW_UP_HINTS.test(text)) signals.push('followup');
  return signals;
}

/** 是否开启深度思考：命中任一信号即开；纯闲聊/纯查询（无任何信号）不开，避免无谓变慢。 */
function decideThink(payload, messages) {
  return thinkSignals(payload, messages).length > 0;
}

/**
 * 上下文压缩：当历史过长（估算 token 超过阈值）时，把较早的对话压缩成一段摘要，
 * 用「摘要 + 最近若干条」替代完整历史，控制 token 成本、避免超上下文窗口。
 * 压缩失败时退化为「保留最近若干条、丢弃更早」，绝不阻塞对话。
 */
async function compressContext(messages, payload, cfg) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const MAX_TOKENS = 8000; // 超过该估算值才触发压缩
  const KEEP_RECENT = 8;   // 始终保留最近的 N 条 user/assistant 消息
  const MIN_HISTORY = 12;  // 历史不足此条数时不压缩

  if (estimateTokens(messages) <= MAX_TOKENS) return messages;

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const hist = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (hist.length < MIN_HISTORY) return messages;

  const recent = hist.slice(-KEEP_RECENT);
  const older = hist.slice(0, -KEEP_RECENT);
  if (older.length === 0) return messages;

  const historyText = older
    .map((m) => (m.role === 'user' ? '用户：' : '助手：') + (m.content || ''))
    .join('\n');

  let summary = null;
  try {
    summary = await summarizeHistory(historyText, payload, cfg);
  } catch (e) {
    console.warn('[context] 摘要生成失败，退化为截断：', e && e.message);
    summary = null;
  }

  if (!summary) {
    return [...systemMsgs, ...recent];
  }

  console.log('[context] 已压缩上下文：', older.length, '条较早消息 -> 摘要（原', historyText.length, '字符）');
  return [
    ...systemMsgs,
    {
      role: 'system',
      content: '【较早对话摘要】\n' + summary + '\n\n（以上是更早对话的压缩摘要，请结合下面最近的对话继续回答）',
    },
    ...recent,
  ];
}

// ===================== 循环内上下文压缩（2026-09-23） =====================
// 背景：compressContext 原先**只在任务开始时调用一次**（见 runAgentLoop 里那行），进了
//   `for (turn < MAX_TURNS)` 之后每轮都把整份 conversation 全量重发（body.messages = conversation），
//   于是单轮成本随轮次单调增长、整任务呈 O(N²)，长任务必然擦线撞上 token 预算。
// 所以这里补一个**循环内**的压缩，触发条件是「上下文实际压力」而不是固定轮次 ——
//   有的任务 3 轮就极长，有的任务 10 轮仍很短，按轮次触发会同时误伤两头。
//
// ★ 与 compressContext 的关键差别：**必须整组取舍**。
//   循环里 assistant(tool_calls) 与紧随其后的 tool 结果必须成对出现（上游会校验），
//   而原来的 compressContext 只挑 role==='user'|'assistant'、把 role==='tool' 全滤掉 ——
//   在开局调用时安全（那时还没有工具消息），搬到循环内就会拆散配对、直接 400。
//   因此这里先把消息切成「不可分割的组」，再**整组**保留或整组丢弃。

/**
 * 把消息序列切成不可分割的组。
 * 组类型：system（永不丢弃）／tools（assistant + 其全部 tool 结果）／text（user|assistant 纯文本）
 * @returns {Array<{type:string, role?:string, msgs:Array}>}
 */
function splitMessageGroups(messages) {
  const groups = [];
  let cur = null;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') { cur = null; groups.push({ type: 'system', msgs: [m] }); continue; }
    if (m.role === 'tool') {
      if (cur && cur.type === 'tools') { cur.msgs.push(m); continue; }
      // 孤儿 tool（正常路径不该出现）：单独成组原样保留，绝不与别的组混排
      groups.push({ type: 'orphan-tool', msgs: [m] });
      cur = null;
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      cur = { type: 'tools', msgs: [m] };
      groups.push(cur);
      continue;
    }
    cur = null;
    groups.push({ type: 'text', role: m.role, msgs: [m] });
  }
  return groups;
}

/** 把要丢弃的组文字化，供摘要器消费（工具结果只留「调了什么」，原始结果不喂给摘要器）。 */
function droppedGroupsToText(groups, dropIdx) {
  const lines = [];
  for (const i of dropIdx) {
    const g = groups[i];
    if (!g) continue;
    if (g.type === 'text') {
      lines.push((g.role === 'user' ? '用户：' : '助手：') + String(g.msgs[0].content || ''));
    } else if (g.type === 'tools') {
      const a = g.msgs[0];
      const names = (a.tool_calls || [])
        .map((t) => (t && t.function && t.function.name) || '')
        .filter(Boolean)
        .join('、');
      const said = String(a.content || '').trim();
      lines.push('助手（调用工具 ' + names + '）' + (said ? '：' + said : '') + '；该次工具结果已省略');
    }
  }
  return lines.join('\n');
}

// ── 工具结果免模型剪枝（2026-11-06）─────────────────────────────────────────
// 与下面一段的循环内压缩是**两件事**，顺序不能反：
//   ① prune：按字符数剪掉 tool 结果正文，保留头尾，结构一个字节不动 —— 不调模型、不花钱
//   ② summary：剪完重新测压力，**仍然超阈值**才花一次模型调用写摘要
// 为什么先剪：让已经跑不动的轻量模型去写摘要，写砸了就退化成整段丢弃，模型突然失去全部
// 工作记忆开始原地打转 —— 那正是用户说的"卡死"。剪枝把大部分场景挡在摘要之前。
const PRUNE_MARK = '【已剪枝】';       // 测试/日志识别用，勿改（改了就无法判别"剪过没剪过"）
const PRUNE_THRESHOLD_CHARS = 8192;    // 单条工具结果超过此字符数才剪
const PRUNE_HEAD_CHARS = 4096;         // 保留开头
const PRUNE_TAIL_CHARS = 1024;         // 保留结尾

// ★ 不变量自检：HEAD + TAIL + 标记预留必须严格小于 THRESHOLD，否则「剪完仍然超阈值」，
//   剪枝白做（压力照报超阈值 ⇒ 直接回落摘要）。这里在**加载期**就喊一声，
//   而不是等到线上发现「剪枝上线了但没效果」。改了这三个常量就必须过这一关。
//   ⚠️ 反面教材就在本卡的规格里：§6.2 曾建议「读长文件改错位置就用 HEAD=8192」——
//   8192 + 1024 + 标记 ≈ 9394 > 阈值 8192 ⇒ 剪完仍超阈值，剪枝等于白做。那条建议是错的。
const PRUNE_MARKER_RESERVE = 512;  // 标记文案实测 ~178，留余量
if (PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS + PRUNE_MARKER_RESERVE >= PRUNE_THRESHOLD_CHARS) {
  console.warn('[context] 剪枝参数不自洽：HEAD(' + PRUNE_HEAD_CHARS + ') + TAIL(' + PRUNE_TAIL_CHARS
    + ') + 标记预留(' + PRUNE_MARKER_RESERVE + ') >= THRESHOLD(' + PRUNE_THRESHOLD_CHARS
    + ') ⇒ 剪完仍会超阈值，剪枝不生效。请调大 THRESHOLD 或调小 HEAD/TAIL。');
}

// 开关：默认**开**，DOUYA_PRUNE=0 才关。
// ⚠️ 默认开 = 生产行为变更（与 DOUYA_CTX_COMPRESS 加开关时"默认不变"不同）。
//   之所以选默认开：本仓有现成反例 —— 渐进披露 payload.lazyTools 默认关着，结果全仓没有
//   生产者，功能写完了从来没用过。默认关 = 没接线，这个坑不再踩第二次。
function toolResultPruneEnabled() { return process.env.DOUYA_PRUNE !== '0'; }

/**
 * 省略标记（模型视角的三要素：省了多少 / 窗口边界 / 可执行的补救动作）。
 * head/tail 可传，未传回落常量 —— 让计划期统计和实际拼出的文本永远同一口径，
 * 不会出现"标记里说保留 4096、实际保留别的数"这种对不上。
 */
function pruneMarker(omitted, total, toolName, head, tail) {
  const h = Number(head) > 0 ? Number(head) : PRUNE_HEAD_CHARS;
  const t = Number(tail) > 0 ? Number(tail) : PRUNE_TAIL_CHARS;
  return '\n\n' + PRUNE_MARK + '此处省略 ' + omitted + ' 字符（该工具输出原始共 ' + total
    + ' 字符，本次只保留开头 ' + h + ' 与结尾 ' + t + ' 字符）。'
    + '⚠️ 这**不是**输出全文，也不代表文件/结果只有这么长 —— 不要据此得出「已经读完」「只有这些内容」的结论。'
    + '需要中间部分时，请重新调用 ' + toolName + ' 并缩小范围（指定行号区间、更精确的过滤条件，或更少的路径）。\n\n';
}

/**
 * 从同组 assistant 的 tool_calls 里按 tool_call_id 反查工具名。
 * 为什么必须反查：全仓所有 conversation.push({role:'tool',...}) 只有 role/tool_call_id/content
 * 三个字段，**没有 name** —— 工具名唯一的来源就是发起它的那条 assistant.tool_calls。
 */
function toolNameOf(group, msg) {
  const a = group && group.msgs && group.msgs[0];
  const tcs = (a && Array.isArray(a.tool_calls)) ? a.tool_calls : [];
  const hit = tcs.find((t) => t && t.id === msg.tool_call_id);
  return (hit && hit.function && hit.function.name) || '该工具';
}

/**
 * **纯计算**：算出这一轮要剪哪些组、剪完多少字符（不发网络、不改入参）。
 * 不变量：只改 content 文本；消息条数、顺序、role、tool_call_id、tool_calls 全部不动
 *        ⇒ tool_calls 配对在结构上不可能被破坏（剪枝 = 零结构变更）。
 * 覆盖性可证明：splitMessageGroups 把**每一条** role==='tool' 必然归入 tools 或 orphan-tool 组
 *        （:2709-2714），所以按组遍历不可能漏掉任何 tool 结果，不需要第二套分组。
 * ⚠️ 但「tool 消息不漏」≠「数组元素不漏」：splitMessageGroups 对 null / 非对象是 continue
 *        跳过（它 :2707），这类元素不在任何组里，而执行器是按组重建数组的。所以下面
 *        另做一次覆盖数对齐，不相等就 fail-closed 拒绝剪枝（见 uncovered-messages）。
 */
function planToolResultPrune(messages, opts) {
  const o = opts || {};
  const th = Number(o.thresholdChars) > 0 ? Number(o.thresholdChars) : PRUNE_THRESHOLD_CHARS;
  const head = Number(o.headChars) > 0 ? Number(o.headChars) : PRUNE_HEAD_CHARS;
  const tail = Number(o.tailChars) > 0 ? Number(o.tailChars) : PRUNE_TAIL_CHARS;

  const groups = splitMessageGroups(messages);

  // ★ fail-closed：splitMessageGroups 会 continue 跳过 null / 非对象元素（见它自己的 :2707），
  //   这些元素不属于任何组。而执行器是按组重建数组的 ⇒ 它们会被静默吞掉，
  //   「零增删」这条不变量就出现一个只在畸形输入下触发的例外。
  //   这里先把「组一共覆盖了多少条」与入参条数对齐：不相等就**拒绝剪枝**，
  //   让 pruneToolResults 走 :2836 原样返回同一个数组引用（零行为变化）。
  //   ≠ 防御性编程：宁可这一次不剪，也不能有一条消息凭空消失。
  const covered = groups.reduce((n, g) => n + g.msgs.length, 0);
  if (covered !== messages.length) {
    return {
      ok: false, reason: 'uncovered-messages',
      groups, prunedGroupIdx: new Set(),
      prunedCount: 0, charsBefore: 0, charsAfter: 0, omittedChars: 0,
      headChars: head, tailChars: tail, thresholdChars: th,
      uncovered: messages.length - covered,
    };
  }
  const prunedGroupIdx = new Set();
  let charsBefore = 0, charsAfter = 0, prunedCount = 0, omittedChars = 0;
  groups.forEach((g, gi) => {
    let touched = false;
    for (const m of g.msgs) {
      if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
      const c = m.content;
      charsBefore += c.length;
      // 用**实际拼出来的长度**判定，别用 omitted > 0 估算：
      //   标记本身有 175~179 字符（随 omitted 位数浮动），漏算它会让
      //   5120 < len < 5295 这段区间的结果反而**比原文更长**（实测 5150 → 5294）。
      //   判据：结果长度 >= 原文长度 ⇒ 不剪（宁可这条不剪，也不能剪出更大的东西）。
      //   注意 omittedChars 仍按 c.length - head - tail 累计 —— 那是「省掉的中间段」语义，
      //   与这里判「总长是否变短」是两件事，不要混。
      const mkLen = pruneMarker(c.length - head - tail, c.length, toolNameOf(g, m), head, tail).length;
      const resultLen = head + tail + mkLen;
      if (c.length <= th || c.includes(PRUNE_MARK) || resultLen >= c.length) { charsAfter += c.length; continue; }
      charsAfter += resultLen;
      prunedCount += 1; omittedChars += (c.length - head - tail); touched = true;
    }
    if (touched) prunedGroupIdx.add(gi);
  });
  return {
    ok: prunedGroupIdx.size > 0,
    reason: prunedGroupIdx.size > 0 ? 'prune' : 'nothing-to-prune',
    groups, prunedGroupIdx, prunedCount, charsBefore, charsAfter, omittedChars,
    headChars: head, tailChars: tail, thresholdChars: th,
  };
}

/**
 * 按计划执行。**返回新数组**，原 messages 及其中的消息对象一个都不改
 * （原始全文永远留在 conversation 里，只有"发出去的那份副本"被剪）。
 * 不变量（两条，缺一不可）：
 *   ① HEAD + TAIL + 标记长度 < THRESHOLD ⇒ 剪过的内容下次仍不超阈值（幂等）。
 *      4096 + 1024 + ~150 < 8192 成立；另加 PRUNE_MARK 命中即跳过做二道防御。
 *   ② head + tail + 标记长 < 原文长度 ⇒ 剪过一定比原文**短**，否则不剪。
 *      ⚠️ 别写成「omitted > 0 ⇒ 更短」——那句是**错的**：标记自身有 175~179 字符，
 *      5120 < len < 5295 这段区间 omitted 明明 > 0，剪完却更长（实测 5150 → 5294）。
 *      标记长度随 omitted 位数浮动，不是常量，所以必须比实际拼出来的长度。
 */
function pruneToolResults(messages, opts) {
  const plan = planToolResultPrune(messages, opts);
  if (!plan.ok) return { messages, pruned: false, plan };
  const out = [];
  plan.groups.forEach((g, gi) => {
    if (!plan.prunedGroupIdx.has(gi)) { out.push(...g.msgs); return; }
    for (const m of g.msgs) {
      // 与 planToolResultPrune 的判据**必须逐字一致**（同一组参数 + 同一个 marker 函数判同一件事）：
      // 计划说「这条剪」执行器就必须剪、计划说「不剪」执行器就不能动，否则统计与结果不一致。
      if (!m || m.role !== 'tool' || typeof m.content !== 'string'
        || m.content.length <= plan.thresholdChars || m.content.includes(PRUNE_MARK)) { out.push(m); continue; }
      const c = m.content;
      const omitted = c.length - plan.headChars - plan.tailChars;
      const marker = pruneMarker(omitted, c.length, toolNameOf(g, m), plan.headChars, plan.tailChars);
      if ((plan.headChars + plan.tailChars + marker.length) >= c.length) { out.push(m); continue; }
      out.push({ ...m, content: c.slice(0, plan.headChars) + marker + c.slice(-plan.tailChars) });
    }
  });
  return { messages: out, pruned: true, plan };
}

/**
 * **纯计算**：算出这一轮该丢哪些组、保留哪些组（不发网络请求，便于单测直接断言）。
 * 不变量：返回的 keepSet 只含**完整组**、dropIdx 只含**完整组**，两者并集 = 全部非 system 组，
 *         且 system 组永远不在 dropIdx 里。⇒ 任何 tool_calls 都不会与它的 tool 结果分离。
 */
function planLoopCompress(messages, opts) {
  const o = opts || {};
  const KEEP_RECENT_GROUPS = Number(o.keepRecentGroups) > 0 ? Number(o.keepRecentGroups) : 12;
  const MIN_GROUPS = Number(o.minGroups) > 0 ? Number(o.minGroups) : 16;

  const groups = splitMessageGroups(messages);
  const contentIdx = [];
  groups.forEach((g, i) => { if (g.type !== 'system') contentIdx.push(i); });

  if (contentIdx.length < MIN_GROUPS) {
    return { ok: false, reason: 'too-few-groups', groups, contentIdx, keepFirstIdx: -1, dropIdx: [], keepSet: new Set(), historyText: '' };
  }
  const keepFrom = contentIdx.length - KEEP_RECENT_GROUPS;
  if (keepFrom <= 0) {
    return { ok: false, reason: 'nothing-to-drop', groups, contentIdx, keepFirstIdx: -1, dropIdx: [], keepSet: new Set(), historyText: '' };
  }
  const dropIdx = contentIdx.slice(0, keepFrom);
  const keepSet = new Set(contentIdx.slice(keepFrom));
  const keepFirstIdx = contentIdx[keepFrom];
  const dropSet = new Set(dropIdx);
  return {
    ok: true,
    reason: 'compress',
    groups,
    contentIdx,
    dropIdx,
    dropSet,
    keepSet,
    keepFirstIdx,
    historyText: droppedGroupsToText(groups, dropIdx),
    keepRecentGroups: KEEP_RECENT_GROUPS,
  };
}

/**
 * 循环内压缩：保留全部 system + 最近 K 个内容组，更早的组压成一段摘要（摘要失败则纯丢弃）。
 * @param {object} [deps] 仅测试注入用：{ summarize }，默认走真实 summarizeHistory
 * @returns {Promise<{messages:Array, compressed:boolean, droppedGroups:number, tokensBefore:number, tokensAfter:number, summarized:boolean, reason:string}>}
 */
async function compressContextInLoop(messages, payload, cfg, opts, deps) {
  const tokensBefore = estimateTokens(messages);
  const plan = planLoopCompress(messages, opts);
  if (!plan.ok) {
    return { messages, compressed: false, droppedGroups: 0, tokensBefore, tokensAfter: tokensBefore, summarized: false, reason: plan.reason };
  }

  const summarize = (deps && typeof deps.summarize === 'function') ? deps.summarize : summarizeHistory;
  let summary = null;
  try {
    summary = await summarize(plan.historyText, payload, cfg);
  } catch (e) {
    console.warn('[context] 循环内摘要失败，退化为整组丢弃：', e && e.message);
    summary = null;
  }

  const out = [];
  for (let i = 0; i < plan.groups.length; i++) {
    // 摘要插在「第一个被保留的组」之前
    if (summary && i === plan.keepFirstIdx) {
      out.push({
        role: 'system',
        content: '【较早对话摘要】\n' + summary
          + '\n\n（以上是更早对话的压缩摘要，请结合下面最近的对话继续；'
          + '其中被省略的工具原始结果如仍需要，可重新调用对应技能获取）',
      });
    }
    // 早期非 system 组：整组丢弃（连同其全部 tool 结果，保证不产生孤儿）
    if (i < plan.keepFirstIdx && plan.groups[i].type !== 'system') continue;
    out.push(...plan.groups[i].msgs);
  }

  const tokensAfter = estimateTokens(out);
  console.log('[context] 循环内压缩：丢弃', plan.dropIdx.length, '组，保留', plan.keepSet.size,
    '组；token', tokensBefore, '->', tokensAfter, summary ? '（含摘要）' : '（摘要失败，纯丢弃）');
  return {
    messages: out,
    compressed: true,
    droppedGroups: plan.dropIdx.length,
    tokensBefore,
    tokensAfter,
    summarized: !!summary,
    reason: 'compress',
  };
}

/**
 * 上下文是否该压了 —— **按实际压力判定，不按轮次**。
 * 压力 = 当前 conversation 的估算 token 占「本任务剩余预算」的比例，同时给一个绝对上限兜底。
 * 为什么两者都要：小预算任务要早压（比例敏感），而绝对上限防止「预算很大所以一路不压」
 * 把单轮 prompt 撑到上游上下文窗口之外。
 */
function shouldCompressInLoop(messages, o) {
  const c = o || {};
  const tokens = estimateTokens(messages);
  const budget = Number(c.tokenBudget) > 0 ? Number(c.tokenBudget) : 0;
  const used = Number(c.usedTokens) > 0 ? Number(c.usedTokens) : 0;
  const share = Number(c.share) > 0 ? Number(c.share) : CTX_COMPRESS_SHARE;
  const hardCap = Number(c.hardCap) > 0 ? Number(c.hardCap) : CTX_COMPRESS_HARD_CAP;
  const floor = Number(c.floor) > 0 ? Number(c.floor) : CTX_COMPRESS_FLOOR;
  // ⚠️ 读这个返回值的 `threshold` 字段要小心：本分支是**早退**，threshold 填的是 floor，
  //    不是真实阈值（真实阈值 = max(floor, min(budget*share, hardCap))，见下面几行）。
  //    想探真实阈值必须喂够量的 messages 让它走到底，否则会拿到 12000 这个假数。
  //    实测同一组参数：喂 [] 或 1 字符 ⇒ threshold:12000（floor）；
  //    喂 30000 字符 ⇒ threshold:21000（真实阈值，budget 600000 × share 0.035）。
  //    这个函数是导出的、门禁与运维都会直接调，「同名不同义」比缺字段更危险 ——
  //    调用方不会怀疑一个叫 threshold 的字段，据此判定就全错。
  if (tokens < floor) return { compress: false, tokens, threshold: floor, reason: 'below-floor' };
  const remaining = budget > 0 ? Math.max(budget - used, 0) : 0;
  const byShare = budget > 0 ? Math.min(budget * share, hardCap) : hardCap;
  const threshold = Math.max(floor, byShare);
  return { compress: tokens >= threshold, tokens, threshold, remaining, reason: tokens >= threshold ? 'over-threshold' : 'under-threshold' };
}

// 循环内压缩的默认参数（集中在此，便于调参与单测直接引用，避免散落在循环体里的魔法数字）
// ⚠️ 这三个数不是拍脑袋来的，是**按本机真实账单反推**的（2026-09-23）：
//   实测平均每次模型调用 prompt ≈ 28397 token；若把阈值设成 60000，正常任务根本到不了，
//   等于"修了但没生效"（首版就是这么错的，被 unit-context-budget 的 P3/R1 当场抓出来）。
//   所以按「单轮上下文不超过总预算的 3.5%，且绝对不超过 28000」定阈值 ⇒ 约 2 万 token 起压，
//   压完落到 1.1~1.7 万区间，稳定不再单调膨胀。
const CTX_COMPRESS_FLOOR = 12000;        // 单轮上下文低于此值不值得压（摘要本身也要花一次模型调用）
const CTX_COMPRESS_HARD_CAP = 28000;     // 单轮上下文绝对上限（防「预算很大所以一路不压」把 prompt 撑出上游窗口）
const CTX_COMPRESS_SHARE = 0.035;        // 单轮上下文不超过单任务总预算的 3.5%
const CTX_KEEP_RECENT_GROUPS = 8;        // 压缩时保留最近 8 个「消息组」（组 = 不可分割的 tool_calls 配对）
const CTX_MIN_GROUPS = 10;               // 组数少于此时不压（够丢才值得花一次摘要调用）

/**
 * 循环内压缩的运行期开关：`DOUYA_CTX_COMPRESS=0` 彻底关掉它。两个理由都是真需求：
 *   ① 运维兜底 —— 摘要服务不可用、或想省这一次摘要调用时，允许不改代码就退回"全量重发"的老行为；
 *   ② 它是本门禁（scripts/smoke/unit-context-budget.mjs）的**对照组开关** —— 只有真跑一遍
 *      "同一场景但不压缩"，「压缩确实把膨胀压住了」才算被证明，而不是"压了、但压不压都一样"。
 * 默认开启 ⇒ 生产行为与加这个开关之前完全一致。
 */
function inLoopCompressEnabled() { return process.env.DOUYA_CTX_COMPRESS !== '0'; }

/**
 * 证伪闸门开关（2026-09-23，人设「二十一」）。
 * ⚠️ **默认开启**：默认关就等于没接线（"加了开关但默认不生效"是本仓库记过的坑）。
 * 这个开关同时是单测的**对照组** —— 关掉它，带归因无反证的正文**必须不再**被降级，
 * 以此证明「拦的力量来自这段代码」，而不是别的闸门顺手拦下的。
 */
function falsificationGateEnabled() { return process.env.DOUYA_FALSIFICATION_GATE !== '0'; }

/**
 * 结论证据与反证门开关（2026-09-24）。
 * ⚠️ **默认开启**（与上面同一条纪律：默认关 = 没接线）。它同时是单测的**对照组** ——
 * 关掉它，证据不足的"已完成"必须**不再**被降级，以证明「拦的力量来自这一段代码」。
 */
function claimGateEnabled() { return process.env.DOUYA_CLAIM_GATE !== '0'; }

/**
 * 「产物检测器（verifyDeliverables）自己可不可信」的**真跑**自证（2026-09-24，第八节）。
 *
 * 为什么必须有这一问：产物证据的 PASS **全部出自同一个检测器**。检测器要是坏了
 * （东西明明没生成，它照样说 OK），那些 PASS 就一文不值 —— 此时正确的动作是
 * **当场拒收它的 PASS**（VERIFIER_SUSPECT），而不是"那我更相信它一点"。
 *
 * 两端都真跑（缺一不可）：
 *   baseline —— 拿一个**确定存在且非空**的文件当样品，它必须说 OK（不无故喊狼来了）
 *   mutation —— 拿一个**确定不存在**的路径当样品，它必须说"不 OK"（**针是活的**）
 *
 * ⚠️ 三道反误伤（"检测器自己也会被误伤"是本仓记过的教训，这里逐条挡住）：
 *   ① 探针**只读**（statSync/openSync，全在 verifyDeliverables 内部），不写盘、不碰用户文件；
 *   ② 探针自己跑不起来（异常 / baseline 连样品都测不出"好"）⇒ 返回 null，**不声明 selfTest**：
 *      按 verifyClaim 的语义「**未自证 ≠ 可疑**」。不许把"我没验成"报成"检测器坏了"——
 *      否则一次环境抖动就会把所有发布判成"未验证"，那才是真的假警报；
 *   ③ 只有**真的测出**"它对一个不存在的文件说了 OK"（mutation:'fail'）才判可疑。
 *
 * @param {Function} [verifyFn] 产物检测器（默认 verifyDeliverables；**可注入**，门禁要拿它做反控）
 * @param {{samplePath?:string, tmpDir?:string}} [opts] 样品路径（默认取运行中的可执行文件，必然存在）
 */
function claimVerifierSelfTest(verifyFn, opts) {
  const o = opts || {};
  const detector = typeof verifyFn === 'function' ? verifyFn : verifyDeliverables;
  const sample = o.samplePath || process.execPath;
  const tmpDir = o.tmpDir || os.tmpdir();
  try {
    // baseline：拿一个**必然存在且非空**的样品（进程自己的可执行文件）
    const good = detector([{ path: sample }], { maxCheck: 1 });
    if (!good.ok) return null;
    // mutation：一个**必然不存在**的路径（只拿它去问，绝不创建它）
    const bogus = path.join(tmpDir,
      'douya-selftest-must-not-exist-' + process.pid + '-' + Date.now() + '.bin');
    const bad = detector([{ path: bogus }], { maxCheck: 1 });
    return { baseline: 'pass', mutation: bad.ok === false ? 'pass' : 'fail' };
  } catch {
    return null;
  }
}

/**
 * 按**真实信号**整理出「关键结论账本」的输入（不是让调用方自己编，也不是抄一份逻辑）。
 *
 * ★ 后端能拿到的**硬信号**只有一样：「产物 + 它到底对不对」（verifyDeliverables 真跑过）。
 *   没有产物导出的任务（纯问答 / 改仓库内代码但没产出交付物），后端**无从判断"改得对不对"** ——
 *   此时宁可不介入，也不硬造一条不可靠的证据：**造证据比没有证据更糟**（它会让门看起来在工作）。
 *   所以 `productionRun` 的条件是「真动过手 **且** 至少有一条可核的产物」。
 */
function buildClaimContext(o) {
  const c = o && typeof o === 'object' ? o : {};
  const items = Array.isArray(c.deliverables) ? c.deliverables : [];
  const artifactsOk = c.artifactsOk !== false;
  // ★ 第八节落地：这些 PASS 全出自**同一个检测器**，所以先把"检测器自己可不可信"问清楚，
  //   再决定要不要拿它的 PASS 当证据（null = 没自证 ⇒ 按"未自证 ≠ 可疑"不判它可疑）。
  const selfTest = claimVerifierSelfTest();
  return {
    productionRun: items.length > 0,
    completionClaimed: !!c.completionClaimed,
    deliverableClaimed: !!c.deliverableClaimed,
    bugfixClaimed: !!c.bugfixClaimed,
    // 逐项结果只有整体口径（verifyDeliverables 返回的是分类数组，不逐项 ok），
    // 所以统一取整体判定：**读不到 ≠ 通过**（那条语义已在 verifyDeliverables 里）。
    artifacts: items.map((d) => {
      const ev = { path: (d && d.path) || '', result: artifactsOk ? 'pass' : 'fail' };
      if (selfTest) ev.selfTest = selfTest;
      return ev;
    }),
    doneLog: c.doneLog,
    codeChanged: !!c.codeChanged,
    blocked: !!c.blocked,
    blockedReason: c.blockedReason,
    blockedGap: c.blockedGap,
    // 【2026-10-21】用户本轮原话要一路传到 buildClaimLedger → isRealArtifact。
    // 少了它，`WANTS_SCRIPT_RE`（「用户明确要脚本时，脚本就是成果」）在证据门这一侧
    // 永远走不到：用户要脚本、脚本也写了，结论却仍按 generic 判 ⇒ 对用户说「文件还没生成」。
    userText: String(c.userText || ''),
  };
}

/** 「这个 bug 已经修复」这类**关键结论**的识别（第 3 类）。刻意收窄，避免把正常叙述当成声称。 */
const BUGFIX_CLAIM_RE = /(已(经)?修复|修复完成|已(经)?修好|修好了|问题已(经)?解决|已经解决)/;

async function handleChat(req, res, cfg, skills) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  const apiKey = payload.apiKey || cfg.apiKey;
  const baseURL = normalizeBaseURL(payload.baseURL || cfg.baseURL);
  // 仅公网 DeepSeek（api.deepseek.com）要求用户自填 Key；内网模型网关零配置即可对话（登录即用）。
  if (!apiKey && /api\.deepseek\.com/.test(baseURL)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing apiKey' }));
    return;
  }

  // 工具调用模式：让模型自主决定调用本地技能（对标原版 skillhub 的灵魂）
  if (Array.isArray(payload.tools)) {
    // ★★ 渐进披露开关的**唯一生产者**（2026-11-11 补；此前全仓没有生产者，见 lazyTools.resolveLazySwitch 头注）。
    //   为什么必须在这里补：payload 是上面 `JSON.parse(raw)` 出来的**原始请求体**，
    //   而全仓（渲染层 + 主进程）没有任何地方写 `lazyTools` 字段 ⇒
    //   `turnToolsFor` 里那句 `isLazyEnabled(payload)` 恒为 false ⇒ 48 个技能的 schema
    //   每轮原样重发（实测 52,494 字节 ≈ 11,900 tokens），分层逻辑一次都没跑过。
    //   判据不内联在这里，走 lazyTools.resolveLazySwitch（纯函数，门禁能真跑四种优先级）：
    //     请求体显式布尔 > config.json > 环境变量/出厂值。
    //   注意**改写的是 payload 本身**：后续 `request.payload` 就是它，
    //   内层读的也是它 —— 不存在"这里改了、那边读旧的"两份真相。
    payload.lazyTools = lazyTools.resolveLazySwitch(payload, cfg);
    // 运行底座 P1：调用点改走可替换的 runtime 接口层，返回值暂不消费（阶段 1 零行为变化）。
    // P0 的关联键 sessionId 在这里透传；taskId 缺省时留空串 —— 内层会自己 genId，
    // 本层不替它生成、也不改写 payload。signal 只是 request 形状的占位，阶段 1 不消费。
    const request = {
      sessionId: String(payload.sessionId || ''),
      taskId: String(payload.taskId || ''),
      payload, cfg, skills, res,
      signal: null,
    };
    await agentRuntime.run(request);
    return;
  }

  // 普通流式代理
  const model = payload.model || cfg.model;
  const messages = await compressContext(injectExpertSystemMessage(payload), payload, cfg);
  const upstreamURL = baseURL.replace(/\/+$/, '') + '/chat/completions';

  let upstream;
  try {
    upstream = await fetch(upstreamURL, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.7,
        ...(payload.enableSearch === true ? { enable_search: true } : {}),
      }),
    });
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream request failed: ' + e.message }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // ★ 2026-11-04：原来这里显式写死 `Access-Control-Allow-Origin: *`。writeHead 的显式头会**压过**
    //   `applyLocalCors` 用 setHeader 回显的白名单 Origin ⇒ SSE 流对任何网页都可读，上面那道闸等于白装。
    //   删掉这一行即可：AC-AO 由 applyLocalCors 统一决定（白名单回显 / 无 Origin 就不发）。
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    res.write('\n\n[data: error]\n');
  } finally {
    res.end();
  }
}

// 非流式补全端点（/api/chat-once）：
// 供前端结构化 AI 调用（AI 辅助建项目 / 一句话建任务 / AI 执行任务 / 项目助手 / 今日建议）。
// 复用 injectExpertSystemMessage + compressContext + normalizeBaseURL + authHeaders，
// 只做一次性补全并返回 JSON { ok, content }。不改动现有 /api/chat 流式链路。

// ===== 上游 LLM 请求：指数退避重试 =====
// 2026-10-15 实测（老板机器，公网 api.deepseek.com）：DeepSeek 服务端间歇返回
// 503 "Service is too busy"（约 50% 概率，0.2~0.5s 快速失败），另有偶发读超时。
// 网络与 key 均正常（同机 tavily 检索 100% 通、同 key 重试即可 200）。
// 单发不重试时，经营诊断/竞品分析这类要连打 2~3 个 LLM 的链路极易「两个源都没返回」
// —— 老板看到的就是「在线检索和内网模型都没返回可用结论」。
// 策略：503/502/504/429/408 与网络异常 → 最多重试 2 次（800ms、1600ms 退避）；
// 4xx（除 429/408）= 请求体或 key 问题，重试无意义，原样返回让调用方如实呈现。
const LLM_RETRY_DELAYS_MS = [800, 1600];
const LLM_RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const LLM_ATTEMPT_TIMEOUT_MS = 45000;

/**
 * 带重试的上游 chat/completions 请求。
 * @returns {Promise<{ok:true, resp:Response} | {ok:false, error:string, status:number}>}
 *   ok:false 时 error 含真实原因（重试后仍失败的 HTTP 码，或网络层错误），status 为 0 表示网络错误。
 */
async function fetchChatCompletionsWithRetry(upstreamURL, bodyObj, apiKey) {
  let lastError = 'upstream request failed';
  let lastStatus = 0;
  for (let attempt = 0; attempt <= LLM_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_ATTEMPT_TIMEOUT_MS);
    try {
      const resp = await fetch(upstreamURL, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      });
      if (resp.ok) return { ok: true, resp };
      lastStatus = resp.status;
      // 不可重试的 4xx：直接交出响应，由调用方按原逻辑呈现（错误信息更准）
      if (resp.status < 500 && !LLM_RETRYABLE_STATUS.has(resp.status)) {
        return { ok: true, resp };
      }
      let detail = '';
      try { detail = (await resp.text() || '').slice(0, 200); } catch { /* 忽略读取失败 */ }
      lastError = 'LLM HTTP ' + resp.status + (detail ? ' ' + detail : '');
    } catch (e) {
      lastStatus = 0;
      lastError = 'upstream request failed: ' + (e && e.message ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (attempt < LLM_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, LLM_RETRY_DELAYS_MS[attempt]));
    }
  }
  return { ok: false, error: lastError + '（已自动重试 ' + LLM_RETRY_DELAYS_MS.length + ' 次）', status: lastStatus };
}

async function handleChatOnce(req, res, cfg) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
    return;
  }

  const apiKey = payload.apiKey || cfg.apiKey;
  const baseURL = normalizeBaseURL(payload.baseURL || cfg.baseURL);
  // 仅公网 DeepSeek 要求用户自填 Key（与 handleChat 保持一致）
  if (!apiKey && /api\.deepseek\.com/.test(baseURL)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'missing apiKey' }));
    return;
  }

  const model = payload.model || cfg.model;
  const messages = await compressContext(injectExpertSystemMessage(payload), payload, cfg);
  const upstreamURL = baseURL.replace(/\/+$/, '') + '/chat/completions';

  const upstreamCall = await fetchChatCompletionsWithRetry(upstreamURL, {
    model,
    messages,
    stream: false,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.4,
    max_tokens: typeof payload.maxTokens === 'number' && payload.maxTokens > 0 ? payload.maxTokens : 8000,
    // thinking 模型（deepseek-v4-pro-wb）默认会输出 reasoning_content 占 token，
    // 复杂长 prompt 下 reasoning 可能吃满 max_tokens 导致 content 为空 → 前端「生成失败」。
    // 结构化补全（活动策划/竞品对比/能力执行）无需思考，固定关思考直接出正文。
    reasoning_effort: payload.reasoningEffort === 'high' ? 'high' : 'none',
    ...(payload.enableSearch === true ? { enable_search: true } : {}),
  }, apiKey);
  if (!upstreamCall.ok) {
    // 重试后仍失败：如实带回真实原因（含 HTTP 码，如 503 too busy），不再伪装成 502 网关错
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: upstreamCall.error }));
    return;
  }
  const upstream = upstreamCall.resp;

  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'LLM HTTP ' + upstream.status + ' ' + detail.slice(0, 200) }));
    return;
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'LLM 返回解析失败' }));
    return;
  }

  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const content = msg && msg.content;
  // 兜底：某些网关即使 reasoning_effort:none 仍可能只吐 reasoning 而 content 为空，
  // 此时取 reasoning_content 作为结果，避免结构化生成「空结果」失败。
  const fallback = content || (msg && typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '');
  // 记账（2026-09-20 新增）：此前 /api/chat-once 不落任何用量 => 开发工作台等结构化调用的 token 两头都看不见。
  // 优先用上游真实 usage，拿不到就估算（与 /api/chat 同口径）；失败绝不影响返回结果。
  try {
    const _uu = data && data.usage;
    const _pt = _uu && typeof _uu.prompt_tokens === 'number' ? _uu.prompt_tokens : estimateTokens(messages);
    const _ct = _uu && typeof _uu.completion_tokens === 'number' ? _uu.completion_tokens : estimateTokens([{ content: fallback || '' }]);
    addUsage(payload.username || payload.owner || 'anonymous', _pt, _ct, { model, src: 'chat-once' });
  } catch { /* 记账失败绝不影响返回 */ }
  if (typeof fallback !== 'string' || !fallback.trim()) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'LLM 返回空结果' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, content: fallback.trim() }));
}

/**
 * POST /api/web-search —— 真实联网检索代理。
 *
 * 请求体：{ query, count?, freshness?, timeoutMs? }
 * 响应：  { ok, provider, elapsedMs, results:[{title,url,content,score,publishedDate,siteName}], error }
 *
 * 语义边界（调用方务必区分）：
 *   · ok:true  + results 非空 → 真检到了资料；
 *   · ok:true  + results 为空 → **真没搜到**（provider 可用但无结果），不是失败；
 *   · ok:false              → 检索失败（网络/HTTP 非 2xx/解析失败/超时），error 说明原因。
 *
 * 安全：provider 的链路与 key 全部在主进程内；响应体**不含任何 key 字段**。
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} cfg 主进程配置（含 tavilyApiKey / bochaApiKey）
 */
async function handleWebSearch(req, res, cfg) {
  let p = {};
  try {
    p = JSON.parse((await readBody(req)) || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, provider: 'none', elapsedMs: 0, results: [], error: '请求格式错误' }));
    return;
  }
  // 注意：只把 provider 需要的字段透传，key 从 cfg（主进程）取，绝不接受渲染层传入的 key。
  const outcome = await runWebSearch({
    query: p && p.query,
    count: p && p.count,
    freshness: p && p.freshness,
    timeoutMs: p && p.timeoutMs,
    tavilyApiKey: cfg.tavilyApiKey,
    bochaApiKey: cfg.bochaApiKey,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(outcome));
}

// ═══════════════════════════════════════════════════════════════════════════
// 【任务类型工作流 · 启动 / 推进 / 终审】2026-10-23
// 对应老板第六节：「关键是让 backend.js 真正执行它，而不是把它作为另一个提示词塞给模型。」
//
// 这一段做三件**不产生任何提示词**的事：
//   ① 用**用户原话**判定这次任务属于哪套工作流，并抽出硬规格（页数/格式）。
//      判定本身**不在本文件**：`workflows.selectWorkflow` 按注册顺序调各注册项的 `match`
//      （PPT 那套的 `match` 内部才调 `workflowRunner.detectWorkflow`）；本文件只消费选择结果。
//   ② 按**证据**推进阶段（markStage）——没有证据的阶段推不动，拿不到证据的阶段只能显式豁免；
//   ③ 收尾时对**真文件**逐项验收（evaluate），结论直接压到终态（验收没过不许判 COMPLETE）。
//
// ★ 三条纪律（都是为了让"标准"不被模型的自述带跑）：
//   1. 阶段的证据必须是**代码能验到的东西**（用户原话、抽出的规格、附件清单、真文件解析结果），
//      绝不采信"模型说它做了大纲/做了渲染"。
//   2. 任何一步推进失败都只记账（errors），**绝不向主流程抛错** —— 工作流是增益，不是单点故障源。
//   3. 本机没有 pptx 渲染器 ⇒ render 阶段按能力边界**豁免**（带理由、进报告），
//      但 build/validate/final_validate 永远不可豁免：那两个才是"到底做没做出来"的判据。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 页数规格 → 人能读的一句话（写进阶段证据，事后能对着原话核）。
 *
 * ★★ 2026-10-28【F3】把**页数算术**写出来，不再让模型自己推。
 *   为什么这不只是"措辞优化"（实测，不是假想）：snap-inject A/B 的 seed5 与 seed6
 *   输入**逐字相同**，提示词里既写了「它**会自动加一页封面**，所以 slides 只传 4 页正文」
 *   又点了那 4 个标题 —— seed6 照样传了 5 条 ⇒ 5 条正文 + 1 封面 = 6 页
 *   ⇒ must 级 `slide_count_matches_plan` 判失败，整轮 PARTIAL。
 *   所以「算术只写在用户原话里」是不够的：模型每轮看到的**任务规格**这句也必须说清
 *   「含封面共 N 页 ⇒ 正文 N−1 张」，并且明确告诉它**这个数字是产品强制的**
 *   （强制点在两处：`cfg.pageBudget` 声明 + 后端 `withPageBudget` 确定性注入
 *   `expected_pages`，技能侧 `run.py` 校验不等就非 0 退出）。
 *   ⚠️ 本函数只产出**证据文案**，不参与任何判据；`slide_count_matches_plan` 一个字都没动。
 */
function describeSlideSpec(sc) {
  if (!sc) return '用户未提页数，且配置无默认值（不做页数判定）';
  /** 数值安全化：非数字时退回占位符，绝不把 NaN 写进证据 */
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (sc.mode === 'exact') {
    const n = num(sc.count);
    const body = n === null ? 'N−1' : String(n - 1);
    return '用户明确要求 ' + sc.count + ' 页（**幻灯片总数，含封面**：必须恰好等于 ' + sc.count
      + ' 页 ⇒ 正文内容页只能 ' + body + ' 张，封面算第 1 页；'
      + '这个数字由产品**强制执行** —— 生成时提交的正文条数不等于 ' + body
      + ' 会直接失败、不会产出超页文件，所以别自行加减页）';
  }
  if (sc.mode === 'range') {
    const lo = num(sc.min);
    const hi = num(sc.max);
    const bodyRange = (lo === null || hi === null) ? 'min−1 ~ max−1' : ((lo - 1) + '-' + (hi - 1));
    const tail = '（含封面：正文内容页对应 ' + bodyRange + ' 张，封面算第 1 页）';
    return (sc.source === 'default'
      ? '用户未提页数，按配置默认 ' + sc.min + '-' + sc.max + ' 页'
      : '用户要求 ' + sc.min + '-' + sc.max + ' 页') + tail;
  }
  return JSON.stringify(sc);
}

/**
 * 从页数规格里取「**恰好**多少页」这个硬数字；取不到（range / 缺失 / 非数字）返回 0。
 *
 * ★ 只有 `mode === 'exact'` 才有强制预算可言：范围规格不能强判等（那会把"落在范围里"
 *   的正常产物判死）。所以注入侧只认这一种形态，range 一律不注入、行为与今天一致。
 * ★ 与 `describeSlideSpec` 用同一套 parse 判据（都看 `mode` / `count`），
 *   不许另写一份"差不多"的取数逻辑 —— 两套取数必然漂移。
 *
 * @param {object|number|null} sc 页数规格（`{mode:'exact',count:5}` 或裸数字）
 * @returns {number} 总页数（含封面）；0 = 没有可强制的确切页数
 */
function slideBudgetPages(sc) {
  if (typeof sc === 'number') {
    return (Number.isFinite(sc) && sc > 0) ? Math.floor(sc) : 0;
  }
  if (sc && typeof sc === 'object' && sc.mode === 'exact') {
    const n = Number(sc.count);
    return (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
  }
  return 0;
}

/**
 * ★★ 2026-10-28【备份件降权】判定「这个文件名看起来像一次备份」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（真读数，不是假想）
 * ═══════════════════════════════════════════════════════════════════════════
 * `discoverArtifactsForConcludeCore` 的第 ③ 级 `workspace-scan` **只取最新一份**
 * （同级文件谁属于本任务无法区分，多取就是猜）。于是同目录里只要有一份
 * `zhongzhi-5.backup.pptx` 的 mtime 比 `zhongzhi-5.pptx` 新，它就会成为**唯一**产物：
 * 扩展名合法、pptx 可解析、不是 0 字节 —— 三道硬判据全过。
 * **备份文件的字节于是冒充了交付物，验收在它身上跑。**
 *
 * 实测（`_al-backup-order.mjs`，同一份 5 页真件，只改盘面）：
 *   A 真件 +2s / 备份(6页) +6s ⇒ 认领**备份** ⇒ verdict **PARTIAL**
 *   B 只有备份(6页)           ⇒ 认领备份   ⇒ verdict PARTIAL（页数确实不对，结论是对的）
 *   C 真件 +6s / 备份(6页) +2s ⇒ 认领真件   ⇒ verdict **COMPLETE**
 * ★ A 与 C 是**同一份真件**：它赢了是 COMPLETE，被备份顶掉就是 PARTIAL。
 *   也就是说"备份命名不降权"这一个因素，单独就能把一次合格交付判成不合格。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 判定表（**写死在这里**，改判定必须同时改这张表和下面的正则，别只改一处）
 * ═══════════════════════════════════════════════════════════════════════════
 * | # | 规则                                        | 例                                   |
 * |---|---------------------------------------------|--------------------------------------|
 * | 1 | 以 `~` 结尾（编辑器备份）                    | `zhongzhi-5.pptx~`                   |
 * | 2 | 以 `~$` 开头（Office 临时锁文件）             | `~$zhongzhi-5.pptx`                  |
 * | 3 | 词干以 `.bak`/`.backup`/`.orig`/`.old` 结尾   | `zhongzhi-5.bak.pptx`（双扩展名）    |
 * | 4 | 词干以 `-bak`/`_bak`/`-backup`/`_backup` 结尾 | `zhongzhi-5-backup.pptx`             |
 * | 5 | 名字里含 `副本` 或 `备份`                     | `zhongzhi-5-副本.pptx`、`…备份.pptx` |
 * | 6 | 括号序号结尾（微信/资源管理器「(1)」全半角）  | `zhongzhi-5(1).pptx`、`…（2）.pptx`   |
 *
 * 判定对象是**去掉最后一个扩展名之后的词干**（`path.parse(p).name`），因为
 * `zhongzhi-5.bak.pptx` 的 `.bak` 在词干里、不在扩展名里 —— 只查扩展名会漏掉双扩展名那一类。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么**不**收「空格 + 数字」(`zhongzhi-5 2.pptx`, macOS/资源管理器「另存为」形态)
 * ─────────────────────────────────────────────────────────────────────────
 * 2026-10-28 第一版收过它，实测后**撤回**。理由是它的**方向不确定**：
 *   · `deck.pptx` + `deck 2.pptx`：几乎一定是"用户另存了新版本"，` 2` 那份是**更新更好的**；
 *   · 而 `(1)`（下载/微信）几乎一定是"同一份被重复下载"，重复那份才该让位。
 * 两种形态的长相接近、语义相反，不能归成一类。实测代价（`_lead-backup-two-gaps.mjs` 场景①）：
 *   `deck.pptx`(5页/旧) + `deck 2.pptx`(5页/新) ⇒ 降权后认领 **`deck.pptx`（旧的那份）**，
 *   也就是**把用户刚存的新版本换成了旧版本** —— 比不收这条规则更糟，因为改造前的语义是"同级取最新"。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★★ 单凭文件名**不算证据** —— 必须存在「同基名的正本」才算备份（第二个参数）
 * ─────────────────────────────────────────────────────────────────────────
 * 一处不符，就没收：
 *   盘上只有 `方案-副本.pptx` 而**没有** `方案.pptx` ⇒ 它不属于"谁的备份"，它就是正本本身
 *   （用户把自己那份交付物命名成 `xxx-副本` 是真实存在的写法）。
 * 实测代价（同探针场景②）：`方案-副本.pptx`(5页/新/合格) + `unrelated.pptx`(6页/旧/不合格)
 *   ⇒ 单看名字降权后认领 **`unrelated.pptx`** ⇒ 结论从 COMPLETE 掉成 **PARTIAL**，
 *   判词还是"实际 6 页 ≠ 要求 5 页" —— 一份合格件被判不合格，且判词看着完全合理。
 * ⇒ **词表命中是信号，基名冲突才是证据。** 调用方必须把同级候选一起传进来。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它只用来**降权**，永远不用来**排除**（这条比上面整张表都重要）
 * ═══════════════════════════════════════════════════════════════════════════
 * 「用户唯一那份交付物合法地叫 `xxx-备份.pptx`」是真实存在的写法。若在这里 `return null`
 * 把它排掉，后果是**门禁宣称"本任务没有产物"**——那比误认备份更糟：
 *   · 误认备份：东西还在，验收里看得见"实际 6 页 ≠ 要求 5 页"，人能看懂发生了什么；
 *   · 拒认备份：`paths=[]` ⇒ 结论退化成 PARTIAL +「没有产物」，用户以为自己的成果丢了。
 * 所以调用点必须写成「同级里先按 `is` 升序（非备份在前），再按 mtime 降序」——
 * 备份在**同一来源内**只在没有非备份候选时才可能被选中。
 * ⚠️ 但"同一来源内"这个限定不能省：若被判成备份的那份处在**更高优先级来源**
 *   （本任务 trace 里 `file-write` 过它），而正本只在更低一级的 `workspace-scan` 里，
 *   顶层来源就只有它一个候选 ⇒ **它会被认领**，这是对的（那本来就是本任务写的文件）。
 *   门禁 F5 钉的就是这条路，G3 用「在收集层静默丢弃」的变异体反证它承重。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 它**不解决**什么（失效边界，别把这条修复当成"备份问题已彻底解决"）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① 备份的内容**本身更新更好**（用户改了备份、忘了改正本）⇒ 降权反而选错。
 *      这是"按名字猜意图"的固有上限，名字给不出答案。
 *   ② 两份都**不像**备份（`real.pptx` + `real-2.pptx`）⇒ 仍按原有语义只取最新一份，
 *      并如实写"无法确认哪一份属于本任务"。降权只动备份这一类，不改原有语义。
 *
 * @param {string} p 候选路径（绝对或相对都行，只看 basename）
 * @param {string[]|{path:string}[]} [siblings] 同级候选（用于确认"同基名正本"是否存在）；
 *        不传 ⇒ 退化成"只按词表判"，仅用于探针/单测的纯函数调用，**生产调用点必须传**。
 * @returns {{is:boolean, rule:string, stem:string, stripped:string}}
 *          `is=false` 时 `rule` 为 `''`
 */
function looksLikeBackup(p, siblings) {
  const base = path.basename(String(p == null ? '' : p));
  if (!base) return { is: false, rule: '', stem: '', stripped: '' };
  // 词干：去掉最后一个扩展名（`zhongzhi-5.bak.pptx` ⇒ `zhongzhi-5.bak`）
  const stem = path.parse(base).name || base;
  /** 去掉一个尾部/头部的分隔符残留：`方案-副本` 剥成 `方案`，`方案_备份` 剥成 `方案`。 */
  const trimSep = (s) => String(s).replace(/[-_\s]+$/, '');
  const RULES = [
    ['以 ~ 结尾（编辑器备份）', () => /~$/.test(base), () => base.replace(/~+$/, '')],
    ['以 ~$ 开头（Office 临时锁文件）', () => /^~\$/.test(base), () => base.replace(/^~\$/, '')],
    ['以 .bak/.backup/.orig/.old 结尾（含双扩展名）', () => /\.(bak|backup|orig|old)$/i.test(stem),
      () => stem.replace(/\.(bak|backup|orig|old)$/i, '')],
    ['以 -bak/-backup/_bak/_backup 结尾', () => /[-_](bak|backup)$/i.test(stem),
      () => trimSep(stem.replace(/[-_](bak|backup)$/i, ''))],
    ['名字里含「副本」或「备份」', () => /(副本|备份)/.test(stem),
      () => trimSep(stem.replace(/(副本|备份)+/g, ''))],
    ['括号序号结尾（如 (1)（2））', () => /[(（]\d+[)）]$/.test(stem),
      () => trimSep(stem.replace(/[(（]\d+[)）]$/, ''))],
  ];
  for (const item of RULES) {
    let hit = false; let stripped = '';
    try { hit = item[1]() === true; if (hit) stripped = String(item[2]()); } catch { hit = false; }
    if (!hit) continue;
    /**
     * ★ 第二道闸：词表命中只是**信号**，必须确认"同基名的正本"确实存在才是**证据**。
     *   `siblings` 不传 ⇒ 跳过这道闸（纯函数调用场景，见 jsdoc）。
     */
    if (Array.isArray(siblings) && siblings.length) {
      const dirOf = (x) => { try { return path.dirname(typeof x === 'string' ? x : String(x && x.path)).toLowerCase(); } catch { return ''; } };
      const myDir = dirOf(p);
      const stemOf = (x) => {
        const pp = typeof x === 'string' ? x : String(x && x.path);
        const b = path.basename(pp);
        return path.parse(b).name || b;
      };
      const hasOriginal = siblings.some((x) => {
        const xp = typeof x === 'string' ? x : String(x && x.path);
        if (!xp || path.basename(xp) === base) return false;
        if (dirOf(xp) !== myDir) return false;
        if (stemOf(xp) !== stripped) return false;
        // 那份"正本"自己也不许是备份命名的（否则两份都是备份，谈不上谁让位给谁）
        const sibSelf = looksLikeBackup(xp, null);
        return !sibSelf.is;
      });
      if (!hasOriginal) return { is: false, rule: '', stem, stripped: '' };
    }
    return { is: true, rule: item[0], stem, stripped: stripped || stem };
  }
  return { is: false, rule: '', stem, stripped: '' };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★★【KI-001 · 2026-10-28】契约产物判据的**唯一**逐件闸门（两条路共用）。
 *
 * 为什么必须抽出来：KI-001 的病根不是"少写了一个 if"，而是**同源判据、消费者不齐**
 *   —— `pptx-v1.regenKind` 认 `shell-exec:cmd(pptx+write)` 会出片（引擎认这条路径），
 *   而 `deliverables` / `markBuild` / `custody` 三处都没有它的入口。
 *   补这一处时若在收尾归属器之外再写一份"扩展名 + 能不能打开"的判据，就等于把
 *   "两套标准"从阶段机搬进归属器 —— 问题原封不动，只是换了个文件。
 *
 * 闸门顺序**固定**（改顺序 = 改语义：先报哪一个原因会变，既有门禁钉着这些文案）：
 *   ① 扩展名属于本工作流产物契约 → ② 文件存在 → ③ 非 0 字节
 *   → ④ 落地时间不早于 `startedAt`（传 0 ⇒ 不做时间窗判定，由调用方用**自己的**证据代替）
 *   → ⑤ `.pptx` 必须能被产品自己的解析器打开且页数 > 0
 *
 * ⚠️ ④ 传 0 的唯一合法用途是「调用方手里有**更强**的归属证据」。今天只有一个这样的调用方：
 *   `shell-exec` 的执行区间（前后快照差 —— 这份文件在**这次调用里**出现或被改写，
 *   比"mtime 晚于某个时刻"硬得多）。**不许**为了"多认一份"随手传 0：那正是被修掉的
 *   「凭磁盘上存在文件就推定归属」。
 * ⚠️ ⑤ 是 `inspectPptx` 的**真实读数**，不是扩展名后缀判据；解析器读不出来就不认。
 *
 * @param {string} p 绝对路径
 * @param {{extOk?:(p:string)=>boolean, extLabel?:string, startedAt?:number}} o
 * @returns {{ok:boolean, why?:string, size?:number, mtimeMs?:number, info?:object|null}}
 */
function judgeContractArtifact(p, o) {
  const opt = o || {};
  const extOk = typeof opt.extOk === 'function' ? opt.extOk : () => false;
  const extLabel = String(opt.extLabel || '未声明');
  const startedAt = Number(opt.startedAt) || 0;
  const s = String(p == null ? '' : p);
  if (!s) return { ok: false, why: '空路径' };
  if (!extOk(s)) {
    return { ok: false, why: '扩展名不属于本工作流产物契约（' + extLabel + '）⇒ 不是本工作流的产物' };
  }
  let st = null;
  try { st = fs.statSync(s); } catch { st = null; }
  if (!st || !st.isFile()) return { ok: false, why: '文件不存在' };
  const size = Number(st.size) || 0;
  const mtimeMs = Number(st.mtimeMs) || 0;
  if (!(size > 0)) return { ok: false, why: '0 字节' };
  if (startedAt && mtimeMs < startedAt) {
    return {
      ok: false,
      why: '落地时间早于本任务开始时间（mtime=' + Math.round(mtimeMs) + ' < startedAt=' + startedAt + '）⇒ 不是本任务产出的',
    };
  }
  let info = null;
  if (workflowRunner.extOf(s) === '.pptx') {
    try { info = workflowRunner.inspectPptx(fs.readFileSync(s)); } catch { info = null; }
    if (!info || info.openable !== true || !(Number(info.slideCount) > 0)) {
      return {
        ok: false,
        why: '不是可解析的 pptx（' + ((info && info.error) || 'openable=false 或 0 页') + '）',
      };
    }
  }
  return { ok: true, size, mtimeMs, info: info || null };
}

/**
 * ★★★【KI-001 · 2026-10-28】工作区里"属于本工作流产物契约"的那部分文件的**快照**。
 *
 * 用途只有一个：给一次 `shell-exec` 的执行区间拍**前**后两张，差出来的才是"这次命令
 * 真的落了什么"。为什么不能只按 mtime 判（`conclude` 第 ③ 级就是这么判的）：
 *   · mtime 只能回答"文件比某时刻新"，回答不了"它是不是**这次调用**写出来的"——
 *     同一时刻另一个任务写下的同扩展名文件会被一锅端；
 *   · 快照差能区分「出现（appeared）」与「被就地改写（changed）」，
 *     而后者正是实测现场（`file-write _fix.py` + `shell-exec python` **就地改写** pptx）。
 *
 * 失败关闭：目录读不到 ⇒ 返回 `null`（不是空 Map）——空 Map 会被读成
 *   "工作区里一份契约产物都没有"，从而把随后出现的任何同名文件都判成"本命令新产出的"。
 *
 * @param {string} dir 工作区绝对路径
 * @param {string[]} wantExts 产物契约扩展名（`.pptx` 这种带点、已小写）
 * @returns {Map<string,{size:number,mtimeMs:number}>|null}
 */
function snapshotContractFiles(dir, wantExts) {
  const want = Array.isArray(wantExts) ? wantExts : [];
  if (!want.length) return null;
  const snap = new Map();
  try {
    for (const n of fs.readdirSync(dir)) {
      const ext = workflowRunner.extOf(n);
      if (!ext || want.indexOf(ext) < 0) continue;
      const abs = path.join(dir, n);
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      snap.set(abs, { size: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 });
    }
  } catch { return null; }
  return snap;
}

/**
 * ★★★ 2026-10-26【第三阶段】收尾产物归属的**唯一实现**（被两条路共用）。
 *
 * 为什么把它从 `startWorkflowRun` 的闭包里搬出来（不是"顺手重构"）：
 *   通用任务（`lifecycle:'none'`）没有控制器，也就没有 `state.run` / `cfg` 可取 ——
 *   但它的验收**同样**必须回答"这份文件是不是本任务产出的"。如果为了这条路在别处再写
 *   一个扫描器，就会出现两套归属判据：一套认"本 run 的账"，另一套认"文件在不在"，
 *   于是同一个工作区状态在两条路上一个是"冒领"、一个是"合格"（老板在 §4.4 明确禁止）。
 *   所以判据**只写一次**：这里的输入全部由参数给出（run 的账 / 工作区 / 时间窗 / 扩展名判据），
 *   谁能凑齐这些事实谁就能得到**同一份**归属结论。
 *   · `startWorkflowRun` 的 `discoverArtifactsForConclude()` 现在是它的一层薄包装；
 *   · 通用任务在收尾时用本工作流的 `buildExts` + 本任务开始时间调**同一个**函数。
 *
 * 顺序（优先级从高到低，前一级有合格项就不看后一级）：
 *   ① `runArtifacts` —— 本 run 自己落过账的产物（只有有状态的工作流才给得出；通用任务传 []，
 *      因为通用任务**没有**跨请求账本，传空是事实陈述，不是"没查"）；
 *   ② 本任务 trace 里真实的写入动作（`file-write` 的 path，相对路径按 workspace 解析）；
 *   ③ 工作区扫描 —— **只认本任务开始后落地的**（mtime >= startedAt），且扩展名必须属于
 *      本工作流的产物契约；同一级里只取**最新的一份**（同级文件谁属于本任务无法区分，多取就是猜）。
 *      ★ 2026-10-28：这一级的"最新"改为**备份降权后的最新** —— 同级的备份命名候选排到非备份之后，
 *      只在没有非备份可用时才可能被选中（判据见 `looksLikeBackup`）。**降权不排除**：
 *      同级只剩备份时照旧认领，因为拒认会让结论退化成"没有产物"。
 * 每一份被拒的候选都留原因（`rejected[{path,source,why}]`），**没有归属就明确拒绝，不许猜**。
 *
 * @param {{runArtifacts?:string[], taskId?:string, workspace?:string, startedAt?:number,
 *          extOk?:(p:string)=>boolean, hasExts?:boolean, extLabel?:string}} o
 * @returns {{paths:string[], accepted:Array<{path:string,source:string}>, rejected:Array,
 *            source:string, why:string, startedAt:number}}
 */
function discoverArtifactsForConcludeCore(o) {
  const opt = o || {};
  const workspace = String(opt.workspace || '');
  const startedAt = Number(opt.startedAt) || 0;
  const extOk = typeof opt.extOk === 'function' ? opt.extOk : () => false;
  const hasExts = opt.hasExts === true;
  const extLabel = String(opt.extLabel || '未声明');
  const runArtifacts = Array.isArray(opt.runArtifacts) ? opt.runArtifacts : [];

  const rejected = [];
  const cands = [];
  const seen = new Set();
  const addCand = (p, source) => {
    const s = String(p == null ? '' : p);
    if (!s || seen.has(s)) return;
    seen.add(s);
    cands.push({ path: s, source });
  };
  // ① 本 run 已落账的产物
  for (const p of runArtifacts) addCand(p, 'run.artifacts');
  // ② 本任务 trace 里真实的写入动作
  let evts = [];
  try {
    const t = taskTrace.read(String(opt.taskId || ''));
    evts = (t && Array.isArray(t.events)) ? t.events : [];
  } catch { evts = []; }
  for (const e of evts) {
    if (!e || e.kind !== 'tool' || e.name !== 'file-write') continue;
    const raw = e.params && e.params.path;
    if (!raw) continue;
    const s = String(raw);
    addCand(path.isAbsolute(s) ? s : path.resolve(workspace, s), 'trace-write');
  }
  // ③ 工作区扫描（本任务开始之后落地的、且扩展名属于契约的，才算"候选"）
  try {
    for (const n of fs.readdirSync(workspace)) {
      const abs = path.join(workspace, n);
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      if (hasExts && !extOk(abs)) continue;   // 扩展名不属于契约 ⇒ 不当候选（也就不必解释）
      addCand(abs, 'workspace-scan');
    }
  } catch { /* 工作区读不到：不兜底（宁可不认，也不拿假路径去认） */ }

  const ok = [];
  for (const cand of cands) {
    const p = cand.path;
    /**
     * ★★★【KI-001 · 2026-10-28】逐件闸门已抽成模块级 `judgeContractArtifact()` —— 与
     *   `shell-exec` 执行区间的归属通道**共用同一份**判据（扩展名 / 存在 / 非空 / 时间窗 /
     *   pptx 可解析），顺序与文案逐字保留。抽出来的理由见那个函数的头注（禁止第二套标准）。
     *
     * 时间窗仍然只对 ②③ 两级生效：① 是本 run 自己的账，它落账那一刻就证明了归属，
     *   再要求 mtime 晚于 startedAt 只会把"续跑复用上次产物"判死。
     */
    const verdict = judgeContractArtifact(p, {
      extOk,
      extLabel,
      startedAt: cand.source === 'run.artifacts' ? 0 : startedAt,
    });
    if (!verdict.ok) {
      rejected.push({ path: p, source: cand.source, why: verdict.why });
      continue;
    }
    ok.push({
      path: p,
      source: cand.source,
      mtimeMs: verdict.mtimeMs,
      // 备份判定放到循环**之后**统一算：它需要同级候选一起看（同基名正本是否存在），
      // 循环中拿不到全集。这里先占位，别在这里就地判。
      backup: { is: false, rule: '', stem: '', stripped: '' },
    });
  }

  /**
   * ★★ 2026-10-28【备份判定的第二道闸】必须拿到**同级全集**再判，单看一个文件名不算证据。
   *
   * 为什么要两遍：`looksLikeBackup` 的结论取决于"同级有没有同基名的正本"——
   *   只有 `zhongzhi-5.backup.pptx` 而**没有** `zhongzhi-5.pptx` 时，它就不是谁的备份，
   *   它本身可能就是用户那份交付物（用户把它命名成 `xxx-副本` 是真实写法）。
   *   实测代价见 `_lead-backup-two-gaps.mjs` 场景②：一份 5 页合格件因此被判成 PARTIAL。
   */
  for (const x of ok) x.backup = looksLikeBackup(x.path, ok);

  const PRIORITY = { 'run.artifacts': 0, 'trace-write': 1, 'workspace-scan': 2 };
  /**
   * ★★ 2026-10-28【同级降权】排序三层，顺序不能颠倒：
   *   ① 来源优先级（`PRIORITY`）—— 本 run 的账 > trace 写入 > 工作区扫描，这一层最硬；
   *   ② **备份降权**：非备份在前（`backup.is` 升序）—— 只在同一来源内部生效，
   *      因为 ① 先比过了，所以它天然只是"同级降权"，不会跨级抢位；
   *   ③ mtime 降序 —— 同级里最新的优先（原有语义，未改）。
   *
   * ⚠️ 为什么 ② 必须在 ③ 之前：`same[0]` 就是"将被认领的那一份"。若先按 mtime 排完再降权，
   *   得到的是"最新的备份"与"最新的非备份"混在一起，等于把备份仍然排到了第一位。
   * ⚠️ 为什么是"降权"不是"过滤"：见 `looksLikeBackup` 头注里那段「永远不用来排除」。
   *   同级只剩备份时必须照旧认领它 —— 拒认会让结论退化成「没有产物」，比误认更糟。
   */
  ok.sort((a, b) => {
    const pa = PRIORITY[a.source] === undefined ? 9 : PRIORITY[a.source];
    const pb = PRIORITY[b.source] === undefined ? 9 : PRIORITY[b.source];
    if (pa !== pb) return pa - pb;
    const ba = a.backup && a.backup.is ? 1 : 0;
    const bb = b.backup && b.backup.is ? 1 : 0;
    if (ba !== bb) return ba - bb;
    return b.mtimeMs - a.mtimeMs;
  });
  let paths = [];
  let source = '';
  if (ok.length) {
    const top = ok[0].source;
    source = top;
    const same = ok.filter((x) => x.source === top);
    // 工作区扫描这一级只取最新一份：同级文件谁属于本任务**无法区分**，多取就是猜。
    // （`same` 已由上面的排序保证"非备份在前、同级最新在前" ⇒ `same[0]` 就是该认领的那一份）
    const nonBackup = same.filter((x) => !(x.backup && x.backup.is));
    paths = (top === 'workspace-scan') ? [same[0].path] : same.map((x) => x.path);
    if (top === 'workspace-scan' && same.length > 1) {
      for (const extra of same.slice(1)) {
        const isBak = !!(extra.backup && extra.backup.is);
        /**
         * 留痕分两种，**都不许静默**：
         *   · 因"像备份"被降权的 ⇒ 写明命中了哪条规则，并说清"是降权、不是排除"。
         *     否则事后只会看到"这份文件没进产物"，读的人会以为它压根没被看见。
         *   · 其余（同级多份、谁都不像备份）⇒ 沿用原来的理由，语义一字不改。
         * ⚠️ 只有当**确实存在非备份候选**时才说"降权"：同级全是备份时，被选中的那份本身就是备份，
         *   此时说"让位给非备份"是假的（没有可让的对象）⇒ 退回"同级只取最新一份"的原始理由。
         */
        rejected.push({
          path: extra.path, source: extra.source,
          why: (isBak && nonBackup.length > 0)
            ? '文件名像备份（命中 `' + extra.backup.rule + '`）⇒ 在同级里**降权**，不是被排除；'
              + '同级有 ' + nonBackup.length + ' 份非备份候选，优先认领它们'
            : '同一级有 ' + same.length + ' 份同类型候选，无法确认哪一份属于本任务 ⇒ 只认最新的那一份',
        });
      }
    }
    /**
     * ⚠️ 这里**不要**为了"认领了一份备份"往 `rejected` 里补一条：
     *   `rejected` 的契约是「每一份**被拒**的候选留原因」，把一份**已认领**的路径塞进去，
     *   会让 `被拒 N 份` 这个读数变成错的，读报告的人也会把它当成"这份被拒了"。
     *   （认领的那份要不要额外解释，见下面 `why` 前的说明：加第二道闸后不需要了。）
     */
  }
  /**
   * ★ 2026-10-28【这里曾经有一条 `pickedBak`，已删】它原本给结论加一句"认领的这份名字像备份，
   *   但同级只有它 ⇒ 仍认领"。加了第二道闸之后这段**不可达**，留着就是死分支：
   *
   *   设 `source === 'workspace-scan'` 且 `paths[0]` 被判成备份 ⇒ 按定义 `ok` 里存在同基名的
   *   非备份正本。那个正本要么也在 scan（同一 `same` 数组）——排序把非备份排前，那它就是
   *   `same[0]`，被认领的就不是这份了；要么在 trace-write / run.artifacts——其优先级更高(数字更小)，
   *   `top` 便不是 `workspace-scan`。两条路都与前提矛盾 ⇒ 该分支永远不成立。
   *
   * ⇒ 结论里不再解释"为什么挑了个备份"，因为**这种情况已经不存在**：名字像备份但没有同基名正本
   *   的文件，现在压根不算备份，认领它与认领任何普通文件没有区别，多一句话反而是噪音。
   *   真正的留痕在 `rejected`（被降权那份写明命中哪条规则）——那道闸仍有效，见 F3/G2。
   */
  const why = paths.length
    ? '本次模型没有提交产物清单；按归属顺序（run.artifacts → trace 写入动作 → 本任务时间窗内的工作区扫描）'
      + '认定 ' + paths.length + ' 份产物（来源 ' + source + '），被拒 ' + rejected.length + ' 份'
    : '本次模型没有提交产物清单；按归属顺序查了 run.artifacts / trace 写入动作 / 工作区扫描，'
      + '没有任何一份能确认属于本任务（被拒 ' + rejected.length + ' 份，原因见 rejected）';
  return {
    paths,
    /** 通过归属检查的那些候选（`paths` 的来源明细），给验收项判"能不能归属"用。 */
    accepted: paths.map((p) => ({ path: p, source })),
    rejected,
    source,
    why,
    /** 本次判定用的时间窗（写进报告，事后能复核"为什么这份被拒")。 */
    startedAt,
  };
}

/**
 * 开启一次工作流运行。非 PPT 任务返回 null（调用点无须分支，整段自然 no-op）。
 *
 * 起手就把 brief / outline / asset_inventory 三个阶段的证据备齐 —— 这三条**不需要模型配合**：
 *   brief           证据=用户原话本身
 *   outline         证据=从原话抽出的硬规格（页数/交付格式/验收项数量）
 *   asset_inventory 证据=本次真实附件清单
 * 剩下的 build / validate / final_validate / deliver 要等真有产物才算数，见 markBuild / conclude。
 */
function startWorkflowRun(opts) {
  const o = opts || {};
  const text = String(o.text || '');
  // ── 选工作流：统一走注册表（识别职责不在本函数里了）
  //   注册表按优先级试各工作流的 `match()`，第一个非 null 胜出；`match` 抛错按未命中处理。
  //   ★ 这个 try/catch 兜的**只有** `selectWorkflow` 调用本身抛错（近乎不可达：它内部已逐项
  //     try 过）。注册表模块被写坏（语法错 / 缺文件）属**加载期**故障，`require` 在文件顶部
  //     就抛了，根本进不到这里 —— 本函数的 try 兜不住，也不该假装能兜。
  // ★ 2026-10-25：允许调用方把**已经算好的**选择结果传进来（`o.selection`）。
  //   为什么要这个口子：主循环需要的不是"控制器"，而是"选中的是哪套工作流、它声明了哪些判据"——
  //   lifecycle:'none' 时只有前者不存在。若只让本函数内部做选择，主循环永远拿不到 'none' 项的身份
  //   （本函数对它返回 null），于是只能退回"按 PPT 判"。
  //   ⚠️ 用 `!== undefined` 而不是真值判断：调用方明确传 null（选择确实失败）时必须与"没传"区分，
  //      否则会**再选一次**，两次结果可能不一致。
  let picked = null;
  if (o.selection !== undefined) {
    picked = o.selection;
  } else {
    try { picked = workflows.selectWorkflow(text, { attachments: o.attachments, taskId: o.taskId }); } catch { picked = null; }
  }
  const detected = picked ? { workflowId: picked.workflowId, version: picked.version, spec: picked.spec } : null;
  if (!detected) return null;
  // ★★ 兼容层：lifecycle 'none'（通用兜底 general-v1）**不建控制器**。
  //   返回 null ⇒ 本文件里所有 wfCtl.* 调用点全部 no-op（实测 27 处，均已核过有 null 守卫），
  //   与「注册表引入前非 PPT 返回 null」逐字等价。
  //   为什么不做一个 no-op 控制器：那会让这 27 个调用点从 null 变非 null，
  //   只要 checks()/priorBuild/conclude() 任何一个漏了 no-op 就会改变行为
  //   （验收严格度、复用门禁、终态语义）。结构上不建，比"方法全写对"可靠。
  //   ★ 实测（非推理，2026-10-24）：把下面这段早退删掉、让兜底项硬建控制器，
  //     3/3 次调用全部在 open 之后抛 TypeError: Cannot read properties of null (reading 'requiredChecks')
  //     —— 因为 general-v1 的 cfg 刻意是 null（它不许声明 requiredChecks，见 general-v1.js 头注）。
  //     所以「不建控制器」不是设计偏好，是结构必然：兜底项根本没有可执行契约，硬建就崩。
  //     负控证据：scripts/tmp-probe/_lead/wf-registry/impl-selfcheck.mjs [D-arm] 组（原版 openCount=0 / 变异体 openCount=3）。
  if (picked.lifecycle === 'none') {
    // 只在显式打开调试开关时打一行，默认静默：这是选择结果的观测点，不是产品行为。
    if (process.env.DOUYA_DEBUG_WORKFLOW === '1') {
      try { console.log('[workflow] select ' + picked.workflowId + ' lifecycle=' + picked.lifecycle); } catch { /* 旁路 */ }
    }
    return null;
  }
  const cfg = picked.cfg;

  // ── 跨请求状态：有状态就接着上次的账走，没状态就是全新 run（零迁移）
  let wfState = null;
  const openErrors = [];
  if (workflowState.isEnabled() && o.taskId) {
    // 同进程重复进入的挡板。⚠️ 它覆盖不了「两个请求都在 runningTasks.set 之前进来」的窗口
    //   —— 那个窗口只有跨进程租约（lease.epoch）能挡，见 workflowState 头注第 4 条。
    if (runningTasks.has(String(o.taskId))) return null;
    /**
     * ★ 2026-10-23 修（C4-a/C4-b 抓到的真缺陷）：这里**漏传三个入参**，而恢复判据全靠它们。
     *   症状不是报错，是「恢复看起来跑了、但每次都从头重做」：
     *   · 漏 spec       ⇒ run.spec 恒为 {} ⇒ stageEvidence('outline') 永远判「页数规格未固化」
     *                     ⇒ 每次重启 gap 被拉回 outline，已有产物白做（实测 resumeStage 从 build 退回 outline）
     *   · 漏 workspaces ⇒ candidateDecks 恒空 ⇒ adoptArtifact 永远没有候选 ⇒ 磁盘上明明有成品也不认领
     *   · 漏 traceEvents⇒ trace 里 file-write 的产物路径也收不到（写绝对路径的场景只剩这一个来源）
     *   三个都补上后同一场景：resumeStage=render、adopted=<deck>、completedStages 补上 build。
     * ⚠️ 不许把这段"顺手简化"掉：删掉任何一个，纯函数单测仍然是绿的，只有真跑中断恢复才会露。
     */
    let resumeTrace = [];
    try {
      const t = taskTrace.read(String(o.taskId));
      resumeTrace = (t && Array.isArray(t.events)) ? t.events : [];
    } catch { resumeTrace = []; }
    try {
      wfState = workflowState.open({
        taskId: String(o.taskId), cfg, text, attachments: o.attachments,
        spec: detected.spec,
        workspaces: [AGENT_WORKSPACE],
        traceEvents: resumeTrace,
      });
    } catch (e) {
      // open 失败 = 降级成「没有状态」，绝不中断任务（状态存不下不该让本次任务死掉）
      openErrors.push({ stage: 'workflowState.open', error: String((e && e.message) || e) });
    }
  }
  const wfMode = (wfState && wfState.mode) || 'disabled';
  const observer = wfMode === 'observer';

  /**
   * 保管点④：续跑核对。三个读数一起看（老板 D 条件④）：
   *   · 原件哈希 = `check().firstSha1`（库里记的**最初那一版**）
   *   · 当前哈希 = `check().sha1`（磁盘上此刻的真实内容）
   *   · 历史版本 = `events()` 里这个路径的每条 `artifact-kept`（带 storePath ⇒ 能取回）
   * `check().changed` 是"跟最近一次 keep 比"—— 因为每次真实落地都保管，所以
   * "最近一次 keep"就等于"上一次请求结束时的那一版"，这正是续跑要回答的问题。
   *
   * ⚠️ 这里**只核对、不恢复**（老板 D 条件⑥「不自动覆盖当前文件」）：
   *   恢复是用户的决定。把"发现变了"和"改回去"分成两件事，是因为前者可以自动，
   *   后者一旦自动就可能覆盖掉用户**故意**做的那次修改（比如他自己改了两页）。
   * ⚠️ 位置：`open()` 之后、`state` 构造之前 —— 此时只有 `wfState.run.artifacts` 可读。
   */
  const custodyPre = [];
  if (wfState && wfState.run && Array.isArray(wfState.run.artifacts) && wfState.run.artifacts.length) {
    let histAll = [];
    try { histAll = artifactCustody.events(); } catch { histAll = []; }
    const KEPT_KINDS = ['artifact-kept', 'artifact-kept-dedup'];
    const normPath = (x) => String(x || '').replace(/\\/g, '/');
    for (const p of wfState.run.artifacts.slice(-20).map(String)) {
      const key = normPath(p);
      const revisions = histAll
        .filter((e) => e && KEPT_KINDS.includes(e.kind) && normPath(e.path) === key)
        .map((e) => ({ at: e.at, sha1: e.sha1, bytes: e.bytes, storePath: e.storePath }));
      try {
        const c = artifactCustody.check(p);
        if (c && c.ok) {
          custodyPre.push({
            path: p,
            status: c.missing ? 'missing' : (c.changed ? 'changed' : 'same'),
            firstSha1: c.firstSha1, sha1: c.sha1, baselineSha1: c.baselineSha1, revisions,
          });
        } else if (c && c.reason === 'not_kept') {
          // 接线之前留下的产物：补一次保管把它纳入保护。这是**唯一**允许把"当前内容"
          // 当基线的地方 —— 它从没被保管过，不存在更早的版本可比。
          const k = custodyKeep(p, 'resume-precheck', o.taskId);
          custodyPre.push({
            path: p, status: k && k.ok ? 'adopted' : 'adopt_failed',
            reason: k && k.ok ? '' : ((k && k.reason) || 'unknown'), revisions,
          });
        } else {
          custodyPre.push({ path: p, status: 'unverified', reason: (c && c.reason) || 'unknown', revisions });
        }
      } catch (e) {
        custodyPre.push({ path: p, status: 'error', reason: String((e && e.message) || e), revisions });
      }
    }
    try {
      taskTrace.record(String(o.taskId || ''), 'custody', {
        phase: 'resume-precheck', count: custodyPre.length, items: custodyPre.slice(0, 10),
      });
    } catch { /* 旁路：记录失败不影响主流程 */ }
  }

  const state = {
    cfg,
    detected,
    run: (wfState && wfState.run) ? wfState.run : workflowRunner.createRun(cfg, detected.spec),
    concluded: null,       // evaluate 结论（只算一次；收尾与兜底都读它）
    mode: wfMode,
    store: (wfState && wfState.store) || null,
    resumeStage: (wfState && wfState.resumeStage) || '',
    errors: openErrors,
    buildMarked: false,
    /** 点④的核对读数（续跑时才有内容）；点⑤的审计读数挂在 `state.custodyAudit`。 */
    custodyPre,
    // 本机没有可用 pptx 渲染器（只有 PowerPoint GUI，无稳定 CLI）。
    // 将来真接入渲染器时，这里与 rendered 置位必须**一起**改，否则「有渲染器却没渲染」会被判合格。
    rendererAvailable: false,
    rendered: false,
  };

  /**
   * ★★ 2026-10-28【F7】任务规格的**唯一取值点**：续跑时读**冻结账本**，不许现算。
   *
   * 病根（实测）：本函数里同一件事有两个来源 ——
   *   · 契约对照（`conclude()` 里 `contractSpec.planned`）读 `state.run.spec.slideCount`
   *     （`createRun` 固化下来的**用户原话规格**），注释里已经写明"不用 detected.spec 现算的第二份"；
   *   · 而真正喂给 `slide_count_matches_plan` 的 `evalCtx.planned` 读的是 `detected.spec.slideCount`
   *     —— 每来一次请求就按**这一次**的用户原话重新解析一遍。
   *   于是「同一份任务，验收标准在两次请求之间可以不同」：续跑时用户随口补一句「顺便多讲点」
   *   就可能把 exact 规格漂成 range，或反之；同一份 trace 里躺着两套规格口径。
   *
   * 口径（三条，缺一条这条修复就变成"另一个口径"）：
   *   ① 账本里有 `slideCount` ⇒ **只认它**（首轮就是它：`createRun(cfg, detected.spec)` 立刻固化）；
   *   ② 账本里真的没有（旧版账本 / `open()` 没拿到 spec）才回落 `detected.spec.slideCount`，
   *      且**回落必须进 trace**（`phase:'spec-fallback'`），否则就是"凭空发明了一个标准还不留痕"；
   *   ③ 两处消费点（`outline` 证据、`evalCtx.planned`）**共用这一个值**，不许各自再读一次 `detected`。
   *   ⚠️ `defaultSlideCount`（`{mode:'range',min:8,max:20}`）**不许**当默认值静默生效：
   *      它只在 `parseSlideCount` 里"用户没提页数"时才算一个规格，且带 `source:'default'`
   *      （证据里明写"按配置默认"），不是这里的回落目标。
   */
  const frozenRunSpec = (state.run && state.run.spec && typeof state.run.spec === 'object'
    && !Array.isArray(state.run.spec)) ? state.run.spec : {};
  const hasFrozenSlideCount = (frozenRunSpec.slideCount !== undefined && frozenRunSpec.slideCount !== null);
  const plannedSlideSpec = hasFrozenSlideCount
    ? frozenRunSpec.slideCount
    : ((detected.spec && detected.spec.slideCount !== undefined && detected.spec.slideCount !== null)
      ? detected.spec.slideCount : null);
  const plannedSlideSource = hasFrozenSlideCount
    ? 'frozen-run-spec'
    : (plannedSlideSpec !== null ? 'fallback-detected-spec' : 'none');
  if (!hasFrozenSlideCount && plannedSlideSpec !== null) {
    try {
      taskTrace.record(String(o.taskId || ''), 'workflow', {
        phase: 'spec-fallback',
        field: 'spec.slideCount',
        source: plannedSlideSource,
        planned: plannedSlideSpec,
        why: '冻结账本（state.run.spec）里没有 slideCount ⇒ 按本次请求现算的规格回落；'
          + '回落必须留痕，否则事后无法区分"用户当初就是这么说的"与"我们今天又解析了一遍"',
      });
    } catch { /* 旁路：记录失败不影响主流程 */ }
  }

  const step = (stage, evidence) => {
    if (observer) return false;   // 观察者不推进阶段（plan H2）
    try {
      state.run = workflowRunner.markStage(state.run, cfg, stage, evidence);
      try { if (state.store) state.store.save(state.run); } catch (e) {
        state.errors.push({ stage: 'persist:' + stage, error: String((e && e.message) || e) });
      }
      return true;
    } catch (e) {
      state.errors.push({ stage, error: String((e && e.message) || e) });
      return false;
    }
  };
  const waive = (stage, reason) => {
    if (observer) return false;   // 观察者不推进阶段（plan H2）
    try {
      state.run = workflowRunner.waiveStage(state.run, cfg, stage, reason);
      try { if (state.store) state.store.save(state.run); } catch (e) {
        state.errors.push({ stage: 'persist:' + stage, error: String((e && e.message) || e) });
      }
      return true;
    } catch (e) {
      state.errors.push({ stage, error: String((e && e.message) || e), waived: true });
      return false;
    }
  };

  // ★ 跨请求判据（只取这一刻，之后不再重算）：open() 拿到磁盘状态时，build 是否**已经**完成？
  //   为什么必须前置：下面 step('brief') 起会推进本次运行自己的账；若在闸门里现读
  //   state.run.completedStages，本次运行刚标的 build 也会命中 ⇒ 闸门变成"同一请求里也不许再生成"，
  //   那是另一种（有害的）行为。这里要的是"上一次请求已经做完的活，这次别再重做"。
  // ★★ 2026-10-25【契约切口 1/3 · 阶段契约】`build` 是**阶段名**，不是 PPT 身份标识。
  //    本工作流把哪个阶段叫"产物阶段"由 `cfg.buildStage` 声明（见 pptx-v1.BUILD_STAGE 头注），
  //    通用入口**不再持有**这个字面量。缺声明 ⇒ 没有产物阶段可言 ⇒ priorBuild 恒 false ——
  //    宁可闸门不武装，也不能拿别的依据猜；猜错的代价是拦掉正常任务（误拦比漏拦更糟）。
  const buildStage = (cfg && typeof cfg.buildStage === 'string' && cfg.buildStage) ? cfg.buildStage : '';
  const priorBuild = !!(buildStage && wfState && wfState.run && Array.isArray(wfState.run.completedStages)
    && wfState.run.completedStages.includes(buildStage));
  const priorResumeStage = String((wfState && wfState.resumeStage) || '');

  // ① brief：证据就是用户原话
  step('brief', '用户原话（' + text.length + ' 字）：' + text.replace(/\s+/g, ' ').slice(0, 180));
  // ② outline：证据是**抽出来的硬规格**，不是模型的自述
  //    ★ F7：这里读 `plannedSlideSpec`（冻结账本优先），不读 `detected.spec.slideCount`。
  //      否则同一份 trace 里会同时躺着"现算的规格"（这句）与"冻结的规格"（收尾验收用）两套口径。
  //      来源串进证据（frozen-run-spec / fallback-detected-spec），事后能一眼看出这次是不是回落过。
  const mustCount = (cfg.requiredChecks || []).filter((c) => c.severity === 'must').length;
  step('outline', '任务规格：' + describeSlideSpec(plannedSlideSpec)
    + '（规格来源：' + plannedSlideSource + '）'
    + '；交付格式必须是 ' + cfg.deliverable.format
    + (detected.spec.explicitPptx ? '（用户明确点名 pptx，不许用网页顶替）' : '')
    + '；验收项 ' + (cfg.requiredChecks || []).length + ' 项（其中 must ' + mustCount + ' 项）；'
    + '必需阶段 ' + (cfg.requiredStages || []).length + ' 个');
  // ③ asset_inventory：证据是真实附件清单
  const atts = Array.isArray(o.attachments) ? o.attachments.filter(Boolean) : [];
  step('asset_inventory', atts.length
    ? '用户附件 ' + atts.length + ' 个：' + atts.slice(0, 10).map((a) => String(a && (a.name || a.path) || a)).join('、')
    : '用户本次未附任何素材（0 个）—— 图片位全部需要自行生成或留白');

  /**
   * ★★ 2026-10-25【契约切口 2/3 · 产物类型契约】哪些扩展名算本工作流的产物，由 `cfg.buildExts`
   *   声明（见 pptx-v1.BUILD_EXTS 头注）。
   *   **没有全局回落**：没声明 ⇒ 本工作流没有"专用产物阶段"可言 ⇒ 明确 return false，
   *   绝不默认 `.pptx`。默认回落等于把通用执行入口重新绑死到 PPT。
   */
  const buildExts = (cfg && Array.isArray(cfg.buildExts) ? cfg.buildExts : [])
    .map((x) => String(x == null ? '' : x).trim().toLowerCase())
    .filter((x) => x.length > 1 && x.charAt(0) === '.');
  /**
   * 产物落地时才允许标 build。判据是**真有本工作流声明的产物类型**（扩展名由上面 `buildExts`
   * 给出；PPT 工作流今天就是 `.pptx`），不是"模型说它生成了 PPT"。
   * 解析结果（可打开/页数/slide 文件数）一并写进证据，免得收尾时再读一遍文件。
   */
  const markBuild = (artifacts, inspections) => {
    if (state.buildMarked) return false;
    if (!buildStage || !buildExts.length) return false;   // 未声明契约 ⇒ 明确跳过（不回落 .pptx）
    const list = (artifacts || []).filter((p) => {
      const ext = path.extname(String(p == null ? '' : p)).toLowerCase();
      return !!ext && buildExts.indexOf(ext) >= 0;
    });
    if (!list.length) return false;
    state.buildMarked = true;
    const bits = list.slice(0, 5).map((p) => {
      const info = inspections && inspections[p];
      return p + (info ? '（解析：' + (info.openable ? info.slideCount + ' 页' : '打不开——' + (info.error || '未知'))
        + '，slide 文件 ' + (info.slideFiles || 0) + ' 个）' : '');
    });
    return step(buildStage, '产出 ' + buildExts.join('/') + ' ' + list.length + ' 份：' + bits.join('；'));
  };

  /**
   * ══【F1b】页数预算的**确定性注入** —— 全文件唯一实现，唯一调用点是下面三个 `runSkill(...)` ══
   *
   * 为什么必须有这一段（不是"锦上添花"）：把页数算术写进提示词这条路**已经实测失效**。
   *   snap-inject A/B 的 seed5 与 seed6 输入**逐字相同**，提示词原文是
   *   「它**会自动加一页封面**，所以 slides 只传 4 页正文（缺牙的危害 / 种植牙原理 / 活动政策 / 到店转化），
   *    最终文件正好 5 页」—— 算术给了、4 个标题也点了，seed6 照样传 5 条 ⇒ 6 页 ⇒ must 判失败。
   *   让"被校验者自愿传参"来生效的校验，等于没有校验。所以预算由**产品**塞进去。
   *
   * 三条规则（只有这三条，不要再扩）：
   *   ① `name` 不是本工作流声明的产物技能（`cfg.pageBudget.skill`）⇒ **原样返回入参**，零副作用；
   *      未声明 `cfg.pageBudget` ⇒ 同样不注入（失败关闭，绝不猜一个技能名去塞参数）。
   *   ② 规格是 `exact` ⇒ **强制**覆盖成 `参数 = 总页数`（产品值优先）。模型若也传了且值不同，
   *      记一条 trace（`phase:'slide-budget-injected'`，带 modelValue / used / planned），
   *      事后能看出"模型本来想传几页"——这条是本次修复的**观测面**，不是判据。
   *   ③ 规格是 `range` 或缺失 ⇒ **不注入**，行为与今天逐字一致（范围不能强判等，别硬凑）。
   *
   * 硬边界（改这里之前先读这三条）：
   *   · **只加/覆盖一个入参**，不碰 `argsInfo`、不碰 `canExecute`、不碰任何门禁与判据；
   *   · 不改 `skills.js`（技能的失败语义在 `run.py` 里用非 0 退出表达，无需动 bootstrap）；
   *   · 返回的可能是**新对象**，调用方只把它交给 `runSkill`，原来的 `params` 继续用于记账/门禁
   *     （见调用点）——这样"注入"对账本、对门禁判据是**不可见**的。
   *
   * @param {string} name 技能 id
   * @param {object} params 模型给的原始入参
   * @returns {object} 交给 runSkill 的入参（可能是同一个对象）
   */
  const pageBudgetDecl = (cfg && cfg.pageBudget && typeof cfg.pageBudget === 'object' && !Array.isArray(cfg.pageBudget))
    ? cfg.pageBudget : null;
  const pageBudgetSkill = (pageBudgetDecl && typeof pageBudgetDecl.skill === 'string') ? pageBudgetDecl.skill : '';
  const pageBudgetParam = (pageBudgetDecl && typeof pageBudgetDecl.param === 'string') ? pageBudgetDecl.param : '';
  const withPageBudget = (name, params) => {
    if (!pageBudgetSkill || !pageBudgetParam) return params;          // 未声明契约 ⇒ 不注入
    if (String(name == null ? '' : name) !== pageBudgetSkill) return params;  // 不是产物技能 ⇒ 零副作用
    const pages = slideBudgetPages(plannedSlideSpec);                  // 只认 exact（range ⇒ 0）
    if (!pages) return params;                                        // 没有可强制的确切页数 ⇒ 不注入
    const base = (params && typeof params === 'object' && !Array.isArray(params)) ? params : {};
    const modelValue = base[pageBudgetParam];
    try {
      taskTrace.record(String(o.taskId || ''), 'workflow', {
        phase: 'slide-budget-injected',
        skill: pageBudgetSkill,
        param: pageBudgetParam,
        planned: plannedSlideSpec,
        specSource: plannedSlideSource,
        used: pages,
        modelValue: (modelValue === undefined || modelValue === null) ? null : modelValue,
        overridden: (modelValue !== undefined && modelValue !== null && Number(modelValue) !== pages),
      });
    } catch { /* 旁路：记录失败不影响主流程 */ }
    return Object.assign({}, base, { [pageBudgetParam]: pages });
  };

  /**
   * 工作区里现有的**本工作流产物**（按契约扩展名），按 mtime 从新到旧。
   *
   * ⚠️ 2026-10-26：这个函数**只剩一个合法用途** —— 复用闸门（`planReuseGate`）判「上一次的产物还在不在」。
   *   收尾兜底**不再**用它：按扩展名无条件扫共享工作区，然后把任何同类型文件认成"本次交付物"，
   *   正是本阶段要拆掉的东西（实测：`.txt` 任务的收尾兜底把**上一次请求**留下的 `.pptx` 认成交付物
   *   ⇒ 六项 PPT 检查全过 ⇒ verdict=COMPLETE，而同一份报告里同时写着"契约偏差 format：期望 txt，实际 pptx"）。
   *   兜底发现改走 `discoverArtifactsForConclude()`（按契约 + 归属三重验证）。
   */
  /**
   * ★★ 2026-10-26【残余耦合修复 · 点 2】扫描口径改为**契约驱动**（`buildExts`），不再写死 `.pptx`。
   *
   * 修前：`.filter((f) => /\.pptx$/i.test(f))` —— 复用闸门的"磁盘上真的有产物吗"这一步被写死成 pptx。
   *   后果（实测，scripts/tmp-probe/_lead/coupling-fix/p2-reusegate.mjs 修前读数）：
   *   一套声明了 `regenKind` + `buildExts:['.txt']` 的工作流，工作区里明明有 `report.txt`、
   *   `priorBuild=true`、`regenKind` **也确实被调用了 1 次**，但 `found=[]` ⇒ `blocked=false`
   *   ⇒ **判据跑了却被空扫描作废**。再往同一目录补一份 `.pptx`（正控）就 `blocked=true`
   *   ⇒ 拦截靠的是那份 `.pptx` 存在，不是 txt 契约。
   *   为什么今天没爆：`general-v1` 是 `lifecycle:'none'` ⇒ 不建控制器 ⇒ `priorBuild` 恒 false
   *   ⇒ 闸门首行就返回。第一个非 PPT 的 full 工作流接入即静默失效。
   *
   * 改法：扩名清单取 `buildExts`（与 `extMatches` / `discoverArtifactsForConcludeCore` 同一来源）。
   *   `exts` 入参可选，给门禁/探针单独指定用；不传就用闭包里的 `buildExts`。
   *   **空清单 ⇒ 返回 `[]`（失败关闭）**，与 `extMatches` 的既有约定一致
   *   （`if (!buildExts.length) return false;`）：没声明产物类型就没有"可复用的产物"这回事，
   *   宁可让闸门不武装，也不许回落成 `.pptx` 去拦别人。
   *   `size > 0` 过滤与 mtime 倒序**逐字保留**。
   * @param {string[]} [exts] 扩展名清单（`.txt` 这种带点形式）；缺省 = 本工作流的 buildExts
   * @returns {string[]} 绝对路径，mtime 新的在前
   */
  const workspaceDecks = (exts) => {
    const want = workflowRunner.normalizeExts(Array.isArray(exts) ? exts : buildExts);
    if (!want.length) return [];   // 未声明产物类型 ⇒ 没有可复用产物（失败关闭，不回落 .pptx）
    try {
      return fs.readdirSync(AGENT_WORKSPACE)
        .filter((f) => {
          const ext = workflowRunner.extOf(f);
          return !!ext && want.indexOf(ext) >= 0;
        })
        .map((f) => path.join(AGENT_WORKSPACE, f))
        .filter((p) => { try { return fs.statSync(p).size > 0; } catch { return false; } })
        .sort((a, b) => {
          try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
        });
    } catch { return []; }
  };

  /**
   * 本工作流的产物阶段是否**存在**（`cfg.stages` 里有没有这个名字）。
   * 为什么需要：收尾流程里的 render / validate / final_validate / repair / deliver 都是
   * **阶段名**，不是"所有工作流都有的通用动作"。一个只有 4 个阶段的工作流，对 `render` 调
   * `step()` 会抛「未知阶段」、对 `repair` 调 `waive()` 会抛「不可豁免」——
   * 修前这些异常被 catch 吞进 `state.errors`，看起来"无害"，实际是拿 PPT 的阶段序列
   * 在给别的工作流记账（错误账本越积越脏）。
   */
  const hasStage = (name) => !!(cfg && Array.isArray(cfg.stages) && cfg.stages.indexOf(name) >= 0);

  /** 一个路径的扩展名是否属于本工作流的产物契约（`buildExts`，唯一来源）。 */
  const extMatches = (p) => {
    if (!buildExts.length) return false;
    const ext = workflowRunner.extOf(p);
    return !!ext && buildExts.indexOf(ext) >= 0;
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * 收尾兜底发现（2026-10-26）—— **只认能归属到本任务的产物**。
   *
   * 修前：`if (!list.length && priorBuild) { const cands = workspaceDecks(); … }`
   *   —— 按 `.pptx` 无条件扫共享工作区，取第一份能解析的就当本次交付物。
   *   两个人共用一个工作区时，别人的成品会被算成本次的交付；更要命的是它与工作流的
   *   交付格式完全无关（`.txt` 任务也能被塞一份 `.pptx`）。
   *
   * 现在的顺序（优先级从高到低，前一级有合格项就不看后一级）：
   *   ① `state.run.artifacts` —— 本 run 自己落过账的产物（落地钩子/上一次收尾写进去的，
   *      它是"本任务"的账，不是"工作区里有什么"）；
   *   ② 本任务 trace 里真实的写入动作（`file-write` 的 path，相对路径按 WORKSPACE 解析）；
   *   ③ 工作区扫描 —— **只认本任务开始后落地的**（mtime >= run.startedAt），且扩展名必须
   *      属于本工作流产物契约；同一级里只取**最新的一份**（同级文件谁属于本任务无法区分，
   *      多取就是猜）。
   * 每一份被拒的候选都必须留下原因（`rejected`），并且整件事写进 trace（不静默）。
   * ★★ 2026-10-26：判据本体已搬到模块级 `discoverArtifactsForConcludeCore()` —— 通用任务
   *   （`lifecycle:'none'`，没有 `state.run`/`cfg`）收尾时要用**同一份**归属判据，而在闭包里
   *   再写一份就是第二套标准（老板 §4.4 明令禁止）。这里只负责把闭包里的事实喂进去：
   *   本 run 的账 / 任务 ID / 工作区 / 本 run 时间窗 / 本工作流的产物扩展名。
   * @returns {{paths:string[], accepted:Array, rejected:Array, source:string, why:string, startedAt:number}}
   */
  const discoverArtifactsForConclude = () => discoverArtifactsForConcludeCore({
    runArtifacts: Array.isArray(state.run.artifacts) ? state.run.artifacts : [],
    taskId: String(o.taskId || ''),
    workspace: AGENT_WORKSPACE,
    startedAt: Number(state.run.startedAt) || 0,
    extOk: extMatches,
    hasExts: buildExts.length > 0,
    extLabel: buildExts.join('/') || '未声明',
  });


  return {
    cfg,
    detected,
    /** ★ 注册表选择结果（与是否建控制器无关，见 o.selection 的口子） */
    selection: picked,
    state,
    step,
    waive,
    markBuild,
    /**
     * ★【F1b】页数预算注入（见 `withPageBudget` 头注）。
     *
     * 为什么必须挂出来而不是在 runAgentLoop 里再写一份：
     *   冻结规格（`plannedSlideSpec`）与契约（`cfg.pageBudget`）都住在本闭包里，
     *   调用点在 runAgentLoop（三个 `runSkill(...)`）。若在那边重写一份，
     *   立刻出现"两套取规格/取技能名"的实现 —— 正是本仓反复踩的坑。
     * 调用方约定：\`p2 = wfCtl.withPageBudget(name, params)\` 只交给 runSkill；
     *   记账 / 门禁 / 参数诊断继续用**原始** params（注入对它们不可见）。
     * 无控制器（非 full 工作流 / 状态禁用）时调用方不看这个方法，行为与今天一致。
     */
    withPageBudget,
    /**
     * 工作区里现有的本工作流产物（见上面的 workspaceDecks）。
     * 挂出来是因为**复用闸门在 runAgentLoop 里**，
     * 而扫描来源必须与 conclude 的兜底同源 —— 各扫各的迟早会分成两套判据。
     * ★ 2026-10-26：口径由 `buildExts` 决定（可传入 exts 覆盖，不传就用本工作流的契约）。
     */
    workspaceDecks,
    /**
     * 本工作流的**验收项定义**（`requiredChecks`）。给 `evidenceQuality` 判「这条检查对准了哪一项」用。
     *
     * ★ 为什么必须由这里给、而不是从 `runAgentLoop(payload, cfg, ...)` 的 `cfg` 取：
     *   `handleChat` 传进来的 `cfg` 是 `defaultConfig(dataDir)` —— 那是**网关配置**（baseURL/apiKey/model/
     *   商城账号…，26 个键），里面**根本没有** requiredChecks。
     *   2026-10-23 实测踩过这个：判据写成 `cfg.requiredChecks` ⇒ 真实路径上恒为空
     *   ⇒ 所有结果都判成"没对准验收项" ⇒ `newEv` 恒 0 ⇒ **每份真做完验收的任务都被判成原地打转提前收尾**。
     *   标准属于工作流，就该由工作流提供。这里的 `cfg` 是 `startWorkflowRun` 开头由
     *   `workflows.selectWorkflow(...)` 选出来的**那一套**工作流配置（`lifecycle === 'full'` 时
     *   就是注册项本身）；PPT 任务下它逐字等于 pptx-v1 的配置，换成别的专用工作流则是那一套。
     *   ★ 注意本文件**不再持有**任何具体工作流的引用：`cfg` 是函数作用域里的局部绑定。
     *     全文件对 workflows 只有一个 require，即顶部的 `require('./workflows')`（注册表本身）；
     *     具体工作流一律由注册表内部加载 —— 这一条由 unit-workflow-backend-wiring 的
     *     B12「注册表契约」段按源码正则守着（该文件的 B3 已被「build 阶段」占用），不靠人记。
     */
    checks() { return (cfg && Array.isArray(cfg.requiredChecks)) ? cfg.requiredChecks : []; },
    /**
     * 把一条**失败方法**记进跨请求账本（`state.run.attempts`），并立刻落盘。
     *
     * ★ 为什么必须「立刻落盘」而不是收尾时统一写：
     *   老板第 5 条挑战就是「执行到一半中断进程」。收尾统一写 ⇒ **恰恰在最需要它的那种中断里，
     *   一个字节都没写下去**。所以每失败一次就写一次（状态文件有 64KB 上限，实测一条 ≤400 字节）。
     * ★ 为什么写权在这个对象手里、而不是 backend 直接碰文件：
     *   `workflowState` 是跨请求状态的**唯一 fs 写者**（一任务一文件 / 原子写 / 写前核对租约 epoch）。
     *   backend 若能绕过去直写，那三条边界同时失效 ⇒ 这里只暴露一个"记一条"的语义接口，不暴露路径。
     * ★ 旁观者（observer：租约被别的进程占着）一律不写 —— 那不是我的账，写进去就是篡改别人的状态。
     *
     * @param {{sig:string, tool?:string, count?:number, lastKind?:string,
     *          lastError?:string, nextAction?:string, at?:number}} one
     * @returns {boolean} 真的记下去了
     */
    noteAttempt(one) {
      if (observer || state.mode === 'observer') return false;
      if (!one || typeof one !== 'object' || Array.isArray(one) || !one.sig) return false;
      try {
        const prev = Array.isArray(state.run.attempts) ? state.run.attempts : [];
        state.run = { ...state.run, attempts: workflowState.mergeAttempts(prev, [one]) };
        try { if (state.store) state.store.save(state.run); } catch (e) {
          state.errors.push({ stage: 'persist:attempts', error: String((e && e.message) || e) });
        }
        return true;
      } catch (e) {
        state.errors.push({ stage: 'attempts', error: String((e && e.message) || e) });
        return false;
      }
    },
    /** 跨请求账本的只读副本（给预热 / trace / 门禁取证用，外部改不动内部状态） */
    attempts() { return Array.isArray(state.run.attempts) ? state.run.attempts.slice() : []; },
    /**
     * 记一条**已证伪**（跨请求禁令）。★ 2026-02-16：`refuted` 的**唯一写入点**。
     *
     * 语义与 `noteAttempt` 并列（"试过几次" vs "这条路别试了"），但落账动作**不在本函数里**：
     * 真源是 `workflowState` 的 store（它是跨请求状态的唯一 fs 写者：一任务一文件 / 原子写 /
     * 写前核对租约 epoch）。这里只做三件事：observer 挡板、把账本同步回本闭包的 `state.run`
     * （否则 `attempts()` 会读到落账前的旧值，两边成了两份账）、把失败塞进 `state.errors`。
     *
     * @param {object} one 由 `toolProtocol.refuteDecision(...)` 产出
     * @returns {{ok:boolean, reason?:string, sig?:string, files?:string[]}}
     */
    refute(one) {
      if (observer || state.mode === 'observer') return { ok: false, reason: 'observer' };
      if (!one || typeof one !== 'object' || Array.isArray(one) || !one.sig) return { ok: false, reason: 'sig_required' };
      if (!state.store || typeof state.store.refute !== 'function') return { ok: false, reason: 'no_store' };
      const r = state.store.refute(one);
      if (r && Array.isArray(r.attempts)) state.run = { ...state.run, attempts: r.attempts };
      if (!r || r.ok !== true) {
        state.errors.push({ stage: 'persist:refute', error: String((r && r.reason) || 'unknown') });
        return { ok: false, reason: String((r && r.reason) || 'unknown'), sig: String(one.sig) };
      }
      return { ok: true, sig: String(r.sig || one.sig), files: Array.isArray(r.files) ? r.files.slice() : [] };
    },
    /**
     * 解除证伪（"这个方法现在能用了"）。★ 2026-02-16：`refuted` 的**唯一解除点**。
     * 与 `refute` 同一条纪律：落账真源在 store，这里只同步闭包里的账本。
     * @param {{sig?:string, tool?:string}} one
     * @returns {{ok:boolean, reason?:string, cleared:number}}
     */
    unrefute(one) {
      if (observer || state.mode === 'observer') return { ok: false, reason: 'observer', cleared: 0 };
      if (!state.store || typeof state.store.unrefute !== 'function') return { ok: false, reason: 'no_store', cleared: 0 };
      const r = state.store.unrefute(one);
      if (r && Array.isArray(r.attempts)) state.run = { ...state.run, attempts: r.attempts };
      if (!r || r.ok !== true) {
        state.errors.push({ stage: 'persist:unrefute', error: String((r && r.reason) || 'unknown') });
        return { ok: false, reason: String((r && r.reason) || 'unknown'), cleared: 0 };
      }
      return { ok: true, cleared: Number(r.cleared) || 0 };
    },
    /** 当前运行状态（老板要的六字段口径）；写进 trace，跨任务可查 */
    snapshot() {
      return {
        workflowId: state.run.workflowId,
        version: state.run.version,
        stage: state.run.stage,
        completedStages: state.run.completedStages.slice(),
        waivedStages: (state.run.waivedStages || []).map((w) => w.stage),
        openIssues: (state.run.openIssues || []).length,
        nextAction: state.run.nextAction,
        status: state.run.status,
      };
    },
    /**
     * 产物落地时才允许标 build（判据见上面的 markBuild）。保留成方法只是为了让调用点读起来顺。
     */
    markBuild,

    /**
     * 恢复/租约的可观测快照。
     * ★ 2026-10-23：**除 `priorBuild` 外**全部只读、只给 trace 用，不参与判据 ——
     *   `priorBuild` / `priorResumeStage` 是「跨请求产物复用闸门」的判据来源（见 planReuseGate），
     *   它们由 startWorkflowRun 在任何 step() 之前取定，本函数只是把它交回去，
     *   此处**不做任何重算**（重算会读到本次运行推进后的账，语义就变成"同一请求内也不许再生成"）。
     */
    stateInfo: () => ({
      mode: state.mode,
      resumeStage: state.resumeStage,
      // ★ 跨请求复用闸门的判据（取值点是 startWorkflowRun 开头，不是这里）
      priorBuild,
      priorResumeStage,
      notes: (wfState && wfState.notes) || [],
      plan: (wfState && wfState.plan) ? {
        resumeStage: wfState.plan.resumeStage,
        invalidated: wfState.plan.invalidated,
        adopted: wfState.plan.adopted || '',
        completedStages: wfState.plan.completedStages,
        waivedStages: wfState.plan.waivedStages,
      } : null,
    }),

    /**
     * 收尾终审：一次算完，幂等。
     * 返回值 = evaluate 结论；调用方据此压终态。
     */
    conclude(artifacts) {
      if (state.concluded) return state.concluded;
      let list = (artifacts || []).filter(Boolean).map(String);
      /**
       * ═══════════════════════════════════════════════════════════════════════════
       * ★ 收尾兜底（2026-10-23 引入，**2026-10-26 重写归属判据**）。
       *
       * 为什么要有兜底（真读数）：实测现场是中断恢复后模型没再调 ppt-generate，而是
       *   file-write 一个 build_pptx.py 再 shell-exec 跑出 pptx —— 文件真在磁盘上，
       *   `trackDeliverable` 只认"工具自报的产物路径"⇒ deliverables 为空 ⇒ 收尾收到空清单
       *   ⇒ 判 PARTIAL + 「没有产物」，用户以为自己的成果丢了。这是**假红**，必须修。
       *
       * 修前为什么仍然是错的：兜底是「`workspaceDecks()` 按 `.pptx` 无条件扫共享工作区」。
       *   于是（真读数）一个 `.txt` 任务在「.txt 写不出去」时，收尾把**上一次请求留下的 pptx**
       *   认成本次交付物 ⇒ 六项 PPT 检查全过 ⇒ `verdict=COMPLETE` / `status=completed`，
       *   而同一份报告里还写着「契约偏差 format：期望 txt，实际 pptx」。**假绿**，比假红更糟。
       *
       * 现在：发现交给 `discoverArtifactsForConclude()`（按本工作流产物契约 + 归属三重验证）；
       *   ① **接受**仍需 `priorBuild`（上一次请求的账里产物阶段已完成）—— 新任务一份都不认；
       *   ② `priorBuild` 不成立时**照样查一遍**并把"拒了谁、为什么"写进 trace（不静默）；
       *   ③ 每份被拒候选都带 `{path, source, why}`，结论里另有 `discovery` 字段。
       *
       * ★★ 2026-10-28【R1 · 闸门条件订正，真读数驱动】：原来这里写的是 `if (!list.length)`。
       *   那是把闸门的**字面**当成了语义 —— 要守的是「清单里没有满足产物契约的东西」，
       *   不是「清单是空的」。实测（snap-inject `pair4-inject` 臂）：模型只报了
       *   `zhongzhi-5-内容稿.md` 一份 ⇒ 清单一非空，兜底整段被短路 ⇒ `discoverArtifactsForConclude`
       *   一次都没跑（trace 里没有 `artifacts-from-evidence`），而工作区里那份
       *   `zhongzhi-5.pptx`（37456B / 可打开 / 5 页）连"被拒绝"的机会都没有 ⇒
       *   独立验收只看得到 `.md` ⇒ `requested_format_matches` 判失败 ⇒ 级联
       *   `file_opens` / `slide_count_matches_plan` / `no_duplicate_pages` 全判「没有可检查的 pptx」
       *   ⇒ PARTIAL。**用户成果没丢，是账本记错了、验收读错了。**
       *
       *   注意这条只在「清单非空、但一份契约产物都没有」这一种情形改变行为：
       *   清单里已有一份契约产物时行为**逐字不变**（不跑兜底），空清单时也**逐字不变**（跑兜底）。
       *   ⚠️ 不要把 `!list.some(...)` 简化成 `list.length === 0`：那正是被修掉的那个错。
       * ═══════════════════════════════════════════════════════════════════════════
       */
      let listFromEvidence = false;
      let discovery = null;
      if (!list.some((p) => !buildExts.length || extMatches(p))) {
        const disc = discoverArtifactsForConclude(list);
        const accepted = priorBuild ? disc.paths : [];
        const rejected = disc.rejected.slice();
        if (!priorBuild) {
          for (const p of disc.paths) {
            rejected.push({
              path: p,
              why: '上一次请求的账里没有完成过产物阶段（priorBuild=false）⇒ 不许认领（新任务不做兜底）',
            });
          }
        }
        discovery = {
          source: accepted.length ? disc.source : '',
          paths: accepted.slice(0, 5),
          rejected: rejected.slice(0, 10),
          accepted: accepted.length,
          priorBuild: !!priorBuild,
          why: disc.why,
        };
        if (accepted.length) {
          list = accepted;
          listFromEvidence = true;
        }
        try {
          taskTrace.record(String(o.taskId || ''), 'workflow', {
            phase: 'artifacts-from-evidence',
            project: cfg.workflowId,
            paths: list.slice(0, 5),
            source: discovery.source,
            accepted: accepted.length,
            priorBuild: !!priorBuild,
            rejected: rejected.slice(0, 10),
            why: disc.why + (priorBuild ? '' : '；但 priorBuild=false ⇒ 一份都不认'),
          });
        } catch { /* 旁路：记录失败不影响结论 */ }
      }

      // 本工作流产物契约下的真产物（扩展名口径见 workflowRunner 的验收契约一节）
      const produced = list.filter((p) => !buildExts.length || extMatches(p));
      const pptx = produced.filter((p) => workflowRunner.extOf(p) === '.pptx');

      // 文件只读一次：解析结果既做 build/validate 的证据，也供 evaluate 复用
      const inspections = {};
      for (const p of pptx) {
        try { inspections[p] = workflowRunner.inspectPptx(fs.readFileSync(p)); }
        catch (e) { inspections[p] = { openable: false, slideCount: 0, slideFiles: 0, duplicateGroups: [], error: String((e && e.message) || e) }; }
      }
      // ★ 传**完整清单**而不是 `pptx`：扩展名过滤已由工作流契约（buildExts）负责，
      //   这里再按 `.pptx` 预筛一遍等于把 PPT 判据又写回通用路径。
      markBuild(list, inspections);

      /**
       * 保管点③：**只有**清单由磁盘证据补全时才在收尾再保管一次。
       *   为什么不是"所有清单都保管"：模型自报的清单在落地那一刻已经过点②（`landing-hook`），
       *   这里再保管一次只会得到一条 dedup 事件，反而让 `by` 的语义变糊。
       *   而 `listFromEvidence` 的那份**从没经过点②** —— 它不是模型调 ppt-generate 写的，
       *   是模型写个 python 脚本、shell-exec 跑出来的 ⇒ 这里是它唯一进库的机会。
       */
      if (listFromEvidence && produced.length) {
        for (const p of produced) custodyKeep(p, 'conclude-fallback', o.taskId);
      }

      // ★ 产物入账（2026-10-23，真实端到端读数驱动）：
      //   实测 Build/Validate/FinalValidate/Deliver 四个阶段全部完成，磁盘 `state.run.artifacts` 仍是 []。
      //   原因是 conclude 只把清单喂给 markBuild 当证据，从不写进 run。后果不是"少记一笔"：
      //   下一次 open() 里 `artifactPathsOf` / `adoptArtifact` 都以 `state.run.artifacts` 为第一来源，
      //   它是空 ⇒ 认领链路整条瞎掉 ⇒ **用户已完成的产物在下一次请求里无法被复用**（唯一会丢用户工作的那一类）。
      //   ⚠️ 位置必须在幂等返回之后（`if (state.concluded) return state.concluded;` 在函数开头）
      //   ⇒ 这段在一次计算里只执行一次，不会把同一条路径重复 append。
      //
      // ★★ 2026-10-26【归属清理】：`artifacts` 是「**本工作流**的产物清单」，不属于本工作流产物契约
      //   （buildExts）的路径不该留在里面。修前不做这一步，于是状态文件里上一次留下的 `.pptx`
      //   会一直挂在 `.txt` 任务的账上（实测：D 段读到的 `state.run.artifacts` 仍是那份旧 pptx，
      //   看起来就像"本次交付了它"）。清理必须留痕：被移出的路径连同原因进 trace。
      const prevArts = Array.isArray(state.run.artifacts) ? state.run.artifacts.slice() : [];
      const kept = [];
      const pruned = [];
      for (const p of prevArts) {
        if (!buildExts.length || extMatches(p)) kept.push(p);
        else pruned.push(p);
      }
      const merged = kept.concat(list.filter((p) => !kept.includes(p))).slice(-20);
      if (pruned.length) {
        try {
          taskTrace.record(String(o.taskId || ''), 'workflow', {
            phase: 'artifacts-pruned',
            project: cfg.workflowId,
            paths: pruned.slice(0, 5),
            why: '这些路径的扩展名不属于本工作流产物契约（' + (buildExts.join('/') || '未声明') + '）'
              + ' ⇒ 不作为本工作流的产物保留（避免旧任务的同类文件被读成本次交付物）',
          });
        } catch { /* 旁路：记录失败不影响结论 */ }
      }
      if (merged.join('\u0000') !== prevArts.join('\u0000')) {
        state.run = { ...state.run, artifacts: merged, lastUpdated: Date.now() };
        try { if (state.store) state.store.save(state.run); } catch (e) {
          state.errors.push({ stage: 'persist:artifacts', error: String((e && e.message) || e) });
        }
        try {
          taskTrace.record(String(o.taskId || ''), 'workflow', {
            phase: 'artifacts-persisted', count: merged.length, paths: merged.slice(-5),
          });
        } catch { /* 旁路：记录失败不影响结论 */ }
      }

      /**
       * ★★【F2 · 2026-10-28】产物定稿之后给它们拍一次指纹（这是唯一"字节已定稿"的时点）。
       *
       * 为什么必须有这一笔：`artifactFingerprint` 是 `validate` / `final_validate` 的**前置** ——
       *   `workflowRunner.fingerprintProblems()` 的第一条分支是
       *   「没有指纹记录（无法复核 ⇒ 不许当已验收）」。没有记录 ⇒ 每一次续跑都把 validate 及之后作废，
       *   而这条对**每一份**产物恒真 ⇒ 用户第二次接着做的时候，上一轮挣来的验收全被扔掉。
       *   （`saveWithStore` 里那条"缺指纹就补拍"确实在工作，但它以前被 `releaseWithStore`
       *     用空 map 整体盖掉 —— 那条已由 F1 堵住；F2 是让**定稿时点**也拍一次，两者不是替代关系。）
       *
       * 为什么选 `conclude()` 而不选 `markBuild`：`markBuild` 的输入是"这一轮第一次落地"的路径，
       *   而实测现场（snap-inject `pair4-inject`）是「`file-write` 写 `_fix.py`（会过 markBuild）
       *   → `shell-exec` 用 python **就地改写** pptx」—— `shell-exec` 既不进 `deliverables`
       *   也不进 `markBuild`。在 markBuild 拍指纹 ⇒ 拍到**改写前**的字节 ⇒ 下一次 open 必然失配。
       *
       * 守卫四条：
       *   ① `!observer` + store 可写（observer 一行都不许写）；
       *   ② 传 `merged`（已过 `buildExts` 过滤的**定稿清单**），不是 `produced`（后者还带着被剪掉的旧路径）；
       *   ③ **复用上面那份 `inspections`** —— 同一个文件不读第二遍 zip；
       *   ④ 失败**不阻断**：拍不到指纹的后果是"下次判无法复核"（与本修复前同态），
       *      不该因此让一次已经完成的交付失败。
       */
      if (!observer && state.store && typeof state.store.fingerprint === 'function' && merged.length) {
        try {
          state.store.fingerprint(merged, { inspections });
          try { if (state.store.save) state.store.save(state.run); } catch { /* 落盘失败不影响结论 */ }
        } catch { /* 增益功能：拍不到就算了，不阻断收尾 */ }
      }

      /**
       * 保管点⑤：每任务收尾**一次** audit，且**不过滤失败结果**（老板 D 条件⑤）。
       *
       * 为什么"不过滤"是硬要求：过滤掉 `tampered` / `missing` 就等于"只在好消息上留痕"，
       * 而这两个恰好是唯一需要人去看的两种。`unverified` 也照记 —— 它是"不知道"，
       * 不是"没问题"；把它藏起来等于把它改写成"没问题"。
       *
       * ⚠️ 位置：在"产物入账"之后（那里刚把 list 并进 `state.run.artifacts`），
       *   且在本函数第一行 `if (state.concluded) return state.concluded;` 之后 ⇒
       *   一次计算里只执行一次，不会因为重复调用产生重复审计事件。
       * ⚠️ 只审计**保管范围内的扩展名**：给 `audit()` 喂一个从没打算保管的文件，
       *   它只会老实回报 `unverified/never_kept` —— 那条读数没有信息量，却会稀释真红。
       */
      try {
        const audited = (Array.isArray(state.run.artifacts) ? state.run.artifacts : [])
          .map(String)
          .filter((p) => CUSTODY_PROTECTED_EXT.includes(path.extname(p).toLowerCase()));
        if (audited.length) {
          const au = artifactCustody.audit(audited);
          state.custodyAudit = au;
          try {
            taskTrace.record(String(o.taskId || ''), 'custody', {
              phase: 'audit',
              ok: !!(au && au.ok),
              counts: (au && au.counts) || null,
              items: (au && au.items) || [],
              tampered: (au && au.tampered) || [],
              missing: (au && au.missing) || [],
              unverified: (au && au.unverified) || [],
              /* ★ 2026-02-16：原来只挑了 `corruptNow`（"本次坏了"），漏了 `corrupt`
               *   （"此刻可不可信"）。两者语义不同：`corruptNow = ix.origin === 'file_bad'`
               *   只说明这一次 `_index.json` 解析失败；`corrupt = ix.ok === false` 是
               *   **本次坏 或 历史坏过没确认**（`artifactCustody.js:2227-2229`）—— 那才是
               *   "这份元数据此刻可不可信"。缺它 ⇒ 下游只能看到"本次没事"，
               *   把不可信读数当可信。
               *   实测（`artifactCustody.js:345-353` 的 both-corrupt 探针场景）：索引与
               *   事件**同时**损坏时 `recoverIndex()` 把 `index-corrupt` 追加进那半行垃圾里，
               *   续读 `corruptEvents === 0` ⇒ `corruptNow:false` 而 `corrupt:true`，
               *   此刻 `tampered` 从 1 掉到 0 ⇒ 少报的恰恰是"真实发生过变造"的那一条。
               *   `suspect` 与 `corrupt` 当前同源（`indexSuspect()` = `ix.ok === false`），
               *   照抄是为了"下游按哪个名字读都对"，不是因为这里多了一个新语义。
               *   ⚠️ 这条是 `scripts/report/delivery-scorecard.mjs` 头 B7 点名的那处上游
               *     缺口（「修法在上游：把 corrupt 也写进那条 custody 记录」）—— 此处即修法。 */
              index: (au && au.index) ? {
                corrupt: au.index.corrupt === true,
                corruptNow: au.index.corruptNow,
                suspect: au.index.suspect === true,
                orphanCount: au.index.orphanCount,
                storeObjects: au.index.storeObjects,
                historyLines: au.index.historyLines,
                historyBadLines: au.index.historyBadLines,
              } : null,
            });
          } catch { /* 旁路：记录失败不影响结论 */ }
        }
      } catch (e) {
        state.errors.push({ stage: 'custody.audit', error: String((e && e.message) || e) });
      }

      /**
       * ★ 目标契约收尾对照（2026-02-16，路线文档第一期第 2 项）：
       *   「`diffContract` 必须区分「偏差」与「经批准的变更」。」
       *
       * 修之前收尾只有一条笼统的"验收没过"，从不逐字段对照"交付物 vs 用户当初要的"，于是：
       *   A 种：用户中途改了口（"只要 3 页"）也照样报偏差 ⇒ 真偏差被淹没在人自己改的需求里；
       *   B 种：谁写一句"用户已批准"就能把真偏差洗掉 ⇒ 偏差数被清零，而且看起来更绿。
       * ⇒ 判据全部在 `workflowRunner.diffContract`（纯函数、可单独变异），这里**只做接线**：
       *   把 `state.run.spec`（用户当初的规格 + 变更申报）与真实产物读数喂进去，结论摊平后落盘。
       *
       * ⚠️ 位置：必须在 `if (state.concluded) return state.concluded;` **之后**
       *   （那是本函数第一行），否则重复调用会重复 append；此处与上面"产物入账"同理，
       *   一次计算里只执行一次。
       * ⚠️ `planned` 取 `state.run.spec.slideCount`（`createRun` 固化下来的**用户原话规格**），
       *   不用 `detected.spec` 现算的第二份 —— 同一语义养两套实现正是本仓反复踩的坑。
       */
      const contractRunSpec = (state.run && state.run.spec && typeof state.run.spec === 'object'
        && !Array.isArray(state.run.spec)) ? state.run.spec : {};
      const contractSpec = {
        planned: (contractRunSpec.slideCount !== undefined ? contractRunSpec.slideCount
          : (detected.spec ? detected.spec.slideCount : null)),
        // ★ 2026-10-26：原来这里回落成 `'pptx'`——通用路径里的 PPT 默认值。
        //   没有声明交付格式的工作流就该是空串（对照表里如实显示"未声明"），不许替它编一个格式。
        format: (cfg.deliverable && cfg.deliverable.format) || '',
        // 没有 startedAt 时传 null（**不许**退回 0：0 会让任何 at>0 的旧批准都算"本轮"）
        startedAt: (Number.isFinite(Number(state.run && state.run.startedAt)) && Number(state.run.startedAt) > 0)
          ? Number(state.run.startedAt) : null,
        amendments: Array.isArray(contractRunSpec.amendments) ? contractRunSpec.amendments.slice(0, 40) : [],
      };
      const contractActual = {
        artifacts: list,
        counts: pptx.map((p) => ({
          path: p,
          slideCount: Number((inspections[p] || {}).slideCount) || 0,
        })),
      };
      let contractView = null;
      try {
        contractView = workflowRunner.compactContract(
          workflowRunner.diffContract(contractSpec, contractActual, { format: contractSpec.format }));
      } catch (e) {
        // 判据自己崩了**不许**当成"无偏差"：如实记成"未核验"，并让用户看见。
        state.errors.push({ stage: 'diffContract', error: String((e && e.message) || e) });
        contractView = {
          contractCompared: false,
          deviations: [],
          deviationsApproved: [],
          deviationsUnverified: [{ field: 'contract', why: 'diffContract 抛异常 ⇒ 本次契约对照未核验（不许当成无偏差）：' + String((e && e.message) || e) }],
          contractSummary: { deviated: 0, approved: 0, unverified: 1, fields: 0 },
        };
      }
      /**
       * 必须**同时**落盘（照上面"产物入账"那段的写法：合并后 save，失败推 errors，不许静默吞）。
       * 理由：不落盘的结论下一次请求读不到，等于"只有本次会话里有效"——那正是本项要修的病。
       */
      state.run = { ...state.run, ...contractView, lastUpdated: Date.now() };
      try { if (state.store) state.store.save(state.run); } catch (e) {
        state.errors.push({ stage: 'persist:contract', error: String((e && e.message) || e) });
      }
      try {
        taskTrace.record(String(o.taskId || ''), 'workflow', {
          phase: 'contract-diff',
          compared: contractView.contractCompared,
          summary: contractView.contractSummary,
          deviations: contractView.deviations.slice(0, 5),
          approved: contractView.deviationsApproved.slice(0, 5),
        });
      } catch { /* 旁路：记录失败不影响结论 */ }

      /**
       * render：本机无渲染器 ⇒ 能力边界豁免（带理由，进交付报告）。
       * ★ 只有本工作流的阶段表里**有** render 才谈得上推进/豁免 —— 一个没有 render 阶段的工作流
       *   在这里既不该被打勾，也不该被记一条"未知阶段"的错误账（见 hasStage 头注）。
       * ★ 同理：下面的 validate / repair / final_validate / deliver 全部加阶段守卫。
       */
      if (hasStage('render')) {
        if (state.rendererAvailable) {
          // 有渲染器却没渲染 = "没做"，不许豁免（此时 rendered 必须是 true）
          if (state.rendered) step('render', '已完成逐页渲染检查');
        } else {
          waive('render', '本机无 pptx 渲染器（只有 PowerPoint GUI，无稳定 CLI），未做逐页渲染检查');
        }
      }

      // validate：证据 = 真文件读数（pptx 走 zip 真解析；其它类型只到"存在且非空"）
      if (hasStage('validate') && produced.length) {
        step('validate', produced.slice(0, 5).map((p) => {
          const i = inspections[p];
          if (!i) return p + '：存在且非空（' + (workflowRunner.extOf(p) || '无扩展名') + '，本引擎不做格式解析）';
          return p + '：' + (i.openable ? '可打开，' + i.slideCount + ' 页' : '打不开') + '，重复页组 ' + ((i.duplicateGroups || []).length);
        }).join('；'));
      }

      const inspector = (p) => inspections[p] || { openable: false, slideCount: 0, slideFiles: 0, duplicateGroups: [], error: '未解析' };
      const evalCtx = {
        artifacts: list,
        // ★ F7：与 `outline` 证据**同一个值**（冻结账本优先）。改前这里是 `detected.spec.slideCount`
        //   —— 每次请求重新解析 ⇒ 同一任务的验收标准会随"这次用户怎么说话"漂移，
        //   而同一函数里的契约对照早就改成读冻结账本了（见 contractSpec 的注释）。
        planned: plannedSlideSpec,
        rendered: state.rendered,
        rendererAvailable: state.rendererAvailable,
        inspector,
      };

      // 先试算一次，把**真实的**失败项记进 openIssues。
      // ★ 自指的终态一致性检查必须排除：它此刻必然失败（repair/final_validate/deliver 还没走完），
      //   记进去就是每次多一条假问题 —— 这条语义由**契约**用 `terminal: true` 声明
      //   （见 workflowRunner.terminalCheckIds 头注）。修前这里是写死的 id 比较。
      let pre = null;
      try { pre = workflowRunner.evaluate(state.run, cfg, evalCtx); } catch { pre = null; }
      const terminalIds = workflowRunner.terminalCheckIds(cfg);
      const realFails = pre ? (pre.failedChecks || []).filter((f) => terminalIds.indexOf(f.id) < 0) : [];
      for (const f of realFails) {
        try {
          state.run = workflowRunner.recordIssue(state.run, cfg, {
            issue_id: f.id, stage: 'validate', target: cfg.deliverable.format,
            failure: f.why || f.id, evidence: { why: f.why || '' },
          });
        } catch (e) { state.errors.push({ stage: 'recordIssue', error: String((e && e.message) || e) }); }
      }
      const openIssues = (state.run.openIssues || []).filter((x) => x.status !== 'closed');
      // repair：无未解决项 ⇒ 没有可执行动作（豁免）；有未解决项 ⇒ 必须真有修复动作才算做，绝不豁免
      if (hasStage('repair') && !openIssues.length) {
        waive('repair', 'validate 未发现需要修复的问题，本阶段无可执行动作');
      }

      // final_validate：证据 = 这一轮 evaluate 真按契约跑完了全部检查
      if (hasStage('final_validate') && pre) {
        step('final_validate', '完整复验已执行：' + (pre.results || []).length + ' 项检查（本工作流契约 '
          + (cfg.requiredChecks || []).length + ' 项），must 失败 '
          + (pre.failedChecks || []).filter((f) => f.severity === 'must').length + ' 项，证据不足 '
          + (pre.unverifiedChecks || []).length + ' 项，配置错误 ' + (pre.configErrors || []).length + ' 项，'
          + '缺失阶段 ' + (pre.missingStages || []).length + ' 个');
      }
      // deliver：证据 = 本次真的登记了产物（0 件也如实写 0）
      if (hasStage('deliver')) {
        step('deliver', produced.length
          ? '已登记 ' + produced.length + ' 件产物到成果清单（' + (buildExts.join('/') || '未声明产物类型') + ' ' + produced.length + ' 件）'
            + (listFromEvidence
              ? '；⚠ 清单由工作流按归属证据补全（本次模型没交清单；来源=' + (discovery && discovery.source) + '）'
              : '')
          : '本次无任何产物登记（0 件）');
      }

      const cap = (cfg.repairPolicy && cfg.repairPolicy.maxOpenIssuesBeforeStop) || 20;
      let finalEval = null;
      try {
        finalEval = workflowRunner.evaluate(state.run, cfg, {
          ...evalCtx,
          blockedReason: openIssues.length >= cap
            ? '未解决问题达到上限 ' + cap + ' 条（同一问题反复修不好，需要换策略或人工介入）' : '',
        });
      } catch (e) {
        state.errors.push({ stage: 'evaluate', error: String((e && e.message) || e) });
        return null;
      }
      state.run = { ...state.run, status: finalEval.verdict === 'COMPLETE' ? 'completed' : 'stopped' };
      // 终态落盘 + 清租约（observer 只返回结论，一行都不写）
      if (observer) {
        state.errors.push({ stage: 'release', error: 'observer 模式：结论只读，不写状态' });
      } else if (state.store) {
        try { state.store.save(state.run); } catch { /* 落盘失败不影响结论 */ }
        try {
          state.store.release(state.run, {
            status: state.run.status,
            verdict: finalEval.verdict,
            verdictSummary: workflowRunner.summarize(finalEval),
          });
        } catch (e) { state.errors.push({ stage: 'release', error: String((e && e.message) || e) }); }
      }
      // 兜底事实必须能被上层看见：不给出去，"清单是补的"这件事就只活在 trace 里，
      // 交付报告会把它写成"模型交付了 N 件"，那是另一种失实。
      // 目标契约对照结论必须一起交出去（键名固定：deviations / deviationsApproved /
      // deviationsUnverified / contractCompared / contractSummary）——
      // 只落盘不给出去，交付文本里就不会有「契约偏差」小节，用户看到的仍是"验收通过"一句话。
      const concluded = Object.assign({}, finalEval, {
        artifactsFromEvidence: listFromEvidence,
        /**
         * ★ 兜底发现的**全部痕迹**（不是只给一句话）：来源 / 接受了哪些 / 拒了哪些、为什么拒。
         *   为什么必须给出去：不给出去，"清单是补的 / 旧文件被拒了"这件事就只活在 trace 里，
         *   交付报告会把它写成"模型交付了 N 件"，那是另一种失实。
         */
        discovery,
      }, contractView);
      state.concluded = concluded;
      return concluded;
    },
  };
}

// Agent 循环：模型 -> tool_calls -> 本地执行技能 -> 把结果喂回 -> 重复，
// 直到模型产出了不带工具调用的回答，再流式推给前端。
// 增强：阶段化(phase 事件)、素材索要(request_material 挂起)、确认门(file-write/shell-exec 挂起)。
/**
 * ★★★ 2026-10-26【第三阶段】本函数的**返回值**现在携带验收裁决：`{ acceptance }`。
 *
 * 为什么要在外面套这一层薄壳（而不是让主循环每个出口自己 return 它）：
 *   主循环里有 18 个早退出口（用户叫停 / 超时 / 预算 / 上游失败 / 流中断 / 轮次耗尽…），
 *   它们散在三个嵌套层里。逐个改写成 `return { acceptance: … }` 有两个问题：
 *     ① 那是把"同一件事"在 18 个地方各说一遍 —— 下一个新增出口必然会漏；
 *     ② 每个出口都要能读到裁决变量，于是变量必须是**最外层**作用域，改起来的爆炸半径比这层壳大得多。
 *   这里改成"出口往里塞、返回由外壳统一给"：裁决只在一个地方计算（收尾终审那一处），
 *   写进 `retBox`，外壳无条件把它挂在返回值上。**未走到收尾的出口 ⇒ null**，这是事实
 *   （那一轮没有收尾可言，硬编一个 verdict 就是编读数）。
 *
 * 约定（调用方请按此消费）：
 *   `{ acceptance: null }`            —— 本轮没有走到收尾终审（中断/超时/异常/上游失败）。
 *   `{ acceptance: { verdict, … } }` —— 走了收尾；形状与 `workflowRunner.evaluate` 一致
 *                                       （通用任务另有 `standalone:true` / `statePersisted:false`）。
 */
async function runAgentLoop(payload, cfg, skills, res, retBox) {
  retBox = retBox || { acceptance: null };
  await runAgentLoopInner(payload, cfg, skills, res, retBox);
  return { acceptance: retBox.acceptance };
}

async function runAgentLoopInner(payload, cfg, skills, res, retBox) {
  const baseURL = normalizeBaseURL(payload.baseURL || cfg.baseURL);
  const apiKey = payload.apiKey || cfg.apiKey;
  const model = payload.model || cfg.model;
  const requestedTemp = typeof payload.temperature === 'number' ? payload.temperature : null;
  const upstreamURL = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const headers = authHeaders(apiKey);
  // 购物场景走「快速路径」：只给 shop-search / shop-order 等真实技能，不注入 workflow_plan /
  // request_material / clarify_requirements / request_plan_ack 这些通用 Agent 元工具。
  // 这些元工具是为「产出型任务」设计的（复述→计划→选择题确认），购物要的是「快」，套上反而慢，
  // 而且 clarify 选择题建立在识别错的词上，越问越错。歧义改由 prompt 让模型口头问一句解决。
  const isShopping = payload.expert === 'shopping';
  // 关键词正则 DEEP_THINK_HINTS 已提升为模块级（见文件上方「深度思考判定」区），并降级为多信号之一；
  // 「是否深度思考」的最终判定见下方 thinkSignals/decideThink。
  // 防嘴炮专用窄正则：只保留明确「要文件产出」的产物名词（不复用上面的宽正则，避免把纯文本/查询/只读任务误判为需落盘）
  const WANTS_FILE_OUTPUT = /(网页|网站|PPT|ppt|Excel|excel|Word|word|文档|报告|方案|海报|视频|程序|脚本|代码|小程序|图表|表格|简历|周报|日报|作品|成品|页面|站点)/;
  // 只读意图正则：命中「读/看/打开 XX 文档」→ 用户只是要读，不该被逼补写文件，排除
  const READ_ONLY_HINTS = /(读|看|打开|查看|浏览|查阅)((一下|这个|这份|这篇|这页)\s*)*(文档|文件|网页|报告|表|图)/;
  const lastUserText = lastUserTextOf(payload);
  // ===== 任务意图闸门（2026-09-23）=====
  // 先判定用户**这一轮**是要答案 / 查原因 / 要方案，还是要动手；非执行模式下拦下「会改动环境」的技能。
  // 只用本轮消息判定（**不扫历史**）：跨轮继承会把「上周让你部署过」变成今天的永久执行授权。
  //
  // ★ 2026-09-23 加固：判定的**输入**必须取「最后一条真实用户消息」。
  //   原先这里传 lastUserTextOf(payload) —— 它只取 messages 的**最后一条**，既不校验 role，
  //   也不排除我们自己注入的「（系统提示…）」。当前前端发送时最后一条恒为用户消息，所以正常路径
  //   看不出差别；但只要哪条链把 assistant/tool 消息或注入提示留在末尾，闸门就会拿**不是用户说的话**
  //   去判「这一轮要不要动手」—— 闸门第一环就错了，后面拦得再准也没意义。
  //   intentGate.lastRealUserText 正是为此而写（向前找最后一条非空 user、且非系统注入），
  //   却一直**零调用** ⇒ 与「adjudicateDelivery 被 import 却零调用」是同一种"同一语义养两套实现"病。
  //   取不到时退回原口径，正常路径判定结果不变（纯加固，不改变已通过的既有行为）。
  const intentText = lastRealUserText(payload && payload.messages) || lastUserText;
  const intent = classifyIntent(intentText);
  // ⚠️ 必须是 let：下面「短追问沿用授权」要把它从 QUESTION 改判成 EXECUTE（2026-10-21）。
  let intentMode = intent.mode;
  // ★★ 2026-11-11【交付授权标记】：本轮是否已经从「用户答了澄清 / 给了素材 / 短追问沿用」拿到授权。
  //
  // 为什么必须单独一个标记，而不是让授权门去看 userText：
  //   用户答澄清时说的是「口腔诊所」这种短答案，`isDeliveryAuthorized('口腔诊所')` 必然 false
  //   ⇒ 授权门会把它拦下 ⇒ 用户答了还是不干活，正是 gateDirective 头注里记的那场老病。
  //   （实测：改前 `unit-intent-gate-runtime` 的 9c/10c/11c 三条就是这样红的。）
  //
  // ★ 唯一真源纪律：本标记**只**在下面各处 `intentMode = INTENT_MODE.EXECUTE` 的
  //   「因用户答复而升级」分支里置 true —— 那几处已经是被公认的授权点，
  //   这里不再造第二套判据，只把同一个事实记下来给授权门用。
  //   短追问沿用授权（约 :5233）那处**也**置 true：能走到那里说明
  //   ①上一轮真的判过 EXECUTE ②在 30 分钟窗内 ③是 ≤20 字纯追问，三条合起来已是足够强的授权证据。
  let deliveryAuthGranted = false;
  // 短追问（「好了吗」「什么时候好」「继续」）沿用上一轮的执行授权。
  // 原有注释担心的「把上周让你部署过变成今天永久授权」仍然避开：短追问形态 + 30 分钟时间窗，两道闸。
  // ① 形态闸：isShortFollowUp 只认 ≤20 字的纯追问句，长句一律 false（「先别动手」不会被它放过）。
  // ② 时间闸：只认 FOLLOW_UP_GRACE_MS 内**真的判过** EXECUTE 的那一轮。
  // 另：① 否定执行在 classifyIntent 里优先级最高，命中时本轮 mode 本就不是 EXECUTE，
  //    而这里只在「本来就没授权」时才尝试继承 —— 所以「先别动手」这类句子继承不进来。
  // ⚠️ 第二道硬线（2026-10-21 第二版新增，别删）：
  //   `intent.reason !== 'explicit-no-execute'`。
  //   为什么非加不可：判成「不要动手」时 mode 是 QUESTION ⇒ 本来就没授权 ⇒ 会走进这个 if。
  //   原设计指望 `isShortFollowUp` 返回 false 来挡住它，可那只靠**文本形态**兜底；
  //   第二版为了让「什么意思？」「你是不是没做」这类质疑也能继承授权，把形态判据放宽了，
  //   形态兜底就不再可靠 —— 必须在**判据层**（classifyIntent 的 reason）显式排除。
  //   「先别动手」压过一切，这是必须保住的安全底线。
  if (!isExecutionAuthorized(intentMode)
      && intent.reason !== 'explicit-no-execute'
      && isShortFollowUp(intentText)) {
    const ownerKey = ownerKeyOf(payload);
    const grantedAt = lastExecGrantedAt.get(ownerKey) || 0;
    if (grantedAt && Date.now() - grantedAt < FOLLOW_UP_GRACE_MS) {
      intentMode = INTENT_MODE.EXECUTE;
      deliveryAuthGranted = true;   // 交付授权：见声明处注释（短追问沿用上轮授权）
      console.log('[intent] 短追问「' + intentText + '」沿用上一轮执行授权（'
        + Math.round((Date.now() - grantedAt) / 1000) + ' 秒前判过）');
    }
  }
  // 只有**本轮真的拿到授权**才刷新时间戳（继承来的那一轮也刷新，让连续催问不掉线；
  // 但被拦下的只读轮绝不刷新 —— 否则一次拦截会被下一次继承无限续期）。
  if (isExecutionAuthorized(intentMode)) {
    lastExecGrantedAt.set(ownerKeyOf(payload), Date.now());
  }
  if (!isExecutionAuthorized(intentMode)) {
    console.log('[intent] 本轮=「' + (INTENT_MODE_LABEL[intentMode] || intentMode) + '」(' + intent.reason
      + ')，会改动环境的技能将被拦下（只读与元工具放行）');
  }
  let didToolCall = false; // 仅诊断用：确认已进入「干活」状态（不再参与 wantThink —— 见下方「深度思考判定」注释）
  let thinkForcedOff = false; // thinking 契约 400 自愈后置位：本次请求剩余轮次一律关闭思考
let suppressMaxTokens = false; // 显式 max_tokens 被上游拒绝后置位：后续轮次不再带它（自愈开关）
  // 购物场景强制关闭联网搜索：商品在商城里查（shop-search），不需要 DeepSeek 联网，开着反而每轮都拖慢。
  // 也顺带把购物温度压到 0.3，让导购推荐更稳定、少发散。
  const enableSearch = !isShopping && payload.enableSearch === true;
  /**
   * 本轮**真正发给模型**的工具表。两段来源：
   *   ① `payload.tools`（调用方给的技能表）；
   *   ② `META_TOOLS`（通用 Agent 元工具）—— 购物场景不加。
   *
   * 🔴 `payload.noMetaTools`（2026-02-16 新增）：**不许**在它置位时把元工具加回来。
   *   这条是为第二执行实例开的：替补的承诺是"工具集**严格变小**"，而原来这一行
   *   `[...payload.tools, ...META_TOOLS]` 会把刚被裁掉的 4 个元工具**原样加回来**
   *   （独立验收实测：补丁里 3 个工具，模型实际看到 7 个 ⇒ "缩小的工具集"在运行时**不成立**，
   *   而 trace 里 `tools2=3` 还**低报**了真实数）。承诺与读数必须同时为真，所以两处一起修：
   *     · 这里尊重开关（承诺为真）；
   *     · 下面的 `retBox.toolsSeen` 记**运行时实际表**（读数为真，供 trace 用）。
   *   普通对话/主实例不带这个字段 ⇒ 行为一字不变。
   */
  const suppressMetaTools = payload.noMetaTools === true;
  const tools = [
    ...(Array.isArray(payload.tools) ? payload.tools : []),
    ...((isShopping || suppressMetaTools) ? [] : META_TOOLS),
  ];
  // ★ 运行时可核验读数：把**这一份**（模型真正看到的）工具名交给调用方。
  //   为什么不用调用方自己算的 `plan.tools2.length`：那是"打算给几个"，这是"真给了几个" ——
  //   两者一旦分叉（正是上面那个 bug），trace 会替我们说假话。retBox 可能不存在（普通调用）⇒ 有则写。
  try {
    if (retBox && typeof retBox === 'object') {
      retBox.toolsSeen = tools.map((t) => (t && t.function && t.function.name) ? t.function.name
        : (typeof t === 'string' ? t : ''));
      retBox.metaToolsSuppressed = suppressMetaTools;
    }
  } catch { /* 取证旁路，失败不影响主流程 */ }

  // ===== 技能渐进披露（2026-02-16）：每轮工具表 = 全量表 → 「核心档 + 已披露档」=====
  /**
   * ⚠️ 上面那行 `const tools` **必须保持全量表**，一个字都不许改成"每轮表"。它还有两处消费者，
   *   两处都需要全量：
   *     · `pickDelegateTools(tools, Array.from(META_TOOL_NAMES))`（本文件下方交接单预览）；
   *     · `planDelegation({ ..., tools, metaNames: ... })`（第二执行实例的候选池）。
   *   若把 `tools` 收窄，替补既拿不到隐藏技能、`pickDelegateTools` 又会把元工具全部剔掉
   *   （`secondRunner.js` 那句按 metaNames 过滤）⇒ 替补彻底失能。
   *   ⇒ 正确做法：`tools` 不动，**在 turn 循环内另算一份 `turnTools`**，只把 `turnTools` 塞进 `body.tools`。
   *
   * 另外那行 `retBox.toolsSeen = tools.map(...)` 也**不许改**：
   *   `scripts/smoke/unit-second-runner.mjs:726` 是一条**源码正则判据**（grep 这个字面量）。
   *   语义上它仍然正确 —— 但**理由要说准**（订正于阶段 2，原文写"没传 retBox"已经不成立）：
   *   主实例的 `retBox` 是薄壳自建的临时 box（`{ acceptance: null }`，主路径 request 不带 retBox），
   *   所以这段 `if (retBox && ...)` **会执行**，`toolsSeen` 写进那个临时 box —— 但薄壳只读
   *   `retBox.acceptance`，临时 box 随请求结束丢弃，**没有人读它的 `toolsSeen`**；
   *   真正被读的是替换实例的 `retBox2`（phase 事件里的 `tools2Real`），而它拿的就是全量表
   *   （替补不做分层，见 lazyTools.isLazyEnabled）。
   */
  /** 已被 `find_skills` 披露出来的技能 id：每轮累加，本次运行内有效（不落盘、不跨任务）。 */
  const disclosedSkillIds = new Set();
  /**
   * 技能 id 真源（`scanSkills()` 的 manifest 清单）。
   * 为什么不用 `payload.tools` 自己推：全量表里混着元工具，且元工具名与技能名同为 kebab-case，
   * "看起来像技能名"不是判据。真源必须是 manifest 清单 —— 与 `skills.find(...)` 同一份数据。
   */
  const lazySkillIds = new Set(
    (Array.isArray(skills) ? skills : []).map((s) => (s && s.id) || '').filter(Boolean)
  );
  /** manifest 索引：`find_skills` 的中文 `name` 从这里取（后端扫描出来的技能标题，不是模型编的）。 */
  const lazySkillMeta = new Map(
    (Array.isArray(skills) ? skills : []).map((s) => [String((s && s.id) || ''), s])
  );
  // 开关判定只走 lazyTools.isLazyEnabled 一处（`lazyTools === true` 且未被 noMetaTools 裁掉元工具）。
  const lazyOn = lazyTools.isLazyEnabled(payload);
  if (lazyOn) {
    console.log('[lazy] 渐进披露已开启：全量 ' + tools.length + ' 个工具，核心档 '
      + lazyTools.CORE_SKILL_IDS.length + ' 个 + 元工具，其余由 find_skills 按需披露');
  }

  // ===== 第一层内核：任务注册表（叫停）+ 无人值守开关 =====
  // 产出型任务落地清单：收集 file-write + 各产出技能生成的文件绝对路径，收尾时一并发给前端"成果卡"。
  // ⚠️ 必须声明在任务注册表之前：persistTask 会读它（若中途异常、finally 里 persistTask 也不会撞 TDZ）。
  const deliverables = [];
  /**
   * ★★ 2026-02-16【任务级成本归属】第二执行实例烧掉的 token 合计。
   *
   * 为什么需要它（独立验收实测）：本轮把内部子运行的 tasks.json 记录挡掉了（P1-1）⇒
   * 单任务成本视图只剩外层那 `81 / 39`，而 `token-usage.json` 的 `total=368` 里
   * **有替补的份额但拆不出来**。钱没漏（内层每轮都走 `addUsage`，username 由 payload2 继承），
   * 但"这个任务到底花了多少"从此算不出来 —— 修一个污染，顺手开了个黑洞。
   * ⇒ 在外层任务记录里补 `delegateTokens`（**只在这一处记**，不去 usage 里再打一份标：
   *   两处都记必然有一天对不上，那时没人知道该信哪个）。
   *
   * 为什么是对象而不是 `let` 数字：它要在 `persistTask`（定义在前面）的闭包里被读，
   * 而累加发生在后面的 delegate 块 ⇒ 用可变容器避免 TDZ，也避免"每轮重新声明"。
   *
   * ★★ 口径（复验方点名"轮数 ≠ 模型调用次数"之后补齐，读这个字段的人必须先看这段）：
   *   `tokens` = 内层 `taskEntry.usedTokens` 的原值 ⇒ **与 `usedTokens` 同一口径**
   *   （`computeTurnCost().work`：增量法，只计"本轮新增的 prompt + completion"），
   *   两者相加才有意义（本任务总花费 = usedTokens + delegateTokens）。
   *   🔴 **不许**用 `turns2 × 每轮估算` 顶替：实测同一个 turn 里可能发生 **2 次**模型调用
   *   （`backend.js` 里 thinking 契约 400 的一次自愈重试就是"多发一次请求"；循环内压缩摘要
   *   那次调用根本不算一轮），复验方量到过 `turns2=5` 而内层真实 **7 次**调用 ⇒
   *   按轮推算低报约 29%（770 记成 550）。
   *   所以本值只允许来自**逐次 usage 累加**（`taskEntry.usedTokens` 的累加点与 `addUsage`
   *   在同一个"每个上游响应"代码块里，见 `computeTurnCost` 调用处），不允许任何轮数推算。
   *   另外：`billableTokens`（= Σ(pt+ct)，上游真实收数）是**另一个口径**，它不并进本字段，
   *   而是单独回传给 trace（`tokens2Billable`）—— 审计时"上游真相"与"闸门口径"各留一份，
   *   谁也不许把谁覆盖掉。
   */
  const delegateUsage = { tokens: 0 };
  // 任务 ID：优先用前端传来的（停止按钮据此叫停）；缺省则本地生成（保持可观测）。
  const taskId = String(payload.taskId || genId('task'));
  // 运行底座 P0：前端 /api/chat 带上来的稳定会话关联键。没有就留空串（诚实，不编造），
  // 由 taskTrace.begin 落到第一条事件上；taskId 是**任务** id，两者不许互相冒充。
  const sessionId = String(payload.sessionId || '');
  // ★★ 2026-11-06【意图取值点 · 修前这里就是断点】
  //   修前：`const taskGoal = clip(lastUserText, 300)` —— 一句话三个缺陷，且都往同一个方向偏：
  //     ① 取 **最后一条消息**（用户第 3 轮的"顺便改个颜色"顶替了最初那句完整需求）；
  //     ② 截断 **300 字**（长需求后段的硬约束被静默切掉，验收员看不到就不会判它缺失）；
  //     ③ **不落盘**（重启/复盘时无从知道当时判卷人看的到底是哪份目标）。
  //   而执行侧读的是 `project.origin.text`（最初原话、完整、落盘）—— 两侧看的不是同一份卷子。
  //   现在：先给一个"没有项目账时"的默认值（用 intentText，比 lastUserText 更准：
  //   它排除了我们自己注入的系统提示），等下面项目账解析完（`project` 在 5204 才赋值）
  //   由 `resolveTaskGoal` 一次性换源，并在 trace 里留下"取的哪一份、多长、是否截断"。
  //   ⚠️ 必须是 `let`：修前是 `const`，这正是"换源"这件事当时根本写不进去的物理原因。
  let taskGoal = clip(intentText, TASK_GOAL_MAX_CHARS);
  /** 意图来源的自述（供 trace 与验收诊断读，不许拿来当判据）。换源后由 resolveTaskGoal 覆盖。 */
  let taskGoalMeta = {
    source: 'turn', originChars: 0, turnChars: String(intentText || '').length,
    totalChars: String(intentText || '').length, truncated: false, projectId: '',
  };
  // lifeCtrl = 任务生命周期控制器（全程**不置 null**，供「停止」打断正在执行的技能）。
  // ⚠️ 为什么不能复用 ctrl：ctrl 是**每轮上游请求**用的 AbortController，fetch 一结束就被置 null；
  //   而技能是在模型返回**之后**才执行的 —— 那时 ctrl 已经是死的，用户点「停止」会打空、中断不了技能。
  //   故单列 lifeCtrl：abortTask / 关窗 时同时 abort 它，才能真正打断 runSkill。
  const taskEntry = {
    aborted: false, abortReason: null, ctrl: null, lifeCtrl: new AbortController(), done: false,
    startedAt: Date.now(), turn: 0, lastSkill: '', owner: payload.username || '',
    stepNo: 0, plan: [], doneLog: [], current: null, lastError: '',
    skippedGates: [], usedTokens: 0,   // 无人值守跳过闸门的可见记账 / 本次任务累计 token
    // 「真的动过手」计数（2026-09-17）：写过文件 / 跑过命令 / 连过服务器 / 查过库的次数。
    // 收尾据此强制补一次结论汇报 —— 见「收尾必给结论」。
    wroteCount: 0,
    // ★ 2026-09-24 取证字段（落盘见 persistTask / trimTaskRecord）：
    toolCalls: 0,        // 累计工具调用次数
    turnTrace: [],       // 逐轮轨迹：{t,tools,ok,fail,arts}
    wrappedUp: false,    // 本次任务是否进过收尾模式（轮数轴或预算轴）
    wrappedUpReason: '', // 是哪条轴触发的：'stuck'（结果不动）/ 'turns' / 'budget' / 'both'
    maxTurns: 0,         // 当次实际生效的轮数上限
    // 2026-10-18 第十六轮：双 AI 自检的续跑轮数（自查没做完 → 回灌续跑，有上限防无限循环）
    reviewRounds: 0,
    // 客观运行验收失败后的独立回灌预算（与 AI 自查轮次分开，最多 2 次）。
    runtimeFeedbackRounds: 0,
  };
  let runtimeRequired = expectsRuntime(intentText || lastUserText);
  const runtimeEvidence = createRuntimeEvidence({ taskId, userText: intentText || lastUserText });
  let acceptanceForLedger = null;
  let projectStore = null;
  let projectDecision = { status: 'unavailable' };
  let project = null;
  /**
   * 本次运行是不是**内部子运行**（第二执行实例 / delegate）。
   * 它由主执行者递归调起（见下方「第二执行实例」那段），有自己的 taskId 与 taskEntry，
   * 但**没有用户**：它的 res 是假 sink，前端收不到它的任何事件。
   *
   * 为什么这个标记会影响项目账（下面那个 if）：项目账记的是"这个用户在这个项目上说过什么、
   * 交付了什么"。替补这一轮的"用户反馈文本"其实是一段**内部交接单** —— 把它写进项目账，
   * 就是往用户的项目历史里塞一条他没说过的话。所以内部子运行**不认领项目账**：
   * 账由主执行者那一次运行统一落（它的 origin 才是用户真正说的那句）。
   */
  // ★ 归一化后再判（**不得**自己写 `Number(payload.delegateDepth) >= 1`）：payload 来自
  //   `/api/chat` 的 body，外部可控；`delegateDepth:-1` 会让这里判成 false，
  //   于是替补被当成主任务（认领项目账 / 进续跑清单 / 写 tasks.json）。
  //   归一化只有一处实现：secondRunner.normalizeDelegateDepth（取整 + 下界 0）。
  const isInternalRun = normalizeDelegateDepth(payload.delegateDepth) >= 1;
  try {
    const ledgerPath = tasksPath
      ? path.join(path.dirname(tasksPath), 'projects.json')
      : path.join(AGENT_WORKSPACE, 'projects.json');
    projectStore = createProjectLedger({ filePath: ledgerPath });
    const productiveTask = runtimeRequired || !!payload.projectId
      || (WANTS_FILE_OUTPUT.test(intentText) && !READ_ONLY_HINTS.test(intentText));
    projectDecision = isInternalRun ? { status: 'internal-run' } : projectStore.begin({
      owner: ownerKeyOf(payload),
      threadId: String(payload.threadId || ''),
      projectId: String(payload.projectId || ''),
      create: productiveTask,
      originText: intentText || lastUserText,
      attachmentPaths: (Array.isArray(payload.attachments) ? payload.attachments : [])
        .map((a) => a && (a.path || a.filePath)).filter(Boolean),
      taskId,
    });
    if (projectDecision.project) project = projectDecision.project;
    // 同项目的“继续 / 再改一下”可以省略产物类型；运行要求与导出证据要求都继承最初需求。
    if (project && project.origin) {
      runtimeEvidence.setUserText(String(project.origin.text || '') + '\n' + String(intentText || lastUserText || ''));
    }
    if (project && !runtimeRequired) runtimeRequired = expectsRuntime(project.origin && project.origin.text);
    if (project && project.validation && project.validation.runtime) {
      runtimeEvidence.importRecords(project.validation.runtime.records);
      // 持久账里的 hash 是上次验收时的字节身份；盘外改动会使对应历史证据失效。
      const current = artifactsOf(project.currentArtifacts);
      const changed = (project.currentArtifacts || []).filter((old) => {
        const hit = current.find((a) => a.path === old.path);
        return !hit || hit.sha1 !== old.sha1 || hit.size !== old.size;
      }).map((a) => a.path);
      if (changed.length) runtimeEvidence.invalidate({ paths: changed });
    }
  } catch (e) {
    // 项目账是增益，损坏或不可写都不能让主任务崩溃；无账时绝不猜最近项目。
    projectDecision = { status: 'error', reason: String((e && e.message) || e) };
    project = null;
  }
  // ══【意图换源 · 唯一取值点】══════════════════════════════════════════════════
  // 位置是刻意的：放在项目账 try/catch **之后**，不是之前。
  //   · 之前在 try 里 ⇒ 项目账一旦抛错（账本损坏/不可写），换源这一步连试都没试，
  //     taskGoal 停在一个"看起来有值、其实是临时默认"的状态上 —— 验收照样跑，
  //     只是它拿到的那份目标没人知道是哪来的。这就是"静默降级"。
  //   · 之后 ⇒ 无论项目账成没成，都**必须**产出一份明确的意图 + 它的来源自述。
  //     项目账挂了不影响任务（既有纪律），但"意图是哪一份"这件事不许含糊。
  // 纯字符串运算，不会抛；不包 try 是为了让任何意外都暴露成真错，而不是被吞成"没换源"。
  {
    const g = resolveTaskGoal({ project, intentText });
    taskGoal = g.goal;
    taskGoalMeta = {
      source: g.source, originChars: g.originChars, turnChars: g.turnChars,
      totalChars: g.totalChars, truncated: g.truncated, projectId: g.projectId,
    };
    // 截断这件事要能被事后看见。`resolveTaskGoal` 已在文本里留了标记，但那是在
    // 给模型看的提示词里 —— 复盘的人看的是 trace，所以这里再单独记一条。
    if (g.truncated) {
      taskGoalMeta.truncatedAt = TASK_GOAL_MAX_CHARS;
    }
  }
  // 【执行记录 · 任务开始】记下这次任务的原始目标、模型、给了哪些工具。
  // 为什么要在意「给了哪些工具」：上一轮真模型 e2e 踩过一个坑 —— 探针传了 tools:[]，
  //   backend 只补 META_TOOLS（全是"停下来问"的工具，一个能干活的都没有），于是模型
  //   27 轮 0 工具结果。那种现场如果没有这一条记录，事后只会看到"模型不干活"，查不到真因。
  try {
    taskTrace.begin(taskId, {
      // P0 关联键：begin() 内部会 bindSession，之后该任务所有事件都带同一个 sessionId。
      sessionId,
      goal: taskGoal,
      owner: payload.username || '',
      model,
      tools: (Array.isArray(tools) ? tools : []).map((t) => (t && t.function && t.function.name) || ''),
      skillCount: Array.isArray(skills) ? skills.length : 0,
      // ⚠️ 这里**故意不记 maxTurns**：MAX_TURNS 在第 3552 行才定义（本处是 TDZ 区），
      //   在这里读它只会被判成 0 或直接抛。实际生效的轮数上限与预算，在下面定义之后
      //   由 'task_config' 事件补记 —— 记一次"真的生效的值"，比记一个拿不到的常量有用。
    });
  } catch { /* 旁路：记录失败绝不影响任务 */ }
  // 【意图来源取证 · 独立事件】为什么要单列一条，而不是塞进上面的 `task_begin`：
  //   `taskTrace.begin` 里对 goal 有它自己的 `clip(…, 300)`（那份是取证用的，够看），
  //   也就是说 **trace 里的 goal 永远是截断版**。如果只记 goal，事后复盘的人会以为
  //   "当时验收看到的就是这 300 字" —— 恰恰相反，验收看到的是完整版。
  //   所以这里记的是**元信息**（取的哪一份、各自多长、有没有截断），与文本分开，互不冒充。
  try {
    taskTrace.record(taskId, 'task_goal_source', {
      source: taskGoalMeta.source,
      originChars: taskGoalMeta.originChars,
      turnChars: taskGoalMeta.turnChars,
      totalChars: taskGoalMeta.totalChars,
      truncated: taskGoalMeta.truncated === true,
      truncatedAt: taskGoalMeta.truncatedAt || 0,
      candidateProjectId: taskGoalMeta.projectId,
      acceptedProjectId: project ? String(project.projectId || '') : '',
      projectDecision: projectDecision ? String(projectDecision.status || '') : '',
    });
  } catch { /* 旁路：取证写失败不改任务行为 */ }
  // 执行单元记账器：本任务内所有 loop-unit-begin/end 都经它落进 trace（同一个 taskId 的流）。
  // 注入 `taskTrace` 而不是让它自己 require：这样「begin 写失败但 end 还在」那条负控（LU13）
  // 可以用一个桩造出来，端上来的事件仍然是真落盘的。
  // ⚠️ 这 4 行必须待在下面 `taskTrace.begin` 的 catch **之后**，不是位置洁癖，是残留可诊断性的差别：
  //   构造抛错时（loopUnitKinds 坏了 / trace 记录器畸形），begin **之前**抛 ⇒ trace 里连
  //   `task_begin` 都没有，事后只能看到「这个任务什么都没发生」，与「根本没跑过」不可区分；
  //   begin **之后**抛 ⇒ trace 里有一条 `task_begin`、零条 `loop-unit-*`，一眼能读出
  //   「任务开始过，但一个执行单元都没记上」—— 后者是可诊断的缺失，前者不是。
  const __luTracker = loopUnitKinds.createUnitTracker(taskTrace, taskId);
  // ── 执行单元 ① loop-init（形态 **P · 不可包裹**）────────────────────────────
  // 为什么不包 try/finally：这一段（到下面主 try 之前）里声明了 95 个**被后面的块引用**的
  //   const/箭头函数（闸门上报器、markStep、deliverablesForUser 之类）。const/let 是块级
  //   作用域 ⇒ 整段包进 try，那些名字在块外全部 ReferenceError。语法层面的必然，不是概率。
  // 真实结束点 = 初始化走完的那一刻；放进全局 finally 会让它的 `ms` 等于整个任务时长，
  //   与 loop-finally 的窗口完全重叠 —— 两个单元测同一段时间，那是噪声不是记账。
  // 代价如实记：初始化段抛异常时（那时连主 try 都还没进）begin 会没有配对 end。
  //   这个孤儿 begin 本身就是信号（"初始化开始了但没走完"），门禁 LU18 把它钉成合法形态之一。
  const _luInitT0 = Date.now();
  const __luInit = __luTracker.begin('loop-init');
  // ══【任务类型工作流 · 调用点①：任务开始】══════════════════════════════════════
  // 老板第六节：「让它识别任务类型，加载该类型的工作流」。判定输入是**用户原话**（intentText
  // 已是「最后一条真实用户消息」），不是模型自报的任务类型 —— 否则模型说自己是 PPT 任务就能套上
  // 一套松标准，说不是就免检。
  // 非 PPT 任务这里返回 null，下面三处调用点全是 no-op：行为与修前逐字一致。
  // ★★ 2026-10-25【工作流契约切口 · 第 3 处】这里必须把两件事分开：
  //   `wfSel` = 注册表**选择结果**（选中的是哪套工作流、它声明了哪些判据）——**任何 lifecycle 都有**；
  //   `wfCtl` = **生命周期控制器**（只有 lifecycle:'full' 才有）。
  //   以前两者合成了一个变量（`wfCtl === null` 被当成"不是 PPT 任务"在用），于是一个
  //   lifecycle:'none' 的工作流即使声明了判据也取不到、还会被套上 PPT 那套。
  let wfSel = null;
  let wfCtl = null;
  try {
    wfSel = workflows.selectWorkflow(intentText || lastUserText, { attachments: payload.attachments, taskId });
  } catch { wfSel = null; }   // 选择失败 = 没有工作流（与 startWorkflowRun 内部同一纪律：不抛）
  try {
    wfCtl = startWorkflowRun({
      text: intentText || lastUserText, attachments: payload.attachments, taskId, selection: wfSel,
    });
    if (wfCtl) {
      const snap = wfCtl.snapshot();
      console.log('[workflow] ' + snap.workflowId + ' v' + snap.version + ' 生效：'
        + '已完成 ' + snap.completedStages.join('>') + '，下一步 ' + snap.nextAction);
      try { taskTrace.record(taskId, 'workflow', { phase: 'start', ...snap, spec: wfCtl.detected.spec }); } catch { /* 旁路 */ }
      // 恢复留痕：这次是「接着上次的账走」还是「租约冲突只能旁观」，磁盘上要能查
      const st = wfCtl.stateInfo();
      if (st && (st.mode === 'observer' || st.resumeStage)) {
        try {
          taskTrace.record(taskId, 'workflow', {
            phase: st.mode === 'observer' ? 'lease-conflict' : 'recover',
            mode: st.mode, resumeStage: st.resumeStage, notes: st.notes, plan: st.plan,
          });
        } catch { /* 旁路 */ }
      }
    }
  } catch (e) {
    // 工作流是增益，不是单点故障源：起不来就当没这套工作流，绝不阻断任务。
    console.error('[workflow] 启动失败（按无工作流继续）：', e && e.message);
    wfCtl = null;
  }
  /**
   * 把一次终审结论写进 trace（幂等由调用方保证：conclude 只算一次）。
   * 为什么非要落 trace 而不是只发前端：老板要求"报告的完成状态是不是事实"可被事后审计，
   * 而 tasks.json 有字段白名单（trimTaskRecord 18 项），塞不进 workflowId/stage/openIssues。
   * trace 是逐任务 JSONL，天然能承载结构化运行记录，也是"跨任务对比同一标准"的数据来源。
   */
  const traceWorkflowEnd = (ev) => {
    if (!wfCtl || !ev) return;
    try {
      taskTrace.record(taskId, 'workflow', {
        phase: 'end',
        ...wfCtl.snapshot(),
        verdict: ev.verdict,
        missingStages: ev.missingStages,
        failedChecks: (ev.failedChecks || []).map((f) => ({ id: f.id, severity: f.severity, why: f.why })),
        waivedStages: ev.waivedStages,
        results: (ev.results || []).map((r) => ({ id: r.id, pass: r.pass, severity: r.severity })),
        plan: wfCtl.detected.spec,
        summary: workflowRunner.summarize(ev),
        errors: wfCtl.state.errors,
      });
    } catch { /* 旁路：记录失败不影响任务 */ }
  };
  /**
   * ★ 2026-10-26【第三阶段】通用任务裁决的 trace 落点（kind = `acceptance/end`）。
   *
   * 为什么**不复用** `workflow` kind：`traceWorkflowEnd()` 的第一行是 `if (!wfCtl …) return`，
   *  它整套形状（snapshot / missingStages / waivedStages / errors）都来自**控制器**。
   *  通用任务没有控制器，硬塞进去只能造一堆恒为空的字段，还会让"这两条记录是同一件事"变成假话。
   *  新 kind 让审计能一眼回答：「这次按哪套标准判的、判成什么、哪几项没过、为什么、归属证据是什么」。
   * 字段是老板逐条点名的那几个（workflowId / verdict / results / skipped / failedChecks /
   *  unverifiedChecks / configErrors / attribution），另加本次裁决的**输入事实**，便于事后复核。
   * `statePersisted:false` 是事实陈述：通用任务没有 run 文件，这份裁决只服务本轮收尾。
   */
  const traceAcceptanceEnd = (ev, facts) => {
    if (!ev) return;
    const f = facts || {};
    const att = (f.attribution && typeof f.attribution === 'object') ? f.attribution : null;
    try {
      taskTrace.record(taskId, 'acceptance/end', {
        workflowId: String((wfSel && wfSel.entry && wfSel.entry.workflowId) || ''),
        verdict: ev.verdict,
        verdictReason: String(ev.verdictReason || ''),
        results: (ev.results || []).map((r) => ({
          id: r.id, outcome: r.outcome, pass: r.pass, severity: r.severity,
          why: String(r.why || '').slice(0, 200),
        })),
        skipped: (ev.skippedChecks || []).map((x) => ({ id: x.id, why: x.why })),
        failedChecks: (ev.failedChecks || []).map((x) => ({ id: x.id, severity: x.severity, why: x.why })),
        unverifiedChecks: (ev.unverifiedChecks || []).map((x) => ({ id: x.id, severity: x.severity, why: x.why })),
        configErrors: (ev.configErrors || []).map((x) => ({ id: x.id, why: x.why })),
        attribution: att ? {
          source: String(att.source || ''),
          accepted: (att.accepted || []).map((x) => ({ path: x.path, source: x.source })),
          rejected: (att.rejected || []).slice(0, 20),
          why: String(att.why || ''),
          startedAt: Number(att.startedAt) || 0,
        } : null,
        facts: {
          artifacts: (f.artifacts || []).length,
          claimedArtifacts: (f.claimedArtifacts || []).length,
          declaredFormat: String(f.declaredFormat || ''),
          expectsArtifact: f.expectsArtifact === true,
          expectsRuntime: f.expectsRuntime === true,
          runtime: f.runtime && f.runtime.evaluation ? {
            status: f.runtime.evaluation.status,
            why: String(f.runtime.evaluation.why || ''),
            gaps: f.runtime.evaluation.gaps || [],
          } : null,
          toolFailures: f.toolFailures || null,
          evidence: f.evidence || null,
        },
        summary: workflowRunner.summarize(ev),
        standalone: true,
        statePersisted: false,
      });
    } catch { /* 旁路：记录失败不影响任务 */ }
  };

  /**
   * ★★★ 2026-10-26【第三阶段】通用任务收尾裁决的唯一落点（`lifecycle:'none'`）。
   *
   * 【为什么是这一处】候选只有三个：① 收尾终审（下面 `if (wfCtl) { … }` 那段）；
   *   ② `finalizeTask()`（finally 里的归一出口）；③ 主循环里新增一处。
   *   · ③ 直接排除：那是第三套判定入口。
   *   · ② 会被所有出口经过，但它在 finally 里、**在 `sendPhase('done', terminalLabel(...))`
   *     之后**——裁决若在那里压终态，界面上的终态词与 tasks.json 就会不一致
   *     （本仓明令禁止的那类自相矛盾）；而且它早于 `finalReport` 也做不到"缺口要点进报告"。
   *   · ① 与控制器路径**同一个位置**：终态已算完、`reviewVerdict` 已压过、还没下发 done 标签。
   *     结论能同时进 trace、进终态、进报告，三处同向。
   *   ⇒ 所以就用 ①，并且用 `else if` 与控制器路径**结构性互斥**：
   *     `wfCtl !== null`（PPT 等 full 工作流）时这一支永不执行 ⇒ 不会出现两份裁决。
   *
   * 【为什么通用任务没有持久化】它没有控制器、没有 run 文件（`startWorkflowRun` 对它返回 null），
   *   所以本次结论**只用于本轮收尾**（`evaluateStandalone` 的返回里 `statePersisted:false` 就是
   *   这句话的机器可读形态）。报告与 trace 里都按"无 run 状态可落盘"如实写，不假装存过。
   */
  const runStandaloneAcceptance = (ctx) => {
    if (wfCtl) return null;                                     // full 工作流：走控制器，绝不双判
    const entry = (wfSel && wfSel.entry) ? wfSel.entry : null;
    if (!entry) return null;                                    // 选择失败 ⇒ 没有契约可依（不猜一份）
    const checks = Array.isArray(entry.requiredChecks) ? entry.requiredChecks : [];
    if (!checks.length) return null;                            // 没有可执行验收项 ⇒ 不产出裁决（空契约不是合格机器）
    let ev = null;
    try { ev = workflowRunner.evaluateStandalone(entry, ctx); } catch (e) {
      // 判据自己崩了**不许**当成"通过"：如实记成"未核验"。裁决缺失本身就是缺口。
      try {
        taskTrace.record(taskId, 'acceptance/end', {
          workflowId: String(entry.workflowId || ''),
          verdict: 'UNVERIFIED',
          error: String((e && e.message) || e),
          why: 'evaluateStandalone 抛异常 ⇒ 本次验收未核验（不许当成通过）',
          statePersisted: false,
        });
      } catch { /* 旁路 */ }
      return null;
    }
    return ev;
  };

  // 本轮增量的暂存桶（每轮开头清零、把**上一轮**固化进 turnTrace）。
  // 为什么不在"上一轮结尾"固化：工具执行路径有多个 continue / throw 出口，写结尾必然漏记。
  // ══【进度账本 · 四维度】════════════════════════════════════════════════════════
  // 老板第 1 条原话（2026-10-23）：
  //   「执行一次 shell 命令只能证明"发生了操作"，不能单独证明"取得了进展"。」
  //   「我不建议简单地把『交付物生成后，任何 shell-exec 或 ssh-exec 都算进度』作为最终修复。
  //     否则，Agent 可以不断写新脚本、重复运行相同检查，即使验收结果完全没有变化，
  //     也可能永远不触发 stuck。」
  // ⇒ 进度不是一个布尔，是四个**各自可核验**的维度，任一有真实增量才算本轮有进展：
  //   ① 产物进度  arts>before（新交付物）或 artUpd>0（**已有产物内容真的变了**）
  //   ② 验收进度  newEv>0（一条**新的**检查跑出**有效结果**；命令+入参+结果三者全同=重复，不重复计）
  //   ③ 问题解决  issClosed>0（某检查项先前失败、现在通过 ⇒ 未解决问题减少）
  //   ④ 工程进度  codeNew>0 / codeUpd>0（非过程脚本的文件**新增 / 内容真变**）
  // 这条设计直接堵掉"反复写新脚本+重复跑同样检查"这个新漏洞 —— 那种情况下四维度全是 0。
  //
  // ★ 为什么必须有第 ④ 维（2026-11-11 补，实测根因）：
  //   前面三维**全部由「交付物」派生**（arts / artUpd / newEv 都要先过 isRealArtifact，
  //   issClosed 也要 deliverable 语境）。也就是说：**"显示轴"同时兼任了"进度轴"**。
  //   两者口径根本不同 —— 显示轴回答「用户拿到手上能用的是哪一个」（要窄，宁漏勿滥），
  //   进度轴回答「agent 这轮有没有真的往前挪」（要宽，别把真干活当没干）。
  //   用一个窄口径去兼一个宽判断，症状就是**代码工程型任务被判原地打转**：
  //   实测 task_mwa5k33u_rkysqp（Godot 涂鸦跳跃）9 次 file-write 里，
  //   `icon.svg` 是唯一命中 ARTIFACT_EXT_RE 的（.godot/.tscn/.gd 既不在产物类也不在脚本类，
  //   落到 isRealArtifact 最后的 `return false`）⇒ arts 从第 1 轮起恒等于 1、artUpd 23 轮恒等于 0
  //   ⇒ 第 5 轮判 stuck ⇒ 注入收尾训话 ⇒ 终态 incomplete，而当时账本里还挂着 3 条未闭环失败。
  //   **模型不是自己放弃的，是闸门把它按下去的。**
  //   所以第 ④ 维独立取数：不看 isRealArtifact，只问「这个文件是不是过程脚本」+「内容真的变了没」。
  const evSeen = new Set();      // 已见过的验收证据指纹（检查项 + 结果指纹）
  const artHash = new Map();     // 产物路径 -> 内容指纹（区分"有效更新"与"又写了一遍同样的东西"）
  // 第 ④ 维的指纹表：键同样是路径，但**入表口径比 artHash 宽**（不过 isRealArtifact，只过
  //   isProcessScript）。两张表必须分开：若共用一张，显示轴的过滤会顺着 map 漏进进度轴
  //   （这正是本次缺陷的形态）。共用还有一个更隐蔽的后果 —— 路径在 A 表被记住、在 B 表没记住时，
  //   "首次落地"与"有效更新"的判定会随另一轴的调用顺序漂移。
  const codeHash = new Map();
  const issueOpen = new Set();   // 未解决问题：键=检查项（工具+命令+入参）。失败则开、同一项转成功则关
  // 第二执行实例（delegate）是否已经起过。与 replanPushed **同一个理由**：每条任务最多一次 ——
  // 反复起替补 = 反复烧预算，而且第一次起过之后"卡住"这件事本身就说明同一个判据再触发也没有新信息。
  let delegatePushed = false;
  let replanPushed = false;      // "只有操作、没有新证据"的重新规划提示是否已下发（每条任务只发一次）
  // 「纯表态停滞」（stall-no-action：连续几轮一次工具都没调）的训话是否已下发。
  // 与 replanPushed 同一个理由：**每条任务只发一次**。每轮都训一遍 = 噪声，
  // 模型只会学会无视它（本仓已实测过：重复的"请换个方法"最后被当成背景音）。
  let stallPushed = false;
  // 同上，拆成两半：用户侧一次 / 模型侧一次。为什么不共用一个开关：
  // 前端可能已断开（sendPhase 打空），但这不代表模型侧那句训话可以不发 ——
  // 收尾能不能说人话取决于模型侧，两边必须各自可判定、各自只发一次。
  let stallPushedModel = false;
  const digestOf = (s) => crypto.createHash('sha1')
    .update(String(s == null ? '' : s), 'utf8').digest('hex').slice(0, 16);
  // ★ 2026-10-23：这里原本有一份 `isInformativeResult`（「非空 + 长度 >24 或不是确认词就算有效结果」）。
  //   **已删除**，判据统一到 `evidenceQuality.gradeVerifyEvidence`（文件顶部 require）。
  //   删它的理由不是"更好看"，而是它被实测证明**判错了轴**：
  //     · `'全部检查通过：3 项'` 12 个字 ⇒ 长度 ≤24 ⇒ 走确认词判定 ⇒ 既不以 ok/success 开头 ⇒ 算"有效证据"；
  //     · 于是每轮换个脚本名跑同一句空话，6 轮全部 fresh=true ⇒ 永不判打转。
  //   判据必须回答「它报告了什么」，而不是「这段文字够不够长」。
  //   ⚠️ 不许把它加回来当"兜底"：两处各写一份判据，必然漂移，而且先说话的那一份信息更少
  //     （同源事故见 `breakerDirective` 兜底分支与 `recoveryStrategyFor` 的历史）。
  let turnSnap = { tools: 0, ok: 0, fail: 0, skipped: 0, vf: 0, newEv: 0, newEvWeak: 0, artUpd: 0, codeNew: 0, codeUpd: 0, issClosed: 0, issOpen: 0 };
  /**
   * ★ 2026-10-26【第三阶段】本任务**累计**的验收动作次数 / 其中给出可核读数的次数。
   *
   * 为什么不能用 `turnTrace` 求和：turnTrace 到收尾那一刻只固化到"上一轮"（最后一轮是在
   * finally 里才补的），而通用验收要判的正是"**本轮**到底有没有真的检查过"。
   * 计数口径与 `evidenceQuality.gradeVerifyEvidence` **完全同源**（就在下面那次调用旁边累加），
   * 不另判一次"这段文字算不算证据" —— 那就是第二套判据。
   * 消费者只有一个：通用验收的 `general_goal_evidence`（见 workflows/general-v1.js）。
   */
  let evCallsTotal = 0;
  let evReadingsTotal = 0;
  // wroteCount 是**累计**值 ⇒ 每轮记增量要自己扣基准
  let wroteBase = 0;
  runningTasks.set(taskId, taskEntry);
  // ===== 第十八轮：断线不杀任务 =====
  // 事件全部先进 taskStream 缓冲，再写给当前连接。渲染层刷新/关窗只会「脱离」这条 SSE，
  // 任务继续跑完；重新连上（POST /api/chat/resume）按 seq 补发，用户不会看到「干到一半没了」。
  // 用户主动叫停仍走 /api/abort（abortTask 精确置 aborted），这条兜底不再兼任「中断」。
  const stream = taskStream.createStream(taskId, {
    goal: taskGoal,
    scope: payload.scope || '',
    owner: payload.username || '',
    // ★ 2026-02-16：第二执行实例（delegate）是**内部子运行** —— 它的 res 是个假 sink，
    //   前端根本连不上它。若不标出来，它会出现在「有任务在后台跑，点这里接回来」的清单里，
    //   用户点进去只能看到一条永远不动的连接。那是另一种"假装"（假装有个能接回来的任务）。
    internal: Number(payload.delegateDepth) >= 1,
  });
  taskStream.bind(stream, res);
  // [ABORT-CHECK] 本次任务是否已被用户取消（每轮开头 / 每个工具执行前 / 每个闸门返回后都会查）。
  // 这是「能叫停」的单一判据：RC 变异把它恒返回 false，中断断言即定点转红。
  const isAborted = () => !!taskEntry.aborted;
  // 前端断开（关窗/刷新/取消 fetch）：
  //   默认 → 只摘连接，任务在后台继续跑，结果留在缓冲里等重连（这是「不中断」的关键改动）。
  //   显式 killOnDisconnect=true（例如桌宠单次调用、脚本）→ 保持旧行为，立即中止省资源。
  res.on('close', () => {
    const wasLive = taskStream.detach(stream, res);
    const t = runningTasks.get(taskId);
    if (!t || t.done) return;
    if (payload.killOnDisconnect === true) {
      t.aborted = true;
      t.abortReason = 'disconnect';
      if (t.ctrl) { try { t.ctrl.abort(); } catch { /* ignore */ } }
      if (t.lifeCtrl) { try { t.lifeCtrl.abort(); } catch { /* ignore */ } }
      return;
    }
    if (wasLive) {
      // 只做标记：任务继续，前端刷新回来能接上（tasks.json 里也能看出这次是脱离运行）。
      t.detached = true;
      t.detachedAt = Date.now();
    }
  });
  // [UNATTENDED-GATE] 无人值守开关：默认 false —— 正常聊天行为一字不变，仅显式传 true 才跳过闸门。
  const unattended = payload.unattended === true;
  // 无人值守「诚实红线」：跳过任何闸门都必须在结果里**可见地记账**，绝不许静默当作「用户已同意」通过。
  // 记账三处：① 回灌给模型的 tool 结果（模型看得到）；② 任务状态 tasks.json 的 skipped_gates；③ 收尾文案。
  // ★ 2026-11-03：按 `gate + skill` **聚合**，不再每拦一次就 push 一条。
  //   为什么必须改：用户在一次普通对话里看到 **7 条一模一样**的「以下需要你在场的步骤已被自动跳过」——
  //   同一个「未获执行授权」被意图闸门拦 7 次 ⇒ 7 条重复记账 ⇒ 7 行重复文案。
  //   去重后同键只累加 count（"被拦过几次"这个信息不丢，只是不再重复占行）。
  // 待批队列：QUEUE 档 / 无人值守下 CONFIRM 档产生的写入动作排在这里，收尾一次性列出。
  // 为什么需要它：人走开时不能卡死，也不能偷偷做 —— 只能"先做可回滚的，把要点头的记账"。
  // 记账必须**可见**：只写在 tasks.json 里等于没记（用户不会去看那个文件）。
  const pendingQueue = createPendingQueue();
  const recordSkip = (gate, skill, target) => {
    const key = gate + '\u0000' + (skill || '');
    const prev = taskEntry.skippedGates.find((r) => r.key === key);
    if (prev) {
      prev.count = (prev.count || 1) + 1;
      prev.lastAt = Date.now();
      if (target) prev.target = target;
      try { send({ type: 'gate_skipped', gate, skill: skill || '', target: target || '', unattended, count: prev.count }); } catch { /* ignore */ }
      try { taskTrace.gate(taskId, { turn: taskEntry.turn, gate, skill, target, count: prev.count }); } catch { /* 旁路 */ }
      return prev;
    }
    const rec = { key, gate, skill: skill || '', target: target || '', count: 1, at: Date.now() };
    taskEntry.skippedGates.push(rec);
    if (taskEntry.skippedGates.length > 30) taskEntry.skippedGates = taskEntry.skippedGates.slice(-30);
    try { send({ type: 'gate_skipped', gate, skill: skill || '', target: target || '', unattended, count: 1 }); } catch { /* ignore */ }
    // 【执行记录 · 闸门拦截】记在 recordSkip 里，一处覆盖所有闸门。
    // ★ 为什么这条特别重要：审计发现「模型想动手、被系统按住」这件事在磁盘上几乎不可见 ——
    //   `gate_skipped` 事件渲染进程零消费；意图闸门发生在 send({__tool__}) 之前，前端连这一步都看不到；
    //   唯一痕迹是收尾那段标题写死「【无人值守提示】」的文案（正常模式也这么印）。
    //   于是最典型的失败形状「用户催、系统按住、模型空转」事后完全查不到。
    try {
      taskTrace.gate(taskId, { turn: taskEntry.turn, gate, skill, target, count: 1 });
    } catch { /* 旁路 */ }
    return rec;
  };
  // 被跳过闸门的**结构化数据**（不再是拼给 assistant 正文的字符串）。
  // ★ 2026-11-03：修前这里是返回一段以「【无人值守提示】」开头的文案（现已删除），
  //   拼进 assistant 正文流（`sendTextAsStream` 只发 delta.content）——两个后果：
  //   ① 标题在撒谎：这段在 `unattended=false` 的普通聊天里也印，而触发它的是意图闸门拦下工具调用，
  //      与「无人值守」开关毫无关系；
  //   ② 位置错：它被拼进正文流 ⇒ 前端拿不到边界，既不能折叠也不能去重，循环里每轮收尾再追加一次，
  //      用户就在一次对话里看到 7 段一模一样的字。
  //   改为数据 + 独立事件（`gate_report`）由前端渲染成一条默认收起的折叠条。
  const skippedGatesPayload = () => {
    const list = taskEntry.skippedGates || [];
    if (!list.length) return null;
    // ★ total 必须是**去重后的条目数**，不是 count 之和。
    //   2026-11-03 实测：同一条 ssh 命令被 confirm 闸门连拦 5 次（用户催、系统按住、模型换参数再试），
    //   list 里只有 1 条记录、count=5 ⇒ 若 total 取 sum 就会显示「有 5 步没执行」，
    //   而实际只有**一件事**没做。用户读到的是假信息（以为有 5 件事没做）。
    //   拦截次数不丢：留在每项的 count 里，展开后才看得到（前端渲染成「confirm：ssh-exec ×5」）。
    return {
      total: list.length,
      blocked: list.reduce((n, g) => n + (g.count || 1), 0),
      items: list.map((g) => ({ gate: g.gate, skill: g.skill || '', target: g.target || '', count: g.count || 1 })),
    };
  };
  // 把「哪些步骤没执行」作为**一条独立事件**发出去（前端渲染成默认收起的折叠条）。
  // 签名去重的理由：这个函数在主循环每轮收尾都会被调用一次（1 + 4 段自查 = 5 次），
  // 内容没变就不该重复发 —— 用户看到的重复条数必须只跟「真的又拦了新东西」有关。
  // 签名里带 target：同 gate+skill 但目标不同（不同主机/不同文件）是不同的事，不能互相吞掉。
  let lastGateSig = '';
  /**
   * 待批队列 → 渲染层（`pending_actions` 事件）。
   *
   * 与 gate_report 的**差别必须保住**，否则两个组件说的是同一件事、用户读两遍：
   *   · gate_report      「有 N 步**没执行**」（系统把它们挡下来了）
   *   · pending_actions  「有 N 步**已经做了、可以回滚**」+「有 M 步**等你点头**才能做」
   * 前者是损失，后者是待办。混在一起说会让用户以为可回滚的改动也没做。
   */
  let lastPendingSig = '';
  const emitPendingActions = () => {
    let list;
    try { list = pendingQueue.list(); } catch { return; }
    if (!list.length) return;
    const sig = list.map((x) => x.id + '|' + x.summary + '|' + (x.reversible ? 1 : 0)).join(',');
    if (sig === lastPendingSig) return;
    lastPendingSig = sig;
    try {
      send({
        type: 'pending_actions',
        total: list.length,
        items: list.map((x) => ({
          id: x.id, summary: x.summary, tool: x.tool || '', reversible: x.reversible !== false,
        })),
      });
    } catch { /* ignore */ }
  };
  /**
   * 待批清单的**正文通道**（用户真的看得见的那一条）。
   *
   * 为什么事件之外还要正文：`gate_skipped` 事件发出去以后在渲染层零消费，用户什么都没看到 ——
   * 这个坑本仓踩过。待批清单比它更要紧：那是"我等你点头才做"的清单，
   * 只写进 tasks.json 或者只发事件，等于用户永远不知道该补哪一句。
   *
   * 幂等：同样内容只说一次。三个终态出口（正常/中断/预算/轮尽）都会调，
   * 主循环每轮收尾也可能调 —— 不去重的话用户会看到 5 段一模一样的清单。
   */
  let lastPendingNoteText = '';
  const appendPendingNote = async () => {
    let note = '';
    try { note = pendingQueue.summary(); } catch { return; }
    if (!note || note === lastPendingNoteText) return;
    lastPendingNoteText = note;
    try {
      await sendTextAsStream('\n\n【等你点头】\n' + note
        + '\n\n（上面标「还没做」的，我一件都没动。回一句「都做」我按顺序执行；也可以只挑其中几条。）');
    } catch { /* 前端可能已断开，收尾写流失败无所谓 */ }
  };
  const emitGateReport = () => {
    // ★ 待批队列与闸门清单共用同一个收尾时机（都是"当前状态"，不是事件流水）。
    //   放在这里而不是另找 5 个调用点：emitGateReport 本来就在每轮收尾被调用，
    //   复制一份调用就到手了；另起一套时机必然漏一处（这仓库踩过太多次）。
    emitPendingActions();
    const p = skippedGatesPayload();
    if (!p) return;
    const sig = p.total + '|' + p.items.map((g) => g.gate + ':' + g.skill + ':' + g.target + ':' + g.count).join(',');
    if (sig === lastGateSig) return;   // 内容没变就不重复发（循环每轮都调）
    lastGateSig = sig;
    try { send({ type: 'gate_report', total: p.total, blocked: p.blocked, items: p.items, unattended }); } catch { /* ignore */ }
  };
  // 任务状态落盘（每轮工具执行后调用），中途崩了/被停也留得下进度。
  const persistTask = (status) => {
    try {
      // ★ 把自己这一轮的真实用量交给调用方：第二执行实例靠它把"替补花了多少"报回外层
      //   （`retBox.usedTokens` 与落盘的 `usedTokens` **同源同一秒**，不是另算一份）。
      //   普通调用 retBox 不存在 / 不是对象 ⇒ 什么都不做，行为不变。
      try {
        if (retBox && typeof retBox === 'object') {
          retBox.usedTokens = taskEntry.usedTokens || 0;
          // ★ 第二个读数：**上游真实收数**（Σ(prompt+completion)），与 `usedTokens` 的
          //   "增量口径"不同。复验方量"替补花了多少"时用的是上游实收（次数 × 单价），
          //   而闸门/预算用的是增量口径 ⇒ 只回传一个数，另一个口径就必然被当成"记漏"。
          //   两个都交出去，审计能自己对齐，且**不改** `usedTokens` 的既有语义。
          retBox.billableTokens = taskEntry.billableTokens || 0;
        }
      } catch { /* 取证旁路 */ }
      upsertTaskRecord({
        taskId,
        owner: payload.username || '',
        // ★ 内部子运行（第二执行实例）在这里被显式标记，upsertTaskRecord 会据此**不落盘**
        //   （判据 isInternalTaskRecord：写侧与读侧同一条，见那个函数的头注）。
        internal: isInternalRun,
        goal: taskGoal,
        plan: taskEntry.plan || [],
        done: taskEntry.doneLog || [],
        current: taskEntry.current || null,
        artifacts: deliverables.map((d) => d.path),
        lastError: taskEntry.lastError || '',
        skippedGates: taskEntry.skippedGates || [],
        usedTokens: taskEntry.usedTokens || 0,
        // ★ 本任务里第二执行实例烧掉的 token 合计（见 delegateUsage 头注）。
        //   本任务总花费 = usedTokens + delegateTokens。
        delegateTokens: delegateUsage.tokens,
        // ★ 2026-09-24：轮数轴 / 打转检测的取证字段（原来只落 usedTokens）
        turns: taskEntry.turn + 1,          // turn 是 0-based ⇒ +1 之后才是"跑了几轮"
        toolCalls: taskEntry.toolCalls || 0,
        maxTurns: taskEntry.maxTurns || 0,
        wrappedUp: !!taskEntry.wrappedUp,
        wrappedUpReason: clip(taskEntry.wrappedUpReason, 20),
        turnTrace: taskEntry.turnTrace || [],
        status,
        updatedAt: Date.now(),
      });
      if (projectStore && project) {
        const artifactItems = deliverables.map((d) => d.path);
        const runtime = runtimeEvidence.summary({ artifacts: artifactItems, expectsRuntime: runtimeRequired });
        runtime.records = runtime.records.slice(-30);
        const saved = projectStore.recordTurn({
          owner: ownerKeyOf(payload),
          threadId: String(payload.threadId || ''),
          projectId: project.projectId,
          taskId,
          kind: project.origin && project.origin.taskId === taskId ? 'origin' : 'feedback',
          feedbackText: intentText || lastUserText,
          plan: taskEntry.plan || [],
          failures: unresolvedSteps(taskEntry.doneLog),
          artifacts: artifactItems,
          validation: { acceptance: acceptanceForLedger, runtime, artifacts: artifactsOf(artifactItems) },
        });
        if (saved.ok && saved.project) project = saved.project;
      }
    } catch (e) { console.error('[Backend] persist task failed:', e.message); }
  };
  // 记录一步「已完成/已失败」的技能执行结果（brief 取结果首行）。
  // kind：'ok' | 'failed' | 'skipped'。**跳过 ≠ 失败**：无人值守跳过闸门、用户主动取消
  // 这类是「没执行」，不该被当成失败挂账，否则收尾会误判成半成品（见 unresolvedSteps）。
  // ★ 销账逻辑（销哪一条旧账）**不写在这里**，而在 deliveryProtocol.recordStep 里：
  //   它是完成门禁的输入，必须能被单测直接调用（抽真函数，不写副本）。
  // ★★ target（第 5 参，2026-11-02）：这一步**作用的对象**，由 deriveStepTarget 从工具入参推出。
  //   只销「同技能 + 同 target」的账 ⇒ 第 3 步验 A 失败不会被第 7 步验 B 的 pass 销掉。
  //   ⚠️ 只有「真的执行了某个技能」的三条路径传它（并行 / 需确认工具 / 普通技能）；
  //     其余 18 处（闸门拦截 / 熔断 / 跳过 / 危险操作确认 / 用户取消）**故意不传**：
  //      那些是"这次没执行"，不是"这次执行对象是 X"，硬塞一个 target 会伪造证据。
  //      它们要么 kind:'skipped'（本来就不参与销账），要么走保守兜底（最多销一条）。
  //      这一行是留给下一个人的说明，不是漏写。
  /**
   * 往失败账本记一步。
   * @param {string} skill 技能名
   * @param {boolean} ok 这一步**是否真的做成了**
   * @param {string} brief 一句话说明（会出现在用户能看到的分步清单里）
   * @param {string} [kindHint] 'skipped' = 这一步**没有执行技能本体**（无人值守跳过 / 用户点跳过 /
   *   用户未提供素材 / 危险操作拦下 / 熔断 / 意图闸门）。**跳过不算成功，不许销账。**
   *   ⚠️ 硬规则：凡是 `markStep(name, true, …)` 而这一步并没有真的跑技能本体，**必须**传 'skipped'
   *   （或传 target），否则 kind 缺省成 'ok' ⇒ 它会把同一技能上一轮的真失败销掉。
   *   实测事故：第 3 步 ppt-generate 真失败（磁盘满）→ 用户点一次「跳过素材提供」⇒ 账被抹平
   *   ⇒ 完成门禁放行 ⇒ 用户看到「承认有问题，然后没了」（原话）。
   *   本文件现有 6 处属于这一类，全部已显式传 'skipped'；门禁 unit-failure-ledger 的 L8.13 会拦新的。
   * @param {string} [target] 这一步作用的对象（由 deriveStepTarget 从工具入参推出）。
   *   ⚠️ 只有**真的执行了技能**的三条路径（受控并行 / 需确认工具 / 普通技能）才许传；
   *   闸门、熔断、跳过、取消这些"未执行"的记账**一律不传** —— 给没执行的东西安一个 target，
   *   销账时就会把真执行过的失败销掉（伪造证据）。
   */
  const markStep = (skill, ok, brief, kindHint, target) => {
    taskEntry.stepNo += 1;
    taskEntry.lastSkill = skill;
    recordStep(taskEntry.doneLog, {
      step: taskEntry.stepNo, skill, ok,
      kind: kindHint || undefined,
      brief: clip(brief, TASK_BRIEF_MAX),
      target: target || undefined,
    });
    taskEntry.current = { step: taskEntry.stepNo, skill, status: ok ? 'done' : 'failed' };
    // ★ 2026-09-24 逐轮轨迹（本轮增量）：成功/失败步数分别记账 ⇒ 事后能看出
    //   "第几轮开始只剩不产出的动作"（打转检测的数据基础，不是拿它当判据）。
    if (kindHint === 'skipped') turnSnap.skipped = (turnSnap.skipped || 0) + 1;
    else if (ok) turnSnap.ok += 1; else turnSnap.fail += 1;
    persistTask('running');
  };
  // 仍未闭环的失败（供收尾门禁：只要还有没解决的失败，就不许宣布完成）。
  const openFailures = () => unresolvedSteps(taskEntry.doneLog);

  // 注入专家 system prompt 后复制对话，避免污染前端传来的历史；过长时先压缩历史
  // ⚠️ 必须用 let：循环内会按上下文压力**重新赋值**（见下方「循环内上下文压缩」）。
  // 原先这里是 const、且压缩只做这一次 ⇒ 进循环后每轮全量重发，长任务必然 O(N²) 烧穿预算。
  let conversation = await compressContext(injectExpertSystemMessage(payload), payload, cfg);

  // 豆芽行为协议：主聊天（workbench 豆芽对话）始终注入，作为最底层人设。
  // 放在 compressContext 之后 unshift，保证协议完整、不被历史压缩吃掉。
  conversation.unshift({ role: 'system', content: DOUYA_PERSONA_PROMPT });

  // 【2026-10-19 老板第 1 条】豆芽要叫用户的名字。
  // 老板原话：「豆芽能够叫用户名字 登录的名字就是豆芽对用户的称呼」。
  //
  // 为什么是**第二条 system**而不是拼进上面那个常量（两层都要，缺一层等于没做）：
  //   ① 上面的常量是纯静态人设，被 unit-delivery-protocol / unit-agent-summary 等多条门禁
  //      按字面断言（尤其 unit-agent-summary:145 直接正则匹配 `content: DOUYA_PERSONA_PROMPT` 这一行）；
  //      把运行时数据拼进去会让「人设是否被完整注入」这条判据失真，也会打掉那条正则。
  //   ② 称呼是**每请求变化的数据**，本来就不该混进人设文本。
  // 顺序：两次 unshift ⇒ 称呼消息在最前，人设紧随其后。模型先知道"在跟谁说话"，再读行为协议。
  // 取不到名字（未登录 / 空串）时**不注入**——塞一条「名字是空」比不塞更糟。
  const callNameMsg = buildCallNamePrompt(payload && payload.username);
  if (callNameMsg) conversation.unshift({ role: 'system', content: callNameMsg });

  // 只注入当前 owner+thread 明确解析出的项目；多项目歧义时列候选，不猜“最近一个”。
  if (project) conversation.push({ role: 'system', content: projectPrompt(project) });
  else if (projectDecision && projectDecision.status === 'ambiguous') {
    conversation.push({ role: 'system', content: ambiguityPrompt(projectDecision) });
  }

  // ===== 【2026-11-09】任务级三档判定（SILENT / QUEUE / CONFIRM）=====
  // 判据在 gateTier.js（纯函数、零 fs、有独立门禁 unit-gate-tier.mjs），本文件只消费结论。
  //
  // 为什么必须在**这里**算一次：闸门散落在下面十几处，各自判断"要不要打扰"，等于没有判据。
  // 只在这一处算，之后每个闸门问同一句话：本轮是哪一档？
  //
  // 只认**用户原话**做信号（不读模型自述）—— 模型说"这个很简单"不算信号，
  // 那正是闸门存在的理由（不信任这个判断）。
  const goalTextOf = (msgs) => {
    const list = Array.isArray(msgs) ? msgs : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m || m.role !== 'user') continue;
      const c = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string')
          .map((x) => x.text).join('\n');
      }
    }
    return '';
  };
  const goalText = goalTextOf(conversation);
  // ★ 可重判：拿到 request_plan_ack 的真实步骤数后会再算一次（steps 从"分句估下界"升级为"计划长度"）。
  let gateTier = decideForTask({ goalText, explicitNoAsk: unattended === true });
  const gateTierLabel = () => gateTier.tier;
  const refreshGateTier = (plan) => {
    gateTier = decideForTask({ goalText, plan, explicitNoAsk: unattended === true });
    return gateTier;
  };
  try {
    taskTrace.record(taskId, 'gate_tier', {
      tier: gateTierLabel(),
      reasons: gateTier.reasons,
      steps: gateTier.steps,
      ambiguous: gateTier.ambiguous,
      categories: gateTier.categories,
      unattended: unattended === true,
    });
  } catch { /* 旁路 */ }

  // ===== 深度思考判定：请求开始时算一次并锁定（多信号综合，全程 high/none 一致，不中途翻转）=====
  // 信号来源（任一命中即开，见模块级 thinkSignals）：① 历史/请求内已有工具活动 ② 本次带附件
  // ③ 动作/产物关键词 ④ 短促跟进指令（继续 / 再试 / 修一下 / 部署 / 上线 / 看下有没有问题 …）。
  // ★ 必须在第 0 轮就开对：thinking 契约要求「工具轮的 assistant.reasoning_content 需原样回传」，
  //   若第 0 轮判 none 又调了工具，该轮 assistant 天生没有 reasoning_content，之后各轮会被
  //   hasReasoningLossyToolTurn 守卫永久关闭（原 didToolCall「调工具后自动开思考」补偿因此不可达）。
  //   所以唯一安全的路径是「开头就判对」，而不是中途补开。
  const thinkReasons = thinkSignals(payload, conversation);
  const deepThink = !isShopping && thinkReasons.length > 0;
  if (process.env.DOUYA_DEBUG_THINK === '1') {
    console.log('[DEBUG think] signals=' + JSON.stringify(thinkReasons) + ' deepThink=' + deepThink);
  }
  // 本次请求是否开启 thinking。deepThink 在请求内锁定；thinkForcedOff 与 lossy 守卫只会把 true 变 false，
  // 绝不会 false→true 翻转（保证同一请求内 high/none 一致，不触发 thinking 契约违约）。
  const wantThink = () =>
    !isShopping && !thinkForcedOff && deepThink && !hasReasoningLossyToolTurn(conversation);

  // 解析用户本次上传/选择的本地文件，把内容追加为一条 system 上下文供模型阅读
  const attachedText = await resolveAttachments(payload.attachments, skills, cfg);
  if (attachedText) {
    conversation.push({
      role: 'system',
      content:
        '【用户本次提供的本地文件内容，请优先据此回答】\n' + attachedText +
        '\n\n注意：以上是文件正文，不是用户新说的话。请结合用户最后的问题，基于这些文件内容来回答/处理。' +
        '\n\n若上面没有提到某张图片的画面内容，说明那张图没有被读到——不要编造画面内容，如实说明没读到。',
    });
  }

  // 对话记忆：把最近做过的成果清单注入为 system 消息，让模型跨会话"记得"自己做过什么，
  // 避免用户说"改一下之前的网页"时模型不知道是哪个文件（上下文压缩也不会把这层记忆压掉）。
  try {
    const recentDels = readDeliverables(payload.username)
      .slice()
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .slice(0, 10);
    if (recentDels.length) {
      const lines = recentDels.map((d) => '- ' + (d.path || '') + '（' + (d.name || '') + '）').join('\n');
      conversation.push({
        role: 'system',
        content:
          '【你之前做过的成果（用户可能让你改其中某个）】\n' + lines +
          '\n\n如果用户说「改一下之前的网页/文件」但没指明是哪个，先根据这份清单和最近对话判断最可能是哪个，必要时问一句确认，不要瞎猜路径。',
      });
    }
  } catch {}

  // ===== ⑤ 部署后必须做浏览器验收（工具使用引导；只注入系统提示，不动 runAgentLoop 主流程）=====
  // 【部署能力引导】实测教训（2026-09-15 真机端到端）：给模型 41 个工具时，若只提供 deploy-static
  // 而不明确要求「用它」，模型会绕开技能、用 shell-exec 手写 `ssh` / `npm install ssh2` 自建上传脚本，
  // 结果在本机因缺依赖反复失败并耗尽 token 预算，网站根本没传上去。故在提示层写死「必须用现成技能」。
  // 仅在环境里真有部署类技能时注入（技能未就绪则不产生空指引）。
  if (skills.some((s) => s && (s.id === 'deploy-static' || s.id === 'deploy-node'))) {
    conversation.push({
      role: 'system',
      content:
        '【部署网站 / 连服务器必须用现成技能（硬规矩）】\n' +
        '· 把网站或项目传到服务器、以及在服务器上执行命令，**必须调用现成技能**：\n' +
        '  - 静态网站（HTML/CSS/JS，或打包好的前端产物）→ `deploy-static`\n' +
        '  - Node 应用 / 需要进程守护的服务 → `deploy-node`\n' +
        '  - 在服务器上跑某条命令、或单独传一个文件 → `ssh-exec`\n' +
        '· **严禁自己手写替代方案**：不许用 shell-exec 拼 `ssh` / `scp` / `sftp` 命令；不许 `npm install ssh2`（或任何 SSH 库）再写脚本；不许自己实现打包上传。\n' +
        '  这类做法在本机会因缺依赖、Windows/Linux 命令差异而反复失败，而且**绕过了技能内置的备份、回读校验、危险目录拦截与 nginx 配置**，即使侥幸成功也更危险。\n' +
        '· **不要用 `ping` 判断服务器是否可达**：ping 常被机房/防火墙禁用，不通**不代表**连不上。要确认连通性就直接调用上述技能，让技能去连。\n' +
        '· 用户已经给出服务器地址、用户名、密码（或私钥路径）时，**直接填进技能参数执行**，不要再追问一遍。\n' +
        '· 目标目录以用户指定为准；用户没指定时选一个语义明确的站点目录（如 /www/<项目名>），**绝不要**指向 /etc、/usr、/var 等系统目录。',
    });
  }

  // 老板核心诉求：「部署上去、做测试、检测 bug、最后上线」。部署技能返回成功 / curl 看到 200
  // **只证明服务器应答了，不等于用户能用**（可能白屏、按钮没反应、控制台报错、资源 404）。
  // browser-verify 能力已交付，必须在提示层接上，否则豆芽永远只看到 200 就宣布"上线成功"。
  // 仅在环境里真有该技能时注入（技能未就绪则不产生空指引）。
  if (skills.some((s) => s && s.id === 'browser-verify')) {
    conversation.push({
      role: 'system',
      content:
        '【部署后必须做浏览器验收（硬规矩）】\n' +
        '· 部署类技能（deploy-static / deploy-node / ssh-exec）返回成功、或 curl 看到 HTTP 200，**只证明服务器应答了，不等于上线成功**；HTTP 200 的页面照样可能白屏、按钮点了没反应、控制台报错、资源 404 —— 用户根本用不了。\n' +
        '· 所以部署完成之后，**必须再调用「浏览器验证」(browser-verify) 技能**打开**公网可访问的 URL**（对外域名 / 公网 IP，**不是 127.0.0.1 / localhost** —— 那只是服务器自己），并带上 expect_text 或 expect_selector 做断言，确认页面真的渲染出预期内容。**不要**在只看到 200 时就宣布"上线成功"。\n' +
        '· ⚠️ browser-verify 要在**本机**跑（本机装了 Edge/Chrome）；**Linux 服务器上通常没有任何 Chromium 内核浏览器**，把验收丢到服务器上跑只会得到 verified:false（根本没检查成）。所以正确做法是：在**本机**对**公网 URL** 验收。\n' +
        '· 诚实语义（务必分清，别把"没查成"说成"通过"）：\n' +
        '  - `verified:false` = **根本没检查成**（例如那台机器上没有浏览器内核）—— **不是通过**，必须如实转述，并建议在本机复验；\n' +
        '  - `ok:false` 且 verified:true = **确实检查了、并发现了问题**，blockers 里是真实原文（控制台报错 / 失败请求 / 断言不符），要把要点如实转述给用户。\n' +
        '· browser-verify 返回 FAIL（ok:false）或没跑成（verified:false）时，**绝不许对用户说"上线成功"**；要如实说："部署已完成，但浏览器验收未通过 / 未跑成，受阻点是 X"。\n' +
        '· 只有 verified:true **且** ok:true 时，才可以说"已上线并通过浏览器验收"。',
    });
  }

  // ===== ⑨ 本机文件产物怎么自己截图验收（2026-11-07 新增；补上「本地产物」这条路）=====
  // 【为什么需要这一段（端到端实测抓到的真缺陷，别删）】
  //   上一段「部署后必须做浏览器验收」的本意**是对的**：防「在服务器本机看 127.0.0.1 就宣称
  //   外网能用」。但它被模型**泛化**成了「任何时候都不许用 127.0.0.1」。后果是一条死循环：
  //   slides-generate 之类做完本地产物想截图自检时，模型只会去试
  //     ① `file://` —— 被 browser-verify 按安全红线直接拒绝（skills/browser-verify/lib/urls.js），
  //     ② `shell-exec` 起本地静态服务器 —— 600 秒超时 / 本机缺 powershell 直接熔断，
  //   然后放弃 ⇒ 复检永远 verified:false ⇒ 任务终态永远是 PARTIAL，永远到不了 COMPLETE。
  //   后端其实已经开好只读静态路由 `/ws/*`（实现与全部安全判据见 `resolveWsRequest` 那段），
  //   缺的**只是提示层没告诉模型它存在、地址怎么拼**。所以这里补两件事：
  //   (a) 说清「部署验收用公网 / 本地产物用回环」是两个场景、不冲突（老规矩一个字都不放宽）；
  //   (b) 给出可直接使用的确切地址，端口用真实的 PORT 拼进去（写占位符等于没给）。
  // 仅在环境里真有该技能时注入（技能未就绪则不产生空指引），与相邻块风格一致。
  if (skills.some((s) => s && s.id === 'browser-verify')) {
    conversation.push({
      role: 'system',
      content:
        '【本机文件产物怎么自己截图验收（硬规矩）】\n' +
        '· 先分清这是**两件不同的事**，两者**不冲突**：\n' +
        '  - 验收**已经部署到服务器**的站点 ⇒ 仍然必须用**公网可访问的 URL**（对外域名 / 公网 IP），**不许**用 127.0.0.1 / localhost：那只是服务器自己，证明不了外网能用。**这条老规矩继续原样有效，没有放宽**。\n' +
        '  - 验收**本机工作区里的文件产物**（例如 slides-generate 产出的 HTML）⇒ 用**本机回环地址**打开。这种场景下 127.0.0.1 就是**正确**地址，不算违规。\n' +
        '· 确切的可用地址（后端已开好一条只读静态路由，就在本机回环上，端口就是后端端口）：\n' +
        '  http://127.0.0.1:' + PORT + '/ws/<产物相对工作区根的路径>\n' +
        '  例：产物是 ' + AGENT_WORKSPACE + '\\演示文稿.html ⇒ 地址就是 http://127.0.0.1:' + PORT + '/ws/演示文稿.html\n' +
        '  （子目录用 `/` 分隔，例如 /ws/ppt/第二页.html；**中文文件名可以直接写**，浏览器会自动做百分号编码，路由对中文与编码两种写法都认。工作区根目录是 ' + AGENT_WORKSPACE + '，URL 里的路径是相对它的。）\n' +
        '· **不要绕路**（这两条都试过、都走不通，别再浪费一轮）：\n' +
        '  - `file://` 会被 browser-verify 按安全红线**直接拒绝**（故意这么设计的：file:// 会绕过网络边界直接读本机任意文件）—— **绝不尝试绕过它**，也不要把 file:// 改写成别的协议去绕过。\n' +
        '  - **不要**用 shell-exec 自己起本地静态服务器（http-server / python -m http.server 之类）：会撞 600 秒超时，本机缺 powershell 时还会直接熔断。要用 http 就用上面那条现成的路由。\n' +
        '· 这条路由的边界（别把它当通用文件读取用）：**只读**（只允许 GET/HEAD）、**只能取工作区内的文件**、取不到工作区外的任何路径、只放行白名单扩展名（.html/.htm/.css/.js/.mjs/.json/.md/.txt/.csv/.svg/.png/.jpg/.jpeg/.webp/.gif/.ico/.woff/.woff2/.ttf/.mp4/.webm/.mov/.m4a/.mp3/.wav/.ogg），单文件上限 64 MiB。要预览工作区外的文件，先把它产出/复制到工作区内。\n' +
        '· 判定语义（与上一段同口径，别混）：`verified:false` = **根本没检查成**（地址打不开 / 被路由拒绝 / 那台机器没有浏览器内核），**不是通过**；只有 `ok:false` 且 `verified:true` 才是**确实查了、且发现了问题**。自检没跑成时如实说"没查成、受阻点是 X"，**不许**当作通过。',
    });
  }

  // ===== ⑧ 演示文稿默认用网页版（2026-10-11 新增；工具选择引导）=====
  // 起因（老板原话）：「现在做 PPT 特别弱鸡 只能做很差的那种」。查证结论：不是模型不努力，
  // 是**接口 + 格式双重锁死** ——
  //   · 旧 ppt-generate（python + python-pptx）实测：形状类型只有文本框（{'sp':20}）、图片 0、
  //      图表 0、每页形状数恒为 5、版式只有 1 种；
  //    · 它的 manifest 只收 {title, slides:[{title,bullets[]}]} ⇒ 模型**没有参数能表达版面**；
  //    · pptx 是 zip+OOXML 二进制包 ⇒ 生成完**无法渲染、无法截图自检**，文字一长就溢出而它看不见
  //      （正好违反「完成状态由证据决定」）。
  //   网页版（slides-generate）一次解开全部：CSS 可表达版面、可被 browser-verify 截图验收、可发链接分享。
  //   ⇒ 设为默认；只有在「明确要 .pptx 文件 / 对方要用 Office 改」时才走旧技能。
  // 仅在环境里真有该技能时注入（技能未就绪则不产生空指引）。
  if (skills.some((s) => s && s.id === 'slides-generate')) {
    conversation.push({
      role: 'system',
      content:
        '【做演示文稿默认用网页版（硬规矩）】\n' +
        '· 用户要 PPT / 演示文稿 / 汇报 / 方案 / 路演 / 介绍材料时，**默认调用「生成演示文稿（网页版）」（slides-generate）**，产出用浏览器直接演示的网页。\n' +
        '· **只有**这两种情况才改用旧的 ppt-generate（生成 .pptx 文件）：① 用户明确说要文件版、"要能下载/发给别人的 pptx"；② 对方必须用 PowerPoint 二次编辑。除此之外一律用网页版。\n' +
        '· 为什么默认网页版（别改回去）：网页版**能被浏览器截图验证**（做完可用 browser-verify 打开验收，确认排版没崩、内容都在），pptx 做不到；网页版还能表达版面（分栏/图文），旧版只能"一标题 + 一串要点"。\n' +
        '· **每页怎么写**（决定好不好看，务必照做）：\n' +
        '  - 一页讲一件事，页标题直接给结论（例：「根因：同步调用冻住了主进程」），别写「问题分析」这类空标题；\n' +
        '  - 每页 3~6 条，**每条尽量短**，一句话说清；长句拆成两条，不要超过一行半；\n' +
        '  - 一页别塞十几条，宁可拆成两页。\n' +
        '· 做完后：把生成的文件路径告诉用户，说明"双击就能打开、按 → 翻页、F 全屏"。用户若想**发给别人看**，再提议用「部署静态网站」技能发成链接（**不要未经他同意就发布**）。',
    });
  }

  // ===== ⑧.5 视频：单轨用「处理音视频」，多轨精剪用 concat-video（2026-11-07 接入 Concat）=====
  // 【为什么要有这段】接入 Concat（开源视频编辑器，MCP over stdio，45 个工具）之后，技能
  // 目录里会同时存在「处理音视频」(media-edit，ffmpeg 单轨) 与「视频精剪（Concat）」
  // (concat-video，多轨)。不给分流规则的话有两种可预见的坏结果：
  //   ① 模型拿 media-edit 硬凑多轨 —— 它只能 trim/speed/concat，做不出画中画与转场，
  //      于是"尽力了但很丑"，用户还得自己再剪一遍；
  //   ② 模型拿 concat-video 去做一条 5 秒的纯拼接 —— 起 MCP 会话、建工程、导出，
  //      比 ffmpeg 一条命令慢一个数量级。
  // 另外必须写死"没装就引导安装"，否则模型会以为工具坏了而反复重试。
  if (skills.some((s) => s && s.id === 'concat-video')) {
    conversation.push({
      role: 'system',
      content:
        '【视频：先分清是「拼接」还是「精剪」（硬规矩）】\n' +
        '· 只有**裁剪 / 变速 / 提取音频 / 转格式 / 调音量 / 压缩 / 多段拼接** ⇒ 用「处理音视频」(media-edit)，一条命令就完事，别起编辑器。\n' +
        '· 要**多轨叠加 / 画中画（缩放·位移·旋转）/ 淡入淡出 / 转场 / 关键帧动画 / 标题文字 / 字幕** ⇒ 用「视频精剪（Concat）」(concat-video)。这些 media-edit 做不出来，别硬凑。\n' +
        '· concat-video 的用法：先 `action=probe` 确认装没装；`action=render` 给一份剪辑单（JSON）一口气出片；`action=inspect` 读已建工程的时间线；`action=frame` 在某个时间点抽一帧 PNG 看画面对不对。\n' +
        '· **剪辑单里只写它认识的字段**（字段名就是底下 Concat 的原名，别自己造）：`name` / `video{width,height,fps}` / `tracks[{type,clips[{media,start,in,duration,scale,offsetX,offsetY,rotation,opacity,fadeIn,fadeOut,transition,keyframes}]}]` / `titles[{text,start,duration,offsetY,fontSize,color,...}]` / `captions[{text,start,end}]` / `captionStyle` / `export{output,crf,preset}`。写错了它会**一次把所有错都列出来**，照它说的改，不要一条一条试。\n' +
        '· **复用工程是「往上加」，不是覆盖**：传了 `project` 指向已建工程时，原来的内容还在，新内容叠上去。想要干净的成片就**不要传 project**，让它新建一个。\n' +
        '· 导出可能要几十秒到几分钟（`export_wait` 一次最多等 600 秒），**别中途当成卡死**；技能内部会循环等到出片或到点，到点没完它会如实说"可能仍在跑、稍后看产物文件"。\n' +
        '· 如果 probe 说**没装**：如实告诉用户"这台机器没装 Concat，多轨精剪需要它"，把技能返回里的下载地址与安装路径转述给用户，并问要不要先改用「处理音视频」做单轨版。**不要**反复重试 probe，也不要说成"工具坏了"。\n' +
        '· 出片后把**视频的绝对路径**告诉用户，并说明"双击就能播放"。想确认画面对不对，用 `action=frame` 抽一帧（它返回 PNG 路径），不必让用户自己去看。',
    });
  }

  // ===== ⑥ 目标域名已被占用时：自己按默认路线走，别把选择题丢回用户（工具使用引导）=====
  // 【实测教训（2026-09-16 真机）】用户说"在 api.example.com 里传个新页面、自己创个子页面"时，
  // 模型发现该域名已被工作台站点占用（/etc/nginx/sites-enabled/workbench-https），
  // 判断"动别人配置有风险"，于是**把"方案A 子域名 / 方案B 路径"的选择题原样丢回给用户**，
  // 一个动作都没做。根因有两层：(a) 提示层没给"目标被占用"的默认路线，模型没有可执行的默认动作；
  // (b) 旧版 deploy-static 只会"新开独立站点"，没有"挂到已有域名子路径"的能力。
  // (b) 已由 deploy-static 的 url_path 参数补齐；此处补 (a)：把默认路线与"不许问"写死。
  // 仅在环境里真有部署类技能时注入（技能未就绪则不产生空指引）。
  if (skills.some((s) => s && (s.id === 'deploy-static' || s.id === 'deploy-node'))) {
    conversation.push({
      role: 'system',
      content:
        '【目标域名已被占用时：自己按默认路线执行，禁止把选择题丢回用户（硬规矩）】\n' +
        '【复杂度阶梯：从上往下挑，能用上面的绝不用下面的】\n' +
        '1. 把内容挂到**已有域名的一个子路径下**——零进程、零端口、不动 DNS、不动证书，天然继承已有 HTTPS。**用户说"加个页面 / 子页面 / 网页 / 上传个网站"时，默认就是这一条。**\n' +
        '2. 只有当内容与已有站点完全无关、且用户另有自己的域名时，才新建独立站点。\n' +
        '3. 只有当用户给的确实是**需要常驻运行的后端服务**（Node 项目、要 npm start、有服务端接口）时，才用需要起进程的那个部署技能。**普通网页永远不用它**——它会起常驻进程、要占端口，是最重的一条路。\n' +
        '· **技能选择排他规则**：`deploy-node` 需要一个"应用端口"参数才能让页面从外部打开，**选错就会把"你要开哪个端口"这个问题送进对话**——这正是用户最反感的"把简单事复杂化"。所以 **"上传一个网页"一律用静态部署技能（`deploy-static`）**，不要碰 `deploy-node`。\n' +
        '· 用户让你把页面/应用挂到某个域名下，而该域名**已经被别的站点占用**（例如 api.example.com 正跑着工作台）时，**不要**列出"方案A 子域名 / 方案B 路径"让用户选。你有默认路线，**直接执行它**：\n' +
        '  **默认 = 挂到该域名的子路径下**：`deploy-static` 填 `domain=<该域名>`、`url_path=/<项目名>`、`remote_dir=<站点目录>`。\n' +
        '  为什么默认走路径而不是子域名：路径**不需要加 DNS 记录、不需要申请证书**，而且那段 location 是插在对方已有的 server 块里，天然继承它的 HTTPS；子域名则要用户去域名服务商加 A 记录——那是用户做不到就得你干等的活。\n' +
        '· 技能自己会做安全兜底：定位真正承载该域名的配置文件 → **只在它的 server 块内插入一段带 `# >>> douya subpath begin/end <<<` 标记的 location，绝不改动原有任何内容** → 先备份 → `nginx -t` → 失败立刻回滚 → 通过才 reload，并会自证"除插入段外原文逐字节未变"。所以**不要**因为"怕改坏"而回避，也**不要**绕开技能去手写 nginx 配置或手动 sed 文件。\n' +
        '· **默认永远走路径**（见上面的复杂度阶梯），这条路不需要用户做任何事。**只有用户明确点名了某个具体网址时**（如"我要用 xxx.api.example.com"）才考虑那条路。\n' +
        '· **即使那种情况，也绝不许直接甩一句"这一步我做不了"给用户**：必须先给出一个**不需要他动手的替代方案并推荐它**，再用大白话说明另一条为什么需要他配合。可照说的口吻示例："你说的那个网址现在还打不开，需要在域名那边加一条记录才行，这一步得你去操作。不过我也可以直接挂在 api.example.com 下面，你不用动任何设置就能打开，要这样吗？"\n' +
        '· 挂了子路径之后，**页面内所有以斜杠开头的绝对路径都必须改成相对路径**，这是挂子路径后**必做的一步**，不改就一定坏：\n' +
        '  - **静态资源**：`/app.js`、`/assets/x.png`、`/style.css` → 改成 `app.js`、`assets/x.png`、`style.css`（或 `./` 前缀）。不改成相对路径，浏览器会去对方站点的根目录找，直接 404。\n' +
        '  - **接口/API 调用**（最容易漏，且坏了更隐蔽）：`fetch(\'/api/state\')`、`axios.get(\'/api/list\')` 这类**写死绝对路径的请求**，在子路径下会打到对方站点的 `/api/...`（那是它自己的后端），**页面能打开但功能全错**。必须改成相对路径（`fetch(\'api/state\')`），并确认 nginx 的 location 前缀能把 `/子路径/api/...` 一并转给应用。\n' +
        '  - 动手前先**通读页面，把所有以 `/` 开头的 `src`/`href`/`url()`/`fetch()`/`XMLHttpRequest`/`axios` 路径找出来改掉**；有构建配置或 `base`/`publicPath` 概念的（如 Vite `base`、webpack `publicPath`）就改配置，不要只改产物。\n' +
        '· 如果目标不是纯静态站、而是**需要后端进程的应用**（Node 等），挂子路径同样可行，但要注意：nginx 侧要写成 `location ^~ /<路径>/ { proxy_pass http://127.0.0.1:<端口>/; }`（**`proxy_pass` 结尾那个 `/` 不能漏**，它负责把 `/路径/` 前缀剥掉再转给应用，否则应用收到的路径会多一层前缀而对不上路由），并且**上面那条「绝对路径必须相对化」同样适用于它的 API 与资源引用**。**只有一种情况才退到子域名路线**（应用跑在根路径，不需要改任何路径）：该应用是你无法修改的第三方程序、**且**它不支持设置基础路径（如 `base`/`publicPath`/`<base>` 标签）；**这是最后手段**，必须先用大白话向用户说明，并给出你不用他动手的替代方案让他选。\n' +
        '· **收尾必须实测内容，不许只看状态码**：很多站点有 SPA/兜底规则（如 `location / { try_files $uri $uri/ /index.html; }`），**任何不存在的路径都会返回 200**，让你误判"已经好了"（实测过：挂载前 `https://api.example.com/自定义路径/` 就已经是 200，但正文其实是对方站点的首页）。所以验收必须比对**正文内容**（是不是你自己的页面）与关键功能（接口是不是你自己的后端），不能只看 HTTP 200。\n' +
        '· **通则（不止部署场景）**：当你在几条路之间摇摆时，先判断"哪条路不需要用户额外操作、且风险我能自己兜底"，然后**直接执行它**，收尾时用一两句话说明"我选了哪条、为什么、失败会怎样"。**严禁**把"A 还是 B"这种决策原样抛回给用户——用户找你，正是因为他不想做这个决定。\n' +
        '· **极窄例外——只有一种情况才可以请用户配合**：真的必须用户在外部系统操作、你无论如何做不到（例如那是他公司账号、你碰不到）。开口前必须同时满足三条约束：① 先自查"有没有一条我自己就能做完、且不需要他动手的路"，有就先走那条、不要开口；② 措辞必须大白话、零术语（见 ⑦ 的黑名单）；③ 一次只给**一个**具体请求动作，说清"请你在 X 做 Y，做完告诉我，我接着干 Z"，**绝不列多个方案让他挑**。',
    });
  }
  // ===== ⑥.5 设计模具库（2026-11-03）=====
  // 老板原话：「AI 不会设计、没有美感」「每次做出来都一个样」「产品只造了一个模具」
  //        「变聪明这个你能不能去找点所谓的模具？」
  //
  // 【改之前的事实（逐行核过）】
  //   全仓唯一给出**可执行数值**的设计标准在 `experts.js:87`（配色 60/30/10、字号阶、间距、圆角），
  //   而真正注入模型的 `douyaPersona.DOUYA_PERSONA_PROMPT`（11987 字）里**一个 px、一个百分比都没有**
  //   —— 全是"要有设计感/要有呼吸感/别糊弄"。为什么那套进不来：注入条件 `if (payload.expert)`，
  //   而 `App.jsx:1516` 把 expertId 写死成 `''` 且全仓无 setExpertId 调用 ⇒ 死代码。
  //   更要紧的是**每类产出只有一种骨架**：模型没有可选项，同一类需求每次只能写出同一个东西。
  //
  // 【注入范围：按任务类型选择，不是无条件】
  //   2026-11-03 第一版这里是**无条件注入**，理由写的是「判错一次整段模具就静默消失」。
  //   老板指出这是错的方向：「设计规范应该在网页、海报、PPT 等相关任务中注入，
  //   不应该让普通问答、代码调试也携带整套设计上下文。」
  //   现在改为：先过 `designMolds.gateDesignIntent()`（纯函数、可单独断言），
  //   只看**本轮真实用户消息**（传 `intentText`，不传整段历史 —— 历史里提过一次"网页"
  //   就会此后每轮命中，等于又变回无条件注入），并复用 `intentMode`（QUESTION / DIAGNOSE
  //   正是老板说的"普通问答、代码调试"两种形态）。
  //   ★ 判定结果**连命中词一起落 trace**（phase:'gate'）：这条判据将来漏判/误开都能查，
  //     而不是"反正多给 1.3K 字无害"。判据偏召回，见 designMolds 头注③。
  //
  // 【与验收侧的关系】`acceptanceChecklist.G2-4` 会判"只交一版"不合格 ——
  //   此前那条判据只进复核员的清单，**执行侧从没被告知要做两版**，等于因为没人要求过的事扣分。
  //   这一段就是补上执行侧那半句，让判据和指令说同一件事。
  // ★ 声明在块外：收尾处的 auditTask 也要读这次判定（creativeKind 就靠它）。
  let moldDecision = null;
  {
    const moldGate = designMolds.gateDesignIntent({ text: intentText, mode: intentMode });
    // ★ 把判定结果**留在外层作用域**：收尾处的 auditTask 需要 creativeKind 才能按类型查设计维度
    //   （网页查 hover / 移动端适配，PPT 查信息层级，游戏查胜利判定）。不传的话
    //   `acceptanceChecklist.normalizeCreativeKind(undefined)` 一律归一成 visual ⇒
    //   只查通用 8 项 ⇒ 网页专属维度**从来没被查过**。这是"判据在、但输入缺一截"的典型。
    moldDecision = moldGate;
    try {
      taskTrace.record(taskId, 'design-mold', {
        phase: 'gate',
        inject: moldGate.inject,
        reason: moldGate.reason,
        kinds: moldGate.kinds,
        nouns: moldGate.nouns,
        signals: moldGate.signals,
        mode: intentMode,
        // 判"不注入"时留下原文前 120 字：这是复核"判据有没有判错"的唯一线索
        text: moldGate.inject ? undefined : String(intentText || '').slice(0, 120),
      });
    } catch { /* 旁路：记录失败不影响任务 */ }
    if (moldGate.inject) {
      conversation.push({
        role: 'system',
        content: designMolds.buildMoldBrief({ kinds: moldGate.kinds }),
      });
    }
  }

  // ===== ⑦ 面向不懂技术的用户：说人话、技术决策你自己扛（无条件注入）=====
  conversation.push({
    role: 'system',
    content:
      '【面向不懂技术的用户：说人话、技术决策你自己扛（硬规矩）】\n' +
      '· **用户画像**：口腔行业的经营者 / 店长 / 运营，**不是程序员**。他找豆芽，就是因为不想做技术决定。\n' +
      '· **绝不许把技术决策抛回给用户**：不许问"用子域名还是子路径""放根目录还是子目录""用哪个端口""目录 / 路径叫什么"——这些你自己定。\n' +
      '· **术语黑名单（对用户说的话里一律不许出现）**：端口、DNS、A 记录、子域名、证书、SSL、HTTPS（作为技术解释时）、nginx、location、proxy_pass、反向代理、PM2、进程、server 块、根目录、配置文件、ssh、参数、字段。\n' +
      '  - 例外：用户**自己**先在对话里用了某个术语，你才可以在回应里沿用那个词。\n' +
      // 2026-09-22 补：老板实测反馈「很多不必要给用户看的还是会给用户看」——上面那份黑名单漏了
      // **工具名/技能名**（shell-exec、file-write 这类），模型于是把内部工具名当成果汇报。
      // 与 douyaPersona.js 的「排版与呈现」段是一对：那边定行为，这边兜底。
      '· **工具名/技能名黑名单（同样一律不许出现）**：shell-exec、file-write、file-read、file-list、file-search、' +
      'browser-verify、web-fetch、web-search、ssh-exec、image-ocr 等一切英文标识符形式的技能 ID；\n' +
      '  也不许说「我调用了 N 个工具」「重试了 N 次」「读取了 N 个文件」「跑了某个技能」。这些是内部记账，不是交付内容。\n' +
      '· **排版硬要求**：第一行先给结论；超过两句话必须分点（「· 」或「1. 2. 3.」），一点一行；\n' +
      '  不许把三五句话挤成一个没有换行的大段落；不许贴代码块、命令、日志、报错堆栈、JSON、英文字段名。\n' +
      '  用户看不懂代码和英文，出现一次他就会整段跳过——那等于这件事白做了。\n' +
      '· **交付物只有两样**：一句人话（我做了什么）+ 一个**能直接点开的网址**。\n' +
      '  - 坏例子（禁止）："需要你去域名服务商加一条 A 记录指向服务器 IP，这一步我做不了"。\n' +
      '  - 好例子："已经帮你挂好了，打开 https://api.example.com/miaomiao/ 就能看到，原来页面一点没动。"\n' +
      '· **收尾不报**：参数、目录、端口、你改了哪个配置文件、你用了哪个技能名。\n' +
      '· **判断标准**：如果你写出的回复里出现了上面黑名单里的词，就说明你把自己的活推给了用户——重写。',
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * 【snapshot() 注入实验 · 2026-10-27】
   *
   * 改之前的事实（为什么加这一段）：
   *   `wfCtl.snapshot()` 此前只有两个消费点 —— `:4147` 的 console + trace(phase:'start')、
   *   `traceWorkflowEnd` 的 trace(phase:'end')。**它一次都没进过模型上下文**。于是模型
   *   不知道账本里「已完成 outline>build」，跨请求续跑时会把做好的产物重做一遍覆盖掉
   *   （本项目实测：4 次 SIGINT 续跑，2 次产物 sha1 变了）。
   *
   * 这一段**只是把账本事实读出来交给模型**，不做三件事：
   *   ① 不参与任何判据 —— 没有任何代码读这段文本做判断，终态仍由 `workflowRunner.evaluate()`
   *      按磁盘证据算。所以「伪造完成」也绕不过独立验收（这是实验 C 组要证明的）；
   *   ② 不写判决 —— 文本里没有「全部完成/可以收尾」，只有阶段清单、待跑检查、产物指纹；
   *   ③ 不写推测 —— 拿不到的写「未记录」，不补默认值。
   *
   * 放在所有 system 注入之后 push ⇒ 它是模型看到的**最后一条** system，紧邻当前轮。
   * 开关关闭时整段 no-op，与会话历史、工具序列、判据全部无关。
   */
  if (wfCtl && workflowSnapshotPrompt.isEnabled()) {
    try {
      const _snapTxt = workflowSnapshotPrompt.build({
        snap: wfCtl.snapshot(),
        checks: (typeof wfCtl.checks === 'function') ? wfCtl.checks() : [],
        decks: (typeof wfCtl.workspaceDecks === 'function') ? wfCtl.workspaceDecks() : [],
      });
      if (_snapTxt) {
        conversation.push({ role: 'system', content: _snapTxt });
        // 落 trace：实验要求「trace 可以关联实际注入内容、对应请求及执行结果」。
        // 记全文而不是只记长度 —— 事后要能逐字核对模型到底看到了什么。
        try {
          taskTrace.record(taskId, 'workflow', {
            phase: 'snapshot-inject',
            chars: _snapTxt.length,
            turn: 0,
            inject: _snapTxt,
          });
        } catch { /* 旁路：记录失败不影响任务 */ }
      }
    } catch (e) {
      // 注入是增益，不是单点故障源：组装失败就当没注入，绝不让它阻断任务。
      console.error('[snapshot-inject] 组装失败（按不注入继续）：', e && e.message);
    }
  }

  // 产出型任务落地清单（deliverables 已在「任务注册表」前声明，供中断/续跑状态复用）
  // 【防嘴炮】标记：产出型任务收尾时若 deliverables 为空，是否已补过一轮强制提示（最多 1 次，防死循环）
  let antiMouthCannonFired = false;
// 收尾前自检只做一次（补不齐也要允许收尾把实情说出来，避免在这里死循环）
  let artifactVerifyDone = false;
  // 【截断收尾闸门】本轮回答被输出上限截断（finish_reason='length'）时只拦一次：
  // 必须让它接着说完/改用分次追加，**不许把半截回答当完整结论收尾**（用户会看到"话没说完就结束了"）。
  let truncatedTurnHandled = false;
  // 【半成品交付闸门】规范 §二明令禁止「已经完成，剩下 XXX 你可以自己处理」——这类话术**可以被文字检出**，
  // 既然能检出就不该只靠模型自觉。命中且不构成合法 BLOCKED 时，推一轮继续指令（只拦一次，防死循环）。
  let bailOutHandled = false;
  // 【证伪闸门】人设「二十一：先证伪自己的第一判断」此前零运行时强制。命中归因结论且没给反证/未验证声明时，
  // 推一轮纠正指令（与 bailOutHandled 同法：只拦一次，防与模型的固执互相死锁）。
  let falsifHandled = false;
  // 这些技能把「已生成 XXX：<绝对路径>」写进返回文本，需从结果里解析出路径供成果卡点击打开
  // ★ 2026-11-11 夜：这份字面量已**搬走**到 `intentGate.PRODUCER_SKILLS`（文件顶部 import）。
  //   搬的理由：授权门也必须在**同一份**集合上判，否则「成果卡点得开」与「归授权门管」两件事
  //   会各自漂移，而漂移的症状是静默的（门漏掉一个技能不报错，事故复盘时才发现）。
  //   原注释保留在此处以备追溯：
  //     演示文稿默认产出（单文件 HTML）；ppt-generate 保留以备「明确要 .pptx」。
  //     多轨精剪（Concat）产出 mp4 / 预览帧 png / 工程目录三条绝对路径，
  //     不登记的话成片在界面上点不开，用户只能自己去翻工作区。
  // 从技能返回文本里提取所有绝对路径（Windows 盘符路径 C:\... / D:\...，以及 / 或 \\ 开头）
  function extractPaths(text) {
    const s = String(text || '');
    const out = [];
    const seen = new Set();
    const re = /(?:[A-Za-z]:[\\\/][^\s"'<>|?*]+\.[A-Za-z0-9]{1,5})|(?:\/\/[^\s"'<>|?*]+)|(?:\/[^\s"'<>|?*]+\.[A-Za-z0-9]{1,5})/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      let p = m[0];
      // 去掉尾部可能粘着的标点/括号
      p = p.replace(/[),;，。；、]+$/, '');
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
    return out;
  }
  // 「真的动过手」的技能集合（2026-09-17）：写文件 / 跑命令 / 连服务器 / 查库。
  // 这些会产生**用户看不见的副作用**，收尾必须主动给结论（否则用户只能干瞪眼问「它真改了吗」）。
  const WRITE_TOOLS = new Set([
    'file-write', 'shell-exec', 'ssh-exec', 'deploy-static', 'deploy-node', 'db-query',
  ]);
  // 【验收动作】只在**已有交付物**之后执行才计入结果轴（见 noGoalProgress）。
  //   shell-exec / ssh-exec 是"对已有产物跑一次检查/操作"的主要形态；
  //   desktop-verify 是真启动桌面窗口、点击、等导出的一等验收动作（2026-02-16 加入）——
  //   复杂交付（exe / 桌面工具 / 游戏）以前只能靠 shell 拼命令，拿不到窗口级证据。
  //   file-write 不在此列：写脚本本身不是验收，跑起来才是。
  const VERIFY_TOOLS = new Set(['shell-exec', 'ssh-exec', 'browser-verify', 'desktop-verify']);
  // 【过程脚本判据】把「动手手段」和「交付物」分开（2026-09-17 新增）。
  // 背景：用户原话「导出的东西很多都是 py 格式的……让他改一下服务器的东西，他会生产很多 py，
  //   并没有告诉你结果是什么」。根因之一＝过程脚本被当成成果入卡（下详）。
  // 判据一：文件名以 `_` / `tmp_` / `temp_` 开头 —— 工作区里约定俗成的临时件命名。
  // 判据二：扩展名是**纯执行脚本**（.py/.sh/.bash/.bat/.cmd/.ps1）且用户这轮没要脚本/代码。
  //   `.js` 故意**不在**列表里：网页交付物常常就是 .js，误伤代价比漏放一条大
  //   （`_fix.js` 这类仍会被判据一拦住）。
  const PROC_SCRIPT_EXT_RE = /\.(py|sh|bash|bat|cmd|ps1)$/i;
  const TMP_NAME_RE = /^(?:_|tmp[_-]|temp[_-])/i;
  // ⚠️ `\bpy\b` 必须带边界：裸写 `py` 会匹配到 copy / happy 这类英文词，
  //    让「帮我 copy 到服务器」被误判成「用户要脚本」，.py 过程脚本就漏放了。
  const WANTS_SCRIPT_RE = /(脚本|代码|程序|\bpython\b|\bpy\b|批处理|shell|bash|命令行)/i;
  function isProcessScript(relPath, userText) {
    const base = String(relPath || '').split(/[\\/]/).pop() || '';
    if (!base) return false;
    if (TMP_NAME_RE.test(base)) return true;
    if (PROC_SCRIPT_EXT_RE.test(base) && !WANTS_SCRIPT_RE.test(String(userText || ''))) return true;
    return false;
  }
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ★★★【KI-001 · 2026-10-28】执行区间 → 契约产物：**落地期**的归属通道
   *
   * 要修的到底是什么（KI-001 的九条取证，读这里就够了，别再翻原来那段）：
   *   · `pptx-v1.regenKind` 对 shell-exec 明确返回 `'shell-exec:cmd(pptx+write)'`
   *     —— 引擎认这条路径会出片（复用闸门据此拦得住）；
   *   · 但 `PRODUCER_SKILLS` 不含 shell-exec、`deliverables.push` 全文件只有两处
   *     （file-write 分支 / PRODUCER_SKILLS 扫返回文本）、`markBuild` 只过滤**入参**；
   *   · 于是"模型写个 build_ppt.py，再 shell-exec 跑出 pptx"这条**合法**产出路径，
   *     在落地那一刻对归属链**结构性不可见**：`state.run.artifacts` 空、`build` 没标、
   *     `custody` 没进库，只能指望收尾的磁盘扫描兜底（而兜底还被 `priorBuild` 闸着，
   *     新任务一份都不认）⇒ 用户成果真在磁盘上，账本上却"没有产物"。
   *
   * 修法（三条硬边界，改这里之前先读完）：
   *   ① **不把 `shell-exec` 加进 `PRODUCER_SKILLS`**。那支是从**返回文本里扫绝对路径**，
   *      任何一条 `ls` / `dir` / 报错信息里的路径都会进成果卡 —— 那是比原缺陷更大的误判。
   *      本通道**一个字符都不解析命令文本或命令输出**，只认磁盘上"执行前后真的变了"。
   *   ② **不改 `regenKind` 的窄判据**。它的身份是"这次调用算不算重做产物"（拦重复劳动），
   *      不是"这次调用产生了哪些文件"。让同一个窄判据去当归属判据，等于逼它做两件事。
   *      两者**同源**在 `cfg.buildExts`：regenKind 判"像不像在出片"，本通道判"是不是真出了"。
   *   ③ **不是所有 shell-exec 都升级成可信生产者**：只有同时满足
   *      「本工作流声明了产物契约」+「执行区间内该扩展名文件出现或被改写」+
   *      「非 0 字节」+「pptx 能被产品解析器打开且页数>0」才认。跑 `npm install`、
   *      跑 `python --version`、`echo "已生成 x.pptx" > log.txt` 一律认不出东西来
   *      （前者不产契约文件；后者只产 .txt；最后一条连文件都没变）。
   *
   * 证据顺序（从硬到软）：前后快照差（出现 / 被就地改写）> 非 0 字节与可解析 > 内容指纹。
   *   **不看模型说了什么**：`res`（命令输出）只用来记 `toolOk`，不参与任何归属判定。
   *
   * 为什么快照要在这里做（而不是收尾统一扫）：验收标准第一条是"build 在**落地期**被标记，
   *   不依赖 conclude 的磁盘扫描"。落地期只有这一刻：命令刚返回、别的进程还没来得及动这个目录。
   */
  const EXEC_ARTIFACT_TOOLS = new Set(['shell-exec']);
  /**
   * 一次执行区间的"前"快照。**只能用一次**（consumed 后置空）：
   *   留着会被下一次 shell-exec 冒用，届时"前后差"的时间窗被拉长成两次调用，
   *   第一次命令产出的文件会被算到第二次头上。
   * ⚠️ 单槽变量是安全的**前提**是 shell-exec 不走并行：`PARALLEL_SAFE_TOOLS` 只有 web-fetch。
   *   新门禁对这条前提有定点断言（`unit-artifact-exec-bounds.mjs` 的 P2），别只信注释。
   */
  let pendingExecBounds = null;
  const execBoundsBegin = (nm) => {
    if (!EXEC_ARTIFACT_TOOLS.has(nm)) return null;
    const wfCfg0 = (wfCtl && wfCtl.cfg) ? wfCtl.cfg : null;
    const want0 = wfCfg0 ? workflowRunner.normalizeExts(wfCfg0.buildExts) : [];
    if (!want0.length) return null;   // 未声明产物契约 ⇒ 没有"可归属的产物类型"，不拍快照（零开销）
    const before = snapshotContractFiles(AGENT_WORKSPACE, want0);
    if (!before) return null;         // 工作区读不到 ⇒ 不归属（宁可不认，也不猜）
    return { at: Date.now(), before, want: want0, extLabel: want0.join('/') };
  };
  /**
   * ★ 在**每一个** `await runSkill(manifest, ...)` 之前调用一次（今天共三处：受控并行槽位 /
   *   需确认工具 / 普通技能）。
   * 为什么要一个统一入口，而不是三处各写一句 `pendingExecBounds = execBoundsBegin(name)`：
   *   那种写法对**非** shell-exec 的调用会把槽位写成 null —— 只要某条路径在 begin 与 claim
   *   之间插进了别的工具调用，已经拍好的前快照就被**清掉**，症状是"通道静默不生效、没有报错"。
   *   统一入口只在本工具命中时才动槽位。
   * ★ 漏接一处的代价同样是**静默漏归属**。本轮实测踩过：先只接了「需确认工具」分支，
   *   而实际执行走的是「普通技能」分支 ⇒ `claim tok=null`，整条通道一次都没跑，且不报任何错。
   *   新门禁对"三处都接上、且处数恰好是 3"有定点断言。
   */
  const armExecBounds = (nm) => {
    if (!EXEC_ARTIFACT_TOOLS.has(nm)) return;
    pendingExecBounds = execBoundsBegin(nm);
  };
  /**
   * 执行区间结束后的归属判定。**只判定、不记账**：
   *   `deliverables` / `markBuild` / `custodyKeep` 的写入留在 `trackDeliverable` 里，
   *   与 file-write 落地、产出技能扫描落地**同一处**（保管点就那三个，不许再多一个"空调"）。
   * @returns {{accepted:Array, inspections:object, appeared:string[], changed:string[], rejected:Array}|null}
   */
  const claimExecArtifacts = (prm, res) => {
    const tok = pendingExecBounds;
    pendingExecBounds = null;                 // 一次性：不许被下一次调用复用
    if (!tok) return null;
    const after = snapshotContractFiles(AGENT_WORKSPACE, tok.want);
    if (!after) return null;
    const wfCfg = (wfCtl && wfCtl.cfg) ? wfCtl.cfg : null;
    const extOk = (x) => tok.want.indexOf(workflowRunner.extOf(x)) >= 0;
    const accepted = [];
    const rejected = [];
    const appeared = [];
    const changed = [];
    const inspections = {};
    for (const [p, cur] of after) {
      const prev = tok.before.get(p);
      // ① 这次调用之前就在、而且大小与 mtime 一个字节都没动 ⇒ 不是本次产出的（反控核心）
      if (prev && prev.size === cur.size && prev.mtimeMs === cur.mtimeMs) continue;
      if (prev) changed.push(p); else appeared.push(p);
      /**
       * ⚠️ `startedAt` 传 0 是**有意的**，不是图省事：归属证据已经是"前后快照差"
       *   （文件在这次调用里出现/被改写），比"mtime 晚于 tok.at"更硬；而 mtime 在
       *   粗粒度文件系统上可能被向下取整到 tok.at 之前，再加一道时间门只会制造假阴性。
       */
      const v = judgeContractArtifact(p, { extOk, extLabel: tok.extLabel, startedAt: 0 });
      if (!v.ok) { rejected.push({ path: p, why: v.why }); continue; }
      if (v.info) inspections[p] = v.info;
      let fp = '';
      try { fp = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch { fp = ''; }
      accepted.push({ path: p, size: v.size, mtimeMs: v.mtimeMs, fp, how: prev ? 'changed' : 'appeared' });
    }
    if (!accepted.length && !rejected.length) return null;   // 这次命令没动任何契约文件 ⇒ 不吭声
    /**
     * 页数预算（KI-001 验收标准 c）：要么生效，要么**明确拒绝并留痕**。
     *   事实是：`withPageBudget` 只能往 `cfg.pageBudget.skill`（今天 = ppt-generate）的
     *   **入参**里塞参数，而 shell-exec 的入参只有 command / timeout_ms —— 根本没有可注入的槽位。
     *   所以这里不假装生效，把"为什么不可能"写进账：事后审计能一眼看出"这条路径的页数
     *   从来没有被契约约束过"，而不是以为它被约束了。
     */
    const pb = (wfCfg && wfCfg.pageBudget && typeof wfCfg.pageBudget === 'object') ? wfCfg.pageBudget : null;
    const pageBudget = pb ? {
      declared: { skill: String(pb.skill || ''), param: String(pb.param || '') },
      applied: false,
      why: '页数预算只能注入 cfg.pageBudget.skill（' + String(pb.skill || '未声明') + '）的入参；'
        + 'shell-exec 的入参只有 command / timeout_ms，没有可注入的槽位 ⇒ 明确不注入（不是静默跳过）。'
        + '产物页数由 validate / final_validate 单独核，不由本通道负责。',
    } : null;
    try {
      taskTrace.record(taskId, 'workflow', {
        phase: 'artifacts-from-exec',
        project: wfCfg ? wfCfg.workflowId : '',
        skill: 'shell-exec',
        // 真实工具调用参数（截断）：这是"归属来自哪一次调用"的第一手证据
        command: String((prm && (prm.command || prm.cmd)) || '').replace(/\s+/g, ' ').slice(0, 200),
        toolOk: !isFailureResult(res),
        contract: tok.extLabel,
        snapshot: { before: tok.before.size, after: after.size },
        appeared: appeared.slice(0, 5),
        changed: changed.slice(0, 5),
        accepted: accepted.slice(0, 5),
        rejected: rejected.slice(0, 10),
        pageBudget,
        why: accepted.length
          ? '执行区间前后快照差 + 产物契约 + 可解析校验 ⇒ 这些文件是本次命令真的落地的'
          : '执行区间内没有任何契约产物通过闸门 ⇒ 一份都不认（不凭"命令里提到了路径"认领）',
      });
    } catch { /* 旁路：记录失败不影响主流程 */ }
    return { accepted, inspections, appeared, changed, rejected };
  };

  const invalidateChangedProjectEvidence = () => {
    // 续接项目在本轮改写字节后，旧 hash 的通过记录立即失效；不能等下一次请求才发现。
    if (!project || !Array.isArray(project.currentArtifacts) || !project.currentArtifacts.length) return;
    const current = artifactsOf(deliverables.map((d) => d.path));
    const changed = project.currentArtifacts.filter((old) => {
      const hit = current.find((a) => a.path === old.path);
      return hit && (hit.sha1 !== old.sha1 || hit.size !== old.size);
    }).map((a) => a.path);
    if (changed.length) runtimeEvidence.invalidate({ paths: changed });
  };

  const trackDeliverable = (nm, prm, res) => {
    // file-write 此时已经写完真实字节：无论证据来自当前轮还是历史轮，被重写路径都必须重跑。
    // 不能只看 project.currentArtifacts；同轮新建项目在收尾前还没有持久化旧产物清单。
    if (nm === 'file-write' && prm && prm.path) {
      const written = path.isAbsolute(String(prm.path))
        ? String(prm.path) : path.resolve(AGENT_WORKSPACE, String(prm.path));
      runtimeEvidence.invalidate({ paths: [written] });
    }
    invalidateChangedProjectEvidence();
    // 三条工具执行路径都在这里汇合；同一本客观运行账同时服务 AI 审查与 general-v1。
    runtimeEvidence.recordToolResult({
      name: nm, params: prm, result: res,
      artifacts: deliverables.map((d) => d.path),
    });
    // ⑧ 记账「真的动过手」（2026-09-17）：这些技能会产生**用户看不见的副作用**（改了文件、
    //    跑了命令、动了服务器、改了库），收尾必须主动给结论。用户原话：
    //    「并没有告诉你结果是什么，他真的改了吗」——收尾强制结论的触发条件就是这里记的数。
    //    ⚠️ 必须记在 isFailureResult 之前：**失败也算动过手**（更要汇报「没改成 / 卡在哪」）。
    if (WRITE_TOOLS.has(nm)) taskEntry.wroteCount = (taskEntry.wroteCount || 0) + 1;
    // ★★ 2026-10-23 进度账本（②③维）：验收进度 + 问题解决进度。第④维（工程进度）在 file-write 分支取数，不在这里。
    //   ⚠️ 位置必须在 `isFailureResult(res)` 早退**之前** —— 失败的检查是"未解决问题"（维度③的开端），
    //      若放在早退之后，失败永远不会被记成问题，于是"问题从有到无"这条进度**永远算不出来**。
    //   ⚠️ 必须要求 deliverables.length > 0：没有交付物时的 shell-exec 属于"造轮子"，不是验收。
    //      这条前置正是为了**保留**原护栏（写一堆脚本但一件交付物都没落地 ⇒ 照旧判打转）。
    /**
     * ★★ 2026-10-26【残余耦合修复 · 点 1】`evCallsTotal` / `evReadingsTotal` **无条件**计。
     *
     * 修前这两个计数写在下面那个 `VERIFY_TOOLS.has(nm) && deliverables.length > 0` 守卫**里面**，
     * 于是"跑了 3 次 shell 检查、一个产物都没有"的研究任务，喂给通用验收的是 `{checks:0, evidence:0}`
     * —— 与"一次手都没动"的空聊**逐字相同**。实测（真 backend + 假上游，见
     * scripts/tmp-probe/_lead/coupling-fix/p1-evcalls.mjs）：
     *   真研究（2 次 shell-exec、有真读数、零产物）⇒ 修前 checks=0 ⇒ general_goal_evidence=not-applicable
     *   ⇒ taskKind=chat / level=generated-only / verdict=COMPLETE，与「零动作问答」的那一行完全一样。
     * 这就是必须修的：**"查了但没产物" 与 "根本没查" 不能得出同一个结论。**
     *
     * 改法：计数（以及它依赖的 `grade`）搬到守卫外 —— 只要调了 shell-exec / ssh-exec 就计一次，
     * 不论有没有交付物。**守卫本身一字不动**：`turnSnap.vf`、`newEv`/`evSeen`/`sig`、
     * `issueOpen` 与问题解决进度仍然只在"已有交付物之后"才动 —— 那些是**进度轴**，
     * 而 `evCallsTotal` 是**事实轴**（"这一轮到底检查了几次"），两者不是一件事。
     *
     * ⚠️ `gradeVerifyEvidence` 是纯函数，但这里**只调一次**：外面算好 `verifyGrade`，
     *   守卫内直接复用，绝不重复判一次"这段文字算不算证据"（那就是第二套判据）。
     * ⚠️ 已知且**预期**的副作用：`{checks>0, evidence:0}` 会把 `general_goal_evidence` 判成
     *   `unverified`（must）⇒ verdict 从 COMPLETE 变 PARTIAL。这是**变严**，方向正确
     *   （老板明确禁止的是"为取绿而放松"，变严不在此列）。
     */
    const isVerifyCall = VERIFY_TOOLS.has(nm);
    const verifyCmd = isVerifyCall
      ? String((prm && (prm.command || prm.cmd || prm.script)) || '').replace(/\s+/g, ' ').trim()
      : '';
    const verifyFailed = isVerifyCall ? isFailureResult(res) : false;
    const verifyChecks = isVerifyCall
      ? ((wfCtl && typeof wfCtl.checks === 'function') ? wfCtl.checks() : [])
      : [];
    const verifyGrade = isVerifyCall ? gradeVerifyEvidence(res, verifyChecks) : null;
    const verifyInformative = isVerifyCall && !verifyFailed && verifyGrade.isEvidence === true;
    // ⚠️ 已知缺口（本轮不修，明面记账，不许静默）：`checks` 已在守卫外计，但下面那个
    //   `taskTrace.record(taskId, 'verify', …)` 仍在 `deliverables.length > 0` 守卫内
    //   ⇒ 零产物任务的检查次数**有账无痕**：报告说"3 次检查类调用"，事后 trace 里
    //   一条 `kind==='verify'` 都查不到，无法核对是哪 3 条命令。实测（p1-evcalls.mjs）：
    //   修后 t2/t5（零产物）的 verify 事件数 = 0，而 t3=1 / t4=2（有交付物）。
    //   补齐需要把 `record` 也搬出守卫，但 `record` 里的 `fresh` 依赖 `evSeen`（进度轴状态），
    //   搬出去就得给 `fresh` 编一个假值或省略字段 ⇒ **trace 记录形状会变**，消费方要跟着改。
    //   ⇒ 列为下一轮独立改造，不在本次收尾范围（不许用"给 fresh 传 true"这种假值糊过去）。
    if (isVerifyCall) {
      evCallsTotal += 1;
      if (verifyInformative) evReadingsTotal += 1;
    }
    if (isVerifyCall && deliverables.length > 0) {
      turnSnap.vf = (turnSnap.vf || 0) + 1;
      const cmd = verifyCmd;
      const key = nm + '\u0000' + cmd;                  // 检查对象：同一条命令 = 同一次检查动作
      const failed = verifyFailed;
      // ★★ 2026-10-23（老板第 2 条建议的落地）：验收证据的判据交给 evidenceQuality 的**唯一**一份实现。
      //   上一版这里是 `isInformativeResult(res)`，而它的身份是 `命令 + 结果指纹` —— 实测漏得很彻底：
      //   每轮只换脚本名（check1.py / check2.py …）、结果都返回「全部检查通过：3 项」，
      //   6 轮全部 informative=true / fresh=true ⇒ 永不判打转。这正是老板说的
      //   「Agent 可以不断写新脚本、重复运行相同检查，即使验收结果完全没有变化」。
      //   现在身份改成「**它报告了什么**」（读数集 + 命中的验收项），命令与脚本名**完全不参与**。
      //   ⚠️ 标准**必须**从工作流控制器取，不许从 `cfg` 取：`cfg` 是网关配置（defaultConfig），
      //      没有 requiredChecks ⇒ 传空数组 ⇒ 全都判"没对准" ⇒ 真验收被误杀成打转。
      //      没工作流时（非 PPT 任务）走 `no-checks-lenient`：有读数就算有信息，纯表态仍不算。
      //   ★ 2026-10-26：`verifyChecks` / `verifyGrade` / `verifyInformative` 已在守卫外算好
      //      （口径一模一样，只是提前算），这里**复用**，不再调用第二次。
      const wfChecks = verifyChecks;
      const grade = verifyGrade;
      const informative = verifyInformative;
      // ★ 2026-10-26：通用验收要的两项累计读数**已移到守卫外**（见上），这里不再累加。
      const sig = grade.signature;
      const fresh = informative && !evSeen.has(sig);
      if (fresh) {
        evSeen.add(sig);
        turnSnap.newEv = turnSnap.newEv + 1;
        // ★ 强/弱证据分开记账（2026-10-23）：
        //   `strict`（有工作流标准，读数对得上验收项）= 强证据；
        //   `no-checks-lenient`（无标准，有读数就算）= 弱证据。
        //   两者都算进展（没有标准时误杀比漏放更糟），但**必须能分辨** ——
        //   否则事后无法回答"这次进展里有多少其实是宽判来的"，也就无法判断判据是否在退化。
        if (grade.mode !== 'strict') turnSnap.newEvWeak = (turnSnap.newEvWeak || 0) + 1;
      }
      // 问题解决进度也按**检查对象**记，但只有"真证据"的成败才算数：
      //   一条纯表态既不能开问题（它没证明有问题），也不能关问题（它没证明修好了）。
      if (grade.isEvidence) {
        if (failed) issueOpen.add(key);
        else if (issueOpen.has(key)) { issueOpen.delete(key); turnSnap.issClosed = turnSnap.issClosed + 1; }
      }
      turnSnap.issOpen = issueOpen.size;
      // 「必须记录检查对象、实际结果和证据」——落在 trace 里（独立文件，不撑爆 tasks.json）。
      //   secret 等敏感参数由 taskTrace 的键名兜底脱敏；这里只记命令摘要与结果指纹/长度。
      //   ★ 新增 grade/topics：判据的**输入**也要留痕，否则事后无法复核"为什么这次不算证据"。
      //   ⚠️ 已知缺口（与上面 `evCallsTotal` 处同一件事）：这条 record 仍在
      //      `deliverables.length > 0` 守卫内，而计数已在守卫外 ⇒ 零产物任务的
      //      "检查了几次" 有账无痕。搬出去需先解掉 `fresh` 对 `evSeen` 的依赖（进度轴），
      //      本轮不动（原因见上）。
      try {
        taskTrace.record(taskId, 'verify', {
          turn: taskEntry.turn, skill: nm, check: cmd.slice(0, 160),
          ok: !failed, informative, fresh, digest: digestOf(String(res == null ? '' : res)),
          resultLen: String(res == null ? '' : res).length, issuesOpen: issueOpen.size,
          grade: grade.grade, topics: grade.topics, evSig: sig, evWhy: grade.why.slice(0, 200),
          // ★ mode 必须留痕：`strict`（有工作流标准，要求对准验收项）与
          //   `no-checks-lenient`（没有标准，有读数就算）是两种严格度，事后必须能分开审。
          evMode: grade.mode, checksCount: wfChecks.length,
        });
      } catch { /* 取证是旁路，不影响主流程 */ }
    }
    /**
     * ══【KI-001 · 2026-10-28】执行区间产物的**登记点** ══════════════════════════
     *
     * 位置三条，都不是随手放的：
     *   ① 在 `isVerifyCall && deliverables.length > 0` 那段**之后**：
     *      那段会数 `turnSnap.vf` / `newEv`（验收进度）。若先把本命令刚产出的文件塞进
     *      `deliverables`，`deliverables.length > 0` 立刻成立 ⇒ **产出者被记成验收者**，
     *      同一个动作既算"产出"又算"验收了一次"。顺序反了不会报错，只会让进度轴虚高。
     *   ② 在 `if (isFailureResult(res)) return;` **之前**：命令返回非 0 但文件已经落地，
     *      文件是真的（闸门还会验能不能打开、页数）。把它丢掉才是"凭文案判产物"。
     *      `toolOk` 照样记进 trace（`toolOk:false`），失败不被掩盖。
     *   ③ `custodyKeep` 必须落在 `trackDeliverable` 函数体内（`unit-custody-wiring` C1-f 钉着）：
     *      保管点只有"真落地那一刻"这一处语义，不是另开一个空调。
     */
    if (EXEC_ARTIFACT_TOOLS.has(nm)) {
      const claim = claimExecArtifacts(prm, res);
      if (claim && claim.accepted.length) {
        for (const c of claim.accepted) {
          if (deliverables.some((d) => d.path === c.path)) continue;
          deliverables.push({ name: cleanName(path.basename(c.path)), path: c.path });
          // 落地期标 build：证据来自**这次命令执行前后工作区快照的差**，不是收尾扫描。
          // 传 inspections 让阶段账本里连页数一起留下（"能打开 / 几页"是 markBuild 证据的一部分）。
          if (wfCtl) { try { wfCtl.markBuild([c.path], claim.inspections); } catch { /* 增益功能，不影响主流程 */ } }
          custodyKeep(c.path, 'landing-hook', taskId);
        }
      }
    }
    invalidateChangedProjectEvidence();
    // ⑥ 失败结果不成果卡：用单一判据（覆盖中英文失败前缀），不再只认 startsWith('error')
    if (isFailureResult(res)) return;
    if (nm === 'file-write' && prm && prm.path) {
      // ★★【进度轴先取数，显示闸后过滤】—— 顺序是这条修复的核心，别调换。
      //   ① 进度轴（第 ④ 维 codeNew/codeUpd）：只要**不是过程脚本**，就记"文件真落地/真变了"。
      //      它不过 isRealArtifact —— 因为 isRealArtifact 的口径是"给用户看什么"，
      //      拿它兼进度判断会把整类代码工程任务（.gd/.tscn/.godot/.vue/.ts/.go/…）判成没干活。
      //      实测依据见 codeHash 上方注释（task_mwa5k33u_rkysqp：9 次写入只有 icon.svg 算数）。
      //   ② 显示轴（isProcessScript + isRealArtifact）：口径一字不改，仍然宁漏勿滥。
      //   为什么不能把 ① 塞进 ② 里面：② 是 return 型闸门，进去了就没有"外面"了。
      //   为什么不能共用一个 hash 表：共用会让显示轴的过滤顺着 map 漏进进度轴 —— 正是本次缺陷。
      // >>> STUCK_AXIS_SPLIT_BEGIN
      //   标记之间的代码是「进度轴取数」块。`unit-stuck-axis-split.mjs` 按这对标记切出**真实源码**
      //   在内存里跑（不抄副本）；挪出 file-write 分支或被显示闸包住 ⇒ 门禁必红。
      {
        const pProg = path.resolve(AGENT_WORKSPACE, String(prm.path)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
        // 过程脚本不算工程进度：否则「反复写 _probe.py / _check.py」就成了永不判 stuck 的免死金牌
        //   （那正是老板 2026-10-23 第 1 条要堵的漏洞）。isProcessScript 只认"临时命名 + 纯执行脚本
        //   且用户没要脚本"，不认 .gd/.tscn/.vue 这类工程源码 ⇒ 正好是需要的宽窄。
        if (pProg && !isProcessScript(prm.path, lastUserText)) {
          const body = prm && prm.content != null ? String(prm.content) : String(res == null ? '' : res);
          const h = digestOf(body);
          const prevC = codeHash.get(pProg);
          if (prevC === undefined) { codeHash.set(pProg, h); turnSnap.codeNew = (turnSnap.codeNew || 0) + 1; }
          // 同内容重写不记（与 artUpd 同一条语义）：重复操作不算进展。
          else if (prevC !== h) { codeHash.set(pProg, h); turnSnap.codeUpd = (turnSnap.codeUpd || 0) + 1; }
        }
      }
      // <<< STUCK_AXIS_SPLIT_END
      // ⑦ 过程脚本不是交付物（2026-09-17）：把 `_probe.py` 这类中途写的一次性脚本塞进成果卡，
      //    会把真正的成果挤掉 —— 实测用户本地 deliverables.json **40 条里 33 条是过程脚本**
      //    （`_probe.py`×7 / `_patch.py` / `_check.py` / `_syntax.py` / `_fix.js` / `_show.js` /
      //     `_tmp_resize720.py` / `gen_cds2026_v3.py` / `pdf_to_word.py` …），
      //    而成果卡首屏**只展示 2 条**（App.jsx 的 items.slice(0, 2)）⇒ 用户看到的「成果」
      //    几乎全是脚本，真正的 index.html 被挤到折叠区里 ⇒ 这就是
      //    「生成一堆 py、也没告诉我结果」的成因之一。
      if (isProcessScript(prm.path, lastUserText)) return;
      // 【真交付物判据 2026-10-21】上面那条只认 `.py/.sh/.bash/.bat/.cmd/.ps1`，**不含 .js**
      // ⇒ 实测台账 72 条里 js 20 条 + py 21 条（57%）全是过程脚本，成果卡里堆着
      //   check_deck.js / serve_deck.js / cp_assets.js / patch_hash.js。用户原话：
      //   「输出的文件夹 只显示你要的那个就行了 别的不用告诉你」。
      // 统一改走 deliveryProtocol.isRealArtifact（产物类扩展名算真交付物；脚本类只在用户
      // 明确要脚本时才算；带 check_/gen_/serve_/cp_/patch_/_tmp_ 过程前缀一律不算）。
      // ⚠️ 上面那次 isProcessScript 调用**保留**：它的 TMP_NAME_RE 仍有独立价值（`_x.html` 也得拦）。
      if (!isRealArtifact(prm.path, lastUserText)) return;
      // 仅清控制字符（乱码来源），保留路径分隔符，保证绝对路径仍可打开
      const p = path.resolve(AGENT_WORKSPACE, String(prm.path)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
      // ★★ 2026-10-23 进度账本 ①产物进度：区分"有效更新"与"又写了一遍同样的内容"。
      //   老板的原话是「已有产物发生有效更新」才算产物进度 —— 内容一模一样再写一遍不是进展。
      //   指纹取 prm.content（file-write 的正文）；拿不到正文时退回结果文本指纹。
      // ⚠️ 这张表只管**交付物**（已过 isRealArtifact）。同一个文件若又被第 ④ 维记了一次，
      //   两个计数器会同时涨 —— 不冲突：`progressed` 是布尔或，不会因此把"进展"算成两份；
      //   而事后看 trace 时，"artUpd 涨了但 codeUpd 也涨了"正好说明它既是交付物也是工程文件。
      {
        const body = prm && prm.content != null ? String(prm.content) : String(res == null ? '' : res);
        const h = digestOf(body);
        const prev = artHash.get(p);
        if (prev === undefined) artHash.set(p, h);            // 首次落地：由 arts 增长天然覆盖
        else if (prev !== h) { artHash.set(p, h); turnSnap.artUpd = (turnSnap.artUpd || 0) + 1; }
        // prev === h ⇒ 同内容重写：不记任何进度（正是"重复操作不算进展"那一条）
      }
      // ★★【成果卡去重】这一处是全文件唯一**没有去重守卫**的 deliverables.push
      //   （其余几处都写了 `some((d) => d.path === p)`）。后果：同一文件写两次 = 两张一样的卡。
      //   实测形态：先落盘、再改一行 ⇒ 成果卡上并排两张「文案.md」。
      //   ⚠️ 去重只挡**重复登记**，不挡进度记账：上面的 artHash/artUpd 与 codeHash/codeUpd
      //      都在这一行之前算完了（"又改了一遍"该记的进展一条不少）。
      if (!deliverables.some((d) => d && d.path === p)) {
        deliverables.push({ name: cleanName(String(prm.path)), path: p });
      }
      invalidateChangedProjectEvidence();
      // 【任务类型工作流 · 调用点②：产物落地】真有 .pptx 落地才允许标 build。
      // 证据只是"文件生成出来了"，"能不能打开 / 页数对不对"留给 validate —— 两件事分开记，
      // 才不会出现「build 打勾了但其实文件是坏的」这种自欺。
      if (wfCtl) { try { wfCtl.markBuild([p]); } catch { /* 增益功能，不影响主流程 */ } }
      // 保管点②：真实落地。**故意不接进 markBuild 内部**（老板 D 条件②）：
      //   markBuild 是"证据判定"（能不能打开/页数对不对），保管是"把字节留下来"，
      //   两件事的成功条件不同 —— 判定通过的文件也可能没进过库，反过来也一样。
      custodyKeep(p, 'landing-hook', taskId);
      return;
    }
    if (PRODUCER_SKILLS.has(nm)) {
      for (const raw of extractPaths(res)) {
        const p = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        // 【真交付物判据 2026-10-21】技能返回文本里扫出来的路径同样要过闸：
        // 产出类技能的中途脚本（serve_deck.js 之类）不该冒充成果。用 continue 而不是 return，
        // 因为这一条路径是**批量**扫描，一条不合格不该丢掉同批的 index.html。
        if (!isRealArtifact(p, lastUserText)) continue;
        if (!deliverables.some((d) => d.path === p)) {
          deliverables.push({ name: cleanName(path.basename(p)), path: p });
          if (wfCtl) { try { wfCtl.markBuild([p]); } catch { /* 增益功能，不影响主流程 */ } }
          // 保管点②（技能扫描这支）：同 `file-write` 落地，只是路径来自技能返回文本。
          //   `extractPaths` 只匹配绝对路径，所以这里的 p 与上支一样是绝对路径。
          custodyKeep(p, 'landing-hook', taskId);
        }
      }
    }
    invalidateChangedProjectEvidence();
  };
  /**
   * 成果卡最终下发口径（2026-10-21）：卡里只放**真交付物**。
   * 兜底铁律：过滤后为空数组 ⇒ 退回原数组。
   *   为什么必须有这条退路：用户真的要「写个 node 服务」时，产物全是 .js，
   *   isRealArtifact 在这个语境下会因为「名字带过程前缀」或判据本身把条目滤光 ——
   *   卡被滤成空 ⇒ 用户什么都看不到，比看到一堆 js 更糟。宁可退化成旧行为，也不许给空白卡。
   * ⚠️ 只影响**下发**口径；本地台账（appendDeliverables）与产物复验（verifyDeliverables）
   *   仍然用完整 deliverables —— 取证要全，展示要干净，两者不能混。
   */
  const deliverablesForUser = () => {
    if (!deliverables.length) return [];
    // ★ 去重放在**下发口径**这一处（而不是只靠记账时的守卫）：
    //   ① 记账守卫只能防"以后不再重复登记"；已经重复的（历史 project 账、技能扫描与
    //      file-write 各登记一次、大小写/斜杠写法不同）它管不了。
    //   ② 这一处是**用户真正看到卡的地方**，所以"看到两张一样的卡"必须在这里就断掉。
    //   归一键见 deliveryProtocol.artifactPathKey（win 折大小写、其余平台不折）。
    const shown = dedupeArtifacts(deliverables.filter((d) => isRealArtifact(d && d.path, lastUserText)));
    if (shown.length) return shown;
    // 兜底铁律不许变：过滤后为空 ⇒ 退回（去重后的）原数组，绝不给空白卡。
    return dedupeArtifacts(deliverables);
  };

  // ===== 统一工具调用协议（参数体检 → 执行 → 失败归因 → 记账 → 连续失败升级换方案）=====
  // 每个任务一份失败账本：同一签名（技能名 + 参数形状）反复失败 = 模型在原地打转的**客观证据**。
  // 规矩：同一种方法最多重试 1 次，第二次仍失败就必须换工具/换方案（不许无限原地重试）。
  const toolLedger = createRetryLedger();
  // ★ 跨请求记忆（2026-10-23 老板第 5/8 条：「持久化的不只是第几步，还有尝试过的方法和失败原因」）。
  //   修之前 `strategyCount` 只活在内存 Map（toolProtocol 的 byStrategy），而这里每次 runAgentLoop
  //   都新建一份 ⇒ 「同一种方法失败 2 次就必须换路」这条**执法每重启一次就归零**：
  //       失败→失败→拦住（这次生效）｜进程重启｜失败→失败→拦住（又"第一次"生效）
  //   症状极具欺骗性：每次都拦得住，看起来完全正常；而真正跨请求的那句"这个坑上次就踩过"
  //   从来没发生过 —— 模型每次都像第一次接触这个问题。
  //   宽容语义见 toolProtocol.seed 的纪律②：count-1 再落账（环境可能已变，**只宽容一次**）。
  // 观测点：`seed` 的读数落进 trace 的 `recover-ledger` 事件（在门禁里可断言"真的预热了 N 条"）。
  // 刻意**不留**一个没人读的中间变量 —— 「算出来了但没人用」在本仓是明确的历史事故类型。
  (() => {
    try {
      const arr = (wfCtl && typeof wfCtl.attempts === 'function') ? wfCtl.attempts() : [];
      if (!arr.length) return { seeded: 0, skipped: 0, stale: 0 };
      const r = toolLedger.seed(arr);
      try {
        taskTrace.record(taskId, 'recover-ledger', {
          seeded: r.seeded, skipped: r.skipped, onDisk: arr.length,
          /**
           * ★ 2026-02-16：`stale` 必须进 trace（老板裁决的边界 #1）。
           *   它回答的是"这一次有几条旧禁令因为**代码变了**而自动失效" —— 这条读数如果只在内存里，
           *   事后审计在时间线上就完全看不见"这次为什么突然不再跳过某个方法了"，
           *   而那正是本次机制存在的意义（旧禁令不许无条件生效）。
           *   三态各自独立落一个数：`seeded`（这次用了多少旧账）/ `skipped`（没恢复的）/
           *   `stale`（判成"需重试"的 refuted）—— 不许把 stale 折进任何一边。
           */
          stale: Number(r.stale) || 0,
          sigs: arr.map((a) => String((a && a.sig) || '')).slice(0, 20),
        });
      } catch { /* 旁路：记录失败不影响任务 */ }
      if (r.seeded || r.stale) {
        console.log('[recover] 跨请求失败账本预热：恢复 ' + r.seeded + ' 条 / 放弃 ' + r.skipped
          + ' 条 / 旧禁令失效 ' + (Number(r.stale) || 0) + ' 条（磁盘上 ' + arr.length + ' 条）');
      }
      return r;
    } catch (e) {
      // 预热是增益，不是单点故障源：坏了就当没有上次的账，绝不阻断任务。
      console.error('[recover] 失败账本预热异常（按无记忆继续）：', e && e.message);
      return { seeded: 0, skipped: 0, stale: 0 };
    }
  })();
  /**
   * ══【通用任务的跨请求失败账本 · 2026-11-09】════════════════════════════════
   *
   * 老板原话：「让他修复或者重做，他会犯一模一样的错误。」
   *
   * 【为什么上面那段预热对他没用】
   *   上面那段 `wfCtl.attempts()` 是**唯一**的数据源，而 `wfCtl` 只在命中工作流时存在
   *   （非 PPT 任务为 null，见本文件 startWorkflowRun 调用点）。他说的"修复 / 重做"
   *   是改 bug、改界面这类通用任务 ⇒ 走的是 wfCtl===null 那一路
   *   ⇒ `arr=[]` ⇒ 预热 0 条 ⇒ 交接单不出（reason:'no-prev'）
   *   ⇒ `planRecoveryGate` 眼里"这是第一次用这个办法" ⇒ 放行
   *   ⇒ 模型照着上次的坑原样再踩一遍，而所有闸都显示正常。
   *   机制不缺，缺的是给通用任务接一根管子。
   *
   * 【为什么账本按"会话"分文件，不按 taskId】
   *   `taskId` 每个任务都是新的（`genId('task')`），用它当键等于每个任务一本独立账
   *   ⇒ 永远读不到上一次，和"不接"是同一个结果。
   *   "重做"发生在同一个会话里 ⇒ `threadId`（缺则 `projectId`）才是"上一次"的身份。
   *   两者都拿不到 ⇒ **不落盘**（约束①：宁可少记，不许把 A 项目的失败记到 B 项目头上）。
   *
   * 【为什么工作流任务不给它建】
   *   `wfCtl.attempts()` 已经在记同一件事，两边都记就是记两份，
   *   而两份账的 count 会各自累加 ⇒ 拦截阈值提前触发，用户看到"莫名其妙不让用"。
   */
  const repeatLedger = wfCtl ? null : (() => {
    try {
      const sk = repeatLedgerMod.sessionKeyOf(payload, ownerKeyOf(payload));
      return repeatLedgerMod.createRepeatLedger({
        dir: repeatLedgerMod.dirOf(tasksPath),
        key: sk.key,
        reason: sk.reason,
      });
    } catch (e) {
      // 账本是增益，不是单点故障源：建不起来就当没有上次的账，绝不阻断任务。
      console.error('[repeat] 账本创建失败（按无记忆继续）：', e && e.message);
      return null;
    }
  })();
  // 预热：与上面那段**同一套语义**（`seed` 的 count-1 只宽容一次），只是换了个数据源。
  // 刻意不合并成一段循环：两段的观测字段与失败语义不同，合并会让 trace 里的来源变模糊
  // （而「这次到底是工作流的账还是通用账」正是事后要判的第一件事）。
  (() => {
    if (!repeatLedger) {
      try { taskTrace.record(taskId, 'recover-ledger', { source: 'wf', seeded: 0, skipped: 0, stale: 0 }); } catch { /* 旁路 */ }
      return { seeded: 0, skipped: 0, stale: 0 };
    }
    if (!repeatLedger.available) {
      // 拿不到会话身份 ⇒ 明确记下"为什么这次没有跨运行记忆"，不许静默当没这回事。
      try {
        taskTrace.record(taskId, 'recover-ledger', {
          source: 'repeat', seeded: 0, skipped: 0, stale: 0, why: repeatLedger.why,
        });
      } catch { /* 旁路 */ }
      return { seeded: 0, skipped: 0, stale: 0 };
    }
    try {
      const arr = repeatLedger.attempts();
      if (!arr.length) {
        try {
          taskTrace.record(taskId, 'recover-ledger', {
            source: 'repeat', seeded: 0, skipped: 0, stale: 0, onDisk: 0,
          });
        } catch { /* 旁路 */ }
        return { seeded: 0, skipped: 0, stale: 0 };
      }
      const r = toolLedger.seed(arr);
      try {
        taskTrace.record(taskId, 'recover-ledger', {
          source: 'repeat', seeded: r.seeded, skipped: r.skipped, stale: Number(r.stale) || 0,
          onDisk: arr.length, repeated: repeatLedger.summary().repeated,
          sigs: arr.map((a) => String((a && a.sig) || '')).slice(0, 20),
        });
      } catch { /* 旁路：记录失败不影响任务 */ }
      if (r.seeded || r.stale) {
        console.log('[repeat] 通用任务失败账本预热：恢复 ' + r.seeded + ' 条 / 放弃 ' + r.skipped
          + ' 条 / 旧禁令失效 ' + (Number(r.stale) || 0) + ' 条（磁盘上 ' + arr.length + ' 条）');
      }
      return r;
    } catch (e) {
      console.error('[repeat] 账本预热异常（按无记忆继续）：', e && e.message);
      return { seeded: 0, skipped: 0, stale: 0 };
    }
  })();
  /**
   * ══════════════════════════════════════════════════════════════════════════
   * 【交接单 · 2026-11-03】P3 第一层：换手的时候，接手的人该看到哪一页纸
   *
   * 老板原话：「尤其是替补 Agent：它必须知道前任尝试过什么、为什么失败、哪些办法不能再用。
   *   不能接手后把前任失败的步骤再重复一遍。」以及「如果几个 Agent 使用相同模型、相同上下文、
   *   相同判断方式，它们可能只是集体犯同一个错误。」
   *
   * 【为什么不先造第二个执行者】全仓查证（2026-11-03）：`highRiskParallel` 从用户答案一路
   *   存进工单偏好、并在工单上印成「并行模式：开启（双方案对比）」，**零个消费者** ——
   *   第二个执行者根本不存在，只是纸上印着一行字。而"择优"最终仍由同一个模型判 ⇒
   *   正是老板担心的"集体犯同一个错"。所以先做**不需要第二个进程就能生效**的那一半：
   *   让接手的那次运行看到的信息不一样。同一模型拿到不同的信息集，也会走出不同的路。
   *
   * 【为什么这里算真交接，不是自己跟自己说话的假功能】
   *   `wfCtl.attempts()` 来自磁盘上的 workflows 状态，是**上一次运行**落下的账；
   *   而本段只在"接手者上下文里没有那些失败过程"时才说话（见下方 hasToolHistory）。
   *   两条同时成立时，"上任"就是字面意义的上一次执行。
   *   反过来：本次运行**内**的反复失败由 `breakerDirective` 负责（它掌握的信息更全：
   *   同一段对话里模型已经看过自己的失败原文），这里绝不插手，否则是往已知信息里兑水。
   *
   * 不做三件事（与 snapshot 注入同一纪律）：不参与判据（没有任何代码读这段文本做判断）、
   * 不写判决、不补推测值 —— 拿不到的字段宁可整行不写。
   */
  (() => {
    try {
      const prevStrats = (typeof toolLedger.seededList === 'function') ? toolLedger.seededList() : [];
      if (!prevStrats.length) return;
      // ★ 分拣与措辞全部交给 `buildHandoffFromSeeded`（纯函数，门禁可单独跑、可单独变异）。
      //   backend 这里只负责三件它才会做的事：读账本、往对话里放、落 trace。
      //   为什么不在本文件里拼 strategies 数组：这段代码在 runAgentLoop 闭包里，
      //   单测整装启动不了 ⇒ "字段口径有没有接错"永远钉不住（`highRiskParallel` 零消费者就是这么来的）。
      const built = buildHandoffFromSeeded({
        seeded: prevStrats,
        // 语义判据：接手者上下文里已有工具调用 ⇒ 那些失败过程它看得见，不许当"上任"再念一遍。
        hasToolHistory: conversation.some((m) => m && m.role === 'tool'),
        actionsAll: Object.keys(RECOVERY_ACTION_LABEL),
        actionLabel: RECOVERY_ACTION_LABEL,
        kindLabel,
        // kind→动作 的唯一真源在 toolProtocol；这里只转发，绝不在本文件养第二张表。
        actionOf: (k) => recoveryStrategyFor({ kind: k }).action,
        trigger: '这是一次**续跑**：上一次运行没走完，下面是它留下的失败账（不是你这一轮做错的）。',
      });
      const brief = built.brief;
      // 没有交接必要（只偶发失败一次、也未被证伪）⇒ 一个字都不加。
      // 老板批过长篇大论；没有实质信息的一段 system 只会稀释真正的指令。
      if (!brief || !brief.text) {
        try {
          taskTrace.record(taskId, 'handoff', {
            phase: 'skip', prev: prevStrats.length, reason: built.reason,
          });
        } catch { /* 旁路 */ }
        return;
      }
      // ★ 注入的 content 必须是**具名函数调用的返回值**，不能是 `brief.text` 这种随手取字段。
      //   理由不是洁癖：`unit-asset-registry` 的 R6d/R6e 棘轮把"注入点数"钉住，它的前提是
      //   「这些注入的 content 全是具名常量或具名函数 ⇒ 没有一处是按角色编号查表选出来的」。
      //   一旦允许 `obj.text` 这种形态，那道反向证明的前提就松了（虽然 R6f 仍会查查表，
      //   但"具名"这一层可读性会丢）。所以走一个具名函数，值是同一份。
      conversation.push({ role: 'system', content: handoffBriefText(brief) });

      try {
        taskTrace.record(taskId, 'handoff', {
          phase: 'inject',
          prev: prevStrats.length,
          forbidden: brief.forbidden.map((f) => f.tool),
          tried: brief.tried.map((t) => ({ tool: t.tool, count: t.count, lastKind: t.lastKind })),
          notTried: brief.notTried,
          usedActions: built.usedActions,
          chars: brief.text.length,
          // 记全文而不是只记长度 —— 事后要能逐字核对接手者到底看到了什么。
          inject: brief.text,
        });
      } catch { /* 旁路：记录失败不影响任务 */ }
      console.log('[handoff] 交接单已注入：禁令 ' + brief.forbidden.length
        + ' 条 / 试过 ' + brief.tried.length + ' 条 / 未试方向 ' + brief.notTried.length + ' 个');
    } catch (e) {
      // 注入是增益，不是单点故障源：组装失败就当没有上次的账，绝不阻断任务。
      console.error('[handoff] 交接单组装失败（按不注入继续）：', e && e.message);
    }
  })();

  // ★ 工具级熔断（2026-09-23）：账本只**记录**"在原地打转"，从不阻止下一次调用 ——
  //   于是"浏览器失败 → 再启动一次 → 再失败 → 再启动"会把任务预算烧穿。熔断器才是**执法**那一层：
  //   同一工具连续失败 2 次即关闭它，并强制给出降级链的下一层（见 breakerDirective）。
  const toolBreaker = createToolBreaker();
  // 熔断拦截的可见记账（与 skippedGates 同源，只为让用户/事后审计看得见"哪一步被省掉了"）
  const recordBreaker = (name, trip) => {
    try { (taskEntry.skippedGates = taskEntry.skippedGates || []).push({ gate: '工具熔断', skill: name, target: '连续失败 ' + trip.count + ' 次' }); } catch { /* ignore */ }
    if (taskEntry.skippedGates && taskEntry.skippedGates.length > 30) taskEntry.skippedGates = taskEntry.skippedGates.slice(-30);
  };

  // ===== 恢复执行器（2026-10-05 老板拍板）：把「同策略已耗尽」从**文案**提升为**执法** =====
  // 同源缺口（上一轮收口时已量出）：sameStrategy / strategyCount / escalate 早就算出来了，
  // 却只喂进 recoveryDirective 的**文案** —— 零 if 分支。下面这个 if 才是"拦"。
  // 纪律与工具熔断器**完全一致**：位置在**所有执行分支之前**，动作是 `continue` 而不是打日志。
  const recoveryExecutor = createRecoveryExecutor({ maxSameMethod: 2 });
  const recoveryLog = [];        // 每次恢复动作一条 {action, result, evidence, reverification?}
  let reverifyPending = false;   // 有恢复动作已下发、还没拿到复验读数
  let recoveryVerified = true;   // 没有恢复动作时恒 true ⇒ 正常路径完全不受影响
  const planRecoveryGate = (name, params) => {
    // ★ 跨请求记忆（2026-10-23）：这条策略是不是**上一次运行**就坏过的？
    //   只有拦住它的时候才知道"上次为什么坏"，否则模型会把它当成"这次运气不好"，
    //   换个说法再试一遍 —— 重启一次就白记一次，失败账本等于没落盘。
    //   seededOf 只认 seed() 灌进来的账（非空即"来自上一次运行"），本次运行内的失败不算。
    let seeded = null;
    try { seeded = toolLedger.seededOf(name, params) || null; } catch { seeded = null; }
    return recoveryExecutor.plan({
      name, params,
      strategyCount: toolLedger.strategyCountOf(name, params),
      lastKind: toolLedger.lastKindOfStrategy(name, params),
      // 逐字级没失败过（说明参数值变了）但策略级失败过 ⇒ 换汤不换药
      sameStrategy: toolLedger.countOf(name, params) === 0 && toolLedger.strategyCountOf(name, params) > 0,
      seeded: !!seeded,
      seededRefuted: !!(seeded && seeded.refuted),
      seededLastError: seeded ? seeded.lastError : '',
    });
  };

  // ===== 跨请求「产物复用」硬闸门（2026-10-23）=====
  // 为什么需要它（真读数，不是假想）：
  //   真实模型端到端跑里，中断时已有 live-e2e.pptx（33824B / sha1 8b46c0f8），
  //   恢复时账是对的（resumeStage=render、completedStages 含 build）、续跑摘要也明确说了
  //   「已产出的文件直接复用，不要重新生成」—— 但模型在恢复后的**第一轮**就重调 ppt-generate，
  //   把产物覆写了（31955B / 0ce580c4）。即"账对了、提示也给了，仍然重做"。
  //   提示是**劝**；这里补的是**执法**。与 planRecoveryGate 完全同一条纪律。
  // ★ 只拦"跨请求重做"这一种形态，三个条件全中才拦：
  //   ① open() 那一刻 build 已完成（priorBuild）—— 挡掉"同一请求内的正常重试/改写"
  //   ② 工作区里此刻真有 .pptx 且 size > 0 —— 挡掉"账说做了、盘上没有"（那种该做，不该拦）
  //   ③ 这次调用**可能重做本工作流的产物** —— 挡掉无关调用
  //      （判据由**选中的工作流**声明，本文件只负责去问它：见下面 `wfRegenKind` 的头注）
  // ★ 每次运行最多拦 1 次：模型若在收到拦截后仍坚持重做，第二次放行。
  //   闸门的作用是「先告知再放行」，不是建一堵墙 —— 否则用户真想重做时会被产品憋死。
  //
  // ★★ 2026-10-25【契约切口 3/3 的前情】判据本体已整体迁入具体工作流（`pptx-v1.regenKind`）。
  //   这一节原来还写着四条窄判据的说明（① ppt-generate 工具名 / ② file-write 的 .pptx 路径 /
  //   ③ file-write 的 python-pptx 生成骨架 / ④ shell-exec 的「生成特征 AND 写动作」），
  //   以及「为什么特征表故意不含裸 pptx」的取证理由 —— 那些文字**逐字搬到了**
  //   `pptx-v1.js` 的 `regenKind` 头注里，理由仍然成立，只是它属于那一套工作流，
  //   不属于通用主循环。改判据请看那里，别在本文件重新长出一份。
  /**
   * 命中判据的**证据摘录**（给 trace 用）。
   *
   * 为什么必须有它（2026-10-23 真跑踩到的取证缺口）：
   *   被闸门拦下的调用**不产生 `tool` 事件**（它压根没执行），`recordSkip` 也只记
   *   `{gate, skill, target}` —— 于是**命令原文一个字节都没落盘**。
   *   实测后果：`live_e2e_20261023121232` 的恢复臂第 0 轮有 2 个调用，其中 `shell-exec`
   *   被这道闸拦下、紧接着 `file-list` 正常执行；事后只能看到"拦了一个 shell-exec"，
   *   **无法判断那是真重做还是误拦**（比如 `cp live-e2e.pptx live-e2e.bak.pptx` 备份，
   *   命中 `cp ` + `.pptx` —— 那是误拦，会打断正常任务）。
   *   没有这条证据，"闸门判断对不对"就只能靠猜。所以把命中处的一小段原文记进 trace。
   *
   * @param {string} name 技能 id
   * @param {Object} params 调用参数
   * @return {string} 短摘录（≤200 字符，空白折叠；无参数返回 ''）
   */
  // ★ 说明（2026-10-25）：判据 `regenKind` 已迁到具体工作流（见 pptx-v1），本函数留下是因为
  //   它不含任何判据 —— 只把参数拍平成 trace 里的证据串。若将来某个工作流的重做判据换用别的
  //   参数形状，证据摘录要跟着一起参数化，那时再迁。
  const pptxRegenEvidence = (name, params) => {
    const prm = (params && typeof params === 'object') ? params : {};
    const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 200);
    const nm = String(name || '');
    if (nm === 'file-write') {
      return flat('path=' + String(prm.path == null ? '' : prm.path)
        + ' | content=' + String(prm.content == null ? '' : prm.content));
    }
    if (nm === 'shell-exec') return flat('command=' + String(prm.command == null ? '' : prm.command));
    return '';
  };
  /**
   * ★★ 2026-10-25【契约切口 3/3 · 重做判据契约】判据属于**选中的工作流**，不属于通用主循环。
   *   本函数只负责一件事：从注册表的**选择结果**里取出该工作流声明的 `regenKind` 并调用。
   *
   * ★ 判据来源是「选择结果」（`wfSel`），**不是** `wfCtl` 是否存在：
   *   `general-v1` 是 `lifecycle:'none'` ⇒ 不建控制器，但它**仍然是一套被选中的工作流**，
   *   有身份、也可能有判据。把「有没有控制器」当成「是不是本工作流」用，就是这次要拆的耦合。
   * ★ 未声明 ⇒ 返回 ''（无判据、闸门不武装），**绝不回落** PPT 那套判据。
   * ★ 判据抛错按"没命中"处理：工作流是增益，不是单点故障源 —— 一条判据写错不该让任务死掉。
   */
  const wfRegenKind = (name, params) => {
    const entry = (wfSel && typeof wfSel === 'object') ? wfSel.entry : null;
    if (!entry || typeof entry.regenKind !== 'function') return '';
    let k = '';
    try { k = String(entry.regenKind(name, params) || ''); } catch { k = ''; }
    return k;
  };
  // ★ 判据取值：从 `startWorkflowRun` 里那对常量**取回**（它们在任何 step() 之前就定好了）。
  //   绝不在闸门里现读 `state.run.completedStages` —— 那里面已经含本次运行自己标的 build
  //   （step('brief') 起就开始推进），闸门会退化成"同一请求里也不许再生成"。
  //   stateInfo() 只是把闭包里那一刻的值交回来，不做重算（见它的注释）。
  const priorBuild = !!(wfCtl && typeof wfCtl.stateInfo === 'function' && wfCtl.stateInfo().priorBuild);
  const priorResumeStage = String((wfCtl && typeof wfCtl.stateInfo === 'function'
    && wfCtl.stateInfo().priorResumeStage) || '');
  // ═══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-24 第五轮：**只加可审计性，不动放行/拦截策略**
  // ---------------------------------------------------------------------------
  // 为什么必须补「放行决策」的留痕（老板 2026-10-24 第 2 条指令的原话现场）：
  //   2026-10-23 那次真跑（taskId=live_e2e_20261023121551）的完整链条是：
  //     原产物 live-e2e.pptx 33381B / sha1 224959c5 / **4 页**；用户要的是 **3 页**；
  //     #9  file-write(build_ppt.py)      ⇒ **被拦**（reuse-gate ts=…797543）
  //     #10~#15 doc-read / file-list / shell-exec（模型真的去读并核对了产物）
  //     #16 第二次 file-write             ⇒ **静默放行** ← 零 trace、零记录
  //     #17~#18 shell-exec python 脚本    ⇒ 覆写
  //     新产物 live-e2e.pptx 33288B / sha1 c96bf9a7 / **3 页**；
  //     原内容被另存成 `豆芽端到端验收.pptx`（与原件**字节完全相同**）。
  //   ⇒ 那次覆写**是合法的修正**（4 页 → 3 页符合 spec），不是缺陷。
  //   **但**：这个"合法"结论当时只能靠模型最后自己说的那句
  //   「已改成正好 3 页，文件已重新生成并覆盖原文件」**读出来**。
  //   机制本身对「#16 为什么被放行」一个字节都没留。
  //   ⇒ 换一个不说理由的模型，trace 形状完全一样（`reuse-gate` count:1），
  //      我们分不清"合法修正"与"无理由重做"。**这才是真缺陷。**
  //
  // 本轮改法（`blocked` 的取值集合与触发条件**逐字不变**，真值表等价）：
  //   旧：`reuseGateFired` 为真 ⇒ **在任何后续判据之前**早退 `{blocked:false}`，静默。
  //   新：判据先算完；`reuseGateFired` 为真时同样返回 `blocked:false`，
  //       但多返回 `released:true` + `event`，由两个调用点记一条**新 kind**
  //       `reuse-gate-release`。
  //   ★ 为什么用新 kind 而不复用 `reuse-gate`：`unit-wf-resume-wiring.mjs` 的 F5e
  //     断言 `kind==='reuse-gate'` 恰好 1 条。复用同一 kind 会让 F5e 从 1 变 2 而红 ——
  //     那等于把"加可审计性"包装成一个假的产品回归。新 kind 也让审计方
  //     一眼分开「拦过几次」与「放行过几次」。
  //   ★ 真值表等价性（逐条对过，不是感觉）：
  //       旧 fired=true  → false（早退，不看后面的判据）
  //       新 fired=true  → false（先算判据；算完仍然 false）
  //       旧 fired=false → 与新的 fired=false 完全相同（判据顺序未变）
  //     ⇒ 对任何入参，`blocked` 的结果与改前**逐一相同**。
  //     唯一副作用：`workspaceDecks()` 在放行路径上也会被调一次（多一次 readdir+stat，
  //     且只在这个调用确实命中重做判据时才发生）—— 这是"放行"能被称作"放行"的前提：
  //     必须确认"如果不放行，它本来会被拦"。
  //
  // ★★ 2026-10-24 第六轮：`modelLastText` 原来会填**上一轮**的话（假读数，必须记住这个坑）
  // ---------------------------------------------------------------------------
  // 第五轮把「放行」从零字节变成可读，但 `modelLastText` 的取值方式错了：
  //   旧实现「从 conversation 尾部往前找最近一条**正文非空**的 assistant」，
  //   那个 `if (s)` 就是回溯开关 ⇒ 本轮无正文时会一路回看到更早轮次。
  // 真实现场（`live_e2e_20261023121551` 续跑臂，19 轮 `llm_resp`，其中 **14 轮 contentLen=0**，73.7%）：
  //   ★ 口径（2026-10-24 订正，别再拼错）：本句只统计**续跑臂**（该 trace 按 `task_start` 分段后的
  //     段 2，19 条）。整份文件是 23 条 / 15 条 silent —— 那是**另一个**口径，别把 19 和 15 拼进一句。
  //   turn=14  492 字  「文件在工作区里，两份都在，内容完全一样。…」
  //   turn=15    0 字  ← 第 2 次 file-write，**放行那次**，模型一个字都没说
  //   旧实现于是在"放行"事件里写下 turn=14 那句「内容完全一样」——
  //   **语义相反**（刚说完内容一样，下一轮就把文件覆写了），而且会让审计者以为模型申报过理由。
  // ⇒ 这不是"字段不准"，是**它会填写假读数**：不可读被换成了"可读但错"。
  //   字段缺失会被发现，假读数不会。所以宁可返回空串。
  // 改法（最小，且**不触碰放行/拦截策略**）：
  //   ① `thisTurnAssistantText()` 只看**最近一条** assistant，正文为空就返回 ''，绝不回溯；
  //      尾部不是 assistant（并行 join 段会 push `tool`）也直接返回 ''，不跨 role 找。
  //   ② 事件多一个 `modelTextState: 'said' | 'silent'` —— 让「本轮零申报」成为**显式读数**，
  //      而不是让人从空串去猜。`silent` 本身就有价值：它在说"这次放行是模型零申报下做的"。
  //   ③ 两个事件共用同一个 `said`（只读一次），避免同一轮两条事件取值不一致。
  //   ★ `blocked` 真值表**这一轮一个字没动**（第五轮那条等价性论证继续成立）。
  // ═══════════════════════════════════════════════════════════════════════════
  let reuseGateFired = false;     // 策略位：已拦过 ⇒ 第 2 次起放行（**语义一字未动**）
  // ★★ 2026-11-11【新建交付物授权门】策略位：本任务内**哪些技能**已被这道门拦过。
  //   只拦一次的理由见 intentGate.planAuthGate 头注：拦下后模型会问一句，用户答「做吧」
  //   ⇒ 下一轮判据已放行。若每轮都拦，用户答了也过不去，就退化成 gateDirective 头注里
  //   记的那场事故（"用户答了『做吧』仍被拦 ⇒ 再问一遍"）。
  //
  // ★ 2026-11-11 夜：**从「任务级一次性布尔」改成「按技能名的集合」**。
  //   原来写的是 `let authGateFired = false`，任何一次拦截都会把它置 true ⇒
  //   本任务内**其余 14 个产出技能全部免检**。实测症状（unit-agent-resume 的 Q4b/Q5 转红）：
  //     串行路：turn1 的 file-write 被拦 ⇒ fired=true ⇒ turn2 的 chart-generate 直接通过授权门；
  //     并行路：turn1 全是只读 web-fetch ⇒ fired 仍 false ⇒ turn2 的 chart-generate 被拦。
  //   两条路**同一句用户话、同一个技能，行为不同** —— 这本身就是缺陷信号。
  //   更要紧的是语义：任务级一次性 = 「先拿一个技能撞一次门，再换一个技能就过了」，
  //   正是本轮要堵的「换个技能名就复发」换了个形态。⇒ 作用域必须收窄到**同一技能**：
  //   同一个技能只拦一次（够模型改写/发问），换了技能重新判。
  //   方向说明：这是**收紧**（拦的范围变大），不是放宽 —— 唯一的代价是模型若连环换技能，
  //   每次都会被拦一句，但它照样能通过 `deliveryAuthGranted` 在用户点头后放行。
  let authGateFiredFor = new Set();
  // ★ 2026-11-11【产物正文事实门】策略位：本任务内**哪些技能**已被事实门拦过。
  //   与 authGateFiredFor 同一个"只拦一次"理由（拦一次是为了让模型**改写**），
  //   同一个作用域收紧理由（换技能不等于已经改好了）。
  let claimGateFiredFor = new Set();
  // ★ 2026-11-11 夜：原来这里有一份内联的 `producerTarget`（只认 params.path 的加强版）。
  //   已抽成独立模块 `./producerTarget`（文件顶部 require）。抽出去的两个理由：
  //     ① 15 个技能的路径形态各不相同，那段 switch 有 60 行，埋在 startBackend 里没人看得见；
  //     ② **闭包里门禁够不着** ⇒ 只能断言"源码里有这个字样"，而那种断言遇到
  //        "把函数名留在注释里"照样会绿（本轮实测踩到）。抽出模块后门禁能真建文件、真看 exists。
  //   ⚠️ 刻意不留 `fileWriteTargetExists` 兼容别名 —— 只守 file-write 一个口径正是本次要修的病根。
  let reuseGateAttempt = 0;       // 本次运行内第几次**命中重做判据**（1=拦截，2…=放行）
  let reuseGateBlocks = 0;        // 已拦过几次（**独立计数**，不从 attempt 反推）
  /**
   * 「本轮模型发了 tool_call 的同时说了什么」—— 放行决策的审计读数。
   *
   * ★ 只取**最近一条 assistant 消息**（runAgentLoop 在 `conversation.push(msg)` 之后才派发工具，
   *   所以此刻尾部那条就是本轮），**正文为空就返回空串，绝不回溯历史**。
   *
   * ★★ 为什么必须「不回溯」（2026-10-24 第六轮，反例实测，别改回去）：
   *   上一版是「从尾部往前找最近一条**正文非空**的 assistant」——`if (s) return ...` 里的
   *   `if (s)` 就是回溯开关。真实现场（续跑臂 live_e2e_20261023121551，19 轮 llm_resp）：
   *     turn=14  contentLen=492  「文件在工作区里，两份都在，内容完全一样。…」
   *     turn=15  contentLen=0    ← 第 2 次 file-write（**放行那次**），模型一个字没说
   *   旧实现在 turn=15 那一刻返回的是 **turn=14** 那句「内容完全一样」。
   *   字段名叫「模型说了什么」，填进去的是**上一轮的、语义相反**的话
   *   （刚说完"内容一样"，下一轮就把文件覆写了）。
   *   ⇒ 后果比字段缺失更糟：**不可读被换成了"可读但错"**。审计者看到非空字符串
   *     会以为模型申报过理由，实际它什么都没说。缺失会被发现，假读数不会。
   *   续跑臂 19 轮里有 14 轮 contentLen=0（73.7%）⇒ 这不是边角情况，是常态。
   *
   * ★ 只记录，**不判真伪、不参与放行决策**：返回值不进入任何 if。
   *   本轮**不做**"有理由才放行"—— 那会把一条启发式判断变成执法层。
   * @return {string} 本轮 assistant 正文（空白折叠、≤200 字符）；本轮无正文/取不到 ⇒ ''
   */
  const thisTurnAssistantText = () => {
    try {
      const list = Array.isArray(conversation) ? conversation : [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (!m) continue;
        // ★ 尾部不是 assistant 就不猜（不跨 role 回溯）：并行路径 join 段会先 push `tool` 消息，
        //   再往前找回来的那些 assistant 都是**更早轮次**的，写进去就是假读数。
        if (m.role !== 'assistant') break;
        const s = String(m.content == null ? '' : m.content).replace(/\s+/g, ' ').trim();
        return s.slice(0, 200);   // 空就是空，如实返回
      }
    } catch { /* 取不到就给空串：审计字段缺失绝不影响任务（与 taskTrace 同一条纪律） */ }
    return '';
  };
  /**
   * @param {string} name 技能 id
   * @param {Object} params 调用参数
   *   （没有第三参：`path` **不进 event** —— 索引见下）
   * @return {{blocked: boolean, target?: string, directive?: string, released?: boolean, event?: Object}}
   *   `event` 是**除 path 之外**已经拼好的载荷（拦截/放行**同一个形状**）。
   *   8 个字段（skill/target?/priorResumeStage/regenKind/evidence/attempt/firedBefore/modelLastText）
   *   是**闸门的知识**，只在 planReuseGate 里长一遍；
   *   `path` 是**调用点的知识**，由调用点 `{ ...reusePlan.event, path: 'serial' }` 补上 ——
   *   这样并联路径有没有留痕，看那一行 `taskTrace.record` 的字面量就知道（门禁 F9-f 就是这么检的）。
   */
  const planReuseGate = (name, params) => {
    if (!priorBuild) return { blocked: false };
    // ★ 这里判的是**效果**（见 pptx-v1.regenKind 的头注），不是工具名白名单。
    //   第四轮修的就是这一行：原来 `if (!PPTX_REGEN_TOOLS.has(name)) return { blocked: false };`
    //   ⇒ 模型换一条合法路径（file-write .py + shell-exec python）就能整条绕过闸门。
    // ★ 放行路径也必须**真算一次** regenKind（不许填 'released' 之类的假值）：
    //   否则"放行"就没有确切语义 —— 我们记不下"这次调用本来会命中哪条判据"。
    const regenKind = wfRegenKind(name, params);
    if (!regenKind) return { blocked: false };   // 没命中重做判据的普通调用：一个字都不记
    // ★ 这里原来是 `if (!wfCtl) return { blocked: false };` —— 那是把"有没有控制器"当成
    //   "是不是本工作流"的判据（本轮拆掉的那条耦合）。现在判据来自 `wfSel.entry.regenKind`，
    //   没声明就是没判据；而 `priorBuild` 本身只能由控制器里的状态置位 ⇒ 该守卫已冗余。
    // 与 conclude 的兜底共用同一个扫描来源（wfCtl.workspaceDecks → startWorkflowRun 里的 workspaceDecks）：
    // 两处各写一份 scan，迟早会有一天一处改了另一处没改，判据就分成两套了。
    // ★ 2026-10-26：不传参 ⇒ 用本工作流契约里的 `buildExts`（修前这里恒为 `.pptx`，
    //   非 PPT 工作流即便声明了产物类型也会被空扫描作废 ⇒ 拦不住重做）。
    const found = (wfCtl && typeof wfCtl.workspaceDecks === 'function') ? wfCtl.workspaceDecks() : [];
    if (!found.length) return { blocked: false };
    // ===== 到这里：这次调用**确实命中**「跨请求重做 pptx」的全部判据 =====
    // ★ 2026-10-24（第六轮）：本轮模型说了什么，**只读一次**，拦截/放行两个事件共用同一个值。
    //   读两次的话两次之间 conversation 可能已经被别的分支 push 过（拦截分支里有 sendPhase/recordSkip），
    //   两条事件就会出现"同一轮、不同的 modelLastText"，审计时对不齐。
    const said = thisTurnAssistantText();
    if (reuseGateFired) {
      // ★ 策略位已置：放行。改前这一行是 `return { blocked: false };` —— 完全静默。
      //   现在把放行决策也记下来，且字段与拦截口径完全一致（同一套 wfRegenKind /
      //   pptxRegenEvidence / priorResumeStage），审计时两条事件可以直接对齐比较。
      reuseGateAttempt += 1;
      return {
        blocked: false,
        released: true,
        event: {
          skill: String(name || ''),
          regenKind,
          priorResumeStage,
          attempt: reuseGateAttempt,        // 2, 3, …（1 永远是拦截那一次）
          firedBefore: reuseGateBlocks,     // 此前已拦过几次（正常是 1）—— 独立计数，不反推
          evidence: pptxRegenEvidence(name, params),   // 与拦截口径**完全相同**
          modelLastText: said,                          // ★ 本轮模型说了什么（空串=没申报）
          // ★★ 第六轮：把「说过 / 没说」变成显式可读，不让人从空串去猜。
          //   `silent` 本身是有价值的读数：它在说"**这次放行是在模型零申报的情况下做的**"。
          //   真实现场 turn=15 就是 silent —— 而旧实现会在这里填一句上一轮的话。
          modelTextState: said ? 'said' : 'silent',
        },
      };
    }
    reuseGateFired = true;
    reuseGateAttempt += 1;   // 本次是第 1 次命中 ⇒ 1
    reuseGateBlocks += 1;    // 又拦了一次
    const bits = found.slice(0, 3).map((p) => {
      let size = 0; let sha = '';
      try { size = fs.statSync(p).size; } catch { /* 读不到就只报路径 */ }
      // ★ 这里**不能**用 digestOf：它对入参做 `String(s)` 再按 utf8 update，
      //   传 Buffer 会把非 UTF-8 字节压成替换符 ⇒ 打出来的根本不是文件 sha1（实测对上不上）。
      //   诊断里报错的哈希比不报更糟：模型会拿它去核对一个假的指纹。
      try { sha = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { /* 同上 */ }
      return p + '（' + size + ' 字节' + (sha ? '，sha1 ' + sha.slice(0, 8) : '') + '）';
    });
    const target = bits.join('；');
    /**
     * ★ 2026-10-26【点 2 配套】产物称呼必须来自契约，不许写死 `pptx`。
     *   修前这段文案三处硬编码「pptx」。点 2 之前复用闸门只对 PPT 生效（扫描写死 `.pptx`），
     *   所以那个字面量不会被外人看到；点 2 之后第一个非 PPT 的 full 工作流就会命中它 ——
     *   实测（p2-reusegate.mjs 修后 case A）用户看到的是
     *   「这个任务的 **pptx** 上一次请求就已经产出：…\report.txt」—— 文件名与称呼自相矛盾。
     *   ⚠️ 取值只能走 `wfCtl.cfg.buildExts`（契约，唯一来源）；`buildExts` 那个闭包变量在
     *      startWorkflowRun 里，这里是 runAgentLoop 的作用域，直接引用会 ReferenceError。
     *   ⚠️ 去掉前导点 ⇒ PPT 侧仍是逐字的「pptx」，用户可见文案一字不变（正控要求）。
     */
    const gateExts = (wfCtl && wfCtl.cfg && Array.isArray(wfCtl.cfg.buildExts)) ? wfCtl.cfg.buildExts : [];
    const deckLabel = gateExts.length
      ? gateExts.map((e) => String(e || '').replace(/^\./, '')).filter(Boolean).join('/')
      : '产物';
    return {
      blocked: true,
      target,
      // ★ 命中原因（窄表里的哪一条）。进 trace ⇒ 事后审计能区分
      //   "模型调了 ppt-generate" 与 "模型换了一条路重做 pptx" 这两种完全不同的现场。
      regenKind,
      // ★ 命中处的**原文摘录**。被拦下的调用没有 tool 事件、命令原文本来一个字节都不落盘，
      //   没有这一条就分不清"真重做"与"误拦"（见 pptxRegenEvidence 的头注）。
      evidence: pptxRegenEvidence(name, params),
      // ★ 2026-10-24（第五轮）：拦截事件也带上同一对计数（attempt/firedBefore），
      //   让 `reuse-gate` 与 `reuse-gate-release` **字段对称**、可以直接对齐比较：
      //   拦截 = attempt 1 / firedBefore 0；放行 = attempt 2… / firedBefore 1。
      //   不放的话审计方只能从"事件出现了几次"反推，那正是本轮要消灭的东西。
      attempt: reuseGateAttempt,
      firedBefore: reuseGateBlocks - 1,   // 本次拦截**之前**已拦过几次（第 1 次拦截时为 0）
      // ★ 与放行事件**同一份构造**（同一个对象形状、同一套取值函数），只是多了 target。
      //   两个调用点一律 `taskTrace.record(taskId, 'reuse-gate', reusePlan.event)` ——
      //   字段只在这里长一遍，杜绝"两处各拼一份、迟早就分成两套"。
      event: {
        skill: String(name || ''),
        target,
        priorResumeStage,
        regenKind,
        evidence: pptxRegenEvidence(name, params),
        attempt: reuseGateAttempt,
        firedBefore: reuseGateBlocks - 1,
        // ★★ 第六轮：与放行事件同一个值（上面只读一次）、同一个状态口径。
        modelLastText: said,
        modelTextState: said ? 'said' : 'silent',
      },
      directive:
        '本次调用没有执行：这个任务的 ' + deckLabel + ' **上一次请求就已经产出**，磁盘上现在确实有：' + target + '。\n'
        + '当前任务是**跨请求恢复**（上次停在「' + (priorResumeStage || 'build') + '」之后），已有产物应当**直接复用**，'
        + '重新生成会覆盖掉已完成的工作。\n'
        + '识别到这次调用的效果是「重新产出 ' + deckLabel + '」（判据：' + regenKind + '）—— 换工具/换写法同样算重做。\n'
        + '下一步请这样做：① 先读现有产物确认内容够不够（file-read / shell-exec 解析内容）；'
        + '② 够用就继续往下走（校验、收尾、交付）；③ 若确实内容不够，明确说出「为什么必须重做」，'
        + '再调一次本工具 —— 第二次会放行。',
    };
  };
  /**
   * 恢复动作执行后**强制复验**（契约②）：恢复器自己说"好了"不算证据，只有这次复验的读数算。
   * ★ 用的是**同一条**证据链（buildClaimContext → verifyCompletionClaims），不另造一套判定；
   *   判定结果经 recoveryEvidenceGate 才作数 ⇒ 删掉下面这次调用，读数必为 false，终态随之降级。
   */
  const reverifyAfterRecovery = (entry, reason) => {
    if (!claimGateEnabled()) return false;   // 门禁关闭 ⇒ 本闸不参与（与 claim 门同一开关，单测对照组）
    let artifactsOk = true;
    if (deliverables.length) {
      try {
        artifactsOk = verifyDeliverables(deliverables.map((d) => ({
          name: d.name, path: path.isAbsolute(d.path) ? d.path : path.resolve(AGENT_WORKSPACE, d.path),
        }))).ok;
      } catch { artifactsOk = false; }
    }
    const ev = verifyCompletionClaims(buildClaimContext({
      deliverables,
      artifactsOk,
      completionClaimed: true,
      deliverableClaimed: deliverables.some((d) => isRealArtifact(d && d.path, lastUserText)),
      userText: lastUserText,
    }));
    if (entry) {
      entry.reverification = {
        ran: true, ok: artifactsOk, reason,
        gateReason: ev && ev.reason, criticalCount: ev ? ev.criticalCount : 0,
      };
    }
    return recoveryEvidenceGate(entry);
  };
  /** 有恢复动作在等复验时，**每次成功执行**都补一次复验（没执行成 ⇒ 也证明不了恢复生效）。 */
  const drainRecoveryReverify = () => {
    if (!reverifyPending) return;
    reverifyPending = false;
    const entry = recoveryLog[recoveryLog.length - 1];
    // ★★ 这一行是契约②的**唯一执法点**：删掉它 / 绕过它 ⇒ entry 拿不到复验读数
    //    ⇒ recoveryEvidenceGate 必然判 false ⇒ 终态不许 COMPLETE。
    recoveryVerified = reverifyAfterRecovery(entry, '恢复动作执行后');
  };
  /** 契约②的对外读数：有恢复动作、却始终没拿到复验读数 ⇒ 未复验（收尾不许说"完成"）。 */
  const recoveryUnverifiedNow = () => recoveryLog.length > 0 && !recoveryVerified;
  // 【诊断可复现 · 取证载体】2026-02-16
  // 为什么要自己记一份，而不是收尾时去读 trace 文件：
  //   ① `DOUYA_TRACE=0` 时整个 trace 层关闭，读不到任何东西；
  //   ② trace 有 MAX_LINES=4000 / MAX_BYTES=8MB 上限，超限后**丢弃后续事件** ——
  //      而收尾恰恰发生在最后，最需要的那几条很可能已被丢弃。
  // 只留最近 200 条：判"可复现"只需要找同一条命令的 2 次执行，留太多是白占内存。
  // ⚠️ 不要在这里做任何判定 —— 它只是取证，判定在 classifyBlockedDiagnosis。
  // ★★ 作用域为什么必须在这里（`governToolResult` 之外、`runAgentLoopInner` 之内）：
  //   唯一写入点 `traceTool` 是 `governToolResult` 的**闭包**（它在 :7108 定义），
  //   而唯一读取点是收尾判定里那次 `adjudicateTerminal` 调用的 `blockedDiagnosed` 入参（见 :9451 附近），
  //   它在 `governToolResult` **外面**。若把它声明在 `governToolResult` 里面，
  //   ⚠️ 下面这段注释里**不许**出现 `adjudicateTerminal` 紧跟左括号再跟花括号的写法：
  //      `unit-delivery-protocol.mjs` 的 D21-e2 是**按行裸扫**那段调用形式的（不剥注释），
  //      注释里写一遍就等于多出一处"调用点"，它会把 blocks 数成 3 而判红 —— 那不是门禁太严，
  //      而是它分不清注释与代码，所以约束在**被扫的这一侧**（本注释）。
  //   ① 收尾侧根本看不见它（ReferenceError 或静默拿到 undefined ⇒ 判据永久失效）；
  //   ② 即使看得见，它也会**每次工具调用重建一次** ⇒ 永远只有 1 条 ⇒
  //      "同一条命令跑过 ≥2 次"永远判不成立 ⇒ 第四档永远产不出来（一个不会响的判据）。
  //   两者都是静默失效，不会报错 —— 所以这条位置是**判据的一部分**，不是排版偏好。
  const toolExecLog = [];
  const TOOL_EXEC_LOG_MAX = 200;
  // 工具结果统一收口：**成功结果一个字都不改**（与 skills.js 的 attachRecoveryHint 同一纪律，
  // 保证不拦死任何本来能成功的调用）；只给**失败**结果追加"这一类失败该走的出路"。
  const governToolResult = (nm, prm, result, argsInfo) => {
    const text = String(result == null ? '' : result);
    // 【执行记录 · 工具调用】把「调了什么、参数是什么、结果如何、归因是哪类」记下来。
    // ★ 为什么挂在这里：三条执行路径（串行两处 + 受控并行一处）的结果**都经过本函数**，
    //   挂一处即全覆盖 —— 这与上面 drainRecoveryReverify 的挂法同一个理由。
    // ★ 为什么参数必须记：审计发现「每次工具调用的参数，磁盘上零记录」——
    //   SSE 只发中文动作标签，sessions.json 不存 arguments，tasks.json 的 brief 只有结果首行 120 字。
    //   于是「第 3 步到底给 file-read 传了什么路径」这种最基本的问题，事后无法回答。
    // ★ 脱敏走 backend 自己的 maskSecrets（不在这里另建一份密钥名单——两份必然漂移）。
    const traceTool = (ok, kind) => {
      try {
        let p = prm;
        try { p = maskSecrets(prm); } catch { /* 参数形态怪异：退回原值，taskTrace 里还有一层键名兜底 */ }
        // ⚠️ 失败归因传的是 failKind（不是 kind）：trace 的 kind 是**事件类型**，
        //   两个同名会导致失败事件在磁盘上不再叫 'tool'（门禁 unit-task-trace 的 B2 钉住这一点）。
        // ★ failureSide（2026-10-22）：事后查「这条为什么没重试 / 为什么没熔断」时，
        //   光有 failKind 不够 —— 还得知道当时把它判成模型侧还是工具侧。判据错一次，
        //   整条处置链就走错边，而这个错误只有留痕才看得出来。
        taskTrace.tool(taskId, {
          turn: taskEntry.turn, name: nm, params: p, ok,
          failKind: kind, failureSide: kind ? failureSide(kind) : null, result: text,
        });
        // 【诊断可复现 · 取证】2026-02-16：把这一条执行记录同时放进任务级日志。
        // ★ 为什么挂在这里而不是另找地方：`governToolResult` 是三条执行路径（串行两处 +
        //   受控并行一处）的唯一收口点，而 `traceTool` 又是本函数**成功/失败两条出口共同**的唯一
        //   写盘点（成功 :7177、失败 :7263）⇒ 挂一处即全覆盖，不会漏掉失败那条 ——
        //   而"失败那条"恰恰是第四档唯一关心的证据（`ok !== false`）。
        try {
          // 只记诊断判定真正需要的三个字段：命令、成败、输出前 800 字
          // （800 与 taskTrace 的 HEAD_LIMITS.toolResult 对齐，保证两边读数可比）
          toolExecLog.push({
            params: { command: (prm && (prm.command || prm.cmd || prm.script)) || '' },
            ok: ok !== false,
            resultHead: String(text == null ? '' : text).slice(0, 800),
          });
          if (toolExecLog.length > TOOL_EXEC_LOG_MAX) toolExecLog.splice(0, toolExecLog.length - TOOL_EXEC_LOG_MAX);
        } catch { /* 旁路：取证失败绝不许影响工具执行本身 */ }
      } catch { /* 旁路 */ }
    };
    // ★★ 2026-10-22：这里原来直接测 `FAILURE_RESULT_RE`（裸正则），于是**同一件事有两个判据**：
    //   本函数判成功 ⇒ `toolBreaker.ok()` 把计数**清零**；而三个调用点（4099/5283/5318）
    //   转头用 `isFailureResult` 判 ⇒ SSE 发 ok:false、markStep 记失败。
    //   一条空输出就这样同时被记成"失败"(履历)和"成功"(熔断器) —— 而熔断器被清零的后果是
    //   后面再也拦不住这个工具。判据必须走 `isFailureResult`（声明上的单一真源）。
    if (!isFailureResult(text)) {
      toolBreaker.ok(nm);   // 成功：绝不插手（并给熔断器清零）
      /**
       * ★ 2026-02-16：**成功 ⇒ 解除证伪**（"这个方法现在能用了"是唯一可信的解除证据）。
       *
       * 为什么必须有这一条（否则机制只做一半）：账本里记了"这个方法已证伪"之后，
       * 若永远不会被成功解除，那它只能靠"代码变了"（stale）这一条路失效 ——
       * 而现实中大量"上次不行、这次行了"并不涉及代码变更（磁盘清了、依赖装好了、权限给了、
       * 参数换了个合规值）。没有这一条，这些情况下的旧禁令会一直生效，
       * 正是老板批的那个病（把一次历史失败固化成永久禁令）。
       *
       * 为什么按 `tool` 也清（而不只按 `sig`）：成功那一刻的参数可能已经和失败时不同，
       * `sig` 含参数键，未必对得上；而"这个工具刚刚真的成功了"本身就足以否定它身上的旧禁令。
       * **清除比保留安全**：多清一条的代价只是多试一次；少清一条的代价是永远不再试一个能用的办法。
       *
       * 只在真的清掉了东西时才写盘（`unrefute` 内部保证），所以正常路径零额外 I/O。
       */
      try {
        if (wfCtl && typeof wfCtl.unrefute === 'function') {
          let sig = '';
          try { sig = toolCallSignature(nm, prm); } catch { sig = ''; }
          wfCtl.unrefute({ sig, tool: nm });
        }
      } catch { /* 旁路：解除失败不影响这次成功 */ }
      // ★ 契约②（2026-10-05）：恢复动作**真的执行成功了** ⇒ 立刻补一次强制复验。
      //   为什么挂在这里：三条执行路径（串行两处 + 受控并行一处）的结果都经过本函数，
      //   挂一处即全覆盖；而"成功"正是"恢复生效"的唯一可观察形态（失败/没执行都证明不了）。
      //   它只在「有恢复动作在等复验」时做实事，正常路径零开销、零行为变化。
      drainRecoveryReverify();
      traceTool(true, null);
      return text;
    }
    const problem = argsInfo && argsInfo.problem;
    // ★ 2026-11-09：把三条 catch 挂上来的进程级事实并入分类入参。
    //   优先级由 classifyToolFailure 自己决定（parseProblem > 结构化 kind/proc > 文案正则），
    //   这里只负责"把已知的事实交给它"，不在调用点做第二套判定（本仓纪律：判定只有一处）。
    const failure = argsInfo && argsInfo.failure;
    const failCtx = (problem || (failure && (failure.kind || failure.proc)))
      ? Object.assign({}, problem ? { parseProblem: problem } : {},
        failure && failure.kind ? { kind: failure.kind } : {},
        failure && failure.proc ? { proc: failure.proc } : {})
      : undefined;
    const kind = classifyToolFailure(text, failCtx);
    const rec = toolLedger.fail(nm, prm, kind);
    // ★ 跨请求落盘（2026-10-23）：把这条**失败方法**当场写进任务状态，而不是只留在内存里。
    //   记的是「方法」不是「这一次」：sig = 工具 + 参数键 + 执行模式（不含参数值）——
    //   参数值变了是"换了个输入"，参数键不变才是"还在用同一个办法"。
    //   nextAction 直接取恢复器的标准处方（单一真源），不在这里另写一套 kind→动作。
    try {
      let nextAction = '';
      try {
        const rs = recoveryStrategyFor({ kind, escalate: rec.escalate });
        nextAction = RECOVERY_ACTION_LABEL[rs.action] || '';
      } catch { nextAction = ''; }
      if (wfCtl && typeof wfCtl.noteAttempt === 'function') {
        wfCtl.noteAttempt({
          sig: rec.strategy || '',
          tool: nm,
          count: rec.strategyCount,
          lastKind: kind,
          // 只留能读懂的一段（状态文件有上限）；原文已经进了 trace 与回灌文案
          lastError: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          nextAction,
          at: Date.now(),
        });
      }
      /**
       * ★★ 2026-11-09【通用任务那一半】把这条失败**跨运行**记下来。
       *
       * 与上面 `wfCtl.noteAttempt` 是**同一件事的两个半边**，不是两套账：
       *   `sig` 来自 `rec.strategy`（工具 + 参数键 + 执行模式，不含参数值）——
       *   **同一个计算点、同一个口径**，否则预热进 `byStrategy` 的桶键和 `fail()` 写的桶键对不上，
       *   账记了却永远拦不住（"看起来接了、其实空转"）。
       *   `nextAction` 取自 `recoveryStrategyFor` 的标准处方，不在这里另写一套 kind→动作。
       *
       * 为什么**同步落盘**（`remember` 内部 writeFileSync + rename）而不是攒着批量写：
       *   用户点「停止」、关窗、进程被杀都是常态，而"上一次为什么失败"恰恰要在这些时刻之后才读。
       *   攒着写等于"最需要它的那次刚好没写下去"。
       *
       * 为什么这里不写 `refuted`：
       *   "这条办法已证伪"需要证据（失败原文 + 适用范围 + 代码版本），够不上就不能写。
       *   硬塞一个 `refuted: true` 会让交接单把它写成"不要再用"，而实际上从没验证过 —— 伪造证据。
       *   本处只贡献**次数与原因**，是否上升到禁令由 `refuteDecision` 判（判据只有一处）。
       */
      if (repeatLedger && repeatLedger.available) {
        try {
          repeatLedger.remember({
            sig: rec.strategy || '',
            tool: nm,
            kind,
            // 原文交给模块自己压缩/截断（口径在 repeatLedger.ERR_MAX，不在这里再写一个数）
            lastError: text,
            nextAction,
            at: Date.now(),
          });
        } catch { /* 旁路：记账失败不影响本次执行，更不许把失败变成异常 */ }
      }
      /**
       * ★★ 2026-02-16：跨请求**证伪**落账 —— 「这个方法已不行」的唯一写入点。
       *
       * 背景（老板原话）：「一次工具执行失败，不等于"某个根因假设已经被证伪"；
       * 一次调查暂时找不到证据，也不等于"假设为假"。」「`refuted` 要记证据、适用范围/代码版本，
       * 否则代码变了旧假设仍被无条件跳过。」
       *
       * 为什么挂在**这里**（noteAttempt 同一个 try 块里）：
       *   账本（"试过几次"）与禁令（"这条路别试了"）是同一件事的两个半边。
       *   分两处挂必然出现"记了次数但没记禁令"或反过来的半截状态，而那种状态在磁盘上看起来完全正常。
       *
       * 为什么判定不写在这里：`governToolResult` 是闭包，单测启动不了 ⇒ 判定会被迫无人监督。
       *   判据在 `toolProtocol.refuteDecision`（纯函数）里：**只在 `rec.escalate === true` 时**才判证伪，
       *   即"同一个策略（工具+参数键+执行模式，不含参数值）已失败到上限"。
       *   失败**一次**就记证伪 = 老板批的那个原始缺陷原封不动地回来，所以阈值这一条绝不能松。
       *
       * 为什么证据取 `text`（失败原文）：这就是"让这次判定成立的那一次真实失败"。
       *   `refuteDecision` 只搬运，`workflowState.recordRefuted` 负责截断（2000 字符）与拍代码版本。
       */
      if (wfCtl && typeof wfCtl.refute === 'function') {
        const dec = refuteDecision({
          tool: nm, params: prm, kind, text,
          escalate: rec.escalate === true,
          strategy: rec.strategy || '',
          strategyCount: rec.strategyCount,
          nextAction,
          lastError: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          now: Date.now(),
        });
        if (dec.refute && dec.one) {
          const r = wfCtl.refute(dec.one);
          // 观测点：证伪落账是**罕见且重要**的事件（一次任务通常 0~2 条）⇒ 值得一条日志。
          // 落账失败不阻断任何东西（旁路），但必须留下可见痕迹，否则"以为记了、其实没记"。
          if (r && r.ok) {
            console.log('[refute] 已记证伪：' + r.sig + '（范围 ' + ((r.files || []).length) + ' 份实现文件）');
          } else {
            console.warn('[refute] 证伪落账未成功（按未落账继续）：' + String((r && r.reason) || 'unknown'));
          }
        }
      }
    } catch { /* 旁路：落盘失败不影响这次失败处置 */ }
    // 熔断计数：与账本**各记一份**（账本按策略签名、熔断按工具名，两者要回答的问题不同）
    const trip = toolBreaker.fail(nm, kind);
    // 截断类：把**实况**说清楚（缺哪些值、用了多少输出 token、上游给的结束原因）。
    // 模型只有知道"我是被截断的"，才会去改"一次写多少"；否则它会一直以为是自己漏写参数。
    let salvageHint = '';
    if (kind === KIND.ARGS_TRUNCATED) {
      const got = (argsInfo && argsInfo.missing) || [];
      salvageHint = '· 本次实况：' + (got.length ? ('这些参数没拿到完整值：' + got.join('、')) : '内容被截在中间')
        + '；已用输出 ' + ((argsInfo && argsInfo.completionTokens) || '?') + ' tokens'
        + '，参数原始长度=' + ((argsInfo && argsInfo.rawLength) || '?') + ' 字符'
        + '，上游结束原因=' + ((argsInfo && argsInfo.finishReason) || '?') + '。';
    }
    // ★ 熔断触发：这是**语言层面的劝告**变成**执行层面的禁令**的地方。
    //   只加 recoveryDirective（"换一种方式"）是不够的 —— 实测里模型读到了这句话，
    //   然后又启动了一次浏览器。所以熔断时额外追加一条明确禁令 + 降级链。
    const breakerNote = trip.tripped ? ('\n' + breakerDirective(trip)) : '';
    if (trip.tripped) recordBreaker(nm, trip);
    traceTool(false, kind);
    // ★★ 2026-10-22（第二次修同一个坑）：失败出口的返回值**必须自己认得出是失败**。
    //   修之前这里直接 `text + '\n' + recoveryDirective(...)`，于是空结果拼完开头变成
    //   `"\n【工具调用失败 · …"` —— 而调用点的 `!isFailureResult(result)` 只认
    //   `错误/失败：/error` 这些前缀，`【` 一个都不匹配 ⇒ **判成功**。
    //   后果：账本/熔断/执行记录说失败，SSE 发 ok:true、履历记「完成」、成果卡照收、终态还能 COMPLETE。
    //   判据修了，但用户可见层完全反了 —— 等于没修。
    //   不变量立在 toolProtocol.ensureFailureHead（纯函数，门禁对 15 个 KIND 逐个断言），
    //   不再在调用点逐处打补丁。原有以失败前缀开头的文案**一个字都不改**。
    return ensureFailureHead(text, kind) + '\n' + recoveryDirective({
      kind, skill: nm,
      missing: (argsInfo && argsInfo.missing) || [],
      escalate: rec.escalate, count: rec.count, salvageHint,
      // 策略级信息：升级是按「工具+参数键+执行模式」记的，所以要告诉模型它是真换了方法还是换汤不换药。
      sameStrategy: rec.sameStrategy, strategyCount: rec.strategyCount,
    }) + breakerNote;
  };

  // ===== 产物验证分诊（规范 §二十三）=====
  // 验证没通过有两种完全不同的原因：① 验证/读取这一侧出了问题（文件存在但读不到）；
  // ② 产品真的没做出来。**混在一起会把账算错方向** —— 把"读不到"说成"根本没生成"，
  // 就会让人（和模型）去修一个不存在的问题。所以这里统一走一次分诊再决定怎么说。
  // 三个收尾出口（收尾前静默复验 / 轮次上限出口）都调它，避免口径分叉。
  const reportArtifactVerdict = async (fv) => {
    if (!fv || fv.ok) return;
    const verdict = classifyVerificationFailure({
      toolFailed: (fv.unreadable || []).length > 0,
      productSignal: (fv.missing.length || fv.empty.length || fv.oversized.length) ? 'broken' : 'unknown',
    });
    if (verdict === 'product') {
      await sendTextAsStream(honestStatusReport(fv));
      return;
    }
    // 验证侧问题 / 分不清 ⇒ 按 §18 说人话，并明说"结论未确认"：既不说完成，也不说坏了。
    await sendTextAsStream(
      verificationVerdictText(verdict)
      + ((fv.unreadable || []).length ? '\n· 读不到的：' + fv.unreadable.join('、') : '')
    );
  };


  // ===== 跨请求续跑：注入本 owner 最近未完成任务的「任务状态摘要」 =====
  // 放在 compressContext + persona 之后（避免被历史压缩吃掉），只为让「继续」时模型看得见
  // 「目标是什么、已完成哪几步、卡在哪」，而不是两眼一抹黑（工具历史已被 packMessages 剥掉）。
  // [TASK-STATE-INJECT] RC 变异会中和这一行，续跑断言即定点转红。
  //
  // ★ 2026-02-16 `payload.skipResumeState`：**第二执行实例必须跳过这一注入**。
  //   独立验收实测：替补的内层请求体是 9 条消息 = 8 system + 1 种子，其中【跨请求任务状态】
  //   列着前任那 4 步 `shell-exec：hi`，而种子文案又写「你没拿到它的工具调用过程」
  //   ⇒ **同一份上下文里两句话互相打脸**（说"全新上下文"是假的）。
  //   二选一（要么跳过、要么改文案说真话）：本轮 6 条 P1 的前提就是"全新上下文"，
  //   所以选择跳过 —— 连"内部子运行不该进续跑清单"这件事也才真正闭合。
  if (payload.skipResumeState !== true) injectResumeState(conversation, payload.username);

  // ===== 长期记忆注入（A 阶段 #245）：让豆芽「记得你是谁」 =====
  // 位置：紧跟 injectResumeState（同属"注入族"，都在 compressContext + persona 之后）
  //   为什么在这里：本段之前 conversation 刚被压缩/重建过，在这里 push 才不会被历史压缩吃掉；
  //   之后紧接着就是各种门控（澄清/计划确认），注入的 system 消息不会干扰它们。
  //
  // ★ 三条不可动摇的性质（见 memorySummary.js 头部）：
  //   ① 绝不阻塞：读失败/无档案/无 owner 一律降级成"不注入"，主任务照常。
  //   ② 只注入 active：pending_conflict / stale 绝不进 system 消息
  //      （模型无从质疑注入内容 ⇒ 把"可能不是真的"喂进去等于让它拿假事实推理）。
  //   ③ owner 为空绝不注入（宁可这次不记，也不能读成别人的档案）。
  // ⚠️ 返回值刻意只用于日志：注入成功与否**不影响**主任务任何分支。
  {
    const mem = injectUserMemory(conversation, payload.username);
    if (mem.injected) {
      console.log('[Memory] injected ' + mem.entryCount + ' entries / ' + mem.chars + ' chars for ' + payload.username);
    } else if (mem.reason !== 'owner_required' && mem.reason !== 'no_entries') {
      // 只有"异常类"原因才留痕；"没有 owner / 没有条目"是正常情况，不刷日志
      console.log('[Memory] not injected: ' + mem.reason);
    }
  }

  // 需求澄清门控状态：产出型动作前必须先澄清一次
  let clarifyDone = false;     // 是否已经跟用户对齐过需求
  let clarifyGateUsed = false; // 门控是否已拦截过（只拦一次，避免死循环）
  let clarifyCalls = 0;        // clarify_requirements 实际调用次数（硬上限 1 次，超过直接放行）
  // ★ 2026-10-16 补：request_material 原先**完全没有次数上限** —— 模型只要一直调它，
  //   就能一直 `await waitMaterial(...)` 阻塞 5 分钟，用户不提交素材就永远不干活。
  //   与 clarifyCalls 同款单轮硬上限 1 次（跨轮见 conversation 前缀判据）。
  let materialCalls = 0;       // request_material 实际调用次数（硬上限 1 次，超过直接放行）

  // 计划确认门控状态：动手前必须先给用户看计划并拿到确认（只拦一次，避免死循环）
  let planAcked = false;        // 是否已经拿到用户计划确认
  let planAckGateUsed = false;  // 计划确认门控是否已拦截过（只拦一次）
  let planAckTries = 0;         // 计划步骤不足时的回补次数（超限放行避免死循环）

  // 分阶段温度状态机：currentPhase 驱动本轮 fetch 的温度
  let currentPhase = 'planning'; // 首轮为规划/复述阶段（低温）
  let stepSeq = 0;              // 工具执行步骤计数（保留，但 step 事件已停发，仅供内部状态追踪）
  let lastPlanSteps = 0;        // 最近一次 request_plan_ack 的步骤数（保留，不再用于状态行）
  let searchCount = 0;          // 本任务已联网搜索次数
  let searchBlockCount = 0;     // 拦截计数，防死循环
  // 本任务内已被用户勾选「不再询问」的服务器键（runAgentLoop 内定义 ⇒ 每次新任务自动清空，即「本任务内」语义）。
  // 安全底线：任何服务器的**首次**调用不在集合里，必弹；只有用户在对该服务器的确认里勾选并允许后才写入。
  const confirmedTargets = new Set();
  const SEARCH_FIRST_SKILLS = new Set(['slides-generate', 'ppt-generate', 'excel-generate', 'docx-generate', 'pdf-generate', 'project-scaffold', 'miniprogram-scaffold', 'chart-generate', 'data-analyze']);
  const pickTemp = (phase) => {
    if (isShopping) return 0.3; // 购物场景固定低温：推荐更稳定、少发散，不因阶段温度而波动
    const base = tempForPhase(phase);
    if (requestedTemp == null) return base;
    if (phase === 'clarifying' || phase === 'planning') return Math.min(base, requestedTemp);
    return requestedTemp;
  };

  // 单任务轮数上限（可配：DOUYA_MAX_TURNS，默认 24）。与 token 预算**同性质**：都是"资源轴"，
  // 任何一条见底都要如实说"未完成"，绝不许降级成"已完成"。
  // ★ 2026-02-16 新增 `payload.maxTurns` 这一档：第二执行实例（delegate）必须**有界** ——
  //   它是"再来一次机会"，不是"再来一整个任务"。普通对话/主实例不带这个字段 ⇒ 行为一字不变。
  const MAX_TURNS = (() => {
    const pv = Number(payload && payload.maxTurns);
    if (Number.isFinite(pv) && pv > 0) return Math.floor(pv);
    const v = Number(process.env.DOUYA_MAX_TURNS);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 24;
  })();
  // ★ 2026-10-23【自查回灌的轮次预留】—— 老板第 3 条修改：「不要把 4 改成 6，先检查回灌条件」。
  //   病根（实测 task_mvkad091_9paio，24/24 轮、自查 3 轮全判未完成、status=done）：
  //     回灌条件只检查「自查还剩几轮」（reviewRounds < AGENT_REVIEW_MAX_ROUNDS=4），
  //     **从不检查主循环还剩几轮**。于是第 3 次 continue 后 turn 正好走到 24，for 循环直接退出，
  //     模型一句话都没机会说，用户也拿不到「还差什么」的清单。
  //   修法：回灌前必须预留「够说完 + 够复验」的轮次。值可配（DOUYA_REVIEW_RESERVE_TURNS），
  //     默认 2 = 与下面 4300 行「最后通牒」（turn >= MAX_TURNS - 2）同一个刻度，
  //     两处口径一致才不会出现「系统要求它收尾、同时又要它再干一轮」的自相矛盾。
  const REVIEW_RESERVE_TURNS = (() => {
    const v = Number(process.env.DOUYA_REVIEW_RESERVE_TURNS);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2;
  })();
  // 【执行记录 · 实际生效的资源轴】建 trace 时读不到 MAX_TURNS（TDZ），在这里补记**真正生效**的值。
  // 为什么值得单独记一条：事后查"为什么它在第 24 轮停了"，需要区分「撞轮数上限」与「模型自己收尾」，
  //   而这两个在 tasks.json 里都只是 status='done'。预算同理（600000 与用户改过的值差别很大）。
  try {
    taskTrace.record(taskId, 'task_config', {
      maxTurns: MAX_TURNS,
      tokenBudget: resolveTaskTokenBudget(cfg),
      intentMode: String(intentMode || ''),
      intentReason: String((intent && intent.reason) || ''),
      unattended: unattended === true,
      expert: String(payload.expert || ''),
    });
  } catch { /* 旁路 */ }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // ★ 2026-11-04：原来这里显式写死 `Access-Control-Allow-Origin: *`（writeHead 的显式头会压过
    //   `applyLocalCors` 用 setHeader 回显的白名单 Origin ⇒ 任务事件流对任何网页都可读）。
    //   删掉：AC-AO 统一由 applyLocalCors 决定（白名单回显 / 无 Origin 就不发）。
  });
  // 所有事件都走缓冲（带 seq），断线重连时按 seq 补发；写连接只在有客户端时发生。
  const send = (obj) => taskStream.push(stream, obj);

  // 进度只许前进，不许回跳（模型工具顺序可能乱序，回跳会让用户以为卡死）
  let lastProgress = 0;
  // meta（2026-09-22 新增，可选）：随 done 事件下发的收尾元数据。
  // 目前只带 unresolved = **未闭环的真失败数**。
  // 【2026-10-21】前端不再把它当折叠块标题：摘要降级为 <summary> 内的尾部灰字（App.jsx 的 tg-stepcount），
  //   标题固定为「处理过程」或终态人话。理由：deliveryProtocol.js 的 TOOL_CHURN_RE 本来就禁止
  //   把过程统计写进回答，渲染层却把「N 步其中 M 步没做成」放在最显眼的位置，属于自相矛盾。
  // 而不是拿它自己数出来的"事件级失败数"——前端那个计数只增不减（工具报错过就永远算），
  // 会把已经修好的步骤也报成问题。账本口径只在后端有，所以必须由后端下发。
  const sendPhase = (phase, label, progress, meta) => {
    lastProgress = Math.max(lastProgress, Number(progress) || 0);
    currentPhase = phase;
    send({ type: 'phase', phase, label, progress: lastProgress, ...(meta || {}) });
  };

  // 收尾「结论是否已补」标记（2026-09-17）：最多补一次，防死循环。
  let forcedSummaryDone = false;
  /**
   * ★ 2026-10-26：`finalizeWithText()` 补出来的那段结论（非空才写）。
   * 通用验收判「本次回复有没有实质内容」时用它兜底：模型这一轮一个字都没吐、靠兜底请求
   * 补了结论的任务，用户是真收到了回复的 —— 只看 `contentAcc` 会把它误判成空回复。
   */
  let finalizeTextOut = '';
  // 收尾兜底：强制模型只输出自然语言（不给 tools，模型无法再调工具），保证用户一定收到话
  // summaryOnly=true（2026-09-17 新增）：模型已经回过正文、但**没给结论**时用它 ——
  //   此时只补一段结论，明确要求「不要重复已经说过的话」，避免啰嗦重复。
  const finalizeWithText = async (summaryOnly) => {
    try {
      const resp = await fetch(upstreamURL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            ...conversation,
            {
              role: 'user',
              content: summaryOnly
                ? '（系统）你上面已经回过用户了，但**没有给出结论**，用户不知道到底改成了没有。'
                  + '请只补一段简短结论，**不要重复你已经说过的话**：'
                  + '①这次到底做了什么（对着用户最初的要求说）；②结果在哪（能直接打开的网址或文件）；'
                  + '③他怎么能确认真的生效了；④还有什么没做到。'
                  + '用大白话 3-5 句说完，**不要贴代码、命令、日志、报错原文或英文内容**，也不要再调用任何工具。'
                : '现在请先对照用户最初的需求逐条自检：①列出用户要什么；②逐项说明成果是否达成、文件落在哪个完整路径；③如有遗漏说明原因并尽量补做。自检完再用自然语言向我汇报（不要再调用任何工具）：做了什么、成果文件完整路径、怎么打开使用、下一步建议。',
            },
          ],
          ...(wantThink() ? { reasoning_effort: REASONING_EFFORT } : { reasoning_effort: 'none' }),
          temperature: isShopping ? 0.3 : tempForPhase('done'),
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const m = (data.choices && data.choices[0] && data.choices[0].message) || {};
        if (data.usage) addUsage(payload.username, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, { model, src: 'agent-finalize' });
        else addUsage(payload.username, 0, estimateTokens([{ content: m.content || '' }]), { model, src: 'agent-finalize' });
        if (m.reasoning_content) send({ type: 'reasoning', text: m.reasoning_content });
        const txt = String(m.content || '').trim();
        if (txt) {
          // ★ 2026-10-26【第三阶段】把兜底结论也记下来：通用验收要判"用户到底有没有收到实质回复"，
          //   而这条出口的正文**不在** `contentAcc` 里（那是本轮流式累积的，这里是另一路请求）。
          //   不记的话，"模型没吐字、靠兜底补了结论"的任务会被判成"空回复" —— 那是假红。
          finalizeTextOut = txt;
          await sendTextAsStream(txt);
          return true;
        }
      }
    } catch {}
    return false;
  };

  // 把一段文本按 OpenAI 流式格式分片推给前端（复用前端已有的打字机渲染）
  const sendTextAsStream = async (text) => {
    const str = String(text || '');
    const CHUNK = 24;
    for (let i = 0; i < str.length; i += CHUNK) {
      send({ choices: [{ delta: { content: str.slice(i, i + CHUNK) }, index: 0, finish_reason: null }] });
      await new Promise((r) => setTimeout(r, 12));
    }
  };

  // 中断收尾：绝不丢弃已完成的工作 —— 如实汇报「做了什么 / 停在哪 / 产出文件」，并落库成果卡。
  // 区分「用户主动停」（user/disconnect）与「超时」（timeout）两种语态。幂等：只收尾一次。
  let abortReported = false;
  const reportAbort = async (headOverride) => {
    if (abortReported) return;
    abortReported = true;
    try {
      const byTimeout = taskEntry.abortReason === 'timeout';
      // 1) 已产出的文件不白做：走已有的成果卡/落库路径
      if (deliverables.length) {
        try { appendDeliverables(deliverables, payload.username); } catch { /* ignore */ }
        send({ type: 'deliverables', items: deliverablesForUser(), workspace: AGENT_WORKSPACE });
      }
      // 2) 状态落盘（终态）
      taskEntry.current = { step: taskEntry.stepNo, skill: taskEntry.lastSkill || '', status: byTimeout ? 'timeout' : 'aborted' };
      // 【统一终态收尾 2026-10-23】精确出口必须**同时**更新 endStatus 与 terminalStateFinal。
      // 修前这里只写 tasks.json，`endStatus` 仍停在初值 'done' ⇒ trace 的 task_end.status 与
      // tasks.json 的 status 各说一套（实测 task_mvk9lihc：tasks.json=budget/aborted 而 trace=done），
      // 且没有任何 terminal 事件 ⇒ 事后审计「为什么结束」时两个记录互相矛盾。
      endStatus = byTimeout ? 'timeout' : 'aborted';
      terminalStateFinal = TERMINAL.PARTIAL;   // 中断/超时 = 没做完，但绝不是 COMPLETE
      terminalReason = byTimeout ? 'timeout' : 'aborted';
      persistTask(endStatus);
      // 3) 如实汇报进度
      const doneLog = taskEntry.doneLog || [];
      const doneText = doneLog.length
        ? doneLog.map((d) => '· ' + d.skill + '：' + (d.brief || (d.ok ? '完成' : '失败'))).join('\n')
        : '（还没有已完成步骤）';
      const arts = deliverables.map((d) => d.path);
      const artText = arts.length ? '\n已产出的文件（已保留，可直接打开）：\n' + arts.map((p) => '· ' + p).join('\n') : '';
      // ★ 2026-11-03 文案改口：先给结论（做到哪了 / 能不能用），再给**具体**的往下走的路。
      //   修前这两句把「你说一声」当唯一出路（"我接着干"/"说一声我重新开始"）——
      //   用户的原话是「最后没完成啥也不知道」，只被推回去再说一句话，等于没给任何信息。
      const tail = (doneLog.length || arts.length)
        ? '\n上面这些已经做完的部分可以直接用。往下有两条路，你挑一条就行：'
          + '① 让我换个做法重做（例如「换个方式再做一遍」）；② 指出上面哪一步不对，我只改那一步。'
        : '\n这次还没产出能直接用的东西。往下有两条路，你挑一条就行：'
          + '① 我换个思路重做一遍；② 你告诉我第一步先做什么，我从那里开始。';
      const head = headOverride || (byTimeout
        ? '（等不到你的回应，我先停下了）'
        : '（已按你的要求停下）我停在这里了，不会再继续下一步。');
      emitGateReport();   // 跳过的闸门走独立事件（前端折叠条），不再拼进正文
      await sendTextAsStream(head + '\n已完成：\n' + doneText + artText + tail);
      await appendPendingNote();
      sendPhase('done', byTimeout ? '已超时停止' : '已停止', lastProgress,
        { state: terminalStateFinal, reason: terminalReason });
    } catch { /* 前端可能已断开，收尾写流失败无所谓 */ }
  };
  // 闸门返回后 / 每个工具前的中断判据：命中断言则回灌一条 tool 结果并立刻收尾。
  const bailIfAborted = async (tc) => {
    if (!isAborted()) return false;
    if (tc && tc.id) conversation.push({ role: 'tool', tool_call_id: tc.id, content: '用户中断了本次任务。' });
    await reportAbort();
    return true;
  };
  // token 预算护栏：单任务累计 token 超预算即停止后续模型调用。
  // ★ 诚实话术：必须说「因超出 token 预算已停止」，**绝不**说成「已完成」。
  // 预算值按 cfg 解析（本次任务生效值），下面所有展示/记账/判定都统一用它，
  // 避免「判定用 A、记账用 B」导致台账与实际不符。
  const tokenBudget = resolveTaskTokenBudget(cfg);
  let budgetReported = false;
  // 上一轮的 prompt_tokens：仅在上游不返回缓存命中量时用于「增量法」计量（见 computeTurnCost）。
  let lastPromptTokens = 0;
  // 收尾模式：过了软阈值就置位，之后不再启动新的重资产动作、要求模型交出阶段成果 + 缺口声明。
  let wrapUpMode = false;
  // 收尾是**哪条轴**触发的（'stuck' / 'both' / 'turns' / 'budget'）：落盘取证，
  // 否则事后只知道"进过收尾"，不知道是结果不动还是资源见底。
  let wrapUpReasonUsed = '';
  // 结果轴阈值（轮）：MAX_TURNS 已可配 ⇒ 阈值必须跟着缩放，不能写死 12。
  // 下限 4：极端配置（DOUYA_MAX_TURNS=3）下不至于变成"第 1 轮就收尾"这种荒谬行为。
  const STUCK_AFTER_TURNS = Math.max(4, Math.floor(MAX_TURNS * STUCK_TURN_RATIO));
  const progressGateOn = process.env.DOUYA_PROGRESS_GATE !== '0';
  /**
   * 结果轴检测：窗口内「每轮都在动」但「交付物零增长」⇒ 判为原地打转（结果层没有实质进展）。
   * ⚠️ 只说"原地打转"，**不猜模型的内部动机**（用户明确要求过这一点）：
   *    `_probe*.py` 数量在变是事实，"模型乱搞"不是我们能从数据里读出来的结论。
   * ⚠️ 只用客观量，且**必须锚点在场**：用户没说要产出型成果（如"帮我看看这个"）时
   *    ⇒ 返回 false（无目标锚点就不判），**绝不退回"工具活动量"当进度判据**。
   * ⚠️ 「进度」有**三个**各自可核验的证据来源，不是只有一个（2026-10-23 重修）：
   *    ① 产物进度 —— 新交付物（arts 增长）或已有产物**内容真的变了**（artUpd）
   *    ② 验收进度 —— 一条**新的**检查跑出**有效结果**（newEv；命令+入参+结果全同 = 重复，不重复计）
   *    ③ 问题解决 —— 某检查项先前失败、现在通过（issClosed ⇒ 未解决问题减少）
   *    只看 ① 会把"认真验收"判成打转（实测 run-20261023050924：交付物落地后连续 12 轮验收）。
   *    只看"有没有执行命令"又会造出反向漏洞（反复写新脚本+重复跑同样检查永不触发收尾）。
   *    所以判据是这几条**任一**有真实增量 —— 纯操作（重复命令、同内容重写）四维度全 0，照旧判打转。
   */
  // >>> STALL_GATE_BEGIN（scripts/smoke/unit-stall-gate.mjs 按这对标记**抽取真实代码**在内存里跑）
  /**
   * 进度门的**锚点文本**：项目原始需求 + 本轮这句。
   *
   * 【2026-02-16 修 · 用户报障「继续」把检测关掉】
   *   修前 `noGoalProgress()` 的第一道 guard 只看 `lastUserText` —— 也就是**本轮**那句话：
   *     `if (!(WANTS_FILE_OUTPUT.test(lastUserText) && !READ_ONLY_HINTS.test(lastUserText))) return false;`
   *   用户被"我承认有问题、我接着做"折磨几轮之后，嘴上只能说的是「你继续」/「继续做」，
   *   而这种句子**一个产物名词都不含** ⇒ guard 立刻 return false ⇒ 打转/停滞检测**整条关闭**
   *   ⇒ agent 可以无限「承认问题 + 承诺继续」直到轮数用尽。用户原话：
   *     「复查完了就没有后续了.....我让他继续 他也承认有问题 但是就是不解决 也没有能力解决」
   *     「不能闭环就根本不能用 这个agent就没有用」
   *   ⇒ 锚点必须是「这个项目要什么」（原始需求）+「这一轮说什么」，而不是只有后者。
   *   同一个病在 `runtimeRequired` / `runtimeEvidence.setUserText` 那里已经治过一半
   *   （会用 `project.origin.text` 兜底），这里补上另一半，两处口径一致 —— 不再一个病两个治法。
   *
   * 代价方向（写清楚，免得以后有人把它"简化"回去）：
   *   · **漏判**（产出型任务被判成非产出型）= 检测被关掉 = 用户拿到无限"我接着做"。
   *     这正是本次报障，后果是「不能闭环就根本不能用」，不可接受。
   *   · **误判**（非产出型任务被判成产出型）= 该收尾时提前把"缺什么"说清楚。
   *     用户少的只是一条信息出现的位置，任务本身不受损。
   *   ⇒ 两害相权，**宁可多判**。
   *
   * @returns {{originText:string, currentText:string, anchor:string}}
   *   originText：项目原始需求（拿不到就是 ''）；currentText：本轮这句；anchor：拼起来的判定锚点。
   */
  const goalAnchorParts = () => {
    const originText = (project && project.origin && project.origin.text)
      ? String(project.origin.text) : '';
    const currentText = String(intentText || lastUserText || '');
    // 项目拿不到（project 为 null / 没有 origin）⇒ 退回本轮文本，行为与修前**完全一致**。
    // 这一条是"不许把老路径改坏"的硬线：老路径（无项目账本）上判定结果必须与修前逐字相同。
    return { originText, currentText, anchor: originText ? (originText + '\n' + currentText) : currentText };
  };
  /**
   * 锚点上「用户要不要产出型成果」的授权判定。
   * WANTS_FILE_OUTPUT：原始需求或本轮**任一**点名了要产出（网页/PPT/程序/店铺/宠物… 见词表）。
   * READ_ONLY_HINTS：排除"只是读一下"的只读任务（两道，方向仍是宁可多判）：
   *   ① 本轮这句本身就是只读请求（且没提产物）⇒ 不逼它产出；
   *   ② 原始需求就是只读任务、且本轮没提出**新的**产物诉求 ⇒ 整条任务仍是只读，
   *      保住老路径对只读任务的豁免（否则只读任务会被判成"该产出但没产出"）。
   */
  const anchorWantsFileOutput = () => {
    const { originText, currentText, anchor } = goalAnchorParts();
    // 两道产物信号，任一命中即可（都是**既有**判据，不在这里另造第三套词表）：
    //   ① WANTS_FILE_OUTPUT —— 防嘴炮窄表（网页/PPT/程序/脚本/作品…）；
    //   ② expectsRuntime(anchor) —— runtimeEvidence 的对象×动作判据，桌面形态（桌面宠物/桌宠/
    //      悬浮窗/托盘/exe/客户端…）只有它认得。**必须并上它**，否则本仓真实报障那句话
    //      「帮我做一个桌面宠物，蓝色小蜗牛」+「你继续」仍然漏判 —— 窄表里没有"宠物"，
    //      于是修了锚点还是关着门，等于没修。
    //   （`runtimeEvidence` 那边已经为这句话专门补过词表并把理由写死在那里，这里只消费它，
    //     不复制一份 —— 同一个语义养两套词表正是本仓反复踩过的坑。）
    const wants = WANTS_FILE_OUTPUT.test(anchor) || expectsRuntime(anchor);
    const currentOnly = WANTS_FILE_OUTPUT.test(currentText);
    const readOnly = (READ_ONLY_HINTS.test(currentText) && !currentOnly)
      || (READ_ONLY_HINTS.test(originText) && !currentOnly);
    return wants && !readOnly;
  };
  /**
   * 纯表态停滞窗口（轮）。
   * 为什么是 2：**单轮**只说话不动手是正常的（先思考、先答应、先问一句），判它必误伤；
   *   而连续 2 轮**一次工具都没调**、且未闭环失败数没有减少，在产出型任务里已经没有合理解释 ——
   *   那不是"正在做"，那就是在说"我接着做"。用户报障里最伤人的正是这种：
   *   「我承认有问题」「你说继续我就接着做」，说了 N 轮，一步没动。
   * （`winLen` 的硬下限也在 stallWindowNoAction 里再挡一次：< 2 一律不判。）
   */
  const STALL_NO_ACTION_TURNS = 2;
  /**
   * 本次 `noGoalProgress()` 是**哪一支**判停的：'' / 'stuck'（动了但没用）/ 'stall-no-action'（压根没动）。
   * ⚠️ 只用于**文案与 trace 事件名**，绝不用来扩充终态词表 —— `wrapUpReason()` 仍旧把它
   *   统一映射成 `'stuck'`，走那条已有的收尾出口。本仓历史上就因为"同一个任务两套词表"出过事故
   *   （见 `adjudicateTerminal` 上方的注释），不许再造 `reason='stall'` 这种新取值。
   */
  let lastNoProgressKind = '';
  const noGoalProgress = () => {
    lastNoProgressKind = '';
    if (!progressGateOn) return false;
    // ★ 锚点 = 项目原始需求 + 本轮这句（修前只看本轮 ⇒ 一句「继续」就把检测关掉了）。
    if (!anchorWantsFileOutput()) return false;
    const tr = taskEntry.turnTrace || [];
    // 支①「动了但没用」：需要足够长的窗口才看得清趋势。
    if (tr.length >= STUCK_AFTER_TURNS && stuckWindowLacksProgress(STUCK_AFTER_TURNS)) {
      lastNoProgressKind = 'stuck';
      return true;
    }
    // 支②「压根没动」：不需要看趋势，只看"一动不动" ⇒ 窗口短得多（STALL_NO_ACTION_TURNS）。
    if (stallWindowNoAction(STALL_NO_ACTION_TURNS)) {
      lastNoProgressKind = 'stall-no-action';
      return true;
    }
    return false;
  };
  /**
   * 窗口内「每轮都在动、也真的动过手，但四维度全无增量」⇒ 判为原地打转。
   * 抽成独立函数是为了让"重新规划闸"用**同一个**判据、只是换窗口长度，
   * 避免两处各写一套（那正是本仓反复踩过的"两套口径同一个任务"）。
   */
  const stuckWindowLacksProgress = (winLen) => {
    const tr = taskEntry.turnTrace || [];
    if (tr.length < winLen) return false;
    const win = tr.slice(-winLen);
    const before = tr.length > winLen ? tr[tr.length - winLen - 1].arts : 0;
    const active = win.every((e) => e.tools > 0);      // 每一轮都在动（不是闲着等）
    // ★ 关键区分位：窗口内**真的动过手写过东西**（file-write/shell-exec/…）。
    //   没有这一条，"用户说要报告 + 连搜 12 轮"的**正常调研**会被误判成打转。
    const didWrite = win.some((e) => e.wrote > 0);
    // ── 四维度：任一有真实增量就不算打转 ──
    const artGrew = win.some((e) => e.arts > before);
    const artUpdated = win.some((e) => (e.artUpd || 0) > 0);
    const newEvidence = win.some((e) => (e.newEv || 0) > 0);
    const issuesClosed = win.some((e) => (e.issClosed || 0) > 0);
    // ★ ④工程进度：非过程脚本的文件新增 / 内容真变。**故意不看 isRealArtifact**
    //   （理由见 codeHash 上方那段实测根因）——代码工程型任务里"写了一堆源码"是实打实的进展，
    //   但那些扩展名在显示轴上一条都不算，修前就是靠这条漏判把任务按进收尾的。
    //   注意它**不能**退化成"只要 wrote>0 就算进展"：那与 didWrite 重复 ⇒ 闸门永不触发。
    //   分辨力全部来自 codeHash 的"内容指纹变了没"，同内容重写照样不记。
    const codeGrew = win.some((e) => (e.codeNew || 0) > 0 || (e.codeUpd || 0) > 0);
    const progressed = artGrew || artUpdated || newEvidence || issuesClosed || codeGrew;
    return active && didWrite && !progressed;
  };
  /**
   * 窗口内「一次手都没动」（工具调用累计为 0）且**未闭环失败数没有减少** ⇒ 判为停滞。
   *
   * 与 `stuckWindowLacksProgress` 的区别（两支必须并列，不能互相取代）：
   *   · 那个判「动了但没用」—— 前提是 `tools > 0`（每轮都在动手）；
   *   · 这个判「压根没动，只在说话」—— 前提恰恰是 `tools === 0`。
   * 修前只有前一支 ⇒ **越是只表态不动手，越检测不出来**：`active` 要求"每轮工具调用数 > 0"，
   * 纯表态轮 `tools=0` ⇒ `active=false` ⇒ 永不判打转。也就是说原判据方向装反了一格：
   * 它抓的是"忙而无功"，却放过了用户报障里真正伤人的那种 ——
   * 「我承认有问题」「你说继续我就接着做」，一步没动，说十轮也不会被判停。
   *
   * 三条判据全满足才判停滞：
   *   ① 窗口满（`tr.length >= winLen` 且取到 winLen 条）；
   *   ② 窗口内**每一轮**工具调用都是 0（有一轮动过手就不是"压根没动"）；
   *   ③ 未闭环失败数在本窗口内**没有减少**（首轮读数 vs 末轮读数；没有读数时按"没减少"处理 ——
   *      宁可多判：缺读数不该成为免死金牌）。
   *
   * 防误伤（每条都对应一个真实形态，删掉就会造出假红）：
   *   · `winLen >= 2`：单轮纯文本是**正常思考**，不许判；
   *   · 窗口内有任一轮 `wrote > 0`（写过文件）⇒ 立刻不判：那是"写完了在汇报"，不是停滞；
   *   · 未闭环数减少了 ⇒ 不判：哪怕只是嘴上说，问题真的在收敛就不是停滞。
   *
   * @param {number} winLen 窗口轮数（调用点传 STALL_NO_ACTION_TURNS）
   * @returns {boolean} true = 判为纯表态停滞
   */
  const stallWindowNoAction = (winLen) => {
    // ⚠️ 这里**不许**留任何 env 开关 / 诊断短路（曾经有过 `DOUYA_STALL_ANTI`，2026-02-16 已删）。
    //   理由：这是一条拦住 agent 无限打转的判据，一旦被环境静默关掉，用户就又回到
    //   「他承认有问题但就是不解决」；而真机上这类变量很可能被"按文档试一次诊断"之后忘删，
    //   届时没有任何提示、打转检测整条失效，**门禁还是绿的**。
    //   反控臂改在 `scripts/smoke/unit-stall-gate.mjs` 里**变异本函数这段真源码字符串**（只在测试
    //   进程内存里，不落盘）—— 判据能不能被分辨由测试证明，而不是靠产品代码里的逃生口。
    const len = Number(winLen);
    if (!Number.isFinite(len) || len < 2) return false;   // 单轮 / 非法窗口：一律不判
    const tr = taskEntry.turnTrace || [];
    if (tr.length < len) return false;                    // 窗口没满
    const win = tr.slice(-len);
    if (!win.length) return false;
    // ① 窗口内每一轮工具调用都是 0（`|| 0` 兼容老记录缺字段）
    if (!win.every((e) => ((e && e.tools) || 0) === 0)) return false;
    // ② 窗口内没写过任何文件：写过就是在出活，"汇报型"轮次不许判停滞
    if (win.some((e) => ((e && e.wrote) || 0) > 0)) return false;
    // ③ 未闭环失败数没有减少
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const firstOpen = num(win[0] && win[0].issOpen);
    const lastOpenRaw = num(win[win.length - 1] && win[win.length - 1].issOpen);
    // 末轮缺读数时退回**实时账本**（末轮就是"现在"）—— 仍然缺才按"没减少"处理。
    const lastOpen = lastOpenRaw === null ? openFailures().length : lastOpenRaw;
    const shrunk = firstOpen !== null && lastOpen !== null && lastOpen < firstOpen;
    if (shrunk) return false;
    return true;
  };
  // <<< STALL_GATE_END
  /** 判据的**读数**（写进 trace / 日志，让"为什么这么判"事后可核验，而不是只有一句结论） */
  const stuckWindowFacts = (winLen) => {    const tr = taskEntry.turnTrace || [];
    const win = tr.slice(-winLen);
    const before = tr.length > winLen ? tr[tr.length - winLen - 1].arts : 0;
    const sum = (k) => win.reduce((s, e) => s + (e[k] || 0), 0);
    return {
      win: winLen,
      active: win.length > 0 && win.every((e) => e.tools > 0),
      didWrite: win.some((e) => e.wrote > 0),
      artGrew: win.some((e) => e.arts > before),
      artUpdated: sum('artUpd'),
      // ④ 工程进度：非过程脚本文件的新增 / 内容真变。
      //   必须单独报出来（而不是并进 artUpdated）：这两个读数是判据第 ④ 维的**唯一**证据，
      //   缺了它们，事后看到 `progressed=false` 时无法分辨"真没进展"还是"又判错了轴"。
      codeNew: sum('codeNew'),
      codeUpdated: sum('codeUpd'),
      newEvidence: sum('newEv'),
      // 其中有多少是**弱证据**（没有工作流标准、只按"有读数"宽判的）。
      // 为什么必须报出来：`newEvidence` 混着强弱两种，只报合计数的话，
      //   判据一旦退化成"什么都有读数"，收尾读数看上去照样"有进展"，没人能发现。
      newEvidenceWeak: sum('newEvWeak'),
      issuesClosed: sum('issClosed'),
      verifyActions: sum('vf'),
      issuesOpen: issueOpen.size,
    };
  };
  /**
   * 重新规划闸的**入场时机**：不让它在任务刚起手时就插嘴。
   * 前 30% 的轮次本来就是"摸索期"，那时没进展是正常的；过早训话只会打断正常开工。
   */
  const replanAllowTurn = (turn) => Number(turn) >= Math.max(4, Math.floor(MAX_TURNS * 0.3));
  const isOverBudget = () => (taskEntry.usedTokens || 0) >= tokenBudget;
  /** 是否已进入收尾区（软阈值）。硬闸门是悬崖，软阈值才是能"带着产出落地"的那条路。 */
  // 返回**触发收尾的原因**（而不是 bool）：文案必须如实说清是哪条资源轴见底了 ——
  // 否则轮数触发时却说"token 预算已用到 75%"，那是**说假话**（本仓明令禁止）。
  // ★ 2026-09-24 由 shouldWrapUp() 改名而来：两条资源轴（轮数 / token）取"先到者"。
  const wrapUpReason = (turn) => {
    if (wrapUpMode) return null;
    // ★ 结果轴优先级最高：资源还没见底但**结果一直不动**时，最该说实话的是"没进展"，不是"预算还够"。
    if (noGoalProgress()) return 'stuck';
    const byTurn = Number(turn) >= MAX_TURNS * TURN_WRAPUP_RATIO;
    const byBudget = tokenBudget > 0 && (taskEntry.usedTokens || 0) >= tokenBudget * BUDGET_WRAPUP_RATIO;
    return (byTurn && byBudget) ? 'both' : byTurn ? 'turns' : byBudget ? 'budget' : null;
  };
  // ★ 唯一的终态判定入口（关键：backend 里 classifyTerminalState 调用点**只许有一处**）。
  //   本函数有两条收尾出口 ——「预算停止」与「正常收尾」。两条出口**必须共用同一次判定**，
  //   否则就是"另算一套"：出现两套词表/两份口径，同一个任务会有两个终态。
  //   2026-09-23 二次修前的实际缺陷：预算出口自己手拼 ①② 文案，判定器 require 进来却**零调用**
  //   ⇒ 终态从没被算过、UI 也无从渲染（只能拿工具历史猜"做完了没"）。现在两条出口都走这里。
  // ★ 2026-09-24：`lastClaimEval` 保存**同一次**结论证据判定的结果，供收尾文案如实解释
  //   （"为什么不能说完成"）。它是判定的**留痕**，不是第二套判定 —— 判定本身只在下面这一处。
  let lastClaimEval = null;
  const adjudicateTerminal = (o) => {
    const src = o && typeof o === 'object' ? o : {};
    let st = classifyTerminalState({
      hasDeliverables: !!src.hasDeliverables,
      artifactsOk: src.artifactsOk,
      bailOutHit: !!src.bailOutHit,
      blockedEvidenced: !!src.blockedEvidenced,
    });
    // >>> BUDGET_TERMINAL_GATE_BEGIN（单测按这对标记**抽取真实代码**在内存里跑，不抄副本）
    // 预算停止（noVerification）⇒ 没有任何验证动作跑过 ⇒ 规范 §三的「已验证」不成立 ⇒ 不许 COMPLETE。
    // （删掉这一行，预算出口就会拿"停止"冒充"完成" —— 那正是要防的假绿。）
    if (src.noVerification && st === TERMINAL.COMPLETE) st = TERMINAL.PARTIAL;
    // <<< BUDGET_TERMINAL_GATE_END
    // >>> CLAIM_EVIDENCE_GATE_BEGIN（unit-delivery-protocol.mjs D21 按这对标记**抽取真实代码**在内存里跑）
    // 【结论证据与反证门】2026-09-24：在宣布 COMPLETE 之前，先证明「我准备声称的事情是真的」。
    // 规范 §三 早写了「已验证」才配 COMPLETE，但那句话此前没有可执行的门 —— 这一段就是那道门。
    // ★ 判定**只在这一处**（两条收尾出口都只是把真实信号 claimCtx 递进来，不各算一套）。
    // ★ 顺序即语义（与 deliveryProtocol.verifyClaim 的四态同源）：
    //     DISPROVED（反向检查已推翻）> UNVERIFIED（证据不足）> BLOCKED（环境验不了，缺口不是失败）。
    //     —— 前两者都不许 COMPLETE；BLOCKED 只在"确实需要用户介入"时才用它，否则同样降 PARTIAL
    //        （**不许把"验不了"伪装成"完成"**，也不许把"验不了"一律说成"失败"）。
    // ★ claimGateEnabled() 参与同一条判定：关掉开关 ⇒ 本降级不发生（单测的对照组）。
    const claimEval = claimGateEnabled() ? verifyCompletionClaims(buildClaimContext(src.claimCtx)) : null;
    // 把**同一次**判定的结果留给收尾文案用（不是重算一遍：重算就是两套判定，迟早漂移）。
    lastClaimEval = claimEval;
    if (st === TERMINAL.COMPLETE && claimEval) {
      if (claimEval.hasDisproved) st = TERMINAL.PARTIAL;
      else if (claimEval.hasUnverifiedCritical) st = TERMINAL.PARTIAL;
      else if (claimEval.hasBlockedCritical) st = src.blockedEvidenced ? TERMINAL.BLOCKED : TERMINAL.PARTIAL;
    }
    // <<< CLAIM_EVIDENCE_GATE_END
    // >>> BLOCKED_DIAG_UPGRADE_BEGIN（unit-blocked-wiring.mjs 按这对标记抽取真实代码在内存里跑）
    // 【第四档 · 有诊断的阻塞】2026-02-16
    // 为什么放在这里（两条 BLOCKED 来源之后）：
    //   ① classifyTerminalState 在 blockedEvidenced 时返回 BLOCKED；
    //   ② 上面的 CLAIM_EVIDENCE_GATE 在 hasBlockedCritical 时也可能改成 BLOCKED。
    //   升级必须覆盖两者，所以不能塞进任何一个标记块内部（那样抽取到的真代码就不是这一段了）。
    // 语义：同样是"卡住了"，但这一次模型给出了**可复现**的诊断 —— 复现命令在本任务里真的跑过
    //   ≥2 次、每次都复现同一个失败。它**不是完成**，也**不是失败**，算一次有效交付。
    // ★ 输入从哪来：`src.blockedDiagnosed` 由**唯一终态判定入口的调用点**算好传进来
    //   （backend.js 正常收尾出口，`classifyBlockedDiagnosis({content, toolEvents: toolExecLog})`）。
    //   为什么不在本函数内部算：本函数被**两条收尾出口**共用，而"诊断取证"只对正常收尾出口
    //   有意义（预算出口连 bailOut 都没测）⇒ 在本函数里算等于凭空给预算出口造一份证据。
    //   ⇒ 本函数只做**纯升级**，不做取证；取证失败/没算（字段缺）一律当"没诊断"。
    // ⚠️ 只升不降：只把 BLOCKED 升成第四档，绝不把任何状态升成 COMPLETE
    //   （下面单测的 S4 组就是拿 COMPLETE / PARTIAL 打这条的单向阀）。
    if (st === TERMINAL.BLOCKED && src.blockedDiagnosed === true) st = TERMINAL.BLOCKED_WITH_DIAGNOSIS;
    // <<< BLOCKED_DIAG_UPGRADE_END
    // >>> RECOVERY_REVERIFY_GATE_BEGIN（unit-recovery-executor.mjs 按这对标记**抽取真代码**在内存里跑）
    // 契约②（2026-10-05）：恢复动作下发之后**始终没拿到复验读数** ⇒ 不许把"恢复器说自己好了"
    //   当成恢复成功 ⇒ 不许 COMPLETE。这是单向阀：只会把 COMPLETE 压到 PARTIAL，
    //   绝不会把任何东西抬成 COMPLETE（恢复器永远不能宣布完成）。
    if (src.recoveryUnverified && st === TERMINAL.COMPLETE) st = TERMINAL.PARTIAL;
    // <<< RECOVERY_REVERIFY_GATE_END
    // >>> MEMORY_NONBLOCKING_GATE_BEGIN（unit-memory-write-wiring.mjs 按这对标记**抽取真实代码**在内存里跑）
    // 【记忆不阻塞门 · R5 的运行时载体】B 阶段 #252
    // 记忆是旁路：**记忆侧的任何状态都不许改任务终态**。
    // ★ 为什么这行看起来"没用"却必须存在：
    //   memoryAffectsTaskOutcome() 恒返回 false，所以这个 if **永远不会进**。
    //   但它的价值不在运行时行为，而在**把一条纪律变成可被门禁钉住的控制逻辑**：
    //     · 没有它 ⇒ "记忆不影响终态"只是注释里的一句话，谁都可以在下面塞一行
    //       `if (memOutcome.error) st = TERMINAL.PARTIAL` 而门禁**看不出来**。
    //     · 有它 ⇒ 门禁可以断言"唯一终态入口里，记忆的影响被显式问过且答案恒为否"，
    //       于是任何人再想加记忆→终态的影响，都得先面对这个函数的返回值。
    //   ⚠️ 判据自身也要自证：门禁 W2c 断言"这里真的调用了它"，W2b 断言"结果没流进 st"。
    //      两者一起才构成"接线了 + 且没被绕过"，只测其一是假绿。
    if (memoryAffectsTaskOutcome() && st === TERMINAL.COMPLETE) st = TERMINAL.PARTIAL;
    // <<< MEMORY_NONBLOCKING_GATE_END
    return st;
  };
  // 【执行记录 · 终态】把"最终判成什么、依据是什么、当时的读数是多少"记下来。
  // ★ 为什么必须记：审计发现 tasks.json 里 `status` 与 `terminalState` 是**两套**——
  //   正常收尾即使终态是 PARTIAL，落盘的 status 仍写 'done'（终态只通过 sendPhase 发给 UI）。
  //   于是"这个任务到底完成没有"这个问题，事后读记录得到的答案是错的。
  // ★ 为什么不改 adjudicateTerminal 内部：那里夹着两组门禁标记块（MEMORY_NONBLOCKING_GATE /
  //   RECOVERY_REVERIFY_GATE），单测按 indexOf(begin)..indexOf(end) 抽取真代码在内存里跑。
  //   往标记里塞东西会让"抽取到的真代码"和"实际运行的代码"不再是同一段 —— 那正是本项目最忌讳的假绿。
  //   所以只在**调用点**记，一行不改它的内部。
  const traceTerminal = (st, reason, facts) => {
    try { taskTrace.terminal(taskId, { state: st, reason, facts }); } catch { /* 旁路 */ }
    // 【统一终态收尾 2026-10-23】打上「已记过」标记：finally 里的兜底补记据此避免重复。
    // 有些出口（中断/超时/异常/上游失败）修前一条 terminal 都不写，事后无法归因。
    terminalTraced = true;
  };
  const reportBudget = async () => {
    if (budgetReported) return;
    budgetReported = true;
    try {
      // 1) 已完成成果不白做
      if (deliverables.length) {
        try { appendDeliverables(deliverables, payload.username); } catch { /* ignore */ }
        send({ type: 'deliverables', items: deliverablesForUser(), workspace: AGENT_WORKSPACE });
      }
      // 2) 落盘终态 + token-usage 记账（budgetExceeded:true，便于事后查账）
      taskEntry.current = { step: taskEntry.stepNo, skill: taskEntry.lastSkill || '', status: 'budget-exceeded' };
      // 【统一终态收尾 2026-10-23】同 reportAbort：精确状态必须同步进 endStatus，
      // 否则 trace 的 task_end.status 仍是 'done'，与 tasks.json 的 'budget-exceeded' 冲突。
      endStatus = 'budget-exceeded';
      terminalReason = 'budget-exceeded';
      persistTask(endStatus);
      try { addUsage(payload.username, 0, 0, { budgetExceeded: true, taskId, usedTokens: taskEntry.usedTokens || 0, budget: tokenBudget }); } catch { /* ignore */ }
      // ★ 2026-09-23 修（老板点名的三处，缺一不可）：
      //   ① 原实现把 doneLog **全量**塞进「已完成：」标题下（含 ok:false 的失败项）⇒
      //      用户读到的就是「刚说完成、又说停止」这种自相矛盾。现在**成功与未闭环分开列**。
      //   ② openFailures() 早就在上面定义好了，却**从没在这条路径上被调用过** ⇒
      //      信号只被声明、从未进控制逻辑。这里真正调用它。
      //   ③ unresolved 必须随 done 事件下发（对齐正常收尾那条路径），
      //      否则前端只知道「停了」、不知道「还有几件事没闭环」，会把中断渲染成完成。
      const doneLog = taskEntry.doneLog || [];
      const okSteps = doneLog.filter((d) => d && d.ok);
      const openList = openFailures();
      const doneText = okSteps.length
        ? okSteps.map((d) => '· ' + d.skill + '：' + (d.brief || '完成')).join('\n')
        : '（这次没能做完任何一步）';
      const arts = deliverables.map((d) => d.path);
      const artText = arts.length ? '\n\n已产出的文件（已保留，可直接打开）：\n' + arts.map((p) => '· ' + p).join('\n') : '';
      // ★ 终态：把「判决」和「清单」分开，而且**两样都必须真算出来**（2026-09-23 二次修）
      //   上一版这里是**手拼文案**：①② 是写死的字符串，而判定器 import 了却**零调用** ⇒
      //   状态从没被算过，UI 也无从"拿最终状态渲染"（只能退回工具历史计数）。这就是"写了≠接线"。
      //   现在：① 缺口清单交给 buildDeliveryGap 产出；
      //        ② 三态判决复用**唯一**那支规范状态机 classifyTerminalState（不在此另立词表）；
      //        ③ 补一条预算路径专属门禁：预算停止时**没有任何验证动作跑过** ⇒ 规范 §三的
      //          「已验证」不成立 ⇒ 一律不许 COMPLETE（否则等于拿"停止"冒充"完成"）。
      const gap = buildDeliveryGap({
        expected: okSteps.length + openList.length,
        delivered: okSteps.length,
        unresolved: openList.length,
        verifyGap: wrapUpMode ? '收尾模式下不再启动重资产验证（如浏览器渲染），这部分未验证' : '',
      });
      const gapLines = gap.gap.map((g) => '· ' + g);
      for (const d of openList) gapLines.push('· ' + d.skill + '：' + (d.brief || '失败'));
      const gapText = gapLines.length ? gapLines.join('\n') : '（本次没有未闭环的步骤）';
      // 终态走**唯一**入口 adjudicateTerminal（noVerification:true ⇒ 未验证 ⇒ 不许 COMPLETE）
      const terminalState = adjudicateTerminal({
        hasDeliverables: deliverables.length > 0,
        artifactsOk: deliverables.length > 0,
        noVerification: true,
        // 契约②：预算这条出口同样要检查"恢复动作有没有拿到复验读数"（两条出口共用同一次判定）。
        recoveryUnverified: recoveryUnverifiedNow(),
        // 结论证据与反证门：预算停止这条出口同样要证明"我准备声称的事情是真的"。
        // 这里没有跑 verifyDeliverables（已停止），所以产物只按"存在"记 —— 而 noVerification
        // 本身已经把终态压到 PARTIAL，本段的职责是让两条出口**共用同一次判定**（不许各算一套）。
        claimCtx: {
          deliverables,
          artifactsOk: true,
          completionClaimed: true,
          // 与正常收尾出口**同一判据**（2026-10-21）：原来这里是 `deliverables.length > 0`，
          // 于是预算停止这条出口会把 check_deck.js 当成「交付物声明」⇒ 生成「产物可以交付」
          // 结论 ⇒ 缺产物证据 ⇒ UNVERIFIED。两条出口各写一套判据必然漂移，
          // 而漂移的形态正是老板看到的「卡上只有脚本、结论却说缺产物」。
          deliverableClaimed: deliverables.some((d) => isRealArtifact(d && d.path, lastUserText)),
          userText: lastUserText,   // 判据必须在两处一致，否则两条出口会判出不同结论
        },
      });
      // 【统一终态收尾 2026-10-23】把这条出口算出的终态**交给统一收尾**（而不是只发个事件就丢），
      // 否则 finally 里的归一拿不到它，只能退化成按「预算耗尽」硬编码。
      terminalStateFinal = terminalState;
      // 前端可见提示：把「还有几件没闭环」+ **终态**一并下发（此前只报 used/budget，
      // 前端就算想如实渲染也无从得知未闭环数，更不知道终态是什么）
      send({ type: 'budget_exceeded', used: taskEntry.usedTokens || 0, budget: tokenBudget, unresolved: openList.length, stopped: true, state: terminalState });
      traceTerminal(terminalState, 'budget-exceeded', {
        usedTokens: taskEntry.usedTokens || 0, budget: tokenBudget,
        unresolved: openList.length, deliverables: deliverables.length,
      });
      emitGateReport();   // 跳过的闸门走独立事件（前端折叠条），不再拼进正文
      await sendTextAsStream(
        '（因超出单任务 token 预算已停止）已用约 ' + (taskEntry.usedTokens || 0) +
        ' / 预算 ' + tokenBudget + ' token。\n'
        + '**终态：' + terminalLabel(terminalState) + '**\n\n'
        + '**① 交付了什么**\n' + doneText + artText + '\n\n'
        + '**② 还缺什么**\n' + gapText + '\n'
        + '验证层级：**未验证**（预算停止时不再启动新的验证动作）。\n\n'
        // ★ 2026-11-03：原来只有一句「说一声我接着做」—— 用户读完仍然不知道手上的东西能不能用。
        //   现在先说清「预算用完了但已完成的不受影响」，再给出两条可执行的路（拆小任务 / 换个做法）。
        + '预算已经用完了，上面「交付了什么」里的东西是完整的、可以直接打开用；'
        + '剩下「还缺什么」的部分在这个任务里做不下去了。往下两条路：'
        + '① 把剩下的拆成一个更小的新任务交给我（预算重新计）；② 让我换个做法重做这一整件。'
      );
      await appendPendingNote();
      // 标签保留原标题（有测试断言该短语），只在后面追加「还有几件没闭环」——
      // 让「停止」不被读成「完成」（原实现二者混在一句里，正是老板读到矛盾感的来源）。
      sendPhase('done',
        '因超出 token 预算停止' + (openList.length ? '（还有 ' + openList.length + ' 件没闭环）' : ''),
        lastProgress,
        { unresolved: openList.length, stopped: true, reason: 'budget-exceeded', wrappedUp: wrapUpMode, state: terminalState, gap: gap.gap });
    } catch { /* ignore */ }
  };

  sendPhase('planning', '规划任务', 8);

  const pipeStream = async (resp) => {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  };

  // ===== 第四层：受控并行编排 —— 整轮门控 =====
  // 返回 { parallel, reason }。**只有全部满足**才允许并行，否则整体走下方串行路径（行为一字不变）：
  //   ① 本轮工具数 >= 2；② 无 META 工具（要 await wait* 并改前端单值 state，与并行天然互斥）；
  //   ③ 无 CONFIRM_TOOLS（需用户在场确认，必须逐条挂起）；④ 无 SEARCH_FIRST_SKILLS（门控靠 searchCount）；
  //   ⑤ 全部在白名单 PARALLEL_SAFE_TOOLS 内（当前仅 web-fetch ⇒ 混合轮次一律串行，这是最简单的安全边界）。
  const planParallel = (calls) => {
    if (!Array.isArray(calls) || calls.length < 2) return { parallel: false, reason: 'single-tool' };
    const names = calls.map((tc) => (tc && tc.function && tc.function.name) || '');
    if (names.some((n) => META_TOOL_NAMES.has(n))) return { parallel: false, reason: 'meta-tool' };
    if (names.some((n) => CONFIRM_TOOLS.has(n))) return { parallel: false, reason: 'confirm-tool' };
    if (names.some((n) => SEARCH_FIRST_SKILLS.has(n))) return { parallel: false, reason: 'search-first' };
    if (names.some((n) => !PARALLEL_SAFE_TOOLS.has(n))) return { parallel: false, reason: 'mixed-turn' };
    // ⑥ 意图闸门（2026-09-23）：本轮只要有一个技能在当前意图下不被允许，就**强制走串行** ——
    //    串行路径会逐条拦下。这是纵深防御：当前 PARALLEL_SAFE_TOOLS 只含只读的 web-fetch，
    //    并行本来是安全的；但万一将来白名单扩大，这里能保证并行分支不会变成绕过闸门的旁路。
    if (names.some((n) => !isSkillAllowed(n, intentMode).allowed)) return { parallel: false, reason: 'intent-gate' };
    return { parallel: true, reason: 'all-web-fetch' };
  };

  // ===== 第四层：受控并行执行（仅 web-fetch，并发度 PARALLEL_LIMIT）=====
  // 保序铁律：结果按 toolCalls **原下标**缓存；join 后**按原序**依次发 __tool_result__ / trackDeliverable /
  // conversation.push / markStep。理由（侦察确认的竞态）：markStep 会 push taskEntry.doneLog，
  // 而这份履历经 buildTaskStateSummary 回灌给模型 —— 若按「完成顺序」写，用户「继续」时看到的步骤顺序就乱了。
  // searchCount 同理：并发内自增会乱序/漏计，改为 join 后按「本轮 web-fetch 成功数」一次性累加。
  const runParallelTurn = async (calls, fr) => {
    const n = calls.length;
    // 参数解析 + 事件 id 预计算（tc.id 缺失时退回 genId('tool')，保证 __tool__ 与 __tool_result__ 同 id）
    const parsed = calls.map((tc) => {
      const fn = (tc && tc.function) || {};
      // 与串行路径同源：走统一协议解析参数，不再 `catch { params = {} }` 静默清空（截断是实测真根因）
      // fr 由调用点把本轮的 finish_reason / completion_tokens 传进来（本函数定义在主循环之外，拿不到那个作用域）
      const _na = normalizeToolArgs(fn.arguments, skills.find((s) => s.id === (fn.name || '')), { finishReason: (fr && fr.finishReason) || '' });
      return {
        name: fn.name || '',
        params: _na.params,
        evtId: (tc && tc.id) || genId('tool'),
        argsInfo: {
          problem: _na.problem, canExecute: _na.canExecute, missing: _na.missing, reason: _na.reason,
          finishReason: (fr && fr.finishReason) || '', completionTokens: (fr && fr.completionTokens) || 0,
          lengthHit: _na.lengthHit, rawLength: _na.rawLength,
        },
      };
    });
    // 1) 启动阶段（无 await）：阶段事件 + __tool__「正在调用」。两条的 id 严格一致。
    for (let i = 0; i < n; i++) {
      const { name, evtId } = parsed[i];
      const ph = phaseOfTool(name);
      const actionLabel = skillAction(name) || ph.label;
      sendPhase(ph.phase, actionLabel, ph.progress);
      stepSeq++;
      send({ __tool__: name, label: actionLabel, silent: SILENT_TOOLS.has(name), id: evtId });
    }
    // 2) 并发执行：手写 PARALLEL_LIMIT 槽位调度（零依赖）。每个任务各自 try/catch，
    //    任一失败只写进自己的 outcomes[i]，绝不让整组 reject。
    const outcomes = new Array(n).fill(null);
    let nextIdx = 0;
    const worker = async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= n) return;
        const { name, params, argsInfo } = parsed[i];
        // ===== 熔断闸（2026-10-22 补齐）：串行路径一直有，**并行路径从来没有** =====
        // 缺口是怎么发现的：`toolBreaker.allows()` 全文件原本只有一处调用（串行），
        //   而并行路径的 `governToolResult` 同样在 `toolBreaker.fail()` 计数 ——
        //   也就是说并行路径**会记账却不会执法**：计数涨到上限、熔断态置位，
        //   但并行分支从不查，于是同一个"本机跑不起来"的工具会被继续并行派发。
        // 为什么这条不能只靠"凑巧不会并行"来兜：web-fetch 一轮可发 2 个，同一工具
        //   连发两次就正好踩中 max=2。
        if (!toolBreaker.allows(name)) {
          const tripInfo = {
            name, kind: toolBreaker.kindOf(name),
            count: toolBreaker.openCount(name), max: toolBreaker.max,
          };
          recordSkip('工具熔断', name, '已连续失败 ' + tripInfo.count + ' 次');
          outcomes[i] = {
            name, params, result: breakerDirective(tripInfo), argsInfo,
            skippedByGate: true, gateReason: '工具熔断',
          };
          continue;
        }
        // ===== 同策略升级硬拦截（与串行路径同一判据、同一位置纪律）：执行前拦下，不真正执行 =====
        const recPlan = planRecoveryGate(name, params);
        if (recPlan.blocked) {
          recoveryLog.push(recoveryExecutor.record({ action: recPlan.action, result: 'dispatched', evidence: recPlan.evidence }));
          reverifyPending = true;
          recoveryVerified = false;
          recordSkip('同策略升级', name, recPlan.evidence.reason);
          // ★★ 2026-10-22 修双重记账：这个 directive 是**我们说给模型的话**，不是工具的执行结果。
          //   join 段原来把它无条件喂给 `governToolResult` ⇒ 被当成一次**新的失败**再记一遍
          //   （实测：directive 文本里含"网络"⇒ 分类成 UPSTREAM ⇒ toolLedger +1、toolBreaker +1），
          //   于是**同一次失败被记两次**，熔断与策略升级都提前触发 —— 而台账上看起来毫无异常。
          //   打上 skippedByGate，让 join 段走"不记账、但要如实说没执行"的支路（与串行路径同形）。
          //   顺带修掉第二个后果：directive 开头不是失败前缀 ⇒ `isFailureResult` 判 false ⇒
          //   原来这次"根本没执行"的调用会被 markStep 记成**成功**。
          outcomes[i] = { name, params, result: recPlan.directive, argsInfo, skippedByGate: true, gateReason: '同策略升级' };
          continue;
        }
        // ===== ★★ 新建交付物授权门（与串行路径同一判据、同一位置纪律）=====
        // ★ 本路径的记账形态与串行不同：这里只能写 outcomes[i]（join 段再统一落 conversation），
        //   所以必须带 `skippedByGate: true` —— 否则 join 段会把 directive 当成**成功结果**
        //   （directive 开头不是失败前缀 ⇒ isFailureResult 判 false）。这是 RC 反控 D2 盯的那一格。
        // ★ 2026-11-11 夜：`target` / `pathExists` 改由 `producerTarget` 统一解析 ——
        //   原来这里写的是 `(params && params.path) || ''`，对 docx-generate 等 14 个技能**恒为空串**，
        //   于是 `pathExists` 恒 false ⇒ 覆盖已有文件也被当成"新建"。改成按技能形态解析。
        const _authTgt = producerTarget(name, params);
        const authPlan = planAuthGate({
          skillName: name,
          params,
          pathExists: _authTgt.exists,
          userText: lastUserText,
          alreadyBlocked: authGateFiredFor.has(name),
          alreadyGranted: deliveryAuthGranted,
          target: _authTgt.target,
          targetKnown: _authTgt.known,
        });
        if (authPlan.blocked) {
          authGateFiredFor.add(name);
          recordSkip('新建交付物授权', name, authPlan.target);
          outcomes[i] = {
            name, params, result: authPlan.directive, argsInfo,
            skippedByGate: true, gateReason: '新建交付物授权',
          };
          try {
            taskTrace.record(taskId, 'auth-gate', { ...authPlan.event, path: 'parallel' });
          } catch { /* 旁路：记录失败绝不影响任务 */ }
          continue;
        }
        // ===== ★★ 产物正文「断言必须有来源」门（与串行路径同一判据）=====
        const claimPlan = planContentClaimGate({
          skillName: name,
          // ★ 2026-11-11 夜：必须把 `params` 交进去 —— 产出类技能的正文不在 `content` 里
          //   （docx/pdf 在 `sections`、ppt/slides 在 `slides`、excel 在 `headers`+`rows`、
          //   project-scaffold 在 `files[].content`）。只传 `content` 的话，
          //   除 file-write 外全是空串 ⇒ 事实门**静默失效**（total=0 就放行，不报错）。
          params,
          path: _authTgt.target || (params && params.path) || '',
          content: (params && params.content) || '',
          alreadyBlocked: claimGateFiredFor.has(name),
        });
        if (claimPlan.blocked) {
          claimGateFiredFor.add(name);
          recordSkip('产物断言无来源', name, String((params && params.path) || ''));
          outcomes[i] = {
            name, params, result: claimPlan.directive, argsInfo,
            skippedByGate: true, gateReason: '产物断言无来源',
          };
          try {
            taskTrace.record(taskId, 'content-claim-gate', { ...claimPlan.event, path: 'parallel' });
          } catch { /* 旁路：记录失败绝不影响任务 */ }
          continue;
        }
        // ===== 跨请求产物复用（与串行路径同一判据、同一位置纪律）=====
        const reusePlan = planReuseGate(name, params);
        if (reusePlan.blocked) {
          recordSkip('产物复用', name, reusePlan.target);
          outcomes[i] = {
            name, params, result: reusePlan.directive, argsInfo,
            skippedByGate: true, gateReason: '产物复用',
          };
          // ★ 2026-10-23（第四轮）：并联路径原来**只有** recordSkip —— 它进的是
          //   `taskEntry.skippedGates`，**不在 trace 里** ⇒ 事后审计看不到"哪一步被这道闸省掉的"，
          //   门禁/live 脚本也读不到并联路径上闸门是否触发过。与串行路径补**同一条**事件。
          //   ★ 2026-10-24（第五轮）：字段由 planReuseGate 一处拼好，这里只补 `path`
          //     （path 是调用点的知识；写在这里，F9-f 才检得到"并联路径确实留了痕"）。
          try {
            taskTrace.record(taskId, 'reuse-gate', { ...reusePlan.event, path: 'parallel' });
          } catch { /* 旁路：记录失败绝不影响任务 */ }
          continue;
        }
        // ★ 2026-10-24（第五轮）：**放行**也要留痕（改前这里什么都没有）。
        if (reusePlan.released) {
          try { taskTrace.record(taskId, 'reuse-gate-release', { ...reusePlan.event, path: 'parallel' }); } catch { /* 旁路 */ }
        }
        let result;
        try {
          const manifest = skills.find((s) => s.id === name);
          if (!manifest) {
            result = 'error: skill not found: ' + name;
          } else if (argsInfo.canExecute === false) {
            // 同串行路径：参数**根本不可用**（截断 / 非法 JSON）绝不执行 —— 带空参数执行只会得到
            // 误导性的"缺参数"报错。注意严格判等 false：字段缺失(undefined)时放行，避免漏传字段就拦死所有调用。
            result = 'error: 本次调用没有执行：' + argsInfo.reason;
          } else {
            // 传入任务级 signal：用户点「停止」时能真中断正在执行的技能（与串行路径一致）
            // ★【F1b】页数预算注入（唯一实现在 wfCtl.withPageBudget）：只改交给 runSkill 的那一份，
            //   outcomes[i].params 仍是**原始入参** ⇒ 门禁/记账看到的东西一个字节都没变。
            const runParams = (wfCtl && typeof wfCtl.withPageBudget === 'function')
              ? wfCtl.withPageBudget(name, params) : params;
            // ★【KI-001】执行区间的前快照（只对 shell-exec 且本工作流声明了产物契约时拍，其余零开销）。
            //   配对消费点在 `trackDeliverable` 的 `EXEC_ARTIFACT_TOOLS` 分支里（一次性）。
            armExecBounds(name);
            result = await runSkill(manifest, runParams, cfg, { signal: taskEntry.lifeCtrl.signal });
          }
        } catch (e) {
          // ★ 2026-11-09：把「进程级事实」挂在 argsInfo 上，随它一路进 governToolResult。
          //   为什么挂 argsInfo 而不改函数签名：governToolResult 已被三条执行路径共用，
          //   加参数要同步改三处调用点；而 argsInfo 本来就是**每次调用独有**的对象。
          try { if (argsInfo) argsInfo.failure = procEvidence.fromError(e, { skillId: name }); } catch { /* 取证旁路 */ }
          result = 'error: ' + ((e && e.message) || String(e));
        }
        outcomes[i] = { name, params, result, argsInfo };
      }
    };
    const lanes = Math.max(1, Math.min(PARALLEL_LIMIT, n));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    // 3) join：按原下标顺序回灌（发结果事件 / 记成果 / 写对话 / 记步骤）
    let webFetchSuccess = 0;
    for (let i = 0; i < n; i++) {
      const o = outcomes[i];
      if (!o) continue; // 防御：槽位未填充（理论上不会发生）
      const { name, params } = o;
      // ★★ 被闸门拦下的调用**不经过 governToolResult**：它的 result 是"给模型的话"，不是执行结果，
      //   再分类一次就是重复记账（同一次失败记两次 ⇒ 熔断提前）。但"这次没执行"必须如实说出来：
      //   SSE ok=false（模型看到的是失败），步骤记 'skipped'（与串行的同策略闸完全同形，
      //   否则同一件事在两条路径上会有两种记账口径）。
      if (o.skippedByGate) {
        const dir = String(o.result);
        send({ __tool_result__: { name, result: dir.slice(0, 3000), id: parsed[i].evtId, ok: false } });
        conversation.push({ role: 'tool', tool_call_id: calls[i].id, content: dir });
        // 文案按**真实原因**出：熔断与同策略升级是两件事，混成一句会让履历说谎
        // （用户看到"同一策略已失败"而实际是被熔断，就找不到该修的是环境还是参数）。
        const why = o.gateReason || '同策略升级';
        markStep(name, false,
          why + '：本次不再执行，已给出替代路径',
          'skipped');
        continue;
      }
      const result = governToolResult(name, params, o.result, o.argsInfo);
      send({ __tool_result__: { name, result: String(result).slice(0, 3000), id: parsed[i].evtId, ok: !isFailureResult(result) } });
      if (name === 'web-fetch' && !isFailureResult(result)) webFetchSuccess += 1;
      trackDeliverable(name, params, result);
      conversation.push({ role: 'tool', tool_call_id: calls[i].id, content: String(result) });
      // ★ 执行路径①（受控并行）：带出 target ⇒ 账本按「同一个对象」销账
      markStep(name, !isFailureResult(result), String(result).split('\n')[0], undefined,
        deriveStepTarget(name, params));
    }
    searchCount += webFetchSuccess; // 一次性累加，避免并发内自增乱序
  };

  let finalTextSent = false;
  // 终态：done / incomplete（撞轮数上限）/ blocked / error / aborted / timeout / budget-exceeded / stream-idle
  // ★ 2026-10-23：初值从 'done' 改为 null。原先的 'done' 默认值是「说了没做完却判完成」的根因之一 ——
  //   任何没走到终态判定的出口都静默继承它。改为 null 后，未判定会被 finalizeTask() 显式按未完成记账。
  let endStatus = null;
  // ══【统一终态收尾 · 2026-10-23】══════════════════════════════════════════════════
  // 病根（实测，见 trace-baseline-report）：本任务存在两个互不相干的「终态」变量 ——
  //   · terminalState（COMPLETE / PARTIAL / BLOCKED）算得对，但只进 trace 与用户文案；
  //   · endStatus（done / …）才是 persistTask 落盘给列表和 /api/tasks 读的那个。
  // 两者之间**从无赋值关系**，于是：
  //   任务 B（task_mvk9lihc）terminal.state=PARTIAL、tasks.json status=done —— 同一任务两处记录互相矛盾；
  //   任务 A（task_mvkad091）连一条 terminal 事件都没写，因为它在 4786 自查回灌后 continue，
  //   轮次正好耗尽，直接跳出循环，既没走正常收尾也没走轮次上限出口。
  // 修法：终态**只有一个来源** —— terminalStateFinal；endStatus 只由它派生，不再有默认值。
  //      所有出口（正常收尾 / 轮次耗尽 / 中断 / 超时 / 预算 / 流空闲 / 上游失败 / 异常）
  //      最终都经过 finally 里的 finalizeTask() 归一，trace / tasks.json / 前端拿到同一个判定。
  let terminalStateFinal = null;   // 本任务最终判定（null = 尚未判定）
  let terminalReason = '';         // 判定来自哪条出口（落 trace 用，事后可归因）
  let terminalTraced = false;      // 是否已写过 terminal 事件（防重复记账）
  // TERMINAL → tasks.json status 的**唯一**映射。三个值都必须有明确去向，
  // 不许把「非 COMPLETE」无差别压成同一种状态（那会让「卡住待介入」和「没做完」不可区分）。
  const TERMINAL_TO_TASK_STATUS = {
    COMPLETE: 'done',
    PARTIAL: 'incomplete',   // 沿用系统既有等价状态（5398 轮次上限出口同值）
    BLOCKED: 'blocked',      // 新增独立阻塞态；下游 latestUnfinishedTask 用 status!=='done' 判未完成，
                             // 故 'blocked' 自动被当作未完成，语义正确且不误伤既有消费者
    // 【第四档】2026-02-16：BLOCKED_WITH_DIAGNOSIS **必须**和 BLOCKED 同值 'blocked'。
    // 为什么同值：它是"卡住了、但诊断可复现"，**仍然是未完成**（目标没达成、产物/功能没到位）。
    //   ① 下游 `latestUnfinishedTask` 用 `status !== 'done'` 判未完成 ⇒ 'blocked' 自动被当作未完成；
    //   ② 若这里漏掉这个键，`:8251` 的 `TERMINAL_TO_TASK_STATUS[terminalStateFinal] || 'incomplete'`
    //      会**静默**把它记成 'incomplete' —— 与 PARTIAL 混同，"卡住待介入"和"没做完"再次不可区分
    //      （那正是上一版加 BLOCKED 这一档要解决的问题，漏一个键就全废）。
    // ★★ 绝不许映射成 'done'：那等于把"卡住了"记成"完成"，是本仓最严重的一类谎
    //    （unit-blocked-wiring 的反控 R4 就是把这个值改成 'done' ⇒ 必须有断言转红）。
    //   它"算一次有效交付"是**统计口径**（deliveryScorecard 的 effectiveDelivery），
    //   与"任务状态是否完成"是两件事 —— 把口径混进状态字段就是造假的起点。
    BLOCKED_WITH_DIAGNOSIS: 'blocked',
  };
  // 「精确出口」写过比三态更具体的原因，归一时必须保留，不许被 PARTIAL 之类派生值盖回去。
  const PRECISE_END_STATUS = new Set(['aborted', 'timeout', 'budget-exceeded', 'stream-idle', 'error']);
  /**
   * 统一终态收尾 —— 唯一出口。幂等：可重复调用。
   * 返回是否发生过「由判定派生 status」（供调用方判断要不要补文案，目前不需要）。
   */
  const finalizeTask = () => {
    // ══【任务类型工作流 · 第二道网】2026-10-23 ══════════════════════════════════════
    // 正常收尾那条出口已经在调用点③ 里终审过了；这里兜的是**其余所有出口**
    // （轮次耗尽 / 中断 / 超时 / 预算 / 流空闲 / 上游失败 / 异常）：
    // 它们在修前都会绕过工作流 ⇒ trace 里只看到「为什么结束」，看不到「按标准判了没」。
    // 两条纪律：① 不论走哪条出口都要留下这条记录（conclude 幂等，重复调无副作用）；
    //          ② 若已有判定是 COMPLETE 而验收没过，必须在这里压下来 —— 这是最后一道，
    //             过了这道就写盘了，压不住就等于「验收没过还显示完成」。
    if (wfCtl && !wfCtl.state.concluded) {
      try {
        const wfEv = wfCtl.conclude(deliverables.map((d) => d.path));
        if (wfEv) {
          traceWorkflowEnd(wfEv);
          if (wfEv.verdict !== 'COMPLETE' && terminalStateFinal === TERMINAL.COMPLETE) {
            terminalStateFinal = wfEv.verdict === 'BLOCKED' ? TERMINAL.BLOCKED : TERMINAL.PARTIAL;
            terminalReason = 'workflow-' + wfEv.verdict;
          }
        }
      } catch { /* 增益功能，不影响归一 */ }
    }
    if (PRECISE_END_STATUS.has(endStatus)) {
      // 精确状态已就位（中断/超时/预算/流空闲/异常）：保留它，只补终态判定供 trace 归因。
      // 不回写 endStatus —— 那些状态比 PARTIAL 更具体，覆盖就是信息损失。
      // 注意这里**不排除 error**：异常退出的任务同样没做完，terminal 仍应记 PARTIAL，
      // 否则「为什么结束」在 trace 里只剩一行 task_end，看不到完成度结论。
      if (terminalStateFinal === null) {
        terminalStateFinal = TERMINAL.PARTIAL;
        terminalReason = terminalReason || endStatus;
      }
      return false;
    }
    if (terminalStateFinal) {
      const mapped = TERMINAL_TO_TASK_STATUS[terminalStateFinal] || 'incomplete';
      if (endStatus !== mapped) { endStatus = mapped; return true; }
      return false;
    }
    // 既没有精确状态、也没有任何终态判定 ⇒ 任务没走到收尾判定就结束了。
    // 这里就是「默认 done」的入口，必须堵死：一律按未完成记，并留下归因。
    endStatus = 'incomplete';
    terminalStateFinal = TERMINAL.PARTIAL;
    terminalReason = terminalReason || 'undetermined-exit';
    return true;
  };
  // 任务级心跳（2026-10-21）：下面的 6s 心跳只活在「模型吐字」阶段（它在每次 LLM 流式调用内部创建、
  // 在 finally 里就 clearInterval），**工具执行期间一个字节都不发**；而前端看门狗（App.jsx 90s）
  // 收不到任何字节就判连接死 ⇒ 任何单步工具执行超过 90 秒必被前端误杀：前端弹「连接长时间没有响应，
  // 已自动结束本次请求」，后端其实还在跑、成果已经生成，但没人接（实测：图片插 PPT 就是这样丢的）。
  // 这里按 15s 补一条**任务级**心跳，覆盖工具执行期。重复发心跳对前端无害（它只重置计时器）。
  // 生命周期：与下面这个 try 严格配对 —— 在 try 之前起、在 finally 第一行清（不随轮次重建）。
  const taskHeartbeat = setInterval(() => {
    try { send({ type: 'heartbeat', thinking: false }); } catch { /* 连接已断：忽略，勿让心跳打断任务 */ }
  }, 15000);
  // ── loop-init 收尾（形态 P：end 落在主 try 之前，理由见上面 begin 处）──────────────
  try {
    __luTracker.end('loop-init', __luInit, { ok: true, ms: Date.now() - _luInitT0 });
  } catch (__luE) { try { process.stderr.write('[loop-unit] end loop-init failed: ' + (__luE && __luE.message) + '\n'); } catch { /* ignore */ } }
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      taskEntry.turn = turn;
      taskEntry.maxTurns = MAX_TURNS;   // 当次生效的上限（可配 ⇒ 必须落到记录里，否则无从判断"24"真假）
      // ★ 2026-09-24 把**上一轮**的增量固化进逐轮轨迹，然后清零本轮桶。
      //   写在轮首而不是轮尾：轮内的工具执行有多条 continue / throw 出路，写轮尾必然漏记。
      // ── 执行单元 ② turn-trace（形态 W · 可包裹）──────────────────────────────
      // 块内只有 `const tr`（块外用不到）与对 `wroteBase` 的赋值（外层 let）⇒ 整段可包。
      // count 取「本轮是否真的固化了上一轮」：`if (turn > 0)` 就是那个判据，不另判一次。
      let _luTtOk = true;
      const _luTtT0 = Date.now();
      const __luTt = __luTracker.begin('turn-trace');
      try {
      if (turn > 0) {
        const tr = taskEntry.turnTrace;
        // wrote = 本轮**真的动过手写东西**的次数（file-write/shell-exec/…，见 WRITE_TOOLS）。
        // 这一列是结果轴的关键区分位：**"在调研"（只读、wrote=0）与"在原地造轮子"（wrote 在涨、
        // 交付物不涨）必须分开** —— 否则纯搜索类任务会被误判成打转。
        tr.push({ t: turn - 1, tools: turnSnap.tools, ok: turnSnap.ok, fail: turnSnap.fail, skipped: turnSnap.skipped || 0, wrote: Math.max(0, (taskEntry.wroteCount || 0) - wroteBase), vf: turnSnap.vf || 0, newEv: turnSnap.newEv || 0, newEvWeak: turnSnap.newEvWeak || 0, artUpd: turnSnap.artUpd || 0, codeNew: turnSnap.codeNew || 0, codeUpd: turnSnap.codeUpd || 0, issClosed: turnSnap.issClosed || 0, issOpen: turnSnap.issOpen || 0, arts: deliverables.length });
        wroteBase = taskEntry.wroteCount || 0;
        if (tr.length > TASK_TRACE_MAX) tr.shift();
      }
      } catch (__luE) {
        // ok 一律「默认真、遇错置假」：不靠事后推断，也不吞异常（原样抛出）。
        _luTtOk = false;
        throw __luE;
      } finally {
        try {
          __luTracker.end('turn-trace', __luTt, {
            ok: _luTtOk, count: turn > 0 ? 1 : 0, ms: Date.now() - _luTtT0,
          });
        } catch (__luE2) { try { process.stderr.write('[loop-unit] end turn-trace failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
      }
      turnSnap = { tools: 0, ok: 0, fail: 0, skipped: 0, vf: 0, newEv: 0, newEvWeak: 0, artUpd: 0, codeNew: 0, codeUpd: 0, issClosed: 0, issOpen: issueOpen.size };
      // 每轮开头检查用户是否已叫停（命中则不再发起任何模型调用）
      if (await bailIfAborted(null)) return;
      // token 预算护栏：命中则不再发起任何模型调用，如实说明「因超出预算停止」（不许说成已完成）
      if (isOverBudget()) { await reportBudget(); return; }
      // ★ 软阈值收尾（2026-09-23）：过了 BUDGET_WRAPUP_RATIO 就切"收尾模式"。
      //   为什么必须有这一层：硬闸门是**悬崖** —— 跨过去就掐断，于是任务总在"差最后一步"处停
      //   （用户抱怨的"干一半就跳"）。有了收尾模式，最坏情况也是**带着可用产出落地**。
      //   收尾模式做三件事：① 不再启动新的重资产验证（如浏览器），只走降级链；
      //   ② 强制压缩上下文，把剩下的预算留给"把话说清楚"；③ 给模型一条明确的收尾指令。
      const wuReason = wrapUpReason(turn);
      // ══【重新规划闸 · 有界停止之前的缓冲】══════════════════════════════════════════
      // 老板第 1 条第三个限制：「连续多轮只有操作、没有新证据或问题变化时，应触发重新规划
      //   或有界停止，而不是永远被认定为正在推进。」
      // 这里给的正是"重新规划"那一半：窗口更短（约 0.6×STUCK）、每条任务只发一次。
      //   · 与收尾用**同一个**判据函数（stuckWindowLacksProgress），只是窗口不同 ⇒ 不会两套口径；
      //   · 只发一次：否则每轮都训话，"提示"就变成了噪声，模型只会学会无视它；
      //   · 用更短窗口是为了在真收尾**之前**给模型一次换方法的机会；它若仍无进展，STUCK 会如期兜底。
      if (!wuReason && !replanPushed && replanAllowTurn(turn)) {
        const shortWin = Math.max(4, Math.floor(STUCK_AFTER_TURNS * 0.6));
        if (taskEntry.turnTrace.length >= shortWin && stuckWindowLacksProgress(shortWin)) {
          replanPushed = true;
          const f = stuckWindowFacts(shortWin);
          try {
            taskTrace.record(taskId, 'replan', { turn, win: shortWin, facts: f });
          } catch { /* 取证旁路 */ }
          console.log('[replan] 只有操作、没有新证据 ⇒ 要求换方法：turn=' + turn
            + ' win=' + shortWin + ' newEv=' + f.newEvidence + ' artUpd=' + f.artUpdated
            + ' issClosed=' + f.issuesClosed + ' verifyActions=' + f.verifyActions);
          sendPhase('working', '最近几轮只有操作、没有新证据，换个方法', lastProgress);
          conversation.push({
            role: 'user',
            content: '（系统提示：最近 ' + shortWin + ' 轮你一直在动手（共执行 ' + f.verifyActions
              + ' 次检查），但**没有产生新的证据**：交付物没有新增或有效更新、检查没有跑出新结果、'
              + '也没有任何一个未解决问题被解决。\n'
              + '这说明当前这条路走不通，而不是"还差一点"。请立刻换一种做法，按顺序回答并执行：\n'
              + '① 你现在试图证明/达成的**具体目标**是什么，一句话；\n'
              + '② 已经试过哪些方法、各自得到什么结果（重复的方法不要再试）；\n'
              + '③ 换一个**还没试过**的方法，或明确说明这条目标无法达成以及卡在哪个具体条件上。\n'
              + '⚠️ 不要再用同一条命令再跑一遍 —— 同样的输入和同样的结果不算进展。）',
          });

          // ══【第二执行实例 · 2026-02-16】卡住时，真的换一个人来干 ═══════════════════════
          // 上面那段 replan 提示只是**让同一个实例换个方法**：同一份上下文、同一套工具、同一个模型。
          // 老板的判断是：「如果几个 Agent 使用相同模型、相同上下文、相同判断方式，
          //   它们可能只是集体犯同一个错误。」而"再训一遍话"恰恰就是"相同判断方式"。
          // 这里补上真正缺的那一半：**另起一个执行实例** ——
          //   · 新 taskId（必须换：主实例 finally 里的 `runningTasks.delete(taskId)` 会把同名的
          //     替补从"可叫停"表里删掉，替补就再也停不下来了）；
          //   · 新模型（拿得到不同模型才叫"独立"；拿不到就**如实降级**，见下）；
          //   · 更小的工具集（去掉搜索类与"跟用户来回"的元工具：前任已经把调研走过一遍，
          //     替补该干的是换一条动手的路，而它这一侧根本没有用户在回答它的提问）；
          //   · 只带交接单的全新上下文（不带前任 messages、不带任何 tool 消息）。
          // 为什么放在 replan 闸**里面**：这就是"重新规划"那一半的**执行者版本**，两者共用同一个
          //   触发判据（stuckWindowLacksProgress），不另立第二条"什么叫卡住"。
          // 为什么只起一次：与 replanPushed 同因 —— 反复起替补 = 反复烧预算，且没有新信息。
          // ⚠️ 没真起第二实例时**一个字都不许说**"已双路/并行执行"：本仓有过"工单上印着
          //   「并行模式：开启（双方案对比）」而消费者为零"的前科（见本文件上方那段自查注释）。
          // ── 执行单元 ③ delegate（形态 W）──────────────────────────────────────────
          // 块内 12 个同级声明里真正逃到块外的只有 `plan` 一族，而且块后到收尾判据那段
          //   一次都没再引用 ⇒ 整段可包（逐条核过 8334 之后 130 行）。
          let _luDlgOk = true;
          let _luDlgChild = null;
          let _luDlgN = 0;
          let _luDlgWhy = '';
          const _luDlgT0 = Date.now();
          const __luDlg = __luTracker.begin('delegate');
          try {
          if (!delegatePushed && !isAborted() && isExecutionAuthorized(intentMode)) {
            delegatePushed = true;
            // 交接单：**复用**已接线的交接单纯函数（`buildHandoffFromSeeded` + `handoffBriefText`），
            // 但经由 secondRunner.buildDelegateHandoff 这一层调，理由写在那个函数的头注里，一句话：
            //   主实例那次传的是"我看不看得见失败过程"，第二实例的上下文是全新的 ⇒ 语义判据不同，
            //   实现必须是同一份。这样本文件里交接单的组装点仍然**只有一个**
            //   （`unit-handoff-brief` F6 把这条钉成硬断言：不许出现"第二种说法"）。
            let handoffText = '';
            let handoffReason = 'build-failed';
            let handoffForbidden = [];
            let handoffOutOfReach = [];
            let handoffItems = 0;
            let handoffLive = 0;
            let handoffUsable = 0;
            let handoffUnusable = 0;
            /** 交接单**产物本身**（`buildHandoffBrief` 的返回值）。trace 要靠它算 `sections` 五个布尔。 */
            let handoffBrief = null;
            /**
             * ══【替补接手要带走的四类事实 —— 一个纯函数算完，本文件只负责"把来源塞进去"】══
             *
             * 修前（683f778）这四类事实的"取数 + 变换"**散在本块的三段代码里**，门禁只能靠 grep
             * 源码字面量证明接线。独立验收做了两个变异体，门禁全绿：
             *   · 在取数下一行插 `unfinishedItems = [];` ⇒ 功能已死，326/0；
             *   · 把 `acceptance:` / `workspace:` / `workspaceFingerprint(...)` 全删 ⇒ ③④ 全死，326/0。
             * ⇒ 逻辑抽到 `secondRunner.buildDelegatePacket`（入参是**原始来源**，出参是成品），
             *   门禁真跑它 + 逐字段变异打红。本文件这一层**只做注入**，不再有任何变换逻辑。
             *
             * 四个来源（各自的真源，都在本函数作用域内，已核实）：
             *   ① 未完成事项：`openFailures()` = `unresolvedSteps(taskEntry.doneLog)`（本文件 5273）
             *      ——判据只有一份，**不在这里重新判**"哪些算未完成"，也不在这里截条数
             *      （条数上限由 `handoffBrief.UNFINISHED_MAX` 一处管，超了它会写「另有 N 条」）。
             *   ② 项目最初的要求：项目账 `project.origin.text`（`projectStore.begin` 时写入的那一句）。
             *   ③ 验收标准：`wfSel.entry.requiredChecks` —— 收尾时 `workflowRunner.evaluate`
             *      会**逐项真跑**它，这就是"对外承诺的验收口径"，不是模型自述。
             *   ④ 工作区/分支/指纹：`AGENT_WORKSPACE`（本文件 755，常量）+ `.git/HEAD` 文本，
             *      并按 `taskEntry.startedAt` 过滤 —— 本机工作区是**所有任务共用**的一个目录，
             *      不过滤就会把上一个任务的 8 个 html 当成"本次起点"（实测过，见 P3）。
             */
            /**
             * ★★【只赋值一次（`const`）—— 这是"整变量重绑"唯一的入口】
             *
             * 冻结（`buildDelegatePacket` 里的 `Object.freeze`）挡得住就地清空/替换，
             *   **挡不住**把整个变量换成一个新对象：
             *     `delegatePacket = Object.assign({}, delegatePacket, { unfinished: [] });`
             *   复核方实测：这一手在上一版**381/0 全绿**。
             * ⇒ 让它必须先改这里：`const` 单次赋值之后，那一行会直接 **TypeError**（响亮失败），
             *   而不是静默生效。`R26a9` 钉这一条（形态判据，诚实标注）。
             *
             * ⚠️ 失败路径**也要冻结**：否则"清空"只要落在这条分支上，读数照样归零，
             *   而 `R26a8` 走的是成功路径 ⇒ 看不出来。
             */
            const delegatePacket = (() => {
              try {
                return buildDelegatePacket({
                  // ★ 传**函数**而不是结果：判据只有一份，由 `openFailures` 那一处决定"哪些算未完成"。
                  openFailures,
                  projectOrigin: (project && project.origin) ? project.origin.text : '',
                  turnText: taskGoal,
                  requiredChecks: (wfSel && wfSel.entry) ? wfSel.entry.requiredChecks : [],
                  workspace: AGENT_WORKSPACE,
                  // ★ 任务开始时间（`taskEntry.startedAt`，创建 taskEntry 时取的那个 `Date.now()`）：
                  //   指纹只留"本次任务开始之后动过"的文件，避免把别的任务的产物当成交接起点。
                  taskStartedAt: taskEntry.startedAt,
                  // ★ 用本文件同一个 `clip()`（去换行 + 截断 + '…'），不另造一套截断风格
                  clip,
                });
              } catch (e) {
                // 这一包是增益不是单点故障源：算不出来就按"四类全空"继续（替补仍然换上下文 + 换工具）。
                console.error('[delegate] 四类事实取证失败（按空处理继续）：', e && e.message);
                const emptyPacket = {
                  goal: '', acceptance: [], unfinished: [], workspace: null,
                  fingerprint: { items: [], seen: 0, filteredByTaskStart: false }, openCount: 0,
                };
                Object.freeze(emptyPacket.acceptance);
                Object.freeze(emptyPacket.unfinished);
                Object.freeze(emptyPacket.fingerprint);
                return Object.freeze(emptyPacket);
              }
            })();
            /**
             * ★★【注入侧的安全保证分三层，强弱不同 —— 别再把可读性说成保证】
             *
             * ⚠️ 这里曾经写着"没有名字，就没有可插入的位置"（删掉别名的理由）。**那句话是错的**，
             *   2026-02-17 第三次打回时被复核方直接推翻：在同一个位置写
             *     `const { unfinished: _u } = delegatePacket; _u.length = 0;`
             *   效果与旧别名**完全相同**，而当时负责盯别名的 `R26a6` **全绿**。
             *   ⇒ 删别名只删掉了"上一轮那个具体标识符"，不是"这一类写法"。
             *
             * 现在的三层，按承重排：
             *   ① **承重：出口冻结**（`buildDelegatePacket` 里 `Object.freeze`）。
             *      七种写法（整字段重绑 / `pop()` / `splice(0)` / 方括号 / `Reflect.set` /
             *      解构别名 / `length = 0`）在冻结对象上**要么抛错、要么静默无效**。
             *      由 `R26a8` **真跑**这七种写法来守 —— 它不看源码写法，只看"值还在不在"，
             *      所以将来出现第八种，只要真动了值就会红。
             *   ② **`const` 单次赋值**：冻结唯一的缺口是"整变量重绑"，而那一手必须先把
             *      `const` 改成 `let` 才能生效 ⇒ `R26a9` 钉住这一点（**形态判据**，如实标注）。
             *   ③ **可读性**：注入行仍直接写 `delegatePacket.unfinished`，不经别名。
             *      这不是安全保证，只是让人（和 `R26a4`）一眼看见接线。
             *
             * ⚠️ 还有一件事必须记住：**backend.js 在本门禁里执行覆盖 = 0**。
             *   `unit-second-runner` 只 `readFileSync` 它（复核方实测：第一行插 `process.exit(42)`
             *   或 `throw` 都仍然全绿）。⇒ 这段注释里所有"防住"都不是"被断言证明"，
             *   而是 ①结构上写不出来 ②`R26a8` 在纯函数那一层**真跑**证明值改不动。
             *   这两回事别混着说 —— 混着说就是下一条"说明与判据不符"。
             */
            try {
              // ★★ 2026-02-16 修 P1-4：喂给交接单的**不再只有** `seededList()`。
              //   原来只用 seeded ⇒ `seededMeta` 仅在 `seed()` 里写、`seed()` 只在工作流
              //   `attempts()`（PPT 类）有内容时才调 ⇒ **一般任务 seededList 恒空** ⇒
              //   交接单恒为「0 字 / 禁令 0 条」—— 老板那句「替补必须知道前任尝试过什么」
              //   在多数任务上**根本没兑现**（独立验收实测）。
              //   ⇒ 改用账本的**唯一并集出口** `handoffList()` = 跨请求预热账 + 本次运行 live 失败账。
              //   ⚠️ 仍然**只有账本这一个失败真源**：这里不做任何"哪些算失败"的判断，只是取数。
              const prevStrats = (toolLedger && typeof toolLedger.handoffList === 'function')
                ? toolLedger.handoffList()
                : ((toolLedger && typeof toolLedger.seededList === 'function') ? toolLedger.seededList() : []);
              handoffItems = Array.isArray(prevStrats) ? prevStrats.length : 0;
              handoffLive = (Array.isArray(prevStrats) ? prevStrats : [])
                .filter((x) => x && x.from === 'live').length;
              // ★ 交接单必须知道"替补手里有哪些工具"（独立验收实测：3 条里有 2 条是
              //   `DELEGATE_DENY_TOOLS` 剔掉的那一族 ⇒ 说"别再用 file-search"是句空话）。
              //   这里用**同一个纯函数、同一份入参**先算一遍（`planDelegation` 内部也是它）。
              const pickedPreview = pickDelegateTools(tools, Array.from(META_TOOL_NAMES));
              const dh = buildDelegateHandoff({
                seeded: prevStrats,
                delegateTools: pickedPreview.tools,
                actionsAll: Object.keys(RECOVERY_ACTION_LABEL),
                actionLabel: RECOVERY_ACTION_LABEL,
                kindLabel,
                actionOf: (k) => recoveryStrategyFor({ kind: k }).action,
                /**
                 * ★★【第 1 类 · 未完成事项】把 `delegatePacket.unfinished` **真的传下去**。
                 *   元素是**纯字符串**（`delegateStepLines` 给的 `第N步 技能名：brief`）——
                 *   `handoffBrief` 三种形态都兼容，但 `doneLog` 原始条目里的 `step` 是**数字**，
                 *   直接传对象会因为 `typeof x.step === 'string'` 判假而被丢掉（那样等于没接）。
                 *   **条数不在本文件截**：有几条给几条，上限由 `handoffBrief.UNFINISHED_MAX`（20）
                 *   一处管，超了它会写「另有 N 条未展开」；在上游先截成 8 条会让那句话永远不触发。
                 *   空数组 ⇒ 正文里「还没做完的事」整段不出现（渲染逻辑在 handoffBrief，本文件不改）。
                 *
                 * ⚠️ 这一行**直接写 `delegatePacket.unfinished`**，不经本地变量。
                 *   但要说清它的分量：这**不是**安全保证（冻结才是，见本块上方三层）。
                 *   别名本身现在也改不动值了（数组已冻结），写"不许别名"只有两个作用：
                 *   让读的人一眼看见接线（`R26a4` 也靠这一行定位），以及别再多一个可以被误改的引用。
                 */
                unfinished: delegatePacket.unfinished,
                trigger: '这是一次**替补接手**：上一个执行者在"只有动作、没有新证据"上卡住了，'
                  + '下面是它留下的失败账（不是这一轮做错的）。',
              });
              handoffReason = String(dh.reason || 'unknown');
              handoffBrief = dh.brief || null;
              handoffForbidden = Array.isArray(dh.forbidden) ? dh.forbidden : [];
              handoffOutOfReach = Array.isArray(dh.outOfReach) ? dh.outOfReach : [];
              handoffUsable = Number(dh.usable) || 0;
              handoffUnusable = Number(dh.unusable) || 0;
              handoffText = String(dh.text || '');
            } catch (e) {
              // 交接单是增益不是单点故障源：组装失败就按"无交接"继续（第二实例仍然换上下文 + 换工具）。
              console.error('[delegate] 交接单组装失败（按"无交接"继续）：', e && e.message);
            }
            /**
             * 第 2/3/4 类事实（目标两个来源 / 验收标准 / 工作区指纹）已经全部在
             * `delegatePacket` 里算好了（见上面那段注释）——本文件这一层**只取值，不再变换**：
             * 这样"接线断没断"可以被门禁真跑打红，而不是靠 grep 源码字面量。
             */
            const dcfg = (cfg && typeof cfg === 'object') ? cfg : {};
            const plan = planDelegation({
              taskId,
              // ★ 不再是 `taskGoal` 那一句：原始需求 + 本轮要求两个来源。
              goal: delegatePacket.goal,
              tools,
              metaNames: Array.from(META_TOOL_NAMES),
              mainModel: model,
              delegateModel: {
                payloadModel: payload.delegateModel,
                cfgModel: dcfg.delegateModel,
                envModel: process.env.DOUYA_DELEGATE_MODEL,
              },
              // ★ 与 isInternalRun 用**同一条**归一化（别在这里写 `Number(...) || 0`：
              //   `-1` 会原样透传，于是深度闸放行、内层却拿到 delegateDepth:0 ⇒ 隔离全失效）。
              depth: normalizeDelegateDepth(payload.delegateDepth),
              turn,
              maxTurnsLeft: MAX_TURNS - turn,
              handoffText,
              handoffReason,
              // 第 3、4 类事实（第 1 类已经进上面那张交接单了）。
              acceptance: delegatePacket.acceptance,
              workspace: delegatePacket.workspace,
            });
            if (plan.action !== 'run') {
              // 起不来就**如实记、什么都不演**：不记一条"已换人"，也不发任何 phase 文案。
              try {
                taskTrace.record(taskId, 'delegate', { phase: 'skip', reason: plan.reason, turn });
              } catch { /* 取证旁路 */ }
              console.log('[delegate] 不起第二实例：' + plan.reason + '（turn=' + turn + '）');
              // 没起第二实例：本单元正常走完，只是「没启动」。count=0、reason 记清是哪条不起。
              _luDlgWhy = 'skip:' + String(plan.reason || '');
            } else {
              const taskId2 = plan.taskId2;
              const sink = createDelegateSink();
              const retBox2 = { acceptance: null };
              /**
               * 第二实例的 payload：**整份继承环境、只替换"人"**。
               *   · 继承：baseURL / apiKey / expert / context / username（环境事实：同一网关、
               *     同一密钥、同一个人设、同一个企业项目上下文 —— 这些不是"前任的思路"）；
               *   · 替换：taskId / delegateDepth / model / tools / messages / maxTurns；
               *   · `messages` 只有一条（交接单种子），**没有任何**前任历史 ⇒ 这是"全新上下文"的字面实现。
               */
              const payload2 = { ...payload, ...plan.payloadPatch };
              try {
                taskTrace.record(taskId, 'delegate', {
                  phase: 'start', mode: plan.mode, taskId2, model2: plan.model2,
                  // ⚠️ 这一刻还**没跑**，所以这里只能记"打算给几个"，字段名必须这么说。
                  //   运行时的真实值记在 `phase:'end'` 的 `tools2`（取自内层实际的 tools 数组）。
                  tools2Planned: plan.tools2.length, tools1: tools.length,
                  modelReason: plan.modelReason,
                  dropped: plan.droppedTools, handoff: plan.handoffReason,
                  handoffChars: plan.handoffChars, forbidden: handoffForbidden,
                  handoffItems, handoffLive,
                  // ★ 条目可用性（独立验收实测过：不标就是"点名了替补没有的工具"）：
                  //   forbidden = 真禁令（手里有的）；outOfReach = 手里没有的那族（改口成"绕开"）。
                  handoffUsable, handoffUnusable, handoffOutOfReach,
                  depth: plan.depth, maxTurns2: plan.maxTurns2,
                  /**
                   * ══【本轮新增：交接单"实际产出了什么"的读数】══
                   * 目的只有一个：让「交接信息完整率」可统计。
                   *   briefOk      —— 交接单是否产出（false ⇒ 替补只拿到种子文案 + 另外三类事实）；
                   *   briefChars   —— 正文长度（**不再重复记全文**：全文副本会撑爆 trace 上限，
                   *                   而 `handoffChars` 那边已经有同一个读数，这里保留是为了让
                   *                   "本次这一份"与"plan 里那一份"能对上）；
                   *   sections     —— 五段各自的布尔（forbidden/outOfReach/tried/notTried/unfinished）；
                   *   goalChars    —— 目标文本字数（含"项目最初的要求"+"本次这一轮的要求"两个来源）；
                   *   acceptChars  —— 验收标准各条字数之和（0 ⇒ 种子消息里没有那段，**不是空标题**）；
                   *   fingerprintCount —— 产物指纹条目数（≤ 8；0 ⇒ 只有一句""没有新文件"的实话）；
                   *   unfinishedCount  —— 未完成事项**条数**（= `openFailures().length`，不再被上游截 8）；
                   *   fingerprintSeen  —— 工作区里**枚举到的候选数**（顶层 + **一层**子目录内的普通文件，
                   *                       隐藏项不算、过滤前；受 `DELEGATE_FP_SCAN_MAX` = 200 次 stat 预算
                   *                       截断 ⇒ 是**下限**，**不是**"工作区文件总数"）。
                   *                       ⚠️ 下潜一层之后同一个工作区从这个数 50 变成 177，文件一个没多 ——
                   *                       变的是"数的方式"，别把 177 读成"产物一夜涨三倍"。
                   *                       与 `fingerprintCount` 一比，差的那部分是"被任务开始时间
                   *                       过滤掉 + 没抢到 8 条配额"的；
                   *   fingerprintFiltered —— 是否按 `taskEntry.startedAt` 过滤过（false ⇒ 上面那堆
                   *                       可能混着别的任务的文件，读数时别当成"本次产物"）。
                   */
                  briefOk: !!handoffText,
                  briefChars: handoffText.length,
                  sections: handoffSectionsOf(handoffBrief),
                  goalChars: Number(plan.goalChars) || 0,
                  acceptChars: Number(plan.acceptChars) || 0,
                  fingerprintCount: Number(plan.fingerprintCount) || 0,
                  unfinishedCount: delegatePacket.unfinished.length,
                  fingerprintSeen: Number(delegatePacket.fingerprint.seen) || 0,
                  fingerprintFiltered: !!delegatePacket.fingerprint.filteredByTaskStart,
                  reason: 'stuck-no-progress', turn,
                });
              } catch { /* 取证旁路 */ }
              console.log('[delegate] 起第二执行实例：mode=' + plan.mode + '/' + plan.modelReason
                + '（' + (plan.mode === DELEGATE_MODE.INDEPENDENT ? '独立模型' : '同模型·独立性有限') + '）'
                + ' taskId2=' + taskId2 + ' model2=' + plan.model2
                + ' tools=' + tools.length + '→' + plan.tools2.length
                + ' 交接单=' + plan.handoffChars + '字/禁令' + handoffForbidden.length + '条'
                + '/手里没有' + handoffOutOfReach.length + '条'
                + '（可用 ' + handoffUsable + ' / 不可用 ' + handoffUnusable + '）'
                + ' 未完成=' + delegatePacket.unfinished.length + '条'
                + ' 目标=' + (Number(plan.goalChars) || 0) + '字'
                + ' 验收=' + (Number(plan.acceptChars) || 0) + '字'
                // ★ 分母是"**枚举到的候选数**"（顶层 + 一层子目录内的普通文件，受 200 次 stat 预算截断）——
                //   不是工作区文件总数：下潜一层之后同一个工作区从 50 → 177，**文件没变多**。
                //   所以这里写"候选"而不是笼统的"个"，免得读日志的人以为产物一夜涨了三倍。
                + ' 指纹=' + (Number(plan.fingerprintCount) || 0) + '条/候选'
                + (Number(delegatePacket.fingerprint.seen) || 0) + '条'
                + (delegatePacket.fingerprint.filteredByTaskStart ? '（已按本次任务开始时间过滤）' : '（未过滤）')
                + ' maxTurns2=' + plan.maxTurns2);
              sendPhase('working', plan.phaseLabel, lastProgress,
                { delegated: true, mode: plan.mode, model2: plan.model2, taskId2, tools2: plan.tools2.length });
              try {
                // ★ 有界递归：深度闸（payload2.delegateDepth=1）保证它不会自己再起一个。
                //   它的 res 是 sink（吞字节），所以**不会**给用户发任何字节；
                //   它自己会注册 runningTasks[taskId2] ⇒ 用户点"停止"时由 abortTask 连带叫停。
                // ★ 阶段 2：改走 `agentRuntime.run` 边界（与主路径同一条链），不再直调 Inner。
                //   `retBox: retBox2` 原样透传 —— 薄壳声明了可选第 5 参，内层照旧写
                //   acceptance / usedTokens / toolsSeen 到同一个 box 上，下面那些读数一行都不用改。
                // ⚠️ 变量名必须是 `request2`：`unit-runtime-substrate.mjs` 的 S2-M2 断言
                //   「`agentRuntime.run` + 单实参 `request` + 分号」这个**整串**全文恰好 1 次
                //   （那是主路径 :3005 的调用点）。这里若也叫 `request`，整串就会命中 2 次
                //   ⇒ 那条判据必红，而它守的正是"边界只有一个入口"。
                //   （本条注释本身也刻意不写那个整串：写了同样会把计数顶成 2 —— 实测踩过。）
                const request2 = {
                  sessionId,
                  taskId: taskId2,
                  payload: payload2, cfg, skills,
                  res: sink.res,
                  retBox: retBox2,
                  signal: null,
                };
                await agentRuntime.run(request2);
              } catch (e) {
                // 第二实例炸了不是主任务的终点：如实记下来，主实例照常往下走。
                console.error('[delegate] 第二实例异常（按"无产出"继续主实例）：', e && e.message);
              }
              const r2Text = clip(String(sink.getText() || '').trim(), DELEGATE_SUMMARY_MAX);
              // ★ 成本归属：把替补这一轮烧掉的 token 记到**外层任务**头上（见 delegateUsage 头注）。
              //   读数来自内层自己的 `taskEntry.usedTokens`（persistTask 时写进 retBox2），
              //   不是外部估算 ⇒ 与 `token-usage.json` 同源。读不到就记 0，不编。
              //   🔴 口径：增量法（work）。**不是** `turns2 × 每轮` —— 详见 delegateUsage 头注里的实测
              //   （5 轮 7 次调用，按轮推算会低报 29%）。
              const r2Tokens = Math.max(0, Number(retBox2.usedTokens) || 0);
              // 上游真实收数（Σ(prompt+completion)）：只进 trace，不进任务记录（两个口径不混用）。
              const r2Billable = Math.max(0, Number(retBox2.billableTokens) || 0);
              delegateUsage.tokens += r2Tokens;
              // ★ 替补做出来的文件**也是这次任务的产出**：从 sink 收到的 `deliverables` 事件里
              //   取（那是主循环自己推的真实清单，不是我们猜的），按路径去重后并进本任务的
              //   `deliverables` —— 否则成果卡上看不到替补写的东西、验收也当它没写过，
              //   而用户明明在磁盘上看得见它们。
              let r2Arts = 0;
              try {
                const items = sink.getDeliverables();
                for (const it of (Array.isArray(items) ? items : [])) {
                  const p = it && it.path;
                  if (!p) continue;
                  if (deliverables.some((d) => d && d.path === p)) continue;
                  deliverables.push(it);
                  r2Arts += 1;
                }
              } catch { /* 合并是增益，失败不影响主流程 */ }
              // 轮数从**它自己的** trace 读（不是估的）：它内部走的是同一个 runAgentLoopInner，
              // 收尾必然写一条 task_end。读不到就记 0 —— 不编读数。
              let turns2 = 0;
              let outcome2 = r2Text ? 'produced-text' : 'no-output';
              try {
                const tr2 = taskTrace.read(taskId2);
                const evs2 = (tr2 && Array.isArray(tr2.events)) ? tr2.events : [];
                const endRec = evs2.filter((e) => e && e.kind === 'task_end').pop();
                if (endRec) {
                  turns2 = Number(endRec.turns) || 0;
                  if (endRec.status) outcome2 = String(endRec.status);
                }
              } catch { /* 读数缺失按 0 记，不阻断 */ }
              // ★ 第二实例**运行时真实**的工具表：由内层在组装请求体时写进 retBox2.toolsSeen
              //   （见 4626 附近那段）。不用 `plan.tools2.length` 顶替 —— 那个值曾经是**低报**：
              //   内层把 META_TOOLS 又加回来，模型实际看到 7 个，trace 却写 3。
              //   读不到（retBox2 没被写）就记 -1 = "未读数"，不编一个看起来正常的数字。
              const tools2Real = Array.isArray(retBox2.toolsSeen) ? retBox2.toolsSeen.length : -1;
              try {
                taskTrace.record(taskId, 'delegate', {
                  phase: 'end', mode: plan.mode, taskId2, model2: plan.model2,
                  // tools2 = **运行时真实值**（模型实际看到几个工具）；计划值另有一格。
                  tools2: tools2Real, tools2Planned: plan.tools2.length,
                  metaToolsSuppressed: retBox2.metaToolsSuppressed === true,
                  reason: 'stuck-no-progress',
                  turns2, outcome: outcome2, textChars: r2Text.length,
                  // ★ 替补花的 token（并进外层任务的 delegateTokens；两处同源，不各记一份）
                  tokens2: r2Tokens,
                  // ★ 同一段实际用量的**上游真实收数**（Σ(pt+ct)）。与 tokens2 不同不是矛盾：
                  //   tokens2 是闸门/预算口径（增量法），tokens2Billable 是上游账单口径。
                  //   复验方用"次数 × 单价"核账时看这一格，不要拿 tokens2 去对次数。
                  tokens2Billable: r2Billable,
                  acceptance: (retBox2.acceptance && retBox2.acceptance.verdict) || null,
                  sinkEvents: sink.eventCount(), artifacts: r2Arts,
                });
              } catch { /* 取证旁路 */ }
              // delegate 的机器读数取在**这里**（紧接着上面那条 phase:end）：
              //   两件事（trace 的 delegate/end 与 loop-unit-end）看的是同一刻，不许各取一份、各说一套。
              //   ok 只认内层自己的终态读数（它写在自己的 task_end 里），不从正文猜。
              _luDlgChild = taskId2;
              _luDlgN = turns2;
              _luDlgOk = outcome2 === 'done';
              if (!_luDlgOk && !_luDlgWhy) _luDlgWhy = 'child:' + String(outcome2 || '');
              // 结论回灌主对话：**只回摘要**（全文会挤爆上下文，主实例真正需要的是"替补走到哪了"）。
              // 走 `role:'user'` + 「（系统提示：」前缀，而不是 role:'system'，理由三条：
              //   ① 本文件所有**轮内注入**的既有约定就是这条形态（replan / 收尾 / 停滞训话都是它）；
              //   ② `intentGate.lastRealUserText` 明确跳过这个前缀 ⇒ 它不会被当"用户说的话"去判意图；
              //   ③ 不新增 role:'system' 注入点 ⇒ `unit-asset-registry` 的 R6d/R6e 棘轮（20/22 处）
              //      及其背后的反向证明（"注入全是具名常量/函数，没有角色槽位"）一个字都不用动。
              conversation.push({
                role: 'user',
                content: '（系统提示：第二个执行实例已跑完。它拿到的是**干净的上下文 + 交接单**'
                  + '（与主执行者' + delegateModeLabel(plan.mode) + '），下面是它最后的结论，原样转给你'
                  + ' —— 这不是用户说的话：\n'
                  + (r2Text || '（它没有留下可用的结论文本。）')
                  + '\n以上是替补的结论。你可以直接采用它，或在它基础上继续；'
                  + '**不要重复它已经做过的动作**，也不要把它的结论当成用户已经确认过的事。',
              });
              // 用户在替补跑的过程中点了停止 ⇒ 主实例立刻走中断收尾，不再发起模型调用。
              if (isAborted()) { await bailIfAborted(null); return; }
            }
          }
          } catch (__luE) {
            _luDlgOk = false;
            if (!_luDlgWhy) _luDlgWhy = 'threw';
            throw __luE;
          } finally {
            try {
              __luTracker.end('delegate', __luDlg, {
                ok: _luDlgOk, count: _luDlgN, childTaskId: _luDlgChild,
                tokens: delegateUsage.tokens, ms: Date.now() - _luDlgT0,
                ...(_luDlgWhy ? { reason: _luDlgWhy } : {}),
              });
            } catch (__luE2) { try { process.stderr.write('[loop-unit] end delegate failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
          }
        }
      }
      // ── 执行单元 ④ wrapup-inject（形态 W）────────────────────────────────────
      // 这个单元没有"失败"语义：进了 if 就是真的注入了收尾指令。ok 恒真、count 恒 1。
      const _luWuT0 = Date.now();
      const __luWu = __luTracker.begin('wrapup-inject');
      try {
      if (wuReason) {
        wrapUpMode = true;
        taskEntry.wrappedUp = true;   // 落盘取证：软收尾到底有没有真的进过
        wrapUpReasonUsed = wuReason;
        taskEntry.wrappedUpReason = wuReason;
        const wuPct = Math.round((wuReason === 'budget' ? BUDGET_WRAPUP_RATIO
          : wuReason === 'stuck' ? STUCK_TURN_RATIO : TURN_WRAPUP_RATIO) * 100);
        // ★ 停滞是**哪一支**判出来的（终态词表不动，仍是 'stuck'；这里只决定"说什么话"）：
        //   · 'stuck'           = 一直在动手，但四维度没有增量（忙而无功）；
        //   · 'stall-no-action' = 连续几轮**一次工具都没调**，只在说"我承认有问题/我接着做"。
        //   后者是用户报障里最伤人的那种，文案必须**如实说卡住了**，不许再写"继续努力/还差一点"。
        const stallNoAction = wuReason === 'stuck' && lastNoProgressKind === 'stall-no-action';
        // 未闭环失败清单：这是"你说过要解决但还没解决的"的**唯一**来源（不另算一套口径）。
        const openNow = (wuReason === 'stuck' && openFailures) ? openFailures() : [];
        const openShown = openNow.slice(0, 8);   // 最多 8 条：太长模型会直接略读
        const stallLines = openShown.map((s, i) => {
          const rawNo = Number(s && s.step);
          const no = Number.isFinite(rawNo) && rawNo > 0 ? rawNo : (i + 1);
          const skill = String((s && s.skill) || '').trim() || '未记录技能';
          let brief = String((s && s.brief) || '').replace(/\s+/g, ' ').trim();
          if (!brief) brief = '没有留下失败原因';
          if (brief.length > 120) brief = brief.slice(0, 120) + '…';
          return '· 第' + no + '步 ' + skill + '：' + brief;   // 形如「第3步 desktop-verify：窗口没起来」
        });
        const wuWhat = wuReason === 'turns'
          ? '轮数已用到 ' + wuPct + '%（第 ' + (turn + 1) + ' / ' + MAX_TURNS + ' 轮）'
          : wuReason === 'stuck'
            // ★ 2026-10-23 改文案：原来一律说「没有落地任何交付物」，但交付物可能**早就落地了**，
            //   真原因是"后面这些轮只有操作、没有新证据"。说错原因 = 让用户照着错的方向去查。
            // ★ 2026-02-16 再加一支（stall-no-action）：一支工具都没调过的时候，
            //   说"连续 N 轮有工具动作"是**说假话** —— 那几轮恰恰一次都没有。
            ? (stallNoAction
              ? '你已经连续 ' + STALL_NO_ACTION_TURNS + ' 轮**一次工具都没有调用**（每一轮都只是在说'
                + '「我承认有问题」「你说继续我就接着做」这类话），而未解决的问题一条都没有减少'
              : (deliverables.length > 0
                ? '已经连续 ' + STUCK_AFTER_TURNS + ' 轮有工具动作，但**没有新的进展**'
                  // ★ 2026-11-11 文案补第 ④ 维：判据已经加了"工程文件新增/真变"，这句不长出来
                  //   就与判据对不上 —— 模型会被告知"交付物没更新"，而它明明在写源码。
                  //   说错原因比不说更糟：它会照着错的方向去"补交付物"，把真活停掉。
                  + '（交付物没有新增或有效更新、工程文件没有新增或内容变化、'
                  + '检查没有跑出新结果、未解决问题没有减少）'
                : '已经连续 ' + STUCK_AFTER_TURNS + ' 轮有工具动作、但没有落地任何交付物'))
            : wuReason === 'both'
              ? '轮数与 token 预算都已用到 ' + wuPct + '%'
              : 'token 预算已用到 ' + wuPct + '%';
        // 读数：停滞那一支用**自己的**窗口读数（工具数/未闭环数），不许拿"四维度"冒充 ——
        // 四维度回答的是"动了但没用"，这里要回答的是"一动没动"。
        const stallFacts = stallNoAction ? {
          win: STALL_NO_ACTION_TURNS,
          turns: (taskEntry.turnTrace || []).slice(-STALL_NO_ACTION_TURNS).map((e) => ({
            t: e && e.t, tools: (e && e.tools) || 0, wrote: (e && e.wrote) || 0,
            issOpen: Number((e && e.issOpen)) || 0,
          })),
          openNow: openNow.length,
          openListed: openShown.length,
        } : null;
        const wuFacts = (wuReason === 'stuck' && !stallNoAction) ? stuckWindowFacts(STUCK_AFTER_TURNS) : null;
        console.log('[wrapup] 进入收尾模式(' + wuReason + (stallNoAction ? '/stall-no-action' : '') + ')：turn=' + turn + '/' + MAX_TURNS
          + ' used=' + (taskEntry.usedTokens || 0) + ' / budget=' + tokenBudget
          + ' deliverables=' + deliverables.length + ' stuckAfter=' + STUCK_AFTER_TURNS
          // 把四维度读数一并打出来：事后看到的就是"为什么判打转"的直接证据，
          //   而不是只有一句结论（老板要的"可审计过程"）。
          + (wuFacts ? ' 四维度=' + JSON.stringify(wuFacts) : '')
          + (stallFacts ? ' 纯表态=' + JSON.stringify(stallFacts) : ''));
        try { if (wuFacts) taskTrace.record(taskId, 'wrapup', { reason: wuReason, turn, facts: wuFacts }); } catch { /* 旁路 */ }
        // 停滞支单独记一条**事件**（事件名区分，不动 reason 的取值集合 —— 见 lastNoProgressKind 注释）。
        try {
          if (stallFacts) taskTrace.record(taskId, 'stall-no-action', { turn, facts: stallFacts });
        } catch { /* 旁路 */ }
        // 用户侧：**如实说卡住了**。这句话是给用户看的，不是给模型的激励语 ——
        //   「继续努力/还差一点」会让用户以为再催一句就好，而他实际上已经催了 N 轮。
        if (stallNoAction) {
          if (!stallPushed) {
            stallPushed = true;
            sendPhase('working',
              '卡住了：连续 ' + STALL_NO_ACTION_TURNS + ' 轮没有任何实际操作，只说"我接着做"，转入收尾',
              lastProgress, { stalled: true, stallReason: 'no-action', open: openNow.length });
          }
        } else {
          sendPhase('working',
            // 同样不许说错原因：有交付物时不能说"没有产出"，那是另一件事。
            wuReason === 'stuck'
              ? (deliverables.length > 0 ? '连续多轮只有操作、没有新进展，转入收尾' : '一直没有产出，转入收尾')
              : '接近' + (wuReason === 'turns' ? '轮数上限' : '预算上限') + '，转入收尾', lastProgress);
        }
        // 模型侧：停滞支必须**逐条列出**未闭环项，并明确禁止再说"我接着做"。
        // 只说"你没进展"是没用的 —— 模型会回一句"我承认有问题"继续糊（用户报障原话）。
        // 唯一有效的训话形态是：把**具体哪几条**还没解决的贴到它眼前，逼它选"做"或"说做不了"。
        if (stallNoAction) {
          if (!stallPushedModel) {
            stallPushedModel = true;
            conversation.push({
              role: 'user',
              content: '（系统提示：本任务' + wuWhat + '。'
                + '现在开始收尾，**不要再承诺"我接着做"** —— 那不算动作，也不会让任何一条变少。\n'
                + (stallLines.length
                  ? '下面这些是你说过要解决、但到现在**还没有解决**的（共 ' + openNow.length + ' 条'
                    + (openNow.length > openShown.length ? '，只列前 ' + openShown.length + ' 条' : '') + '）：\n'
                    + stallLines.join('\n') + '\n'
                  : '（本次没有任何已登记的未闭环步骤 —— 那就直接说明卡在哪里。）\n')
                + '逐条回答，每一条只能给两种结论之一：\n'
                + '① 已解决：给出你刚跑的检查 + 可核读的结果；\n'
                + '② 做不了：说明卡在哪个**具体条件**（缺的账号/权限/参数/环境），不要写"稍后继续"。\n'
                + '下面这些是你说过要解决但还没解决的，逐条解决或明确告诉我做不了，不要再说"我接着做"。\n'
                + '然后按两段如实汇报：① 交付了什么（文件路径/结论 + 验证到了哪一层）；'
                + '② 还缺什么（没做完、没验证的部分）。缺口声明是必填项，没有就写"无"。',
            });
          }
        } else {
          conversation.push({
            role: 'user',
            content: '（系统提示：本任务' + wuWhat + '。'
              + '现在开始收尾：**不要再启动新的重资产动作**（例如再开一次浏览器、再跑一次全量构建）；'
              + '手上正在做的那一步做完就停。然后按下面两段如实汇报：\n'
              + '① 交付了什么：具体到文件路径/结论，以及**验证到了哪一层**（功能已验 / 仅结构已验 / 未验证）；\n'
              + '② 还缺什么：没做完的部分、以及**没验证的部分**，一条一条列出来，不要用"已完成"盖过去。\n'
              + '⚠️ 缺口声明是必填项：没有缺口就明确写"无"。绝不许把未验证说成已验证。',
          });
        }
      }
      } finally {
        try {
          __luTracker.end('wrapup-inject', __luWu, { ok: true, count: 1, ms: Date.now() - _luWuT0 });
        } catch (__luE2) { try { process.stderr.write('[loop-unit] end wrapup-inject failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
      }
      // 剪枝视图：每次用都**现算**，不缓存快照。
      // 为什么必须现算：下方那条「最后通牒」是在压缩块**之后**才 push 进 conversation 的。
      // 若在这里算一份快照留着后面用，那条通牒会被漏掉 ⇒ 模型收不到硬停警告。
      // 这类"少一条消息"的 bug 事后极难归因，所以宁可每轮算两次。
      // 现算成本 = O(字符数)，只有超阈值的那几条才会真的切片；未剪时直返 conversation 同一引用。
      const pruneView = () => (toolResultPruneEnabled()
        ? pruneToolResults(conversation, {})
        : { messages: conversation, pruned: false });
      // 循环内上下文压缩（2026-09-23）：**按实际上下文压力触发，不按固定轮次**。
      // 放在预算检查**之后** —— 预算已经不够了就没必要再花一次摘要调用。
      // 触发条件与不变量见 shouldCompressInLoop / planLoopCompress 上方注释。
      {
        // 这就是 dsh 的「重测」：剪枝只改变**测什么**，不改变**怎么测** ——
        // 全轴仍然只有 estimateTokens（:2444）一个 token 口径，不新增第二个测量函数。
        const pvM = pruneView();
        const pressure = inLoopCompressEnabled()
          ? shouldCompressInLoop(pvM.messages, {
            tokenBudget,
            usedTokens: taskEntry.usedTokens || 0,
            share: CTX_COMPRESS_SHARE,
            hardCap: CTX_COMPRESS_HARD_CAP,
            floor: CTX_COMPRESS_FLOOR,
          })
          // 被开关关掉时：不压（用于对照实验/运维兜底），语义与"压力不够"区分开，便于排查
          : { compress: false, reason: 'disabled-by-env' };
        if (pressure.compress) {
          try {
            // ★ 压缩的**输入必须是原文 conversation**，不是剪枝视图（pvM.messages）。
            //   剪枝是「这一轮发出去时少发点」，压缩是「把旧组换成摘要」—— 两件事必须正交。
            //   若把剪枝视图喂给压缩器，下面 `conversation = cr2.messages` 就会把剪枝副本
            //   写回主历史：原始工具结果**永久丢失**，而且 DOUYA_PRUNE=0 也回不去
            //   （开关只对"还没压缩过"的时刻有效）—— 只在生产偶发、事后极难归因。
            //   附带后果：保留组里那些带 PRUNE_MARK 的副本会被剪枝的二道防御跳过，
            //   于是 toolPrunes 计数再也不增长，账也对不上。
            //   发送侧不受影响：pruneView() 每轮现算，最终发出去的字节完全一致。
            const cr2 = await compressContextInLoop(conversation, payload, cfg, {
              keepRecentGroups: CTX_KEEP_RECENT_GROUPS,
              minGroups: CTX_MIN_GROUPS,
            });
            if (cr2.compressed) {
              conversation = cr2.messages;
              taskEntry.ctxCompressions = (taskEntry.ctxCompressions || 0) + 1;
              taskEntry.ctxTokensSaved = (taskEntry.ctxTokensSaved || 0) + Math.max(cr2.tokensBefore - cr2.tokensAfter, 0);
            }
          } catch (e) {
            // 压缩是**优化**不是必需品：失败绝不能拖垮任务，原样继续（宁可多花 token 也别中断）
            console.warn('[context] 循环内压缩异常，已跳过本次：', e && e.message);
          }
        }
      }
      // ★ 2026-09-24 轮数轴与预算轴对称化后，本段**职责被重新划定**（原来是"提前 3 轮提醒收拢"）：
      //   自 turn >= MAX_TURNS * TURN_WRAPUP_RATIO 起 wrapUpMode 已经在替模型收尾（见 wrapUpReason），
      //   所以这里**不再重复"别再重复读文件/尽快产出"那套话**（同一件事说两遍＝既费 token 又稀释指令）。
      //   现在它只负责**硬停前的最后通牒**：明说"到点会被强制停止"，让模型主动把该说的话说完，
      //   而不是等被切断之后才由 E2 那段收尾文案事后告知。触发点也改用"剩余轮数"，与 24 这个具体数字解耦。
      if (turn >= MAX_TURNS - 2) {
        conversation.push({
          role: 'user',
          content: '（系统提示·最后通牒）只剩最后 ' + (MAX_TURNS - turn) + ' 轮，到点会被强制停止（不是暂停、不会自动续）。'
            + '不要再做新的探索或读取，立刻用自然语言向我总结：已经完成了什么、产出的文件在哪、以及还差什么没做完。',
        });
      }
      // thinking 契约 400 的一次自愈重试：request body 里含 reasoning_effort，重试必须按新的
      // wantThink() 重建，因此把「构建 body + 发送 + 判定」放进这个小循环（最多 2 次；第 2 次必定关闭思考）。
      // 这样即便撞上会校验契约的上游通道，用户也只会感知到「多等一拍」，而不是任务失败。
      let body = null;
      let resp = null;
      /**
       * ★ 本轮**真正塞进 body.tools** 的表（渐进披露的唯一作用点）。
       *
       * 上一轮 `find_skills` 披露的 id 在 `disclosedSkillIds` 里 ⇒ 本轮自然会多出来几个技能，
       * 这就是"查到之后下一轮可直接调用"的实现。关闭开关时 `turnToolsFor` 返回**全量表的副本**，
       * 与改动前逐字节一致（判据在 lazyTools.isLazyEnabled，门禁 L11 用能让行为分叉的值真跑）。
       *
       * ⚠️ 位置纪律：必须算在 `for (attempt ...)` **外面**。thinking 契约 400 的自愈重试是同一轮的
       *   第二次请求，工具表不该跟着变（同一轮内披露集合不会动；但一旦哪天有人在循环里加披露，
       *   放进去就会让"重试"变成"换了张表再问一次"，那是最难查的一类前后不一致）。
       */
      const turnTools = lazyTools.turnToolsFor(tools, disclosedSkillIds, lazySkillIds, payload);
      // 剪枝计数放在这里（`for (attempt ...)` 之外），thinking 契约 400 的自愈重试不会双记。
      const pv = pruneView();
      if (pv.pruned) {
        taskEntry.toolPrunes = (taskEntry.toolPrunes || 0) + 1;
        taskEntry.toolPruneCharsSaved = (taskEntry.toolPruneCharsSaved || 0)
          + Math.max(pv.plan.charsBefore - pv.plan.charsAfter, 0);
      }
      // ★ 发出去的是**剪枝后的视图**，不是 conversation 本人。
      //   为什么这样记也不会说谎：下方 taskTrace.llmReq 记的是 `body.messages`，
      //   所以执行记录自动变成「剪枝后真正发出去的那份」—— 不要额外去记 conversation。
      //   未剪时 pv.messages === conversation（同一引用）⇒ 零拷贝、零行为变化。
      const sendMessages = pv.messages;
      // ── 执行单元 ⑤ model-call（形态 W）──────────────────────────────────────
      // 块内 3 个同级声明（`body`/`resp` 在外，`turnTools` 在外）⇒ 可包。
      // ok = 最后一次上游响应是不是 2xx；status 记真值（0 = 一次响应都没拿到）。
      // count = **真发出去**的请求次数 —— thinking 契约 400 的自愈重试是真的多打了一次，
      //   不许用「一轮 = 一次」推算（本仓实测过 5 轮打了 7 次）。
      let _luMcOk = true;
      let _luMcStatus = 0;
      let _luMcN = 0;
      const _luMcT0 = Date.now();
      const __luMc = __luTracker.begin('model-call');
      try {
      for (let attempt = 0; attempt < 2; attempt++) {
        _luMcN += 1;
        body = { model, messages: sendMessages, tools: turnTools, temperature: pickTemp(currentPhase), stream: true, stream_options: { include_usage: true }, ...(wantThink() ? { reasoning_effort: REASONING_EFFORT } : { reasoning_effort: 'none' }), ...(enableSearch ? { enable_search: true } : {}), ...(suppressMaxTokens ? {} : { max_tokens: MAX_OUTPUT_TOKENS }) };
        // [DEBUG 温度] 仅当 DOUYA_DEBUG_TEMP=1 时打印每轮 phase/temperature，便于核对分阶段温度；默认关闭不污染日志
        if (process.env.DOUYA_DEBUG_TEMP === '1') {
          console.log('[DEBUG temp] turn=' + turn + ' attempt=' + attempt + ' phase=' + currentPhase + ' temperature=' + pickTemp(currentPhase));
        }
        const ctrl = new AbortController();
        taskEntry.ctrl = ctrl; // 供 /api/abort 立刻打断本次上游请求（否则要等 fetch 自己结束）
        const to = setTimeout(() => ctrl.abort(), 180000);
        // 【执行记录 · LLM 请求】记下这一轮**到底把什么发给了模型**。
        // 此前这段输入只活在 conversation 局部变量里，事后完全不可重建：
        //   「模型第 3 轮看没看到那条工具结果」「压缩有没有把关键上下文吃掉」都无从判断。
        // 只记结构（角色/长度/头部），全文要 DOUYA_TRACE_FULL=1 —— 默认不落整段对话（隐私 + 体积）。
        try {
          taskTrace.llmReq(taskId, {
            turn,
            model,
            temperature: body.temperature,
            thinking: !!body.reasoning_effort && body.reasoning_effort !== 'none',
            search: !!body.enable_search,
            maxTokens: body.max_tokens,
            tools: (Array.isArray(body.tools) ? body.tools : []).map((t) => (t && t.function && t.function.name) || ''),
            messages: body.messages,
          });
        } catch { /* 旁路 */ }
        try {
          resp = await fetch(upstreamURL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
          _luMcStatus = Number(resp && resp.status) || 0; _luMcOk = !!(resp && resp.ok);
        } catch (e) {
          _luMcOk = false;   // 请求根本没发成（叫停 / 超时 / 上游失败）：status 保留值，不另编数字
          clearTimeout(to);
          taskEntry.ctrl = null;
          if (e.name === 'AbortError') {
            // 区分「用户主动停」（叫停会 abort 这个 ctrl）与「超时」
            if (isAborted()) {
              taskEntry.abortReason = taskEntry.abortReason || 'user';
              await reportAbort();
              return;
            }
            taskEntry.aborted = true;
            taskEntry.abortReason = 'timeout';
            sendPhase('stuck', '响应超时', lastProgress);
            await reportAbort('（这一步思考/响应超过了 3 分钟，我主动停下避免无限等待）');
            return;
          }
          send({ error: 'upstream request failed: ' + e.message });
          // 【统一终态收尾 2026-10-23】上游请求直接失败 ⇒ 任务根本没跑完。
          // 修前这条出口不设任何终态，finally 的 persistTask 用的是初值 'done' —— 用户看到「完成」。
          terminalStateFinal = TERMINAL.PARTIAL;
          terminalReason = 'upstream-request-failed';
          return;
        } finally {
          clearTimeout(to);
        }
        if (resp.ok) break;
        const errTxt = await resp.text().catch(() => '');
        if (attempt === 0 && isReasoningContractError(errTxt)) {
          thinkForcedOff = true;
          console.log('[reasoning] 命中 thinking 契约 400，已关闭思考并重试同一轮');
          continue;
        }

        // 自愈：上游不认显式 max_tokens（或嫌太大）⇒ 去掉它重试同一轮。
        // 宁可退回上游默认，也绝不让"为了加大上限"反而把整轮请求打成 400。
        if (attempt === 0 && /max_tokens|max output|maximum context/i.test(errTxt)) {
          suppressMaxTokens = true;
          console.log('[max_tokens] 上游拒绝显式 max_tokens，已去掉并重试同一轮');
          continue;
        }
        send({ error: 'upstream ' + resp.status + ': ' + errTxt.slice(0, 300) });
        // 【统一终态收尾 2026-10-23】上游 HTTP 非 2xx 且两次自愈都没命中 ⇒ 任务没跑完。
        // 同上：修前这条出口留下的是初值 'done'。
        terminalStateFinal = TERMINAL.PARTIAL;
        terminalReason = 'upstream-http-error';
        return;
      }
      } catch (__luE) {
        _luMcOk = false;
        throw __luE;
      } finally {
        try {
          __luTracker.end('model-call', __luMc, {
            ok: _luMcOk, status: _luMcStatus, count: _luMcN, ms: Date.now() - _luMcT0,
          });
        } catch (__luE2) { try { process.stderr.write('[loop-unit] end model-call failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
      }

      // ===== 流式读取：边推 content/reasoning 给前端，边累积 tool_calls =====
      // 这是「体感提速」的关键：模型边想边出字，用户马上看到，不用等完整生成完才一次性吐出。
      // 工具调用参数（tool_calls）在流式里是分片累积的，这里手工拼接成完整对象。
      // ── 执行单元 ⑥ stream-read（形态 **P · 不可包裹**）─────────────────────────
      // 不包 try/finally 的原因：块内 7 个声明（`contentAcc` / `toolCallMap` / `streamIdle` /
      //   `turnFinishReason` / `streamUsage` / `sdec` / `sbuf`）在 8700 之后被反复引用，
      //   包进 try 会让它们全部 ReferenceError。
      // begin 放在 `let contentAcc` 之前 ⇒ `ms` 含整段读流耗时，且不必动那 7 个声明。
      const _luSrT0 = Date.now();
      const __luSr = __luTracker.begin('stream-read');
      let contentAcc = '';      // 本轮累积的正文（已实时推给前端）
      let reasoningAcc = '';    // 本轮累积的思考（deepseek-chat 无，仅 reasoner 有）
      let reasoningStarted = false; // 本轮是否已开始流出思考（首次时更新进度条为「深度思考中」）
      const toolCallMap = {};   // index -> { id, name, argsStr }
      // 本轮上游给的结束原因。★ 此前整条链路**从来没读过它** ⇒「因输出上限被截断（length）」与
      // 「正常结束（tool_calls）」在本地长得一模一样，谁也发现不了参数其实是半截的。
      let turnFinishReason = null;
      let streamErr = null;
      let streamUsage = null;
      const reader = resp.body.getReader();
      const sdec = new TextDecoder();
      let sbuf = '';
      const handleLine = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const raw = t.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        let j;
        try { j = JSON.parse(raw); } catch { return; }
        if (j.usage) streamUsage = j.usage;
        // 结束原因必须落下来：截断归因（"你不是漏写，是没写完"）全靠它
        if (j.choices && j.choices[0] && j.choices[0].finish_reason) turnFinishReason = j.choices[0].finish_reason;
        const delta = j && j.choices && j.choices[0] && j.choices[0].delta;
        if (!delta) return;
        if (delta.reasoning_content) {
          if (!reasoningStarted) {
            reasoningStarted = true;
            // 模型开始深度思考：把进度条推到「思考中」，让用户知道没卡住、正在想
            sendPhase('thinking', '深度思考中', Math.max(lastProgress, 20));
          }
          reasoningAcc += delta.reasoning_content;
          send({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          contentAcc += delta.content;
          // 以 OpenAI 流式格式转发，前端现有打字机逻辑直接边出字
          send({ choices: [{ delta: { content: delta.content }, index: 0, finish_reason: null }] });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            if (!toolCallMap[idx]) toolCallMap[idx] = { id: '', name: '', argsStr: '' };
            if (tc.id) toolCallMap[idx].id = tc.id;
            if (tc.function) {
              if (tc.function.name) toolCallMap[idx].name += tc.function.name;
              if (tc.function.arguments) toolCallMap[idx].argsStr += tc.function.arguments;
            }
          }
        }
      };
      // 心跳：模型深度思考时可能几十秒不吐字，定期发 keepalive 让前端知道「没卡死，还在想」。
      let heartbeat = null;
      if (!isShopping) {
        heartbeat = setInterval(() => {
          send({ type: 'heartbeat', thinking: reasoningAcc.length > 0 });
        }, 6000);
      }
      // ⑦ 流式「空闲」超时：reader.read() 上游卡死时会永久 pending，而心跳仍在发 ⇒ UI 永久假活。
      // 用 Promise.race 给每次 read 加一个空闲计时器：读完一个 chunk 就清掉（空闲语义），
      // 连续 STREAM_IDLE_TIMEOUT_MS 无 chunk 即判上游卡死。整体时长不设限（长生成不误杀）。
      let streamIdle = false;
      const readWithIdle = () => new Promise((resolve, reject) => {
        let settled = false;
        const idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('stream-idle-timeout'));
        }, STREAM_IDLE_TIMEOUT_MS);
        reader.read().then(
          (v) => { if (settled) return; settled = true; clearTimeout(idleTimer); resolve(v); },
          (e) => { if (settled) return; settled = true; clearTimeout(idleTimer); reject(e); },
        );
      });
      try {
        while (true) {
          const { done, value } = await readWithIdle();
          if (done) break;
          sbuf += sdec.decode(value, { stream: true });
          const lines = sbuf.split('\n');
          sbuf = lines.pop();
          for (const line of lines) handleLine(line);
        }
        if (sbuf) handleLine(sbuf);
      } catch (e) {
        if (e && e.message === 'stream-idle-timeout') streamIdle = true;
        else streamErr = e;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      // ── stream-read 收尾（形态 P：end 紧跟块尾）。ok 取块内**自己的**错误信号，
      //   不是从外面猜：`streamErr` 是那块 catch 记下的、`streamIdle` 是空闲超时置的。
      try {
        __luTracker.end('stream-read', __luSr, {
          ok: !streamErr && !streamIdle,
          count: turnFinishReason ? 1 : 0,
          ms: Date.now() - _luSrT0,
          ...(streamErr ? { reason: 'stream-error' } : (streamIdle ? { reason: 'stream-idle' } : {})),
        });
      } catch (__luE) { try { process.stderr.write('[loop-unit] end stream-read failed: ' + (__luE && __luE.message) + '\n'); } catch { /* ignore */ } }
      // ⑦ 空闲超时触发：如实告知「上游响应中断」，走既有优雅收尾（**成果不丢**），
      // 落盘状态用 'stream-idle' 与「用户主动停(aborted)」「撞轮数上限(incomplete)」明确区分。
      if (streamIdle) {
        endStatus = 'stream-idle';
        taskEntry.abortReason = 'stream-idle';
        taskEntry.current = { step: taskEntry.stepNo, skill: taskEntry.lastSkill || '', status: 'stream-idle' };
        taskEntry.lastError = 'upstream idle > ' + Math.round(STREAM_IDLE_TIMEOUT_MS / 1000) + 's';
        sendPhase('stuck', '上游响应中断', lastProgress);
        try { send({ type: 'stream_idle', idle_ms: STREAM_IDLE_TIMEOUT_MS }); } catch { /* ignore */ }
        // 已完成成果照常保留（与中断一致的「不白做」语义）
        if (deliverables.length) {
          try { appendDeliverables(deliverables, payload.username); } catch { /* ignore */ }
          try { send({ type: 'deliverables', items: deliverablesForUser(), workspace: AGENT_WORKSPACE }); } catch { /* ignore */ }
        }
        try { persistTask('stream-idle'); } catch { /* ignore */ }
        const idleSec = Math.round(STREAM_IDLE_TIMEOUT_MS / 1000);
        emitGateReport();   // 跳过的闸门走独立事件（前端折叠条），不再拼进正文
        await sendTextAsStream(
          '（上游响应中断：超过 ' + idleSec + ' 秒没有收到新数据，我已停下避免无限等待，**本次任务未完成**）' +
          (deliverables.length ? '\n已完成并产出的文件（已保留，可直接打开）：\n' + deliverables.map((d) => '· ' + d.path).join('\n') : '') +
          // ★ 2026-11-03：说清「停在哪、已完成的可直接用、接着做不丢进度」，
          //   而不是只丢一句「说一声我接着做」让用户自己猜前面做的还在不在。
          '\n我是卡在等待上游回复这一步停下的，不是做错了什么。上面列出的文件都已经写好，可以直接打开用。' +
          '\n接着做不会丢进度（已完成的部分和当前进度都在任务记录里），你说一句「继续」，我就从断的地方往下走。'
        );
        await appendPendingNote();
        sendPhase('done', '上游响应中断已停止', lastProgress);
        return;
      }
      if (streamErr && contentAcc === '' && Object.keys(toolCallMap).length === 0) {
        if (isAborted()) { await bailIfAborted(null); return; }
        send({ error: 'upstream stream failed: ' + streamErr.message });
        // 【统一终态收尾 2026-10-23】流出错且既无正文也无 tool_calls ⇒ 这一轮什么都没拿到。
        // 修前落到 finally 时 endStatus 仍是初值 'done'（用户看到「完成」而实际一个字都没产出）。
        terminalStateFinal = TERMINAL.PARTIAL;
        terminalReason = 'upstream-stream-failed';
        return;
      }
      // 流式读取结束后、进入工具执行前，再查一次中断（用户可能在模型出字时按了停止）
      if (await bailIfAborted(null)) return;

      // 统计本轮 token 用量（优先用上游返回的真实 usage，拿不到就估算）
      const pt = (streamUsage && typeof streamUsage.prompt_tokens === 'number') ? streamUsage.prompt_tokens : estimateTokens(body.messages);
      const ct = (streamUsage && typeof streamUsage.completion_tokens === 'number') ? streamUsage.completion_tokens : estimateTokens([{ content: contentAcc }]);
      // 缓存命中量（网关按 DeepSeek 口径返回）。拿不到时 computeTurnCost 自动退化为增量法。
      const cacheHitRaw = streamUsage && (typeof streamUsage.prompt_cache_hit_tokens === 'number'
        ? streamUsage.prompt_cache_hit_tokens
        : (typeof streamUsage.cached_tokens === 'number' ? streamUsage.cached_tokens : undefined));
      addUsage(payload.username, pt, ct, { model, src: 'agent' });
      // 累计本任务用量（下一轮开头据此判预算）。
      // 🔴 只累加**新增**（work），不累加整份重发的 prompt —— 否则同一上下文被反复计费，
      //    长任务会在中途被"预算耗尽"掐断（详见 computeTurnCost 的说明）。
      const turnCost = computeTurnCost({
        promptTokens: pt,
        completionTokens: ct,
        cacheHitTokens: cacheHitRaw,
        lastPromptTokens: lastPromptTokens,
      });
      lastPromptTokens = pt;
      taskEntry.usedTokens = (taskEntry.usedTokens || 0) + turnCost.work;
      // 诚实记账：台账里同时留下"真实用量"与"闸门口径"，事后能审计出计量有没有偏。
      taskEntry.billableTokens = (taskEntry.billableTokens || 0) + turnCost.billable;
      taskEntry.reusedTokens = (taskEntry.reusedTokens || 0) + turnCost.reused;
      taskEntry.lastCostMethod = turnCost.method;

      // 组装本轮消息（含流式累积的 tool_calls），塞回对话保持一致性
      const toolCalls = Object.keys(toolCallMap)
        .sort((a, b) => a - b)
        .map((k) => {
          const tc = toolCallMap[k];
          return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argsStr } };
        });
      const msg = { role: 'assistant', content: contentAcc || null };
      if (reasoningAcc) msg.reasoning_content = reasoningAcc;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      // ★ 2026-09-24 本轮工具调用数（模型**发出**了多少次调用，与"成功几次"分开记）
      turnSnap.tools += toolCalls.length;
      taskEntry.toolCalls += toolCalls.length;
      conversation.push(msg);
      // 【执行记录 · LLM 响应】每一轮的收口点（所有分支都经过这里，因为 msg 必须入队）。
      // ★ 最有价值的字段是 finishReason：'length' 是"参数被输出上限掐断"的**唯一**证据，
      //   而此前它只存在内存变量 turnFinishReason 里，用于当轮控制流后即丢。
      //   实测后果：事后无法区分「模型给错了参数」和「JSON 被截断」——这两者的修法完全相反。
      try {
        taskTrace.llmResp(taskId, {
          turn, finishReason: turnFinishReason, usage: streamUsage,
          content: contentAcc, thinking: reasoningAcc, toolCalls,
        });
      } catch { /* 旁路 */ }

      // ── 执行单元 ⑦ acceptance（形态 W）───────────────────────────────────────
      // verdict 只取**结构化裁决**（`acceptanceForLedger`，由 runStandaloneAcceptance 产出），
      //   取不到就 null + reason=no-structured-verdict。**绝不许**从正文 grep 关键词 ——
      //   那是"从模型的话里推断执行过什么"，正是规格 §2.4-1 明令禁止的那一类。
      const _luAcT0 = Date.now();
      const __luAc = __luTracker.begin('acceptance');
      try {
      if (toolCalls.length === 0) {

        // 【截断收尾闸门】最高优先级信号：本轮**没有任何工具调用**，但上游明确说输出是被长度上限掐断的
        // （finish_reason='length'）⇒ 这就不是"最终回答"，而是"话说到一半没说完"/「写到一半 token 用完」。
        // 此前这一层**把 turnFinishReason 完全丢掉了**：半截回答会被当成完整结论收尾，
        // 用户看到的就是"说着说着就断了"，而系统认为一切正常。只拦一次，避免死循环。
        if (turnFinishReason === 'length' && !truncatedTurnHandled && (contentAcc !== '' || deliverables.length > 0)) {
          truncatedTurnHandled = true;
          conversation.push({
            role: 'user',
            content: '【本轮输出被截断】你上一条回答**没有说完就被输出上限截断了**（上游结束原因=length，本轮已用输出 '
              + ((streamUsage && streamUsage.completion_tokens) || '?') + ' tokens）。所以它不是一个完整结论，**不要把它当任务已完成**。\n'
              + '· 请接着把没说完的部分说完。\n'
              + '· 如果本来是要把一大段内容写进文件：改用「写文件」技能并加 "mode":"append" **分次追加**，'
              + '不要试图把几万字节塞进一次调用里。\n'
              + '· 已经产出的文件不用重做。',
          });
          sendPhase('building', '回答被截断，继续补完', Math.max(lastProgress, 30));
          continue;
        }

        // 【收尾前自检】模型想收尾了 —— 先核对它声称的成果**真的落地了**。
        // 为什么必须有：「说做完了」「文件存在」「文件不是半截」是三件事。
        // 它是把大文件一次写出来的，一旦生成被输出上限截断，完全可能留下 0 字节/半截文件还照样汇报成功。
        // 只做一次（artifactVerifyDone）：补不齐也允许收尾，但必须让用户看到实情。
        if (deliverables.length && !artifactVerifyDone) {
          artifactVerifyDone = true;
          const v = verifyDeliverables(
            deliverables.map((d) => ({ name: d.name, path: path.isAbsolute(d.path) ? d.path : path.resolve(AGENT_WORKSPACE, d.path) }))
          );
          if (!v.ok) {
            conversation.push({ role: 'user', content: verificationDirective(v) });
            sendPhase('building', '自检未通过，先补齐产物', Math.max(lastProgress, 30));
            continue;
          }
        }
        // 【防嘴炮兜底】产出型任务里，模型可能只回复「做好了/文件在XX」却没真正调写文件技能落地，
        // 导致 deliverables 为空、成果卡不显示、历史面板无记录。此时补一轮强制提示，逼它真正调
        // 「写文件/搭建项目」把成果写到工作区（最多 1 次，防死循环）。
        if (WANTS_FILE_OUTPUT.test(lastUserText) && !READ_ONLY_HINTS.test(lastUserText) && deliverables.length === 0 && !antiMouthCannonFired) {
          antiMouthCannonFired = true;
          conversation.push({
            role: 'user',
            content: '系统检查到你还没有真正生成任何文件。这是产出型任务，必须真正调用「写文件」或「搭建项目」技能把成果写到工作区，不能只在文字里说做完了。请现在补做，然后把文件的完整绝对路径告诉我。',
          });
          sendPhase('building', '补写成果文件', Math.max(lastProgress, 30));
          continue;
        }
        // 【半成品交付闸门】规范 §二：「已经完成，剩下 XXX 你可以自己处理」被明令禁止 ——
        // 只要"剩下的事"是完成用户目标所必需的，任务就**没有完成**。
        // 为什么要有这一层：上面三道闸门管的是「有没有产物」「产物完不完整」「有没有被截断」，
        // 但还有一种收尾是**文字上就把活甩回给用户**（做了一半 + 列一堆"剩下的你可以自己处理"），
        // 它三条都绕得过去：不写文件就没有 deliverables、没被截断就 finish_reason 正常。
        // 这类话术是可以被文字检出的，所以必须在这里真的拦下来，而不是只写在人设里"劝"。
        // 例外：合法的 BLOCKED（已试过≥2条路 + 四段式齐全）允许停下 —— 规范 §十三 明确承认这个出口。
        // 只拦一次（bailOutHandled），否则会与模型的固执互相死锁。
        if (contentAcc && !bailOutHandled) {
          const bo = detectBailOut(contentAcc);
          if (bo.hit) {
            const legit = bo.kind === 'cannot' && isLegitimateBlocked(contentAcc);
            if (!legit) {
              bailOutHandled = true;
              conversation.push({ role: 'user', content: bailOutDirective(bo) });
              sendPhase('building', '还有关键步骤没做完，继续', Math.max(lastProgress, 30));
              continue;
            }
          }
        }

        // 【证伪闸门】人设「二十一：先证伪自己的第一判断（假设 ≠ 事实）」此前**只是文字**，零运行时强制。
        // 这是最隐蔽的失败模式：模型**不必说错话**，只要把一条没验证过的归因说成结论，
        // 用户就会拿它当事实去做决策。话术可被文字检出 ⇒ 必须真的拦，而不是只靠人设"劝"。
        // 与上面的 §二 闸门同构（弱判定 → 纠正指令 → 终态兜底），同样**只拦一次**防死锁。
        // ★ 放行条件很关键：已做过反证动作、或已明说「这只是推断 / 尚未验证」⇒ **不拦**（那正是正确表述）。
        if (falsificationGateEnabled() && contentAcc && !falsifHandled) {
          const fal = detectCausalClaim(contentAcc);
          if (fal.hit && missingFalsificationParts(contentAcc).length > 0) {
            falsifHandled = true;
            conversation.push({ role: 'user', content: falsificationDirective(fal) });
            sendPhase('building', '先证伪自己的第一判断，继续', Math.max(lastProgress, 30));
            continue;
          }
        }

        // 模型给出最终回答：正文已在上面流式推给前端，这里只做收尾。
        // 情况一：流式没推到任何字（异常/空正文）→ 走「只许说话」兜底请求，确保用户一定收到话。
        // 情况二（2026-09-17 新增）：正文非空、但**本次任务真的动过手**（写过文件 / 跑过命令 /
        //   连过服务器 / 查过库）且还没给过结论 → 强制补一次结论汇报。
        //   原逻辑只在 contentAcc === '' 时才兜底，于是模型只要在最后吐一句「好了」就能顺利收尾、
        //   不给任何结论 —— 用户原话：「并没有告诉你结果是什么，他真的改了吗」。
        //   这里就是那句话的**机制性根因**。
        if (contentAcc === '' || (taskEntry.wroteCount > 0 && !forcedSummaryDone)) {
          const summaryOnly = contentAcc !== '';
          forcedSummaryDone = true;
          const ok = await finalizeWithText(summaryOnly);
          // summaryOnly 模式下失败就算了：用户已经有正文，不该再用模板话术盖上去
          if (!ok && !summaryOnly) {
            await sendTextAsStream(
              deliverables.length
                ? '做完了。文件我已经写好放在下面的成果里了，你可以直接打开看看，有想改的地方告诉我。'
                : '这一轮我处理完了，你看看还需要我做什么？'
            );
          }
        }
        finalTextSent = true;
        // 【产物诚实标记】收尾前再**静默**核一次产物（只读、不再打回，不影响循环次数）。
        // 为什么必须有：上面的自检只允许补一轮，补完就不再验证 —— 于是"第二轮仍然没修好"会一路
        // 走到这里，把残缺文件当成果发出去、界面还显示「完成」。那正是老板规范明令禁止的
        // 「**文件写出来了所以完成**」。可信出口只有两个：
        //   COMPLETE = 产物存在 + 验证通过 ｜ BLOCKED = 已试过恢复 + 确实没做出来（明说卡在哪）。
        // 位置刻意放在发成果卡**之前**：先让用户看到"有东西没做好"，再看到成果，而不是反过来。
        let finalArtifactsOk = true;
        if (deliverables.length) {
          const fv = verifyDeliverables(
            deliverables.map((d) => ({ name: d.name, path: path.isAbsolute(d.path) ? d.path : path.resolve(AGENT_WORKSPACE, d.path) }))
          );
          finalArtifactsOk = fv.ok;
          if (!fv.ok) await reportArtifactVerdict(fv);
        }
        if (deliverables.length) {
          appendDeliverables(deliverables, payload.username);
          send({ type: 'deliverables', items: deliverablesForUser(), workspace: AGENT_WORKSPACE });
        }
        // 若有闸门跳过了步骤，收尾必须把「哪些没做」明确告知用户（诚实记账，不许静默）。
        // ★ 2026-11-03：这里原来是把跳过的闸门拼成一段以「【无人值守提示】」开头的
        //   **正文**续在 assistant 流后面 —— 于是它跟正文混在一起、前端拿不到边界，而且这段在主循环
        //   体内，每轮收尾都会再追加一次（1 + 4 段自查 = 5 次），用户在**一次**对话里看到 7 段一样的字。
        //   改为独立事件 `gate_report`，由前端渲染成一条默认收起的折叠条；
        //   内容不变就不重发（emitGateReport 内部按签名去重）。
        emitGateReport();
        // 待批清单的正文通道（③）。放在这里而不是塞进 emitGateReport 里：
        // 那个函数是同步的、且被 5 处调用（每轮收尾都调一次），让它去 await 正文流会把
        // "发事件"变成"发事件 + 可能发一段字"，时序上不可控。
        // 本函数自带内容去重，重复调用不会重复占行。
        await appendPendingNote();
        // 【终点状态判定】规范 §三：只有「目标对象已实际修改 + 关键功能已实现 + 产物已写入 + 已验证」
        // 才算 COMPLETE。产物没落地、或正文里出现了甩锅话术 ⇒ 一律降级为 PARTIAL，绝不许当完成收尾。
        // 合法 BLOCKED 是唯一"可以停下"的出口，但前提严格（已试过≥2条路 + 四段式齐全，见 isLegitimateBlocked）。
        // ⚠️ 这里**重新检测一次**而不是复用闸门里的结果：闸门只拦一次，若第二轮模型改好了，
        //    复用旧结果会把好答案误判成 PARTIAL（状态残留）。
        const curBailOut = detectBailOut(contentAcc || '');
        // ★ 交叉核对用的「正文自我宣称」必须**先算**：它同时是结论证据门的输入之一
        //   （声称"已完成 / 可交付 / 已修复"这三类，才需要证据；普通过程性描述不走这里）。
        const claimedDone = claimsCompletion(contentAcc || '');
        const claimCtx = {
          deliverables,
          artifactsOk: finalArtifactsOk,
          completionClaimed: claimedDone,
          // 【只认真交付物 2026-10-21】原来是 `deliverables.length > 0` —— 台账里有 1 个
          // check_deck.js 就算「声称有交付物」，于是 claim 生成「产物可以交付」，
          // 而台账里没有产物证据 ⇒ 判「缺证据：产物存在」⇒ 收尾对用户说「还没验证过」。
          // 这就是老板看到的「缺证据：产物存在」的直接来源：**过程脚本冒充了交付物声明**。
          deliverableClaimed: deliverables.some((d) => isRealArtifact(d && d.path, lastUserText)),
          bugfixClaimed: BUGFIX_CLAIM_RE.test(contentAcc || ''),
          doneLog: taskEntry.doneLog,
          userText: lastUserText,   // 证据门判「用户是不是要脚本」用（见 buildClaimLedger）
        };
        // 【第四档取证 2026-02-16】BLOCKED 的硬前提**只算一次**：`blockedEvidenced` 与
        // `blockedDiagnosed` 必须用同一个判据，写成两份表达式迟早漂移。
        const blockedEvidencedNow = curBailOut.hit && curBailOut.kind === 'cannot' && isLegitimateBlocked(contentAcc || '');
        let terminalState = adjudicateTerminal({
          hasDeliverables: deliverables.length > 0,
          artifactsOk: finalArtifactsOk,
          bailOutHit: curBailOut.hit,
          blockedEvidenced: blockedEvidencedNow,
          // 【第四档】确实要进 BLOCKED 时才取证（判据本体在 deliveryProtocol，这里只调用）
          blockedDiagnosed: blockedEvidencedNow
            ? classifyBlockedDiagnosis({ content: contentAcc || '', toolEvents: toolExecLog }).reproducible === true
            : false,
          // 契约②：恢复动作下发后始终没拿到复验读数 ⇒ 不许拿"恢复器自称成功"当完成证据。
          recoveryUnverified: recoveryUnverifiedNow(),
          claimCtx,
        });
        // 【第四档取证 · 为什么是这两个实参】（挪到调用点之外写，不挤占调用处的可读性）
        //   · `content` 用 `contentAcc`：收尾累积的正文，probe（复现命令）只能从它里面抽；
        //   · `toolEvents` 用 `toolExecLog`：本任务自己的执行记录。**不用 trace 文件** ——
        //     `DOUYA_TRACE=0` 时它整个关闭、且有 4000 行上限会在收尾前丢掉最靠后的事件，
        //     拿它取证等于"证据可能刚好被丢掉"，而收尾恰恰发生在最后。
        //   · 只把布尔 `reproducible === true` 传进去：`reason` 只用于事后归因，
        //     不参与终态判定 —— 传对象进去等于给下游留一个"自己解释判据"的口子。
        // ===== 【§二 / §十三 硬门禁】2026-09-22（老板提案第 2 条：异常不能与完成共存）=====
        // 账本里只要还有**未闭环的真失败**，就不许判 COMPLETE —— 不管模型正文写得多漂亮。
        // 这条把"失败账本"真正接进了完成门禁：账本不再是给人看的日志，而是判定输入。
        // （已闭环的失败（同技能后来做成了）不算，见 markStep 的销账逻辑。）
        const unresolved = openFailures();
        if (terminalState === TERMINAL.COMPLETE && unresolved.length > 0) {
          terminalState = TERMINAL.PARTIAL;
        }
        // ===== 【证伪闸门·终态兜底】人设「二十一」 2026-09-23 =====
        // 上面那轮只拦一次；模型若仍不收口，就要在**终态**上兜住：
        // 正文里有归因结论、却没有反证动作也没有"尚未验证"声明 ⇒ 不许 COMPLETE，降 PARTIAL
        // （与「账本还有未闭环失败」走**同一条**降级路径，不新开出口）。
        // ★ detectCausalClaim / missingFalsificationParts 的结果在这里**真的进了判定分支** ——
        //   不是"读到信号"，是"信号进控制逻辑"（两者的区别见 §claimsCompletion 那段注释）。
        // ★ falsificationGateEnabled() 参与同一条判定：关掉开关 ⇒ 本降级不发生（单测的对照组）。
        // >>> FALSIFICATION_GATE_BEGIN（unit-falsification-gate.mjs 按这对标记**抽取真实代码**在内存里跑，
        //     不是抄一份逻辑 —— 抄一份跑出来的只是副本的结果。标记内改动必须同步通过那套单测。）
        const curCausal = detectCausalClaim(contentAcc || '');
        const curMissingFalsif = missingFalsificationParts(contentAcc || '');
        const falsifDowngraded = !!(falsificationGateEnabled()
          && curCausal.hit
          && curMissingFalsif.length > 0
          && terminalState === TERMINAL.COMPLETE);
        if (falsifDowngraded) {
          terminalState = TERMINAL.PARTIAL;
        }
        // <<< FALSIFICATION_GATE_END
        // 【§十三 / §十九 交叉核对】模型正文里写了「已完成」，但门禁并没有判它 COMPLETE ——
        // 这两件事只要不一致，就必须**当场更正**（主动更正，不许等用户发现）。
        // 2026-09-22 接线：claimsCompletion 早就实现，但 backend 从未调用过 —— 那等于没做。
        // 现在它真的参与判定：声称完成 + 终态不允许 ⇒ 收尾文案里必须纠正这句自我宣称。
        // （claimedDone 已在上面算好 —— 它同时是结论证据门的输入，所以只算一次。）
        const mustCorrectClaim = claimedDone && terminalState !== TERMINAL.COMPLETE;
        // 非 COMPLETE 时，必须把"还没做完 / 卡在哪"如实说出来；绝不许界面写着完成、实际是半成品。
        // 放在成果卡之后：用户先看到成果，再看到"其中哪些其实没做好"，避免顺序造成"已交付"的误判。
        // 产物本身就坏了的情况由上面的 reportArtifactVerdict 已经说过，这里不重复。
        // ★ 规范 §29：这段是**给用户看的**，所以走 finalReport 整形 —— 只说「做到哪了 / 还差什么 /
        //   为什么卡 / 你只需提供什么」，**不带任何过程统计**（调用了几个工具、重试几次一律不出现）。
        if (terminalState !== TERMINAL.COMPLETE && finalArtifactsOk) {
          await sendTextAsStream(finalReport({
            state: terminalState,
            // ★ 2026-09-25 出口层接线：把**同一次**结论证据判定的账本交给报告。
            //   用的是上面 adjudicateTerminal 留下的 lastClaimEval，**不在这里重算** ——
            //   重算就是两套判定，迟早漂移（这条纪律见 adjudicateTerminal 的注释）。
            //   没有账本（门禁关闭 / 没有关键结论）⇒ 传 null，报告按"还没验证过"处理（保守方向）。
            claims: lastClaimEval ? lastClaimEval.claims : null,
            pending: falsifDowngraded
              ? ['把这条结论的依据补做成「先证伪自己的第一判断」（找反证，或明确标成未验证的推断）']
              : (curBailOut.hit ? ['正文里被交还给你的那些步骤'] : []),
            stuckAt: mustCorrectClaim
              ? '我上面写了「已完成」，这句话不成立 —— 以本段为准，这件事还没做完'
              : (falsifDowngraded
                ? '我给了你一个**结论式的归因**，但没有给出找反证的过程，也没说它还没验证 —— 所以它现在只能算推断，不能算结论'
                : (unresolved.length
                  ? '有 ' + unresolved.length + ' 处试过但没做成，我换过方式，还没换到能用的那一条'
                  : (recoveryUnverifiedNow()
                    ? '有一次失败恢复的动作执行后，我还没拿到复验读数 —— 恢复器说自己"好了"不算证据，复验读数才是唯一权威'
                    : (curBailOut.hit ? '这部分工作我没有做完，不该交给你处理' : '')))),
            needFromUser: '（需要我再说清一次，你问我就行）',
            afterUserCanDo: '接着往下做完并把结果给你',
          }));
        }
        // 成功文案不在这里发：后面还有 AI 审查与客观验收，任何否决都必须先于成功表述。
        // 【结论证据与反证门 · 收尾留痕】2026-09-24
        // 判据降级了，就必须**说清凭什么**：哪条结论没立住、缺的是哪一份证据。
        // ★ 这里用的是 adjudicateTerminal 里那次判定的结果（lastClaimEval），不重算 —— 重算就是两套判定。
        // ★ 放在四段式**之后**：先让用户看到"做到哪了"，再看到"这句话为什么还不能成立"。
        // ★ 全部结论都成立时返回空串 ⇒ 一个字都不多说（不许把正常收尾也拖成"验证报告"）。
        const claimGap = claimGapStatement(lastClaimEval);
        if (claimGap) await sendTextAsStream(claimGap);
        // ===== 三态如实说明（2026-10-21，老板第 4 关）=====
        // 「我打算做 / 我执行了 / 我验证通过」是三件事，不许混成一句「做好了」。
        // 放在 AI 验收**之前**：先给客观事实（几个动作被拦、几个真跑了、几项验过），
        // 再让自检员/复检员给主观判断。顺序反过来会让"AI 说挺好了"盖过"其实一次没执行"。
        // 只在三态有落差时说话（三个数字对得上就返回空串，正常收尾一个字都不多）。
        const userWantsArtifact = WANTS_FILE_OUTPUT.test(intentText) && !READ_ONLY_HINTS.test(intentText);
        const traceText = buildTraceReport({
          // 打算做 = 被闸门拦下的次数 + 真正执行过的次数（两者都是模型发起的动作）
          attempted: (taskEntry.intentBlocks || 0) + (taskEntry.execCount || 0),
          executed: taskEntry.execCount || 0,
          // 验证通过 = 终态判成 COMPLETE 且产物逐个核过，才计作"验过"
          verified: (terminalState === TERMINAL.COMPLETE && finalArtifactsOk) ? deliverables.length : 0,
          blockedByGate: (taskEntry.intentBlocks || 0) > 0,
          expectArtifact: userWantsArtifact,
          needFromUser: '直接说「做吧」，或者把要求写成一句明确指令（带上要产出的东西名，比如「做一份 15 页 PPT」）',
        });
        if (traceText) await sendTextAsStream(traceText);
        // ===== 2026-10-18 第十六轮：Agent 双 AI 自检 + 复检 + 对话汇报（老板第 6 条）=====
        // ===== 2026-10-21 老板实测「做 PPT 反复说等我、最后交空壳报告」之后：让这道闸真的可达 =====
        //
        // ★ 原条件 `payload.scope === 'work' && didToolCall` 上有一个**致命的断链**，必须记下来：
        //   0.21.11（第十九轮）把聊天区「对话 / 工作」分区开关从界面上拿掉了，
        //   `App.jsx:1878 switchChatScope()` 全仓零调用点 ⇒ chatScope 恒为 'chat' ⇒
        //   请求体 scope 恒为 'chat' ⇒ 第一个条件**永远为假**。
        //   而工具被意图闸门拦下时 didToolCall 仍是 false ⇒ 第二个条件也不成立。
        //   ⇒ 老板 10-18 提的这道验收闸，从上线到 10-21 **一次都没跑过**。
        //     这才是「它说做完了却拿不出证据、也没人拦它」的真因 —— 不是模型变差，是闸没开。
        //
        // 新判据见 agentReview.shouldReviewTask（任一成立就跑，纯问答一条都不命中）。
        // 这里**不再**把 scope 写死在条件里：分区只是触发方式之一，不是必要条件。
        const reviewReason = shouldReviewTask({
          scope: payload.scope,
          didToolCall,
          productiveCount: taskEntry.prodCount || 0,
          deliverableCount: deliverables.length,
          intentBlocks: taskEntry.intentBlocks || 0,
          // 用户这一轮要的东西是不是"产出物"（复用既有判据，且排除"只是让我读一读"）
          userWantsArtifact: WANTS_FILE_OUTPUT.test(intentText) && !READ_ONLY_HINTS.test(intentText),
        });
        // 审查否决的留痕（2026-10-22）：空串 = 没有被否决；非空 = 降级原因。
        // 它同时进 traceTerminal 的 facts —— 事后查"为什么不算完成"时，要能区分
        // 「模型没做完」「账本有未闭环失败」「审查否决」这三种完全不同的情况。
        let reviewDowngrade = '';
        // AI 复检报告也只能在客观 general/full 验收之后发；先缓存，避免 fail 前出现“放心用”。
        let pendingAuditReport = '';
        const runtimeReview = runtimeEvidence.summary({
          artifacts: deliverables.map((d) => d.path),
          expectsRuntime: runtimeRequired && !wfCtl,
        });
        if (reviewReason) {
          if (process.env.DOUYA_DEBUG_REVIEW === '1') {
            console.log('[agentReview] 启动验收（理由=' + reviewReason + '）scope=' + (payload.scope || '')
              + ' didToolCall=' + didToolCall + ' deliverables=' + deliverables.length
              + ' 被拦=' + (taskEntry.intentBlocks || 0) + ' 执行=' + (taskEntry.execCount || 0));
          }
          let selfCheck = null;
          try {
            selfCheck = await selfCheckTask({
              baseURL, apiKey, model,
              goal: taskGoal,
              doneLog: taskEntry.doneLog,
              deliverables,
              finalText: contentAcc,
              runtimeSummary: runtimeReview.text,
            });
          } catch (e) { console.error('[agentReview] 自检失败（跳过）：', e && e.message); }
          const reviewRounds = taskEntry.reviewRounds || 0;
          // ══【自查回灌：三个条件缺一不可】══════════════════════════════════════════════
          // ★ 2026-10-23（老板第 3 条修改）：修前这里只有前两个条件，**没有第三个**。
          //   实测 task_mvkad091：reviewRounds 3 < 4 一路放行，最后一次 continue 正好吃掉第 24 轮
          //   ⇒ for 循环退出，模型连一句「还差什么」都没机会说，用户只看到「完成」。
          //   ⇒ 回灌前必须确认「主循环还剩得下说完 + 复验的轮次」，见 REVIEW_RESERVE_TURNS 的注释。
          const selfCheckUnfinished = !!(selfCheck && selfCheck.finished === false && (selfCheck.missing || []).length);
          const canRetryReview = selfCheckUnfinished
            && reviewRounds < AGENT_REVIEW_MAX_ROUNDS
            && turn + REVIEW_RESERVE_TURNS < MAX_TURNS;
          if (canRetryReview) {
            // 没做完：把缺失清单回灌给 agent，要求继续（不 break，回主循环接着干）
            // ★ 2026-11-06：回灌里只引用**最初目标那一段**，且压到 200 字。
            //   为什么不像修前那样 `'「' + taskGoal + '」'` 整段塞进去：taskGoal 现在是
            //   「最初原话 + 【本轮要求】」的合成体，最长 2000 字。原样塞进一句引号里，
            //   一是让这轮 prompt 白烧几百字（内容本来就还在对话历史里），二是两段标题
            //   横在引号中间，模型容易读成"用户又说了一遍"。回灌的目的只是提醒"你在做什么"，
            //   不需要把整份卷子重抄一遍。
            const goalBriefForPush = clip(
              String(taskGoal || '').split('\n\n【本轮要求】')[0], 200,
            );
            taskEntry.reviewRounds = reviewRounds + 1;
            send({ type: 'selfcheck', phase: 'continue', round: taskEntry.reviewRounds, missing: selfCheck.missing });
            conversation.push({
              role: 'user',
              content: '（豆芽自查：对照你最初的目标——「' + goalBriefForPush + '」，以下还没做完，请继续：\n'
                + selfCheck.missing.map((m, i) => (i + 1) + '. ' + m).join('\n')
                + '\n做完直接说结果，不要再从头复述。）',
            });
            sendPhase('building', '自查发现还有没做完的，继续', Math.max(lastProgress, 60));
            continue;
          }
          // 走到这里有两种情形，必须能分开——因为它们对用户要说的话完全不同：
          //   ① 自查通过了 ⇒ 什么都不用说；
          //   ② 自查说没做完，但**没法再回灌**（自查轮次用完 / 主循环轮次不够）⇒ 必须如实交底。
          // 修前只有 ①，②被当成 ① 处理（连一句解释都没有）。
          const reviewStopReason = !selfCheckUnfinished ? ''
            : (reviewRounds >= AGENT_REVIEW_MAX_ROUNDS ? 'rounds' : 'turns');
          if (reviewStopReason === 'turns') {
            // 轮次不够而停止回灌：这是**提前止损**，不是失败。用户需要知道「为什么它这时候停」，
            // 否则下一次看到的就是一个没头没尾的未完成。
            // ★ 2026-11-03：修前这里只写「把还差的部分列在下面」，然后**下面什么都没有** ——
            //   承诺了却不兑现，等于把用户晾在那儿（原话：「没完成啥也不知道」）。
            //   现在真把 selfCheck.missing 逐条列出来，并说明「哪部分已可直接用、接着做不丢进度」。
            const miss = (selfCheck && selfCheck.missing) || [];
            const tail = miss.length
              ? '\n还差这几项：\n' + miss.map((m, i) => (i + 1) + '. ' + m).join('\n')
              : '';
            try {
              await sendTextAsStream('\n\n结论：这次没全做完（轮次用完了，不是失败了）。' + tail
                + '\n\n已完成的部分可以直接用。要我接着做，说一句「继续」就行，进度不会丢。\n');
            } catch { /* 文案失败不影响终态 */ }
          }
          // 自检通过（或续跑轮数用尽）⇒ 复检 + 对话汇报
          let audit = null;
          // ★★ 2026-10-23 复检可观测性（老板第 2 条）：把「调用 → 输入摘要 → 结果 → 原因 → 终态决策」
          //   整条链落进 trace。修前只有一句 console.error，且 `audit===null` 时**一声不吭**
          //   ⇒ 事后无法区分"没执行""执行失败""成功但没产生预期事件"（实测 run-20261023050924 就卡在这）。
          //   ⚠️ 只记规模与原因，不记提示词原文与密钥。
          const auditDiag = {
            called: false,
            input: {
              goalChars: String(taskGoal || '').length,
              // ★ 2026-11-06：判卷人这次到底看的哪一份意图 —— 只记来源与长度，不记文本。
              //   修前这里只有一个 goalChars，`source` 这个概念不存在 ⇒ 复盘时看到
              //   "目标 137 字"，既不知道是最后一句还是最初那句，也不知道有没有被截断。
              goalSource: taskGoalMeta.source,
              goalOriginChars: taskGoalMeta.originChars,
              goalTurnChars: taskGoalMeta.turnChars,
              goalTruncated: taskGoalMeta.truncated === true,
              doneLog: Array.isArray(taskEntry.doneLog) ? taskEntry.doneLog.length : 0,
              deliverables: deliverables.length,
              finalTextChars: String(contentAcc || '').length,
            },
          };
          try {
            auditDiag.called = true;
            // ★ 2026-11-03：补上 creativeKind / taskType。
            //   修之前这两个参数**根本没传**（`grep projectRoot src/main/backend.js` = 0 命中），
            //   于是 `normalizeCreativeKind(undefined)` 一律归一成 visual ⇒ 设计维度只查通用 8 项，
            //   网页的「hover 反馈 / 移动端适配 / 加载状态」**从来没被核过**；
            //   `normalizeTaskType(undefined)` 一律归一成 dev ⇒ 创作类任务按开发清单判。
            //   现在用前面设计模具闸门的判定结果反推：判为设计任务 ⇒ creative，并按类型给 kind。
            //   ⚠️ 非设计任务**保持不传**（等价于原来的缺省），不去猜"它其实是 dev" ——
            //      猜错会让清单套错维度，比不判更糟。
            const ck = (() => {
              if (!moldDecision || !moldDecision.inject) return '';
              const k = moldDecision.kinds || [];
              if (k.indexOf('web') >= 0) return 'web';
              if (k.indexOf('ppt') >= 0) return 'ppt';
              // 海报/长图在 acceptanceChecklist 里没有专属维度表 ⇒ 诚实走 visual（只查通用项）
              return 'visual';
            })();
            audit = await auditTask({
              baseURL, apiKey, model,
              goal: taskGoal,
              doneLog: taskEntry.doneLog,
              deliverables,
              finalText: contentAcc,
              runtimeSummary: runtimeReview.text,
              diag: auditDiag,
              taskType: ck ? 'creative' : undefined,
              creativeKind: ck || undefined,
            });
          } catch (e) {
            auditDiag.reason = auditDiag.reason || 'threw';
            auditDiag.error = auditDiag.error || String((e && e.message) || e).slice(0, 160);
            console.error('[agentReview] 复检失败（跳过）：', e && e.message);
          }
          if (audit) {
            send({ type: 'selfcheck', phase: 'audit', pass: audit.pass, summary: audit.summary });
            pendingAuditReport = buildAuditReport(audit);
          }
          // ══【第 2 条建议：为关键节点设置明确的成功条件】══════════════════════════════
          // 2026-10-22：修「审查跑完了，但否决没有强制力」。
          // 修之前：`audit.pass === false` 的全部后果 = 一条 SSE + 一段文案，**终态一个字都没改**
          //   （terminalState 在 200 行前就算好了，之后没人再动它）⇒ 两个 AI 都说不合格，
          //   用户看到的仍然是「完成」。自查说没做完且续跑轮数用尽时同理。
          // 判据只有一份（agentReview.reviewVerdict，纯函数，门禁直接喂输入看输出），这里只做接线。
          // ⚠️ 只往**下**压（COMPLETE → PARTIAL），绝不往上抬：审查员没有把任何东西变成"完成"的权力。
          const verdict = reviewVerdict({
            terminalState,
            auditPass: audit ? audit.pass : null,
            auditDefects: audit && audit.defects,
            // ★ 2026-11-03：把「4 号验收 Agent」的四态结论带进判定链。
            //   只传一个字符串，不改 reviewVerdict 的既有语义：不传时逐字回落到 audit-rejected。
            //   为什么要它：降级达标也走 pass=false，若不区分，向用户说的是
            //   「复检没通过」—— 而真相是外部壁垒挡住主目标、降级版本身合格。
            acceptanceVerdict: audit && audit.acceptance ? audit.acceptance.verdict : '',
            selfCheckFinished: selfCheck ? selfCheck.finished : null,
            selfCheckMissing: selfCheck && selfCheck.missing,
            // ★ 2026-10-23：判据从「自查轮次 >= 上限」改成「自查说没做完、且**不允许再补**」。
            //   修前只认轮次用完这一种，于是「因为主循环轮次不够而提前止损」的情形
            //   在 verdict 眼里等于「还能继续」⇒ 不降级 ⇒ COMPLETE 保留下来 ⇒ 又变成一次「没做完却完成」。
            //   两种原因对下游的语义相同（都不再补了），但文案必须能分开，故另传 exhaustedBy。
            reviewRoundsExhausted: selfCheckUnfinished && !canRetryReview,
            exhaustedBy: reviewStopReason,
          });
          if (verdict.downgrade && terminalState === TERMINAL.COMPLETE) {
            terminalState = TERMINAL.PARTIAL;
            reviewDowngrade = verdict.reason;
            // 降级必须**说出来**：默默把状态改成 PARTIAL，用户只会觉得"它又说没做完，但没说为什么"。
            try { await sendTextAsStream(reviewVerdictStatement(verdict)); } catch { /* 文案失败不影响终态 */ }
          } else if (verdict.unverified) {
            // 复检**没跑成**（上游报错 / 回答不是 JSON）⇒ 不降级（审查是增益不是门禁），
            // 但也**不许装作复核过**：这一句就是为了让"复核通过"这四个字不能被白拿。
            // 修前这里什么都不说 ⇒ 用户以为"两个 AI 都看过了"，其实第二个压根没给出结论。
            try { await sendTextAsStream('（说明一下：这一轮的复检没跑成 —— 复检员没有给出可用的结论，所以下面这个结论只来自自查，不算复检通过。）'); } catch { /* 文案失败不影响终态 */ }
          }
          if (process.env.DOUYA_DEBUG_REVIEW === '1') {
            console.log('[agentReview] 审查结论：pass=' + (audit ? audit.pass : 'null')
              + ' selfCheck=' + (selfCheck ? selfCheck.finished : 'null')
              + ' 降级=' + (reviewDowngrade || '无') + ' 终态=' + terminalState);
          }
          // ★ 2026-10-23：把复检这条链**完整**落进 trace（含终态决策）。
          //   判据想回答的就是老板那句：「日志必须保留足够的信息，才能区别
          //   『没执行』『执行失败』和『成功但没有产生预期事件』。」
          //   reason 取值：ok / threw / empty-response / no-json / no-pass-field
          //   再配上 unverified + downgrade + 终态，四件事就能一眼分开。
          try {
            taskTrace.record(taskId, 'audit', {
              ...auditDiag,
              usable: !!audit,
              unverified: !!(verdict && verdict.unverified),
              downgrade: reviewDowngrade || '',
              terminalState,
            });
          } catch { /* 取证旁路 */ }
          if (!audit) {
            // 无条件打一行（不再只在 DEBUG 时打）：这就是"复检没给出结论"的唯一可查线索。
            console.log('[agentReview] 复检无可用结论：reason=' + (auditDiag.reason || 'unknown')
              + ' called=' + auditDiag.called
              + ' input=' + JSON.stringify(auditDiag.input)
              + (auditDiag.error ? ' error=' + auditDiag.error : '')
              + ' ⇒ verdict.unverified=' + !!(verdict && verdict.unverified)
              + ' 终态=' + terminalState);
          }
        }
        // ══【任务类型工作流 · 调用点③：收尾终审】══════════════════════════════════════
        // 老板第六节：「同一标准任务重复运行时，必需阶段和交付标准保持一致」要落在这里 ——
        // 不是"每次都用一段提示词提醒模型"，而是收尾时**用同一套判据对真文件重新算一次**。
        // 只往**下**压（COMPLETE → PARTIAL/BLOCKED），绝不往上抬：工作流没有把任何东西变"完成"的权力。
        // 为什么放在 reviewVerdict 之后：审查看的是"过程与自述是否自洽"，工作流看的是"产物是否达标"，
        // 两道门都过才能是 COMPLETE；任何一道否决都必须能把结论压下来。
        let wfDowngrade = '';
        /**
         * ★ 2026-10-26【第三阶段】通用任务的验收事实 + 裁决，**在这里一次算好**（下面两支共用）。
         *
         * 为什么事实要在这里凑：`runStandaloneAcceptance()` 只做"调用 + 兜异常"，
         * 它需要的七个事实必须由主循环提供 —— 引擎自己既不扫盘也不猜（见 workflowRunner.ctxBase
         * 那段"只把调用方已经核实过的事实原样交出去"）。七个事实全部来自**本任务已有的读数**：
         *   · artifacts / attribution —— `discoverArtifactsForConcludeCore`（与控制器路径同一个判据）；
         *   · claimedArtifacts —— 本次真的入了交付台账的路径（模型自报那一份）；
         *   · declaredFormat —— 注册项声明的能力（`entry.declaredFormat`），backend 不 require 具体工作流；
         *   · responseText —— 本轮最终正文（模型没吐字时用 `finalizeWithText` 补的那段）；
         *   · expectsArtifact —— 用户要不要文件（既有判据 ∪ 明确点了扩展名 ∪ 真动过手写文件）；
         *   · toolFailures —— 未闭环失败账（与收尾门禁 `unresolved` 同源）；
         *   · evidence —— 检查类调用次数 / 其中给出可核读数的次数（与 gradeVerifyEvidence 同源）。
         */
        let genAcceptance = null;
        let genAcceptanceCtx = null;
        if (!wfCtl && wfSel && wfSel.entry) {
          const genEntry = wfSel.entry;
          const genExts = Array.isArray(genEntry.buildExts) ? genEntry.buildExts : [];
          const genDisc = discoverArtifactsForConcludeCore({
            runArtifacts: [],              // 通用任务没有跨请求账本 ⇒ 传空是事实，不是"没查"
            taskId,
            workspace: AGENT_WORKSPACE,
            startedAt: Number(taskEntry.startedAt) || 0,
            extOk: (p) => {
              const ext = workflowRunner.extOf(p);
              return !!ext && genExts.indexOf(ext) >= 0;
            },
            hasExts: genExts.length > 0,
            extLabel: genExts.join('/') || '未声明',
          });
          // 「用户在任务里声明了什么交付格式」是**工作流自己的能力**（见 general-v1 的 declaredFormat 头注）；
          // 没声明这个能力的注册项 ⇒ 空串（不许 backend 自己猜一个）。
          const genDeclaredFmt = (typeof genEntry.declaredFormat === 'function')
            ? String(genEntry.declaredFormat(intentText) || '') : '';
          // 交付台账里同一路径可能被写两次（模型重复写同一文件）⇒ 去重保序，别把重复算成两份产物。
          const genClaimed = [];
          for (const d of deliverables) {
            const p = String((d && d.path) || '');
            if (p && genClaimed.indexOf(p) < 0) genClaimed.push(p);
          }
          const genLastFail = unresolved.length
            ? String((unresolved[unresolved.length - 1] || {}).brief || taskEntry.lastError || '') : '';
          genAcceptanceCtx = {
            artifacts: genDisc.paths,
            claimedArtifacts: genClaimed,
            attribution: genDisc,
            declaredFormat: genDeclaredFmt,
            // ★ 已定的判据（WANTS_FILE_OUTPUT ∧ ¬READ_ONLY_HINTS）在前，另两条是"明确的补充证据"：
            //   用户点名了扩展名 = 明确要一份该格式的文件；模型真动过手写文件 ⇒ 本次本来就有交付物。
            expectsArtifact: userWantsArtifact || genDeclaredFmt !== '' || genClaimed.length > 0,
            responseText: String(contentAcc || finalizeTextOut || ''),
            toolFailures: {
              calls: Number(taskEntry.toolCalls) || 0,
              unresolved: unresolved.length,
              // ★ 2026-11-09：把「未闭环失败」按**归属侧**再切一刀。
              //   工具/环境侧的失败（缺依赖、超时、权限）不是交付物的问题，处置方向是修工具，
              //   不该让 general_no_unresolved_failure 一概判失败（否则工具一坏，任何任务都完不成）。
              //   归属判据只一份：failureSide(kind)（与 trace 的 failureSide 同源）。
              toolSide: unresolved.filter((u) => {
                try { return failureSide(String((u && (u.lastKind || u.kind)) || '')) === 'tool'; }
                catch { return false; }
              }).length,
              lastError: genLastFail,
            },
            evidence: { checks: evCallsTotal, evidence: evReadingsTotal },
            expectsRuntime: runtimeRequired,
            // ★ 2026-11-09：验收需要**需求原文**才能判「点名的技术栈」。
            //   来源用 taskEntry.goal（项目账里钉住的初始目标），不读对话历史——
            //   历史会被压缩，goal 不会（与「执行侧与验收侧读同一份目标」同一纪律）。
            goalText: String((taskEntry && taskEntry.goal) || ''),
            runtime: runtimeEvidence.summary({
              artifacts: genClaimed.concat(genDisc.paths.filter((p) => genClaimed.indexOf(p) < 0)),
              expectsRuntime: runtimeRequired,
            }),
          };
          genAcceptance = runStandaloneAcceptance(genAcceptanceCtx);
          acceptanceForLedger = genAcceptance;
          // 外壳按这个盒子给返回值（见 runAgentLoop 头注：只在这一处写，18 个早退出口不各说一遍）
          if (retBox) retBox.acceptance = genAcceptance;
          const objectiveGaps = (genAcceptance && Array.isArray(genAcceptance.results))
            ? genAcceptance.results.filter((r) => r && r.severity === 'must'
              && (r.outcome === 'fail' || r.outcome === 'unverified'))
              .map((r) => ({ id: r.id, outcome: r.outcome, why: String(r.why || ''), gaps: r.gaps || [] }))
            : [];
          const canRetryObjective = runtimeRequired && genAcceptance && genAcceptance.verdict === 'PARTIAL'
            && objectiveGaps.length > 0
            && (taskEntry.runtimeFeedbackRounds || 0) < 2
            && turn + REVIEW_RESERVE_TURNS < MAX_TURNS
            && !isOverBudget();
          if (canRetryObjective) {
            taskEntry.runtimeFeedbackRounds = (taskEntry.runtimeFeedbackRounds || 0) + 1;
            const detail = objectiveGaps.map((g, i) => (i + 1) + '. [' + g.outcome + '] ' + g.id + '：' + g.why).join('\n');
            conversation.push({
              role: 'user',
              content: '（客观验收回灌，第 ' + taskEntry.runtimeFeedbackRounds + ' / 2 轮。以下不是模型自述，而是本轮真实检查结论：\n'
                + detail + '\n请在同一项目产物上修复这些问题，并重新执行同一项验收。'
                + '网页必须重跑 browser-verify；exe/桌面应用必须重跑原验收脚本并输出 DOUYA_RUNTIME_ACCEPTANCE= 的合法 JSON 行。'
                + '只改文案、只看文件存在/HTTP 200/命令退出成功都不能销掉这些缺口。修复并重跑后再回到收尾。）',
            });
            send({ type: 'selfcheck', phase: 'runtime-continue', round: taskEntry.runtimeFeedbackRounds, missing: objectiveGaps });
            sendPhase('building', '客观验收发现缺口，继续修复并重跑', Math.max(lastProgress, 60));
            try { taskTrace.record(taskId, 'acceptance/feedback', { round: taskEntry.runtimeFeedbackRounds, gaps: objectiveGaps }); } catch { /* 旁路 */ }
            continue;
          }
        }
        if (wfCtl) {
          const wfEv = wfCtl.conclude(deliverables.map((d) => d.path));
          if (wfEv) {
            traceWorkflowEnd(wfEv);
            if (wfEv.verdict !== 'COMPLETE' && terminalState === TERMINAL.COMPLETE) {
              terminalState = wfEv.verdict === 'BLOCKED' ? TERMINAL.BLOCKED : TERMINAL.PARTIAL;
              wfDowngrade = 'workflow-' + wfEv.verdict;
            }
            // 必须说出来：用户看到的结论要和判定同源。修前"验收标准"只活在提示词里，
            // 用户既不知道自己这份东西按哪套标准判的，也不知道哪条没过。
            try {
              await sendTextAsStream('\n\n（按 ' + wfCtl.cfg.workflowId + ' 的验收标准逐项复验：'
                + workflowRunner.summarize(wfEv) + (wfDowngrade ? ' —— 所以我不把这次算完成。' : '') + '）');
            } catch { /* 文案失败不影响终态 */ }
          }
        } else if (genAcceptance) {
          /**
           * ★★★ 2026-10-26【第三阶段】通用任务（`lifecycle:'none'`）：没有控制器，但**有契约**。
           *
           * 修前的真缺口：这一支写成 `if (wfCtl)` 一个分支就完了 —— 通用任务既不建控制器，
           * 就永远走不到任何验收 ⇒ 它**没有 verdict**（不是判错，是没判）。于是老板点名的两条
           * 同时成立且都没被满足：「不能因为没专用工作流就天然无法完成」（它连完成都判不出来）、
           * 「不能因为没专用工作流就自动完成」（连"自动完成"都没发生）。
           *
           * 三条纪律（与本文件其它闸门同源）：
           *   ① 只往**下**压，绝不往上抬 —— 通用契约没有把任何东西变"完成"的权力；
           *   ② 结论必须**三处同向**且同源：返回对象上的 `acceptance` / trace 的 `acceptance/end` /
           *      用户可见报告。三处都读**同一个** `genAcceptance`，不许各自再算一次；
           *   ③ 不落盘：通用任务没有 run 文件，本次结论只服务本轮收尾（`statePersisted:false`）。
           */
          traceAcceptanceEnd(genAcceptance, {
            artifacts: genAcceptanceCtx.artifacts,
            claimedArtifacts: genAcceptanceCtx.claimedArtifacts,
            attribution: genAcceptanceCtx.attribution,
            declaredFormat: genAcceptanceCtx.declaredFormat,
            expectsArtifact: genAcceptanceCtx.expectsArtifact,
            expectsRuntime: genAcceptanceCtx.expectsRuntime,
            runtime: genAcceptanceCtx.runtime,
            toolFailures: genAcceptanceCtx.toolFailures,
            evidence: genAcceptanceCtx.evidence,
          });
          if (genAcceptance.verdict !== 'COMPLETE' && terminalState === TERMINAL.COMPLETE) {
            terminalState = genAcceptance.verdict === 'BLOCKED' ? TERMINAL.BLOCKED : TERMINAL.PARTIAL;
            wfDowngrade = 'acceptance-' + genAcceptance.verdict;
          }
          /**
           * ③ 用户可见报告：**只在非 COMPLETE 时**追加，且必须逐项点名没过的是哪一条。
           *   COMPLETE 时一个字都不加 —— 正常收尾的文案既有门禁逐字守着（unit-delivery-protocol
           *   D8 / unit-user-facing-output U2），也为了一条纪律："通过了不必再念一遍标准"。
           *   ★ 文体**复用上面控制器那一支的同一句**（「按 X 的验收标准逐项复验：… —— 所以我不把
           *   这次算完成。」），不新造报告格式；`summarize()` 本来就会把没过的 check id 逐条点名，
           *   所以这一句同时满足"结构化"和"点出是哪一项"。
           *   ⚠️ 没有改成 deliveryProtocol 的 `【缺口 / 纠正】` 槽位标签，是因为那个标签的 owner
           *   `doneSlotLabel` 没有导出，而 `deliveryProtocol.js` 也是**冻结申报文件** —— 为了一句
           *   标签再去动一个冻结文件、多一轮 regen+apply，风险大于收益。同义、同作者、同位置。
           */
          if (genAcceptance.verdict !== 'COMPLETE') {
            try {
              await sendTextAsStream('\n\n（按 '
                + String((wfSel && wfSel.entry && wfSel.entry.workflowId) || '通用任务')
                + ' 的验收标准逐项复验：' + workflowRunner.summarize(genAcceptance)
                + ' —— 所以我不把这次算完成。）');
            } catch { /* 文案失败不影响终态 */ }
          }
        }
        // 复检报告与成功文案都在客观验收之后；非 COMPLETE 时客观缺口报告取代“放心用”成功版。
        if (pendingAuditReport && terminalState === TERMINAL.COMPLETE) {
          try { await sendTextAsStream(pendingAuditReport); } catch { /* 文案失败不影响终态 */ }
        }
        // 唯一的成功文案出口：所有客观验收、回灌与 AI 审查均已结束，后续不会再有否决。
        if (terminalState === TERMINAL.COMPLETE && deliverables.length) {
          const shown = deliverablesForUser();
          await sendTextAsStream('已经做完了：' + shown.slice(0, 3).map((d) => d.name).join('、') + '。');
        }
        sendPhase('done', terminalLabel(terminalState), 100, { unresolved: unresolved.length });
        // 【执行记录 · 正常收尾的终态】此处的 terminalState 已经过**全部**降级门
        // （unresolved 未闭环失败 / 证伪兜底 / 结论证据门 / 审查否决），所以记的是最终值，不是中间值。
        traceTerminal(terminalState, 'normal-wrapup', {
          unresolved: unresolved.length,
          deliverables: deliverables.length,
          artifactsOk: finalArtifactsOk,
          bailOutHit: !!(curBailOut && curBailOut.hit),
          recoveryUnverified: recoveryUnverifiedNow(),
          reviewDowngrade: reviewDowngrade || null,
          reviewRounds: taskEntry.reviewRounds || 0,
          turns: turn,
          usedTokens: taskEntry.usedTokens || 0,
        });
        // 【统一终态收尾 2026-10-23】正常收尾出口把判定交给统一收尾 —— 这是修前最典型的失血点：
        // terminalState 已算完（含 unresolved / 证伪 / 证据门 / 审查否决四道降级），
        // 但 endStatus 仍是初值 ⇒ tasks.json 写 'done'，与 trace 里的 PARTIAL 直接矛盾。
        terminalStateFinal = terminalState;
        terminalReason = wfDowngrade ? 'workflow-downgrade'
          : (reviewDowngrade ? 'review-downgrade' : 'normal-wrapup');
        break;
      }
      } finally {
        try {
          const _luAcVerdict = (acceptanceForLedger && acceptanceForLedger.verdict)
            ? String(acceptanceForLedger.verdict) : null;
          __luTracker.end('acceptance', __luAc, {
            ok: true, count: 1, verdict: _luAcVerdict, ms: Date.now() - _luAcT0,
            ...(_luAcVerdict ? {} : { reason: 'no-structured-verdict' }),
          });
        } catch (__luE2) { try { process.stderr.write('[loop-unit] end acceptance failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
      }

      // ===== 第四层：整轮门控 —— 只有「全是 web-fetch 且无特殊工具」才走受控并行 =====
      const parallelPlan = planParallel(toolCalls);
      // ── 执行单元 ⑧ plan-parallel（形态 W）────────────────────────────────────
      // 从**判定分支**起算，不含上一行那个纯函数调用：`parallelPlan` 是 const，包进 try
      //   之后块外就看不见它（那是新风险，不赌）；而 planParallel() 是纯函数、零副作用，
      //   计不计入对记账没有信息量。
      // ⚠️ 本窗口在**并行分支上含执行体**，不是纯判定：下面的 try 块里就 await 了
      //   `runParallelTurn`（定义在 :7660，内部并发抓取 + 保序回灌），所以并行轮的 `ms` 含网络时间。
      //   实测两分支：串行 {count:1, ms:4}、并行 {count:2, ms:31}。`count` 两种都是
      //   `toolCalls.length`，读数干净，**不许动**；只有 `ms` 的口径随分支不同，读账时必须分着看。
      //   根因在规格不在实现：§2.3 的 B6 只声明了 `planParallel` 这个纯决策函数（零副作用），
      //   B7 `tool-exec` 是下面那段 `for (const tc of toolCalls)` 串行遍历 —— **并行执行体在规格里
      //   没有归属单元**，于是它落进了本单元 ⑧ 的窗口。记 D7：阶段 2 收尾时报老板定夺
      //   （要么给并行执行体单独立单元，要么把 ⑧ 的窗口缩回纯判定）。本卡不动结构 ——
      //   动 `if (parallelPlan.parallel) { ... continue; }` 里的 try/finally 是已知风险最高的地方。
      const _luPpT0 = Date.now();
      const __luPp = __luTracker.begin('plan-parallel');
      try {
      if (parallelPlan.parallel) {
        // 并行组启动前查一次中断；组内不逐条查；join 后立即再查一次（见 runParallelTurn 之后）
        if (await bailIfAborted(null)) return;
        await runParallelTurn(toolCalls, { finishReason: turnFinishReason, completionTokens: (streamUsage && streamUsage.completion_tokens) || 0 });
        if (await bailIfAborted(null)) return;
        if (toolCalls.length) {
          didToolCall = true;
          // 三态记账（2026-10-21）：executed = 真正跑完的动作数。与 taskEntry.intentBlocks
          // （被拦下的次数）配对，才能在收尾时算出「打算做几次 / 真做了几次」的落差。
          taskEntry.execCount = (taskEntry.execCount || 0) + toolCalls.length;
          taskEntry.prodCount = (taskEntry.prodCount || 0) + countProductive(toolCalls);
          if (process.env.DOUYA_DEBUG_THINK === '1') {
            console.log('[DEBUG think] didToolCall=true (parallel) turn=' + turn + ' lockedThink=' + deepThink);
          }
        }
        continue; // 本轮已处理完（含保序回灌），进入下一轮
      }
      } finally {
        try {
          __luTracker.end('plan-parallel', __luPp, {
            ok: true, count: Array.isArray(toolCalls) ? toolCalls.length : 0, ms: Date.now() - _luPpT0,
          });
        } catch (__luE2) { try { process.stderr.write('[loop-unit] end plan-parallel failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
      }

      // 逐个执行本地技能，把结果喂回模型
      // ── 执行单元 ⑨ tool-exec（形态 W，唯一带 I/O 的读数：artifactHashes）──────────
      // 可包：块内 13 个同级声明（name/params/manifest/result …）块后到 10150 一次都没再引用。
      // ⚠️ 明确不做的一条臂（押后，不是漏了）：**逐工具一条 end** 不做。那会让 unit 对 begin
      //   变成 1:N，与「causationId 一条 end 配一条 begin」的模型直接冲突；留到第三阶段用
      //   更细粒度的事件承载。本单元只报「最后一个工具 + 总条数」。
      let _luTeOk = true;
      let _luTeTool = '';
      let _luTeN = 0;
      const _luTeT0 = Date.now();
      const _luTeFail0 = (turnSnap && turnSnap.fail) || 0;
      const _luTeSeen = new Set();
      for (const _luD of (deliverables || [])) { if (_luD && _luD.path) _luTeSeen.add(String(_luD.path)); }
      const __luTe = __luTracker.begin('tool-exec');
      try {
      for (const tc of toolCalls) {
        // 只记**真正进了执行体**的工具（提前 return 时，最后进过的那条才是事实）。
        _luTeN += 1;
        if (tc && tc.function && tc.function.name) _luTeTool = String(tc.function.name);
        // 每个工具执行前检查中断：命中则立刻停止，不再执行任何技能
        if (await bailIfAborted(tc)) return;
        const fn = tc.function || {};
        const name = fn.name || '';
        // 事件 id：__tool__ 与 __tool_result__ 必须同 id（前端按 id 配对「调用中→结果」）；
        // tc.id 缺失时退回 genId('tool')，两条路都要有。
        const evtId = tc.id || genId('tool');

        // ===== 任务意图闸门（2026-09-23）：执行前的最后一道硬拦截 =====
        // 用户这一轮只是问问题 / 要方案 / 让调查，而模型却准备改动环境 ⇒ 拦下、**不执行**。
        // 位置很关键：必须在**所有执行分支之前**（含下方「需确认的危险操作」——
        // 没获执行授权时，连确认弹窗都不该弹出来打扰用户）。
        // 「信号读到 ≠ 信号进控制逻辑」：这里是真的 continue 掉，不是只打一行日志。
        if (!isSkillAllowed(name, intentMode).allowed) {
          taskEntry.intentBlocks = (taskEntry.intentBlocks || 0) + 1;
          recordSkip('未获执行授权', name, INTENT_MODE_LABEL[intentMode] || intentMode);
          const directive = gateDirective(name, intentMode, taskEntry.intentBlocks - 1);
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: directive });
          markStep(name, false,
            '意图闸门：本轮为「' + (INTENT_MODE_LABEL[intentMode] || intentMode) + '」，未获执行授权，已拦下（未执行）',
            'skipped');
          if (process.env.DOUYA_DEBUG_INTENT === '1') {
            console.log('[intent] 拦下 ' + name + '（第 ' + taskEntry.intentBlocks + ' 次，模式=' + intentMode + '）');
          }
          continue;
        }

        // ===== 工具熔断硬拦截（2026-09-23）：执行前最后一道闸 =====
        // ★ 为什么必须放在这里（而不是只靠 governToolResult 追加提示）：
        //   追加提示是"劝"，而模型在重试循环里会忽略劝告 —— 实测形态就是
        //   「浏览器启动失败 → 收到"换个方式"的提示 → 又启动一次浏览器」。
        //   拦在这里才是"拦"：连执行分支都不进，**这个工具本轮彻底关闭**。
        //   与意图闸门同一位置纪律：都在所有执行分支之前，且都是 `continue` 掉而不是只打日志。
        //   注意：熔断只对"会改动/占用环境的重资产动作"生效的判据是**连续失败次数**，
        //   不是工具白名单 —— 白名单会漏掉将来新增的工具。
        if (!toolBreaker.allows(name)) {
          const openKind = toolBreaker.kindOf(name);
          const tripInfo = { name, kind: openKind, count: toolBreaker.openCount(name), max: toolBreaker.max };
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: breakerDirective(tripInfo) });
          markStep(name, false, '工具熔断：已连续失败 ' + tripInfo.count + ' 次，本轮不再执行（已换降级验证路径）', 'skipped');
          if (wrapUpMode) {
            // 收尾模式下连降级链也不再展开：预算已经不够了，先把话说完
            conversation.push({
              role: 'user',
              content: '（系统提示：已进入收尾模式，且 ' + name + ' 已被熔断。不要再换验证工具了，'
                + '直接把现在已验到的层级和缺口写成结论。）',
            });
          }
          continue;
        }
        // ★ 参数解析走统一协议：**不再用 `catch { params = {} }` 静默清空参数**。
        //   实测真根因：arguments 是流式拼出来的，一旦生成被输出上限截断（finish_reason='length'），
        //   拿到的是半截 JSON；旧代码把参数整个丢掉 ⇒ 技能只能报「请提供目标文件路径」（表象），
        //   而模型坚信自己已经给了参数 ⇒ 原样重试 ⇒ 每轮都在同一处被截断 ⇒ 任务卡死。
        const _na = normalizeToolArgs(fn.arguments, skills.find((s) => s.id === name), { finishReason: turnFinishReason });
        const argsInfo = { problem: _na.problem, canExecute: _na.canExecute, missing: _na.missing, reason: _na.reason, finishReason: turnFinishReason, completionTokens: (streamUsage && streamUsage.completion_tokens) || 0, lengthHit: _na.lengthHit, rawLength: _na.rawLength };
        const params = _na.params;

        // ===== 同策略升级硬拦截（2026-10-05）：执行前最后一道闸 =====
        // 为什么必须在这个位置（而不是只靠 governToolResult 里那句"禁止再重复它"）：
        //   那句话是**劝**；实测形态是「模型读到"换个方式"，然后又把同一个策略发了一次」。
        //   与意图闸门 / 工具熔断器**同一位置纪律**：都在所有执行分支之前，且都是 `continue` 掉。
        // ★ 拦的是**重复**不是**失败**：第一次失败不拦（改对参数就能成）；只有同一策略
        //   （同一工具 + 同一组参数键 + 同一执行模式）失败到上限才拦，并按失败类型给出**换哪条路**。
        const recPlan = planRecoveryGate(name, params);
        if (recPlan.blocked) {
          recoveryLog.push(recoveryExecutor.record({
            action: recPlan.action, result: 'dispatched', evidence: recPlan.evidence,
          }));
          reverifyPending = true;      // 契约②：这条恢复动作必须拿到复验读数才算"好了"
          recoveryVerified = false;
          recordSkip('同策略升级', name, recPlan.evidence.reason);
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: recPlan.directive });
          markStep(name, false,
            '同策略升级：同一策略已失败 ' + recPlan.evidence.strategyCount + ' 次（上限 '
            + recPlan.evidence.maxSameMethod + '），本次不再执行，已给出替代路径',
            'skipped');
          if (process.env.DOUYA_DEBUG_RECOVERY === '1') {
            console.log('[recovery] 拦下 ' + name + ' action=' + recPlan.action
              + ' strategyCount=' + recPlan.evidence.strategyCount);
          }
          continue;
        }

        // ===== ★★ 新建交付物授权门（2026-11-11）=====
        // 为什么放在这一层、这个位置：与 planRecoveryGate / planReuseGate **同一位置纪律** ——
        // 都在"即将真正执行"之前、且都在本文件唯一的两条执行路径（serial / parallel）上各一处。
        // 为什么不能用既有闸门代替：那两道判的是"该不该重做/复用**已有**产物"，
        // 而本道判的是"**该不该凭空造一个新产物**"，前提完全不同（新文件没有前序产物可比）。
        // ★ 2026-11-11 夜：`target` / `pathExists` 改由 `producerTarget` 统一解析 ——
        //   原来这里写的是 `(params && params.path) || ''`，对 docx-generate 等 14 个技能**恒为空串**，
        //   于是 `pathExists` 恒 false ⇒ 覆盖已有文件也被当成"新建"。改成按技能形态解析。
        const _authTgt = producerTarget(name, params);
        const authPlan = planAuthGate({
          skillName: name,
          params,
          pathExists: _authTgt.exists,
          userText: lastUserText,
          alreadyBlocked: authGateFiredFor.has(name),
          alreadyGranted: deliveryAuthGranted,
          target: _authTgt.target,
          targetKnown: _authTgt.known,
        });
        if (authPlan.blocked) {
          authGateFiredFor.add(name);
          recordSkip('新建交付物授权', name, authPlan.target);
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: authPlan.directive });
          markStep(name, false,
            '授权门：本轮用户只是在补信息/回答提问，未获交付授权，本次不创建文件（' + authPlan.reason + '）',
            'skipped');
          try {
            taskTrace.record(taskId, 'auth-gate', { ...authPlan.event, path: 'serial' });
          } catch { /* 旁路：记录失败绝不影响任务 */ }
          continue;
        }

        // ===== ★★ 产物正文「断言必须有来源」门（2026-11-11，P0 事实门）=====
        // 判的是**写出去的文件里说了什么**，不是聊天回复说了什么 —— 这是 0.21.31 事故的第二个漏洞：
        // 文件里写「11 条暗号已全部核对归属」，而实际只有 2 条经用户确认。
        // 人设 §八 那条纪律只管回复、管不到产物正文，所以必须在写入前有一道机械判据。
        // 位置在授权门**之后**：先判"该不该做"，再判"做出来的东西对不对"。
        const claimPlan = planContentClaimGate({
          skillName: name,
          // ★ 2026-11-11 夜：必须把 `params` 交进去 —— 产出类技能的正文不在 `content` 里
          //   （docx/pdf 在 `sections`、ppt/slides 在 `slides`、excel 在 `headers`+`rows`、
          //   project-scaffold 在 `files[].content`）。只传 `content` 的话，
          //   除 file-write 外全是空串 ⇒ 事实门**静默失效**（total=0 就放行，不报错）。
          params,
          path: _authTgt.target || (params && params.path) || '',
          content: (params && params.content) || '',
          alreadyBlocked: claimGateFiredFor.has(name),
        });
        if (claimPlan.blocked) {
          claimGateFiredFor.add(name);
          recordSkip('产物断言无来源', name, String((params && params.path) || ''));
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: claimPlan.directive });
          markStep(name, false,
            '事实门：正文有 ' + claimPlan.total + ' 处"已核对/已确认"类断言找不到来源，已拦下要求改写（未写入）',
            'skipped');
          try {
            taskTrace.record(taskId, 'content-claim-gate', { ...claimPlan.event, path: 'serial' });
          } catch { /* 旁路：记录失败绝不影响任务 */ }
          continue;
        }

        // ===== 跨请求产物复用硬闸门：先告知再放行，不静默、不记账为失败 =====
        const reusePlan = planReuseGate(name, params);
        if (reusePlan.blocked) {
          recordSkip('产物复用', name, reusePlan.target);
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: reusePlan.directive });
          markStep(name, false,
            '跨请求恢复：该任务的 pptx 上次已产出（' + reusePlan.target + '），本次不再重新生成，已要求复用',
            'skipped');
          // ★ 2026-10-24（第五轮）：字段由 planReuseGate 一处拼好，这里只补 `path`。
          try {
            taskTrace.record(taskId, 'reuse-gate', { ...reusePlan.event, path: 'serial' });
          } catch { /* 旁路 */ }
          continue;
        }
        // ★ 2026-10-24（第五轮）：**放行**也要留痕（改前这里什么都没有）。
        //   改前第 2 次命中重做判据时静默放行 ⇒ 事后只能靠模型自己说的那句
        //   「已改成正好 3 页，文件已重新生成并覆盖原文件」反推"这次是合法修正"。
        //   现在放行这件事本身（谁、命中哪条判据、原文是什么、模型上一次说了什么）
        //   全部落进 trace，且与拦截事件字段同源，两条可以直接对齐比较。
        if (reusePlan.released) {
          try { taskTrace.record(taskId, 'reuse-gate-release', { ...reusePlan.event, path: 'serial' }); } catch { /* 旁路 */ }
        }

        // 阶段事件（仍驱动温度状态机与后端内部状态，前端不再渲染进度条）
        const ph = phaseOfTool(name);
        const actionLabel = skillAction(name) || ph.label;
        sendPhase(ph.phase, actionLabel, ph.progress);
        stepSeq++;

        // （已移除强制澄清门与计划确认门：需求明确直接做，拿不准由模型自行调用 clarify_requirements 问一次，
        //   后端对 clarify_requirements 做硬上限 1 次，杜绝连环确认。）

        // 1) workflow_plan：结构化计划，不真正执行，仅展示
        if (name === 'workflow_plan') {
          const steps = Array.isArray(params.steps) ? params.steps : [];
          send({ type: 'plan', steps });
          taskEntry.plan = steps.map((s) => String(s)).slice(0, TASK_PLAN_MAX);
          persistTask('running');
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: '计划已展示给用户（共 ' + steps.length + ' 步）' });
          continue;
        }

        // 2) request_material：向用户索要素材，挂起等待提交
        if (name === 'request_material') {
          materialCalls++;
          // ★ 2026-10-16 修「无限索要素材」：这条分支原先**一道闸都没有**，
          //   模型只要反复调它就能反复阻塞等 5 分钟 —— 用户不提交就永远不干活。
          //   两道判据都是精确条件，不做任何"看起来差不多就放行"的放宽：
          //     ① 单轮硬上限：materialCalls > 1 即本轮第 2 次及以后（跨轮会归零，单靠它不够）；
          //     ② 跨轮持久：会话历史里已经留下「素材已给」或「用户跳过」的痕迹（见 conversationHasToolPrefix）。
          //   注意「用户跳过」也要算"问过了" —— 用户明确不想给素材，再问一遍只会更烦人。
          if (materialCalls > 1
            || conversationHasToolPrefix(conversation, MATERIAL_GIVEN_PREFIX)
            || conversationHasToolPrefix(conversation, MATERIAL_SKIPPED_PREFIX)) {
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content:
                '【系统】本轮已经索要过一次素材了，不再重复索要（这次没有向用户弹出索要框）。'
                + '请立刻用现有信息动手，缺的部分用最合理的默认值补上，做完在交付说明里标注你做了哪些假设。',
            });
            markStep(name, false, '素材索要已用掉：不再重复索要，改为用现有信息继续', 'skipped');
            if (process.env.DOUYA_DEBUG_INTENT === '1') {
              console.log('[intent] 拦下重复的 request_material（本轮第 ' + materialCalls + ' 次）');
            }
            continue;
          }
          if (unattended) {
            // 无人值守：不挂起（不白等 300s），直接回灌自愈文案继续。
            // 诚实红线：必须显式写明「因无人值守被跳过」，绝不许静默当作「用户已提供」。
            //
            // ★ 2026-11-09 三档接线：同 clarify —— 这里判的是"人在不在"，不是"该不该问"。
            //   但 CONFIRM 档（多步/不可逆/有歧义）下缺素材不能"用最合理的默认值补上"就算完：
            //   缺的若是品牌图/真实数据，编出来的东西会一路做到交付里。⇒ 登记待批，只做能确定的。
            // ★ 同 clarify：必须同时看 ambiguous 这个客观事实，不能只用 tier 代理
            //   （tier 是策略，会被 explicitNoAsk 之类的优先级影响）。
            const materialMatters = gateTier.ambiguous === true || gateTier.tier === TIER.CONFIRM;
            recordSkip('material', name, '');
            if (materialMatters) {
              pendingQueue.add({
                tool: 'material',
                summary: '等你提供素材：' + String(params.prompt || '（模型索要的素材）').slice(0, 80),
                reversible: false,
                done: false,
              });
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '【无人值守 · 缺素材】本步骤需要向你索要素材，但当前为无人值守模式，已跳过。'
                  + '本轮判定为 CONFIRM 档（' + ((gateTier.reasons || []).join('；') || '步骤多/不可逆') + '），'
                  + '缺的素材已登记为待你提供。\n'
                  + '请只做**不依赖该素材**的部分，并用占位或明确标注"此处待素材"的方式留空；'
                  + '**不要编造品牌图、真实数据、客户信息这类会被当成事实的东西**。\n'
                  + '做完在交付说明里写清：哪些地方因为缺素材留了空、需要你补什么。',
              });
              markStep(name, true, '无人值守·缺素材：跳过索要并登记待批', 'skipped');
              continue;
            }
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '【无人值守】本步骤需要向你索要素材，但当前为无人值守模式，已自动跳过（未获取到素材）。请按你的最佳判断继续。',
            });
            markStep(name, true, '无人值守：跳过索要素材（未获取素材）', 'skipped');
            continue;
          }
          const mid = genId('mat');
          send({ type: 'material', id: mid, prompt: String(params.prompt || '需要你提供素材') });
          const content = await waitMaterial(mid, 300000, taskId);
          if (await bailIfAborted(tc)) return;
          if (content == null) {
            send({ type: 'material_result', id: mid, cancelled: true });
            conversation.push({ role: 'tool', tool_call_id: tc.id, content: '用户未提供素材（超时/取消）' });
            markStep(name, true, '用户未提供素材', 'skipped');
          } else if (String(content).trim() === '') {
            // ★ 2026-10-16 修「谎话 + 假素材」：用户点「跳过」时前端提交的是**空字符串**
            //   （不是 null —— 见渲染层 material_result 的提交分支），旧代码落进 else 里，
            //   把空串拼成「用户提供的素材：\n」回灌给模型 ⇒ 模型以为拿到了素材，其实什么都没有；
            //   同时这行假话还会让**跨轮去重判据**误判成"已经给过素材"，把后续合法的索要也挡掉。
            //   所以单列一支：诚实写明"用户跳过了"，并且**不**把它记成 MATERIAL_GIVEN_PREFIX。
            //   也不升级执行授权 —— 用户跳过不等于"授权你随便编"。
            send({ type: 'material_result', id: mid, content: '' });
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: MATERIAL_SKIPPED_PREFIX + '（用户点了跳过，没有提供任何素材）。'
                + '请按你的最佳判断继续，缺的信息用最合理的默认值补上，'
                + '并在交付说明里明确标注哪些内容是假设、哪些需要他补。',
            });
            markStep(name, true, '用户跳过了素材提供', 'skipped');
          } else {
            // ★ 2026-10-16 治本之一：用户**真的给了素材** ⇒ 这是"照这个动手"的明确信号，
            //   等价于执行授权。不升级的话会形成死循环：
            //   用户给素材 → 模型想动手 → 闸门按本轮 QUESTION 拦下 → 模型只能再要素材 → 用户再给一遍。
            //   ⚠️ 这一行同样是**本轮全线放行、不可回退**（不只是放行"用这份素材做的那件事"）。
            //   权限面代价、真实越界场景、以及将来该怎么收紧，见 clarify_requirements 分支里
            //   「⚠️ 权限面警告」那段长注释 —— 改这里之前先读那段。
            intentMode = INTENT_MODE.EXECUTE;
            deliveryAuthGranted = true;   // 交付授权：用户真的给了素材 ⇒ 这是"照这个动手"的明确信号
            lastExecGrantedAt.set(ownerKeyOf(payload), Date.now());
            console.log('[intent] 用户已提供素材 ⇒ 本轮升级为「实际执行」，会改动环境的技能改由放行');
            send({ type: 'material_result', id: mid, content });
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: MATERIAL_GIVEN_PREFIX + '\n' + content
                + '\n你**已经获得执行授权**（用户已提交素材）：立刻动手，不要再来回确认。',
            });
            markStep(name, true, '用户已提供素材', 'skipped');
          }
          continue;
        }

        // 2.5) clarify_requirements：向用户澄清需求，挂起等待回答后继续（硬上限 1 次，杜绝连环确认）
        if (name === 'clarify_requirements') {
          clarifyCalls++;
          // ★ 2026-10-16 跨轮去重（治「每轮归零后重新问一遍」）：
          //   clarifyCalls 是**单轮局部量**，用户每答一句就开新一轮 runAgentLoop，它归零 ⇒
          //   实测形态 = 用户答了 → 模型还想动手 → 本轮仍是问答模式被拦 → 只能再问 → 用户再答 → 无限循环。
          //   判据改用 conversation（跨轮持久，来自 payload.messages）里的历史痕迹：
          //   只要会话中已经出现「用户回答需求澄清」或「用户未回答需求澄清」的 tool 消息，就不再挂起等第二次。
          //   超时（CLARIFY_TIMEOUT_PREFIX）也算"问过了" —— 用户当时没答，再挂 5 分钟只会继续空转。
          const clarifiedBefore =
            conversationHasToolPrefix(conversation, CLARIFY_ANSWERED_PREFIX)
            || conversationHasToolPrefix(conversation, CLARIFY_TIMEOUT_PREFIX);
          if (clarifyCalls > 1 || clarifiedBefore) {
            // 已经确认过一次，直接放行，逼模型开工，不再阻塞等用户
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content:
                '【系统】这个会话里你已经问过需求并拿到答复了，不再重复确认（这次没有向用户弹出确认框）。'
                + '请立刻动手执行，用最合理的默认值补全剩余细节，做完在交付说明里标注你做了哪些假设；用户不满意会告诉你改。',
            });
            // ★ 关键：只是"不问了"还不够 —— 本轮 intentMode 如果仍是 QUESTION/PLAN，
            //   模型接着想动手还是会被闸门拦下，于是又回到"想动手→被拦→只能再问"的闭环。
            //   历史上已经拿到过用户答复 ⇒ 用户的答复就是执行授权，这里直接把本轮升级成 EXECUTE。
            //   仅在 clarifiedBefore 为真（历史里确有其事）时升级；纯粹 clarifyCalls > 1 不升级，
            //   因为那可能只是同一轮内连问两次、一次都没拿到答复。
            if (clarifiedBefore) {
              // ⚠️ 同前：本轮全线放行、不可回退。权限面代价与收紧方向见 clarify 答复分支里的
              //   「⚠️ 权限面警告」长注释。
              intentMode = INTENT_MODE.EXECUTE;
              deliveryAuthGranted = true;   // 交付授权：历史轮已拿到澄清答复 ⇒ 用户的答复就是授权
              lastExecGrantedAt.set(ownerKeyOf(payload), Date.now());
              console.log('[intent] 历史轮已拿到需求澄清答复 ⇒ 本轮升级为「实际执行」，会改动环境的技能改由放行');
            }
            markStep(name, false, '需求澄清已用掉：不再重复追问，改为直接动手', 'skipped');
            continue;
          }
          if (unattended) {
            // 无人值守：不挂起（不白等 300s）。
            //
            // ★ 2026-11-09 三档接线 —— 这里判的**不是"该不该打扰"，是"人在不在"**。
            //   `tier` 回答"这个任务要不要问"，`unattended` 回答"现在能不能等人"。两者正交：
            //   同一档（比如 QUEUE）在"人在"和"人走开"下行为必须不同，所以**不能**把这里
            //   换成 `tier === 'silent'` —— 那会让"人走开 + 该等"的情况去白等 300 秒。
            //
            //   但跳过之后**怎么继续**，必须看档位：
            //     修前一律回灌「请按你的最佳判断继续」。在 tier=CONFIRM（需求本身有歧义）时，
            //     这句话等于让模型把歧义猜成结论直接开做 —— 正是本轮要治的形状。
            //     反例来自本仓自己的门禁：goalText「用godot做一个愤怒的小鸟的游戏」被判 toolNoForm，
            //     人走开时若照旧"按最佳判断继续"，就会交一个网页顶替 Godot 工程。
            //   ⇒ CONFIRM 档：不改用"猜"，而是登记待批 + 逼模型停在"不需要猜"的部分。
            //
            // ⚠️ 判据必须同时看 `ambiguous` 这个**客观信号本身**，不能只用 tier 代理：
            //   tier 是一个"结论"，而结论会受优先级影响。本轮就出现过这种翻车：
            //   「用godot做一个愤怒小鸟的游戏」判出 ambiguous=true，但因为 explicitNoAsk
            //   排在歧义之前，tier 落成了 QUEUE —— 只看 tier 的话这里就会走"按最佳判断继续"，
            //   原样重演事故。歧义是**事实**，档位是**策略**，事实不该被策略抹掉。
            const clarifyAmbiguous = gateTier.ambiguous === true || gateTier.tier === TIER.CONFIRM;
            clarifyDone = true;
            recordSkip('clarify', name, '');
            if (clarifyAmbiguous) {
              pendingQueue.add({
                tool: 'clarify',
                summary: '等你回答需求确认：'
                  + (String(params.context || '').slice(0, 80) || '（本轮判定需求有歧义）'),
                reversible: false,
                done: false,
              });
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '【无人值守 · 需求有歧义】本步骤需要向你澄清需求，但当前为无人值守模式。'
                  + '本轮判定为 CONFIRM 档（' + ((gateTier.reasons || []).join('；') || '需求有歧义') + '），'
                  + '**歧义没消除就动手等于赌方向，所以不走"按最佳判断继续"这条路**。\n'
                  + '请只做**不需要猜**的部分（读现状、分析、列出可选方案），'
                  + '并把"需要你点头才能定的选择"逐条写进交付说明；不可逆动作一律不要做。\n'
                  + '绝不许把任何一个假设当成已经确认。',
              });
              markStep(name, true, '无人值守·有歧义：跳过澄清，停在可选方案阶段', 'skipped');
              continue;
            }
            // tier=QUEUE / SILENT：本来就不是"方向不明"，只是缺细节 ⇒ 按最佳判断继续是对的。
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '【无人值守】本步骤需要向你澄清需求，但当前为无人值守模式，已自动跳过（未获得你的答复）。请按你的最佳判断继续。',
            });
            markStep(name, true, '无人值守：跳过澄清（未获用户答复）', 'skipped');
            continue;
          }
          const cid = genId('clarify');
          const questions = Array.isArray(params.questions) ? params.questions : [];
          send({ type: 'clarify', id: cid, questions, context: String(params.context || '') });
          const answer = await waitClarify(cid, 300000, taskId);
          if (await bailIfAborted(tc)) return;
          clarifyDone = true; // 已经跟用户对齐过（含超时按最佳判断继续的情形）
          if (answer == null) {
            // ⚠️ 用户**没回应**（超时/取消）⇒ 这不是授权，绝不升级 intentMode。
            //    没答复时升级等于"用户什么都没说就被放开执行"，那是拿安全换流畅，不能做。
            send({ type: 'clarify_result', id: cid, cancelled: true });
            conversation.push({ role: 'tool', tool_call_id: tc.id, content: '用户未回答需求澄清（超时），请按你的最佳判断继续。' });
          } else {
            const answerText = typeof answer === 'string' ? answer : String(answer);
            // ⚠️ 「答了」不等于「同意动手」—— 用户完全可能在澄清框里回一句「先别动手，我只是问问」。
            //    intentGate 的判定优先级里「否定执行」是最强信号（NO_EXEC_PATTERNS），
            //    所以这里**复用 classifyIntent** 再判一次答复本身，不另造一套判据
            //    （同一语义养两套实现是这个仓库反复踩过的坑）。
            //    只有答复**不是**「明确不要动手」时才升级；否则保持原有拦截，模型只能把话讲清楚。
            const answerNoExec = classifyIntent(answerText).reason === 'explicit-no-execute';
            if (!answerNoExec) {
              // ★ 2026-10-16 治本（本次核心）：用户**真的回答了**澄清问题 ⇒ 这就是执行授权。
              //   原代码只把答案回灌给模型，却没动 intentMode，于是：
              //     intentMode 仍是 QUESTION ⇒ 模型想动手 ⇒ 被闸门拦 ⇒ 只能再 clarify_requirements
              //     ⇒ 用户再答 ⇒ 下一轮 clarifyCalls 归零 ⇒ 无限循环（老板原话「反复追问、不答就不干活」）。
              //   「用户答了」和「用户没答」是两件完全不同的事，必须分开处理：
              //     answer != null 且答复不是"别动" ⇒ 升级为 EXECUTE 并刷新授权时间戳（照短追问那段的写法，键是 username）；
              //     answer == null（超时）⇒ 见上面分支，绝不升级。
              //
              // ┌─────────────────────────────────────────────────────────────────────┐
              // │ ⚠️ 权限面警告 —— 给半年后想收紧这里的人（不要以为这是一次"局部放行"）│
              // └─────────────────────────────────────────────────────────────────────┘
              // 下面这一行改的是**整个本轮**的执行授权，不是"只放行用户答复所指的那一件事"：
              //   · 它是**本轮内单向、不可回退**的 —— 一旦置为 EXECUTE，本轮剩余所有轮次里
              //     `isSkillAllowed(name, intentMode)` 都会返回 allowed（intentGate.js）；
              //   · 于是**任何**会改动环境的技能都会放行：shell-exec、ssh-exec、deploy-static、
              //     deploy-node、file-write、shop-order…… 不只是用户答复里提到的那件事；
              //   · 也不区分"是不是同一个话题"。用户在澄清框里换了个话题答复，照样全线放行。
              //
              // 具体越界构造场景（真实可复现，别当理论问题）：
              //   用户问「这报告为什么写不出来？」（判 QUESTION，闸门拦住一切动手）
              //   → 模型调 request_material 要"门店名单"
              //   → 用户随手粘一段素材（**与"要不要动服务器"毫无关系**）
              //   → 本行升级为 EXECUTE
              //   → 模型下一轮顺手调 shell-exec 去删临时目录 / ssh-exec 去改服务器
              //   → **闸门不再拦**（改之前是拦的）。
              //   同样成立：用户在澄清框里答「行吧你看着办」，模型随即 deploy 上线。
              //
              // 为什么仍然接受这个代价（这是权衡，不是疏忽）：
              //   1) 用户**主动提交素材 / 主动回答澄清**，是对话里最强的"照这个动手"信号；
              //      把它读成"仅授权我继续问"，就是老板点名的那条死循环 —— 病比这个漏洞更常见更伤。
              //   2) 判错的**代价不对称**且可挽回：越界动作里最重的那些（deploy / ssh-exec / 下单）
              //      仍分别受 confirm 门、工具熔断、同策略升级、交付自检四道闸约束，不是裸奔；
              //      而"答了却还是不动手"是用户直接感知到的失败，无法挽回信任。
              //   3) 收紧的正确方向**不是在这行加 if**（那样会退回到"按措辞猜意图"，越加越脆），
              //      而是给技能加**动作族分级**：在 intentGate 里把技能分成
              //      「只读 / 产出类（写本地文件）/ 外发类（部署、上传、发消息）/ 破坏类（删、ssh、下单）」，
              //      让"升级"只放开产出类，外发类与破坏类仍需**本轮显式**授权。
              //      这是一次结构性改动，本轮评估后**未做**（会把风险面铺得更大），已记录为待办。
              intentMode = INTENT_MODE.EXECUTE;
              deliveryAuthGranted = true;   // 交付授权：用户答完了澄清 ⇒ 这就是授权（授权门必须认这条，否则"答了也不干活"）
              lastExecGrantedAt.set(ownerKeyOf(payload), Date.now());
              console.log('[intent] 用户已回答需求澄清「' + answerText.slice(0, 40)
                + '」⇒ 本轮升级为「实际执行」，会改动环境的技能改由放行');
            } else {
              console.log('[intent] 用户答复里明确说不要动手「' + answerText.slice(0, 40)
                + '」⇒ 本轮**不**升级执行授权，继续按「' + (INTENT_MODE_LABEL[intentMode] || intentMode) + '」拦执行');
            }
            send({ type: 'clarify_result', id: cid, content: answerText });
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content:
                CLARIFY_ANSWERED_PREFIX + ' ' + answerText + '\n' +
                (answerNoExec
                  ? '用户这句的意思是**先别动手**：不要改动任何东西，只把答案/说明讲清楚。'
                  : '你**已经获得执行授权**：立刻动手，不要再问第二遍，也不要用「你确认吗」这类反问。\n'
                    + '用自然语言说明你在做什么；做完对照需求自检并交付完整路径。'
                    + '需求里没写到的细节用最合理的默认值补上，并在交付说明里标注这些假设。'),
            });
          }
          continue;
        }

        // 2.6) request_plan_ack：【三档接线后的 plan_gate】
        //   · CONFIRM 档（不可逆 / 多步 / 有歧义）且**用户在场** ⇒ 真挂起等点头（这就是"复杂任务先出计划"）
        //   · CONFIRM 档但**无人值守** ⇒ 不挂起、也不擅自做不可逆部分：计划排进待批队列，收尾列出
        //   · QUEUE / SILENT 档 ⇒ 收到即放行（保持用户明确要求过的"去掉确认弹窗"）
        // 为什么不能无条件挂起：上一版就是无条件弹，用户嫌烦要求去掉；现在只在**该问的时候**问。
        if (name === 'request_plan_ack') {
          const steps = Array.isArray(params.steps) ? params.steps : [];
          lastPlanSteps = steps.length;
          // 拿到**真实计划长度** ⇒ 重判一次（signals 优先用计划长度，比按分句估的下界准）
          const g = refreshGateTier(steps);
          const stepsText = steps.map((s) => {
            if (typeof s === 'string') return s.trim();
            if (s && typeof s === 'object') {
              return String(s.title || s.step || s.label || s.text || s.desc || '').trim();
            }
            return '';
          }).filter(Boolean);
          const planSummary = stepsText.length
            ? stepsText.slice(0, 3).join('；') + (stepsText.length > 3 ? ' 等 ' + stepsText.length + ' 步' : '')
            : (steps.length ? '共 ' + steps.length + ' 步' : '未给出步骤');

          if (g.tier === TIER.CONFIRM && g.needsPlan && unattended) {
            // 人走开 + 复杂/不可逆：既不白等 180 秒，也不擅自开做不可逆的部分。
            // 诚实红线：显式记账（闸门清单 + 待批队列两处都要有），绝不许静默当作"用户已同意"。
            recordSkip('plan', name, '');
            pendingQueue.add({
              tool: 'plan',
              summary: '确认计划后再执行：' + planSummary,
              reversible: false,
              done: false,   // 没做 —— 分组标题已经写了「还没做、等你点头」，这里不再重复那半句
            });
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '【无人值守】这是需要你先确认计划的复杂/不可逆任务（' + g.reasons.join('；') + '）。'
                + '计划已登记为「待你确认后才能执行」，不会自动开做。\n'
                + '你可以：① 只做**可回滚**的部分（例如读文件、分析、生成草案到工作区），'
                + '并在交付说明里写明哪些改动还没落盘；② 明确列出"需要你点头才能做"的清单。\n'
                + '绝不允许把不可逆动作（部署/删除/付款/发布/改库）当成已经得到授权。',
            });
            markStep(name, true, '无人值守：计划已登记待批（未擅自执行）', 'skipped');
            continue;
          }

          if (g.tier === TIER.CONFIRM && g.needsPlan && !planAcked && !planAckGateUsed) {
            planAckGateUsed = true;   // 只拦一次，避免死循环
            const plid = genId('plan');
            send({
              type: 'plan_ack', id: plid,
              steps: stepsText.length ? stepsText : steps.map((s, i) => '第 ' + (i + 1) + ' 步'),
              tier: g.tier, reasons: g.reasons,
            });
            sendPhase('planning', '等你确认计划', 12);
            const ack = await waitPlanAck(plid, 180000);
            if (await bailIfAborted(tc)) return;
            if (ack == null) {
              // 超时/取消：不卡死（这是"人可能不在"的常态），但必须如实记账，绝不当作已确认。
              recordSkip('plan', name, '');
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '用户没有回应计划确认（超时/取消），**未获授权**。'
                  + '请只做可回滚的部分（读、分析、生成草案），不可逆动作一律不要执行，'
                  + '并在交付说明里列出"等你点头才能做"的清单。',
              });
            } else if (String(ack).trim().toLowerCase() === 'no') {
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '用户**不同意**这个计划。先别动手 —— 用自然语言问清楚他想怎么改，等他明确后再继续。',
              });
            } else {
              planAcked = true;
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '用户已确认计划，开始执行。每步用自然语言说明在做什么；全部完成后对照需求自检再交付。',
              });
            }
            continue;
          }

          conversation.push({ role: 'tool', tool_call_id: tc.id, content: '计划已记录，直接开始执行，每步用自然语言说明在做什么；全部完成后对照需求自检再交付。' });
          continue;
        }

        // 2.7) pick_local_files：AI 主动向用户索要本地文件，弹文件选择框，选完自动读内容继续
        if (name === 'pick_local_files') {
          if (unattended) {
            // 无人值守：不挂起（不白等 300s），直接回灌自愈文案继续。
            // 诚实红线：显式写明「因无人值守被跳过」，不许静默当作「用户未选/已选」。
            //
            // ★ 2026-11-09 三档接线：判的是"人在不在"。CONFIRM 档下"没选到文件"往往意味着
            //   任务的关键输入缺失（用户说"改刚才那个文件"），这时让模型随便找个文件继续比停下更糟。
            // ★ 同 clarify：同时看 ambiguous 事实，不只信 tier 策略。
            const pickMatters = gateTier.ambiguous === true || gateTier.tier === TIER.CONFIRM;
            recordSkip('pick', name, '');
            if (pickMatters) {
              pendingQueue.add({
                tool: 'pick_local_files',
                summary: '等你选文件：' + String(params.hint || '（模型要你指定一个本地文件）').slice(0, 80),
                reversible: false,
                done: false,
              });
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '【无人值守 · 缺输入文件】本步骤需要你指定本地文件，但当前为无人值守模式，已跳过。'
                  + '本轮判定为 CONFIRM 档（' + ((gateTier.reasons || []).join('；') || '步骤多/不可逆') + '）。\n'
                  + '**不要自己挑一个"看起来像"的文件顶替** —— 改错文件比不改更糟。\n'
                  + '请把需要哪个文件、用来做什么写清楚，其余不需要该文件的部分照常做完。',
              });
              markStep(name, true, '无人值守·缺文件：跳过选择并登记待批', 'skipped');
              continue;
            }
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '【无人值守】本步骤需要你选择本地文件，但当前为无人值守模式，已自动跳过（未选择文件）。请按此情况继续或用自然语言向用户说明。',
            });
            markStep(name, true, '无人值守：跳过选择文件（未选择）', 'skipped');
            continue;
          }
          const pid = genId('pick');
          const hint = String(params.hint || '请选择需要处理的本地文件（可多选）');
          send({ type: 'pick_files', id: pid, hint });
          sendPhase('gathering', '等待选择文件', 45);
          const chosen = await waitPickFiles(pid, 300000, taskId);
          if (await bailIfAborted(tc)) return;
          if (!chosen || !Array.isArray(chosen.paths) || chosen.paths.length === 0) {
            send({ type: 'pick_files_result', id: pid, cancelled: true });
            conversation.push({ role: 'tool', tool_call_id: tc.id, content: '用户未选择文件（超时/取消），请按此情况继续或用自然语言向用户说明。' });
          } else {
            const files = chosen.paths.map((p) => ({ path: p, name: path.basename(p) }));
            const txt = await resolveAttachments(files, skills, cfg);
            send({ type: 'pick_files_result', id: pid, files });
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: txt
                ? '[用户选择的本地文件内容] \n' + txt + '\n请基于这些文件内容继续。\n若上面没有提到某张图片的画面内容，说明那张图没有被读到——不要编造画面内容，如实说明没读到。'
                : '用户已选择文件，但内容未能解析，请用自然语言询问用户或让其重新上传。',
            });
          }
          continue;
        }

        // ===== 2.8) find_skills：技能渐进披露的**唯一入口**（2026-02-16）=====
        // 它是个**零副作用**的元工具：不写盘、不起进程、不碰远端 —— 只改内存里的 `disclosedSkillIds`。
        // 那种"改"要到**下一轮**才生效（`turnTools` 在 turn 循环开头按它算），这也是它被
        // `planParallel` 判成 meta-tool 禁止并行的原因：同一轮里并行披露，下一轮的表就说不清是谁拉的。
        //
        // 全部判定在 `lazyTools.planFindSkills` 里（纯函数，门禁真跑 L7/L8）。这里只做三件事：
        //   调它 → 把 `enabled` 记进 `disclosedSkillIds` → 把 `text` 原样回灌给模型。
        // ⚠️ 不许在这里再写一遍"哪些算匹配""要不要自动披露 top3"——那就是第二套判据。
        if (name === 'find_skills') {
          const fq = String(params.query || '');
          const fenable = params.enable;
          /**
           * 开关关闭时的诚实回复。**不许**静默返回一段"清单"：
           * 关闭时模型本来就看得见全部技能，给它一份清单会让它以为"这些要披露才有"，
           * 于是它开始把已知的技能再 enable 一遍 —— 白烧轮次，且日志里看起来还一切正常。
           */
          if (!lazyOn) {
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '当前没有开启技能渐进披露：全部技能工具**都已经直接在你的工具表里**，'
                + '不需要通过本工具查找，直接调用需要的技能即可。',
            });
            try {
              taskTrace.record(taskId, 'lazy-skills', {
                turn, lazyOn: false, query: fq, matched: [], enabled: [],
                disclosedTotal: 0, turnToolsCount: Array.isArray(turnTools) ? turnTools.length : -1,
                note: '开关关闭，本工具是空操作',
              });
            } catch { /* 取证旁路 */ }
            continue;
          }
          const fres = lazyTools.planFindSkills({
            allTools: tools,
            skillIds: lazySkillIds,
            disclosed: disclosedSkillIds,
            query: fq,
            enable: fenable,
            metaById: lazySkillMeta,
          });
          for (const id of fres.enabled) disclosedSkillIds.add(id);
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: fres.text });
          /**
           * 【观测】披露必须可核验。`turnToolsCount` 是**这一轮实际发给模型的工具数**
           * （`turnTools` 就是塞进 `body.tools` 的那张表，见上面 turn 循环开头的注释）；
           * `nextTurnToolsCount` 是"下一轮会发多少"—— 承诺与读数分开记，谁也别替谁说话。
           * ⚠️ 教训（`payload.noMetaTools` 那次）：承诺缩小、实际没缩小，而 trace 还低报。
           *   所以这里记的必须是**运行时算出来的表**，不是"打算给几个"。
           */
          try {
            const nextTurnTools = lazyTools.buildTurnTools(tools, disclosedSkillIds, lazySkillIds);
            taskTrace.record(taskId, 'lazy-skills', {
              turn,
              lazyOn: true,
              query: fres.query,
              matched: fres.matched.map((b) => b.id).slice(0, 20),
              enabled: fres.enabled,
              unknown: fres.unknown,
              alreadyCore: fres.alreadyCore,
              hiddenCount: fres.hiddenCount,
              disclosedTotal: disclosedSkillIds.size,
              turnToolsCount: Array.isArray(turnTools) ? turnTools.length : -1,
              nextTurnToolsCount: nextTurnTools.length,
              nextTurnToolsBytes: Buffer.byteLength(JSON.stringify(nextTurnTools), 'utf8'),
              fullToolsCount: tools.length,
              textChars: fres.text.length,
            });
          } catch { /* 取证旁路：失败不许影响主流程 */ }
          if (process.env.DOUYA_DEBUG_LAZY === '1') {
            console.log('[lazy] find_skills query=「' + fres.query + '」 matched=' + fres.matched.length
              + ' enabled=[' + fres.enabled.join(',') + '] disclosed=' + disclosedSkillIds.size
              + ' turnTools=' + (Array.isArray(turnTools) ? turnTools.length : -1) + '/' + tools.length);
          }
          continue;
        }

        // ===== 3) 危险操作门控（G3，2026-10-24）：按**命令形态**判定，命中即拦 =====
        // 为什么必须有这道闸（要钉住的缺陷）：
        //   `shell-exec` 在授权分档里是 **auto** 档（AUTH_TIER_BY_TOOL 只覆盖 deploy/ssh/db 一类
        //   **技能名**），于是「看起来在解决问题、副作用比问题本身更大」的命令会被**原样执行**：
        //   递归把整棵树放开成谁都能写、递归强删依赖目录、`sed -i` 直接改**验收脚本本身**。
        //   最后那条最严重 —— 它让"测试变绿"这件事失去意义，之后所有读数都不可信。
        //
        // 与下一段 `needsUserConfirm` 的分工（两者互不替代，也互不修改）：
        //   · needsUserConfirm：按**技能名 / action 档位**决定"要不要问用户"；
        //   · 本闸：按**命令形态**决定"要不要直接拦死"。
        //   位置纪律：必须在 needsUserConfirm **之前**、在所有执行分支之前 ——
        //   命中就 `continue`，命令一个字都不许真跑（只打日志不算拦）。
        //
        // 判定与文案全在 riskGate.js（纯函数、零 fs）；这里只做三件事：记账 / 回灌 / 拦或问。
        const riskInfo = classifyRisk({ name, params });
        if (riskInfo.risky) {
          const riskTarget = riskInfo.command.slice(0, 160);
          // 【执行记录 · 风险留痕】判为危险就必须在 trace 上留一条，无论最后拦下还是放行确认 ——
          //   否则事后查「这条命令为什么没执行 / 为什么弹了窗」时只剩一片空白。
          recordSkip('危险操作（' + riskInfo.category + '）', name, riskTarget);
          if (isGateEnabled() && riskInfo.level === 'block') {
            // 回灌文案以失败前缀（`错误：`）开头 —— 本仓不变式：判了失败的结果，
            // 文本自己也得能被 isFailureResult 认成失败，否则会被记成"完成"
            // （门禁 scripts/smoke/unit-failure-side-split.mjs 钉着这条）。
            conversation.push({ role: 'tool', tool_call_id: tc.id, content: riskInfo.message });
            markStep(name, false, '危险操作已拦下（未执行，已说明范围/可逆/替代）', 'skipped');
            if (process.env.DOUYA_DEBUG_INTENT === '1') {
              console.log('[risk-gate] 拦下 ' + name + ' category=' + riskInfo.category
                + ' level=' + riskInfo.level + ' targets=' + JSON.stringify(riskInfo.targets));
            }
            continue;
          }
          if (isGateEnabled() && riskInfo.level === 'confirm' && !needsUserConfirm(name, params)) {
            // 危险但可协商（可重建 / 可回滚）。这类技能本身是 auto 档，既有确认门不会为它弹窗，
            // 所以在这里补一次**显式确认**——语义与既有确认门一致，只问一次、不带"不再询问"。
            if (unattended) {
              // 无人值守：不挂起（不白等 300s），如实说清"未执行"，绝不许静默当作"用户已同意"。
              recordSkip('危险操作·需确认（' + riskInfo.category + '）', name, riskTarget);
              // ★ 2026-11-09：同时排进待批队列 —— 闸门清单只说"没做"，用户不知道自己该做什么。
              //   这一类是「可重建/可回滚」，所以 reversible:true（回来点一下就能补做）。
              pendingQueue.add({
                tool: name,
                summary: riskInfo.categoryLabel + '（' + riskTarget + '）',
                // reversible:true 说的是"这个动作做了之后能重建/能回滚"，
                // done:false 说的是"现在**还没做**"。早期把这两件事混成一个字段，
                // 于是收尾把它渲染成「（可回滚）」—— 用户读成"已经做完了可以撤回"，与事实相反。
                reversible: true,
                done: false,
              });
              conversation.push({ role: 'tool', tool_call_id: tc.id, content: riskInfo.message });
              markStep(name, false, '无人值守：危险操作需确认，已跳过（未执行）', 'skipped');
              continue;
            }
            const rid = genId('risk');
            send({
              type: 'confirm', id: rid, name,
              params: maskSecrets(params), phase: ph.phase,
              label: riskInfo.categoryLabel, target: '',
            });
            const riskDecision = await waitConfirm(rid, 300000, taskId);
            if (await bailIfAborted(tc)) return;
            if (!riskDecision || !riskDecision.allow) {
              send({ type: 'confirm_result', id: rid, allowed: false });
              conversation.push({ role: 'tool', tool_call_id: tc.id, content: riskInfo.message });
              markStep(name, false, '危险操作：用户未确认，已拦下（未执行）', 'skipped');
              continue;
            }
            send({ type: 'confirm_result', id: rid, allowed: true });
            // 用户明确允许 ⇒ **不 continue**：落到下面的既有执行链（needsUserConfirm 为 false，
            // 会一直走到「普通技能：直接执行」那一支）。这样执行路径只有一条，不新增第二份 runSkill。
          }
        }

        // 3.5) 需确认的危险操作：发确认事件并挂起，等前端 /api/exec
        //    去重：同一任务内，用户勾选过「不再询问此服务器」的目标，后续调用直接放行（首次必弹）。
        // 【0.21.10】判据从「名字在不在集合里」升级为「按 action 分档」：
        // geo-company-register 的 list 是只读（不打扰），delete 是删公司（永远确认），
        // 只看名字分不出来。CONFIRM_TOOLS 现在退化为「名字级粗视图」，仅供编排门控与 UI 提示。
        if (needsUserConfirm(name, params)) {
          if (unattended) {
            // 无人值守：需用户在场确认的危险操作不挂起、不等待，如实跳过并继续别的步骤。
            // 诚实红线：显式记账（含目标服务器键），绝不许静默当作「用户已同意」通过。
            recordSkip('confirm', name, confirmTargetKey(params));
            // ★ 2026-11-09：同步进待批队列。这类多为对外可见/远端操作用（部署、推送、发布），
            //   保守按**不可回滚**标记 —— 宁可多让用户看一眼，也不许混进"可回滚"里被随手批准。
            pendingQueue.add({
              tool: name,
              summary: name + (confirmTargetKey(params) ? '（' + confirmTargetKey(params) + '）' : ''),
              // 这类多为对外可见/远端操作（部署、推送、发布）⇒ 保守按不可回滚标记：
              // 宁可多让用户看一眼，也不许混进"可撤回"里被随手批准。
              reversible: false,
              done: false,
            });
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '【无人值守】该操作（' + name + '）需要用户在场确认，但当前为无人值守模式，已跳过（**未执行**）。',
            });
            markStep(name, false, '无人值守：需确认，已跳过（未执行）', 'skipped');
            continue;
          }
          const aid = genId('act');
          // 【0.21.10】always 档**不下发** target：前端据 target 非空才显示「不再询问」，
          // target 为空则永不记账（见下方 confirmedTargets.add 的条件）。
          // 这样「每次都必须确认」不靠前端纪律，而是靠协议本身表达不出来 —— 前端想记住也没键可记。
          const target = isAlwaysConfirm(name, params) ? '' : confirmTargetKey(params);
          const preAuthorized = !!target && confirmedTargets.has(target);
          if (!preAuthorized) {
            // 发给前端的只是「脱敏后的参数副本」用于展示；真正执行仍用下方原始 params（含密码），
            // 保证密码不出主进程（渲染进程收到的永远是 ••••••）。
            // target 是服务器键（非密钥），随事件下发，前端据此决定是否显示「不再询问」勾选。
            send({ type: 'confirm', id: aid, name, params: maskSecrets(params), phase: ph.phase, label: ph.label, target });
            const decision = await waitConfirm(aid, 300000, taskId);
            if (await bailIfAborted(tc)) return;
            if (!decision || !decision.allow) {
              send({ type: 'confirm_result', id: aid, allowed: false });
              conversation.push({ role: 'tool', tool_call_id: tc.id, content: '用户取消了该操作' });
              markStep(name, false, '用户取消', 'skipped');
              continue;
            }
            // 只有「明确允许」且「用户勾选」且「有服务器键」时才记账；target 为空时永不去重。
            // 严格 === true：/api/exec 传来的非布尔真值（"true" / 1 / 省略）一律不算勾选，安全底线。
            // 第二道保险：即便 target 因为将来改回 R3 又变非空，always 档也不许入账。
            // 两处都写不是冗余 —— 这是「每次必须确认」的唯一闸口，单点失守等于红线失守。
            if (target && decision.remember === true && !isAlwaysConfirm(name, params)) confirmedTargets.add(target);
            send({ type: 'confirm_result', id: aid, allowed: true });
          }
          send({ __tool__: name, label: actionLabel, silent: SILENT_TOOLS.has(name), id: evtId }); // 通知前端正在调用哪个技能（带 id，供结果配对）
          const manifest = skills.find((s) => s.id === name);
          let result;
          if (!manifest) {
            result = 'error: skill not found: ' + name;
          } else if (argsInfo.canExecute === false) {
            // 参数**根本不可用**（多为生成被输出上限截断）：**绝不带着空参数去执行**。
            // 执行只会得到"缺参数"这种误导性报错，让模型以为是自己漏写，从而原样重试、永远修不好。
            // 严格判等 false（fail-open）：字段缺失时放行，不因漏传一个字段就拦死所有调用。
            result = 'error: 本次调用没有执行：' + argsInfo.reason;
          } else {
            try {
              // 传入任务级 signal：用户点「停止」时能真中断正在执行的技能（第 4 参可选、向后兼容）
              // ★【F1b】页数预算注入（唯一实现 wfCtl.withPageBudget；记账/门禁仍用原始 params）
              const runParams = (wfCtl && typeof wfCtl.withPageBudget === 'function')
                ? wfCtl.withPageBudget(name, params) : params;
              // ★【KI-001】同上一处：执行区间的前快照（只对 shell-exec 且声明了产物契约时生效）
              armExecBounds(name);
              result = await runSkill(manifest, runParams, cfg, { signal: taskEntry.lifeCtrl.signal });
            } catch (e) {
              // ★ 2026-11-09：同并行路径 —— 进程级事实随 argsInfo 进分类器。
              try { if (argsInfo) argsInfo.failure = procEvidence.fromError(e, { skillId: name }); } catch { /* 取证旁路 */ }
              result = 'error: ' + e.message;
            }
          }
          result = governToolResult(name, params, result, argsInfo);
          send({ __tool_result__: { name, result: String(result).slice(0, 3000), id: evtId, ok: !isFailureResult(result) } });
        trackDeliverable(name, params, result);
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
          // ★ 执行路径②（需确认工具）：带出 target
          markStep(name, !isFailureResult(result), String(result).split('\n')[0], undefined,
            deriveStepTarget(name, params));
          continue;
        }

        // 4) 普通技能：直接执行
        // 产出真实内容前必须深度联网搜索（用户明确要求：只给一个表格/一句话不能照着糊弄，
        // 要先读懂材料提取主题，逐项搜索、抓正文，拿到真实资料才生成）
        if (SEARCH_FIRST_SKILLS.has(name) && searchCount < 2 && searchBlockCount < 3) {
          searchBlockCount++;
          conversation.push({
            role: 'tool', tool_call_id: tc.id,
            content: '【系统】产出前必须先做深度联网研究，不能只搜一次就敷衍生成。要求：①先读懂用户给的材料（表格/文字/文件），从中提取关键主题、实体、数据点；②用「联网搜索」技能（web-fetch，传 query）至少搜 2 个不同关键词，把真实数据、行业现状、竞品、案例、专业术语搜出来；③对最相关的 1-2 条结果，再用「联网搜索」技能（传 url）抓取网页正文深度阅读；④把搜到的真实内容揉进成果再生成。搜完再重新调用「' + name + '」技能。'
          });
          continue; // 拦截，不执行该产出技能
        }
        send({ __tool__: name, label: actionLabel, silent: SILENT_TOOLS.has(name), id: evtId }); // 通知前端正在调用哪个技能（带 id，供结果配对）
        const manifest = skills.find((s) => s.id === name);
        let result;
        if (!manifest) {
          result = 'error: skill not found: ' + name;
        } else if (argsInfo.canExecute === false) {
          // 同上：参数**根本不可用**就绝不执行（见上方 argsInfo 注释）；严格判等 false 是刻意 fail-open。
          result = 'error: 本次调用没有执行：' + argsInfo.reason;
        } else {
          try {
            // 传入任务级 signal：用户点「停止」时能真中断正在执行的技能（第 4 参可选、向后兼容）
            // ★【F1b】页数预算注入（唯一实现 wfCtl.withPageBudget；下面 governToolResult /
            //   trackDeliverable / markStep 继续用**原始** params ⇒ 注入对门禁与记账不可见）
            const runParams = (wfCtl && typeof wfCtl.withPageBudget === 'function')
              ? wfCtl.withPageBudget(name, params) : params;
            // ★【KI-001】执行区间的前快照。**这一处最容易漏**（正常任务走的就是这条分支：
            //   shell-exec 在授权分档里是 auto 档，不弹确认、不进「需确认工具」分支）——
            //   本轮实测就是漏在这里，通道静默不生效且零报错。别删，删了由新门禁的 P5 转红。
            armExecBounds(name);
            result = await runSkill(manifest, runParams, cfg, { signal: taskEntry.lifeCtrl.signal });
          } catch (e) {
            // ★ 2026-11-09：同并行路径 —— 进程级事实随 argsInfo 进分类器。
            try { if (argsInfo) argsInfo.failure = procEvidence.fromError(e, { skillId: name }); } catch { /* 取证旁路 */ }
            result = 'error: ' + e.message;
          }
        }
        result = governToolResult(name, params, result, argsInfo);
        send({ __tool_result__: { name, result: String(result).slice(0, 3000), id: evtId, ok: !isFailureResult(result) } });
        // 与并行路径对齐：只算**成功**的 web-fetch（失败的搜索没提供真实资料，不该让产出技能被放行）
        if (name === 'web-fetch' && !isFailureResult(result)) searchCount++;
        trackDeliverable(name, params, result);
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
        // ★ 执行路径③（普通技能 —— 正常任务走的就是这条）：带出 target
        markStep(name, !isFailureResult(result), String(result).split('\n')[0], undefined,
          deriveStepTarget(name, params));
      }
      } catch (__luE) {
        _luTeOk = false;
        throw __luE;
      } finally {
        try {
          // artifactHashes（规格 §2.4.5）：只算**本次**新增的产物；逐文件 try、单条失败不连累整段。
          // 数组上限 8 条（别让一次 bundle 任务把 trace 行撑爆）；超了截断并把原因写进 reason。
          // ⚠️ ok **不反映**哈希成败：哈希失败不是工具失败，混淆两者会让 verdict 说谎。
          const _luTeHash = [];
          const _luTeWhy = [];
          for (const _luD of (deliverables || [])) {
            const _luP = _luD && _luD.path;
            if (!_luP || _luTeSeen.has(String(_luP))) continue;
            if (_luTeHash.length >= 8) { _luTeWhy.push('hashes-truncated'); break; }
            try {
              const _luAbs = path.isAbsolute(_luP) ? _luP : path.resolve(AGENT_WORKSPACE, _luP);
              _luTeHash.push(crypto.createHash('sha1').update(fs.readFileSync(_luAbs)).digest('hex'));
            } catch { _luTeWhy.push('hash-missing:' + path.basename(String(_luP))); }
          }
          // 工具结果那一半：用本轮既有的失败计数差（markStep 就在循环体里），不另判一次。
          if (((turnSnap && turnSnap.fail) || 0) !== _luTeFail0) _luTeOk = false;
          __luTracker.end('tool-exec', __luTe, {
            ok: _luTeOk, tool: _luTeTool, count: _luTeN, artifactHashes: _luTeHash,
            ms: Date.now() - _luTeT0,
            ...(_luTeWhy.length ? { reason: _luTeWhy.join(',') } : {}),
          });
        } catch (__luE2) { try { process.stderr.write('[loop-unit] end tool-exec failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
      }
      // 本轮调过工具 ⇒ 确认进入「干活」状态。注意：这里**不再**用它把 wantThink 从 none 翻转成 high
      // —— 深度思考已在请求开始时由 thinkSignals 一次性判对（见上方）。保留 didToolCall 仅作诊断，
      // 因为「首轮 none + 调工具」产生的工具轮必然缺 reasoning_content，中途转 high 会被契约守卫拦下并 400。
      if (toolCalls.length) {
        didToolCall = true;
        // 三态记账（2026-10-21）：与并行分支同一个口径。
        taskEntry.execCount = (taskEntry.execCount || 0) + toolCalls.length;
        taskEntry.prodCount = (taskEntry.prodCount || 0) + countProductive(toolCalls);
        if (process.env.DOUYA_DEBUG_THINK === '1') {
          console.log('[DEBUG think] didToolCall=true turn=' + turn + ' lockedThink=' + deepThink);
        }
      }

      // ---- 轮尾：长期记忆抽取（B 阶段 #252，**旁路**）----
      // ★ 位置的选择（为什么是这里，而不是轮首或整段收尾）：
      //   · 轮尾 —— 此刻本轮的「用户说了什么 / 模型答了什么 / 调了哪些工具」都已入队，
      //     抽取看得到**刚说完的话**。放轮首会永远慢一轮，放任务开始前则什么都看不到。
      //   · 放在本轮工具执行**之后**：串行/并行两条路径都汇到这里，不会漏记；
      //     而 break（收尾）分支不经过这里 —— 任务已结束，再抽取只会拖慢收尾。
      //
      // ★★ 2026-10-21 修：这一段原来落在 `for (let turn …)` 的**循环体之外**（for 已在上方闭合），
      //   注释写着"轮尾 / 每轮一次"，实际是**整个任务只跑一次**。三个后果，全部有实测：
      //     ① 日志行 `'[Memory] turn=' + turn` 引用的 `turn` 是 for 的块级作用域变量，
      //        循环外**未定义** ⇒ 该行**必抛** ReferenceError，被下面的 catch 吞成
      //        `[Memory] side path escaped: turn is not defined`
      //        （真模型 e2e 日志里抓到的原文，见 scripts/tmp-probe/real-model-e2e.mjs）。
      //     ② `memoryWatermark`（owner → 已处理消息条数）只有在**每轮**调用时才自洽：
      //        整任务只调一次时，上一个任务的对话长度会成为下一个任务的起点
      //        ⇒ 新任务 `conversation.slice(seen)` 长期为空 ⇒ **新任务的记忆一条都不抽**。
      //        （首轮注释写着"水位线为 0 ⇒ 全量"，那只有在每个任务第一次调用时才有意义。）
      //     ③ 门禁没抓到 —— `unit-memory-write-wiring` 的 W3c 原来用
      //        `SRC.indexOf('runMemorySidePath', loopIdx) > loopIdx` 判「在循环内」，
      //        而它命中的是**本段注释里的一个词**，真正被调用的却是 `runMemoryTurn`。
      //        `indexOf` 只能证明"出现在之后"，证不了"落在里面"。该判据已同轮改为真实花括号作用域。
      //
      // ★★ 三条例外纪律（缺一条就会变成"辅助功能杀死主功能"）：
      //   ① 整段包 try/catch —— 记忆侧任何异常都不得向上传播（R5）。
      //      注意 runMemoryTurn 内部已经保证不抛，这里是**第二道**兜底：
      //      因为「它不抛」是它的承诺，而本行的存在让这个承诺**不成为主流程的依赖**。
      //   ② 不 await 出任何分支/返回值 —— 结果只用于日志，绝不进终态判定。
      //   ③ 绝不 throw、绝不 return、绝不 continue —— 本段对控制流**零影响**。
      try {
        const memOutcome = await runMemoryTurn(conversation, payload.username);
        // 只有"真的更新了"或"异常类原因"才留痕；正常空转不刷日志。
        if (memOutcome && memOutcome.status !== MEMORY_STATUS.NO_CHANGE) {
          console.log('[Memory] turn=' + turn + ' ' + memOutcome.status + '/' + memOutcome.reason
            + ' passed=' + (memOutcome.passedCount || 0) + ' rejected=' + (memOutcome.rejectedCount || 0));
        }
      } catch (e) {
        // 走到这里说明连旁路编排器都失效了 —— 那是它的问题，但**绝不能连累用户任务**。
        console.error('[Memory] side path escaped:', e && e.message);
      }
    }

    // ── 执行单元 ⑩ terminal（形态 W）────────────────────────────────────────────
    // ★ 本卡唯一"看起来该进全局 finally、实际绝不能"的地方，理由写在明面上：
    //   `createUnitTracker.end()` 在 token 不是对象时会**抛错**。若把它放进全局 finally，
    //   一旦异常在本段**之前**抛出（本单元的 begin 从未执行），finally 里拿到 undefined ⇒
    //   在 finally 里抛，而 finally 抛出的错会**顶替掉正在传播的原异常** ——
    //   用户从此看到的是 TypeError 而不是真正的失败原因。最坏的一类回归：
    //   把可诊断的故障变成不可诊断的。⇒ 本单元自带 try/finally，不借全局那个。
    const _luTmT0 = Date.now();
    const __luTm = __luTracker.begin('terminal');
    try {
    // 【统一终态收尾 2026-10-23】轮次真的用完了 —— 先补终态判定，再决定要不要发硬出口文案。
    // 为什么单独立一段：自查回灌（4786 的 continue）耗尽最后一轮时，`finalTextSent` 早已为 true，
    // 下面 `if (!finalTextSent)` 整块会被跳过 ⇒ 修前既没有 terminal 事件、endStatus 也停在初值，
    // 用户看到的是「完成」（实测 task_mvkad091 就是这样：24/24 轮、自查 3 轮全判未完成、status=done）。
    if (terminalStateFinal === null) {
      terminalStateFinal = TERMINAL.PARTIAL;
      terminalReason = 'turn-limit';
    }
    // 模型一直调用工具到达上限：强制一次"只许说话"的收尾，绝不让用户面对空白回复
    if (!finalTextSent) {
      endStatus = 'incomplete';
      taskEntry.current = { step: taskEntry.stepNo, skill: taskEntry.lastSkill || '', status: 'turn-limit' };
      const ok = await finalizeWithText();
      if (!ok) {
        // ★ 规范 §30：这里的状态是 PARTIAL（步数用完＝还在干活、没收敛），
        //   所以**不许对用户说「做完了」** —— 旧文案正是这么写的（"这次的东西我做完了"），
        //   与它自己设的 endStatus='incomplete' 自相矛盾。改用三态口径的如实表述。
        await sendTextAsStream(terminalStatement(TERMINAL.PARTIAL, {
          pending: deliverables.length ? ['把剩下的步骤做完并复核'] : ['把这一步做完'],
          stuckAt: '单次任务的步数用完了，我还没收敛',
          needFromUser: '（不需要你提供任何东西）',
          afterUserCanDo: '从没做完的地方接着做',
        }));
      }
      // 明确告知轮次上限（与「跨请求续跑」能力配套：有续跑才敢让用户说「继续」）
      // ★ 2026-09-24：轮数上限已可配（DOUYA_MAX_TURNS）⇒ 这里**必须**插值，不许再写死 24，
      //   否则 DOUYA_MAX_TURNS=40 时会对着用户说"已达到 24 轮"——那是对用户说假话。
      // ★ 2026-11-03：原句只说「我先停下汇报进度；你说一声「继续」」—— 用户读完仍然不知道
      //   停在哪一步、做出来的那些能不能用、还差什么，正是「没完成啥也不知道」的来源。
      //   改成先把这三件事说清楚（停在哪 / 已完成什么 / 还差什么），再给往下走的路。
      const tlDone = (taskEntry.doneLog || []).map((d) => '· ' + d.skill + '：' + (d.brief || (d.ok ? '完成' : '失败')));
      const tlArts = deliverables.map((d) => '· ' + d.path);
      emitGateReport();   // 跳过的闸门走独立事件（前端折叠条），不再拼进正文
      await sendTextAsStream('\n\n（说明：已达到单次任务 ' + MAX_TURNS + ' 轮的步数上限，我停在这里）'
        + '\n停在哪一步：' + (taskEntry.lastSkill || '（还没进入具体步骤）')
        + (tlDone.length ? '\n已经做完的：\n' + tlDone.join('\n') : '\n已经做完的：（还没有登记完成的步骤）')
        + (tlArts.length ? '\n已产出的文件（已保留，可直接打开）：\n' + tlArts.join('\n') : '')
        + '\n还差的：上面这些步骤之后剩下的部分 —— 这个任务的轮次已经不够了。'
        + '\n已完成的东西不受影响，可以直接用；接着做不丢进度，你说一句「继续」，我从这里往下走。');
      await appendPendingNote();
      if (deliverables.length) {
        appendDeliverables(deliverables, payload.username);
        send({ type: 'deliverables', items: deliverablesForUser(), workspace: AGENT_WORKSPACE });
      }
      // 【终点状态一致性】这条出口原本写死 `sendPhase('done','完成')`，但它上面刚设了
      // `endStatus='incomplete'` ⇒ 界面说"完成"、状态说"未完成"，正是规范 §三 明令禁止的
      // 「还有关键工作没有完成，却说 COMPLETE」。轮次上限**本身**就意味着模型还在干活、没收敛，
      // 所以这里不许出现"完成"二字；同时补一道产物静默复验，坏就如实说坏在哪。
      if (deliverables.length) {
        const lv = verifyDeliverables(
          deliverables.map((d) => ({ name: d.name, path: path.isAbsolute(d.path) ? d.path : path.resolve(AGENT_WORKSPACE, d.path) }))
        );
        if (!lv.ok) await reportArtifactVerdict(lv);
      }
      // ★ 2026-09-24 对称化补全：预算出口的 sendPhase 里带 `wrappedUp: wrapUpMode`，
      //   轮数出口原来**什么都不带** ⇒「轮数轴的软收尾到底生效了没有」在事件流/记录里完全不可观测
      //   （只能靠翻对话文本猜）。这里补上同一组口径，两条资源轴的收尾状态才可比对、可审计。
      sendPhase('done', terminalLabel(TERMINAL.PARTIAL) + '（步数用完了，做到哪了见上）', 100,
        { reason: 'turn-limit', wrappedUp: wrapUpMode, wrappedUpReason: wrapUpReasonUsed, maxTurns: MAX_TURNS });
    }
    } finally {
      try {
        __luTracker.end('terminal', __luTm, {
          ok: terminalStateFinal !== null,
          // ★★ 2026-11-05【D10】这一行**读得太早**，正常路径上它必然读到空串（真跑实测：五条端到端臂
          //   全部 status:""）。因果链：`endStatus` 的五个赋值点（中断/超时 :7180、预算 :7539、
          //   流空闲 :8841、轮尽 :10381、异常 :10442）在**正常收尾**路径上一条都不走；
          //   `endStatus` 真正被派生是在 `finalizeTask()` 里（`:7887`
          //   `endStatus = TERMINAL_TO_TASK_STATUS[terminalStateFinal]`），而 `finalizeTask` 在这一段
          //   **之后**才被调用（外层 finally :10474）—— 本行当时读到的还是 null。
          //   ⇒ 不是"字段忘了填"，是"在读一个还没算出来的值"。
          // 修法：显式兜底到**同一个映射表**（不是另一个口径）—— finalizeTask 正常路径派生的就是它。
          //   `terminalStateFinal` 为 null 时（下面 `ok` 那条已承认这种可能）仍落回 ''，与修前等价，
          //   不引入新谎言。
          // ⚠️ 边界（如实记，不在这行修）：若 `finalizeTask` 里的工作流终审把 COMPLETE 压成 PARTIAL
          //   （`:7869`），本行已经按 COMPLETE 记成 'done' ⇒ 与 tasks.json 的 'incomplete' 不一致。
          //   要修那个得把 terminal 的 end 挪到 finalizeTask 之后，而那个顺序是上一卡定死的，
          //   得先裁决 —— 故只登记，不乱动。
          status: String(endStatus || TERMINAL_TO_TASK_STATUS[terminalStateFinal] || ''),
          count: taskEntry.turn || 0,
          ms: Date.now() - _luTmT0,
          ...(terminalStateFinal === null ? { reason: 'no-terminal-state' } : {}),
        });
      } catch (__luE2) { try { process.stderr.write('[loop-unit] end terminal failed: ' + (__luE2 && __luE2.message) + '\n'); } catch { /* ignore */ } }
    }
  } catch (e) {
    endStatus = 'error';
    taskEntry.lastError = clip(e && e.message, TASK_ERR_MAX);
    send({ error: e.message });
  } finally {
    // 先清任务级心跳（2026-10-21）：它是 setInterval，不清就会在任务结束后继续往死连接里写，
    // 把进程句柄一直吊着（长跑后端会累积成泄漏）。放在 finally 第一行，任何出口都必然执行到。
    if (taskHeartbeat) clearInterval(taskHeartbeat);
    // ── 执行单元 ⑪ loop-finally（形态 P）──────────────────────────────────────
    // 形态 P 不是偷懒：它**本身就在 finally 里**，再套一层 try/finally 只会得到
    //   「finally 里抛错顶替原异常」的同一个坑（见 terminal 那段）。
    // 它的 end 必须早于下面 `taskTrace.end(...)` 的 try：否则 trace 的收尾记录会先落盘，
    //   而"这一轮到底闭没闭合"反而在它之后才知道 —— 顺序反了记录就自相矛盾。
    const _luFpT0 = Date.now();
    const __luFp = __luTracker.begin('loop-finally');
    // ★ 2026-09-24 补齐**最后一轮**的轨迹：轮首固化的是"上一轮"，所以循环退出时最后一轮还没落。
    //   去重判据是"末条的轮号"，不是"有没有 push 过"——否则中断/异常路径会重复记一轮。
    try {
      const tr = taskEntry.turnTrace;
      if (!tr.length || tr[tr.length - 1].t !== taskEntry.turn) {
        tr.push({ t: taskEntry.turn, tools: turnSnap.tools, ok: turnSnap.ok, fail: turnSnap.fail, skipped: turnSnap.skipped || 0, wrote: Math.max(0, (taskEntry.wroteCount || 0) - wroteBase), vf: turnSnap.vf || 0, newEv: turnSnap.newEv || 0, newEvWeak: turnSnap.newEvWeak || 0, artUpd: turnSnap.artUpd || 0, codeNew: turnSnap.codeNew || 0, codeUpd: turnSnap.codeUpd || 0, issClosed: turnSnap.issClosed || 0, issOpen: turnSnap.issOpen || 0, arts: deliverables.length });
        if (tr.length > TASK_TRACE_MAX) tr.shift();
      }
    } catch { /* 轨迹是取证用的，绝不能因为它出错而影响收尾 */ }
    // 收尾：注销任务（让 res.on('close') 不再误判为断开）、落盘终态
    taskEntry.done = true;
    taskEntry.ctrl = null;
    runningTasks.delete(taskId);
    // ══【统一终态收尾 2026-10-23】所有出口在此归一，之后 trace / tasks.json 用的是同一个值 ══
    // 为什么要无条件落盘：修前这里有 `if (!abortReported && !budgetReported)` 守卫，
    // 一旦 reportAbort/reportBudget 在「置位之后、落盘之前」抛异常（3713 vs 3723 之间的窗口），
    // finally 会被守卫静默跳过 ⇒ 任务永远停在 'running'。归一后 endStatus 已与精确出口一致，
    // 重复写同值是幂等的，所以守卫不再需要，改为无条件写。
    try { finalizeTask(); } catch { /* 归一失败不阻断收尾，下面 persistTask 仍会写 null 之外的值 */ }
    try { persistTask(endStatus); } catch { /* 落盘失败不影响收尾 */ }
    // 【终态记录兜底】修前只有「正常收尾」和「预算」两条出口会写 terminal 事件，
    // 中断/超时/异常/上游失败/轮次耗尽全都没有 ⇒ 事后无法回答「这个任务为什么结束」。
    // 这里补一条，reason 带上真实出口，facts 里区分「完成度判定」与「终止原因」。
    if (!terminalTraced && terminalStateFinal) {
      traceTerminal(terminalStateFinal, terminalReason || endStatus || 'unknown-exit', {
        exitStatus: endStatus,
        turns: taskEntry.turn || 0,
        usedTokens: taskEntry.usedTokens || 0,
        deliverables: deliverables.length,
        reviewRounds: taskEntry.reviewRounds || 0,
      });
    }
    // 【执行记录 · 任务结束】放在 finally 里 ⇒ 正常结束、抛异常、用户中断、预算耗尽**都会留下**这一条。
    // 这一条的意义是「这个任务的记录到此为止，且它以 status=X 收场」——
    // 缺了它，CLI 无法区分「记录没写完」和「任务还在跑」。
    // ── loop-finally 收尾（形态 P）：把「还剩哪几个没关」**点名**写进 reason。
    //   `pending()` 不含自己（它此刻正开着）⇒ 显式滤掉自身，否则 count 恒 ≥1，
    //   那会让"永远有一个未闭合"变成常态，这条读数就废了。
    try {
      const _luFpPend = __luTracker.pending().filter((x) => x.unit !== 'loop-finally');
      __luTracker.end('loop-finally', __luFp, {
        ok: _luFpPend.length === 0,
        count: _luFpPend.length,
        ms: Date.now() - _luFpT0,
        ...(_luFpPend.length ? { reason: 'unclosed:' + _luFpPend.map((x) => x.unit).join(',') } : {}),
      });
    } catch (__luE) { try { process.stderr.write('[loop-unit] end loop-finally failed: ' + (__luE && __luE.message) + '\n'); } catch { /* ignore */ } }
    try {
      taskTrace.end(taskId, {
        // 归一后 endStatus 与 tasks.json 必然同值；兜底 'incomplete' 只防 finalizeTask 自身抛错。
        status: endStatus || 'incomplete',
        turns: taskEntry.turn || 0,
        usedTokens: taskEntry.usedTokens || 0,
        toolCalls: taskEntry.toolCalls || 0,
        deliverables: deliverables.length,
        reviewRounds: taskEntry.reviewRounds || 0,
      });
    } catch { /* 旁路 */ }
    // 收尾：结束在线连接 + 标记完成（缓冲再留 10 分钟供重连取结果，之后自动回收）。
    try { taskStream.finish(stream); } catch { /* ignore */ }
    try { if (!res.writableEnded) res.end(); } catch { /* 客户端可能已断开 */ }
  }
}


async function handleSkillsList(res, skills) {
  const list = skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    type: s.runtime || 'js',
    params: s.params || [],
    // 真源唯一：哪些技能需要用户确认，只由 CONFIRM_TOOLS 定义；前端/桌宠据此把需确认的技能
    // 从工具表里滤掉（桌宠不处理 confirm 事件，若不滤掉会挂在 waitConfirm 上等超时）。
    requiresConfirm: CONFIRM_TOOLS.has(s.id),
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(list));
}

/**
 * `POST /api/skills/:id/run` —— **任务循环之外**的技能执行入口。
 *
 * ★ 2026-11-04 加固（P0）。这个入口原来零防线：不认证、不判风险、CORS 全开，而且
 *   `decodeURIComponent` 在调用点裸抛、调用处没有 `.catch` —— `POST /api/skills/%/run`
 *   会让整个后端因 unhandledRejection 退出（实测：`unhandledRejection: URI malformed`）。
 *
 * 加固后每道闸都 fail-closed，**任何一道不过都拒绝**：
 *   ① `X-Douya-Skill-Token` 能力令牌缺失/不匹配 ⇒ 401（先认证再解析参数：未认证的调用方
 *      连"这条命令会不会被拦"都不该知道）；
 *   ② 技能名解码失败 ⇒ 400（异常不再逃出请求处理器）；
 *   ③ riskGate 判为 block 档 ⇒ 403，**不进审批、不给放行**。
 *
 * confirm 档在本入口**不弹窗也不挂起**（本入口没有任务上下文、没有审批生命周期，
 * 拿不出"用户点了同意"这件事），但判定结果必须如实放进响应体，不许静默通过。
 *
 * ★ 这里**故意不判** `isGateEnabled()`（任务循环里是 `isGateEnabled() && level === 'block'`）。
 *   不是漏写。理由：循环里有一个人在环里看着拦下的原因（对话里有回灌文案、有 markStep），
 *   而这个入口没有 —— 它只有一次 HTTP 请求和一个响应码。`DOUYA_RISK_GATE=off` 的语义是
 *   「暂时让模型自己承担这个风险」，不是「让任何持令牌者在本机无审批地执行 rm -rf」。
 *   ⇒ 开关只关「循环里的自动判定」，不关这个入口的 block 闸。要改这条必须先想清楚
 *     「关闸之后谁来看住这个入口」，否则不要动。
 */
async function handleSkillRun(req, res, skills, rawId) {
  // ① 能力令牌
  if (!skillRunToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'skill-run-not-initialized', message: '后端未完成启动初始化，拒绝执行。' }));
    return;
  }
  const given = String(req.headers['x-douya-skill-token'] || '');
  if (!given || !timingSafeEqualStr(given, skillRunToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'unauthorized',
      message: '本入口需要可信调用方令牌（请求头 X-Douya-Skill-Token）。'
        + '应用自有界面不走这个入口；外部集成可从 dataDir/skill-run.token 读取，'
        + '或用环境变量 DOUYA_SKILL_RUN_TOKEN 固定。',
    }));
    return;
  }
  // ② 技能名：解码失败不许把异常抛出请求处理器
  let id = '';
  try { id = decodeURIComponent(rawId); } catch { id = ''; }
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad skill id' }));
    return;
  }
  const manifest = skills.find((s) => s.id === id);
  if (!manifest) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'skill not found' }));
    return;
  }
  let params = {};
  try {
    params = JSON.parse(await readBody(req) || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }
  // ③ 危险操作：block 档直接拒绝
  let risk = null;
  try {
    risk = classifyRisk({ name: id, params });
  } catch (e) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'risk-gate-error',
      message: '风险判据异常，已拒绝执行（fail-closed）：' + e.message,
    }));
    return;
  }
  if (risk && risk.risky && risk.level === 'block') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'blocked-by-risk-gate',
      category: risk.category,
      categoryLabel: risk.categoryLabel,
      level: risk.level,
      targets: risk.targets,
      message: risk.message,
      alternative: risk.alternative,
    }));
    return;
  }
  try {
    const result = await runSkill(manifest, params);
    const body = { result };
    if (risk && risk.risky) {
      body.risk = {
        level: risk.level,
        category: risk.category,
        categoryLabel: risk.categoryLabel,
        targets: risk.targets,
        message: risk.message,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

/** GET /api/experts —— 返回专家列表（不含 systemPrompt） */
function handleExpertsList(res) {
  const list = getExperts().map((e) => ({
    id: e.id,
    name: e.name,
    emoji: e.emoji,
    description: e.description,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(list));
}

/** GET /api/experts/:id —— 返回单个专家完整信息 */
function handleExpertDetail(res, id) {
  const expert = getExpert(id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(expert));
}

function buildCallbackHtml(ok, info) {
  const title = ok ? '连接成功' : '连接失败';
  const msg = ok ? `「${info.name}」已成功连接，可关闭此页面回到应用。` : '错误：' + (info.error || '未知');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;background:#1e1e26;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column}h1{color:${ok ? '#4caf50' : '#f44336'}}</style>
  </head><body><h1>${title}</h1><p>${msg}</p><script>setTimeout(()=>window.close(),1500)</script></body></html>`;
}

let currentCfg = null;

/**
 * 「当前账号变了」的通知钩子（2026-11-06 · 产物隔离）。
 *
 * 为什么需要它：产物目录（`wanxMediaDir()`）由**主进程**派生，而"当前是哪个账号"
 * 是**本文件**在处理登录/校验时才知道的。两边各拿一半事实 ⇒ 必须有一个人通知另一个人。
 * 选主进程反向通知（而不是 main.js 去轮询账号文件）：登录那一刻就能立刻切目录，
 * 不用等下一次 `wanx:*` 调用，也就没有"刚登录时作品库还是上一个账号的"那个窗口。
 *
 * ⚠️ 存成模块级变量（而不是塞进 options 闭包里）：`startBackend` 只被调一次，
 *   但两个记账点（login / profile）在 HTTP 回调里，拿不到 options 作用域。
 */
let accountChangeHook = null;

/**
 * 注册账号变更钩子。
 * @param {Function|null} fn 回调，入参是账号对象（`{id, username, role}`）
 * @returns {void}
 */
function setAccountChangeHook(fn) {
  accountChangeHook = typeof fn === 'function' ? fn : null;
}

/**
 * 通知「当前账号已变更」。
 *
 * **异常一律吞掉**：钩子做的是"刷新产物目录 / 媒体授权根"这类旁路动作，
 * 它失败的最坏后果是缩略图 403（fail-closed），绝不该反过来把登录本身判失败。
 *
 * @param {object} user 账号对象
 * @returns {void}
 */
function notifyAccountChange(user) {
  if (!accountChangeHook) return;
  try { accountChangeHook(user || {}); } catch { /* 旁路失败不影响登录/校验 */ }
}

function getConfig() {
  return currentCfg;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 只读静态路由 `/ws/*`（2026-11-08）
 * ═══════════════════════════════════════════════════════════════════════════
 * 【为什么要这条路由 —— 不是为了方便，是因为三条路全堵了】
 *   `slides-generate` 的卖点是「产物可被浏览器截图自检」，但实测走不通：
 *     · `browser-verify` 的 `ALLOWED_PROTOCOLS` 只有 `http:` / `https:`
 *       （`skills/browser-verify/lib/urls.js`）—— 拒绝 `file://` 是**安全红线，不许放开**；
 *     · `shell-exec` 起本地静态服务会 600 秒超时；
 *     · `powershell` 缺失又直接熔断。
 *   ⇒ 渲染永远验不了 ⇒ 复检永远 unverified ⇒ 任务终态永远是 PARTIAL 而不是 COMPLETE。
 *   这条路由把 `AGENT_WORKSPACE` 下的产物暴露成
 *   `http://127.0.0.1:10119/ws/xxx.html`，让 `browser-verify` 名正言顺走 http 协议。
 *
 * 【为什么它不扩大「本机回环安全闸」的暴露面】
 *   · **只读**：只认 GET / HEAD，其它方法 405，永远不写盘；
 *   · **只读工作区**：路径必须落在 `AGENT_WORKSPACE` 之内（判据见下）；
 *   · **扩展名白名单 fail-closed**：只允许页面/样式/脚本/字体/媒体/纯文本几类，
 *     `.py` / `.exe` / 无扩展名文件一律 403 —— 这是「默认拒绝」，不是黑名单排除；
 *   · **不发 `Access-Control-Allow-Origin`**：本机浏览器里的任意网页不能靠 `<img src>`
 *     或 fetch 读到工作区内容。真正的拦截靠「该头缺省 + `Cross-Origin-Resource-Policy`」，
 *     而不是靠在某个入口写回 `*`（等于把授权根里每个文件对任意网页开放，见 KI-010）。
 *
 * 【路径穿越的判据为什么是这一串，而不是一句 startsWith】
 *   本仓踩过两次同族坑：
 *     · `skills/slides-generate/run.js` 用 `startsWith` 比字符串判越界 ——
 *       Windows 上正/反斜杠混用时 `startsWith` 恒 false ⇒ **合法写入被全部拒绝**；
 *     · `skills/file-write/run.js` 是那个有坑写法的现存反例。
 *   ⇒ 这里一律用 `path.relative` 判越界，并且**软链再验一次**（防根内 junction 指向根外）。
 *   另外 Windows 会把 `.. ` 当 `..`、`...` 当空 ⇒ 段尾的点/空格必须先归一化再判。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 路由前缀。定义成常量而不是散落字面量，避免哪天有人改成 `/ws` 少个斜杠导致前缀互吃。 */
const WS_URL_PREFIX = '/ws/';

/** 单文件上限 64 MiB。用 `stat.size` 判，绝不读进内存再判。 */
const WS_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 扩展名 → Content-Type。**这张表同时就是白名单**（键集即允许集）。
 *
 * 单一真源的理由：白名单和 MIME 分开维护时必然漂移 —— 白名单允许了 `.md`
 * 而 MIME 表里没有 ⇒ 回落成 `application/octet-stream` ⇒ 浏览器下载而不是渲染。
 * 文本类必须带 `charset=utf-8`，否则中文产物在截图里会乱码（这类「看着像渲染坏了」
 * 的问题最难查）。二进制（图片/字体/音视频）**不带** charset。
 */
const WS_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
});

/**
 * 把 `/ws/...` 的 URL pathname 解析成一个**确实落在工作区内**的绝对路径。
 *
 * 纯函数式（只读 fs 的 realpath 与 extname），不写盘、不抛异常：
 * 所有失败都以 `{ ok:false, status, error }` 返回 —— 因为调用点在 async handler 里，
 * **同步抛出会打死整个后端**（本文件已有两处同类事故，见下方 connector id 那段的注释）。
 *
 * @param {string} pathname `new URL(req.url, ...).pathname`，**仍是百分号编码的原样**
 * @returns {{ok:true, abs:string, ext:string, mime:string}|{ok:false, status:number, error:string}}
 */
function resolveWsRequest(pathname) {
  /** 统一构造失败结果。status 的语义要能审计出「没这文件」还是「有人试图越界」。 */
  const bad = (status, error) => ({ ok: false, status, error });

  const raw = String(pathname || '');
  if (raw.slice(0, WS_URL_PREFIX.length) !== WS_URL_PREFIX) return bad(404, 'not found');
  let rel = raw.slice(WS_URL_PREFIX.length);

  // (a) 多轮百分号解码到稳定 —— 防 `%252e%252e%252f` 这种二次编码。
  //     ★ 必须 try/catch：裸 `decodeURIComponent` 在 async 处理器里同步抛出会打死整个后端。
  //     第一轮就解不开 ⇒ 请求本身是坏的（400）；第二轮起解不开 ⇒ 剩下的 `%` 是文件名里的
  //     字面量（例如 `100%.html` 经 `100%25.html` 解回来后就是这样），按稳定处理。
  for (let i = 0; i < 3; i += 1) {
    if (rel.indexOf('%') < 0) break;
    let next;
    try {
      next = decodeURIComponent(rel);
    } catch {
      if (i === 0) return bad(400, 'bad-encoding');
      break;
    }
    if (next === rel) break;
    rel = next;
  }

  // (b) NUL 字节：任何文件系统 API 都会截断在它前面，历史上是典型的绕过面。
  if (rel.indexOf('\0') >= 0) return bad(403, 'nul-byte');

  // (c) 去掉开头**一个**分隔符；去掉之后仍是分隔符、或以盘符开头 ⇒
  //     这是在给我们重新指定根（UNC `//host` / `\\host`、`C:`），一律拒绝。
  let s = rel;
  if (s.charAt(0) === '/' || s.charAt(0) === '\\') s = s.slice(1);
  if (s.charAt(0) === '/' || s.charAt(0) === '\\') return bad(403, 'absolute_path');
  if (/^[a-zA-Z]:/.test(s)) return bad(403, 'drive_path');

  // (d) 两种分隔符**都**当分隔符（Windows 上 `..\..\x` 与 `../../x` 等价）。
  const segs = s.split(/[\\/]+/).filter((seg) => seg !== '' && seg !== '.');
  if (segs.some((seg) => seg === '..')) return bad(403, 'parent_segment');

  // (e) Windows 尾点/尾空格归一化：`.. ` 会被当成 `..`、`...` 会被当成空 ⇒ 先归一化再判。
  for (const seg of segs) {
    if (seg.replace(/[. ]+$/, '') !== seg) return bad(403, 'win_tail_normalized');
  }
  if (!segs.length) return bad(404, 'not found');

  // (f) 越界判定 —— **必须用 path.relative，绝对不能用 startsWith 比字符串**
  //     （Windows 上正/反斜杠混用时 startsWith 恒 false，见本段文件头）。
  const wsRoot = path.resolve(AGENT_WORKSPACE);
  const abs = path.resolve(wsRoot, segs.join(path.sep));
  const relCheck = path.relative(wsRoot, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return bad(403, 'outside_root');

  // (g) 软链二次校验：根内软链 / junction 可以指向根外，字符串层看不出来，只有 realpath 能。
  //     realpath 抛异常（文件不存在）⇒ 按 404（不能让「不存在」和「越界」混成一个状态码）。
  let realAbs = '';
  try {
    realAbs = fs.realpathSync(abs);
  } catch {
    return bad(404, 'not found');
  }
  let realRoot = '';
  try {
    realRoot = fs.realpathSync(wsRoot);
  } catch {
    realRoot = '';
  }
  if (realRoot) {
    const relReal = path.relative(realRoot, realAbs);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) return bad(403, 'outside_root_symlink');
  }

  // (h) 取扩展名供白名单判定 —— **但白名单不在这里判**。
  //     顺序是有讲究的：目录也可能没有扩展名，而规格要求「目录 ⇒ 404」而不是
  //     「目录 ⇒ 403 ext-not-allowed」（前者是"没这个文件"，后者是"这个文件不许给"，
  //     审计时要能分开）。所以 `stat.isFile()` 必须**先**跑，白名单在调用点紧随其后。
  //     扩展名取 realpath **之后**的路径：软链 `x.html` → `secret.txt` 要按 `.txt` 判。
  const ext = path.extname(realAbs).toLowerCase();
  return { ok: true, abs: realAbs, ext };
}

function startBackend(options = {}) {
  const dataDir = options.dataDir || require('os').homedir() + '/.douya-claw';
  const cfg = defaultConfig(dataDir);
  currentCfg = cfg;
  // ★ 2026-11-06：账号变更通知（见上方 setAccountChangeHook 的说明）。
  //   非函数一律视为"没接"（传了 null / undefined / 字符串都不会把上一个钩子留住一半）。
  if (typeof options.onAccountChange === 'function') setAccountChangeHook(options.onAccountChange);
  initSkillRunToken(dataDir);
  delivPath = path.join(dataDir, 'deliverables.json');
  usagePath = path.join(dataDir, 'token-usage.json');
  // 客户端用量自报：队列/凭证落盘位置 + 启动装载 + 兜底补报定时器
  usageQueuePath = path.join(dataDir, 'usage-queue.json');
  authTokenPath = path.join(dataDir, 'auth-token.json');
  loadUsageQueue();
  loadAuthToken();
  if (usageQueue.length) scheduleUsageFlush(5000);
  const usageSweepTimer = setInterval(() => {
    flushUsageReports().catch(() => { /* ignore */ });
  }, 5 * 60 * 1000);
  if (usageSweepTimer.unref) usageSweepTimer.unref();
  tasksPath = path.join(dataDir, 'tasks.json');
  // ══【僵尸任务回收】上一次进程没走到收尾的 running，在这里改判成 interrupted ══
  // 为什么必须在 tasksPath 赋值之后、且在任何"读未完成任务"之前：
  //   下面一整套东西（projectLedger / 系统提示注入 / 任务清单接口）都以 tasks.json 为准，
  //   抢在它们前面收拾，才能保证"这次启动之后，没有任何人再把一条死任务当成在跑的"。
  // 详细理由（为什么不放 before-quit、为什么写 interrupted 而不是 done）见 reapDanglingRuns 头注。
  try {
    const rp = reapDanglingRuns();
    if (rp.reaped > 0) {
      console.log('[Backend] 回收僵尸任务 ' + rp.reaped + ' 条（上次未正常收尾）：'
        + rp.ids.join(', ') + ' ⇒ status=interrupted');
    } else if (rp.scanned > 0) {
      console.log('[Backend] 僵尸任务回收：扫描 ' + rp.scanned + ' 条，无需处理');
    }
  } catch (e) {
    // 回收是修复性增益，不是主流程：失败就照常跑，只把原因说出来（静默失败会让人以为已经修好了）。
    console.error('[Backend] 僵尸任务回收失败（不影响启动）：' + ((e && e.message) || e));
  }
  // 执行记录目录（<dataDir>/traces/）：init 失败必须能被知道 —— 记录器自己静默失效，
  // 比没有记录器更糟（那会让你以为"这次没出问题"）。故失败时打一行 error，并把状态留进 health()。
  try {
    const tr = taskTrace.init({ dataDir });
    if (!tr.ok && tr.reason !== 'disabled_by_env') {
      console.error('[taskTrace] 记录目录不可用，本次运行没有执行记录：' + tr.reason);
    }
  } catch (e) {
    console.error('[taskTrace] 初始化异常（不影响主流程）：' + ((e && e.message) || e));
  }
  // ---- 工作流跨请求状态（恢复用）：与 taskTrace 同 dataDir，落在 <dataDir>/workflows/ ----
  try {
    const ws = workflowState.init({ dataDir });
    if (!ws.ok && ws.reason !== 'disabled_by_env') {
      console.error('[workflowState] 状态目录不可用，本次运行不支持中断恢复：' + ws.reason);
    }
  } catch (e) {
    console.error('[workflowState] 初始化异常（不影响主流程）：' + ((e && e.message) || e));
  }
  // ---- 产物保管库（D 阶段）：与 workflows/ **平级**落在 <dataDir>/custody/ ----
  // ⚠️ `subdir: ''` 是必需的：模块默认 subdir 是 `_custody`，不传就会变成 <dataDir>/custody/_custody，
  //   于是"保管目录与 workflows/ 平级"这条要求事实上不成立（而它看起来完全正常工作）。
  // ⚠️ root 必须是绝对路径：init 对非绝对路径返回 `root_not_absolute`，那是**静默失效**
  //   （之后每次 keep/check 都返回 not_initialized，症状像"没接上"而不是"参数写错了"）。
  // ⚠️ 同一进程只 init 一次；init 失败**不等于**清空 —— 模块会沿用上次成功的配置，
  //   所以"失败"这一支只能报清楚原因，不能假装库已经没了。
  try {
    const cu = artifactCustody.init({ root: path.join(path.resolve(dataDir), 'custody'), subdir: '' });
    if (!cu.ok) {
      console.error('[custody] 保管库不可用，本次运行不支持产物恢复：' + cu.reason);
    } else {
      console.log('[custody] 保管库就绪：' + cu.dir);
    }
  } catch (e) {
    console.error('[custody] 初始化异常（不影响主流程）：' + ((e && e.message) || e));
  }
  // ---- 长期记忆写入链路（B 阶段 #252）：落点必须用传入的 dataDir，绝不硬编码 ----
  // ⚠️ 硬编码会分叉出幽灵档案目录（仓库里已有先例：~/.douya-claw 与 userData 两套）。
  //   memoryStore 的 resolveMemoryRoot 会在 dataDir 下再拼一层 'memory'。
  memoryDataDir = dataDir;
  // 开关与「后台常驻」设置共用 desktop.json（main.js 的 readResidentSettings 也读它）。
  // ★ 为什么同文件而不是新建 memory.json：设置页写一处、读一处，避免"两个设置文件谁是准的"。
  desktopSettingsPath = path.join(dataDir, 'desktop.json');
  memoryEnabledCache = { at: 0, value: true };   // 启动时清缓存，让磁盘值立即生效
  console.log('[Memory] write path ready: dataDir=' + dataDir
    + ' enabled=' + memoryEnabled());
  const skillsDir = options.skillsDir;
  const skills = scanSkills(skillsDir);
  loadedSkills = skills; // 供 getSkills() 导出（主进程/桌宠据此构造 payload.tools）
  console.log(`[Backend] loaded ${skills.length} skill(s) from ${skillsDir || '(none)'}`);
  // 检索 provider 就绪情况（只打印「已配置/未配置」，**绝不打印 key 本身**）
  console.log('[Backend] ' + describeProviders(cfg));
  const connectorMgr = new ConnectorManager({
    dataDir,
    baseURL: 'http://127.0.0.1:' + PORT,
    cfg,
  });
  setConnectorManager(connectorMgr);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
    // ---- CORS：只回显白名单 Origin（★ 原来是无条件 `*`，来由见文件上部「本机回环安全闸」）----
    const cors = applyLocalCors(req, res);
    if (!cors.ok) {
      // 两种拒绝理由的文案必须分开：`file://` 页面和无白名单 Origin 是完全不同的两件事，
      // 混成一句话会让用户/审计方看不出到底哪条判据命中了。
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: cors.why || 'origin-not-allowed',
        message: cors.why === 'originless-cross-site'
          ? '本地文件页面（file://）不允许调用本机后端；请从应用界面或本机回环页面操作。'
          : '本机后端只接受应用自身（app://douya）与本机回环页面的跨源请求。',
      }));
      return;
    }
    if (req.method === 'OPTIONS') {
      if (!cors.cors) { res.writeHead(204); res.end(); return; }
      res.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type, X-Douya-Skill-Token',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    // ── 只读静态路由 `/ws/*`（设计说明与全部安全判据见 `resolveWsRequest` 上方整段）──
    // 位置有意放在 `applyLocalCors` 之后、所有 `/api/*` 之前：
    //   · 放在 CORS 闸之后 ⇒ 本机回环安全闸的 ① Origin 闸对这条路由同样生效，不需要另写一份；
    //   · 放在所有字面量路由之前 ⇒ 前缀匹配不会吃掉任何 `/api/*` 路径（两者前缀不相交，
    //     但顺序上先判前缀更不容易在以后插路由时把 `/ws` 埋到某条兜底后面）。
    if (url.pathname.startsWith(WS_URL_PREFIX)) {
      // 方法：只读。其它方法一律 405（带 Allow，便于调用方自查）。
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          'Content-Type': 'application/json; charset=utf-8',
          Allow: 'GET, HEAD',
        });
        res.end(JSON.stringify({ error: 'method-not-allowed' }));
        return;
      }

      const verdict = resolveWsRequest(url.pathname);
      if (!verdict.ok) {
        // ★ 这里**故意不发任何 CORS 头**：见文件头「不发 Access-Control-Allow-Origin」。
        res.writeHead(verdict.status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(JSON.stringify({ error: verdict.error }));
        return;
      }

      // 目录必须**显式**判 `stat.isFile()`：不许让 `readFileSync` 抛 EISDIR 落到 404 ——
      // 那样哪天换成别的读法（比如 readdir + 拼 index）就会变成能列目录。
      let st = null;
      try {
        st = fs.statSync(verdict.abs);
      } catch {
        st = null;
      }
      if (!st || !st.isFile()) {
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      // 扩展名白名单（fail-closed）：键集即允许集，不在表里一律 403。
      // **必须排在 `isFile()` 之后**：目录常常没有扩展名，若先判白名单，
      // `/ws/sub` 会得到 403 `ext-not-allowed` —— 那是"这个文件不许给"的语义，
      // 而规格要的是"没这个文件"（404），审计时要能分开。
      // 这里也是"默认拒绝"而不是"黑名单排除"：新增的扩展名不会因为忘了加规则而放行。
      if (!Object.prototype.hasOwnProperty.call(WS_MIME, verdict.ext)) {
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(JSON.stringify({ error: 'ext-not-allowed' }));
        return;
      }

      // 大小上限：用 stat.size 判，不读进内存再判（一个 4GB 的 .mov 会把主进程读死）。
      if (st.size > WS_MAX_BYTES) {
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(JSON.stringify({ error: 'too-large' }));
        return;
      }

      const wsHeaders = {
        'Content-Type': WS_MIME[verdict.ext],
        'Cache-Control': 'no-cache',
        // 双保险：即使哪天有人误加了 ACAO，CORP 也会让跨源 `<img>`/fetch 读不到正文。
        'Cross-Origin-Resource-Policy': 'same-origin',
        // 不让浏览器把 .txt 之类嗅探成 HTML 执行（截图场景里 body 是产物，不是我们写的页面）。
        'X-Content-Type-Options': 'nosniff',
      };

      // HEAD：头与 GET 完全一致，但**不发 body**（用 stat.size 给 Content-Length，不读盘）。
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...wsHeaders, 'Content-Length': String(st.size) });
        res.end();
        return;
      }

      let body = null;
      try {
        body = fs.readFileSync(verdict.abs);
      } catch {
        // 判完 stat 到读盘之间被删/被锁：按 404 处理，不再往上层抛。
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { ...wsHeaders, 'Content-Length': String(body.length) });
      res.end(body);
      return;
    }

    // ══【授权 · 2026-11-09】HTTP 侧接线 ═══════════════════════════════════
    //
    // 为什么挂在这里而不是 IPC：本应用真正的价值面是**对话/Agent**，而它走的是
    // 本地 HTTP（渲染层 `fetch(BACKEND + '/api/chat')`），不走 ipcRenderer。
    // 只拦 IPC 等于"闸装在没人过的门上"—— 用户照样能用全部功能。
    //
    // 三条不动摇的边界（写在这里，免得下一个人"顺手加严"）：
    //  ① **懒 require**。`./license/wire` 顶层 `require('electron')`，而本文件在纯 node
    //     单测里也会被加载 ⇒ 硬 require 会让整套后端起不来。懒加载 + 兜住才两种环境都能活。
    //  ② **拿不到闸就放行**。没接线（单测 / 未来的其它壳）不等于"没授权"。
    //     把"我不知道"当成"不许用"，是最容易造成"整个产品打不开"的那种错。
    //  ③ **授权门自己炸了也放行**。铁律：服务端挂了不许锁用户 —— 这条在 license/index.js
    //     里已经落成 `unknown` 状态，这里再兜一层：读闸抛异常 ⇒ 当没拦住。
    //
    // 刻意**没有**拦的东西：静态资源、`/api/health`、`/api/license/*`（不然没激活的人
    // 连输入激活码的地方都到不了 —— 那才是真的锁死）。
    const licenseBridge = (() => {
      let cached = null;
      let tried = false;
      return () => {
        if (tried) return cached;
        tried = true;
        try {
          const wire = require('./license/wire');
          cached = (wire && typeof wire.getLicenseGate === 'function') ? wire.getLicenseGate() : null;
        } catch { cached = null; }
        return cached;
      };
    })();
    /** 当前是否被授权门拦下（null = 放行）。判定本身在 license/decide.js（纯函数，可单测）。 */
    const licenseBlocked = () => {
      const g = licenseBridge();
      if (!g) return null;
      return decideBlocked(g);
    };
    const sendJson = (code, obj) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(obj));
    };

    /**
     * ══════════════════════════════════════════════════════════════════════════
     * ★★ 授权闸（统一入口 · 2026-11-11 从「单点闸」改成「默认拦 + 白名单放行」）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 【为什么改：单点闸是假的闸】
     *   改前 402 只写在 `/api/chat` 那一个分支里。端到端实测（真 HTTP、真 gate）：
     *     POST /api/chat        ⇒ 402 ✔
     *     POST /api/chat-once   ⇒ **200**，而且真的把请求打到 LLM 网关
     *                              （回的是网关的 401 "Invalid token" ⇒ 带着用户的 key 出去了）
     *     POST /api/llm/test    ⇒ **200**
     *   也就是说：没激活的人把 URL 里的 `chat` 改成 `chat-once`，就能继续白用 AI。
     *   授权对产品的实际约束力 = 0，而所有门禁都显示正常 —— 因为没人测"其它入口"。
     *
     * 【为什么是白名单，不是黑名单】
     *   黑名单（"这些要拦"）的失败方向是**新接口默认不拦**：以后谁加一个 `/api/xxx`，
     *   除非他记得来这里补一行，否则就是一个新洞，而且没有任何东西会提醒他。
     *   白名单的失败方向是**新接口默认拦**：忘了补 ⇒ 功能报 402 ⇒ 立刻被发现并修。
     *   安全默认值只能是后者。
     *
     * 【白名单里为什么是这四个（每一条都在防一个具体的死锁）】
     *   · `/api/license/*`  —— 激活入口本身。拦了它，没激活的人连输激活码的地方都到不了，
     *                          产品变成"永久锁死"，这比不设防更糟。
     *   · `/api/health`     —— 探活。渲染层/诊断靠它判断后端起没起来；被拦会被误读成"后端崩了"。
     *   · `/ws/*`           —— 静态产物服务（agent 产出的 HTML 靠它给 browser-verify 打开）。
     *                          拦了它，agent 就没法验收自己的产物 ⇒ "先做完再验收"这条链断掉。
     *   · `/api/abort`      —— **止损通道**。授权在任务执行中途过期/被吊销时（心跳 4 小时一次，
     *                          完全可能），用户连"停止"都点不动 ⇒ 只能杀进程。
     *                          铁律：授权可以限制开始，但不能让人停不下来。
     *
     * 【2026-11-11 补第五类：`/api/auth/*` —— 它是第四条无限循环，必须写清楚】
     *   事故原话（老板）："我现在豆芽进去要先激活 但是没有激活的地方"。
     *   实测（真 HTTP + 真 gate，未激活本机）：
     *     POST /api/auth/login     ⇒ 402 {"path":"/api/auth/login","detail":"还没激活"}
     *     GET  /api/auth/profile   ⇒ 402 {"path":"/api/auth/profile","detail":"还没激活"}
     *   这两条 402 各自造成一个后一半的锁，叠起来是闭环：
     *     ① login 被拦 ⇒ 渲染层 `setLoginErr(j.detail)` ⇒ 登录页红字"还没激活"。
     *        **它冒充了密码错误** —— 用户会去反复改密码，而真正的原因是授权。
     *     ② 启动验签走 profile，被拦 ⇒ `r.ok === false` ⇒ 渲染层的 `.catch` 里
     *        `localStorage.removeItem('douya-auth-token')` ⇒ **每次启动悄悄销毁登录态**。
     *        这是"拦一下"变成了"破坏数据"，比进不去更坏。
     *     ③ 而激活面板当时只挂在主界面那个 return 里，登录页/引导页都到不了。
     *   ⇒ 要登录才能激活，要激活才能登录。
     *
     *   为什么**应该**放行（不是"为了绕开麻烦"，是本来就不该拦）：
     *     - 授权要限制的是**消耗模型/联网额度**的动作（chat / llm / 生图 / 检索…）。
     *       `/api/auth/*` 只是"拿密码换 token""拿 token 换我是谁"，不打 LLM、不产生费用。
     *     - 它也不像 `/api/config` 那样明文回显本机凭证 —— 拦它拿不到任何安全收益。
     *     - 失败方向对比：放行 ⇒ 未激活的人能完成身份验证、能进界面、能看到自动弹出的激活窗
     *       ⇒ 能自救；拦 ⇒ 谁都进不去，且顺手销毁凭据。
     *   按**前缀**放行而不是逐条列举：逐条的话，以后加一个 `/api/auth/refresh` 忘了补，
     *   就又是一次同类事故，而且没有任何东西会提醒他（同 F8 对 `/api/license/` 的理由）。
     *
     * 【刻意没有放行的（想清楚了才写下来）】
     *   · `GET /api/config` —— 它**明文回显** apiKey / wxAppSecret / shopPassword / mmmPassword
     *     / geoApiKey 等全部凭证，而这是 `127.0.0.1` 的 HTTP 接口，任何本机进程都能 GET。
     *     未授权时拦住它，顺带把这个暴露面收窄。渲染层读不到只会回落成"未配置"（有 .catch 兜底），
     *     不会白屏 —— 而且未激活时本来也不该看到这些。
     *   · 那些"任务进行中的应答通道"（clarify / plan-ack / material / pick-files）：未激活时
     *     不可能有待应答的任务（发起任务的 chat 已经被拦）。真要考虑"激活中途过期"，
     *     正确做法是让用户重新激活，而不是让应答通道绕开授权。
     */
    const LICENSE_BYPASS = (p) =>
      p.startsWith('/api/license/')
      || p.startsWith('/api/auth/')
      || p === '/api/health'
      || p === '/api/abort'
      || p.startsWith('/ws/');

    if (!LICENSE_BYPASS(url.pathname)) {
      const blocked = licenseBlocked();
      if (blocked) {
        sendJson(402, {
          error: 'LICENSE_REQUIRED',
          code: 'LICENSE_REQUIRED',
          state: blocked.state,
          detail: blocked.detail,
          // ★ 2026-11-11：这里原来写的是「打开「设置 → 授权」，粘贴激活码后即可继续」。
          //   **那是一块假指路牌** —— 渲染层里根本没有「设置 → 授权」这个页面，
          //   唯一的激活入口是 LicenseGuardHost 自动弹出的 Modal（App.jsx 里内联的那个）。
          //   指引必须指向真实存在的东西，否则用户照着找只会更懵，然后来投诉"没有激活的地方"。
          hint: '界面上会自动弹出激活窗口，粘贴激活码即可；若没看到，请重启应用。',
          path: url.pathname,
        });
        return;
      }
    }

    // 授权查询：渲染层拿它决定"要不要弹激活引导"。
    if (url.pathname === '/api/license/status') {
      const g = licenseBridge();
      if (!g) { sendJson(200, { ok: true, wired: false, allowed: true, state: 'UNKNOWN', detail: '本机未接线' }); return; }
      try {
        const st = g.getStatus() || {};
        // ★ `allowed` 由**主进程**算好再给渲染层，不让渲染层自己按 state 枚举判。
        //   理由：哪些状态算"可以干活"是授权模块的产品决策（ALLOWED_STATES），
        //   在 UI 里再写一份枚举，两处迟早漂移 —— 而漂移的后果是"界面说能用、后端 402"。
        const allowed = (typeof g.isAllowed === 'function') ? !!g.isAllowed() : true;
        sendJson(200, Object.assign({ ok: true, wired: true, allowed }, st));
      } catch (e) {
        sendJson(200, { ok: false, wired: true, allowed: true, state: 'UNKNOWN', detail: String((e && e.message) || '') });
      }
      return;
    }

    // 本机机器码：报障时念给客服；也用于激活前自检"是不是这台机器"。
    if (url.pathname === '/api/license/machine') {
      try {
        const fpMod = require('./license/fingerprint');
        const fp = fpMod.computeFingerprint();
        sendJson(200, {
          ok: true,
          short: fpMod.shortCode(fp),
          strength: fp.strength,
          strong: fp.strong,
          missing: fp.missing,
        });
      } catch (e) {
        sendJson(200, { ok: false, short: '--------', strength: 0, strong: false, missing: [], detail: String((e && e.message) || '') });
      }
      return;
    }

    if (url.pathname === '/api/license/activate' && req.method === 'POST') {
      const g = licenseBridge();
      if (!g) { sendJson(503, { ok: false, code: 'NOT_WIRED', detail: '本机未接线，无法激活' }); return; }
      let body = '';
      try { body = await readBody(req); } catch { body = ''; }
      let code = '';
      try { code = String((JSON.parse(body || '{}') || {}).code || '').trim(); } catch { code = ''; }
      if (!code) { sendJson(400, { ok: false, code: 'EMPTY_CODE', detail: '请填写激活码' }); return; }
      try {
        const r = await g.activate(code);
        // 激活成功 ⇒ 立刻回一份新状态，渲染层不用再查一次（少一次竞态）。
        let st = {};
        try { st = g.getStatus(); } catch { st = {}; }
        sendJson(200, Object.assign({}, r, { status: st }));
      } catch (e) {
        sendJson(200, { ok: false, detail: String((e && e.message) || '激活失败') });
      }
      return;
    }

    if (url.pathname === '/api/chat') {
      // ★ 闸**不在这里**（2026-11-11 移走）。
      //   这里原有一条 402 判定，但它只管这一个分支 ⇒ `/api/chat-once` / `/api/llm/test`
      //   照样能白用 AI（端到端实测过，见本文件 LICENSE_BYPASS 上方那段）。
      //   现在判定统一在路由分发最前面的 `LICENSE_BYPASS` 白名单闸里，**唯一一处**。
      //   刻意不保留这条：两处判据必然漂移，而漂移时两边都能通过各自的门禁。
      handleChat(req, res, cfg, skills).catch((e) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // 断线重连：把一条新 SSE 接回仍在跑（或刚跑完、还在保留期）的任务，按 seq 补发历史事件。
    // 与 /api/chat 的关键差别：不新建任务、不重发请求，只「接上」已有任务的事件流。
    if (url.pathname === '/api/chat/resume' && req.method === 'POST') {
      let p = {};
      try { p = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 body 当作从头补发 */ }
      const s = taskStream.get(p.taskId);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // ★ 2026-11-04：同上 —— 显式 `*` 会压过 applyLocalCors 的回显，删掉交给统一闸。
      });
      if (!s) {
        res.write('data: ' + JSON.stringify({ type: 'resume_error', error: '任务已结束或超出保留时间，结果请看任务记录' }) + '\n\n');
        res.end();
        return;
      }
      res.on('close', () => { try { taskStream.detach(s, res); } catch { /* ignore */ } });
      taskStream.attach(s, res, p.fromSeq);
      return;
    }

    // 后台任务清单：前端刷新后据此显示「有个任务还在后台跑，接回来」。
    if (url.pathname === '/api/chat/active' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tasks: taskStream.listActive() }));
      return;
    }

    // 文案合规预检（发稿前的医疗广告红线自查）：纯本地规则，不发网络请求，断网也能用。
    if (url.pathname === '/api/compliance/check' && req.method === 'POST') {
      let p = {};
      try { p = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 body 当作空文案 */ }
      const r = compliance.checkText(typeof p.text === 'string' ? p.text : '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }

    if (url.pathname === '/api/chat-once' && req.method === 'POST') {
      handleChatOnce(req, res, cfg).catch((e) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
      return;
    }

    // 诊断端点：一键验证 LLM 模型网关连通性与 key 是否有效（供设置页「测试 AI 连接」）。
    if (url.pathname === '/api/llm/test' && req.method === 'POST') {
      let p = {};
      try {
        p = JSON.parse((await readBody(req)) || '{}');
      } catch {
        /* 空 body 忽略 */
      }
      const apiKey = typeof p.apiKey === 'string' ? p.apiKey : cfg.apiKey;
      const baseURL = normalizeBaseURL(typeof p.baseURL === 'string' ? p.baseURL : cfg.baseURL);
      const model = typeof p.model === 'string' ? p.model : cfg.model;
      const upstreamURL = baseURL.replace(/\/+$/, '') + '/chat/completions';
      const t0 = Date.now();
      try {
        const up = await fetch(upstreamURL, {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: '只回复两个字：在线' }],
            stream: false,
            max_tokens: 8,
          }),
        });
        const text = await up.text();
        const latencyMs = Date.now() - t0;
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        if (up.status === 401 || up.status === 403) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, status: up.status, error: '鉴权失败（401/403）：网关要求有效 Token，请填写 API Key', latencyMs }));
          return;
        }
        if (!up.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, status: up.status, error: '网关返回 HTTP ' + up.status + (json && json.error && json.error.message ? '：' + json.error.message : ''), latencyMs }));
          return;
        }
        const reply = json && json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, model, baseURL, reply: String(reply).slice(0, 50), latencyMs }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '无法连接模型网关：' + (e.name === 'AbortError' ? '请求超时' : e.message), latencyMs: Date.now() - t0 }));
      }
      return;
    }

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skills: skills.length }));
      return;
    }

    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const patch = {};
          if (typeof body.baseURL === 'string') patch.baseURL = body.baseURL;
          if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey;
          if (typeof body.model === 'string') patch.model = body.model;
          if (typeof body.enableSearch === 'boolean') patch.enableSearch = body.enableSearch;
          if (typeof body.asrApiKey === 'string') patch.asrApiKey = body.asrApiKey;
          if (typeof body.ttsApiKey === 'string') patch.ttsApiKey = body.ttsApiKey;
          if (typeof body.wxAppId === 'string') patch.wxAppId = body.wxAppId;
          if (typeof body.wxAppSecret === 'string') patch.wxAppSecret = body.wxAppSecret;
          if (typeof body.shopBaseURL === 'string') patch.shopBaseURL = body.shopBaseURL;
          if (typeof body.shopAccount === 'string') patch.shopAccount = body.shopAccount;
          if (typeof body.shopPassword === 'string') patch.shopPassword = body.shopPassword;
          if (typeof body.shopApiKey === 'string') patch.shopApiKey = body.shopApiKey;
          if (typeof body.shopProductUrl === 'string') patch.shopProductUrl = body.shopProductUrl;
          if (typeof body.shopOrderUrl === 'string') patch.shopOrderUrl = body.shopOrderUrl;
          // 上游货源商城（supplier.example.com）：独立 mmm* 命名空间，与 shop* 分开写盘
          if (typeof body.mmmBaseURL === 'string') patch.mmmBaseURL = body.mmmBaseURL;
          if (typeof body.mmmAccount === 'string') patch.mmmAccount = body.mmmAccount;
          if (typeof body.mmmPassword === 'string') patch.mmmPassword = body.mmmPassword;
          if (typeof body.mmmApiKey === 'string') patch.mmmApiKey = body.mmmApiKey;
          if (typeof body.geoBaseURL === 'string') patch.geoBaseURL = body.geoBaseURL;
          if (typeof body.geoAccount === 'string') patch.geoAccount = body.geoAccount;
          if (typeof body.geoPassword === 'string') patch.geoPassword = body.geoPassword;
          if (typeof body.geoApiKey === 'string') patch.geoApiKey = body.geoApiKey;
          // 检索 key 仅接受写入（不回显）：GET /api/config 不返回它们，避免泄漏到渲染层。
          if (typeof body.tavilyApiKey === 'string') patch.tavilyApiKey = body.tavilyApiKey;
          if (typeof body.bochaApiKey === 'string') patch.bochaApiKey = body.bochaApiKey;
          // 看图模型：允许设置/清空（空串 = 回落到默认视觉模型）
          if (typeof body.visionModel === 'string') patch.visionModel = body.visionModel;
          const merged = saveConfig(dataDir, patch);
          Object.assign(cfg, merged);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      // GET：返回完整配置（含语音 key 与商城配置，供设置界面回显）
      // 检索 key（tavily/bocha）**绝不回显原文**，只回传布尔状态供设置界面显示「已配置/未配置」。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: cfg.model, baseURL: cfg.baseURL, apiKey: cfg.apiKey, enableSearch: cfg.enableSearch, asrApiKey: cfg.asrApiKey, ttsApiKey: cfg.ttsApiKey, wxAppId: cfg.wxAppId || '', wxAppSecret: cfg.wxAppSecret || '', shopBaseURL: cfg.shopBaseURL || '', shopAccount: cfg.shopAccount || '', shopPassword: cfg.shopPassword || '', shopApiKey: cfg.shopApiKey || '', shopProductUrl: cfg.shopProductUrl || '', shopOrderUrl: cfg.shopOrderUrl || '', mmmBaseURL: cfg.mmmBaseURL || '', mmmAccount: cfg.mmmAccount || '', mmmPassword: cfg.mmmPassword || '', mmmApiKey: cfg.mmmApiKey || '', geoBaseURL: cfg.geoBaseURL || '', geoAccount: cfg.geoAccount || '', geoPassword: cfg.geoPassword || '', geoApiKey: cfg.geoApiKey || '', tavilyConfigured: !!cfg.tavilyApiKey, bochaConfigured: !!cfg.bochaApiKey, visionModel: cfg.visionModel || '' }));
      return;
    }

    // ---- 成果库：持久化产出的文件清单，供侧栏"成果"与"继续改"使用 ----
    if (url.pathname === '/api/deliverables' && req.method === 'GET') {
      const username = url.searchParams.get('username') || '';
      const items = readDeliverables(username).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items }));
      return;
    }
    if (url.pathname === '/api/deliverables' && req.method === 'DELETE') {
      const username = url.searchParams.get('username') || '';
      const target = url.searchParams.get('path') || '';
      // 只删当前用户自己的记录，其他账号的成果保留
      const items = readDeliverables().filter((d) => !(d.owner === username && d.path === target));
      writeDeliverables(items);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/deliverables/clear' && req.method === 'POST') {
      const username = url.searchParams.get('username') || '';
      // 只清当前用户的成果，其他账号的成果保留
      const remaining = readDeliverables().filter((d) => d.owner !== username);
      writeDeliverables(remaining);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ---- token 用量查询（登录后看自己用了多少）----
    if (url.pathname === '/api/usage' && req.method === 'GET') {
      const username = url.searchParams.get('username') || '';
      const u = readUsage();
      const mine = (u.byUser && u.byUser[username]) || { total: 0, prompt: 0, completion: 0, calls: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: u.total, prompt: u.prompt, completion: u.completion, calls: u.calls, mine }));
      return;
    }

    // ---- 登录系统：后端代理转发到自建后端，避免 app:// 页面跨域 CORS ----
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: '请求格式错误' }));
        return;
      }
      const username = String(body.username || '');
      const password = String(body.password || '');
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: '请输入账号和密码' }));
        return;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const upstream = await fetch(DOUYA_BASE_URL + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 豆芽AI 客户端入口：显式带 client:'douya'，让后端按「客户端」入口分流
          body: JSON.stringify({ username, password, client: 'douya' }),
          signal: ctrl.signal,
        });
        const text = await upstream.text();
        let json;
        try { json = JSON.parse(text); } catch { json = { detail: text || '登录失败' }; }
        // 登录成功：把 access_token 注入 doudou-ai 连接器，GEO 代理直接复用，
        // 免去用户在设置里再填一遍豆芽账号密码（同一后端、同一 token）。
        // 给 24h 有效期（登录态 token 通常更长；过期后 GEO 会提示重新登录）。
        if (json && json.access_token) {
          connectorMgr.injectToken('doudou-ai', json.access_token, Date.now() + 24 * 60 * 60 * 1000);
          // 同时给主进程留一份：用量上报需要长期有效的凭证（连接器那份 24h 就过期了）
          rememberAuthToken(json.access_token);
          // ★ 2026-11-06 产物隔离：把「当前账号」记下来 —— 主进程据此派生
          //   生图/生视频/海报的落盘目录与 app:// 媒体授权根（见 accountScope.js 头注）。
          //   dataDir 就取 authTokenPath 的同级目录（`startBackend` 里同一个 dataDir 派生的）。
          try {
            const okWrite = accountScope.writeAccount(path.dirname(authTokenPath), json.user || {});
            // 记账失败不影响登录（下一行注释同理）；但**写成功**才通知，避免拿一个空账号去切目录。
            if (okWrite) notifyAccountChange(json.user || {});
          } catch { /* 记账失败不影响登录 */ }
        }
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: '无法连接登录服务器' }));
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    if (url.pathname === '/api/auth/profile' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (!token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: '缺少 token' }));
        return;
      }
      // ★★ 2026-11-06 修：这里原来在 fetch **之前**就 `rememberAuthToken(token)`。
      //   症状（实测，不是推测）：任何本机调用方拿一个假 token 打一次本接口，
      //   `auth-token.json` 就被覆盖成那个假值 —— 我用 `rc5-bogus-token-abc123` 打了一次，
      //   文件 mtime 立刻变了，最后是从渲染层 leveldb 里把真值扒回来的。
      //   为什么这事不容易被发现：这个文件唯一的消费者是**用量上报**（scheduleUsageFlush），
      //   假 token 只会让上报 401 ⇒ 静默失败 ⇒ 统计少了也没人报错。**不影响主功能，
      //   但错值静默写入 + 随后静默失败，是事后最难查的一类。**
      //   修法：挪到上游**认可**之后，判据与紧邻的 writeAccount 同一个口径（有 username）；
      //   两件事（记 token / 记账号）用同一个"这 token 有效"的定义，避免同一问题两种判法。
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const upstream = await fetch(DOUYA_BASE_URL + '/api/profile', {
          headers: { Authorization: 'Bearer ' + token },
          signal: ctrl.signal,
        });
        const text = await upstream.text();
        let json;
        try { json = JSON.parse(text); } catch { json = { detail: text || '校验失败' }; }
        // ★ 2026-11-06 产物隔离：渲染层每次启动都会带 token 来校验，校验成功时
        //   `json` 本身就是 `{id, username, role}` ⇒ 顺手把「当前账号」记下来。
        //   为什么这条必不可少：只靠 login 记账的话，「记住登录态、没重新登录」的用户
        //   每次启动都会被当成未登录（产物目录退回 anon 桶 ⇒ 作品看着像丢了）。
        //   注意：上游失败时 json 是 `{detail:...}`，没有 username ⇒ writeAccount 返回 false，
        //   不会把已有的正确账号擦掉（见 accountScope.writeAccount 的空名分支）。
        try {
          const okWrite = accountScope.writeAccount(path.dirname(authTokenPath), json || {});
          if (okWrite) notifyAccountChange(json || {});
        } catch { /* 记账失败不影响校验结果 */ }
        // ★★ 2026-11-06：token 只在**上游认可**之后才落盘（判据同上面的 writeAccount：
        //   有 username 才算这个 token 真的有效）。放在这里还有一个附带好处：
        //   上游明确否定（401）时不会把已有的好凭证冲掉 —— 用户 token 过期不等于是坏凭证，
        //   那是"该重新登录"，而把文件清空/写坏连重新登录都没得救。
        //   ⚠️ 不写 else 分支去"清理"：401 之后保留旧值是对的（旧的至少能跑完积压上报）。
        if (upstream.ok && json && json.username) rememberAuthToken(token);
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: '无法连接登录服务器' }));
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    // ---- 语音识别（火山引擎 REST → Windows SAPI 兜底） ----
    if (url.pathname === '/api/speech-recognize' && req.method === 'POST') {
      try {
        const pcmData = await readBodyBuffer(req);
        if (!pcmData || pcmData.length < 800) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '录音太短，请重新尝试' }));
          return;
        }

        let text = '';
        let lastError = '';

        // 方案一：火山引擎豆包语音识别
        if (cfg.asrApiKey) {
          try {
            text = await volcanoRecognizeREST(cfg.asrApiKey, Buffer.from(pcmData));
          } catch (e) { lastError = e.message; }
        }

        // 方案二：Windows 本地 SAPI 兜底
        if (!text) {
          const sapiResult = await runSapiRecognize(6);
          if (sapiResult) {
            text = sapiResult;
            lastError = ''; // SAPI 成功就不报错
          }
        }

        if (text) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: lastError || '未识别到语音内容',
            hint: '请在火山引擎控制台开通"语音识别大模型"服务，或确认 Windows 语音识别已安装（设置→语言→中文→语音识别）',
          }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ---- 专家路由 ----
    if (url.pathname === '/api/experts' && req.method === 'GET') {
      handleExpertsList(res);
      return;
    }
    const expertDetail = url.pathname.match(/^\/api\/experts\/([^/]+)$/);
    if (expertDetail && req.method === 'GET') {
      // ★ 2026-11-04：`decodeURIComponent` 在 `async` 请求处理器里**同步抛出** = unhandledRejection
      //   ⇒ 纯 Node 承载时（Node ≥ 15）整个后端退出（`GET /api/experts/%` 就能打死它，实测）。
      //   与 `/api/skills/:id/run` 同一类洞，判据一致：解不出就当坏 id，给 400。
      let expertId = '';
      try { expertId = decodeURIComponent(expertDetail[1]); } catch { expertId = ''; }
      if (!expertId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad expert id' }));
        return;
      }
      handleExpertDetail(res, expertId);
      return;
    }

    // ---- 技能路由 ----
    if (url.pathname === '/api/skills' && req.method === 'GET') {
      handleSkillsList(res, skills);
      return;
    }
    const skillRun = url.pathname.match(/^\/api\/skills\/([^/]+)\/run$/);
    if (skillRun && req.method === 'POST') {
      // ★ 必须接住：请求处理器是 async，同步抛出会变成 unhandledRejection。
      //   纯 Node 承载时 Node ≥15 直接退出整个后端（实测 /api/skills/%/run 就能打死它）。
      handleSkillRun(req, res, skills, skillRun[1]).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'skill-run-failed', message: e.message }));
        } else {
          try { res.end(); } catch { /* 已结束 */ }
        }
      });
      return;
    }

    // ---- 用户叫停：置 aborted=true（并唤醒该任务正等待的闸门），立刻停止后续模型调用/技能执行 ----
    if (url.pathname === '/api/abort' && req.method === 'POST') {
      readBody(req).then((raw) => {
        let p = {}; try { p = JSON.parse(raw); } catch {}
        const found = abortTask(String(p.taskId || ''), 'user');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, found }));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // ---- 工作流确认门：用户确认后由后端执行待确认动作 ----
    if (url.pathname === '/api/exec' && req.method === 'POST') {
      readBody(req).then((raw) => {
        let p = {}; try { p = JSON.parse(raw); } catch {}
        const entry = pendingActions.get(p.id);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'action not found or expired' }));
          return;
        }
        pendingActions.delete(p.id);
        // ★★ 2026-11-04【P0 安全修复】allow 与 remember **都**严格布尔（fail-closed）：
        //   只有前端明确传 `true` 才算许可 / 才算勾选，其余一律视为「未许可 / 未勾选」。
        //
        //   修前 `allow` 写的是 `p.allow !== false` ⇒ 缺字段、字符串 "false"、数字 0、
        //   乃至 {} 全都被判成**允许**。方向反了：这是一条「用户点了同意才动手」的通道，
        //   它的缺省值必须是**拒绝**，不是允许。同一个对象里 `remember` 早就是 `=== true`，
        //   `allow` 是唯一反向的那个 —— 更像笔误而不是设计。
        //
        //   为什么这不是理论风险：`/api/exec` 是**本机 HTTP 接口**（127.0.0.1:<PORT>），
        //   不是 Electron IPC，任何本机进程都能 POST 它；渲染进程一次意外的空 body，
        //   若命中一个尚未应答的 action id，就等于替用户点了同意。
        //   实测（scripts/smoke/unit-exec-allow-strict.mjs，改前读数 12/3）：
        //     {id}                    ⇒ ssh-exec **真的执行了**（技能调用数=1）
        //     {id, allow:"false"}     ⇒ 真的执行了
        //     {id, allow:0}           ⇒ 真的执行了
        //   改后三条都变成「技能调用 0 次」，而 {id, allow:true} 仍然是 1 次（反向对照），
        //   所以那三个 0 是判据拒绝，不是技能跑不起来。
        //
        //   ⚠️ 注意 `{}`（连 id 都没有）走的是**另一条防线**：更上面的
        //      `pendingActions.get(undefined)` 判 404，跟这一行无关。两条别混为一谈 ——
        //      「删掉 allow 这一行」和「改对 allow 这一行」在空 body 上读数完全一样。
        entry.resolve({ allow: p.allow === true, remember: p.remember === true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // ---- 素材索要：用户提交素材内容后继续 Agent 循环 ----
    if (url.pathname === '/api/material' && req.method === 'POST') {
      readBody(req).then((raw) => {
        let p = {}; try { p = JSON.parse(raw); } catch {}
        const entry = pendingMaterials.get(p.id);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'material request not found or expired' }));
          return;
        }
        pendingMaterials.delete(p.id);
        entry.resolve(p.content != null ? String(p.content) : '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // ---- 需求澄清：用户回答澄清问题后继续 Agent 循环 ----
    if (url.pathname === '/api/clarify' && req.method === 'POST') {
      readBody(req).then((raw) => {
        let p = {}; try { p = JSON.parse(raw); } catch {}
        const entry = pendingClarify.get(p.id);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'clarify request not found or expired' }));
          return;
        }
        pendingClarify.delete(p.id);
        entry.resolve(p.answer != null ? String(p.answer) : '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // ---- 计划确认：用户确认计划后继续 Agent 循环 ----
    if (url.pathname === '/api/plan-ack' && req.method === 'POST') {
      readBody(req).then((raw) => {
        let p = {}; try { p = JSON.parse(raw); } catch {}
        const entry = pendingPlanAck.get(p.id);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'plan-ack not found or expired' }));
          return;
        }
        pendingPlanAck.delete(p.id);
        entry.resolve(p.ack != null ? String(p.ack) : '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // ---- 本地文件选择：用户选完文件后回传路径，继续 Agent 循环 ----
    if (url.pathname === '/api/pick-files' && req.method === 'POST') {
      readBody(req).then((raw) => {
        let p = {}; try { p = JSON.parse(raw); } catch {}
        const entry = pendingPickFiles.get(p.id);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pick-files request not found or expired' }));
          return;
        }
        pendingPickFiles.delete(p.id);
        entry.resolve({ paths: Array.isArray(p.paths) ? p.paths : [] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // ---- 本地文件读取：GEO 向导「上传素材」用，读取文件内容返回文本 ----
    if (url.pathname === '/api/read-files' && req.method === 'POST') {
      readBody(req).then(async (raw) => {
        let p = {}; try { p = JSON.parse(raw); } catch {}
        const paths = Array.isArray(p.paths) ? p.paths.filter((x) => typeof x === 'string' && x.trim()) : [];
        if (paths.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'paths 不能为空' }));
          return;
        }
        const files = [];
        for (const fp of paths) {
          const name = path.basename(fp);
          try {
            const text = await resolveAttachments([{ path: fp, name }], skills, cfg);
            // 剥离 resolveAttachments 自动加的文件标签行。标签形态不止一种：
            //   · 文本/文档：「【文件：name】\n」
            //   · 图片视觉成功：「【文件：name】（图片｜豆芽已看到画面内容）\n」
            //   · 图片仅 OCR：「【文件：name】（图片｜画面内容未能解析，以下为图中文字识别结果）\n」
            // 故用正则匹配「【文件：name】」开头到首个换行整行，而不是写死字面量前缀。
            const labelRe = new RegExp('^【文件：' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '】[^\n]*\n');
            const content = labelRe.test(text) ? text.replace(labelRe, '') : text;
            files.push({ name, content });
          } catch (e) {
            files.push({ name, content: '', error: e.message });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, files }));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // ---- 连接器路由 ----
    if (url.pathname === '/api/connectors/types' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(connectorMgr.types()));
      return;
    }
    if (url.pathname === '/api/connectors' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(connectorMgr.list()));
      return;
    }
    // 连接 / 断开 / 测试（body: { id }）
    const connectorAction = url.pathname.match(/^\/api\/connectors\/([^/]+)\/(connect|disconnect|test)$/);
    if (connectorAction && req.method === 'POST') {
      // ★ 2026-11-04：同上 —— 裸 `decodeURIComponent` 在 async 处理器里同步抛出会打死整个后端。
      let connId = '';
      try { connId = decodeURIComponent(connectorAction[1]); } catch { connId = ''; }
      if (!connId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad connector id' }));
        return;
      }
      const action = connectorAction[2];
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const targetId = body.id || connId;
        let result;
        if (action === 'connect') result = await connectorMgr.connect(targetId);
        else if (action === 'disconnect') result = connectorMgr.disconnect(targetId);
        else result = await connectorMgr.test(targetId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    const authUrl = url.pathname.match(/^\/api\/connectors\/([^/]+)\/auth-url$/);
    if (authUrl && req.method === 'GET') {
      // ★ 2026-11-04：同上 —— 裸 `decodeURIComponent` 在 async 处理器里同步抛出会打死整个后端。
      let connId = '';
      try { connId = decodeURIComponent(authUrl[1]); } catch { connId = ''; }
      if (!connId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad connector id' }));
        return;
      }
      const r = connectorMgr.getAuthUrl(connId);
      if (!r) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'connector not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }
    if (url.pathname === '/api/connectors/callback' && req.method === 'GET') {
      const result = await connectorMgr.handleCallback(Object.fromEntries(url.searchParams));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildCallbackHtml(result.ok, result));
      return;
    }

    // ---- GEO 代理：renderer 无法跨域调自建后端，主进程转发（带 Bearer token）----
    if (url.pathname === '/api/geo-proxy' && req.method === 'POST') {
      let p;
      try {
        p = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
        return;
      }
      const token = await connectorMgr.getToken('doudou-ai');
      if (!token) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '登录已过期，请退出后重新登录' }));
        return;
      }
      const geoCfg = connectorMgr.getGeoConfig();
      const geoBaseURL = String(geoCfg.baseURL || DOUYA_BASE_URL).replace(/\/+$/, '');
      let path = String(p.path || '').trim();
      if (!path.startsWith('/')) path = '/' + path;
      const method = String(p.method || 'POST').toUpperCase();
      const reqBody = p.body && typeof p.body === 'object' ? p.body : {};
      // 本地兜底：自建后端后端未实现 /api/geo/media-contact（媒体留言）。
      // 直接在本机持久化留言（dataDir/media-contact.jsonl），返回 ok，避免 404，不丢用户消息。
      if (path === '/api/geo/media-contact') {
        try {
          const entry = {
            ts: new Date().toISOString(),
            media: reqBody.media,
            name: reqBody.name,
            contact: reqBody.contact,
            message: reqBody.message,
            company_id: reqBody.company_id || p.companyId || null,
          };
          require('fs').appendFileSync(
            require('path').join(dataDir, 'media-contact.jsonl'),
            JSON.stringify(entry) + '\n',
            'utf8',
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, saved: true }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '留言保存失败：' + e.message }));
        }
        return;
      }
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
      };
      // 租户上下文：把当前企业/项目/工作空间 id 作为头转发给自建后端。
      // 后端暂不支持也安全（会忽略未知头），为多租户能力接入铺路。
      if (p.companyId) headers['X-Company-Id'] = String(p.companyId);
      if (p.projectId) headers['X-Project-Id'] = String(p.projectId);
      if (p.workspaceId) headers['X-Workspace-Id'] = String(p.workspaceId);
      // 同时注入请求体（company_id/project_id/workspace_id）：后端能力接口读 body 做归属隔离，
      // 仅在调用方未显式传时注入，避免覆盖调用方显式指定的值。
      if (p.companyId && !reqBody.company_id) reqBody.company_id = String(p.companyId);
      if (p.projectId && !reqBody.project_id) reqBody.project_id = String(p.projectId);
      if (p.workspaceId && !reqBody.workspace_id) reqBody.workspace_id = String(p.workspaceId);
      // 企业内容上下文（四类知识 + 项目/任务/角色，contextBuilder 生成）：注入为 ai_context 字段，
      // 豆芽AI工作台能力接口读它作为 AI 分析的额外输入；后端暂不支持则忽略，不破坏现有调用。
      if (p.contextText && !reqBody.ai_context) reqBody.ai_context = String(p.contextText);
      let targetURL = geoBaseURL + path;
      let fetchOpts = { method, headers };
      // ===== GET/DELETE 的 query 拼装：三层防护，防止大字段把 URL 撑爆 =====
      //
      // 【线上事故（生产 nginx 日志实锤）】`GET /api/meimiaomiao/schedules` 的真实请求 URI
      // 长度 8189~8257 字符，nginx 请求行上限 8KB（默认 large_client_header_buffers），
      // 线上分布：200×50（后台页面，URL 短）/ 414×100（豆芽claw 客户端，URL 长）/ 401×11（人工探针）。
      // 重放验证：直连 :8000 → 401（到了 FastAPI）；经 nginx → 414 size=186（HTML 错误页，压根没到后端）。
      // 后果就是「后台配了双11提前购/嘉豪大会，客户端里一个都没有」——客户端永远拿不到档期数据。
      //
      // 根因就在下面这段：把**整个 reqBody**（含 contextBuilder 生成的 5~8KB 企业上下文 ai_context）
      // 百分号编码进 query。8KB 的 ai_context 进 URL，按定义就必然 414，不是偶发。
      //
      // ai_context 是 AI 分析类接口的入参，放进 GET query 没有任何意义，故：
      //  · ① GET/DELETE 显式排除 ai_context（本段）；
      //  · ② 单字段 > GET_QUERY_FIELD_MAX 字符 ⇒ 跳过该字段并告警；
      //  · ③ 整个 URL 仍 > GET_QUERY_TOTAL_MAX 字符 ⇒ 按「最长优先」确定性丢弃并告警汇总。
      // ⚠️ 只作用于 GET/DELETE 分支。POST 分支**必须**继续把 ai_context 放进 body ——
      //    那是 AI 接口的真实入参，在这里误伤会让一批 AI 功能静默失效（症状比 414 更难查）。
      const GET_QUERY_FIELD_MAX = 1500; // 单字段上限：超过说明这个值本来就不该进 URL
      const GET_QUERY_TOTAL_MAX = 3500; // 整条 URL 上限：给 nginx 8KB 请求行留足余量
      if (method === 'GET' || method === 'DELETE') {
        const qs = new URLSearchParams();
        const oversizeSkipped = [];
        for (const [k, v] of Object.entries(reqBody)) {
          if (v == null) continue;
          // ① 大字段白名单外的一律不进 URL（见上方事故说明）
          if (k === 'ai_context') continue;
          const str = Array.isArray(v) ? JSON.stringify(v) : String(v);
          // ② 单字段熔断：将来谁再加一个大字段，也不会把 URL 撑到 8KB
          if (str.length > GET_QUERY_FIELD_MAX) {
            oversizeSkipped.push(k + '(' + str.length + ' 字符)');
            continue;
          }
          qs.set(k, str);
        }
        if (oversizeSkipped.length) {
          console.warn('[geo-proxy] 已跳过超长 query 字段（>' + GET_QUERY_FIELD_MAX
            + ' 字符，塞进 URL 会被 nginx 414 拒掉）：' + oversizeSkipped.join('、'));
        }
        // ③ 总量熔断：按编码后长度「最长优先」丢弃，直到整条 URL ≤ GET_QUERY_TOTAL_MAX。
        // 确定性要求：长度降序 → 同长度按字段名升序，保证同样输入必然丢同样字段（否则测试会飘）。
        // 计量口径用**整条 URL**（base + path + query）而不是只算 query：nginx 限的是请求行，
        // 只卡 query 会出现「query 刚好 3500、URL 已经 3530」的漏网。
        const baseLen = targetURL.length + (targetURL.includes('?') ? 1 : 0);
        let q = qs.toString();
        if (baseLen + q.length > GET_QUERY_TOTAL_MAX) {
          const encLen = (k, v) => encodeURIComponent(k).length + 1 + encodeURIComponent(v).length;
          const order = [...qs.entries()]
            .map(([k, v]) => ({ k, v }))
            .sort((a, b) => (encLen(b.k, b.v) - encLen(a.k, a.v))
              || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
          const dropped = [];
          for (const e of order) {
            if (baseLen + q.length <= GET_QUERY_TOTAL_MAX) break;
            qs.delete(e.k);
            dropped.push(e.k);
            q = qs.toString();
          }
          if (dropped.length) {
            console.warn('[geo-proxy] query 仍超过 ' + GET_QUERY_TOTAL_MAX
              + ' 字符，按最长优先丢弃字段：' + dropped.join('、')
              + '（丢弃后 URL 长 ' + (baseLen + q.length) + '）');
          }
        }
        if (q) targetURL += (targetURL.includes('?') ? '&' : '?') + q;
      } else {
        fetchOpts.body = JSON.stringify(reqBody);
      }
      const ctrl = new AbortController();
      // **超时顺序必须是「渲染层先放弃，主进程后兜底」**。
      // 渲染层 api.js:GEO_PROXY_TIMEOUT_MS = 180s（可给用户一句人话「超时了」），
      // 主进程如果更短，就会先把自己的 fetch 掐断，渲染层只能收到一个
      // 「GEO 请求失败：请求超时」的半截结果 —— 长文案生成的表现正是「生一半就断了」。
      // 所以这里必须严格大于渲染层超时，留 60s 余量。
      const GEO_PROXY_TIMEOUT_MS_MAIN = 240000;
      const timer = setTimeout(() => ctrl.abort(), GEO_PROXY_TIMEOUT_MS_MAIN);
      try {
        const upstream = await fetch(targetURL, { ...fetchOpts, signal: ctrl.signal });
        const text = await upstream.text();
        /**
         * 把上游错误页压成一行人话：剥 HTML 标签 + 压掉连续空白 + 截断到 120 字符。
         *
         * 为什么必须有：JSON.parse 失败时（上游回的往往是 nginx 的 HTML 错误页），
         * 旧代码走 `error: text`，于是 `<html><head>...414 Request-URI Too Large...` 整段
         * 原样回吐给渲染层，最终会出现在用户可读的错误提示里。这条路径必须绝迹。
         */
        const toPlainSnippet = (s) => String(s == null ? '' : s)
          .replace(/<[^>]*>/g, ' ')          // 剥标签
          .replace(/&nbsp;/gi, ' ')          // 最常见实体，先转空格再压空白
          .replace(/\s+/g, ' ')              // 压连续空白（含换行）
          .trim()
          .slice(0, 120);
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          // 非 JSON body：status>=400 用「HTTP 码 + 去标签片段」，否则用去标签片段兜底，
          // 两条路径都不会把 HTML 原样漏给上层。
          const snip = toPlainSnippet(text);
          json = {
            ok: false,
            error: upstream.status >= 400
              ? ('HTTP ' + upstream.status + (snip ? ' ' + snip : ''))
              : (snip || ('HTTP ' + upstream.status)),
          };
        }
        // 414/431 一律翻成人话（nginx 的这两类响应常见 HTML body，即便是 JSON 也用固定文案更可读）。
        if (upstream.status === 414) {
          json = { ok: false, error: '请求参数过长（HTTP 414），已拒绝。请把上下文改用 POST 提交。' };
        } else if (upstream.status === 431) {
          json = { ok: false, error: '请求头过大（HTTP 431），已拒绝。' };
        }
        // ⚠️ 这句文案是另一个同事做现场判据用的**精确字符串**，一个字都不许改。
        if (upstream.status === 401) {
          json = { ok: false, error: '登录已过期，请退出后重新登录' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'GEO 请求失败：' + (e.name === 'AbortError' ? '请求超时' : e.message) }));
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    // ---- RSS 抓取代理：学习站稳定资讯源（主进程直连，规避渲染进程跨域/证书问题）----
    // 说明：不带任何 token，只做纯文本抓取。必须做 SSRF 防护：仅放行 http/https，
    // 禁止回环/内网/链路本地地址，且重定向目标也要重新校验，避免被 302 绕过。
    if (url.pathname === '/api/rss-fetch' && req.method === 'POST') {
      let p;
      try {
        p = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
        return;
      }
      const target = String((p && p.url) || '').trim();
      if (!target) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'RSS 地址不能为空' }));
        return;
      }
      /** 校验 URL 是否为可安全抓取的公网地址。 */
      const isSafeRssUrl = (raw) => {
        let u;
        try { u = new URL(raw); } catch { return false; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (!host) return false;
        if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
        if (host === '::1' || host === '::' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return false;
        const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (v4) {
          const a = Number(v4[1]);
          const b = Number(v4[2]);
          if (a === 127 || a === 10 || a === 0) return false;
          if (a === 192 && b === 168) return false;
          if (a === 172 && b >= 16 && b <= 31) return false;
          if (a === 169 && b === 254) return false;
          if (a >= 224) return false;
        }
        return true;
      };
      if (!isSafeRssUrl(target)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '不允许抓取的地址' }));
        return;
      }
      const RSS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
      try {
        let current = target;
        let finalRes = null;
        for (let hop = 0; hop < 3; hop += 1) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 12000); // RSS 源必须快，超时即失败，不拖慢学习站
          let r;
          try {
            r = await fetch(current, {
              method: 'GET',
              redirect: 'manual',
              signal: ctrl.signal,
              headers: {
                'User-Agent': RSS_UA,
                Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
              },
            });
          } finally {
            clearTimeout(timer);
          }
          if (r.status >= 300 && r.status < 400) {
            const loc = r.headers.get('location');
            if (!loc) { finalRes = r; break; }
            let next = '';
            try { next = new URL(loc, current).toString(); } catch { next = ''; }
            if (!next || !isSafeRssUrl(next)) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: '不允许抓取的地址（重定向）' }));
              return;
            }
            current = next;
            continue;
          }
          finalRes = r;
          break;
        }
        if (!finalRes) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'RSS 请求失败：重定向过多' }));
          return;
        }
        const text = await finalRes.text();
        if (!finalRes.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'RSS 源返回 HTTP ' + finalRes.status }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text: text || '', url: current, status: finalRes.status }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'RSS 抓取失败：' + (e.name === 'AbortError' ? '超时（12s）' : e.message) }));
      }
      return;
    }

    // ---- 中华医学期刊网（*.yiigle.com / medjournals.cn）当期目录抓取 ----
    // 为什么必须另开一条、不能复用上面的 /api/rss-fetch（2026-10-20 实测）：
    //   ① **必须有 cookie jar**。不带 cookie 请求当期目录页时，链路是
    //        zhkqyxzz.yiigle.com/CN…/index.htm → 302 → casmp.yiigle.com/login?service=…
    //        → 302 → 回 zhkqyxzz.yiigle.com/CN… → 302 → 又去 casmp 登录页 …… 无限循环
    //        （curl 直接报 `(47) Maximum (50) redirects followed`）。
    //      带上第 1 跳下发的 AWSALB / AWSALBTG / JSESSIONID 之后，同样的请求第 3 跳即 200，
    //      拿到 84KB 整页、22 篇文章。而 /api/rss-fetch 是**无状态逐跳**抓取（跨跳不携带 cookie），
    //      结构上永远拿不到这两站的内容 —— 所以这里必须有 jar。
    //   ② 域名要收紧：rss-fetch 对全网公网开放（RSS 源本来就散落各处），
    //      而这里只允许中华医学期刊网的域名，SSRF 面比 rss-fetch 更小。
    // 返回语义与 rss-fetch 完全一致：{ ok:true, text, url, status } / { ok:false, error }。
    if (url.pathname === '/api/journal-issue' && req.method === 'POST') {
      let p;
      try {
        p = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
        return;
      }
      const target = String((p && p.url) || '').trim();
      if (!target) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '期刊地址不能为空' }));
        return;
      }
      /** 期刊站域名白名单（写死，不再接受任意公网地址）。 */
      const JOURNAL_HOST_SUFFIXES = ['yiigle.com', 'medjournals.cn'];
      /** 只放行中华医学期刊网自己的域名。 */
      const isJournalUrl = (raw) => {
        let u;
        try { u = new URL(raw); } catch { return false; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (!host) return false;
        return JOURNAL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix));
      };
      if (!isJournalUrl(target)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: '只允许抓取中华医学期刊网（*.yiigle.com / medjournals.cn）',
        }));
        return;
      }

      const JOURNAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

      /** 简易 cookie jar：`域名\0name` → value。跨跳携带，这是本站能抓到内容的唯一前提。 */
      const jar = new Map();
      /** 取出该主机该带上的 cookie（同域 + 父域下发都带）。 */
      const cookiesFor = (hostname) => {
        const h = String(hostname || '').toLowerCase();
        const out = [];
        jar.forEach((value, key) => {
          const sep = key.indexOf('\u0000');
          if (sep <= 0) return;
          const domain = key.slice(0, sep).replace(/^\./, '');
          const name = key.slice(sep + 1);
          if (h === domain || h.endsWith('.' + domain)) out.push(name + '=' + value);
        });
        return out.join('; ');
      };
      /** 读取响应的 Set-Cookie 列表（Node/undici 新老版本的三条路径都试一遍）。 */
      const readSetCookies = (r) => {
        try {
          if (typeof r.headers.getSetCookie === 'function') {
            const arr = r.headers.getSetCookie();
            if (Array.isArray(arr) && arr.length) return arr;
          }
        } catch { /* 老版本没有 getSetCookie，走下面的兜底 */ }
        try {
          const raw = typeof r.headers.raw === 'function' ? r.headers.raw()['set-cookie'] : null;
          if (Array.isArray(raw) && raw.length) return raw;
        } catch { /* 忽略 */ }
        const single = r.headers.get('set-cookie');
        return single ? String(single).split(/,(?=\s*[\w-]+=)/) : [];
      };
      /** 把响应的 cookie 收进 jar（按**收到它的那个主机**归属）。 */
      const absorbCookies = (r, hostname) => {
        readSetCookies(r).forEach((line) => {
          const pair = String(line).split(';')[0] || '';
          const eq = pair.indexOf('=');
          if (eq <= 0) return;
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          if (!name) return;
          jar.set(String(hostname || '').toLowerCase() + '\u0000' + name, value);
        });
      };

      const hops = [];
      try {
        let current = target;
        let finalRes = null;
        // 实测需要 3 跳（目录页 → CAS → 回目录页）；留到 6 跳以容忍多做一次会话初始化。
        for (let hop = 0; hop < 6; hop += 1) {
          const hopUrl = new URL(current);
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 12000);
          let r;
          try {
            const cookieHeader = cookiesFor(hopUrl.hostname);
            r = await fetch(current, {
              method: 'GET',
              redirect: 'manual',
              signal: ctrl.signal,
              headers: {
                'User-Agent': JOURNAL_UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                ...(cookieHeader ? { Cookie: cookieHeader } : {}),
              },
            });
          } finally {
            clearTimeout(timer);
          }
          absorbCookies(r, hopUrl.hostname);
          hops.push({ hop, status: r.status, url: current });
          if (r.status >= 300 && r.status < 400) {
            const loc = r.headers.get('location');
            if (!loc) { finalRes = r; break; }
            let next = '';
            try { next = new URL(loc, current).toString(); } catch { next = ''; }
            if (!next || !isJournalUrl(next)) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: false,
                error: '不允许抓取的地址（重定向到站外）',
                url: next,
                hops,
              }));
              return;
            }
            current = next;
            continue;
          }
          finalRes = r;
          break;
        }
        if (!finalRes) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: '期刊抓取失败：重定向过多（站点没有接受本次会话 cookie）',
            hops,
          }));
          return;
        }
        const text = await finalRes.text();
        if (!finalRes.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: '期刊页返回 HTTP ' + finalRes.status,
            url: current,
            hops,
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text: text || '', url: current, status: finalRes.status, hops }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: '期刊抓取失败：' + (e && e.name === 'AbortError' ? '超时（12s）' : (e && e.message) || '未知错误'),
          hops,
        }));
      }
      return;
    }

    // ---- 真实联网检索代理：直连第三方搜索 API（tavily/bocha），规避渲染层跨域并把 key 留在主进程 ----
    if (url.pathname === '/api/web-search' && req.method === 'POST') {
      handleWebSearch(req, res, cfg).catch((e) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(JSON.stringify({ ok: false, provider: 'none', elapsedMs: 0, results: [], error: e.message }));
      });
      return;
    }

    // ---- 公关危机本地爬虫：品牌词 + 平台定向搜负面（不经过豆芽工作台，本地直连百度）----
    // 主数据源是前端的 LLM 联网检索，这里只作为「爬虫证据」补充；被反爬/超时即标记 blocked 走降级。
    if (url.pathname === '/api/crisis/scan-local' && req.method === 'POST') {
      let p;
      try {
        p = JSON.parse((await readBody(req)) || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
        return;
      }
      const brand = String((p && p.brand) || '').trim();
      if (!brand) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '品牌词不能为空' }));
        return;
      }
      const platforms = Array.isArray(p && p.platforms) && p.platforms.length
        ? p.platforms.filter((k) => PLATFORM_SOURCES[k])
        : Object.keys(PLATFORM_SOURCES);
      const maxPer = Number(p && p.maxPer) > 0 ? Math.min(Number(p.maxPer), 20) : 5;

      // 节流：同一品牌 30s 内不重复打百度（实测连续请求会被反爬拦截）
      const now = Date.now();
      const lastAt = crisisScanThrottle.get(brand) || 0;
      if (now - lastAt < CRISIS_THROTTLE_MS) {
        const waitSec = Math.ceil((CRISIS_THROTTLE_MS - (now - lastAt)) / 1000);
        // 【诚实红线】被节流 = 本次**根本没有扫描**，绝不许可返回 ok:true —— 否则调用方/模型会把
        // 「没扫」误当成「扫完了、很干净」（这是假绿，比报错更糟）。显式 ok:false + throttled:true +
        // retry_after_ms，并给出能让模型看懂「这是被节流、不是舆情干净」的文案。
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          throttled: true,
          retry_after_ms: Math.max(0, CRISIS_THROTTLE_MS - (now - lastAt)),
          brand,
          results: [],
          scanned: 0,
          all_blocked: true,
          error: `本次未扫描：同一品牌 30 秒内只允许扫一次（百度反爬节流），请 ${waitSec} 秒后重试。注意：这不是「没有舆情」，而是根本没扫。`,
        }));
        return;
      }
      crisisScanThrottle.set(brand, now);

      const startedAt = Date.now();
      const results = [];
      for (let i = 0; i < platforms.length; i += 1) {
        const key = platforms[i];
        const cfg = PLATFORM_SOURCES[key];
        // 整体 60s 超时：超出后剩余平台直接标记 blocked，不再继续请求百度
        if (Date.now() - startedAt > 60000) {
          results.push({ platform: key, platformLabel: cfg.label, blocked: true, items: [], total: 0, negativeCount: 0 });
          continue;
        }
        if (i > 0) await crisisRandDelay(); // 平台之间随机延迟，防连续请求触发反爬
        const r = await scanBaiduPlatform(brand, key, cfg, maxPer);
        const items = Array.isArray(r.items) ? r.items : [];
        results.push({
          platform: key,
          platformLabel: cfg.label,
          blocked: !!r.blocked,
          items,
          total: items.length,
          negativeCount: items.filter((x) => x && x.negative).length,
        });
      }
      // 成功路径的诚实标注：scanned = 真正扫到数据的平台数；all_blocked = 全部平台都被反爬/超时挡下。
      // 即便全 blocked 也**保留 ok:true**（请求确实执行了、且结果里 blocked 标记如实），但额外给出
      // all_blocked 让调用方/模型一眼看出「这次什么都没扫到」，不把空结果当成「干净」。
      const scanned = results.filter((r) => !r.blocked).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, throttled: false, brand, results, scanned, all_blocked: scanned === 0 }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // 端口被占用（EADDRINUSE）时不再抛 Uncaught Exception 弹窗，改为友好提示并退出。
  // 常见诱因：另一个豆芽CLAW 实例、或开发时残留的本地 mock/node 进程占用了 10119。
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[Backend] 端口 ' + PORT + ' 已被占用，无法启动本地服务。');
      try {
        // 仅在 Electron 主进程环境下可 require electron
        const { dialog, app } = require('electron');
        dialog.showErrorBox(
          '豆芽CLAW 无法启动',
          '本地服务端口 ' + PORT + ' 已被占用。\n\n请关闭其他正在运行的豆芽CLAW 或相关后台进程（如残留的 Node 进程）后，重新打开本程序。'
        );
        app.quit();
      } catch (e) {
        // 非 Electron 环境（单元测试等）仅打印日志
      }
      return;
    }
    console.error('[Backend] server error:', err && err.message);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('[Backend] LLM proxy + skills + connectors + experts listening on http://127.0.0.1:' + PORT);
  });

  return server;
}

// maskSecrets / CONFIRM_TOOLS / confirmTargetKey 一并导出，供单测直接 require 断言（否则测试只能靠正则扒源码文本，
// 会被注释措辞变动假红）。它们都是纯函数/常量，导出不改变任何运行时行为。
// thinkSignals / decideThink（深度思考多信号判定）同理导出：纯函数、零副作用，供单测逐条断言判定表。
// getSkills/abortTask/buildTaskStateSummary（第一层内核）导出：getSkills 让主进程拿得到技能清单，
// abortTask/buildTaskStateSummary 供单测与主进程复用，均为纯查询/标记，不改变默认行为。
module.exports = { startBackend, getConfig, defaultConfig,
  // 2026-09-23：循环内上下文压缩的纯计算部分 + 压力判据，导出供单测直接断言
  // （否则测试只能用正则扒源码文本，扒不出「不拆散 tool_calls 配对」这种真正的不变量）
  planLoopCompress, shouldCompressInLoop, splitMessageGroups, compressContextInLoop, inLoopCompressEnabled,
  // 2026-11-06：工具结果免模型剪枝层。plan/prune 是纯函数，export 供单测直接断言；
  // ★ 为什么把 estimateTokens 一并导出：测试判据必须用**产品同口径**的 token 数，
  //   测试里再复制一份 `/1.5+4` 就是本仓明令禁止的「两条口径」（必然漂移，且漂移时两边都绿）。
  //   导出纯函数不改任何运行时行为。
  planToolResultPrune, pruneToolResults, toolResultPruneEnabled, estimateTokens,
  CTX_COMPRESS_FLOOR, CTX_COMPRESS_HARD_CAP, CTX_COMPRESS_SHARE, CTX_KEEP_RECENT_GROUPS, CTX_MIN_GROUPS, PRUNE_THRESHOLD_CHARS, PRUNE_HEAD_CHARS, PRUNE_TAIL_CHARS, PRUNE_MARK, runSapiRecognize, resolveAttachments, isReasoningContractError, hasReasoningLossyToolTurn, runAgentLoop, maskSecrets, CONFIRM_TOOLS, confirmTargetKey, authTierOf, needsUserConfirm, isAlwaysConfirm, isFailureResult, thinkSignals, decideThink, getSkills, abortTask, buildTaskStateSummary, readTaskRecords, addUsage, enqueueUsageReport, flushUsageReports, rememberAuthToken, loadUsageQueue, loadAuthToken, __usageTestSeam, __usageQueueSnapshot,
  // 2026-11-11：僵尸任务回收（修「跑不完」根因之二）。导出 reapDanglingRuns 是为了让门禁**真跑**它：
  // 造一条 status='running' 的记录进临时库 → 断言被改成 'interrupted' 且写回没碰别的记录。
  // 只 grep 源码里有没有 `status !== 'running'` 挡不住"写回时顺带覆盖了 done 记录"这种事故。
  // __taskStoreSeam 供门禁把 tasksPath 指向临时文件，运行时无人调用。
  reapDanglingRuns, __taskStoreSeam,
  // ★ 2026-11-11：落盘规范化（turnTrace 字段白名单）。导出是为了让门禁**真跑**它：
  //   `codeNew/codeUpd` 这类新字段一旦漏在白名单里，内存里判对了、落盘被裁成 0，
  //   事后复盘只看到 "progressed=false" —— 那正是"以为它在跑"的错觉。
  //   只 grep 源码里有没有 `codeNew` 挡不住这件事（写了但被放在裁剪之后照样丢）。
  //   纯函数、不读文件、不碰网络，导出不改任何运行时行为。
  trimTaskRecord,
  // ★ 2026-11-04：`POST /api/skills/:id/run` 需要能力令牌。导出读取器是为了让门禁/主进程
  //   能拿到**同一个**令牌（不导出就只能去猜文件路径，或扒源码常量）。
  getSkillRunToken: () => skillRunToken,
  // 2026-09-23：预算计量口径（修「干一半就跳超预算」的根因）+ 软阈值收尾
  computeTurnCost, BUDGET_WRAPUP_RATIO,
  // ===== 长期记忆（B 阶段 #252）：供 main.js 的 IPC 层直接读写档案 =====
  // ★ 为什么导出的是**这些**：
  //   · runMemoryTurn —— 供门禁端到端验证"一轮对话真的会落盘"（不导出就只能扒源码猜）
  //   · memoryEnabled / invalidateMemorySwitch —— 开关的真实生效点（设置页写完要立刻生效）
  //   · memoryDataDir 相关：暴露一个读取器，让 IPC 层不必自己猜 dataDir
  runMemoryTurn, memoryEnabled, invalidateMemorySwitch,
  getMemoryWritePath: () => ({ dataDir: memoryDataDir, settingsPath: desktopSettingsPath }),
  // ★ 2026-10-23【任务类型工作流】导出 startWorkflowRun 供门禁**端到端**验收。
  //   为什么要导出：老板第六节的要求是「backend.js 真正执行它」，而只断言"源码里出现过 selectWorkflow"
  //   等于用正则扒文本 —— 那证明不了识别、阶段推进、验收压终态这条链真的通。导出一个纯本地工厂
  //   （只读文件、不碰网络、不启动服务），门禁就能像调用真实入口一样把整条链跑一遍。
  //   它不改变任何运行时行为：runAgentLoop 内部用的是同一个函数。
  startWorkflowRun,
  // ★ 2026-10-24【产物保管】把 `custodyKeep` 与它的三个 `by` 枚举导出，供门禁**直接**钉住：
  //   · 拼错的 by 必须被硬拒（连事件都不落）—— 这条只能靠真调用验，扒源码文本证明不了；
  //   · 非 .pptx 必须放行为"不保管"且不留任何痕迹 —— 同上。
  //   导出不改变任何运行时行为：内部调用点用的是同一个函数。
  custodyKeep, CUSTODY_BY,
  // 运行底座 P1：导出**同一个** runtime 实例；门禁可 setImpl 注入替身，
  // 而 :2990 调用点用的正是它（不是另建一份）。
  agentRuntime,
  // ★ 2026-11-06 产物隔离：账号变更钩子的注册入口。
  //   导出的是"注册"而不是"设置账号"—— 账号由本文件的 login/profile 两处记账点写入，
  //   主进程（main.js）只负责在被通知时把产物目录与媒体授权根切过去。
  setAccountChangeHook,
};
