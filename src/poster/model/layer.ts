/**
 * 海报图层模型 —— 全仓**单一真源**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件
 * ════════════════════════════════════════════════════════════════════════════
 * 在此之前，图层模型只活在 `src/renderer/modules/PosterStudio.jsx` 的
 * `normalizeLayer()`（约 L887）里 —— 那是一段**无类型标注的 JS**，字段靠
 * 字符串拼装（`out.fontSize = ...`）。任何人新增一个字段，既没有编译器
 * 提醒，也没有门禁拦着，只能靠"记得把 normalizeLayer 也改一下"。
 *
 * 这里把**同一套字段**写成显式类型，作为 `src/poster/**` 全部模块的契约。
 * 字段名与 `normalizeLayer` 逐一对齐（2026-11-02 核对），所以：
 *   · 新 TS 引擎产出的图层，可以直接喂给现有 `drawPoster()`
 *   · 现有模板（`posterTemplates.js`）的图层形状，天然满足这里的类型
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 与 JS 侧的唯一差异（刻意的，不是漂移）
 * ════════════════════════════════════════════════════════════════════════════
 * 1. `rotation` 是**新增字段**。现状全仓 `rotate`/`angle` 零命中（grep 实测），
 *    即现有实现**根本没有旋转能力**。老板明确要求「裁剪 旋转 调色」，
 *    所以旋转必须进模型；`normalizeLayer` 侧补默认值 0 即可向后兼容旧存档。
 * 2. `shapeKind` 是**新增字段**。现有 `drawShapeLayer` 只会画圆角矩形
 *    （`PosterStudio.jsx:638-642`，整个函数 5 行：`roundRectPath` + `fill`），
 *    线 / 圆 / 多边形全部为零。几何图元模块要落地，模型上必须先有"形状种类"。
 * 3. `verticalAlign` / `fontFamily` 是**新增字段**（见 `TextLayer` 里的两条注释）。
 *    它们不是"新功能"，而是把**新旧引擎之间唯一两个渲染差异来源**从"写死"变成
 *    "可指定"：垂直对齐口径（贴顶 vs 居中，h=200/72px 单行标题差 49.6px）与
 *    字体栈落地字体（雅黑 vs Segoe UI，同一串西文宽 9%）。逐像素基线实测证明
 *    消灭这两个来源之后新旧引擎差异为 0 ⇒ 它们必须可由数据指定，否则必有一边的
 *    存量海报整体移位。
 *
 * 新增字段都带 `?`（可选）语义吗？—— **不带，必填**。
 * 理由：可选字段会让每个消费方都要处理 `undefined` 分支，而 `normalize*`
 * 一定会补默认值，所以下游拿到的永远是确定值。**默认值只在 normalize 里出现一次。**
 * （`verticalAlign` 的默认值必须是 `'top'`、`fontFamily` 必须是空串 —— 这两个默认值
 * 本身就是"存量海报打开后像素不变"的保证，不是随手取的。）
 */

/**
 * 图层三大类。
 *
 * 为什么没有 'group'：现有实现没有分组能力，加一个渲染路径完全空的类型
 * 只会制造"看起来支持、实际画不出来"的假象。要分组时再加，并且同一次提交里
 * 必须有对应的 `drawGroupLayer`。
 */
export type LayerKind = 'text' | 'image' | 'shape';

/**
 * 所有图层共有的几何与合成属性。
 *
 * 坐标语义（与 `PosterStudio.jsx` 一致，不要另立一套）：
 *   · `x,y` 是**左上角**，单位是画布像素（不是 CSS 像素，也不乘 dpr）
 *   · `w,h` 是未旋转时的外接盒尺寸
 *   · `rotation` 绕**自身中心**顺时针，单位是度
 *
 * 为什么 `rotation` 用度不用弧度：模板作者和 AI 都是按"转 15 度"这种直觉给的，
 * 度是外部接口，弧度只在 `ctx.rotate()` 那一行临时换算。
 */
