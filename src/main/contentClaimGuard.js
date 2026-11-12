/**
 * 产物正文的「断言必须有来源」门（P0 事实门）
 * ============================================================================
 * 这个文件回答一个问题：**一份写出去的文件里，那句「已核对」凭什么叫已核对？**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（老板 2026-11-11 复盘的第二条，证据逐条可查）
 * ═══════════════════════════════════════════════════════════════════════════
 *   那次交付的文件第 5 行和结尾第 207 行都写着「11 条暗号已全部核对归属」。
 *   事实是：用户只确认了第 1 条和第 6 条；模型自己在上一条回复里明说「另外 4 条我拿不准」，
 *   其中就有第 10 条黑神话、第 11 条极限竞速；剩下 9 条**没有任何人确认过**。
 *   ⇒ 9 条无人确认的推测，被写成了「已核对」。
 *
 *   这直接违反人设 §八「绝不假装完成：没验证过的，一个字都不能说成已完成」。
 *   **漏洞在于：那条纪律只管聊天回复，管不到写进文件的正文。**
 *   模型在正文里撒谎，收尾门禁一个字都查不出来 —— 因为门禁从头到尾只读「它说了什么」，
 *   不读「它写出去的文件里说了什么」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 判据（三条，缺一条就会变成打地鼠）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① **命中断言词**：文中出现「已核对 / 已确认 / 全部确认 / 核对完毕 / 逐一核对…」这类
 *      把「未验证」说成「已验证」的措辞。
 *   ② **同一处没有来源**：该行 ± 上下文窗口内，既没有「来源标注」
 *      （用户确认 / 工具输出 / 见某处 / 依据 / URL…），也没有「未验证声明」
 *      （待确认 / 尚未核实 / 未验证…）。
 *   ③ ③ 只有 ①② 同时成立才算违规。
 *
 * ★★ 为什么「未验证声明」是**放行词**而不是危险词（这条最容易被改错）：
 *   诚实标注「第 10 条待确认」正是我们要的行为。罚它等于教模型"别标注，直接断言更安全"。
 *   所以 `UNVERIFIED_DECLARATION_RE` 命中的行**一律放行**。
 *   这与 `deliveryProtocol.js` 的 `hasFalsificationEvidence` 是同一口径 —— 本文件直接复用它，
 *   **不自己再养一份词表**（两套词表迟早漂移，而漂移的症状是"某些诚实标注突然被罚"）。
 *
 * ★★ 为什么按**行 + 上下文窗口**判，而不是全文判：
 *   全文判太宽（一份 500 行的文档只要有一处「待确认」，全文的「已全部核对」就都放过了）；
 *   逐行判太窄（来源常常写在下一行的"依据：…"里）。
 *   上下文窗口 `CTX_LINES = 2` 是这两者之间唯一能用的折中：一行断言 + 前后各 2 行找来源。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 失败方向（改之前必须先想清楚这条，因为它决定"误拦"还是"漏拦"）
 * ═══════════════════════════════════════════════════════════════════════════
 *   本模块本身是**纯判定**，不做拦截。调用方 `planContentClaimGate` 的方向是：
 *     · 命中且无来源 ⇒ **拦**（要求改写或补来源）—— 因为"凭空断言"正是要防的事；
 *     · 拿不到内容 / 解析抛错 ⇒ **放行**（fail-open）。
 *       理由：判据自己坏掉时，让文件写出去比让整个功能瘫痪好得多；
 *       而且这是"多问一句"级别的缺陷，不是"数据被删"级别。
 *   两句话必须分开看：**判据命中时严（fail-closed），判据自己坏了时宽（fail-open）**。
 */

'use strict';

const { UNVERIFIED_DECLARATION_RE } = require('./deliveryProtocol');

/** 上下文窗口：断言行前后各看几行找来源。数值理由见文件头注。 */
const CTX_LINES = 2;

