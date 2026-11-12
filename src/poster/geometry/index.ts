/**
 * 几何图元模块的对外入口。
 *
 * 只做再导出，不含任何逻辑 —— 目的是让下游只记一个路径：
 * `import { drawShapeLayer } from '../geometry';`
 * 而不是记住"路径在 path.ts、线在 line.ts、策略在 draw.ts"这种内部布线。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么这里只有 10 个名字（不是"能导的都导"）
 * ════════════════════════════════════════════════════════════════════════════
 * 单文件导出上限是 12（`unit-ts-strict.mjs` 的 `MAX_EXPORTS`，实测本文件第一版
 * 14 个被当场判红）。但**不要**为了凑数随手砍 —— 砍的标准是"有没有人会真的从
 * barrel 拿它"：
 *
 *   · `drawLine` 只有 `draw.ts` 调用它（同模块内的邻居），走相对路径 import 更直接。
 *     放进 barrel 会让它看起来是公共 API，将来有人从外部调它就会绕过
 *     `drawShapeLayer` 的 save/restore 与字段守卫。
 *   · `isUsableBox` / `isUsablePoint` / `Point` 是**几何内部的前置条件**。
 *     外部要判的话应该用 `normalizeLayer`（它的职责就是保证数据合法），
 *     而不是在渲染前自己判 —— 那会形成第二套判据。
 *   · 留下来的每个名字都有一个明确的**外部**理由（见下方分组注释）。
 *
 * ★ 语义提示：`import` 本文件（或 `./draw`）会**顺带注册** `'shape'` 渲染器
 *   （`draw.ts` 顶层调用 `registerLayerRenderer`）。这是有意的：接线不该是一个
 *   需要人记得调用的 `init()`。反过来说，**不要**为了"看看类型"而 import 本文件 ——
 *   它会带来注册副作用。只需要类型时用 `import type`。
 *
 * ★ `isolatedModules: true` 下，类型必须用 `export type` 再导出。
 *   写成 `export { LineDir }` 会被 Vite 逐文件转译成一次**真实的值导入**，
 *   而 `LineDir` 在运行时不存在 ⇒ 运行期直接报 "does not provide an export named"。
 */

// ── 渲染器（装配层与测试用；import 本模块即触发注册）──────────────────────
export { drawShapeLayer } from './draw';

// ── 线的方向策略（模板编辑器要按方向显示把手，测试要断言推断结果）──────────
export { resolveLineDir } from './line';

// ── 路径构造（单测直接断言路径；将来导出 SVG 也要用同一套几何）──────────────
export { clampRoundRadius, ellipsePath, roundRectPath } from './path';
export { linePath, polygonPath } from './polyline';

// ── 失败类型与线宽契约（调用方靠 `instanceof` 区分"几何非法"与"渲染器 bug"）──
export { MIN_STROKE_WIDTH, ShapeDrawError } from './guards';

// ── 类型（`export type`，理由见文件头）──────────────────────────────────────
export type { LineDir } from './polyline';
