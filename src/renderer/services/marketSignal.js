/**
 * marketSignal —— 「市场与声势」事实层（先回答「现在有没有、是多少、在哪里发生」）。
 *
 * 设计依据：docs/企业声势-数据模型-v1.md §0/§3.2 + docs/AI搜索核心场景采集协议-v1.md。
 * 性质：纯函数，不 import React / store / localStorage，不发网络。
 *
 * 核心原则（本轮）：
 *   「没有历史基线」≠「没有数据」。
 *   趋势判断（momentumEngine）需要 baseline 才能算 ↑/→/↓；但「当前可见性」
 *   只依赖「当前有没有被看到」，不需要 baseline。
 *
 * 三层分离：
 *   事实层（本文件）→ 现在有没有、是多少、在哪里
 *   趋势层（momentumEngine）→ 相对稳定基线变好还是变坏（只在有基线时产出）
 *   判断/行动层（marketMomentum）→ 是否改变经营者下一步选择、调整哪个专项
 *
 * 采集协议（核心场景 vs 探索场景，必须分开）：
 *   - 核心场景（coreSearchScenes）：固定 20 个，形成长期 baseline，分母稳定可比。
 *   - 探索场景（explore）：临时发现的新问题，市场侦察，不污染趋势基线。
 *   7/20 的 20 是产品定义的核心场景数，不是后端这次实际问了几句。
 *
 * 三种可见性状态（visibility.state）：
 *   visible     有数据（看到企业了）→ 当前可见性快照 + 建立基线
 *   not_found   搜了但没搜到        → 可见性偏低（≠数据不足）
 *   no_data     采集失败 / 未覆盖    → 告诉为什么 + 采集动作
 *
 * 三种数据源状态（sourceState，与 visibility 正交）：
 *   ready           数据源已接入，本轮拿到结果
 *   collecting      数据源已接入，但本轮还没拿到完整结果（运行状态）
 *   not_connected   数据源尚未接入（产品能力边界）
 */

import { alignScenesToCore, getActiveCoreScenes } from '../config/coreSearchScenes.js';

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 可见性三态。 */
export const VISIBILITY_STATE = {
  VISIBLE: 'visible',
  NOT_FOUND: 'not_found',
  NO_DATA: 'no_data',
};

/** 数据源三态。 */
export const SOURCE_STATE = {
  READY: 'ready',
  COLLECTING: 'collecting',
  NOT_CONNECTED: 'not_connected',
};

/** 数据源状态中文标签。 */
export const SOURCE_STATE_LABEL = {
  ready: '已接入',
  collecting: '正在采集',
  not_connected: '数据源尚未接入',
};

/**
 * 从 realScan.self.questions 归一化「盲测场景」。
 * 后端问题字段可能是 question / q / prompt；命中字段可能是 mentioned / hit。
 * @param {Array} questions
 * @returns {Array<{question:string, mentioned:boolean}>}
 */
export function normalizeScenes(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q) => {
      if (!q || typeof q !== 'object') return null;
      const question = str(q.question || q.q || q.prompt);
      if (!question) return null;
      return { question, mentioned: !!(q.mentioned || q.hit) };
    })
    .filter(Boolean);
}

/**
 * 从 realScan 提取「AI 搜索曝光」的当前可见性快照（对齐核心场景清单）。
 *
 * realScan = geoExposure.diagnoseExposure 返回的 realScan：
 *   { self: { mention_prob(0-1), indexed_count, sentiment_cn, questions[] }, competitors[], conclusion }
 *
 * 对齐逻辑（核心场景优先）：
 *   1. 后端有 questions → alignScenesToCore 对齐核心场景，算 coreMentioned / coreCovered / coreTotal；
 *      分母 = 核心场景总数（稳定），不是后端实际问句数。
 *   2. 无 questions 但 mention_prob 有值 → 概率兜底（缺场景明细）。
 *   3. 都没有 → no_data。
 *
 * @param {Object|null} realScan
 * @returns {{
 *   state: 'visible'|'not_found'|'no_data',
 *   sourceState: 'ready'|'collecting'|'not_connected',
 *   mentioned: number|null,        // 核心场景命中数（对齐后）
 *   total: number|null,            // 核心场景总数（稳定分母）
 *   coreCovered: number|null,      // 本轮实际覆盖的核心场景数
 *   coreMissedSceneIds: string[],  // 清单里有但本轮未覆盖的核心场景 id
 *   prob: number|null,             // AI 盲测提及概率（0-100）
 *   indexed: number|null,          // 官网 site 收录数
 *   scenes: Array,                 // 后端原始场景（归一化后）
 *   exploreScenes: Array,          // 探索场景（不进基线）
 *   summary: string,               // 一句话「现在有没有 / 是多少」
 *   judgment: string,              // 豆芽判断（当前可见性，非趋势）
 *   nextAction: string,            // 豆芽下一步
 * }}
 */
