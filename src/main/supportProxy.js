'use strict';

/**
 * ============================================================================
 * 客服助手 —— 主进程代理层（渲染层绝不直连外网）
 * ----------------------------------------------------------------------------
 * 背景（老板约束）：「反馈内容 ≤2MB 保留 7 天」。
 *   · ≤2MB      —— 本文件 `FEEDBACK_MAX_BYTES` 是**唯一事实源**，在**主进程**实施；
 *                  超限直接拒绝（含明确 code/status 与中文提示），**绝不静默截断**。
 *   · 本地历史  —— 原「保留 7 天」**已取消**（需求变更：改为**永久保留**）。本地提交历史落
 *                  localStorage，由渲染层 services/support.js 维护：只增不减（不按时间淘汰），
 *                  仅以 50 条为上限、超限时**整列拒绝写入**；线上库不做过期清理，故不与本文件耦合。
 *
 * 为什么放在主进程而不是渲染层：
 *   本仓铁律「渲染层绝不直连外网」（`src/renderer/**` 只打本地后端 / 经 preload 桥）。
 *   所有对 `https://api.example.com` 的外部请求必须由主进程转发 —— 与 GEO 代理（backend.js
 *   /api/geo-proxy）同一条架构约束，只是本能力走 IPC（main.js `support:submit`）而非 HTTP 路由。
 *
 * 接口契约（已实测确认，照此实现，勿再探测生产接口 —— 探测 = 向生产库写数据）：
 *   POST https://api.example.com/api/feedback
 *   · 无需鉴权：**不要**加 Authorization 头（加了反而可能被拒）。
 *   · 必填字段：type、description。
 *   · type 合法枚举（4 个）：bug / feature / experience / other。
 *   · 可选字段：title、contact、url、screenshots。
 *   · 成功：{"success":true,"message":"反馈提交成功！"}
 *   · 失败：{"success":false,"message":"…"}
 *
 * 可测性：本文件**不 require('electron')**，可被纯 node 直接 require 求值并调用
 * （供 scripts/tmp-probe 的独立 2MB 验证使用）。
 *
 * @module supportProxy
 */

/** 自建后端反馈接口（无鉴权）。 */
const DOUYA_FEEDBACK_URL = 'https://api.example.com/api/feedback';
/** 反馈请求体的硬上限：2MB（老板约束「反馈内容 ≤2MB」）。 */
const FEEDBACK_MAX_BYTES = 2 * 1024 * 1024;
/** 合法反馈类型（取自线上后台下拉真源，顺序即展示顺序）。 */
const FEEDBACK_TYPES = Object.freeze(['bug', 'feature', 'experience', 'other']);
/** 转发超时（毫秒）：超时中断 fetch，避免界面「点了没反应」。 */
const FEEDBACK_TIMEOUT_MS = 30000;
/** 截图数量上限（P0 不做上传，仅透传数组；防被塞进超大体量）。 */
const MAX_SCREENSHOTS = 9;

/**
 * UTF-8 字节数（2MB 判据用的是**请求体的真实字节数**，不是字符数）。
 * @param {string} s
 * @returns {number}
 */
function byteLength(s) {
  return Buffer.byteLength(String(s == null ? '' : s), 'utf8');
}

/**
 * 把任意输入规整成将要发送的请求体（只保留契约内的字段，逐字对齐字段名）。
 * @param {object} input 渲染层传上来的原始对象
 * @returns {{type:string, description:string, title?:string, contact?:string, url?:string, screenshots?:string[]}}
 */
function buildFeedbackBody(input) {
  const src = input && typeof input === 'object' ? input : {};
  const body = {};
  // 必填两字段始终带上（即使为空串，交由 validate 判定是否缺失，便于给出精确错误）
  body.type = String(src.type == null ? '' : src.type).trim();
  body.description = String(src.description == null ? '' : src.description);
  // 可选字段：非空才带上，避免污染服务端语义
  const title = src.title == null ? '' : String(src.title);
  if (title !== '') body.title = title;
  const contact = src.contact == null ? '' : String(src.contact);
  if (contact !== '') body.contact = contact;
  const url = src.url == null ? '' : String(src.url);
  if (url !== '') body.url = url;
  // screenshots：P0 只透传字符串数组（不做上传），并限制条数
  if (Array.isArray(src.screenshots) && src.screenshots.length > 0) {
    body.screenshots = src.screenshots.slice(0, MAX_SCREENSHOTS).map((x) => String(x));
  }
  return body;
}

