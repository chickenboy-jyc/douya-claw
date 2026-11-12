/**
 * directionCatalog —— 「经营方案」方向模板库（唯一事实源）。
 *
 * 设计依据：docs/First-run-SQP-经营方案-v1.md（2026-09-10）。
 * 性质：纯常量，不 import React / store / localStorage，不发网络。
 *
 * 核心概念（本轮升级）：
 *   「经营方案 Direction」是比「营销专项 Campaign」更高一层的一级对象。
 *   用户刚进来不知道「要创建什么 Campaign」，只知道「想把公司做起来」。
 *   所以豆芽根据企业认知 + 当前阶段，主动给 3 个经营方向，用户只选一个，
 *   豆芽自动搭建整条链路（经营目标 → 专项 → 传播计划 → 执行任务 → 市场监测 → 每日运营）。
 *
 * 五主体差异化：厂家 / 门诊 / 医生 / 经销商 / 平台 的经营方向完全不同。
 * 每个方向绑定一个「主专项类型」（映射 campaignStore.CAMPAIGN_TYPES）。
 *
 * 诚实边界：
 *   - summary 是「豆芽判断」（基于主体 + 阶段的方向建议），不是事实，UI 需带「AI假设」语境；
 *   - expectedPeriodDays 是「预计周期」，不是承诺，用户可调整。
 */

/** 经营方向 key（跨主体统一语义，便于排序/统计）。 */
export const DIRECTION_KEYS = {
  GROWTH: 'growth', // 获客 / 增长
  LAUNCH: 'launch', // 新品 / 项目推广
  GEO: 'geo', // AI 搜索可见性 / 内容增长
  BRAND: 'brand', // 品牌 / 口碑建设
  CHANNEL: 'channel', // 渠道 / 招商
  DOCTOR_IP: 'doctor_ip', // 医生 / 个人 IP
  PRIVATE: 'private', // 私域 / 复购
};

/** 经营方案状态（历史不丢，换方向 = 暂停旧方向，非删除）。 */
export const DIRECTION_STATUS = {
  active: '当前方向',
  paused: '已暂停',
};

/**
 * 五主体 × 3 个经营方向方案模板（厂家 / 门诊 / 医生 / 经销商 / 平台）。
 * 每方向字段：
 *   key        方向 key（DIRECTION_KEYS）
 *   name       方向名（老板视角）
 *   summary    豆芽判断（为什么值得做）
 *   expectedPeriodDays 预计周期
 *   campaignType 主专项类型（CAMPAIGN_TYPES 的 key）
 *   campaignHint 主专项一句话（喂给 campaignDirector 生成主专项）
 *   deliveryPlan 传播计划结构 { content, media, case }（数量是豆芽建议，非承诺）
 *   actions     执行任务（能力动作，title + capability）
 *   monitor     市场监测维度（对齐 marketSignal 的 dimensionId）
 */
