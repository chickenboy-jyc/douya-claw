/**
 * companyCheckup —— 首登「企业体检」：分析完之后，把「豆芽到底了解了什么」讲成人话，
 * 并指出短板与整改动作，作为第 8 步「选运营方案」的依据。
 *
 * 为什么单独做一个服务（而不是复用 deepThink）：
 *   - deepThink 产 brain，是**资产**（竞品 / 平台账号 / 运营洞察 / 内容角度），供各能力模块机器消费；
 *   - companyCheckup 产**体检报告**，是**给人看的判断**（理解 / 短板 / 整改），只在首登展示 + 选方案时引用。
 *   两者输入重叠（同一份画像与联网结果）、用途正交，故不合并；合并会让 brain 的契约被文案污染。
 *
 * 与「全是未知」那次教训一致的口径（本模块的红线）：
 *   ① AI 任何失败一律 { ok:false, error }，**绝不返回编造的报告**；
 *   ② 空壳（三段全空）视为无效 → 返回 ok:false，不许把空报告当成功展示；
 *   ③ 报告里每条「理解」都要能说出**来源**（你的填写 / 联网检索 / 豆芽推断），
 *      让用户一眼看出哪句是事实、哪句是 AI 假设。
 *
 * 纯函数边界：
 *   - normalizeCheckup 是纯函数，可在 node 里裸测（不读 localStorage、不 import React、不调 AI）；
 *   - runCompanyCheckup 只负责编排（组装 prompt → chatFn → 解析 → 归一化）。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
// 体检结论持久化（独立 key `douya-company-checkup`，与四类企业知识完全隔离）。
// 依赖方向：companyCheckup → checkupBrief → companyTimeline，无环。
import { saveCheckup } from './checkupBrief.js';

/** 「理解」条目的来源合法取值（UI 据此渲染来源标签）。 */
export const CHECKUP_FROM_VALUES = ['user', 'web', 'ai'];
/** 来源非法 / 缺失时的归一化默认值 —— 默认按「豆芽推断」算，宁可低估可信度也不冒充实测。 */
export const CHECKUP_FROM_DEFAULT = 'ai';

/** 各段最小保留条数上限（防 AI 灌水；超出截断，不报错）。 */
export const MAX_UNDERSTOOD = 8;
export const MAX_GAPS = 5;
export const MAX_FIXES = 5;

/**
 * 「全方位了解」的维度清单 —— 这是对「分析是不是真的了解这家企业」的正面回答。
 * 每个维度都要求 AI 要么给出判断，要么老实说「缺少 X 信息」，不许留空、不许编。
 */
export const CHECKUP_DIMENSIONS = [
  '主营与产品（到底卖什么）',
  '目标客户与决策链（谁买、谁拍板）',
  '竞品与替代方案（客户不比价也会想到谁）',
  '差异化卖点（凭什么选你）',
  '获客与传播渠道（现在靠什么让人知道）',
  '行业定位与所处阶段（在牌桌的哪个位置）',
];

/**
 * 体检报告的硬性约束原文（导出以便单测与 UI 复用同一口径）。
 * 措辞沿用 directionRecommend.DIRECTION_REASON_RULE 的风格，避免多处风格漂移。
 */
export const CHECKUP_RULE = [
  '【绝对约束】',
  '1. 只能依据「用户填写的资料」与「联网检索结果」作答；这两处都没有的信息，不许编造。',
  '2. 严禁编造具体数据：营收、客流、粉丝数、排名、市场占有率、疗效、治愈率一律不得出现。',
  '3. gaps（短板）每条必须写明依据（引用具体信息或「公开信息未见 X」），禁止「品牌影响力不足」这类无依据的结论。',
  '4. fixes（整改）必须是**可执行动作**（做什么、在哪做、多久见效），禁止「加强品牌建设」这类空话。',
  '5. 信息不足以判断某维度时，在该维度写「缺少 X 信息」，而不是给出猜测 —— 缺什么也要如实说。',
  '6. 若你**无法访问实时网络**（拿不到任何「联网检索结果」），必须如实以「未联网核实」说明，严禁把模型记忆里的推测冒充成检索到的公开信息。',
  '7. 只返回一个 JSON 对象，不要 markdown 围栏、不要任何解释文字。',
].join('\n');

