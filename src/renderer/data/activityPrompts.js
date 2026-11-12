/**
 * AI 活动总监 · Prompt 动态组装层
 * ============================================================================
 *
 * 设计依据：docs/ACTIVITY-DIRECTOR-DESIGN.md §13「AI Prompt 动态组装逻辑」。
 *
 * 这是「AI 活动总监」唯一一处拼装发给大模型的 Prompt 的地方。services/activityDirector.js
 * 只负责调用 chatOnce / extractJSON，具体的「说什么」全部来自本文件。
 *
 * ── 核心设计原则（§13.1）：不能再是一套通用 Prompt ──
 * Prompt 由 7 个 Block 组装，其中 4 个强制差异化、随「主体 / 目标」变化：
 *   ① BASE_RULES     通用硬约束（所有调用必带）
 *   ② SUBJECT_BLOCK  主体身份段（强制差异化）★ —— 含该主体的禁用项
 *   ③ GOAL_BLOCK     目标段 + 该目标常见误区（强制差异化）★
 *   ④ FORM_BLOCK     形式执行维度（offline / online / hybrid）
 *   ⑤ TEMPLATE_BLOCK 场景参考（可选注入，标注可调整）
 *   ⑥ STEP_CONTRACT  当前步骤的输出契约（JSON Schema）★
 *   ⑦ CONTEXT        四层业务上下文（由调用方 buildAIContext 预拼好传入）
 *
 * ── 工程红线（验收口径，写在注释里自检，也写进 Prompt 层）──
 *   1. 四主体完全分化：靠 SUBJECT_NEGATIVE_RULES + buildSubjectBlock 在结构层保证。
 *      厂家 prompt 不得出现患者到店/留资；门诊不得默认经销商招商；
 *      医生不得套企业招商模型；平台不得用患者获客模型。
 *   2. 不编造效果：所有数字只给区间 + ASSUMPTION_RULE 标注「策划假设」。
 *   3. 七步第一步是「谁在办」（主体），不是「线上还是线下」。
 *   4. 第一版不做自动化（自动邀约/发微信/投放/成交/多 Agent），prompt 不引导 AI 生成这些。
 *
 * 本文件为纯函数层：不 import React、不读写 localStorage、不发网络请求。
 */

import {
  ACTIVITY_SUBJECTS,
  DEFAULT_SUBJECT,
  getSubjectNegativeRules,
  buildSubjectNegativeText,
  buildDoctorIdentityLabel,
  buildActivitySubjectContext,
} from '../config/activitySubjects.js';
import {
  getGoal,
  getGoalPitfall,
  buildCustomGoal,
  SUBJECT_FALLBACK_KPI,
} from '../config/activityGoals.js';
import {
  getTemplate,
} from '../config/activityTemplates.js';
import {
  getKpis,
  getKpi,
} from '../config/activityMetrics.js';
import {
  BUDGET_DISCLAIMER,
} from '../config/activityBudget.js';

/* ============================================================================
 * ① 通用硬约束集（所有 8 个 AI 能力调用都必须注入，且不可被覆盖）
 * ==========================================================================*/

/**
 * 活动 AI 通用底座规则（合规 + 不编造 + 三段式）。
 * 直接来自设计文档 §13.2 ①，作为所有调用的第一段硬约束。
 * @type {string}
 */
export const ACTIVITY_BASE_RULES = [
  '【真实原则】每一个主要设计都必须回答「为什么这么办」，而不只是「怎么办」；',
  '  每个主要设计至少给出三要素：目的（解决什么问题）/ 依据（凭什么这么判断）/ 预期作用（期望带来什么变化）。',
  '【不编造】禁止输出伪装精确的效果预测（如「预计转化率 35%」「预计带来 200 个到店」）。',
  '  需要量化时，只能给「建议目标区间」或明确写「需要根据历史活动数据确定」。没有历史数据不得伪造。',
  '【假设标注】所有预测、区间、系数必须显式标注为「策划假设」，并说明依据来源（行业经验 / 本企业历史 / 用户设定）。',
  '【事实与推测分离】企业已知事实与你的推测必须分开写，推测前必须加「推测：」。',
  '【医疗合规】不得承诺或暗示疗效，不得出现绝对化用语，不得编造案例、数据、专家评价。',
  '【信息不足】信息不足时写「待补充：X」，禁止自行补全为事实。',
].join('\n');

