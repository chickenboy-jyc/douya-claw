/**
 * workflowState —— 工作流**跨请求状态**的唯一 fs 写者（pptx-v1）。
 *
 * 老板的原话：「纯函数能够正确计算恢复方案，不等于 Agent 已经具备真正的跨请求恢复能力。」
 * 所以恢复能力 = ① 状态真的落到磁盘上（本文件） + ② 恢复判据是纯函数（workflowRunner.planRecovery）
 *             + ③ 磁盘证据真的被读出来喂给判据（本文件的 collectEvidence）。
 *
 * 四条边界（越界就会把整个系统弄脏，都是有代价换来的结论）：
 *   1. **一任务一文件**：`<dataDir>/workflows/<safeTaskId>.json`。与 taskTrace 的「按 taskId 切分」
 *      同构 ⇒ 天然没有第二个写者，绝不出现两方抢 `tasks.json`（那个是整份覆盖写）。
 *   2. **只承载完成度**：stage / completedStages / waivedStages / openIssues / verdict。
 *      恢复**永远不写** `tasks.json`、不写 `task_end` —— 终态仍由 backend 的 finalizeTask 单独派生。
 *   3. **原子写复用 memoryStore.atomicWrite**：`<file>.tmp<pid>` → `renameSync`。
 *      不新写第二份原子写实现（memoryStore 里那段注释已经把"为什么不能直接 writeFileSync"写清了）。
 *   4. **写盘前比对 lease.epoch**：不符就返回 `{ok:false, reason:'lease_lost'}` 并降级为 observer。
 *      这不是为了优雅，是因为两个执行者各干了一份 PPT 时用户会看到两张成果卡。
 *
 * 降级纪律（全部"降级不丢"）：
 *   · 文件不存在      ⇒ 全新 run（与今天的行为逐字一致，零迁移）；
 *   · JSON 解析失败    ⇒ 原文件改名 `<file>.corrupt-<ts>`（**留证据、不删不覆盖**）→ 全新 run；
 *   · 字段类型不对    ⇒ **字段级** coerce 成安全值，原值进 `quarantine`，其余字段照用（绝不整份丢弃）；
 *   · 不认识的阶段名  ⇒ 该条移出并进 `quarantine`（一个错别字不该毁掉整次运行）；
 *   · 认不出的键      ⇒ 原样进 `_unknown`（防"读不懂就丢"）；
 *   · schemaVersion>2 ⇒ 只读、不回写（覆盖更新版本写的文件 = 数据丢失）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const memoryStore = require('./memoryStore');
const workflowRunner = require('./workflowRunner');
const toolProtocol = require('./toolProtocol');
/**
 * ★ 2026-02-16：`refuted` 的**三态判定**（证据 / 适用范围 / 代码版本）放在这里，
 *   因为它是 `workflowState`（写账本的人）与 `toolProtocol`（读账本预热的人）**共用**的同一条规则。
 *   两处各写一份 = 迟早分成两套判据（本仓已经有太多次这种事故）。
 *   它只 require fs/path/crypto ⇒ 与 workflowState / toolProtocol 无环。
 *
 * ★ 为什么用 `require(path.join(__dirname, 'refuteScope'))` 而不是裸相对路径：
 *   本仓门禁会在**内存/沙箱**里装载本文件跑变异副本（`new Function` 装载器、`loadMutatedModule` 沙箱）。
 *   裸相对 require 会按**装载方**的路径解析 ⇒ MODULE_NOT_FOUND。按本文件目录解析在正常路径与
 *   `new Function` 装载器下都成立（它们都正确传入了本文件的真实 `__dirname`）。
 *   （把本文件拷到临时目录的沙箱另需一份转发桩，见 `unit-wf-resume-wiring.mjs`。）
 */
const refuteScope = require(path.join(__dirname, 'refuteScope'));

/** 状态文件自己的 schema 版本。★ 与 `pptx-v1.version`（验收标准版本）**不是一回事**，别混用。 */
const SCHEMA_VERSION = 2;
/** 硬上限：超过就按 recoverLog → quarantine → openIssues 丢最旧条目，**永不丢阶段字段** */
const MAX_BYTES = 64 * 1024;
/** 租约 TTL：只在"写时刷新 + epoch fencing"，不挂心跳定时器 */
const LEASE_TTL_MS = 30 * 60 * 1000;
/** 状态保留天数（比 trace 的 7 天长：用户可能隔周回来接着做） */
const KEEP_DAYS = 30;
const MAX_RECOVER_LOG = 10;
const MAX_QUARANTINE = 20;
const MAX_REQUESTS = 5;
const MAX_ARTIFACTS = 20;
const MAX_ATTACHMENTS = 50;
/**
 * 失败方法账本上限。★ 超限时丢的是**最旧的**，不是**最频繁的** ——
 * 丢最旧的是"遗忘"，丢最频繁的是"消除证据"（后者等于把最该记住的坑删掉）。
 */
const MAX_ATTEMPTS = 20;
/**
 * `refutedEvidence.errorText` 的保存上限。
 * ★ 截断的是**多余的字节**，不是"证伪这件事"：留下能让下一个人复核的那段原文就够了。
 */
const REFUTED_ERROR_MAX = 2000;
/**
 * `refutedStale` 事件上限。与 `recoverLog` 同口径：只留最近的 N 条。
 * ★ 一条事件 = 一次"旧禁令被降级"，它是审计线索，不是流水账，所以不需要无限留。
 */
const MAX_REFUTE_EVENTS = 20;
/**
 * 目标契约对照结论（`workflowRunner.diffContract` 的落盘形态）每个桶最多留几条。
 *
 * ★ 2026-02-16：为什么必须进 schema，而不是"想起来再写一笔"：
 *   结论是**跨请求可读**才有意义。第一版只做了 `state.run = {...state.run, ...contractView}` +
 *   `store.save`，看着"落盘了"，实际序列化时被这份字段白名单丢掉了 —
 *   于是下一次请求读不到任何偏差，等于"只有本次会话里有效"（正是本项要修的病）。
 *   这是被 `unit-contract-diff` 的 H-7/H-8 抓到的（真读状态文件，不信内存）。
 */
const MAX_CONTRACT_ITEMS = 20;
const STATUSES = ['in_progress', 'completed', 'stopped'];

const HOST = (() => {
  try { return os.hostname() || 'unknown'; } catch { return 'unknown'; }
})();
/** 本进程的身份（跨进程的唯一性由 host+pid 提供，进程内复用同一身份） */
const PROC_OWNER = HOST + ':' + process.pid;

let root = '';
let enabled = false;
let fsOverride = null;
/** 本进程已持有租约的 taskId → {epoch, owner, expiresAt}（同进程重复进入的挡板） */
const HELD = new Map();
/** taskId → store（供模块级 save/release 使用） */
const STORES = new Map();
let stats = { opens: 0, writes: 0, corrupts: 0, leaseLost: 0, prunes: 0, observers: 0 };
/**
 * 时钟（可注入）。★ 必须只有这一处时间源：租约的 expiresAt 与 save 时的比对如果一边用注入时间、
 * 一边用 Date.now()，租约会永远"已过期"（门禁里注入 now 时就会踩到），这类 bug 极难看出。
 */
let clock = () => Date.now();

function fsx() { return fsOverride || fs; }
function nowMs(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : clock(); }
function sha1(s) { return crypto.createHash('sha1').update(String(s || '')).digest('hex'); }

/** 文件名净化：与 taskTrace.fileOf 同规则（只留字母数字下划线连字符） */
function safeName(taskId) {
  const safe = String(taskId === undefined || taskId === null ? 'unknown' : taskId)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80);
  return safe || 'unknown';
}

// ───────────────────────────────────────────────────────────────────────────
// 一、生命周期
// ───────────────────────────────────────────────────────────────────────────

/**
 * 初始化。只在 startBackend 调；未调 ⇒ enabled=false，所有方法 no-op（不抛、不写盘）。
 * @param {{dataDir:string}} opts
 * @returns {{ok:boolean, dir?:string, reason?:string}}
 */
function init(opts) {
  const dataDir = String((opts && opts.dataDir) || '').trim();
  if (!dataDir) {
    enabled = false;
    root = '';
    return { ok: false, reason: 'no_data_dir' };
  }
  const dir = path.join(dataDir, 'workflows');
  try {
    fsx().mkdirSync(dir, { recursive: true });
  } catch (e) {
    enabled = false;
    return { ok: false, reason: 'mkdir_failed: ' + String((e && e.message) || e) };
  }
  root = dir;
  enabled = true;
  // 无人回来的任务由 mtime prune 收尾（手法照抄 taskTrace.pruneOld）
  try { prune({ keepDays: KEEP_DAYS }); } catch { /* 清理不是关键路径 */ }
  return { ok: true, dir };
}

function isEnabled() { return enabled && !!root; }

/** 状态文件路径（一任务一文件） */
function pathOf(taskId) {
  if (!isEnabled()) return '';
  return path.join(root, safeName(taskId) + '.json');
}

/** 供门禁：把根目录指到临时目录（会清空本进程租约表） */
function __setRoot(p) {
  const dir = String(p || '');
  root = dir;
  enabled = !!dir;
  HELD.clear();
  STORES.clear();
  if (dir) {
    try { fsx().mkdirSync(dir, { recursive: true }); } catch { /* 门禁自己会断言失败 */ }
  }
  return root;
}

/** 供门禁：恢复出厂设置（含注入的 fs 模块） */
function __reset() {
  root = '';
  enabled = false;
  fsOverride = null;
  clock = () => Date.now();
  HELD.clear();
  STORES.clear();
  stats = { opens: 0, writes: 0, corrupts: 0, leaseLost: 0, prunes: 0, observers: 0 };
  return true;
}

/** 供门禁：注入时钟（与租约 TTL 必须共用同一个时间源） */
function __setClock(fn) { clock = (typeof fn === 'function') ? fn : (() => Date.now()); return true; }

/** 供门禁：注入 fs（只影响本模块自己做的事，atomicWrite 仍走真实 fs） */
function __setFs(m) { fsOverride = m || null; return !!fsOverride; }

/** 供门禁/诊断：计数器快照 */
function __stats() { return { ...stats, held: HELD.size, stores: STORES.size }; }

/** 供门禁：字段级 coerce 的纯函数入口 */
function __normalize(objIn, opts) { return normalize(objIn, opts); }

// ───────────────────────────────────────────────────────────────────────────
// 二、读 + 迁移（降级不丢）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 读原始文件。
 * @returns {{kind:'missing'}|{kind:'corrupt', file:string, reason:string, bytes:Buffer}|{kind:'ok', file:string, obj:object, bytes:Buffer}}
 */
function readStateRaw(file) {
  const f = fsx();
  if (!file) return { kind: 'missing', file: '' };
  let exists = false;
  try { exists = f.existsSync(file); } catch { exists = false; }
  if (!exists) return { kind: 'missing', file };
  let raw = '';
  try {
    raw = f.readFileSync(file, 'utf8');
  } catch (e) {
    const code = String((e && e.code) || '');
    if (code === 'ENOENT') return { kind: 'missing', file };
    return { kind: 'corrupt', file, reason: 'read_failed: ' + code, bytes: Buffer.alloc(0) };
  }
  if (!raw || !raw.trim()) return { kind: 'corrupt', file, reason: 'empty_file', bytes: Buffer.from(raw || '', 'utf8') };
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { kind: 'corrupt', file, reason: 'json_parse_failed: ' + String((e && e.message) || e), bytes: Buffer.from(raw, 'utf8') };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { kind: 'corrupt', file, reason: 'not_an_object', bytes: Buffer.from(raw, 'utf8') };
  }
  return { kind: 'ok', file, obj, bytes: Buffer.from(raw, 'utf8') };
}

/**
 * 损坏文件改名留证（`<file>.corrupt-<ts>`）：**不删、不覆盖** —— 被删掉的字节没人能抢救。
 * @returns {string} 改名后的路径（改名失败返回 ''）
 */
function quarantineCorruptFile(res) {
  const f = fsx();
  const ts = clock();
  let target = res.file + '.corrupt-' + ts;
  let n = 0;
  try {
    while (f.existsSync(target) && n < 100) { n += 1; target = res.file + '.corrupt-' + ts + '-' + n; }
    f.renameSync(res.file, target);
    stats.corrupts += 1;
    return target;
  } catch {
    return '';
  }
}

/** 把任意值安全地压成可放进 quarantine 的短字符串 */
function safeJson(v) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return String(s === undefined ? '' : s).slice(0, 300);
  } catch { return '[unserializable]'; }
}

// ───────────────────────────────────────────────────────────────────────────
// 二·五、refuted 三字段的字段级规范化 + 判定合并口径
// ───────────────────────────────────────────────────────────────────────────

