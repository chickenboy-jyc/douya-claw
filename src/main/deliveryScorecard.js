'use strict';

/**
 * deliveryScorecard —— 「一个任务的终态该记在账上的哪一栏」的**唯一算式**（2026-02-16）。
 *
 * 老板原话（口径来源，不是我的发明）：
 *   「报 BLOCKED 的任务**不计入失败率**」
 *   「报 BLOCKED 且诊断可复现的，算**一次有效交付**」
 *   「被查出**变造**的任务，计**双倍失效**」
 *   「终态枚举新增 BLOCKED_WITH_DIAGNOSIS 这一档」
 * ⇒ 本模块把这四句话变成可被单测逐字段核对的输出。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 四条铁律（改这个文件之前先读完；每一条都对应一个真出过的谎）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① **`scored === 0` 时 `failureRate` 返回 `null`，不是 0。**
 *      一个只会报 BLOCKED 的系统，失败率若报 0%，等于把"没样本"伪装成"零失败"——
 *      两个都长得很好看，但一个是真的，一个是在骗人。`null` + `noSample` + `reason`
 *      才能让读者分清"没有失败"和"没有样本"。
 *   ② **`failureRate` 可能 > 1，不许 clamp 到 1。**
 *      变造是双倍失效 ⇒ 3 条变造 / 3 条样本 = 200%。把它压回 100% 就是把"问题比样本还多"
 *      抹平成一个好看的数 —— clamp 就是造假。要解释就写在 `notes` 里，不许改数。
 *   ③ **`excludedBlocked` 必须出现在输出里。**
 *      不给这个数，读者无法判断分母被削了多少：削掉 1 条和削掉 900 条，失败率的含义完全不同。
 *   ④ **`tamperedCount === 0` 不等于「零变造」。**
 *      变造判定只覆盖**保管白名单内**的产物（当前只有 `.pptx`，见 `src/main/backend.js`
 *      的 `CUSTODY_PROTECTED_EXT`）。一份跑在 .html / .md / .png 产物任务上的账，
 *      `tamperedCount` **恒为 0** —— 那个 0 的意思是"这些产物压根没被保管、无从比对"，
 *      不是"检查过没问题"。
 *      ⇒ 所以 `tamperedUnverifiable` 必须输出，且 `tamperedCount === 0 且
 *      tamperedUnverifiable > 0` 时 `notes` 必须把这两件事分开说；
 *      **不许**给出任何"干净 / 零变造 / 已验证"式的结论字段（有执行者会检查这一点）。
 *      与铁律①是同一个病的两个部位：**宁可承认看不见，也不许报一个假的零。**
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 为什么是一个独立模块（而不是塞进 deliveryProtocol.js）
 * ───────────────────────────────────────────────────────────────────────────
 *   · deliveryProtocol 管的是「**一个任务**该判什么终态」（判定）；
 *     本模块管的是「**一批任务**的终态该怎么记账」（统计）。判定错了去改那边，
 *     口径错了来改这边，改的地方不同 ⇒ 不该挤在同一个文件里。
 *   · deliveryProtocol.js 是**冻结申报文件**（unit-onboarding-v2 的 FROZEN_PATCHES），
 *     往里加统计代码每加一次都要重抠申报；口径这种"会反复被老板调"的东西放在冻结文件里，
 *     等于每改一次口径就动一次申报 —— 迟早有人为了省事去放宽申报。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 边界（如实写，不假装全能）
 * ───────────────────────────────────────────────────────────────────────────
 *   · 本模块**不认识"诊断是否可复现"**。它只读 `terminal` 这个字符串。
 *     "这条 BLOCKED_WITH_DIAGNOSIS 是不是真货"由 `deliveryProtocol.classifyBlockedDiagnosis`
 *     按执行证据判 —— 判定在前，记账在后。**记账不重判**，否则两处判据必然漂移。
 *   · 本模块**不计算**"变造"是怎么查出来的，也**不从 custody 内部推断**。
 *     `tampered` 只接受**外部传入的布尔**（由 `artifactCustody.audit()` 的 `tampered[]`
 *     得出）。本模块不认 `unverified` 列表、不自己比 sha1、不看 `missing`。
 *     理由在 `artifactCustody.js:1938`：`unverified`（无法核验）**既不许折进 `tampered`**
 *     （那是冤枉，它只是"没看成"，没有一类 reason 声称字节变了），
 *     **也不许折进"正常"**（那是瞒报）。这两条纪律只能靠"根本不看 unverified"来保证。
 *   · 本模块同样**不判断"产物是否在保管范围内"**。它只读 `custodyCovered` 这个外部布尔。
 *     判断在 `backend.js`（`.pptx` 白名单）：只有白名单内的产物会被 `keep()` 进基线、
 *     才会被 `audit()` 比对，非白名单产物永远 `unverified / never_kept`。
 *     ⇒ 账本侧的责任只是**把"没检查过"如实报成"没检查过"**。
 *   · `custodyIndexCorrupt` 同理是外部事实：`artifactCustody.audit()` 的 `index.corrupt`
 *     为 true 时，`tampered` 读数**偏低**（实测：索引与事件同时损坏，
 *     `tampered 1` 掉到 `tampered 0` / `unverified 3`，见 `artifactCustody.js:347-353`）。
 *     账本侧不许把这种读数当"零变造"的证据，只能把它标成不可信。
 *   · 本模块是纯函数、**零 require**（连 deliveryProtocol 都不 require）⇒ 门禁可以
 *     把源码做文本变异后用 `new Function` 直接求值，不必落临时文件（反控才划算）。
 *     代价是终态那四个字符串在这里**有一份副本**。这份副本由
 *     `scripts/smoke/unit-delivery-scorecard.mjs` 的 S0 组钉住（逐值与
 *     `deliveryProtocol.TERMINAL` 比对，漂了必红）—— 有执行者守着的副本才允许存在。
 *     `CUSTODY_PROTECTED_EXT` 这份副本同理，由 S0-e/S0-f 从 `backend.js` 源码抽出来比对。
 */

