/**
 * marketMomentumRoute —— 市场变化 → 模块路由意图（P2 跨模块回流契约，纯函数）。
 *
 * 设计文档：docs/市场与声势-主视图设计-v1.md §10 + §13（删除项 8 后的正式回流）。
 * 性质：纯映射。把 ctaForChange 的「回流 CTA 意图」翻译成「App 路由层能直接消费的目标模块」。
 *
 * 与 marketMomentum.js / marketMomentumCta.js 解耦：本文件只做「CTA → 路由」这一层，
 * 不知道 ActivityPlanning 怎么打开（那是 App / ActivityPlanning 的职责）。
 * MarketMomentum 只调用本函数拿路由对象，绝不在 JSX 里写死 'huodong' 或判断目标模块内部结构。
 *
 * 语义（§10）：
 *   - B（adjust）        → { module:'campaign', intent:{ kind:'adjust', campaignId, campaignName } }，定位已有专项
 *   - C（confirm_brief） → { module:'campaign', intent:{ kind:'confirm_brief', briefTitle, briefReason, source:'market_momentum', sourceChangeId } }，预填专项生成器 Brief（Brief 是内部承接对象，须经老板确认后才交给豆芽制定计划）
 *   - A（observe）/ insufficient → null（不跳转，不诱导任何动作）
 *
 * @param {Object} change marketMomentum.buildDimensionChange 的产物
 * @returns {{module:string, intent:Object}|null}
 */
import { ctaForChange } from './marketMomentumCta.js';

export function resolveMomentumRoute(change) {
  const cta = ctaForChange(change);

  // B：调整当前计划 → 定位到对应专项
  if (cta.kind === 'adjust') {
    return {
      module: 'campaign',
      intent: {
        kind: 'adjust',
        campaignId: cta.campaignId,
        campaignName: cta.campaignName,
      },
    };
  }

  // C：新增经营动作 → 预填专项生成器 Brief（老板确认后交给豆芽制定计划）
  // source / sourceChangeId 用于追溯「这条经营动作建议来自哪条市场变化」，便于复盘回流。
  if (cta.kind === 'confirm_brief') {
    return {
      module: 'campaign',
      intent: {
        kind: 'confirm_brief',
        briefTitle: cta.briefTitle,
        briefReason: cta.briefReason,
        source: 'market_momentum',
        sourceChangeId: (change && change.id) || null,
      },
    };
  }

  // A（观察）/ insufficient_data（信号不足）：不跳转
  return null;
}

export default { resolveMomentumRoute };
