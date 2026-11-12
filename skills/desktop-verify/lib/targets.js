'use strict';
/**
 * 调试端口 discovery：轮询 `http://127.0.0.1:<port>/json/list`，挑出**真实窗口** target。
 *
 * ★ 为什么这一步是整套工具的命根子：
 *   桌面验收最大的假绿来源就是「进程起来了」被当成「窗口起来了」。
 *   ELECTRON_RUN_AS_NODE=1 时进程照常在跑（甚至输出也一样），但**一个窗口都没有**；
 *   后续所有 evaluate 都会被无声地丢掉，于是"检查了 8 项全绿"其实是"什么都没检查"。
 *   所以这里**只认 type==='page' 且带 webSocketDebuggerUrl 的 target**，其它一律不算，
 *   并把当时实际的 target 列表原样带回，让报告能说明「看到了什么、为什么不算」。
 */

const http = require('http');

/**
 * 取一个调试端口的 /json/list。
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<Array<object>>}
 */
function listTargets(port, timeoutMs) {
  const ms = timeoutMs || 3000;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/json/list', method: 'GET', timeout: ms },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('调试端口返回 HTTP ' + res.statusCode));
            return;
          }
          try {
            const j = JSON.parse(b);
            resolve(Array.isArray(j) ? j : []);
          } catch (e) {
            reject(new Error('调试端口响应不是 JSON：' + String(b).slice(0, 120)));
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('访问调试端口超时')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 取调试端口的版本信息（带 &，顺带骗过 Chrome 的 Host 头校验）。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
function version(port, timeoutMs) {
  const ms = timeoutMs || 3000;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/json/version', method: 'GET', timeout: ms },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('版本信息不是 JSON')); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('访问调试端口超时')); });
    req.on('error', reject);
    req.end();
  });
}

/** 挑真正的窗口：Electron 会同时挂出 DevTools / background_page 等一堆 target。 */
function isPageTarget(t) {
  return !!(t && t.type === 'page' && t.webSocketDebuggerUrl);
}

function brief(t) {
  if (!t) return null;
  return { type: String(t.type || ''), url: String(t.url || '').slice(0, 200), title: String(t.title || '').slice(0, 80) };
}

/**
 * 轮询直到出现真实窗口 target。
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @param {{pollMs?:number, now?:() => number, onDead?:() => boolean}} [opts]
 *   onDead：让调用方告知「子进程已经没了」⇒ 立刻放弃等待（没人是真，早失败早报告）
 * @returns {Promise<{ok:boolean, target?:object, targets?:Array<object>, polls?:number, detail?:string}>}
 */
async function waitPageTarget(port, timeoutMs, opts) {
  const o = opts || {};
  const pollMs = o.pollMs || 300;
  const now = o.now || Date.now;
  const deadline = now() + timeoutMs;
  let polls = 0;
  let lastErr = '';
  let lastSeen = [];
  while (now() < deadline) {
    polls += 1;
    try {
      const list = await listTargets(port, 2500);
      lastSeen = list.map(brief);
      const pages = list.filter(isPageTarget);
      if (pages.length) {
        // 同栏多个窗口时优先挑 url 已经不是 about:blank 的那个（真实文档通常滞后几毫秒出现）
        const realDoc = pages.find((t) => String(t.url || '') !== 'about:blank');
        const chosen = realDoc || pages[0];
        return { ok: true, target: chosen, targets: lastSeen, polls };
      }
      lastErr = '已连上调试端口，但没有 type=page 的窗口目标（进程可能在被当 Node 跑，或窗口创建失败）';
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    if (typeof o.onDead === 'function' && o.onDead()) {
      return { ok: false, targets: lastSeen, polls, detail: '子进程在等到窗口之前就已退出：' + (lastErr || '(无附加信息)') };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return {
    ok: false,
    targets: lastSeen,
    polls,
    detail: (lastErr || '调试端口始终没有返回窗口目标') + '（等了 ' + timeoutMs + 'ms / ' + polls + ' 次轮询）',
  };
}

/** 申请一个空闲 TCP 端口（先 listen(0) 拿到再释放，避免硬编码端口撞车）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { listTargets, version, waitPageTarget, isPageTarget, brief, freePort };
