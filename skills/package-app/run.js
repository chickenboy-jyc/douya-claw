/**
 * package-app —— 把 Electron 工程真的打包成可双击运行的 exe。
 *
 * 为什么存在这个技能：产品原有的 47 个技能里没有任何一个能把源码变成 exe。
 * `desktop-verify` 只能「启动已存在的 exe / Electron 工程做验收」，它不会打包。
 * 于是模型把界面做得再好，也只能交出 `启动xx.bat` 这种依赖 260MB node_modules 的东西，
 * 用户拿去发给别人就废了 —— 老板的原话是「根本不能闭环」。
 *
 * 本技能的三条硬规矩（每一条都对应一次真实翻车）：
 *   ① **前置检查必须各说各话**：目录不存在 / 没有 package.json / JSON 解析失败 /
 *      没有 electron 依赖 / 缺 main / main 指向的文件不存在，六种情况六句不同的话。
 *      老板要的是「卡在哪」，不是「失败了」。
 *   ② **缺配置就自己补**：先备份、再写入最小可用的 build 段与 electron-builder 依赖，
 *      不改动任何既有字段。报错让用户自己去改 package.json 等于把活推回给用户。
 *   ③ **退出码 0 不等于打包成功**：必须去 outDir 里真找 exe、记字节数。
 *      找不到 exe 一律判失败 —— 假绿是本技能最不能犯的错。
 *
 * 依赖注入：真打包走 spawn（**不用 spawnSync** —— 本机实测同步派生 GUI 型子进程会返回
 * `EBUSY` 且 `status === null`，会把「子进程根本没起来」读成「没输出」）。
 * `runWith(params, deps)` 允许单测把 `runBuilder` 换成假实现，从而在不真打包的前提下
 * 覆盖全部判据分支；生产路径 `run(params)` 永远是真实 spawn。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// 子进程字节 → 文本的唯一真源（stderr / 给人看的结论允许 GBK 回退，见该文件头部）。
const { decodeOutput } = require('../../src/main/childOutput');

/** 技能目录（skills/package-app）。 */
const SKILL_DIR = __dirname;
/** 本应用仓库根目录（skills/package-app/../..），用于兜底找 electron-builder。 */
const REPO_ROOT = path.resolve(SKILL_DIR, '..', '..');

/** 默认产物形态：便携版单文件 exe，双击即用、不写注册表。 */
const DEFAULT_TARGET = 'portable';
/** 支持的产物形态。 */
const VALID_TARGETS = ['portable', 'nsis', 'dir'];
/** 默认打包超时：10 分钟（230MB 级 Electron 应用实测 2~6 分钟）。 */
const DEFAULT_TIMEOUT_MS = 600000;
/**
 * 外层技能超时（manifest.timeoutMs = 600000）会**先于**我们的内层超时把整次调用掐死，
 * 那样模型只能看到一句「技能执行超过 N 秒未返回」，看不到任何已收集的日志。
 * 所以内层默认值比外层小 5 秒：让我们先返回「打包超时 + 日志尾部」。
 */
const OUTER_TIMEOUT_GUARD_MS = 5000;
/** stdout/stderr 收集上限（尾部截断），打包失败时这段是唯一线索。 */
const OUTPUT_TAIL_LIMIT = 4000;
/** 安装包小于这个字节数判为「不像一个真的 Electron 应用」（正常 60~200MB）。 */
const MIN_INSTALLER_BYTES = 5 * 1024 * 1024;
/** `dir` 形态按整个 win-unpacked 目录的体量判（里面的 exe 只是改名后的 electron.exe）。 */
const MIN_UNPACKED_TOTAL_BYTES = 20 * 1024 * 1024;
/** 兜底安装的 electron-builder 版本（与本仓 node_modules 里的实测版本一致）。 */
const FALLBACK_BUILDER_VERSION = '24.13.3';

/** 产物形态 → 给人看的说明。 */
const TARGET_LABEL = {
  portable: '便携版单文件 exe（双击即用，不写注册表）',
  nsis: 'NSIS 安装包 exe（会写注册表与开始菜单）',
  dir: '免安装目录 win-unpacked/（最快，用于先落地验收）',
};

/**
 * 成功路径专用的下一步（与 desktop-verify 的衔接点）。
 *
 * ⚠️ 只在**真的产出 exe 且通过 judgeArtifacts** 之后才允许输出。
 *   2026-10-30 修：「文件存在、打包成功、命令退出码 0 都不等于用户能用」这句话是**对的结论**，
 *   但它只在**有产物**时成立。原实现把它写死进每一次返回值，于是「目录不存在」「连 electron
 *   都没有」这类**根本没打出任何 exe** 的失败返回末尾也挂着「接着必须去桌面窗口验收」——
 *   模型据此会去启动一个不存在的程序，白烧一轮再报「启动失败」，用户看到的就是
 *   「它承认有问题但就是不解决」；更坏的是失败结论里带了个「接下来要做的事」，
 *   容易被读成「还没结束，继续」。失败路径用 FAILURE_NEXT_STEPS（按卡点给动作）。
 */
const NEXT_STEP =
  '下一步：接着必须用『桌面窗口验收』技能把它真的启动一次，能起来才算做完。' +
  '文件存在、打包成功、命令退出码 0 都不等于用户能用。';

/**
 * 失败路径的下一步：按「卡在哪」给**各自的**动作。
 *
 * 🔴 这里任何一条都**不许**出现「去桌面窗口验收 / 去启动 / 去双击」——
 *    没打出 exe 时让模型去启动一个不存在的文件，就是上面注释里那种打转。
 *    与前置检查「六种情况六句话」同一个原则：模型要的是「现在该干什么」，不是一句通用鼓励。
 */
