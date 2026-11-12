/**
 * evidenceQuality —— 一条「验收结果」到底算不算**证据**，只有一个判据。
 *
 * 老板的原话（2026-10-23）：
 *   「我不建议简单地把『交付物生成后，任何 shell-exec 或 ssh-exec 都算进度』作为最终修复。
 *     否则 Agent 可以不断写新脚本、重复运行相同检查，即使验收结果完全没有变化，
 *     也可能永远不触发 stuck。」
 *   「相同验证命令、相同输入、相同结果重复出现，不重复累计有效进度。」
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么需要一个独立模块：判据错了两次，两次都是"身份"错了
 * ═══════════════════════════════════════════════════════════════════════
 *   第一版：**任意一次** shell-exec 就算进度。后果：反复跑同一条检查永不收尾。
 *   第二版（本模块之前）：把「验收证据」的身份定义成 `工具名 + 完整命令行 + 结果指纹`。
 *     看起来严谨，实测仍漏 —— 复现读数（6 轮，每轮只换脚本名）：
 *       python check1.py … check6.py，结果都返回「全部检查通过：3 项」
 *       ⇒ informative=true / fresh=true **6 次全中** ⇒ 永不判打转。
 *     根因一句话：命令里带着会被随手改写的**脚本名**，于是"同一条检查"每轮都换了身份。
 *
 *   所以身份的判据必须换轴：**证据的身份由「它报告了什么」决定，不由「用哪条命令跑的」决定。**
 *   同一条检查换个脚本名再跑一遍，报告的还是那一组读数 ⇒ 不是新证据。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 四级判定（不是布尔值 —— 布尔值会把"没看懂"和"空话"混成一类）
 * ═══════════════════════════════════════════════════════════════════════
 *   empty    空输出（连字都没有）
 *   prose    有文字但**没有任何可追溯读数**，例如「全部检查通过」「✓ 所有断言通过，未发现问题」
 *            —— 这类是**表态**，不是证据。它证明不了检查真的跑过、也证明不了检查了什么。
 *   numeric  有读数，但**对不上任何一条验收项**（例如只打印 `total 24`）
 *            —— 有信息，但不知道它在回答哪个问题。
 *   reading  既有读数、又对得上具体验收项 ⇒ **只有这一级算证据**。
 *
 * ★ 为什么要分 numeric 和 prose：两者的处置方向不同。
 *   prose  ⇒ 这次检查没产生信息，要换做法（重新规划）；
 *   numeric ⇒ 检查跑了但没对准验收项，要补上"检查哪一项"。
 *   混成一句「结果不够好」等于什么都没说。
 *
 * ★ 为什么 `reading` 还要求「对得上验收项」：老板的挑战 2 就是
 *   「给它一个看似全绿、实际上没有检查目标问题的测试集，看它能否发现测试的盲区」。
 *   判据如果只要求"有数字"，那么 `print("3")` 就能冒充验收 —— 盲区没有被发现，只是被藏得更深。
 *
 * 本模块**零 fs、零网络、零时间依赖**（纯函数）：判据能被门禁直接钉住，也能被恢复路径复用。
 */

/** 数字 + 量词（`3 页` / `0 个重复` / `31872 字节` / `12.5%`） */
const NUM_UNIT_RE = /(-?\d+(?:\.\d+)?)\s*(页|项|个|条|张|份|字节|byte|bytes|KB|MB|GB|%|px|pt|ms|行|列|次|页数)/gi;
/** 键值对（`slideCount=3` / `bytes: 31872` / `duplicate=0`） */
const KEY_VAL_RE = /\b([A-Za-z_][A-Za-z0-9_]{1,24})\s*[=:：]\s*(-?\d+(?:\.\d+)?)/g;
/** 具名产物（`deck.pptx` / `out/report.pdf`） */
const ARTIFACT_RE = /([\w\-./\\]+\.(?:pptx|docx|xlsx|pdf|png|jpe?g|gif|mp4|html|md|csv|json|zip))\b/gi;

