'use strict';
/**
 * 豆芽记忆 2.0 · 调和器 Reconciler（A 阶段 #244 之二）
 * ============================================================================
 * 设计总纲：**记忆可以增长，但事实必须有来源；记忆可以更新，但不能无证据漂移。**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 本模块回答一个问题：**一条新候选，跟档案里已有的东西比，该怎么办？**
 * ────────────────────────────────────────────────────────────────────────────
 * 四种判定（老板拍板的「完整四判定」）：
 *   ADD       档案里没有 ⇒ 新增
 *   CONFIRM   同 key 同值 ⇒ 再确认一次（confirmedCount +1，lastSeen 更新）
 *   UPDATE    同 key 不同值、且新证据更强 ⇒ 更新（旧值进 supersedes 链）
 *   CONFLICT  同 key 不同值、且**无法判断谁对** ⇒ 待裁决（**绝不猜**）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 核心设计：冲突**先尝试语义拆分**，不急着覆盖
 * ────────────────────────────────────────────────────────────────────────────
 * 用户说「我在杭州」，后来说「我在上海」——这是**矛盾**吗？往往不是：
 *   · 家在杭州、当前在上海出差 ⇒ 两个事实**都成立**
 *   · 直接覆盖 ⇒ 丢掉「家在杭州」，而这条下次聊到家人/房产时还有用
 * ⇒ 所以冲突时先问："这两个值能不能各归其位？"
 *   能 ⇒ 拆成 `home=杭州` + `current_work_location=上海`，**两者都留**
 *   不能 ⇒ `pending_conflict`，**宁可不知道，不可猜错**
 *
 * 为什么"宁可不知道"是对的：猜错的代价是**注入一个假事实**，
 * 而模型会拿它当真相用（记忆层在 system 消息里，模型无从质疑）。
 * 不知道的代价只是"这次没帮上"。两者不对称 ⇒ 必须偏向"不猜"。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 三条守卫（"不能无证据漂移"的可执行形式）
 * ────────────────────────────────────────────────────────────────────────────
 *   G1 来源守卫：低权威来源**不可覆盖**高权威来源
 *      （inferred ≤0.40 永远盖不过 explicit_user 0.95+）
 *   G2 频次守卫：confirmedCount **只增不减**（在 memoryStore.normalizeEntry 已夹底，
 *      这里保证只做 +1，任何路径都不做 -1）
 *   G3 出处守卫：**无 quote 丢弃**（在 Extractor 已卡源头，这里做第二道）
 */

const { memorySecretGate, GATE_VERDICT } = require('./memorySecretGate');
const { LEDGER_OP } = require('./memoryStore');

// ============================================================================
// 1. 常量
// ============================================================================

/** 四种判定。 */
const VERDICT = Object.freeze({
  ADD: 'ADD',
  CONFIRM: 'CONFIRM',
  UPDATE: 'UPDATE',
  CONFLICT: 'CONFLICT',
  REJECT: 'REJECT',       // 被 Secret 硬门拒收 / 缺 quote —— 不是"记忆冲突"，是"不许进"
});

/**
 * 来源权威度（越高越可信）。
 *
 * ⚠️ 这是**跨来源比较**的唯一依据。为什么不用 confidence 直接比：
 *   confidence 是"这条值有多确信"，authority 是"这个来源有多可信"。
 *   一个 inferred 的 0.40 和一个 explicit_user 的 0.95，
 *   不是"差 0.55"，而是**性质不同** —— 前者是模型推测，后者是用户原话。
 *   ⇒ 用序关系而不是数值比较，规则更硬、更难被"调参"绕过。
 */
const SOURCE_AUTHORITY = Object.freeze({
  explicit_user: 5,
  system: 4,
  conversation: 3,
  imported: 2,
  inferred: 1,
});

/**
 * 拿来源权威度（未知来源按最低处理）。
 *
 * ⚠️ 为什么未知来源给 0（而不是给个中间值）：
 *    权威度是"这个值有没有权覆盖别人"的依据。**认不出的来源不该有权覆盖任何东西** ——
 *    这是 fail-closed：宁可保留旧的，也不让一个来路不明的值把已确认的事实顶掉。
 *
 * ⚠️ 但"静默给 0"是个陷阱（2026-10-05 自检时踩到）：
 *    调用方若因笔误传了数字（如 `source: 0.9` 而不是 `'explicit_user'`），
 *    它会被**静默**当成最弱来源 ⇒ 该调用方的所有写入都被静默降级，且没有任何提示。
 *    ⇒ 所以 isKnownSource 单独导出，让调用方/门禁能显式检查，而不是靠猜。
 */
