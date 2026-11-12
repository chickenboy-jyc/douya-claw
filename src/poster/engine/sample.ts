/**
 * 海报引擎占位模块 —— 证明 TypeScript 严格地基「能编译、能被门禁扫、能拦坏代码」。
 *
 * ⚠ 本文件不是产品逻辑，是**地基样本**：
 *   `scripts/smoke/unit-ts-strict.mjs` 的验收步骤会临时把它改坏（加 `: any`、撑到 300 行）
 *   再恢复，用它证明门禁真的会红。
 *   真正的引擎实现落地时**替换**本文件，届时同步更新验收脚本里的样本路径即可。
 */
import type { Size } from '../../shared/dimension';
import { isPositiveInteger, isValidSize } from '../../shared/dimension';

/** 常用竖版比例（宽 : 高）。`readonly` 元组：长度与顺序都是契约的一部分。 */
const PORTRAIT_RATIOS: readonly (readonly [number, number])[] = [
  [3, 4],
  [4, 5],
  [9, 16],
];

/**
 * 造一个像素尺寸。
 *
 * @param width 宽（正整数像素）
 * @param height 高（正整数像素）
 * @returns 新的尺寸对象（调用方拿到的是副本，改它不影响任何人）
 * @throws RangeError 宽或高不是正整数时
 */
export function createSize(width: number, height: number): Size {
  if (!isPositiveInteger(width)) {
    throw new RangeError(`createSize: 宽必须是正整数，收到 ${String(width)}`);
  }
  if (!isPositiveInteger(height)) {
    throw new RangeError(`createSize: 高必须是正整数，收到 ${String(height)}`);
  }
  return { width, height };
}

/**
 * 按比例算尺寸：给定宽，按 `PORTRAIT_RATIOS[index]` 求高（四舍五入到整数像素）。
 *
 * `noUncheckedIndexedAccess` 下 `PORTRAIT_RATIOS[index]` 是
 * `readonly [number, number] | undefined`，所以必须先判 `undefined`
 * —— 这正是该开关要教给写作者的动作。
 *
 * @param width 宽（正整数像素）
 * @param index 比例表下标
 * @throws RangeError 宽非法或下标越界时
 */
export function sizeFromRatio(width: number, index: number): Size {
  const ratio = PORTRAIT_RATIOS[index];
  if (ratio === undefined) {
    throw new RangeError(`sizeFromRatio: 比例下标越界，收到 ${String(index)}`);
  }
  const [ratioWidth, ratioHeight] = ratio;
  const height = Math.round((width * ratioHeight) / ratioWidth);
  return createSize(width, height);
}

/**
 * 把外部传来的值解析成尺寸：合法就原样返回，否则用兜底。
 *
 * 入参是 `unknown` 而不是 `any` —— 「我不知道它是什么」和「我不管它是什么」
 * 是两件事：前者可以窄化，后者会把错误传到下一层去炸。
 */
export function coerceSize(value: unknown, fallback: Size): Size {
  return isValidSize(value) ? value : fallback;
}
