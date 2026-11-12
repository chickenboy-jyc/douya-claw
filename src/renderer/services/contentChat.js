/**
 * contentChat —— 「内容创作」对话式生成的**单一入口**（prompt 组装 + 调接口 + 错误归一）。
 *
 * 【为什么单独成文件（0.21.15 · 老板需求 5）】
 *   老板原话：「现在内容创作点击创作还会跳转到三级页 我不要那个三级页了 直接在对话输入后
 *   就自动开始生成，而且现在会出现生一半就中断掉了的问题，这个你需要修复一下。
 *   然后这个创作对话框要大一些 不然生成的内容放不下对吧」
 *
 *   改前：内容创作的生成能力**只**存在于 `NewMediaWorkbench` 这个整页组件里，而它只在
 *   `ContentOps` 的 `view === 'gen'` 分支挂载 ⇒ 「说一句话」和「把它写出来」被拆成两个页面，
 *   并且生成动作还得在那页**再点一次**按钮。三级页、二次点击、生成中切页丢结果，都是这个
 *   结构派生出来的。改后：生成动作下沉到本文件（纯函数 + 一次 fetch），由对话区直接调用，
 *   页面不再切换。
 *
 * 【与 NewMediaWorkbench 的关系 —— 一处**刻意**的重复，留档以免漂移】
 *   `NewMediaWorkbench.jsx` 里的 `WRITE_BASE_RULES` / 快稿规格 / 精品长版 prompt 的拼装顺序，
 *   本文件按同一口径复刻了一份。这不是"第二份真相"，是两个**不同的交付面**：
 *     · NewMediaWorkbench = 完整表单工作台（类型 / 风格 / 平台 / 人设 / 联网开关都能调），
 *       它的 prompt 常量在组件内部，**未导出**；
 *     · 本文件 = 对话式创作（只有「写什么 + 日常/精品」两个入参）。
 *   ⚠️ 但重复就是重复：`WRITE_BASE_RULES` 里那 5 条（成稿口径 / 医疗合规红线 / 参考资料优先 /
 *      平台适配 / 书面语）**任何一条被改，两边都要改**。本轮不允许改 NewMediaWorkbench
 *      （团队边界：该文件由另一位工程师负责），所以只能复刻。合并方式已想好、待解冻后做：
 *      把 `WRITE_BASE_RULES` 提到本文件导出，NewMediaWorkbench 改为 import —— 但那是它的
 *      改动，不属于本轮任务，故不在本轮擅自改动。
 *   精品长版（wenan）**没有**重复：直接用 `config/geoContentPrompt.js` 的
 *   `buildGeoPromptWenan()`（同一个函数、同一份九章原文），口径天然一致。
 */

import { buildGeoPromptWenan } from '../config/geoContentPrompt.js';
import { buildAIContext } from './contextBuilder.js';
/**
 * KI-008：内容创作要**先检索再写作**，检索通道就是主进程的 `/api/web-search`
 * （`src/main/backend.js` 的 `handleWebSearch`，provider 的 key 全在主进程，渲染层不碰 key）。
 *
 * ⚠️ 循环 import 已核实：`api.js` 只 import `./services/aiReadiness.js`（纯函数模块），
 *   **不** import 本文件 ⇒ 这条 import 不会成环。
 */
import { fetchWebSearch } from '../api.js';

/**
 * 后台任务键前缀。
 *
 * ⚠️ 为什么**不用** `wenan-` 前缀：`components/BackgroundJobsBar.jsx` 的 `JOB_META` 把
 *   `wenan-` 映射到模块 `xinmeiti`（新媒体工作台整页）。内容创作的对话结果**不在**那一页，
 *   点「去看」会跳到另一个页面、结果看不见 —— 用户视角就是"生到一半没了"。
 *   本前缀在 `JOB_META` 里没有登记 ⇒ 指示条只显示「豆芽任务」且不可点跳（module 为空），
 *   不会把人送到错误页面。**要加映射请同时改 BackgroundJobsBar（本轮不在我的边界内）。**
 */
export const CONTENT_CHAT_JOB_PREFIX = 'content-chat-';

/**
 * 生成任务的 job key。按企业隔离：切企业不串结果（与 NewMediaWorkbench 的 `wenan-<id>` 同思路）。
 * @param {string} [companyId] 当前企业 id
 * @returns {string} job key
 */
