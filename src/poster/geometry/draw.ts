/**
 * 形状图元的**绘制策略与调度入口**：构造路径 → 填充 / 描边 → 注册进调度表。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 现状（这段代码存在的理由）
 * ════════════════════════════════════════════════════════════════════════════
 * `PosterStudio.jsx:638-642` 的 `drawShapeLayer` 整个函数 5 行：
 * `roundRectPath()` + `fill()`。全仓 `stroke()` 零命中、`arc()` 零命中、
 * 多边形零命中 ⇒ 除了"圆角矩形填充"，几何能力一条都没有。
 * 老板要的「用几何工具拼装线条矩形」，落到代码上就是这个文件：
 * 四种形状 × （填充 / 描边）= 一条统一的、可测试的绘制路径。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 模块分工（读这个文件前先知道谁在哪）
 * ════════════════════════════════════════════════════════════════════════════
 *   guards.ts    公共前置条件：`isUsableBox` / `MIN_STROKE_WIDTH` / `ShapeDrawError` / `failShape`
 *   path.ts      盒子形状的**路径**：`clampRoundRadius` / `roundRectPath` / `ellipsePath`
 *   polyline.ts  顶点形状的**路径**：`LineDir` / `linePath` / `polygonPath`
 *   line.ts      线的**策略**：方向推断、线宽反推、fill 当描边色
 *   本文件        闭合形状的策略（fill → 可选 stroke）+ 分派 + 注册
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 与 `engine/registry.ts` 的分工（逐条对齐）
 * ════════════════════════════════════════════════════════════════════════════
 * 引擎保证、本文件**不做**的三件事：
 *   ① 平移 + 旋转          —— 所以坐标永远是 `[0,0,w,h]` 里的局部坐标；
 *   ② 全局透明度           —— 所以这里**不许**再乘 `layer.opacity`（乘了会变成 opacity²；
 *                            0.5 的图层会画成 0.25，而且只在半透明图层上看得出来）；
 *   ③ 缩放（dpr / 导出倍率）—— 所以这里**不许**自己 `scale`。
 */

import type { ShapeLayer } from '../model/layer';
import { isShapeLayer } from '../model/layer';
import type { LayerDrawFn } from '../engine/registry';
import { registerLayerRenderer } from '../engine/registry';
import { MIN_STROKE_WIDTH, ShapeDrawError, failShape } from './guards';
import { ellipsePath, roundRectPath } from './path';
import { polygonPath } from './polyline';
import { drawLine } from './line';
import { closedPathFailureReason } from './failure';

/** 颜色兜底：空串会让 canvas **保留上一次的** `fillStyle`（跨图层串色），所以退到纯黑。 */
const FALLBACK_FILL = '#000000';

/** 颜色兜底（见 `FALLBACK_FILL`）。 */
function normalizeColor(color: string): string {
  return color.length > 0 ? color : FALLBACK_FILL;
}

/**
 * 描边宽度（已夹下限）。
 *
 * @param stroke 图层的描边设置（`null` = 只填充不描边）
 * @returns 至少 `MIN_STROKE_WIDTH`
 */
function strokeWidthOf(stroke: ShapeLayer['stroke']): number {
  if (stroke === null) return MIN_STROKE_WIDTH;
  const width = stroke.width;
  if (!Number.isFinite(width)) return MIN_STROKE_WIDTH;
  return Math.max(MIN_STROKE_WIDTH, width);
}

/**
 * 构造闭合形状的路径（矩形 / 椭圆 / 多边形）。
 *
 * ★ `default` 里的 `const exhaustive: never` 是**穷尽性检查**，不是兜底逻辑。
 *   它的作用是：将来给 `ShapeLayer['shapeKind']` 加第五种（如 `'arrow'`）时，
 *   `layer.shapeKind` 在这个位置就不再是 `never` ⇒ **tsc 直接报 TS2322**，
 *   编译器会逼你回来处理。
 *
 *   为什么不用"省略 default 靠 TS2366（函数缺少 return）"那条路：
 *   实测也能挡（加第五种时 `buildClosedPath` 与 `closedPathFailureReason`
 *   各报一条 TS2366），但它有个副作用 —— **运行时消息会退化成 `undefined`**
 *   （实测：`图层 A（arrow）没有画出任何像素：undefined`）。
 *   而 `never` 写法两者兼得：编译期照报，运行时也给出准确的
 *   "未实现的 shapeKind: arrow"（这句话本身就是对的：它确实没实现）。
 *
 * @returns 路径是否成立（`false` 时**该函数没有在 ctx 上留下任何调用**）
 */
function buildClosedPath(ctx: CanvasRenderingContext2D, layer: ShapeLayer): boolean {
  switch (layer.shapeKind) {
    case 'rect':
      return roundRectPath(ctx, layer.w, layer.h, layer.radius);
    case 'ellipse':
      return ellipsePath(ctx, layer.w, layer.h);
    case 'polygon':
      return polygonPath(ctx, layer.points);
    case 'line':
      // 不可达：`drawShapeLayer` 已把 line 分派给 `line.ts`。返回 false 而不是抛，
      // 是为了让"分派逻辑被改坏"表现为一条普通失败，而不是在这里抛一个谜之异常。
      return false;
    default: {
      // 穷尽性检查（见函数头注释）。运行时如果真走到这里，说明数据里的
      // shapeKind 是类型系统之外的值（存档被手改 / AI 直出 / 旧版本数据）。
      const exhaustive: never = layer.shapeKind;
      void exhaustive;
      return false;
    }
  }
}


