/**
 * videoCaptionAI —— 「视频精剪」的字幕 AI：把一整段口播稿/文案切成**可上时间轴的字幕条**。
 *
 * ============================================================================
 * 【为什么要有这个文件（老板原话 2026-11-10）】
 *   「视频剪辑 那个也有问题 … 输入字幕 还有功能这一块是灰色的 **并没有AI功能**」
 *   逐行核过现场：`VideoStudio.jsx` 的字幕面板只有一个 textarea + 一个「加字幕」按钮，
 *   每条固定 `CAPTION_SEC = 3` 秒。也就是说 —— 用户必须**自己断句、自己数秒数**。
 *   这不是"AI 工具"，这是一个手摇的表格录入框。
 *
 * 【为什么"断句"值得交给 AI，而"算时间"不该交给 AI】
 *   断句要理解语义（谁在说话、哪里换意群、一行字读起来会不会太长）—— 这是模型擅长的；
 *   排时间轴要的是**确定性和不重叠**（同一秒不能压两条字幕、总长不能超片长）——
 *   这是算术，交给模型必然出现 0.3s / 负数 / 重叠 / 越界，而且每次都不一样。
 *   ⇒ 分工：模型只回**每行文本**（外加一个可选的"这一句大约几秒"的直觉值），
 *     时间轴由本文件的 `layoutCaptions()` 用可核对的规则算出来。
 *
 * 【不变量（门禁 unit-video-caption-ai 逐条钉住）】
 *   ① `layoutCaptions()` 的输出必须**严格递增且不重叠**：`next.start === prev.end`；
 *   ② 每条时长落在 `[minSec, maxSec]` 内，且**由字数决定**（同字数同秒数，可复现）；
 *   ③ 给了 `totalSec` 时，最后一条的 `end` **不许超过** `totalSec`（宁可缩，不许溢出）；
 *   ④ 空行 / 纯空白 / 超长行都要有确定行为：空行丢弃，超长行按 `maxChars` 硬切；
 *   ⑤ 模型返回为空 / 不是 JSON / 说没写 —— 一律 `{ok:false, error}`，**不许**编造字幕。
 */
import { chatOnce } from '../api.js';
import { extractJSON } from './projectAI.js';

/** 一条字幕的默认阅读速度（字/秒）。中文口播实测 4~6 字/秒，取 5 作中位。 */
export const DEFAULT_CPS = 5;

/** 单条字幕的时长上下限（秒）。太短读不完，太长会和下一句抢注意力。 */
export const MIN_CAPTION_SEC = 1.2;
export const MAX_CAPTION_SEC = 8;

/** 单行字幕的字数上限（汉字）。超过就按标点/等分切开 —— 一行 40 字在小屏上必然截断。 */
export const DEFAULT_MAX_CHARS = 18;

/**
 * 把一段文本按标点切成"一句话"级别的碎块。
 *
 * ★ 为什么先按标点切、而不是直接按字数硬切：
 *   硬切会把「我们用的是德国进口的」/「设备」这种词切断，读起来像机器。
 *   标点切分是**免费的语义**，先用它，不够长再用字数兜底。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const out = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // 中文句末 + 英文句末都算；保留标点（字幕里带着标点读起来更自然）
    const parts = t.split(/(?<=[。！？!?；;…])/);
    for (const p of parts) {
      const q = p.trim();
      if (q) out.push(q);
    }
  }
  return out;
}

/**
 * 把一句可能过长的话按 `maxChars` 切开（优先在逗号/顿号处断）。
 * @param {string} sentence
 * @param {number} maxChars
 * @returns {string[]}
 */
export function splitLong(sentence, maxChars) {
  const s = String(sentence || '').trim();
  const max = Math.max(4, Number(maxChars) || DEFAULT_MAX_CHARS);
  if (s.length <= max) return s ? [s] : [];
  const pieces = s.split(/(?<=[，,、：:])/);
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of pieces) {
    if (!p) continue;
    if ((buf + p).length <= max) { buf += p; continue; }
    flush();
    // 单块本身就超长 ⇒ 兜底切。**按等分切，不要按 max 硬切**：
    //   硬切（每 max 一刀）在末尾会留下「查」这种 1 个字的孤儿行 ——
    //   实测 18 字上限下「到店可以先做一次免费的口腔 CT 检查」被切成
    //   「…口腔 CT 检」+「查」，字幕上闪一个字，比不切还难看。
    //   等分（n = ceil(len/max)，每段 ≈ len/n）能让每段长度接近，不会出孤儿。
    if (p.length <= max) { buf = p; continue; }
    const parts = Math.ceil(p.length / max);
    const step = Math.ceil(p.length / parts);
    let rest = p;
    while (rest.length > step) {
      out.push(rest.slice(0, step).trim());
      rest = rest.slice(step);
    }
    buf = rest;
  }
  flush();
  return out.filter(Boolean);
}

