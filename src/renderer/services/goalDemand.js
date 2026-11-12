/**
 * 「保存需求」的本地存储层。
 *
 * 场景：用户点了一个**尚未开通**的目标（例：dealer-inventory），产品不给他生成方案、也不建项目，
 * 但需求不能丢 —— 用户可以把这次需求「记下来」，之后再回来看。
 *
 * 沿用本仓 renderer store 的既有约定：localStorage + `douya-` 前缀，**按企业隔离**。
 * 读入一律容错：脏数据 / JSON 解析失败 / 非数组 ⇒ 回落空数组，绝不抛错。
 */

/** localStorage key（唯一真源）。 */
export const GOAL_DEMANDS_KEY = 'douya-goal-demands';

/** 取 localStorage；不可用（node / 隐私模式）时返回 null，调用方安全降级。 */
function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * 读全部需求条目（跨企业）。容错：任何异常 ⇒ []。
 * @returns {Array<object>}
 */
function readAll() {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(GOAL_DEMANDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

/**
 * 写回全部条目。容错：写失败（配额 / 不可用）静默忽略，不影响调用方。
 * @param {Array<object>} list
 */
function writeAll(list) {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(GOAL_DEMANDS_KEY, JSON.stringify(Array.isArray(list) ? list : []));
  } catch {
    /* 写失败不抛：需求列表是辅助能力，不该拖垮主流程 */
  }
}

const toStr = (v) => (v == null ? '' : String(v));

/**
 * 列出某企业下已保存的需求，按保存时间**倒序**。
 * @param {string|number} companyId 企业 id
 * @returns {Array<{companyId:string, goalId:string, label:string, gap:string, savedAt:number}>}
 */
export function listGoalDemands(companyId) {
  const cid = toStr(companyId);
  return readAll()
    .filter((x) => toStr(x.companyId) === cid)
    .slice()
    .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));
}

/**
 * 保存一条需求。**同企业同目标去重**：已存在则刷新保存时间（不新增一条）。
 * @param {{companyId: string|number, goalId: string, label?: string, gap?: string}} demand
 * @returns {Array<object>} 该企业下最新的需求列表（倒序）
 */
export function saveGoalDemand(demand) {
  const d = demand && typeof demand === 'object' ? demand : {};
  const cid = toStr(d.companyId);
  const gid = toStr(d.goalId);
  const list = readAll();
  const entry = {
    companyId: cid,
    goalId: gid,
    label: toStr(d.label),
    gap: toStr(d.gap),
    savedAt: Date.now(),
  };
  const idx = list.findIndex((x) => toStr(x.companyId) === cid && toStr(x.goalId) === gid);
  if (idx >= 0) list.splice(idx, 1, entry);
  else list.push(entry);
  writeAll(list);
  return listGoalDemands(cid);
}

/**
 * 删除某企业下某目标的需求（不存在则安全无操作）。
 * @param {string|number} companyId
 * @param {string} goalId
 * @returns {Array<object>} 该企业下最新的需求列表（倒序）
 */
export function removeGoalDemand(companyId, goalId) {
  const cid = toStr(companyId);
  const gid = toStr(goalId);
  const list = readAll().filter((x) => !(toStr(x.companyId) === cid && toStr(x.goalId) === gid));
  writeAll(list);
  return listGoalDemands(cid);
}
