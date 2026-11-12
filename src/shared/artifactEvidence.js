/**
 * artifactEvidence.js —— 产物「结构指纹」抽取（**一份真源**）。
 *
 * 【为什么必须存在这个文件】
 *   2026-10-21 实测（`scripts/tmp-probe/review-sees-layout.mjs`，真模型 + 确定性两路）：
 *   验收闸（自查员 / 复检员）拿到的产物清单只有**一个路径**——`summarizeWork` 里
 *   `deliverables.map(d => '· ' + d.path)`，零 fs 调用。后果连续两条，都实测到了：
 *     ① 它**物理上**看不见文件里有什么 ⇒ 页数、图片尺寸、排版全部不可见；
 *     ② 于是在「看不见」的基础上只能判「**无法核实**」⇒ 一个真正合格的产物也会被判未完成，
 *        然后回灌 missing 让 agent 再去「核实一遍」，白跑轮次、还对用户说"还没验过"。
 *   所以缺的不是「更聪明的提示词」，是**事实**。本文件只提供事实，不下判断。
 *
 * 【纪律：事实与判断分离】
 *   这里只输出可数的东西（字节数 / 页数 / 图片张数 / 写死的宽高 / 是否 overflow:hidden），
 *   **不写「这个排版有问题」**。判断留给审查员 —— 否则等于把审查结论写死在代码里，
 *   以后模型换了、模板换了，代码里的结论就成了没人敢改的教条。
 *
 * 【为什么放在 src/shared（而不是塞进 agentReview 或 backend）】
 *   页数判据（`class="slide"` / `<section>` / `class="page"` 取最大）在
 *   `scripts/tmp-probe/real-model-e2e.mjs` 里已经有一份**探针本地实现**。两边各写一份
 *   必然漂移，而漂移的症状是「探针说 15 页、审查员看到 3 页」这种没人会想到去查的地方。
 *   ⇒ 抽成一份，探针与 agentReview 共用。
 *
 * 【边界：只读头部，绝不整读】
 *   `MAX_READ` 之前的内容才解析。理由：产物可能是几百 MB 的视频/PDF，
 *   审查链路上任何一次整读都会把主进程卡住。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 只解析头部这么多字节。超出部分不计入统计（并在文案里如实标注"仅统计前 N"）。 */
const MAX_READ = 256 * 1024;

/** 单个产物的证据描述上限，防止某个怪文件把 prompt 撑爆。 */
const MAX_ONE = 220;

/** 全部产物证据的合计上限。 */
const MAX_TOTAL = 1200;

/**
 * 纯文本类产物（.md/.txt/.csv/.tsv）的正文节选长度上限。
 * 为什么要单独给一档、而不是沿用 MAX_ONE 的剩余空间：这两类文件是**文案/报告/清单**，
 * 审查员要核的是内容本身（"11 条归属对不对"），只给"207 行"等于没给。
 * 220 的总帽子里，节选占 120，剩下的留给行数/标题/其它指纹。
 */
const EXCERPT_MAX = 120;

/**
 * 纯文本类扩展名。刻意与 TEXT_EXT 区分开：TEXT_EXT 决定「要不要解析」，
 * 本集合决定「要不要给正文节选」——后者只对**人能直接读的文稿**有意义。
 * 不把 .json/.js/.html 收进来：那些文件的"正文"是结构/代码，节选出来对审查员是噪音。
 */
const PLAIN_TEXT_EXT = /\.(?:md|markdown|txt|csv|tsv)$/i;

const TEXT_EXT = new Set([
  '.html', '.htm', '.xhtml', '.md', '.txt', '.json', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.scss',
  '.svg', '.xml', '.yml', '.yaml', '.py', '.sh', '.bat', '.ps1', '.vue',
]);

/**
 * HTML/PPT 类产物的**页数**判据。
 *
 * 为什么取三者最大值而不是只认一个：仓库里实际出现过三种写法
 * （`class="slide"`、`<section>`、`class="page"`），只认一种就会把另一种报成「0 页」，
 * 而 0 页会让审查员判出一个**完全错误**的结论 —— 比"没证据"更糟（是假证据）。
 *
 * ★★ 2026-10-21 修一个**假证据源**（真模型 e2e 当场撞到，读数 `slide=30 section=15`）：
 *   第一版用 `/\bslide\b/` 在 class 值里做词边界匹配。词边界的 `\b` 只认「字母/数字 ↔ 非字母数字」，
 *   `-` 正好是非字母数字 ⇒ `class="slide-nav"` **也命中**。于是 15 个 `<section class="slide">`
 *   加 15 个 `slide-nav`（翻页导航）被算成 **30 页**，而文件其实只有 15 页。
 *   危害方向很隐蔽：审查员会拿「声称 15 页 / 实际 30 页」去判**未完成**，
 *   一个完全合格的产物被判没做完 —— 和这次要修的病同型，只是反过来。
 *   ⇒ 判据改成「把 class 值按空白切成 token，**整 token 等于** slide/page 才算」。
 *      `slide-nav` / `page-header` / `slider` / `slides` 一律不算。
 *
 * @param {string} text 文件内容（或头部）
 * @returns {number} 页数（判不出为 0）
 */
