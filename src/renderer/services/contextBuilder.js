/**
 * contextBuilder —— AI 上下文注入系统（阶段四 P0 → 阶段一「多企业底座」统一 Context 组装器）。
 *
 * 职责：把「工作空间 → 企业 → 项目 → 任务」四层结构化上下文，连同企业类型/角色，拼成
 * 统一的中文 Context 文本 + 结构化 id 载荷，随 /api/chat 请求带给后端，后端在专家 Prompt
 * 之前注入为 system 消息。现有专家/能力 Prompt 一字不改，只在其上叠这一层。
 *
 * 统一入口 buildAIContext({ workspaceId, companyId, projectId, taskId, ... }) 输出
 * WorkspaceContext / CompanyContext / ProjectContext / TaskContext 四段 + 合并文本 + id 载荷。
 * 所有 AI 调用必须经此统一层，禁止组件内自行拼复杂 Prompt。
 *
 * 数据来源优先级：企业长期知识（companyKnowledgeStore 四类）> 营销资产（asset）> 旧 Company.memory。
 * 纯函数，无副作用，方便后续视频脚本 / PPT / 竞品 Agent 直接复用。
 */

import { BUSINESS_MODEL, hasBrain, normalizeBrain } from '../config/companyBrain.js';
import { projectTypeLabel } from '../config/projectTypes.js';
import { taskTypeLabel } from './capabilityResolver.js';
import { buildTimelineText } from './companyTimeline.js';
import { buildGoalContext } from './companyGoal.js';
import { buildPlanContext } from './planBrief.js';
// 企业体检结论（独立 key，AI 假设层）—— 依赖方向 contextBuilder → checkupBrief，无环。
import { buildCheckupContext } from './checkupBrief.js';
// 数据来源诚实化（2026-09-14）：brain「来源」里的 web 标注跟随联网探针，未确证联网不谎称「联网检索」。
import { getCachedWebSearchHealth } from './webSearchHealth.js';
// 第 5 层「公司上下文贯通任务」：统一公司资料读取入口（纯函数，只读）。
// ⚠️ 依赖图约束：companyContext 只依赖纯 .js（知识模型 / 时间轴 / 目标 / 方案 / 体检 / 联网探针），
//    **不得**把任何 .jsx 拉进本文件的依赖图 —— 本文件有单测是 Node 直跑（不经打包），
//    .jsx 会直接 `Unknown file extension ".jsx"` 把门禁打挂。改动前请先看 companyKnowledgeModel.js 的说明。
import { readCompanyContext, describePresentTiers } from './companyContext.js';
// 第 5 层第 4 步：「活动档期（促销日历）」事实层 —— 让活动策划真正读到档期、状态与重叠。
// 与 planBrief / companyTimeline / companyGoal 完全对称的纯函数（不读 localStorage，入参即数据）。
import { buildPromoContext } from './promoCalendar.js';

/** 企业类型中文名（与 SSOT `config/companyTypeConfig.js` 的 label 逐字对齐：口腔医生 / 口腔平台）。
 *  ⚠️ 必须与 `COMPANY_TYPE_KEYS` 白名单同为 **5 值**：缺 dealer 时 `COMPANY_TYPE_LABEL[key] || key`
 *  会把内部枚举名 `dealer` 原样拼进喂给模型的上下文（"企业类型：dealer"），对模型是噪声。 */
const COMPANY_TYPE_LABEL = {
  manufacturer: '口腔厂家',
  clinic: '口腔门诊',
  doctor: '口腔医生',
  dealer: '经销商',
  platform: '口腔平台',
};
const ROLE_LABEL = { admin: '管理员', operator: '运营', viewer: '查看' };
const PRIORITY_LABEL = { low: '低', medium: '中', high: '高', urgent: '紧急' };
/** brain 商业模式中文名（unknown 不注入）。 */
const BUSINESS_MODEL_LABEL = { b2b: 'B2B', b2c: 'B2C' };
/** brain 来源分级中文名（industry=行业经验假设 / user=用户已填；web 走联网探针，见 brainSourceLabel）。 */
const BRAIN_SOURCE_LABEL = { industry: '行业经验假设', user: '用户已填' };
/** brain 平台账号优先级中文名。 */
const BRAIN_PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };

