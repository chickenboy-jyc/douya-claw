/**
 * 图层 id 生成 —— **可注入序列**，不是「Date.now() + 随机数」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 现有实现的两个真问题（`PosterStudio.jsx:136` 的 `makeId()`）
 * ════════════════════════════════════════════════════════════════════════════
 * 它写的是 `type + '-' + Date.now().toString(36) + '-' + seq`，已经带了自增，
 * 所以"同一毫秒批量建层会撞"其实**不成立**（自增兜住了）。真正的问题是另外两个：
 *
 * ① `seq` 是**渲染进程内**的。同一份文档被两个窗口编辑（或主/渲染两侧各建一层）时，
 *    两边都从 1 开始数 ⇒ 撞号。而撤销栈是按 id 找图层的，撞号 = **撤销改错层**。
 *    这种故障在单窗口测试里永远复现不出来。
 * ② 没有可注入点 ⇒ 测试只能断言"id 是不含空格的非空字符串"，
 *    除此之外什么都断言不了（不可复现的东西无法写期望值）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 这里的形态：`<kind>-<boot>-<salt>-<seq>`
 * ════════════════════════════════════════════════════════════════════════════
 *   · `boot`  —— 进程启动时刻（base36）。让 id 可读地带出"哪一次启动"。
 *                取一次就固定，不是每层取 `Date.now()`：后者只让 id 变长，不提供额外保证。
 *   · `salt`  —— 每次启动随机一次的 24 位片段。**全 id 里唯一不可复现的一段**，
 *                它挡的正是 ① 那种"两个进程从同一个 seq 开始数"的撞车。
 *   · `seq`   —— 进程内自增，保证同一进程连续调用绝不重号（测试跑 10000 次）。
 *
 * 传 `seed` 时 id **完全**由 `kind + seed` 决定，不含时间与随机 ⇒ 可复现，可写期望值。
 * 代价是调用方要自己保证 seed 唯一；真撞了由 `addLayer` 兜住（见 ops.ts）。
 */

import type { Layer, LayerKind } from '../model/layer';

/** 启动时刻（base36）。模块加载期取一次，之后不变。 */
const BOOT_STAMP = Date.now().toString(36);

/** 每次启动随机一次的片段。全 id 里**唯一**不可复现的一段，用途见文件头 ①。 */
const BOOT_SALT = Math.floor(Math.random() * 0x1000000).toString(36);

/** 进程内自增序号。 */
let seq = 0;

/**
 * 造一个图层 id。
 *
 * @param kind 图层类型（进 id 只为可读性，不参与唯一性判断）
 * @param seed 可选的确定性序号；给了就**完全**跳过时间与随机片段（测试专用）
 * @returns 形如 `text-m3k2p-a1b2c3-1`（有 seed 时形如 `text-s7`）
 */
export function makeLayerId(kind: LayerKind, seed?: number): string {
  if (seed !== undefined) {
    const n = Number.isFinite(seed) ? Math.trunc(seed) : 0;
    return String(kind) + '-s' + n.toString(36);
  }
  seq += 1;
  return String(kind) + '-' + BOOT_STAMP + '-' + BOOT_SALT + '-' + seq.toString(36);
}

/**
 * 换一个 id，其余字段原样。
 *
 * 为什么写成 switch 而不是 `{ ...layer, id }`：对 `Layer`（判别联合）直接做对象展开时，
 * TS 会把 `type` 算成宽的 `LayerKind`，返回值就不再是 `Layer` 了（编译器当场丢判别信息）。
 * 三个分支各自窄化成具体图层，是最短的、**编译期不会退化**的写法。
 *
 * ★★ 为什么必须有 `default: never`（2026-11-02 实测补的，不是防御性洁癖）★★
 * 此函数的返回类型是 `Layer`（**不含 undefined**），所以"缺分支"时 TS2366 会报错 ——
 * 这一点我实测过（给 `Layer` 联合加真实成员，本函数确实被拦住）。
 * **但 TS2366 只保护编译期。** 运行期拿一个 `type` 不在三者之内的对象进来
 * （旧存档手改 / AI 直出 / `as` 断言），这个 switch 会**落到函数末尾**，
 * 于是它**返回 `undefined`，而类型声明说它返回 `Layer`** —— 一个类型谎言。
 * 实测：`withLayerId({type:'bogus', …}, 'NEW')` ⇒ `undefined`。
 *
 * 调用方拿到 undefined 之后的链式后果：`{ ...undefined }` 是 `{}`、
 * 存进数组会变成 `[undefined]`、再传到 `normalizeLayer` 就是"默认空白文字层"。
 *
 * `default` 里把 `never` 赋值 + 抛错，同时解决两件事：
 *   · 编译期：将来 `Layer` 加成员而这里没补 ⇒ TS2322；
 *   · 运行期：非法 type ⇒ **抛错带类型名**，而不是返回 undefined。
 *
 * @param layer 原图层（不会被修改）
 * @param id 新 id
 * @returns 新图层对象
 * @throws RangeError `layer.type` 不在已知三种之内（只可能来自绕过类型的调用方）
 */
export function withLayerId(layer: Layer, id: string): Layer {
  switch (layer.type) {
    case 'text':
      return { ...layer, id };
    case 'image':
      return { ...layer, id };
    case 'shape':
      return { ...layer, id };
    default: {
      const exhaustive: never = layer;
      // 取原始 type 用于报错：`exhaustive` 已被收窄成 `never`，直接 String 会得到
      // `[object Object]` —— 那条消息等于没说（正是本注释上一段批评的形态）。
      const rawType: unknown = (layer as Layer).type;
      throw new RangeError(
        `withLayerId: 未知的图层类型 ${String(rawType)}（Layer 有新成员但未在此处理）`,
      );
    }
  }
}

/**
 * 只给测试用：把自增序号归零。
 *
 * 生产代码**不许**调 —— 归零之后新 id 会与本次启动早先产出的 id 撞号
 * （`boot`/`salt` 相同、`seq` 重复）。存在它的唯一理由是让测试能在同一进程里
 * 反复验证"从 0 起连发 N 个不重号"，而不必靠子进程。
 */
export function __resetLayerIdCounterForTests(): void {
  seq = 0;
}
