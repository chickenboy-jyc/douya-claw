// 设计模具库（design molds）—— 把"要好看"翻译成可照抄的结构与数值。
// ============================================================================
// 老板原话（2026-11-03）：「AI 不会设计、没有美感」「每次做出来都一个样」
//                          「产品只造了一个模具」「变聪明这个你能不能去找点所谓的模具？」
//
// 【查证结论：模具存在，但接不上（2026-11-03，逐行核过）】
//   全仓唯一一处给出**可执行数值**的设计标准在 `src/main/experts.js:87`
//   （配色 60/30/10、字号 24-32/18-20/14-16px、间距 48-80px、圆角 12-16px、阴影 .06~.12）。
//   而真正被注入模型的 `douyaPersona.DOUYA_PERSONA_PROMPT`（11987 字）里
//   **一个 px、一个百分比都没有** —— 全是"要有设计感/要有呼吸感/别糊弄"这类形容词。
//
//   为什么 experts.js 那套进不了模型：`backend.js:2161` 的注入条件是 `if (payload.expert)`，
//   而 `App.jsx:1516` 把 `expertId` 写死成 `useState('')` 且**全仓无 setExpertId 调用**。
//   ⇒ general 专家的整段 systemPrompt（含那套硬指标）是死代码。
//   这是一笔现成的资产，接上就有，不需要重新发明。
//
// 【本模块做两件事】
//   ① 数值规格（TOKENS）作为**唯一真源**：experts.js 那段文字改为从这里生成，
//      避免"两处各写一份 60/30/10"——本仓对双真源漂移已有明确历史教训。
//   ② 结构模具（MOLDS）：**多个结构上真的不同**的版面骨架，按产出类型分组。
//      这一条直接对治"只造了一个模具"：之前每类产出只有一种骨架，
//      模型没有可选项，只能每次写出同一个东西。
//
// 【为什么模具要"多个"而不是"更好的一套"】
//   老板的判断：「如果几个 Agent 使用相同模型、相同上下文、相同判断方式，
//   它们可能只是集体犯同一个错误。」同理：把一套模具打磨得更精致，
//   仍然是每单产出同一副样子。要有变化，必须先有**可选集**。
//   所以这里的每一条 mold 都必须能与同组其它条在**结构**上区分开
//   （分区顺序 / 栏数 / 主视觉占比不同），而不是只在配色上不同。
//
// 【不变量（门禁 unit-design-molds 逐条钉住）】
//   ① TOKENS 的每个数值都必须出现在 `tokensProse()` 的正文里（规格不许写了不用）；
//      `buildMoldBrief` 在 `kinds` 含 `web` 时**默认**把这段规格带出去 —— 注意是"默认"，
//      不是"必须"：`includeTokens:false` 能把它关掉（实测 627 字 / px=0），
//      所以别把"含 web ⇒ 一定含 px"当不变量写断言（写了必红）。见 `buildMoldBrief` 那段注释；
//   ② 同一 kind 下 MOLDS 至少 3 条，且任意两条的 skeleton 相似度 < 0.7
//      （"换皮模具"不算第二个模具）；
//   ③ 正文必须要求"先选 2 个结构不同的候选、自己比较、自己定"，
//      且必须明写**不许把选择交给用户**（persona 明确禁止把选择题丢回用户）；
//   ④ PPT 不许在本模块另造一套版面 —— slides-generate 已有 8 种版面白名单，
//      再写一份就是双真源；
//   ⑤ 正文长度受控（≤1200 字）：注入块越长，真正要执行的那几句越被稀释。
'use strict';

/**
 * 数值规格。**唯一真源**：`experts.js` 里那段「网页设计硬指标」由 `tokensProse()` 生成，
 * 不许在两处各写一份数字。
 *
 * 每个值都是可核对的（px / 百分比 / 毫秒），刻意不写"适度""合理"这类无法核对的词 ——
 * 无法核对的约束等于没有约束，模型只能靠猜，而猜出来的东西每次都不一样。
 */
const DESIGN_TOKENS = {
  color: {
    // 60/30/10 是配色比例的行业惯例写法，不是本产品发明的
    ratio: { primary: 60, secondary: 30, neutral: 10 },
    maxHues: 4,
    // 明确禁止的两端：全灰阶看不到重点；色相过多看起来像调色盘
    forbid: '禁止全黑白无主色；禁止超过 4 个色相'
  },
  type: [
    { role: 'hero 大标题', px: [40, 56], weight: 700, lineHeight: 1.15 },
    { role: '页面标题', px: [28, 36], weight: 700, lineHeight: 1.2 },
    { role: '小节标题', px: [18, 20], weight: 600, lineHeight: 1.35 },
    { role: '正文', px: [15, 17], weight: 400, lineHeight: 1.7 },
    { role: '注释/标签', px: [12, 13], weight: 400, lineHeight: 1.5 }
  ],
  // 字号档数：少于 3 档 ⇒ 全文一个字号，读起来没有层次（这是"像机器做的"最直观的特征）
  minTypeSteps: 3,
  space: { grid: 8, section: [48, 80], cardPadding: [24, 32], containerMax: [1080, 1200] },
  radius: [12, 16],
  shadow: 'rgba(0,0,0,.06~.12)',
  motion: { hoverMs: [150, 220], ease: 'ease-out' }
};

