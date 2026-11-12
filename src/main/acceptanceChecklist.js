/**
 * 「4 号验收 Agent」结构化核对清单 —— 唯一真源。
 * ============================================================================
 * 这个文件回答一个问题：**一份交付，到底该判「达标 / 降级达标 / 失败 / 待优化」中的哪一个。**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（两个真实痛点，都来自老板实测）
 * ═══════════════════════════════════════════════════════════════════════════
 *  ① **死磕卡壳直接判失败**：遇到平台反爬 / 没账号 / 权限封锁这类**外部硬壁垒**时，
 *     执行方原地重试到轮次耗尽，最后交出一副「什么都没做成」。验收方看到的也是"没交付"，
 *     于是整个任务被判失败 —— 而实际上本来能交出保底版本（少一个功能 / 降一档规格）。
 *     正确形态是：**硬壁垒 ⇒ 按流程降级 ⇒ 降级后达标就算「降级达标」，不是失败。**
 *  ② **创作任务甩最简模板**：用户要一个能玩的小游戏 / 能看的页面，执行方交一份
 *     「能跑就行」的通用骨架，等着用户一条一条提需求。这**不是工作量问题，是交付形态问题**：
 *     没有设计推演、没有细节、甚至界面看着有但点不动。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计原则（三条，缺一条这个清单就会变成另一种形式主义）
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. **跟随当前生效目标等级，不拿主目标的标准去卡保底 / 临时目标。**
 *     ⇒ 每个核验项都声明它在哪个等级下适用（`levels`）。降级之后，只判**降级后仍适用**的项。
 *        这一条是「降级达标」能成立的技术前提：项目被降级了，却还拿主目标的项去卡它，
 *        那降级等于白降。
 *  2. **无证据不算合格（fail-closed）。** 判断类核验项必须带证据（文件路径 / 读数 / 复现路径），
 *     只写「已确认」而不给依据 ⇒ 判 `unknown`，不许算通过。
 *     本仓栽过太多次「判据自己没判别力」的坑 —— 一个永远能通过的断言不是验证，是摆设。
 *  3. **「不合格」不等于「整体失败」。** 用户明确区分了两件事：
 *     · 硬失败（3 条）：三层全无可交付 / 核心功能失效 / 造假壳子 / 无理由拒绝做推演；
 *     · 待优化：代码瑕疵、细节不足、漏写文档 ⇒ **打回执行方补**，不判失败。
 *     ⇒ 所以本文件给每个项标了 `hardWhen`，只有它对上号才升级成硬失败。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 一处口径必须说清（否则它会和运行时真值打架）
 * ═══════════════════════════════════════════════════════════════════════════
 *   清单里「同一动作重试 ≤ 3 次」是**验收判据的上界**（判执行方有没有死磕），
 *   **不是**运行时的重试预算。运行时真值更严：人设 §四 / toolProtocol 的 maxSameMethod=2
 *   ⇒ 同一做法**最多重试 1 次**，第 2 次失败必须换方法。
 *   两层不同层，故分别常量命名。**任何一处把 3 当成"允许重试 3 次"，都是把它读错了。**
 */
'use strict';

// ============================ 一、枚举 ============================

/**
 * 任务类型（前置核验第 1 项）。只有创作类启用第二组。
 *
 * ⚠️ 2026-11-03 补 RESEARCH：原来只有 dev / creative 两个值，而 5 号工单模板的分类
 * 标签是「普通开发 / 创作类 / 调研规则类」三档 —— 调研类任务传 `research` 进来会被
 * `normalizeTaskType` **静默归一成 dev**，于是清单给一个纯调研任务套上 G3-3「E2E 测试」，
 * 等于用打不开的门判它失败。归一不报错、报告里还写着「普通开发」，是最难查的那种错。
 *
 * 【research 走哪几组】只走 `scope:'always'`（G1 卡点/重试/降级/三层目标 + G4 交付物/
 * 噪音/报告三要素），**不进** creative 组（不产出 UI/游戏）也**不进** dev 组（不产出代码）。
 * 这是靠下面 itemApplies 的两条 scope 排除天然实现的，不新增分支 —— 一新增分支就有
 * 第二个真源。清单里目前没有 `scope:'research'` 的专属项，将来要加必须同时改 itemApplies。
 */
const TASK_TYPES = {
  DEV: 'dev',           // 普通开发：代码 / 接口 / 部署
  CREATIVE: 'creative', // 创作类：游戏 / 网页 / PPT / UI / 桌面宠物
  RESEARCH: 'research', // 调研/规则类：竞品调研、舆情规则、SOP、模板清单（不产代码/UI）
};

/** 当前生效目标等级（前置核验第 2 项）。 */
const GOAL_LEVELS = {
  MAIN: 'main',         // 主目标：用户明确要的那件事，原样交付
  FALLBACK: 'fallback', // 保底目标：少一个功能 / 降一档规格但仍能用
  TEMP: 'temp',         // 临时目标：代码产物都产不出来时的最后一档（报告 / SOP / 清单模板）
};

/** 验收结论四态（判定公式的输出）。 */
const ACCEPT_VERDICTS = {
  PASS: 'PASS',             // ✅ 达标
  DEGRADED: 'DEGRADED',     // ⚠️ 降级达标（硬壁垒 + 按流程降级 + 降级后各项通过）
  FAIL: 'FAIL',             // ❌ 失败（命中硬失败条件）
  TO_IMPROVE: 'TO_IMPROVE', // 📝 待优化（打回执行方补，不判失败）
};

/** 单项核验结果三态。注意 skip ≠ pass：跳过只是「这项不适用」，不能当成通过来凑数。 */
const ITEM_RESULTS = {
  PASS: 'pass',
  FAIL: 'fail',
  SKIP: 'skip',
  UNKNOWN: 'unknown', // 该核验但没给结论 / 给了「通过」却没给证据 ⇒ 不算通过
};

/**
 * 重试次数的**两层**口径（务必区分，见文件头 ⚠️）。
 *  - RUNTIME：运行时真值。toolProtocol.createRetryLedger 的 maxSameMethod 缺省 2，
 *    语义是「同一签名第 2 次失败必须升级」⇒ **只允许重试 1 次**。
 *  - ACCEPT：验收判据上界。同一动作重试超过这个次数还没停 ⇒ 判「死磕」。
 *    它比 RUNTIME 宽松，所以任何满足 RUNTIME 的执行必然也满足 ACCEPT —— 两层不会互相否定。
 */
