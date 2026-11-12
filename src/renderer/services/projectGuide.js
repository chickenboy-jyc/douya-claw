/**
 * projectGuide —— 项目概览「AI 统筹」服务。
 *
 * 用户痛点：项目概览只有一堆字段 + 一个「已完成 n/m」，看不出"现在卡在哪、下一步该干嘛"。
 * 这个服务让 AI 站在统筹视角，读企业画像 + 项目 + 任务清单，产出：
 *   - summary      一句话项目综述
 *   - progressRead 进度解读（卡在哪 / 为什么慢）
 *   - nextActions  接下来最该做的 3-5 件事（引用具体任务 + 为什么）
 *   - risks        风险/待补信息提示
 *
 * 硬约束（与 goalGuide.js 同口径）：reason/why 必须从企业画像与任务现状推导，禁空话、禁编造。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';

function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function normPriority(v) {
  const p = asStr(v).toLowerCase();
  if (p === 'high' || p === '高' || p === 'urgent' || p === '紧急') return 'high';
  if (p === 'low' || p === '低') return 'low';
  return 'mid';
}

const STATUS_LABEL = { todo: '待做', doing: '进行中', review: '待审核', done: '已完成' };

/** 把任务清单精简成给 AI 看的一行行文本（只保留 AI 需要的字段）。 */
function tasksText(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return '（当前项目还没有任何任务）';
  return list
    .map((t) => {
      const st = STATUS_LABEL[t.status] || t.status || '未知';
      return `- [${st}] ${t.title || '（无标题）'}（优先级：${t.priority || '未标'}）`;
    })
    .join('\n');
}

/** 给 AI 看的项目信息精简文本。 */
function projectText(p) {
  const proj = p.project || {};
  const lines = [];
  if (proj.name) lines.push(`项目名：${proj.name}`);
  if (proj.description) lines.push(`项目说明：${proj.description}`);
  if (p.goalLabel) lines.push(`营销目标：${p.goalLabel}`);
  if (proj.period) lines.push(`项目周期：${proj.period}`);
  if (proj.audience) lines.push(`目标人群：${proj.audience}`);
  if (proj.product) lines.push(`核心产品：${proj.product}`);
  if (proj.kpi) lines.push(`KPI：${proj.kpi}`);
  if (proj.status) lines.push(`项目状态：${proj.status}`);
  return lines.length ? lines.join('\n') : '（项目信息尚未填写完整）';
}

const REASON_RULE = [
  '每条「why / 为什么」必须从企业画像或任务现状里推导，明确引用具体信息（行业、产品、目标客户、当前任务卡在哪），',
  '禁止输出「因为重要」「为了增长」等空话；信息不足时写明「缺少 X 信息」。',
].join('');

const FACT_RULE = '禁止编造企业信息、数据、案例、疗效。画像里没有的一律不写，或标注「待补充」。';

/**
 * AI 项目统筹建议。
 *
 * @param {object} p { currentCompany, project, asset, knowledge, tasks, goalLabel, companyType, role }
 * @param {object} [opts] { chatFn, temperature }
 * @returns {Promise<{
 *   summary: string,
 *   progressRead: string,
 *   nextActions: Array<{title:string, why:string, priority:'high'|'mid'|'low'}>,
 *   risks: Array<{title:string, why:string}>
 * }|null>} 失败返回 null
 */
export async function genProjectGuidance(p = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const ctx = buildAIContext({
    company: p.currentCompany,
    asset: p.asset,
    knowledge: p.knowledge,
    project: p.project,
    role: p.role || 'admin',
    goalLabel: p.goalLabel || '',
  });

  const prompt = [
    '你是口腔行业项目经理，负责给这家企业当前的项目做「统筹」。',
    '请读下面的项目信息与任务清单，告诉用户：现在项目整体在干嘛、卡在哪、下一步最该做哪几件事、有什么风险。',
    '',
    `企业类型：${p.companyType || '未知'}。`,
    '【项目信息】',
    projectText(p),
    '',
    '【任务清单】',
    tasksText(p.tasks),
    '',
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "summary": "项目整体一句话综述", "progressRead": "进度解读（当前推进到哪、有没有卡点、为什么）", "nextActions": [ { "title": "下一步要做的事（能对应到具体任务就写具体任务）", "why": "为什么现在做它", "priority": "high/mid/low" } ], "risks": [ { "title": "风险或待补信息", "why": "为什么是风险" } ] }',
    'nextActions 给 3-5 条，按优先级从高到低排序；priority 只能是 high / mid / low。',
    'risks 给 0-3 条，没有就返回空数组。',
    '若项目还没有任务，progressRead 要直接点明"还没拆任务，先去建任务"，nextActions 里第一条就是"为项目拆解出首批任务"。',
    REASON_RULE,
    FACT_RULE,
  ].join('\n');

  let res;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
      reasoningEffort: 'none',
    });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return null;

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const nextActions = (Array.isArray(parsed.nextActions) ? parsed.nextActions : [])
    .map((it) => ({
      title: asStr(it && it.title),
      why: asStr(it && it.why),
      priority: normPriority(it && it.priority),
    }))
    .filter((it) => it.title)
    .slice(0, 5);

  const risks = (Array.isArray(parsed.risks) ? parsed.risks : [])
    .map((it) => ({ title: asStr(it && it.title), why: asStr(it && it.why) }))
    .filter((it) => it.title)
    .slice(0, 3);

  const summary = asStr(parsed.summary);
  const progressRead = asStr(parsed.progressRead);

  if (!summary && !progressRead && nextActions.length === 0) return null;

  return {
    summary: summary || '（AI 未给出综述）',
    progressRead: progressRead || '',
    nextActions,
    risks,
    generatedAt: Date.now(),
  };
}

export default { genProjectGuidance };