/**
 * 结构模具。`skeleton` 是**分区顺序**（从上到下），刻意用同一套词表，
 * 这样"两条模具是否真的不同"可以被程序比对，而不是靠措辞感觉。
 *
 * 词表：nav 导航 / hero 主视觉 / cards 卡片组 / split 图文对开 / prose 正文流 /
 *       metrics 指标条 / table 表格 / quote 大字引语 / gallery 图墙 / cta 行动区 /
 *       footer 页脚 / timeline 时间轴 / compare 对照栏 / steps 步骤条 / form 表单
 */
const MOLDS = [
  // ---------- 网页 ----------
  {
    id: 'W1', kind: 'web', name: '首屏 + 三卡并列',
    skeleton: ['nav', 'hero', 'cards', 'split', 'cta', 'footer'],
    bestFor: '产品/服务落地页',
    avoidWhen: '数据密集或长文（卡片会把内容切碎）'
  },
  {
    id: 'W2', kind: 'web', name: '左右对开 · 交替',
    skeleton: ['nav', 'hero', 'split', 'split', 'cards', 'footer'],
    bestFor: '单一卖点反复展开',
    avoidWhen: '条目 >6（交替节奏失序）'
  },
  {
    id: 'W3', kind: 'web', name: '杂志多栏 · 错位',
    skeleton: ['nav', 'hero', 'prose', 'quote', 'gallery', 'footer'],
    bestFor: '品牌故事/深度内容',
    avoidWhen: '首屏就要看到价格或清单'
  },
  {
    id: 'W4', kind: 'web', name: '数据看板',
    skeleton: ['nav', 'metrics', 'table', 'cards', 'footer'],
    bestFor: '后台/报表/经营数据',
    avoidWhen: '没有真实数据（空看板最假）'
  },
  {
    id: 'W5', kind: 'web', name: '分步引导',
    skeleton: ['nav', 'hero', 'steps', 'steps', 'faq', 'cta', 'footer'],
    bestFor: '教程/安装/开通流程',
    avoidWhen: '内容无先后（会造出假顺序）'
  },
  // ---------- 海报 ----------
  {
    id: 'P1', kind: 'poster', name: '上图下文 · 中轴对称',
    skeleton: ['hero', 'prose', 'cta'],
    bestFor: '活动/通知（一眼看完）',
    avoidWhen: '文字 >60 字（变一堵墙）'
  },
  {
    id: 'P2', kind: 'poster', name: '左文案 · 右主视觉',
    skeleton: ['split', 'cta'],
    bestFor: '有明确主图（人像/产品）',
    avoidWhen: '无主图（右半空色）'
  },
  {
    id: 'P3', kind: 'poster', name: '九宫格信息墙',
    skeleton: ['hero', 'gallery', 'footer'],
    bestFor: '价目表/项目清单',
    avoidWhen: '条目 <4 或文字 >12 字（撑破格子）'
  },
  {
    id: 'P4', kind: 'poster', name: '大数字 · 单主张',
    skeleton: ['hero', 'prose'],
    bestFor: '单一数字即全部卖点',
    avoidWhen: '多个同等重要的数字（互相抢）'
  },
  // ---------- 长图 ----------
  {
    id: 'L1', kind: 'longimage', name: '分段卡片流',
    skeleton: ['hero', 'cards', 'cards', 'cta'],
    bestFor: '操作指引/多要点科普',
    avoidWhen: '要点有先后依赖（看不出顺序）'
  },
  {
    id: 'L2', kind: 'longimage', name: '时间轴',
    skeleton: ['hero', 'timeline', 'cta'],
    bestFor: '历程/周期/阶段计划',
    avoidWhen: '内容是并列关系（会编出假顺序）'
  },
  {
    id: 'L3', kind: 'longimage', name: '三栏对照',
    skeleton: ['hero', 'compare', 'cta'],
    bestFor: '方案/新旧/套餐对比',
    avoidWhen: '只有一个对象（空两栏）'
  }
];

/**
 * 产出类型 → 可用模具。**PPT 故意返回空**：版面白名单在
 * `skills/slides-generate` 自己的 manifest 里（8 种 layout + 铁律），
 * 本模块再列一份就是双真源，迟早漂移。
 * @param {string} kind  web | poster | longimage | ppt | visual | game
 * @returns {Array}
 */
function moldsFor(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'ppt' || k === 'slides' || k === 'presentation') return [];
  return MOLDS.filter((m) => m.kind === k);
}

/**
 * 网页设计硬指标的中文段落 —— **experts.js 那段的唯一真源**。
 * 改数字只改 `DESIGN_TOKENS`，文字自动跟着变；两处各写一份才是真正的坑。
 * @returns {string}
 */
function tokensProse() {
  const c = DESIGN_TOKENS.color;
  const t = DESIGN_TOKENS.type;
  const sp = DESIGN_TOKENS.space;
  const r = DESIGN_TOKENS.radius;
  const g = (x) => (Array.isArray(x) ? x[0] + '-' + x[1] : String(x));
  const byRole = (role) => t.filter((x) => x.role.indexOf(role) >= 0)[0] || { px: [0, 0] };
  return '配色：主色+辅助色+中性色三色体系，主色占比 ' + c.ratio.primary + '%、辅助 '
    + c.ratio.secondary + '%、中性 ' + c.ratio.neutral + '%，' + c.forbid + '；'
    + '字体：hero 标题 ' + g(byRole('hero').px) + 'px、页面标题 ' + g(byRole('页面').px)
    + 'px、小节标题 ' + g(byRole('小节').px) + 'px、正文 ' + g(byRole('正文').px)
    + 'px、注释与标签 ' + g(byRole('注释').px) + 'px，行高 1.6-1.8，全文至少 '
    + DESIGN_TOKENS.minTypeSteps + ' 档字号；'
    + '间距：8px 栅格，区块间距 ' + g(sp.section) + 'px、卡片内边距 ' + g(sp.cardPadding)
    + 'px、圆角 ' + g(r) + 'px、阴影 ' + DESIGN_TOKENS.shadow + '；'
    + '动效：hover 过渡 ' + g(DESIGN_TOKENS.motion.hoverMs) + 'ms ' + DESIGN_TOKENS.motion.ease + '。';
}

