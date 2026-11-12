/**
 * **顶点形状**的路径构造：线、多边形。
 *
 * 与 `path.ts`（盒子形状：圆角矩形、椭圆）的分工见该文件头部。
 * 一句话：盒子形状只吃「宽、高」，顶点形状吃一串坐标 —— 输入形状不同就分文件，
 * 这样单文件规模上限（`unit-ts-strict.mjs` [4/4] 250 行）不会因为"形状种类增加"
 * 而被连带撑爆，加一种新顶点形状也不必再读一遍圆角的逻辑。
 *
 * 同样遵守 `path.ts` 的三条总约定：
 *   · 原点 = 图层左上角，未旋转未缩放（引擎已做好平移/旋转/透明度）；
 *   · 本文件不 `fill()` / `stroke()`，只铺路径；
 *   · 返回 `false` 表示**路径没成立且一次 ctx 调用都没发生**。
 */

import type { Point } from './guards';
import { isUsablePoint } from './guards';

/**
 * 线的方向。
 *
 * 为什么需要这个类型（而不是"从 `(0,0)` 画到 `(w,h)`"就完事）：
 * 线是**被压扁的盒子**（见 `model/layer.ts` 的 `ShapeLayer` 注释），盒子只有
 * 「宽、高」两个数，光看这两个数无法区分「左上到右下」和「左下到右上」——
 * 那两条线的外接盒完全一样。所以方向必须是一个显式参数，由调用方决定。
 *
 * 取值是**语义命名**而不是角度：模板作者和 AI 说的是"画一条竖线 / 一条往下的斜线"。
 */
export type LineDir = 'horizontal' | 'diagonal-down' | 'diagonal-up' | 'vertical';

/** 一个点到多边形的入参形状（`readonly` 数组，因为模型里的 `points` 就是只读的）。 */
type PointList = ReadonlyArray<Point>;

/**
 * 线路径：从盒子的一个角/边中点画到对角/对边中点。
 *
 * 四条方向与端点的对应（写死成契约，避免下游各自猜）：
 *   · `horizontal`     左中点 → 右中点
 *   · `vertical`       上中点 → 下中点
 *   · `diagonal-down`  左上角 → 右下角
 *   · `diagonal-up`    左下角 → 右上角
 *
 * ★ **不闭合**（不调 `closePath`）：闭合一条单段路径会让 canvas 把它当成
 *   "回到起点的折返路径"，`lineJoin` 在端点处生效 ⇒ 线两头出现斜切/圆角，
 *   而且 `stroke` 的实际覆盖范围与原意不同。线就是一条开路径。
 *
 * ★ 有效性判据按方向分开，这是必须的：一条 `horizontal` 线的 `h` 可以是 0
 *   （盒子被压到没有厚度），此时路径 `(0,0) → (w,0)` 完全合法；
 *   但 `w = 0` 的 `horizontal` 线就成了 `(0,h/2) → (0,h/2)` —— 长度为 0，
 *   canvas 配 `lineCap: 'butt'`（默认）时**一个像素都不画**，而且不报错。
 *   这正是本模块头部说的"静默空白"，所以按方向分别判。
 *
 * @param ctx 2D 上下文
 * @param w 盒子宽（≥ 0，横向/斜向要求 > 0）
 * @param h 盒子高（≥ 0，纵向/斜向要求 > 0）
 * @param dir 方向
 * @returns 路径是否成立
 */