/**
 * 终态字面量（**副本**，唯一真源是 `deliveryProtocol.TERMINAL`）。
 * 为什么可以存在副本：本模块零 require 才能被 new Function 求值做反控（见文件头边界）。
 * 为什么不会漂：unit-delivery-scorecard 的 S0 组逐个值与 deliveryProtocol.TERMINAL 比对。
 */
const TERMINAL_VALUES = {
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  BLOCKED: 'BLOCKED',
  BLOCKED_WITH_DIAGNOSIS: 'BLOCKED_WITH_DIAGNOSIS',
};

/**
 * 保管白名单（**副本**，唯一真源是 `src/main/backend.js` 的 `CUSTODY_PROTECTED_EXT`）。
 *
 * ⚠️ 为什么必须在账本里也有一份：`notes` 要写人话告诉读者"变造判定只覆盖到哪"，
 *    而这句话必须能随白名单**一起**变化 —— 如果账本里写死 `.pptx` 而白名单扩了，
 *    读者会按一句过期的话去理解读数；反过来白名单缩了而账本没跟上，
 *    读者会以为"查过了"（瞒报）。
 * ⚠️ 为什么不怕漂：`unit-delivery-scorecard` 的 S0-e **从 backend.js 源码文本里抽**
 *    这个常量的字面值逐值比对；S0-f 断言"真的抽到了"——抽不到就红，
 *    因为抽不到就等于"只覆盖某些扩展名"这句话失去了证据支撑。
 */
const CUSTODY_PROTECTED_EXT = ['.pptx'];

/** 变造任务的失效**权重**（老板口径：双倍失效）。单独成常量是为了让反控能点名它。 */
const TAMPERED_FAILURE_WEIGHT = 2;

