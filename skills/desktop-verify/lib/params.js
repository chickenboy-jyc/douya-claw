'use strict';
/**
 * desktop-verify —— 参数归一化与合法性判定（纯函数，便于单测驱动反向控制）。
 *
 * 为什么单独一层：技能参数在渲染层被声明为 string（见 skills/browser-verify/manifest.json
 * 的同款约定），所以 `actions` / `expectExport` / `args` 传进来可能是 JSON **字符串**。
 * 这里统一做强类型归一化，让下游永远只看到数组/对象/数字，不再各自猜。
 *
 * 诚实红线：任何「不确定」都往 **失败** 方向解释 —— 参数不足以启动一个真实窗口时，
 * 返回 `{ok:false}`，由上层输出 verdict=fail 的记录，而不是降级去"验证"一个不存在的东西。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 取字符串。
 * @param {*} v
 * @param {string} [def]
 * @returns {string}
 */
function str(v, def) {
  const d = def === undefined ? '' : def;
  if (v == null) return d;
  return String(v).trim();
}

/**
 * 取数字（非法值一律回退到默认值，不做 `NaN` 传播）。
 * @param {*} v
 * @param {number} def
 * @returns {number}
 */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * 取布尔。技能层常收到 'true' / 'false' 字符串。
 * @param {*} v
 * @param {boolean} [def]
 * @returns {boolean}
 */
function bool(v, def) {
  const d = def === undefined ? false : def;
  if (v == null) return d;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  return d;
}

/**
 * 取数组：数组原样返回；JSON 字符串解析；空值返回 []。
 * @param {*} v
 * @returns {Array}
 */
function arr(v) {
  if (Array.isArray(v)) return v;
  const s = str(v);
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    return null; // 解析失败 ⇒ 记为「传了但不是数组」，由调用方判非法
  }
}

/**
 * 取对象：对象原样返回；JSON 字符串解析；空值返回 {}。
 * @param {*} v
 * @returns {object|null} null 表示传了但解析不出对象
 */
function obj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  const s = str(v);
  if (!s) return {};
  try {
    const j = JSON.parse(s);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────── 路径解析：相对路径按 Agent 工作区 ───────────────────────

/**
 * 解析「相对路径的基目录」。
 *
 * ★ 为什么必须有这一层（真实故障，不是假设）：本技能由豆芽主进程 require() 执行，
 *   `process.cwd()` 是**仓库根**，不是 Agent 工作区。模型自然写的 `poster-app/main.js`
 *   按 cwd 解析成了 `<仓库根>/poster-app/main.js`（不存在）⇒ electron 拿一个不存在的入口
 *   启动、几毫秒就退出 ⇒ 报出来的是 `ECONNREFUSED 127.0.0.1:<port>`，对模型毫无指导性。
 *   后端其它工具早就按工作区解析了（src/main/backend.js:711 定义 AGENT_WORKSPACE，
 *   :5470 / :5639 用 path.resolve(AGENT_WORKSPACE, ...)），本技能与它们同一条规矩。
 *
 * 优先级：显式 workspace 参数 → AGENT_WORKSPACE 环境变量 → ~/douya-claw-workspace。
 *
 * @param {object} r 原始 params
 * @returns {string} 绝对路径基目录
 */
function resolveBaseDir(r) {
  const explicit = str(r && (r.workspace || r.workDir || r.workspaceDir));
  if (explicit) return path.resolve(explicit);
  const fromEnv = str(process.env.AGENT_WORKSPACE);
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(path.join(os.homedir(), 'douya-claw-workspace'));
}

/**
 * 按基目录把一个路径解析成绝对路径。
 * @param {string} baseDir 基目录（绝对路径）
 * @param {*} given 用户给的原始值（可为空）
 * @returns {string} 空值返回 ''；绝对路径原样规范化；相对路径落到 baseDir 下
 */
function resolveUnder(baseDir, given) {
  const s = str(given);
  if (!s) return '';
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(baseDir, s);
}

/**
 * 解析 actions：数组原样；JSON **字符串**（含被二次编码成字符串的情况）解析成数组；
 * 没传 ⇒ []；解析不出数组（解析失败 / 结果是对象或数字）⇒ null（由调用方判非法）。
 *
 * ★ 为什么要接受字符串：技能参数在渲染层声明为 string，模型据此把合法动作数组
 *   `JSON.stringify` 之后再传，内容完全合法、只是外壳是字符串 —— 整包拒绝等于白烧一轮。
 *   注意：**只放宽外壳，不放宽内容**（逐项校验在 normalizeActions 里一字不动）。
 *
 * @param {*} v
 * @returns {Array|null}
 */
function parseActionsArray(v) {
  if (Array.isArray(v)) return v;
  let cur = v;
  for (let depth = 0; depth < 3; depth += 1) {
    const s = str(cur);
    if (!s) return depth === 0 ? [] : null;
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      return null;
    }
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== 'string') return null; // 解出来是对象/数字：不是动作数组
    cur = parsed;
  }
  return null;
}

