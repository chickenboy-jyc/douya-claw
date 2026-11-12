/**
 * 跨请求失败账本 · 通用任务那一半（repeatLedger）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件为什么存在（老板原话）
 * ═══════════════════════════════════════════════════════════════════════════
 *   「让他修复或者重做，他会犯一模一样的错误。」
 *
 * 【查证结论：不是模型不听话，是它第二次根本不知道第一次为什么错】
 *   仓里本来就有「跨请求失败账本」这套机制，全链路已建好且各有门禁：
 *     `toolProtocol.createRetryLedger().seed()`   ← 预热入口（纪律②：count-1，只宽容一次）
 *     `backend.js` 的 `recover-ledger` IIFE        ← 唯一的预热调用点
 *     `handoffBrief.buildHandoffFromSeeded()`      ← 把预热进来的账念给接手的人
 *     `recoveryExecutor` / `planRecoveryGate()`    ← 真正**拦下**「同一个办法再试一次」
 *   但这套东西的数据源只有一个：`wfCtl.attempts()`。
 *   而 `wfCtl`（workflow 生命周期控制器）只在**命中工作流**时才存在
 *   —— `startWorkflowRun()` 对非 PPT 任务返回 null（backend.js:5381/5403）。
 *
 *   ⇒ 于是：修 bug、改界面、重做一版这类**通用任务**，第二运行时
 *     `arr = []` ⇒ `seeded = 0` ⇒ 交接单不出（`reason: 'no-prev'`）
 *     ⇒ 预热 0 条 ⇒ `recoveryExecutor` 眼里这是"第一次用这个办法" ⇒ 放行
 *     ⇒ 模型照着上次的坑原样再踩一遍，而**三道执法闸都觉得一切正常**。
 *   这就是「重做还犯一模一样的错」的物理原因 —— 不是没机制，是机制没接上数据源。
 *
 * 【本模块只做一件事：把数据源补齐】
 *   不新造判据、不新造文案、不新造执法层。产出就是 `seed()` 认识的 `attempts` 数组，
 *   喂进去以后 `planRecoveryGate` / `handoffBrief` / `recoveryExecutor` 全部原样生效。
 *   这是本仓纪律：「优先复用而非自研」「判定只有一处」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条硬约束（写之前先定死，免得事后拿"条件不满足"当借口）
 * ═══════════════════════════════════════════════════════════════════════════
 *  ① **没有稳定会话身份就不落盘。**
 *     账本按 `owner + thread` 分文件。拿不到 threadId 也拿不到 projectId ⇒ 返回 null（内存不落盘），
 *     并在 trace 里说明原因。理由：把 A 项目的失败记到 B 项目头上，比不记更坏
 *     —— 它会拦住一个本来没问题的办法，用户看到的是"莫名其妙不让用"。
 *     宁可少记，不许记错。
 *
 *  ② **绝不抛异常、绝不阻塞。**
 *     本模块全程旁路：读坏了 = 没有上次的账；写坏了 = 这次不留痕。两者都不许影响任务本身。
 *     （与 `[recover]` / `[handoff]` 那两段的纪律逐字一致。）
 *
 *  ③ **`sig` 必须与 `wfCtl` 同一口径**（`rec.strategy` = 工具 + 参数键 + 执行模式，不含参数值）。
 *     否则预热进 `byStrategy` 的桶键和 `fail()` 写的桶键对不上 ⇒ 账记了但永远拦不住，
 *     是"看起来接了、其实空转"的典型形态。
 *
 * @module repeatLedger
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 单个会话账本最多留多少条。超了按 `at` 丢最旧的。 */
const MAX_ENTRIES = 80;
/** 失败原文/处方的截断长度（与 workflowState.noteAttempt 同量级）。 */
const ERR_MAX = 300;
const NEXT_MAX = 200;
/** 账本格式版本。不认得的版本一律当空账（不猜、不迁移）。 */
const FORMAT_VERSION = 1;

/**
 * 规范化策略签名。
 * 只 trim：**不做任何其它改写** —— 这个字符串要拿去当 `byStrategy` 的键，
 * 在写入端和读取端改一个字，账就永远对不上（见约束③）。
 * @param {unknown} s
 * @returns {string}
 */
