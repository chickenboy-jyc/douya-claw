/**
 * 统一的 GEO 代理调用。
 * 所有新媒体 / 活动 / 危机等模块（以及原 GEO 向导）都通过主进程 /api/geo-proxy
 * 把请求转发到自建后端（https://api.example.com），自动带 Bearer token，避免渲染进程跨域。
 */
/**
 * AI 可用性判据（单一事实源）。**必须与主进程 backend.js 同源**：
 * 只有「无 apiKey 且 baseURL 是公网 DeepSeek」才真的不能连；
 * 内网模型网关零配置登录即用（老板原话「填 API 或者账号」的账号那条）。
 */
import { needAiConfig, readSettingsAi } from './services/aiReadiness.js';

// 同 App.jsx：允许 window.__DOUYA_BACKEND__ 覆盖（真实浏览器验收用），生产不注入。
const BACKEND =
  (typeof window !== 'undefined' && window.__DOUYA_BACKEND__) || 'http://127.0.0.1:10119';

/**
 * 租户上下文（模块级，随当前企业/项目切换而更新）。
 * geoProxy 自动把它作为顶层字段带给主进程，主进程据此给自建后端转发
 * X-Company-Id / X-Project-Id / X-Workspace-Id 头（后端暂不支持也能忽略，为能力接入铺路）。
 */
let __tenant = { companyId: null, projectId: null, workspaceId: null, role: null };

export function setTenantContext(ctx) {
  __tenant = { ...__tenant, ...(ctx && typeof ctx === 'object' ? ctx : {}) };
}
export function getTenantContext() {
  return __tenant;
}

/**
 * 调用自建后端接口。
 *
 * ══════════════════════════════════════════════════════════════════
 * 【0.21.15 · 老板需求 7「做东西有概率会卡死，而且不能多线程工作」】两个根因都在本函数里：
 *
 *  ① **没有超时、没有 AbortController**（chatOnce 早就有，本函数一直漏着）。
 *     主进程那侧虽然给上游 fetch 挂了 120s，但它在**拿到 token 之前**就可能一直挂着
 *     （`connectorMgr.getToken()` 是一次可能要联网续期的调用，没有任何时限）。
 *     那种情况下 `/api/geo-proxy` 永远不返回 ⇒ 本函数的 `await fetch` 永不 settle
 *     ⇒ 调用方的 busy 永远是 true ⇒ 界面上按钮永久转圈。这就是「卡死」。
 *     ⇒ 现在本函数自带 AbortController + 超时（默认 180s，可用 opts.timeoutMs 覆盖），
 *        到点自己中断并**返回** { ok:false, error:'超时…' }，绝不悬挂。
 *
 *  ② **认证类错误用 `alert()` 报**。`window.alert` 是**阻塞式模态框**：
 *     它一弹出来，渲染进程的 JS 主线程就被卡住 —— 此时**所有**其它并发任务的回调、
 *     React 渲染、定时器全部停摆。表现就是老板说的「不能多线程工作」：
 *     一个任务出错弹框，其它任务跟着一起僵住。
 *     ⇒ 改为**非阻塞**：派发 `douya:auth-expired` 自定义事件 + console.warn，
 *        错误本身仍通过返回值 `{ok:false, error}` 交给调用方展示（各模块都有错误位）。
 *
 * @param {string} path 后端相对路径，如 '/api/geo/company-analyze'
 * @param {string} [method='POST'] HTTP 方法
 * @param {object} [body={}] 请求体（GET/DELETE 时会作为 query 参数）
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts] 超时毫秒数 / 外部取消信号
 * @returns {Promise<object>} 成功时返回后端 JSON（通常带 ok:true），失败时返回 { ok:false, error }
 */

/** GEO 代理默认超时（毫秒）。AI 生成类接口可能 20-30s，放宽到 180s；可用 opts.timeoutMs 覆盖。 */
export const GEO_PROXY_TIMEOUT_MS = 180000;

/** AI 补全默认超时（毫秒）：超时直接中断 fetch，避免界面「点了没反应、只能干等」。 */
export const CHAT_TIMEOUT_MS = 120000;

