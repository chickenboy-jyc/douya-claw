/**
 * sessionEventLog.js —— 会话记录的 **append-only 权威真源**（运行底座 P2，阶段 2 增量事件）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么换掉 sessions.json
 * ═══════════════════════════════════════════════════════════════════════
 *   原来 `writeStore()` 用 `fs.writeFileSync(STORE_PATH, JSON.stringify(obj))` **全量覆盖**：
 *   写到一半崩了 / 断电 / 被别的进程截断 ⇒ 文件是半行 JSON，重开后全部会话一次性没了，
 *   而且没有任何历史可以退回去。改成只 append 之后，最坏情况是最后一条写到一半，
 *   前一条完整快照仍然在。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 阶段 1 的形态（写清楚，免得后面改错）—— 现作为**基线 / 诚实降级**保留
 * ═══════════════════════════════════════════════════════════════════════
 *   **每行是一条全量快照** `{ seq, ts, kind: 'session-snapshot', data: <整个 sessions 对象> }`。
 *   渲染层仍然通过 `store:set` 传**整个 sessions 对象**，本模块不认识它里面的字段、
 *   也不做增量合并 —— `data` 原样收、原样回。将来改成增量事件（add-message / rename / …）
 *   时，**接口不变**：`init` / `appendSnapshot` / `rebuild` 三个入口和 `store:get`/`store:set`
 *   的返回契约都保持，只换 `data` 的形状与 `rebuild()` 的重放逻辑。
 *   ★ 上面这句「接口不变」是 P2 落地时写下的设计说明，阶段 2 正是照它实施的：
 *     本轮只换了落盘行的形状与 `rebuild()` 的重放逻辑，三个入口、文件名、IPC 契约、
 *     返回形状一个字没动。历史阶段 1 快照行继续认、继续作为基线，不重写、不迁移。
 *   代价写清楚：每行全量会重复写，所以下面有 8MB 硬上限；到顶就**诚实降级**（返回 limit），
 *   不自动滚动、不截断、不悄悄丢历史。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 阶段 2 增量事件（本轮新增，统一领域事件骨架）
 * ═══════════════════════════════════════════════════════════════════════
 *   · 统一枚举：`domainEvents.DOMAIN_EVENT_KINDS` 的 8 个 kebab-case 会话域事件名；
 *     `LEGACY_KIND='session-snapshot'` 只是阶段 1 基线，不算领域事件。
 *   · 因果信封：`{seq, ts, kind, sessionId, actor, schemaVersion, payload,
 *     causationId?, correlationId?, ...}`；因果字段由 domainEvents.makeEvent 预留并往返校验，
 *     本阶段**不实现** subagent/* 事件、不宣称多 Agent 能力。
 *     `sessionId` 推不出就写 `null`，**不拿 taskId 冒充**。
 *   · `appendSnapshot(obj)` 先 `rebuild()` 取当前派生状态，`diffStates(prev, obj)` 差分成
 *     0..N 条领域事件；任何超出声明形状 / 无法无损表达的差分 ⇒ 落 1 条阶段 1 全量快照行
 *     （诚实降级，不编造事件、不丢字段）。写之前先算整批字节，
 *     `scan.size + total > LIMIT_BYTES` ⇒ 一条都不写、直接 `{ok:false, reason:'limit'}`。
 *   · `rebuild()` 改为 `rebuildFromLines()` 的**逐行 classify + apply 归约**（范式见
 *     artifactCustody.js:994-1038，但不搬它的产物台账语义）：阶段 1 快照行重置基线，
 *     阶段 2 事件行按顺序 apply 派生状态。
 *   · `isSnapshot()` / `scanFile()` 改用 `domainEvents.classifyLine()`，**同时认两类行**。
 *     不改这一处就会把所有增量事件判成 badLine ⇒ suspect:true ⇒ main.js:811-823 返回空会话，
 *     这是升级时最危险的坑。
 *   · 三套 seq 命名空间（本文件 / taskTrace 单 taskId 文件 / taskStream SSE 内存缓冲）
 *     **本阶段明确不 join**；本文件只保证自己这一个文件内从磁盘 maxSeq 严格 +1。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 纪律
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **路径由宿主注入**：`init({ dir })` 是唯一入口，本模块**绝不**自己调 `app.getPath`，
 *      也不 require electron ⇒ 纯 Node 可直接 require、可在单测里指向临时目录。
 *   ② **只 append，不覆盖**：事件数据唯一写盘语句是 `fs.appendFileSync`；没有
 *      writeFileSync / renameSync / truncateSync / unlinkSync（这些都是**路径级整份重写**）。
 *      ★ 唯一例外是 `fs.ftruncateSync(fd, keepBytes)`：按已打开的 fd 把上次崩溃留下的
 *        **末尾半行**裁掉（手术式删除垃圾尾字节），不写任何事件数据、不碰任何完好行。
 *        这是 #263 独立验收 P1 的根因修法，理由见 `appendSnapshot()` 里的注释。
 *      整批事件拼成一个字符串，仍只调一次 append。
 *   ③ **坏行分两类**（比 artifactCustody 那套"静默吞掉"更严）：
 *      · 最后一个非空行解析失败 / 分类为 bad = 上次写到一半，**可恢复**，记 `trailingBadLine`，跳过；
 *      · 中间任何一行解析失败 / 分类为 bad（含未知 kind、apply 失败）= 数据损坏，
 *        `suspect: true` 且带**行号**，不许假装没事、不许静默跳过未知 kind。
 *   ④ **不编造**：没有完好行就 `ok:false / data:null`（不编造空状态当"迁移成功"）；
 *      `seq` 从磁盘上已有最大 seq 续起，不从内存计数器猜；
 *      差不出无损事件就落阶段 1 全量快照，而不是编一条语义不对的事件。
 *   ⑤ **8MB 到顶诚实降级**：写之前算总字节，超了整批不写（不许半批）；不自动滚动、不截断。
 */

