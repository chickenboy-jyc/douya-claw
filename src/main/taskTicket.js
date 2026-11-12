'use strict';

/**
 * 「5 号规划 Agent」标准化任务工单（结构化容器）。
 *
 * ============================ 这个文件解决什么 ============================
 * 老板给的工单模板有 11 个字段，其中第 5 项「当前生效目标等级」是**动态字段**，
 * 降级时原地更新、广播全集群、旧工单归档不丢弃。
 *
 * 【它为什么必须是一个模块，而不是一段提示词】
 *   在它之前，本仓根本没有「当前生效目标等级」这个东西：
 *   `grep -E "degrade|goalLevel|保底|临时目标|硬壁垒" src/main/backend.js` ⇒ 零命中。
 *   三层目标只活在 `douyaPersona` 的提示词里，没有任何状态承载；
 *   于是验收侧（`auditTask` 的 `level / taskType / skeletonOnly / hardBarrier /
 *   degradeDeclared` 五个参数）**永远拿不到真值**，只能兜底读复检模型自己填的 `j.level`。
 *   而「4 号验收清单」的整个立意是「不靠模型自觉」——
 *   验收标准跟随目标等级，目标等级却由被验收的那个模型自述，这条链是断的。
 *
 *   本模块就是那个断点的容器：**等级由工单承载，工单由规划侧写，验收侧只读**。
 *   第 5 项从此是一个可断言的对象，而不是一句提示词。
 *
 * ============================ 两条纪律 ============================
 * 1. **纯函数、零副作用**（不读盘、不联网、不读环境变量）。
 *    理由：它要被单测直接 require 喂输入看输出；一有 IO 就只能靠集成测试，而集成测试
 *    在本仓历史上多次给出「跑通了但跑的是旧分支」的假绿。
 * 2. **不静默补默认值**。缺字段就如实报缺失（`validateTicket` 的 issues），
 *    绝不用默认值把一张残缺工单伪装成合法工单 —— 那是 fail-open，本仓最贵的一类缺陷。
 */

// ===================== 一、常量 =====================

/** 任务分类（工单第 3 项）。 */
const TASK_TYPES = {
  DEV: 'dev',           // 普通开发任务
  CREATIVE: 'creative', // 创作类：游戏 / 网页 / PPT / UI / 桌面宠物 / 交互 Demo
  RESEARCH: 'research', // 调研 / 规则类
};

/**
 * 创作子类型（工单第 3 项的下钻）。值域与 `acceptanceChecklist.CREATIVE_KINDS` 一致。
 *
 * 【为什么必须有】老板的创作类规则第 3 条给的是**按类型分的细节清单**：
 * 游戏要查「胜利判定/难度梯度」，网页要查「hover 反馈/移动端适配」，
 * PPT 要查「信息层级/动画节奏」。只有一个笼统的 `creative`，验收侧就无从知道该查哪一套 ——
 * 拿游戏的「胜利判定」去卡一个网页任务，是纯粹的误伤。
 *
 * ⚠️ 缺省 `VISUAL`（visual 的专属维度为空，只查通用 8 项）：
 *   标错类型的代价远大于少查几项。工单没写子类型时，验收侧只按通用项核对，
 *   并在报告里写明「未标子类型 ⇒ 专属细节没查」，不假装查过。
 */
const CREATIVE_KINDS = {
  GAME: 'game',     // 游戏
  WEB: 'web',       // 网页 / 页面
  PPT: 'ppt',       // PPT
  VISUAL: 'visual', // 可视化 / 桌面宠物 / 其他（老板未给专属维度）
};

/** 当前生效目标等级（工单第 5 项，动态）。与 acceptanceChecklist.GOAL_LEVELS 同值域。 */
const GOAL_LEVELS = {
  MAIN: 'main',         // 主目标
  FALLBACK: 'fallback', // 保底目标
  TEMP: 'temp',         // 临时目标（代码产物完全无法产出时的最后兜底）
};

/** 探测状态（工单第 6 项）。 */
const PROBE_STATUS = {
  PENDING: 'pending', // 未探测
  RUNNING: 'running', // 探测中
  DONE: 'done',       // 探测完成
};

/** 阻碍性质（工单第 6 项要求区分两类，走法完全相反）。 */
const BARRIER_KINDS = {
  NONE: 'none',               // 无外部硬壁垒
  FIXABLE_BUG: 'fixable-bug', // 可修复 bug ⇒ 改对了再试
  HARD: 'hard-barrier',       // 外部硬壁垒（反爬/权限/账号/付费/风控）⇒ 一次都别再试
};

/**
 * ★★ 重试上限的**两层口径**（这是本仓最容易写成谎话的一个数字，别合并）。
 *
 *   · `RETRY_LIMIT_RUNTIME = 1`
 *     运行时真值。`toolProtocol.createRetryLedger` 的 `maxSameMethod` 缺省 2，语义是
 *     「同一签名第 2 次失败必须升级」⇒ **只允许重试 1 次**。
 *     提示层/工单层若承诺「最多 3 次」，就是在允许运行时给第 3、第 4 次机会 —— 那是谎话，
 *     而且会被用户当成「你说能试三次，怎么第二次就放弃了」。
 *   · `RETRY_LIMIT_ACCEPT = 3`
 *     验收判据上界。老板工单第 10 项写「同一点动作最多 3 次」，它回答的问题是
 *     「怎么判执行方在死磕」——超过 3 次同点动作 ⇒ 判死磕 / 该降级了。
 *     它是**判据**，不是**预算**。
 *
 *   ⇒ 两个数字都保留、都命名、都写清语义。谁想统一成一个，先回答：
 *     「第 2 次失败之后运行时还准不准再试？」准，才轮到 3；不准，3 就只是判据。
 */