/**
 * 生成注入模型的设计模具说明。
 *
 * @param {{kinds?: string[], includeTokens?: boolean}} [o]
 *   `kinds` 为本次可能要做的产出类型；不给就全给（宁可多给几条可选项，
 *   也不要在运行时判错类型导致整段模具消失——那是"功能在但从不触发"的典型形态）。
 *   `includeTokens` 是否带**网页数值规格**。不传时**由 `kinds` 推导**（含 web 才带）；
 *   显式传 `true` / `false` 时以显式值为准 —— 留一个逃生口，但默认不再无条件跟随。
 * @returns {string}
 */
function buildMoldBrief(o) {
  const opt = (o && typeof o === 'object') ? o : {};
  const kinds = Array.isArray(opt.kinds) && opt.kinds.length
    ? opt.kinds.map((k) => String(k || '').trim().toLowerCase())
    : ['web', 'poster', 'longimage'];

  // ★ 数值规格按需跟随（2026-11-04 修实证缺陷②）。
  //   修前是 `opt.includeTokens !== false` —— 恒为 true ⇒ 只要 inject 为真，
  //   网页的 px/百分数规格**一定**被注入，哪怕本次 kinds 只有 poster / longimage / ppt。
  //   而 `TOKENS` 里每一个数字都是**网页**的硬指标（首屏 hero 40-56px、容器 1080-1200px、
  //   hover 过渡 150-220ms…）：海报是一张固定画布、长图是一条竖切流、PPT 是版面白名单，
  //   三者用的都不是这套 px 语言。把网页尺寸硬塞进海报任务，模型只会按"网页那一屏"去想，
  //   产出反而更不像海报 —— 注入的规格和当前产出物对不上，就是噪音。
  //   最荒唐的是 ppt 分支：`moldsFor('ppt')` 返回空数组，修前注入的正文里**一条模具都没有**，
  //   只有一大段网页数值规格 + 一句"不用上表"。
  //   ⇒ 默认值改为由 kinds 推导；显式传布尔值时仍以显式值为准（逃生口保留）。
  const includeTokens = (typeof opt.includeTokens === 'boolean')
    ? opt.includeTokens
    : kinds.indexOf('web') >= 0;

  const L = [];
  // 分节序号按**实际存在的小节**递增 —— 不带数值规格时不许出现"一、"缺失却从"二、"开始，
  // 也不许出现只有标题、底下一行没有的空分节（模型会去猜那节是不是被截断了）。
  const CN_NUM = ['一', '二', '三', '四', '五', '六'];
  let secNo = 0;
  const nextHead = (title) => {
    const n = CN_NUM[secNo] || String(secNo + 1);
    secNo += 1;
    return n + '、' + title;
  };

  L.push('【设计模具库 · 先选结构再动手】');
  if (includeTokens) {
    L.push(nextHead('数值规格（硬指标）：'));
    L.push('   ' + tokensProse());
  }

  // 先把结构小节的行攒出来，**非空才落标题**（空分节标题比没有更糟）。
  const struct = [];
  const KIND_LABEL = { web: '网页', poster: '海报', longimage: '长图' };
  for (const k of kinds) {
    const list = moldsFor(k);
    if (!list.length) continue;
    struct.push('   ' + (KIND_LABEL[k] || k) + '：');
    // 每行压成一句：id+名 · 分区 · 宜 · 忌。
    // ★ 为什么压这么狠：注入块里"看起来有用的说明"越多，真正要执行的那三句越被稀释，
    //   而模型对长 system 的遵守率是下降的。这里宁可像清单，不要像文章。
    for (const m of list) {
      struct.push('     ' + m.id + ' ' + m.name + ' · ' + m.skeleton.join('→')
        + ' · 宜' + m.bestFor + ' · 忌' + m.avoidWhen);
    }
  }
  if (kinds.indexOf('ppt') >= 0) {
    struct.push('   演示文稿：**不用上表**，用「生成演示文稿（网页版）」自带的 8 种版面'
      + '（bullets/cards/stats/compare/steps/quote/image/section），那里已有必填字段与反单调铁律。');
  }
  if (struct.length) {
    L.push(nextHead('可选结构（一个方向一条，三个不许共用）：'));
    for (const line of struct) L.push(line);
  }

  // ★★ 2026-11-10 老板改口径：从"自己选一个"改成"**先给用户 3 个带轴值的方向，让他选**"。
  //
  //   老板原话：「它只有一条生成路径，而一条路径必然收敛到均值。一次生成 = 取所有做法的平均。
  //   所以它永远给你"通用方案"——不是它笨，是它没有分叉。」
  //   他还点了上一版写法的死穴：「每个方向必须有"轴值"，不能只写"风格 A/B/C"——那还是同一套东西换名字。」
  //
  //   旧口径（"自己选，不许把选择交给用户"）当初是为治「豆芽动不动就问 A 还是 B，什么都不做」。
  //   但设计恰好相反：客户对"好看"没有统一答案，AI 自己选的那一个必然是均值。所以把两类选择切开：
  //     · **设计方向（审美取向）** ⇒ 必须交给用户选，3 选 1，只问这一次；
  //     · **技术实现（端口/目录/框架/参数）** ⇒ 仍然一个字都不许问。
  //   这不是推翻旧规矩，是给它划一条例外线。
  //
  //   ⚠️ 这一段**不许出现任何字面样例**（具体的 hex / px / 模具 id）：
  //     写个样例最省事，但它会被原样带进每一个 kinds —— 只判出海报的任务里出现 "W1"、
  //     只判出长图的任务里出现网页 px 规格，门禁 G5/H3/H5b/H7b 会当场红，而且那确实是错：
  //     注入的内容必须只跟当前产出类型有关；样例属于"看起来有用、实际在泄漏别的类型"。
  L.push(nextHead('三步走（**必须**走完）'));
  L.push('   1) **只出方向不写代码**：3 个方向各填满五轴，轴名原样、值用「｜」隔 —— '
    + '「布局：<上表 id 与名>｜配色：ink/bg/accent 三个具体色值(主色占比)｜'
    + '圆角：数值带单位+字号档｜参考：能认出的参照+为什么像｜一句话：做什么、给谁看」。'
    + '缺一轴=没做完；三个【布局】必须三条不同结构，只换配色/换标题=换名字，不算方向。');
  L.push('   2) **等用户选**：3 个方向原样给他挑一个（可"选 2 配色用 3"），'
    + '再把选中的展开成 tokens：墨色/底色/主色/字号档/间距/圆角/留白比例。');
  L.push('   3) **只许消费这套 tokens**：交付前数一遍每个 token 的字面值在产物里出现几次'
    + '（颜色至少两处）；哪项 0 次=没兑现，回去重做。相邻两屏不许同结构。');
  L.push('   ⚠️ 只问设计方向、只问一次；技术实现（端口/目录）不问用户。');
  return L.join('\n');
}

