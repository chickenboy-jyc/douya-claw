/**
 * directionDirector —— 「经营方案」自动搭建链路（纯函数，无副作用，可测试）。
 *
 * 设计依据：docs/First-run-SQP-经营方案-v1.md（2026-09-10）。
 * 性质：纯映射 + 结构生成。把「用户选的方向」翻译成「Direction + 主 Campaign 草案」。
 *
 * 核心原则（本轮）：
 *   选择方案 ≠ 创建一个空项目。
 *   而是豆芽自动把整条链路搭起来：经营目标 → 主专项 → 传播计划 → 执行任务 → 市场监测。
 *   用户不配置内容数量 / 阶段 / 任务 / 渠道 —— 全部由豆芽根据方向模板生成。
 *
 * 与 campaignDirector 解耦：本文件只做「方向 → Direction + Campaign 草案」这一层，
 * 具体 Campaign 五段式结构仍由 campaignDirector.draftCampaign 生成。
 *
 * 历史不丢：换方向 = 旧 Direction 转 paused，保留历史，非删除。
 */

import { DIRECTION_KEYS, getDirections, getDirectionByKey, getDirectionDiagnosis } from '../config/directionCatalog.js';
import { recognizeCampaignIntent, draftCampaign } from './campaignDirector.js';

function asIso(v) {
  return typeof v === 'string' && v ? v : '';
}

/** 宽松取字符串（非字符串 → String，null/undefined → 空串）。 */
function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ==================== 引导执行：模板 actions[] → 阶段 checklist ====================
// 依据 IA 定稿 §5.1：planSteps 从模板 actions[] 派生（单一事实源在 directionCatalog），
// 模板不额外硬编码步骤，避免双份事实源。每个动作产出「产出物」（必须带宾语）。

/** 动作能力 → 「去执行」目标模块 key（仅提供跳转，不自动建任务，见 IA 未决项 U2）。 */
const CAPABILITY_EXEC_MODULE = {
  content: 'content', // 内容与传播
  geo: 'content', // GEO 内容体系归内容与传播
  media: 'newmedia', // 媒体投放在新媒体中心
  activity: 'campaign', // 活动 / 沙龙落到营销专项
};

/** 三个引导阶段（固定骨架；空阶段会在末尾被过滤掉）。 */
const PLAN_STAGES = [
  { id: 'base', title: '阶段一 · 梳理与定调', goal: '把现状、目标和资源梳理清楚，定下这一轮要做的事。' },
  { id: 'produce', title: '阶段二 · 产出内容', goal: '按梳理结果产出可对外发布的内容与素材。' },
  { id: 'spread', title: '阶段三 · 传播与落地', goal: '把内容投出去，落到渠道、活动与客户手里。' },
];

/** 判定一个动作落在哪个阶段（0/1/2）；无命中时归到「传播与落地」。 */
function stageIndexOf(title, capability) {
  const t = str(title);
  const cap = str(capability);
  if (/梳理|清单|诊断|定调|人设|标签|卖点|大纲|政策|策略|背书|资质|标准|规范/.test(t)) return 0;
  if (/生成|产出|内容|选题|文案|脚本|素材|科普|观点|课程/.test(t)) return 1;
  if (cap === 'media' || cap === 'activity') return 2;
  return 2;
}

/** 由动作标题 + 能力推导「产出物」文案（必须带宾语，禁「加强 / 优化」这类无宾语动词）。 */
function deriveDeliverable(title, capability) {
  const t = str(title);
  const cap = str(capability);
  if (/选题|大纲/.test(t)) return '一份选题 / 大纲表';
  if (/话术/.test(t)) return '一套可用话术';
  if (/脚本|口播/.test(t)) return '一版口播脚本';
  if (/文案|邀约/.test(t)) return '一版可发布的文案';
  if (/清单|名单/.test(t)) return '一份清单';
  if (/活动|沙龙/.test(t)) return '一个活动方案';
  if (/投放|分发|媒体/.test(t)) return '一份投放计划';
  if (/案例/.test(t)) return '一批可用案例';
  if (/规范|合规表达/.test(t)) return '一份合规表达规范';
  if (/内容|素材|观点|科普|品牌|形象/.test(t)) return '一批内容素材';
  if (/人设|标签|卖点|背书|资质/.test(t)) return '一套人设 / 卖点资料';
  if (/政策|策略/.test(t)) return '一版策略说明';
  return cap === 'activity' ? '一个可执行方案' : '一份可交付成果';
}