export function contentChatJobKey(companyId) {
  return CONTENT_CHAT_JOB_PREFIX + (companyId || 'x');
}

/** 文案类型（引擎枚举码）。对话区没有类型选择器 ⇒ 用工作台同一个默认值，不新造枚举。 */
const DEFAULT_TYPE = 'gongzhonghao';
/** 内容风格（引擎枚举码）。老板第 6 条已删风格选择器 ⇒ 固定默认值，见 ContentOps 的说明。 */
const DEFAULT_STYLE = 'professional';

/**
 * 单次生成的**兜底超时**（毫秒）。
 *
 * 这不是"重试蒙过去"，是"不许静默挂死"：
 *   · 主进程 `backend.js` 的 geo-proxy 自己有 120s 硬超时（到点 abort，返回「请求超时」）；
 *   · 但渲染层 `api.js:geoProxy()` **没有任何超时** —— 一旦主进程那侧因为别的原因没回
 *     （端口占用、进程重启、连接挂住），`await` 会永远不 resolve，界面就停在「正在写…」
 *     永不结束。用户看到的就是"生成中断、内容只剩半截"。
 * 所以这里再加一道显式上限：到点**必须**变成一句人话错误，绝不留在 pending。
 * 180s > 主进程的 120s，正常情况轮不到我倒计时。
 */
export const CONTENT_CHAT_TIMEOUT_MS = 180000;

/**
 * 写作通用要求（与 `NewMediaWorkbench.jsx` 的 `WRITE_BASE_RULES` 同源，见文件头「关系」段）。
 * ⚠️ 改这里请同步改那一边 —— 两处不同步时，同一个企业从对话区和工作台出来的稿子口径会分家。
 */
const WRITE_BASE_RULES = [
  '【写作要求（通用）】',
  '1. 直接给成稿：标题 + 正文 + 收尾，不要写「以下是为您生成的文案」这类开场白和解释。',
  '2. 口腔医疗行业红线（硬性，违反任何一条即不可用）：不用「最好/第一/顶尖/根治/100%/彻底解决」等绝对化或疗效承诺用语；不编造治愈率、患者案例、资质证书；不贬低其他机构；资料里没有的价格、活动、数据一律不许写。',
  '3. 提供了【参考资料】时，内容以资料为准：活动规则、价格、参数、卖点必须出自资料，与资料冲突的表述以资料为准；资料没覆盖的地方用稳妥表述，不要脑补。',
  '4. 给了发布平台就按平台适配长度与语气（如小红书口语化带话题标签、公众号用小标题分节、知乎重论证），不要一篇通吃。',
  '5. 中文书面语，杜绝翻译腔；每段只讲一件事。',
].join('\n');

/** 日常内容（快稿）规格。与 NewMediaWorkbench 的 daily 分支逐字同源。 */
const DAILY_RULES = '\n【写作模式：日常内容（快稿）】\n- 正文 300~500 字；给 1 个主标题（可附 1 个备选），结构从简：一句入题 + 要点 + 收尾行动号召。\n- 口语化、短句，像门店小编日常发的内容，拿来就能发。\n- 不堆砌形容词，不硬凑金句。';

/**
 * 企业资产 → 上下文段（卖点 / 人群 / 调性 / 画像）。
 * 与 NewMediaWorkbench 的 `ctxParts` 同源；空值不写，绝不伪造内容。
 * @param {Object} [asset] useMarketingAsset().asset
 * @returns {string} 「【企业资产上下文】…」或空串
 */
function buildAssetContext(asset) {
  const a = asset || {};
  const parts = [];
  if (a.companyName) parts.push(`企业：${a.companyName}`);
  if (a.brandTone) parts.push(`品牌调性：${a.brandTone}`);
  if (Array.isArray(a.coreSellingPoints) && a.coreSellingPoints.length) {
    parts.push(`核心卖点：${a.coreSellingPoints.join('、')}`);
  }
  if (Array.isArray(a.targetCustomers) && a.targetCustomers.length) {
    parts.push(`目标人群：${a.targetCustomers.join('、')}`);
  }
  if (a.profile) parts.push(`企业画像：${a.profile}`);
  return parts.length ? `【企业资产上下文】\n${parts.join('\n')}` : '';
}

