'use strict';
/**
 * 证据 → 结论。**本文件是"这次到底算不算通过"的唯一裁决点。**
 *
 * 两条诚实红线（也是反向控制 RC 的变异锚点，见 scripts/smoke/unit-browser-verify.mjs）：
 *   ① `verified` 只认 evidence.verified === true —— 浏览器没起来时它必须为 false，
 *      于是 ok 必为 false，绝不会把"没检查成"说成"通过"；
 *   ② `ok` 必须同时满足 verified 且**没有任何 blocker** —— 页面返回 200 也照样可能
 *      白屏 / 控制台报错 / 请求 500，这些都会进 blockers，因此 200 ≠ 通过。
 *
 * 本文件刻意**不引入任何依赖**，可以被单测用 Module._compile 在内存里编译变异。
 */

// 部署后最常见的"噪声"：favicon 缺失几乎不影响可用性。归入 ignoredRequests，不算 blocker。
const FAVICON_RE = /\/favicon\.ico(\?|$)/i;

/**
 * 把证据里所有"真问题"收集成 blockers。
 * @param {object} evidence
 * @returns {Array<{id:string, detail:string}>}
 */
function collectBlockers(evidence) {
  const out = [];
  if (!evidence || typeof evidence !== 'object') {
    return [{ id: 'no_evidence', detail: '没有任何验证证据（内部错误）' }];
  }

  if (evidence.navigationFailed) {
    out.push({ id: 'page_unreachable', detail: String(evidence.navigationFailed) });
  }
  const page = evidence.page;
  // 错误页只在没有别的导航错误说明时单独报一次，避免同一件事出现两条 blocker
  if (!evidence.navigationFailed && page && typeof page.finalUrl === 'string' && /^chrome-error:/i.test(page.finalUrl)) {
    out.push({ id: 'page_unreachable', detail: '浏览器停在错误页（chrome-error）：' + page.finalUrl });
  }
  if (page && page.whiteScreen) {
    out.push({
      id: 'white_screen',
      detail: '页面白屏：没有可见文字、没有可见图片/控件（可见元素 ' + (page.visibleElements == null ? '?' : page.visibleElements) +
        ' 个，body 子节点 ' + page.bodyChildren + ' 个，HTTP ' + (page.httpStatus == null ? '未知' : page.httpStatus) +
        '）。典型原因：前端打包失败、#root 里没渲染出东西、资源路径错。',
    });
  }

  const consoleErrors = evidence.consoleErrors || [];
  if (consoleErrors.length) {
    out.push({ id: 'console_errors', detail: '控制台有 ' + consoleErrors.length + ' 条 error：' + consoleErrors.slice(0, 3).join(' | ') });
  }

  const pageErrors = evidence.pageErrors || [];
  if (pageErrors.length) {
    out.push({ id: 'page_errors', detail: '页面有 ' + pageErrors.length + ' 个未捕获异常：' + pageErrors.slice(0, 2).join(' | ') });
  }

  // Log 域里 source=network 的条目与 failedRequests 重复，这里只把非 network 的当 blocker
  const nonNetLogs = (evidence.logErrors || []).filter((e) => e && e.source && e.source !== 'network');
  for (const e of nonNetLogs.slice(0, 3)) {
    out.push({ id: 'log_error', detail: '[' + e.source + '] ' + e.text + (e.url ? ' @ ' + e.url : '') });
  }

  for (const r of evidence.failedRequests || []) {
    const url = String((r && r.url) || '');
    if (FAVICON_RE.test(url)) continue;
    out.push({ id: 'failed_request', detail: '请求失败 HTTP ' + (r && r.status) + ' ' + url + (r && r.type ? '（' + r.type + '）' : '') });
  }

  for (const r of evidence.requestFailures || []) {
    // canceled 多为页面自身主动取消（abort / 懒加载取消），不算站点缺陷，只如实记录在 evidence 里。
    if (r && r.canceled) continue;
    out.push({ id: 'request_failure', detail: '请求未完成：' + ((r && r.url) || (r && r.requestId) || '') + ' —— ' + ((r && r.errorText) || '') });
  }

  for (const a of evidence.actions || []) {
    // skipped（页面没打开 / 总时长预算用尽）不算「交互失败」——它已经有各自的 blocker 说明原因，
    // 这里再记一次会让同一个原因重复报两遍。
    if (a && a.ok === false && !a.skipped) {
      out.push({ id: 'action_failed', detail: '交互失败 [' + a.type + ' ' + (a.selector || '') + ']：' + (a.detail || '') });
    }
  }

  for (const a of evidence.assertions || []) {
    if (a && a.status === 'FAIL') {
      out.push({ id: 'assertion_failed', detail: '断言失败：' + a.name + (a.detail ? ' —— ' + a.detail : '') });
    }
  }

  // 去重：同一 id + 同一说明只报一次（例如"页面打不开"会同时由导航错误与错误页两条路径命中）
  const seen = new Set();
  const unique = [];
  for (const b of out) {
    const k = b.id + '\u0000' + b.detail;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(b);
  }
  return unique;
}

