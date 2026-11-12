'use strict';

/**
 * mcpStdioClient.js —— 通用 MCP over stdio 客户端（JSON-RPC 2.0 · 换行分帧）。
 *
 * 目标进程：开源视频编辑器 Concat（`jub0t/Concat`，Rust）。它的 `docs/MCP.md` 写的口径是：
 *   「MCP over stdio, newline-delimited JSON-RPC 2.0 ... `ping` / `tools/list` / `tools/call` /
 *     progress notifications for `export_wait` / `notifications/cancelled` 都支持；
 *     **标准输出只走协议，服务端日志走标准错误**。」
 * 本文件按这条口径实现。纯 CJS、零第三方依赖、不需要 Electron 运行时，
 * 所以既能被 `backend.js` require，也能被门禁在纯 node 里直接跑。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这一轮的范围：只做「客户端本身正确、可靠、可测」，**不接线**
 * ═══════════════════════════════════════════════════════════════════════
 *   只导出两个东西：`findConcatExecutable()` 与 `createMcpStdioClient(options)`。
 *   本文件不 require 任何 src/main 里的兄弟模块（不碰 backend.js / main.js），
 *   这样接线那一刀可以独立评审、独立回滚。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 十个真实的坑，逐条对应下面的实现（都是踩出来的，不是假想）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① 分帧：stdout 是换行分隔的 JSON。一条 JSON 可能被管道拆成多块，一次 read 也可能
 *      拿到多行 ⇒ 必须缓存**不完整的尾段**等下一块拼上（见 handleStdoutChunk）。
 *   ② 超大单行：`preview_frame` 把合成帧 base64 内联在 JSON 里，单行好几 MB。
 *      上限给 64 MiB；超了报 `line-too-large` 并**明确失败**。既不静默截断（截断后
 *      只会得到一条"看起来正常"的解析失败），也不让缓冲区涨到 OOM。
 *   ③ stderr 必须持续 drain：Concat 把日志写标准错误，不读它管道写满后子进程会卡死在
 *      writeSys / write 上（门禁用 `fs.writeSync(2, ...)` 复现了这一死锁）。
 *      保留**最近 200 行**（环形）供报错时附上，不无限累积。
 *   ④ stdout 上的非 JSON 行：真实程序可能混调试输出 ⇒ 解析失败**记下来跳过**，不崩。
 *   ⑤ 子进程崩溃/退出：所有 pending 请求必须以明确错误 reject（带 exit code + stderr 尾部）。
 *      永远挂着的 Promise 在生产里表现为"点了没反应"，是最难查的一类。
 *   ⑥ 超时：①reject ②发 `notifications/cancelled`（带该请求 id）③清掉 pending。
 *      清 pending 是为了让**迟到响应**按孤儿丢弃，防止 id 复用后错配。
 *   ⑦ id 严格对应：并发调用时每个响应必须回到自己的调用方；查不到的响应丢弃并 emit 'orphan'。
 *   ⑧ spawn 环境隔离：从 env 里**删掉** `ELECTRON_RUN_AS_NODE` 与 `NODE_OPTIONS`。
 *      宿主 Electron 会设这两个，传下去会让子进程行为变形（本仓已知踩坑点）。
 *   ⑨ Windows 上可能被 Smart App Control 拦 spawn：`EPERM` 裸奔到调用栈顶部没人看得懂，
 *      这里翻译成可读错误（带可能原因与处置建议）。
 *   ⑩ `findConcatExecutable()` 不能只用 `existsSync`：同名**目录**也会 `existsSync === true`，
 *      必须 `statSync().isFile()` 才算数。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 事件
 * ═══════════════════════════════════════════════════════════════════════
 *   `notification` (msg)                服务端主动发的 JSON-RPC 通知（含 progress / log）
 *   `exit`         (info)               子进程退出：{ code, signal, stderrTail }
 *   `orphan`       (msg)                收到查不到 pending 的响应（迟到/无关），已丢弃
 *   `nonjson`      (line)               stdout 上收到解析不了的行，已跳过
 *   `spawnError`   (err)                spawn 失败（可读错误）。**不用 'error' 这个名字**：
 *                                       EventEmitter 的 'error' 没监听者会抛，反而把可读错误变成崩溃。
 *   `stderr`       (chunk)              stderr 原始块（一般只在调试时用）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
// 子进程字节 → 文本的唯一真源。
// ⚠️ 本模块会被 `skills/concat-video/lib/mcp.js` 在**普通 node** 下 require（打包后走
//    resources/src/main/mcpStdioClient.js），所以 childOutput 必须零依赖 —— 它是的。
const { decodeOutput } = require('./childOutput');

/** 默认协商协议版本。Concat 同时服务 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 四个版本。 */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** `export_wait` 这类工具可能要几分钟 ⇒ 默认超时给 10 分钟，允许调用方覆盖。 */
const DEFAULT_TOOL_TIMEOUT_MS = 600000;

/** 握手/列表这类轻请求的超时。 */
const DEFAULT_CONTROL_TIMEOUT_MS = 60000;

/** 单行上限 64 MiB（`preview_frame` 的 base64 合成帧实测能到好几 MB）。 */
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/** stderr 环形缓冲的行数上限。 */
const DEFAULT_STDERR_TAIL_LINES = 200;

/** 单行 stderr 超过这个长度就强制落锤，避免没有换行的日志把 partial 撑爆。 */
const STDERR_PARTIAL_MAX_CHARS = 64 * 1024;

/** 非 JSON 行的保留条数（诊断用，不参与业务判断）。 */
const NON_JSON_KEEP = 50;

/** `tools/list` 分页防御上限，防止服务端游标死循环。 */
const MAX_LIST_PAGES = 200;

