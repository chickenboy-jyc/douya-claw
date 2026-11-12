/**
 * 文字换行 —— **纯排版算法，不许碰 canvas**。
 *
 * 为什么做成「注入 measure 的纯函数」：`PosterStudio.jsx:416` 把 `ctx.measureText`
 * 焊死在函数体里 ⇒ 只能靠真 canvas 才测得了，而 GUI 链路要起 Electron 才算数 ⇒ 实际
 * 没人给这段写单测，而换行错（词被劈开 / 字溢出画布）恰好是海报最直观的废图原因。
 * 测量变成入参后，单测传「每字 10px」的假测量就能逐字节断言断行。三条口径：
 * 1. `MeasureFn` 只管**字形本身**，不含字间距。必须如此：Chromium 的 `measureText`
 *    会把 `ctx.letterSpacing` 算进返回值（实测 14 字 2px ⇒ 多 28px），调用方没把原生
 *    字距归零时这里再乘一次就**双算** ⇒ 断行提前、右对齐右移，而构建全绿。
 * 2. 宽度是「墨迹宽」：最后一个字之后**没有**字距。居中/右对齐用它，那就是视觉宽度。
 * 3. 全产出 `readonly`，无模块级可变状态 ⇒ 同样输入必然同样输出。
 *
 * 断点策略（CJK 逐字 / 拉丁按词 / 连字符优先）在 `breakpoints.ts`；本文件只负责
 * 「断在哪」——贪心累加、省略号、参数合法性。拆开的理由是单文件 250 行硬门禁。
 */

import { tokenize, splitOversized } from './breakpoints';

/** 宽度测量函数：返回 `text` 的字形宽度（px），**不含字间距**。 */
export type MeasureFn = (text: string) => number;

/**
 * 换行入参。三个字段必填 —— 逼调用方显式说出 maxLines 是 0 还是 3。
 *
 * ⚠ 非有限数（`NaN`）是**非法值，不是"超出范围"**。与 `layer.ts` 的分工一致：
 * 范围问题（`fontSize: 500`）由 normalize 夹紧；合法性问题（`fontSize: NaN`）必须
 * 在这里拦住并报出来。`Infinity` 按字段区分，见 `normalizeOptions` 的表。
 */
export interface WrapOptions {
  /** 行宽上限（px）。`Infinity` = 不限宽；`NaN` = 非法值。有限数 ≤ 0 也按不限宽。 */
  readonly maxWidth: number;
  /** 字间距（px），可负（紧缩）。参与宽度估算。**必须有限**，`Infinity` 也非法。 */
  readonly letterSpacing: number;
  /** 行数上限。0 或 `Infinity` = 不限；`NaN` = 非法值。 */
  readonly maxLines: number;
}

/**
 * 换行结果。
 *
 * `invalid` 存在的理由：`renderDoc` 的契约是「**诊断数组非空 = 有层没画出来**」，
 * 而非法入参如果只是静默回落，就会画出一张"看起来正常、其实按默认值排的"图 ——
 * 那正是本仓禁止的「静默变空」的排版版。所以非法时不仅回落，还要能**被调用方
 * 发现**：`drawTextLayer` 靠它抛错，让 `renderDoc` 记一条 `draw-threw` 诊断。
 */
export interface WrapResult {
  /** 至少一行。空文本是 `['']`（不是 `[]`）—— 绘制侧不必再判空。 */
  readonly lines: readonly string[];
  /** 是否因为 `maxLines` 被截断（末行已带省略号）。 */
  readonly truncated: boolean;
  /** 最宽一行的**墨迹宽**（含字间距），供居中与自适应字号用。 */
  readonly widestLine: number;
  /** 有非有限入参 ⇒ true，此时其余字段是**按回落默认值**算出来的，调用方必须消费它。 */
  readonly invalid: boolean;
  /** 非法的字段名（`invalid` 为 true 时非空）。顺序 = 检查顺序，可复现。 */
  readonly invalidFields: readonly string[];
}

/** 非法字段名。用 `keyof WrapOptions` 的收窄形式，改键名时这里会跟着报错。 */
type InvalidField = 'maxWidth' | 'letterSpacing' | 'maxLines';

