/**
 * devProject —— 「开发工作台」的数据层与纯函数（豆芽对话 → 开发板块）。
 *
 * 与经营侧**完全隔离**（老板原话「它不受记忆影响」）：
 *   - 独立 key：`douya-dev-projects`（项目登记）/ `douya-dev-sessions`（开发会话）；
 *   - 调 AI 时 **context 传 null**，不注入企业档案（画像/事实/规则/记忆/目标/时间轴/体检结论一律不带）；
 *   - 项目是「工程师视角的本地代码库」，本来也不该按企业分桶 —— 故不分 companyId。
 *
 * 本文件是纯逻辑（不需要 Electron / React），可在 node 里裸测：
 *   - 项目 / 会话的归一化与读写边界；
 *   - parseAiFiles：把 AI 回复里的 ```file:path 块解析成文件改动集（**安全第一**，AI 输出当敌意输入）；
 *   - buildDevPrompt：把项目结构 + 已选文件 + 任务拼成给 AI 的提示词。
 * 真正落盘在主进程 devBridge（那里还有一道路径安全闸），这里只做「解析 + 预校验 + 展示」。
 */

// ==================== 常量 ====================

export const DEV_PROJECTS_KEY = 'douya-dev-projects';
export const DEV_SESSIONS_KEY = 'douya-dev-sessions';

export const MAX_PROJECTS = 50;
export const MAX_SESSIONS = 30;
export const MAX_MESSAGES_PER_SESSION = 60;
export const MAX_TREE_LINES = 400;      // 拼进 prompt 的目录树行数上限
export const MAX_PROMPT_CHARS = 60000;  // 拼进 prompt 的上下文总量上限（防撑爆）
export const MAX_MENTION_FILES = 8;     // 对话点名时，一次最多自动带入的文件数（防「所有文件」读爆）

/**
 * 「AI 自己申请读文件」的自动补读上限（2026-09-19 新增，B 方案）。
 *
 * 背景：开发台原先**只有**「用户在输入框里点名文件」这一个入口，
 * 模型发现少了文件时**没有出口**，只能在正文里说「请你回一句『先看 xxx』」——
 * 把活推回给用户（违反产品锁「技术路线题不许抛回用户」），用户体感就是「笨」。
 * 现在给模型一个 `read:` 出口：它申请 → 前端自动读 → 带着内容再问一轮。
 *
 * 为什么必须有上限：每一轮补读都是**一次完整的 LLM 调用**（reasoningEffort:high，实测 5~7s 起），
 * 不加限会变成「申请 → 读 → 再申请 → 再读」的无限循环，成本和等待都失控。
 */
export const MAX_AUTO_READ_ROUNDS = 2;  // 最多自动补读几轮（总 LLM 调用 = 1 + 轮数）
export const MAX_AUTO_READ_FILES = 12;  // 自动补读累计带上来的文件数上限（跨轮累计）

/** `read:` 出口的关键字（解析时也接受 need: / open: 等同义写法）。 */
export const DEV_READ_MARK = 'read';

/**
 * 只有「含路径」或「含下列已知扩展名」的英文 token，才可能被当成文件名去匹配。
 * 目的：排除中文句子里偶然出现的英文噪声词（例如「加个 button」里的 `button`）。
 */
export const DEV_MENTION_EXTS = [
  '.js', '.json', '.wxml', '.wxss', '.wxs', '.ts', '.tsx', '.jsx',
  '.html', '.css', '.md', '.txt', '.py', '.yml', '.yaml', '.vue', '.java', '.go',
];

/** 没点名任何文件时的兜底：这几个「入口级」文件一起带上（仅限目录树里真实存在的）。 */
export const DEV_CORE_FILES = ['app.json', 'project.config.json', 'package.json', 'app.js', 'app.wxss', 'sitemap.json'];

/**
 * 兜底「入口级」文件清单（按项目类型分流，入口文件在前）。
 *
 * 为什么必须分流：`DEV_CORE_FILES` 是**纯微信小程序**清单，前端项目（index.html + style.css
 * + script.js）一个都命中不了 → 没点名文件时 wanted=[] → prompt 里只写「没有提供文件内容」
 * → 模型只能猜。这里按 kind 给出各自的入口文件，让「前端项目」也能被自动带正文。
 */
export const DEV_FALLBACK_FILES = {
  miniprogram: DEV_CORE_FILES.slice(),
  web: [
    'index.html', 'package.json', 'vite.config.js', 'vite.config.ts', 'webpack.config.js',
    'public/index.html', 'src/main.jsx', 'src/main.js', 'src/index.jsx', 'src/index.js',
    'src/App.jsx', 'src/App.js', 'src/App.vue', 'style.css', 'script.js',
  ],
  node: ['package.json', 'src/index.js', 'src/server.js', 'index.js', 'server.js', 'app.js', 'main.js'],
  other: ['package.json', 'index.html', 'README.md', 'src/index.js', 'src/main.js', 'index.js', 'main.js', 'app.js'],
};

/** 兜底带入的文件「数量」上限（纯防御；真正的主约束是下面的字节预算）。 */
export const MAX_FALLBACK_FILES = 12;
/** 兜底带入的文件「字节」预算（目录树未截断时）。 */
export const FALLBACK_BYTE_BUDGET = 32 * 1024;
/** 目录树已截断（满 400 行）时收紧到 24KB，给目录结构正文留出空间。 */
export const FALLBACK_BYTE_BUDGET_SMALL = 24 * 1024;

/**
 * 取某项目类型对应的兜底清单。
 *
 * ⚠️ `kind` 只在「+ 添加项目」那一刻判定一次，之后是**过期值**（用户后期把项目改造成了别的样子
 * 也还是旧 kind）。所以：已知 kind → 用它自己那类；`other` / 空 / 未知 → 跑一遍**跨类通用清单**
 * （各类型清单去重并按 web → node → other → miniprogram 归并，入口文件排前），兜住误判。
 *
 * @param {string} kind 项目类型（miniprogram / web / node / other）
 * @returns {string[]} 兜底文件相对路径清单（新数组，调用方可安全修改）
 */
