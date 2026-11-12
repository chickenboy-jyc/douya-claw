'use strict';
/**
 * desktop-verify —— 「桌面窗口真实验收」技能入口。
 *
 * 为什么需要它：文件存在、打包成功、命令退出码 0，都不能证明用户能用。
 * 桌面应用最典型的三种假绿：
 *   ① 进程起来了但**一个窗口都没有**（被 ELECTRON_RUN_AS_NODE 当 Node 跑了）；
 *   ② 窗口起来了但**渲染进程在报 null.addEventListener**，按钮点了没反应；
 *   ③ 点了导出，但原生保存对话框挂住 / 界面假装成功，**目录里一个字节都没有**。
 * 本技能逐条堵住这三种：只认真实 page target、只认真实断言、只认真实落盘产物。
 *
 * 运行形态：本项目 JS 技能由主进程 require() 后在 Electron 主进程内执行
 * （见 src/main/skills.js）。所以这里只用 Node 标准库 + 仓库已有依赖 `ws`（package.json dependencies）。
 *
 * 返回：**纯 JSON 字符串**（不加大段前缀，保证上游能 JSON.parse）。
 *   通过 ⇒ verdict:'pass'、ok:true、verified:true
 *   失败/没验成 ⇒ verdict:'fail' / 'unverified'，并写明 reason —— 绝不把没验证说成通过。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const WebSocket = require('ws');
// 子进程字节 → 文本的唯一真源（stderr / 给人看的日志允许 GBK 回退，见该文件头部）。
// ⚠️ 这两个流是**用户可见失败文案的原料**：`log.stderr` 会被拼进 "没验成" 的 reason 里，
//   而它抓的是被验收的那个 Electron 应用自己的日志 —— 日志里带中文路径/中文用户目录是常态。
//   原先写 `String(b)`（等价 utf8 硬解），中文 Windows 上 Electron 子进程走控制台代码页时
//   那些字会变成一串 `�`，用户看到的"验收失败原因"就成了乱码。
const { decodeOutput } = require('../../src/main/childOutput');

const { normalizeParams, planLaunch } = require('./lib/params');
const { resolveElectron } = require('./lib/electron');
const { waitPageTarget, freePort } = require('./lib/targets');

/** 与 src/main/runtimeEvidence.js 的 RUNTIME_MARKER 一致：让 shell 路径也能认这条证据。 */
const RUNTIME_MARKER = 'DOUYA_RUNTIME_ACCEPTANCE=';
const MAX_LOG = 20000;
const MAX_ERRORS = 40;

/**
 * 页面错误钩子。
 *
 * ★ 为什么必须有它：CDP 的 Runtime.exceptionThrown **不回放历史**。
 *   应用在 loadFile 完成的那一刻就可能已经抛了 null.addEventListener ——
 *   等我们连上调试端口时异常早就过去了，于是「零 pageerror」变成一句谎话
 *   （海报基准三轮就是这么被骗过去的）。
 *   所以在文档创建**之前**把 window.onerror / unhandledrejection 挂上，
 *   把错误留在 window.__douyaVerifyErrors 里，收尾时取回。
 */
const ERROR_HOOK = '(function(){ if(window.__douyaVerifyErrors) return;'
  + 'var a=[]; window.__douyaVerifyErrors=a;'
  + 'window.addEventListener("error",function(e){try{'
  + 'a.push({kind:"error",message:String((e&&e.message)||""),source:String((e&&e.filename)||""),line:Number(e&&e.lineno)||0});'
  + '}catch(x){}});'
  + 'window.addEventListener("unhandledrejection",function(e){try{'
  + 'var r=e&&e.reason; var m=(r&&(r.stack||r.message))||r||"";'
  + 'a.push({kind:"unhandledrejection",message:String(m).slice(0,500)});'
  + '}catch(x){}});'
  + '})();';

function nowMs() { return Date.now(); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function clampText(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…(' + t.length + '字)' : t;
}

function sha1OfFile(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return ''; }
}

/** 极简 glob：只支持 * 与 ?，够用于 '*.png' 这类导出匹配。 */
function matchGlob(name, pat) {
  const p = String(pat || '*');
  const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try { return new RegExp('^' + esc + '$', 'i').test(name); } catch (e) { return false; }
}

function dirFiles(dir) {
  try {
    return fs.readdirSync(dir).map((n) => {
      const full = path.join(dir, n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { st = null; }
      if (!st || !st.isFile()) return null;
      return { name: n, path: full, size: st.size, mtimeMs: st.mtimeMs };
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ───────────────────────────── CDP 会话 ─────────────────────────────

/** 单行压缩：CDP Runtime.evaluate 的表达式**不能含换行**（会 SyntaxError）。 */
function oneLine(js) { return String(js == null ? '' : js).replace(/\r?\n/g, ' '); }

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closedReason = '';
  }

  connect(timeoutMs) {
    const ms = timeoutMs || 10000;
    return new Promise((resolve, reject) => {
      let done = false;
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, handshakeTimeout: ms });
      this.ws = ws;
      const fail = (e) => {
        if (done) return;
        done = true;
        try { ws.terminate(); } catch (x) { /* ignore */ }
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      ws.on('open', () => { if (done) return; done = true; resolve(true); });
      ws.on('error', (e) => fail(e));
      ws.on('close', () => {
        this.closedReason = 'CDP 会话已关闭（窗口可能被关掉或进程退出）';
        for (const [, p] of this.pending) p.reject(new Error(this.closedReason));
        this.pending.clear();
      });
      ws.on('message', (raw) => {
        let msg = null;
        try { msg = JSON.parse(String(raw)); } catch (e) { return; }
        if (msg && msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(String((msg.error && msg.error.message) || 'CDP 调用失败')));
          else p.resolve(msg.result || {});
          return;
        }
        const key = String(msg.method || '');
        const fns = this.listeners.get(key);
        if (fns) for (const fn of fns) { try { fn(msg.params || {}); } catch (e) { /* ignore */ } }
      });
      setTimeout(() => fail(new Error('连接窗口调试端口超时（' + ms + 'ms）')), ms).unref();
    });
  }

  on(method, fn) {
    const k = String(method);
    if (!this.listeners.has(k)) this.listeners.set(k, []);
    this.listeners.get(k).push(fn);
  }

  send(method, params, timeoutMs) {
    const ms = timeoutMs || 15000;
    const id = (this.seq += 1);
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP 会话不可用：' + (this.closedReason || '未连接')));
    }
    const payload = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 调用超时（' + method + ' / ' + ms + 'ms）'));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(payload); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** 求值并取回值；表达式必须是单行。 */
  async eval(expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', {
      expression: oneLine(expression),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '表达式执行抛异常';
      return { ok: false, reason: clampText(desc, 300) };
    }
    return { ok: true, value: r && r.result ? r.result.value : undefined };
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
  }
}

