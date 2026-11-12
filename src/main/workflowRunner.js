/**
 * workflowRunner —— 任务类型工作流的**执行器**（不是提示词）。
 *
 * 老板第三节：「豆芽不应该每次从空白开始思考"我今天准备怎么做"……固定的是工作流和验收标准，
 * 不是每页必须长得一样。」第六节又说：「关键是让 backend.js 真正执行它。」
 *
 * 本模块的定位：**纯函数 + 真实检查**，不产生任何提示词。它只回答三个问题：
 *   1. 这次任务该走哪套工作流？（detectWorkflow）
 *   2. 现在走到哪一步、还差哪些阶段？（createRun / advance）
 *   3. 按配置逐项验收，到底过没过？（evaluate —— 其中 .pptx 的页数/重复页是**真解析文件**得出的）
 *
 * 为什么检查要真解析 .pptx 而不是让模型自述：
 *   老板第一节的教训就是「积极执行不等于流程可靠」——原计划 19 页、实际 22 页、第 10–12 页重复，
 *   而模型当时是"觉得做完了"。页数与重复页必须由文件本身算出来，模型的描述不算证据。
 *   .pptx 就是一个 zip：数 ppt/slides/slideN.xml 的个数即真页数，比较各页 XML 文本的哈希即可查重。
 *   零依赖（只用 Node 内建 zlib），所以门禁里能直接喂 Buffer 测，不必有真 PowerPoint。
 */

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

// ───────────────────────────────────────────────────────────────────────────
// 一、任务类型识别
// ───────────────────────────────────────────────────────────────────────────

/**
 * 强判据：一出现就基本确定"这是在要做一份演示文稿"。
 * ★ 注意 `\bppt\b` 只认**独立的** ppt（"PPT"、"a ppt"），不吃 pptx（\b 在 x 前不成立），
 *   也不吃 "pptx" 的前缀。这样"做一份 PPT"能进，而"PPT 下载入口"要靠下面的排除条件挡。
 */
const STRONG_DECK = /pptx\b|powerpoint|\.ppt\b|\.pptx\b|\bppt\b|幻灯片|演示文稿|演示文件|路演|\bslides?\b|\bdeck\b/i;
/**
 * 弱判据：这些话在商务语境里**既可能是"做一份演示文稿"，也可能只是"讲一下情况"**。
 *   「给我汇报一下上个月订单」→ 这是要我说话，不是要我交个文件；
 *   「做个 12 页的汇报」      → 这才是要文件。
 * 所以弱判据**单独命中不算数**，必须配上页数证据（下面 PAGE_EVIDENCE）。
 *
 * ★ 2026-10-23 这是一条真实的假阳性回归：接进主循环后 detectWorkflow 会跑在**每一个**任务的
 *   用户原话上。若只认「汇报」二字，那么一句「汇报一下订单」就会被套上 pptx-v1 的验收标准，
 *   收尾时因为没有 .pptx 产物判 requested_format_matches 失败 ⇒ 一个纯查询任务被降级成未完成。
 *   这比"漏判"糟糕得多：漏判只是没走标准流程，误判是**把做对的事判成没做完**。
 */
const WEAK_DECK = /(汇报|宣讲|演示)/i;
/** 页数证据：有它就说明用户脑子里是"一份几页的东西"，而不是"跟我说两句" */
const PAGE_EVIDENCE = /(\d{1,3}\s*[-~到至]\s*\d{1,3}|\d{1,3})\s*(?:页|张|屏)|\d{1,3}\s*slides?/i;

/**
 * 交付物明显是别的东西（网页 / Word / 表格 / 一句话说明）。
 * 「下载入口/下载页/下载链接」也归到这里：用户要的是那个**入口**，PPT 只是被下载的对象。
 */
const NON_DECK_HINTS = /(一页|单页|一屏|一段话|几句话|word|docx|excel|xlsx|表格|网页|html|下载入口|下载页|下载链接)/i;
/**
 * 「明确要 .pptx 文件」的判据。
 * ★ 2026-10-23 实测修正：原来写的是 `/pptx?/i`，于是「在网页上放一个 PPT 下载入口」里的
 *   "PPT" 也被当成"要 pptx 文件" ⇒ 被误判成 PPT 任务，把网页需求套上了 pptx 的验收标准。
 *   现在只有**写出 pptx / PowerPoint / .ppt 扩展名**才算明确点名。
 *   （W1-e 就是为这条修正立的断言 —— 判据改松了它会立刻红。）
 */
const EXPLICIT_PPTX = /pptx\b|powerpoint|\.ppt\b|\.pptx\b/i;

/**
 * 识别任务类型。返回 { workflowId, spec } 或 null。
 *
 * spec 是**从用户原话里抽出来的硬约束**（老板第四节：把用户需求固化成任务规格）：
 *   · 用户明说页数时，slideCount 用确切值（不是说"落在范围里"就行）；
 *   · 用户没说页数时，才用配置里的默认范围。
 * 抽不出来就如实留 null，不许编一个数字出来 —— 编数字会让每次运行的验收标准都不一样。
 */
function detectWorkflow(userText, cfgOverride) {
  const text = String(userText || '');
  if (!text) return null;
  const cfg = cfgOverride || require('./workflows/pptx-v1');

  // ① 得先像在"要做一份演示文稿"，而不是像在"讲一下情况"
  //    强判据单独命中即可；弱判据（汇报/宣讲/演示）必须配上页数证据才算数。
  if (!STRONG_DECK.test(text) && !(WEAK_DECK.test(text) && PAGE_EVIDENCE.test(text))) return null;

  const explicitPptx = EXPLICIT_PPTX.test(text);

  // ② 交付物明显是别的东西，且没有明确点名 pptx ⇒ 不是 PPT 任务
  //    「在网页上放一个 PPT 下载入口」要交付的是网页；套 pptx 的验收标准只会判它不合格。
  if (!explicitPptx && NON_DECK_HINTS.test(text)) return null;

  return {
    workflowId: cfg.workflowId,
    version: cfg.version,
    spec: {
      // 「做 12 页」→ 确切 12；「12-16 页」→ 范围；都没说 → 配置默认
      slideCount: parseSlideCount(text, cfg),
      // 用户是否**明确点名** .pptx。点名了就不能拿网页顶替（requested_format_matches 的输入）
      explicitPptx,
    },
  };
}

/**
 * 从用户原话解析页数规格。三种形态：
 *   「做 12 页」          → { mode:'exact', count:12 }
 *   「12 到 16 页」/「12-16 页」→ { mode:'range', min:12, max:16 }
 *   「十几页」/ 没提       → 配置默认（defaultSlideCount）
 * 注意中文数字与"页"之间有空格也要认（实测老板常写「做 12 页 PPT」）。
 */