/**
 * 「一个方向必须填满的 5 个轴」。**顺序即格式**：解析和渲染都按这个顺序来，
 * 因为下游要靠它机械判定"三个方向是不是真的不同"（见 `checkDirections`）。
 *
 * 老板原话（2026-11-10）：「每个方向必须有"轴值"，不能只写"风格 A/B/C"——那还是同一套东西换名字。」
 * 所以这五个轴刻意都是**可核对的**：结构 id、hex、px、可认出的参照。
 * 不写"高级感/呼吸感"这种词，因为那种词写三遍也不产生差异。
 */
const DIRECTION_SLOTS = ['布局', '配色', '圆角', '参考', '一句话'];

/**
 * 模具相似度（0~1）：按分区顺序的最长公共子序列占比。
 *
 * ★ 为什么需要它：门禁要能机械判定"这两条模具是不是换皮"。
 *   "看起来不一样"不行——那正是老板批的"换颜色、换标题冒充"。
 *   结构不同的唯一可核对口径就是分区序列不同。
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function moldSimilarity(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (!x.length || !y.length) return 0;
  // LCS 长度
  const dp = [];
  for (let i = 0; i <= x.length; i += 1) dp.push(new Array(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      dp[i][j] = x[i - 1] === y[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

// ============================================================================
// 选择性注入闸门（2026-11-03 第二版）
// ============================================================================
// 老板原话：「我建议检查 backend 无条件注入设计模具的做法。设计规范应该在网页、海报、PPT
//   等相关任务中注入，不应该让普通问答、代码调试也携带整套设计上下文。」
//
// 【我上一版为什么写成无条件，以及那条理由错在哪】
//   上一版注释写的是「判错一次整段模具就静默消失，那是本仓反复出现的『功能在、但从不触发』，
//   所以宁可多给」。这句话的**前半是对的**（漏判的代价确实高），但结论下错了：
//   它把一个"判据可能出错"的问题，用"干脆不判"来回避，代价是**每一次问答都多背 1.5K 字
//   跟当前任务无关的设计规格**。而本仓真正的病史不是"判了但判错"，是"判据写了但没人接线"
//   —— 那要靠**门禁钉住调用点**解决，不靠取消判据解决。
//
// 【这一版怎么同时防"判错"和"从不触发"】
//   ① 判据是**纯函数**，喂一批真实说法就能逐条断言（门禁 unit-design-molds 的 G 组）；
//   ② 判定结果**连同命中词一起落 trace**（`phase:'gate'`），事后能数出"这条判据
//      漏了多少次、误开过多少次" —— 这才是可取证的做法，而不是把风险摊进上下文；
//   ③ 判据**偏向召回**：只要出现设计名词 + 任何创作信号（动词/量词/设计词），就注入；
//      名词在、信号弱、又无代码词时**也注入**（`noun-only-lean-inject`）。
//   ④ 复用已存在的执行模式判定（`intentGate.classifyIntent` 的 QUESTION / DIAGNOSE）——
//      老板点名的"普通问答、代码调试"恰好就是这两种模式，不需要我另造一套分类。
//
// 【为什么"设计名词 + 创作信号"要用邻近窗口，而不是全篇共现】
//   反例：「这个网页报错怎么修」——「网页」和「修」全篇共现，但它显然不是设计任务。
//   所以动词必须落在名词的邻近窗口内，且**排除**「修 / 调 / 查 / 为什么 / 报错」这类诊断词。
//   这条区分是门禁 G 组的核心反控。

/** 产出类型 → 关键词。刻意收**用户真会说的名词**，不收"界面""UI"这种太泛的词。 */
const DESIGN_NOUNS = [
  { kind: 'web', words: ['落地页', '官网', '首页', '介绍页', '产品页', '专题页', '单页', '网页', '页面', '网站', '站点', 'landing page'] },
  { kind: 'poster', words: ['海报', '宣传图', '朋友圈图', '封面图', '易拉宝', '展架', 'banner', '主视觉', '灯箱'] },
  { kind: 'longimage', words: ['长图', '长图文', '详情长图', '信息长图', '长海报'] },
  { kind: 'ppt', words: ['PPT', 'pptx', '幻灯片', '演示文稿', '演示稿', '路演稿', '汇报稿', '课件'] }
];

