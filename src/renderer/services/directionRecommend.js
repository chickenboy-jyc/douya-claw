/**
 * directionRecommend —— 首登「第 8 步：选经营方向」的 AI 排序 + 个性化理由服务。
 *
 * 背景（老板拍板的实质升级）：
 *   旧实现 getDirections(type) 只按「企业类型」查硬编码目录，第 6 步用户立下的经营目标
 *   从头到尾没被读过 —— 「外壳是 AI、内壳是死表」。本服务接真 AI，把「AI 根据企业目标
 *   给出经营方向」落到实处。
 *
 * 硬约束（刻意的设计，不是偷懒）：
 *   方向 key 是下游契约。Onboarding.jsx 的 buildDirection(dirKey, ...) 会用 key 去
 *   getDirectionByKey(type, key) 查目录，查不到就静默返回 {direction:null}。
 *   所以 **AI 绝不能发明新方向 key**，它只能在「既有候选方向」里做：
 *     ① 按「现在最该先做哪个」排序；② 为每个方向写个性化理由（引用企业目标与画像）。
 *   UI 显示什么与落库什么本就解耦（chooseDirection 只把 key 交给 buildDirection），
 *   因此 AI 只改显示与排序，零契约风险。
 *
 * 设计对照：与 goalGuide.recommendGoals 同构（AI 从候选清单里挑 + 写理由）。
 *
 * 2026-09-12 增量：接入首登第 4 步的「企业体检短板」（p.gaps）。
 *   老板追问「分析完真的对这个企业有了解了吗？分析完指出不足 → 运营方向 → 给几种方案让用户确认」，
 *   若第 8 步排序无视第 4 步查出的短板，用户看到的就是「分析说得头头是道、方案却跟短板无关」。
 *   故新增 DIRECTION_GAP_RULE，并把 gaps 写进 prompt —— 只影响 AI 的判断依据，
 *   **不改 mergeDirectionPicks 的产出契约**（仍是 { key, reason, fit, fitLabel }），零下游风险。
 *
 * 2026-09-15 增量：方案卡片默认态「AI 压缩短句」（老板原话「方案选择字太多了，需不需要 AI 简化」）。
 *   复用**同一次** recommendDirections 调用，多返回一个 shortSummary（每条约 12-18 字），
 *   **不新增网络请求**。产出契约**只增一个字段**：
 *   { key, reason, fit, fitLabel, shortSummary } —— reason/fit/fitLabel 的语义与取值域不变。
 *   模型没给 / 空串 / 超长 / 回显占位时，UI 侧 pickShortSummary 回退静态 summary 首句。
 *
 * 纯函数边界：
 *   - mergeDirectionPicks 是纯函数，可在 node 里裸测，不读 localStorage、不 import React、不调 AI；
 *   - recommendDirections 只负责编排（组装 prompt → 调 chatFn → 解析 → 白名单归一化），
 *     失败一律返回 { ok:false, error }，**绝不编造 list**。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
import { getDirections } from '../config/directionCatalog.js';

/** fit 合法取值（与目录注释、UI 渲染口径一致）。 */
const FIT_VALUES = ['高', '中', '低'];
/** fit 非法时的归一化默认值。 */
const FIT_DEFAULT = '中';

/**
 * 「为什么选这个方向」必须从企业画像与用户目标推导的硬性约束（禁止空泛理由）。
 * 措辞沿用 goalGuide.js 的 REASON_RULE 风格（同款口径，避免两处风格漂移）。
 */
export const DIRECTION_REASON_RULE = [
  '每条「reason（为什么这个方向适合你现在这家企业）」必须从当前企业画像与用户刚立下的经营目标中推导，',
  '明确引用具体信息（行业、产品、核心卖点、目标客户、竞品、企业目标），',
  '例如「企业主营种植体，目标客户是民营口腔门诊，竞品正主推数字化方案，且你今年要冲营收，所以应先……」。',
  '禁止输出「因为要增长」「因为重要」「提升品牌」等空泛理由；信息不足时写明「企业画像中缺少 X 信息」。',
].join('');

/**
 * 「key 必须严格取自候选清单」的硬性约束原文。
 * 这条是防「AI 发明新 key → 下游 getDirectionByKey 查不到 → 用户点了没反应」的红线。
 */
export const DIRECTION_KEY_RULE =
  '每个 key 必须严格取自上面的候选方向清单：不得新增、不得改写、不得遗漏；清单之外的 key 一律无效。';