function parseSlideCount(text, cfg) {
  const t = String(text || '');
  const pair = t.match(/(\d{1,3})\s*[-~到至]\s*(\d{1,3})\s*(?:页|张|屏|slides?)/i);
  if (pair) {
    const a = Number(pair[1]);
    const b = Number(pair[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo > 0) return { mode: 'range', min: lo, max: hi };
  }
  const one = t.match(/(\d{1,3})\s*(?:页|张|屏|slides?)/i);
  if (one) {
    const n = Number(one[1]);
    if (n > 0) return { mode: 'exact', count: n };
  }
  return cfg && cfg.defaultSlideCount ? { ...cfg.defaultSlideCount, source: 'default' } : null;
}

// ───────────────────────────────────────────────────────────────────────────
// 二、运行状态（可持久化，跨请求恢复就靠它）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 新建一次运行。字段与老板给的示例对齐（workflowId / stage / completedStages /
 * openIssues / nextAction / status），多加了 version 与 spec 便于事后复现判定标准。
 */
function createRun(cfg, spec, now) {
  return {
    workflowId: cfg.workflowId,
    version: cfg.version,
    stage: cfg.stages[0],
    completedStages: [],
    // ★ 被豁免的阶段单独记（不进 completedStages）：让「真做了」与「环境不允许」永远可区分。
    waivedStages: [],
    openIssues: [],
    nextAction: cfg.stages[0],
    status: 'in_progress',
    spec: spec || {},
    startedAt: now || Date.now(),
  };
}

/**
 * 推进阶段。**只认证据，不认自述**：
 *   markStage(run, cfg, 'build', {evidence:'...'}) —— 调用方必须给出证据字符串，
 *   空证据直接抛错。这是本模块最重要的一条纪律：老板第二节「真实执行优先于文字汇报」
 *   在代码层面的落点就是「没有证据就不能打勾」。
 *
 * 顺序约束：只允许推进到「当前阶段或它的下一个」，不许跳着往前（跳步正是老板说的规划差异）。
 * 允许 stage == 已完成的下一个；允许重复标记同一阶段（幂等）。
 */
/**
 * 执行游标（`stage` / `nextAction`）的**唯一**计算点。★ 2026-10-28 修「游标倒退」
 *
 * ── 修的是什么（实测读数，不是推测）──────────────────────────────────────────
 * 旧实现里 markStage / waiveStage 都**无条件**写：
 *     stage: stage,
 *     nextAction: cfg.stages[idx + 1],
 * 于是「重新标记一个更早的阶段」会把游标一起拖回去。最小复现：
 *     续跑前：stage=build  nextAction=render  completed=[brief,outline,asset_inventory,build]
 *     标 brief          → stage=brief          nextAction=outline
 *     标 outline        → stage=outline        nextAction=asset_inventory
 *     标 asset_inventory→ stage=asset_inventory nextAction=build     ← 游标退回到已完成的 build
 * 而 `completedStages` 仍正确保留 build ⇒ **账本自己前后不一致**。
 *
 * 触发路径不是边角：`backend.js` 每次请求都会在开头 `step('brief')` / `step('outline')` /
 * `step('asset_inventory')`（证据分别是用户原话、硬规格、附件清单）。所以**每一次跨请求续跑**
 * 都会把游标拉回到 asset_inventory/build，而不是停在上一次真正做到的 build/render。
 * 后果实测：`snapshot()` 忠实转述这个坏游标 ⇒ 注入文本一边写「已完成 …>build」，
 * 一边写「下一步动作：build」；模型据此重跑了 ppt-generate（5 对 A/B 里 pair1/pair5 各 1 次）。
 *
 * ── 修法：游标单调不减 ────────────────────────────────────────────────────────
 * 游标是「执行到哪儿了」的**高水位事实**，不是「本次调用标了哪个阶段」的记录。
 * 取当前游标 = max(账本 `stage` 的下标, `completedStages ∪ waivedStages` 的最大下标)：
 *   · 只看 `stage` 会在 stage 缺失/落后于 completed 的旧账上出错；
 *   · 只看 completed 会漏算**已豁免**阶段（豁免不进 completedStages，但位置确实过去了）。
 * 新游标 = max(当前游标, 本次阶段下标) ⇒ 重标更早阶段：`completedStages` 照旧幂等补齐，
 * 游标原地不动；`stage` 与 `nextAction` 始终由同一个下标派生，二者不会互相矛盾。
 *
 * ── 需要「重新执行某个阶段」时怎么办（这是硬约定）──────────────────────────────
 * **不靠重标阶段来倒退游标**。真正的回退语义由 `planRecovery()` 的 `resumeStage` 表达：
 * 它按「前缀不变量」算出该从哪个阶段继续（例如中间存在缺口时 resumeStage 会早于游标），
 * 调用方把 `resumeStage` 当**指令**去执行，账本游标仍然记「事实做到了哪里」。
 * 两者若不一致，是「有活要补」，不是「账本错了」—— 由恢复器判断，不由 markStage 顺手改写。
 *
 * @returns {{stage:string, nextAction:string, cursorIdx:number, curIdx:number, movedForward:boolean}}
 */
function advanceCursor(run, cfg, stage) {
  const stages = cfg.stages;
  const idx = stages.indexOf(stage);
  const stageIdx = (run && run.stage) ? stages.indexOf(String(run.stage)) : -1;
  const curIdx = Math.max(stageIdx, maxDoneIndex(run, cfg));
  const cursorIdx = Math.max(curIdx, idx);        // 单调不减：只前进，不后退
  const safe = Math.min(Math.max(cursorIdx, 0), stages.length - 1);
  return {
    stage: stages[safe],
    nextAction: stages[Math.min(safe + 1, stages.length - 1)],
    cursorIdx: safe,
    curIdx,
    movedForward: idx > curIdx,
  };
}

function markStage(run, cfg, stage, evidence) {
  if (!cfg.stages.includes(stage)) throw new Error('未知阶段：' + stage);
  if (!evidence || !String(evidence).trim()) throw new Error('阶段「' + stage + '」没有证据，不能打勾');
  const idx = cfg.stages.indexOf(stage);
  // ★ 2026-10-23 修：进度基准必须把**已豁免**的阶段也算进去。
  //   原来只数 completedStages ⇒ 豁免 render 之后 maxDone 停在 build(3)，
  //   接着标 validate(5) 就被判「跳步，前置 render 还没完成」—— 于是豁免一开，
  //   后面所有阶段全都推不动（实测由 W9-f 抓到：finish() 直接抛「不允许跳步」）。
  //   豁免的语义是「这个位置过去了，只是没真做」，所以它占位但不进 completedStages。
  // ★ 进度基准收敛到 maxDoneIndex 一处定义：恢复判据要用同一份口径，
  //   否则「能推到哪里」与「恢复从哪里继续」会各自演化（本仓已有漂移的历史）。
  const maxDone = maxDoneIndex(run, cfg);
  // 允许：补标记已完成的、以及恰好下一步。跳步（idx > maxDone + 1）一律拒绝。
  if (idx > maxDone + 1) {
    throw new Error('不允许跳步：「' + stage + '」的前置阶段「' + cfg.stages[maxDone + 1] + '」还没完成');
  }
  // ★ 2026-10-28：游标由 advanceCursor 单调推进，不再无条件回写到本阶段。
  //   重标一个已完成的早期阶段，只补齐 completedStages（幂等），游标原地不动。
  const cur = advanceCursor(run, cfg, stage);
  const next = {
    ...run,
    completedStages: run.completedStages.includes(stage) ? run.completedStages.slice() : run.completedStages.concat(stage),
    stage: cur.stage,
    nextAction: cur.nextAction,
  };
  return next;
}

/**
 * 豁免一个阶段：**只在白名单里、且必须写明理由**。
 *
 * 与 markStage 的区别（这是本模块第二条纪律的落点）：
 *   markStage  = 「这件事我做完了，证据在这」
 *   waiveStage = 「这件事在当前环境做不了 / 没有可执行动作，原因在这」
 * 二者**绝不混同**：豁免不进 completedStages，只进 waivedStages。
 * 于是事后看一次运行记录，能直接算出「9 个阶段里 7 个真做了、2 个被豁免」；
 * 如果混在一起打勾，这个区分就永久丢失，等于把「做不到」洗成「做完了」。
 *
 * 白名单之外一律抛错：如果 build/validate/final_validate 也能豁免，
 * 那「有没有真的产出 pptx」「有没有真的验过」就都能被一句话绕开 —— 整套验收就废了。
 */
function waiveStage(run, cfg, stage, reason) {
  if (!cfg.stages.includes(stage)) throw new Error('未知阶段：' + stage);
  const waivable = Array.isArray(cfg.waivableStages) ? cfg.waivableStages : [];
  if (!waivable.includes(stage)) {
    throw new Error('阶段「' + stage + '」不可豁免（白名单只有：' + (waivable.join('、') || '空') + '）');
  }
  const why = String(reason || '').trim();
  if (!why) throw new Error('豁免阶段「' + stage + '"必须写明理由（环境不允许 / 无可执行动作），不许静默跳过');
  // 顺序约束与 markStage 一致：豁免也不许跳着往前，否则「跳过 outline 直接豁免 render」就能绕过中间阶段。
  const idx = cfg.stages.indexOf(stage);
  // 与 markStage 用同一个进度基准（同一份定义，见 maxDoneIndex）
  const maxDone = maxDoneIndex(run, cfg);
  if (idx > maxDone + 1) {
    throw new Error('不允许跳步：「' + stage + '」的前置阶段「' + cfg.stages[maxDone + 1] + '」还没完成');
  }
  const prev = Array.isArray(run.waivedStages) ? run.waivedStages.slice() : [];
  const already = prev.some((w) => w.stage === stage);
  // ★ 2026-10-28：豁免与 markStage 走**同一个**游标计算点（同一类缺陷，一起修）。
  //   重新豁免一个更早的阶段（例如续跑后又判了一次 render 不可做）不该把游标拖回去。
  const cur = advanceCursor(run, cfg, stage);
  return {
    ...run,
    waivedStages: already ? prev.map((w) => (w.stage === stage ? { stage, reason: why } : w)) : prev.concat({ stage, reason: why }),
    stage: cur.stage,
    nextAction: cur.nextAction,
  };
}

/**
 * 记一条未解决问题。同样的 issue_id 重复出现时 attempts+1（老板第五节 repair_attempts），
 * 达到 maxAttemptsPerIssue 仍 open ⇒ 标 needsStrategyChange，
 * 供上层判断「同一问题连续几轮没有实质改善时必须换策略或明说阻塞」。
 */
function recordIssue(run, cfg, issue) {
  const id = String((issue && issue.issue_id) || '').trim();
  if (!id) throw new Error('issue 必须有 issue_id（没有 id 的失败记录无法追踪修复次数）');
  const list = Array.isArray(run.openIssues) ? run.openIssues.slice() : [];
  const i = list.findIndex((x) => x.issue_id === id);
  const maxA = (cfg.repairPolicy && cfg.repairPolicy.maxAttemptsPerIssue) || 3;
  if (i < 0) {
    list.push({
      issue_id: id,
      stage: String(issue.stage || ''),
      target: String(issue.target || ''),
      failure: String(issue.failure || ''),
      evidence: issue.evidence || {},
      repair_attempts: Number(issue.repair_attempts) || 0,
      status: 'open',
    });
  } else {
    const cur = list[i];
    list[i] = {
      ...cur,
      repair_attempts: cur.repair_attempts + 1,
      lastEvidence: issue.evidence || cur.lastEvidence || {},
      needsStrategyChange: cur.repair_attempts + 1 >= maxA,
    };
  }
  const cap = (cfg.repairPolicy && cfg.repairPolicy.maxOpenIssuesBeforeStop) || 20;
  return { ...run, openIssues: list.slice(-cap) };
}

/** 关闭一条问题（修完并复验通过才允许关，evidence 必填 —— 同 markStage 的纪律） */
function closeIssue(run, issueId, evidence) {
  if (!evidence || !String(evidence).trim()) throw new Error('关闭问题必须带复验证据');
  const list = (run.openIssues || []).map((x) => (x.issue_id === issueId ? { ...x, status: 'closed', closedBy: String(evidence) } : x));
  return { ...run, openIssues: list };
}

// ───────────────────────────────────────────────────────────────────────────
// 三、真检查：.pptx 是 zip，页数与重复页由文件算出来
// ───────────────────────────────────────────────────────────────────────────

/** 读 zip 中央目录，返回 [{ name, method, compSize, uncompSize, localOffset }]。零依赖。 */
function listZipEntries(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 22) throw new Error('文件太小，不是 zip');
  let eocd = -1;
  const lowest = Math.max(0, b.length - 22 - 65535);
  for (let i = b.length - 22; i >= lowest; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 zip 中央目录（不是合法 zip）');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const uncompSize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const cmtLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/** 取某个条目解压后的内容（只支持 stored / deflate —— pptx 只用这两种） */
function readZipEntry(buf, entry) {
  const b = buf;
  const lo = entry.localOffset;
  if (lo + 30 > b.length || b.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地头损坏：' + entry.name);
  const nameLen = b.readUInt16LE(lo + 26);
  const extraLen = b.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const raw = b.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式 ' + entry.method + '（' + entry.name + '）');
}

/**
 * 检查一份 .pptx：能不能打开、真有几页、有没有重复页。
 * 返回 { openable, slideCount, duplicateGroups, error }
 *
 * 判据说明（为什么这么定）：
 *   · openable：能解出 zip 目录 + 能找到 ppt/presentation.xml。文件存在但结构坏 ⇒ 不开。
 *   · slideCount：**按 presentation.xml 里 <p:sldIdLst> 的条目数**算，而不是数 slideN.xml 文件个数。
 *     两者不等的文件是"删页后残留"的典型形态 —— 那种文件 PowerPoint 打开会报错或显示页数不符，
 *     正好是我们要抓的「页数对不上」。同时把两者都记下来，便于定位。
 *   · duplicateGroups：按每页所有文本节点拼起来的 sha1 分组，同组 ≥2 页即重复。
 *     （老板的现场：19 页变 22 页、第 10–12 页重复 ⇒ 文本完全一样。）
 */
function inspectPptx(buf) {
  const res = { openable: false, slideCount: 0, slideFiles: 0, duplicateGroups: [], error: '' };
  try {
    const entries = listZipEntries(buf);
    const names = new Set(entries.map((e) => e.name));
    if (!names.has('ppt/presentation.xml')) {
      res.error = '缺少 ppt/presentation.xml（不是 PowerPoint 文件）';
      return res;
    }
    const presEntry = entries.find((e) => e.name === 'ppt/presentation.xml');
    const presXml = readZipEntry(buf, presEntry).toString('utf8');
    const idMatches = presXml.match(/<p:sldId\b/g);
    res.slideCount = idMatches ? idMatches.length : 0;
    res.openable = res.slideCount > 0;

    const slideEntries = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
    res.slideFiles = slideEntries.length;

    const byHash = new Map();
    for (const e of slideEntries) {
      const xml = readZipEntry(buf, e).toString('utf8');
      // 只取文本节点 <a:t>…</a:t>：形状/坐标/样式不同但文字相同的页面，对用户就是"重复页"
      const texts = (xml.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).join('');
      const h = crypto.createHash('sha1').update(texts).digest('hex').slice(0, 12);
      if (!texts) continue;                       // 空白页不参与查重（图版页本来就没字）
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(e.name);
    }
    res.duplicateGroups = [...byHash.entries()].filter(([, v]) => v.length > 1).map(([h, v]) => ({ hash: h, pages: v }));
  } catch (e) {
    res.error = String((e && e.message) || e);
  }
  return res;
}

// ───────────────────────────────────────────────────────────────────────────
// 四、验收
// ───────────────────────────────────────────────────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 验收契约的**唯一**来源（2026-10-26）。
 *
 * 为什么要有这一节：修之前 `evaluate()` 里硬编码了 PPT 的六条检查 —— 于是
 *   · 一个 `.txt` 工作流接进注册表后，验收结果里出现的**仍然是** PPT 六项
 *     （`noop_out_written` 这类本工作流自己的检查**一次都不执行**）；
 *   · 每一项的 `severity` 还要靠 `cfg.requiredChecks.find(x => x.id === id)` 反查，
 *     也就是说 `requiredChecks` 只被用来**标注级别**，从不被用来**驱动执行** ——
 *     「把标准写进配置」这件事在验收侧是假的。
 *
 * 现在的分工（三句话）：
 *   ① 通用引擎**只**遍历 `cfg.requiredChecks`，逐项调用该工作流自己提供的 `run(ctx)`；
 *      引擎**不认识**任何具体 check id（本文件全文不出现六个 PPT id，由门禁按源码守）。
 *   ② 每一项的结果归一到**四态**：通过 / 失败 / 证据不足（unverified）/ 配置错误（config-error）。
 *      未注册实现（没有 `run`）、实现抛错、返回不可判读 ⇒ 一律 config-error，
 *      **不许静默忽略、不许自动通过**；「契约为空」也必须是 config-error 而不是"全过"。
 *   ③ 结论（verdict）由四态 + 缺口阶段聚合：任何 must 失败/未核验、任何配置错误、任何缺阶段
 *      ⇒ 不许 COMPLETE。
 *
 * 契约字段（扩展名口径，两个字段**各管一件事，不许合并**）：
 *   · `buildExts`            「算产物」的唯一来源（阶段机 / 恢复取证 / 收尾兜底都读它）；
 *   · `deliverable.extensions`「交付格式」的唯一来源（只用于格式比对，不参与产物发现）。
 *   两者今天同值但语义不同；把「交付格式」拿去当「产物发现」用，就会退回到
 *   「按扩展名扫共享工作区」那种无条件认领。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 结果五态。字符串值会原样落进 trace / 报告，所以写成人能读的形态。 */
const CHECK_OUTCOME = {
  pass: 'pass',
  fail: 'fail',
  unverified: 'unverified',
  configError: 'config-error',
  /**
   * ★★ 2026-10-26【第五态】`not-applicable`（不适用）。
   *
   * 为什么必须有第五态（真需求，不是洁癖）：老板这一轮定下的口径是「按任务目标分流」——
   *   问答任务、研究任务、文件操作任务的**成功标准本来就不同**。「这条检查的对象在本次任务里
   *   根本不存在」既不是失败（做对了活被判没做完），也不是通过（那正是老板禁止的"自动完成"）。
   *   今天只有四态 ⇒ 只能拿 `{ pass: true }` 冒充 ⇒ 报告里读起来像"验过了"，其实是"没这条"。
   *
   * ⚠️ 三条纪律：
   *   ① 它**不阻断** COMPLETE（否则"无产物"永远判未完成 —— 和"永远判完成"是同一种谎）；
   *   ② **全部**声明项都是 not-applicable ⇒ 判 PARTIAL（没有任何一项真验过 ⇒ 无法判定完成）；
   *   ③ 报告里必须单独呈现为「[不适用]」，**绝不许**渲染成"通过"。
   */
  notApplicable: 'not-applicable',
};

/**
 * 归一扩展名清单：小写、带点、长度 > 1。
 * @param {*} list
 * @returns {string[]}
 */
function normalizeExts(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x == null ? '' : x).trim().toLowerCase())
    .filter((x) => x.length > 1 && x.charAt(0) === '.');
}

/**
 * 取一个路径的扩展名（**按 basename 的最后一段**判）。
 * ★ 为什么不用 `s.endsWith('.pptx')`：那样 `deck.pptx.bak` / `deck.pptx.txt` 也会命中，
 *   而它们都不是 pptx —— 扩展名判据必须和真实文件格式一致（大小写不敏感）。
 * @param {string} p
 * @returns {string} 小写扩展名（含点）；没有扩展名返回 ''
 */
function extOf(p) {
  const base = String(p == null ? '' : p).split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i).toLowerCase();
}

/**
 * 路径是否属于给定扩展名集合。
 * @param {string} p
 * @param {string[]} exts 归一后的扩展名
 * @returns {boolean}
 */
function matchesExt(p, exts) {
  const list = Array.isArray(exts) ? exts : [];
  if (!list.length) return false;
  const e = extOf(p);
  return !!e && list.indexOf(e) >= 0;
}

/** 本工作流「算产物」的扩展名 —— **唯一**来源 `buildExts`（无回落，见头注）。 */
function artifactExtsOf(cfg) {
  return normalizeExts(cfg && cfg.buildExts);
}

/** 本工作流「交付格式」的扩展名 —— **唯一**来源 `deliverable.extensions`。 */
function deliverableExtsOf(cfg) {
  return normalizeExts(cfg && cfg.deliverable && cfg.deliverable.extensions);
}

/**
 * 契约里声明为「自指的终态一致性检查」的 id 集合。
 *
 * ★ 为什么这必须是契约声明而不是引擎字面量：这类检查的输入是"前面那些检查的结果"，
 *   所以调用方在**前面的检查还没跑完**时（例如 conclude 里试算一次以登记 openIssues）
 *   必须把它从失败清单里排除，否则它必然失败、每次都会多记一条假问题。
 *   修前这里写的是 `f.id !== 'final_status_matches_validation'` —— 通用文件里出现具体 check id，
 *   换一套工作流就失效（新工作流要么改通用文件，要么永远多记一条假问题）。
 *   现在由契约用 `terminal: true` 声明；没有声明 ⇒ 集合为空 ⇒ 一行都不排除（宁严不宽）。
 * @param {object} cfg
 * @returns {string[]}
 */
function terminalCheckIds(cfg) {
  const list = (cfg && Array.isArray(cfg.requiredChecks)) ? cfg.requiredChecks : [];
  return list.filter((x) => x && x.terminal === true && typeof x.id === 'string' && x.id).map((x) => x.id);
}

