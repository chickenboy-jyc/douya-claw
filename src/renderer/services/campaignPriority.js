/**
 * campaignPriority —— 营销专项优先级排序引擎（纯规则，无 AI / 无副作用）。
 *
 * 设计文档：docs/专项优先级排序规则-v1.md（定稿）。
 * 性质：纯常量 + 纯函数，不 import React / store / localStorage，不发网络。
 * 这是「专项列表」背后真正决定「总监感真假」的引擎——把「人读出来的优先级」
 * 变成「豆芽算出来的、可解释的经营取舍」。
 *
 * 三条铁律（对应规则文档 §0）：
 *  1. 排序不是评分仪表盘：不产出 83 分 / 76 分，只做同档内「序关系判断」。
 *  2. 排序不是黑箱：每个名次都必须能回答「为什么它排这个位置」（排序解释器）。
 *  3. 不打分 ≠ 不结构化：三变量用「定性等级」，不用百分比权重。
 *
 * 输入是「专项信号快照」（事实），不是「结论」——引擎负责从信号推导分档与序关系。
 *
 * 信号快照字段（Signal）：
 *  @property {string} id                         专项 id
 *  @property {string} name                       专项名
 *  @property {Array<{key:string,label?:string}>} pendingDecisions   需要老板决策但未完成的事项
 *  @property {Array<{key:string,label?:string}>} blockedByDecision  被上述决策阻塞的豆芽关键动作
 *  @property {string|null} criticalNodeAt         关键节点时间（ISO），null=无关键节点
 *  @property {number} correctionRequiredHours     动作链预计纠偏耗时（小时）
 *  @property {'high'|'mid'|'low'|'none'} deviation 偏离等级（none=无可靠基线）
 *  @property {boolean} canAutoCorrect             豆芽能否自动纠偏
 *  @property {'high'|'mid'|'low'} businessImpact   业务影响等级
 */

/** 分档顺序（index 越小越靠前）。 */
export const TIER_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4'];

/** 业务影响顺序（index 越小越优先）。 */
export const IMPACT_ORDER = ['high', 'mid', 'low'];

/** 节点紧迫度顺序（none 最低，表示无关键节点/无纠偏需求）。 */
export const URGENCY_ORDER = ['high', 'mid', 'low', 'none'];

/** 偏离程度顺序（none 最低，表示无可靠基线）。 */
export const DEV_ORDER = ['high', 'mid', 'low', 'none'];

/** 分档语义（规则文档 §1：不是严重程度，是「多需要老板把注意力拿过来」）。 */
export const TIER_MEANING = {
  P0: '最需要人介入（决策已阻塞关键动作）',
  P1: '时间已压缩到影响纠偏',
  P2: '结果已偏离，但豆芽还能救',
  P3: '有风险，但还有缓冲',
  P4: '最不需要人介入（可自动推进）',
};

/**
 * 计算节点紧迫度（纠偏窗口）。
 *
 * 规则文档 §3：不是「距离节点 N 天」，而是「纠偏剩余时间」。
 * availableHours = 关键节点时间 - 当前时间；requiredHours = 动作链预计纠偏耗时。
 *
 * @param {Object} signal Signal
 * @param {number} now 当前时间戳（ms），测试传固定值保证确定性
 * @returns {'high'|'mid'|'low'|'none'}
 *   high = 纠偏窗口不足（剩余 < 纠偏所需）
 *   mid  = 窗口正在收窄（剩余 ≤ 纠偏所需 × 1.5）
 *   low  = 仍有充分缓冲
 *   none = 无关键节点（无纠偏窗口概念）
 */
export function computeUrgency(signal, now) {
  const s = signal || {};
  if (!s.criticalNodeAt) return 'none';
  const nodeAt = new Date(s.criticalNodeAt).getTime();
  if (Number.isNaN(nodeAt)) return 'none';
  const required = Number(s.correctionRequiredHours) || 0;
  const availableHours = (nodeAt - now) / 3600000;
  if (required <= 0) return 'low';
  if (availableHours < required) return 'high';
  if (availableHours <= required * 1.5) return 'mid';
  return 'low';
}

/**
 * 判定专项分档（第一层：硬规则截断，P0→P4）。
 *
 * 规则文档 §1。判定顺序即优先级顺序，先命中先返回。
 *
 * @param {Object} signal Signal
 * @param {number} now 当前时间戳（ms）
 * @returns {'P0'|'P1'|'P2'|'P3'|'P4'}
 */