/**
 * 组装 `/api/wenan/generate` 的 `extra`（= 后端拼进 user prompt「补充：」段的内容）。
 *
 * 顺序与 NewMediaWorkbench 严格一致：**企业上下文（含【资料可信度】抬头）永远第一位**，
 * 这是 `unit-chain-tier-wiring` 的 C1 契约，不许把写作指令插到它前面。
 *
 * @param {Object} bag
 * @param {string} [bag.topic] 用户那句话（主题）
 * @param {string} [bag.mode] 'daily' | 'wenan'
 * @param {string} [bag.refs] 参考资料（文件名清单 + 粘贴正文）
 * @param {Object} [bag.asset] 营销资产
 * @param {string} [bag.companyContext] buildAIContext().companyContext
 * @returns {string} 拼好的 extra 文本
 */
export function buildContentChatExtra(bag) {
  const b = bag || {};
  const topic = String(b.topic || '').trim();
  const mode = b.mode === 'wenan' ? 'wenan' : 'daily';
  const refs = String(b.refs || '').trim();
  const companyContext = String(b.companyContext || '').trim();
  const assetContext = buildAssetContext(b.asset);
  const isWenan = mode === 'wenan';

  // 精品文案走老板给的九章长版 prompt（与 NewMediaWorkbench 同一个函数，不重复定义）。
  // daily 走 WRITE_BASE_RULES + 快稿规格。
  const modeInstruction = isWenan
    ? buildGeoPromptWenan({
      topic,
      refs,
      companyCtx: companyContext,
      platforms: [], // 对话区没有平台选择器 —— 留空，不硬编平台
      audience: '', // 同上：没有输入项就如实留空，让模型自己判断
      goal: '',
    })
    : DAILY_RULES;

  // 参考资料：wenan 已进长版 prompt 的「A. 可用的原始资料」槽位，这里不再重复带（省 token、避免双来源）。
  const refsBlock = !isWenan && refs ? `【用户提供的参考资料】\n${refs}` : '';
  const baseRules = isWenan ? '' : WRITE_BASE_RULES;

  return [companyContext, baseRules, modeInstruction, assetContext, refsBlock].filter(Boolean).join('\n\n');
}

/* ============================================================================
 * KI-008（0.21.26 · 老板原话「内容创作生成精品文章的时候容易中途断掉 生一半就没了」）
 *
 * 【真实主因，实测 60%，不是截断】
 *   ① 本文件原来把 `online: false` 写死 ⇒ 后端 `enable_search` 恒假；
 *   ② 而服务端 `backend_main.py` 的 system_prompt 命令「所有数据必须来源于联网搜索」
 *      「以真实搜索数据为基础」——**模型手里没有任何工具，却被命令必须去搜**；
 *   ③ 于是模型输出 `<tool_call>{"name":"web_search",…}</tool_call>` 这段**桩文本**，
 *      `finish_reason` 是 `stop`（不是 `length`）⇒ `_wenan_result_from_meta` 判
 *      `ok:true, truncated:false` ⇒ **当成"成功"** 交给用户，正文就只有那一小段桩。
 *   把 `online` 改 true 也治不了：内网网关不支持 `enable_search`（只会回「我无法实时获取」）。
 *
 * 【治法是"先检索再写作"，不是"多要 token"】
 *   发请求前先在**客户端**真做一次检索，把资料塞进 `extra`（后端会拼进 user prompt 的
 *   「补充：」段），并明确告诉模型：资料就是全部事实来源、**你没有工具、禁止输出
 *   `<tool_call>`**、直接从一级标题写正文。
 *   受控 A/B（各 10 次，真实网关）：现状 6/10 出桩、可用 4/10；本修法 0/10 出桩、可用 10/10；
 *   且**只改客户端、system_prompt 一字不改**。
 *
 * 【为什么分工是这样的】
 *   · 检索放在**客户端**：主进程已有真实的 `/api/web-search`（Tavily/Bocha），改后端要等部署批次；
 *   · `buildGroundingQuery` / `buildGroundingExtra` 做成**导出的纯函数**：门禁能直接断言，
 *     不必为了测一句话去起整个 UI；
 *   · 检索**失败也必须继续生成**（否则"检索挂了"会变成新的"一个字都不出来"）——
 *     所以 `gatherGrounding` 连超时在内的一切异常都吞掉，降级成"没有资料"，
 *     但**写作纪律照旧输出**（修法承重的正是纪律那几句，见反向控制实验）。
 * ========================================================================== */

