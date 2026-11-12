/**
 * 单字段窄化 —— `unknown` ⇒ 某个具体字段的合法值。
 *
 * 为什么单独成文件：`normalize.ts` 里"逐字段窄化"占了整份文件的一大半，
 * 而每一条窄化都带着一段"为什么必须这么判"的理由（见各函数注释）。
 * 混在一起会让人以为它们只是 normalizeLayer 的局部细节，实际上它们是**跨入口的规则**：
 * AI 输出、IPC 回包、模板补齐走的是同一套判据，任何一处放宽都是一次单据面的漂移。
 *
 * ⚠ 这里所有函数都**不接受**"默认值缺省"的情形：默认值由调用方显式传入。
 * 因为默认值是产品决策（文字用什么色、占位文案写什么），不该藏在一个工具函数里。
 */

/** 形状层默认填充色。`strokeOf` 与 `normalizeLayer` 都要用，所以从这里出。 */
export const DEFAULT_SHAPE_FILL = '#1f7a4d';

const DEFAULT_STROKE_WIDTH = 2;
/** 多边形顶点上限。AI 偶尔给上万个点，canvas 逐点描边会卡住渲染线程（不报错，只是卡）。 */
const MAX_POLYGON_POINTS = 256;
/** 字重白名单。给 437 这种值浏览器会合成字重（笔画糊），所以吸附到最近的合法档。 */
const ALLOWED_WEIGHTS: readonly number[] = [400, 500, 600, 700, 800, 900];
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** 冻结的空表，让 `recordOf` 的返回值永远可索引（调用方不必到处判 null）。 */
export const EMPTY_RECORD: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * 是否合法的十六进制颜色（`#rgb` / `#rrggbb`，大小写不限）。
 *
 * 只认这两种形态：`#rrggbbaa`、`rgb(1,2,3)`、`red` 一律算非法 ——
 * 模型层只存导出时无歧义的写法（见 `model/layer.ts` 的 `color` 注释）。
 *
 * @param value 任意输入
 * @returns 是合法颜色时为 true（并收窄成 string）
 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

/**
 * `unknown` ⇒ 可读的键值表。不是对象就给冻结空表。
 *
 * @param raw 任意输入
 * @returns 可安全用 `src['field']` 索引的只读表
 */
export function recordOf(raw: unknown): Readonly<Record<string, unknown>> {
  return typeof raw === 'object' && raw !== null ? (raw as Readonly<Record<string, unknown>>) : EMPTY_RECORD;
}

/**
 * 文本字段窄化。
 *
 * 数字型保留（AI 常把「2026」这种年份写成数字）；其余类型一律空串 ——
 * 把 `{a:1}` 拼成 `"[object Object]"` 画到海报上，比空着更糟。
 *
 * @param raw 任意输入
 * @param fallback 取不到合法文本时的回落值
 * @returns 字符串
 */
export function textOf(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && raw !== '') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return fallback;
}

/**
 * **只认字符串**的字段窄化（图片 `src`）。
 *
 * 与 `textOf` 的区别是本文件里唯一容易搞混的一处，值得写清楚：
 * `textOf` 会把数字转成字符串（`text: 2026` ⇒ `'2026'`，AI 常把年份写成数字，这是**要的**）；
 * 但 `src: 0` 用同一套规则会变成字符串 `'0'` —— 一条**必然 404 的 URL**。
 * 它不是"空图"也不是"加载失败"，而是一个看起来有值的坏地址：`placeholder` 会被算成 false，
 * 用户看不到"这里本该放图"的虚线框，只看到一片空白。
 *
 * @param raw 任意输入
 * @returns 字符串（非字符串一律空串）
 */
