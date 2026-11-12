/**
 * taskTrace.js —— Agent 任务的**执行记录（trace）**：旁路 JSONL，按 taskId 切分。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么必须存在这个文件（2026-10-22，老板原话）
 * ═══════════════════════════════════════════════════════════════════════
 *   「你看到的是最终失败，但真正的原因可能在十几个步骤之前。究竟是模型判断错了、
 *     工具调用失败了、权限被拦截了，还是任务状态没有正确更新？没有完整的执行日志，就只能猜。」
 *
 *   审计读数（本次四路并行审计的实测数字，不是估计）：
 *     · backend.js 116 个 catch，**0 个 rethrow**，48 个完全空白，58 处失败后无任何信号；
 *     · 每次 LLM 调用的完整输入输出只活在 `conversation` 这个**函数局部变量**里，
 *       函数返回即 GC —— 磁盘上零记录；
 *     · 每次工具调用的**参数**，磁盘上零记录（SSE 只发中文标签，sessions.json 不存 arguments）；
 *     · 8 条「为什么这么做」的日志（意图闸门拦了谁、为什么启动验收闸、为什么这样调温度）
 *       **全部锁在 `DOUYA_DEBUG_*` 后面，默认关闭**；
 *     · 全仓无 electron-log / winston；打包后的 Electron 从资源管理器启动时 stdout 没有接收方；
 *     · tasks.json 每 owner 只留 20 条，全量覆盖写，`done[].brief` 只有结果首行 120 字。
 *   ⇒ 结论：默认配置下一次失败任务，事后能查到的信息 ≈ 0。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 设计纪律（每一则都有代价，写清楚是为了以后别改错）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **旁路，绝不改变控制流**。本模块任何函数都不抛、不返回错误、不影响返回值。
 *      与 agentReview 同一条纪律：增益功能不许把能正常结束的任务搞挂。
 *      但——「不抛」不等于「失败被吞」：写盘失败会记进 `stats().lastError`，
 *      并由 `health()` 暴露给门禁/CLI。**静默失败的记录器比没有记录器更糟**。
 *   ② **默认开启**。`DOUYA_TRACE === '0'` 才关。上一轮的病就是"关键日志全在默认关闭的
 *      DEBUG 开关后面"，不能自己再造一个。（体积有上限，见 ⑤，所以敢默认开。）
 *   ③ **只记事实，不记判断**。这里不判"这个工具该不该重试"、不判"任务做完了没有"，
 *      只记"发生了什么、参数是什么、结果是什麼、归因是什么"。
 *      判断留给 toolProtocol / deliveryProtocol / agentReview —— 那些地方已经有判据，
 *      在这里再判一次就是养第二套规则（本仓库反复踩过：`\bslide\b`、W3c 那次）。
 *   ④ **按 taskId 切分，一个任务一个文件**。取证时 `cat` 一个文件就够，
 *      天然不污染 tasks.json，也不必重建"哪条属于哪个任务"的关联。
 *   ⑤ **有上限**：单任务 4000 行 / 8MB，超了记一条 `trace_truncated` 后停写。
 *      全局按天保留 7 天。没有上限的日志最终会因为太大而没人看。
 *   ⑥ **不落敏感信息**：参数由调用方用 backend 的 `maskSecrets` 脱敏后再传进来
 *      （本模块不认识哪些键是密钥，也不该认识——两份名单必然漂移）。
 *      正文类内容默认只记头部 N 字符 + 全长，`DOUYA_TRACE_FULL=1` 才记全文。
 *   ⑦ **可审计历史（2026-11-04，运行底座 P0）**：每条落盘事件带 `seq` 与 `sessionId`。
 *      `seq` 是**磁盘上**的连续序号，**只在 appendFileSync 真正成功后才推进**——
 *      写失败不推进，就不会出现"事件少了一条、序号却跳了一格"的假完整。
 *      `sessionId` 是跨任务/跨会话的关联键，由 `bindSession()` 绑定；没绑定诚实写 `null`，
 *      不编造、不拿 taskId 冒充。两者与 `ts`/`kind` 同属**保留字段**，payload 不许伪造。
 *      ⚠️ 与 `src/main/taskStream.js` 那套 SSE 断线重连 seq 是**两个命名空间**，互不相干。
 *   ⑧ **seq 只能由本模块告知**（2026-11-05，阶段 2 / 卡 S2-3）：`recordEx()` 返回 `{ok, seq}`，
 *      `record()` 是它的布尔视图（语义照旧，调用点一个不改）。执行单元事件要写 `causationId`，
 *      而它必须指向同一条 trace 里**真实存在**的 `begin.seq` —— 让调用方自己数或回读去猜，
 *      得到的是「看起来对、其实指向别处」的因果链。`ok:false` 时 seq 一律 0，不许报假号。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 单任务上限。超了就停写——宁可缺尾巴，也不许把一个任务写成几百 MB。 */
