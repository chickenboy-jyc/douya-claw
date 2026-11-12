'use strict';

/**
 * deliveryProtocol —— 《结果交付与决策协作核心规范》里**可机械判定**的那部分。
 *
 * 为什么要有这个模块（而不是只写进人设 Prompt）：
 *   人设只能**劝**模型，不能**拦**模型。规范里最要命的那条禁令
 *   （「已经完成，剩下 XXX 你可以自己处理」）是一句**可以被文字检测的话术**，
 *   既然能检测，就不该只靠模型自觉 —— 必须在收尾层真的把它拦下来。
 *
 * 与既有模块的分工：
 *   toolProtocol.js      —— 管「**这一次工具调用**怎么了」（四态契约 / 分类 / 重试账本 / 产物验证）
 *   deliveryProtocol.js  —— 管「**整个任务**到底算不算交付完成」（终点状态 / 半成品话术 / 决策与阻塞报告 / 状态机 / 验证分诊）
 *
 * ★ 2026-09-22 老板把这套东西定成**四层架构**（原话：这套东西要放在 Agent 的核心执行规则，而不是只放在人设 Prompt 里）：
 *   ┌ System Prompt（douyaPersona.js）—— 负责「**怎么思考、怎么和用户协作**」
 *   ├ Tool Protocol（toolProtocol.js）—— 负责「**工具失败后怎么恢复**」（§26 的分类与处方）
 *   ├ Agent State Machine（本文件 §十一）—— 负责「**什么时候继续 / 询问 / 修复 / 完成 / 阻塞**」
 *   └ Verifier（本文件终点判定 + toolProtocol.verifyDeliverables）—— 负责「**有没有资格说完成**」
 *   分工的意义：模型说"我完成了"**不能**决定状态；状态由 Verifier 的证据决定（§28）。
 *   本文件是**唯一**给"整个任务"下结论的地方 —— 别把终点判定散回 backend 的 if 里。
 *
 * 本文件是纯函数、零依赖，可被单测直接 require，不需要起 Electron。
 */

// ===================== 一、终点状态（规范 §三 / §十三） =====================
// 只有两个**可信出口**，外加两个必须如实说明的中间态：
//   COMPLETE = 目标对象已实际修改 + 关键功能已实现 + 产物已落地 + 已验证
//   PARTIAL  = 做了，但还有完成目标所必需的工作没做完
//   BLOCKED  = 已试过合理方案、已分析原因、已排除可替代方案，确实需要用户介入
//   BLOCKED_WITH_DIAGNOSIS（2026-02-16 新增第四档）
//            = 卡住了，但**给出了卡点根因 + 一套可复现的复现步骤**，且该步骤在本任务的
//              执行记录里真的被跑过 ≥2 次、每次都是同一个失败。
//              ★ 它和 BLOCKED 的区别只有一条、但很关键：
//                BLOCKED                  —— 卡住了，但没给出可复现的诊断（用户只能自己猜/自己查）
//                BLOCKED_WITH_DIAGNOSIS   —— 卡住了，但已经把问题定位到**可复现**的程度，
//                                            复现步骤是实测跑过的（不是自述"我已经复现了"）
//              ★★ 它是"有诊断的阻塞"，**既不是"完成"，也不是"失败"**：
//                · 不是完成：目标没有达成，产物/功能没到位 —— 不许显示成"完成"（见 terminalLabel 的 fail-open 史）；
//                · 不是失败：它没有把问题丢回给用户去查，反而交出了可复现证据 ⇒ 统计口径上算一次**有效交付**
//                  （口径见 deliveryScorecard.js：报 BLOCKED 不计失败率、有诊断的阻塞算有效交付）。
//              ★ 机械判据不在文字里，在 classifyBlockedDiagnosis（下方 §三·补）—— 靠执行证据，不靠正则自述。
// ⚠️ 中间那三种「工具报错了所以失败 / 我试过一次所以做不到 / 代码写出来了所以完成」全部不属于以上任何一个。
const TERMINAL = {
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  BLOCKED: 'BLOCKED',
  BLOCKED_WITH_DIAGNOSIS: 'BLOCKED_WITH_DIAGNOSIS',
};

/**
 * 判定终点状态。
 * @param {object} o
 * @param {boolean} o.hasDeliverables 本轮是否声明了产物（纯对话/纯查询任务为 false）
 * @param {boolean} o.artifactsOk     产物是否逐个验证通过（不存在/0字节/半截 ⇒ false）
 * @param {boolean} o.bailOutHit      正文里是否出现「把剩余工作交给用户」的话术
 * @param {boolean} o.blockedEvidenced 是否满足进入 BLOCKED 的硬前提（试过≥2条路 + 四段式齐全）
 * @returns {'COMPLETE'|'PARTIAL'|'BLOCKED'}
 */
function classifyTerminalState(o) {
  const c = o || {};
  // BLOCKED 优先：它是唯一"明确需要用户介入"的出口，前提最严（见 blockedEvidenced）。
  if (c.blockedEvidenced) return TERMINAL.BLOCKED;
  // 产物没落地 / 出现甩锅话术 ⇒ 一律不许 COMPLETE。
  if (c.artifactsOk === false) return TERMINAL.PARTIAL;
  // ★★ 2026-10-22：**声明了产物、却没给验证结论 ⇒ 未验证 ⇒ 不许 COMPLETE**。
  //   修之前：`hasDeliverables` 写在签名里，函数体**一次都没读它** —— 传了不读。
  //   于是本函数的默认出口是 `return COMPLETE`，也就是 fail-open：
  //   任何"没有被显式判坏"的输入都算完成，包括"我声明了产物但验证环节压根没跑完"。
  //   最坏的形态：模型说"PPT 做好了"，产物清单非空，而验证因为预算/异常没执行
  //   （artifactsOk === undefined）⇒ 照样 COMPLETE。用户拿到一句"完成"，手里没有东西。
  //   规范 §三 早写了"已验证才配 COMPLETE"；这一条就是把它变成**可执行的门**。
  //   ⚠️ 判据刻意用「=== true」而不是「真值」：纯对话/纯查询任务根本不传这个字段
  //      （undefined），它们**不受影响**——不能因为"没产物"就把闲聊判成没做完。
  if (c.hasDeliverables === true && c.artifactsOk === undefined) return TERMINAL.PARTIAL;
  if (c.bailOutHit) return TERMINAL.PARTIAL;
  return TERMINAL.COMPLETE;
}

/**
 * 给用户看的状态标签（人话，不许出现英文状态名）。
 *
 * ★★ 本函数长期是**已知的 fail-open 结构**，改之前先读完这段（2026-02-16 两轮改动的记录）：
 *   最早它就是"最后一行 return '完成'"，于是新增一个状态时，上面几个 if 都不命中
 *   ⇒ 新状态被**静默显示成"完成"**。这是全仓唯一一处会把"卡住"显示成"完成"的路径，
 *   而且它不报错、不失败、不会有任何一个既有断言转红 —— 静默地骗人。
 *
 *   【第一轮只修了一半】当时只给新增的第四档加了分支，**兜底仍是 `return '完成'`**，
 *   理由写的是"改成未知状态会改变既有调用点语义 + 用门禁钉住每一个已知状态都有分支"。
 *   这个理由站不住，两个硬伤：
 *     ① 那条"逐状态点名"的清单（unit-blocked-diagnosis 的 LABELED）是**手写**的：
 *        往 TERMINAL 加第五档时它不会自动多一项 ⇒ 那条断言照样绿 ⇒ 第五档继续被兜底
 *        显示成"完成"，而且没有任何门禁会发现。所以「门禁钉住了每一个已知状态」这句话
 *        当时**并不成立**（它只覆盖"已经想到的状态"，管不住将来）。
 *     ② 「既有调用点会变语义」这个担心方向是反的：三个调用点传的全是终态词表的值
 *        （backend.js 的 terminalState 两处 + 硬编码的 TERMINAL.PARTIAL 一处），
 *        没有任何一处传模型自造的字符串。而**万一真传了**：现在显示"完成"是一个**谎**，
 *        显示"状态未知"是**实话** —— "不改变既有语义"不该排在"不许静默骗人"前面。
 *
 *   【现在的结构】四档全部写成**显式分支**，兜底**绝不许说"完成"**。
 *   走到兜底的只可能是"没识别出来的终态值"，说它完成就是撒谎。
 *   真正把 fail-open 关掉的是门禁里那条「未知值**不许**是完成」
 *   （unit-blocked-diagnosis 的 E1-d/E1-e），不是逐状态点名。
 *   ⇒ 纪律（保留）：**但凡新增终态，必须先在这里加一条分支**；分支顺序即语义，
 *     第四档必须排在 BLOCKED 前面（否则永远进不去）。
 * @param {string} state TERMINAL 之一
 * @returns {string} 人话标签
 */
function terminalLabel(state) {
  if (state === TERMINAL.COMPLETE) return '完成';
  if (state === TERMINAL.BLOCKED_WITH_DIAGNOSIS) return '卡住了（诊断可复现，我把步骤给你了）';
  if (state === TERMINAL.BLOCKED) return '卡住了（需要你提供一个东西）';
  if (state === TERMINAL.PARTIAL) return '还没做完（我不会说完成了）';
  // ★ 兜底：**绝不许说"完成"**。走到这里的只可能是"没识别出来的终态值"，
  //   说它完成就是撒谎；说"状态未知"至少是实话。
  //   上一版保留了 `return '完成'`，理由是"不改变既有调用点语义"——
  //   这个取舍把"兼容"排在了"不许静默骗人"前面，是错的：三个调用点传的都是终态词表的值，
  //   唯一会被兜底的恰恰是"以后新加、却忘了加分支"的状态，而那正是最需要被看见的一类。
  return '状态未知（没识别出来的终态值 —— 这不是完成）';
}

/**
 * 非 COMPLETE 时，收尾必须对用户说的那段话。
 * 原则：先说自己做了什么，再说卡在哪，再说用户只需要提供什么，最后说拿到之后能干什么。
 *
 * 四档各说各的话，**不许共用同一段**（共用就等于把"有诊断的阻塞"说成"我没办法"）：
 *   PARTIAL / 兜底    → 「还没做完」四行（我不会说完成了）
 *   BLOCKED           → 四段式（我已经做了什么 / 卡在哪 / 你只需要提供什么 / 拿到之后我做什么）
 *   BLOCKED_WITH_DIAGNOSIS → 卡点 + 诊断 + 复现步骤 + 我跑了几次 + 你只需要提供什么
 *                            标题与语气都区别于 BLOCKED：这不是"我没办法"，是"我定位到可复现了"。
 */
function terminalStatement(state, o) {
  if (state === TERMINAL.COMPLETE) return '';
  const c = o || {};
  if (state === TERMINAL.BLOCKED_WITH_DIAGNOSIS) {
    return buildDiagnosedBlockedReport({
      tried: c.tried,
      stuckAt: c.stuckAt,
      diagnosis: c.diagnosis || c.rootCause,
      reproSteps: c.reproSteps,
      runs: c.runs,
      needFromUser: c.needFromUser,
      afterUserCanDo: c.afterUserCanDo,
    });
  }
  if (state === TERMINAL.BLOCKED) {
    return buildBlockedReport({
      tried: c.tried,
      stuckAt: c.stuckAt,
      needFromUser: c.needFromUser,
      afterUserCanDo: c.afterUserCanDo,
    });
  }
  const L = [];
  L.push('【进度说明】这件事**还没做完**，所以我不把它当成交付完成：');
  if (c.pending && c.pending.length) L.push('· 还差：' + c.pending.join('、'));
  if (c.reason) L.push('· 原因：' + c.reason);
  L.push('· 我接下来按这个顺序继续找出路：改参数 → 换工具 → 换执行方式 → 拆小任务 → 改变写法（分次追加 / 拆成多个文件）。');
  L.push('· 你也可以直接说先做哪一部分，我照你的优先级来。');
  return L.join('\n');
}

// ===================== 二、禁止半成品交付（规范 §二） =====================
// 规范里点名最狠的一句：「已经完成，剩下 XXX 你可以自己处理。」
// 只要「剩下的事」是达成用户目标所必需的，任务就没完成 —— 这类话术必须被**拦下来**。

/** 「把剩余工作甩给用户」的话术。命中即违规（无例外）。 */
const HANDOFF_RE = new RegExp(
  [
    // 剩下/其余/后续 …（你）自己 … 处理/完成/做
    '(剩下|其余|剩余|后续|后面)[^。；;\\n]{0,12}(你|您|自己|自行|手动)[^。；;\\n]{0,12}(处理|完成|做|添加|创建|操作|填|改|弄|搞定|继续|补)',
    // （请/需要/要）你 自己/手动 …
    '(请|需要|要|由)(你|您)(自己|自行|手动)[^。；;\\n]{0,12}(处理|完成|做|添加|创建|操作|填|改|弄|搞定)',
    // 你自己处理 / 您自行完成
    '(你|您)(自己|自行|手动)[^。；;\\n]{0,10}(处理|完成|添加|创建|操作|填|改|弄|搞定)',
    // 交给你处理
    '交给?(你|您)[^。；;\\n]{0,8}(处理|完成|做|搞定)',
  ].join('|'),
  'g'
);

/** 「以能力不足为终点」的话术。**不单独算违规** —— 说明清白的 BLOCKED 是允许的，见 blockedEvidenced。 */
const CANNOT_RE = new RegExp(
  [
    '我(做|办|完)不了',
    '我(无法|不能|没办法|没法|没有办法)(完成|实现|做到|处理|继续|接着|往下|写入|生成)',
    '(这个|该|此)?功能?(实现不了|无法实现)',
    '工具(不支持|无法|做不到|办不到)',
    '当前(工具|环境|技能|版本)(不支持|无法|不允许)',
    '我(能力|权限|水平)有限',
  ].join('|'),
  'g'
);

/** 判定「已试过合理方案」的弱证据：试过/换过 出现 ≥2 次，或 1 次 + 枚举标记 ≥2 个。 */
function hasRecoveryEvidence(text) {
  if (!text) return false;
  const tried = (text.match(/(试过|尝试过|试了|已经试|换过|改用过|已排除|排查过)/g) || []).length;
  if (tried >= 2) return true;
  const marks = (text.match(/(①|②|③|④|⑤|第一|第二|其一|其二|1\\.|2\\.)/g) || []).length;
  return tried >= 1 && marks >= 2;
}

/**
 * 检测正文里的违规话术。
 * @returns {{hit:boolean, kind:'handoff'|'cannot'|null, matched:string, snippet:string}}
 */
function detectBailOut(text) {
  const none = { hit: false, kind: null, matched: '', snippet: '' };
  if (!text || typeof text !== 'string') return none;

  const h = new RegExp(HANDOFF_RE.source, 'g').exec(text);
  if (h) {
    return { hit: true, kind: 'handoff', matched: h[0], snippet: pickSnippet(text, h.index) };
  }
  const c = new RegExp(CANNOT_RE.source, 'g').exec(text);
  if (c) {
    return { hit: true, kind: 'cannot', matched: c[0], snippet: pickSnippet(text, c.index) };
  }
  return none;
}

function pickSnippet(text, idx) {
  const a = Math.max(0, idx - 24);
  const b = Math.min(text.length, idx + 48);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\n/g, ' ') + (b < text.length ? '…' : '');
}

/**
 * 违规话术是否**已经被允许**（即属于合法的 BLOCKED）。
 * 规范 §十三 要求进入 BLOCKED 前必须：已试过合理方案 + 已分析失败原因 + 已排除可替代方案；
 * §十四 又要求报告必须四段齐全。两个条件都满足，才承认它是"真的做不下去"，而不是"不想做"。
 */
function isLegitimateBlocked(text) {
  return hasRecoveryEvidence(text) && missingBlockedParts(text).length === 0;
}

/** 给模型的继续指令（不是给用户的）。 */
function bailOutDirective(hit) {
  const L = [];
  L.push('【还有关键步骤没做完，不许这样收尾】');
  if (hit && hit.matched) {
    L.push('你上一条回答里出现了这句话：**「' + hit.matched + '」**（原句：' + (hit.snippet || '') + '）');
  }
  L.push('· 这是被明令禁止的：**剩下的工作只要是为完成用户目标所必需的，任务就不算完成**，不能列出来交给用户自己处理，也不能把它描述成"小问题"。');
  L.push('· 同样禁止的还有：做了一半就说完成 / 代码写出来就说完成 / 工具调用成功就说完成 / 一个方案失败就不再试别的。');
  L.push('· **工具是手段，不是目标。**某个工具失败、某个方案走不通、某个文件写不进去，都只说明**这个方法**不行，不代表这件事做不了。');
  L.push('· 现在继续做。按这个顺序找出路，逐个试，不要在同一个做法上原地重试：');
  L.push('  ① 改参数（补齐 / 改对格式）→ ② 换工具（换一个能干同一件事的技能）→ ③ 换执行方式（例如写文件改成用命令写、改成 shell + 临时文件）→ ④ 拆小任务（分步做、分次写）→ ⑤ 改变写入策略（加 "mode":"append" 分次追加，或拆成多个小文件）。');
  L.push('· 确实需要用户介入时（缺账号 / 缺业务决策 / 目标系统连不上 / 权限拿不到），才允许停下来，'
    + '并且必须四段都说清：**我已经做了什么 / 现在卡在哪 / 你只需要提供什么 / 拿到之后我会做什么**。');
  L.push('· 现在请继续执行，不要再把工作交回给我。');
  return L.join('\n');
}