/** 检索单条结果的摘要截断长度（字符）。够模型判断"这条讲什么"，又不至于把 prompt 撑爆。 */
const GROUNDING_SNIPPET_MAX = 500;
/** 全部资料块的总长上限（字符）：6 条 × 500 + 标题，留一点余量；超了就按顺序截断。 */
const GROUNDING_DOCS_MAX = 4000;
/** 检索期望条数。6 条 ≈ 一份长文的资料面，再多对成稿边际收益很低。 */
const GROUNDING_COUNT = 6;
/** 检索默认超时（毫秒）。检索是**增益**，不许让它把生成拖成"卡住"：10s 到点就当作没资料。 */
const GROUNDING_TIMEOUT_MS = 10000;
/** 检索词里的意图词：把「话题」推向「要数据/要案例」的检索意图，而不是要一段泛泛的科普。 */
const GROUNDING_INTENT_WORDS = '最新 行业数据 案例';

/**
 * 组装这次要拿去检索的**检索词**：主题 + 行业 + 意图词。
 *
 * ⚠️ 行业只从 `asset.industry` 取，**为空就不写** —— 绝不按主题猜行业（"编造"比"少一个词"更坏：
 *   猜错行业会检索回完全不相干的资料，模型还会把它当事实用）。
 *
 * @param {string} topic 用户那句话（主题）
 * @param {Object} [asset] 营销资产（只读 `industry`）
 * @returns {string} 检索词
 */
export function buildGroundingQuery(topic, asset) {
  const t = String(topic || '').trim();
  const a = asset && typeof asset === 'object' ? asset : {};
  const industry = String(a.industry || '').trim();
  return [t, industry, GROUNDING_INTENT_WORDS].filter(Boolean).join(' ').trim();
}

/**
 * 组装「资料块 + 写作纪律」—— 追加进 `extra` 的尾段（后端会拼到 user prompt 的「补充：」里）。
 *
 * 【两条分支都必须有纪律】
 *   · `searched && docs` ⇒ 把资料原样给出，并说「这就是全部事实来源，已经足够写完」
 *     （否则模型会嫌资料不够、继续"想搜一下" ⇒ 又吐工具桩）；
 *   · 否则 ⇒ 诚实说「本轮没有可用的检索资料」（带原因），并禁止编造数据/案例/用户评价。
 *   两种情况下都明确「你没有工具、不许输出 `<tool_call>`」—— 这是本条修复的承重句。
 *
 * @param {{docs?:string, searched?:boolean, reason?:string}} bag 资料与检索结果状态
 * @returns {string} 拼好的尾段文本（永不为空）
 */
export function buildGroundingExtra(bag) {
  const b = bag && typeof bag === 'object' ? bag : {};
  const docs = String(b.docs || '').trim();
  const searched = b.searched === true;
  const reason = String(b.reason || '').trim();
  const grounded = searched && !!docs;

  const head = grounded
    ? `【本次已为你检索好的真实资料，直接据此写作】\n${docs}`
    : `【本轮没有可用的检索资料】${reason ? `（${reason}）` : ''}`;
  const factRule = grounded
    ? '上述资料就是本轮的全部事实来源，已经足够写完。'
    : '没有资料时不许编造任何数据、案例、用户评价，只写不需要数据支撑的部分。';
  const discipline = [
    '【写作纪律】',
    factRule,
    '你现在没有任何可调用的工具，请不要输出 <tool_call>、<tool_search>、<tool_use> 之类的标记，也不要写「先搜索一下」这类过渡句，直接从一级标题开始写正文。',
  ].join('\n');

  return [head, discipline].join('\n\n');
}