export function devFallbackFiles(kind) {
  const k = typeof kind === 'string' ? kind : '';
  if (k && k !== 'other' && Array.isArray(DEV_FALLBACK_FILES[k])) {
    return DEV_FALLBACK_FILES[k].slice();
  }
  // other / 空 / 未知：跨类通用清单（去重）
  const seen = new Set();
  const out = [];
  for (const key of ['other', 'web', 'node', 'miniprogram']) {
    for (const f of DEV_FALLBACK_FILES[key]) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** 项目类型（登记时按本地文件自动判定，也可手改）。 */
export const DEV_KINDS = [
  { key: 'miniprogram', label: '微信小程序', icon: '📱', hint: '有 project.config.json / app.json' },
  { key: 'web', label: '网页 / 前端', icon: '🌐', hint: '有 package.json 或 index.html' },
  { key: 'node', label: 'Node 脚本 / 服务', icon: '⚙️', hint: 'Node 后端或脚本项目' },
  { key: 'other', label: '其它', icon: '📁', hint: '未识别，按普通目录处理' },
];

export function devKindMeta(key) {
  return DEV_KINDS.find((k) => k.key === key) || DEV_KINDS[3];
}

/**
 * 「除了改代码还能干的事」—— 这些不是硬编码功能，而是**给对话起手的提示模板**，
 * 让老板不必自己想怎么问（点一下就填进输入框，可再改）。覆盖日常开发里最高频的几类活。
 */
export const DEV_QUICK_ACTIONS = [
  { key: 'explain', label: '解释代码', text: '请解释这个文件/这段代码在做什么，按「输入 → 处理 → 输出」讲清楚，指出容易踩坑的地方。' },
  { key: 'bug', label: '找 Bug', text: '请帮我找出这段代码的问题（逻辑错误 / 边界情况 / 异步时序），逐条给出：现象、原因、怎么改。' },
  { key: 'feature', label: '加功能', text: '请在这个项目里加一个功能：' },
  { key: 'style', label: '改样式', text: '请调整这段界面的样式，要求：' },
  { key: 'api', label: '调接口', text: '请把这段接口调用改对：把请求地址、参数、返回字段对齐后端真实契约，并加上失败处理。' },
  { key: 'script', label: '写脚本', text: '请写一个 Node 脚本，用来：' },
  { key: 'sql', label: '写 SQL', text: '请写一条 SQL，需求是：' },
  { key: 'regex', label: '写正则', text: '请写一个正则，用来匹配：' },
  { key: 'review', label: '整体体检', text: '请通读这个项目，指出结构性问题（重复代码 / 命名 / 异常处理 / 性能），按优先级列出该怎么改。' },
  { key: 'commit', label: '写提交说明', text: '请根据这次的改动，写一条规范的 git commit message（一行标题 + 要点列表）。' },
];

/**
 * 「范围外」标记块的标签名。
 *
 * 约定：模型发现任务不在当前项目范围时，输出一个 ```scope:out 块（内容是一段人话），
 * **不得**同时输出任何 file:/delete: 块。前端解析后渲染成醒目提示，且不提供「写入项目」。
 */
export const DEV_SCOPE_OUT_MARK = 'scope:out';

/**
 * 【任务范围闸】—— 给模型一个「合法拒绝」的出口。
 *
 * 血泪（老板原话「做法也不怎么聪明」「答非所问」）：
 *   旧 prompt 里只有「你正在一个**本地真实项目**里改代码」+「**必须**给出完整文件内容」两条，
 *   模型拿到范围外任务（「改 api.example.com 网页的配色」而当前项目是个微信小程序）时
 *   **没有任何退出通道** —— 于是只能在给定项目里找替身下手：改小程序配色、
 *   甚至有「在 api.example.com/admin 加个查看用户信息的功能」→ 它在小程序里新建了 pages/user-info。
 *   它自己都在回复里写了「源码不在这个项目里」，然后照样产出文件交差。
 *   根因不是模型笨，是「它知道自己不知道」和「它必须产出文件」这两条规则打架，产出赢了。
 *
 * 这条规则把「说做不到」变成一个**被鼓励的合法输出**，并要求给出可执行的下一步。
 */
export const DEV_SCOPE_RULE = [
  '【先判断：这个任务在不在这项目里？】',
  '',
  '你只能改【项目】根目录下的文件。开始动手前先对一下，命中**任意一条**就算范围外：',
  '1. 任务指的是**别的站点 / 域名 / 线上环境**（出现了本项目目录里没有的网址、域名、线上地址），',
  '   而当前打开的是**另一个东西**；',
  '2. 任务要操作**远程服务器**（提到服务器、线上、部署、SSH，或给了 IP / 账号密码），',
  '   而你手上只是一个**本地文件夹**，够不到服务器上的东西；',
  '3. 用户点名了**另一个项目 / 目录 / 代码库**，跟当前【项目】不是同一个；',
  '4. 任务里的那个页面 / 模块 / 文件，在【目录结构】里**根本找不到**。',
  '',
  '范围外时，你必须输出下面这一个块（且**一个 file: / delete: 块都不要给**）：',
  '',
  '```' + DEV_SCOPE_OUT_MARK,
  '（用人话说三件事：① 这事为什么不在这儿；② 当前打开的是什么；③ 要办成它，用户下一步该做什么）',
  '（最后写明「这次我没有动任何文件」）',
  '```',
  '',
  '第 ③ 点只能从下面这两个**真实存在**的出路里选，不许自己编界面按钮或流程：',
  '- 先把那个项目的文件夹加到本工具里（项目列表左上角「+ 添加项目」），然后在这里改；',
  '- 如果那东西在**线上服务器**上：这里只是一个本地文件夹开发台，够不到服务器；',
  '  要让用户知道「我不能替你连服务器改」，并说清他需要先在本地拿到那份代码。',
  '',
  '**绝不许做的事**（这是最容易犯的错）：',
  '- 不许在本项目里找个「差不多的地方」顺手改掉（比如用户要改网页配色，你去改小程序的配色）；',
  '- 不许为了「有东西交差」而凭空新建一个页面 / 文件来假装完成（用户要的是那个东西被改好，不是本项目多一个文件）；',
  '- 不许在回复里说了「源码不在这个项目里」，然后又输出一堆文件块。',
  '',
  '**反向约束（别误伤）**：只要任务确实是对当前【项目】里的代码做改动（改配色、加页面、修 bug、',
  '写脚本、调接口、体检、写提交说明……），就**正常干活**，绝不许走上面的块。本项目内能做的事走这条路就是错的。',
].join('\n');

/**
 * 【要看的文件自己申请，不要推给用户】—— 2026-09-19 新增的 `read:` 出口（B 方案）。
 *
 * 为什么要有这条：上面 DEV_NO_GUESS_RULE 说清了「看不到的别瞎写」，但**没给出口**，
 * 于是模型唯一的做法就是「请你回一句『先看 xxx』」—— 把活推回给用户。
 * 实测（`lead-prompt/model-compare.mjs`，三个不同模型各 2 轮）**三者都这么干**，
 * 而且这是「技术路线题不许抛回用户」这条产品锁的直接违反。
 *
 * 关键：出口必须是**机器通道**（和 file: 一样由程序解析），而不是「教它换个说法」。
 * 底层能力本来就有 —— `dev:readFiles(root, rels)` 支持按路径读，
 * 缺的只是「模型申请 → 前端自动读取 → 再问一轮」这个回路。
 *
 * ⚠️ 与 DEV_NO_GUESS_RULE 的分工（两条必须合起来读，不许只读一条）：
 *   本条说「缺文件时**怎么要**」（read: 块，自己申请）；
 *   DEV_NO_GUESS_RULE 说「要不到时**怎么办**」（别编，如实说卡在哪）。
 *   两条都说「不许推给用户」，方向一致，不构成冲突。
 */
export const DEV_READ_RULE = [
  '【要看的文件：你自己申请，别让用户去翻】',
  '1. 你只能看到「【以下是这些文件的当前内容】」里给了正文的文件。【目录结构】只是清单，不是内容。',
  '2. 发现**该看的文件没给你**时，**不要**在正文里说「请你回一句『先看 xxx』」、',
  '   「麻烦你把 xxx 发给我」——**你要自己申请**，用一个 read 块（格式见下），',
  '   系统会自动把那些文件读出来、再问你一次。**你不需要等用户回话。**',
  '3. 申请格式：一个代码块，块内**每行一个相对路径**（相对项目根目录，正斜杠）：',
  '',
  '```read:',
  'pages/index/index.wxss',
  'components/navbar/navbar.wxss',
  '```',
  '',
  '   也可以只写一行：```read:app.wxss 。路径必须**原样来自【目录结构】**，',
  '   宁可多申请几个，也不要写一个你猜的名字。',
  '4. **一次申请就申请齐**：把这件事可能牵涉到的文件一并申请完（例如「全站换主色」要把',
  '   全局样式、各页面样式、导航栏、tabBar 配置等一次列全），**不要挤牙膏式一轮要一个**。',
  '   一旦你申请了，这一轮的**其它活儿也照样要干完** —— 手上有的文件该改就改、把 read 块和 file 块',
  '   一起给出来；不许用「我还没看到别的文件」当借口什么都不做。',
  '5. 申请机会有限（最多 2 轮）。如果申请的文件**目录树里其实不存在**（你猜的），',
  '   系统会告诉你「没找到」；这时按 DEV_NO_GUESS_RULE 如实说明卡在哪，**不许换个名字接着猜**。',
].join('\n');

/**
 * 【不许凭空编文件内容】—— 止住「看不到内容却写出整个文件」。
 *
 * 旧规则第 5 条「必须给出完整文件内容」是个陷阱：兜底只带了几个入口文件，
 * 模型看不到 pages/* 的真实内容，却照样「必须给完整文件」→ 编出一份编译不过的假代码落盘。
 */
export const DEV_NO_GUESS_RULE = [
  '【你只对「看得到正文」的文件负责】',
  '- 【目录结构】只告诉你**有哪些文件**，不代表你看到了它们的内容。',
  '- 只有出现在「【以下是这些文件的当前内容】」里的文件，你才看得到正文。',
  '- 要改的文件**不在里面**时：不许凭想象写它的「完整新内容」（那必然是编译不过的假代码，',
  '  写进去等于把用户的文件搞坏）。正确做法**不是**让用户去翻，而是走上面【要看的文件：',
  '  你自己申请，别让用户去翻】的 `read:` 出口**自己申请**；只有在申请过、系统明确告诉你',
  '  「找不到」之后，才如实说明卡在哪。**任何情况下都不许把「你打算怎么做」推给用户去决定。**',
].join('\n');

/**
 * 【怎么跟用户说话】—— 用户是老板，不写代码。
 *
 * 旧实现只要求「一两句话说明打算怎么改」，没规定对谁说话，模型就写成了工程师腔：
 * 「补充说明（不属于代码改动）」「待写入 2 个文件」「本次未收到这些文件的当前内容」……
 * 老板的原话是「让那些不怎么懂的人怎么看得懂」。
 */
export const DEV_HUMAN_RULE = [
  '【怎么跟用户说话】（用户是老板，不写代码）',
  '1. 第一句就是结论：改好了没有 / 具体动了什么 / 有没有没做完或拿不准的地方。',
  '2. 全程说人话。不许出现「补充说明」「待写入」「（不属于代码改动）」「本次未收到……」这类工程黑话；',
  '   要说改了什么，用「主题色」「导航栏颜色」「按钮样式」这种词，不要甩 var(--primary)、',
  '   CSS 选择器、文件扩展名清单给用户看。',
  '3. 正文的结尾**必须**有一句「你现在要做什么」（例如「不用你动手，我已经改好了」/',
  '   「你重新编译一次就能看到」/「我先等你确认这个文件名」）。',
  '4. 不要复述代码、不要贴日志。真正的文件改动由下面的代码块承载，界面会自己显示给用户，',
  '   你不需要在正文里再罗列一遍文件名。',
  '5. 一次就够：先用一句大白话确认你听懂了，然后直接把活干完，不要来回追问；做完再用一句大白话讲清楚改了什么、现在会怎样。',
].join('\n');

/**
 * 【一次确认，直接把活干完，正文只讲人话】—— 止住「反复追问 + 把代码甩给老板看」。
 *
 * 老板原话（2026-09-17）：「不用经常跟你确认，而是你跟他说一个结果，他前期用很简单的话
 * 跟你做确认后就直接把东西给做好了，并且用很简单的话告诉你做了哪些」。
 * 上面 DEV_HUMAN_RULE 只说了「第一句是结论」，没规定「确认几次」「要不要来回问」，
 * 模型于是反复征求同意、还把代码贴进正文（「我做了个 py 格式的给你看」）。
 * 本条**只做追加与加强**，不推翻、不删除 DEV_HUMAN_RULE 已有的任何条款。
 */
export const DEV_CONFIRM_ONCE_RULE = [
  '【一次确认，直接把活干完】（用户是老板，不写代码，也没耐心来回答话）',
  '1. 先只用**一句大白话复述你要做什么**（讲成人话，例如「你是想让我把首页主色从绿色改成蓝色」），',
  '   然后**紧接着就动手**。',
  '   ⚠️ 这句复述是**陈述**，不是提问：不许写成「…，对吧？」「可以吗？」「需要我…吗？」这类',
  '   **等用户答复的问句**。**你的回复里不许出现「需要用户先回答才能继续」的内容** ——',
  '   你这一轮就要把事情做完、给结果，而不是问一句然后停下等回复。',
  '2. **确认一次就够**：**绝不许把一个任务拆成好几轮来回追问**，信息够就**直接把东西做完**，',
  '   中途**不要反复征求同意**、不要每改一处就停下来问一句。',
  '   **「该看的文件没给我」不算「缺信息」**：走 read 块自己申请（见【要看的文件：你自己申请，',
  '   别让用户去翻】），系统会自动把文件读给你，**不需要用户回任何话**。',
  '3. 做完后用**一句大白话**讲清楚你改了哪些地方、现在会怎样（例如「首页背景和按钮都换成蓝色了，你重新打开就能看到」）。',
  '4. **正文里绝对不许甩代码给用户看**：不许写「我给你做了个 py 格式的给你看」「下面是代码」「这是完整的 xxx.js」这类话，',
  '   正文只讲人话。真正的文件改动由下面的 file: 代码块承载（那是给程序读的，不用在正文里再讲一遍）。',
].join('\n');

/**
 * 给 AI 的输出格式硬约束（导出以便单测与 UI 复用同一口径）。
 * 用「完整文件」而不是 diff：模型写 diff 极易行号错位，落盘会写坏文件；
 * 完整文件 + 写前备份，是可靠性最高的组合。
 */
export const DEV_OUTPUT_RULE = [
  '【输出格式 · 必须严格遵守】',
  '1. 先按【怎么跟用户说话】说清结论（简明，不复述代码）。',
  '2. 然后对**每一个**要改动的文件，输出一个代码块，格式严格如下（注意是 file: 后紧跟相对路径）：',
  '',
  '```file:相对路径/文件名.js',
  '（这个文件的完整新内容，不要省略、不要写“此处不变”、不要用省略号）',
  '```',
  '',
  '3. 要删除文件时用：```delete:相对路径/文件名.js',
  '4. 路径必须是**相对项目根目录**的路径，用正斜杠 /，不要以 / 或盘符开头，不要出现 ..',
  '5. 必须给出**完整文件内容**，不要给 diff、不要给片段。',
  '6. 只输出该改的文件；不要顺手格式化无关文件、不要改与本任务无关的代码。',
  '7. 还需要看别的文件时，用 read 块申请（块内每行一个相对路径）：',
  '',
  '```read:',
  'pages/index/index.wxss',
  '```',
  '',
  '   它和 file: 块**可以在同一条回复里一起给**（手上有的先改，缺的同时申请）。',
  '8. 除 `file:` / `delete:` / `read:` 之外，**不要输出其它任何代码块格式**。',
].join('\n');

/**
 * 【回复长度与风格】—— 老板要的「快、准、直白、好懂」，只在「正文」生效。
 *
 * 老板原话（2026-09-18）：豆芽 AI 的回复要「快、准、直白、好懂」，并给了两份材料
 * （「回复原则 + 长度控制」与「Agent 工作模式」），要求「有的话不用改，没有的话补一下」。
 * 逐条对照既有 5 条常量后，长度分档、废话清单、不重复 / 不堆全面、不确定直说、失败三段式、
 * 冲突取舍优先级、「结论 → 必要说明 → 下一步」这些**明确是缺的**，本规则只补这些缺口。
 *
 * ⚠️ 本规则与 DEV_OUTPUT_RULE 的边界（上一轮踩过的坑）：下面「控制长度 / 简洁 / 不赘述」
 * **只约束你写给用户看的「正文」**。file: / delete: 代码块是给程序解析的**机器通道**，
 * 必须完整给出，不许因为「要简短」而省略、不许写「此处不变」、不许用省略号——
 * 这条红线本规则**不得削弱**（见本常量最后一条）。上一轮就因为把「正文」和「机器通道」
 * 混为一谈，差点让 file: 块被「简洁」化。
 */
export const DEV_REPLY_STYLE_RULE = [
  '【回复长度与风格】（只约束正文，不碰 file:/delete: 机器通道）',
  '老板要的是：快、准、直白、好懂。',
  '',
  '1. 先说结论：永远先回答用户真正问的问题；第一段直接给结论，不铺垫背景；答案简单就只用 1～3 句。',
  '2. 语言简单：日常中文，像聪明、靠谱的人跟朋友说话；少用专业术语，必要术语用一句大白话解释；不堆概念 / 定义 / 背景。',
  '3. 只回答用户需要的内容：不主动扩到无关话题；不重复用户已经说过的；不重复自己的结论；不为「全面」加用户没问的内容；一个例子能说清就别给五个。',
  '4. 做事情优先于解释：用户让你做事就直接做；不花大量篇幅解释你准备怎么做；不把执行过程写成教程（除非用户要求）；能直接给结果就直接给结果。',
  '5. 不确定就说：不要猜；明确告诉用户「我不确定」；缺关键信息只问最必要的，不要连环问一堆问题。',
  '6. 输出格式：默认「结论 → 必要说明 → 下一步」；只有内容确实适合列表时才用列表，不为格式而格式化。',
  '7. 禁止无意义废话：避免「当然可以」「这是一个很好的问题」「让我来为你详细分析一下」「希望这个回答对你有所帮助」「综上所述」「值得注意的是」这类填充语，除非这些话本身有实际作用。',
  '8. 简单问题就简单答，不要把简单问题复杂化。',
  '9. 用户要方案时：不只讲原理，直接给「推荐做法 / 具体步骤 / 可直接使用的内容」。',
  '10. 冲突取舍优先级：完整 vs 易懂 → 优先易懂；详细 vs 直接 → 优先直接；解释 vs 完成任务 → 优先完成任务。目标不是让回复显得聪明，是让用户最快看懂并马上能拿去用。',
  '',
  '【长度分档】（默认 L1，不主动升档）',
  '- L1 极简：直接回答，1～3 句。默认档。',
  '- L2 简洁：先结论，3～8 句，必要时 3～5 个要点。',
  '- L3 详细：先结论 + 分步骤 + 必要例子。',
  '- L4 深入：系统分析、多方案、优缺点、风险边界。',
  '除非用户明确要求「详细解释 / 深入分析 / 完整教程」，否则默认 L1，**不主动用 L3 / L4**。',
  '',
  '⚠️ 机器通道豁免（红线，不得削弱）：上面「控制长度 / 简洁 / 不赘述」**只约束正文**。',
  '下面的 file: / delete: 代码块是给程序解析的**机器通道**，必须**完整给出**，',
  '不许为了「简短」而省略、不许写「此处不变」、不许用省略号——DEV_OUTPUT_RULE 这条红线本规则不得触碰。',
].join('\n');

/**
 * 【Agent 工作模式】—— 老板要的「你怎么干活」，只补缺口（上面已管的不再重复命令）。
 *
 * 老板原话（2026-09-18）第二份材料「Agent 工作模式」+ 骨架要求（角色 / 核心目标 / 工作规则 /
 * 输出规则 / 失败处理）。既有 DEV_CONFIRM_ONCE_RULE 已管了「一次确认、直接干完、不来回追问」，
 * 本规则只补它**没覆盖**的：不展示内部思考、过程中不频繁汇报、完成后直接给结果、失败三段式、
 * 以及「第一目标 = 准确完成任务而不是写长回复」的优先级。
 */
export const DEV_AGENT_MODE_RULE = [
  '【Agent 工作模式】（你怎么干活）',
  '核心目标：第一目标是「准确完成任务」，不是写一段长回复；用户要的是结果，不是你的思考流水账。',
  '',
  '1. 用户让你完成任务时：① 识别最终目标 ② 判断完成所需的信息 ③ 信息够就立即执行',
  '   ④ 缺关键信息只问最必要的 ⑤ 不要向用户展示无意义的内部思考过程',
  '   ⑥ 执行过程中不要频繁汇报 ⑦ 完成后直接给最终结果',
  '   ⑧ 失败就直接说明：哪里失败 / 为什么失败 / 下一步怎么处理。',
  '2. 不要为了证明自己思考过而输出大量过程；能直接给结果就直接给。',
  '3. 最终输出让用户一眼知道：你做了什么、结果是什么、我接下来需要做什么（对应「结论 → 必要说明 → 下一步」）。',
  '4. 失败处理三段式：真失败时直接说清「① 哪里失败 ② 为什么失败 ③ 下一步怎么办」，',
  '   不许含糊带过，也不许硬编一个假成果交差（范围外的任务走 DEV_SCOPE_RULE 的 scope:out 通道，同样不许编文件）。',
].join('\n');

/**
 * 【你手上有什么、没有什么】—— 把能力边界说死，堵住「假装跑过 / 假装连过」。
 *
 * 老板原话（2026-09-18 第二批材料）要求开发 Agent「能运行就运行、能构建就构建、能测试就测试」
 * 「如果 SSH 能用，它甚至应该先检查服务器上的项目结构」。
 * **但开发台事实上没有这些能力**：`src/main/devBridge.js` 只挂了七件事 ——
 * dev:projectMeta / dev:tree / dev:readFiles / dev:write / dev:openFolder / dev:openDevTools / dev:cliPath，
 * **没有终端、没有命令执行、没有网络、没有图片处理**。
 * 若把「去运行 / 去 SSH」照抄进 prompt，模型只会**声称**自己跑过、连过 —— 那正是老板最恨的
 * 「假完成」，而且比不干活更坏：用户会以为已经验证过了。
 * 所以这里把边界写成事实，并把「验证」重新定义成**它真能做的那部分核对**。
 *
 * ⚠️ 必须带「反向约束」：给了 BLOCKED 出口，就得同时防误伤 —— 否则会从「硬着头皮乱做」
 * 滑到另一个极端「拿没能力当借口不干活」。这正是 DEV_SCOPE_RULE 当初踩过的坑。
 */
export const DEV_CAPABILITY_RULE = [
  '【你手上有什么、没有什么】（说清能力边界 —— 不许假装做过你没有的事）',
  '',
  '**你手上有的**（这就是你全部的工具）：',
  '1. 【目录结构】—— 这个项目里**有哪些**文件（只有名字，没有内容）；',
  '2. 出现在「【以下是这些文件的当前内容】」里的文件**正文**（没出现在那里的，你一个字都看不到）；',
  '3. 写文件 / 删文件：你输出的 file: / delete: 块，用户点「应用」之后才会真正落到磁盘上；',
  '4. 在用户电脑上打开这个文件夹、打开微信开发者工具。',
  '',
  '**你手上没有的**：',
  '- 没有命令行、没有终端：**不能运行、不能构建、不能跑测试、不能装依赖**；',
  '- 不能连服务器、不能 SSH、不能连数据库、不能调线上接口 —— 你只能改**这台电脑上这个文件夹里**的文件；',
  '- 不能打开 PNG / JPG 图片去改颜色，不能画图，不能转换图片格式；',
  '- 不能自己打开浏览器 / 开发者工具去看效果（那个按钮是给用户点的，你看不到结果），不能截图。',
  '',
  '所以「验证」对你只意味着**你能做的那部分核对**：',
  '- 回到【目录结构】核对你引用的每个路径**真的存在**、新增的文件 / 页面**是否已登记**',
  '  （例如小程序新页面有没有写进 app.json 的 pages）；',
  '- 回到文件正文核对：旧颜色 / 旧配置 / 旧写法是不是真的不再出现，改完之后上下文是否自洽；',
  '- 检查你写出去的东西本身是否合法：括号引号成对、JSON 能被解析、相对路径没有 .. 没有盘符。',
  '',
  '**反向约束（别拿这个当挡箭牌）**：只要用上面那 4 样就够干（改配色、加页面、修 bug、重排结构、',
  '写脚本、写 SQL、写提交说明……），就**正常干活**，不许用「我跑不了 / 我没法测 / 我看不到效果」',
  '当借口少干或不干。只有任务**确实必须**用到你没有的能力时，才停下来 —— 怎么停见【任务状态】。',
].join('\n');

/**
 * 【先把任务想对，再动手】—— 老板要的「理解用户真正想要什么 + 不要猜，先检查」。
 *
 * 老板原话（2026-09-18 第二批材料）：「真正的任务是让整个小程序最终视觉上变成红色，不能只修改
 * 你猜测相关的两个文件」「当前提供的文件不等于项目全部文件」「不要因为当前上下文没有某个文件，
 * 就直接告诉用户请把文件发给我」「不要擅自扩大需求」。
 *
 * ⚠️ 与 DEV_NO_GUESS_RULE 的**口径衔接**（两条不冲突，是衔接）：
 *   - 本条第 4 点管「怎么把文件找齐」→ 主动从目录结构里要点名（你负责点名）；
 *   - DEV_NO_GUESS_RULE 管「要点不到 / 没看到正文时不许编内容」。
 * 两者合起来才是这个产品的真实机制：**看不到就说要看哪个，但绝不许凭想象写它的内容**。
 * 注意开发台**没有搜索工具**（只有目录树 + 已带入的文件），所以「把项目里所有绿色找出来」
 * 这件事只能靠「看目录树 → 点名要文件 → 逐一看」完成，不能写成「去全局搜索」。
 */
export const DEV_REAL_TASK_RULE = [
  '【先把任务想对，再动手】',
  '1. 用户说的文件名不是目标，**效果**才是目标。用户说「把小程序改成红色」，真正的任务是',
  '   「用户打开后看到的地方都变红」，不是「把 app.wxss 里那几个颜色改掉」。',
  '2. **「本次带入的文件」不等于「项目的全部文件」**：带入的只是几个入口文件（有大小预算），',
  '   【目录结构】才是全貌。别因为手上只有 3 个文件，就以为项目只有 3 个文件。',
  '3. 别猜，先查：用什么框架、哪个目录、哪个页面、什么表名、什么接口地址 —— 都要从',
  '   【目录结构】和文件正文里**看出来**，不许按经验假设。真只能推测时，明说「这是推测」。',
  '4. 要「全部改掉」这类要求，必须**主动把相关文件找齐**。做法：先看【目录结构】判断哪些文件',
  '   可能管这件事 → **直接点名把它们要进来看**（在 read 块里把它们一次全申请进来，',
  '   见【要看的文件：你自己申请，别让用户去翻】）。',
  '   **这不算把活推给用户** —— 申请是你自己的动作，系统会自动把文件读给你，',
  '   **不用麻烦用户回话，也不许让用户去翻文件**。',
  '   · 不许只凭手上这几个文件就宣布「全改好了」；',
  '   · 不许看不到就凭想象改（那是下面【你只对「看得到正文」的文件负责】管的红线）。',
  '   改主色这类任务，至少要想到：全局样式 / 主题变量、各页面自己的样式、写死在代码里的颜色值、',
  '   JS 里动态设置的颜色、页面配置（导航栏 / tabBar）、图标与图片资源。',
  '   找颜色也别只盯一两个提前猜好的值，要把项目里**实际出现的**那几个都覆盖到。',
  '5. 最小改动：只改真正需要改的。**不许顺手**重构、改业务逻辑、改数据库、改接口、改页面布局、',
  '   删代码、格式化无关文件。要大面积改动，先确认这是完成这件事**必须**的。',
  '6. 有更合理的做法就用更合理的做法（项目本来就有主题变量，就统一主题变量，而不是去几百个文件里',
  '   做字符串替换），但**必须核对**这么做是不是真的覆盖到了用户要看到的地方。',
  '7. 安全：**绝不许**把密码 / Token / 密钥写进文件、写进前端代码、贴进正文；',
  '   涉及用户信息的功能要考虑权限 —— 只有管理员能看的数据，不许直接摆给所有人看。',
].join('\n');

/**
 * 【一句话里有几件事，就办几件事】—— 2026-09-20 加的（**有实测证据，不是凭空补的**）。
 *
 * 证据：`scripts/tmp-probe/lead-read-loop/read-loop-e2e.out.txt` 的 `rename-hero` 用例。
 *   任务：「把首页顶部那个大标题的文字改成『苗苗严选』，**顺便**把标题颜色改成白色」——**两件事**。
 *   同 prompt 同参数跑两遍：
 *     · 第 1 遍 → 最终改动集只有 `pages/index/index.js` **一个文件**（只改了文字，白色没落，虽然有
 *       wxss 在补读清单里 —— 读进来了却没用）；
 *     · 第 2 遍 → `wxml + js + wxss` **三个文件**，这一遍做全了。
 *   ⇒ **一致性不成立**：一半的执行只办了前半句。这正是老板说的「笨」里最难被察觉的一种 ——
 *     它不是不会，而是**不稳定**，同一句话两次跑出两种完成度。
 *
 * 与既有规则的分工（本条**只补缺口**，不推翻任何一条）：
 *   - DEV_REAL_TASK_RULE 管「用户说的文件名不是目标，**效果**才是目标」——解决"改错对象"；
 *   - **本条管「一句话里的每一件事都要有落实」**——解决"漏办后半句"；
 *   - DEV_TASK_STATE_RULE 管「交付前怎么如实报状态」——本条把「逐条对账」作为它 PARTIALLY_COMPLETED
 *     的**触发条件**，两者衔接、不重复。
 * 之所以单列：上面两条都**没有**说「用户一句话可能包含多个要求，要逐个拆开逐条核销」，
 * 而「顺便 / 还有 / 同时 / 另外」这类连接词恰恰是模型最容易当成"可选补充"而丢掉的。
 */
export const DEV_MULTI_REQ_RULE = [
  '【一句话里有几件事，就办几件事】（漏办和办错一样严重）',
  '1. 拿到任务**先在心里把它拆成条目**：用户这一句话里有几个要求？',
  '   出现「顺便」「还有」「同时」「另外」「也」「并且」这类词的，**后面那半句同样是任务**，',
  '   **不是可选项、不是建议、不是「有机会再说」**。',
  '   例：「把标题文字改成『苗苗严选』，顺便把标题颜色改成白色」＝ **两件事**：① 改文字 ② 改颜色。',
  '2. **每一条都必须落到具体的文件改动上**（file: / delete: 块）。只用一句「另外建议你…」带过，',
  '   等于没做 —— 用户不会因为你说得客气就当他那半句不存在。',
  '3. **你申请读进来的文件，必须用上**：read 回来的文件如果没出现在你的改动里，要么是它确实不需要改',
  '   （那就在正文里一句说清为什么），要么就是你**漏了**。改文字通常要动 .wxml / .js，',
  '   改颜色通常要动 .wxss / .wxml 的内联样式 —— 出现「读了样式文件却没动任何样式」这种组合，',
  '   基本就是漏办了。',
  '4. **交付前逐条对账**：把第 1 步拆出来的条目一条条过一遍 ——「这条改了吗？改在哪个文件？」',
  '   只要有一条没落实，就**不许**说完成：按【任务状态】报 PARTIALLY_COMPLETED，并写清哪条没做完、',
  '   为什么没做完（例如「颜色那条得改 PNG 图片，我动不了图片」，见【你手上有什么、没有什么】）。',
  '5. **一条都不能少，也不用多做**：对账是为了补漏，不是为了加戏 —— 用户没提的事仍然不许顺手做',
  '   （见【先把任务想对，再动手】的第 5 条「最小改动」）。',
].join('\n');

/**
 * 【任务状态】—— 老板 2026-09-18 指定要加的一段（原话：「这个会比单纯限制字数更有用」）。
 *
 * 老板给的四态：WORKING / COMPLETED / PARTIALLY_COMPLETED / BLOCKED + 「结束前自检」9 问。
 * 它跟 DEV_SCOPE_RULE / DEV_AGENT_MODE_RULE 是**合流**而不是重复：
 *   - scope:out 只是 BLOCKED 的一种（任务不在本项目里）；
 *   - AGENT_MODE 管「不展示思考、失败三段式」，本规则把它升级成**四态 + 各态准入条件 + 自检清单**。
 * 最重要的一条是「不许把 BLOCKED 说成 COMPLETED」—— 老板举的反例正是本轮之前真实发生过的：
 * 让它改 api.example.com/admin，它却在小程序里新建了 pages/user-info 交差。
 */
export const DEV_TASK_STATE_RULE = [
  '【任务状态】（每次结束时，你必须处于下面四个状态之一，并**如实**告诉用户是哪个）',
  '',
  '1. **WORKING** —— 还在检查、还在改。',
  '   这时候**不要**把过程一条条汇报出来（不要写「我正在查看 A、B、C」「接下来我打算……」），',
  '   更不许还没干完就说「已经完成」。',
  '',
  '2. **COMPLETED** —— 真的做完了，而且该核对的都核对过。',
  '   四条**同时**满足才能用：① 文件改动真的给出去了（有 file: / delete: 块）；',
  '   ② 改动是完整的，不是改了一半；③ 该做的核对做过了（见【你手上有什么、没有什么】里「验证」那段）；',
  '   ④ 没有已知错误、没有明显遗漏。四条里有一条说不清，就不许说「完成」。',
  '',
  '3. **PARTIALLY_COMPLETED** —— 主体做完了，但有**明确**没做完的部分。',
  '   必须讲清三件事：**做完了什么 / 没做完什么 / 为什么没做完**。',
  '   典型：项目里有几个图标是 PNG 图片，你改不了它的颜色 —— 就明说是哪几个没处理，其余已经改好。',
  '',
  '4. **BLOCKED** —— 干不下去。',
  '   必须讲清三件事：**① 卡在哪儿 ② 为什么干不下去 ③ 用户只需要提供什么**（一句话能解决的那种）。',
  '   典型：要改的东西不在这个项目里（走 DEV_SCOPE_RULE 的 scope:out）；或者这件事必须连服务器 /',
  '   必须跑起来才能做，而你没有那些能力。BLOCKED 时说「没有动任何文件」，就真的**一个文件都没动**。',
  '',
  '**红线：不许把 BLOCKED 说成 COMPLETED。** 拿一个自己编的、跟用户目标无关的东西交差',
  '（用户要改网页，你却在当前项目里新建一个页面），是这四种状态里最严重的错。',
  '做不到就说做不到、说清卡在哪、需要什么 —— 这不丢人；硬编一个假的才丢人。',
  '',
  '【结束前自检】（发出去之前自己回答一遍，有一条答不上就回去补）',
  '1. 我真的给出文件改动了吗？还是只说了一堆话？',
  '2. 我改的是**用户点名的那个东西**吗？还是本项目里一个差不多的替身？',
  '3. 我是不是只看手上这几个文件就动手了，没先看目录结构？',
  '4. 我有没有在猜（猜文件名、猜表名、猜接口、猜某个页面存在）？',
  '5. 明显相关的地方有没有漏（别的页面、别的样式、配置、图标）？',
  '6. 我核对过了吗？还是只有一句「应该没问题」？',
  '7. 有没有把文件写成错误的格式（例如 .py）？',
  '8. 我准备说的那个「完成」，是真完成还是假完成？',
  '9. 用户看完这段回复，能不能立刻知道「结果是什么、我还要做什么」？',
].join('\n');

/**
 * 【文件格式必须正确】—— 老板单独给的一条「文件类型绝对规则」。
 *
 * 老板原话（2026-09-18）：「禁止因为 Agent 使用 Python 工具而把其他语言文件输出为 .py」
 * 「扩展名和内容语言不匹配时，禁止交付」。
 * DEV_OUTPUT_RULE 只管**块的格式**（file: 后面怎么写、必须完整），不管**扩展名与语言是否匹配**；
 * 这两件事会同时出错，所以这条单列，且紧挨着 DEV_OUTPUT_RULE。
 */
export const DEV_FILE_FORMAT_RULE = [
  '【文件格式必须正确】（硬性红线）',
  '1. 你给出的每个文件，**扩展名必须和它在这个项目里的真实类型一致**，里面装的内容也必须是那个',
  '   类型该有的语言：.js → JavaScript，.json → 合法 JSON，.wxml → WXML，.wxss → WXSS，',
  '   .html → HTML，.css → CSS，.vue → Vue，.ts / .tsx → TypeScript，.py → Python，',
  '   .php → PHP，.sql → SQL，.md → Markdown。',
  '2. **绝对不许**把项目里的非 Python 文件当成 Python 写（把 app.wxss 的内容塞进 app.py、',
  '   把 JSON 写成 Python 字典、把 JS 写成 Python 脚本）—— 那是**直接把用户的文件搞坏**，比不干活更糟。',
  '3. 写每个文件之前先自问四件事：① 路径对吗（相对项目根、用正斜杠、没有 .. 没有盘符）；',
  '   ② 扩展名对吗；③ 里面装的语言是这扩展名该有的吗；④ 这是新建还是覆盖（覆盖会不会把该保留的',
  '   代码删掉）。四条有一条答不上来，就先别写这个文件。',
].join('\n');

// ==================== 基础工具 ====================

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* ignore */ }
  return null;
}