const FAILURE_NEXT_STEPS = {
  BAD_TARGET:
    '下一步：把 target 改成 dir / portable / nsis 之一重试（dir 最快，适合先落地验收；交付给用户用 portable）。',
  APPDIR_MISSING: '下一步：先确认要打包的是哪个 Electron 工程目录，再带 appDir 参数重试。',
  APPDIR_ESCAPE: '下一步：把工程移进工作区，或把 appDir 写成工作区内的路径，然后重试。',
  NO_DIR: '下一步：先用『文件列表』确认工程到底建在哪里（把真实路径找出来），再用那个目录重试。',
  NOT_DIR: '下一步：appDir 要传工程目录本身（不是某个文件），确认后重试。',
  NO_PKG:
    '下一步：先用『搭建项目』把这个 Electron 工程建起来（至少 package.json + main 入口 + electron 依赖），再回来打包。',
  PKG_UNREADABLE: '下一步：先用『文件列表』/『读取文件』确认 package.json 是否可读，修好后再重试。',
  PKG_JSON: '下一步：先把 package.json 的 JSON 语法修好（缺引号、多逗号最常见），再重试打包。',
  PKG_NOT_OBJECT: '下一步：package.json 顶层必须是一个 JSON 对象（{ ... }），修好后重试。',
  NO_ELECTRON:
    '下一步：如果这是网页项目，改用『部署静态网站』（不需要 exe）；如果确实要做桌面应用，先用『搭建项目』建 Electron 工程并装上 electron 依赖，再回来打包。',
  NO_MAIN: '下一步：在 package.json 里补一个 "main": "main.js" 这类入口声明（入口文件必须真实存在），再重试打包。',
  MAIN_MISSING: '下一步：把上面那个入口文件补上，或把 main 改成真实存在的文件，然后重试打包。',
  MAIN_DIR_NO_INDEX: '下一步：把 main 指向具体文件（如 main.js），或在该目录补一个 index.js，然后重试打包。',
  OUTDIR_ESCAPE: '下一步：把 outDir 改成工作区内的路径，或留空（默认 <appDir>/dist），然后重试。',
  CFG_PATCH: '下一步：按上面的原因修好 package.json（或磁盘写权限）后重试；原文件已备份，可原样恢复。',
  NO_BUILDER: '下一步：先在工程里执行 npm i -D electron-builder（或确认本应用自带的 electron-builder 可用），再重试。',
  TIMEOUT: '下一步：看上面日志尾部卡在哪一步；如果是在解压/下载 electron，调大 timeoutMs（如 900000）后重跑一次。',
  NO_SPAWN: '下一步：按上面的子进程错误（ENOENT/权限）排查 electron-builder 是否真的可执行，修好再重试。',
  EXIT_NONZERO:
    '下一步：按上面日志尾部的**第一条报错**修（不要凭猜测改参数），修好后重跑一次；在真的拿到 exe 之前不要说成功。',
  NO_ARTIFACT:
    '下一步：把上面日志尾部的报错贴出来定位（常见：electron 下载失败、磁盘空间不足、target 配错），重跑一次。' +
    '**不要**在没拿到 exe 的情况下说成功，也不要去启动一个不存在的程序。',
  UNKNOWN: '下一步：按上面的原因修好后重跑一次；在真的拿到 exe 之前不要说成功。',
};

/**
 * 取某类失败的下一步动作。
 * @param {string} code 失败码（见 FAILURE_NEXT_STEPS 的键）
 * @returns {string} 下一步文案
 */
function nextStepForFailure(code) {
  return FAILURE_NEXT_STEPS[asText(code)] || FAILURE_NEXT_STEPS.UNKNOWN;
}

/**
 * 工作区根目录（每次调用时求值，便于单测用 AGENT_WORKSPACE 指向夹具目录）。
 * 与 skills/project-scaffold/run.js 保持同一约定。
 * @returns {string} 绝对路径
 */
function workspaceRoot() {
  return path.resolve(
    process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace')
  );
}

/**
 * 把字符串参数收敛成非空 trim 文本。
 * @param {*} v 任意入参
 * @returns {string} 结果
 */
function asText(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * 校验并把 target 参数收敛成合法值。
 * @param {*} raw 入参
 * @returns {{ok:boolean, target:string, message:string}}
 */
function normalizeTarget(raw) {
  const text = asText(raw).toLowerCase();
  if (!text) return { ok: true, target: DEFAULT_TARGET, message: '' };
  if (VALID_TARGETS.indexOf(text) >= 0) return { ok: true, target: text, message: '' };
  return {
    ok: false,
    target: DEFAULT_TARGET,
    message:
      '打包失败：target 只能是 ' +
      VALID_TARGETS.join(' / ') +
      ' 三者之一，收到的是「' +
      text +
      '」。' +
      '（portable=单文件免安装 exe，nsis=安装包，dir=只出 win-unpacked 目录）',
  };
}

/**
 * 解析 appDir：相对路径按工作区解析，且结果必须仍在工作区内。
 * 注意：path.resolve 会规范化正/反斜杠，不能拿原始字符串直接 startsWith 比较
 * （skills/project-scaffold/run.js:24-26 已记录过这个坑）。
 * @param {*} raw 入参
 * @returns {{ok:boolean, appDir:string, message:string}}
 */
function resolveAppDir(raw) {
  const ws = workspaceRoot();
  const text = asText(raw);
  if (!text) {
    return {
      ok: false,
      appDir: '',
      code: 'APPDIR_MISSING',
      message:
        '打包失败：没有给 appDir 参数 —— 不知道要打包哪个工程。' +
        '请传一个 Electron 工程目录（相对工作区 ' +
        ws +
        ' 或绝对路径）。',
    };
  }
  const abs = path.resolve(ws, text);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    return {
      ok: false,
      appDir: abs,
      code: 'APPDIR_ESCAPE',
      message:
        '打包失败：' +
        abs +
        ' 不在工作区 ' +
        ws +
        ' 内，拒绝打包。请把工程放进工作区，或把 appDir 写成工作区内的路径。',
    };
  }
  return { ok: true, appDir: abs, code: 'OK', message: '' };
}

/**
 * 解析 outDir：相对路径按 appDir 解析，默认 <appDir>/dist；结果必须仍在工作区内。
 * @param {*} raw 入参
 * @param {string} appDir 工程目录（绝对路径）
 * @returns {{ok:boolean, outDir:string, message:string}}
 */
function resolveOutDir(raw, appDir) {
  const ws = workspaceRoot();
  const text = asText(raw);
  const abs = text ? path.resolve(appDir, text) : path.join(appDir, 'dist');
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    return {
      ok: false,
      outDir: abs,
      message:
        '打包失败：outDir ' +
        abs +
        ' 不在工作区 ' +
        ws +
        ' 内，拒绝把产物写到工作区外。请改成工作区内的路径，或留空（默认 <appDir>/dist）。',
    };
  }
  return { ok: true, outDir: abs, message: '' };
}

/**
 * 读 package.json 里是否声明了 electron 依赖。
 * @param {object} pkg package.json 对象
 * @returns {{found:boolean, version:string, field:string}} 结果
 */
function findElectronDep(pkg) {
  const groups = ['dependencies', 'devDependencies'];
  for (const g of groups) {
    const box = pkg && pkg[g];
    if (box && typeof box === 'object' && Object.prototype.hasOwnProperty.call(box, 'electron')) {
      return { found: true, version: asText(box.electron), field: g };
    }
  }
  return { found: false, version: '', field: '' };
}

