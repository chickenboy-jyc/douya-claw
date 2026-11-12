/**
 * 把**不可信输入**（磁盘 JSON / AI 输出 / IPC 返回值）窄化成合法的 `Layer` / `PosterDoc`。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么入参是 `unknown` 而不是 `Partial<Layer>`
 * ════════════════════════════════════════════════════════════════════════════
 * 现有实现（`PosterStudio.jsx:887` 的 `normalizeLayer(src)`）把入参标成 `object`，
 * 函数体里却到处 `src && src.x` —— 标注等于没有，编译器一个字段都没帮上忙。
 * 这里降成 `unknown`，**每个字段都必须显式窄化**，于是：
 *   · 少写一个字段 ⇒ 编译报错（不会像 JS 那样静默产出 undefined）
 *   · 某字段类型变了 ⇒ 编译报错（而不是等 canvas 画出空白才发现）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 与现有 JS 实现的有意差异（都是修 bug，不是漂移）
 * ════════════════════════════════════════════════════════════════════════════
 * 1. **不做隐式数字转换**（`Number('') === 0` 会把"没值"变成"在左上角"），理由见 `numbers.ts`。
 * 2. **颜色做格式校验**，理由见 `sanitize.ts` 的 `colorOf`（canvas 会静默沿用上一次的样式）。
 * 3. **`rotation` / `shapeKind` / `stroke` / `points` / `verticalAlign` / `fontFamily`
 *    是新增字段**（见 `model/layer.ts`），
 *    旧存档里没有，全部由这里补默认值 —— 下游拿到的永远是确定值。
 *    ⚠ 其中 `verticalAlign` 的默认值必须是 `'top'`、`fontFamily` 必须是空串。
 *    这两条不是随手选的：前者的语义等于「旧引擎行为」，后者等于「引擎默认栈」，
 *    所以存量海报打开后像素不变（详见下面各自的注释与 `model/layer.ts` 的字段注释）。
 *    ⚠ 原文写的是「**默认值只在本文件出现一次**」，**那句是错的**（2026-11-02 实测更正）：
 *     默认值实际由**三个文件**分持 —— 本文件（名称/文字色/底色/占位文案/画布边界）、
 *     `sanitize.ts`（`DEFAULT_SHAPE_FILL` / `DEFAULT_STROKE_WIDTH` / 顶点上限）、
 *     `ops-resize.ts`（字号缩放下限）。它们各自**只定义一次**（这才是真正要保证的），
 *     但**不在本文件**。写错方向的代价：让人以为"改默认值只需翻这一个文件"。
 *     （取证：`grep -nE "^(const|export const) DEFAULT|^const (MIN|MAX)_" src/poster/layers/*.ts`）
 * 4. **`hidden` 只认 `true`**。JS 侧写 `!!src.hidden`，而 `!!'false' === true` ——
 *    一个被序列化成字符串的 false 会让图层莫名隐藏。
 *
 * 逐字段的窄化规则在 `sanitize.ts`；字体族名在 `font-family.ts`（该文件导出数已满
 * 12 个，撞上门禁上限，见其文件头）。本文件只负责"把字段装进对应种类"和边界夹紧。
 */

import type { ImageLayer, Layer, LayerBase, LayerKind, ShapeLayer, TextLayer } from '../model/layer';
import type { PosterDoc } from '../model/doc';
import { POSTER_BASE, ratioKeyOf } from '../model/doc';
import { clampFilters } from '../model/filters';
import { fontFamilyOf } from './font-family';
import { makeLayerId } from './id';
import { asFiniteNumber, asRoundedInt, clampNumber } from './numbers';
import {
  DEFAULT_SHAPE_FILL,
  colorOf,
  layerKindOf,
  pointsOf,
  recordOf,
  rotationOf,
  stringOf,
  strokeOf,
  textOf,
  weightOf,
} from './sanitize';
import { compactZ } from './z-order';