function join(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.map((s) => String(s).trim()).filter(Boolean).join('、');
}

function section(title, lines) {
  const body = lines.filter((l) => l && String(l).trim());
  if (body.length === 0) return '';
  return `【${title}】\n` + body.join('\n');
}

/** 取优先非空数组：knowledge 优先，回退旧字段。 */
function pickList(...lists) {
  for (const l of lists) {
    if (Array.isArray(l) && l.length > 0) return l;
  }
  return [];
}

/**
 * 活动主体 → 上下文一行（AI 活动总监 T01）。
 * 让 AI 知道「这场活动到底是谁在办」，是四种主体（厂家/门诊/医生/平台）分化 Prompt 的入口。
 * 兼容两种传参：
 *  - string：主体 key，如 'doctor' → 「本次活动主体：口腔医生」；未知 key 原样输出
 *  - object：{ subjectType, subjectLabel }，如 { subjectType:'doctor', subjectLabel:'李医生（主任医师）' }
 *    → 「本次活动主体：李医生（主任医师）（口腔医生）」；两者缺其一则只输出有的那段
 * 传空值返回 ''，调用方不传则整行不出现（向后兼容，行为零变化）。
 * @param {string|{subjectType?:string, subjectLabel?:string, type?:string, label?:string}} activitySubject
 * @returns {string}
 */
function activitySubjectLine(activitySubject) {
  if (!activitySubject) return '';
  if (typeof activitySubject === 'string') {
    const key = activitySubject.trim();
    if (!key) return '';
    return `- 本次活动主体：${COMPANY_TYPE_LABEL[key] || key}`;
  }
  if (typeof activitySubject !== 'object') return '';
  const typeKey = String(activitySubject.subjectType || activitySubject.type || '').trim();
  const label = String(activitySubject.subjectLabel || activitySubject.label || '').trim();
  const typeLabel = typeKey ? (COMPANY_TYPE_LABEL[typeKey] || typeKey) : '';
  if (label && typeLabel) return `- 本次活动主体：${label}（${typeLabel}）`;
  if (typeLabel) return `- 本次活动主体：${typeLabel}`;
  if (label) return `- 本次活动主体：${label}`;
  return '';
}

/** 取优先非空字符串。 */
function pickStr(...vals) {
  for (const v of vals) {
    const s = v == null ? '' : String(v).trim();
    if (s) return s;
  }
  return '';
}

// ---- 四段独立上下文 ----

/** 工作空间段。 */
export function buildWorkspaceContext(workspace, role) {
  const w = workspace || {};
  return section('工作空间 Context', [
    w.name ? `- 工作空间：${w.name}` : '',
    role ? `- 工作空间角色：${ROLE_LABEL[role] || role}` : '',
  ]);
}

/**
 * brain 深度思考产物 → 企业 Context 追加行（仅在 hasBrain 为真时调用，避免把 emptyBrain
 * 的空字段拼进 prompt）。每条尽量保留，避免信息丢失；竞品必须标注来源（web=联网检索 /
 * industry=行业经验假设），不得把行业假设伪装成已核实事实。
 * @param {object} brain 已归一化 brain（任意来源，内部会再 normalize 一次保证结构完整）
 * @returns {string[]} 形如 `- 标签：内容` 的行数组
 */
