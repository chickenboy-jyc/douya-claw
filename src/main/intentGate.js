'use strict';

/**
 * intentGate —— 「任务意图闸门」：先判断用户到底是要**答案 / 诊断 / 方案**，还是要**动手做**，
 * 再决定允不允许模型调用「会改动环境」的技能。
 *
 * 为什么必须是独立模块（而不是再往人设里加十几条 Prompt）：
 *   Prompt 只能**劝**模型，拦不住。而「用户问了个为什么、模型却开始写文件开服务」这类故障
 *   本质是**任务类型识别错** —— 再聪明的执行策略都救不回来（2026-09-23 老板原话）。
 *   既然「用户有没有授权动手」是**可以被文字判定**的，就不该只靠模型自觉，
 *   必须在工具执行前真的把它拦下来。
 *
 * 与既有模块的分工（四层里的最前面一层）：
 *   intentGate.js（本文件）—— 「**这一轮有没有资格动手**」
 *   toolProtocol.js        —— 「这一次工具调用怎么了」
 *   deliveryProtocol.js    —— 「整个任务算不算交付完成」
 *
 * ★ 2026-11-06 追加第二职责：「**这次任务的意图到底是哪一段文本**」（`resolveTaskGoal`）。
 *   放这里不是凑数：闸门判的是"这句指令算不算动手指令"，而 `resolveTaskGoal` 判的是
 *   "整件任务要交付什么"。两者读的是同一份输入（用户原话），且必须读**同一个来源** ——
 *   修前它们各读各的（闸门读本轮消息，验收读 `clip(lastUserText,300)`），于是
 *   "干活的人看到的最初需求"与"判卷的人看到的目标"是两份不同的东西。
 *   见该函数头注：这是「意图」这件事在代码里的**唯一取值点**。
 *
 * 本文件纯函数、零依赖，可被单测直接 require，不需要起 Electron。
 */

// ===================== 一、四种任务模式 =====================
//   QUESTION —— 只要答案：解释、原因、你怎么看。**不许改动任何东西。**
//   DIAGNOSE —— 要查清事实：只读调查（读源码/日志/数据、对照实验）。**调查≠修复授权。**
//   PLAN     —— 要方案：怎么改、有什么选择、风险如何。**给方案不等于开始执行。**
//   EXECUTE  —— 明确让你动手：做/改/修/打包/上传/发布/部署。
const MODE = {
  QUESTION: 'QUESTION',
  DIAGNOSE: 'DIAGNOSE',
  PLAN: 'PLAN',
  EXECUTE: 'EXECUTE',
};

/** 给用户/模型看的中文说法（内部状态名不许直接露给用户）。 */
const MODE_LABEL = {
  QUESTION: '回答问题',
  DIAGNOSE: '只读调查',
  PLAN: '给方案',
  EXECUTE: '实际执行',
};

/** 只有这一个模式被授权「动手」。其余三个一律不许改动环境。 */
const AUTHORIZED_MODES = new Set([MODE.EXECUTE]);

/**
 * 这一轮是否获得执行授权。
 * 单一判据：模式 === EXECUTE。**不做任何"看起来像要干活就放行"的宽松推断** ——
 * 宽松推断正是「用户只是问问题、模型却开干」的成因。
 */
function isExecutionAuthorized(mode) {
  return AUTHORIZED_MODES.has(mode);
}

// ===================== 二、技能分级 =====================
// 只读技能：只读取信息、**不改变任何东西**，在四种模式下都放行。
// ⚠️ 这里是**白名单**：没列进来的技能在非 EXECUTE 模式下**一律按"需授权"处理**（fail-closed）。
//    宁可少放行（被拦时模型可改用自然语言说明），也不能因为漏列一个写操作技能而放它改环境。
const READONLY_SKILLS = new Set([
  'file-read',      // 读文件
  'file-list',      // 列目录
  'file-search',    // 搜文件
  'doc-read',       // 读文档
  'image-info',     // 读图片信息
  'image-ocr',      // OCR 读取
  'web-fetch',      // 抓网页（只读）
  'calculator',     // 计算
  'python-wordcount', // 统计字数
  'shop-search',    // 搜商品（只读）
  'mmm-shop-search',// 搜商品（只读）
  'browser-verify', // 浏览器核对（只读渲染结果）
  'hello',          // 连通性自检，无副作用
]);

/**
 * 无副作用的「元工具」（workflow_plan / request_material / clarify_requirements / pick_local_files / find_skills）。
 * 它们只影响对话流程、不碰环境，且是**非执行模式下唯一合法的交互手段**（比如让用户选文件），
 * 因此必须放行 —— 否则 QUESTION 模式下连"请你确认一下"都做不到。
 * 与 backend 的 META_TOOL_NAMES 同名同步（那边由 META_TOOLS 派生）。
 *
 * ★ 2026-02-16 新增 `find_skills`（技能渐进披露的查询入口）：它**零副作用**（不写盘、不起进程、
 *   不碰远端，只改主循环内存里的"已披露"集合），完全符合本集合的定义。
 *   为什么非登记不可：backend 的 intent 闸门在**执行前**调本函数，未登记 ⇒ 判成 `needs-authorization`。
 *   症状会非常难查 —— 用户问「这个能做成 PPT 吗」（QUESTION 模式）时，模型想查一下技能清单，
 *   被闸门拦下、拿到一句"未获执行授权"，于是它**再也不会去查**，只能凭工具表里剩下的 8 个核心技能
 *   硬答"我做不了"。而这条链上没有任何一处会报错。
 *   ⚠️ 这份名单是手抄的（backend 那份由 META_TOOLS 派生），两处必须同步 —— 这也是门禁
 *   `unit-lazy-tools` L10 之外单独核对过一次的理由。
 */
const META_TOOL_NAMES = new Set([
  'workflow_plan',
  'request_material',
  'clarify_requirements',
  'pick_local_files',
  'find_skills',
]);

// ===================== 二·一、产出类技能（2026-11-11 夜 扩展用）=====================
/**
 * 「会写出一个新的交付物文件」的技能集合 —— 授权门与事实门的**唯一真源**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这份表（0.21.31 事故换一个技能就能复发）
 * ═══════════════════════════════════════════════════════════════════════════
 *   0.21.31 那轮的真实绕过路径是 `docx-generate`：它不叫 `file-write`，
 *   于是 `planAuthGate` 头一句 `if (name !== 'file-write') return pass(...)` 直接放行，
 *   模型在**用户只补了信息**的那一轮凭空造出一个 38,421 字节的 docx。
 *   实测读数：`auth-gate 命中=0`、`skippedGates=[]` —— 门根本没被触发过。
 *   ⇒ 只守 `file-write` 一处，等于把门的有效性绑定在「模型下次还用 file-write」这个假设上。
 *
 *   本集合的 15 个名字**不是我列出来的**，是 `backend.js` 里成果卡登记表
 *   （`PRODUCER_SKILLS`，注释原文「这些技能把『已生成 XXX：<绝对路径>』写进返回文本」）
 *   原本就有的同一份；那边已由 `unit-artifact-exec-bounds` 的 S2 臂守着。
 *   现在改为**从这里 import**（backend 不再自己养一份字面量），两份不可能漂移。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 判据怎么用（⚠️ 不要把它当"这些技能一律拦"，它只是"这些技能归门管"）
 * ═══════════════════════════════════════════════════════════════════════════
 *   进本表只意味着：调用它时 `planAuthGate` **不再早退**，而是继续走后面四条旁路
 *   （覆盖已有 / 只拦一次 / 用户已点头 / 本轮明确派活）。
 *   ⇒ 用户正常说「帮我做一份 PPT」时照样一次通过，不产生任何多余提问。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 实测出的输入形态差异（2026-11-11 逐个读每个技能的 run.py / run.js 得到，不是猜的）
 * ═══════════════════════════════════════════════════════════════════════════
 *   15 个里有 **11 个是 Python 实现**（`run.py`），只有 slides-generate / concat-video /
 *   project-scaffold / miniprogram-scaffold 是 JS。⇒ 任何"读 run.js 推断行为"的做法都会漏一大半。
 *
 *   目标输出路径（`params` 里的字段，逐字来自源码）：
 *     file-write            path
 *     docx-generate         filename ‖ title + ".docx"
 *     pdf-generate          filename ‖ title + ".pdf"
 *     ppt-generate          filename ‖ title + ".pptx"
 *     excel-generate        filename ‖ (title ‖ "Sheet1") + ".xlsx"
 *     slides-generate       filename ‖ title   （safeName 净化后强制 .html）
 *     chart-generate        output   ‖ "chart.png"
 *     gif-make              output   ‖ "animation.gif"
 *     video-make            output   ‖ "video.mp4"
 *     image-edit            output   ‖ 输入文件名 + "-edited" + 原扩展名
 *     image-compress        output（是**目录**）‖ 输入文件所在目录
 *     media-edit            output   ‖ 由 input/inputs 派生
 *     concat-video          output   ‖ plan.export.output（只有 render/frame 产出）
 *     zip-pack              output   ‖ 输入路径 + ".zip"（path 是**输入**，不是输出）
 *     project-scaffold      files[].path（JSON 数组里，可多个）
 *     miniprogram-scaffold  basedir ‖ "miniprogram"（是**目录**）
 *
 *   正文（供事实门扫断言）：
 *     docx / pdf            sections（JSON 字符串，数组里带 paragraphs / bullets）
 *     ppt / slides          slides（JSON 字符串）
 *     excel                 headers + rows（JSON 字符串）
 *     project-scaffold      files[].content（JSON 数组里）
 *     image-edit            text（仅水印文字）
 *     其余                  没有正文
 *
 *   ⇒ 结论：**入参形态根本无法统一**。所以：
 *     · 授权门只认「目标路径」（尽力解析；解析不出的按 `pathExists:false` 处理 ⇒ 仍受门管）；
 *     · 事实门只认「正文文本」（把该技能所有可能的文本参数收集拼接后扫）。
 *
 * ⚠️ 改动本表时必须同步：`scripts/smoke/unit-auth-gate.mjs` 的 P 组会逐条核对
 *   「本表的每个名字在 skills/<name>/ 下真的有实现」，删掉一个技能而不删表 ⇒ 转红。
 */