function normSig(s) {
  return typeof s === 'string' ? s.trim() : '';
}

/**
 * 把一条失败并进账本（**纯函数**，返回新数组，不改入参）。
 *
 * 合并规则：同 `sig` 累计次数（`count + 1`），其余字段取最新。
 * 为什么是**累计**而不是"每次运行从 0 开始"：
 *   `seed()` 的纪律②会把 count 减 1 再落账（"环境可能已经变了，宽容一次"）。
 *   如果每次运行都从 0 重数，那么跨三次运行各失败一次 ⇒ 每次存进去都是 1
 *   ⇒ 减 1 后为 0 ⇒ `skipped` ⇒ **一条都预热不进来**，机制静默空转。
 *   只有真正累计，"这条办法已经反复不行"才是一个能跨运行成立的判断。
 *
 * @param {Array<object>} list 现有账本
 * @param {{sig:string, tool:string, kind:string, lastError?:string, nextAction?:string, at?:number}} item
 * @returns {Array<object>} 新账本
 */
function mergeAttempt(list, item) {
  const src = Array.isArray(list) ? list : [];
  const it = item && typeof item === 'object' ? item : {};
  const sig = normSig(it.sig);
  // 拿不出 sig 的条目一律不收：`seed()` 纪律③也是这么丢的，收了也只会变成 skipped。
  if (!sig) return src.slice();

  const at = Number(it.at) > 0 ? Number(it.at) : Date.now();
  const out = [];
  let hit = false;
  for (const e of src) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (normSig(e.sig) !== sig) { out.push(e); continue; }
    hit = true;
    out.push({
      sig,
      tool: String(it.tool || e.tool || ''),
      count: Math.max(0, Math.floor(Number(e.count) || 0)) + 1,
      // 类别取**最新**这次：老类别只说明"上次怎么坏的"，这次坏在哪才是要照着改的东西。
      lastKind: String(it.kind || e.lastKind || ''),
      lastError: String(it.lastError || e.lastError || '').replace(/\s+/g, ' ').trim().slice(0, ERR_MAX),
      nextAction: String(it.nextAction || e.nextAction || '').trim().slice(0, NEXT_MAX),
      at,
      // 首次出现时间留着：事后看「是从哪一轮开始反复的」需要它，而 `at` 只记最后一次。
      firstAt: Number(e.firstAt) > 0 ? Number(e.firstAt) : at,
    });
  }
  if (!hit) {
    out.push({
      sig,
      tool: String(it.tool || ''),
      count: 1,
      lastKind: String(it.kind || ''),
      lastError: String(it.lastError || '').replace(/\s+/g, ' ').trim().slice(0, ERR_MAX),
      nextAction: String(it.nextAction || '').trim().slice(0, NEXT_MAX),
      at,
      firstAt: at,
    });
  }
  return pruneAttempts(out, MAX_ENTRIES);
}

/**
 * 剪枝（**纯函数**）：超上限时按 `at` 丢最旧的。
 * 为什么按 `at` 而不是数组顺序：数组顺序取决于"哪次先被 merge"，
 * 而 `at` 是事实。任务可能并发（主执行 + 替补），顺序不可靠。
 * @param {Array<object>} list
 * @param {number} max
 * @returns {Array<object>}
 */