/**
 * 两条红线的唯一裁决。
 * @param {object} evidence
 * @returns {{verified:boolean, blockers:Array<{id:string,detail:string}>, ok:boolean}}
 */
function decideVerdict(evidence) {
  const verified = !!(evidence && evidence.verified === true);
  const blockers = verified ? collectBlockers(evidence) : [];
  const ok = verified && blockers.length === 0;
  return { verified, blockers, ok };
}

function statusOf(pass) {
  return pass ? 'PASS' : 'FAIL';
}

/**
 * 组装结构化结论。
 * @param {object} evidence
 * @param {{url:string, target?:object}} ctx
 * @returns {object}
 */
function buildReport(evidence, ctx) {
  const e = evidence || {};
  const { verified, blockers, ok } = decideVerdict(e);
  const checks = [];
  const add = (id, name, status, detail) => checks.push({ id, name, status, detail: detail || '' });

  if (!verified) {
    add('browser', '浏览器内核可用', 'FAIL', e.detail || '未找到可用浏览器内核，本次没有做任何页面检查');
  } else {
    const engine = e.engine || {};
    add('browser', '浏览器内核可用', 'PASS', (engine.name || 'chromium') + (engine.path ? ' @ ' + engine.path : ''));
    const page = e.page || null;
    const pageOpened = !e.navigationFailed && !(page && typeof page.finalUrl === 'string' && /^chrome-error:/i.test(page.finalUrl));
    add('page_load', '页面能打开', statusOf(pageOpened),
      e.navigationFailed || ('HTTP ' + (page && page.httpStatus != null ? page.httpStatus : '未知') + ' → ' + (page ? page.finalUrl : (ctx && ctx.url))));
    add('not_white', '页面不是白屏', pageOpened ? statusOf(!(page && page.whiteScreen)) : 'SKIP',
      !pageOpened ? '页面没打开，跳过白屏检查' : (page ? ('可见文字 ' + page.textLength + ' 字，可见元素 ' + (page.visibleElements == null ? '?' : page.visibleElements) + ' 个，标题「' + page.title + '」') : '页面未加载成功'));
    add('console', '控制台无报错', statusOf(!(e.consoleErrors || []).length),
      (e.consoleErrors || []).length ? (e.consoleErrors || []).slice(0, 3).join(' | ') : '无 error');
    add('network', '无失败请求', statusOf(!(e.failedRequests || []).length && !(e.requestFailures || []).filter((r) => r && !r.canceled).length),
      ((e.failedRequests || []).length + ' 个 4xx/5xx，' + (e.requestFailures || []).filter((r) => r && !r.canceled).length + ' 个请求未完成'));
  }

  for (const a of e.actions || []) {
    add('action:' + a.type + ':' + (a.selector || ''), '交互 ' + a.type + ' ' + (a.selector || ''),
      a.skipped ? 'SKIP' : statusOf(a.ok === true), a.detail || '');
  }
  for (const a of e.assertions || []) {
    add('assert:' + a.name, a.name, a.status, a.detail || '');
  }

  const page = e.page || null;
  const report = {
    ok,
    verified,
    reason: verified ? (ok ? 'verified_ok' : 'problems_found') : (e.reason || 'not_checked'),
    target: Object.assign({ url: (ctx && ctx.url) || (e.target && e.target.url) || '', httpStatus: page ? page.httpStatus : null }, ctx && ctx.target ? { host: ctx.target.host, port: ctx.target.port } : {}),
    engine: e.engine || null,
    durationMs: e.durationMs || 0,
    checksRun: e.checksRun || 0,
    checks,
    blockers,
    page: page
      ? { finalUrl: page.finalUrl, title: page.title, httpStatus: page.httpStatus, textLength: page.textLength, bodyChildren: page.bodyChildren, whiteScreen: page.whiteScreen }
      : null,
    evidence: {
      consoleErrors: e.consoleErrors || [],
      pageErrors: e.pageErrors || [],
      logErrors: e.logErrors || [],
      failedRequests: e.failedRequests || [],
      ignoredRequests: e.ignoredRequests || [],
      requestFailures: e.requestFailures || [],
      actions: e.actions || [],
      assertions: e.assertions || [],
    },
    screenshot: e.screenshot || null,
    error: verified ? '' : (e.detail || '本次没有做任何页面检查'),
  };
  report.summary = formatSummary(report);
  return report;
}

