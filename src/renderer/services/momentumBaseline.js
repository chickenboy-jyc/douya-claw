/**
 * momentumBaseline —— 「AI 搜索可见性」baseline 建立机制（纯函数，无副作用）。
 *
 * 设计依据：docs/AI搜索核心场景采集协议-v1.md + docs/AI可见性Baseline-v1.md（2026-09-10）。
 * 性质：纯常量 + 纯函数，不 import React / store / localStorage，不发网络。
 *
 * 核心原则（本轮）：
 *   baseline 不是「存一个 7/20」，而是「连续有效 Snapshot → 参照水平 → 趋势准入」。
 *   「采集」和「baseline」彻底拆开：
 *     事实采集 → Snapshot → 采集质量判定 → 累计有效 Snapshot → 达最小样本量 → 建 baseline → 允许趋势。
 *
 * 三个概念不混：
 *   Snapshot  事实：2026-09-10，7/20
 *   Baseline  参照：最近 N 次有效采集的稳定水平（均值 + 范围）
 *   Trend     判断：当前高于/低于 baseline（方向判定仍由 momentumEngine 负责）
 *
 * 关键红线：**「覆盖不全」的采集绝不能进 baseline**。
 *   后端今天只测了 3 个场景、恰好 2 个命中 → 2/20 看似「可见性 2/20」，实则是「只测了 3 个」。
 *   这种快照若进 baseline，会污染基线。
 *
 * 采集质量（collectionQuality）四级：
 *   complete      20/20 全覆盖 → valid
 *   partial       覆盖 ≥ 阈值（默认 80%）但 < 100% → valid
 *   insufficient  覆盖 > 0 但 < 阈值 → invalid（暂不进基线）
 *   no_data       覆盖 = 0 或无核心场景口径 → invalid
 */

import { coreSceneTotal } from '../config/coreSearchScenes.js';

/** 覆盖率阈值：核心场景覆盖 ≥ 80%（即 16/20）才判为有效样本。 */
export const COVERAGE_THRESHOLD = 0.8;

/** 最小样本量：至少 3 次有效采集才建立 baseline。 */
export const MIN_SAMPLE_THRESHOLD = 3;

/** 观测窗口（天）：只取最近 14 天内的快照参与 baseline。 */
export const OBSERVATION_WINDOW_DAYS = 14;

/** 核心场景版本（场景清单变更时递增，触发 baseline 失效重建）。 */
export const CORE_SCENE_VERSION = 'v1';

/** 采集质量四级。 */
export const QUALITY_LEVEL = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  INSUFFICIENT: 'insufficient',
  NO_DATA: 'no_data',
};

/** 采集质量中文标签。 */
export const QUALITY_LEVEL_LABEL = {
  complete: '完整采集',
  partial: '部分采集（可用）',
  insufficient: '覆盖不足（暂不进基线）',
  no_data: '无有效数据',
};