// ===================== 二·补、先证伪自己的第一判断（假设 ≠ 事实）[人设「二十一」] =====================
// 为什么补在这里：人设「### 二十一、先证伪自己的第一判断（假设 ≠ 事实）」此前**只是文字**，
// 零运行时强制。这是整套规则里最隐蔽的失败模式 —— 模型**不需要说错话**，
// 只要把一条**没验证过的归因**说成结论，用户就会拿它当事实去做决策。
//
// ★ 完全照 §二 的现成范式走（不发明新架构）：
//   detectBailOut(弱判定)        → bailOutDirective(纠正指令)  → missingBlockedParts(决定终态)
//   detectCausalClaim(弱判定)    → falsificationDirective(纠正指令) → missingFalsificationParts(决定终态)
//   「弱判定」= 命中**只算可疑**，不单独违规：有反证、或明说"这只是推断/尚未验证"，一律放行。
//   ⚠️ 这一点至关重要：**误拦正确的假设表述比漏拦更糟** —— 模型会学会"干脆不说假设"，
//      正好把 §21 反着执行。

/**
 * 「把假设当结论用」的归因话术。**保守收词**：只收明确的下结论式归因。
 * 刻意**不收**「可能是 / 我怀疑 / 初步判断 / 也许 / 似乎」—— 那些正是**正确**的假设表述，拦它们就是拦对了。
 */
const CAUSAL_CLAIM_RE = new RegExp(
  [
    // 「就是/正是 … 导致/造成/引起的」
    '(就是|正是)[^。；;\\n]{0,12}(导致|造成|引起的|引起)',
    // 「就是因为/由于 …」（挡住「不一定是因为」）
    '(?<![不无])就是(因为|由于)',
    // 「原因就在于/原因就是 …」
    '原因(就)?(在于|就是)',
    // 「根因就是/根因在于 …」（挡住「根因是不是…」这种问句）
    '根因(就是|在于|是(?![不否]))',
    // 「根本原因/根源 出在/在于 …」（刻意不含裸「在」，否则「根源在哪里？」这种问句会被误拦）
    '(根本原因|根源|根因)(就)?(出在|在于)',
    // 「说明/表明/可见 … 有问题/存在…」（挡住「不能说明」）
    '(?<![不不能无])(说明|表明|可见)[^。；;\\n]{0,10}(有|存在|出)(问题|冲突|异常|错误|bug|BUG)',
    // 「肯定（是/因为/由于）」
    '肯定(是|因为|由于)',
    // 「一定是（因为/由于）」（挡住「不一定是因为」）
    '(?<![不无])一定是(因为|由于)',
    // 「可以确定（是/就是）」
    '可以确定(是|就是)',
  ].join('|'),
  'g'
);

/**
 * 检测「把假设当结论用」的归因话术。
 * @returns {{hit:boolean, matched:string, snippet:string}}
 */
function detectCausalClaim(text) {
  const none = { hit: false, matched: '', snippet: '' };
  if (!text || typeof text !== 'string') return none;
  const m = new RegExp(CAUSAL_CLAIM_RE.source, 'g').exec(text);
  if (!m) return none;
  return { hit: true, matched: m[0], snippet: pickSnippet(text, m.index) };
}

/** ① 找反证的**动作**（与 hasRecoveryEvidence 同为弱证据口径：有动作即认）。 */
const FALSIFICATION_ACTION_RE = new RegExp(
  [
    '对照', '反证', '证伪', '排除', '复现', '重现', '独立复核', '反向验证',
    '换个批次', '换批次', '换了[^。；;\\n]{0,8}再试', '又试了[^。；;\\n]{0,8}(一次|一遍)',
  ].join('|')
);

/** ② **显式**承认"还没验证"的声明 —— 诚实标注必须被放行，而不是被罚。 */
const UNVERIFIED_DECLARATION_RE = new RegExp(
  [
    '这只是(推断|假设|猜测)', '仅(是|为)?(推断|假设|猜测)',
    '尚未验证', '还没验证', '没有验证', '未经验证',
    '待确认', '尚未确认', '还没确认', '不确定',
    '尚无证据', '还没有证据', '没有证据支持',
  ].join('|')
);

/**
 * 是否已经做过「证伪自己」的动作，或已显式声明「这还是推断 / 尚未验证」。
 * 命中任一 ⇒ 放行（这正是 §21 要的行为，不是违规）。
 */
function hasFalsificationEvidence(text) {
  if (!text || typeof text !== 'string') return false;
  return FALSIFICATION_ACTION_RE.test(text) || UNVERIFIED_DECLARATION_RE.test(text);
}

/**
 * 缺失部分（沿用 missingBlockedParts 的口径：返回中文标签数组，空数组 = 合格）。
 * 只有在「命中归因」且「既无反证动作、也无未验证声明」时才非空。
 */
function missingFalsificationParts(text) {
  if (!text || typeof text !== 'string') return [];
  if (!detectCausalClaim(text).hit) return [];
  if (hasFalsificationEvidence(text)) return [];
  return ['未提供反证或未验证声明'];
}

/** 给模型的纠正指令（**不是**给用户看的）。要教它怎么补，不是单纯骂。 */
function falsificationDirective(hit) {
  const L = [];
  L.push('【先证伪自己的第一判断（假设 ≠ 事实）】');
  if (hit && hit.matched) {
    L.push('你上一条回答里出现了这句话：**「' + hit.matched + '」**（原句：' + (hit.snippet || '') + '）');
  }
  L.push('· 你的这个判断**目前只是假设**。在把它当结论之前，说明你**做过哪一步去找反证**；没做就现在做。');
  L.push('· 如果只找到支持它的证据，必须明说「这还是推断，因为 XX 还没验证」—— 不要把它写成结论。');
  L.push('· 记住真正的教训：**同批里目标失败、对照成功时，先问「对照换个批次还会成功吗」；'
    + '如果对照下一批也失败，说明整批结论作废。**');
  L.push('· 现在补上你的反证步骤（或把结论改写成"未验证的推断"），然后继续。');
  return L.join('\n');
}

// ===================== 三、BLOCKED 四段式报告（规范 §十三 / §十四） =====================
// 不许只说「任务失败，请检查环境」；必须让用户知道：已经做了什么、真正卡在哪、
// 他只需要提供什么、提供之后能继续做什么。
const BLOCKED_PARTS = [
  // ⚠️ did 段刻意放宽：「我试过 X」「尝试过 Y」「已排查 Z」都是陈述"做了什么"的自然中文，
  // 若只认「我已经/已经」，模型换个说法就会被误判成"没交代做过什么"，进而被要求重写一遍。
  { key: 'did', label: '我已经做了什么', re: /(我已经|我已|已经|我试过|试过|尝试过|排查过|已(排查|检查|尝试|试))/ },
  { key: 'stuck', label: '现在卡在哪', re: /(卡在|卡住|卡点|受阻|无法继续的原因|原因是我)/ },
  { key: 'need', label: '需要你提供什么', re: /(只需要|需要你|请你?(提供|给|告知|确认|授权))/ },
  { key: 'after', label: '拿到之后我会做什么', re: /(拿到|提供后|之后我|给到之后|接着我|就可以继续)/ },
];

/** 返回四段里**缺失**的部分（中文标签数组）。空数组 = 格式合格。 */
function missingBlockedParts(text) {
  if (!text) return BLOCKED_PARTS.map((p) => p.label);
  return BLOCKED_PARTS.filter((p) => !p.re.test(text)).map((p) => p.label);
}

/** 按规范生成四段式阻塞报告。缺的参数用「（见上）」兜底，绝不留空。 */
function buildBlockedReport(o) {
  const c = o || {};
  const L = [];
  L.push('这件事我做到这里，**需要你提供一个东西才能继续**（不是失败，是确实缺这个）：');
  L.push('· 我已经做了什么：' + (c.tried || '（见上）'));
  L.push('· 现在卡在哪：' + (c.stuckAt || '（见上）'));
  L.push('· 你只需要提供：' + (c.needFromUser || '（见上）'));
  L.push('· 拿到之后我会：' + (c.afterUserCanDo || '接着往下做完，并把结果给你'));
  return L.join('\n');
}

/**
 * 第四档（BLOCKED_WITH_DIAGNOSIS）的报告：卡点 + 诊断 + 复现步骤 + 实测次数 + 只差什么。
 *
 * 为什么不能直接复用 buildBlockedReport：那一段的标题是「**需要你提供一个东西才能继续**」，
 *   而第四档的重点不在这儿 —— 它已经把问题定位到"照着跑就能再现"。套进那句话会说成
 *   "我没办法，等你给东西"，用户拿不到最有价值的东西：**复现步骤**。
 * 骨架沿用四段式（做了什么 / 卡在哪 / 你只需要提供什么 / 拿到之后我做什么），
 *   中间插入"诊断 + 复现步骤 + 我跑了几次"，因为那正是这一档与 BLOCKED 的全部差别。
 * @param {{tried?:string, stuckAt?:string, diagnosis?:string, reproSteps?:string[]|string,
 *          runs?:number, needFromUser?:string, afterUserCanDo?:string}} o
 */
function buildDiagnosedBlockedReport(o) {
  const c = o || {};
  const steps = Array.isArray(c.reproSteps)
    ? c.reproSteps.map((s) => String(s)).filter((s) => s.trim())
    : (c.reproSteps ? [String(c.reproSteps)] : []);
  // runs 不合法（NaN / 0 / 负数）时**不许编一个数出来**：写"反复跑过"，让读者知道没记下确切次数。
  const runs = Number.isFinite(c.runs) && c.runs > 0 ? Math.floor(c.runs) : null;
  const L = [];
  L.push('这件事**卡住了，但我已经把卡点定位到可复现**（不是"我没办法"，是我能证明它每次都一样地卡）：');
  L.push('· 我已经做了什么：' + (c.tried || '（见上）'));
  L.push('· 卡在哪：' + (c.stuckAt || '（见上）') + (c.diagnosis ? '｜我的诊断：' + c.diagnosis : ''));
  L.push('· 复现步骤（照着跑就能再现同一处失败）：'
    + (steps.length ? steps.map((s, i) => (i + 1) + ') ' + s).join('；') : '（见上面的命令）'));
  L.push('· 实测：' + (runs === null ? '我按上面的步骤反复跑过' : '我跑了 ' + runs + ' 次')
    + '，每次都是同一处失败、同一段输出 —— 所以这不是偶发，也不是"环境一时不好"。');
  L.push('· 你只需要提供：' + (c.needFromUser || '（见上）'));
  L.push('· 拿到之后我会：' + (c.afterUserCanDo || '按上面的复现步骤继续定位，直到修好并重新验证'));
  return L.join('\n');
}

// ── 三·补、判定"诊断是否真的可复现"（2026-02-16，第四档的机械判据）────────────────
// 为什么必须靠执行证据、不许靠正则自述：
//   BLOCKED 的门槛此前**全在正文文字里** —— hasRecoveryEvidence 数"试过/换过"，BLOCKED_PARTS 是四条纯正则。
//   于是"卡住了"和"卡住了、而且真的定位到可复现"在机器眼里长得一模一样：正文里写一句
//   "我已复现"就能骗过任何文本判据。而这两件事对用户的含义天差地别 ——
//   后者用户拿去就能自己再现、能直接找对人修；前者只是一句"我不行了"。
// ⇒ 判据落到**本任务的真实执行记录**（taskTrace 的 tool 事件）上：
//   正文给出的那条复现命令，必须在记录里被跑过 **≥2 次**、每次都失败、且失败输出一致。
//   ★ "一次不算"是核心：一次失败可能只是运气/环境抖动；两次同一处失败才配叫"可复现"。
//   ★ 本函数只回答"这一步的证据够不够"，**不产出终态**（终态仍归 classifyTerminalState）。

/** 常见命令词的命令头（用来判断一段反引号内容"像不像一条能跑的命令"，与安全性判定无关）。 */
const PROBE_COMMAND_HEADS = [
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'git', 'python', 'python3', 'py',
  'curl', 'wget', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cat', 'ls', 'dir', 'find',
  'findstr', 'grep', 'rg', 'tar', 'zip', 'unzip', 'java', 'javac', 'tsc', 'make', 'cmake',
  'cargo', 'go', 'dotnet', 'ruby', 'perl', 'php', 'sed', 'awk', 'docker', 'msbuild',
];
/** 可执行脚本后缀（没有常见命令头时，靠它判断"这串是要跑的东西"，不是文件名）。 */
const PROBE_EXEC_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|sh|ps1|bat|cmd|rb|pl|jar)\b/i;

/** 取一条命令的"命令头"（去掉目录前缀与 .exe，小写）——`C:\...\node.exe` ⇒ `node`。 */
function probeHeadOf(cmd) {
  const t = String(cmd == null ? '' : cmd).trim();
  if (!t) return '';
  const first = t.split(/\s+/)[0] || '';
  const base = first.split(/[\\/]/).pop() || '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

/**
 * 这段候选文本"像不像一条能跑的命令"。
 * 判据（两条任一）：必含空白（至少两个 token）；且
 *   ① 第一个 token 是常见命令词（PROBE_COMMAND_HEADS），或
 *   ② 串里带可执行脚本后缀（`./scripts/probe.mjs --x` 这种自带路径的写法）。
 * ⚠️ 为什么要求"必含空白"：正文里被反引号包住的东西大多是**文件名/变量名/字段名**
 *   （`deliveryProtocol.js`、`toolEvents`、`reproducible`），它们不含空格 ⇒ 一律不算命令。
 */
function looksLikeProbeCommand(cand) {
  const t = String(cand == null ? '' : cand).trim();
  if (!t) return false;
  if (!/\s/.test(t)) return false;
  if (PROBE_COMMAND_HEADS.indexOf(probeHeadOf(t)) >= 0) return true;
  return PROBE_EXEC_EXT_RE.test(t);
}

/**
 * 从正文里抽一条"最像复现命令"的东西。
 * 优先级（抽到即返回）：① 反引号包裹且长度 ≥8 的片段；② 以 `$ ` / `> ` 开头的行。
 * @param {string} content
 * @returns {string} 抽到的命令原文；抽不到 ⇒ ''
 */
function extractDiagnosisProbe(content) {
  const text = String(content == null ? '' : content);
  if (!text) return '';
  // ⚠️ 这个正则**必须**用 `new RegExp('…')` 拼，不许写成 `/`…`/` 的正则字面量。
  //   实测原因（2026-02-16，本轮真踩了）：`scripts/smoke/unit-protocol-wiring.mjs` 的
  //   注释/字符串剥离器 `stripSource` **不认正则字面量** —— 它遇到反引号就进"模板串"状态，
  //   于是正则里那对反引号把它后面的**整份文件**当成模板串抹掉，`reportClaimGate` 的调用点
  //   被抹成空白 ⇒ 该门禁把它判成"零调用" ⇒ 真实锚点自检红（看起来像接线丢了，其实是剥离器）。
  //   写成字符串实参后，剥离器按单引号串处理，反引号只是串内容 ⇒ 不再有跨行状态泄漏。
  const tickRe = new RegExp('`([^`]{8,})`', 'g');
  let m = tickRe.exec(text);
  while (m) {
    const cand = String(m[1] || '').trim();
    if (looksLikeProbeCommand(cand)) return cand;
    m = tickRe.exec(text);
  }
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    const hit = /^\s*[$>]\s+(.*)$/.exec(ln);
    if (!hit) continue;
    const cand = String(hit[1] || '').trim();
    if (looksLikeProbeCommand(cand)) return cand;
  }
  return '';
}

/**
 * 比对用的归一化（命令与输出**共用同一套规则**，否则两边口径不同 ⇒ 命中率靠运气）。
 *
 * 逐条规则与理由：
 *   ① 空白折叠成单空格 + 去首尾 —— 同一条命令换个换行/多打一个空格仍是同一条；
 *   ② 时间戳 `\d{4}-\d{2}-\d{2}T[\d:.+\-Z]+` → `‹ts›` —— 每次跑的时间必然不同，
 *      不抹掉它，"输出一致"永远判不成立（等于第四档永远不会被承认）；
 *   ③ `0x[0-9a-fA-F]{6,}` → `‹hex›` —— 指针/句柄/内存地址每次都变，与失败本质无关；
 *   ④ 临时路径（/tmp、/var/folders、/private/var、Windows 的 `…\AppData\Local\Temp`）→ `‹tmp›`
 *      —— 同一个门禁跑两次的临时目录名不同，那是环境噪声不是复现证据；
 *   ⑤ 连续 4 位以上数字 → `‹n›` —— 时间戳残留的毫秒数、字节数、端口号、PID 这类长数字。
 *   ★ 为什么不把"所有数字"都归一化：**行号 / 断言编号 / 计数**的差异正是"输出不一致"的正当信号。
 *     把它们一起抹掉，会把真正的不一致判成一致 —— 那是假绿，比漏判严重得多。
 *     只抹 4 位以上的长数字（时间戳/字节数/端口），保留小整数。
 * @param {*} raw
 * @returns {string}
 */
