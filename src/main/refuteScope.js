/**
 * refuteScope —— 「refuted（已证伪）」这个判定的**唯一真源**：证据 / 适用范围 / 代码版本。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个模块要修的病（老板原话）
 * ═══════════════════════════════════════════════════════════════════════════
 *   「一次工具执行失败，不等于"某个根因假设已经被证伪"；一次调查暂时找不到证据，
 *     也不等于"假设为假"。」
 *   「`refuted` 要记证据、适用范围/代码版本，否则代码变了旧假设仍被无条件跳过。」
 *
 * 修之前的事实：账本里只有一个布尔 `refuted`，没有任何证据、范围、版本。于是
 * **代码早已修好，账本里还记着"这方法不行"** ⇒ 一次历史失败被固化成了永久禁令。
 *
 * 本模块给出三态判定（**不许把 stale 折成 refuted，也不许折成 pass**）：
 *   · `refuted` —— 有证据、有范围、且范围里每个文件的**内容 sha1 与记账时逐字相同**
 *                 ⇒ 代码没变 ⇒ 这个否定结论仍然成立 ⇒ 允许跳过。
 *   · `stale`   —— 记账时声称已证伪，但**无法证明代码没变**（文件变了 / 没版本 / 没范围）
 *                 ⇒ **降级：不跳过、允许重试**，并留下 `refutedStale` 事件（点名是哪个文件变了）。
 *   · `none`    —— 这一条根本不是 refuted（或压根没这条账）。
 *
 * 为什么 stale 必须包括「旧格式记录（无 refutedCodeVersion）」和「scope.files 为空」：
 *   这两种情形的共同点是**拿不出"代码没变"的证据**。拿不出证据就不能当禁令 ——
 *   否则旧账本里大量无版本的 refuted 会继续吃老本，正是本次要根治的那个病。
 *
 * 纪律：
 *   ① 本模块**只读**文件系统（读源码算 sha1），不写任何文件、不改任何状态；
 *   ② 不依赖 workflowState / toolProtocol（两者都 require 本模块 ⇒ 必须无环）；
 *   ③ 文件读不到（不存在 / 无权限）一律按 `''` 参与比对 ⇒ 与记账时的 sha1 不等 ⇒ stale
 *      （"证明不了没变"就只能认它变了 —— 保守方向必须偏向**允许重试**）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 2026-02-16 语义纠正（team-lead 指出，原实现理解错了，必须记在这里防复发）
 * ═══════════════════════════════════════════════════════════════════════════
 * `refutedScope.files` 的语义是「**什么变了会让这条禁令不再成立**」，
 * **不是**「这次失败涉及哪些数据文件」。两者搞混会让机制在**最常见的场景下必然失效**：
 *
 *   反例（原实现的洞）：`file-write` 因 `precondition_error`（目录不存在）失败 3 次 ⇒ 记 refuted，
 *   `files` 记成目标数据路径 `out/deck.pptx`。之后**代码修好了**（file-write 现在会自动建目录），
 *   但 `out/deck.pptx` 这个路径没变、内容也没变 ⇒ 版本比对全部一致 ⇒ 禁令继续生效
 *   ⇒ **永远不再试一个已经能用的办法**。这正是老板要防的那个病，只是从「代码变了还跳」
 *   变成了「代码变了还跳、且检测不到」—— 更糟，因为它看起来在工作。
 *
 * 所以 `files` 只收两类，且顺序固定：
 *   ① **工具/技能的实现文件**（必须，静态可定）：`skills/<tool>/manifest.json` + 它的入口文件
 *      （js 默认 `run.js`、python 用 manifest 的 `entry`）+ 分发层 `src/main/skills.js`。
 *      见 `implFilesFor()` —— 由它算，调用方**不许自己猜**。
 *   ② **目标数据文件**（可选，仅在失败原因**明确指向某个具体文件**时才加）：见 `dataFilesFor()`。
 *      取不到就不加 —— **不许猜**。猜错的方向是"多了一条会让禁令平白失效的路径"，
 *      会让一个真禁令被无故作废（噪声），比漏一条更糟。
 *
 * 两条推论，写在这里免得后人当 bug 修：
 *   · `implFilesFor()` 返回空数组是**合法且正确**的：说明"我连它有哪份实现都说不出来"
 *     ⇒ 拿不出"代码没变"的证据 ⇒ 判定侧自动 stale ⇒ 允许重试。这是保守方向。
 *   · 同一份实现文件被多个工具共用（`src/main/skills.js`）时，改它会让**所有**工具的禁令
 *     一起失效一次。这是刻意的：分发层改了，"这个方法为什么失败"的判据就可能变。
 *     代价是保守地多试几次，而不是错误地永久跳过。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 已知留白（不是漏项，别当 bug 修）
 * ═══════════════════════════════════════════════════════════════════════════
 *   `workflowState.open()` 在 `schemaVersion > SCHEMA_VERSION` 时**提前返回**（只读、不写盘、
 *   不抢租约），那条路径上**不做**本模块的三态复核。理由：那个文件是**更高版本的产品**写的，
 *   本版本不知道它怎么解释 `refuted`；按本版本的规则去猜、去降级，等于替未来版本做决定，
 *   猜错的危害（把一条真禁令悄悄作废 / 把一条作废的禁令偷偷生效）比"不复核"大得多。
 *   已经被更高版本写过的任务，其终态由那个版本负责。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * · `changedFiles` 元素形状是 { file, oldSha1, newSha1 }，与 `refutedScope.files`（字符串数组）
 *   和 attempts 条目的其他路径字段（`path`）命名不一致。判定侧消费时不要写成 `.path`
 *   （2026-10-23 lead 独立打靶时踩过，误判成"空指针真缺陷"）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 默认仓库根（本文件位于 `<root>/src/main/`）：相对路径一律相对它解析。 */
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/** @returns {string} 十六进制 sha1 */
function sha1Text(s) {
  return crypto.createHash('sha1').update(String(s === undefined || s === null ? '' : s), 'utf8').digest('hex');
}

