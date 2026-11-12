/**
 * 图片图元的绘制实现 —— 在 `[0,0,w,h]` 这个盒子里把 `ImageLayer` 画出来。
 *
 * 引擎在调用本函数之前已经做完**平移 + 旋转 + 透明度**，所以这里的原点就是图层
 * 左上角，不需要（也不许）再做任何缩放；`opacity` 引擎已经乘过，**不许再乘一次**。
 *
 * 贴图数学（源矩形裁切量）在 `fit.ts`，本文件只管「状态管理与失败可见性」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 本文件重点防的是两格「静默失败」
 * ════════════════════════════════════════════════════════════════════════════
 * ① `ctx.filter` 是**状态**不是一次性参数。用完不复位 ⇒ 后面**所有**图层都继承
 *    这层的滤镜。这类 bug 在"图片是最后一个图层"时完全看不出来，只有在它上面
 *    还有文字/形状时才显形 —— 所以这里**显式复位**，不依赖 `restore()` 的隐式恢复。
 * ② 图片没加载出来 ⇒ 必须**先画占位、再让调用方可观测**（见下一节）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 渲染器没有诊断通道，怎么「让调用方可观测」
 * ════════════════════════════════════════════════════════════════════════════
 * `RenderEnv` 只有 `width/height/resolveImage/exportMode`，没有回传诊断的口子。渲染器唯一能把
 * "我没画出来"送达 `renderDoc` 的通道就是**抛异常**（`render.ts` 逐层 try/catch
 * 把它转成 `draw-threw` 诊断）。所以本文件的策略分两档，界线是**有意还是失败**：
 *   · **有意占位**（`placeholder === true` 或 `src` 为空）⇒ 画占位框，**不抛**。
 *     这是合法状态（套模板走的就是这条路），报错会把正常流程变成噪声。
 *     **但导出模式（`env.exportMode === true`）下一律零绘制** —— 见下面 `drawImageLayer`
 *     里的逐条对齐说明；占位框是给编辑者看的提示，不是成品的一部分。
 *   · **加载失败**（`src` 非空但 `resolveImage()` 返回 null）⇒ **先画占位框，再抛**。
 *     "先画"保证用户看得见图该在哪；"再抛"保证调用方拿到诊断、不会以为导出成功。
 *     ⚠ 这一档**不看导出模式**：加载失败是错误状态，必须响亮。让引擎在导出时
 *     静默画一张缺图的成品，比让调用方看到非空诊断更难发现。
 *
 * 「先画后抛」的顺序是关键，两种偷懒都不行：
 *   · 只抛不画 ⇒ 用户看到一片空白，不知道为什么；
 *   · 只画不抛 ⇒ 静默成"图没加载出来但流程显示成功"，正是本仓最恨的形态。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么圆角复用 `../geometry/path` 的 `roundRectPath()`
 * ════════════════════════════════════════════════════════════════════════════
 * 圆角半径要夹到 `[0, min(w,h)/2]`（超出会让 `arcTo` 自交、画出畸形轮廓）。
 * 那份夹紧逻辑在几何模块里已经写好并被断言守着，这里再抄一遍就会出现
 * "矩形的圆角被夹了、图片的圆角没夹"这种只在一种图元上显形的偏差。
 * 只 import 那一个文件（不是 `geometry/index.ts`）⇒ 不会顺带注册形状渲染器。
 */

import type { Layer } from '../model/layer';
import { isImageLayer } from '../model/layer';
import { filtersToCss } from '../model/filters';
import type { LayerDrawFn } from '../engine/registry';
import { registerLayerRenderer } from '../engine/registry';
import { roundRectPath } from '../geometry/path';
import { fitRectFor, intrinsicSizeOf } from './fit';
import { drawImagePlaceholder } from './placeholder';


/**
 * 图片渲染器专用的错误类型。
 *
 * 单独一个类而不是 `new Error(...)`：`render.ts` 的 `describeError()` 会把
 * `err.name` 拼进诊断 detail，所以诊断里能直接看出是图片渲染器报的，
 * 而不是"某处 Error"。带 `layerId` 是为了让调用方不必从 detail 文本里抠 id。
 */
export class ImageDrawError extends Error {
  readonly layerId: string;

  constructor(layerId: string, message: string) {
    super(message);
    this.name = 'ImageDrawError';
    this.layerId = layerId;
  }
}

/**
 * 画一个图片层。契约见 `engine/registry.ts`：进入前变换与透明度已就绪，
 * 只需要在 `[0,0,w,h]` 里画。
 *
 * @throws ImageDrawError 收到非图片图层、或图片加载/尺寸/几何任一环节不可用时
 *   （**抛之前一定已经画过占位框**，见文件头"先画后抛"）
 */
