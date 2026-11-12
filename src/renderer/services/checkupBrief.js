/**
 * checkupBrief —— 企业体检结论的「持久化 + 注入」数据层（独立 key，三层数据隔离）。
 *
 * 为什么单独建文件（而不是放进 companyCheckup.js）：
 *   companyCheckup.js 依赖 contextBuilder.js（要 buildAIContext 组装上下文），
 *   而 contextBuilder.js 又需要读体检结论来注入 AI —— 若把读写放进同一文件就会形成
 *   companyCheckup ⇄ contextBuilder 的循环导入。故按本项目既有惯例（planBrief / companyTimeline）
 *   抽成 xxxBrief.js：**本文件不 import 任何业务模块**（仅公司时间轴用于留痕），
 *   由 companyCheckup.js 与 contextBuilder.js 单向依赖它，依赖图无环。
 *
 * ==================== 三层数据隔离（回答「为什么不能做数据隔离」）====================
 * 老板问「写进去，为什么不能做数据隔离」。真相是**能做，而且是三层隔离**，此前只是没做：
 *   ① 存储隔离：独立 key `douya-company-checkup`，绝不进 douya-company-knowledge 的
 *      facts / rules / memories —— 体检结论是「AI 的判断」，一旦混进 facts 就会被所有 AI 调用
 *      当成「已核实的企业事实」，这是之前不敢写库的真正原因。独立 key 后这个风险归零。
 *   ② 作用域隔离：按 companyId 分桶（{ [companyId]: record }），多企业互不可见、互不覆盖。
 *   ③ 语义隔离：注入 AI 时**自带「AI 假设，非已核实事实」抬头 + 冲突时以企业事实为准**的兜底句，
 *      模型不会把它当成事实；且只注入 summary/gaps/fixes（判断与短板），
 *      understood（豆芽了解到什么）只给人看、不进 AI 上下文，避免把「自述」反复喂给模型自我强化。
 *   另：用户可在「企业大脑」页一键清除（clearCheckup），隔离可回收、可控。
 *
 * 数据结构（只保留最新一次体检，重跑即刷新；历史痕迹走 companyTimeline 事件）：
 *   { [companyId]: { at:ISO, companyName, summary, understood:[], gaps:[], fixes:[] } }
 */

import { recordEvent } from './companyTimeline.js';

const CHECKUP_KEY = 'douya-company-checkup';

/** 单企业体检结论各段上限（与 companyCheckup 的 MAX_* 同口径，此处再兜一层防脏数据膨胀）。 */
export const BRIEF_MAX_UNDERSTOOD = 8;
export const BRIEF_MAX_GAPS = 5;
export const BRIEF_MAX_FIXES = 5;
/** 单条文本最大长度（截断，防某条超长撑爆 AI 上下文）。 */
export const BRIEF_TEXT_MAX = 200;

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function clip(s, max = BRIEF_TEXT_MAX) {
  const t = asStr(s);
  return t.length > max ? t.slice(0, max) + '…' : t;
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

/**
 * 归一化一份体检结论记录；**空壳（三段全空）返回 null**（空壳不是结论，不许写库）。
 * 不修改入参。
 * @param {unknown} raw
 * @returns {{at:string, companyName:string, summary:string, understood:Array, gaps:Array, fixes:Array}|null}
 */
export function normalizeCheckupRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const understood = [];
  const uSeen = new Set();
  const rawU = Array.isArray(raw.understood) ? raw.understood : [];
  for (const it of rawU) {
    if (understood.length >= BRIEF_MAX_UNDERSTOOD) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const label = clip(it.label, 40);
    const value = clip(it.value);
    if (!label || !value) continue;
    if (uSeen.has(label)) continue;
    uSeen.add(label);
    const from = asStr(it.from);
    understood.push({ label, value, from: ['user', 'web', 'ai'].includes(from) ? from : 'ai' });
  }

  const gaps = [];
  const gSeen = new Set();
  const rawG = Array.isArray(raw.gaps) ? raw.gaps : [];
  for (const it of rawG) {
    if (gaps.length >= BRIEF_MAX_GAPS) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const title = clip(it.title, 60);
    const why = clip(it.why);
    if (!title || !why) continue;
    if (gSeen.has(title)) continue;
    gSeen.add(title);
    gaps.push({ title, why });
  }

  const fixes = [];
  const rawF = Array.isArray(raw.fixes) ? raw.fixes : [];
  for (const it of rawF) {
    if (fixes.length >= BRIEF_MAX_FIXES) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const gap = clip(it.gap, 60);
    const action = clip(it.action);
    if (!gap || !action) continue;
    fixes.push({ gap, action });
  }

  const summary = clip(raw.summary);

  // 空壳判负：三段全空 + 无总评 —— 与 companyCheckup.normalizeCheckup 同口径。
  if (understood.length === 0 && gaps.length === 0 && fixes.length === 0 && !summary) return null;

  return {
    at: asStr(raw.at) || new Date().toISOString(),
    companyName: asStr(raw.companyName),
    summary,
    understood,
    gaps,
    fixes,
  };
}

