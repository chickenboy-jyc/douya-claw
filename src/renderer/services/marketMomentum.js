/**
 * marketMomentum —— 「市场与声势」数据编排层（经营逻辑集中地）。
 *
 * 设计文档：docs/市场与声势-主视图设计-v1.md。
 * 性质：纯函数编排，UI 只消费本层产物，绝不在 JSX 里重新判断。
 * 管线（§2 八步主链）：
 *   外部市场事实 → 声势变化（momentumEngine）→ 证据链 → 豆芽判断（规则化降级）
 *   → 经营影响 → 回到经营计划（A/B/C）→ 建议动作 → 老板是否需要决策
 *   → 注意力排序（marketAttentionPriority）→ TopInsight
 *
 * 关键红线：
 *   - 方向由 momentumEngine.calculateChange 判定，不是本层拍脑袋；
 *   - 相对可见度由 classifyMomentumState 判定（竞品是对照证据，非企业维度）；
 *   - 判断/建议在本层规则化推导（等价 AI 降级路径），可替换为 LLM 判断管线；
 *   - 排序严格走 marketAttentionPriority 五级序关系，方向只做 tie-breaker；
 *   - changePercent 只做证据展示，不参与排序；insufficient_data 沉底。
 */

import {
  evaluateDimension,
  classifyMomentumState,
  DIRECTION,
  RELATIVE_VISIBILITY,
} from './momentumEngine.js';
import { rankMarketChanges, classifyTopInsight } from './marketAttentionPriority.js';
import { buildVisibilitySnapshot, buildAiSearchVisibility } from './marketSignal.js';

/** 四个企业自身声势维度的 8 字段定义（文档 §5.3：竞品不是企业维度）。 */
export const MOMENTUM_DIMENSIONS = [
  {
    id: 'ai_search_exposure',
    label: '在 AI 搜索里被看到',
    definition: '品牌在核心采购场景的 AI 提及概率',
    source: 'geo',
    refreshFrequency: 'daily',
    observationWindow: 7,
    baseline: 'previous_equal_window',
    missingDataPolicy: 'insufficient_data',
    comparability: true,
    changeRule: { thresholdPercent: 5 },
  },
  {
    id: 'media_volume',
    label: '媒体热度',
    definition: '品牌媒体提及量',
    source: 'media_monitor',
    refreshFrequency: 'daily',
    observationWindow: 30,
    baseline: 'previous_equal_window',
    missingDataPolicy: 'insufficient_data',
    comparability: true,
    changeRule: { thresholdPercent: 5 },
  },
  {
    id: 'brand_sentiment',
    label: '品牌舆情',
    definition: '品牌负面舆情提及数',
    source: 'social',
    refreshFrequency: 'daily',
    observationWindow: 7,
    baseline: 'previous_equal_window',
    missingDataPolicy: 'insufficient_data',
    comparability: true,
    changeRule: { thresholdPercent: 5 },
  },
  {
    id: 'content_activity',
    label: '内容活跃',
    definition: '品牌内容发布活跃度',
    source: 'content_system',
    refreshFrequency: 'daily',
    observationWindow: 7,
    baseline: 'previous_equal_window',
    missingDataPolicy: 'insufficient_data',
    comparability: true,
    changeRule: { thresholdPercent: 5 },
  },
];

export const DIMENSION_LABEL = MOMENTUM_DIMENSIONS.reduce((m, d) => {
  m[d.id] = d.label;
  return m;
}, {});

export const DIRECTION_LABEL = {
  up: '↑',
  flat: '→',
  down: '↓',
  insufficient_data: '数据采集中',
};

/** 关联工作匹配关键词（P1 规则化降级：判断某条变化命中哪项现有工作）。 */
const CAMPAIGN_MATCH_HINTS = {
  ai_search_exposure: ['曝光', 'AI', '搜索', '机扩', '选型', 'GEO', '可见度'],
  media_volume: ['媒体', '声量', '传播', '投放', '新闻', '报道', 'PR'],
  brand_sentiment: ['舆情', '口碑', '危机', '声誉', '负面'],
  content_activity: ['内容', '发布', '文章', '素材', '选题'],
};

