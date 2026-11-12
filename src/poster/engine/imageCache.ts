/**
 * 图片预加载器 —— canvas 绘制是同步的，异步加载必须在渲染**之前**做完。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么不能只等 `onload`
 * ════════════════════════════════════════════════════════════════════════════
 * `img.onload` 只表示「字节与元数据到手」，**不保证解码完成**。此时
 * `ctx.drawImage(img, ...)` 会同步触发一次解码：大图（4000px 的模板底图）
 * 上这是几十毫秒的主线程阻塞，且部分浏览器会先画出一个空白/半张的位图
 * 再重绘 —— 表现是"导出的图里偶尔有一张图是白的"。
 * `img.decode()` 返回的 Promise 才代表"此刻可以**立刻**绘制"。
 *
 * 兜底：老引擎没有 `decode()`，退回 `onload`/`onerror` 双事件。
 * 这条路已知不如 `decode()` 严格，但它只在没有 `decode()` 时才走。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么单张失败**不许**让整体 reject
 * ════════════════════════════════════════════════════════════════════════════
 * 一份海报有 6 个图层，其中 1 张图挂了（data URL 被截断 / http 404），
 * 整体失败意味着**一行都画不出来**；而按层降级意味着"画得出 5 层的图，
 * 第 6 层画占位框"。后者永远比前者有用 —— 用户能看见哪里坏了。
 * 所以失败被记录进 `failures()`，`resolve()` 对坏图返回 `null`，
 * 由各图元渲染器自己画占位（这是 `RenderEnv.resolveImage` 的约定）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么不设 `img.crossOrigin`
 * ════════════════════════════════════════════════════════════════════════════
 * 设 `crossOrigin = 'anonymous'` 会让**不回 CORS 头的服务器**从"能画"（只是
 * 污染画布、`toDataURL` 才受限）变成"加载失败"。模板素材多是 data URL，
 * 而 data URL 本身不需要 CORS。对确实需要导出的跨域图，正确做法是主进程
 * 代理下载（见既有 poster 存储路径），不是在这里赌一个 CORS 头。
 */

/** 一张图加载失败的原因（诊断用；渲染器只看 `resolve()` 的 null）。 */
export interface ImageLoadFailure {
  /** 失败的原 src（已 trim）。 */
  readonly src: string;
  /** 失败原因（异常类型 + 消息）。人读的，不要拿去分支判断。 */
  readonly reason: string;
}

/**
 * 预加载结果。
 *
 * `resolve()` 是**同步**的 —— 它只查表。这个签名是被 `registry.ts` 里的
 * `RenderEnv.resolveImage` 定死的：canvas 绘制无法等待 Promise。
 */
export interface ImageCache {
  /** 取已解码的位图；空串、未提供过、加载失败一律返回 `null`（不抛错）。 */
  resolve(src: string): CanvasImageSource | null;
  /** 所有失败记录（副本）。每次调用返回新数组，调用方改不到内部状态。 */
  failures(): readonly ImageLoadFailure[];
  /** 成功加载的张数（不含失败、不含重复）。 */
  loadedCount(): number;
}

/** 把 `unknown` 异常转成一行可读文本 —— `useUnknownInCatchVariables` 下 catch 到的是 `unknown`。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message === '' ? err.name : `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * 加载并解码一张图。
 *
 * @param src 非空的图片地址（data URL 或 http(s)）
 * @returns 可直接 `drawImage` 的位图
 * @throws 地址无效 / 解码失败 / 无 DOM 环境时
 */
async function decodeOne(src: string): Promise<CanvasImageSource> {
  const img = new Image();
  img.src = src;

  // `typeof` 判断是为了运行时安全（TS 的 DOM 类型说它一定存在，
  // 但 Electron 里可以用 `--disable-blink-features` 之类关掉，届时会 TypeError）。
  if (typeof img.decode === 'function') {
    await img.decode();
    return img;
  }

  await new Promise<void>((resolve, reject) => {
    img.onload = (): void => { resolve(); };
    img.onerror = (): void => {
      reject(new Error('onerror：加载失败（本环境无 img.decode()，退回事件回调判定）'));
    };
  });
  return img;
}

/**
 * 批量预加载。
 *
 * 同一 src 只加载一次：入参先过一遍去重（`Set`），所以「6 个图层用同一张底图」
 * 只会发一次请求、只占一份解码内存。去重发生在**加载之前**而不是之后 ——
 * 事后去重省不了请求。
 *
 * 本函数**永不 reject**：任何单张失败都落在 `failures()` 里。
 * 空数组入参 ⇒ 立即返回一个空缓存（合法情况：空白文档没有任何图片层）。
 *
 * @param sources 图片地址列表（允许重复、允许空串）
 * @returns 预加载结果
 */
export async function loadImages(sources: readonly string[]): Promise<ImageCache> {
  /** src ⇒ 解码后的位图。只放**成功**的，失败的进 `failureRows`。 */
  const images = new Map<string, CanvasImageSource>();
  const failureRows: ImageLoadFailure[] = [];

  // 去重 + 去空。trim 是必要的：data URL 常来自模板字面量，换行会被带进首尾，
  // 而首尾带空白的 src 在 `new Image()` 里会直接失败。
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of sources) {
    const src = raw.trim();
    if (src === '' || seen.has(src)) continue;
    seen.add(src);
    unique.push(src);
  }

  // 并发加载，但每张各自吞掉自己的异常 —— 一张失败不能让整批进 catch。
  await Promise.all(unique.map(async (src: string): Promise<void> => {
    try {
      const image = await decodeOne(src);
      images.set(src, image);
    } catch (err) {
      failureRows.push({ src, reason: describeError(err) });
    }
  }));

  return {
    resolve(src: string): CanvasImageSource | null {
      const key = src.trim();
      if (key === '') return null;
      return images.get(key) ?? null;
    },
    failures(): readonly ImageLoadFailure[] {
      return failureRows.slice();
    },
    loadedCount(): number {
      return images.size;
    },
  };
}