/**
 * 「排序必须优先考虑体检短板」的硬性约束原文。
 *
 * 为什么需要：首登第 4 步的企业体检已经指出了短板，第 8 步若无视短板排序，
 * 用户会看到「分析说得头头是道、方案却跟短板毫无关系」的断裂 —— 正是老板追问的
 * 「分析完真的对这个企业有了解了吗」。这条把两者接上。
 */
export const DIRECTION_GAP_RULE =
  '若已给出企业短板，排序时必须优先把「能直接改善这些短板」的方向排在前面，并在 reason 中点明该方向改善的是哪一条短板。';

/**
 * shortSummary 合法最大长度。超过即视为「模型不听话」，UI 回退静态 summary 首句。
 * 取 30：目标区间是 12-18 字，30 留一倍冗余；超过 30 基本是模型把整段塞进来了。
 */
export const SHORT_SUMMARY_MAX = 30;

/**
 * 「提示词回显 / 无意义占位」拒绝名单：模型有时会把提示词片段或占位语原样吐进字段
 * （例如「省略」「模板未配」「无摘要」），这类值**语义上不是短句**，必须回退。
 * 命中（整串完全匹配）即视为无效 shortSummary。
 */
export const SHORT_SUMMARY_REJECT = /^(?:模板未配|省略|略|无摘要|暂无)$/;

/**
 * 「一句话短句」硬约束原文（与 DIRECTION_*_RULE 同款导出，便于单测引用特征串）。
 */
export const DIRECTION_SHORT_RULE = [
  'shortSummary 必须是一句中文短句（12-18 字），一句话说清「这套方案现在主要干什么」；',
  '不要标点堆砌（最多一个句末标点）、不要换行、不要出现「AI」「大模型」「豆芽」等字样；',
  '不得编造候选方向说明里没有的事实；信息不足时用该方向现有说明里的措辞概括；',
  '不要把要求原文、占位语（如「省略」「模板未配」）当作内容输出。',
].join('');

/** 取字符串（非字符串 → 空串，并 trim）。 */
function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** fit 归一化：非法值（含 undefined / 数字 / 其它中文）统一回退 '中'。 */
function normFit(v) {
  const s = asStr(v);
  return FIT_VALUES.includes(s) ? s : FIT_DEFAULT;
}

/**
 * 把 AI 归一化后的选择（picks）合并进候选目录，产出 UI 可直接渲染的 list。
 *
 * 规则（红线）：
 *   - 丢弃 key 不在候选白名单里的项（比对前对 key 做 String(...).trim()）；
 *   - 同 key 只保留「首次出现」的那条（去重）；
 *   - 保留 AI 给的顺序（这就是「豆芽建议先做哪个」的排序）；
 *   - 候选里未被 AI 提到的方向，按目录原顺序追加到末尾（reason:''、fit:'中'）
 *     —— AI 的遗漏绝不能让用户少看到一个方向；
 *   - 产出字段一律为 { key, reason, fit, fitLabel, shortSummary }，不带候选里 deliveryPlan/actions 等大字段；
 *   - 不修改入参（先复制）。
 *
 * @param {Array<{key?:unknown, reason?:unknown, fit?:unknown, shortSummary?:unknown}>} picks AI 归一化后的选择
 * @param {Array<{key?:unknown}>} candidates 目录数组（getDirections 的返回值）
 * @returns {Array<{key:string, reason:string, fit:'高'|'中'|'低', fitLabel:'高'|'中'|'低', shortSummary:string}>}
 */
