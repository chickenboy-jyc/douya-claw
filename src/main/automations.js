'use strict';

/**
 * ============================================================================
 * 第三层能力：定时任务（Automations）
 * ----------------------------------------------------------------------------
 * 让豆芽在指定时间**无人值守**地自己干活（每天早 9 点跑经营诊断 / 每周巡检竞品 /
 * 定时核对 GEO 发文台账）。调度器活在**主进程**：托盘常驻（main.js）是它存活的前提。
 *
 * 设计要点（务必与实现保持一致，否则可靠性红线会破）：
 *   ① 执行通道 = 回环 HTTP 自调用（POST http://127.0.0.1:<port>/api/chat，读 SSE 到结束），
 *      **不是** 直接 require backend 的 runAgentLoop —— 后者第 4 个参数是 HTTP 响应对象，
 *      伪造它等于让「断开检测/中断」走非真实路径。走 HTTP 就复用了用户聊天的同一条代码路径
 *      （确认门、无人值守分支、成果落盘、token 记账、任务状态全部自动生效）。
 *   ② 先写台账、再执行：进程执行中崩掉也要留下一条悬挂的 running —— 悬挂是**可观测的失败**。
 *   ③ 只补最近一次：启动时发现漏跑，只补最近那一次；更早的直接记 missed（诚实回答「上周的诊断呢」）。
 *   ④ 短周期轮询（默认 30s，可注入）替代裸 setTimeout：Node 定时器在系统休眠期间不推进，
 *      且单次 setTimeout 上限约 24.8 天会静默溢出。任何单次定时器都 clamp ≤ 1 小时。
 *
 * 可测性：本文件**能被纯 node 直接 require 而不炸**（顶部不 require('electron')，
 * 全部依赖注入 + lazy require + try/catch）。导出 createScheduler(deps) 与若干纯函数。
 *
 * @module automations
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================================
// 常量
// ============================================================================

/** 数据文件版本。 */
const FILE_VERSION = 1;
/** items 数量上限（防无限增长）。 */
const MAX_ITEMS = 50;
/** runs 条数上限（照 backend.js TASK_MAX_RECORDS 先例）。 */
const MAX_RUNS = 500;
/** runs 保留时长上限：180 天。与 MAX_RUNS 取小者生效。 */
const RUNS_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** 默认轮询周期（毫秒）。 */
const DEFAULT_INTERVAL_MS = 30000;
/** 单次定时器上限：1 小时（防休眠不推进 / 24.8 天溢出）。 */
const MAX_TIMER_MS = 60 * 60 * 1000;
/** 单次对账最多枚举的漏跑次数（防极端时钟跳变把 CPU 打死）。 */
const MAX_CATCHUP_ENUM = 1000;
/** 失败自动重试封顶（坏任务不能变成 token 黑洞）。 */
const MAX_RETRY = 1;

/** 合法频次。 */
const FREQS = new Set(['daily', 'weekly', 'monthly']);

/**
 * 需要用户确认的危险技能（与 backend.js CONFIRM_TOOLS 同源，仅用于 UI 提示）。
 * 无人值守下这些技能会被后端跳过并如实标记，**定时任务不适合**调度它们。
 *
 * 【0.21.10】从 4 个扩到 9 个：backend.js 的确认集已改为**按可逆性三档分级派生**
 * （auto / confirm / always），集合相应变大。本文件不 require backend（要能纯 node 直接
 * require、不起后端），所以只能硬编码 —— 于是**必须有门禁钉死同源**：
 * `unit-confirm-gate` 的 A6 会直接断言 `CONFIRM_TOOL_IDS` 与本文件的 `CONFIRM_TOOLS`
 * 集合相等，任一边改了另一边没跟上就红。别只改这里。
 */
const CONFIRM_TOOL_IDS = Object.freeze([
  // always：每次都问、且不给「不再询问」
  'ssh-exec', 'db-query',
  // confirm：一次确认、同目标可记住
  'deploy-static', 'deploy-node', 'wechat-api', 'shop-order', 'mmm-shop-order',
  // 一技多能：按 action 细分（list 只读不弹、delete 必须弹）
  'geo-company-register', 'geo-account-detect',
  // agent-delegate（2026-11-11 加入）：confirm。
  // 它在这一份清单里的意义比在 backend.js 那份里更硬 —— 本清单服务的是
  // 「**无人值守**下跳过并如实标记」，而委派恰恰是"把方向盘交给另一个 agent"：
  // 定时任务在半夜触发一次 15 分钟、默认 deepseek-v4-pro + effort=high 的自主改盘，
  // 用户第二天只看到工作区变了却没有人工确认点。判定依据与失效方向
  // 见 backend.js 的 AUTH_TIER_BY_TOOL 与 unit-confirm-gate 的 TIER_WHITELIST。
  'agent-delegate',
]);

/** 终态 reason → 人类可读文案（通知正文/UI 复用）。 */
const REASON_LABEL = Object.freeze({
  app_not_running: '到点时应用没在运行（漏跑）',
  resident_disabled: '你关闭了「后台常驻」，没人值守',
  user_quit: '上次你退出应用时正跑到一半',
  concurrency_lock: '上一个定时任务还在跑，本次让位',
  clock_rollback: '系统时钟往回跳了，等时钟追上再跑',
});

// ============================================================================
// 小工具
// ============================================================================

/** 错误对象 → 短字符串。 */
function errMsg(e) {
  if (!e) return '未知错误';
  return String((e && e.message) || e);
}

