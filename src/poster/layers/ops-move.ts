/**
 * 图层叠放位置调整：上下移动（按钮）与拖拽排序（拖拽）。
 *
 * 两者都是"把某一层挪到另一个下标再压紧 z"，区别只在**入参怎么表达目标**：
 *   · `moveLayer` 收的是**相对位移**（`+1` / `-1`），因为 UI 上是两个按钮；
 *   · `reorderLayer` 收的是**绝对下标**，因为拖拽落点本身就是一个位置。
 * 分开而不是用一个 `toIndex` 兼两种语义，是因为"上移一层"在最顶层时**不是**
 * "挪到 index-1"（那会变成 -1）—— 到边界必须**原样返回**，而不是循环到底部。
 * 用户点"上移"看到图层从最上层跳到最下层，会以为程序疯了。
 */

import type { PosterDoc } from '../model/doc';
import { clampIndex } from './numbers';
import { renumberByOrder } from './z-order';

/**
 * 把 `from` 处的图层挪到 `to` 处。
 *
 * ★ 用 `renumberByOrder` 而不是 `compactZ`：这里数组顺序是**刚刚亲手排好的新事实**，
 *   而图层身上带的 z 是**旧事实**。再按 z 排一次等于用旧顺序覆盖新顺序 ——
 *   表现就是"上移一层点了没反应"（交付前实测踩过，见 z-order.ts 文件头）。
 *
 * @param doc 文档
 * @param from 源下标（调用方已保证合法）
 * @param to 目标下标（调用方已保证合法）
 * @returns 新文档
 */
function moveTo(doc: PosterDoc, from: number, to: number): PosterDoc {
  const next = doc.layers.slice();
  const moved = next.splice(from, 1);
  const layer = moved[0];
  if (layer === undefined) return doc;
  next.splice(to, 0, layer);
  return { ...doc, layers: renumberByOrder(next) };
}

/**
 * 上下移动 `deltaZ` 层。
 *
 * 到顶/到底时**原样返回**（深度相等，不是抛错、也不是循环）：按钮在那个方向上是
 * 无意义的，最诚实的反馈就是"什么都没发生"。
 *
 * @param doc 文档
 * @param id 图层 id
 * @param deltaZ 相对位移（正数上移）。非有限数按 0 处理
 * @returns 新文档
 */
export function moveLayer(doc: PosterDoc, id: string, deltaZ: number): PosterDoc {
  const from = doc.layers.findIndex((layer) => layer.id === id);
  if (from < 0) return doc;
  const step = Number.isFinite(deltaZ) ? Math.trunc(deltaZ) : 0;
  if (step === 0) return doc;
  const to = clampIndex(from + step, doc.layers.length - 1);
  if (to === from) return doc;
  return moveTo(doc, from, to);
}

/**
 * 拖拽排序：把第 `id` 层挪到下标 `toIndex`。
 *
 * 越界下标**夹紧**而不是拒绝：拖到列表外面的视觉落点会被 UI 算成"超过末行"，
 * 那里夹到末行正是用户期待的结果。
 *
 * @param doc 文档
 * @param id 图层 id
 * @param toIndex 目标下标
 * @returns 新文档
 */
export function reorderLayer(doc: PosterDoc, id: string, toIndex: number): PosterDoc {
  const from = doc.layers.findIndex((layer) => layer.id === id);
  if (from < 0) return doc;
  const to = clampIndex(toIndex, doc.layers.length - 1);
  if (to === from) return doc;
  return moveTo(doc, from, to);
}