const ACTION_TYPES = ['click', 'clickText', 'type', 'waitFor', 'waitText', 'sleep', 'evaluate', 'screenshot'];

/**
 * 归一化交互数组。**未知动作类型一律判非法**（静默跳过 = 声称做了没做的事）。
 *
 * 外壳容错：`actions` 可以是数组，也可以是 JSON 编码的字符串（见 parseActionsArray）；
 * 但逐项校验完全不变 —— 未知 type、缺 selector、缺 text、缺 expression 全部照旧判非法。
 *
 * 给了 baseDir 时，screenshot 动作的落盘路径也按同一个基目录绝对化（同一个规矩：
 * 否则 `path:"shots/a.png"` 会落到 process.cwd()，即仓库根）。
 *
 * @param {*} v
 * @param {string} [baseDir] 相对路径基目录（见 resolveBaseDir）
 * @returns {{ok:boolean, reason?:string, actions:Array<object>}}
 */
function normalizeActions(v, baseDir) {
  const raw = parseActionsArray(v);
  if (raw === null) return { ok: false, reason: 'actions 传了值但不是 JSON 数组', actions: [] };
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const a = raw[i];
    if (!a || typeof a !== 'object') return { ok: false, reason: 'actions[' + i + '] 不是对象', actions: [] };
    const type = str(a.type || a.action);
    if (!ACTION_TYPES.includes(type)) {
      return { ok: false, reason: 'actions[' + i + '] 的 type「' + type + '」不支持（只认 ' + ACTION_TYPES.join('/') + '）', actions: [] };
    }
    const item = {
      type,
      selector: str(a.selector || a.target),
      text: str(a.text || a.value),
      expression: str(a.expression || a.js || a.expr),
      name: str(a.name || '') || type + '#' + i,
      path: baseDir ? resolveUnder(baseDir, str(a.path || a.screenshot)) : str(a.path || a.screenshot),
      ms: num(a.ms || a.sleep, 500),
      timeoutMs: num(a.timeoutMs, 10000),
    };
    if (type === 'click' && !item.selector) return { ok: false, reason: 'actions[' + i + '] click 缺少 selector', actions: [] };
    if (type === 'clickText' && !item.text) return { ok: false, reason: 'actions[' + i + '] clickText 缺少 text', actions: [] };
    if (type === 'type' && !item.selector) return { ok: false, reason: 'actions[' + i + '] type 缺少 selector', actions: [] };
    if (type === 'waitFor' && !item.selector) return { ok: false, reason: 'actions[' + i + '] waitFor 缺少 selector', actions: [] };
    if (type === 'waitText' && !item.text) return { ok: false, reason: 'actions[' + i + '] waitText 缺少 text', actions: [] };
    if (type === 'evaluate' && !item.expression) return { ok: false, reason: 'actions[' + i + '] evaluate 缺少 expression', actions: [] };
    out.push(item);
  }
  return { ok: true, actions: out };
}