function countDeckPages(text) {
  const t = String(text || '');
  if (!t) return 0;

  // 逐个 class 属性取值，切成 token 做**精确**匹配（不做子串、不做词边界）
  const classTokens = (word) => {
    let n = 0;
    for (const m of t.matchAll(/\bclass\s*=\s*(["'])([^"']*)\1/gi)) {
      for (const tok of String(m[2]).split(/\s+/)) {
        if (tok === word) n += 1;
      }
    }
    return n;
  };

  const byClass = classTokens('slide');
  const bySection = (t.match(/<section\b/gi) || []).length;
  const byPage = classTokens('page');
  return Math.max(byClass, bySection, byPage);
}

/** 13.2KB / 940B / 3.1MB 这类人读的大小。 */
function humanSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'KB';
  return (b / 1024 / 1024).toFixed(1) + 'MB';
}

/**
 * 抽出文件里**写死**的图片宽高（`width:400px;height:120px` 或 `width="400" height="120"`）。
 * 只报「有几种尺寸、各几张」这个事实，不判"是否被拉伸" —— 判断归审查员。
 * @returns {Array<{w:number,h:number,n:number}>}
 */
function imageSizes(text) {
  const t = String(text || '');
  const bag = new Map();
  const push = (w, h) => {
    const k = w + 'x' + h;
    bag.set(k, (bag.get(k) || 0) + 1);
  };
  // 内联样式：width:400px; height:120px（顺序可颠倒，中间允许别的声明）
  for (const m of t.matchAll(/<img\b[^>]*style\s*=\s*["']([^"']*)["']/gi)) {
    const s = m[1];
    const w = /\bwidth\s*:\s*(\d+)px/i.exec(s);
    const h = /\bheight\s*:\s*(\d+)px/i.exec(s);
    if (w && h) push(Number(w[1]), Number(h[1]));
  }
  // 属性写法
  for (const m of t.matchAll(/<img\b([^>]*)>/gi)) {
    const a = m[1];
    const w = /\bwidth\s*=\s*["']?(\d+)/i.exec(a);
    const h = /\bheight\s*=\s*["']?(\d+)/i.exec(a);
    if (w && h) push(Number(w[1]), Number(h[1]));
  }
  return [...bag.entries()]
    .map(([k, n]) => { const [w, h] = k.split('x').map(Number); return { w, h, n }; })
    .sort((x, y) => x.w * x.h - y.w * y.h)
    .slice(0, 4);
}

/**
 * 为一个产物生成一行结构证据。
 *
 * 返回永远是短字符串（≤ MAX_ONE），**永远不抛**：
 * 审查链是增益功能，取证失败只该让证据变弱，不该让整个收尾崩掉。
 *
 * @param {string} p 产物路径（绝对或相对）
 * @returns {string} 例：`deck.html｜27.1KB｜15 页｜12 张图｜图尺寸 400×120（3 张）`
 */
function readArtifactEvidence(p) {
  const raw = String(p || '');
  const name = (() => {
    try { return path.basename(raw) || raw; } catch { return raw; }
  })();
  if (!raw) return '';
  try {
    const st = fs.statSync(raw);
    if (st.isDirectory()) return clamp(name + '｜是个目录，不是文件');
    const ext = path.extname(raw).toLowerCase();
    const head = '｜' + humanSize(st.size);
    if (!TEXT_EXT.has(ext)) return clamp(name + head + '｜（二进制/未知类型，未解析内容）');

    const truncated = st.size > MAX_READ;
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
    const fd = fs.openSync(raw, 'r');
    let read = 0;
    try { read = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const text = buf.slice(0, read).toString('utf8');

    const parts = [name + head];

    // 页数：只对 HTML 系有意义；md/txt 里出现 class="slide" 的概率极低，误报也无害
    const pages = countDeckPages(text);
    if (pages > 0) parts.push(pages + ' 页');

    const imgs = (text.match(/<img\b/gi) || []).length;
    if (imgs > 0) parts.push(imgs + ' 张图');
    const sizes = imageSizes(text);
    if (sizes.length) {
      parts.push('图尺寸 ' + sizes.map((s) => s.w + '×' + s.h
        + (s.n > 1 ? '（' + s.n + ' 张）' : '')).join('/'));
    }
    if (/overflow\s*:\s*hidden/i.test(text)) parts.push('样式含 overflow:hidden');

    // ★★ 2026-11-11【纯文本类给正文，不给空壳】—— 事故第 3 条的直接根因就在这一行前面：
    //   .md 在 TEXT_EXT 里（内容**被读了**），但下面只 push 了「文件名｜大小」。
    //   页数判据对 .md 恒 0、图数恒 0、图尺寸恒空、overflow 恒 false
    //   ⇒ 审查员拿到的就是「文案.md｜7.6KB」，**正文一个字都看不见**。
    //   于是它只能反复判「无法核实」，实测连问 4 轮、最后 audit 返回空。
    //   注意本文件的纪律：**只给事实、不下判断**。所以这里给的是
    //   「多少行 / 标题是什么 / 正文开头写了什么」—— 不是「这份文案合格/不合格」。
    if (PLAIN_TEXT_EXT.test(ext)) {
      const body = text;
      const allLines = body.split(/\r?\n/);
      const shownLines = truncated ? '（前 ' + humanSize(MAX_READ) + '）' : '';
      parts.push(allLines.length + ' 行' + shownLines);
      // 标题：一级标题优先，没有就取第一行非空。只给内容，不评价。
      const nonEmpty = allLines.filter((l) => l && l.trim());
      const h1 = nonEmpty.find((l) => /^\s*#\s+/.test(l));
      const titleRaw = (h1 || nonEmpty[0] || '').replace(/^\s*#+\s*/, '').trim();
      if (titleRaw) parts.push('标题「' + titleRaw.slice(0, 40) + '」');
      // 正文节选：跳过标题行与分隔线，取第一段有实质内容的文字。
      // ★ 为什么必须给节选：审查员要核的是「11 条暗号归属对不对」，那只能靠读正文。
      //   只给行数和标题，等于告诉它"有 207 行"却不给看一个字 —— 仍然是「无法核实」。
      const bodyLines = nonEmpty.filter((l) => {
        const t = l.trim();
        if (/^#+\s/.test(t)) return false;      // 跳过所有标题
        if (/^[-=*_]{3,}$/.test(t)) return false; // 跳过分隔线
        return true;
      });
      const excerpt = bodyLines.join(' ').replace(/\s+/g, ' ').trim();
      if (excerpt) parts.push('节选：' + excerpt.slice(0, EXCERPT_MAX));
    }

    if (truncated) parts.push('仅统计前 ' + humanSize(MAX_READ));

    return clamp(parts.join('｜'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return clamp(name + '｜**文件不存在**');
    return clamp(name + '｜取证失败：' + String((e && e.message) || e).slice(0, 60));
  }
}

function clamp(s) {
  const t = String(s || '');
  return t.length > MAX_ONE ? t.slice(0, MAX_ONE - 1) + '…' : t;
}

/**
 * 为一批产物生成证据块（每行一个）。合计超长时按顺序截断并如实标注。
 * @param {Array<{path?:string,name?:string}>} deliverables
 * @returns {string} 多行文本；无产物返回空串
 */
function buildEvidenceBlock(deliverables) {
  const list = Array.isArray(deliverables) ? deliverables : [];
  const lines = [];
  let used = 0;
  for (const d of list) {
    const p = (d && (d.path || d.name)) || '';
    if (!p) continue;
    const one = readArtifactEvidence(p);
    if (!one) continue;
    // ★ 记账必须算上「- 」前缀与换行符本身，否则 MAX_TOTAL 只是个近似值：
    //   每行都少算了 3 个字符，30 行就能把真实长度顶出上限（本门禁 C3 就是这么抓到的）。
    const line = '- ' + one;
    if (used + line.length + 1 > MAX_TOTAL) { lines.push('…（其余产物证据省略）'); break; }
    used += line.length + 1;
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = {
  MAX_READ,
  EXCERPT_MAX,
  PLAIN_TEXT_EXT,
  MAX_ONE,
  MAX_TOTAL,
  countDeckPages,
  imageSizes,
  humanSize,
  readArtifactEvidence,
  buildEvidenceBlock,
};
