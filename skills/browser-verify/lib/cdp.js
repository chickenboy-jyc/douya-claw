'use strict';
/**
 * Chrome DevTools Protocol（CDP）驱动层：起一个 headless Chromium → 连上 → 开页面 →
 * 收集控制台/异常/网络失败 → 执行交互 → 断言 → 截图。
 *
 * 依赖：仅 Node 标准库 + 本目录 ./miniws（无第三方包，零下载）。
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const MiniWebSocket = require('./miniws');
// 子进程字节 → 文本的唯一真源（stderr/给人看的文案允许 GBK 回退，见该文件头部）。
// 跨树 require 通路与 src/shared/pythonRuntime 同款；打包布局下靠
// electron-builder.yml 的 extraResources 把 src/main/childOutput.js 搬到 resources/src/main/。
const { decodeOutput } = require('../../../src/main/childOutput');

const DEVTOOLS_RE = /DevTools listening on (ws:\/\/\S+)/;
const IGNORED_REQUEST_RE = /\/favicon\.ico(\?|$)/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 活动 profile 登记 + 收尾清理（#44）
//
// 为什么不能只靠 setTimeout 重试：强杀 / 提前退出时定时器根本不跑。
//   旧实现 `setTimeout(attempt, …).unref()` 是竞态根因 —— unref 的定时器**不阻止进程退出**，
//   于是「浏览器一关就退出的验证脚本」在重试窗口内就退出了 ⇒ 收尾被跳过 ⇒ 残留 douya-bv-*。
// 对策两条，缺一不可：
//   ① 本进程登记「活动 profile 集合」，挂 exit/SIGINT/SIGTERM 兜底逐个删**登记过的确切路径**；
//   ② 重试定时器**保持引用**（不再 unref），有界（≤6 次、末次约 3.6s），保证句柄释放后还能删。
// ⚠️ 只删本进程登记的确切路径，绝不按前缀 sweep 整个 tmp（会误删并发兄弟会话的 profile）。
// ---------------------------------------------------------------------------
const ACTIVE_PROFILES = new Set();
let profileCleanupHooked = false;

function attemptRemoveProfile(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* 句柄未释放：交给下一次重试 */
  }
  return !fs.existsSync(dir);
}

/** 收尾：删掉所有仍登记在案的活动 profile。@returns {string[]} 没删干净的路径（供门禁/报告核对）。 */
function purgeActiveProfiles() {
  const leftovers = [];
  for (const dir of [...ACTIVE_PROFILES]) {
    if (attemptRemoveProfile(dir)) ACTIVE_PROFILES.delete(dir);
    else leftovers.push(dir);
  }
  return leftovers;
}

function hookProfileCleanup() {
  if (profileCleanupHooked) return;
  profileCleanupHooked = true;
  process.on('exit', () => { purgeActiveProfiles(); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      purgeActiveProfiles();
      process.exit(sig === 'SIGINT' ? 130 : 143); // 非 0：不把「被中断」伪装成成功
    });
  }
}

/** 登记一个刚创建的活动 profile 目录，并确保收尾钩子已挂上。 */
function registerProfile(dir) {
  if (!dir) return;
  ACTIVE_PROFILES.add(dir);
  hookProfileCleanup();
}

// ---------------------------------------------------------------------------
// 启停浏览器
// ---------------------------------------------------------------------------

/**
 * 启动一个 headless Chromium（用系统已装的 Edge/Chrome/Chromium/Brave）。
 * 端口用 0 = 让浏览器自己挑，避免与用户的调试端口冲突。
 * @param {{exe:string, timeoutMs?:number}} opts
 * @returns {Promise<{child:import('child_process').ChildProcess, wsUrl:string, profileDir:string}>}
 */