const RETRY_LIMIT_RUNTIME = 1;
const RETRY_LIMIT_ACCEPT = 3;

/** 代码工程规范阈值（第三组）。 */
const MAX_SINGLE_FILE_LINES = 1200; // 超过就是"超大单体文件"，按职责拆分是底线
const ANY_ALLOWED = 0;              // 用户口径：严格模式 + 无 any

/**
 * 创作类「方案探索」的下限数量（第二组第 4 项）。
 *
 * 老板原话：「至少形成几个有实质区别的方案，而不是换颜色、换标题冒充多个方案。」
 * 取 2 而不是 3：两个才刚够「比较并取舍」这件事成立；要求 3 会把实现成本推高到
 * 模型宁可不做，而"没做"比"只做两版"更坏。
 */
const DESIGN_OPTIONS_MIN = 2;

/**
 * 判「两个方案是不是只换了个皮」的文本相似度上限（Jaccard，字符二元组）。
 *
 * ⚠️ 这**只是提示**，不参与判死（见 acceptanceReadings 的强/弱证据分层）：
 *   中文短段落天然高度重合（同一产品、同一技术栈，词一定大面积重叠），
 *   拿它判死必然误伤 —— 本仓在"关键词命中算不算证据"上已经栽过一次。
 *   0.86 取自实测：真正换皮的两个方案段普遍在 0.9 以上；而仅"用同一技术栈"的
 *   两个不同方案也常常到 0.7 左右，所以阈值必须明显高于后者。
 */
const DESIGN_OPTION_SIMILAR_MAX = 0.86;

/** 创作类「设计推演文档」必须覆盖的七个维度（第二组第 1 项）。 */
/**
 * 创作类任务的**子类型**。老板原话：「游戏 / 页面 / PPT / 可视化类生效」。
 *
 * 【为什么必须分开】修前只有一个笼统的 `creative`，于是设计推演只能查 7 个通用维度。
 * 而老板第 3 条给的专属细节是完全不同的东西：游戏要查「胜利判定、难度梯度」，
 * 网页要查「hover 反馈、移动端适配」，PPT 要查「信息层级、动画节奏」。
 * 拿通用维度去查，等于**没法查** —— 一个网页任务被问「胜利判定写了吗」是荒谬的。
 *
 * ⚠️ `visual` 是诚实回落，不是我自己编的：老板列了游戏/网页/PPT 三套维度，
 *    **没有给可视化专属维度**。所以 visual 只查通用 8 项，并在报告里写明
 *    「该类型未给专属维度，按通用清单核对」——不许假装查过。
 */
const CREATIVE_KINDS = {
  GAME: 'game',     // 游戏：机制 + 胜负 + 音效 + 美术 + 难度梯度
  WEB: 'web',       // 网页：配色 + 排版层次 + hover + 加载态 + 移动端 + 留白
  PPT: 'ppt',       // PPT：版式逻辑 + 配图建议 + 信息层级 + 动画节奏
  VISUAL: 'visual', // 可视化（含桌面宠物）：老板未给专属维度 ⇒ 只查通用项
};

/**
 * 通用设计维度（老板第 2 条逐字）：风格定位、交互思路、视觉方案、关卡/页面结构、
 * 细节彩蛋、状态分支、动效、反馈逻辑。
 *
 * ⚠️ 「关卡/页面结构」在老板原文里是一项（用斜杠并列），这里保持一项 ——
 *   拆成两项会让游戏任务被要求写「页面结构」、网页任务被要求写「关卡结构」，
 *   两边都缺一半，纯属自找误判。
 */
const DESIGN_DIMENSIONS_BASE = [
  '风格定位', '交互思路', '视觉方案', '关卡/页面结构', '细节彩蛋', '状态分支', '动效', '反馈逻辑',
];

/**
 * 类型专属细节维度（老板第 3 条逐字照抄）。
 * 这三套是**「细节主动补齐」的机械判据**：G2-2 原来只有一句「要主动补齐合理配套」，
 * 补没补全靠模型自己说；有了这三套，就能按类型逐项核对。
 */
const DESIGN_DIMENSIONS_BY_KIND = {
  [CREATIVE_KINDS.GAME]: ['失败反馈', '胜利判定', '音效提示', '界面美术风格', '难度梯度', '边界异常处理'],
  [CREATIVE_KINDS.WEB]: ['配色', '排版层次', 'hover 反馈', '加载状态', '移动端适配', '留白'],
  [CREATIVE_KINDS.PPT]: ['版式逻辑', '配图建议', '信息层级', '动画节奏'],
  [CREATIVE_KINDS.VISUAL]: [],
};

/**
 * 设计维度（旧常量，保留导出以防既有门禁/调用点断裂）。
 *
 * ⚠️ 新代码请用 `designDimensionsFor(kind)`。这个常量只是「通用 8 项」的别名，
 *   原来那 7 个粗维度（结构/反馈/边界/细节规划…）已经细化进 BASE，
 *   留着别名是因为 `acceptanceReadings` 与若干门禁都在 import 它。
 */
const DESIGN_DIMENSIONS = DESIGN_DIMENSIONS_BASE;

/**
 * 创作子类型归一。**按值遍历，不按值当键查** —— 这个坑在本仓已经踩过三次
 * （`GOAL_LEVELS[s]`、`TASK_TYPES[s]`），每次的症状都一样：归一不报错，
 * 一律回落到第一个值，然后整条过滤静默失效。
 *
 * 缺省回落 `VISUAL` 而不是 `GAME`/`WEB`：visual 的专属维度是空数组，
 * 只查通用 8 项 ⇒ **最不容易误伤**。标错类型的代价（拿游戏的「胜利判定」
 * 去卡一个网页任务）比少查几项严重得多。
 *
 * @param {string} v
 * @returns {string} CREATIVE_KINDS 之一
 */