function authorityOf(source) {
  const s = String(source == null ? '' : source);
  return SOURCE_AUTHORITY[s] || 0;
}

/** 判断来源标签是否是我们认识的（用于把"笔误"显式暴露出来，而不是静默降级）。 */
function isKnownSource(source) {
  const s = String(source == null ? '' : source);
  return Object.prototype.hasOwnProperty.call(SOURCE_AUTHORITY, s);
}

/** 冲突时可能用到的语义槽位拆分（key → 拆出的候选 key）。 */
const SEMANTIC_SPLITS = Object.freeze({
  'user.city': [
    { key: 'user.home_city', label: '常住地', re: /家|常住|老家|定居/ },
    { key: 'user.current_work_location', label: '当前工作地', re: /出差|派驻|目前在|现在在|暂时/ },
  ],
  'project.current': [
    { key: 'project.current', label: '当前项目', re: /正在|目前|最近/ },
    { key: 'project.previous', label: '上一项目', re: /之前|以前|上一?个|刚做完/ },
  ],
});

// ============================================================================
// 2. 工具
// ============================================================================

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 值归一化比较（去空白 + 大小写无关 + 全角/半角差异不敏感）。 */
function sameValue(a, b) {
  const na = String(a == null ? '' : a).replace(/\s+/g, '').toLowerCase();
  const nb = String(b == null ? '' : b).replace(/\s+/g, '').toLowerCase();
  return na === nb;
}

/** 找档案里同 key 的条目（取 active 的那条；都非 active 则取最后修改的）。 */
function findExisting(entries, key) {
  const list = Array.isArray(entries) ? entries : [];
  const same = list.filter((e) => e && e.key === key);
  if (!same.length) return null;
  const active = same.filter((e) => e.status === 'active');
  const pool = active.length ? active : same;
  return pool.slice().sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0))[0];
}

/** 命中候选 quote 里的哪个语义槽（用于拆分）。找不到 ⇒ null。 */
function pickSlot(key, quote) {
  const slots = SEMANTIC_SPLITS[key];
  if (!Array.isArray(slots)) return null;
  const q = String(quote || '');
  for (const s of slots) if (s.re.test(q)) return s;
  return null;
}

// ============================================================================
// 3. 单条调和
// ============================================================================

/**
 * 调和一条候选与既有条目。
 *
 * @param {{layer,key,value,source,confidence,quote}} cand
 * @param {Array} entries 该层的现有条目
 * @param {{now?:number}} [opts]
 * @returns {{verdict:string, reason:string, entry?:object, ledgerOp?:string, extra?:Array}}
 *          —— entry 是**应当写进该层的新条目**（调用方负责落盘）
 *          —— extra 是需要同时写入**其它层**的条目（语义拆分产生）
 */