/**
 * 从实抓数据提取「AI 搜索曝光」维度样本 + 竞品对照。
 *
 * realScan = geoExposure.diagnoseExposure 返回的 realScan：
 *   { self: { mention_prob, indexed_count, sentiment_cn, questions }, competitors: [{name, mention_prob, indexed_count}], conclusion }
 *
 * 测量口径（本轮升级）：优先用「核心场景命中率」（coreMentioned/coreCovered，来自 marketSignal 对齐核心场景清单），
 * 缺核心场景明细时退回 mention_prob（0-1）。命中率与概率数值同量纲（0-1），转百分数一致。
 *
 * @param {Object|null} realScan
 * @param {Object|null} baselineMap 基线参照 { ai_search_exposure: number }（命中率或概率 0-1）
 * @returns {{dimension:Object, sample:Object, competitor:Object|null}}
 */
export function extractAiSearch(realScan, baselineMap) {
  const self = (realScan && realScan.self) || {};
  const comps = Array.isArray((realScan && realScan.competitors)) ? realScan.competitors : [];

  const curProb = typeof self.mention_prob === 'number' ? self.mention_prob : null;
  const baseProb = baselineMap && typeof baselineMap.ai_search_exposure === 'number'
    ? baselineMap.ai_search_exposure
    : null;

  // 核心场景命中率（测量对象，优先于 mention_prob；无核心场景口径时退回概率）
  const vis = buildAiSearchVisibility(realScan);
  const hitRate = vis.coreCovered != null && vis.coreCovered > 0
    ? vis.coreMentioned / vis.coreCovered
    : null;
  const curValue = hitRate != null
    ? Math.round(hitRate * 100)
    : (curProb == null ? null : Math.round(curProb * 100));

  const bestComp = comps.reduce((m, c) => {
    const p = c && typeof c.mention_prob === 'number' ? c.mention_prob : -1;
    return Math.max(m, p);
  }, -1);

  const dim = MOMENTUM_DIMENSIONS.find((d) => d.id === 'ai_search_exposure');

  const sample = {
    dimensionId: 'ai_search_exposure',
    value: curValue,
    baselineValue: baseProb == null ? null : Math.round(baseProb * 100),
    windowDays: 7,
    source: 'geo',
    refreshCadence: 'daily',
    sampleCount: curValue == null ? 0 : 1,
    baselineSampleCount: baseProb == null ? 0 : 1,
    raw: self,
  };

  // 竞品对照：只取「最高提及概率竞品」作为对照证据（不列为企业维度）
  let competitor = null;
  if (bestComp >= 0 && curProb != null) {
    const topComp = comps.find((c) => c && typeof c.mention_prob === 'number' && c.mention_prob === bestComp) || comps[0];
    competitor = {
      name: (topComp && topComp.name) || '竞品',
      sample: {
        dimensionId: 'ai_search_exposure',
        value: Math.round(bestComp * 100),
        baselineValue: baseProb == null ? null : Math.round(baseProb * 100),
        windowDays: 7,
        source: 'geo',
        refreshCadence: 'daily',
        sampleCount: 1,
        baselineSampleCount: baseProb == null ? 0 : 1,
      },
    };
  }

  return { dimension: dim, sample, competitor };
}

/**
 * 匹配现有工作（Activity）—— B/C 分流依据。
 * P1 规则化：用维度关键词匹配 Activity.name / goalCustomText；匹配到 → B，否则 → C。
 *
 * @param {Array<Object>} activities activityStore 的 activities
 * @param {string} dimensionId
 * @returns {Object|null} 匹配到的 Activity，或 null
 */
export function matchActivity(activities, dimensionId) {
  const hints = CAMPAIGN_MATCH_HINTS[dimensionId] || [];
  const list = Array.isArray(activities) ? activities : [];
  return list.find((a) => {
    const hay = `${(a && a.name) || ''} ${(a && a.goalCustomText) || ''} ${(a && a.subjectLabel) || ''}`;
    return hints.some((h) => hay.includes(h));
  }) || null;
}

