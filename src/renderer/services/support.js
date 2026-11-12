/**
 * ============================================================================
 * 客服助手 · 服务层
 * ----------------------------------------------------------------------------
 * 职责（渲染层，三件事）：
 *   ① 转发提交：把表单经 api.supportSubmit 交给主进程（主进程再转发 api.example.com）。
 *   ② 本地历史：留存「我自己提交过」的记录，**永久保留**（老板需求变更：原「保留 7 天」已取消
 *      ⇒ 不再按时间剔除任何记录；历史只增不减，除非用户手动清空）。
 *   ③ 前端 2MB 预检：提交前先量一遍请求体字节数，超限**提前**给出中文提示（省一次往返）。
 *      —— 但**权威闸门在主进程**（src/main/supportProxy.js），前端预检只是体验优化，
 *         不能替代主进程校验（两者判据同值：FEEDBACK_MAX_BYTES）。
 *
 * 类型枚举与文案：与线上后台下拉真源一致（bug/feature/experience/other 4 值）。
 *
 * 容量策略（务必与实现保持一致）：`SUPPORT_HISTORY_MAX_ITEMS = 50` **不是保留期**，
 *   它只防"无限增长"。超上限时**整列拒绝写入** —— 绝不静默裁剪旧记录（静默剪旧 = 变相保留期，
 *   与已取消的 7 天淘汰属同一类问题）；改为把已有记录原样写回，并显式回传 `truncated: true`，
 *   由调用方（submitFeedback）如实告知用户「历史已满、本次未记入历史」。
 *
 * @module services/support
 */
import { supportSubmit } from '../api.js';

/** 请求体硬上限：2MB（与主进程 supportProxy.FEEDBACK_MAX_BYTES 同值）。 */
export const FEEDBACK_MAX_BYTES = 2 * 1024 * 1024;

/** 本地提交历史的存储 key。 */
export const SUPPORT_HISTORY_KEY = 'douya-support-history';

/**
 * 本地提交历史条数上限（**只防无限增长，不是保留期**）。
 * ⚠️ 超上限时**整列拒绝写入**，绝不静默裁剪旧记录（详见 writeHistory）。
 */
export const SUPPORT_HISTORY_MAX_ITEMS = 50;

/**
 * 反馈类型选项（4 选 1）：value = 提交给后端的枚举值；label/desc = 界面文案。
 * 顺序即展示顺序；label 前缀 emoji 取自需求。
 */
export const FEEDBACK_TYPE_OPTIONS = Object.freeze([
  { value: 'bug', label: '🐛 问题报告', desc: '功能报错、崩溃、显示异常' },
  { value: 'feature', label: '💡 功能建议', desc: '希望新增的能力' },
  { value: 'experience', label: '⚡ 体验问题', desc: '不好用、太慢、步骤多' },
  { value: 'other', label: '📌 其他', desc: '其他想说的话' },
]);

/** 合法类型值集合（供校验；由 FEEDBACK_TYPE_OPTIONS 派生，单一事实源）。 */
export const FEEDBACK_TYPE_VALUES = Object.freeze(FEEDBACK_TYPE_OPTIONS.map((o) => o.value));

/**
 * UTF-8 字节数（2MB 判据用真实字节，不是字符数）。
 * 优先用 TextEncoder（渲染层可用）；不可用时退回手算（代理对按 2 个码元计）。
 * @param {string} s
 * @returns {number}
 */
export function utf8ByteLength(s) {
  const str = String(s == null ? '' : s);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } // 代理对
    else n += 3;
  }
  return n;
}

/**
 * 把表单输入规整成请求体（字段名与后端契约逐字对齐；可选字段非空才带上）。
 * @param {{type?:string, title?:string, description?:string, contact?:string}} input
 * @returns {{type:string, description:string, title?:string, contact?:string}}
 */
export function buildPayload(input) {
  const src = input && typeof input === 'object' ? input : {};
  const payload = {
    type: String(src.type == null ? '' : src.type).trim(),
    description: String(src.description == null ? '' : src.description),
  };
  const title = src.title == null ? '' : String(src.title);
  if (title !== '') payload.title = title;
  const contact = src.contact == null ? '' : String(src.contact);
  if (contact !== '') payload.contact = contact;
  return payload;
}

/**
 * 前端提交前预检（**非权威闸门**，权威在主进程）。
 * @param {object} input
 * @returns {{ok:boolean, payload?:object, size?:number, error?:string}}
 */
export function precheckPayload(input) {
  const payload = buildPayload(input);
  if (!payload.type) return { ok: false, error: '请选择反馈类型' };
  if (!FEEDBACK_TYPE_VALUES.includes(payload.type)) return { ok: false, error: '反馈类型不合法' };
  if (!payload.description.trim()) return { ok: false, error: '请填写问题描述' };
  const size = utf8ByteLength(JSON.stringify(payload));
  if (size > FEEDBACK_MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(2);
    return { ok: false, size, error: `反馈内容过大（${mb}MB，超过 2MB 上限），请精简后重试` };
  }
  return { ok: true, payload, size };
}

/** 读存储里的原始数组（**不做任何裁剪**；解析失败 / 非数组 ⇒ 空数组）。 */
function readRawHistory() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SUPPORT_HISTORY_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 把数组落盘（隐私模式 / 配额失败一律吞掉，不影响提交主流程）。 */
function persistHistory(list) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SUPPORT_HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式/配额满：不影响提交主流程 */
  }
}