/** 读全部公司体检 map（容错：异常结构回 {}）。 */
function loadMap() {
  const st = storage();
  if (!st) return {};
  try {
    const raw = st.getItem(CHECKUP_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/**
 * 读某企业的体检结论（无 / 脏数据一律返回 null）。
 * @param {string|number} companyId
 * @returns {object|null}
 */
export function loadCheckup(companyId) {
  const cid = asStr(companyId);
  if (!cid) return null;
  const map = loadMap();
  return normalizeCheckupRecord(map[cid]);
}

/**
 * 写入某企业体检结论（覆盖上一次；空壳不写）。
 * @param {string|number} companyId
 * @param {object} checkup 体检结论（normalizeCheckup 产物或 AI 原始对象皆可）
 * @param {{companyName?:string, at?:string, recordEvent?:boolean}} [opts]
 *   recordEvent（默认 true）：在企业时间轴「本月做了什么」留一条痕，让体检也有时间维度。
 * @returns {object|null} 写回后的记录；写失败 / 入参无效返回 null
 */
export function saveCheckup(companyId, checkup, opts = {}) {
  const cid = asStr(companyId);
  if (!cid) return null;
  const rec = normalizeCheckupRecord({
    ...(checkup && typeof checkup === 'object' ? checkup : {}),
    companyName: opts.companyName != null ? opts.companyName : (checkup && checkup.companyName),
    at: opts.at || (checkup && checkup.at),
  });
  if (!rec) return null;

  const st = storage();
  if (!st) return null;
  try {
    const map = loadMap();
    map[cid] = rec;
    st.setItem(CHECKUP_KEY, JSON.stringify(map));
  } catch {
    return null;
  }

  // 时间维度留痕：体检本身也是「企业本月发生的一件事」。失败不影响主流程。
  if (opts.recordEvent !== false && rec.gaps.length > 0) {
    try {
      recordEvent(cid, { label: `企业体检：发现 ${rec.gaps.length} 项短板`, kind: '体检' });
    } catch {
      /* 忽略 */
    }
  }
  return rec;
}

/**
 * 清除某企业体检结论（用户在「企业大脑」页一键清除 —— 隔离可回收）。
 * @returns {boolean} 是否真的删掉了
 */
export function clearCheckup(companyId) {
  const cid = asStr(companyId);
  if (!cid) return false;
  const st = storage();
  if (!st) return false;
  try {
    const map = loadMap();
    if (!(cid in map)) return false;
    delete map[cid];
    st.setItem(CHECKUP_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** 体检日期（取 at 的 YYYY-MM-DD，解析失败返回空串）。 */
export function checkupDate(record) {
  const at = asStr(record && record.at);
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * 体检结论 → 注入 AI 的上下文文本。
 *
 * **无数据返回 ''（零注入）** —— 保证没做过体检时，AI 上下文与改动前逐字一致。
 * 只取 summary / gaps / fixes：understand 是「豆芽自述了解了什么」，属给人看的内容，
 * 反复喂回模型只会自我强化，故不注入。
 * 抬头与兜底句是硬约束，防止模型把 AI 假设当成已核实事实。
 *
 * @param {object|null} record loadCheckup 产物（或 k.checkup）
 * @returns {string}
 */
export function buildCheckupContext(record) {
  const rec = normalizeCheckupRecord(record);
  if (!rec) return '';
  const hasBody = rec.gaps.length > 0 || rec.fixes.length > 0 || !!rec.summary;
  if (!hasBody) return '';

  const lines = [];
  const date = checkupDate(rec);
  if (date) lines.push(`体检时间：${date}`);
  if (rec.summary) lines.push(`总评：${rec.summary}`);

  if (rec.gaps.length > 0) {
    lines.push('当时发现的短板：');
    rec.gaps.forEach((g) => lines.push(`  - ${g.title}（依据：${g.why}）`));
  }
  if (rec.fixes.length > 0) {
    lines.push('当时建议的整改：');
    rec.fixes.forEach((f) => lines.push(`  - 针对「${f.gap}」：${f.action}`));
  }

  const head = '【企业体检结论（豆芽此前的判断 · AI 假设，不是已核实事实）】';
  const foot = '（以上是豆芽在体检当时基于有限资料与公开信息给出的判断，请当作**待验证的假设**；若与【企业事实】冲突，一律以企业事实为准。）';
  return `${head}\n${lines.join('\n')}\n${foot}`;
}

/** 便捷入口：直接读某企业并拼上下文文本。 */
export function buildCheckupContextById(companyId) {
  return buildCheckupContext(loadCheckup(companyId));
}

export default {
  BRIEF_MAX_UNDERSTOOD,
  BRIEF_MAX_GAPS,
  BRIEF_MAX_FIXES,
  BRIEF_TEXT_MAX,
  normalizeCheckupRecord,
  loadCheckup,
  saveCheckup,
  clearCheckup,
  checkupDate,
  buildCheckupContext,
  buildCheckupContextById,
};