/**
 * 归一化导出等待规格。
 * @param {*} v
 * @returns {{ok:boolean, reason?:string, spec:object|null}}
 */
function normalizeExpectExport(v) {
  const o = obj(v);
  if (o === null) return { ok: false, reason: 'expectExport 传了值但不是 JSON 对象', spec: null };
  const keys = Object.keys(o);
  if (!keys.length) return { ok: true, spec: null };
  const dir = str(o.dir || o.directory || o.path);
  if (!dir) return { ok: false, reason: 'expectExport 缺少 dir（要到哪个目录里等导出产物）', spec: null };
  const s = {
    dir,
    glob: str(o.glob || o.pattern, '*'),
    minBytes: Number(o.minBytes || o.minSize || 1) || 1,
    timeoutMs: num(o.timeoutMs || o.waitMs, 20000),
    stableMs: num(o.stableMs, 400),
  };
  return { ok: true, spec: s };
}

/**
 * 完整归一化入口。
 *
 * 路径约定（与后端其它工具一致）：相对路径一律按 **Agent 工作区** 解析，
 * 绝对路径不受影响。解析结果写进返回的 `p`（下游永远看到绝对路径），
 * 用户原始字符串原样留在 `p.given` 里 —— 报错必须能同时给出「你给的值」和
 * 「按哪个工作区解析成了什么」，否则模型只会看到一句没用的 ECONNREFUSED。
 *
 * @param {object} raw 技能原始 params
 * @returns {{ok:boolean, reason?:string, params?:object}}
 */
function normalizeParams(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  // 用户原值（报错文案要引用）
  const givenAppPath = str(r.appPath || r.app || r.exe);
  const givenEntry = str(r.entry || r.main);
  const givenElectronPath = str(r.electronPath || r.electron);
  if (!givenAppPath && !givenEntry) {
    return { ok: false, reason: '缺少 appPath / entry：没有要启动的应用，本次没有做任何窗口检查' };
  }

  // 基目录 + 绝对化（绝对路径原样）
  const baseDir = resolveBaseDir(r);
  const appPath = resolveUnder(baseDir, givenAppPath);
  const entry = resolveUnder(baseDir, givenEntry);
  const electronPath = resolveUnder(baseDir, givenElectronPath);

  const argsRaw = arr(r.args || r.argv);
  if (argsRaw === null) return { ok: false, reason: 'args 传了值但不是 JSON 数组', params: undefined };
  const envRaw = obj(r.env || r.environment);
  if (envRaw === null) return { ok: false, reason: 'env 传了值但不是 JSON 对象', params: undefined };

  const acts = normalizeActions(r.actions, baseDir);
  if (!acts.ok) return { ok: false, reason: acts.reason };
  const exp = normalizeExpectExport(r.expectExport);
  if (!exp.ok) return { ok: false, reason: exp.reason };

  const timeoutMs = num(r.timeoutMs, 90000);
  const readyTimeoutMs = Math.min(num(r.readyTimeoutMs, 30000), timeoutMs);
  const mode = str(r.inputMode || r.mode, 'real').toLowerCase();

  const givenScreenshot = str(r.screenshot || r.shot);
  const expSpec = exp.spec
    ? Object.assign({}, exp.spec, { dir: resolveUnder(baseDir, exp.spec.dir) })
    : null;

  const p = {
    appPath,
    entry,
    electronPath,
    cwd: resolveUnder(baseDir, str(r.cwd)),
    args: argsRaw.map((a) => String(a)),
    env: envRaw,
    actions: acts.actions,
    expectExport: expSpec,
    expectUrl: str(r.expectUrl || r.urlPrefix),
    screenshot: resolveUnder(baseDir, givenScreenshot),
    timeoutMs,
    readyTimeoutMs,
    // 默认会在连上窗口后 reload 一次（把错误钩子装到文档创建之前）；
    // 应用 reload 会有副作用的场景可以显式关掉，但那就抓不到启动瞬间的异常。
    noReload: bool(r.noReload, false),
    inputMode: mode === 'dom' ? 'dom' : 'real',
    // 本次的解析基目录 + 用户原值：预检报错要引用它们
    workspace: baseDir,
    given: {
      appPath: givenAppPath,
      entry: givenEntry,
      electronPath: givenElectronPath,
      expectExportDir: exp.spec ? exp.spec.dir : '',
      screenshot: givenScreenshot,
    },
  };
  return { ok: true, params: p };
}