function launchChromium(opts) {
  const exe = opts.exe;
  const timeoutMs = opts.timeoutMs || 20000;
  // 独立临时 profile：不碰用户浏览器配置，也不复用旧会话
  const profileDir = path.join(os.tmpdir(), 'douya-bv-' + process.pid + '-' + Date.now());
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (e) {
    /* 创建失败时浏览器自己也会再报错 */
  }
  registerProfile(profileDir); // #44：登记进收尾集合（见文件上方「活动 profile 登记」说明）
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--mute-audio',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--window-size=1366,900',
    'about:blank',
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(new Error('启动浏览器失败：' + e.message));
    }
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error('启动浏览器超时（' + timeoutMs + 'ms 内没拿到调试端口）'));
    }, timeoutMs);

    const onData = (d) => {
      // 【解码分类：stdout+stderr 混流 → GBK 回退】
      //   这里同时挂了 stdout 与 stderr（electron/chromium 的 "DevTools listening on …"
      //   在哪个流上不固定）。解码后的文本有两个用途：
      //     ① 用 `DEVTOOLS_RE` 抓 ws URL —— 纯 ASCII，GBK 回退对它零影响；
      //     ② 起进程失败时 `buf.slice(-300)` **原样进错误文案**给用户看
      //        （"浏览器提前退出（code=…）：<buf>"）。这一半是用户可见的错误信息，
      //        中文路径/中文用户名在这里按 utf8 硬解就是一串 `�`。
      //   ⇒ 用 decodeOutput()：ASCII 与合法 UTF-8 输入结果与 utf8 完全一致，只在
      //     "utf8 解出 FFFD 而 gbk 更干净" 时才切换到 GBK。
      buf += decodeOutput(d);
      if (settled) return;
      const m = DEVTOOLS_RE.exec(buf);
      if (m) {
        settled = true;
        clearTimeout(timer);
        detach();
        resolve({ child, wsUrl: m[1], profileDir });
      }
    };
    function detach() {
      try {
        child.stdout.removeListener('data', onData);
      } catch (e) {
        /* ignore */
      }
      try {
        child.stderr.removeListener('data', onData);
      } catch (e) {
        /* ignore */
      }
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('浏览器进程错误：' + e.message));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('浏览器提前退出（code=' + code + '）：' + buf.slice(-300)));
    });
  });
}

/** 关掉浏览器进程树并清掉临时 profile（best-effort，绝不抛错）。 */
function killBrowser(child, profileDir) {
  try {
    if (child && child.pid && !child.killed) {
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch (e) {
          /* ignore */
        }
      }
      child.kill('SIGKILL');
    }
  } catch (e) {
    /* ignore */
  }
  scheduleProfileCleanup(profileDir);
}

/**
 * 清理临时 profile 目录。
 *
 * 为什么不能只 rmSync 一次：浏览器刚被 taskkill，**文件句柄还没释放**，Windows 下
 * rmdir 会 ENOTEMPTY/EBUSY 失败 —— 实测会残留 douya-bv-* 目录。因此改成
 * 「立即试一次 + 延时重试」，全程 best-effort，失败也只是留下一个临时目录，
 * 绝不影响验证结论（不抛错、不改变返回值）。
 * 兜底：登记的路径还会在 exit/SIGINT/SIGTERM 时被 purgeActiveProfiles() 再删一遍。
 * @param {string} dir
 */
function scheduleProfileCleanup(dir) {
  if (!dir) return;
  let tries = 0;
  const attempt = () => {
    tries += 1;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* 句柄未释放，下面重试 */
    }
    if (!fs.existsSync(dir)) {
      ACTIVE_PROFILES.delete(dir); // 删掉了 ⇒ 从收尾集合摘掉，免得退出时白跑一遍
      return;
    }
    // 🔴 不调用 `.unref()`：unref 的定时器不阻止进程退出 ⇒ 强杀/提前退出时收尾根本不跑
    //    （这正是 douya-bv-* 残留的竞态根因）。保持引用，有界：最多 6 次、末次约 3.6s。
    if (tries < 6) setTimeout(attempt, 600 * tries);
  };
  attempt();
}

// ---------------------------------------------------------------------------
// HTTP 小工具（/json/list 等）
// ---------------------------------------------------------------------------

function httpJson(origin, urlPath, method, timeoutMs) {
  const ms = timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    const req = http.request(origin + urlPath, { method: method || 'GET', timeout: ms }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        b += c;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('调试端口返回 HTTP ' + res.statusCode + '（' + urlPath + '）'));
        }
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(new Error('调试端口响应不是 JSON：' + b.slice(0, 120)));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('访问调试端口超时：' + urlPath));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 连到 browser 级调试地址，拿到一个可用的 page 目标 ws 地址。
 * @param {string} browserWsUrl 形如 ws://127.0.0.1:PORT/devtools/browser/UUID
 * @param {number} [timeoutMs]
 * @returns {Promise<{origin:string, pageWsUrl:string}>}
 */