function loadJSON(key, fallback) {
  const st = storage();
  if (!st) return fallback;
  try {
    const raw = st.getItem(key);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    return p == null ? fallback : p;
  } catch {
    return fallback;
  }
}

function saveJSON(key, val) {
  const st = storage();
  if (!st) return false;
  try {
    st.setItem(key, JSON.stringify(val));
    return true;
  } catch {
    return false;
  }
}

/** 生成短 id（不引入 uuid 依赖）。 */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 相对路径安全预校验（与主进程 devBridge.safeJoin 同口径的「前端版」）。
 * 主进程那道闸才是权威，这里只为了**在落盘之前**就把不安全的路径标出来给用户看。
 * @returns {boolean}
 */
export function isSafeRelPath(rel) {
  const s = asStr(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.length > 240) return false;
  if (s.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(s)) return false;
  const segs = s.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.length === 0) return false;
  if (segs.some((x) => x === '..')) return false;
  if (segs[0] === '.douya-backup' || segs[0] === '.git') return false;
  return true;
}

/** 规范化相对路径（统一正斜杠、去 ./）。 */
export function normRelPath(rel) {
  return asStr(rel).replace(/\\/g, '/').replace(/^\.\//, '');
}

// ==================== 对话点名（用户在输入里说要看哪个文件） ====================

/** 单条 token 清理：统一分隔符、去开头 ./ 与 /、去结尾标点（. , ; : ! ? /）。 */
function cleanMentionToken(raw) {
  let s = String(raw == null ? '' : raw).replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  s = s.replace(/^\/+/, '');
  s = s.replace(/[.,;:!?/]+$/, '');
  return s;
}

/** 取路径的文件名部分（basename）。 */
function baseNameOf(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 从「用户这句话」里认出他想让豆芽看的文件 —— 取代原来的「上下文文件」勾选。
 *
 * 只在**目录树里真实存在的文件**里匹配（红线：绝不返回不存在的路径，不许凭空读）。
 * 匹配规则（大小写不敏感，按优先级去重）：
 *   1) 带路径 + 带扩展名（`pages/goods/detail.wxml`）→ 精确匹配整条 path
 *   2) 只有文件名 + 带扩展名（`detail.wxml` / `app.json`）→ 匹配 basename 相同的项
 *   3) 带路径 + 不带扩展名（`pages/goods/detail`）→ 匹配 path 等于它、或以「它.」开头的项
 * 噪声排除：token 必须含 `/` 或含已知扩展名才参与匹配
 *   （所以「加个 button」里的 `button` 不会被当文件）。
 * 纯函数，不改入参；脏输入返回 []。
 *
 * @param {string} text 用户输入
 * @param {Array<{path:string,dir?:boolean}>} entries dev:tree 返回的目录树条目
 * @param {number} [limit] 最多返回多少个（默认 MAX_MENTION_FILES=8）
 * @returns {string[]} 命中的文件相对路径（真实存在、非目录）
 */
