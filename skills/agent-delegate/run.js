/**
 * agent-delegate: 把一段代码工程型子任务整体委派给本机 DeepSeek Harness（dsh）跑。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么做成「一个技能」，而不是往 backend.js 主循环里塞委派分支
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① 完全复用现有的 tool-call 通道：模型自己决定要不要委派，不需要我们写判定逻辑。
 *      「什么时候该委派」本来就是个判断，交给模型比写死阈值可靠。
 *   ② 复用现有的超时 / 取消 / 结果回传路径（runSkill 的 runWithTimeoutAndAbort），
 *      一条也不用另造。
 *   ③ 默认关 = 这个技能不启用，主循环零改动 ⇒ 想 A/B 对比就开关一次，不用回滚代码。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 开关：`DOUYA_DSH_DELEGATE=1`
 * ═══════════════════════════════════════════════════════════════════════════
 *   **默认关**。关着的时候不是"藏着"——`run()` 会明确回一句"未启用 + 怎么启用"，
 *   模型读到就知道自己该接着干，不会以为工具坏了、也不会反复重试。
 *   （「默认关 = 没接线」这条规矩要求：关的时候必须**可见地**关，不能静默。）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 失败方向（写清楚，因为这里有三处不同的失败）
 * ═══════════════════════════════════════════════════════════════════════════
 *   A. 没启用 / 找不到 dsh / 参数不对 ⇒ **返回结构化失败文本**（不抛）。
 *      为什么返回而不抛：模型需要一条**明确的降级路径**——"委派不可用，你自己干"。
 *      抛错会被外层包成"技能失败"，模型只看到一句异常，容易反复重试同一个工具。
 *      这不叫静默降级：文本里原因、边界、下一步都写清了。
 *   B. 用户叫停 / 超时 ⇒ **抛**（交给 runWithTimeoutAndAbort 的原路径）。
 *      这两种情况本来外层就管，我不该把它改成"成功返回"，那会让"没跑完"长得像"跑完了"。
 *   C. dsh 跑完但 stopReason 不是 end_turn（cancelled / max_tokens …）⇒
 *      **如实报 PARTIAL**，不冒充成功。报告里带 stopReason 原文。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 已知缺口（明确记下来，别当成秘密）
 * ═══════════════════════════════════════════════════════════════════════════
 *   本技能让 dsh 直接改磁盘上的文件，那些写入**不经过豆芽的 file-write 技能**
 *   ⇒ backend.js 的进度轴（artHash / codeHash，第 ④ 维 codeNew/codeUpd）
 *   **看不到这些变更**。
 *   后果：如果模型全程只用委派、不自己写文件，STUCK 闸门仍可能判它"原地打转"。
 *   本轮**故意不接**：接它要改 backend.js 的 fingerprint 记录，那是更大的一步，
 *   而本技能默认关着，缺口眼下不成立。等 A 方案跑出对比数据、决定要长期用时再补。
 *   门禁 unit-dsh-delegate 里有一条断言把这个缺口钉住，
 *   免得将来以为它已经接上了（"我们以为它在跑"的错觉）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');

/** 开关：显式 `1` 才算开。任何其它值一律视为关（含 'true'、'yes' —— 与全仓 `=== true` 的严格口径一致）。 */
function isEnabled() {
  return process.env.DOUYA_DSH_DELEGATE === '1';
}

/**
 * 把 dsh 的工具调用流水压成一段人能读的、且**能核对**的变更清单。
 * 只统计有路径的写类调用；同一路径重复写只记最后一次（避免 30 行 "write a.js" 噪音）。
 */
function summarizeChanges(toolCalls) {
  const writes = new Map();
  let others = 0;
  for (const t of toolCalls || []) {
    const title = String(t.title || '');
    const raw = t.rawInput || {};
    const p = raw.file_path || raw.path || raw.filePath || '';
    if (/write|edit|create|patch/i.test(title) && p) {
      writes.set(String(p), { title, status: t.status });
    } else if (t.status === 'failed') {
      others += 1;
    }
  }
  return { writes: Array.from(writes.entries()).map(([p, v]) => ({ path: p, title: v.title })), failedOthers: others };
}