const RETRY_LIMIT_RUNTIME = 1;
const RETRY_LIMIT_ACCEPT = 3;

/**
 * 工单重试上限的归一化 —— **唯一规则**，`createTicket` 与 `renderTicket` 共用。
 *
 * ★ 为什么必须抽成一个函数（2026-11-04 第三轮）：
 *   这两处原来各写一遍同样的意图，结果**一处写对了、一处写错了**：
 *     · `createTicket`：`Number.isFinite(Number(x)) ? Number(x) : RETRY_LIMIT_ACCEPT`（对）
 *     · `renderTicket`：`... + Number.isFinite(Number(x)) + ' 次'`（**漏了取数字这一步**，
 *       `Number.isFinite(...)` 返回的是**布尔**）⇒ 工单上真的印出过「同一点动作最多 **true** 次」。
 *   一个数字两处各写一份，迟早漂移；共用一个函数，漂移就没地方发生。
 *
 * ★ 兜底为什么取 `RETRY_LIMIT_ACCEPT`：它就是 `createTicket` 原本在用的默认值，
 *   不另发明一个数。这样即使调用方把一个**没走过 `createTicket` 归一化**的对象直接丢给
 *   `renderTicket`，印出来的也是这张工单"本来会被归一成"的数字，而不是 `NaN` / `true`。
 *
 * @param {*} v 工单里写的 retryLimit（可能是数字、字符串、undefined、null、NaN）
 * @returns {number} 一定是有限数字
 */
function normalizeRetryLimit(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : RETRY_LIMIT_ACCEPT;
}

/** 工单 11 项的字段名（用于校验缺项时能说出人话）。 */
const TICKET_FIELDS = [
  ['ticketId', '工单ID'],
  ['version', '版本号'],
  ['createdAt', '创建时间'],
  ['rawUserRequirement', '原始用户需求'],
  ['preference', '用户显性&隐性偏好'],
  ['taskType', '任务分类标签'],
  ['goals', '三层目标定义'],
  ['level', '当前生效目标等级'],
  ['probe', '可行性探测结论'],
  ['deliverables', '交付物清单'],
  ['upgradeCondition', '升级回退条件'],
  ['dispatch', '调度与资源分配'],
];

// ===================== 二、归一 =====================

/**
 * 按**值集合**归一，不按键查。
 *
 * ⚠️ 这是踩过的坑，不是防御性编程：`GOAL_LEVELS` 是 `{MAIN:'main', ...}`，
 * 键是大写常量名、值是取值。写成 `GOAL_LEVELS[level]` 是拿**值**当**键**查，
 * 永远 undefined ⇒ 一律回落 main ⇒ 等级过滤整条失效（临时目标不再跳过工程规范组）。
 * `unit-acceptance-checklist` 的 S2i/S2j 就是这个坑的常驻反控。
 */
function normalizeLevel(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(GOAL_LEVELS)) if (GOAL_LEVELS[k] === s) return s;
  return GOAL_LEVELS.MAIN;
}

function normalizeTaskType(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(TASK_TYPES)) if (TASK_TYPES[k] === s) return s;
  return TASK_TYPES.DEV;
}

function normalizeProbeStatus(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(PROBE_STATUS)) if (PROBE_STATUS[k] === s) return s;
  return PROBE_STATUS.PENDING;
}

function normalizeBarrierKind(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(BARRIER_KINDS)) if (BARRIER_KINDS[k] === s) return s;
  return BARRIER_KINDS.NONE;
}

/**
 * 创作子类型归一（同上，按值遍历）。
 * 缺省回落 VISUAL —— 它的专属维度是空的，只查通用 8 项，最不容易误伤。
 */
function normalizeCreativeKind(v) {
  const s = String(v == null ? '' : v);
  for (const k of Object.keys(CREATIVE_KINDS)) if (CREATIVE_KINDS[k] === s) return s;
  return CREATIVE_KINDS.VISUAL;
}

function strList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
}

// ===================== 三、建档 =====================

/**
 * 生成一张工单。**所有字段都落位**（缺的留空/null，不留 undefined 坑）。
 *
 * 为什么不用 `{...input}` 直接透传：透传会让「缺字段」与「字段值为空」看起来一样，
 * 校验时就分不清「他没填」和「他填了空」。
 *
 * @param {object} input
 * @returns {object} ticket
 */