/**
 * 由方向模板的 actions[] 派生引导阶段清单（纯函数，无副作用）。
 *
 * 规则：
 *   - 每个模板动作按「标题关键词 + 能力」归入三个阶段之一；
 *   - 动作 id 形如 `<阶段id>-<序号>`（确定性 → 刷新后 planProgress 键稳定）；
 *   - 产出物由 deriveDeliverable 推导；
 *   - execModule 由能力映射（无映射则为空串 = 本页完成）；
 *   - 末尾过滤空阶段，保证 checklist 里不出现空块。
 *
 * @param {Array<{title?:string, capability?:string}>} actions 模板执行任务
 * @returns {Array<{id:string,title:string,goal:string,actions:Array}>}
 */
export function derivePlanSteps(actions) {
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && str(a.title));
  if (!list.length) return [];

  const stages = PLAN_STAGES.map((s) => ({ id: s.id, title: s.title, goal: s.goal, actions: [] }));
  list.forEach((a, idx) => {
    const cap = str(a.capability);
    const si = stageIndexOf(a.title, cap);
    const stepId = stages[si].id;
    stages[si].actions.push({
      id: `${stepId}-${idx + 1}`,
      title: str(a.title),
      deliverable: deriveDeliverable(a.title, cap),
      execModule: CAPABILITY_EXEC_MODULE[cap] || '',
    });
  });
  return stages.filter((s) => s.actions.length > 0);
}

/**
 * 由方向 key 生成完整经营方案（Direction + 主 Campaign 草案）。
 *
 * @param {string} directionKey DIRECTION_KEYS 之一
 * @param {Object} [opts] { subjectType, companyName, source }
 * @returns {{
 *   direction: Object,          // Direction 数据（不含 id/companyId，由 store 补齐）
 *   campaign: Object|null,      // 主 Campaign 草案（campaignDirector.draftCampaign 产物，不含 id/companyId/status）
 *   deliveryPlan: Object,       // 传播计划结构 { content, media, case }
 * }}
 */
export function buildDirection(directionKey, opts = {}) {
  const subjectType = opts.subjectType || 'manufacturer';
  const companyName = opts.companyName || '';
  const source = opts.source || 'onboarding';
  const now = asIso(opts.now) || new Date().toISOString();

  const plan = getDirectionByKey(subjectType, directionKey);
  if (!plan) return { direction: null, campaign: null, deliveryPlan: null };

  // 方向诊断（问题清单 + 优化路径）：按 key 复用，跨主体
  const diagnosis = getDirectionDiagnosis(plan.key);

  // 主 Campaign 草案：用方向的一句话喂 campaignDirector
  let campaign = null;
  try {
    const rec = recognizeCampaignIntent(plan.campaignHint, { subjectType, companyName });
    campaign = draftCampaign(rec, { source, briefText: plan.campaignHint });
    // 用方向名覆盖 campaign 名（更贴合老板选的方案）
    campaign = { ...campaign, name: `${plan.name} · ${rec.typeLabel}` };
  } catch (e) {
    campaign = null;
  }

  const direction = {
    name: plan.name,
    key: plan.key,
    summary: plan.summary,
    expectedPeriodDays: plan.expectedPeriodDays,
    // 诊断化（用户 2026-09-10 定调「运营方案要指出问题/怎么优化/多久达标」）
    problems: diagnosis.problems || [],
    optimization: diagnosis.optimization || [],
    targetCycleDays: plan.expectedPeriodDays, // 多久达标 = 模板预计周期
    status: 'active',
    campaignIds: [], // 主 Campaign id 由 store 创建后回填
    deliveryPlan: plan.deliveryPlan,
    actions: plan.actions,
    monitor: plan.monitor,
    // 引导执行清单（由模板 actions[] 派生；空进度）—— 老板第 3 条「选一套，一步步做」
    planSteps: derivePlanSteps(plan.actions),
    planProgress: {},
    createdAt: now,
    activatedAt: now,
    pausedAt: null,
  };

  return { direction, campaign, deliveryPlan: plan.deliveryPlan };
}

/**
 * 换方向：旧 Direction 转 paused（历史保留），新方向返回 active 模板。
 * 不做删除、不做数据迁移，只改 status。
 *
 * @param {Object} oldDirection 旧 Direction
 * @param {Object} newDirection buildDirection 产物里的新 direction
 * @returns {Object} 新 Direction（status=active）
 */
export function switchDirection(oldDirection, newDirection) {
  const old = oldDirection || {};
  const next = { ...(newDirection || {}) };
  return {
    ...next,
    status: 'active',
    // 旧方向的专项保留历史（不删除），但不再挂到新方向
    campaignIds: next.campaignIds || [],
    previousDirectionId: old.id || null,
    previousDirectionName: old.name || '',
    activatedAt: new Date().toISOString(),
  };
}

export default {
  buildDirection,
  switchDirection,
  derivePlanSteps,
  classifyDirectionKeyFromCompetitor,
  buildCompetitorDirection,
};