/**
 * 「计数单位」—— 它数的是**做了几项检查**，不是**检查出了什么**。
 * ★ 这一条是老板那个漏洞的最后一道缝：`全部检查通过：3 项` 里的 `3 项`
 *   被 `NUM_UNIT_RE` 当成读数 ⇒ 在无标准档里会被判成"有读数 ⇒ 有信息" ⇒ 空话又当证据了。
 *   所以判「是不是纯结论」时必须先把计数单位剥掉。
 * ⚠️ 只剥 `项/个/条/张/份/次` 这类**纯计数**词；`页/字节/KB/%/px` 是**读数单位**，绝不能剥
 *   （`共 8 页` 剥掉就变成了"啥也没说"，真读数会被误杀）。
 */
const COUNT_UNIT_RE = /-?\d+(?:\.\d+)?\s*(?:项|个|条|张|份|次)/g;
/**
 * 「只剩结论词」的词表。判法：把计数单位与标点剥掉后，
 * **整串是否完全由这些词构成** —— 是 ⇒ 纯表态；出现任何一个别的词 ⇒ 不在这里下结论。
 * 为什么用穷举词表而不是"含通过两字就算"：`检查通过 3 项但第 2 页溢出` 这种**有真内容**的句子
 * 会含"通过"，但它是证据，不能被判成空话。
 */
const CONCLUSION_WORD_RE = /^(?:所有|全部|一切|各项|每项|都|均|共|总共|一共|合计|检查|断言|测试|校验|验证|项目|通过|成功|正常|完成|没问题|无问题|未发现问题|无异常|ok|okay|pass|passed|success|all|tests?|checks?|are|is|and)+$/i;

/** 一条结果是否「只有表态，没有任何实质内容」。 */
function looksLikeConclusionOnly(flat) {
  const s = String(flat == null ? '' : flat)
    .replace(COUNT_UNIT_RE, ' ')
    .replace(/[：:，,。.!！、/\\|;；\-—·()（）\[\]【】✓✔√✗×⚠\s]+/g, '');
  if (!s) return false;
  return CONCLUSION_WORD_RE.test(s);
}

/**
 * 各验收项「真读数长什么样」。**这是标准的一部分**，所以放在配置里（`cfg.requiredChecks[i].evidenceHints`）。
 *
 * ★★ 2026-10-26【删表】这里原本还有一张 `FALLBACK_HINTS`（按 check id 名字写死六个 PPT 专属 id 的
 *   hints）。它是"按检查 ID 名称自动继承 PPT 专属规则"的**第二套标准**：
 *   将来任何一个非 PPT 工作流只要用了一个通用长相的名字（例如 `requested_format_matches`）却没声明
 *   `evidenceHints`，就会**静默继承** `\.pptx\b` —— 于是它自己的结果会被判成"对准了某一项"，
 *   而它根本没有验格式。删掉之后只剩两级：**配置声明的 evidenceHints → id 的 token**。
 *   两级都是"这份标准自己说的"，引擎不再替任何工作流定义它的验收项。
 *
 * ⚠️ 方向是**变严**不是变松：删表只会让少一批"假装对准"的路径（strict 档照旧要求"读数对得上
 *   某一项"才算证据；`no-checks-lenient` 照旧只用于"根本没有验收标准"的场合）。
 *   回归证据：wf-acceptance 的 P3-H1/P3-H2（源码 + 行为两处）与 P3-M5（把表恢复 ⇒ 行为断言转红）。
 */

/** 把一条 hint（字符串/RegExp）变成可 test 的正则；写坏了不抛，返回 null。 */
function toRe(h) {
  try {
    if (h instanceof RegExp) return new RegExp(h.source, h.flags.includes('i') ? h.flags : h.flags + 'i');
    const s = String(h == null ? '' : h).trim();
    if (!s) return null;
    return new RegExp(s, 'i');
  } catch { return null; }
}

