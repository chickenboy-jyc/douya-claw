/**
 * dailyOps —— 第六阶段「日常运营工作台」AI 生成服务。
 *
 * 统一复用 buildAIContext + chatOnce + extractJSON，不新建 Prompt 体系：
 * 上下文 = Company Context + Project Context（可选）+ Daily Context（日期/渠道/类型/要求）。
 *
 * 四个能力：
 * - genMomentsCopy    朋友圈（推荐时间 / 文案 / 配图建议 / 三版本）
 * - genCommunityCopy  社群文案（开场 / 主内容 / 提问 / 互动引导 / 收尾）
 * - genCommunityEvent 社群活动（活动前 / 当天 / 结束三阶段）
 * - genContentLayout  内容排版（标题 / 层级 / 加粗 / CTA / 图片位置 / 平台适配）
 *
 * 所有函数均注入合规约束（不编造病例/疗效/数据/用户评价），并在资料不足时要求明确提示。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
import { COMPLIANCE_RULE, companyTypeLabel } from '../data/dailyOpsCatalog.js';

/** 组装上下文 + 合规约束 + 用户补充要求，输出统一 { ctx, dailyNote }。 */
function buildCtx({ company, asset, knowledge, project, goalLabel, projectMaterials } = {}) {
  const ctx = buildAIContext({ company, asset, knowledge, project, goalLabel, projectMaterials });
  const cname = (company && company.name) || (asset && asset.companyName) || '当前企业';
  const ctype = (company && company.type) || 'manufacturer';
  const dailyNote = [
    `- 当前企业：${cname}（${companyTypeLabel(ctype)}）`,
    `- 今天日期：${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}`,
  ].join('\n');
  return { ctx, dailyNote, ctype };
}

