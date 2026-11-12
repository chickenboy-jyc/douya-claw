/**
 * 渲染调度器 —— canvas 引擎的**唯一入口函数**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 它负责什么 / 不负责什么
 * ════════════════════════════════════════════════════════════════════════════
 * 负责（**横切**逻辑，所有图元都一样）：
 *   ① 铺底（`doc.background`）
 *   ② 叠放顺序（按 `z` 升序，同 `z` 按数组顺序）
 *   ③ 跳过 `hidden`
 *   ④ 平移 + 绕自身中心旋转 + 水平/垂直翻转 + 透明度
 *   ⑤ 查渲染器；查不到 ⇒ 记诊断（**不许静默跳过**）
 *   ⑥ 数值守卫：NaN / Infinity ⇒ 不画 + 记诊断（见 `layerGuard.ts`）
 * 不负责（**图元各自**的事）：
 *   怎么画一个矩形 / 一行文字 / 一张图 —— 全在 `registerLayerRenderer()` 注册的实现里。
 *
 * 这条分界的收益是具体的：加一种新图元（椭圆、多边形、箭头）只需要新写一个
 * 渲染器并注册，**这个文件一行都不用改**，也就不会动到 ②③④⑤⑥ 这些所有图元共用的
 * 高风险代码。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 图层几何变换（平移 / 旋转 / 翻转）不在本文件
 * ════════════════════════════════════════════════════════════════════════════
 * 那四个 `ctx` 调用，连同「为什么必须是 translate → rotate → scale → translate」
 * 和「翻转为什么能原地翻」的验算，全部在 `engine/transform.ts`。
 * 本文件只负责**在正确的位置调用它**，以及 save/restore 的配对。
 *
 * 为什么值得拆成两个文件：两者的失效方式完全不同 ——
 * 调度错了表现为"某层没画 / 叠放顺序不对"，会产出诊断；
 * 几何错了表现为"画出来了但位置或朝向不对"，**不产出任何诊断**（坐标系算错不抛错）。
 * 混在一个文件里，后者的不变量就永远只能被"顺带"测到。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 硬约定（跨模块，调用方必须遵守）
 * ════════════════════════════════════════════════════════════════════════════
 * **`renderDoc` 返回的诊断数组非空 = 有层没画出来。**
 * 调用方（导出 / 预览 / GUI）**必须**检查它，非空时不许对外宣称"导出成功"。
 *
 * 这条约定是"捕获异常"换来的代价，必须显式：图元渲染器内部抛的异常不会以
 * 异常形式冒到调用方（那样一层崩就会让整幅图变白），而是变成一条
 * `draw-threw` 诊断。同理数值非法的层变成 `non-finite-field` 诊断、
 * 未注册的图元变成 `missing-renderer` 诊断。**三种都是"这层没画"**，
 * 忽略返回值就等于把所有的失败都默认成成功。反过来说：**空数组是唯一的
 * "全部画出来了"信号**，这也是它唯一的用法。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么 alpha 用 `*=` 而不是 `=`
 * ════════════════════════════════════════════════════════════════════════════
 * 本函数会被**嵌套**调用：图层缩略图、分组预览、"整幅海报作为一个图层塞进
 * 另一份文档"这些场景里，外层已经把 `ctx.globalAlpha` 设成 0.5 了。
 * 写成 `ctx.globalAlpha = layer.opacity` 会把外层的 0.5 覆盖掉 ⇒ 缩略图比
 * 主画布**更不透明**，而这种不一致只在特定路径下出现，测试很容易漏。
 */

import type { Layer, LayerKind } from '../model/layer';
import type { PosterDoc } from '../model/doc';
import type { RenderEnv } from './registry';
import { getLayerRenderer } from './registry';
import { describeNonFiniteField, findNonFiniteField } from './layerGuard';
import { applyLayerTransform } from './transform';

