/**
 * agentReview.js —— 2026-10-18 第十六轮：Agent「双 AI 自检 + 复检 + 对话汇报」。
 *
 * 老板原话（第 6 条）：
 *   豆芽对话的 agent 功能我要加一个：他做开发，每次做完的时候先停一停，让 AI 看一遍
 *   他做得怎么样、是否和用户提出的一致；检查一遍，如果没做完 AI 要求他继续做完；
 *   做完后再让一个 AI 检查一下是否达到用户想要的目标，并且以对话的形式告诉用户
 *   完成了个什么样子的东西、剩下可以做什么、后续要不要继续完成到一个更加完善的地步、
 *   或者告诉用户这个有什么缺陷应该怎么改、要不要我帮你改掉。
 *
 * 落地方式（与现有链路的接法）：
 *   · 只有「工作」分区（payload.scope === 'work'）且任务真的动过手（didToolCall）才跑；
 *     普通对话（scope === 'chat'）一字不变 —— 聊天不该被审查流程拖慢。
 *   · selfCheckTask = 第一次 AI 审查：拿【用户原始目标 + 已完成步骤 + 产物清单 + 最终正文】，
 *     逐条比对「做没做完」。没做完 ⇒ 返回 missing 清单，由调用方回灌给 agent 继续干
 *     （最多 AGENT_REVIEW_MAX_ROUNDS 轮，防无限循环）。
 *   · auditTask = 第二次 AI 审查（独立 system prompt，复检员角色）：评估「是否达成用户目标」，
 *     给出总结 / 剩余可做 / 缺陷 / 建议。两次调用是**不同的 AI 视角**，不是同一提示问两遍。
 *   · buildAuditReport = 把复检结果写成「对话形式」的汇报（口语、给选择、不堆术语）。
 *
 * 所有 LLM 调用都是**非流式**的一次性补全（审查不需要边想边看），失败一律容错：
 * 自检/复检任何一步出错，都返回 null 让调用方按「没有审查」继续收尾 ——
 * 审查是增益不是门禁，绝不允许它把本来能正常结束的任务搞挂。
 *
 * ⚠️ 为什么不复用 backend.js 的 fetchChatCompletionsWithRetry：backend.js 被
 * unit-onboarding-v2 的 M2 冻结补丁按 md5 锁着（本轮改它 = 补丁漂移 = 单测红），
 * 且它不导出该函数。故这里内联一份同策略的精简实现（503/502/504/429/408 重试 2 次）。
 */

/** 与 backend.js 同策略的精简重试（内联副本；改策略时两边同步）。 */
const REVIEW_RETRY_DELAYS_MS = [800, 1600];

// ★ 2026-11-11：【必须显式 require，别以为 node --check 过了就没问题】
//   buildClaimHint 要用 fs 读产物正文、path 取文件名，而本文件此前**一个都没引入**。
//   `node --check` 只做语法检查，不会因为"用了未定义的变量"报错 ——
//   那种错只有在真跑审查链路时才会炸成 ReferenceError，
//   而 agentReview 的纪律是"审查失败一律容错返回 null"
//   ⇒ 后果会是**审查静默失效**、没有任何人发现。所以这两行不是可选的。
const fs = require('node:fs');
const path = require('node:path');
const REVIEW_RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const REVIEW_ATTEMPT_TIMEOUT_MS = 45000;

/**
 * 产物结构指纹（2026-10-21）：让审查员看得见「文件里到底有什么」。
 * 只给**程序读到的事实**（字节数 / 页数 / 图片张数 / 写死的宽高 / 是否 overflow:hidden），
 * 不给判断 —— 结论必须由审查员自己下，不许写死在代码里。
 * 一份真源在 src/shared/artifactEvidence.js（探针也用它，避免两边页数判据漂移）。
 */
const { buildEvidenceBlock: evidenceBlock } = require('../shared/artifactEvidence');

/**
 * 「4 号验收 Agent」结构化核对清单（2026-11-03）。
 * 真源：acceptanceChecklist.js（清单 + 判定公式 + 报告模板，纯函数）
 *       acceptanceReadings.js（机械读数，读盘）
 * 本文件只做**接线**：把复检员的判断结论 + 机械读数喂给判定公式，拿到四态结论。
 * ⚠️ 为什么不把判定逻辑写在这里：四态公式必须能被门禁直接喂输入看输出（纯函数），
 *    而本文件里的两个审查员都是 LLM 调用，夹在一起就没法单独验判定本身。
 */
const acceptanceChecklist = require('./acceptanceChecklist');
const acceptanceReadings = require('./acceptanceReadings');
// ★ 2026-11-11：审查链要能看见「产物正文里有几处断言找不到来源」（0.21.31 事故连问 4 轮的根因）。
//   复用事实门的**同一套判据**，不另写一份 —— 否则会出现"门禁判它有问题、审查员判它没问题"。
const contentClaimGuard = require('./contentClaimGuard');

async function fetchWithRetry(upstreamURL, bodyObj, apiKey) {
  let lastError = 'upstream request failed';
  for (let attempt = 0; attempt <= REVIEW_RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVIEW_ATTEMPT_TIMEOUT_MS);
    try {
      const resp = await fetch(upstreamURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
        },
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      });
      if (resp.ok) return { ok: true, resp };
      if (resp.status < 500 && !REVIEW_RETRYABLE_STATUS.has(resp.status)) {
        return { ok: true, resp };
      }
      lastError = 'LLM HTTP ' + resp.status;
    } catch (e) {
      lastError = 'upstream request failed: ' + (e && e.message ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (attempt < REVIEW_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, REVIEW_RETRY_DELAYS_MS[attempt]));
    }
  }
  return { ok: false, error: lastError + '（已自动重试 ' + REVIEW_RETRY_DELAYS_MS.length + ' 次）' };
}

/** 自检未通过时最多回灌续跑几轮（防「差一点」被无限续下去）。
 *  2026-10-19 第十七轮：2 → 4。老板原话「确保可以做到不中断」——真实开发任务里，
 *  自查常常要 3 轮才暴露最后的缺口（第 1 轮发现主功能缺、补完第 2 轮发现验证缺、
 *  补完第 3 轮才发现文档缺）。2 轮封顶会把「差一点」的任务当场判死，交给用户一副烂尾。
 *  4 轮的兜底不是它自己：续跑每轮都走主循环（turn+1、耗 token），
 *  MAX_TURNS(24) 与 token 预算才是无限续的真防线；这里只是别让审查成为提前掐断任务的那一刀。 */
const AGENT_REVIEW_MAX_ROUNDS = 4;