async function connectCdp(browserWsUrl, timeoutMs) {
  const raw = String(browserWsUrl).trim();
  // 允许用户直接给 http://127.0.0.1:9222
  const origin = /^https?:\/\//i.test(raw)
    ? raw.replace(/\/+$/, '')
    : raw.replace(/^ws/, 'http').replace(/\/devtools\/.*$/, '');
  const deadline = Date.now() + (timeoutMs || 8000);
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson(origin, '/json/list', 'GET', 3000);
      const pages = (Array.isArray(list) ? list : []).filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
      if (pages.length) {
        const blank = pages.find((t) => t.url === 'about:blank') || pages[0];
        return { origin, pageWsUrl: blank.webSocketDebuggerUrl };
      }
      // 没有 page 目标：让浏览器新建一个（新版 Chromium 要求 PUT）
      let created = null;
      try {
        created = await httpJson(origin, '/json/new?about:blank', 'PUT', 3000);
      } catch (e) {
        created = null;
      }
      if (created && created.webSocketDebuggerUrl) {
        return { origin, pageWsUrl: created.webSocketDebuggerUrl };
      }
      lastErr = new Error('浏览器里没有可用的页面目标（page target）');
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error('连接浏览器调试端口失败：' + (lastErr ? lastErr.message : '超时'));
}

// ---------------------------------------------------------------------------
// CDP 会话
// ---------------------------------------------------------------------------

class CdpSession {
  /**
   * @param {MiniWebSocket} ws
   * @param {number} [defaultTimeoutMs]
   */
  constructor(ws, defaultTimeoutMs) {
    this.ws = ws;
    this.defaultTimeoutMs = defaultTimeoutMs || 15000;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._closed = false;
    ws.on('message', (text) => this._onMessage(text));
    ws.on('error', (e) => {
      // 连接断了：把挂起的请求全部 reject，避免永久挂起
      for (const [, p] of this._pending) p.reject(new Error('CDP 连接错误：' + (e && e.message ? e.message : String(e))));
      this._pending.clear();
    });
    ws.on('close', () => {
      this._closed = true;
      for (const [, p] of this._pending) p.reject(new Error('CDP 连接已关闭'));
      this._pending.clear();
    });
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (msg.id && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error('CDP ' + p.method + ' 失败：' + (msg.error.message || JSON.stringify(msg.error))));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const list = this._listeners.get(msg.method) || [];
      for (const fn of list) {
        try {
          fn(msg.params, msg);
        } catch (e) {
          /* 监听器异常不影响会话 */
        }
      }
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  send(method, params, timeoutMs) {
    if (this._closed) return Promise.reject(new Error('CDP 会话已关闭，无法发送 ' + method));
    const id = ++this._id;
    const ms = timeoutMs || this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('CDP ' + method + ' 超时（' + ms + 'ms）'));
      }, ms);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * @param {string} method
   * @param {Function} fn
   */
  on(method, fn) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(fn);
  }

  close() {
    this._closed = true;
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 页面事实 / 交互 / 断言
// ---------------------------------------------------------------------------

/**
 * 页面事实探测。
 *
 * 「白屏」判定**不能只看 body 有没有子节点**：最常见的 SPA 白屏是
 * `<div id="root"></div>`（有子节点 1 个、但里面啥都没渲染出来）。
 * 因此这里改成看「有没有**可见内容**」：
 *   · 有可见文字（body.innerText 非空，或某个可见元素**自身**有文本节点）；或
 *   · 有可见的媒体/图形元素（img/canvas/video/svg/picture/iframe），或表单控件（input/select/textarea/button）；或
 *   · 有面积较大且带 background-image 的块。
 * 三者皆无 ⇒ 判为白屏。这是「返回 200 但用户看到一片空白」的机器判据。
 */
const PAGE_FACTS_EXPR = '(function(){' +
  'var body=document.body;' +
  'var text=body?(body.innerText||"").trim():"";' +
  'var hasText=false,hasMedia=false,visibleCount=0,bgChecked=0;' +
  'if(body){' +
  'var all=body.querySelectorAll("*");' +
  'var LIMIT=Math.min(all.length,2000);' +
  'for(var i=0;i<LIMIT;i++){' +
  'var e=all[i];var r=e.getBoundingClientRect();' +
  'if(!(r.width>2&&r.height>2))continue;' +
  'visibleCount++;' +
  'var tag=e.tagName?e.tagName.toUpperCase():"";' +
  'if(tag==="IMG"||tag==="CANVAS"||tag==="VIDEO"||tag==="SVG"||tag==="PICTURE"||tag==="IFRAME"||' +
  'tag==="INPUT"||tag==="SELECT"||tag==="TEXTAREA"||tag==="BUTTON"||tag==="HR"){hasMedia=true;continue;}' +
  'var nodes=e.childNodes;var own=false;' +
  'for(var j=0;j<nodes.length;j++){var n=nodes[j];' +
  'if(n.nodeType===3&&String(n.textContent||"").trim()){own=true;break;}}' +
  'if(own){hasText=true;continue;}' +
  'if(bgChecked<80&&r.width>40&&r.height>40){bgChecked++;' +
  'try{var st=window.getComputedStyle(e);if(st&&st.backgroundImage&&st.backgroundImage!=="none"){hasMedia=true;}}catch(err){}}' +
  '}' +
  '}' +
  'if(text.length>0)hasText=true;' +
  'var white=(!hasText)&&(!hasMedia);' +
  'return JSON.stringify({' +
  'title:document.title||"",' +
  'url:location.href,' +
  'readyState:document.readyState,' +
  'textLength:text.length,' +
  'textSample:text.slice(0,200),' +
  'bodyChildren:body?body.children.length:0,' +
  'visibleElements:visibleCount,' +
  'hasVisibleText:hasText,' +
  'hasVisibleMedia:hasMedia,' +
  'htmlLength:document.documentElement?document.documentElement.outerHTML.length:0,' +
  'whiteScreen:white});})()';

function buildClickExpr(selector) {
  return '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');' +
    'if(!el)return {ok:false,reason:"选择器未找到元素"};' +
    'try{el.scrollIntoView({block:"center"});}catch(e){}' +
    'if(typeof el.click!=="function")return {ok:false,reason:"该元素不可点击（没有 click 方法）"};' +
    'el.click();return {ok:true};})()';
}