const PRODUCER_SKILLS = new Set([
  'slides-generate', 'ppt-generate', 'excel-generate', 'docx-generate', 'pdf-generate', 'chart-generate',
  'image-edit', 'image-compress', 'gif-make', 'video-make', 'media-edit',
  'concat-video',
  'project-scaffold', 'miniprogram-scaffold', 'zip-pack',
]);

/**
 * 产出类技能里「这个 action 其实只读」的例外 —— 进本表 = **不归授权门/事实门管**。
 *
 * ★ 为什么必须有这一层，而不是「整个技能一律拦」：
 *   `concat-video` 的 4 个 action 里，`probe`（查本机装没装 Concat）与 `inspect`（读已有工程
 *   的时间线，返回人话）**一个字节都不写盘**（源码 `skills/concat-video/run.js` 的
 *   `if (rawAction === 'probe')` / `'inspect'` 两支，只有 `render` / `frame` 才产出）。
 *   若整技能一律拦，"这个片子多长"这种纯查询会被要求授权 ⇒ 这是**真误伤**，
 *   而且用户会觉得"它连看一眼都要问我"。
 *
 * ⚠️ 漏登记任何一个只读 action 的方向是**误拦**（多问一句，可恢复）；
 *   反过来把产出 action 错登记成只读，方向是**漏拦**（事故复发）。
 *   所以本表只允许登记**源码里明确 return 而不落盘**的 action，P 组会逐个核对。
 */
const PRODUCER_READONLY_ACTIONS = Object.freeze({
  'concat-video': Object.freeze(['probe', 'inspect']),
});

/**
 * 这个技能（这次调用）会不会写出新的交付物文件。
 *
 * ★ 为什么判据是 `PRODUCER_SKILLS ∪ {file-write}` 而不是单看那个集合：
 *   `file-write` **不在** `PRODUCER_SKILLS` 里 —— 不是漏了，是 backend 侧它走**单独一支**
 *   登记成果卡（`if (nm === 'file-write')` 直接拿 `params.path`，不必从返回文本里扫绝对路径）。
 *   所以两份集合**确实差这一个成员**，差得有理。若把它塞进那份集合，会连带让 file-write
 *   的返回文本也去走"扫绝对路径"那支 —— 无害但属于没必要的副作用，本次不动。
 *   ⇒ 门这边显式把 file-write 补上，并用注释锁住这个"差一个"的事实。
 *   （`unit-auth-gate` 的 C0 会实测 file-write **必须**被拦，P 组会核对集合规模。）
 *
 * @param {string} skillName
 * @param {object} [params] 调用入参（用于 action 级只读例外判定）
 * @returns {boolean}
 */
function isProducerSkill(skillName, params) {
  const name = String(skillName == null ? '' : skillName);
  if (!PRODUCER_SKILLS.has(name) && name !== 'file-write') return false;
  const ro = PRODUCER_READONLY_ACTIONS[name];
  if (ro && ro.length) {
    const p = (params && typeof params === 'object') ? params : {};
    const act = String(p.action == null ? '' : p.action).trim().toLowerCase();
    if (act && ro.indexOf(act) >= 0) return false;
  }
  return true;
}

/**
 * 判断某个技能在当前模式下是否允许调用。
 * @returns {{allowed:boolean, reason:string}}
 */
function isSkillAllowed(skillName, mode) {
  const name = String(skillName || '');
  if (!name) return { allowed: false, reason: 'empty-name' };
  if (isExecutionAuthorized(mode)) return { allowed: true, reason: 'authorized' };
  if (META_TOOL_NAMES.has(name)) return { allowed: true, reason: 'meta-tool' };
  if (READONLY_SKILLS.has(name)) return { allowed: true, reason: 'readonly' };
  return { allowed: false, reason: 'needs-authorization' };
}

// ===================== 二·二、短追问（跨轮授权的唯一入口）=====================
// 【2026-10-21 老板实测暴露，原话】「什么时候好」→ agent 回「还没好」→ 再问 → 还是「还没好」→「然后就停了」。
//
// 根因不在模型，在这里：`classifyIntent` 只看**本轮**那一句，而「好了吗」是疑问句 ⇒ QUESTION ⇒
// 本轮禁止一切执行。可 agent 那一轮最该做的事恰恰是「起个本地服务把成品翻一遍」——
// 它想干、也被要求干，却因为用户问了句「好了吗」而丧失权限，于是只能说「还没好」。
// **用户越催，agent 越没权限把活干完。**
//
// 修法（不是"扫历史"，原注释担心的那个坑仍然避开）：
//   只在**极窄**的条件下沿用上一轮的执行授权 ——
//     ① 本轮文本是**短追问形态**（≤40 字且整句就是催/问进度/说继续/质疑做没做）；
//     ② 上一轮确实判过 EXECUTE，且距今在 FOLLOW_UP_GRACE_MS 内（默认 30 分钟）；
//     ③ 明确的「先别动手」仍然压过一切（在 classifyIntent ① 已优先命中，本函数不参与）。
//   ⇒ 「上周让你部署过」不会被继承成今天的永久授权：出了时间窗就不认，长句也不算追问。
/** 追问的最长字数。超过就是新要求（或贴了整段材料）。 */
const FOLLOW_UP_MAX_LEN = 40;

// 【2026-10-21 第三版｜第二版被真机门禁打回，记在这里别重犯】
//
// 第一版：整句逐字命中一条约 25 词的白名单，`length > 20` 直接 false。
//   病：老板质疑时的原话（「什么意思？」「？」「那现在呢」「ppt 呢」「你不会自己操作吗？」
//   「你是不是没安装成功啊」）一条都不在表里 ⇒ 继承不到授权 ⇒ 那一轮 shell-exec/file-write
//   被拦 ⇒ 只能说「还没好」⇒ 用户再催 ⇒ 依旧 QUESTION。**用户越催，越没权限把活干完。**
//
// 第二版（本轮的第一次尝试）：改成「反向排除 + 泛化追问」——有问号且不含新材料指纹就算追问。
//   ★ 结果被 unit-intent-gate-runtime 当场打回：**10 条安全测试全红，全是"本该被拦却执行了"**。
//     最致命的是这一句：「为什么会出现 因超出token预算而停止？」
//     它是**真疑问句**（问原因），第二版却把它当成对上一件事的催促 ⇒ 继承执行授权 ⇒
//     DIAGNOSE/PLAN 模式下本该拦下的 shell-exec / file-write 全部放行。
//     实测连带红：★3a 诊断模式 shell-exec 被拦 / ★3c 方案模式 file-write 被拦 /
//     ★6b 并行旁路 / ★7a 连续 3 轮写操作全被执行 / ★12b 跳过素材 / ★13b「先别动手」。
//   教训：**「有问号」根本不等于「在催上一件事」。** 中文里问号太廉价，
//   「为什么 X」是在问 X 的成因，不是催进度。把它算成追问，等于给每一个疑问句开执行权。
//
// 第三版（本版）：**回到整句锚定**，但把「词条」从 25 个扩到覆盖老板的实际说法，
//   并允许**多个词条用分隔符串联**（「做了吗 什么时候好」这种连问）。
//   ⇒ 「什么意思？」能继承（它问的是"你刚才那句话"，指向上一件事）；
//     「为什么会出现 token 预算不足？」不能继承（它在问一个新问题的成因，走 QUESTION/DIAGNOSE）。
//   判据仍然只认「整句就是催问」这一种形态：句子里只要有**任何具体内容**
//   （原因、名词短语、要改什么），就不在词条表里 ⇒ 落回正常意图判定。这是它安全的原因。
const FOLLOW_UP_TOKEN = '(?:'  + '好了吗|好了没|好了么|好没好|'
  + '完了吗|完了没|完成了吗|做完了吗|做完了没|做完没|'
  + '可以了吗|行了吗|'
  + '怎么样了|到哪了|到哪一步了|到哪一步|进度如何|进度呢|进度|'
  + '继续|接着做?|接着|然后呢|那然后呢|'
  + '什么时候(?:能)?(?:好|完|弄完|做完)|还要多久|要多久|'
  + '还没好|还没完|还没弄好|还没做完|'
  + '快点|催一下|催下|在吗|还在吗|还在不在|'
  + '弄好没|弄完了吗|弄完了没|搞定没|搞定没呢|搞好没|'
  // ── 2026-10-21 第三版新增：老板实测说过的那些（原白名单一条都没有）──
  + '做了吗|做了没|做没做|真的做了吗|到底做了没|你到底做了没有|'
  + '什么意思|什么意思啊|啥意思|那现在呢|现在呢|所以呢|'
  + '你不会自己操作吗|你不会操作吗|你自己没操作吗|'
  // 「你是不是没做 / 你是不是没安装成功啊」—— 老板质疑"到底做没做"的原话。
  // ★ 后面必须允许补语（成功/好/完）与语气词（了/啊/呀）：漏了它们，整句锚定就匹配不上，
  //   「你是不是没安装成功啊」会落到 false —— 而它正是老板要求"必须重新调查"的那一句。
  + '你(?:是不是|是不是又)没(?:做|弄|搞|生成|安装|执行|跑)(?:成功|好|完)?[了啊呀]?|'
  + '(?:是不是|又)没(?:做|弄|搞|生成|安装|跑)(?:成功|好|完)?[了啊呀]?|'
  // 「怎么还没好」——原白名单只有「还没好」，多一个字就失配
  + '怎么(?:还|这么)?没(?:好|完|弄好|做完|结果)|'
  // 「ppt 呢 / 图呢 / 文件呢」——短宾语 + 呢。限定 1~6 个字符，
  // 是为了挡住「这个报告为什么写不出来呢」这类问成因的长句（那种走 QUESTION/DIAGNOSE）。
  + '[A-Za-z0-9\u4e00-\u9fa5]{1,6}\\s*呢|'
  // 「没完成？」—— 反问式质疑：用户已经**认定**没完成。这时最需要的是真的去做完，
  // 而不是再回答一句"确实没完成"。收进这一族是老板第 1 条主动能力的直接要求。
  + '没(?:完成|做完|弄好|搞定)|'
  // 「对吧你到底做了没有」—— 逼问式催问。允许前置「对吧/是吧」这类反问引导语。
  + '(?:对吧|是吧|对不对)?\\s*你到底(?:做|弄|搞|干)了(?:没有|没|吗)|'
  + '你(?:到底|究竟)(?:做|弄|搞|干)了(?:没有|没|吗)'
  + ')';