/**
 * 真做一次检索，产出「资料块 + 纪律」的尾段。
 *
 * **绝不抛异常、绝不阻断生成**：空结果 / `ok:false` / 抛错 / 超时，全部降级成
 * `searched:false` + 原因，**纪律照旧返回**（那时纪律里换成"不许编造"那一条）。
 *
 * 导出仅为单测可注入假 `webSearchFn`（生产调用点只有 `generateContentCopy` 一处）。
 *
 * @param {string} topic 主题
 * @param {Object} [asset] 营销资产
 * @param {Function} [webSearchFn] 检索实现，默认 `fetchWebSearch`（签名 `(query, opts) => Promise<{ok,results,error}>`）
 * @param {number} [timeoutMs] 检索超时，默认 10s
 * @returns {Promise<string>} 尾段文本（永不为空）
 */
export async function gatherGrounding(topic, asset, webSearchFn, timeoutMs = GROUNDING_TIMEOUT_MS) {
  const fn = typeof webSearchFn === 'function' ? webSearchFn : fetchWebSearch;
  const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : GROUNDING_TIMEOUT_MS;

  let docs = '';
  let searched = false;
  let reason = '';

  try {
    const query = buildGroundingQuery(topic, asset);
    const r = await withTimeout(fn(query, { count: GROUNDING_COUNT }), limit);
    const results = r && Array.isArray(r.results) ? r.results : [];
    if (r && r.ok === false) {
      // 检索**失败**（网络/HTTP 非 2xx/解析失败）：原因原样带到纪律块里，方便复盘
      reason = String(r.error || '').trim() || '检索接口返回失败';
    } else if (!results.length) {
      // ok:true 但空结果 = **真没搜到**，不是失败（语义边界见主进程 handleWebSearch 注释）
      reason = '检索没有返回结果';
    } else {
      const lines = [];
      for (const it of results) {
        const item = it && typeof it === 'object' ? it : {};
        const title = String(item.title || '').trim();
        const body = String(item.content || '').trim().slice(0, GROUNDING_SNIPPET_MAX);
        if (!title && !body) continue;
        lines.push(`- 标题：${title || '（该来源没有标题）'}\n  要点：${body || '（该来源没有摘要）'}`);
      }
      docs = lines.join('\n').slice(0, GROUNDING_DOCS_MAX).trim();
      searched = !!docs;
      if (!searched) reason = '检索结果里没有可用摘要';
    }
  } catch (e) {
    // 超时 / 抛错 / 返回值结构异常 —— 一律降级，绝不让"检索挂了"变成"生成挂了"
    if (e && e.code === 'CONTENT_CHAT_TIMEOUT') {
      reason = `检索超时（超过 ${Math.round(limit / 1000)} 秒）`;
    } else {
      reason = `检索异常：${(e && e.message) || String(e)}`;
    }
    docs = '';
    searched = false;
  }

  return buildGroundingExtra({ docs, searched, reason });
}

/**
 * 把接口失败翻译成一句用户能照着做的中文。
 * 判据：宁可说得难听，也不要一句「生成失败」把原因吞掉（那正是"生一半就断了"的观感来源之一）。
 * @param {Object} [r] geoProxy 的返回
 * @returns {string} 错误文案
 */
export function pickGenerateError(r) {
  const raw = r && (r.error || r.message || r.msg);
  const msg = String(raw == null ? '' : raw).trim();
  if (!msg) return '生成失败：接口没有给出原因（这不是"没有内容"，是真的失败了），点「重试」再来一次。';
  if (/超时|timeout/i.test(msg)) {
    return `${msg} —— 长文最容易卡在这一步：点「重试」，或先让它只出大纲，再分段补。`;
  }
  return msg;
}

/**
 * 给 promise 加一道显式上限：到点 reject（code = CONTENT_CHAT_TIMEOUT），绝不无限 pending。
 * @param {Promise} promise 被包的 promise
 * @param {number} ms 上限毫秒
 * @returns {Promise} 同结果
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('content-chat timeout');
      err.code = 'CONTENT_CHAT_TIMEOUT';
      reject(err);
    }, ms);
    // Node 侧别让这个定时器把进程吊住（浏览器里 setTimeout 返回数字，没有 unref）。
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 真正发一次生成请求。
 *
 * 失败**一律**返回 `{ ok:false, error:<人话> }`，不抛异常 —— 调用方（对话区）据此把
 * 「正在写」气泡换成错误气泡，保证不会停在半截。
 *
 * @param {Object} opts
 * @param {Function} opts.geoProxy 取数通道（App.jsx 注入；测试可注入桩）
 * @param {string} [opts.companyId] 当前企业 id（用于自解析企业上下文）
 * @param {string} [opts.topic] 用户那句话
 * @param {string} [opts.mode] 'daily' | 'wenan'
 * @param {string} [opts.refs] 参考资料
 * @param {Object} [opts.asset] 营销资产
 * @param {Function} [opts.webSearch] 检索实现（默认 `fetchWebSearch`；测试可注入桩）
 * @param {number} [opts.timeoutMs] 兜底超时
 * @returns {Promise<{ok:boolean, content:string, truncated?:boolean, error?:string}>}
 *         成功分支多带一个 `truncated`（布尔）：本次输出被服务端模型预算上限截断，
 *         内容可能不完整。**只在成功分支出现**，失败分支字段不变。
 */
