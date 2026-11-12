/**
 * 海报绘制路径的**开关**：预览与导出各自可走「新引擎 `src/poster/`」或「回退路径
 * `PosterStudio.drawPoster()`」，两条**互相独立**（"预览走新的、导出走旧的"必须能表达）。
 *
 * ① 为什么需要开关：新引擎首次接管真机预览/导出，回退必须留在代码里且现场可切 —— git revert
 *    不行（会连本次接线证据一起丢，而回退发生在用户机器上）。顺带得到**负控天然存在**：
 *    同一 doc、同一 env 只翻一个字符串就对出数字；否则唯一对照是"改代码再改回来"，本仓已两次
 *    踩到"改了没还原 / 还原了没复跑"。状态放**模块级**（组件 state 会被重渲染重置；不用 window
 *    当读取源），另配 `window.__posterEngine` 读写口，与 `window.__posterTest` 同一"产品能力"
 *    惯例。**默认必须是 `new`** —— 默认 `legacy` 等于"切换根本没发生"，所有用例都会假绿。
 * ② 为什么不塞进 `drawPoster` 的 `opts`：`PosterStudio.jsx:754-770` 明令 `opts` 只允许一个键
 *    `forExport` 且只决定占位框画不画，**禁止**用它分叉排版。加第二个键就是给"以后顺手在这里
 *    分叉"再开一个入口；一旦发生，预览与导出不再共用一段代码。所以开关只能活在**调用点之上**：
 *    它选"调哪个函数"，不是"函数内部怎么画"。
 * ③ 为什么预览要自己 `setTransform` + `clearRect`：`renderDoc()` 的前置条件是「`ctx` 变换
 *    已乘好倍率」，而 `createCanvas()` 会造**新画布** —— 预览必须画进 `canvasRef.current`。
 *    顺序不能反：`setTransform(倍率) → clearRect(逻辑尺寸) → renderDoc`。
 *    ★ **倍率的分母与绘制尺寸必须是同一个数**。`normalizeDoc` 把画布边钳进 [64, 8192]，
 *    而 `doc.width` 是未钳制的原始值；两个数分开算过一次，实测 width=20000 时底色只铺
 *    (8192/20000) 见方 ≈ 16.8%，剩 83.1768% 是**透明像素**（由 E14 两个方向钉住）。
 *    ★ `clearRect` 在"两个数一致"这个前提下**不是**承重墙（底色 fillRect 不透明且铺满，
 *    负控 N2 拔掉它实测全绿）；但两个数不一致时它也救不了 —— 它之后那片是透明的，
 *    不是底色。两条都别删：`render.ts:50-51` 明确把外层 `globalAlpha` 当特性保留，
 *    将来有人拿这开关做半透明缩略图时 `clearRect` 立刻承重。"它一度可有可无"的根因
 *    就是上面那个尺寸不一致，不是颜色。
 *    倍率取「位图尺寸 ÷ 归一化尺寸」而非入参 `scale`：`canvas.width` 是整数，1080×0.31
 *    = 334.8 截成 334，仍按 0.31 变换就多出一条画不到的缝。
 * ④ 为什么调用点仍写 `forExport`、内部才映射成 `exportMode`：前者是**调用点语义**
 *    （"给用户看还是给用户拿走"），后者是**画布引擎语义**（`RenderEnv.exportMode`）。
 *    今天一一对应，但后者将来还要覆盖缩略图、分组预览、A/B 导出。映射只在
 *    `toExportMode()` 一处 ⇒ 语义分叉时改一行；在调用层写 `exportMode` 则同一概念有两个
 *    名字，下次谁也说不清哪个是画布语义、哪个是调用点语义。
 * ⑤ 诊断非空时的口径（**不许静默回退**）：非空 = 有层没画出来。导出 ⇒ **抛错**（带层 id），
 *    绝不产出缺图却不报错的成品；预览 ⇒ `console.error` + 记进 `lastPreviewDiagnostics`
 *    （抛错会把整页打死，坏一层不该让用户连字都改不了）。两条都**不许**自动改走 legacy。
 */
import { createCanvasEl, drawPoster, peekImage } from './PosterStudio.jsx';
import { createCanvas, normalizeDoc, renderDoc } from '../../poster/index';

