/**
 * 海报引擎的**总装入口** —— 全仓唯一该被外部 import 的 `src/poster/` 路径。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么需要这一层（这是本轮最重要的一个教训）
 * ════════════════════════════════════════════════════════════════════════════
 * 四个模块（canvas 引擎 / 图层 / 几何 / 文字）各自的测试全绿，但做跨模块验收时发现：
 *
 *     grep -rn "registerLayerRenderer(" src/ --include=*.ts
 *     → geometry/draw.ts:241  registerLayerRenderer('shape', ...)
 *     → text/draw.ts:135     registerLayerRenderer('text', ...)
 *
 * **`'image'` 一次都没注册。** 也就是说：任何带图片的海报，图片层会被
 * `renderDoc` 判成 `missing-renderer` 而**静默跳过**——而"把照片放到海报上"
 * 恰恰是整个产品最核心的一件事。
 *
 * 每个模块单独看都没问题：
 *   · canvas 测的是「调度顺序对不对」（用假渲染器）
 *   · layers 测的是「数据结构对不对」
 *   · geometry 测的是「形状画不画得出」
 *   · text 测的是「换行算得对不对」
 * **没有任何一个测试问过「三种图层类型是不是都真的有人能画」。**
 *
 * 这就是"每个零件都合格、整机不转"。本文件的存在就是为了让这件事**只能被集中检查一次**：
 * 它 import 全部渲染器（触发各自顶层的 `registerLayerRenderer`），
 * 然后由 `scripts/smoke/unit-poster-assembly.mjs` 断言三种类型都在。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 副作用说明（重要，不要为了"看看类型"而 import 本文件）
 * ════════════════════════════════════════════════════════════════════════════
 * import 本文件会**顺带注册所有渲染器**。这是刻意的——注册不该是一个
 * 「需要人记得调用」的 `init()`。理由：本仓已经反复踩过"写了但没人调用"的坑
 * （`addLayer` 零命中、探针没接线、`verify-schedule-fields.py` 从没跑通过）。
 * 只需要类型时请用 `import type`。
 */

// ── 渲染器：import 即注册（顺序无关，每个只认自己的 kind）──────────────────
// ⚠ 每新增一种图层类型，**必须**在这里加一行 import，否则它永远不会被画出来。
//   漏了也不会编译报错 —— 所以 `unit-poster-assembly.mjs` 用
//   `registeredKinds().length === 3` 兜住这个洞。
import './geometry/draw';
import './text/draw';
import './image/draw';

// ── 对外 API（外部只需要这几个名字）────────────────────────────────────────
export { renderDoc } from './engine/render';
export type { RenderDiagnostic } from './engine/render';
export type { RenderEnv, LayerDrawFn } from './engine/registry';
export { createCanvas, resolveScale, canvasToDataUrl } from './engine/canvas';
export { loadImages } from './engine/imageCache';
export type { ImageCache } from './engine/imageCache';

export { registeredKinds, getLayerRenderer } from './engine/registry';

export { normalizeLayer, normalizeDoc } from './layers/normalize';
export {
  addLayer,
  removeLayer,
  updateLayer,
  findLayer,
  moveLayer,
  reorderLayer,
  setCanvasSize,
} from './layers/ops';

export type { Layer, LayerKind, TextLayer, ImageLayer, ShapeLayer } from './model/layer';
export type { PosterDoc, RatioKey } from './model/doc';
export { POSTER_BASE, ratioKeyOf, sizeForRatio } from './model/doc';
export type { FilterState } from './model/filters';
export { DEFAULT_FILTERS, clampFilters, filtersToCss } from './model/filters';
