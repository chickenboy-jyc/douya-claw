/**
 * timelineInsight —— 企业档案「时间轴」AI 解读服务（阶段一补完）。
 *
 * 背景：企业档案已有「时间轴」数据层（按月记录做了什么 + 关键指标怎么变），
 * 但 AI 对变化的解读一直「没有产出物、没有回显」；且 UI 曾把「写给 AI 的指令」
 * 当成内容直接贴给用户看。本服务把这条链路补完：
 *
 *   loadTimeline（事实）→ comparePeriods（本月 vs 上月）→ buildTimelineFacts（只给用户看的事实）
 *                                                        → interpretTimeline（AI 解读，2~4 句大白话）
 *
 * 真实性铁律：
 *  - 不编数字：prompt 要求 AI「只基于给定事实，不编造数字，不确定就说不确定」；
 *  - 无数据不出解读：两期都没有记录时直接返回 { ok:false }，绝不调 AI、绝不写缓存（红线）；
 *  - 只碰独立缓存 key（`douya-timeline-insight`），不污染时间轴事实层与四类知识。
 *
 * 缓存 + 数据指纹：解读按月缓存，并记下「两期事实文本」的简单指纹；数据没变就直接复用，
 * 数据变了（指纹不同）才需要重新解读，避免每次渲染都打 AI。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import {
  loadTimeline,
  comparePeriods,
  buildTimelineFacts,
  currentPeriod,
  previousPeriod,
} from './companyTimeline.js';

/** 独立缓存 key（与事实层 `douya-company-timeline` 分离）。 */
const INSIGHT_KEY = 'douya-timeline-insight';

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/** 读取 localStorage（容错：非浏览器环境 / 被禁用返回 null）。 */
function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