// ===================== 一·二、这道验收闸「什么时候该跑」 =====================
/**
 * 该不该启动「自检员 + 复检员」。
 *
 * 【为什么需要这个函数】
 * 2026-10-21 老板贴出一整段实测对话：豆芽做 PPT，反复说「我现在就做」「等我」，
 * 最后交出一份「（还没有可交付的部分）」的空壳报告，还让老板自己去检查。
 * 查下来**没人拦它** —— 而拦它的机制（本文件这两个 AI）在正常路径上**一次都没跑过**：
 *
 *   backend 原来的条件是 `payload.scope === 'work' && didToolCall`。
 *   而 0.21.11（第十九轮）把聊天区「对话 / 工作」分区开关从界面上拿掉了，
 *   `App.jsx:1878 switchChatScope()` 全仓零调用点 ⇒ chatScope 恒为 'chat' ⇒
 *   请求体 scope 恒为 'chat' ⇒ 第一个条件**永远为假**。
 *
 *   叠加第二个条件更致命：工具被意图闸门拦下时 `didToolCall` 仍是 false。
 *   于是「老板提需求 → 追问 → 被拦 → 说做完了」这条链上，两个条件同时不满足。
 *   ⇒ 这是「代码在、入口没了」，比没写更坏：它让人以为有验收。
 *
 * 【新判据】任一成立就跑。每条都对应一个「必须有人看一眼」的真实现场：
 *   ① productiveCount > 0        —— 真的产出过东西（改文件 / 跑产出技能 / 部署）
 *   ② deliverableCount > 0       —— 声称有产物：产物必须核，不能只说有
 *   ③ 被拦 且 用户要产出物       —— ★ 本次事故现场：想动手被拦、却仍然宣称做完
 *   ④ 被拦 ≥2 次                 —— 反复被拦是异常态，至少要第二双眼睛看一眼
 *   ⑤ 只动了只读工具 但用户要产出物 —— ★ 「光看没做」：老板说"做 15 页 PPT"，
 *        模型只 file-read 了几份素材就交差。这同样是空壳报告，只是换了个入口。
 *
 * 【为什么①不直接用 didToolCall（这是第二版修正，第一版踩过）】
 *   didToolCall 对**只读工具**也置位（file-read / web-fetch / 搜索）。拿它当判据 ⇒
 *   用户随口问「这个文件里写了什么」也会多跑 2 次 LLM 调用（自查+复检），
 *   真实体感是"每句话都变慢了"。实测代价：unit-failure-chain-e2e 的 A 段只调一个会失败的
 *   demo 技能，改动后收尾突然多出 2 次请求 —— 那正是被误触发的审查。
 *   ⇒ productiveCount 只统计**不在 READONLY_SKILLS / META_TOOL_NAMES 里**的工具。
 *      只读与元工具（问用户、选文件）不算"动过手"，这一类由 ⑤ 单独兜。
 *
 * @param {{scope?:string, didToolCall?:boolean, productiveCount?:number,
 *          deliverableCount?:number, intentBlocks?:number,
 *          userWantsArtifact?:boolean}} o
 * @returns {string} 命中的理由（空串 = 不跑）。返回理由而不是布尔，是为了日志里能一眼看出为什么跑。
 */
function shouldReviewTask(o) {
  const c = o || {};
  if (c.scope === 'work') return 'work-scope';
  const productive = Number(c.productiveCount) || 0;
  if (productive > 0) return 'productive-call';
  if (Number(c.deliverableCount) > 0) return 'has-deliverables';
  const blocks = Number(c.intentBlocks) || 0;
  if (blocks > 0 && c.userWantsArtifact === true) return 'blocked-but-claimed';
  if (blocks >= 2) return 'blocked-repeatedly';
  // ⑤「光看没做」：动过手（含只读），但一次生产性动作都没有，而用户要的是产出物
  if (c.didToolCall === true && productive === 0 && c.userWantsArtifact === true) {
    return 'readonly-for-artifact';
  }
  return '';
}

// ===================== 一·三、三态如实说明（老板第 4 关） =====================
/**
 * 「我打算做 / 我执行了 / 我验证通过」是三个不同状态，不许混成一句「做好了」。
 *
 * 老板原话：「真正的 Agent 必须有独立的验收机制，能区分『我打算做』『我执行了』
 * 『我验证通过』这三个不同状态。」
 *
 * 【为什么必须有它】现在代码里只有 `didToolCall` 一个布尔 —— 它只能表达「执行过/没执行」，
 * 表达不了「想执行但被拦」和「执行了但没验」。于是模型被拦的那一轮，
 * 收尾报告照模板吐「（还没有可交付的部分）」，没有人把它翻译成一句人话：
 * 到底是我没做、还是我做了没验。用户看到的只是"又不干活"。
 *
 * 【只在有落差时说话】三个状态一致（想 → 做 → 验 全齐，或压根没想动手的纯问答）
 * 时返回空串，一个字都不多说 —— 不许把正常收尾也拖成一份"验证报告"。
 *
 * @param {{attempted?:number, executed?:number, verified?:number,
 *          blockedByGate?:boolean, expectArtifact?:boolean, needFromUser?:string}} o
 * @returns {string} 给用户看的说明（空串 = 三态一致，不必说）
 */
function buildTraceReport(o) {
  const c = o || {};
  const attempted = Number(c.attempted) || 0;   // 打算做：发起过的动作（含被拦下的）
  const executed = Number(c.executed) || 0;     // 执行了：真正跑完的动作
  const verified = Number(c.verified) || 0;     // 验证通过：拿到读数、产物核过的项
  const lines = [];

  // 落差一（最严重）：想动手，一次都没真正执行 —— 「光说不做」的现场
  if (attempted > 0 && executed === 0) {
    lines.push('【三态如实说明】打算做：' + attempted + ' 次；真正执行：0 次；验证通过：0 项。');
    lines.push('所以上面任何「做好了 / 已经生成」都不成立 —— 实际状态是**我根本没动手**，不是做了但失败。');
    if (c.blockedByGate) {
      lines.push('原因在这次是权限：你这一句在系统里被判成「问问题 / 要方案」，执行类工具被拦了下来。');
      lines.push('这不是你的错，是我这边把「追问」和「新问题」判错了 —— 我记下了。');
    }
    if (c.needFromUser) lines.push('要继续，我只需要你一句：' + c.needFromUser);
    return lines.join('\n');
  }

  // 落差二：执行了，但没有验证读数 —— 「做了」不等于「做对了」
  if (executed > 0 && verified === 0 && c.expectArtifact === true) {
    lines.push('【三态如实说明】打算做：' + attempted + ' 次；真正执行：' + executed + ' 次；验证通过：0 项。');
    lines.push('东西确实动手做了，但**还没拿到验证读数**，所以只能说「做了」，不能说「做对了」。');
    lines.push('要我接着验一遍再说结论吗？');
    return lines.join('\n');
  }

  return '';
}