/** 一个对象是不是「检查项声明」（有非空字符串 id）。 */
function isCheckShaped(x) {
  return !!(x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string' && x.id.trim());
}

/**
 * 缺口阶段：必需阶段里既没完成、也没被豁免的那些。
 * ★ 豁免阶段**不算缺失**，但也**不算完成**：从 missingStages 排除（否则本机无渲染器就等于
 *   「每份 PPT 都判未完成」——和「每份都判完成」是同一类谎），同时原样列进 waivedStages
 *   交给交付报告，让用户自己看到"这 2 个阶段是因为环境不允许才没做"。
 * @param {object} run
 * @param {object} cfg
 * @returns {string[]}
 */
function missingStagesOf(run, cfg) {
  const r = run || {};
  const waivedNames = (Array.isArray(r.waivedStages) ? r.waivedStages : []).map((w) => w && w.stage);
  const completed = Array.isArray(r.completedStages) ? r.completedStages : [];
  return ((cfg && Array.isArray(cfg.requiredStages)) ? cfg.requiredStages : [])
    .filter((s) => !completed.includes(s) && !waivedNames.includes(s));
}

/**
 * 把检查实现的返回值归一到五态。
 *
 * 认的形状（只有这几种，其余一律 config-error —— **崩了/没说话都不等于通过**）：
 *   true                          ⇒ 通过
 *   false                         ⇒ 失败
 *   { pass:boolean, why }         ⇒ 通过 / 失败
 *   { unverified:true, why }      ⇒ 证据不足（未核验）
 *   { notApplicable:true, why }   ⇒ 不适用（这条检查的对象在本次任务里不存在）
 *   { configError:true, why }     ⇒ 配置错误
 * @param {*} ret
 * @returns {{kind:string, why:string, extra:object}}
 */
function normalizeCheckReturn(ret) {
  if (ret === true) return { kind: CHECK_OUTCOME.pass, why: '', extra: {} };
  if (ret === false) return { kind: CHECK_OUTCOME.fail, why: '', extra: {} };
  if (!ret || typeof ret !== 'object' || Array.isArray(ret)) {
    return { kind: CHECK_OUTCOME.configError, why: '检查实现没有返回可判读的结果（必须是 true/false 或 {pass,why}）⇒ 配置错误', extra: {} };
  }
  const why = String(ret.why == null ? '' : ret.why);
  const extra = {};
  for (const k of Object.keys(ret)) {
    if (k === 'pass' || k === 'why' || k === 'outcome' || k === 'configError' || k === 'unverified' || k === 'notApplicable') continue;
    extra[k] = ret[k];
  }
  if (ret.configError === true || ret.outcome === CHECK_OUTCOME.configError) {
    return { kind: CHECK_OUTCOME.configError, why: why || '配置错误', extra };
  }
  if (ret.unverified === true || ret.outcome === CHECK_OUTCOME.unverified) {
    return { kind: CHECK_OUTCOME.unverified, why, extra };
  }
  // ★ 第五态：必须排在 pass/fail 之前 —— 它的形状是 `{ notApplicable: true, why }`，
  //   没有 pass 字段；放后面会掉进"没有 pass 字段 ⇒ 配置错误"那条，把"不适用"记成"契约坏了"。
  if (ret.notApplicable === true || ret.outcome === CHECK_OUTCOME.notApplicable) {
    return { kind: CHECK_OUTCOME.notApplicable, why: why || '该项在本次任务里不适用', extra };
  }
  if (ret.pass === true) return { kind: CHECK_OUTCOME.pass, why, extra };
  if (ret.pass === false) return { kind: CHECK_OUTCOME.fail, why, extra };
  return { kind: CHECK_OUTCOME.configError, why: why || '检查实现返回了没有 pass 字段的对象 ⇒ 配置错误', extra: {} };
}

/**
 * 按**当前工作流契约**逐项验收。返回:
 *   { verdict:'COMPLETE'|'PARTIAL'|'BLOCKED', missingStages, failedChecks, unverifiedChecks,
 *     configErrors, limitations, waivedStages, blockedReason, results, contractExecutable }
 *
 * ctx 形状（backend 负责填，门禁直接构造）：
 *   {
 *     artifacts: ['/path/a.pptx', '/path/b.txt'],   // 本次任务真实产出的文件（归属由调用方保证）
 *     planned:   { mode, min, max } | { mode:'exact', count } | null,   // 页数规格
 *     rendered:  true|false,             // 有没有真的做过逐页渲染检查
 *     rendererAvailable: true|false,
 *     inspector: (path) => inspectPptx 结果,   // 可注入，门禁用来喂内存 Buffer
 *     exists: (p) => boolean,            // 可注入；默认读 fs
 *     sizeOf: (p) => number,             // 可注入；默认读 fs
 *   }
 *
 * 检查项拿到的 `run(ctx)` 参数（见 `ctxBase`）：
 *   extensions / deliverableExtensions —— 两个口径的扩展名（产物 / 交付格式）
 *   artifactsMatching(exts)            —— 按扩展名挑产物（**不判存在性**，存在性是检查自己的事）
 *   sizeOf / readArtifact / inspect    —— 真读数（读不到就是 0 / null，不许编）
 *   formatMatches()                    —— 交付格式比对（唯一实现，见下）
 *   priorResults() / mustProblems() / missingStages() —— 自指检查用的只读快照
 *   unverified(why) / configError(why) —— 表达"证据不足 / 契约有问题"的统一写法
 *
 * ★ 反假绿纪律：引擎**不提供**任何"默认通过"的路径。没有 run ⇒ config-error；
 *   run 崩了 ⇒ config-error；契约一条检查都没声明 ⇒ config-error。三者都不许 COMPLETE。
 */
function evaluate(run, cfg, ctx) {
  const c = ctx || {};
  const cf = cfg || {};
  const runNow = run || {};
  const artifacts = Array.isArray(c.artifacts) ? c.artifacts.filter(Boolean).map(String) : [];
  const inspect = typeof c.inspector === 'function' ? c.inspector : (p) => {
    try { return inspectPptx(fs.readFileSync(p)); } catch (e) { return { openable: false, slideCount: 0, slideFiles: 0, duplicateGroups: [], error: String(e.message || e) }; }
  };

  // ── 契约口径（唯一来源，见本节头注）────────────────────────────────────────
  const artifactExts = artifactExtsOf(cf);
  const delivExts = deliverableExtsOf(cf);
  const delivFormat = String((cf.deliverable && cf.deliverable.format) || '') || delivExts.join('/');
  const rejectsExts = normalizeExts(cf.deliverable && cf.deliverable.rejectsAsDeliverable);

  const existsFn = typeof c.exists === 'function' ? c.exists
    : (p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
  const sizeFn = typeof c.sizeOf === 'function' ? c.sizeOf
    : (p) => { try { return Number(fs.statSync(p).size) || 0; } catch { return 0; } };
  const readArtifact = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

  /**
   * 按扩展名挑产物。**只按扩展名**（大小写不敏感、按 basename 最后一段判）。
   * ★ 为什么这里**不**过滤"文件不存在"：那会把「文件没落地」这种失败提前变成「没有产物」，
   *   两种失败的归因混在一起，事后看不出到底是"没做"还是"做了但没写下去"。
   *   存在性 / 大小 / 内容一律由检查项自己用 sizeOf / readArtifact / inspect 判（读不到就是 0 / null）。
   */
  const artifactsMatching = (exts) => {
    const e = normalizeExts(exts);
    if (!e.length) return [];
    return artifacts.filter((p) => matchesExt(p, e));
  };

  /**
   * 交付格式比对（**唯一**实现）。检查项通过 `coversFormat: true` 声明自己覆盖它。
   * 三态：有交付格式产物 ⇒ 通过；只有被明确拒收的格式（如 .html/.md）⇒ 失败并把话说清；
   * 什么都没有 ⇒ 失败（"没有 xxx 产物"）。
   * 契约根本没声明交付格式 ⇒ unverified（**不许**当成通过）。
   */
  const formatMatches = () => {
    if (!delivExts.length && !delivFormat) {
      return { pass: false, unverified: true, why: '契约没有声明交付格式（deliverable.format/extensions 皆空）⇒ 格式无法比对（不许当成通过）' };
    }
    const hits = delivExts.length ? artifactsMatching(delivExts) : [];
    if (hits.length) return { pass: true, why: '' };
    const bad = rejectsExts.length ? artifacts.filter((p) => matchesExt(p, rejectsExts)) : [];
    if (bad.length) {
      return { pass: false, why: '只产出了 ' + bad.join('、') + '，用户要的是 ' + delivFormat };
    }
    return { pass: false, why: '没有 ' + delivFormat + ' 产物' };
  };

  const missingStages = missingStagesOf(runNow, cf);
  const priorResults = () => results.slice();

  const results = [];
  const ctxBase = {
    run: runNow,
    cfg: cf,
    artifacts,
    /** 「算产物」的扩展名（来自 buildExts；未声明 ⇒ 空数组，不许回落 .pptx） */
    extensions: artifactExts,
    /** 「交付格式」的扩展名（来自 deliverable.extensions） */
    deliverableExtensions: delivExts,
    deliverableFormat: delivFormat,
    planned: c.planned || null,
    rendered: c.rendered === true,
    rendererAvailable: c.rendererAvailable === true,
    renderPolicy: String(cf.renderPolicy || ''),
    exists: existsFn,
    sizeOf: sizeFn,
    readArtifact,
    inspect,
    artifactsMatching,
    formatMatches,
    /**
     * ★ 第三阶段（2026-10-26）新增的**事实**入口。它们只做"把调用方已经核实过的事实原样交出去"，
     *   引擎自己既不扫盘、也不猜 —— 判据仍然由**工作流契约**写（见 general-v1.js）。
     *   为什么要有这些：通用任务的成功标准不是"有没有文件"，而是"任务目标有没有被证据满足"，
     *   而目标证据（本轮回复 / 工具失败账 / 检查读数）只有 backend 拿得到。
     */
    claimedArtifacts: Array.isArray(c.claimedArtifacts) ? c.claimedArtifacts.filter(Boolean).map(String) : [],
    attribution: (c.attribution && typeof c.attribution === 'object') ? c.attribution : null,
    declaredFormat: String(c.declaredFormat == null ? '' : c.declaredFormat),
    responseText: String(c.responseText == null ? '' : c.responseText),
    expectsArtifact: c.expectsArtifact === true,
    expectsRuntime: c.expectsRuntime === true,
    runtime: (c.runtime && typeof c.runtime === 'object') ? c.runtime : null,
    toolFailures: (c.toolFailures && typeof c.toolFailures === 'object') ? c.toolFailures : null,
    evidence: (c.evidence && typeof c.evidence === 'object') ? c.evidence : null,
    /** 扩展名判据的**唯一**实现（与 matchesExt 同源），给契约自己做格式比对用。 */
    extOf,
    outcome: CHECK_OUTCOME,
    /**
     * 自指检查用的只读快照：**本条检查之前**已经算出的结果。
     * 终态一致性检查必须读这个，而不是读完整的 results —— 它自己还没算出来，
     * 拿完整 results 会形成自指（永远红 / 永远绿都说不清）。
     */
    priorResults,
    mustProblems: () => priorResults().filter((x) => x && x.severity === 'must'
      // ★ 第五态（2026-10-26）：「不适用」不是问题。把它算成问题，会让任何含
      //   `terminal: true` 自指检查的工作流在"某项不适用"时被自己判死。
      && x.outcome !== CHECK_OUTCOME.pass && x.outcome !== CHECK_OUTCOME.notApplicable),
    missingStages: () => missingStages.slice(),
    /** 检查项表达"证据不足"的统一写法（**不许**自己编一个 pass:true 糊过去）。 */
    unverified(why) { return { pass: false, unverified: true, why: String(why == null ? '' : why) || '证据不足，未核验' }; },
    /** 检查项表达"契约本身有问题"的统一写法（未注册实现 / 实现崩了 / 配置缺字段）。 */
    configError(why) { return { pass: false, configError: true, why: String(why == null ? '' : why) || '契约配置错误' }; },
  };

  // ── ① 契约自身的完整性：这些是**配置错误**，不是"证据不足"，更不是"通过" ──────
  const declaredRaw = Array.isArray(cf.requiredChecks) ? cf.requiredChecks.filter(isCheckShaped) : [];
  const seenIds = new Set();
  const declared = [];
  for (const spec of declaredRaw) {
    if (seenIds.has(spec.id)) continue;      // 同一 id 重复声明：只跑一次（重复不是"多一道保险"）
    seenIds.add(spec.id);
    declared.push(spec);
  }
  if (!declared.length) {
    results.push({
      id: 'acceptance_contract_checks',
      severity: 'must',
      pass: false,
      outcome: CHECK_OUTCOME.configError,
      configError: true,
      why: '本工作流没有声明任何可执行验收项（requiredChecks 为空）⇒ 没有可执行验收契约，不许判完成',
    });
  }
  const coversFormat = declared.filter((x) => x.coversFormat === true);
  if (declared.length && (delivFormat || delivExts.length) && !coversFormat.length) {
    results.push({
      id: 'acceptance_contract_format',
      severity: 'must',
      pass: false,
      outcome: CHECK_OUTCOME.configError,
      configError: true,
      why: '契约声明了交付格式「' + delivFormat + '」，但没有任何验收项声明 coversFormat'
        + ' ⇒ 格式偏差不会被任何检查看到（漏声明就是静默全绿）',
    });
  }

  // ── ② 逐项跑工作流自己提供的检查 ────────────────────────────────────────────
  for (const spec of declared) {
    const severity = spec.severity === 'best-effort' ? 'best-effort' : 'must';
    const head = { id: spec.id, severity };
    if (typeof spec.run !== 'function') {
      results.push({
        ...head, pass: false, outcome: CHECK_OUTCOME.configError, configError: true,
        why: '验收项「' + spec.id + '」声明了 id 却没有 run 实现 ⇒ 配置错误'
          + '（未注册的必需检查不许静默忽略、不许自动通过）',
      });
      continue;
    }
    let ret = null;
    try {
      ret = spec.run(ctxBase);
    } catch (e) {
      const msg = String((e && e.message) || e);
      results.push({
        ...head, pass: false, outcome: CHECK_OUTCOME.configError, configError: true, error: msg,
        why: '验收项「' + spec.id + '」的实现抛错：' + msg + '（崩了不等于通过）',
      });
      continue;
    }
    const norm = normalizeCheckReturn(ret);
    const base = { ...head, ...norm.extra };
    if (norm.kind === CHECK_OUTCOME.configError) {
      results.push({ ...base, pass: false, outcome: CHECK_OUTCOME.configError, configError: true, why: norm.why });
    } else if (norm.kind === CHECK_OUTCOME.unverified) {
      results.push({ ...base, pass: false, unverified: true, outcome: CHECK_OUTCOME.unverified, why: norm.why });
    } else if (norm.kind === CHECK_OUTCOME.notApplicable) {
      // ★ `pass: false` 是有意为之：这不是"通过"。所有读 `pass` 的既有消费者（成果卡/门禁/
      //   旧报告）因此不会把"不适用"读成"验过了"；要分辨它请读 `outcome === 'not-applicable'`
      //   或 `notApplicable === true`。聚合与报告都按第五态单独处理。
      results.push({ ...base, pass: false, notApplicable: true, outcome: CHECK_OUTCOME.notApplicable, why: norm.why });
    } else {
      results.push({ ...base, pass: norm.kind === CHECK_OUTCOME.pass, outcome: norm.kind, why: norm.why });
    }
  }

  // ── ③ 聚合结论 ─────────────────────────────────────────────────────────────
  const failedChecks = results.filter((x) => x.outcome === CHECK_OUTCOME.fail);
  const unverifiedChecks = results.filter((x) => x.outcome === CHECK_OUTCOME.unverified);
  const configErrors = results.filter((x) => x.outcome === CHECK_OUTCOME.configError);
  const skipped = results.filter((x) => x.outcome === CHECK_OUTCOME.notApplicable);
  const passed = results.filter((x) => x.outcome === CHECK_OUTCOME.pass);
  const unverifiedMust = unverifiedChecks.filter((x) => x.severity === 'must');
  const limitations = results.filter((x) => x.limitation === true);
  let verdict = 'COMPLETE';
  let verdictReason = '';
  /**
   * ★★ 第五态的关键聚合规则（2026-10-26，**不许简化**）：
   *   "全部声明项都不适用"= 一条通过都没有，且没有任何失败 / 证据不足 / 配置错误 / 缺阶段。
   *   这种情况**必须判 PARTIAL**：它意味着"本次任务没有一条验收标准真正被执行过"，
   *   于是**无法判定完成**。判 COMPLETE 就是把"什么都没验"洗成"验过了" —— 老板明确禁止。
   *   （注意顺序：阻断分支优先。`else if` 只在"没有任何阻断"时才生效。）
   */
  if (failedChecks.length || unverifiedMust.length || configErrors.length || missingStages.length) verdict = 'PARTIAL';
  else if (!passed.length && skipped.length) {
    verdict = 'PARTIAL';
    verdictReason = '全部 ' + skipped.length + ' 个验收项都不适用于本次任务'
      + '（没有任何一项真正被执行并给出通过结论）⇒ 没有任何适用于本次任务的验收项 ⇒ 无法判定完成';
  }
  // BLOCKED 只留给「外部能力缺失导致根本做不了」，由调用方显式传入
  if (c.blockedReason) verdict = 'BLOCKED';

  const waived = Array.isArray(runNow.waivedStages) ? runNow.waivedStages : [];
  /**
   * ★★★ 2026-10-26【内容保障级别】通用机制（**不是** PPT 改造，也不含任何具体 id）。
   *
   * 为什么由引擎提供这个口子：`evaluate()` 是唯一知道"哪些检查跑了、结论是什么"的地方，
   *   而"这段结论能被怎样引用"必须从**同一批结果**读 —— 让调用方自己再判一遍就是第二套判据。
   * 触发条件是 `cfg.assuranceOf` 是函数（工作流自己声明能力，引擎不认识任何具体工作流）：
   *   · 声明了 ⇒ 返回对象多一个 `contentAssurance` 字段；
   *   · **没声明**（pptx-v1 就是）⇒ 返回对象**逐字节不变**，没有这个键。这是本机制的正控。
   *
   * 三条纪律：
   *   ① 它**不参与 verdict**：不是判据，是定性标签（问答类任务的 COMPLETE 依然合法）。
   *   ② 抛错**不许静默吞掉**：降级成 `{level:'unavailable'}` 放进返回对象（审计能看到"这次没定出级别"），
   *      但绝不因此压 verdict —— 一个标签坏了不该把一件做好的事判成没做好。
   *   ③ 只在**结果全部算完**之后调用（它读 `results[].outcome`，读半成品会得到错级别）。
   */
  const out = {
    verdict,
    /** 为什么是这个结论（空串 = 走的是常规聚合，没有特殊理由可讲）。 */
    verdictReason,
    missingStages,
    /**
     * ★ 语义收窄（2026-10-26）：`failedChecks` 现在只装「**执行过**且判失败」的项。
     *   证据不足（unverified）与配置错误（config-error）**单独列出** —— 它们同样不许判完成
     *   （见上面的 verdict 聚合），但把它们混进 `failedChecks` 会让「这条检查没通过」
     *   与「这条检查根本没跑成」这两件事在报告里读起来一样。三态必须可分辨。
     */
    failedChecks,
    unverifiedChecks,
    configErrors,
    /**
     * ★ 第五态（`not-applicable`）单独一列。**不许**混进 `failedChecks`
     *   （它们不是失败，混进去会让"这次没这条"读成"这条做砸了"），
     *   也**不许**混进通过项。`skippedChecks` 是给报告/trace 的 id 简表。
     */
    skipped,
    skippedChecks: skipped.map((x) => ({ id: x.id, severity: x.severity, why: x.why })),
    limitations,
    // 被豁免的阶段（带理由）。与 missingStages 语义不同：这些是「环境不允许/无动作可做」，
    // 不是「该做没做」；报告里必须分别呈现，否则两者会被读成一回事。
    waivedStages: waived.map((w) => ({ stage: w && w.stage, reason: String((w && w.reason) || '') })),
    blockedReason: c.blockedReason || '',
    results,
    /** 本工作流到底有没有「可执行验收契约」：没有 ⇒ 调用方必须说"没验过"，不许说"通过"。 */
    contractExecutable: declared.length > 0 && configErrors.length === 0,
  };
  if (typeof cf.assuranceOf === 'function') {
    try {
      out.contentAssurance = cf.assuranceOf(ctxBase, results);
    } catch (e) {
      out.contentAssurance = {
        level: 'unavailable',
        why: '内容保障级别推导抛错：' + String((e && e.message) || e)
          + '（这只是一个定性标签，不影响上面的 verdict；但"没定出级别"必须被看见，不许静默）',
      };
    }
  }
  return out;
}

/** 把 evaluate 的结论翻成用户能看懂的一句话（交付报告用） */
function summarize(evaluation) {
  const e = evaluation || {};
  const waived = (e.waivedStages || []).length
    ? '（' + e.waivedStages.length + ' 个阶段按能力边界豁免：'
      + e.waivedStages.map((w) => w.stage + '——' + w.reason).join('；') + '）'
    : '';
  /**
   * ★ 第五态的统一呈现（2026-10-26）：`[不适用] id（why）`。
   *   为什么**所有出口**都追加：合规报告必须能区分「验过了」「没验成」「这次没有这一项」。
   *   只把它放在失败分支里，COMPLETE 时"有 3 项其实没验"就会被读成"全部通过"。
   *   ⚠️ 用词纪律：这一段**不许**出现"通过"二字（否则读起来像通过项）。
   */
  const naList = (e.skippedChecks || []).filter((x) => x && x.id);
  const na = naList.length
    ? '（[不适用] ' + naList.map((x) => x.id + (x.why ? '（' + x.why + '）' : '')).join('；[不适用] ') + '）'
    : '';
  // ★ 契约偏差小节追加在所有出口上（路线文档判据：交付文本必须含「契约偏差」小节）。
  //   没有任何契约结论时 describeContract 返回空串 ⇒ 老调用方的文本逐字不变。
  if (e.verdict === 'COMPLETE') {
    const lim = (e.limitations || []).length ? '（已知限制：' + e.limitations.map((x) => x.why).join('；') + '）' : '';
    return '验收通过' + lim + waived + na + describeContract(e);
  }
  if (e.verdict === 'BLOCKED') return '被阻塞：' + (e.blockedReason || '外部条件不满足') + describeContract(e);
  const parts = [];
  if (e.verdictReason) parts.push(e.verdictReason);
  if ((e.missingStages || []).length) parts.push('缺少阶段 ' + e.missingStages.join('、'));
  for (const f of e.failedChecks || []) parts.push(f.id + (f.why ? '（' + f.why + '）' : ''));
  // ★ 三态都要能读出来：证据不足 ≠ 失败，配置错误更不是失败 —— 混在一句"未通过"里，
  //   事后无法回答"这条到底是没做到，还是根本没验成"。
  for (const f of e.unverifiedChecks || []) parts.push('[证据不足] ' + f.id + (f.why ? '（' + f.why + '）' : ''));
  for (const f of e.configErrors || []) parts.push('[配置错误] ' + f.id + (f.why ? '（' + f.why + '）' : ''));
  return '未通过：' + parts.join('；') + waived + na + describeContract(e);
}

// ───────────────────────────────────────────────────────────────────────────
// 三·B、`evaluateStandalone` —— 没有阶段机的通用任务怎么验收
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★★★ 2026-10-26【第三阶段】通用任务（`lifecycle: 'none'`）的验收路径。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（真缺口，不是设计偏好）：
 *   `backend.js` 对 `lifecycle: 'none'` 的注册项**不建控制器**（`startWorkflowRun` 直接返回
 *   null），而 `evaluate()` 的两处调用点都在控制器内部 ⇒ 通用任务**根本没有 verdict**：
 *   它既判不了 COMPLETE，也判不了 PARTIAL，报告里那一栏永远是空的。于是
 *   「general-v1 不能永远无法完成」这条就无从谈起 —— 不是判错了，是没判。
 *
 * 为什么**不**把 general-v1 改成 `lifecycle: 'full'`（这是本阶段最容易被顺手做错的一步）：
 *   那会给每一个非 PPT 任务建控制器、open 持久化状态、武装跨请求复用闸门，
 *   27 个 `wfCtl.*` 调用点全部从 null 变非 null；blast radius 远超"给通用任务一个 verdict"。
 *   （`backend.js:3016` 那段注释已经用实测记下"硬建控制器 3/3 次 TypeError"。）
 *   所以这里走**另一条**路：不建控制器，只在收尾时对**注册对象本身**做一次验收。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★ 它不是第二份聚合器（这条是硬约束）：
 *   逐项归一（`normalizeCheckReturn`）、五态聚合、`formatMatches`、契约完整性检查
 *   ——全部复用 `evaluate()`。本函数只做三件事：① 把注册项投影成一份**只含判据**的
 *   临时契约；② 造一个"没有阶段、没有历史账"的空 run；③ 调用 evaluate 并补三个说明字段。
 *   所以不存在"两套判据各自漂移"的风险：改判据只改 `evaluate()` 一处。
 *
 * ★ 与 `evaluate(run, cfg, ctx)` 的**只有三处**差别（都写在这里，不许新增第四处）：
 *   ① 没有阶段机 ⇒ `missingStages` 恒为 `[]`；且**绝不**因为"没有阶段"就判完成
 *      —— 完成只能来自"至少一条检查真的通过"（空契约 ⇒ config-error ⇒ 不许 COMPLETE）。
 *   ② 没有 run 状态 ⇒ **不读** `completedStages` / `waivedStages`（传空数组，不是"读不到就猜"）。
 *   ③ 结论**只用于本轮收尾**，**不落持久化状态**（返回里的 `statePersisted: false` 就是这句话的
 *      机器可读形态；通用任务没有 run 文件，谁要说写了盘就是失实）。
 *
 * 契约来源**唯一**：`entry.requiredChecks`。`entry` 没有可执行项 ⇒ `evaluate` 会给出
 *   `acceptance_contract_checks` 的 config-error ⇒ PARTIAL。**不许**在这里静默返回 null，
 *   也不许返回 COMPLETE（空契约不是合格机器）。
 *
 * @param {object} entry 注册表选中的**注册对象本身**（`selectWorkflow(...).entry`，任何 lifecycle 都给）
 * @param {object} ctx   与 `evaluate` 同形状（额外认 `claimedArtifacts / attribution / declaredFormat /
 *                       responseText / expectsArtifact / toolFailures / evidence`，见 `ctxBase`）
 * @returns {object} evaluate 的结论 + `{ standalone:true, statePersisted:false, missingStages:[] }`
 */
function evaluateStandalone(entry, ctx) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  /**
   * 投影成"只含判据"的临时契约。**故意不搬** stages / requiredStages / repairPolicy：
   * 这些字段一旦出现，`evaluate` 的缺阶段判定就会介入 —— 通用任务没有阶段机，
   * 那不是"缺阶段"，是"没有阶段机这件事本身"。
   * `renderPolicy` 照搬：它是"能力边界"声明，不是阶段机（pptx 的 render 检查读它）。
   */
  const projection = {
    workflowId: e.workflowId,
    version: e.version,
    requiredChecks: e.requiredChecks,
    buildExts: e.buildExts,
    deliverable: e.deliverable,
    renderPolicy: e.renderPolicy,
    /**
     * ★ 2026-10-26：能力声明也要跟着投影。
     *   漏掉这一行 ⇒ `evaluate()` 永远看不到 `assuranceOf` ⇒ 通用任务的返回对象上
     *   永远没有 `contentAssurance`，而且**不会有任何报错**（静默少一个字段，
     *   正是"投影漏搬"这类事故最难查的形态）。没有它的工作流 ⇒ 这里是 undefined ⇒ 跳过。
     */
    assuranceOf: e.assuranceOf,
  };
  /** 空 run：没有阶段、没有历史账、没有产物账（产物归属由 `ctx.attribution` 提供）。 */
  const emptyRun = {
    workflowId: String(e.workflowId || ''),
    version: Number(e.version) || 0,
    completedStages: [],
    waivedStages: [],
    openIssues: [],
    artifacts: [],
    spec: {},
  };
  const ev = evaluate(emptyRun, projection, ctx || {});
  return Object.assign({}, ev, {
    /** 本结论来自"没有控制器的通用路径"（调用方据此决定不写状态）。 */
    standalone: true,
    /** 通用任务没有 run 状态可落盘 —— 这句话是事实陈述，不是注释。 */
    statePersisted: false,
    /** 见上面差别①：没有阶段机 ⇒ 不存在"缺阶段"。 */
    missingStages: [],
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 四·B、目标契约收尾对照（diffContract）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把 `spec.planned` 归一成 `{mode:'exact',count}` / `{mode:'range',min,max}` / `null`。
 * 认不出就是 `null`（**不许猜一个默认值**：猜出来的"规格"会和用户真说的话混在一起，
 * 而这两者的区别正是本模块要保住的东西）。
 */
function normalizePlanned(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    return (Number.isFinite(input) && input > 0) ? { mode: 'exact', count: Math.floor(input) } : null;
  }
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const mode = String(input.mode || '').trim();
  if (mode === 'exact') {
    const n = Number(input.count);
    return (Number.isFinite(n) && n > 0) ? { mode: 'exact', count: Math.floor(n) } : null;
  }
  if (mode === 'range') {
    const lo = Number(input.min);
    const hi = Number(input.max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) return null;
    return { mode: 'range', min: Math.floor(lo), max: Math.floor(hi) };
  }
  return null;
}

/** 交付格式归一：小写、去掉前导点。认不出返回 `''`（空 = 拿不出可比项，不是"一致"）。 */
function normalizeFormat(input) {
  if (input === null || input === undefined) return '';
  return String(input).trim().toLowerCase().replace(/^\./, '');
}

/** 产物路径清单（去重、保序）；`actual` 允许直接是字符串数组。 */
function artifactPathsOf(actual) {
  const raw = Array.isArray(actual) ? actual
    : ((actual && typeof actual === 'object' && Array.isArray(actual.artifacts)) ? actual.artifacts : []);
  const list = [];
  for (const p of raw) {
    const t = (p === null || p === undefined) ? '' : String(p).trim();
    if (t && list.indexOf(t) < 0) list.push(t);
  }
  return list;
}

/**
 * 取出**每一份**产物的真实页数。两种来源（先专用、后通用）：
 *   ① `actual.counts = [{path, slideCount}]` —— 收尾时由 `inspectPptx` 的真实读数填进来；
 *   ② `actual.slideCount = n` —— 单份产物的简化形态。
 * 页数 ≤ 0 的**不参与比较**（打不开 / 0 页 = 拿不出可比项，不是"0 页符合 5 页"）。
 */
function collectDecks(actual) {
  const a = (actual && typeof actual === 'object' && !Array.isArray(actual)) ? actual : {};
  const decks = [];
  const rawCounts = Array.isArray(a.counts) ? a.counts : [];
  for (const c of rawCounts) {
    if (!c || typeof c !== 'object') continue;
    const n = Number(c.slideCount !== undefined ? c.slideCount : c.count);
    if (Number.isFinite(n) && n > 0) decks.push({ path: String(c.path || ''), count: Math.floor(n) });
  }
  if (!decks.length) {
    const single = Number(a.slideCount);
    if (Number.isFinite(single) && single > 0) {
      const paths = artifactPathsOf(a);
      decks.push({ path: paths.length ? paths[0] : '', count: Math.floor(single) });
    }
  }
  return decks;
}

/**
 * 从产物扩展名判交付格式。
 * `pptx` 优先（有就说明"用户要的东西真的在"）；没有 pptx 时：全一致就如实报那一种，
 * 两种以上就拼成 `a+b`（**绝不**归一成 `pptx` 或某个"看起来对"的值）。
 */
function formatOfArtifacts(paths) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) return '';
  const exts = [];
  for (const p of list) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(p).trim());
    if (m) exts.push(m[1].toLowerCase());
  }
  if (!exts.length) return '';
  if (exts.indexOf('pptx') >= 0) return 'pptx';
  const uniq = [];
  for (const e of exts) if (uniq.indexOf(e) < 0) uniq.push(e);
  if (uniq.length === 1) return uniq[0];
  return uniq.sort().join('+');
}

