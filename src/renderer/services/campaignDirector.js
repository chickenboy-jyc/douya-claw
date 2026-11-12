/**
 * campaignDirector —— 「营销专项」意图识别 + 草案生成（纯函数，无副作用，可测试）。
 *
 * 设计文档：docs/营销专项-设计定稿.md v3 §4（7 类专项）+ §5（一句话建专项）+ §6（五段式）。
 * 性质：纯映射 + 结构草案。把「一句话」翻译成「关键词匹配结果 + 五段式草案」。
 * 不接真实 AI（v3 §12「意图识别 Prompt 待编码」），第一版用关键词规则 + 结构化骨架，
 * 所有 AI 推导一律进 assumptions（AI假设标签），事实缺失写「暂无数据」，绝不编造。
 *
 * 与 activityDirector.js 解耦：本文件只做「意图 → 专项草案」这一层，不碰活动策划模型。
 */

import {
  CAMPAIGN_TYPES,
} from '../store/campaignStore.jsx';
import {
  ACTIVITY_SUBJECTS,
  DEFAULT_SUBJECT,
} from '../config/activitySubjects.js';

/** 7 类专项的关键词特征（顺序即优先级，命中即止）。 */
const TYPE_KEYWORDS = [
  { type: 'expo', keywords: ['展会', '口腔展', '华南展', '展台', '参展', '博览会'] },
  { type: 'launch', keywords: ['新品', '上市', '发布', '首发', '上市推广'] },
  { type: 'academic', keywords: ['学术', '沙龙', '培训', '研讨会', '讲课', '医生教育', '学术会'] },
  { type: 'crisis', keywords: ['舆情', '危机', '负面', '公关', '辟谣'] },
  { type: 'channel', keywords: ['招商', '渠道', '经销商', '代理', '铺货', '招商会'] },
  { type: 'patient', keywords: ['获客', '患者', '到店', '引流', '种草', '导流'] },
  { type: 'content', keywords: ['内容', '曝光', 'AI搜索', '搜索', 'GEO', '文章', '媒体', '声量', '品牌', '传播'] },
];

/** 三阶段骨架（v3 §6.3：建资产 → 放大曝光 → 沉淀复盘，日期待老板确认，标 AI假设）。 */
const STAGE_SKELETON = [
  { key: 'asset', name: '第一阶段 · 建资产', milestones: ['明确核心产品与目标客群', '准备内容场景与素材'] },
  { key: 'exposure', name: '第二阶段 · 放大曝光', milestones: ['内容发布与传播', '关键指标监测'] },
  { key: 'review', name: '第三阶段 · 沉淀复盘', milestones: ['结果复盘', '沉淀进企业大脑'] },
];

/**
 * 识别一句话意图 → 专项类型 / 主体 / 名称 / 目标提示。
 * @param {string} text 用户一句话
 * @param {Object} [opts] { subjectType, companyType, companyName }
 * @returns {{ type:string, typeLabel:string, subjectType:string, subjectLabel:string, name:string, goalHint:string }}
 */
export function recognizeCampaignIntent(text, opts = {}) {
  const t = (text || '').trim();
  let type = '';
  for (const rule of TYPE_KEYWORDS) {
    if (rule.keywords.some((k) => t.includes(k))) {
      type = rule.type;
      break;
    }
  }
  if (!type) type = 'content'; // 兜底：内容传播（最常见、覆盖面最广）

  const subjectType = Object.prototype.hasOwnProperty.call(ACTIVITY_SUBJECTS, opts.subjectType)
    ? opts.subjectType
    : DEFAULT_SUBJECT;
  const subjectLabel = asLabel(subjectType, opts.companyName);

  const name = buildName(t, type);
  const goalHint = buildGoalHint(t);

  return {
    type,
    typeLabel: CAMPAIGN_TYPES[type],
    subjectType,
    subjectLabel,
    name,
    goalHint,
  };
}

/** 从一句话提炼目标提示（只做关键词映射，不编造数据，提炼不出就空）。 */
function buildGoalHint(t) {
  if (!t) return '';
  // 提取「提高 / 提升 / 增加 / 覆盖」等目标短语
  const m = t.match(/(提高|提升|增加|覆盖|扩大|加强|降低|减少)[^，。；,;]{0,20}/);
  return m ? m[0] : '';
}

