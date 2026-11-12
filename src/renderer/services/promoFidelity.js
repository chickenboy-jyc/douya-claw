/**
 * promoFidelity —— 「生成之后」的关键业务事实校验层（唯一实现）。
 *
 * ── 它补的是哪个洞（2026-10-11 第 5 层第 5 步 · 生成忠实性）────────────────────
 * 上一轮把「日期错」查清后，结论是：**上下文传对 ≠ 生成结果可靠**。
 * 实测两次真生成，模型对档期名/日期/状态/重叠天数都忠实，但**有一次漏报了 1 对重叠**
 * （起止完全相同、且当天已双双结束的那对）—— 也就是说：
 *   「重叠是否列全」目前是**模型的自觉**，而不是**产品的保证**。
 * 而这件事本来就不该由模型承担：`findOverlaps` 已经能确定性地算出完整重叠清单。
 *
 * 分工（老板 2026-10-11 明确）：**模型负责组织和表达，产品负责保证关键业务事实完整。**
 * 于是本模块做三件事，全部确定性、可复判：
 *   ① 由真源算出**完整**重叠清单（复用 `findOverlaps`，不另写一套计算）；
 *   ② 逐项核对模型产出（日期 / 活动名 / 重叠信息），名称对但日期错**也**判失败；
 *   ③ 漏了重叠 ⇒ 产出「同期活动核对」段（**由真源计算**，非 AI 生成）供上层补进交付物；
 *      事实不一致（如日期错）⇒ 产出标注段，要求复核，而不是把不完整结果当完整方案交付。
 *
 * ── 为什么是「纯函数 + 注入 records」而不是自己去读 store ──────────────────────
 * 与 `promoCalendar.js` 同一条依赖方向：本模块 → `promoCalendar` → `data/promoCalendarSeed`，
 * **不反向**、不 import React/store/.jsx。records 由调用方从上下文里取（`ctx.knowledge.promos`
 * 就是 `loadPromoRecords(cid)` 的结果，与注入给模型的那份**同一来源**）⇒
 * 「拿来核对的事实」与「喂给模型的事实」不可能分叉（这正是不再手抄真源的意义）。
 *
 * ── 三条不许越界的纪律（与 promoCalendar 的红线同源）──────────────────────────
 * 【红线 1｜只核对不裁决】漏报重叠时只**补事实**（谁和谁重叠几天），绝不排序、绝不推荐优先级、
 *   绝不建议合并/叠加/错开 —— 那是业务方的决定。补上去的那段结尾明确写「以本表为准 + 需业务方决定」。
 * 【红线 2｜不编造规则】`condition` 为空的档期，若产出里在其名称旁出现了具体折扣规则
 *   （满 X 减 Y / 打折 / 立减），判 `rule_invented` 并**要求标注**（不得被解释成已确认规则）。
 * 【红线 3｜只标注不改写】本模块**不修改模型原文**（不改名、不改数字）；它只
 *   ① 附加一段由真源计算的核对表 ② 附加一段「需人工确认」的标注。原文怎么写的，交付物里就是怎么写的。
 */

import { findOverlaps, normalizePromo } from './promoCalendar.js';

/** 完整日期（'YYYY-MM-DD'）。 */
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
/** 「重叠类」表述：重叠行里出现的活动名，带的是**重叠区间**而不是档期区间。 */
const OVERLAP_LINE_RE = /重叠|×|冲突|撞车/;
/** 具体折扣/券面规则（只在**未录入 condition** 的档期旁出现才算"自行解释"）。 */
const OFFER_RE = /满\s*\d+\s*(?:减|送|返|赠|折)|\d+\s*折|立减/;

const asStr = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const datesOf = (s) => asStr(s).match(DATE_RE) || [];
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(asStr(s));

/** 转义正则元字符（活动名要拼进正则做"从行里剥掉名字"）。 */
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一行里**除活动名之外**的文本。
 *
 * 为什么要剥掉名字：真实档期名本身就含折扣字样 ——
 * `下单满500元返999-50优惠券` 里就有「满500元返」，若不剥名字，判定「自行解释规则」时
 * 会把**照抄名称**误判成编造规则（判定器自伤）。剥掉后再看剩余部分有没有 OFFER 规则。
 */
function textWithoutName(line, name) {
  return asStr(line).replace(new RegExp(esc(name), 'g'), ' ');
}

