/**
 * 闭合**盒子形状**的路径构造：圆角矩形、椭圆。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 这一层只管一件事：把路径铺到 `ctx` 上
 * ════════════════════════════════════════════════════════════════════════════
 * 本文件**不调用** `fill()` / `stroke()`，也**不读** `layer.fill` / `layer.stroke`。
 * 理由：填充与描边是**策略**（描不描、用什么色、线宽多少、线的 fill 当 stroke 色用），
 * 而路径是**几何**。混在一起时，加一种新形状就要重写一遍"要不要描边"的判断，
 * 而那段判断一旦两边写得不一样，就会出现「矩形有描边、多边形没描边」这种
 * 只在某一种图元上出现的怪现象。所以：路径归这里，策略归 `draw.ts`。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么线 / 多边形不在这里（`polyline.ts`）
 * ════════════════════════════════════════════════════════════════════════════
 * 两者的输入形状不同：盒子形状只吃「宽、高」两个数，顶点形状吃一串坐标。
 * 放一起会同时撑爆单文件规模上限（`unit-ts-strict.mjs`：[4/4] 250 行 ⇒ 判红，
 * 本文件第一版 291 行就是被这条门禁拦下来的），也会让"我要找线怎么画的"
 * 必须先读完矩形。按**输入形状**分文件是这条边界最自然的落法。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 坐标系（与 `engine/registry.ts` 的约定一致，不要另立一套）
 * ════════════════════════════════════════════════════════════════════════════
 * 原点 = **图层左上角**，未旋转、未缩放。所有路径都在 `[0,0,w,h]` 这个盒子里构造。
 * 引擎在调用绘制函数之前已经做了「平移 + 旋转 + 透明度」，所以这里：
 *   · 不接收 `x` / `y`（坐标永远是 0 起点）
 *   · 不做 `ctx.rotate()` / `ctx.scale()`
 * 现有 JS 实现（`PosterStudio.jsx:279` 的 `roundRectPath`）收 `x/y` 是因为它
 * 把"定位"和"画"揉在一起；新引擎把定位交给变换矩阵，这里就只剩尺寸。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么每个函数都返回 `boolean`
 * ════════════════════════════════════════════════════════════════════════════
 * 非法几何（宽高为 0、坐标是 NaN）在 canvas 里的失败形态是**静默的**：
 *   · `fill()` 照常返回，什么都不画，不抛错；
 *   · 导出的 PNG 是空白的，但控制台一个字都没有；
 * 这类 bug 的定位成本远高于一个返回值。所以这里的契约是：
 *   **返回 false = 路径没有成立（且没有任何 ctx 调用）**，由调用方决定怎么记录诊断。
 * 反过来，`true` 也不代表"用户看得见"（比如 1×1 的矩形），它只代表"路径是合法的"。
 */

import { isUsableBox } from './guards';

/**
 * 把圆角半径夹进**上下界都有效**的区间。
 *
 * ★ 这是与现有实现**有实质差别**的地方，也是必须抽成独立函数的原因。
 *   现有 `roundRectPath`（`PosterStudio.jsx:280`）写的是
 *   `Math.max(0, Math.min(r, Math.min(w, h) / 2))` —— 上界其实夹了，
 *   但真正的洞是**非有限数**：`Math.min(NaN, 25)` = `NaN`，`Math.max(0, NaN)` = `NaN`，
 *   而 `NaN <= 0` 是 false ⇒ 现有实现会**跳过直角分支**、带着 `NaN` 半径去调
 *   `arcTo`。canvas 对 `NaN` 参数的处理是**整条子路径被丢弃**（不抛错），
 *   画出来是空白 —— 导出图空白且没有任何报错。
 *
 *   三种非有限数的处理**故意不同**，不是"统一兜底成 0"：
 *     · `NaN`       ⇒ 0（没有意义的输入，退到直角；直角至少画得出东西）
 *     · `+Infinity` ⇒ 上界（语义就是"尽可能圆"，`Math.min` 天然给出短边一半）
 *     · `-Infinity` ⇒ 0（负半径，与 `radius < 0` 同一条分支）
 *   统一兜底成 0 会把 `radius: Infinity`（存档里除零算出来的值，本意显然不是
 *   "直角"）画成尖角 —— 那种"改动幅度极大但没人报错"的结果更难查。
 *
 * 上界取 `min(w, h) / 2` 而不是更小的值：半径等于短边一半时矩形退化成"胶囊"
 * （两段直边长度为 0），这是合法的；再大 `arcTo` 就会自交，画出畸形轮廓。
 *
 * @param w 盒子宽（> 0）
 * @param h 盒子高（> 0）
 * @param radius 期望半径（可能来自 UI 输入 / 存档，不做有效性假设）
 * @returns 夹在 `[0, min(w,h)/2]` 的半径；盒子无效时返回 0
 */