/**
 * 一条验收项的主题正则集。
 * 两级来源（前面的优先）：配置里的 evidenceHints → check id 的 token。
 * ★ 2026-10-26：第三级"按 id 名字查内置兜底表"已**删除**（理由见上面那段）。
 */
function hintsOfCheck(check) {
  const c = check || {};
  const id = String(c.id || '');
  const out = [];
  const raw = Array.isArray(c.evidenceHints) ? c.evidenceHints : [];
  for (const h of raw) { const re = toRe(h); if (re) out.push(re); }
  // 兜底：id 的 token 直接当线索（`slide_count_matches_plan` ⇒ slide / count）
  for (const tok of id.split('_')) {
    if (tok.length >= 4 && !['matches', 'plan', 'from', 'with'].includes(tok)) {
      const re = toRe(tok);
      if (re) out.push(re);
    }
  }
  return out;
}

/** 结果里出现的「读数」token（归一化后可直接比对）。 */
function readingsOf(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  NUM_UNIT_RE.lastIndex = 0;
  KEY_VAL_RE.lastIndex = 0;
  ARTIFACT_RE.lastIndex = 0;
  let m;
  while ((m = KEY_VAL_RE.exec(s))) out.push(m[1].toLowerCase() + '=' + m[2]);
  while ((m = NUM_UNIT_RE.exec(s))) out.push(m[1] + m[2]);
  while ((m = ARTIFACT_RE.exec(s))) out.push(m[1].toLowerCase());
  // 去重保序：`3 页` 出现两次不是两条读数
  return [...new Set(out)];
}

/** 结果命中了哪些验收项（返回 check id 列表）。 */
function topicsOf(text, checks) {
  const s = String(text == null ? '' : text);
  const list = Array.isArray(checks) ? checks : [];
  const hits = [];
  for (const c of list) {
    if (!c || !c.id) continue;
    const res = hintsOfCheck(c);
    if (res.some((re) => { re.lastIndex = 0; return re.test(s); })) hits.push(String(c.id));
  }
  return hits;
}