/**
 * 在产出里找**一行**同时含两个活动名、且带「重叠类」关键词的表述。
 *
 * ⚠️ 与 `_fidelity_judge.mjs` 同口径（那边已踩过坑，此处不重犯）：
 *   ① 不用"滑窗兜底"—— 180 字符窗会从表格里的活动名一路滑到下方的「**同期**重叠」小标题上，
 *      把**根本没被报告**的一对误判成"已提及"；
 *   ② 重叠在上下文与产出里都是**一行一对**（`- A × B：重叠 N 天（from ~ to）`），
 *      "必须同一行"既够用又不会自伤。
 * @param {string} text
 * @param {string} a
 * @param {string} b
 * @returns {string|null}
 */
function findOverlapLine(text, a, b) {
  for (const ln of asStr(text).split(/\r?\n/)) {
    if (ln.includes(a) && ln.includes(b) && OVERLAP_LINE_RE.test(ln)) return ln;
  }
  return null;
}

/**
 * 由真源重叠清单生成「同期活动核对」段（**程序计算，非 AI 生成**）。
 *
 * 措辞受红线 1 约束：只报事实（谁和谁、几天、哪个区间），结尾声明以本表为准 + 是否调整仍需业务方决定，
 * **不含**任何排序/推荐/建议合并措辞。
 *
 * @param {Array<{a:string,b:string,from:string,to:string,days:number,identical:boolean}>} overlaps
 * @returns {string} 无重叠返回 ''
 */
export function buildOverlapAuditSection(overlaps) {
  const list = Array.isArray(overlaps) ? overlaps.filter((o) => o && o.a && o.b) : [];
  if (list.length === 0) return '';
  const body = list
    .map((o) => `- ${o.a} × ${o.b}：重叠 ${o.days} 天（${o.from} ~ ${o.to}${o.identical ? '，起止完全相同' : ''}）`)
    .join('\n');
  return [
    '【同期活动核对（系统按已录入档期计算，非 AI 生成）】',
    `已录入档期中存在 ${list.length} 对同期重叠，逐条列全如下：`,
    body,
    '本表由程序直接算出；如上文方案与本表不一致，以本表为准。是否调整档期重叠仍需业务方决定。',
  ].join('\n');
}

/** 供上层附加到交付物里的「需人工确认」标注段（没有任何问题时返回 ''）。 */
function buildNotice(issues) {
  const list = Array.isArray(issues) ? issues.filter((i) => i && i.text) : [];
  if (list.length === 0) return '';
  const errs = list.filter((i) => i.level === 'error');
  const warns = list.filter((i) => i.level !== 'error');
  const lines = [
    '【生成后事实核对：以下需人工确认】',
    '系统已用已录入档期逐项核对本方案，发现下列事实问题（不修改上文原文，仅标注）：',
    ...list.map((i) => `- ${i.level === 'error' ? '❗' : '⚠️'} ${i.text}`),
  ];
  if (errs.length) {
    lines.push('❗ 项与已录入档期冲突，**请对照后修正或提示重新生成**，不要直接按上文执行。');
  }
  if (warns.length && !errs.length) {
    lines.push('⚠️ 项未与已录入事实冲突，但属于未核实信息被具体化，请人工确认后再采用。');
  }
  return lines.join('\n');
}

/**
 * 生成后事实校验（唯一实现）。
 *
 * @param {object} p
 * @param {string} p.output    模型返回原文（活动方案）
 * @param {Array}  p.records   该企业已录入档期（`ctx.knowledge.promos`；无则 []）
 * @param {Date|number|string} [p.now] 参考时刻（可注入 ⇒ 单测用冻结时钟）
 * @returns {{
 *   ok:boolean, verdict:'ok'|'ok_with_notes'|'patched'|'needs_review'|'skipped',
 *   issues:Array<{kind:string,level:'error'|'warn',text:string}>,
 *   overlap:{truth:Array,reported:Array,missed:Array},
 *   patch:string, notice:string, audit:string
 * }}
 *
 * verdict 语义：
 *   skipped       无正文（AI 没产出）⇒ 无物可核，不改变交付物
 *   ok            事实一致且重叠列全 ⇒ 可直接交付
 *   ok_with_notes 事实未冲突，但有未核实信息被具体化 ⇒ 交付 + 标注
 *   patched       漏报重叠 ⇒ 交付物已补上「同期活动核对」段（不完整结果不再被当完整方案）
 *   needs_review  与已录入档期**冲突**（如日期错）⇒ 标注并要求复核/重新生成
 */