function buildBrainLines(brain) {
  const b = normalizeBrain(brain);
  const lines = [];

  if (b.businessModel && b.businessModel !== BUSINESS_MODEL.UNKNOWN) {
    lines.push(`- 商业模式：${BUSINESS_MODEL_LABEL[b.businessModel] || b.businessModel}`);
  }
  if (b.brandTone) {
    lines.push(`- 品牌调性：${b.brandTone}`);
  }

  const segments = b.customerSegments.map((s) => (s.pain ? `${s.name}（痛点：${s.pain}）` : s.name));
  if (segments.length) lines.push(`- 目标客户细分：${segments.join('、')}`);

  // 来源标注跟随联网探针：web 类事实只有在**确证联网可用**时才敢标「联网检索」，
  // 否则照实写「未联网 · 模型推断 / 模型分析（联网状态未确认）」—— 不把推断伪装成联网产物。
  const brainSourceLabel = (source) => {
    if (source === 'web') {
      const h = getCachedWebSearchHealth();
      if (h && h.available === true) return '联网检索';
      if (h && h.available === false) return '未联网 · 模型推断';
      return '模型分析（联网状态未确认）';
    }
    return BRAIN_SOURCE_LABEL[source] || BRAIN_SOURCE_LABEL.industry;
  };
  const comps = b.competitors.map((c) => {
    const src = brainSourceLabel(c.source);
    return `${c.name}（${c.reason || '—'}，来源：${src}）`;
  });
  if (comps.length) lines.push(`- 竞品推荐：${comps.join('、')}`);

  const accounts = b.platformAccounts
    .filter((p) => p.should)
    .map((p) => `${p.platformKey}（${p.why || '—'}，优先级：${BRAIN_PRIORITY_LABEL[p.priority] || p.priority}）`);
  if (accounts.length) lines.push(`- 平台账号建议：${accounts.join('、')}`);

  const insights = b.operatingInsights.map((i) => (i.expect ? `${i.title}（预期：${i.expect}）` : i.title));
  if (insights.length) lines.push(`- 运营洞察：${insights.join('、')}`);

  const angles = join(b.contentAngles);
  if (angles) lines.push(`- 内容选题角度：${angles}`);

  if (b.marketingStrategy) lines.push(`- 营销策略：${b.marketingStrategy}`);

  const activities = b.activitySuggestions.map((s) =>
    [s.subject, s.goalKey, s.templateKey, s.why].filter(Boolean).join('｜')
  );
  if (activities.length) lines.push(`- 活动建议：${activities.join('；')}`);

  return lines;
}

/**
 * 企业段（合并 knowledge 四类 + 资产 + 旧 memory，knowledge 优先）。
 * @param {object} [p.activitySubject] 可选「本次活动主体」（T01）：string 主体 key 或
 *   { subjectType, subjectLabel }。不传则输出与改造前完全一致。
 * @param {object} [p.brain] 可选「公司画像中枢」深度思考产物（companyBrain）。hasBrain 为真时
 *   在企业 Context 末尾追加商业模式/调性/细分/竞品/账号/洞察/选题/策略/活动建议；缺省 null 零变化。
 * @param {string} [p.tiersLine] 第 5 层：`describePresentTiers` 产出的【资料可信度】抬头。
 *   **由 buildAIContext 计算后传入**（本函数不自己算，避免"企业段"与"合并文本"各算一份而分叉）。
 *   缺省 '' ⇒ 输出与改动前逐字节一致（直接调用本函数的老代码不受影响）。
 *   另：`k.promos`（活动档期）由读入口/`getKnowledge` 挂载，本函数经 `buildPromoContext` 注入；
 *   无记录时零注入 ⇒ 同样保持逐字节一致，无需新增入参。
 */