export function buildAiSearchVisibility(realScan) {
  const self = (realScan && realScan.self) || {};
  const questions = Array.isArray(self.questions) ? self.questions : [];
  const mentionProb = typeof self.mention_prob === 'number' ? self.mention_prob : null;
  const indexed = typeof self.indexed_count === 'number' ? self.indexed_count : null;

  const scenes = normalizeScenes(questions);
  const prob = mentionProb != null ? Math.round(mentionProb * 100) : null;

  // —— 情况 1：有场景明细 → 对齐核心场景清单 ——
  if (scenes.length > 0) {
    const aligned = alignScenesToCore(scenes, getActiveCoreScenes());
    const { coreMentioned, coreCovered, coreTotal, coreMissedSceneIds, exploreScenes } = aligned;

    // 覆盖不全：诚实标注「本轮只覆盖了 X/20 核心场景」
    const fullCoverage = coreCovered === coreTotal && coreTotal > 0;

    if (coreMentioned > 0) {
      return {
        state: VISIBILITY_STATE.VISIBLE,
        sourceState: SOURCE_STATE.READY,
        mentioned: coreMentioned,
        total: coreTotal,
        coreCovered,
        coreMissedSceneIds,
        prob,
        indexed,
        scenes,
        exploreScenes,
        summary: fullCoverage
          ? `当前已发现企业在 ${coreMentioned}/${coreTotal} 个核心搜索场景中被 AI 提及`
          : `本轮覆盖 ${coreCovered}/${coreTotal} 个核心场景，其中 ${coreMentioned} 个被 AI 提及（另有 ${coreTotal - coreCovered} 个核心场景未采集）`,
        judgment: '企业已经具备一定 AI 搜索可见性，但覆盖仍集中在少数场景，暂时无法判断上升还是下降',
        nextAction: '持续采集，建立基线后再判断趋势',
      };
    }
    if (coreCovered > 0) {
      // 覆盖了核心场景但一个都没被提及 → 可见性偏低
      return {
        state: VISIBILITY_STATE.NOT_FOUND,
        sourceState: SOURCE_STATE.READY,
        mentioned: 0,
        total: coreTotal,
        coreCovered,
        coreMissedSceneIds,
        prob: prob != null ? prob : 0,
        indexed,
        scenes,
        exploreScenes,
        summary: fullCoverage
          ? `当前 ${coreTotal} 个核心搜索场景暂未发现企业被 AI 明确提及`
          : `本轮覆盖 ${coreCovered}/${coreTotal} 个核心场景，均未发现企业被 AI 明确提及（另有 ${coreTotal - coreCovered} 个核心场景未采集）`,
        judgment: '这更像是外部可见性不足，而不是数据不足',
        nextAction: '优先补充核心选型场景内容',
      };
    }
    // 后端问了但全部落在探索场景（没问到核心场景）→ 诚实说明核心场景未覆盖
    return {
      state: VISIBILITY_STATE.NO_DATA,
      sourceState: SOURCE_STATE.COLLECTING,
      mentioned: 0,
      total: coreTotal,
      coreCovered: 0,
      coreMissedSceneIds,
      prob,
      indexed,
      scenes,
      exploreScenes,
      summary: `本轮未覆盖 ${coreTotal} 个核心场景（仅 ${exploreScenes.length} 个探索场景）`,
      judgment: '当前采集还没问到产品定义的核心场景，暂不能判断核心可见性',
      nextAction: '按核心场景清单重新采集',
    };
  }

  // —— 情况 2：无场景明细，但有提及概率 ——
  if (mentionProb != null) {
    if (mentionProb > 0) {
      return {
        state: VISIBILITY_STATE.VISIBLE,
        sourceState: SOURCE_STATE.READY,
        mentioned: null,
        total: null,
        coreCovered: null,
        coreMissedSceneIds: [],
        prob,
        indexed,
        scenes,
        exploreScenes: [],
        summary: `AI 盲测提及概率 ${prob}%`,
        judgment: '企业已被 AI 提及，但缺少具体场景明细，暂不判断趋势',
        nextAction: '持续采集，建立基线并补全场景明细',
      };
    }
    return {
      state: VISIBILITY_STATE.NOT_FOUND,
      sourceState: SOURCE_STATE.READY,
      mentioned: 0,
      total: null,
      coreCovered: null,
      coreMissedSceneIds: [],
      prob: 0,
      indexed,
      scenes,
      exploreScenes: [],
      summary: 'AI 盲测暂未提及企业',
      judgment: '外部可见性偏低，建议优先补充核心选型场景内容',
      nextAction: '优先补充核心选型场景内容',
    };
  }

  // —— 情况 3：完全没数据（数据源已接入，但本轮没拿到结果） ——
  return {
    state: VISIBILITY_STATE.NO_DATA,
    sourceState: SOURCE_STATE.COLLECTING,
    mentioned: null,
    total: getActiveCoreScenes().length,
    coreCovered: null,
    coreMissedSceneIds: [],
    prob: null,
    indexed,
    scenes,
    exploreScenes: [],
    summary: '本轮采集未返回有效结果',
    judgment: '数据源已接入，但本轮还没拿到完整结果',
    nextAction: '正在采集，稍后重试',
  };
}