/**
 * 画闭合形状：先填充，再（可选）描边。
 *
 * 顺序是「填充 → 描边」而不是反过来：描边压在填充上，这样描边色的边缘不会被
 * 填充色盖掉半像素（`lineWidth` 以路径为中心向外各占一半，先描边再填充会让
 * 内半边被吃掉，视觉上线比设定值细一半）。
 *
 * @param ctx 2D 上下文
 * @param layer 已收窄的形状图层
 * @throws ShapeDrawError 路径不成立时（理由见 `guards.ts` 里 `ShapeDrawError` 的注释）
 */
function drawClosedShape(ctx: CanvasRenderingContext2D, layer: ShapeLayer): void {
  if (!buildClosedPath(ctx, layer)) {
    failShape(layer, closedPathFailureReason(layer));
  }

  ctx.fillStyle = normalizeColor(layer.fill);
  ctx.fill();

  const stroke = layer.stroke;
  // `null` = 明确表示"只填充不描边"（模型用 null 而不是 undefined，见 ShapeLayer 注释）。
  if (stroke === null) return;
  ctx.strokeStyle = normalizeColor(stroke.color);
  ctx.lineWidth = strokeWidthOf(stroke);
  ctx.stroke();
}

/**
 * 形状图元的绘制入口，注册在 `registry` 的 `'shape'` 位上。
 *
 * ★ 为什么开头的 `isShapeLayer` 不是多余判断：`LayerDrawFn` 的入参是
 *   **判别联合的宽类型** `Layer`（注册表按 `kind` 分发后类型信息就丢了），
 *   所以收窄必须发生在真正要用 `shapeKind` / `fill` / `points` 的地方。
 *   真拿到非形状图层（注册表被错误接线）时**抛错而不是安静返回**：这是接线 bug，
 *   而"安静返回"的表现是"某一层永远不画、没有任何报错"——正是本仓最贵的失败形态。
 *
 * ★ 关于 `ctx.save()` / `ctx.restore()`：本函数会改 `fillStyle` / `strokeStyle` /
 *   `lineWidth` 三个全局状态。引擎是否在每层周围 save/restore 由引擎决定，
 *   但图元**不能**依赖那个假设 —— 一旦引擎将来改成"手动回填状态"或忘了回填，
 *   症状会是"描边色串到别的图层上"，而且取决于图层顺序（极难复现）。
 *   自己 save/restore 的成本是每层一次，换掉这一类不确定性；写在 `finally` 里
 *   是为了**抛错时也配平**（否则一次失败会把矩阵/样式状态留给后面的图层，
 *   雪崩式错位比"少画一层"严重得多）。
 *
 * @param ctx 2D 上下文（引擎已应用平移 + 旋转 + 透明度）
 * @param layer 待绘制图层（宽类型，函数内收窄）
 * @throws ShapeDrawError 该层画不出来时（见 `guards.ts`；引擎会转成 `draw-threw` 诊断）
 */
export const drawShapeLayer: LayerDrawFn = (ctx, layer): void => {
  if (!isShapeLayer(layer)) {
    throw new ShapeDrawError(
      layer.id,
      layer.type,
      `'shape' 渲染器收到了 type="${layer.type}" 的图层 —— 注册表接线有误，该层没有画出来`,
    );
  }

  // 有限性检查是**纵深防御**：`render.ts` 在调用渲染器之前已经用
  // `findNonFiniteField()` 拦掉了 NaN/Infinity 的 x/y/w/h/opacity/rotation/z
  // 并记了 `non-finite-field` 诊断 ⇒ 走 `renderDoc` 时这两条分支不可达。
  // 保留它们是因为 `drawShapeLayer` 也会被单测和将来其它调用方**直接**调用，
  // 那时没有引擎的守卫兜着。这一点如实写在这里，免得有人以为它是主防线。
  if (!Number.isFinite(layer.w) || !Number.isFinite(layer.h)) {
    failShape(layer, `宽高不是有限数，收到 ${String(layer.w)}×${String(layer.h)}`);
  }
  // 负尺寸不被 `layerGuard` 覆盖（它只查有限性），所以这里必须自己拦：
  // 负号会让路径的行进方向翻转，`isUsableBox` 判 false ⇒ 什么都不画。
  if (layer.w < 0 || layer.h < 0) {
    failShape(layer, `宽高不能是负数，收到 ${String(layer.w)}×${String(layer.h)}`);
  }

  ctx.save();
  try {
    if (layer.shapeKind === 'line') {
      drawLine(ctx, layer);
    } else {
      drawClosedShape(ctx, layer);
    }
  } finally {
    ctx.restore();
  }
};

/**
 * 模块加载即注册。
 *
 * 为什么放在模块顶层而不是"谁用谁注册"：注册表是**调度层唯一认识图元**的地方，
 * 漏注册的失败形态是"这一层静默不画"（`registry.ts` 的 `MissingRenderer` 诊断）。
 * 放在顶层 ⇒ `import '../geometry'` 这一个动作就完成了接线，没有"忘了调 init"这一步。
 * 覆盖已有注册是允许的（`registerLayerRenderer` 明确支持热更与测试替身）。
 *
 * ⚠ **本注释必须留在这里**：注册是模块副作用，所以「谁 import 了本模块」就是接线本身。
 *   截至本次提交，仓库里**没有任何生产代码 import 几何模块**（`render.ts` 不 import 它）。
 *   也就是说注册此刻**尚未生效**，`renderDoc` 里形状层会得到 `missing-renderer` 诊断
 *   —— 这是**已知的、待接线**状态，不是"已经通了"。接线点属于引擎/装配层（不在本模块边界）。
 */
registerLayerRenderer('shape', drawShapeLayer);