// ─────────────────────────── 进程启动与清理 ───────────────────────────

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
    }
  } catch (e) { /* 尽力而为 */ }
}

function removeDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 临时目录，删不掉不影响结论 */ }
}

/**
 * 启动被测应用。
 *
 * ★ 两条铁律（都是踩过的坑）：
 *   1. env 必须**无条件剔除** ELECTRON_RUN_AS_NODE / NODE_OPTIONS。
 *      前者会让 Electron 变成 Node 跑（零窗口），后者会把宿主的 --require 垫片带进去。
 *   2. 必须给独立 --user-data-dir，否则会跟用户正在用的实例抢单例锁，第二个进程直接退出。
 */
function launchApp(plan, params) {
  const env = Object.assign({}, process.env, params.env || {});
  const removed = [];
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    if (Object.prototype.hasOwnProperty.call(env, k)) { delete env[k]; removed.push(k); }
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douya-desktop-verify-'));
  const port = plan.port;
  const extra = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--disable-features=CalculateNativeWinOcclusion',
  ];
  const cwd = params.cwd || plan.appRoot || params.workspace || process.cwd();
  const child = cp.spawn(plan.exe, plan.appArgs.concat(extra), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    detached: process.platform !== 'win32',
  });
  const log = { stdout: '', stderr: '', exitCode: null, spawnError: '' };
  // 【解码分类：stdout+stderr 都进"给人看的验收日志" → GBK 回退】
  //   这两个字符串唯一的下游就是 clampText 之后拼进结论/reason，没有任何结构化解析
  //   （不是 JSON.parse，也不是正则取值）⇒ 可以安全地走 GBK 回退。
  child.stdout.on('data', (b) => { log.stdout = clampText(log.stdout + decodeOutput(b), MAX_LOG); });
  child.stderr.on('data', (b) => { log.stderr = clampText(log.stderr + decodeOutput(b), MAX_LOG); });
  child.on('error', (e) => { log.spawnError = String((e && e.message) || e); });
  child.on('exit', (code, signal) => { log.exitCode = (code == null ? 'signal:' + signal : code); });
  // cwd 一并回传：验收证据要记「子进程真实工作目录」，不能事后自己再推一遍（推的可能是错的）。
  return { child, log, userDataDir, port, removedEnv: removed, cwd };
}

// ─────────────────────────── actions 执行 ───────────────────────────

async function rectOf(session, selector) {
  const js = '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');'
    + 'if(!el) return {found:false};'
    + 'el.scrollIntoView({block:"center",inline:"center"});'
    + 'var r=el.getBoundingClientRect();'
    + 'var cs=getComputedStyle(el);'
    + 'return {found:true,x:r.x,y:r.y,w:r.width,h:r.height,disabled:!!el.disabled,'
    + 'vis:cs.visibility,disp:cs.display,op:cs.opacity,text:(el.textContent||"").slice(0,80)};})()';
  return session.eval(js, 8000);
}

async function clickSelector(session, selector, mode) {
  if (mode === 'dom') {
    const r = await session.eval('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');'
      + 'if(!el) return {ok:false,reason:"选择器没有匹配到元素"};'
      + 'el.click(); return {ok:true};})()', 8000);
    return r.ok ? (r.value || r) : { ok: false, reason: r.reason };
  }
  const box = await rectOf(session, selector);
  if (!box.ok) return { ok: false, reason: box.reason };
  const b = box.value || {};
  if (!b.found) return { ok: false, reason: '选择器没有匹配到元素：' + selector };
  if (b.disabled) return { ok: false, reason: '元素处于禁用状态（点了不会有反应）：' + selector };
  if (!(b.w > 0 && b.h > 0)) return { ok: false, reason: '元素尺寸为 0（存在但不可见，点了不会有反应）：' + selector };
  if (b.vis === 'hidden' || b.disp === 'none' || Number(b.op) === 0) {
    return { ok: false, reason: '元素不可见（visibility/display/opacity）：' + selector };
  }
  const x = b.x + b.w / 2;
  const y = b.y + b.h / 2;
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }, 8000);
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 8000);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, 8000);
  return { ok: true, at: { x: Math.round(x), y: Math.round(y) }, text: b.text };
}

async function clickText(session, text, mode) {
  const js = '(function(){var want=' + JSON.stringify(text) + ';'
    + 'var all=Array.prototype.slice.call(document.querySelectorAll("button,a,[role=button],input[type=button],input[type=submit],label,li,div"));'
    + 'var hit=all.filter(function(el){var t=(el.textContent||"").replace(/\\s+/g,"");'
    + ' return t.indexOf(want.replace(/\\s+/g,""))>=0;})'
    + '.filter(function(el){var r=el.getBoundingClientRect(); return r.width>0&&r.height>0;});'
    + 'if(!hit.length) return {ok:false,reason:"没有可见元素包含文字："+want};'
    + 'hit.sort(function(a,b){return a.textContent.length-b.textContent.length;});'
    + 'var el=hit[0]; el.setAttribute("data-douya-verify-hit","1"); return {ok:true};})()';
  const found = await session.eval(js, 8000);
  if (!found.ok) return { ok: false, reason: found.reason };
  const v = found.value || {};
  if (!v.ok) return { ok: false, reason: v.reason || '没有找到目标文字' };
  return clickSelector(session, '[data-douya-verify-hit="1"]', mode);
}

