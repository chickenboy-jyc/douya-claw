/**
 * webSearchHonesty.js —— 「联网」相关文案的诚实化助手（纯函数，不发起任何请求）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ────────────────────────────────────────────────────────────────────────────
 * 内网 LLM 网关**静默忽略** `enable_search`（详见 webSearchHealth.js 顶部注释），
 * 但产品里仍有多处 UI 把「模型凭训练记忆作答」标成「联网检索 / 正在联网检索 / 来源：联网检索」——
 * 这是**用户可见的假标签**（老板原话：「半个产品还在写联网检索，等于没修」）。
 *
 * 本模块把「按联网探针状态给出诚实文案」的逻辑集中成一组**纯函数**，供各 UI 复用，
 * 避免每个调用点各写各的、又各漏一处。约定：所有函数都**接收探针结果 health 作入参**，
 * 不自己读全局缓存 —— 这样可单测、可注入（与 marketDiagnosis 的 webHealth 传参做法一致）。
 * health 结构见 webSearchHealth.js 的 WebSearchHealth（至少含 `available: boolean|null`）。
 *
 * 三态口径（红线，与 describeSource 一致）：
 *   available === true   → 已确证联网：可以如实写「联网检索」；
 *   available === false  → 已确证未联网：照实写「未联网 · 模型推断」；
 *   available === null   → 未测 / 测不了：**按未知处理**，写「联网状态未确认」，绝不当 true。
 */
import { describeSource, SOURCE_KINDS } from './webSearchHealth.js';

/**
 * 是否已**确证**联网可用（available === true 才算；null / false 一律不算）。
 * @param {object|null|undefined} health
 * @returns {boolean}
 */
export function isWebConfirmed(health) {
  return !!(health && typeof health === 'object' && health.available === true);
}

/**
 * 未确证联网时的显式诚实声明（舆情 / 检索类结论区**必须**展示，避免老板把推断当真相）。
 * 已确证联网 → 返回 ''（无需声明）。
 * @param {object|null|undefined} health
 * @returns {string}
 */
export function noWebDeclaration(health) {
  if (isWebConfirmed(health)) return '';
  return '本轮未联网：以下内容为模型基于常见情形的推断，不代表实际联网检索 / 扫描结果，请勿据此判定「无风险 / 无负面」。';
}

/**
 * 舆情 AI 结论区的标题文案（绝不在未联网时谎称「联网检索结论」）。
 * @param {object|null|undefined} health
 * @returns {string}
 */
export function crisisLlmLabel(health) {
  return isWebConfirmed(health) ? 'AI 联网检索结论' : 'AI 结论（本轮未联网 · 模型推断）';
}

/**
 * 候选 / 条目的来源标注：复用 describeSource，未确证联网绝不出现「联网检索」。
 * @param {object|null|undefined} health
 * @returns {string}
 */
export function candidateSourceLabel(health) {
  return describeSource(SOURCE_KINDS.WEB, health);
}

/**
 * 「用户已确认候选」写入企业知识库时用的 note 文案。
 * 已确证联网 → 「来源：联网检索（已确认）」（与旧口径一致，向后兼容）；
 * 否则 → 「来源：未联网 · 模型推断（已确认）」/「来源：模型分析（联网状态未确认）（已确认）」。
 * @param {object|null|undefined} health
 * @param {boolean} [confirmed=true]
 * @returns {string}
 */
export function candidateSourceNote(health, confirmed = true) {
  return `来源：${candidateSourceLabel(health)}${confirmed ? '（已确认）' : ''}`;
}

/**
 * 过程性 UI 的左侧小标题：未确证联网时去掉「联网」二字（避免实时行为层面的撒谎）。
 * @param {object|null|undefined} health
 * @returns {string} '联网检索' | '公开信息识别'
 */
export function onboardingSearchKey(health) {
  return isWebConfirmed(health) ? '联网检索' : '公开信息识别';
}

/**
 * 过程性 UI 的正文：正在检索 / 正在识别（未确证联网时不谎称「联网」）。
 * @param {object|null|undefined} health
 * @param {string} [target] 目标名称（企业名等）
 * @returns {string}
 */
export function searchingText(health, target) {
  const t = target ? `「${target}」` : '';
  return isWebConfirmed(health)
    ? `正在搜索${t}的公开信息…`
    : `正在识别${t}的公开信息（未确证联网，结果可能来自模型推断）…`;
}