/**
 * 校验并构造请求体。**2MB 上限在此实施**（主进程唯一事实源）。
 *
 * 返回契约（调用方务必区分 ok 与 code）：
 *   · { ok:true,  body, size }                          —— 通过，可发送
 *   · { ok:false, code, error, status?, size?, limit? } —— 被拒绝（error 为中文，绝不静默）
 *
 * @param {object} input 渲染层传上来的原始对象
 * @returns {{ok:boolean, body?:object, size?:number, code?:string, error?:string, status?:number, limit?:number}}
 */
function validateFeedbackPayload(input) {
  const body = buildFeedbackBody(input);
  if (!body.type) {
    return { ok: false, code: 'MISSING_TYPE', status: 400, error: '请选择反馈类型' };
  }
  if (!FEEDBACK_TYPES.includes(body.type)) {
    return {
      ok: false,
      code: 'INVALID_TYPE',
      status: 400,
      error: '反馈类型不合法（须为 bug / feature / experience / other 之一）',
    };
  }
  if (!body.description || !body.description.trim()) {
    return { ok: false, code: 'MISSING_DESCRIPTION', status: 400, error: '请填写问题描述' };
  }
  const serialized = JSON.stringify(body);
  const size = byteLength(serialized);
  if (size > FEEDBACK_MAX_BYTES) {
    const mb = (n) => (n / 1024 / 1024).toFixed(2);
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      status: 413, // 明确的「请求体过大」拒绝（镜像 HTTP 413），不做静默截断
      size,
      limit: FEEDBACK_MAX_BYTES,
      error: `反馈内容过大（${mb(size)}MB，超过 ${FEEDBACK_MAX_BYTES / 1024 / 1024}MB 上限），请精简后重试`,
    };
  }
  return { ok: true, body, size };
}

/**
 * 提交反馈：先校验（含 2MB），再经主进程转发到 api.example.com。
 * **永不自抛** —— 网络/超时/脏响应一律归一为 { ok:false, error }，交给调用方决定 UI。
 *
 * @param {object} input 渲染层传上来的原始对象
 * @param {{fetch?:Function, url?:string, timeoutMs?:number}} [deps] 依赖注入（测试用；生产不传）
 * @returns {Promise<{ok:boolean, message?:string, error?:string, code?:string, status?:number, data?:object}>}
 */
async function submitFeedback(input, deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const check = validateFeedbackPayload(input);
  if (!check.ok) {
    return { ok: false, code: check.code, status: check.status, error: check.error };
  }
  const fetchImpl = typeof d.fetch === 'function' ? d.fetch : (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return { ok: false, code: 'NO_FETCH', error: '主进程缺少网络能力（fetch 不可用）' };
  }
  const url = typeof d.url === 'string' && d.url ? d.url : DOUYA_FEEDBACK_URL;
  const timeoutMs = Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : FEEDBACK_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      // ⚠️ 反馈接口**无需鉴权** —— 刻意**不带** Authorization（带了反而可能被拒）。
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(check.body),
      signal: ctrl.signal,
    });
    let json = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }
    const success = !!(json && json.success === true);
    if (success) {
      return {
        ok: true,
        message: String((json && json.message) || '反馈提交成功！'),
        data: json,
      };
    }
    const status = resp && typeof resp.status === 'number' ? resp.status : 0;
    const msg = (json && json.message) || ('提交失败（HTTP ' + (status || '未知') + '）');
    return { ok: false, error: String(msg), status: status || undefined, data: json };
  } catch (e) {
    const aborted = !!(e && (e.name === 'AbortError' || String(e.name).toLowerCase() === 'abort'));
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
      error: aborted ? `提交超时（超过 ${Math.round(timeoutMs / 1000)} 秒未返回），请稍后重试` : '提交失败：' + ((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DOUYA_FEEDBACK_URL,
  FEEDBACK_MAX_BYTES,
  FEEDBACK_TYPES,
  FEEDBACK_TIMEOUT_MS,
  MAX_SCREENSHOTS,
  byteLength,
  buildFeedbackBody,
  validateFeedbackPayload,
  submitFeedback,
};