export async function generateContentCopy(opts) {
  const o = opts || {};
  const geoProxy = o.geoProxy;
  const topic = String(o.topic || '').trim();
  const mode = o.mode === 'wenan' ? 'wenan' : 'daily';
  const timeoutMs = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? o.timeoutMs : CONTENT_CHAT_TIMEOUT_MS;

  if (!topic) return { ok: false, content: '', error: '还没说要写什么 —— 先说一句主题，比如「春季种植体促销」' };
  if (typeof geoProxy !== 'function') {
    return { ok: false, content: '', error: '取数通道不可用（没有拿到 geoProxy），这一版发不出请求。' };
  }

  let companyContext = '';
  try {
    companyContext = buildAIContext({ companyId: o.companyId || '' }).companyContext || '';
  } catch {
    companyContext = ''; // 没有企业上下文不影响生成：由 prompt 的"资料不足"规则兜底
  }

  const extra = buildContentChatExtra({
    topic,
    mode,
    refs: o.refs,
    asset: o.asset,
    companyContext,
  });

  /**
   * KI-008：**先检索再写作**。资料块只能**追加在最后** ——
   *   `buildContentChatExtra` 内部的顺序契约（`companyContext` 永远第一位，
   *   见 `scripts/smoke/unit-chain-tier-wiring.mjs` 的 C1）一个字都不能动，
   *   所以这里是在它**外面**拼接，而不是往它里面插。
   * 检索失败 / 超时不会中断生成：`gatherGrounding` 自己吞掉一切异常并降级成"没有资料 + 纪律"。
   *
   * ⚠️ 超时预算账（跨文件不变量，改 `GROUNDING_TIMEOUT_MS` 前先算这一笔）：
   *   最坏耗时 = 检索 10s + 本次生成 180s（`CONTENT_CHAT_TIMEOUT_MS`）= 190s，
   *   而 `ContentOps` 的外层任务超时是 `180s + 30s 余量 = 210s`
   *   ⇒ 仍然是"内圈先说话、外圈只兜底"。检索上限一旦涨到 >30s，这层关系就反转了
   *   （外圈会先掐断，界面只会看到一句泛泛的"超过 210 秒"）。
   */
  const grounding = await gatherGrounding(topic, o.asset, o.webSearch);
  const finalExtra = grounding ? [extra, grounding].filter(Boolean).join('\n\n') : extra;

  let r;
  try {
    r = await withTimeout(
      geoProxy('/api/wenan/generate', 'POST', {
        type: DEFAULT_TYPE,
        style: DEFAULT_STYLE,
        topic,
        extra: finalExtra,
        /**
         * ⚠️ `online: false` **保持不动**（KI-008 已用受控实验排除这条路）：
         *   后端 `online=true` 只做两件事 —— `enable_search=True` 和给 user prompt 追加一句
         *   「请结合最新网络信息」。而内网模型网关**不支持** `enable_search`
         *   （实测只回「我无法实时获取…」），追加那句反而**进一步逼模型去搜** ⇒ 更容易吐工具桩。
         *   真正解决"模型被命令必须搜却没有工具"的是上面那段 grounding（真检索 + 禁工具桩纪律），
         *   把它改成 true 既不解决问题、又会让下一个人误以为"联网已经开了"。
         */
        online: false,
        personas: [],
        platforms: [],
      }),
      timeoutMs,
    );
  } catch (e) {
    if (e && e.code === 'CONTENT_CHAT_TIMEOUT') {
      return {
        ok: false,
        content: '',
        error: `生成超时（超过 ${Math.round(timeoutMs / 1000)} 秒还没写完），已停止等它 —— 点「重试」，或先让它只出大纲再补。`,
      };
    }
    return { ok: false, content: '', error: `生成失败：${(e && e.message) || String(e)}` };
  }

  /**
   * KI-008：服务端改成**三态**了 —— 正常完成 `ok:true`；被上限截断 `ok:false + truncated:true`
   *   + 半截正文；真失败 `ok:false + error`。服务端不再把截断说成成功（这是老板点名的那条），
   *   但截断时那半截正文是**能看的内容**，不能因为 ok:false 就整段丢掉。
   * ⇒ 这一层把它降级成「可用但带告警」：ok:true + truncated:true，
   *   由视图层（ContentOps）在气泡下方渲染一行 `.co-msg-limit`。
   *   判据用 `=== true` 与"正文非空"，避免把空串当正文。
   */
  if (!r || r.ok === false) {
    const partial = (r && typeof r.content === 'string') ? r.content : '';
    if (r && r.truncated === true && partial.trim()) {
      return { ok: true, content: partial, truncated: true };
    }
    return { ok: false, content: '', error: pickGenerateError(r) };
  }

  const content = r.content || r.text || r.result;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, content: '', error: '接口回了空内容（这一版没写出来），点「重试」再来一次。' };
  }
  /**
   * 透传服务端的「被上限截断」标记（`/api/wenan/generate` 新增字段 `truncated`）。
   * 为什么原样透传而不是在这里改文案：本文件是「调用接口」的单一入口，它只负责
   *   **把接口说的话带回来**；"要不要在气泡里多渲染一行提示"是视图层的决定（ContentOps）。
   * 判据写成 `=== true` 而不是真值判断：服务端可能回 `"true"`/`1`/`null`，
   *   只有真正的布尔 true 才算截断，避免把字符串误报成"内容不完整"吓用户。
   */
  return { ok: true, content, truncated: r.truncated === true };
}

