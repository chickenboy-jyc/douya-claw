/**
 * domainEvents.js —— 会话域「统一领域事件骨架」（三阶段依赖顺序的第 1 个可交付增量）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这一层是什么 / 不是什么
 * ═══════════════════════════════════════════════════════════════════════
 *   · 是：统一枚举（8 个 kebab-case 会话域事件名）+ 因果信封 + 纯 reducer 的逐行归约。
 *         `sessionEventLog.rebuild()` 从「取最后一份全量快照」升级成「逐行 apply 派生状态」，
 *         范式来自 `artifactCustody.js:994-1038 rebuildIndexFromEvents()`（逐行 apply、按 kind
 *         分派），**不**抄它的产物台账语义。
 *   · 不是：订阅 / EventBus / 投影框架；不是多 Agent；不宣称并行能力。
 *         因果字段（causationId / correlationId / sourceEventSeqs / runnerId /
 *         parentTaskId / parentSessionId / artifactHashes）只是**预留并做往返校验**，
 *         本阶段不实现 `subagent/*` 事件，也不实现「替补配到不同模型才算 independent」的判定
 *         —— payload 白名单里给 `model` / `mode` 留了可校验位置（只校验类型是字符串）。
 *   · 零 fs：本文件是纯 Node 纯函数层，不 require fs、不写盘、不 require electron。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 事件信封
 * ═══════════════════════════════════════════════════════════════════════
 *   { seq, ts, kind, sessionId, actor, schemaVersion, payload,
 *     causationId?, correlationId?, sourceEventSeqs?, runnerId?,
 *     parentTaskId?, parentSessionId?, artifactHashes? }
 *
 *   ★ `seq` 是**会话事件日志这一个文件**内的全局单调号（从磁盘 maxSeq 续起），
 *     与 `taskStream.js` 的 SSE 断线重连 seq、`taskTrace.js` 的单 taskId 文件内 seq
 *     **三个命名空间互不相干，本阶段明确不 join**。
 *   ★ `sessionId` 推不出就写 `null`，**不拿 taskId 冒充**（与 taskTrace.bindSession 同源口径）。
 *   ★ payload 不许覆盖任何保留字段 —— 照抄 `taskTrace.js:196-200` 的
 *     `delete p.ts; delete p.kind; delete p.seq; delete p.sessionId;` 纪律并扩到整个信封。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 无损优先 / 诚实降级
 * ═══════════════════════════════════════════════════════════════════════
 *   `diffStates()` 只把**声明过的会话域聚合形状**（App.jsx 真实产出的
 *   `{currentId, items:{[id]:{id,title,messages,updatedAt,...}}}`）差分成领域事件；
 *   任何超出该形状、或差分无法用 8 个 kind 无损表达的 ⇒ 返回 `{fallback:true}`，
 *   由调用方落一条阶段 1 全量快照行。不编造事件、不丢字段、不把「不懂」伪装成「没变」。
 *   特别注意：`message-appended` / `message-updated` **自携带该条消息的完整内容**
 *   （不是调研草案里的 contentRef/contentLen —— 那样 rebuild() 无法无损还原正文）；
 *   伴随变化的 `updatedAt` 等标量折进事件的 `patch`，applyEvent 合并回会话对象。
 */

'use strict';

/** 8 个会话域事件名，统一 kebab-case。冻结数组：后续阶段按名字表扩展，不许散落字面量。 */
const DOMAIN_EVENT_KINDS = Object.freeze([
  'session-created',
  'session-renamed',
  'message-appended',
  'message-updated',
  'session-switched',
  'task-linked',
  'session-deleted',
  'session-archived',
]);

/** 阶段 1 全量快照行。只作基线 / 诚实降级，不算领域事件。 */
const LEGACY_KIND = 'session-snapshot';

/** 事件 schema 版本。改 payload 形状必须 +1，旧行才会被诚实判成 bad，而不是被误读。 */
const SCHEMA_VERSION = 1;

