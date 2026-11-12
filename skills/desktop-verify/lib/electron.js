'use strict';
/**
 * 解析「哪个可执行文件能真正跑起 Electron 窗口」。
 *
 * 为什么必须显式兜住：豆芽的技能是被 Electron 主进程 require() 执行的（见 src/main/skills.js），
 * 此时 `process.execPath` **是豆芽自己的 exe**，拿来跑被测应用会直接把宿主自己启一遍。
 * 所以候选里**绝不能**放 `process.execPath`。
 *
 * 解析顺序（先 explicit 后自动，自动部分全部 fs.existsSync 校验，不返回不存在的东西）：
 *   ① 显式 electronPath 参数
 *   ② DOUYA_ELECTRON_PATH 环境变量
 *   ③ require('electron')（dev 与打包形态都可用；它返回的就是可执行文件绝对路径）
 *   ④ 仓库 node_modules/electron/dist/electron.exe（本仓库相对位置：skills/desktop-verify/lib → 根）
 *   ⑤ Windows 常见安装位
 *
 * 诚实红线：解析不到就返回 ''，让上层判 fail —— 绝不静默退化成「用 node 跑 main.js」
 * （那样窗口根本不会出现，而工具会以为自己在验收）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 仓库根：skills/desktop-verify/lib/*.js → ../../.. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * 在仓库里找 electron 二进制（打包形态 dist 在 resources 下，dev 形态就是 electron.exe）。
 * @returns {string}
 */
function repoElectron() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * 系统级常见安装位（Windows / macOS / Linux）。
 * @returns {string}
 */
function systemInstall() {
  const list = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || '';
    list.push(path.join(pf, 'Electron', 'electron.exe'));
    if (pf86) list.push(path.join(pf86, 'Electron', 'electron.exe'));
    const local = process.env.LOCALAPPDATA || '';
    if (local) list.push(path.join(local, 'Programs', 'Electron', 'electron.exe'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Electron.app/Contents/MacOS/Electron');
    list.push(path.join(os.homedir(), 'Applications', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  } else {
    list.push('/usr/bin/electron');
    list.push('/usr/local/bin/electron');
  }
  for (const c of list) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * 逐条尝试候选，返回第一个**真实存在**的绝对路径。
 * @param {Array<string>} candidates
 * @returns {string}
 */
function firstExisting(candidates) {
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (!s) continue;
    try {
      if (fs.existsSync(s) && fs.statSync(s).isFile()) return path.resolve(s);
    } catch (e) {
      /* 权限/损坏：换下一个候选 */
    }
  }
  return '';
}

/**
 * 解析 electron 可执行文件。
 * @param {{electronPath?:string, tried?:string[]}} [opts]
 * @returns {string} '' 表示没解析到（上层必须判 fail）
 */
function resolveElectron(opts) {
  const o = opts || {};
  const tried = Array.isArray(o.tried) ? o.tried : null;
  const record = (label, cand) => {
    if (tried) tried.push(label + '=' + (cand || '(未找到)'));
    return cand || '';
  };

  const explicit = firstExisting([o.electronPath]);
  if (explicit) return record('显式 electronPath', explicit);

  const fromEnv = firstExisting([process.env.DOUYA_ELECTRON_PATH]);
  if (fromEnv) return record('环境变量 DOUYA_ELECTRON_PATH', fromEnv);

  let viaRequire = '';
  try {
    const p = require('electron'); // eslint-disable-line global-require
    if (typeof p === 'string') viaRequire = firstExisting([p]);
  } catch (e) {
    viaRequire = '';
  }
  if (viaRequire) return record('require("electron")', viaRequire);

  const inRepo = repoElectron();
  if (inRepo) return record('仓库 node_modules/electron', inRepo);

  const sysOne = systemInstall();
  return record('系统常见安装位', sysOne);
}

module.exports = { resolveElectron, repoElectron, systemInstall, firstExisting, REPO_ROOT };