/**
 * 整句 = 一个或多个「催问词条」用空白/逗号/顿号串联，末尾可带标点。
 * 例：「做了吗 什么时候好」「什么意思？」「然后呢」「还在吗」都命中。
 * 反例：「为什么会出现 token 预算不足？」——「为什么…」不是词条，整句不匹配 ⇒ 不继承（这是对的）。
 */
// ★ 词条之间的分隔符**必须包含问号/叹号**（2026-10-21 修）：
//   真人是这么打的 ——「好了吗？怎么样了？到哪一步了？还要多久？在吗？」。
//   原分隔符只有空白/逗号/顿号/句号，于是**逗号连问能过、问号连问不能过**，
//   而后者才是老板最常见的打法。放开它不会放松安全性：整句依然只能由词条拼接，
//   「好了吗？那这个报告为什么写不出来」里后半句不是词条，照样不匹配。
const FOLLOW_UP_RE = new RegExp(
  '^' + FOLLOW_UP_TOKEN + '(?:[\\s,，、。？?！!.…~～]*' + FOLLOW_UP_TOKEN + ')*[\\s？?。！!.…、~～]*$'
);
/** 纯标点句（「？」「？？」「。」）也算追问：那是催得没话说了，指向的必然是上一件事。 */
const FOLLOW_UP_PUNCT_ONLY_RE = /^[？?。！!.…~～\s]+$/;

/**
 * 这一句是不是「在催 / 问进度 / 说继续 / 质疑上一件事做没做」——不是新要求。
 *
 * ★ 只认整句形态，**不做泛化**。这一点是第三版被真机门禁打回来之后定下的：
 *   泛化（有问号就算追问）会把「为什么 X」「怎么 Y」这类真疑问句也变成执行授权，
 *   而那正是意图闸门存在的理由。
 *
 * ★「质疑」也算追问（老板原话：「当你说『这个结果不对』『你是不是没做』『为什么会这样』，
 *   它不能只道歉……应该重新检查文件、执行日志和实际结果」）—— 但**只收"质疑做没做"这一族**
 *   （「做了吗」「做没做」「你是不是没做」），不收"问成因"那一族（「为什么会这样」）。
 *   后者走 QUESTION / DIAGNOSE：查原因只需要只读权限，不该拿到执行权。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isShortFollowUp(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 长文本一律不算追问：那是在提新要求（或贴了新材料），必须重新判意图。
  if (t.length > FOLLOW_UP_MAX_LEN) return false;
  if (FOLLOW_UP_PUNCT_ONLY_RE.test(t)) return true;
  return FOLLOW_UP_RE.test(t);
}

/** 追问沿用授权的有效期：30 分钟。超出就当新任务重新判。 */
const FOLLOW_UP_GRACE_MS = 30 * 60 * 1000;

// ===================== 三、引用内容剥离 =====================
// 用户经常**把一大段别处的话贴进来问**（报告、日志、别人的回答、规则文档）。
// 那段话里几乎必然出现「做」「改」「修」「执行」等词 —— 若整段拿去做意图判定，
// 就会把「用户只是想让你看看这段话」误判成「用户让你动手」。
// 所以先把 Markdown 引用块（行首 `>`）剥掉再判定；若剥完什么都不剩，说明用户整条都是引用，
// 那就退回用原文（否则无信息可判，会永远判成默认档）。
function stripQuoted(text) {
  const raw = String(text || '');
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
  return kept || raw.trim();
}

/**
 * 「这是我们自己注入的系统提示」的**唯一**前缀判据（全仓只此一处正则）。
 * 见 `isSystemInjectedText` 头注：意图判定与记忆抽取必须共用它，不许各写一条。
 */
const SYSTEM_INJECT_PREFIX_RE = /^[（(]\s*系统提示/;

/**
 * 这条 `role:'user'` 文本是不是**我们自己注入的系统提示**（不是用户说的话）。
 *
 * ★ 判据在这里**只此一份**（`SYSTEM_INJECT_PREFIX_RE`），因为仓里有不止一处需要它：
 *   · `lastRealUserText` —— 不拿注入文案去判意图；
 *   · `memoryExtractor.extractFromMessages` —— 不拿注入文案去抽"关于用户的事实"
 *     （2026-02-16 独立验收实测：第二执行实例的结论回灌用的是 `role:'user'` +「（系统提示：」，
 *      只按 role 过滤的抽取器把模型自己编的「我的名字叫小豆」写成了 `identity/user.name`，
 *      confidence 0.98 ⇒ **模型生成的任意文本可以写进用户身份档案**）。
 *   两处若各写一条前缀规则，注入文案改一次标点就会出现"一处认得、一处不认得"的分裂 ——
 *   这正是本仓最忌讳的"同一件事两套口径"。所以**导出这一个函数，谁都来调它**。
 *
 * ⚠️ 为什么是「以（系统提示 开头」而不是「（系统提示）」四字紧连：见下面 lastRealUserText 里
 *   那段 2026-09-24 的教训（原正则要求四字紧连，而我们注入的文案带冒号 ⇒ 防护从来没生效过）。
 *
 * @param {unknown} content 消息正文（非字符串一律当"不是注入"）
 * @returns {boolean} true = 这是系统注入的提示文本，应跳过
 */
function isSystemInjectedText(content) {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  if (!t) return false;
  // 全角「（」与半角「(」都算：注入点有历史遗留两种形态（见 replan / 收尾 / 交接单回灌）。
  return SYSTEM_INJECT_PREFIX_RE.test(t);
}

/** 取用户消息里「最后一条真实用户消息」的文本（供 backend 调用；排除系统注入的提示）。 */
function lastRealUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const c = typeof m.content === 'string' ? m.content : '';
    if (!c.trim()) continue;
    // 我们自己注入的「系统提示」不是用户说的，不参与意图判定。
    // 🔴 2026-09-24 修：原正则写成 /^[（(]系统提示[）)]/ —— 要求「（系统提示）」四字**紧连**，
    //    而我们**实际注入**的文案是「（系统提示：…」（★带冒号★），两者对不上
    //    ⇒ 这个"排除系统注入"的防护**从来没生效过**（只对用户手写「（系统提示）」这种形态有效）。
    //    改成「以（系统提示 开头即排除」，不依赖其后的标点 —— 否则注入文案再改一次标点就再度失配。
    // ★ 2026-02-16：正则提升为模块级 `SYSTEM_INJECT_PREFIX_RE` 并由 `isSystemInjectedText` 导出，
    //   `memoryExtractor.extractFromMessages` 复用同一个判据（它原先只按 role 过滤 ⇒ 注入文案会被
    //   抽成"关于用户的事实"，独立验收已实测出 identity/user.name 被模型编的内容写脏）。
    if (isSystemInjectedText(c)) continue;
    return c;
  }
  return '';
}

// ===================== 四、意图判定 =====================
// 判定优先级（顺序本身就是设计，别随手调换）：
//   ① 明确说了「不要动手」  —— 最强信号，压过一切（哪怕同一句里有「改」字）
//   ② 明确给了执行授权      —— 才算 EXECUTE
//   ③ 请求调查（有查/排查/定位这类动作） —— DIAGNOSE（只读）
//   ④ 问「怎么改/有什么方案」            —— PLAN
//   ④·二 祈使请求 + 礼貌疑问尾（「做个落地页行吗？」） —— EXECUTE（2026-10-16 新增，见下）
//   ⑤ 疑问句                              —— QUESTION
//   ⑥ 都没有                              —— 默认 EXECUTE（保持既有行为，不误伤正常干活）
// 说明为什么默认是 EXECUTE 而不是 QUESTION：
//   这是**向后兼容**的选择。判错的代价不对称 —— 该执行却判成问答，会出现"用户让干活、它光说不做"；
//   而该问答却判成执行，才是老板点名要拦的那种事故。所以只在**明确出现疑问/求方案特征**时才降档，
//   其余保持原行为；一旦降档错了，被拦的模型会先向用户确认，用户一句"做吧"即可放行，代价很小。
//
// ★ 2026-10-16 补 ④·二：上面那段"降档错了代价很小"的前提已经**不成立**了。
//   原话是"被拦的模型会先向用户确认，用户一句『做吧』即可放行" —— 可这条出口后来被拆了：
//   人设改成「说完就直接开始做、不要停下来等确认」，gateDirective 也改成「用一句话说明
//   『我这就开始做 X』然后继续」。于是"降档错了"的代价从"多问一句"变成"模型宣告动手后
//   再调同一个技能**照样被拦**，只能说空话收场" —— 老板看到的"光说不做"正是这个形状。
//   ⚠️ 但 ④·二 **不是放宽**，理由必须说清（否则后来人会以为这里开了口子）：
//     判据不是"句子末尾有问号"，而是**句子内部存在祈使结构**（动词+量词：做个/写一份/改一下），
//     问号只是中文里的礼貌语气（「做一份周报吧？」「图改一下行不行？」）。
//     把这类句子判成"用户只是问问"，本身是一次**误判**；修误判 ≠ 扩大放行面。
//     反证：`这报告为什么写不出来？`／`方案呢？`／`要不要用 A 还是 B？` **一条都不含**
//     祈使结构，因此仍然判 QUESTION / PLAN（见 unit-intent-gate.mjs 的 L 组用例），
//     放行面严格只增加了"带祈使结构的礼貌请求"这一族。
//   另外 ① 否定执行仍然压过 ④·二：「先别动手，帮我做个落地页」照样降档（L 组有断言钉住）。