/**
 * 把任意路径写法压成**稳定的比较键**：分隔符统一为 `/`；在 `root` 内的转成相对路径。
 * @param {string} p
 * @param {string} [root]
 * @returns {string}
 */
function toKey(p, root) {
  const base = String(root || DEFAULT_ROOT);
  const raw = String(p === undefined || p === null ? '' : p).trim();
  if (!raw) return '';
  let abs = raw;
  try { if (!path.isAbsolute(raw)) abs = path.resolve(base, raw); } catch { abs = raw; }
  let rel = abs;
  try { rel = path.relative(base, abs); } catch { rel = abs; }
  const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const key = inside ? rel : abs;
  return key.replace(/\\/g, '/');
}

/** 把比较键还原成可读写的绝对路径 */
function absOf(key, root) {
  const base = String(root || DEFAULT_ROOT);
  const raw = String(key === undefined || key === null ? '' : key).trim();
  if (!raw) return '';
  try { return path.isAbsolute(raw) ? raw : path.resolve(base, raw); } catch { return raw; }
}

/**
 * 读一个文件的**内容 sha1**。读不到 ⇒ `''`（不是抛错：一条账读不出源码不该让整次运行崩）。
 * @param {string} p 相对（相对 root）或绝对路径
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts] readFile 可注入（门禁/沙箱用）
 * @returns {string} 40 位十六进制，或 ''（文件不存在 / 读失败）
 */
