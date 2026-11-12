/**
 * goalGuide —— 目标引导面板（P0-2）的 AI 内容生成服务。
 *
 * 把「目标 → 工作流步骤」里每一步的 AI 生成逻辑单独抽出来，
 * 方便单元测试用假 chatFn 替换真实网络（与 autoFill.js 同思路）。
 *
 * routeForGoal(goalId).steps 中每个 step 形如：
 *   { key, title, module, hint }
 * 当用户走到某一步时，调用 generateStepContent(step, context) 让 AI 产出该步可直接落地的执行内容。
 *
 * 另外提供两个「选目标即开工」的结构化 AI 能力：
 *  - recommendGoals()：让 AI 从**本身份**的目标组里挑出最适合当前企业的 3-5 个
 *    （按 companyType 收窄候选集，与 GoalSelector.preferred / 门禁 VISIBLE_GROUP 同语义；
 *     未知/空身份 ⇒ 全量清单，向后兼容且不抛错）
 *  - planGoalCampaign()：为选定目标产出一套可直接落成项目 + 任务的作战方案
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
import { GOAL_GROUPS } from '../store/goalCatalog.js';

/**
 * 构造某一步的 AI 提示词。企业/项目上下文由后端用 context 注入 system，
 * 这里只描述「这一步具体要做什么」。
 * @param {{title:string, hint?:string, module?:string}} step
 * @param {string} goalLabel 当前目标名（如「获客」）
 */
export function buildStepPrompt(step, goalLabel) {
  const title = (step && step.title) || '当前步骤';
  const hint = (step && step.hint) || '';
  const goal = goalLabel ? `营销目标「${goalLabel}」` : '当前营销目标';
  return [
    `我正在推进${goal}。`,
    `请帮我完成其中的「${title}」这一步${hint ? `（${hint}）` : ''}。`,
    '请直接产出可落地、可直接进入运营工作流的执行内容/方案，语言简洁、条理清晰，不要泛泛而谈。',
    '若涉及医疗疗效、数据、案例或专家评价，不得编造，信息不足时明确标注「待补充」。',
  ].join('\n');
}

/**
 * 生成某一步的 AI 内容。
 * @param {{title:string, hint?:string, module?:string}} step
 * @param {object} [context] buildAIContext 输出（企业/项目上下文）
 * @param {object} [opts] { chatFn, goalLabel, enableSearch, temperature }
 * @returns {Promise<{ok:boolean, content:string, error:string}>}
 */
export async function generateStepContent(step, context, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const prompt = buildStepPrompt(step, opts.goalLabel || '');
  let res;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], context && typeof context === 'object' ? context : null, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.5,
      enableSearch: !!opts.enableSearch,
      reasoningEffort: 'none',
    });
  } catch (e) {
    return { ok: false, content: '', error: '生成失败：' + (e && e.message) };
  }
  if (res && res.ok && res.content) {
    return { ok: true, content: res.content, error: '' };
  }
  return { ok: false, content: '', error: (res && res.error) || 'AI 未返回结果' };
}

/* ============================================================
   以下为「营销目标卡片化 + AI 自动建项目」新增能力
   ============================================================ */

function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 取字符串数组（过滤空项，最多保留 limit 条）。 */
function asList(v, limit = 12) {
  return (Array.isArray(v) ? v : [])
    .map((it) => asStr(it))
    .filter(Boolean)
    .slice(0, limit);
}

/** priority 只允许 high / mid / low，缺省 mid。 */
function normPriority(v) {
  const p = asStr(v).toLowerCase();
  if (p === 'high' || p === '高') return 'high';
  if (p === 'low' || p === '低') return 'low';
  return 'mid';
}

/** dayOffset 必须是 0-365 的整数，缺省 0。 */
function normDay(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 365);
}