function normalizeDiagnosisText(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\d{4}-\d{2}-\d{2}T[\d:.+\-Z]+/g, '‹ts›');
  s = s.replace(/0x[0-9a-fA-F]{6,}/g, '‹hex›');
  // Windows 临时目录：正斜杠/反斜杠两种写法都要认（trace 里两种都出现过）。
  s = s.replace(/(?:\/tmp|\/var\/folders|\/private\/var|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+[\\/]+AppData[\\/]+Local[\\/]+Temp)[^\s]*/g, '‹tmp›');
  s = s.replace(/\d{4,}/g, '‹n›');
  return s;
}

/**
 * 判定一个 BLOCKED 的"诊断"是否**真的可复现**。
 * ★ 为什么不能用正则判：正文里写一句"我已复现"就能骗过任何文本判据。
 *   本函数要求：正文给出的复现命令，必须在**本任务的真实执行记录**里被跑过 ≥2 次，
 *   每次都复现同一个失败，且输出一致。
 *
 * 判定顺序即语义（每一条不通过就返回对应 reason，不许跳过）：
 *   1) 抽 probe —— 抽不到 ⇒ 'no-probe'
 *   2) 在 trace 的 tool 事件里按 `params.command` 前缀包含匹配 probe：
 *        命中 0 ⇒ 'probe-not-executed'；命中 1 ⇒ 'not-repeated'（一次不算可复现）；
 *        命中 ≥2 但有任何一条 `ok === true` ⇒ 'not-reproducible'（跑成功了 ⇒ 这个卡点不复发）
 *   3) 输出一致性 —— 命中记录的 `resultHead` 归一化后取前 80 字，必须全部相同，
 *        否则 ⇒ 'inconsistent-output'
 *   4) 全过 ⇒ reproducible:true / reason:'ok'
 *
 * ★ 边界（如实写在代码里，不假装全能）：
 *   · trace 的 `params` 里命令**只保留 ≤400 字**、`resultHead` **只保留 ≤800 字**
 *     （见 src/main/taskTrace.js 的 HEAD_LIMITS）。所以：
 *       - 命令超长时只能做**前缀比对**（两边谁长都算命中，见下）；
 *       - 输出超过 800 字的部分看不到 ⇒ 差异可能漏检。
 *   · **漏检的方向是安全的**：漏检只会把本该判"可复现"的判成"不可复现"
 *     （少给一次有效交付），绝不会把假诊断判成真。宁可少给一次，也不许给假的。
 *   · resultHead 全部缺失（trace 没记输出）⇒ 也算"不可复现"：没有输出就证明不了
 *     "每次都是同一个失败"，缺证据按不成立算（与 §十四③「写不出证据 ＝ 没检查」同源）。
 *
 * @param {object} o
 * @param {string} o.content  正文全文
 * @param {Array}  o.toolEvents  trace 的 tool 事件数组（{name, params, ok, resultHead, …}）
 * @returns {{reproducible:boolean, reason:string, probe:string, runs:number}}
 *   reason ∈ 'ok' | 'no-probe' | 'probe-not-executed' | 'not-repeated' | 'not-reproducible' | 'inconsistent-output'
 */
function classifyBlockedDiagnosis(o) {
  const c = o || {};
  const events = Array.isArray(c.toolEvents) ? c.toolEvents : [];
  const probe = extractDiagnosisProbe(c.content);
  if (!probe) return { reproducible: false, reason: 'no-probe', probe: '', runs: 0 };
  const normProbe = normalizeDiagnosisText(probe);

  // 命中判定：允许"记录里的命令比 probe 更长"（带上额外参数 / 换了个入口脚本），
  // 也允许"probe 被正文写得更长"（用户看到的是一整条命令，记录里只记了前半段被截断）
  // ⇒ 双向前缀包含都算命中。这是**唯一**能用的判据：命令被 400 字截断后不可能再逐字相等。
  const hits = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const params = e.params;
    const cmd = params && typeof params === 'object' ? params.command : '';
    if (typeof cmd !== 'string' || !cmd.trim()) continue;
    const normRecord = normalizeDiagnosisText(cmd);
    if (!normRecord) continue;
    if (normRecord.indexOf(normProbe) === 0 || normProbe.indexOf(normRecord) === 0) hits.push(e);
  }

  if (hits.length === 0) return { reproducible: false, reason: 'probe-not-executed', probe, runs: 0 };
  if (hits.length === 1) return { reproducible: false, reason: 'not-repeated', probe, runs: 1 };
  // 有任何一次跑成功了 ⇒ 这个"卡点"不是稳定复现的（可能是环境抖动，或已经修好了）。
  if (hits.some((e) => e.ok === true)) {
    return { reproducible: false, reason: 'not-reproducible', probe, runs: hits.length };
  }

  const heads = hits.map((e) => normalizeDiagnosisText(e.resultHead).slice(0, 80));
  const first = heads[0];
  const allEmpty = heads.every((h) => !h);
  if (allEmpty || heads.some((h) => h !== first)) {
    return { reproducible: false, reason: 'inconsistent-output', probe, runs: hits.length };
  }
  return { reproducible: true, reason: 'ok', probe, runs: hits.length };
}

// ===================== 四、决策选项（规范 §五 / §六 / §八 / §九） =====================
// 三种情况必须分开处理：
//   1) 自己能解决 ⇒ 直接做，不要问用户；
//   2) 有多个合理方案、用户偏好会影响结果 ⇒ 给 3-5 个选项（说明结果与代价），等他选；
//   3) 没有用户决策就无法继续 ⇒ 一次只问**真正阻塞**的那一件事。
// 并且：用户说「你看着办」时不许继续追问技术细节，要自己选一条并说明。

const DECISION = {
  SELF: 'SELF', // 自己能解决
  CHOOSE: 'CHOOSE', // 需要用户选一个方向
  BLOCKING: 'BLOCKING', // 不决策就无法继续
};

/**
 * 渲染决策选项块（规范 §六 / §八 的格式）。
 * @param {object} o
 * @param {string} o.question
 * @param {Array<{label:string,effect:string,cost?:string}>} o.options 3-5 项
 * @param {number} [o.defaultIndex] 用户不选时默认按第几项（0-based）
 */
function buildDecisionOptions(o) {
  const c = o || {};
  const options = Array.isArray(c.options) ? c.options : [];
  const L = [];
  L.push(c.question || '这里有个方向需要你定一下：');
  L.push('');
  options.forEach((it, i) => {
    L.push((i + 1) + '. ' + it.label + '：' + it.effect + (it.cost ? '（代价：' + it.cost + '）' : ''));
  });
  L.push((options.length + 1) + '. 你直接说想怎么做也行');
  const d = Number.isInteger(c.defaultIndex) && c.defaultIndex >= 0 && c.defaultIndex < options.length ? c.defaultIndex : 0;
  L.push('');
  L.push('你不懂技术细节没关系，不用你定这些。**你不选我就直接按 ' + (d + 1) + ' 继续**'
    + (options[d] ? '（' + options[d].label + '）' : '') + '。');
  return L.join('\n');
}

/** 选项数量是否合规（规范 §六：3～5 个；不是越多越好，也不许凑数）。 */
function isValidOptionCount(n) {
  return Number.isInteger(n) && n >= 3 && n <= 5;
}

// ===================== 五、失败后的降级链（规范 §四 / §十 / §十一） =====================
// 「不要原地重试，要改变方法」。同一个工具第一次失败 → 分析并修正；再次失败 → 禁止原样重发。
const FALLBACK_LADDER = {
  // 写文件 / 写内容类
  write: [
    '换一种写入方式：用执行命令的方式把内容写进文件',
    '再不行就「写shell + 临时文件」，然后移动到目标位置',
    '内容太长被截断时：先写最小可用版本，再加 "mode":"append" 一段段追加',
    '或者把一个巨大的文件拆成几个小文件',
  ],
  // 取数据 / 抓网页类
  fetch: [
    '换一个等价来源取同一份信息',
    '改用联网搜索取同一事实',
    '降低一次取回的规模（少取一点、分页取）',
  ],
  // 兜底
  generic: [
    '改参数后**只重试一次**（必须是改过东西的重试）',
    '换一个能干同一件事的工具',
    '换执行方式（命令 / 脚本 / 分段）',
    '把任务拆小，分步完成',
  ],
};

/**
 * 渲染降级链文本，供工具失败时喂给模型。
 * @param {'write'|'fetch'|'generic'} purpose
 */
function fallbackLadderText(purpose) {
  const key = FALLBACK_LADDER[purpose] ? purpose : 'generic';
  const L = ['· 这条路走不通就按下面顺序换方法（**工具是可以替换的，目标不能放弃**）：'];
  FALLBACK_LADDER[key].forEach((s, i) => L.push('  ' + (i + 1) + ') ' + s));
  return L.join('\n');
}

// ===================== 六、措辞纪律（规范 §十五：绝不假装完成） =====================
// 只能说**已经验证过**的那一步。没 build 就不能说发布完成；没实际看页面就不能说页面正常。
const SCOPE_EXAMPLES = [
  { done: '代码已修改', notYet: '还没有完成构建验证' },
  { done: '构建已通过', notYet: '还没有实际打开页面确认效果' },
  { done: '前端已完成', notYet: '后端还没做完' },
];

/**
 * 生成「只说到哪一步」的收尾措辞。
 * @param {{done?:string[], notYet?:string[]}} o
 */
function scopedCompletionStatement(o) {
  const c = o || {};
  const done = Array.isArray(c.done) ? c.done : [];
  const notYet = Array.isArray(c.notYet) ? c.notYet : [];
  const L = [];
  if (done.length) L.push('已经做到的：' + done.join('、') + '。');
  if (notYet.length) L.push('还没做到、所以我**不会说已经完成**的：' + notYet.join('、') + '。');
  if (!done.length && !notYet.length) return '';
  return L.join('\n');
}

/** 正文里是否出现「完成」类断言（供门禁/收尾做交叉核对，不单独拦截）。 */
function claimsCompletion(text) {
  if (!text) return false;
  return /(已(经)?完成|已完成|全部做完|都做好了|搞定了|已经搞定)/.test(text);
}

// ============ 七、Agent 状态机（规范 §十一 / §三十一） ============
// 规范 §31 给的是**流程图**，这里落成**状态与转移**，让「什么时候继续/询问/修复/完成/阻塞」
// 有唯一真源（而不是散落在 backend 各处的 if 里 —— 散着写就会漏掉某条出口，
// 本项目已经吃过一次亏：轮次上限那条出口写死"完成"，与它自己设的 incomplete 自相矛盾）。
const STATE = {
  UNDERSTAND: 'UNDERSTAND',   // 理解用户真正要的**最终结果**
  DISCOVER: 'DISCOVER',       // 检查真实环境（规范 §19/§20：不许猜项目结构）
  PLAN: 'PLAN',
  EXECUTE: 'EXECUTE',
  VERIFY: 'VERIFY',
  ANALYZE: 'ANALYZE',                  // 失败后先分析原因（不是马上重试）
  RECOVER: 'RECOVER',                  // 修参数后重走 EXECUTE
  CHANGE_STRATEGY: 'CHANGE_STRATEGY',  // 换方法（规范 §七/§十一：不许原地打转）
  ASK_USER: 'ASK_USER',                // 只有真正阻塞的那一件事才问
};

// 转移表：happy path 一路向前；任何失败都先进 ANALYZE，再由 ANALYZE 决定"修 / 换 / 问 / 阻塞"。
// ★ 注意：EXECUTE 失败**不允许**直接回 EXECUTE（那就是原地打转）。
const STATE_TRANSITIONS = {
  [STATE.UNDERSTAND]: { ok: STATE.DISCOVER, fail: STATE.ANALYZE },
  [STATE.DISCOVER]: { ok: STATE.PLAN, fail: STATE.ANALYZE },
  [STATE.PLAN]: { ok: STATE.EXECUTE, fail: STATE.ANALYZE },
  [STATE.EXECUTE]: { ok: STATE.VERIFY, fail: STATE.ANALYZE },
  [STATE.VERIFY]: { ok: TERMINAL.COMPLETE, fail: STATE.ANALYZE },
  [STATE.ANALYZE]: {
    retryable: STATE.RECOVER,            // 改对参数就能好
    change: STATE.CHANGE_STRATEGY,       // 参数没错、得换方法
    need_user: STATE.ASK_USER,           // 只有用户能决定
    exhausted: TERMINAL.BLOCKED,         // 合理路径都试过了
    partial: TERMINAL.PARTIAL,           // 做了一部分、还差关键工作
  },
  [STATE.RECOVER]: { ok: STATE.EXECUTE },
  [STATE.CHANGE_STRATEGY]: { ok: STATE.EXECUTE },
  [STATE.ASK_USER]: { ok: STATE.EXECUTE },
};

/**
 * 状态机推进。
 * @param {string} state STATE 之一
 * @param {string} outcome 'ok' | 'fail' | 'retryable' | 'change' | 'need_user' | 'exhausted' | 'partial'
 * @returns {string} 下一个状态（可能是 TERMINAL.COMPLETE/PARTIAL/BLOCKED）
 */
function nextState(state, outcome) {
  const row = STATE_TRANSITIONS[state];
  if (!row) return STATE.ANALYZE;
  const nx = row[outcome];
  // 没有这条转移 ⇒ 回到分析，绝不放行到终点（宁可多分析一次，也不许假装完成）
  return nx || STATE.ANALYZE;
}

/**
 * 状态机是否已到终点（供收尾逻辑判断"还能不能继续"）。
 *
 * ★ 2026-02-16 改成**从 TERMINAL 词表派生**，不再手抄三个值。理由就是本函数上一版的病史：
 *   它把 COMPLETE / PARTIAL / BLOCKED 三个值硬编码在一条 `||` 里，于是新增
 *   BLOCKED_WITH_DIAGNOSIS 之后，第四档会被判成"不是终点"—— 语义正好反了：
 *   它明明是终点（卡住了、不再继续），却被当成"还能继续推进"的状态。
 *   手抄的清单每加一档就会漏一次，而漏了不会报错（只是判断反了）⇒ 现在派生。
 * @param {string} state
 * @returns {boolean}
 */
function isTerminalState(state) {
  return Object.keys(TERMINAL).some((k) => TERMINAL[k] === state);
}

// ============ 八、验证失败分诊（规范 §二十三） ============
/**
 * 「验证没通过」有两种完全不同的原因，**必须分开**：
 *   ① 验证工具自己坏了（浏览器起不来、CDP 连不上、截图失败）—— 产品可能根本没事；
 *   ② 产品真的坏了。
 * 为什么必须分：把它俩混在一起，会让人去改**不存在的东西**（规范 §23 原话：
 * "不要把测试工具的问题误报成产品问题"）；反过来也会把真 bug 放过去。
 *
 * @param {{toolFailed?:boolean, productSignal?:('broken'|'ok'|'unknown')}} o
 * @returns {('tool'|'product'|'unknown')}
 */
function classifyVerificationFailure(o) {
  const c = o || {};
  const toolFailed = !!c.toolFailed;
  const signal = c.productSignal || 'unknown';
  if (!toolFailed) {
    if (signal === 'broken') return 'product';
    return 'unknown'; // 没有工具失败、也没有产品坏信号 ⇒ 无从判定，别硬下结论
  }
  // 工具确实挂了：如果同时还有"产品坏了"的证据，说明**两者都可能**（工具坏了也可能误报产品坏）
  // ⇒ 只能判 unknown，要求换一种方式复核；不能直接把账算在产品头上。
  if (signal === 'broken') return 'unknown';
  return 'tool';
}

/**
 * 验证分诊结论的**人话**说明（规范 §18：用户不需要懂技术）+ 下一步动作。
 * @param {('tool'|'product'|'unknown')} verdict
 */
function verificationVerdictText(verdict) {
  if (verdict === 'tool') {
    return '这次"没验证过"是**验证工具本身没跑起来**（不是页面/功能坏了）。我会换一种方式重新验证，不会拿它当结论。';
  }
  if (verdict === 'product') {
    return '这次是真的发现**产品有问题**（不是验证工具的问题）。我去修，修完重新验证。';
  }
  return '现在还分不清是"验证工具坏了"还是"东西真的坏了"。我会换一种验证方式复核；在复核清楚之前，**我不会说已经完成，也不会说它坏了**。';
}