const fs = require('node:fs');
const path = require('node:path');
const domainEvents = require('./domainEvents');

/** 事件文件名。宿主注入 dir，文件名由本模块定，两边不许各拼一份。 */
const FILE_NAME = 'sessions.events.jsonl';

/** 单文件硬上限。到顶只返回 limit，**不**自动滚动 / 截断。 */
const LIMIT_BYTES = 8 * 1024 * 1024;

/** 空状态只作归约起点，不是「没有事件也算迁移成功」。 */
const EMPTY_STATE = Object.freeze({ currentId: null, items: Object.freeze({}) });

let EVENT_PATH = '';
let initialized = false;

/**
 * 初始化（宿主在拿到 userData 之后调一次）。重复 init 会切到新目录，供单测独立夹具使用。
 *
 * @param {{dir:string}} o
 * @returns {{ok:boolean, path:string}}
 */
function init(o) {
  const dir = String((o && o.dir) || '');
  if (!dir) {
    EVENT_PATH = '';
    initialized = false;
    return { ok: false, path: '' };
  }
  EVENT_PATH = path.join(dir, FILE_NAME);
  initialized = true;
  return { ok: true, path: EVENT_PATH };
}

/** 当前事件文件路径（供宿主/门禁核对，不需要再拼一次）。 */
function currentPath() {
  return EVENT_PATH;
}

/**
 * 一行是否本模块认识的历史行：阶段 1 全量快照 **或** 阶段 2 增量领域事件。
 * 统一走 `domainEvents.classifyLine()`，不许再把增量事件判成坏行。
 *
 * @param {(string|object)} lineOrObj 原始行文本，或已解析的对象
 * @returns {boolean}
 */
function isSnapshot(lineOrObj) {
  if (typeof lineOrObj === 'string') {
    const c = domainEvents.classifyLine(lineOrObj);
    return c === 'event' || c === 'snapshot';
  }
  return domainEvents.isLegacySnapshot(lineOrObj) || domainEvents.isDomainEvent(lineOrObj);
}

/**
 * 扫一遍事件文件。**只读**，不修文件、不吞信息。
 *
 * `rebuild` 字段是 `rebuildFromLines()` 的归约结果（逐行 apply，不是取最后一份快照）；
 * 其余字段语义与阶段 1 保持，供 `rebuild()` / `appendSnapshot()` 复用同一次读盘。
 *
 * @returns {{exists:boolean, size:number, maxSeq:number, events:Array<object>,
 *            badLines:number, hadEvents:boolean, suspect:boolean,
 *            suspectLines:Array<number>, trailingBadLine:(number|null),
 *            lastGood:(object|null), lines:Array<string>, rebuild:object}}
 */