async function typeInto(session, selector, text, mode) {
  if (mode === 'dom') {
    const r = await session.eval('(function(sel,val){var el=document.querySelector(sel);'
      + 'if(!el) return {ok:false,reason:"选择器没有匹配到元素"};'
      + 'el.focus();'
      + 'var proto = (typeof HTMLTextAreaElement!=="undefined" && el instanceof HTMLTextAreaElement)'
      + ' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;'
      + 'var d=Object.getOwnPropertyDescriptor(proto,"value");'
      + 'if(d&&d.set) d.set.call(el,val); else el.value=val;'
      + 'el.dispatchEvent(new Event("input",{bubbles:true}));'
      + 'el.dispatchEvent(new Event("change",{bubbles:true}));'
      + 'return {ok:true,value:String(el.value)};})(' + JSON.stringify(selector) + ',' + JSON.stringify(String(text)) + ')', 8000);
    return r.ok ? (r.value || r) : { ok: false, reason: r.reason };
  }
  const box = await rectOf(session, selector);
  if (!box.ok) return { ok: false, reason: box.reason };
  const b = box.value || {};
  if (!b.found) return { ok: false, reason: '选择器没有匹配到元素：' + selector };
  if (!(b.w > 0 && b.h > 0)) return { ok: false, reason: '输入框尺寸为 0（不可见，输入不进去）：' + selector };
  const x = b.x + b.w / 2;
  const y = b.y + b.h / 2;
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 8000);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, 8000);
  await session.send('Input.insertText', { text: String(text) }, 8000);
  return { ok: true };
}

async function waitForSelector(session, selector, timeoutMs) {
  const deadline = nowMs() + timeoutMs;
  let last = '';
  while (nowMs() < deadline) {
    const r = await session.eval('(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');'
      + 'if(!el) return {ok:false};var b=el.getBoundingClientRect();return {ok:true,w:b.width,h:b.height};})()', 8000);
    const v = (r.ok && r.value) || {};
    if (v.ok) return { ok: true, detail: '元素已出现' };
    last = r.ok ? '选择器暂时没有匹配到元素' : String(r.reason || '');
    await sleep(200);
  }
  return { ok: false, reason: '等待元素超时（' + timeoutMs + 'ms）：' + selector + (last ? '｜' + last : '') };
}

async function waitForText(session, text, timeoutMs) {
  const deadline = nowMs() + timeoutMs;
  const js = '(function(){var t=document.body?document.body.innerText:"";return t.indexOf(' + JSON.stringify(String(text)) + ')>=0;})()';
  while (nowMs() < deadline) {
    const r = await session.eval(js, 8000);
    if (r.ok && r.value === true) return { ok: true, detail: '文字已出现' };
    await sleep(200);
  }
  return { ok: false, reason: '等待文字超时（' + timeoutMs + 'ms）：' + text };
}

async function shoot(session, outPath) {
  const r = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15000);
  const b64 = r && r.data ? String(r.data) : '';
  if (!b64) return { ok: false, reason: '截图没有返回数据' };
  const buf = Buffer.from(b64, 'base64');
  try {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, buf);
  } catch (e) { return { ok: false, reason: '截图写盘失败：' + String(e && e.message || e) }; }
  return { ok: true, path: path.resolve(outPath), size: buf.length };
}

async function runActions(session, actions, mode, defShot) {
  const interactions = [];
  const shots = [];
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    let out = { action: a.type, name: a.name, ok: false, detail: '' };
    try {
      if (a.type === 'click') {
        out.detail = '点击 ' + a.selector;
        out = Object.assign(out, await clickSelector(session, a.selector, mode));
      } else if (a.type === 'clickText') {
        out.detail = '点击文字「' + a.text + '」';
        out = Object.assign(out, await clickText(session, a.text, mode));
      } else if (a.type === 'type') {
        out.detail = '向 ' + a.selector + ' 输入「' + clampText(a.text, 40) + '」';
        out = Object.assign(out, await typeInto(session, a.selector, a.text, mode));
      } else if (a.type === 'waitFor') {
        out = Object.assign(out, await waitForSelector(session, a.selector, a.timeoutMs));
        out.detail = '等待元素 ' + a.selector;
      } else if (a.type === 'waitText') {
        out = Object.assign(out, await waitForText(session, a.text, a.timeoutMs));
        out.detail = '等待文字「' + a.text + '」';
      } else if (a.type === 'sleep') {
        await sleep(a.ms);
        out.ok = true;
        out.detail = '等待 ' + a.ms + 'ms';
      } else if (a.type === 'evaluate') {
        const r = await session.eval(a.expression, a.timeoutMs);
        out.ok = r.ok;
        out.value = r.ok ? r.value : undefined;
        out.detail = r.ok ? clampText(JSON.stringify(r.value === undefined ? null : r.value), 200) : String(r.reason || '');
      } else if (a.type === 'screenshot') {
        const p = a.path || (defShot ? defShot.replace(/\.png$/i, '') + '-' + i + '.png' : '');
        if (!p) { out.detail = 'screenshot 动作没有给 path'; }
        else { out = Object.assign(out, await shoot(session, p)); out.detail = '截图 ' + p; }
      }
      if (shots.length === 0 && a.type === 'screenshot' && out.ok && out.path) shots.push(out.path);
    } catch (e) {
      out.ok = false;
      out.detail = '动作抛错：' + String((e && e.message) || e);
    }
    // 失败时把底层原因带到 detail 上：断言里只说「第 N 个交互失败」等于没说清为什么。
    if (!out.ok && out.reason && String(out.detail || '').indexOf(String(out.reason)) < 0) {
      out.detail = out.detail ? (out.detail + ' → ' + out.reason) : String(out.reason);
    }
    interactions.push(out);
    if (!out.ok) return { interactions, shots, failedAt: i };
  }
  return { interactions, shots, failedAt: -1 };
}

/** 等导出产物落盘：新文件 + 字节数够 + 大小稳定，三者同时成立才算数。 */
async function waitExport(spec, sinceMs) {
  const deadline = nowMs() + (spec.timeoutMs || 20000);
  const dir = path.resolve(spec.dir);
  let lastSeen = [];
  let stable = null;
  while (nowMs() < deadline) {
    const files = dirFiles(dir).filter((f) => matchGlob(f.name, spec.glob) && f.mtimeMs >= sinceMs - 2000);
    lastSeen = files.map((f) => ({ name: f.name, size: f.size }));
    const big = files.filter((f) => f.size >= (spec.minBytes || 1));
    if (big.length) {
      const cur = big.map((f) => f.path + ':' + f.size).sort().join('|');
      if (stable && stable.key === cur) {
        if (nowMs() - stable.at >= (spec.stableMs || 400)) {
          return {
            ok: true,
            exported: big.map((f) => ({ path: f.path, size: f.size, sha1: sha1OfFile(f.path) })),
          };
        }
      } else {
        stable = { key: cur, at: nowMs() };
      }
    }
    await sleep(250);
  }
  return {
    ok: false,
    exported: [],
    reason: '等不到导出产物：目录 ' + dir + ' 在 ' + (spec.timeoutMs || 20000) + 'ms 内没有出现匹配 '
      + spec.glob + ' 且不小于 ' + (spec.minBytes || 1) + ' 字节的新文件'
      + (lastSeen.length ? '（看到的候选：' + JSON.stringify(lastSeen.slice(0, 6)) + '）' : '（目录里一个匹配文件都没有）'),
  };
}