/** 图层短边下限。小于 8px 的图层选框比拖拽手柄还小，选不中也拖不动。 */
export const MIN_LAYER_EDGE = 8;

const DEFAULT_NAMES: Readonly<Record<LayerKind, string>> = Object.freeze({
  text: '文字',
  image: '图片',
  shape: '形状',
});
const DEFAULT_TEXT_COLOR = '#123328';
const DEFAULT_BACKGROUND = '#f6fbf8';
const DEFAULT_PLACEHOLDER_LABEL = '放图片';
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 4096;
/**
 * 画布单边合法区间。
 *
 * 64 下限：再小的画布连一个 14px 标题都放不下，界面只剩一堆重叠的按钮。
 *
 * 8192 上限：**它不是 Chromium 的渲染上限**，而是一个"导出倍率能安全放大"的额度。
 *
 * 实测（2026-11-02，`win32` + 系统 Edge / Chromium 156，用 `scripts/e2e/_parity-bundle.mjs`
 * 的 `launchBrowser()` 起浏览器；纯红铺满后读中心像素 + `toDataURL`）：
 *   · 8192 ✅ 801 ms，PNG 1.70M    · 16384 ✅ 2350 ms，6.68M    · 17000 ❌ 0 ms，`"data:,"`（长度 6）
 *
 * 边界是**像素总量 = 2^28 = 268,435,456 px**，**不是单边** —— 这条必须钉住，否则会外推出
 * 错误结论：16385×16384（268,451,840 px，只多 16,384 个像素）❌ 不画，而 32768×8192 与
 * 65535×4096（都是 268.4M px）✅ 正常画，20000×10000 也 ✅。只写"边界在 16384 与 17000
 * 之间"会让人以为单边过了 16384 就不行，那是错的：**单边 65535 能画，只要总像素不越界**。
 *
 * 那 8192 这个数为什么正好对：`PosterStudio.jsx:84` 的 `EXPORT_SCALE = 2` ⇒ 导出位图
 * (2E)² ≤ 2^28 ⇒ **E ≤ 2^13 = 8192**，等式精确取等号（4 × 8192² = 268,435,456）。所以
 * 8192 是"导出倍率能安全放大的最大逻辑尺寸"，不是拍出来的整数。附带代价（不是成因）：
 * 8192² ≈ 0.25 GB 位图，导出那张 16384² ≈ 1.00 GB。
 *
 * ⚠ 超边界的失败是**静默的，而且四层都在撒谎**：`canvas.width` 仍读回你设的 17000、
 * `getContext('2d')` 不为 null、不抛任何错、耗时 0 ms（⇒ 压根没尝试分配，不是 OOM）。
 * 唯一可观测信号是 `toDataURL` 返回 `"data:,"`。**判断依据只能是 `toDataURL` 的结果。**
 *
 * ⚠ 这里曾经写的是「Chromium 单边超 8192 就画不出来，导出得到一张全白 PNG 且不报错」——
 * 方向对了一半（确实是静默空图），但**边界和机制都错**：8193 / 12000 / 16384 都正常，17000
 * 也不是 OOM、不是崩溃，是无声丢弃。别因为"实测 16384 能画"就删掉这个上限：删掉之后
 * `EXPORT_SCALE=2` 会把导出推到 20000+，那时**没有任何一层会报错**。
 * 回归线：`scripts/e2e/canvas-edge-limit.spec.mjs`（含 17000 必须画不出来的正控）。
 *
 * 📌 适用范围：以上读数**只在 `win32` + 系统 Edge（Chromium 156）上实测过**；Electron 内嵌
 * 的 Chromium 版本、Linux / macOS、移动端（iOS Safari 硬上限约 16.7M 像素，与这里的 268M
 * 完全不是一个量级）**全部未测**，不要把桌面端结论外推过去。本仓刚在"读数没错但不具外推
 * 性"上吃过一次亏（`t6cjk 0 / sh1 0` 在 56px 成立、104px 就跨过像素边界）。
 */
