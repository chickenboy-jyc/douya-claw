'use strict';
/**
 * 工作流快照注入（snapshot() 注入实验）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一句话：把**账本里已有的执行事实**作为一条 system 消息交给模型，
 *        让它接着已有进度干活，而不是每一轮从零猜「上次做到哪了」。
 *
 * ── 为什么需要这个（问题是什么）──────────────────────────────────────────────
 * 实测现状：`wfCtl.snapshot()` 只被两处消费 ——
 *   `backend.js:4147` console.log + taskTrace.record(phase:'start')
 *   `backend.js:4178` taskTrace.record(phase:'end')
 * ⇒ 它对**模型上下文一次都没进过**。模型完全不知道账本里「已完成 outline>build」，
 *   于是跨请求续跑时会把已经做好的产物重做一遍（本项目实测过：4 次 SIGKILL 续跑，
 *   2 次产物 sha1 变了，根因就是重做覆盖）。
 *
 * ── 这个模块的纪律（改之前先把这五条读完，它们是本模块存在的理由）──────────
 * ① **只写事实**。写了什么就标什么来源（账本字段名 / 磁盘实测）。
 * ② **不写判决**。禁止出现「全部完成」「可以收尾」「已经做好」「验收通过」这类结论。
 *    完成与否由 `workflowRunner.evaluate()` 按磁盘证据独立计算，本模块输出
 *    **不参与任何判据**（它只是一条 system 文本，没有任何代码读它做判断）。
 * ③ **不写推测**。拿不到的值写「未记录」，绝不补一个看起来合理的默认值。
 * ④ **标注哪些检查还没跑**。`checks()` 返回的是「收尾会逐项跑的检查清单」，
 *    不是「已经通过的检查」。混淆这两者是本实验最需要防的伪事实。
 * ⑤ **伪造也不能变成判决**（反控用）。即使上游喂进来一份「所有阶段都完成」的假账，
 *    本模块也只会如实转述「账本这么写」，并明确写出「这不构成验收结论」。
 *
 * ── 开关 ───────────────────────────────────────────────────────────────────
 * 默认**关**。`DOUYA_SNAP_INJECT=1` 才注入 ⇒ 不设环境变量时行为与改造前逐字一致，
 * 未注入对照组天然等于基线，不需要另一份代码。
 * `DOUYA_SNAP_INJECT_FAKE=<json路径>` 仅用于反控实验：用该文件内容覆盖账本字段。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 最多展示几个产物指纹（多到几十个只会淹掉上下文，而且 sha1 要读盘） */
const MAX_DECKS = 3;
/** 超过这个大小就不算 sha1（大文件读盘会拖慢首轮；改为只报 size/mtime 并写明未算） */
const MAX_HASH_BYTES = 64 * 1024 * 1024;

function isEnabled() {
  return process.env.DOUYA_SNAP_INJECT === '1';
}

/** 反控入口：伪造账本。读不到/解析失败一律返回 null（不静默造假）。 */
function readFake() {
  const p = process.env.DOUYA_SNAP_INJECT_FAKE;
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch {
    return null;
  }
}

function sha1Of(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > MAX_HASH_BYTES) return null;
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function fmtTime(p) {
  try { return new Date(fs.statSync(p).mtimeMs).toISOString(); } catch { return null; }
}

/** 数组 → 「a > b > c」；空数组 → null（调用方决定怎么写「无」） */
function joinStages(arr) {
  const list = (arr || []).map((x) => String(x || '')).filter(Boolean);
  return list.length ? list.join(' > ') : null;
}

/**
 * 组装注入文本。
 *
 * @param {object} input
 * @param {object} input.snap      `wfCtl.snapshot()` 的返回值（8 字段）
 * @param {Array}  [input.checks]  `wfCtl.checks()` —— 收尾要跑的检查定义，**不是**跑过的结果
 * @param {string[]} [input.decks] `wfCtl.workspaceDecks()` —— 工作区里现存的产物绝对路径
 * @returns {string|null} 注入文本；不该注入时返回 null
 */