function createTicket(input) {
  const i = input && typeof input === 'object' ? input : {};
  const pref = i.preference && typeof i.preference === 'object' ? i.preference : {};
  const goals = i.goals && typeof i.goals === 'object' ? i.goals : {};
  const probe = i.probe && typeof i.probe === 'object' ? i.probe : {};
  const disp = i.dispatch && typeof i.dispatch === 'object' ? i.dispatch : {};

  const pickGoal = (g) => {
    const x = g && typeof g === 'object' ? g : {};
    return {
      text: String(x.text || '').trim(),
      capability: String(x.capability || '').trim(),
      riskCost: String(x.riskCost || '').trim(),
    };
  };

  return {
    ticketId: String(i.ticketId || '').trim(),
    version: String(i.version || 'v1').trim(),
    createdAt: String(i.createdAt || '').trim(),
    updatedAt: String(i.updatedAt || i.createdAt || '').trim(),

    rawUserRequirement: String(i.rawUserRequirement || '').trim(),

    // 第 2 项：三项勾选 + 备注。刻意用 true/false/null 三态：
    //   null = 用户没表态。**不能当 false 用**——把「没表态」读成「明确不允许」会误判违规。
    preference: {
      allowDegrade: pref.allowDegrade === true ? true : (pref.allowDegrade === false ? false : null),
      skeletonOnly: pref.skeletonOnly === true,
      highRiskParallel: pref.highRiskParallel === true,
      note: String(pref.note || '').trim(),
    },

    taskType: normalizeTaskType(i.taskType),
    // 第 3 项下钻：创作子类型。决定验收侧查哪一套专属细节维度。
    // 非创作类任务这个字段无意义，但**不强行清空** —— 宁可留着让人看见
    // "填了但类型不是创作类"，也不要静默丢弃用户/5 号的输入。
    creativeKind: normalizeCreativeKind(i.creativeKind),

    // 第 4 项：三层目标，每层三件事（目标 / 能力 / 风险成本）。
    // 只写一句「做个 XX」不算定义了三层——校验会要求三层互不相同。
    goals: {
      main: pickGoal(goals.main),
      fallback: pickGoal(goals.fallback),
      temp: pickGoal(goals.temp),
    },

    // 第 5 项：动态字段
    level: normalizeLevel(i.level),
    activeGoal: String(i.activeGoal || '').trim(),

    // 第 6 项：探测
    probe: {
      status: normalizeProbeStatus(probe.status),
      result: String(probe.result || '').trim(),
      blockers: strList(probe.blockers),
      barrierKind: normalizeBarrierKind(probe.barrierKind),
      // 临时目标的硬前提：**代码产物完全无法产出**。
      // 单独一个布尔而不是从 barrierKind 推断，因为「有硬壁垒」≠「连文档都给不出」。
      codeArtifactsImpossible: probe.codeArtifactsImpossible === true,
    },

    // 第 7 项：交付物绑定当前生效目标
    deliverables: strList(i.deliverables),
    deliverablesLevel: i.deliverablesLevel ? normalizeLevel(i.deliverablesLevel) : '',

    // 第 9 项：升级回退条件（降级时必填）
    upgradeCondition: String(i.upgradeCondition || '').trim(),

    // 第 10 项：调度
    dispatch: {
      mainAgent: String(disp.mainAgent || '').trim(),
      backupAgent: String(disp.backupAgent || '').trim(),
      parallel: disp.parallel === true,
      // 工单里写的是 3；写进这里时同时记下运行时真值，避免下游把它当预算用。
      retryLimit: normalizeRetryLimit(disp.retryLimit),
    },

    // 第 11 项
    specialNote: String(i.specialNote || '').trim(),

    // 归档：降级时把旧快照推进来，**不覆盖、不丢弃**
    history: Array.isArray(i.history) ? i.history.slice() : [],
  };
}

// ===================== 四、校验 =====================

/**
 * 校验一张工单是否「能拿去派活」。
 *
 * 设计原则：**每条 issue 都必须能说出「谁会因此做错什么」**。
 * 说不出后果的检查项是噪音，噪音多了这一整套就会被当成形式主义跳过。
 *
 * ★★ `severity` 两档，这个区分是实测逼出来的，不是设计洁癖：
 *   · `error`  —— 会让下游做错事，**阻断**（`ok=false`）
 *   · `notice` —— 只是口径上要说清，**不阻断**，放进 `notices` 供派活时念一遍
 *
 *   为什么必须分：老板模板第 10 项原文写的是「同一点动作最多 3 次」，而运行时真值只有 1 次。
 *   第一版我把这条写成 error，结果**他那张示例工单自己就过不了校验**，
 *   连带 `moveLevel` 降级也被一起拦死 —— 等于我造了一道门，把老板的模板挡在门外。
 *   校验一旦会否掉正主给的样板，它就会被整体跳过，那比不校验更糟。故降为 notice。
 *
 * @param {object} t createTicket 的产物
 * @returns {{ok:boolean, issues:Array, notices:Array}}  issues 只含 error
 */