export function buildCompanyContext({ company, asset, knowledge, role, activitySubject, brain, tiersLine } = {}) {
  const c = company || {};
  const a = asset || {};
  const k = knowledge && typeof knowledge === 'object' ? knowledge : {};
  const kp = k.profile && typeof k.profile === 'object' ? k.profile : {};
  const mem = c.memory && typeof c.memory === 'object' ? c.memory : {};

  const facts = pickList(k.facts, a.brandFacts, mem.facts);
  const rules = pickList(k.rules, a.contentTaboos, a.complianceWords, mem.restrictions);
  const memories = pickList(k.memories);
  const coreSelling = pickList(kp.coreSellingPoints, a.coreSellingPoints);
  const targetCustomers = pickList(kp.targetCustomers, a.targetCustomers);
  const competitors = pickList(kp.competitors, a.competitors);
  // 旗下品牌 / 子品牌 IP（如康健苗苗 → 上游货源 / 舒雅星系 / 中齿云彩）。
  // 品牌矩阵型客户（本产品主要客群）写内容、做舆情时必须以「具体 IP」为单位，
  // 此前该字段只用于危机监控（PrCrisis 取监测词），从未注入 AI ——
  // 导致豆芽只知道母公司名，不知道它旗下有哪些 IP。此处补上。
  const brandIps = pickList(kp.brandIps, a.brandIps)
    .map((x) => {
      const v = x && typeof x === 'object' ? x.name : x;
      return typeof v === 'string' ? v.trim() : '';
    })
    .filter(Boolean);

  const brainLines = hasBrain(brain) ? buildBrainLines(brain) : [];

  const base = section('企业 Context', [
    // 第 5 层：资料可信度抬头放**第一行** —— 它是下面这些数据行的注解：
    // 先让模型知道"哪些能当事实引用、哪些不能"，再读到具体内容，避免它把未确认的画像/体检
    // 当成企业事实照抄。一个槽位都没有内容时它是 ''（不注入），保持改动前逐字一致。
    tiersLine || '',
    c.name ? `- 企业名称：${c.name}` : '',
    c.type ? `- 企业类型：${COMPANY_TYPE_LABEL[c.type] || c.type}` : '',
    role ? `- 用户角色：${ROLE_LABEL[role] || role}` : '',
    pickStr(kp.brandPositioning, a.brandTone) ? `- 品牌定位/调性：${pickStr(kp.brandPositioning, a.brandTone)}` : '',
    pickStr(kp.industry, a.industry) ? `- 行业：${pickStr(kp.industry, a.industry)}` : '',
    pickStr(kp.products, a.products) ? `- 产品：${pickStr(kp.products, a.products)}` : '',
    pickStr(kp.summary, a.profile) ? `- 企业画像：${pickStr(kp.summary, a.profile)}` : '',
    join(coreSelling) ? `- 核心卖点：${join(coreSelling)}` : '',
    join(targetCustomers) ? `- 目标客户：${join(targetCustomers)}` : '',
    join(competitors) ? `- 竞品：${join(competitors)}` : '',
    join(brandIps) ? `- 旗下品牌/IP：${join(brandIps)}` : '',
    join(facts) ? `- 企业事实：${join(facts)}` : '',
    join(rules) ? `- 品牌规则/禁区：${join(rules)}` : '',
    join(memories) ? `- 企业长期记忆：${join(memories)}` : '',
    a.marketingStrategy ? `- 营销策略：${a.marketingStrategy}` : '',
    ...brainLines,
  ]);

  // 阶段一：企业档案时间段追踪 —— 「上月 vs 本月」对比注入（k.timeline 由 getKnowledge 附带）。
  // 事实层：只给「做了什么 + 指标怎么变」，让 AI 判断变化含义，不预设结论。
  const timelineText = buildTimelineText(k.timeline);

  // P1：企业目标（方向盘）注入 —— k.goals 由 getKnowledge 附带，让 AI 知道「要去哪」。
  const goalText = buildGoalContext(k.goals);

  // P1：已排方案（日历）注入 —— k.plan 由 getKnowledge 附带（豆芽给用户排好、铺在日历上的带日期节点）。
  // 事实层：只给「排了什么、什么时候」，让 AI 知道「打算怎么做」，无需再问用户「豆芽排过什么」。
  // 无方案（或窗口内无节点）时 buildPlanContext 返回 ''，此处不注入 —— AI 上下文与改动前完全一致。
  const planText = buildPlanContext(k.plan);

  // 企业体检结论注入 —— k.checkup 由 getKnowledge 附带（独立 key `douya-company-checkup`）。
  // **假设层**：自带「AI 假设，非已核实事实 / 与事实冲突以事实为准」抬头，绝不与【企业事实】混淆。
  // 只注入 summary + gaps + fixes；understood（豆芽自述了解了什么）不注入，避免模型自我强化。
  // 无体检记录时 buildCheckupContext 返回 ''（零注入），AI 上下文与改动前逐字一致。
  const checkupText = buildCheckupContext(k.checkup);

  // 第 5 层第 4 步：活动档期（促销日历）注入 —— k.promos 由 getKnowledge / readCompanyContext 挂载。
  // 事实层：只给「有哪些档期、什么时候、当前处于什么状态、哪里重叠」，**不给优先级结论**
  // （老板明确：重叠只提醒，谁优先必须问用户，不能由程序裁决）。
  // 无档期记录时 buildPromoContext 返回 ''（零注入）⇒ AI 上下文与改动前逐字一致。
  const promoText = buildPromoContext(k.promos);

  // 顺序语义：体检结论＝豆芽对这家企业的判断（假设）→ 目标＝要去哪 → 已排方案＝打算怎么做
  // → 活动档期＝已经排定/正在跑的促销 → 时间轴＝已经做了什么。
  // 假设层放最前，让后续事实/目标对其形成覆盖关系（冲突时以事实为准）。
  const extra = [checkupText, goalText, planText, promoText, timelineText].filter(Boolean).join('\n\n');
  if (!extra) return base;
  return base ? base + '\n\n' + extra : extra;
}

