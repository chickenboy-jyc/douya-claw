/**
 * marketMomentumCta —— 市场变化 → 回流 CTA 意图映射（纯函数，无副作用）。
 *
 * 设计文档：docs/市场与声势-主视图设计-v1.md §10（老板需要做什么）+ §7.2（A/B/C 三出口）。
 * 性质：纯映射。只把「结论 + 回流信息」翻译成「UI 该显示什么 CTA / 跳转意图」，
 *       不含经营判断（经营判断在 marketMomentum.js），UI 只消费本函数产物。
 *
 * 与 marketMomentum.js 解耦：本文件独立存在，测试只针对「结论 → CTA」这一层，
 * 不触及事实→方向→判断→排序引擎。
 *
 * 意图语义（§10）：
 *   - A（不需动作）      → observe：显示「豆芽继续观察」，无按钮
 *   - insufficient_data  → none：无任何决策 CTA（数据不足不诱导动作）
 *   - B（调整当前计划）  → adjust：按钮「调整当前计划 →」，携带 campaignId（定位到对应活动）
 *   - C（新增经营动作）  → confirm_brief：按钮「确认后交给豆芽制定计划 →」，携带 newBrief 种子
 *
 * @param {Object} change marketMomentum.buildDimensionChange 的产物
 * @returns {{kind:'adjust'|'confirm_brief'|'observe'|'none', label:string,
 *            campaignId:string|null, campaignName:string|null, briefTitle:string|null, briefReason:string|null, primary:boolean}}
 */
export function ctaForChange(change) {
  const c = change || {};

  // 数据不足：不诱导任何决策动作
  if (c.direction === 'insufficient_data') {
    return {
      kind: 'none',
      label: '',
      campaignId: null,
      campaignName: null,
      briefTitle: null,
      briefReason: null,
      primary: false,
    };
  }

  // A：不需动作，豆芽继续观察
  if (c.conclusion === 'A') {
    return {
      kind: 'observe',
      label: '豆芽继续观察',
      campaignId: null,
      campaignName: null,
      briefTitle: null,
      briefReason: null,
      primary: false,
    };
  }

  // B：调整当前计划（携带 campaignId 定位到对应活动）
  if (c.conclusion === 'B') {
    const ref = c.campaignRef || {};
    return {
      kind: 'adjust',
      label: '调整当前计划 →',
      campaignId: ref.campaignId || null,
      campaignName: ref.campaignName || null,
      briefTitle: null,
      briefReason: null,
      primary: false,
    };
  }

  // C：新增经营动作（携带 newBrief 种子，需老板确认）
  if (c.conclusion === 'C') {
    const brief = c.newBrief || {};
    return {
      kind: 'confirm_brief',
      label: '确认后交给豆芽制定计划 →',
      campaignId: null,
      campaignName: null,
      briefTitle: brief.title || null,
      briefReason: brief.reason || null,
      primary: true,
    };
  }

  // 兜底：无 CTA
  return {
    kind: 'none',
    label: '',
    campaignId: null,
    campaignName: null,
    briefTitle: null,
    briefReason: null,
    primary: false,
  };
}

export default { ctaForChange };