function validateTicket(t) {
  const issues = [];
  const notices = [];
  const add = (field, code, message) => issues.push({ field, code, message, severity: 'error' });
  const note = (field, code, message) => notices.push({ field, code, message, severity: 'notice' });
  if (!t || typeof t !== 'object') {
    add('ticket', 'not-a-ticket', '工单为空或不是对象 —— 验收侧拿不到等级，会一律按主目标卡');
    return { ok: false, issues, notices };
  }

  // ── V1 必备字段 ───────────────────────────────────────────────
  if (!t.ticketId) add('ticketId', 'missing', '没有工单ID ⇒ 归档与「同类需求优先读历史工单」都无从索引');
  if (!t.rawUserRequirement) add('rawUserRequirement', 'missing', '没有原始需求原文 ⇒ 后续所有角色只能读二手转述，理解偏差无处对账');
  if (!t.createdAt) add('createdAt', 'missing', '没有创建时间 ⇒ 无法判断工单是否过期');

  // ── V2 三层目标必须真的有三层 ──────────────────────────────────
  const g = t.goals || {};
  const texts = [g.main, g.fallback, g.temp].map((x) => String((x && x.text) || '').trim());
  if (!texts[0]) add('goals.main', 'missing', '没有主目标 ⇒ 没有「原定要做」，降级时说不出落差');
  if (!texts[1]) add('goals.fallback', 'missing', '没有保底目标 ⇒ 主目标受阻时只能干耗或直接判失败');
  if (!texts[2]) add('goals.temp', 'missing', '没有临时目标 ⇒ 代码产物全产不出时连文档兜底都没有');
  if (texts[0] && texts[0] === texts[1]) {
    add('goals.fallback', 'same-as-main', '保底目标与主目标逐字相同 ⇒ 这不是降级方案，是「假装有预案」');
  }
  if (texts[1] && texts[1] === texts[2]) {
    add('goals.temp', 'same-as-fallback', '临时目标与保底目标逐字相同 ⇒ 少了最后一档，届时只剩「什么都没有」');
  }
  // 每层都要写清能力与代价：只写目标不写代价 = 决策时只能拍脑袋
  ['main', 'fallback', 'temp'].forEach((k, idx) => {
    const x = (g[k] || {});
    if (texts[idx] && !x.capability) {
      add('goals.' + k + '.capability', 'missing', '「' + k + '」没写能做到什么 ⇒ 用户不知道降级后手里是什么');
    }
    if (texts[idx] && !x.riskCost) {
      add('goals.' + k + '.riskCost', 'missing', '「' + k + '」没写风险/成本 ⇒ 换档决定是拍脑袋');
    }
  });

  // ── V3 创作类强制设计推演（工单第 3 项自带约束）───────────────────
  // 模板原文：「只要勾选创作类、用户没有勾选『只要最简骨架』，工单自带强制约束：
  //            先输出设计推演文档，规划校验通过，再进入开发」
  // 这里不检查「有没有真的交设计文档」（那是验收侧 G2 的事），
  // 只检查**工单层面有没有把这条约束挂上去**——没挂，验收侧根本不知道该查。
  const pref = t.preference || {};
  if (t.taskType === TASK_TYPES.CREATIVE && pref.skeletonOnly !== true) {
    const note = String(t.specialNote || '');
    const marked = /设计推演/.test(note);
    if (!marked) {
      add('specialNote', 'creative-needs-design-doc',
        '创作类且用户没说要骨架，但工单没写「需要先交付设计推演文档」⇒ 执行方会直接甩模板，验收侧也没有依据拦');
    }
  }
  // 反向：用户明确只要骨架时，工单不该还挂着强制设计推演（那是加戏）
  if (pref.skeletonOnly === true && /设计推演.*确认后再开发/.test(String(t.specialNote || ''))) {
    add('specialNote', 'skeleton-but-forced-design',
      '用户明确只要最简骨架，工单却仍强制「设计推演确认后再开发」⇒ 违背用户明确指示，会被判违规');
  }

  // 创作子类型：没标 ⇒ 专属细节根本无从查起。
  // ⚠️ 这条只记 notice **不阻断**：没标子类型时验收侧会回落 visual（只查通用 8 项），
  //   结果是「少查了几项」而不是「判错」。把"少查"升级成"不许提交"会让 5 号
  //   在一个纯 UI 调整的单子上被拦住，那是拿校验绑架正事。
  //
  // ⚠️⚠️ 判据**不能**写 `String(t.creativeKind || '').trim() === ''` —— createTicket 已经
  //   把它归一成 'visual' 了，那个条件永远 false，notice 永远不发（本门禁 D7b 抓到过）。
  //   代价是「明确标了 visual」也会收到这条提示，但提示内容对两者**都成立**：
  //   visual 本来就没有专属维度，不管它是"没标"还是"确实不是游戏/网页/PPT"。
  if (t.taskType === TASK_TYPES.CREATIVE && normalizeCreativeKind(t.creativeKind) === CREATIVE_KINDS.VISUAL) {
    note('creativeKind', 'creative-kind-unset',
      '创作类子类型是 visual（未标 game/web/ppt，或确实不属于这三类）⇒ 验收只按通用 8 项核对；'
      + '若它其实是游戏/网页/PPT，该类型的专属细节（胜利判定、hover/移动端适配、信息层级）不会被查到');
  }

  // ── V4 降级的三个必要条件（这是「降级流程合规」的机器判据）────────
  const lv = t.level;
  if (lv !== GOAL_LEVELS.MAIN) {
    const probe = t.probe || {};
    if (probe.status !== PROBE_STATUS.DONE) {
      add('probe.status', 'degrade-without-probe',
        '还没探测完就降级了 ⇒ 降级理由是猜的。探测没跑完，硬壁垒不成立');
    }
    if (probe.barrierKind !== BARRIER_KINDS.HARD) {
      add('probe.barrierKind', 'degrade-without-hard-barrier',
        '降级了但阻碍性质不是「外部硬壁垒」⇒ 这是「可修复 bug」被当成了借口。'
        + '可修复缺陷必须改对了再试，不许切保底');
    }
    if (!Array.isArray(probe.blockers) || probe.blockers.length === 0) {
      add('probe.blockers', 'degrade-without-blockers',
        '降级了但阻碍清单是空的 ⇒ 用户看不到「卡在哪」，只看到「它不做了」');
    }
    if (!t.upgradeCondition) {
      add('upgradeCondition', 'degrade-without-upgrade',
        '降级了但没写升级回退条件 ⇒ 用户不知道怎样能拿回原版（验收清单 G1-3 会直接判失败）');
    }
    // 交付物必须跟着等级走：降级后还挂着主目标的交付物，等于承诺做不到的东西
    if (t.deliverablesLevel && t.deliverablesLevel !== lv) {
      add('deliverables', 'deliverables-level-stale',
        '交付物清单还绑在「' + t.deliverablesLevel + '」，而当前生效等级已是「' + lv + '」⇒ 验收会照旧清单核对，必红或假绿');
    }
    // 临时目标的硬前提
    if (lv === GOAL_LEVELS.TEMP && probe.codeArtifactsImpossible !== true) {
      add('probe.codeArtifactsImpossible', 'temp-without-impossible',
        '切到临时目标，但没声明「代码产物确实完全产不出」⇒ 临时目标是最后一档，不许当省事的出口');
    }
  }

  // ── V5 用户明确不许降级 ───────────────────────────────────────
  if (pref.allowDegrade === false && lv !== GOAL_LEVELS.MAIN) {
    add('level', 'violates-user-no-degrade',
      '用户明确说了不允许降级，工单却已切到「' + lv + '」⇒ 违背明确指示');
  }

  // ── V6 重试上限两层口径不许混 ────────────────────────────────
  const rl = Number((t.dispatch || {}).retryLimit);
  if (!Number.isFinite(rl) || rl <= 0) {
    add('dispatch.retryLimit', 'bad-retry-limit', '重试上限不是正数 ⇒ 下游要么不重试要么无限重试');
  } else if (rl > RETRY_LIMIT_ACCEPT) {
    add('dispatch.retryLimit', 'retry-over-accept',
      '重试上限 ' + rl + ' 超过验收上界 ' + RETRY_LIMIT_ACCEPT + ' ⇒ 超过 3 次同点动作就该判死磕了');
  } else if (rl > RETRY_LIMIT_RUNTIME) {
    // 这一条**不是错**，是必须显式知道的口径落差 ⇒ notice，不阻断。
    // 写成 notice 而不是注释，是因为注释没人读，而这里差 1 次就会让提示层撒谎。
    note('dispatch.retryLimit', 'retry-exceeds-runtime',
      '工单写 ' + rl + ' 次，运行时真值是 ' + RETRY_LIMIT_RUNTIME + ' 次'
      + '（createRetryLedger 的 maxSameMethod 缺省 2 ⇒ 第 2 次失败必须升级）。'
      + '派活时必须说清这是「验收判据上界」不是「运行时可重试次数」，否则提示层在承诺运行时做不到的事');
  }

  // ── V7 版本与更新时间的自洽 ──────────────────────────────────
  if (t.updatedAt && t.createdAt && String(t.updatedAt) !== String(t.createdAt) && !/^v/.test(String(t.version || ''))) {
    add('version', 'version-not-tracked', '工单被更新过，但版本号不是 vN 形式 ⇒ 归档时无法排序，新旧工单分辨不出');
  }

  return { ok: issues.length === 0, issues, notices };
}