/** 信封保留字段：payload 里同名键一律剔除，不许伪造定序 / 关联键 / 因果链。 */
const RESERVED_FIELDS = Object.freeze([
  'seq', 'ts', 'kind', 'sessionId', 'actor', 'schemaVersion',
  'causationId', 'correlationId', 'sourceEventSeqs', 'runnerId',
  'parentTaskId', 'artifactHashes', 'payload',
]);

/** 可选因果字段（信封顶层）。`parentSessionId` 一并按产品裁决预留。 */
const CAUSAL_FIELDS = Object.freeze([
  'causationId', 'correlationId', 'sourceEventSeqs', 'runnerId',
  'parentTaskId', 'parentSessionId', 'artifactHashes',
]);

/**
 * payload 顶层键白名单。**只校验白名单与类型，不实现任何多 Agent 语义**：
 * `model` / `mode` 是「替补必须配到不同模型才算 independent」这条未来裁决预留的可校验位置。
 * 嵌套对象（item / message / patch 内部）不受此表约束 —— 它们是业务数据，逐字段原样保存。
 */
const PAYLOAD_WHITELIST = new Set([
  'id', 'item', 'message', 'index', 'from', 'to', 'patch',
  'fromSessionId', 'toSessionId', 'taskId', 'taskKind',
  'reason', 'at', 'origin',
  'model', 'mode',
]);

/** 归约起点。空状态不是「迁移成功」，只有出现过完好行才 ok:true。 */
const EMPTY_STATE = Object.freeze({ currentId: null, items: Object.freeze({}) });