function normInt(v, fallback, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * 身份 → 目标组（**必须与 GoalSelector.preferred / 门禁 VISIBLE_GROUP 同语义**，三处不许各说各话）。
 * 未知/空身份不在此表中 ⇒ 不做组过滤 = 全量（向后兼容，且不抛错）。
 */
const TYPE_GOAL_GROUP = {
  manufacturer: 'factory',
  clinic: 'clinic',
  doctor: 'dentist',
  dealer: 'dealer',
  platform: 'platform',
};

/**
 * 解析某身份**允许**的目标组 id 集合；未知/空 ⇒ null（=「全量」，保持既有行为）。
 * ⚠️ 组必须**真的存在于目录**，否则也退化为「全量」——绝不把**空清单**喂给 AI（宁可多给，不可不给）。
 * @param {string} companyType 企业类型 key
 * @returns {string[]|null}
 */
function goalGroupIdsFor(companyType) {
  const key = typeof companyType === 'string' ? companyType.trim() : '';
  const g = TYPE_GOAL_GROUP[key];
  if (!g || !GOAL_GROUPS.some((x) => x && x.id === g)) return null;
  return [g];
}

/**
 * 目标目录里所有目标 id 的集合（用于校验 AI 推荐的 goalId 是否合法）。
 * @param {string[]|null} [groupIds] 只取这些组；缺省/空 ⇒ 全量（向后兼容）。
 */
function allGoalIds(groupIds) {
  const ids = [];
  for (const g of GOAL_GROUPS) {
    if (groupIds && !groupIds.includes(g.id)) continue;
    for (const item of g.goals) ids.push(item.id);
  }
  return ids;
}

/**
 * 把目标拼成可供 AI 选择的清单文本。
 * @param {string[]|null} [groupIds] 只列这些组；缺省/空 ⇒ 全量（向后兼容）。
 */
function goalOptionsText(groupIds) {
  return GOAL_GROUPS
    .filter((g) => !groupIds || groupIds.includes(g.id))
    .map((g) => `${g.label}：${g.goals.map((it) => `${it.id}(${it.label} - ${it.desc})`).join('、')}`)
    .join('\n');
}

/** reason 必须从企业画像推导的硬性约束（禁止空泛理由）。 */
const REASON_RULE = [
  '每条「reason / why（为什么做）」必须从当前企业画像中推导，明确引用具体信息（行业、产品、核心卖点、目标客户、竞品、当前营销目标），',
  '例如「企业主营种植体，目标客户是民营口腔门诊，竞品正主推数字化方案，所以应先……」。',
  '禁止输出「因为要增长」「因为重要」「提升品牌」等空泛理由；信息不足时写明「企业画像中缺少 X 信息」。',
].join('');

/** 禁止编造 + 必须有明确产出物的硬性约束。 */
const FACT_RULE = [
  '禁止编造企业信息（产品名、客户名、疗效、数据、案例、获奖）。画像中没有的信息，一律写「待补充：X」。',
  '每条任务必须可直接执行：title 必须有明确宾语，禁止出现「加强」「优化」「提升」这类没有宾语的动词；',
  'outputFormat 必须写明这一条最终交付什么具体东西（如「1 篇小红书图文初稿」「10 家目标诊所名单表格」）。',
].join('');

/**
 * AI 从**本身份**的目标组中挑出最适合当前企业的 3-5 个。
 * 候选集按 `p.companyType` 收窄（未知/空 ⇒ 全量），返回结果也按同口径过滤。
 *
 * @param {object} p { currentCompany, asset, knowledge, companyType, role }
 * @param {object} [opts] { chatFn, temperature }
 * @returns {Promise<Array<{goalId:string, reason:string, fit:'高'|'中'|'低'}>>} 失败返回 []
 */
export async function recommendGoals(p = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  // 按身份收窄候选集：dealer 只看 dealer 组、门诊只看 clinic 组……未知/空 ⇒ null = 全量（向后兼容）。
  const groupIds = goalGroupIdsFor(p.companyType);
  const ctx = buildAIContext({
    company: p.currentCompany,
    asset: p.asset,
    knowledge: p.knowledge,
    role: p.role || 'admin',
    goalLabel: '',
  });

  const prompt = [
    '你是口腔行业营销顾问。请基于这家企业的画像，从下面全部营销目标里挑出最适合它「现在就做」的 3-5 个。',
    `企业类型：${p.companyType || '未知'}。`,
    '可选目标清单（id(名称 - 说明)）：',
    goalOptionsText(groupIds),
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "list": [ { "goalId": "上面清单里的 id", "reason": "为什么适合这家企业（一句话）", "fit": "高/中/低" } ] }',
    'goalId 必须严格取自上面的清单；fit 取「高」「中」「低」之一；按 fit 从高到低排序，最多 5 个。',
    REASON_RULE,
    '不得编造企业信息。',
  ].join('\n');

  let res;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
      reasoningEffort: 'none',
    });
  } catch {
    return [];
  }
  if (!res || res.ok !== true || !res.content) return [];

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const raw = Array.isArray(parsed.list) ? parsed.list : Array.isArray(parsed) ? parsed : [];
  const valid = allGoalIds(groupIds); // 与候选集同口径收窄 ⇒ 身份外的 id 一律过滤掉

  return raw
    .map((it) => {
      const goalId = asStr(it && it.goalId);
      const fitRaw = asStr(it && it.fit);
      const fit = fitRaw === '高' || fitRaw === '中' || fitRaw === '低' ? fitRaw : '中';
      return { goalId, reason: asStr(it && it.reason), fit };
    })
    .filter((it) => valid.includes(it.goalId))
    .slice(0, 5);
}