/** 取字符串（非字符串 → 空串，并 trim）。 */
function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 把 AI 原始返回归一化为 UI 可直接渲染的报告；**不可用一律返回 null**。
 *
 * 规则（红线）：
 *   - 非对象 / 数组 / null → null；
 *   - understood 每条必须有 label 与 value，缺任一即丢弃；label 去重保留首次；上限 MAX_UNDERSTOOD；
 *   - from 非法（含缺失 / 数字 / 未知中文）统一回退 CHECKUP_FROM_DEFAULT；
 *   - gaps 每条必须有 title 与 why，缺任一即丢弃；title 去重；上限 MAX_GAPS；
 *   - fixes 每条必须有 gap 与 action，缺任一即丢弃；上限 MAX_FIXES；
 *   - summary 非字符串 → 空串；
 *   - **三段全空 → null**（空壳报告不是报告，必须让调用方按失败处理）；
 *   - 不修改入参。
 *
 * @param {unknown} raw AI 解析后的对象
 * @returns {{understood:Array<{label:string,value:string,from:string}>,gaps:Array<{title:string,why:string}>,fixes:Array<{gap:string,action:string}>,summary:string}|null}
 */
export function normalizeCheckup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  // ① 全方位理解
  const understood = [];
  const uSeen = new Set();
  const rawU = Array.isArray(raw.understood) ? raw.understood : [];
  for (const it of rawU) {
    if (understood.length >= MAX_UNDERSTOOD) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const label = asStr(it.label);
    const value = asStr(it.value);
    if (!label || !value) continue; // 缺项即丢弃，不留半条
    if (uSeen.has(label)) continue;
    uSeen.add(label);
    const from = asStr(it.from);
    understood.push({
      label,
      value,
      from: CHECKUP_FROM_VALUES.includes(from) ? from : CHECKUP_FROM_DEFAULT,
    });
  }

  // ② 短板
  const gaps = [];
  const gSeen = new Set();
  const rawG = Array.isArray(raw.gaps) ? raw.gaps : [];
  for (const it of rawG) {
    if (gaps.length >= MAX_GAPS) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const title = asStr(it.title);
    const why = asStr(it.why);
    if (!title || !why) continue;
    if (gSeen.has(title)) continue;
    gSeen.add(title);
    gaps.push({ title, why });
  }

  // ③ 整改动作
  const fixes = [];
  const rawF = Array.isArray(raw.fixes) ? raw.fixes : [];
  for (const it of rawF) {
    if (fixes.length >= MAX_FIXES) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const gap = asStr(it.gap);
    const action = asStr(it.action);
    if (!gap || !action) continue;
    fixes.push({ gap, action });
  }

  const summary = asStr(raw.summary);

  // ④ 空壳判负 —— 这三段全空意味着 AI 什么有效信息都没给，不能当成功。
  if (understood.length === 0 && gaps.length === 0 && fixes.length === 0) return null;

  return { understood, gaps, fixes, summary };
}

/**
 * 剥掉 knowledge 里的 checkup（体检吃自己上一次的结论会形成自我强化回路，见 runCompanyCheckup 注释）。
 * 纯函数，不改入参；非法入参原样返回。
 */
function stripCheckup(knowledge) {
  if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) return knowledge;
  if (!('checkup' in knowledge)) return knowledge;
  return { ...knowledge, checkup: null };
}

/** 把体检输入（用户填写资料 + 联网结果）拼成 prompt 里的「已知信息」段。 */
function knownInfoText(p) {
  const lines = [];
  const name = asStr(p.companyName);
  if (name) lines.push(`企业名称：${name}`);
  const typeLabel = asStr(p.companyTypeLabel) || asStr(p.companyType);
  if (typeLabel) lines.push(`企业类型：${typeLabel}`);

  const f = p.fields && typeof p.fields === 'object' ? p.fields : {};
  const pairs = [
    ['行业', f.industry || f.clinicType],
    ['一句话介绍', f.intro || f.summary],
    ['核心产品', f.products || f.coreProjects],
    ['目标客户', f.targetCustomers],
    ['品牌定位', f.brandPositioning],
  ];
  for (const [label, v] of pairs) {
    const s = asStr(v);
    if (s) lines.push(`${label}（用户填写）：${s}`);
  }
  const tp = asStr(p.topPriority);
  if (tp) lines.push(`用户当前最想推动的事（用户选择）：${tp}`);

  const web = asStr(p.webSummary);
  lines.push(web ? `联网检索到的公开信息（若你无法联网，此处可能并不可信，请以「未联网核实」说明）：${web}` : '联网检索到的公开信息：暂无（未联网 / 检索失败 / 公开信息较少）');

  return lines.join('\n');
}

/** 把维度清单拼成编号列表，供 prompt 使用。 */
function dimensionsText() {
  return CHECKUP_DIMENSIONS.map((d, i) => `${i + 1}. ${d}`).join('\n');
}