// ============ 九、主动发现真实环境（规范 §十九 / §二十） ============
// §19：不要把「当前上下文里的文件」当成「项目全部文件」；§20：不允许猜项目结构。
// 这两条是同一种事故的两面 —— 猜错载体/猜错目录，然后把任务做在了错的地方（本项目 09-17 真实踩过：
// 老板说"档期功能没做"，其实是做在了错的角色和宿主上）。
const DISCOVERY_CHECKLIST = [
  '项目入口在哪（package.json / 主入口文件 / index.html 等）',
  '页面与路由在哪（路由表 / 页面目录）',
  '后端与接口在哪（服务端目录 / API 定义）',
  '构建与运行配置在哪（构建脚本 / 环境变量 / 端口）',
  '**目标运行在哪里**（本地 / 服务器 / 桌面客户端 / 内嵌页 / 小程序）——这决定了改完怎么生效、要不要发版',
];

/**
 * 环境发现指令（在做"改代码/改页面"这类任务前推给模型）。
 * @param {{goal?:string, seen?:string, suspectWrongHost?:boolean}} o
 */
function discoveryDirective(o) {
  const c = o || {};
  const L = [];
  L.push('【先确认你在改的是**真正的那份代码**】');
  if (c.goal) L.push('· 用户要的最终结果是：' + c.goal);
  if (c.seen) L.push('· 你现在看到的：' + c.seen);
  if (c.suspectWrongHost) {
    L.push('· ⚠️ 你看到的载体和用户描述的**可能不是同一个东西**（典型：用户说改网站，你手上是小程序的代码）。');
    L.push('· **先确认目标是什么、跑在哪里、真正的代码在哪**，确认之后再动手；不许先改起来再说。');
  }
  L.push('· 动手前至少查清这几项：' + DISCOVERY_CHECKLIST.join('；') + '。');
  L.push('· 🔴 **不许猜项目结构**（"应该有 pages/user-info 吧"）然后直接创建。先看真实的目录与入口，再决定改哪里。');
  return L.join('\n');
}

// ============ 十、并列问题不许漏（规范 §二十四） ============
// §24 的实质：一个"看起来是一个需求"的改动，往往有**多个独立来源**共同决定最终效果。
// 典型：让"整个页面变红" —— 改完 CSS 只是其中一个来源，SVG 里的硬编码色、图片本身、
// 组件库默认色、TabBar 配置色都还在。只改一处就说"页面已经变红"＝没做完。
const PARALLEL_SITE_HINTS = [
  '样式表 / CSS 变量',
  '图标与图形（SVG 里的硬编码颜色、图片/图标文件本身）',
  '组件库或框架的默认主题配置',
  '导航/TabBar/状态栏等**独立配置**的地方',
  '文案里写死的字面量',
  '后端返回的数据（或数据库里的存量数据）',
  '**已经生成并留存的历史产物**（旧缓存、旧的持久化结果、已发布的静态页）',
];

/**
 * 并列问题排查指令。
 * @param {{goal?:string, sites?:string[], changed?:string[]}} o
 */
function parallelIssueDirective(o) {
  const c = o || {};
  const L = [];
  L.push('【改一处 ≠ 改完：先找出**所有**会影响最终效果的来源】');
  if (c.goal) L.push('· 目标效果：' + c.goal);
  const changed = Array.isArray(c.changed) ? c.changed : [];
  if (changed.length) L.push('· 你已经改的：' + changed.join('、') + '。');
  L.push('· 同类来源通常还包括：' + (Array.isArray(c.sites) && c.sites.length ? c.sites.join('；') : PARALLEL_SITE_HINTS.join('；')) + '。');
  L.push('· 逐个核对还有哪些没改；**只要还有一处会影响最终效果，就不能说"已经完成"**。');
  L.push('· 核对完再汇报，并说明你一共确认了哪几处、哪几处改过、哪几处本来就不需要改。');
  return L.join('\n');
}

// ============ 十一、收尾只说重要的（规范 §29 + §十三） ============
// §29 明确禁止把"调用了 17 个工具 / 重试了 4 次"这类**过程噪音**倒给用户。
// §13「最终交付格式」规定固定**六个槽位**：
//     结论 → 做了什么 → 验证结果 → 当前限制 → 用户下一步 → 遗留项，且「先给结论，再给证据」。
//
// ★ 2026-09-25 出口层加固（老板拍板：「出口编译器已经存在，欠的是它没把结论状态接进输出内容」）：
//   `finalReport` 新增 `claims` 输入 —— **必须是 adjudicateTerminal 里那次判定产出的结论账本**
//   （调用侧传 `lastClaimEval.claims`）。**绝不允许在这里重新评估**：重算就是两套判定，迟早漂移；
//   这也维持了本仓那条纪律「一次判定，多处消费」。
//   门控铁律（规范 §14 ③「写不出证据的那一项 ＝ 没检查，不是通过」）：
//     VERIFIED   → 只有它配出现在「做了什么」；
//     UNVERIFIED → 同一批内容必须改口径进「观察 / 待验证」；
//     DISPROVED  → 进「缺口 / 纠正」；
//     BLOCKED    → 进「环境所限、还没验证」，由「当前限制」说清需要用户介入什么。
//   ⇒ 声明、证据、输出被接成一条线：**没验证过的东西，不许被说成已完成。**
//
// ⚠️ 分工（避免同一件事写两遍）：本函数只负责**按证据状态给内容改口径**；
//   "这条结论为什么还不能成立"的详细解释归 claimGapStatement（唯一 owner），这里不重复列。
const TOOL_CHURN_RE = /(调用了\s*\d+\s*个?\s*(?:工具|技能)|重试了\s*\d+\s*次|执行了\s*\d+\s*次|读取了\s*\d+\s*个?\s*文件|工具调用次数|token\s*消耗|共调用\s*\d+)/;

/** 收尾文本里是否混入了"过程噪音"（§29 禁止项，供门禁断言）。 */
function hasToolChurn(text) {
  if (!text) return false;
  return TOOL_CHURN_RE.test(String(text));
}

/** 收尾报告固定槽位（规范 §13）。顺序即语义：先给结论，再给证据。 */
const REPORT_SLOTS = ['结论', '做了什么', '验证结果', '当前限制', '下一步', '遗留项'];

/**
 * 结论账本对**收尾措辞**的门控档位。
 * ⚠️ 这不是判定 —— 判定只在 adjudicateTerminal 里发生一次；本函数只读已判定过的 `status`，
 *   **绝不重算**（重算 = 两套判定 = 迟早漂移）。它回答的只有一句：
 *   「我准备写进收尾的这些内容，配不配被说成已完成？」
 * @param {Array} claims adjudicateTerminal 里那一份 claimEval.claims（已判定的账本）
 * @returns {string} CLAIM_STATUS 之一；优先级：任一 DISPROVED > 任一 BLOCKED > 任一未核实 > 全部已核实
 */
function reportClaimGate(claims) {
  const list = (Array.isArray(claims) ? claims : [])
    .filter((x) => x && typeof x === 'object' && x.claim);
  // 账本为空 / 没传 ⇒ 按"还没验证过"处理：**没有证据 ≠ 已核实**（§14 ③）。
  // ⚠️ 这是刻意取**保守**方向的默认值：宁可少说一句"完成"，不可多说一句。
  if (!list.length) return CLAIM_STATUS.UNVERIFIED;
  if (list.some((x) => x.status === CLAIM_STATUS.DISPROVED)) return CLAIM_STATUS.DISPROVED;
  if (list.some((x) => x.status === CLAIM_STATUS.BLOCKED)) return CLAIM_STATUS.BLOCKED;
  if (list.some((x) => x.status !== CLAIM_STATUS.VERIFIED)) return CLAIM_STATUS.UNVERIFIED;
  return CLAIM_STATUS.VERIFIED;
}

/** 槽位② 的标签由**证据档位**决定：同一批内容，证据不足就必须换口径（本刀的核心）。
 *  ⚠️ 写成函数而不是顶层 const 映射表：CLAIM_STATUS 在 §十二 才定义，
 *     顶层 `{ [CLAIM_STATUS.X]: … }` 会在**模块加载期**取用 TDZ 变量直接抛 ReferenceError。 */
function doneSlotLabel(gate) {
  if (gate === CLAIM_STATUS.VERIFIED) return '【做了什么】';
  if (gate === CLAIM_STATUS.DISPROVED) return '【缺口 / 纠正】';
  if (gate === CLAIM_STATUS.BLOCKED) return '【环境所限、还没验证】';
  return '【观察 / 待验证】'; // UNVERIFIED 及一切未知档位 ⇒ 取最保守口径
}

/** 槽位② 的口径注释：把"为什么它现在不算已完成"写在内容前面（不给读者留误会空间）。同上，用函数。 */
function doneSlotNote(gate) {
  if (gate === CLAIM_STATUS.VERIFIED) return '';
  if (gate === CLAIM_STATUS.DISPROVED) return '（反向检查已证明结论不成立，不算已完成）';
  if (gate === CLAIM_STATUS.BLOCKED) return '（环境让验证做不了 —— 这是缺口，不是失败）';
  return '（这些还没有可核的证据，不能算已完成）';
}

/**
 * 收尾报告整形（规范 §13 + §29 + §30）。
 * 固定六个槽位；内容按结论证据档位改口径。
 * ⚠️ 绝不输出工具调用次数/重试次数这类过程统计。
 * @param {{state:string, claims?:Array, done?:string[], verified?:string[], pending?:string[],
 *          changed?:string[], issues?:string[], stuckAt?:string,
 *          needFromUser?:string, afterUserCanDo?:string}} o
 *        `claims` = 已判定过的结论账本（lastClaimEval.claims）；缺省 ⇒ 按"还没验证过"处理。
 */
function finalReport(o) {
  const c = o || {};
  const state = c.state || TERMINAL.PARTIAL;
  // ★ §29 的自守：报告生成器**自己拒绝回显过程噪音**（"调用了 17 个工具/重试 4 次"）。
  //   放在这里而不是只写进人设，是因为后端自己拼的收尾文本同样可能被塞进这类统计；
  //   生成器直接过滤掉，才算真的生效（否则 hasToolChurn 就只是个没人读的常量）。
  const clean = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s)).filter((s) => s && !hasToolChurn(s));
  const done = clean(c.done);
  const verified = clean(c.verified);
  const changed = clean(c.changed);
  const pending = clean(c.pending);
  const issues = clean(c.issues);
  // ★ 结论账本（**已判定过的那一份**，这里只读不重算）—— 它决定"配不配被说成已完成"。
  //   `canClaimDone` 参与下面每一个槽位的分支，本刀要的不是"多一个参数"，而是"输出真的随它变"。
  const claimGate = reportClaimGate(c.claims);
  const canClaimDone = claimGate === CLAIM_STATUS.VERIFIED;
  const claimsList = (Array.isArray(c.claims) ? c.claims : [])
    .filter((x) => x && typeof x === 'object' && x.claim);
  const complete = state === TERMINAL.COMPLETE;
  // ★ 第四档**也是 blocked 的一种**（同样卡住、同样需要用户介入），所以它必须进这个布尔：
  //   槽位④「需要你提供什么」与槽位⑤「下一步」都读它，漏掉就等于第四档的报告里
  //   既不提"需要你提供什么"、也不提"下一步等你"，读者看不出自己该做什么。
  //   ⚠️ `complete` 那行**不许**跟着改：第四档不是完成，把它算进 complete 就是本仓最严重的谎。
  const blocked = state === TERMINAL.BLOCKED || state === TERMINAL.BLOCKED_WITH_DIAGNOSIS;
  const doneItems = [].concat(done, changed);
  const L = [];

  // ── 槽位① 结论（§13：先给结论，再给证据）──────────────────────────
  if (complete && canClaimDone) {
    L.push('【结论】已经完成。');
  } else if (complete && claimGate === CLAIM_STATUS.DISPROVED) {
    // 「反向检查已推翻」不是"没验过"，是"验了、结论不成立" —— 两种口径必须分开说，
    // 否则用户会以为只是"还没来得及验"（那会让人继续等，而不是回头查）。
    L.push('【结论】这件事**不能**说完成 —— 反向检查已经把它推翻了。');
  } else if (complete) {
    // 终态说 COMPLETE，但**没有可核证据**（未验证 / 环境所限）⇒ 不许替用户下这个结论。
    // 这正是规范 §14 ③ 的执行形态：写不出证据的那一项 ＝ 没检查，不是通过。
    L.push('【结论】这件事我还不能说"完成" —— 现在没有可核的证据来源。');
  } else if (state === TERMINAL.BLOCKED_WITH_DIAGNOSIS) {
    // 第四档**不能**借用下一支那句「缺一个只有你能给的条件」：它卡住的原因已经定位到可复现，
    // 用户此刻最需要知道的是"问题被定位了、复现步骤在下面"，而不是"我在等你要东西"。
    // 也不能落进最后那支「还没全做完」——那会读成"我还在推进"，而它其实已经停下（终点）。
    L.push('【结论】卡住了 —— 但卡点已经**定位到可复现**：下面直接给你复现步骤和实测次数，不是"我做不下去"。');
  } else if (blocked) {
    L.push('【结论】卡住了：缺一个只有你能给的条件。这不是失败，也不是我做不下去。');
  } else {
    L.push('【结论】这件事还没全做完，如实说明进展：');
  }

  // ── 槽位② 做了什么（按证据档位换口径 —— 本刀核心：声明 → evidence → 输出）──────
  const slotLabel = doneSlotLabel(claimGate);
  const slotNote = doneSlotNote(claimGate);
  if (doneItems.length) {
    L.push(slotLabel + slotNote + doneItems.join('；') + '。');
  } else {
    L.push(slotLabel + '（还没有可交付的部分）');
  }

  // ── 槽位③ 验证结果 ──────────────────────────────────────────────
  // 有来源的 PASS 才算验证结果。已核实的结论**只报中性计数、不回显原文**：
  // 原文是机器口径（如"用户要求的事已经完成"），一旦某条结论未核实、整篇在说"还不能算完成"，
  // 回显原文就会让同一篇报告里冒出"已经完成"字样 —— 读者只会记住后者（端到端探针实测抓到过）。
  const verifiedClaimCount = claimsList.filter((x) => x.status === CLAIM_STATUS.VERIFIED).length;
  const verifiedAll = verified.concat(
    verifiedClaimCount ? [verifiedClaimCount + ' 条关键结论已核实（有证据 + 反证探针通过）'] : []);
  // ⚠️ 2026-10-21 试过「空槽位整段不输出」，已**撤回**。理由（写完又否掉，记下来免得下轮再试一遍）：
  //   ① 收益极小：实测只省 20 字（356→335），真正的噪音是 claimGapStatement 的 227 字（已压到 35）；
  //   ② 代价是打破 §13「六槽位齐全、没有就写没有、不许省略」——而那条约定的价值是**可审计**：
  //      一旦省略，读者无法区分「确实没有」与「根本没检查」。这与 §14③「写不出证据 ＝ 没检查」同源，
  //      不能为了版面把它去掉。unit-delivery-protocol 的 D18-e / D22-a1 / D22-a2 正是在守这条。
  L.push('【验证结果】' + (verifiedAll.length ? verifiedAll.join('；') + '。' : '没有'));

  // ── 槽位④ 当前限制（卡在哪 / 缺什么 / 需要你提供什么）──────────────────
  const limits = [];
  if (c.stuckAt) limits.push(String(c.stuckAt));
  if (complete && !canClaimDone) {
    limits.push('结论缺可核证据（写不出证据的那一项 ＝ 没检查，不是通过）');
  }
  const blockedClaims = claimsList.filter((x) => x.status === CLAIM_STATUS.BLOCKED);
  if (blockedClaims.length) {
    // 详细"为什么这条结论不能成立"由 claimGapStatement 统一说明，这里只点到"验不了"这一事实。
    limits.push('有 ' + blockedClaims.length + ' 条结论因环境所限还没验证（这是缺口，不是失败）');
  }
  if (blocked) {
    limits.push('需要你提供：' + (c.needFromUser || '（见上，需要你提供一个外部条件）'));
  }
  L.push('【当前限制】' + (limits.length ? limits.join('；') + '。' : '没有'));

  // ── 槽位⑤ 下一步（只给一个动作，不列七八件事）────────────────────────
  // ⚠️ 2026-02-16：兜底话术**不许写成「等你确认」**。
  //   原兜底是「等你确认，我把剩下的接着做完」—— 它把「还有活没干完」默认说成一件需要用户点头的事，
  //   用户看到的就是「豆芽又停下来等我了」，而这正是本次实测反馈的故障形态（反复追问、不回答就不做）。
  //   「没做完」的正确表达是**如实说明进度 + 剩下的我自己接着做**，不把球踢回给用户；
  //   唯一合法的「等你」是 BLOCKED（那一段已经写成「等你给我上面那个条件」，因为它确实缺用户手里的东西）。
  const next = c.afterUserCanDo ? String(c.afterUserCanDo)
    : (complete && canClaimDone ? '没有（可以直接用了）'
      : (complete ? '没有需要你做的；证据补齐之前，我不会说"完成"'
        : (state === TERMINAL.BLOCKED_WITH_DIAGNOSIS
          // 第四档的"下一步"不是"等你给东西"，而是"照着上面的步骤跑一次，把输出给我"——
          // 这正是它值一次有效交付的原因：用户接手只需要照着做，不需要自己去查。
          ? '你照着上面的复现步骤跑一次；同一处失败就把输出发我，我接着定位到修好为止'
          : (blocked ? '等你给我上面那个条件，我接着往下做' : '不用你做什么；这一轮先到这儿，剩下的我自己接着往下做'))));
  L.push('【下一步】' + next + '。');

  // ── 槽位⑥ 遗留项（§13；没有就写"没有"，不省略这一栏）──────────────────
  const left = pending.concat(issues);
  L.push('【遗留项】' + (left.length ? left.join('；') : '没有'));

  return L.join('\n');
}