export async function geoProxy(path, method = 'POST', body = {}, opts = {}) {
  const external = opts && opts.signal ? opts.signal : null;
  const timeoutMs = opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : GEO_PROXY_TIMEOUT_MS;
  // 统一用内部 controller 承接「超时」与「外部取消」两种中断源（与 chatOnce 同构）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(`${BACKEND}/api/geo-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ path, method: method || 'POST', body: body || {}, ...__tenant }),
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: 'GEO 请求失败（HTTP ' + res.status + '）' };
    if (j.ok === false) {
      const err = j.error || 'GEO 请求失败';
      // 认证/连接类错误：**不再 alert（会卡住整个渲染进程）**，改为非阻塞事件广播。
      if (err.includes('连接豆芽AI') || err.includes('登录已过期')) {
        notifyAuthExpired(err);
      }
      return { ok: false, error: err };
    }
    return j;
  } catch (e) {
    const isAbort = !!(e && (e.name === 'AbortError' || e.name === 'AbortError'.toLowerCase()));
    if (isAbort) {
      if (external && external.aborted) return { ok: false, error: '已取消 GEO 请求' };
      return { ok: false, error: 'GEO 请求超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒未返回），请重试' };
    }
    return { ok: false, error: 'GEO 请求失败：' + e.message };
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 广播「登录已过期 / 连不上豆芽AI」。**非阻塞**（原来的 alert 会冻住整个渲染进程）。
 * 想接的 UI 监听 `window.addEventListener('douya:auth-expired', …)` 即可；
 * 没人监听也无害 —— 错误原文照常通过返回值交给调用方展示。
 * @param {string} err 错误原文
 */
function notifyAuthExpired(err) {
  try {
    console.warn('[douya] 豆芽AI 认证/连接异常：' + err);
  } catch { /* ignore */ }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('douya:auth-expired', { detail: { error: err } }));
    }
  } catch { /* 非浏览器环境（node 测试）忽略 */ }
}

/**
 * 非流式补全：调用主进程 /api/chat-once，返回 { ok, content }。
 * 供 projectAI.js 的结构化 AI 调用（AI 辅助建项目 / 一句话建任务 / AI 执行任务 / 助手问答 / 今日建议）使用。
 * 与 geoProxy 不同：chat-once 走通用 LLM 补全（复用后端 injectExpertSystemMessage + compressContext），
 * 不经过自建后端。
 *
 * 超时 / 中断（纯增量，不破坏现有调用方）：
 *  - 默认 120 秒超时（opts.timeoutMs 可覆盖），到点 AbortController 中断 fetch；
 *  - 可选传 opts.signal（外部 AbortController.signal），外部取消时同步中断本次请求；
 *  - 现有调用方都不传 signal / timeoutMs，行为与原来一致，只是多了超时保护。
 * @param {Array} messages 对话消息 [{ role, content }]
 * @param {object} [context] buildAIContext 输出的上下文（含 text / 四段 / id 载荷）
 * @param {object} [opts] { temperature, model, baseURL, apiKey, signal, timeoutMs }
 * @returns {Promise<{ok:boolean, content?:string, error?:string}>}
 */
/** 当前登录用户名：chat-once 也要按账号记账，而 chatOnce 是纯 helper 拿不到 React 状态 => 直接读本地登录态。 */
function readingUsername() {
  try {
    const u = JSON.parse(localStorage.getItem('douya-auth-user') || '{}');
    return String((u && (u.username || u.name)) || '');
  } catch {
    return '';
  }
}

/**
 * 「AI 是否已连上」的判定源统一在 `services/aiReadiness.js`（与主进程 backend.js 同源）。
 * chatOnce 是纯 helper（拿不到 React 状态），故直接读 localStorage['agent-settings'] ——
 * 必须与 App.jsx 的 loadSettings() / FeedTheBuddyCard 读**同一个 key**，
 * 否则会出现「顶栏说没连上、按钮却把请求发出去」的分裂。
 */

