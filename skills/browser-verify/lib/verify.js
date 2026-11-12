'use strict';
/**
 * 验证编排：挑选/拉起浏览器 → 连 CDP → 跑页面检查 → 收尾（**一定**关掉浏览器）。
 *
 * 所有外部能力都通过 `deps` 注入，方便常驻单测在不启动真浏览器的前提下驱动
 * 「浏览器不可用 ⇒ 必须诚实失败」这条红线，以及驱动对照组的成功路径。
 *
 * 本模块**永不向外抛异常**：任何异常都被折成 evidence（verified=false 或
 * navigationFailed），由上层统一变成「错误：…」，从而杜绝"静默降级成成功"。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const browsers = require('./browsers');
const cdp = require('./cdp');

/** 真实依赖（生产路径） */
function defaultDeps() {
  return {
    findBrowser: browsers.findBrowser,
    triedPaths: browsers.triedPaths,
    launchChromium: cdp.launchChromium,
    killBrowser: cdp.killBrowser,
    connectCdp: cdp.connectCdp,
    runPageChecks: cdp.runPageChecks,
    workspace: () => process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace'),
    now: () => Date.now(),
  };
}

/**
 * @param {object} params 已归一化的参数（见 lib/params.js）
 * @param {object} [depsIn] 依赖覆盖（单测用）
 * @returns {Promise<object>} evidence（永不含 verified=false 的"成功"）
 */
async function runVerification(params, depsIn) {
  const deps = Object.assign({}, defaultDeps(), depsIn || {});
  const startedAt = deps.now();
  const base = {
    verified: false,
    engine: null,
    target: { url: params.url, httpStatus: null },
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

  let launched = null;
  let resumeBrowser = null;
  try {
    let engine = null;
    if (params.cdpUrl) {
      // 复用已开的调试端口（例如应用/用户自己带的 Chromium）：零体积、零新进程
      engine = { name: 'cdp:' + params.cdpUrl, path: params.cdpUrl, external: true };
    } else {
      engine = deps.findBrowser();
    }

    if (!engine) {
      // ★ 诚实红线：找不到浏览器内核 ⇒ verified=false，本次**没有做任何页面检查**
      const tried = typeof deps.triedPaths === 'function' ? deps.triedPaths(8) : [];
      return Object.assign({}, base, {
        reason: 'browser_unavailable',
        detail:
          '未找到可用的 Chromium 内核浏览器（Edge / Chrome / Chromium / Brave），本次没有做任何页面检查。' +
          (tried.length ? '已尝试的位置：' + tried.join('；') : '') +
          '。如需在无桌面环境的服务器上验证，请改用「联网搜索」技能抓正文，或先用 cdp_url 参数接入一个已开启远程调试的浏览器。',
        durationMs: deps.now() - startedAt,
      });
    }

    let pageWsUrl = null;
    if (engine.external) {
      const info = await deps.connectCdp(params.cdpUrl, 8000);
      pageWsUrl = info.pageWsUrl;
    } else {
      launched = await deps.launchChromium({ exe: engine.path, timeoutMs: 20000 });
      const info = await deps.connectCdp(launched.wsUrl, 8000);
      pageWsUrl = info.pageWsUrl;
    }
    resumeBrowser = launched;

    // 截图落盘位置：工作区内，便于成果卡/用户直接打开
    const host = safeHost(params.url);
    const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-');
    const shotDir = path.join(deps.workspace(), 'browser-verify');
    const shotPath = path.join(shotDir, stamp + '-' + host + '.png');

    const evidence = await deps.runPageChecks({
      pageWsUrl,
      url: params.url,
      actions: params.actions,
      expectText: params.expectText,
      expectSelector: params.expectSelector,
      timeoutMs: params.timeoutMs,
      settleMs: params.settleMs,
      screenshot: params.screenshot,
      screenshotDir: shotDir,
      screenshotPath: shotPath,
      engine: { name: engine.name, path: engine.path },
    });

    // 补上 base 里可能有、runPageChecks 没填的字段（注入的桩实现可能很简略）
    return Object.assign({}, base, evidence, {
      target: Object.assign({}, base.target, evidence.target || {}),
      durationMs: evidence.durationMs || deps.now() - startedAt,
    });
  } catch (e) {
    return Object.assign({}, base, {
      reason: 'browser_start_failed',
      detail: '浏览器启动/连接失败，本次没有做任何页面检查：' + (e && e.message ? e.message : String(e)),
      durationMs: deps.now() - startedAt,
    });
  } finally {
    // 无论成功失败都必须收尾，绝不留僵尸浏览器进程
    try {
      if (resumeBrowser && deps.killBrowser) deps.killBrowser(resumeBrowser.child, resumeBrowser.profileDir);
    } catch (e) {
      /* ignore */
    }
  }
}

/**
 * 从 url 里取一个能当文件名的 host。
 * @param {string} url
 * @returns {string}
 */
function safeHost(url) {
  let h = 'page';
  try {
    h = new URL(url).hostname || 'page';
  } catch (e) {
    /* 保留默认值 */
  }
  return String(h).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'page';
}

module.exports = { runVerification, defaultDeps, safeHost };