/** 截断字符串到 n 个字符（超长加省略号）。 */
function clipStr(s, n) {
  const str = s == null ? '' : String(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + '…';
}

/** 夹取整数到 [lo, hi]，非数/非法回落 dflt。 */
function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  const i = Math.trunc(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

/** ISO 星期（周一=1 … 周日=7）。JS getDay() 是 周日=0。 */
function isoWeekday(date) {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

/** 某年某月的天数（month 为 0-based）。 */
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/** 生成任务/运行 id。 */
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ============================================================================
// 调度计算（纯函数，供单测直接断言）
// ============================================================================

/**
 * 归一化 schedule 结构体（不使用 RRULE / cron 字符串）。
 * @param {object} schedule {freq,hour,minute,byDay,byMonthDay}
 * @returns {{freq:string,hour:number,minute:number,byDay:number[],byMonthDay:number}}
 */
function normalizeSchedule(schedule) {
  const s = schedule && typeof schedule === 'object' ? schedule : {};
  const freq = FREQS.has(s.freq) ? s.freq : 'daily';
  const hour = clampInt(s.hour, 0, 23, 9);
  const minute = clampInt(s.minute, 0, 59, 0);
  let byDay = Array.isArray(s.byDay)
    ? s.byDay.map((x) => clampInt(x, 1, 7, 0)).filter((x) => x >= 1 && x <= 7)
    : [];
  byDay = Array.from(new Set(byDay)).sort((a, b) => a - b);
  if (freq === 'weekly' && byDay.length === 0) byDay = [1]; // 默认周一
  const byMonthDay = clampInt(s.byMonthDay, 1, 31, 1);
  return { freq, hour, minute, byDay, byMonthDay };
}

/**
 * 判断某个具体日期是否命中 schedule 的「日」条件。
 * @param {object} s 归一化后的 schedule
 * @param {Date} date
 * @returns {boolean}
 */
function dayMatches(s, date) {
  if (s.freq === 'weekly') {
    return s.byDay.includes(isoWeekday(date));
  }
  if (s.freq === 'monthly') {
    const last = daysInMonth(date.getFullYear(), date.getMonth());
    const target = Math.min(s.byMonthDay, last);
    return date.getDate() === target;
  }
  // daily：byDay 非空时作为可选「仅这些天」过滤器（全 7 天等价于每天）
  if (s.byDay.length > 0 && s.byDay.length < 7) {
    return s.byDay.includes(isoWeekday(date));
  }
  return true;
}

/**
 * 计算「严格晚于 fromTs」的下一个触发时刻（本地时区）。
 * daily：每天 hour:minute（可选 byDay 过滤）；weekly：byDay 指定星期；monthly：byMonthDay（超出当月天数则取当月最后一天）。
 * @param {object} schedule
 * @param {number} fromTs 起算时间戳（毫秒）
 * @returns {number} 下一个触发时间戳；找不到返回 0
 */
function computeNextRun(schedule, fromTs) {
  const s = normalizeSchedule(schedule);
  const from = typeof fromTs === 'number' && isFinite(fromTs) ? fromTs : Date.now();
  const base = new Date(from);
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  for (let i = 0; i <= 400; i++) {
    const cand = new Date(y, m, d + i, s.hour, s.minute, 0, 0);
    const ts = cand.getTime();
    if (ts <= from) continue;
    if (!dayMatches(s, cand)) continue;
    return ts;
  }
  return 0;
}

/**
 * item 是否到达触发点（每轮现算 now 与 nextRunAt）。
 * @param {object} item
 * @param {number} nowTs
 * @returns {boolean}
 */
function isDue(item, nowTs) {
  if (!item || item.enabled === false) return false;
  const next = Number(item.nextRunAt) || 0;
  if (next <= 0) return false;
  return Number(nowTs) >= next;
}

/**
 * 启动对账：算出「该跑哪些」。返回计划，不改状态（纯函数）。
 * - due=false：未到点。
 * - 到点：枚举 nextRunAt..nowTs 之间所有触发点；最近一次 = 补跑目标，更早的 = missed。
 * @param {object} item
 * @param {number} nowTs
 * @param {object} [opts] {maxAgeMs}: 补跑时效（0/不传 = 不限）
 * @returns {{due:boolean, occurrences:number[], missList:number[], catchUpScheduledAt:number, advanceTo:number}}
 */
function decideCatchUp(item, nowTs, opts = {}) {
  const out = { due: false, occurrences: [], missList: [], catchUpScheduledAt: 0, advanceTo: 0 };
  if (!item) return out;
  const next = Number(item.nextRunAt) || 0;
  if (next <= 0) return out;
  if (Number(nowTs) < next) return out;
  out.due = true;

  const schedule = normalizeSchedule(item.schedule);
  const occ = [];
  let t = next;
  while (t <= Number(nowTs) && occ.length < MAX_CATCHUP_ENUM) {
    occ.push(t);
    const nxt = computeNextRun(schedule, t);
    if (!nxt || nxt <= t) break;
    t = nxt;
  }
  out.occurrences = occ;
  if (occ.length === 0) { out.due = false; return out; }

  const latest = occ[occ.length - 1];
  const earlier = occ.slice(0, -1);
  const maxAge = Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : 0;
  const withinAge = maxAge === 0 ? true : (Number(nowTs) - latest) <= maxAge;
  if (withinAge) {
    out.catchUpScheduledAt = latest; // 只补最近一次
    out.missList = earlier;          // 更早的直接记 missed
  } else {
    out.catchUpScheduledAt = 0;
    out.missList = occ;              // 太旧，全部记 missed，不补跑
  }
  out.advanceTo = computeNextRun(schedule, latest);
  return out;
}

// ============================================================================
// payload / 工具表 构造（与 renderer App.jsx buildTools() 完全同形状）
// ============================================================================

/**
 * 从 /api/skills 返回的技能数组构造 OpenAI 工具表。
 *
 * ★ 真源是 src/shared/toolSchema.js（主窗 App.jsx 与桌宠 renderer-pet/App.jsx 共用）。
 *   本函数是它在**主进程**的等价副本 —— 因为主进程是 CJS（'use strict' + require）、
 *   而真源是 ESM（export function），CJS 里同步 require 不了 ESM，
 *   而 getTools 是同步回调、主进程又至今没有任何 import() 通路。
 *   权衡过三条路：① 主进程改用 import()（在出厂 Electron 主进程里新开 ESM 通路，
 *   失败即静默退化成空工具表，风险高于收益）② 真源改写成 CJS 让渲染层吃 interop
 *   （动的是构建产物形状，同样不安全）③ 保留副本 + 用**行为级对拍门禁**焊死漂移 —— 选 ③。
 *
 * ★ 为什么必须对拍：2026-10-21 体检发现这份副本一直硬编码 `required: []`，
 *   而真源自 2026-09-16 起就已透传 manifest 的 params[].required。
 *   同一个病历史上出现过三次：主窗（已修）→ 桌宠（漏了）→ 这里（又漏）。
 *   「两份实现 = 迟早漂移」，既然格式上无法合并，就由
 *   scripts/smoke/unit-tool-schema-parity.mjs 对两份实现做 deepStrictEqual 对拍，
 *   任何一边单独改动都会立刻转红。
 *
 * 与真源逐字对齐的三条语义（改这里必须同步改真源，且对拍门禁会盯着）：
 *   ① required 只做透传：params[].required === true 才算必填，不自行发明；
 *   ② additionalProperties: false，不许模型塞 schema 没声明的字段；
 *   ③ 参数形状提示写进 description（纯文字，不改 JSON 类型 —— 见真源头部取舍说明）。
 *
 * @param {Array} skills 来自后端 /api/skills 的清单（每项含 id/description/params）
 * @returns {Array} OpenAI function 工具表；非数组/空数组 ⇒ []
 */
function buildToolsFromSkills(skills) {
  if (!Array.isArray(skills) || !skills.length) return [];
  return skills.map((s) => ({
    type: 'function',
    function: {
      name: s.id,
      description: s.description || s.name,
      parameters: buildToolParametersLocal(s),
    },
  }));
}

/** 参数形状提示（纯文字）—— 与 src/shared/toolSchema.js::paramShapeNote 逐字一致。 */
function paramShapeNoteLocal(name) {
  const n = String(name || '');
  if (/_ms$/.test(n)) return '数字（毫秒）';
  if (n === 'screenshot') return 'true / false';
  if (n === 'actions') return 'JSON 数组字符串';
  if (n === 'mode') return 'overwrite 或 append';
  return '';
}

/** 单参数 description —— 与 src/shared/toolSchema.js::paramDescription 逐字一致。 */
function paramDescriptionLocal(p) {
  const label = (p && (p.label || p.name || p.key)) || '';
  const shape = paramShapeNoteLocal(p && (p.name || p.key));
  const parts = [label];
  if (shape) parts.push('（' + shape + '）');
  if (p && p.hint) parts.push('（' + p.hint + '）');
  return parts.filter(Boolean).join('');
}

/** parameters 对象 —— 与 src/shared/toolSchema.js::buildToolParameters 逐字一致。 */
function buildToolParametersLocal(skill) {
  const ps = (skill && skill.params) || [];
  const properties = {};
  for (const p of ps) {
    const key = p && (p.name || p.key);
    if (!key) continue;
    properties[key] = { type: 'string', description: paramDescriptionLocal(p) };
  }
  return {
    type: 'object',
    properties,
    // 真源唯一：manifest 的 params[].required。这里只过滤透传，不自行发明必填项。
    required: ps.filter((p) => p && p.required === true).map((p) => p.name || p.key).filter(Boolean),
    // 不许模型塞 schema 里没声明的字段
    additionalProperties: false,
  };
}

/**
 * 组装发给 POST /api/chat 的 payload。
 * @param {object} item 定时任务
 * @param {string} taskId 每次触发唯一（防 runningTasks 覆盖写）
 * @param {number} scheduledAt
 * @param {Array} tools
 * @returns {object}
 */
function buildChatPayload(item, taskId, scheduledAt, tools) {
  const ctx = item.context || {};
  const ctxText = [
    '【定时任务上下文】',
    `- 任务名：${item.name || item.id}`,
    ctx.companyName ? `- 企业：${ctx.companyName}${ctx.companyId ? '（' + ctx.companyId + '）' : ''}` : '',
    ctx.brand ? `- 品牌：${ctx.brand}` : '',
    ctx.username ? `- 归属账号：${ctx.username}` : '',
    `- 触发方式：定时任务（计划时刻 ${new Date(scheduledAt).toLocaleString()}）`,
    '- 说明：这是无人值守自动执行，若遇需用户确认的操作会被跳过并如实记账。',
  ].filter(Boolean).join('\n');

  return {
    messages: [{ role: 'user', content: `【定时任务·${item.name || item.id}】` + String(item.prompt || '') }],
    taskId,
    username: ctx.username || '',
    tools: Array.isArray(tools) ? tools : [],
    unattended: true, // 无人值守：闸门不白等 300s，跳过并如实标记
    enableSearch: false,
    context: {
      text: ctxText,
      companyId: ctx.companyId || '',
      companyName: ctx.companyName || '',
      brand: ctx.brand || '',
      automationId: item.id,
      scheduledAt,
    },
  };
}

// ============================================================================
// 执行通道：回环 HTTP 自调用（POST /api/chat，读 SSE 到结束）
// ============================================================================

/** 把 SSE 文本解析成事件对象数组（忽略 [DONE] / 解析失败的块）。 */
function parseSse(text) {
  const out = [];
  const blocks = String(text || '').split(/\n\n+/);
  for (const block of blocks) {
    let dataLine = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) { dataLine = line.slice(5); break; }
    }
    const raw = dataLine.trim();
    if (!raw || raw === '[DONE]') continue;
    try { out.push(JSON.parse(raw)); } catch { /* 忽略半截块 */ }
  }
  return out;
}

/**
 * 构造 post(payload) => Promise<{ok,status,artifacts,tokensUsed,text,error}>。
 * @param {object} [opts] {baseURL, fetchImpl, logger}
 * @returns {(payload:object)=>Promise<object>}
 */
function createHttpPost(opts = {}) {
  const baseURL = String(opts.baseURL || 'http://127.0.0.1:10119').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return async function post(payload) {
    const out = { ok: false, status: 0, artifacts: [], tokensUsed: 0, text: '', error: '' };
    if (!fetchImpl) { out.error = '当前环境没有可用的 fetch'; return out; }
    let resp;
    try {
      resp = await fetchImpl(baseURL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    } catch (e) {
      out.error = '请求执行通道失败：' + errMsg(e);
      return out;
    }
    out.status = resp && resp.status ? resp.status : 0;
    if (!resp || resp.ok !== true) {
      let body = '';
      try { body = await resp.text(); } catch { /* ignore */ }
      out.error = '执行通道返回 HTTP ' + out.status + (body ? '：' + clipStr(body, 200) : '');
      return out;
    }
    let raw = '';
    try { raw = await resp.text(); } catch (e) {
      out.error = '读取执行结果失败：' + errMsg(e);
      return out;
    }
    const events = parseSse(raw);
    let text = '';
    let err = '';
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.error) err = String(ev.error);
      if (ev.type === 'deliverables' && Array.isArray(ev.items)) {
        for (const it of ev.items) {
          if (it && it.path) out.artifacts.push({ path: String(it.path), name: String(it.name || '') });
        }
      }
      if (Array.isArray(ev.choices)) {
        for (const ch of ev.choices) {
          const delta = ch && ch.delta;
          if (delta && typeof delta.content === 'string') text += delta.content;
        }
      }
      if (ev.type === 'phase' && ev.phase === 'done') { /* 收尾信号，无需额外动作 */ }
    }
    out.text = text;
    if (err) { out.error = err; out.ok = false; }
    else out.ok = true;
    return out;
  };
}