/** 判定普通对象（排除 null / 数组 / Date / Map 等），状态与 payload 一律用这种对象。 */
function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** JSON 深拷贝。事件 / 状态都是 JSON 可序列化数据，用它可以同时保证「不就地改入参」。 */
function cloneJson(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

/** 结构化相等（状态来自 JSON 行 / IPC，不含 undefined / 函数 / 循环引用）。 */
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** hasOwnProperty 的安全写法（物品键可能叫 hasOwnProperty）。 */
function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * 声明过的会话域聚合形状。
 *
 * App.jsx 新建会话（:1868-1876 / :1890-1898）产出的 item 一律带
 * `id / title / messages / updatedAt`，另可带 companyId / projectId / scope 等任意扩展键；
 * 顶层只有 `currentId` 与 `items` 两个键。超出这个形状的状态（包括阶段 1 遗留的手写夹具、
 * 未来新增的顶层字段）不承诺能用 8 个 kind 命名 ⇒ 交给阶段 1 全量快照，逐字段不丢。
 *
 * @param {*} s 待判定的状态
 * @returns {boolean}
 */
function isWellFormedState(s) {
  if (!isPlainObject(s)) return false;
  const keys = Object.keys(s);
  if (keys.length !== 2 || !hasOwn(s, 'currentId') || !hasOwn(s, 'items')) return false;
  if (!(s.currentId === null || (typeof s.currentId === 'string' && s.currentId.length > 0))) return false;
  if (!isPlainObject(s.items)) return false;
  for (const id of Object.keys(s.items)) {
    const it = s.items[id];
    if (!isPlainObject(it)) return false;
    if (it.id !== id) return false;
    if (typeof it.title !== 'string') return false;
    if (!Number.isFinite(it.updatedAt)) return false;
    if (!Array.isArray(it.messages)) return false;
    for (const m of it.messages) if (!isPlainObject(m)) return false;
  }
  return true;
}

/**
 * 按 kind 校验 payload 顶层形状。makeEvent 与 isDomainEvent 共用同一套判据，
 * 保证「写出去的行」和「读进来的行」用同一个契约，不会出现写方放行、读方判坏。
 *
 * @param {string} kind
 * @param {*} p
 * @returns {boolean}
 */
function validPayloadFor(kind, p) {
  if (!isPlainObject(p)) return false;
  const has = (k) => hasOwn(p, k);
  for (const k of Object.keys(p)) if (!PAYLOAD_WHITELIST.has(k)) return false;
  if (has('model') && typeof p.model !== 'string') return false;
  if (has('mode') && typeof p.mode !== 'string') return false;
  if (has('patch') && !isPlainObject(p.patch)) return false;
  if (has('from') && typeof p.from !== 'string') return false;
  if (has('to') && typeof p.to !== 'string') return false;
  const idOk = typeof p.id === 'string' && p.id.length > 0;
  switch (kind) {
    case 'session-created':
      return idOk && isPlainObject(p.item);
    case 'session-renamed':
      return idOk && has('from') && has('to');
    case 'message-appended':
      return idOk && isPlainObject(p.message);
    case 'message-updated':
      // index/message 成对出现；二者都缺省 = 「只改会话元数据」的就地更新形态
      return idOk
        && (has('index')
          ? Number.isInteger(p.index) && p.index >= 0 && isPlainObject(p.message)
          : !has('message'));
    case 'session-switched':
      return has('fromSessionId') && has('toSessionId')
        && (p.fromSessionId === null || typeof p.fromSessionId === 'string')
        && (p.toSessionId === null || typeof p.toSessionId === 'string');
    case 'task-linked':
      return idOk && typeof p.taskId === 'string' && typeof p.taskKind === 'string';
    case 'session-deleted':
      return idOk;
    case 'session-archived':
      return idOk;
    default:
      return false;
  }
}

/**
 * 纯构造一条领域事件。**未知 kind 明确抛错**（不返回半条事件、不静默降级）。
 *
 * @param {{seq:number, ts:number, sessionId:(string|null), kind:string, actor:string,
 *          payload:object, causationId?:*, correlationId?:*, sourceEventSeqs?:*,
 *          runnerId?:*, parentTaskId?:*, parentSessionId?:*, artifactHashes?:*}} spec
 * @returns {{seq:number, ts:number, kind:string, sessionId:(string|null), actor:string,
 *            schemaVersion:number, payload:object}}
 * @throws {Error} kind 不在统一枚举里 / payload 非普通对象 / 键不在白名单 / 形状不合法
 */
function makeEvent(spec) {
  const o = isPlainObject(spec) ? spec : {};
  const kind = o.kind;
  if (typeof kind !== 'string' || DOMAIN_EVENT_KINDS.indexOf(kind) === -1) {
    throw new Error('unknown domain event kind: ' + String(kind));
  }
  if (o.payload !== undefined && !isPlainObject(o.payload)) {
    throw new Error('domain event payload must be a plain object');
  }
  // ★★ 保留字段兜底剔除（taskTrace.js:196-200 纪律）：payload 不许伪造信封任何一格。
  const p = o.payload ? { ...o.payload } : {};
  for (const f of RESERVED_FIELDS) delete p[f];
  if (!validPayloadFor(kind, p)) {
    throw new Error('invalid payload for domain event kind: ' + kind);
  }
  const ev = {
    seq: o.seq,
    ts: o.ts,
    kind,
    sessionId: o.sessionId === undefined ? null : o.sessionId,
    actor: typeof o.actor === 'string' && o.actor ? o.actor : 'user',
    schemaVersion: SCHEMA_VERSION,
    payload: cloneJson(p),
  };
  for (const f of CAUSAL_FIELDS) {
    if (o[f] !== undefined) ev[f] = cloneJson(o[f]);
  }
  return ev;
}

/**
 * 一行（解析后）是否是阶段 2 增量领域事件。信封与 payload 形状都要合格。
 *
 * @param {*} ev
 * @returns {boolean}
 */
function isDomainEvent(ev) {
  if (!isPlainObject(ev)) return false;
  if (typeof ev.kind !== 'string' || DOMAIN_EVENT_KINDS.indexOf(ev.kind) === -1) return false;
  if (!Number.isFinite(Number(ev.seq)) || Number(ev.seq) <= 0) return false;
  if (!Number.isFinite(ev.ts)) return false;
  if (!(ev.sessionId === null || typeof ev.sessionId === 'string')) return false;
  if (typeof ev.actor !== 'string' || !ev.actor) return false;
  if (ev.schemaVersion !== SCHEMA_VERSION) return false;
  return validPayloadFor(ev.kind, ev.payload);
}

/**
 * 一行（解析后）是否是阶段 1 全量快照行。data 原样保存、原样回放，不假设它的字段。
 *
 * @param {*} ev
 * @returns {boolean}
 */
function isLegacySnapshot(ev) {
  return isPlainObject(ev)
    && ev.kind === LEGACY_KIND
    && !!ev.data && typeof ev.data === 'object'
    && Number.isFinite(Number(ev.seq)) && Number(ev.seq) > 0;
}

/**
 * 统一分类判据：阶段 1 快照 + 阶段 2 增量事件都认，其余一律 bad（不许静默跳过）。
 *
 * @param {string} raw 原始行文本
 * @returns {'event'|'snapshot'|'bad'|'blank'}
 */
function classifyLine(raw) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s.trim()) return 'blank';
  let ev = null;
  try { ev = JSON.parse(s); } catch { return 'bad'; }
  if (isLegacySnapshot(ev)) return 'snapshot';
  if (isDomainEvent(ev)) return 'event';
  return 'bad';
}