/** 走新引擎（`src/poster/`）。**默认值**，见文件头 ①。 */
export const POSTER_ENGINE_NEW = 'new';
/** 走回退路径（`PosterStudio.drawPoster`），保留以便现场回退。 */
export const POSTER_ENGINE_LEGACY = 'legacy';
const VALID_MODES = Object.freeze([POSTER_ENGINE_NEW, POSTER_ENGINE_LEGACY]);
/** 画布不可用时的用户可见文案。与旧调用点逐字相同（提示不该因为换引擎而变）。 */
const CANVAS_UNAVAILABLE = '这台设备暂时不能导出（画布不可用），请更新到新版再试';

/** 当前模式（模块级，理由见文件头 ①）+ 上一次预览的诊断（预览不抛错，见文件头 ⑤）。 */
let mode = { preview: POSTER_ENGINE_NEW, export: POSTER_ENGINE_NEW };
let lastPreviewDiagnostics = [];

/** 取有限数，取不到给兜底值（非有限数传给 canvas 会被静默转成 0）。 */
const finiteOf = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
/** 转成"至少 1 的整数"。 */
const positiveIntOf = (value, fallback) => Math.max(1, Math.round(finiteOf(value, fallback)));
/** 调用点语义 ⇒ 引擎语义（文件头 ④）。缺省 / false 都必须是预览模式。 */
const toExportMode = (forExport) => forExport === true;
/** 诊断压成一行 `层id(类型/原因)`：导出报错要能指名道姓。 */
const describeDiagnostics = (diagnostics) => diagnostics
  .map((d) => `${d.layerId}(${d.layerType}/${d.reason})`).join('、');

/** 用新引擎画一版到 `ctx`（预览与导出共用，只差 `exportMode`）。顺序见文件头 ③。 */
function paintWithNewEngine(ctx, doc, exportMode, scale) {
  // ★ 归一化**只做一次**，绘制尺寸 / 变换分母 / clearRect / env 全用这一份 —— 顺序就是契约。
  //   分开算过的代价（E14 钉住）：`positiveIntOf` 不钳制、`normalizeDoc` 钳到 [64, 8192]，
  //   width=20000 时底色只铺 (8192/20000) 见方 ≈ 16.8%，剩下 83.1768% 是**透明像素**。
  const normalized = normalizeDoc(doc);
  const width = normalized.width;
  const height = normalized.height;
  const raw = finiteOf(scale, 1);
  const factor = raw > 0 ? raw : 1;
  const canvas = ctx.canvas || null;
  const bitmapWidth = canvas && finiteOf(canvas.width, 0) > 0 ? canvas.width : Math.round(width * factor);
  const bitmapHeight = canvas && finiteOf(canvas.height, 0) > 0 ? canvas.height : Math.round(height * factor);
  ctx.setTransform(Math.max(1, bitmapWidth) / width, 0, 0, Math.max(1, bitmapHeight) / height, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return renderDoc(ctx, normalized, {
    width,
    height,
    // 同步取已解码位图；异步加载由调用方在渲染之前完成（预览靠 imgVersion 重绘、
    // 导出靠 ensureImage 预热）。缓存只有一份，就在 PosterStudio。
    resolveImage: (src) => peekImage(src),
    exportMode,
  });
}

/**
 * 预览绘制入口 —— 画进**调用方给的** `ctx`（React 的 `canvasRef.current`，不是新画布）。
 * @param {{forExport?: boolean}} [opts] 与旧调用点同形，只认 `forExport`；@returns {boolean} 是否真的画了
 */
export function renderPosterSurface(ctx, doc, scale, opts) {
  if (!ctx || !doc || !Array.isArray(doc.layers)) return false;
  const forExport = toExportMode(opts && opts.forExport);
  if (mode.preview === POSTER_ENGINE_LEGACY) {
    lastPreviewDiagnostics = [];
    return drawPoster(ctx, doc, scale, { forExport }) === true;
  }
  const diagnostics = paintWithNewEngine(ctx, doc, forExport, scale);
  lastPreviewDiagnostics = diagnostics;
  // 预览不抛（文件头 ⑤），但绝不静默：console 与 E2E 两条通道都留。
  if (diagnostics.length > 0) {
    console.error(`[poster] 预览有 ${diagnostics.length} 层没画出来：${describeDiagnostics(diagnostics)}`);
  }
  return true;
}

/** 造导出画布 —— 回退路径，与旧代码逐字等价（`createCanvasEl` + `getContext('2d')`）。 */
function legacyExportSurface(pixelWidth, pixelHeight) {
  const canvas = createCanvasEl(pixelWidth, pixelHeight);
  if (!canvas) throw new Error(CANVAS_UNAVAILABLE);
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) throw new Error(CANVAS_UNAVAILABLE);
  return { canvas, ctx };
}