/**
 * 规则化推导「豆芽判断 + 经营影响 + 建议」（等价 AI 降级路径，可替换为 LLM）。
 *
 * 输入是引擎产物（方向 + 相对可见度），输出五级注意力字段 + A/B/C 结论 + 判断文本。
 * 唯一用事实推导经营含义的地方，UI 绝不复刻这套逻辑。
 *
 * @param {Object} p { dimensionId, label, direction, relativeVisibility, hasCompetitor, activities, matchedActivity }
 * @returns {Object} { judgmentText, businessImpact, attentionLevel, actionNecessity, timeSensitivity, conclusion, campaignRef, newBrief, needsBossDecision }
 */
export function deriveJudgmentRecommendation(p = {}) {
  const {
    label = '维度',
    direction = DIRECTION.INSUFFICIENT,
    relativeVisibility = null,
    hasCompetitor = false,
    matchedActivity = null,
  } = p;

  // ---- 数据采集中：不判断、不动作、沉底 ----
  if (direction === DIRECTION.INSUFFICIENT) {
    return {
      judgmentText: `「${label}」数据采集中，暂无法判断方向。`,
      businessImpact: 'low',
      attentionLevel: 'observe',
      actionNecessity: 'none',
      timeSensitivity: 'none',
      conclusion: 'A',
      campaignRef: null,
      newBrief: null,
      needsBossDecision: false,
    };
  }

  const worsening = relativeVisibility === RELATIVE_VISIBILITY.WORSENING;
  const improving = relativeVisibility === RELATIVE_VISIBILITY.IMPROVING;

  // ---- 判断文本 + 五级字段（规则化，方向只作判断输入之一） ----
  let judgmentText;
  let businessImpact;
  let attentionLevel;
  let actionNecessity;
  let timeSensitivity;

  if (direction === DIRECTION.DOWN && worsening) {
    judgmentText = hasCompetitor
      ? `竞品正在扩大「${label}」场景的品牌占位，而我方当前内容资产不足以覆盖该场景，相对可见度正在恶化。`
      : `「${label}」出现下降，品牌在该场景的外部可见度正在走低。`;
    businessImpact = 'high';
    attentionLevel = matchedActivity ? 'attention' : 'decision';
    actionNecessity = 'change_plan';
    timeSensitivity = 'closing';
  } else if (direction === DIRECTION.DOWN) {
    judgmentText = `「${label}」出现下降，品牌在该场景的外部可见度正在走低。`;
    businessImpact = 'mid';
    attentionLevel = matchedActivity ? 'attention' : 'decision';
    actionNecessity = 'change_plan';
    timeSensitivity = 'open';
  } else if (direction === DIRECTION.UP && worsening) {
    judgmentText = `「${label}」虽有上升，但竞品上升更快，相对可见度仍在恶化。`;
    businessImpact = 'mid';
    attentionLevel = matchedActivity ? 'attention' : 'attention';
    actionNecessity = 'change_plan';
    timeSensitivity = 'open';
  } else if (direction === DIRECTION.UP) {
    judgmentText = `「${label}」出现上升，品牌在该场景的外部可见度正在提升。`;
    businessImpact = improving ? 'mid' : 'low';
    attentionLevel = 'observe';
    actionNecessity = 'none';
    timeSensitivity = 'none';
  } else {
    // flat
    judgmentText = `「${label}」无实质变化，暂不影响经营计划。`;
    businessImpact = 'low';
    attentionLevel = 'observe';
    actionNecessity = 'none';
    timeSensitivity = 'none';
  }

  // ---- A/B/C 结论分流（§7.2 硬门槛） ----
  let conclusion;
  let campaignRef = null;
  let newBrief = null;
  let needsBossDecision = false;

  if (attentionLevel === 'observe') {
    conclusion = 'A'; // 不需动作，豆芽继续观察
  } else if (matchedActivity) {
    conclusion = 'B'; // 调整现有工作
    campaignRef = { campaignId: matchedActivity.id, campaignName: matchedActivity.name, adjustWhat: `补强「${label}」相关的内容与传播动作` };
    needsBossDecision = false; // 豆芽可自动推进，老板可一键批准
  } else {
    conclusion = 'C'; // 现有工作无法承接 → 发起新动作
    newBrief = { title: `「${label}」场景防守`, reason: judgmentText };
    needsBossDecision = true; // 需老板拍板是否新增经营动作
  }

  return {
    judgmentText,
    businessImpact,
    attentionLevel,
    actionNecessity,
    timeSensitivity,
    conclusion,
    campaignRef,
    newBrief,
    needsBossDecision,
  };
}