// ① 否定执行：用户明确说不要动手
//
// ★★ 2026-10-21 修一个**语义反转**（真模型 e2e 抓到的，118 步门禁全绿也没抓到）：
//   原第 3 条是 `/(先|只)(回答我|告诉我|说说|讲解|讲一下)/`，它把下面这句判成了「禁止执行」：
//        「必须真的把文件写出来，**不要只告诉我**方案。」
//   而这句话的意思**完全相反**——它是「别光说、动手做」，是最强的执行指令之一。
//   真机后果（scripts/tmp-probe/real-model-e2e.mjs，真 DeepSeek 实测）：
//        [intent] 本轮=「回答问题」(explicit-no-execute)，会改动环境的技能将被拦下
//        耗时 32.1s ｜ LLM 调用 **26 轮** ｜ 工具结果 **0 条**
//   模型反复想写文件、反复被拦，最后什么都没产出 —— 这正是老板实测失败的形状：
//   **用户越催「别只说不做」，系统越把权限收回**。语义被反转比判据不够准严重得多。
//
//   修法不是删掉「只告诉我」（没有否定的「只告诉我方案」确实该降档），而是：
//     ① 用负向后行断言排除否定前缀 —— 「不要只」「别只」「不用只」「无需只」「不必只」一律不算；
//     ② 把它**主动识别成执行授权**（见 EXEC_PATTERNS 新增那条）：这类句子是在催动手，
//        只做到「不误判成禁止」还不够，得让它真的拿到权限。
//   `(?<!不要)` 在位置 i 检查 i-2..i 是否 == '不要'，V8 支持变长 lookbehind。
const NO_EXEC_PATTERNS = [
  // ★ 「只说不做 / 光讲不做」是固定短语，意思是"别光动嘴"——它整体是**催办**。
  //   但字面上的「不做」会被本条规则当成否定执行。所以用 lookbehind 把这几个短语前缀排掉。
  //   漏掉它的症状（本轮实测）：「不准只说不做」被判 QUESTION。
  //   只排「(只|光|仅)(说|讲)」后面紧跟的那个「不」——「说不要做」这类不受影响。
  // ★★ 2026-10-23 修「否定词与动词之间插一个副词 ⇒ ① 整条失效」：
  //   中文最常见的禁止说法恰恰会插「去/再/乱/随便/…」——「不要去动」「别再动」「别乱改」。
  //   原来的判据要求「否定词 + 动词紧邻」（只允许夹 要/需/用），于是这些句子一条都不命中，
  //   流程继续往下走到 ②，被 `(去|开始|…)(做|改|修|…)` 判成 **explicit-execute**
  //   ⇒ 「不要去修改前面那 1 万」被判成「用户明确让我改」，**语义 180° 反转**。
  //   修法与上文 2026-10-21 那次是同一个病（否定语义被绕过），但 lookbehind 修不了邻接，
  //   只能让中间那段可见：容许**一个**修饰副词。
  //   ⚠️ 副词表**只收这 8 个**，绝不加 `只/光/仅` —— 那是"否定式催办"的排他对象，
  //     加进来会把「不要只告诉我方案」（催动手，最强执行指令）吃成 no-execute，语义又反一次。
  /(?<!只说)(?<!只讲)(?<!光说)(?<!光讲)(?<!仅说)(?<!仅讲)(不|别|先别|无需|不用|没必要|不要)(要|需|用)?(?:再|去|乱|随便|轻易|擅自|私自|直接)?(做|改|动|执行|动手|修|生成|建|写|跑|操作|处理|管)/,
  // ★ 本条与下面那条是同一个病的两处：`只回答/只说/只讲` 前面一旦是否定，
  //   整句就反转成催办（「不要只回答，直接改」）。四条共性前缀一并排除。
  //   漏掉本条的症状（本轮实测）：`别只说，直接给我文件` / `不用只回答，直接改` 仍被降档。
  /(?<!不要)(?<!别)(?<!不用)(?<!无需)(?<!不必)(?<!不准)(?<!不许)(只|仅)(是)?(回答|说|讲|解释|答|问)/,
  /(?<!不要)(?<!别)(?<!不用)(?<!无需)(?<!不必)(先|只)(回答我|告诉我|说说|讲解|讲一下)/,
  // ★ 2026-10-21 补「不许 / 不准 / 禁止」：这三者是最硬的禁止词，原来一条都不在表里
  //   ⇒「不许动我的配置」既不命中①也不命中任何 EXEC_PATTERN ⇒ 落到兜底 default-execute
  //   ⇒ 一条明确的禁令反而拿到了执行授权。这是既有缺陷（不是本轮改动引入的），
  //   但既然正在动这张表，就一并补上 —— 漏掉它的代价是「用户明说别碰，照样被碰」。
  /(别|不要|不用|不许|不准|禁止)(?:再|去|乱|随便|轻易|擅自|私自|直接)?(动|碰|管|改|删|写|做|跑)/,
  /(我问你|问你)(个|一个)?问题/,
  /不需要(做出来|动手|真的做)/,
];

// ② 显式执行授权：注意**刻意不含「查/看/找」** —— 那些是调查动作，应走 DIAGNOSE（只读），
//    若混进来会让「帮我查一下为什么崩了」被误判成执行授权。
const EXEC_PATTERNS = [
  /(帮我|替我|给我|帮忙|请你|麻烦你|麻烦)(做|改|修|写|建|生成|弄|搞|处理|完成|优化|调整|部署|发布|打包|上传|安装|更新|删|清理)/,
  /(去|开始|马上|立即|赶紧|现在|直接)(做|改|修|执行|动手|搞|弄|处理|干)/,
  /按(这个|下面|上述|上面|这份|那个)(执行|做|来|方案|改|干)/,
  /(执行|照做|开工|动手|干吧|搞吧|改吧|修吧|做吧|上吧|搞定|弄好|做好|修好|改好)/,
  /(继续|接着)(做|干|之前的|上次的|执行|修|改)/,
  // ★ 2026-10-21 新增：「别只说不做 / 不要只告诉我方案 / 别光说」= 明确的执行指令。
  //   与上面 NO_EXEC 的负向断言是一对：那边保证它不被判成禁止，这边保证它真拿到权限。
  //   「必须真的把文件写出来」这种「必须真的 X」也归这里 —— 它同样是在要求动手而非解释。
  //   否定词表必须含「不许/不准」：「不准只说不做」是催办，不是禁令（本轮实测漏过一次）。
  /(不要|别|不用|无需|不许|不准)(要)?(只|光|仅)(说|讲|告诉|回答|解释)/,
  /(必须|一定要?)(真的)?(把|给我)?(文件|东西|结果|产物|成品)?(写|做|生成|产|弄|搞)出(来|去)?/,
  // ★★ 2026-11-11 补「产出类动词缺表」—— 这是授权门（isDeliveryAuthorized）逼出来的真漏点：
  //   「帮我整理成文案」「把 11 条整理成一份社群文案」原本**一条 EXEC 模式都不命中**
  //   （上面动词表里没有"整理/汇总/润色/翻译/设计"这些最常用的产出动词），
  //   于是落 ⑥ default-execute。授权门只认 explicit-execute / imperative-request，
  //   就会把**明确的派活**判成"用户没让我做"而拦掉 —— 那是比漏拦更坏的误伤（该做的做不了）。
  //   ✅ 零行为回归：这两条只改变 reason（default-execute → explicit-execute），mode 仍是 EXECUTE。
  /(帮我|替我|给我|帮忙|请你|麻烦你|麻烦)(整理|汇总|编排|润色|翻译|设计|产出|输出|列出|排出|梳理|归档|合并|拆分|扩写|缩写|改写|写成|转成)/,
  // 「把 X 整理成 Y」处置式祈使。
  // ⚠️ `(成|为)` 后必须排除疑问词：否则「把这段整理成什么样」会被读成派活 ⇒ 模型直接造文件，
  //   而那正是本门要防的事故形态（用户只是想问格式）。负向断言是这条唯一不能省的部分。
  /把[^，。！？\n]{1,24}?(整理|汇总|编排|润色|翻译|设计|梳理|扩写|缩写|改写)(?:成|为)(?![什么啥哪怎])/,
  // ★★ 2026-11-11③ 修一个**真 bug**（不是补漏）：上面那条把「做成 / 写成 / 排成 / 转成」也列进了
  //   动词组，然后**又**要求后面跟 `(?:成|为)` ⇒ 等价于要匹配「做成成 / 做成为」。
  //   于是最标准的说法「把季度总结做成PPT」**一条都不命中**，落 ⑥ 兜底档 ⇒ 授权门拦下。
  //   实测代价：`unit-agent-resume` 的 C7 / C12 两条红（goal 原文正是「把季度总结做成PPT」）。
  //   修法：自带「成」的动词单独一条，后面不再要求「成/为」。
  /把[^，。！？\n]{1,24}?(?:做|写|生成|画|排|编|转|弄|切|拆|拼)成(?![什么啥哪怎])/,
];

// ③ 诊断：必须同时含「调查动作」，否则只是普通疑问句（STATEMENT 的问句走 QUESTION）
const DIAGNOSE_PATTERNS = [
  /(排查|诊断|定位|调查|追究)/,
  /(帮我|替我|给我|你)(查|分析|看看|看下|看一下|查查)(一下|下|一哈)?/,
  /(查|找)(一下|下)?(原因|根因|为什么|为何)/,
  /(哪(一|个)步|哪个环节|哪里)(出|有)(问题|毛病|错)/,
  /(证据|据我|你确认)(是什么|在哪)/,
];

// ④ 求方案
const PLAN_PATTERNS = [
  /(怎么|如何|怎样)(改|修|做|解决|处理|优化|避免|防止|实现|调整)/,
  /(有什么|有啥|有没|推荐)(方案|办法|思路|建议|选择)/,
  /(你|您)(建议|推荐|觉得应该)/,
  /(该|应该)怎么(办|做|改|处理)/,
  // 2026-09-23 补：实测「给我一个方案」「方案呢」落在 default-execute ⇒ 被误判成"可以动手"。
  // 求方案是**非执行**意图，必须能在 ④ 命中（位置在 EXEC ② 之后，所以「按方案执行」仍走 EXEC，安全）。
  /(给|来|出|要|整|拿|写|做|拟)(我|个)?\s*(一)?(个|份|套|版)?\s*(方案|计划|思路|提案|预案|对比|评估|建议|分析)/,
  /(方案|计划|思路|提案|预案|对比|评估)\s*(书|呢|吗|吧)?\s*[？?]?\s*$/,
  /(讨论|聊聊|商量|唠唠)(一下|下)?\s*(方案|思路|怎么做|怎么改|对策)/,
];

