/**
 * services/brainRefresh.js —— 企业大脑「AI 一键更新」。
 *
 * 解决的问题：企业大脑（facts / rules / memories）此前只能手动逐条添加，
 * 「做了很多事，大脑却一条都不会自己长」。本服务读取最近产出（Asset）+ 竞品调研 +
 * 企业画像 + 现有知识，让 AI 提炼「值得沉淀进企业大脑」的增量，并给出可勾选的写入清单。
 *
 * 真实性铁律（沿用 smartToday.REASON_RULE 语气）：
 *  - 每条提议必须能追溯到具体产出 / 事件的证据（evidence 字段），禁止编造；
 *  - 禁止「品牌影响力提升」这类无法验证的空话；写不出证据就不要提；
 *  - 已有 facts / rules / memories 全部喂进 prompt，让模型自己比对去重，同一事实不重复提。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';

const KINDS = ['fact', 'rule', 'memory'];
const ACTIONS = ['add', 'update', 'remove'];
const CONFIDENCE = ['high', 'mid', 'low'];
const MAX_PROPOSALS = 12;

/** 证据硬约束：与 smartToday 的 REASON_RULE 同一语气，禁止空话。 */
const EVIDENCE_RULE = [
  '每一条提议的 evidence 必须指向【最近产出】或【竞品/事件】里的具体内容（写明产出名称或结论要点），',
  '例如「来自产出《618种植活动方案》：主推人群为 35-55 岁缺牙患者，客单 8000-15000」。',
  '禁止输出「品牌影响力提升」「口碑变好」「效果显著」等无法验证的空话；',
  '找不到可追溯证据的条目一律不要提——宁可少提，也不许编造。',
].join('');

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
}