export function classifyTier(signal, now) {
  const s = signal || {};
  const urgency = computeUrgency(s, now);
  const imminent = urgency === 'high'; // 纠偏窗口不足 = 节点已临近到影响纠偏
  const hasBlocking = (Array.isArray(s.pendingDecisions) && s.pendingDecisions.length > 0)
    && (Array.isArray(s.blockedByDecision) && s.blockedByDecision.length > 0);
  const deviation = s.deviation || 'none';
  const hasDeviation = deviation !== 'none';
  const canAuto = s.canAutoCorrect === true;

  // P0：老板决策未完成 + 已阻塞豆芽关键动作 + 节点临近
  if (hasBlocking && imminent) return 'P0';
  // P1：节点临近 + 存在偏离 + 豆芽无法自动完成关键动作
  if (imminent && hasDeviation && !canAuto) return 'P1';
  // P2：结果偏离（显著/明确）+ 豆芽仍可自动纠偏
  if ((deviation === 'high' || deviation === 'mid') && canAuto) return 'P2';
  // P3：轻微偏离 + 有缓冲（未到纠偏窗口不足）
  if (deviation === 'low' && urgency !== 'high') return 'P3';
  // P4：其余（无阻塞、无实质偏离、可自动推进；含「无可靠基线」不升档）
  return 'P4';
}

const ORDINAL = ['', '首位', '第二', '第三', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];

function ordinalText(rank) {
  if (rank >= 1 && rank <= 10) return ORDINAL[rank];
  return `第${rank}位`;
}