function normalizeCreativeKind(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(CREATIVE_KINDS)) if (CREATIVE_KINDS[k] === s) return s;
  return CREATIVE_KINDS.VISUAL;
}

/**
 * 某类创作任务要核对的设计维度 = 通用 8 项 + 该类型专属项。
 *
 * 【单一真源】维度名字只在这里定义。`acceptanceReadings` 从这里取名字、
 * 自己配同义词去检测 —— 不许在那边再抄一份名字列表（抄一份就多一处会漂的地方）。
 *
 * @param {string} kind 创作子类型（会先归一）
 * @returns {{kind:string, base:string[], specific:string[], all:string[], hasSpecific:boolean,
 *            note:string}}
 */
function designDimensionsFor(kind) {
  const k = normalizeCreativeKind(kind);
  const base = DESIGN_DIMENSIONS_BASE.slice();
  const specific = (DESIGN_DIMENSIONS_BY_KIND[k] || []).slice();
  return {
    kind: k,
    base,
    specific,
    all: base.concat(specific),
    hasSpecific: specific.length > 0,
    // visual 没有专属维度是**老板没给**，不是我不查。报告里必须写明这一点，
    // 否则用户会以为「可视化类已经按专属标准核过了」。
    note: specific.length ? '' : '该子类型老板未给专属维度，只按通用 ' + base.length + ' 项核对',
  };
}


// ============================ 二、清单本体 ============================

/**
 * 每一项的字段约定：
 *   id         清单编号（报告里逐条引用它，别用中文长名当 key）
 *   group      1=降级与卡点 2=创作类专项 3=代码工程规范 4=交付物完整性
 *   label      给人看的一行标题
 *   scope      'always' | 'creative' | 'dev'      —— 决定这一项在哪种任务类型下启用
 *   levels     在哪些目标等级下适用（不写 = 三个等级都适用）
 *   kind       'mech'（可机械核验，读数由 acceptanceReadings 提供）| 'judge'（需判断，必须带证据）
 *   needsEvidence  判断项是否强制要求证据（true ⇒ 无证据的"通过"降级为 unknown）
 *   hardWhen   这一项判不合格时，什么情况下**升级成硬失败**（空 = 永远只是待优化）
 *   guide      验收员看到这一项该核验什么（同时是给用户看的判据说明）
 */