// ============ 十二、结论证据与反证门（Evidence / Falsification Gate）============
// 2026-09-24 新增（老板定稿口径：「不要再造第四套状态机」—— 给现有那条链**加一层**，
// 而不是另起一套）。因此本节有三条硬约束，改这里之前先看清楚：
//   ① **不新增终态词表**：任务终态仍然只有 TERMINAL 那三个（COMPLETE / PARTIAL / BLOCKED）。
//   ② **不新增状态机**：CLAIM_STATUS 描述的是「**这一条结论**有没有资格成立」，
//      它回答的问题只有一句 —— 「我准备声称的这件事，是真的吗？」；
//      它**不负责任务终态**，终态仍然归 adjudicateTerminal（唯一入口）。
//   ③ **只对关键结论强制**：会让用户以为"任务已经完成"的那三种结论（见 CRITICAL_CLAIM_KINDS），
//      普通过程性描述一律不走这里 —— 否则模型说每一句话都要自证 27 层，那是把系统搞重。
//
// 它要解决的失败模式：模型**不需要说错话**，只要在证据不足时宣布「已经完成 / 可以交付 / 已修复」，
// 用户就会拿这句话当事实去做决策。规范 §三 早就写了「已验证」才允许 COMPLETE，
// 但那句话此前**没有可执行的门** —— 本节就是那道门。
//
// 核心不是 verify() === pass，而是：
//     verify() === pass  **且**  breakIt() === fail
// ——正常输入能通过**还不够**；故意把条件破坏，检测器**还必须能识别**。这就是 falsification 探针。
//   （本仓 09-23 那次事故正是缺这一条：对照与目标同批一起崩，差点据此宣布"缺陷已定位"。）

/** 一条结论的资格状态。注意：这不是任务终态，别往 TERMINAL 上加词。 */
const CLAIM_STATUS = {
  VERIFIED: 'verified',     // 证据够 + 反证探针通过 ⇒ 可以声称
  UNVERIFIED: 'unverified', // 没证据 / 证据不足 ⇒ 不能说"完成"，**也不能说"失败"**
  DISPROVED: 'disproved',   // 反向检查已证明结论不成立 ⇒ 回恢复链
  BLOCKED: 'blocked',       // 环境让验证无法完成 ⇒ 是"缺口"，不是"失败"
};

/** 三类**关键结论** —— 只有这三类会被强制要证据（用户明确点名的三种）。 */
const CLAIM_KINDS = {
  COMPLETION: 'completion',   // 「我已经完成了用户要求」
  DELIVERABLE: 'deliverable', // 「这个产物可以交付」
  BUGFIX: 'bugfix',           // 「这个 bug 已经修复」
};

/** 证据种类。带 source 才算**可追溯**证据 —— 没有来源的"通过了"不算证据。 */
const EVIDENCE_KINDS = {
  SOURCE: 'source',       // 源码/配置确实改了（静态可核）
  ARTIFACT: 'artifact',   // 产物存在且完整
  UNIT: 'unit',           // 单元/门禁测试跑过且通过
  RUNTIME: 'runtime',     // 运行时行为真的跑起来看过
  VISUAL: 'visual',       // 渲染/视觉层看过
  PACKAGE: 'package',     // 安装包/发布物已产出
  HASH: 'hash',           // 哈希/指纹核过
  MANIFEST: 'manifest',   // 版本清单（latest.yml 等）已更新
  DOWNLOAD: 'download',   // 分发地址真的可取
  INSTALLED: 'installed', // 目标机真的装上了
};

const EVIDENCE_LABELS = {
  source: '源码已改', artifact: '产物存在', unit: '测试通过', runtime: '运行时验证',
  visual: '视觉验证', package: '安装包产出', hash: '哈希核对', manifest: '版本清单更新',
  download: '分发地址可取', installed: '目标机已安装',
};

/** 任务类型 —— 决定「最低证据等级」（与风险匹配，不是一律顶格）。 */
const TASK_KINDS = {
  CODE_CHANGE: 'code_change',             // 改代码
  ARTIFACT_DELIVERY: 'artifact_delivery', // 生成报告/文档类产物
  RELEASE: 'release',                     // 发布 EXE / 分发
  GENERIC: 'generic',                     // 其余
};

/**
 * 最小证据集合（对应老板口径第七节）。
 *   evidence —— 这些**必须都有**；
 *   anyOf    —— 这一组里**至少有一项**（避免把"同一件事的不同说法"写成硬性 N 项，
 *               否则现实中明明做全了也会因为缺一个名词而判 UNVERIFIED）；
 *   falsification —— 是否**强制**要求反证探针（高风险动作才强制）。
 * ⚠️ 调这张表就是在调"系统有多重"，改之前先想清楚会不会把所有收尾都变成 PARTIAL。
 */
const MIN_EVIDENCE = {
  [TASK_KINDS.CODE_CHANGE]: {
    label: '改代码',
    evidence: [EVIDENCE_KINDS.SOURCE],
    anyOf: [EVIDENCE_KINDS.UNIT, EVIDENCE_KINDS.RUNTIME],
    falsification: false, // 改了代码至少要跑过一次验证；"代码写出来就说完成"正是要拦的那条
  },
  [TASK_KINDS.ARTIFACT_DELIVERY]: {
    label: '交付产物',
    evidence: [EVIDENCE_KINDS.ARTIFACT],
    anyOf: [],
    falsification: false,
  },
  [TASK_KINDS.RELEASE]: {
    label: '发布分发',
    // ⚠️ 只把「安装包真的产出了」当硬门槛，是因为后端**只有这一项有可靠信号**（产物扩展名）。
    //    hash / latest.yml / 分发页可取 / 目标机已安装 —— 这四项要么靠 agent 自己跑脚本、
    //    要么靠外部权威基线，后端**没有**可信信号 ⇒ 强行当门槛只会把做全了的发版误判成 UNVERIFIED。
    //    它们交给发布流程自己的判据（如 electron-release-triple-verify）保证；
    //    本条只兜住最要命的那一件：**缺反控时不许宣称"发布成功"**。
    evidence: [EVIDENCE_KINDS.PACKAGE],
    anyOf: [],
    falsification: true,
  },
  [TASK_KINDS.GENERIC]: {
    label: '一般任务',
    evidence: [EVIDENCE_KINDS.ARTIFACT],
    anyOf: [],
    falsification: false,
  },
};

/**
 * 「做过找反证的动作」的**痕迹**词表（弱证据）。
 *
 * ⚠️ 口径取宽是**故意**的：这是从执行日志里认**动作痕迹**，不是校验反证做得对不对。
 *    两种误判的代价不对称 ——
 *      把「真跑过反控」判成「没跑」⇒ 明明做对了却被打成 PARTIAL，用户会不再信任这套门；
 *      把「嘴上一句反证」认成动作 ⇒ 漏拦一次，但结论仍然要过最小证据集合。
 *    所以宁可宽。真正的判别力由调用方的反控单测保证（见 unit-delivery-protocol D21）。
 */
const FALSIFICATION_TRACE_RE = new RegExp(
  [
    '变异', '反控', '对照', '复现', '重现', '证伪', '反证', '独立复核', '反向验证', '反向探测', '反向检查',
    '换个批次', '换批次', '换一批',
    '故意(改坏|破坏|弄坏|删掉|删除|写错)', '破坏性', '注入(错误|故障)',
    '本来(会|该)(红|失败)', '应当转红', '必须转红',
    'mutation', 'mutate', 'falsif',
  ].join('|')
);

/**
 * **强词**表：只有真的动手做反控的人才会这么写。
 * 为什么还要分强弱：`对照` / `复现` 是日常分析也天天用的词，拿它当"跑过反控"的证据太松；
 * 而**发布**是高风险动作（改坏了用户装不上），所以发布类只认强词 ——
 * 宁可让发布流程多写一句"反控"，也不许拿"我和对照组比了一下"混过去。
 */
const FALSIFICATION_STRONG_RE = new RegExp(
  [
    '变异', '反控', '证伪', '反证', '独立复核', '反向验证', '反向探测',
    '故意(改坏|破坏|弄坏|删掉|删除|写错)', '破坏性', '注入(错误|故障)',
    '本来(会|该)(红|失败)', '应当转红', '必须转红',
    'mutation', 'mutate', 'falsif',
  ].join('|')
);

/** 检测器自证是否成立（第八节）：**两端都必须成立**，这个检测器才值得相信。 */
function isVerifierAttested(st) {
  return !!(st && st.baseline === 'pass' && st.mutation === 'pass');
}

function describeEvidence(e) {
  const k = (e && e.kind) || 'unknown';
  const src = (e && e.source) || '（无来源）';
  return (EVIDENCE_LABELS[k] || k) + '：' + src;
}

function evidenceKindLabel(k) { return EVIDENCE_LABELS[k] || k; }

/** 截断（本文件是纯函数模块，不引 backend 的 clip）。 */
function clipText(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 判定**一条结论**能不能成立。纯函数，不碰任务终态。
 *
 * 判定顺序**本身就是判据**（换顺序 = 换语义，改之前先想清楚）：
 *   ① 没有证据            ⇒ UNVERIFIED（最先：没证据就没什么好说的）
 *   ② 反证/证据已失败      ⇒ DISPROVED（**优先于一切"通过"**：已证不成立，再多支持证据也不能翻案）
 *   ③ 环境阻塞            ⇒ BLOCKED（"缺口"，不是"失败"——未验证 ≠ 失败）
 *   ④ 全部证据的检测器都自证不过 ⇒ UNVERIFIED（verifier_suspect：可疑检测器的 PASS 不能当证据）
 *   ⑤ 最小证据集合/反证缺失 ⇒ UNVERIFIED（insufficient_evidence，**不能说完成，也不说失败**）
 *   ⑥ 全过                ⇒ VERIFIED
 *
 * @param {object} o
 * @param {string} o.claim          结论原文（给人看的）
 * @param {string} [o.kind]         CLAIM_KINDS 之一
 * @param {string} [o.taskKind]     TASK_KINDS 之一（决定最低证据等级）
 * @param {Array<{kind:string,source:string,result:string,selfTest?:{baseline:string,mutation:string}}>} o.evidence
 * @param {{required?:boolean,result?:string,probe?:string,source?:string}} [o.falsification]
 * @param {string[]} [o.limitations] 如实声明的"没验证到的部分"
 * @param {boolean} [o.blocked]      环境让验证无法完成
 * @returns {{status:string, claim:string, reason:string, evidence:Array, limitations:string[],
 *            missing:string[], suspect:string[], failed:string[], gap:string}}
 */
function verifyClaim(o) {
  const c = o && typeof o === 'object' ? o : {};
  const claim = c.claim || '';
  const kind = c.kind || CLAIM_KINDS.COMPLETION;
  const taskKind = MIN_EVIDENCE[c.taskKind] ? c.taskKind : TASK_KINDS.GENERIC;
  const evidence = (Array.isArray(c.evidence) ? c.evidence : []).filter((e) => e && typeof e === 'object');
  const fal = c.falsification && typeof c.falsification === 'object' ? c.falsification : null;
  const limitations = (Array.isArray(c.limitations) ? c.limitations : []).slice();

  const base = { claim, kind, taskKind, evidence, limitations };

  // ① 没有证据：既不能说"完成"，也不能说"失败" —— 只能如实说"还没验证"。
  if (!evidence.length) {
    return Object.assign({}, base, {
      status: CLAIM_STATUS.UNVERIFIED, reason: 'no_evidence',
      missing: ['至少一条可追溯证据'], suspect: [], failed: [], gap: '',
    });
  }

  // ② 反证优先：反证探针失败 / 有关键证据取值为 fail ⇒ 结论已被证伪，不再看支持证据。
  const failedEv = evidence.filter((e) => e.result === 'fail');
  const falFailed = !!(fal && fal.result === 'fail');
  if (failedEv.length || falFailed) {
    return Object.assign({}, base, {
      status: CLAIM_STATUS.DISPROVED,
      reason: falFailed ? 'falsification_failed' : 'evidence_failed',
      failed: failedEv.map(describeEvidence).concat(falFailed ? ['反证探针失败：' + (fal.probe || '（未说明怎么破坏的）')] : []),
      missing: [], suspect: [], gap: '',
    });
  }

  // ③ 环境阻塞：验证**做不了**（浏览器起不来 / 目标机连不上）。这是"缺口"不是"失败"。
  if (c.blocked) {
    return Object.assign({}, base, {
      status: CLAIM_STATUS.BLOCKED, reason: c.blockedReason || 'environment_blocked',
      missing: [], suspect: [], failed: [],
      gap: c.blockedGap || '环境让这部分验证无法完成 —— 未验证，不等于失败',
    });
  }

  // ④ 检测器自证（第八节）。只有在**全部**证据都来自"自证不过"的检测器时才否决 ——
  //    否则一条边缘证据就能把整个结论打死，那会逼着模型"干脆不标 selfTest"。
  const suspect = evidence.filter((e) => e.selfTest && !isVerifierAttested(e.selfTest));
  if (suspect.length && suspect.length === evidence.length) {
    return Object.assign({}, base, {
      status: CLAIM_STATUS.UNVERIFIED, reason: 'verifier_suspect',
      suspect: suspect.map(describeEvidence),
      missing: ['检测器自证未通过（没有"故意破坏时必须转红"的反控）⇒ 它的 PASS 不能当证据'],
      failed: [], gap: '',
    });
  }
  if (suspect.length) {
    limitations.push('有 ' + suspect.length + ' 条证据的检测器自证未通过（' + suspect.map(describeEvidence).join('；') + '）');
  }

  // ⑤ 最低证据集合 + 反证探针（按 taskKind 的风险等级要求）
  const need = MIN_EVIDENCE[taskKind];
  const have = {};
  evidence.forEach((e) => { if (!have[e.kind]) have[e.kind] = 0; have[e.kind] += 1; });
  const missing = [];
  for (const k of need.evidence) if (!have[k]) missing.push('缺证据：' + evidenceKindLabel(k));
  if (need.anyOf.length && !need.anyOf.some((k) => have[k])) {
    missing.push('缺证据：' + need.anyOf.map(evidenceKindLabel).join(' / ') + '（至少一项）');
  }
  if (need.falsification) {
    if (!fal) missing.push('缺反证探针（要能证明「故意破坏时门禁会转红」）');
    else if (fal.result !== 'pass') missing.push('反证探针未通过：' + (fal.result || 'missing'));
    // 可追溯：只有 probe（怎么破坏的）+ source（哪次执行）都写清，才算真跑过
    else if (!fal.probe || !fal.source) missing.push('反证探针缺可追溯来源（probe / source 都要写清）');
  } else if (fal && fal.required === true && fal.result !== 'pass') {
    // 非强制任务里，**调用方显式**要求的那条反证同样要成立（required 必须显式传 true）
    missing.push('调用方要求的反证探针未通过：' + (fal.result || 'missing'));
  }

  if (missing.length) {
    return Object.assign({}, base, {
      status: CLAIM_STATUS.UNVERIFIED, reason: 'insufficient_evidence',
      missing, suspect: suspect.map(describeEvidence), failed: [], gap: '',
    });
  }

  return Object.assign({}, base, {
    status: CLAIM_STATUS.VERIFIED, reason: 'ok',
    missing: [], suspect: suspect.map(describeEvidence), failed: [], gap: '',
  });
}

/**
 * 从执行日志里认「做过找反证的动作」（弱证据，见 FALSIFICATION_TRACE_RE 的口径说明）。
 * ⚠️ 只扫 **ok === true** 的步骤：失败的那一步不能算"反证做过"。
 * ⚠️ 返回里**不带 `required`** —— 「这次任务是否强制要反证」由 MIN_EVIDENCE 决定，
 *    混进来会造成"任何任务都强制反证"的连锁误拦（施工期真踩过）。
 * @param {Array} doneLog
 * @param {{strong?:boolean}} [opts] strong=true 时只认强词（发布类用）
 * @returns {{result:'pass'|'missing', probe:string, source:string}}
 */
function falsificationFromLog(doneLog, opts) {
  const o = opts || {};
  const re = o.strong ? FALSIFICATION_STRONG_RE : FALSIFICATION_TRACE_RE;
  const list = Array.isArray(doneLog) ? doneLog : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s || s.ok !== true) continue;
    const text = String(s.skill || '') + ' ' + String(s.brief || '');
    if (re.test(text)) {
      return {
        result: 'pass',
        probe: clipText(s.brief || s.skill, 140),
        source: String(s.skill || '') + '#step' + String(s.step == null ? '?' : s.step),
      };
    }
  }
  return { result: 'missing', probe: '', source: '' };
}