/**
 * 断言词：把「未验证」说成「已验证」的措辞。
 *
 * ⚠️ 收词原则（别乱加）：
 *   · 只收**完成态 + 核对语义**的组合（已核对 / 已确认 / 核对完毕），
 *   · **不收**裸的「核对 / 确认」（动词原形）—— 「请核对一下」「需要确认」是**要求**，不是断言；
 *     收了它们，任何写操作说明都会被误拦。
 *   · **不收**「确认收货」「确认订单」这类业务名词（`确认` 后面跟物时可能不是完成态断言）。
 *     用「已/均/全部/逐条」这类完成态前缀来锁定语义，是本表可靠的关键。
 */
const CLAIM_RE = new RegExp([
  // 完成态 + 核对
  '(?:已|均|都|全部|全部已|逐一|逐条|一一|逐个|全部均)(?:经)?(?:核对|核实|校对|比对|校验|验证)(?:过|完毕|无误|正确|通过)?',
  '(?:核对|核实|校对|比对|校验|验证)(?:完毕|无误|通过|完成)',
  // 完成态 + 确认
  '(?:已|均|都|全部|逐一|逐条|一一)(?:经)?确认(?:过|完毕|无误)?',
  '(?:全部|所有|均)(?:正确|无误|准确|一致)',
  '已(?:全部)?确认(?:归属|答案|结果|内容)',
].join('|'));

/**
 * 来源标注：这句话的依据在哪。
 * 命中任一即认为"有据可查"，该行放行。
 */
const SOURCE_RE = new RegExp([
  // ① 人的确认
  '用户(?:已)?(?:确认|确认过|告知|提供|指定|说明|答复)',
  '(?:经|由)用户(?:确认|提供|指定)',
  // ② 工具/执行的证据
  '(?:工具|命令|脚本|程序)(?:的)?(?:输出|结果|读数|返回)',
  '(?:实测|复现|运行结果|执行结果|截图)',
  '(?:我|已)跑过', '(?:我|已)执行过', '(?:我|已)(?:实际)?验证过',
  // ③ 可追溯的出处
  '(?:见|参见|详见|依据|出处|来源|参考|引用|据)[:：]?\\s*\\S',
  '第\\s*\\d+\\s*行',
  'https?://',
  // ④ 明确的归属声明（"这条是用户说的"）
  '(?:来自|出自)用户',
].join('|'));

/** 一行里既有断言又有"还没验证"的诚实标注 ⇒ 放行（见文件头注 ③）。 */
function lineIsHonestlyMarked(line) {
  return UNVERIFIED_DECLARATION_RE.test(line);
}

/**
 * 这一句断言是不是「**大面积覆盖**」的断言（全部 / 所有 / 其余 / 逐条 / N 条且 N≥2）。
 *
 * ★★ 为什么必须把它单独拎出来（这是实测抓到的真缺陷，别删）：
 *   只用 ±CTX_LINES 窗口找来源时，相邻行的来源会**传染**给整篇断言。
 *   实测反例（就是这次事故的形态）：
 *       第 2 行 `第1条已核对（用户确认）`
 *       第 4 行 `其余 9 条已全部核对归属`
 *   第 4 行在窗口内看见了第 2 行的「用户确认」⇒ 被判"有依据"⇒ **放过了**。
 *   而事实是那 9 条没有任何人确认过 —— 本门存在的唯一目的就是抓这一句。
 *   ⇒ 规则改成：**大面积覆盖的断言，来源必须写在同一行**。
 *      「一条被确认过」证明不了「其余 9 条也确认过」，这是一条逻辑事实，不是尺度问题。
 *
 * @param {string} line
 * @returns {boolean}
 */
