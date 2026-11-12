/**
 * companyRegion —— 企业「地区（region）」读写纯函数（唯一事实源）。
 *
 * 背景（onboarding-v2 / T01）：
 *   老板要求「后期按地区运营」（诊所/医生按同城、厂家/经销商按区域卖货、平台按覆盖城市）。
 *   现状历史 key 不统一：clinic / doctor 用 `city`，manufacturer 用 `regions`（都在 companyTypeConfig
 *   的 onboardingFields 里），下游无任何逻辑读取它们。为统一口径又不破坏兼容：
 *     · 规范 key = `region`（写入 company.profile.region，profile 为透传字段，无需改数据结构）；
 *     · 镜像 key = clinic / doctor → `city`，manufacturer / dealer / platform → `regions`（纯保险）。
 *
 * 🔴 落库红线（E1）：地区**只能**经 `companyKnowledgeStore.updateProfile(companyId, patch)` 写入。
 *   `companyStore.updateCompany(id, patch)` 会走 `normalizeCompany`，把 `region`/`city` 等未知字段**静默丢弃**
 *   （companyStore.jsx 的 normalizeCompany 只保留 id/name/type/role/workspaceId/status/memory/createdAt）。
 *
 * 本模块为无副作用纯函数，便于单测。
 */

/**
 * 地区镜像 key：clinic / doctor 沿用历史的 `city`，其余类型沿用历史的 `regions`。
 * @param {string} type 企业类型 key
 * @returns {'city'|'regions'}
 */
export function regionMirrorKey(type) {
  return (type === 'clinic' || type === 'doctor') ? 'city' : 'regions';
}

/**
 * 读企业地区：按 规范 key `region` → 旧 `city` → 旧 `regions` 依次回退（容错，任意非对象一律返回空串）。
 * @param {object|null|undefined} profile 公司 profile（companyKnowledgeStore 的 getKnowledge(cid).profile）
 * @returns {string}
 */
export function readCompanyRegion(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  return String(p.region || p.city || p.regions || '').trim();
}

/**
 * 构造地区写入 patch：同时写规范 key `region` 与类型对应的镜像 key。
 * 例：buildRegionPatch(' 杭州 ', 'clinic') → { region: '杭州', city: '杭州' }
 * @param {string} region 地区文本（自动 trim）
 * @param {string} type 企业类型 key（决定镜像 key）
 * @returns {{region: string} & Record<string, string>}
 */
export function buildRegionPatch(region, type) {
  const v = String(region == null ? '' : region).trim();
  return { region: v, [regionMirrorKey(type)]: v };
}

export default { regionMirrorKey, readCompanyRegion, buildRegionPatch };
