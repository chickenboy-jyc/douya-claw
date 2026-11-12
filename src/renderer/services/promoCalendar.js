/**
 * promoCalendar —— 「活动档期（促销日历）」事实层：读已录入档期 + 判状态 + 找重叠 + 拼给 AI 的事实文本。
 *
 * ── 它补的是哪个洞（2026-10-11 第 5 层第 4 步）────────────────────────────────
 * 「活动策划」此前只能拿到企业画像 / 目标 / 已排方案，**读不到真实的促销档期**。
 * 于是老板说「帮我做下周的活动方案」时，模型不知道下周正在跑什么、也不知道哪些活动在同期重叠，
 * 只能泛泛而谈 —— 这正是「公司资料进了上下文，但业务事实没进」的最后一截。
 *
 * ── 性质（与 planBrief / companyTimeline / companyGoal 完全对称）───────────────
 * 纯常量 + 纯函数（不 import React / store / .jsx），仅在文件底部提供 localStorage **读写**边界。
 * **读**：`loadPromoRecords`；**写**：`savePromoRecords`（唯一写入口，只由 UI 显式调用）。
 * （2026-10-11 补写能力：此前本文件只读 ⇒ 应用里**根本没有正规的档期录入路径**，
 *   档期只能靠手写 localStorage / 改种子塞进去 —— 这正是「假档期写进 store 遮蔽真源」的入口。）
 * 依赖方向：promoCalendar → data/promoCalendarSeed（数据）。**不反向**、不依赖 companyContext
 * （否则 companyContext ↔ promoCalendar 成环）。
 *
 * ── 三条红线（老板 2026-10-11 明确要求，实现自检点）────────────────────────────
 * 【红线 1｜只提醒不裁决】`findOverlaps` 只输出「谁和谁重叠几天」，
 *   绝不排序、绝不推荐优先级、绝不建议合并/叠加/错开 —— 那是业务方的决定，需要真实优先规则。
 * 【红线 2｜不编造规则】适用条件 / 券面规则**没有记录就是没有**：`buildPromoContext`
 *   不得把它解释成任何具体规则（例：不得把名称里的「999-50」写成「满 999 减 50」）。
 * 【红线 3｜原文不改】名称一律照录入原文输出；`verify='pending'` 的只加「待核实」标记，
 *   **不改写名称**（老板：「不要为了把名字统一得漂亮，擅自修改还没确认的业务信息」）。
 *
 * ── 判定口径 ────────────────────────────────────────────────────────────────
 * 「今天」按**本地时区**取（与 planBrief 同口径；本产品部署在国内，本地即 UTC+8）。
 * `now` 可注入 ⇒ 单测用冻结时钟复现任意日期，不需要等到那一天。
 */

import {
  PROMO_SEED,
  PROMO_SEED_ALIASES,
  PROMO_SEED_TYPE_BASIS,
} from '../data/promoCalendarSeed.js';

/**
 * 「已录入档期」的 localStorage key（形如 `{ [companyId]: { records: [...] } }`）。
 * 读：`loadPromoRecords`；写：`savePromoRecords`（唯一写入口，只由 UI 显式调用）。
 */
export const PROMO_KEY = 'douya-promo-calendar';

/** 企业主数据 key（= companyStore.COMPANIES_KEY）——仅用于把 companyId 换成名字做种子匹配。 */
const COMPANIES_KEY = 'douya-companies';

/** 档期种类。 */
export const PROMO_KIND = {
  /** 一次性档期（有明确起止日期）。 */
  CAMPAIGN: 'campaign',
  /** 周期活动（每周固定，如「每周一 植体DAY」）——老板要求：按周期规则存，不存某个月的具体日期。 */
  RECURRING: 'recurring',
};

/** 核实状态。 */
export const PROMO_VERIFY = { USER: 'user', PENDING: 'pending' };

/** 「即将开始 / 尚未开始」的分界：距开始 ≤ 该天数算「即将开始」。 */
export const SOON_DAYS = 7;

/** 状态键 → 中文标签。 */
export const STATUS_LABEL = {
  ended: '已结束',
  ongoing: '进行中',
  upcoming: '即将开始',
  future: '尚未开始',
  recurring: '周期活动',
  invalid: '日期无效',
};

/** 星期中文（ISO：1=周一 … 7=周日）。 */
const WEEKDAY_CN = ['', '一', '二', '三', '四', '五', '六', '日'];

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** localStorage 只读边界（非浏览器 / 被禁用返回 null）。 */
function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