function sha1OfFile(p, opts) {
  const o = opts || {};
  const abs = absOf(p, o.root);
  if (!abs) return '';
  let buf = null;
  try {
    buf = typeof o.readFile === 'function' ? o.readFile(abs) : fs.readFileSync(abs);
  } catch { return ''; }
  if (buf === undefined || buf === null) return '';
  try {
    return crypto.createHash('sha1').update(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')).digest('hex');
  } catch { return ''; }
}

/**
 * 为一组文件算 `{ [比较键]: sha1 }`。
 *
 * ★ 只收录**存在的**文件（读不到的 sha1 是 ''，收进版本表等于给出一条无意义的证据）。
 *   后果正是我们要的：记账时不存在、现在存在 ⇒ 版本表里没有它 ⇒ 比对不等 ⇒ stale。
 *
 * @param {string[]} files
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts]
 * @returns {Object<string,string>}
 */
function sha1MapOf(files, opts) {
  const out = {};
  const list = Array.isArray(files) ? files : [];
  for (const f of list) {
    if (typeof f !== 'string' || !f.trim()) continue;
    const key = toKey(f, (opts || {}).root);
    if (!key) continue;
    const h = sha1OfFile(key, opts);
    if (h) out[key] = h;
  }
  return out;
}

/**
 * 判定一条账的 refuted 到底还算不算数。
 *
 * @param {object} attempt 账本条目
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts]
 * @returns {{state:'none'|'refuted'|'stale',
 *            reasons:Array<{code:string, file?:string, oldSha1?:string, newSha1?:string, detail?:string}>,
 *            changedFiles:Array<{file:string, oldSha1:string, newSha1:string}>}}
 *   `changedFiles` 只收**内容 sha1 真的对不上**的文件（含"记账时不存在 / 现在不存在"），
 *   `reasons` 收全部降级原因（含结构性原因：没范围、没版本…）。
 */
function judgeRefute(attempt, opts) {
  const o = opts || {};
  const a = (attempt && typeof attempt === 'object') ? attempt : {};
  const res = { state: 'none', reasons: [], changedFiles: [] };
  if (a.refuted !== true) return res;   // 不是 refuted ⇒ 没有"要不要降级"这回事

  const stale = (code, extra) => { res.state = 'stale'; res.reasons.push({ code, ...(extra || {}) }); };

  // ① 适用范围：必须是显式的对象，`files` 必须是**显式数组**（空数组合法，但一定要是数组）
  const scope = (a.refutedScope && typeof a.refutedScope === 'object' && !Array.isArray(a.refutedScope))
    ? a.refutedScope : null;
  if (!scope) {
    stale('scope-missing', { detail: 'refutedScope 缺失或类型不对 ⇒ 无法界定适用范围 ⇒ 不能当禁令' });
    return res;
  }
  const filesRaw = scope.files;
  if (!Array.isArray(filesRaw)) {
    stale('scope-files-not-array', { detail: 'refutedScope.files 不是数组（' + typeof filesRaw + '）⇒ 无法界定适用范围' });
    return res;
  }
  const files = filesRaw.filter((x) => typeof x === 'string' && x.trim()).map((x) => toKey(x, o.root));
  if (files.length === 0) {
    stale('scope-files-empty', { detail: 'refutedScope.files 为空 ⇒ 无法证明"代码没变" ⇒ 不能当禁令' });
    // 继续往下判版本，好让事件里能同时说清"连版本也没有"
  }

  // ② 代码版本：旧格式（无 refutedCodeVersion）一律 stale —— 这条是本次的核心
  const verRaw = a.refutedCodeVersion;
  const ver = (verRaw && typeof verRaw === 'object' && !Array.isArray(verRaw)) ? verRaw : null;
  if (!ver) {
    stale('code-version-missing', { detail: '记账时没记代码版本（旧格式记录）⇒ 无法证明代码没变 ⇒ 自动失效一次' });
    return res;
  }
  if (Object.keys(ver).length === 0) {
    stale('code-version-empty', { detail: 'refutedCodeVersion 是空表 ⇒ 拿不出任何"代码没变"的证据' });
  }

  // ③ 逐文件比对内容 sha1：任何一条不一致 ⇒ stale，并点名是哪个文件变了（旧值 / 新值都要留）
  for (const key of files) {
    const expected = typeof ver[key] === 'string' ? ver[key] : '';
    const actual = sha1OfFile(key, o);
    if (expected === actual) continue;
    res.state = 'stale';
    res.changedFiles.push({ file: key, oldSha1: expected, newSha1: actual });
    res.reasons.push({
      code: expected ? (actual ? 'file-changed' : 'file-missing-now')
        : (actual ? 'file-appeared' : 'file-never-hashed'),
      file: key,
      oldSha1: expected,
      newSha1: actual,
      detail: '记账时 sha1=' + (expected || '(未记录)') + '，当前 sha1=' + (actual || '(读不到)')
        + ' ⇒ 代码已变 ⇒ 旧假设不再成立，允许重试',
    });
  }

  // 三态定稿：有任何一条理由 ⇒ stale；一条理由都没有 ⇒ 这个否定结论仍然成立
  res.state = res.reasons.length ? 'stale' : 'refuted';
  return res;
}

/**
 * 把判定摊平成调用方要的读法（`refuted` 与 `stale` **互斥且都可能是 false**）。
 * @param {object} attempt
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts]
 */
function projectRefute(attempt, opts) {
  const a = (attempt && typeof attempt === 'object') ? attempt : {};
  const j = judgeRefute(a, opts);
  return {
    state: j.state,
    refuted: j.state === 'refuted',
    stale: j.state === 'stale',
    reasons: j.reasons,
    changedFiles: j.changedFiles,
    refutedEvidence: a.refutedEvidence || null,
    refutedScope: a.refutedScope || null,
    refutedCodeVersion: a.refutedCodeVersion || null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 适用范围：**实现文件**（静态可定）与**目标数据文件**（只在明确指向时才收）
// ───────────────────────────────────────────────────────────────────────────

/** 技能实现的根目录（相对仓库根）。与 `src/main/skills.js` 的扫描口径必须一致。 */
const SKILLS_REL = 'skills';
/** 分发层：所有技能调用都经过它 ⇒ 它变了，"这个方法为什么失败"的判据就可能变。 */
const DISPATCHER_REL = 'src/main/skills.js';

/**
 * 读技能 manifest（只读、失败返回 null）。用于静态确定"入口文件是哪一份"。
 * @param {string} tool 工具/技能名
 * @param {{root?:string, readFile?:(abs:string)=>any, exists?:(abs:string)=>boolean}} [opts]
 * @returns {object|null}
 */
function readSkillManifest(tool, opts) {
  const o = opts || {};
  const name = String(tool === undefined || tool === null ? '' : tool).trim();
  if (!name) return null;
  const rel = SKILLS_REL + '/' + name + '/manifest.json';
  const abs = absOf(rel, o.root);
  let text = '';
  try {
    const buf = typeof o.readFile === 'function' ? o.readFile(abs) : fs.readFileSync(abs);
    if (buf === undefined || buf === null) return null;
    text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  } catch { return null; }
  try {
    const obj = JSON.parse(text);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch { return null; }
}

/**
 * 一个工具/技能的**实现文件清单**（相对仓库根，只收真实存在的）。
 *
 * 这是 `refutedScope.files` 的主来源：判"这个办法还行不行"，首先要看**实现它的代码变没变**。
 * 静态可定，不猜参数 —— 这也是它敢被自动写进账本的原因。
 *
 * 收录规则（顺序固定，便于审计）：
 *   1. `skills/<tool>/manifest.json`（声明：必填参数、超时、运行时…）
 *   2. 入口文件：`runtime === 'python'` ⇒ manifest `entry`（默认 `run.py`）；
 *      `runtime === 'command'` ⇒ 无入口文件（系统命令，按 manifest 判定）；其余 ⇒ `run.js`
 *   3. `src/main/skills.js`（分发层）—— 仅在**确实找到了该技能的实现**时才加，
 *      否则"工具名根本不存在"这件事会和"分发层变了"混在一起，事件里说不清。
 *
 * @param {string} tool
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts]
 * @returns {string[]} 可能是空数组（= 说不清实现在哪 ⇒ 判定侧 stale ⇒ 允许重试，保守方向正确）
 */
function implFilesFor(tool, opts) {
  const o = opts || {};
  const name = String(tool === undefined || tool === null ? '' : tool).trim();
  if (!name) return [];
  // 只在**合法技能名**上查：`skills.js` 的目录名不含路径分隔符，含了就一定不是技能名
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return [];
  const out = [];
  const push = (rel) => { if (rel && out.indexOf(rel) < 0) out.push(rel); };
  const manifestRel = SKILLS_REL + '/' + name + '/manifest.json';
  if (sha1OfFile(manifestRel, o)) push(manifestRel);
  const man = readSkillManifest(name, o);
  const runtime = (man && typeof man.runtime === 'string') ? man.runtime : 'js';
  if (runtime === 'python') {
    const entry = (man && typeof man.entry === 'string' && man.entry.trim()) ? man.entry.trim() : 'run.py';
    // 入口名可能带子目录；只接受不含 `..` 的相对名（防 manifest 被写成 ../../etc/passwd）
    if (!entry.startsWith('/') && !entry.includes('..') && !/^[A-Za-z]:/.test(entry)) {
      const entryRel = SKILLS_REL + '/' + name + '/' + entry.replace(/\\/g, '/');
      if (sha1OfFile(entryRel, o)) push(entryRel);
    }
  } else if (runtime !== 'command') {
    const runRel = SKILLS_REL + '/' + name + '/run.js';
    if (sha1OfFile(runRel, o)) push(runRel);
  }
  // 分发层：只有"确实找到了这个技能的实现"才收 —— 见上方 3
  if (out.length && sha1OfFile(DISPATCHER_REL, o)) push(DISPATCHER_REL);
  return out;
}

/**
 * 失败原因**明确指向**某个具体数据文件时，把它也纳入范围（可选、不许猜）。
 *
 * 什么时候算"明确指向"：
 *   · `args.path` 是可 resolve 的路径（`file-write` / `file-read` / `file-list` 这类单文件工具），**且**
 *   · 失败类型是 `path_error` / `precondition_error`（"这个路径不行"就是失败本身）
 *     —— 其余类型（参数截断、上游 5xx、超时）与"哪个数据文件"无关，加了只会让禁令平白失效。
 *
 * ★ 这条**刻意做得极窄**：多收一条路径的代价是"一个真禁令被无故作废"（噪声，让人不再相信它），
 *   比漏一条严重。取不到就返回 `[]`。
 *
 * @param {{tool?:string, params?:object, kind?:string}} o
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts]
 * @returns {string[]}
 */
function dataFilesFor(o, opts) {
  const s = (o && typeof o === 'object') ? o : {};
  const kind = String(s.kind || '');
  if (kind !== 'path_error' && kind !== 'precondition_error') return [];
  const params = (s.params && typeof s.params === 'object' && !Array.isArray(s.params)) ? s.params : {};
  const raw = params.path;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const key = toKey(raw, (opts || {}).root);
  if (!key) return [];
  // 只收**此刻真的存在**的文件：不存在的路径没有内容可算 sha1，收进来等于伪造证据
  if (!sha1OfFile(key, opts)) return [];
  return [key];
}

/**
 * 造一条 `refutedStale` 事件（落盘/落 trace 用）。**必须点名哪个文件变了 + 旧 sha1 + 新 sha1**。
 * @param {object} attempt
 * @param {object} judgement `judgeRefute` 的返回值
 * @param {number} now
 */
function makeStaleEvent(attempt, judgement, now) {
  const a = (attempt && typeof attempt === 'object') ? attempt : {};
  const j = (judgement && typeof judgement === 'object') ? judgement : { reasons: [], changedFiles: [] };
  const files = (a.refutedScope && Array.isArray(a.refutedScope.files)) ? a.refutedScope.files.slice(0, 20) : [];
  return {
    at: Number(now) > 0 ? Number(now) : Date.now(),
    kind: 'refutedStale',
    sig: String(a.sig || ''),
    tool: String(a.tool || ''),
    /** 为什么降级（结构性原因 + 逐文件原因，全部保留，便于事后审计） */
    reasons: Array.isArray(j.reasons) ? j.reasons.slice(0, 20) : [],
    /** 哪些文件的内容真的变了（旧 sha1 / 新 sha1）—— 这是"点名"的落点 */
    changedFiles: Array.isArray(j.changedFiles) ? j.changedFiles.slice(0, 20) : [],
    scopeFiles: files,
    /**
     * 证据原文的**短摘要**（不是全文）：事件是审计线索，全文在账本条目的 `refutedEvidence` 里。
     * 这里带一小段是为了"事件本身能读懂"，不为了让事件变成第二份证据存储。
     */
    evidenceErrorText: String((a.refutedEvidence && a.refutedEvidence.errorText) || '').slice(0, 200),
    codeVersion: (a.refutedCodeVersion && typeof a.refutedCodeVersion === 'object') ? a.refutedCodeVersion : {},
  };
}

/**
 * 三态汇总（门禁要求 stale **单独数出来**，不能折进 refuted 也不能折进"正常"）。
 * @param {Array<object>} attempts
 * @param {{root?:string, readFile?:(abs:string)=>any, now?:number}} [opts]
 * @returns {{total:number, refuted:number, stale:number, none:number,
 *            events:Array<object>, states:Object<string,string>}}
 */
function summarize(attempts, opts) {
  const o = opts || {};
  const now = Number(o.now) > 0 ? Number(o.now) : Date.now();
  const list = Array.isArray(attempts) ? attempts : [];
  const out = { total: list.length, refuted: 0, stale: 0, none: 0, events: [], states: {} };
  for (const a of list) {
    const j = judgeRefute(a, o);
    if (j.state === 'refuted') out.refuted += 1;
    else if (j.state === 'stale') { out.stale += 1; out.events.push(makeStaleEvent(a, j, now)); }
    else out.none += 1;
    const sig = String((a && a.sig) || '');
    if (sig) out.states[sig] = j.state;
  }
  return out;
}

/**
 * 给一组 attempts 出"**生效视图**"：stale 的 refuted 在这里被压成 `false`（不跳过、允许重试），
 * 但**原条目一个字都不改**（证据不能因为降级就被抹掉 —— 抹掉就再也无法复核）。
 *
 * @param {Array<object>} attempts
 * @param {{root?:string, readFile?:(abs:string)=>any}} [opts]
 * @returns {Array<object>} 浅拷贝的条目数组，每条多一个 `refuteState: 'refuted'|'stale'|'none'`
 */
function effectiveAttempts(attempts, opts) {
  const list = Array.isArray(attempts) ? attempts : [];
  return list.map((a) => {
    if (!a || typeof a !== 'object') return a;
    const p = projectRefute(a, opts);
    return { ...a, refuted: p.refuted, refuteState: p.state };
  });
}

module.exports = {
  DEFAULT_ROOT,
  SKILLS_REL,
  DISPATCHER_REL,
  sha1Text,
  toKey,
  absOf,
  sha1OfFile,
  sha1MapOf,
  judgeRefute,
  projectRefute,
  readSkillManifest,
  implFilesFor,
  dataFilesFor,
  makeStaleEvent,
  summarize,
  effectiveAttempts,
};