const MIN_CANVAS_EDGE = 64;
const MAX_CANVAS_EDGE = 8192;

/**
 * 画布宽高窄化 + 夹紧。非法（非有限数 / ≤0）回落基准尺寸。
 *
 * 与 `setCanvasSize` 共用这一份边界，所以"切到 32px 宽"不会在那边通过、
 * 到这里又被改回去 —— 两个入口的合法集合是同一个。
 *
 * @param width 任意输入
 * @param height 任意输入
 * @returns 合法的 `{ width, height }`（整数，落在 [64, 8192]）
 */
export function normalizeCanvas(width: unknown, height: unknown): { width: number; height: number } {
  return {
    width: canvasEdge(width, POSTER_BASE.width),
    height: canvasEdge(height, POSTER_BASE.height),
  };
}

/** 单边窄化：非有限数或 ≤0 回落，再夹进合法区间。 */
function canvasEdge(raw: unknown, fallback: number): number {
  const n = asRoundedInt(raw, fallback);
  return clampNumber(n > 0 ? n : fallback, MIN_CANVAS_EDGE, MAX_CANVAS_EDGE);
}

/** 三种图层共有的几何与合成字段。`type` 留给各分支写，这样判别信息不会在共用部分被拓宽。 */
function commonFieldsOf(src: Readonly<Record<string, unknown>>, kind: LayerKind, index: number): Omit<LayerBase, 'type'> {
  return {
    id: textOf(src['id'], makeLayerId(kind)),
    name: textOf(src['name'], DEFAULT_NAMES[kind]),
    x: asRoundedInt(src['x'], 0),
    y: asRoundedInt(src['y'], 0),
    w: Math.max(MIN_LAYER_EDGE, asRoundedInt(src['w'], 200)),
    h: Math.max(MIN_LAYER_EDGE, asRoundedInt(src['h'], 100)),
    opacity: clampNumber(asFiniteNumber(src['opacity'], 1), 0, 1),
    z: asRoundedInt(src['z'], index + 1),
    hidden: src['hidden'] === true,
    rotation: rotationOf(src['rotation']),
    // 与 `hidden` 同一套写法：只认 `=== true`。
    // **不许写成 `Boolean(src['flipX'])`** —— 那会把字符串 `"false"`、数字 `-1`
    // 判成 true，于是一份被错误序列化的存档里"不要翻"的图层翻了。
    flipX: src['flipX'] === true,
    flipY: src['flipY'] === true,
  };
}

/**
 * 补齐一个图层：逐字段窄化 + 夹紧，缺字段补默认值。
 *
 * @param raw 任意输入（模板 / 存档 / AI 输出 / IPC）
 * @param index 在数组中的位置，仅用于兜底 z
 * @returns 字段完整的图层（判别联合的具体成员）
 */
