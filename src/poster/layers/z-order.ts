/**
 * 叠放顺序的唯一真源：**`layers` 数组顺序就是叠放顺序，且 `layers[i].z === i + 1`**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么必须把 z 压紧成连续整数（这一条最容易被当成"多余的一步"）
 * ════════════════════════════════════════════════════════════════════════════
 * 存档里的 z 可能长成 10 / 30 / 70（手改过、或从别的模板合并过来）。这时如果把
 * "上移一层"实现成 `z - 1`，结果会变成 10 / 29 / 70 —— **看上去动了，实际层级没变**
 * （中间那个还是中间那个）。用户点三次按钮，图层纹丝不动，于是判定"按钮坏了"。
 * 这是本仓海报模块"上移/下移"最典型的失效形态，而且它在 UI 上完全不可见。
 *
 * 反过来，若 z 全部相等（模板批量产出时常见），"上移"在 z 上根本没有方向，
 * 只能退回数组顺序 —— 那 z 就不是真源了，两套真源迟早打架。
 *
 * 结论：**任何一次结构变更之后都重新压紧**，让 z 永远是 1..n 且与数组下标一一对应。
 * 代价是 z 失去了"留空隙方便插层"的能力；本产品不需要它 —— 插入位置按**索引**给
 * （见 `ops.ts` 的 `addLayer`），不按 z 给。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么是**两个**函数而不是一个（这里是真正容易写错的一格）
 * ════════════════════════════════════════════════════════════════════════════
 * 有两个方向完全相反的场合，用同一个函数必然写错其中一边：
 *
 *   · `compactZ`      —— **z 说了算**。用于"从外部读进来"（存档 / AI 输出 / IPC）：
 *                        此时数组顺序没有任何意义，唯一的顺序信息只存在 z 里。
 *   · `renumberByOrder` —— **数组顺序说了算**。用于"刚刚亲手排好序"（插入、删除、
 *                        拖拽到位）：此时数组已经是对的，而每个图层身上带的 z 是**旧的**。
 *                        若这时再按 z 排一次，等于用旧顺序覆盖新顺序 ——
 *                        表现就是"上移一层点了没反应"。
 *
 * 交付前实测踩过这个坑：`moveLayer` 里误用 `compactZ` ⇒ 三条移动断言全红，
 * 且失败信息看起来像"移动函数没被调用"（顺序与入参完全一致），极易归因到错误的地方。
 */

import type { Layer } from '../model/layer';

/**
 * 单层换 z。
 *
 * switch 而不是 `{ ...layer, z }`：对判别联合做对象展开会让 `type` 拓宽成 `LayerKind`，
 * 返回值不再是 `Layer`（同 `id.ts` 的 `withLayerId`）。
 *
 * ★ `default: never` 的理由与 `withLayerId` 完全相同（见那边更长的说明）：
 *   返回类型窄 ⇒ TS2366 在编译期有效，但**运行期非法 type 会落到函数末尾返回
 *   `undefined`，而类型声明说返回 `Layer`**。实测确认过这个类型谎言。
 *
 * @throws RangeError `layer.type` 不在已知三种之内
 */
function withZ(layer: Layer, z: number): Layer {
  switch (layer.type) {
    case 'text':
      return { ...layer, z };
    case 'image':
      return { ...layer, z };
    case 'shape':
      return { ...layer, z };
    default: {
      const exhaustive: never = layer;
      // 取原始 type 用于报错：`exhaustive` 已被收窄成 `never`，直接 String 会得到
      // `[object Object]` —— 那条消息等于没说（正是本注释上一段批评的形态）。
      const rawType: unknown = (layer as Layer).type;
      throw new RangeError(
        `withZ: 未知的图层类型 ${String(rawType)}（Layer 有新成员但未在此处理）`,
      );
    }
  }
}

/**
 * 按 z 升序**稳定**排序，并把 z 压紧成 1..n。返回新数组，不修改入参。
 *
 * 用在"从外部读进来"的一侧（`normalizeDoc`、`updateLayer` 的带 z 更新）。
 *
 * 稳定性为什么重要：z 相等的图层（模板批量产出时常见）必须保持原数组顺序，
 * 否则"打开一次项目，两个同级图层的上下关系就翻一次"——用户会看到图片莫名跑到文字下面。
 *
 * z 已经正确的图层**原样复用**（不复制），于是"什么都没变"的调用产出的新 doc
 * 与原 doc 深度相等，撤销栈里也不会多出一层"看起来一样"的快照。
 *
 * @param layers 任意顺序 / 任意 z 的图层数组（只读）
 * @returns z 为 1..n 且按升序排列的新数组
 */
export function compactZ(layers: readonly Layer[]): Layer[] {
  const slots = layers.map((layer, order) => ({ layer, order }));
  slots.sort((a, b) => (a.layer.z - b.layer.z) || (a.order - b.order));
  return slots.map((slot, i) => (slot.layer.z === i + 1 ? slot.layer : withZ(slot.layer, i + 1)));
}

/**
 * **按数组顺序**重编 z（不排序）。返回新数组，不修改入参。
 *
 * 用在"刚刚亲手排好序"的一侧（`addLayer` / `removeLayer` / `moveLayer` / `reorderLayer`）：
 * 那时数组顺序才是新事实，图层身上带的 z 是旧事实。见文件头那一节。
 *
 * @param layers 已经排好序的图层数组（只读）
 * @returns z 为 1..n 的新数组（顺序与入参一致）
 */
export function renumberByOrder(layers: readonly Layer[]): Layer[] {
  return layers.map((layer, i) => (layer.z === i + 1 ? layer : withZ(layer, i + 1)));
}