/** 从模型输出里抠出 JSON 对象：容忍 ```json 围栏、前后废话、尾逗号。 */
function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    // 尾逗号 / 单引号等轻微畸形：再做一次宽松尝试
    try {
      return JSON.parse(body.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/**
 * 非流式一次性补全（审查专用）。返回文本；失败返回 null（调用方容错）。
 */
async function reviewChat({ baseURL, apiKey, model, system, user, temperature = 0.2, diag }) {
  // ★★ 2026-10-23：把「在哪一步失败」带出来。修前这里对三种失败**一律 return null**：
  //   ① 传输层失败（fetchWithRetry 重试后仍失败，带 error 文案）
  //   ② 响应体不是 JSON
  //   ③ 回了但正文为空
  //   于是"上游 502"与"模型回了空"在调用方看来完全同形 —— 正是老板第 2 条要分开的那件事。
  //   只写 diag、不改返回值，既有调用方与门禁行为不变；也不记提示词与密钥。
  const noteR = (o) => { if (diag && typeof diag === 'object') Object.assign(diag, o); };
  const upstreamURL = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const r = await fetchWithRetry(upstreamURL, {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    stream: false,
    temperature,
    max_tokens: 1200,
  }, apiKey);
  if (!r.ok) {
    noteR({ failStage: 'transport', transportError: String(r.error || '').slice(0, 140) });
    return null;
  }
  let data;
  try {
    data = await r.resp.json();
  } catch {
    noteR({ failStage: 'bad-body', httpStatus: (r.resp && r.resp.status) || 0 });
    return null;
  }
  const txt = data && data.choices && data.choices[0] && data.choices[0].message
    ? (data.choices[0].message.content || '')
    : '';
  const trimmed = String(txt).trim();
  if (!trimmed) { noteR({ failStage: 'empty-content', httpStatus: (r.resp && r.resp.status) || 0 }); return null; }
  noteR({ failStage: 'ok', httpStatus: (r.resp && r.resp.status) || 200 });
  return trimmed;
}

/** 把已完成步骤 + 产物清单压成一段人话，供两个审查员读。 */
function summarizeWork(doneLog, deliverables, finalText) {
  const steps = (doneLog || [])
    .filter((s) => s && s.ok)
    .map((s) => `· ${s.skill || '步骤'}：${String(s.brief || s.detail || '').slice(0, 120)}`)
    .slice(-12)
    .join('\n');
  const arts = (deliverables || []).map((d) => `· ${d.path || d.name || ''}`).join('\n');
  // ★★ 2026-10-21 补「产物结构指纹」（老板第 5 关）。
  //   原来这里只有路径，审查员物理上看不见文件里有什么 —— 实测（review-sees-layout.mjs）：
  //   一个「用户要 15 页、文件只有 3 页、图片宽高被写成 400×120」的现场，
  //   自查员判 finished=false，但 missing 里写的是「核实 deck.html 里是否真有 15 页」——
  //   它**不是看出了不符**，而是**看不见，只能说无法核实**。这两者的区别决定了一切：
  //   前者能把缺陷说出来，后者会把一个真正合格的产物也判成"没做完"。
  //   证据由 shared/artifactEvidence 统一提供（只给事实：字节/页数/图张数/写死的宽高/overflow），
  //   判断仍留给审查员，不在代码里写死结论。
  const evidence = evidenceBlock(deliverables);
  // ★★ 2026-11-11【把「正文里有没有无依据断言」直接摆给审查员看】
  //   为什么放在这里而不是 artifactEvidence 里：那个文件的纪律是「只给事实、不下判断」，
  //   而"这句断言找不到来源"是**判断**。审查链（本文件）本来就该承担判断输入的准备。
  //   为什么必须给：0.21.31 那次文件的第 5 行写着「11 条暗号已全部核对归属」，
  //   而用户只确认了 2 条。审查员当时看不见正文 ⇒ 连问 4 轮 ⇒ 最后 audit 返回空。
  //   现在它至少能看见"这份正文里有 1 处断言没有来源"，能直接判，而不是干问。
  const claimHint = buildClaimHint(deliverables);
  const text = String(finalText || '').slice(0, 1500);
  return [
    steps ? '【已完成的步骤】\n' + steps : '【已完成的步骤】（无记录）',
    arts ? '\n【已产出的文件】\n' + art(arts) : '',
    evidence ? '\n【产物的实际内容（程序读取，不是助手自述）】\n' + evidence : '',
    claimHint ? '\n【正文断言核查（程序扫描，不是助手自述）】\n' + claimHint : '',
    text ? '\n【最终回复正文（节选）】\n' + text : '',
  ].join('\n');
}
function art(s) { return s; }

/**
 * 扫一遍文稿类产物，把「有断言但找不到来源」的处数报给审查员。
 *
 * ★ 这里只**报告事实**（几处、第几行、哪句话），不写"所以这份不合格"——
 *   判断留给审查员，与本仓 artifactEvidence 的纪律一致。
 * ★ 单份文件最多列 2 处：审查员的 prompt 有预算，20 处全列会把别的证据挤掉。
 *
 * @param {Array<{path?:string,name?:string}>} deliverables
 * @returns {string} 多行文本；没有命中返回 ''
 */
function buildClaimHint(deliverables) {
  const list = Array.isArray(deliverables) ? deliverables : [];
  const lines = [];
  for (const d of list) {
    const p = (d && (d.path || d.name)) || '';
    if (!p || !/\.(?:md|markdown|txt|csv|tsv)$/i.test(p)) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8').slice(0, 256 * 1024); } catch { continue; }
    let scan;
    try { scan = contentClaimGuard.scanClaims(text); } catch { continue; }
    if (!scan.unsupported.length) continue;
    const name = (() => { try { return path.basename(p); } catch { return p; } })();
    lines.push('- ' + name + '：**' + scan.unsupported.length + ' 处**断言找不到来源');
    for (const u of scan.unsupported.slice(0, 2)) {
      lines.push('  · 第 ' + u.line + ' 行「' + u.text.slice(0, 60) + '」（关键词：' + u.claim + '）');
    }
    if (scan.unsupported.length > 2) lines.push('  · …另有 ' + (scan.unsupported.length - 2) + ' 处');
  }
  return lines.join('\n');
}

// ===================== 一·四、验收核对清单（4 号验收 Agent） =====================
/**
 * 把清单渲染成复检员可以照着答的一段提示。
 *
 * 【为什么把 14 条全给，而不是先过滤】
 *   过滤需要先知道「任务类型」和「目标等级」，而这两件事正是清单的前置核验项 ——
 *   由复检员读了目标与产物之后判定。先过滤等于让它先答题再出题。
 *   所以：**全给，并要求它对不适用项显式标 applies=false**。
 *   过滤在代码侧做（evaluateAcceptance → itemApplies），那儿是纯函数、可被门禁验。
 *   这样"该不该跳过"这件事掌握在代码手里，不在模型心情里。
 */
function buildChecklistPrompt() {
  const lines = [];
  lines.push('');
  lines.push('【必须逐条核验的清单】每条都要给结论；不适用的也要显式写 applies=false 并说明原因，');
  lines.push('不许整条漏掉（漏掉会被记为"未核验"，不算通过）。');
  for (const it of acceptanceChecklist.CHECKLIST) {
    const scopeTag = it.scope === 'creative' ? '仅创作类' : (it.scope === 'dev' ? '仅开发类' : '所有任务');
    lines.push('- [' + it.id + '] ' + it.label + '（' + scopeTag + '）：' + it.guide);
  }
  lines.push('判定硬红线（命中任意一条即为硬失败，不许往下折算成"待优化"）：');
  lines.push('  · G1-4 写 reason=nothing-at-all：三层目标全空，连文档/SOP 都产不出；');
  lines.push('  · G2-1 / G2-2 写 reason=refused-design：创作类明确拒绝做设计推演；');
  lines.push('  · G2-3 写 reason=fake-shell：造假壳子（样式完整、核心功能失效）；');
  lines.push('  · G4-1 写 reason=core-broken：核心功能失效 / 存在逻辑 bug。');
  lines.push('除这四条之外的不合格**一律只是"待优化"**，不许自行升级成失败。');
  return lines.join('\n');
}

/**
 * 把机械读数渲染成给复检员看的证据块。
 *
 * 【为什么这些读数必须显式给它看】G3 那一组（TS 规范 / 代码结构 / E2E / 边界说明）
 * 是**程序读盘读出来的**，比模型"看起来像"可靠得多。不给它看，它就会凭印象答；
 * 给了它看，它至少没法假装"我核过了"。代码侧仍以读数为准（mech 覆盖 judge）。
 */
function buildReadingsBlock(readings) {
  const r = readings || {};
  const mech = r.mech || {};
  const extra = r.extra || {};
  const lines = [];
  lines.push('');
  lines.push('【程序读盘得到的机械读数（不是助手自述，可直接当证据用）】');
  lines.push('项目根：' + (extra.projectRoot || '（未定位）'));
  for (const id of ['G3-1', 'G3-2', 'G3-3', 'G3-4']) {
    const m = mech[id];
    if (!m) continue;
    const state = m.result === 'skip' ? '不适用' : (m.pass ? '通过' : '不合格');
    lines.push('· ' + id + ' ' + state + '：' + String(m.evidence || ''));
  }
  const dc = extra.designCoverage;
  if (dc) {
    const kindLabel = { game: '游戏', web: '网页', ppt: 'PPT', visual: '可视化' }[dc.kind] || dc.kind;
    if (!dc.docExists) {
      lines.push('· 设计推演：**一份设计文档都没有**（创作类任务交付了文件却没有任何 .md/.txt 设计推演）'
        + ' ⇒ G2-1 已由程序判为不合格。最小可运行版本只是验证底座，不等于交付成果。');
    } else {
      // 把命中词一起给出去：关键词是子串匹配，会串味（实测游戏文档里写「状态分支：加载」
      // 曾被算成覆盖了网页的「加载状态」）。带上命中词，模型才能看出哪些只是撞词。
      const fmtCov = (cov) => {
        const c = ((cov && cov.covered) || []);
        const hits = (cov && cov.hits) || {};
        return c.map((n) => n + (hits[n] && hits[n] !== n ? '←' + hits[n] : '')).join('/');
      };
      lines.push('· 设计推演（' + kindLabel + '，读的是 ' + dc.path + '）'
        + '通用 8 项 已覆盖 [' + fmtCov(dc.base) + ']'
        + ' 缺 [' + ((dc.base && dc.base.missing) || []).join('/') + ']'
        + (dc.hasSpecific
          ? '；' + kindLabel + '专属 已覆盖 [' + fmtCov(dc.specific) + ']'
            + ' 缺 [' + ((dc.specific && dc.specific.missing) || []).join('/') + ']'
          : '；' + (dc.note || '该子类型无专属维度')));
      // ★ 说清证据强度，防止模型把关键词命中当"已核对"用
      lines.push('  （注：上面按关键词命中的是**弱证据** —— 「加载状态←加载」这种只是撞词，'
        + '不等于真设计了加载态。G2-1/G2-2 仍需你自己看文档判：覆盖到的项要能说出具体怎么做的，'
        + '没覆盖的项要判它缺失。）');
    }
  }
  if (Array.isArray(extra.shellSignals) && extra.shellSignals.length) {
    lines.push('· 空壳信号（只是提示，需人工确认，不能凭它定罪）：' + extra.shellSignals.join('；'));
  }
  // ★ 2026-11-03：方案探索读数。老板原话「至少形成几个有实质区别的方案，
  //   而不是换颜色、换标题冒充多个方案」。这里必须把读数**说出来**，
  //   否则模型只知道"设计维度覆盖了"，不知道"自己只做了一版"。
  const dopt = extra.designOptions;
  if (dopt && typeof dopt === 'object') {
    const n = Number(dopt.count) || 0;
    if (n === 0) {
      lines.push('· 方案探索：文档里**没有找到并列的方案结构**（没识别到「方案A/方案B」这类小标题）。'
        + '如果确实只做了一版，G2-4 判不合格；如果用了别的词（如路线A/路线B），请自己按内容判。');
    } else {
      lines.push('· 方案探索：识别到 ' + n + ' 个方案 [' + (dopt.labels || []).join(' / ') + ']'
        + (n < 2 ? ' ⇒ **不足 2 个，G2-4 已由程序判为不合格**（换颜色/换标题不算第二个方案）' : ''));
      if (n >= 2) {
        lines.push('  比较：' + (dopt.compare ? ('有（' + dopt.compareWhy + '）') : ('**没找到**（' + dopt.compareWhy + '）'
          + ' —— 请自己判：文档里到底有没有把这几个方案在功能/审美/可用性/创新性/成本上比过？')));
        lines.push('  选定：' + (dopt.chosen ? ('选了方案 ' + dopt.chosen + '（' + dopt.chosenWhy + '）')
          : '**没写明选哪个** —— 请自己判：有没有说清"为什么选这个、不选那个"？'));
        if (Array.isArray(dopt.shapePairs) && dopt.shapePairs.length) {
          // ★★ 这条是**判死了的读数**，不是提示：骨架完全一样就是同一版换皮。
          const p = dopt.shapePairs[0];
          lines.push('  ✘ 换皮：方案' + p.a + ' 与 方案' + p.b + ' 的版面骨架**完全相同**（' + p.shape + '）'
            + ' ⇒ 这不是两个结构不同的方案，G2-4 已由程序判为不合格。'
            + '（说明：字符相似度对这种情况是失效的——两段文字几乎不重合，但结构一样。）');
        }
        if (Array.isArray(dopt.shapes) && dopt.shapes.length) {
          lines.push('  各方案骨架：' + dopt.shapes.map((s) => s.id + '=' + (s.shape || '（没写结构）')).join('；'));
        }
        if (Array.isArray(dopt.similarPairs) && dopt.similarPairs.length) {
          lines.push('  ⚠️ 疑似换皮：' + dopt.similarPairs.map((p) => '方案' + p.a + ' 与 方案' + p.b
            + ' 文本相似度 ' + p.sim).join('；')
            + ' —— 这是**提示不是结论**（中文段落天然重合），请自己看两份方案在结构上是否真的不同。');
        }
      }
    }
  }
  lines.push('规则：G3 四条以上面的读数为准；读数说不合格就是不合格，不许写成通过。');
  return lines.join('\n');
}

/**
 * 把「意图」渲染进两位审查员提示词的**唯一入口**。
 *
 * 为什么要包一层（2026-11-06）：意图从 backend 传进来时可能是**两段**——
 * 项目账里的「最初原话」+ 本轮的「【本轮要求】」（见 intentGate.resolveTaskGoal）。
 * 不点明的话，审查员很可能把「【本轮要求】」当成用户又开了个新项目，于是:
 *   · 自检员：把最初目标里已经做完的部分重新列进 missing（明明做完了判没做完）；
 *   · 复检员：只按最后那句「把第 3 页改成蓝色」判，最初那 12 页的硬要求直接不看。
 * 两段都是用户说的，效力同等，必须一起核。
 *
 * 空目标仍然给 `（未记录）`：那是既有契约（fail-open 到"照现在的证据判"），
 * 不许在这里改成"缺目标就判失败"—— 那是另一个决定，得单独论证。
 */
function goalBlock(goal) {
  const t = String(goal || '').trim();
  if (!t) return '（未记录）';
  return t.indexOf('【本轮要求】') >= 0
    ? t + '\n（上面「【本轮要求】」是用户本次追加的指令，与最初目标**同等有效**：两段都要逐条核。）'
    : t;
}

/**
 * 第一次审查（自检）：对照用户目标，判断 agent 是否真的做完了。
 * @returns {Promise<{finished:boolean, missing:string[], brief:string}|null>} 失败返回 null
 */
async function selfCheckTask({ cfg, baseURL, apiKey, model, goal, doneLog, deliverables, finalText, runtimeSummary = '' }) {
  const system = '你是「豆芽自查员」。你的唯一职责：拿用户的目标对照 AI 助手实际做完的工作，'
    + '判断「做没做完」。只认事实（完成的步骤、产出的文件），不认助手的自我宣称。'
    + '判定规则（按优先级）：'
    + '① 助手在正文里宣称「已完成/已修复」但没有对应文件或步骤证据 ⇒ 判未完成，把缺证据的部分列进 missing；'
    + '② 用户目标可以拆成多条（如「做 X 并测一下」= 两条），任一条没有事实支撑 ⇒ 判未完成；'
    + '③ 有文件、有步骤、且覆盖目标每一条 ⇒ 才判完成。'
    // ★★ 2026-10-21 新增：以前这里只有「产物清单」，审查员看不见文件内容，
    //   于是只能说「无法核实」—— 实测会把真正合格的产物也判成未完成。
    //   现在多了一段【产物的实际内容（程序读取，不是助手自述）】，规则必须跟上，
    //   否则模型会继续沿用「无法核实」的旧习惯，白给了证据也不用。
    + '【重要：有一段「产物的实际内容」是程序直接读文件读出来的事实（字节数、页数、图片张数、'
    + '图片写死的宽高、是否有 overflow:hidden），它比助手的自述可信得多。判断时必须用它去核对：'
    + '   · 用户/助手说了数量（如「15 页」「每页一张图」）⇒ **拿证据里的实际数字对一遍**，'
    + '     对不上就把差额明确写进 missing（例：「实际只有 3 页，与要求的 15 页差 12 页」）；'
    + '   · 证据里已给出事实时**不许**再说「无法核实」「无法确认」——那是把已给的事实当没有，属于你的失职；'
    + '   · 证据显示「文件不存在」⇒ 直接判未完成，不要猜；'
    + '   · 只有证据里确实没覆盖的维度（如网页渲染后的视觉观感、字体是否溢出）才可以说「未验证」。'
    + 'missing 一条一句、写具体动作（如「补跑一次构建确认没报错」），不要写「继续完善」这种空话。'
    + '严格只输出 JSON，不要任何别的文字。格式：'
    + '{"finished": true 或 false, "missing": ["还没做的事，一条一句，没有就空数组"], "brief": "一两句总结它实际做到了什么"}';
  const user = '【用户最初的目标】\n' + goalBlock(goal)
    + '\n\n【AI 助手实际做的工作】\n' + summarizeWork(doneLog, deliverables, finalText)
    + (runtimeSummary ? '\n\n【运行验收客观记录（真实工具结果，不是助手自述）】\n' + String(runtimeSummary).slice(0, 5000)
      + '\n运行记录为 fail/unverified 时不得判 finished=true；pass 也不能替代未覆盖的目标检查。' : '')
    + '\n\n请对照目标逐条检查，输出 JSON。';
  const txt = await reviewChat({ baseURL, apiKey, model, system, user, temperature: 0.1 });
  if (!txt) return null;
  const j = extractJson(txt);
  if (!j || typeof j.finished !== 'boolean') return null;
  return {
    finished: j.finished === true,
    missing: Array.isArray(j.missing) ? j.missing.map((x) => String(x)).filter(Boolean).slice(0, 6) : [],
    brief: String(j.brief || '').slice(0, 300),
  };
}

/**
 * 第二次审查（复检，独立复检员角色）：是否达成用户想要的目标，还差什么、有什么缺陷。
 * @returns {Promise<{pass:boolean, summary:string, remaining:string[], defects:string[], suggestion:string}|null>}
 */
async function auditTask({ cfg, baseURL, apiKey, model, goal, doneLog, deliverables, finalText, runtimeSummary = '', diag,
  taskType, level, skeletonOnly, hardBarrier, degradeDeclared, allowDegrade, creativeKind, projectRoot }) {
  // ★★ 2026-10-23 可观测性（老板第 2 条）：
  //   原来 `null` 把三种完全不同的情况**压成同一个值**，调用方无从分辨：
  //     ① 上游返回空响应（`!txt`）② 拿不到 JSON（`!j`）③ JSON 里没有 boolean 的 pass
  //   老板原话：「调用了但返回 null：需要检查异常处理、输入条件、模型响应、工具调用或者其他返回路径。」
  //   `diag` 是**只写不读**的诊断出口：不改动返回契约（仍是 null / object），
  //   所以既有门禁（unit-agent-review）与所有调用方行为逐字不变。
  //   ⚠️ 只记原因与字符数，**不记**提示词内容与密钥。
  const note = (reason, extra) => {
    if (diag && typeof diag === 'object') Object.assign(diag, { reason }, extra || {});
  };
  const system = '你是「豆芽复检员」，一位严格但讲道理的质量审查官。你不是执行者，是第二双眼睛：'
    + '另一位 AI 刚完成了一个任务并自称做完，你要独立判断它是否真正达成用户目标。'
    // ★★ 2026-10-21 同 selfCheckTask：多了一段「产物的实际内容（程序读取）」，
    //   规则必须明确要求用它核对，否则模型会继续输出「无法核实」这种空结论。
    + '【重要：有一段「产物的实际内容」是程序直接读文件读出来的事实（字节数、页数、图片张数、'
    + '图片写死的宽高、是否有 overflow:hidden），它比助手的自述可信得多。'
    + '  · 助手的结论里出现任何数量（页数、张数、条目数）⇒ 拿证据里的实际数字核对，'
    + '    对不上必须写进 defects，并说清差多少（例：「声称 15 页，文件里只有 3 页」）；'
    + '  · 证据显示图片宽高比明显异常（如 400×120 这种远偏离 16:9 的写法）⇒ 写进 defects 作为排版风险；'
    + '  · 证据里已有事实时**不许**写「无法核实/无法确认」，那是浪费已给的事实；'
    + '  · 证据覆盖不到的维度（渲染后的视觉观感、字体是否真的溢出）可以列为"未验证"，这是诚实的。'
    + '严格只输出 JSON，不要任何别的文字。格式：'
    + '{"pass": true 或 false, "summary": "它到底做出了什么（一两句，说人话）", '
    + '"remaining": ["用户接下来还可以做什么，一条一句"], '
    + '"defects": ["发现的缺陷或风险，一条一句，没有就空数组"], '
    + '"suggestion": "一句建议：要不要继续完善、或先改哪个缺陷", '
    // ↓↓↓ 2026-11-03 新增：验收清单所需的结构化字段（旧字段一个没删，向后兼容）
    + '"taskType": "dev 或 creative（创作类=游戏/网页/PPT/UI/桌面宠物）", '
    + '"level": "main 或 fallback 或 temp（当前生效目标等级）", '
    + '"hardBarrier": true 或 false（是否遇到外部硬壁垒：反爬/权限/账号/付费/风控）, '
    + '"degradeDeclared": true 或 false（降级这件事是否已写进给用户的汇报）, '
    + '"degradeAllowed": 用户是否明确允许降级（true / false；用户没表态就省略这个字段）, '
    + '"done": ["逐条罗列本次真正交付了什么"], '
    + '"limits": {"can": ["能做什么"], "cannot": ["不能做什么"], "source": "限制来源（平台反爬/权限/环境等）"}, '
    + '"upgrade": ["降级达标时必填：满足什么条件才能切回主目标版本"], '
    + '"items": {"清单编号": {"pass": true 或 false, "evidence": "文件路径/读数/复现路径", '
    + '"reason": "仅硬失败时必填（nothing-at-all/refused-design/fake-shell/core-broken）", '
    + '"applies": 不适用时填 false}}}'
    + buildChecklistPrompt();
  // ★ 先取机械读数：它是**证据**，必须在组提示词之前就拿到，否则模型会先下结论再找依据。
  //   读盘失败一律容错（本模块纪律：审查是增益不是门禁，不许把正常收尾搞挂）。
  let readings = { mech: {}, extra: {}, projectRoot: '' };
  try {
    // creativeKind 决定「查哪些设计维度」：游戏查胜利判定/难度梯度，网页查 hover/移动端适配，
    // PPT 查信息层级/动画节奏。不传则归一成 visual（只查通用 8 项，最不易误伤）。
    readings = acceptanceReadings.collectAcceptanceReadings({ deliverables, projectRoot, creativeKind });
  } catch (e) {
    note('readings-failed', { readingsError: String((e && e.message) || e).slice(0, 160) });
  }
  const user = '【用户最初的目标】\n' + goalBlock(goal)
    + '\n\n【AI 助手实际做的工作】\n' + summarizeWork(doneLog, deliverables, finalText)
    + buildReadingsBlock(readings)
    + (runtimeSummary ? '\n\n【运行验收客观记录（真实工具结果，不是助手自述）】\n' + String(runtimeSummary).slice(0, 5000)
      + '\n运行记录为 fail/unverified 时不得判 pass=true；pass 也不能替代未覆盖的目标检查。' : '')
    + '\n\n请独立复检，按清单逐条核验后输出 JSON。';
  let txt;
  try {
    txt = await reviewChat({ baseURL, apiKey, model, system, user, temperature: 0.2, diag });
  } catch (e) {
    // reviewChat 内部已把异常吞成"带 failStage 的 null"（见上面的注释），所以这条分支
    // 是**兜底**而不是常态；留着是为了将来 reviewChat 行为变化时不至于把原因丢干净。
    note('threw', { aiChars: 0, error: String((e && e.message) || e).slice(0, 160) });
    throw e;
  }
  if (!txt) {
    // 把"在哪一步没成"翻译成可读原因：传输层失败 ≠ 模型回了空 ≠ 回了但没正文。
    const stage = (diag && diag.failStage) || '';
    const reason = stage === 'transport' ? 'upstream-error'
      : stage === 'bad-body' ? 'bad-json-body'
        : 'empty-response';
    note(reason, {
      aiChars: 0,
      httpStatus: (diag && diag.httpStatus) || 0,
      transportError: (diag && diag.transportError) || '',
    });
    return null;
  }
  const j = extractJson(txt);
  if (!j) { note('no-json', { aiChars: String(txt).length }); return null; }
  if (typeof j.pass !== 'boolean') { note('no-pass-field', { aiChars: String(txt).length }); return null; }

  // ══════════ 结构化验收（2026-11-03 新增，4 号验收 Agent）══════════
  // 【为什么不干脆用验收结论取代 pass】
  //   本文件的既有契约（backend 的 reviewVerdict、unit-agent-review 的 T8a/R1~R4）都认 `pass`
  //   这个布尔。直接把 pass 改成"由清单推导"，那些契约会在模型漏答清单时全部翻红 ——
  //   而模型漏答是常态，不是异常。所以采用**增量**接线：
  //     · 模型给了 items ⇒ 走判定公式，pass = (结论 === 达标)，四态结论挂在 acceptance 上；
  //     · 模型没给 items ⇒ 保持旧行为（pass 原样透传），但**如实记 itemsMissing**，
  //       绝不让"没核验"伪装成"核验通过"。
  //   两个分支都要能被看见：trace 里 itemsMissing=true 就说明这一轮只跑了旧口径。
  const itemsGiven = !!(j.items && typeof j.items === 'object' && !Array.isArray(j.items)
    && Object.keys(j.items).length > 0);
  let acceptance = null;
  if (itemsGiven) {
    const ctxType = taskType ? acceptanceChecklist.normalizeTaskType(taskType) : acceptanceChecklist.normalizeTaskType(j.taskType);
    const ctxLevel = level ? acceptanceChecklist.normalizeLevel(level) : acceptanceChecklist.normalizeLevel(j.level);
    const acc = acceptanceChecklist.evaluateAcceptance({
      taskType: ctxType,
      level: ctxLevel,
      skeletonOnly: skeletonOnly === true || j.skeletonOnly === true,
      // 用户明说过「不要降级 / 必须做完」⇒ 降级要判违规（清单前置核验要求读这条偏好）。
      //
      // ★★ 2026-11-03 补 `allowDegrade` 入参：原来这里**只能**读 `j.degradeAllowed`，
      //   也就是「让被验收方自己说用户允不允许降级」。而 6 号开场白第 1 问才是这条偏好的
      //   唯一真源（`userDialog.collectPreferences` → 工单第 2 项 → `ticketToAcceptanceContext`）。
      //   调用方显式给了就以调用方为准 —— 它掌握现场（用户原话），比复检员的一次猜测可信。
      //   这与下面 hardBarrier / degradeDeclared 两行是**同一条纪律**，不是新规矩。
      //
      // ⚠️ 三态不许压成两态：没表态传 undefined，**绝不能落成 false**。
      //   false 会造出「用户禁止降级」这条根本不存在的指示，进而让正常降级被判违规
      //   （unit-user-dialog 的 U3j 专门钉死这个后果）。
      // ⚠️ 不传（缺省）时逐字回落到旧行为 —— 既有调用点与 unit-agent-review 的契约不受影响。
      allowDegrade: (typeof allowDegrade === 'boolean') ? allowDegrade
        : (j.degradeAllowed === false ? false : (j.degradeAllowed === true ? true : undefined)),
      // 调用方显式给了就以调用方为准（它是掌握现场的一方，比模型的一次猜测可信）
      hardBarrier: (typeof hardBarrier === 'boolean') ? hardBarrier : j.hardBarrier === true,
      degradeDeclared: (typeof degradeDeclared === 'boolean') ? degradeDeclared : j.degradeDeclared === true,
      items: j.items,
      mech: readings.mech,
    });
    const doneList = Array.isArray(j.done) && j.done.length
      ? j.done.map((x) => String(x)).filter(Boolean)
      : [String(j.summary || '')].filter(Boolean);
    const lim = (j.limits && typeof j.limits === 'object') ? j.limits : {};
    acceptance = Object.assign({}, acc, {
      readings: readings.extra,
      report: acceptanceChecklist.renderAcceptanceReport({
        taskId: '',
        taskType: acc.taskType,
        level: acc.level,
        verdict: acc.verdict,
        done: doneList,
        limits: {
          can: Array.isArray(lim.can) ? lim.can.map((x) => String(x)) : [],
          cannot: Array.isArray(lim.cannot) ? lim.cannot.map((x) => String(x)) : [],
          source: String(lim.source || ''),
        },
        failed: acc.failed,
        upgrade: Array.isArray(j.upgrade) ? j.upgrade.map((x) => String(x)).filter(Boolean) : [],
        items: acc.items,
      }),
    });
  }
  note('ok', {
    aiChars: String(txt).length,
    pass: itemsGiven ? acceptance.verdict === acceptanceChecklist.ACCEPT_VERDICTS.PASS : j.pass === true,
    itemsMissing: !itemsGiven,
    acceptanceVerdict: acceptance ? acceptance.verdict : '',
  });
  return {
    // ★ 降级达标不是"不通过"，但它也**不是完成** —— 所以 pass=false，由 reviewVerdict
    //   带着 acceptanceVerdict 去分辨措辞（见 reviewVerdict 的新分支）。
    pass: itemsGiven ? acceptance.verdict === acceptanceChecklist.ACCEPT_VERDICTS.PASS : j.pass === true,
    acceptance,
    itemsMissing: !itemsGiven,
    summary: String(j.summary || '').slice(0, 400),
    remaining: Array.isArray(j.remaining) ? j.remaining.map((x) => String(x)).filter(Boolean).slice(0, 5) : [],
    defects: Array.isArray(j.defects) ? j.defects.map((x) => String(x)).filter(Boolean).slice(0, 5) : [],
    suggestion: String(j.suggestion || '').slice(0, 300),
  };
}

/**
 * 把复检结果写成「对话形式」的汇报 —— 老板要的不是 JSON，是豆芽像同事一样说话：
 * 做了什么 → 还剩什么 → 要不要继续 → 有什么缺陷要不要改。
 * 2026-10-19 第十七轮白话化：开头改成「我看完了它干的活」式的同事口吻（而不是直接
 * 甩一句 summary 结论）；「还能做什么」明确说成「你随时可以让我接着做」；
 * 结尾把选择权交还给用户，一次只问一件事（要不要改缺陷 / 要不要继续），不连珠炮。
 */
function buildAuditReport(audit) {
  if (!audit) return '';
  const lines = [];
  lines.push('我把刚才干的活从头到尾看了一遍，说给你听：');
  lines.push(audit.summary || '这件事我做完了。');
  if (audit.remaining && audit.remaining.length) {
    lines.push('\n接下来你还可以让我做这些，随时说一声：');
    audit.remaining.forEach((r) => lines.push('· ' + r));
  } else {
    lines.push('\n你这次要的部分都已经齐了，暂时想不出还该补什么。');
  }
  if (audit.defects && audit.defects.length) {
    lines.push('\n有几点我得如实说，算是缺陷或风险：');
    audit.defects.forEach((d) => lines.push('· ' + d));
    lines.push('\n这些要不要我帮你改掉？说一声就动手。');
  } else {
    lines.push('\n暂时没发现明显缺陷，可以放心用。');
  }
  if (audit.suggestion) lines.push('\n我的建议：' + audit.suggestion);
  if (!audit.pass) {
    // ★ 2026-11-03：区分三种"没通过"，不许一律说成「还没完全达到你的目标」。
    //   · 降级达标：目标没达到是**外部硬壁垒**造成的，降级版本身是合格的 ——
    //     说成"没达到你的目标"会让用户以为是执行方偷懒，方向完全错了。
    //   · 待优化 / 失败：沿用旧话术（那条本来就是"还没达到"）。
    const av = audit.acceptance && audit.acceptance.verdict;
    if (av === acceptanceChecklist.ACCEPT_VERDICTS.DEGRADED) {
      lines.push('\n（复检结论：主目标被外部限制挡住了，降级后的版本本身合格 —— 所以我按"降级达标"记账，'
        + '上面写清了它能干什么、不能干什么、以及要切回原版还缺什么。）');
    } else if (av === acceptanceChecklist.ACCEPT_VERDICTS.TO_IMPROVE) {
      lines.push('\n（复检结论：主体达到了，但清单里还有几条该补的细节 —— 这些属于"待优化"，'
        + '不算失败。要我按上面列的直接补掉吗？）');
    } else if (av === acceptanceChecklist.ACCEPT_VERDICTS.FAIL) {
      // ★ FAIL 和"差一点"是两种处境，不许用同一句"要我接着做吗"糊过去：
      //   命中硬失败（三层全空 / 核心功能失效 / 造假壳子 / 拒绝推演）时，用户需要知道
      //   **这次没做成**，而不是被问"要不要继续"—— 后者会让一次真失败看起来像半成品。
      lines.push('\n（复检结论：这次**没做成** —— 上面写清了卡在哪条硬条件上。'
        + '这不是"差一点"，我不把它算完成。）');
    } else {
      lines.push('\n（复检结论：还没完全达到你的目标，所以上面列了剩下的部分 —— 要我接着做吗？）');
    }
  }
  // ★ 结构化验收报告（2026-11-03）：有清单结论才附加。
  //   为什么附在对话汇报之后而不是替换它：前半段是"像同事一样说话"（老板要的体感），
  //   后半段是"可逐条对账的验收单据"（老板要的判据）。两者解决的不是同一个问题，都留着。
  if (audit.acceptance && audit.acceptance.report) {
    lines.push('');
    lines.push(audit.acceptance.report);
  }
  return lines.join('\n');
}

/**
 * 审查结果对**任务终态**的强制力 —— 唯一判据（2026-10-22，老板第 2 条建议）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么必须有它：审查跑完了，但**否决没有强制力**
 * ═══════════════════════════════════════════════════════════════════════
 *   审计读到的现场（本轮修之前）：
 *     · `audit.pass === false` 的全部后果 = 一条 SSE 事件 + 一段文案；
 *       **终态一个字都没改**（`terminalState` 在验收闸之前就算好了，之后没人再动它）。
 *     · 自查 `finished === false` 且续跑轮数用尽 ⇒ 直接走复检；复检若说 pass ⇒ 照样 COMPLETE。
 *   ⇒ 于是"两个 AI 都看了、都说不合格"，用户看到的仍然是「完成」。
 *     这不是"审查没做"，是**审查的结论没有接线到判定**——本仓反复踩过的「写了 ≠ 接线」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 判据（三条，都只回答一句话：能不能叫完成）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① 复检员明确判不合格（`audit.pass === false`）⇒ 不许 COMPLETE。
 *   ② 自查说没做完、且续跑轮数已用尽（再问也不会有第 N+1 轮）⇒ 不许 COMPLETE。
 *      为什么"1:1 平票"要取保守：说「没做完」的那一票有**具体缺失项**作证据，
 *      说「做完了」的那一票只有声称。证据压过声称（与人设「先证伪」同源）。
 *   ③ `auditPass === null`（复检没跑成/抛错）⇒ **不降级**，也**不当作通过**：
 *      返回 `unverified: true`，由调用方在文案里如实说"这一轮没跑成复检"。
 *      为什么不降级：审查是增益不是门禁（见文件头）。让一次上游 5xx 把正常任务打成 PARTIAL，
 *      就是在用"验证机制的故障"惩罚用户。
 *
 * ⚠️ 本函数是**纯函数**：不读环境、不读文件、不调用 LLM。所以门禁可以直接喂输入看输出，
 *    也能用变异自证（把任一条判据搬走 ⇒ 对应断言必须变红）。
 *
 * @param {{terminalState?:string, auditPass?:boolean|null, auditDefects?:string[],
 *          selfCheckFinished?:boolean|null, selfCheckMissing?:string[],
 *          reviewRoundsExhausted?:boolean}} o
 * @returns {{downgrade:boolean, reason:string, pending:string[], unverified:boolean}}
 */
function reviewVerdict(o) {
  const c = o || {};
  const pendingOf = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 5) : []);
  const out = { downgrade: false, reason: '', pending: [], unverified: c.auditPass === null || c.auditPass === undefined };
  // 只有 COMPLETE 需要被压下来：PARTIAL/BLOCKED 已经是"没说完"，再降就是无意义的改词。
  if (String(c.terminalState || '') !== 'COMPLETE') { out.unverified = false; return out; }
  if (c.auditPass === false) {
    out.downgrade = true;
    // ★ 2026-11-03：把「为什么没通过」分细。语义词不拆分会出现一句非常伤人的错话：
    //   「降级达标」也走 pass=false 分支 ⇒ 旧代码会对用户说「复检没通过，所以我不把这次算完成」，
    //   而真相是**外部壁垒挡住主目标、降级版本身合格**。同一句模板盖住两种完全不同的处境，
    //   用户会以为执行方偷懒 —— 这正是老板最烦的"话说不清"。
    //   ⚠️ 缺省（调用方不传 acceptanceVerdict）时**逐字回落到旧行为**，既有门禁 R1 不受影响。
    const av = String(c.acceptanceVerdict || '');
    if (av === 'DEGRADED') {
      out.reason = 'acceptance-degraded';
      // 降级达标没有"剩下的要继续做"——它已经交付完了，只是标的不是完成。
      out.pending = [];
      return out;
    }
    if (av === 'TO_IMPROVE') {
      out.reason = 'acceptance-to-improve';
      out.pending = pendingOf(c.auditDefects);
      return out;
    }
    if (av === 'FAIL') {
      out.reason = 'acceptance-failed';
      out.pending = pendingOf(c.auditDefects);
      return out;
    }
    out.reason = 'audit-rejected';
    out.pending = pendingOf(c.auditDefects);
    return out;
  }
  if (c.selfCheckFinished === false && c.reviewRoundsExhausted === true) {
    out.downgrade = true;
    out.reason = 'selfcheck-unfinished';
    // ★ 2026-10-23：区分「为什么不再补」—— 自查轮次用完 / 主循环轮次不够。
    //   两者对状态的结论相同（都不能再继续 ⇒ 必须降级），但对用户说的话完全不同：
    //   前者是「我试了 4 轮还是没搞定」，后者是「我没时间了，先交底」。
    //   缺省按 'rounds'（向后兼容：老调用点只传 reviewRoundsExhausted，不传这个字段）。
    out.exhaustedBy = c.exhaustedBy === 'turns' ? 'turns' : 'rounds';
    out.pending = pendingOf(c.selfCheckMissing);
    return out;
  }
  return out;
}

