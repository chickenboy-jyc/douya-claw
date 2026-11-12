/**
 * webSearchHealth.js —— 「联网搜索到底通没通」的运行时探针（数据来源诚实化的唯一判据）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 一、为什么需要这个探针（背景 / 产品级谎言）
 * ────────────────────────────────────────────────────────────────────────────
 * 产品里的 searchWeb()（src/renderer/api.js）在 UI 上被标成「联网检索」，实现是把
 * `enableSearch: true` 交给主进程 /api/chat-once，主进程再转发给**内网 LLM 网关**
 * （New API，默认 http://192.168.80.99:10003/v1 ，模型 deepseek-v4-pro-wb）。
 *
 * 本机真实调用实测证实：该网关**不支持 enable_search 参数，会静默忽略它**——
 *   ① 直接问「今天的日期 / 最新新闻」，模型回答「我无法实时获取…建议你打开联网搜索功能」；
 *   ② 返回体 choices[0].message 只有 role / content，**没有** search_results / references；
 *   ③ usage.prompt_tokens ≈ 18 —— 若真发生检索，检索摘要会注入 prompt，token 会涨到几千；
 *   ④ 换 deepseek-v4-pro / qwen3.7-max / qwen3.7-plus 等全部可用模型都一样自认无法联网。
 * 也就是说：**这条链路从来没有真的上过网**，结果是模型凭训练记忆作答。
 *
 * 但下游有 4 处调用点只要 searchWeb 返回 HTTP 200 且有文本，就把数据来源标成「联网检索」，
 * 老板在企业微信形态的经营诊断里因此看到满屏「来源：联网检索（AI 推断）」——
 * 那是假的，一次网都没上过，违反产品自己定的「数据来源诚实三态」红线。
 *
 * 本模块不做联网服务接入（那是下一步），只做一件事：**让「联网」这个标签可证伪**——
 * 没联网，调用方就老实在 UI 上写「未联网 · 模型推断」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 二、为什么这个探针有判别力（知识截止 2025-05 vs 运行时 2026 年）
 * ────────────────────────────────────────────────────────────────────────────
 * 内网这批模型的训练知识截止在 2025-05 前后，且自述「无法实时获取今天日期」。
 * 探针就问它**运行时当天**的日期：
 *   · 真联网  → 它能拿到当天日期并答对 → available = true；
 *   · 没联网  → 它只能靠训练记忆，答不出运行时的具体日期（且常用「知识截止 / 无法实时」推脱）
 *              → available = false。
 * 判别力的关键：探针必须用**运行时当天**的日期（绝不写死），否则模型靠常识蒙对某个过去日期
 * 就会假阳性。同时，探针问题里**不泄露答案日期**（只要求它给出当天的具体年月日），
 * 否则模型只需复读问题就能骗过探针。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 三、三态语义（调用方必须严格遵守）
 * ────────────────────────────────────────────────────────────────────────────
 *   available === true  → 已确证联网可用；
 *   available === false → 已确证未联网（探针跑通，但没答出运行时当天日期）；
 *   available === null  → 未测 / 测不了（探针抛异常 / 超时 / 返回体不可用）
 *                         —— **必须按「未知」处理，绝不许当 true**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 四、双探针（v2：真实检索端点接入后）
 * ────────────────────────────────────────────────────────────────────────────
 * 「问模型今天日期」只能证明**模型侧**联没联网。产品接入真实检索端点
 * （主进程 /api/web-search，见 src/main/webSearchProviders.js）后，必须用**直接证据**
 * 判断检索端点本身是否可用，不能再靠问模型。故 checkWebSearchHealth 改跑两个探针：
 *   · llmSearch —— 现有「问模型今天日期」判据（保留）；
 *   · webApi    —— 直接调 /api/web-search 检索一个**必定有结果**的中文词
 *                  （WEB_PROBE_QUERY），results.length > 0 → true；
 *                  端点 404/网络失败（fetchWebSearch 返回 ok:false）→ false；
 *                  抛异常 / 无法判定 → null。
 * 统一口径 available = webApi===true || llmSearch===true ? true
 *                     : (webApi===false && llmSearch===false ? false : null)
 * 「任一失败不许污染另一个」：两个探针各自 try/catch，互不影响。
 *
 * @typedef {{available: boolean|null, llmSearch: boolean|null, webApi: boolean|null,
 *            provider: string, checkedAt: number, reason: string, probeContent: string,
 *            probeCount: number}} WebSearchHealth
 */