/** 项目段。 */
export function buildProjectContext({ project, goalLabel, projectMaterials } = {}) {
  const p = project || {};
  const base = section('项目 Context', [
    p.name ? `- 项目名称：${p.name}` : '',
    p.type ? `- 项目类型：${projectTypeLabel(p.type) || p.type}` : '',
    goalLabel ? `- 营销目标：${goalLabel}` : '',
    p.description ? `- 项目描述：${p.description}` : '',
    p.audience ? `- 目标客户：${p.audience}` : '',
    p.product ? `- 核心产品：${p.product}` : '',
    join(p.sellingPoints) ? `- 核心卖点：${join(p.sellingPoints)}` : '',
    p.period ? `- 项目周期：${p.period}` : '',
    p.budget ? `- 预算：${p.budget}` : '',
    join(p.channels) ? `- 传播渠道：${join(p.channels)}` : '',
    p.kpi ? `- KPI：${p.kpi}` : '',
    join(p.memory) ? `- 项目记忆：${join(p.memory)}` : '',
  ]);
  const mats = buildProjectMaterialsContext(projectMaterials);
  if (!mats) return base;
  return base ? base + '\n' + mats : '【项目 Context】\n' + mats;
}

/** 项目资料每篇正文最大字符数（截断，避免 Context 过长）。 */
const MATERIAL_MAX_CHARS = 400;
/** 项目资料最多注入篇数。 */
const MATERIAL_MAX_COUNT = 8;

/**
 * 项目资料 → 上下文文本（阶段五：让运营上传/粘贴的产品资料、历史文章正文真正喂给 AI）。
 * 只取当前项目的资料（由调用方按 projectId 过滤后传入），每篇截断、限制篇数，防撑爆上下文。
 * @param {Array<{name:string, content?:string}>} projectMaterials
 */
export function buildProjectMaterialsContext(projectMaterials) {
  const mats = (Array.isArray(projectMaterials) ? projectMaterials : [])
    .filter((m) => m && (m.name || m.content))
    .slice(0, MATERIAL_MAX_COUNT);
  if (mats.length === 0) return '';
  const lines = mats.map((m) => {
    const name = m.name ? String(m.name).trim() : '';
    const content = m.content ? String(m.content).trim() : '';
    const body = content.length > MATERIAL_MAX_CHARS ? content.slice(0, MATERIAL_MAX_CHARS) + '…' : content;
    if (name && body) return `· ${name}：${body}`;
    if (name) return `· ${name}`;
    return `· ${body}`;
  });
  return '项目资料（供 AI 参考，仅当前项目）：\n' + lines.join('\n');
}

