/**
 * capabilityResolver —— task_type 唯一事实源 + capability 派生（阶段四改造：委托统一注册中心）。
 *
 * 共享知识约定：
 * 1. task_type 常量唯一导出位置是这里的 TASK_TYPES，组件禁止重写枚举。
 * 2. task_type → capability 的反向映射唯一来源是 capabilities/registry.js（TASK_TYPE_CAPABILITY）。
 * 3. capability 由 resolveCapability(taskType) 派生（未知兜底 chat）；带公司类型权限的用 resolveCapabilityForType。
 * 4. capability → 落地模块由 moduleForCapability(capability) 派生。
 * 纯函数，无副作用、无 React 依赖。
 */

import {
  TASK_TYPE_CAPABILITY as _TASK_TYPE_CAPABILITY,
  resolveCapabilityForType as _resolveCapabilityForType,
  canUseCapability as _canUseCapability,
  capabilityLabel as _capabilityLabel,
  getCapability,
} from '../capabilities/registry.js';

/** 任务类型枚举（中文标签）。 */
export const TASK_TYPES = {
  // 公共
  content: '内容创作',
  geo: 'GEO策略',
  media: '媒体传播',
  activity: '活动策划',
  social: '社媒运营',
  research: '调研分析',
  crisis: '危机公关',
  analysis: '数据分析',
  design: '设计创意',
  other: '其他',
  // 厂家
  product: '产品营销',
  kol: '医生KOL',
  channel: '渠道招商',
  exhibition: '展会活动',
  academic: '学术教育',
  // 门诊
  patient_acquisition: '患者获客',
  doctor_ip: '医生IP',
  private_domain: '私域运营',
  local_marketing: '同城营销',
  project_marketing: '项目营销',
  // 共用
  competitor: '竞品对比',
};

/** 唯一事实源：task_type → capability（由注册中心导出）。 */
export const TASK_TYPE_CAPABILITY = _TASK_TYPE_CAPABILITY;

/** 由 task_type 派生 capability（未知类型兜底 chat；不校验公司类型）。 */
export function resolveCapability(taskType) {
  return _TASK_TYPE_CAPABILITY[taskType] || 'chat';
}

/** Task → Capability（带公司类型业务路由 + 项目类型兜底）。 */
export function resolveCapabilityForType(taskType, companyType, projectType) {
  return _resolveCapabilityForType(taskType, companyType, projectType);
}

/** 能力是否可用（业务路由，非安全权限）。 */
export function canUseCapability(companyType, capabilityId) {
  return _canUseCapability(companyType, capabilityId);
}

/** 能力中文名。 */
export function capabilityLabel(id) {
  return _capabilityLabel(id);
}

/** capability → 落地模块（与旧 App.CAP_MODULE_MAP 合并为单一来源）。 */
export const CAPABILITY_MODULE = {
  // 通用
  chat: 'workbench',
  geo: 'geo',
  content: 'xinmeiti',
  media: 'media',
  activity: 'huodong',
  crisis: 'crisis',
  research: 'workbench',
  analysis: 'workbench',
  competitor: 'competitor',
  // 厂家专属
  product: 'xinmeiti',
  kol: 'xinmeiti',
  channel: 'media',
  academic: 'xinmeiti',
  exhibition: 'huodong',
  // 门诊专属
  patient_acquisition: 'geo',
  doctor_ip: 'xinmeiti',
  private_domain: 'xinmeiti',
  local_marketing: 'geo',
};

/** capability → 落地模块（未知能力兜底工作区）。 */
export function moduleForCapability(capability) {
  return CAPABILITY_MODULE[capability] || 'workbench';
}

/** 能力是否「建设中」。 */
export function isCapabilityBuilding(id) {
  const cap = getCapability(id);
  return !!cap && cap.status === 'building';
}

/** 任务类型中文标签。 */
export function taskTypeLabel(taskType) {
  return TASK_TYPES[taskType] || '其他';
}

export default resolveCapability;