/**
 * 报告正文。**只写有据可查的东西**：dsh 自己说的结论 + 工具调用里能看到的文件清单，
 * 不做任何"它应该还做了 X"的推断。
 */
function buildReport(r, changes) {
  const lines = [];
  const okish = r.stopReason === 'end_turn';
  lines.push(okish ? '【委派完成】' : '【委派未正常结束】stopReason=' + r.stopReason);
  lines.push('');
  lines.push('## 它自己的结论');
  lines.push(String(r.text || '(它没有给出文字结论)').trim());
  lines.push('');
  lines.push('## 它改动过的文件（' + changes.writes.length + ' 个，取自工具调用记录）');
  if (!changes.writes.length) {
    lines.push('(没有任何写文件记录 —— 注意这可能是它把活干在了别的地方，也可能是它只是分析没动手)');
  } else {
    for (const w of changes.writes) lines.push('- ' + w.path + '  (' + w.title + ')');
  }
  if (changes.failedOthers > 0) {
    lines.push('');
    lines.push('⚠ 另有 ' + changes.failedOthers + ' 个工具调用以失败结束（详见下方统计）');
  }
  const kinds = {};
  for (const t of r.toolCalls || []) kinds[t.status || '?'] = (kinds[t.status || '?'] || 0) + 1;
  lines.push('');
  lines.push('## 工具调用统计');
  lines.push(
    '共 ' + (r.toolCalls || []).length + ' 次：' +
      (Object.keys(kinds).length ? Object.entries(kinds).map(([k, v]) => k + '=' + v).join(' / ') : '无'),
  );
  if (!okish) {
    lines.push('');
    lines.push('⚠ 它没有跑到 end_turn（正常收尾）。上面的文件清单是**实际已发生的改动**，');
    lines.push('  但不代表任务完成 —— 请你自己核对验收标准，别把它当成功结果转述给用户。');
  }
  return lines.join('\n');
}

