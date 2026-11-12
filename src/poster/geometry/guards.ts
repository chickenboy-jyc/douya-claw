/**
 * 几何图元的**公共前置条件**：可用性判定 + 数值下限 + 失败类型。
 *
 * 为什么单独一个文件（而不是各模块各写一行 `Number.isFinite`）：
 * 「什么样的盒子算可用」「最小线宽是多少」「画不出来时怎么表达失败」是**几何模块的
 * 公共契约**，它一变，`path.ts` / `polyline.ts` / `line.ts` / `draw.ts` 必须同时变。
 * 写四份的话，改动时漏一处的结果是"矩形拒掉了 NaN 宽、而多边形没拒"——
 * 这种不对称只看代码看不出来，只在某个特定的脏数据上才现形。
 *
 * 也正因为它是"公共契约"，这里**只放纯判定与纯构造**，不放任何会调用 ctx 的东西：
 * 判定可以在动笔之前跑完，而"动笔"必须留在各自模块里（否则又会把校验与绘制
 * 交错起来，出现"返回 false 但已经画了一半"的自相矛盾）。
 */

import type { ShapeLayer } from '../model/layer';

/**
 * 描边线宽下限，单位像素（逻辑像素，不含导出倍率）。
 *
 * 为什么必须有这条下限：canvas 的 `lineWidth = 0` **不抛错、也不画**——
 * 它安静地什么都不做，调用方会以为"我设了描边"，于是去查颜色、查图层顺序，
 * 永远查不到"线宽是 0"。
 * 下限取 1 而不是"当成没设描边"：`stroke !== null` 已经是"我要描边"的明确表达，
 * 我们的职责是把这句话画出来（哪怕只有 1px），而不是替它改决定。
 *
 * ★ 它**实际**在哪两种情况下生效（实测，2026-11-02）—— 别把它当"防线"：
 *   ① `stroke.width` 是 `(0, 1)` 的分数值。`layers/sanitize.ts` 的 `strokeOf`
 *      只把 `width <= 0` 归一成 `null`，`0 < width <= 256` 原样保留 ⇒
 *      `width: 0.4` 会活到这里，被抬到 1。**这条路不依赖 normalize。**
 *   ② 调用方**没有**先 `normalizeLayer` 就读渲染（例如 AI 直出、手搓存档）。
 *      此时 `line` 的短边可以是 `0` / `1`，`max(1, h)` 真的会绑。
 *
 * ★ 它**挡不住**什么（这才是容易误读的地方）：
 *   一份经过 `normalizeLayer`、且 `stroke === null` 的文档里，`line` 的短边被
 *   `MIN_LAYER_EDGE = 8` 垫到 8 ⇒ 走"从盒子反推"那条路时恒 ≥ 8。
 *   也就是说它在**那个格子里**不生效，挡不住"细线被画成 8px"。
 *   那属于 `MIN_LAYER_EDGE` 该怎么对待 line 的**规格问题**。
 *
 *   ⚠ 但**不要**把它简化成"对 line 恒不生效" —— 我自己第一版就是这么写的，
 *     而情形 ① 恰好是反例：`stroke: {width: 0.4}` 经 normalize 后仍是 0.4，
 *     到这里被抬成 1（断言 `[17]` 的 D 段钉着）。**"恒不生效"这四个字是错的**，
 *     正确的是"在 `stroke === null` 且经 normalize 的格子里不生效"。
 *     这正是"否定词最容易没跑就写下"的实例：漏一个限定条件，"不生效"变成"恒不生效"。
 *
 *   完整读数不抄在这里（注释里的读数会与测试漂移，见 `line.ts` 同类说明），
 *   唯一真源是 `scripts/smoke/unit-poster-geometry.mjs` 的 [17] 矩阵 A/B/B2/D。
 */
export const MIN_STROKE_WIDTH = 1;

/**
 * 多边形顶点的类型。与 `ShapeLayer['points']` 的元素类型结构一致
 * （`readonly`，因为模型里的 `points` 就是只读数组）。
 */
export type Point = { readonly x: number; readonly y: number };

/**
 * 盒子是否可用于构造路径：两个维度都必须是**有限正数**。
 *
 * 为什么 `0` 也算不可用：0 宽或 0 高的闭合形状，路径本身合法，但填充出来
 * 一个像素都没有（面积 0），描边则退化成一条线 —— 于是"矩形"和"线"在输出上
 * 无法区分。这类"以为画了、其实没有"的状态是本模块最想挡住的，所以返回 `false`
 * 让调用方知道它没画（`draw.ts` 会把它转成一条可观测的失败，见 `ShapeDrawError`）。
 *
 * @param w 宽
 * @param h 高
 * @returns 两个维度都是有限正数时为 true
 */
export function isUsableBox(w: number, h: number): boolean {
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
}