/** 候选列表区的来源角标（组件默认 props 用）。 */
export function candidatePickerNote(health) {
  return isWebConfirmed(health) ? '来自联网检索，需你确认' : '来自模型识别（未确证联网），需你确认';
}

/** 候选列表区标题（未确证联网时去掉「联网检索」字样）。 */
export function candidateListHeading(health) {
  return isWebConfirmed(health) ? '联网检索到的候选' : '识别到的候选';
}

/** 候选区旁的操作提示（「联网结果只是候选…」→ 未确证联网时改「识别结果…」）。 */
export function candidateHintText(health) {
  return isWebConfirmed(health) ? '联网结果只是候选，勾选确认后才会写入。' : '识别结果只是候选，勾选确认后才会写入。';
}

/** 候选检索进行中的提示。 */
export function searchingCandidateText(health) {
  return isWebConfirmed(health) ? '豆芽正在联网检索…' : '豆芽正在识别候选（未确证联网）…';
}

/** 候选检索失败时的兜底文案（未确证联网时不谎称「联网检索失败」）。 */
export function candidateFetchFailText(health) {
  return isWebConfirmed(health)
    ? '联网检索暂不可用，请稍后重试或手动添加。'
    : '候选检索暂不可用（未确证联网），请稍后重试或手动添加。';
}

/**
 * 「🔍 联网找候选 X」按钮文案：未确证联网时去掉「联网」并显式标注未确证。
 * @param {object|null|undefined} health
 * @param {string} [target] 目标名（如「子品牌」「竞品」）
 * @returns {string}
 */
export function webFindButtonText(health, target = '') {
  const t = String(target || '');
  return isWebConfirmed(health) ? `🔍 联网找候选${t}` : `🔍 找候选${t}（未确证联网）`;
}

/**
 * 构造舆情扫描的模型 prompt（纯函数，便于单测 / 反向控制）。
 *
 * 关键红线（B 类「命令模型去搜」的兜底约束）：
 *   · 保留「请联网检索」这类指令（删掉它会让模型彻底不去尝试）；
 *   · **补一条能力诚实兜底** —— 让模型在「无法访问实时网络」时明说，
 *     而不是用「本次未检索到明显负面」搪塞（后者会被老板误读为「查过了、没有负面」）。
 *
 * @param {object} p { name, parentName, kindText, aliasText, noteText, platText }
 * @returns {string}
 */
export function buildCrisisScanPrompt(p = {}) {
  const name = String(p.name || '');
  const parentName = String(p.parentName || '') || name;
  const aliasText = String(p.aliasText || '');
  const noteText = String(p.noteText || '');
  const kindText = String(p.kindText || '');
  const platText = String(p.platText || '');
  return [
    '你是一名公关舆情分析师。请联网检索**下面这一个品牌**的公开舆情，不要与公司主体或其他子品牌混在一起。',
    '',
    `公司主体：${parentName}`,
    `本次监控对象（${kindText}）：「${name}」${aliasText}${noteText}`,
    `重点平台：${platText}`,
    '',
    '严格要求：',
    `1. 只检索「${name}」本身的公开内容，不要写公司主体或其他子品牌的内容。`,
    `2. 注意同名实体干扰：「${name}」可能与无关的人名、地名、商品同名（或只有部分字面重合）。凡是明显与本公司业务无关的，请明确写「疑似同名干扰，已排除」，**不要计为负面**。`,
    '3. 检索到公司主体的正面新闻不等于本对象安全；中性报道、行业科普、招聘信息也**不要**判为负面。',
    '4. 输出三段：①一句话风险结论（安全 / 关注 / 预警 / 高危 + 一句原因）；②确实检索到的负面点（每条注明平台与来源）；③检索不到就明确写「本次未检索到明显负面」。',
    '5. 能力诚实兜底：若你**无法访问实时网络 / 无法真正联网检索**，必须在结论第一句就明确写「本轮无法联网检索」，禁止用「本次未检索到明显负面」代替 —— 二者含义完全不同，后者会被误读为「已经查过、确认没有负面」。',
    '控制在 250 字以内，不要臆造来源。',
  ].join('\n');
}

export default {
  isWebConfirmed,
  noWebDeclaration,
  crisisLlmLabel,
  candidateSourceLabel,
  candidateSourceNote,
  onboardingSearchKey,
  searchingText,
  candidatePickerNote,
  candidateListHeading,
  candidateHintText,
  searchingCandidateText,
  candidateFetchFailText,
  webFindButtonText,
  buildCrisisScanPrompt,
};