/**
 * 读取并列出某个依赖段的键名（用于失败文案里给出实况）。
 * @param {object} pkg package.json 对象
 * @param {string} field 依赖段名
 * @returns {string} 逗号分隔的键名，空则「(空)」
 */
function depKeys(pkg, field) {
  const box = pkg && pkg[field];
  if (!box || typeof box !== 'object') return '(空)';
  const keys = Object.keys(box);
  return keys.length ? keys.join(', ') : '(空)';
}

/**
 * 前置检查：不通过就返回**具体**的一句话，绝不合并成「校验不通过」。
 *
 * 六种互不相同的失败：
 *   ① 目录不存在（带期望路径）
 *   ② 没有 package.json（这不是 Node/Electron 工程）
 *   ③ package.json 解析失败（带 JSON 解析错误原文）
 *   ④ 没有 electron 依赖（不是 Electron 应用）
 *   ⑤ 缺 main 字段（不知道入口）
 *   ⑥ main 指向的文件不存在（带实际解析出来的绝对路径）
 *
 * @param {string} appDir 工程绝对路径
 * @returns {{ok:boolean, code:string, message:string, pkg:object|null, pkgPath:string, mainAbs:string}}
 */
function precheckProject(appDir) {
  const pkgPath = path.join(appDir, 'package.json');
  const fail = (code, message) => ({ ok: false, code, message, pkg: null, pkgPath, mainAbs: '' });

  // ① 目录不存在 / 不是目录
  let st = null;
  try {
    st = fs.statSync(appDir);
  } catch (e) {
    st = null;
  }
  if (!st) {
    return fail(
      'NO_DIR',
      '打包失败：目录不存在 —— 「' +
        appDir +
        '」。期望路径就是它（相对路径按工作区 ' +
        workspaceRoot() +
        ' 解析）。请先用「文件列表」确认工程建在哪里了。'
    );
  }
  if (!st.isDirectory()) {
    return fail(
      'NOT_DIR',
      '打包失败：' + appDir + ' 是一个文件，不是目录 —— 打包要的是 Electron 工程目录本身。'
    );
  }

  // ② 没有 package.json
  if (!fs.existsSync(pkgPath)) {
    return fail(
      'NO_PKG',
      '打包失败：' +
        appDir +
        ' 下没有 package.json —— 这不是一个 Node/Electron 工程。' +
        '请先用「搭建项目」把 Electron 工程建起来（至少要有 package.json、main 入口、electron 依赖）。'
    );
  }

  // ③ JSON 解析失败
  let rawText = '';
  try {
    rawText = fs.readFileSync(pkgPath, 'utf8');
  } catch (e) {
    return fail('PKG_UNREADABLE', '打包失败：package.json 读不出来（' + pkgPath + '）：' + e.message);
  }
  let pkg = null;
  try {
    pkg = JSON.parse(rawText);
  } catch (e) {
    return fail(
      'PKG_JSON',
      '打包失败：package.json 解析失败（' + pkgPath + '）：' + e.message + '。请先修好这个 JSON 再打包。'
    );
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return fail('PKG_NOT_OBJECT', '打包失败：package.json 不是一个对象（' + pkgPath + '）。');
  }

  // ④ 没有 electron 依赖
  const dep = findElectronDep(pkg);
  if (!dep.found) {
    return fail(
      'NO_ELECTRON',
      '打包失败：这个工程不是 Electron 应用 —— package.json 的 dependencies 与 devDependencies 里都没有 electron 依赖' +
        '（现在的 dependencies=' +
        depKeys(pkg, 'dependencies') +
        '，devDependencies=' +
        depKeys(pkg, 'devDependencies') +
        '）。要打包成 exe 必须有 electron；如果这是网页项目，请改用「部署静态网站」。'
    );
  }

  // ⑤ 缺 main 字段
  const mainField = asText(pkg.main);
  if (!mainField) {
    return fail(
      'NO_MAIN',
      '打包失败：package.json 缺 main 字段，不知道入口是哪个文件。请补一个 "main": "main.js" 这类入口声明（本技能不会替你猜入口）。'
    );
  }

  // ⑥ main 指向的文件不存在
  const mainAbs = path.resolve(appDir, mainField);
  let mainSt = null;
  try {
    mainSt = fs.statSync(mainAbs);
  } catch (e) {
    mainSt = null;
  }
  if (!mainSt) {
    return fail(
      'MAIN_MISSING',
      '打包失败：package.json 的 main 字段（"' +
        mainField +
        '"）指向的文件不存在 —— 实际解析到的绝对路径是 ' +
        mainAbs +
        '。请把这个入口文件补上，或把 main 改成真实存在的文件。'
    );
  }
  if (mainSt.isDirectory()) {
    const indexAbs = path.join(mainAbs, 'index.js');
    if (!fs.existsSync(indexAbs)) {
      return fail(
        'MAIN_DIR_NO_INDEX',
        '打包失败：package.json 的 main 字段指向目录 ' +
          mainAbs +
          '，但这个目录里没有 index.js（实际检查的绝对路径是 ' +
          indexAbs +
          '）。'
      );
    }
  }

  return { ok: true, code: 'OK', message: '', pkg, pkgPath, mainAbs };
}

/**
 * 判断 package.json 里是否已经有可用的打包配置（三选一命中即算有）。
 * @param {object} pkg package.json 对象
 * @returns {string[]} 命中的证据（空数组 = 没有配置，需要补）
 */
function detectBuildConfig(pkg) {
  const hits = [];
  const build = pkg && pkg.build;
  if (build && typeof build === 'object' && !Array.isArray(build) && Object.keys(build).length > 0) {
    hits.push('package.json 已有 build 段（' + Object.keys(build).join(', ') + '）');
  }
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const candidates = ['dist', 'dist:win', 'build', 'build:win', 'pack', 'package', 'make', 'release'];
  const scriptHits = candidates.filter(
    (n) => typeof scripts[n] === 'string' && scripts[n].trim() !== ''
  );
  if (scriptHits.length > 0) hits.push('scripts 里已有打包脚本 ' + scriptHits.join('/'));
  const devBox = (pkg && pkg.devDependencies) || {};
  const depBox = (pkg && pkg.dependencies) || {};
  if (Object.prototype.hasOwnProperty.call(devBox, 'electron-builder') ||
      Object.prototype.hasOwnProperty.call(depBox, 'electron-builder')) {
    hits.push('依赖里已有 electron-builder');
  }
  return hits;
}