// ⑤ 疑问句兜底
const QUESTION_PATTERNS = [
  /(为什么|为何|是什么|什么是|啥意思|什么意思|怎么回事|怎么会|如何理解)/,
  /(你|您)(觉得|认为|怎么看|怎么想|意见)/,
  // ★★ 2026-10-23 修「`说明/解释` 被当成动词，于是**名词短语**也被降档」：
  //   原判据 `/(解释|说明|介绍|讲讲|说一下|科普|讲解)(一下|下)?/` 里后缀是**可选**的，
  //   所以裸的「说明」两个字就命中 ⇒「活动说明」「产品使用说明」「说明书」「说明文档」
  //   全部被判成 QUESTION ⇒ 用户明明在要一个**交付物**，闸门却把写文件权限收了。
  //   连带伤害是成串的：「写一份活动说明」「生成一个活动说明文档」同样中招
  //   （用户明确让写、系统判"你要我解释"）。
  //   根因：`说明/解释` 单独出现时**既可能是名词也可能是动词**，字面子串匹配分不出来。
  //   修法不是删规则（那会把「说明一下这个活动」判成执行授权，是更严重的反向错误），
  //   而是要求它**被支配**——三条支路任一命中才说明"用户在让我解释"：
  //     ① 有动词后缀（一下/下/明白/白/清楚）——「说明白点」「解释一下…」
  //     ② 有支配前缀（请/帮我/给我/替我/麻烦/详细/具体/简单/简要/你/您）——「请解释…」
  //     ③ 有指示宾语（这个/这段/这篇/这些/上述/上面）——「讲讲这个活动」
  //   三条都不满足的（`活动说明`、`说明书`）落回 ⑥ 默认档 EXECUTE，这正是设计意图
  //   （见 :256-259「只在明确出现疑问/求方案特征时才降档」）。
  //   ⚠️ 不要改成"名词黑名单"（活动说明|使用说明|说明书|…）—— 那是打地鼠，
  //     下一条「活动文案」「产品描述」又要补一个词。
  /(?:说一下|(?:解释|说明|介绍|科普|讲解|讲讲)(?:一下|下|明白|白|清楚)|(?:请|帮我|给我|替我|麻烦|详细|具体|简单|简要|你|您)(?:解释|说明|介绍|科普|讲解|讲讲)|(?:解释|说明|介绍|科普|讲解|讲讲)(?:这个|这段|这篇|这些|上述|上面))/,
  // 2026-09-23 补：反义/正反问句。实测老板最常说的「你是不是没安装成功啊」原落在
  // default-execute ⇒ 被当成"可以动手"，而它其实是**质问/提问**。这类句式必须能命中。
  // 放在 ⑤（优先级最低的疑问层）是安全的：「帮我查一下是不是坏了」仍先在 ③ 命中 DIAGNOSE。
  /(是不是|有没有|算不算|行不行|好不好|对不对|能不能|可不可以|要不要|是否)/,
  /[？?]\s*$/,
  /(吗|呢)\s*[？?]?\s*$/,
];

// ④·二 祈使请求的**结构判据**（2026-10-16）：动词 + 量词/宾语。
// 只认结构，不认问号。这几条合起来才是"用户在让我做东西"的证据。
const IMPERATIVE_REQUEST_PATTERNS = [
  // 动词 + 量词/动量词：「做个落地页」「写一份周报」「改一下图」「生成一个海报」「整理一遍」
  /(做|写|生成|制作|画|建|改|整理|弄|搞|导出|翻译|汇总|统计|排版|设计|装|修|调试|替换)(个|一个|一份|一下|一遍|份|张|篇|套|版|次|条|批)/,
  // 「帮我把 X 做了」——"把"字句，宾语被提前，量词可能不在动词后面
  /帮(我|忙)?(把|将)/,
];
// 「真疑问词」黑名单：句子里出现这些，说明用户在**问**而不是在**让我做**，一律不进 ④·二。
// 这是 ④·二 的第二道窄口 —— 没有它，「做个落地页为什么不行？」会被误当成执行请求。
const TRUE_INQUIRY_RE = /(为什么|为何|什么|啥|怎么|如何|怎样|哪里|哪个|哪一|是不是|是否|算不算|对不对|有没|要不要)/;
// 「礼貌疑问尾」：中文里把请求说得客气，问号/语气词只是语气，不改变"这是请求"。
const REQUEST_TAIL_RE = /(?:[？?]|(?:吗|呢|吧|行吗|行不行|好吗|好不好|可以吗|可不可以|成吗))\s*[。！!.…~～]*\s*$/;

/**
 * 这一句是不是「带祈使结构的礼貌请求」（例如「做个落地页行吗？」「图改一下行不行？」）。
 * 判定三件套，缺一不可：① 有祈使结构；② 有礼貌疑问尾；③ **不含**真疑问词。
 * @param {string} text
 * @returns {boolean}
 */
function isImperativeExecuteRequest(text) {
  const t = String(text || '');
  if (!t) return false;
  if (!REQUEST_TAIL_RE.test(t)) return false;              // ② 没有疑问尾 ⇒ 不是本族（交给 ②/⑥）
  if (TRUE_INQUIRY_RE.test(t)) return false;               // ③ 含真疑问词 ⇒ 用户在问，不是让我做
  return hitPatterns(t, IMPERATIVE_REQUEST_PATTERNS).length > 0; // ① 必须有祈使结构
}

function hitPatterns(text, patterns) {
  const hits = [];
  for (const p of patterns) {
    if (p.test(text)) hits.push(String(p));
  }
  return hits;
}

// ===================== 四·三 「落成文件」的显式指令（2026-11-12）=====================
// 【为什么必须单独一条】用户最标准的交付说法是「把这份诊断报告存成 Word 文件」——
//   它不带「帮我/给我」前缀，也没有「动词+量词」（存成 ≠ 写一份），
//   于是旧判据里 ② 不命中；③ 又因为句中有「诊断/报告」被判成 DIAGNOSE；⑥ 兜底也不放行。
//   结果：用户连说了几次「存成文件」，文件一次都没落盘，模型只能反复问「要我现在整理吗」。
//   （事故现场：把诊断报告写成 Word 那一轮，6 次写盘全被这道门拦下。）
//
// 【只认结构】落盘动词 + 文件类名词，且两者相距不超过 12 字（不跨句）。
//   反例「把这段整理成什么样」——没有文件类名词，不命中；
//   「为什么存成文件会失败」——含真疑问词，在 classifyIntent 里被 TRUE_INQUIRY_RE 挡回原判定。
//   ⚠️ 动词表**刻意不含「生成」**：「生成一个活动说明文档」这条由既有的「动词+量词」
//   （CREATION_QUANTIFIER_RE）负责，判据保持它原来的 default-execute 口径；
//   这里只补「存成/保存为/导出成/写成…」这一族原来没人管的说法。
const SAVE_VERB_RE = /(?:存成|存为|保存成|保存为|另存为|存到|保存到|写到|写入|写成|导出成|导出为|导出到|输出成|输出为|输出到|整理成|做成|转成)/;
const FILE_KIND_RE = /(?:文件|文档|报告|表格|文案|清单|方案|总结|Word|word|DOCX|docx|PDF|pdf|Excel|excel|XLSX|xlsx|PPT|ppt|PPTX|pptx|TXT|txt|Markdown|markdown|md|图片|照片|截图|\.[a-z0-9]{2,5})/;
const ARTIFACT_SAVE_RE = new RegExp(SAVE_VERB_RE.source + '[^。！？?]{0,12}' + FILE_KIND_RE.source);

/**
 * 判定本轮用户意图。
 * @param {string} userText 用户这一轮说的话（**只取本轮**，不要把整段历史塞进来）
 * @param {{keepQuotes?:boolean}} [opts] keepQuotes=true 时不剥离引用块（仅调试用）
 * @returns {{mode:string, signals:string[], reason:string, probed:string}}
 */
function classifyIntent(userText, opts) {
  const o = opts || {};
  const raw = String(userText || '');
  const probed = o.keepQuotes ? raw.trim() : stripQuoted(raw);

  if (!probed) {
    return { mode: MODE.EXECUTE, signals: [], reason: 'empty-input', probed };
  }

  // ① 否定执行 —— 最强信号，压过一切
  const noExec = hitPatterns(probed, NO_EXEC_PATTERNS);
  if (noExec.length) {
    const diag = hitPatterns(probed, DIAGNOSE_PATTERNS);
    return {
      mode: diag.length ? MODE.DIAGNOSE : MODE.QUESTION,
      signals: noExec.concat(diag),
      reason: 'explicit-no-execute',
      probed,
    };
  }

  // ② 显式执行授权
  const exec = hitPatterns(probed, EXEC_PATTERNS);
  if (exec.length) {
    return { mode: MODE.EXECUTE, signals: exec, reason: 'explicit-execute', probed };
  }

  // ②·二 明确的「落成文件」指令（见 ARTIFACT_SAVE_RE 头注）。
  //   位置必须在 ③ 诊断之前：「把这份诊断报告存成 Word 文件」含「诊断」二字，
  //   放到 ③ 后面会被判成只读调查 ⇒ 写文件仍被拦。
  //   含真疑问词（为什么/怎么/是否…）的句子不在此列：那是在问原因，不是让我写。
  if (!TRUE_INQUIRY_RE.test(probed) && ARTIFACT_SAVE_RE.test(probed)) {
    return { mode: MODE.EXECUTE, signals: [String(ARTIFACT_SAVE_RE)], reason: 'artifact-save', probed };
  }

  // ③ 诊断
  const diag = hitPatterns(probed, DIAGNOSE_PATTERNS);
  if (diag.length) return { mode: MODE.DIAGNOSE, signals: diag, reason: 'diagnose', probed };

  // ④ 求方案
  const plan = hitPatterns(probed, PLAN_PATTERNS);
  if (plan.length) return { mode: MODE.PLAN, signals: plan, reason: 'plan', probed };

  // ④·二 祈使请求 + 礼貌疑问尾 ⇒ 这是执行请求，问号只是语气（2026-10-16 修正误判）
  // 位置很关键：必须在 ①~④ 之后、⑤ 之前。
  //   在 ① 之后 ⇒ 「先别动手，帮我做个落地页」仍被否定压过（安全底线不动）。
  //   在 ③ 之后 ⇒ 「帮我查一下为什么崩了」仍是 DIAGNOSE（不会被"查一下"里的量词带跑）。
  //   在 ④ 之后 ⇒ 「给我做个方案？」仍走 PLAN（"做个方案"是求方案，不是开工）。
  //   在 ⑤ 之前 ⇒ 只有"已排除上面全部降档理由、且句内有祈使结构"的句子才会落到这里。
  if (isImperativeExecuteRequest(probed)) {
    return {
      mode: MODE.EXECUTE,
      signals: hitPatterns(probed, IMPERATIVE_REQUEST_PATTERNS),
      reason: 'imperative-request',
      probed,
    };
  }

  // ⑤ 疑问句
  const q = hitPatterns(probed, QUESTION_PATTERNS);
  if (q.length) return { mode: MODE.QUESTION, signals: q, reason: 'question', probed };

  // ⑥ 默认（向后兼容）
  return { mode: MODE.EXECUTE, signals: [], reason: 'default-execute', probed };
}