/**
 * 假设标注规则（所有区间/预估必须标「策划假设」）。与 BASE_RULES 中的同义条目呼应，
 * 单独抽出以便调用方按需强注入。
 * @type {string}
 */
export const ASSUMPTION_RULE = [
  '【假设标注 · 强制】所有预测、区间、系数、漏斗目标值，必须显式标注「策划假设」并写明依据来源',
  '  （行业经验 / 本企业历史 / 用户设定），没有数据支撑的结论严禁写成确定数字。',
  '  区间一律给 [min, max]，不给出单点估计；如确无依据，写「待补充：X」。',
].join('\n');

/**
 * 真实原则规则（每个设计都必须回答「为什么」）。沿用设计口径，单独抽出以便强注入。
 * @type {string}
 */
export const REASON_RULE = [
  '【真实原则 · 强制】每一项主要设计都必须先讲「为什么这么办」再讲「怎么办」，至少包含三要素：',
  '  目的（解决什么业务问题）/ 依据（凭什么这么判断，来自主体资源还是行业惯例）/ 预期作用（期望带来什么变化）。',
  '  只写「怎么办」不写「为什么」的设计视为不合格。',
].join('\n');

/**
 * 事实与推测分离规则（企业已知事实 vs 你的推测）。沿用设计口径，单独抽出以便强注入。
 * @type {string}
 */
export const FACT_RULE = [
  '【事实与推测分离 · 强制】企业已知事实与你的推测必须分开书写：',
  '  已知事实直接陈述；推测前必须加「推测：」前缀；信息不足时写「待补充：X」，禁止自行补全为既定事实。',
].join('\n');

/**
 * 主体禁止项硬约束（§13.3 的 NEGATIVE_RULE）。这是一个「口径」常量：
 * 真正按主体取具体禁用条目的是 getSubjectNegativeRules(subject)，由 assembleActivityPrompt
 * 无条件注入。此处导出一个统一的标题/说明，便于调用方直接拼接。
 * @type {string}
 */
export const NEGATIVE_RULE = [
  '【主体禁止项 · 无条件生效】以下禁止项来自 SUBJECT_NEGATIVE_RULES，违反任意一条即判不合格，',
  '  不论本次目标或形式如何都不允许突破：',
].join('\n');

/* ============================================================================
 * ② 主体 Block（强制差异化）
 * ==========================================================================*/

/**
 * 构造「活动主体」身份段 Prompt（含该主体的目标/形式/禁用项）。
 *
 * 这是四主体分化的主落点：主体不同 → audience / 资源约束 / 允许 KPI 字段 / 禁止项全部不同。
 * 设计文档 §13.2 ②。doctor 主体可传入 identity 以渲染「口腔医生」展示名。
 *
 * @param {string} subject 主体 key（manufacturer|clinic|doctor|platform），异常时回退 DEFAULT_SUBJECT
 * @param {Object} [options] 可选参数
 * @param {Object} [options.identity] DoctorIdentity（仅 doctor 主体用到）
 * @param {string} [options.note] 来自活动快照的补充约束文本
 * @param {string} [options.companyName] 机构/厂家/平台主体时的企业名
 * @returns {string} 多行 Prompt 文本块
 */