export interface LayerBase {
  /** 图层唯一 id。生成规则见 `id.ts`，不要用 `Math.random()` 直接拼。 */
  id: string;
  type: LayerKind;
  /** 展示名（左栏图层列表用）。重名允许。 */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0~1。**超出范围**（如 1.5、-0.2）由 `normalize` 夹紧，渲染侧不再判。
   *  ⚠ 但**非有限数**（NaN / Infinity）不是"超范围"，是"非法值"——
   *  渲染侧必须拦并在诊断里报出来，不许当 0 或 1 用掉。
   *  理由：canvas 对 NaN 的 globalAlpha 是**静默忽略**（沿用上一次的值），
   *  对 NaN 的 rotate 是**整层画不出来且不报错**。这类"静默变空"比红更坏。 */
  opacity: number;
  /** 叠放顺序。大的在上。允许同值（用数组顺序兜底）。 */
  z: number;
  hidden: boolean;
  /** 顺时针角度，单位度。0 = 不旋转。
   *  ⚠ NaN 会让 `ctx.rotate()` 把整层画没，且 canvas **不报错**。
   *  所以渲染侧对非有限数必须发诊断并跳过该层（见 `engine/render.ts`）。 */
  rotation: number;
  /**
   * 水平翻转（左右镜像）。`false` = 不翻。
   *
   * ★ 为什么镜像要用**独立布尔字段**，而不是"把 `w` 写成负数"：
   *   `ctx.fillRect(x, y, -50, h)` 确实会镜像着画，但它镜像的是
   *   **`x` 与 `x+w` 之间的区间**，盒子位置跟着变 —— 于是"翻转"会顺带移动图层，
   *   而用户点翻转按钮时预期的是**原地翻**。`ctx.scale(-1, 1)` 绕图层中心镜像，
   *   中心点不动（验算见 `engine/render.ts` 第 ③ 步），才是按钮该有的语义。
   *   两套机制混用还有更坏的后果：变换链里 `translate(x + w/2)` 在 `w<0` 时
   *   就已经偏到反方向，再叠一个 `scale(-1)` 会变成双重镜像（等于没翻）。
   *
   * 实现点在 `engine/render.ts` 的变换链，**四个渲染器不需要各自处理**。
   * 理由：`render.ts` 是所有图元的唯一调度点，它做的变换对所有 kind 自动生效；
   * 若在 `geometry/draw.ts`、`text/draw.ts`、`image/draw.ts` 各写一遍，就是四份
   * 重复逻辑，加第五种图元时必漏（本仓刚因"图片层没人注册渲染器"静默跳过出过一次）。
   */
  flipX: boolean;
  /** 垂直翻转（上下镜像）。`false` = 不翻。语义与实现点同 `flipX`。 */
  flipY: boolean;
}

/** 文字层。字段与 `normalizeLayer` 的 `type === 'text'` 分支逐一对齐。 */
export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  fontSize: number;
  /** `#rrggbb` 或 `#rgb`。不存 CSS 颜色名（导出时避免歧义）。 */
  color: string;
  /** 字重。现有实现只用 400/500/600/700，给任意数值会出现浏览器合成字重。 */
  weight: number;
  align: 'left' | 'center' | 'right';
  /** 行高倍数（不是像素）。 */
  lineHeight: number;
  /** 字间距，像素。 */
  letterSpacing: number;
  /** 0 = 不限行数。 */
  maxLines: number;
  /**
   * 内容在盒子里的**垂直位置**：`'top'` 贴顶 / `'middle'` 居中 / `'bottom'` 贴底。
   *
   * ★ 为什么不能写死成某一个值（这是像素基线实测的结论，不是审美偏好）：
   *   旧引擎是**贴顶**（`PosterStudio.jsx:628` 的 `y + i * step`），而 TS 引擎最初
   *   实现成**居中**（`(boxHeight - blockHeight) / 2`）。同一个 `h=200` 的单行 72px
   *   标题（行距 1.4 ⇒ 行盒高 100.8）在两种口径下整整差 `(200 - 100.8) / 2 = 49.6px`。
   *   写死任何一种，都会让**另一边**的存量海报整体移位 —— 存量海报是已经发出去过的图，
   *   "打开后整块文字下移 50px"是不可接受的回归。
   *   所以它必须是**图层字段**，且默认 `'top'`（= 旧实现行为 ⇒ 存量文件打开后原地不动）。
   *
   * ★ 参与计算的是**行盒总高**（行数 × 行距），不是墨迹高。
   *   与 CSS `line-height` 同口径（实现在 `text/typeset.ts` 的 `verticalOffsetFor`）。
   *   用墨迹高的话，"这一行带下伸部（g/y/p/中文字底）"会让块高比邻行多一两像素，
   *   于是整块文字在换行/改字号时**上下跳** —— 1~2px 的抖动比整体偏移更难查，
   *   因为它只在一部分内容上出现。
   *
   * ★ 内容比盒子高时**钳到 0**（溢出向下发生），**不返回负数**。
   *   不钳的话 `'bottom'` 会返回负数，把首行顶到盒子**外面**，
   *   用户第一眼看到的是"文字没了"，而不是"文字溢出了"。
   */
  verticalAlign: 'top' | 'middle' | 'bottom';
  /**
   * 字体族名，覆盖引擎的默认字体栈。**空串 = 用默认栈**（栈的真源在
   * `text/font-stack.ts` 的 `DEFAULT_FONT_STACK`，与回退路径 `PosterStudio.jsx:100`
   * **字面一致** —— 迁移期两套引擎画同一份 doc，字体一换"字宽（断行点）"与
   * "`textBaseline = 'top'` 用的主字体 ascent（基线）"会同时动，像素基线就失去意义；
   * 逐条实测读数写在那个文件头）。
   *
   * ★ 为什么必须可指定：老板的终极目标是"复刻别人发来的海报"，而**字体是视觉第一要素**。
   *   写死的栈在任何与源图不同字体的机器上都对不上，而"对不上"不报错 ——
   *   它只是"看着像但就是不像"，属于最难自证失败的那一类失败。
   *
   * ★ 非空时拼成 `"<fontFamily>", <默认栈>`，即**用户指定的字体优先、找不到再回退默认栈**。
   *   为什么不写成"只用这一个字体"：中文名或拼错的族名会让 canvas 掉进某个只带拉丁字形
   *   的默认字体，中文全变豆腐块；而 canvas 对无效的 `font` **不报错**（静默沿用上一次的
   *   字体），所以这种错永远不会以异常的形式出现。留默认栈兜底，最坏情况也还能看中文。
   *
   * ★ 换行结果**不能跨机器比对**：Windows 有雅黑没苹方，macOS 反之。这个字段能保证的
   *   只有"字体名对得上就用它"，保证不了"两台机器断行一致"。
   */
  fontFamily: string;
}