const CHECKLIST = [
  // ── 第一组：降级与卡点合规（防死脑筋、乱判失败）──
  {
    id: 'G1-1', group: 1, label: '卡点区分', scope: 'always', kind: 'judge', needsEvidence: true, hardWhen: null,
    guide: '是否把卡点分成两类：可修复缺陷（参数/路径/选择器写错）vs 外部硬壁垒（反爬、权限、账号、付费、风控）。'
      + '证据要给具体卡点原文（报错文本 / HTTP 状态 / 页面提示），不能只写"判断为硬壁垒"。',
  },
  {
    id: 'G1-2', group: 1, label: '重试次数', scope: 'always', kind: 'judge', needsEvidence: true, hardWhen: null,
    guide: '同一动作重试 >' + RETRY_LIMIT_ACCEPT + ' 次仍不停 ⇒ 不合格（判"死磕"）。'
      + '注：运行时上限更严（同一做法最多 ' + RETRY_LIMIT_RUNTIME + ' 次，见人设 §四）；'
      + '本项只判执行方有没有死磕，不重新定义重试预算。证据要给重试次数与对应的动作签名。',
  },
  {
    id: 'G1-3', group: 1, label: '降级流程合规', scope: 'always', kind: 'judge', needsEvidence: true, hardWhen: null,
    guide: '触发降级后必须同时满足四件事：① 目标等级已更新 ② 写明卡点原因 ③ 写明交付边界'
      + ' ④ 写明升级条件；落差大时还要问过用户。私自降级 / 不告知 / 不写升级路径 ⇒ 不合格。'
      + '另：有硬壁垒却仍留在主目标（死磕）、或没有硬壁垒却已降级（私自降级），都判不合格。',
  },
  {
    id: 'G1-4', group: 1, label: '三层目标兜底', scope: 'always', kind: 'judge', needsEvidence: true,
    hardWhen: 'nothing-at-all',
    guide: '主目标不可行 ⇒ 切保底；保底不可行 ⇒ 切临时（报告 / SOP / 清单模板）。'
      + '三层里还有可交付项就直接判整体失败 ⇒ 不合格。'
      + '只有**连一份能用的文档都给不出来**（reason=nothing-at-all）才升级为硬失败。',
  },

  // ── 第二组：创作类专项（防止直接甩最简模板）──
  {
    id: 'G2-1', group: 2, label: '设计推演文档', scope: 'creative', kind: 'judge', needsEvidence: true,
    hardWhen: 'refused-design',
    guide: '交付物必须附带独立的设计推演，通用 ' + DESIGN_DIMENSIONS_BASE.length + ' 项：'
      + DESIGN_DIMENSIONS_BASE.join(' / ') + '；再按创作子类型追加专属项（游戏/网页/PPT 各有，见清单 G2-2）。'
      + '★「最小可运行版本只是验证底座，不等于交付成果」—— 只交一份光秃秃的通用模板、空骨架、'
      + '样板 demo 来交差 ⇒ 不合格，哪怕它能跑。'
      + '若执行方**明确拒绝做推演**（reason=refused-design）⇒ 升级为硬失败；只是没做但愿意补 ⇒ 待优化。',
  },
  {
    id: 'G2-2', group: 2, label: '细节主动补齐', scope: 'creative', kind: 'judge', needsEvidence: true,
    hardWhen: 'refused-design',
    guide: '基础功能之外要主动补齐**该类型**的合理细节，不要等用户一条条提：'
      + '游戏 ⇒ ' + DESIGN_DIMENSIONS_BY_KIND[CREATIVE_KINDS.GAME].join(' / ') + '；'
      + '网页 ⇒ ' + DESIGN_DIMENSIONS_BY_KIND[CREATIVE_KINDS.WEB].join(' / ') + '；'
      + 'PPT ⇒ ' + DESIGN_DIMENSIONS_BY_KIND[CREATIVE_KINDS.PPT].join(' / ') + '。'
      + '只保证"能跑"、其余全留白等用户一条条提 ⇒ 不合格。明确拒绝补 ⇒ 升级为硬失败。',
  },
  {
    id: 'G2-3', group: 2, label: '不造假壳子', scope: 'creative', kind: 'judge', needsEvidence: true,
    hardWhen: 'fake-shell',
    guide: '界面、交互功能与设计文档必须对齐，不许出现"看得见但点不动"的假 UI。'
      + '空壳页面（样式完整、核心功能失效）⇒ 不合格，且**直接升级为硬失败**（这是欺骗性交付）。',
  },
  {
    // ★ 2026-11-03 新增。老板原话：「至少形成几个有实质区别的方案，而不是换颜色、
    //   换标题冒充多个方案」「从功能、审美、可用性、创新性和实现成本进行比较」「选定方向」。
    //
    // 【为什么必须单独成一项，而不是塞进 G2-1】
    //   G2-1 查的是「设计维度覆盖度」——它只能回答"有没有想过动效/反馈/状态分支"。
    //   一个方案 + 8 个维度全提到，G2-1 满分，但老板要的「比较并取舍」一步都没做。
    //   这两件事的失败形态完全不同，混在一项里就没法分别变异、也没法分别给理由。
    //
    // 【为什么 kind 写 judge 而不是 mech】
    //   本项有三层读数：① 方案个数（强、可机械）；② 有没有比较/选定（弱、会被表述方式骗）；
    //   ③ 两方案是否只换皮（弱、相似度阈值）。主要判断依赖①②③的综合，所以主口径是 judge；
    //   而 ① 那条强读数一旦存在，会经 `mech[id] !== undefined` 覆盖模型自述 ——
    //   这正是本项目对 judge 项的既定语义（见 evaluateAcceptance 里那段注释）。
    id: 'G2-4', group: 2, label: '方案探索与取舍', scope: 'creative', kind: 'judge', needsEvidence: true,
    hardWhen: null,
    guide: '动手前必须形成至少 ' + DESIGN_OPTIONS_MIN + ' 个**结构上真的不同**的方案（换颜色/换标题不算），'
      + '按功能、审美、可用性、创新性、实现成本做比较，并写明选哪个、为什么。'
      + '只交一版就开工 ⇒ 不合格（用户明确只要一版时除外）。'
      // ★ 2026-11-03：这句是给复核员的"去哪儿看"提示。
      //   加它之前，本判据只存在于复核清单里，执行侧一个字都没说过（backend 里零命中）——
      //   等于因为一件从没要求过它做的事扣分。执行侧那半句由 `designMolds.buildMoldBrief` 注入
      //   （backend.js「设计模具库」段），两处说的是同一件事：候选结构从模具库里挑。
      + '可选的版面结构见「设计模具库」（网页 W1~W5 / 海报 P1~P4 / 长图 L1~L3），'
      + '合格的方案应能对上其中不同的两条，而不是同一个结构的两种配色。',
  },

  // ── 第三组：代码工程规范（开发类；临时目标跳过）──
  {
    id: 'G3-1', group: 3, label: 'TypeScript 规范', scope: 'dev', kind: 'mech', hardWhen: null,
    levels: [GOAL_LEVELS.MAIN, GOAL_LEVELS.FALLBACK],
    guide: '严格模式开启（tsconfig 的 strict=true）、且交付的 .ts/.tsx 里没有 any（上限 ' + ANY_ALLOWED + '）。',
  },
  {
    id: 'G3-2', group: 3, label: '代码结构', scope: 'dev', kind: 'mech', hardWhen: null,
    levels: [GOAL_LEVELS.MAIN, GOAL_LEVELS.FALLBACK],
    guide: '按职责拆模块，单文件不超过 ' + MAX_SINGLE_FILE_LINES + ' 行；全部逻辑堆在一个文件里 ⇒ 不合格。',
  },
  {
    id: 'G3-3', group: 3, label: 'E2E 测试', scope: 'dev', kind: 'mech', hardWhen: null,
    levels: [GOAL_LEVELS.MAIN, GOAL_LEVELS.FALLBACK],
    guide: '有 Playwright（或其他端到端）用例且覆盖核心流程；没有 E2E 用例 / 核心流程无测试 ⇒ 不合格。',
  },
  {
    id: 'G3-4', group: 3, label: '边界说明', scope: 'dev', kind: 'mech', hardWhen: null,
    levels: [GOAL_LEVELS.MAIN, GOAL_LEVELS.FALLBACK],
    guide: '附带文档写明：能力范围、已知限制、使用注意事项。隐瞒限制、夸大功能 ⇒ 不合格。',
  },

  // ── 第四组：交付物完整性（所有任务通用）──
  {
    id: 'G4-1', group: 4, label: '交付物匹配工单目标', scope: 'always', kind: 'judge', needsEvidence: true,
    hardWhen: 'core-broken',
    guide: '交付范围与【当前生效目标】一致：不多承诺、不少核心诉求。'
      + '交付内容缩水超出降级约定、或硬塞无关功能 ⇒ 不合格。'
      + '若核心功能失效 / 存在逻辑 bug（reason=core-broken）⇒ 升级为硬失败。',
  },
  {
    id: 'G4-2', group: 4, label: '噪音 / 风险规则', scope: 'always', kind: 'judge', needsEvidence: true, hardWhen: null,
    guide: '舆情类任务专属：规则必须能区分目标对象与无关噪音（例：上游货源品牌 vs 同名普通人）。'
      + '规则模糊、容易误判或漏判 ⇒ 不合格。非舆情类任务本项标不适用（skip）。',
  },
  {
    id: 'G4-3', group: 4, label: '报告三要素', scope: 'always', kind: 'judge', needsEvidence: false, hardWhen: null,
    guide: '验收报告必须含：✅已完成、⚠️限制边界、📌后续升级路径。'
      + '只输出"通过 / 失败"两个字、没有说明 ⇒ 不合格。',
  },
];

/** 允许出现在 reason 里的硬失败码（每个都必须能对上一条清单项的 hardWhen）。 */
const HARD_REASONS = {
  'nothing-at-all': '三层目标全部无法交付，连文档/SOP 都产不出',
  'refused-design': '创作类无合理理由拒绝做设计推演（直接甩最简模板）',
  'fake-shell': '制造虚假空壳 UI，欺骗性交付',
  'core-broken': '交付物存在逻辑 bug / 核心功能失效',
};

