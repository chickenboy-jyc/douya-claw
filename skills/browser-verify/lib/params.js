'use strict';
/**
 * 技能参数归一化。
 *
 * 重要事实：本项目的技能参数在渲染层被统一声明为 **string**
 * （见 src/renderer/App.jsx:923 `{ type: 'string' }`），模型回传的 `screenshot`
 * 很可能是字符串 "true"/"false"，`timeout_ms` 很可能是 "30000"。
 * 因此这里必须**显式强转**，不能假定类型。
 */

const ACTION_TYPES = new Set(['click', 'fill', 'waitFor']);

const DEFAULTS = {
  timeoutMs: 30000,   // 页面加载超时
  settleMs: 800,      // 加载完成后的额外等待（等前端框架渲染）
  screenshot: true,
};

const LIMITS = {
  timeoutMs: [2000, 120000],
  settleMs: [0, 10000],
  maxActions: 30,
};

/**
 * 宽松布尔转换：接受 true/false、"true"/"false"、"1"/"0"、"yes"/"no"、1/0。
 * 认不出来时用默认值（不抛错，参数噪音不该让整次验证失败）。
 * @param {unknown} v
 * @param {boolean} dflt
 * @returns {boolean}
 */
function coerceBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return dflt;
}

/**
 * 整数转换 + clamp。
 * @param {unknown} v
 * @param {number} dflt
 * @param {[number, number]} range
 * @returns {number}
 */
function coerceInt(v, dflt, range) {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return dflt;
  const lo = range[0];
  const hi = range[1];
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * 解析 actions：接受 JSON 数组、JSON 字符串、或 '', null, undefined（→ 空数组）。
 * 任何格式错误都**如实返回失败**（不静默丢弃用户的点击动作 —— 那会让结论假装"验过了"）。
 * @param {unknown} raw
 * @returns {{ok:true, actions:Array<object>} | {ok:false, reason:string}}
 */
function normalizeActions(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, actions: [] };
  }
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: 'actions 不是合法 JSON：' + e.message + '（应为一个数组，如 [{"type":"click","selector":"#go"}]）' };
    }
  }
  if (!Array.isArray(arr)) {
    return { ok: false, reason: 'actions 必须是数组（收到的是 ' + typeof arr + '）' };
  }
  if (arr.length > LIMITS.maxActions) {
    return { ok: false, reason: 'actions 项数过多（' + arr.length + ' > ' + LIMITS.maxActions + '），请拆分验证步骤' };
  }
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      return { ok: false, reason: 'actions[' + i + '] 不是对象' };
    }
    const type = String(it.type == null ? '' : it.type).trim();
    if (!ACTION_TYPES.has(type)) {
      return { ok: false, reason: 'actions[' + i + '].type 不支持：' + (type || '(空)') + '（仅支持 click / fill / waitFor）' };
    }
    const selector = String(it.selector == null ? '' : it.selector).trim();
    if (!selector) {
      return { ok: false, reason: 'actions[' + i + '](' + type + ') 缺少 selector' };
    }
    if (type === 'fill') {
      if (it.value === undefined || it.value === null) {
        return { ok: false, reason: 'actions[' + i + '](fill) 缺少 value' };
      }
      out.push({ type, selector, value: String(it.value) });
    } else if (type === 'waitFor') {
      const t = it.timeout_ms === undefined ? 5000 : coerceInt(it.timeout_ms, 5000, [200, 60000]);
      out.push({ type, selector, timeoutMs: t });
    } else {
      out.push({ type, selector });
    }
  }
  return { ok: true, actions: out };
}

/**
 * @param {object} p 原始 params
 * @returns {{ok:true, url:string, actions:Array<object>, expectText:string, expectSelector:string, screenshot:boolean, timeoutMs:number, settleMs:number, cdpUrl:string} | {ok:false, reason:string}}
 */
function normalizeParams(p) {
  const raw = p && typeof p === 'object' ? p : {};
  const a = normalizeActions(raw.actions);
  if (!a.ok) return { ok: false, reason: a.reason };
  return {
    ok: true,
    url: String(raw.url == null ? '' : raw.url).trim(),
    actions: a.actions,
    expectText: String(raw.expect_text == null ? '' : raw.expect_text),
    expectSelector: String(raw.expect_selector == null ? '' : raw.expect_selector).trim(),
    screenshot: coerceBool(raw.screenshot, DEFAULTS.screenshot),
    timeoutMs: coerceInt(raw.timeout_ms, DEFAULTS.timeoutMs, LIMITS.timeoutMs),
    settleMs: coerceInt(raw.settle_ms, DEFAULTS.settleMs, LIMITS.settleMs),
    cdpUrl: String(raw.cdp_url == null ? '' : raw.cdp_url).trim(),
  };
}

module.exports = { normalizeParams, normalizeActions, coerceBool, coerceInt, ACTION_TYPES, DEFAULTS, LIMITS };