function isBlanketClaim(line) {
  const t = String(line == null ? '' : line);
  if (/(全部|所有|均|都|逐一|逐条|一一|逐个|每一|其余|整体)/.test(t)) return true;
  // 「11 条」「9 项」这类 ≥2 的数量覆盖，同样是"一大片"。
  // ⚠️ 只认 ≥2：单条（「第1条已核对」）允许下一行写「依据：…」，那是正常写法；
  //    而且单位表刻意不含「行」—— 否则正文里的「见第 3 行」会被当成句数。
  //
  // ⚠️⚠️ 必须先剥掉「第 N 条」这种**序数**再匹配数量（实测抓到的误判，别删）：
  //   「第6条已核对」里的「6条」是"第 6 项"（单条指代），不是"六个条目"。
  //   不剥的话 6 >= 2 ⇒ 被判成 blanket ⇒ 要求同行来源 ⇒ 一条正常的单条标注被拦。
  //   用「先剥序数」而不是 lookbehind：`第 6 条` 中间可能有空格，lookbehind 只固定看前一个字符，
  //   漏掉带空格的写法就会静默退回误判。
  const noOrdinal = t.replace(/第\s*\d+\s*(?:条|个|项|份|处|章|节|段)/g, '');
  const m = /(\d+)\s*(?:条|个|项|份|处|章|节|段)/g;
  let x = m.exec(noOrdinal);
  while (x !== null) {
    if (Number(x[1]) >= 2) return true;
    x = m.exec(noOrdinal);
  }
  return false;
}

/**
 * 扫描正文，找出「断言了但没有依据」的位置。
 *
 * @param {string} text 产物正文
 * @returns {{hits:Array<{line:number, text:string, claim:string, hasSource:boolean, blanket:boolean}>,
 *            unsupported:Array<{line:number, text:string, claim:string, blanket:boolean}>,
 *            total:number}}
 *   hits = 所有命中断言词的行；unsupported = 其中**没有依据**的（= 真正要处理的）。
 */
function scanClaims(text) {
  const src = String(text == null ? '' : text);
  const empty = { hits: [], unsupported: [], total: 0 };
  if (!src) return empty;

  const lines = src.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    // 命中断言词
    const m = CLAIM_RE.exec(line);
    if (!m) continue;
    // 该行自己就标了"待确认"⇒ 诚实标注，放行（不进 hits）
    if (lineIsHonestlyMarked(line)) continue;

    const blanket = isBlanketClaim(line);
    let hasSource = false;

    if (blanket) {
      // 大面积覆盖：来源必须在**同一行**（理由见 isBlanketClaim 注释）
      hasSource = SOURCE_RE.test(line);
    } else {
      // 单条断言：允许 ±CTX_LINES 窗口里找来源 / 未验证声明
      const from = Math.max(0, i - CTX_LINES);
      const to = Math.min(lines.length - 1, i + CTX_LINES);
      for (let j = from; j <= to; j += 1) {
        const w = lines[j];
        if (!w) continue;
        if (SOURCE_RE.test(w) || lineIsHonestlyMarked(w)) { hasSource = true; break; }
      }
    }

    const rec = { line: i + 1, text: line.trim().slice(0, 160), claim: m[0], blanket };
    hits.push({ ...rec, hasSource });
  }

  const unsupported = hits.filter((h) => !h.hasSource).map((h) => ({
    line: h.line, text: h.text, claim: h.claim, blanket: h.blanket,
  }));
  return { hits, unsupported, total: unsupported.length };
}

/**
 * 需要检查的产物类型。只查**正文里会写结论**的文本类文件。
 * 不查 .html/.js 之类：那里出现「已核对」多半是 UI 文案或变量名，误报率高。
 */
const CLAIM_TEXT_EXT_RE = /\.(?:md|markdown|txt|csv|tsv)$/i;

// ===================== 产出类技能的正文收集（2026-11-11 夜 扩展用）=====================
// 依赖方向说明：intentGate 是**零 require 的叶子模块**，这里 require 它不会成环；
// 反过来（intentGate 依赖本文件）会成环，所以产出技能名单只有那一份。
const { isProducerSkill } = require('./intentGate');