// ─────────────────────────── 启动前预检 ───────────────────────────

/**
 * 组装「这一次到底启动了什么的」证据。
 *
 * ★ 为什么它必须出现在**每一条发起 spawn 的路径上**（成功也要）：
 *   验收记录要能事后证明「通过的是**这个**应用，不是别的」。只有失败时才有 resolved，
 *   等于通过的那次没有任何主体标识 —— 工作区里有几个同名 poster-app 时，
 *   事后无法区分到底验的是哪一个。所以成功路径同样输出。
 *
 * @param {object} plan 启动计划（planLaunch 的结果 + port）
 * @param {object} p 已归一化参数
 * @param {string} [actualCwd] 子进程真实 cwd（launchApp 返回值；缺省时按同一条兜底链推算）
 * @param {boolean} [spawned] 是否真的发起了 spawn（预检失败时为 false，字段是计划值）
 * @returns {object}
 */
function buildResolved(plan, p, actualCwd, spawned) {
  const pl = plan || {};
  const pp = p || {};
  return {
    // spawned=false ⇒ 以下为**计划值**（预检已判定不可用，进程从未启动）
    spawned: spawned !== false,
    exe: pl.exe || '',
    appArgs: Array.isArray(pl.appArgs) ? pl.appArgs.slice() : [],
    appRoot: pl.appRoot || '',
    cwd: actualCwd || pp.cwd || pl.appRoot || pp.workspace || '',
    workspace: pp.workspace || '',
  };
}

/**
 * 启动前的存在性预检：**预检失败 ⇒ 绝不 spawn**。
 *
 * ★ 为什么必须在 spawn 之前（真实故障，不是假设）：入口路径不存在时，electron 会在
 *   几毫秒内退出（实测 durationMs=7），我们唯一看得到的是
 *   `子进程在等到窗口之前就已退出：connect ECONNREFUSED 127.0.0.1:<port>` ——
 *   这句话既没说是哪个路径不存在，也没说按哪个基目录解析的，对模型毫无指导性。
 *   预检把「你给的值 → 按哪个工作区解析成了什么 → 为什么不可用」一次说清。
 *
 * 结论形态与参数错误完全一致：verdict='fail' + reason + 一条失败断言（绝不降级成 unverified/pass）。
 *
 * @param {object} p 已归一化参数（路径均已是绝对路径，见 lib/params.js）
 * @param {object} d 依赖覆盖（单测用：detectElectron）
 * @returns {{ok:boolean, reason?:string}}
 */
function preflightPaths(p, d) {
  const given = (p && p.given) || {};
  const ws = String((p && p.workspace) || '') || '(未指定工作区)';

  if (p.appPath) {
    let st = null;
    try { st = fs.statSync(p.appPath); } catch (e) { st = null; }
    if (!st) {
      return {
        ok: false,
        reason: 'appPath 不存在：' + p.appPath
          + '（相对路径按工作区 ' + ws + ' 解析；你给的是 "' + String(given.appPath || p.appPath) + '"）',
      };
    }
  }

  if (p.entry) {
    let est = null;
    try { est = fs.statSync(p.entry); } catch (e) { est = null; }
    if (!est || est.isDirectory()) {
      return {
        ok: false,
        reason: 'entry 不存在（不是一个文件）：' + p.entry
          + '（相对路径按工作区 ' + ws + ' 解析；你给的是 "' + String(given.entry || p.entry) + '"）',
      };
    }
  }

  if (p.electronPath) {
    let xst = null;
    try { xst = fs.statSync(p.electronPath); } catch (e) { xst = null; }
    if (!xst) {
      // 复用 lib/electron.js 的自动解析（tried 会记录逐条候选），别另写一份候选清单
      const candidates = [];
      let auto = '';
      try {
        if (d && typeof d.detectElectron === 'function') auto = String(d.detectElectron() || '');
        else auto = String(resolveElectron({ tried: candidates }) || '');
      } catch (e) {
        auto = '';
      }
      return {
        ok: false,
        reason: 'electronPath 不存在：' + p.electronPath
          + '（相对路径按工作区 ' + ws + ' 解析；你给的是 "' + String(given.electronPath || p.electronPath) + '"）'
          + '｜自动解析候选：' + (candidates.length ? candidates.join('；') : '未记录（本次使用了注入的解析器）')
          + '｜自动解析结果：' + (auto || '未找到'),
      };
    }
  }

  return { ok: true };
}

// ─────────────────────────── 主流程 ───────────────────────────

/**
 * 执行一次桌面验收。任何异常都被转成结构化失败，绝不抛出。
 * @param {object} raw 原始 params
 * @param {object} [deps] 依赖覆盖（单测用）
 * @returns {Promise<object>} 结构化结论
 */