export const drawImageLayer: LayerDrawFn = (
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  env,
): void => {
  // 接线 bug 要可观测：`render` 按 type 查表，传错类型说明注册表被污染了。
  if (!isImageLayer(layer)) {
    throw new ImageDrawError(layer.id, `图片渲染器收到 type="${layer.type}" 的图层`);
  }

  // ★ 盒子退化（w<=0 / h<=0 / 非有限数）⇒ **必须最先判，先于占位分支**。
  // 这格我错过两次，第二次是真 bug（2026-11-02，由 eng-poster-layers 的
  // 「image 不保证报错」引出实测）：
  //   ① 无条件画占位框再抛 —— 占位框走 roundRectPath，对 0 面积返回 false
  //      ⇒ 一个像素都没画，"先画后抛"是假承诺。
  //   ② 补了守卫但**放在占位分支之后** ⇒ 占位分支先 return，守卫根本没执行：
  //      `placeholder:true && w=0` 与 `src:'' && w:0` **不抛、零绘制、零诊断**。
  //      实测 `占位 w=0 → 抛:null, paint:[]`；renderDoc 拿到 0 条诊断 ⇒ 对外宣称
  //      "全部画出来了"，而那一层什么都没画 —— 本仓最恨的形态。
  // 为什么不在占位分支里各加一遍：三处重复判据、改一处漏两处，正是"同一条理由存多份
  // 副本"的坑。**守卫只此一处，且必须在所有 return 之前。**
  // 为什么不硬画 1px 标记凑承诺：那等于谎报几何。0 面积就是无物可画，唯一诚实的
  // 通道是抛（render.ts 转 draw-threw 诊断）。
  if (!Number.isFinite(layer.w) || !Number.isFinite(layer.h) || layer.w <= 0 || layer.h <= 0) {
    throw new ImageDrawError(
      layer.id,
      `图片盒子的面积为 0（${String(layer.w)}×${String(layer.h)}），`
      + '占位框也无处可画，这一层完全不出现 —— 正常路径下 normalize 会夹到下限 8',
    );
  }

  // ── 有意占位：不 resolve、不抛 ──
  // 注意：走到这里 `w/h` 已保证是有限正数 ⇒ `drawPlaceholder` 内部必然能画出框，
  // "画了占位框"这个说法在这一行是**可验证的事实**，不是承诺。
  const src = layer.src.trim();
  if (layer.placeholder === true || src === '') {
    // 与回退路径 `PosterStudio.jsx:711-716` 逐条对齐（少一条就会把虚线框写进成品）：
    //   · 只有「有意占位」（`placeholder === true`）的层才画虚线框；
    //     空 src 但**没标** placeholder 的层两种模式下都什么都不画
    //     （旧实现同一条 if 分支里 return，此处不许"顺手"给它补一个框）；
    //   · 导出模式（`env.exportMode === true`）一个像素都不画 ——
    //     否则虚线框和「放医生照片」四个字会被烙进用户要发出去的海报。
    //     `!== true` 而不是 `=== false`：缺省（undefined）必须等于预览模式，
    //     否则所有只传 width/height/resolveImage 的既有调用点会突然什么都不画。
    if (layer.placeholder === true && env.exportMode !== true) {
      drawImagePlaceholder(ctx, layer, false);
    }
    return;
  }

  // ── 加载失败：先画占位，再抛（双通道）──
  const source = env.resolveImage(src);
  if (source === null) {
    drawImagePlaceholder(ctx, layer, true);
    throw new ImageDrawError(
      layer.id,
      `图片没有加载成功（resolveImage 返回 null），src 前 48 字符 "${src.slice(0, 48)}"`
      + ' —— 已画占位框，这一层不会出现在导出结果里',
    );
  }

  // 走到这里 `w/h` 已由函数开头的守卫保证是有限正数 —— 所以下面 `fitRectFor`
  // 返回 null **只可能**是因为位图内在尺寸读不出（不是盒子问题），消息也只说这个。
  const size = intrinsicSizeOf(source);
  const rect = size === null
    ? null
    : fitRectFor(size.width, size.height, layer.w, layer.h, layer.fit);
  if (rect === null) {
    const measured = size === null
      ? '读不出'
      : `${String(size.width)}×${String(size.height)}`;
    drawImagePlaceholder(ctx, layer, true);
    throw new ImageDrawError(
      layer.id,
      `图片素材无法用于计算贴图（内在尺寸 ${measured}，`
      + `盒子 ${String(layer.w)}×${String(layer.h)}，fit=${layer.fit}）—— 已画占位框`,
    );
  }

  // ── 正式绘制 ──
  ctx.save();
  const previousFilter = ctx.filter;
  try {
    // 圆角裁剪必须在 drawImage 之前，靠 save/restore 保证裁切区域不外溢。
    if (layer.radius > 0 && roundRectPath(ctx, layer.w, layer.h, layer.radius)) {
      ctx.clip();
    }
    ctx.filter = filtersToCss(layer.filters);
    ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
  } finally {
    // 显式复位（不依赖 restore 的隐式恢复）：`ctx.filter` 漏复位会让**后面所有
    // 图层**都被染上这层的滤镜，而"图片是最后一个图层"时这个 bug 完全看不出来。
    ctx.filter = previousFilter;
    ctx.restore();
  }
};

/**
 * 模块加载即注册。
 *
 * 与 `geometry/draw.ts`、`text/draw.ts` 同一个约定：注册放在模块顶层 ⇒
 * 「谁 import 了本模块」就是接线本身，不存在"忘了调 init()"这一步。
 * 漏注册的失败形态是"这一层静默不画"（`render.ts` 的 `missing-renderer` 诊断），
 * 而这正是本模块存在的理由 —— 截至接线完成前，图片层一直没人能画。
 *
 * ⚠ 本模块**必须**被装配根（`src/poster/index.ts`）import，否则注册不生效。
 *   `unit-poster-canvas.mjs` 里有一条断言守着 `registeredKinds()` 含 `'image'`。
 */
registerLayerRenderer('image', drawImageLayer);