/** 回落默认值：不限宽 / 无字距 / 不限行数 = "什么都不约束"，最不可能出废图。 */
const FALLBACK: Readonly<Record<InvalidField, number>> = {
  maxWidth: Number.POSITIVE_INFINITY,
  letterSpacing: 0,
  maxLines: 0,
};

/** 省略号。用单个 U+2026（不是三个点）—— 三个点会被当成三个字符多算两格字距。 */
const ELLIPSIS = '…';

/** 省略号逐字回退的迭代上限（换行本身的循环上限在 `breakpoints.ts`）。 */
const MAX_STEPS = 10000;

/**
 * 校验入参。三个字段的判据**不一样**，这是刻意的：
 *
 * | 字段 | `Infinity` | `-Infinity` | `NaN` |
 * |---|---|---|---|
 * | `maxWidth` | 合法（明确的不限宽） | 合法（装不下任何东西 ⇒ 按不限宽更安全） | **非法** |
 * | `maxLines` | 合法（= 不限行数） | 合法（= 不限行数） | **非法** |
 * | `letterSpacing` | **非法** | **非法** | **非法** |
 *
 * 为什么 `letterSpacing` 一格都不放行：另外两个字段的 `Infinity` 有**明确的语义**
 * （"不限"），而"无限字距"没有任何合理含义 —— 它是算错了或者从别处漏进来一个
 * `Infinity`。放行它的后果是 `widthOf` 对任何多字符文本都返回 `Infinity` ⇒ 每个字
 * 独占一行 ⇒ 一张字全竖着排的废图，而且**不报错**。所以这里必须收窄到有限数。
 *
 * 为什么不抛异常：`wrapText` 是绘制路径上的纯函数，抛异常会变成整层的
 * `draw-threw`（合法的文字也一起看不见）。替代方案是「用安全默认值算完 + 把违规
 * 字段名带回去」，由调用方决定怎么处理 —— `drawTextLayer` 选择抛，单测选择断言。
 */
function normalizeOptions(options: WrapOptions): { options: WrapOptions; fields: InvalidField[] } {
  const fields: InvalidField[] = [];
  const bad = (value: number, allowInfinity: boolean): boolean => (
    allowInfinity ? Number.isNaN(value) : !Number.isFinite(value)
  );
  // 检查顺序**就是** `WrapOptions` 的声明顺序（maxWidth → letterSpacing → maxLines）：
  // 人看 `invalidFields` 时期望它按字段表从上往下排，而不是按实现里的偶然顺序。
  const maxWidthBad = bad(options.maxWidth, true);
  if (maxWidthBad) fields.push('maxWidth');
  const letterSpacingBad = bad(options.letterSpacing, false);
  if (letterSpacingBad) fields.push('letterSpacing');
  const maxLinesBad = bad(options.maxLines, true);
  if (maxLinesBad) fields.push('maxLines');
  return {
    options: {
      maxWidth: maxWidthBad ? FALLBACK.maxWidth : options.maxWidth,
      letterSpacing: letterSpacingBad ? FALLBACK.letterSpacing : options.letterSpacing,
      maxLines: maxLinesBad ? FALLBACK.maxLines : options.maxLines,
    },
    fields,
  };
}

/**
 * 一行文本的**墨迹宽**：字形宽 + `(n-1) * letterSpacing`。字符数按**码点**算。
 *
 * 非有限入参按"该字段不参与"处理（`letterSpacing: NaN` 当 0，`measure` 返回 NaN 当 0）：
 * 本函数是宽度估算的**唯一出口**，让它永不返回 NaN，是 `widthOf(...) <= limit` 这些
 * 比较成立的前提 —— `宽度 > NaN` 恒为 false 会让所有断行判断一起失效。
 */
export function widthOfText(text: string, measure: MeasureFn, letterSpacing: number): number {
  const spacing = Number.isFinite(letterSpacing) ? letterSpacing : 0;
  const glyph = measure(text);
  return (Number.isFinite(glyph) ? glyph : 0) + spacing * Math.max(0, Array.from(text).length - 1);
}

/**
 * 给一行末尾加省略号，必要时从尾部挤掉字符，**保证加了省略号之后仍不超宽**（省略号本身
 * 必须算进宽度，否则「原行 + …」溢出画布而 `truncated` 仍是 true、看起来"已处理"）。
 * 最差返回 `…` 本身 —— 不返回空串，那会让"被截断"在画面上彻底消失。
 */