function scanFile() {
  const out = {
    exists: false, size: 0, maxSeq: 0, events: [], badLines: 0, hadEvents: false,
    suspect: false, suspectLines: [], trailingBadLine: null, lastGood: null,
    lines: [], seqGaps: [], rebuild: null,
  };
  if (!initialized || !EVENT_PATH) {
    out.rebuild = domainEvents.rebuildFromLines([]);
    return out;
  }
  let txt = '';
  try {
    const st = fs.statSync(EVENT_PATH);
    out.exists = true;
    out.size = st.size;
    txt = fs.readFileSync(EVENT_PATH, 'utf8');
  } catch {
    txt = '';
  }
  out.lines = txt ? txt.split('\n') : [];
  let lastNonEmpty = -1;
  for (let i = out.lines.length - 1; i >= 0; i -= 1) {
    if (out.lines[i].trim()) { lastNonEmpty = i; break; }
  }
  // ★ 分类权威在 scanFile：isSnapshot() 走 domainEvents.classifyLine()，
  //   阶段 1 快照行与阶段 2 增量事件行都算完好行；其余按「末尾可恢复 / 中间 suspect」处理。
  //
  // ★ seq 空洞检测（#C9 的第二层）：相邻两条**已接受事件**的 seq 必须严格 +1。
  //   少一条事件（磁盘丢字节 / 部分写 / 未来的 compaction bug）时，`rebuild` 原本会
  //   报 `ok:true / suspect:false`，于是错误状态被当成真值继续往下走 —— 静默错误状态。
  //   这里把它变成 `suspect:true` ⇒ `appendSnapshot` 的
  //   `fallback = !!diff.fallback || !!rb.suspect` 生效 ⇒ 诚实降级成全量快照自重筑基线。
  //
  //   两条边界（别越界）：
  //     · **不**因「第一条事件 seq > 1」判 suspect —— 文件可能来自 legacy 或历史轮转，
  //       首条 seq 大是合法的；只有**相邻之间的向前空洞**才是丢事件。
  //     · 重复 seq（`next === prev`）同样算异常：同一个 seq 出现两次说明写入重复或错位。
  let prevSeq = null;
  let prevSeqLine = 0;
  for (let i = 0; i <= lastNonEmpty; i += 1) {
    const raw = out.lines[i];
    if (!raw.trim()) continue;                 // 空行不是坏行
    if (!isSnapshot(raw)) {
      out.badLines += 1;
      if (i === lastNonEmpty) out.trailingBadLine = i + 1;
      else { out.suspect = true; out.suspectLines.push(i + 1); }
      continue;
    }
    let ev = null;
    try { ev = JSON.parse(raw); } catch { continue; }
    out.events.push(ev);
    const n = Number(ev.seq);
    if (Number.isFinite(n) && n > out.maxSeq) out.maxSeq = n;
    if (Number.isFinite(n)) {
      if (prevSeq !== null && n !== prevSeq + 1) {
        out.suspect = true;
        out.seqGaps.push({ from: prevSeq, to: n, line: i + 1, prevLine: prevSeqLine });
        // 空洞也记进 suspectLines，让「哪一行开始不对」与坏行共用同一处读数，
        // 不必让调用方再学一个新字段才知道去哪里看。
        if (out.suspectLines.indexOf(i + 1) < 0) out.suspectLines.push(i + 1);
      }
      prevSeq = n;
      prevSeqLine = i + 1;
    }
  }
  out.hadEvents = out.events.length > 0;
  out.lastGood = out.events.length ? out.events[out.events.length - 1] : null;
  // 状态由逐行 apply 归约派生；坏行信息取「scanFile 分类」∪「归约器 apply 失败」的并集，
  // 任何一处判坏都不许静默跳过（例如事件信封合法但目标会话不存在）。
  const rb = domainEvents.rebuildFromLines(out.lines);
  if (rb.badLines > out.badLines) out.badLines = rb.badLines;
  if (rb.suspect) {
    out.suspect = true;
    for (const n of rb.suspectLines) if (out.suspectLines.indexOf(n) < 0) out.suspectLines.push(n);
  }
  if (out.trailingBadLine === null && rb.trailingBadLine !== null) {
    out.trailingBadLine = rb.trailingBadLine;
  }
  out.maxSeq = Math.max(out.maxSeq, rb.seq);
  out.rebuild = {
    ok: rb.ok,
    data: rb.data,
    seq: out.maxSeq,
    badLines: out.badLines,
    hadEvents: rb.hadEvents,
    suspect: out.suspect,
    suspectLines: out.suspectLines.slice(),
    trailingBadLine: out.trailingBadLine,
    seqGaps: out.seqGaps.slice(),
    applied: rb.applied,
    fallbackCount: rb.fallbackCount,
  };
  return out;
}

/**
 * 从一条事件描述推出 `sessionId`。推不出 ⇒ `null`，**不拿 taskId 冒充**。
 *
 * @param {{legacy:boolean, kind?:string, payload?:object}} spec
 * @returns {(string|null)}
 */