/**
 * 纯函数：把若干行字幕排到时间轴上。
 *
 * @param {string[]} lines 已经切好的一行一条
 * @param {{startAt?: number, cps?: number, minSec?: number, maxSec?: number, totalSec?: number}} [opts]
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function layoutCaptions(lines, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const cps = Number(o.cps) > 0 ? Number(o.cps) : DEFAULT_CPS;
  const minSec = Number(o.minSec) > 0 ? Number(o.minSec) : MIN_CAPTION_SEC;
  const maxSec = Number(o.maxSec) > 0 ? Number(o.maxSec) : MAX_CAPTION_SEC;
  const totalSec = Number(o.totalSec) > 0 ? Number(o.totalSec) : 0;
  let t = Number(o.startAt) > 0 ? Number(o.startAt) : 0;

  const round2 = (x) => Math.round(x * 100) / 100;
  const out = [];
  const list = Array.isArray(lines) ? lines : [];
  for (const raw of list) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) continue;
    // 时长只由**字数**决定：同字数必然同秒数 ⇒ 可复现、可断言
    const byChars = text.length / cps;
    const dur = round2(Math.min(maxSec, Math.max(minSec, byChars)));
    let start = round2(t);
    let end = round2(start + dur);
    if (totalSec > 0 && end > totalSec) {
      // 越界不丢句子：把这一条的**结束**压到片尾；实在一点空间都没有就跳过剩下的。
      end = round2(totalSec);
      if (end - start < 0.2) break;
    }
    out.push({ start, end, text });
    t = end;
  }
  return out;
}

/**
 * 调模型把文案切成字幕行。
 *
 * @param {{script?: string, maxChars?: number, tone?: string, duration?: number}} p
 * @returns {Promise<{ok:boolean, lines?:string[], error?:string}>}
 */
export async function genCaptionLines(p) {
  const a = p && typeof p === 'object' ? p : {};
  const script = String(a.script == null ? '' : a.script).trim();
  if (!script) return { ok: false, error: '先贴一段口播稿或文案' };
  const maxChars = Math.max(8, Number(a.maxChars) || DEFAULT_MAX_CHARS);
  const dur = Number(a.duration) > 0 ? Number(a.duration) : 0;

  const messages = [
    {
      role: 'user',
      content: [
        '你是短视频字幕技师。把下面这段口播稿切成**逐条上屏的字幕**。',
        `硬要求：每条不超过 ${maxChars} 个汉字；按意群断，不许把词组切断；保留必要的标点；`,
        '不要加任何解释、不要加序号、不要加"字幕1"这类前缀；不要改写原意、不要新增内容。',
        dur > 0 ? `整片大约 ${Math.round(dur)} 秒，条数要能被这个时长读完（约每秒 5 个字）。` : '',
        '只返回一个 JSON：{ "lines": ["第一条", "第二条", "…"] }',
        '【原文】',
        script,
      ].filter(Boolean).join('\n'),
    },
  ];

  let res;
  try {
    res = await chatOnce(messages, {}, { temperature: 0.2, reasoningEffort: 'none' });
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'AI 调用失败' };
  }
  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || 'AI 没有返回内容' };
  }
  const parsed = extractJSON(res.content);
  let lines = [];
  if (parsed && Array.isArray(parsed.lines)) {
    lines = parsed.lines;
  } else if (parsed && Array.isArray(parsed.captions)) {
    // 兼容模型自作主张换了字段名的情况（它常常把 lines 叫 captions / subtitles）
    lines = parsed.captions.map((x) => (typeof x === 'string' ? x : (x && x.text)));
  }
  if (!lines.length) {
    // 模型没给 JSON ⇒ 退一步用它返回的纯文本按行切（这不是编造，是"它确实写了这些字"）
    const plain = String(res.content || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!plain.length) return { ok: false, error: 'AI 返回为空，没能切出字幕' };
    lines = plain;
  }

  const cleaned = [];
  for (const raw of lines) {
    const t = String(raw == null ? '' : raw).trim()
      .replace(/^[-*·•\d.、)）\s]+/, '') // 去掉模型爱加的列表符号
      .replace(/^["'「『]|["'」』]$/g, '');
    if (!t) continue;
    for (const piece of splitLong(t, maxChars)) cleaned.push(piece);
  }
  if (!cleaned.length) return { ok: false, error: 'AI 返回为空，没能切出字幕' };
  return { ok: true, lines: cleaned };
}
