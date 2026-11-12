/**
 * Activity 目标定义（Goal）—— Activity Engine 四层模型的第 2 层。
 *
 * 唯一事实源：docs/ACTIVITY-DIRECTOR-DESIGN.md §2（目标模型）、§8（KPI_DICT）。
 *
 * 设计要点：
 * 1. **按 subject 分桶**：ACTIVITY_GOALS 是四层结构，UI 只渲染 ACTIVITY_GOALS[subjectType]，
 *    物理上不存在「给厂家渲染门诊目标」的代码路径（§2.5 跨主体禁止）。
 * 2. `patient_acquisition` 在 clinic（到店线索）与 doctor（可跟进咨询）下含义不同；
 *    `brand` 在 clinic（本地口碑）与厂家语境下不同 —— 这正是必须分桶的原因。
 * 3. `pitfall` 把「AI 常犯的错」前置成硬约束注入 Prompt，而不是事后修。
 *
 * 本文件为纯常量 + 纯函数：不 import 任何框架、不读写 localStorage、不发网络请求。
 */

import { ACTIVITY_SUBJECTS, DEFAULT_SUBJECT, CUSTOM_GOAL_KEY } from './activitySubjects.js';

/**
 * ActivityGoal
 * @typedef {Object} ActivityGoal
 * @property {string} key            // product_launch
 * @property {string} label          // 新品推广
 * @property {'manufacturer'|'clinic'|'doctor'|'platform'} subject
 * @property {string} desc           // 一句话解释这个目标在解决什么问题
 * @property {string[]} templates    // 默认推荐场景（ActivityTemplate.key）
 * @property {string} primaryKpi     // 主 KPI（KPI_DICT 的 key）
 * @property {'offline'|'online'|'hybrid'} defaultForm
 * @property {string} pitfall        // 常见误区（注入 Prompt 的负面约束）
 */

/**
 * 四主体的活动目标，按 subject 分桶（§2.2 ~ §2.5，共 27 个）。
 * key 顺序即 UI 展示顺序。
 * @type {Object<string, Object<string, ActivityGoal>>}
 */