/** 纯函数、导出给门禁/运维复算口径用的说明文案（与 scoreDelivery 的 notes 同一份）。 */
const SCORECARD_RULES = [
  '报 BLOCKED（纯阻塞）的任务不进失败率分母，单独计入 excludedBlocked —— 它既不算成功也不算失败。',
  'BLOCKED_WITH_DIAGNOSIS 算一次有效交付：卡住了，但卡点已定位到可复现，用户拿去就能接。',
  'COMPLETE 算一次有效交付。',
  'PARTIAL 计 1 次失效。',
  '变造（tampered）无论终态是什么，一律计 2 次失效，且**不进** effectiveDelivery —— 它宣称的交付是假的。',
  '未知终态（空串 / 没见过的值）单独计入 unknownCount：不进 failures、不进 effectiveDelivery，但**计入分母**。',
  'failureRate 在 scored===0 时返回 null（不是 0）；它可能 > 1（变造双倍失效），**不许 clamp**。',
  'tampered 只认外部传入的 `tampered === true`：custody 的 `unverified`（无法核验）既不许折成变造，也不许折成正常。',
  'custodyCovered 为假（含缺省）的产物「没被保管过 ⇒ 没被比对过」，其条数由 tamperedUnverifiable 如实报出。',
  'custody 索引损坏时 tamperedCount 偏低，由 custodyReadoutUnreliable 标成不可信读数。',
];

/**
 * 把一批任务终态折成一份可公开的账。
 *
 * 分类规则（**优先级从上到下，命中即止**；顺序即语义，调换顺序就会改变口径）：
 *   1) `tampered === true`            → 变造：失效 +2（无论终态），且不计入 effectiveDelivery
 *   2) `terminal === BLOCKED`         → 纯阻塞：从分母剔除（excludedBlocked）
 *   3) `terminal === BLOCKED_WITH_DIAGNOSIS` → 有效交付，不计失效，**不**从分母剔除（它算样本）
 *   4) `terminal === COMPLETE`        → 有效交付
 *   5) `terminal === PARTIAL`         → 失效 +1
 *   6) 其它（未知值 / 空串）           → unknown：报出条数，不进失败也不进有效交付，但计入分母
 *
 * 记账之外的**三组事实**（与终态分类正交，所以先算、且对每一条记录都算）：
 *   · `custodyCovered`       —— 该任务产物是否落在保管白名单内（只有严格 `=== true` 算覆盖）
 *   · `custodyIndexCorrupt`  —— 该任务所在 custody 库的索引此刻是否不可信
 *   · `tampered`             —— 外部审计结论；`unverified` **不是**变造，本模块也不收 `unverified`
 *
 * @param {Array<{
 *   terminal?:string,
 *   tampered?:boolean,
 *   custodyCovered?:boolean,
 *   custodyIndexCorrupt?:boolean
 * }>} records
 * @returns {{
 *   total:number, scored:number, failures:number, failureRate:number|null,
 *   effectiveDelivery:number, effectiveRate:number|null,
 *   excludedBlocked:number, tamperedCount:number, unknownCount:number,
 *   custodyCoveredCount:number, tamperedUnverifiable:number,
 *   custodyIndexCorruptCount:number, custodyContradictionCount:number,
 *   custodyReadoutUnreliable:boolean,
 *   noSample:boolean, reason:string, notes:string[]
 * }}
 */