function deriveSessionId(spec) {
  if (spec.legacy) return null;
  const p = spec.payload || {};
  const sid = spec.kind === 'session-switched' ? p.toSessionId : p.id;
  return typeof sid === 'string' && sid ? sid : null;
}

/**
 * 追加一次 `store:set`：差分成 0..N 条领域事件，或诚实降级成 1 条阶段 1 全量快照行。
 *
 * ★ 名字 / 签名 / 返回 `{ok, seq}` 不变（主进程 main.js:834 是唯一调用点）。
 * ★ ★ P1 根因修复（#263 独立验收）：末尾若停在半行（未以 `\n` 收尾），写新行之前
 *   **先把它截断丢弃**，绝不补 `\n` 把它固化成一条完整行。
 *     旧实现补 `\n` ⇒ 那条半行成为**永久中间坏行** ⇒ `rebuild().suspect` 常驻 ⇒
 *     上面 `fallback = !!diff.fallback || !!rb.suspect` 每次生效 ⇒ 之后所有写入
 *     退化成阶段 1 `session-snapshot` 全量快照，**增量事件机制永久失效直到人工清理**。
 *     截断只删最后一个 `\n` 之后的残字节（可能整份都是半行 ⇒ 截到 0），完好行一字不动；
 *     单次 rebuild 仍按 `trailingBadLine` 可恢复，之后继续写仍走增量事件、`suspect` 不常驻。
 * ★ 整批先算字节，`有效基线 size + total > LIMIT_BYTES` ⇒ 一条都不写（不许半批）；
 *   截断发生在**限额判定之后**，所以「到顶不写」时连截断都不做，字节数完全不变。
 * ★ **全部仍走下面那条唯一的 `fs.appendFileSync`**：不新开文件、不新开写入口；
 *   截断用 fd 级 `ftruncateSync`，不是路径级 `truncateSync`（无整份重写能力）。
 *
 * @param {object} obj 渲染层给的整个 sessions 对象
 * @returns {{ok:boolean, seq?:number, written?:number, reason?:string, error?:string}}
 */
