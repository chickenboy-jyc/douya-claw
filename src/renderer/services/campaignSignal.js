/**
 * campaignSignal —— 「营销专项」→ 排序信号快照适配器（纯函数，无副作用，可测试）。
 *
 * 设计文档：docs/专项优先级排序规则-v1.md + docs/营销专项-设计定稿.md v3。
 * 性质：把 Campaign（业务对象）翻译成 campaignPriority.rankCampaigns 需要的「信号快照 Signal」。
 *
 * 与 campaignPriority.js 解耦：本文件只做「Campaign → Signal」这一层，不知道排序规则。
 * 与 store 解耦：输入是普通对象，不 import React / store。
 *
 * 数据边界（红线，对齐规则文档）：暂无数据 ≠ 偏离 ≠ 预警。
 *   - deviation：Campaign 未显式记录偏离时 → 'none'（无可靠基线，不升档）。
 *   - businessImpact：未记录 → 'mid'（中性，不虚构「高影响」）。
 *   - criticalNodeAt：未记录 → null（无关键节点，urgency='none'）。
 *   - pendingDecisions / blockedByDecision：从 Campaign 真实 decisions/actions 推导，不编造。
 */

/**
 * @param {Object} campaign normalizeCampaign 的产物
 * @returns {Object} Signal（字段见 campaignPriority.js 头部注释）
 */
export function toSignal(campaign) {
  const c = campaign || {};
  const pendingDecisions = (Array.isArray(c.decisions) ? c.decisions : [])
    .filter((d) => d && d.status === 'pending')
    .map((d) => ({ key: d.id, label: d.title }));
  const blockedByDecision = (Array.isArray(c.actions) ? c.actions : [])
    .filter((a) => a && a.status === 'blocked')
    .map((a) => ({ key: a.id, label: a.title }));

  return {
    id: c.id,
    name: c.name,
    pendingDecisions,
    blockedByDecision,
    criticalNodeAt: c.criticalNodeAt || null,
    correctionRequiredHours: Number(c.correctionRequiredHours) || 0,
    deviation: c.deviation || 'none',
    canAutoCorrect: c.canAutoCorrect !== false,
    businessImpact: c.businessImpact || 'mid',
  };
}

/**
 * 健康度三档（对齐 docs/专项列表-设计定稿.md：正常/预警/需处理，本质 = 是否还在可自动推进状态）。
 * 映射 campaignPriority 的 P0~P4 五档 → 驾驶舱三档。
 *   - 需处理 = P0 + P1（需要人介入：决策阻塞 / 纠偏窗口不足且无法自动纠偏）
 *   - 需关注 = P2 + P3（偏离但豆芽可自动纠偏 / 轻微偏离有缓冲）
 *   - 正常推进 = P4（无阻塞可自动推进）
 */
export const HEALTH_LEVEL = {
  handle: '需处理',
  watch: '需关注',
  normal: '正常推进',
};

/** P0~P4 五档 → 驾驶舱三档。 */
export function tierToHealth(tier) {
  if (tier === 'P0' || tier === 'P1') return 'handle';
  if (tier === 'P2' || tier === 'P3') return 'watch';
  return 'normal';
}

export default { toSignal, tierToHealth, HEALTH_LEVEL };
