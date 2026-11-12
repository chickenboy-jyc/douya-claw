/**
 * capabilities/real.js —— 真实能力（有后端接口或通用 AI 兜底，绝不伪造）。
 *
 * 统一契约：每个能力导出 makeCapability 产物，execute(task, ctx) → { ok, content, aiInput, aiProcess }。
 * ctx 为 buildAIContext 返回的丰富对象（含 asset/knowledge/company/profile/facts/rules/memory）。
 * 优先调用自建后端真实接口（geoProxy），失败/不适配时降级为本地 DeepSeek 通用补全（chatGenerate）。
 */

import { makeCapability, chatGenerate, extractText, geoProxy } from './base.js';
import { assetToAnalyzeInput, assetToRecommendPayload } from '../services/companyProfile.js';
import { offlinePrompt, onlinePrompt } from '../data/activityPrompts.js';
import { verifyPromoPlan } from '../services/promoFidelity.js';

// ---- 能力级 Prompt（Prompt 拆层第五段）----

const CONTENT_PROMPT =
  '请作为新媒体内容专家完成该任务：输出符合品牌调性的文案/脚本/内容，结构清晰、可直接发布或交付设计。';

const GEO_PROMPT =
  '请围绕 GEO（生成式引擎优化）策略完成该任务：结合企业/项目上下文，输出关键词策略、内容结构建议与可落地执行方案。';

const ACTIVITY_PROMPT =
  '请作为资深活动策划完成该任务：输出活动主题、Slogan、核心创意、流程、物料、预算、风险预案与 KPI，可实际落地，避免「领导讲话+抽奖」俗套。';

const MEDIA_PROMPT =
  '请围绕媒体传播完成该任务：分析目标人群，输出媒体分类、推荐媒体、投放建议与传播物料。';

const CRISIS_PROMPT =
  '请作为公关危机专家完成该任务：输出发现的问题、风险等级、来源、处置建议与回复话术，不得编造舆情事实。';

const RESEARCH_PROMPT =
  '请作为营销研究员完成该任务：结合上下文输出有据可查的调研分析，信息不足时明确说明，不得编造数据。';

const ANALYSIS_PROMPT =
  '请作为数据分析师完成该任务：输出结构化分析结论与可执行建议，区分事实与推测。';

const CHAT_PROMPT =
  '请以专业营销运营顾问的身份完成该任务，输出可直接使用的完整结果。';

// ---- 文案：wrap /api/wenan/generate ----

function inferWenanType(task) {
  const tt = (task && task.taskType) || '';
  return tt === 'social' ? 'xinmeiti' : 'custom';
}

function buildContentExtra(task, ctx) {
  const parts = [];
  if (task.description) parts.push('任务要求：' + task.description);
  if (task.requirements) parts.push('补充要求：' + task.requirements);
  if (ctx && ctx.companyContext) parts.push(ctx.companyContext);
  return parts.filter(Boolean).join('\n\n');
}

async function contentExecute(task, ctx) {
  const topic = (task && task.title) || '营销内容';
  const extra = buildContentExtra(task, ctx);
  try {
    const r = await geoProxy('/api/wenan/generate', 'POST', {
      type: inferWenanType(task),
      style: 'marketing',
      topic,
      extra,
      online: false,
      personas: [],
      platforms: [],
    });
    const content = extractText(r);
    if (r && r.ok && content) {
      return { ok: true, content, aiInput: `POST /api/wenan/generate { type, style, topic, extra }`, aiProcess: '已调用自建后端文案接口（/api/wenan/generate）生成。' };
    }
  } catch {
    /* 降级通用补全 */
  }
  return chatGenerate(task, ctx, CONTENT_PROMPT);
}

// ---- GEO：按任务意图分发到 company-analyze / brand-tone / strategy / material-insight ----

export function resolveGeoSubAction(task) {
  const text = String((task && (task.title + ' ' + (task.description || ''))) || '');
  if (/调性|品牌定位|brand.?tone/i.test(text)) return 'brand_tone';
  if (/素材|洞察|material/i.test(text)) return 'material_insight';
  if (/策略|战略|GEO|生成式|内容规划/i.test(text)) return 'geo_strategy';
  if (/分析|诊断|画像|基础|摸底/i.test(text)) return 'company_analysis';
  return 'geo_strategy';
}

function geoPayload(subAction, ctx) {
  const a = (ctx && ctx.asset) || {};
  const name = String((ctx && ctx.company && ctx.company.name) || a.companyName || '').trim();
  const industry = String(a.industry || '').trim();
  const brandDesc = String(a.profile || '').trim();
  const goal = String((ctx && ctx.goalLabel) || '').trim();
  if (subAction === 'company_analysis') return assetToAnalyzeInput(a);
  if (subAction === 'brand_tone') return { company_name: name, industry, brand_desc: brandDesc };
  if (subAction === 'material_insight') return { company_name: name, industry, brand_desc: brandDesc, goal };
  // geo_strategy
  return { company_name: name, industry, brand_desc: brandDesc, goal };
}