// ===================== 五、降级 / 升级 =====================

/**
 * 切档（降级或升级）。**原地更新工单内容 + 旧快照归档 + 版本号前移**。
 *
 * 老板原话：「触发降级时，原地更新工单内容，同步通知全部角色，旧工单保留归档，不丢弃。」
 * ⇒ 这里的「归档」是把旧快照推进 `history`，而不是留一个文件旧版本在那谁也不看。
 *
 * ⚠️ 拒绝而不是宽容：不合规的切档返回 `{ok:false, issues}`，**不改工单**。
 *    静默接受一次非法降级，等于把「降级流程合规」这条规则废掉。
 *
 * @param {object} t
 * @param {object} o { level, activeGoal, deliverables, upgradeCondition, barrierKind, blockers,
 *                     probeStatus, codeArtifactsImpossible, reason, now, version }
 * @returns {{ok:boolean, ticket:object, issues:Array}}
 */
function moveLevel(t, o) {
  const x = o && typeof o === 'object' ? o : {};
  const to = normalizeLevel(x.level);
  const from = normalizeLevel(t && t.level);
  if (!t || typeof t !== 'object') {
    return { ok: false, ticket: t, issues: [{ field: 'ticket', code: 'not-a-ticket', message: '工单为空，无法切档' }] };
  }

  // 先在副本上改，再整体校验：任何一项不合规就**一个字都不改**（避免半改状态）
  const next = createTicket(Object.assign({}, t, {
    level: to,
    activeGoal: x.activeGoal != null ? String(x.activeGoal) : String((t.goals || {})[to] ? t.goals[to].text : ''),
    deliverables: x.deliverables != null ? x.deliverables : t.deliverables,
    // 交付物跟着等级走：没显式给就标记为当前等级，避免「旧清单挂旧等级」
    deliverablesLevel: x.deliverables != null ? to : (t.deliverablesLevel || to),
    upgradeCondition: x.upgradeCondition != null ? String(x.upgradeCondition) : t.upgradeCondition,
    probe: Object.assign({}, t.probe, {
      status: x.probeStatus != null ? normalizeProbeStatus(x.probeStatus) : (t.probe || {}).status,
      barrierKind: x.barrierKind != null ? normalizeBarrierKind(x.barrierKind) : (t.probe || {}).barrierKind,
      blockers: x.blockers != null ? x.blockers : (t.probe || {}).blockers,
      codeArtifactsImpossible: x.codeArtifactsImpossible != null
        ? x.codeArtifactsImpossible === true
        : (t.probe || {}).codeArtifactsImpossible,
      result: x.reason != null ? String(x.reason) : (t.probe || {}).result,
    }),
    updatedAt: String(x.now || ''),
    // 版本号：默认 +1（v1 → v2）。降级不换版本号，归档里就分不出「改了几次」。
    version: x.version != null ? String(x.version) : bumpVersion(t.version),
  }));

  const v = validateTicket(next);
  if (!v.ok) return { ok: false, ticket: t, issues: v.issues, notices: v.notices };

  // 旧快照归档（含它当时的等级与交付物），**不丢弃**
  next.history = (Array.isArray(t.history) ? t.history.slice() : []).concat([{
    version: t.version,
    level: from,
    activeGoal: t.activeGoal,
    deliverables: Array.isArray(t.deliverables) ? t.deliverables.slice() : [],
    upgradeCondition: t.upgradeCondition,
    reason: String(x.reason || ''),
    at: String(x.now || ''),
  }]);

  return { ok: true, ticket: next, issues: [], notices: v.notices };
}

