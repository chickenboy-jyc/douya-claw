'use strict';

/**
 * loopUnitKinds.js —— **执行单元事件**的词汇表 + 配对追踪器（阶段 2 / 卡 S2-3）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个文件为什么独立存在（先讲清边界，再讲实现）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **与会话域零交集**：`DOMAIN_EVENT_KINDS`（`domainEvents.js`）是**会话域**的事件类型，
 *      进的是 append-only 的会话真源；本文件的两个 kind 是**执行轨迹**，进 `taskTrace`。
 *      规格裁决 5 选 (b)：执行轨迹**不进**会话域。两套常量分开冻结、零引用，
 *      改本文件不会（也不许）影响会话域一行 —— 门禁 LU2 用真 require 比集合来钉这一点，
 *      不写死字面量（写死就变成"两份名单各自漂移，谁也不知道"）。
 *
 *   ② **为什么现在只做词汇、不插主循环**：`backend.js` 是冻结文件（11754 行），
 *      每插一次就要重抠 hunks + 重写 thaw 申报。在「事件长什么样、配对怎么保证、seq 从哪来」
 *      还没定死的时候去插，返工一次就是一次重抠。所以先让词汇与判据在盘上全绿（卡 S2-3），
 *      再一次性插进主循环（卡 S2-4）。本文件此刻**没有被任何生产代码引用**，这是有意为之。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 纪律（每条都对应一条门禁负控，改之前先看负控是哪个）
 * ═══════════════════════════════════════════════════════════════════════
 *   · **配对不许靠猜**：`pending()` 让「开了没关」可被发现（负控 A）。
 *   · **因果不许伪造**：`end` 的 `causationId` 只能来自 `begin` 拿到的 `seq`；
 *     读数一律先过白名单、且**宿主字段在读数之后展开**（负控 D / E + 顺序变异臂）。
 *   · **begin 丢了要留痕**：`recordEx` 回 `ok:false` 时 token.seq 是 `null`，
 *     `stats.beginLost` 计数，`end` 照常落盘并带 `causationId:null`（负控 C）。
 *     不许「因为 begin 没写成功就不写 end」—— 那会把一次真实执行整段抹掉。
 *   · **重复 end 不静默**：带 `duplicate:true` 落盘 + `stats.orphanEnd` 计数（负控 B）。
 */

/**
 * 执行单元事件的两种 kind（冻结）。
 *
 * kebab-case 与 `DOMAIN_EVENT_KINDS` 的风格一致，但**前缀 `loop-unit-` 保证与遗留 kind 不撞**。
 * 冻结（`Object.freeze`）不是形式主义：这两个字符串是磁盘上的**事实**，改一个字母，
 * 历史 trace 的回放就断一截，而断的地方不会报错。
 *
 * @type {ReadonlyArray<string>}
 */
const LOOP_UNIT_KINDS = Object.freeze(['loop-unit-begin', 'loop-unit-end']);

/**
 * 规格 §2.3 的 11 个**可命名**执行单元。
 *
 * `digestOf` / `extractPaths` 这类 A 组内联小函数**不配事件**：它们没有独立的开始/结束语义，
 * 给它配一对事件只会制造「配对了但什么都没说明」的噪声（规格 §2.3 已写明理由）。
 * 顺序即规格里的顺序，改动需同步规格与门禁 LU3。
 *
 * @type {ReadonlyArray<string>}
 */
const LOOP_UNITS = Object.freeze([
  'loop-init',
  'delegate',
  'wrapup-inject',
  'model-call',
  'stream-read',
  'acceptance',
  'plan-parallel',
  'tool-exec',
  'turn-trace',
  'terminal',
  'loop-finally',
]);

/**
 * `end` 允许携带的**机器读数**键白名单。
 *
 * 为什么要有白名单而不是「什么都让写」：规格 §2.4-1 要求「不得仅凭模型自述证明执行过」。
 * 如果模型正文（`contentFull` 之类）能被塞进事件，那么一条 `loop-unit-end` 里就会出现
 * 「我已启动其他 Agent 并完成了产物」这种**自述**，事后回放读起来和事实一模一样。
 * 白名单把它挡在**结构上**（写不进来），而不是靠门禁事后 grep 关键词 —— 后者永远漏词。
 *
 * @type {ReadonlyArray<string>}
 */
