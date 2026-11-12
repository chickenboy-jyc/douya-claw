/**
 * **线**的绘制策略。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么线要单独一个文件（不是按行数硬切）
 * ════════════════════════════════════════════════════════════════════════════
 * 四种形状里，只有 `line` 有下面三条**独有的**语义，其余三种（矩形/椭圆/多边形）
 * 都是"构造闭合路径 → fill → 可选 stroke"的同构处理：
 *
 *   ① **方向要靠推断**：模型只有 `w/h` 两个数，而「左上→右下」和「左下→右上」
 *      的外接盒完全一样。所以线必须先把盒子翻译成一个 `LineDir`。
 *   ② **用 `fill` 当描边色**：`ShapeLayer.fill` 的注释写着「`line` 用它当描边色」。
 *      于是线的颜色字段和其他三种形状的语义正好相反。
 *   ③ **线宽要从盒子反推**：没给 `stroke` 时，线是"被压扁的盒子"，
 *      被压掉的那一维就是粗细（横线看 `h`、竖线看 `w`）。
 *
 * 把这三条留在 `draw.ts` 里，会让"怎么画一个矩形"和"线的方向怎么猜"挤在一起，
 * 而且 `draw.ts` 会撞上单文件 250 行上限（`unit-ts-strict.mjs` [4/4]）。
 * 按**语义独特性**分文件，是这个边界最自然的落法 —— 加一种新形状时也不用
 * 再读一遍线的推断规则。
 *
 * 路径怎么铺（开路径、四个方向的端点坐标）仍然归 `polyline.ts` 的 `linePath`：
 * 本文件只决定"用什么方向、多粗、什么色、fill 还是 stroke"这些**策略**。
 */

import type { ShapeLayer } from '../model/layer';
import { MIN_STROKE_WIDTH, failShape } from './guards';
import { linePath } from './polyline';
import type { LineDir } from './polyline';

/**
 * 判定「线沿哪个轴」的宽高比阈值。
 *
 * 取 3 的理由：线的盒子是**被压扁**的，正常用法下主/次比通常是 20 以上
 * （200×4 的横线、4×200 的竖线）；而"斜线"的盒子接近正方形（120×120）。
 * 阈值取 3 时，2:1 的盒子会被判成斜线 —— 这是刻意的：2:1 更像一条斜线的外接盒，
 * 而不是一条"有点粗的横线"（那种情况用户会把 h 拖到很小）。
 *
 * ⚠ 已知缺口（如实声明）：`ShapeLayer` 里**没有** `lineDir` 字段（模型已冻结），
 *   所以 `diagonal-up`（左下 → 右上）**无法从盒子里表达出来** —— `resolveLineDir`
 *   只会产出 `horizontal` / `vertical` / `diagonal-down`。`linePath` 本身**支持**
 *   四个方向（有断言），缺的只是模型字段。要支持得给 `ShapeLayer` 加字段并由
 *   `normalizeLayer` 补默认值，那是另一次改动。
 */
const DOMINANT_AXIS_RATIO = 3;

/** 颜色兜底：空串会让 canvas **保留上一次的** `strokeStyle`（跨图层串色），所以退到纯黑。 */
const FALLBACK_FILL = '#000000';

/**
 * 从盒子的宽高推断线的方向。
 *
 * 抽成导出函数（而不是内联进 `drawLine`）是为了让它**可被断言**：
 * 方向策略是"几何正确性"之外的第二类风险 —— 一条本该水平的线被画成斜线，
 * 图还是画出来了，只是位置不对，肉眼很难归因。
 *
 * @param w 盒子宽（≥ 0）
 * @param h 盒子高（≥ 0）
 * @returns 方向；盒子退化到 `0×0` 或含非有限数时返回 `horizontal`
 *          （`linePath` 会把 `w<=0` 判成失败，`drawLine` 会抛出来）
 */
export function resolveLineDir(w: number, h: number): LineDir {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 'horizontal';
  if (w <= 0 && h <= 0) return 'horizontal';
  if (w <= 0) return 'vertical';
  if (h <= 0) return 'horizontal';
  if (w >= h * DOMINANT_AXIS_RATIO) return 'horizontal';
  if (h >= w * DOMINANT_AXIS_RATIO) return 'vertical';
  return 'diagonal-down';
}