export function buildSubjectBlock(subject, options = {}) {
  const subjectType = ACTIVITY_SUBJECTS[subject] ? subject : DEFAULT_SUBJECT;
  const meta = ACTIVITY_SUBJECTS[subjectType];
  const opts = options && typeof options === 'object' ? options : {};

  // 只允许使用本主体的 KPI 字段（物理层防跨主体指标漂移，§8.5）。
  const kpiList = getKpis(subjectType)
    .map((k) => `${k.label}(${k.key})`)
    .join('、');

  const lines = [];
  lines.push('【活动主体】（第一步：先明确「谁在办」，再谈形式）');
  lines.push(`- 组织者类型：${meta.label}`);
  lines.push(`- 主体定位：${meta.desc}`);
  lines.push(`- 活动对象：${meta.audience}`);
  lines.push(`- 资源约束：${meta.constraint}`);
  lines.push('- 你的判断起点：围绕「这家企业有什么资源、缺什么」来设计，不要套通用活动模板；');
  lines.push('  形式（线上/线下）是第二步才决定的事，不能反过来用形式定义主体。');
  lines.push(`- 可用 KPI 字段（严禁自创跨主体指标，如厂家不得出现患者到店/留资、平台不得用患者获客指标）：${kpiList}`);

  // doctor 主体：渲染个人身份，并强调不得默认占用挂靠机构资源（§1.4）。
  if (subjectType === 'doctor' && opts.identity) {
    const label = buildDoctorIdentityLabel(opts.identity);
    if (label) lines.push(`- 本次组织者：${label}`);
    const affiliation = String(opts.identity.affiliation || '').trim();
    if (affiliation) {
      lines.push(`- 注意：不得把挂靠机构（${affiliation}）的场地、预算、团队、患者池默认算作本次活动资源，` +
        '除非用户明确说明由机构支持。');
    }
  } else if (opts.companyName) {
    lines.push(`- 本次组织者：${String(opts.companyName).trim()}`);
  }

  // 禁止事项（硬性）—— 直接来自 SUBJECT_NEGATIVE_RULES，无条件注入。
  const negative = buildSubjectNegativeText(subjectType);
  lines.push('【禁止事项】（硬性，违反即判不合格）');
  if (negative) {
    lines.push(negative);
  } else {
    lines.push('- （该主体暂无额外禁止项）');
  }

  if (opts.note) lines.push(`- 补充约束：${String(opts.note).trim()}`);

  return lines.join('\n');
}

/* ============================================================================
 * ③ 目标 Block（强制差异化）
 * ==========================================================================*/

/**
 * 构造「本次活动目标」段 Prompt（含该目标的含义 / 主 KPI / 推荐形式 / 常见误区）。
 * 设计文档 §13.2 ③。
 *
 * @param {string} subject 主体 key
 * @param {string} goalKey 目标 key（含 'custom'）
 * @param {string} [goalText] 自定义目标文本（仅当 goalKey === 'custom' 时使用）
 * @returns {string} 多行 Prompt 文本块
 */
export function buildGoalBlock(subject, goalKey, goalText) {
  const subjectType = ACTIVITY_SUBJECTS[subject] ? subject : DEFAULT_SUBJECT;
  const resolved = subjectType === 'custom' || goalKey === 'custom'
    ? buildCustomGoal(subjectType, goalText)
    : getGoal(subjectType, goalKey);

  const lines = [];
  lines.push('【本次活动目标】');

  if (!resolved) {
    // 兜底：取不到目标时，用主体兜底 KPI 给一个安全占位，并提醒 AI 向用户确认。
    const fbKpi = getKpi(subjectType, SUBJECT_FALLBACK_KPI[subjectType]);
    lines.push(`- 目标：未识别（goalKey=${goalKey || '空'}），待补充：请向用户确认本次活动目标`);
    if (fbKpi) lines.push(`- 主 KPI（兜底）：${fbKpi.label}(${fbKpi.key})`);
    lines.push('- 常见误区：未明确目标前，不得套用任何主体的标准误区清单；先确认目标再设计。');
    return lines.join('\n');
  }

  const primaryKpi = getKpi(subjectType, resolved.primaryKpi);
  lines.push(`- 目标：${resolved.label}（${resolved.key}）`);
  lines.push(`- 含义：${resolved.desc}`);
  lines.push(`- 主 KPI：${primaryKpi ? `${primaryKpi.label}(${primaryKpi.key})` : resolved.primaryKpi}`);
  lines.push(`- 默认推荐形式：${resolved.defaultForm}`);
  lines.push(`- 这个目标常见的错误做法（你必须避免）：${resolved.pitfall || '（无）'}`);
  lines.push('- 成功判据：以主 KPI 是否达成 + 是否有明确「下一步动作」来衡量，' +
    '不得用与主体不匹配的指标（如厂家用患者到店、平台用患者获客）充当成功判据。');

  return lines.join('\n');
}

/* ============================================================================
 * ④ 形式 Block（offline / online / hybrid）
 * ==========================================================================*/

/**
 * 形式执行维度约束块。保留旧 offline/online Prompt 的「执行维度精华」
 * （现场 SOP / 物料清单 / 风险预案 / 推流开播前后 / 互动 / 数据追踪），
 * 去掉与主体无关的通用套话；hybrid 增加双线 KPI 不得混算的硬约束。
 *
 * 注意：形式只是执行维度，不是第一决策。设计文档 §13.3 红线 3：第一步是主体。
 * @type {Object<string, string>}
 */
