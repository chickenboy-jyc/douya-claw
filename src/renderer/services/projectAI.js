/**
 * projectAI —— 营销项目 / 任务的 AI 结构化调用编排层。
 *
 * 所有「AI 辅助建项目 / 一句话建任务 / AI 执行任务 / Project 助手 / 今日建议」的结构化补全
 * 统一走这里：上下文一律经 buildAIContext 组装，请求走 chatOnce（非流式 /api/chat-once）。
 * 组件禁止自行 fetch /api/chat-once 或散写业务 Prompt。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { TASK_TYPES } from './capabilityResolver.js';

/**
 * 从模型输出中稳健提取第一个 JSON 对象/数组（容忍 markdown 代码围栏与前后噪音）。
 * @param {string} text
 * @returns {object|Array|null}
 */
export function extractJSON(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const noFence = s.replace(/^```[a-zA-Z]*\s*/gm, '').replace(/```\s*$/gm, '');
  const opens = [noFence.indexOf('{'), noFence.indexOf('[')].filter((i) => i >= 0);
  if (opens.length === 0) return null;
  const start = Math.min(...opens);
  const open = noFence[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < noFence.length; i++) {
    const ch = noFence[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(noFence.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 归一化优先级。 */
function normPriority(v) {
  return ['low', 'medium', 'high', 'urgent'].includes(v) ? v : 'medium';
}

/**
 * AI 辅助建项目：根据项目类型起草一份方案草稿。
 * 失败返回 null（由调用方降级为纯手填，不阻塞建项目）。
 * @returns {Promise<{name,goalId,audience,product,period,budget,channels,kpi}|null>}
 */
export async function buildProjectDraftSuggestion({ companyType, company, asset, knowledge, projectType, goalLabel } = {}) {
  const pt = projectType || {};
  const ctx = buildAIContext({
    company,
    asset,
    knowledge,
    project: { type: pt.key || '', name: '', goalId: pt.goalId || null },
    goalLabel: goalLabel || '',
  });
  const messages = [
    {
      role: 'user',
      content: [
        '请帮我为一个营销项目起草一份方案草稿，项目类型为「' + (pt.label || pt.key || '') + '」（说明：' + (pt.desc || '') + '）。',
        '请只返回一个 JSON 对象（不要输出任何解释、markdown 或代码围栏），字段如下：',
        '{ "name": "项目名称", "goalId": "营销目标ID(可留空字符串)", "audience": "目标人群", "product": "核心产品", "period": "项目周期", "budget": "预算", "channels": ["渠道1","渠道2"], "kpi": "KPI" }',
        '要求：name 简洁具体；channels 为字符串数组；其余字段为字符串。信息不足时合理推断，但不要编造医疗疗效与数据。',
      ].join('\n'),
    },
  ];
  const res = await chatOnce(messages, ctx, { temperature: 0.4 });
  if (!res || res.ok !== true || !res.content) return null;
  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return {
    name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    goalId: typeof parsed.goalId === 'string' && parsed.goalId.trim() ? parsed.goalId.trim() : (pt.goalId || null),
    audience: typeof parsed.audience === 'string' ? parsed.audience : '',
    product: typeof parsed.product === 'string' ? parsed.product : '',
    period: typeof parsed.period === 'string' ? parsed.period : '',
    budget: typeof parsed.budget === 'string' ? parsed.budget : '',
    channels: Array.isArray(parsed.channels) ? parsed.channels.map((x) => String(x).trim()).filter(Boolean) : [],
    kpi: typeof parsed.kpi === 'string' ? parsed.kpi : '',
  };
}

/**
 * 一句话建任务：把一句话解析为 { title, taskType, description, priority }。
 * 失败返回 null（调用方降级为按原话手填建任务）。
 */
export async function parseTaskFromText(text, { company, project, asset, knowledge, goalLabel } = {}) {
  const s = String(text || '').trim();
  if (!s) return null;
  const ctx = buildAIContext({ company, asset, knowledge, project, goalLabel });
  const messages = [
    {
      role: 'user',
      content: [
        '用户用一句话描述了一个运营任务：' + s,
        '请把它解析成一个 JSON 对象（只返回 JSON，不要解释、不要 markdown 围栏）：',
        '{ "title": "任务标题", "taskType": "任务类型", "description": "任务描述", "priority": "优先级" }',
        '其中 taskType 必须从以下枚举中选择最贴切的一个：' + Object.keys(TASK_TYPES).join('、') + '。',
        'priority 只能取 low / medium / high / urgent 之一，默认 medium。',
        'title 要简洁（15 字内）；description 说明要做什么、给谁看、什么形式。',
      ].join('\n'),
    },
  ];
  const res = await chatOnce(messages, ctx, { temperature: 0.3 });
  if (!res || res.ok !== true || !res.content) return null;
  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const tt = String(parsed.taskType || '').trim();
  return {
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : s.slice(0, 30),
    taskType: TASK_TYPES[tt] ? tt : 'other',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    priority: normPriority(parsed.priority),
  };
}

/**
 * 任务执行已统一迁移到 services/taskExecutor.js（executeTask，走统一能力层）。
 * 本文件只保留「助手 / 草稿」类结构化调用：AI 辅助建项目、一句话建任务、助手问答、任务清单、今日建议。
 * 如需「AI 执行任务」，请 import { executeTask } from './taskExecutor.js'。
 */

/**
 * Project 上下文问答（AI 助手）。
 * @returns {Promise<{ok,content,error}>}
 */
export async function askProjectAssistant(question, { company, project, asset, knowledge, goalLabel } = {}) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, content: '', error: '问题不能为空' };
  const ctx = buildAIContext({ company, asset, knowledge, project, goalLabel });
  const messages = [
    {
      role: 'user',
      content: '你是一个营销项目助手。请基于当前项目上下文回答用户问题，信息不足时明确说明，不要编造。\n\n用户问题：' + q,
    },
  ];
  const res = await chatOnce(messages, ctx, { temperature: 0.5 });
  if (!res || res.ok !== true) return { ok: false, content: '', error: (res && res.error) || 'AI 助手调用失败' };
  return { ok: true, content: res.content, error: '' };
}

/**
 * 生成项目任务清单（AI 助手「生成任务列表」用）。
 * @returns {Promise<Array<{title,taskType,description,priority}>|null>}
 */
export async function generateProjectTasks({ company, project, asset, knowledge, goalLabel, hint } = {}) {
  const ctx = buildAIContext({ company, asset, knowledge, project, goalLabel });
  const messages = [
    {
      role: 'user',
      content: [
        '请基于当前项目，规划一个可执行的任务清单（3-8 个任务）。',
        (hint ? '用户补充要求：' + hint : ''),
        '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
        '{ "tasks": [ { "title": "任务标题", "taskType": "任务类型", "description": "任务描述", "priority": "优先级" } ] }',
        'taskType 从以下枚举选择：' + Object.keys(TASK_TYPES).join('、') + '；priority 取 low/medium/high/urgent 之一。',
      ].filter(Boolean).join('\n'),
    },
  ];
  const res = await chatOnce(messages, ctx, { temperature: 0.4 });
  if (!res || res.ok !== true || !res.content) return null;
  const parsed = extractJSON(res.content);
  const arr = parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null;
  if (!arr) return null;
  return arr
    .map((it) => ({
      title: typeof it.title === 'string' ? it.title.trim() : '',
      taskType: typeof it.taskType === 'string' && TASK_TYPES[it.taskType] ? it.taskType : 'other',
      description: typeof it.description === 'string' ? it.description : '',
      priority: normPriority(it.priority),
    }))
    .filter((it) => it.title);
}

/**
 * 生成「今日运营建议」（≤3 条，按需生成，缓存由调用方处理）。
 * @returns {Promise<{items:Array<{type,title,desc,reason}>,generatedAt:number}|null>}
 */
export async function generateTodaySuggestions({ company, project, asset, knowledge, goalLabel } = {}) {
  const ctx = buildAIContext({ company, asset, knowledge, project, goalLabel });
  const messages = [
    {
      role: 'user',
      content: [
        '请为「今日运营」生成不超过 3 条可执行的运营建议，围绕当前企业/项目。',
        '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
        '{ "items": [ { "type": "建议类型(如 content/geo/media/activity/其他)", "title": "建议标题", "desc": "具体怎么做", "reason": "为什么建议" } ] }',
        '要求：items 最多 3 条；每条 title 简短、desc 可执行、reason 说明依据；紧密结合当前项目与目标；不得编造医疗疗效或数据。',
      ].join('\n'),
    },
  ];
  const res = await chatOnce(messages, ctx, { temperature: 0.5 });
  if (!res || res.ok !== true || !res.content) return null;
  const parsed = extractJSON(res.content);
  const items = (parsed && Array.isArray(parsed.items) ? parsed.items : [])
    .slice(0, 3)
    .map((it) => ({
      type: typeof it.type === 'string' ? it.type : 'other',
      title: typeof it.title === 'string' ? it.title.trim() : '',
      desc: typeof it.desc === 'string' ? it.desc : '',
      reason: typeof it.reason === 'string' ? it.reason : '',
    }))
    .filter((it) => it.title);
  if (items.length === 0) return null;
  return { items, generatedAt: Date.now() };
}

export default {
  buildProjectDraftSuggestion,
  parseTaskFromText,
  askProjectAssistant,
  generateProjectTasks,
  generateTodaySuggestions,
  extractJSON,
};
