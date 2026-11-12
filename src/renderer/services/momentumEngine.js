/**
 * momentumEngine —— 企业声势方向判定引擎（纯规则，无 AI / 无副作用）。
 *
 * 设计文档：docs/企业声势-数据模型-v1.md（定稿：8 字段 + changeRule + 自身/对照边界）。
 * 性质：纯常量 + 纯函数，不 import React / store / localStorage，不发网络。
 * 这是「市场与声势」页背后的主心骨——把「人读出来的市场变化」变成
 * 「豆芽算出来的、可解释的方向判定」，且绝不允许拼出一个「声势总分」。
 *
 * 三条核心红线（对应数据模型 §0）：
 *  1. 监测数据 ≠ 市场判断。
 *  2. 数据模型未锁前，禁止「企业声势 + X 分」。
 *  3. 只输出「方向性变化」+ 证据链，不输出总分。
 *
 * 五个纯函数（对应数据模型 §8）：
 *  momentumDataValidator()   数据有效性检查（8 字段齐 + 来源/窗口/频率口径一致）
 *  momentumBaseline()        baseline 对齐（前一个等长窗口）
 *  calculateChange()         changeRule 判定 ↑/→/↓/insufficient_data
 *  buildEvidence()           组装证据链（指标→时段→基线→来源）
 *  classifyMomentumState()   组合自身/对照信号 → 经营状态（禁止直接映射）
 *
 * 输入是「维度定义 + 采样快照」（事实），不是结论——引擎负责从事实推导方向。
 *
 * MomentumDimension（8 字段，数据模型 §2/§3）：
 *  @property {string} definition          1 指标定义
 *  @property {string} source              2 数据来源
 *  @property {string} refreshFrequency    3 更新频率
 *  @property {number} observationWindow   4 时间窗口（天）
 *  @property {string} baseline            5 基线定义
 *  @property {string} missingDataPolicy   6 缺失处理
 *  @property {boolean} comparability      7 跨周期比较（口径是否一致）
 *  @property {{thresholdPercent:number, minSamples?:number}} changeRule 8 变化规则
 *
 * 采样快照 Sample（事实）：
 *  @property {string} dimensionId
 *  @property {number|null} value           当前窗口指标值
 *  @property {number|null} baselineValue   前一个等长窗口指标值
 *  @property {number} [windowDays]         实际采样窗口天数（用于校验）
 *  @property {string} [source]             实际来源（用于校验口径）
 *  @property {string} [refreshCadence]     实际采集频率（用于校验）
 *  @property {number} [sampleCount]        当前窗口采样点数
 *  @property {number} [baselineSampleCount] 基线窗口采样点数
 */

/** 方向状态（数据模型 §3.2，insufficient_data 为合法输出状态）。 */
export const DIRECTION = {
  UP: 'up',
  FLAT: 'flat',
  DOWN: 'down',
  INSUFFICIENT: 'insufficient_data',
};

export const DIRECTION_TEXT = {
  up: '上升',
  flat: '持平',
  down: '下降',
  insufficient_data: '数据采集中',
};

/** 相对可见度状态（自身 vs 竞品对照，数据模型 §4）。 */
export const RELATIVE_VISIBILITY = {
  IMPROVING: 'improving',
  STABLE: 'stable',
  WORSENING: 'worsening',
  INSUFFICIENT: 'insufficient_data',
};

/** 8 个必定义字段（数据模型 §2）。 */
export const REQUIRED_FIELDS = [
  'definition',
  'source',
  'refreshFrequency',
  'observationWindow',
  'baseline',
  'missingDataPolicy',
  'comparability',
  'changeRule',
];

/**
 * 维度 8 字段是否齐备。
 * @param {Object} dimension MomentumDimension
 * @returns {boolean}
 */
export function isDimensionComplete(dimension) {
  const d = dimension || {};
  return REQUIRED_FIELDS.every(
    (f) => d[f] !== undefined && d[f] !== null && d[f] !== '',
  );
}

/**
 * 变化百分比（保留符号）。baseline=0 时用 ±Infinity 表达方向（0→x 视为 up）。
 * @param {number} current 当前值
 * @param {number} baseline 基线值
 * @returns {number}
 */