/** 稳定指纹（不依赖命令、不依赖顺序）。 */
function digestOf(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = (h1 ^ ch) * 16777619 >>> 0;
    h2 = (h2 + ch * (i + 1)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 判一条验收结果。
 *
 * @param {string} result 技能的返回值
 * @param {Array<{id:string, evidenceHints?:Array<string|RegExp>}>} [checks] 验收项定义（工作流标准 `requiredChecks`）
 * @returns {{grade:'empty'|'prose'|'numeric'|'reading', topics:string[], readings:string[],
 *            signature:string, isEvidence:boolean, mode:string, why:string}}
 *
 * ★ 两档严格度（`mode` 字段，**必须落 trace**，否则事后分不清这次是严判还是宽判）：
 *   · `strict`（传了非空 checks）：读数必须**对得上某一验收项**才算证据。
 *                        这是工作流生效时的口径 —— 判的是「有没有回答这一项」。
 *   · `no-checks-lenient`（checks 为空）：**不知道该对准什么**，退一步 —— 有读数就算有信息。
 *
 * ⚠️ 为什么必须有宽判档（2026-10-23 实测踩到的回归，不是设计洁癖）：
 *   判据第一版直接用了调用方传进来的 `cfg.requiredChecks`，而 `handleChat` 里的 `cfg`
 *   是 `defaultConfig(dataDir)`（网关配置，26 个键，**没有** requiredChecks）。
 *   ⇒ 真实产品路径上 checks 恒为空 ⇒ topics 恒空 ⇒ 所有结果都判成「没对准」⇒ `newEv` 恒 0
 *   ⇒ **每一份真的做完验收的任务都被判成"原地打转"提前收尾**。
 *   这比原来的漏洞更糟：原来的漏洞是"永不收尾"，这个回归是"永远误收尾"。
 *   所以：**没有标准时不许假装自己有标准**。宁可多认一条进展，也不能把真验收误杀。
 *   （纯表态在两档里都不算证据 —— 那是老板点名要堵的，与标准有无无关。）
 */
function gradeVerifyEvidence(result, checks) {
  const raw = String(result == null ? '' : result);
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) {
    return { grade: 'empty', topics: [], readings: [], signature: 'empty', isEvidence: false,
      mode: 'strict', why: '空输出（一个字节都没有）' };
  }
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && c.id);
  const lenient = list.length === 0;
  const mode = lenient ? 'no-checks-lenient' : 'strict';
  const readings = readingsOf(flat);
  const topics = topicsOf(flat, list);
  // 签名：有读数就按「读数集」认身份（命令/脚本名**完全不参与**）；
  //   一个读数都没有 ⇒ 退回文本指纹（让同一句空话在多轮之间也能被认成同一句）。
  const signature = readings.length
    ? 'r:' + [...readings].sort().join('|') + '|t:' + [...topics].sort().join(',')
    : 'x:' + digestOf(flat);

  // ★ 纯表态必须**最先**判，不能等 `!readings.length` 才判。
  //   为什么（实测踩过的顺序 bug）：「全部检查通过：3 项」里的 `3 项` 会被 readingsOf 收成一条读数，
  //   于是跳过结论判定 ⇒ 落到「有读数没对准」分支 ⇒ 在无标准档里被宽判成**有证据** ⇒ 空话又混进来了。
  //   这个句子整体就是一句结论，"3 项"只是在数"我检查了几项"，不是"检查出了什么"。
  //   反例保护：`检查通过 3 项但第 2 页溢出` 剥掉计数后含「但/第/页/溢出」⇒ 不判纯表态 ⇒ 照常当证据。
  if (looksLikeConclusionOnly(flat)) {
    // ⚠️ 措辞纪律（2026-10-23 门禁工人抓到的文案 bug）：这里 `readings` **可能非空** ——
    //   「全部检查通过：3 项」会收出 `['3项']`。原来的 why 写"没有任何读数"，那是**假话**，
    //   而 why 会落进 trace 供人复核，假话比不写更糟。所以按两种情况分开说。
    const counted = readings.length
      ? '有计数（' + readings.slice(0, 3).join(' / ') + '）但它数的是"检查了几项"，不是"检查出了什么"'
      : '没有任何读数';
    return { grade: 'prose', topics, readings, signature, isEvidence: false, mode,
      why: '只有结论词（"' + flat.slice(0, 40) + '"），' + counted + ' ⇒ 这是表态，不是证据' };
  }
  if (!readings.length) {
    return { grade: 'prose', topics, readings, signature, isEvidence: false, mode,
      why: '有文字但没有可追溯读数（无数字、无具名产物、无键值）⇒ 证明不了检查跑过什么' };
  }
  if (!topics.length) {
    if (lenient) {
      return { grade: 'numeric', topics, readings, signature, isEvidence: true, mode,
        why: '有读数（' + readings.slice(0, 4).join(' / ') + '），本次**没有验收标准**可对照 ⇒ '
          + '宽判为有信息（不计入"对准了哪一项"，只当"拿到了新读数"）' };
    }
    return { grade: 'numeric', topics, readings, signature, isEvidence: false, mode,
      why: '有读数（' + readings.slice(0, 4).join(' / ') + '）但没对上任一验收项 ⇒ 不知道它在回答哪个问题' };
  }
  return { grade: 'reading', topics, readings, signature, isEvidence: true, mode,
    why: '读数（' + readings.slice(0, 4).join(' / ') + '）对上验收项 ' + topics.join(',') };
}

module.exports = {
  gradeVerifyEvidence,
  readingsOf,
  topicsOf,
  hintsOfCheck,
  digestOf,
  looksLikeConclusionOnly,
};
