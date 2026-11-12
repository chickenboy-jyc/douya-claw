/**
 * dailyOpsCatalog —— 第六阶段「日常运营工作台」的静态配置层。
 *
 * 只放「厂家 / 门诊」两套差异化的枚举与模板，不做任何 AI 逻辑。
 * 通过 companyType（'manufacturer' | 'clinic'）取对应配置，让同一个「朋友圈生成」
 * 在厂家手里出「产品/招商/展会」，在门诊手里出「种植/正畸/到店」——内容逻辑完全不同。
 *
 * 合规提醒贯穿始终：口腔/医疗内容不编造病例、疗效、数据、用户评价。
 */

// ==================== 朋友圈类型 ====================
// 门诊（clinic）与厂家（manufacturer）各有独立类型集合。
export const MOMENTS_TYPES = {
  clinic: [
    { key: 'daily', label: '日常经营', hint: '门诊日常营业 / 服务展示' },
    { key: 'doctor', label: '医生专业', hint: '医生专业形象 / 科普' },
    { key: 'project', label: '项目推广', hint: '种植 / 正畸等项目推广' },
    { key: 'activity_preheat', label: '活动预热', hint: '活动预告 / 造势' },
    { key: 'case', label: '客户案例', hint: '真实案例（需脱敏合规）' },
    { key: 'festival', label: '节日', hint: '节日借势' },
    { key: 'brand', label: '企业动态', hint: '门诊动态 / 里程碑' },
    { key: 'industry', label: '行业内容', hint: '行业资讯 / 科普' },
    { key: 'implant', label: '种植', hint: '种植专题' },
    { key: 'ortho', label: '正畸', hint: '正畸专题' },
    { key: 'pediatric', label: '儿牙', hint: '儿童口腔专题' },
    { key: 'visit', label: '到店', hint: '到店提醒 / 预约' },
    { key: 'patient_service', label: '患者服务', hint: '患者关怀 / 服务' },
    { key: 'event', label: '活动', hint: '门店活动' },
  ],
  manufacturer: [
    { key: 'product', label: '产品', hint: '产品卖点 / 上新' },
    { key: 'doctor_kol', label: '医生/KOL', hint: '医生 / KOL 合作内容' },
    { key: 'recruit', label: '招商', hint: '招商加盟 / 代理' },
    { key: 'exhibition', label: '展会', hint: '展会预热 / 参展' },
    { key: 'academic', label: '学术', hint: '学术会议 / 文献' },
    { key: 'brand', label: '企业动态', hint: '企业动态 / 里程碑' },
    { key: 'industry', label: '行业内容', hint: '行业资讯' },
  ],
};

// ==================== 社群类型 ====================
export const COMMUNITY_TYPES = {
  clinic: [
    { key: 'implant_group', label: '种植患者群', audience: '种植意向 / 术后患者', positioning: '种植科普 + 术后关怀 + 复购引导' },
    { key: 'ortho_group', label: '正畸咨询群', audience: '正畸意向 / 复诊患者', positioning: '正畸科普 + 复诊提醒 + 案例分享' },
    { key: 'old_customer', label: '老客群', audience: '老客户', positioning: '老客维护 + 转介绍 + 复购' },
    { key: 'activity_group', label: '活动群', audience: '活动报名用户', positioning: '活动预热 + 报名 + 到店转化' },
    { key: 'doctor_group', label: '医生交流群', audience: '院内医生', positioning: '案例讨论 + 排班通知 + 培训' },
    { key: 'patient_service', label: '患者服务群', audience: '在诊患者', positioning: '预约提醒 + 就诊指引 + 满意度' },
  ],
  manufacturer: [
    { key: 'dealer_group', label: '经销商群', audience: '经销商 / 代理', positioning: '政策传达 + 订货 + 招商' },
    { key: 'doctor_group', label: '医生交流群', audience: '合作医生', positioning: '产品培训 + 学术 + 案例' },
    { key: 'training_group', label: '产品培训群', audience: '客户团队', positioning: '产品使用培训 + 答疑' },
    { key: 'recruit_group', label: '招商群', audience: '意向加盟商', positioning: '招商宣讲 + 政策 + 跟进' },
    { key: 'industry_group', label: '行业交流群', audience: '行业从业者', positioning: '行业资讯 + 资源对接' },
  ],
};

