/**
 * opsPlan —— 今日/月度运营计划 AI 一键生成（P0-6）。
 *
 * 从旧「≤3 条今日建议」升级为「完整运营计划」：
 * - generateTodayPlan：今日该做的 N 件事（含优先级 + 对应任务类型）。
 * - generateMonthlyPlan：30 天逐日计划（每天 1-2 个关键动作，含优先级），不按周粗分。
 *
 * 两者均走 chatOnce + buildAIContext 注入企业/项目上下文；chatFn 可注入以便单元测试。
 * 没选目标时由调用方（TodayOps）先引导选目标，本服务只负责「给定目标下的计划生成」。
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

function buildCtx({ company, project, asset, knowledge, goalLabel }) {
  return buildAIContext({ company, asset, knowledge, project, goalLabel: goalLabel || '' });
}

/**
 * 生成「今日运营计划」：N 件今天该做的事，含优先级 + 任务类型 + 依据。
 * @returns {Promise<{items:Array<{title,taskType,priority,desc,reason}>,generatedAt:number}|null>}
 */
export async function generateTodayPlan(params = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const ctx = buildCtx(params);
  const goalNote = params.goalLabel ? `当前营销目标：${params.goalLabel}。` : '';
  const messages = [
    {
      role: 'user',
      content: [
        '请为「今日运营」生成一份完整的今日运营计划，围绕当前企业/项目。' + goalNote,
        '输出今天该做的 4-8 件事，每件都给出：具体动作、优先级、对应的任务类型、为什么做。',
        '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
        '{ "items": [ { "title": "事项标题", "taskType": "任务类型", "priority": "优先级", "desc": "具体怎么做", "reason": "为什么做" } ] }',
        'taskType 从以下枚举选择：' + Object.keys(TASK_TYPES).join('、') + '；priority 取 low/medium/high/urgent 之一。',
        '紧密结合当前项目与目标，不得编造医疗疗效或数据。',
      ].join('\n'),
    },
  ];
  let res;
  try {
    res = await chatFn(messages, ctx, { temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.5, reasoningEffort: 'none' });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return null;
  const parsed = extractJSON(res.content);
  const items = (parsed && Array.isArray(parsed.items) ? parsed.items : [])
    .map((it) => ({
      title: typeof it.title === 'string' ? it.title.trim() : '',
      taskType: normTaskType(it.taskType),
      priority: normPriority(it.priority),
      desc: typeof it.desc === 'string' ? it.desc : '',
      reason: typeof it.reason === 'string' ? it.reason : '',
    }))
    .filter((it) => it.title);
  if (items.length === 0) return null;
  return { items, generatedAt: Date.now() };
}

/**
 * 生成「月度运营计划」：30 天逐日计划，每天 1-2 个关键动作（含优先级）。
 * @returns {Promise<{days:Array<{day:number,title:string,priority:string,taskType:string,desc:string}>,generatedAt:number}|null>}
 * 注：为便于前端渲染与转任务，days 每项即「某天的一个关键动作」，同一天可能有多条（day 重复）。
 */
export async function generateMonthlyPlan(params = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const ctx = buildCtx(params);
  const goalNote = params.goalLabel ? `当前营销目标：${params.goalLabel}。` : '';
  const messages = [
    {
      role: 'user',
      content: [
        '请为「月度运营」生成 30 天逐日运营计划，围绕当前企业/项目。' + goalNote,
        '按天输出（第 1 天到第 30 天），每天 1-2 个关键动作；动作要具体、可执行，并给出优先级与任务类型。',
        '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
        '{ "days": [ { "day": 1, "title": "关键动作", "taskType": "任务类型", "priority": "优先级", "desc": "怎么做" } ] }',
        'taskType 从以下枚举选择：' + Object.keys(TASK_TYPES).join('、') + '；priority 取 low/medium/high/urgent 之一。',
        'days 数组要覆盖 30 天（每天至少 1 条，可同一天多条）；不得编造医疗疗效或数据。',
      ].join('\n'),
    },
  ];
  let res;
  try {
    res = await chatFn(messages, ctx, { temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.5, reasoningEffort: 'none' });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return null;
  const parsed = extractJSON(res.content);
  const days = (parsed && Array.isArray(parsed.days) ? parsed.days : [])
    .map((d) => ({
      day: Number(d.day) || 1,
      title: typeof d.title === 'string' ? d.title.trim() : '',
      taskType: normTaskType(d.taskType),
      priority: normPriority(d.priority),
      desc: typeof d.desc === 'string' ? d.desc : '',
    }))
    .filter((d) => d.title)
    .sort((a, b) => a.day - b.day);
  if (days.length === 0) return null;
  return { days, generatedAt: Date.now() };
}

export default { generateTodayPlan, generateMonthlyPlan };