/**
 * 跑一次企业体检：全方位理解 + 短板 + 整改。
 *
 * @param {object} [p]
 * @param {object} [p.currentCompany] 企业对象（用于统一 AI 上下文）
 * @param {string} [p.companyId] 企业 id（用于把体检结论落库到独立 key；缺省时回退 currentCompany.id）
 * @param {object} [p.asset] 企业营销资产
 * @param {object} [p.knowledge] getKnowledge(companyId) 返回值
 * @param {string} [p.role] 默认 'admin'
 * @param {string} [p.companyName] 企业名称（必填；缺失直接失败，不浪费一次 AI 调用）
 * @param {string} [p.companyType] 'manufacturer' | 'clinic' | 'doctor' | 'platform'
 * @param {string} [p.companyTypeLabel] 企业类型中文（仅用于 prompt 可读性）
 * @param {object} [p.fields] 首登第 3 步填写的基础资料
 * @param {string} [p.topPriority] 首登第 3 步选择的「当前最想推动什么」
 * @param {string} [p.webSummary] 联网检索到的公开信息摘要
 * @param {object} [opts] { chatFn, temperature }（chatFn 可注入，单测靠它）
 * @returns {Promise<{ok:true, checkup:object, saved:boolean, companyId:string}|{ok:false, error:string}>}
 *   成功时会顺带把结论写入独立 key `douya-company-checkup`（数据隔离，见 checkupBrief.js）；
 *   saved 表示落库是否成功 —— **落库失败仍算 ok:true**，不影响本次展示。
 */
export async function runCompanyCheckup(p = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const companyName = asStr(p.companyName) || asStr(p.currentCompany && p.currentCompany.name);
  if (!companyName) return { ok: false, error: '缺少企业名称，无法体检' };

  const ctx = buildAIContext({
    company: p.currentCompany,
    asset: p.asset,
    // 关键：体检自己**不吃上一次的体检结论**（剥掉 knowledge.checkup）。
    // 否则「重新体检」会把上一轮的短板当既成判断复述回来，形成自我强化回路，越查越像。
    // 结论只向外输出（给后续规划/文案等调用用），不回流给自己。
    knowledge: stripCheckup(p.knowledge),
    role: p.role || 'admin',
  });

  const prompt = [
    '你是口腔行业经营顾问。用户刚注册完企业，你要先证明「你真的了解了这家企业」，再指出问题。',
    '请基于下面【已知信息】里的内容，产出一份企业体检报告。',
    '',
    '【已知信息】',
    knownInfoText({ ...p, companyName }),
    '',
    '【第一步：全方位了解】',
    '逐个判断下面每个维度，写进 understood 数组（label 用维度名，value 是你的判断）：',
    dimensionsText(),
    '判断不了的维度，value 就写「缺少 X 信息」（X 写具体缺什么），不要猜。',
    '每条的 from 标注这条判断的来源，只能取这三值之一：',
    '  user = 来自用户填写的资料；web = 来自联网检索结果（若你无法联网，则不要用 web 标注，改用 ai）；ai = 你基于行业规律的推断。',
    '',
    '【第二步：指出短板】',
    '写进 gaps 数组，3-5 条。只写真正影响经营的短板，每条必须有依据（why）。',
    '宁可少写、也不要凑数；确实看不出短板时，gaps 给空数组。',
    '',
    '【第三步：怎么整改】',
    '写进 fixes 数组，针对上面每条短板给一个可执行动作（gap 写对应的短板标题，action 写具体做什么）。',
    '',
    '【第四步：一句话总评】',
    'summary 用一句话说清「这家企业现在最该被解决的一件事」。',
    '',
    '【输出 JSON 结构】',
    '{',
    '  "understood": [ { "label": "维度名", "value": "你的判断", "from": "user|web|ai" } ],',
    '  "gaps": [ { "title": "短板标题", "why": "依据" } ],',
    '  "fixes": [ { "gap": "对应的短板标题", "action": "具体动作" } ],',
    '  "summary": "一句话总评"',
    '}',
    CHECKUP_RULE,
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

  const checkup = normalizeCheckup(parsed);
  if (!checkup) {
    return { ok: false, error: 'AI 未返回有效体检内容' };
  }

  // 落库：写入独立 key `douya-company-checkup`（按 companyId 分桶，与四类企业知识完全隔离）。
  // 原则：**持久化失败不影响本次结果** —— 报告先给用户看，存下来只是为了让「下次 AI 还记得短板」。
  // 无 companyId（未建企业）或无 localStorage（node 单测）时静默跳过，绝不因此把体检判失败。
  const companyId = asStr(p.companyId)
    || asStr(p.currentCompany && p.currentCompany.id)
    || asStr(p.company && p.company.id);
  let saved = null;
  if (companyId) {
    try {
      saved = saveCheckup(companyId, checkup, { companyName });
    } catch {
      saved = null;
    }
  }

  return { ok: true, checkup, saved: !!saved, companyId: companyId || '' };
}

export default {
  CHECKUP_RULE,
  CHECKUP_DIMENSIONS,
  CHECKUP_FROM_VALUES,
  CHECKUP_FROM_DEFAULT,
  MAX_UNDERSTOOD,
  MAX_GAPS,
  MAX_FIXES,
  normalizeCheckup,
  runCompanyCheckup,
};