/**
 * 线的实际线宽。
 *
 * 来源按优先级：
 *   ① 有 `stroke` ⇒ 用 `stroke.width`（夹下限）。用户显式给了线宽，就该听它的。
 *   ② 没 `stroke` 且是横线 ⇒ 用盒子的**高**当粗细。线是"被压扁的盒子"，
 *      盒子被压掉的那一维就是线的粗细 —— 这是模型语义，不是猜的。
 *   ③ 没 `stroke` 且是竖线 ⇒ 用盒子的**宽**当粗细（同上，压掉的是宽）。
 *   ④ 没 `stroke` 且是斜线 ⇒ 退回 1px。**不用盒子的短边**：斜线的盒子短边
 *      在 2:1 比例下是"高"，而 120×120 的斜线盒子短边是 120 —— 拿它当线宽会
 *      画出一坨 120px 粗的斜带，那不是一条线。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 「从盒子反推粗细」这条语义的两个前提（实测，2026-11-02）
 * ════════════════════════════════════════════════════════════════════════════
 * 分支 ②③ 能让 1px、2px 的细线出现，**只在下面两种情况下**。写在这里是因为
 * 不写就会变成隐式承诺（eng-poster-layers 的 `MIN_LAYER_EDGE = 8` 会把它关掉）：
 *
 * **前提 A：`stroke === null` 且这份文档没有经过 `normalizeLayer` / `normalizeDoc`。**
 *   `normalize` 把**所有**图层的 `w`/`h` 一律 `Math.max(8, …)`（`MIN_LAYER_EDGE`），
 *   因为它要保证"选框可点、可拖"。而线是"被压扁的盒子"，短边被垫到 8 之后
 *   `max(1, 8) = 8` ⇒ **这条路走不到细线**。
 *   ⚠ 而 `renderDoc` **自己不做 normalize**（`engine/render.ts` 全文零命中）——
 *     它是纯渲染器。所以"真实链路是否被 8 锁死"取决于**调用方有没有先 normalize**，
 *     不是渲染层能决定的事。当前 `src/poster/` 尚未接进 `src/renderer/`，
 *     这个调用方还不存在 ⇒ 现在写"真实链路已经锁死"是不准确的，写"会在
 *     normalize 之后锁死"才准确。
 *   ⚠ `stroke` **非 null** 时（哪怕 `width: 1`）**不受此限** —— 显式线宽会
 *     原样保留，`normalize` 之后线宽仍是 1。所以「细线做不到」这句话必须带
 *     `stroke === null` 这个限定，否则它是错的（我第一版就漏了这个限定）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 具体数值不在这里抄 —— 请读测试，别读注释
 * ════════════════════════════════════════════════════════════════════════════
 * 本注释第一版内联了一张实测表（`0×200 → 线宽 8` 之类）。已删掉换成本段，
 * 理由：**复制到注释里的读数会与测试漂移** —— 测试一改，注释不会跟着改，
 * 于是注释开始陈述一个过去的世界（这正是本模块反复踩的形态）。
 * 唯一的真源是断言，不是这里的文字：
 *   `scripts/smoke/unit-poster-geometry.mjs` 的 **[17] 线宽可达性矩阵**
 *   （A：不走 normalize / B：经 normalize 且 stroke=null / B2：显式 stroke.width）
 *   `scripts/smoke/unit-poster-layers.mjs` 的 **I18–I25**（归一化侧的字段读数）
 *
 * **前提 B：`stroke === null`，或者 `stroke.width` 落在 `(0, 1)` 之间。**
 *   `layers/sanitize.ts` 的 `strokeOf` 只把 `width <= 0` 归一成 `null`，
 *   `0 < width <= 256` **原样保留**。所以 `stroke: { width: 0.4 }` 会活到这一层，
 *   被 `Math.max(1, 0.4)` 抬到 1 —— 这条夹紧**不依赖 normalize 是否跑过**。
 *
 * 结论（不夸大）：`MIN_STROKE_WIDTH` 既不是"永不可达"，也不是"防线"。
 * 它的实际作用是**兜住 `stroke.width` 的分数值**，以及在调用方跳过 normalize 时
 * 兜住 0/1px 的盒子。一旦 normalize 成为必经之路，分支 ②③ 的细线能力就等于关闭，
 * 那时**正确做法是改 `MIN_LAYER_EDGE` 对 line 的例外**（规格层），
 * 不是在渲染层偷偷把 8 改回 1 —— 那会让渲染结果与图层盒子的实际尺寸不一致，
 * 选框会和画出来的线对不上。
 *
 * @param dir 线方向
 * @param w 盒子宽
 * @param h 盒子高
 * @param stroke 图层的描边设置（`null` = 没显式指定线宽）
 * @returns 至少 `MIN_STROKE_WIDTH`
 */