export function clampRoundRadius(w: number, h: number, radius: number): number {
  const halfShort = Math.min(w, h) / 2;
  if (!Number.isFinite(halfShort) || halfShort <= 0) return 0;
  if (Number.isNaN(radius)) return 0;
  // `radius <= 0` 同时吃掉负数与 `-Infinity`；`+Infinity` 落到下面被 `Math.min` 夹住。
  if (radius <= 0) return 0;
  return Math.min(radius, halfShort);
}

/**
 * 圆角矩形路径（原点在左上角）。
 *
 * `radius = 0` 时**退化成直角矩形**（`moveTo` + 3 个 `lineTo` + `closePath`），
 * 而不是"什么都不画"—— 现有实现就是这个语义，改了会让所有 radius=0 的
 * 模板色块消失。
 *
 * @param ctx 2D 上下文（引擎已设好变换）
 * @param w 宽（> 0）
 * @param h 高（> 0）
 * @param radius 圆角半径；非法/超界由 `clampRoundRadius` 处理
 * @returns 路径是否成立（`false` 时**一次 ctx 调用都没发生**）
 */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  radius: number,
): boolean {
  if (!isUsableBox(w, h)) return false;
  const r = clampRoundRadius(w, h, radius);

  ctx.beginPath();
  if (r <= 0) {
    // 直角分支：仍要画，不能"没有圆角所以跳过"。
    ctx.moveTo(0, 0);
    ctx.lineTo(w, 0);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    return true;
  }

  // 顺时针一圈：上边 → 右上角 → 右边 → 右下角 → 下边 → 左下角 → 左边 → 左上角。
  // 每个角用 `arcTo(拐点, 出点, r)`：入点是上一段 lineTo 的终点，所以不用重复写。
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.arcTo(w, 0, w, r, r);
  ctx.lineTo(w, h - r);
  ctx.arcTo(w, h, w - r, h, r);
  ctx.lineTo(r, h);
  ctx.arcTo(0, h, 0, h - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  return true;
}

/**
 * 椭圆路径：中心在盒子中心，横纵半径分别是 `w/2`、`h/2`。
 *
 * 为什么用 `ellipse()` 而不是 `arc()` + 缩放：
 *   · `arc()` 只能画正圆，画椭圆必须 `save() + scale() + restore()`，
 *     而 `scale()` 会同时把**线宽**拉扁 —— 描边宽度在横竖两个方向不一致，
 *     一条 2px 的描边在长轴上会变成 3px、短轴上变 1.5px。
 *   · `ellipse()` 在 Chromium 里一直可用（Electron 31 = Chromium 126），
 *     没有兼容性理由退回 `arc()`。
 *
 * @param ctx 2D 上下文
 * @param w 宽（> 0）
 * @param h 高（> 0）
 * @returns 路径是否成立
 */
export function ellipsePath(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  if (!isUsableBox(w, h)) return false;
  const rx = w / 2;
  const ry = h / 2;
  ctx.beginPath();
  // 旋转角 0、起止角 0 → 2π（顺时针整圈）。
  ctx.ellipse(rx, ry, rx, ry, 0, 0, Math.PI * 2);
  ctx.closePath();
  return true;
}