/**
 * 单维度求值 + 判断 + 建议，产出合并 change 对象（满足 marketAttentionPriority 输入 + 展示字段）。
 *
 * @param {Object} p { dimension, sample, competitor, activities, observedAt }
 * @returns {Object}
 */
export function buildDimensionChange(p = {}) {
  const { dimension, sample, competitor, activities = [], observedAt = new Date().toISOString() } = p;
  const dim = dimension || {};
  const dimId = dim.id || (sample && sample.dimensionId) || '';

  const ev = evaluateDimension(dim, sample);
  const direction = ev.direction;

  let relativeVisibility = null;
  let competitorEvidence = null;
  if (competitor && direction !== DIRECTION.INSUFFICIENT) {
    const compEv = evaluateDimension(dim, competitor.sample);
    const st = classifyMomentumState(ev, compEv);
    relativeVisibility = st.relativeVisibility;
    competitorEvidence = {
      name: competitor.name,
      direction: compEv.direction,
      changePercent: compEv.changePercent,
      evidence: compEv.evidence,
    };
  }

  const matchedActivity = matchActivity(activities, dimId);
  const jr = deriveJudgmentRecommendation({
    dimensionId: dimId,
    label: dim.label || DIMENSION_LABEL[dimId] || dimId,
    direction,
    relativeVisibility,
    hasCompetitor: !!competitor,
    matchedActivity,
  });

  return {
    id: `chg_${dimId}`,
    dimensionId: dimId,
    label: dim.label || DIMENSION_LABEL[dimId] || dimId,
    direction,
    changePercent: ev.changePercent,
    evidence: ev.evidence,
    observedAt,
    relativeVisibility,
    competitorEvidence,
    // 判断层（MomentumJudgment）
    judgmentText: jr.judgmentText,
    businessImpact: jr.businessImpact,
    attentionLevel: jr.attentionLevel,
    actionNecessity: jr.actionNecessity,
    timeSensitivity: jr.timeSensitivity,
    // 建议层（MomentumRecommendation）
    conclusion: jr.conclusion,
    campaignRef: jr.campaignRef,
    newBrief: jr.newBrief,
    needsBossDecision: jr.needsBossDecision,
  };
}

/**
 * 完整管线：采集 → 求值 → 判断 → 建议 → 排序 → TopInsight。
 *
 * @param {Object} p { realScan, baselineMap, activities, now, baseline }
 *   baseline（可选）momentumBaseline.buildBaseline 产物（新结构，含 established/baselineValue/sampleCount）。
 *   未传 baseline 时退回 baselineMap（旧结构，向后兼容）。
 * @returns {{ topInsight:Object, dimensions:Array, rankedChanges:Array, feedState:string, baseline:Object|null }}
 *   feedState: 'ok' | 'insufficient_market_signal' | 'empty'
 */
