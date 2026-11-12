/**
 * 海报文档模型 —— 一份可保存、可恢复、可导出的完整文档。
 *
 * 与 `PosterStudio.jsx` 的 `normalizeDoc()`（约 L927）字段一一对齐：
 * `{ width, height, ratioKey, background, templateName, layers }`。
 */

import type { Layer } from './layer';

/**
 * 基准画布尺寸。与 `posterTemplates.js:29` 的 `POSTER_BASE` 是同一个数。
 *
 * 为什么两处都要有：JS 那边的模板坐标是按 1080×1440 写的，不能动；
 * TS 这边需要它的**类型化**版本给新引擎用。两处一致由 `unit-poster-model`
 * 的断言守着（不是靠注释承诺）。
 */
export const POSTER_BASE = Object.freeze({ width: 1080, height: 1440 });

/**
 * 画布宽高比标识。用于左栏切换、也用于判断"这份文档该用哪套版式规则"。
 *
 * 不存浮点比例（如 0.75）而存键名，是因为 1080/1440 和 1200/1600 都是 0.75，
 * 但它们是两种不同尺寸 —— 键名能区分，浮点数不能。
 */
export type RatioKey = '3:4' | '4:5' | '1:1' | '9:16' | '16:9' | 'custom';

/** 一份海报文档。 */
export interface PosterDoc {
  /** 画布宽，像素。导出尺寸按它 × scale。 */
  width: number;
  height: number;
  ratioKey: RatioKey;
  /** 画布底色。`#rrggbb`。 */
  background: string;
  /** 当前套用的模板 key；空串表示空白文档（不是套了模板又改）。 */
  templateName: string;
  /** 图层数组。**数组顺序不代表叠放顺序**，叠放看 `layer.z`。 */
  layers: Layer[];
}

/**
 * 宽高换成 ratioKey。
 *
 * 容差 0.01：1080×1440 与 1080×1439（取整误差）必须判成同一个比例，
 * 否则"改个尺寸再改回来"会莫名其妙从 `3:4` 变成 `custom`。
 */
export function ratioKeyOf(width: number, height: number): RatioKey {
  if (!(width > 0) || !(height > 0)) return 'custom';
  const ratio = width / height;
  const known: ReadonlyArray<{ key: RatioKey; value: number }> = [
    { key: '3:4', value: 3 / 4 },
    { key: '4:5', value: 4 / 5 },
    { key: '1:1', value: 1 },
    { key: '9:16', value: 9 / 16 },
    { key: '16:9', value: 16 / 9 },
  ];
  for (const item of known) {
    if (Math.abs(ratio - item.value) <= 0.01) return item.key;
  }
  return 'custom';
}

/**
 * 按 ratioKey 给出该比例的推荐像素尺寸（基准 1080 宽或高，取整到 2 的倍数）。
 *
 * 为什么要取整到偶数：导出时 dpr 可能不是整数，奇数尺寸在 2× 导出后
 * 会出现半像素，文字边缘会糊。这个问题只在导出尺寸上是奇数时才出现，
 * 肉眼第一眼看不出来、放大才看得见，所以必须在**生成尺寸**这一层堵掉。
 */
export function sizeForRatio(key: RatioKey): { width: number; height: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  switch (key) {
    case '3:4':
      return { width: 1080, height: 1440 };
    case '4:5':
      return { width: 1080, height: even(1080 * 5 / 4) };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '9:16':
      return { width: 1080, height: 1920 };
    case '16:9':
      return { width: 1920, height: 1080 };
    case 'custom':
      return { width: POSTER_BASE.width, height: POSTER_BASE.height };
    default: {
      // `switch` 已穷尽 RatioKey；这里用 never 断言，将来加枚举值会**编译报错**
      // 而不是静默落进某个默认分支。
      const exhaustive: never = key;
      throw new Error(`未知 ratioKey: ${String(exhaustive)}`);
    }
  }
}