export function parseMentionedFiles(text, entries, limit) {
  const src = typeof text === 'string' ? text : '';
  const list = Array.isArray(entries) ? entries : [];
  if (!src || list.length === 0) return [];
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_MENTION_FILES;

  // 索引：小写路径 → 原始路径；小写文件名(basename) → 原始路径数组
  const byPath = new Map();
  const byBase = new Map();
  for (const e of list) {
    if (!e || typeof e.path !== 'string' || e.dir === true) continue;
    const p = e.path.replace(/\\/g, '/');
    if (!p) continue;
    const lp = p.toLowerCase();
    if (!byPath.has(lp)) byPath.set(lp, p);
    const b = baseNameOf(p).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  if (byPath.size === 0) return [];

  const exts = new Set(DEV_MENTION_EXTS);
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || seen.has(p) || out.length >= max) return;
    seen.add(p);
    out.push(p);
  };

  // 抓出「像路径/文件名」的 token。字符类含 CJK（\u4e00-\u9fa5），否则「看下 首页.html」
  // 这种中文文件名会被整段切开、永远匹配不到底下的真实文件。
  // 噪声仍由后面的「必须含 / 或已知扩展名」拦掉，纯中文词不会被误当文件名。
  const tokens = src.match(/[A-Za-z0-9_\-./\u4e00-\u9fa5]+/g) || [];
  for (const rawTok of tokens) {
    if (out.length >= max) break;
    const tok = cleanMentionToken(rawTok);
    if (!tok) continue;
    const hasSlash = tok.includes('/');
    const dot = tok.lastIndexOf('.');
    const ext = dot > 0 ? tok.slice(dot).toLowerCase() : '';
    const hasExt = !!ext && exts.has(ext);
    if (!hasSlash && !hasExt) continue; // 噪声词直接跳过
    const lower = tok.toLowerCase();

    if (hasSlash && hasExt) {
      // 规则 1：完整路径 → 精确匹配
      const hit = byPath.get(lower);
      if (hit) add(hit);
    } else if (hasExt) {
      // 规则 2：裸文件名 → 基名匹配
      const arr = byBase.get(lower);
      if (arr) for (const p of arr) add(p);
    } else {
      // 规则 3：无扩展名的路径 → 精确 + 同名前缀（可命中 detail.wxml / detail.js …）
      if (byPath.has(lower)) add(byPath.get(lower));
      const prefix = lower + '.';
      for (const [lp, orig] of byPath) {
        if (lp.startsWith(prefix)) add(orig);
      }
    }
  }
  return out;
}