async function verify(raw, deps) {
  const d = deps || {};
  const startedAt = nowMs();
  const base = {
    tool: 'desktop-verify',
    kind: 'app',
    startedAt,
    launched: false,
    verified: false,
    ok: false,
    verdict: 'unverified',
    url: '',
    readyState: '',
    interactions: [],
    assertions: [],
    exported: [],
    consoleErrors: [],
    pageErrors: [],
    screenshots: [],
    artifactPaths: [],
    targetsSeen: [],
    reason: '',
    unverifiedReason: '',
    removedEnv: [],
    durationMs: 0,
    // 「这一次到底启动了哪个 exe / 哪个入口 / 哪个 cwd」。true 表示真的 spawn 过；
    // 预检/计划失败时为 false（字段是计划值）；null 表示连参数都没过，什么都没算。
    resolved: null,
  };

  // ① 参数
  const norm = normalizeParams(raw);
  if (!norm.ok) {
    return Object.assign(base, {
      verdict: 'fail', reason: norm.reason, unverifiedReason: '',
      assertions: [{ name: 'params-valid', ok: false, detail: norm.reason }],
      durationMs: nowMs() - startedAt,
    });
  }
  const p = norm.params;

  // ② 启动计划（谁来产生窗口）
  const detect = d.detectElectron || (() => resolveElectron());
  const planned = planLaunch(p, detect);
  if (!planned.ok) {
    return Object.assign(base, {
      verdict: 'fail', reason: planned.reason,
      assertions: [{ name: 'launch-plan', ok: false, detail: planned.reason }],
      // 计划就没成型 ⇒ 没有可跑的主体，但仍记下「按哪个工作区算过」。
      resolved: buildResolved({}, p, '', false),
      durationMs: nowMs() - startedAt,
    });
  }

  // ②b 启动前存在性预检：预检失败 ⇒ 不 spawn（否则只会得到一句无指导性的 ECONNREFUSED）
  const pre = preflightPaths(p, d);
  if (!pre.ok) {
    return Object.assign(base, {
      verdict: 'fail', reason: pre.reason, unverifiedReason: '',
      assertions: [{ name: 'launch-plan', ok: false, detail: pre.reason }],
      // 还没 spawn：字段是**计划值**，spawned=false 已注明（不是「启动过但没记下来」）
      resolved: buildResolved(planned, p, '', false),
      durationMs: nowMs() - startedAt,
    });
  }

  const port = await (d.freePort || freePort)();
  const plan = Object.assign({}, planned, { port });
  const run = (d.launchApp || launchApp)(plan, p);
  const child = run.child;
  const log = run.log;

  const session = new CdpSession('');
  let screenshot = '';
  const result = Object.assign({}, base);
  // 交付本体是 exe 就记 exe（上游对「要 exe 的任务」只认 kind=exe 的运行记录）。
  result.kind = /\.exe$/i.test(String(p.appPath || '')) ? 'exe' : 'app';
  // ★ 证据主体：只要真的发起了 spawn 就先记下来。放进 result（而不是每条分支各写一份），
  //   这样成功、page-target 失败、后续任意断言失败、以及 catch 兜底路径都自动带上它。
  result.resolved = buildResolved(plan, p, run.cwd || '', true);

  const cleanup = () => {
    session.close();
    killTree(child);
    removeDir(run.userDataDir);
  };

  try {
    // ③ 等真实窗口（只认 type=page + webSocketDebuggerUrl）
    const waited = await (d.waitPageTarget || waitPageTarget)(port, p.readyTimeoutMs, {
      onDead: () => child.exitCode != null,
    });
    result.targetsSeen = waited.targets || [];
    if (!waited.ok) {
      result.verdict = 'fail';
      result.reason = waited.detail || '没有等到真实窗口';
      result.assertions = [{ name: 'page-target', ok: false, detail: result.reason }];
      result.stderrTail = log.stderr.slice(-1200);
      result.stdoutTail = log.stdout.slice(-600);
      result.removedEnv = run.removedEnv;
      result.durationMs = nowMs() - startedAt;
      cleanup();
      return result;
    }

    // ④ 连上窗口
    session.wsUrl = waited.target.webSocketDebuggerUrl;
    await session.connect(12000);
    await session.send('Runtime.enable', {}, 8000);
    await session.send('Page.enable', {}, 8000);
    const consoleErrors = [];
    const pageErrors = [];
    session.on('Runtime.consoleAPICalled', (e) => {
      if (!e || String(e.type) !== 'error') return;
      const txt = (Array.isArray(e.args) ? e.args : []).map((a) => {
        if (!a) return '';
        return String(a.value != null ? a.value : (a.description || a.type || ''));
      }).join(' ').trim();
      if (consoleErrors.length < MAX_ERRORS) consoleErrors.push(clampText(txt, 400));
    });
    session.on('Runtime.exceptionThrown', (e) => {
      const det = (e && e.exceptionDetails) || {};
      const ex = det.exception || {};
      const txt = String(ex.description || ex.value || det.text || '未捕获异常');
      if (pageErrors.length < MAX_ERRORS) {
        pageErrors.push(clampText(txt, 500) + (det.url ? ' @' + det.url + ':' + (det.lineNumber != null ? det.lineNumber + 1 : '?') : ''));
      }
    });
    // 原生下载兜底：让走 BrowserWindow.downloadURL / a[download] 的导出落到目标目录
    if (p.expectExport && p.expectExport.dir) {
      try {
        fs.mkdirSync(p.expectExport.dir, { recursive: true });
        await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(p.expectExport.dir) }, 5000);
      } catch (e) { /* 老版本只认 Page.setDownloadBehavior，失败不影响主判据 */ }
    }

    // ⑤ 在文档创建前挂上错误钩子，然后重载一次。
    //    不重载的话，启动瞬间的异常（正是最典型的那类）永远抓不到。
    let reloaded = false;
    if (!p.noReload) {
      try {
        await session.send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_HOOK }, 5000);
        await session.send('Page.reload', { ignoreCache: false }, 10000);
        reloaded = true;
        await sleep(250);
      } catch (e) { reloaded = false; }
    }
    result.reloaded = reloaded;

    // ⑤ 就绪：href 已切到目标文档 + readyState 已是 complete（两个条件必须同时成立）
    const readyDeadline = nowMs() + p.readyTimeoutMs;
    let href = '';
    let readyState = '';
    let urlOk = false;
    let lastErr = '';
    while (nowMs() < readyDeadline) {
      const r = await session.eval('JSON.stringify({href:String(location.href),readyState:String(document.readyState)})', 8000);
      if (r.ok && typeof r.value === 'string') {
        try {
          const o = JSON.parse(r.value);
          href = String(o.href || '');
          readyState = String(o.readyState || '');
        } catch (e) { lastErr = '读取页面状态失败'; }
      } else {
        lastErr = String(r.reason || '读取页面状态失败');
      }
      const realDoc = !!href && href !== 'about:blank' && /^(file:|https?:|app:)/i.test(href);
      const prefixOk = p.expectUrl ? href.indexOf(p.expectUrl) === 0 : true;
      urlOk = realDoc && prefixOk;
      if (urlOk && readyState === 'complete') break;
      if (p.expectUrl && realDoc && !prefixOk) {
        // 已经到了别的文档：明确失败，不再空等
        lastErr = '窗口实际 URL 与期望前缀不符：实际 ' + href + ' / 期望以 ' + p.expectUrl + ' 开头';
        break;
      }
      await sleep(150);
    }
    result.url = href;
    result.readyState = readyState;
    const readyOk = urlOk && readyState === 'complete';
    result.assertions.push({
      name: 'window-ready',
      ok: readyOk,
      detail: readyOk ? ('真实窗口已就绪：' + href) : ('窗口没有进入可操作状态：href=' + (href || '(空)') + ' readyState=' + (readyState || '(空)') + (lastErr ? '｜' + lastErr : '')),
    });

    // ⑥ 执行交互
    let actionsOut = { interactions: [], shots: [], failedAt: -1 };
    if (p.actions.length && readyOk) {
      actionsOut = await runActions(session, p.actions, p.inputMode, p.screenshot);
      result.interactions = actionsOut.interactions;
      result.assertions.push({
        name: 'actions-all-ok',
        ok: actionsOut.failedAt < 0,
        detail: actionsOut.failedAt < 0
          ? ('全部 ' + p.actions.length + ' 个交互都执行成功')
          : ('第 ' + (actionsOut.failedAt + 1) + ' 个交互失败：' + (result.interactions[actionsOut.failedAt] || {}).detail),
      });
    } else if (p.actions.length && !readyOk) {
      result.interactions = p.actions.map((a) => ({ action: a.type, name: a.name, ok: false, detail: '窗口没就绪，未执行' }));
      result.assertions.push({ name: 'actions-all-ok', ok: false, detail: '窗口没就绪，' + p.actions.length + ' 个交互一个都没执行' });
    }

    // ⑦ 等导出产物
    let exportOut = { ok: true, exported: [] };
    if (p.expectExport) {
      exportOut = await (d.waitExport || waitExport)(p.expectExport, startedAt);
      result.exported = exportOut.exported || [];
      result.assertions.push({
        name: 'export-present',
        ok: !!exportOut.ok,
        detail: exportOut.ok
          ? ('导出产物已落盘：' + result.exported.map((x) => path.basename(x.path) + ' (' + x.size + 'B)').join(', '))
          : String(exportOut.reason || '没有导出产物'),
      });
    }

    // ⑧ 截图（默认在有 screenshot 参数时落一张，不参与判据）
    if (p.screenshot) {
      const s = await shoot(session, p.screenshot);
      if (s.ok) { screenshot = s.path; result.screenshots.push(s.path); }
    }
    for (const sp of actionsOut.shots || []) if (result.screenshots.indexOf(sp) < 0) result.screenshots.push(sp);

    // ⑨ 收尾再读一次错误（导出期间冒出来的异常同样要算）
    //    三路合并：注入钩子记下的（含 reload 前那段）、CDP 实时收到的、以及下面的 console.error。
    await sleep(250);
    let hookErrors = [];
    try {
      const hr = await session.eval('JSON.stringify(window.__douyaVerifyErrors||[])', 8000);
      if (hr.ok && typeof hr.value === 'string') {
        const arrH = JSON.parse(hr.value);
        if (Array.isArray(arrH)) hookErrors = arrH;
      }
    } catch (e) { hookErrors = []; }
    const merged = pageErrors.slice();
    const seenMsg = new Set(merged.map((m) => String(m).slice(0, 120)));
    for (const he of hookErrors) {
      const msg = String((he && he.message) || '未捕获异常');
      const key = (String(he && he.kind || '') + '::' + msg).slice(0, 120);
      if (seenMsg.has(key) || seenMsg.has(msg.slice(0, 120))) continue;
      seenMsg.add(key);
      const where = he && he.source ? ' @' + he.source + ':' + (Number(he.line) || 0) : '';
      merged.push(clampText(msg + where, 500));
    }
    result.hookErrors = hookErrors.length;
    result.consoleErrors = consoleErrors.slice();
    result.pageErrors = merged.slice(0, MAX_ERRORS);
    result.assertions.push({
      name: 'no-pageerror',
      ok: result.pageErrors.length === 0,
      detail: result.pageErrors.length === 0
        ? '渲染进程没有未捕获异常'
        : ('渲染进程有 ' + result.pageErrors.length + ' 条未捕获异常：' + result.pageErrors[0]),
    });
  } catch (e) {
    result.verdict = 'fail';
    result.reason = '桌面验收执行中断：' + String((e && e.message) || e);
    result.stderrTail = log.stderr.slice(-1200);
    result.assertions.push({ name: 'verify-completed', ok: false, detail: result.reason });
    result.removedEnv = run.removedEnv;
    result.durationMs = nowMs() - startedAt;
    cleanup();
    return result;
  }

  // ⑩ 汇总裁决
  result.launched = true;
  result.screenshot = screenshot;
  result.removedEnv = run.removedEnv;
  result.stdoutTail = log.stdout.slice(-600);
  result.stderrTail = log.stderr.slice(-1200);
  const failed = result.assertions.filter((a) => !a.ok);
  // 「窗口开了」本身不是验收：至少要有一次真实交互，或一项产物/内容断言。
  // 否则宁可口径为 unverified —— 这正是「进程活着就当通过」的假绿口子。
  const basicNames = ['window-ready', 'no-pageerror'];
  const contentAssertions = result.assertions.filter((a) => basicNames.indexOf(a.name) < 0);
  const hasSubstance = result.interactions.length > 0 || contentAssertions.length > 0;
  const needsExport = !!(p.expectExport);
  const exportedOk = needsExport ? result.exported.length > 0 : true;
  const pass = failed.length === 0 && hasSubstance && exportedOk;

  result.verified = true;
  result.ok = pass;
  result.verdict = pass ? 'pass' : (hasSubstance ? 'fail' : 'unverified');
  if (pass) {
    result.reason = '真实窗口已启动并完成 ' + (result.interactions.length || 0) + ' 个交互与 '
      + result.assertions.length + ' 项断言，无未捕获异常'
      + (exportedOk && needsExport ? '，导出产物 ' + result.exported.length + ' 个已落盘' : '');
  } else if (!hasSubstance) {
    result.reason = '只启动了窗口，既没有执行任何交互，也没有产物/内容断言 —— 这不构成验收';
    result.unverifiedReason = '窗口起来了，但本次没有检查任何东西';
  } else {
    result.reason = failed.length ? failed[0].detail : (exportedOk ? '断言不足，不能判通过' : '没有导出产物');
  }
  result.artifactPaths = result.exported.map((x) => x.path)
    .concat(result.screenshots)
    .filter(Boolean);
  if (!result.artifactPaths.length && p.appPath) result.artifactPaths = [p.appPath];
  result.durationMs = nowMs() - startedAt;
  cleanup();
  return result;
}