/**
 * 生成时间戳字符串（用于备份文件名）：YYYYMMDD-HHmmss。
 * @param {number} ms 毫秒时间戳
 * @returns {string} 结果
 */
function stampOf(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()) +
    p2(d.getMonth() + 1) +
    p2(d.getDate()) +
    '-' +
    p2(d.getHours()) +
    p2(d.getMinutes()) +
    p2(d.getSeconds())
  );
}

/**
 * 工程名 → appId 用的 slug：小写、非字母数字折成 `-`。
 * @param {string} text 原始工程名
 * @returns {string} slug
 */
function slugOf(text) {
  const s = asText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'app';
}

/**
 * 读某个包的版本号（读不到返回空串，绝不抛）。
 * @param {string} pkgJsonPath package.json 绝对路径
 * @returns {string} 版本
 */
function readVersion(pkgJsonPath) {
  try {
    const obj = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    return asText(obj.version);
  } catch (e) {
    return '';
  }
}

/**
 * 补齐打包配置：没有可用配置时，先备份 package.json，再写入最小可用的 build 段
 * 与 electron-builder devDependency。
 *
 * 红线：
 *   · 改文件前必须备份（package.json.bak-douya-<时间戳>），备份路径进返回值；
 *   · 绝不改动既有的 main / name / version / dependencies / scripts 等任何已有字段；
 *   · 补完用 JSON.stringify(obj, null, 2) 写回，保持 2 空格缩进。
 *
 * @param {{appDir:string, pkg:object, pkgPath:string, now:number}} ctx 上下文
 * @returns {{patched:boolean, backupPath:string, addedKeys:string[], evidence:string[], productName:string, appId:string, message:string}}
 */