/**
 * 数据源能力说明（产品能力边界 vs 运行状态的区分）。
 * 返回该维度数据源的接入状态 + 接入后的预期。
 */
export function dimensionSource(dimensionId) {
  switch (dimensionId) {
    case 'ai_search_exposure':
      return { sourceState: SOURCE_STATE.READY, hint: '数据源：豆芽工作台 GEO 实抓（问 AI 盲测 + 搜狗收录）' };
    case 'media_volume':
      return { sourceState: SOURCE_STATE.NOT_CONNECTED, hint: '接入媒体监测后，豆芽将开始建立企业媒体声量基线' };
    case 'brand_sentiment':
      return { sourceState: SOURCE_STATE.NOT_CONNECTED, hint: '接入舆情监测后，豆芽将开始建立企业品牌舆情基线' };
    case 'content_activity':
      return { sourceState: SOURCE_STATE.NOT_CONNECTED, hint: '接入企业内容系统后，豆芽将开始统计内容发布活跃度' };
    default:
      return { sourceState: SOURCE_STATE.NOT_CONNECTED, hint: '数据源尚未接入' };
  }
}

/**
 * 总入口：按维度提取「当前可见性」快照 + 数据源状态。
 * 目前只有 ai_search_exposure 有真实数据源（geoExposure.diagnoseExposure 的 realScan）；
 * 其余维度（media_volume / brand_sentiment / content_activity）→ not_connected（产品能力边界）。
 *
 * @param {Object|null} realScan
 * @param {string} dimensionId
 * @returns {Object} 含 visibility（三态）与 sourceState / hint
 */
export function buildVisibilitySnapshot(realScan, dimensionId) {
  if (dimensionId === 'ai_search_exposure') {
    return buildAiSearchVisibility(realScan);
  }
  const ds = dimensionSource(dimensionId);
  return {
    state: VISIBILITY_STATE.NO_DATA,
    sourceState: ds.sourceState,
    mentioned: null,
    total: null,
    coreCovered: null,
    coreMissedSceneIds: [],
    prob: null,
    indexed: null,
    scenes: [],
    exploreScenes: [],
    summary: '数据源尚未接入',
    judgment: '当前没有足够数据判断该维度外部可见性',
    nextAction: ds.hint,
  };
}

export default {
  VISIBILITY_STATE,
  SOURCE_STATE,
  SOURCE_STATE_LABEL,
  normalizeScenes,
  buildAiSearchVisibility,
  dimensionSource,
  buildVisibilitySnapshot,
};
