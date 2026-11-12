/**
 * 图片层的**占位绘制** —— 虚线圆角框 + 居中文字。
 *
 * 从 `draw.ts` 拆出来的理由只有一条，但很硬：`draw.ts` 在加完退化守卫和
 * "消息不许撒谎"的注释后到了 **248 行**，距单文件 250 行上限只剩 2 行
 * （`unit-ts-strict.mjs` 的 [4/4] 会判红）。eng-poster-layers 提醒过两次
 * （他自己被同一条门禁拦过）。**贴上限的状态本身就是隐患**：下次任何人加一行
 * 注释都会红，而那时他会倾向于压缩注释而不是拆文件。
 *
 * 顺带收益：占位绘制是**纯视觉**的一坨（全是 fillStyle / font / 虚线），
 * 和"要不要画 / 画不画得出来"的判定逻辑混在一起时，改配色要翻过整段决策代码。
 * 拆开后 `draw.ts` 只剩决策，这个文件只剩外观。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么本文件不 import `text/draw.ts` 的 `FONT_STACK`
 * ════════════════════════════════════════════════════════════════════════════
 * 那个模块**顶层会调用** `registerLayerRenderer('text', …)`。import 它的常量等于
 * 顺手把文字渲染器也注册了 —— "import 图片占位模块却顺带注册了文字渲染器"
 * 是没人能猜到的副作用。占位文字只是提示，不需要与正文排版同一栈，但必须含
 * 中文字体（否则"图片"两个字会渲染成豆腐块）。
 */

import type { ImageLayer } from '../model/layer';
import { roundRectPath } from '../geometry/path';

/** 占位框的底色（极淡，压在深色底上也看得出"这里有一块"）。 */
const PLACEHOLDER_FILL = 'rgba(127, 127, 127, 0.10)';
/** 占位虚线 / 文字色。 */
const PLACEHOLDER_LINE = 'rgba(127, 127, 127, 0.85)';
/** 占位虚线：10 实 6 空，足够疏、在小图层上也认得出是"占位"而不是实线框。 */
const PLACEHOLDER_DASH = [10, 6];
/** 占位框线宽。 */
const PLACEHOLDER_LINE_WIDTH = 2;
/**
 * 占位文字用的字体栈（含中文字体，理由见文件头）。
 * 与 `text/draw.ts` 的 `FONT_STACK` 是**两份独立的值**，不是副本 ——
 * 占位提示的字形与正文排版没有一致性要求。
 */
const PLACEHOLDER_FONT_STACK = '"PingFang SC", "Microsoft YaHei", sans-serif';

/** 占位框上写什么字。`failed` 时说明是"没加载出来"，与"还没放图"区分开。 */
export function placeholderLabelOf(layer: ImageLayer, failed: boolean): string {
  const custom = layer.placeholderLabel.trim();
  if (!failed) return custom === '' ? '图片' : custom;
  return custom === '' ? '图片加载失败' : `${custom}（加载失败）`;
}

/**
 * 画占位：虚线圆角框 + 居中文字。
 *
 * **调用前提（由 `draw.ts` 保证）**：`layer.w` / `layer.h` 必须是有限正数。
 * 因为本函数靠 `roundRectPath(w, h, …)` 出框，而它对 0 面积盒子返回 `false`
 * ⇒ 会**一个像素都不画**却也不报错。0 面积那格由 `draw.ts` 的退化守卫先抛掉
 * （那是我 `f3980ae` 修的真 bug：守卫曾放在占位分支之后，于是 `w=0` 的占位层
 * 静默什么都不画，`renderDoc` 拿到 0 条诊断）。
 *
 * 整体包在 `save/restore` 里：`fillStyle` / `strokeStyle` / `lineWidth` /
 * `font` / `textAlign` / `textBaseline` / 虚线 全是上下文级状态，漏恢复会让
 * **后面所有图层**继承这一层的样子（文字变灰、变中号、带上虚线）。症状出现在
 * 下一个图元上，极难归因到"图片占位没恢复状态"。
 *
 * @param failed 是"加载失败"（true）还是"有意占位"（false）
 */
export function drawImagePlaceholder(
  ctx: CanvasRenderingContext2D,
  layer: ImageLayer,
  failed: boolean,
): void {
  ctx.save();
  try {
    // ── 框（填充 + 虚线描边）──
    if (roundRectPath(ctx, layer.w, layer.h, layer.radius)) {
      ctx.fillStyle = PLACEHOLDER_FILL;
      ctx.fill();
      ctx.setLineDash(PLACEHOLDER_DASH);
      ctx.lineWidth = PLACEHOLDER_LINE_WIDTH;
      ctx.strokeStyle = PLACEHOLDER_LINE;
      ctx.stroke();
      // 显式收回虚线：`restore()` 也会恢复它，但让"我设过的状态我都收回了"
      // 在代码里看得见，比依赖读者记住 restore 的语义更可靠。
      ctx.setLineDash([]);
    }

    // ── 文字（单独一层 save/clip：长 label 不许溢出盒子）──
    ctx.save();
    try {
      if (!roundRectPath(ctx, layer.w, layer.h, layer.radius)) return;
      ctx.clip();
      // 字号按短边比例给，并夹在 [10,48]：小缩略图上不至于糊成一团，
      // 大图上也不至于变成一行占满的巨型字。
      const fontSize = Math.max(10, Math.min(48, Math.min(layer.w, layer.h) * 0.12));
      ctx.font = `500 ${String(fontSize)}px ${PLACEHOLDER_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = PLACEHOLDER_LINE;
      ctx.fillText(placeholderLabelOf(layer, failed), layer.w / 2, layer.h / 2);
    } finally {
      ctx.restore();
    }
  } finally {
    ctx.restore();
  }
}