// ===================== 五、被拦时回灌给模型的话 =====================
/**
 * 闸门拦下某次工具调用后，回灌给模型的 tool 结果。
 * 必须做到三件事：① 说清"没有执行"（不能让它以为做过了）；
 *              ② 说清"为什么不许"（当前是问答/调查模式，未获执行授权）；
 *              ③ 给出**正确的下一步**，否则模型会原地换个技能名重试，浪费轮次和 token。
 *
 * ★ 2026-10-16 改写 ③ —— 为什么非改不可（这是"反复追问、用户不答就不干活"的直接来源）：
 *   旧文案的 ③ 写的是「如果确实必须动手，就明确问一句『这需要我动手改，你确认吗』，
 *   等用户明确同意后再做」—— 它把「反问用户要授权」定义成了**默认正确做法**。
 *   而 backend 有一整段**无条件注入**给模型的硬规矩：「严禁把『A 还是 B』这种决策原样抛回给用户 /
 *   绝不许把技术决策抛回给用户——用户找你，正是因为他不想做这个决定」。
 *   两条指令正面冲突，模型只能折中成「我先确认一下再动手」，于是同一件事被反复追问；
 *   更糟的是用户答了「做吧」之后**本轮 intentMode 并不会改**（升级只发生在
 *   clarify_requirements / request_material 拿到真实答复的分支里），模型想动手仍被拦 ⇒ 再问一遍。
 *
 *   新 ③ 的唯一硬要求：**先把用户问的答清楚；能动手就直接动手，不要反问「你确认吗」**。
 *   反问被压缩到只剩一种合法场景：真的缺「只有用户才知道的关键信息」，且一次问完。
 */
function gateDirective(skillName, mode, strikeCount) {
  const label = MODE_LABEL[mode] || '未获执行授权';
  const n = Number(strikeCount) || 0;
  const lines = [
    '【意图闸门·已拦下，未执行】用户这一句是「' + label + '」性质，',
    '而这次调用（' + skillName + '）会**改动环境**（写文件 / 跑命令 / 部署 / 下单等），所以被拦下、**没有执行**。',
    '注意：这不是"做了但失败了"，而是**根本没做** —— 不要对外声称已经做完任何事。',
    '',
    '下一步按顺序做，别跳步：',
    '1) 先用自然语言把用户问的这件事**回答清楚**。这是本轮必须完成的事。',
    '2) 如果用户的意图里本来就包含「动手做这件事」，**不要反问「你确认吗」**——',
    '   那等于把决定抛回给用户，而他找你正是不想做这个决定。改成用一句话说明',
    '   「我这就开始做 X」，然后继续做你此刻就能做的那部分（只读核对、准备工作、给出方案），',
    '   不要停下来等一句确认；用户下一句如果说不要，立刻停。',
    '3) 只有真的缺「只有用户才知道的关键信息」（目标网址、要改哪一份文件、交给谁）时，',
    '   才用 clarify_requirements 问一次 —— **一次把所有问题问完**，不要拆成好几轮追问。',
    '**不要换个技能名重试同一件事。**',
  ];
  if (n >= 2) {
    lines.push('');
    lines.push('（这已经是第 ' + (n + 1) + ' 次被拦下。请立即停止再调用任何会改动环境的技能，'
      + '直接用自然语言给结论；如果这件事本来就该做，就说明你已经做到哪一步、还差什么，'
      + '不要再问用户"要不要授权"。）');
  }
  return lines.join('\n');
}

// ===================== 五、任务意图的唯一取值点 =====================
// 上面四节判的是「这一轮能不能动手」；这一节判的是「整件任务要交付什么」。
// 两者都必须读用户原话，但**不是同一句话**：前者读本轮，后者读整件任务。
// 把后者也塞进闸门判定里是错的（跨轮继承会把"上周让你部署过"变成今天的永久授权）；
// 但让它和闸门读**同一份落盘来源**是对的 —— 见 resolveTaskGoal 头注。

/**
 * 任务意图的字符上限（`resolveTaskGoal` 的默认值）。
 *
 * 为什么从 300 抬到 2000：修前验收侧拿到的是 `clip(lastUserText, 300)`。
 * 用户一句「帮我做个面向经销商的报价单页面，要有报价列表/加购/门诊名称弹窗/……」
 * 写到 400 多字，后 100 字被直接切掉，而那 100 字往往正是最后补的那几条硬约束。
 * **验收员看不到的约束，它就不会判它缺失** —— 交付看起来"通过了"，用户一眼就看出没做。
 *
 * 2000 不是"够用"，是"比一条长需求的正常长度更长"；仍有硬上限，防的是
 * 有人把整篇文档粘进来把上下文炸掉。真被截断时文本里会留可见标记（不静默截断）。
 */
const TASK_GOAL_MAX_CHARS = 2000;

/** 同一句判定的归一化：只用于比较，不参与输出。 */
function goalNorm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * 「这次任务的意图是哪一段文本」—— 意图这件事在代码里的**唯一取值点**。
 *
 * ── 为什么必须存在（老板点名质问「这份设计里 goal.md 在哪、你能指着图上某个模块
 *    说『就是它保存意图』吗」之后的落点）────────────────────────────────────
 * 修前这里有**两个互不相干、且都不完整的意图**：
 *
 *   | | 执行侧 | 验收侧 |
 *   |---|---|---|
 *   | 载体 | `project.origin.text`（项目账，落盘） | `taskGoal`（局部变量，不落盘） |
 *   | 取的是哪句 | 最初那句原话 | 最后一条消息 |
 *   | 完整度 | 原话，不截断 | `clip(…, 300)` |
 *   | 重启后还在 | 在 | 不在 |
 *
 * 后果不是"不够优雅"，是**判卷人和干活的人看到的不是同一份卷子**：
 * 用户在第 3 轮补的「注意别把 A 和 B 混了」，只进了验收侧（因为它取最后一条），
 * 而最初那句「一共要 12 页」只进了执行侧（因为验收只取最后一条，前面全丢）。
 * 两边各拿一半，谁都不完整。
 *
 * ── 现在的规则（只有这一条，不设分支树）─────────────────────────────
 *   1. 有项目账 ⇒ 以 `origin.text`（最初原话）为**主目标**；
 *   2. 本轮指令与最初原话不是同一句 ⇒ 追加成 `【本轮要求】` 段，**不覆盖**主目标；
 *   3. 没有项目账（内部子运行 / 只读问答 / 项目账损坏）⇒ 用本轮指令；
 *   4. 只有超过 `maxChars` 才截断，且**在文本里留可见标记** —— 静默截断等于伪造完整度。
 *
 * 「同一句」按空白归一后逐字比对：前端重试、用户复述需求时，不该在验收提示里
 * 出现两遍一模一样的话（那会让复检员以为用户强调过两次）。
 *
 * ⚠️ 纯函数、零 IO：项目账在外面读好后传进来。这样这段判定可以被单测直接打，
 *    不需要起 Electron，也不需要造一个真账本。
 *
 * @param {{project?:object, intentText?:string, maxChars?:number}} input
 * @returns {{goal:string, source:'origin'|'origin+turn'|'turn'|'empty',
 *            originChars:number, turnChars:number, totalChars:number,
 *            truncated:boolean, projectId:string}}
 */
function resolveTaskGoal(input) {
  const x = (input && typeof input === 'object') ? input : {};
  const originText = (x.project && x.project.origin && typeof x.project.origin.text === 'string')
    ? x.project.origin.text.trim() : '';
  const turnText = typeof x.intentText === 'string' ? x.intentText.trim() : '';
  const maxChars = Number(x.maxChars) > 0 ? Math.floor(Number(x.maxChars)) : TASK_GOAL_MAX_CHARS;
  const projectId = (x.project && typeof x.project.projectId === 'string') ? x.project.projectId : '';

  const sameAsOrigin = !!originText && !!turnText && goalNorm(originText) === goalNorm(turnText);
  // 「本轮是否真的贡献了一段」—— 与 `sameAsOrigin` 不是同一件事，别合并：
  //   · 没有项目账时，本轮文本**就是目标本身**，不该被贴上「【本轮要求】」的标签。
  //     贴上等于告诉复检员"还有一份最初目标没给你"，而其实没有。
  //   · 本轮为空（用户直接点了继续/重跑）时也不贡献段落，source 就不能写成 origin+turn。
  // 这两条都是本门禁 A1 / A8 打出来的真缺陷（第一版实现把 `!sameAsOrigin` 当成了
  // 「本轮有内容」，于是无项目账的正常任务也被贴上了「本轮要求」标题）。
  const hasTurnPart = !!turnText && !sameAsOrigin;
  const parts = [];
  if (originText) parts.push(originText);
  if (hasTurnPart) parts.push(originText ? ('【本轮要求】\n' + turnText) : turnText);
  const full = parts.join('\n\n');

  const truncated = full.length > maxChars;
  const goal = truncated
    ? full.slice(0, maxChars) + '\n…[意图已截断：原文 ' + full.length + ' 字，上限 ' + maxChars + ' 字]'
    : full;
  const source = !originText
    ? (turnText ? 'turn' : 'empty')
    : (hasTurnPart ? 'origin+turn' : 'origin');

  return {
    goal,
    source,
    originChars: originText.length,
    turnChars: turnText.length,
    totalChars: full.length,
    truncated,
    projectId,
  };
}