export const ACTIVITY_GOALS = {
  // ── 口腔厂家（7 个，§2.2）───────────────────────────────────────────────
  manufacturer: {
    product_launch: {
      key: 'product_launch',
      label: '新品推广',
      subject: 'manufacturer',
      desc: '让目标医生理解并愿意试用新品',
      templates: ['new_product_launch', 'doctor_salon', 'exhibition'],
      primaryKpi: 'productInquiry',
      defaultForm: 'offline',
      pitfall: '不得写成纯品牌发布会，必须有产品理解→试用→商机路径',
    },
    doctor_education: {
      key: 'doctor_education',
      label: '医生教育',
      subject: 'manufacturer',
      desc: '通过学术内容建立专业信任',
      templates: ['doctor_salon', 'product_training', 'academic_conference'],
      primaryKpi: 'effectiveCustomer',
      defaultForm: 'offline',
      pitfall: '不得把「到场人数」当主 KPI；教育目标看有效客户',
    },
    channel_recruitment: {
      key: 'channel_recruitment',
      label: '渠道招商',
      subject: 'manufacturer',
      desc: '获取经销商 / 渠道线索',
      templates: ['distributor_meeting', 'new_product_launch'],
      primaryKpi: 'channelLead',
      defaultForm: 'offline',
      pitfall: '不得出现患者获客指标；招商看线索与商机',
    },
    kol_relationship: {
      key: 'kol_relationship',
      label: 'KOL 关系',
      subject: 'manufacturer',
      desc: '维护头部专家关系',
      templates: ['kol_closed_meeting', 'doctor_salon'],
      primaryKpi: 'effectiveCustomer',
      defaultForm: 'offline',
      pitfall: '小规模闭门，不得按大型会议规模设计',
    },
    brand_awareness: {
      key: 'brand_awareness',
      label: '品牌传播',
      subject: 'manufacturer',
      desc: '扩大行业声量',
      templates: ['exhibition', 'academic_conference', 'new_product_launch'],
      primaryKpi: 'exposure',
      defaultForm: 'hybrid',
      pitfall: '曝光≠效果，必须给出声量→有效客户的中间指标',
    },
    academic: {
      key: 'academic',
      label: '学术',
      subject: 'manufacturer',
      desc: '学术影响力建设',
      templates: ['academic_conference', 'doctor_salon'],
      primaryKpi: 'attend',
      defaultForm: 'offline',
      pitfall: '不得混入招商话术主导流程',
    },
    exhibition: {
      key: 'exhibition',
      label: '展会获客',
      subject: 'manufacturer',
      desc: '展会现场高效获客',
      templates: ['exhibition'],
      primaryKpi: 'effectiveCustomer',
      defaultForm: 'offline',
      pitfall: '展会的瓶颈是「留资质量」不是「人流」',
    },
  },

  // ── 口腔门诊 / 医院（8 个，§2.3）────────────────────────────────────────
  clinic: {
    patient_acquisition: {
      key: 'patient_acquisition',
      label: '患者获客',
      subject: 'clinic',
      desc: '拿到可跟进的患者线索',
      templates: ['implant_day', 'community_event', 'oral_health_lecture'],
      primaryKpi: 'leads',
      defaultForm: 'offline',
      pitfall: '不得用「曝光量」冒充获客成果',
    },
    project_marketing: {
      key: 'project_marketing',
      label: '项目转化',
      subject: 'clinic',
      desc: '种植 / 正畸 / 儿牙等重点项目成交',
      templates: ['implant_day', 'orthodontic_day', 'pediatric_event'],
      primaryKpi: 'deal',
      defaultForm: 'offline',
      pitfall: '不得只写活动流程，必须写清到店→方案→成交的承接',
    },
    new_customer: {
      key: 'new_customer',
      label: '新客',
      subject: 'clinic',
      desc: '首次到店',
      templates: ['community_event', 'opening_event', 'oral_health_lecture'],
      primaryKpi: 'visit',
      defaultForm: 'offline',
      pitfall: '新客看首次到店，不得与老客复购混算',
    },
    repeat_customer: {
      key: 'repeat_customer',
      label: '老客维护',
      subject: 'clinic',
      desc: '提升老客复购与黏性',
      templates: ['patient_salon', 'referral_event'],
      primaryKpi: 'visit',
      defaultForm: 'offline',
      pitfall: '老客活动不得按陌生人获客的招募逻辑设计',
    },
    referral: {
      key: 'referral',
      label: '转介绍',
      subject: 'clinic',
      desc: '老带新',
      templates: ['referral_event', 'patient_salon'],
      primaryKpi: 'referralCount',
      defaultForm: 'offline',
      pitfall: '转介绍必须有明确的激励机制与追踪口径',
    },
    community: {
      key: 'community',
      label: '社区获客',
      subject: 'clinic',
      desc: '周边 3-5 公里渗透',
      templates: ['community_event', 'oral_health_lecture'],
      primaryKpi: 'leads',
      defaultForm: 'offline',
      pitfall: '社区场景不得设计高门槛 / 高客单项目',
    },
    brand: {
      key: 'brand',
      label: '品牌',
      subject: 'clinic',
      desc: '本地口碑',
      templates: ['community_event', 'oral_health_lecture', 'opening_event'],
      primaryKpi: 'exposure',
      defaultForm: 'hybrid',
      pitfall: '门诊品牌 ≠ 行业品牌，不得套厂家学术会议模型',
    },
    doctor_ip: {
      key: 'doctor_ip',
      label: '医生 IP',
      subject: 'clinic',
      desc: '打造院内专家人设',
      templates: ['oral_health_lecture', 'patient_salon'],
      primaryKpi: 'consult',
      defaultForm: 'hybrid',
      pitfall: '医生 IP 活动不得脱离门诊承接能力单做流量',
    },
  },

  // ── 口腔医生（6 个，§2.4）───────────────────────────────────────────────
  doctor: {
    personal_brand: {
      key: 'personal_brand',
      label: '个人品牌',
      subject: 'doctor',
      desc: '建立可被记住的医生人设',
      templates: ['professional_live', 'educational_event', 'case_sharing'],
      primaryKpi: 'newFollowers',
      defaultForm: 'online',
      pitfall: '不得按机构活动规模设计；医生一人执行',
    },
    patient_education: {
      key: 'patient_education',
      label: '患者教育',
      subject: 'doctor',
      desc: '用科普建立信任',
      templates: ['patient_qa', 'educational_event', 'professional_live'],
      primaryKpi: 'interactions',
      defaultForm: 'online',
      pitfall: '不得承诺疗效、不得出现绝对化医疗表述',
    },
    patient_acquisition: {
      key: 'patient_acquisition',
      label: '获客',
      subject: 'doctor',
      desc: '获得可跟进的患者咨询',
      templates: ['patient_qa', 'doctor_personal_salon'],
      primaryKpi: 'consults',
      defaultForm: 'online',
      pitfall: '不得声称「带来多少到店」——除非有挂靠机构承接',
    },
    live_stream: {
      key: 'live_stream',
      label: '直播',
      subject: 'doctor',
      desc: '直播场次运营',
      templates: ['professional_live', 'patient_qa'],
      primaryKpi: 'views',
      defaultForm: 'online',
      pitfall: '直播不得只有讲，必须有互动与留资机制',
    },
    professional_influence: {
      key: 'professional_influence',
      label: '专业影响力',
      subject: 'doctor',
      desc: '同行认可',
      templates: ['case_sharing', 'professional_live', 'peer_exchange'],
      primaryKpi: 'spread',
      defaultForm: 'hybrid',
      pitfall: '专业影响力看同行传播，不是看泛流量',
    },
    peer_exchange: {
      key: 'peer_exchange',
      label: '同行交流',
      subject: 'doctor',
      desc: '同行社群与病例讨论',
      templates: ['peer_exchange', 'case_sharing'],
      primaryKpi: 'interactions',
      defaultForm: 'offline',
      pitfall: '不得混入患者招募逻辑',
    },
  },

  // ── 口腔平台（6 个，§2.5）─────────────────────────────────────────────
  platform: {
    merchant_acquisition: {
      key: 'merchant_acquisition',
      label: '商家招商',
      subject: 'platform',
      desc: '获取商家（门诊 / 经销商）线索',
      templates: ['merchant_salon', 'platform_launch', 'city_event'],
      primaryKpi: 'merchantSignup',
      defaultForm: 'offline',
      pitfall: '不得使用患者获客模型；对象是商家不是 C 端',
    },
    merchant_growth: {
      key: 'merchant_growth',
      label: '商家增长',
      subject: 'platform',
      desc: '提升已入驻商家的使用深度',
      templates: ['merchant_training', 'merchant_salon'],
      primaryKpi: 'usage',
      defaultForm: 'offline',
      pitfall: '增长看使用与活跃，不是看报名人数',
    },
    platform_training: {
      key: 'platform_training',
      label: '平台培训',
      subject: 'platform',
      desc: '教会商家用起来',
      templates: ['merchant_training'],
      primaryKpi: 'usage',
      defaultForm: 'offline',
      pitfall: '培训必须设计「训后 7 天使用」，否则等于没做',
    },
    user_growth: {
      key: 'user_growth',
      label: '用户增长',
      subject: 'platform',
      desc: '平台侧 C 端用户增长',
      templates: ['city_event', 'platform_launch'],
      primaryKpi: 'exposure',
      defaultForm: 'hybrid',
      pitfall: '只有当平台确实面向 C 端时才允许；需二次确认',
    },
    industry_brand: {
      key: 'industry_brand',
      label: '行业品牌',
      subject: 'platform',
      desc: '行业影响力',
      templates: ['industry_forum', 'platform_launch'],
      primaryKpi: 'attend',
      defaultForm: 'offline',
      pitfall: '不得用招商话术主导峰会内容',
    },
    partner_relationship: {
      key: 'partner_relationship',
      label: '伙伴关系',
      subject: 'platform',
      desc: '合作伙伴维护',
      templates: ['partner_event', 'industry_forum'],
      primaryKpi: 'convert',
      defaultForm: 'offline',
      pitfall: '关系型活动不得用纯漏斗指标衡量',
    },
  },
};