export function mergeDirectionPicks(picks, candidates) {
  const cands = Array.isArray(candidates) ? candidates : [];
  if (cands.length === 0) return [];

  // 候选白名单（key 去空白去重），并记录目录原顺序。
  const candidateKeys = [];
  const candidateKeySet = new Set();
  for (const c of cands) {
    const k = c && c.key != null ? String(c.key).trim() : '';
    if (!k || candidateKeySet.has(k)) continue;
    candidateKeySet.add(k);
    candidateKeys.push(k);
  }
  if (candidateKeys.length === 0) return [];

  const pickList = Array.isArray(picks) ? picks : [];
  const mentioned = new Set();
  const out = [];

  // ① 先按 AI 顺序收下合法项（丢弃编造 key + 去重保留首次）。
  for (const it of pickList) {
    if (!it || typeof it !== 'object') continue; // 单项非对象 → 跳过
    const k = it.key != null ? String(it.key).trim() : '';
    if (!k || !candidateKeySet.has(k)) continue; // 编造 / 空 key → 丢弃
    if (mentioned.has(k)) continue; // 已出现 → 只保留首次
    mentioned.add(k);
    const fit = normFit(it.fit);
    out.push({ key: k, reason: asStr(it.reason), fit, fitLabel: fit, shortSummary: asStr(it.shortSummary) });
  }

  // ② 补全：AI 遗漏的方向按目录原顺序追加到末尾。
  for (const k of candidateKeys) {
    if (mentioned.has(k)) continue;
    out.push({ key: k, reason: '', fit: FIT_DEFAULT, fitLabel: FIT_DEFAULT, shortSummary: '' });
  }

  return out;
}

/** 取静态 summary 的首句（按「。」切分取 [0]；无句号则整句）。 */
function firstSentence(text) {
  const t = asStr(text);
  if (!t) return '';
  return t.split('。')[0].trim();
}

/**
 * 取卡片默认态要展示的「压缩短句」。
 *
 * 优先级：模型给的 shortSummary（长度合法 且 非回显占位）→ 该方向静态 summary 的首句（回退）
 *        → 再兜底 '暂无数据'（事实缺失一律写「暂无数据」，见项目红线）。
 *
 * 回退判据一律基于**值**（不是真值）：
 *   - 缺失 / 非字符串 / 空串 / 超长（> SHORT_SUMMARY_MAX）/ 命中 SHORT_SUMMARY_REJECT → 回退；
 *   - 静态 summary 无「。」时 `split('。')[0]` 返回整段（不抛、不返回 undefined）；
 *   - 静态 summary 也缺失时返回 '暂无数据'，绝不返回 undefined / ''，避免 UI 渲染空白。
 * 纯函数，可 node 裸测、不起网络。
 *
 * @param {{shortSummary?:unknown}} pick  mergeDirectionPicks 产出的单条
 * @param {{summary?:unknown}} [cat]      目录方向对象
 * @returns {string} 短句（永不为 undefined；最差为 '暂无数据'）
 */
export function pickShortSummary(pick, cat) {
  const s = asStr(pick && pick.shortSummary);
  if (s && s.length <= SHORT_SUMMARY_MAX && !SHORT_SUMMARY_REJECT.test(s)) return s;
  return firstSentence(cat && cat.summary) || '暂无数据';
}

/** 把候选方向拼成「key(名称 - 现有说明)」清单文本，供 AI 选择。 */
function directionOptionsText(candidates) {
  return candidates
    .map((d) => {
      const key = d && d.key != null ? String(d.key).trim() : '';
      const name = d && d.name ? String(d.name).trim() : '';
      const summary = d && d.summary ? String(d.summary).trim() : '';
      return `${key}(${name} - ${summary})`;
    })
    .join('\n');
}

/**
 * AI 根据「企业真实目标 + 画像」对既有经营方向做排序 + 写个性化理由。
 *
 * @param {object} [p]
 * @param {object} [p.currentCompany] 企业对象
 * @param {object} [p.asset] 企业营销资产
 * @param {object} [p.knowledge] getKnowledge(companyId) 返回值（含 goals / plan / timeline）
 * @param {string} [p.companyType] 'manufacturer' | 'clinic' | 'doctor' | 'platform'
 * @param {string} [p.role] 默认 'admin'
 * @param {string} [p.goalLabel] 用户刚在 Step6 立下的目标陈述
 * @param {Array<string>} [p.goals] 可选：目标数组（若调用方已读库）
 * @param {object} [opts] { chatFn, temperature }（chatFn 可注入，单测靠它）
 * @returns {Promise<{ok:true, list:Array<{key:string,reason:string,fit:string,fitLabel:string}>}|{ok:false,error:string}>}
 */