export function buildMomentumFeed(p = {}) {
  const { realScan = null, baselineMap = null, activities = [], now, baseline = null } = p;

  // 趋势参照：baseline（新结构，仅 established 才允许）优先，退回 baselineMap（旧）
  let effBaselineMap = baselineMap;
  if (baseline && baseline.established === true && typeof baseline.baselineValue === 'number') {
    effBaselineMap = { ai_search_exposure: baseline.baselineValue };
  }

  // AI 搜索曝光：唯一有真实数据源的维度
  const ai = extractAiSearch(realScan, effBaselineMap);
  const aiChange = buildDimensionChange({
    dimension: ai.dimension,
    sample: ai.sample,
    competitor: ai.competitor,
    activities,
    observedAt: new Date((now || Date.now())).toISOString(),
  });

  // 其余三维度：P1 暂无真实数据源 → 数据采集中（诚实，不硬凑方向）
  const otherChanges = MOMENTUM_DIMENSIONS.filter((d) => d.id !== 'ai_search_exposure').map((d) => {
    const sample = {
      dimensionId: d.id,
      value: null,
      baselineValue: null,
      windowDays: d.observationWindow,
      source: d.source,
      refreshCadence: d.refreshFrequency,
    };
    return buildDimensionChange({ dimension: d, sample, competitor: null, activities, observedAt: new Date((now || Date.now())).toISOString() });
  });

  const allChanges = [aiChange, ...otherChanges];
  const rankedChanges = rankMarketChanges(allChanges);
  const topInsight = classifyTopInsight(rankedChanges);

  const dimensions = MOMENTUM_DIMENSIONS.map((d) => {
    const ch = rankedChanges.find((c) => c.dimensionId === d.id);
    // 事实层：当前可见性快照（先回答「现在有没有」，与趋势 change 是两层）
    const visibility = buildVisibilitySnapshot(realScan, d.id);
    return { id: d.id, label: d.label, change: ch || null, visibility };
  });

  const feedState = topInsight.state === 'insufficient_market_signal'
    ? 'insufficient_market_signal'
    : 'ok';

  // baseline 元信息（供 UI 显示采集进度 / 趋势参照，不做判断）
  const baselineInfo = baseline ? {
    established: !!baseline.established,
    sampleCount: baseline.sampleCount || 0,
    minSampleThreshold: baseline.minSampleThreshold,
    baselineValue: baseline.baselineValue,
    baselineValueAbs: baseline.baselineValueAbs,
    baselineRange: baseline.baselineRange,
  } : null;

  return { topInsight, dimensions, rankedChanges, feedState, baseline: baselineInfo };
}

/**
 * 示例样本（明确标注 demo，用于视觉验证完整链路，非生产路径）。
 * 数据来自文档 §4.2 / §5.1 / §7.3 / §7.4 样本。
 */