/* ============================================================================
 * 「上一次请求」的轻量记忆（只存主题 + 模式 + 时间戳，不存正文）
 *
 * 为什么要它：结果正文的事实源是 `store/backgroundJobs.js`（切页/刷新都在），
 * 但**用户问的是哪一句**只存在于组件 state 里 —— 组件一旦因切模块 / 切企业被重建，
 * 界面上就只剩「一段没有问题的答案」或者干脆什么都没有，用户看到的就是"生到一半断了"。
 * 所以把"问的那句 + 对应的 job 时间戳"落盘一份（几十字节），重建时凭 job.at 认领回来。
 * ⚠️ 正文**不落这里** —— 两处存同一份正文就是第二份真相，必然漂移。
 * ========================================================================== */

/**
 * @param {string} jobKey job key
 * @returns {{topic:string, mode:string, sentAt:number, jobAt:number}|null}
 */
export function readLastRequest(jobKey) {
  try {
    const raw = localStorage.getItem('douya-content-chat-last:' + jobKey);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return {
      topic: String(j.topic || ''),
      mode: j.mode === 'wenan' ? 'wenan' : 'daily',
      sentAt: Number(j.sentAt) || 0,
      jobAt: Number(j.jobAt) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} jobKey job key
 * @param {{topic?:string, mode?:string, sentAt?:number, jobAt?:number}} patch 要合并的字段
 * @returns {void}
 */
export function writeLastRequest(jobKey, patch) {
  try {
    const prev = readLastRequest(jobKey) || { topic: '', mode: 'daily', sentAt: 0, jobAt: 0 };
    const next = { ...prev, ...(patch || {}) };
    localStorage.setItem('douya-content-chat-last:' + jobKey, JSON.stringify({
      topic: String(next.topic || ''),
      mode: next.mode === 'wenan' ? 'wenan' : 'daily',
      sentAt: Number(next.sentAt) || 0,
      jobAt: Number(next.jobAt) || 0,
    }));
  } catch {
    /* localStorage 满了也不该让生成失败：这只是"再来一次能不能认回来"的便利 */
  }
}

/** 清掉「上一次请求」记忆（切企业 / 测试复位时用）。 */
export function clearLastRequest(jobKey) {
  try { localStorage.removeItem('douya-content-chat-last:' + jobKey); } catch { /* 忽略 */ }
}

export default generateContentCopy;