/** v1 → v2；v9 → v10；没有数字就补成 v2（绝不静默返回原值——那会让归档看起来没变过）。 */
function bumpVersion(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^v(\d+)$/i);
  if (!m) return 'v2';
  return 'v' + (Number(m[1]) + 1);
}

// ===================== 六、桥：工单 ⇒ 验收上下文 =====================

/**
 * ★★ 这是整个模块的**存在理由**：把工单变成 `acceptanceChecklist.evaluateAcceptance`
 * 能直接吃的上下文，从而让验收标准真的跟随「当前生效目标等级」。
 *
 * 在它之前，这五个字段只能来自复检模型自己的 JSON（`j.taskType` / `j.level` /
 * `j.skeletonOnly` / `j.hardBarrier` / `j.degradeDeclared`）——
 * 也就是**被验收方自己申报验收标准**。现在它们来自工单，而工单由规划侧写、验收侧只读。
 *
 * 映射口径（逐条写清，别让人猜）：
 *  · `level`            ← 工单第 5 项（当前生效等级）
 *  · `taskType`         ← 工单第 3 项
 *  · `skeletonOnly`     ← 工单第 2 项勾选（**只认用户显式偏好**；执行方单方主张不算）
 *  · `allowDegrade`     ← 第 2 项三态：true / false / undefined（没表态就不传，别当"不允许"）
 *  · `hardBarrier`      ← 第 6 项阻碍性质 === hard-barrier
 *  · `degradeDeclared`  ← 等级≠main 且升级条件非空（"说了"= 改档 + 写了怎么回去）
 *  · `upgrade`          ← 第 9 项，拆成列表喂给报告渲染
 *  · `deliverables`     ← 第 7 项（验收按这个核对交付物是否齐全）
 *
 * @param {object} t
 * @returns {object} 可直接展开进 auditTask / evaluateAcceptance 的上下文
 */
function ticketToAcceptanceContext(t) {
  const k = t && typeof t === 'object' ? t : {};
  const probe = k.probe || {};
  const pref = k.preference || {};
  const lv = normalizeLevel(k.level);
  const hardBarrier = normalizeBarrierKind(probe.barrierKind) === BARRIER_KINDS.HARD;

  // 三态：**只有用户明确表态才传**。把 null 传成 false 会造出「用户不许降级」的假指示。
  let allowDegrade;
  if (pref.allowDegrade === true) allowDegrade = true;
  else if (pref.allowDegrade === false) allowDegrade = false;

  return {
    taskId: String(k.ticketId || ''),
    taskType: normalizeTaskType(k.taskType),
    // 创作子类型：验收侧据此选「查哪一套专属设计维度」。
    // 不传 ⇒ 回落 visual（只查通用 8 项），**不会**误用游戏/网页那套去卡。
    creativeKind: normalizeCreativeKind(k.creativeKind),
    level: lv,
    skeletonOnly: pref.skeletonOnly === true,
    allowDegrade,
    hardBarrier,
    // "已声明降级" = 真的改了档 + 写清了怎么回去。只有其中一个，用户还是不知道发生了什么。
    degradeDeclared: lv !== GOAL_LEVELS.MAIN && !!String(k.upgradeCondition || '').trim(),
    upgrade: String(k.upgradeCondition || '').trim()
      ? [String(k.upgradeCondition).trim()]
      : [],
    deliverables: strList(k.deliverables),
    // 给验收侧看的补充事实：探测是否真的做完（没做完的降级要额外标出来）
    probeDone: normalizeProbeStatus(probe.status) === PROBE_STATUS.DONE,
    blockers: strList(probe.blockers),
  };
}

// ===================== 七、渲染 =====================

const LEVEL_LABEL = {
  [GOAL_LEVELS.MAIN]: '主目标',
  [GOAL_LEVELS.FALLBACK]: '保底目标',
  [GOAL_LEVELS.TEMP]: '临时目标',
};
const TYPE_LABEL = {
  [TASK_TYPES.DEV]: '普通开发任务',
  [TASK_TYPES.CREATIVE]: '创作类任务',
  [TASK_TYPES.RESEARCH]: '调研/规则类任务',
};
const PROBE_LABEL = {
  [PROBE_STATUS.PENDING]: '未探测',
  [PROBE_STATUS.RUNNING]: '探测中',
  [PROBE_STATUS.DONE]: '探测完成',
};

function mark(v) { return v ? '☑' : '□'; }

