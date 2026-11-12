/**
 * canvas 底层原语：造画布、算导出倍率、导出成 dataURL / Blob。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么倍率必须用 `setTransform` 一次设好，不能用 `ctx.scale()`
 * ════════════════════════════════════════════════════════════════════════════
 * `ctx.scale()` 是**乘进当前变换矩阵**，不是设值。同一个 ctx 被重复渲染时
 * （预览 → 拖一次滑块 → 再预览，走的是同一个 ctx），第二遍会在第一遍的
 * 基础**再乘一次**：1× → 2× → 4× → 8×，画面一路缩小、边缘一路糊掉，
 * 而且**第一帧永远是对的** —— 这类"第二次才错"的 bug 极难归因。
 * `setTransform(a,b,c,d,e,f)` 是**覆盖**，无论被调用多少次结果都一样。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么 setTransform 用的不是传进来的 scale 本身
 * ════════════════════════════════════════════════════════════════════════════
 * 位图宽高必须是整数（`canvas.width` 是 `unsigned long`，赋 324.6 会变成 324），
 * 所以 1080 × 0.3 = 324 恰好整除、而 1080 × 0.31 = 334.8 会被截成 334。
 * 若此时仍用 0.31 做变换，画面会比位图**大 0.8 像素** ⇒ 右侧/底部出现一条
 * 永远画不到（导出后是白边）的缝，肉眼在浅色底上看得见。
 * 所以这里用「实际位图尺寸 ÷ 逻辑尺寸」当倍率：整除时它就等于 scale
 * （即 `setTransform(scale,0,0,scale,0,0)`），不整除时它保证画面与位图严格对齐。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 环境假设
 * ════════════════════════════════════════════════════════════════════════════
 * 本文件只在渲染进程（Chromium）里被调用：`document` / `HTMLCanvasElement`
 * 都来自 DOM。**没有**任何顶层 DOM 访问 —— 所以它可以被 Node 直接 import
 * 做单元测试（只测不碰 DOM 的纯逻辑与参数校验）。
 */

import type { PosterDoc } from '../model/doc';

/** 导出图片格式。`webp` 在 Chromium 上可用（Electron 渲染进程就是 Chromium）。 */
export type ExportFormat = 'png' | 'jpeg' | 'webp';

/**
 * 一张**已经把倍率设进变换矩阵**的画布。
 *
 * 刻意不暴露 `scale` 字段：图元渲染器只需要在 `[0,0,doc.width,doc.height]`
 * 这个逻辑坐标系里画，倍率由引擎管 —— 这正是 `registry.ts` 里
 * 「图元只管画、引擎管缩放」那条分界的落法。
 */
export interface CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

/**
 * 导出倍率下限 0.25。
 *
 * 1080 宽的海报 × 0.25 = 270px —— 这个尺寸上任何 24px 的文字都只剩约 6px 高，
 * 已经不可能"看清"。比它更小的请求几乎只能是调用方算错了参数（例如把
 * 「目标高度」当成「目标宽度」传进来）。夹到 0.25 而不是抛错：调用方拿到
 * 一个合法但明显偏小的图，比拿到一个异常更容易被排查（异常会被人 try 掉）。
 */
const MIN_SCALE = 0.25;

/**
 * 导出倍率上限 4。
 *
 * · 4× 让 1080×1440 变成 4320×5760 = 24.9M 像素。A4 打印 300dpi 需要 2480×3508
 *   （约 8.7M），4× 对它已富余 2.8 倍。
 * · 再往上**位图来源不够**：模板里的图片素材普遍是 1080~1600 宽，
 *   放大 5 倍以上只是把同样的像素拉大，画质一分不涨、内存照涨。
 * · 24.9M 也接近浏览器 canvas 的可用区（Chrome 单画布约 268M 像素但显存有限；
 *   iOS Safari 硬上限约 16.7M 像素）—— 同一份代码在移动端预览里会直接得到
 *   一张**全白**的画布（`getContext` 成功但绘制被丢弃，不抛错）。
 */