function ensureBuildConfig(ctx) {
  const pkg = ctx.pkg;
  const evidence = detectBuildConfig(pkg);
  const productName = asText(
    (pkg.build && pkg.build.productName) || pkg.name || path.basename(ctx.appDir)
  );
  const appId = 'com.douya.' + slugOf(pkg.name || path.basename(ctx.appDir));

  if (evidence.length > 0) {
    // 已有配置：一个字节都不动（幂等的关键 —— 第二次调用走的就是这条路）
    return {
      patched: false,
      backupPath: '',
      addedKeys: [],
      evidence,
      productName,
      appId: asText((pkg.build && pkg.build.appId) || appId),
      message: 'package.json 已有可用打包配置，未改动：' + evidence.join('；'),
    };
  }

  // ① 先备份（备份失败就不改文件，宁可不补也不能无备份地改）
  const backupPath = ctx.pkgPath + '.bak-douya-' + stampOf(ctx.now);
  try {
    fs.copyFileSync(ctx.pkgPath, backupPath);
  } catch (e) {
    return {
      patched: false,
      backupPath: '',
      addedKeys: [],
      evidence: [],
      productName,
      appId,
      message:
        '打包失败：想补打包配置，但备份 package.json 失败（' +
        backupPath +
        '）：' +
        e.message +
        '。没有备份就不改文件，因此本次没有开始打包。',
    };
  }

  // ② 构造新对象：深拷贝既有内容，只**追加**缺失的键
  const next = JSON.parse(JSON.stringify(pkg));
  const addedKeys = [];

  next.build = {
    appId,
    productName,
    files: ['**/*', '!node_modules/.cache/**'],
    win: { target: DEFAULT_TARGET },
  };
  addedKeys.push('build');

  const devDeps = Object.assign({}, pkg.devDependencies || {});
  const builderVersion =
    readVersion(path.join(REPO_ROOT, 'node_modules', 'electron-builder', 'package.json')) ||
    FALLBACK_BUILDER_VERSION;
  if (!devDeps['electron-builder']) {
    devDeps['electron-builder'] = '^' + builderVersion;
    next.devDependencies = devDeps;
    addedKeys.push('devDependencies.electron-builder');
  }
  // electron-builder 对缺 description / author 的工程会告警甚至拒绝出包，缺则补
  if (!asText(next.description)) {
    next.description = productName + '（由豆芽打包）';
    addedKeys.push('description');
  }
  if (!asText(next.author) && !(next.author && typeof next.author === 'object')) {
    next.author = 'Douya';
    addedKeys.push('author');
  }

  try {
    fs.writeFileSync(ctx.pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (e) {
    return {
      patched: false,
      backupPath,
      addedKeys: [],
      evidence: [],
      productName,
      appId,
      message:
        '打包失败：写回 package.json 失败（' +
        ctx.pkgPath +
        '）：' +
        e.message +
        '。原文件已备份在 ' +
        backupPath +
        '，可以原样恢复。',
    };
  }

  return {
    patched: true,
    backupPath,
    addedKeys,
    evidence: [],
    productName,
    appId,
    message:
      'package.json 原本没有打包配置，已自动补写 ' +
      addedKeys.join(' + ') +
      '（改前已备份 → ' +
      backupPath +
      '；main / name / version / dependencies 一个字节都没动）。',
  };
}

/**
 * 找 electron-builder 的 cli.js：工程自身 → 本应用仓库 → npx 兜底。
 *
 * 用 `node <cli.js>` 而不是 `.bin/electron-builder.cmd`：Windows 上 .cmd 必须经 shell 派生，
 * 路径带空格时引号处理极易出错；直接喂 node 一个 js 入口则没有任何引号/转义问题，
 * 且 stdout / stderr 全程可读。
 *
 * @param {string} appDir 工程绝对路径
 * @returns {{ok:boolean, cmd:string, args:string[], display:string, version:string, source:string, shell:boolean, message:string}}
 */
function resolveBuilder(appDir) {
  const candidates = [
    { source: '工程自身 node_modules', dir: path.join(appDir, 'node_modules', 'electron-builder') },
    { source: '本应用仓库 node_modules', dir: path.join(REPO_ROOT, 'node_modules', 'electron-builder') },
  ];
  for (const c of candidates) {
    const cli = path.join(c.dir, 'out', 'cli', 'cli.js');
    if (fs.existsSync(cli)) {
      const version = readVersion(path.join(c.dir, 'package.json'));
      return {
        ok: true,
        cmd: process.execPath,
        args: [cli],
        display: 'node ' + cli + '（electron-builder ' + (version || '版本未知') + '，来自' + c.source + '）',
        version: version || '未知',
        source: c.source,
        shell: false,
        message: '',
      };
    }
  }
  // npx 兜底：本机会真的去装一份，慢且依赖网络，因此把这件事写进返回值
  return {
    ok: true,
    cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', 'electron-builder@' + FALLBACK_BUILDER_VERSION],
    display:
      'npx --yes electron-builder@' +
      FALLBACK_BUILDER_VERSION +
      '（工程与本应用仓库都没有 electron-builder，本机将现装一份）',
    version: FALLBACK_BUILDER_VERSION,
    source: 'npx（现装）',
    shell: process.platform === 'win32',
    message: '',
  };
}

/**
 * 找本地的 electron 二进制目录，命中就通过 `--config.electronDist` 指过去。
 *
 * 为什么值得做：electron-builder 默认要下载 100MB+ 的 electron 压缩包；
 * 而工程自己的 `node_modules/electron/dist` 往往已经解压好了（275MB 现场就是这样）。
 * 指过去就完全不碰网络，也避免 `github.com` 不可达时整次打包失败。
 * 注意 app-builder-lib 对 win32 的 srcDir 就是「你给的这个目录」，所以要求目录里真有 electron.exe。
 *
 * @param {string} appDir 工程绝对路径
 * @returns {string} 可用则返回绝对路径，否则空串
 */
function findLocalElectronDist(appDir) {
  const dist = path.join(appDir, 'node_modules', 'electron', 'dist');
  try {
    if (fs.existsSync(path.join(dist, 'electron.exe')) || fs.existsSync(path.join(dist, 'electron'))) {
      return dist;
    }
  } catch (e) {
    /* 读不到就当没有 */
  }
  return '';
}

/**
 * 递归列出目录下所有文件（读不到的子目录静默跳过）。
 * @param {string} dir 目录
 * @param {string[]} acc 累加器
 * @returns {string[]} 文件绝对路径
 */
function walkFiles(dir, acc) {
  const out = acc || [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/**
 * 取文件字节数（读不到返回 0）。
 * @param {string} file 文件绝对路径
 * @returns {number} 字节数
 */
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

/**
 * 去 outDir 里真找产物：顶层 exe（安装包 / 便携版）与 win-unpacked 目录。
 * @param {string} outDir 输出目录
 * @returns {{outDir:string, exists:boolean, topExe:string[], unpackedDir:string, unpackedExe:string[], unpackedTotalBytes:number}}
 */
function inspectOutput(outDir) {
  const res = {
    outDir,
    exists: fs.existsSync(outDir),
    topExe: [],
    unpackedDir: path.join(outDir, 'win-unpacked'),
    unpackedExe: [],
    unpackedTotalBytes: 0,
  };
  if (!res.exists) return res;

  let entries = [];
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch (e) {
    entries = [];
  }
  for (const ent of entries) {
    if (ent.isFile() && /\.exe$/i.test(ent.name)) res.topExe.push(path.join(outDir, ent.name));
  }

  if (fs.existsSync(res.unpackedDir)) {
    const files = walkFiles(res.unpackedDir);
    let total = 0;
    for (const f of files) total += sizeOf(f);
    res.unpackedTotalBytes = total;
    res.unpackedExe = files.filter((f) => /\.exe$/i.test(f));
  }
  return res;
}

/**
 * 按 target 核对产物并给出判定。**不看退出码**，只看真文件。
 * @param {string} target 产物形态
 * @param {object} out inspectOutput 的返回
 * @param {string} productName 产物名（win-unpacked 里的 exe 名）
 * @returns {{ok:boolean, artifacts:Array<{path:string,bytes:number,kind:string}>, problems:string[]}}
 */
function judgeArtifacts(target, out, productName) {
  const artifacts = [];
  const problems = [];

  if (target === 'dir') {
    if (!out.exists) {
      problems.push('outDir 不存在：' + out.outDir);
      return { ok: false, artifacts, problems };
    }
    const wantAbs = path.resolve(out.unpackedDir, productName + '.exe');
    const hit =
      out.unpackedExe.find((f) => path.resolve(f).toLowerCase() === wantAbs.toLowerCase()) ||
      out.unpackedExe[0] ||
      '';
    if (!hit) {
      problems.push('win-unpacked 里没有 exe（期望 ' + wantAbs + '）');
      return { ok: false, artifacts, problems };
    }
    artifacts.push({ path: hit, bytes: sizeOf(hit), kind: 'win-unpacked 主程序' });
    if (out.unpackedTotalBytes < MIN_UNPACKED_TOTAL_BYTES) {
      problems.push(
        'win-unpacked 整目录只有 ' +
          out.unpackedTotalBytes +
          ' 字节（' +
          mb(out.unpackedTotalBytes) +
          ' MB），不到 ' +
          mb(MIN_UNPACKED_TOTAL_BYTES) +
          ' MB —— 不像一个真的 Electron 应用（正常 100~250MB）'
      );
    }
    return { ok: problems.length === 0, artifacts, problems };
  }

  // portable / nsis：只认 outDir **顶层** 的 exe（win-unpacked 里那个是改名后的 electron.exe，不算交付物）
  const top = out.topExe.slice();
  if (target === 'nsis') {
    const setup = top.filter((f) => /setup/i.test(path.basename(f)));
    if (setup.length > 0) {
      top.length = 0;
      for (const f of setup) top.push(f);
    }
  }
  if (top.length === 0) {
    problems.push(
      'outDir（' +
        out.outDir +
        '）顶层没有 ' +
        (target === 'nsis' ? 'setup 安装包 exe' : '便携版 exe') +
        '（win-unpacked 里那个 electron.exe 不算交付物）'
    );
    return { ok: false, artifacts, problems };
  }
  for (const f of top) {
    const bytes = sizeOf(f);
    artifacts.push({ path: f, bytes, kind: target === 'nsis' ? 'NSIS 安装包' : '便携版单文件 exe' });
    if (bytes < MIN_INSTALLER_BYTES) {
      problems.push(
        path.basename(f) +
          ' 只有 ' +
          bytes +
          ' 字节（' +
          mb(bytes) +
          ' MB）—— 不像一个真的 Electron 应用（正常 60~200MB）'
      );
    }
  }
  return { ok: problems.length === 0, artifacts, problems };
}

/**
 * 字节 → 可读 MB（保留 1 位小数）。
 * @param {number} bytes 字节数
 * @returns {string} 例如 "87.5"
 */
function mb(bytes) {
  return (Number(bytes || 0) / (1024 * 1024)).toFixed(1);
}

/**
 * 杀掉子进程树（Windows 用 taskkill /T /F，否则 SIGKILL）。
 * @param {import('child_process').ChildProcess} child 子进程
 * @returns {void}
 */
function killTree(child) {
  try {
    if (process.platform === 'win32' && child && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } else if (child) {
      child.kill('SIGKILL');
    }
  } catch (e) {
    /* 杀不掉也要继续走收尾 */
  }
  try {
    if (child) child.kill('SIGKILL');
  } catch (e) {
    /* ignore */
  }
}

/**
 * 子进程环境变量：从宿主 env 里**剔除会污染构建的注入项**。
 *
 * 为什么必须剔（2026-10-30 实测，两条都是真事故）：
 *   ① `NODE_OPTIONS=--require=<node-language-shim.cjs>` —— 宿主 CLI 注入的 shim 会二次
 *      `require('node-safe-delete-shim')`，把 `fs.rm` 改写成「丢进回收站」。electron-builder
 *      内部用 fs-extra 的 emptyDir/remove 清理 win-unpacked，于是整次打包直接挂在
 *        `[safe-delete] 操作失败: ERROR … Error during a trash operation: Unknown`
 *      （栈里能看到 node-safe-delete-shim.cjs:300 trashViaBinary）。子进程不该继承宿主的 monkey patch。
 *   ② `ELECTRON_RUN_AS_NODE=1` —— 会让任何 electron 可执行文件以 Node 模式跑起来、不开窗口，
 *      与 skills/desktop-verify 剔除它是同一个原因。
 * 另外把 PATH 里指向 `…/cli/vendor/shim/safe-bin` 的目录段摘掉：那是同一套 shim 的命令行影子，
 * 留着会让子进程里的 `node`/`rm` 之类命令走到代理实现上去。
 *
 * @returns {object} 可安全传给 spawn 的 env
 */
function buildChildEnv() {
  const env = Object.assign({}, process.env);
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const rawPath = asText(env.PATH || env.Path || '');
  if (rawPath) {
    const kept = rawPath
      .split(path.delimiter)
      .filter((p) => p && !/app\.asar\.unpacked[\\/]+cli[\\/]+vendor[\\/]+shim/i.test(p));
    env.PATH = kept.join(path.delimiter);
    // Windows 上环境变量名大小写不敏感，Path / PATH 同时存在会让后者被忽略，这里统一成一个
    delete env.Path;
  }
  // 关掉代码签名自动发现：没证书时它会去翻证书库并反复失败，白白拖慢几分钟
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return env;
}

/**
 * 清掉 win-unpacked 根目录上残留的构建临时物（`*.tmp`）。
 *
 * 起因：rcedit 的工作方式是「在目标 exe 旁边写临时文件 → 改名覆盖」。改名失败时临时文件
 * 留在原地（本项目 2026-09-23 实测过 0 字节的 RCX*.tmp，2026-10-30 实测过 4 个 188MB 的），
 * 而 portable / nsis 会把整个 win-unpacked 打进去 ⇒ 垃圾进安装包。
 * 只按「根层 + .tmp 后缀」这一最窄特征删，绝不递归、绝不碰其他文件。
 *
 * @param {string} unpackedDir win-unpacked 绝对路径
 * @returns {string[]} 被删掉的文件名
 */
function cleanStaleTempAtRoot(unpackedDir) {
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(unpackedDir, { withFileTypes: true });
  } catch (e) {
    return removed;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !/\.tmp$/i.test(ent.name)) continue;
    try {
      fs.rmSync(path.join(unpackedDir, ent.name), { force: true });
      removed.push(ent.name);
    } catch (e) {
      /* 删不掉就留着，由下一次 electron-builder 自己 emptyDir */
    }
  }
  return removed;
}

/**
 * 判断一次失败是否属于「改 exe 版本信息/图标那一步（rcedit）」的已知瞬态故障。
 * @param {string} output stdout+stderr 合并文本
 * @returns {boolean} 是否属于该特征
 */
function looksLikeExecutableEditFailure(output) {
  const text = String(output || '');
  return /Unable to commit changes/i.test(text) || /rcedit/i.test(text);
}

/**
 * 真实打包执行器：spawn 子进程、收集全部 stdout/stderr（尾部 4000 字）、超时杀树。
 * **不用 spawnSync** —— 本机实测同步派生 GUI 型子进程会返回 EBUSY 且 status===null，
 * 把「子进程根本没起来」错读成「没输出」，进而把假绿当结论。
 *
 * @param {{cmd:string, args:string[], cwd:string, env:object, timeoutMs:number, shell:boolean}} spec 执行规格
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, spawnError:Error|null}>}
 */
function realRunBuilder(spec) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawnError = null;

    const appendTail = (prev, chunk) => {
      // 【解码分类：electron-builder 的 stdout+stderr → 全是"给人看的结论" ⇒ GBK 回退】
      //   这两条流的唯一下游是 `composeReport()`：`builderDisplay` / `problems` 直接拼进
      //   返回给用户和模型的文案（"【打包结果】❌ 失败…发现的问题：…"），**没有任何**
      //   JSON.parse / 结构化取值。
      //   而 electron-builder 在 Windows 上是 node 进程（utf8），它内部再派生的 rcedit /
      //   node-gyp / 7za 等原生工具走的是控制台代码页（cp936）。工程路径里有中文时
      //   （用户素材目录、中文用户名），这些工具的行就会在报告里变成一串 `�`。
      //   ⇒ 原写法 `String(chunk)`（= utf8 硬解）换成 decodeOutput()：合法 utf8 与纯 ASCII
      //     的结果与原先逐字节一致，只在 utf8 解出 FFFD 而 gbk 更干净时才切 GBK。
      const next = prev + decodeOutput(chunk);
      return next.length > OUTPUT_TAIL_LIMIT ? next.slice(next.length - OUTPUT_TAIL_LIMIT) : next;
    };

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, spawnError });
    };

    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: !!spec.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      spawnError = e;
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: e });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1000, spec.timeoutMs));

    if (child.stdout) child.stdout.on('data', (c) => { stdout = appendTail(stdout, c); });
    if (child.stderr) child.stderr.on('data', (c) => { stderr = appendTail(stderr, c); });
    child.on('error', (e) => { spawnError = e; finish(null, null); });
    child.on('close', (code, signal) => { finish(code, signal); });
  });
}