export function buildDemoFeed() {
  const observedAt = new Date().toISOString();
  const activities = [
    { id: 'act_ai', name: 'AI 搜索曝光提升', goalCustomText: '提升 AI 搜索场景可见度', subjectLabel: '' },
  ];

  const demoChanges = [
    // 1. AI 搜索曝光 ↓，竞品 B 42%，相对恶化 → B 调整现有工作
    (() => {
      const d = MOMENTUM_DIMENSIONS.find((x) => x.id === 'ai_search_exposure');
      const sample = { dimensionId: 'ai_search_exposure', value: 18, baselineValue: 30, windowDays: 7, source: 'geo', refreshCadence: 'daily', sampleCount: 1, baselineSampleCount: 1 };
      const ev = evaluateDimension(d, sample);
      const compEv = evaluateDimension(d, { dimensionId: 'ai_search_exposure', value: 42, baselineValue: 30, windowDays: 7, source: 'geo', refreshCadence: 'daily', sampleCount: 1, baselineSampleCount: 1 });
      const st = classifyMomentumState(ev, compEv);
      return {
        id: 'chg_ai_search_exposure',
        dimensionId: 'ai_search_exposure',
        label: '在 AI 搜索里被看到',
        direction: ev.direction,
        changePercent: ev.changePercent,
        evidence: ev.evidence,
        observedAt,
        relativeVisibility: st.relativeVisibility,
        competitorEvidence: { name: '竞品 B', direction: compEv.direction, changePercent: compEv.changePercent, evidence: compEv.evidence },
        judgmentText: '竞品 B 正在扩大「机扩采购」场景的品牌占位，而我方当前内容资产不足以覆盖该场景，相对可见度正在恶化。',
        businessImpact: 'high',
        attentionLevel: 'attention',
        actionNecessity: 'change_plan',
        timeSensitivity: 'closing',
        conclusion: 'B',
        campaignRef: { campaignId: 'act_ai', campaignName: 'AI 搜索曝光提升', adjustWhat: '第二阶段增加「机扩选型」内容资产' },
        newBrief: null,
        needsBossDecision: false,
      };
    })(),
    // 2. 品牌舆情 ↓ → 需要关注
    (() => {
      const d = MOMENTUM_DIMENSIONS.find((x) => x.id === 'brand_sentiment');
      const sample = { dimensionId: 'brand_sentiment', value: 3, baselineValue: 0, windowDays: 7, source: 'social', refreshCadence: 'daily', sampleCount: 1, baselineSampleCount: 1 };
      const ev = evaluateDimension(d, sample);
      return {
        id: 'chg_brand_sentiment',
        dimensionId: 'brand_sentiment',
        label: '品牌舆情',
        direction: ev.direction,
        changePercent: ev.changePercent,
        evidence: ev.evidence,
        observedAt,
        relativeVisibility: null,
        competitorEvidence: null,
        judgmentText: '品牌舆情出现负面提及（小红书 3 条），值得关注。',
        businessImpact: 'mid',
        attentionLevel: 'attention',
        actionNecessity: 'change_plan',
        timeSensitivity: 'open',
        conclusion: 'B',
        campaignRef: { campaignId: 'act_pr', campaignName: '品牌口碑维护', adjustWhat: '回应小红书负面提及' },
        newBrief: null,
        needsBossDecision: false,
      };
    })(),
    // 3. 媒体声量 flat → A 继续观察
    (() => {
      const d = MOMENTUM_DIMENSIONS.find((x) => x.id === 'media_volume');
      const sample = { dimensionId: 'media_volume', value: 10, baselineValue: 10, windowDays: 30, source: 'media_monitor', refreshCadence: 'daily', sampleCount: 1, baselineSampleCount: 1 };
      const ev = evaluateDimension(d, sample);
      return {
        id: 'chg_media_volume',
        dimensionId: 'media_volume',
        label: '媒体热度',
        direction: ev.direction,
        changePercent: ev.changePercent,
        evidence: ev.evidence,
        observedAt,
        relativeVisibility: null,
        competitorEvidence: null,
        judgmentText: '媒体声量无实质变化，暂不影响经营计划。',
        businessImpact: 'low',
        attentionLevel: 'observe',
        actionNecessity: 'none',
        timeSensitivity: 'none',
        conclusion: 'A',
        campaignRef: null,
        newBrief: null,
        needsBossDecision: false,
      };
    })(),
    // 4. 内容活跃 flat → A 继续观察
    (() => {
      const d = MOMENTUM_DIMENSIONS.find((x) => x.id === 'content_activity');
      const sample = { dimensionId: 'content_activity', value: 8, baselineValue: 8, windowDays: 7, source: 'content_system', refreshCadence: 'daily', sampleCount: 1, baselineSampleCount: 1 };
      const ev = evaluateDimension(d, sample);
      return {
        id: 'chg_content_activity',
        dimensionId: 'content_activity',
        label: '内容活跃',
        direction: ev.direction,
        changePercent: ev.changePercent,
        evidence: ev.evidence,
        observedAt,
        relativeVisibility: null,
        competitorEvidence: null,
        judgmentText: '内容活跃无实质变化，暂不影响经营计划。',
        businessImpact: 'low',
        attentionLevel: 'observe',
        actionNecessity: 'none',
        timeSensitivity: 'none',
        conclusion: 'A',
        campaignRef: null,
        newBrief: null,
        needsBossDecision: false,
      };
    })(),
  ];

  const rankedChanges = rankMarketChanges(demoChanges);
  const topInsight = classifyTopInsight(rankedChanges);
  const dimensions = MOMENTUM_DIMENSIONS.map((d) => {
    const ch = rankedChanges.find((c) => c.dimensionId === d.id);
    return { id: d.id, label: d.label, change: ch || null };
  });

  return { topInsight, dimensions, rankedChanges, feedState: 'ok', isDemo: true, activities };
}

export default {
  MOMENTUM_DIMENSIONS,
  DIMENSION_LABEL,
  DIRECTION_LABEL,
  extractAiSearch,
  matchActivity,
  deriveJudgmentRecommendation,
  buildDimensionChange,
  buildMomentumFeed,
  buildDemoFeed,
};