// ===================== 六·补、新建交付物的授权档（2026-11-11）=====================
/**
 * ★★ 为什么需要这一层：`classifyIntent` 的档位回答的是「**这一轮像不像在派活**」，
 *    而「要不要**凭空造一个新文件**」是另一件事，且代价不对称。
 *
 * 事故现场（老板 2026-11-11 复盘的 0.21.31 那轮，证据逐条可查）：
 *   用户只说了两句 ——「11 条暗号 + 你知道这 11 个代表什么么」和「第一个是皇空8 第6个是尼尔机械纪元」。
 *   第二句是在**回答模型自己的提问**，不是派活。
 *   但模型在这一轮 turn 0 就写了 7.6KB 的交付文件，理由是"我上一轮答应你的"。
 *   那个"答应"是它**自己上一轮提的建议**，用户从未确认。
 *   ⇒ 它造出了一个没人要的交付物 → 为了交差把猜测写成"已核对" → 又要验这东西却验不了 → 卡死。
 *
 * 根因不是模型偶发，是判据档位：这两句话都没有任何动作词、也没有任何肯定词，
 * 于是**落进 ⑥ `default-execute` 兜底档**，而兜底档在 `AUTHORIZED_MODES` 里 ⇒ 拿到执行授权。
 * （实测：`classifyIntent('第一个是皇空8 第6个是尼尔机械纪元').reason === 'default-execute'`）
 *
 * ⚠️ **不能直接把兜底改成 QUESTION**：`default-execute` 是向后兼容档，
 *   「红色主题的落地页」这种无动词短句也落这里，改方向会让大量正常任务做不成。
 *   兜底是对的，错的是**拿兜底当授权凭据去造新文件**。
 *   ⇒ 所以本层不改 `classifyIntent` 一个字（零回归），只在它之上加一条**更严的消费口径**。
 *
 * 【失败方向：fail-open，且必须写清为什么】
 *   本函数抛错/拿不到输入 ⇒ 返回 `ok:false`（= 不授权）**不**代表"拦死"，
 *   因为调用方 `planAuthGate` 还有 `alreadyBlocked`（只拦一次）与 `pathExists`（覆盖不拦）两道旁路，
 *   且被拦时给的是"问一句再动手"而不是"做不了"。
 *   ★ 真正必须 fail-open 的是 `planAuthGate` 顶层的 try/catch（写在那边），
 *     而不是这里 —— 这里判错方向会把正常任务的做法说错。
 */

/**
 * 有**证据**的执行授权档位。`default-execute` 刻意不在内：它表示"什么都没找到"，不是"用户让我做"。
 */
const DELIVERY_AUTH_REASONS = new Set(['explicit-execute', 'imperative-request']);
// 2026-11-12：用户明确说「把 X 存成/写成/导出成 <文件类>」时，classifyIntent 落 `artifact-save`。
// 这是比「帮我做一份」更直接的落盘指令，必须能过授权门 —— 单独 add 而不是写进上面的字面量，
// 是为了不改动 unit-auth-gate 的 RC-AU1 变异锚点（那行文字是那条反控的判据本体）。
DELIVERY_AUTH_REASONS.add('artifact-save');

/**
 * 「动词 + 量词」/「动词 + 一下」= 要动手。授权门用它兜住最朴素的派活
 * （详见 isDeliveryAuthorized 里的长注释）。
 *
 * ★ 判据的核心是**结构**，不是修辞：
 *   ① 动词 + 量词：「写一个 / 写个 / 生成一份 / 做一版 / 画一张 / 出一套 / 整理一份」⇒ 成立
 *   ② 动词 + 一下：「跑一下 / 试一下 / 执行一下 / 改一下」⇒ 成立
 *      （实测漏点：「并行跑一下」—— 一句再普通不过的派活，动词表里连「跑」都没有，
 *        落 ⑥ 兜底档 ⇒ 被授权门拦下 ⇒ `unit-agent-resume` 的 P4b 当场红。
 *        这是**误伤**，比漏拦更坏：该做的做不了。）
 *
 * ★ 为什么这两条都不靠"猜时态"：
 *   · 「我写了一个 bug」「他画了一张图」是陈述过去 ⇒ 量词必须紧跟在动词后，
 *     中间夹「了」就断掉 —— 结构上就不命中，不需要任何时态推断。
 *   · 「这段写的什么」「写得不错」⇒ 后面不是量词也不是「一下」，不命中。
 *   ⚠️ 已知会放行的边缘例：「我试一下」这种"用户自己动手"的话也会被判成派活。
 *     接受它 —— 这一层**多放行只是回到本门上线前的行为**（先做再说），
 *     而漏放行会让正常派活彻底做不成。方向不对称，所以宁可放宽。
 */
const CREATION_QUANTIFIER_RE =
  /(?:写|生成|制作|做|画|创建|新建|搭建|出|整理|输出)(?:一个|一份|一张|一套|一篇|一版|个|份|张|套|篇|版)/;
const IMPERATIVE_YIXIA_RE =
  /(?:跑|试|执行|调|改|弄|搞|处理|做|写|生成|画|建|搭|装|部署|上传|打包)(?:一下|下)/;

/**
 * 明确的肯定/放行话术（整句级）。
 * 为什么要单独列：用户答「可以」「做吧」时**不含动作词**，`classifyIntent` 同样落 default-execute，
 * 若只认 reason 白名单，会把"用户已同意"也判成未授权 —— 那正是 §八 明令禁止的
 * 「反复追问用户」的老病复发。所以肯定词必须是一等判据。
 *
 * ⚠️ 匹配前先剥标点空白再**整句**比对（见 isAffirmative），不做子串匹配：
 *   子串匹配会让「不可以」命中「可以」，把一条明确的拒绝读成同意 —— 方向反了是最坏的错。
 */
const AFFIRM_WORDS = [
  '好', '好的', '好呀', '好滴', '好吧', '可以', '可以了', '行', '行吧', '行了',
  '嗯', '嗯嗯', '对', '是的', '对的', '没问题', '同意', '批准', '准了',
  '做吧', '做', '开始', '开始吧', '干吧', '去吧', '上吧', '搞吧', '来吧', '动手', '开工',
  '继续', '接着来', '就这么办', '就这个', '按你说的做', '按这个来', '那就做', '那就开始',
  'ok', 'okay',
];

/** 「可以，但第 3 条改一下」—— 前半是放行、后半是追加要求。这类**是授权**，不能因为带了要求就不认。 */
const AFFIRM_THEN_REQUEST_RE = /^(?:可以|好|行|没问题|同意|嗯)(?:但|不过|只是|另外|同时|顺便|然后)/;

