/**
 * 建议任务（suggestedTasks）接线层：把 companyTypeConfig 里按「身份 × 经营目标」写的首批建议任务，
 * 安全、幂等地喂给项目。
 *
 * 背景（死配置修复）：companyTypeConfig.COMPANY_TYPE_CONFIG[*].suggestedTasks 此前只被
 * companyStore.createCompanyFull 读取，而 createCompanyFull 全仓 0 调用 ⇒ 该配置**零消费**
 * （配置写了 5 份，用户永远看不到）。本次把「选定经营目标 → 建项目 + 排任务」的真实路径
 * （GoalPlanPreview.doConfirm）接上本模块。
 *
 * 设计约束（务必保持）：
 *   · 只读 companyTypeConfig，不修改其结构；
 *   · 未知身份 / 未知 goalId / 空配置一律返回 []（**不 seed 比 seed 错的好**）；
 *   · 幂等：标题经空白归一化后在 existingTitles 里出现过就不返回 ⇒ 对同一 projectId
 *     重复调用不会重复建任务（老用户数据零迁移：只影响新建项目）。
 */

import { getTypeConfig } from '../config/companyTypeConfig.js';

/**
 * 标题归一化：去首尾空白 + 折叠内部连续空白，用于幂等比对。
 * @param {unknown} title
 * @returns {string}
 */
export function normalizeTaskTitle(title) {
  return String(title == null ? '' : title).trim().replace(/\s+/g, ' ');
}

/**
 * 取「某身份 × 某经营目标」下**尚未存在**的建议任务。
 * @param {string} companyType 企业类型 key（manufacturer|clinic|doctor|dealer|platform；未知兜底 manufacturer）
 * @param {string} goalId 经营目标 id（须命中该身份 suggestedTasks 的键才算命中，否则返回 []）
 * @param {string[]} [existingTitles] 目标项目中已存在的任务标题（用于幂等去重）
 * @returns {{title:string, capability:string}[]} 待落库的建议任务（已去重，可能为空数组）
 */
export function suggestedTasksForGoal(companyType, goalId, existingTitles) {
  const cfg = getTypeConfig(companyType);
  const map = cfg && cfg.suggestedTasks;
  if (!map || typeof map !== 'object') return [];
  const gid = goalId == null ? '' : String(goalId);
  const raw = gid ? map[gid] : null;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const seen = new Set(
    (Array.isArray(existingTitles) ? existingTitles : [])
      .map(normalizeTaskTitle)
      .filter(Boolean),
  );
  const out = [];
  for (const t of raw) {
    const title = normalizeTaskTitle(t && t.title);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push({ title, capability: (t && t.capability) || 'chat' });
  }
  return out;
}

/**
 * 列出某身份在 suggestedTasks 里**实际配置**的全部 goalId。
 * 用途：审计「各身份能命中哪些 goalId」，避免误以为某个目标会自动 seed。
 * @param {string} companyType 企业类型 key
 * @returns {string[]}
 */
export function suggestedGoalIds(companyType) {
  const cfg = getTypeConfig(companyType);
  const map = cfg && cfg.suggestedTasks;
  return map && typeof map === 'object' ? Object.keys(map) : [];
}

export default suggestedTasksForGoal;