// ───────────────────── marker 构造：紧凑 + 长度上界可控 ─────────────────────
/**
 * marker 的字符上限（**硬上界**，不是期望值）。
 *
 * 为什么是 2500：产品侧把工具结果写进 SSE 时按 `String(result).slice(0, 3000)` 截断
 * （src/main/backend.js:6981 / :8637 / :8680）。真读数（run-20261030015528，本机实测）：
 * 那轮 desktop-verify 的 marker 行 3000 字符、marker 之后的 JSON tail 2975 字符、
 * **括号没配平** —— 结论行被 cap 切成半个 JSON，外部验收只能读到 invalid-json，
 * 「marker 被截断」和「marker 只是格式不对」在读数上糊成一条。
 * ⇒ 留 500 字符余量给令牌本身和未来的小字段，让 3000 的 cap **永远切不到它**。
 */
const MARKER_MAX_CHARS = 2500;

/**
 * 逐级降级时「长文本」保留多少字符：300 → 120 → 40 → 0（只留占位符）。
 *
 * 为什么 0 不是「删掉这条」：pageErrors 的**条数**与**非空**本身就是判据
 * （src/main/runtimeEvidence.js 的「非空即 fail」），删条目等于把一条真失败
 * 洗成通过 —— 所以最后一级是「保留 N 条占位符」，只牺牲文字，不牺牲结论。
 */