function buildFillExpr(selector, value) {
  return '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');' +
    'if(!el)return {ok:false,reason:"选择器未找到元素"};' +
    'try{if(typeof el.focus==="function")el.focus();}catch(e){}' +
    'var proto=el.tagName==="TEXTAREA"?window.HTMLTextAreaElement.prototype:' +
    '(el.tagName==="SELECT"?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype);' +
    'var d=Object.getOwnPropertyDescriptor(proto,"value");' +
    'if(d&&d.set)d.set.call(el,' + JSON.stringify(value) + ');else el.value=' + JSON.stringify(value) + ';' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));' +
    'el.dispatchEvent(new Event("change",{bubbles:true}));' +
    'return {ok:true,value:String(el.value)};})()';
}

function buildWaitExpr(selector, timeoutMs) {
  return '(function(){return new Promise(function(resolve){' +
    'var t0=Date.now();' +
    '(function tick(){' +
    'if(document.querySelector(' + JSON.stringify(selector) + '))return resolve({ok:true});' +
    'if(Date.now()-t0>' + String(timeoutMs) + ')return resolve({ok:false,reason:"等待元素超时（' + String(timeoutMs) + 'ms）"});' +
    'setTimeout(tick,100);})();});})()';
}

function buildTextExpr(text) {
  return '(function(){var t=(document.body&&document.body.innerText)||"";' +
    'return t.toLowerCase().indexOf(' + JSON.stringify(String(text).toLowerCase()) + ')>=0;})()';
}

function buildSelectorExpr(selector) {
  return '!!document.querySelector(' + JSON.stringify(selector) + ')';
}

