/**
 * smartToday —— 「今日运营 · AI 智能驾驶舱」智能行动清单生成（替代旧「今日建议 / 今日计划」点选式交互）。
 *
 * AI 直接基于企业画像（行业 / 产品 / 卖点 / 目标客户 / 竞品 / 营销目标）给出「今天该做什么」，
 * 用户只确认、不填表。两种模式由 hasProject / hasTasks 决定：
 *  - 空态（无项目或无任务）：输出企业现状总结 + 建议项目 suggestProject + 第一步任务 firstTasks
 *  - 非空态（有项目且有任务）：输出今日聚焦总结 + 今日行动 actions（4-6 条）
 *
 * 均走 chatOnce + buildAIContext 注入企业/项目上下文；失败返回 null（调用方降级）。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
import { TASK_TYPES } from './capabilityResolver.js';

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

function normPriority(v) {
  return PRIORITIES.includes(v) ? v : 'medium';
}

function normTaskType(v) {
  const t = String(v || '').trim();
  return TASK_TYPES[t] ? t : 'content';
}

function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** reason 必须从企业画像推导的硬性约束（用户特别强调，禁止空泛理由）。 */
const REASON_RULE = [
  '每条「reason（为什么做）」必须从当前企业画像中推导，明确引用具体信息（行业、产品、核心卖点、目标客户、竞品、当前营销目标），',
  '例如「口腔厂家主打种植体，目标客户是民营门诊，竞品正主推数字化方案，所以今天应……」。',
  '禁止输出「因为要增长」「因为重要」「提升品牌」等空泛理由；信息不足时写明「企业画像中缺少 X 信息」。',
].join('');

/**
 * 生成「今日运营」智能行动清单。
 * @param {object} params {
 *   company, project, asset, knowledge, goalLabel, companyType, role, hasProject, hasTasks
 * }
 * @returns {Promise<{mode:'empty'|'normal', summary:string, suggestProject?:object, firstTasks?:Array, actions?:Array, generatedAt:number}|null>}
 */
export async function generateSmartToday(params = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const ctx = buildAIContext({
    company: params.company,
    asset: params.asset,
    knowledge: params.knowledge,
    project: params.project,
    role: params.role || 'admin',
    goalLabel: params.goalLabel || '',
  });

  const goalNote = params.goalLabel ? `当前营销目标：${params.goalLabel}。` : '';
  const empty = !params.hasProject || !params.hasTasks;

  let prompt;
  if (empty) {
    prompt = [
      '你是「今日运营」智能驾驶舱。当前企业还没有可执行的项目/任务，请基于企业画像给出「第一步该做什么」。',
      goalNote,
      '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
      '{ "summary": "一段话总结该企业现状与当务之急", "suggestProject": { "name": "项目名", "type": "项目类型key(英文短key)", "goalId": "营销目标id(可空字符串)", "description": "项目目标", "audience": "目标人群", "product": "核心产品", "period": "周期" }, "firstTasks": [ { "title": "任务标题", "taskType": "任务类型", "priority": "优先级", "desc": "怎么做", "reason": "为什么做" } ] }',
      'taskType 从以下枚举选择：' + Object.keys(TASK_TYPES).join('、') + '；priority 取 low/medium/high/urgent 之一。',
      'firstTasks 给 3-6 条可执行的「第一步」任务；type 用简短英文 key（如 new_product / patient_acquisition 等）。',
      REASON_RULE,
      '不得编造医疗疗效、数据或案例。',
    ].join('\n');
  } else {
    prompt = [
      '你是「今日运营」智能驾驶舱。请基于企业画像 + 当前项目，生成「今天该做的行动清单」，用户只确认、不填表。',
      goalNote,
      '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
      '{ "summary": "一段话总结今天该聚焦什么", "actions": [ { "title": "行动标题", "taskType": "任务类型", "priority": "优先级", "desc": "怎么做", "reason": "为什么做" } ] }',
      'taskType 从以下枚举选择：' + Object.keys(TASK_TYPES).join('、') + '；priority 取 low/medium/high/urgent 之一。',
      'actions 输出 4-6 条，每条具体可执行。',
      REASON_RULE,
      '不得编造医疗疗效、数据或案例。',
    ].join('\n');
  }

  let res;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.5,
      reasoningEffort: 'none',
    });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return null;

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const summary = asStr(parsed.summary);

  if (empty) {
    const sp = parsed.suggestProject && typeof parsed.suggestProject === 'object' ? parsed.suggestProject : {};
    const firstTasks = (Array.isArray(parsed.firstTasks) ? parsed.firstTasks : [])
      .map((it) => ({
        title: asStr(it && it.title),
        taskType: normTaskType(it && it.taskType),
        priority: normPriority(it && it.priority),
        desc: asStr(it && it.desc),
        reason: asStr(it && it.reason),
      }))
      .filter((it) => it.title);

    if (!summary && !asStr(sp.name) && firstTasks.length === 0) return null;

    return {
      mode: 'empty',
      summary,
      suggestProject: {
        name: asStr(sp.name),
        type: asStr(sp.type),
        goalId: asStr(sp.goalId),
        description: asStr(sp.description),
        audience: asStr(sp.audience),
        product: asStr(sp.product),
        period: asStr(sp.period),
      },
      firstTasks,
      generatedAt: Date.now(),
    };
  }

  const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
    .map((it) => ({
      title: asStr(it && it.title),
      taskType: normTaskType(it && it.taskType),
      priority: normPriority(it && it.priority),
      desc: asStr(it && it.desc),
      reason: asStr(it && it.reason),
    }))
    .filter((it) => it.title);

  if (!summary && actions.length === 0) return null;

  return { mode: 'normal', summary, actions, generatedAt: Date.now() };
}

export default generateSmartToday;
