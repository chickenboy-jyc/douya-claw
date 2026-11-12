/**
 * aiReadiness —— 渲染层「AI 是否可用」的**单一事实源**。
 *
 * 为什么必须抽出来：此前渲染层有 HUD（顶栏提示条 / 发送按钮 / 引导卡 / 首登屏 2）
 * 各自用 `!apiKey` 判「有没有连上 AI」，而主进程的真实判据**不是**「有没有 key」——
 * 见 `src/main/backend.js` 的 `/api/chat` 与 `/api/chat-once`：
 *
 *     const apiKey = payload.apiKey || cfg.apiKey;
 *     const baseURL = normalizeBaseURL(payload.baseURL || cfg.baseURL);
 *     // 仅公网 DeepSeek（api.deepseek.com）要求用户自填 Key；内网模型网关零配置即可对话（登录即用）。
 *     if (!apiKey && /api\.deepseek\.com/.test(baseURL)) { 400 missing apiKey }
 *
 * 且 `defaultConfig()`（backend.js）默认 `baseURL='http://192.168.80.99:10003/v1'`、`apiKey=''`，
 * `authHeaders()` 在 apiKey 为空时**不发送** Authorization —— 从设计上就支持「无 key 内网」。
 *
 * ⇒ 「本地无 apiKey + 内网模型网关」是**合法可用状态**（老板原话「填 API **或者账号**」的账号那条）。
 * 若渲染层只用 `!apiKey` 判，会把这类用户全部误判成「未连接 AI」：顶栏永久黄条、发送按钮禁用、
 * 首登屏 2 的「测试连接」点不动（直接把 onboarding 掐死）。
 *
 * 【同源纪律】本文件的 `isPublicDeepSeek` 与主进程 `backend.js` 的那条正则**必须逐字一致**。
 * 改动任何一侧，另一侧必须同步；`scripts/smoke/unit-onboarding-v2.mjs` 有断言钉住两侧表达式。
 *
 * 本文件是**纯函数模块**：不 import React、不读写 localStorage（除 `readSettingsAi`）、
 * 不发网络请求、无副作用。
 */

/** 公网 DeepSeek 域名 —— 与主进程 `backend.js` 的 `/api\.deepseek\.com/` 正则逐字一致。 */
export const PUBLIC_DEEPSEEK_RE = /api\.deepseek\.com/;

/**
 * baseURL 是否指向公网 DeepSeek（唯一「必须自填 Key」的服务商）。
 * @param {string} [baseURL]
 * @returns {boolean}
 */
export function isPublicDeepSeek(baseURL) {
  return PUBLIC_DEEPSEEK_RE.test(String(baseURL == null ? '' : baseURL));
}

/**
 * AI 是否可用 —— 与主进程判据同源（`blocked = !apiKey && isPublicDeepSeek(baseURL)` 取反）。
 *
 * · 有 apiKey ⇒ 可用（任何服务商）；
 * · 无 apiKey 且 baseURL 不是公网 DeepSeek（内网模型网关 / 自建网关）⇒ **可用**（零配置登录即用）；
 * · 无 apiKey 且 baseURL 是公网 DeepSeek ⇒ 不可用（须自填 Key）。
 *
 * @param {{apiKey?:string, baseURL?:string}} [input]
 * @returns {boolean}
 */
export function isAiReady(input) {
  const { apiKey, baseURL } = input && typeof input === 'object' ? input : {};
  return !!apiKey || !isPublicDeepSeek(baseURL);
}

/**
 * 是否需要用户补 AI 配置（= !isAiReady）。语义与 `isAiReady` 严格互补，供 UI 直接取反使用。
 * @param {{apiKey?:string, baseURL?:string}} [input]
 * @returns {boolean}
 */
export function needAiConfig(input) {
  return !isAiReady(input);
}

/**
 * 读本地 AI 配置（与 `App.jsx` 的 `loadSettings()` 同源 key `agent-settings`）。
 *
 * 为什么读 localStorage 而不是只信入参：`chatOnce()` 的 20 个调用点**都不传 apiKey / baseURL**
 * （只传 temperature / enableSearch / reasoningEffort 等），故必须回落本地设置。
 *
 * @returns {{apiKey:string, baseURL:string, model:string}} 缺失 / 脏数据一律空串
 */
export function readSettingsAi() {
  const out = { apiKey: '', baseURL: '', model: '' };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('agent-settings') : null;
    const s = JSON.parse(raw || '{}');
    if (!s || typeof s !== 'object') return out;
    if (typeof s.apiKey === 'string') out.apiKey = s.apiKey;
    if (typeof s.baseURL === 'string') out.baseURL = s.baseURL;
    if (typeof s.model === 'string') out.model = s.model;
  } catch {
    // 脏数据 / localStorage 不可用：一律当作「无配置」，由调用方结合 baseURL 判定。
  }
  return out;
}
