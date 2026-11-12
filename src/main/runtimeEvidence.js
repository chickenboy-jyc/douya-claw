'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * 运行时验收证据账。
 *
 * 只有真实工具结果里的结构化记录能进入本账：browser-verify 的 verified/ok，
 * 或 shell-exec 输出中带固定 marker 的 JSON 行。HTTP 200、命令退出成功、
 * 文件非空以及助手自述都不是应用运行验收。
 */

const RUNTIME_MARKER = 'DOUYA_RUNTIME_ACCEPTANCE=';
const PASS_WORDS = new Set(['pass', 'passed', 'ok', 'success', 'complete', 'completed']);
const FAIL_WORDS = new Set(['fail', 'failed', 'error', 'rejected']);

function text(v) {
  return String(v == null ? '' : v).trim();
}

function list(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => typeof x === 'object' ? Object.assign({}, x) : String(x));
  if (v == null || v === '') return [];
  return [typeof v === 'object' ? Object.assign({}, v) : String(v)];
}

/** 整段能解析成对象才算数（数组/标量一律不认 —— 调用方要的都是字段表）。 */
function tryObject(str) {
  const t = text(str).trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

/**
 * 从工具结果里取出结构化对象。
 *
 * ★★ 2026-10-30（**真实缺陷，不是加固**）：真实工具的输出常常是「结构化 JSON 正文 + 一行 marker」
 *   两段（`desktop-verify` 就是：`JSON.stringify(out,null,2) + '\n' + DOUYA_RUNTIME_ACCEPTANCE={...}`），
 *   而 **marker 自己也是一段 JSON**。旧实现只有两条路：
 *     ① 整串 `JSON.parse` —— 尾部多了 marker，必失败；
 *     ② 取 first `{` … last `}` 切片 —— 从正文开头一直切到 **marker 的结尾**，拼出来是非法 JSON，也失败。
 *   于是 `desktopRecord` 拿到的 `j` 永远是 `null`，**每一次真实桌面验收都被记成
 *   「desktop-verify 没有返回可解析的结构化验收记录」**，连真跑通并导出了 PNG 的 PASS 也一样
 *   （实测：把 run.js 的真实返回直接喂进来，summary 恒为 `unverified:1`；单测之所以全绿，
 *    是因为它喂的是纯 JSON 字符串，从来没喂过生产环境真实形状 —— 这正是「门禁绿、产线死」的典型）。
 *   ⇒ 按 marker 切开、两段各自尝试；**正文优先**（`verified` / `ok` / `screenshots` / `resolved`
 *     只有正文有，marker 是紧凑结论），marker 兜底。两种先后顺序都支持（正文在前 / marker 在前）。
 */
function parseJson(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  const s = text(v);
  if (!s) return null;
  const whole = tryObject(s);
  if (whole) return whole;
  const idx = s.indexOf(RUNTIME_MARKER);
  if (idx >= 0) {
    const tailAll = s.slice(idx + RUNTIME_MARKER.length);
    const nl = tailAll.indexOf('\n');
    const markerLine = nl >= 0 ? tailAll.slice(0, nl) : tailAll;
    const afterBody = nl >= 0 ? tailAll.slice(nl + 1) : '';
    // 正文候选：marker 之前那一段 / marker 之后那一段（marker 在前时正文在后面）
    const body = tryObject(s.slice(0, idx)) || tryObject(afterBody);
    if (body) return body;
    const markerOnly = tryObject(markerLine);
    if (markerOnly) return markerOnly;
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  return tryObject(s.slice(a, b + 1));
}

function normalizePath(p) {
  return text(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

function extOf(p) {
  const m = normalizePath(p).match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

function uniqPaths(v) {
  const out = [];
  const seen = new Set();
  for (const x of list(v)) {
    const p = text(typeof x === 'object' ? (x.path || x.artifact || x.file) : x);
    const k = normalizePath(p);
    if (k && !seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

function artifactFacts(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const p = text(typeof item === 'object' ? item.path : item);
    if (!p) continue;
    const old = item && typeof item === 'object' ? item : {};
    let size = Number(old.size) || 0;
    let sha1 = text(old.sha1);
    try {
      const buf = fs.readFileSync(p);
      size = buf.length;
      sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    } catch { /* 历史证据只保留原 hash；新证据读不到字节就不能放行当前文件 */ }
    out.push({ path: p, size, sha1 });
  }
  return out;
}

function storedArtifactFacts(items) {
  return (Array.isArray(items) ? items : []).filter((x) => x && typeof x === 'object' && text(x.path))
    .map((x) => ({ path: text(x.path), size: Number(x.size) || 0, sha1: text(x.sha1) }));
}

function errorsOf(j, names) {
  const out = [];
  for (const name of names) {
    for (const x of list(j[name])) out.push(text(typeof x === 'object' ? (x.message || x.error || x.url || JSON.stringify(x)) : x));
  }
  return out.filter(Boolean);
}

function sha1OfFile(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; }
}

/**
 * 桌面窗口验收记录（desktop-verify）。
 *
 * 比 browser-verify **更严**，因为「桌面应用能跑」正是复杂交付里最容易自我欺骗的一环。
 * 这里的每一条都是实测踩过的假绿来源：
 *   ① 只报 launched，一条断言都没有 ⇒ 不能算通过（那是「进程起来了」不是「能用」）；
 *   ② 有未捕获异常（典型 TypeError: Cannot read properties of null）⇒ 直接 fail，
 *      因为用户点按钮必然踩到，海报基准三轮就是死在这里；
 *   ③ exported 里写的文件必须**真的在磁盘上**且字节数与声明一致 —— 否则就是编的；
 *   ④ verdict 说 pass 但断言里有 false ⇒ 以断言为准（失败断言优先）。
 */
function desktopRecord(params, result, at, userText) {
  const p = params && typeof params === 'object' ? params : {};
  const j = parseJson(result);
  // ★★ 2026-10-30：本体标识取「所有真实存在的候选」，不是二选一。
  //   为什么不能只取一个：Electron 源码形态下 `resolved.exe` 是解释器（node_modules/electron/dist/electron.exe），
  //   真正被验的应用本体是 `resolved.appArgs[0]`（main.js）；打包形态反过来 —— `appArgs` 为空、本体就是 exe。
  //   只认其中一个，必然在另一种形态下把真实通过判成「记录没关联到交付物」。
  //   ⇒ 逐项 stat，**只绑磁盘上确实存在且是文件**的路径；目录一律不绑
  //     （目录不是交付文件，绑了会让归属判据退化成「同目录即算」的放水）。
  const resolvedRaw0 = (j && j.resolved && typeof j.resolved === 'object' && !Array.isArray(j.resolved)) ? j.resolved : null;
  const candidates = [];
  if (resolvedRaw0) {
    candidates.push(text(resolvedRaw0.exe));
    for (const a of list(resolvedRaw0.appArgs)) candidates.push(text(a));
  }
  candidates.push(text(p.appPath));
  const bound = uniqPaths(candidates.filter((c) => {
    if (!c) return false;
    try { return fs.statSync(c).isFile(); } catch { return false; }
  }));
  // 交付本体类型：以**调用参数里那个 appPath** 为准（它就是用户眼里"这个工具"），
  // 参数没给才退回实际启动的可执行文件。绝不因为「exe 叫 electron.exe」就把源码应用判成 exe。
  const kindProbe = text(p.appPath) || text(resolvedRaw0 && resolvedRaw0.exe);
  const inferredKind = /\.exe$/i.test(kindProbe) ? 'exe' : 'app';
  const joinArtifacts = (extra) => uniqPaths(list(extra).concat(bound));

  if (!j) {
    return {
      tool: 'desktop-verify', kind: inferredKind, status: 'unverified', at,
      url: text(p.url || kindProbe), assertions: [], interactions: [], exported: [],
      screenshots: [], consoleErrors: [], pageErrors: [],
      artifactPaths: joinArtifacts([]),
      launched: false, verified: false, ok: false, verdict: 'unverified',
      resolved: null,
      unverifiedReason: 'desktop-verify 没有返回可解析的结构化验收记录',
      reason: 'desktop-verify 没有返回可解析的结构化验收记录',
      gaps: ['重跑桌面验收并返回结构化结论（launched/assertions/exported）'],
    };
  }
  const launched = j.launched === true;
  const verified = j.verified === true;
  const okFlag = j.ok === true;
  const verdict = text(j.verdict).toLowerCase();
  const assertions = list(j.assertions || j.checks);
  const interactions = list(j.interactions);
  const screenshots = list(j.screenshots || j.screenshot);
  const consoleErrors = errorsOf(j, ['consoleErrors']);
  const pageErrors = errorsOf(j, ['pageErrors']);
  const failedAssertions = assertions.filter((a) => a && typeof a === 'object'
    && (a.pass === false || a.ok === false || a.success === false || FAIL_WORDS.has(text(a.status).toLowerCase())));

  // 导出证据必须能在磁盘上核对；编出来的路径、0 字节、字节数对不上都不算证据。
  const exported = [];
  let exportProblem = '';
  for (const e of list(j.exported)) {
    const path0 = text(typeof e === 'object' ? (e.path || e.file) : e);
    if (!path0) continue;
    let st = null;
    try { st = fs.statSync(path0); } catch { st = null; }
    if (!st || !st.isFile() || st.size <= 0) {
      exportProblem = exportProblem || ('导出证据指向的文件不存在或是空文件：' + path0);
      continue;
    }
    const claimed = Number(e && typeof e === 'object' ? e.size : 0) || 0;
    if (claimed && claimed !== st.size) {
      exportProblem = exportProblem || ('导出证据声明的字节数与磁盘不符（声明 ' + claimed + ' / 实际 ' + st.size + '）：' + path0);
    }
    exported.push({ path: path0, size: st.size, sha1: sha1OfFile(path0) });
  }

  const needsExport = /(导出|海报)/.test(text(userText));
  // 「只启动了窗口就报 pass」不能算验收：至少要有一条真实交互或一件真实产物。
  const onlyLaunched = launched && !interactions.length && !exported.length
    && !assertions.some((a) => a && typeof a === 'object' && !['window-ready', 'no-pageerror'].includes(text(a.name)));

  let status = 'pass';
  let why = '';
  // 技能自己说「没验成」（unverified / 带 unverifiedReason）时以它为准：
  // 这时断言 false 反映的是「环境不允许检查」，不该升级成「产品证明有问题」。
  // 注意这不放水 —— unverified 同样不是 pass，只是归因不同。
  const selfSaysUnverified = verdict === 'unverified' || !!text(j.unverifiedReason);
  if (selfSaysUnverified) { status = 'unverified'; why = text(j.unverifiedReason || j.reason) || '桌面验收没有完成检查'; }
  else if (verdict === 'fail' || FAIL_WORDS.has(verdict) || okFlag === false) { status = 'fail'; why = text(j.reason) || '桌面验收自报失败'; }
  else if (failedAssertions.length) { status = 'fail'; why = text(failedAssertions[0].detail || failedAssertions[0].reason || failedAssertions[0].name); }
  else if (pageErrors.length) { status = 'fail'; why = '渲染进程有未捕获异常：' + pageErrors[0]; }
  else if (exportProblem) { status = 'fail'; why = exportProblem; }
  else if (!launched) { status = 'unverified'; why = text(j.unverifiedReason || j.reason) || '桌面窗口没有启动成功'; }
  else if (!verified) { status = 'unverified'; why = '桌面验收没有给出 verified 结论'; }
  else if (!assertions.length) { status = 'unverified'; why = '桌面验收没有给出任何断言'; }
  else if (onlyLaunched) { status = 'unverified'; why = '只启动了窗口，没有执行任何交互也没有产物证据'; }
  else if (needsExport && !exported.length) { status = 'unverified'; why = '用户要求导出/海报工具，但验收没有导出证据'; }
  else if (verdict && !PASS_WORDS.has(verdict)) { status = 'unverified'; why = '桌面验收的 verdict 不是通过：' + verdict; }

  const reason = why || text(j.reason) || (status === 'pass' ? '桌面窗口已真实启动并通过断言检查' : '桌面验收未通过');
  // kind 必须跟交付本体一致：evaluate 对「要 exe 的任务」只认 kind=exe 的记录，
  // 若一律记成 app，一个真跑通的 exe 验收会被判成「没有匹配记录」。
  const declaredKind = text(j.kind).toLowerCase();
  // 证据主体（哪一次 spawn、跑的是哪个 exe / 入口 / cwd）原样冻进记录：
  // 通过的那次也要有主体标识，否则事后无法证明「通过的是这个应用，不是别的」。
  // 只做**透传**，不参与任何判据（status/why 的计算在上面已经结束）。
  const resolvedRaw = j.resolved && typeof j.resolved === 'object' && !Array.isArray(j.resolved) ? j.resolved : null;
  const resolved = resolvedRaw ? {
    spawned: resolvedRaw.spawned !== false,
    exe: text(resolvedRaw.exe),
    appArgs: list(resolvedRaw.appArgs).map((a) => text(a)).filter(Boolean),
    appRoot: text(resolvedRaw.appRoot),
    cwd: text(resolvedRaw.cwd),
    workspace: text(resolvedRaw.workspace),
  } : null;
  return {
    tool: 'desktop-verify',
    kind: ['web', 'app', 'exe'].includes(declaredKind) ? declaredKind : inferredKind,
    status, at,
    url: text(j.url || p.url || p.appPath),
    launched, verified, ok: okFlag, verdict: verdict || status,
    assertions, interactions, exported, screenshots, consoleErrors, pageErrors,
    artifactPaths: joinArtifacts(list(j.artifactPaths).concat(exported.map((x) => x.path)).concat(screenshots)),
    exportProblem,
    resolved,
    unverifiedReason: status === 'unverified' ? reason : '',
    reason,
    gaps: status === 'pass' ? [] : [reason],
  };
}

// ---------------------------------------------------------------------------
// 形态词表与「可交付 Electron 工程」判据（deliveryMismatch / artifactType 共用）
// ---------------------------------------------------------------------------

/**
 * 「桌面形态」词表。
 *
 * ★ 为什么必须单独一份（0.21.25 用户报障的真实形态）：
 *   老板原话「帮我做一个桌面宠物，蓝色小蜗牛趴在桌面右下角」——旧词表里只有
 *   「桌面应用/桌面程序/客户端」，**一个都不命中**，于是这次任务压根没有进入运行时验收。
 *   用户嘴里说的桌面程序，最常见的说法恰恰是「桌面宠物 / 桌宠 / 悬浮窗 / 托盘 / 挂件」，
 *   不是产品文档里的「桌面应用」。
 */
const DESKTOP_FORM_RE = /(桌面|桌宠|桌面宠物|宠物|悬浮窗|悬浮球|托盘|挂件|壁纸)/;

/** 需求点名「用户自己双击就能跑」的产物形态。 */
const DOUBLE_CLICK_RE = /(双击|\bexe\b|安装包|安装程序|\bsetup\b|打包)/i;

/** 具备打包能力的标志：三个字段任一成立即可（缺一条都不算，见 packableElectronProject）。 */
const PACKAGE_MANAGER_DEPS = ['electron-builder', 'electron-packager'];
const PACKAGE_SCRIPTS = ['dist', 'build', 'pack', 'make', 'package'];

/**
 * 读一份 package.json；读不到 / 解析失败 / 不是对象 ⇒ null（**绝不抛**）。
 * @param {string} p 磁盘上的真实路径（不要传 normalizePath 过的小写路径）
 * @returns {Object|null}
 */
function readPackageJson(p) {
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

/**
 * ★ R3：「可交付的 Electron 工程」判定（**不许放宽**）。
 *
 * 为什么标准必须这么硬：`desktop-pet/package.json` 里 `devDependencies.electron` 是有的，
 *   但**没有** `build` 字段、**没有** dist/build/pack/make/package 脚本、**没有** electron-builder。
 *   这种工程对开发者是「源码能跑（`npm start`）」，对用户是「拿不到任何能双击的东西」——
 *   而本轮用户报障要的正是「双击就能用」。把它算成合格工程，等于把「我只能 `npm start`」
 *   洗成「我交付了一个桌面应用」。
 *
 * 三条同时成立才算：
 *   (a) `dependencies.electron` 或 `devDependencies.electron` 存在（真的是 Electron 工程）；
 *   (b) 具备打包能力，三者任一：
 *       · `pkg.build` 字段存在（electron-builder 的配置位）；
 *       · `pkg.scripts` 里有名为 dist / build / pack / make / package 的脚本；
 *       · 依赖里有 electron-builder / @electron-forge/* / electron-packager。
 *
 * ⚠️ 脚本名按**精确名**匹配（`build:win` 不算）——这是**故意的**：`build:win` 单看名字无法
 *   证明它真能产出安装包，而"名字里带 build"恰恰是最容易自我说服的假证据。真想被认，
 *   就把打包器写进依赖（(b) 的第三条），那是机器可核的事实。
 *
 * @param {string[]} artifacts 本次交付的产物绝对路径
 * @returns {{ok: boolean, path: string, why: string}}
 */
function packableElectronProject(artifacts) {
  const files = Array.isArray(artifacts) ? artifacts : [];
  for (const raw of files) {
    const p = text(raw);
    if (!p) continue;
    if (normalizePath(p).split('/').pop() !== 'package.json') continue;
    const pkg = readPackageJson(p);
    if (!pkg) continue; // 读不到 / 解析失败 ⇒ 视为不满足（不许崩，也不许猜）
    const deps = Object.assign({},
      (pkg.dependencies && typeof pkg.dependencies === 'object') ? pkg.dependencies : {},
      (pkg.devDependencies && typeof pkg.devDependencies === 'object') ? pkg.devDependencies : {});
    const names = Object.keys(deps);
    const hasElectron = names.includes('electron');
    if (!hasElectron) continue;
    const hasBuildField = pkg.build != null && pkg.build !== '';
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
    const hasScript = Object.keys(scripts).some((k) => PACKAGE_SCRIPTS.includes(k));
    const hasPacker = names.some((k) => PACKAGE_MANAGER_DEPS.includes(k) || k.indexOf('@electron-forge/') === 0);
    if (!(hasBuildField || hasScript || hasPacker)) continue;
    return { ok: true, path: p, why: 'package.json 具备打包能力' };
  }
  return { ok: false, path: '', why: '没有可交付的 Electron 工程（缺打包能力或没有 electron 依赖）' };
}

/**
 * 交付形态与需求形态对不上时，返回一句**能直接给用户看**的理由；对得上返回 ''。
 *
 * 这是完成门禁的输入：只要返回非空，就不许判 COMPLETE。
 * 判据方向与 expectsRuntime 一致 —— **宁可多拦一次，不可漏放一次**：
 *   漏放的代价是「用户拿到一个跑不起来的东西，还以为做完了」（本轮报障本身）；
 *   多拦的代价只是「让 agent 再说一句到底交付了什么」。
 *
 * 三条规则（各自可独立分辨，见 scripts/smoke/unit-runtime-trigger.mjs）：
 *   R1 需求要双击可运行的产物，但没有任何 .exe；
 *   R2 需求要桌面形态，但既没有 .exe，也没有具备打包能力的 Electron 工程（R3）。
 *
 * @param {string} userText 需求原文
 * @param {string[]} artifacts 本次交付的产物绝对路径
 * @returns {string}
 */
function deliveryMismatch(userText, artifacts) {
  const t = text(userText);
  const files = Array.isArray(artifacts) ? artifacts : [];
  if (!t) return '';
  const hasExe = files.some((p) => extOf(p) === '.exe');
  // R1：用户点了「双击 / exe / 安装包 / 打包」，交付物里却没有一个 .exe。
  //     网页、源码、工程目录都满足不了这句需求 —— 用户双击不了它们。
  if (DOUBLE_CLICK_RE.test(t) && !hasExe) {
    return '需求要一个双击就能运行的程序，但交付物里没有 .exe（只有网页或源码，用户双击不了）';
  }
  // R2：用户点的是桌面形态（桌面宠物 / 桌宠 / 悬浮窗 / 托盘 / 挂件 / 壁纸…）。
  //     合格交付只有两种：能双击的 .exe，或者一个**真能打出包**的 Electron 工程。
  if (DESKTOP_FORM_RE.test(t) && !hasExe) {
    const project = packableElectronProject(files);
    if (!project.ok) {
      return '需求要桌面程序，但交付物里没有可执行文件，也没有具备打包能力的 Electron 工程';
    }
  }
  return '';
}

/**
 * 本次交付该按什么形态验收。
 *
 * ★★ 判定顺序：**用户需求优先，扩展名垫底**（2026-10-30 修）。
 *
 * 旧实现先看扩展名：产物里只要有 `.html` 就返回 `'web'` ⇒ 浏览器验收（browser-verify）
 *   就能把「桌面窗口必须启动」这一条销掉。而「交付了一个网页」**恰恰就是本轮用户报障的形态**：
 *   用户要的是桌面宠物悬浮窗，agent 交了一个网页，验收按 web 标准（浏览器能打开）**放水通过**，
 *   任务被判完成，而 9333 端口的悬浮窗从未启动（ECONNREFUSED），没有双击入口、没打包。
 *
 * 所以顺序改成：
 *   .exe 存在                     ⇒ 'exe'（唯一一种用户能自己双击的形态）
 *   需求点名桌面形态（R2 词表）    ⇒ 'desktop'（新类型：必须真有窗口跑起来的记录）
 *   有可交付 Electron 工程（R3）   ⇒ 'app'
 *   .html/.htm 存在               ⇒ 'web'
 *   兜底（含"还没有产物"的早轮）   ⇒ 按需求措辞判（沿用旧实现的同一批词），再兜 'app'
 *
 * ⚠️ 最后那一步**不能省**：`evaluate()` 会在还没有产物时就被调用（一轮任务里先判一次），
 *   此时若直接兜 'app'，「做一个网页游戏」会被要求 **app** 运行验收 ⇒ 一份真实的浏览器验收
 *   反被判成"没有匹配记录"。旧实现的 userText 词表必须在这里原样保留。
 *
 * @param {string} userText 需求原文
 * @param {string[]} artifacts 本次交付的产物绝对路径
 * @returns {'exe'|'desktop'|'app'|'web'}
 */
function artifactType(userText, artifacts) {
  const files = Array.isArray(artifacts) ? artifacts : [];
  const t = text(userText);
  if (files.some((p) => extOf(p) === '.exe')) return 'exe';
  if (DESKTOP_FORM_RE.test(t)) return 'desktop';
  if (packableElectronProject(files).ok) return 'app';
  if (files.some((p) => ['.html', '.htm'].includes(extOf(p)))) return 'web';
  // 兜底：没有产物可看时按需求措辞判（旧实现的同一批词，一个字都没改）。
  if (/(网页|网站|web\s*(?:app|应用|页面)?|浏览器|h5\b)/i.test(t)) return 'web';
  if (/(\.exe\b|桌面应用|桌面程序|客户端|windows\s*应用)/i.test(t)) return 'exe';
  return 'app';
}

/**
 * 旧的「对象」词表 —— **只服务门禁的反控臂**（`RT_ANTI=1`）。
 *
 * 保留它的唯一理由：让 scripts/smoke/unit-runtime-trigger.mjs 能证明自己的断言
 * **能分辨新旧**，而不是一组恒真的断言。生产路径永远走 OBJECT_RE。
 */
const OBJECT_RE_LEGACY = /(\.exe\b|桌面应用|桌面程序|客户端|网页|网站|web\s*(?:app|应用|页面)?|浏览器应用|游戏|海报(?:制作|设计|生成)?工具|应用|小程序|软件|交互页面|工具)/i;

/**
 * 现行「对象」词表：在旧表基础上补齐**桌面形态的常见说法**。
 *
 * 实测（0.21.25，6 条真实说法喂进去）：
 *   「帮我做一个桌面宠物，蓝色小蜗牛趴在桌面右下角，可以拖着走」 → 旧表 false（跳过运行时验收）
 *   「做个桌宠」                                              → 旧表 false
 *   「帮我做一个桌面宠物，最后打包成 exe，双击就能用」            → 旧表 false
 *   「你继续，把悬浮窗口修好，然后打包成 exe」                   → 旧表 false
 *   「帮我做一个桌面宠物应用，蓝色小蜗牛悬浮在桌面」              → 旧表 true
 *   「帮我做一个网页游戏，蓝色小蜗牛」                          → 旧表 true
 *   ⇒ 前 4 条是**真漏判**：它们全是"要个能跑的程序"，却全部绕过了运行时验收。
 *
 * ★ 判据方向（写在代码里，免得以后有人"顺手收紧"）：
 *   **漏判的代价**是「用户拿到一个跑不起来的东西，还以为做完了」（本轮报障）；
 *   **误判的代价**只是「多验一次运行」。
 *   两者不对称，所以这个表**宁宽不宁窄**：宁可多要求验收，不可少要求。
 */
const OBJECT_RE = /(\.exe\b|桌面应用|桌面程序|客户端|桌面宠物|桌宠|宠物|悬浮窗|悬浮球|悬浮|托盘|挂件|桌面小工具|桌面上|壁纸|钟表|便签|网页|网站|web\s*(?:app|应用|页面)?|浏览器应用|游戏|海报(?:制作|设计|生成)?工具|应用|小程序|软件|交互页面|工具)/i;

/**
 * 动作词表。相比旧表只补了三个真缺的：转成 / 压成 / 编译
 * （「把网页转成桌面程序」「压成 exe」「编译一下」都是让 agent 动手，不是求教）。
 */
const ACTION_RE = /(做|开发|创建|生成|制作|搭|写|实现|修|改|优化|完善|继续|接着|重跑|验收|测试|打包|导出|上线|部署|转成|压成|编译)/;

/** 纯判据：这类交付必须真的启动并操作，不能只验文件。 */
function expectsRuntime(userText) {
  const t = text(userText);
  if (!t) return false;
  // PPT 有自己的 full workflow，不能在这里再被判一次。
  if (/(\.pptx\b|powerpoint|演示文稿|\bppt\b)/i.test(t)
    && !/(\.exe\b|桌面|网页|网站|游戏|应用|程序|工具|软件)/i.test(t)) return false;
  // 反控臂：门禁用 RT_ANTI=1 临时关掉新增的桌面词表，用来证明断言能分辨新旧（不是恒真）。
  const object = (process.env.RT_ANTI === '1' ? OBJECT_RE_LEGACY : OBJECT_RE).test(t);
  if (!object) return false;
  const action = ACTION_RE.test(t);
  const informationalQuestion = /^(什么是|什么叫|介绍|解释|聊聊|告诉我|如何做|怎么做|如何|为什么)/.test(t);
  const abilityQuestion = /^(能否|可不可以)/.test(t) && !action;
  return !(informationalQuestion || abilityQuestion);
}

function browserRecord(params, result, at) {
  const p = params && typeof params === 'object' ? params : {};
  const j = parseJson(result);
  if (!j) {
    return {
      tool: 'browser-verify', kind: 'web', status: 'unverified', at,
      url: text(p.url), assertions: [], screenshots: [], consoleErrors: [], requestErrors: [],
      artifactPaths: uniqPaths(p.artifactPaths || p.artifacts || p.artifactPath),
      unverifiedReason: 'browser-verify 没有返回可解析的结构化验收记录',
      reason: 'browser-verify 没有返回可解析的结构化验收记录', gaps: ['补跑浏览器验收并返回 verified/ok 与页面证据'],
    };
  }
  const ev = j.evidence && typeof j.evidence === 'object' ? j.evidence : {};
  const target = j.target && typeof j.target === 'object' ? j.target
    : (ev.target && typeof ev.target === 'object' ? ev.target : {});
  const verified = j.verified === true || ev.verified === true;
  const ok = j.ok === true;
  const assertions = list(j.assertions || ev.assertions || j.checks || ev.checks);
  const failedAssertions = assertions.filter((a) => a && typeof a === 'object'
    && (a.pass === false || a.ok === false || a.success === false || FAIL_WORDS.has(text(a.status).toLowerCase())));
  const screenshots = list(j.screenshots || j.screenshot || ev.screenshots || ev.screenshot);
  const consoleErrors = errorsOf(Object.assign({}, ev, j), ['consoleErrors', 'pageErrors', 'logErrors']);
  const requestErrors = errorsOf(Object.assign({}, ev, j), ['failedRequests', 'requestErrors']);
  const blockers = errorsOf(j, ['blockers', 'errors']);
  const reason = text(j.unverifiedReason || j.reason || j.detail || j.error || blockers.join('；'));
  // ok:true 只是工具自报总状态；没有实际断言不算验收，失败断言也不能被总状态洗绿。
  const status = !verified ? 'unverified'
    : (!ok || failedAssertions.length ? 'fail' : (!assertions.length ? 'unverified' : 'pass'));
  const url = text(j.url || target.url || ev.url || p.url);
  return {
    tool: 'browser-verify', kind: 'web', status, at, url,
    verified, ok,
    assertions, screenshots, consoleErrors, requestErrors,
    artifactPaths: uniqPaths(j.artifactPaths || j.artifacts || j.artifactPath || p.artifactPaths || p.artifacts || p.artifactPath),
    launched: verified,
    interactions: assertions,
    exported: screenshots,
    verdict: status,
    unverifiedReason: status === 'unverified' ? (reason || '浏览器没有完成检查') : '',
    reason: reason || (status === 'pass' ? '浏览器完成页面渲染与断言检查' : '浏览器验收未通过'),
    gaps: status === 'pass' ? [] : [reason || (status === 'unverified' ? '在可用浏览器环境中重跑页面验收' : '修复页面断言、控制台或请求错误后重跑')],
  };
}

function shellRecords(params, result, at, taskId, userText) {
  const out = [];
  const lines = text(result).split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(RUNTIME_MARKER);
    if (idx < 0) continue;
    const j = parseJson(line.slice(idx + RUNTIME_MARKER.length));
    if (!j) {
      out.push({
        tool: 'shell-exec', kind: 'app', status: 'unverified', at,
        artifactPaths: [], assertions: [], screenshots: [], consoleErrors: [], requestErrors: [],
        unverifiedReason: '运行验收 marker 后不是合法 JSON', reason: '运行验收 marker 后不是合法 JSON',
        gaps: ['让验收脚本输出一条合法的 ' + RUNTIME_MARKER + '{...} JSON 行'],
      });
      continue;
    }
    if (text(j.taskId) && text(j.taskId) !== text(taskId)) continue;
    const verdict = text(j.verdict).toLowerCase();
    const launched = j.launched === true;
    const interactions = list(j.interactions);
    const assertions = list(j.assertions || j.checks);
    const exported = list(j.exported);
    const needsExport = /(导出|海报)/.test(text(userText));
    const missingEvidence = launched && PASS_WORDS.has(verdict)
      ? (!interactions.length && !assertions.length
        ? '运行通过结论缺少至少一条 interaction/assertion'
        : (needsExport && !exported.length ? '用户要求导出/海报工具，但验收没有 exported 证据' : ''))
      : '';
    const status = (verdict === 'unverified' || j.unverifiedReason || missingEvidence
      || (!launched && !FAIL_WORDS.has(verdict)))
      ? 'unverified'
      : (FAIL_WORDS.has(verdict) || j.ok === false ? 'fail' : (launched && PASS_WORDS.has(verdict) ? 'pass' : 'unverified'));
    const kind = ['web', 'app', 'exe'].includes(text(j.kind || j.type).toLowerCase())
      ? text(j.kind || j.type).toLowerCase() : 'app';
    const reason = text(j.unverifiedReason || missingEvidence || j.reason || j.error || j.detail);
    out.push({
      tool: 'shell-exec', kind, status, at,
      url: text(j.url || (params && params.url)),
      launched,
      interactions,
      exported,
      assertions,
      screenshots: list(j.screenshots || j.screenshot),
      consoleErrors: errorsOf(j, ['consoleErrors', 'pageErrors']),
      requestErrors: errorsOf(j, ['requestErrors', 'failedRequests']),
      artifactPaths: uniqPaths(j.artifactPaths || j.artifacts || j.artifactPath || j.path || j.exe),
      verdict,
      unverifiedReason: status === 'unverified' ? (reason || '运行验收没有完成') : '',
      reason: reason || (status === 'pass' ? '应用已启动并给出机器可读通过结论' : '运行验收未通过'),
      gaps: status === 'pass' ? [] : [reason || '修复产物后重跑同一运行验收'],
    });
  }
  return out;
}

function createRuntimeEvidence(options) {
  const opt = options && typeof options === 'object' ? options : {};
  const taskId = text(opt.taskId);
  let userText = text(opt.userText);
  let records = [];
  let seq = 0;

  function importRecords(items) {
    if (!Array.isArray(items)) return 0;
    let n = 0;
    for (const r of items) {
      if (!r || typeof r !== 'object' || !['pass', 'fail', 'unverified'].includes(r.status)) continue;
      records.push(Object.assign({}, r, {
        artifactPaths: uniqPaths(r.artifactPaths),
        // 历史 hash 只能读账本，绝不能按当前磁盘重算后把旧证据洗成新字节证据。
        artifactFacts: storedArtifactFacts(r.artifactFacts),
        prior: true,
        at: Number(r.at) || 0,
        seq: ++seq,
      }));
      n += 1;
    }
    return n;
  }

  function recordToolResult(input) {
    const x = input && typeof input === 'object' ? input : {};
    const name = text(x.name);
    const at = Number(x.at) || Date.now();
    let found = [];
    if (name === 'browser-verify') found = [browserRecord(x.params, x.result, at)];
    else if (name === 'desktop-verify') found = [desktopRecord(x.params, x.result, at, userText)];
    else if (name === 'shell-exec' || name === 'ssh-exec') found = shellRecords(x.params, x.result, at, taskId, userText);
    const currentArtifacts = uniqPaths(x.artifacts);
    for (const r of found) {
      // 命令/参数明确提到当前产物时，补上关联；不接受输出里随便写路径来冒领。
      if (!r.artifactPaths.length && currentArtifacts.length) {
        const paramsText = text(JSON.stringify(x.params || {}));
        r.artifactPaths = currentArtifacts.filter((p) => paramsText.includes(p));
      }
      // 真实 browser manifest 通常只有 URL：在执行当下绑定已存在的网页本体，而不是事后猜。
      if (name === 'browser-verify' && !r.artifactPaths.length) {
        r.artifactPaths = currentArtifacts.filter((p) => ['.html', '.htm'].includes(extOf(p)));
      }
      // 证据必须绑定验收当时的真实字节；evaluate 会对当前文件重算，路径相同也不能冒充同版本。
      r.artifactFacts = artifactFacts(r.artifactPaths);
      r.taskId = taskId;
      r.prior = false;
      r.seq = ++seq;
      records.push(r);
    }
    return found;
  }

  /** 产物发生改动后，旧的通过证据不能继续替新字节背书。 */
  function invalidate(input) {
    const x = input && typeof input === 'object' ? input : {};
    const paths = uniqPaths(x.paths).map(normalizePath);
    const before = records.length;
    records = records.filter((r) => {
      if (x.all === true) return false;
      if (!paths.length) return true;
      const rp = uniqPaths(r.artifactPaths).map(normalizePath);
      if (rp.some((p) => paths.includes(p))) return false;
      // browser-verify 通常只给 URL、不给产物路径；这种记录对当前网页共享，
      // 因此任一网页本体变化都必须失效，不能因 rp 为空而永久保留。
      if (!rp.length && r.kind === 'web'
        && paths.some((p) => ['.html', '.htm'].includes(extOf(p)))) return false;
      // 当前轮记录与历史记录遵循同一字节身份规则：验收后再改写就必须重跑。
      return true;
    });
    return before - records.length;
  }

  function evaluate(input) {
    const x = input && typeof input === 'object' ? input : {};
    const required = x.expectsRuntime == null ? expectsRuntime(x.userText == null ? userText : x.userText) : x.expectsRuntime === true;
    if (!required) return { status: 'not-applicable', notApplicable: true, pass: false, why: '本任务不需要应用运行验收', gaps: [], records: [] };
    const allArtifacts = uniqPaths(x.artifacts);
    const wanted = artifactType(x.userText == null ? userText : x.userText, allArtifacts);
    // 运行验收只覆盖可运行本体；随 exe 一起交付的说明文档不强迫再“启动”一次。
    const artifacts = wanted === 'exe'
      ? allArtifacts.filter((p) => extOf(p) === '.exe')
      : (wanted === 'web' ? allArtifacts.filter((p) => ['.html', '.htm'].includes(extOf(p))) : allArtifacts);
    // 形态匹配：`desktop` 是本次新加的形态（用户点名桌面形态时的要求），它不是一种"记录 kind"，
    // 而是「必须有真窗口跑起来的证据」这条要求 —— 所以 app / exe 两种真实桌面验收记录都算。
    // ★ 关键：**web 记录（browser-verify）不算**。这就是本轮报障的漏洞所在：
    //   交付了一个网页、浏览器验收通过 ⇒ 桌面窗口从未启动也能销掉要求。
    const sameType = records.filter((r) => r.kind === wanted
      || (wanted === 'app' && r.kind === 'exe')
      || (wanted === 'desktop' && (r.kind === 'app' || r.kind === 'exe')));
    if (!sameType.length) {
      const why = '任务需要 ' + wanted + ' 运行验收，但没有任何匹配的结构化运行记录（命令成功/HTTP 200 不算）';
      return { status: 'fail', pass: false, why, gaps: [why], records: [] };
    }
    const relevant = sameType.filter((r) => {
      if (!artifacts.length) return true;
      const rp = uniqPaths(r.artifactPaths).map(normalizePath);
      return rp.some((p) => artifacts.map(normalizePath).includes(p));
    });
    if (!relevant.length) {
      const why = '有运行验收尝试，但记录没有关联到当前任务/交付物，不能据此通过';
      return { status: 'unverified', unverified: true, pass: false, why, gaps: [why], records: [] };
    }

    // 同一对象只认最后一次结论：修复后重跑成功可以销掉此前失败。
    const latest = new Map();
    for (const r of relevant) {
      const paths = uniqPaths(r.artifactPaths);
      const keys = paths.length ? paths.map(normalizePath) : ['__shared__'];
      for (const k of keys) latest.set(k, r);
    }
    const latestRecords = Array.from(latest.values());
    if (artifacts.length) {
      const currentFacts = new Map(artifactFacts(artifacts).map((a) => [normalizePath(a.path), a]));
      const stale = [];
      for (const r of latestRecords) {
        const bound = new Map(storedArtifactFacts(r.artifactFacts).map((a) => [normalizePath(a.path), a]));
        for (const p of uniqPaths(r.artifactPaths).map(normalizePath)) {
          if (!currentFacts.has(p)) continue;
          const oldFact = bound.get(p);
          const newFact = currentFacts.get(p);
          if (!oldFact || !oldFact.sha1 || !newFact.sha1 || oldFact.sha1 !== newFact.sha1) stale.push(p);
        }
      }
      if (stale.length) {
        const why = '运行证据未绑定当前字节或产物已在验收后变化，必须重跑：' + stale.join('、');
        return { status: 'unverified', unverified: true, pass: false, why, gaps: [why], records: latestRecords };
      }
    }
    const failed = latestRecords.filter((r) => r.status === 'fail');
    if (failed.length) {
      const why = failed.map((r) => r.reason || '运行验收失败').join('；');
      return { status: 'fail', pass: false, why, gaps: failed.flatMap((r) => list(r.gaps).length ? list(r.gaps) : [r.reason || '修复后重跑运行验收']), records: latestRecords };
    }
    const unverified = latestRecords.filter((r) => r.status !== 'pass');
    if (unverified.length) {
      const why = unverified.map((r) => r.unverifiedReason || r.reason || '运行验收未跑成').join('；');
      return { status: 'unverified', unverified: true, pass: false, why, gaps: unverified.flatMap((r) => list(r.gaps).length ? list(r.gaps) : [r.unverifiedReason || '补跑运行验收']), records: latestRecords };
    }
    if (artifacts.length) {
      const covered = new Set();
      for (const r of latestRecords) {
        const rp = uniqPaths(r.artifactPaths).map(normalizePath);
        if (wanted === 'web' && !rp.length) artifacts.forEach((p) => covered.add(normalizePath(p)));
        rp.forEach((p) => covered.add(p));
      }
      const missing = artifacts.filter((p) => !covered.has(normalizePath(p)));
      /**
       * `desktop` 的覆盖率口径（与 `exe` 同一思路，**不是放宽，是纠正一个结构性不可能**）。
       *
       * 桌面工程交付的是**一棵文件树**（package.json / main.js / index.html / 资源图…），
       * 而用户眼里的"这个程序"是**入口或可执行文件**一个。
       * 若要求每个伴随文件都被同一份运行记录逐一覆盖，`package.json` 与资源图就得各"启动"一次 ——
       * 结构上做不到 ⇒ 一个**真跑通**的桌面应用会永远停在 unverified。
       * `exe` 形态早就是这么处理的（只看 .exe 一个本体）。所以 desktop 只要求
       * **至少一个本体被真实记录覆盖**（且 sameType 过滤已保证那是 app/exe 的真实桌面验收，
       * browser-verify 进不来）。覆盖率之外的那道门一条都没松：
       * launched / verified / 断言 / 交互 / 字节 hash 仍逐条判。
       */
      const desktopBodyCovered = wanted === 'desktop' && covered.size > 0;
      if (missing.length && !desktopBodyCovered) {
        const why = '以下当前交付物没有匹配的运行通过记录：' + missing.join('、');
        return { status: 'unverified', unverified: true, pass: false, why, gaps: [why], records: latestRecords };
      }
    }
    return { status: 'pass', pass: true, why: wanted + ' 当前交付物有匹配的真实运行通过记录（' + latestRecords.length + ' 条）', gaps: [], records: latestRecords };
  }

  // ★ 2026-11-09 新增：产物形态也能证明「必须真实运行才能验收」。
  //   要钉住的缺陷（实测）：交付物是 dist\大肥鱼.exe，但 expectsRuntime 只读用户那句话的措辞，
  //   判 false ⇒ general_runtime_validated 标「不适用」⇒ 一个 exe 反而不需要运行验收。
  //   判据方向：不看用户怎么说，看**交付了什么**；只认可执行/安装包，避免把静态文件升级成必须启动。
  const RUNTIME_ONLY_EXT = /\.(exe|msi|msix|app|dmg|pkg|apk|appimage)$/i;
  function artifactNeedsRun(arts) {
    if (!Array.isArray(arts)) return false;
    for (const a of arts) {
      const p = (a && (a.path || a.name)) || a;
      if (typeof p === 'string' && RUNTIME_ONLY_EXT.test(p)) return true;
    }
    return false;
  }

  function summary(input) {
    const evaluation = evaluate(input);
    const counts = { pass: 0, fail: 0, unverified: 0 };
    records.forEach((r) => { if (counts[r.status] != null) counts[r.status] += 1; });
    const lines = records.slice(-8).map((r) => '[' + r.status + '] ' + r.kind
      + (r.url ? ' ' + r.url : '')
      + (r.artifactPaths && r.artifactPaths.length ? ' ' + r.artifactPaths.join('、') : '')
      + '：' + (r.reason || r.unverifiedReason || '无原因记录'));
    return {
      taskId, expectsRuntime: (expectsRuntime(userText) || artifactNeedsRun(input && input.artifacts)), counts,
      evaluation, records: records.map((r) => Object.assign({}, r)),
      text: ['运行验收客观账：pass=' + counts.pass + ' / fail=' + counts.fail + ' / unverified=' + counts.unverified,
        '当前裁决：' + evaluation.status + ' —— ' + evaluation.why].concat(lines).join('\n'),
    };
  }

  function setUserText(v) { userText = text(v); }

  return { recordToolResult, importRecords, invalidate, evaluate, summary, setUserText, records: () => records.map((r) => Object.assign({}, r)) };
}

module.exports = {
  RUNTIME_MARKER,
  expectsRuntime,
  // 完成门禁的输入：非空 ⇒ 交付形态与需求形态对不上，不许判 COMPLETE。
  deliveryMismatch,
  // 形态判定本身也要能被门禁直接钉住（顺序反转是本次修复的核心之一）。
  artifactType,
  createRuntimeEvidence,
};
