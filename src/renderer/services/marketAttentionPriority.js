/**
 * marketAttentionPriority —— 市场变化注意力排序引擎（纯规则，无 AI / 无副作用）。
 *
 * 设计文档：docs/市场与声势-主视图设计-v1.md §6.2（五级定性序关系 + 抗抖动）。
 * 性质：纯常量 + 纯函数，不 import React / store / localStorage，不发网络。
 * 这是「市场与声势」页的主心骨——把「哪个指标更红」变成
 * 「哪件事最可能改变经营者的下一步选择」。
 *
 * 注意力排序定义（§6.2，先锁定义）：
 *   注意力排序 = 当前哪些市场变化最可能改变经营者的下一步选择。
 *   不是「把最严重的指标排前面」，也不是「把下降最多的排前面」。
 *
 * 五级排序键（全部定性序关系，不产生分数）：
 *   1. 决策状态    decision > attention > observe
 *   2. 经营动作    change_plan > continue > none
 *   3. 经营影响    high > mid > low
 *   4. 时间敏感性  closing > open > none
 *   5. 方向        down > up > flat（仅 tie-breaker）
 *
 * 两条硬约束：
 *   - changePercent 仅用于证据展示，不参与排序。
 *   - insufficient_data 沉底，不参与正常排序。
 *
 * 信号快照字段（MarketSignal，事实 + 判断 + 建议的合并快照）：
 *  @property {string} id
 *  @property {'down'|'up'|'flat'|'insufficient_data'} direction  方向
 *  @property {'decision'|'attention'|'observe'} attentionLevel    决策状态
 *  @property {'change_plan'|'continue'|'none'} actionNecessity    经营动作必要性
 *  @property {'high'|'mid'|'low'} businessImpact                  经营影响
 *  @property {'closing'|'open'|'none'} timeSensitivity            时间敏感性
 *  @property {'A'|'B'|'C'} conclusion                             三出口结论
 *  @property {boolean} needsBossDecision                          是否需要老板决策
 *  @property {number|null} changePercent                          仅证据，不参与排序
 */

export const ATTENTION_ORDER = ['decision', 'attention', 'observe'];
export const ACTION_ORDER = ['change_plan', 'continue', 'none'];
export const IMPACT_ORDER = ['high', 'mid', 'low'];
export const TIME_ORDER = ['closing', 'open', 'none'];
export const DIRECTION_ORDER = ['down', 'up', 'flat'];

export const ATTENTION_TEXT = {
  decision: '需要决策',
  attention: '需要关注',
  observe: '继续观察',
};

export const ACTION_TEXT = {
  change_plan: '需要改变当前计划',
  continue: '需要继续推进',
  none: '无需改变',
};

export const TIME_TEXT = {
  closing: '窗口正在收窄',
  open: '窗口存在',
  none: '暂无时限压力',
};

/** 判断是否为「数据采集中」（沉底组）。 */
function isInsufficient(signal) {
  return (signal && signal.direction) === 'insufficient_data';
}

function idx(order, v) {
  const i = order.indexOf(v);
  return i === -1 ? order.length : i;
}

/**
 * 五级序关系比较（attentionLevel → actionNecessity → impact → timeSensitivity → direction）。
 * 返回 -1（a 优先）/ 1（b 优先）/ 0（平局）。不产出分数。
 *
 * 方向 down > up > flat 只作为同等经营条件下的 tie-breaker。
 */
export function compareAttention(aSignal, bSignal) {
  const a = aSignal || {};
  const b = bSignal || {};

  const aAtt = idx(ATTENTION_ORDER, a.attentionLevel);
  const bAtt = idx(ATTENTION_ORDER, b.attentionLevel);
  if (aAtt !== bAtt) return aAtt - bAtt;

  const aAct = idx(ACTION_ORDER, a.actionNecessity);
  const bAct = idx(ACTION_ORDER, b.actionNecessity);
  if (aAct !== bAct) return aAct - bAct;

  const aImp = idx(IMPACT_ORDER, a.businessImpact);
  const bImp = idx(IMPACT_ORDER, b.businessImpact);
  if (aImp !== bImp) return aImp - bImp;

  const aTime = idx(TIME_ORDER, a.timeSensitivity);
  const bTime = idx(TIME_ORDER, b.timeSensitivity);
  if (aTime !== bTime) return aTime - bTime;

  const aDir = idx(DIRECTION_ORDER, a.direction);
  const bDir = idx(DIRECTION_ORDER, b.direction);
  return aDir - bDir;
}

const ORDINAL = ['', '首位', '第二', '第三', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];

function ordinalText(rank) {
  if (rank >= 1 && rank <= 10) return ORDINAL[rank];
  return `第${rank}位`;
}

/**
 * 排序解释器：每个名次必须能回答「为什么排这个位置」。
 * 返回 { reason, text }。reason 用于解释一致性测试。
 */