/** 图片层。 */
export interface ImageLayer extends LayerBase {
  type: 'image';
  /** data URL 或 http(s) URL。空串表示还没放图。 */
  src: string;
  fit: 'cover' | 'contain';
  /** 圆角，像素。 */
  radius: number;
  filters: import('./filters').FilterState;
  /** 占位态：显示虚线框而不是图。套模板走的就是这条路。 */
  placeholder: boolean;
  placeholderLabel: string;
}

/**
 * 形状层。
 *
 * `shapeKind` 是新增字段（现有实现只能画圆角矩形）。四种取值的渲染实现
 * 分别在 `src/poster/geometry/` 里，**本文件不负责画**，只负责描述。
 *
 * 为什么 'line' 也有 `h`：线不是零厚度对象 —— 要让命中测试、选框、缩放
 * 都有统一语义，线就是"一个被压扁的盒子"。渲染时用它自己的 stroke 宽度。
 */
export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shapeKind: 'rect' | 'ellipse' | 'line' | 'polygon';
  /** 填充色。`line` 用它当描边色。 */
  fill: string;
  radius: number;
  /**
   * 描边。`null` 表示只填充不描边 —— 用 `null` 而不是 `undefined`，
   * 因为 `exactOptionalPropertyTypes` 下 `stroke?: X` 不允许显式传 undefined，
   * 而"明确表示没有描边"本身是有意义的状态。
   */
  stroke: { color: string; width: number } | null;
  /** 多边形的顶点，`polygon` 之外的形状必须为空数组。坐标相对图层左上角。 */
  points: ReadonlyArray<{ x: number; y: number }>;
}

/** 判别联合。所有渲染/编辑入口都吃这个类型。 */
export type Layer = TextLayer | ImageLayer | ShapeLayer;

/**
 * 三个收窄函数。
 *
 * 为什么不用 `layer.type === 'text'` 直接判：判别联合已经够了，
 * 这三个函数的价值在**跨边界处** —— 从 `unknown`（存档 / AI 输出 / IPC）
 * 收窄到具体图层时，需要一个具名断言，而不是把 `as` 撒得到处都是。
 */
export function isTextLayer(layer: Layer): layer is TextLayer {
  return layer.type === 'text';
}

export function isImageLayer(layer: Layer): layer is ImageLayer {
  return layer.type === 'image';
}

export function isShapeLayer(layer: Layer): layer is ShapeLayer {
  return layer.type === 'shape';
}