// ============================ 三、适用范围 ============================

/**
 * 把外部传进来的等级归一成合法值。
 *
 * ⚠️ 这里踩过一次真坑，必须留注释：`GOAL_LEVELS` 是 `{MAIN:'main', ...}`，
 *   **键是大写常量名、值是取值**。写成 `GOAL_LEVELS[c.level]` 是拿**值**去当**键**查，
 *   永远 undefined ⇒ 一律回落成 main ⇒ **等级过滤整条失效**：临时目标本该跳过第三组
 *   （代码工程规范），却照样拿它去卡 —— 正好是用户最烦的那件事「拿主目标的标准卡保底」。
 *   修前实测：`itemsFor({level:'temp'})` 里仍含 G3-1..G3-4。
 *   ⇒ 归一必须走「值集合」，不许按键查。
 */
function normalizeLevel(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(GOAL_LEVELS)) if (GOAL_LEVELS[k] === s) return s;
  return GOAL_LEVELS.MAIN;
}

/** 任务类型归一（同上，按值集合判，不按键查）。 */
function normalizeTaskType(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(TASK_TYPES)) if (TASK_TYPES[k] === s) return s;
  return TASK_TYPES.DEV;
}

/**
 * 这一项在当前任务下适用吗？
 * 三级过滤：任务类型 → 目标等级 → 用户是否明确只要骨架。
 * @param {object} item 清单项
 * @param {{taskType?:string, level?:string, skeletonOnly?:boolean}} ctx
 * @returns {{applies:boolean, why:string}}
 */
function itemApplies(item, ctx) {
  const c = ctx || {};
  const taskType = normalizeTaskType(c.taskType);
  const level = normalizeLevel(c.level);
  if (item.scope === 'creative' && taskType !== TASK_TYPES.CREATIVE) {
    return { applies: false, why: '非创作类任务，本组不启用' };
  }
  if (item.scope === 'dev' && taskType !== TASK_TYPES.DEV) {
    return { applies: false, why: '非开发类任务，本组不启用' };
  }
  if (Array.isArray(item.levels) && item.levels.indexOf(level) < 0) {
    return { applies: false, why: '当前目标等级为「' + level + '」，本项在该等级下不适用' };
  }
  // ★ 用户明确说了「只要骨架，后续补细节」⇒ 创作类专项整组跳过（清单原话）。
  //   注意：这是**用户显式偏好**，不是执行方自己给自己开的口子。执行方单方面主张"先给骨架"
  //   不构成跳过理由 —— 否则这条就成了甩模板的合法后门。
  if (item.scope === 'creative' && c.skeletonOnly === true) {
    return { applies: false, why: '用户明确要求只出骨架 ⇒ 本组按清单约定跳过' };
  }
  return { applies: true, why: '' };
}

/** 取当前任务下适用的清单项。 */
function itemsFor(ctx) {
  const out = [];
  for (const item of CHECKLIST) {
    const a = itemApplies(item, ctx);
    if (a.applies) out.push(item);
  }
  return out;
}

// ============================ 四、核验结果归一 ============================

/**
 * 把外部给的判断结果归一成 `{ pass, evidence, reason, note }`。
 *
 * 【为什么要 fail-closed】判断项如果允许「只写 pass:true、不给证据」，那它必然退化成
 * 一句橡皮图章 —— 本仓已经为此付过代价（一个按旧写法实现也能通过的断言，不是验证）。
 * 所以：**声明通过却没给证据 ⇒ 记 unknown，不算通过。**
 *
 * @param {object} item 清单项
 * @param {any} raw 外部结论（true/false 布尔，或 {pass, evidence, reason, note}）
 * @returns {{result:string, evidence:string, reason:string, note:string}}
 */
function normalizeItemResult(item, raw) {
  const empty = { result: ITEM_RESULTS.UNKNOWN, evidence: '', reason: '', note: '' };
  if (raw === undefined || raw === null) {
    return Object.assign({}, empty, { note: '未核验（清单要求逐条给结论）' });
  }
  let pass;
  let evidence = '';
  let reason = '';
  let note = '';
  if (typeof raw === 'boolean') {
    pass = raw;
  } else if (typeof raw === 'object') {
    if (typeof raw.pass === 'boolean') pass = raw.pass;
    else if (typeof raw.result === 'string') {
      // 兼容 'skip' / 'unknown' 直传
      const r = String(raw.result);
      if (r === ITEM_RESULTS.SKIP) return { result: ITEM_RESULTS.SKIP, evidence: '', reason: '', note: String(raw.note || '') };
      if (r === ITEM_RESULTS.UNKNOWN) return Object.assign({}, empty, { note: String(raw.note || '未核验') });
      pass = r === ITEM_RESULTS.PASS;
    }
    evidence = String(raw.evidence || raw.basis || '').trim();
    reason = String(raw.reason || '').trim();
    note = String(raw.note || '').trim();
    if (raw.applies === false) {
      return { result: ITEM_RESULTS.SKIP, evidence, reason: '', note: note || String(raw.why || '不适用') };
    }
  }
  if (typeof pass !== 'boolean') return Object.assign({}, empty, { note: '结论不是布尔，无法判读' });
  if (pass) {
    // ★ 无证据的"通过"不算通过（needsEvidence 的项才管这条；G4-3 这种自证型项不放宽也不收紧）
    if (item.needsEvidence && !evidence) {
      return { result: ITEM_RESULTS.UNKNOWN, evidence: '', reason, note: '声明通过但没给证据 ⇒ 不算通过' };
    }
    return { result: ITEM_RESULTS.PASS, evidence, reason: '', note };
  }
  return { result: ITEM_RESULTS.FAIL, evidence, reason, note };
}

/**
 * 判断这一条失败时要不要升级成硬失败。
 * 依据只有一条：**清单项自己声明的 hardWhen 与本次 reason 对得上**。
 * 为什么不让判断方自由标"这是硬失败"：那等于把严重性交给一次 LLM 调用，
 * 它一紧张就能把所有瑕疵都升级成失败 —— 又回到「死磕卡壳直接判失败」那个痛点。
 */