/**
 * 规格 vs 实际的差距。**两个方向都必须报**：
 *   3 页配 5 页的规格要报；5 页配 3 页的规格**也要报**（多交不是"超额完成"，
 *   多出来的页是用户没要的内容，同样得让他知道）。
 * @returns {{expected:any, why:string}|null} `null` = 这一份达标
 */
function countGap(planned, n) {
  if (!planned) return null;
  if (planned.mode === 'exact') {
    if (n === planned.count) return null;
    return {
      expected: planned.count,
      why: '规格要求恰好 ' + planned.count + ' 页，实际 ' + n + ' 页'
        + (n < planned.count ? '（少交）' : '（多交，多出来的页是用户没要的内容）'),
    };
  }
  if (planned.mode === 'range') {
    if (n >= planned.min && n <= planned.max) return null;
    return {
      expected: { mode: 'range', min: planned.min, max: planned.max },
      why: '规格要求 ' + planned.min + '-' + planned.max + ' 页，实际 ' + n + ' 页'
        + (n < planned.min ? '（少于下限）' : '（超过上限）'),
    };
  }
  return null;
}

/** 变更申报的 `field`（逐字比较用；缺字段归一成空串，不猜）。 */
function amendmentFieldName(m) {
  if (!m || typeof m !== 'object') return '';
  const v = (m.field === undefined || m.field === null) ? '' : m.field;
  return String(v).trim();
}

