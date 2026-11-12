/**
 * capabilities/base.js —— Capability 标准接口基座 + 通用 AI 补全兜底。
 *
 * 阶段四核心约定：所有 AI 能力统一走「标准接口」注册，Task 执行器（taskExecutor）只认这个接口，
 * 不再让每个业务模块各自决定 AI 怎么调。
 *
 * Capability 标准接口（见 makeCapability）：
 *   {
 *     id,                    // 能力唯一 id
 *     name,                  // 中文名
 *     description,           // 描述
 *     supportedCompanyTypes, // ['manufacturer'] | ['clinic'] | 两者
 *     taskTypes,             // 该能力承接的 task_type 列表（唯一事实源反向映射依据）
 *     status,                // 'ready' | 'building'（building = 建设中，禁止伪造结果）
 *     assetType,             // 成功后默认落库的资产 type（null = 不自动落库）
 *     buildPrompt(task, ctx),// 返回「能力级 Prompt」片段（Prompt 拆层第五段）
 *     execute(task, ctx),    // async → { ok, content, aiInput, aiProcess, subAction?, enrichment? }
 *     validate(content),     // → { ok, error? }
 *   }
 *
 * execute 统一返回：{ ok, content, aiInput, aiProcess }；失败 { ok:false, error, building? }。
 * 纯函数 + 无 React 依赖，方便单测（esbuild → CJS require）。
 */

import { chatOnce, geoProxy } from '../api.js';

/** 能力状态。 */
export const CAP_STATUS = { ready: 'ready', building: 'building' };

/** 归一化能力定义，补齐默认字段（保证接口稳定）。 */
export function makeCapability(def) {
  return {
    id: def.id,
    name: def.name || def.id,
    description: def.description || '',
    supportedCompanyTypes: Array.isArray(def.supportedCompanyTypes) ? def.supportedCompanyTypes : ['manufacturer', 'clinic'],
    taskTypes: Array.isArray(def.taskTypes) ? def.taskTypes : [],
    status: def.status === 'building' ? 'building' : 'ready',
    assetType: def.assetType || null,
    buildPrompt: def.buildPrompt || (() => ''),
    execute: def.execute || (async () => ({ ok: false, error: '该能力未实现', building: true })),
    validate: def.validate || (() => ({ ok: true })),
  };
}

/**
 * 通用 LLM 补全兜底：把「任务要求 + 能力指令」拼成单条用户消息走 chatOnce。
 * 供各真实能力在专用后端（wenan/media-recommend/crisis-scan…）不可用或不适配时降级。
 * 这是「真实 AI 调用」而非伪造：走本地 DeepSeek 通用补全。
 * @returns {Promise<{ok:boolean, content:string, aiInput:string, error?:string}>}
 */
export async function chatGenerate(task, ctx, instruction, opts = {}) {
  const t = task || {};
  const lines = [];
  if (t.title) lines.push('【任务】' + t.title);
  if (t.description) lines.push('【任务描述】' + t.description);
  if (t.goal) lines.push('【任务目标】' + t.goal);
  if (t.requirements) lines.push('【任务要求】' + t.requirements);
  if (t.outputFormat) lines.push('【输出格式】' + t.outputFormat);
  lines.push('【能力指令】' + (instruction || ''));
  lines.push('请直接输出最终交付内容（Markdown），不要复述任务本身，不要输出「好的/收到」等寒暄。');
  const aiInput = lines.join('\n');
  const res = await chatOnce([{ role: 'user', content: aiInput }], ctx || null, { temperature: 0.6, ...(opts || {}) });
  if (!res || res.ok !== true || !res.content) {
    return { ok: false, content: '', aiInput, error: (res && res.error) || 'AI 执行失败' };
  }
  return { ok: true, content: res.content, aiInput };
}

/** 兜底：能力建设中，禁止伪造结果。 */
export function buildingResult(name) {
  return { ok: false, building: true, error: `能力「${name}」正在建设中，暂未接入真实后端，不能生成结果` };
}

/** 从 wenan / 各类接口响应里稳健抽取文本内容。 */
export function extractText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.content || r.text || r.result || r.data || '').trim();
}

export { chatOnce, geoProxy };