/**
 * 目标数组快照（按 subject 分桶，供 UI 直接 map）。
 * @type {Object<string, ActivityGoal[]>}
 */
export const ACTIVITY_GOAL_LIST = {
  manufacturer: Object.values(ACTIVITY_GOALS.manufacturer),
  clinic: Object.values(ACTIVITY_GOALS.clinic),
  doctor: Object.values(ACTIVITY_GOALS.doctor),
  platform: Object.values(ACTIVITY_GOALS.platform),
};

/**
 * 每个主体的默认选中目标（Step 2 初始选中项）。
 * @type {Object<string, string>}
 */
export const SUBJECT_DEFAULT_GOAL = {
  manufacturer: 'product_launch',
  clinic: 'patient_acquisition',
  doctor: 'personal_brand',
  platform: 'merchant_acquisition',
};

/**
 * 每个主体的兜底主 KPI（用于自定义目标等拿不到 primaryKpi 的场景）。
 * 取值均为 §8 KPI_DICT 中该主体的核心漏斗指标。
 * @type {Object<string, string>}
 */
export const SUBJECT_FALLBACK_KPI = {
  manufacturer: 'effectiveCustomer',
  clinic: 'leads',
  doctor: 'interactions',
  platform: 'merchantSignup',
};

/**
 * 取某个主体的全部活动目标（分桶读取，跨主体不可见）。
 * @param {string} subject 主体 key
 * @returns {ActivityGoal[]} 目标数组；未知主体返回空数组
 */
