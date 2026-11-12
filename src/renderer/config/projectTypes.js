/**
 * Project 类型配置（PROJECT_TYPES）。
 *
 * 四组身份各一套：厂家 8 类 / 门诊 9 类 / 经销商 6 类 / 平台 6 类。
 * ⚠️ 条目的 goalId 必须挂**本身份**的目标（dealer-* / platform-* 等），不得复用 factory-*：
 *    否则 projectTypes 的条目会身份串味（门禁 G1 / E7 守这条）。
 * 首页/建项目弹窗/项目详情都从这里取类型，避免散写。
 */

export const PROJECT_TYPES = {
  manufacturer: [
    { key: 'new_product', label: '新品推广', icon: '🚀', goalId: 'factory-new-product', desc: '新品上市传播与种草' },
    { key: 'zhaoshang', label: '招商获客', icon: '🤝', goalId: 'factory-zhaoshang', desc: '招商会 / 加盟线索' },
    { key: 'doctor_kol', label: '医生KOL', icon: '👨‍⚕️', goalId: 'factory-education', desc: '医生教育 / KOL 合作' },
    { key: 'brand', label: '品牌传播', icon: '📣', goalId: 'factory-brand', desc: '让更多人看到品牌' },
    { key: 'activity', label: '活动营销', icon: '🎯', goalId: 'factory-expo', desc: '展会 / 峰会 / 学术会' },
    { key: 'media', label: '媒体传播', icon: '📡', goalId: 'factory-brand', desc: '媒体投放与发稿' },
    { key: 'xinmeiti', label: '新媒体运营', icon: '✍️', goalId: 'factory-dealer', desc: '内容运营 / 渠道文案' },
    { key: 'education', label: '产品教育', icon: '🎓', goalId: 'factory-education', desc: '产品培训 / 科普教育' },
  ],
  clinic: [
    { key: 'patient_acquisition', label: '患者获客', icon: '👥', goalId: 'clinic-acquire', desc: '新客增长 / 到店线索' },
    { key: 'implant', label: '种植项目', icon: '🦷', goalId: 'clinic-project', desc: '种植项目精准种草' },
    { key: 'ortho', label: '正畸项目', icon: '🦷', goalId: 'clinic-project', desc: '正畸 / 儿牙项目' },
    { key: 'doctor_ip', label: '医生IP', icon: '👨‍⚕️', goalId: 'clinic-doctor-ip', desc: '医生专家人设' },
    { key: 'xinmeiti', label: '新媒体', icon: '✍️', goalId: 'clinic-visit', desc: '获客 / 到店内容' },
    { key: 'private_domain', label: '老客召回', icon: '❤️', goalId: 'clinic-private', desc: '老客内容与召回' },
    { key: 'activity', label: '活动营销', icon: '🎯', goalId: 'clinic-event', desc: '沙龙 / 义诊 / 活动' },
    { key: 'local', label: '同城营销', icon: '📍', goalId: 'clinic-acquire', desc: '本地到店转化' },
    { key: 'reputation', label: '口碑提升', icon: '📣', goalId: 'clinic-brand', desc: '口碑 / 舆情' },
  ],
  dealer: [
    { key: 'expand_store', label: '拓终端门店', icon: '🏬', goalId: 'dealer-expand', desc: '开发下游门店/诊所' },
    { key: 'distribute', label: '新品铺货', icon: '📦', goalId: 'dealer-distribute', desc: '新品区域铺货上架' },
    { key: 'sellthrough', label: '终端动销', icon: '📈', goalId: 'dealer-sellthrough', desc: '拉动终端走量与复购' },
    { key: 'orderfair', label: '订货会', icon: '🎪', goalId: 'dealer-orderfair', desc: '订货会/门店促销' },
    { key: 'channel', label: '渠道维护', icon: '🤝', goalId: 'dealer-channel', desc: '下级渠道与门店关系' },
    { key: 'brand', label: '区域口碑', icon: '📣', goalId: 'dealer-brand', desc: '区域品牌与门店口碑' },
  ],
  platform: [
    { key: 'onboard', label: '商家入驻', icon: '🏢', goalId: 'platform-onboard', desc: '拉诊所与厂家入驻' },
    { key: 'merchant_ops', label: '商家运营', icon: '🧩', goalId: 'platform-merchant-ops', desc: '商家激活与留存' },
    { key: 'event', label: '平台活动', icon: '🎯', goalId: 'platform-event', desc: '城市沙龙/行业峰会' },
    { key: 'case', label: '标杆案例', icon: '🏆', goalId: 'platform-case', desc: '标杆商家案例传播' },
    { key: 'brand', label: '平台品牌', icon: '🌐', goalId: 'platform-brand', desc: '平台品牌与信任' },
    { key: 'compliance', label: '平台合规', icon: '⚖️', goalId: 'platform-compliance', desc: '广告与入驻资质合规' },
  ],
};