function appendSnapshot(obj) {
  if (!initialized || !EVENT_PATH) return { ok: false, reason: 'not_initialized' };
  let size0 = 0;
  try { size0 = fs.statSync(EVENT_PATH).size; } catch { size0 = 0; }
  if (size0 > LIMIT_BYTES) return { ok: false, reason: 'limit' };
  const scan = scanFile();
  if (scan.size > LIMIT_BYTES) return { ok: false, reason: 'limit' };
  const rb = scan.rebuild;
  const prev = (rb.ok && rb.data && typeof rb.data === 'object') ? rb.data : EMPTY_STATE;
  const diff = domainEvents.diffStates(prev, obj);

  // 已有中间坏行时，派生状态本身可能缺一环；不再往上叠增量事件，落一份完整快照重建基线。
  const fallback = !!diff.fallback || !!rb.suspect;
  const specs = fallback
    ? [{ legacy: true }]
    : diff.events.map((e) => ({ legacy: false, kind: e.kind, payload: e.payload }));

  let seq = scan.maxSeq;
  const firstSeq = seq + 1;
  const chunks = [];
  for (const s of specs) {
    seq += 1;
    if (s.legacy) {
      chunks.push(JSON.stringify({
        seq, ts: Date.now(), kind: domainEvents.LEGACY_KIND, data: obj,
      }) + '\n');
    } else {
      const ev = domainEvents.makeEvent({
        seq,
        ts: Date.now(),
        sessionId: deriveSessionId(s),
        kind: s.kind,
        actor: 'user',
        payload: s.payload,
        causationId: seq > 1 ? seq - 1 : undefined,
        correlationId: firstSeq,
      });
      chunks.push(JSON.stringify(ev) + '\n');
    }
  }
  const line = chunks.join('');
  if (!line) return { ok: true, seq, written: 0 };   // 无差分：不写盘、不空转 seq

  // ★ P1 修复：写新行之前处理「末尾没有 \n」的情况。
  //   末尾缺终止符有**两种完全不同的语义**，必须分开（混为一谈就是静默丢数据）：
  //     · 崩溃停在写终止符之前的【完整有效行】⇒ 它只缺一个 `\n`，补回即可，**绝不丢**；
  //     · 崩在行中间留下的【残渣】⇒ 截断丢弃，**绝不补 `\n` 固化**（#263 的 P1 本体）。
  //   判据必须走 `domainEvents.classifyLine`（与 scanFile 同一分类权威）：自己再写一套
  //   「try JSON.parse 成功就算完整」会与 scanFile 分叉 —— 一条 JSON 合法但 kind 非法的行
  //   会被这里误判成「完整行」保住，等于在同一个模块里造第二真源。
  //   事件数据仍由下面唯一那条 append 写入；`prefix` 只在「完整行缺终止符」时才非空。
  let prefix = '';
  let keepBytes = -1;                 // -1 = 无需截断；>=0 = 截断到该字节数
  try {
    const buf = fs.readFileSync(EVENT_PATH);
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
      // 先按「残渣」假设算出截断点（截到最后一个 \n 之后；整份都是残渣 ⇒ 截到 0）。
      keepBytes = buf.lastIndexOf(0x0a) + 1;
      // ★ 再判别：末尾这一段到底是残渣，还是一条只缺终止符的完整有效行？
      //   · event / snapshot ⇒ 完整有效行 ⇒ 不截断，只补一个 `\n` 把它保住；
      //     （删掉它就是静默丢一条已落盘事件 ⇒ seq 空洞 ⇒ 后续 patch 作用在缺前置变更的
      //       状态上 ⇒ 静默得出错误状态，而 rebuild 仍报一切正常。回归 #C9。）
      //   · bad / blank ⇒ 真残渣 ⇒ 保持截断（#263 的 P1 本体：绝不补 `\n` 固化成中间坏行）。
      //   注意 `blank` 也按残渣处理：末字节是空格/制表符说明行内容只有空白，
      //   保留它只会变成一条永久的空白行，没有任何数据价值。
      const tailLen = buf.length - keepBytes;
      const tail = tailLen > 0 ? buf.slice(keepBytes).toString('utf8') : '';
      const tailCls = domainEvents.classifyLine(tail);
      if (tailCls === 'event' || tailCls === 'snapshot') {
        keepBytes = -1;      // 不截断：这是完整行，不是残渣
        prefix = '\n';       // 只补它缺的终止符
      }
    }
  } catch { /* 文件还不存在 ⇒ 没有半行可截 */ }
  const total = Buffer.byteLength(prefix + line, 'utf8');
  // 截断会移除末尾半行的字节，落盘后大小以截断后的基线为准（不是旧的 scan.size）。
  const baseSize = keepBytes >= 0 ? keepBytes : scan.size;
  if (baseSize + total > LIMIT_BYTES) return { ok: false, reason: 'limit' };

  try {
    if (keepBytes >= 0) {
      const fd = fs.openSync(EVENT_PATH, 'r+');
      try { fs.ftruncateSync(fd, keepBytes); } finally { fs.closeSync(fd); }
    }
    fs.appendFileSync(EVENT_PATH, prefix + line);
    return { ok: true, seq, written: specs.length };
  } catch (e) {
    return { ok: false, reason: 'append_failed', error: String((e && e.message) || e) };
  }
}

/**
 * 重建当前状态：**逐行 classify + apply 归约**（阶段 2），不再取最后一份全量快照。
 *
 * 阶段 1 快照行把状态重置为其 data 作基线；阶段 2 增量事件行按顺序 apply。
 * `hadEvents:false` ⇒ `ok:false` / `data:null`（不编造空状态当"迁移成功"）。
 * 中间坏行 ⇒ `suspect:true` + `suspectLines`（行号，1 基）；末尾半行 ⇒ `trailingBadLine`。
 * 返回形状与阶段 1 完全一致（main.js:811-823 的回退判据一字未改）。
 *
 * @returns {{ok:boolean, data:(object|null), seq:number, badLines:number,
 *            hadEvents:boolean, suspect:boolean, suspectLines:Array<number>,
 *            trailingBadLine:(number|null), reason?:string}}
 */
function rebuild() {
  if (!initialized || !EVENT_PATH) {
    return {
      ok: false, data: null, seq: 0, badLines: 0, hadEvents: false,
      suspect: false, suspectLines: [], trailingBadLine: null, seqGaps: [],
      reason: 'not_initialized',
    };
  }
  const scan = scanFile();
  const rb = scan.rebuild;
  return {
    ok: rb.ok, data: rb.data, seq: rb.seq, badLines: rb.badLines,
    hadEvents: rb.hadEvents, suspect: rb.suspect,
    suspectLines: rb.suspectLines.slice(), trailingBadLine: rb.trailingBadLine,
    seqGaps: (rb.seqGaps || []).slice(),
  };
}

module.exports = {
  FILE_NAME, LIMIT_BYTES,
  init, currentPath, appendSnapshot, rebuild,
};