const MAX_SCALE = 4;

/** 有损格式（jpeg / webp）的质量。0.92 是"肉眼无损"与文件大小之间的常用折中。 */
const LOSSY_QUALITY = 0.92;

/** `ExportFormat` ⇒ MIME。用 Record 让「加一种格式」时这里不补就编译报错。 */
const MIME: Readonly<Record<ExportFormat, string>> = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

/**
 * 断言是有限正数。
 *
 * 为什么统一在这里抛 `RangeError` 而不是让 NaN 流下去：
 * `NaN` 传给 `canvas.width` 会被静默转成 0，得到 0×0 画布，`toDataURL` 返回
 * `"data:,"` —— 一条**能成功解码但什么都没有**的 data URL。
 * 这种"看起来成功了"的产物是本仓反复踩的坑，所以在参数入口就断死。
 */
function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} 必须是有限正数，收到 ${String(value)}`);
  }
}

/**
 * 按「目标像素宽度」算导出倍率。
 *
 * 只接受 `width/height` 两个字段（`Pick`）而不是整个 `PosterDoc`：
 * 导出倍率只跟尺寸有关，收窄入参可以让调用方传一份"只有尺寸的草稿"
 * 来算倍率，而不必先凑出一个完整文档。
 *
 * @param doc 文档（只读宽高）
 * @param targetWidth 期望的导出像素宽度
 * @returns 夹在 `[0.25, 4]` 区间的倍率
 * @throws RangeError 宽、高或目标宽度不是有限正数时
 */
export function resolveScale(
  doc: Pick<PosterDoc, 'width' | 'height'>,
  targetWidth: number,
): number {
  assertPositiveFinite(doc.width, 'resolveScale: doc.width');
  assertPositiveFinite(doc.height, 'resolveScale: doc.height');
  assertPositiveFinite(targetWidth, 'resolveScale: targetWidth');
  const raw = targetWidth / doc.width;
  if (raw < MIN_SCALE) return MIN_SCALE;
  if (raw > MAX_SCALE) return MAX_SCALE;
  return raw;
}

/**
 * 造一张按 `scale` 定好位图尺寸与变换矩阵的画布。
 *
 * 返回的 `ctx` 已经满足：
 *   · 坐标系是**逻辑像素**（`[0,0,width,height]`），倍率不再需要图元关心；
 *   · `imageSmoothingQuality = 'high'` —— 缩小时（导出到小尺寸、图层缩略图）
 *     默认的 `'low'` 会做最近邻近似，文字与细线出现明显锯齿；代价是缩放开销。
 *
 * @param width 逻辑宽（海报坐标，像素）
 * @param height 逻辑高
 * @param scale 倍率（通常来自 `resolveScale`）
 * @returns 画布与 2D 上下文
 * @throws RangeError 任一参数不是有限正数时
 * @throws Error `getContext('2d')` 返回 null（GPU 上下文耗尽 / 上下文数超限）时
 */
export function createCanvas(width: number, height: number, scale: number): CanvasSurface {
  assertPositiveFinite(width, 'createCanvas: width');
  assertPositiveFinite(height, 'createCanvas: height');
  assertPositiveFinite(scale, 'createCanvas: scale');

  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;

  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    // 不降级成"返回一张空画布"：那会让导出得到一张全白图而没有任何报错。
    throw new Error(
      `createCanvas: getContext('2d') 返回 null（${pixelWidth}×${pixelHeight}）—— `
      + '多半是同时存在的 canvas 上下文过多或显存耗尽；此时不可能画出任何东西',
    );
  }

  // 见文件头：用位图实际尺寸反推倍率，保证画面与位图严格对齐。
  // 整除时 scaleX === scaleY === scale，等价于 setTransform(scale,0,0,scale,0,0)。
  const scaleX = pixelWidth / width;
  const scaleY = pixelHeight / height;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  ctx.imageSmoothingQuality = 'high';

  return { canvas, ctx };
}

/**
 * 画布 ⇒ data URL 字符串。
 *
 * 显式拦 `"data:,"`（长度 6）。它是一段**合法** URL，`<img src>` 会安静地显示成
 * "什么都没有"，主进程也会照常把它当图片字节落盘 —— 静默产出空图是本仓明确禁止的
 * 失败模式，所以这里直接抛。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `"data:,"` 的两个来源（第二个才是更常见的那个）
 * ════════════════════════════════════════════════════════════════════════════
 * ① 画布尺寸为 0（`canvas.width/height` 被赋成 0 或非正数）。
 * ② **画布面积超过 Chromium 的上限，所有绘制被静默丢弃。** 这条比 ① 危险得多，
 *    因为超限时**四层信号全在撒谎**：`canvas.width` 读回你设的值、`getContext('2d')`
 *    返回非 null、不抛错、绘制耗时 0ms。唯一可观测信号就是 `toDataURL` 返回
 *    `"data:,"`。
 *
 *    本机实测（`win32` + 系统 Edge / Chromium 156，方形画布，`fillRect` 铺纯红后
 *    取中心像素并 `toDataURL('image/png')`）：
 *      · 16384×16384 —— 中心 `[255,0,0,255]`，URL 6,682,842 字符，正常；
 *      · **16385×16385 —— 中心 `[0,0,0,0]`，URL 长度 6（`"data:,"`），耗时 0ms**；
 *      · 17000、20000 —— 同上，都是 `"data:,"`，且 `canvas.width` 仍读回 17000 / 20000。
 *    分界点是 16384² = 268,435,456 像素（≈ Chromium 的单画布面积上限）。**注意这是
 *    面积上限、不是单边上限** —— 一条边 16385 就已经越界。
 *
 *    可达性：`PosterStudio.jsx` 的导出是「`normalizeDoc` 钳到 8192」×
 *    「`EXPORT_SCALE = 2`」= 16384，**正好贴着边界**。任何一个常量往上抬一点
 *    （`EXPORT_SCALE` 提到 3，或 `MAX_CANVAS_EDGE` 提到 10000）就会静默出空图。
 *
 * @throws Error 结果为 `"data:,"`（尺寸为 0 / 面积超限）或不是 `data:image/` 时
 */
export function canvasToDataUrl(canvas: HTMLCanvasElement, format: ExportFormat): string {
  // png 忽略质量参数，但两条分支分开写：合起来写会让后来的人以为 png 也走有损。
  const url = format === 'png'
    ? canvas.toDataURL(MIME.png)
    : canvas.toDataURL(MIME[format], LOSSY_QUALITY);
  if (url === 'data:,' || !url.startsWith('data:image/')) {
    throw new Error(
      `canvasToDataUrl: 得到无效结果（format=${format}，`
      + `画布 ${canvas.width}×${canvas.height}，结果前 24 字符 "${url.slice(0, 24)}"）`
      + '—— 尺寸为 0，或面积超过 Chromium 上限后绘制被静默丢弃；此时导出的图是空的',
    );
  }
  return url;
}

/**
 * 画布 ⇒ Blob（`toBlob` 的回调式 API 的 Promise 包装）。
 *
 * `toBlob` 的回调参数类型是 `Blob | null`，`null` 的含义是**编码失败**
 * （画布为 0 尺寸、或格式不被支持）。把它当成功传出去，调用方会拿到
 * 一个 0 字节文件、并在保存到磁盘之后才发现 —— 所以这里必须显式拒绝。
 *
 * @throws 编码失败（回调收到 `null`）时 Promise reject
 */
export function canvasToBlob(canvas: HTMLCanvasElement, format: ExportFormat): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob: Blob | null): void => {
      if (blob === null) {
        reject(new Error(
          `canvasToBlob: toBlob 回调收到 null（format=${format}，`
          + `画布 ${canvas.width}×${canvas.height}）—— 编码失败，不能当成空图继续`,
        ));
        return;
      }
      resolve(blob);
    }, MIME[format], LOSSY_QUALITY);
  });
}