function ellipsize(line: string, widthOf: (s: string) => number, limit: number): string {
  const chars = Array.from(line);
  let candidate = line + ELLIPSIS;
  let steps = 0;
  while (widthOf(candidate) > limit && chars.length > 0 && steps < MAX_STEPS) {
    chars.pop();
    candidate = chars.join('') + ELLIPSIS;
    steps += 1;
  }
  return candidate;
}

/** 把一段无换行符的文本贪心排成若干行。行首空白丢（缩进该用 align），断行处的行尾空白也丢。 */
function wrapParagraph(paragraph: string, widthOf: (s: string) => number, limit: number): string[] {
  if (paragraph === '') return [''];
  const lines: string[] = [];
  let cur = '';
  for (const token of tokenize(paragraph)) {
    if (token.space) {
      if (cur === '') continue;
      const withSpace = cur + token.text;
      if (widthOf(withSpace) <= limit) cur = withSpace;
      continue;
    }
    if (cur !== '') {
      const joined = cur + token.text;
      if (widthOf(joined) <= limit) {
        cur = joined;
        continue;
      }
      lines.push(cur.replace(/\s+$/, ''));
      cur = '';
    }
    if (widthOf(token.text) <= limit) {
      cur = token.text;
      continue;
    }
    // 整个单元比一行还宽 ⇒ 硬切；除最后一片外全部收口，最后一片留着继续拼
    const parts = splitOversized(token.text, widthOf, limit);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (part !== undefined) lines.push(part);
    }
    cur = parts[parts.length - 1] ?? '';
  }
  lines.push(cur.replace(/\s+$/, ''));
  return lines;
}

/**
 * 按行宽自动换行。**预览与导出必须共用这一个函数**，否则同一份稿子两处断行不同。
 *
 * 顺序本身是需求，别调换：① `\r\n`/`\r` 归一成 `\n`；② `\n` **硬换行优先**（用户写了
 * 换行就是换行，自动断行不许合并它），空行保留成空字符串行；③ 段内贪心断行（CJK 逐字
 * / 拉丁按词 / 超宽单元硬切 / 连字符优先）；④ 超行 ⇒ 截断 + 末行省略号 + `truncated`；
 * ⑤ `widestLine` 用**截断后**的行算（居中与自适应字号看的都是最终画面）。
 *
 * `maxWidth` 为有限数且 ≤ 0 时按**不限宽**处理（每段一行）：当 0 处理会让每个字各占
 * 一行，那种「参数没传对」的表现比「不换行」更难定位。`NaN` 不在此列，见 `WrapResult`。
 */
export function wrapText(text: string, measure: MeasureFn, options: WrapOptions): WrapResult {
  const normalized = normalizeOptions(options);
  const opts = normalized.options;
  const limit = opts.maxWidth > 0 ? opts.maxWidth : Number.POSITIVE_INFINITY;
  const maxLinesRaw = Number.isFinite(opts.maxLines) ? Math.floor(opts.maxLines) : 0;
  const maxLines = maxLinesRaw > 0 ? maxLinesRaw : 0;
  const widthOf = (s: string): number => widthOfText(s, measure, opts.letterSpacing);

  const source = typeof text === 'string' ? text : '';
  const collected: string[] = [];
  for (const paragraph of source.replace(/\r\n?/g, '\n').split('\n')) {
    for (const line of wrapParagraph(paragraph, widthOf, limit)) collected.push(line);
  }
  // split() 至少给一段 ⇒ collected 非空；仍兜一个底，绘制侧不必判空
  let kept: string[] = collected.length > 0 ? collected : [''];
  let truncated = false;
  if (maxLines > 0 && kept.length > maxLines) {
    truncated = true;
    kept = kept.slice(0, maxLines);
    const lastIndex = maxLines - 1;
    kept[lastIndex] = ellipsize(kept[lastIndex] ?? '', widthOf, limit);
  }
  let widestLine = 0;
  for (const line of kept) {
    const w = widthOf(line);
    if (w > widestLine) widestLine = w;
  }
  return {
    lines: kept,
    truncated,
    widestLine,
    invalid: normalized.fields.length > 0,
    invalidFields: normalized.fields,
  };
}