/**
 * 跑完一整轮页面验收。
 *
 * 语义约定：
 *   · `verified` 只表示「真的接上了浏览器并执行了检查」，**不代表通过**；
 *   · 站点打不开 / 白屏 / 控制台报错 / 请求失败 / 断言失败 ⇒ 都是 verified=true 的**真实问题**；
 *   · 浏览器起不来 ⇒ verified=false（"根本没检查成"），由上层报错，绝不伪装成功。
 *   · 断言与交互按「先 actions 后 assertions」顺序执行：断言看到的是交互之后的页面状态。
 *
 * @param {object} o
 * @returns {Promise<object>} evidence
 */
async function runPageChecks(o) {
  const startedAt = Date.now();
  const timeoutMs = o.timeoutMs || 30000;
  const settleMs = typeof o.settleMs === 'number' ? o.settleMs : 800;

  const evidence = {
    verified: false,
    engine: o.engine || null,
    target: { url: o.url, httpStatus: null },
    page: null,
    navigationFailed: null,
    consoleErrors: [],
    pageErrors: [],
    logErrors: [],
    failedRequests: [],
    ignoredRequests: [],
    requestFailures: [],
    actions: [],
    assertions: [],
    screenshot: null,
    checksRun: 0,
    durationMs: 0,
  };

  const ws = new MiniWebSocket(o.pageWsUrl, { maxPayload: 96 * 1024 * 1024 });
  await ws.waitOpen(8000);
  const session = new CdpSession(ws, Math.max(15000, timeoutMs));

  // ---- 事件收集 ----
  const reqUrlById = new Map();
  const pendingReq = new Set();
  let lastActivity = Date.now();
  let sawLoadEvent = false;
  const documentStatuses = [];

  session.on('Page.loadEventFired', () => {
    sawLoadEvent = true;
    lastActivity = Date.now();
  });
  session.on('Network.requestWillBeSent', (p) => {
    if (!p) return;
    reqUrlById.set(p.requestId, p.request && p.request.url);
    pendingReq.add(p.requestId);
    lastActivity = Date.now();
  });
  session.on('Network.loadingFinished', (p) => {
    if (p) pendingReq.delete(p.requestId);
    lastActivity = Date.now();
  });
  session.on('Network.loadingFailed', (p) => {
    if (!p) return;
    pendingReq.delete(p.requestId);
    lastActivity = Date.now();
    // 主动取消（例如被 JS abort）不算站点缺陷，但仍如实记录
    const url = reqUrlById.get(p.requestId) || '';
    const errorText = p.errorText || '未知网络错误';
    // 同一 URL + 同一错误只记一条：浏览器对主文档失败可能同时抛主资源与子资源两条 loadingFailed
    const dup = evidence.requestFailures.some((r) => r.url === url && r.errorText === errorText);
    if (!dup) {
      evidence.requestFailures.push({
        requestId: p.requestId,
        url,
        errorText,
        canceled: !!p.canceled,
        type: p.type || '',
      });
    }
  });
  session.on('Network.responseReceived', (p) => {
    if (!p || !p.response) return;
    const url = p.response.url || '';
    if (p.type === 'Document') documentStatuses.push(p.response.status);
    if (p.response.status >= 400) {
      const item = { status: p.response.status, url, type: p.type || '', method: (p.response.requestHeaders && p.response.requestHeaders[':method']) || '' };
      if (IGNORED_REQUEST_RE.test(url)) evidence.ignoredRequests.push(Object.assign({ reason: 'favicon 噪声' }, item));
      else evidence.failedRequests.push(item);
    }
  });
  session.on('Runtime.consoleAPICalled', (p) => {
    if (!p) return;
    if (p.type !== 'error' && p.type !== 'assert') return;
    const text = (p.args || [])
      .map((a) => (a && a.value !== undefined && a.value !== null ? String(a.value) : (a && (a.description || a.type)) || ''))
      .join(' ')
      .trim();
    if (text) evidence.consoleErrors.push(text);
  });
  session.on('Runtime.exceptionThrown', (p) => {
    const d = p && p.exceptionDetails;
    if (!d) return;
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常';
    evidence.pageErrors.push(String(desc).split('\n')[0]);
  });
  session.on('Log.entryAdded', (p) => {
    const e = p && p.entry;
    if (!e || e.level !== 'error') return;
    evidence.logErrors.push({ source: e.source || '', text: e.text || '', url: e.url || '' });
  });

  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Network.enable');

  // ---- 导航 ----
  let navResult = null;
  try {
    navResult = await session.send('Page.navigate', { url: o.url }, timeoutMs + 5000);
  } catch (e) {
    navResult = null;
    evidence.navigationFailed = '导航失败：' + e.message;
  }
  if (navResult && navResult.errorText) {
    evidence.navigationFailed = '页面打不开：' + navResult.errorText;
  }

  // 等 load 事件（或超时）
  const navDeadline = Date.now() + timeoutMs;
  while (!sawLoadEvent && Date.now() < navDeadline) {
    await sleep(100);
  }
  if (!sawLoadEvent && !evidence.navigationFailed) {
    evidence.navigationFailed = '页面在 ' + timeoutMs + 'ms 内没有触发 load 事件（可能一直卡在加载中）';
  }

  // 等网络静默（networkidle）+ 额外 settle，均设上限，绝不无限等
  const idleDeadline = Date.now() + 4000;
  while (Date.now() < idleDeadline) {
    if (pendingReq.size === 0 && Date.now() - lastActivity >= 500) break;
    await sleep(150);
  }
  if (settleMs > 0) await sleep(settleMs);

  // ---- 页面事实 ----
  let facts = null;
  try {
    const raw = await session.send(
      'Runtime.evaluate',
      { expression: PAGE_FACTS_EXPR, returnByValue: true },
      10000
    );
    if (raw && raw.exceptionDetails) {
      evidence.navigationFailed = evidence.navigationFailed || ('读取页面内容时脚本报错：' + (raw.exceptionDetails.text || ''));
    } else if (raw && raw.result && typeof raw.result.value === 'string') {
      facts = JSON.parse(raw.result.value);
    }
  } catch (e) {
    evidence.navigationFailed = evidence.navigationFailed || ('读取页面内容失败：' + e.message);
  }

  const finalUrl = (facts && facts.url) || '';
  const isErrorPage = /^chrome-error:/i.test(finalUrl);
  if (isErrorPage) {
    evidence.navigationFailed = evidence.navigationFailed || '浏览器停在错误页（' + finalUrl + '）';
  }

  // 主文档 HTTP 状态（最后一次 Document 响应）
  if (documentStatuses.length) {
    evidence.target.httpStatus = documentStatuses[documentStatuses.length - 1];
  }

  const pageOk = !!facts && !isErrorPage;
  evidence.page = facts
    ? {
        finalUrl,
        title: facts.title,
        httpStatus: evidence.target.httpStatus,
        readyState: facts.readyState,
        textLength: facts.textLength,
        textSample: facts.textSample,
        bodyChildren: facts.bodyChildren,
        visibleElements: facts.visibleElements,
        hasVisibleText: facts.hasVisibleText,
        hasVisibleMedia: facts.hasVisibleMedia,
        htmlLength: facts.htmlLength,
        whiteScreen: pageOk ? !!facts.whiteScreen : false,
      }
    : null;

  evidence.checksRun += 5; // 浏览器内核 / 页面打开 / 白屏 / 控制台 / 网络

  // 总时长预算：本技能跑在 Electron 主进程里（JS 技能无外部超时兜底），
  // 必须自己兜住最坏情况，绝不把主进程拖死。
  const budgetMs = timeoutMs + settleMs + 60000;
  const overallDeadline = startedAt + budgetMs;
  const budgetLabel = '约 ' + Math.round(budgetMs / 1000) + ' 秒';

  // ---- 交互（在页面可用时才执行）----
  if (pageOk) {
    for (const act of o.actions || []) {
      const rec = { type: act.type, selector: act.selector, ok: false, detail: '' };
      if (Date.now() > overallDeadline) {
        rec.skipped = true;
        rec.detail = '总时长预算（' + budgetLabel + '）用尽，未执行该交互';
        evidence.actions.push(rec);
        continue;
      }
      try {
        if (act.type === 'click') {
          const r = await session.send('Runtime.evaluate', { expression: buildClickExpr(act.selector), returnByValue: true, userGesture: true }, 10000);
          const v = r && r.result ? r.result.value : null;
          if (v && v.ok) {
            rec.ok = true;
          } else {
            rec.detail = (v && v.reason) || '点击未生效';
          }
        } else if (act.type === 'fill') {
          const r = await session.send('Runtime.evaluate', { expression: buildFillExpr(act.selector, act.value), returnByValue: true, userGesture: true }, 10000);
          const v = r && r.result ? r.result.value : null;
          if (v && v.ok) {
            rec.ok = true;
            rec.value = v.value;
          } else {
            rec.detail = (v && v.reason) || '填充未生效';
          }
        } else if (act.type === 'waitFor') {
          const r = await session.send('Runtime.evaluate', { expression: buildWaitExpr(act.selector, act.timeoutMs), returnByValue: true, awaitPromise: true }, act.timeoutMs + 5000);
          const v = r && r.result ? r.result.value : null;
          if (v && v.ok) {
            rec.ok = true;
          } else {
            rec.detail = (v && v.reason) || '等待元素超时';
          }
        }
      } catch (e) {
        rec.detail = '执行异常：' + e.message;
      }
      evidence.actions.push(rec);
      evidence.checksRun += 1;
    }

    // ---- 断言（在交互之后跑）----
    if (o.expectText) {
      const name = '页面应出现文字「' + o.expectText + '」';
      if (Date.now() > overallDeadline) {
        evidence.assertions.push({ name, status: 'SKIP', detail: '总时长预算（' + budgetLabel + '）用尽，未执行该断言' });
      } else {
        const rec = { name, status: 'FAIL', detail: '' };
        try {
          const r = await session.send('Runtime.evaluate', { expression: buildTextExpr(o.expectText), returnByValue: true }, 8000);
          const found = !!(r && r.result && r.result.value === true);
          rec.status = found ? 'PASS' : 'FAIL';
          rec.detail = found ? '' : '页面可见文字里没有这段内容（可能是文案没渲染出来，或站点内容不对）';
        } catch (e) {
          rec.detail = '检查异常：' + e.message;
        }
        evidence.assertions.push(rec);
        evidence.checksRun += 1;
      }
    }
    if (o.expectSelector) {
      const name = '页面应存在元素 ' + o.expectSelector;
      if (Date.now() > overallDeadline) {
        evidence.assertions.push({ name, status: 'SKIP', detail: '总时长预算（' + budgetLabel + '）用尽，未执行该断言' });
      } else {
        const rec = { name, status: 'FAIL', detail: '' };
        try {
          const r = await session.send('Runtime.evaluate', { expression: buildSelectorExpr(o.expectSelector), returnByValue: true }, 8000);
          const found = !!(r && r.result && r.result.value === true);
          rec.status = found ? 'PASS' : 'FAIL';
          rec.detail = found ? '' : 'document.querySelector 没找到该元素';
        } catch (e) {
          rec.detail = '检查异常：' + e.message;
        }
        evidence.assertions.push(rec);
        evidence.checksRun += 1;
      }
    }
  } else {
    // 页面没起来：交互/断言一律标记为「未执行」，而不是假装通过
    for (const act of o.actions || []) {
      evidence.actions.push({ type: act.type, selector: act.selector, ok: false, detail: '页面未加载成功，未执行该交互', skipped: true });
    }
    for (const name of [o.expectText ? '页面应出现文字「' + o.expectText + '」' : '', o.expectSelector ? '页面应存在元素 ' + o.expectSelector : '']) {
      if (name) evidence.assertions.push({ name, status: 'SKIP', detail: '页面未加载成功，未执行该断言' });
    }
  }

  // ---- 截图 ----
  if (o.screenshot && pageOk) {
    try {
      const shot = await session.send('Page.captureScreenshot', { format: 'png' }, 15000);
      if (shot && shot.data) {
        const dir = o.screenshotDir || os.tmpdir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(o.screenshotPath, Buffer.from(shot.data, 'base64'));
        evidence.screenshot = o.screenshotPath;
      }
    } catch (e) {
      evidence.screenshotError = '截图失败：' + e.message;
    }
  }

  session.close();
  evidence.verified = true;
  evidence.durationMs = Date.now() - startedAt;
  return evidence;
}

module.exports = {
  launchChromium,
  killBrowser,
  scheduleProfileCleanup,
  connectCdp,
  runPageChecks,
  CdpSession,
  IGNORED_REQUEST_RE,
  PAGE_FACTS_EXPR,
  buildClickExpr,
  buildFillExpr,
  buildWaitExpr,
  buildTextExpr,
  buildSelectorExpr,
};