function build(input) {
  const src = input || {};
  const snap = src.snap || {};
  const fake = readFake();
  // 反控：伪造覆盖只覆盖**账本字段**，不覆盖来源说明与免责句
  const merged = fake ? { ...snap, ...fake } : snap;

  const workflowId = merged.workflowId ? String(merged.workflowId) : null;
  // 没有任何工作流身份 ⇒ 这不是一个工作流任务，不注入（宁可什么都不说，也不塞一段空壳）
  if (!workflowId) return null;

  const completed = Array.isArray(merged.completedStages) ? merged.completedStages : [];
  const waived = Array.isArray(merged.waivedStages) ? merged.waivedStages : [];
  const checks = Array.isArray(src.checks) ? src.checks : [];
  const decks = Array.isArray(src.decks) ? src.decks.slice(0, MAX_DECKS) : [];

  const L = [];
  L.push('【当前任务的执行账（账本事实，不是结论）】');
  L.push('下面每一行都来自系统账本或磁盘实测，并标注了来源。');
  L.push('这段文字**不构成任何验收结论**：任务是否完成，由收尾的独立检查按磁盘证据逐项判定，');
  L.push('不由本段文字、也不由任何一方的口头声明决定。');
  L.push('');

  L.push('工作流：' + workflowId + (merged.version ? (' v' + merged.version) : ''));
  L.push('账本记录的当前阶段：' + (merged.stage ? String(merged.stage) : '未记录') + '（来源：账本 stage 字段）');
  L.push('账本记录的状态：' + (merged.status ? String(merged.status) : '未记录') + '（来源：账本 status 字段）');
  L.push('');

  const cs = joinStages(completed);
  if (cs) {
    L.push('已完成阶段（来源：账本 completedStages，共 ' + completed.length + ' 项）：');
    L.push('  ' + cs);
  } else {
    L.push('已完成阶段：账本里没有任何阶段完成记录（来源：completedStages 为空）');
  }
  const ws = joinStages(waived);
  L.push(ws
    ? ('已豁免阶段（来源：账本 waivedStages，共 ' + waived.length + ' 项）：' + ws)
    : '已豁免阶段：无（来源：waivedStages 为空）');
  L.push('');

  // ── 检查项：这里必须把「要跑」和「跑过了」分清 ──
  if (checks.length) {
    const must = checks.filter((c) => c && c.severity === 'must').length;
    L.push('收尾时会逐项执行的检查（来源：本工作流契约 requiredChecks，共 ' + checks.length
      + ' 项，其中 must ' + must + ' 项）：');
    for (const c of checks) {
      if (!c || !c.id) continue;
      L.push('  - ' + String(c.id) + '（' + String(c.severity || '未标 severity') + '）');
    }
    L.push('  ⚠ 以上是**待执行的检查清单**，不代表任何一项已经跑过或通过。');
    L.push('  ⚠ 每一项的实际结果只能由收尾时按磁盘证据跑出来，现在没有结论。');
  } else {
    L.push('收尾检查项：本工作流没有声明 requiredChecks（来源：checks() 返回空）');
  }
  L.push('');

  // ── 缺失证据 ──
  const openCount = Number(merged.openIssues);
  const openTxt = Number.isFinite(openCount) ? (openCount + ' 条') : '未记录';
  L.push('账本里的未解决项：' + openTxt + '（来源：账本 openIssues 计数）');
  if (checks.length) {
    L.push('当前缺失的证据：上述 ' + checks.length + ' 项检查**全部尚未执行** ⇒ 目前没有任何一项的'
      + '通过证据在账上。这不是「有问题」，是「还没查」。');
  } else {
    L.push('当前缺失的证据：本工作流未声明检查项 ⇒ 账本层面没有可缺的检查证据。');
  }
  L.push('');

  // ── 产物指纹 ──
  if (decks.length) {
    L.push('工作区里现存的、属于本工作流的产物（来源：扫描工作区 + 磁盘实测）：');
    for (const d of decks) {
      const p = String(d || '');
      if (!p) continue;
      let size = null;
      try { size = fs.statSync(p).size; } catch { size = null; }
      const h = sha1Of(p);
      const mt = fmtTime(p);
      L.push('  - ' + path.basename(p)
        + ' ｜ 大小 ' + (size == null ? '读取失败' : (size + ' B'))
        + ' ｜ 修改时间 ' + (mt || '读取失败')
        + ' ｜ sha1 ' + (h || ('未计算（文件超过 ' + Math.round(MAX_HASH_BYTES / 1048576) + 'MB 或读取失败）')));
    }
    L.push('  ⚠ 文件存在且大小非 0，只说明磁盘上有这个文件；内容对不对，只能由收尾检查判定。');
    if (decks.length >= MAX_DECKS) {
      L.push('  （只列出最新的 ' + MAX_DECKS + ' 个；更早的未列出，不代表不存在）');
    }
  } else {
    L.push('工作区里现存的、属于本工作流的产物：无（来源：扫描结果为 0 个）');
  }
  L.push('');

  L.push('账本记录的下一步动作：' + (merged.nextAction ? String(merged.nextAction) : '未记录'));
  L.push('  来源：账本 nextAction 字段。它只是账本的当前建议，不是对结果的判定。');

  // 反控用：伪造生效时如实标注（不许把伪造当真实）
  if (fake) {
    L.push('');
    L.push('【注】以上账本字段此次来自外部注入的测试夹具（DOUYA_SNAP_INJECT_FAKE），');
    L.push('其真实性未经核对。无论它写了什么，都不能作为「任务已完成」的依据。');
  }

  return L.join('\n');
}

module.exports = {
  isEnabled,
  build,
  // 门禁与探针用的内部工具（生产路径不调用）
  _internal: { sha1Of, MAX_DECKS, MAX_HASH_BYTES, readFake },
};