export const DIRECTION_CATALOG = {
  manufacturer: [
    {
      key: DIRECTION_KEYS.LAUNCH,
      name: '新品增长',
      summary: '当前新品已具备基础内容资产，但外部认知不足。建议做一次完整的推广：先让人看到，再出内容，最后找到客户。',
      expectedPeriodDays: 30,
      campaignType: 'launch',
      campaignHint: '围绕新品做推广，让人看到并找到客户',
      deliveryPlan: { content: 6, media: 5, case: 3 },
      actions: [
        { title: '完善新品卖点与核心场景内容', capability: 'content' },
        { title: '制定新品 AI 搜索场景内容计划', capability: 'geo' },
        { title: '制定媒体传播计划', capability: 'media' },
        { title: '梳理重点客户触达名单', capability: 'content' },
      ],
      monitor: ['ai_search_exposure', 'media_volume', 'content_activity'],
    },
    {
      key: DIRECTION_KEYS.GEO,
      name: 'AI 搜索可见性',
      summary: '目前企业已经能被部分 AI 搜索场景发现，但核心采购场景覆盖不足。建议按采购场景逐条补内容，让客户搜的时候能找到你。',
      expectedPeriodDays: 45,
      campaignType: 'content',
      campaignHint: '按采购场景逐条补内容',
      deliveryPlan: { content: 12, media: 3, case: 2 },
      actions: [
        { title: '梳理核心采购场景清单', capability: 'geo' },
        { title: '逐场景生成选型内容', capability: 'content' },
        { title: '制定内容分发节奏', capability: 'media' },
      ],
      monitor: ['ai_search_exposure', 'content_activity'],
    },
    {
      key: DIRECTION_KEYS.BRAND,
      name: '行业品牌建设',
      summary: '行业内容持续性不足，媒体和专家内容资产偏少。建议建立行业内容 + 媒体传播 + 专家观点体系。',
      expectedPeriodDays: 60,
      campaignType: 'content',
      campaignHint: '建立行业内容与媒体传播体系',
      deliveryPlan: { content: 10, media: 8, case: 4 },
      actions: [
        { title: '制定行业内容选题体系', capability: 'content' },
        { title: '梳理行业媒体与专家资源', capability: 'media' },
        { title: '生成首批行业观点内容', capability: 'content' },
      ],
      monitor: ['media_volume', 'brand_sentiment', 'content_activity'],
    },
  ],
  clinic: [
    {
      key: DIRECTION_KEYS.GROWTH,
      name: '患者获客',
      summary: '当前门诊需要稳定新客来源，建议围绕核心项目建立同城内容 + 到店活动 + 私域承接的获客专项。',
      expectedPeriodDays: 30,
      campaignType: 'patient',
      campaignHint: '围绕核心项目把同城获客这条路走通',
      deliveryPlan: { content: 8, media: 4, case: 2 },
      actions: [
        { title: '梳理核心项目卖点与获客渠道', capability: 'content' },
        { title: '制定同城内容计划', capability: 'geo' },
        { title: '设计到店引流活动', capability: 'activity' },
        { title: '制定私域承接话术', capability: 'content' },
      ],
      monitor: ['ai_search_exposure', 'content_activity'],
    },
    {
      key: DIRECTION_KEYS.DOCTOR_IP,
      name: '医生 IP',
      summary: '医生个人品牌是门诊长期信任资产，建议建立医生人设 + 科普内容 + 专业信任体系。',
      expectedPeriodDays: 45,
      campaignType: 'content',
      campaignHint: '建立医生 IP 与科普内容体系',
      deliveryPlan: { content: 12, media: 3, case: 3 },
      actions: [
        { title: '梳理医生人设与差异化标签', capability: 'content' },
        { title: '制定 30 天科普选题表', capability: 'content' },
        { title: '生成首批医生 IP 内容', capability: 'content' },
      ],
      monitor: ['content_activity', 'brand_sentiment'],
    },
    {
      key: DIRECTION_KEYS.PRIVATE,
      name: '私域复购',
      summary: '存量患者价值未被充分挖掘，建议建立私域运营 + 复购召回 + 口碑转介绍体系。',
      expectedPeriodDays: 30,
      campaignType: 'content',
      campaignHint: '建立私域运营与复购召回体系',
      deliveryPlan: { content: 8, media: 2, case: 2 },
      actions: [
        { title: '设计私域欢迎语与钩子', capability: 'content' },
        { title: '制定复购召回话术', capability: 'content' },
        { title: '设计口碑转介绍活动', capability: 'activity' },
      ],
      monitor: ['content_activity'],
    },
  ],
  doctor: [
    {
      key: DIRECTION_KEYS.DOCTOR_IP,
      name: '个人 IP 增长',
      summary: '医生个人品牌需要持续内容投入，建议建立人设 + 科普 + 粉丝增长的内容体系。',
      expectedPeriodDays: 45,
      campaignType: 'content',
      campaignHint: '建立个人 IP 与科普内容体系',
      deliveryPlan: { content: 12, media: 3, case: 2 },
      actions: [
        { title: '梳理人设与差异化标签', capability: 'content' },
        { title: '制定 30 天内容选题表', capability: 'content' },
        { title: '生成首批口播脚本', capability: 'content' },
      ],
      monitor: ['content_activity'],
    },
    {
      key: DIRECTION_KEYS.GROWTH,
      name: '专业信任',
      summary: '专业信任是医生转化的核心，建议建立专业背书 + 真实案例 + 合规表达体系。',
      expectedPeriodDays: 30,
      campaignType: 'content',
      campaignHint: '建立专业信任与合规表达体系',
      deliveryPlan: { content: 8, media: 2, case: 4 },
      actions: [
        { title: '梳理专业背书与资质素材', capability: 'content' },
        { title: '生成专业形象塑造内容', capability: 'content' },
        { title: '制定真实案例合规表达规范', capability: 'content' },
      ],
      monitor: ['brand_sentiment', 'content_activity'],
    },
    {
      key: DIRECTION_KEYS.CHANNEL,
      name: '同行影响',
      summary: '同行愿意替你说话，专业形象就立得住，建议建立行业观点 + 学术内容 + 同行传播体系。',
      expectedPeriodDays: 60,
      campaignType: 'academic',
      campaignHint: '建立行业观点与学术传播体系',
      deliveryPlan: { content: 10, media: 5, case: 3 },
      actions: [
        { title: '梳理行业观点选题', capability: 'content' },
        { title: '制定学术内容计划', capability: 'media' },
        { title: '生成首批行业观点内容', capability: 'content' },
      ],
      monitor: ['media_volume', 'content_activity'],
    },
  ],
  platform: [
    {
      key: DIRECTION_KEYS.CHANNEL,
      name: '商家招商',
      summary: '平台增长核心在商家规模，建议建立招商政策 + 邀约 + 城市沙龙体系的招商专项。',
      expectedPeriodDays: 45,
      campaignType: 'channel',
      campaignHint: '建立商家招商与邀约体系',
      deliveryPlan: { content: 10, media: 6, case: 4 },
      actions: [
        { title: '梳理平台招商政策与卖点', capability: 'content' },
        { title: '生成商家招商邀约文案', capability: 'content' },
        { title: '策划城市招商沙龙', capability: 'activity' },
        { title: '制定招商内容分发计划', capability: 'media' },
      ],
      monitor: ['ai_search_exposure', 'media_volume', 'content_activity'],
    },
    {
      key: DIRECTION_KEYS.BRAND,
      name: '平台品牌',
      summary: '平台品牌名气不够，建议做行业内容 + 媒体传播 + 标杆案例。',
      expectedPeriodDays: 60,
      campaignType: 'content',
      campaignHint: '建立平台品牌与行业口碑',
      deliveryPlan: { content: 12, media: 8, case: 6 },
      actions: [
        { title: '制定平台品牌内容策略', capability: 'geo' },
        { title: '生成平台品牌口碑内容', capability: 'content' },
        { title: '制定行业媒体投放计划', capability: 'media' },
      ],
      monitor: ['media_volume', 'brand_sentiment', 'content_activity'],
    },
    {
      key: DIRECTION_KEYS.GROWTH,
      name: '商家增长赋能',
      summary: '商家留存与增长是平台价值证明，建议建立标杆案例 + 培训赋能 + 增长内容体系。',
      expectedPeriodDays: 45,
      campaignType: 'content',
      campaignHint: '建立商家增长案例与培训赋能体系',
      deliveryPlan: { content: 10, media: 4, case: 6 },
      actions: [
        { title: '梳理商家增长案例', capability: 'content' },
        { title: '生成标杆商家案例内容', capability: 'content' },
        { title: '制定商家培训课程大纲', capability: 'content' },
      ],
      monitor: ['content_activity', 'brand_sentiment'],
    },
  ],
  // 经销商（dealer）：老板 2026-10 裁决新增主体。经营方向围绕「拓店 / 渠道 / 动销 / 库存 / 返利 / 终端」，
  // 与厂家（品牌/产品/学术）视角**彻底分化**——不写品牌建设、不写招商获客，只写「拿货走量、把货卖到终端」。
  dealer: [
    {
      key: DIRECTION_KEYS.CHANNEL,
      name: '拓店招商',
      summary: '作为经销商当前区域终端门店覆盖不足，建议围绕拓店政策建立「招商内容 → 门店开发 → 区域活动」的拓店专项。',
      expectedPeriodDays: 30,
      campaignType: 'channel',
      campaignHint: '定好拓店政策，把门店开发这条路走通',
      deliveryPlan: { content: 8, media: 4, case: 2 },
      actions: [
        { title: '梳理拓店政策与返利卖点', capability: 'content' },
        { title: '生成门店开发话术', capability: 'content' },
        { title: '制定区域拓店计划', capability: 'media' },
        { title: '策划门店签约活动', capability: 'activity' },
      ],
      monitor: ['content_activity', 'media_volume'],
    },
    {
      key: DIRECTION_KEYS.GROWTH,
      name: '渠道动销',
      summary: '作为经销商货铺出去了但终端动销慢、库存周转低，建议建立「终端内容 → 门店活动 → 库存清理」的动销专项。',
      expectedPeriodDays: 30,
      campaignType: 'content',
      campaignHint: '把终端动销与库存周转这条路走通',
      deliveryPlan: { content: 8, media: 3, case: 2 },
      actions: [
        { title: '梳理终端动销卖点与话术', capability: 'content' },
        { title: '生成终端促销内容', capability: 'content' },
        { title: '制定门店动销活动方案', capability: 'activity' },
        { title: '梳理滞销库存清理计划', capability: 'content' },
      ],
      monitor: ['content_activity'],
    },
    {
      key: DIRECTION_KEYS.LAUNCH,
      name: '新品铺货',
      summary: '作为经销商拿到厂家新品后区域铺货不到位，建议建立「铺货政策 → 门店推广 → 终端陈列」的新品铺货专项。',
      expectedPeriodDays: 45,
      campaignType: 'launch',
      campaignHint: '把新品铺货与门店推广这条路走通',
      deliveryPlan: { content: 6, media: 4, case: 3 },
      actions: [
        { title: '梳理新品铺货政策与卖点', capability: 'content' },
        { title: '生成门店铺货推广内容', capability: 'content' },
        { title: '制定区域铺货节奏计划', capability: 'media' },
        { title: '梳理重点门店铺货名单', capability: 'content' },
      ],
      monitor: ['content_activity', 'media_volume'],
    },
  ],
};