function reconcileOne(cand, entries, opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();

  // ── 第 0 关：Secret 硬门（唯一敏感判定入口）──────────────────────────
  //    ⚠️ 必须先过这一关。低于它的任何逻辑（比较/拆分/更新）都不该看到敏感内容。
  const gate = memorySecretGate(cand);
  if (gate.verdict !== GATE_VERDICT.PASS) {
    // 拒收项**原样不进结果**，只留 reason（不含原文）供审计
    return { verdict: VERDICT.REJECT, reason: gate.reason, flags: gate.flags, key: gate.key || '' };
  }

  // ── 第 1 关：G3 出处守卫（第二道防线）────────────────────────────────
  if (!cand || !cand.key || !cand.value) {
    return { verdict: VERDICT.REJECT, reason: 'missing_key_or_value', key: (cand && cand.key) || '' };
  }
  const quote = clip(cand.quote, 240);
  if (!quote) {
    return { verdict: VERDICT.REJECT, reason: 'missing_quote', key: cand.key };
  }

  const existing = findExisting(entries, cand.key);

  // ★ 来源标签不合法 ⇒ 显式标注（不阻断，但让问题可见）。
  //   为什么不拒收：抽取器已经保证 source 合法；这里出现不合法说明**调用方接线有误**，
  //   那种问题该在日志/门禁里炸出来，而不是让用户的记忆静默消失。
  //   所以：照常处理（按最弱来源），但在返回值里带上 sourceInvalid 标记。
  const sourceInvalid = !isKnownSource(cand.source);

  // ── 新增 ────────────────────────────────────────────────────────────
  if (!existing) {
    return {
      verdict: VERDICT.ADD,
      reason: sourceInvalid ? 'no_existing_unknown_source' : 'no_existing',
      sourceInvalid,
      ledgerOp: LEDGER_OP.ADD,
      entry: {
        key: cand.key,
        value: cand.value,
        source: cand.source,
        confidence: Number(cand.confidence) || 0,
        firstSeen: now,
        lastSeen: now,
        confirmedCount: 1,            // ★ 首次出现即 1（"被确认过一次"）
        status: 'active',
        supersedes: '',
        evidence: [{ quote, at: now, source: cand.source }],
      },
    };
  }

  // ── 同值 ⇒ 再确认 ───────────────────────────────────────────────────
  if (sameValue(existing.value, cand.value)) {
    return {
      verdict: VERDICT.CONFIRM,
      // ★ 同值这条分支**也必须**带 sourceInvalid：来源非法是"输入层的事实"，
      //   它跟走哪条判定无关。首版只在 no_existing / weaker_source 两条分支带，
      //   而这两条在"档案已有同值条目"时根本走不到 ⇒ 笔误来源静默通过（门禁 S4j 抓到）。
      //   教训：标注类字段要挂在**所有出口**上，不能挂在其中几条出口上。
      reason: sourceInvalid ? 'same_value_unknown_source' : 'same_value',
      sourceInvalid,
      ledgerOp: LEDGER_OP.CONFIRM,
      entry: Object.assign({}, existing, {
        lastSeen: now,
        // ★ G2：只做 +1，任何路径都不做 -1
        confirmedCount: (Number(existing.confirmedCount) || 0) + 1,
        confidence: Math.max(Number(existing.confidence) || 0, Number(cand.confidence) || 0),
        evidence: [...(existing.evidence || []), { quote, at: now, source: cand.source }].slice(-8),
      }),
    };
  }

  // ── 不同值 ⇒ 先看来源权威度（G1）─────────────────────────────────────
  const authNew = authorityOf(cand.source);
  const authOld = authorityOf(existing.source);

  // ★ G1：新来源**弱于**旧来源 ⇒ 不覆盖，也不判冲突（旧事实仍然成立、且更可信）
  //   为什么不算 CONFLICT：冲突意味着"两个都可能是真的、需要人裁决"。
  //   而这里我们**有明确依据**判断谁更可信 ⇒ 直接保留旧的，不必打扰用户。
  if (authNew < authOld) {
    return {
      verdict: VERDICT.CONFIRM,
      reason: sourceInvalid ? 'weaker_source_kept_existing_unknown_source' : 'weaker_source_kept_existing',
      sourceInvalid,
      ledgerOp: LEDGER_OP.CONFIRM,
      // 注意：这里**不改 value**，只更新 lastSeen（"用户又提了一次这个话题"）
      entry: Object.assign({}, existing, { lastSeen: now }),
    };
  }

  // ── 试图语义拆分（"两者都成立"的最优解）────────────────────────────
  const slot = pickSlot(cand.key, quote);
  if (slot) {
    // 拆出的槽位与既有值不同 ⇒ 槽位是**新事实**，落到独立的 key 上，
    // **原 key 保持不动**（因为它描述的是另一个维度的位置）
    const slotExisting = findExisting(entries, slot.key);
    if (!slotExisting) {
      return {
        verdict: VERDICT.ADD,
        reason: (sourceInvalid ? 'semantic_split_add_unknown_source:' : 'semantic_split_add:')
          + slot.key + '←' + cand.key,
        sourceInvalid,
        ledgerOp: LEDGER_OP.ADD,
        entry: {
          key: slot.key,
          value: cand.value,
          source: cand.source,
          confidence: Number(cand.confidence) || 0,
          firstSeen: now,
          lastSeen: now,
          confirmedCount: 1,
          status: 'active',
          supersedes: '',
          evidence: [{ quote, at: now, source: cand.source }],
        },
      };
    }
    if (sameValue(slotExisting.value, cand.value)) {
      return {
        verdict: VERDICT.CONFIRM,
        reason: (sourceInvalid ? 'semantic_split_confirm_unknown_source:' : 'semantic_split_confirm:') + slot.key,
        sourceInvalid,
        ledgerOp: LEDGER_OP.CONFIRM,
        entry: Object.assign({}, slotExisting, {
          lastSeen: now,
          confirmedCount: (Number(slotExisting.confirmedCount) || 0) + 1,
          evidence: [...(slotExisting.evidence || []), { quote, at: now, source: cand.source }].slice(-8),
        }),
      };
    }
  }

  // ── 同权威度、拆不开 ⇒ 判 UPDATE（新证据更强）还是 CONFLICT（无法判断）
  //   判据：权威度更高 ⇒ 明确 UPDATE；权威度相同且**新值置信度明显更高** ⇒ UPDATE；
  //         否则 ⇒ CONFLICT（宁可不知道，不可猜错）
  const confNew = Number(cand.confidence) || 0;
  const confOld = Number(existing.confidence) || 0;
  const clearlyBetter = confNew - confOld >= 0.15;

  if (authNew > authOld || clearlyBetter) {
    return {
      verdict: VERDICT.UPDATE,
      reason: sourceInvalid
        ? 'unknown_source_but_outranks'
        : (authNew > authOld ? 'higher_authority' : 'higher_confidence'),
      sourceInvalid,
      ledgerOp: LEDGER_OP.SUPERSEDE,
      entry: Object.assign({}, existing, {
        value: cand.value,
        source: cand.source,
        confidence: confNew,
        lastSeen: now,
        confirmedCount: (Number(existing.confirmedCount) || 0) + 1,
        // ★ 可回溯链：新条目记住它替代了旧值，历史不丢
        supersedes: String(existing.value),
        evidence: [...(existing.evidence || []), { quote, at: now, source: cand.source }].slice(-8),
      }),
    };
  }

  // ── 无法判断 ⇒ 待裁决。**绝不猜。** ─────────────────────────────────
  return {
    verdict: VERDICT.CONFLICT,
    reason: sourceInvalid ? 'ambiguous_keep_both_unknown_source' : 'ambiguous_keep_both',
    sourceInvalid,
    ledgerOp: LEDGER_OP.CONFLICT,
    // pending_conflict 条目**不注入模型**（见 buildMemorySummary），
    // 但保留在档案里 ⇒ UI 可以让用户一键裁决，且**没有丢任何信息**
    entry: {
      key: cand.key + '@pending',
      value: cand.value,
      source: cand.source,
      confidence: confNew,
      firstSeen: now,
      lastSeen: now,
      confirmedCount: 1,
      status: 'pending_conflict',
      supersedes: String(existing.value),
      evidence: [{ quote, at: now, source: cand.source }],
    },
    conflictWith: { key: existing.key, value: existing.value, source: existing.source },
  };
}