function hardReasonOf(item, norm) {
  if (!item.hardWhen) return '';
  const want = String(item.hardWhen);
  const got = String(norm.reason || '');
  // reason 允许写成 'core-broken' 或 'core-broken：详情…'，前缀对上即算
  if (got === want || got.indexOf(want + '：') === 0 || got.indexOf(want + ':') === 0) return want;
  return '';
}

// ============================ 五、判定公式 ============================

/**
 * 验收状态判定 —— 唯一判据（纯函数）。
 *
 * 判定顺序（**顺序本身就是语义，不许调换**）：
 *   ① 任一硬失败条件成立            ⇒ ❌ FAIL
 *   ② 有非跳过项没通过（含 unknown）⇒ 📝 TO_IMPROVE（打回执行方补，不判失败）
 *   ③ 硬壁垒 + 已按流程降级 + 降级后各项全过 ⇒ ⚠️ DEGRADED
 *   ④ 其余                          ⇒ ✅ PASS
 *
 * 【为什么 ② 排在 ③ 前面】降级了、但降级版本身还有细节没补齐时，应该先让执行方把那点补上，
 * 而不是直接给用户一个 PARTIAL。先修，再判。
 *
 * @param {{taskType?:string, level?:string, skeletonOnly?:boolean, allowDegrade?:boolean,
 *          hardBarrier?:boolean, degradeDeclared?:boolean, userAsked?:boolean,
 *          items?:object|Array, mech?:object}} input
 *   items  判断项结论（键 = 清单 id）
 *   mech   机械核验结果（键 = 清单 id，由 acceptanceReadings 提供，同名覆盖 items）
 * @returns {{verdict:string, items:Array, failed:Array, hardFailed:Array,
 *            skipped:Array, unknown:Array, hardBarrier:boolean, level:string, taskType:string,
 *            degradeDeclared:boolean, reason:string}}
 */
function evaluateAcceptance(input) {
  const c = input || {};
  const taskType = normalizeTaskType(c.taskType);
  const level = normalizeLevel(c.level);
  const ctx = { taskType, level, skeletonOnly: c.skeletonOnly === true };
  const given = c.items && typeof c.items === 'object' ? c.items : {};
  const mech = c.mech && typeof c.mech === 'object' ? c.mech : {};

  const rows = [];
  const failed = [];
  const hardFailed = [];
  const skipped = [];
  const unknown = [];

  for (const item of CHECKLIST) {
    const a = itemApplies(item, ctx);
    if (!a.applies) {
      skipped.push({ id: item.id, label: item.label, why: a.why });
      rows.push({ id: item.id, label: item.label, group: item.group, result: ITEM_RESULTS.SKIP, evidence: '', reason: '', note: a.why });
      continue;
    }
    // 机械读数优先（读数来自真实文件系统，比任何自述都可信）。
    //
    // ★★ 2026-11-03 修一条**假接线**：原来这里写的是
    //     `(item.kind === 'mech' && mech[item.id] !== undefined) ? … : given[…]`
    //   ⇒ 只有 `kind:'mech'` 的项才读 mech。而 G2-1（设计推演）是 `judge`，
    //   于是 acceptanceReadings 里那条「创作类一份设计文档都没有 ⇒ G2-1 不合格」
    //   的硬判**根本没人消费** —— 采集了、算好了、塞进去了，然后被这行条件整个丢掉。
    //   这正是本仓反复栽的「写了不等于接线」，而且它更坏：代码读起来完全合理。
    //
    //   正确语义：`kind` 说的是「这一项**主要**靠什么判」（mech=纯机械 / judge=需判断），
    //   而 `mech[id]` 存在说的是「这一项**现在有一条硬读数**」。两者是不同的信息，
    //   不该用一个条件把它们绑死。硬读数压过模型自述，对 judge 项同样成立 ——
    //   甚至更重要，因为 judge 项最容易靠一句自述糊弄过去。
    //
    //   ⚠️ 仍未给 mech 的项行为逐字不变（走 given），既有契约不受影响。
    //      unit-creative-design 的 D4d/D11 一负一正钉住这个边界。
    const raw = mech[item.id] !== undefined ? mech[item.id] : given[item.id];
    const norm = normalizeItemResult(item, raw);
    const row = { id: item.id, label: item.label, group: item.group, result: norm.result, evidence: norm.evidence, reason: norm.reason, note: norm.note };
    if (norm.result === ITEM_RESULTS.FAIL) {
      failed.push(row);
      const hr = hardReasonOf(item, norm);
      if (hr) { row.hard = hr; hardFailed.push(row); }
    }
    if (norm.result === ITEM_RESULTS.UNKNOWN) unknown.push(row);
    rows.push(row);
  }

  // ── 降级流程的一致性校验（纯逻辑，不依赖判断方）──
  //  这批检查是"结构性的"，不需要谁来判断：等级与硬壁垒的说法必须自洽。
  //  为什么必须放在代码里而不是交给判断方：判断方可能为了"让任务通过"把不一致抹平。
  const hardBarrier = c.hardBarrier === true;
  const declared = c.degradeDeclared === true;
  const flowRow = rows.find((r) => r.id === 'G1-3');
  if (flowRow && flowRow.result !== ITEM_RESULTS.SKIP) {
    if (hardBarrier && level === GOAL_LEVELS.MAIN) {
      flowRow.result = ITEM_RESULTS.FAIL;
      flowRow.reason = flowRow.reason || 'hard-barrier-but-main';
      flowRow.note = '存在外部硬壁垒却仍按主目标交付（死磕），降级流程不合规';
      if (failed.indexOf(flowRow) < 0) failed.push(flowRow);
    } else if (!hardBarrier && level !== GOAL_LEVELS.MAIN) {
      flowRow.result = ITEM_RESULTS.FAIL;
      flowRow.reason = flowRow.reason || 'degrade-without-barrier';
      flowRow.note = '没有外部硬壁垒却已降级（私自降级），降级流程不合规';
      if (failed.indexOf(flowRow) < 0) failed.push(flowRow);
    } else if (level !== GOAL_LEVELS.MAIN && !declared) {
      flowRow.result = ITEM_RESULTS.FAIL;
      flowRow.reason = flowRow.reason || 'degrade-not-declared';
      flowRow.note = '已降级但没有把降级这件事写进工单/报告（不告知用户）';
      if (failed.indexOf(flowRow) < 0) failed.push(flowRow);
    } else if (level !== GOAL_LEVELS.MAIN && c.allowDegrade === false) {
      // 前置核验第 1 项里有一条「用户前置偏好：是否允许降级」。
      // 用户明说过「不要降级 / 必须做完」时，降级就不是"聪明的止损"，而是**违背明确指示**。
      // 这一条只判"待优化"（打回补齐或说明），不升级成失败 —— 用户要的可能是"继续试别的路"，
      // 而不是"宣布整件事失败"。
      flowRow.result = ITEM_RESULTS.FAIL;
      flowRow.reason = flowRow.reason || 'degrade-not-allowed';
      flowRow.note = '用户明确表示不允许降级，实际却降级交付了';
      if (failed.indexOf(flowRow) < 0) failed.push(flowRow);
    }
  }

  // ── 判定（顺序即语义）──
  let verdict;
  let reason = '';
  if (hardFailed.length) {
    verdict = ACCEPT_VERDICTS.FAIL;
    reason = 'hard:' + hardFailed.map((r) => r.hard).join(',');
  } else if (failed.length || unknown.length) {
    verdict = ACCEPT_VERDICTS.TO_IMPROVE;
    reason = failed.length ? 'soft:' + failed.map((r) => r.id).join(',') : 'unverified:' + unknown.map((r) => r.id).join(',');
  } else if (hardBarrier && level !== GOAL_LEVELS.MAIN) {
    verdict = ACCEPT_VERDICTS.DEGRADED;
    reason = 'degraded-to:' + level;
  } else {
    verdict = ACCEPT_VERDICTS.PASS;
    reason = 'all-pass';
  }

  return {
    verdict, reason, items: rows, failed, hardFailed, skipped, unknown,
    hardBarrier, level, taskType, degradeDeclared: declared,
  };
}