/** 归一化字符串数组。 */
function arr(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

async function callLLM(messages, ctx, opts = {}) {
  let res;
  try {
    res = await chatOnce(messages, ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.6,
      reasoningEffort: 'none',
    });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return { __error: (res && res.error) || 'AI 返回为空' };
  const parsed = extractJSON(res.content);
  if (parsed) return parsed;
  // 兜底：未解析出 JSON 时，把原文塞进 content 字段
  return { __raw: res.content };
}

/**
 * 朋友圈文案生成。
 * @param {object} p { company, asset, knowledge, project, goalLabel, typeLabel, requirement }
 * @returns {Promise<{suggestTime,timeNote,content,imageSuggestions,versions}|null>}
 */
export async function genMomentsCopy(p = {}, opts = {}) {
  const { ctx, dailyNote, ctype } = buildCtx(p);
  const typeLabel = String(p.typeLabel || '日常经营');
  const requirement = String(p.requirement || '').trim();
  const reqLine = requirement ? `用户要求：${requirement}` : '用户要求：（未补充，请根据企业画像与类型自行创作）';
  const messages = [
    {
      role: 'user',
      content: [
        `你是资深口腔行业新媒体运营。请为「朋友圈」生成一条可发布的文案。`,
        `企业类型：${companyTypeLabel(ctype)}；内容类型：${typeLabel}。`,
        reqLine,
        `【今日运营上下文】\n${dailyNote}`,
        `【合规要求】${COMPLIANCE_RULE}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "suggestTime": "上午/下午/晚间 之一", "timeNote": "建议时间的说明（不得虚构平台数据，只能说建议）", "content": "完整朋友圈文案正文", "imageSuggestions": ["配图建议1", "配图建议2", "配图建议3"], "versions": [ { "style": "专业版", "content": "..." }, { "style": "亲和版", "content": "..." }, { "style": "销售版", "content": "..." } ] }`,
        `content 与 versions 三条文案都要完整、可直接复制发布；配图建议要贴合内容，不得虚构不存在的真实案例照片。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) return { suggestTime: '', timeNote: '', content: parsed.__raw, imageSuggestions: [], versions: [] };
  return {
    suggestTime: typeof parsed.suggestTime === 'string' ? parsed.suggestTime : '',
    timeNote: typeof parsed.timeNote === 'string' ? parsed.timeNote : '',
    content: typeof parsed.content === 'string' ? parsed.content : '',
    imageSuggestions: arr(parsed.imageSuggestions),
    versions: (Array.isArray(parsed.versions) ? parsed.versions : [])
      .map((v) => ({ style: String((v && v.style) || ''), content: String((v && v.content) || '') }))
      .filter((v) => v.content),
  };
}

/**
 * 社群文案生成（针对某个社群）。
 * @param {object} p { company, asset, knowledge, project, goalLabel, community, requirement }
 */
export async function genCommunityCopy(p = {}, opts = {}) {
  const { ctx, dailyNote, ctype } = buildCtx(p);
  const c = p.community || {};
  const cname = String(c.name || '当前社群');
  const cpos = String(c.positioning || '');
  const caud = String(c.audience || '');
  const requirement = String(p.requirement || '').trim();
  const reqLine = requirement ? `用户要求：${requirement}` : '用户要求：（未补充，请结合社群定位生成今日互动内容）';
  const messages = [
    {
      role: 'user',
      content: [
        `你是资深口腔行业社群运营。请为社群「${cname}」生成今日可用的互动内容。`,
        `企业类型：${companyTypeLabel(ctype)}；社群定位：${cpos || '（未填写）'}；目标人群：${caud || '（未填写）'}。`,
        reqLine,
        `【今日运营上下文】\n${dailyNote}`,
        `【合规要求】${COMPLIANCE_RULE}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "topic": "今日主题", "announcement": "群公告（可留空）", "opening": "开场话术", "mainContent": "科普/主内容", "question": "互动提问", "interaction": "互动引导话术", "closing": "收尾" }`,
        `各字段都要可直接复制发布；科普内容不得编造医学数据或疗效。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) return { topic: '', opening: parsed.__raw, mainContent: '', question: '', interaction: '', closing: '', announcement: '' };
  return {
    topic: typeof parsed.topic === 'string' ? parsed.topic : '',
    announcement: typeof parsed.announcement === 'string' ? parsed.announcement : '',
    opening: typeof parsed.opening === 'string' ? parsed.opening : '',
    mainContent: typeof parsed.mainContent === 'string' ? parsed.mainContent : '',
    question: typeof parsed.question === 'string' ? parsed.question : '',
    interaction: typeof parsed.interaction === 'string' ? parsed.interaction : '',
    closing: typeof parsed.closing === 'string' ? parsed.closing : '',
  };
}

/**
 * 社群活动文案生成（活动前 / 当天 / 结束三阶段）。
 * @param {object} p { company, asset, knowledge, project, goalLabel, community, eventName, eventTime }
 */
export async function genCommunityEvent(p = {}, opts = {}) {
  const { ctx, dailyNote, ctype } = buildCtx(p);
  const c = p.community || {};
  const cname = String(c.name || '当前社群');
  const eventName = String(p.eventName || '').trim() || '本次社群活动';
  const eventTime = String(p.eventTime || '').trim() || '（待定）';
  const messages = [
    {
      role: 'user',
      content: [
        `你是资深口腔行业活动运营。请为社群「${cname}」策划一场活动的完整运营文案。`,
        `企业类型：${companyTypeLabel(ctype)}；活动名称：${eventName}；活动时间：${eventTime}。`,
        `【今日运营上下文】\n${dailyNote}`,
        `【合规要求】${COMPLIANCE_RULE}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "before": { "poster": "预热海报文案", "announcement": "群公告", "invite": "私聊邀请话术", "moments": "朋友圈预热文案" }, "during": { "opening": "开场话术", "guest": "嘉宾介绍", "questions": ["互动问题1", "互动问题2"], "welfare": "抽奖/福利话术" }, "after": { "thanks": "感谢文案", "summary": "活动总结", "followup": "私聊跟进话术", "spread": "二次传播文案" } }`,
        `所有文案都要可直接复制使用，不得编造活动效果数据或虚构到场人数。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  const s = (o) => (o && typeof o === 'object' ? o : {});
  return {
    before: {
      poster: typeof s(parsed.before).poster === 'string' ? parsed.before.poster : '',
      announcement: typeof s(parsed.before).announcement === 'string' ? parsed.before.announcement : '',
      invite: typeof s(parsed.before).invite === 'string' ? parsed.before.invite : '',
      moments: typeof s(parsed.before).moments === 'string' ? parsed.before.moments : '',
    },
    during: {
      opening: typeof s(parsed.during).opening === 'string' ? parsed.during.opening : '',
      guest: typeof s(parsed.during).guest === 'string' ? parsed.during.guest : '',
      questions: arr(s(parsed.during).questions),
      welfare: typeof s(parsed.during).welfare === 'string' ? parsed.during.welfare : '',
    },
    after: {
      thanks: typeof s(parsed.after).thanks === 'string' ? parsed.after.thanks : '',
      summary: typeof s(parsed.after).summary === 'string' ? parsed.after.summary : '',
      followup: typeof s(parsed.after).followup === 'string' ? parsed.after.followup : '',
      spread: typeof s(parsed.after).spread === 'string' ? parsed.after.spread : '',
    },
  };
}

/**
 * 内容排版：把用户粘贴的长文结构化，并按平台适配。
 * @param {object} p { company, asset, knowledge, project, goalLabel, rawContent, platformLabel }
 */
export async function genContentLayout(p = {}, opts = {}) {
  const { ctx, dailyNote } = buildCtx(p);
  const raw = String(p.rawContent || '').trim();
  const platform = String(p.platformLabel || '微信公众号');
  const messages = [
    {
      role: 'user',
      content: [
        `你是资深新媒体编辑。请把下面这篇内容做「结构化排版 + 平台适配」，输出可复制发布的版本。目标平台：${platform}。`,
        `【今日运营上下文】\n${dailyNote}`,
        `【合规要求】${COMPLIANCE_RULE}`,
        `【待排版内容】\n${raw.slice(0, 4000)}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "title": "梳理后的标题", "outline": ["一级标题/小节1", "一级标题/小节2"], "structured": "结构化后的正文（含分段与小标题，保留原意不编造）", "boldPoints": ["应加粗的重点"], "cta": "文末引导语/CTA", "imageSlots": [ { "position": "开头/中段/结尾", "suggestion": "配图建议" } ], "platformNote": "针对该平台的适配说明（字数/语气/标签/分段等）" }`,
        `不得编造原文没有的事实或数据；如原文信息不足，明确标注「资料不足」。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) return { title: '', outline: [], structured: parsed.__raw, boldPoints: [], cta: '', imageSlots: [], platformNote: '' };
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    outline: arr(parsed.outline),
    structured: typeof parsed.structured === 'string' ? parsed.structured : '',
    boldPoints: arr(parsed.boldPoints),
    cta: typeof parsed.cta === 'string' ? parsed.cta : '',
    imageSlots: (Array.isArray(parsed.imageSlots) ? parsed.imageSlots : []).map((s) => ({
      position: String((s && s.position) || ''),
      suggestion: String((s && s.suggestion) || ''),
    })),
    platformNote: typeof parsed.platformNote === 'string' ? parsed.platformNote : '',
  };
}

export default { genMomentsCopy, genCommunityCopy, genCommunityEvent, genContentLayout };