/** 优雅关的等待：先关 stdin 等自然退出，超时再 kill，再超时强杀。 */
const DEFAULT_CLOSE_GRACE_MS = 3000;
const DEFAULT_KILL_GRACE_MS = 1500;

/** clientInfo.name —— 服务端日志里能看到是我们。 */
const CLIENT_NAME = 'douya-claw';

/**
 * 读本包版本号当 `clientInfo.version`。读不到就如实给 '0.0.0'（不编造）。
 *
 * @returns {string}
 */
function readClientVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    const v = pkg && pkg.version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 探测 Concat 可执行文件。**任何情况下都不抛异常**，找不到就如实返回 null。
 *
 * 探测顺序（与 Windows 上的真实安装形态对应）：
 *   1. `DOUYA_CONCAT_PATH` 环境变量（运维/调试用的显式覆盖，优先级最高）
 *   2. `%LOCALAPPDATA%\Programs\Concat\concat.exe`（用户级安装）
 *   3. `C:\Program Files\Concat\concat.exe`（全局 / .msi）
 *   4. PATH 里的 `concat`（含 `Program Files` 之外的便携版）
 *
 * ⚠️ 判据是 `statSync(p).isFile()`，**不是** `existsSync(p)`：
 *    同名**目录**也会让 existsSync 为真，那会把"没装"误报成"装了"，随后 spawn 才炸。
 *
 * @param {{env?:Record<string,string|undefined>, platform?:string, extraCandidates?:string[]}=} options
 * @returns {{path:string, source:string}|null}
 */
function findConcatExecutable(options) {
  const o = options || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const exeName = platform === 'win32' ? 'concat.exe' : 'concat';

  /** @param {string} p @returns {boolean} */
  const isRealFile = (p) => {
    if (!p || typeof p !== 'string') return false;
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  const explicit = env.DOUYA_CONCAT_PATH;
  if (explicit && isRealFile(explicit)) {
    return { path: explicit, source: 'env:DOUYA_CONCAT_PATH' };
  }

  if (Array.isArray(o.extraCandidates)) {
    for (const c of o.extraCandidates) {
      if (isRealFile(c)) return { path: c, source: 'extraCandidates' };
    }
  }

  // ★ 2026-11-07 实测缺陷：环境变量可能整个缺失。本机 bash 里 `LOCALAPPDATA` 与
  //   `ProgramFiles` 都是**空串**，装上 Concat 之后本函数仍返回 null —— 用户会看到
  //   「装了但豆芽说没装」。所以拿不到环境变量时退回 Windows 的约定绝对路径，而不是跳过。
  //   （只在 win32 上兜底：其它平台没有这两个变量是正常的。）
  const homeDir = env.USERPROFILE || env.HOME || os.homedir();
  const localAppData = env.LOCALAPPDATA ||
    (platform === 'win32' && homeDir ? path.join(homeDir, 'AppData', 'Local') : '');
  if (localAppData) {
    const p = path.join(localAppData, 'Programs', 'Concat', exeName);
    if (isRealFile(p)) return { path: p, source: 'localappdata' };
  }

  // `ProgramW6432` 是 64 位进程看到的 Program Files，32 位进程里 ProgramFiles 会指向 (x86)。
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || env.ProgramW6432 ||
    (platform === 'win32' ? (env.SystemDrive || 'C:') + path.sep + 'Program Files' : '');
  if (programFiles) {
    const p = path.join(programFiles, 'Concat', exeName);
    if (isRealFile(p)) return { path: p, source: 'programfiles' };
  }
  const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] ||
    (platform === 'win32' ? (env.SystemDrive || 'C:') + path.sep + 'Program Files (x86)' : '');
  if (programFilesX86 && programFilesX86 !== programFiles) {
    const p = path.join(programFilesX86, 'Concat', exeName);
    if (isRealFile(p)) return { path: p, source: 'programfiles-x86' };
  }

  // PATH 扫描。只在目录存在时拼路径，逐个 statSync 判 isFile。
  const pathVar = env.PATH || env.Path || '';
  const dirs = String(pathVar).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, exeName);
    if (isRealFile(p)) return { path: p, source: 'PATH' };
  }

  return null;
}

/**
 * 把 spawn 的原始错误翻译成能看懂的话（⑨：Windows Smart App Control 拦截）。
 *
 * @param {NodeJS.ErrnoException} err
 * @param {string} command
 * @returns {Error}
 */
function toReadableSpawnError(err, command) {
  const code = err && err.code ? String(err.code) : 'UNKNOWN';
  const raw = err && err.message ? String(err.message) : String(err);
  let hint = '';
  if (code === 'ENOENT') {
    hint = '（找不到可执行文件：Concat 可能没安装，或路径写错）';
  } else if (code === 'EPERM' || code === 'EACCES') {
    hint = '（权限被拒：Windows 上常见于 Smart App Control / 杀软拦截可执行文件；'
      + '可在「Windows 安全中心 → 应用和浏览器控制」放行，或改用已签名/受信任的安装路径）';
  } else if (code === 'EBUSY') {
    hint = '（文件被占用：另一个进程正持有该可执行文件）';
  }
  const e = new Error('MCP: 无法启动子进程 ' + command + ' —— ' + code + ': ' + raw + hint);
  e.code = 'mcp-spawn-failed';
  e.rawCode = code;
  e.command = command;
  e.hint = hint;
  return e;
}

