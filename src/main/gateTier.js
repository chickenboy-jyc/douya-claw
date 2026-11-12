/**
 * gateTier.js —— 「这一轮该怎么打扰用户」的**唯一判据**（2026-11-09 新增）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 要钉住的缺陷
 * ═══════════════════════════════════════════════════════════════════════
 *   现状是**一个全局布尔** `unattended`：
 *     · 用户嫌弹窗烦 + 人走开就卡死 ⇒ 把它设成 true
 *     · 于是"不打扰"在**所有任务**上生效，包括部署、多步改盘、需求没说清
 *   结果两个症状同时出现：复杂任务不问就开做；需要授权时静默跳过（记账为"需要你在场"）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 设计：从"开关"换成"三档"
 * ═══════════════════════════════════════════════════════════════════════
 *   SILENT  只读 / 单步 / 用户显式说别问  ⇒ 直接做，不打扰
 *   QUEUE   会写盘但可回滚、步骤少        ⇒ **照做，同时把动作排进待批队列**
 *                                          （人走开不卡死；回来能逐条批准/回滚）
 *   CONFIRM 多步改盘 / 部署 / 支付 / 删除 / 需求有歧义 ⇒ 先出计划，等点头
 *
 * 纪律：
 *   ① **纯函数、零 fs、零环境变量**：同输入同结论，单测可直接断言。
 *   ② **只认客观信号**：不读模型自述（"我觉得很简单"不算信号）。
 *   ③ 判"复杂"优先看**会不会造成不可逆后果**，其次才看步骤数。
 */

'use strict';

const TIER = Object.freeze({ SILENT: 'silent', QUEUE: 'queue', CONFIRM: 'confirm' });

/** 一旦命中就至少 CONFIRM 的动作类别（不可逆 / 对外可见 / 花钱）。 */
const HARD_CATEGORIES = Object.freeze(['deploy', 'publish', 'pay', 'delete', 'db-write', 'ssh', 'production']);

/**
 * 判定本轮该走哪一档。
 *
 * @param {{
 *   writes?: boolean,           是否会改动环境（写文件/跑命令/部署/下单）
 *   steps?: number,             预估步骤数（客观来源：计划长度或工具调用预估）
 *   readonlySkills?: boolean,   本轮涉及的全部技能是否都在只读白名单
 *   ambiguous?: boolean,        需求是否有歧义（多目标 / 产物形态没说清）
 *   categories?: string[],      命中的动作类别（deploy/pay/delete…）
 *   explicitNoAsk?: boolean,    用户这一轮明确说了"别问我/直接做"
 *   maxQueueSteps?: number,     可异步的步骤上限（默认 3）
 * }} input
 * @returns {{tier:string, reasons:string[], needsPlan:boolean}}
 */
function decide(input) {
  const o = input && typeof input === 'object' ? input : {};
  const reasons = [];
  const cats = Array.isArray(o.categories) ? o.categories.map(String) : [];
  const hard = cats.filter((c) => HARD_CATEGORIES.indexOf(c) !== -1);
  const steps = Number(o.steps) || 0;
  const maxQueueSteps = Number(o.maxQueueSteps) || 3;

  // ① 不可逆 / 对外 / 花钱：无论用户说过什么，一律要点头。
  if (hard.length) {
    reasons.push('命中不可逆类别：' + hard.join('/'));
    return { tier: TIER.CONFIRM, reasons, needsPlan: true };
  }
  // ② 不会改动环境：不打扰（只读没有代价）。
  if (o.writes !== true) {
    reasons.push('只读任务');
    return { tier: TIER.SILENT, reasons, needsPlan: false };
  }
  // ③ 需求有歧义：必须先对齐 —— 这是"做错方向"的唯一预防点。
  //
  // ★ 2026-11-09 顺序修正（本轮最重要的一处）。
  //   修前这里是：③ explicitNoAsk → QUEUE，④ ambiguous → CONFIRM。
  //   于是**用户一开"别问我"，歧义就被压掉了**：判定停在 QUEUE、needsPlan=false，
  //   既不弹计划也不问需求，直接开做。
  //   这不是理论风险，是本仓自己的事故形状：
  //     用户原话「用godot做一个愤怒小鸟的游戏」→ signals 判出 ambiguous=true（点了工具、点了主题，
  //     唯独没说交什么形态），但用户同时开着 unattended ⇒ 被判 QUEUE ⇒ 不问 ⇒
  //     最后交了一个网页顶替 Godot 工程。signals 里那段注释记录了这个反例，
  //     却没人回头看 decide 的优先级 —— 判据写对了，顺序把它废掉了。
  //
  //   为什么歧义必须排在"别问"前面（代价不对称）：
  //     · 多问一句的代价 = 用户被烦一次；
  //     · 方向做错的代价 = 整个交付物作废，用户还得重新描述一遍需求。
  //   而且"人走开"并不等于"方向不明也照做"：CONFIRM 档在人走开时的落法**不是白等**，
  //   而是「不执行、排进待批队列、只做不需要猜的部分、收尾列出等你点头」——
  //   既不阻塞，也不赌方向。所以把歧义提前**不会**重新引入"人走开就卡死"。
  if (o.ambiguous === true) {
    reasons.push('需求有歧义（多目标或产物形态未说清）');
    return { tier: TIER.CONFIRM, reasons, needsPlan: true };
  }
  // ④ 用户显式说"别问"：尊重，但仍然进队列（做，且可回滚、可事后追认）。
  //   走到这里说明**方向是明确的**，只是不该为细节打断他 —— 这正是"别问"该有的作用范围。
  if (o.explicitNoAsk === true) {
    reasons.push('用户显式要求不要打断（方向已明确）');
    return { tier: TIER.QUEUE, reasons, needsPlan: false };
  }
  // ⑤ 步骤少且可回滚：边做边排队，不阻塞。
  if (steps > 0 && steps <= maxQueueSteps) {
    reasons.push('会改盘但步骤少（' + steps + ' ≤ ' + maxQueueSteps + '）');
    return { tier: TIER.QUEUE, reasons, needsPlan: false };
  }
  // ⑥ 其余（多步改盘 / 步骤未知）：先出计划。
  reasons.push(steps > maxQueueSteps ? '多步改盘（' + steps + ' 步）' : '会改盘且步骤未知');
  return { tier: TIER.CONFIRM, reasons, needsPlan: true };
}