/**
 * 图层没被画出来的原因。
 *
 * 只有"失败"进诊断：`hidden` 是**有意的**跳过，不算失败。这一点是刻意的 ——
 * 一份文档里常有十几层是隐藏的，每帧都给它们发诊断会把真正的错误淹掉。
 */
export type RenderDiagnosticReason =
  /** 该 `type` 没有任何渲染器注册（忘了注册 / type 拼错 / 新图元还没实现）。 */
  | 'missing-renderer'
  /** 渲染器抛了异常（图元实现里的 bug，或 env 里的数据不合法）。 */
  | 'draw-threw'
  /**
   * 某个数值字段是 NaN / Infinity。这类值在 canvas 上**不会抛错**：
   * `globalAlpha = NaN` 被静默忽略，`translate(NaN, y)` 让整条矩阵变 NaN
   * ⇒ 该层一个像素都不落。所以必须在绘制前拦下并报出来（见 `layerGuard.ts`）。
   */
  | 'non-finite-field';

/**
 * 一条"第 N 层没画出来"的诊断。
 *
 * `layerIndex` 是**原始 `doc.layers` 数组下标**，不是绘制顺序里的序号：
 * 调用方要拿它回数组里定位（图层面板的选中态按下标记）。绘制顺序随 `z`
 * 变化，用它定位会指错层。
 */
export interface RenderDiagnostic {
  readonly layerIndex: number;
  readonly layerId: string;
  readonly layerType: LayerKind;
  readonly reason: RenderDiagnosticReason;
  /** 人读的细节（错误消息 / 缺哪个 kind）。不要拿它做分支判断。 */
  readonly detail: string;
}

/** 排好序的一层 + 它在原数组里的下标。 */
interface OrderedLayer {
  readonly layer: Layer;
  readonly index: number;
}

/** 把 `unknown` 异常转成一行可读文本。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message === '' ? err.name : `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * `z` 的分档：0 = 有限数（正常参与排序），1 = 非有限数（已被守卫判为不画）。
 * 为什么不直接把 `NaN` 当 0 比较（旧写法，已推翻）：`NaN - 5` 仍是 `NaN`，
 * 比较器返回 NaN 时规范只说"当作 0"、实测不同引擎给出不同顺序 ⇒ 叠放顺序会飘。
 * 分档后比较器里**永远不出现 NaN**，坏 `z` 的层统一排最后（反正也不画）。
 */
function zRankOf(layer: Layer): number {
  return Number.isFinite(layer.z) ? 0 : 1;
}

/**
 * 计算绘制顺序。
 *
 * 按 `z` 升序（大的在上 ⇒ 后画）；`z` 相同按**原数组顺序**（后者在上）。
 *
 * 为什么显式用 `index` 做次级键而不依赖 `Array.prototype.sort` 的稳定性：
 * 稳定性在 ES2019 之后才进规范，而"稳定"这件事**恰好是本逻辑的语义要求**
 * （同层高时上层关系由用户拖动决定，必须可复现）。多一个整数比较的代价
 * 可以忽略，换来的是这个函数在任何引擎上都给出同一个顺序。
 */
function drawOrderOf(layers: readonly Layer[]): OrderedLayer[] {
  const rows: OrderedLayer[] = layers.map(
    (layer: Layer, index: number): OrderedLayer => ({ layer, index }),
  );
  rows.sort((a: OrderedLayer, b: OrderedLayer): number => {
    const rankA = zRankOf(a.layer);
    const rankB = zRankOf(b.layer);
    if (rankA !== rankB) return rankA - rankB;
    // 两层的 z 都不可用 ⇒ 只按数组顺序，不去碰 NaN 算术
    if (rankA === 1) return a.index - b.index;
    if (a.layer.z !== b.layer.z) return a.layer.z - b.layer.z;
    return a.index - b.index;
  });
  return rows;
}