/**
 * **纯 reducer**：按 kind 分派，返回新的 `{currentId, items}`（保留状态里其它顶层键），
 * 绝不就地改入参。未知 kind 明确返回 `{ok:false, reason:'unknown-kind'}`，不许静默跳过。
 *
 * @param {object} state 当前状态（会被深拷贝，不修改）
 * @param {object} ev 一条已通过 isDomainEvent 的事件
 * @returns {{currentId:*, items:object}|{ok:false, reason:string}}
 */
function applyEvent(state, ev) {
  const kind = ev && ev.kind;
  if (typeof kind !== 'string' || DOMAIN_EVENT_KINDS.indexOf(kind) === -1) {
    return { ok: false, reason: 'unknown-kind' };
  }
  if (!isDomainEvent(ev)) return { ok: false, reason: 'invalid-event' };
  const src = isPlainObject(state) ? state : EMPTY_STATE;
  const next = cloneJson(src);
  if (!isPlainObject(next.items)) next.items = {};
  if (next.currentId === undefined) next.currentId = null;
  const p = ev.payload;
  const id = p.id;
  const patch = isPlainObject(p.patch) ? cloneJson(p.patch) : null;
  const applyPatch = (it) => { if (patch) Object.assign(it, patch); };

  // 「会话不存在」是数据完整性问题，不编造一个空会话把它补上。
  const itemOf = () => {
    if (!hasOwn(next.items, id) || !isPlainObject(next.items[id])) return null;
    return next.items[id];
  };

  if (kind === 'session-created') {
    next.items[id] = cloneJson(p.item);
  } else if (kind === 'session-switched') {
    next.currentId = p.toSessionId;
  } else if (kind === 'session-deleted') {
    if (!itemOf()) return { ok: false, reason: 'missing-session' };
    delete next.items[id];
  } else if (kind === 'session-renamed') {
    const it = itemOf();
    if (!it) return { ok: false, reason: 'missing-session' };
    it.title = p.to;
    applyPatch(it);
  } else if (kind === 'message-appended') {
    const it = itemOf();
    if (!it) return { ok: false, reason: 'missing-session' };
    it.messages = Array.isArray(it.messages) ? it.messages.slice() : [];
    it.messages.push(cloneJson(p.message));
    applyPatch(it);
  } else if (kind === 'message-updated') {
    const it = itemOf();
    if (!it) return { ok: false, reason: 'missing-session' };
    if (hasOwn(p, 'index')) {
      if (!Array.isArray(it.messages) || p.index >= it.messages.length) {
        return { ok: false, reason: 'invalid-payload' };
      }
      it.messages = it.messages.slice();
      it.messages[p.index] = cloneJson(p.message);
    }
    applyPatch(it);
  } else if (kind === 'task-linked') {
    const it = itemOf();
    if (!it) return { ok: false, reason: 'missing-session' };
    it.taskId = p.taskId;
    it.taskKind = p.taskKind;
    // model / mode 只登记、不判定 independent（本阶段不实现该裁决）。
    if (p.model !== undefined) it.model = p.model;
    if (p.mode !== undefined) it.mode = p.mode;
    applyPatch(it);
  } else if (kind === 'session-archived') {
    const it = itemOf();
    if (!it) return { ok: false, reason: 'missing-session' };
    it.archived = true;
    if (p.reason !== undefined) it.archiveReason = p.reason;
    if (p.at !== undefined) it.archivedAt = p.at;
    applyPatch(it);
  } else {
    return { ok: false, reason: 'unknown-kind' };
  }
  return next;
}