const UNIT_READING_KEYS = Object.freeze([
  'ok', 'status', 'tokens', 'ms', 'count', 'reason',
  'tool', 'verdict', 'artifactHashes', 'childTaskId',
]);

/**
 * 造一个执行单元追踪器。**纯状态机，不碰 IO** —— 写盘全部经注入的 `rec.recordEx`。
 *
 * 为什么注入而不是直接 `require('./taskTrace')`：
 *   「begin 写失败」这条负控必须能在**不弄坏磁盘**的前提下构造出来。注入之后，门禁用
 *   一个「第一次返回 `{ok:false,seq:0}`、其余委托真 taskTrace」的桩就能造出那个场景，
 *   同时端上来的事件仍然真实落盘、可读回。直接 require 就只有「删目录」一种造法，
 *   而删目录会让整轮写盘全失败，测不到「只有 begin 丢了、end 还在」。
 *
 * @param {{recordEx:function(string,string,object):{ok:boolean, seq:number}}} rec
 *   通常是 `taskTrace`；也允许是桩（见上）。
 * @param {string} taskId 落盘时的任务 id
 * @returns {{
 *   begin:function(string):{unit:string, unitRunId:string, seq:(number|null)},
 *   end:function(string, object, object):{ok:boolean, seq:number, dropped:number},
 *   pending:function():Array<{unit:string, seq:(number|null)}>,
 *   stats:function():{begins:number, ends:number, beginLost:number, droppedKeys:number, orphanEnd:number}
 * }}
 */