/**
 * 待批队列：异步档产生的写操作排在这里，收尾一次性列出。
 * 为什么需要：人走开时不能卡死，也不能偷偷做——只能"先做可回滚的，把要点头的记账"。
 *
 * 【`done` 与 `reversible` 是两个不同的轴，早期版本把它们混成一个，会直接对用户说假话】
 *   done=true      这一步**已经做了**（写进队列是为了告诉用户"随时能撤回"）
 *   done=false     这一步**还没做**（写进队列是为了告诉用户"等你点头才做"）
 *   reversible      这一步做了之后**能不能撤回**
 * 只有 4 种组合里的 2 种在现实中存在，但渲染必须分开写：
 *   done=true  + reversible=true   → 「已做，可撤回」
 *   done=false + reversible=false  → 「未做，等你点头（⚠ 做完撤不回）」
 * 早期 summary() 只看 reversible，于是**所有**条目都被渲染成「（可回滚）」——
 * 而当时尚无任何一种 done=true 的写入，等于把"等你点头才做的事"说成"已经做完、可以撤回"。
 * 用户读到「可回滚」会以为已经落盘，然后拿它去验收，那是最坏的一种误导。
 */
function createPendingQueue() {
  const items = [];
  return {
    /** @param {{tool:string, summary:string, reversible?:boolean, done?:boolean, path?:string}} a */
    add(a) {
      const it = Object.assign({ id: 'p' + (items.length + 1), reversible: true, done: false }, a || {});
      items.push(it);
      return it;
    },
    list() { return items.slice(); },
    size() { return items.length; },
    /** 逐条批准：返回被批准的动作 */
    approve(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return null;
      return items.splice(i, 1)[0];
    },
    approveAll() { const all = items.slice(); items.length = 0; return all; },
    /**
     * 收尾文案：只列事实，不替用户决定。
     *
     * 分两段输出（还没做 / 已经做了），因为这两件事对用户的意义完全相反：
     *   没做的要提醒「你点头我才做」，已做的要提醒「不满意就撤回」。
     * 混成一段时，用户既不知道哪件已经动过了环境，也不知道自己该做什么。
     *
     * 即使只有一组**也要打组名**：单看「1. 部署到线上」根本看不出这句是
     * "已经部署了"还是"等着部署"。省掉那行标题换来的简洁，代价是把判断责任推给用户。
     */
    summary() {
      if (!items.length) return '';
      const doneItems = items.filter((x) => x.done === true);
      const todoItems = items.filter((x) => x.done !== true);
      const lines = [];
      if (todoItems.length) {
        lines.push('还没做、等你点头：');
        todoItems.forEach((x, i) => {
          lines.push((i + 1) + '. ' + x.summary + (x.reversible ? '' : '（⚠ 做了撤不回）'));
        });
      }
      if (doneItems.length) {
        lines.push('已经做了、可以撤回：');
        doneItems.forEach((x, i) => {
          lines.push((i + 1) + '. ' + x.summary + (x.reversible ? '（可撤回）' : '（⚠ 撤不回）'));
        });
      }
      return lines.join('\n');
    },
  };
}