export async function recommendDirections(p = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const companyType = p.companyType || 'manufacturer';

  // 候选清单由本服务自己生成 —— 不信任外部传入的候选，保证 key 白名单与下游永远一致。
  const candidates = getDirections(companyType);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, error: '没有可用的经营方向候选' };
  }

  const ctx = buildAIContext({
    company: p.currentCompany,
    asset: p.asset,
    knowledge: p.knowledge,
    role: p.role || 'admin',
    goalLabel: p.goalLabel || '',
  });

  // 目标陈述：优先用用户刚立的 goalLabel；否则回落到 goals 数组。
  const goalStatement = asStr(p.goalLabel);
  const goalList = (Array.isArray(p.goals) ? p.goals : []).map(asStr).filter(Boolean);
  const goalText = goalStatement || (goalList.length ? goalList.join('、') : '');

  // 首登第 4 步体检发现的短板（可选）。只取 title/why，缺 title 的丢弃 —— 不完整的一条
  // 让 AI 误读，比不给更糟。
  const gapList = (Array.isArray(p.gaps) ? p.gaps : [])
    .map((g) => ({ title: asStr(g && g.title), why: asStr(g && g.why) }))
    .filter((g) => g.title);
  const gapText = gapList.map((g) => (g.why ? `${g.title}（${g.why}）` : g.title)).join('；');

  const prompt = [
    '你是口腔行业经营顾问。用户刚完成企业注册与目标设定，现在要选择「经营方向」。',
    '请结合这家企业的真实画像与用户刚立下的经营目标，判断「现在最该先做哪个方向」，并为每个方向写出个性化理由。',
    `企业类型：${companyType}。`,
    goalText ? `用户刚立下的经营目标：${goalText}。` : '用户刚立下的经营目标：未提供（请仅依据企业画像判断）。',
    gapText ? `首登体检已指出的企业短板：${gapText}。` : '首登体检未给出明确短板。',
    '可选经营方向清单（key(名称 - 现有说明)）：',
    directionOptionsText(candidates),
    '请对清单里的每一个方向都给出「reason（为什么适合这家企业）」「fit（匹配度）」与「shortSummary（一句话短句）」，并按「现在最该先做」的顺序从先到后排列；排序依据必须是该企业的真实目标与画像。',
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "list": [ { "key": "上面清单里的 key", "reason": "为什么这个方向适合你现在这家企业", "fit": "高/中/低", "shortSummary": "一句话说清这套方案现在主要干什么（12-18 字）" } ] }',
    DIRECTION_KEY_RULE,
    'fit 取「高」「中」「低」之一。',
    DIRECTION_REASON_RULE,
    DIRECTION_SHORT_RULE,
    DIRECTION_GAP_RULE,
    '不得编造企业信息。',
  ].join('\n');

  let res;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
      reasoningEffort: 'none',
    });
  } catch (e) {
    return { ok: false, error: 'AI 调用失败' + (e && e.message ? `：${e.message}` : '') };
  }

  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || 'AI 调用失败' };
  }
  if (!res.content) {
    return { ok: false, error: 'AI 未返回内容' };
  }

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: '返回内容无法解析为 JSON' };
  }

  // 兼容 { list: [...] } 与直接数组两种形态（与 goalGuide 同款容错）。
  const raw = Array.isArray(parsed.list) ? parsed.list : Array.isArray(parsed) ? parsed : null;
  if (!Array.isArray(raw)) {
    return { ok: false, error: '返回内容结构不符（缺少 list 数组）' };
  }
  // AI 一条都没返回（空数组）→ 视为无效，不「假装成功」。
  // 注意：若 AI 返回了条目但 key 全是编造的，则不算此情形 —— 那种情况由 mergeDirectionPicks
  // 丢弃后补全全部候选并返回 ok:true（AI 的遗漏不能让用户少看到方向）。
  if (raw.length === 0) {
    return { ok: false, error: 'AI 未返回有效方向' };
  }

  // 归一化 AI 选择（只取契约字段，交由纯函数做白名单 / 去重 / 补全）。
  const picks = raw.map((it) => ({
    key: it && typeof it === 'object' ? it.key : undefined,
    reason: it && typeof it === 'object' ? it.reason : undefined,
    fit: it && typeof it === 'object' ? it.fit : undefined,
    shortSummary: it && typeof it === 'object' ? it.shortSummary : undefined,
  }));

  const list = mergeDirectionPicks(picks, candidates);
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: 'AI 未返回有效方向' };
  }

  return { ok: true, list };
}

export default { DIRECTION_REASON_RULE, DIRECTION_KEY_RULE, DIRECTION_GAP_RULE, DIRECTION_SHORT_RULE, SHORT_SUMMARY_MAX, SHORT_SUMMARY_REJECT, mergeDirectionPicks, pickShortSummary, recommendDirections };