/**
 * 把 AI 用 `read:` 块申请的路径，解析成**目录树里真实存在**的文件（B 方案的落地环节）。
 *
 * 与 parseMentionedFiles 的关系：那一个是「听懂**用户**说的话」，本一个是「听懂**模型**写的路径」。
 * 两者共用同一条红线：**绝不返回目录树里不存在的路径**（不许凭空读文件）。
 * 差别在容错策略：用户的自由文本要激进地捞（宁可多认几个），
 * 而模型给的本来就是路径，**可以精确匹配就精确匹配**，只在无歧义时才肯降级 ——
 * 有歧义时**不猜**，如实报 ambiguous，让模型把完整路径写出来。
 *
 * 匹配优先级（大小写不敏感）：
 *   1) 精确整条路径         pages/index/index.wxss
 *   2) 基名唯一             index.wxss → pages/index/index.wxss（同名多个 ⇒ 不猜）
 *   3) 无扩展名前缀         pages/index/index → 该前缀下的 .wxss/.js/.json …
 *
 * 纯函数，不改入参。
 *
 * @param {string[]} reads AI 申请的路径（已过 isSafeRelPath）
 * @param {Array<{path:string,dir?:boolean}>} entries dev:tree 的条目
 * @param {number} [limit] 本次最多解析出几个（默认 MAX_MENTION_FILES=8）
 * @returns {{paths:string[], missing:string[], ambiguous:string[], overflow:number}}
 *   paths=真实存在可读的；missing=树里没有这个路径；ambiguous=同名多个、无法确定；
 *   overflow=因为数量上限被丢掉几个（**必须如实回报，不许静默丢**）。
 */