/** 产品扩展名 → 证据种类（`.exe` 这类发布物既是产物，也是"安装包已产出"的硬证据）。 */
const RELEASE_EXT_RE = /\.(exe|msi|dmg|pkg|AppImage|deb|rpm|blockmap)$/i;
const CODE_EXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|kt|rb|php|cs|cpp|c|h|css|scss|less|sql|sh)$/i;

// ============ 十一·二、「什么算真交付物」的唯一判据（backend / UI / 证据门三处共用）============
// 【2026-10-21 老板实测暴露，原话】「输出的文件夹 只显示你要的那个就行了 别的不用告诉你」。
// 现场：一次「把图插进去做个 ppt」的收尾，成果卡里是
//   check_deck.js / serve_deck.js / patch_hash.js / cp_assets.js —— 全是过程脚本，
//   真正的 mmm-ai-report-deck.html 被挤在后面。
//
// 根因（实测数据）：旧判据 backend.js 的 `PROC_SCRIPT_EXT_RE = /\.(py|sh|bat|cmd|ps1)$/` **不含 .js**；
//   而本地交付台账 72 条里 js 20 条 + py 21 条 = 过程脚本占 57%，全部被当成"交付物"入卡。
//
// 本函数只回答一句话：**用户拿到手上能用的东西，是哪一个？**
//   · 产物类扩展名（html / docx / pdf / png / mp4 / exe …） ⇒ 是（用户要的就是它）
//   · 脚本 / 源码 / 配置类                             ⇒ 只有用户明确要脚本时才算
//   · 名字自带过程用途（check_ / gen_ / serve_ …）      ⇒ 用户没明说要脚本时一律不算（那是手段，不是成果）
//   ⚠️ 优先顺序是契约的一部分：①产物 > ②用户明说要脚本 > ③过程命名 > ④其余脚本。
//      「用户明确说的」压过「按名字猜的」—— 老板说「写个检查脚本」时，check_deck.js 就是他要的东西。
//      2026-10-21 验收曾按注释里「一律不算」去断言，与实现（②先于③）打架；裁决为②优先，注释已改准。
//
// ⚠️ 这是**唯一判据**。成果卡过滤、交付台账入账、结论证据门三处必须共用它 ——
//   三处各写一套必然漂移，而漂移的形态恰恰就是本次事故：
//   「卡上显示一堆 js」+「结论却在说『缺证据：产物存在』」，两句话同时出现在一屏里。
const ARTIFACT_EXT_RE = /\.(html?|pdf|docx?|xlsx?|pptx?|csv|md|txt|rtf|png|jpe?g|gif|svg|webp|bmp|ico|mp4|mov|avi|mkv|mp3|wav|m4a|zip|7z|rar|tar|gz|exe|msi|dmg|pkg|AppImage|apk|ipa)$/i;
const PROC_SCRIPT_EXT_RE = /\.(py|sh|bash|zsh|bat|cmd|ps1|psm1|js|mjs|cjs|jsx|ts|tsx|vue|svelte|rb|php|pl|lua|go|rs|java|kt|scala|swift|cs|cpp|cc|c|h|hpp|css|scss|sass|less|styl|sql|yaml|yml|toml|ini)$/i;
/** 过程用途命名：check_deck.js / gen_cds.py / serve_deck.js / _serve_check.py / img-report_compressed.png 里的 compress。 */
const PROC_NAME_RE = /(?:^|[\\/])[_.]|(?:^|[\\/._-])(check|patch|cp|copy|mv|move|gen|make|build|serve|server|probe|verify|test|fix|scan|dump|debug|run|deploy|upload|fetch|download|resize|compress|convert|merge|split|inspect|parse|extract)(?:[._-]|$)/i;
/** 用户明确要「脚本 / 代码」时才允许脚本类进卡（否则就是拿手段当成果汇报）。 */
const WANTS_SCRIPT_RE = /(脚本|代码|源码|程序|\bpython\b|\bpy\b|\bnode\b|\bjs\b|javascript|typescript|批处理|shell|bash|命令行|写个?函数|写个?类)/i;

/**
 * 「临时 / 过程文件」判据（2026-10-22 新增，优先级高于产物扩展名白名单）。
 *
 * 为什么需要它：`ARTIFACT_EXT_RE` 含 `.txt/.md/.html` 等**通用**扩展名，于是"模型写出来的
 *   中间文件"只要用这些扩展名，就会被第 ① 档无条件判成交付物。实测形态：`.check-tmp.txt`
 *   进了成果卡。过程名判据（PROC_NAME_RE）本来认得出它，但它排在产物类之后 ⇒ 永远轮不到。
 *
 * 三类形态（都是"人手不会交付给客户"的东西）：
 *   ① 以点开头（`.check-tmp.txt`、`.draft.md`）—— 隐藏文件是工具/脚本的中间产物习惯；
 *   ② 以 tmp/temp/bak/backup/orig/swp/swo/partial 作为**一段**（`deck-tmp.html`、`deck.html.tmp`）；
 *   ③ 以 `~` 结尾（Word/WPS 编辑时留下的 `报告.docx~`）。
 * ⚠️ 判据要求这些词前面是 `^` 或分隔符 `[._-]`，所以 `template.docx` / `attempt.html`
 *    **不会**被误杀（那两个词前面是字母）。
 */
const TEMP_ARTIFACT_RE = /^\.|~$|(?:^|[._-])(?:tmp|temp|bak|backup|orig|swp|swo|partial)(?:[._-]|$)/i;

/**
 * 这个路径算不算「用户要的交付物」。
 * @param {string} p 绝对或相对路径
 * @param {string} [userText] 用户本轮原话（决定"要不要脚本"）
 * @returns {boolean}
 */
function isRealArtifact(p, userText) {
  const s = String(p || '');
  if (!s) return false;
  const base = s.split(/[\\/]/).pop() || '';
  if (!base) return false;
  // ⓿ ★★ 2026-10-22：**临时/过程文件优先判否** —— 必须排在「产物类扩展名」之前。
  //   修之前的结构性缺陷（实测到的形态）：`.check-tmp.txt` 这种模型自己写的中间文件，
  //   因为 `.txt` 在 ARTIFACT_EXT_RE 里，走到第 ① 档就 `return true` 了；
  //   而第 ③ 档的 PROC_NAME_RE 明明认得出它是过程文件 —— **永远轮不到**。
  //   ⇒ 一堆"校验/草稿/半截"文件被当成成果塞进成果卡，用户拿到一张卡说"这些是给你的东西"。
  //   为什么用通用判据而不是硬编码 `.check-tmp.txt`：那个名字是模型临时起的，
  //   下次它可能叫 `.verify-tmp.md` / `deck.html.bak`。按**命名形态**判才挡得住。
  //   为什么不会误伤正常文件：`template.docx`/`attempt.html` 里虽然含 `temp`/`tmp` 字母，
  //   但前面不是分隔符，正则要求 `^` 或 `[._-]` 才起判 ⇒ 不命中。
  if (TEMP_ARTIFACT_RE.test(base)) return false;
  // ① 产物类：用户拿在手上能用的东西，无条件算。（`.html` 落在这一档，所以演示稿永远进卡）
  if (ARTIFACT_EXT_RE.test(base)) return true;
  // ② 用户明确要脚本 ⇒ 脚本这时真的就是成果
  if (WANTS_SCRIPT_RE.test(String(userText || ''))) return true;
  // ③ 名字自带过程用途 ⇒ 永远不算
  if (PROC_NAME_RE.test(base)) return false;
  // ④ 其余脚本 / 源码 / 配置：没有产物佐证时不进卡
  if (PROC_SCRIPT_EXT_RE.test(base)) return false;
  return false;
}

/** 产物路径 → 证据对象（**只报真的验过的东西**：ok===true 才算 pass）。 */
function evidenceFromArtifact(a, userText) {
  const p = String((a && (a.path || a.name)) || '');
  const okFlag = !(a && a.result === 'fail');
  // ⚠️ 2026-10-21 修一处自相矛盾：分类按扩展名一刀切（.py/.js ⇒ source），
  //   于是「用户明确要脚本、脚本就是成果」时，台账里明明有 gen_report.py，
  //   却因为它是 source 而报缺 artifact ⇒ 收尾说「文件还没生成」。**脚本就在，这话是错的。**
  //   判据只有一条：**已经判定它是用户要的交付物**（isRealArtifact）⇒ 它就按 artifact 记；
  //   否则仍按扩展名分（过程脚本照旧记 source，不给它冒充产物的机会）。
  // 顺序即语义：**安装包永远先按安装包记**（.exe/.msi/.dmg 同时也在 ARTIFACT_EXT_RE 里，
  //   若让 isRealArtifact 抢先，发布类任务会拿不到 PACKAGE 证据 ⇒ 明明打了包却判「缺证据：安装包」。
  //   这是我自己第一版写反顺序时实测撞到的回归，D21-c3 当场变红。）
  const kind = RELEASE_EXT_RE.test(p) ? EVIDENCE_KINDS.PACKAGE
    : ((userText !== undefined && isRealArtifact(p, userText)) ? EVIDENCE_KINDS.ARTIFACT
      : (CODE_EXT_RE.test(p) ? EVIDENCE_KINDS.SOURCE : EVIDENCE_KINDS.ARTIFACT));
  const ev = { kind, source: p, result: okFlag ? 'pass' : 'fail' };
  if (a && a.selfTest) ev.selfTest = a.selfTest;
  return ev;
}

/**
 * 按**真实信号**构建结论账本（不是抄一份逻辑，也不是让调用方自己编）。
 * @param {object} ctx
 * @param {boolean} [ctx.productionRun]  本轮是否真动过手（写文件/跑命令/连服务器）。
 *        false ⇒ 纯对话/纯查询 ⇒ **不产生关键结论、门禁不介入**（这是防"过度工程化"的那道闸）。
 * @param {boolean} [ctx.completionClaimed] 正文里是否声称完成
 * @param {boolean} [ctx.deliverableClaimed] 是否在声称"产物可交付"
 * @param {boolean} [ctx.bugfixClaimed]     是否在声称"bug 已修复"
 * @param {Array}   [ctx.artifacts]         产物及其验证结果 [{path, result}]
 * @param {Array}   [ctx.extraEvidence]     调用方补充的证据
 * @param {Array}   [ctx.doneLog]           执行日志（用于认反证痕迹）
 * @param {boolean} [ctx.codeChanged]       是否改了代码
 * @param {boolean} [ctx.blocked]           环境是否让验证无法完成
 * @param {string}  [ctx.blockedGap]
 */
function buildClaimLedger(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  if (!c.productionRun) return [];

  const arts = (Array.isArray(c.artifacts) ? c.artifacts : []).filter(Boolean);
  const evidence = arts.map((a) => evidenceFromArtifact(a, c.userText))
    .concat((Array.isArray(c.extraEvidence) ? c.extraEvidence : []).filter(Boolean));

  // 任务类型：按产物形状推断（推不出来 = generic，绝不许"猜一个更严的"来给自己加戏）
  // ⚠️ 2026-10-21 修：原判据 `else if (arts.length)` 只要台账里有**任何**文件就判「交付产物」，
  //   于是「只写了 check_deck.js」这种中间态被要求出示产物证据 ⇒ 结论被判「缺证据：产物存在」。
  //   现改为**只认真交付物**（isRealArtifact）：台账里全是过程脚本时不再冒充「交付产物任务」。
  const hasRealArtifact = arts.some((a) => isRealArtifact(a && (a.path || a.name), c.userText));
  // ⚠️ 2026-10-21 补：上面这一行必须带 c.userText。漏了它 ⇒ `WANTS_SCRIPT_RE` 那条分支在
  //   **证据门这一侧永远走不到**：用户说「帮我写个脚本」、脚本就是成果时，这里仍判 generic，
  //   然后对用户说「文件还没生成」—— 而脚本明明就在。验收实测原名（只传一个参数）时
  //   ctx.userText='帮我写个脚本' 仍是 generic，原因就是上层 buildClaimContext 没带这个字段。
  const names = arts.map((a) => String((a && (a.path || a.name)) || '')).join(' ');
  let taskKind = TASK_KINDS.GENERIC;
  if (RELEASE_EXT_RE.test(names) || /latest\.yml/i.test(names)) taskKind = TASK_KINDS.RELEASE;
  else if (hasRealArtifact) taskKind = TASK_KINDS.ARTIFACT_DELIVERY;
  else if (c.codeChanged) taskKind = TASK_KINDS.CODE_CHANGE;

  // 反证痕迹：发布类只认强词（见 FALSIFICATION_STRONG_RE 的说明）
  const fal = falsificationFromLog(c.doneLog, { strong: taskKind === TASK_KINDS.RELEASE });
  const common = {
    taskKind,
    evidence,
    falsification: fal,
    blocked: !!c.blocked,
    blockedReason: c.blockedReason,
    blockedGap: c.blockedGap,
  };

  // ⚠️ 2026-10-21 删掉原先硬编码在每条结论上的
  //   limitations: ['反证探针来自执行日志的痕迹匹配（弱证据），不是签名校验']
  // 理由：① 它与会话里真实发生了什么无关，是**每次都必然出现**的固定旁白；
  //      ② 用户看到的形态是「每条未核实结论下面再挂一句自我审查」，实测一轮里同一句话出现 2 次；
  //      ③ 真正需要"这是弱证据"的场景，由 falsificationFromLog 的 strong 口径与
  //         claimGapStatement 的一句人话承担，不需要在每个 claim 上重复。
  const claims = [];
  if (c.deliverableClaimed) {
    claims.push(verifyClaim(Object.assign({}, common, {
      kind: CLAIM_KINDS.DELIVERABLE,
      claim: '产物可以交付',
      limitations: [],
    })));
  }
  if (c.bugfixClaimed) {
    claims.push(verifyClaim(Object.assign({}, common, {
      kind: CLAIM_KINDS.BUGFIX,
      claim: '这个 bug 已经修复',
      limitations: [],
    })));
  }
  if (c.completionClaimed) {
    claims.push(verifyClaim(Object.assign({}, common, {
      kind: CLAIM_KINDS.COMPLETION,
      claim: '用户要求的事已经完成',
      limitations: [],
    })));
  }
  return claims;
}

/**
 * 汇总关键结论，产出**喂给唯一终态入口**的那一份判定输入。
 * 它只回答"这些结论能不能成立"，**不产出任务终态**（终态仍归 adjudicateTerminal）。
 *
 * @returns {{claims:Array, criticalCount:number, hasDisproved:boolean,
 *            hasUnverifiedCritical:boolean, hasBlockedCritical:boolean,
 *            allCriticalVerified:boolean, reason:string, blockedGap:string}}
 */
function verifyCompletionClaims(ctx) {
  const claims = buildClaimLedger(ctx);
  const hasDisproved = claims.some((x) => x.status === CLAIM_STATUS.DISPROVED);
  const hasUnverified = claims.some((x) => x.status === CLAIM_STATUS.UNVERIFIED);
  const hasBlocked = claims.some((x) => x.status === CLAIM_STATUS.BLOCKED);
  const allVerified = claims.length > 0 && claims.every((x) => x.status === CLAIM_STATUS.VERIFIED);
  let reason = 'no_critical_claim';
  if (hasDisproved) reason = 'disproved';
  else if (hasUnverified) reason = 'unverified';
  else if (hasBlocked) reason = 'blocked';
  else if (allVerified) reason = 'all_verified';
  const gap = (claims.find((x) => x.status === CLAIM_STATUS.BLOCKED) || {}).gap || '';
  return {
    claims,
    criticalCount: claims.length,
    hasDisproved,
    hasUnverifiedCritical: hasUnverified,
    hasBlockedCritical: hasBlocked,
    allCriticalVerified: allVerified,
    reason,
    blockedGap: gap,
  };
}

/**
 * 给用户的**人话**说明（结论不成立时，收尾必须说清"凭什么不能说完成"）。
 * @param {{claims:Array}} evalResult
 * @returns {string} 空字符串 = 所有关键结论都成立，无需解释
 */