/**
 * 人类可读摘要（放进 report.summary，便于模型/用户直读）。
 * @param {object} report
 * @returns {string}
 */
function formatSummary(report) {
  const lines = [];
  const head = report.verified ? (report.ok ? '浏览器验证：通过' : '浏览器验证：发现问题') : '浏览器验证：未完成';
  lines.push(head + ' —— ' + report.target.url);
  if (!report.verified) {
    lines.push('本次**没有做成任何页面检查**：' + report.error);
    return lines.join('\n');
  }
  lines.push('实际检查 ' + report.checksRun + ' 项，其中失败 ' + report.blockers.length + ' 项。');
  for (const c of report.checks) {
    const mark = c.status === 'PASS' ? '✅' : (c.status === 'SKIP' ? '⏭️' : '❌');
    lines.push(mark + ' ' + c.name + (c.detail ? '：' + c.detail : ''));
  }
  if (report.blockers.length) {
    lines.push('需要修的问题：');
    for (const b of report.blockers) lines.push('  · [' + b.id + '] ' + b.detail);
  }
  if (report.screenshot) lines.push('截图：' + report.screenshot);
  return lines.join('\n');
}

/**
 * 硬失败（参数非法 / 浏览器起不来 / 执行崩溃）的结论骨架。
 * @param {{url:string, reason:string, detail:string}} o
 * @returns {object}
 */
function hardFailReport(o) {
  const report = {
    ok: false,
    verified: false,
    reason: o.reason,
    target: { url: o.url, httpStatus: null },
    engine: null,
    durationMs: 0,
    checksRun: 0,
    checks: [{ id: 'browser', name: '浏览器内核可用', status: 'FAIL', detail: o.detail }],
    blockers: [{ id: o.reason, detail: o.detail }],
    page: null,
    evidence: { consoleErrors: [], pageErrors: [], logErrors: [], failedRequests: [], ignoredRequests: [], requestFailures: [], actions: [], assertions: [] },
    screenshot: null,
    error: o.detail,
  };
  report.summary = formatSummary(report);
  return report;
}

module.exports = { collectBlockers, decideVerdict, buildReport, formatSummary, hardFailReport, FAVICON_RE };
