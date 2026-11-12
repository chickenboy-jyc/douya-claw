'use strict';
/**
 * 豆芽记忆 2.0 · 记忆摘要与注入（A 阶段 #245）
 * ============================================================================
 * 一条记忆从"被抽到"到"模型真的用上"，中间隔着的**最后一道也是唯一一道**关卡就是这里。
 * 前面所有环节（Extractor / Secret 门 / Reconciler / 存储）做得再对，
 * 如果这一段没接上，用户感受到的是**零变化** —— 记了等于没记。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 三条设计纪律
 * ────────────────────────────────────────────────────────────────────────────
 * ① **绝不阻塞主任务**（R5 旁路）。读档案失败、目录不存在、JSON 损坏 ——
 *    一律**静默降级成"不注入"**，绝不让记忆问题把主任务打崩。
 *    ⚠️ 但降级是**有返回值标记**的（injected:false + reason），不是假装成功。
 *
 * ② **只注入 active 条目**。`pending_conflict` / `stale` / 已过期一律不注入。
 *    为什么：注入进 system 消息的东西，模型**无从质疑** —— 它会当成既定事实。
 *    把"还可能不是真的"的值喂进去，等于让模型拿假事实推理，且用户看不到为什么。
 *
 * ③ **硬上限按层裁剪**，且裁剪是**确定性的**（同输入同输出）。
 *    为什么：注入预算是有限资源，被记忆吃掉的部分主任务就没了。
 *    无上限 ⇒ 记忆越用越多 ⇒ 某天突然把主任务的上下文挤爆，
 *    而症状是"豆芽变笨了"，没人会联想到是记忆太多。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 与 memoryStore 的边界
 * ────────────────────────────────────────────────────────────────────────────
 * 本模块**只读不写**。它 require memoryStore 的读函数，绝不碰任何写函数。
 * ⇒ 注入层即使被绕过，也不可能污染档案。这是"读路径"和"写路径"的物理分离。
 */

const store = require('./memoryStore');

// ============================================================================
// 1. 常量
// ============================================================================

/** 注入预算：整段记忆摘要的字符上限。超出按层优先级从后往前砍。 */
const SUMMARY_MAX_CHARS = 1200;

/**
 * 每层的注入条数上限（**在 TTL/active 过滤之后**再按此裁剪）。
 * 刻意比存储层上限（40/60/80/60）小得多：
 * 存储上限管的是"档案能存多少"，这里管的是"模型每轮要看多少"。
 * 两者是**不同的问题**，用同一个数字反而是设计缺陷。
 */
const INJECT_MAX_ENTRIES = Object.freeze({
  identity: 8,
  orgs: 6,
  prefs: 8,
  projects: 6,
});

/** 单条 value 在摘要里的最大字符数（超长截断，防一条脏数据吃掉整段预算）。 */
const VALUE_MAX_CHARS = 60;

/** 层标题（注入文案）。 */
const LAYER_TITLE = Object.freeze({
  identity: '关于用户',
  orgs: '用户所在组织',
  prefs: '用户偏好',
  projects: '用户当前在办',
});

/** 哪些 status 才允许注入。**白名单**，不是黑名单。 */
const INJECTABLE_STATUS = Object.freeze(['active']);

/** 注入段落的开头（模型据此识别"这是记忆"）。 */
const HEADER = '【关于这位用户的长期记忆】';

// ============================================================================
// 2. 工具
// ============================================================================

/** 去掉首尾空白并压掉换行（记忆值不该带换行，会破坏列表排版）。 */
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** 按字符截断（注意：这里用字符不是字节 —— 中文一个字算 1）。 */
function cut(s, n) {
  const t = oneLine(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * 判断一条条目是否可注入。
 *
 * ★ 为什么单独抽成函数：这条判定是"注入层唯一的安全阀"，
 *   必须能被门禁**定点**验证（喂一条 pending_conflict 进去看它返回 false）。
 *   内联在循环里就只能从外部间接观察。
 */
function isInjectable(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.key || !entry.value) return false;
  if (INJECTABLE_STATUS.indexOf(String(entry.status)) < 0) return false;
  // 防御：即使 status 被手工写成 active，lastSeen 异常也不注入（时钟错乱的兜底）
  const seen = Number(entry.lastSeen);
  if (seen && Number(now) && seen > Number(now) + 86400000) return false;  // 未来时间 >1 天 ⇒ 可疑
  return true;
}

/**
 * 按层挑出要注入的条目，并做确定性排序。
 *
 * 排序键（**必须确定性**，否则同一档案两次注入不同 ⇒ 前缀缓存失效、且无法回归）：
 *   ① confirmedCount 降序（被确认得越多越可信）
 *   ② confidence 降序
 *   ③ lastSeen 降序（越近越相关）
 *   ④ key 升序（**兜底键** —— 前三个全相等时靠它保证稳定，不能省）
 */
function pickForLayer(entries, layer, now) {
  const max = INJECT_MAX_ENTRIES[layer] || 6;
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => isInjectable(e, now));
  list.sort((a, b) => {
    const ca = Number(a.confirmedCount) || 0;
    const cb = Number(b.confirmedCount) || 0;
    if (ca !== cb) return cb - ca;
    const fa = Number(a.confidence) || 0;
    const fb = Number(b.confidence) || 0;
    if (fa !== fb) return fb - fa;
    const la = Number(a.lastSeen) || 0;
    const lb = Number(b.lastSeen) || 0;
    if (la !== lb) return lb - la;
    return String(a.key) < String(b.key) ? -1 : (String(a.key) > String(b.key) ? 1 : 0);
  });
  return list.slice(0, max);
}

