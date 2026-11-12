/**
 * autoTitle —— 「按你做的事自动取名字」（2026-10-19 第十九轮 · 老板第 3 条）。
 *
 * 老板原话：「并且会根据你做的内容自动给你取名字」。
 * 在此之前，对话标题是 `text.slice(0, 24)` 的**原样硬截**（App.jsx send()）——
 * 于是任务栏里出现的是「帮我写一条春季种植体的朋友圈文案，再配三个标题」这种
 * 又长又带口头语的行，扫一眼根本分不清哪条是哪条。
 *
 * 本文件是**纯函数**（无 React / 无 Electron / 无 localStorage），可在 node 里裸测：
 *   node --input-type=module -e "import {autoTitle} from './src/renderer/services/autoTitle.js'; ..."
 *
 * 规则（与老板需求逐条对应，顺序不能换）：
 *   1. 去换行（换行折成一个空格，避免多行任务把标题撑成「前半句 + 空白」）；
 *   2. 压缩连续空白；
 *   3. 去开头标点（中文引号/书名号/括号/顿号这类「不是内容」的壳）；
 *   4. 去口头前缀（帮我 / 请 / 我想要 …，可叠加，例如「麻烦你帮我…」）；
 *   5. 去结尾标点；
 *   6. 取前 18 个字符，超出加「…」（截断点在空格上时先 trim，别让标题以空格结尾）；
 *   7. 全空 ⇒ 回退 fallback。
 *
 * 为什么不做「智能摘要」而做「清洗 + 截断」：
 *   摘录要调模型 ⇒ 建会话时多一次网络请求、还要处理失败重试，而标题只是列表里的一行字，
 *   不值得为它引入异步与不确定性。清洗 + 截断是同步的、可预测的、可单测的。
 */

/** 标题最大显示宽度（字符数）。超出加省略号。 */
export const AUTO_TITLE_MAX = 18;

/**
 * 「不是内容」的口头前缀。**长的排在前面**，保证「麻烦你帮我」先整体剥掉，
 * 而不是先剥「麻烦」再剩「你帮我」被漏掉。
 */
export const AUTO_TITLE_PREFIXES = [
  '麻烦你帮我',
  '麻烦帮我',
  '能不能帮我',
  '可以帮我',
  '你帮我',
  '请帮我',
  '帮我',
  '帮忙',
  '请你',
  '麻烦你',
  '我想要',
  '我想让',
  '我想',
  '我要',
  '想让你',
  '我需要',
  '给我',
  '麻烦',
  '请',
];

/**
 * 首尾要剥掉的标点 / 引号 / 括号壳。
 *
 * 【2026-10-19 补】原字符类里有 `“”‘’`（英文弯引号）与 `《》`，但**漏了中文直角引号
 * 「」『』**，以及 `〈〉〔〕`。中文里「」是最常用的引号之一（老板自己的需求原话就通篇用「」），
 * 于是「「春季种植体」文案怎么写」这条标题会**以「开头**，在任务栏里看起来像排版坏了。
 *
 * 这个缺口不是靠读代码发现的 —— 是 `scripts/smoke/unit-autotitle.mjs` 先写了
 * 「开头引号壳必须剥掉」的断言、跑出 1 条红才暴露出来的。补完后该用例转绿，
 * 同文件里的 RC1/RC2/RC3 三组变异反控仍红（15 / 24 / 11 条），证明断言没有被削弱。
 */
const LEAD_TRIM = /^[\s，,。.、；;：:！!？?~～…—\-_+*/\\|"'“”‘’「」『』《》〈〉〔〕<>（）()【】\[\]{}]+/;
const TAIL_TRIM = /[\s，,。.、；;：:！!？?~～…—\-_+*/\\|"'“”‘’「」『』《》〈〉〔〕<>（）()【】\[\]{}]+$/;

/**
 * 剥一层口头前缀（只剥一层，由调用方循环到剥不动为止，防「帮我帮我看…」这种叠词死循环）。
 * @param {string} s 已清洗过的文本
 * @returns {string}
 */
function stripOnePrefix(s) {
  for (const p of AUTO_TITLE_PREFIXES) {
    if (!s.startsWith(p)) continue;
    const rest = s.slice(p.length);
    // 剥完什么都没了 ⇒ 这一层不能剥（否则「帮我」这种纯口头语会变成空标题）
    if (!rest.trim()) return s;
    // 「请问 / 请教 / 请示」不是口头前缀，是问题的一部分 —— 裸「请」不许剥掉它们
    if (p === '请' && /^[问教示假帮]/.test(rest)) return s;
    return rest;
  }
  return s;
}

/**
 * 按内容自动生成任务标题。
 *
 * @param {string} text 原始内容（用户说的第一句话 / 任务描述）
 * @param {string} [fallback] 清洗后为空时的回退标题（默认「新对话」）
 * @returns {string} 不超过 AUTO_TITLE_MAX+1 个字符的标题（超出时末位是「…」）
 */
export function autoTitle(text, fallback) {
  const fb = typeof fallback === 'string' && fallback.trim() ? fallback.trim() : '新对话';
  let s = typeof text === 'string' ? text : text == null ? '' : String(text);

  // 1 + 2：换行折成空格、压缩连续空白
  s = s.replace(/\s+/g, ' ').trim();
  // 3：开头标点/引号壳
  s = s.replace(LEAD_TRIM, '').trim();
  // 4：口头前缀（可叠加，最多剥 4 层，防御异常输入）
  for (let i = 0; i < 4; i += 1) {
    const next = stripOnePrefix(s);
    if (next === s) break;
    s = next.replace(LEAD_TRIM, '').trim();
  }
  // 5：结尾标点
  s = s.replace(TAIL_TRIM, '').trim();

  if (!s) return fb;
  if (s.length <= AUTO_TITLE_MAX) return s;
  // 6：截断。落在空格上时先 trim，避免标题以空格结尾（「…朋友圈文案 …」那种脏观感）
  const cut = s.slice(0, AUTO_TITLE_MAX).trim();
  return (cut || s.slice(0, AUTO_TITLE_MAX)) + '…';
}

export default { autoTitle, AUTO_TITLE_MAX, AUTO_TITLE_PREFIXES };
