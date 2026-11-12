/**
 * 贴图数学：算「源图哪一块」贴到「盒子哪一块」。
 *
 * 从 `draw.ts` 拆出来的理由有两条，都不是为了凑行数：
 *   ① **可测性**：这两个函数完全不碰 canvas，测试可以对着每个分支逐项断言，
 *      而 `cover` 算错的症状（图被拉伸但仍铺满、不露白边）肉眼极难发现；
 *   ② 单文件 250 行上限（`unit-ts-strict.mjs` [4/4]）—— 第一版写在 `draw.ts`
 *      里是 336 行，被这条门禁拦下。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么用九参数 `drawImage` 而不是五参数 + `clip()`
 * ════════════════════════════════════════════════════════════════════════════
 * 五参数版画的是**整张**图，`cover` 的"裁掉溢出"就只能靠外层 `clip()` 实现，
 * 而 `clip()` 的裁剪发生在**光栅化之后**：溢出的像素先被缩放、再被裁掉，
 * 等于白算一遍采样，大图上画质可见地变差。直接给出源矩形，则只采样用得到的那块。
 * 这也是本文件存在的核心价值：源矩形必须算准，否则裁到的是错的像素。
 */

/**
 * 贴图数学的结果：源矩形（裁哪些像素）+ 目标矩形（画到盒子的哪一块）。
 *
 * 字段名与 `ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)` 的参数
 * 一一对应，调用方可以直接展开，不必再翻译一次命名。字段用 `readonly`：
 * 这个对象会被算出后立刻用掉，就地被改是最难查的一类 bug。
 */
export interface ImageFitRect {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

/** 位图的内在像素尺寸。 */
export interface ImageIntrinsicSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 算 `cover` / `contain` 的源与目标矩形。
 *
 * **`cover`**（填满，多出来的居中裁掉）：
 *   `scale = max(boxW/imgW, boxH/imgH)`；源矩形取 `boxW/scale × boxH/scale`
 *   —— 它正好等于盒子的宽高比，居中放到源图中央；目标矩形就是整个盒子。
 *   恒有 `sw ≤ imgW`：因为 `scale ≥ boxW/imgW ⇒ boxW/scale ≤ imgW`。
 *   恒有 `sh ≤ imgH`，同理。
 *
 * **`contain`**（缩进盒子内，不拉伸，居中留白）：
 *   `scale = min(boxW/imgW, boxH/imgH)`；目标矩形 `imgW×imgH` 乘 scale 后居中；
 *   源矩形是整张图。恒有 `dw ≤ boxW`、`dh ≤ boxH`。
 *
 * ⚠ 两个分支的 `min`/`max` 写反是这里唯一的真实风险，而且两种写反的
 * **可发现性完全不同**：contain 写反会直接露白边（一眼看出）；cover 写反
 * 则是"图被拉伸但铺满"，**不露白边、不报错**，只能靠断言抓。所以测试对
 * 两个分支各自断言，并带一条"把 fit 对调 ⇒ 断言必须红"的反控。
 *
 * @param imageWidth 源图像素宽
 * @param imageHeight 源图像素高
 * @param boxWidth 盒子宽（图层 `w`）
 * @param boxHeight 盒子高（图层 `h`）
 * @param fit 适配方式
 * @returns 源/目标矩形；任一尺寸非有限数或 ≤ 0 时返回 `null`（调用方走占位分支）
 */
export function fitRectFor(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: 'cover' | 'contain',
): ImageFitRect | null {
  const dims = [imageWidth, imageHeight, boxWidth, boxHeight];
  if (!dims.every((value: number): boolean => Number.isFinite(value) && value > 0)) {
    return null;
  }

  if (fit === 'cover') {
    // 取 max：宁可放大到溢出再裁，也不能留空。负数宽高已在上面挡掉。
    const scale = Math.max(boxWidth / imageWidth, boxHeight / imageHeight);
    const sw = boxWidth / scale;
    const sh = boxHeight / scale;
    return {
      sx: (imageWidth - sw) / 2,
      sy: (imageHeight - sh) / 2,
      sw,
      sh,
      dx: 0,
      dy: 0,
      dw: boxWidth,
      dh: boxHeight,
    };
  }

  // 取 min：宁可留白，也不能裁掉内容。
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const dw = imageWidth * scale;
  const dh = imageHeight * scale;
  return {
    sx: 0,
    sy: 0,
    sw: imageWidth,
    sh: imageHeight,
    dx: (boxWidth - dw) / 2,
    dy: (boxHeight - dh) / 2,
    dw,
    dh,
  };
}

/**
 * 读出位图的**内在像素尺寸**。
 *
 * 为什么不用 `instanceof HTMLImageElement` 这类判断：`CanvasImageSource` 是六种
 * 类型的联合（`HTMLImageElement` / `HTMLCanvasElement` / `ImageBitmap` /
 * `OffscreenCanvas` / `SVGImageElement` / `VideoFrame`），它们**没有统一的尺寸
 * 字段**（图片用 `naturalWidth`、画布用 `width`）。六个 `instanceof` 分支既长，
 * 又会在无 DOM 的 Node 环境里直接 `ReferenceError`（全局构造器根本不存在，
 * 而本模块要被纯 Node 的单元测试 import）。
 *
 * 所以按"结构上有哪个字段就用哪个"读，然后**逐个校验是有限正数**：
 * 读到怪值（`SVGImageElement.width` 是个 `SVGAnimatedLength` 对象）会被判成
 * `null` 走占位分支，`NaN` 不会流进 `fitRectFor`。
 *
 * 为什么先 `naturalWidth` 再 `width`：`HTMLImageElement.width` 是可以被 HTML 属性
 * 改写的**显示宽**，只有 `naturalWidth` 才是解码后的真实像素。先读错的那个会让
 * `cover` 的裁切量按错误的基准算。
 *
 * @param source 已解码的位图
 * @returns 内在尺寸；读不出可用尺寸时返回 `null`
 */
export function intrinsicSizeOf(source: CanvasImageSource): ImageIntrinsicSize | null {
  const probe = source as unknown as {
    readonly naturalWidth?: number;
    readonly naturalHeight?: number;
    readonly width?: number;
    readonly height?: number;
  };
  const width = probe.naturalWidth ?? probe.width ?? 0;
  const height = probe.naturalHeight ?? probe.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}