/** 获取某主体的经营方向方案集（缺省回厂家）。 */
export function getDirections(type) {
  return DIRECTION_CATALOG[type] || DIRECTION_CATALOG.manufacturer;
}

/** 按 key 找方向。 */
export function getDirectionByKey(type, key) {
  return getDirections(type).find((d) => d.key === key) || null;
}

/**
 * 方向诊断库（按 DIRECTION_KEYS 复用，跨四主体）。
 * 用户 2026-09-10 定调「运营方案要指出现在的问题、怎么做优化、多久达标」。
 * 每个方向一份诊断：problems[]（当前问题清单）+ optimization[]（优化动作，与 problems 对应）。
 * targetCycleDays 复用模板 expectedPeriodDays（「多久达标」语义）。
 * 红线：problems 是「豆芽判断」不是「事实」，UI 需带「AI假设」语境；不编造数据。
 */
export const DIRECTION_DIAGNOSIS = {
  [DIRECTION_KEYS.LAUNCH]: {
    problems: [
      '新品外部认知不足，目标客群还没被有效触达',
      '缺少「让人看到 → 出内容 → 找到客户」的完整流程',
      '内容资产停留在基础阶段，缺少场景化卖点',
    ],
    optimization: [
      '围绕新品做一次「让人看到 → 出内容 → 找到客户」的专项',
      '完善新品卖点与核心场景内容',
      '制定媒体传播计划，把「让人看到」落到具体渠道',
    ],
  },
  [DIRECTION_KEYS.GEO]: {
    problems: [
      '核心采购场景覆盖不足，只在部分场景被 AI 搜索发现',
      '缺少稳定的场景化选型内容体系',
      '内容发得没节奏，口碑攒不下来',
    ],
    optimization: [
      '按采购场景逐条补齐选型内容',
      '梳理核心采购场景清单，优先补覆盖不足的场景',
      '制定内容分发节奏，持续累积核心场景可见性',
    ],
  },
  [DIRECTION_KEYS.BRAND]: {
    problems: [
      '行业内容发得断断续续，热度起伏大',
      '媒体与专家内容资产偏少，权威背书弱',
      '品牌口碑没攒成能反复用的内容',
    ],
    optimization: [
      '建立行业内容 + 媒体传播 + 专家观点体系',
      '制定行业选题体系，保持内容持续产出',
      '梳理行业媒体与专家资源，生成首批观点内容',
    ],
  },
  [DIRECTION_KEYS.GROWTH]: {
    problems: [
      '新客来源不稳定，缺少到店 / 接线索的固定流程',
      '获客内容不成体系，转化率低',
      '引流动作与私域承接脱节',
    ],
    optimization: [
      '建立同城内容 + 到店活动 + 私域承接的获客专项',
      '设计到店引流活动，把线索抓到手里',
      '制定私域承接话术，提升线索转化',
    ],
  },
  [DIRECTION_KEYS.CHANNEL]: {
    problems: [
      '商家 / 渠道规模增长慢',
      '招商政策传播不足，邀约转化低',
      '缺少标杆案例支撑，说服力弱',
    ],
    optimization: [
      '建立招商政策 + 邀约 + 城市沙龙体系',
      '生成商家招商邀约文案，放大政策传播',
      '策划城市招商沙龙，沉淀标杆案例',
    ],
  },
  [DIRECTION_KEYS.DOCTOR_IP]: {
    problems: [
      '医生个人品牌未建立，缺少差异化标签',
      '科普内容不持续，粉丝增长乏力',
      '专业信任感不足，转化依赖线下',
    ],
    optimization: [
      '建立医生人设 + 科普 + 粉丝增长内容体系',
      '制定 30 天科普选题表，保证内容持续',
      '生成首批医生 IP 内容，建立专业信任',
    ],
  },
  [DIRECTION_KEYS.PRIVATE]: {
    problems: [
      '存量患者价值未被充分挖掘',
      '复购召回缺失，老客流失',
      '口碑转介绍未做，增长全靠新客',
    ],
    optimization: [
      '建立私域运营 + 复购召回 + 口碑转介绍体系',
      '设计私域欢迎语与钩子，激活存量',
      '制定复购召回话术，提升老客价值',
    ],
  },
};

/** 取某方向的诊断（problems + optimization），无则空。 */
export function getDirectionDiagnosis(key) {
  return DIRECTION_DIAGNOSIS[key] || { problems: [], optimization: [] };
}

export default {
  DIRECTION_KEYS,
  DIRECTION_STATUS,
  DIRECTION_CATALOG,
  DIRECTION_DIAGNOSIS,
  getDirections,
  getDirectionByKey,
  getDirectionDiagnosis,
};