export function linePath(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dir: LineDir,
): boolean {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) return false;

  let fromX: number;
  let fromY: number;
  let toX: number;
  let toY: number;

  // ★ 用 switch + `default: never` 而不是 if/else-if 链。
  //
  // 实测（2026-11-02）：第一版是 if/else-if，我给它加第五个方向 `'zigzag'`：
  //   · `tsc -p tsconfig.renderer.json` ⇒ **EXIT=0，零报错**
  //   · `unit-poster-geometry` ⇒ **164/0，全绿**
  // 也就是说新方向会**静默按 horizontal 画**（`fromY`/`toY` 的初始值兜底），
  // 而编译器和测试都不响。这是"画出来了、只是画错"的最坏形态。
  // 换成 switch + never 后，同一变异立刻报 TS2322（两处：这里与 `lineWidthOf`
  // 的旁路 → 见 `[20]` 段的断言）。
  //
  // 为什么 if/else-if 没有被保护：**没有"缺分支"这个概念**，if 链天然"可以有别的"。
  // 只有 `never` 赋值能把它变成一个类型错误。
  switch (dir) {
    case 'horizontal':
      fromX = 0;
      fromY = h / 2;
      toX = w;
      toY = h / 2;
      break;
    case 'vertical':
      fromX = w / 2;
      fromY = 0;
      toX = w / 2;
      toY = h;
      break;
    case 'diagonal-down':
      fromX = 0;
      fromY = 0;
      toX = w;
      toY = h;
      break;
    case 'diagonal-up':
      fromX = 0;
      fromY = h;
      toX = w;
      toY = 0;
      break;
    default: {
      // 穷尽性检查。运行时走到这里说明 dir 是类型之外的值（存档手改 / 旧数据）。
      // 返回 false（路径没成立）而不是"随便按某方向画" —— 后者会画出一条
      // 看起来正常、实际方向错的线，比不画更难查。
      const exhaustive: never = dir;
      void exhaustive;
      return false;
    }
  }

  // 长度为 0 的线画不出任何像素（默认 lineCap 是 butt）：判定为"路径没成立"。
  // 判据按方向分开，理由见本函数注释：横线允许 h = 0（盒子被压扁），竖线允许 w = 0。
  if (dir === 'horizontal') {
    if (w <= 0) return false;
  } else if (dir === 'vertical') {
    if (h <= 0) return false;
  } else if (w <= 0 || h <= 0) {
    return false;
  }
  if (fromX === toX && fromY === toY) return false;

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  return true;
}

/**
 * 多边形路径（闭合）。
 *
 * ★ 点数 < 3 时的行为是**明确定义**的，不是"随便试试"：
 *   `return false` 且**一次 ctx 调用都没有**（连 `beginPath()` 都不调）。
 *   为什么不 `throw`：这个函数在渲染循环里被逐图层调用，抛异常会让**整幅海报**
 *   （包括那些完全正确的图层）都画不出来，用户看到的是一张空白 —— 比"少一个多边形"
 *   严重得多。为什么不静默返回 true 并画一个空路径：那样调用方会以为画了，
 *   于是"点导入失败"这件事在整条链路上再也露不出来。
 *
 * ⚠ 已知缺口（如实声明）：这里只拦「点数不足」「坐标非有限数」「退化成一个点」，
 *   **不拦共线退化**（三点在同一直线上：路径合法但面积为 0，填充看不见，
 *   描边能看见）。要判共线得算叉积，代价与收益不划算 —— 而且共线三角形描边是有意义的
 *   （用户会看到一条线段），所以那不算失败。
 *
 * @param ctx 2D 上下文
 * @param points 顶点（相对图层左上角），只读
 * @returns 路径是否成立
 */
export function polygonPath(ctx: CanvasRenderingContext2D, points: PointList): boolean {
  if (points.length < 3) return false;

  // 先把**所有**顶点验一遍再动手：若校验与绘制交错，中途发现坏点时就
  // 已经在 ctx 上留了半条路径 —— 那正是"返回 false 但已经画了一半"的自相矛盾。
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!isUsablePoint(point)) return false;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  // 所有顶点重合 ⇒ 外接盒是 0×0 ⇒ 画出来什么都没有。
  if (maxX - minX <= 0 && maxY - minY <= 0) return false;

  ctx.beginPath();
  let isFirst = true;
  for (const point of points) {
    if (isFirst) {
      ctx.moveTo(point.x, point.y);
      isFirst = false;
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.closePath();
  return true;
}