/** 生成专项名（一句话截断 + 类型语义，避免空名）。 */
function buildName(t, type) {
  const clean = t.replace(/[，。；,;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean) {
    const short = clean.length > 18 ? clean.slice(0, 18) : clean;
    return `${short} · ${CAMPAIGN_TYPES[type]}`;
  }
  return CAMPAIGN_TYPES[type];
}

function asLabel(subjectType, companyName) {
  const label = (ACTIVITY_SUBJECTS[subjectType] && ACTIVITY_SUBJECTS[subjectType].label) || '';
  return companyName ? `${label} · ${companyName}` : label;
}

/**
 * 由识别结果生成五段式草案（结构化骨架，AI假设显式标注，事实缺失写「暂无数据」）。
 * @param {Object} rec recognizeCampaignIntent 产物
 * @param {Object} [opts] { source, sourceChangeId, briefText }
 * @returns {Object} Campaign draft（不含 id/companyId/status，由 store.createCampaign 补齐）
 */
export function draftCampaign(rec, opts = {}) {
  const source = opts.source || 'user';
  const briefText = opts.briefText || '';

  const assumptions = [
    `专项类型暂按「${rec.typeLabel}」识别（AI假设，待确认）`,
    '目标客群暂按主体默认受众（AI假设，待确认）',
    '预算未确定（不默认，需老板确认）',
  ];

  const outcomes = {
    businessOutcome: rec.goalHint ? `围绕「${rec.goalHint}」达成的经营结果（待确认）` : '待确认',
    momentumOutcome: '核心搜索 / 曝光场景覆盖（待确认）',
    deliveryPlan: '内容与传播计划（待确认）',
  };

  const stages = STAGE_SKELETON.map((s) => ({
    ...s,
    startDate: '待定',
    endDate: '待定',
  }));

  const actions = [
    {
      owner: 'douya',
      status: 'todo',
      title: '确认目标客群与核心产品线',
      why: '先锁定打谁、打什么，后续阶段才有明确方向（AI假设，待确认）',
    },
    {
      owner: 'boss',
      status: 'todo',
      title: '预算额度',
      why: '预算决定传播规模，绝不默认，需要你决定',
    },
  ];

  const decisions = [
    { title: '预算额度', status: 'pending' },
    { title: '目标客群', status: 'pending' },
  ];

  return {
    name: rec.name,
    subjectType: rec.subjectType,
    subjectLabel: rec.subjectLabel,
    type: rec.type,
    brief: {
      intent: briefText,
      problem: '',
      evidence: [],
      suggestion: '',
      source,
      sourceChangeId: opts.sourceChangeId || null,
      assumptions,
    },
    whyNow: {
      facts: ['暂无数据（豆芽尚未采集到可确认的外部事实，不编造）'],
      // 措辞红线：结论会渲染在 CampaignModule 三处（L379 / L546 / L670），
      // 其中 L546 前面已带「豆芽判断：」前缀，故这里**不带「豆芽」主语**，
      // 三处读起来都通顺。且不得写「识别」——本链路是本地关键词规则，未接模型。
      conclusion: `按你这句话里的关键词匹配到「${rec.typeLabel}」专项${rec.goalHint ? `，核心目标指向「${rec.goalHint}」` : ''}。`,
    },
    outcomes,
    stages,
    actions: actions.map((a) => ({ ...a, id: undefined })),
    decisions,
    results: {
      executionDone: 0,
      executionTotal: actions.length,
      businessOutcome: '暂无数据',
      momentumOutcome: '暂无数据',
    },
    review: null,
  };
}

/**
 * 三套「打法」方案（多方案卡片式选择的来源）。
 * 用户 2026-09-10 定调：活动策划要多方案卡片式选择，不是单方案向导。
 * 三套打法跨四类主体（厂家/平台/经销商/诊所）通用，各落到一个 CAMPAIGN_TYPES：
 *   - 获客转化：低门槛钩子，把线索抓进来（patient 获客）
 *   - 渠道裂变：借渠道/老客放大（channel 渠道招商）
 *   - 内容声量：内容/媒体/AI搜索建长期声量（content 内容传播）
 */
const PLAY_OPTIONS = [
  {
    key: 'hook',
    type: 'patient',
    title: '获客转化打法',
    tagline: '低门槛钩子，把目标客群的线索先抓进来',
    reason: '先让目标客群低成本试第一单、留资，把线索抓进来，是拉新最快的一条路；适合想短期看到线索增长。',
  },
  {
    key: 'channel',
    type: 'channel',
    title: '渠道裂变打法',
    tagline: '借现有渠道 / 老客做裂变，低成本放大',
    reason: '借现有经销商、老客户的人脉做推荐裂变，线索来源广、边际成本低；适合已有稳定渠道、想放量的情况。',
  },
  {
    key: 'content',
    type: 'content',
    title: '内容声量打法',
    tagline: '内容 / 媒体 / AI搜索曝光，长线建声量',
    reason: '用内容持续建立品牌与专业认知，声量沉淀后线索更稳、复购更高；适合想长期经营品牌声量、不急于短期冲量。',
  },
];

/**
 * 一句话 → 3 套不同打法的完整草案（多方案卡片）。
 * 每套 = 一套独立「打法」+ 对应 type 的完整 Campaign 草案（选中后直接落库，无需二次生成）。
 * 结合 recognizeCampaignIntent 识别的主体/名称/目标提示，仅打法 type 不同。
 *
 * @param {string} text 用户一句话
 * @param {Object} [opts] { subjectType, companyType, companyName, source, sourceChangeId, briefText }
 * @returns {Array<{id:string, play:string, title:string, tagline:string, reason:string, type:string, draft:Object}>}
 */
export function buildCampaignOptionCards(text, opts = {}) {
  const base = recognizeCampaignIntent(text, opts);
  return PLAY_OPTIONS.map((p) => {
    // 每套打法：覆盖 type，名称带上打法标签以区分三张卡
    const rec = {
      ...base,
      type: p.type,
      typeLabel: CAMPAIGN_TYPES[p.type],
      name: `${base.name.replace(new RegExp(' · ' + base.typeLabel + '$'), '')} · ${p.title}`,
    };
    const draft = draftCampaign(rec, {
      source: opts.source || 'user',
      sourceChangeId: opts.sourceChangeId || null,
      briefText: opts.briefText || text,
    });
    // 草案 whyNow.conclusion 追加打法理由，让老板看到「为什么这么打」
    draft.whyNow = {
      ...draft.whyNow,
      conclusion: `${draft.whyNow.conclusion}\n\n打法选择：${p.title}——${p.reason}`,
    };
    return {
      id: 'option-' + p.key,
      play: p.key,
      title: p.title,
      tagline: p.tagline,
      reason: p.reason,
      type: p.type,
      draft,
    };
  });
}

export default {
  recognizeCampaignIntent,
  draftCampaign,
  buildCampaignOptionCards,
  CAMPAIGN_TYPES,
};