/**
 * 为一个营销目标产出「可直接建项目执行」的作战方案。
 *
 * @param {object} p {
 *   currentCompany, asset, knowledge, project, goalId, goalLabel, companyType, role
 * }
 * @param {object} [opts] { chatFn, temperature }
 * @returns {Promise<{
 *   campaignName: string,
 *   why: string,
 *   durationDays: number,
 *   tasks: Array<{title:string, description:string, outputFormat:string, priority:'high'|'mid'|'low', dayOffset:number, why:string}>,
 *   kpi: Array<{name:string, target:string, howToMeasure:string}>,
 *   channels: string[],
 *   quickWin: string,
 *   generatedAt: number
 * }|null>}
 */
export async function planGoalCampaign(p = {}, opts = {}) {
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
    '你是口腔行业营销作战参谋。这家企业刚选定了一个营销目标，请围绕它产出一套「可以直接落成项目去执行」的作战方案。',
    `营销目标：${p.goalLabel || ''}（id: ${p.goalId || ''}）。`,
    `企业类型：${p.companyType || '未知'}。`,
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "campaignName": "战役名（10 字以内，带营销目标味）", "why": "为什么这么打（结合企业画像）", "durationDays": 30, "tasks": [ { "title": "任务标题（必须有明确宾语）", "description": "具体怎么做", "outputFormat": "这一条最终交付什么", "priority": "high/mid/low", "dayOffset": 0, "why": "为什么做" } ], "kpi": [ { "name": "指标名", "target": "目标值", "howToMeasure": "怎么统计" } ], "channels": ["小红书"], "quickWin": "今天就能做完并能立刻看到反馈的一件事" }',
    'tasks 给 6-12 条，按时间顺序排列，dayOffset 从 0 开始（0 = 今天就做），全部落在 durationDays 之内。',
    'priority 只能是 high / mid / low。',
    'kpi 给 2-3 条，必须可量化并写清统计口径。',
    'channels 只从中国主流平台里选与该目标、该企业匹配的（小红书、抖音、微信视频号、公众号、知乎、百度、美团点评、行业媒体、线下展会 等），2-5 个。',
    REASON_RULE,
    FACT_RULE,
  ].join('\n');

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

  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
    .map((it) => ({
      title: asStr(it && it.title),
      description: asStr(it && it.description),
      outputFormat: asStr(it && it.outputFormat),
      priority: normPriority(it && it.priority),
      dayOffset: normDay(it && it.dayOffset),
      why: asStr(it && it.why),
    }))
    .filter((it) => it.title)
    .sort((a, b) => a.dayOffset - b.dayOffset)
    .slice(0, 12);

  const kpi = (Array.isArray(parsed.kpi) ? parsed.kpi : [])
    .map((it) => ({
      name: asStr(it && it.name),
      target: asStr(it && it.target),
      howToMeasure: asStr(it && it.howToMeasure),
    }))
    .filter((it) => it.name)
    .slice(0, 5);

  const campaignName = asStr(parsed.campaignName);
  const why = asStr(parsed.why);
  const quickWin = asStr(parsed.quickWin);
  const channels = asList(parsed.channels, 6);
  const maxDay = tasks.reduce((m, t) => Math.max(m, t.dayOffset), 0);
  const durationDays = normInt(parsed.durationDays, Math.max(maxDay + 1, 14), 365);

  if (!campaignName && tasks.length === 0) return null;

  return {
    campaignName: campaignName || `${p.goalLabel || '营销'}作战计划`,
    why,
    durationDays,
    tasks,
    kpi,
    channels,
    quickWin,
    generatedAt: Date.now(),
  };
}

export default { buildStepPrompt, generateStepContent, recommendGoals, planGoalCampaign };
