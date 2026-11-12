/**
 * 营销目标目录 + 目标→工作流映射表。
 *
 * 纯数据层，不依赖 React。五组角色（口腔诊所 / 口腔厂家 / 牙医个人 / 经销商 / 口腔平台）
 * 共 35 个目标（clinic 7 / factory 8 / dentist 6 / dealer 7 / platform 7）。
 * - GOAL_GROUPS：目标目录（供 GoalSelector 渲染）
 * - GOAL_ROUTES：目标 → 落地模块 + 步骤序列（module=null 表示 P0 缺口目标，前端渲染缺口提示）
 * - routeForGoal：查询 + 缺省兜底
 */

export const GOAL_GROUPS = [
  {
    id: 'clinic',
    icon: '🦷',
    label: '口腔诊所',
    goals: [
      { id: 'clinic-acquire', label: '获客', desc: '新客增长 / 到店线索' },
      { id: 'clinic-visit', label: '提升到店', desc: '线上内容带动到店转化' },
      { id: 'clinic-doctor-ip', label: '医生个人IP', desc: '打造医生专家人设' },
      { id: 'clinic-project', label: '种植·正畸·儿牙项目', desc: '重点项目的精准种草' },
      { id: 'clinic-event', label: '做活动', desc: '线下/线上活动方案' },
      { id: 'clinic-brand', label: '提升品牌口碑', desc: '品牌口碑与舆情监测' },
      { id: 'clinic-private', label: '做私域', desc: '私域内容与运营' },
    ],
  },
  {
    id: 'factory',
    icon: '🏭',
    label: '口腔厂家',
    goals: [
      { id: 'factory-dealer', label: '找经销商', desc: '招商线索' },
      { id: 'factory-clinic', label: '找牙科诊所', desc: '诊所线索' },
      { id: 'factory-new-product', label: '推广新品', desc: '新品上市传播' },
      { id: 'factory-zhaoshang', label: '招商', desc: '招商会/加盟' },
      { id: 'factory-brand', label: '让更多人知道', desc: '把品牌讲给更多潜在客户' },
      { id: 'factory-education', label: '医生教育', desc: '医生科普/教育内容' },
      { id: 'factory-expo', label: '展会·峰会', desc: '展会活动方案' },
      { id: 'factory-channel', label: '渠道维护', desc: '渠道关系维护' },
    ],
  },
  {
    id: 'dentist',
    icon: '👨‍⚕️',
    label: '牙医个人',
    goals: [
      { id: 'dentist-ip', label: '个人IP', desc: '医生个人品牌' },
      { id: 'dentist-fans', label: '涨粉', desc: '账号粉丝增长' },
      { id: 'dentist-science', label: '科普', desc: '口腔健康科普内容' },
      { id: 'dentist-trust', label: '建立专业信任', desc: '专业形象塑造' },
      { id: 'dentist-patient', label: '获取患者', desc: '患者线索获取' },
      { id: 'dentist-local', label: '同城营销', desc: '本地到店转化' },
    ],
  },
  {
    id: 'dealer',
    icon: '🚚',
    label: '经销商',
    goals: [
      { id: 'dealer-expand', label: '拓终端门店', desc: '开发下游门店/诊所' },
      { id: 'dealer-distribute', label: '新品铺货', desc: '新品区域铺货上架' },
      { id: 'dealer-sellthrough', label: '终端动销', desc: '拉动终端走量与复购' },
      { id: 'dealer-orderfair', label: '订货会', desc: '订货会/门店促销' },
      { id: 'dealer-channel', label: '渠道维护', desc: '下级渠道与门店关系' },
      { id: 'dealer-inventory', label: '库存周转', desc: '库存与回款周转' },
      { id: 'dealer-brand', label: '区域口碑', desc: '区域品牌与门店口碑' },
    ],
  },
  {
    id: 'platform',
    icon: '🌐',
    label: '口腔平台',
    goals: [
      { id: 'platform-onboard', label: '商家入驻', desc: '拉诊所与厂家入驻' },
      { id: 'platform-match', label: '供需撮合', desc: '撮合厂家货源与诊所采购' },
      { id: 'platform-merchant-ops', label: '商家运营', desc: '商家激活与留存' },
      { id: 'platform-event', label: '平台活动', desc: '城市沙龙/行业峰会' },
      { id: 'platform-case', label: '标杆案例', desc: '标杆商家案例传播' },
      { id: 'platform-brand', label: '平台品牌', desc: '平台品牌与信任' },
      { id: 'platform-compliance', label: '平台合规', desc: '广告与入驻资质合规' },
    ],
  },
];