/**
 * 组装最终返回文本（模型据此做下一步判断，因此每一项都要在）。
 * @param {object} st 状态对象
 * @returns {string} 给人看/给模型看的结论
 */
function composeReport(st) {
  const lines = [];
  lines.push(st.ok ? '【打包结果】✅ 成功：已生成可双击运行的程序' : '【打包结果】❌ 失败：没有拿到可用的 exe');
  lines.push('');
  lines.push('工程目录：' + st.appDir);
  lines.push('产物形态：' + st.target + '（' + TARGET_LABEL[st.target] + '）');
  lines.push('输出目录：' + st.outDir);
  if (st.builderDisplay) lines.push('electron-builder：' + st.builderDisplay);
  if (st.electronSource) lines.push('electron 二进制：' + st.electronSource);
  if (st.configMessage) lines.push('package.json：' + st.configMessage);

  if (st.artifacts && st.artifacts.length) {
    lines.push('');
    lines.push('产物清单（绝对路径 + 字节数）：');
    for (const a of st.artifacts) {
      lines.push('  · ' + a.path + '  [' + a.kind + ']  ' + a.bytes + ' 字节（' + mb(a.bytes) + ' MB）');
    }
  }

  if (st.unpackedSummary) {
    lines.push('');
    lines.push('附：win-unpacked 目录 ' + st.unpackedSummary);
  }

  if (st.problems && st.problems.length) {
    lines.push('');
    lines.push('发现的问题：');
    for (const p of st.problems) lines.push('  · ' + p);
  }

  if (st.attemptNotes && st.attemptNotes.length) {
    lines.push('');
    lines.push('重试记录：');
    for (const n of st.attemptNotes) lines.push('  · ' + n);
  }

  if (st.checks && st.checks.length) {
    lines.push('');
    lines.push('前置检查：' + st.checks.join(' / '));
  }

  if (st.seconds != null) lines.push('耗时：' + st.seconds + ' 秒');

  if (st.outputTail) {
    lines.push('');
    lines.push('打包日志尾部（最多 4000 字）：');
    lines.push(st.outputTail);
  }

  // 下一步：**成功才**写死「去桌面窗口验收」；失败按 st.nextStep 给对应动作。
  // 成功与失败互斥（不要合并：没打出 exe 时让人去启动 = 制造「承认有问题但不解决」的打转）。
  const nextStep = st.ok ? NEXT_STEP : asText(st.nextStep);
  if (nextStep) {
    lines.push('');
    lines.push(nextStep);
  }
  return lines.join('\n');
}