export function changePercent(current, baseline) {
  if (baseline === 0) {
    if (current === 0) return 0;
    return current > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

/**
 * 数据有效性检查（momentumDataValidator）。
 * 检查维度 8 字段是否齐备 + 采样与维度的口径一致性（来源 / 时间窗口 / 采集频率）。
 *
 * @param {Object} dimension MomentumDimension
 * @param {Object} sample Sample
 * @returns {{valid:boolean, errors:string[]}}
 */
export function momentumDataValidator(dimension, sample) {
  const d = dimension || {};
  const s = sample || {};
  const errors = [];

  if (!isDimensionComplete(d)) {
    const missing = REQUIRED_FIELDS.filter(
      (f) => d[f] === undefined || d[f] === null || d[f] === '',
    );
    errors.push(`维度定义缺失字段: ${missing.join('、')}`);
  }
  if (d.source && s.source != null && d.source !== s.source) {
    errors.push(`来源口径不一致：维度声明 ${d.source}，采样实际 ${s.source}`);
  }
  if (
    d.observationWindow != null
    && s.windowDays != null
    && Number(s.windowDays) !== Number(d.observationWindow)
  ) {
    errors.push(`时间窗口不一致：维度声明 ${d.observationWindow} 天，采样实际 ${s.windowDays} 天`);
  }
  if (d.refreshFrequency && s.refreshCadence != null && d.refreshFrequency !== s.refreshCadence) {
    errors.push(`采集频率不一致：维度声明 ${d.refreshFrequency}，采样实际 ${s.refreshCadence}`);
  }
  if (d.comparability === false) {
    errors.push('跨周期口径不可比较（comparability=false）');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * baseline 对齐（momentumBaseline）。
 * 取采样里的前一个等长窗口值；缺失或非法 → null（将导致 insufficient_data）。
 *
 * @param {Object} sample Sample
 * @returns {number|null}
 */
export function momentumBaseline(sample) {
  const s = sample || {};
  const b = s.baselineValue;
  if (b === undefined || b === null || Number.isNaN(Number(b))) return null;
  return Number(b);
}

/**
 * changeRule 判定方向（calculateChange）。
 * 流程：数据有效性 → 当前值 → baseline → 采样数 → changeRule 阈值。
 * 任一前置不满足 → insufficient_data（绝不编造方向）。
 *
 * @param {Object} dimension MomentumDimension
 * @param {Object} sample Sample
 * @returns {'up'|'flat'|'down'|'insufficient_data'}
 */
export function calculateChange(dimension, sample) {
  const d = dimension || {};
  const s = sample || {};

  const { valid } = momentumDataValidator(d, s);
  if (!valid) return DIRECTION.INSUFFICIENT;

  if (s.value === undefined || s.value === null || Number.isNaN(Number(s.value))) {
    return DIRECTION.INSUFFICIENT;
  }
  const baseline = momentumBaseline(s);
  if (baseline === null) return DIRECTION.INSUFFICIENT;

  const rule = d.changeRule || {};
  const threshold = Number(rule.thresholdPercent);
  if (Number.isNaN(threshold)) return DIRECTION.INSUFFICIENT;

  // 采样数不足（新增数据不足以比较）
  const minSamples = Number(rule.minSamples) || 1;
  const sampleCount = s.sampleCount == null ? null : Number(s.sampleCount);
  const baselineSampleCount = s.baselineSampleCount == null ? null : Number(s.baselineSampleCount);
  if (sampleCount !== null && sampleCount < minSamples) return DIRECTION.INSUFFICIENT;
  if (baselineSampleCount !== null && baselineSampleCount < minSamples) return DIRECTION.INSUFFICIENT;

  const current = Number(s.value);
  const pct = changePercent(current, baseline);
  if (Math.abs(pct) < threshold) return DIRECTION.FLAT;
  return pct > 0 ? DIRECTION.UP : DIRECTION.DOWN;
}

/**
 * 组装证据链（buildEvidence）：指标 → 时段 → 基线 → 来源。
 * 每个 ↑/→/↓ 必须能点开这条链；text 与 direction 严格一致（解释一致性）。
 *
 * @param {Object} dimension MomentumDimension
 * @param {Object} sample Sample
 * @param {string} direction 方向
 * @returns {{indicator:string, window:string, baseline:string, source:string, direction:string, text:string}}
 */
export function buildEvidence(dimension, sample, direction) {
  const d = dimension || {};
  const s = sample || {};
  const indicator = d.definition || s.dimensionId || '指标';
  const windowText = d.observationWindow != null
    ? `近 ${d.observationWindow} 天 vs 前 ${d.observationWindow} 天`
    : '时段未定义';
  const baselineText = s.baselineValue != null
    ? `当前 ${s.value} vs 基线 ${s.baselineValue}`
    : '基线缺失';
  const sourceText = d.source || '来源未定义';
  const dirText = DIRECTION_TEXT[direction] || '未知';
  return {
    indicator,
    window: windowText,
    baseline: baselineText,
    source: sourceText,
    direction,
    text: `${indicator} ${dirText}（证据：${windowText}；${baselineText}；来源：${sourceText}）`,
  };
}

/**
 * 组合自身信号 + 竞品对照信号 → 经营状态（classifyMomentumState）。
 *
 * 数据模型 §4 红线：禁止「竞品↑ → 企业↓」直接映射。
 * 品牌自身方向（selfDirection）只由品牌自己的 calculateChange 决定；
 * 相对可见度（relativeVisibility）由两者方向 + 变化幅度组合得出，是「相对」判断。
 *
 * @param {Object} selfResult       品牌自身维度求值结果（含 direction/changePercent/evidence）
 * @param {Object} competitorResult 竞品对照维度求值结果（含 direction/changePercent/evidence）
 * @returns {{selfDirection:string, competitorDirection:string, relativeVisibility:string, judgment:string, needsAttention:boolean}}
 */
export function classifyMomentumState(selfResult, competitorResult) {
  const self = selfResult || {};
  const comp = competitorResult || {};
  const selfDir = self.direction || DIRECTION.INSUFFICIENT;
  const compDir = comp.direction || DIRECTION.INSUFFICIENT;
  const selfPct = Number(self.changePercent);
  const compPct = Number(comp.changePercent);

  if (selfDir === DIRECTION.INSUFFICIENT || compDir === DIRECTION.INSUFFICIENT) {
    return {
      selfDirection: selfDir,
      competitorDirection: compDir,
      relativeVisibility: RELATIVE_VISIBILITY.INSUFFICIENT,
      judgment: '数据不足，无法判断相对可见度变化',
      needsAttention: false,
    };
  }

  let relativeVisibility = classifyRelative(selfDir, compDir, selfPct, compPct);

  const indicator = (self.evidence && self.evidence.indicator) || '品牌可见度';
  const judgmentText = {
    improving: `${indicator}相对竞品的可见度正在提升`,
    stable: `${indicator}相对竞品的可见度保持稳定`,
    worsening: `${indicator}相对竞品的可见度正在恶化`,
  }[relativeVisibility] || '相对可见度无法判断';

  return {
    selfDirection: selfDir,
    competitorDirection: compDir,
    relativeVisibility,
    judgment: judgmentText,
    needsAttention: relativeVisibility === RELATIVE_VISIBILITY.WORSENING,
  };
}

/**
 * 相对可见度判定（定性方向，不打分）。优先用变化幅度比快慢，幅度缺失时退回方向组合。
 * 关键：品牌自身方向不因竞品方向而被改写——只产出「相对」判断。
 */
function classifyRelative(selfDir, compDir, selfPct, compPct) {
  if (selfDir === DIRECTION.INSUFFICIENT || compDir === DIRECTION.INSUFFICIENT) {
    return RELATIVE_VISIBILITY.INSUFFICIENT;
  }
  // 双方都持平：不制造趋势（小幅波动也算持平）
  if (selfDir === DIRECTION.FLAT && compDir === DIRECTION.FLAT) {
    return RELATIVE_VISIBILITY.STABLE;
  }
  const sNaN = Number.isNaN(selfPct);
  const cNaN = Number.isNaN(compPct);
  if (sNaN || cNaN) {
    // 幅度缺失时退回方向组合（仍禁止直接映射）
    if (selfDir === DIRECTION.DOWN) return RELATIVE_VISIBILITY.WORSENING;
    if (compDir === DIRECTION.DOWN) return RELATIVE_VISIBILITY.IMPROVING;
    if (selfDir === DIRECTION.UP) return RELATIVE_VISIBILITY.IMPROVING;
    if (compDir === DIRECTION.UP) return RELATIVE_VISIBILITY.WORSENING;
    return RELATIVE_VISIBILITY.STABLE;
  }
  if (selfPct > compPct) return RELATIVE_VISIBILITY.IMPROVING;
  if (selfPct < compPct) return RELATIVE_VISIBILITY.WORSENING;
  return RELATIVE_VISIBILITY.STABLE;
}

/**
 * 一步到位：维度求值（validate → baseline → change → evidence）。
 * 返回 direction + changePercent + evidence，供 classifyMomentumState 直接消费。
 *
 * @param {Object} dimension MomentumDimension
 * @param {Object} sample Sample
 * @returns {{direction:string, changePercent:number|null, evidence:Object}}
 */
export function evaluateDimension(dimension, sample) {
  const direction = calculateChange(dimension, sample);
  const current = sample ? Number(sample.value) : NaN;
  const baseline = momentumBaseline(sample);
  const pct = (
    direction === DIRECTION.INSUFFICIENT
    || Number.isNaN(current)
    || baseline === null
  )
    ? null
    : changePercent(current, baseline);
  return {
    direction,
    changePercent: pct,
    evidence: buildEvidence(dimension, sample, direction),
  };
}

export default {
  DIRECTION,
  DIRECTION_TEXT,
  RELATIVE_VISIBILITY,
  REQUIRED_FIELDS,
  isDimensionComplete,
  changePercent,
  momentumDataValidator,
  momentumBaseline,
  calculateChange,
  buildEvidence,
  classifyMomentumState,
  evaluateDimension,
};