function pruneAttempts(list, max) {
  const arr = (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object' && normSig(e.sig));
  const cap = Number(max) > 0 ? Math.floor(Number(max)) : MAX_ENTRIES;
  if (arr.length <= cap) return arr;
  const sorted = arr.slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  return sorted.slice(sorted.length - cap);
}

/**
 * 投影成 `toolLedger.seed()` 认识的形状（**纯函数**）。
 *
 * 只投影 `seed()` 真的会读的字段，多余字段一律不带：
 *   `seed()` 会读 `refuted` / `refutedAt` / `refutedScope` / `refutedCodeVersion` 走
 *   `refuteScope.projectRefute` 的三态判定。**本模块刻意不产出这些字段** ——
 *   "这条办法已证伪"是一个需要证据（原文 + 适用范围 + 代码版本）的结论，
 *   本模块手里只有"失败了几次、错在哪"，够不上那个门槛。
 *   硬塞一个 `refuted: true` 就是伪造证据，会让 `handoffBrief` 把它写成"不要再用"
 *   而实际上从没验证过。
 *   ⇒ 本模块只贡献**次数与原因**，是否上升到"禁令"由原有判据（`refuteDecision`）决定。
 *
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
function toSeedAttempts(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const sig = normSig(e.sig);
    if (!sig) continue;
    out.push({
      sig,
      tool: String(e.tool || ''),
      count: Math.max(0, Math.floor(Number(e.count) || 0)),
      lastKind: String(e.lastKind || ''),
      lastError: String(e.lastError || '').slice(0, ERR_MAX),
      nextAction: String(e.nextAction || '').slice(0, NEXT_MAX),
      at: Number(e.at) || 0,
    });
  }
  return out;
}

/**
 * 给 trace 用的读数（**纯函数**）。
 * `repeated` = count >= 2 的条数 —— 这才是「反复撞同一面墙」的直接读数，
 * `total` 会把"每个办法各错一次"也算进去，两个数不能互相冒充。
 * @param {Array<object>} list
 * @returns {{total:number, repeated:number, tools:string[]}}
 */
function summarizeAttempts(list) {
  const arr = Array.isArray(list) ? list : [];
  let repeated = 0;
  const tools = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    if ((Number(e.count) || 0) >= 2) repeated += 1;
    const t = String(e.tool || '');
    if (t && tools.indexOf(t) < 0) tools.push(t);
  }
  return { total: arr.length, repeated, tools: tools.slice(0, 10) };
}

/**
 * 会话键 -> 安全文件名。
 * 用 djb2 哈希而不是把原文塞进文件名：threadId / owner 可能含中文、斜杠、超长，
 * 直接拼接在 Windows 上会静默失败（`CreateFile` 拒绝非法字符），
 * 而失败形态是"账本文件根本没建" —— 和"这次没失败过"长得一模一样，事后查不出来。
 * @param {string} key
 * @returns {string} 形如 `t_1a2b3c4d`
 */
function fileNameOf(key) {
  const s = String(key || '');
  if (!s) return '';
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return 't_' + h.toString(16).padStart(8, '0');
}

/**
 * 解析账本文件内容（**纯函数**，不读盘）。
 * 任何畸形输入一律返回空数组：账本是增益，读坏了就当没有上次的账。
 * @param {string} raw 文件原文
 * @returns {Array<object>}
 */