export function resolveReadPaths(reads, entries, limit) {
  const list = Array.isArray(reads) ? reads : [];
  const tree = Array.isArray(entries) ? entries : [];
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_MENTION_FILES;
  if (list.length === 0 || tree.length === 0) {
    return { paths: [], missing: list.map((x) => normRelPath(String(x || ''))).filter(Boolean), ambiguous: [], overflow: 0 };
  }

  const byPath = new Map(); // 小写路径 → 原始路径
  const byBase = new Map(); // 小写文件名 → 原始路径数组
  for (const e of tree) {
    if (!e || typeof e.path !== 'string' || e.dir === true) continue;
    const p = e.path.replace(/\\/g, '/');
    if (!p) continue;
    const lp = p.toLowerCase();
    if (!byPath.has(lp)) byPath.set(lp, p);
    const b = baseNameOf(p).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  if (byPath.size === 0) {
    return { paths: [], missing: list.map((x) => normRelPath(String(x || ''))).filter(Boolean), ambiguous: [], overflow: 0 };
  }

  const paths = [];
  const missing = [];
  const ambiguous = [];
  const seen = new Set();
  let overflow = 0;
  const add = (p) => {
    if (!p || seen.has(p)) return;
    if (paths.length >= max) { overflow += 1; return; }
    seen.add(p);
    paths.push(p);
  };

  for (const rawRead of list) {
    const r = normRelPath(String(rawRead == null ? '' : rawRead));
    if (!r) continue;
    const lower = r.toLowerCase();

    // 规则 1：整条路径精确命中
    const exact = byPath.get(lower);
    if (exact) { add(exact); continue; }

    // 规则 2：裸文件名 / 路径片段 → 基名匹配（唯一才认）
    const arr = byBase.get(baseNameOf(lower));
    if (arr && arr.length === 1) { add(arr[0]); continue; }
    if (arr && arr.length > 1) {
      // 同名多个：用申请里带的目录片段消歧（要求是**完整目录段**，不是任意子串匹配 ——
      // 用 includes 会让 pages/user/index.wxss 误配到 pages/index/index.wxss）
      const hinted = arr.filter((p) => p.toLowerCase().endsWith('/' + lower));
      if (hinted.length === 1) { add(hinted[0]); continue; }
      ambiguous.push(r);
      continue;
    }

    // 规则 3：无扩展名的路径前缀（detail → detail.wxml / detail.js / detail.json …）
    const prefix = lower + '.';
    const hits = [];
    for (const [lp, orig] of byPath) if (lp.startsWith(prefix)) hits.push(orig);
    if (hits.length > 0) { for (const h of hits) add(h); continue; }

    missing.push(r);
  }

  return { paths, missing, ambiguous, overflow };
}

/**
 * 「没点名任何文件」时的兜底选取：按项目类型拿入口清单 → 只在**目录树里真实存在**的文件里命中
 * → 受「数量上限 + 字节预算」双层约束。
 *
 * 红线：
 *   ① 绝不返回目录树里不存在的路径（不许凭空读）；
 *   ② 每层都要有上限（数量 + 字节），防一次带太多把 prompt 撑爆；
 *   ③ 脏输入（entries 非数组 / size 缺失）不许抛异常，也不许「因 NaN 而全部放行」。
 *
 * @param {Array<{path:string,dir?:boolean,size?:number}>} entries dev:tree 返回的目录树条目
 * @param {string} kind 项目类型（可为空 / other → 跨类通用清单）
 * @param {boolean} [truncated] 目录树是否已截断（true 时用更小的字节预算）
 * @param {{maxFiles?:number, byteBudget?:number}} [opts] 覆盖默认上限（便于单测）
 * @returns {string[]} 命中的文件相对路径（真实存在、非目录）
 */
export function pickFallbackFiles(entries, kind, truncated, opts) {
  const list = Array.isArray(entries) ? entries : [];
  const names = devFallbackFiles(kind);
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxFiles = Number(o.maxFiles) > 0 ? Math.floor(Number(o.maxFiles)) : MAX_FALLBACK_FILES;
  const byteBudget = Number(o.byteBudget) > 0
    ? Math.floor(Number(o.byteBudget))
    : (truncated ? FALLBACK_BYTE_BUDGET_SMALL : FALLBACK_BYTE_BUDGET);

  // 目录树里真实存在的「文件」：小写路径 → { path, size }
  const fileMap = new Map();
  for (const e of list) {
    if (!e || typeof e.path !== 'string' || e.dir === true) continue;
    const p = e.path.replace(/\\/g, '/');
    if (!p) continue;
    const lp = p.toLowerCase();
    if (!fileMap.has(lp)) {
      // ⚠️ 必须 Number(e.size) || 0：mock 的 entries 可能没有 size，undefined → NaN，
      //    而 NaN > budget 恒为 false ⇒ 所有文件都会通过，通道「全绿但根本没验预算」（假绿）。
      fileMap.set(lp, { path: p, size: Number(e.size) || 0 });
    }
  }

  const out = [];
  let used = 0;
  for (const f of names) {
    if (out.length >= maxFiles) break;
    const hit = fileMap.get(String(f).toLowerCase());
    if (!hit) continue;
    if (used + hit.size > byteBudget) continue; // 超预算的文件跳过（不是整体停止，后面的小文件仍可带）
    used += hit.size;
    out.push(hit.path);
  }
  return out;
}

// ==================== AI 回复解析（核心） ====================

/**
 * 把 AI 回复解析成「文件改动集」。
 *
 * 支持两种块：
 *   ```file:路径       → 写（整文件覆盖）
 *   ```delete:路径     → 删
 * 容错：`file=` / `write:` / 大小写 / 路径两侧空格 都能认；一个回复里同路径**后者覆盖前者**。
 * 安全：路径不合法（绝对路径 / .. / 写 .git）不丢弃，而是标 `unsafe:true` ——
 *       让 UI 能如实告诉用户「AI 给了一个越权路径，已拦截」，而不是静默吞掉。
 *
 * 另有第三种块（不是文件改动）：
 *   ```scope:out        → 「这事不在当前项目里」的显式声明，内容是一段人话。
 * 它由【任务范围闸】要求模型在范围外时输出：此时**不该**有任何 file:/delete: 块。
 * 万一模型又说范围外、又给了文件块（自相矛盾），这里**不静默丢弃 ops**，
 * 而是把矛盾如实回传（conflict=true），由界面提示用户先确认它到底改的是哪儿。
 *
 * 第四种块（2026-09-19 新增，B 方案）：
 *   ```read:            → **申请读取**某些文件的正文，块内每行一个相对路径。
 * 与上面三种的本质区别：它不是「结论」，而是**中间动作** —— 由调用方
 * （DevWorkbench 的自动补读循环）去 `dev:readFiles` 读出来、再问一轮模型。
 * 因此它**不与 file: 互斥**：模型完全可以「手上有的先改（file:）+ 缺的同时申请（read:）」，
 * 这时**不算自相矛盾**（conflict 只看 scope:out 那一路）。
 * 路径在这里**只做形状校验**（isSafeRelPath），**不校验存在性** ——
 * 存在性要拿【目录结构】去对（见 resolveReadPaths），那是另一件事。
 *
 * 纯函数，不改入参。
 *
 * @param {string} text AI 原始回复
 * @returns {{ops:Array<{path:string,content:string,kind:'write'|'delete',unsafe:boolean}>, note:string, duplicates:string[], scopeOut:string, reads:string[], conflict:boolean}}
 */
export function parseAiFiles(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return { ops: [], note: '', duplicates: [], scopeOut: '', reads: [], conflict: false };

  const ops = [];
  const duplicates = [];
  const reads = [];
  const seenRead = new Set();
  const seen = new Map(); // path → ops 下标

  const pushOp = (pathRaw, content, kind) => {
    const path = normRelPath(pathRaw);
    if (!path) return;
    const unsafe = !isSafeRelPath(path);
    const idx = seen.get(path);
    if (idx != null) {
      duplicates.push(path);
      // 后者覆盖前者（AI 常先给片段再给完整版）
      ops[idx] = { path, content, kind, unsafe };
      return;
    }
    seen.set(path, ops.length);
    ops.push({ path, content, kind, unsafe });
  };

  const consumed = []; // 记录被消费的区间，避免被 delete 正则重复匹配

  // scope:out → 「不在本项目里」的显式声明。必须先扫并记入 consumed，
  // 否则这段文字会以「普通代码块」的样子留在 note 正文里，跟提示卡重复显示。
  const scopeRe = /```[ \t]*scope[ \t]*[:=][ \t]*out\b[ \t]*\r?\n?([\s\S]*?)```/i;
  const scopeHit = scopeRe.exec(raw);
  const scopeOut = scopeHit ? String(scopeHit[1] || '').replace(/\s+$/, '').trim() : '';
  // ⚠️ 必须用 index + 匹配长度，**不能**用 scopeRe.lastIndex ——
  //    scopeRe 没有 g 标志，非全局正则的 lastIndex 永远是 0，
  //    写成 [index, lastIndex] 会得到 [start, 0]，删除区间时反而把前半段重复拼一遍，
  //    正文里就会出现「这事不在当前项目里。」出现两次 + 原始 scope 块粘在尾部。
  //    （这个坑是 unit-dev-scope.mjs 的 B4 断言抓出来的。）
  if (scopeHit) consumed.push([scopeHit.index, scopeHit.index + scopeHit[0].length]);

  // file: / write: → 写入块（内容到下一个 ``` 为止）。i 标志让 FILE:/File: 等变体也能认。
  const writeRe = /```[ \t]*(?:file|write)[ \t]*[:=][ \t]*([^\n`]+)\n([\s\S]*?)```/gi;
  let m;
  while ((m = writeRe.exec(raw)) !== null) {
    pushOp(m[1], m[2].replace(/\s+$/, '') + '\n', 'write');
    consumed.push([m.index, writeRe.lastIndex]);
  }

  // delete: / rm: → 删除块（可以没有内容）
  const delRe = /```[ \t]*(?:delete|rm)[ \t]*[:=][ \t]*([^\n`]*)\n?([\s\S]*?)```/gi;
  while ((m = delRe.exec(raw)) !== null) {
    const inside = consumed.some(([a, b]) => m.index >= a && m.index < b);
    if (inside) continue;
    pushOp(m[1], '', 'delete');
    consumed.push([m.index, delRe.lastIndex]);
  }

  // read: / need: / open: → 「申请读取」块（块内每行一个路径）。
  // 放在 file:/delete: **之后**跑，并复用同一套 consumed 区间检查：
  // 万一模型在 file: 块里写了一段提到 read 协议的文档（正文/注释），
  // 那属于文件内容、不该被当成申请（这正是 delRe 当初加 inside 检查的原因）。
  const readRe = /```[ \t]*(?:read|need|open)[ \t]*[:=][ \t]*([\s\S]*?)```/gi;
  while ((m = readRe.exec(raw)) !== null) {
    const inside = consumed.some(([a, b]) => m.index >= a && m.index < b);
    if (inside) continue;
    // 逐行解析：容忍 `- ` / `* ` 列表符号、行尾标点、两侧空白与 ./ 前缀。
    for (const line of String(m[1] || '').split(/\r?\n/)) {
      const cleaned = line
        .replace(/^\s*[-*·•]\s*/, '')
        .replace(/^\s*路径\s*[:：]\s*/, '')
        .replace(/[.,;:!?，。；：）)\]】]+$/, '')
        .trim();
      if (!cleaned) continue;
      const p = normRelPath(cleaned);
      // 形状不合法（绝对路径 / .. / 写 .git 等）直接丢 —— 这里**不是**「越权文件改动」，
      // 只是个读申请，没必要像 ops 那样标 unsafe 交给界面提示，静默拒绝即可。
      if (!isSafeRelPath(p) || seenRead.has(p)) continue;
      if (reads.length >= MAX_MENTION_FILES) break;
      seenRead.add(p);
      reads.push(p);
    }
    consumed.push([m.index, readRe.lastIndex]);
  }

  // 说明文字 = 去掉所有文件块之后剩下的部分（保留其它代码块，它们是解释用的例子）
  let note = raw;
  consumed
    .slice()
    .sort((a, b) => b[0] - a[0])
    .forEach(([a, b]) => { note = note.slice(0, a) + note.slice(b); });
  note = note.replace(/\n{3,}/g, '\n\n').trim();

  // conflict 只由 scope:out 那一路触发（「既说不在本项目、又给了产物」）。
  // read: 与 file: 并存是**正常**的（先改能改的、同时申请缺的），不计入 conflict。
  const conflict = !!(scopeOut && (ops.length > 0 || reads.length > 0));
  return { ops, note, duplicates, scopeOut, reads, conflict };
}