/**
 * 把 reviewVerdict 的结论写成给用户看的一句话（降级时必须说，不许默默改状态）。
 * 为什么单独一个函数：这句话要同时被"收尾文案"和"门禁"消费，写两处必然漂移。
 */
function reviewVerdictStatement(v) {
  const x = v || {};
  if (!x.downgrade) return '';
  // 2026-11-03：三种"没通过"必须说三种话（见 reviewVerdict 分支注释）。
  if (x.reason === 'acceptance-degraded') {
    return '这次主目标被外部限制挡住了（不是我改不动），我按流程降级交付了，降级后的版本是达标的 —— '
      + '所以我把它标成「做了一部分」，不标完成。上面写清了这个版本能干什么、不能干什么，以及要切回原版还缺什么。';
  }
  if (x.reason === 'acceptance-to-improve') {
    const l1 = (x.pending || []).length ? '：' + x.pending.join('；') : '。';
    return '验收清单里还有几条该补的细节，我把这次标成「做了一部分」，不算完成' + l1
      + '（这些属于待优化，不是失败 —— 我按上面这几条接着补就行，你不用重说需求。）';
  }
  if (x.reason === 'acceptance-failed') {
    const l2 = (x.pending || []).length ? '：' + x.pending.join('；') : '。';
    return '验收判定这次没做成（清单里的硬条件没满足），我不把它算完成' + l2;
  }
  const head = x.reason === 'audit-rejected'
    ? '复检没通过，所以我不把这次算完成'
    : x.exhaustedBy === 'turns'
      // ★ 2026-10-23：这一句必须和真实原因一致。修前不管哪种原因都说「续跑轮次已经用完」，
      //   而实测里更常见的是**主循环轮次不够**（task_mvkad091 自查只跑了 3 轮、上限是 4）
      //   ⇒ 用户看到「轮次用完了」会以为是自查不给力，实际是任务步数被掐断。两件事不一样。
      ? '自查说还有没做完的，而这次任务的步数已经不够再跑一轮完整修复，我先停在这里'
      : '自查说还有没做完的，而续跑轮次已经用完';
  const list = (x.pending || []).length ? '：' + x.pending.join('；') : '。';
  return head + list + '（剩下的我按上面这几条继续，不用你重新说一遍需求。）';
}

module.exports = {
  AGENT_REVIEW_MAX_ROUNDS,
  shouldReviewTask,
  buildTraceReport,
  // ★ 导出只为门禁能单独验「读数有没有真的被说给模型听」。
  //   不导出的话，就只能整装起 Electron 才能看到这段文本 ⇒ 永远钉不住。
  buildReadingsBlock,
  // ★ 2026-11-11：导出同上理由 —— 不导出就只能整装 Electron 才看得到审查员到底收到了什么，
  //   而"审查员看不见正文"正是 0.21.31 那次连问 4 轮的根因，必须能被门禁钉住。
  summarizeWork,
  buildClaimHint,
  selfCheckTask,
  auditTask,
  buildAuditReport,
  reviewVerdict,
  reviewVerdictStatement,
};