export function verifyPromoPlan({ output, records, now } = {}) {
  const out = asStr(output);
  const list = (Array.isArray(records) ? records : []).map(normalizePromo).filter((r) => r.name);
  const campaigns = list.filter((r) => r.kind === 'campaign');
  /** @type {Array<{kind:string,level:'error'|'warn',text:string}>} */
  const issues = [];
  const overlap = { truth: [], reported: [], missed: [] };

  // 无正文 ⇒ 没有可核对的对象（AI 失败/空产出由上层按其它路径处理，本层不越权开火）
  if (!out.trim()) {
    return { ok: true, verdict: 'skipped', issues, overlap, patch: '', notice: '', audit: '无正文，跳过档期核对' };
  }
  // 该企业没有已录入档期 ⇒ 没有可核对的事实（**不是**"核对了没问题"，如实表述）
  if (campaigns.length === 0) {
    return { ok: true, verdict: 'ok', issues, overlap, patch: '', notice: '', audit: '该企业无已录入档期，无需核对' };
  }

  // ① 由真源算出**完整**重叠清单（复用产品自己的 findOverlaps，不另写一套计算）
  const truth = findOverlaps(campaigns);
  overlap.truth = truth;

  // ② 重叠完整性：真源每一对都必须在产出里被成对提及
  for (const o of truth) {
    if (findOverlapLine(out, o.a, o.b)) overlap.reported.push(o);
    else overlap.missed.push(o);
  }
  if (overlap.missed.length) {
    issues.push({
      kind: 'overlap_missing',
      level: 'error',
      text:
        `方案漏报 ${overlap.missed.length} 对同期重叠：` +
        overlap.missed.map((o) => `${o.a} × ${o.b}（${o.days} 天：${o.from} ~ ${o.to}）`).join('、'),
    });
  }

  // ③ 逐档期日期一致性：**名称对但日期错也必须判失败**（老板点名要抓的形态）。
  //    只在"它确实被当作一条档期引用（独立行且带日期读数）"时才判 —— 方案里全新提议的日期不算错。
  const lines = out.split(/\r?\n/);
  for (const r of campaigns) {
    if (!isISODate(r.startDate) || !isISODate(r.endDate)) continue;
    const cands = lines.filter((ln) => ln.includes(r.name) && !OVERLAP_LINE_RE.test(ln));
    const withDates = cands.filter((ln) => datesOf(ln).length);
    if (withDates.length === 0) continue; // 未被引用 / 无日期读数 ⇒ 无从核对，不判失败
    if (cands.some((ln) => ln.includes(r.startDate) && ln.includes(r.endDate))) continue;
    const toks = datesOf(withDates[0]);
    const off = toks.filter((t) => t !== r.startDate && t !== r.endDate);
    if (off.length) {
      issues.push({
        kind: 'date_mismatch',
        level: 'error',
        text:
          `「${r.name}」被引用的日期 ${toks.join(' , ')} 与已录入档期 ${r.startDate} ~ ${r.endDate} 不一致` +
          `（错值：${off.join('、')}）`,
      });
    }
  }

  // ④ 未录入的适用条件不得被具体化（如把名称里的「999-50」解释成「满 999 减 50」）
  //    ⚠️ 必须**先剥掉活动名**再判：真实名称「下单满500元返999-50优惠券」自带折扣字样，
  //       不剥就会把"照抄名称"误判成"编造规则"（这是判定器自伤，不是产品缺陷）。
  for (const r of campaigns) {
    if (asStr(r.condition)) continue;
    const line = lines.find((ln) => ln.includes(r.name) && OFFER_RE.test(textWithoutName(ln, r.name)));
    if (line) {
      issues.push({
        kind: 'rule_invented',
        level: 'warn',
        text: `「${r.name}」的适用条件未录入，方案里却出现了具体规则：${line.trim().slice(0, 80)}`,
      });
    }
  }

  const hasDateErr = issues.some((i) => i.kind === 'date_mismatch');
  const missed = overlap.missed.length > 0;
  const patch = missed ? buildOverlapAuditSection(truth) : '';
  const notice = buildNotice(issues);

  let verdict;
  if (hasDateErr) verdict = 'needs_review';
  else if (missed) verdict = 'patched';
  else if (issues.length) verdict = 'ok_with_notes';
  else verdict = 'ok';

  const auditParts = [];
  if (missed) auditParts.push(`补全同期重叠 ${overlap.missed.length} 对（真源共 ${truth.length} 对）`);
  if (hasDateErr) auditParts.push(`发现 ${issues.filter((i) => i.kind === 'date_mismatch').length} 处档期日期与已录入记录冲突`);
  if (!auditParts.length) auditParts.push('档期事实核对通过');
  const audit = `生成后核对：${auditParts.join('；')}。`;

  return { ok: !hasDateErr, verdict, issues, overlap, patch, notice, audit };
}

export default { verifyPromoPlan, buildOverlapAuditSection };