/**
 * 每个产出类技能「正文藏在哪个参数里」——逐字来自各自 `run.py` / `run.js` 的读取处。
 *
 * ★ 为什么不是一张凭直觉写的表：这些字段名一点都不统一，而且**有一半是 JSON 字符串**
 *   （`sections` / `slides` / `files` / `headers` / `rows`）。按 `params.content` 一刀切，
 *   除 file-write 外全部读到空串 ⇒ 事实门对它们**静默失效**（`total=0` 就放行，不报错）。
 *   `unit-content-claim.mjs` 的 Q 组会读每个技能的源码，断言这里列的每个字段名在源码里真的有读取。
 *
 * 空数组 = 该技能没有「正文」（纯加工/派生：压缩、转码、拼接、打包），**不是漏填**。
 * 这类技能的产物里没有可断言的措辞，事实门对它们本来就不适用（授权门照管）。
 */
const CLAIM_TEXT_FIELDS = Object.freeze({
  'file-write': ['content'],
  'docx-generate': ['title', 'sections'],
  'pdf-generate': ['title', 'sections'],
  'ppt-generate': ['title', 'slides'],
  'slides-generate': ['title', 'subtitle', 'slides'],
  'excel-generate': ['title', 'headers', 'rows'],
  'chart-generate': ['title', 'xlabel', 'ylabel', 'labels'],
  'project-scaffold': ['files'],
  //   ⚠️ 这里**故意没有 `note`**：manifest 声明了 `{name:'note',label:'项目说明(可选)'}`，
  //   但 `skills/project-scaffold/run.js` **从不读它**（实测 grep 零命中）⇒ 用户填的说明
  //   根本不会进任何文件。收一个进不了文件的字段去扫断言，等于让门去管一个不存在的东西。
  //   （这是本轮顺带发现的**产品缺陷**，不在本次范围内，已单独记给老板；门这边先不假装它在。）
  'image-edit': ['text'],            // 只有水印文字是"写出去的话"
  'image-compress': [],
  'gif-make': [],                    // text 参数是**画在图上的字**，不是文档正文；扫它会误伤
  'video-make': [],
  'media-edit': [],
  'concat-video': [],
  'miniprogram-scaffold': [],
  'zip-pack': [],
});

/**
 * 把任意 JSON 结构里的**所有字符串叶子**按出现顺序摊平。
 *
 * ★ 为什么必须摊平，而不是直接扫 JSON 原文（这是判据能不能成立的关键）：
 *   `scanClaims` 是「按行 + 前后各 2 行找来源」。`sections` 常常是一整行 JSON
 *   （textarea 里粘进去的），于是 9 处「已核对」和 1 处「来源：用户确认」全落在**同一行**，
 *   同一个上下文窗口 ⇒ 一个来源把九句都保下来了 ⇒ **全部漏判**，而且 totally 静默。
 *   摊平成「一条字符串一行」之后，判据恢复到设计时的粒度：一句话一个窗口。
 *
 * 深度上限防御 JSON 炸弹式的深度嵌套（正常数据 3~4 层）。
 */
function flattenStrings(v, out, depth) {
  const acc = out || [];
  const d = depth || 0;
  if (d > 8 || acc.length > 20000) return acc;
  if (typeof v === 'string') { if (v) acc.push(v); return acc; }
  if (Array.isArray(v)) { for (const it of v) flattenStrings(it, acc, d + 1); return acc; }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) flattenStrings(v[k], acc, d + 1);
    return acc;
  }
  return acc;
}

/**
 * 收集一次调用「会被写出去的全部正文」。
 *
 * 失败方向：**fail-open**（与文件头注一致）—— 收不到就当没有正文，绝不让收集逻辑自己坏掉交付。
 * 但「收不到」必须能与「收到了、没命中」在 reason 上分开：
 *   `no-claim-text-param`（该技能无正文字段）/ `empty-claim-text`（有字段但都是空的）。
 *
 * @returns {{text:string, reason:string}}
 */