// ==================== 竞品差异化 → 经营方案（阶段D：竞品声量→运营方案闭环） ====================

/**
 * 竞品差异化 → 方向 key 规则（纯关键词映射，按优先级命中即止）。
 * 输入是竞品分析已产出的「关键发现 findings + 机会点 opportunities」文本，
 * 输出最贴切的 DIRECTION_KEYS 之一；未命中返回 null（由调用方兜底到主体首个方向）。
 */
const COMPETITOR_DIRECTION_RULES = [
  { key: DIRECTION_KEYS.GROWTH, pattern: /获客|引流|到店|新客|患者|线索|转化|流量|粉丝|进店/ },
  { key: DIRECTION_KEYS.LAUNCH, pattern: /新品|种植体|正畸|矫治|新品发布|上新|产品上市|项目推广/ },
  { key: DIRECTION_KEYS.GEO, pattern: /搜索|曝光|SEO|GEO|AI搜索|可见性|场景|选型|内容分发|知乎|小红书/ },
  { key: DIRECTION_KEYS.BRAND, pattern: /品牌|口碑|信任|声量|媒体|权威|背书|舆情|行业影响力/ },
  { key: DIRECTION_KEYS.CHANNEL, pattern: /招商|渠道|经销|商家|加盟|代理|分销/ },
  { key: DIRECTION_KEYS.DOCTOR_IP, pattern: /医生|专家|IP|科普|讲师|院长|个人品牌/ },
  { key: DIRECTION_KEYS.PRIVATE, pattern: /复购|私域|会员|老客|留存|转介绍|召回/ },
];

/** 把竞品 findings + opportunities 文本映射到方向 key（纯函数，无 AI）。 */
export function classifyDirectionKeyFromCompetitor(findings, opportunities) {
  const finds = Array.isArray(findings) ? findings : [];
  const opps = Array.isArray(opportunities) ? opportunities : [];
  const hay = finds.concat(opps).map((x) => {
    const o = x || {};
    return [o.title, o.detail, o.action, o.basis, o.expected].filter(Boolean).join(' ');
  }).join(' ');
  for (const rule of COMPETITOR_DIRECTION_RULES) {
    if (rule.pattern.test(hay)) return rule.key;
  }
  return null;
}

/**
 * 基于竞品差异化搭建经营方案（Direction + 主 Campaign 草案）。
 * 竞品 findings（差异/差距/结论）→ direction.problems；opportunities（机会/动作）→ direction.optimization。
 * 选出的方向 key 若该主体无模板，兜底到该主体首个方向，保证 buildDirection 能命中。
 *
 * @param {Array} findings 竞品分析「关键发现」（差异化/差距）
 * @param {Array} opportunities 竞品分析「机会点」
 * @param {Object} [opts] { subjectType, companyName, source }
 * @returns {{ direction: Object|null, campaign: Object|null, sourceKey: string }}
 */
export function buildCompetitorDirection(findings, opportunities, opts = {}) {
  const subjectType = opts.subjectType || 'manufacturer';
  const companyName = opts.companyName || '';
  const finds = Array.isArray(findings) ? findings : [];
  const opps = Array.isArray(opportunities) ? opportunities : [];

  // 1) 选方向 key；该主体无此模板则兜底到主体首个方向
  let key = classifyDirectionKeyFromCompetitor(finds, opps);
  if (!key || !getDirectionByKey(subjectType, key)) {
    const dirs = getDirections(subjectType);
    key = dirs.length ? dirs[0].key : DIRECTION_KEYS.GROWTH;
  }

  // 2) 基础方向（含模板诊断）
  const built = buildDirection(key, { subjectType, companyName, source: opts.source });
  if (!built.direction) return { direction: null, campaign: null, sourceKey: key };

  // 3) 竞品差异化覆盖诊断：findings → problems，opportunities → optimization
  const problems = finds.map((f) => {
    const t = (f && f.title) || '';
    const d = (f && f.detail) || '';
    return t ? (t + (d ? '：' + d : '')) : d;
  }).filter((s) => String(s || '').trim());

  const optimization = opps.map((o) => {
    const t = (o && (o.title || o.action)) || '';
    const e = (o && o.expected) || '';
    return t ? (t + (e ? ' → ' + e : '')) : e;
  }).filter((s) => String(s || '').trim());

  const direction = {
    ...built.direction,
    // 竞品差异化太少时保留模板诊断，避免空
    problems: problems.length ? problems : built.direction.problems,
    optimization: optimization.length ? optimization : built.direction.optimization,
    summary: (built.direction.summary || '') + '（基于竞品对比差异化定制）',
  };

  return { direction, campaign: built.campaign, sourceKey: key };
}