// ============================================================================
// 4. 批量调和
// ============================================================================

/**
 * 对一批候选做调和，产出**按层分组的新条目集合**。
 *
 * ⚠️ 本函数**不落盘** —— 它只产出"应该写成什么样"。
 *    落盘是调用方（backend 接线）经 memoryStore.commit 的责任。
 *    为什么这样切：调和逻辑可以**纯函数式地被测试**（给定输入→期望输出），
 *    不需要临时文件、不需要 mock fs。这让"四判定 + 三条守卫"的判据非常干净。
 *
 * @param {Array} candidates
 * @param {Object} layers 现状：{ identity:[], orgs:[], prefs:[], projects:[] }
 * @param {{now?:number}} [opts]
 * @returns {{changes:Object, decisions:Array, rejected:Array, counts:Object}}
 *   changes: { layer: [新条目数组] }  —— 只有**发生了变化的层**才出现
 */
function reconcile(candidates, layers, opts) {
  const o = opts || {};
  const now = Number(o.now) || Date.now();
  const list = Array.isArray(candidates) ? candidates : [];
  const cur = layers && typeof layers === 'object' ? layers : {};

  const decisions = [];
  const rejected = [];
  // 用副本推进，保证同一批里多条候选能互相看见（例如先 ADD 再 CONFIRM 同一条）
  const working = {};
  const changed = {};
  for (const k of ['identity', 'orgs', 'prefs', 'projects']) {
    working[k] = Array.isArray(cur[k]) ? cur[k].slice() : [];
  }

  for (const cand of list) {
    let r;
    try {
      const layer = cand && cand.layer;
      if (!layer || !working[layer]) {
        r = { verdict: VERDICT.REJECT, reason: 'unknown_layer:' + layer, key: (cand && cand.key) || '' };
      } else {
        r = reconcileOne(cand, working[layer], { now });
      }
    } catch (e) {
      // 单条候选失败不连累整批（与旁路纪律一致）
      r = { verdict: VERDICT.REJECT, reason: 'reconcile_error:' + (e && e.message ? e.message : 'unknown'), key: (cand && cand.key) || '' };
    }

    if (r.verdict === VERDICT.REJECT) {
      rejected.push({ key: r.key || '', reason: r.reason, flags: r.flags || [] });
      decisions.push({ key: r.key || '', verdict: r.verdict, reason: r.reason });
      continue;
    }

    const layer = (cand && cand.layer) || '';
    const entry = r.entry;
    if (!entry || !working[layer]) {
      rejected.push({ key: (cand && cand.key) || '', reason: 'no_entry_produced' });
      continue;
    }

    // 写进工作副本：同 key 替换，否则追加
    const idx = working[layer].findIndex((e) => e && e.key === entry.key);
    if (idx >= 0) working[layer][idx] = entry;
    else working[layer].push(entry);

    changed[layer] = working[layer].slice();
    decisions.push({
      key: entry.key,
      verdict: r.verdict,
      reason: r.reason,
      ledgerOp: r.ledgerOp || LEDGER_OP.UPDATE,
      value: entry.value,
      supersedes: entry.supersedes || '',
      conflictWith: r.conflictWith || null,
    });
  }

  const counts = { ADD: 0, CONFIRM: 0, UPDATE: 0, CONFLICT: 0, REJECT: 0 };
  for (const d of decisions) if (counts[d.verdict] !== undefined) counts[d.verdict] += 1;

  return { changes: changed, decisions, rejected, counts };
}

