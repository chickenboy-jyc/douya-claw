/**
 * 图层结构操作：增 / 删 / 改 / 查。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 两条贯穿全文件的规矩
 * ════════════════════════════════════════════════════════════════════════════
 * ① **纯函数**：吃 `PosterDoc`，吐**新** `PosterDoc`；入参一个字段都不改。
 *    这条不靠注释保证 —— 测试会用 `Object.freeze` 深冻结入参再跑一遍每个 ops，
 *    有任何一处写操作都会当场 `TypeError`（严格模式下写冻结对象直接抛）。
 * ② **z 不变量**：任何结构变化之后都走 `compactZ`，让 `layers[i].z === i + 1`
 *    且数组顺序就是叠放顺序。理由见 `z-order.ts`（"上移一层点不动"的根因）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么 `updateLayer` 的 patch 不是 `Partial<Layer>`
 * ════════════════════════════════════════════════════════════════════════════
 * `Partial<Layer>` 是"所有成员的字段的并集的全部可选"，于是给 shape 层传
 * `{ fontSize: 20 }` 也能编译通过，运行时被打到形状层上 —— 一个永远不会被渲染、
 * 却会随文档一起存盘的字段。这不是"运行时才发现"的问题，是**类型该拦住**的问题。
 *
 * 这里用**判别标签 + 对应成员的可选字段**：
 *   `{ type: 'shape', fill: '#fff' }`        ✅
 *   `{ type: 'shape', fontSize: 20 }`        ❌ 编译报错（shape 成员没有 fontSize）
 *   `{ fill: '#fff' }`（不写 type）           ❌ 编译报错（标签是必填的）
 * 标签必填还有第二个好处：运行时能校验"调用方以为的种类"和"图层真实种类"是否一致，
 * 不一致就**拒绝更新并原样返回**，而不是把字段硬打上去。
 */

import type { ImageLayer, Layer, ShapeLayer, TextLayer } from '../model/layer';
import type { PosterDoc } from '../model/doc';
import { makeLayerId, withLayerId } from './id';
import { clampIndex } from './numbers';
import { normalizeLayer } from './normalize';
import { compactZ, renumberByOrder } from './z-order';

/** 文字层的部分更新。`id` / `type` 不许改（改了就不是"更新"而是"换层"）。 */
type TextLayerPatch = { readonly type: 'text' } & Partial<Omit<TextLayer, 'id' | 'type'>>;
/** 图片层的部分更新。 */
type ImageLayerPatch = { readonly type: 'image' } & Partial<Omit<ImageLayer, 'id' | 'type'>>;
/** 形状层的部分更新。 */
type ShapeLayerPatch = { readonly type: 'shape' } & Partial<Omit<ShapeLayer, 'id' | 'type'>>;

/** 类型安全的部分更新：种类与字段必须自洽。 */
export type LayerPatch = TextLayerPatch | ImageLayerPatch | ShapeLayerPatch;

/**
 * 按 id 找图层。
 *
 * @param doc 文档
 * @param id 图层 id
 * @returns 找到的图层，或 `null`（不返回 undefined：调用方少一处窄化）
 */
export function findLayer(doc: PosterDoc, id: string): Layer | null {
  return doc.layers.find((layer) => layer.id === id) ?? null;
}

/**
 * 加一层。
 *
 * `at` 是**数组下标**（0 = 最底层），不是 z —— 界面上"插到这一层上面"拿到的是下标，
 * 而 z 是派生量，让调用方算 z 只会算错。
 *
 * ★ 插入后**按数组顺序**重编 z（`renumberByOrder`），**不能**再按 z 排一次：
 *   传进来的图层可能自带 `z: 1`（"我刚新建的，当然是第一层"），若按 z 重排，
 *   新层会被排到最底层 —— 用户点"加文字"，文字跑到所有图下面去了。
 *
 * id 撞号时**重新铸一个**而不是静默放过：撤销栈按 id 找图层，撞号 = 撤销改错层
 * （复制图层、AI 复用 id 都会走到这里）。
 *
 * @param doc 文档
 * @param layer 要加的图层（本身应已合法；这里仍会再归一化一次，因为调用方可能来自 JS）
 * @param at 插入下标，省略则加到最上层
 * @returns 新文档
 */
export function addLayer(doc: PosterDoc, layer: Layer, at?: number): PosterDoc {
  const count = doc.layers.length;
  const index = at === undefined ? count : clampIndex(at, count);
  const taken = doc.layers.some((item) => item.id === layer.id);
  const incoming = taken ? withLayerId(layer, makeLayerId(layer.type)) : layer;
  const next = doc.layers.slice();
  next.splice(index, 0, normalizeLayer(incoming, index));
  return { ...doc, layers: renumberByOrder(next) };
}

/**
 * 删一层。id 不存在时原样返回（不抛错：删除是幂等的，连点两次不该炸）。
 *
 * @param doc 文档
 * @param id 图层 id
 * @returns 新文档
 */
export function removeLayer(doc: PosterDoc, id: string): PosterDoc {
  const next = doc.layers.filter((layer) => layer.id !== id);
  if (next.length === doc.layers.length) return doc;
  return { ...doc, layers: renumberByOrder(next) };
}