// ============================================================================
// 通知文案（纯函数，供单测直接断言「跑完但没产出」的诚实措辞）
// ============================================================================

/**
 * 构造某次运行的通知文案。**诚实红线**：`ran` 但 artifacts 为空时，
 * 文案必须说「跑完了但没产出文件」，绝不许说「已完成」。
 * @param {object} item
 * @param {object} run
 * @returns {{title:string, body:string}}
 */
function buildNotifyText(item, run) {
  const name = (item && (item.name || item.id)) || '定时任务';
  const r = run || {};
  if (r.status === 'ran') {
    const arts = Array.isArray(r.artifacts) ? r.artifacts : [];
    if (arts.length > 0) {
      const names = arts.slice(0, 3).map((a) => (a && (a.name || a.path)) || '').filter(Boolean).join('、');
      return { title: `「${name}」已完成`, body: `产出 ${arts.length} 个文件：${names}` };
    }
    // 跑完 ≠ 跑成：无产出时必须如实说「没产出」
    return { title: `「${name}」跑完了`, body: `已按计划执行，但这次没产出文件（结果已记入执行台账）。` };
  }
  if (r.status === 'failed') {
    return { title: `「${name}」执行失败`, body: `原因：${r.reason || '未知错误'}` };
  }
  if (r.status === 'skipped') {
    return { title: `「${name}」已跳过`, body: `原因：${REASON_LABEL[r.reason] || r.reason || '未知'}` };
  }
  if (r.status === 'missed') {
    return { title: `「${name}」漏跑`, body: `原因：${REASON_LABEL[r.reason] || r.reason || '未知'}（已记入台账，未执行）` };
  }
  return { title: `「${name}」${r.status || '状态未知'}`, body: r.reason || '' };
}