export function getGoals(subject) {
  return ACTIVITY_GOAL_LIST[subject] || [];
}

/**
 * 取某个主体的目标 key 列表。
 * @param {string} subject 主体 key
 * @returns {string[]} key 数组；未知主体返回空数组
 */
export function getGoalKeys(subject) {
  return getGoals(subject).map((g) => g.key);
}

/**
 * 按 subject + key 精确取目标（严格分桶，厂家取不到门诊目标）。
 * @param {string} subject 主体 key
 * @param {string} key 目标 key
 * @returns {ActivityGoal|null} 目标对象；不存在或跨主体时返回 null
 */
export function getGoal(subject, key) {
  const bucket = ACTIVITY_GOALS[subject];
  if (!bucket) return null;
  const goal = bucket[String(key || '')];
  return goal || null;
}

/**
 * 判断某目标是否属于某主体（用于落库前校验，防止 key 跨主体漂移）。
 * @param {string} subject 主体 key
 * @param {string} key 目标 key
 * @returns {boolean} 是否合法
 */
export function hasGoal(subject, key) {
  return getGoal(subject, key) !== null;
}

/**
 * 取目标的负面约束文本（pitfall），未知时返回空字符串。
 * @param {string} subject 主体 key
 * @param {string} key 目标 key
 * @returns {string} pitfall 文本
 */
export function getGoalPitfall(subject, key) {
  const goal = getGoal(subject, key);
  return goal ? goal.pitfall : '';
}

/**
 * 构造自定义目标对象（§1.3：自定义目标走 goalKey='custom'，文本落 goalCustomText）。
 *
 * @param {string} subject 主体 key
 * @param {string} text 用户填写的自定义目标文本
 * @returns {ActivityGoal|null} 目标对象；未知主体或空文本返回 null
 */
export function buildCustomGoal(subject, text) {
  const meta = ACTIVITY_SUBJECTS[subject];
  const content = String(text || '').trim();
  if (!meta || !content) return null;
  return {
    key: CUSTOM_GOAL_KEY,
    label: '自定义目标',
    subject: meta.key,
    desc: content,
    templates: [],
    primaryKpi: SUBJECT_FALLBACK_KPI[meta.key] || SUBJECT_FALLBACK_KPI[DEFAULT_SUBJECT],
    defaultForm: 'offline',
    pitfall: `本次目标为用户自定义的「${content}」，必须围绕该目标本身设计活动与指标，` +
      '同时无条件遵守当前活动主体的负面约束清单',
  };
}

/**
 * 目标数量自检（对齐设计文档：厂家 7 / 门诊 8 / 医生 6 / 平台 6，共 27 个）。
 * @type {Object<string, number>}
 */
export const GOAL_COUNT_BY_SUBJECT = {
  manufacturer: getGoalKeys('manufacturer').length,
  clinic: getGoalKeys('clinic').length,
  doctor: getGoalKeys('doctor').length,
  platform: getGoalKeys('platform').length,
};