function collectClaimText(skillName, params) {
  const name = String(skillName == null ? '' : skillName);
  const fields = CLAIM_TEXT_FIELDS[name];
  if (!fields || !fields.length) return { text: '', reason: 'no-claim-text-param' };
  const prm = (params && typeof params === 'object') ? params : {};
  const parts = [];
  for (const f of fields) {
    const raw = prm[f];
    if (raw == null) continue;
    if (typeof raw !== 'string') { flattenStrings(raw, parts, 0); continue; }
    const s = raw;
    if (!s.trim()) continue;
    // JSON 形态（sections / slides / files / headers / rows）⇒ 摊平成"一条一行"；
    // 解不开就按原文收（原文里同样有字，只是粒度差一点 —— 比丢掉强）。
    const t = s.trim();
    if (t.charAt(0) === '[' || t.charAt(0) === '{') {
      let parsed = null;
      try { parsed = JSON.parse(t); } catch { parsed = null; }
      if (parsed !== null) { flattenStrings(parsed, parts, 0); continue; }
    }
    parts.push(s);
  }
  const text = parts.join('\n');
  return { text, reason: text ? 'collected' : 'empty-claim-text' };
}

/**
 * 事实门的判定（纯函数，与 `planAuthGate` 同形，便于 backend 在同一个位置接）。
 *
 * @param {object} o
 * @param {string} o.skillName
 * @param {object} [o.params]    该次调用入参（产出类技能从这里收正文，见 CLAIM_TEXT_FIELDS）
 * @param {string} o.path        目标路径（file-write 用它判类型；产出类只用于回灌文案）
 * @param {string} o.content     file-write 的正文（保留原入口，不要求调用方改造）
 * @param {boolean} [o.alreadyBlocked] 本任务内是否已被本门拦过（只拦一次，避免死循环）
 * @returns {{blocked:boolean, reason:string, total:number, samples:Array, directive:string, event:object}}
 */
function planContentClaimGate(o) {
  const c = o || {};
  const pass = (reason) => ({
    blocked: false, reason, total: 0, samples: [], directive: '', event: {},
  });

  const name = String(c.skillName == null ? '' : c.skillName);
  // ★ 2026-11-11 夜：判据由 `name !== 'file-write'` 改为「是不是产出类技能」。
  //   理由与授权门同一条：0.21.31 的病根不是"某个技能写错了"，是"门只认一个技能名"。
  if (!isProducerSkill(name, c.params)) return pass('not-producer-skill');
  if (c.alreadyBlocked === true) return pass('already-blocked-once');

  const p = String(c.path == null ? '' : c.path);
  const isFileWrite = name === 'file-write';
  // file-write 保留原有的「只扫正文类文件」限制（.md/.txt/.csv…）；
  // 产出类技能**必须跳过**这个限制：.docx / .pptx / .pdf 里同样是文字，
  // 0.21.31 那份撒谎的正文就在 .docx 里 —— 按扩展名排除等于把事故正靶子排除掉。
  if (isFileWrite && !CLAIM_TEXT_EXT_RE.test(p)) return pass('not-claim-text');

  let text = String(c.content == null ? '' : c.content);
  let collectReason = 'file-write-content';
  if (!isFileWrite) {
    const got = collectClaimText(name, c.params);
    text = got.text;
    collectReason = got.reason;
    if (!text) return pass(collectReason);
  }

  let scan;
  try {
    scan = scanClaims(text);
  } catch (e) {
    // ★ fail-open：判据自己坏了不许阻断交付（见文件头注"失败方向"）
    return pass('scan-error:' + String((e && e.message) || e).slice(0, 60));
  }
  if (!scan.unsupported.length) return pass('no-unsupported-claim');

  // 只报前 5 处：一份 500 行的文档可能有 20 处，全列出来反而让模型只改前几条就交差。
  const samples = scan.unsupported.slice(0, 5);
  return {
    blocked: true,
    reason: 'unsupported-claim',
    total: scan.total,
    samples,
    directive: contentClaimDirective(samples, scan.total, p || name),
    event: {
      gate: 'content-claim',
      skill: name,
      target: p,
      // ★ 这一位让事后能分清「扫了、没命中」与「根本没收到正文」——
      //   两者在 total=0 这个读数上长得一模一样，但含义相反。
      textSource: collectReason,
      textChars: text.length,
      total: scan.total,
      firstLine: samples[0] ? samples[0].line : 0,
      firstClaim: samples[0] ? samples[0].claim : '',
    },
  };
}

