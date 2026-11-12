/**
 * general-v1 —— 「没有专用工作流命中」时的**通用任务契约**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★★ 2026-10-26【第三阶段】本文件改过一次定位，先读完这段再动它。
 *
 * 【改之前】它是「**没有标准**」的兜底标记：`lifecycle:'none'` + 什么都不声明。
 *   理由当时是对的：一份空 cfg 不是 no-op，而是一台**永远判合格的机器**
 *   （`evaluate()` 见空 requiredStages ⇒ 一开始就"全部阶段完成"⇒ 收尾判 COMPLETE）。
 *
 * 【问题】把它做成"没有标准"的直接后果不是"不乱判"，而是**根本不判**：
 *   `backend.js` 对 `lifecycle:'none'` 的项不建控制器，`evaluate()` 的两处调用点都在
 *   控制器内部 ⇒ 通用任务**没有任何 verdict**。于是老板点名的两条同时成立且都没被满足：
 *     · 「不能因为没专属工作流就**天然无法完成**」—— 它连"完成"都判不出来；
 *     · 「不能因为没专属工作流就**自动完成**」—— 它连"自动完成"都没发生，因为没判。
 *   用户看到的是一个既不能说完成、也不能说没完成的空洞。
 *
 * 【现在】它是一套**按任务目标分流**的最小通用验收契约：
 *   · 有交付物的任务 ⇒ 核"产物存在/可读/非空 + 归属本任务 + 格式符合声明"；
 *   · 没有交付物的任务 ⇒ 核"回复是否存在且不是占位 + 检查有没有真读数"，
 *     **绝不**因为"没文件"就判失败（那是把文件生成器当成通用 Agent）；
 *   · 执行型任务 ⇒ "一个非空文件不能证明用户要求的工作全部完成"：
 *     工具失败未补救 / 声明了产物却没落地 ⇒ 一律不许 COMPLETE；
 *   · 一切都对不上时（全部不适用）⇒ `not-applicable` ⇒ 聚合判 **PARTIAL**（不是 COMPLETE）。
 *
 * 【刻意不声明的东西（声明了就会有人把它当 cfg 用）】
 *   · stages / requiredStages / waivableStages —— **仍然没有阶段机**。
 *     有阶段机 ⇒ backend 会为它建控制器、open 持久化状态、武装复用闸门，
 *     27 个 `wfCtl.*` 调用点全部从 null 变非 null（blast radius 远超本阶段射程）。
 *     验收走 `workflowRunner.evaluateStandalone(entry, ctx)`（不建控制器、不落盘）。
 *   · repairPolicy / renderPolicy / defaultSlideCount —— 没有修复、渲染、页数概念。
 *   · 任何 PPT 专属的 check id —— `general_*` 前缀是刻意的：它们是**另一套标准**，
 *     不是"一套很宽松的 PPT 标准"。
 *
 * 【无法自动核验的情况（必须让用户看见，不许装成通过）】
 *   ① 用户要的东西"对不对/好不好"（内容质量、结论真伪）：本契约只核**有没有、是不是、属不属于**，
 *      不核判断力。这一项由 `general_goal_evidence` 的读数把边界说清：有检查类调用但没有任何
 *      可对上验收项的读数 ⇒ **unverified**（不是 fail）。见 REPORT.md §13。
 *   ② 任务声明的格式：只有**显式**写出来的格式（`.pdf` / `.docx` / … 或裸词 `pdf`）才认；
 *      说"给我一份报告"这种没写格式的 ⇒ `declaredFormat=''` ⇒ 格式比对**不参与否决**。
 *   ③ 用户的隐性期望（"顺便把上次那个也改了"）：任何契约都核不了，如实记为未验证。
 *
 * 【"已响应"与"内容已验证"（2026-10-26 追加）】
 *   六项检查判的是"有没有、是不是、属不属于"，而 `general_response_present` 通过**只**说明
 *   "产生了一段非空回复"。为了让报告能区分这两件事，本文件另外导出一个 `assuranceOf()`，
 *   把结论定性成 `generated-only / source-checked / goal-verified` 三档（推导只用客观事实：
 *   归属产物数 + 检查读数）。它**不参与 verdict**（问答类任务的 COMPLETE 依然合法），
 *   只决定"这份结论能被怎样引用"。见该函数头注。
 *
 *   ⚠ 中间那一档的 id 名不副实（已知，不打算在本阶段改名）：
 *   `source-checked` 的 id 是历史命名；本档含义是「有可核读数、未做任何验收项比对」，
 *   不是「来源已核对」。为什么改不动：`general-v1` 的 `lifecycle='none'` ⇒ backend 不给
 *   控制器（`wfCtl===null`）⇒ 拿不到 `requiredChecks` 清单 ⇒ `gradeVerifyEvidence` 走
 *   `no-checks-lenient`，**没有任何验收项被比过**。要让 id 名副其实就得新造一套检查项来源，
 *   那是另一轮改动。当前处置：id 保留（改 id 会波及 22 处引用，其中 9 处在别人的探针目录），
 *   但 summary/why **只陈述可数事实**，并强制带上"未做比对"的局限句。
 *   —— 详见 REPORT.md §8 的 UNVERIFIED 条目（真实路径上无比对对象）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * 「算产物」的扩展名（`buildExts`）—— 通用 Agent 的产物类型清单。
 *
 * ★ 为什么必须是清单而不能是空数组：空数组等于"永远没有产物" ⇒ 文件任务也会被
 *   当成问答任务 ⇒ 交付物存在性检查永远 not-applicable ⇒ **做了也白做**。
 * ★ 为什么不能只写一种格式：豆芽是通用 Agent，不是 pptx 生成器。
 * ★ 为什么**不含** `.py/.js/.sh` 这类过程脚本：它们是"动手手段"，不是"交付物"
 *   （`deliveryProtocol.isRealArtifact` 已经先筛过一遍；这里再声明一次是为了让
 *   "本工作流的产物契约"自己说得清 —— 两处都是同一口径，不是两套判据）。
 */
