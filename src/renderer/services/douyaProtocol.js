/**
 * douyaProtocol —— 「豆芽执行协议」：豆芽判断+执行 → 人确认 → 结果回写。
 *
 * 设计依据：豆芽产品地图（2026-09-10），产品人格关系锁定。
 * 性质：纯常量 + 纯函数，不 import React / store / localStorage，不发网络。
 *
 * 产品人格关系（红线，不可混）：
 *   豆芽负责「想 + 做」：理解 / 判断 / 规划 / 决策提醒，以及操作 / 执行 / 搬运 / 发布 / 搜集 / 填表 / 登录后台。
 *   老板负责「拍板」：需要承担经营责任的动作必须由人确认。
 *
 * 一句话：需要「想」和「动手」的事豆芽做，需要「承担经营责任」的事人确认。
 *
 * 协议链（一个动作走完的完整闭环）：
 *   豆芽判断（该做什么）→ 人确认（是否拍板）→ 豆芽执行（动手做）→ 结果回写（回到专项）→ 豆芽继续判断。
 * 豆芽不是「第八个模块」，它藏在每一个「判断清楚、需要实际动手」的动作后面。
 */

/** 动作责任人两态（对齐 campaignStore.CAMPAIGN_ACTION_OWNER，唯一事实源在此）。 */
export const ACTION_OWNER = {
  douya: '豆芽', // 判断 + 执行（豆芽想 + 做）
  boss: '需要你决定', // 人拍板（承担经营责任）
};

/** 责任人角色标签（UI 展示用）。 */
export const OWNER_ROLE = {
  douya: '豆芽',
  boss: '需要你确认',
};

/** 协议链四环节。 */
export const PROTOCOL_STEPS = [
  { key: 'judge', label: '豆芽判断', who: 'douya', desc: '豆芽理解现状、判断该做什么' },
  { key: 'confirm', label: '人确认', who: 'boss', desc: '需要承担经营责任的动作，老板拍板' },
  { key: 'execute', label: '豆芽执行', who: 'douya', desc: '豆芽动手：搜索 / 发布 / 搬运 / 填表 / 采集' },
  { key: 'writeback', label: '结果回写', who: 'douya', desc: '结果回到专项，豆芽继续判断' },
];

/**
 * 判断一个动作属于协议链哪个环节。
 * @param {Object} action 含 owner 字段的动作
 * @returns {'confirm'|'execute'} 环节 key
 */
export function actionStage(action) {
  const owner = action && action.owner;
  if (owner === 'boss') return 'confirm';
  return 'execute'; // douya（默认）= 豆芽判断 + 执行
}

/**
 * 动作是否需要老板确认（高风险动作：owner=boss，或被阻塞）。
 * @param {Object} action
 * @returns {boolean}
 */
export function needsBossConfirmation(action) {
  if (!action) return false;
  return action.owner === 'boss' || action.status === 'blocked';
}

/**
 * 动作是否属于「豆芽可自动推进」（不阻塞、不需老板确认）。
 * 与 campaignPriority 的健康度语义一致：能在无人介入下自动推进的动作。
 * @param {Object} action
 * @returns {boolean}
 */
export function isAutoAdvancing(action) {
  if (!action) return false;
  return !needsBossConfirmation(action);
}

export default {
  ACTION_OWNER,
  OWNER_ROLE,
  PROTOCOL_STEPS,
  actionStage,
  needsBossConfirmation,
  isAutoAdvancing,
};