/**
 * 读 Electron 应用目录的入口声明。
 *
 * 「确定性」的边界：只认两种**读得到**的声明 —— ① package.json 的 `main` 且该文件真实存在；
 * ② Electron 的文档默认入口 `<dir>/index.js`（没有 main 时的官方兜底）。
 * 除此之外一律不猜（猜 = 拿一个不存在的入口去启动，然后报 ECONNREFUSED）。
 *
 * @param {string} dir 应用目录（绝对路径）
 * @returns {{main:string, declared:string}} main 为空表示没有可用入口
 */
function readAppMain(dir) {
  const pkgPath = path.join(dir, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    pkg = null; // 没有 package.json / 内容不是合法 JSON：继续看默认入口
  }
  const declared = pkg && typeof pkg === 'object' ? str(pkg.main) : '';
  if (declared) {
    const absolute = path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(dir, declared);
    try {
      if (fs.statSync(absolute).isFile()) return { main: absolute, declared };
    } catch (e) {
      /* 声明了但文件不在：不计为可用入口 */
    }
  }
  const fallback = path.join(dir, 'index.js');
  try {
    if (fs.statSync(fallback).isFile()) return { main: fallback, declared: declared || 'index.js（Electron 默认入口）' };
  } catch (e) {
    /* 没有默认入口 */
  }
  return { main: '', declared };
}

/**
 * 在应用目录里找「打包产物本体」：目录顶层**唯一**的那个 .exe。
 *
 * 为什么要它：manifest 明确支持 `appPath=…/win-unpacked`（electron-builder 打包目录），
 * 这种目录里没有 package.json main（应用被塞进 resources/app.asar），只有 <App>.exe。
 * 顶层恰好一个 .exe 是**读到的**事实，不是猜；0 个或多个一律不认（多个就必须由人指定）。
 *
 * @param {string} dir 应用目录（绝对路径）
 * @returns {string} '' 表示没有唯一的打包 exe
 */
function findPackagedExe(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return '';
  }
  const exes = [];
  for (const ent of entries) {
    if (!ent || !ent.isFile || !ent.isFile()) continue;
    if (!/\.exe$/i.test(String(ent.name || ''))) continue;
    exes.push(path.join(dir, String(ent.name)));
  }
  if (exes.length !== 1) return '';
  const only = exes[0];
  try {
    if (fs.statSync(only).isFile()) return only;
  } catch (e) {
    return '';
  }
  return '';
}

/**
 * 判断路径是不是一个真实存在的目录。
 * @param {string} p
 * @returns {boolean}
 */
