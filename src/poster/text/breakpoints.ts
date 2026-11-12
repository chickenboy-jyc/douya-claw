/**
 * 断点策略 —— 把一段文本切成**可断单元**，以及「自己就超宽」的单元怎么硬切。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么从 `wrap.ts` 拆出来（不是为了好看）
 * ════════════════════════════════════════════════════════════════════════════
 * 单文件 250 行是**硬门禁**（`unit-ts-strict.mjs` 第 4 段），而 `wrap.ts` 已经 248 行。
 * 加任何一行都会撞线 —— 撞线之后的正确做法不是压缩注释，而是按职责拆：本文件做的
 * 全是「在哪能断」（字符分类 + 切分），`wrap.ts` 做的是「断在哪」（贪心累加 + 截断）。
 * 两者唯一的耦合是「量宽函数」，所以边界正好切在这里。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么 CJK 用区间表而不是 `\p{Script=Han}` 正则
 * ════════════════════════════════════════════════════════════════════════════
 * 区间表是**数据**：漏了哪一段，加一行就能看出来。正则的误判只能靠猜。
 * 扩展 B 及以后的汉字（≥0x20000）只有 `codePointAt` 拿得到 ⇒ 本模块**不用 `charCodeAt`**，
 * 否则代理对会被当成两个「字」，逐字断行时会把一个字劈成两半。
 */

/** 行宽测量函数（已含字距，由调用方闭包进来）。 */
type WidthOf = (text: string) => number;

/**
 * CJK 码点区间：落在区间内的码点**逐字断行**，其余累积成词再断。
 *
 * 把标点（0x3000-0x303F）、假名、全角区一起收，是因为中文海报里 `。，、「」` 的断行
 * 必须与汉字一致 —— 否则会出现「行首是句号」，而那是排版事故不是设计选择。
 */
export const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x2eff], [0x2f00, 0x2fdf], [0x3000, 0x303f], [0x3040, 0x309f], [0x30a0, 0x30ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xffef],
  [0x20000, 0x2a6df], [0x2a700, 0x2ebef], [0x2f800, 0x2fa1f], [0x30000, 0x3134f],
];

/** 码点是否落在 CJK 区间内。 */
export function isCjkCodePoint(codePoint: number): boolean {
  if (!Number.isFinite(codePoint)) return false;
  return CJK_RANGES.some((range) => codePoint >= range[0] && codePoint <= range[1]);
}

/**
 * 循环的硬迭代上限。换行最经典的 bug 是死循环（字符超宽 + 当前行已满 ⇒ 压不进也退
 * 不出），本模块每步都消费至少一个字符 ⇒ 这是**逃生阀**，不是主判据。
 */
const MAX_STEPS = 10000;

/** 断行单元：`space` 为 true 表示空白串（可丢），否则是一片不可再分的「词」。 */
export interface BreakToken {
  readonly text: string;
  readonly space: boolean;
}

/**
 * 把一段（无 `\n`）文本切成断行单元：空白串 → space 单元；CJK 码点 → 单独一个单元；
 * `-` → 并入当前词后**立刻收口**（`well-known` ⇒ `['well-','known']`，整词放不下时
 * 天然断在连字符后）；字母数字 → 累积成词；其余符号 → 单独一个单元。
 * ⚠ 全角空格 0x3000 在 CJK 区间里但它是**空白**，先判空白。
 */
export function tokenize(paragraph: string): BreakToken[] {
  const tokens: BreakToken[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') {
      tokens.push({ text: buf, space: false });
      buf = '';
    }
  };
  for (const ch of Array.from(paragraph)) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    if (ch === ' ' || ch === '\t' || ch === '\u00a0' || ch === '\u3000') {
      flush();
      const previous = tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
      if (previous !== undefined && previous.space) {
        tokens[tokens.length - 1] = { text: previous.text + ch, space: true };
      } else {
        tokens.push({ text: ch, space: true });
      }
      continue;
    }
    if (isCjkCodePoint(codePoint)) {
      flush();
      tokens.push({ text: ch, space: false });
      continue;
    }
    if (ch === '-') {
      buf += ch;
      flush(); // 连字符留在前半段末尾 ⇒ 断点就在它后面
      continue;
    }
    if (/[0-9A-Za-z]/.test(ch)) {
      buf += ch;
      continue;
    }
    flush();
    tokens.push({ text: ch, space: false });
  }
  flush();
  return tokens;
}

/**
 * 把**自己就比整行宽**的单元硬切开，每片尽量满且不超宽。
 *
 * 前进性证明（唯一要小心的地方）：内层从 `start + 1` 起算 ⇒ 每次至少吃 1 个字符 ⇒
 * `start` 严格递增 ⇒ 必然终止。单字符本身超宽时内层不执行（它只检查「再加一个是否
 * 超宽」），该字符独占一行 —— 既满足「不许死循环」，也**不隐藏**溢出（吞字符会让
 * 用户以为字丢了）。切点优先落在连字符后（`well-/known` 而不是 `well-k/nown`）。
 *
 * @param text 待切单元
 * @param widthOf 量宽函数（已含字距）
 * @param limit 行宽上限
 * @returns 切好的片（每片单独成行）
 */
export function splitOversized(text: string, widthOf: WidthOf, limit: number): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length && parts.length < MAX_STEPS) {
    let end = start + 1; // 至少吃一个字符 ⇒ 一定前进
    while (end < chars.length && widthOf(chars.slice(start, end + 1).join('')) <= limit) {
      end += 1;
    }
    let cut = end;
    for (let i = end - 1; i > start; i -= 1) {
      if (chars[i] === '-') {
        cut = i + 1;
        break;
      }
    }
    parts.push(chars.slice(start, cut).join(''));
    start = cut;
  }
  if (start < chars.length) parts.push(chars.slice(start).join('')); // 逃生阀出口
  return parts;
}