// ============================ 六、结论 → 终态 ============================

/**
 * 验收结论映射到任务终态（本仓只有 COMPLETE / PARTIAL / BLOCKED 三档）。
 *
 * 映射规则与理由：
 *  · PASS       → COMPLETE
 *  · DEGRADED   → **PARTIAL**（不标 COMPLETE）。老板原话：降级了就要如实标"做了一部分"，
 *                 否则用户以为拿到了原版。但它**不是 BLOCKED** —— 东西是能用的。
 *  · FAIL       → **PARTIAL**。
 *                 ⚠️ 2026-11-03 更正：这一格原来写的是 BLOCKED，**是错的**，改掉。
 *                 理由：本仓 `TERMINAL.BLOCKED` 的定义（deliveryProtocol.js:31）是
 *                 「已试过合理方案、已分析原因、已排除可替代方案，**确实需要用户介入**」，
 *                 且 `classifyTerminalState` 给它设了硬前提 `blockedEvidenced`（试过≥2条路+四段式）。
 *                 「失败」的含义是**执行方没做成**，不是「用户得动手」——两者混同的直接后果是：
 *                 任何一次复检判失败都会被标成"需要您介入"，用户被叫去修本该执行方修的东西；
 *                 而且它**绕过了 blockedEvidenced 那道硬前提**，BLOCKED 从此变成一个人人可达的出口。
 *                 ⇒ 失败该如实说"没做成"，落 PARTIAL；真需要用户介入时，那条路自己走 blockedEvidenced。
 *  · TO_IMPROVE → 还有续跑轮次就 `CONTINUE`（打回执行方补细节），没有才落 PARTIAL。
 *                 这一条正是「代码瑕疵不算硬失败」的落点：先给一次补的机会。
 *
 * 【本函数当前无生产调用点，这不是遗漏】
 *   backend 的压制链（reviewVerdict 的 downgrade ⇒ COMPLETE 压成 PARTIAL）已经在做同一件事。
 *   这里保留纯函数版本，是因为**它可被单测直接喂输入看输出**，而压制链埋在 8000 行的
 *   闭包里测不了。两边的语义必须一致 —— 谁改这一格，必须同时检查
 *   `backend.js` 里 `verdict.downgrade && terminalState === TERMINAL.COMPLETE` 那一段。
 *   ⚠️ 别在这里接一条新分支进 backend：那会变成**两个真源**，而这仓最贵的一类缺陷就是它。
 *
 * @param {{verdict:string, roundsLeft?:number}} o
 * @returns {{terminal:string, continueLoop:boolean}}
 */
function acceptanceToTerminal(o) {
  const x = o || {};
  const v = String(x.verdict || '');
  if (v === ACCEPT_VERDICTS.PASS) return { terminal: 'COMPLETE', continueLoop: false };
  if (v === ACCEPT_VERDICTS.DEGRADED) return { terminal: 'PARTIAL', continueLoop: false };
  if (v === ACCEPT_VERDICTS.FAIL) return { terminal: 'PARTIAL', continueLoop: false };
  const left = Number(x.roundsLeft);
  const canRetry = Number.isFinite(left) && left > 0;
  return { terminal: canRetry ? '' : 'PARTIAL', continueLoop: canRetry };
}

// ============================ 七、报告渲染 ============================

const VERDICT_LABEL = {
  [ACCEPT_VERDICTS.PASS]: '✅ 达标',
  [ACCEPT_VERDICTS.DEGRADED]: '⚠️ 降级达标',
  [ACCEPT_VERDICTS.FAIL]: '❌ 失败',
  [ACCEPT_VERDICTS.TO_IMPROVE]: '📝 待优化',
};
const TYPE_LABEL = {
  [TASK_TYPES.DEV]: '普通开发',
  [TASK_TYPES.CREATIVE]: '创作类',
  // 不补这条的话报告会渲染成「任务类型：undefined」—— 归一没报错，用户看到的就是一句空话。
  [TASK_TYPES.RESEARCH]: '调研/规则类',
};
const LEVEL_LABEL = {
  [GOAL_LEVELS.MAIN]: '主目标',
  [GOAL_LEVELS.FALLBACK]: '保底目标',
  [GOAL_LEVELS.TEMP]: '临时目标',
};
const RESULT_MARK = {
  [ITEM_RESULTS.PASS]: '✔',
  [ITEM_RESULTS.FAIL]: '✘',
  [ITEM_RESULTS.SKIP]: '—',
  [ITEM_RESULTS.UNKNOWN]: '？',
};