export async function chatOnce(messages, context, opts = {}) {
  // 「AI 未就绪」软门禁拦截：整条渲染层的唯一 AI 出口就是本函数，20 个调用点全收敛于此。
  // 未连接 AI 时**提前返回**，不发出网络请求（避免"顶栏说没连上、却仍把请求打出去"的分裂）。
  // ⚠️ 早退必须在 `new AbortController()` / `setTimeout()` **之前** —— 否则会漏 clearTimeout。
  // ⚠️ 本拦截**只**作用于 chatOnce；`/api/llm/test`（llmTest.js，屏 2 正是在无 key 状态下测连接）
  //    与 geoProxy（走自建后端登录态，不由 apiKey 决定）**绝不受影响**。
  // ⚠️ 判据**不是**「有没有 apiKey」：内网模型网关零配置登录即用（主进程 backend.js 只在
  //    「无 key 且 baseURL 是公网 DeepSeek」时才拒），故统一走 services/aiReadiness.js 同源判定。
  const settingsAi = readSettingsAi();
  const ai = {
    apiKey: (opts && opts.apiKey) || settingsAi.apiKey,
    baseURL: (opts && opts.baseURL) || settingsAi.baseURL,
  };
  if (needAiConfig(ai)) {
    return {
      ok: false,
      content: '',
      error: '尚未连接 AI：请在「设置」里填写 API Key（若走内网网关，登录即可用）。',
      code: 'AI_NOT_CONFIGURED',
    };
  }
  const external = opts && opts.signal ? opts.signal : null;
  const timeoutMs = opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : CHAT_TIMEOUT_MS;
  // 统一用一个内部 controller 承接「超时」与「外部取消」两种中断源
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(`${BACKEND}/api/chat-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: Array.isArray(messages) ? messages : [],
        context: context && typeof context === 'object' ? context : null,
        // 用量按账号归属（主进程据此记账并上报；服务端最终以 access_token 为准）
        username: readingUsername() || undefined,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined,
        model: opts.model,
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        enableSearch: opts.enableSearch === true ? true : undefined,
        reasoningEffort: opts.reasoningEffort,
        // 透传 maxTokens：后端 handleChatOnce 默认 8000，开思考后 reasoning_content 会占用预算，
        // 长代码任务需要更高上限（否则正文可能被 reasoning 挤空）。
        maxTokens: typeof opts.maxTokens === 'number' && opts.maxTokens > 0 ? opts.maxTokens : undefined,
      }),
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, content: '', error: 'AI 请求失败（HTTP ' + res.status + '）' };
    return j;
  } catch (e) {
    const isAbort = !!(e && (e.name === 'AbortError' || e.name === 'AbortError'.toLowerCase()));
    if (isAbort) {
      if (external && external.aborted) return { ok: false, content: '', error: '已取消 AI 请求' };
      return { ok: false, content: '', error: 'AI 请求超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒未返回），请重试' };
    }
    return { ok: false, content: '', error: 'AI 请求失败：' + e.message };
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 抓取 RSS/Atom 源原始文本。
 * 走主进程 /api/rss-fetch（主进程直连，规避渲染进程跨域与证书问题，并做 SSRF 防护）。
 * 不带任何 token。
 * @param {string} url RSS/Atom 地址
 * @returns {Promise<{ok:boolean, text?:string, url?:string, status?:number, error?:string}>}
 */
export async function fetchRss(url) {
  try {
    const res = await fetch(`${BACKEND}/api/rss-fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: String(url || '') }),
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: 'RSS 抓取失败（HTTP ' + res.status + '）' };
    return j;
  } catch (e) {
    return { ok: false, error: 'RSS 抓取失败：' + e.message };
  }
}

/**
 * 抓中华医学期刊网（*.yiigle.com / medjournals.cn）的一个页面。
 *
 * 为什么不复用 `fetchRss`：
 *   那条通路是**无状态逐跳**抓取（跨跳不带 cookie）。而这两站实测（2026-10-20）必须先拿
 *   第 1 跳下发的 AWSALB / JSESSIONID，否则 `当期目录` → CAS 登录页 → 回原地址 → 又去登录页，
 *   无限 302（curl 直接 `(47) Maximum (50) redirects followed`）。
 *   所以主进程单开了一条带 cookie jar 的 `/api/journal-issue`，域名白名单只放中华医学期刊网。
 *
 * 返回语义与 fetchRss 一致：`{ ok:true, text, url, status }` / `{ ok:false, error }`。
 * 调用方**必须**区分这两者 —— 抓不到就是抓不到，不许当成「今天没有新文献」。
 * @param {string} url 目标页面地址
 * @returns {Promise<{ok:boolean, text?:string, url?:string, status?:number, error?:string}>}
 */