const MAX_LINES = 4000;
const MAX_BYTES = 8 * 1024 * 1024;

/** 正文类内容的默认截断长度（头部保留这么多字符）。 */
const HEAD_LIMITS = { llmContent: 500, toolResult: 800, msgContent: 120 };

/** 保留天数。 */
const KEEP_DAYS = 7;

/** 每个 taskId 的会话状态。taskId -> { lines, bytes, truncated, openedAt, lastTurn, seq, sessionId } */
const sessions = new Map();

let TRACE_DIR = '';
let enabled = false;
/** 记录器自身的健康状态。**这是唯一允许暴露"我失败了"的地方**（见设计纪律①）。 */
const stats = { writes: 0, writeErrors: 0, lastError: '', droppedLines: 0, tasks: 0, disabledReason: '', bindConflicts: 0 };

/**
 * 开关：默认开，`DOUYA_TRACE=0` 关。
 *
 * ★ 2026-10-22（写门禁时发现的两个方向性缺陷，两边都改）：
 *   ① **「关」要宽松**：原来只有字面量 `'0'` 才算关，于是 `DOUYA_TRACE=false` / `off`
 *      会被判成「开」—— 用户以为关掉了、其实还在写盘。对一个**会落对话头部**的记录器，
 *      这是隐私方向的错误，比多记一点严重。⇒ 0/false/off/no 一律算关。
 *   ② **「记全文」要严格**：`DOUYA_TRACE_FULL` 落的是完整对话正文，只认 1/true/yes。
 *      宽松只允许发生在「少记」这一侧。
 */
function isEnabled() {
  const v = String(process.env.DOUYA_TRACE == null ? '' : process.env.DOUYA_TRACE).trim();
  if (!v) return true;                       // 未设置 ⇒ 开（默认开启，见设计纪律②）
  return !/^(0|false|off|no)$/i.test(v);
}

/** 是否记全文（默认否；只认 1/true/yes，宽松只允许发生在「少记」那一侧）。 */
function wantsFull() {
  const v = String(process.env.DOUYA_TRACE_FULL == null ? '' : process.env.DOUYA_TRACE_FULL).trim();
  return /^(1|true|yes)$/i.test(v);
}

/**
 * 初始化（启动 backend 时调一次）。
 *
 * @param {{dataDir:string}} o
 * @returns {{ok:boolean, dir:string, reason:string}}
 */
function init(o) {
  const dataDir = String((o && o.dataDir) || '');
  if (!dataDir) {
    stats.disabledReason = 'no_dataDir';
    return { ok: false, dir: '', reason: 'no_dataDir' };
  }
  TRACE_DIR = path.join(dataDir, 'traces');
  enabled = isEnabled();
  if (!enabled) {
    stats.disabledReason = 'DOUYA_TRACE=0';
    return { ok: false, dir: TRACE_DIR, reason: 'disabled_by_env' };
  }
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
  } catch (e) {
    // 目录建不出来 ⇒ 整个记录层不可用。这必须被知道，不能静默（纪律①）。
    stats.lastError = 'mkdir_failed: ' + String((e && e.message) || e);
    enabled = false;
    stats.disabledReason = 'mkdir_failed';
    return { ok: false, dir: TRACE_DIR, reason: 'mkdir_failed: ' + stats.lastError };
  }
  pruneOld();
  return { ok: true, dir: TRACE_DIR, reason: 'ok' };
}