/** 剥掉标点/空白/引号，用于整句级比对（`好，开始吧` ⇒ `好开始吧`）。 */
function squashForAffirm(text) {
  return String(text == null ? '' : text)
    .replace(/[\s，,。.!！?？~～、；;：:"'“”‘’…—\-]/g, '')
    .toLowerCase();
}

/**
 * 这一句是不是明确的放行/同意（用于「模型上一轮自己提的建议，用户这轮点头了」）。
 * @param {string} text
 * @returns {boolean}
 */
function isAffirmative(text) {
  const t = squashForAffirm(text);
  if (!t) return false;
  if (AFFIRM_WORDS.indexOf(t) >= 0) return true;
  if (AFFIRM_THEN_REQUEST_RE.test(t)) return true;
  // 两段式：「好开始吧」「可以动手」= 肯定词 + 另一个肯定词/动作词。
  // ⚠️ 只允许**前缀**切分，且余下部分必须**也**是肯定词 —— 否则「好，问题在哪」会被误判成同意。
  for (const w of AFFIRM_WORDS) {
    if (w.length >= t.length) continue;
    if (t.indexOf(w) !== 0) continue;
    const rest = t.slice(w.length);
    if (AFFIRM_WORDS.indexOf(rest) >= 0) return true;
  }
  return false;
}

/**
 * 用户这一轮是否给了「**可以新建交付物**」的授权。
 *
 * 与 `isExecutionAuthorized(mode)` 的区别（两者不是一回事，别混用）：
 *   · `isExecutionAuthorized` 回答「这一轮能不能动手」—— 宽，含兜底档，管的是只读/调查类动作；
 *   · 本函数回答「能不能**凭这一轮**造一个新文件出来」—— 严，只要**有证据**的授权。
 *
 * @param {string} userText 本轮用户原话（**只取本轮**）
 * @returns {{ok:boolean, reason:string, matched?:string}}
 */
function isDeliveryAuthorized(userText) {
  const raw = String(userText == null ? '' : userText);
  if (!raw.trim()) return { ok: false, reason: 'empty-input' };
  const r = classifyIntent(raw);
  if (DELIVERY_AUTH_REASONS.has(r.reason)) return { ok: true, reason: r.reason };
  if (isAffirmative(raw)) return { ok: true, reason: 'affirmative' };
  // ★★ 2026-11-11② 「动词 + 量词」= 最朴素的派活，**授权门自己认，不动意图分档**。
  //
  // 为什么漏在授权门这一层（实测，不是推测）：
  //   「写一个报告文件给我」——最普通的一句建文件请求。它落到 ⑥ 兜底档（既没命中"显式执行"
  //   也没命中"否定"），因为动词表里所有"写/做"都要求带 `帮我/给我/替我` 前缀。
  //   而授权门只认 explicit-execute / imperative-request ⇒ 判成"用户没让我做" ⇒ 拦下。
  //   实测代价：`unit-loop-unit-e2e` ⑥ 组（原话正是这句）6 条断言全红 —— 造不出真文件，
  //   artifactHashes 为空，连"哈希骗不过谎"那条硬断言都失去了被测对象。
  //
  // 为什么**不**加进 EXEC_PATTERNS（第一版就是那么写的，被门禁打回来）：
  //   加进去会把 reason 从 default-execute 改成 explicit-execute ⇒ `unit-intent-gate`
  //   当场 11 条红（它逐条钉着"这几句属于兜底档"的正控与变异锚点）。
  //   mode 没变、行为没变，却要为了一个措辞去改 11 条既有断言 —— 那是拿测试迁就实现。
  //   分档口径是既有契约；这里要的只是"**授权门**认不认这一句"，所以判据放在这一层。
  //
  // 判据用「动词 + 量词」：量词是"要一个新东西"的语言标志。
  //   · 不跨「了」：「我写了一个 bug」「他画了一张图」是陈述过去，不是派活
  //     （量词必须紧跟在动词后，中间夹"了"就不命中 —— 正则天然挡住，不需要额外的时态判断）。
  //   · 「这段写的什么」「写得不错」也天然不命中（后面不是量词）。
  // ⚠️ 安全方向：这一层**多判授权是安全的**（= 回到改之前的行为，先做再说）；
  //   **漏判才危险**（该做的做不了）。所以宁可放宽。
  if (CREATION_QUANTIFIER_RE.test(raw)) return { ok: true, reason: 'creation-with-quantifier' };
  if (IMPERATIVE_YIXIA_RE.test(raw)) return { ok: true, reason: 'imperative-with-yixia' };
  return { ok: false, reason: r.reason };
}

/**
 * 授权门的判定（纯函数：存在性由调用方注入，便于门禁直接喂输入看输出）。
 *
 * 只拦一种组合（**五条**同时成立，任一条不成立就放行）：
 *   ① 这个技能会写出新的交付物（`isProducerSkill(skillName, params) === true`）；
 *   ② 目标是**新建**（`pathExists === false`）—— 覆盖已有文件不在本门管辖内；
 *   ③ 本轮用户没给交付授权（`isDeliveryAuthorized().ok === false`）；
 *   ④ 本任务还没被这道门拦过（`alreadyBlocked === false`，只拦一次）；
 *   ⑤ 本轮**也没有**从"用户答澄清 / 给素材 / 短追问沿用"拿到授权（`alreadyGranted === false`）。
 *
 * ★ ① 的变化（2026-11-11 夜）：原来是 `skillName === 'file-write'`。
 *   改的理由与后果见 `PRODUCER_SKILLS` 头注 —— 一句话：**只守一个技能名 = 换个技能就复发**。
 *   注意 ① 只扩大**范围**，不放宽**判据**：②③④⑤ 一个字没动。
 *
 * ★ 为什么必须有一条 ⑤（这条是被门禁抓出来的真回归，别删）：
 *   用户答澄清时说的是「口腔诊所」这种短答案，`isDeliveryAuthorized('口腔诊所')` 必然 false，
 *   于是 ③ 成立 ⇒ 被拦 ⇒ 用户答了还是不干活，退回本仓最老的那个病
 *   （`gateDirective` 头注：「用户答了『做吧』仍被拦 ⇒ 再问一遍」）。
 *   实测证据：加 ⑤ 之前 `unit-intent-gate-runtime` 的 9c / 10c / 11c 三条同时转红，
 *   报的都是「实际执行=[]」—— 也就是说模型写文件的调用确实被本门吃掉了。
 *   `alreadyGranted` 的来源是 backend 里那几处 `intentMode = INTENT_MODE.EXECUTE` 的
 *   "因用户答复而升级"分支（唯一真源），本函数不自己再判一遍。
 *
 * @param {object} o
 * @param {string} o.skillName
 * @param {object} [o.params]        该次调用入参（只用于 action 级只读例外，见 PRODUCER_READONLY_ACTIONS）
 * @param {boolean} o.pathExists     目标文件是否已存在（调用方用 fs 判，本函数不碰 IO）
 * @param {string} o.userText        本轮用户原话
 * @param {boolean} [o.alreadyBlocked] 本任务内是否已被本门拦过
 * @param {boolean} [o.alreadyGranted] 本轮是否已从用户答复/素材拿到交付授权
 * @param {string} [o.target]        目标路径（仅用于回灌文案与审计，不参与判定）
 * @param {boolean} [o.targetKnown]  目标路径是否**可靠**推出来了。仅落 trace，不参与判定 ——
 *   推不出来时调用方必须已把 `pathExists` 置 false（= 当作新建 ⇒ 仍受门管，fail-closed）。
 *   这一位存在的唯一目的是让事后审计能分清"真的新建"与"推不出所以按新建处理"。
 * @returns {{blocked:boolean, reason:string, target:string, directive:string, event:object}}
 */
function planAuthGate(o) {
  const c = o || {};
  const name = String(c.skillName == null ? '' : c.skillName);
  const pass = (reason) => ({ blocked: false, reason, target: '', directive: '', event: {} });

  // ★ 2026-11-11 夜：判据由 `name !== 'file-write'` 改为「是不是产出类技能」。
  //   原来那一句等于把门的有效性绑在"模型下次还调 file-write"这个假设上 ——
  //   0.21.31 它换成了 docx-generate，门一声不响地放行（实测 auth-gate 命中=0）。
  //   ⚠️ 方向说明：范围**只扩大、不放宽** —— 进本表只是"不再早退"，
  //   下面四条旁路（覆盖已有 / 只拦一次 / 已点头 / 本轮派活）一条都没动。
  if (!isProducerSkill(name, c.params)) return pass('not-producer-skill');
  if (c.pathExists === true) return pass('overwrite-existing');
  if (c.alreadyBlocked === true) return pass('already-blocked-once');
  if (c.alreadyGranted === true) return pass('granted-by-answer');

  const auth = isDeliveryAuthorized(c.userText);
  if (auth.ok) return pass('authorized:' + auth.reason);

  const target = String(c.target == null ? '' : c.target);
  return {
    blocked: true,
    reason: 'no-delivery-auth:' + auth.reason,
    target,
    directive: authGateDirective(c.userText, auth.reason),
    event: {
      gate: 'auth',
      skill: name,
      target,
      // ★ 这一位不是装饰：`target` 为空有两种完全不同的原因 ——
      //   ① 真·没目标（理论上不该有）；② 该技能的路径字段形态推不出（如 project-scaffold 的
      //   `files[].path` 在 JSON 里，或 media-edit 由 input 派生）。
      //   两者在 trace 里长得一样，事后审计就会把"按新建处理"误读成"真的新建"。
      //   所以把"推没推得出来"单独记一位，让审计能分开。
      targetKnown: c.targetKnown === true,
      intentReason: auth.reason,
      userTextHead: String(c.userText == null ? '' : c.userText).replace(/\s+/g, ' ').slice(0, 200),
    },
  };
}

/**
 * 被授权门拦下时回灌给模型的 tool 结果。三件事必须说清（同 `gateDirective` 的口径）：
 *   ① 文件**没有**被创建（不许让它以为写过了）；
 *   ② 为什么（这一轮用户只是在补信息/回答你的提问，不是在派活）；
 *   ③ **正确的下一步** —— 而且**不许**是"你确认一下"这种把选择题推回去的写法。
 */
function authGateDirective(userText, reason) {
  const said = String(userText == null ? '' : userText).replace(/\s+/g, ' ').trim().slice(0, 120);
  const L = [];
  L.push('【没有创建文件】这次调用没有执行，目标文件不存在。');
  L.push('原因：这一轮用户说的话是「' + (said || '（空）') + '」，');
  L.push('判据是 ' + (reason || 'no-delivery-auth') + ' —— 它**只是补充信息 / 回答你上一个问题 / 一句陈述**，');
  L.push('既没有动作要求（"帮我做…/整理成…"），也没有明确点头（"可以/做吧/开始"）。');
  L.push('');
  L.push('★ 这里最容易犯的错，正是你在 0.21.31 那一轮犯的：');
  L.push('  你把**自己上一轮的建议**（"你把答案告诉我，我就能整理"）当成了用户已经同意。');
  L.push('  那不是承诺，那是你自己的提议 —— **用户补充信息 ≠ 授权执行；自己提的建议 ≠ 用户已同意**。');
  L.push('');
  L.push('现在按下面之一继续：');
  L.push('· 如果用户问的东西你还没答完 → **先把答案说完**。做完这一步通常就结束了，不需要造文件。');
  L.push('· 如果你判断确实该出一份文件 → 问**一句**（不是一堆）：「要我现在就整理成一份文案吗？」然后**停下等回复**。');
  L.push('  用户回「可以 / 做吧 / 开始」后，下一轮就直接做，不要再问。');
  L.push('· 禁止：换个技能名重试 / 换个路径重试 / 先把内容攒在对话里等绕过去。');
  return L.join('\n');
}

module.exports = {
  MODE,
  MODE_LABEL,
  AUTHORIZED_MODES,
  READONLY_SKILLS,
  META_TOOL_NAMES,
  // ★ 产出类技能（授权门 + 事实门的唯一真源）。backend 的成果卡登记表改为从这里 import，
  //   不再自己养一份字面量 —— 两份迟早漂移，而漂移的症状是"门悄悄漏掉一个技能"（不报错）。
  PRODUCER_SKILLS,
  PRODUCER_READONLY_ACTIONS,
  isProducerSkill,
  isExecutionAuthorized,
  isSkillAllowed,
  isShortFollowUp,
  FOLLOW_UP_GRACE_MS,
  stripQuoted,
  lastRealUserText,
  // ★ 系统注入前缀判据（唯一真源）：memoryExtractor 也调它，见 isSystemInjectedText 头注。
  isSystemInjectedText,
  SYSTEM_INJECT_PREFIX_RE,
  classifyIntent,
  gateDirective,
  // ④·二 的判据一并导出：门禁要用它做**双向变异**（关掉 / 放宽过头），
  // 只测"它能放行"证明不了"它没放宽过头"。
  IMPERATIVE_REQUEST_PATTERNS,
  TRUE_INQUIRY_RE,
  REQUEST_TAIL_RE,
  isImperativeExecuteRequest,
  // ⑤ 意图的唯一取值点（本节新增）：执行侧与验收侧从此读同一份。
  TASK_GOAL_MAX_CHARS,
  resolveTaskGoal,
  // ⑥ 新建交付物的授权档（2026-11-11）：与 isExecutionAuthorized 刻意分开，别混用。
  //   门禁要能对它做**双向变异**：把判据关掉要转红、把判据放宽成恒 true 也必须转红。
  DELIVERY_AUTH_REASONS,
  AFFIRM_WORDS,
  AFFIRM_THEN_REQUEST_RE,
  isAffirmative,
  isDeliveryAuthorized,
  planAuthGate,
  authGateDirective,
};