/**
 * 创作信号（动词/量词）。**刻意不收「修 / 调 / 查」**——那三个属于诊断，不是创作。
 * ⚠️ 每个词都必须足够长，避免单字噪声：「出」留给"出一版"这类，单独的"出"不进表。
 */
const CREATE_SIGNALS = [
  '做', '弄', '搞', '设计', '画', '生成', '制作', '搭一个', '搭个', '写一个', '写个',
  '出一版', '出一张', '来一', '美化', '改版', '重做', '换风格', '一套', '一版', '一份', '一张', '一页'
];

/** 设计词：出现即视为设计任务（即使附近没有动词）。「太丑」「很土」是老板的原话级反馈。 */
const DESIGN_WORDS = [
  '好看', '美观', '设计感', '美感', '颜值', '高级感', '太丑', '很土', '大气',
  '配色', '版式', '排版', '视觉', '风格'
];

/** 诊断/代码信号：与设计名词共现、且**没有**创作信号或设计词时，判为代码任务。 */
const CODE_WORDS = [
  '报错', '日志', '堆栈', '异常', '崩溃', 'bug', 'Bug', 'BUG', '接口', '数据库',
  '函数', '脚本', '编译', '单元测试', '部署', '服务器', '依赖', '配置文件', '正则',
  '性能', '内存', '端口', '控制台', '环境变量', 'npm', 'git', '为什么', '怎么修'
];

/** 创作信号与设计名词之间允许的最大字符距离（含中间内容）。 */
const SIGNAL_WINDOW = 10;

/**
 * 这一步是不是设计/创作产出任务；若是，产出该注入哪些类型。
 *
 * @param {{text?: string, mode?: string}} [input]
 *   `text` = **本轮真实用户消息**（调用方传 `lastRealUserText`，不要传整段历史：
 *     历史里只要提过一次"网页"，此后每轮都会命中，等于变回无条件注入）。
 *   `mode` = `intentGate` 的 QUESTION / DIAGNOSE / PLAN / EXECUTE。
 * @returns {{inject: boolean, kinds: string[], reason: string, nouns: string[], signals: string[]}}
 *   `reason` 直接进 trace，是"这条判据有没有判错"的唯一取证路径。
 */