/**
 * 把调和结果转成 memoryStore.commit 需要的 changes 形态 + ledger 行。
 *
 * ⚠️ 单独一个函数（而不是塞进 reconcile）的理由：
 *   reconcile 是**纯逻辑**（给定输入→给定输出，无副作用，好测）；
 *   这一步是**把逻辑翻译成副作用指令**。分开后，
 *   "判定对不对"和"落盘指令拼得对不对"可以分别测，出问题能精确定位。
 */
function toCommitChanges(result) {
  const r = result || {};
  const changes = [];
  const byLayer = r.changes && typeof r.changes === 'object' ? r.changes : {};

  // 先把每层的最新快照作为一条"整层覆写"变更
  for (const layer of Object.keys(byLayer)) {
    changes.push({ layer, entries: byLayer[layer], op: LEDGER_OP.UPDATE, key: '' });
  }

  // 再为每条判定补一条**语义明确的 ledger 行**（UI 时间线的数据源）
  const rows = [];
  for (const d of Array.isArray(r.decisions) ? r.decisions : []) {
    if (!d || d.verdict === VERDICT.REJECT) continue;
    rows.push({
      op: d.ledgerOp || LEDGER_OP.UPDATE,
      key: d.key,
      detail: {
        verdict: d.verdict,
        reason: d.reason,
        // ⚠️ 只放 value 的摘要，不放 quote 全文（quote 已在 entry.evidence 里，
        //    ledger 是流水，不需要把原话再存一份）
        value: typeof d.value === 'string' ? clip(d.value, 80) : '',
        supersedes: d.supersedes || '',
      },
    });
  }
  return { changes, ledgerRows: rows };
}

module.exports = {
  VERDICT,
  SOURCE_AUTHORITY,
  SEMANTIC_SPLITS,
  authorityOf,
  isKnownSource,
  sameValue,
  findExisting,
  pickSlot,
  reconcileOne,
  reconcile,
  toCommitChanges,
  clip,
};
