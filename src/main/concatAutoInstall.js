/**
 * concatAutoInstall.js —— Concat 引擎「零操作补齐」（2026-11-09 新增）
 *
 * ═══ 要解决的缺陷 ══════════════════════════════════════════════════════════
 *   老板原话：「视频剪辑安装到新的电脑就没有 concat 这个功能就没法使用了」
 *   「可以的做成一键自动安装好了，越简单越好，我们的用户很笨的」。
 *   现状：Concat 是第三方 headless MCP 引擎，豆芽安装包不带它；新电脑打开
 *   「视频精剪」页只会得到一句「请先安装 Concat 0.2.9…（装在别处就设环境变量
 *   DOUYA_CONCAT_PATH）」—— 让不懂命令行的人去设环境变量，等于功能不存在。
 *
 * ═══ 本模块的口径 ════════════════════════════════════════════════════════
 *   **零操作**：探测不到就自动下载官方安装器 → 静默安装 → 轮询重新探测 → 直接连上。
 *   用户不点按钮、不填路径、不设环境变量。只有全自动这条路走不通时才如实报错。
 *   所有 IO 都可通过 options 注入，便于单测（不依赖网络就能断言整条状态机）。
 *
 * ═══ 安全 / 诚实边界 ════════════════════════════════════════════════════
 *   · 只从 GitHub 官方 releases API 取地址，只认 Windows x64 setup 这个 asset 名；
 *   · 全程 HTTPS，重定向也只跟随 https；
 *   · 安装器落 TEMP、用完即删；装完**重新探测**才算成功（不把"进程退出了"当成功）；
 *   · 网络不通 / 没有匹配 asset / 装完仍找不到，一律返回明确 error，绝不假装装好。
 */
'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const RELEASES_API = 'https://api.github.com/repos/jub0t/Concat/releases/latest';
/**
 * Windows x64 安装器命名判据。
 *
 * ★ 2026-11-09 实证修正：官方 v0.2.9 的真实 asset 名是
 *   `Concat-0.2.9-windows-x86_64-setup.exe`（连字符 + windows-x86_64），
 *   而初版写的是 `Concat_..._x64-setup.exe`（下划线）—— mock 单测用假名全绿，
 *   真实发布页却一个都匹配不上，等于一键安装永远失败。
 *   现在同时认官方真实命名与旧假设命名；.msi / .dmg / .AppImage / .deb / .rpm 一律不认。
 */
const ASSET_NAME = /^Concat[-_].*(?:windows[-_]x86_64|windows[-_]x64|x64)[-_]setup\.exe$/i;
const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Concat 官方 setup.exe 是 **Inno Setup 6** 打的，不是 NSIS：
 *   `.github/workflows/build-app.yml` 调 ISCC.exe 编译 `assets/windows/concat.iss`；
 *   `concat.iss` 里 `PrivilegesRequired=lowest` + `{autopf}\Concat`
 *   ⇒ 无需管理员、默认装到 `%LOCALAPPDATA%\Programs\Concat`（正好在探测路径里）。
 * 初版误用 NSIS 的 `/S /currentuser`，Inno 不认，会弹 GUI 卡住 10 分钟。
 * 2026-11-09 本机实测：`/VERYSILENT ... /CURRENTUSER` 无 UAC、无弹窗、静默落盘成功。
 */
const INSTALL_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CURRENTUSER'];

function defaultFind() {
  // 懒 require：避免 concatStudio ↔ mcpStdioClient ↔ 本模块之间形成加载环。
  return require('./mcpStdioClient').findConcatExecutable();
}

/** GET 一个 URL，自动跟随 https 重定向；`asJson=true` 时解析 JSON。 */
function httpsGet(url, { asJson = false, redirects = 0, timeoutMs = REQUEST_TIMEOUT_MS, dest = '' } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('重定向次数过多')); return; }
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('下载地址不合法：' + url)); return; }
    if (u.protocol !== 'https:') { reject(new Error('只允许 https 下载：' + url)); return; }
    const req = https.get(u, {
      headers: { 'User-Agent': 'douya-claw-concat-installer', Accept: asJson ? 'application/vnd.github+json' : '*/*' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        httpsGet(next, { asJson, redirects: redirects + 1, timeoutMs, dest }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + '（' + u.hostname + '）'));
        return;
      }
      if (dest) {
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve({ bytes: fs.existsSync(dest) ? fs.statSync(dest).size : 0 })));
        file.on('error', reject);
        res.on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!asJson) { resolve(text); return; }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('返回的不是合法 JSON：' + text.slice(0, 120))); }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）')));
    req.on('error', reject);
  });
}