const MARKER_CLIP_STEPS = [300, 120, 40, 0];

/**
 * 第二级降级：**条目数上界**（Infinity → 12 → 6 → 3）。
 *
 * 为什么光砍文字不够（这是实测出来的，不是预防性设计）：marker 里有三块成本是
 * **固定**的 —— 真读数（run-20261030015528 第 2 条 marker，行宽 2508）拆开是
 * `resolved` 830 + `url` 180 + `artifactPaths` 192 ≈ 1200 字符，这三块都不能砍
 * （resolved 是归属证据、artifactPaths 要按磁盘核对字节数）。剩下的 ~1300 全给了
 * 条目：真读数有 3 条交互/3 条断言（654 + 351）刚好放下，但**条数是外部输入的**，
 * 20 条交互就要 900+ 字符 —— 单靠砍 detail 永远推不出长度上界。
 * ⇒ 深层降级必须连**条数**一起收，且失败条目一条不丢（失败原因就是判据），
 *   真实条数记进 `interactionsTotal` / `assertionsTotal`（只在被裁剪时出现）。
 */
const MARKER_COUNT_STEPS = [Infinity, 12, 6, 3];

/**
 * 把一段文本裁到上限，超出部分用「…」收尾（**不做整串 slice**：那会切出非法 JSON）。
 * @param {*} value 任意值（内部 String 化）
 * @param {number} max 保留字符数；<=0 ⇒ 只要有内容就退化成单个占位符
 * @returns {string}
 */
function clipMarkerText(value, max) {
  const s = String(value == null ? '' : value);
  if (!s) return '';
  if (max > 0 && s.length <= max) return s;
  return max > 0 ? (s.slice(0, max) + '…') : '…';
}

/**
 * 压缩错误列表：**保留条数**与每条的**前 N 字符**。
 *
 * 为什么不需要整段 stack：runtimeEvidence 只用「非空即 fail」+ 首条做 why；
 * 完整 stack 在正文 JSON（`JSON.stringify(out, null, 2)`）里给人和事后审计看。
 * @param {Array} list
 * @param {number} maxText
 * @returns {Array<string>}
 */
function compactErrorList(list, maxText) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map((x) => clipMarkerText(typeof x === 'object' && x ? (x.message || x.error || JSON.stringify(x)) : x, maxText));
}

/**
 * 压缩交互列表：只留 `{action, name, ok}`。
 *
 * 唯一例外是**失败条目**：`detail` 是失败原因，不能丢（产品侧不读它，但 `reason`
 * 与人工复盘要靠它），因此 `ok===false` 的条目带 detail（按 maxText 截断）。
 * @param {Array} list
 * @param {number} maxText
 * @returns {Array<object>}
 */
function compactInteractions(list, maxText) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map((x) => {
    const row = x && typeof x === 'object' ? x : { action: String(x == null ? '' : x) };
    const kept = { action: row.action, name: row.name, ok: row.ok === true };
    if (row.ok === false && row.detail != null) kept.detail = clipMarkerText(row.detail, maxText);
    return kept;
  });
}

/**
 * 压缩断言列表：只留 `{name, ok}`；`ok===false` 的才带 `detail`（截断后）。
 * @param {Array} list
 * @param {number} maxText
 * @returns {Array<object>}
 */
function compactAssertions(list, maxText) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map((x) => {
    const row = x && typeof x === 'object' ? x : { name: String(x == null ? '' : x) };
    const kept = { name: row.name, ok: row.ok === true };
    if (row.ok === false && row.detail != null) kept.detail = clipMarkerText(row.detail, maxText);
    return kept;
  });
}

/**
 * 条目裁剪：**失败条目一条不丢**，其余按原顺序补到上限。
 *
 * @param {Array<object>} rows 已压缩成 `{..., ok}` 的条目
 * @param {number} maxEntries 条目数上界（`Infinity` ⇒ 不裁）
 * @returns {{rows:Array<object>,omitted:number,total:number}} `omitted>0` 时调用方要记下真实总数
 */
function boundRows(rows, maxEntries) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Number.isFinite(maxEntries) ? Math.max(0, Number(maxEntries)) : Infinity;
  if (list.length <= limit) return { rows: list, omitted: 0, total: list.length };
  const failed = list.filter((r) => r && r.ok === false);
  const rest = list.filter((r) => !r || r.ok !== false);
  // 失败的先占位（它们是判据），剩下的名额按原顺序给正常条目 —— 顺序是"这次验收实际做了什么"，
  // 打乱它会让 marker 读起来像另一条证据。
  const keep = failed.slice(0, Math.max(limit, failed.length)).concat(rest.slice(0, Math.max(0, limit - failed.length)));
  const indexOf = new Map(list.map((r, i) => [r, i]));
  keep.sort((a, b) => (indexOf.get(a) || 0) - (indexOf.get(b) || 0));
  return { rows: keep, omitted: list.length - keep.length, total: list.length };
}

/**
 * 组装 marker 的 JSON 载荷（**结论优先，冗余可牺牲，证据不可砍**）。
 *
 * 保留策略（逐项都有理由，不是随手删）：
 *   · tool/kind/launched/verified/ok/verdict/url/resolved/reason/unverifiedReason ⇒ 全留，缺一个判据就废；
 *   · exported / artifactPaths ⇒ **完整保留**：产品侧要在磁盘上核对字节数，
 *     截断路径等于毁证据（省下来的那点长度不值得）；
 *   · interactions / assertions ⇒ 只留结论字段，失败条目的 detail 保留（失败原因是判据）；
 *   · consoleErrors / pageErrors ⇒ 留条数与每条前 N 字符（非空即 fail 的判据在条数上）。
 *
 * @param {object} out verify()/崩溃兜底产出的结构化结论
 * @param {number} maxText 长文本保留字符数
 * @param {number} [maxEntries=Infinity] interactions/assertions 的条目数上界（失败条目不计入）
 * @returns {object}
 */