function hoursUntilText(signal, now) {
  const s = signal || {};
  if (!s.criticalNodeAt) return null;
  const nodeAt = new Date(s.criticalNodeAt).getTime();
  if (Number.isNaN(nodeAt)) return null;
  const h = (nodeAt - now) / 3600000;
  if (h < 0) return '已过节点';
  if (h < 24) return `${Math.round(h)} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/**
 * 排序解释器（规则文档 §6：每个名次必须能回答「为什么排这个位置」）。
 *
 * 返回 { reason, text }：
 *  - reason：内部规则标识（决策阻塞 / 节点紧迫 / 结果偏离可纠偏 / 轻微偏离 / 自动推进），
 *            用于「解释一致性」测试（排序是 A，解释必须说 A 的触发规则）。
 *  - text：给老板看的一句话，必须可溯源到触发该分档的具体规则 + 关键事实。
 *
 * @param {Object} signal Signal
 * @param {number} now 当前时间戳
 * @param {{rank:number, tier:string}} ctx 名次与分档
 * @returns {{reason:string, text:string}}
 */
export function explainTier(signal, now, ctx) {
  const s = signal || {};
  const tier = ctx.tier;
  const rankText = ordinalText(ctx.rank);
  const urgency = computeUrgency(s, now);

  if (tier === 'P0') {
    const decision = (s.pendingDecisions && s.pendingDecisions[0] && s.pendingDecisions[0].label)
      || (s.pendingDecisions && s.pendingDecisions[0] && s.pendingDecisions[0].key) || '关键决策';
    const hText = hoursUntilText(s, now) || '节点临近';
    return {
      reason: 'decision_blocked',
      text: `排在${rankText}，因为「${decision}」决策已阻塞关键动作，距离关键节点仅 ${hText}。`,
    };
  }
  if (tier === 'P1') {
    return {
      reason: 'node_imminent',
      text: `排在${rankText}，因为纠偏窗口不足，豆芽无法在关键节点前自行完成纠偏。`,
    };
  }
  if (tier === 'P2') {
    return {
      reason: 'deviation_auto_correctable',
      text: `排在${rankText}，因为结果已偏离目标，但豆芽仍可自动纠偏，暂无需你介入。`,
    };
  }
  if (tier === 'P3') {
    return {
      reason: 'minor_deviation',
      text: `排在${rankText}，因为有轻微偏离，但仍有缓冲，豆芽可继续推进。`,
    };
  }
  return {
    reason: 'auto_progress',
    text: `排在${rankText}，因为当前无关键阻塞，豆芽可以继续自动推进。`,
  };
}

/**
 * 同档内序关系比较（第二层：三变量定性等级，只做序关系判断，不打分）。
 *
 * 优先级：业务影响 → 节点紧迫度 → 偏离程度（规则文档 §5）。
 * 返回 -1（a 优先）/ 1（b 优先）/ 0（平局）。
 *
 * @param {Object} aSignal Signal
 * @param {Object} bSignal Signal
 * @param {number} now 当前时间戳
 * @returns {number}
 */
export function compareSameTier(aSignal, bSignal, now) {
  const a = aSignal || {};
  const b = bSignal || {};
  const aImpact = IMPACT_ORDER.indexOf(a.businessImpact);
  const bImpact = IMPACT_ORDER.indexOf(b.businessImpact);
  if (aImpact !== bImpact) return aImpact - bImpact;

  const aUrg = URGENCY_ORDER.indexOf(computeUrgency(a, now));
  const bUrg = URGENCY_ORDER.indexOf(computeUrgency(b, now));
  if (aUrg !== bUrg) return aUrg - bUrg;

  const aDev = DEV_ORDER.indexOf(a.deviation || 'none');
  const bDev = DEV_ORDER.indexOf(b.deviation || 'none');
  return aDev - bDev;
}

/**
 * 完整排序：分档截断 + 同档三变量序关系。
 *
 * 返回按优先级降序的专项数组，每项附加 { tier, urgency, rank, explain }。
 * 不产出分数，只产出「名次 + 可解释理由」。
 *
 * @param {Array<Object>} campaigns Signal 数组
 * @param {{now?:number}} [opts] now 缺省取 Date.now()
 * @returns {Array<Object>}
 */
export function rankCampaigns(campaigns, opts = {}) {
  const now = opts.now || Date.now();
  const list = (campaigns || []).map((c) => {
    const tier = classifyTier(c, now);
    return { ...c, tier, urgency: computeUrgency(c, now) };
  });

  list.sort((a, b) => {
    const ta = TIER_ORDER.indexOf(a.tier);
    const tb = TIER_ORDER.indexOf(b.tier);
    if (ta !== tb) return ta - tb;
    return compareSameTier(a, b, now);
  });

  return list.map((c, i) => ({
    ...c,
    rank: i + 1,
    explain: explainTier(c, now, { rank: i + 1, tier: c.tier }),
  }));
}

/**
 * 判断两次快照间是否发生「重大事实变化」（排序抗抖动的判定基础）。
 *
 * 规则文档 §7：跨档或重大事实变化才重排；同档内指标微调（如 72%→74%）不换位。
 *
 * 重大事实变化 = 以下任一：
 *  1. 分档变化（跨档）
 *  2. 决策阻塞状态变化（阻塞 空↔非空）
 *  3. 关键节点时间变化（延期 / 到来）
 *  4. 节点紧迫度变化（纠偏窗口不足 ↔ 收窄 ↔ 充足）
 *
 * 注意：业务影响 / 偏离等级的「档内微调」若不导致以上变化，不算重大。
 *
 * @param {Object} prevSignal Signal（上次快照）
 * @param {Object} newSignal Signal（本次快照）
 * @param {number} now 当前时间戳
 * @returns {boolean}
 */
export function isSignificantChange(prevSignal, newSignal, now) {
  const prev = prevSignal || {};
  const next = newSignal || {};

  if (classifyTier(prev, now) !== classifyTier(next, now)) return true;
  if (computeUrgency(prev, now) !== computeUrgency(next, now)) return true;

  const prevBlocked = (Array.isArray(prev.pendingDecisions) && prev.pendingDecisions.length > 0)
    && (Array.isArray(prev.blockedByDecision) && prev.blockedByDecision.length > 0);
  const nextBlocked = (Array.isArray(next.pendingDecisions) && next.pendingDecisions.length > 0)
    && (Array.isArray(next.blockedByDecision) && next.blockedByDecision.length > 0);
  if (prevBlocked !== nextBlocked) return true;

  const prevNode = prev.criticalNodeAt || null;
  const nextNode = next.criticalNodeAt || null;
  if (prevNode !== nextNode) return true;

  return false;
}

/**
 * 排序稳定性（抗抖动）：除非发生重大事实变化，否则保持上次名次。
 *
 * 规则文档 §7：真正的总监不会因为一个指标刷新 2% 就重排注意力。
 * 若所有专项都无重大变化 → 返回 previousOrder；任一专项发生重大变化 → 返回 newOrder。
 *
 * @param {Array<Object>} newOrder   本次 rankCampaigns 的输出
 * @param {Array<Object>|null} previousOrder 上次的 rankCampaigns 输出（含 id）
 * @param {Array<Object>} prevSignals 上次的信号快照
 * @param {Array<Object>} newSignals  本次的信号快照
 * @param {number} now 当前时间戳
 * @returns {Array<Object>}
 */
export function stabilizeOrder(newOrder, previousOrder, prevSignals, newSignals, now) {
  if (!Array.isArray(previousOrder) || previousOrder.length === 0) return newOrder;
  const prevMap = new Map((prevSignals || []).map((s) => [s.id, s]));
  const nextMap = new Map((newSignals || []).map((s) => [s.id, s]));
  for (const c of newOrder) {
    const prev = prevMap.get(c.id);
    const next = nextMap.get(c.id);
    if (!prev) continue; // 新增专项视为重大变化
    if (isSignificantChange(prev, next, now)) return newOrder;
  }
  return previousOrder;
}

export default {
  TIER_ORDER,
  IMPACT_ORDER,
  URGENCY_ORDER,
  DEV_ORDER,
  TIER_MEANING,
  computeUrgency,
  classifyTier,
  compareSameTier,
  rankCampaigns,
  explainTier,
  isSignificantChange,
  stabilizeOrder,
};
