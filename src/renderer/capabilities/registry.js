/**
 * capabilities/registry.js —— 统一能力注册中心（阶段四核心）。
 *
 * 所有 AI 能力统一注册在这里，通过 company_type + capability_config 决定可用能力，
 * 不为厂家/门诊复制两套代码。task_type → capability 的反向映射也由此唯一导出。
 *
 * 关键函数：
 *  - getCapability(id)                      取单个能力
 *  - canUseCapability(companyType, capId)   业务能力路由（非安全权限；安全仍由 Account/Member 控制）
 *  - listCapabilitiesForType(companyType)   某企业类型可用能力列表
 *  - resolveCapabilityForType(taskType, companyType, projectType)  Task → Capability（唯一事实源）
 *  - TASK_TYPE_CAPABILITY                   task_type → capability 反向映射
 *  - ASSET_TYPE_BY_CAPABILITY               capability → 默认资产 type
 */

import { CAP_STATUS } from './base.js';
import { REAL_CAPABILITIES } from './real.js';
import { SPECIALIZED_CAPABILITIES } from './specialized.js';

// 全部能力均已开通（真实 AI 执行，无 building 占位）。
const ALL_CAPABILITIES = [...REAL_CAPABILITIES, ...SPECIALIZED_CAPABILITIES];

/** id → Capability 映射。 */
export const CAPABILITIES = {};
for (const c of ALL_CAPABILITIES) CAPABILITIES[c.id] = c;

/** 能力数组（有序）。 */
export const CAPABILITY_LIST = ALL_CAPABILITIES;

/** task_type → capability（由各能力 taskTypes 唯一派生，禁止组件重写）。 */
export const TASK_TYPE_CAPABILITY = {};
for (const c of ALL_CAPABILITIES) {
  for (const tt of c.taskTypes) TASK_TYPE_CAPABILITY[tt] = c.id;
}

/** 项目类型 → 默认 capability（Task 无 task_type 时按项目类型兜底）。 */
export const PROJECT_TYPE_CAPABILITY = {
  // 厂家
  new_product: 'content',
  zhaoshang: 'channel',
  doctor_kol: 'kol',
  brand: 'geo',
  activity: 'activity',
  media: 'media',
  xinmeiti: 'content',
  education: 'academic',
  // 门诊
  patient_acquisition: 'patient_acquisition',
  implant: 'content',
  ortho: 'content',
  doctor_ip: 'doctor_ip',
  private_domain: 'private_domain',
  local: 'local_marketing',
  reputation: 'crisis',
};

/** capability → 默认资产 type（成功后自动落库）。 */
export const ASSET_TYPE_BY_CAPABILITY = {};
for (const c of ALL_CAPABILITIES) {
  if (c.assetType) ASSET_TYPE_BY_CAPABILITY[c.id] = c.assetType;
}

/** 取单个能力（未知返回 null）。 */
export function getCapability(id) {
  return CAPABILITIES[id] || null;
}

/**
 * 企业类型 → 能力集（T01 四主体底座）。
 * doctor 走 clinic 能力集（面向 C 端患者），platform 走 manufacturer 能力集（面向 B 端商家/合作伙伴）。
 * 目的：让 4 主体复用现有全部能力路由，不新造权限体系，新增两个类型不改动任何已有能力判断逻辑。
 */
const CAP_SET_OF_TYPE = {
  clinic: 'clinic',
  doctor: 'clinic',
  manufacturer: 'manufacturer',
  platform: 'manufacturer',
};

/**
 * 企业类型 → 能力集名（未知类型兜底 manufacturer，与改造前行为一致）。
 * @param {string} companyType manufacturer | clinic | doctor | platform
 * @returns {'clinic'|'manufacturer'}
 */
function capSetOf(companyType) {
  return CAP_SET_OF_TYPE[companyType] || 'manufacturer';
}

/** 能力是否可用（业务路由，非安全权限）。 */
export function canUseCapability(companyType, capabilityId) {
  const cap = getCapability(capabilityId);
  if (!cap) return false;
  const t = capSetOf(companyType);
  return cap.supportedCompanyTypes.includes(t);
}

/** 某企业类型可用能力列表。 */
export function listCapabilitiesForType(companyType) {
  const t = capSetOf(companyType);
  return ALL_CAPABILITIES.filter((c) => c.supportedCompanyTypes.includes(t));
}

/** 能力中文名（未知回原 id）。 */
export function capabilityLabel(id) {
  const cap = getCapability(id);
  return cap ? cap.name : id;
}

/**
 * Task → Capability 唯一事实源。
 * 优先级（阶段四 §十四）：显式 task_type → 项目类型 → 通用 chat。
 * 再做业务路由校验：解析出的能力若当前企业类型不可用，回退 chat（保证始终可执行，不越权）。
 * @returns {string} capability id
 */
export function resolveCapabilityForType(taskType, companyType, projectType) {
  let capId = null;
  if (taskType && TASK_TYPE_CAPABILITY[taskType]) capId = TASK_TYPE_CAPABILITY[taskType];
  if (!capId && projectType && PROJECT_TYPE_CAPABILITY[projectType]) capId = PROJECT_TYPE_CAPABILITY[projectType];
  if (!capId) capId = 'chat';
  if (!canUseCapability(companyType, capId)) capId = 'chat';
  return capId;
}

export { CAP_STATUS };
export default CAPABILITIES;