module.exports.run = async function run(params, ctx) {
  // ── A. 失败方向：全部返回文本，不抛 ──
  if (!isEnabled()) {
    return [
      // ★ 2026-11-11 文案改写（门禁 unit-failure-judge-census 抓出来的**真缺陷**）：
      //   原来写的是「委派不可用：…」。FAILURE_RESULT_RE 是**前缀锚定**的：
      //     ① `委派不可用` 里的失败词只有「不可用」，而词表是 失败/错误/超时/不存在/无效/不允许/拒绝
      //        ⇒ 一个都不命中 ⇒ 判**成功**；
      //     ② 就算写成「委派不可用：…失败（」，失败词出现在第 15 个字符之后，
      //        而正则的通用分支只允许前 12 个字符 ⇒ 仍然判成功。
      //   后果是静默且方向最坏：这次调用会被记成"已完成"（doneLog 加 ok、熔断清零、成果卡不计），
      //   模型以为委派成功了、接着往下走，而实际一个字节都没跑。
      //   改成以「委派失败（…）」开头 ——「失败」紧跟「（」，两道判据都吃得下。
      '委派失败（工具不可用，别重试）：本机没有启用 dsh 委派（开关关闭）。',
      '启用方式：设置环境变量 DOUYA_DSH_DELEGATE=1 后重启应用。',
      '现在请你自己按原计划完成任务，不要再尝试调用这个工具。',
    ].join('\n');
  }

  // ★ 叫停检查必须放在**起进程之前**。
  //   放在 prompt 里也能拦（dshClient.prompt 首行就检查 aborted），但那时 session/new
  //   已经把服务器进程拉起来了 ⇒ 用户点了"停止"却还是白起一个进程、白做一次握手。
  //   门禁 unit-dsh-delegate 的 4-3 会盯着这条：stderr 里出现"服务器就绪"就算红。
  if (ctx && ctx.signal && ctx.signal.aborted) {
    const e = new Error('agent-delegate: 调用前就已被叫停，未启动 dsh 进程');
    e.code = 'E_ABORTED';
    throw e;
  }

  const task = String((params && params.task) || '').trim();
  if (!task) return '错误：task 不能为空。请写清楚目标 + 验收标准 + 关键约束（它看不到你和用户的对话）。';

  // 目录：相对工作区解析，且必须落在工作区内（与 file-write 同一条边界）。
  const relCwd = String((params && params.cwd) || '').trim();
  const cwd = path.resolve(WORKSPACE, relCwd || '.');
  const inside = cwd === WORKSPACE || cwd.startsWith(WORKSPACE + path.sep);
  if (!inside) {
    return '错误：cwd 必须落在工作区内（' + WORKSPACE + '），收到 ' + JSON.stringify(relCwd) + '。';
  }
  if (!fs.existsSync(cwd)) {
    // 不替它建 —— 目录名写错时静默建一个空目录，会让 dsh 在一个空目录里白干一轮。
    return '错误：目录不存在：' + cwd + '\n请先确认路径，或用 file-write 建出目录里的第一个文件后再委派。';
  }

  const model = String((params && params.model) || 'deepseek-v4-pro').trim();
  const effort = String((params && params.effort) || 'high').trim();

  let dshClient = null;
  let cli = null;
  try {
    dshClient = require('../../src/main/dshClient');
  } catch (e) {
    // ★ 同上：必须让失败词落在判据吃得到的位置（细节见本文件上方「委派失败（工具不可用…）」那段）
    return '委派失败（工具不可用，别重试）：加载 dshClient 失败（' + e.message + '）。请你自己完成任务。';
  }

  try {
    cli = dshClient.createDshClient({
      cwd,
      // 技能没自己的生活周期，日志只往 stderr 走，不污染 stdout 的协议通道
      logger: {
        info: (m) => console.error('[agent-delegate] ' + m),
        warn: (m) => console.error('[agent-delegate] ' + m),
        error: (m) => console.error('[agent-delegate] ' + m),
      },
    });

    let session = null;
    try {
      session = await cli.newSession({ cwd, model, effort });
    } catch (e) {
      return [
        '委派失败：起不来 dsh 会话（' + e.message + '）。',
        '可能是本机没装 DeepSeek Harness，或 profile acp 没配好。',
        '请你自己完成任务，不要重试这个工具。',
      ].join('\n');
    }

    const r = await cli.prompt(session.sessionId, task, {
      // B. 叫停/超时交给外层：这里把 signal 一路接到 session/cancel，
      //    否则本技能已被判失败，dsh 还在后台写文件（没人管的第二执行者）。
      signal: ctx && ctx.signal,
      // 比技能的 timeoutMs 略短，让这里先收尾、留出 dispose 的时间，
      // 免得外层超时直接把我们掐了、进程留在那里。
      timeoutMs: Math.max(30000, (Number(ctx && ctx.timeoutMs) || 900000) - 15000),
    });

    const changes = summarizeChanges(r.toolCalls);
    console.error(
      '[agent-delegate] 完成 stopReason=' + r.stopReason +
        ' 工具调用=' + (r.toolCalls || []).length +
        ' 写文件=' + changes.writes.length,
    );
    return buildReport(r, changes);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 叫停 / 超时 ⇒ 抛，让外层走它原本的处理（不能伪装成"完成"）
    if (ctx && ctx.signal && ctx.signal.aborted) throw e;
    if (/已被叫停|超时/.test(msg)) throw e;
    // 其它运行时异常 ⇒ 返回文本，给模型一条明确的降级路径
    return '委派中途失败：' + msg + '\n请你自己完成任务，不要重试这个工具。';
  } finally {
    // ★ 任何退出路径都必须收掉服务器进程。
    //   不收就留一个孤儿 Electron 进程在后台，用户看不到、也不会自己退。
    if (cli) {
      try {
        await cli.dispose();
      } catch {
        /* dispose 自己保证不抛，这里是双保险 */
      }
    }
  }
};