function createUnitTracker(rec, taskId) {
  if (!rec || typeof rec.recordEx !== 'function') {
    throw new TypeError('createUnitTracker: rec 必须提供 recordEx(taskId, kind, payload)');
  }
  const id = String(taskId == null ? '' : taskId) || 'unknown';

  /** unitRunId -> token。用 Map 而不是对象：`__proto__` 这类键名不会闹鬼。 */
  const open = new Map();
  const counters = { begins: 0, ends: 0, beginLost: 0, droppedKeys: 0, orphanEnd: 0 };
  let serial = 0;

  /**
   * 开一个执行单元。
   *
   * `unit` 不在 `LOOP_UNITS` 里 ⇒ **抛错**。这不是运行时状况，是编程错误：
   * 一个没登记的名字意味着 `LOOP_UNITS` 与调用点已经不一致，而门禁 LU3 只钉前者。
   * 默默接受它，就会在磁盘上留下一批「谁也不知道属于哪一类」的事件。
   *
   * @param {string} unit
   * @returns {{unit:string, unitRunId:string, seq:(number|null)}} token，必须原样交回 `end`
   */
  function begin(unit) {
    const u = String(unit == null ? '' : unit);
    if (LOOP_UNITS.indexOf(u) === -1) {
      throw new Error('createUnitTracker.begin: 未登记的执行单元 "' + u + '"（LOOP_UNITS 只有 '
        + LOOP_UNITS.length + ' 个）');
    }
    serial += 1;
    const unitRunId = u + '#' + serial;
    const r = rec.recordEx(id, LOOP_UNIT_KINDS[0], { unit: u, unitRunId });
    const seq = r && r.ok ? r.seq : null;
    if (seq === null) counters.beginLost += 1;
    counters.begins += 1;
    const token = { unit: u, unitRunId, seq };
    open.set(unitRunId, token);
    return token;
  }

  /**
   * 收一个执行单元。
   *
   * 读数过滤与展开顺序（**这两条是同一个洞的两半**）：
   *   · `readings` 逐个键对 `UNIT_READING_KEYS` 检查，不在表里的一律丢弃并计数；
   *   · 展开顺序必须是「**读数先、宿主字段后**」。反过来写，读数就能覆盖
   *     `unit` / `unitRunId` / `causationId` —— 那就是伪造因果，而且伪造出来的因果
   *     在回放里和真的长得一模一样。门禁 LU14 用真值表证明这两半各自挡的是哪一层。
   *
   * ⚠️ `causationId` 是**纯序号，不带任务/文件身份** —— 它的意义只在同一个 `taskId` 的流里成立。
   *   把 A 任务的 token 交给 B 任务的 `end`，`t.unit === u` 照样通过、`open.has(uri)` 为假
   *   ⇒ 落成 `duplicate:true`，而那串 `causationId` 在 B 的文件里悬空（指向一条不存在的 begin）。
   *   门禁 LU17b 是这个边界的负控 —— 不是"防不住"，是这个性质的边界就在这里。
   *
   * @param {string} unit
   * @param {{unit:string, unitRunId:string, seq:(number|null)}} token `begin` 的返回值
   * @param {object=} readings 机器读数（只允许白名单里的键）
   * @returns {{ok:boolean, seq:number, dropped:number}}
   */
  function end(unit, token, readings) {
    const u = String(unit == null ? '' : unit);
    const t = token && typeof token === 'object' ? token : {};
    if (t.unit !== u) {
      // token 与 unit 不配对 ⇒ 编程错误。放过去就会产生一条「end 属于 A、causationId 指向 B」
      // 的事件，也就是门禁刚要防的那种假因果，只不过这次是调用方自己造出来的。
      throw new Error('createUnitTracker.end: token 属于 "' + String(t.unit)
        + '"，但收到的是 "' + u + '"');
    }
    const src = readings && typeof readings === 'object' ? readings : {};
    const filtered = {};
    let dropped = 0;
    for (const k of Object.keys(src)) {
      if (UNIT_READING_KEYS.indexOf(k) === -1) { dropped += 1; continue; }
      filtered[k] = src[k];
    }
    counters.droppedKeys += dropped;

    const uri = String(t.unitRunId == null ? '' : t.unitRunId);
    const cid = t.seq == null ? null : t.seq;
    const isOrphan = !open.has(uri);
    if (isOrphan) counters.orphanEnd += 1;
    else open.delete(uri);

    // ⚠️ 顺序不能反：读数的键虽然已被白名单过滤，但「过滤」与「先后」是两层独立的防线，
    //    少一层就少一次被发现的机会（LU14a/b/c 是这条的实测矩阵）。
    const payload = Object.assign({}, filtered, { unit: u, unitRunId: uri, causationId: cid });
    if (isOrphan) payload.duplicate = true;

    const r = rec.recordEx(id, LOOP_UNIT_KINDS[1], payload);
    counters.ends += 1;
    return { ok: !!(r && r.ok), seq: r && r.ok ? r.seq : 0, dropped };
  }

  /**
   * 还没 end 的 token。
   *
   * 「漏 end」必须能被**点名**而不是靠人肉翻磁盘 —— 一个永远不结束的单元，
   * 事后看就是「这段时间什么都没发生」，而实际上它可能一直在等一个永不到来的回调。
   *
   * @returns {Array<{unit:string, seq:(number|null)}>}
   */
  function pending() {
    const out = [];
    for (const t of open.values()) out.push({ unit: t.unit, seq: t.seq });
    return out;
  }

  /**
   * 计数器副本（副本，不是引用：调用方拿不到内部对象，就不会意外改掉它）。
   *
   * @returns {{begins:number, ends:number, beginLost:number, droppedKeys:number, orphanEnd:number}}
   */
  function stats() {
    return {
      begins: counters.begins,
      ends: counters.ends,
      beginLost: counters.beginLost,
      droppedKeys: counters.droppedKeys,
      orphanEnd: counters.orphanEnd,
    };
  }

  return { begin, end, pending, stats };
}

module.exports = {
  LOOP_UNIT_KINDS,
  LOOP_UNITS,
  UNIT_READING_KEYS,
  createUnitTracker,
};
