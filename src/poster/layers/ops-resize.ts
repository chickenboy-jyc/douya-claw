/**
 * 改画布尺寸 —— 移植 `PosterStudio.jsx:949` 的 `rescaleDoc` 语义，并补上它漏掉的三处缩放。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 必须保持不变的两条语义（这是产品行为，不是实现细节）
 * ════════════════════════════════════════════════════════════════════════════
 * ① **不清空**：切比例后图层一个都不能少。用户切一下比例再切回来，图必须还在。
 * ② **不重排**：z 与数组顺序原样带过来。切比例不是"重新排版"，重新算层级会让
 *    用户辛苦调好的上下关系凭空变化。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 相对现有实现补的三处（同一个 bug 的三个面孔：px 值没跟着缩）
 * ════════════════════════════════════════════════════════════════════════════
 * 现有 `rescaleDoc` 只缩 `x/y/w/h`、文字 `fontSize`、`radius`。漏掉的：
 *   · `letterSpacing` 是 px ⇒ 字号缩了它不缩，小画布上字距显得特别宽；
 *   · 形状的 `stroke.width` 是 px ⇒ 放大到 2× 后描边细得看不见；
 *   · 多边形的 `points` 是**相对左上角的 px** ⇒ 盒子缩了顶点不缩，三角形会戳到框外
 *     （而且它戳出去的部分会被裁剪，用户只看到"三角形缺了一角"）。
 * 三处都补上，且都按同一对比例 `sx / sy` 缩，与盒子的缩放保持一致。
 */

import type { Layer, ShapeLayer } from '../model/layer';
import type { PosterDoc } from '../model/doc';
import { ratioKeyOf } from '../model/doc';
import { MIN_LAYER_EDGE, normalizeCanvas } from './normalize';

/**
 * 字号缩放因子的下限。
 *
 * 为什么夹**因子**而不是夹结果：现有实现就是 `max(0.4, min(sx, sy))` 再取 `max(14, ...)`。
 * 夹结果（"字号最小 14"）在 1080→270 这种极端缩放下会让字占满整幅画；
 * 夹因子则保证"字相对画面的占比不会突然暴涨"，同时结果仍有一个 14px 的绝对下限
 * （见 `MIN_SCALED_FONT_SIZE`）挡住"小到读不出"的那一端。两条一起才是完整的。
 */
const MIN_FONT_SCALE = 0.4;
/** 缩放后的字体绝对下限。低于它中文已经糊成一团，读不出就不是文字层了。 */
const MIN_SCALED_FONT_SIZE = 14;

/** 保留两位小数，避免描边宽度累积成 `2.4199999999999995` 这种值存进存档。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 缩放一层。三种图层的公共部分（盒子）算好后各自补自己的 px 字段。
 *
 * @param layer 原图层（不会被修改）
 * @param sx 横向比例
 * @param sy 纵向比例
 * @param fontScale 字号比例（已夹下限，见 `MIN_FONT_SCALE`）
 * @returns 新图层
 */
function scaleLayer(layer: Layer, sx: number, sy: number, fontScale: number): Layer {
  const x = Math.round(layer.x * sx);
  const y = Math.round(layer.y * sy);
  const w = Math.max(MIN_LAYER_EDGE, Math.round(layer.w * sx));
  const h = Math.max(MIN_LAYER_EDGE, Math.round(layer.h * sy));
  const radiusScale = Math.min(sx, sy);

  if (layer.type === 'text') {
    return {
      ...layer,
      x,
      y,
      w,
      h,
      fontSize: Math.max(MIN_SCALED_FONT_SIZE, Math.round(layer.fontSize * fontScale)),
      letterSpacing: Math.round(layer.letterSpacing * fontScale),
    };
  }

  if (layer.type === 'image') {
    return { ...layer, x, y, w, h, radius: Math.round(layer.radius * radiusScale) };
  }

  const stroke: ShapeLayer['stroke'] =
    layer.stroke === null
      ? null
      : { color: layer.stroke.color, width: round2(layer.stroke.width * radiusScale) };
  return {
    ...layer,
    x,
    y,
    w,
    h,
    radius: Math.round(layer.radius * radiusScale),
    stroke,
    points: layer.points.map((point) => ({
      x: Math.round(point.x * sx),
      y: Math.round(point.y * sy),
    })),
  };
}

/**
 * 改画布尺寸，等比缩放所有图层。
 *
 * 尺寸归一化（`normalizeCanvas`）与 `normalizeDoc` 共用同一套边界，所以"切到 32px 宽"
 * 不会在这里通过、到了归一化又被改回去 —— 两个入口的合法集合是同一个。
 *
 * @param doc 文档
 * @param width 新宽（非法值回落基准尺寸）
 * @param height 新高（非法值回落基准尺寸）
 * @returns 新文档；尺寸没变时**原样返回**（避免撤销栈里多一层空快照）
 */
export function setCanvasSize(doc: PosterDoc, width: number, height: number): PosterDoc {
  const target = normalizeCanvas(width, height);
  if (target.width === doc.width && target.height === doc.height) return doc;
  const sx = target.width / Math.max(1, doc.width);
  const sy = target.height / Math.max(1, doc.height);
  const fontScale = Math.max(MIN_FONT_SCALE, Math.min(sx, sy));
  return {
    ...doc,
    width: target.width,
    height: target.height,
    ratioKey: ratioKeyOf(target.width, target.height),
    layers: doc.layers.map((layer) => scaleLayer(layer, sx, sy, fontScale)),
  };
}