const GEO_ENDPOINT = {
  company_analysis: '/api/geo/company-analyze',
  brand_tone: '/api/geo/brand-tone',
  geo_strategy: '/api/geo/strategy',
  material_insight: '/api/geo/material-insight',
};

const GEO_ACTION_LABEL = {
  company_analysis: '企业 GEO 基础分析',
  brand_tone: '品牌调性分析',
  geo_strategy: 'GEO 策略',
  material_insight: '素材洞察',
};

async function geoExecute(task, ctx) {
  const subAction = resolveGeoSubAction(task);
  const endpoint = GEO_ENDPOINT[subAction];
  try {
    const r = await geoProxy(endpoint, 'POST', geoPayload(subAction, ctx));
    const text = typeof r === 'string' ? r : JSON.stringify(r && (r.analysis || r.data || r.result || r), null, 2);
    if (r && r.ok && text && text.trim() && text.trim() !== '{}') {
      return {
        ok: true,
        content: text,
        aiInput: `POST ${endpoint} ${JSON.stringify(geoPayload(subAction, ctx))}`,
        aiProcess: `已调用自建后端 GEO 接口（${endpoint}，${GEO_ACTION_LABEL[subAction]}）。`,
        subAction,
      };
    }
  } catch {
    /* 降级 */
  }
  const res = await chatGenerate(task, ctx, GEO_PROMPT);
  return { ...res, subAction };
}

// ---- 活动：chatOnce + 线下/线上/整合策略（原 activityPrompts 继续保留）----
//
// ★ 2026-10-11（第 5 层第 5 步 · 生成忠实性）：**活动方案生成之后**过一次事实校验。
//   起因：两次真生成实测，模型对档期名/日期/状态/重叠天数都忠实，但**有一次漏报了 1 对重叠**
//   ——「重叠是否列全」只是模型的自觉，不是产品的保证。而 `findOverlaps` 本就能确定性算全。
//   分工（老板明确）：模型负责组织和表达，**产品负责保证关键业务事实完整**。
//   规则（与 promoFidelity 的 verdict 一一对应）：
//     · 漏报重叠 ⇒ 交付物**补上**由真源计算的「同期活动核对」段（不完整结果不再被当完整方案交付）；
//     · 与已录入档期冲突（日期错）⇒ 附加标注段，要求人工/重新生成，**不修改模型原文**；
//     · 事实一致、无问题 ⇒ 交付物**逐字不变**（零侵入：改前改后同一份内容）。
//   ⚠️ 不引入第二份事实来源：records 取 `ctx.knowledge.promos`（= `loadPromoRecords(cid)`，
//      与注入给模型的那份**同一来源**），所以"拿来核对的事实"不可能与"喂给模型的事实"分叉。

async function activityExecute(task, ctx) {
  const text = String((task && (task.title + ' ' + (task.description || ''))) || '');
  const strategy =
    /线上|直播|裂变/.test(text) ? '线上' :
    /线下|展会|发布会|沙龙|义诊|招商会/.test(text) ? '线下' : '整合（线下体验+线上传播）';
  const guide = strategy === '线上' ? onlinePrompt : strategy === '线下' ? offlinePrompt : offlinePrompt + '\n\n' + onlinePrompt;
  const instruction = `${ACTIVITY_PROMPT}\n\n本次活动形式：${strategy}。\n\n【生成指引（活动策划框架）】\n${guide}`;
  const res = await chatGenerate(task, ctx, instruction);
  if (!res || res.ok !== true) return { ...res, aiProcess: `已按「${strategy}」活动策略生成活动方案（生成失败，未做事实核对）。` };

  const fp = verifyPromoPlan({
    output: res.content,
    records: ctx && ctx.knowledge ? ctx.knowledge.promos : null,
  });
  // 零侵入：只有在"补全/标注"真的发生时才动正文与 aiProcess（无事时逐字与改造前一致）。
  let content = String(res.content || '');
  if (fp.patch) content = content + '\n\n' + fp.patch;
  if (fp.notice) content = content + '\n\n' + fp.notice;
  const changed = !!fp.patch || !!fp.notice;
  return {
    ...res,
    content,
    aiProcess:
      `已按「${strategy}」活动策略生成活动方案。` + (changed ? fp.audit : ''),
    fidelity: { verdict: fp.verdict, issueCount: fp.issues.length },
  };
}

// ---- 媒体：media-recommend + 本地媒体库 ----

async function mediaExecute(task, ctx) {
  try {
    const payload = assetToRecommendPayload((ctx && ctx.asset) || {}, ctx && ctx.goalLabel ? ctx.goalLabel : '', (ctx && ctx.company && ctx.company.name) || '');
    const r = await geoProxy('/api/geo/media-recommend', 'POST', payload);
    const text = typeof r === 'string' ? r : JSON.stringify(r && (r.recommendation || r.media || r.data || r.result || r), null, 2);
    if (r && r.ok && text && text.trim() && text.trim() !== '{}') {
      return {
        ok: true,
        content: text,
        aiInput: `POST /api/geo/media-recommend ${JSON.stringify(payload)}`,
        aiProcess: '已调用自建后端媒体推荐接口（/api/geo/media-recommend）并匹配本地媒体库。',
      };
    }
  } catch {
    /* 降级 */
  }
  return chatGenerate(task, ctx, MEDIA_PROMPT);
}

