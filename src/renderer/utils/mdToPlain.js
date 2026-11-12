/**
 * mdToPlain —— 「Markdown → 纯文本」的唯一真源。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这个文件（用户 0.21.25 报障）
 * ────────────────────────────────────────────────────────────────────────────
 * 老板原话：「生的文章 不要有 ## ** 这种没有意义的符号」。
 *
 * 阅读面（屏幕上）的问题已由 `components/Markdown.jsx` 的 normalize 补空格修掉；
 * 但**文本出口**是另一条完全独立的路径 —— 复制到剪贴板、卡片预览切片，走的都是
 * 数据库/模型吐出来的**原始 Markdown 字符串**，一次都没经过渲染器。于是：
 *   · 「复制全文」粘到公众号/微信里 = `## 最终文章` `**重点**` 原样可见；
 *   · 资产卡片的 80 字预览，前两个字就是 `##` —— 比正文里露符号更刺眼。
 *
 * 本文件只做一件事：**保留文字，去掉标记**。不改写、不摘要、不重排语义。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 口径（三条，别改）
 * ────────────────────────────────────────────────────────────────────────────
 * ① **绝不抛异常**：入参不是字符串（null / undefined / 数字 / 对象 / 数组）一律返回 ''。
 *    这些调用点全在 UI 事件里，一个 throw 会白屏，而"复制出来的是空串"最多是没复制到。
 * ② **围栏内的内容原样保留**：代码块是有意义的内容，只去掉 ``` 那一行和语言标识。
 * ③ **换行保留**：调用方（朋友圈文案 / 群内容 / 节点字段）靠 `white-space: pre-wrap`
 *    出段落感，本函数不许把 \n 压成空格 —— 只有「连续 3 个以上空行」才压成 2 个。
 *
 * 用法：
 *   import { mdToPlain } from '../utils/mdToPlain.js';
 *   await copyText(mdToPlain(resultText));
 */

/**
 * 表格分隔行 / 水平分隔线：整行只由 `-` `|` `:` 与空白组成时，它是纯排版标记，整行删掉。
 *
 * 中间那个 `[-:|]` 是必需的：没有它，`^[\s:|-]+$` 会把**只有空格的空行**也吃掉，
 * 段落间距会一起消失（正文变成一大坨）。
 * 反例（必须**不**命中）：`- 一项` / `· 一项` —— 行里还有中文字，吃不到行尾。
 */
const RULE_LINE_RE = /^\s*\|?[ \t:|-]*[-:|][ \t:|-]*\|?\s*$/;

/** 代码围栏行（``` 或 ~~~，允许 0~3 个前导空格、允许跟语言标识）。 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * 判断某一行是不是表格数据行。
 * 只认「以 | 开头」或「至少 2 个 |」，避免把正文里偶尔出现的一个竖线当表格。
 * @param {string} line
 * @returns {boolean}
 */
function isTableRow(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (t.charAt(0) === '|') return true;
  const hits = t.split('|').length - 1;
  return hits >= 2;
}

/**
 * 行内标记 → 纯文本（同一行内的处理，不跨行）。
 * 顺序有意义：图片必须先于链接（`![x](y)` 也满足 `[x](y)` 的形状）。
 * @param {string} line 单行文本
 * @returns {string}
 */
function inlineToPlain(line) {
  let t = String(line || '');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // 图片 → alt 文字
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接 → 链接文字
  t = t.replace(/`([^`\n]+)`/g, '$1'); // 行内代码 → 代码内容
  t = t.replace(/~~([^\n~]+)~~/g, '$1'); // ~~删除线~~（GFM）
  t = t.replace(/\*\*([^\n*]+)\*\*/g, '$1'); // **粗**
  t = t.replace(/(?<![\w*])__([^\n_]+)__(?![\w*])/g, '$1'); // __粗__（不当 snake_case 处理）
  t = t.replace(/(?<![\w*])\*([^\n*]+)\*(?![\w*])/g, '$1'); // *斜*
  t = t.replace(/(?<![\w_])_([^\n_]+)_(?![\w_])/g, '$1'); // _斜_（同理不碰 file_name）
  return t;
}

/**
 * 单行 → 纯文本（块级标记 + 行内标记）。
 * @param {string} line 原始一行
 * @param {boolean} inFence 是否处在代码围栏内部（是则原样返回）
 * @returns {string}
 */
function lineToPlain(line, inFence) {
  if (inFence) return line;
  if (RULE_LINE_RE.test(line)) return '';
  let s = String(line || '');
  s = s.replace(/^\s{0,3}(?:>[ \t]?)+/, ''); // 引用（支持 >> 嵌套）
  /**
   * 标题：只剥这两种形态 ——
   *   ① `#{2,6}` 后面跟空白/行尾，**或**紧跟非空白非 `#`（`##最终文章` 这种标题误写）；
   *   ② 单个 `#` 后面跟空白或行尾（CommonMark 正规一级标题 `# 标题`）。
   *
   * ⚠️ **单 `#` 紧跟非空白时故意不剥**。这不是漏处理，是防过度清洗：
   *   `#1 号牙`（牙位编号）、`#话题`（社交标签）、`#tag` 在正文里是**内容**不是标记，
   *   剥掉等于篡改产品文案。本产品是口腔医疗营销场景，`#1 号牙` 这类是真实业务数据。
   * 代价：`#标题`（单 # 紧贴标题字）不再被剥。这是**口径取舍**，已与 team-lead 对齐：
   *   牺牲罕见的单 # 标题误写形态，换取产品数据零篡改。
   *   （`#{2,6}` 紧贴形态仍然照剥 —— 多个 # 连写不可能出现在正文里，只可能是标题误写。）
   */
  s = s.replace(/^\s{0,3}#{2,6}(?:[ \t]+|$|(?=[^\s#]))/, '');
  s = s.replace(/^\s{0,3}#(?:[ \t]+|$)/, '');
  s = s.replace(/^(\s*)[-*+][ \t]+/, '$1· '); // 无序列表 → 「· 」
  s = s.replace(/^(\s*)(\d+)[.)][ \t]+/, '$1$2. '); // 有序列表保留 "1. "
  if (isTableRow(s)) {
    s = s.replace(/\|/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  }
  return inlineToPlain(s);
}

/**
 * 把 Markdown 正文压成可以直接贴到任何地方的纯文本。
 *
 * @param {string} text Markdown 原文
 * @returns {string} 纯文本；入参不是字符串时返回 ''，任何内部异常也返回 ''
 */
export function mdToPlain(text) {
  try {
    if (typeof text !== 'string' || !text) return '';
    const src = text.replace(/\r\n?/g, '\n');
    const kept = [];
    /** 当前处在哪个围栏里（空串 = 不在围栏内）。 */
    let fenceMark = '';
    for (const line of src.split('\n')) {
      const fenceM = FENCE_RE.exec(line);
      if (fenceM) {
        const mark = fenceM[1].charAt(0);
        if (!fenceMark) fenceMark = mark;
        else if (fenceMark === mark) fenceMark = '';
        // 开/闭围栏行本身连同语言标识一起丢掉；围栏**内**的内容不受影响。
        continue;
      }
      kept.push(lineToPlain(line, fenceMark !== ''));
    }
    return kept
      .join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

export default mdToPlain;