/**
 * `refutedEvidence`（证据）的字段级规范化：`{ tool, errorText, exitCode, at }`。
 *
 * 它就是「让这次判定成立的那一次真实失败的原文」—— 没有它，`refuted` 只是一个意见。
 * @param {any} v 磁盘上的原值
 * @param {number} [assertedAt] 兜底的判定时刻（证据自带 at 时以它为准）
 * @returns {{tool:string, errorText:string, exitCode:(number|null), at:number}}
 */
function coerceRefutedEvidence(v, assertedAt) {
  const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const rawEc = o.exitCode;
  let exitCode = null;
  if (rawEc !== null && rawEc !== undefined && rawEc !== '') {
    const n = Number(rawEc);
    exitCode = Number.isFinite(n) ? Math.trunc(n) : null;
  }
  const at = Number(o.at) > 0 ? Number(o.at) : (Number(assertedAt) > 0 ? Number(assertedAt) : 0);
  return {
    tool: typeof o.tool === 'string' ? o.tool.slice(0, 60) : '',
    errorText: typeof o.errorText === 'string' ? o.errorText.slice(0, REFUTED_ERROR_MAX) : '',
    exitCode,
    at,
  };
}

/**
 * `refutedScope`（适用范围）的字段级规范化：`{ files: string[], paramKeys: string[] }`。
 *
 * ★ **空数组合法，但必须是数组**（不许 undefined）：空数组会让判定侧判成 `stale`
 *   （"证明不了代码没变"就不许当禁令），这正是我们要的行为；而 undefined 会让"空范围"
 *   与"老记录压根没这个字段"混在一起，事件里就说不清到底缺的是什么。
 * @param {any} v
 * @param {any} [fallbackParamKeys] 缺 paramKeys 时用条目自身的 paramKeys 兜底（同一件事只存一份）
 * @returns {{files:string[], paramKeys:string[]}}
 */
function coerceRefutedScope(v, fallbackParamKeys) {
  const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const files = Array.isArray(o.files)
    ? o.files.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.replace(/\\/g, '/').slice(0, 300)).slice(0, 50)
    : [];
  const paramKeys = Array.isArray(o.paramKeys)
    ? o.paramKeys.filter((x) => typeof x === 'string').slice(0, 40)
    : (Array.isArray(fallbackParamKeys) ? fallbackParamKeys.filter((x) => typeof x === 'string').slice(0, 40) : []);
  return { files, paramKeys };
}

/**
 * `refutedCodeVersion`（代码版本）的字段级规范化：`{ [相对路径]: sha1 }`。
 *
 * 只收 40 位十六进制 —— 其它形状留着会让比对**永远不等**（于是恒 stale），
 * 那是"看起来记了版本、其实一直无效"，比不记更糟。
 * @param {any} v
 * @returns {Object<string,string>} 合法的版本表（可能是空对象 = 拿不出证据 ⇒ 判定侧 stale）
 */
function coerceRefutedCodeVersion(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, h] of Object.entries(v)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (typeof h !== 'string' || !/^[0-9a-fA-F]{40}$/.test(h)) continue;
    out[k.replace(/\\/g, '/').slice(0, 300)] = h.toLowerCase();
  }
  return out;
}

/**
 * 把一条记录里的 `refuted` 判定**整体**抽出来（布尔 + 三字段）。
 *
 * 🔴 纪律：判定是**一个整体**，绝不允许"evidence 来自 A、version 来自 B"的拼装 ——
 *   那等于伪造证据（说"这个版本被判过证伪"，其实那个版本从没被验过）。
 * @param {object} src
 * @param {number} [assertedAt] 断言时刻的兜底值
 */
function verdictFields(src, assertedAt) {
  const s = (src && typeof src === 'object') ? src : {};
  const refuted = s.refuted === true;
  const refutedAt = Number(s.refutedAt) > 0 ? Number(s.refutedAt)
    : (Number(assertedAt) > 0 ? Number(assertedAt) : 0);
  if (!refuted) {
    // 非 refuted ⇒ 三字段**一并清空**："证伪已解除"时留着旧证据 = 留着一条读不懂的账
    return { refuted: false, refutedAt, refutedEvidence: null, refutedScope: null, refutedCodeVersion: null };
  }
  return {
    refuted: true,
    refutedAt,
    refutedEvidence: coerceRefutedEvidence(s.refutedEvidence, refutedAt),
    refutedScope: coerceRefutedScope(s.refutedScope, s.paramKeys),
    refutedCodeVersion: coerceRefutedCodeVersion(s.refutedCodeVersion),
  };
}

/**
 * 同一 sig 两条账合并时，refuted 判定取哪一条：**判定时刻（refutedAt，缺则 at）大者胜**。
 * @param {object} a
 * @param {object} b
 * @returns {object} 胜出的那一条（原对象，不拷贝）
 */
function pickVerdict(a, b) {
  const atOf = (e) => (Number(e && e.refutedAt) > 0 ? Number(e.refutedAt) : (Number(e && e.at) || 0));
  return atOf(b) >= atOf(a) ? b : a;
}

/**
 * 失败方法账本（`attempts`）的字段级规范化。
 *
 * 每条形如
 * `{ sig, tool?, paramKeys?, mode?, count, lastKind?, refuted?, refutedAt?,
 *    refutedEvidence?, refutedScope?, refutedCodeVersion?, nextAction?, lastError?, at? }`
 * —— 老板要的「已经证伪的假设 / 试过的方法 / 失败原因 / 有效证据 / 为什么换下一条路线」，
 * 逐项就落在这几个字段上（sig=方法身份，lastError=失败原因，refuted=已证伪，nextAction=为什么换路）。
 *
 * ★ 2026-02-16 新增三字段（老板原话：「`refuted` 要记证据、适用范围/代码版本」）：
 *   · `refutedEvidence`     证据：让这次判定成立的那一次真实失败的原文（截断到 2000 字符）；
 *   · `refutedScope`        适用范围：`{ files[], paramKeys[] }`（**空数组合法，但必须是数组**）；
 *   · `refutedCodeVersion`  代码版本：`{ [相对路径]: sha1 }`。
 *   三者只在 `refuted === true` 时存在；`refuted` 被解除时必须一起清空（见 `clearRefuted`）。
 *
 * 三条纪律：
 *   ① **字段级降级**：坏一条只丢一条（其余条目照用），绝不整份丢弃；
 *   ② `sig` 缺失 ⇒ 这一条**算不出 key**，恢复不了 ⇒ 丢（宁可少恢复，不许恢复出一条查不到的账）；
 *   ③ 超上限按 `at` 丢**最旧的** ⇒ 保留的是经验，不是流水账。
 *
 * @param {any} v 磁盘上的原值
 * @param {(field:string, value:any, why:string)=>void} q quarantine 回调
 * @param {string} [fieldName]
 * @returns {Array<object>} 规范化后的条目（`at` 升序，最多 MAX_ATTEMPTS 条）
 */
function normalizeAttempts(v, q, fieldName) {
  const field = fieldName || 'attempts';
  const put0 = typeof q === 'function' ? q : () => {};
  if (v === undefined || v === null) return [];   // 旧文件没有这个字段 ⇒ []（零迁移、不报案）
  if (!Array.isArray(v)) {
    put0(field, v, '类型不对（期望 object[]）⇒ coerce 成 []');
    return [];
  }
  const out = [];
  v.forEach((a, i) => {
    const at0 = field + '[' + i + ']';
    if (!a || typeof a !== 'object' || Array.isArray(a)) { put0(at0, a, '不是对象 ⇒ 丢弃该条'); return; }
    const sig = (typeof a.sig === 'string') ? a.sig.trim() : '';
    if (!sig) { put0(at0, a, '缺 sig（算不出策略 key，无法恢复）⇒ 丢弃该条'); return; }
    let count = Math.floor(Number(a.count));
    if (!Number.isFinite(count) || count < 0) {
      put0(at0 + '.count', a.count, 'count 不是非负数字 ⇒ 记 0（seed 会跳过这一条）');
      count = 0;
    }
    const at = Number(a.at);
    const verdict = verdictFields(a, at);
    out.push({
      sig,
      tool: typeof a.tool === 'string' ? a.tool.slice(0, 60) : '',
      paramKeys: Array.isArray(a.paramKeys) ? a.paramKeys.filter((k) => typeof k === 'string').slice(0, 40) : [],
      mode: typeof a.mode === 'string' ? a.mode.slice(0, 30) : '',
      count,
      lastKind: (typeof a.lastKind === 'string' && a.lastKind) ? a.lastKind.slice(0, 40) : 'unknown',
      refuted: verdict.refuted,
      refutedAt: verdict.refutedAt,
      // 三字段只在 refuted 为 true 时带上：解除证伪时"清空"才是诚实形状（见 verdictFields）
      ...(verdict.refuted ? {
        refutedEvidence: verdict.refutedEvidence,
        refutedScope: verdict.refutedScope,
        refutedCodeVersion: verdict.refutedCodeVersion,
      } : {}),
      nextAction: typeof a.nextAction === 'string' ? a.nextAction.slice(0, 200) : '',
      lastError: typeof a.lastError === 'string' ? a.lastError.slice(0, 300) : '',
      at: (Number.isFinite(at) && at > 0) ? at : 0,
    });
  });
  // 同一 sig 出现多条 ⇒ 合并（取最大 count、最新的证据），不许因为重复就把账算丢
  const bys = new Map();
  for (const a of out) {
    const prev = bys.get(a.sig);
    if (!prev) { bys.set(a.sig, a); continue; }
    const newer = a.at >= prev.at;
    // ★ refuted 判定整体取"判定时刻更晚"的那一条（不许把两条的字段拼起来 —— 那是伪造证据）
    const winner = verdictFields(pickVerdict(prev, a), 0);
    const merged = {
      ...prev,
      count: Math.max(prev.count, a.count),
      lastKind: newer ? a.lastKind : prev.lastKind,
      lastError: a.lastError || prev.lastError,
      nextAction: a.nextAction || prev.nextAction,
      refuted: winner.refuted,
      refutedAt: winner.refutedAt,
      at: Math.max(prev.at, a.at),
    };
    if (winner.refuted) {
      merged.refutedEvidence = winner.refutedEvidence;
      merged.refutedScope = winner.refutedScope;
      merged.refutedCodeVersion = winner.refutedCodeVersion;
    } else {
      delete merged.refutedEvidence;
      delete merged.refutedScope;
      delete merged.refutedCodeVersion;
    }
    bys.set(a.sig, merged);
  }
  // `at` 升序（最旧在前）：上限裁剪与 clipState 都统一按「shift() = 丢最旧的」处理，口径只此一处。
  return [...bys.values()].sort((x, y) => x.at - y.at).slice(-MAX_ATTEMPTS);
}

/**
 * 把本次运行的策略快照合并进磁盘上的失败账本。
 *
 * ★ 纯函数：**不读盘、不写盘、不 require**（与 `workflowRunner.planRecovery` 同一条纪律）——
 *   磁盘读写只允许发生在 `open()/save()` 里，否则"恢复判据"会变成"顺手 IO"，门禁就再也钉不住它。
 *
 * ★ 2026-02-16：`refuted` 的合并口径从「一旦 true 永不回退」改成「**判定时刻更晚者胜**」。
 *   为什么必须改：旧口径把"一次历史失败"固化成了永久禁令 —— 正是老板点的那个病。
 *   两条子规则：
 *     ① 入参**带了 `refuted` 属性**才算"新观测" ⇒ 它的判定覆盖旧的（无论 true 还是 false）；
 *     ② 入参**没带 `refuted`**（backend 每次失败记账都是这种）⇒ 磁盘上的判定原样保留，
 *        绝不能因为"又失败了一次"就把旧的证伪结论抹掉（那是另一种数据丢失）。
 *
 * @param {Array<object>} prev 磁盘上已有的 attempts
 * @param {object|Array} next 本次运行的策略快照：`ledger.strategySnapshot()`（`{sig:{count,lastKind}}`），
 *                            或同形状的数组（`[{sig,count,lastKind,lastError,…}]`）
 * @param {{now?:number}} [opts]
 * @returns {Array<object>} 合并后的 attempts（`at` 升序，最多 MAX_ATTEMPTS 条）
 */