/** Date → 'YYYY-MM-DD'（本地时区）。 */
function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 规整 now（Date / number / 字符串）；非法或缺失回落到当前时间。 */
function resolveNow(now) {
  if (now instanceof Date) return Number.isNaN(now.getTime()) ? new Date() : now;
  if (typeof now === 'number' || typeof now === 'string') {
    const d = new Date(now);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  return new Date();
}

/** 严格校验 'YYYY-MM-DD'（同时排除 2026-13-45 这类不存在的日期）。 */
export function isISODate(s) {
  const v = asStr(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * ISO 日期 → 连续天序号（UTC 归一化）。
 * 为什么不用 `new Date(a) - new Date(b)`：字符串形态的 Date 解析带时区语义，
 * 夏令时/时区偏移会让「相差几天」在个别日期算错一位。用 UTC 天序号做整数差才是确定的。
 */
function dayNumber(iso) {
  const [y, m, d] = asStr(iso).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** b - a 的天数（a、b 均为 'YYYY-MM-DD'，且需已通过 isISODate）。 */
export function diffDays(a, b) {
  return dayNumber(b) - dayNumber(a);
}

/** 星期中文：1 → '一'。 */
export function weekdayCN(byDay) {
  return WEEKDAY_CN[Number(byDay)] || '';
}

/**
 * 归一化单条档期记录（丢弃脏字段，保结构稳定）。
 * @param {object} raw
 * @returns {{id:string,name:string,aliases:string[],kind:string,type:string,startDate:string,
 *   endDate:string,recurring:({freq:string,byDay:number}|null),condition:string,source:string,
 *   recordedAt:string,verify:string,verifyNote:string,rawNote:string}}
 */
export function normalizePromo(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const kind = asStr(r.kind) === PROMO_KIND.RECURRING ? PROMO_KIND.RECURRING : PROMO_KIND.CAMPAIGN;
  const rec = r.recurring && typeof r.recurring === 'object' ? r.recurring : null;
  const byDay = rec ? Number(rec.byDay) : 0;
  return {
    id: asStr(r.id),
    name: asStr(r.name),
    aliases: Array.isArray(r.aliases) ? r.aliases.map(asStr).filter(Boolean) : [],
    kind,
    type: asStr(r.type),
    startDate: asStr(r.startDate),
    endDate: asStr(r.endDate),
    recurring: rec ? { freq: asStr(rec.freq) || 'weekly', byDay: byDay >= 1 && byDay <= 7 ? byDay : 0 } : null,
    condition: asStr(r.condition),
    source: asStr(r.source),
    recordedAt: asStr(r.recordedAt),
    verify: asStr(r.verify),
    verifyNote: asStr(r.verifyNote),
    rawNote: asStr(r.rawNote),
  };
}

/**
 * 判定单条档期的当前状态。**唯一实现**（上下文文本、门禁、UI 都走这里，不许各写一套）。
 *
 * @param {object} rec 档期记录（任意形态，内部会 normalize）
 * @param {Date|number|string} [now] 参考时刻（**可注入** ⇒ 单测用冻结时钟）
 * @returns {{key:string,label:string,days:number,detail:string}}
 *   key   'ended' | 'ongoing' | 'upcoming' | 'future' | 'recurring' | 'invalid'
 *   days  已结束=距结束天数；进行中=剩余天数；即将开始/尚未开始=距开始天数；其余=0
 *   detail 给模型看的一句话状态（含天数，数字才是不可能被误读的那部分）
 */
export function promoStatus(rec, now) {
  const r = normalizePromo(rec);

  if (r.kind === PROMO_KIND.RECURRING) {
    const w = weekdayCN(r.recurring && r.recurring.byDay);
    return {
      key: 'recurring',
      label: STATUS_LABEL.recurring,
      days: 0,
      detail: w ? `周期活动（每周${w}）` : '周期活动',
    };
  }

  // 起止日期必须成对存在且合法，否则**不猜**：标为日期无效（宁可不说，也不说错）。
  if (!isISODate(r.startDate) || !isISODate(r.endDate) || diffDays(r.startDate, r.endDate) < 0) {
    return { key: 'invalid', label: STATUS_LABEL.invalid, days: 0, detail: '起止日期缺失或非法，无法判断状态' };
  }

  const today = toISO(resolveNow(now));
  const toStart = diffDays(today, r.startDate);
  const toEnd = diffDays(today, r.endDate);

  if (toEnd < 0) {
    const n = diffDays(r.endDate, today);
    return { key: 'ended', label: STATUS_LABEL.ended, days: n, detail: `已结束（结束于 ${n} 天前）` };
  }
  if (toStart > 0) {
    const soon = toStart <= SOON_DAYS;
    return {
      key: soon ? 'upcoming' : 'future',
      label: soon ? STATUS_LABEL.upcoming : STATUS_LABEL.future,
      days: toStart,
      detail: `${soon ? '即将开始' : '尚未开始'}（${toStart} 天后开始）`,
    };
  }
  return {
    key: 'ongoing',
    label: STATUS_LABEL.ongoing,
    days: toEnd,
    detail: `进行中（剩余 ${toEnd} 天）`,
  };
}

/**
 * 找同期重叠档期。**只回答「重叠了没有、几天」，不排序、不推荐、不决定谁优先。**
 *
 * 默认只比一次性档期（campaign × campaign）：周期活动（每周固定）与档期同时存在是常态，
 * 逐日展开会产生大量噪声行，对模型没有增量信息。需要时用 `{ includeRecurring: true }` 打开，
 * 此时按**未来窗口内的具体日期**判定冲突。
 *
 * @param {Array} records 档期记录数组
 * @param {{now?:Date|number|string, includeRecurring?:boolean, horizonDays?:number}} [opts]
 * @returns {Array<{a:string,b:string,from:string,to:string,days:number,identical:boolean}>}
 *   按 from 升序；`identical` = 起止完全相同（同日同止）。
 */
export function findOverlaps(records, opts = {}) {
  const list = (Array.isArray(records) ? records : [])
    .map(normalizePromo)
    .filter((r) => r.name && isISODate(r.startDate) && isISODate(r.endDate) && diffDays(r.startDate, r.endDate) >= 0);

  const includeRecurring = opts.includeRecurring === true;
  const out = [];

  if (!includeRecurring) {
    const campaigns = list.filter((r) => r.kind === PROMO_KIND.CAMPAIGN);
    for (let i = 0; i < campaigns.length; i += 1) {
      for (let j = i + 1; j < campaigns.length; j += 1) {
        const x = campaigns[i];
        const y = campaigns[j];
        // 闭区间相交：重叠起点 = 较晚的开始，重叠终点 = 较早的结束。
        const from = x.startDate > y.startDate ? x.startDate : y.startDate;
        const to = x.endDate < y.endDate ? x.endDate : y.endDate;
        if (diffDays(from, to) < 0) continue; // 端点相接（如 10-07 结束、10-08 开始）不算重叠
        out.push({
          a: x.name,
          b: y.name,
          from,
          to,
          days: diffDays(from, to) + 1,
          identical: x.startDate === y.startDate && x.endDate === y.endDate,
        });
      }
    }
    return out.sort((m, n) => (m.from < n.from ? -1 : m.from > n.from ? 1 : 0));
  }

  // 含周期活动：把周期规则在未来窗口内展开成具体日期，再与一次性档期逐日比对。
  const now = resolveNow(opts.now);
  const horizon = Number.isFinite(opts.horizonDays) && Number(opts.horizonDays) > 0 ? Math.floor(Number(opts.horizonDays)) : 30;
  const campaigns = list.filter((r) => r.kind === PROMO_KIND.CAMPAIGN);
  const recurring = list.filter((r) => r.kind === PROMO_KIND.RECURRING);
  for (const rc of recurring) {
    const days = nextOccurrences(rc, now, horizon);
    for (const d of days) {
      for (const c of campaigns) {
        if (d < c.startDate || d > c.endDate) continue;
        out.push({ a: c.name, b: rc.name, from: d, to: d, days: 1, identical: false });
      }
    }
  }
  return out.sort((m, n) => (m.from < n.from ? -1 : m.from > n.from ? 1 : 0));
}

/**
 * 周期活动在未来 `horizonDays` 天内的具体发生日期（含今天）。
 * 用于「下周有哪些活动」这类问法 —— 周期规则本身没有日期，必须展开才能落到具体某天。
 * @param {object} rec 周期档期记录
 * @param {Date|number|string} [now]
 * @param {number} [horizonDays]
 * @returns {string[]} ISO 日期升序；非周期记录返回 []
 */
export function nextOccurrences(rec, now, horizonDays = 14) {
  const r = normalizePromo(rec);
  if (r.kind !== PROMO_KIND.RECURRING) return [];
  const byDay = r.recurring && r.recurring.byDay;
  if (!byDay) return [];
  const start = resolveNow(now);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const out = [];
  for (let i = 0; i <= horizonDays; i += 1) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i);
    // JS getDay(): 0=周日 … 6=周六 ⇒ 转 ISO 1..7
    const isoDay = d.getDay() === 0 ? 7 : d.getDay();
    if (isoDay === byDay) out.push(toISO(d));
  }
  return out;
}

/**
 * 档期记录 → 给 AI 的事实文本（注入企业 Context）。
 *
 * 只给事实（有什么档期、什么时候、什么状态、哪里重叠），加**使用规则**把红线讲清楚：
 * 不许改日期、不许把「待核实」当事实、不许推断未记录的规则、重叠必须问用户而不许自己裁决。
 * 无记录时返回 ''（零注入 ⇒ 没有档期的企业，AI 上下文与改动前逐字一致）。
 *
 * @param {Array} records 档期记录（或不存在）
 * @param {{now?:Date|number|string, maxItems?:number}} [opts]
 * @returns {string}
 */
export function buildPromoContext(records, opts = {}) {
  const list = (Array.isArray(records) ? records : []).map(normalizePromo).filter((r) => r.name);
  if (list.length === 0) return '';

  const now = resolveNow(opts.now);
  const today = toISO(now);
  const maxItems = Number.isFinite(opts.maxItems) && Number(opts.maxItems) > 0 ? Math.floor(Number(opts.maxItems)) : 14;

  const campaigns = list
    .filter((r) => r.kind === PROMO_KIND.CAMPAIGN)
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  const recurring = list.filter((r) => r.kind === PROMO_KIND.RECURRING);

  const head =
    `【活动档期（促销日历）】该企业已录入的促销档期，共 ${list.length} 条` +
    `（一次性档期 ${campaigns.length} 条、周期活动 ${recurring.length} 条）；今天：${today}。`;

  /** 一行一条：状态 + 原文名称 + 起止 + 类型 + 待核实标记 + 未记录提示。 */
  const line = (r) => {
    const st = promoStatus(r, now);
    const span = `${r.startDate} ~ ${r.endDate}`;
    const bits = [r.type ? `类型：${r.type}` : ''];
    if (r.aliases.length) bits.push(`别称：${r.aliases.join('、')}`);
    if (r.verify === PROMO_VERIFY.PENDING) bits.push('⚠️待核实（见下）');
    if (r.condition) bits.push(`适用条件：${r.condition}`);
    return `- [${st.label}] ${r.name}｜${span}｜${st.detail}` + (bits.length ? `｜${bits.join('｜')}` : '');
  };

  const shown = campaigns.slice(0, maxItems);
  const restN = campaigns.length - shown.length;
  const campaignBody = shown.length
    ? shown.map(line).concat(restN > 0 ? [`（另有 ${restN} 条档期未列出）`] : []).join('\n')
    : '（无一次性档期）';

  const recurringBody = recurring.length
    ? recurring
        .map((r) => {
          const w = weekdayCN(r.recurring && r.recurring.byDay);
          const extra = [];
          if (r.type) extra.push(`类型：${r.type}`);
          if (r.verify === PROMO_VERIFY.PENDING) extra.push('⚠️待核实');
          // rawNote 是截图小字**原文**（可能是残句）—— 原样给出并标明"未核实原文"，
          // 避免它被当成一条已经确认的规则（老板第 1 条：未确认的业务信息不许擅自解释）。
          if (r.rawNote) extra.push(`截图小字（未核实原文）：${r.rawNote}`);
          return `- 每周${w}：${r.name}` + (extra.length ? `｜${extra.join('｜')}` : '');
        })
        .join('\n')
    : '';

  const overlaps = findOverlaps(campaigns);
  const overlapText = overlaps.length
    ? '同期重叠（**只提示，不作优先级判断**）：\n' +
      overlaps
        .map(
          (o) =>
            `- ${o.a} × ${o.b}：重叠 ${o.days} 天（${o.from} ~ ${o.to}${o.identical ? '，起止完全相同' : ''}）`
        )
        .join('\n')
    : '同期重叠：未发现。';

  /** 待核实项：把"哪里不确定"逐条讲明白，而不是让模型自己猜哪条可疑。 */
  const pending = list.filter((r) => r.verify === PROMO_VERIFY.PENDING && r.verifyNote);
  const pendingText = pending.length
    ? '待核实项（以下**不得**当成已确认事实，也**不得**替用户改写）：\n' +
      pending.map((r) => `- ${r.name}：${r.verifyNote}`).join('\n')
    : '';

  const rules =
    '使用规则：\n' +
    '1. 上表日期是已录入档期的事实，可直接引用；**不要**在回答里改动这些日期。\n' +
    '2. 标「待核实」的名称与规则不得当作已确认事实引用，也**不得**替用户改写成"更规范"的名字。\n' +
    '3. 未记录的适用条件 / 券面规则**不得自行推断**（例如不得把名称里的「999-50」解释成「满 999 减 50」）。\n' +
    '4. 遇到同期重叠档期，必须主动向用户指出并询问优先级，**不得自行决定**合并宣传、叠加优惠或错开安排。\n' +
    `5. 活动类型是${PROMO_SEED_TYPE_BASIS}，仅供组织语言参考。`;

  const segs = [head, '一次性档期：\n' + campaignBody];
  if (recurringBody) segs.push('周期活动（每周固定，不是某个月的具体日期）：\n' + recurringBody);
  segs.push(overlapText);
  if (pendingText) segs.push(pendingText);
  segs.push(rules);

  return segs.join('\n\n');
}

/** 从 localStorage 读某企业已录入的档期（归一化）。无 / 脏 / 异常一律 []。本文件只读不写。 */
function readStoredRecords(cid) {
  const st = storage();
  if (!st) return [];
  try {
    const raw = st.getItem(PROMO_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw);
    const entry = all && typeof all === 'object' && !Array.isArray(all) ? all[cid] : null;
    const list = entry && Array.isArray(entry.records) ? entry.records : [];
    return list.map(normalizePromo).filter((r) => r.name);
  } catch {
    return [];
  }
}

/** 从企业主数据取企业名（失败返回 ''；绝不影响主流程）。 */
function companyNameOf(cid) {
  const st = storage();
  if (!st) return '';
  try {
    const list = JSON.parse(st.getItem(COMPANIES_KEY) || '[]');
    if (!Array.isArray(list)) return '';
    const c = list.find((x) => x && asStr(x.id) === cid);
    return asStr(c && c.name);
  } catch {
    return '';
  }
}

/** 企业名是否命中种子匹配词（小写包含）。 */
function matchSeedCompany(name) {
  const n = asStr(name).toLowerCase();
  if (!n) return false;
  return PROMO_SEED_ALIASES.some((t) => n.includes(asStr(t).toLowerCase()));
}

/**
 * 读某企业的档期记录（归一化，按开始日期升序；周期活动排在后面）。
 *
 * 取数优先级：**store（`douya-promo-calendar`）> 种子（data/promoCalendarSeed）> 空**。
 * 一旦该企业在 store 里有记录，种子**不再参与**（用户/接口录入的数据永远优先，
 * 避免"改了没生效"这种最难查的问题）。
 *
 * @param {string|number} companyId
 * @returns {Array} 归一化后的档期记录；无则 []
 */
export function loadPromoRecords(companyId) {
  const cid = asStr(companyId);
  if (!cid) return [];
  const stored = readStoredRecords(cid);
  if (stored.length > 0) return sortRecords(stored);
  if (!matchSeedCompany(companyNameOf(cid))) return [];
  return sortRecords(PROMO_SEED.map(normalizePromo));
}

// ══════════════════════════════════════════════════════════════════
// 写边界（2026-10-11 补）：档期录入的**唯一入口**。
// 为什么写在这个文件：校验 / 归一化 / 排序必须与读侧**同源**，
// 否则「写进去的」与「读出来的」会长得不一样（两套口径的亏本仓已经吃过一次）。
// ══════════════════════════════════════════════════════════════════

/**
 * 单条档期**字段**校验（不含重名；重名在整表保存时判）。
 * 口径：**缺就是缺，不猜不补** —— 与 `promoStatus` 遇非法日期「标为日期无效」是同一条原则。
 * @param {object} raw
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validatePromoRecord(raw) {
  const r = normalizePromo(raw);
  const errors = [];
  if (!r.name) errors.push('活动名称不能为空');
  if (r.kind === PROMO_KIND.RECURRING) {
    const byDay = r.recurring ? Number(r.recurring.byDay) : 0;
    if (!(byDay >= 1 && byDay <= 7)) errors.push('周期活动必须选「每周几」（周一 ~ 周日）');
  } else {
    const okStart = isISODate(r.startDate);
    const okEnd = isISODate(r.endDate);
    if (!okStart) errors.push('开始日期必须是真实存在的日期（形如 2026-10-01）');
    if (!okEnd) errors.push('结束日期必须是真实存在的日期（形如 2026-10-07）');
    if (okStart && okEnd && diffDays(r.startDate, r.endDate) < 0) errors.push('结束日期不能早于开始日期');
  }
  return { ok: errors.length === 0, errors };
}

/** 生成一条新档期的 id（时间戳 + 递增序号；不依赖 crypto，够用即可）。 */
let promoSeq = 0;
export function makePromoId() {
  promoSeq += 1;
  return 'p' + Date.now().toString(36) + '-' + promoSeq.toString(36);
}

/** 读整张 store 表（原始对象；缺 / 脏 / 异常一律 {}）。 */
function readStoreMap() {
  const st = storage();
  if (!st) return {};
  try {
    const all = JSON.parse(st.getItem(PROMO_KEY) || '{}');
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

/**
 * 保存某企业的档期（**整表覆盖**）。
 *
 * 语义刻意是「整表覆盖」而非「逐条 patch」：调用方手里拿的就是刚从 `loadPromoRecords`
 * 读出来的完整列表，覆盖能保证「写进去的 = 屏幕上看到的」，不会出现"删了一条、
 * store 里还留着"这类幽灵记录。
 *
 * **校验不通过 ⇒ 一个字都不写**（先校验、后落盘；绝不让半截数据进 store）。
 *
 * @param {string|number} companyId
 * @param {Array} records 完整档期列表（会被归一化 + 排序后落盘）
 * @returns {{ok:boolean, errors:string[], records:Array}}
 */
export function savePromoRecords(companyId, records) {
  const cid = asStr(companyId);
  if (!cid) return { ok: false, errors: ['缺少企业 ID，无法保存'], records: [] };

  const list = (Array.isArray(records) ? records : []).map(normalizePromo);

  // ① 逐条字段校验
  const errors = [];
  list.forEach((r, i) => {
    const v = validatePromoRecord(r);
    v.errors.forEach((e) => errors.push(list.length > 1 ? `第 ${i + 1} 条：${e}` : e));
  });

  // ② 重名校验（同企业内禁止同名：找重叠是按名称输出「谁 × 谁」，同名会让结论无法解读）
  const count = new Map();
  for (const r of list) count.set(r.name, (count.get(r.name) || 0) + 1);
  for (const [name, n] of count) if (n > 1) errors.push(`「${name}」重复 ${n} 次；同一企业内不能有同名档期`);

  const sorted = sortRecords(list);
  if (errors.length) return { ok: false, errors, records: sorted };

  const st = storage();
  if (!st) return { ok: false, errors: ['当前环境无法写入（localStorage 不可用）'], records: sorted };

  try {
    const map = readStoreMap();
    // updatedAt 是给人看的审计线索（"这批档期什么时候录进去的"）；读侧不使用它。
    map[cid] = { records: sorted, updatedAt: new Date().toISOString() };
    st.setItem(PROMO_KEY, JSON.stringify(map));
    return { ok: true, errors: [], records: sorted };
  } catch (e) {
    return { ok: false, errors: ['写入失败：' + ((e && e.message) || '未知错误')], records: sorted };
  }
}

/** 排序：一次性档期按开始日期升序在前，周期活动在后（保持录入顺序）。 */
function sortRecords(list) {
  const camp = list
    .filter((r) => r.kind === PROMO_KIND.CAMPAIGN)
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  const rec = list.filter((r) => r.kind === PROMO_KIND.RECURRING);
  return camp.concat(rec);
}

export default {
  PROMO_KEY,
  PROMO_KIND,
  PROMO_VERIFY,
  STATUS_LABEL,
  SOON_DAYS,
  isISODate,
  diffDays,
  weekdayCN,
  normalizePromo,
  promoStatus,
  findOverlaps,
  nextOccurrences,
  buildPromoContext,
  loadPromoRecords,
  validatePromoRecord,
  savePromoRecords,
  makePromoId,
};