/** 改动集统计（UI 展示用）：新增/覆盖/删除各几个、总字节。 */
export function summarizeOps(ops) {
  const list = Array.isArray(ops) ? ops : [];
  let write = 0;
  let del = 0;
  let bytes = 0;
  let unsafe = 0;
  for (const op of list) {
    if (!op) continue;
    if (op.kind === 'delete') del += 1;
    else { write += 1; bytes += typeof op.content === 'string' ? op.content.length : 0; }
    if (op.unsafe) unsafe += 1;
  }
  return { total: list.length, write, del, bytes, unsafe };
}

// ==================== 项目登记 ====================

/** 归一化一个项目登记。name 缺失时用目录名兜底。 */
export function normalizeProject(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const root = asStr(r.root);
  const fallbackName = root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
  return {
    id: asStr(r.id) || newId('devp'),
    name: asStr(r.name) || fallbackName || '未命名项目',
    root,
    kind: DEV_KINDS.some((k) => k.key === r.kind) ? r.kind : 'other',
    appid: asStr(r.appid),
    note: asStr(r.note),
    createdAt: Number(r.createdAt) > 0 ? Number(r.createdAt) : Date.now(),
    lastUsedAt: Number(r.lastUsedAt) > 0 ? Number(r.lastUsedAt) : 0,
  };
}

/** 读全部项目（过滤无 root 的垃圾数据）。 */
export function loadProjects() {
  const raw = loadJSON(DEV_PROJECTS_KEY, []);
  const list = Array.isArray(raw) ? raw : [];
  return list.map(normalizeProject).filter((p) => p.root).slice(0, MAX_PROJECTS);
}

/** 整体写回全部项目。 */
export function saveProjects(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map(normalizeProject)
    .filter((p) => p.root)
    .slice(0, MAX_PROJECTS);
  return saveJSON(DEV_PROJECTS_KEY, clean) ? clean : null;
}

/** 新增项目（同 root 已存在则更新并返回它，避免重复登记）。 */
export function addProject(p) {
  const list = loadProjects();
  const np = normalizeProject(p);
  if (!np.root) return null;
  const key = np.root.replace(/[\\/]+$/, '').toLowerCase();
  const idx = list.findIndex((x) => x.root.replace(/[\\/]+$/, '').toLowerCase() === key);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...np, id: list[idx].id, createdAt: list[idx].createdAt };
    saveProjects(list);
    return list[idx];
  }
  list.unshift(np);
  saveProjects(list);
  return np;
}

/** 更新项目（按 id 浅合并）。 */
export function updateProject(id, patch) {
  const list = loadProjects();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  list[idx] = normalizeProject({ ...list[idx], ...(patch && typeof patch === 'object' ? patch : {}), id });
  saveProjects(list);
  return list[idx];
}

/** 删除项目（同时删掉它的开发会话）。 */
export function removeProject(id) {
  const list = loadProjects();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return false;
  saveProjects(next);
  const sessions = loadSessions().filter((s) => s.projectId !== id);
  saveSessions(sessions);
  return true;
}

/** 标记项目为最近使用（用于列表排序）。 */
export function touchProject(id) {
  return updateProject(id, { lastUsedAt: Date.now() });
}

/** 按最近使用排序。 */
export function sortProjects(list) {
  return (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0));
}

// ==================== 开发会话 ====================

/** 归一化一条消息。 */
export function normalizeMessage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const role = r.role === 'user' ? 'user' : 'assistant';
  const msg = {
    id: asStr(r.id) || newId('m'),
    role,
    content: typeof r.content === 'string' ? r.content : '',
    at: Number(r.at) > 0 ? Number(r.at) : Date.now(),
  };
  // 只有 assistant 消息才可能带文件改动集
  if (role === 'assistant' && r.ops != null) {
    msg.ops = (Array.isArray(r.ops) ? r.ops : []).map((o) => ({
      path: normRelPath(o && o.path),
      content: o && typeof o.content === 'string' ? o.content : '',
      kind: o && o.kind === 'delete' ? 'delete' : 'write',
      unsafe: !!(o && o.unsafe),
    })).filter((o) => o.path);
  }
  if (role === 'assistant' && r.error) msg.error = asStr(r.error);
  // 范围外声明（```scope:out）：必须持久化，否则刷新页面后「这事不在本项目里」的提示就没了，
  // 用户只会看到一段没有文件块的光秃回复，以为豆芽在敷衍。
  if (role === 'assistant' && r.scopeOut) {
    msg.scopeOut = String(r.scopeOut);
    msg.scopeConflict = !!r.scopeConflict;
  }
  // 用户消息：记录本次「对话点名」实际带入的文件名（识别结果，与是否读到内容无关）
  if (role === 'user' && Array.isArray(r.ctx)) {
    msg.ctx = r.ctx.map((x) => asStr(x)).filter(Boolean).slice(0, MAX_MENTION_FILES);
  }
  return msg;
}

/** 归一化一个会话。 */
export function normalizeSession(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let messages = Array.isArray(r.messages) ? r.messages.map(normalizeMessage) : [];
  if (messages.length > MAX_MESSAGES_PER_SESSION) messages = messages.slice(messages.length - MAX_MESSAGES_PER_SESSION);
  return {
    id: asStr(r.id) || newId('devs'),
    projectId: asStr(r.projectId),
    title: asStr(r.title) || '新开发会话',
    messages,
    createdAt: Number(r.createdAt) > 0 ? Number(r.createdAt) : Date.now(),
    updatedAt: Number(r.updatedAt) > 0 ? Number(r.updatedAt) : Date.now(),
  };
}

/** 读全部会话（新的在前）。 */
export function loadSessions() {
  const raw = loadJSON(DEV_SESSIONS_KEY, []);
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map(normalizeSession)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SESSIONS);
}

export function saveSessions(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map(normalizeSession)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SESSIONS);
  return saveJSON(DEV_SESSIONS_KEY, clean) ? clean : null;
}

/** 新增 / 覆盖一个会话。 */
export function upsertSession(session) {
  const list = loadSessions();
  const ns = normalizeSession({ ...session, updatedAt: Date.now() });
  const idx = list.findIndex((x) => x.id === ns.id);
  if (idx >= 0) list[idx] = ns;
  else list.unshift(ns);
  saveSessions(list);
  return ns;
}

export function removeSession(id) {
  const list = loadSessions();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  saveSessions(next);
  return true;
}

/** 取某项目下的会话（新的在前）。 */
export function sessionsOfProject(projectId) {
  return loadSessions().filter((s) => s.projectId === projectId);
}

// ==================== Prompt ====================

/** 目录树数组 → 紧凑文本（带行数上限）。 */
export function treeToText(entries, maxLines = MAX_TREE_LINES) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [];
  for (const e of list) {
    if (lines.length >= maxLines) { lines.push('…（目录过大，已截断，需要看哪个文件请直接说文件名）'); break; }
    if (!e || !e.path) continue;
    lines.push(e.dir ? e.path + '/' : e.path);
  }
  return lines.join('\n');
}

/**
 * 组装给 AI 的提示词。
 *
 * **不含任何企业档案**（这是「不受记忆影响」的落地处）：只有代码库本身的事实。
 * @param {object} p
 * @param {object} p.project 项目登记 { name, root, kind, appid }
 * @param {Array}  [p.tree] 目录树条目
 * @param {Array}  [p.files] 已选文件 [{ path, content, truncated }]
 * @param {string} p.task 用户这次要做什么
 * @param {string} [p.extraNote] 追加要求（可选）
 */