export const FORM_BLOCKS = {
  offline: [
    '【形式：线下】请按「现场可落地」的颗粒度设计：',
    '1. 场地：明确分区（签到区 / 主会场 / 互动体验区 / 产品/洽谈区 / 媒体区 / 后台）与人员动线，说明每区功能与设计重点。',
    '2. 现场执行 SOP：细化到「时间｜环节｜具体内容｜负责人｜所需物料｜注意事项」，至少包含签到、开场、核心内容、互动、展示、合影/离场、会后跟进。',
    '3. 现场岗位：主持人 / 摄影摄像 / 灯光 / 音响 / 舞美 / 安保 / 接待 / 嘉宾管理 / 后勤 / 医疗应急，每个岗位一段职责。',
    '4. 物料清单：物料名｜数量｜用途｜制作时间｜负责人｜预估费用，遵循「策划建议比例，非实际报价」口径。',
    '5. 风险预案：至少覆盖嘉宾缺席 / 设备故障 / 停电 / 网络 / 天气 / 拥堵 / 受伤 / 超时 / 物料缺失 / 舆情，每条含「预防措施 + 现场处理 + 责任人」。',
    '6. 不得设计任何自动邀约、自动群发、自动投放等自动化动作（第一版不做自动化）。',
  ].join('\n'),

  online: [
    '【形式：线上】请按「可追踪、可互动」的颗粒度设计：',
    '1. 平台与推流：明确主平台与推流/分发方式，区分曝光目标、参与目标、转化目标，不唯观看人数。',
    '2. 开播前 / 中 / 后：分别设计预热（预告+预约）、进行（实时互动+评论区运营）、收尾（精彩回顾+数据海报+UGC+线索跟进）。',
    '3. 互动机制：互动玩法、分享/裂变机制、奖励机制、留资机制，避免「直播+讲话+抽奖」传统模式。',
    '4. 预约与提醒：预约入口、开播前提醒、未到场召回，给出具体工具与负责人。',
    '5. 数据追踪：曝光量 / 观看 / 互动 / 分享 / 新增 / 留资（仅允许当前主体口径）分别定义口径，不得混用他主体指标。',
    '6. 不得设计自动投放、自动成交等自动化动作（第一版不做自动化）。',
  ].join('\n'),

  hybrid: [
    '【形式：线上 + 线下（hybrid）】同时满足线下主会场与线上观看两端，且：',
    '1. 线下主会场 KPI 与线上观看 KPI 必须分开统计，不得混算（如到场人数与观看人数不能相加成「总参与」）。',
    '2. 线下部分按「形式：线下」的场地/ SOP / 岗位 / 物料 / 风险设计；线上部分按「形式：线上」的推流 / 互动 / 追踪设计。',
    '3. 双线分工：明确哪些环节只在线下、哪些只线上、哪些双线同步，并指定两端各自的负责人。',
    '4. 不得设计自动邀约、自动投放、自动成交等自动化动作（第一版不做自动化）。',
  ].join('\n'),
};

/**
 * 兼容导出（legacy）：offlinePrompt / onlinePrompt。
 *
 * 设计文档 §13.4 指出现有 `offlinePrompt + onlinePrompt` 两段 PDF verbatim 直接拼接、与主体/目标无关，
 * 是反模式，已被 7-Block 组装（assembleActivityPrompt）取代。但以下两处仍引用这两个名字，
 * 且并行开发的 services/activityDirector.js 明确「offlinePrompt / onlinePrompt 无需改动、保留执行维度精华」：
 *   - src/renderer/capabilities/real.js（通用活动能力，按 线上/线下/整合 策略取用）
 *   - src/renderer/modules/ActivityPlanning.jsx（旧活动规划模块）
 *   - src/renderer/services/activityDirector.js（AI 活动总监，引用作形式执行维度）
 *
 * 因此这里不恢复 PDF verbatim 全文，而是把这两个名字映射到「形式执行维度精华」：
 *   offlinePrompt = FORM_BLOCKS.offline，onlinePrompt = FORM_BLOCKS.online。
 * 新代码请直接使用 assembleActivityPrompt() / FORM_BLOCKS，不要再依赖本兼容别名。
 */
export const offlinePrompt = FORM_BLOCKS.offline;
export const onlinePrompt = FORM_BLOCKS.online;