function claimGapStatement(evalResult) {
  const e = evalResult || {};
  const claims = Array.isArray(e.claims) ? e.claims : [];
  const bad = claims.filter((x) => x.status !== CLAIM_STATUS.VERIFIED);
  if (!bad.length) return '';
  // ★ 2026-10-21 压缩（老板：「输出一堆内容 我找不到哪个才是重点」）。
  //   原实现：每条未核实结论 2 行（结论 + 「（如实说明：弱证据…）」）+ 固定 1 行收尾，
  //   实测 227 字/轮；而六槽位报告已经把「没做完」说过一遍 ⇒ 同一件事在一屏里出现 5 次以上。
  //   现在压成**一句话**：哪件事还不能算完成 + 差什么。不再逐条拆解，不再自我审查。
  const first = bad[0];
  // ⚠️ DISPROVED 时 why 必须为空：claimStatusLabel 已经说了「已被反向检查推翻」，
  //   再拼一句「反向检查已经把它推翻了」就成了一句里说两遍（2026-10-21 验收实测
  //   「已被反向检查推翻 —— 反向检查已经把它推翻了。」）。只有真能补充信息时才补。
  const why = first.status === CLAIM_STATUS.DISPROVED
    ? (first.gap || '')
    : (first.status === CLAIM_STATUS.BLOCKED
      ? (first.gap || '环境让这部分验证做不了')
      : (first.reason === 'no_evidence'
        ? '还没有任何可追溯的证据'
        : (first.missing || []).join('；')));
  // 「缺证据：X」是内部证据分类名，翻成人话再给用户看。
  const human = String(why || '')
    .replace(/缺证据：产物存在/g, '文件还没生成')
    .replace(/缺证据：/g, '还差：');
  // ★ 真实限制必须露出来（2026-10-21 验收抓到的信息丢失）。
  //   verifyClaim() 会 push 一类**真信息**：'有 N 条证据的检测器自证未通过'。
  //   压缩时如果把 limitations 整段丢掉，这条就永远不显示了 —— 那不是「精简」，
  //   是把「证据本身的可靠性有问题」这件要命的事藏起来（和 §14③「写不出证据 ＝ 没检查」同源）。
  //   取舍：只露第一条未核实结论的限制，且只露第一条，其余折叠进「另有 N 项」。
  const lim = (Array.isArray(first.limitations) ? first.limitations : []).filter(Boolean);
  // 用「；」衔接而不是套括号：限制本身常带括号（如证据清单），套起来会出现
  // 「（有 2 条证据…（a.js；b.js））」这种双层括号，读着像语法错误。
  const limText = lim.length ? '；' + lim[0] + (lim.length > 1 ? '…' : '') : '';
  const more = bad.length > 1 ? '（另有 ' + (bad.length - 1) + ' 项同样待补）' : '';
  const tail = String(human || '') + limText;
  // why 为空（DISPROVED 无 gap）时不拼破折号，避免出现「推翻 —— 」这种断掉的句子。
  return '· 「' + first.claim + '」' + claimStatusLabel(first.status)
    + (tail ? ' —— ' + tail : '') + more + '。';
}

/** 结论状态的人话标签（不许出现英文状态名）。 */
function claimStatusLabel(status) {
  if (status === CLAIM_STATUS.VERIFIED) return '已核实（有证据 + 反证探针通过）';
  if (status === CLAIM_STATUS.DISPROVED) return '已被反向检查推翻';
  if (status === CLAIM_STATUS.BLOCKED) return '环境所限、暂时验不了（不是失败）';
  return '还没验证过';
}

// ============ 八、失败账本（规范 §三：异常必须闭环）============
// 2026-09-22 新增（老板提案第 3 条）。背景：原来的步骤日志**只追加、从不销账**，
// 于是「异常」只增不减 —— 同一个技能后来换了方法做成了，之前那次失败还永远挂着。
// 用户看到的是一份**过期账**：界面上写着"3 步异常"，而其中 3 步早就修好了。
// 这既是假信息，也让「异常」和「完成」在同一句话里自相矛盾。
// 闭环规则只有一条，但必须写死在一个地方（否则 backend / 前端各判一次就会漂移）。
// ⚠️ kind === 'skipped' 不参与：跳过（无人值守未执行 / 用户取消）是"没做"，不是"做失败"，
//    它不该被销账，也不该被当成未闭环失败去拦完成门禁。
//
// ── 2026-11-02 修（用户原话：「复查完了就没有后续了……我让他继续 他也承认有问题 但是就是
//    不解决 也没有能力解决」「不能闭环就根本不能用」）──
// 旧规则是「**同一个技能**后来成功了 ⇒ 把它此前所有未闭环失败一次全销」。
// 它按**技能名**销账，所以只要同一个技能再被调一次、并且返回了一次 pass，就把该技能
// **全部历史失败**抹平 —— 哪怕那次成功验的是完全另一个东西：
//   第 3 步 desktop-verify 失败（窗口起不来）→ 第 7 步又调一次、这次只是返回了个 pass
//   → 第 3 步的失败被销 → unresolvedSteps() 为空 → 完成门禁放行 → 判 COMPLETE。
// 这正是用户说的「承认有问题，然后被自己的下一次调用抹掉」。
// ⇒ 新规则把销账粒度从「技能名」改成「**同一个目标**」（entry.target：文件路径 / URL /
//   端口 / 命令的规范化形式等，标识"这一步作用的对象"）：
//   ① target 非空 ⇒ 只销 `skill 相同 && target 相同` 的未闭环失败；
//   ② target 为空（老调用方没传）⇒ **保守兜底**：最多只销最近一条同技能未闭环失败。
//      理由写在 recordStep 里（一句话：目标未知时无法判断"这次成功能不能代表那次失败真的
//      解决了"，所以宁可让用户多看一条未闭环项，也不许把没解决的抹掉）。

/** summarizeSteps 最多列几条（超过的让调用方用 open 计数说「另有 N 项」）。 */
const STEP_SUMMARY_MAX_LINES = 8;
/** summarizeSteps 单行里 brief 的截断长度（够说清「哪里坏了」，又不至于撑爆界面）。 */
const STEP_SUMMARY_BRIEF_MAX = 60;

/**
 * 把 entry.target 规范化成可比较的串。
 * 只做**不会改变语义**的归一：去掉首尾空白、剥掉一层包裹引号。
 * 更聪明的归一（win 路径斜杠 / URL query 排序 / 命令重排）**故意不做**：
 *   那需要按 target 的种类分别猜，猜错就会把「两个不同目标」判成同一个 ⇒ 又变成误销。
 *   ⇒ 规范化是**调用方的责任**（它才知道这个 target 是路径还是命令），这里只挡住
 *     "多打了一个空格 / 多包了一层引号"这种纯噪声。
 * @param {*} raw
 * @returns {string} 规范化后的 target；无法识别为有效目标时返回 ''（走保守兜底）
 */
function normalizeStepTarget(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === '`' && b === '`')) {
      t = t.slice(1, -1).trim();
    }
  }
  return t;
}

/**
 * 工具入参里「明确指向某一个对象」的键，按**固定优先级**排列（先命中先用）。
 *
 * ⚠️ 这份表是销账粒度的**唯一来源**，加键之前先想清楚一件事：
 *   这个键换了值，是不是"换了一个被作用的对象"？是 ⇒ 可以进表；不是 ⇒ 不许进。
 *
 * ★ 表里的键**按真实 manifest 核对过**（2026-11-02，`skills/*‌/manifest.json` 全量扫）：
 *   · `appPath` —— desktop-verify（**用户报障那条路径**：验的是哪个应用）
 *   · `appDir`  —— package-app
 *   · `path`    —— 11 个技能（data-analyze / doc-read / excel-edit / file-* / …）
 *   · `url`     —— browser-verify / web-fetch
 *   · `filePath` / `file` / `dir` / `dest` / `projectDir` —— 今天 0 个技能用，
 *     作为标准别名保留：将来新技能用这些名字时，不该因为"表里没有"就静默退化成兜底。
 *
 * ★★ 被**明确排除**的键（每一条都有实测依据，不是猜的；删掉这条注释就等于丢了依据）：
 *   · `target` —— package-app 的 `target` 是**打包形态**（`dir` / `portable` / `nsis`），
 *     不是对象（见 skills/package-app/run.js:152 VALID_TARGETS）。收进来就会变成
 *     "给 A 应用打包成功"销掉"给 B 应用打包失败" —— 正是用户报的那个 bug 换了个门。
 *   · `command` / `cmd` —— shell-exec / ssh-exec 的命令文本**每次都可能不同**
 *     （`npm run build` vs `npm run build -- --fix`，甚至只是引号/空格不同）。
 *     同一件事换个写法就变成"另一个目标" ⇒ 账**永不闭环**，用户看到一份只增不减的失败清单。
 *     这类"动作本身没有稳定对象标识"的技能，宁可走保守兜底（每次成功销一条），也不造假目标。
 *     ★ 这一条是 team-lead 点出来的：`command` 要么能证明"换写法仍相等"，要么摘掉。
 *       实测 `ls  -la` 与 `ls -la`（内部多一个空格）不相等，靠 normalizeStepTarget 兜不住
 *       （它只剥首尾空白与一层引号）⇒ 按纪律**摘掉**，不为了多认一个键去改归一口径
 *       （改归一口径会连路径一起被折叠空格，那是另一类更严重的误销）。
 *   · `port` —— ssh-exec / deploy-node / deploy-static / db-query 都有，但它**不标识对象**
 *     （ssh 端口永远 22）⇒ 收进来等于"谁都能销谁的账"。
 *   · `src` —— 在 web 语境里可能是**HTML 源码**（内容），不是路径。
 *   · `prompt` / `text` / `query` / `content` / `message` —— 内容，改一个标点就是"另一个目标"，
 *     收进来会让销账从"全销"变成"永不销"。改写提示词重试同一件事，攻的仍是同一个对象。
 *
 * ★ 也不含任何"靠 skill 名 + 入参拼出来"的伪目标（如 skill + JSON.stringify(params)）：
 *   那种 target **每次都不一样**（params 里只要有易变字段），等于永不销账，
 *   而且看起来像"接了线"——比不接更难被发现。
 */
const STEP_TARGET_KEYS = ['appPath', 'appDir', 'path', 'filePath', 'file', 'dir', 'dest', 'projectDir', 'url'];

/**
 * 从工具入参里推出「这一步作用在什么对象上」，供 recordStep 按 target 销账。
 *
 * 销账要解决的问题（用户原话「复查完了就没有后续了……不能闭环就根本不能用」）：
 *   同一个技能第 3 步验 A 失败、第 7 步验 B 成功，不该把第 3 步的账销掉。
 *   所以每一步都要带出"它作用的对象"，销账时只销**同一对象**的账。
 *
 * 推不出来就返回 `''`（走 recordStep 的保守兜底：最多销最近一条），
 * **绝不自己编一个**——编出来的 target 每次都可能不同，会让账永不闭环。
 *
 * @param {string} skill 技能名（只用于日志/调试，**不参与** target 构造）
 * @param {object|undefined|null} params 工具入参（数组 / 非对象 / undefined 都要能跑）
 * @returns {string} 规范化后的 target；推不出来返回 ''
 */
function deriveStepTarget(skill, params) {
  // 数组、null、字符串、数字一律当"没有入参"：它们的"第一个字符串"没有对象语义。
  if (!params || typeof params !== 'object' || Array.isArray(params)) return '';
  for (let i = 0; i < STEP_TARGET_KEYS.length; i++) {
    const key = STEP_TARGET_KEYS[i];
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    const v = params[key];
    // 只认非空字符串：端口可能是数字，数字不是"对象标识"，跳过（不许 String(8080) 混进来，
    // 那会让 "8080" 这种随处可见的值把两个不相干的目标判成同一个）。
    if (typeof v !== 'string') continue;
    const t = normalizeStepTarget(v);
    if (t) return t;
  }
  // ── ② 只读命令：从命令文本里认出"它查的是哪个文件" ──
  // 为什么必须补这一路（2026-11-02③，老板 P1「失败销账放宽」）：
  //   shell-exec 的入参只有 `command`，而 `command` 被明确排除在 STEP_TARGET_KEYS 之外
  //   （换写法就不相等 ⇒ 收进来会让账永不闭环）。结果就是**所有** shell-exec 步的 target
  //   都是空 ⇒ 只能走保守兜底（一次成功最多销一条）。
  //   实测事故：`findstr` 查中文必失败 → 记账 2 条未闭环 → 改用 Select-String 查**同一个文件**
  //   查成了，却因为 target 为空、且两次 success 只能销一条，另一条永远挂着 ⇒ 完成门禁
  //   判 PARTIAL ⇒ 12 轮 69k tokens 之后用户看到的仍是「还没做完」。
  //   注意：这里放宽的是**账本认不认得出"同一个对象"**，销账规则一个字没动 ——
  //   仍然只销"同技能 + 同 target"（外加只读族跨技能，见 recordStep）。
  //   ⚠️ 反控见 scripts/smoke/unit-failure-writeoff.mjs W3：拆掉这一路 ⇒ findstr→Select-String
  //      的账必须重新变成 2 条未闭环。
  const cmdTarget = deriveReadCommandTarget(
    (Object.prototype.hasOwnProperty.call(params, 'command') ? params.command : params.cmd)
  );
  if (cmdTarget) return cmdTarget;
  return '';
}

/**
 * 只读查看类命令的白名单（小写，不含 `.exe`）。
 *
 * ★ 只有这几个命令允许从命令文本里推出目标，理由只有一条：
 *   它们**只看不改** —— 命令里那个文件路径，就是"这一步作用的对象"本身。
 *   白名单之外一律不给 target（继续走保守兜底），因为 `node -e` / `del` / `npm run build`
 *   的命令文本里即使出现文件名，也完全不代表"这一步作用在那个文件上"。
 *   给它们编一个 target，就是拿一次成功去掩盖另一个问题（正是 STEP_TARGET_KEYS 注释里
 *   那些"被明确排除"的键要防的事）。
 */
const READ_CMD_WHITELIST = new Set([
  'findstr', 'select-string', 'sls', 'rg', 'ripgrep', 'grep', 'egrep', 'fgrep',
  'type', 'cat', 'more', 'get-content', 'gc', 'head', 'tail', 'wc', 'find',
]);

/**
 * 命令里出现这些字符 ⇒ **不给 target**，直接返回 ''。
 * 每一条都有具体理由（不是"保险起见"）：
 *   · `>` `>>` —— 重定向 = 写文件。`type a.md > b.md` 的"对象"到底是读的 a 还是写的 b？
 *     说不清就不许猜：猜成 a 会让"写 b 失败"被"读 a 成功"销掉。
 *   · `;` `&&` `||` `&` 换行 —— 一条 command 里塞了多个动作，它的"对象"不唯一。
 *     `findstr x a.md; rm a.md` 若被判成"对象 = a.md"，下一次读 a.md 成功就销了删除失败的账。
 *   · `|` 管道 —— 每一段的命令可能都不同，无法用一个对象概括。宁可走保守兜底。
 */
const CMD_AMBIGUOUS_RE = /[>|;&\r\n]/;

/**
 * 从一条**只读命令**里认出它查的是哪个文件。
 *
 * @param {*} rawCommand shell-exec / ssh-exec 的 `command` 入参
 * @returns {string} 规范化后的文件路径；认不出来（或不该认）返回 ''
 */