export function explainAttention(signal, ctx) {
  const s = signal || {};
  const rankText = ordinalText(ctx.rank);

  if (isInsufficient(s)) {
    return {
      reason: 'insufficient_data',
      text: `数据采集中，暂不参与排序。`,
    };
  }
  if (s.attentionLevel === 'decision') {
    return {
      reason: 'need_decision',
      text: `排在${rankText}，因为这项市场变化需要你拍板是否新增经营动作。`,
    };
  }
  if (s.attentionLevel === 'attention') {
    return {
      reason: 'need_attention',
      text: `排在${rankText}，因为这项变化与当前重点工作相关，豆芽建议调整当前计划。`,
    };
  }
  return {
    reason: 'observe',
    text: `排在${rankText}，因为这项变化暂不影响经营计划，豆芽继续观察。`,
  };
}

/**
 * 完整排序：insufficient_data 沉底 + 五级序关系。
 * 不产出分数，只产出「名次 + 可解释理由」。
 *
 * @param {Array<Object>} changes MarketSignal 数组
 * @returns {Array<Object>}
 */
export function rankMarketChanges(changes) {
  const list = (changes || []).map((c) => ({ ...c }));

  const normal = list.filter((c) => !isInsufficient(c));
  const insufficient = list.filter((c) => isInsufficient(c));

  normal.sort(compareAttention);
  // insufficient 组保持输入相对顺序（稳定，不脑补序关系）
  const ordered = normal.concat(insufficient);

  return ordered.map((c, i) => ({
    ...c,
    rank: i + 1,
    explain: explainAttention(c, { rank: i + 1 }),
  }));
}

/**
 * 顶部第一屏状态（§4.1 TopInsight 三态）。
 *
 * @param {Array<Object>} ranked rankMarketChanges 的输出
 * @returns {{state:'highest_attention_change'|'no_action_needed'|'insufficient_market_signal', top:Object|null}}
 *   highest_attention_change → top = 排序第一名（且需要决策或需要关注）
 *   no_action_needed          → 所有变化都是 observe（继续观察），无需要处理的变化
 *   insufficient_market_signal→ 所有变化都是 insufficient_data
 */
export function classifyTopInsight(ranked) {
  const list = ranked || [];
  if (list.length === 0) return { state: 'insufficient_market_signal', top: null };

  const allInsufficient = list.every((c) => isInsufficient(c));
  if (allInsufficient) return { state: 'insufficient_market_signal', top: null };

  const actionable = list.find(
    (c) => !isInsufficient(c) && (c.attentionLevel === 'decision' || c.attentionLevel === 'attention'),
  );
  if (!actionable) return { state: 'no_action_needed', top: null };

  return { state: 'highest_attention_change', top: actionable };
}

/**
 * 判断两次快照间是否发生「重大事实变化」（抗抖动基础）。
 *
 * 重大事实变化 = 五级排序键任一档变化，或 conclusion / needsBossDecision 变化。
 * changePercent 数值变化（方向不变）不算重大。
 *
 * @param {Object} prevSignal
 * @param {Object} newSignal
 * @returns {boolean}
 */
export function isSignificantChange(prevSignal, newSignal) {
  const prev = prevSignal || {};
  const next = newSignal || {};

  if (prev.attentionLevel !== next.attentionLevel) return true;
  if (prev.actionNecessity !== next.actionNecessity) return true;
  if (prev.businessImpact !== next.businessImpact) return true;
  if (prev.timeSensitivity !== next.timeSensitivity) return true;
  if (prev.direction !== next.direction) return true;
  if (prev.conclusion !== next.conclusion) return true;
  if (prev.needsBossDecision !== next.needsBossDecision) return true;
  return false;
}

/**
 * 排序稳定性（抗抖动）：除非发生重大事实变化，否则保持上次名次。
 *
 * @param {Array<Object>} newOrder    本次 rankMarketChanges 输出
 * @param {Array<Object>|null} previousOrder 上次输出（含 id）
 * @param {Array<Object>} prevSignals 上次信号快照
 * @param {Array<Object>} newSignals  本次信号快照
 * @returns {Array<Object>}
 */
export function stabilizeOrder(newOrder, previousOrder, prevSignals, newSignals) {
  if (!Array.isArray(previousOrder) || previousOrder.length === 0) return newOrder;
  const prevMap = new Map((prevSignals || []).map((s) => [s.id, s]));
  const nextMap = new Map((newSignals || []).map((s) => [s.id, s]));
  for (const c of newOrder) {
    const prev = prevMap.get(c.id);
    const next = nextMap.get(c.id);
    if (!prev) return newOrder; // 新增变化视为重大变化
    if (isSignificantChange(prev, next)) return newOrder;
  }
  return previousOrder;
}

export default {
  ATTENTION_ORDER,
  ACTION_ORDER,
  IMPACT_ORDER,
  TIME_ORDER,
  DIRECTION_ORDER,
  ATTENTION_TEXT,
  ACTION_TEXT,
  TIME_TEXT,
  compareAttention,
  rankMarketChanges,
  explainAttention,
  classifyTopInsight,
  isSignificantChange,
  stabilizeOrder,
};