/* ============================================================================
 * ⑤ 场景模板 Block（可选注入，标注可调整）
 * ==========================================================================*/

/**
 * 把一条 ActivityTemplate 渲染成「行业场景参考」Prompt（设计文档 §13.2 ⑤）。
 * 明确标注「仅供参考，必须按企业实际资源增删调整，禁止原样照抄」。
 *
 * @param {Object|string} template ActivityTemplate 对象，或其 key（内部用 getTemplate 解析）
 * @returns {string} 多行 Prompt 文本块；模板不存在时返回空字符串
 */
export function buildTemplateBlock(template) {
  const tpl = typeof template === 'string' ? getTemplate(template) : template;
  if (!tpl || typeof tpl !== 'object' || !tpl.key) return '';

  const stages = Array.isArray(tpl.stages)
    ? tpl.stages.map((s) => `- ${s.name}（目的：${s.purpose}）`).join('\n')
    : '（无）';
  const tasks = Array.isArray(tpl.tasks)
    ? tpl.tasks.map((s) => `- [${s.phase}] ${s.title}（why：${s.why}）`).join('\n')
    : '（无）';
  const risks = Array.isArray(tpl.risks)
    ? tpl.risks.map((s) => `- ${s.risk}（预防：${s.prevent}）`).join('\n')
    : '（无）';
  const kpis = Array.isArray(tpl.kpis) && tpl.kpis.length
    ? tpl.kpis.join('、')
    : '（无）';

  const lines = [];
  lines.push('【行业场景参考（仅供理解惯例，你必须按实际情况重新设计）】');
  lines.push(`场景：${tpl.label}`);
  lines.push(`典型规模：${tpl.scale}｜典型预算级别：${tpl.budgetLevel}｜常见对象：${tpl.audience || '（见主体）'}`);
  lines.push('常见环节：');
  lines.push(stages);
  lines.push('常见任务：');
  lines.push(tasks);
  lines.push('常见风险：');
  lines.push(risks);
  lines.push(`常见 KPI：${kpis}`);
  lines.push(`为什么这类目标常选它：${tpl.whyFit || '（无）'}`);
  lines.push('⚠️ 以上仅供参考：你必须结合当前企业的资源、预算、时间、团队能力增删调整，禁止原样照抄输出。');
  return lines.join('\n');
}

/* ============================================================================
 * ⑥ 七步 / 八能力 输出契约（对齐 §13.3 表）
 * ==========================================================================*/

/**
 * 每个 AI 能力的输出契约（JSON Schema / Markdown 约定）。key 即 assembleActivityPrompt
 * 的 step 入参值。所有契约都重申：区间标「策划假设」、不得编造效果、不得生成自动化动作。
 *
 * 来源：设计文档 §13.3 表（temperature 等由 services/activityDirector.js 控制，这里只定输出形状）。
 * @type {Object<string, string>}
 */
