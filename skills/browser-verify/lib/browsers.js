'use strict';
/**
 * 「已有 Chromium 内核浏览器」发现（零下载、零打包体积增加）。
 *
 * 为什么是"复用已有浏览器"而不是"下载一个"：
 *   · 本应用是 Electron，自带 Chromium；但**默认没有开远程调试端口**
 *     （src/main/main.js 里没有任何 appendSwitch('remote-debugging-port')），
 *     所以技能无法直接接管应用自己的 Chromium 渲染进程。
 *   · playwright-core / puppeteer-core 都没有随包分发，`playwright` 亦不在
 *     package.json 依赖里 → 打包后不可用；且打包后 skills 在 resources/skills/（asar 外），
 *     而 node_modules 在 app.asar 内，技能里的 require('ws')/require('playwright-core')
 *     在打包形态下**不可靠**。
 *   · 因此这里改为「找系统已装的 Chromium 内核浏览器（Edge/Chrome/Chromium/Brave）」，
 *     用 --remote-debugging-port 起一个 headless 实例，再走 CDP 驱动。**不下载任何东西**。
 *
 * Linux 服务器上通常没有任何 Chromium 内核浏览器 → findBrowser() 返回 null →
 * 技能如实报「未找到浏览器内核」，绝不静默降级成"通过"。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 按平台给出候选浏览器（越靠前优先级越高）。
 * @returns {Array<{name:string, path:string}>}
 */
function candidatePaths() {
  const out = [];
  const env = String(process.env.BROWSER_VERIFY_BROWSER || '').trim();
  if (env) out.push({ name: 'env(BROWSER_VERIFY_BROWSER)', path: env });

  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    out.push({ name: 'Microsoft Edge', path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    out.push({ name: 'Microsoft Edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    out.push({ name: 'Google Chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    out.push({ name: 'Google Chrome', path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    out.push({ name: 'Google Chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') });
    out.push({ name: 'Brave', path: path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') });
    out.push({ name: 'Microsoft Edge', path: path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  } else if (process.platform === 'darwin') {
    out.push({ name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    out.push({ name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' });
    out.push({ name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' });
    out.push({ name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' });
  } else {
    const bins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
    const dirs = String(process.env.PATH || '').split(path.delimiter);
    for (const bin of bins) {
      for (const d of dirs) {
        if (d) out.push({ name: bin, path: path.join(d, bin) });
      }
    }
  }
  return out;
}

/**
 * 找第一个真实存在的 Chromium 内核浏览器。
 * @returns {{name:string, path:string, external:false} | null}
 */
function findBrowser() {
  for (const c of candidatePaths()) {
    try {
      if (c.path && fs.existsSync(c.path)) return { name: c.name, path: c.path, external: false };
    } catch (e) {
      /* 候选路径不可读就跳过 */
    }
  }
  return null;
}

/**
 * 供"诚实失败"时回显：我们到底找过哪些位置。
 * @param {number} limit
 * @returns {string[]}
 */
function triedPaths(limit) {
  const max = limit || 8;
  return candidatePaths().slice(0, max).map((c) => c.name + ' → ' + c.path);
}

module.exports = { candidatePaths, findBrowser, triedPaths };