export function buildDevPrompt(input) {
  // 注意：不能用 `= {}` 的默认值 —— 那只能接住 undefined，传 null 仍会炸（单测覆盖到）。
  const { project, tree, files, task, extraNote } =
    input && typeof input === 'object' ? input : {};
  const p = project && typeof project === 'object' ? project : {};
  const kindMeta = devKindMeta(p.kind);

  // ---- 「指令段」先拼好（任务 / 输出格式是命根子，超长时绝不能被截掉）----
  const headParts = [];
  headParts.push(
    '你是资深的全栈工程师，正在一个**本地真实项目**里改代码。'
    + '你的输出会被程序解析后直接写入磁盘文件，所以格式必须严格。'
    + '—— 但**只在任务确实属于这个项目时**才动手；不属于这个项目的事，直接说清楚，不要硬凑一个东西交差。'
  );
  headParts.push(
    [
      '【项目】',
      `- 名称：${asStr(p.name) || '未命名'}`,
      `- 类型：${kindMeta.label}`,
      p.appid ? `- 小程序 AppID：${asStr(p.appid)}` : '',
      `- 根目录：${asStr(p.root)}`,
    ].filter(Boolean).join('\n')
  );
  const treeText = treeToText(tree);
  if (treeText) headParts.push('【目录结构】（已忽略 node_modules / dist / .git 等）\n' + treeText);
  // 能力边界排在范围闸**之前**：先把「你手上有什么、够不到什么」说成事实，
  // 范围闸的判据 2（远程服务器 / SSH）才有依据 —— 否则模型会以为自己能连服务器。
  headParts.push(DEV_CAPABILITY_RULE);
  // 范围闸排在【项目】与【目录结构】之后：模型刚看完「这项目长什么样」，紧接着就被要求
  // 「先判断任务在不在这个范围里」，判据 4（目录树里找不到）有据可依。
  headParts.push(DEV_SCOPE_RULE);
  const head = headParts.join('\n\n');

  const tailParts = [];
  tailParts.push('【本次任务】\n' + asStr(task));
  if (asStr(extraNote)) tailParts.push('【追加要求】\n' + asStr(extraNote));
  if (p.kind === 'miniprogram') {
    tailParts.push(
      '【小程序特别注意】\n' +
      '- 新增页面必须同时在 app.json 的 pages 里注册（把 app.json 的完整新内容一起输出）；\n' +
      '- WXML 里不要用浏览器/DOM API；WXSS 不支持部分 CSS 选择器；\n' +
      '- 需要权限/接口时优先用 wx.* 官方 API，并处理 fail 分支。'
    );
  }
  // 说话口径排在输出格式之前：先定「怎么跟用户交代」，再讲「文件块怎么写」。
  tailParts.push(DEV_HUMAN_RULE);
  // 「一次确认、直接干完」紧跟在「怎么跟用户说话」之后：是它的收紧（追加），不是替代。
  tailParts.push(DEV_CONFIRM_ONCE_RULE);
  // 2026-09-18 追加：回复长度/风格 + Agent 工作模式（只追加、不替代上面任何条款）。
  // 紧跟「一次确认、直接干完」之后——同属「贴着任务那段说话口径」：它管「确认几次 / 是否甩代码」，
  // 这两个新规则管「说多长 / 怎么干活」，都排在「不猜文件」与输出格式（DEV_NO_GUESS_RULE / DEV_OUTPUT_RULE）之前。
  tailParts.push(DEV_REPLY_STYLE_RULE);
  tailParts.push(DEV_AGENT_MODE_RULE);
  // 2026-09-18 第二批（老板两份「开发 Agent 规则」+ 单独指定的「任务状态」，要求「直接放进去」）：
  // 先「把任务想对」（要检查什么 / 怎么把文件找齐 / 最小改动 / 安全），再「怎么如实交代状态」；
  // 之后才是文件块那一组（不猜内容 → 格式正确 → 输出格式）。
  // ⚠️ DEV_OUTPUT_RULE 仍然**排最后**：它是 file:/delete: 机器通道的口径，绝不能被稀释或顶掉。
  tailParts.push(DEV_REAL_TASK_RULE);
  // 2026-09-20（有实测证据）：紧跟在「先把任务想对」之后 —— 同属「把任务想对」这一组：
  // 上一条管「别把对象搞错」，这一条管「一句话里的每一件事都要有落实（漏办后半句）」。
  // 排在 DEV_TASK_STATE_RULE **之前**是因为它要引用后者的 PARTIALLY_COMPLETED：先讲怎么拆、
  // 后讲怎么如实报状态，引用关系才成立。
  tailParts.push(DEV_MULTI_REQ_RULE);
  tailParts.push(DEV_TASK_STATE_RULE);
  // 2026-09-19（B 方案）：read: 出口的定义必须排在 DEV_NO_GUESS_RULE **之前** ——
  // 后者会引用「走 read 出口自己申请」，先定义后引用，模型才不会把 read: 当成自创语法。
  // 排在这里还兼一个作用：它在 DEV_FILE_FORMAT_RULE / DEV_OUTPUT_RULE（机器通道）之前，
  // 属于「先把文件找齐」这一组，与 dev:readFiles 的自动补读回路一一对应。
  tailParts.push(DEV_READ_RULE);
  tailParts.push(DEV_NO_GUESS_RULE);
  tailParts.push(DEV_FILE_FORMAT_RULE);
  tailParts.push(DEV_OUTPUT_RULE);
  const tail = tailParts.join('\n\n');

  // ---- 文件内容段：用「剩余预算」裁剪它，而不是等最后把整段 prompt 一刀切掉 ----
  // 旧实现是 `out.slice(0, MAX_PROMPT_CHARS)` —— 文件正文一旦超大，就会把排在它后面的
  // 【本次任务】连同输出格式一起截走，模型于是拿不到指令。这里改成「先给指令段留够空间，
  // 再按预算逐块装文件」，保证任务与格式始终完整。
  const fs2 = (Array.isArray(files) ? files : []).filter((f) => f && f.path);
  const FILES_HEADER = '【以下是这些文件的当前内容，请以此为准做修改】\n';
  // 2026-09-19（B 方案）：旧文案教模型「请直接说『请先看 xxx』」—— 那是把活推回用户。
  // 现在改成走 read: 出口：模型自己申请，前端自动读出来再问一轮（见 DEV_READ_RULE）。
  const NO_FILES = '【文件内容】本次没有提供文件内容。如果需要看某个文件，'
    + '按【要看的文件：你自己申请，别让用户去翻】用 read 块申请它，系统会自动把内容给你；'
    + '不要猜测它的内容，也不要把「让用户去翻一下再告诉你」当成解决办法。';
  const FILE_TRUNC_MARK = '\n…（该文件过长，已截断）';
  let filesPart = NO_FILES;
  if (fs2.length > 0) {
    // 预留「头 + 文件段导语 + 尾 + 三个 '\n\n' 连接符」后，剩余才是可给正文的预算。
    const reserve = head.length + tail.length + FILES_HEADER.length + 8;
    const budget = Math.max(0, MAX_PROMPT_CHARS - reserve);
    const blocks = [];
    let used = 0;
    for (const f of fs2) {
      const header = '```file:' + f.path + '\n';
      const body = typeof f.content === 'string' ? f.content : '';
      // 这一块能放多少正文字符（预留 header + '\n```' + join 分隔 + 截断标记）
      const room = budget - used - header.length - 4 - FILE_TRUNC_MARK.length - 2;
      if (room < 64) continue; // 预算已满：后续文件内容不放（末尾统一如实列出）
      let text = body;
      let cut = false;
      if (text.length > room) { text = text.slice(0, room); cut = true; }
      const b = header + text + ((cut || f.truncated) ? FILE_TRUNC_MARK : '') + '\n```';
      blocks.push(b);
      used += b.length + 2;
    }
    filesPart = FILES_HEADER + blocks.join('\n\n');
    if (blocks.length < fs2.length) {
      const missing = fs2.slice(blocks.length).map((f) => String(f.path)).join('、');
      const note = '\n…（因上下文预算已满，以下文件内容本次未带上：' + missing + '）';
      if (filesPart.length + note.length <= budget) filesPart += note;
    }
  }

  // 组装顺序与旧版一字不差：头（含目录结构）→ 文件内容 → 尾（任务 / 格式约定）
  let out = [head, filesPart, tail].join('\n\n');
  // 最后的安全网：正常路径下上面的预算已保证不超限；这里只兜「指令段自身就超长」的极端情况。
  if (out.length > MAX_PROMPT_CHARS) out = out.slice(0, MAX_PROMPT_CHARS) + '\n…（上下文过长已截断）';
  return out;
}

/**
 * 把会话历史压成给 AI 的 messages。
 * 只保留最近 N 轮，且**assistant 的历史消息只留说明文字**（丢掉文件块体，避免上下文爆炸）。
 */
export function buildDevMessages(session, prompt, keepTurns = 6) {
  const msgs = [];
  const history = (session && Array.isArray(session.messages) ? session.messages : []).slice(-keepTurns * 2);
  for (const m of history) {
    if (!m || !m.content) continue;
    msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 4000) });
  }
  msgs.push({ role: 'user', content: prompt });
  return msgs;
}

/**
 * 用第一条用户消息给会话起标题。
 *
 * ⚠️ 2026-10-19（第十九轮）说明：本轮新增了 `services/autoTitle.js`（去口头前缀 / 去标点 /
 * 18 字截断）并已用于**经营对话**标题（App.jsx send()）。这里**故意不改**为调用 autoTitle：
 * 本文件被 `scripts/smoke/unit-dev-project.mjs` 的变异反控（RC）整份复制到临时目录后重新 import，
 * 一旦新增 `import './autoTitle.js'`，那些副本里没有该模块 ⇒ 21 条 RC 断言全红（实测）。
 * 本函数本身就已有「压空白 + 18 字截断 + 省略号」这条截断规则，符合本轮需求
 * 「开发会话沿用 titleFromTask，若它没有截断规则就复用 autoTitle」的前半句。
 * 若要统一，需同步给 RC 副本补上 autoTitle.js（属门禁脚本改动，留给主理人决定）。
 */
export function titleFromTask(task) {
  const t = asStr(task).replace(/\s+/g, ' ');
  if (!t) return '新开发会话';
  return t.length > 18 ? t.slice(0, 18) + '…' : t;
}

/** 会话 → 展示用文本（导出/复制）。 */
export function sessionToText(session) {
  const s = normalizeSession(session);
  const lines = [`# ${s.title}`];
  for (const m of s.messages) {
    lines.push('', m.role === 'user' ? '## 我' : '## 豆芽');
    if (m.error) lines.push('（失败：' + m.error + '）');
    if (m.content) lines.push(m.content);
    if (m.ops && m.ops.length) {
      lines.push('改动文件：' + m.ops.map((o) => (o.kind === 'delete' ? '删除 ' : '写入 ') + o.path).join('、'));
    }
  }
  return lines.join('\n');
}

export default {
  DEV_PROJECTS_KEY,
  DEV_SESSIONS_KEY,
  DEV_KINDS,
  DEV_QUICK_ACTIONS,
  DEV_OUTPUT_RULE,
  DEV_CONFIRM_ONCE_RULE,
  DEV_REPLY_STYLE_RULE,
  DEV_AGENT_MODE_RULE,
  DEV_CAPABILITY_RULE,
  DEV_REAL_TASK_RULE,
  DEV_TASK_STATE_RULE,
  DEV_FILE_FORMAT_RULE,
  DEV_MENTION_EXTS,
  DEV_CORE_FILES,
  DEV_FALLBACK_FILES,
  MAX_FALLBACK_FILES,
  FALLBACK_BYTE_BUDGET,
  FALLBACK_BYTE_BUDGET_SMALL,
  MAX_MENTION_FILES,
  devKindMeta,
  devFallbackFiles,
  pickFallbackFiles,
  isSafeRelPath,
  normRelPath,
  newId,
  parseMentionedFiles,
  parseAiFiles,
  summarizeOps,
  normalizeProject,
  loadProjects,
  saveProjects,
  addProject,
  updateProject,
  removeProject,
  touchProject,
  sortProjects,
  normalizeMessage,
  normalizeSession,
  loadSessions,
  saveSessions,
  upsertSession,
  removeSession,
  sessionsOfProject,
  treeToText,
  buildDevPrompt,
  buildDevMessages,
  titleFromTask,
  sessionToText,
};