function lineWidthOf(dir: LineDir, w: number, h: number, stroke: ShapeLayer['stroke']): number {
  if (stroke !== null) {
    const width = stroke.width;
    if (!Number.isFinite(width)) return MIN_STROKE_WIDTH;
    return Math.max(MIN_STROKE_WIDTH, width);
  }
  // ★ switch + `default: never`（理由与 `polyline.ts` 的 `linePath` 相同）。
  // 第一版是 if 链，末行 `return MIN_STROKE_WIDTH` 兜住"其他方向" ——
  // 那让 `LineDir` 加第五个方向时**静默按 1px 处理**，编译器和测试都不响。
  // 注意：`diagonal-down` 与 `diagonal-up` 在这里**故意共用同一个值**（都是 1px），
  // 但它们是两个**显式**的 case —— 共用值可以，共用分支不行：前者是设计，
  // 后者会让"漏了新方向"和"有意复用"在代码上长得一样。
  switch (dir) {
    case 'horizontal':
      return Math.max(MIN_STROKE_WIDTH, h);
    case 'vertical':
      return Math.max(MIN_STROKE_WIDTH, w);
    case 'diagonal-down':
    case 'diagonal-up':
      return MIN_STROKE_WIDTH;
    default: {
      const exhaustive: never = dir;
      void exhaustive;
      return MIN_STROKE_WIDTH;
    }
  }
}

/**
 * 画一条线：**必须用 `stroke`**，不能用 `fill`。
 *
 * ── 设计理由（这部分与"数据能不能到这个分支"无关，长期成立）──
 * 线的盒子高理论上可能只有 1px（`200×1` 的分隔线）。
 * 用 `fill` 填一个 1px 高的矩形，在导出倍率 0.25 时它只占 0.25 物理像素，
 * 抗锯齿会把它摊成一层几乎透明的浅灰 —— 屏幕上"看得见一点"，导出图上是空的。
 * `stroke` 的线宽是**几何宽度**（按变换矩阵缩放，并保证至少覆盖一条像素带），
 * 所以**任意线宽的线**（1px 或 8px）在低倍率下都比 fill 版本稳定可见 ——
 * 这个结论不依赖"能不能做出 1px 的线"。
 *
 * ── 可达性（2026-11-02 补，因为上面那个例子当前到不了）──
 * `200×1` 这种细线在当前数据流下**走不到"从盒子反推"那条路**：
 * `normalizeLayer` 的 `MIN_LAYER_EDGE = 8` 会把短边夹成 8 ⇒ 那条路恒 ≥ 8。
 * 所以 `1px` 是**设计意图 / 能力上限**，不是当前数据流的事实。
 *
 * ⚠ 两个限定词都不能省（我第一版省了，于是这句话变成错的）：
 *   ① 「**从盒子反推**那条路」—— 显式 `stroke: {width: 1}` 时线宽就是 1，
 *      经 normalize 也仍是 1。**不是"所有细线都做不到"**。
 *   ② 「**当前数据流**」—— 例外若批准（line 的短边允许 0），前半句即失效。
 *
 * 例外是否批准由 team-lead 定；对照读数只看断言，不看本注释：
 * `scripts/smoke/unit-poster-geometry.mjs` 的 [17] 矩阵（A/B/B2/D）+
 * `scripts/smoke/unit-poster-layers.mjs` 的 I18–I25。
 * ⚠ 别照着"1px 分隔线"去做 UI —— **不写 stroke** 时现在做出来是 8px 粗。
 *
 * 颜色取 `layer.fill`：这是模型里写死的语义（`ShapeLayer.fill` 的注释
 * 「`line` 用它当描边色」）。`stroke.color` 对线**不参与** —— 两个颜色字段
 * 同时生效会让"改了没反应"变成常态。
 *
 * @param ctx 2D 上下文
 * @param layer 已经收窄过的形状图层
 * @throws ShapeDrawError 路径不成立（零长度 / 非有限尺寸）时 —— 见 `guards.ts` 的理由
 */
export function drawLine(ctx: CanvasRenderingContext2D, layer: ShapeLayer): void {
  const dir = resolveLineDir(layer.w, layer.h);
  if (!linePath(ctx, layer.w, layer.h, dir)) {
    // 零长度的线在 canvas 里（默认 `lineCap: 'butt'`）**一个像素都不画且不报错**。
    // 不在这里抛的话，调用方会拿到"渲染成功但图上没有这条线"。
    failShape(
      layer,
      `线长为零（方向 ${dir}，盒子 ${layer.w}×${layer.h}）——`
      + '零长度的线在 canvas 里不产生任何像素，该层等于没画',
    );
  }

  ctx.strokeStyle = layer.fill.length > 0 ? layer.fill : FALLBACK_FILL;
  ctx.lineWidth = lineWidthOf(dir, layer.w, layer.h, layer.stroke);
  ctx.stroke();
}