/**
 * 建一个 MCP over stdio 客户端。**spawn 是立即发生的**（构造即启动），
 * 这样 `client.pid` 从第一刻就可用；spawn 失败则以可读错误 reject 所有请求，
 * 并 emit 'spawnError'，不会静默变成"请求永远 pending"。
 *
 * @param {{
 *   command?: string,
 *   args?: string[],
 *   env?: Record<string,string|undefined>,
 *   cwd?: string,
 *   protocolVersion?: string,
 *   clientInfo?: {name?:string, version?:string},
 *   defaultTimeoutMs?: number,
 *   maxLineBytes?: number,
 *   stderrTailLines?: number,
 *   closeGraceMs?: number,
 *   autoInitialize?: boolean,
 * }} [options]
 * @returns {object} client
 */
function createMcpStdioClient(options) {
  const o = options || {};
  const command = typeof o.command === 'string' && o.command ? o.command : 'concat';
  const args = Array.isArray(o.args) ? o.args.filter((a) => typeof a === 'string') : ['--mcp'];
  const protocolVersion = typeof o.protocolVersion === 'string' && o.protocolVersion
    ? o.protocolVersion
    : DEFAULT_PROTOCOL_VERSION;
  const clientInfo = {
    name: (o.clientInfo && o.clientInfo.name) || CLIENT_NAME,
    version: (o.clientInfo && o.clientInfo.version) || readClientVersion(),
  };
  const defaultTimeoutMs = Number.isFinite(o.defaultTimeoutMs) && o.defaultTimeoutMs > 0
    ? o.defaultTimeoutMs
    : DEFAULT_TOOL_TIMEOUT_MS;
  const maxLineBytes = Number.isFinite(o.maxLineBytes) && o.maxLineBytes > 0
    ? o.maxLineBytes
    : DEFAULT_MAX_LINE_BYTES;
  const stderrTailLines = Number.isFinite(o.stderrTailLines) && o.stderrTailLines > 0
    ? Math.floor(o.stderrTailLines)
    : DEFAULT_STDERR_TAIL_LINES;
  const closeGraceMs = Number.isFinite(o.closeGraceMs) && o.closeGraceMs >= 0
    ? o.closeGraceMs
    : DEFAULT_CLOSE_GRACE_MS;
  const autoInitialize = o.autoInitialize !== false;

  const emitter = new EventEmitter();
  emitter.setMaxListeners(64);

  /** 'starting' | 'running' | 'closing' | 'closed' | 'failed' */
  let state = 'starting';
  /** @type {import('child_process').ChildProcess|null} */
  let child = null;
  /** @type {Error|null} */
  let spawnError = null;
  let exited = false;
  /** @type {{code:number|null, signal:string|null}|null} */
  let exitInfo = null;

  let nextId = 1;
  /** @type {Map<number, object>} */
  const pending = new Map();
  /** @type {Map<string, object>} */
  const progressIndex = new Map();

  /**
   * stdout 接收缓冲：保存**不完整的尾段**（坑①）。
   *
   * ⚠️ 形状是「整块列表 + 总长度」，**不是**一个用 `Buffer.concat` 反复追加的大 Buffer：
   *    `preview_frame` 的单行能到 9 MB，按 64 KB 一块到达就是 140 次追加；
   *    每次都重拷累积部分 ⇒ O(n²) 拷贝量（实测能把这台机器拖到超时）。
   *    改成 spill 列表后只在**见到换行的那一刻**拼一次，整体是线性的。
   */
  let spill = [];
  let spillLen = 0;

  /** stderr 环形缓冲（坑③）。 */
  const stderrRing = [];
  let stderrPartial = '';
  let stderrTotalLines = 0;

  /** stdout 上解析不了的行（坑④）。 */
  const nonJsonLines = [];

  /** @type {{serverInfo:object|null, protocolVersion:string|null, capabilities:object|null, instructions:string|null, raw:object}|null} */
  let negotiated = null;
  /** @type {Promise<object>|null} */
  let initPromise = null;
  /** @type {Promise<any>|null} */
  let closePromise = null;
  let closeResult = null;

  // ── 事件小工具 ────────────────────────────────────────────────────────
  /** @param {string} ev @param {*} payload */
  function emitSafe(ev, payload) {
    try {
      emitter.emit(ev, payload);
    } catch {
      /* 监听者自己抛不能反噬客户端 */
    }
  }

  // ── stderr ───────────────────────────────────────────────────────────
  /** @param {string} line */
  function pushStderrLine(line) {
    stderrTotalLines += 1;
    stderrRing.push(line);
    while (stderrRing.length > stderrTailLines) stderrRing.shift();
  }

  /** @param {Buffer} chunk */
  function handleStderrChunk(chunk) {
    // 坑③：必须把数据读走。这里只做记账，不抛、不阻塞。
    // 【解码分类：stderr → GBK 回退】stderr 的用途是「MCP 服务器为什么挂了」的证据，
    //   会原样进 `stderrTail()` → 给用户/模型的失败文案。MCP 服务器可能是 node（utf8），
    //   也可能是任何原生 exe / cmd 包装（中文 Windows 上是 cp936）⇒ 必须走 decodeOutput()。
    //   注意**不能只解新增的 chunk** 再拼 partial：行切分依赖已有 partial 的内容，
    //   原实现对 partial 存的是字符串、对 chunk 用 utf8 硬解；这里把 chunk 的解码换成
    //   decodeOutput 即可（纯 ASCII 与合法 UTF-8 下结果与原先逐字节一致）。
    let text = stderrPartial + decodeOutput(chunk);
    let idx = text.indexOf('\n');
    while (idx >= 0) {
      const line = text.slice(0, idx).replace(/\r$/, '');
      text = text.slice(idx + 1);
      pushStderrLine(line);
      idx = text.indexOf('\n');
    }
    stderrPartial = text;
    if (stderrPartial.length > STDERR_PARTIAL_MAX_CHARS) {
      pushStderrLine(stderrPartial);
      stderrPartial = '';
    }
    emitSafe('stderr', chunk);
  }

  /** 把尾部 partial 也落进环形缓冲（退出时调用，避免最后一行没换行就丢了）。 */
  function flushStderrPartial() {
    if (stderrPartial) {
      pushStderrLine(stderrPartial.replace(/\r$/, ''));
      stderrPartial = '';
    }
  }

  /**
   * 取最近 n 行 stderr。
   *
   * @param {number=} n
   * @returns {string[]}
   */
  function stderrTail(n) {
    const k = Number.isFinite(n) && n > 0 ? Math.floor(n) : stderrTailLines;
    return stderrRing.slice(Math.max(0, stderrRing.length - k));
  }

  // ── pending 管理 ──────────────────────────────────────────────────────
  /**
   * 一次性了结一个 pending 请求（成功或失败）。
   *
   * @param {object} entry
   * @param {{result?:*, error?:Error}} outcome
   */
  function settleEntry(entry, outcome) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    pending.delete(entry.id);
    if (entry.progressToken) progressIndex.delete(entry.progressToken);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.signal && entry.onAbort && typeof entry.signal.removeEventListener === 'function') {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort);
      } catch {
        /* 忽略：不同 AbortSignal 实现的差异 */
      }
    }
    if (outcome && outcome.error) {
      try {
        entry.reject(outcome.error);
      } catch {
        /* 调用方自己的 then 抛错不该反噬客户端 */
      }
    } else {
      try {
        entry.resolve(outcome ? outcome.result : undefined);
      } catch {
        /* 同上 */
      }
    }
  }

  /**
   * 所有 pending 一律 reject（子进程退出/关闭/spawn 失败/致命帧错误时用，坑⑤）。
   *
   * @param {(entry:object)=>Error} makeErr
   */
  function rejectAllPending(makeErr) {
    const entries = Array.from(pending.values());
    for (const entry of entries) settleEntry(entry, { error: makeErr(entry) });
    pending.clear();
    progressIndex.clear();
  }

  /** @returns {Error} 子进程退出/不可用时的统一错误 */
  function makeUnavailableError(entry) {
    const method = entry && entry.method ? String(entry.method) : 'unknown';
    const idPart = entry && entry.id !== undefined ? String(entry.id) : '?';
    const ecode = exitInfo && exitInfo.code !== null && exitInfo.code !== undefined ? exitInfo.code : null;
    const sig = exitInfo && exitInfo.signal ? exitInfo.signal : null;
    const why = spawnError
      ? spawnError.message
      : 'MCP 子进程已退出（exit code ' + (ecode === null ? '<无>' : String(ecode))
        + (sig ? ', signal ' + sig : '') + '）';
    const tail = stderrTail(20);
    const message = 'MCP 请求失败 [' + method + ' id=' + idPart + ']：' + why
      + (tail.length ? '；stderr 尾部：' + tail.join(' | ') : '');
    const err = new Error(message);
    err.code = spawnError ? 'mcp-spawn-failed' : 'mcp-exit';
    err.method = method;
    err.rpcId = entry ? entry.id : null;
    err.exitCode = ecode;
    err.signal = sig;
    err.stderrTail = tail;
    return err;
  }

  // ── stdout 解析（坑①②④⑦）────────────────────────────────────────────
  /**
   * 致命帧错误：单行超过上限。缓冲区已经不可信 ⇒ 明确失败并收掉子进程，绝不静默截断。
   *
   * @param {number} bytes
   */
  function failLineTooLarge(bytes) {
    spill = [];
    spillLen = 0;
    const err = new Error('MCP stdout 单行超过上限 ' + maxLineBytes + ' 字节'
      + '（已缓存 ' + bytes + ' 字节仍未见换行，坑②）：疑似服务端吐了一条超大 JSON；'
      + '如确属正常请调大 maxLineBytes');
    err.code = 'line-too-large';
    err.maxLineBytes = maxLineBytes;
    err.bufferedBytes = bytes;
    rejectAllPending(() => {
      const e = new Error(err.message);
      e.code = 'line-too-large';
      e.maxLineBytes = maxLineBytes;
      e.bufferedBytes = bytes;
      return e;
    });
    emitSafe('spawnError', err);
    // 缓冲区已经乱了，继续读只会越读越错；收掉子进程（close 里会等它真退出）。
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }

  /**
   * 处理一条完整的 stdout 行。
   *
   * @param {string} rawLine
   */
  function handleLine(rawLine) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) return;
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      // 坑④：非 JSON 行记下来跳过，客户端不崩。
      nonJsonLines.push(line.slice(0, 512));
      while (nonJsonLines.length > NON_JSON_KEEP) nonJsonLines.shift();
      emitSafe('nonjson', line);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      // 'null' / '42' / '[1,2,3]' 这类合法 JSON 但不是对象：同样按垃圾处理。
      nonJsonLines.push(line.slice(0, 512));
      while (nonJsonLines.length > NON_JSON_KEEP) nonJsonLines.shift();
      emitSafe('nonjson', line);
      return;
    }
    handleMessage(msg);
  }

  /**
   * 分派一条已解析的 JSON-RPC 消息。
   *
   * @param {object} msg
   */
  function handleMessage(msg) {
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;
    const hasMethod = typeof msg.method === 'string' && msg.method;

    if (hasMethod && hasId) {
      handleServerRequest(msg);
      return;
    }
    if (hasMethod) {
      handleNotification(msg);
      return;
    }
    if (hasId) {
      handleResponse(msg);
      return;
    }
    // 既没有 id 也没有 method：不是协议消息，按垃圾记一笔就好。
    nonJsonLines.push(JSON.stringify(msg).slice(0, 512));
    while (nonJsonLines.length > NON_JSON_KEEP) nonJsonLines.shift();
  }

  /**
   * 服务端 → 客户端的响应。
   *
   * @param {{id:*, result?:*, error?:{code:number,message:string,data?:*}}} msg
   */
  function handleResponse(msg) {
    const entry = pending.get(msg.id);
    if (!entry) {
      // 坑⑦：查不到 pending（超时后的迟到响应 / 不是我们的 id）⇒ 丢弃，绝不错配。
      emitSafe('orphan', msg);
      return;
    }
    if (msg.error && typeof msg.error === 'object') {
      const code = msg.error.code;
      const rmsg = msg.error.message === undefined ? '' : String(msg.error.message);
      const err = new Error('JSON-RPC 错误 ' + code + '：' + rmsg + '（' + String(entry.method) + '）');
      err.code = 'mcp-rpc-error';
      err.rpcCode = code;
      err.rpcMessage = rmsg;
      err.rpcData = msg.error.data;
      err.method = entry.method;
      err.rpcId = entry.id;
      settleEntry(entry, { error: err });
      return;
    }
    settleEntry(entry, { result: msg.result });
  }

  /**
   * 服务端 → 客户端的通知（progress / log / cancelled 回显等）。
   *
   * @param {{method:string, params?:object}} msg
   */
  function handleNotification(msg) {
    const params = msg.params && typeof msg.params === 'object' ? msg.params : null;
    if (msg.method === 'notifications/progress' && params) {
      const token = params.progressToken;
      const entry = token === undefined || token === null ? null : progressIndex.get(token);
      if (entry && typeof entry.onProgress === 'function') {
        try {
          entry.onProgress(params);
        } catch {
          /* 调用方的回调抛错不影响协议循环 */
        }
      }
    }
    emitSafe('notification', msg);
  }

  /**
   * 服务端 → 客户端的**请求**（协议允许，例如 `ping` / `roots/list` / `sampling/createMessage`）。
   * 不回应会让服务端一直等 ⇒ 必须回：会答的回 result，不会的回 -32601。
   *
   * @param {{id:*, method:string, params?:object}} msg
   */
  function handleServerRequest(msg) {
    const id = msg.id;
    if (msg.method === 'ping') {
      writeLineSafe({ jsonrpc: '2.0', id: id, result: {} });
      return;
    }
    writeLineSafe({
      jsonrpc: '2.0',
      id: id,
      error: { code: -32601, message: 'Method not found: ' + String(msg.method) + '（本客户端未实现）' },
    });
    emitSafe('notification', msg);
  }

  /**
   * 处理一块 stdout 数据：拼尾段、按换行切、逐行交给 handleLine（坑①②）。
   *
   * @param {Buffer} chunk
   */
  function handleStdoutChunk(chunk) {
    let buf = chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      const piece = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      let whole = piece;
      if (spillLen > 0) {
        // 坑①：见到换行才拼这一次（线性总拷贝量）。
        spill.push(piece);
        whole = Buffer.concat(spill, spillLen + piece.length);
        spill = [];
        spillLen = 0;
      }
      if (whole.length > maxLineBytes) {
        failLineTooLarge(whole.length);
        return;
      }
      // 【解码分类：stdout → JSON-RPC ⇒ **严格 utf-8，禁止 GBK 回退**】
      //   这一行是每一帧 JSON-RPC 的解码点：喂给 `handleLine` 之后立刻 `JSON.parse`。
      //   JSON 规范只允许 UTF-8；若在这里图省事换成 decodeOutput()，GBK 回退会把本来正确的
      //   JSON 解成乱码 ⇒ JSON.parse 失败 ⇒ **整个 MCP 连接被判协议错误**。
      //   那是把一个"显示问题"换成"功能故障"，所以这里必须钉死 utf8。
      //   （stderr 侧相反，见上面 handleStderrChunk 的注释。）
      handleLine(whole.toString('utf8'));
      if (state === 'closed' || state === 'failed') return;
    }
    if (buf.length) {
      // 复制一份再存：socket 的 data Buffer 可能复用了底下的内存池。
      spill.push(Buffer.from(buf));
      spillLen += buf.length;
      if (spillLen > maxLineBytes) failLineTooLarge(spillLen);
    }
  }

  // ── 写 ───────────────────────────────────────────────────────────────
  /** @returns {boolean} stdin 现在可写吗 */
  function stdinWritable() {
    return !!(child && child.stdin && !child.stdin.destroyed && child.stdin.writable);
  }

  /**
   * 写一条 JSON-RPC 消息（自动加换行）。写不进去就抛，由调用方决定怎么失败。
   *
   * @param {object} msg
   */
  function writeLine(msg) {
    if (!stdinWritable()) {
      const err = new Error('MCP: 子进程 stdin 不可写（未启动或已关闭）');
      err.code = 'mcp-stdin-closed';
      throw err;
    }
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * 尽力写（通知/回应场景：写不进去不算致命）。
   *
   * @param {object} msg
   * @returns {boolean}
   */
  function writeLineSafe(msg) {
    try {
      writeLine(msg);
      return true;
    } catch {
      return false;
    }
  }

  // ── 请求 ─────────────────────────────────────────────────────────────
  /**
   * 发一个 JSON-RPC 请求并等响应。
   *
   * @param {string} method
   * @param {object|undefined} params
   * @param {{timeoutMs?:number, signal?:AbortSignal, onProgress?:Function,
   *          progressToken?:string, label?:string}=} opts
   * @returns {Promise<*>} 原始 result
   */
  function request(method, params, opts) {
    const opt = opts || {};
    const timeoutMs = Number.isFinite(opt.timeoutMs) && opt.timeoutMs > 0 ? opt.timeoutMs : defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      if (spawnError) {
        reject(makeUnavailableError({ method: method, id: null }));
        return;
      }
      if (state === 'closed' || state === 'closing' || state === 'failed') {
        const e = new Error('MCP: 客户端已关闭，拒绝发送 ' + method);
        e.code = 'mcp-closed';
        reject(e);
        return;
      }

      const id = nextId;
      nextId += 1;

      const wantProgress = typeof opt.onProgress === 'function';
      const progressToken = wantProgress
        ? String(opt.progressToken || ('pt-' + id))
        : (opt.progressToken === undefined ? null : String(opt.progressToken));

      const finalParams = {};
      if (params && typeof params === 'object') {
        for (const k of Object.keys(params)) finalParams[k] = params[k];
      }
      if (progressToken) {
        // 2026-07-28 era 的「按请求 _meta」；老版本服务端会忽略这个键，无害。
        const meta = finalParams._meta && typeof finalParams._meta === 'object' ? finalParams._meta : {};
        const metaCopy = {};
        for (const k of Object.keys(meta)) metaCopy[k] = meta[k];
        metaCopy.progressToken = progressToken;
        finalParams._meta = metaCopy;
      }

      /** @type {object} */
      const entry = {
        id: id,
        method: method,
        resolve: resolve,
        reject: reject,
        settled: false,
        timer: null,
        onProgress: wantProgress ? opt.onProgress : null,
        progressToken: progressToken,
        signal: opt.signal || null,
        onAbort: null,
        timeoutMs: timeoutMs,
      };

      if (opt.signal && typeof opt.signal.addEventListener === 'function'
        && !(opt.signal.aborted === true)) {
        entry.onAbort = () => {
          if (entry.settled) return;
          // 调用方主动取消：同样先通知服务端再了结，免得服务端白干。
          writeLineSafe({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'cancelled-by-caller' },
          });
          const e = new Error('MCP 请求被调用方取消 [' + method + ' id=' + id + ']');
          e.code = 'mcp-aborted';
          e.method = method;
          e.rpcId = id;
          settleEntry(entry, { error: e });
        };
        try {
          opt.signal.addEventListener('abort', entry.onAbort);
        } catch {
          entry.onAbort = null;
        }
      }

      pending.set(id, entry);
      if (progressToken) progressIndex.set(progressToken, entry);

      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        const e = new Error('MCP 请求超时 [' + method + ' id=' + id + ']：'
          + timeoutMs + ' ms 内没有响应（坑⑥）');
        e.code = 'mcp-timeout';
        e.method = method;
        e.rpcId = id;
        e.timeoutMs = timeoutMs;
        // ①先发取消（让服务端有感知），②再清 pending，③最后 reject。
        // 顺序不能反：先 reject 会让门禁看不到取消，也会让"迟到响应"落到已清空的 pending 之外。
        writeLineSafe({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'timeout' },
        });
        settleEntry(entry, { error: e });
      }, timeoutMs);

      try {
        writeLine({ jsonrpc: '2.0', id: id, method: method, params: finalParams });
      } catch (e) {
        settleEntry(entry, { error: e });
      }
    });
  }

  /** 发一条 JSON-RPC 通知（无 id、不需响应）。 @param {string} method @param {object=} params */
  function notify(method, params) {
    return writeLineSafe({ jsonrpc: '2.0', method: method, params: params || {} });
  }

  /**
   * 显式取消某个已发出的请求（对外暴露，便于上层做"用户点了停止"）。
   *
   * @param {number} id
   * @param {string=} reason
   * @returns {boolean} 是否真的写进了 stdin
   */
  function cancelRequest(id, reason) {
    return notify('notifications/cancelled', {
      requestId: id,
      reason: reason || 'cancelled',
    });
  }

  // ── 握手 / 工具 ──────────────────────────────────────────────────────
  /**
   * `initialize` 握手，成功后自动发 `notifications/initialized`。幂等。
   *
   * @param {{timeoutMs?:number, signal?:AbortSignal}=} opts
   * @returns {Promise<{serverInfo:object|null, protocolVersion:string, capabilities:object|null,
   *                    instructions:string|null, raw:object}>}
   */
  async function initialize(opts) {
    if (negotiated) return negotiated;
    if (initPromise) return initPromise;
    const opt = opts || {};
    initPromise = (async () => {
      const result = await request('initialize', {
        protocolVersion: protocolVersion,
        capabilities: {},
        clientInfo: { name: clientInfo.name, version: clientInfo.version },
      }, {
        timeoutMs: Number.isFinite(opt.timeoutMs) && opt.timeoutMs > 0
          ? opt.timeoutMs
          : DEFAULT_CONTROL_TIMEOUT_MS,
        signal: opt.signal,
      });

      const r = result && typeof result === 'object' ? result : {};
      negotiated = {
        serverInfo: r.serverInfo && typeof r.serverInfo === 'object' ? r.serverInfo : null,
        protocolVersion: typeof r.protocolVersion === 'string' && r.protocolVersion
          ? r.protocolVersion
          : protocolVersion,
        capabilities: r.capabilities && typeof r.capabilities === 'object' ? r.capabilities : null,
        instructions: typeof r.instructions === 'string' ? r.instructions : null,
        raw: r,
      };
      // 握手完成的标志（服务端有些实现会等这条才开始正常应答）。
      notify('notifications/initialized', {});
      return negotiated;
    })();
    try {
      return await initPromise;
    } finally {
      // 失败不缓存：允许调用方重试（比如子进程重启后复用同一 client 对象不现实，但别卡死）。
      initPromise = null;
    }
  }

  /** 没有握手就先握手（`autoInitialize === false` 时改为明确报错）。 */
  async function ensureInitialized() {
    if (negotiated) return negotiated;
    if (!autoInitialize) {
      const e = new Error('MCP: 尚未 initialize()（autoInitialize=false）');
      e.code = 'mcp-not-initialized';
      throw e;
    }
    return initialize();
  }

  /**
   * `tools/list`，自动翻页（`nextCursor`）。
   *
   * @param {{timeoutMs?:number, signal?:AbortSignal}=} opts
   * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
   */
  async function listTools(opts) {
    const opt = opts || {};
    await ensureInitialized();
    /** @type {Array<object>} */
    const tools = [];
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    do {
      const params = {};
      if (cursor) params.cursor = cursor;
      const result = await request('tools/list', params, {
        timeoutMs: Number.isFinite(opt.timeoutMs) && opt.timeoutMs > 0
          ? opt.timeoutMs
          : DEFAULT_CONTROL_TIMEOUT_MS,
        signal: opt.signal,
      });
      pages += 1;
      const pageTools = result && Array.isArray(result.tools) ? result.tools : [];
      for (const t of pageTools) {
        if (t && typeof t === 'object') tools.push(t);
      }
      const next = result && typeof result.nextCursor === 'string' ? result.nextCursor : '';
      if (next && !seen.has(next) && pages < MAX_LIST_PAGES) {
        seen.add(next);
        cursor = next;
      } else {
        cursor = null;
      }
    } while (cursor);
    return tools;
  }

  /**
   * `tools/call`。返回**原始 result**，由调用方自己判断内容。
   *
   * ⚠️ 两类"失败"必须分开（这是本文件最容易被写错的地方）：
   *    · 工具级失败：`result.isError === true` ⇒ **不抛异常**，原样返回。
   *      "工具说这件事没干成"和"连接坏了"是两件事，混在一起会让上层以为 MCP 不可用。
   *    · JSON-RPC 层失败：消息里有 `error` 字段 ⇒ 抛异常，带 `rpcCode`。
   *
   * @param {string} name
   * @param {object=} args
   * @param {{timeoutMs?:number, onProgress?:(p:object)=>void, progressToken?:string,
   *          signal?:AbortSignal}=} opts
   * @returns {Promise<*>}
   */
  async function callTool(name, args, opts) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('mcp.callTool: name 必须是非空字符串');
    }
    const opt = opts || {};
    if (args !== undefined && args !== null && typeof args !== 'object') {
      throw new TypeError('mcp.callTool: args 必须是对象（收到 ' + typeof args + '）');
    }
    if (opt.signal && opt.signal.aborted === true) {
      const e = new Error('MCP tools/call 被调用方取消（发出前）[' + name + ']');
      e.code = 'mcp-aborted';
      e.method = 'tools/call';
      throw e;
    }
    await ensureInitialized();
    return request('tools/call', { name: name, arguments: args || {} }, {
      timeoutMs: Number.isFinite(opt.timeoutMs) && opt.timeoutMs > 0 ? opt.timeoutMs : defaultTimeoutMs,
      signal: opt.signal,
      onProgress: opt.onProgress,
      progressToken: opt.progressToken,
    });
  }

  /**
   * `ping`。
   *
   * @param {{timeoutMs?:number}=} opts
   * @returns {Promise<*>}
   */
  async function ping(opts) {
    const opt = opts || {};
    await ensureInitialized();
    return request('ping', {}, {
      timeoutMs: Number.isFinite(opt.timeoutMs) && opt.timeoutMs > 0
        ? opt.timeoutMs
        : DEFAULT_CONTROL_TIMEOUT_MS,
    });
  }

  // ── 关闭 ─────────────────────────────────────────────────────────────
  /**
   * 等子进程退出。
   *
   * @param {number} ms
   * @returns {Promise<boolean>} true = 已退出，false = 超时还在
   */
  function waitExit(ms) {
    if (exited || !child) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.removeListener('exit', onExit);
        } catch {
          /* 忽略 */
        }
        resolve(false);
      }, ms);
      child.once('exit', onExit);
    });
  }

  /**
   * 优雅关闭：先关 stdin 等自然退出，超时再 SIGTERM，再超时 SIGKILL。
   * **必须确保不留孤儿进程**（门禁会用 pid 探测确认）。幂等。
   *
   * @returns {Promise<{code:number|null, signal:string|null, forced:boolean}>}
   */
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!child) {
        state = 'closed';
        closeResult = { code: null, signal: null, forced: false };
        return closeResult;
      }
      if (exited) {
        state = 'closed';
        closeResult = {
          code: exitInfo ? exitInfo.code : null,
          signal: exitInfo ? exitInfo.signal : null,
          forced: false,
        };
        return closeResult;
      }
      state = 'closing';
      // 先让还在等的请求拿到明确错误（不能挂到进程消失为止）。
      rejectAllPending((entry) => {
        const e = new Error('MCP: 客户端正在关闭，请求 [' + String(entry.method)
          + ' id=' + String(entry.id) + '] 已取消');
        e.code = 'mcp-closed';
        e.method = entry.method;
        e.rpcId = entry.id;
        return e;
      });

      // ① 关 stdin：正规 MCP 服务端读到 EOF 会自己退。
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      } catch {
        /* 已经关了 */
      }
      let forced = false;
      if (!(await waitExit(closeGraceMs))) {
        // ② SIGTERM
        forced = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* 已经没了 */
        }
        if (!(await waitExit(DEFAULT_KILL_GRACE_MS))) {
          // ③ SIGKILL（Windows 上映射到 TerminateProcess）
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已经没了 */
          }
          await waitExit(DEFAULT_KILL_GRACE_MS);
        }
      }

      // 收尾：把流拆掉，避免句柄吊着 node 不退出。
      try {
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
        if (child.stdin) child.stdin.destroy();
      } catch {
        /* 忽略 */
      }
      flushStderrPartial();
      state = 'closed';
      closeResult = {
        code: exitInfo ? exitInfo.code : null,
        signal: exitInfo ? exitInfo.signal : null,
        forced: forced,
      };
      return closeResult;
    })();
    return closePromise;
  }

  // ── spawn（坑⑧⑨）─────────────────────────────────────────────────────
  const childEnv = {};
  for (const k of Object.keys(process.env)) childEnv[k] = process.env[k];
  // ⑧ 宿主 Electron 会设这两个；传给子进程会让它以"Node 模式/带调试参数"跑，行为变形。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  // 调用方显式覆盖放最后：门禁要用 FAKE_MCP_CANCEL_LOG 之类的注入点。
  if (o.env && typeof o.env === 'object') {
    for (const k of Object.keys(o.env)) childEnv[k] = o.env[k];
  }

  try {
    child = spawn(command, args, {
      cwd: typeof o.cwd === 'string' && o.cwd ? o.cwd : undefined,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    state = 'running';
  } catch (e) {
    // spawn 同步抛（少见，一般是参数非法）也要收敛成明确错误。
    spawnError = toReadableSpawnError(e, command);
    state = 'failed';
    child = null;
  }

  if (child) {
    if (child.stdout) child.stdout.on('data', handleStdoutChunk);
    if (child.stderr) child.stderr.on('data', handleStderrChunk);
    // stdin 的 EPIPE 必须吞掉：否则关子进程的过程中进程级 uncaught 会把主进程带走。
    if (child.stdin) child.stdin.on('error', () => { /* 子进程已退出时的 EPIPE，故意忽略 */ });

    child.on('error', (err) => {
      // ⑨ spawn 失败（ENOENT / EPERM ...）走这里。
      spawnError = toReadableSpawnError(err, command);
      state = 'failed';
      rejectAllPending((entry) => makeUnavailableError(entry));
      emitSafe('spawnError', spawnError);
    });

    child.on('exit', (code, signal) => {
      exited = true;
      exitInfo = { code: code === undefined ? null : code, signal: signal || null };
      flushStderrPartial();
      if (state !== 'closing') state = 'closed';
      // ⑤ 所有还在等的请求立刻以明确错误了结（带 exit code + stderr 尾部）。
      rejectAllPending((entry) => makeUnavailableError(entry));
      emitSafe('exit', {
        code: exitInfo.code,
        signal: exitInfo.signal,
        stderrTail: stderrTail(20),
      });
    });
  }

  // ── 对外 API ─────────────────────────────────────────────────────────
  const api = {
    initialize: initialize,
    listTools: listTools,
    callTool: callTool,
    ping: ping,
    close: close,
    notify: notify,
    cancelRequest: cancelRequest,

    /** @param {string} ev @param {Function} fn @returns {object} this */
    on(ev, fn) {
      emitter.on(ev, fn);
      return api;
    },
    /** @param {string} ev @param {Function} fn @returns {object} this */
    once(ev, fn) {
      emitter.once(ev, fn);
      return api;
    },
    /** @param {string} ev @param {Function} fn @returns {object} this */
    off(ev, fn) {
      emitter.removeListener(ev, fn);
      return api;
    },

    /** @returns {number|null} 子进程 pid（关掉之后仍是最后一次的 pid，便于确认没孤儿） */
    get pid() {
      return child ? child.pid : null;
    },
    /** @returns {string} starting | running | closing | closed | failed */
    get state() {
      return state;
    },
    /** @returns {boolean} */
    isClosed() {
      return state === 'closed' || state === 'failed';
    },
    /** @returns {object|null} 握手协商结果 */
    get negotiated() {
      return negotiated;
    },
    /** @returns {object|null} */
    get serverInfo() {
      return negotiated ? negotiated.serverInfo : null;
    },
    /** @returns {string|null} */
    get negotiatedProtocolVersion() {
      return negotiated ? negotiated.protocolVersion : null;
    },
    /** @returns {{code:number|null, signal:string|null}|null} */
    get exitInfo() {
      return exitInfo;
    },
    /** @returns {Error|null} */
    get spawnError() {
      return spawnError;
    },
    /** @returns {number} */
    get pendingCount() {
      return pending.size;
    },

    /**
     * 最近 n 行 stderr。
     *
     * @param {number=} n
     * @returns {string[]}
     */
    stderrTail(n) {
      return stderrTail(n);
    },
    /**
     * stderr 读数：环形缓冲当前行数 + 累计收到行数（累计远超 200 才说明真的洪泛过）。
     *
     * @returns {{buffered:number, total:number, capacity:number}}
     */
    stderrStats() {
      return { buffered: stderrRing.length, total: stderrTotalLines, capacity: stderrTailLines };
    },
    /** @returns {string[]} 被跳过的非 JSON 行（最多 50 条） */
    nonJsonLines() {
      return nonJsonLines.slice();
    },
  };

  if (spawnError) {
    // spawn 同步失败：异步派发，让调用方有机会先挂上监听。
    setImmediate(() => emitSafe('spawnError', spawnError));
  }

  return api;
}

module.exports = {
  findConcatExecutable,
  createMcpStdioClient,
  DEFAULT_PROTOCOL_VERSION,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_STDERR_TAIL_LINES,
  CLIENT_NAME,
};