function asNum(v, d = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function asIso(v) {
  return typeof v === 'string' && v ? v : '';
}

/**
 * 采集质量判定（collectionQuality）。
 *
 * @param {{coreMentioned:number|null, coreCovered:number|null, coreTotal:number|null}} p
 *   coreMentioned 命中的核心场景数；coreCovered 本轮覆盖的核心场景数；coreTotal 核心场景总数。
 * @returns {{coverage:number|null, level:string, valid:boolean, reason:string}}
 *   coverage = coreCovered/coreTotal（0-1）；level 四级；valid = complete|partial。
 */
export function assessCollectionQuality(p = {}) {
  const total = asNum(p.coreTotal);
  const covered = asNum(p.coreCovered);
  const mentioned = asNum(p.coreMentioned);

  // 无核心场景口径（total 或 covered 缺失）→ 无有效数据
  if (total == null || covered == null || total <= 0) {
    return { coverage: null, level: QUALITY_LEVEL.NO_DATA, valid: false, reason: '无核心场景口径，不具备可比性' };
  }
  if (covered <= 0) {
    return { coverage: 0, level: QUALITY_LEVEL.NO_DATA, valid: false, reason: '本轮未覆盖任何核心场景' };
  }

  const coverage = covered / total;
  if (coverage >= 1) {
    return { coverage, level: QUALITY_LEVEL.COMPLETE, valid: true, reason: `${covered}/${total} 核心场景全覆盖，本轮有效` };
  }
  if (coverage >= COVERAGE_THRESHOLD) {
    return { coverage, level: QUALITY_LEVEL.PARTIAL, valid: true, reason: `${covered}/${total} 核心场景覆盖达标，本轮可进基线` };
  }
  return {
    coverage,
    level: QUALITY_LEVEL.INSUFFICIENT,
    valid: false,
    reason: `${covered}/${total} 核心场景覆盖不足（< ${Math.round(COVERAGE_THRESHOLD * 100)}%），本轮暂不进基线`,
  };
}

/**
 * 归一化 Snapshot（一次采集的事实快照）。
 *
 * @param {Object} raw 原始数据（来自 marketSignal.buildAiSearchVisibility 的产物）
 * @returns {{
 *   dimensionId:string,
 *   capturedAt:string,
 *   coreSceneVersion:string,
 *   coreMentioned:number|null,
 *   coreCovered:number|null,
 *   coreTotal:number,
 *   prob:number|null,
 *   indexed:number|null,
 *   quality:Object,          // assessCollectionQuality 产物
 *   hitRate:number|null,     // 命中率 = coreMentioned/coreCovered（0-1，可比口径）
 * }}
 */
export function normalizeSnapshot(raw, opts = {}) {
  const r = raw || {};
  const coreTotal = asNum(r.total) != null ? asNum(r.total) : coreSceneTotal();
  const coreCovered = asNum(r.coreCovered);
  const coreMentioned = asNum(r.mentioned != null ? r.mentioned : r.coreMentioned);

  const quality = assessCollectionQuality({ coreMentioned, coreCovered, coreTotal });

  // 命中率：仅当核心场景口径齐全且覆盖 > 0 才可算（跨覆盖不全可比的关键）
  let hitRate = null;
  if (coreMentioned != null && coreCovered != null && coreCovered > 0) {
    hitRate = coreMentioned / coreCovered;
  }

  return {
    dimensionId: r.dimensionId || 'ai_search_exposure',
    capturedAt: asIso(opts.capturedAt || r.capturedAt || new Date().toISOString()),
    coreSceneVersion: asIso(opts.coreSceneVersion || r.coreSceneVersion || CORE_SCENE_VERSION),
    coreMentioned,
    coreCovered,
    coreTotal,
    prob: asNum(r.prob),
    indexed: asNum(r.indexed),
    quality,
    hitRate,
  };
}

/**
 * 过滤「有效 + 同版本 + 窗口内」的快照，供 baseline 计算。
 *
 * @param {Array<Object>} snapshots 历史快照（已 normalizeSnapshot）
 * @param {Object} [opts] { now, windowDays, coreSceneVersion }
 * @returns {Array<Object>} 有效快照（quality.valid && 同版本 && 窗口内）
 */
export function filterValidSnapshots(snapshots, opts = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  const now = asNum(opts.now) != null ? asNum(opts.now) : Date.now();
  const windowDays = asNum(opts.windowDays) != null ? asNum(opts.windowDays) : OBSERVATION_WINDOW_DAYS;
  const version = opts.coreSceneVersion || CORE_SCENE_VERSION;
  const windowMs = windowDays * 24 * 3600 * 1000;

  return list.filter((s) => {
    if (!s || !s.quality || s.quality.valid !== true) return false;
    if (s.coreSceneVersion && s.coreSceneVersion !== version) return false;
    const t = Date.parse(s.capturedAt);
    if (Number.isNaN(t)) return false;
    return now - t <= windowMs;
  });
}

/**
 * 从有效快照建立 baseline（参照水平）。
 *
 * @param {Array<Object>} validSnapshots filterValidSnapshots 的产物
 * @returns {{
 *   coreSceneVersion:string,
 *   observationWindowDays:number,
 *   sampleCount:number,          // 有效样本数
 *   minSampleThreshold:number,
 *   baselineValue:number|null,   // 命中率均值（0-1，可比口径）
 *   baselineRange:[number,number]|null, // 命中率范围 [min,max]
 *   baselineValueAbs:number|null,// 折算绝对数 = baselineValue × coreTotal（展示「5.8/20」）
 *   established:boolean,         // 是否已建立（sampleCount >= minSampleThreshold）
 *   lastCollectedAt:string,
 * }}
 */
export function buildBaseline(validSnapshots, opts = {}) {
  const list = Array.isArray(validSnapshots) ? validSnapshots : [];
  const minSample = asNum(opts.minSampleThreshold) != null ? asNum(opts.minSampleThreshold) : MIN_SAMPLE_THRESHOLD;
  const version = opts.coreSceneVersion || CORE_SCENE_VERSION;
  const windowDays = asNum(opts.observationWindowDays) != null ? asNum(opts.observationWindowDays) : OBSERVATION_WINDOW_DAYS;

  const withRate = list.filter((s) => s && s.hitRate != null);
  const rates = withRate.map((s) => s.hitRate);

  const sampleCount = rates.length;
  const established = sampleCount >= minSample;

  let baselineValue = null;
  let baselineRange = null;
  let baselineValueAbs = null;
  if (sampleCount > 0) {
    const sum = rates.reduce((a, b) => a + b, 0);
    baselineValue = sum / sampleCount;
    baselineRange = [Math.min(...rates), Math.max(...rates)];
    const coreTotal = withRate[0] && withRate[0].coreTotal ? withRate[0].coreTotal : coreSceneTotal();
    baselineValueAbs = baselineValue * coreTotal;
  }

  const lastCollectedAt = list.reduce((m, s) => {
    const t = Date.parse(s.capturedAt);
    return Number.isNaN(t) ? m : Math.max(m, t);
  }, 0);

  return {
    coreSceneVersion: version,
    observationWindowDays: windowDays,
    sampleCount,
    minSampleThreshold: minSample,
    baselineValue,
    baselineRange,
    baselineValueAbs,
    established,
    lastCollectedAt: lastCollectedAt ? new Date(lastCollectedAt).toISOString() : '',
  };
}

/**
 * 趋势准入判定（trend eligibility）。
 * 只有「baseline 已建立」且「本轮采集质量有效」才允许进入趋势判断。
 *
 * @param {Object} snapshot 本轮快照（normalizeSnapshot 产物）
 * @param {Object} baseline buildBaseline 产物
 * @returns {{eligible:boolean, reason:string}}
 */
export function trendEligibility(snapshot, baseline) {
  const b = baseline || {};
  if (!b.established) {
    const done = b.sampleCount || 0;
    const min = b.minSampleThreshold || MIN_SAMPLE_THRESHOLD;
    return { eligible: false, reason: `基线未建立（已完成 ${done}/${min} 次有效采集）` };
  }
  if (!snapshot || !snapshot.quality || snapshot.quality.valid !== true) {
    return { eligible: false, reason: '本轮采集质量不足，暂不判断趋势' };
  }
  return { eligible: true, reason: '趋势可判断' };
}

/**
 * 当前快照 vs baseline 的参照比较（只产参照值，方向判定交给 momentumEngine）。
 *
 * @param {Object} snapshot 本轮快照
 * @param {Object} baseline buildBaseline 产物
 * @returns {{
 *   currentRate:number|null,   // 本轮命中率（0-1）
 *   baselineRate:number|null,  // 基线命中率（0-1）
 *   aboveBaseline:boolean|null,// 是否高于基线
 * }}
 */
export function compareToBaseline(snapshot, baseline) {
  const s = snapshot || {};
  const b = baseline || {};
  const currentRate = s.hitRate != null ? s.hitRate : null;
  const baselineRate = b.baselineValue != null ? b.baselineValue : null;
  let aboveBaseline = null;
  if (currentRate != null && baselineRate != null) {
    aboveBaseline = currentRate > baselineRate;
  }
  return { currentRate, baselineRate, aboveBaseline };
}

/**
 * 版本失效判定：核心场景版本变化 → 旧 baseline 不可比，返回 true（需重建）。
 *
 * @param {Object} baseline buildBaseline 产物
 * @param {string} newVersion 新的核心场景版本
 * @returns {boolean}
 */
export function isBaselineStale(baseline, newVersion) {
  const b = baseline || {};
  const v = newVersion || CORE_SCENE_VERSION;
  return !!b.coreSceneVersion && b.coreSceneVersion !== v;
}

/**
 * 累计历史快照：追加新快照 + 去重 + 只保留窗口内有效快照（供存储层用）。
 *
 * @param {Array<Object>} history 历史快照
 * @param {Object} snapshot 本轮快照（normalizeSnapshot 产物）
 * @param {Object} [opts] { now, windowDays, coreSceneVersion }
 * @returns {Array<Object>} 累计后的快照数组（窗口内有效快照）
 */
export function accumulateSnapshots(history, snapshot, opts = {}) {
  const list = Array.isArray(history) ? history : [];
  const next = [...list];
  if (snapshot && snapshot.quality && snapshot.quality.valid === true) {
    next.push(snapshot);
  }
  // 去重：同一 capturedAt 只保留最后一条
  const seen = new Set();
  const deduped = next.filter((s) => {
    const k = s && s.capturedAt;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return filterValidSnapshots(deduped, opts);
}

export default {
  COVERAGE_THRESHOLD,
  MIN_SAMPLE_THRESHOLD,
  OBSERVATION_WINDOW_DAYS,
  CORE_SCENE_VERSION,
  QUALITY_LEVEL,
  QUALITY_LEVEL_LABEL,
  assessCollectionQuality,
  normalizeSnapshot,
  filterValidSnapshots,
  buildBaseline,
  trendEligibility,
  compareToBaseline,
  isBaselineStale,
  accumulateSnapshots,
};