export const STEP_CONTRACTS = {
  // 步骤 3：推荐方向（3 个）
  recommendDirections: [
    '【输出格式：严格 JSON】为当前主体推荐 3 个活动方向，每个方向必须结合主体资源约束给出为什么合理：',
    '{\n  "directions": [\n    {\n      "key": "snake_case",\n      "title": "方向名",\n      "mechanism": "核心机制（一段话）",\n      "fitScenarios": "适合什么资源/预算/阶段",\n      "pros": ["优势1","优势2"],\n      "risks": ["风险1","风险2"],\n      "resourceNeeds": "需要什么资源",\n      "budgetLevel": "low|mid|high（定性，禁止写金额）",\n      "bestForGoals": ["goalKey"],\n      "form": "offline|online|hybrid",\n      "why": "为什么这个主体用这个方向更合理"\n    }\n  ]\n}',
    '要求：必须返回 3 个；不得出现跨主体指标；budgetLevel 只给定性级别；每个方向含 why。',
  ].join('\n'),

  // 步骤 5：目标倒推校准（本地先算，AI 只校准 + 提示风险）
  calibrateReverseGoal: [
    '【输出格式：严格 JSON】本地已先算出漏斗目标区间，你只做校准与风险提示，不要重算点估计：',
    '{\n  "adjustments": [\n    { "stage": "漏斗阶段名", "suggestedRange": [a, b], "note": "策划假设：依据来源..." }\n  ],\n  "overallNote": "整体说明",\n  "missingInfo": ["待补充：X"]\n}',
    '要求：suggestedRange 必须是 [min,max] 区间，不得给单点；note 必须标「策划假设」与依据来源；' +
    '缺数据写 missingInfo；不得编造任何确定数字。',
  ].join('\n'),

  // 步骤 6：活动前中后动作
  genCampaign: [
    '【输出格式：严格 JSON】产出活动前(pre)/中(on)/后(post)三段时间盒动作：',
    '{\n  "pre":  [ { "action":"动作","purpose":"目的","basis":"依据","expected":"预期作用","channel":"触点","ownerHint":"负责人建议" } ],\n' +
    '  "on":   [ ... 同上结构 ],\n  "post": [ ... 同上结构 ]\n}',
    '要求：pre/on/post 三段齐全；活动后(post)不得弱于前两段（这是常见短板）；' +
    '每个 action 必须带 purpose/basis/expected 三要素；不得设计自动邀约/自动发微信等自动化动作。',
  ].join('\n'),

  // 步骤 7：方案版（Markdown）
  genPlanVersion: [
    '【输出格式：Markdown，不要 JSON】按以下章节输出活动方案：',
    '活动背景 / 目标 / 核心创意 / 活动机制 / 用户路径 / 传播方案 / 预算 / KPI。',
    `要求：所有数字为区间或「待补充」；KPI 只用当前主体允许字段；预算引用口径：「${BUDGET_DISCLAIMER}」；` +
    '不得编造效果、不得出现绝对化医疗表述。',
  ].join('\n'),

  // 步骤 7：执行版（Markdown）
  genExecVersion: [
    '【输出格式：Markdown，不要 JSON】按以下章节输出执行手册：',
    '时间 / 环节 / 负责人 / 物料 / 场地 / 注意事项 / 嘉宾 / 摄影 / 后勤 / 风险 + 现场 SOP。',
    '要求：现场 SOP 必须细化到岗位与动线；风险含「预防措施 + 现场处理 + 责任人」；不涉及自动投放/自动成交。',
  ].join('\n'),

  // 素材（材料）
  genMaterials: [
    '【输出格式：严格 JSON】产出物料清单：',
    '{\n  "items": [ { "type":"物料类型","title":"标题","content":"内容/文案","note":"AI 建议，需运营审核" } ]\n}',
    '要求：每条 note 固定为「AI 建议，需运营审核」；不得生成需自动群发/自动发布的动作。',
  ].join('\n'),

  // 复盘
  genReview: [
    '【输出格式：严格 JSON】对活动做复盘：',
    '{\n  "good":["做得好"], "problems":["问题"], "causes":["原因"], "improvements":["改进"]\n}',
    '要求：problems 与 improvements 一一对应；只基于已录入的实际数据，不得编造效果。',
  ].join('\n'),

  // 联动：筹备风险
  genPreparationRisk: [
    '【输出格式：严格 JSON】评估筹备风险：',
    '{\n  "level":"low|mid|high", "findings":[ { "finding":"发现","basis":"依据" } ], "suggestions":["建议"]\n}',
    '要求：level 为定性；finding 必须带 basis；不得把建议写成自动化执行指令。',
  ].join('\n'),
};

/* ============================================================================
 * ⑦ 组装主函数
 * ==========================================================================*/

/**
 * 组装最终发给 AI 的 Prompt 字符串（设计文档 §13.2 的 7 Block 顺序 + §13.3 硬约束集）。
 *
 * 关键不变量：
 *  - SUBJECT_NEGATIVE_RULES 无条件注入（getSubjectNegativeRules(subject) 取四主体各自禁用项）。
 *  - 主体 Block、目标 Block 随主体/目标强制差异化。
 *  - BASE_RULES + ASSUMPTION_RULE + REASON_RULE + FACT_RULE 每次必带。
 *
 * @param {Object} params 组装入参
 * @param {string} params.subject 主体 key（manufacturer|clinic|doctor|platform）
 * @param {string} [params.goalKey] 目标 key（含 'custom'）
 * @param {string} [params.goalText] 自定义目标文本（goalKey==='custom' 时使用）
 * @param {'offline'|'online'|'hybrid'} [params.form] 形式执行维度
 * @param {Object|string} [params.template] 场景模板（ActivityTemplate 对象或其 key）
 * @param {string} [params.step] STEP_CONTRACTS 的 key（指定本次调用的输出契约）
 * @param {Object} [params.identity] DoctorIdentity（仅 doctor 主体）
 * @param {string} [params.companyName] 机构/厂家/平台主体时的企业名
 * @param {string} [params.note] 补充约束（落库快照里的备注）
 * @param {string} [params.context] 调用方已用 buildAIContext 预拼好的四层业务上下文（⑦ CONTEXT）
 * @param {string} [params.subjectContext] 覆盖用主体上下文（一般不传，由 buildSubjectBlock 生成）
 * @returns {string} 最终 Prompt
 */