/**
 * 把一次 `store:set` 的整份状态差分成 0..N 条 `{kind, payload}`。
 *
 * 覆盖 App.jsx 的真实变更：新建会话、切换、删除、清空、追加消息、流式就地改消息、
 * 重命名、以及随这些变更一起发生的 `updatedAt` 变化（折进 `patch`，不丢字段）。
 * 无法无损表达 / 超出声明形状 ⇒ `{fallback:true}`（调用方落阶段 1 全量快照行）。
 *
 * @param {object} prev 上一次派生出的状态
 * @param {object} next 本次 store:set 的整份状态
 * @returns {{fallback:boolean, events:Array<{kind:string, payload:object}>, reason?:string}}
 */
function diffStates(prev, next) {
  if (!isWellFormedState(prev) || !isWellFormedState(next)) {
    return { fallback: true, reason: 'out-of-domain-state', events: [] };
  }
  const events = [];
  if (prev.currentId !== next.currentId) {
    events.push({
      kind: 'session-switched',
      payload: { fromSessionId: prev.currentId, toSessionId: next.currentId },
    });
  }
  const prevIds = Object.keys(prev.items);
  const nextIds = Object.keys(next.items);
  for (const id of prevIds) {
    if (!hasOwn(next.items, id)) events.push({ kind: 'session-deleted', payload: { id } });
  }
  for (const id of nextIds) {
    if (!hasOwn(prev.items, id)) {
      events.push({ kind: 'session-created', payload: { id, item: cloneJson(next.items[id]) } });
      continue;
    }
    const a = prev.items[id];
    const b = next.items[id];
    if (jsonEqual(a, b)) continue;
    const changed = [];
    const allKeys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of allKeys) if (!jsonEqual(a[k], b[k])) changed.push(k);
    if (changed.indexOf('id') >= 0) {
      return { fallback: true, reason: 'session-id-changed', events: [] };
    }
    // 键被删掉无法用「合并 patch」表达 ⇒ 诚实降级，不悄悄留着旧值。
    const patch = {};
    for (const k of changed) {
      if (!hasOwn(b, k)) return { fallback: true, reason: 'item-key-removed', events: [] };
      if (k !== 'title' && k !== 'messages') patch[k] = cloneJson(b[k]);
    }
    const local = [];
    if (changed.indexOf('title') >= 0) {
      local.push({ kind: 'session-renamed', payload: { id, from: a.title, to: b.title } });
    }
    if (changed.indexOf('messages') >= 0) {
      const am = Array.isArray(a.messages) ? a.messages : [];
      const bm = Array.isArray(b.messages) ? b.messages : [];
      let isPrefix = am.length <= bm.length;
      if (isPrefix) {
        for (let i = 0; i < am.length; i += 1) {
          if (!jsonEqual(am[i], bm[i])) { isPrefix = false; break; }
        }
      }
      if (isPrefix && bm.length > am.length) {
        // 追加消息（含 :2101-2114 一次追加 user + assistant 两条）：事件自携带完整消息正文。
        for (let i = am.length; i < bm.length; i += 1) {
          local.push({ kind: 'message-appended', payload: { id, message: cloneJson(bm[i]) } });
        }
      } else if (am.length === bm.length && !isPrefix) {
        // 流式就地改写（:2139-2149 / :2194-2213）：按索引逐条替换完整消息。
        for (let i = 0; i < am.length; i += 1) {
          if (!jsonEqual(am[i], bm[i])) {
            local.push({ kind: 'message-updated', payload: { id, index: i, message: cloneJson(bm[i]) } });
          }
        }
      } else {
        return { fallback: true, reason: 'unexpressible-message-diff', events: [] };
      }
    }
    if (Object.keys(patch).length > 0) {
      if (local.length === 0) {
        // 只有 updatedAt 之类的标量变了：沿用 message-updated 的「就地改写」语义，
        // 不凭空发明第 9 个 kind，也不静默丢掉时间戳。
        local.push({ kind: 'message-updated', payload: { id, patch } });
      } else {
        local[local.length - 1].payload.patch = patch;
      }
    }
    for (const e of local) events.push(e);
  }
  return { fallback: false, events };
}