function buildMarkerPayload(out, maxText, maxEntries = Infinity) {
  const o = out && typeof out === 'object' ? out : {};
  const interBound = boundRows(compactInteractions(o.interactions, maxText), maxEntries);
  const assertBound = boundRows(compactAssertions(o.assertions, maxText), maxEntries);
  const payload = {
    tool: o.tool, kind: o.kind,
    launched: o.launched === true, verified: o.verified === true, ok: o.ok === true,
    verdict: o.verdict,
    url: o.url,
    interactions: interBound.rows,
    assertions: assertBound.rows,
    exported: Array.isArray(o.exported) ? o.exported : [],
    artifactPaths: Array.isArray(o.artifactPaths) ? o.artifactPaths : [],
    consoleErrors: compactErrorList(o.consoleErrors, maxText),
    pageErrors: compactErrorList(o.pageErrors, maxText),
    // 证据主体随 marker 一起出去：shell 路径与工具路径拿到的是同一份「验的是哪个应用」。
    resolved: o.resolved || null,
    unverifiedReason: String(o.unverifiedReason || ''),
    reason: String(o.reason || ''),
  };
  // 条数只在**被裁剪时**才显式记下来（正常路径的字段形状与历史版本逐字一致）。
  if (interBound.omitted > 0) payload.interactionsTotal = interBound.total;
  if (assertBound.omitted > 0) payload.assertionsTotal = assertBound.total;
  return payload;
}

/**
 * 构造 marker 行（**永不超过 `MARKER_MAX_CHARS`**，且任何一级都是合法 JSON）。
 *
 * 降级顺序（先砍冗余、后砍文字、再砍条数，**绝不整串 slice**）：
 *   ① 长文本 300 → 120 → 40 → 占位符（先砍 pageErrors/consoleErrors 与失败条目的 detail）；
 *   ② 仍超 ⇒ 条目数 12 → 6 → 3（失败条目一条不丢，真实条数记进 *Total）；
 *   ③ 砍到底仍超（现实里只可能是 exported/artifactPaths 极多，而那两项**绝不截断**）
 *     ⇒ 把 reason / unverifiedReason 收到 300 字符，并加 `markerTrimmed: true` 显式标注。
 * 为什么不用「整串 slice」收尾：那会切出**非法 JSON**，正是这次要根治的病
 * （真读数：marker 被 3000 cap 切成 Unterminated string at position 2975）。
 *
 * @param {object} out
 * @returns {string} `DOUYA_RUNTIME_ACCEPTANCE={...}`（单行）
 */
function buildRuntimeMarker(out) {
  const o = out && typeof out === 'object' ? out : {};
  for (const maxEntries of MARKER_COUNT_STEPS) {
    for (const maxText of MARKER_CLIP_STEPS) {
      const text = RUNTIME_MARKER + JSON.stringify(buildMarkerPayload(o, maxText, maxEntries));
      if (text.length <= MARKER_MAX_CHARS) return text;
    }
  }
  const lastEntries = MARKER_COUNT_STEPS[MARKER_COUNT_STEPS.length - 1];
  const payload = buildMarkerPayload(o, 0, lastEntries);
  payload.reason = clipMarkerText(payload.reason, 300);
  payload.unverifiedReason = clipMarkerText(payload.unverifiedReason, 300);
  payload.markerTrimmed = true;
  return RUNTIME_MARKER + JSON.stringify(payload);
}

/**
 * 技能入口（本项目约定：run.js 导出 async run(params, ctx)）。
 * @param {object} params
 * @param {object} [_ctx]
 * @returns {Promise<string>} 纯 JSON 字符串
 */
async function run(params, _ctx) {
  return runWithDeps(params, undefined);
}

/**
 * 可注入依赖版本（单测用）。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<string>}
 */
async function runWithDeps(params, deps) {
  let out;
  try {
    out = await verify(params, deps);
  } catch (e) {
    out = {
      tool: 'desktop-verify', kind: 'app', launched: false, verified: false, ok: false,
      verdict: 'fail', reason: '桌面验收崩溃：' + String((e && e.message) || e),
      interactions: [], assertions: [{ name: 'verify-completed', ok: false, detail: '崩溃' }],
      exported: [], consoleErrors: [], pageErrors: [], screenshots: [], artifactPaths: [],
      resolved: null,
    };
  }
  // ★★ 2026-10-30（第二次修复，真读数驱动）：marker **放在最前面**，并且**自足**（带
  //   verified / ok / resolved）+ **长度上界可控**（见 buildRuntimeMarker）。
  //   第一版只解决了「marker 在最后一行 ⇒ 被切掉」，没解决「marker 自己太长 ⇒ 被切一半」：
  //   真读数 run-20261030015528 的 marker 行整整 3000 字符（里面塞了完整 pageErrors 的
  //   stack trace 与每条 interaction 的 detail），产品侧 `slice(0, 3000)` 正好切在它中段，
  //   外部验收读到的是 `Unterminated string in JSON at position 2975` —— marker 先行也救不了。
  //   ⇒ 结论必须**稳定装进 2500 字符**：只保留判据必需字段，冗余（整段 stack / 非失败的
  //     detail）只在正文 JSON 里给人看。
  //   兼容性：产品侧 `runtimeEvidence.parseJson` 支持两种顺序（见该函数头注），
  //   它的 marker 扫描本来就是逐行 indexOf，与顺序无关；marker 里的字段名一个没改。
  const marker = buildRuntimeMarker(out);
  return marker + '\n' + JSON.stringify(out, null, 2);
}

module.exports = {
  run, runWithDeps, verify, RUNTIME_MARKER,
  /** 门禁用：直接拿 marker 构造器验长度上界与降级不变量（不需要真起 Electron）。 */
  buildRuntimeMarker, buildMarkerPayload, MARKER_MAX_CHARS, MARKER_CLIP_STEPS, MARKER_COUNT_STEPS,
  _internals: { matchGlob, oneLine, CdpSession, preflightPaths },
};