// ============================================================================
// 调度器
// ============================================================================

/**
 * @typedef {object} SchedulerDeps
 * @property {string} dataDir      必填：automations.json 所在目录（生产传 app.getPath('userData')）
 * @property {()=>number} [now]    时钟（可注入假时钟）
 * @property {(payload:object)=>Promise<object>} [post] 执行通道
 * @property {()=>Promise<Array>} [getTools] 取技能表
 * @property {(title:string, body:string, opts?:object)=>{ok:boolean,error?:string}} [notify] 系统通知
 * @property {()=>object} [readResidentSettings] 读常驻设置（closeToTray）
 * @property {number} [intervalMs] 轮询周期
 * @property {Function} [setInterval]/[clearInterval]/[setTimeout]/[clearTimeout] 定时器（可注入以单测）
 * @property {object} [logger]
 */

/**
 * 创建调度器。全部依赖注入 —— 纯 node 可 require、可单测。
 * @param {SchedulerDeps} deps
 * @returns {object} scheduler
 */
function createScheduler(deps = {}) {
  const dataDir = deps.dataDir;
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('[automations] createScheduler 需要 dataDir（禁止硬编码路径）');
  }
  const filePath = path.join(dataDir, 'automations.json');

  const logger = deps.logger || console;
  const postFn = typeof deps.post === 'function' ? deps.post : null;
  const getToolsFn = typeof deps.getTools === 'function' ? deps.getTools : null;
  const notifyFn = typeof deps.notify === 'function' ? deps.notify : () => ({ ok: true });
  const readResidentSettingsFn = typeof deps.readResidentSettings === 'function'
    ? deps.readResidentSettings
    : () => ({ closeToTray: true });
  const intervalMs = clampInt(deps.intervalMs, 1000, MAX_TIMER_MS, DEFAULT_INTERVAL_MS);
  const catchUpMaxAgeMs = Number(deps.catchUpMaxAgeMs) > 0 ? Number(deps.catchUpMaxAgeMs) : 0;
  const setIntervalFn = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
  const clearIntervalFn = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval;

  // 统计（供测试自证「注入的假时钟/假 post 真的生效」）
  const stats = { nowCalls: 0, ticks: 0, fires: 0, notifications: 0 };

  const rawNow = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const now = () => { stats.nowCalls += 1; return Number(rawNow()); };

  let store = { version: FILE_VERSION, items: [], runs: [], lifecycle: { lastShutdown: '', lastShutdownAt: 0 } };
  let timer = null;
  let busy = false;          // 全局执行锁（同一时刻只跑一个任务）
  let appStartedAt = 0;
  let started = false;

  // ---- 持久化 ----

  function ensureDir() {
    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    } catch (e) {
      logger.error && logger.error('[automations] 建目录失败:', errMsg(e));
    }
  }

  function normalizeRun(r) {
    if (!r || typeof r !== 'object') return null;
    return {
      runId: String(r.runId || ''),
      automationId: String(r.automationId || ''),
      scheduledAt: Number(r.scheduledAt) || 0,
      startedAt: Number(r.startedAt) || 0,
      endedAt: Number(r.endedAt) || 0,
      durationMs: Number(r.durationMs) || 0,
      status: String(r.status || 'running'),
      reason: String(r.reason || ''),
      taskId: String(r.taskId || ''),
      artifacts: Array.isArray(r.artifacts)
        ? r.artifacts.map((a) => ({ path: String((a && a.path) || ''), name: String((a && a.name) || '') })).filter((a) => a.path)
        : [],
      tokensUsed: Number(r.tokensUsed) || 0,
      summaryShort: String(r.summaryShort || ''),
      catchUpOf: Number(r.catchUpOf) || 0,
    };
  }

  function normalizeItem(it) {
    if (!it || typeof it !== 'object') return null;
    const schedule = normalizeSchedule(it.schedule);
    const ctx = it.context && typeof it.context === 'object' ? it.context : {};
    return {
      id: String(it.id || genId('auto')),
      name: clipStr(it.name || '未命名定时任务', 60) || '未命名定时任务',
      enabled: it.enabled !== false,
      schedule,
      prompt: String(it.prompt || ''),
      context: {
        username: String(ctx.username || ''),
        companyId: String(ctx.companyId || ''),
        companyName: String(ctx.companyName || ''),
        brand: String(ctx.brand || ''),
      },
      limits: { maxTurnsPerRun: clampInt(it.limits && it.limits.maxTurnsPerRun, 1, 48, 12) },
      createdAt: Number(it.createdAt) || 0,
      updatedAt: Number(it.updatedAt) || 0,
      nextRunAt: Number(it.nextRunAt) || 0,
      lastRunAt: Number(it.lastRunAt) || 0,
      cursorFiredAt: Number(it.cursorFiredAt) || 0,
    };
  }

  function readStore() {
    let disk = null;
    try {
      if (fs.existsSync(filePath)) {
        disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (e) {
      logger.error && logger.error('[automations] 读取 automations.json 失败（回落空表）:', errMsg(e));
      disk = null;
    }
    const root = disk && typeof disk === 'object' ? disk : {};
    const items = Array.isArray(root.items) ? root.items.map(normalizeItem).filter(Boolean) : [];
    const runs = Array.isArray(root.runs) ? root.runs.map(normalizeRun).filter(Boolean) : [];
    const life = root.lifecycle && typeof root.lifecycle === 'object' ? root.lifecycle : {};
    return {
      version: FILE_VERSION,
      items: items.slice(-MAX_ITEMS),
      runs,
      lifecycle: {
        lastShutdown: String(life.lastShutdown || ''),
        lastShutdownAt: Number(life.lastShutdownAt) || 0,
      },
    };
  }

  /** 裁剪 runs：≤180 天 且 ≤MAX_RUNS 条（取小者）。 */
  function trimRuns(runs) {
    const cutoff = now() - RUNS_MAX_AGE_MS;
    const kept = runs.filter((r) => {
      const t = Number(r.scheduledAt) || Number(r.startedAt) || 0;
      return t >= cutoff;
    });
    return kept.slice(-MAX_RUNS);
  }

  function writeStore() {
    ensureDir();
    store.runs = trimRuns(store.runs);
    const out = {
      version: FILE_VERSION,
      items: store.items,
      runs: store.runs,
      lifecycle: store.lifecycle,
    };
    try {
      fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
    } catch (e) {
      logger.error && logger.error('[automations] 写 automations.json 失败:', errMsg(e));
    }
  }

  // ---- 台账 ----

  function newRunRecord(item, scheduledAt) {
    const ts = now();
    return {
      runId: `auto_${item.id}_${scheduledAt}`,
      automationId: item.id,
      scheduledAt,
      startedAt: ts,
      endedAt: 0,
      durationMs: 0,
      status: 'running',
      reason: '',
      taskId: `auto_${item.id}_${scheduledAt}`,
      artifacts: [],
      tokensUsed: 0,
      summaryShort: '',
      catchUpOf: 0,
    };
  }

  function upsertRun(run) {
    const i = store.runs.findIndex((r) => r.runId === run.runId);
    if (i >= 0) store.runs[i] = run;
    else store.runs.push(run);
  }

  function notifyRun(item, run) {
    const { title, body } = buildNotifyText(item, run);
    try {
      const r = notifyFn(title, body, { automationId: item.id, runId: run.runId, status: run.status });
      stats.notifications += 1;
      if (r && r.ok === false) {
        // 降级不静默：照 main.js sendSystemNotification 的既定契约
        logger.error && logger.error('[automations] 系统通知降级（ok:false）:', r.error || '未知');
      }
      return r;
    } catch (e) {
      logger.error && logger.error('[automations] 通知异常:', errMsg(e));
      return { ok: false, error: errMsg(e) };
    }
  }

  /** 结算一条 run：落库 + 通知。 */
  function finalizeRun(item, run) {
    upsertRun(run);
    item.updatedAt = now();
    try { writeStore(); } catch (e) { logger.error && logger.error('[automations] 落库失败:', errMsg(e)); }
    notifyRun(item, run);
    return run;
  }

  /** 结算水位：前移 cursorFiredAt / nextRunAt，防「每次启动都把同一次当漏跑」反复补跑。 */
  function settleOccurrence(item, settledAt) {
    item.cursorFiredAt = settledAt;                                  // [CURSOR-ADVANCE]
    item.nextRunAt = computeNextRun(item.schedule, settledAt);       // 水位前移，防重复补跑
    item.updatedAt = now();
  }

  function residentEnabled() {
    try {
      const s = readResidentSettingsFn() || {};
      return s.closeToTray !== false;
    } catch {
      return true; // 读不到按开启处理（宁可跑，也不因一个坏文件永久不跑）
    }
  }

  // ---- 执行 ----

  /**
   * 执行一次触发。
   * @param {object} item
   * @param {number} scheduledAt
   * @param {{catchUpOf?:number, manual?:boolean}} [opts]
   */
  async function executeOccurrence(item, scheduledAt, opts = {}) {
    const run = newRunRecord(item, scheduledAt);
    run.catchUpOf = Number(opts.catchUpOf) || 0;

    // 并发锁：同一时刻只跑一个任务（LLM 无并发上限 + 成果/token 落盘是 read-modify-write 无锁）
    if (busy) {
      run.status = 'skipped';
      run.reason = 'concurrency_lock';
      run.endedAt = now();
      run.durationMs = 0;
      return finalizeRun(item, run);
    }
    // 常驻检查：用户关了常驻 ⇒ 无人值守根本不会存活，如实跳过（手动「立即跑一次」不拦）
    if (!opts.manual && !residentEnabled()) {
      run.status = 'skipped';
      run.reason = 'resident_disabled';
      run.endedAt = now();
      run.durationMs = 0;
      return finalizeRun(item, run);
    }

    busy = true;
    try {
      // [LEDGER-BEFORE-RUN] 先写台账、再执行：进程执行中崩掉，重启后能看见一条悬挂 running（可观测的失败）。
      store.runs.push(run);
      writeStore();
      stats.fires += 1;

      let result = null;
      try {
        const tools = getToolsFn ? await getToolsFn() : [];
        if (!postFn) throw new Error('未配置执行通道（post）');
        result = await postFn(buildChatPayload(item, run.taskId, scheduledAt, tools));
      } catch (e) {
        result = { ok: false, error: errMsg(e), artifacts: [], tokensUsed: 0, text: '' };
      }
      result = result || { ok: false, error: '执行通道无返回', artifacts: [], tokensUsed: 0, text: '' };

      // 失败自动重试（封顶 MAX_RETRY）—— 换一个唯一 taskId，避免覆盖进行中状态
      let attempt = 0;
      while (!result.ok && attempt < MAX_RETRY) {
        attempt += 1;
        try {
          const tools2 = getToolsFn ? await getToolsFn() : [];
          result = await postFn(buildChatPayload(item, run.taskId + '_r' + attempt, scheduledAt, tools2));
        } catch (e) {
          result = { ok: false, error: errMsg(e), artifacts: [], tokensUsed: 0, text: '' };
        }
        result = result || { ok: false, error: '执行通道无返回', artifacts: [], tokensUsed: 0, text: '' };
      }

      const endTs = now();
      run.endedAt = endTs;
      run.durationMs = Math.max(0, endTs - run.startedAt);
      run.tokensUsed = Number(result.tokensUsed) || 0;
      run.artifacts = Array.isArray(result.artifacts)
        ? result.artifacts.map((a) => ({ path: String((a && a.path) || ''), name: String((a && a.name) || '') })).filter((a) => a.path)
        : [];
      if (result.ok) {
        run.status = 'ran';
        run.reason = '';
        run.summaryShort = clipStr(result.text || '', 200);
      } else {
        run.status = 'failed';
        run.reason = clipStr(result.error || '执行失败', 200);
      }
      item.lastRunAt = endTs;
    } catch (e) {
      // 兜底：绝不让异常吞掉台账
      run.status = 'failed';
      run.reason = clipStr(errMsg(e), 200);
      run.endedAt = now();
      run.durationMs = Math.max(0, run.endedAt - run.startedAt);
    } finally {
      busy = false;
    }

    return finalizeRun(item, run);
  }

  /**
   * 对账单个 item：到点则处理（更早的记 missed，最近一次执行）。
   * @param {object} item
   * @returns {Promise<Array>} 本次产生的 run
   */
  async function reconcileItem(item) {
    if (!item || item.enabled === false) return [];
    const n = now();
    if (Number(item.nextRunAt) <= 0) return [];
    if (n < Number(item.nextRunAt)) return [];

    // 时钟回拨：now < lastRunAt ⇒ 不触发，记一条带 reason 的异常，等时钟追上
    if (Number(item.lastRunAt) > 0 && n < Number(item.lastRunAt)) {
      const run = newRunRecord(item, item.nextRunAt);
      run.status = 'skipped';
      run.reason = 'clock_rollback';
      run.startedAt = n;
      run.endedAt = n;
      run.durationMs = 0;
      finalizeRun(item, run);
      return [run];
    }

    const plan = decideCatchUp(item, n, { maxAgeMs: catchUpMaxAgeMs });
    if (!plan.due || plan.occurrences.length === 0) return [];

    const produced = [];
    // 更早的：直接记 missed（诚实：这些没跑）
    for (const s of plan.missList) {
      const run = newRunRecord(item, s);
      run.status = 'missed';
      run.reason = 'app_not_running';
      run.startedAt = 0;
      run.endedAt = n;
      run.durationMs = 0;
      finalizeRun(item, run);
      produced.push(run);
    }

    // 最近一次：执行。「跑到很晚」（now - latest > 一个轮询周期）即视为补跑，记 catchUpOf。
    const latest = plan.occurrences[plan.occurrences.length - 1];
    const late = (n - latest) > intervalMs;
    const catchUpOf = late ? latest : 0;
    const executed = await executeOccurrence(item, latest, { catchUpOf, manual: false });
    produced.push(executed);

    // 结算水位
    settleOccurrence(item, latest);
    writeStore();
    return produced;
  }

  /** 轮询一次：把所有到点的 item 串行处理（同一时刻只跑一个）。 */
  async function tick() {
    stats.ticks += 1;
    const n = now();
    const due = store.items.filter((it) => isDue(it, n));
    for (const it of due) {
      try {
        await reconcileItem(it); // await ⇒ 串行（明确排队，绝不并发）
      } catch (e) {
        logger.error && logger.error('[automations] tick 处理失败:', errMsg(e));
      }
    }
    return due.length;
  }

  /**
   * 启动对账：① 悬挂 running 的善后（干净退出⇒user_quit）② 逐项补跑。
   */
  async function reconcile() {
    if (appStartedAt <= 0) appStartedAt = now();

    // ① 上次退出是否干净：clean ⇒ 把「退出时还在 running」的悬挂记为 skipped/user_quit
    const clean = store.lifecycle.lastShutdown === 'clean';
    for (const run of store.runs) {
      if (run.status === 'running') {
        if (clean) {
          run.status = 'skipped';
          run.reason = 'user_quit';
          run.endedAt = now();
          run.durationMs = Math.max(0, run.endedAt - run.startedAt);
          notifyRun({ id: run.automationId, name: (store.items.find((x) => x.id === run.automationId) || {}).name || run.automationId }, run);
        }
        // 非干净退出：**保持 running** —— 悬挂本身就是可观测的失败，绝不假装成「没到点、正常」。
      }
    }
    // 标记本次会话开始：若中途崩溃，lastShutdown 会停在 'running'
    store.lifecycle.lastShutdown = 'running';
    store.lifecycle.lastShutdownAt = now();

    // ② 逐项补跑（串行）
    for (const item of store.items) {
      try {
        await reconcileItem(item);
      } catch (e) {
        logger.error && logger.error('[automations] 启动对账失败:', errMsg(e));
      }
    }
    writeStore();
    return true;
  }

  // ---- 生命周期 ----

  /**
   * 启动调度器：先对账，再挂短周期轮询（默认 30s，clamp ≤ 1 小时）。
   * @returns {Promise<boolean>} 首次对账完成的 promise
   */
  function start() {
    if (started) return Promise.resolve(false);
    started = true;
    appStartedAt = now();
    const ready = reconcile().catch((e) => {
      logger.error && logger.error('[automations] 启动对账异常:', errMsg(e));
      return false;
    });
    // 短周期轮询：每次现算 now 与 nextRunAt，休眠/时钟跳变都能被对账逻辑兜住
    timer = setIntervalFn(() => { tick().catch(() => { /* 已在 tick 内记日志 */ }); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出（Electron 由窗口/托盘决定存活）
    return ready;
  }

  /** 停止轮询。 */
  function stop() {
    if (timer != null) {
      try { clearIntervalFn(timer); } catch { /* ignore */ }
      timer = null;
    }
    started = false;
  }

  /**
   * 干净退出标记（before-quit 调用）：下次启动据此把「退出时在跑的悬挂」判为 user_quit，
   * 而不是误判成漏跑（app_not_running）。
   */
  function markCleanQuit() {
    store.lifecycle.lastShutdown = 'clean';
    store.lifecycle.lastShutdownAt = now();
    writeStore();
    return true;
  }

  // ---- 数据 CRUD（IPC 用）----

  function cloneItem(it) { return JSON.parse(JSON.stringify(it)); }
  function cloneRun(r) { return JSON.parse(JSON.stringify(r)); }

  function listItems() {
    return store.items.map(cloneItem);
  }

  function createItem(input = {}) {
    const prompt = String(input.prompt || '').trim();
    if (!prompt) throw new Error('prompt 不能为空');
    const schedule = normalizeSchedule(input.schedule);
    if (store.items.length >= MAX_ITEMS) throw new Error('定时任务数量已达上限 ' + MAX_ITEMS);
    const ts = now();
    const item = normalizeItem({
      id: genId('auto'),
      name: input.name,
      enabled: input.enabled !== false,
      schedule,
      prompt,
      context: input.context,
      limits: input.limits,
      createdAt: ts,
      updatedAt: ts,
      nextRunAt: computeNextRun(schedule, ts),
      lastRunAt: 0,
      cursorFiredAt: 0,
    });
    store.items.push(item);
    writeStore();
    return cloneItem(item);
  }

  function updateItem(id, patch = {}) {
    const item = store.items.find((x) => x.id === id);
    if (!item) throw new Error('定时任务不存在: ' + id);
    const ts = now();
    const wasEnabled = item.enabled;
    if (patch.name != null) item.name = clipStr(patch.name, 60) || item.name;
    if (patch.prompt != null) {
      const p = String(patch.prompt).trim();
      if (p) item.prompt = p;
    }
    if (patch.context != null && typeof patch.context === 'object') {
      item.context = normalizeItem({ schedule: item.schedule, context: patch.context }).context;
    }
    if (patch.limits != null) {
      item.limits = { maxTurnsPerRun: clampInt(patch.limits.maxTurnsPerRun, 1, 48, item.limits.maxTurnsPerRun) };
    }
    let scheduleChanged = false;
    if (patch.schedule != null) {
      const next = normalizeSchedule(patch.schedule);
      scheduleChanged = JSON.stringify(next) !== JSON.stringify(item.schedule);
      item.schedule = next;
    }
    if (patch.enabled != null) item.enabled = patch.enabled !== false;
    // 频次变化 / 重新启用：从「现在」起重算下次触发（避免立即补跑一堆历史）
    if (scheduleChanged || (item.enabled && !wasEnabled)) {
      item.nextRunAt = computeNextRun(item.schedule, ts);
    }
    item.updatedAt = ts;
    writeStore();
    return cloneItem(item);
  }

  function removeItem(id) {
    const before = store.items.length;
    store.items = store.items.filter((x) => x.id !== id);
    if (store.items.length === before) return false;
    store.runs = store.runs.filter((r) => r.automationId !== id);
    writeStore();
    return true;
  }

  /** 立即跑一次（手动：不受常驻开关拦截，但仍受并发锁约束）。 */
  async function runNow(id) {
    const item = store.items.find((x) => x.id === id);
    if (!item) throw new Error('定时任务不存在: ' + id);
    return executeOccurrence(item, now(), { catchUpOf: 0, manual: true });
  }

  function listRuns(opts = {}) {
    const automationId = opts.automationId ? String(opts.automationId) : '';
    const limit = clampInt(opts.limit, 1, MAX_RUNS, 100);
    let list = store.runs.slice();
    if (automationId) list = list.filter((r) => r.automationId === automationId);
    list.sort((a, b) => (b.scheduledAt || b.startedAt || 0) - (a.scheduledAt || a.startedAt || 0));
    return list.slice(0, limit).map(cloneRun);
  }

  function getStats() { return { ...stats, intervalMs, busy, filePath }; }

  // 初始化：读盘
  store = readStore();

  return {
    // 生命周期
    start,
    stop,
    reconcile,
    tick,
    markCleanQuit,
    // 数据
    listItems,
    createItem,
    updateItem,
    removeItem,
    runNow,
    listRuns,
    // 诊断
    getStats,
    filePath,
    _internals: { readStore, writeStore, trimRuns, normalizeSchedule, decideCatchUp },
  };
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // 主入口
  createScheduler,
  createHttpPost,
  buildToolsFromSkills,
  buildChatPayload,
  buildNotifyText,
  // 纯函数（供单测直接调）
  computeNextRun,
  isDue,
  decideCatchUp,
  normalizeSchedule,
  dayMatches,
  isoWeekday,
  parseSse,
  // 常量
  MAX_ITEMS,
  MAX_RUNS,
  RUNS_MAX_AGE_MS,
  DEFAULT_INTERVAL_MS,
  MAX_TIMER_MS,
  MAX_RETRY,
  REASON_LABEL,
  CONFIRM_TOOL_IDS,
};