/**
 * 部分更新一层。
 *
 * 更新结果**再过一遍 `normalizeLayer`**：于是 patch 里塞进来的非法值
 * （`color: 'not-a-color'`、`rotation: 720`、`opacity: 9`）和其它入口一样被夹紧/归一，
 * 不会出现"从 UI 改的合法、从 AI 改的不合法"两套口径。
 *
 * patch 带 `z` 时会被 `compactZ` 重新排序（AI 想直接指定层级就走这条路）。
 *
 * @param doc 文档
 * @param id 图层 id
 * @param patch 判别标签 + 该种类允许的字段
 * @returns 新文档；id 不存在或标签与真实种类不符时**原样返回**
 */
export function updateLayer(doc: PosterDoc, id: string, patch: LayerPatch): PosterDoc {
  const index = doc.layers.findIndex((layer) => layer.id === id);
  if (index < 0) return doc;
  const current = doc.layers[index];
  if (current === undefined) return doc;
  const merged = applyPatch(current, patch);
  if (merged === null) return doc;
  const next = doc.layers.slice();
  next[index] = normalizeLayer(merged, index);
  return { ...doc, layers: compactZ(next) };
}

/**
 * 把 patch 合进图层。标签不符返回 `null`。
 *
 * 返回值标成 `unknown` 是故意的：合并后的对象要交给 `normalizeLayer`（入参 `unknown`）
 * 统一校验，而**不**依赖对象展开推导出的类型 —— 对判别联合做展开会把 `type`
 * 拓宽成 `LayerKind`，那样得到的"类型"是假的。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 为什么这里必须有 `default: never`（这不是防御性编程，是补一个编译期洞）★★
 * ════════════════════════════════════════════════════════════════════════════
 * 返回类型是 `unknown` 而不是 `Layer`，于是**隐式 `undefined` 是合法返回值** ——
 * `Function lacks ending return statement`（TS2366）**永远不会在这里触发**。
 * 实测（2026-11-02）：给 `model/layer.ts` 加一个真实成员 `ArrowLayer` 并加进
 * `Layer` 联合后跑 `tsc`，本模块的另外两个 switch（`id.ts` 的 `withLayerId`、
 * `z-order.ts` 的 `withZ`）都报 TS2366 **被拦住了**，唯独这里**一条报错都没有**。
 *
 * 而漏掉的后果不是"少一个字段"，是**静默数据丢失**：
 *   `applyPatch` 落空 ⇒ 返回 `undefined` ⇒ `updateLayer` 把它喂给
 *   `normalizeLayer(undefined, i)` ⇒ 产出**默认空白文字层**。
 * 实测：`normalizeLayer(undefined, 0)` = `{type:'text', name:'文字', text:'', w:200, h:100}`。
 * 即一个 `shape` 图层被悄悄换成空 `text` 图层 —— 内容全丢、类型变了、
 * 无报错、无诊断，`layers[i].z === i+1` 不变量还完好无损，所以连门禁都不响。
 *
 * `default` 分支里的 `const exhaustive: never = patch` 把这个洞补上：
 * 将来 `LayerPatch` 加成员而这里没补 case ⇒ **TS2322 编译报错**；
 * 运行期遇到非法 type（旧存档 / JS 调用方 / `as` 断言）⇒ **抛错带 node 标签**，
 * 而不是把 `undefined` 静默传下去。
 * （判据与写法来自 `eng-poster-geometry`：`never` 穷尽检查优于"省略 default 靠 TS2366"，
 *   因为后者牺牲了运行时消息的准确性，而运行时的非法数据恰恰最需要准确消息。）
 *
 * @param current 当前图层
 * @param patch 部分更新
 * @returns 合并后的原始对象，或 `null` 表示拒绝
 * @throws RangeError patch.type 不在已知三种之内（只可能来自绕过类型的调用方）
 */
function applyPatch(current: Layer, patch: LayerPatch): unknown {
  switch (patch.type) {
    case 'text': {
      if (current.type !== 'text') return null;
      const { type: _tag, ...fields } = patch;
      return { ...current, ...fields };
    }
    case 'image': {
      if (current.type !== 'image') return null;
      const { type: _tag, ...fields } = patch;
      return { ...current, ...fields };
    }
    case 'shape': {
      if (current.type !== 'shape') return null;
      const { type: _tag, ...fields } = patch;
      return { ...current, ...fields };
    }
    default: {
      // 走到这里 ⇒ `LayerPatch` 加了成员但这个 switch 没补 —— 编译期会报 TS2322。
      // 运行期只可能来自绕过类型的调用方，此时**必须抛**（不能返回 undefined）：
      // 返回 undefined 会在 updateLayer 里变成"默认空白文字层"，静默丢数据。
      const exhaustive: never = patch;
      throw new RangeError(
        `applyPatch: 未知的 patch.type ${String(exhaustive)}（LayerPatch 有新成员但未在此处理）`,
      );
    }
  }
}

// 上下移动 / 拖拽排序见 ops-move.ts，改画布尺寸见 ops-resize.ts。
// 这里转出它们，是为了让消费方只 import 一个入口，不必知道内部怎么拆的。
export { moveLayer, reorderLayer } from './ops-move';
export { setCanvasSize } from './ops-resize';