export function normalizeLayer(raw: unknown, index: number): Layer {
  const src = recordOf(raw);
  const kind = layerKindOf(src);
  const common = commonFieldsOf(src, kind, index);

  if (kind === 'text') {
    const layer: TextLayer = {
      ...common,
      type: 'text',
      text: textOf(src['text'], ''),
      fontSize: clampNumber(asRoundedInt(src['fontSize'], 32), MIN_FONT_SIZE, MAX_FONT_SIZE),
      color: colorOf(src['color'], DEFAULT_TEXT_COLOR),
      weight: weightOf(src['weight']),
      align: src['align'] === 'center' ? 'center' : src['align'] === 'right' ? 'right' : 'left',
      lineHeight: clampNumber(asFiniteNumber(src['lineHeight'], 1.4), 0.8, 8),
      letterSpacing: clampNumber(asRoundedInt(src['letterSpacing'], 0), -64, 256),
      maxLines: clampNumber(asRoundedInt(src['maxLines'], 0), 0, 200),
      // 白名单写法，与上面 `align` 同一个形状（两处保持一致，改一处就能照着改另一处）。
      // ★ **默认和非法值都必须回退 `'top'`，不许回退 `'middle'`** ——
      //   回退 middle 等于让一份缺字段的旧存档整体下移（h=200/72px 的单行标题差 49.6px），
      //   而那正是这次要避免的回归。`top` 才是旧引擎行为。
      verticalAlign: src['verticalAlign'] === 'middle' ? 'middle'
        : src['verticalAlign'] === 'bottom' ? 'bottom' : 'top',
      // 空串 = 用引擎默认栈（真源是 `text/font-stack.ts` 的 `DEFAULT_FONT_STACK`，
      // 与回退路径 `PosterStudio.jsx:100` **字面一致**；窄化规则在 `font-family.ts`，
      // 含逐字符理由）。本行原先把默认栈描述成「中文字体优先」—— T01 把默认栈换成与
      // 旧引擎字面一致之后那句已经过时（会让人以为这里仍走另一个栈），故订正。
      fontFamily: fontFamilyOf(src['fontFamily']),
    };
    return layer;
  }

  if (kind === 'image') {
    const layer: ImageLayer = {
      ...common,
      type: 'image',
      // 只认字符串，不走 textOf：`src: 0` 被转成 `'0'` 会变成一条必然 404 的 URL，
      // 而它同时让 placeholder 算成 false ⇒ 用户看不到虚线框，只看到空白。见 sanitize.ts。
      src: stringOf(src['src']),
      fit: src['fit'] === 'contain' ? 'contain' : 'cover',
      radius: clampNumber(asRoundedInt(src['radius'], 0), 0, 4096),
      filters: clampFilters(src['filters']),
      // 占位标记必须活着穿过归一化：套模板走的就是这条路，丢了它模板里的
      // 「放医生照片」虚线框既不显示、也没法被 importFromPath 填充。
      placeholder: src['placeholder'] === true,
      placeholderLabel: textOf(src['placeholderLabel'], DEFAULT_PLACEHOLDER_LABEL),
    };
    return layer;
  }

  const rawKind = src['shapeKind'];
  const shapeKind: ShapeLayer['shapeKind'] =
    rawKind === 'ellipse' || rawKind === 'line' || rawKind === 'polygon' ? rawKind : 'rect';
  const layer: ShapeLayer = {
    ...common,
    type: 'shape',
    shapeKind,
    fill: colorOf(src['fill'], DEFAULT_SHAPE_FILL),
    radius: clampNumber(asRoundedInt(src['radius'], 0), 0, 4096),
    stroke: strokeOf(src['stroke']),
    points: pointsOf(src['points'], shapeKind),
  };
  return layer;
}

/**
 * 补齐一份文档。
 *
 * ★ `ratioKey` 用 `ratioKeyOf` **重算**，不信任存档里的值：它是宽高的派生量。
 *   改了宽高而 ratioKey 不跟着变，左栏就会出现"明明选的是 1:1，3:4 按钮却亮着"
 *   （现有 JS 实现踩过这个坑，见 `PosterStudio.jsx:215` 的注释）。
 * ★ `layers` 逐层 normalize 后**按 z 压紧成 1..n**（理由见 `z-order.ts`）。
 *
 * @param raw 任意输入
 * @returns 一份可以安全交给渲染层的文档
 */
export function normalizeDoc(raw: unknown): PosterDoc {
  const src = recordOf(raw);
  const size = normalizeCanvas(src['width'], src['height']);
  const rawLayers = src['layers'];
  const list: readonly unknown[] = Array.isArray(rawLayers) ? rawLayers : [];
  return {
    width: size.width,
    height: size.height,
    ratioKey: ratioKeyOf(size.width, size.height),
    background: colorOf(src['background'], DEFAULT_BACKGROUND),
    templateName: textOf(src['templateName'], ''),
    layers: compactZ(list.map((item, i) => normalizeLayer(item, i))),
  };
}