/**
 * 规整本地历史：**只做有效性过滤 + 时间倒序**，不做任何容量 / 保留期裁剪。
 *
 * · 保留 `e.at <= t`：这是挡「时钟回拨 / 未来时间戳」的**防御**，与保留期无关 ——
 *   正因如此它必须留着；`now` 形参也**仅为这一个判别服务**（已不再是"保留期基准"）。
 * · ⚠️ 容量上限（SUPPORT_HISTORY_MAX_ITEMS）**刻意不在这里执行**：这里若 slice，
 *   就是静默裁剪旧记录（= 变相保留期）。容量由 writeHistory 以「整列拒绝」方式处理。
 *
 * @param {Array} list 原始记录数组
 * @param {number} [now] 当前时间戳（仅用于未来时间戳防御）
 * @returns {Array}
 */
export function pruneHistory(list, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const arr = Array.isArray(list) ? list : [];
  return arr
    .filter((e) => e && typeof e === 'object' && Number.isFinite(e.at) && e.at <= t)
    .sort((a, b) => b.at - a.at);
}

/**
 * 读取本地历史（永久保留：不再过滤任何"过期"记录）。
 * @param {number} [now]
 * @returns {Array}
 */
export function readHistory(now) {
  return pruneHistory(readRawHistory(), now);
}

/**
 * 写入本地历史（**容量上限的唯一执行点**）。
 *
 * 语义（与"永久保留"一致）：
 *   · 正常（≤ SUPPORT_HISTORY_MAX_ITEMS）⇒ 整列落盘，返回 { truncated:false }；
 *   · 超上限 ⇒ **整列拒绝写入**：绝不静默裁剪旧记录，而是把存储里**已有的记录原样写回**
 *     （不改动），并返回 { list:已有记录, truncated:true }，让调用方如实告知用户。
 *
 * @param {Array} list
 * @param {number} [now] 当前时间戳（仅用于未来时间戳防御，读写同源）
 * @returns {{list:Array, truncated:boolean}}
 */
export function writeHistory(list, now) {
  const pruned = pruneHistory(list, now);
  if (pruned.length > SUPPORT_HISTORY_MAX_ITEMS) {
    // 容量已满：整列拒绝。把已有记录原样写回（readRawHistory 不做任何裁剪 ⇒ 不是"淘汰旧的"）。
    const existing = pruneHistory(readRawHistory(), now);
    persistHistory(existing);
    return { list: existing, truncated: true };
  }
  persistHistory(pruned);
  return { list: pruned, truncated: false };
}

/**
 * 追加一条提交记录并落盘。
 *
 * ⚠️ `now` 的作用已被"永久保留"**收窄为两点**：① 作为新记录的时间戳；② 参与 pruneHistory
 * 的**未来时间戳防御**。它**不再**决定任何保留期。形参保留的理由：若读、写两处用了不同
 * 时间源，就会出现「读了 N 条、写回时又按另一个时钟筛一遍」的错位（本仓踩过的"假缝"）——
 * 所以 `now` 必须一路贯穿 readHistory 与 writeHistory。
 *
 * @param {{type:string, title?:string, description?:string, message?:string}} entry
 * @param {number} [now]
 * @returns {{list:Array, truncated:boolean}} truncated=true 表示历史已满、本次**未记入**
 */
export function appendHistory(entry, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const cur = readHistory(t);
  const record = {
    at: t,
    type: String((entry && entry.type) || ''),
    title: String((entry && entry.title) || ''),
    description: String((entry && entry.description) || ''),
    message: String((entry && entry.message) || ''),
  };
  return writeHistory([record, ...cur], t);
}

/** 清空本地历史。 */
export function clearHistory() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(SUPPORT_HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 提交反馈主入口（服务层）：预检 → 交主进程转发 → 成功后记本地历史。
 * 返回 { ok, message?, error? }；永不自抛。
 *
 * 历史已满（truncated）时**不静默**：提交本身仍成功，但在 message 里如实补一句
 * 「本地历史已满 N 条，本次未记入历史」，避免用户以为记录还在。
 *
 * @param {{type:string, title?:string, description:string, contact?:string}} input
 * @param {number} [now]
 * @returns {Promise<{ok:boolean, message?:string, error?:string}>}
 */
export async function submitFeedback(input, now) {
  const check = precheckPayload(input);
  if (!check.ok) return { ok: false, error: check.error };
  const res = await supportSubmit(check.payload);
  if (res && res.ok) {
    const message = res.message || '反馈提交成功！';
    const w = appendHistory(
      {
        type: check.payload.type,
        title: check.payload.title || '',
        // 本地只留描述摘要，避免历史本身堆到很大
        description: String(check.payload.description || '').slice(0, 200),
        message,
      },
      now,
    );
    // 历史已满 ⇒ 本次未记入本地历史：如实告知（静默会让用户误以为记录还在）。
    if (w && w.truncated) {
      return { ok: true, message: `${message}（提示：本地历史已满 ${SUPPORT_HISTORY_MAX_ITEMS} 条，本次未记入历史）` };
    }
    return { ok: true, message };
  }
  return { ok: false, error: (res && res.error) || '提交失败，请稍后重试' };
}
