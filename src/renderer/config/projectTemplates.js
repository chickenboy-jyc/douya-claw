/**
 * PROJECT_TEMPLATES —— 项目模板（P1-2）。
 *
 * 只初始化「结构 + 推荐 Task」，不执行 AI（主理人决策：模板不跑 AI）。
 * 推荐 Task 用 taskType（capability 由 capabilityResolver.resolveCapability 派生）。
 * 未显式提供的类型 getProjectTemplate 返回空 tasks 的兜底结构。
 */

export const PROJECT_TEMPLATES = {
  new_product: {
    key: 'new_product',
    label: '新品推广',
    goalId: 'factory-new-product',
    description: '围绕新品上市做传播与种草',
    tasks: [
      { title: '完善产品卖点', taskType: 'product', priority: 'high' },
      { title: '制定 7 天内容计划', taskType: 'content', priority: 'medium' },
      { title: '制定媒体传播计划', taskType: 'media', priority: 'medium' },
    ],
  },
  zhaoshang: {
    key: 'zhaoshang',
    label: '招商获客',
    goalId: 'factory-zhaoshang',
    description: '招商会 / 加盟线索获取',
    tasks: [
      { title: '梳理招商政策与卖点', taskType: 'product', priority: 'high' },
      { title: '生成招商邀约话术', taskType: 'content', priority: 'medium' },
      { title: '策划线下招商会', taskType: 'activity', priority: 'medium' },
    ],
  },
  doctor_kol: {
    key: 'doctor_kol',
    label: '医生KOL',
    goalId: 'factory-education',
    description: '医生教育 / KOL 合作',
    tasks: [
      { title: '梳理医生教育选题', taskType: 'kol', priority: 'high' },
      { title: '制定医生科普内容计划', taskType: 'content', priority: 'medium' },
    ],
  },
  brand: {
    key: 'brand',
    label: '品牌传播',
    goalId: 'factory-brand',
    description: '让更多人看到品牌',
    tasks: [
      { title: '制定品牌宣传内容策略', taskType: 'geo', priority: 'high' },
      { title: '生成品牌口碑内容', taskType: 'content', priority: 'medium' },
    ],
  },
  activity: {
    key: 'activity',
    label: '活动营销',
    goalId: 'factory-expo',
    description: '展会 / 峰会 / 学术会',
    tasks: [
      { title: '策划活动主题与亮点', taskType: 'activity', priority: 'high' },
      { title: '生成活动邀约文案', taskType: 'content', priority: 'medium' },
    ],
  },
  patient_acquisition: {
    key: 'patient_acquisition',
    label: '患者获客',
    goalId: 'clinic-acquire',
    description: '新客增长 / 到店线索',
    tasks: [
      { title: '梳理获客渠道与卖点', taskType: 'patient_acquisition', priority: 'high' },
      { title: '制定同城内容计划', taskType: 'content', priority: 'medium' },
    ],
  },
  implant: {
    key: 'implant',
    label: '种植项目',
    goalId: 'clinic-project',
    description: '种植项目精准种草',
    tasks: [
      { title: '梳理种植项目卖点', taskType: 'project_marketing', priority: 'high' },
      { title: '生成 3 条短视频脚本', taskType: 'content', priority: 'medium' },
    ],
  },
  doctor_ip: {
    key: 'doctor_ip',
    label: '医生IP',
    goalId: 'clinic-doctor-ip',
    description: '医生专家人设',
    tasks: [
      { title: '梳理医生人设定位', taskType: 'doctor_ip', priority: 'high' },
      { title: '制定医生科普内容计划', taskType: 'content', priority: 'medium' },
    ],
  },
  private_domain: {
    key: 'private_domain',
    label: '老客召回',
    goalId: 'clinic-private',
    description: '老客内容与召回',
    tasks: [
      { title: '设计私域欢迎语与钩子', taskType: 'private_domain', priority: 'high' },
      { title: '制定私域召回话术', taskType: 'content', priority: 'medium' },
    ],
  },
};

/** 取某项目类型模板；未命中返回空结构（tasks 为空数组，不触发 AI）。 */
export function getProjectTemplate(projectTypeKey) {
  return PROJECT_TEMPLATES[projectTypeKey] || { key: projectTypeKey, label: '', goalId: null, description: '', tasks: [] };
}

export default PROJECT_TEMPLATES;
