/**
 * companyIdentity —— 「首登时豆芽认对了公司吗」的判断逻辑（纯函数，可单测）。
 *
 * ── 为什么需要这个文件（2026-09-12 老板反馈）────────────────────────────────
 * 首登输入企业名后会联网检索公开信息，但检索很容易出错，两类高频误判：
 *   ① 名字相近：想做「杭州康健苗苗」，检索回来的却是「康健苗苗（天津）」或同名的另一家；
 *   ② 查不到：刚注册的公司、个体诊所、没做过任何公开曝光的公司，检索结果为空或极简。
 * 旧实现把检索结果当事实直接展示，用户既不能否认、也没有地方补充 ——
 * 一旦认错，后面「体检 → 短板 → 方向 → 方案」全都建立在错误的公司上。
 *
 * 本模块只做两件事，且都必须是**可判断、可解释、不忽悠**的：
 *   1. 判断用户手填的企业信息够不够用（validateManualCompanyInfo）；
 *   2. 给出「能不能继续」的结论与理由（judgeIdentityGate）。
 *
 * 红线：判断不通过时必须给出**具体到可执行**的理由，不能只回一句「不合法」。
 */

/** 常见占位/敷衍输入（命中即判为「没真填」）。比较时去空白并转小写。 */
export const MANUAL_PLACEHOLDERS = [
  '不知道', '不清楚', '不记得', '暂无', '无', '没有', '待定', '待补充', '略', '同上',
  '测试', 'test', 'abc', 'xxx', 'asdf', '。。', '...', '---', '还没想好', '以后再说',
];

/** 手填信息的最小有效长度（中文字符口径：太短说不清「做什么、给谁」）。 */
export const MANUAL_MIN_LEN = 8;
/** 手填信息上限（与后端 prompt 长度习惯保持一致，避免把档案撑爆）。 */
export const MANUAL_MAX_LEN = 200;

/**
 * 手填企业信息只允许「有实质内容」的文本。
 *
 * @param {string} raw 用户输入
 * @returns {{ok: boolean, reason: string, value: string}} reason 为不通过时的原因（通过时为空串）
 */
export function validateManualCompanyInfo(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) {
    return { ok: false, reason: '还没填。用一句话说清「你是做什么的、卖给谁」，豆芽才能接着往下做。', value };
  }
  if (value.length < MANUAL_MIN_LEN) {
    return { ok: false, reason: `太短了（至少 ${MANUAL_MIN_LEN} 个字）。比如「杭州口腔门诊，做种植和正畸，客户是周边中老年缺牙患者」。`, value };
  }
  if (value.length > MANUAL_MAX_LEN) {
    return { ok: false, reason: `太长了（最多 ${MANUAL_MAX_LEN} 个字），一句话说清重点即可。`, value: value.slice(0, MANUAL_MAX_LEN) };
  }

  const compact = value.replace(/\s+/g, '').toLowerCase();
  if (MANUAL_PLACEHOLDERS.includes(compact)) {
    return { ok: false, reason: '这句话还不能用来判断企业做什么。请换成具体的业务描述（做什么 + 卖给谁）。', value };
  }
  // 纯符号 / 纯数字 / 只有重复单字（如「aaaa」「1111」「。。。」）→ 没有信息量
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(compact)) {
    return { ok: false, reason: '没看到文字内容。请用中文或英文说清企业是做什么的。', value };
  }
  if (/^(.)\1+$/.test(compact)) {
    return { ok: false, reason: '检测到重复字符，看起来不是企业描述。请换成一句真实的业务说明。', value };
  }
  // 至少要能看出「业务对象/角色」之一，否则对下游（体检 / 方向 / 方案）没有增量。
  // 中英双轨：口腔行业里有不少团队用英文写业务（dental clinic / distributor / implant），
  // 只认中文会把这类真实描述误杀 —— 误杀比漏放更糟（用户连公司都说不清就进不去系统）。
  const hasBizWord = /(公司|企业|厂|门店|门诊|诊所|医院|机构|平台|品牌|团队|集团|中心|商城|店铺|经销|代理|服务|产品|设备|器械|材料|软件|课程|项目|客户|患者|医生|B端|C端|线下|线上|company|corp|clinic|dental|hospital|implant|orthodont|distributor|dealer|supplier|brand|platform|agency|service|product|clinic)/i.test(value);
  if (!hasBizWord) {
    return { ok: false, reason: '看不出企业类型与业务。建议带上身份或客户，例如「儿童矫治器厂家」「口腔门诊」「牙科耗材经销商」。', value };
  }
  return { ok: true, reason: '', value };
}

/**
 * 「继续」按钮的放行判断（首登第 4 步）。
 *
 * 口径（必须两头都保住）：
 *  - 有检索结果 → 用户必须先表态：确认「就是这家」或「不对，我自己填」；
 *    选了自己填 → 必须通过 validateManualCompanyInfo；
 *  - 检索失败/无结果（刚注册的公司查不到）→ **不强制手填**，允许直接继续。
 *    为什么：把「查不到」也变成必填项，等于让新公司卡死在首登，这是比误判更严重的问题。
 *
 * @param {Object} p
 * @param {boolean} p.hasWebResult 联网检索是否拿到了内容
 * @param {string} p.identity 'pending' | 'confirmed' | 'manual'
 * @param {string} p.manualText 手填内容
 * @returns {{canContinue: boolean, reason: string, needsManual: boolean, manual: Object}}
 */
export function judgeIdentityGate({ hasWebResult, identity, manualText } = {}) {
  const manual = validateManualCompanyInfo(manualText);

  if (!hasWebResult) {
    // 查不到：手填是加分项不是门槛。填了就必须有效，没填也放行。
    const typed = String(manualText == null ? '' : manualText).trim();
    if (typed && !manual.ok) {
      return { canContinue: false, reason: manual.reason, needsManual: true, manual };
    }
    return { canContinue: true, reason: '', needsManual: true, manual };
  }

  if (identity === 'confirmed') {
    return { canContinue: true, reason: '', needsManual: false, manual };
  }
  if (identity === 'manual') {
    if (!manual.ok) return { canContinue: false, reason: manual.reason, needsManual: true, manual };
    return { canContinue: true, reason: '', needsManual: true, manual };
  }
  // pending：既没确认也没否认 → 拦住并说清为什么
  return {
    canContinue: false,
    reason: '先确认一下：上面识别到的这家公司，是你这次要做的公司吗？是就点「对，就是这家」，不是就点「不对，我自己填」。',
    needsManual: true,
    manual,
  };
}