/** 任务段。 */
export function buildTaskContext(task) {
  const t = task || {};
  return section('任务 Context', [
    t.title ? `- 当前任务：${t.title}` : '',
    t.taskType ? `- 任务类型：${taskTypeLabel(t.taskType)}` : '',
    t.priority ? `- 优先级：${PRIORITY_LABEL[t.priority] || t.priority}` : '',
    t.description ? `- 任务描述：${t.description}` : '',
    t.goal ? `- 任务目标：${t.goal}` : '',
    t.requirements ? `- 任务要求：${t.requirements}` : '',
    t.outputFormat ? `- 输出格式：${t.outputFormat}` : '',
  ]);
}

/**
 * 统一组装四段文本（只输出非空段，保持精简）。
 * @param {object} p
 * @param {object} [p.workspace] 当前工作空间 { name }
 * @param {object} [p.company] 当前企业 { name, type, role }
 * @param {object} [p.asset] 企业营销资产（marketingStore）
 * @param {object} [p.knowledge] 企业长期知识（companyKnowledgeStore 四类）
 * @param {object} [p.project] 当前项目
 * @param {object} [p.task] 当前任务
 * @param {string} [p.role] 当前角色
 * @param {string} [p.workspaceRole] 当前工作空间角色
 * @param {string} [p.goalLabel] 当前营销目标中文名
 * @param {Array} [p.projectMaterials] 当前项目资料（type=material 的 Asset 数组，注入正文）
 * @param {string|object} [p.activitySubject] 可选「本次活动主体」（T01），透传给 buildCompanyContext
 * @param {object} [p.brain] 可选「公司画像中枢」深度思考产物，透传给 buildCompanyContext
 * @param {string} [p.tiersLine] 第 5 层：资料可信度抬头，透传给 buildCompanyContext。
 *   由 buildAIContext 统一计算后传入 —— 这样 `buildAIContext(...).text` 与本函数同参调用
 *   的输出**逐字相同**（否则两处会各写一套）。缺省 '' ⇒ 与改动前逐字一致。
 */
export function buildContextText({ workspace, company, asset, knowledge, project, task, role, workspaceRole, goalLabel, projectMaterials, activitySubject, brain, tiersLine } = {}) {
  const c = company || {};

  // 无企业（既无 id 也无名称）→ 无「当前工作上下文」，不注入占位企业，避免删除企业后残留「未命名企业」
  if (!c.id && !c.name) return '';

  const lines = [
    buildWorkspaceContext(workspace, workspaceRole),
    buildCompanyContext({ company, asset, knowledge, role, brain, tiersLine }),
    buildProjectContext({ project, goalLabel, projectMaterials }),
    buildTaskContext(task),
  ].filter(Boolean);

  const contextBody = lines.join('\n\n');
  if (!contextBody) return '';

  return (
    '【当前工作上下文】你正在为一家「' +
    (c.name || '未命名企业') +
    '」的营销运营工作服务。请严格围绕以下「工作空间 → 企业 → 项目 → 任务」上下文完成工作，不要带入其他企业或项目的信息。\n\n' +
    contextBody +
    '\n\n【执行规则】\n' +
    '1. 只围绕当前企业/项目/任务回答，严禁把其他企业或其他项目的信息带入。\n' +
    '2. 企业事实与 AI 推测必须明确区分；医疗相关内容不得编造疗效、数据、案例、专家评价。\n' +
    '3. 信息不足时不要自行补全为事实。\n' +
    '4. 优先输出可直接进入运营工作流程的执行结果，而非大段泛泛建议。'
  );
}