/**
 * 逐行 classify + apply，从事件行派生状态。
 *
 * · `snapshot` 行把状态**重置**为它的 data（阶段 1 基线，原样保留任意字段）；
 * · `event` 行按顺序 apply；apply 失败（未知 kind / 缺会话 / 形状坏）⇒ 记坏行，不静默跳过；
 * · 末尾半行坏行可恢复（trailingBadLine）；中间坏行 ⇒ suspect:true + 1 基行号；
 * · `hadEvents:false` ⇒ ok:false / data:null（不编造空状态当迁移成功）。
 *
 * @param {(string[]|string)} lines 原始行数组，或整份文件文本
 * @returns {{ok:boolean, data:(object|null), seq:number, badLines:number,
 *            hadEvents:boolean, suspect:boolean, suspectLines:Array<number>,
 *            trailingBadLine:(number|null), applied:number, fallbackCount:number}}
 */
function rebuildFromLines(lines) {
  const arr = typeof lines === 'string'
    ? lines.split('\n')
    : (Array.isArray(lines) ? lines : []);
  const out = {
    ok: false, data: null, seq: 0, badLines: 0, hadEvents: false,
    suspect: false, suspectLines: [], trailingBadLine: null,
    applied: 0, fallbackCount: 0,
  };
  let lastNonEmpty = -1;
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (String(arr[i] == null ? '' : arr[i]).trim()) { lastNonEmpty = i; break; }
  }
  let state = cloneJson(EMPTY_STATE);
  let maxSeq = 0;
  let accepted = false;
  for (let i = 0; i <= lastNonEmpty; i += 1) {
    const raw = String(arr[i] == null ? '' : arr[i]);
    const cls = classifyLine(raw);
    if (cls === 'blank') continue;
    let ev = null;
    if (cls !== 'bad') {
      try { ev = JSON.parse(raw); } catch { ev = null; }
    }
    if (cls === 'bad' || !ev) {
      out.badLines += 1;
      if (i === lastNonEmpty) out.trailingBadLine = i + 1;
      else { out.suspect = true; out.suspectLines.push(i + 1); }
      continue;
    }
    // 只要 envelope 合法，磁盘上这个 seq 就被占用了；后续 append 不得复用它。
    const n = Number(ev.seq);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    if (cls === 'snapshot') {
      state = cloneJson(ev.data);
      out.fallbackCount += 1;
      accepted = true;
      continue;
    }
    const r = applyEvent(state, ev);
    if (r && r.ok === false) {
      out.badLines += 1;
      if (i === lastNonEmpty) out.trailingBadLine = i + 1;
      else { out.suspect = true; out.suspectLines.push(i + 1); }
      continue;
    }
    state = r;
    out.applied += 1;
    accepted = true;
  }
  out.seq = maxSeq;
  out.hadEvents = accepted;
  if (!accepted) return out;   // ok:false / data:null，不编造空状态
  out.ok = true;
  out.data = state;
  return out;
}

module.exports = {
  DOMAIN_EVENT_KINDS, LEGACY_KIND, SCHEMA_VERSION, RESERVED_FIELDS,
  makeEvent, isDomainEvent, isLegacySnapshot, classifyLine,
  applyEvent, diffStates, rebuildFromLines,
};