function gateDesignIntent(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const t = String(i.text == null ? '' : i.text);
  // ★★ 大小写不敏感（2026-11-04 修实证缺陷①）。
  //   修前 `DESIGN_NOUNS` 里 ppt 相关只有 `'PPT'` / `'pptx'`，而命中判断用的是
  //   `t.indexOf(w)` —— **区分大小写**。于是用户说「做份ppt，给院长汇报」时：
  //   名词不命中、又没有设计词 ⇒ 直接返回 `no-design-noun`，**一条模具都不注入**，
  //   连"演示文稿不用上表、用自带 8 种版面"那句提示都没有。这是典型的"判据写了但判漏"。
  //
  //   ⚠️ 只改**比较方式**，不动任何词条内容（`DESIGN_NOUNS` / `CREATE_SIGNALS` /
  //   `DESIGN_WORDS` / `CODE_WORDS` 一个字都不改）：词条是业务口径，大小写是实现细节。
  //   ⚠️ 四张表**必须同时不敏感**，否则会出现"名词不敏感但代码词敏感"的不对称：
  //   那会让「修个PPT的bug」判成设计任务（bug 没命中），比修前更糟。
  //   ⚠️ 索引 `at` / `end` 都是**小写文本坐标系**里的位置，只用于邻近窗口的距离计算，
  //   不用于回切原文，所以不受大小写改写影响。
  //
  //   ★★ 已知影响**不只 ppt 一个方向**（2026-11-04 第二轮，独立验收方逐条比对后补记）。
  //   小写化会同时让含**大写**英文的行命中，于是这个闸门的行为变化有两个方向：
  //     (a) 召回扩大（缺陷①想修的）：`做份ppt` / `做个Ppt` / `用 BANNER 做张图`
  //         由 `no-design-noun` 翻成命中 —— 这些是真收获。
  //     (b) **召回收缩（有意，且方向在语义上更对，但必须写明）**：`npm` / `git` 在
  //         `CODE_WORDS` 里只有小写词条，旧版对 `NPM` / `GIT` 不命中 ⇒ 落到偏召回分支；
  //         小写化后命中 ⇒ 判为代码任务。已实测的两条具体影响：
  //           · `这个网页 NPM 起不来`：旧 `true/web/noun-only-lean-inject` → 新 `false/code-task`
  //           · `网站 GIT 拉不下来`：  旧 `true/web/noun-only-lean-inject` → 新 `false/code-task`
  //         这是**有意的召回收缩**（"服务起不来/拉不下来"本来就是诊断，不该带设计规格），
  //         但它们属于 web 类，所以**不许再声称"web/poster/longimage 三类判定逐条未变"**。
  //         门禁 H11 把这两条当前判定钉死；谁再动 `CODE_WORDS` 会立刻看到。
  //     (c) 另有一批**误召回**（`打不开`/`导出`/`转成`/`在哪` 不在 `CODE_WORDS` 里）：
  //         `这个ppt打不开` / `ppt 怎么导出成pdf` / `把ppt转成pdf` / `昨天那个ppt文件在哪`
  //         由不注入变为注入 321 字模具。**本轮不修**，登记为已知误召清单（门禁 H12 只记录读数，不判红）。
  const tLower = t.toLowerCase();
  const mode = String(i.mode || '').toUpperCase();
  const out = (inject, kinds, reason, nouns, signals) => ({
    inject: !!inject, kinds: kinds || [], reason, nouns: nouns || [], signals: signals || []
  });
  const uniqKinds = (arr) => {
    const r = [];
    for (const k of arr) if (r.indexOf(k) < 0) r.push(k);
    return r;
  };

  if (!t.trim()) return out(false, [], 'empty-text');
  // ★ 老板点名的两类：普通问答（QUESTION）、代码/日志诊断（DIAGNOSE）。
  //   复用已有判定，不另造分类 —— 这两类的语义与本闸门要挡的东西完全重合。
  if (mode === 'QUESTION' || mode === 'DIAGNOSE') return out(false, [], 'non-exec-mode:' + mode);

  // 每个类型的关键词命中位置（一个词可能在多处出现，全取）
  const nounHits = [];
  for (const g of DESIGN_NOUNS) {
    for (const w of g.words) {
      const wl = w.toLowerCase();
      let from = 0;
      for (;;) {
        const at = tLower.indexOf(wl, from);
        if (at < 0) break;
        nounHits.push({ kind: g.kind, word: w, at, end: at + wl.length });
        from = at + wl.length;
      }
    }
  }
  const signalHits = [];
  for (const w of CREATE_SIGNALS) {
    const wl = w.toLowerCase();
    let from = 0;
    for (;;) {
      const at = tLower.indexOf(wl, from);
      if (at < 0) break;
      signalHits.push({ word: w, at, end: at + wl.length });
      from = at + wl.length;
    }
  }
  /**
   * 词表命中：**按小写去重**，保留首次出现的词面（trace 里仍看得懂）。
   *
   * ★ 为什么非去重不可（2026-11-04 第二轮，独立验收方实测）：`CODE_WORDS` 里
   *   `'bug' / 'Bug' / 'BUG'` 三条同义并存（历史留下的兜底写法，本轮不动词条）。
   *   旧版按原样比对，一次命中只记 1 条；全小写化后三条都能命中 ⇒ 一次命中被记成 **3 条**。
   *   分支只判 truthy 所以**结论不变**，但 `codeWordHit` 会作为 `signals` 进 trace
   *   （`backend.js` 的 design-mold 记录），于是"这条判据命中了几个代码词"这个回查口径
   *   从此恒虚增 3 倍 —— 事后拿 trace 统计漏判/误开时会直接读错。
   *   实测修前：`修个PPT的bug` → `["bug","Bug","BUG"]`（应为 1 条）。
   */
  const matchWords = (table) => {
    const res = [];
    const seen = new Set();
    for (const w of table) {
      const wl = String(w).toLowerCase();
      if (seen.has(wl)) continue;
      if (tLower.indexOf(wl) < 0) continue;
      seen.add(wl);
      res.push(w);
    }
    return res;
  };
  const designWordHit = matchWords(DESIGN_WORDS);
  const codeWordHit = matchWords(CODE_WORDS);

  if (!nounHits.length) {
    // 没有名词但出现设计词（「这个太丑了，帮我弄好看点」）⇒ 纯审美反馈，判不出产出类型
    // ⇒ 给全量候选（这是唯一还保留"全给"的分支，因为这里真的判不出类型）。
    if (designWordHit.length) return out(true, ['web', 'poster', 'longimage'], 'design-word-only', [], designWordHit);
    return out(false, [], 'no-design-noun', [], codeWordHit);
  }

  // 每个名词命中点：附近有创作信号才算"要我做这个"
  const accepted = [];
  for (const h of nounHits) {
    const near = signalHits.filter((s) =>
      Math.abs(s.at - h.end) <= SIGNAL_WINDOW || Math.abs(h.at - s.end) <= SIGNAL_WINDOW);
    if (near.length) accepted.push({ kind: h.kind, word: h.word, signal: near[0].word });
  }

  if (accepted.length) {
    return out(true, uniqKinds(accepted.map((a) => a.kind)), 'noun+signal',
      accepted.map((a) => a.word), accepted.map((a) => a.signal));
  }
  // 设计词（配色/排版/好看…）压过"没有动词"：老板的抱怨通常就是这种形态
  if (designWordHit.length) {
    return out(true, uniqKinds(nounHits.map((h) => h.kind)), 'noun+design-word',
      nounHits.map((h) => h.word), designWordHit);
  }
  // 名词在、但既无创作信号也无设计词，且带代码/诊断词 ⇒ 判为代码任务，不注入
  if (codeWordHit.length) return out(false, [], 'code-task', nounHits.map((h) => h.word), codeWordHit);
  // 名词在、无信号、也无代码词 ⇒ **偏召回，注入**。理由见头注③：漏判代价 > 多注入 1K 字。
  return out(true, uniqKinds(nounHits.map((h) => h.kind)), 'noun-only-lean-inject',
    nounHits.map((h) => h.word), []);
}