/**
 * 两个缺失信号的**唯一来源**（接线前先有它，否则三档退化成瞎判）。
 *
 * steps：优先用计划长度（客观、已落盘）；没有计划时用需求里的动作分句数估一个下界。
 * ambiguous：只认三种客观不确定——多个目标 / 产物形态没说清 / 关键技术栈没定。
 * 全部不看模型自述（"我觉得清楚"不算信号）。
 *
 * @param {{goalText?:string, plan?:any[], artifactsDeclared?:boolean}} input
 * @returns {{steps:number, ambiguous:boolean, reasons:string[]}}
 */
function signals(input) {
  const o = input && typeof input === 'object' ? input : {};
  const goal = String(o.goalText || '');
  const reasons = [];
  const planLen = Array.isArray(o.plan) ? o.plan.length : 0;
  // 下界估计：把需求按动作分句/顿号切开，至少要走这么多步。
  const clauses = goal.split(/[，,。；;\n]|然后|接着|再|并且/).filter((s) => s.trim().length > 0);
  const steps = planLen > 0 ? planLen : Math.min(clauses.length, 12);
  if (!planLen && clauses.length > 1) reasons.push('无计划，按需求分句估步数=' + steps);

  // 歧义三条（任一成立即算）：
  // ① 一个需求里出现多个目标动作（然后/接着/同时/另外/还要）
  // ② 要从零**创建**东西，却没说产物形态（没有扩展名、没有"网页/小程序/工程/exe"这类词）
  // ③ 说了"用 X 做"但 X 之后没有具体落地方式 —— 交给技术栈契约去判，这里不重复
  const multiGoal = /(然后|接着|同时|另外|还要|顺便)/.test(goal);
  // ★ 2026-11-09 把「创建」和「修改」分开 —— 修前它们共用 wantsThing 一个正则，
  //   于是「帮我改一下首页标题」被判成"要做东西但没说产物形态"⇒ 歧义 ⇒ 每次都弹计划。
  //   这类指令的产物**早就在那儿了**（首页就是那个页面），再问"你要什么形态"纯属反问。
  //   需要问形态的只有从零创建：做/写/生成/搭/建/开发/实现。
  //   （实测反例：把两条并在一起时，「帮我把首页标题改成夏季促销」这种明确到不能再明确的
  //     指令也会被拦下来 —— 过度收紧和过度放松一样是 bug，只是换了个方向。）
  const createsThing = /(做|写|生成|搭|建|开发|实现)/.test(goal);
  const hasShape = /(网页|网站|页面|小程序|工程|项目|exe|\.(html|md|docx|xlsx|pptx|pdf|js|py)\b|游戏|接口|文档|报告)/i.test(goal);
  const noShapeWhenCreating = createsThing && !hasShape && goal.length > 8;
  // ③ "用 X 做 Y" 但没说是工程/可执行/网页这类**交付形态** ⇒ 歧义。
  //    实测反例："用godot做一个愤怒小鸟的游戏" 里"游戏"骗过了 hasShape，
  //    于是只靠上面那条判据会放行，最后交了个网页顶替 Godot 工程。
  //    规律：点了工具、点了主题，唯独没点"交什么形态"，才是最容易做错的一类。
  const explicitTool = /用\s*[^\s，,。；;]{2,12}\s*(做|搭|写|开发|实现|生成)/.test(goal);
  const formWord = /(工程|项目|exe|可执行|安装包|网页|页面|小程序|脚本|文档|报告)/i.test(goal);
  const toolNoForm = explicitTool && !formWord;
  const ambiguous = (multiGoal || toolNoForm || noShapeWhenCreating);
  if (multiGoal) reasons.push('需求里有多个目标动作');
  if (toolNoForm) reasons.push('点了工具和主题，但没说交什么形态');
  if (noShapeWhenCreating) reasons.push('要从零做东西但没说产物形态');
  if (o.artifactsDeclared === true) reasons.push('用户已声明产物');

  return { steps, ambiguous: ambiguous && o.artifactsDeclared !== true, reasons };
}