/**
 * 组装失败文案（前置检查/参数阶段的早退路径：没有开始打包）。
 * @param {{appDir?:string, target?:string, outDir?:string, message:string, code?:string}} ctx 上下文
 * @returns {string} 结论
 */
function earlyFail(ctx) {
  // 各分支的 message 都以「打包失败：」开头（便于单测按句取值）；这里统一剥掉前缀，
  // 避免拼出「【打包结果】❌ 失败：打包失败：…」这种重复。
  const reason = asText(ctx.message).replace(/^打包失败[：:]\s*/, '');
  const lines = ['【打包结果】❌ 失败：' + reason, '', '没有开始打包（前置检查未通过，未执行任何 electron-builder 命令）。'];
  if (ctx.appDir) lines.push('工程目录：' + ctx.appDir);
  if (ctx.target) lines.push('产物形态：' + ctx.target);
  if (ctx.outDir) lines.push('输出目录：' + ctx.outDir);
  // 失败路径**只**给本类失败的动作，绝不带「去桌面窗口验收」（那时根本没有 exe 可启动）。
  const nextStep = nextStepForFailure(ctx.code);
  lines.push('');
  lines.push(nextStep);
  return lines.join('\n');
}

/**
 * 可注入依赖的核心执行体（生产入口 run() 用真实 spawn，单测用假 runBuilder）。
 * @param {object} rawParams 技能参数
 * @param {{runBuilder?:Function, now?:Function}} deps 注入依赖
 * @returns {Promise<string>} 结论文本
 */