/**
 * 被事实门拦下时回灌给模型的 tool 结果。
 * 三件事：① 文件没写；② 具体是哪几行哪句；③ 两条**可执行**的改法（补来源 / 改成待确认）。
 */
function contentClaimDirective(samples, total, targetPath) {
  const list = Array.isArray(samples) ? samples : [];
  const n = Number.isFinite(total) ? total : list.length;
  const L = [];
  L.push('【没有写入文件】这次调用没有执行，目标文件未创建 / 未修改。');
  L.push('原因：正文里有 **' + n + '** 处「把没验证的东西说成已验证」的断言，但同一处找不到任何依据。');
  if (list.length) {
    L.push('命中的地方（最多列 5 处）：');
    for (const s of list) {
      L.push('· 第 ' + s.line + ' 行：「' + s.text + '」— 关键词「' + s.claim + '」');
    }
    if (n > list.length) L.push('· …另有 ' + (n - list.length) + ' 处同类。');
  }
  L.push('');
  L.push('两条改法，逐处二选一：');
  L.push('① **有依据** ⇒ 就地补上来源，例如「第 1 条已核对（依据：用户已确认）」'
    + '、「已确认 11 条归属（来源：用户答复第 2 段）」、「实测通过（命令输出见下）」。');
  L.push('② **没依据** ⇒ 把断言改成承诺级别的说法：「**待确认**」「尚未核实」「据推测，需用户确认」。');
  L.push('');
  L.push('★ 这不是在罚你诚实 —— 「待确认」这类标注是**合法的、必须写**的。');
  L.push('  真正不许写的是：**只确认了 2 条，却写「11 条已全部核对」**。');
  L.push('  人设 §八 讲的是「没验证过的，一个字都不能说成已完成」—— 那条纪律同样管写进文件的正文，');
  L.push('  不只是管聊天回复。');
  L.push('');
  L.push('★ 改完重新调用 file-write（整篇重写或 append 都行），不要再原样重发同一份内容。');
  if (targetPath) L.push('（目标文件：' + targetPath + '）');
  return L.join('\n');
}

/**
 * 给审查员看的一句话摘要（供 agentReview 的产物证据块复用）。
 * 为什么复用同一套判据：审查员"看不见正文"正是 2026-11-11 那次连问 4 轮的根因，
 * 而它最该看见的恰好就是这一句「正文里有几处无依据的断言」。
 *
 * @param {string} text
 * @returns {string} 例：`无依据断言 3 处（首次在第 5 行「已全部核对归属」）`；无命中返回 ''
 */
function summarizeClaims(text) {
  let scan;
  try { scan = scanClaims(text); } catch { return ''; }
  if (!scan.unsupported.length) return '';
  const f = scan.unsupported[0];
  return '无依据断言 ' + scan.unsupported.length + ' 处（首次在第 ' + f.line + ' 行「'
    + f.text.slice(0, 40) + '」）';
}

module.exports = {
  CTX_LINES,
  CLAIM_RE,
  SOURCE_RE,
  CLAIM_TEXT_EXT_RE,
  // ★ 产出类技能的正文收集（2026-11-11 夜）：门禁要能对"收到的是哪段文本"做断言，
  //   否则 total=0 分不清"扫了没命中"与"根本没收到正文"。
  CLAIM_TEXT_FIELDS,
  collectClaimText,
  flattenStrings,
  lineIsHonestlyMarked,
  isBlanketClaim,
  scanClaims,
  planContentClaimGate,
  contentClaimDirective,
  summarizeClaims,
};