/** 把一段文字压成一行（报告里每条不许占三行以上，否则用户不会看）。 */
function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const m = Number(max) > 0 ? Number(max) : 160;
  return t.length > m ? t.slice(0, m - 1) + '…' : t;
}

/**
 * 渲染固定格式验收报告。
 *
 * 【为什么模板一块都不许省】老板给的是固定模板，四节各有各的用处：
 *  一、已完成 —— 用户先要知道"我拿到了什么"；
 *  二、限制边界 —— 用户要知道"这东西不能干什么"，否则会拿它去干不该干的事；
 *  三、核验不通过项 —— 要能对号入座，不是一句"没通过"；
 *  四、后续升级路径 —— 降级达标必填，否则用户不知道怎样才能拿回原版。
 *
 * 【为什么在四节之后加「附：逐条核验结果」】老板同一段要求里还有一句
 *  「输出报告时把每条核验结果带上」，而四节模板只承载"不通过项"。
 *  两条要求同时满足的唯一办法就是附录。附录不替代四节，也不改变四节的顺序。
 *
 * @param {{taskId?:string, taskType?:string, level?:string, verdict:string,
 *          done?:string[], limits?:{can?:string[], cannot?:string[], source?:string},
 *          failed?:Array, upgrade?:string[], items?:Array}} o
 * @returns {string}
 */
function renderAcceptanceReport(o) {
  const x = o || {};
  const verdict = ACCEPT_VERDICTS[x.verdict] ? x.verdict : ACCEPT_VERDICTS.TO_IMPROVE;
  const taskType = normalizeTaskType(x.taskType);
  const level = normalizeLevel(x.level);
  const L = [];
  L.push('【验收报告】');
  L.push('任务编号：' + (x.taskId ? String(x.taskId) : '（未提供）'));
  L.push('任务类型：' + TYPE_LABEL[taskType]);
  L.push('当前生效目标等级：' + LEVEL_LABEL[level]);
  L.push('验收结论：' + VERDICT_LABEL[verdict]);

  L.push('一、已完成');
  const done = Array.isArray(x.done) ? x.done.filter(Boolean) : [];
  if (done.length) done.forEach((d) => L.push('- ' + oneLine(d, 200)));
  else L.push('- （这一轮没有可交付内容）');

  L.push('二、限制边界');
  const lim = x.limits || {};
  const can = Array.isArray(lim.can) ? lim.can.filter(Boolean) : [];
  const cannot = Array.isArray(lim.cannot) ? lim.cannot.filter(Boolean) : [];
  L.push('- 能做什么：' + (can.length ? oneLine(can.join('；'), 200) : '（未说明）'));
  L.push('- 不能做什么：' + (cannot.length ? oneLine(cannot.join('；'), 200) : '（未说明）'));
  L.push('- 限制来源：' + (lim.source ? oneLine(lim.source, 120) : '（未说明）'));

  L.push('三、核验不通过项（如有）');
  const failed = Array.isArray(x.failed) ? x.failed.filter(Boolean) : [];
  if (!failed.length) L.push('- 无');
  else {
    failed.forEach((f) => {
      const id = f && f.id ? String(f.id) : '?';
      const label = f && f.label ? String(f.label) : '';
      const desc = oneLine((f && (f.note || f.reason)) || '不合格', 160);
      const fix = oneLine((f && f.fix) || '按该条判据补齐后重新验收', 120);
      L.push('- [' + id + (label ? ' ' + label : '') + '] ' + desc);
      L.push('  修改要求：' + fix);
    });
  }

  L.push('四、后续升级路径（降级达标必填）');
  const up = Array.isArray(x.upgrade) ? x.upgrade.filter(Boolean) : [];
  if (up.length) up.forEach((u) => L.push('- ' + oneLine(u, 200)));
  else if (verdict === ACCEPT_VERDICTS.DEGRADED) {
    // 降级达标不给升级路径 = 用户永远拿不回原版，这比不给报告更糟
    L.push('- （缺失：降级达标必须写明切回主目标需要满足的条件）');
  } else {
    L.push('- 无（未降级）');
  }

  const items = Array.isArray(x.items) ? x.items : [];
  if (items.length) {
    L.push('附：逐条核验结果');
    items.forEach((it) => {
      const mark = RESULT_MARK[it.result] || '？';
      const tail = it.result === ITEM_RESULTS.SKIP
        ? ('跳过：' + oneLine(it.note || '本项不适用', 80))
        : (it.result === ITEM_RESULTS.PASS
          ? (it.evidence ? oneLine(it.evidence, 80) : '（自证型项）')
          : oneLine(it.note || it.reason || it.evidence || '不合格', 80));
      L.push('- [' + it.id + '] ' + it.label + ' ' + mark + ' ' + tail);
    });
  }
  return L.join('\n');
}

module.exports = {
  TASK_TYPES,
  GOAL_LEVELS,
  ACCEPT_VERDICTS,
  ITEM_RESULTS,
  RETRY_LIMIT_RUNTIME,
  RETRY_LIMIT_ACCEPT,
  MAX_SINGLE_FILE_LINES,
  ANY_ALLOWED,
  DESIGN_OPTIONS_MIN,
  DESIGN_OPTION_SIMILAR_MAX,
  DESIGN_DIMENSIONS,
  DESIGN_DIMENSIONS_BASE,
  DESIGN_DIMENSIONS_BY_KIND,
  CREATIVE_KINDS,
  normalizeCreativeKind,
  designDimensionsFor,
  CHECKLIST,
  HARD_REASONS,
  VERDICT_LABEL,
  itemApplies,
  itemsFor,
  normalizeLevel,
  normalizeTaskType,
  normalizeItemResult,
  evaluateAcceptance,
  acceptanceToTerminal,
  renderAcceptanceReport,
};
