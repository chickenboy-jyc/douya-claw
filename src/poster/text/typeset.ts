/**
 * 文字排版度量：行距、垂直定位（top/middle/bottom）、字间距设置、自适应字号 ——
 * **只算数字，不画字**。
 *
 * 为什么和 `draw.ts` 分开：这几个函数里有三个是可以**脱离 canvas 单测**的纯数学
 * （行距、垂直定位、自适应字号只要注入 measure 就够），而"看起来差几像素"是海报验收
 * 里最常见的争议点。把数字算在能测的地方，把 `fillText` 留在不能测的地方，是这里唯一
 * 的取舍。
 *
 * ⚠ 语义口径（写死，不要在别处另立一套）：
 *   · 所有 y 都以**图层盒子左上角**为原点、单位是画布像素（引擎已做完平移/旋转/缩放）
 *   · 绘制用 `textBaseline = 'top'`，所以 y 是**行盒顶端**，不是基线
 *   · 行距 = `fontSize * lineHeight`（倍数语义来自 `TextLayer.lineHeight`）
 */

import type { TextLayer } from '../model/layer';
import { wrapText } from './wrap';
import type { MeasureFn } from './wrap';

/** 行高倍数下限。低于它多行会互相压字，任何真实排版都不会要。 */
const MIN_LINE_HEIGHT = 0.8;

/** 自适应字号的迭代上限（二分 64 次足够覆盖 1~2^32 px，写死是为了「不会死循环」可断言）。 */
const MAX_FIT_STEPS = 32;

/** 浮点比较容差：宽度刚好等于上限时必须判「放得下」，否则会多减一号。 */
const EPSILON = 0.01;

/**
 * 行与行之间的**基线间距**（px），即相邻两行 y 的差值。
 *
 * 为什么不是"字号 × 1"：`lineHeight` 在 `TextLayer` 里是**倍数**（1.4 = 140%），
 * 而 canvas 没有行高概念 —— 必须由绘制方自己乘出来再逐行累加。用同一个函数算，
 * 才不会出现「多行间距」和「垂直居中用的总高」两处各乘一次、乘出不同结果。
 *
 * @param fontSize 字号（px）
 * @param lineHeight 行高倍数（< 0.8 会被夹到 0.8）
 * @returns 行间距（px）
 */
export function textBaselineOffset(fontSize: number, lineHeight: number): number {
  const size = Number.isFinite(fontSize) ? Math.max(0, fontSize) : 0;
  const ratio = Number.isFinite(lineHeight) ? Math.max(MIN_LINE_HEIGHT, lineHeight) : 1;
  return size * ratio;
}

/**
 * 多行文字在盒子里**按 `layer.verticalAlign` 决定**第一行 y（相对盒子左上角）。
 *
 * 语义（这一条最容易吵，所以写清楚）：
 *   · 位置由图层字段 `verticalAlign` 决定：`'top'` 贴顶 ⇒ 0；`'middle'` ⇒ 空白量的一半；
 *     `'bottom'` 贴底 ⇒ 整个空白量。**三种都是算出来的，不是写死的** ——
 *     旧引擎贴顶、TS 引擎最初居中，一个 h=200 的单行 72px 标题整整差 49.6px，
 *     写死任何一种都会让另一边的存量海报整体移位（详见 `model/layer.ts` 的字段注释）。
 *   · 参与计算的是**行盒总高** = `行数 × textBaselineOffset`，不是墨迹总高。
 *     用行盒是刻意的 —— 与 CSS `line-height` 同口径，视觉上更稳；
 *     用墨迹高会让"有下伸部的行多占一两像素"直接变成整块文字上下跳动。
 *   · 内容比盒子高时**钳到 0**（不返回负数）：溢出向下发生，阅读顺序在下方；
 *     返回负数会把首行顶到盒子外面，用户第一眼看到的是"文字消失了"。
 *     ★ 不钳的话只有 `'bottom'` 会返回负数（`slack` 变负 ← `boxHeight - blockHeight`），
 *     症状最隐蔽：短文本正常、长文本"凭空少一行"。
 *
 * @param layer 文字图层（只用 fontSize / lineHeight / h / verticalAlign）
 * @param measuredLineCount 实际要画的行数（换行/截断之后的行数，不是原文行数）
 * @returns 第一行的 y（px，≥ 0）
 */
export function verticalOffsetFor(layer: TextLayer, measuredLineCount: number): number {
  const count = Number.isFinite(measuredLineCount) ? Math.max(0, Math.floor(measuredLineCount)) : 0;
  if (count === 0) return 0;
  const blockHeight = count * textBaselineOffset(layer.fontSize, layer.lineHeight);
  const boxHeight = Number.isFinite(layer.h) ? Math.max(0, layer.h) : 0;
  // `Math.max(0, …)` 放在**算空白量**这一步，语义就是"溢出时三种对齐都从顶部开始"。
  const slack = Math.max(0, boxHeight - blockHeight);
  // 刻意用 if 链而不是 switch + exhaustive 检查：`verticalAlign` 为 `undefined` 时
  // （未经 `normalize` 的对象 —— 旧调用方、手改存档、AI 直出的中间态）这里安全落到 0，
  // 而 switch 的 default 分支读起来像"这不该发生"，会让下一个人把它改成 throw。
  if (layer.verticalAlign === 'middle') return slack / 2;
  if (layer.verticalAlign === 'bottom') return slack;
  return 0;
}