/**
 * 解析「三个方向」的正文，返回结构化候选。
 *
 * 为什么要有解析器而不是"让复核员看着判"：老板点的死穴是**换名字冒充三个方向**。
 * 那件事只有机械比对才抓得住（三个"风格 A/B/C"在文字上长得完全不一样，
 * 但轴值会一模一样）。所以格式必须固定到可解析：一个方向一行，轴之间用「｜」分隔。
 *
 * 容错的三种小变体（真模型一定会写出来）：`【方向A】` / `【方向 1】` / `## 方向B`；
 * 轴名后允许全角/半角冒号；轴值里出现「｜」以外的分隔符一律当成值的一部分。
 *
 * @param {string} text
 * @returns {Array<{tag:string, slots:Object<string,string>}>}
 */
function parseDirections(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const out = [];
  const lines = s.split('\n');
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 方向标题：允许 "【方向A】" / "【方向 1】" / "方向B：" / "## 方向 1" / "方案C 布局 W2…"
    // ★ 标题后面**不一定有冒号**：模型经常写成 `## 方向 2` 独占一行、或者
    //   `方案C 布局 W2…` 直接接内容。第一版要求必须带「：」/「】」，
    //   于是那两种写法的整行都被当成上一个方向的续行 ⇒ 只解析出 1 个方向（实测 D08 红）。
    //   现在的判据：认到「方向/方案 + 标号」之后，**余下部分为空、或以五轴之一开头、
    //   或含「｜」**，才算标题；否则当续行（避免把正文里"方向是从上到下"这种句子当标题）。
    const head = line.match(/^[#*\s]*(?:【\s*(?:方向|方案)\s*([A-Za-z0-9一二三1-3])\s*】|(?:方向|方案)\s*([A-Za-z0-9一二三1-3])\s*[】]?\s*[：:]?)/);
    const rest = head ? line.slice(head[0].length).trim() : '';
    const isHead = !!head && (rest === ''
      || DIRECTION_SLOTS.some((k) => rest.indexOf(k) === 0)
      || rest.indexOf('｜') >= 0 || rest.indexOf('|') >= 0);
    if (isHead) {
      cur = { tag: line.slice(0, 24), slots: {}, rest };
      out.push(cur);
      if (rest) fillSlots(cur, rest);
      continue;
    }
    if (cur) fillSlots(cur, line);
  }
  return out.map((d) => ({ tag: d.tag, slots: d.slots }));

  /** 把 "布局：W1｜配色：ink#111" 这样的片段写进 slots（同名轴后者覆盖前者）。 */
  function fillSlots(d, chunk) {
    const parts = String(chunk).split(/[｜|]/);
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      // ★ 冒号**可选**：模型两种都爱写（"布局：W1" / "布局 W1"）。
      //   第一版这里要求必须有冒号，于是所有"布局 W1…"的行被整行丢掉，
      //   解析出 3 个"全轴都缺"的方向 —— 判据本身没坏，是解析太挑。
      const slot = DIRECTION_SLOTS.find((k) => t.indexOf(k) === 0);
      if (!slot) continue;
      const val = t.slice(slot.length).replace(/^\s*[：:]\s*/, '').trim();
      if (!val) continue;
      d.slots[slot] = val;
    }
  }
}

/** 从「布局」值里抠出结构 id（W1/P2/L3…）。抠不到返回 ''。 */
function moldIdOf(value) {
  const m = String(value == null ? '' : value).match(/\b([WPL])\s*([1-9])\b/i);
  return m ? (m[1].toUpperCase() + m[2]) : '';
}

/** 从「配色」值里抠出全部 hex（小写化，去重）。 */
function hexesOf(value) {
  const s = String(value == null ? '' : value);
  const out = [];
  const re = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
  let m = re.exec(s);
  while (m) {
    const h = ('#' + m[1]).toLowerCase();
    if (out.indexOf(h) < 0) out.push(h);
    m = re.exec(s);
  }
  return out;
}

/** 从「圆角」值里抠出 px 数值（"14px/字号 15-52" ⇒ 14）。 */
function radiusOf(value) {
  const m = String(value == null ? '' : value).match(/(\d+(?:\.\d+)?)\s*px/);
  return m ? Number(m[1]) : null;
}

/**
 * 机械判定「这三个方向是不是真的三个方向」。
 *
 * 判据（每条都能被一条假数据打红，见 `unit-design-directions.mjs`）：
 *   ① 必须正好 3 个方向；
 *   ② 每个方向 5 个轴**全填**（缺一个 = 没做完，不是"风格差异"）；
 *   ③ 两两之间「布局」的结构 id 必须不同 —— 这条最硬：同 id = 同一套骨架换个皮；
 *   ④ 两两之间至少 **2 个轴**的值不同（允许"选 2 但配色用 3"这种局部借用，
 *      但不允许只改一个轴就号称两个方向）。
 *
 * @param {string} text 模型输出的方向清单原文
 * @returns {{ok:boolean, count:number, problems:string[], dirs:Array}}
 */
