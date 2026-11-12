import { routeForGoal } from '../store/goalCatalog.js';

/**
 * route 里没写 gap 时的兜底文案（给用户看的「为什么暂时做不了」）。
 * @type {string}
 */
const FALLBACK_GAP = '该目标暂未配置工作流。';

/**
 * 目标「当前是否可执行」的**唯一**判据。
 *
 * 真源 = goalCatalog.routeForGoal：
 *   module 非空 且 steps 非空 ⇒ 可执行（executable: true）
 *   否则（module 为 null / steps 为空 / 未命中回落）⇒ 视为未开通（executable: false）
 *
 * 纯函数、无副作用：GoalSelector（点击前置）与 GoalPlanPreview（兜底层）都从这里取值，
 * 避免「两处各写一套判断，日后漂移」。
 *
 * @param {string} goalId 目标 id（如 'dealer-inventory' / 'dealer-channel'）
 * @returns {{executable: boolean, gap: string}} gap 为给用户看的「为什么暂时做不了」（已 trim，空则兜底）
 */
export function goalExecutability(goalId) {
  let route = null;
  try {
    route = routeForGoal(goalId);
  } catch {
    route = null;
  }

  const moduleOk = !!(route && route.module);
  const stepsOk = !!(route && Array.isArray(route.steps) && route.steps.length > 0);
  const executable = moduleOk && stepsOk;

  const rawGap = route && typeof route.gap === 'string' ? route.gap : '';
  const trimmed = rawGap.trim();
  const gap = trimmed || FALLBACK_GAP;

  return { executable, gap };
}

export default goalExecutability;