function scoreDelivery(records) {
  const list = Array.isArray(records) ? records : [];
  let excludedBlocked = 0;
  let tamperedCount = 0;
  let unknownCount = 0;
  let failures = 0;
  let effectiveDelivery = 0;
  // ---- 记账之外的三组事实 ----
  let custodyCoveredCount = 0;
  let tamperedUnverifiable = 0;
  let custodyIndexCorruptCount = 0;
  let custodyContradictionCount = 0;

  for (const r of list) {
    // 畸形条目（null / 字符串）不许抛：这份清单来自运行时台账，一个脏条目不该毁掉整份账。
    // 它们的 terminal 视作 '' ⇒ 落进 unknown 桶（**不许**默认当成成功，也不许默认当成失败）。
    const rec = (r && typeof r === 'object') ? r : {};
    const terminal = typeof rec.terminal === 'string' ? rec.terminal : '';

    // ---- 先记"这条有没有被检查过"，因为它与终态无关（BLOCKED 也可以有产物）----
    // 为什么必须严格 `=== true`：`'yes'` / `1` / `[]` 都是真值 ⇒ 一个字符串笔误
    // 就能把"没检查过"伪装成"检查过"，而那正是铁律④要防的那个谎。
    // 为什么缺省**不**算覆盖：宁可多报"没检查过"（读者只会更谨慎），
    // 也不许默认"查过了"（那是瞒报，而且查不出来的东西最像查过了）。
    const covered = rec.custodyCovered === true;
    if (covered) {
      custodyCoveredCount += 1;
    } else {
      // 没被保管过 ⇒ 永远拿不到 tampered 判定（audit 只会回 unverified/never_kept）。
      tamperedUnverifiable += 1;
    }

    // 索引损坏 ⇒ 这一条的 tampered 读数**本身**偏低（不是"错了"，是"该说的话说不出来"）。
    // 刻意**不**重复计入 tamperedUnverifiable：那个数只表达"没检查过"一件事，
    // 混进"检查了但读数不可信"会让它同时表达两件事，两个意思都读不出来。
    if (rec.custodyIndexCorrupt === true) custodyIndexCorruptCount += 1;

    // ① 变造优先：无论终态是什么，它宣称的交付都是假的 ⇒ 双倍失效，且**不进**有效交付。
    //    为什么把变造排在最前：一条 COMPLETE + 变造的任务，若按 COMPLETE 记就是
    //    "既算一次有效交付、又算两次失效"—— 那等于说"它虽然造假，但确实交付了"，是自相矛盾的账。
    if (rec.tampered === true) {
      tamperedCount += 1;
      failures += TAMPERED_FAILURE_WEIGHT;
      // 矛盾输入：不在保管白名单内的产物**不可能**拿到 tampered 判定
      // （backend.js:4732 只把白名单内的产物喂给 audit，非白名单恒为 unverified/never_kept）。
      // 出现这种组合只能说明调用方把两个字段接错了线。
      // 落账方向：**照计变造**（少报变造比多报危险得多），但把条数报出来，不许静默。
      if (!covered) custodyContradictionCount += 1;
      continue;
    }
    // ② 纯阻塞：不进分母。注意它**不是**被当成成功 —— 它是被移出样本，且这个移除量必须报出来。
    if (terminal === TERMINAL_VALUES.BLOCKED) {
      excludedBlocked += 1;
      continue;
    }
    // ③ 有诊断的阻塞：算一次有效交付，但仍留在分母里（它是有信息量的样本，不是"没结论"）。
    if (terminal === TERMINAL_VALUES.BLOCKED_WITH_DIAGNOSIS) {
      effectiveDelivery += 1;
      continue;
    }
    // ④ 完成：有效交付。
    if (terminal === TERMINAL_VALUES.COMPLETE) {
      effectiveDelivery += 1;
      continue;
    }
    // ⑤ 半成品：失效一次（权重 1）。
    if (terminal === TERMINAL_VALUES.PARTIAL) {
      failures += 1;
      continue;
    }
    // ⑥ 未知：单独报出条数。不进 failures / effectiveDelivery，但它在分母里
    //    —— 未知状态既不许被悄悄当成成功，也不许被悄悄当成失败。
    unknownCount += 1;
  }

  const total = list.length;
  const scored = total - excludedBlocked;
  // ★ 铁律①：没有可评样本时返回 null，绝不返回 0（0 会被读成"零失败"）。
  const failureRate = scored === 0 ? null : failures / scored;
  // 有效交付率的分母是 total（纯阻塞也是"接到过的任务"，只是不计失败率）——
  // 它与 failureRate 的分子分母**故意不同**：一个是"有效交付占全部任务"，
  // 一个是"失败占可评样本"。两个数不要互相反推，含义不同。
  const effectiveRate = total === 0 ? null : effectiveDelivery / total;
  const noSample = scored === 0;
  // ★ 铁律④的机器可读形态：有任何一条索引损坏 ⇒ 本次 tamperedCount **不可作为证据**。
  const custodyReadoutUnreliable = custodyIndexCorruptCount > 0;

  const notes = SCORECARD_RULES.slice();
  if (noSample) {
    notes.push('本批 scored=0（分母被 BLOCKED 或样本量为 0 清空了）⇒ failureRate 是 null 而不是 0：'
      + '"没有可评样本"与"零失败"是两件事，不许混。');
  }
  if (failures > scored) {
    notes.push('failures(' + failures + ') > scored(' + scored + ') 是**正常的**：变造按双倍失效入账'
      + '（权重 ' + TAMPERED_FAILURE_WEIGHT + '）⇒ failureRate 可能大于 1。**不许 clamp 到 1**，'
      + '那个数字表达的正是"问题比可评样本还多"。');
  }
  // ★ 铁律④：把"没检查过"这件事写成读者看得见的一句话。
  //   这句话**必须**能随白名单一起变（所以用常量拼），也必须能被门禁按措辞抓（所以是固定句式）。
  if (tamperedUnverifiable > 0) {
    notes.push('变造判定只覆盖 ' + CUSTODY_PROTECTED_EXT.join('/') + '（backend.CUSTODY_PROTECTED_EXT）；'
      + '其余 ' + tamperedUnverifiable + ' 条产物的「无变造」是「没检查过」，不是「检查过没问题」。');
  }
  if (tamperedCount === 0 && tamperedUnverifiable > 0) {
    notes.push('★本批 tamperedCount=0，但有 ' + tamperedUnverifiable + ' 条产物没被保管过 ⇒ '
      + '这个 0 **不是**「零变造」的证据：它们是没检查，不是检查了没问题。'
      + '要读「零变造」，先让 tamperedUnverifiable 归零。');
  }
  if (custodyIndexCorruptCount > 0) {
    notes.push('变造读数不可信（custody 索引损坏 ' + custodyIndexCorruptCount + ' 条）：'
      + '损坏时真实变造会被记成 unverified，tamperedCount 偏低。'
      + '不许把本次读数当作「零变造」的证据。');
  }
  if (custodyContradictionCount > 0) {
    notes.push('另有 ' + custodyContradictionCount + ' 条同时是 tampered 且「不在保管白名单内」—— '
      + '这个组合在现有接线下**不可能**成立（backend.js:4732 只把白名单内的产物喂给 audit），'
      + '多半是调用方把两个字段接错了线。本模块仍按变造照计双倍失效（少报变造比多报危险），'
      + '但这个数不许被静默。');
  }

  return {
    total,
    scored,
    failures,
    failureRate,
    effectiveDelivery,
    effectiveRate,
    excludedBlocked,
    tamperedCount,
    unknownCount,
    // ---- 三组事实的出口（铁律④要求它们必须出现在输出里）----
    custodyCoveredCount,
    tamperedUnverifiable,
    custodyIndexCorruptCount,
    custodyContradictionCount,
    custodyReadoutUnreliable,
    noSample,
    reason: noSample ? 'no-scored-sample' : '',
    notes,
  };
}

module.exports = {
  scoreDelivery,
  TERMINAL_VALUES,
  CUSTODY_PROTECTED_EXT,
  TAMPERED_FAILURE_WEIGHT,
  SCORECARD_RULES,
};