const BUILD_EXTS = [
  '.pptx', '.docx', '.xlsx', '.pdf',
  '.txt', '.md', '.csv', '.json', '.xml',
  '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.mp4', '.mp3', '.zip', '.exe',
];

/**
 * 「交付格式」的扩展名（`deliverable.extensions`）。
 * ★ 与 `buildExts` 的分工（上一阶段定的口径，**不许合并**）：
 *   `buildExts` 回答"哪些文件算本工作流的产物"（阶段认定 / 归属取证读它）；
 *   本字段回答"哪些格式可以当交付格式"（格式比对读它）。
 *   今天同值、语义不同 —— 合并成一个字段，将来只改一处的那天就会同时改掉另一处。
 */
const DELIVERABLE_EXTS = [
  '.pptx', '.docx', '.xlsx', '.pdf',
  '.txt', '.md', '.csv', '.json', '.xml',
  '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.mp4', '.mp3', '.zip', '.exe',
];

/**
 * 去重保序。
 * @param {string[]} list
 * @returns {string[]}
 */
function uniq(list) {
  const out = [];
  for (const x of (Array.isArray(list) ? list : [])) {
    const s = String(x == null ? '' : x);
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/**
 * 本次任务里"被当成交付物"的那些文件 = 模型自报的 ∪ 已确认归属的，再按交付格式清单过滤。
 *
 * ★ 为什么两个来源都要看：
 *   · 只看 `artifacts`（已归属）⇒「模型声称写了、其实没写」这种失败根本看不见
 *     （它不在归属结果里），于是"文件缺失"会被静默放行；
 *   · 只看 `claimedArtifacts`（自报）⇒ 工作区里那份**本任务真的产出、但模型没交清单**的文件
 *     会被漏掉 ⇒ 做对了被判没做（假红）。
 *   两个来源合起来，"该有的没有"与"有的没被认领"才都能被判到。
 * @param {object} c 检查上下文
 * @returns {string[]}
 */
function deliverableFiles(c) {
  const want = (Array.isArray(c.deliverableExtensions) && c.deliverableExtensions.length)
    ? c.deliverableExtensions : null;
  const all = uniq((c.claimedArtifacts || []).concat(c.artifacts || []));
  return want ? all.filter((p) => want.indexOf(c.extOf(p)) >= 0) : all;
}

/**
 * 纯占位回复（"好的/收到/稍等"）—— 它们**不构成**"回复存在"。
 * 判法：去掉标点空白后很短、且整串完全由确认词构成。任何带实质内容的句子都不在此列
 * （所以「好的，已写入 out.txt」不会被误杀）。
 */
const PLACEHOLDER_RE = /^(好的?|好嘞|行|嗯+|收到|明白了?|了解|知道|ok|okay|done|完成|已处理|已处理完|稍等|请稍等|马上)$/i;

/**
 * 用户在这句话里**显式**声明了交付格式吗？返回归一化扩展名（不含点），没声明返回 `''`。
 *
 * ★ 只认三种写法，且都要求"明确"：显式扩展名（`.pdf`）、裸词 `pdf`。
 *   刻意**不**认"报告 / 文档 / 表格 / 图片"这类**类别词**：它们既可能是 .docx 也可能是 .pdf，
 *   猜一个格式就是把"用户没说的话"写进标准里，然后拿它去否决用户的成果。
 * ★ 多个不同格式同时出现 ⇒ 返回 `''`（要求不唯一 ⇒ 不做格式否决），并把这件事记在无法自动核验那一栏。
 * @param {string} text 用户原话
 * @returns {string}
 */
function declaredFormatOf(text) {
  const t = String(text == null ? '' : text);
  const found = [];
  for (const e of DELIVERABLE_EXTS) {
    const ext = e.slice(1);
    // 显式带点：`.pdf` / `.docx`（大小写不敏感）
    if (new RegExp('\\.' + ext + '\\b', 'i').test(t)) found.push(ext);
  }
  if (/\bpdf\b/i.test(t)) found.push('pdf');
  const u = uniq(found);
  return u.length === 1 ? u[0] : '';
}

/**
 * ★ 2026-11-09 新增：**技术栈契约**
 *
 * 要钉住的缺陷（实测）：用户说「用 Godot 做一个愤怒小鸟」，最终交付的是
 * `angry-birds-web/index.html` + 一个只有 icon.svg 的 Godot 空目录，却因为
 * 「网页能验证、Godot 跑不起来」而把**可验证的替代品**当成主交付。
 *
 * 根因不是模型偷懒，是系统**没有把"用 X 技术栈"变成可判定项**：
 * `general_format_matches` 只比对文件扩展名，而 "Godot" 不是扩展名，是一类工程形态。
 *
 * 判据方向：从需求原文抽出点名的技术栈 ⇒ 要求产物里出现该栈的**特征文件**。
 * 只认"点名即契约"：没点名就不判（not-applicable），绝不因为产物像什么就反推要求。
 */
const STACK_SPECS = [
  { id: 'godot', name: 'Godot', hit: /\bgodot\b/i, proof: [/project\.godot$/i, /\.tscn$/i, /\.gd$/i] },
  { id: 'unity', name: 'Unity', hit: /\bunity\b/i, proof: [/\.unity$/i, /Assets[\\/]/i, /\.cs$/i] },
  { id: 'electron', name: 'Electron', hit: /\belectron\b/i, proof: [/electron-builder\.ya?ml$/i, /package\.json$/i] },
  { id: 'miniprogram', name: '微信小程序', hit: /小程序/, proof: [/app\.json$/i, /project\.config\.json$/i, /\.wxml$/i] },
  { id: 'python', name: 'Python', hit: /\bpython\b/i, proof: [/\.py$/i] },
];

/** 需求原文里点名的技术栈（没有则 null）。只认第一处，避免一句话里塞两个栈时乱判。 */
function detectStack(goalText) {
  const s = String(goalText || '');
  if (!s) return null;
  for (const spec of STACK_SPECS) if (spec.hit.test(s)) return spec;
  return null;
}

/**
 * 技术栈契约的纯判定（导出给单测；不读环境、不碰 fs）。
 * @param {string} goalText 需求原文
 * @param {string[]} files  产物路径
 * @returns {{notApplicable?:boolean, pass?:boolean, why:string}}
 */
function stackMatch(goalText, files) {
  const spec = detectStack(goalText);
  if (!spec) return { notApplicable: true, why: '用户没有点名技术栈 ⇒ 技术栈这一项不适用' };
  const list = (Array.isArray(files) ? files : []).map(String).filter(Boolean);
  if (!list.length) {
    return { pass: false, why: '用户点名了 ' + spec.name + '，但这次没有任何产物文件（主交付缺失）' };
  }
  const hit = list.filter((p) => spec.proof.some((re) => re.test(p)));
  if (!hit.length) {
    return {
      pass: false,
      why: '用户要的是 ' + spec.name + ' 工程，实际产物是 ' + list.slice(0, 4).join('、')
        + '——没有任何 ' + spec.name + ' 特征文件（另一种形态的成品不能顶替）',
    };
  }
  return { pass: true, why: '交付形态符合点名的 ' + spec.name + '：' + hit.slice(0, 4).join('、') };
}

const CHECKS = [
  {
    id: 'general_deliverable_present',
    severity: 'must',
    label: '交付物确实存在、可读、非空（"模型说写了"不算；0 字节不算；读不出不算）',
    /**
     * 三档：
     *   有产物且都能读 ⇒ 通过；有产物但缺失/0 字节/读不出 ⇒ **失败**；
     *   一份产物都没有：用户要的是文件 ⇒ **失败**（"该有却没有"）；
     *                    用户本来就没要文件 ⇒ **not-applicable**（问答任务不许因缺文件失败）。
     */
    run(c) {
      const files = deliverableFiles(c);
      if (!files.length) {
        if (c.expectsArtifact) {
          return {
            pass: false,
            why: '用户要的是文件，但本次没有任何可交付产物'
              + '（模型没交清单，工作区里也没有能归属到本任务的候选）',
          };
        }
        return { notApplicable: true, why: '本次任务没有文件交付物（问答/研究/操作类）⇒ 交付物存在性这一项不适用' };
      }
      const missing = files.filter((p) => !c.exists(p));
      const empty = files.filter((p) => c.exists(p) && !(c.sizeOf(p) > 0));
      const unreadable = files.filter((p) => c.exists(p) && c.sizeOf(p) > 0 && c.readArtifact(p) === null);
      if (missing.length || empty.length || unreadable.length) {
        const bits = [];
        if (missing.length) bits.push('文件不存在：' + missing.join('、'));
        if (empty.length) bits.push('0 字节：' + empty.join('、'));
        if (unreadable.length) bits.push('读不出内容：' + unreadable.join('、'));
        return { pass: false, why: bits.join('；') };
      }
      return { pass: true, why: files.length + ' 份交付物存在、可读、非空：' + files.join('、') };
    },
  },
  {
    id: 'general_artifact_attributed',
    severity: 'must',
    label: '每份交付物都能归属到**本次任务**（不是工作区里别人留下的旧文件）',
    /**
     * 判据来自 backend 的**同一份**归属事实（`discoverArtifactsForConcludeCore` 的返回）：
     *   `accepted[{path,source}]` 是通过归属检查的候选，`rejected[{path,source,why}]` 是被拒的。
     * ★ 只看**被当成交付物的**那些（`c.artifacts` = 归属结果里真正通过的）：
     *   "模型声称写了、但磁盘上没有"这类问题归**存在性**那一项判（`general_deliverable_present`），
     *   在这里再判一次会让同一件事在报告里出现两条一模一样的失败，也会让两项互相掩护
     *   （删掉其中一项，另一项照样亮红 ⇒ 断言失去区分力）。
     * 失败只有三种，都是"冒领"的具体形态：
     *   ① 这份文件在 rejected 里（已被归属判定拒绝）却还被当成交付物；
     *   ② accepted 里没有它的来源（来源不明）；
     *   ③ 来源不在允许集合内（不是本 run 的账 / 不是本任务 trace 的写入 / 不是本任务时间窗内的落地）。
     * 拿不到归属事实 ⇒ **unverified**（"无法确认归属"），**绝不**退回"有同扩展名文件就算"。
     */
    run(c) {
      const adopted = uniq(c.artifacts || []);
      if (!adopted.length) return { notApplicable: true, why: '本次没有任何已归属的产物 ⇒ 产物归属这一项不适用' };
      const att = c.attribution;
      if (!att || !Array.isArray(att.paths) || !Array.isArray(att.accepted)) {
        return c.unverified('没有拿到产物归属事实（backend 未提供 discovery 结果）⇒ 无法确认这些文件属于本次任务');
      }
      const accepted = att.accepted;
      const rejected = Array.isArray(att.rejected) ? att.rejected : [];
      const ALLOWED = ['run.artifacts', 'trace-write', 'workspace-scan'];
      const bad = [];
      const good = [];
      for (const p of adopted) {
        const hitRej = rejected.find((r) => r && String(r.path || '') === p);
        if (hitRej) {
          bad.push(p + '（已被归属判定拒绝：' + String(hitRej.why || '原因未记录') + '）');
          continue;
        }
        const hit = accepted.find((x) => x && String(x.path || '') === p);
        if (!hit) { bad.push(p + '（归属事实里没有它的来源）'); continue; }
        if (ALLOWED.indexOf(String(hit.source || '')) < 0) {
          bad.push(p + '（来源不可信：' + String(hit.source || '空') + '）');
          continue;
        }
        good.push(String(hit.source));
      }
      if (bad.length) return { pass: false, why: '有产物无法归属到本次任务却被当成了交付物：' + bad.join('；') };
      return { pass: true, why: adopted.length + ' 份产物都能归属到本次任务（来源 ' + uniq(good).join('/') + '）' };
    },
  },
  {
    id: 'general_format_matches',
    severity: 'must',
    coversFormat: true,
    label: '实际格式符合任务声明的格式要求（声明了就必须一致；没声明就不拿格式否决）',
    /**
     * 四档（`coversFormat: true` ⇒ 本项是"交付格式比对"的唯一负责人）：
     *   有产物 + 没声明格式        ⇒ 通过（不拿格式说事，"报告"可以是 docx 也可以是 pdf）
     *   有产物 + 声明了格式且一致  ⇒ 通过
     *   有产物 + 声明了格式但不一致⇒ **失败**（`\\.docx` 的要求不能以 `.pdf` 交差）
     *   没有实体产物 + 没声明格式  ⇒ not-applicable；声明了格式 ⇒ 失败（要的东西不存在）
     * ★ 扩展名比对用引擎的 `c.extOf`（`matchesExt` 的唯一实现），不在这里另写一套正则。
     * ★ 只认**存在**的文件：不存在的东西没有格式，它的问题已经由"存在性"那一项判过，
     *   不在这里重复判（两处重复判，报告里会出现两条一模一样的失败）。
     */
    run(c) {
      const want = String(c.declaredFormat || '').replace(/^\./, '').toLowerCase();
      const files = deliverableFiles(c).filter((p) => c.exists(p));
      if (!files.length) {
        if (!want) return { notApplicable: true, why: '本次没有文件交付物，且用户没有声明格式要求 ⇒ 格式比对不适用' };
        return { pass: false, why: '用户要的是 .' + want + '，但本次没有任何产物' };
      }
      if (!want) return { pass: true, why: '用户没有声明格式要求 ⇒ 不拿格式否决（现有 ' + files.length + ' 份产物）' };
      const hit = files.filter((p) => c.extOf(p) === '.' + want);
      if (!hit.length) {
        return { pass: false, why: '用户要的是 .' + want + '，实际产物是 ' + files.join('、') + '（格式与要求不一致）' };
      }
      return { pass: true, why: '交付格式符合要求（.' + want + '）：' + hit.join('、') };
    },
  },
  {
    id: 'general_runtime_validated',
    severity: 'must',
    label: '需要真实运行的应用已启动并操作验收（文件存在、HTTP 200、命令成功都不算）',
    run(c) {
      if (c.expectsRuntime !== true) {
        return { notApplicable: true, why: '本任务不是网页/桌面应用/exe/游戏等需要真实运行的交付 ⇒ 运行验收不适用' };
      }
      const rt = c.runtime && c.runtime.evaluation ? c.runtime.evaluation : c.runtime;
      if (!rt || !rt.status) {
        return { pass: false, why: '任务需要真实运行验收，但 backend 没有提供运行证据裁决（不能按通过处理）' };
      }
      if (rt.status === 'pass') {
        return { pass: true, why: String(rt.why || '当前交付物有匹配的真实运行通过记录') };
      }
      if (rt.status === 'unverified') {
        return c.unverified(String(rt.why || '运行验收已尝试，但环境没有跑成'));
      }
      return {
        pass: false,
        why: String(rt.why || '运行验收失败或没有任何匹配当前任务/产物的记录'),
        gaps: Array.isArray(rt.gaps) ? rt.gaps.slice(0, 10) : [],
      };
    },
  },
  {
    id: 'general_response_present',
    severity: 'must',
    label: '最终可见回复存在且不是纯占位（"好的/收到/稍等"不算内容）',
    /**
     * 判据（必须写清，否则"什么算空回复"就靠人猜）：
     *   · 空串 / 只有空白 ⇒ **失败**（用户什么都没得到）；
     *   · 去掉标点后长度 ≤ 6 且整串完全由确认词构成 ⇒ **失败**（纯占位）；
     *   · 其余一律通过 —— 本项只判"有没有给出内容"，不判"内容对不对"（那是另一个维度，
     *     而且本契约明确不冒充能判它，见文件头"无法自动核验"①）。
     */
    run(c) {
      const t = String(c.responseText || '').trim();
      if (!t) return { pass: false, why: '本轮没有给用户任何可见回复（空回复不等于完成）' };
      const bare = t.replace(/[\s。，,、！!？?…\.\-—~～:：;；]+/g, '');
      if (bare.length <= 6 && PLACEHOLDER_RE.test(bare)) {
        return { pass: false, why: '本轮回复只有占位语「' + t.slice(0, 20) + '」，没有实际内容' };
      }
      return { pass: true, why: '最终回复非空（' + t.length + ' 字）' };
    },
  },
  {
    id: 'general_goal_evidence',
    severity: 'must',
    label: '本轮需要执行的检查有真实证据（读数对得上验收项，不是一句"全部通过"）',
    /**
     * 判据来自 backend 累积的**同一份** `evidenceQuality.gradeVerifyEvidence` 读数
     * （`{ checks, evidence }`：检查类调用次数 / 其中 `isEvidence === true` 的次数）。
     * ★ 这一条**不许**自己再判一遍"这段文字算不算证据" —— 那会变成第二套判据。
     * 三档：
     *   checks === 0 + 有产物 ⇒ 通过（产物本身就是证据：已核存在/非空/归属/格式）
     *   checks === 0 + 无产物 ⇒ not-applicable（本轮没有任何检查类调用）
     *   evidence > 0          ⇒ 通过
     *   checks > 0 且 evidence === 0 ⇒ **unverified**（有检查动作、但没有一次给出可对上验收项的读数
     *     —— 这是"没验成"，不是"验砸了"；判 fail 会把"检查输出是纯表态"错记成"目标没达成"）
     */
    run(c) {
      const ef = c.evidence;
      if (!ef) return c.unverified('没有拿到本轮检查动作的读数（backend 未提供 evidence 事实）⇒ 无法判定检查是否真的执行过');
      const checks = Number(ef.checks) || 0;
      const evidence = Number(ef.evidence) || 0;
      if (!checks) {
        const files = deliverableFiles(c).filter((p) => c.exists(p));
        if (files.length) {
          return { pass: true, why: '本次以产物本身为证据（' + files.length + ' 份已核存在/非空/归属），无额外检查类读数' };
        }
        return { notApplicable: true, why: '本轮没有任何检查类调用，且没有产物 ⇒ "目标证据"这一项不适用' };
      }
      if (evidence > 0) {
        return { pass: true, why: checks + ' 次检查类调用中有 ' + evidence + ' 次给出了可对上验收项的读数' };
      }
      return c.unverified(checks + ' 次检查类调用，但没有任何一次给出可对上验收项的读数'
        + '（只有表态，或读数没对准任何验收项）⇒ 检查是否真的验到东西无法确认');
    },
  },

  {
    id: 'general_stack_match',
    severity: 'must',
    label: '用户点名的技术栈与实际交付一致（点名 Godot 就不能只交网页）',
    /**
     * 只看两个客观事实：**需求原文点名了什么栈** + **产物里有什么文件**。
     * 不读模型自述（"我做了 Godot 版"不算证据），不因为产物像什么就反推要求。
     */
    run(c) {
      const files = [].concat(c.artifacts || [], c.claimedArtifacts || []).map(String);
      const r = stackMatch(String(c.goalText || ''), files);
      if (r.notApplicable === true) return r;
      return { pass: r.pass === true, why: r.why };
    },
  },
  {
    id: 'general_no_unresolved_failure',
    severity: 'must',
    label: '没有未补救的工具失败（失败后又做成了同一目标 ⇒ 不算未补救）',
    /**
     * 判据来自 backend 的 `openFailures()`（与收尾门禁、报告同源）：
     *   `{ calls, unresolved, lastError }`。
     * ★ "补救"的判定不在这里：`taskEntry.doneLog` 的销账逻辑（同一技能后来做成了 ⇒ 关账）
     *   是既有实现，本项只读它的结论 —— 否则就有了两套"什么算补救"。
     * 三档：无调用 ⇒ not-applicable；有调用且无未闭环 ⇒ 通过；有未闭环 ⇒ **失败**（并给出最后一次失败的原文摘要）。
     */
    run(c) {
      const tf = c.toolFailures;
      if (!tf) return c.unverified('没有拿到本轮工具失败账（backend 未提供 toolFailures 事实）⇒ 无法判定');
      const calls = Number(tf.calls) || 0;
      const open = Number(tf.unresolved) || 0;
      if (!open) {
        if (!calls) return { notApplicable: true, why: '本轮没有任何工具调用 ⇒ 失败检查这一项不适用' };
        return { pass: true, why: '本轮 ' + calls + ' 次工具调用，没有未补救的失败' };
      }
      const last = String(tf.lastError || '').slice(0, 120);
      // ★ 2026-11-09：**工具侧失败 ≠ 交付物失败**。
      //   要钉住的缺陷（实测）：验证工具自己缺依赖（`Cannot find module 'ws'`）⇒ 截图/运行验证
      //   永远跑不起来 ⇒ 这一项永远"有未补救的失败" ⇒ 任何任务都不可能 COMPLETE，
      //   哪怕产物完全合格。工具坏了是环境问题，处置方向是「修工具 / 走 BLOCKED」，
      //   不是「任务失败」——后者会让用户在正确的地方反复返工。
      //   判据：backend 若给出 toolSide 读数（失败归属侧已定），且未闭环的全部来自工具侧 ⇒ 不判失败。
      const toolSide = Number(tf.toolSide) || 0;
      if (open > 0 && toolSide >= open) {
        return c.unverified('有 ' + open + ' 处未闭环失败，但全部来自工具/环境侧（不是交付物问题）'
          + (last ? '（最后一次：' + last + '）' : '') + ' ⇒ 走阻塞口径，不判交付失败');
      }
      return { pass: false, why: '还有 ' + open + ' 处工具失败没有补救' + (last ? '（最后一次：' + last + '）' : '') };
    },
  },
];

/**
 * 「这份结论能被怎样引用」——**内容保障级别**（`contentAssurance` 的唯一来源）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 【为什么要有它】`general_response_present` 只能证明「产生了一段非空回复」，
 *   证明不了**回答真实、准确或完整**。老板 2026-10-26 原话：
 *     「区分"已响应"和"内容已验证"。`general_response_present` 只能证明产生了非空响应…
 *       普通对话：可以报告响应已生成，但不得声称内容已经独立验证。」
 *   于是同一个 `COMPLETE` 必须能被追问："你凭什么这么说？"本函数就是那句回答。
 *
 * 【它**不是**判据】返回值不参与 verdict 聚合（改判它一个字都不会让任务从 COMPLETE 变红）：
 *   · 问答类任务没有文件也可以合法 COMPLETE —— 老板明确反对"为了完成率要求所有问答都生成文件"；
 *   · 它改变的只是**这份结论能被怎样引用**：说"回复已生成"可以，说"内容已验证"不行。
 *   所以它挂在 `evaluate()` 的返回对象上（`contentAssurance`），不进 `results[]`。
 *
 * 【三条硬约束（违反即无效）】
 *   ① `taskKind` **只由客观事实推导**（归属产物数 / 检查读数），不读模型自述、不问模型。
 *      否则"我查过了"这句话就能升一级 —— 那正是老板禁止的"把自述当证据"。
 *   ② 一切结论**从已产生的检查结果读**（`results[].outcome`），不在这里把判据重判一遍
 *      （重判 = 第二套判据，迟早与 `CHECKS` 漂移）。
 *   ③ `generated-only` 的 summary 必须带「内容未经独立核验」六个字面字：
 *      这是一句**限制声明**，少一个字，它就会读成"验过了"。
 *
 * @param {object} ctx      `evaluate()` 的 `ctxBase`（只读其中已核实的事实）
 * @param {object[]} results 已跑完的检查结果（`{id, outcome, pass, why}`）
 * @returns {{level:string, taskKind:string, why:string, summary:string}}
 */
function assuranceOf(ctx, results) {
  const c = ctx || {};
  const rs = Array.isArray(results) ? results : [];
  /** 一条检查的归一结论（`absent` = 这条根本没跑，**不等于**通过）。 */
  const outcomeOf = (id) => {
    const r = rs.find((x) => x && x.id === id) || null;
    if (!r) return 'absent';
    const o = String(r.outcome == null ? '' : r.outcome);
    if (o) return o;
    if (r.notApplicable === true) return 'not-applicable';
    if (r.unverified === true) return 'unverified';
    if (r.configError === true) return 'config-error';
    return r.pass === true ? 'pass' : 'fail';
  };

  const ef = (c.evidence && typeof c.evidence === 'object') ? c.evidence : null;
  const checks = ef ? (Number(ef.checks) || 0) : 0;
  const readings = ef ? (Number(ef.evidence) || 0) : 0;
  const adopted = uniq(Array.isArray(c.artifacts) ? c.artifacts : []);
  /**
   * ★ 本轮**工具调用总数**（与 `general_no_unresolved_failure` 读的是同一份事实）。
   *
   * 为什么要在这里读它：`evidence.checks === 0` 有两种完全不同的含义 ——
   *   ① 真的没调用过检查类工具；
   *   ② 调用了，但 backend 的口径没有把它计进来。
   * 我不掌握这两种情况的区分权（那是 backend 的记账口径），所以**不许**把 `checks===0`
   * 陈述成"没有检查动作"。有工具调用却零读数时，措辞必须如实写成"读数为 0"，
   * 并且把工具调用数摆出来让读者自己判断 —— 否则报告就在替 backend 的记账缺口圆谎。
   *
   * ★ 订正（2026-10-26 深夜，按 backend **真实代码**复核后改写，旧说法见下）：
   *   旧注释写的是「`evCallsTotal` 计在 `deliverables.length > 0` 守卫内，一个真跑了 3 次
   *   shell 检查、零产物的研究任务，喂到这里的就是 `{checks:0,evidence:0}`」——
   *   **这句话在 `backend.js` 修完残余耦合点 1 之后已经成为假话**，所以留在这里就是一条
   *   埋在产物里的错误文档。订正后的真实口径：
   *     `checks === 0` ⇔ 本任务运行内**一次 `shell-exec` / `ssh-exec` 都没有执行过**
   *     （与"有没有产物"无关）。
   *
   * ⚠️ 这一段**不拿 `backend.js` 的行号当锚点**，这是刻意的（2026-10-26 第二次订正）。
   *   事情经过：上一版把「`evidence` 的唯一消费点在 :7129（已失效，勿引用）」和 md5
   *   `fc0b92f7…`（已失效，勿引用）写进了注释。
   *   只过了一次 backend 提交（`b752807`，残余耦合点 1），我引的每个位置都漂了 ——
   *   下面把它们**并按"历史值 / 当时实测值"标出来，方便任何人自己复核这件事**：
   *
   *     旧行号 :4736（已失效，勿引用）→ 现 :4744    `evCallsTotal += 1`
   *     旧行号 :7129（已失效，勿引用）→ 现 :7141    唯一消费点
   *     旧行号 :6627（已失效，勿引用）→ 现 :6639    `taskEntry.toolCalls +=`
   *     md5 : `fc0b92f7…`（已失效，勿引用）→ `72b09967…`
   *
   *   「现 :7141」这一组是 **2026-10-26 在 md5 `72b09967…` 上实测的**，它自己也会随下一次
   *   backend 提交再漂 —— 所以上面带「已失效」的行是为了让人复核"漂移确实发生过"，
   *   **不是**给后来人当锚点用。要干活，请只用下面四条 grep；要验上面这段，拿旧值去对
   *   `git show fc0b92f7` 之前的 backend 即可。
   *   ⇒ **行号在注释里活不过一次提交**，写死行号当锚点 = 给自己留一条会过期的假话
   *   （这正是本段正在订正的那类病）。
   *   改用**可 grep 的符号**定位，任何人任何时候都能自己核一遍：
   *     · 归零：`let evCallsTotal = 0;`（每次任务运行从 0 起）
   *     · 累加：`trackDeliverable` 内、`if (isVerifyCall) { evCallsTotal += 1; ... }`
   *       ——**不在** `deliverables.length > 0` 那个守卫里（守卫只留进度轴：
   *       `turnSnap.vf` / `evSeen` / `sig` / `issueOpen`，那几条**没变**）
   *     · 唯一消费点：`evidence: { checks: evCallsTotal, evidence: evReadingsTotal },`
   *     · `toolCalls` 累加：`taskEntry.toolCalls += toolCalls.length;`（响应收口处，早于闸门）
   *   复核时只认这四条 grep 的结果，**不要**去数行号。
   *
   *   仍要保留上一段的写法，理由换了但没消失：`checks` 数的是"检查类且已执行"，
   *   `toolCalls` 数的是"全部且已发出"，前者是后者的子集（`evCallsTotal` 每次任务运行
   *   从 0 起、只在内层循环里 +1；`toolCalls` 在响应收口处按发出条数累加、跨续跑累计），
   *   所以 `toolCalls > 0 而 checks === 0` 依然只够支撑"不能断定没查过"。
   */
  const toolCalls = (c.toolFailures && Number(c.toolFailures.calls)) || 0;
  /**
   * ★ 措辞纪律（2026-10-26，team-lead 裁决）：`toolCalls` 数的是**模型发出的调用**，
   *   不是"执行了的调用"。出处是 backend 自己的注释（`taskEntry.toolCalls += toolCalls.length`
   *   那一行的上一行原文：「模型**发出**了多少次调用，与"成功几次"分开记」），
   *   而且它在模型响应收口处累加 —— **早于任何闸门与执行**。
   * 两个直接后果，措辞必须体现：
   *   ① 被 reuse-gate 拦下、参数体检不过、工具不存在的调用**也算在内** ⇒ 不能说"执行了 N 次"；
   *   ② 它含**全部**工具（file-read / file-list / web-fetch 都在内）⇒ N>0 只够支撑
   *      "不能断定没查过"，**不够**支撑"查过"，更不能支撑"查的是这次任务该查的东西"。
   * 这是同一条纪律的第三个落点：**"没有 X" 必须能说清是"事实没有"还是"我没看到"**。
   */
  const toolCallsPhrase = '本轮发出 ' + toolCalls + ' 次调用（其中未必都执行，也不限于检查类工具）';

  const presentPass = outcomeOf('general_deliverable_present') === 'pass';
  const attributedPass = outcomeOf('general_artifact_attributed') === 'pass';
  const formatPass = outcomeOf('general_format_matches') === 'pass';
  const goalEvidencePass = outcomeOf('general_goal_evidence') === 'pass';
  const runtimeOutcome = outcomeOf('general_runtime_validated');
  const runtimeRequired = c.expectsRuntime === true;

  // ── 一、taskKind：三条客观事实，按顺序命中 ─────────────────────────────────
  //  ① 有**已归属到本任务**的交付产物 ⇒ execution（"说做了"不算，`general_artifact_attributed`
  //     真判过 pass 才算；归属失败/无产物一律不升到 execution —— 见 M-c 的反控）。
  //  ② 没有归属产物，但本轮有**检查类调用** ⇒ research（哪怕只有一次，也是"去核过"的动作）。
  //  ③ 都不满足 ⇒ chat（纯对话）。
  let taskKind;
  let kindWhy;
  if (attributedPass && adopted.length > 0) {
    taskKind = 'execution';
    kindWhy = adopted.length + ' 份产物已归属到本任务';
  } else if (checks > 0) {
    taskKind = 'research';
    kindWhy = '0 份归属产物 + ' + checks + ' 次被计为检查类调用（其中 ' + readings + ' 次给出了可解析读数）';
  } else {
    taskKind = 'chat';
    /**
     * ★ 措辞纪律（2026-10-26）：`checks===0` 只说"读数为 0"，不说"没查过"。
     *   有调用时把**发出次数**与它的两条局限一起写出来 —— 这是"我拿到的读数"与
     *   "发生的事实"之间的分界线。
     * ★ 排版（2026-10-26）：外层不能再用圆括号 —— `toolCallsPhrase` 自己已经带一对括号，
     *   套起来就成了「（但本轮发出 4 次调用（其中未必都执行…） ⇒ …）」，断句会读错。
     *   外层改分号；不用破折号，因为它会和后面的 `⇒` 挤在一起更难读。
     */
    kindWhy = toolCalls > 0
      ? '0 份归属产物 + 检查读数为 0；' + toolCallsPhrase + ' ⇒ 不能据此断定"没查过"，'
        + '只能说没有可核的检查读数'
      : '0 份归属产物 + 0 次检查类调用';
  }

  // ── 二、level：读三项交付判据 / 一项证据判据的**结论** ────────────────────
  let level;
  let levelWhy;
  if (taskKind === 'execution' && presentPass && attributedPass && formatPass
    && (!runtimeRequired || runtimeOutcome === 'pass')) {
    level = 'goal-verified';
    levelWhy = runtimeRequired
      ? '交付物存在/归属/格式与真实运行验收均 pass'
      : '交付物存在/归属/格式三项均 pass（本任务不要求运行验收）';
  } else if (taskKind === 'research' && goalEvidencePass) {
    level = 'source-checked';
    // id 为历史命名；本档含义是"有可核读数、未做任何验收项比对"，不是"来源已核对"。
    levelWhy = 'general_goal_evidence=pass（' + checks + ' 次被计为检查类的调用中 ' + readings
      + ' 次给出了可解析读数；本轮没有任何验收项可与之比对）';
  } else {
    level = 'generated-only';
    if (taskKind === 'execution') {
      levelWhy = (presentPass && attributedPass && formatPass && runtimeRequired)
        ? '文件级检查通过，但运行未验证：general_runtime_validated=' + runtimeOutcome
        : '交付三项未全过：present=' + outcomeOf('general_deliverable_present')
          + '/attributed=' + outcomeOf('general_artifact_attributed')
          + '/format=' + outcomeOf('general_format_matches');
    } else if (taskKind === 'research') {
      levelWhy = 'general_goal_evidence=' + outcomeOf('general_goal_evidence')
        + '（有检查动作，但 ' + checks + ' 次被计为检查类的调用里没有一次给出可解析读数）';
    } else {
      levelWhy = toolCalls > 0
        ? toolCallsPhrase + '，但没有任何可核的产物或检查读数'
        : '本轮只有对话回复，没有可核的产物或检查读数';
    }
  }

  // ── 三、给报告用的定性句（每档都**只说自己能证明的那一点**）───────────────
  let summary;
  if (level === 'goal-verified') {
    summary = '交付目标已核验：' + adopted.length + ' 份产物的存在性、归属、格式三项均通过';
  } else if (level === 'source-checked') {
    /**
     * ★ 措辞纪律（2026-10-26，team-lead 裁决 (a)）：本档**只陈述可数事实 + 强制局限句**。
     *   为什么必须这样写：本档的 `general_goal_evidence=pass` 是由 `no-checks-lenient`
     *   评分给出的（见文件头「id 名不副实」），它从头到尾**没有跟任何验收项比对过**。
     *   原先写「已核对到可对上验收项的读数」是**字面不成立**的陈述 —— 承认这一点，
     *   比让一句话读起来更漂亮重要。
     * ★ 局限句不许省：只说"有读数"会被读成"结论已核"，那正是本档要防的误读。
     * ★ 为什么这里**没有**「两个数字对不上」那种分支（2026-10-26 深夜删除，别再加回来）：
     *   曾经写过一句「两处记账对不上：发出 N 次却记了 M 次检查类动作」，理由是"实测会不一致"。
     *   那条"实测"是**我自己夹具拼出来的假象**：`_p4probe.mjs` 的 `baseCtx` 写死
     *   `toolFailures:{calls:1}`，而 `research-ok` 场景又单独注入 `evidence:{checks:3}` ——
     *   两个场景的设定被拼进同一份 ctx，读出来就成了"发出 1 次记了 3 次"。
     *   真实路径上 `checks > toolCalls` **不可达**：`checks` 的唯一递增点在 `trackDeliverable`
     *   内（`backend.js` `evCallsTotal += 1`），三条调用链全部落在"每条已执行调用一次"的
     *   循环里、被闸门拦下的分支在 `continue` 之后够不到；`toolCalls` 在响应收口处按**发出**
     *   条数累加、且跨续跑累计。已执行 ⊆ 已发出，且 `evCallsTotal` 每次任务运行从 0 起
     *   ⇒ 分子 ⊆ 分母，只会更小，不会倒挂。
     *   所以留着那个分支等于"用夹具的假象支撑一段真实代码"，永远不触发却给读者留下
     *   "两个数经常对不上"的错误印象。两数口径不同（一个是检查类且已执行、一个是全部且已发出）
     *   这件事已经写在 `toolCallsPhrase` 的两条限定里，不需要再编一个不存在的矛盾。
     */
    summary = toolCallsPhrase + '；被计为检查类的有 ' + checks + ' 次（' + readings
      + ' 次给出了可解析读数）；'
      + '没有可与之对应的验收项，因此这只说明"查过且有读数"，不说明结论已被核对';
  } else if (taskKind === 'execution' && presentPass && attributedPass && formatPass && runtimeRequired) {
    summary = '文件级检查通过，运行未验证（general_runtime_validated=' + runtimeOutcome + '），不得称为目标已核验';
  } else {
    summary = '回复已生成，但内容未经独立核验（' + levelWhy + '）';
  }
  /**
   * ★ 诚实附加句：本次还有没通过 / 没核验的 must 项时，必须在同一句里说出来。
   *   否则"交付目标已核验"会被读成"这一轮全都验过了"—— 而那两件事不一样。
   */
  const badMust = rs.filter((x) => x && x.severity === 'must'
    && x.outcome !== 'pass' && x.outcome !== 'not-applicable');
  if (badMust.length) {
    summary += '；本轮另有 ' + badMust.length + ' 项未通过或未核验（'
      + badMust.map((x) => x.id + '=' + String(x.outcome || '?')).join('、') + '），见验收结论';
  }

  return {
    level,
    taskKind,
    why: '命中「' + taskKind + '」：' + kindWhy + ' ⇒ level=' + level + '（' + levelWhy + '）',
    summary,
  };
}

module.exports = {
  workflowId: 'general-v1',
  version: 2,
  taskType: 'general',
    // ★ 2026-11-09：技术栈契约的纯函数（导出只为单测/审计，产品代码不依赖）
    __stackMatch: stackMatch,
    __detectStack: detectStack,

  /**
   * ★ 生命周期：'none' —— 有"选择"这个动作，**没有**生命周期（阶段/终态/持久化）这一整套。
   *
   * 与 `pptx-v1` 的 `'full'` 成对照。'none' 的结构后果（`backend.js` 已按此实现）：
   *   选中它 ⇒ **不建控制器、不 open 状态、不碰工作流 trace 的持久化账**，
   *   `startWorkflowRun` 直接返回 `null` ⇒ 所有 `if (wfCtl) { … }` 调用点与
   *   "注册表引入之前非 PPT 任务"逐字等价。这是**结构性**保证，不是靠把十几个方法写成 no-op。
   * ★ 验收**不因此消失**：走 `workflowRunner.evaluateStandalone(entry, ctx)`（不建控制器、不落盘）。
   */
  lifecycle: 'none',

  /**
   * 永远命中：返回空规格（`{}`，非 null ⇒ 注册表视为"选中"）。
   *
   * ★ 注册顺序 = 匹配优先级，本项**必须**在 `./index.js` 的 REGISTRY 里排最后；
   *   一旦它排到专用工作流前面，`pptx-v1` 就永远选不中了（兜底会先吃掉所有请求）。
   * ★ 这里**不**做任何识别：通用任务的"是什么任务"由后面的验收项按证据判，
   *   不是在这一步猜（猜出来的 spec 会被当成"用户说过的话"写进账）。
   */
  match: () => ({}),

  /**
   * 产物类型（"算产物"的唯一来源，见 BUILD_EXTS 头注）。
   * ★ 与 `deliverable.extensions` **各管一件事，不许合并**。
   */
  buildExts: BUILD_EXTS,

  /** 交付格式（"哪些格式可以当交付格式"，只用于格式比对，不参与产物发现）。 */
  deliverable: {
    /** 通用任务没有"唯一交付格式"；具体格式由任务本身声明（见 declaredFormat）。 */
    format: '',
    extensions: DELIVERABLE_EXTS,
    /** 通用任务不预先否掉任何格式（pptx 那种"不许用 html 顶替"是**它自己**的判据）。 */
    rejectsAsDeliverable: [],
  },

  /** 本工作流的六项验收（见每条的头注；每项自己带 run 实现，引擎不认识任何具体 id）。 */
  requiredChecks: CHECKS,

  /**
   * 「用户在这句话里声明了什么交付格式」——**声明的能力，不是判据引擎的一部分**。
   *
   * 为什么挂在注册项上而不是注册表里：只有"某套工作流"知道自己的交付格式词表长什么样；
   * 注册表只负责选，不该知道 docx 与 pdf 的区别。backend 通过 `wfSel.entry.declaredFormat(text)`
   * 取用（因此**不需要**直接 require 本文件 —— 通用文件里不出现具体工作流的引用）。
   *
   * @param {string} text 用户原话
   * @returns {string} 归一化扩展名（不含点）；没声明 / 声明不唯一 ⇒ ''
   */
  declaredFormat: declaredFormatOf,

  /**
   * ★ 2026-10-26 新增：**内容保障级别**（"已响应"与"内容已验证"的分界线）。
   *
   * 为什么挂在注册项上（而不是写进 `requiredChecks`）：它不是一条验收标准，
   * 而是一句**对结论的限定**。写进 `requiredChecks` 会让它参与聚合 ⇒ 问答任务的
   * `COMPLETE` 被"内容未经核验"这一项否决 ⇒ 为了过门禁去逼模型生成文件，
   * 正是老板明确反对的那件事（"不要为了追求完成率而要求所有问答都生成文件"）。
   *
   * 声明了它的工作流，`workflowRunner.evaluate()` 会在返回对象上多一个
   * `contentAssurance` 字段；**没声明的工作流（如 pptx-v1）返回对象逐字节不变** ——
   * 这是"通用机制不是 PPT 改造"的结构性证明。
   *
   * @type {(ctx:object, results:object[]) => {level:string, taskKind:string, why:string, summary:string}}
   */
  assuranceOf,
};