/**
 * 目标 → 工作流：module 为落地模块，steps 为可视化步骤序列（可跳转）。
 * 覆盖全部 35 个目标，其中 3 个为 `module:null` 的真实缺口目标
 * （dealer-inventory / platform-match / platform-compliance）—— 现有落地模块
 * （asset / intel / xinmeiti / media / huodong / crisis）全是内容/媒体/活动/舆情类，
 * 没有数据/交易/规则校验能力，故如实标缺口，不硬塞假内容。
 */
export const GOAL_ROUTES = {
  // —— 口腔诊所 ——
  'clinic-acquire': {
    module: 'intel',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'geo', title: 'AI 搜索内容策略', module: 'intel', hint: '生成品牌营销策略' },
      { key: 'write', title: '生成文案', module: 'xinmeiti', hint: '按策略产出获客文案' },
      { key: 'publish', title: '媒体发文', module: 'media', hint: '按画像推荐媒体' },
    ],
  },
  'clinic-visit': {
    module: 'intel',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'geo', title: 'AI 搜索到店策略', module: 'intel', hint: '线上内容带动到店转化' },
      { key: 'write', title: '生成到店文案', module: 'xinmeiti', hint: '产出转化型文案' },
    ],
  },
  'clinic-doctor-ip': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '医生人设内容', module: 'xinmeiti', hint: '打造专家人设' },
    ],
  },
  'clinic-project': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '项目种草文案', module: 'xinmeiti', hint: '种植·正畸·儿牙精准种草' },
      { key: 'publish', title: '媒体发文', module: 'media' },
    ],
  },
  'clinic-event': {
    module: 'huodong',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'event', title: '策划活动方案', module: 'huodong' },
    ],
  },
  'clinic-brand': {
    module: 'media',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'publish', title: '媒体发文', module: 'media' },
      { key: 'crisis', title: '舆情监测', module: 'crisis' },
    ],
  },
  'clinic-private': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '私域内容', module: 'xinmeiti', hint: '私域内容与运营' },
    ],
  },

  // —— 口腔厂家 ——
  'factory-new-product': {
    module: 'media',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'publish', title: '媒体发文', module: 'media' },
    ],
  },
  'factory-brand': {
    module: 'media',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'publish', title: '媒体发文', module: 'media' },
    ],
  },
  'factory-education': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '医生教育内容', module: 'xinmeiti' },
    ],
  },
  'factory-expo': {
    module: 'huodong',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'event', title: '展会活动方案', module: 'huodong' },
    ],
  },

  // —— 厂家招商/渠道类目标：映射到已可用的内容/活动/媒体能力 ——
  'factory-dealer': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'write', title: '生成招商内容', module: 'xinmeiti', hint: '产出经销商招商卖点文案' },
      { key: 'publish', title: '媒体发文', module: 'media', hint: '按画像推荐招商渠道' },
    ],
  },
  'factory-clinic': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '生成诊所触达内容', module: 'xinmeiti', hint: '产出面向牙科诊所的合作文案' },
      { key: 'publish', title: '媒体发文', module: 'media' },
    ],
  },
  'factory-zhaoshang': {
    module: 'huodong',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'event', title: '策划招商活动方案', module: 'huodong', hint: '招商会/加盟说明会活动策划' },
    ],
  },
  'factory-channel': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '渠道维护内容', module: 'xinmeiti', hint: '产出渠道关系维护内容' },
    ],
  },

  // —— 牙医个人 ——
  'dentist-ip': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '个人 IP 内容', module: 'xinmeiti' },
    ],
  },
  'dentist-fans': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '涨粉内容', module: 'xinmeiti' },
    ],
  },
  'dentist-science': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '科普内容', module: 'xinmeiti' },
    ],
  },
  'dentist-trust': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'write', title: '专业信任内容', module: 'xinmeiti' },
    ],
  },
  'dentist-patient': {
    module: 'intel',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'geo', title: 'AI 搜索获客策略', module: 'intel' },
    ],
  },
  'dentist-local': {
    module: 'intel',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset' },
      { key: 'geo', title: '同城营销策略', module: 'intel' },
    ],
  },

  // —— 经销商（dealer）——
  'dealer-expand': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'write', title: '生成门店开发话术', module: 'xinmeiti', hint: '面向终端门店/诊所的合作文案' },
      { key: 'publish', title: '媒体发文', module: 'media', hint: '按区域触达目标门店' },
    ],
  },
  'dealer-distribute': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'write', title: '铺货推广内容', module: 'xinmeiti', hint: '门店铺货与终端陈列推广' },
      { key: 'publish', title: '媒体发文', module: 'media' },
    ],
  },
  'dealer-sellthrough': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'write', title: '动销促销内容', module: 'xinmeiti', hint: '终端促销与复购内容' },
      { key: 'publish', title: '媒体发文', module: 'media' },
    ],
  },
  'dealer-orderfair': {
    module: 'huodong',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'event', title: '策划订货会方案', module: 'huodong', hint: '订货会/门店促销活动' },
    ],
  },
  'dealer-channel': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'write', title: '渠道维护内容', module: 'xinmeiti', hint: '下级渠道与门店回访' },
    ],
  },
  // dealer-inventory：刻意缺口（库存/回款需进销存/财务数据，工作台暂无对应模块）
  'dealer-inventory': {
    module: null,
    steps: [],
    gap: '库存周转与回款依赖进销存/财务数据，当前工作台暂无对应模块。',
  },
  'dealer-brand': {
    module: 'media',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'publish', title: '媒体发文', module: 'media' },
      { key: 'crisis', title: '舆情监测', module: 'crisis' },
    ],
  },

  // —— 口腔平台（platform）——
  'platform-onboard': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'write', title: '生成入驻邀约内容', module: 'xinmeiti', hint: '面向诊所与厂家的双边入驻文案' },
      { key: 'publish', title: '媒体发文', module: 'media' },
    ],
  },
  // platform-match：刻意缺口（撮合需需求池/报价匹配能力）
  'platform-match': {
    module: null,
    steps: [],
    gap: '供需撮合需要需求池/报价匹配能力，当前工作台暂无对应模块（可用「供需对接会」走活动模块做 MVP）。',
  },
  'platform-merchant-ops': {
    module: 'xinmeiti',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'write', title: '商家运营内容', module: 'xinmeiti', hint: '商家激活/留存运营内容' },
    ],
  },
  'platform-event': {
    module: 'huodong',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'event', title: '策划平台活动方案', module: 'huodong', hint: '城市沙龙/行业峰会' },
    ],
  },
  'platform-case': {
    module: 'media',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'publish', title: '媒体发文', module: 'media', hint: '标杆商家案例报道' },
    ],
  },
  'platform-brand': {
    module: 'media',
    steps: [
      { key: 'asset', title: '完善企业资产', module: 'asset', hint: '先建档，下游自动带出' },
      { key: 'publish', title: '媒体发文', module: 'media' },
      { key: 'crisis', title: '舆情监测', module: 'crisis' },
    ],
  },
  // platform-compliance：刻意缺口（合规校验需资质库/规则校验能力）
  'platform-compliance': {
    module: null,
    steps: [],
    gap: '医疗广告与入驻资质合规校验需要资质库/规则校验能力，当前工作台暂无对应模块。',
  },
};

/**
 * 查询目标对应的工作流；未命中时返回安全的空 route，避免下游死链。
 * @param {string} goalId 目标 id
 * @returns {{module: string|null, steps: Array, gap?: string}}
 */
export function routeForGoal(goalId) {
  return GOAL_ROUTES[goalId] || { module: null, steps: [], gap: '该目标暂未配置工作流。' };
}