/** 删掉超过 KEEP_DAYS 的 trace 文件。失败静默（清理不是关键路径）。 */
function pruneOld() {
  try {
    const now = Date.now();
    const cut = now - KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(TRACE_DIR)) {
      if (!/\.jsonl$/.test(f)) continue;
      const p = path.join(TRACE_DIR, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cut) fs.unlinkSync(p);
      } catch { /* 单个文件失败不影响其它 */ }
    }
  } catch { /* 清理失败不影响记录 */ }
}

/** taskId → 安全的文件名（只留字母数字下划线连字符；其它一律换成 _）。 */
function fileOf(taskId) {
  const safe = String(taskId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(TRACE_DIR, safe + '.jsonl');
}

/**
 * 取（或创建）某个 taskId 的会话状态。
 *
 * P0 起状态里多了 `seq` / `sessionId`。`bindSession()` 也走这里，保证
 * 「先绑定再写」与「先写再绑定」看到的是**同一个**状态对象；创建时才累计 stats.tasks。
 *
 * @param {string} taskId
 * @returns {{lines:number, bytes:number, truncated:boolean, openedAt:number, lastTurn:number, seq:number, sessionId:(string|null)}}
 */
function stateFor(taskId) {
  const id = String(taskId || 'unknown');
  let s = sessions.get(id);
  if (!s) {
    s = { lines: 0, bytes: 0, truncated: false, openedAt: Date.now(), lastTurn: -1, seq: 0, sessionId: null };
    sessions.set(id, s);
    stats.tasks += 1;
  }
  return s;
}

/**
 * 追加一条记录并**告知分配到的 seq**。**这是唯一的写入口**，`record()` 是它的布尔视图。
 *
 * 纪律：不抛。写不进去就把错误记进 stats —— 记录器自己失败了必须能被发现。
 *
 * ★ P0：`seq` 用的是 `s.seq + 1`（**预取**），`s.seq` 只在写盘成功后 +1。
 *   于是「写失败 ⇒ 序号不推进 ⇒ 下一条成功写入复用同一个序号」，磁盘上永远 1,2,3… 无空洞。
 *   `trace_truncated` 那条 note 是独立的 `appendFileSync`（历史形态，不经过本函数的 line 构造），
 *   所以它的 seq / sessionId 必须**手写**，并在写成功后同样推进 s.seq —— 见该分支注释。
 *
 * ★ 2026-11-05（阶段 2 / 卡 S2-3）为什么必须新增这个出口，而不是「顺手给 record 加个返回值」：
 *   执行单元事件的 `causationId` 必须指向**同文件真实存在**的 `begin.seq`。而 seq 是本函数内部
 *   用 `s.seq + 1` 分配的 —— 调用方拿不到，就只有三条歪路：
 *     ① 自己维护计数器：同一次任务里还有 llm_req / tool / gate 等 kind **会插队**，必然对不上；
 *     ② 写完回读整个 `<id>.jsonl` 找最后一条：能用，但把「记录器的内部知识」变成调用方的猜测，
 *        而且 `read()` 有自己的上限语义，尾部可能已经不是它要找的那一条；
 *     ③ 用 `Date.now()` 之类当关联键：那不是 seq，「必须指向同文件真实存在的 begin.seq」直接失效。
 *   ①②③ 都会产出「看起来对、其实指向别处」的因果链 —— **那比没有因果链更坏**（回放时会指错步骤，
 *   而且错得看不出来）。⇒ 正路是**让记录器自己说**。
 *
 * @param {string} taskId
 * @param {string} kind 事件类型（task_start / llm_req / llm_resp / tool / gate / terminal / error / ...）
 * @param {object} payload 已脱敏的事实
 * @returns {{ok:boolean, seq:number}} seq 仅在本条**真的落盘**时 > 0；
 *   未启用 / 已截断 / 写失败一律 `{ok:false, seq:0}` —— **绝不报一个磁盘上没有的序号**。
 */
function recordEx(taskId, kind, payload) {
  if (!enabled || !TRACE_DIR) return { ok: false, seq: 0 };
  const id = String(taskId || 'unknown');
  const s = stateFor(id);
  if (s.truncated) { stats.droppedLines += 1; return { ok: false, seq: 0 }; }

  // 本条将要占用的序号。**先取出来**，只有写盘成功后才连同结果一起交回调用方；
  // 写失败时调用方拿到的是 seq:0，绝不是一个「磁盘上并不存在」的号。
  const used = s.seq + 1;

  let line;
  try {
    // ★★ 2026-10-22（本文件的第一个门禁首跑就抓到的真 bug）——`ts` / `kind` 是**保留字段**：
    //   原来写的是 `{ ts, kind, ...payload }`，于是 payload 里同名字段会把它们**覆盖掉**。
    //   `tool()` 恰好把失败归因放在 `kind`（'EXECUTION_ERROR' 等）上 ⇒ 每一条**失败**的工具事件，
    //   磁盘上的 `kind` 都是失败归因、不是 `'tool'`。后果是隐蔽的：
    //     · `show.mjs` 的 `e.kind === 'tool'` 全部筛不到失败调用 ⇒ **失败归因分布永远是空的**；
    //     · 回放里"失败"这一整类证据消失，而文件本身看起来写得好好的。
    //   修法两条一起：① 保留字段在这里兜底剔除（payload 不许覆盖事件类型）；
    //              ② 失败归因改名为 `failKind`（名字不同，就不会再撞车）。
    //   P0 追加：`seq` / `sessionId` 同为保留字段 —— 定序与关联键不许被载荷伪造。
    const p = payload && typeof payload === 'object' ? { ...payload } : { v: payload };
    delete p.ts;
    delete p.kind;
    delete p.seq;
    delete p.sessionId;
    line = JSON.stringify({ ts: Date.now(), seq: used, sessionId: s.sessionId, kind, ...p }) + '\n';
  } catch (e) {
    // 循环引用之类：记一条替代行，不要静默丢事件（丢事件 = 取证时缺一环）
    line = JSON.stringify({
      ts: Date.now(), seq: used, sessionId: s.sessionId, kind,
      _serialize_error: String((e && e.message) || e),
    }) + '\n';
  }
  const bytes = Buffer.byteLength(line, 'utf8');

  if (s.lines + 1 > MAX_LINES || s.bytes + bytes > MAX_BYTES) {
    s.truncated = true;
    // ★★ 这条 note **不走 record() 的 line 构造**，是硬编码对象 + 独立 appendFileSync。
    //   所以 P0 的 seq / sessionId 必须在这里手写；漏了它，截断事件会撕开连续序列。
    //   写成功后推进 s.seq：用 `stats.writes` 是否变化判定成功（它在 append 成功后才 +1），
    //   不增加任何 append 次数，也不改变既有 catch 的静默降级语义。
    const note = JSON.stringify({
      ts: Date.now(), seq: s.seq + 1, sessionId: s.sessionId, kind: 'trace_truncated',
      lines: s.lines, bytes: s.bytes, limitLines: MAX_LINES, limitBytes: MAX_BYTES,
      hint: '本任务记录已达上限，后续事件不再写入（不是任务异常，是记录上限）',
    }) + '\n';
    const writesBefore = stats.writes;
    try { fs.appendFileSync(fileOf(id), note); stats.writes += 1; } catch { /* ignore */ }
    if (stats.writes > writesBefore) s.seq += 1;
    stats.droppedLines += 1;
    // 那条 note 属于「记录层自己」的事件，**不是**调用方要的那条记录 ⇒ 一律 seq:0。
    // 若这里回一个序号，调用方会拿它去当 `causationId`，指向一条与它无关的 trace_truncated。
    return { ok: false, seq: 0 };
  }

  try {
    fs.appendFileSync(fileOf(id), line);
    stats.writes += 1;
    s.seq += 1;
    s.lines += 1;
    s.bytes += bytes;
    return { ok: true, seq: used };
  } catch (e) {
    stats.writeErrors += 1;
    stats.lastError = 'append_failed: ' + String((e && e.message) || e);
    return { ok: false, seq: 0 };
  }
}

/**
 * `record()` = `recordEx()` 的**布尔视图**。
 *
 * ★ 返回值语义**逐字不变**（true = 真的落盘；false = 未启用 / 已截断 / 写盘失败），
 *   所以现有几十个调用点一个都不用改 —— 这是硬约束，不是风格问题。
 *
 * @param {string} taskId
 * @param {string} kind 事件类型
 * @param {object} payload 已脱敏的事实
 * @returns {boolean}
 */
function record(taskId, kind, payload) {
  return recordEx(taskId, kind, payload).ok;
}

/**
 * 把 taskId 关联到稳定的会话 id（P0 的关联键入口）。
 *
 * 纪律：**已绑定到别的值就拒绝覆盖**，返回 false 并累计 `stats.bindConflicts` ——
 * 静默改绑会让"同一个 task 的前半段属于会话 A、后半段属于会话 B"，
 * 事后没有任何办法把历史拼回去。重复绑定**同一个**值是幂等的，返回 true。
 * 没绑定时状态保持 `null`，落盘如实写 `null`（不编造、不拿 taskId 冒充）。
 *
 * @param {string} taskId
 * @param {string|null} sessionId
 * @returns {boolean} true = 绑定成功（含幂等重复）；false = 冲突，拒绝覆盖
 */
function bindSession(taskId, sessionId) {
  const id = String(taskId || 'unknown');
  const sid = sessionId == null ? null : String(sessionId);
  const s = stateFor(id);
  if (s.sessionId !== null && s.sessionId !== sid) {
    stats.bindConflicts += 1;
    return false;
  }
  s.sessionId = sid;
  return true;
}

// ───────────────────────── 事件构造器（语义化，减少调用点写错字段） ─────────────────────────

/** 任务开始。meta.sessionId 有值时先绑定关联键，再落第一条事件。 */
function begin(taskId, meta) {
  const m = meta || {};
  if (m.sessionId != null && String(m.sessionId) !== '') bindSession(taskId, String(m.sessionId));
  return record(taskId, 'task_start', {
    goal: clip(String(m.goal || ''), 300),
    owner: String(m.owner || ''),
    model: String(m.model || ''),
    tools: Array.isArray(m.tools) ? m.tools.map(String) : [],
    skillCount: Number(m.skillCount) || 0,
    maxTurns: Number(m.maxTurns) || 0,
  });
}

/**
 * 一次 LLM 调用（发出前）。
 * messages 只记**结构**（角色/长度/头部），不记全文——除非 DOUYA_TRACE_FULL=1。
 * 为什么还要记头部：定位"模型第 3 轮到底看没看到那条工具结果"时，光有长度不够。
 */
function llmReq(taskId, o) {
  const x = o || {};
  const msgs = Array.isArray(x.messages) ? x.messages : [];
  return record(taskId, 'llm_req', {
    turn: Number(x.turn) || 0,
    model: String(x.model || ''),
    temperature: x.temperature,
    thinking: !!x.thinking,
    search: !!x.search,
    maxTokens: x.maxTokens,
    toolNames: Array.isArray(x.tools) ? x.tools.map(String) : [],
    msgCount: msgs.length,
    msgs: msgs.map((m) => {
      const role = String((m && m.role) || '');
      const content = (m && m.content) == null ? '' : String(m.content);
      const out = { role, len: content.length };
      if (content) out.head = clip(content, HEAD_LIMITS.msgContent);
      if (m && Array.isArray(m.tool_calls)) out.toolCalls = m.tool_calls.length;
      if (m && m.tool_call_id) out.toolCallId = String(m.tool_call_id);
      if (wantsFull()) out.full = content;
      return out;
    }),
  });
}

/** 一次 LLM 调用（本轮响应收口）。耗时靠 llm_req 与本条的 ts 差算。 */
function llmResp(taskId, o) {
  const x = o || {};
  const content = x.content == null ? '' : String(x.content);
  const thinking = x.thinking == null ? '' : String(x.thinking);
  const calls = Array.isArray(x.toolCalls) ? x.toolCalls : [];
  return record(taskId, 'llm_resp', {
    turn: Number(x.turn) || 0,
    // finish_reason 是截断归因的唯一证据（'length' = 被输出上限掐断），此前只在内存里
    finishReason: x.finishReason == null ? null : String(x.finishReason),
    usage: x.usage && typeof x.usage === 'object' ? {
      prompt: x.usage.prompt_tokens, completion: x.usage.completion_tokens, total: x.usage.total_tokens,
    } : null,
    contentLen: content.length,
    contentHead: content ? clip(content, HEAD_LIMITS.llmContent) : '',
    thinkingLen: thinking.length,
    toolCallCount: calls.length,
    // 工具调用**意图**：名字 + 参数原文（这里不脱敏，因为调用方传的是模型原始输出；
    // 真正的密钥脱敏发生在参数解析后、进入确认弹窗时。trace 里的参数是"模型给了什么"，
    // 取证需要它原样 —— 但长度设上限，避免一次巨量写入）。
    toolCalls: calls.slice(0, 20).map((c) => ({
      id: c && c.id ? String(c.id) : '',
      name: c && c.function ? String(c.function.name || '') : '',
      argsLen: c && c.function && c.function.arguments ? String(c.function.arguments).length : 0,
      argsHead: c && c.function && c.function.arguments ? clip(String(c.function.arguments), 400) : '',
    })),
    ...(wantsFull() && content ? { contentFull: content } : {}),
  });
}

/**
 * 一次工具调用（结果收口）。
 * @param {object} o { turn, name, params, ok, failKind, result, ms, via }
 *   params 由调用方先过 maskSecrets；result 只记头部 + 全长。
 *   ⚠️ 失败归因字段叫 **failKind** 而不是 kind —— 理由见 record() 里那段保留字段的注释。
 */
function tool(taskId, o) {
  const x = o || {};
  const result = x.result == null ? '' : String(x.result);
  return record(taskId, 'tool', {
    turn: Number(x.turn) || 0,
    name: String(x.name || ''),
    params: safeParams(x.params),
    ok: x.ok !== false,
    failKind: x.failKind || null,
    ms: Number(x.ms) || null,
    resultLen: result.length,
    resultHead: result ? clip(result, HEAD_LIMITS.toolResult) : '',
    via: x.via || null,
    ...(wantsFull() && result ? { resultFull: result } : {}),
  });
}

/** 闸门拦截（意图闸门 / 熔断 / 同策略升级 / 需确认 / 去重索要 …）。 */
function gate(taskId, o) {
  const x = o || {};
  return record(taskId, 'gate', {
    turn: Number(x.turn) || 0,
    gate: String(x.gate || ''),
    skill: String(x.skill || ''),
    target: String(x.target || ''),
    hint: x.hint ? String(x.hint).slice(0, 200) : '',
  });
}

/**
 * 终态判定。**这是"十几个步骤之前到底怎么了"的最后一块拼图**：
 * 记录终态是 COMPLETE/PARTIAL/BLOCKED、由哪个判据得出、哪些降级条件命中过。
 */
function terminal(taskId, o) {
  const x = o || {};
  return record(taskId, 'terminal', {
    state: String(x.state || ''),
    reason: String(x.reason || ''),
    facts: x.facts && typeof x.facts === 'object' ? x.facts : null,
  });
}

/** 异常/静默失败留痕（供那些"catch 后继续"的地方补一个出口）。 */
function error(taskId, o) {
  const x = o || {};
  return record(taskId, 'error', {
    where: String(x.where || ''),
    message: clip(String(x.message || ''), 500),
    fatal: !!x.fatal,
  });
}

/** 任务结束。 */
function end(taskId, o) {
  const x = o || {};
  return record(taskId, 'task_end', {
    status: String(x.status || ''),
    turns: Number(x.turns) || 0,
    usedTokens: Number(x.usedTokens) || 0,
    toolCalls: Number(x.toolCalls) || 0,
    deliverables: Number(x.deliverables) || 0,
    reviewRounds: Number(x.reviewRounds) || 0,
  });
}

// ───────────────────────── 工具 ─────────────────────────

function clip(s, n) {
  const t = String(s == null ? '' : s);
  const k = Number(n) || 200;
  return t.length > k ? t.slice(0, k) + '…(共' + t.length + ')' : t;
}

/**
 * 密钥类键名：**按词素判定，不按子串**。
 *
 * ★ 2026-10-22（写门禁时发现的真缺陷）：第一版用 `/pass|secret|token|key|credential|auth|cookie/`
 *   对**整个键名**做子串匹配，于是：
 *     · `keyword`（搜索工具的查询词）命中 `key` ⇒ **被抹成 \*\*\***，取证时"用户到底搜了什么"没了；
 *     · `author` / `authorName` 命中 `auth` ⇒ 作者信息被抹；
 *     · `monkey` / `tokenizer` 同理。
 *   抹掉不多余的东西 = 用隐私换**零**安全性，还把取证链挖了个洞。
 *   改法：先把键名按 camelCase / 下划线 / 连字符切成词素，再整词比对。
 *   `apiKey` → ['api','key'] ⇒ 命中；`keyword` → ['keyword'] ⇒ 不命中。
 */
const SECRET_WORDS = new Set([
  'pass', 'password', 'passwd', 'pwd', 'secret', 'token', 'key', 'apikey',
  'credential', 'credentials', 'auth', 'authorization', 'cookie', 'signature',
]);

/** 键名 → 词素数组（camelCase / snake_case / kebab-case 都切）。 */
function keyWords(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** 这个键名是否"明显是密钥"。 */
function isSecretKey(k) {
  const ws = keyWords(k);
  if (!ws.length) return false;
  if (ws.some((w) => SECRET_WORDS.has(w))) return true;
  return SECRET_WORDS.has(ws.join(''));   // `apikey` 这类连写
}

/**
 * 参数脱敏兜底：只处理"明显是密钥"的键名，与 backend 的 maskSecrets 同一思路但更保守。
 *
 * ★ 递归一层以上（2026-10-22）：工具参数经常是 `{opts:{apiKey:'…'}}` 这种嵌套形态，
 *   第一版只看顶层 ⇒ 嵌在里面的密钥**原样落盘**。现在递归，深度上限 3（防环、防巨量展开）。
 */
function safeParams(p, depth) {
  const d = Number(depth) || 0;
  if (p == null) return null;
  if (typeof p !== 'object') return String(p).slice(0, 300);
  if (d >= 3) return '…';
  const out = {};
  let i = 0;
  for (const k of Object.keys(p)) {
    if (i >= 30) { out._more = '…'; break; }
    i += 1;
    if (isSecretKey(k)) { out[k] = '***'; continue; }
    const v = p[k];
    if (v && typeof v === 'object') out[k] = safeParams(v, d + 1);
    else out[k] = typeof v === 'string' ? clip(v, 400) : v;
  }
  return out;
}

// ───────────────────────── 读取 / 自检（供门禁与 CLI） ─────────────────────────

/** 记录器自身的健康状态。**门禁必须断言这个**，否则"记录器坏了"又是一次静默失败。 */
function health() {
  return {
    enabled,
    dir: TRACE_DIR,
    ...stats,
    sessions: sessions.size,
    ok: enabled && stats.writeErrors === 0 && !stats.disabledReason,
  };
}

/** 读某个任务的完整记录（解析失败的行跳过并计数，不抛）。 */
function read(taskId) {
  const p = fileOf(taskId);
  const out = { taskId, path: p, exists: false, events: [], badLines: 0 };
  try {
    const txt = fs.readFileSync(p, 'utf8');
    out.exists = true;
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.events.push(JSON.parse(line)); } catch { out.badLines += 1; }
    }
  } catch { /* 不存在即返回 exists:false */ }
  return out;
}

/** 列出最近的 trace 文件（按 mtime 倒序）。 */
function list(limit) {
  const n = Number(limit) || 20;
  try {
    return fs.readdirSync(TRACE_DIR)
      .filter((f) => /\.jsonl$/.test(f))
      .map((f) => {
        const p = path.join(TRACE_DIR, f);
        try {
          const st = fs.statSync(p);
          return { file: f, path: p, bytes: st.size, mtime: st.mtimeMs, taskId: f.replace(/\.jsonl$/, '') };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n);
  } catch { return []; }
}

/** 供单测重置（不对外）。sessions.clear() 已一并清掉 seq / sessionId，无需额外改。 */
function __reset() {
  sessions.clear();
  stats.writes = 0; stats.writeErrors = 0; stats.lastError = ''; stats.droppedLines = 0; stats.tasks = 0;
  stats.disabledReason = '';
  stats.bindConflicts = 0;
}

module.exports = {
  MAX_LINES, MAX_BYTES, KEEP_DAYS, HEAD_LIMITS,
  init, isEnabled, wantsFull, isSecretKey, keyWords,
  begin, llmReq, llmResp, tool, gate, terminal, error, end,
  bindSession, record, recordEx, read, list, health, __reset,
};