function mergeAttempts(prev, next, opts) {
  const now = nowMs((opts || {}).now);
  const bys = new Map();
  const put = (a) => {
    if (!a || typeof a !== 'object') return;
    const sig = (typeof a.sig === 'string') ? a.sig.trim() : '';
    if (!sig) return;                                   // 同一条纪律②：没有 sig 的账不落
    const count = Math.max(0, Math.floor(Number(a.count) || 0));
    const at = Number(a.at) > 0 ? Number(a.at) : now;
    /** 这一条入参**自己带了 refuted 判定**吗？（带了才算新观测，见本函数头注★） */
    const asserts = Object.prototype.hasOwnProperty.call(a, 'refuted');
    const prevOne = bys.get(sig);
    if (!prevOne) {
      const verdict = asserts ? verdictFields(a, at) : verdictFields({}, 0);
      const one = { ...a, sig, count, at, lastKind: a.lastKind || 'unknown' };
      one.refuted = verdict.refuted;
      one.refutedAt = verdict.refutedAt;
      if (verdict.refuted) {
        one.refutedEvidence = verdict.refutedEvidence;
        one.refutedScope = verdict.refutedScope;
        one.refutedCodeVersion = verdict.refutedCodeVersion;
      } else {
        delete one.refutedEvidence;
        delete one.refutedScope;
        delete one.refutedCodeVersion;
      }
      bys.set(sig, one);
      return;
    }
    // 判定整体取胜者（不许拼装），其余字段仍按"取最大/取非空"照旧合并
    const winner = asserts ? pickVerdict(prevOne, verdictFields(a, at)) : prevOne;
    const verdict = verdictFields(winner, Number(winner.refutedAt) > 0 ? Number(winner.refutedAt) : at);
    const merged = {
      ...prevOne,
      ...a,
      sig,
      count: Math.max(prevOne.count, count),            // 同 sig 取最大 count（次数只增不减）
      lastKind: a.lastKind || prevOne.lastKind || 'unknown',
      lastError: a.lastError || prevOne.lastError || '',
      nextAction: a.nextAction || prevOne.nextAction || '',
      refuted: verdict.refuted,
      refutedAt: verdict.refutedAt,
      at: Math.max(prevOne.at, at),                     // at = 最近一次观测到它的时间
    };
    if (verdict.refuted) {
      merged.refutedEvidence = verdict.refutedEvidence;
      merged.refutedScope = verdict.refutedScope;
      merged.refutedCodeVersion = verdict.refutedCodeVersion;
    } else {
      delete merged.refutedEvidence;
      delete merged.refutedScope;
      delete merged.refutedCodeVersion;
    }
    bys.set(sig, merged);
  };
  for (const a of (Array.isArray(prev) ? prev : [])) put(a);
  if (Array.isArray(next)) {
    for (const a of next) put(a);
  } else if (next && typeof next === 'object') {
    for (const [sig, v] of Object.entries(next)) {
      put({ sig, count: (v && v.count), lastKind: (v && v.lastKind) || '', at: now });
    }
  }
  return [...bys.values()].sort((x, y) => x.at - y.at).slice(-MAX_ATTEMPTS);
}

/**
 * 记一条 **refuted（已证伪）**：把证据、适用范围、以及**此刻磁盘上的代码版本**一次拍下来。
 *
 * ★ 为什么必须"当场拍版本"而不是复用上一次的：证伪结论只对**它当时验证过的那份代码**成立。
 *   复用旧版本等于让新结论蹭旧证据 —— 那是伪造。
 *
 * @param {Array<object>} attempts 现有账（`at` 升序）
 * @param {{sig:string, tool?:string, errorText?:string, exitCode?:(number|null),
 *          files?:string[], paramKeys?:string[], mode?:string, at?:number,
 *          count?:number, lastKind?:string, nextAction?:string, lastError?:string}} one
 * @param {{now?:number, root?:string, readFile?:(abs:string)=>any}} [opts]
 *        `root` / `readFile` 只给门禁与沙箱用（生产环境走真实 fs）
 * @returns {Array<object>} 合并后的账（`at` 升序，最多 MAX_ATTEMPTS 条）
 */
function recordRefuted(attempts, one, opts) {
  const o = opts || {};
  const now = nowMs(o.now);
  const a = (one && typeof one === 'object') ? one : {};
  const sig = typeof a.sig === 'string' ? a.sig.trim() : '';
  const list = Array.isArray(attempts) ? attempts : [];
  if (!sig) return list.slice();                      // 算不出 key 的账不落（同一条纪律②）
  const at = Number(a.at) > 0 ? Number(a.at) : now;
  const files = Array.isArray(a.files)
    ? a.files.filter((x) => typeof x === 'string' && x.trim())
      .map((x) => refuteScope.toKey(x, o.root)).filter((x) => !!x).slice(0, 50)
    : [];
  const paramKeys = Array.isArray(a.paramKeys)
    ? a.paramKeys.filter((x) => typeof x === 'string').slice(0, 40) : [];
  const tool = typeof a.tool === 'string' ? a.tool.slice(0, 60) : '';
  const entry = {
    sig,
    tool,
    paramKeys,
    mode: typeof a.mode === 'string' ? a.mode.slice(0, 30) : '',
    count: Math.max(0, Math.floor(Number(a.count) || 0)),
    lastKind: (typeof a.lastKind === 'string' && a.lastKind) ? a.lastKind.slice(0, 40) : 'unknown',
    refuted: true,
    refutedAt: at,
    refutedEvidence: {
      tool,
      errorText: typeof a.errorText === 'string' ? a.errorText.slice(0, REFUTED_ERROR_MAX) : '',
      exitCode: (() => {
        const ec = a.exitCode;
        if (ec === null || ec === undefined || ec === '') return null;
        const n = Number(ec);
        return Number.isFinite(n) ? Math.trunc(n) : null;
      })(),
      at,
    },
    refutedScope: { files, paramKeys },
    // 只收录**存在的**文件：不存在的文件没有内容可算 sha1，收进版本表等于伪造证据
    refutedCodeVersion: refuteScope.sha1MapOf(files, { root: o.root, readFile: o.readFile }),
    nextAction: typeof a.nextAction === 'string' ? a.nextAction.slice(0, 200) : '',
    lastError: typeof a.lastError === 'string' ? a.lastError.slice(0, 300) : '',
    at,
  };
  return mergeAttempts(list, [entry], { now });
}

/**
 * 解除证伪（`refuted` 归 false 并**连三字段一起清空**）。
 *
 * ★ 为什么清空而不是留着：三字段是"这个结论凭什么成立"的凭据。
 *   `refuted=false` 但证据还在 ⇒ 下一个人读到的是一条**自相矛盾**的账（说没证伪、却挂着证伪证据）。
 *
 * ★ 2026-02-16：支持**两种匹配**（任一命中即解除），因为成功那一刻不一定拿得到 sig：
 *   · `sig`  —— 精确到"这个做法"；
 *   · `tool` —— 精确到"这个工具"。**清除比保留安全**：一个工具刚刚真的成功了，
 *     就说明它现在能用；此时留着它的任何旧禁令，都会让一个已被证明可用的办法不再被尝试
 *     —— 那正是老板批的那个病（把一次历史失败固化成永久禁令）。
 *     反过来"多清了一条"的代价只是多试一次，方向正确。
 *
 * @param {Array<object>} attempts
 * @param {string} sig 要解除的策略签名（可空）
 * @param {{now?:number, tool?:string}} [opts]
 * @returns {Array<object>} 新数组（不改原对象）
 */
function clearRefuted(attempts, sig, opts) {
  const o = opts || {};
  const now = nowMs(o.now);
  const target = String(sig === undefined || sig === null ? '' : sig).trim();
  const tool = String(o.tool === undefined || o.tool === null ? '' : o.tool).trim();
  const list = Array.isArray(attempts) ? attempts : [];
  if (!target && !tool) return list.slice();   // 两个都说不出要清谁 ⇒ 一条都不动（不许"全清"）
  return list.map((a) => {
    if (!a || typeof a !== 'object') return a;
    const hitSig = !!target && String(a.sig || '') === target;
    const hitTool = !!tool && String(a.tool || '') === tool;
    if (!hitSig && !hitTool) return a;
    if (a.refuted !== true) return a;           // 本来就不是禁令 ⇒ 不需要"解除"（别白改 at）
    const next = { ...a, refuted: false, refutedAt: now };
    delete next.refutedEvidence;
    delete next.refutedScope;
    delete next.refutedCodeVersion;
    return next;
  });
}

/**
 * 把整本账过一遍**三态判定**（refuted / stale / none），产出降级事件。
 *
 * 这是"读 refuted"的**唯一入口**：调用方不该自己拿 `a.refuted` 去 if ——
 * 那样就把"代码变没变"这件事漏掉了，等于继续吃老本。
 *
 * @param {Array<object>} attempts
 * @param {{now?:number, root?:string, readFile?:(abs:string)=>any}} [opts]
 * @returns {{attempts:Array<object>, events:Array<object>,
 *            summary:{total:number, refuted:number, stale:number, none:number, states:Object<string,string>},
 *            refutedStale:number}}
 *   `attempts` 是**生效视图**（stale 的 `refuted` 已压成 false，允许重试），原条目不被改写。
 */
function auditRefuted(attempts, opts) {
  const o = opts || {};
  const now = nowMs(o.now);
  const scopeOpts = { root: o.root, readFile: o.readFile };
  const sum = refuteScope.summarize(attempts, { ...scopeOpts, now });
  return {
    attempts: refuteScope.effectiveAttempts(attempts, scopeOpts),
    events: sum.events,
    summary: { total: sum.total, refuted: sum.refuted, stale: sum.stale, none: sum.none, states: sum.states },
    refutedStale: sum.stale,
  };
}

/**
 * 只出三态汇总（不产出生效视图）——给 trace / 门禁 / 审计看的读数。
 * @param {Array<object>} attempts
 * @param {{now?:number, root?:string, readFile?:(abs:string)=>any}} [opts]
 */
function summarizeRefute(attempts, opts) {
  const o = opts || {};
  return refuteScope.summarize(attempts, { root: o.root, readFile: o.readFile, now: nowMs(o.now) });
}

/**
 * 生效视图（外部 readonly）：把 stale 的 refuted 压成 false，其余字段原样。
 * @param {Array<object>} attempts
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts]
 */
function effectiveAttempts(attempts, opts) {
  const o = opts || {};
  return refuteScope.effectiveAttempts(attempts, { root: o.root, readFile: o.readFile });
}

/**
 * 状态对象 → 规范化 run（逐字段 coerce，绝不整份丢弃）。
 * @param {object} objIn 读到的原始对象
 * @param {{taskId?:string, cfg?:object, now?:number}} opts
 * @returns {{schemaVersion:number, declaredSchemaVersion:number, newerSchema:boolean,
 *            taskId:string, objTaskId:string, run:object, quarantine:Array,
 *            unknown:object, notes:string[]}}
 */
