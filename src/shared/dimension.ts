/**
 * 尺寸与比例的共享基础类型 —— 海报引擎（`src/poster/`）与主进程侧共用的最小面。
 *
 * 本文件是 TypeScript 严格模式地基的**样本**：它同时被 `tsconfig.renderer.json`
 * 与 `tsconfig.main.json` 编译，用来证明「同一份共享类型能在两个环境切片下都成立」。
 *
 * 写法约定（全部 14 项严格开关下成立）：
 *  · 不出现 `any`：外部输入一律 `unknown` + 类型守卫窄化；
 *  · 不写裸 `Function`、不写 `{}` 当类型 —— 用 `interface` / 联合类型表达；
 *  · `exactOptionalPropertyTypes` 下「可选」= 可以不出现，与「显式传 undefined」不同；
 *  · `noUncheckedIndexedAccess` 下任何下标访问结果都含 `undefined`，必须先判。
 */

/** 像素尺寸。`readonly` 是有意的：尺寸对象在引擎里到处传，就地被改是最难查的 bug。 */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** 是否是正整数（像素口径下 0 与 1.5 都不是合法边长）。 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 类型守卫：把 `unknown` 收窄成 `Size`。
 *
 * 为什么不用 `as Size`：`as` 只说服编译器，运行时该崩还是崩。
 * 凡是「跨进程 / 跨 IPC / 来自 JSON」的值，一律走这里。
 */
export function isValidSize(value: unknown): value is Size {
  if (typeof value !== 'object' || value === null) return false;
  // 先收窄成「字段未知的对象」，再看字段 —— 这一步不是 any，是 unknown 的结构化读取。
  const candidate: { readonly width?: unknown; readonly height?: unknown } = value;
  return isPositiveInteger(candidate.width) && isPositiveInteger(candidate.height);
}

/** 兜底尺寸（1080×1440，社媒竖版）。调用方拿到的永远是**新对象**，不是共享引用。 */
export function defaultSize(): Size {
  return { width: 1080, height: 1440 };
}