async function runWith(rawParams, deps) {
  const d = Object.assign({ runBuilder: realRunBuilder, now: () => Date.now() }, deps || {});
  const params = rawParams || {};
  const startedAt = d.now();

  // ① target
  const tg = normalizeTarget(params.target);
  if (!tg.ok) return earlyFail({ target: asText(params.target), message: tg.message, code: 'BAD_TARGET' });
  const target = tg.target;

  // ② appDir（解析 + 工作区边界）
  const ap = resolveAppDir(params.appDir);
  if (!ap.ok) return earlyFail({ target, message: ap.message, code: ap.code });
  const appDir = ap.appDir;

  // ③ 六项前置检查：任何一项不过就绝不开始打包（code 决定失败路径的下一步动作）
  const pre = precheckProject(appDir);
  if (!pre.ok) return earlyFail({ appDir, target, message: pre.message, code: pre.code });

  // ④ outDir
  const od = resolveOutDir(params.outDir, appDir);
  if (!od.ok) return earlyFail({ appDir, target, outDir: od.outDir, message: od.message, code: 'OUTDIR_ESCAPE' });
  const outDir = od.outDir;

  // ⑤ 超时（内层比外层技能超时小 5 秒，好让我们先返回「打包超时 + 日志尾部」）
  let timeoutMs = DEFAULT_TIMEOUT_MS - OUTER_TIMEOUT_GUARD_MS;
  const rawTimeout = asText(params.timeoutMs);
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (Number.isFinite(parsed) && parsed >= 30000) timeoutMs = Math.min(parsed, 1800000);
  }

  // ⑥ 补齐打包配置（缺则备份 + 补写；有则一个字节都不动）
  const cfg = ensureBuildConfig({ appDir, pkg: pre.pkg, pkgPath: pre.pkgPath, now: d.now() });
  if (!cfg.patched && cfg.message.indexOf('打包失败') === 0) {
    return earlyFail({ appDir, target, outDir, message: cfg.message, code: 'CFG_PATCH' });
  }

  // ⑦ 找 electron-builder
  const builder = resolveBuilder(appDir);
  if (!builder.ok) return earlyFail({ appDir, target, outDir, message: builder.message, code: 'NO_BUILDER' });

  // ⑧ 真跑打包
  const electronDist = findLocalElectronDist(appDir);
  const env = buildChildEnv();
  const deadline = startedAt + timeoutMs;

  /**
   * 构造一次打包的执行规格。
   * @param {{noEditExecutable:boolean, budgetMs:number}} opts 选项
   * @returns {object} 交给 runBuilder 的规格
   */
  const makeSpec = (opts) => {
    const args = builder.args.concat([
      '--win',
      target,
      '--publish',
      'never',
      '--config.directories.output=' + outDir,
    ]);
    if (electronDist) args.push('--config.electronDist=' + electronDist);
    // 降级重试专用：跳过「改 exe 版本信息/图标」这一步（rcedit 在本机是已知瞬态故障点）
    if (opts.noEditExecutable) args.push('--config.win.signAndEditExecutable=false');
    return {
      cmd: builder.cmd,
      args,
      cwd: appDir,
      env,
      timeoutMs: Math.max(60000, opts.budgetMs),
      shell: builder.shell,
      outDir,
      productName: cfg.productName,
      target,
    };
  };

  // 第 1 次：标准配置
  const attempts = [];
  let run = await d.runBuilder(makeSpec({ noEditExecutable: false, budgetMs: timeoutMs }));
  attempts.push({ label: '第 1 次（标准配置）', run, degraded: false });

  // 第 2 次（仅在命中「改 exe 元信息」这条已知瞬态故障时）：关掉 signAndEditExecutable 重试一次。
  // 为什么不直接默认关掉：关掉后 exe 的属性/图标就是 electron 默认值，能少一步就少一步降级。
  if (
    run.code !== 0 &&
    !run.timedOut &&
    !run.spawnError &&
    looksLikeExecutableEditFailure([run.stdout, run.stderr].join('\n'))
  ) {
    const cleaned = cleanStaleTempAtRoot(path.join(outDir, 'win-unpacked'));
    const second = await d.runBuilder(
      makeSpec({ noEditExecutable: true, budgetMs: deadline - d.now() })
    );
    attempts.push({
      label: '第 2 次（关闭 exe 版本信息/图标编辑）',
      run: second,
      degraded: true,
      cleaned,
    });
    run = second;
  }

  const seconds = Math.max(0, Math.round((d.now() - startedAt) / 1000));
  const outputTail = attempts
    .map((a) => {
      const body = [a.run.stdout, a.run.stderr].filter((s) => s && s.trim()).join('\n----\n').trim();
      return body ? '### ' + a.label + '\n' + body : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const attemptNotes = attempts.slice(1).map((a) => {
    const cleanedText = a.cleaned && a.cleaned.length
      ? '；重试前已清掉 win-unpacked 根目录里 ' + a.cleaned.length + ' 个残留临时文件（' + a.cleaned.join('、') + '）'
      : '';
    return (
      '第 1 次失败在「改 exe 版本信息/图标」（rcedit：Unable to commit changes，本机已知瞬态故障，' +
      '见 scripts/build/check-unpacked-clean.mjs 的记录）⇒ 已自动降级重试：' +
      '关闭 win.signAndEditExecutable 后再打一次（本次产物的 exe 属性/图标是 electron 默认值）' +
      cleanedText +
      '。'
    );
  });

  const base = {
    appDir,
    target,
    outDir,
    builderDisplay: builder.display,
    electronSource: electronDist
      ? electronDist + '（工程本地已有，跳过下载）'
      : '由 electron-builder 自行下载/使用缓存',
    configMessage: cfg.message,
    seconds,
    outputTail,
    attemptNotes,
  };

  // ⑨ 超时
  if (run.timedOut) {
    return composeReport(
      Object.assign({}, base, {
        ok: false,
        nextStep: nextStepForFailure('TIMEOUT'),
        problems: [
          '打包超时（' + Math.round(timeoutMs / 1000) + ' 秒），上游可能还在跑。已杀掉子进程树；如果日志显示仍在解压/下载 electron，可调大 timeoutMs 后重试。',
        ],
      })
    );
  }

  // ⑩ 子进程没起来
  if (run.spawnError) {
    return composeReport(
      Object.assign({}, base, {
        ok: false,
        nextStep: nextStepForFailure('NO_SPAWN'),
        problems: ['electron-builder 子进程根本没起来：' + run.spawnError.message],
      })
    );
  }

  // ⑪ 退出码非 0
  if (run.code !== 0) {
    return composeReport(
      Object.assign({}, base, {
        ok: false,
        nextStep: nextStepForFailure('EXIT_NONZERO'),
        problems: [
          'electron-builder 退出码 ' + String(run.code) + '（signal=' + String(run.signal) + '），日志尾部见下。',
        ],
      })
    );
  }

  // ⑫ 退出码 0 —— 但**不等于**成功：必须去 outDir 里真找 exe
  const out = inspectOutput(outDir);
  const verdict = judgeArtifacts(target, out, cfg.productName);
  const unpackedSummary = out.exists
    ? '存在，共 ' + out.unpackedTotalBytes + ' 字节（' + mb(out.unpackedTotalBytes) + ' MB）'
    : '不存在';

  if (!verdict.ok) {
    const problems = verdict.problems.slice();
    problems.push(
      '打包命令退出码为 0，但 outDir 里没有找到可执行文件 —— 不能算成功' +
        '（退出码 0 只说明进程没崩，不代表产物存在；本技能不会据此报成功）。'
    );
    return composeReport(
      Object.assign({}, base, {
        ok: false,
        // 失败路径：给「排查并重跑」的动作，**不给**「去桌面窗口验收」——没有 exe 可启动
        nextStep: nextStepForFailure('NO_ARTIFACT'),
        artifacts: verdict.artifacts,
        unpackedSummary,
        problems,
      })
    );
  }

  return composeReport(
    Object.assign({}, base, {
      ok: true,
      artifacts: verdict.artifacts,
      unpackedSummary,
      problems: verdict.problems,
      checks: [
        '目录存在',
        'package.json 可解析',
        'electron 依赖 ' + findElectronDep(pre.pkg).version,
        'main → ' + pre.mainAbs,
      ],
    })
  );
}

/**
 * 技能入口（生产路径：真实 spawn electron-builder）。
 * @param {object} params 技能参数
 * @returns {Promise<string>} 结论文本
 */
module.exports.run = async function (params) {
  return runWith(params, {});
};

/* 以下为单测接口：允许假 runBuilder 注入，从而在不真打包的前提下覆盖全部判据分支。 */
module.exports.runWith = runWith;
module.exports.__internals = {
  workspaceRoot,
  normalizeTarget,
  resolveAppDir,
  resolveOutDir,
  precheckProject,
  detectBuildConfig,
  ensureBuildConfig,
  resolveBuilder,
  findLocalElectronDist,
  inspectOutput,
  judgeArtifacts,
  realRunBuilder,
  buildChildEnv,
  cleanStaleTempAtRoot,
  looksLikeExecutableEditFailure,
  slugOf,
  stampOf,
  composeReport,
  earlyFail,
  nextStepForFailure,
  FAILURE_NEXT_STEPS,
  DEFAULT_TARGET,
  VALID_TARGETS,
  DEFAULT_TIMEOUT_MS,
  MIN_INSTALLER_BYTES,
  MIN_UNPACKED_TOTAL_BYTES,
  NEXT_STEP,
};