function normalize(objIn, opts) {
  const o = opts || {};
  const cfg = o.cfg || require('./workflows/pptx-v1');
  const now = nowMs(o.now);
  const taskId = String(o.taskId || '');
  const stages = (cfg && Array.isArray(cfg.stages)) ? cfg.stages : [];
  const raw = (objIn && typeof objIn === 'object' && !Array.isArray(objIn)) ? objIn : {};
  const quarantine = [];
  const notes = [];
  const unknown = {};

  const q = (field, value, why) => {
    if (quarantine.length < MAX_QUARANTINE) quarantine.push({ at: now, field, value: safeJson(value), why });
  };

  // ── schemaVersion：缺失视为 1（旧版），>2 视为"新版本写的"⇒ 只读
  const declared = Number(raw.schemaVersion);
  const declaredSchemaVersion = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : 1;
  const newerSchema = declaredSchemaVersion > SCHEMA_VERSION;
  const schemaVersion = newerSchema ? declaredSchemaVersion : SCHEMA_VERSION;
  if (raw.schemaVersion === undefined) notes.push('schema-missing-treated-as-v1');

  // ── 认不出的键：原样保留（"读不懂就丢"是数据丢失的另一种写法）
  const KNOWN = new Set([
    'schemaVersion', 'taskId', 'workflowId', 'version', 'stage', 'completedStages', 'waivedStages',
    'openIssues', 'nextAction', 'status', 'lastUpdated', 'startedAt', 'spec', 'artifacts',
    'artifactFingerprint', 'verdict', 'verdictSummary', 'lease', 'requests', 'attachments',
    'recoverLog', 'quarantine', '_unknown', 'renderArtifacts', 'concludeAttempts', 'attempts',
    // ★ 2026-02-16：refuted 降级事件（"旧禁令被代码变更作废"的审计线索）
    'refuteEvents',
    // ★ 2026-02-16：目标契约对照结论（「偏差」与「经批准的变更」分两桶）。
    //   这四个名字同时是 backend `conclude()` 挂到返回值上的键名 —— 单一真源，不许各叫一套。
    'contractCompared', 'deviations', 'deviationsApproved', 'deviationsUnverified', 'contractSummary',
  ]);
  for (const k of Object.keys(raw)) if (!KNOWN.has(k)) unknown[k] = raw[k];

  // ── 阶段数组：字段级 coerce
  const asStageNames = (v, field) => {
    if (Array.isArray(v)) {
      const out = [];
      for (const it of v) {
        const name = typeof it === 'string' ? it : (it && typeof it.stage === 'string' ? it.stage : '');
        if (!name) { q(field, it, '不是阶段名 ⇒ 丢弃该条'); continue; }
        out.push(name);
      }
      return out;
    }
    if (v === undefined || v === null) return [];
    q(field, v, '类型不对（期望 string[]）⇒ coerce 成 []');
    return [];
  };

  let completedStages = asStageNames(raw.completedStages, 'completedStages');
  const badNames = [];
  completedStages = completedStages.filter((s) => {
    if (stages.includes(s)) return true;
    badNames.push(s);
    return false;
  });
  for (const bad of badNames) q('completedStages', bad, '不存在的阶段名 ⇒ 移出 completedStages（不影响其它阶段）');
  completedStages = [...new Set(completedStages)].sort((a, b) => stages.indexOf(a) - stages.indexOf(b));

  // ── waivedStages：{stage, reason}[]，理由可以为空但会被判据拒绝
  let waivedStages = [];
  if (Array.isArray(raw.waivedStages)) {
    for (const w of raw.waivedStages) {
      const stage = typeof w === 'string' ? w : (w && typeof w.stage === 'string' ? w.stage : '');
      const reason = typeof w === 'string' ? '' : String((w && w.reason) || '');
      if (!stage) { q('waivedStages', w, '缺 stage ⇒ 丢弃该条'); continue; }
      if (!stages.includes(stage)) { q('waivedStages', stage, '不存在的阶段名 ⇒ 丢弃该条'); continue; }
      waivedStages.push({ stage, reason });
    }
  } else if (raw.waivedStages !== undefined && raw.waivedStages !== null) {
    q('waivedStages', raw.waivedStages, '类型不对（期望 {stage,reason}[]）⇒ coerce 成 []');
  }

  // ── v1 → v2 迁移：早期记录把 render/repair 记进 completed。
  //    本机根本没有渲染器（rendererAvailable:false），那不可能真渲染过；
  //    留在 completed 等于把"做不到"洗成"做完了"（违反 waivableStages 三纪律③）。
  //    理由字符串本身就是可逆证据。
  if (declaredSchemaVersion < 2) {
    const migrated = [];
    completedStages = completedStages.filter((s) => {
      if (s === 'render' || s === 'repair') {
        migrated.push({ stage: s, reason: 'migrated: 早期记录未区分豁免（v1 无渲染器 / 无修复动作）' });
        return false;
      }
      return true;
    });
    if (migrated.length) {
      waivedStages = waivedStages.concat(migrated);
      notes.push('migrated-v1-completed-to-waived');
    }
  }

  // ── 豁免与完成**互斥**：同一阶段不得同时在两边（以 waived 为准 —— 豁免不是打勾）
  const waivedSet = new Set(waivedStages.map((w) => w.stage));
  const both = completedStages.filter((s) => waivedSet.has(s));
  if (both.length) {
    q('completedStages', both, '同一阶段同时出现在 completed 与 waived ⇒ 以 waived 为准（豁免不是打勾）');
    completedStages = completedStages.filter((s) => !waivedSet.has(s));
  }
  const dupWaived = waivedStages.map((w) => w.stage).filter((s, i, arr) => arr.indexOf(s) !== i);
  if (dupWaived.length) {
    q('waivedStages', dupWaived, '同一阶段被豁免多次 ⇒ 只保留第一条');
    const seen = new Set();
    waivedStages = waivedStages.filter((w) => (seen.has(w.stage) ? false : (seen.add(w.stage), true)));
  }

  // ── openIssues
  let openIssues = [];
  if (Array.isArray(raw.openIssues)) {
    openIssues = raw.openIssues.filter((x) => x && typeof x === 'object' && x.issue_id);
    if (openIssues.length !== raw.openIssues.length) {
      q('openIssues', raw.openIssues.length, '有 ' + (raw.openIssues.length - openIssues.length) + ' 条没有 issue_id ⇒ 丢弃（无法追踪）');
    }
  } else if (raw.openIssues !== undefined && raw.openIssues !== null) {
    q('openIssues', raw.openIssues, '类型不对（期望 object[]）⇒ coerce 成 []');
  }

  // ── stage：不合法就由已完成阶段反推
  let stage = (typeof raw.stage === 'string' && stages.includes(raw.stage)) ? raw.stage : '';
  if (!stage) {
    const idxs = completedStages.concat(waivedStages.map((w) => w.stage))
      .map((s) => stages.indexOf(s)).filter((i) => i >= 0);
    stage = idxs.length ? stages[Math.max(...idxs)] : stages[0];
    if (raw.stage !== undefined) q('stage', raw.stage, '不在 cfg.stages 里 ⇒ 由已完成阶段反推');
  }

  const objMap = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  const spec = objMap(raw.spec);
  if (raw.spec !== undefined && !spec) q('spec', raw.spec, '类型不对（期望 object）⇒ coerce 成 {}');
  const fp = objMap(raw.artifactFingerprint);
  if (raw.artifactFingerprint !== undefined && !fp) q('artifactFingerprint', raw.artifactFingerprint, '类型不对（期望 map）⇒ coerce 成 {}');

  const run = {
    workflowId: (typeof raw.workflowId === 'string' && raw.workflowId) ? raw.workflowId : cfg.workflowId,
    version: (Number(raw.version) > 0) ? Math.floor(Number(raw.version)) : Number(cfg.version) || 1,
    stage,
    completedStages,
    waivedStages,
    openIssues,
    nextAction: (typeof raw.nextAction === 'string' && raw.nextAction) ? raw.nextAction : stage,
    status: STATUSES.includes(raw.status) ? raw.status : 'in_progress',
    spec: spec || {},
    startedAt: nowMs(raw.startedAt),
    lastUpdated: now,
    /**
     * ★ 2026-10-23：截断方向必须是 `slice(-MAX)`（留最新）。
     *   原来两处都写 `slice(0, MAX)` —— 而 artifacts 是**追加**语义（新的 push 在末尾），
     *   于是满 21 份时被丢掉的恰好是**刚认领/刚落地的那一份**，表现为"认领成功但下一轮状态里没了"。
     *   与 `backend.js` 的 `trimTaskRecord` 口径也对齐了（那边用的是 `.slice(-TASK_ARTIFACTS_MAX)`）。
     */
    artifacts: (Array.isArray(raw.artifacts) ? raw.artifacts : [])
      .filter((x) => typeof x === 'string' && x).slice(-MAX_ARTIFACTS),
    artifactFingerprint: fp || {},
    verdict: (typeof raw.verdict === 'string' && raw.verdict) ? raw.verdict : null,
    verdictSummary: typeof raw.verdictSummary === 'string' ? raw.verdictSummary.slice(0, 300) : '',
    requests: (Array.isArray(raw.requests) ? raw.requests : [])
      .filter((x) => x && typeof x === 'object').slice(-MAX_REQUESTS),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : [])
      .filter((x) => x && typeof x === 'object' && x.path).slice(0, MAX_ATTACHMENTS),
    renderArtifacts: (Array.isArray(raw.renderArtifacts) ? raw.renderArtifacts : [])
      .filter((x) => typeof x === 'string' && x).slice(0, MAX_ARTIFACTS),
    recoverLog: (Array.isArray(raw.recoverLog) ? raw.recoverLog : [])
      .filter((x) => x && typeof x === 'object').slice(-MAX_RECOVER_LOG),
    concludeAttempts: Number(raw.concludeAttempts) > 0 ? Math.floor(Number(raw.concludeAttempts)) : 0,
    /**
     * 失败方法账本（跨请求的经验）。**不是"做到了第几步"** —— 是"哪些方法已经证伪、为什么坏、
     * 下一步为什么换路"。schemaVersion 仍是 2：旧文件没有它 ⇒ []（零迁移，不算损坏）。
     */
    attempts: normalizeAttempts(raw.attempts, q, 'attempts'),
    /**
     * ★ 2026-02-16：`refutedStale` 事件队列（最近的 N 条）。
     *   一条事件 = "某条 refuted 禁令因代码变更被降级为 stale"，含**哪个文件变了 / 旧 sha1 / 新 sha1**。
     *   旧文件没有这个字段 ⇒ []（零迁移）。
     */
    refuteEvents: (Array.isArray(raw.refuteEvents) ? raw.refuteEvents : [])
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
      .slice(-MAX_REFUTE_EVENTS),
    /**
     * ★ 2026-02-16：目标契约对照结论。三态**各自单独存**，不许折叠：
     *   `deviations`（真偏差）/ `deviationsApproved`（经批准的变更）/ `deviationsUnverified`（没比成的）。
     * 旧文件没有这些字段 ⇒ 零迁移：`contractCompared` 记 **false**（不是 true ——
     * "老文件里没有结论"绝不能因为字段缺失就变成"一致"），三个桶记 []。
     */
    contractCompared: raw.contractCompared === true,
    deviations: (Array.isArray(raw.deviations) ? raw.deviations : [])
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(-MAX_CONTRACT_ITEMS),
    deviationsApproved: (Array.isArray(raw.deviationsApproved) ? raw.deviationsApproved : [])
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(-MAX_CONTRACT_ITEMS),
    deviationsUnverified: (Array.isArray(raw.deviationsUnverified) ? raw.deviationsUnverified : [])
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(-MAX_CONTRACT_ITEMS),
    contractSummary: objMap(raw.contractSummary) || { deviated: 0, approved: 0, unverified: 0, fields: 0 },
  };

  return {
    schemaVersion,
    declaredSchemaVersion,
    newerSchema,
    taskId: taskId || String(raw.taskId || ''),
    objTaskId: typeof raw.taskId === 'string' ? raw.taskId : '',
    run,
    quarantine,
    unknown,
    notes,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 三、原子写
// ───────────────────────────────────────────────────────────────────────────

/**
 * 原子写一个状态文档（只在这里调用 memoryStore.atomicWrite —— 全仓唯一实现）。
 * @returns {{ok:boolean, reason?:string, bytes?:number}}
 */
function writeStateFile(file, doc) {
  const text = JSON.stringify(doc, null, 2);
  const res = memoryStore.atomicWrite(file, text);
  if (!res || res.ok !== true) {
    return { ok: false, reason: String((res && res.error) || 'atomic_write_failed') };
  }
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
}

/** 64KB 裁剪：按 recoverLog → quarantine → openIssues → attempts 丢最旧，**永不丢阶段字段** */
function clipState(doc) {
  const size = (d) => Buffer.byteLength(JSON.stringify(d, null, 2), 'utf8');
  if (size(doc) <= MAX_BYTES) return doc;
  const out = {
    ...doc,
    recoverLog: (Array.isArray(doc.recoverLog) ? doc.recoverLog : []).slice(),
    quarantine: (Array.isArray(doc.quarantine) ? doc.quarantine : []).slice(),
    openIssues: (Array.isArray(doc.openIssues) ? doc.openIssues : []).slice(),
    attempts: (Array.isArray(doc.attempts) ? doc.attempts : []).slice(),
    refuteEvents: (Array.isArray(doc.refuteEvents) ? doc.refuteEvents : []).slice(),
    // 契约结论（三桶）：先整份复制，再在下面按需丢最旧的（绝不整桶丢弃）
    deviations: (Array.isArray(doc.deviations) ? doc.deviations : []).slice(),
    deviationsApproved: (Array.isArray(doc.deviationsApproved) ? doc.deviationsApproved : []).slice(),
    deviationsUnverified: (Array.isArray(doc.deviationsUnverified) ? doc.deviationsUnverified : []).slice(),
  };
  while (size(out) > MAX_BYTES && out.recoverLog.length) out.recoverLog.shift();
  while (size(out) > MAX_BYTES && out.quarantine.length) out.quarantine.shift();
  while (size(out) > MAX_BYTES && out.openIssues.length) out.openIssues.shift();
  // refuteEvents 排在 attempts 之前裁剪（事件是审计线索，账本是经验 —— 经验优先保留）
  while (size(out) > MAX_BYTES && out.refuteEvents.length) out.refuteEvents.shift();
  // 契约结论排在 refuteEvents 之后、attempts 之前：它是**本次交付的结论**，
  // 比流水账（recoverLog/quarantine）更该留，但不如"经验账本"（attempts）值得留 ——
  // 经验丢了下次会重犯，结论丢了下次只是看不到上一次怎么判的。
  // ⚠️ 丢的也是**最旧的**（数组按时间升序），不是最频繁的那几条。
  for (const k of ['deviations', 'deviationsApproved', 'deviationsUnverified']) {
    while (size(out) > MAX_BYTES && out[k].length) out[k].shift();
  }
  // ★ attempts 排在最后：它是「经验」，比流水账（recoverLog / quarantine）更值得留 ——
  //   而且丢的也是**最旧的**（数组已按 at 升序），不是最频繁的那几条。
  while (size(out) > MAX_BYTES && out.attempts.length) out.attempts.shift();
  return out;
}

/** 状态文档（文件形态）。字段顺序 = 人读优先。 */
function buildStateDoc(st, extra) {
  const e = extra || {};
  const run = st.run || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    taskId: String(st.taskId || ''),
    workflowId: run.workflowId,
    version: run.version,
    stage: run.stage,
    completedStages: Array.isArray(run.completedStages) ? run.completedStages : [],
    waivedStages: Array.isArray(run.waivedStages) ? run.waivedStages : [],
    openIssues: Array.isArray(run.openIssues) ? run.openIssues : [],
    nextAction: run.nextAction || run.stage,
    status: STATUSES.includes(run.status) ? run.status : 'in_progress',
    startedAt: run.startedAt,
    lastUpdated: Number(run.lastUpdated) || clock(),
    spec: run.spec || {},
    artifacts: Array.isArray(run.artifacts) ? run.artifacts : [],
    artifactFingerprint: run.artifactFingerprint || {},
    verdict: run.verdict === undefined ? null : run.verdict,
    verdictSummary: String(run.verdictSummary || ''),
    requests: Array.isArray(run.requests) ? run.requests : [],
    attachments: Array.isArray(run.attachments) ? run.attachments : [],
    renderArtifacts: Array.isArray(run.renderArtifacts) ? run.renderArtifacts : [],
    recoverLog: Array.isArray(run.recoverLog) ? run.recoverLog : [],
    concludeAttempts: Number(run.concludeAttempts) || 0,
    // 失败方法账本：经验本身（`at` 升序，最旧在前）
    attempts: Array.isArray(run.attempts) ? run.attempts : [],
    // refuted 降级事件（"这条旧禁令已经因为代码变了而作废"的审计线索）
    refuteEvents: (Array.isArray(run.refuteEvents) ? run.refuteEvents.slice(-MAX_REFUTE_EVENTS) : []),
    // ★ 2026-02-16：目标契约对照结论（「偏差」/「经批准的变更」/「未核验」三个桶分开落盘）
    contractCompared: run.contractCompared === true,
    deviations: Array.isArray(run.deviations) ? run.deviations.slice(-MAX_CONTRACT_ITEMS) : [],
    deviationsApproved: Array.isArray(run.deviationsApproved) ? run.deviationsApproved.slice(-MAX_CONTRACT_ITEMS) : [],
    deviationsUnverified: Array.isArray(run.deviationsUnverified) ? run.deviationsUnverified.slice(-MAX_CONTRACT_ITEMS) : [],
    contractSummary: (run.contractSummary && typeof run.contractSummary === 'object' && !Array.isArray(run.contractSummary))
      ? run.contractSummary
      : { deviated: 0, approved: 0, unverified: 0, fields: 0 },
    lease: e.lease === undefined ? null : e.lease,
    quarantine: Array.isArray(st.quarantine) ? st.quarantine : [],
    _unknown: (st.unknown && typeof st.unknown === 'object') ? st.unknown : {},
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 四、证据收集（磁盘读**只在这里**，planRecovery 保持纯函数）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 收集恢复判据需要的磁盘证据。
 *
 * 产物候选的来源（全部**只读**）：
 *   ① 登记表 `run.artifacts` —— ⚠️ **当前不参与候选收集**：它由 `conclude()` 之后落盘，
 *      读它的只有 `stageEvidence('build')`（经 `workflowRunner.runArtifactPaths`）。
 *      `collectEvidence` 的候选**只**来自 ② 与 ③。这是「只写不读」的**已知缺口**，不是设计：
 *      一份文件被登记过，恢复时并不能因此被认领。
 *   ② traces/<taskId>.jsonl 里 `kind:'tool' && name:'file-write' && params.path`
 *      —— 把 trace 当**只读证据源**，不改它的写入语义。`ok:false` 的写入**不算**"写过"。
 *   ③ 工作区扫描 `workspaces` 下 mtimeMs >= startedAt 的候选 —— **只在复核场景跑**：
 *      本 run 的 `completedStages` 已含 `cfg.buildStage`（上一次请求确实完成过产物阶段）
 *      **且** `run.artifacts` 为空。认领场景（产物阶段尚未完成）**不跑** —— 那正是
 *      「把时间接近当成所有权」的入口（见门禁 ★★N1 / ★★B4）。
 *      候选 >=2 份时 `planRecovery` 不认领（`adoptArtifact` 要求恰好 1 份）。
 *
 * ⚠️ 复核场景下 ③ 仍是**纯 mtime 判断，没有身份判据**：并发任务在同一工作区落下的同类型
 *   文件，仍可能被当成本任务 build 的证据。这是本轮的**已知残留**（收窄手段只有"恰好 1 份"），
 *   不要在这里写成"已解决"。
 *
 * ★★ 2026-10-26【产物类型契约】候选**不再按 `.pptx` 过滤**（修前 ②③ 两处都写死了 `/\.pptx$/i`）：
 *   产物类型由工作流契约声明（`cfg.buildExts`），调用方通过 `ctx.exts` 传进来（`open()` 传的就是
 *   `workflowRunner.artifactExtsOf(cfg)`）。
 *   为什么证据收集这一层也要改：一个 `.txt` 工作流的产物在 ②③ 两条来源上**结构性不可见**，
 *   于是恢复时 build 的账永远站不住 —— 实测症状是「R2 一开始 completedStages 就退回
 *   ["brief","asset_inventory"]、notes 里冒出 evidence-truncated/prefix-truncated、
 *   plan.invalidated 把 build/deliver 全作废」。那不是"没做"，是"看不见"。
 *   ⚠️ `ctx.exts` 未传 ⇒ 不做类型过滤（这一层只负责"磁盘上有什么"，"算不算产物"由
 *      planRecovery 按契约判）。**绝不**在这里回落成 `.pptx`。
 *
 * @param {object} run 当前 run
 * @param {{now?:number, attachmentsChanged?:boolean, traceEvents?:Array, workspaces?:Array,
 *          planned?:object, rendered?:boolean, rendererAvailable?:boolean, exts?:string[],
 *          buildStage?:string}} ctx
 */
function collectEvidence(run, ctx) {
  const c = ctx || {};
  const f = fsx();
  const r = run || {};
  const startedAt = Number(r.startedAt) || 0;
  /** 产物类型过滤（空 = 不按类型过滤，见头注）。 */
  const typeExts = workflowRunner.normalizeExts(c.exts);

  const exists = (p) => {
    if (!p || typeof p !== 'string') return false;
    try { return !!f.existsSync(p); } catch { return false; }
  };
  /**
   * 同一个物理文件的两个路径写法是否等价。
   * 为什么要它：候选数 >=2 时 adoptArtifact 会**拒绝认领**（不知道该信哪份），
   * 所以"同一份 deck 经 trace 和 workspace 扫描各进来一次"必须合并 —— 否则一份文件把自己挤掉，
   * 表现是"磁盘上有且只有一份成品，却回退去重做"。Windows 下大小写不敏感，要一并吃掉。
   */
  const pathKey = (p) => {
    let s = String(p || '');
    try { s = path.resolve(s); } catch { /* 解析不了就按字面比 */ }
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const normSame = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
  const statOf = (p) => {
    try { return f.statSync(p); } catch { return null; }
  };
  const sizeOf = (p) => {
    const st = statOf(p);
    return st ? (Number(st.size) || 0) : 0;
  };
  const mtimeOf = (p) => {
    const st = statOf(p);
    return st ? (Number(st.mtimeMs) || 0) : 0;
  };
  const inspect = (p) => {
    try {
      const info = workflowRunner.inspectPptx(f.readFileSync(p));
      return {
        openable: info.openable === true,
        slideCount: Number(info.slideCount) || 0,
        duplicateGroups: Array.isArray(info.duplicateGroups) ? info.duplicateGroups : [],
        error: String(info.error || ''),
      };
    } catch (e) {
      return { openable: false, slideCount: 0, duplicateGroups: [], error: String((e && e.message) || e) };
    }
  };
  const fingerprintOf = (p) => {
    if (!exists(p)) return null;
    const info = inspect(p);
    return { size: sizeOf(p), mtimeMs: mtimeOf(p), slideCount: info.slideCount };
  };

  const dirs = (Array.isArray(c.workspaces) ? c.workspaces : []).filter((d) => !!d);
  const candidates = [];
  /**
   * ★ 2026-10-23 修：相对路径必须先按 workspaces 解析成绝对路径，否则**永远进不了候选**。
   *   链路是这样的：`skills/file-write/run.js` 真正落地时是 `path.resolve(WORKSPACE, params.path)`，
   *   也就是**写到了绝对路径**；但 `traceTool` 记的是工具的**原始入参**（`params: maskSecrets(prm)`）。
   *   于是模型传 `deck.pptx`（相对，最常见的形态）时，trace 里存的就是 `deck.pptx`，
   *   而这里直接 `fs.existsSync('deck.pptx')` 是按 backend 进程 cwd 解析的 ⇒ 几乎必然 false
   *   ⇒ 第 ② 条来源对相对路径**结构性失效**（当时只剩第 ③ 条工作区扫描在兜，而 ③ 现在
   *   只在复核场景跑 ⇒ 不修这一条，相对路径的写入就彻底看不见了）。
   *   这个缺陷长期看不出来，是因为当时第 ③ 条会把同一个文件再收一遍（且给的是绝对路径）——
   *   两个来源互相遮丑。一旦文件不在 workspaces 里、或 mtime 被过滤掉，就变成"磁盘上有成品却不认领"。
   *   解析不到就**不当候选**：宁可不认领回退 build，也不拿一个假路径去 inspect。
   */
  const resolveCand = (p) => {
    const s = String(p || '');
    if (!s) return '';
    if (path.isAbsolute(s)) return s;
    for (const dir of dirs) {
      const full = path.resolve(dir, s);
      if (exists(full)) return full;
    }
    return '';
  };
  const pushCand = (p) => {
    const s = String(p || '');
    if (!s) return;
    // ★ 类型过滤来自契约（ctx.exts）；未声明类型 ⇒ 不过滤（见 collectEvidence 头注）
    if (typeExts.length && !workflowRunner.matchesExt(s, typeExts)) return;
    if (!exists(s)) return;                       // 磁盘上已经没有的，不能当候选
    // 归一后去重：同一份产物经不同写法（相对 / 绝对 / 大小写变形）进来时必须只算 1 份候选
    //（候选数 >=2 会让 adoptArtifact 拒绝认领，那等于"同一份文件把自己挤掉"）
    if (candidates.some((x) => normSame(x.path, s))) return;
    candidates.push({ path: s, size: sizeOf(s), mtimeMs: mtimeOf(s) });
  };

  /**
   * ★★ 2026-10-26【残余耦合修复 · 点 3】③ 工作区扫描的放行条件：
   *   **只在「复核自己上一次请求的产物」时跑** —— 账上说产物阶段已完成
   *   （`completedStages` 含 `cfg.buildStage`），却没有记下路径（`run.artifacts` 为空）。
   *   这时扫盘是"确认那份成品还在不在"，不是"认领一份新文件"。
   *
   * 修前：③ 的唯一判据是 `mtimeMs >= startedAt`，而 `startedAt` 跨请求保留、窗口**没有上界**
   *   ⇒ 实测（p3-attrib.mjs S4/S5）B 任务把 A 的成品认成了自己的：`candidates=1 ⇒
   *   adopted=A任务的门诊汇报.pptx`，`resumeStage` 从 build 直接跳到 render，并把别人的路径
   *   写进本任务 `run.artifacts` + `fingerprint` ⇒ **误认领被持久化**。
   *   老板原话：「**不得把时间接近直接等同于当前任务所有权**。」时间只是必要条件。
   *
   * 为什么不是"整段删掉"：F8 那个真实场景（产物由脚本产出、`trackDeliverable` 没记上路径，
   *   但 `completedStages` 已含 build）要靠它确认成品仍在盘上。删了会把"用户以为成果丢了"
   *   这个已修好的假红重新造出来（`backend.js:3645` 会因 priorBuild=false 拒绝认领）。
   *
   * ⚠️ 已知残留（别在这里写成"已解决"）：并发任务在同一工作区落下的同类型文件，仍可能被 ③
   *   当成本任务 build 的证据 —— 判据只有 mtime，没有身份证据。收窄手段只有"候选恰好 1 份"。
   *
   * ⚠️ ③ 的候选**到不了** `adoptArtifact`：该函数只在 `gap === buildIdx` 时认领，而那时
   *   `completedStages` 不含 build ⇒ ③ 不跑。③ 现存的唯一消费者是 `stageEvidence('build')`
   *   （`workflowRunner.js:1794` 经 `runArtifactPaths:1587-1590` 回落 `candidateDecks`）。
   *   别在注释里写成"③ 负责认领"。
   */
  const buildStageName = (typeof c.buildStage === 'string' && c.buildStage) ? c.buildStage : '';
  const priorBuildRecorded = !!buildStageName
    && Array.isArray(r.completedStages) && r.completedStages.includes(buildStageName);
  const artifactsRecorded = Array.isArray(r.artifacts) && r.artifacts.length > 0;

  // ② trace 当只读证据源（相对路径先按 workspaces 解析）
  for (const evt of (Array.isArray(c.traceEvents) ? c.traceEvents : [])) {
    if (!evt || evt.kind !== 'tool' || evt.name !== 'file-write') continue;
    if (evt.ok === false) continue;               // 失败写入不算"写过"（taskTrace 把 ok 放事件顶层）
    const p = resolveCand(evt.params && evt.params.path);
    if (p) pushCand(p);
  }
  // ③ 工作区扫描 —— 只在**复核**上一次请求的产物时跑（见上方长注）
  if (priorBuildRecorded && !artifactsRecorded) {
    for (const dir of dirs) {
      let names = [];
      try { names = f.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        const nm = String(n);
        // 目录 / 无扩展名的一律不看（判据在 pushCand 里也有一份，这里先挡掉免得白 stat）
        if (!nm || nm.charAt(0) === '.') continue;
        if (typeExts.length && !workflowRunner.matchesExt(nm, typeExts)) continue;
        const p = path.join(dir, nm);
        if (startedAt && mtimeOf(p) < startedAt) continue;
        pushCand(p);
      }
    }
  }

  return {
    candidateDecks: candidates,
    exists,
    sizeOf,
    inspect,
    fingerprintOf,
    verify: (paths) => toolProtocol.verifyDeliverables(
      (Array.isArray(paths) ? paths : []).map((p) => ({ path: p })),
      { fsModule: f }
    ),
    attachmentsChanged: c.attachmentsChanged === true,
    planned: c.planned || null,
    rendered: c.rendered === true,
    rendererAvailable: c.rendererAvailable === true,
    notes: [],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 五、租约（epoch fencing）
// ───────────────────────────────────────────────────────────────────────────

function makeLease(taskId, prevEpoch, now) {
  return {
    owner: PROC_OWNER,
    pid: process.pid,
    host: HOST,
    epoch: (Number(prevEpoch) || 0) + 1,
    expiresAt: now + LEASE_TTL_MS,
    taskId: String(taskId || ''),
  };
}

/** 回读校验：epoch + owner + 未过期 + 本进程没有另一个执行者已持锁 */
function leaseIsOurs(lease, mine, now) {
  if (!lease || typeof lease !== 'object') return false;
  if (Number(lease.epoch) !== Number(mine.epoch)) return false;
  if (String(lease.owner || '') !== String(mine.owner || '')) return false;
  if (!(Number(lease.expiresAt || 0) > now)) return false;
  if (HELD.has(mine.taskId)) return false;      // 同进程重复进入 ⇒ 不重复持有
  return true;
}

/**
 * 抢租约：递增 epoch → 原子写 → **回读**确认。
 *
 * 为什么必须回读：原子 rename 是「最后写者胜」，真并发时败者回读必然看见别人的 epoch。
 * 同进程的第二次进入（顺序执行，回读看不见别人）由 `HELD` 挡在写盘**之前** ⇒ 一行都不写。
 */
function claim(taskId, st, prevEpoch, now) {
  const held = HELD.get(taskId);
  // 本进程的上一次持有已经过期（比如上一轮崩在半路）⇒ 允许接管，否则同一 taskId 会被永久卡住
  if (held && Number(held.expiresAt || 0) <= now) HELD.delete(taskId);
  if (HELD.has(taskId)) {
    stats.observers += 1;
    return {
      owned: false, wrote: false, mode: 'observer', reason: 'duplicate-in-process',
      lease: st.lease || null,
    };
  }
  const mine = makeLease(taskId, prevEpoch, now);
  const doc = buildStateDoc({ ...st, lease: mine }, { lease: mine });
  doc.lastUpdated = now;
  const w = writeStateFile(st.file, clipState(doc));
  if (!w.ok) {
    stats.observers += 1;
    return { owned: false, wrote: false, mode: 'observer', reason: 'claim_write_failed: ' + w.reason, lease: null, mine };
  }
  const back = readStateRaw(st.file);
  const backLease = (back.kind === 'ok' && back.obj && back.obj.lease) ? back.obj.lease : null;
  if (!leaseIsOurs(backLease, mine, now)) {
    stats.observers += 1;
    return { owned: false, wrote: true, mode: 'observer', reason: 'lease-not-confirmed', lease: backLease, mine };
  }
  HELD.set(taskId, { epoch: mine.epoch, owner: mine.owner, expiresAt: mine.expiresAt });
  stats.writes += 1;
  return { owned: true, wrote: true, mode: 'owner', reason: 'ok', lease: mine };
}

/** save 时的持有校验：文件里的租约必须仍是"我的那一次"（epoch 单调递增 ⇒ 被接管就会被拒） */
function ownsNow(lease, store, now) {
  if (!lease || typeof lease !== 'object') return false;
  if (Number(lease.epoch) !== Number(store.epoch)) return false;
  if (String(lease.owner || '') !== String(store.owner || '')) return false;
  if (!(Number(lease.expiresAt || 0) > now)) return false;
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// 六、open / save / release
// ───────────────────────────────────────────────────────────────────────────

/** 全新 run（无文件 ⇒ 与今天的行为逐字一致，零迁移） */
function freshState(taskId, cfg, now, opts) {
  const spec = (opts && opts.spec) || {};
  const run = workflowRunner.createRun(cfg, spec, now);
  // 新开局：经验账本是空数组（不是 undefined）—— 调用方不必到处 `|| []`
  if (!Array.isArray(run.attempts)) run.attempts = [];
  return {
    schemaVersion: SCHEMA_VERSION,
    declaredSchemaVersion: SCHEMA_VERSION,
    newerSchema: false,
    taskId,
    objTaskId: '',
    run,
    lease: null,
    quarantine: [],
    unknown: {},
    notes: [],
    file: pathOf(taskId),
  };
}

/**
 * 打开（或开局）一个任务的状态。
 *
 * @param {{taskId:string, cfg?:object, now?:number, text?:string, attachments?:Array,
 *          spec?:object, traceEvents?:Array, workspaces?:Array}} opts
 * @returns {{mode:'owner'|'observer'|'disabled', run:object|null, resumeStage:string,
 *            plan:object|null, store:object|null, notes:string[], corruptSavedAs?:string}}
 */
function open(opts) {
  const o = opts || {};
  const cfg = o.cfg || require('./workflows/pptx-v1');
  const now = nowMs(o.now);
  const taskId = String(o.taskId || '');
  if (!isEnabled()) {
    return { mode: 'disabled', run: null, resumeStage: '', plan: null, store: null, notes: ['workflowState-not-initialized'] };
  }
  if (!taskId) {
    return { mode: 'disabled', run: null, resumeStage: '', plan: null, store: null, notes: ['taskId-required'] };
  }

  const notes = [];
  let st = null;
  let corruptSavedAs = '';
  const file = pathOf(taskId);
  const raw = readStateRaw(file);
  // ★ 是不是「从磁盘上读到了上一次的账」——missing 才是首跑，其余（含 corrupt 隔离后重建）都算恢复。
  const isRecovery = raw.kind !== 'missing';

  if (raw.kind === 'missing') {
    st = freshState(taskId, cfg, now, o);
    notes.push(workflowRunner.RECOVERY_NOTES.stateMissing);
  } else if (raw.kind === 'corrupt') {
    corruptSavedAs = quarantineCorruptFile(raw);
    st = freshState(taskId, cfg, now, o);
    notes.push(workflowRunner.RECOVERY_NOTES.stateCorrupt);
    st.quarantine.push({
      at: now,
      field: '*file*',
      value: raw.reason,
      why: '状态文件解析失败 ⇒ 原文件改名留证（' + (corruptSavedAs || '改名失败') + '），本次按无状态起新 run',
    });
  } else {
    st = normalize(raw.obj, { taskId, cfg, now });
    st.taskId = taskId;
    st.file = file;
    if (st.objTaskId && st.objTaskId !== taskId) {
      // 外来文件：不覆盖，改写到带 sha1 后缀的文件
      st.quarantine.push({
        at: now,
        field: 'taskId',
        value: st.objTaskId,
        why: '状态文件里的 taskId 与本次不同 ⇒ 视为外来文件：不覆盖原文件，改写到带 sha1 后缀的文件',
      });
      st.file = path.join(root, safeName(taskId) + '.' + sha1(taskId).slice(0, 8) + '.json');
      notes.push('foreign-state');
    }
    const prev = raw.obj && raw.obj.lease ? raw.obj.lease : null;
    st.lease = prev;
  }

  // ── 本请求的事实（requests / attachments）
  let attachmentsChanged = false;
  if (typeof o.text === 'string' && o.text) {
    const text = String(o.text);
    const h = sha1(text);
    const list = Array.isArray(st.run.requests) ? st.run.requests.slice() : [];
    const last = list[list.length - 1];
    if (!last || last.sha1 !== h || Number(last.textLen) !== text.length) {
      list.push({ sha1: h, textLen: text.length, ts: now });
    }
    st.run.requests = list.slice(-MAX_REQUESTS);
  }
  if (Array.isArray(o.attachments)) {
    const prevPaths = (Array.isArray(st.run.attachments) ? st.run.attachments : []).map((a) => String(a.path));
    const nextList = o.attachments.filter((a) => a && a.path);
    const nextPaths = nextList.map((a) => String(a.path));
    if (prevPaths.length && prevPaths.join('\u0000') !== nextPaths.join('\u0000')) attachmentsChanged = true;
    st.run.attachments = nextList.slice(0, MAX_ATTACHMENTS);
  }

  const prevEpoch = Number((st.lease && st.lease.epoch) || 0);

  /**
   * ★ 产物阶段名来自本工作流契约（`cfg.buildStage`），`collectEvidence` 用它判断
   *   「③ 工作区扫描该不该跑」（只在复核上一次请求的产物时跑）。
   */
  const buildStage = (cfg && typeof cfg.buildStage === 'string') ? cfg.buildStage : '';

  // ── 新版 schema：只读，不抢租约、不写盘
  if (st.newerSchema) {
    notes.push('state-newer-schema');
    const store = makeStore(st, {
      mode: 'observer', persistence: 'read-only', epoch: prevEpoch, owner: PROC_OWNER,
    });
    STORES.set(taskId, store);
    const ev = collectEvidence(st.run, {
      planned: (st.run.spec && st.run.spec.slideCount) || null,
      attachmentsChanged, traceEvents: o.traceEvents, workspaces: o.workspaces,
      // ★ 产物类型来自本工作流契约（唯一来源 buildExts）；这里不写死任何扩展名
      exts: workflowRunner.artifactExtsOf(cfg),
      buildStage,
    });
    const plan = workflowRunner.planRecovery(st.run, cfg, ev);
    return { mode: store.mode, run: st.run, resumeStage: plan.resumeStage, plan, store, notes };
  }

  // ── 抢租约
  const leaseRes = claim(taskId, st, prevEpoch, now);
  st.lease = leaseRes.lease || null;
  st.file = st.file || file;

  const store = makeStore(st, {
    mode: leaseRes.mode,
    persistence: 'read-write',
    epoch: leaseRes.owned && leaseRes.lease ? Number(leaseRes.lease.epoch) : 0,
    owner: leaseRes.owned && leaseRes.lease ? String(leaseRes.lease.owner) : '',
  });
  STORES.set(taskId, store);
  if (leaseRes.mode !== 'owner') notes.push('lease-conflict');

  // ── 证据 + 纯判据
  const ev = collectEvidence(st.run, {
    planned: (st.run.spec && st.run.spec.slideCount) || null,
    attachmentsChanged,
    traceEvents: o.traceEvents,
    workspaces: o.workspaces,
    // ★ 产物类型来自本工作流契约（唯一来源 buildExts）；这里不写死任何扩展名
    exts: workflowRunner.artifactExtsOf(cfg),
    buildStage,
  });
  const plan = workflowRunner.planRecovery(st.run, cfg, ev);

  // ── 把恢复结论落回 run（**只截断，不补账**，唯一例外是产物认领）
  const before = JSON.stringify({
    c: st.run.completedStages || [],
    w: (st.run.waivedStages || []).map((x) => x.stage),
  });
  const recovered = {
    completedStages: plan.completedStages,
    waivedStages: plan.waivedStages,
    openIssues: plan.openIssues,
    nextAction: plan.resumeStage,
    /**
     * stage 的口径：截断后「最后一个已完成的阶段」。
     * 不能写 plan.resumeStage —— stage 表示"站在哪里"，resumeStage 表示"下一步做什么"，
     * 二者相等会让 markStage 的 maxDone 判据看起来像已经推进到了下一阶段。
     */
    stage: plan.completedStages.length
      ? plan.completedStages[plan.completedStages.length - 1]
      : ((cfg.stages && cfg.stages[0]) || 'brief'),
  };
  if (plan.adopted) {
    const arts = (Array.isArray(st.run.artifacts) ? st.run.artifacts.slice() : []);
    if (!arts.includes(plan.adopted)) arts.push(plan.adopted);
    recovered.artifacts = arts.slice(-MAX_ARTIFACTS);   // 留最新（见 normalize 里同一条说明）
    const fp = { ...(st.run.artifactFingerprint || {}) };
    if (!fp[plan.adopted]) {
      const cur = ev.fingerprintOf(plan.adopted);
      if (cur) fp[plan.adopted] = cur;
    }
    recovered.artifactFingerprint = fp;
  }
  st.run = { ...st.run, ...recovered, lastUpdated: now };

  /**
   * ★ 2026-02-16：**refuted 三态复核**（老板那条「代码变了旧假设仍被无条件跳过」）。
   *
   * 位置是刻意的：在 `planRecovery` **之后**（不干扰恢复判据）、在落盘**之前**
   * （降级事实必须留在磁盘上，不能只活在内存返回值里）。
   *
   * 做的事只有两件，都很窄：
   *   ① 拿 `refutedCodeVersion` 与**此刻磁盘上同路径文件的 sha1**逐条比对；
   *   ② 任何一条不一致（或"没版本/没范围"这种讲不出代码没变的情形）⇒ 记一条 `refutedStale` 事件。
   *
   * 🔴 刻意**不改写** `attempts` 里的原条目：证据不能因为"降级"就被抹掉。
   *   降级的执行点在读取侧（`toolProtocol.seededOf` / 本模块 `effectiveAttempts`）。
   *   「stale 之后再失败」由 `recordRefuted` 重拍三字段，「stale 之后成功」由 `clearRefuted` 解除。
   */
  let refuteSummary = null;
  try {
    const audit = auditRefuted(st.run.attempts, { now });
    refuteSummary = audit.summary;
    if (audit.events.length) {
      st.run.refuteEvents = (Array.isArray(st.run.refuteEvents) ? st.run.refuteEvents.slice() : [])
        .concat(audit.events).slice(-MAX_REFUTE_EVENTS);
      notes.push('refuted-stale:' + audit.events.length);
    }
  } catch (e) {
    // 复核是增益，不是单点故障源：坏了按"没有 refuted 信息"继续，绝不阻断任务
    notes.push('refute-audit-failed');
    try { console.error('[workflowState] refuted 三态复核异常（按无此信息继续）：', e && e.message); } catch { /* 旁路 */ }
  }

  const after = JSON.stringify({
    c: st.run.completedStages || [],
    w: (st.run.waivedStages || []).map((x) => x.stage),
  });
  const changed = before !== after || !!plan.adopted || plan.invalidated.length > 0;
  /**
   * ★ 2026-10-23 修：写入门槛原来只看「有没有变化」，于是最该留痕的情形被挡掉了。
   *   「gap 落在 build、磁盘上没有候选 ⇒ 不认领」时：completedStages 没变、adopted 为空、
   *   invalidated 为空 ⇒ `changed === false` ⇒ **一条日志都不写**。
   *   于是"看了、决定了不认领"这种**结论**在磁盘上完全没有痕迹 —— 老板要的"没做到的事不许静默"
   *   在这里被自己的写入门槛吃掉了。实测：`plan.adoptWhy` 有值，磁盘 `recoverLog` 是空数组。
   *   ⇒ 有 `adoptWhy` 就必须写（它就是"为什么没认领"的正文）。
   */
  const hasAdoptWhy = !!String(plan.adoptWhy || '').trim();
  /**
   * ★ 2026-10-23 第二次修（真实端到端读数）：门槛仍然会漏掉**最常见**的那一种恢复。
   *   实测：中断时 completedStages 已含 build，恢复时 resumeStage=render、invalidated=[]、
   *   adopted 为空、adoptWhy 也为空（因为账本来就是对的，没什么可认领、也没什么好解释的）
   *   ⇒ `changed=false`、`hasAdoptWhy=false`、`resumeStage!=='conclude'` ⇒ **recoverLog 一条都不写**。
   *   后果：磁盘上完全看不出"这次是从上一次的账接着跑的"，事后审计只能去翻 trace。
   *   ⇒ 只要本次是**恢复**（不是首跑），就必须留一条，并记下触发原因（trigger）。
   */
  const trigger = changed ? 'changed'
    : hasAdoptWhy ? 'adopt-why'
      : plan.resumeStage === 'conclude' ? 'conclude'
        : isRecovery ? 'recover-noop' : '';
  if (trigger) {
    st.run.recoverLog = (Array.isArray(st.run.recoverLog) ? st.run.recoverLog.slice() : [])
      .concat([{
        at: now,
        trigger,
        resumeStage: plan.resumeStage,
        invalidated: plan.invalidated.slice(),
        adopted: plan.adopted || '',
        /**
         * ★ 2026-10-23：`adoptWhy` 必须一起落盘。
         *   只把"没认领"记下来、不记"为什么没认领"，等于把静默跳过从"完全不响"改成"响一下就没影了"——
         *   事后审计要的是**磁盘上能查到的原因**，不是内存返回值。这条也顺便让"候选为 0 / 候选 >=2"
         *   两种情形在恢复日志里可区分（它们的产品含义完全不同：一个该重做，一个是证据冲突）。
         */
        adoptWhy: plan.adoptWhy || '',
        notes: notes.concat(plan.notes || []),
      }])
      .slice(-MAX_RECOVER_LOG);
  }
  notes.push(...(plan.notes || []));

  // ── 落盘（只有持有租约的写者才写；observer 一行都不写）
  if (store.mode === 'owner') store.save(st.run, { lease: st.lease });

  stats.opens += 1;
  return {
    mode: store.mode,
    run: st.run,
    resumeStage: plan.resumeStage,
    plan,
    store,
    notes,
    corruptSavedAs,
    /**
     * 三态读数（`{total, refuted, stale, none, states}`）。stale **单独计数**，
     * 既不算 refuted 也不算"正常" —— 老板要求的正是"这两种东西不是一回事"。
     */
    refuteSummary,
    /** 本次新产生的降级事件（同时已并入 `run.refuteEvents` 落盘） */
    refuteEvents: Array.isArray(st.run.refuteEvents) ? st.run.refuteEvents.slice() : [],
  };
}

function makeStore(st, info) {
  const self = {
    taskId: String(st.taskId || ''),
    file: st.file,
    mode: info.mode,
    persistence: info.persistence,
    epoch: Number(info.epoch) || 0,
    owner: String(info.owner || ''),
    stats: { writes: 0, leaseLost: 0, lastError: '' },
    save(run, extra) { return saveWithStore(self, st, run, extra); },
    release(run, extra) { return releaseWithStore(self, st, run, extra); },
    /**
     * 记一条**已证伪**（跨请求禁令）并立刻落盘。
     *
     * ★ 为什么语义接口长这样、而不是把 `recordRefuted` 直接扔给 backend：
     *   `workflowState` 是跨请求状态的**唯一 fs 写者**（一任务一文件 / 原子写 / 写前核对租约 epoch）。
     *   backend 若自己去碰文件，那三条边界同时失效。所以这里只暴露"记一条证伪"这个**语义**，
     *   不暴露路径、不暴露 merge 细节。
     * ★ 为什么必须**立刻落盘**：与 `noteAttempt` 同一条理由 —— 老板第 5 条挑战是"执行到一半中断"，
     *   收尾统一写 ⇒ **恰恰在最需要它的那种中断里一个字节都没写下去**。
     * ★ 旁观者（observer / read-only）一律不写：那不是我的账。
     *
     * @param {{sig:string, tool?:string, errorText?:string, exitCode?:(number|null),
     *          files?:string[], paramKeys?:string[], mode?:string, at?:number,
     *          count?:number, lastKind?:string, nextAction?:string, lastError?:string}} one
     *        ★ 通常由 `toolProtocol.refuteDecision(...)` 产出（判定点在那边，这里只负责落账）
     * @returns {{ok:boolean, reason?:string, sig?:string, files?:string[], attempts?:Array<object>}}
     *   `attempts` = 落账后的**完整账本**（供调用方同步自己手里的 run，避免"两份账"）
     */
    refute(one) {
      if (self.mode !== 'owner' || self.persistence === 'read-only') {
        return { ok: false, reason: self.persistence === 'read-only' ? 'state_newer_schema' : 'not_owner' };
      }
      const a = (one && typeof one === 'object' && !Array.isArray(one)) ? one : null;
      if (!a || !a.sig) return { ok: false, reason: 'sig_required' };
      try {
        const prev = Array.isArray(st.run.attempts) ? st.run.attempts : [];
        const next = recordRefuted(prev, a, { now: clock() });
        st.run = { ...st.run, attempts: next };
        const w = self.save(st.run);
        const rec = next.find((x) => String(x.sig || '') === String(a.sig));
        if (!w || w.ok !== true) {
          return { ok: false, reason: String((w && w.reason) || 'save_failed'), sig: String(a.sig), attempts: next };
        }
        return {
          ok: true,
          sig: String(a.sig),
          files: (rec && rec.refutedScope && Array.isArray(rec.refutedScope.files)) ? rec.refutedScope.files.slice() : [],
          attempts: next,
        };
      } catch (e) {
        return { ok: false, reason: 'refute_failed: ' + String((e && e.message) || e) };
      }
    },
    /**
     * 解除证伪（"这个方法现在能用了"）并立刻落盘。
     *
     * ★ 唯一可信的解除证据是**真的成功了** —— 所以调用点在成功出口，不在别处。
     * ★ 匹配口径：`sig` 或 `tool` 任一命中即解除（见 `clearRefuted` 头注：清除比保留安全）。
     *
     * @param {{sig?:string, tool?:string}} one
     * @returns {{ok:boolean, reason?:string, cleared:number, attempts?:Array<object>}}
     *   `cleared` = 本次真的解除了几条（0 ⇒ 没写盘，正常路径零额外 I/O）
     */
    unrefute(one) {
      if (self.mode !== 'owner' || self.persistence === 'read-only') {
        return { ok: false, reason: self.persistence === 'read-only' ? 'state_newer_schema' : 'not_owner', cleared: 0 };
      }
      const a = (one && typeof one === 'object' && !Array.isArray(one)) ? one : {};
      const sig = String(a.sig || '').trim();
      const tool = String(a.tool || '').trim();
      if (!sig && !tool) return { ok: false, reason: 'sig_or_tool_required', cleared: 0 };
      try {
        const prev = Array.isArray(st.run.attempts) ? st.run.attempts : [];
        const next = clearRefuted(prev, sig, { tool, now: clock() });
        // 没有任何一条真被解除 ⇒ 不写盘（避免"每次成功都摸一次文件"）
        let cleared = 0;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i] && prev[i].refuted === true && next[i] && next[i].refuted !== true) cleared += 1;
        }
        if (!cleared) return { ok: true, cleared: 0, attempts: prev };
        st.run = { ...st.run, attempts: next };
        const w = self.save(st.run);
        if (!w || w.ok !== true) {
          return { ok: false, reason: String((w && w.reason) || 'save_failed'), cleared: 0, attempts: next };
        }
        return { ok: true, cleared, attempts: next };
      } catch (e) {
        return { ok: false, reason: 'unrefute_failed: ' + String((e && e.message) || e), cleared: 0 };
      }
    },
    /**
     * 主动给产物拍指纹（backend 在 build/validate 之后调用最合适）。
     *
     * ⚠️ 它**只改内存里的 `st.run`，不落盘** —— 调用方必须紧跟一次 `save()`，
     *    否则这次拍摄会静默丢失（本仓实测过：`conclude()` 里调完就被下一次 save 的空 map 盖掉，
     *    见 `sanitizeIncomingRun` 的长注）。F1 之后空 map 不再覆盖，但"要 save"这条仍然成立。
     *
     * @param {string[]} [paths] 要拍的产物（缺省 = `st.run.artifacts`）
     * @param {{inspections?:object}} [opts] `inspections[p] = {slideCount,openable}`：
     *        调用方已经解析过这份 pptx 时传进来，免得同一个文件被读两遍 zip
     *        （`conclude()` 里本来就有 `inspections`，见 backend 的 F2 调用点）
     * @returns {object} 新的指纹 map
     */
    fingerprint(paths, opts) {
      const o = opts || {};
      const list = (Array.isArray(paths) ? paths : (st.run.artifacts || []))
        .filter((p) => typeof p === 'string' && /\.pptx$/i.test(p));
      const f = fsx();
      const seen = (o.inspections && typeof o.inspections === 'object') ? o.inspections : {};
      const fp = { ...(st.run.artifactFingerprint || {}) };
      for (const p of list) {
        try {
          const stt = f.statSync(p);
          const cached = seen[p];
          let slideCount = 0;
          if (cached && cached.openable === true && cached.slideCount !== undefined) {
            slideCount = Number(cached.slideCount) || 0;
          } else if (cached && cached.openable === false) {
            slideCount = 0;
          } else {
            const info2 = workflowRunner.inspectPptx(f.readFileSync(p));
            slideCount = Number(info2.slideCount) || 0;
          }
          fp[p] = { size: Number(stt.size) || 0, mtimeMs: Number(stt.mtimeMs) || 0, slideCount };
        } catch { /* 拍不到就留空，validate 会因此判"无法复核" */ }
      }
      st.run.artifactFingerprint = pruneFingerprintKeys(fp, Array.isArray(paths) ? paths : st.run.artifacts);
      return st.run.artifactFingerprint;
    },
  };
  return self;
}

/**
 * 把调用方交进来的 run 收干净（**F1 · 2026-10-28**）。
 *
 * 为什么必须有这一步（真读数）：`normalize()` 会给**每一份** run 塞一个自有键
 * `artifactFingerprint: {}`（见 normalize 的返回值）。backend 把 open() 交出来的那份
 * 缓存在自己的 `state.run` 里，之后每次 `store.save(state.run)` / `store.release(state.run, …)`
 * 都把这个**空 map** 带回来 ⇒ `st.run = { ...st.run, ...merged }` 会把已经拍好的指纹**整体盖掉**。
 * 实测写序（instrument `memoryStore.atomicWrite`，5 页真 pptx 夹具）：
 *
 *     write#1   fpKeys=0     （open：还没入账）
 *     write#2   fpKeys=0     （markBuild）
 *     write#3   fpKeys=1     ← `saveWithStore` 的补拍在工作
 *     write#4   fpKeys=0     ← `releaseWithStore` 用空 map 盖掉（租约已清 = 这一步是 release）
 *
 * 两条写盘路径都有 `st.run = { ...st.run, ...merged }`，但 `saveWithStore` 紧跟着在下面**又补拍了一次**
 * （`if (fp[p]) continue` ⇒ 只补缺、不刷新），自己把覆盖掩盖住了；`releaseWithStore` 没有补拍
 * ⇒ 盘上恒为 `{}` ⇒ `workflowRunner.fingerprintProblems()` 的第一条分支
 * 「没有指纹记录（无法复核 ⇒ 不许当已验收）」对**每一份**产物恒真 ⇒ `validate` 及之后每次续跑都被作废。
 *
 * 口径（三条，缺一条这条守卫就会变形）：
 *   ① **只忽略空 map**，不忽略"没有这个键"（后者本来就该保持原状），更不忽略非空 map
 *      （非空是调用方在表达意见，必须原样采用 —— 那可能是"刚拍的新值"）；
 *   ② 全仓 `artifactFingerprint` 的写入点逐个看过（normalize / buildStateDoc / 恢复段 /
 *      `fingerprint()` / `saveWithStore` 补拍），**没有任何一处是"故意清空指纹"**
 *      ⇒ "空 map 一律不表达意见"不会吃掉任何一个真实意图；
 *   ③ 返回**浅拷贝**，绝不删调用方对象上的键（`state.run` 与 store 内部是同一份引用，
 *      就地删会改到别人的账）。
 *
 * @param {object} run 调用方交进来的账
 * @returns {object} 可以安全并入 st.run 的一份
 */
function sanitizeIncomingRun(run) {
  const merged = Object.assign({}, run || {});
  const fp = merged.artifactFingerprint;
  if (fp && typeof fp === 'object' && !Array.isArray(fp) && Object.keys(fp).length === 0) {
    delete merged.artifactFingerprint;
  }
  return merged;
}

/** 指纹的键只跟着 artifacts 走（`artifacts` 有 MAX_ARTIFACTS=20 上限，指纹的键没有 —— 会缓慢膨胀）。就地改 `fp`。 */
function pruneFingerprintKeys(fp, artifacts) {
  const keep = new Set((Array.isArray(artifacts) ? artifacts : []).filter((p) => typeof p === 'string' && p));
  if (!keep.size) return fp;      // ⚠️ artifacts 为空时**不剪**：那可能是"还没入账"，不是"都不要了"
  for (const k of Object.keys(fp)) {
    if (!keep.has(k)) delete fp[k];
  }
  return fp;
}

/**
 * 写状态（store 作用域）。三道闸：只读 → 租约 → 回读比对 epoch。
 * @returns {{ok:boolean, reason?:string, why?:string, bytes?:number}}
 */
function saveWithStore(store, st, run, extra) {
  const now = clock();
  if (store.persistence === 'read-only') {
    return { ok: false, reason: 'state_newer_schema', why: '状态文件由更新版本写入 ⇒ 本次只读，不回写' };
  }
  if (store.mode !== 'owner') {
    store.stats.leaseLost += 1;
    stats.leaseLost += 1;
    return { ok: false, reason: 'lease_lost', why: '本次是 observer（没有租约）⇒ 不写盘' };
  }
  const cur = readStateRaw(store.file);
  if (cur.kind !== 'ok') {
    store.stats.lastError = 'state_unreadable: ' + cur.kind;
    return { ok: false, reason: 'state_unreadable' };
  }
  const curLease = cur.obj && cur.obj.lease;
  const stillMine = ownsNow(curLease, store, now);
  if (!stillMine) {
    store.stats.leaseLost += 1;
    stats.leaseLost += 1;
    return { ok: false, reason: 'lease_lost', why: '回读到的租约 epoch/owner 不是本次持有者 ⇒ 被别的执行者接管了' };
  }

  const merged = sanitizeIncomingRun(run);
  st.run = { ...st.run, ...merged, lastUpdated: now };
  // 缺指纹的产物补拍一次（已有指纹不刷新：它必须是"验收通过那一刻"的快照）
  const fp = { ...(st.run.artifactFingerprint || {}) };
  for (const p of (Array.isArray(st.run.artifacts) ? st.run.artifacts : [])) {
    if (!/\.pptx$/i.test(String(p)) || fp[p]) continue;
    try {
      const f = fsx();
      const stt = f.statSync(p);
      const info = workflowRunner.inspectPptx(f.readFileSync(p));
      fp[p] = { size: Number(stt.size) || 0, mtimeMs: Number(stt.mtimeMs) || 0, slideCount: Number(info.slideCount) || 0 };
    } catch { /* 拍不到就留空 ⇒ validate 判"无法复核" */ }
  }
  // 键只跟着 artifacts 走（见 pruneFingerprintKeys 的说明；artifacts 为空时不剪）
  st.run.artifactFingerprint = pruneFingerprintKeys(fp, st.run.artifacts);

  const lease = {
    owner: store.owner,
    pid: process.pid,
    host: HOST,
    epoch: store.epoch,
    expiresAt: now + LEASE_TTL_MS,
    taskId: store.taskId,
  };
  st.lease = lease;
  const res = writeStateFile(store.file, clipState(buildStateDoc(st, { lease })));
  if (res.ok) {
    store.stats.writes += 1;
    stats.writes += 1;
  } else {
    store.stats.lastError = res.reason || 'write_failed';
  }
  return res;
}

/**
 * 收尾：终态写进状态文件 + 清租约（**不删文件** —— 下次请求还要靠它恢复）。
 * 注意：只写状态文件，**绝不写 tasks.json / task_end**（那由 backend 的 finalizeTask 单独派生）。
 */
function releaseWithStore(store, st, run, extra) {
  const e = extra || {};
  if (store.persistence === 'read-only') return { ok: false, reason: 'state_newer_schema' };
  if (store.mode !== 'owner') {
    store.stats.leaseLost += 1;
    return { ok: false, reason: 'lease_lost' };
  }
  const cur = readStateRaw(store.file);
  const curLease = (cur.kind === 'ok' && cur.obj && cur.obj.lease) ? cur.obj.lease : null;
  if (!ownsNow(curLease, store, clock())) {
    store.stats.leaseLost += 1;
    return { ok: false, reason: 'lease_lost' };
  }
  // ★ F1：空 map 不表达意见（否则 release 会把 saveWithStore 补拍出来的指纹整体盖掉，见 sanitizeIncomingRun）
  const merged = sanitizeIncomingRun(run);
  st.run = { ...st.run, ...merged };
  st.run.status = STATUSES.includes(e.status) ? e.status
    : (STATUSES.includes(merged.status) ? merged.status : 'completed');
  if (typeof e.verdict === 'string' && e.verdict) st.run.verdict = e.verdict;
  if (typeof e.verdictSummary === 'string' && e.verdictSummary) st.run.verdictSummary = e.verdictSummary.slice(0, 300);
  st.run.lastUpdated = clock();
  st.lease = null;
  const res = writeStateFile(store.file, clipState(buildStateDoc(st, { lease: null })));
  HELD.delete(store.taskId);
  STORES.delete(store.taskId);
  if (res.ok) {
    store.stats.writes += 1;
    stats.writes += 1;
  }
  return res;
}

/** 模块级 save（按 run.taskId 或 extra.taskId 找到本次 store；没有则拒绝） */
function save(run, extra) {
  const e = extra || {};
  const taskId = String(e.taskId || (run && run.taskId) || '');
  const store = STORES.get(taskId);
  if (!store) return { ok: false, reason: 'no_store', why: '没有对应 taskId 的 store（先 open）' };
  return store.save(run, e);
}

/** 模块级 release */
function release(run, extra) {
  const e = extra || {};
  const taskId = String(e.taskId || (run && run.taskId) || '');
  const store = STORES.get(taskId);
  if (!store) return { ok: false, reason: 'no_store' };
  return store.release(run, e);
}

/** 按 mtime 清理超期状态文件（不会删 .corrupt-* / .tmp* 以外的正常文件之外的东西） */
function prune(opts) {
  if (!isEnabled()) return { ok: false, reason: 'disabled', removed: 0 };
  const keepDays = (opts && Number(opts.keepDays) > 0) ? Number(opts.keepDays) : KEEP_DAYS;
  const f = fsx();
  const cut = clock() - keepDays * 24 * 3600 * 1000;
  let removed = 0;
  let names = [];
  try { names = f.readdirSync(root); } catch { return { ok: false, reason: 'readdir_failed', removed: 0 }; }
  for (const n of names) {
    if (!/\.json$/.test(String(n))) continue;      // .tmp / .corrupt-* 一律不动（留证据 / 不留半截）
    const p = path.join(root, String(n));
    try {
      const stt = f.statSync(p);
      if (Number(stt.mtimeMs) < cut) { f.unlinkSync(p); removed += 1; }
    } catch { /* 单个文件失败不影响其它 */ }
  }
  stats.prunes += 1;
  return { ok: true, removed, keepDays };
}

module.exports = {
  // 生命周期
  init,
  isEnabled,
  pathOf,
  safeName,
  // 主流程
  open,
  save,
  release,
  prune,
  // 内部（供门禁做定点验证）
  collectEvidence,
  normalize,
  normalizeAttempts,
  mergeAttempts,
  // ===== refuted 三态（证据 / 适用范围 / 代码版本）=====
  recordRefuted,
  clearRefuted,
  auditRefuted,
  summarizeRefute,
  effectiveAttempts,
  refuteScope,
  // 适用范围的两类来源（store.refute 的调用方通常由 toolProtocol.refuteDecision 算，这里也导出便于单独验证）
  implFilesFor: refuteScope.implFilesFor,
  dataFilesFor: refuteScope.dataFilesFor,
  __normalize,
  __setRoot,
  __reset,
  __setFs,
  __setClock,
  __stats,
  SCHEMA_VERSION,
  LEASE_TTL_MS,
  KEEP_DAYS,
  MAX_ATTEMPTS,
  MAX_REFUTE_EVENTS,
  REFUTED_ERROR_MAX,
};