function fetchRelease() {
  return httpsGet(RELEASES_API, { asJson: true });
}
function download(url) {
  const dest = path.join(os.tmpdir(), 'douya-concat-setup-' + Date.now() + '-' + process.pid + '.exe');
  return httpsGet(url, { dest, timeoutMs: DOWNLOAD_TIMEOUT_MS }).then((r) => ({ ...r, dest }));
}
function install(exePath) {
  return new Promise((resolve) => {
    let child;
    try {
      // Inno Setup 6 静默安装（不是 NSIS）：/CURRENTUSER 避免弹出安装范围选择。
      child = spawn(exePath, INSTALL_ARGS.slice(), { stdio: 'ignore', windowsHide: true });
    } catch (e) { resolve({ ok: false, error: '启动安装器失败：' + e.message }); return; }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经没了 */ }
      resolve({ ok: false, error: '安装超时（10 分钟）' });
    }, INSTALL_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: '安装器异常：' + e.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: '安装器退出码 ' + code });
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 release 里挑 Windows x64 安装器；找不到返回 null（不许挑到 Linux/mac 包）。 */
function pickAsset(release) {
  const list = release && Array.isArray(release.assets) ? release.assets : [];
  const a = list.find((x) => x && ASSET_NAME.test(String(x.name || '')) && x.browser_download_url);
  return a ? { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 } : null;
}

/**
 * 保证本机有可用的 concat.exe。
 * @param {{
 *   find?:()=>({path:string,source?:string}|null),
 *   fetchRelease?:()=>Promise<object>, download?:(url:string)=>Promise<{dest:string,bytes:number}>,
 *   install?:(exe:string)=>Promise<{ok:boolean,error?:string}>, wait?:(ms:number)=>Promise<void>,
 *   maxPolls?:number, onProgress?:(msg:string)=>void
 * }=} options 全部 IO 可注入，供单测覆盖整条状态机
 * @returns {Promise<{ok:boolean, path?:string, installed?:boolean, source?:string, error?:string}>}
 */
async function ensureConcatInstalled(options) {
  const o = options || {};
  const find = o.find || defaultFind;
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const hit0 = find();
  if (hit0 && hit0.path) return { ok: true, path: hit0.path, installed: false, source: hit0.source || 'existing' };

  progress('正在获取 Concat 官方版本信息');
  let release;
  try { release = await (o.fetchRelease || fetchRelease)(); }
  catch (e) { return { ok: false, error: '连不上 Concat 官方发布页：' + e.message }; }
  const asset = pickAsset(release);
  if (!asset) return { ok: false, error: '官方发布页里没有找到 Windows x64 安装器（形如 Concat-0.2.9-windows-x86_64-setup.exe）' };

  progress('正在下载 Concat 安装器');
  let dl;
  try { dl = await (o.download || download)(asset.url); }
  catch (e) { return { ok: false, error: '下载失败：' + e.message }; }
  if (!dl || !dl.dest || !dl.bytes) {
    return { ok: false, error: '下载到的安装器是空的（0 字节），已放弃安装' };
  }

  progress('正在静默安装 Concat');
  let ins;
  try { ins = await (o.install || install)(dl.dest); }
  catch (e) { ins = { ok: false, error: e.message }; }
  try { fs.rmSync(dl.dest, { force: true }); } catch { /* 临时文件删不掉不影响结果 */ }
  if (!ins || !ins.ok) return { ok: false, error: '自动安装未完成：' + ((ins && ins.error) || '未知原因') };

  // 判据是「重新探测得到」，不是「安装器退出码 0」—— 装到别处同样算成功。
  // 安装器可能先退出、文件才落完；给足 30 秒重新探测窗口，别把"慢一点"误判成"没装上"。
  const polls = Number(o.maxPolls) || 30;
  const sleep = o.wait || wait;
  for (let i = 0; i < polls; i++) {
    const hit = find();
    if (hit && hit.path) return { ok: true, path: hit.path, installed: true, source: 'auto-installed' };
    await sleep(1000);
  }
  return { ok: false, error: '安装器已运行结束，但本机仍探测不到 concat.exe' };
}

module.exports = { ensureConcatInstalled, pickAsset, RELEASES_API, ASSET_NAME, INSTALL_ARGS };