/** 造导出画布 —— 新引擎路径。`createCanvas` 抛的文案是给实现者看的；用户该看到的是上面那句。 */
function newExportSurface(width, height, factor) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') throw new Error(CANVAS_UNAVAILABLE);
  try {
    return createCanvas(width, height, factor);
  } catch (err) {
    throw new Error(CANVAS_UNAVAILABLE);
  }
}

/**
 * 导出绘制入口 —— 内部建离屏画布并返回它（`toDataURL` 由调用方做：格式与质量是调用点的
 * 产品决策）。诊断非空 ⇒ **抛错**（文件头 ⑤）。
 * @returns {HTMLCanvasElement} 已画好的画布（`scale` 倍位图）
 */
export function renderPosterExport(doc, scale) {
  if (!doc || !Array.isArray(doc.layers)) throw new Error('导出失败：没有可绘制的文档');
  const raw = finiteOf(scale, 1);
  const factor = raw > 0 ? raw : 1;
  if (mode.export === POSTER_ENGINE_LEGACY) {
    // 回退路径的位图尺寸**继续**用未钳制的 `doc.width`：`drawPoster` 自己 setTransform(factor)
    // 且以 doc.width 为逻辑宽 ⇒ 改这里会让回退产物跟着变（E8 的"逐字等价"当场破）。
    const w = positiveIntOf(doc.width, 1080);
    const h = positiveIntOf(doc.height, 1440);
    const legacy = legacyExportSurface(w * factor, h * factor);
    drawPoster(legacy.ctx, doc, factor, { forExport: true });
    return legacy.canvas;
  }
  // 新引擎：位图尺寸必须与 `paintWithNewEngine` 里那次归一化同源，否则又各走一路。
  const normalized = normalizeDoc(doc);
  const surface = newExportSurface(normalized.width, normalized.height, factor);
  const diagnostics = paintWithNewEngine(surface.ctx, doc, toExportMode(true), factor);
  if (diagnostics.length > 0) {
    throw new Error(`导出失败：有 ${diagnostics.length} 层没有画出来（${describeDiagnostics(diagnostics)}）`
      + '—— 与其给你一张缺图的成品，不如明确报错');
  }
  return surface.canvas;
}

/**
 * 模式读写口。`set` 支持部分更新（`{ preview: 'legacy' }` 只改预览），非法值**抛错**而
 * 不是静默忽略 —— 静默忽略的症状是"设了没生效"，它与"这条路径本来就一样"在 E2E 读数上
 * 无法区分。换模式会清空上一次的诊断（判据换了，旧诊断不再代表当前状态）。
 */
export const posterEngineMode = {
  /** @returns {{preview: string, export: string}} 模式副本（改它不影响模块状态） */
  get() {
    return { preview: mode.preview, export: mode.export };
  },
  /**
   * @param {{preview?: string, export?: string}} next 要改的字段
   * @throws {Error} 值不在 `['new', 'legacy']` 里时
   */
  set(next) {
    const patch = next || {};
    const merged = { preview: mode.preview, export: mode.export };
    for (const key of ['preview', 'export']) {
      if (!(key in patch)) continue;
      if (VALID_MODES.indexOf(patch[key]) < 0) {
        throw new Error(`posterEngineMode.set：${key} 只接受 ${VALID_MODES.join(' / ')}，收到 ${String(patch[key])}`);
      }
      merged[key] = patch[key];
    }
    mode = merged;
    lastPreviewDiagnostics = [];
    return { preview: mode.preview, export: mode.export };
  },
};

/** 上一次预览的诊断快照（空数组 = 每一层都画出来了）。预览不抛错（文件头 ⑤），所以"有层
 *  没画出来"在预览路径上没有用户可见信号 —— E2E 与排障需要一个能读的地方。 */
export function getLastPreviewDiagnostics() {
  return lastPreviewDiagnostics.slice();
}

// ── 产品能力口：与 `window.__posterTest` 同一惯例（文件头 ①）。挂在模块顶层而不是组件 effect
// 里 —— 它描述的是"这段代码的能力"，不是"某棵组件树的状态"。
if (typeof window !== 'undefined') {
  try {
    window.__posterEngine = posterEngineMode;
  } catch (err) {
    // window 不可写（某些沙箱 / jsdom 配置）不影响绘制本身，只影响可观测性。
    console.warn(`[poster] 无法挂载 window.__posterEngine：${String(err && err.message ? err.message : err)}`);
  }
}