function deriveReadCommandTarget(rawCommand) {
  // 只处理字符串：数组/对象/数字都不是命令文本。
  if (typeof rawCommand !== 'string') return '';
  const cmd = rawCommand.trim();
  if (!cmd) return '';
  if (CMD_AMBIGUOUS_RE.test(cmd)) return '';
  // 按引号感知切词：`"a b.md"` 必须是一个 token（带空格的路径不能被切成两半）。
  const toks = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (toks.length < 2) return ''; // 只有一个词 ⇒ 可能只是 `dir` / `ls`，没有文件可认
  const cmdName = unquoteToken(toks[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  // 允许 `powershell -Command "Select-String ..."`？**不允许**：那层壳里的引号会被再切一次，
  // 认出来的很可能是半个路径。命令名不在白名单 ⇒ 不给 target（保守兜底照旧）。
  if (!READ_CMD_WHITELIST.has(cmdName)) return '';
  const hits = [];
  for (let i = 1; i < toks.length; i++) {
    const t = unquoteToken(toks[i]);
    if (!looksLikePathToken(t)) continue;
    if (hits.indexOf(t) < 0) hits.push(t);
  }
  // 认出 0 个 ⇒ 没对象；认出 2 个以上 ⇒ 对象不唯一（`rg x a.md b.md` 到底是哪一个？）。
  // 两种都返回 ''，**绝不挑一个最像的**：挑错就是拿 A 的成功销 B 的账。
  if (hits.length !== 1) return '';
  return normalizeStepTarget(hits[0]);
}

/** 剥掉一层成对引号（不剥多层：`"'a'"` 这种畸形保持原样）。 */
function unquoteToken(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * 这个词看起来是不是"一个文件路径"。
 * 判据刻意取保守面（宁可认不出，也不许把 `-Path` 当成路径）：
 *   · 单开关/单参数（`/n` `-Path` `-Encoding`）⇒ 不是路径
 *   · 含 `/` 或 `\` ⇒ 是路径
 *   · 以 `.扩展名`（1~6 位字母数字）结尾 ⇒ 是路径
 *   · 其余（`暗号` `UTF8` `-n`）⇒ 不是
 */
function looksLikePathToken(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return false;
  // 纯开关：`/n` `/c` `-Path` `-Pattern` `--include`，允许后面跟 :值（如 `/c:string`）。
  if (/^(?:[-/]{1,2}[A-Za-z][A-Za-z-]*)(?::.*)?$/.test(t)) return false;
  if (/[\\/]/.test(t)) return true;
  return /\.[A-Za-z0-9]{1,6}$/.test(t);
}

/**
 * 「只读族」技能：**只看不改**，失败不会破坏任何东西。
 *
 * ★ 这张表唯一的用途：允许族内**跨技能**销账（见 recordStep 规则①）。
 *   进表门槛：这个技能无论成功失败，都不改动它读的那个对象。
 *   · shell-exec —— 只对**白名单只读命令**才有 target（见 deriveReadCommandTarget），
 *     所以它带 target 出现时，那一步本身已经是只读动作，不是因为它是 shell 就放行。
 *   · file-read / file-search / file-list / doc-read / image-info / web-fetch —— 看名字即可判定。
 *   ⚠️ 写类（file-write / excel-edit / image-edit / deploy-* / package-app / …）**永远不进表**：
 *      "读 A 成功"证明不了"写 A 成功"，跨技能销账会直接抹掉真失败。
 */
const READ_ONLY_SKILLS = new Set([
  'shell-exec', 'file-read', 'file-search', 'file-list', 'doc-read', 'image-info', 'web-fetch',
]);

/**
 * 两条账是不是"作用在同一个对象上"，且允许互相销账。
 *
 * 判据（缺一不可）：
 *   ① 目标都存在且相等 —— 对象不同一律不许销（这是原规则，不动）。
 *   ② 技能相同 **或** 双方都在只读族 —— 写类技能只能靠同名技能销账。
 */
function sameLedgerObject(o, s) {
  if (!o || !s) return false;
  const t = s.target;
  if (!t || o.target !== t) return false;
  if (o.skill === s.skill) return true;
  return READ_ONLY_SKILLS.has(o.skill) && READ_ONLY_SKILLS.has(s.skill);
}

/**
 * 成果卡的**路径归一键**（只做不会改变语义的归一，与 normalizeStepTarget 同一纪律）。
 *
 * 归一四件事，每件都有具体理由：
 *   ① 去控制字符 —— 路径里的 `\u0007` 之类会让前端显示成乱码，也会让"同一文件"被判成两个。
 *   ② 反斜杠转正斜杠 + 折叠重复分隔符 —— `C:\\a\\b.md` 与 `C:/a/b.md` 是同一个文件。
 *   ③ 去 `./` 前缀、去尾部斜杠 —— `./a.md` 与 `a.md` 是同一个文件。
 *   ④ **只在 win32 折大小写** —— Windows 文件系统不区分大小写（`A.md` 就是 `a.md`）；
 *      但在 Linux/macOS(默认) 上 `a.md` 与 `A.md` 是**两个文件**，无条件折会把真成果吞掉。
 *
 * @param {*} p 绝对/相对路径
 * @returns {string} 归一键；不是有效路径时返回 ''
 */
function artifactPathKey(p) {
  let t = String(p == null ? '' : p).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!t) return '';
  t = t.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  t = t.replace(/^\.\//, '').replace(/\/+$/, '');
  if (process.platform === 'win32') t = t.toLowerCase();
  return t;
}

/**
 * 成果卡去重（老板 P1「成果卡去重」）。
 *
 * 事故形态：同一个文件在一次任务里被写了两次（先落盘、再改一行）⇒ 成果卡上出现**两张
 *   一模一样的卡**。成因是 `file-write` 那一支的记账是全文件唯一一处**没有去重守卫**的
 *   push（其余几处都写了 `deliverables.some((d) => d.path === p)`）。
 *
 * 保留**第一次**出现的那条：
 *   · 用户看到的顺序 = 文件第一次落地的顺序（与 trace 里的 arts 增长顺序一致）；
 *   · 卡片上的展示信息（name）取第一次的，不会出现"同一张卡名字换了"的跳变。
 *
 * @param {Array<{name?:string,path?:string}>} list
 * @returns {Array} 去重后的新数组（不改入参）
 */
function dedupeArtifacts(list) {
  const arr = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || typeof it !== 'object') continue;   // 畸形条目一律跳过，不许抛
    const k = artifactPathKey(it.path);
    if (!k) continue;                              // 没有路径的条目不是成果卡
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * 往失败账本里记一步。
 * @param {Array} log doneLog（**就地修改**）
 * @param {{step?:number, skill:string, ok:boolean, kind?:string, brief?:string, target?:string}} entry
 *   target：这一步**作用的对象**（文件路径 / URL / 端口 / 命令的规范化形式）。
 *   可选 —— 不传就退化成保守兜底（见下），老调用方（backend.markStep）不用改签名。
 * @returns {{step:object, resolvedCount:number}} 写入的这条 + 本次销掉的旧账条数
 */
function recordStep(log, entry) {
  const list = Array.isArray(log) ? log : [];
  const e = entry || {};
  const s = {
    step: e.step,
    skill: e.skill,
    ok: !!e.ok,
    kind: e.kind || (e.ok ? 'ok' : 'failed'),
    brief: e.brief,
    // 字段恒定存在（没传就是 ''），这样「有没有目标」是一个可判断的值，
    // 而不是"有的条目有这个键、有的没有"的三种状态。
    target: normalizeStepTarget(e.target),
  };
  list.push(s);
  let resolvedCount = 0;
  // ⚠️ 跳过 ≠ 成功，**不许销账**。
  //   kind='skipped' 的语义是「这一步没有执行技能本体」：无人值守跳过索要素材/澄清/选文件、
  //   用户点「跳过」、「用户未提供素材」、危险操作被拦下、熔断、意图闸门。
  //   它既不是失败，也**不是"这件事做成了"** —— 拿它去销账就是用"没做"冒充"做成了"。
  //   实测复现（用户报障的第二个形态）：第 3 步 ppt-generate 真失败（磁盘满）后，
  //   用户点一次「跳过素材提供」⇒ 旧判据 `if (s.ok)` 让第 5 步 skipped 把第 3 步销掉
  //   ⇒ unresolvedSteps() 归空 ⇒ 完成门禁放行 ⇒ 用户看到「承认有问题，然后没了」。
  //   这比按错目标销账更隐蔽：界面上用户确实点过东西、也确实显示"已跳过"，
  //   没人会想到那一下把上一轮的真失败抹了。
  //   判据方向刻意取"宁可多留一条未闭环项让用户多看一眼，也不许被一次没执行销掉"。
  //   用「黑名单排除 skipped」而不是「白名单只认 ok」：将来若把 'ok' 改名（如 'done'），
  //   白名单会让**所有**销账静默失效 ⇒ 账永远不闭环、用户被过期失败淹没，是另一种坏法；
  //   黑名单只挡已经确知的这一种"谎"，其余未知 kind 仍按成功处理。
  //   （ok=false 的那些 skipped 不受影响：unresolvedSteps 只认 ok===false && kind==='failed'，
  //     所以它们本来就不进未闭环集，这里也不会去销别人。）
  if (s.ok && s.kind !== 'skipped') {
    if (s.target) {
      // ① 目标已知：只销「同一技能 + 同一目标」的未闭环失败（从后往前扫，不含刚 push 的这条）。
      //    不同目标的失败**不许**被销 —— 那是拿一次成功去掩盖另一个问题。
      //    ★ 2026-11-02③ 放宽一格（老板 P1「失败销账放宽」）：**只读族内部允许跨技能销账**。
      //      事故形态：`shell-exec`(findstr) 查某文件失败 → 改用 `file-read` 读**同一个文件**
      //      成功（这正是新加的编码提示推荐的第一条兜底路径）⇒ 旧判据要求 skill 相同 ⇒
      //      账销不掉 ⇒ 明明已经看到内容了，界面上还写着「2 处工具失败未补救」。
      //      为什么这里可以放宽：两个技能都是**只看不改**，失败没有破坏任何东西，
      //      而"同一个对象被另一个只读手段成功读到了"已经证明那次失败的成因（工具/编码）
      //      不再是障碍。写类技能**不放宽**：写 A 失败、读 A 成功完全不能证明写成功了。
      for (let i = list.length - 2; i >= 0; i--) {
        const o = list[i];
        if (o && sameLedgerObject(o, s) && o.ok === false && o.kind === 'failed' && !o.resolved) {
          o.resolved = true;
          o.resolvedBy = s.step;
          resolvedCount++;
        }
      }
    } else {
      // ② 目标未知（老调用方没传 target）：**保守兜底 —— 最多只销最近一条**。
      //    为什么不是"全销"：不知道这次成功作用在什么对象上，就无法判断它能不能代表
      //      之前那条失败真的解决了。旧实现按技能名全销，于是「第 3 步窗口起不来的失败」
      //      会被「第 7 步验另一个应用的 pass」抹掉 —— 用户看到的就是"承认有问题，然后没了"。
      //    为什么不是"一条都不销"：那会让早已修好的失败永远挂在账上，用户看到一份过期账。
      //    ⇒ 折中：销最近一条（时间上最可能被这次成功覆盖的那条），其余保留。
      //    代价（明说）：如果真有多条同技能失败其实都被修好了，这里会多留几条未闭环项；
      //      这是**故意**选的方向 —— 宁可让用户多看一条未闭环项，也不许把没解决的抹掉。
      for (let i = list.length - 2; i >= 0; i--) {
        const o = list[i];
        if (o && o.skill === s.skill && o.ok === false && o.kind === 'failed' && !o.resolved) {
          o.resolved = true;
          o.resolvedBy = s.step;
          resolvedCount++;
          break;
        }
      }
    }
  }
  return { step: s, resolvedCount };
}

/**
 * 仍未闭环的失败（**完成门禁的输入之一**：还有没解决的失败 ⇒ 不许判 COMPLETE）。
 * @param {Array} log doneLog
 * @returns {Array} 未闭环条目
 */
function unresolvedSteps(log) {
  const list = Array.isArray(log) ? log : [];
  return list.filter((s) => s && s.ok === false && s.kind === 'failed' && !s.resolved);
}

/**
 * 把一步压成一句用户看得懂的话（**不是内部字段名**）。
 * @param {object} s doneLog 条目
 * @param {number} fallbackNo 条目没有 step 时用的序号（1 起）
 * @returns {string} 形如 `第3步 desktop-verify：窗口没起来（超时 20s）`
 */
function stepLineOf(s, fallbackNo) {
  const rawNo = Number(s && s.step);
  const no = Number.isFinite(rawNo) && rawNo > 0 ? rawNo : fallbackNo;
  const skill = String((s && s.skill) || '').trim() || '未记录技能';
  let brief = String((s && s.brief) || '').replace(/\s+/g, ' ').trim();
  if (!brief) brief = '没有留下失败原因';
  if (brief.length > STEP_SUMMARY_BRIEF_MAX) brief = brief.slice(0, STEP_SUMMARY_BRIEF_MAX) + '…';
  return '第' + no + '步 ' + skill + '：' + brief;
}

/**
 * 把 doneLog 折成一句人话，用于「还没做完，卡在哪」。
 * 完成门禁（有未闭环就不许判 COMPLETE）与前端（把失败清单给人看）都用它，
 * 免得两边各算一套计数 —— 计数一漂移，界面上就会出现「未闭环 3 条」却只列 2 条的怪状。
 * @param {Array} log
 * @returns {{open:number, resolved:number, ok:number, lines:string[]}}
 *   open：仍未闭环的失败数（= unresolvedSteps(log).length，同一条判据）
 *   resolved：已被后续成功销掉的失败数
 *   ok：成功步数
 *   lines：每条未闭环失败的 `第N步 技能名：brief`，最多 STEP_SUMMARY_MAX_LINES 条
 *          （open 可能大于 lines.length，调用方负责说「另有 N 项」）
 */
function summarizeSteps(log) {
  const list = Array.isArray(log) ? log : [];
  let open = 0;
  let resolved = 0;
  let okCount = 0;
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    // 畸形条目（null / 字符串 / 缺字段）一律跳过，不许抛：这份日志来自运行时，
    // 一个脏条目不该把「还没做完，卡在哪」这句话整个毁掉。
    if (!s || typeof s !== 'object') continue;
    if (s.ok === true) {
      okCount++;
      continue;
    }
    // 跳过（skipped）既不是完成也不是失败 —— 与 unresolvedSteps 同一口径：不计数、不上榜。
    if (!(s.ok === false && s.kind === 'failed')) continue;
    if (s.resolved) {
      resolved++;
      continue;
    }
    open++;
    if (lines.length < STEP_SUMMARY_MAX_LINES) lines.push(stepLineOf(s, i + 1));
  }
  return { open, resolved, ok: okCount, lines };
}

module.exports = {
  TERMINAL,
  DECISION,
  STATE,
  STATE_TRANSITIONS,
  HANDOFF_RE,
  CANNOT_RE,
  BLOCKED_PARTS,
  FALLBACK_LADDER,
  SCOPE_EXAMPLES,
  DISCOVERY_CHECKLIST,
  PARALLEL_SITE_HINTS,
  classifyTerminalState,
  terminalLabel,
  terminalStatement,
  hasRecoveryEvidence,
  detectBailOut,
  isLegitimateBlocked,
  bailOutDirective,
  // 证伪闸门（2026-09-23，人设「二十一」）：把「假设 ≠ 事实」从软约束变成运行时强制。
  //   与 §二 同构：弱判定 → 纠正指令 → 决定终态。CAUSAL_CLAIM_RE 是弱判定的词表。
  CAUSAL_CLAIM_RE,
  detectCausalClaim,
  hasFalsificationEvidence,
  missingFalsificationParts,
  falsificationDirective,
  // ★ 2026-11-11 导出给 contentClaimGuard.js 用（产物正文的"断言必须有来源"门）。
  //   刻意让它成为**唯一真源**：两处（回复正文 / 产物正文）如果各养一份词表，
  //   迟早漂移，而漂移的症状是"某些诚实标注突然被罚"—— 那会教模型别标注。
  UNVERIFIED_DECLARATION_RE,
  missingBlockedParts,
  buildBlockedReport,
  // 第四档 BLOCKED_WITH_DIAGNOSIS（2026-02-16）：报告渲染 + "诊断是否真的可复现"的机械判据。
  //   ★ 只导出 `classifyBlockedDiagnosis` 一个"新符号"：终态值本身**不**另导出一个常量
  //     （`TERMINAL.BLOCKED_WITH_DIAGNOSIS` 已经在 TERMINAL 里），多一个常量就是第二份真源，
  //     两份必然漂移 —— 本仓「同一件事只能有一处真源」的纪律。
  buildDiagnosedBlockedReport,
  classifyBlockedDiagnosis,
  normalizeDiagnosisText,
  extractDiagnosisProbe,
  buildDecisionOptions,
  isValidOptionCount,
  fallbackLadderText,
  scopedCompletionStatement,
  claimsCompletion,
  nextState,
  isTerminalState,
  classifyVerificationFailure,
  verificationVerdictText,
  discoveryDirective,
  parallelIssueDirective,
  hasToolChurn,
  finalReport,
  // 出口层·结论证据门控（2026-09-25）：`reportClaimGate` 只读已判定的 claim 状态，
  //   决定收尾报告"配不配说已完成"。它不是判定（判定只在 adjudicateTerminal 里一次），
  //   也不新增状态 —— 用的就是 CLAIM_STATUS 那四个值。
  reportClaimGate,
  REPORT_SLOTS,
  // 结论证据与反证门（2026-09-24）：只回答「这条结论能不能成立」，**不产出任务终态**。
  //   终态仍归 adjudicateTerminal（唯一入口）；本节不新增终态词表、不新增第二状态机。
  CLAIM_STATUS,
  CLAIM_KINDS,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  TASK_KINDS,
  MIN_EVIDENCE,
  FALSIFICATION_TRACE_RE,
  FALSIFICATION_STRONG_RE,
  isVerifierAttested,
  verifyClaim,
  buildClaimLedger,
  verifyCompletionClaims,
  claimGapStatement,
  // 「什么算真交付物」唯一判据（2026-10-21）——成果卡过滤 / 台账入账 / 证据门三处共用。
  isRealArtifact,
  claimStatusLabel,
  falsificationFromLog,
  // 失败账本（2026-09-22 / 2026-11-02 改销账粒度）：闭环销账 + 未闭环清单，完成门禁的输入。
  recordStep,
  unresolvedSteps,
  // 2026-11-02③ 销账放宽：只读命令的目标推导 + 只读族跨技能销账（门禁 unit-failure-writeoff 用）
  deriveReadCommandTarget,
  looksLikePathToken,
  sameLedgerObject,
  READ_ONLY_SKILLS,
  READ_CMD_WHITELIST,
  // 2026-11-02③ 成果卡去重
  artifactPathKey,
  dedupeArtifacts,
  // 失败账本（2026-11-02）：把账折成「还没做完，卡在哪」的一句话 + 三个计数。
  //   完成门禁与前端清单共用同一份口径（否则会出现「未闭环 3 条」却只列 2 条）。
  summarizeSteps,
  normalizeStepTarget,
  STEP_SUMMARY_MAX_LINES,
  // 销账粒度的**接线入口**（2026-11-02）：从工具入参推出"这一步作用在什么对象上"。
  //   没有它，recordStep 的 target 永远为空 ⇒ 生产上只走保守兜底 ⇒ 用户报的 bug 原样还在。
  //   ★ 它必须被 backend 的**执行路径**真的调用（unit-failure-ledger 有接线断言 + 接线变异臂）。
  deriveStepTarget,
  STEP_TARGET_KEYS,
};