// ============================================================================
// 3. 组装摘要
// ============================================================================

/**
 * 把四层档案组装成一段可注入的 system 文本。
 *
 * @param {string} owner 用户名（空 ⇒ 不注入，返回 null）
 * @param {object} [opts] { root, dataDir, now, maxChars }
 * @returns {{ok:boolean, text:string, reason:string, layers:Object, injected:boolean, entryCount:number}}
 */
function buildMemorySummary(owner, opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const maxChars = Number(o.maxChars) || SUMMARY_MAX_CHARS;
  const empty = (reason, extra) => Object.assign({
    ok: true, text: '', reason, layers: {}, injected: false, entryCount: 0,
  }, extra || {});

  // ── 门 1：owner 为空 ⇒ 绝不注入 ────────────────────────────────────────
  //   为什么是硬门：没有身份 ⇒ 读到的是"别人的档案"或者"公共档案"，
  //   注入进去就是**把别人的记忆当成这位用户的事实**。宁可这次不注入。
  if (!String(owner == null ? '' : owner).trim()) return empty('owner_required');

  let all;
  try {
    all = store.readAllLayers(owner, o);
  } catch (e) {
    // 读失败一律降级（R5）。注意：降级仍要如实标记，不能返回"成功但空"。
    return empty('read_failed:' + (e && e.message ? e.message : 'unknown'));
  }
  if (!all || !all.ok) {
    return empty('read_failed:' + ((all && all.errors && all.errors[0]) || 'unknown'));
  }

  // ── 组段 ──────────────────────────────────────────────────────────────
  const blocks = [];
  const picked = {};
  let count = 0;
  for (const layer of store.MEMORY_LAYERS) {
    const rows = pickForLayer(all.layers[layer], layer, now);
    if (!rows.length) continue;
    picked[layer] = rows;
    count += rows.length;
    const title = LAYER_TITLE[layer] || layer;
    blocks.push('· ' + title + '\n' + rows.map((e) => '  - ' + cut(e.value, VALUE_MAX_CHARS)).join('\n'));
  }

  if (!blocks.length) return empty('no_entries', { layers: {} });

  // ── 组装 + 硬上限裁剪 ────────────────────────────────────────────────
  const body = blocks.join('\n');
  let text = HEADER + '\n' + body;
  if (text.length > maxChars) {
    const SUFFIX = '\n…（记忆摘要已按预算截断）';
    text = text.slice(0, Math.max(0, maxChars - SUFFIX.length)) + SUFFIX;
  }

  return {
    ok: true,
    text,
    reason: 'ok',
    layers: picked,
    injected: true,
    entryCount: count,
  };
}

// ============================================================================
// 4. 注入
// ============================================================================

/**
 * 把记忆摘要注入 conversation（在 injectResumeState 之后、所有门控之前）。
 *
 * ⚠️ 注入位置很关键：必须在 compressContext + persona 之后。
 *   否则历史压缩会把这段吃掉，或者人设覆盖它 —— 表现为"明明记了却没生效"。
 *
 * @param {Array} conversation 对话消息数组（会被就地 push）
 * @param {string} owner 用户名
 * @param {object} [opts]
 * @returns {{injected:boolean, reason:string, chars:number, entryCount:number}}
 */
function injectUserMemory(conversation, owner, opts) {
  try {
    if (!Array.isArray(conversation)) {
      return { injected: false, reason: 'no_conversation', chars: 0, entryCount: 0 };
    }
    const summary = buildMemorySummary(owner, opts);
    if (!summary.injected || !summary.text) {
      return { injected: false, reason: summary.reason, chars: 0, entryCount: 0 };
    }
    conversation.push({ role: 'system', content: summary.text });
    return {
      injected: true,
      reason: 'ok',
      chars: summary.text.length,
      entryCount: summary.entryCount,
    };
  } catch (e) {
    // ★ 绝不向上抛（R5）：记忆是旁路，不能把主任务打崩。
    console.error('[Memory] inject user memory failed:', e && e.message);
    return { injected: false, reason: 'inject_failed:' + (e && e.message ? e.message : 'unknown'), chars: 0, entryCount: 0 };
  }
}

module.exports = {
  SUMMARY_MAX_CHARS,
  INJECT_MAX_ENTRIES,
  VALUE_MAX_CHARS,
  LAYER_TITLE,
  INJECTABLE_STATUS,
  HEADER,
  isInjectable,
  pickForLayer,
  buildMemorySummary,
  injectUserMemory,
  // 供门禁定点验证
  cut,
  oneLine,
};
