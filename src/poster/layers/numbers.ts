/**
 * 数值窄化与夹紧 —— 只做这一件事。
 *
 * 为什么单独成文件：`normalize` / `ops` / `ops-move` / `ops-resize` 四处都要
 * "非有限数就回落到默认值"、"夹到区间"、"下标夹到合法范围"。各写一份的下场是
 * 四份判据慢慢漂移（比如某一份忘了判 `NaN`），而这类差异只会在极端输入下才暴露。
 *
 * ⚠ 与现有 JS 实现（`PosterStudio.jsx:142` 的 `num()`）的**唯一**区别：
 *   那边用 `Number(value)`，于是 `Number('') === 0`、`Number(null) === 0`、
 *   `Number(true) === 1`、`Number('  ') === 0` —— 空串/空值会被**静默变成数字 0**，
 *   看起来"有值"，实际是"没值但被当成了 0"。这里只认 `typeof === 'number'`。
 */

/**
 * 取一个有限数，否则回落。
 *
 * @param value 任意输入（磁盘 JSON / AI 输出 / IPC 都可能给任何东西）
 * @param fallback 非有限数时的回落值
 * @returns 有限的 number
 */
export function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 取一个整数（四舍五入），否则回落。
 *
 * @param value 任意输入
 * @param fallback 非有限数时的回落值
 * @returns 整数
 */
export function asRoundedInt(value: unknown, fallback: number): number {
  return Math.round(asFiniteNumber(value, fallback));
}

/**
 * 把数值夹进 `[min, max]`。入参已保证是有限数（上游都走 `asFiniteNumber`）。
 *
 * @param value 有限数
 * @param min 下限
 * @param max 上限
 * @returns 夹紧后的值
 */
export function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 把数组下标夹进 `[0, max]`（**闭区间**，因为插入位置可以是 `length`）。
 *
 * 非有限数回落到 0 而不是 `max`：调用方给了一个说不清的值时，
 * "放到最底层"比"放到最顶层"更不容易被误认为成功（`addLayer` 省略 `at` 时
 * 走的是另一条显式路径，不经过这里）。
 *
 * ★★ 本函数是 `withLayerId` / `findLayer` 的**前置防线**（2026-11-02 实测发现）★★
 * 机制：这里不夹上界 ⇒ 下游拿到越界下标 ⇒ `layers[idx]` 是 `undefined`
 * ⇒ `withLayerId` 拿到 undefined ⇒ 走到它那个 `default: never` 分支之外的老路径
 * ⇒ **返回 `undefined`，而返回类型声明是 `Layer`**（类型谎言）。
 *
 * **为什么这条关系必须写在这里**：它坏掉时，**报警点离根因很远** ——
 * 实测变异（把 `clampNumber(..., 0, max)` 改成 `Math.max(0, ...)`，不夹上界）后：
 *   红条是 `B5`（clampIndex 直接测）+ `E22 校验：…switch 齐备…`（指向 id.ts）
 *   + `E23 …返回了 undefined`（指向 id.ts）
 * ⇒ 三个报警点里两个指向 `id.ts`，而根因在**本文件第 61 行**。
 * 下一个看到 `id.ts` 红条的人应该先想想"是谁给了越界下标"。
 *
 * @param value 期望下标（可能是小数 / NaN / Infinity）
 * @param max 合法上界（含）
 * @returns 合法下标
 */
export function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampNumber(Math.trunc(value), 0, max);
}