function arr(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function clip(v, n) {
  const s = asStr(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 把最近产出压成「编号 + 类型 + 名称 + 摘要」喂给模型（控制上下文长度）。 */
function packAssets(list, max) {
  return (Array.isArray(list) ? list : []).slice(0, max).map((a, i) => {
    const o = a && typeof a === 'object' ? a : {};
    const body = String(o.content == null ? '' : o.content).replace(/\s+/g, ' ').trim();
    return `${i + 1}. [${o.type || 'asset'}] 《${o.name || '未命名'}》${body ? '：' + clip(body, 300) : ''}`;
  }).join('\n');
}

function normKind(v) {
  const k = asStr(v).toLowerCase();
  return KINDS.includes(k) ? k : 'fact';
}

function normAction(v) {
  const a = asStr(v).toLowerCase();
  return ACTIONS.includes(a) ? a : 'add';
}

function normConfidence(v) {
  const c = asStr(v).toLowerCase();
  return CONFIDENCE.includes(c) ? c : 'mid';
}

/**
 * 让 AI 提炼「企业大脑该更新什么」。
 * @param {object} p {
 *   companyId, company, knowledge:{profile,facts,rules,memories}, asset,
 *   recentAssets:Array<Asset>, competitors:string[]|string
 * }
 * @param {object} [opts] { chatFn, temperature, signal, timeoutMs }
 * @returns {Promise<{summary:string, proposals:Array, gaps:string[], error?:string}|null>}
 */
export async function suggestKnowledgeUpdates(p = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const knowledge = p.knowledge && typeof p.knowledge === 'object' ? p.knowledge : {};
  const profile = knowledge.profile && typeof knowledge.profile === 'object' ? knowledge.profile : {};
  const facts = arr(knowledge.facts);
  const rules = arr(knowledge.rules);
  const memories = arr(knowledge.memories);

  const ctx = buildAIContext({
    company: p.company,
    asset: p.asset,
    knowledge,
    role: 'admin',
  });

  const cname = (p.company && p.company.name) || asStr(profile.companyName) || '当前企业';
  const recentAssets = Array.isArray(p.recentAssets) ? p.recentAssets : [];
  const competitors = Array.isArray(p.competitors) ? p.competitors.join('、') : asStr(p.competitors);

  if (recentAssets.length === 0 && facts.length + rules.length + memories.length === 0) {
    return { summary: '暂无可分析的产出与已有知识，先去做一次任务或上传资料吧。', proposals: [], gaps: ['企业画像（品牌定位 / 主营产品 / 目标人群）'] };
  }

  const prompt = [
    `你是「企业大脑」维护助手。请阅读【最近产出】与【现有企业大脑】，判断这段时间沉淀下了哪些值得长期记住的信息。`,
    `当前企业：${cname}${competitors ? `；已知竞品：${competitors}` : ''}`,
    '',
    `【企业画像】`,
    `品牌定位：${asStr(profile.brandPositioning) || '（未填写）'}`,
    `行业：${asStr(profile.industry) || '（未填写）'}`,
    `产品：${asStr(profile.products) || '（未填写）'}`,
    `企业简介：${clip(profile.summary, 300) || '（未填写）'}`,
    `核心卖点：${arr(profile.coreSellingPoints).join('、') || '（未填写）'}`,
    `目标客户：${arr(profile.targetCustomers).join('、') || '（未填写）'}`,
    '',
    `【现有企业大脑】（这些已经有了，不要重复提；只有发现错误、过时或需要更精确表达时才用 update/remove）`,
    `- 企业事实 facts：\n${facts.length ? facts.map((x, i) => `  ${i + 1}. ${clip(x, 200)}`).join('\n') : '  （空）'}`,
    `- 品牌规则 rules：\n${rules.length ? rules.map((x, i) => `  ${i + 1}. ${clip(x, 200)}`).join('\n') : '  （空）'}`,
    `- 长期记忆 memories：\n${memories.length ? memories.map((x, i) => `  ${i + 1}. ${clip(x, 200)}`).join('\n') : '  （空）'}`,
    '',
    `【最近产出】（证据来源，编号引用）`,
    recentAssets.length ? packAssets(recentAssets, 30) : '（暂无产出）',
    '',
    `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
    `{ "summary": "一句话：这段时间我们做了什么、能沉淀什么", "proposals": [ { "kind": "fact|rule|memory", "action": "add|update|remove", "value": "新文本（remove 时填旧文本）", "oldValue": "action 为 update 时必填：被替换的旧文本", "evidence": "依据：来自哪次产出 / 哪个竞品调研 / 哪条活动结论", "confidence": "high|mid|low", "reason": "为什么值得进企业大脑" } ], "gaps": ["企业画像里还缺什么，建议去补"] }`,
    `最多输出 ${MAX_PROPOSALS} 条 proposals，按价值从高到低排序。`,
    `kind 取值：fact=可验证事实（做了什么、得出什么结论、客观信息）；rule=品牌规则/合规红线/内容禁区；memory=长期偏好、历史策略、重要决策。`,
    `proposal.value 必须是一条独立、可复用的短句（20-80 字），不要写成段落，不要带编号。`,
    EVIDENCE_RULE,
    `gaps 只写真正缺失且会影响 AI 输出质量的画像字段（如「目标人群」「核心卖点」），没有就返回空数组。`,
  ].join('\n');

  let res = null;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      reasoningEffort: 'none',
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(typeof opts.timeoutMs === 'number' ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return null;

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const seen = new Set();
  const proposals = (Array.isArray(parsed.proposals) ? parsed.proposals : [])
    .map((it) => {
      const o = it && typeof it === 'object' ? it : {};
      const kind = normKind(o.kind);
      const action = normAction(o.action);
      const value = asStr(o.value);
      const oldValue = asStr(o.oldValue);
      const evidence = asStr(o.evidence);
      return {
        kind,
        action,
        value,
        oldValue: action === 'update' ? oldValue : '',
        evidence,
        confidence: normConfidence(o.confidence),
        reason: asStr(o.reason),
      };
    })
    // 硬门槛：无证据 / 无内容 / update 缺 oldValue 的一律丢弃，绝不进 UI
    .filter((x) => x.value && x.evidence && (x.action !== 'update' || x.oldValue))
    .filter((x) => {
      const key = x.kind + '::' + (x.action === 'update' ? x.oldValue + '=>' + x.value : x.value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PROPOSALS);

  return {
    summary: asStr(parsed.summary),
    proposals,
    gaps: arr(parsed.gaps).slice(0, 6),
  };
}

/** kind → companyKnowledgeStore 的列表 key。 */
export function kindToListKey(kind) {
  if (kind === 'fact') return 'facts';
  if (kind === 'rule') return 'rules';
  return 'memories';
}

export default { suggestKnowledgeUpdates, kindToListKey };