/**
 * 把工单渲染成人能读的文本（也进 trace，出问题时能一眼看出当时按哪张工单在干活）。
 * 排版刻意贴老板模板的 11 项顺序 —— 他用这份文本对账，不是我另发明一套。
 */
function renderTicket(t) {
  const k = t && typeof t === 'object' ? t : {};
  const pref = k.preference || {};
  const goals = k.goals || {};
  const probe = k.probe || {};
  const disp = k.dispatch || {};
  const lv = normalizeLevel(k.level);
  const L = [];

  L.push('【任务工单｜版本号：' + (k.version || 'v1') + '】');
  L.push('工单ID：' + (k.ticketId || '（未提供）'));
  L.push('创建时间：' + (k.createdAt || '（未提供）'));
  L.push('更新时间：' + (k.updatedAt || '（未提供）'));
  L.push('');
  L.push('1. 原始用户需求');
  L.push(k.rawUserRequirement || '（未提供）');
  L.push('');
  L.push('2. 用户显性&隐性偏好');
  L.push(mark(pref.allowDegrade === true) + ' 允许降级：' + (pref.allowDegrade === true ? '是' : (pref.allowDegrade === false ? '否' : '未表态')));
  L.push(mark(pref.skeletonOnly) + ' 是否只要最简骨架：' + (pref.skeletonOnly ? '是' : '否'));
  // ★ 2026-11-04：这一项原来印「是否开启高风险并行校验：是/否」——
  //   名字里带"并行"，而全仓对这个字段**零个行为消费者**（没有调度、没有并发、
  //   没有第二路产出），第二个执行实例 `secondRunner.js` 是**顺序接替**。
  //   印在给人看的工单上就是承诺，所以改成如实表述：它是**意向记录**，不是开关。
  //   字段名 `pref.highRiskParallel` 故意保留（改它会打断 createTicket/renderTicket
  //   与多条既有 smoke 断言，收益为零）。
  L.push(mark(pref.highRiskParallel) + ' 是否要求更严格的独立复核（意向记录）：'
    + (pref.highRiskParallel ? '是' : '否')
    + (pref.highRiskParallel ? '（用户意愿；本版本无第二个执行者可派，见第 10 项说明）' : ''));
  L.push('其他偏好备注：' + (pref.note || '无'));
  L.push('');
  L.push('3. 任务分类标签');
  L.push(mark(k.taskType === TASK_TYPES.DEV) + ' 普通开发任务');
  L.push(mark(k.taskType === TASK_TYPES.CREATIVE) + ' 创作类任务（游戏/网页/PPT/UI/桌面宠物/交互 Demo 等）');
  L.push(mark(k.taskType === TASK_TYPES.RESEARCH) + ' 调研/规则类任务');
  if (k.taskType === TASK_TYPES.CREATIVE && pref.skeletonOnly !== true) {
    L.push('创作类附加标记：【需要先交付设计推演文档，确认后再开发】');
  }
  L.push('');
  L.push('4. 三层目标定义');
  const goalLine = (icon, key, label) => {
    const g = goals[key] || {};
    L.push(icon + ' ' + label + '：' + (g.text || '（未提供）'));
    L.push('> 能力：' + (g.capability || '（未提供）'));
    L.push('> 风险/成本：' + (g.riskCost || '（未提供）'));
  };
  goalLine('🎯', 'main', '主目标（用户理想完整版）');
  goalLine('🧩', 'fallback', '保底目标（主目标受阻时自动切换）');
  goalLine('📌', 'temp', '临时目标（代码产物完全无法产出时兜底）');
  L.push('');
  L.push('5. 当前生效目标等级（动态字段）');
  L.push(mark(lv === GOAL_LEVELS.MAIN) + ' 主目标  '
    + mark(lv === GOAL_LEVELS.FALLBACK) + ' 保底目标  '
    + mark(lv === GOAL_LEVELS.TEMP) + ' 临时目标');
  L.push('当前生效目标描述：' + (k.activeGoal || '（未提供）'));
  L.push('');
  L.push('6. 可行性探测结论');
  L.push('探测状态：' + (PROBE_LABEL[normalizeProbeStatus(probe.status)] || probe.status));
  L.push('探测结论：' + (probe.result || '（未回填）'));
  const bl = strList(probe.blockers);
  L.push('阻碍清单：' + (bl.length ? bl.join('；') : '无外部硬壁垒'));
  L.push('区分：' + (normalizeBarrierKind(probe.barrierKind) === BARRIER_KINDS.HARD
    ? '【外部硬壁垒（反爬/权限/账号/付费/风控）】'
    : (normalizeBarrierKind(probe.barrierKind) === BARRIER_KINDS.FIXABLE_BUG
      ? '【可修复bug】' : '（未区分）')));
  L.push('');
  L.push('7. 交付物清单（绑定当前生效目标，验收按这个核对）');
  const dl = strList(k.deliverables);
  if (dl.length) dl.forEach((d, i) => L.push('  ' + (i + 1) + ') ' + d));
  else L.push('（未提供）');
  L.push('');
  L.push('8. 验收标准引用');
  L.push('本次验收使用【' + (LEVEL_LABEL[lv] || lv) + '】对应的验收规则，参照 4 号验收自检清单。');
  L.push('');
  L.push('9. 升级回退条件（降级达标必填）');
  L.push(k.upgradeCondition || '（未提供）');
  L.push('');
  L.push('10. 调度与资源分配');
  L.push('主执行Agent：' + (disp.mainAgent || '（未指定）'));
  L.push('替补Agent：' + (disp.backupAgent || '（未指定）'));
  // ★★ 2026-11-04（第二轮）：上一轮"改表述"没有改干净 —— 这里仍然印着
  //   「并行模式：开启（双方案对比）」/「关闭」的三态，只是把触发字段换成了 `disp.parallel`。
  //   那句话正是老板点名要消除的「没有真实消费者却显示为已开启的双路替补功能」，
  //   而且它还让同一份工单自相矛盾：第 2 项已改印「（意向记录）」，第 10 项却还印「开启（双方案对比）」。
  //   ⇒ 三态打印**整行删除**，改成如实一句话。核证见本段之后的长注。
  L.push('并行/双路产出：本版本无此能力（全仓无双路编排；替补是**顺序接替**，不是并行）');
  L.push('  ⚠️ 以上「替补Agent / 并行」是**意图记录，本版本不据此执行**：'
    + '运行时不启动第二个执行者，也不做双方案择优（做了的是"续跑交接"：上一次留下的失败账'
    + '会在下一次运行开场交给它，见 handoffBrief）。');
  // 【核证：为什么敢删这一行（2026-11-04，grep 全仓逐点确认，不是听转述）】
  //   `dispatch.parallel` 在 `src/` 全目录只有两处被读：
  //     ① `createTicket` 的归一化（本文件第 246 行 `parallel: disp.parallel === true`，只写入不判读）；
  //     ② 本函数刚刚删掉的打印。
  //   没有任何 if 分支 / 调度 / 并发 / 预算分配读它 ⇒ 消费者为零。
  //   ⚠️ 别和 `backend.js` 的 `planParallel()` / `parallelPlan.parallel` 搞混：
  //     那是**同一轮内多个只读工具**的并发（`PARALLEL_SAFE_TOOLS` 白名单当前只有 web-fetch），
  //     有真实消费者，但和本项的"替补 / 双路产出择优"是两件完全不同的事。
  //   字段本身仍保留在工单结构里（`dispatch.parallel`），因为它进 `createTicket` 的归一化契约；
  //   这里删的是**打印**，不是字段。
  // ★ 2026-11-04（第三轮）：这里原来印 `Number.isFinite(Number(disp.retryLimit)) + ' 次'`
  //   —— `Number.isFinite(..)` 返回**布尔**，所以工单上实际印的是「同一点动作最多 **true** 次」。
  //   （这条 bug 在 2df0cb2^ 之前就存在，不是本轮引入；也没有任何门禁盯着这一行。）
  //   现在走 `normalizeRetryLimit()`：与 `createTicket` 用**同一条规则**，兜底值也是同一个
  //   `RETRY_LIMIT_ACCEPT`（不另发明数字），非有限值/缺失时绝不会印出 `NaN` 或 `true`。
  L.push('重试上限：同一点动作最多 ' + normalizeRetryLimit(disp.retryLimit) + ' 次'
    + '（验收判据上界；运行时真值是 ' + RETRY_LIMIT_RUNTIME + ' 次，见 RETRY_LIMIT_RUNTIME 注释）');
  L.push('');
  L.push('11. 备注、特殊约束');
  L.push(k.specialNote || '（无）');

  if (Array.isArray(k.history) && k.history.length) {
    L.push('');
    L.push('— 归档（旧工单，不丢弃）—');
    k.history.forEach((h, i) => {
      L.push((i + 1) + ') ' + (h.version || '?') + ' · ' + (LEVEL_LABEL[h.level] || h.level || '?')
        + (h.at ? ' · ' + h.at : '') + (h.reason ? ' · ' + h.reason : ''));
    });
  }
  return L.join('\n');
}