/**
 * 单个顶点是否可用：两个坐标都必须是有限数。
 *
 * 不要求顶点在盒子内：多边形顶点是**绘图指令**，不是命中区域。
 * 越界顶点会被 canvas 画到图层外（可能被上层图层盖住），但那是调用方的排版问题，
 * 不是几何非法 —— 拦住它会让"故意画到边界外"的正常用法失效。
 *
 * @param point 顶点
 * @returns 两个坐标都是有限数时为 true
 */
export function isUsablePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * 「这一层画不出来」的**可观测失败**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么这里要抛异常，而不是像路径函数那样安静返回 false
 * ════════════════════════════════════════════════════════════════════════════
 * 路径函数（`path.ts` / `polyline.ts` / `line.ts`）是**纯构造器**：它们返回 boolean，
 * 因为单测要能直接断言"这条路径没成立"，而不必去捕异常。
 * 但 `drawShapeLayer` 是**渲染器**，它处在一个已钉死的跨模块契约里
 * （`engine/render.ts` 头部那条硬约定）：
 *
 *   > `renderDoc` 返回的诊断数组非空 = 有层没画出来。空数组是唯一的"全部画出来了"。
 *
 * 也就是说"我没画"这件事**必须**走到诊断数组里，否则调用方无从知道 ——
 * 导出一张少了图形、但报告"成功"的图，正是本仓反复踩的坑。
 *
 * 而诊断只有三条产生路径：`non-finite-field`（引擎查图层字段）、`missing-renderer`
 * （查不到渲染器）、`draw-threw`（**渲染器抛异常**）。`RenderEnv` 里没有诊断回调，
 * 渲染器改不了前两条 ⇒ **抛异常是渲染器唯一能把"我没画"送达调用方的通道**。
 *
 * ★ 一个必须说清的事实（否则有人会以为这里是"一层崩全图白"）：
 *   `render.ts` 的 `try { draw(...) } catch { … } finally { ctx.restore() }`
 *   是**逐层**的。抛异常只会让**这一层**不画并记一条 `draw-threw`，
 *   其余图层照常绘制，且 `finally` 保证变换矩阵不会失配雪崩。
 *   所以"抛"在这里不会升级成整幅图空白 —— 这一点是读过 `render.ts` 才敢依赖的，
 *   如果将来引擎去掉那个 catch，本设计会失效（届时症状是整图空白 + 直接抛出的
 *   `ShapeDrawError`，可立刻归因）。
 *
 * ★ 已知代价（如实声明）：诊断的 `reason` 会是 `'draw-threw'`，而 `render.ts` 对它的
 *   注释是"渲染器抛了异常（图元实现里的 bug，或 env 里的数据不合法）"。也就是说
 *   「用户给了 2 个顶点」和「渲染器有 bug」在 `reason` 上**分不开**，要靠 `detail`
 *   里带的中文细节区分（本类把图层 id、shapeKind、具体原因都拼进 message）。
 *   要彻底分开，得给 `RenderDiagnosticReason` 加一个成员 —— 那是 `render.ts` 的
 *   改动（不在几何模块边界内）。
 */
export class ShapeDrawError extends Error {
  /** 出问题的图层 id（诊断要能定位到「哪一层」）。 */
  readonly layerId: string;
  /** 该层的 `type` / `shapeKind`，拼在消息里方便肉眼归因。 */
  readonly kindLabel: string;

  /**
   * @param layerId 图层 id
   * @param kindLabel 图层种类标签（`'polygon'` / `'text'` 等）
   * @param why 人读的原因（要能让读者知道"哪条数据不对、后果是什么"）
   */
  constructor(layerId: string, kindLabel: string, why: string) {
    super(`图层 ${layerId}（${kindLabel}）没有画出任何像素：${why}`);
    // 赋值而不是声明字段：`noImplicitOverride` 下声明 `name` 需要 `override`，
    // 而 `Error.name` 是可写属性，赋值既达到目的又不多一个声明。
    this.name = 'ShapeDrawError';
    this.layerId = layerId;
    this.kindLabel = kindLabel;
  }
}

/**
 * 抛一条"这层画不出来"的失败。
 *
 * 抽成 `never` 返回值的函数（而不是每处 `throw new ShapeDrawError(...)`）：
 * ① 让调用处的控制流对 tsc 是**明确终止**的 —— 少了这一步，TS 会认为
 *    "函数可能正常返回"，于是后面用 `layer.w` 之类的代码仍要写防御分支；
 * ② 把 message 的拼装格式收在**一处**，诊断文本风格不会随人漂移。
 *
 * @param layer 出问题的形状图层
 * @param why 人读的原因
 * @throws ShapeDrawError 永远
 */
export function failShape(layer: ShapeLayer, why: string): never {
  throw new ShapeDrawError(layer.id, layer.shapeKind, why);
}