function isDirectory(p) {
  const s = str(p);
  if (!s) return false;
  try {
    return fs.statSync(s).isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * 根据参数决定「谁来真正产生窗口」。
 *
 * 三条路径：
 *   ① entry 给了 ⇒ 必须找到 electron 可执行文件，由它跑 entry；
 *   ② appPath 是 .exe ⇒ 直接当作可执行启动（打包后的 Electron / 任意桌面 exe）；
 *   ③ appPath 是目录 ⇒ 当作 Electron 应用目录：读 package.json 的 main（或 index.js 默认入口）
 *      确定性地定位主进程入口文件，再由 electron 跑它。
 *
 * @param {object} p 已归一化参数（路径都已是绝对路径）
 * @param {() => string} [detectElectron] 自动 electron 解析（见 lib/electron.js）
 * @returns {{ok:boolean, reason?:string, exe?:string, appArgs?:string[], appRoot?:string}}
 */
function planLaunch(p, detectElectron) {
  const lower = p.appPath.toLowerCase();
  const isExe = /\.exe$/i.test(lower);
  const isEntryJs = /\.(js|cjs|mjs)$/i.test(lower);

  let appRoot = '';
  if (p.entry) appRoot = path.dirname(path.resolve(p.entry));
  else if (p.appPath && !isEntryJs) appRoot = isExe ? path.dirname(path.resolve(p.appPath)) : path.resolve(p.appPath);
  else appRoot = path.dirname(path.resolve(p.appPath));

  if (p.appPath && isExe) {
    // 特例：appPath 明确指向 electron.exe 本体时，它其实是解释器，不是应用
    const base = path.basename(p.appPath).toLowerCase();
    if (base === 'electron.exe' || base === 'electron') {
      if (!p.entry) return { ok: false, reason: 'appPath 指向的是 electron 解释器本身，但没有给 entry（要跑哪个应用）' };
      return { ok: true, exe: path.resolve(p.appPath), appArgs: [path.resolve(p.entry)].concat(p.args), appRoot };
    }
    return { ok: true, exe: path.resolve(p.appPath), appArgs: p.args.slice(), appRoot };
  }
  if (p.entry) {
    const resolved = p.electronPath || (typeof detectElectron === 'function' ? detectElectron() : '');
    if (!resolved) return { ok: false, reason: '给了 entry 但解析不到 electron 可执行文件（可用 electronPath 显式指定）' };
    return { ok: true, exe: resolved, appArgs: [path.resolve(p.entry)].concat(p.args), appRoot };
  }
  if (p.appPath && !isEntryJs) {
    // appPath 是**真实存在的目录** ⇒ 它可能是应用目录：先读入口声明，不猜
    if (isDirectory(p.appPath)) {
      const appMain = readAppMain(p.appPath);
      if (appMain.main) {
        const resolvedMain = p.electronPath || (typeof detectElectron === 'function' ? detectElectron() : '');
        if (!resolvedMain) return { ok: false, reason: 'appPath 是应用目录，需要 electron 可执行文件才能启动（可用 electronPath 显式指定）' };
        return { ok: true, exe: resolvedMain, appArgs: [appMain.main].concat(p.args), appRoot, appMain: appMain.main };
      }
      // 没有 main / index.js：可能是打包目录（顶层唯一的 <App>.exe），直接跑它
      const packaged = findPackagedExe(p.appPath);
      if (packaged) {
        return { ok: true, exe: packaged, appArgs: p.args.slice(), appRoot, packaged: true };
      }
      return {
        ok: false,
        reason: 'appPath 是应用目录，但 package.json 里没有可用的 main 入口；请直接给主进程入口文件：'
          + path.join(p.appPath, 'main.js'),
      };
    }
    const resolved = p.electronPath || (typeof detectElectron === 'function' ? detectElectron() : '');
    if (!resolved) return { ok: false, reason: 'appPath 是应用目录，需要 electron 可执行文件才能启动（可用 electronPath 显式指定）' };
    return { ok: true, exe: resolved, appArgs: [path.resolve(p.appPath)].concat(p.args), appRoot };
  }
  // 走到这里：appPath 是一个 .js 文件，但没有走 entry 分支
  const resolved = p.electronPath || (typeof detectElectron === 'function' ? detectElectron() : '');
  if (!resolved) return { ok: false, reason: '解析不到 electron 可执行文件来运行 ' + p.appPath };
  return { ok: true, exe: resolved, appArgs: [path.resolve(p.appPath)].concat(p.args), appRoot };
}

module.exports = {
  str, num, bool, arr, obj,
  normalizeActions, normalizeExpectExport, normalizeParams, planLaunch,
  resolveBaseDir, resolveUnder, parseActionsArray, readAppMain, findPackagedExe,
  ACTION_TYPES,
  _fsExists: (p) => fs.existsSync(p),
};