/**
 * 第 5 层判据：这次调用要不要「自解析公司资料」。
 *
 * 规则是**全有或全无**：只有调用方一个公司资料字段都没给（company / asset / knowledge / brain
 * 全为 undefined 或 null），才允许去读；只要给了其中任意一个，就完全按调用方给的来、绝不被覆盖。
 *
 * ⚠️ 判的是**运行时的值**，不是"源码里有没有写这个键"。所以有两类情况会触发：
 *   ① 源码就没传（如 `buildAIContext({ companyId })`）；
 *   ② 源码传了、但**运行时三个值恰好都是 null/undefined**（如 `buildAIContext(params)` 而 params 为空对象）。
 *    ② 是期望语义而非回归：那意味着"这次调用手里没有任何公司背景"，此刻由入口按当前企业读一次，
 *    正是「公司只介绍一次」要的效果。**真正被钉死的不变量是**：只要给了任意一个字段，输出逐字节不变
 *    （门禁 unit-context-selfresolve.mjs 的 SR1b~SR1h 用"空存储 vs 满存储"对照证明，RC1~RC3 反向打它）。
 *
 * 为什么不能「按字段逐个补齐」（缺 asset 就补 asset）：本仓存在形如 `{ company, knowledge }`
 * 的**部分传参**调用点（ModuleAssistant、services/moduleAssistant、ActivityReviewPanel 等）。
 * 它们当前的输出里没有 asset / brain 的贡献，一旦补齐，这些调用点真正送给模型的 prompt 会变化
 * —— 那就破坏了上面那条不变量。故宁可「全有或全无」。
 *
 * @param {{company?:*, asset?:*, knowledge?:*, brain?:*}} p
 * @returns {boolean}
 */
function needsSelfResolve({ company, asset, knowledge, brain }) {
  const given = (v) => v !== undefined && v !== null;
  return !given(company) && !given(asset) && !given(knowledge) && !given(brain);
}

/**
 * 统一 AI Context 组装器（阶段一核心入口）。
 * 输入当前上下文 id + 各层对象，输出四段 Context + 合并文本 + 结构化 id 载荷。
 * @param {object} [p.brain] 可选「公司画像中枢」深度思考产物，透传给 buildCompanyContext 注入企业 Context。
 * @param {string|number} [p.companyId] 第 5 层：显式指定要自解析哪家公司（不传则用「当前企业」）。
 *   仅当调用方**没有**传入 company/asset/knowledge/brain 中任何一个时才生效；
 *   只要传了任意一个，本参数不参与（不会覆盖、也不会补齐）——见 needsSelfResolve。
 */