export function assembleActivityPrompt(params = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const subjectType = ACTIVITY_SUBJECTS[p.subject] ? p.subject : DEFAULT_SUBJECT;

  const blocks = [];

  // ── ① 通用硬约束集（必带，且不可被后续 Block 覆盖）──
  blocks.push('===== 通用硬约束（所有活动 AI 调用必带）=====');
  blocks.push(ACTIVITY_BASE_RULES);
  blocks.push(ASSUMPTION_RULE);
  blocks.push(REASON_RULE);
  blocks.push(FACT_RULE);

  // ── 主体禁止项（无条件注入，§13.3 红线 1 的 Prompt 层落点）──
  const negLines = getSubjectNegativeRules(subjectType);
  blocks.push('===== 主体禁止项（无条件生效）=====');
  blocks.push(NEGATIVE_RULE);
  if (negLines.length) {
    blocks.push(negLines.map((line) => `- ${line}`).join('\n'));
  } else {
    blocks.push('- （该主体暂无额外禁止项）');
  }

  // ── ② 主体 Block（强制差异化）──
  blocks.push('===== ② 活动主体（谁在办）=====');
  blocks.push(buildSubjectBlock(subjectType, {
    identity: p.identity,
    note: p.note,
    companyName: p.companyName,
  }));

  // ── ③ 目标 Block（强制差异化）──
  if (p.goalKey) {
    blocks.push('===== ③ 活动目标 =====');
    blocks.push(buildGoalBlock(subjectType, p.goalKey, p.goalText));
  }

  // ── ④ 形式 Block ──
  if (p.form && FORM_BLOCKS[p.form]) {
    blocks.push(`===== ④ 执行形式（${p.form}）=====`);
    blocks.push(FORM_BLOCKS[p.form]);
  }

  // ── ⑤ 模板 Block（可选）──
  if (p.template) {
    const tplText = buildTemplateBlock(p.template);
    if (tplText) {
      blocks.push('===== ⑤ 行业场景参考 =====');
      blocks.push(tplText);
    }
  }

  // ── ⑥ 步骤输出契约（STEP_CONTRACTS）──
  if (p.step && STEP_CONTRACTS[p.step]) {
    blocks.push(`===== ⑥ 本次输出契约（step=${p.step}）=====`);
    blocks.push(STEP_CONTRACTS[p.step]);
  } else if (p.step) {
    // 未知 step：给出可用 key 提示，避免静默拼空。
    blocks.push(`===== ⑥ 本次输出契约（未知 step=${p.step}，可用：${Object.keys(STEP_CONTRACTS).join('/')}）=====`);
  }

  // ── ⑦ CONTEXT（调用方预拼的四层业务上下文）──
  if (p.context && String(p.context).trim()) {
    blocks.push('===== ⑦ 业务上下文（企业/资产/知识/项目/角色）=====');
    blocks.push(String(p.context).trim());
  }

  // ── 收尾：再强调一次红线，确保不被长上下文稀释 ──
  blocks.push('===== 最终提醒 =====');
  blocks.push('再次确认：所有数字为区间并标注「策划假设」；不得编造效果；不得生成自动邀约/发微信/投放/成交等自动化动作；' +
    '本主体禁止项无条件生效。');

  return blocks.join('\n\n');
}

export default {
  ACTIVITY_BASE_RULES,
  ASSUMPTION_RULE,
  REASON_RULE,
  FACT_RULE,
  NEGATIVE_RULE,
  offlinePrompt,
  onlinePrompt,
  buildSubjectBlock,
  buildGoalBlock,
  FORM_BLOCKS,
  buildTemplateBlock,
  STEP_CONTRACTS,
  assembleActivityPrompt,
};