/**
 * 从「用户原话」里抽动作类别（HARD_CATEGORIES 的唯一来源）。
 *
 * 【为什么要从原话抽，而不是看模型自述】
 *   模型说"这只是个简单改动"不算信号 —— 那是它的判断，而闸门存在的意义正是**不信任**这个判断。
 *   用户原话里的「部署/上线/删掉/付款/推到服务器」是客观事实，可复现、可回放、可被单测断言。
 *
 * 【为什么宁可多报也不漏报】
 *   categories 命中 ⇒ 至少 CONFIRM（走"先出计划等点头"）。漏报的代价是静默做了不可逆的事；
 *   多报的代价只是多问一句。这个不对称决定了正则必须宽松，不许为了"看起来精确"收窄。
 *
 * @param {string} goalText 用户这一轮的原话
 * @returns {string[]} 命中的类别（去重，保持 HARD_CATEGORIES 的顺序）
 */
function inferCategories(goalText) {
  const g = String(goalText || '');
  const hit = new Set();
  if (/(部署|上线|发布到|推送到服务器|发版|deploy)/i.test(g)) hit.add('deploy');
  if (/(发布|发出去|公众号发|小红书发|抖音发|publish)/i.test(g)) hit.add('publish');
  if (/(付款|支付|下单|充值|转账|扣款)/.test(g)) hit.add('pay');
  if (/(删掉|删除|清空|干掉|卸载|delete|rm\s+-rf)/i.test(g)) hit.add('delete');
  if (/(改数据库|写库|入库|迁移表|db\s*write)/i.test(g)) hit.add('db-write');
  if (/(ssh|登录服务器|远程执行)/i.test(g)) hit.add('ssh');
  if (/(生产环境|线上一台|线上服务器|正式环境|production)/i.test(g)) hit.add('production');
  // 按 HARD_CATEGORIES 的声明顺序输出，保证同输入同顺序（单测可直接深比）。
  return HARD_CATEGORIES.filter((c) => hit.has(c));
}

/**
 * 本轮任务的**唯一判定入口**（backend 只该调这个，不自己拼 decide 的参数）。
 *
 * 与 `decide()` 的分工：
 *   · decide 是纯判据，参数由调用方准备；
 *   · decideForTask 负责**准备参数**：从用户原话抽 signals / categories，
 *     再把"人走开"（unattended）翻译成 explicitNoAsk。
 *
 * 【unattended 的语义收窄 —— 这是本次接线的核心】
 *   改前：unattended=true 是**全局布尔**，对**所有任务**一律不打扰 ⇒
 *         复杂任务不问就开做、需要授权时静默跳过，两个症状同时出现。
 *   改后：unattended 只作用于 QUEUE 档（做 + 进待批队列，收尾列出）；
 *         命中不可逆类别（HARD）时判定**照旧是 CONFIRM** —— decide 里 hard 分支排在
 *         explicitNoAsk **之前**，所以"人走开"永远换不来"随便删库"。
 *         CONFIRM 档在无人值守下的落法是"不执行、排进待批队列、收尾告诉你等你点头"，
 *         既不是静默做掉，也不是白等 300 秒卡死。
 *
 * @param {{goalText?:string, plan?:any[], explicitNoAsk?:boolean, artifactsDeclared?:boolean}} input
 * @returns {{tier:string, reasons:string[], needsPlan:boolean, steps:number, ambiguous:boolean, categories:string[]}}
 */
function decideForTask(input) {
  const o = input && typeof input === 'object' ? input : {};
  const goalText = String(o.goalText || '');
  const sig = signals({ goalText, plan: o.plan, artifactsDeclared: o.artifactsDeclared });
  const categories = inferCategories(goalText);
  const d = decide({
    // ★ 会改盘只看**动作动词**，绝不看 `steps > 0`。
    //   实测反例（本门禁第一跑就红了 3 条）：「豆芽是什么」「今天行情怎么样」按分句估出来的
    //   steps 都 ≥ 1，若拿 steps 判"会改盘"，纯问答会被判成 QUEUE —— 用户每问一句就被排进待批队列，
    //   比原来那个全局布尔更烦人。步骤数只该用来**在已确定会改盘之后**分 QUEUE/CONFIRM。
    writes: categories.length > 0 || /(做|写|生成|搭|建|开发|实现|改|部署|发布|删除|安装|配置|执行|运行|跑|上传|下载)/.test(goalText),
    steps: sig.steps,
    ambiguous: sig.ambiguous,
    categories,
    explicitNoAsk: o.explicitNoAsk === true,
    readonlySkills: o.readonlySkills === true,
  });
  return {
    tier: d.tier,
    reasons: sig.reasons.concat(d.reasons),
    needsPlan: d.needsPlan,
    steps: sig.steps,
    ambiguous: sig.ambiguous,
    categories,
  };
}

module.exports = {
  TIER,
  HARD_CATEGORIES,
  decide,
  createPendingQueue,
  signals,
  inferCategories,
  decideForTask,
};