// ---- 危机：crisis/scan + 报告 ----

async function crisisExecute(task, ctx) {
  const a = (ctx && ctx.asset) || {};
  const name = String((ctx && ctx.company && ctx.company.name) || a.companyName || '').trim();
  const kws = [
    name,
    ...(Array.isArray(a.coreSellingPoints) ? a.coreSellingPoints : []),
    ...(Array.isArray(a.brandFacts) ? a.brandFacts.slice(0, 3) : []),
  ].map((s) => String(s || '').trim()).filter(Boolean);
  const uniqueKws = Array.from(new Set(kws)).slice(0, 30);
  let scanned = null;
  try {
    const r = await geoProxy('/api/crisis/scan', 'POST', { keywords: uniqueKws, platforms: ['抖音', '小红书', '公众号', '百度贴吧'] });
    if (r && r.ok) scanned = r;
  } catch {
    scanned = null;
  }
  if (scanned) {
    const raw = JSON.stringify(scanned, null, 2);
    const instruction =
      '根据以下舆情扫描结果，生成一份危机舆情报告（Markdown），包含：发现的问题、风险等级、来源、处置建议、回复建议。不得编造扫描结果之外的内容。\n\n【扫描结果】\n' +
      raw.slice(0, 6000);
    const res = await chatGenerate(task, ctx, instruction);
    return { ...res, aiProcess: '已调用自建后端危机扫描接口（/api/crisis/scan）并生成舆情报告。' };
  }
  return chatGenerate(task, ctx, CRISIS_PROMPT);
}

// ---- 注册真实能力 ----

export const contentCapability = makeCapability({
  id: 'content',
  name: '文案创作',
  description: '文案 / 脚本 / 社媒内容生成，包装 /api/wenan/generate。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['content', 'social', 'project_marketing', 'design'],
  assetType: 'copy',
  buildPrompt: () => CONTENT_PROMPT,
  execute: contentExecute,
});

export const geoCapability = makeCapability({
  id: 'geo',
  name: 'GEO 策略',
  description: '企业 GEO 基础分析 / 品牌调性 / 内容策略 / 素材洞察。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['geo'],
  assetType: 'document',
  buildPrompt: () => GEO_PROMPT,
  execute: geoExecute,
});

export const activityCapability = makeCapability({
  id: 'activity',
  name: '活动策划',
  description: '活动主题 / 流程 / 物料 / 预算 / 风险预案，支持线下 / 线上 / 整合策略。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['activity'],
  assetType: 'event_plan',
  buildPrompt: () => ACTIVITY_PROMPT,
  execute: activityExecute,
});

export const mediaCapability = makeCapability({
  id: 'media',
  name: '媒体传播',
  description: '媒体推荐 / 投放建议 / 传播物料，包装 media-recommend。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['media'],
  assetType: 'media_plan',
  buildPrompt: () => MEDIA_PROMPT,
  execute: mediaExecute,
});

export const crisisCapability = makeCapability({
  id: 'crisis',
  name: '危机公关',
  description: '舆情扫描与应对，包装 /api/crisis/scan，输出风险等级 / 建议 / 回复话术。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['crisis'],
  assetType: 'crisis_report',
  buildPrompt: () => CRISIS_PROMPT,
  execute: crisisExecute,
});

export const researchCapability = makeCapability({
  id: 'research',
  name: '调研分析',
  description: '营销调研与行业研究（通用 AI）。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['research'],
  assetType: 'document',
  buildPrompt: () => RESEARCH_PROMPT,
  execute: (task, ctx) => chatGenerate(task, ctx, RESEARCH_PROMPT),
});

export const analysisCapability = makeCapability({
  id: 'analysis',
  name: '数据分析',
  description: '数据解读与结构化分析（通用 AI）。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['analysis'],
  assetType: 'document',
  buildPrompt: () => ANALYSIS_PROMPT,
  execute: (task, ctx) => chatGenerate(task, ctx, ANALYSIS_PROMPT),
});

export const chatCapability = makeCapability({
  id: 'chat',
  name: '通用 AI',
  description: '通用营销顾问（兜底能力）。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['other'],
  assetType: null,
  buildPrompt: () => CHAT_PROMPT,
  execute: (task, ctx) => chatGenerate(task, ctx, CHAT_PROMPT),
});

export const REAL_CAPABILITIES = [
  contentCapability,
  geoCapability,
  activityCapability,
  mediaCapability,
  crisisCapability,
  researchCapability,
  analysisCapability,
  chatCapability,
];