export function stringOf(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

/**
 * 颜色字段窄化：不合法就落回默认色。
 *
 * ★ 这一条是本模块最值钱的判据：`ctx.fillStyle = '#12345'` **不报错**，
 *   浏览器直接忽略这次赋值，于是画布**静默沿用上一次的 fillStyle** ——
 *   上一层是绿色，这一层本该白底，结果也是绿色。渲染侧看到的是"合法字符串"，
 *   根本无从判断；只能在归一化这层把非法色换成确定值。
 *
 * @param raw 任意输入
 * @param fallback 默认色
 * @returns 合法颜色
 */
export function colorOf(raw: unknown, fallback: string): string {
  return isHexColor(raw) ? raw : fallback;
}

/**
 * 角度归一：`720 → 0`，`-450 → -90`。
 *
 * 用取模而不是"截断到 [-360,360]"：720 度与 0 度**视觉上就是同一个角度**，
 * 截断会让同一姿态存成两个值，于是"改了再改回来"在撤销栈里多出一层。
 * 保留符号（-450 得 -90 而不是 270），因为用户和 AI 都是按"往回拧 450 度"给的。
 *
 * @param raw 任意输入
 * @returns 落在 (-360, 360) 的角度
 */
export function rotationOf(raw: unknown): number {
  const rawNumber = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const wrapped = rawNumber % 360;
  return wrapped === 0 ? 0 : wrapped; // 把 -0 归一成 0：二者深度比较并不相等
}

/**
 * 字重吸附到白名单里最近的一档。
 *
 * @param raw 任意输入
 * @returns 400 / 500 / 600 / 700 / 800 / 900 之一
 */
export function weightOf(raw: unknown): number {
  const target = typeof raw === 'number' && Number.isFinite(raw) ? raw : 600;
  let best = 400;
  let bestGap = Infinity;
  for (const weight of ALLOWED_WEIGHTS) {
    const gap = Math.abs(weight - target);
    if (gap < bestGap) {
      best = weight;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * 描边窄化。宽度 ≤0 归一成 `null` —— "有描边但宽 0"是没有意义的中间态，
 * 留着它会让渲染层为一条看不见的线开一次 stroke 通道。
 *
 * @param raw 任意输入
 * @returns `{ color, width }` 或 `null`
 */
export function strokeOf(raw: unknown): { color: string; width: number } | null {
  const src = recordOf(raw);
  if (src === EMPTY_RECORD) return null;
  const width = typeof src['width'] === 'number' && Number.isFinite(src['width'])
    ? src['width']
    : DEFAULT_STROKE_WIDTH;
  if (width <= 0) return null;
  return { color: colorOf(src['color'], DEFAULT_SHAPE_FILL), width: Math.min(width, 256) };
}

/**
 * 多边形顶点窄化。**非 polygon 一律清空**：留在 rect 上的顶点是"看不见的多余状态"，
 * 一旦有人把 shapeKind 改成 polygon，那些陈旧顶点会突然冒出来。宁可丢掉。
 *
 * @param raw 任意输入
 * @param kind 形状种类
 * @returns 顶点数组（`polygon` 之外恒为空数组）
 */
export function pointsOf(
  raw: unknown,
  kind: 'rect' | 'ellipse' | 'line' | 'polygon',
): ReadonlyArray<{ x: number; y: number }> {
  if (kind !== 'polygon' || !Array.isArray(raw)) return [];
  const out: { x: number; y: number }[] = [];
  for (const item of raw) {
    if (out.length >= MAX_POLYGON_POINTS) break;
    if (typeof item !== 'object' || item === null) continue;
    const point = item as Readonly<Record<string, unknown>>;
    const x = typeof point['x'] === 'number' && Number.isFinite(point['x']) ? Math.round(point['x']) : 0;
    const y = typeof point['y'] === 'number' && Number.isFinite(point['y']) ? Math.round(point['y']) : 0;
    out.push({ x, y });
  }
  return out;
}

/**
 * 图层种类窄化。未知 type 一律当文字层。
 *
 * 为什么默认不是 image/shape：文字层不依赖图源（`src` 空着也能画出文字），
 * 而 image/shape 缺字段时会变成一层**完全看不见**的东西 ——
 * 用户只知道"图没了"，却连一个可选中的对象都找不到。
 *
 * @param src 键值表
 * @returns 'text' | 'image' | 'shape'
 */
export function layerKindOf(src: Readonly<Record<string, unknown>>): 'text' | 'image' | 'shape' {
  const raw = src['type'];
  if (raw === 'image') return 'image';
  if (raw === 'shape') return 'shape';
  return 'text';
}