function parseAttempts(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  let doc = null;
  try { doc = JSON.parse(s); } catch { return []; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  if (Number(doc.v) !== FORMAT_VERSION) return [];
  return pruneAttempts(doc.attempts, MAX_ENTRIES);
}

/**
 * 序列化（**纯函数**）。
 * @param {Array<object>} list
 * @returns {string}
 */
function serializeAttempts(list) {
  return JSON.stringify({
    v: FORMAT_VERSION,
    updatedAt: Date.now(),
    attempts: toSeedAttempts(list),
  }, null, 2);
}

/**
 * 造一个会话级账本。
 *
 * @param {object} o
 * @param {string} o.dir           账本目录（通常是 tasks.json 同级的 `repeat-attempts/`）
 * @param {string} [o.key]         `owner::thread` 形式的会话键。**空串 = 不落盘**（见约束①）。
 * @param {string} [o.reason]      `key` 为空时的原因，只用于让调用方写 trace，不参与判定。
 * @param {object} [o.fsLike]      注入 fs（单测用；生产不传）
 * @param {() => number} [o.now]   注入时钟（单测用）
 * @returns {{available:boolean, why:string, attempts:Function, remember:Function, path:Function, summary:Function}}
 */
function createRepeatLedger(o) {
  const opt = o && typeof o === 'object' ? o : {};
  const io = opt.fsLike && typeof opt.fsLike === 'object' ? opt.fsLike : fs;
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();
  const dir = String(opt.dir || '');
  const key = String(opt.key || '').trim();
  const name = fileNameOf(key);
  // 约束①：拿不到稳定身份 ⇒ 明说不可用，不落盘。
  const available = !!(dir && name);
  const filePath = available ? path.join(dir, name + '.json') : '';
  let cache = null;

  const ensureLoaded = () => {
    if (cache) return cache;
    cache = [];
    if (!available) return cache;
    try {
      if (!io.existsSync(filePath)) return cache;
      cache = parseAttempts(io.readFileSync(filePath, 'utf8'));
    } catch { cache = []; }
    return cache;
  };

  return {
    available,
    why: available ? '' : String(opt.reason || 'no-session-identity'),
    /** 当前账本（已剪枝）。调用方拿去 `seed()`。 */
    attempts() {
      try { return toSeedAttempts(ensureLoaded()); } catch { return []; }
    },
    /**
     * 记一条失败。**同步落盘**：崩溃是常态（用户点停止 / 关窗 / 进程被杀），
     * 攒着批量写等于「最需要它的那次刚好没写下去」。
     */
    remember(item) {
      if (!available) return { ok: false, why: 'unavailable' };
      try {
        const it = Object.assign({}, item || {});
        if (!(Number(it.at) > 0)) it.at = now();
        cache = mergeAttempt(ensureLoaded(), it);
        try { io.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
        // 先写临时文件再 rename：断电/被杀在写一半时，旧账本仍然完整可读。
        // 直接 writeFileSync 到目标路径会留下一个**合法 JSON 的空账**（截断在括号前），
        // 读的时候不会报错，只会静默变成"上次没失败过" —— 静默丢证据是最坏的一种。
        const tmp = filePath + '.tmp';
        io.writeFileSync(tmp, serializeAttempts(cache), 'utf8');
        io.renameSync(tmp, filePath);
        return { ok: true, total: cache.length };
      } catch (e) {
        return { ok: false, why: String((e && e.message) || 'write-failed') };
      }
    },
    /** 账本文件绝对路径（空串 = 不落盘）。供 trace / 门禁断言真落了盘。 */
    path() { return filePath; },
    /** 读数（供 trace）：真的有几个办法在反复撞墙。 */
    summary() { try { return summarizeAttempts(ensureLoaded()); } catch { return { total: 0, repeated: 0, tools: [] }; } },
  };
}

/**
 * 从运行入参里定会话键。
 *
 * 优先级：`threadId` > `projectId`。两者都没有 ⇒ 空串（不落盘）。
 * 为什么**不用** taskId：taskId 每个任务都是新的（`genId('task')`），
 *   用它当键等于"每个任务一本独立账" ⇒ 永远读不到上一次 —— 与不去接数据源是同一个结果。
 * 为什么要带 owner：同一台机器上可能有多个账号，甲撞过的墙不该拦住乙。
 *
 * @param {{threadId?:string, projectId?:string}} payload
 * @param {string} ownerKey
 * @returns {{key:string, reason:string}}
 */
function sessionKeyOf(payload, ownerKey) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const owner = String(ownerKey || '').trim();
  const thread = String(p.threadId || '').trim();
  const project = String(p.projectId || '').trim();
  const scope = thread || project;
  if (!scope) return { key: '', reason: 'no-thread-and-no-project' };
  return { key: owner + '::' + scope, reason: '' };
}

/**
 * 账本目录：与 `tasks.json` 同级（跟着 dataDir 走，纯 node 单测下为 null）。
 * @param {string} tasksFilePath
 * @returns {string}
 */
function dirOf(tasksFilePath) {
  const p = String(tasksFilePath || '');
  if (!p) return '';
  try { return path.join(path.dirname(p), 'repeat-attempts'); } catch { return ''; }
}

module.exports = {
  MAX_ENTRIES,
  FORMAT_VERSION,
  mergeAttempt,
  pruneAttempts,
  toSeedAttempts,
  summarizeAttempts,
  fileNameOf,
  parseAttempts,
  serializeAttempts,
  createRepeatLedger,
  sessionKeyOf,
  dirOf,
};