/**
 * 一句话摘要（给 trace / 日志用，别把 30 行工单塞进 trace）。
 * 例：`T2026110301 v2 · 调研/规则类 · 当前=保底目标 · 探测完成(硬壁垒) · 交付 3 项`
 */
function summariseTicket(t) {
  const k = t && typeof t === 'object' ? t : {};
  const lv = normalizeLevel(k.level);
  const probe = k.probe || {};
  const st = normalizeProbeStatus(probe.status);
  const bk = normalizeBarrierKind(probe.barrierKind);
  const barrier = bk === BARRIER_KINDS.HARD ? '硬壁垒' : (bk === BARRIER_KINDS.FIXABLE_BUG ? '可修bug' : '无壁垒');
  return [
    k.ticketId || '(no-id)',
    String(k.version || 'v1'),
    TYPE_LABEL[normalizeTaskType(k.taskType)] || '',
    '当前=' + (LEVEL_LABEL[lv] || lv),
    PROBE_LABEL[st] + '(' + barrier + ')',
    '交付 ' + strList(k.deliverables).length + ' 项',
  ].join(' · ');
}

module.exports = {
  TASK_TYPES,
  CREATIVE_KINDS,
  normalizeCreativeKind,
  GOAL_LEVELS,
  PROBE_STATUS,
  BARRIER_KINDS,
  RETRY_LIMIT_RUNTIME,
  RETRY_LIMIT_ACCEPT,
  TICKET_FIELDS,
  normalizeLevel,
  normalizeTaskType,
  normalizeProbeStatus,
  normalizeBarrierKind,
  createTicket,
  validateTicket,
  moveLevel,
  bumpVersion,
  ticketToAcceptanceContext,
  renderTicket,
  summariseTicket,
};