import { searchWeb, fetchWebSearch } from '../api.js';

/** 缓存 TTL：30 分钟（探针会真发一次上游请求，不宜过频；也不能太旧）。 */
const TTL_MS = 30 * 60 * 1000;

/**
 * webApi 探针用的查询词：选一个**中文、泛化、必定有结果**的词（口腔行业域内），
 * 只要检索端点通就一定检得到东西；端点挂了/被墙则检不到 → 直接证据。
 */
const WEB_PROBE_QUERY = '口腔医疗器械';

/** 把异常归一成可读字符串。 */
function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

/**
 * 探针返回内容里出现「今天的日期」的判定容错：
 * 支持 2026-09-14 / 2026/9/14 / 2026.09.14 / 2026年9月14日 / 9月14日 等格式。
 * （见 judgeProbeAnswer）
 */

/** 进程内缓存（含 checkedAt，供 TTL 判定）。null = 从未测过。 */
let __cache = null;
/** 进行中的探针 promise：同一时刻并发调用只跑一次真实探针。 */
let __inflight = null;

/** 数字补零（2 位）。 */
function p2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 把任意输入归一成 Date；非法则用当前时间兜底。
 * @param {Date|number|string} [now]
 * @returns {Date}
 */
function asDate(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (now != null) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * Date → 年月日拆分（本地时区）。
 * @param {Date} d
 * @returns {{y:number, m:number, d:number, ymd:string, cn:string}}
 */
function ymdOf(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return { y, m, d: day, ymd: `${y}-${p2(m)}-${p2(day)}`, cn: `${y}年${m}月${day}日` };
}

/**
 * 构造探针问题：要求给出「今天」的具体年月日，并允许模型在无法实时获取时明确拒绝。
 *
 * 注意：**问题里绝不出现答案日期**，否则模型复读即可骗过探针。
 * `now` 只用于内部保持签名一致 / 日志，不写入问题文本。
 *
 * @param {Date} [now=new Date()] 运行时当前时间（本题不泄露，仅保证签名的三态可测）
 * @returns {string}
 */
export function buildProbeQuestion(now = new Date()) {
  // 触碰一次 now，保证传入非法值时也能被归一（但不把日期写进问题）。
  asDate(now);
  return (
    '请只回答一句话：今天的日期是哪一天？' +
    '请用「YYYY年M月D日」或「YYYY-MM-DD」这类明确格式给出**具体年、月、日**（不要只写星期几）。' +
    '如果你无法实时获取当前日期，就只回复四个字：无法获取。'
  );
}

/**
 * 判定模型回答里是否出现「今天」的日期（= 运行时当天）。
 *
 * 容错格式：
 *   · 完整年月日：2026-09-14 / 2026/9/14 / 2026.09.14 / 2026年9月14日 / 2026年09月14号
 *   · 仅月日   ：9月14日 / 9-14 / 9/14（模型可能省略年份）
 * 规则：
 *   · 命中与运行时当天相符的完整年月日或月日 → true；
 *   · 命中其它日期（不符）→ 继续找；全都不符 → false；
 *   · 空串 / 非字符串 / 无任何日期 → false。
 *
 * @param {string} content 模型回答原文
 * @param {Date} [now=new Date()] 运行时当天（判定基准，务必传运行时真实日期）
 * @returns {boolean}
 */
export function judgeProbeAnswer(content, now = new Date()) {
  const s = typeof content === 'string' ? content : '';
  if (!s.trim()) return false;
  const { y, m, d } = ymdOf(asDate(now));

  // 1) 先处理「完整年月日」，并把命中的片段从串里抠掉，
  //    避免 2026-09-14 里的 "6-09" 被下面的「仅月日」规则误判（例如今天恰为 6 月 9 日时）。
  const fullRes = [
    /(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/g, // 2026-09-14 / 2026/9/14 / 2026.09.14
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g, // 2026年9月14日 / 2026年09月14号
  ];
  let rest = s;
  let fullHit = false;
  for (const re of fullRes) {
    rest = rest.replace(re, (_all, a, b, c) => {
      if (Number(a) === y && Number(b) === m && Number(c) === d) fullHit = true;
      return ' ';
    });
  }
  if (fullHit) return true;

  // 2) 再处理「仅月日」：9月14日 / 9-14 / 9/14
  const mdRes = [
    /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g,
    /(?<![\d])(\d{1,2})\s*[-/]\s*(\d{1,2})(?![\d])/g,
  ];
  for (const re of mdRes) {
    let mt;
    re.lastIndex = 0;
    while ((mt = re.exec(rest)) !== null) {
      if (Number(mt[1]) === m && Number(mt[2]) === d) return true;
    }
  }
  return false;
}

/**
 * 模型侧探针：问模型今天的日期，答对 → 模型侧确实能拿到实时信息。
 * 内部函数，永远不抛（异常 → llmSearch:null）。
 * @param {(q:string,o?:object)=>Promise<{ok?:boolean,content?:string,error?:string}>} fn
 * @param {Date} now
 * @returns {Promise<{llmSearch:boolean|null, reason:string, probeContent:string}>}
 */
async function runLlmProbe(fn, now) {
  let res;
  try {
    res = await fn(buildProbeQuestion(now), { temperature: 0 });
  } catch (e) {
    return { llmSearch: null, reason: '模型侧探针执行失败（异常/超时）：' + errMsg(e), probeContent: '' };
  }
  const content = res && typeof res.content === 'string' ? res.content : '';
  if (!res || res.ok !== true || !content.trim()) {
    return {
      llmSearch: null,
      reason: '模型侧探针未取得可用返回（' + ((res && res.error) || (res ? '返回体无 content' : '无返回')) + '）',
      probeContent: content,
    };
  }
  const ok = judgeProbeAnswer(content, now);
  return {
    llmSearch: ok,
    reason: ok
      ? '模型侧答出运行时当天日期（模型侧联网可用）'
      : '模型侧未答出运行时当天日期（仅凭训练知识作答，模型侧未联网）',
    probeContent: content,
  };
}

/**
 * 检索端点探针：直接调真实检索端点，看是否真拿到结果（**不靠问模型**）。
 * 内部函数，永远不抛（异常 → webApi:null）。
 * @param {(q:string,o?:object)=>Promise<{ok?:boolean,provider?:string,results?:Array,error?:string}>} fn
 * @returns {Promise<{webApi:boolean|null, provider:string, count:number, reason:string}>}
 */
async function runWebApiProbe(fn) {
  let res;
  try {
    res = await fn(WEB_PROBE_QUERY, { count: 5 });
  } catch (e) {
    return { webApi: null, provider: '', count: 0, reason: '检索端点探针执行失败（异常/超时）：' + errMsg(e) };
  }
  if (!res || typeof res !== 'object') {
    return { webApi: null, provider: '', count: 0, reason: '检索端点探针无有效返回，无法判定' };
  }
  const provider = typeof res.provider === 'string' ? res.provider : '';
  const results = Array.isArray(res.results) ? res.results : [];
  if (res.ok === true && results.length > 0) {
    return {
      webApi: true,
      provider,
      count: results.length,
      reason: `检索端点可用（${provider || 'unknown'} 实检 ${results.length} 条真实网页结果）`,
    };
  }
  if (res.ok === false) {
    return { webApi: false, provider, count: 0, reason: '检索端点不可用（' + (res.error || '未知错误') + '）' };
  }
  // ok:true 但空结果（或结构异常）：端点通了但没拿到资料 → 不能算「已确证拿到外部资料」
  return { webApi: false, provider, count: results.length, reason: '检索端点可达但未返回结果' };
}

/**
 * 组合两个探针的 reason 成一句人话。
 * @param {boolean|null} available
 * @param {{reason:string}} llm
 * @param {{reason:string}} web
 * @returns {string}
 */
function buildHealthReason(available, llm, web) {
  const head = available === true ? '联网可用：' : available === false ? '未联网：' : '联网状态未知：';
  return head + [llm.reason, web.reason].join('；');
}

/**
 * 跑一次联网探针（双探针），返回联网可用性。
 *
 * - 缓存命中（未过期且非 force）→ 直接返回缓存；
 * - 并发去重：同一时刻多个调用共享同一次真实探针（in-flight promise 复用）；
 * - llmSearch / webApi 各自独立 try/catch，**任一失败不污染另一个**；
 * - 两者都无法判 true 时 available 至少是 null，**绝不许返回 true**。
 *
 * @param {object} [opts]
 * @param {(q:string, o?:object)=>Promise<{ok?:boolean,content?:string,error?:string}>} [opts.searchFn]
 *        模型侧搜索实现，默认 searchWeb；单测注入假实现。
 * @param {(q:string, o?:object)=>Promise<{ok?:boolean,provider?:string,results?:Array,error?:string}>} [opts.fetchFn]
 *        检索端点实现，默认 fetchWebSearch；单测注入假实现。
 * @param {boolean} [opts.force=false] 强制忽略缓存重跑一次
 * @returns {Promise<WebSearchHealth>}
 */
export async function checkWebSearchHealth({ searchFn, fetchFn, force = false } = {}) {
  const llmFn = typeof searchFn === 'function' ? searchFn : searchWeb;
  const webFn = typeof fetchFn === 'function' ? fetchFn : fetchWebSearch;

  if (!force && __cache && Date.now() - __cache.checkedAt < TTL_MS) {
    return __cache;
  }
  if (!force && __inflight) {
    return __inflight;
  }

  const now = new Date();
  __inflight = (async () => {
    // 两个探针并行；各自再包一层 catch，确保任一异常都不会影响另一个的判定。
    const [llm, web] = await Promise.all([
      runLlmProbe(llmFn, now).catch((e) => ({
        llmSearch: null,
        reason: '模型侧探针异常：' + errMsg(e),
        probeContent: '',
      })),
      runWebApiProbe(webFn).catch((e) => ({
        webApi: null,
        provider: '',
        count: 0,
        reason: '检索端点探针异常：' + errMsg(e),
      })),
    ]);

    // 统一口径：有任一为真 → true；两者都确证为假 → false；否则未知(null)。
    let available;
    if (web.webApi === true || llm.llmSearch === true) available = true;
    else if (web.webApi === false && llm.llmSearch === false) available = false;
    else available = null;

    // provider 记实际生效的检索 provider（供 source 文案使用）：
    //   webApi 为真 → 用检索端点报的 provider；否则只有模型侧为真 → 'llm'；否则沿用端点报的（可能为空）。
    const provider =
      web.webApi === true && web.provider
        ? web.provider
        : llm.llmSearch === true
          ? 'llm'
          : web.provider || '';

    const value = {
      available,
      llmSearch: llm.llmSearch,
      webApi: web.webApi,
      provider,
      checkedAt: Date.now(),
      reason: buildHealthReason(available, llm, web),
      probeContent: llm.probeContent || '',
      probeCount: typeof web.count === 'number' ? web.count : 0,
    };
    __cache = value;
    __inflight = null;
    return value;
  })();

  return __inflight;
}

/**
 * 同步读缓存（不发起探针）。没测过 / 已过期 → null。
 * 调用方据此**同步**决定 UI 文案，不阻塞主流程。
 * @returns {WebSearchHealth|null}
 */
export function getCachedWebSearchHealth() {
  if (__cache && Date.now() - __cache.checkedAt < TTL_MS) return __cache;
  return null;
}

/** 仅供测试：清空缓存与游标。 */
export function __resetWebSearchHealthCache() {
  __cache = null;
  __inflight = null;
}

/**
 * 来源标注的种类（供 describeSource 选择文案）。
 *   WEB            —— 纯 LLM 联网结果（无后端实抓），如 marketDiagnosis / geoExposure 降级分支
 *   SCAN_WEB       —— 后端实抓 + LLM 联网，如 geoExposure 实抓分支 / CompetitorAnalysis(有实抓)
 *   INTERNAL       —— 降级到内网模型（根本没联网），如 searchWeb 失败后的 chatOnce 兜底
 *   SCAN_INTERNAL  —— 后端实抓 + 内网模型兜底
 */
export const SOURCE_KINDS = {
  WEB: 'web',
  SCAN_WEB: 'scan_web',
  INTERNAL: 'internal',
  SCAN_INTERNAL: 'scan_internal',
};

/**
 * provider 名 → 来源文案里的简称。
 *   'tavily-key' / 'tavily-keyless' → 'tavily'
 *   'bocha'                         → 'bocha'
 *   'llm'                           → '模型侧'
 * @param {string} provider
 * @returns {string}
 */
export function providerLabel(provider) {
  const p = String(provider || '');
  if (!p) return '';
  if (p.indexOf('tavily') === 0) return 'tavily';
  if (p === 'bocha') return 'bocha';
  if (p === 'llm') return '模型侧';
  return p;
}

/**
 * 按「联网可用性」生成数据来源文案（4 处调用点共用，避免各写各的）。
 *
 * 规则：
 *   available === true  → 保留原文案，并**在拿到直接证据时补上 provider 与实检条数**：
 *                          webApi===true  → 「联网检索（tavily 实检 5 条）」
 *                          仅 llmSearch===true → 「联网检索（模型侧）」
 *                          两者字段都缺（旧探针对象）→ 退回纯「联网检索」（向后兼容）
 *   available === false → 未联网 · 模型推断 / 后端实抓 + 模型推断（未联网）
 *   available === null  → 模型分析（联网状态未确认） / 对应的实抓变体
 *   INTERNAL 系列       → 一律「未联网 · 内网模型」（这类根本没走 searchWeb，与探针无关）
 *
 * @param {'web'|'scan_web'|'internal'|'scan_internal'} kind
 * @param {WebSearchHealth|null|undefined} health checkWebSearchHealth / getCachedWebSearchHealth 的返回值
 * @returns {string}
 */
export function describeSource(kind, health) {
  const cachedCount =
    health && typeof health === 'object' && typeof health.probeCount === 'number' ? health.probeCount : null;
  return describeSourceWithCount(kind, health, cachedCount);
}

/**
 * 同 describeSource，但允许调用方**用自己的实检条数**覆盖探针里记录条数
 * （调用方刚跑完一次真实检索时，它自己知道的条数比探针缓存更新、更准）。
 *
 * 向后兼容：describeSource(kind, health) 现有签名与 4 个调用点不受影响。
 *
 * @param {'web'|'scan_web'|'internal'|'scan_internal'} kind
 * @param {WebSearchHealth|null|undefined} health
 * @param {number|null} [count] 实检条数（null → 用 health.probeCount，仍无则写「若干」）
 * @returns {string}
 */
export function describeSourceWithCount(kind, health, count) {
  const avail = health && typeof health === 'object' ? health.available : null;
  const webApi = health && typeof health === 'object' ? health.webApi : undefined;
  const llmSearch = health && typeof health === 'object' ? health.llmSearch : undefined;
  const label = providerLabel(health && typeof health === 'object' ? health.provider : '');
  const n = typeof count === 'number' && count > 0 ? count : null;

  // 只有「已确证联网」时才允许出现联网字样（红线：未联网/未确认一字不许放松）。
  const webSuffix =
    avail === true
      ? webApi === true
        ? `（${label || '联网'} 实检 ${n == null ? '若干' : n} 条）`
        : llmSearch === true
          ? '（模型侧）'
          : ''
      : '';

  if (kind === SOURCE_KINDS.INTERNAL) return '未联网 · 内网模型';
  if (kind === SOURCE_KINDS.SCAN_INTERNAL) return '后端实抓 + 未联网 · 内网模型';

  if (kind === SOURCE_KINDS.SCAN_WEB) {
    if (avail === true) return '后端实抓+联网检索' + webSuffix;
    if (avail === false) return '后端实抓 + 模型推断（未联网）';
    return '后端实抓 + 模型分析（联网状态未确认）';
  }

  // 默认按 WEB 处理（未知 kind 也走最保守的骨架）
  if (avail === true) return '联网检索' + webSuffix;
  if (avail === false) return '未联网 · 模型推断';
  return '模型分析（联网状态未确认）';
}

export default {
  buildProbeQuestion,
  judgeProbeAnswer,
  checkWebSearchHealth,
  getCachedWebSearchHealth,
  __resetWebSearchHealthCache,
  describeSource,
  describeSourceWithCount,
  providerLabel,
  SOURCE_KINDS,
};