export function buildAIContext({ workspace, company, asset, knowledge, project, task, role, workspaceRole, goalLabel, projectMaterials, activitySubject, brain, companyId } = {}) {
  // ── 第 5 层：公司资料自解析 ────────────────────────────────────────────────
  // 让「公司只介绍一次」真正落地：调用方不必再逐个手工传 company/asset/knowledge/brain。
  // 读取用与 React 侧 getKnowledge **同一套归一化**（companyContext 复用同一个纯模型），
  // 不是"另一份口径"。⚠️ 时序差异：此处读的是**已落盘**的值（会话内刚编辑未落盘的请走 React 侧）。
  if (needsSelfResolve({ company, asset, knowledge, brain })) {
    const resolved = readCompanyContext(companyId);
    // 只有确实读到了**公司记录**才注入；连公司记录都没有时保持旧行为（无企业 ⇒ text 为空串，
    // 不注入占位企业），避免把「零散知识」当成一家公司。
    if (resolved.company) {
      company = resolved.company;
      asset = resolved.asset;
      knowledge = resolved.knowledge;
      brain = resolved.brain;
    }
  }

  // ── 第 5 层第 3 步：资料可信度抬头（三级来源分级**真正**进 prompt）──────────
  // 第 1/2 步已把「统一读取入口」和「自解析」建好，但分级一直是**只算不送**：
  // `describeTiers` 全仓只有门禁在调，模型从来没被告知"哪些不能当事实引用"。
  // 这里把它接上 —— 按**这次实际用到**的那几段算（缺数据的槽位不会被声称有），
  // 同时喂给 companyContext 与 text，保证两处逐字一致（text 由 buildContextText 拼，也吃同一个 tiersLine）。
  // ⚠️ 必须放在自解析**之后**：自解析改的正是"这次到底用了哪几段"，抬头得跟着它走。
  // ⚠️ `describePresentTiers` 只读入参、不读 localStorage ⇒ 显式传参路径的存储免疫性不受影响
  //    （第 93 步 unit-context-selfresolve 的 SR1b~SR1f 钉着这条）。
  const tiersLine = describePresentTiers({ company, asset, knowledge, brain });

  const workspaceContext = buildWorkspaceContext(workspace, workspaceRole);
  const companyContext = buildCompanyContext({ company, asset, knowledge, role, activitySubject, brain, tiersLine });
  const projectContext = buildProjectContext({ project, goalLabel, projectMaterials });
  const taskContext = buildTaskContext(task);
  const text = buildContextText({ workspace, company, asset, knowledge, project, task, role, workspaceRole, goalLabel, projectMaterials, activitySubject, brain, tiersLine });

  // 阶段四：统一 Context 返回「丰富对象」——四层结构化对象 + 企业四类知识，供 Capability 复用，
  // 避免每个能力各自读企业信息。companyProfile 取 knowledge.profile，事实/规则/记忆走 pickList 优先级。
  const c = company || {};
  const k = knowledge && typeof knowledge === 'object' ? knowledge : {};
  const kp = k.profile && typeof k.profile === 'object' ? k.profile : {};
  const a = asset && typeof asset === 'object' ? asset : {};
  const mem = c.memory && typeof c.memory === 'object' ? c.memory : {};
  const companyFacts = pickList(k.facts, a.brandFacts, mem.facts);
  const companyRules = pickList(k.rules, a.contentTaboos, a.complianceWords, mem.restrictions);
  const companyMemory = pickList(k.memories);
  const projectMemory = project && Array.isArray(project.memory) ? project.memory : [];

  return {
    // 四段独立上下文（供后端/未来 Agent 分段注入）
    workspaceContext,
    companyContext,
    projectContext,
    taskContext,
    // 合并文本（现有后端读 payload.context.text）
    text,
    // 结构化 id 载荷
    workspaceId: (workspace && workspace.id) || (company && company.workspaceId) || null,
    companyId: (company && company.id) || null,
    projectId: (project && project.id) || null,
    taskId: (task && task.id) || null,
    companyType: (company && company.type) || null,
    role: role || 'admin',
    workspaceRole: workspaceRole || 'admin',
    goalLabel: goalLabel || '',
    // 阶段四：丰富对象（四层 + 企业四类知识 + 原始引用，Capability 直接消费）
    workspace,
    company,
    project,
    task,
    asset,
    knowledge,
    companyProfile: kp,
    companyFacts,
    companyRules,
    companyMemory,
    projectMemory,
    projectMaterials: Array.isArray(projectMaterials) ? projectMaterials : [],
  };
}

/**
 * 兼容旧签名：返回 { text, companyId, projectId, taskId, workspaceId, companyType, role }。
 * 保留以便现有调用逐步迁移到 buildAIContext。
 * @param {string|number} [p.companyId] 第 5 层：透传给 buildAIContext 的自解析参数。
 */
export function buildContext({ workspace, company, asset, knowledge, project, task, role, workspaceRole, goalLabel, projectMaterials, activitySubject, brain, companyId } = {}) {
  const ctx = buildAIContext({ workspace, company, asset, knowledge, project, task, role, workspaceRole, goalLabel, projectMaterials, activitySubject, brain, companyId });
  return {
    text: ctx.text,
    workspaceContext: ctx.workspaceContext,
    companyContext: ctx.companyContext,
    projectContext: ctx.projectContext,
    taskContext: ctx.taskContext,
    companyId: ctx.companyId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    workspaceId: ctx.workspaceId,
    companyType: ctx.companyType,
    role: ctx.role,
  };
}

export default buildAIContext;
