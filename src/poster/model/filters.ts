/**
 * 图片滤镜状态。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 与现有实现的对应关系（2026-11-02 核对，不要凭记忆改）
 * ════════════════════════════════════════════════════════════════════════════
 * 现状：`PosterStudio.jsx:103` 的 `DEFAULT_FILTERS`，五个键，值是**数字本体**
 * （`brightness: 100` 不是 `'100%'`）。拼成 CSS 字符串的那一步在各自渲染处
 * （`filterCss()` 把数字加单位），**本文件不拼字符串**。
 *
 * 为什么把"数字"和"CSS 字符串"分开：
 *   · 数字可比较、可插值、可做滑块的 min/max，也能被 AI 直接产出
 *   · CSS 字符串一旦进了模型，就再也验不了范围（`'9999%'` 和 `'100%'` 长得一样）
 *
 * 现状的**已知局限（不是本模块的 bug，是 ctx.filter 的局限）**：
 * `ctx.filter` 只作用于**图片层**，文字层和形状层不吃滤镜。要作用于整幅画面
 * 得走离屏 canvas + 像素级处理，那是 `filters` 模块要补的能力，不在模型层解决。
 */

/**
 * 五个滤镜参数。取值范围与左栏滑块的 min/max 完全一致
 * （`PosterStudio.jsx` 的 `FILTER_FIELDS`），这样"滑块能拖到的值"和
 * "模型认为合法的值"是同一套，不存在两套边界。
 *
 * 为什么不直接复用 `FILTER_FIELDS` 的数组：那是 UI 描述（含 label / step / suffix），
 * 而这里是**数据契约**。UI 可以变（换文案、换步长），模型不该跟着动。
 */
export interface FilterState {
  /** 20~180，单位 %。100 = 原样。 */
  brightness: number;
  /** 20~180，单位 %。100 = 原样。 */
  contrast: number;
  /** 0~200，单位 %。100 = 原样。0 = 完全去色。 */
  saturate: number;
  /** 0~20，单位 px。0 = 不模糊。 */
  blur: number;
  /** 0~100，单位 %。0 = 无黑白，100 = 纯黑白。 */
  grayscale: number;
}

/**
 * 默认值 = 恒等变换（除了 blur/grayscale 的 0 也是恒等）。
 * 任何一处"新建图片层"都必须从这里取，**不许各写一份字面量** ——
 * 现在 `PosterStudio.jsx` 里 `DEFAULT_FILTERS` 被 `Object.assign` 了两处
 * （`:914` normalize 与 `:1541` 新建），一旦漏掉一处，新建的图层和读回来的
 * 图层就会有不同默认值，而这种差异只会在导出的图上才看得出来。
 */
export const DEFAULT_FILTERS: Readonly<FilterState> = Object.freeze({
  brightness: 100,
  contrast: 100,
  saturate: 100,
  blur: 0,
  grayscale: 0,
});

/**
 * 单字段合法区间。键与 `FilterState` 一一对应。
 *
 * 用法：`clampFilters()` 遍历它夹紧；UI 滑块从这里取 min/max。
 * 用 `Record<keyof FilterState, ...>` 而不是手写五个常量 ——
 * 这样将来给 `FilterState` 加字段时，**这里不补就会编译报错**，
 * 而不是悄悄漏掉一个字段的范围检查。
 */
export const FILTER_RANGES: Readonly<
  Record<keyof FilterState, { readonly min: number; readonly max: number }>
> = Object.freeze({
  brightness: { min: 20, max: 180 },
  contrast: { min: 20, max: 180 },
  saturate: { min: 0, max: 200 },
  blur: { min: 0, max: 20 },
  grayscale: { min: 0, max: 100 },
});

/** 把任意输入夹进合法区间；非有限数（NaN / Infinity）落回默认值。 */
function clampOne(key: keyof FilterState, raw: unknown): number {
  const fallback = DEFAULT_FILTERS[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const range = FILTER_RANGES[key];
  if (raw < range.min) return range.min;
  if (raw > range.max) return range.max;
  return raw;
}

/**
 * 把任意输入（存档 / AI 输出 / IPC）夹成合法的 `FilterState`。
 *
 * 入参是 `unknown` 而不是 `Partial<FilterState>` —— 它要被用在
 * "从磁盘读回来的一段 JSON"这种完全不设防的位置，标成 `Partial` 只是
 * 骗编译器，运行时的形状仍然是不可信的。
 */
export function clampFilters(raw: unknown): FilterState {
  const isPlainObject = typeof raw === 'object' && raw !== null;
  const src: Record<string, unknown> = isPlainObject
    ? (raw as Record<string, unknown>)
    : Object.freeze({});
  return {
    brightness: clampOne('brightness', src['brightness']),
    contrast: clampOne('contrast', src['contrast']),
    saturate: clampOne('saturate', src['saturate']),
    blur: clampOne('blur', src['blur']),
    grayscale: clampOne('grayscale', src['grayscale']),
  };
}

/**
 * 把 `FilterState` 转成 `ctx.filter` 能吃的 CSS 字符串。
 *
 * 空值优化：全部为默认值时返回 `'none'`，而不是
 * `'brightness(100%) contrast(100%) ...'` —— 后者语义等价但会让浏览器
 * 为整层图片开一个滤镜合成通道，大图上是可测的开销。
 */
export function filtersToCss(state: FilterState): string {
  const parts: string[] = [];
  if (state.brightness !== DEFAULT_FILTERS.brightness) parts.push(`brightness(${state.brightness}%)`);
  if (state.contrast !== DEFAULT_FILTERS.contrast) parts.push(`contrast(${state.contrast}%)`);
  if (state.saturate !== DEFAULT_FILTERS.saturate) parts.push(`saturate(${state.saturate}%)`);
  if (state.blur !== DEFAULT_FILTERS.blur) parts.push(`blur(${state.blur}px)`);
  if (state.grayscale !== DEFAULT_FILTERS.grayscale) parts.push(`grayscale(${state.grayscale}%)`);
  return parts.length === 0 ? 'none' : parts.join(' ');
}