/**
 * 默认项目模板（阶段五「项目工作台」：新建项目第一步显示的常用模板）。
 * 轻量区别：厂家 5 个 / 门诊 5 个，不做复杂类型目录。goalId 对齐 goalCatalog（GOAL_ROUTES）。
 */
export const DEFAULT_PROJECT_TEMPLATES = {
  manufacturer: [
    { key: 'new_product', label: '新品推广', icon: '🚀', goalId: 'factory-new-product', desc: '新品上市传播与种草' },
    { key: 'zhaoshang', label: '招商', icon: '🤝', goalId: 'factory-zhaoshang', desc: '招商会 / 经销商拓展' },
    { key: 'xinmeiti', label: '新媒体', icon: '✍️', goalId: 'factory-dealer', desc: '内容运营 / 渠道文案' },
    { key: 'activity', label: '活动', icon: '🎯', goalId: 'factory-expo', desc: '展会 / 峰会 / 学术会' },
    { key: 'brand', label: '品牌传播', icon: '📣', goalId: 'factory-brand', desc: '让更多人看到品牌' },
  ],
  clinic: [
    { key: 'implant', label: '种植获客', icon: '🦷', goalId: 'clinic-project', desc: '种植项目精准获客' },
    { key: 'ortho', label: '正畸获客', icon: '🦷', goalId: 'clinic-project', desc: '正畸 / 儿牙项目获客' },
    { key: 'xinmeiti', label: '新媒体', icon: '✍️', goalId: 'clinic-visit', desc: '获客 / 到店内容' },
    { key: 'activity', label: '活动', icon: '🎯', goalId: 'clinic-event', desc: '沙龙 / 义诊 / 活动' },
    { key: 'doctor_ip', label: '医生IP', icon: '👨‍⚕️', goalId: 'clinic-doctor-ip', desc: '医生专家人设' },
  ],
  dealer: [
    { key: 'expand_store', label: '拓终端门店', icon: '🏬', goalId: 'dealer-expand', desc: '开发下游门店/诊所' },
    { key: 'distribute', label: '新品铺货', icon: '📦', goalId: 'dealer-distribute', desc: '新品区域铺货上架' },
    { key: 'sellthrough', label: '终端动销', icon: '📈', goalId: 'dealer-sellthrough', desc: '拉动终端走量与复购' },
    { key: 'orderfair', label: '订货会', icon: '🎪', goalId: 'dealer-orderfair', desc: '订货会/门店促销' },
    { key: 'brand', label: '区域口碑', icon: '📣', goalId: 'dealer-brand', desc: '区域品牌与门店口碑' },
  ],
  platform: [
    { key: 'onboard', label: '商家入驻', icon: '🏢', goalId: 'platform-onboard', desc: '拉诊所与厂家入驻' },
    { key: 'merchant_ops', label: '商家运营', icon: '🧩', goalId: 'platform-merchant-ops', desc: '商家激活与留存' },
    { key: 'event', label: '平台活动', icon: '🎯', goalId: 'platform-event', desc: '城市沙龙/行业峰会' },
    { key: 'case', label: '标杆案例', icon: '🏆', goalId: 'platform-case', desc: '标杆商家案例传播' },
    { key: 'brand', label: '平台品牌', icon: '🌐', goalId: 'platform-brand', desc: '平台品牌与信任' },
  ],
};

/**
 * 身份归一：doctor 仍归门诊项目类型（个人医生不做招商）；dealer / platform **各自独立**（不再静默归厂家）。
 * ⚠️ 未知/空类型仍回落 `manufacturer` 是**刻意**的（与 normalizeCompanyType 同策略，历史行为不变）。
 * @param {string} companyType 企业类型 key
 * @returns {'manufacturer'|'clinic'|'dealer'|'platform'}
 */
function normProjectType(companyType) {
  if (companyType === 'clinic' || companyType === 'doctor') return 'clinic';
  if (companyType === 'dealer') return 'dealer';
  if (companyType === 'platform') return 'platform';
  return 'manufacturer';
}

/** 取某企业类型的默认项目模板（新建项目第一步，缺省回厂家）。 */
export function getDefaultProjectTemplates(companyType) {
  return DEFAULT_PROJECT_TEMPLATES[normProjectType(companyType)] || DEFAULT_PROJECT_TEMPLATES.manufacturer;
}

/** 取某企业类型的项目类型列表（缺省回厂家）。 */
export function getProjectTypes(companyType) {
  return PROJECT_TYPES[normProjectType(companyType)] || PROJECT_TYPES.manufacturer;
}

/** 按企业类型 + key 查单个项目类型（未命中返回 null）。 */
export function getProjectType(companyType, key) {
  return getProjectTypes(companyType).find((t) => t.key === key) || null;
}

/** 按 key 反查中文标签（跨厂家/门诊，供上下文等无 companyType 的场景使用）。 */
export function projectTypeLabel(key) {
  for (const list of Object.values(PROJECT_TYPES)) {
    const t = list.find((x) => x.key === key);
    if (t) return t.label;
  }
  return '';
}

export default PROJECT_TYPES;