function checkDirections(text) {
  const dirs = parseDirections(text);
  const problems = [];
  if (dirs.length !== 3) {
    problems.push('方向个数=' + dirs.length + '，必须正好 3 个（老板口径：一次生成 = 取平均，所以要三次分叉）');
  }
  for (let i = 0; i < dirs.length; i += 1) {
    const miss = DIRECTION_SLOTS.filter((k) => !dirs[i].slots[k]);
    if (miss.length) problems.push('第 ' + (i + 1) + ' 个方向缺轴：' + miss.join('、'));
  }
  // 布局必须两两不同（用结构 id 比对；抠不到 id 就退回整串比对）
  const lay = dirs.map((d) => {
    const v = d.slots['布局'] || '';
    return moldIdOf(v) || v;
  });
  for (let i = 0; i < lay.length; i += 1) {
    for (let j = i + 1; j < lay.length; j += 1) {
      if (lay[i] && lay[i] === lay[j]) {
        problems.push('方向 ' + (i + 1) + ' 与 ' + (j + 1) + ' 的【布局】相同（' + lay[i] + '）⇒ 同一套骨架换皮，不算两个方向');
      }
    }
  }
  // 至少 2 个轴不同
  for (let i = 0; i < dirs.length; i += 1) {
    for (let j = i + 1; j < dirs.length; j += 1) {
      const diff = DIRECTION_SLOTS.filter((k) => String(dirs[i].slots[k] || '') !== String(dirs[j].slots[k] || ''));
      if (diff.length && diff.length < 2) {
        problems.push('方向 ' + (i + 1) + ' 与 ' + (j + 1) + ' 只有 1 个轴不同（' + diff.join('、') + '）⇒ 差异太小');
      }
    }
  }
  return { ok: problems.length === 0, count: dirs.length, problems, dirs };
}

/**
 * 把选中的那个方向展开成 design tokens（第二步的产物）。
 *
 * 为什么由代码展开、不让模型自己写一遍：模型写 tokens 时会**顺手美化**
 * （把一个 #1E8E52 改成 #22A05C 之类），于是"选的方向"和"实现的东西"悄悄不是同一个。
 * 这里只做**抠取**，不做创作：抠不出来的项留空，由调用方如实报错，不编。
 *
 * @param {object} dir `parseDirections()` 返回的一项
 * @returns {{ink:string, bg:string, accent:string, accentRatio:number|null, radius:number|null, raw:object}}
 */
function tokensFromDirection(dir) {
  const slots = (dir && dir.slots) || {};
  const hexes = hexesOf(slots['配色']);
  const ratioM = String(slots['配色'] || '').match(/(\d{1,2})\s*%/);
  return {
    // 顺序约定：第一个 hex = ink（墨色/正文），第二个 = bg（底），第三个 = accent（主色）
    ink: hexes[0] || '',
    bg: hexes[1] || '',
    accent: hexes[2] || hexes[0] || '',
    accentRatio: ratioM ? Number(ratioM[1]) : null,
    radius: radiusOf(slots['圆角']),
    raw: slots,
  };
}

/**
 * 数一遍「这套 tokens 在产物里出现了几次」—— 第三步的验收口径。
 *
 * 老板原话：「验收只查一件事：这些颜色/间距值在产物里出现多少次。没出现 = 回到通用模板了。」
 * 所以这个函数只做一件事：把每个 token 的**字面值**在产物里数出来，不猜、不近似。
 *
 * @param {string} artifact 产物源码（HTML/CSS/JSX 都行，按字面找）
 * @param {object} tokens `tokensFromDirection()` 的结果
 * @param {{minPerToken?: number}} [opts] 每个 token 至少出现几次（默认 2：定义一次 + 用到一次）
 * @returns {{ok:boolean, counts:object, missing:string[]}}
 */
function countTokenUse(artifact, tokens, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const min = Number(o.minPerToken) > 0 ? Number(o.minPerToken) : 2;
  const hay = String(artifact == null ? '' : artifact).toLowerCase();
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  const counts = {};
  const missing = [];
  const pairs = [
    ['ink', t.ink],
    ['bg', t.bg],
    ['accent', t.accent],
  ];
  for (const [k, v] of pairs) {
    if (!v) { missing.push(k + '（没选出来，无法验收）'); continue; }
    const n = hay.split(String(v).toLowerCase()).length - 1;
    counts[k] = n;
    if (n < min) missing.push(k + '=' + v + ' 只出现 ' + n + ' 次（要求 ≥' + min + '）');
  }
  if (t.radius !== null && t.radius !== undefined) {
    const n = hay.split(String(t.radius) + 'px').length - 1;
    counts.radius = n;
    if (n < min) missing.push('radius=' + t.radius + 'px 只出现 ' + n + ' 次（要求 ≥' + min + '）');
  }
  return { ok: missing.length === 0, counts, missing };
}

module.exports = {
  DESIGN_TOKENS,
  MOLDS,
  DIRECTION_SLOTS,
  moldsFor,
  tokensProse,
  buildMoldBrief,
  moldSimilarity,
  gateDesignIntent,
  parseDirections,
  checkDirections,
  tokensFromDirection,
  countTokenUse,
  moldIdOf,
  hexesOf,
  radiusOf,
  DESIGN_NOUNS,
  CREATE_SIGNALS,
  DESIGN_WORDS,
  CODE_WORDS
};
