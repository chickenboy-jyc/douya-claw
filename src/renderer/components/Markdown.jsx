import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/** 代码围栏行（``` 或 ~~~，允许 0~3 个前导空格）。 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * 逐行给「没有空格的 Markdown 标记」补一个空格。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 为什么必须有这一层（用户 0.21.25 报障）
 * ──────────────────────────────────────────────────────────────────────────
 * 老板原话：「生的文章 不要有 ## ** 这种没有意义的符号」。
 *
 * 后端 prompt 强制模型用 Markdown 输出（`## 最终文章` 是
 * `NewMediaWorkbench.splitSections()` 的分段契约，不能改），但模型经常把
 * 标题写成 `##最终文章` / `###一、事件评估` —— **# 后面没有空格**。
 * CommonMark 只认 `## `（# 之后必须跟空白），于是 `##最终文章` 不是 heading，
 * 而是一个普通段落 ⇒ 用户看到的是一行带 `##` 的正文。这就是"符号上屏"的
 * 首要机制原因（14 个渲染面全部共用本组件，一处修全修）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 只补空格，不改任何正文文字
 * ──────────────────────────────────────────────────────────────────────────
 * · `#{1,6}`：`##标题` → `## 标题`
 * · `\d+\.` ：`1.项`   → `1. 项`
 * · `[-*+]` ：`-项`    → `- 项`（`**粗**` 已被 `(?!\s|\*)` 挡住；行首 `*强调*`
 *   由下面的额外守卫挡住，否则会把强调改坏成列表项 —— 那才是真回归）
 *
 * **代码围栏内部一律不动**：`#注释` / `-something` 在代码块里就是正文，
 * 补空格会静默改动用户代码。
 *
 * @param {string} text 已经压过空行的文本
 * @returns {string}
 */
function fixMarkerSpacing(text) {
  const lines = String(text == null ? '' : text).split('\n');
  /** 当前处在哪个围栏里（空串 = 不在围栏内）。 */
  let fenceMark = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceM = FENCE_RE.exec(line);
    if (fenceM) {
      const mark = fenceM[1].charAt(0);
      if (!fenceMark) fenceMark = mark;
      else if (fenceMark === mark) fenceMark = '';
      continue; // 围栏行本身不需要改
    }
    if (fenceMark) continue; // 围栏内容原样保留
    lines[i] = line
      .replace(/^(\s{0,3})(#{1,6})(?=[^\s#])/, '$1$2 ')
      .replace(/^(\s{0,3})(\d+\.)(?=[^\s\d])/, '$1$2 ')
      .replace(/^(\s{0,3})([-*+])(?!\s|\*)/, (all, indent, mark, offset, whole) => {
        // `*强调*` 这种行首强调：标记后面还有同一个 `*` ⇒ 是强调不是列表，不动它。
        if (mark === '*' && String(whole).indexOf('*', offset + indent.length + 1) >= 0) return all;
        return indent + mark + ' ';
      });
  }
  return lines.join('\n');
}

// 折叠多余空行：模型输出常有连续 3+ 个换行，react-markdown 会渲染出一堆空段落，导致「动不动空一行」。
// 这里把 3 个以上连续换行压成 1 个空行（\n\n），并去掉行尾多余空格，让排版紧凑自然。
// 之后再逐行给缺空格的 Markdown 标记补空格（见 fixMarkerSpacing 的说明）。
//
// 导出 `normalize` 是为了让 `scripts/smoke/unit-md-plain.mjs` 能用**仓库已有的
// remark-parse 真解析**验证「`##无空格标题` 确实变成了 heading」，而不是只做字符串断言。
/**
 * 渲染前的文本规范化：压空行 + 补标记空格。
 * @param {*} text 任意输入（null / undefined / 数字都能吃）
 * @returns {string}
 */
export function normalize(text) {
  const base = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return fixMarkerSpacing(base).trim();
}

export default function Markdown({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
    >
      {normalize(children)}
    </ReactMarkdown>
  );
}
