/**
 * 闭合形状"**画不出来**"时写给人看的原因。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件（而不是留在 `draw.ts`）
 * ════════════════════════════════════════════════════════════════════════════
 * ① **它是纯文本构造，不含任何绘制逻辑**。`draw.ts` 的职责是"按 kind 分派 +
 *    填色描边"；"怎么把失败原因写成一句人话"是另一件事，改文案不该动到绘制代码。
 * ② `draw.ts` 已到 230 行（上限 250，`unit-ts-strict.mjs` [4/4]）。而"文案"
 *    是**最会持续增长**的那一类代码（每加一种形状就要加一条），留着它等于让
 *    `draw.ts` 随形状种类线性膨胀 —— 那是把规模上限问题存起来而不是解决它。
 *    拆出去之后 `draw.ts` 只剩分派与填充，加形状不再撑它。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么原因要写这么具体（带上实际宽高 / 实际顶点数）
 * ════════════════════════════════════════════════════════════════════════════
 * 这段文字最终会落到 `engine/render.ts` 诊断的 `detail` 里，而那条诊断的
 * `reason` 只有 `'draw-threw'` 一个词 —— 它既可能是"用户数据坏了"，也可能是
 * "渲染器有 bug"。若 `detail` 只写"几何非法"，排查的人还得回去读代码才知道
 * 是哪个字段坏了。所以这里**把实际值打出来**：`0×50` 比"宽高非法"有用得多。
 */

import type { ShapeLayer } from '../model/layer';

/**
 * 给出一条"这一层为什么一个像素都没画出来"的人读原因。
 *
 * `line` 分支**不可达**（`drawShapeLayer` 已把线分派给 `line.ts`），
 * 但仍显式处理：万一将来分派逻辑被改坏，这条消息会直接说明"分派错了"，
 * 比落到 `default` 的"还没有实现渲染"要准确得多 —— 后者会把人带去错误的排查方向。
 *
 * @param layer 出问题的形状图层
 * @returns 人读原因（含实际宽高 / 顶点数，可直接贴进诊断）
 */
export function closedPathFailureReason(layer: ShapeLayer): string {
  switch (layer.shapeKind) {
    case 'rect':
      return `矩形宽高必须是有限正数，收到 ${String(layer.w)}×${String(layer.h)}`
        + '——零或负尺寸的矩形填充不出任何像素';
    case 'ellipse':
      return `椭圆宽高必须是有限正数，收到 ${String(layer.w)}×${String(layer.h)}`
        + '——零或负尺寸的椭圆填充不出任何像素';
    case 'polygon':
      return `多边形需要至少 3 个顶点（且坐标都是有限数、不能全部重合），`
        + `收到 ${String(layer.points.length)} 个顶点`
        + `（宽高 ${String(layer.w)}×${String(layer.h)}）`;
    case 'line':
      return '内部错误：line 被分派到了闭合形状分支（应由 line.ts 处理）';
    default: {
      // 穷尽性检查：加第五种 shapeKind 时这里会报 TS2322，编译器会逼你回来。
      // 运行时消息必须准确（不许 `undefined`）—— 走到这里说明数据里有
      // 类型系统之外的值（存档被手改 / 旧版本 / AI 直出）。
      const exhaustive: never = layer.shapeKind;
      return `shapeKind="${String(exhaustive)}" 还没有实现渲染（几何模块不认识它）`
        + '——加一种新形状时，buildClosedPath 与 closedPathFailureReason 必须同时补';
    }
  }
}