// ==================== 发布渠道 ====================
export const CHANNELS = [
  { key: 'moments', label: '朋友圈', icon: '📱' },
  { key: 'community', label: '社群', icon: '💬' },
  { key: 'social_post', label: '小红书', icon: '📕' },
  { key: 'video', label: '视频号', icon: '🎬' },
  { key: 'article', label: '公众号', icon: '📰' },
];

export function channelLabel(key) {
  const c = CHANNELS.find((x) => x.key === key);
  return c ? c.label : key;
}

// ==================== 每日周期模板 ====================
// 仅作「参考节奏」，不代表固定最佳时间（真实时间应据门店/行业自行判断）。
export const DAILY_TEMPLATES = {
  clinic: [
    { slot: '上午', type: 'moments', label: '朋友圈', hint: '医生坐诊 / 门诊日常' },
    { slot: '中午', type: 'community', label: '社群', hint: '科普互动 / 答疑' },
    { slot: '下午', type: 'social_post', label: '小红书', hint: '种草 / 科普' },
    { slot: '晚上', type: 'moments', label: '朋友圈', hint: '案例 / 答疑' },
  ],
  manufacturer: [
    { slot: '上午', type: 'moments', label: '朋友圈', hint: '企业动态' },
    { slot: '下午', type: 'moments', label: '朋友圈', hint: '产品内容' },
    { slot: '晚上', type: 'community', label: '社群', hint: '行业内容 / 招商' },
  ],
};

// ==================== 内容排版平台 ====================
export const LAYOUT_PLATFORMS = [
  { key: 'wechat', label: '微信公众号' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'shipinhao', label: '视频号' },
  { key: 'douyin', label: '抖音' },
  { key: 'moments', label: '朋友圈' },
];

// ==================== 取用函数 ====================
// 四主体归一：clinic 与 doctor（个人医生）走门诊向内容；manufacturer 与 platform 走企业向内容。
// 避免给医生推招商、给平台推患者获客（对齐 Activity Engine 四主体红线）。
function normType(t) {
  if (t === 'clinic' || t === 'doctor') return 'clinic';
  return 'manufacturer';
}

export function momentsTypesFor(companyType) {
  return MOMENTS_TYPES[normType(companyType)] || MOMENTS_TYPES.manufacturer;
}

export function communityTypesFor(companyType) {
  return COMMUNITY_TYPES[normType(companyType)] || COMMUNITY_TYPES.manufacturer;
}

export function dailyTemplateFor(companyType) {
  return DAILY_TEMPLATES[normType(companyType)] || DAILY_TEMPLATES.manufacturer;
}

/**
 * 企业类型中文标签。未知/旧值回落为「口腔厂家」，保持历史行为。
 * ⚠️ 本文件是**零依赖 data 层**（文件头约定不做 AI 逻辑），故不 import config，而是**显式分支**，
 *    与 **SSOT `config/companyTypeConfig.js` 的 doctor/platform `label`（口腔医生 / 口腔平台）逐字对齐**；
 *    全仓类型中文名的唯一真源 = config 的 label 两行，本文件只是同步副本（data 层惯例，不 import config）。
 *    消费方：`DailyOps.jsx`（页头 · 用户可见）+ `services/dailyOps.js`（🔴 **喂给模型的 prompt 字符串**）。
 * @param {string} companyType 企业类型 key
 * @returns {string}
 */
export function companyTypeLabel(companyType) {
  switch (companyType) {
    case 'clinic': return '口腔门诊';
    case 'doctor': return '口腔医生';
    case 'dealer': return '经销商';
    case 'platform': return '口腔平台';
    default: return '口腔厂家';
  }
}

// 合规约束统一文案（注入每个生成 Prompt）
export const COMPLIANCE_RULE = [
  '口腔/医疗内容必须合规：不编造病例、不编造用户评价、不编造医疗数据、不虚构治疗效果、不使用未经证实的绝对化表述。',
  '如资料不足，明确提示「资料不足」，不得为了营销感而自动制造病例故事或虚构案例。',
  '推荐发布时间仅为「建议」，不得虚构平台官方数据来证明某个时间一定最好。',
].join('');

export default {
  MOMENTS_TYPES,
  COMMUNITY_TYPES,
  CHANNELS,
  DAILY_TEMPLATES,
  LAYOUT_PLATFORMS,
  momentsTypesFor,
  communityTypesFor,
  dailyTemplateFor,
  companyTypeLabel,
  channelLabel,
  COMPLIANCE_RULE,
};