/**
 * 铺底色。
 *
 * 空串的兜底不是洁癖：`ctx.fillStyle = ''` 是**非法值**，浏览器会**静默忽略**
 * 这次赋值，fillStyle 保持**上一次渲染留下的颜色** —— 症状是"第一次导出正常、
 * 第二次底色变成上一张图的颜色"，这种"第二次才错"最难归因。
 * 透明度刻意**不**重置为 1：嵌套渲染时"整幅海报 50% 透明"是调用方要的效果。
 */
function paintBackground(ctx: CanvasRenderingContext2D, doc: PosterDoc): void {
  const background = doc.background.trim() === '' ? '#ffffff' : doc.background;
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, doc.width, doc.height);
  ctx.restore();
}

/**
 * 把一份文档画到 `ctx` 上。
 *
 * 前置条件（由 `createCanvas` 保证）：`ctx` 的变换已经乘好导出倍率，
 * 所以这里可以直接用**逻辑像素**（`doc.width × doc.height`）画。
 *
 * @param ctx 2D 上下文
 * @param doc 文档
 * @param env 图层之外的渲染环境（尺寸 + 同步的图片解析函数）
 * @returns 诊断列表；**空数组**表示"每一层都画出来了"
 */
export function renderDoc(
  ctx: CanvasRenderingContext2D,
  doc: PosterDoc,
  env: RenderEnv,
): RenderDiagnostic[] {
  const diagnostics: RenderDiagnostic[] = [];
  paintBackground(ctx, doc);

  for (const row of drawOrderOf(doc.layers)) {
    const { layer, index } = row;

    // hidden 是有意跳过 ⇒ 不记诊断（见 RenderDiagnosticReason 的注释）。
    if (layer.hidden === true) continue;

    // 数值合法性**先于**任何变换与查表：非有限数不许当 0 用掉（那等于把错误吞了），
    // 该层不画 + 一条诊断。不拦的话 `translate(NaN,…)` 会让整条矩阵变 NaN ⇒
    // 该层一个像素都不落**且不抛错**（静默变空）。
    const badField = findNonFiniteField(layer);
    if (badField !== null) {
      diagnostics.push({
        layerIndex: index,
        layerId: layer.id,
        layerType: layer.type,
        reason: 'non-finite-field',
        detail: describeNonFiniteField(badField),
      });
      continue;
    }

    const draw = getLayerRenderer(layer.type);
    if (draw === null) {
      // 不静默 continue：忘了注册的表现是"导出的图少了一块但没有任何报错"。
      diagnostics.push({
        layerIndex: index,
        layerId: layer.id,
        layerType: layer.type,
        reason: 'missing-renderer',
        detail: `没有为 type="${layer.type}" 注册渲染器（registerLayerRenderer 未调用）`,
      });
      continue;
    }

    // 在 save 之前读：save/restore 会恢复 globalAlpha，但**不会**告诉我们
    // 进入时它是多少。嵌套渲染时这个值可能不是 1。
    const inheritedAlpha = ctx.globalAlpha;

    ctx.save();
    // 平移 + 旋转 + 翻转 + 搬回左上角，四个调用及其顺序全在 transform.ts。
    // save/restore 留在这里：restore 必须在 finally 里，而 try 在下面。
    applyLayerTransform(ctx, layer);
    // 用 `*=` 语义（读出来的乘上去），不覆盖外层 alpha
    ctx.globalAlpha = inheritedAlpha * layer.opacity;

    try {
      draw(ctx, layer, env);
    } catch (err) {
      // 一层画崩不许让整幅图变白：记诊断，继续画下一层。
      // 代价是异常不再向上冒 —— 所以调用方**必须**消费返回值（非空即异常）。
      diagnostics.push({
        layerIndex: index,
        layerId: layer.id,
        layerType: layer.type,
        reason: 'draw-threw',
        detail: describeError(err),
      });
    } finally {
      // 必须在 finally 里：draw 抛异常时若不 restore，save/restore 就失配，
      // 之后每一层的平移/旋转都会叠在坏状态上（雪崩式错位）。
      ctx.restore();
    }
  }

  return diagnostics;
}