/** 变更申报的 `evidence`（trim 后）。空串 = **空证据**，不算批准。 */
function amendmentEvidence(m) {
  if (!m || typeof m !== 'object') return '';
  const v = (m.evidence === undefined || m.evidence === null) ? '' : m.evidence;
  return String(v).trim();
}

/** 短展示（进 why 用；不能把整个对象倒进日志里）。 */
function briefValue(v) {
  let t;
  try { t = (typeof v === 'string') ? v : JSON.stringify(v); } catch { t = String(v); }
  if (t === undefined) t = 'undefined';
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

/** `to` 与产物实际值是否一致：先数值比较（`'3'` 与 `3` 算一致），再退到字符串逐字比较。 */
function valueMatches(claimed, real) {
  if (claimed === undefined || claimed === null) return false;
  if (typeof claimed === 'string' && claimed.trim() === '') return false;
  if (claimed === real) return true;
  const a = Number(claimed);
  const b = Number(real);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  return String(claimed).trim() === String(real).trim();
}

/**
 * 这条偏差能不能降级成「经批准的变更」？—— **四道前置，缺一不可**（AND，不是 OR）。
 *
 * ① `evidence` trim 后非空   —— 空证据的批准不算批准（模型自述一句话就能洗白，是 B 种作弊的唯一入口）；
 * ② `field` 与偏差字段逐字相同 —— 拿 `format` 的批准抵扣 `slideCount` 是跨科目报销；
 * ③ `at > spec.startedAt`     —— **上一轮的批准不许给这一轮免死**（没有 startedAt 视为不满足）；
 * ④ `to` 与产物实际值一致      —— "批准改成 4 页"不能给"实际 3 页"免死。
 *
 * 任一条不过 ⇒ 留在 `deviations` 里，并且 `why` 里**点名是哪一条没过**
 * （`evidence-empty` / `field-mismatch` / `stale-approval` / `to-mismatch`），
 * 这样"为什么不认这条批准"是能被第三方复核的，而不是一句"不符合"。
 *
 * @param {{field:string, actualValue:any, amendments:Array<object>, startedAt:number|null}} o
 * @returns {{approved:boolean, to?:any, evidence?:string, why:string}} `why` 以「；」开头，便于与偏差原文拼接
 */
function judgeAmendment(o) {
  const field = String((o && o.field) || '').trim();
  const actualValue = o ? o.actualValue : null;
  const amendments = (o && Array.isArray(o.amendments)) ? o.amendments : [];
  const startedRaw = o ? Number(o.startedAt) : NaN;
  const startedAt = (Number.isFinite(startedRaw) && startedRaw > 0) ? startedRaw : null;

  if (!amendments.length) {
    return { approved: false, why: '；且没有任何变更申报（spec.amendments 为空）⇒ 按偏差计' };
  }
  const sameField = amendments.filter((m) => amendmentFieldName(m) === field);
  if (!sameField.length) {
    const got = amendments.map((m) => amendmentFieldName(m) || '(空)').join('、');
    return {
      approved: false,
      why: '；变更申报的 field=[' + got + '] 与偏差字段「' + field + '」逐字不同 ⇒ field-mismatch'
        + '（拿别的字段的批准来抵扣是跨科目报销）⇒ 退回偏差',
    };
  }

  const fails = [];
  for (const m of sameField) {
    const evidence = amendmentEvidence(m);
    if (!evidence) {
      fails.push({ token: 'evidence-empty', why: 'evidence 为空（trim 后）⇒ 空证据的批准不算批准' });
      continue;
    }
    if (startedAt === null) {
      fails.push({ token: 'stale-approval', why: 'spec 没有可用的 startedAt ⇒ 证明不了这条批准是本轮给的（上一轮的批准不许免死）' });
      continue;
    }
    const at = Number(m.at);
    if (!Number.isFinite(at) || at <= startedAt) {
      fails.push({
        token: 'stale-approval',
        why: 'at=' + briefValue(m ? m.at : null) + ' 不晚于本轮 startedAt=' + startedAt
          + ' ⇒ 是上一轮（或更早）的批准，不许给这一轮免死',
      });
      continue;
    }
    if (!valueMatches(m.to, actualValue)) {
      fails.push({
        token: 'to-mismatch',
        why: 'to=' + briefValue(m.to) + ' 与产物实际=' + briefValue(actualValue) + ' 对不上'
          + ' ⇒ 批的不是"这样"',
      });
      continue;
    }
    return {
      approved: true,
      to: m.to,
      evidence,
      why: '；用户/上游给了带证据的变更申报（field=' + field + '，at=' + at + ' > startedAt=' + startedAt
        + '，evidence 非空，to 与产物一致）⇒ 这条差异是「经批准的变更」，不是偏差',
    };
  }
  const first = fails[0] || { token: 'no-usable-amendment', why: '没有任何一条变更申报能同时过四道前置' };
  /**
   * 另外还要说清"那些连字段都对不上的申报"：它们本来就不该被用来抵扣，
   * 但为什么不算 —— 必须留痕（否则审计时只能看到"批准没生效"，看不到"因为批的是别的字段"）。
   */
  const others = amendments.filter((m) => amendmentFieldName(m) !== field);
  const otherNote = others.length
    ? '；另有 ' + others.length + ' 条申报的 field=[' + others.map((m) => amendmentFieldName(m) || '(空)').join('、')
      + '] 与偏差字段「' + field + '」不同 ⇒ field-mismatch（跨科目报销，不能抵扣）'
    : '';
  return {
    approved: false,
    why: '；变更申报未通过前置：' + fails.map((f) => f.token).join('+') + '（' + first.why + '）⇒ 退回偏差' + otherNote,
  };
}

/**
 * 「偏差」与「经批准的变更」必须分开 —— 这是全仓**唯一**的契约对照判定点。
 *
 * 老板原话：「`diffContract` 必须区分「偏差」与「经批准的变更」。」
 *
 * 修之前只有一条笼统的"不一致"通道，两种后果都真实发生过：
 *   A 种：用户中途改了口（"只要 3 页"），收尾仍然报偏差 ⇒ 清单里混着用户自己改的需求 ⇒
 *        人开始不信这张清单 ⇒ **真偏差被淹没**（机制自己制造噪声，比不报更糟）。
 *   B 种：模型自己写一句"用户已批准"就能把真偏差洗成"已批准" ⇒ **偏差数被清零，而且看起来更绿**。
 *        这一种更坏：它把"有偏差"变成"没偏差"。
 * ⇒ 所以「经批准的变更」必须**带证据、且证据来自可核验的位置**，四条前置见 `judgeAmendment`。
 *
 * 字段范围**故意只留两个**：`slideCount` / `format` —— 只放"能从产物里量出来"的字段。
 * 加"字体/配色/第几页讲什么"这类量不出来的字段，只会造出"看起来在验、实际验不了"的假判据。
 *
 * 三态（**不许折叠**）：
 *   · `deviations` —— 真偏差（含"批准没过前置"的那些，`why` 里点名是哪一条没过）；
 *   · `approved`   —— 经批准的变更（**单独一桶**：并进 deviations 就等于把用户的决定报成模型的过错）；
 *   · `unverified` —— 拿不出可比项的原因。**`compared=false` 时结论一律是"未核验"，绝不是"一致"**；
 *     `deviations` 为空这件事本身**没有**任何正面含义：空 + `unverified` 非空 = 什么都没比。
 *
 * ⚠️ 返回值里**故意没有任何** `ok` / `consistent` / `match` 之类的布尔结论字段：
 *   那种字段一旦存在，"没比过"就会被下游默认读成"一致"（`[].every() === true` 的同一类病）。
 *   下游要判"过没过"，只能看 `deviations.length` **并且先看 `compared`**。
 *
 * @param {object} spec 规格侧：`{planned, format?, startedAt?, amendments?}`
 * @param {object|string[]} actual 产物侧：`{artifacts?, slideCount?, counts?, format?}` 或直接路径数组
 * @param {{format?:string}} [opts] 兜底的交付格式（生产侧来自 `cfg.deliverable.format`）
 * @returns {{compared:boolean, unverified:Array<object>, deviations:Array<object>,
 *            approved:Array<object>, summary:{deviated:number,approved:number,unverified:number,fields:number}}}
 */
function diffContract(spec, actual, opts) {
  const s = (spec && typeof spec === 'object' && !Array.isArray(spec)) ? spec : {};
  const o = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const a = (actual && typeof actual === 'object' && !Array.isArray(actual)) ? actual : {};
  const artifacts = artifactPathsOf(actual);

  const deviations = [];
  const approved = [];
  const unverified = [];
  /**
   * ★ `fields` 是**唯一**的"真的比过几个字段"口径，`compared` 只由它决定。
   *   为什么不许用"deviations 为空"替代：空既可能是"比过且一致"，也可能是"什么都没比"，
   *   这两种在返回值里必须长得不一样 —— 否则空清单永远绿。
   */
  let fields = 0;

  const planned = normalizePlanned(s.planned);
  const startedRaw = Number(s.startedAt);
  const startedAt = (Number.isFinite(startedRaw) && startedRaw > 0) ? startedRaw : null;
  const amendments = (Array.isArray(s.amendments) ? s.amendments : [])
    .filter((m) => m && typeof m === 'object' && !Array.isArray(m));

  // ── 字段 ①：slideCount —— spec 侧 = 用户要的页数，actual 侧 = 从产物里真解析出的页数
  const decks = collectDecks(actual);
  if (!planned) {
    unverified.push({
      field: 'slideCount',
      why: '未给出页数规格（spec.planned 缺失或认不出）⇒ 拿不出"用户当初要的"，不许据此报"无偏差"',
    });
  } else if (!decks.length) {
    unverified.push({
      field: 'slideCount',
      why: '没有可比对的产物页数（没有产物 / 解析不出页数 / 页数为 0）⇒ 页数这一点未核验',
    });
  } else {
    fields += 1;
    for (const d of decks) {
      const gap = countGap(planned, d.count);
      if (!gap) continue;
      const verdict = judgeAmendment({ field: 'slideCount', actualValue: d.count, amendments, startedAt });
      const where = d.path ? ('（产物：' + d.path + '）') : '';
      if (verdict.approved) {
        approved.push({
          field: 'slideCount', original: gap.expected, current: verdict.to, actual: d.count,
          kind: 'approved_change', evidence: verdict.evidence, why: gap.why + where + verdict.why,
        });
      } else {
        deviations.push({
          field: 'slideCount', expected: gap.expected, actual: d.count,
          kind: 'deviation', why: gap.why + where + verdict.why,
        });
      }
    }
  }

  // ── 字段 ②：format —— spec 侧固定 = 交付格式配置；actual 侧 = 产物扩展名
  /**
   * ★★ 2026-10-26【残余耦合修复 · 点 4】**删掉 `'pptx'` 缺省回落**。
   *
   * 修前：`… ? o.format : 'pptx'` —— 落到这里的 `'pptx'` 是一个**编出来的规格**：
   *   `general-v1` 的 `deliverable.format` 是空串（它没有唯一交付格式），
   *   `backend.contractRunSpec.format` 就传 `''`，于是 `s.format` 与 `o.format` 都空 ⇒ 回落 `'pptx'`
   *   ⇒ 一个 `.txt` 任务收尾时会产出**假偏差**「规格要求交付格式 pptx，实际产物是 txt」。
   *   实测（scripts/tmp-probe/_lead/coupling-fix/p4-format.mjs）：修前 deviated=1（format:ppt→txt），
   *   而用户从来没说过要 pptx —— 这条"偏差"是引擎自己造的，比不报更糟（真偏差会被它淹没）。
   *
   * 为什么今天没爆：`general-v1` 是 `lifecycle:'none'`，不进 `conclude`，这段跑不到；
   *   但产物契约（`buildExts`）一旦放开到非 PPT 工作流，它立刻可达。
   *
   * 改法：没有声明 ⇒ 空串。空串**不是**"一致"，走下面 `unverified` 分支
   *   （与 `evaluate()` 里 `formatMatches()` 的既有口径逐字对齐：
   *    「契约没有声明交付格式 ⇒ 格式无法比对（不许当成通过）」）。
   * ⚠️ PPT 不受影响：`pptx-v1.deliverable.format === 'pptx'` 是**显式声明**，走 `s.format` 那一支。
   */
  const specFmtRaw = (s.format !== undefined && s.format !== null && String(s.format).trim()) ? s.format
    : ((o.format !== undefined && o.format !== null && String(o.format).trim()) ? o.format : '');
  const specFormat = normalizeFormat(specFmtRaw);
  const actualFmtRaw = (a.format !== undefined && a.format !== null && String(a.format).trim())
    ? a.format : formatOfArtifacts(artifacts);
  const actualFormat = normalizeFormat(actualFmtRaw);
  if (!specFormat) {
    // ★ 顺序很重要：先判"规格侧有没有可比对象"。修前这一步不存在，于是空规格会掉进比对分支
    //   并与 actual 逐字比较（'' !== 'txt'）⇒ 造出一条假偏差。
    unverified.push({
      field: 'format',
      why: '契约没有声明交付格式（spec.format / opts.format 皆空）⇒ 格式无法比对（不许当成通过）',
    });
  } else if (!actualFormat) {
    unverified.push({
      field: 'format',
      why: '产物里看不出扩展名（actual 为空或文件名没有扩展名）⇒ 交付格式未核验',
    });
  } else {
    fields += 1;
    if (specFormat !== actualFormat) {
      const gapWhy = '规格要求交付格式 ' + (specFormat || '（空）') + '，实际产物是 ' + actualFormat;
      const verdict = judgeAmendment({ field: 'format', actualValue: actualFormat, amendments, startedAt });
      if (verdict.approved) {
        approved.push({
          field: 'format', original: specFormat, current: verdict.to, actual: actualFormat,
          kind: 'approved_change', evidence: verdict.evidence, why: gapWhy + verdict.why,
        });
      } else {
        deviations.push({
          field: 'format', expected: specFormat, actual: actualFormat,
          kind: 'deviation', why: gapWhy + verdict.why,
        });
      }
    }
  }

  return {
    compared: fields > 0,
    unverified,
    deviations,
    approved,
    summary: {
      deviated: deviations.length,
      approved: approved.length,
      unverified: unverified.length,
      fields,
    },
  };
}

/**
 * 把 `diffContract` 的结果压成**可落盘 / 可回传**的形状：键名固定、条数有上限、长文本截断。
 *
 * 为什么必须有界：跨请求状态文件有字节上限，而 `why` 是自然语言（可以很长）。
 * 「结论存不下」如果被静默吞掉，就变成"下次请求读不到结论"——
 * 那和"只有本次会话里有效"是同一件事，正是这一项要修的病。
 *
 * @param {object} contract `diffContract` 的返回
 * @param {number} [limit] 每个桶最多留几条（默认 20；截断后的条数不计入 summary，summary 是真实总账）
 * @returns {{contractCompared:boolean, deviations:Array<object>, deviationsApproved:Array<object>,
 *            deviationsUnverified:Array<object>,
 *            contractSummary:{deviated:number,approved:number,unverified:number,fields:number}}}
 */
function compactContract(contract, limit) {
  const c = (contract && typeof contract === 'object' && !Array.isArray(contract)) ? contract : {};
  const limitRaw = Number(limit);
  const cap = (Number.isFinite(limitRaw) && limitRaw > 0) ? Math.floor(limitRaw) : 20;
  const sum = (c.summary && typeof c.summary === 'object') ? c.summary : {};
  const cut = (v) => {
    const t = String(v === undefined || v === null ? '' : v);
    return t.length > 240 ? t.slice(0, 240) + '…' : t;
  };
  const keep = (v) => (v === undefined ? null : v);
  const devs = (Array.isArray(c.deviations) ? c.deviations : []).slice(0, cap).map((d) => ({
    field: String((d && d.field) || ''),
    expected: keep(d && d.expected),
    actual: keep(d && d.actual),
    kind: 'deviation',
    why: cut(d && d.why),
  }));
  const apps = (Array.isArray(c.approved) ? c.approved : []).slice(0, cap).map((x) => ({
    field: String((x && x.field) || ''),
    original: keep(x && x.original),
    current: keep(x && x.current),
    actual: keep(x && x.actual),
    kind: 'approved_change',
    evidence: cut(x && x.evidence),
    why: cut(x && x.why),
  }));
  const unv = (Array.isArray(c.unverified) ? c.unverified : []).slice(0, cap).map((u) => ({
    field: String((u && u.field) || ''),
    why: cut(u && u.why),
  }));
  return {
    contractCompared: c.compared === true,
    deviations: devs,
    deviationsApproved: apps,
    deviationsUnverified: unv,
    contractSummary: {
      deviated: Number(sum.deviated) || 0,
      approved: Number(sum.approved) || 0,
      unverified: Number(sum.unverified) || 0,
      fields: Number(sum.fields) || 0,
    },
  };
}

/**
 * 交付文本里的「契约偏差」小节（路线文档的判据：**交付文本必须含这一节**）。
 *
 * 为什么不能只把结论留在返回值里：用户看到的只有交付文本。偏差清单只活在后端，
 * 用户就分不清"哪一条是模型没做到"与"哪一条是你自己改的口" —— 而这正是本项要分开的两种东西。
 *
 * 没有任何契约结论时返回 `''`（老调用方 / 老门禁的文本逐字不变）。
 *
 * @param {object} evaluation 结论对象（`diffContract` 结果被 `compactContract` 摊平后的形状）
 * @returns {string} 以换行开头的小节；无契约结论时为空串
 */
function describeContract(evaluation) {
  const e = evaluation || {};
  const dev = Array.isArray(e.deviations) ? e.deviations : null;
  const app = Array.isArray(e.deviationsApproved) ? e.deviationsApproved : null;
  const unv = Array.isArray(e.deviationsUnverified) ? e.deviationsUnverified : null;
  if (!dev && !app && !unv && e.contractCompared === undefined) return '';
  const sum = (e.contractSummary && typeof e.contractSummary === 'object') ? e.contractSummary : {};
  const fields = Number(sum.fields) || 0;
  const show = (v) => {
    if (v === undefined || v === null) return '—';
    if (typeof v === 'object') {
      if (v.mode === 'range') return v.min + '-' + v.max + ' 页';
      if (v.mode === 'exact') return '恰好 ' + v.count + ' 页';
      return briefValue(v);
    }
    return String(v);
  };
  const lines = [];
  if (e.contractCompared === true) {
    lines.push((dev && dev.length)
      ? '发现 ' + dev.length + ' 项偏差（已对照 ' + fields + ' 个字段）'
      : '已对照 ' + fields + ' 个字段，未发现偏差');
  } else {
    lines.push('未核验（拿不出可比项 ⇒ 不把"没比"写成"一致"）');
  }
  for (const d of (dev || [])) {
    lines.push('· 偏差 ' + d.field + '：期望 ' + show(d.expected) + '，实际 ' + show(d.actual)
      + (d.why ? '（' + d.why + '）' : ''));
  }
  for (const x of (app || [])) {
    lines.push('· 经批准的变更 ' + x.field + '：原规格 ' + show(x.original) + ' → 现规格 ' + show(x.current)
      + '（产物实际 ' + show(x.actual) + (x.evidence ? '，证据：' + x.evidence : '') + '）');
  }
  for (const u of (unv || [])) {
    lines.push('· 未核验 ' + u.field + '：' + u.why);
  }
  const head = lines.shift();
  return '\n契约偏差：' + head + lines.map((l) => '\n  ' + l).join('');
}

// ───────────────────────────────────────────────────────────────────────────
// 五、跨请求恢复的纯判据（planRecovery / stageEvidence）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 这一节回答第四个问题：**上次做到哪一步、上次的账还算不算数？**
 *
 * 老板的原话：「纯函数能够正确计算恢复方案，不等于 Agent 已经具备真正的跨请求恢复能力。」
 * 所以这里的纯函数只做**判据**，不碰磁盘：磁盘证据由 workflowState.collectEvidence 收集后从 `ev` 传进来。
 * 本节的函数**一个 fs 调用都不许有** —— 这是能被门禁钉住的性质（见 W13）。
 *
 * 恢复算法三句话（顺序不能换）：
 *   ① **先物理截断成前缀闭包**：`completedStages ∪ waivedStages` 必须是 `cfg.stages` 的前缀。
 *      第一个既不在 completed 也不在 waived 的阶段就是 gap；gap 之后的记录一律作废。
 *      这一条自动抓住脏状态：deliver 在 completed 里而 validate 不在 ⇒ gap=validate ⇒ deliver 作废。
 *   ② **再逐阶段验证据**：从 gap 往回逐个查判据表；证据站不住的阶段把 gap 往回拉。
 *   ③ **最后认领产物**：磁盘上有且仅有 1 份合法 pptx、但状态里没记 build ⇒ 只补 build 的账，
 *      不重新生成整份 PPT（`adopted-artifact`）。
 *
 * ⚠️ 为什么必须**先截断**再返回 resume 点：`markStage` 的跳步判据依赖 `maxDone`（见上）。
 *   只算「从哪继续」而不截断，后续 `step('build')` 会因为 `maxDone` 仍停在 deliver 而被判
 *   「补标记已完成的」静默通过 —— 脏状态就被洗白了。
 */

/** 恢复过程中产生的事实标签（写进 recoverLog.notes，便于事后审计） */
const RECOVERY_NOTES = {
  stateMissing: 'state-missing',
  stateCorrupt: 'state-corrupt',
  prefixTruncated: 'prefix-truncated',
  evidenceTruncated: 'evidence-truncated',
  adoptedArtifact: 'adopted-artifact',
  notVerifiable: 'not-verifiable',
  attachmentsChanged: 'attachments-changed',
  issueStale: 'issue-stale',
};

/**
 * 已完成 / 已豁免阶段的最大下标（-1 = 一个都还没做）。
 * ★ markStage 与 waiveStage 原来各抄了一份这个计算，这里是**唯一**的那一份。
 */
function maxDoneIndex(run, cfg) {
  const stages = (cfg && Array.isArray(cfg.stages)) ? cfg.stages : [];
  const r = run || {};
  const names = (Array.isArray(r.completedStages) ? r.completedStages : [])
    .concat((Array.isArray(r.waivedStages) ? r.waivedStages : []).map((w) => w && w.stage));
  const idx = names.map((s) => stages.indexOf(s)).filter((i) => i >= 0);
  return idx.length ? Math.max(...idx) : -1;
}

/** completed ∪ waived 的阶段名（去重保序：先 completed，再 waived） */
function doneStageNames(run) {
  const r = run || {};
  const completed = Array.isArray(r.completedStages) ? r.completedStages : [];
  const waived = Array.isArray(r.waivedStages) ? r.waivedStages.map((w) => w && w.stage) : [];
  return completed.concat(waived).filter((s) => typeof s === 'string' && s);
}

/**
 * 前缀不变量：第一个「既不在 completed 也不在 waived」的阶段下标。
 * 全部都在 ⇒ 返回 stages.length（表示没有缺口）。
 *
 * ★ 这一条是「不能跳过未完成的验收」的统一抓法（不需要给每个阶段写特判）：
 *   `{completed:[…,'build','final_validate','deliver'], 无 validate}` ⇒ gap=validate
 *   ⇒ final_validate / deliver 作废，resume=validate。
 */
function firstGapIndex(run, cfg) {
  const stages = (cfg && Array.isArray(cfg.stages)) ? cfg.stages : [];
  const done = new Set(doneStageNames(run).filter((s) => stages.includes(s)));
  for (let i = 0; i < stages.length; i += 1) {
    if (!done.has(stages[i])) return i;
  }
  return stages.length;
}

/** 把调用方传来的证据包成统一形状（缺项一律给"不成立"的安全默认值，绝不假设成立）。 */
function normalizeEvidence(ev) {
  const e = ev || {};
  return {
    candidateDecks: Array.isArray(e.candidateDecks)
      ? e.candidateDecks.filter((x) => x && typeof x.path === 'string' && x.path)
      : [],
    exists: typeof e.exists === 'function' ? e.exists : () => false,
    sizeOf: typeof e.sizeOf === 'function' ? e.sizeOf : () => 0,
    inspect: typeof e.inspect === 'function' ? e.inspect : () => ({ openable: false, slideCount: 0, duplicateGroups: [] }),
    fingerprintOf: typeof e.fingerprintOf === 'function' ? e.fingerprintOf : () => null,
    verify: typeof e.verify === 'function' ? e.verify : null,
    attachmentsChanged: e.attachmentsChanged === true,
    planned: e.planned || null,
    rendered: e.rendered === true,
    rendererAvailable: e.rendererAvailable === true,
    notes: Array.isArray(e.notes) ? e.notes.slice() : [],
  };
}

/** 安全地跑一次 pptx 真解析（解析器抛错 ⇒ 当成"打不开"，不当成"通过"） */
function inspectDeckSafe(p, ev) {
  try {
    const info = ev.inspect(p) || {};
    return {
      openable: info.openable === true,
      slideCount: Number(info.slideCount) || 0,
      duplicateGroups: Array.isArray(info.duplicateGroups) ? info.duplicateGroups : [],
      error: String(info.error || ''),
    };
  } catch (e) {
    return { openable: false, slideCount: 0, duplicateGroups: [], error: String((e && e.message) || e) };
  }
}

/**
 * 该拿哪些路径当「本次运行的产物」：
 *   状态里记了本工作流产物类型的路径 ⇒ **只信记录的**（记录被删就说明产物没了，这正是要抓的形态）；
 *   状态里一条都没有 ⇒ 才退回磁盘候选（供产物认领使用）。
 *
 * ★ 2026-10-26 从 `pptxPathsOf` 改名并**去掉 `.pptx` 字面量**：产物类型由 `cfg.buildExts` 声明，
 *   这是「算不算产物」的唯一来源。未声明 ⇒ **一个都不算**（不回落 .pptx）：
 *   回落会把通用执行入口重新绑死到 PPT —— 那正是本阶段要拆掉的耦合。
 *
 * ★★ 命名的坑（踩过一次，必须记住）：本文件里**已经**有一个 `artifactPathsOf(actual)`
 *   （@:793，契约对照用：从 `actual.artifacts` 去重取路径，与本函数毫无关系）。
 *   第一版改名就叫了 `artifactPathsOf` ⇒ 函数声明提升让**后一个覆盖前一个**，
 *   `diffContract` 于是拿着 `actual` 当 `run`、`cfg` 为 undefined 调进来，恒定返回 `[]`
 *   ⇒ 契约对照的 format 维度永远"看不出扩展名" ⇒ `unit-contract-diff` A-3/A'-2/D2-* /E-4/H-5
 *   七条齐红。这类撞名**不会**报错，只会静默改变语义，所以本函数名必须与它区分开。
 * @param {object} run
 * @param {object} cfg
 * @param {object} ev 归一后的证据
 * @returns {string[]}
 */
function runArtifactPaths(run, cfg, ev) {
  const r = run || {};
  const exts = artifactExtsOf(cfg);
  if (!exts.length) return [];
  const recorded = (Array.isArray(r.artifacts) ? r.artifacts : [])
    .filter((p) => typeof p === 'string' && matchesExt(p, exts));
  if (recorded.length) return recorded;
  return (ev.candidateDecks || []).map((x) => x.path).filter((p) => matchesExt(p, exts));
}

/**
 * 一份产物的「证据强度」：
 *   · 必须存在且非空（任何类型）；
 *   · **pptx 额外要求真解析通过**（openable + slideCount>0）—— 这条是 PPT 工作流的既有纪律，
 *     不能因为"通用化"就放松："文件存在"从来不等于"演示文稿能打开"。
 *   · 其它类型本引擎**不解它的格式**（那是该工作流自己的检查项的事），证据只到"文件在、非空"。
 * @param {string} p
 * @param {object} ev
 * @returns {{ok:boolean, why:string, size:number, exists:boolean, openable:boolean, slideCount:number}}
 */
function artifactEvidenceSafe(p, ev) {
  const out = { ok: false, why: '', size: Number(ev.sizeOf(p)) || 0, exists: !!ev.exists(p), openable: false, slideCount: 0 };
  if (!out.exists) { out.why = '文件不存在'; return out; }
  if (!(out.size > 0)) { out.why = '0 字节'; return out; }
  if (extOf(p) === '.pptx') {
    const info = inspectDeckSafe(p, ev);
    out.openable = info.openable;
    out.slideCount = info.slideCount;
    if (!info.openable) { out.why = '结构坏，打不开（' + (info.error || 'openable=false') + '）'; return out; }
    if (!(info.slideCount > 0)) { out.why = '0 页'; return out; }
  } else {
    out.openable = true;      // 非 pptx：格式由工作流自己的检查项负责，这里不冒充验过
  }
  out.ok = true;
  return out;
}

/** 指纹比对（size / mtimeMs / slideCount 任一项不一致 ⇒ 文件被换过或被改过） */
function fingerprintProblems(run, ev, paths) {
  const r = run || {};
  const fpMap = (r.artifactFingerprint && typeof r.artifactFingerprint === 'object') ? r.artifactFingerprint : {};
  const problems = [];
  for (const p of paths) {
    const want = fpMap[p];
    if (!want || typeof want !== 'object') { problems.push(p + '：没有指纹记录（无法复核 ⇒ 不许当已验收）'); continue; }
    const now = ev.fingerprintOf(p);
    if (!now) { problems.push(p + '：读不到当前指纹'); continue; }
    if (Number(want.size) !== Number(now.size)) problems.push(p + '：size 变了（' + want.size + ' → ' + now.size + '）');
    if (Number(want.mtimeMs) !== Number(now.mtimeMs)) problems.push(p + '：mtimeMs 变了（' + want.mtimeMs + ' → ' + now.mtimeMs + '）');
    if (want.slideCount !== undefined && Number(want.slideCount) !== Number(now.slideCount)) {
      problems.push(p + '：页数变了（' + want.slideCount + ' → ' + now.slideCount + '）');
    }
  }
  return problems;
}

/** validate 的判据：无独立文件 ⇒ **重算**（对当前产物重新取证 + 比对指纹） */
function validateEvidence(run, cfg, ev) {
  const paths = runArtifactPaths(run, cfg, ev);
  if (!paths.length) {
    const exts = artifactExtsOf(cfg);
    return { ok: false, kind: 'derived', why: '没有可比对的产物（本工作流产物类型：' + (exts.join('/') || '未声明') + '）⇒ 无法复核 validate' };
  }
  const missing = paths.filter((p) => !ev.exists(p));
  if (missing.length) return { ok: false, kind: 'derived', why: '产物已不在磁盘：' + missing.join('、') };
  const problems = fingerprintProblems(run, ev, paths);
  if (problems.length) return { ok: false, kind: 'derived', why: problems.join('；') };
  for (const p of paths) {
    const one = artifactEvidenceSafe(p, ev);
    if (!one.ok) return { ok: false, kind: 'derived', why: p + '：重算取证不通过（' + one.why + '）' };
  }
  return { ok: true, kind: 'derived', why: '重算通过：指纹一致（size/mtimeMs/slideCount）且重新取证可打开/非空' };
}

/**
 * final_validate 的判据：无独立文件 ⇒ 由「前序全有效 + 一次 evaluate」重算。
 *
 * ⚠️ 这里有一处必须解释的取舍：`evaluate()` 的 `final_status_matches_validation` 是拿
 *   `run.completedStages` 反推 missingStages 的。恢复过程中阶段完成度**正由本函数的前缀截断决定**，
 *   若再让 evaluate 反推一遍就成了自指（永远红 / 永远绿都说不清）。所以：
 *   把阶段完成度"补齐成满"喂给 evaluate，只让它回答「验收项（页数/可打开/重复页/格式）过不过」；
 *   阶段到底完成没有，由「前缀 + 逐阶段证据」负责。这条分工写在这里，免得后人以为是 bug。
 */
function finalValidateEvidence(run, cfg, ev) {
  const paths = runArtifactPaths(run, cfg, ev);
  if (!paths.length) {
    const exts = artifactExtsOf(cfg);
    return { ok: false, kind: 'derived', why: '没有产物可比对（本工作流产物类型：' + (exts.join('/') || '未声明') + '）⇒ 无法复验' };
  }
  const missing = paths.filter((p) => !ev.exists(p));
  if (missing.length) return { ok: false, kind: 'derived', why: '产物缺失：' + missing.join('、') };
  const problems = fingerprintProblems(run, ev, paths);
  if (problems.length) return { ok: false, kind: 'derived', why: '指纹不一致：' + problems.join('；') };
  const synthetic = { ...run, completedStages: ((cfg && cfg.stages) || []).slice() };
  const planned = ev.planned || (run && run.spec && run.spec.slideCount) || null;
  const e = evaluate(synthetic, cfg, {
    artifacts: paths,
    planned,
    rendered: ev.rendered,
    rendererAvailable: ev.rendererAvailable,
    inspector: (p) => inspectDeckSafe(p, ev),
  });
  // ★ 自指的终态一致性检查由**契约**声明（`terminal: true`），这里不再写具体 id：
  //   通用文件里出现某个工作流的 check id，换一套工作流就失效（见 terminalCheckIds 头注）。
  const terminalIds = terminalCheckIds(cfg);
  const fails = (e.failedChecks || []).filter((f) => terminalIds.indexOf(f.id) < 0);
  if (fails.length) {
    return { ok: false, kind: 'derived', why: '复验未过：' + fails.map((f) => f.id + (f.why ? '（' + f.why + '）' : '')).join('；') };
  }
  if ((e.configErrors || []).length) {
    return { ok: false, kind: 'derived', why: '复验无法判定（契约配置错误）：' + e.configErrors.map((f) => f.id).join('、') };
  }
  return { ok: true, kind: 'derived', why: '重跑 evaluate 无 must 失败项' };
}

/**
 * deliver 的判据：交付物都能验证到 + **本工作流在 deliver 之前要求的阶段必须都过去了**。
 *
 * ★ 2026-10-26：前置阶段原来写死成 `['validate','final_validate']` —— 那是 PPT 的 9 阶段序列。
 *   一个只有 `brief/asset_inventory/build/deliver` 的工作流接了进来，deliver 就**永远**判无效
 *   （它的账上根本不会有 validate 这个名字），恢复时 deliver 被作废、`prefix-truncated` 随之出现。
 *   现在改成「`cfg.stages` 里排在 deliver 之前、且属于 `requiredStages` 的那些阶段」——
 *   语义完全一样（"没验过不算交付过"），但不再假设任何一套具体阶段名。
 * @param {object} run
 * @param {object} cfg
 * @param {object} ev
 * @returns {{ok:boolean, kind:string, why:string}}
 */
function deliverEvidence(run, cfg, ev) {
  const r = run || {};
  const stages = (cfg && Array.isArray(cfg.stages)) ? cfg.stages : [];
  const required = (cfg && Array.isArray(cfg.requiredStages)) ? cfg.requiredStages : [];
  const arts = (Array.isArray(r.artifacts) ? r.artifacts : []).filter((p) => typeof p === 'string' && p);
  if (!arts.length) return { ok: false, kind: 'derived', why: '状态里没有 artifacts（交付清单为空）' };
  const done = new Set(doneStageNames(r));
  const cut = stages.indexOf('deliver');
  const before = (cut < 0 ? stages.slice() : stages.slice(0, cut)).filter((s) => required.indexOf(s) >= 0);
  const missingPrereq = before.filter((s) => !done.has(s));
  if (missingPrereq.length) {
    return { ok: false, kind: 'derived', why: '前置验收缺失：' + missingPrereq.join('、') + '（没验过不算交付过）' };
  }
  let v = null;
  if (ev.verify) {
    try { v = ev.verify(arts); } catch (e) { v = null; }
  }
  if (!v) {
    const missing = arts.filter((p) => !ev.exists(p));
    v = { ok: missing.length === 0, missing, unreadable: [], empty: [], oversized: [] };
  }
  if (v.ok) return { ok: true, kind: 'derived', why: arts.length + ' 份交付物都能验证到' };
  const bad = [].concat(v.missing || [], v.unreadable || [], v.empty || [], v.oversized || []);
  return { ok: false, kind: 'derived', why: '交付物验证失败：' + (bad.join('、') || '未知原因') };
}

/**
 * 单阶段证据判定（判据表见 scripts/tmp-probe/_lead/workflow-persist/plan.md §3）。
 * 返回 { ok, kind, why }：ok=false 表示「这个阶段的账站不住，必须作废」。
 *
 * 注意每条判据的诚实边界：
 *   · brief：磁盘无物可查 ⇒ **不可复核** ⇒ 维持原状（绝不因为"查不到"就删账）；
 *   · asset_inventory：素材被用户删掉是常态 ⇒ 只记 note，不作废；
 *   · render：本机无渲染器 ⇒ 只可能是豁免；若记成 completed 却拿不出 renderArtifacts ⇒ 作废；
 *   · repair：openIssues 全 closed（或为空）才算数；**前置 validate 有效**由回溯顺序天然保证。
 */
function stageEvidence(stage, run, cfg, evIn) {
  const ev = normalizeEvidence(evIn);
  const r = run || {};
  if (!cfg || !Array.isArray(cfg.stages) || !cfg.stages.includes(stage)) {
    return { ok: true, kind: 'unknown', why: '判据表里没有这个阶段，不做推断（维持原状）' };
  }
  if (stage === 'brief') {
    const req = (Array.isArray(r.requests) ? r.requests : [])[0];
    if (req && Number(req.textLen) > 0) {
      return { ok: true, kind: 'none', why: 'requests[0] 记录了本请求（textLen=' + Number(req.textLen) + '）' };
    }
    return { ok: true, kind: 'none', why: '磁盘上无物可查 ⇒ 不可复核，维持原状', note: RECOVERY_NOTES.notVerifiable };
  }
  if (stage === 'outline') {
    const specOk = !!(r.spec && r.spec.slideCount);
    const idOk = r.workflowId === cfg.workflowId;
    const verOk = Number(r.version) === Number(cfg.version);
    if (specOk && idOk && verOk) {
      return { ok: true, kind: 'meta', why: 'spec.slideCount 存在，且 workflowId/version 与当前配置一致' };
    }
    let why = '';
    if (!specOk) why = '没有 spec.slideCount（页数规格未固化）';
    else if (!idOk) why = 'workflowId「' + r.workflowId + '」与当前配置「' + cfg.workflowId + '」不一致';
    else why = 'version ' + r.version + ' ≠ 配置 ' + cfg.version + '（验收标准已变 ⇒ 必须重做）';
    return { ok: false, kind: 'meta', why };
  }
  if (stage === 'asset_inventory') {
    if (ev.attachmentsChanged) {
      return { ok: false, kind: 'files', why: '本请求的附件清单与记录不同 ⇒ 素材盘点必须重做' };
    }
    const notes = [];
    for (const a of (Array.isArray(r.attachments) ? r.attachments : [])) {
      const p = a && a.path;
      if (!p) continue;
      if (!ev.exists(p)) notes.push('素材已不在磁盘：' + p + '（用户删素材是常态，不作废）');
    }
    return { ok: true, kind: 'files', why: notes.length ? notes.join('；') : '素材清单无变化', notes };
  }
  /**
   * ★ 产物阶段由**契约**声明（`cfg.buildStage`），不是字面量 `'build'`：
   *   `build` 只是一个阶段名，它本身不表示"这是 PPT 任务"。判"产物阶段的账还站不站得住"，
   *   必须问"本工作流把哪个阶段叫产物阶段"。
   *   产物类型同样由契约给出（`cfg.buildExts`），pptx 只走额外的"真解析"分支 ——
   *   **没有全局回落**：未声明产物类型 ⇒ 一份都不认（不许默认 .pptx）。
   */
  const buildStageName = (cfg && typeof cfg.buildStage === 'string' && cfg.buildStage) ? cfg.buildStage : '';
  if (buildStageName && stage === buildStageName) {
    const exts = artifactExtsOf(cfg);
    const paths = runArtifactPaths(r, cfg, ev);
    if (!paths.length) {
      return {
        ok: false, kind: 'artifact',
        why: '状态里没有任何 ' + (exts.join('/') || '(未声明产物类型)') + ' 产物路径（账上没有产物）',
      };
    }
    const bad = [];
    let good = 0;
    const reports = [];
    for (const p of paths) {
      const one = artifactEvidenceSafe(p, ev);
      const rep = { path: p, exists: one.exists, size: one.size, slideCount: one.slideCount, openable: one.openable };
      reports.push(rep);
      if (!one.ok) { bad.push(p + '：' + one.why); continue; }
      good += 1;
    }
    if (good > 0) {
      const isDeck = extOf(paths[0]) === '.pptx';
      return {
        ok: true, kind: 'artifact',
        why: good + ' 份产物证据成立（' + (isDeck ? 'pptx 真解析通过：openable + slideCount>0' : extOf(paths[0]) + ' 存在且非空') + '）',
        reports,
      };
    }
    return { ok: false, kind: 'artifact', why: bad.join('；'), reports };
  }
  if (stage === 'render') {
    const waived = (Array.isArray(r.waivedStages) ? r.waivedStages : []).filter((w) => w && w.stage === 'render');
    const inCompleted = (Array.isArray(r.completedStages) ? r.completedStages : []).includes('render');
    if (waived.length) {
      const why = String(waived[0].reason || '').trim();
      if (why) return { ok: true, kind: 'waived-only', why: '有豁免记录且理由非空：' + why };
      return { ok: false, kind: 'waived-only', why: 'render 的豁免记录没有理由（等于静默跳过）' };
    }
    if (inCompleted) {
      const arts = (Array.isArray(r.renderArtifacts) ? r.renderArtifacts : []).filter((p) => typeof p === 'string' && p);
      if (!arts.length) {
        return { ok: false, kind: 'derived', why: '记了「渲染完成」却没有任何 renderArtifacts（本机无渲染器 ⇒ 视为无效，回退 render）' };
      }
      const missing = arts.filter((p) => !ev.exists(p));
      if (missing.length) return { ok: false, kind: 'derived', why: '渲染产物缺失：' + missing.join('、') };
      return { ok: true, kind: 'derived', why: 'renderArtifacts 逐个存在' };
    }
    return { ok: false, kind: 'files', why: 'render 既没有豁免记录也没有产物（无渲染器时应当显式豁免）' };
  }
  if (stage === 'validate') return validateEvidence(r, cfg, ev);
  if (stage === 'repair') {
    const issues = (Array.isArray(r.openIssues) ? r.openIssues : []).filter((x) => x && x.issue_id);
    if (!issues.length) return { ok: true, kind: 'none', why: '没有未解决问题（本阶段本应豁免 / 无可执行动作）' };
    const openOnes = issues.filter((x) => x.status !== 'closed');
    if (openOnes.length) {
      return { ok: false, kind: 'none', why: '仍有 ' + openOnes.length + ' 条 openIssues 未关闭：' + openOnes.map((x) => x.issue_id).join('、') };
    }
    return { ok: true, kind: 'none', why: 'openIssues 全部 closed' };
  }
  if (stage === 'final_validate') return finalValidateEvidence(r, cfg, ev);
  if (stage === 'deliver') return deliverEvidence(r, cfg, ev);
  return { ok: true, kind: 'unknown', why: '判据表未覆盖该阶段，不做推断（维持原状）' };
}

/**
 * 从 gap 往回逐阶段验证据，返回新的 gap。
 *
 * ★ 与 plan §1.2 伪代码的一处**有意修正**：伪代码写的是「第一个 ok 就 break」，那是错的。
 *   产物一旦缺失，失效是**级联**的（build 的 pptx 被删 ⇒ validate 的指纹没了、final_validate 复验不过、
 *   deliver 的交付物验证不过），从后往前扫时最靠后的 repair（openIssues 为空）会先返回 ok 而提前 break，
 *   gap 就停在 repair —— 那等于"文件没了但只重做修复"，比不恢复更糟。
 *   所以这里取**最小的失效下标**（扫完整个前缀，不 break）：gap = min{ i | evidence(i) 不成立 }。
 */
function verifyBackwards(run, cfg, ev, startGap) {
  const stages = (cfg && Array.isArray(cfg.stages)) ? cfg.stages : [];
  let gap = Math.max(0, Math.min(Number(startGap) || 0, stages.length));
  const trail = [];
  for (let i = gap - 1; i >= 0; i -= 1) {
    const v = stageEvidence(stages[i], run, cfg, ev);
    trail.push({ stage: stages[i], ok: v.ok === true, why: v.why || '' });
    if (!v.ok) gap = i;
  }
  return { gap, trail };
}

/**
 * 产物认领：「磁盘上有、状态里没记」⇒ 只补 build 的账，不重新生成整份 PPT。
 *
 * 只在 gap **正好等于 build 下标**时成立 —— 也就是"build 之前的阶段都站得住、只缺 build 这一笔账"。
 * 若 gap 更靠前（比如 brief 都没验过），凭一份磁盘上的 pptx 就跳到 render 会跳过前面的阶段。
 * 候选 ≥2 份 ⇒ 不认领（不知道该信哪份，宁可重做）。
 */
function adoptArtifact(run, cfg, ev, gap) {
  const stages = (cfg && Array.isArray(cfg.stages)) ? cfg.stages : [];
  const buildStageName = (cfg && typeof cfg.buildStage === 'string' && cfg.buildStage) ? cfg.buildStage : '';
  const buildIdx = buildStageName ? stages.indexOf(buildStageName) : -1;
  if (buildIdx < 0) return { gap, adopted: '', why: '' };
  if (gap !== buildIdx) return { gap, adopted: '', why: '' };
  // ★ 产物类型由契约声明（唯一来源 buildExts）；未声明 ⇒ 没有候选可谈（不回落 .pptx）
  const exts = artifactExtsOf(cfg);
  const cands = exts.length
    ? (ev.candidateDecks || []).filter((c) => c && typeof c.path === 'string' && matchesExt(c.path, exts))
    : [];
  if (cands.length !== 1) {
    /**
     * ★ 2026-10-23：候选为 0 时原来返回 `why: ''` —— 那是**静默跳过**：
     *   恢复方案里 gap 停在 build、`plan.adopted` 为空、`plan.adoptWhy` 也是空，
     *   事后只能看到"没认领"，看不到"为什么没认领"。老板要的"未完成不许误报成功"的背面
     *   同样成立：**没做到的事不许静默**。所以这里必须说清候选来源的状态。
     *
     * ★ 2026-10-26【点 3】文案随判据一起订正（原文案会把排障的人往两个死方向引）：
     *   · 原文案写「状态里没记 artifacts」—— `collectEvidence` 的候选**从不读** `run.artifacts`
     *     （登记表由 `conclude()` 之后落盘，只喂 `stageEvidence('build')`）⇒ 记了也不影响认领；
     *   · 原文案写「工作区扫描没命中」—— 认领路径（gap === buildIdx）下 `completedStages`
     *     不含 build ⇒ ③ 按契约根本不会跑 ⇒ 不该在这里出现。
     *   认领候选**只有一个来源**：本任务 trace 里可解析的 `file-write`。
     */
    const label = exts.join('/') || '(本工作流未声明产物类型)';
    const why = cands.length
      ? '磁盘上有 ' + cands.length + ' 份 ' + label + ' 候选，不知道信哪份 ⇒ 不认领，回退 build'
      : '磁盘上没有任何 ' + label + ' 候选（trace 里没有可解析的 file-write 产物指向它；'
        + '本任务尚未完成「' + (buildStageName || 'build') + '」⇒ 按契约不做工作区扫描）⇒ 不认领，回退 build';
    return { gap, adopted: '', why };
  }
  const p = cands[0].path;
  const one = artifactEvidenceSafe(p, ev);
  if (!one.exists) return { gap, adopted: '', why: '候选产物读不到' };
  if (!(one.size > 0)) return { gap, adopted: '', why: '候选产物是 0 字节' };
  if (!one.ok) {
    return { gap, adopted: '', why: '候选产物不成立（' + one.why + '）' };
  }
  return {
    gap: buildIdx + 1,
    adopted: p,
    why: extOf(p) === '.pptx'
      ? '磁盘上有且仅有 1 份合法 pptx（' + one.slideCount + ' 页）⇒ 只补 build 的账，不重新生成'
      : '磁盘上有且仅有 1 份 ' + extOf(p) + ' 产物（存在且非空）⇒ 只补 build 的账，不重新生成',
  };
}

/**
 * 被作废阶段上的 openIssues 标 stale（**不 close**）。
 * 为什么不 close：`closeIssue` 要求复验证据（见上），恢复时并没有复验过。
 * 标 stale 的语义是「这条问题的对象已经不存在了，别拿它当已修复」。
 */
function markStale(openIssues, invalidated) {
  const list = Array.isArray(openIssues) ? openIssues : [];
  const bad = new Set((Array.isArray(invalidated) ? invalidated : []).filter(Boolean));
  if (!bad.size) return list.slice();
  return list.map((x) => {
    if (!x || !x.stage || !bad.has(x.stage)) return x;
    return { ...x, stale: true, staleReason: '恢复时该阶段（' + x.stage + '）的证据已失效 ⇒ 这条问题不能当作已修复' };
  });
}

/**
 * 恢复方案（**纯函数**：只读入参，不碰 fs）。
 *
 * @param {{completedStages?:string[],waivedStages?:Array,openIssues?:Array,artifacts?:string[],artifactFingerprint?:object,spec?:object,requests?:Array,version?:number,workflowId?:string}} run
 * @param {object} cfg 工作流配置（pptx-v1）
 * @param {{candidateDecks?:Array,exists?:Function,sizeOf?:Function,inspect?:Function,fingerprintOf?:Function,verify?:Function,attachmentsChanged?:boolean,planned?:object,rendered?:boolean,rendererAvailable?:boolean}} ev
 * @returns {{resumeStage:string,gap:number,firstGap:number,completedStages:string[],waivedStages:Array,invalidated:string[],adopted:string,openIssues:Array,notes:string[],evidence:Array,changed:boolean}}
 */
function planRecovery(run, cfg, evIn) {
  const stages = (cfg && Array.isArray(cfg.stages)) ? cfg.stages : [];
  const r = run || {};
  const ev = normalizeEvidence(evIn);
  const notes = [];

  // ① 前缀不变量：第一个缺口
  const firstGap = firstGapIndex(r, cfg);

  // ② 逐阶段验证据（取最小失效下标，见 verifyBackwards 的说明）
  const vb = verifyBackwards(r, cfg, ev, firstGap);
  let gap = vb.gap;
  if (gap < firstGap) notes.push(RECOVERY_NOTES.evidenceTruncated);

  // ③ 产物认领
  const claim = adoptArtifact(r, cfg, ev, gap);
  if (claim.adopted) {
    gap = claim.gap;
    notes.push(RECOVERY_NOTES.adoptedArtifact);
  }

  // ④ 物理截断成前缀闭包（**先截断**，再谈从哪继续）
  const prefix = stages.slice(0, gap);
  const waivedAll = (Array.isArray(r.waivedStages) ? r.waivedStages : []).filter((w) => w && w.stage);
  const waivedSet = new Set(waivedAll.map((w) => w.stage));
  const completedStages = prefix.filter((s) => !waivedSet.has(s));
  // 豁免与完成**互斥**：同一阶段不得同时出现在两边（豁免不是打勾）
  const waivedStages = waivedAll
    .filter((w) => prefix.includes(w.stage) && !completedStages.includes(w.stage))
    .map((w) => ({ stage: w.stage, reason: String(w.reason || '') }));

  const recordedNames = doneStageNames(r).filter((s) => stages.includes(s));
  const invalidated = recordedNames.filter((s) => !prefix.includes(s));
  if (invalidated.length && !notes.includes(RECOVERY_NOTES.prefixTruncated)) {
    notes.push(RECOVERY_NOTES.prefixTruncated);
  }

  const openIssues = markStale(r.openIssues, invalidated);
  const staleCount = openIssues.filter((x, i) => {
    const before = (Array.isArray(r.openIssues) ? r.openIssues : [])[i];
    return x && x.stale === true && (!before || before.stale !== true);
  }).length;
  if (staleCount) notes.push(RECOVERY_NOTES.issueStale);

  const resumeStage = gap < stages.length ? stages[gap] : 'conclude';
  const completedBefore = Array.isArray(r.completedStages) ? r.completedStages : [];
  const changed = completedStages.join('\u0000') !== completedBefore.join('\u0000')
    || waivedStages.length !== waivedAll.length
    || !!claim.adopted;

  return {
    resumeStage,
    gap,
    firstGap,
    completedStages,
    waivedStages,
    invalidated,
    adopted: claim.adopted || '',
    adoptWhy: claim.why || '',
    openIssues,
    notes,
    evidence: vb.trail,
    changed,
  };
}

module.exports = {
  detectWorkflow,
  parseSlideCount,
  createRun,
  markStage,
  waiveStage,
  // 游标计算的唯一入口（2026-10-28 起 markStage/waiveStage 共用它）。
  // 导出是给门禁直接断言「游标单调不减」用的，产出路径不单独调用它。
  advanceCursor,
  recordIssue,
  closeIssue,
  inspectPptx,
  listZipEntries,
  // 契约口径（扩展名 / 自指检查 / 产物取证）—— backend 与 workflowState 共用同一份实现
  normalizeExts,
  extOf,
  matchesExt,
  artifactExtsOf,
  deliverableExtsOf,
  terminalCheckIds,
  missingStagesOf,
  CHECK_OUTCOME,
  evaluate,
  /** ★ 第三阶段：没有阶段机的通用任务（lifecycle:'none'）的验收入口（见其头注）。 */
  evaluateStandalone,
  summarize,
  // 目标契约收尾对照（「偏差」与「经批准的变更」必须分开）
  diffContract,
  compactContract,
  describeContract,
  // 跨请求恢复的纯判据（workflowState 调用；门禁直接喂内存 Buffer / 内存证据）
  planRecovery,
  stageEvidence,
  firstGapIndex,
  maxDoneIndex,
  markStale,
  RECOVERY_NOTES,
};