/**
 * 设置 canvas 原生字间距，并返回**恢复函数**。
 *
 * 两个必须说清的点：
 * 1. **传 0 就是"挂起"**。逐字绘制的路径要传 0：原生字距一旦非 0，`measureText` 与
 *    `fillText` 都会按原生字距推进，而手排字距又加一次 ⇒ 宽度翻倍、字距翻倍。
 * 2. **必须恢复**。canvas 上下文在整张海报里是共用的，漏恢复会让后面每个图层都带上
 *    这层字距（症状是"改了标题的字距，正文跟着变"，极难定位）。返回的恢复函数是**幂等**的，
 *    所以嵌套 try/finally 里重复调用安全。
 *
 * 老内核（Chromium < 99）根本没有 `letterSpacing` 属性：此时返回空函数，调用方照常
 * 走逐字绘制兜底，不需要分支判断。
 *
 * @param ctx 画布上下文
 * @param spacing 字间距（px），0 = 挂起原生字距
 * @returns 恢复函数
 */
export function applyLetterSpacing(ctx: CanvasRenderingContext2D, spacing: number): () => void {
  const safe = Number.isFinite(spacing) ? spacing : 0;
  if (!('letterSpacing' in ctx)) return (): void => undefined;
  let previous = '';
  try {
    previous = String(ctx.letterSpacing);
    ctx.letterSpacing = String(safe) + 'px';
  } catch {
    return (): void => undefined;
  }
  let restored = false;
  return (): void => {
    if (restored) return;
    restored = true;
    try {
      ctx.letterSpacing = previous;
    } catch {
      // 属性存在但赋值被拒（被冻结的上下文）：无处可恢复，静默放弃而不是抛给绘制链
    }
  };
}

/** 自适应字号的入参。字段全必填 —— 缺一个就会产生"看起来生效、其实没约束"的死角。 */
export interface FitFontSizeOptions {
  /** 可用宽度（px）。 */
  readonly maxWidth: number;
  /** 可用高度（px）。行数 × 行距 必须装得下。 */
  readonly maxHeight: number;
  /** 行高倍数（与 `TextLayer.lineHeight` 同口径）。 */
  readonly lineHeight: number;
  /** 字间距（px）。必须一起参与，否则字距大的标题会算出"放得下"却溢出。 */
  readonly letterSpacing: number;
  /** 行数上限（0 = 不限）。截断后的行数才算得对高度。 */
  readonly maxLines: number;
  /** 字号下限。**必须有**：没有下限时内容再长也会一路缩到 1px，等于没有文字。 */
  readonly minFontSize: number;
  /** 起始（也就是最大）字号。 */
  readonly startFontSize: number;
  /**
   * 把绘制上下文的字体设成 `fontSize` 对应的那一档。
   *
   * 为什么需要它：`measure` 量的是"当前字体"下的宽度，字号变了必须重新设字体才量得准。
   * 调用方实现成 `ctx.font = ...`；纯单测里实现成「改掉假测量函数用的那个字号变量」。
   */
  readonly applyFontSize: (fontSize: number) => void;
}

/**
 * 自动缩字号，直到文本能装进 `maxWidth × maxHeight`。AI 生成海报时常用。
 *
 * 做法：在 `[minFontSize, startFontSize]` 上**二分**（假设"字号大 ⇒ 更宽更高"，真实
 * 字体在常用区间内成立），最多 `MAX_FIT_STEPS` 次。二分的两个边界就是"不会死循环"的
 * 保证 —— 不用 while(不放下就减 1) 那种写法，它没有下限也不会终止。
 *
 * ⚠ 副作用：为了让调用方能直接接着画，函数结束前会用**返回的那个字号**再调一次
 * `applyFontSize`。所以调用方不必自己再设一次字体，但也**不能**假设字体还是进来时的值。
 *
 * @param text 原文
 * @param measure 字形宽度测量（不含字距，跟着当前字体走）
 * @param options 见 `FitFontSizeOptions`
 * @returns 能用得下的最大整数字号；连 `minFontSize` 都放不下时返回 `minFontSize`
 */
export function fitFontSize(text: string, measure: MeasureFn, options: FitFontSizeOptions): number {
  const minSize = Math.max(1, Math.floor(Number.isFinite(options.minFontSize) ? options.minFontSize : 1));
  const startRaw = Math.floor(Number.isFinite(options.startFontSize) ? options.startFontSize : minSize);
  const startSize = Math.max(minSize, startRaw);

  const fits = (fontSize: number): boolean => {
    options.applyFontSize(fontSize);
    const result = wrapText(text, measure, {
      maxWidth: options.maxWidth,
      letterSpacing: options.letterSpacing,
      maxLines: options.maxLines,
    });
    const blockHeight = result.lines.length * textBaselineOffset(fontSize, options.lineHeight);
    return result.widestLine <= options.maxWidth + EPSILON && blockHeight <= options.maxHeight + EPSILON;
  };

  let low = minSize;
  let high = startSize;
  let best = minSize;
  let steps = 0;
  while (low <= high && steps < MAX_FIT_STEPS) {
    steps += 1;
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  options.applyFontSize(best); // 让调用方的字体与返回值一致（见上面的副作用说明）
  return best;
}