export async function fetchJournalHtml(url) {
  try {
    const res = await fetch(`${BACKEND}/api/journal-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: String(url || '') }),
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: '期刊抓取失败（HTTP ' + res.status + '）' };
    return j;
  } catch (e) {
    return { ok: false, error: '期刊抓取失败：' + e.message };
  }
}

export default geoProxy;

/**
 * 真实联网检索：走主进程 /api/web-search（主进程直连第三方搜索 API，规避渲染层跨域，
 * 并把检索 API key 留在主进程、绝不回传渲染层）。
 *
 * 返回语义（与主进程一致，调用方**务必**区分）：
 *   · { ok:true,  results:[...] }  真检到资料；
 *   · { ok:true,  results:[]   }  **真没搜到**（provider 可用但无结果），不是失败；
 *   · { ok:false, error }         检索失败（网络/超时/HTTP 非 2xx/无可用 provider）。
 * provider 记实际生效者：'tavily-key' | 'tavily-keyless' | 'bocha' | 'none'。
 *
 * @param {string} query 检索词
 * @param {object} [opts] { count, freshness, timeoutMs }
 * @returns {Promise<{ok:boolean, provider:string, results:Array, elapsedMs:number, error:string}>}
 */
export async function fetchWebSearch(query, opts = {}) {
  try {
    const res = await fetch(`${BACKEND}/api/web-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: String(query || ''),
        count: opts && opts.count,
        freshness: opts && opts.freshness,
        timeoutMs: opts && opts.timeoutMs,
      }),
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, provider: 'none', results: [], elapsedMs: 0, error: '联网检索失败（HTTP ' + res.status + '）' };
    return j;
  } catch (e) {
    return { ok: false, provider: 'none', results: [], elapsedMs: 0, error: '联网检索失败：' + e.message };
  }
}

/**
 * 联网搜索兜底：走内网 LLM 的 enable_search 联网能力，让模型联网检索后作答。
 * 用于豆芽工作台后端爬虫/接口返回空或失败时的降级，保证「舆情/竞品/调性」等
 * 依赖真实数据的功能在后端缺口下仍能给出有据可查的结果，而非「无返回/失败」。
 * @param {string} question 要联网检索的问题（尽量具体，含企业名/关键词）
 * @param {object} [opts] { temperature }
 * @returns {Promise<{ok:boolean, content?:string, error?:string}>}
 */
export async function searchWeb(question, opts = {}) {
  return chatOnce([{ role: 'user', content: question }], opts && opts.context ? opts.context : null, {
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
    enableSearch: true,
    reasoningEffort: 'none',
  });
}

/**
 * 客服助手：提交留言/反馈。
 *
 * 传输路径（**渲染层绝不直连外网**，本仓铁律）：
 *   services/support.js → 本函数 → preload 暴露的 window.api.invoke('support:submit', payload)
 *   → 主进程 main.js 的 ipcMain.handle('support:submit') → src/main/supportProxy.js
 *   → POST https://api.example.com/api/feedback。
 *
 * 2MB 上限由**主进程** supportProxy.validateFeedbackPayload 实施（唯一事实源）；
 * 本函数不加 Authorization（该接口无需鉴权），也不做体积判断（前端预检在 services/support.js）。
 *
 * @param {{type:string, description:string, title?:string, contact?:string, url?:string, screenshots?:string[]}} payload
 * @returns {Promise<{ok:boolean, message?:string, error?:string, code?:string, status?:number}>}
 */
export async function supportSubmit(payload) {
  // 非桌面环境（如浏览器验收/SSR）没有 preload 桥 —— 明确报错，绝不静默假装成功。
  const bridge = typeof window !== 'undefined' ? window.api : null;
  if (!bridge || typeof bridge.invoke !== 'function') {
    return { ok: false, error: '当前环境不支持提交反馈（缺少主进程通道），请在桌面客户端内使用。' };
  }
  try {
    const r = await bridge.invoke('support:submit', payload && typeof payload === 'object' ? payload : {});
    return r && typeof r === 'object' ? r : { ok: false, error: '反馈提交失败：主进程返回异常' };
  } catch (e) {
    return { ok: false, error: '反馈提交失败：' + ((e && e.message) || e) };
  }
}

/**
 * 文案合规预检（医疗广告红线自查）。
 * 纯本地规则（主进程 src/main/compliance.js），不走网络、不花 token，断网也能查。
 * @param {string} text 待检查的文案
 */
export async function complianceCheck(text) {
  try {
    const res = await fetch(`${BACKEND}/api/compliance/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || '') }),
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: '合规检查失败（HTTP ' + res.status + '）' };
    return j;
  } catch (e) {
    return { ok: false, error: '合规检查失败：' + ((e && e.message) || e) };
  }
}