/** 读整个缓存对象（容错）。 */
function readAll(st) {
  try {
    const raw = st.getItem(INSIGHT_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/**
 * 简单字符串指纹：长度 + 位置加权字符码求和（无需引入 crypto，够用即止）。
 * 数据文本变了 → 指纹变 → 触发重新解读。
 * @param {string} text
 * @returns {string} 形如 '123-456789'
 */
export function fingerprintOf(text) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) {
    sum = (sum + s.charCodeAt(i) * (i + 1)) % 1000000007;
  }
  return `${s.length}-${sum}`;
}

/**
 * 两期「事实文本」的数据指纹。解读缓存据此判断是否过期。
 * @param {Array} entries loadTimeline 产物（或 k.timeline）
 * @param {string} [period] 目标期（默认当前月）
 * @returns {string}
 */
export function timelineFingerprint(entries, period) {
  const list = Array.isArray(entries) ? entries : [];
  const cur = asStr(period) || currentPeriod();
  const prev = previousPeriod(cur);
  return fingerprintOf(buildTimelineFacts(list, { current: cur, previous: prev }));
}

/**
 * 读取某企业某期的解读缓存。
 * @param {string} companyId
 * @param {string} period 如 '2026-09'
 * @returns {{insight:string, at:string, fingerprint:string}|null}
 */
export function loadInsight(companyId, period) {
  const cid = asStr(companyId);
  const p = asStr(period);
  const st = storage();
  if (!cid || !p || !st) return null;
  const all = readAll(st);
  const byComp = all[cid];
  const rec = byComp && typeof byComp === 'object' && !Array.isArray(byComp) ? byComp[p] : null;
  if (!rec || typeof rec !== 'object' || !rec.insight) return null;
  return {
    insight: String(rec.insight),
    at: asStr(rec.at),
    fingerprint: asStr(rec.fingerprint),
  };
}

/**
 * 写入某企业某期的解读缓存。
 * @param {string} companyId
 * @param {string} period
 * @param {string} insight 纯文本解读（可含换行）
 * @param {string} [fingerprint] 对应的事实文本指纹
 * @returns {boolean}
 */
export function saveInsight(companyId, period, insight, fingerprint = '') {
  const cid = asStr(companyId);
  const p = asStr(period);
  const text = typeof insight === 'string' ? insight.trim() : '';
  const st = storage();
  if (!cid || !p || !text || !st) return false;
  try {
    const all = readAll(st);
    const byComp =
      all[cid] && typeof all[cid] === 'object' && !Array.isArray(all[cid]) ? all[cid] : {};
    byComp[p] = { insight: text, at: new Date().toISOString(), fingerprint: asStr(fingerprint) };
    all[cid] = byComp;
    st.setItem(INSIGHT_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/**
 * 清除某企业的全部解读缓存。
 * @param {string} companyId
 * @returns {boolean}
 */
export function clearInsight(companyId) {
  const cid = asStr(companyId);
  const st = storage();
  if (!cid || !st) return false;
  try {
    const all = readAll(st);
    if (all[cid]) {
      delete all[cid];
      st.setItem(INSIGHT_KEY, JSON.stringify(all));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 组装给 AI 的解读 prompt（只基于事实，不编数字）。
 * @param {string} facts 只给用户看的事实文本
 * @param {string} curPeriod 本月
 * @param {string} prevPeriod 上月
 * @returns {string}
 */
function buildInsightPrompt(facts, curPeriod, prevPeriod) {
  return [
    '你是口腔医疗行业的企业经营顾问。下面是这家企业「本月 vs 上月」的经营事实（只记录了做了什么、关键指标怎么变）：',
    '',
    facts,
    '',
    `请用 2~4 句大白话，回答两件事：① 这些变化说明了什么问题；② 接下来建议调整哪些经营动作。`,
    `要求：只基于上面给出的事实判断，不要编造任何数字或事实；信息不足或拿不准的地方就直说不确定；不要用标题、编号或项目符号，直接用自然段说人话。`,
  ].join('\n');
}

/**
 * 解读企业「本月 vs 上月」的时间轴变化。
 *
 * 红线：无数据 / 两期都没有记录 → 直接返回 { ok:false, error:'暂无可解读的时间轴数据' }，
 * 绝不调用 AI、绝不写缓存。
 *
 * @param {object} p { companyId, entries, knowledge }
 * @returns {Promise<{ok:boolean, insight:string, period:string, error:string}>}
 */
export async function interpretTimeline({ companyId, entries, knowledge } = {}) {
  const list = Array.isArray(entries) ? entries : loadTimeline(companyId);
  const period = currentPeriod();
  const prev = previousPeriod(period);

  // 只出事实：两期都没有记录 → 不解读（不调 AI、不写库）。
  const cmp = comparePeriods(list, period, prev);
  if (!cmp.current && !cmp.previous) {
    return { ok: false, insight: '', period, error: '暂无可解读的时间轴数据' };
  }
  const facts = buildTimelineFacts(list, { current: period, previous: prev });
  if (!facts) {
    return { ok: false, insight: '', period, error: '暂无可解读的时间轴数据' };
  }

  const ctx = buildAIContext({ knowledge });
  const messages = [{ role: 'user', content: buildInsightPrompt(facts, period, prev) }];

  let res;
  try {
    res = await chatOnce(messages, ctx, { temperature: 0.4, reasoningEffort: 'none' });
  } catch (e) {
    return { ok: false, insight: '', period, error: 'AI 解读失败：' + ((e && e.message) || e) };
  }
  if (!res || res.ok !== true || !res.content || !res.content.trim()) {
    return { ok: false, insight: '', period, error: (res && res.error) || 'AI 解读失败（无返回）' };
  }

  const insight = res.content.trim();
  saveInsight(companyId, period, insight, fingerprintOf(facts));
  return { ok: true, insight, period, error: '' };
}

export default {
  INSIGHT_KEY,
  fingerprintOf,
  timelineFingerprint,
  loadInsight,
  saveInsight,
  clearInsight,
  interpretTimeline,
};
