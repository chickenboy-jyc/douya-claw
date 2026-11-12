/**
 * 图层渲染器注册表 —— canvas 引擎与各图元模块之间的**唯一接口**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么要有这一层
 * ════════════════════════════════════════════════════════════════════════════
 * 现状：`PosterStudio.jsx:793` 是一串 if/else
 * （`if (layer.type === 'shape') drawShapeLayer(...)`），所有图元的绘制逻辑
 * 和调度逻辑长在**同一个文件**里（2318 行）。这带来两个具体后果：
 *   · 加一种新图元（椭圆、线、多边形）必须改主渲染函数 ⇒ 每次都在动高风险代码
 *   · 渲染顺序 / 旋转 / 透明度 / 裁剪这些**横切**逻辑与"怎么画一个矩形"混在一起
 *
 * 这里的做法：调度（`engine/render.ts`）不认识任何具体图元，只查表；
 * 各图元模块自己 `registerLayerRenderer()`。加新图元 = 加一个文件 + 一次注册，
 * **不改调度逻辑**。这也是老板要求的「不要一个文件里挤一堆代码」在渲染层的落法。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么用 Map 而不是一个大 switch
 * ════════════════════════════════════════════════════════════════════════════
 * switch 要求调度方**知道所有分支**（穷尽性检查是优点，也是耦合）。
 * 而图元种类会随几何/画笔模块扩张，调度方不该每次跟着改。
 * 代价是：忘了注册不会编译报错 ⇒ 所以 `render()` 里**必须**对
 * "查不到渲染器"显式记录一条诊断（不是静默跳过），见 `MissingRenderer`。
 */

import type { Layer, LayerKind } from '../model/layer';

/**
 * 渲染一层时需要的画布上下文信息。
 *
 * 刻意只放三样东西：
 *   · `width/height` —— 图层之外的坐标参考（阴影偏移、描边不被裁掉的安全距离）
 *   · `resolveImage` —— 图片层的位图来源。**必须是同步返回**，
 *     因为 canvas 绘制是同步的；异步加载由引擎在 render 之前预取完成。
 *   · `exportMode` —— 「这次渲染是导出还是预览」。**第三样必须放这里**，理由见字段注释：
 *     它描述的是**这一次渲染**的性质，不是图层自身的数据。
 *
 * 不放 dpr / scale：那两者已经被引擎乘进 `ctx.setTransform()`，
 * 图元代码**不应该**再自己做任何缩放 —— 这是"图元只管画、引擎管缩放"的分界。
 */
export interface RenderEnv {
  readonly width: number;
  readonly height: number;
  /** 已解码的位图；没加载好返回 null（渲染器要画占位而不是抛错）。 */
  readonly resolveImage: (src: string) => CanvasImageSource | null;
  /**
   * 导出模式：`true` 时**有意占位**的图片层一个像素都不画（见 `image/draw.ts`）。
   * 缺省 / `false` = 预览模式，画虚线占位框提示用户这里要放图。
   *
   * ★ 为什么放在 env 而不是做成图层字段：图层字段会被 `normalize` 落进存档，
   *   于是**同一份存档在预览与导出时无法区分** —— 那正是回退路径把 `forExport`
   *   放在 `opts` 而不是 layer 上的原因（`PosterStudio.jsx:754-765`）。
   *   放进存档还会有一个更坏的后果：用户存盘时恰好在导出，存档里就永久带上
   *   `exportMode: true`，之后每次预览都看不到占位框、也说不清是哪一步弄丢的。
   *
   * ★ 必须是**可选**字段（`?:`），不是必填：现有调用点（GUI 预览、缩略图、
   *   `unit-poster-*` 的断言）都只传 `width/height/resolveImage`，
   *   改成必填会连锁改十几个文件并让既有测试一起变红。缺省语义 = 预览模式。
   */
  readonly exportMode?: boolean;
}

/**
 * 图元绘制函数。
 *
 * 入参 `layer` 是**判别联合的宽类型**，因为注册表按 `kind` 分发后
 * 已经没有类型信息了。各实现在函数体内用 `isTextLayer()` / `isShapeLayer()`
 * 收窄 —— 这是刻意的：**收窄只发生一次，且发生在真正要用字段的地方**。
 *
 * 约定（引擎保证，图元不必重复做）：
 *   · 进入前 `ctx` 已经应用了 **平移 + 旋转 + 透明度**
 *   · 传入的坐标系原点 = 图层左上角，未旋转、未缩放
 *   · 图元只需要在 `[0,0,w,h]` 这个盒子里画
 */
export type LayerDrawFn = (
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  env: RenderEnv,
) => void;

const registry = new Map<LayerKind, LayerDrawFn>();

/**
 * 注册 / 覆盖某个图元的渲染器。
 *
 * 允许覆盖（不抛"重复注册"）：开发热更与测试替身都需要它。
 * 但**覆盖是可观测的** —— `registeredKinds()` 在诊断里会体现最终态，
 * 所以"谁覆盖了谁"在排查时看得见。
 */
export function registerLayerRenderer(kind: LayerKind, draw: LayerDrawFn): void {
  registry.set(kind, draw);
}

/** 取渲染器；没注册返回 `null`（**调用方必须处理**，不许当成功）。 */
export function getLayerRenderer(kind: LayerKind): LayerDrawFn | null {
  return registry.get(kind) ?? null;
}

/** 已注册的图元种类，按固定顺序返回（诊断与断言用，避免 Set 迭代顺序带来的抖动）。 */
export function registeredKinds(): LayerKind[] {
  const all: LayerKind[] = ['text', 'image', 'shape'];
  return all.filter((kind) => registry.has(kind));
}

/**
 * 清空注册表 —— **只给测试用**。
 *
 * 生产代码里调用它会让后续所有渲染都画成空白，
 * 而且因为 `render()` 对缺失渲染器只记录诊断不抛错，症状会是
 * "导出的图是空白的但没有任何报错"。这类"静默变空"是本仓反复踩过的坑，
 * 所以这里从命名到注释都标死用途。
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
