/**
 * moduleAssistant —— 「本页智能助手」的 AI 服务。
 *
 * 复用 buildAIContext + chatOnce + extractJSON，不新建 Prompt 体系（与 knowledgeAI.js 同范式）。
 * 两个能力：
 * - guideTurn      豆芽以「企业运营负责人」口吻做引导：先给判断 → 再讲为什么现在做 → 最后给可点击动作。
 *                  支持多轮追问（history + question）。**面板主能力**。
 * - interpretPage  旧的「本页解读」单轮版，保留兼容（已无 UI 调用；勿新增调用方）。
 *
 * 设计口径：
 *  - 页面事实由系统提供（focalFacts，来自 services/moduleBrief.buildBrief），模型只做判断与建议，
 *    不得编造数字 / 案例 / 疗效 / 来源；
 *  - 信息不足时如实说明「信息不足」，不得臆测；
 *  - actions[].module 只能取 MODULE_NEXT_TARGETS[moduleKey] 白名单内的 key，解析后再过滤（不信模型自律）；
 *  - 失败一律返回 { ok:false, error }，绝不返回假内容（本项目历史红线：宁可失败，不许编）。
 *
 * 本文件不 import React。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';

/** 模块 key → 中文名（用于面板徽标、解读标题、下一步目标副文本）。含隐藏但可达的模块，禁止出现「工作台」兜底。 */
// 【2026-10-12 界面整顿 P2】与 ModuleNav.MODULE_GROUPS 的显示名同步改名，避免
// 「左侧叫竞品分析、本页徽标叫经营诊断」这种同一件事两个名字的割裂。
// 未改的：profile（老板此前点名要求叫「你的企业资产库」）、learn、workbench、miaomiao。
export const MODULE_LABELS = {
  activity: '做活动方案',
  daily: '日常内容',
  learn: '学习中心',
  project: '项目',
  goal: '目标',
  asset: '资产库',
  brain: '企业大脑',
  media: '媒体投放',
  huodong: '活动列表与向导',
  campaign: '营销专项',
  direction: '经营方案',
  crisis: '舆情危机',
  competitor: '竞品分析',
  geo: 'GEO诊断',
  content: '内容创作',
  profile: '你的企业资产库',
  newmedia: '媒体与报价',
  intel: '竞品分析',
  miaomiao: '上游货源档期',
  xinmeiti: '新媒体',
  workbench: '豆芽对话',
};

/**
 * 每个模块允许建议的「跳转目标」白名单（按业务链路设计）。
 * 解读结果的 nextSteps[].module 只能落在这里面，否则被过滤掉。
 *
 * 【0.21.21 · 老板 2026-10-21】「活动与档期」整板块下线后，本表里的 `activity` / `miaomiao`
 * 已不是存在的模块。这里**故意不改数据**，理由：
 *   · 唯一的消费者是 `components/ModuleAssistant.jsx`，而它自第十一轮起就一直没挂载
 *     （`App.jsx` 的 `SHOW_GLOBAL_ASSISTANT = false`）⇒ 这段数据当前不会流出到界面；
 *   · 真要复活这个助手时，跳转仍不会白屏：`App.jsx` 的 LEGACY_MODULE_ALIAS 把
 *     `activity → workbench`、`miaomiao → workbench`、`huodong → campaign` 都兜住了；
 *   · 现在就改数据反而会造出「campaign → ['campaign', …]」这种自指条目。
 * ⚠️ 但**如果你把 ModuleAssistant 挂回来**，请先把 `activity` 换成 `campaign`
 *    （做活动方案的新家），否则用户点建议会落到豆芽助手 —— 不白屏，但跳错地方。
 */
export const MODULE_NEXT_TARGETS = {
  activity: ['direction', 'campaign', 'intel'],
  direction: ['activity', 'content', 'campaign'],
  content: ['newmedia', 'activity', 'intel'],
  newmedia: ['content', 'intel', 'activity'],
  intel: ['direction', 'content', 'newmedia', 'activity'],
  profile: ['activity', 'direction', 'intel'],
  brain: ['activity', 'direction', 'intel'],
  campaign: ['activity', 'content', 'direction'],
  crisis: ['intel', 'content', 'activity'],
  competitor: ['intel', 'content', 'direction'],
  daily: ['content', 'activity', 'newmedia'],
  media: ['content', 'newmedia', 'activity'],
  huodong: ['campaign', 'content', 'activity'],
  learn: ['intel', 'profile', 'activity'],
  geo: ['content', 'intel', 'activity'],
  project: ['activity', 'campaign', 'direction'],
  goal: ['activity', 'direction', 'campaign'],
  asset: ['content', 'activity', 'newmedia'],
  xinmeiti: ['content', 'newmedia', 'intel'],
  miaomiao: ['activity', 'content', 'campaign'],
};

/** 把 focalFacts 归一化成「标签：值」文本行（供 Prompt 注入，禁止模型添加这里没有的数据）。 */
function factLines(focalFacts) {
  if (!Array.isArray(focalFacts)) return [];
  return focalFacts
    .map((it) => {
      if (!it || typeof it !== 'object') return '';
      const label = it.label == null ? '' : String(it.label).trim();
      const value = it.value == null ? '' : String(it.value).trim();
      if (!label && !value) return '';
      return `${label || '信息'}：${value || '（空）'}`;
    })
    .filter(Boolean);
}

/**
 * 解读当前页：给一段「这一页现在说明什么」的解读 + 0~3 条下一步引导。
 *
 * @param {object} p
 * @param {string} p.moduleKey   当前模块 key
 * @param {string} [p.moduleLabel] 当前模块中文名（缺省回退 MODULE_LABELS）
 * @param {Array<{label:string,value:string}>} [p.focalFacts] 页面事实（系统复算，唯一可信事实源）
 * @param {string[]} [p.topics]  话题关键词（辅助模型聚焦，不构成事实）
 * @param {object} [p.context]   已组装的 buildAIContext 输出（优先使用）
 * @param {object} [p.company]   未传 context 时的企业对象（用于兜底组装）
 * @param {object} [p.knowledge] 未传 context 时的企业知识（用于兜底组装）
 * @returns {Promise<{ok:true, interpretation:string, nextSteps:Array<{label:string,module:string,why:string}>}
 *                  | {ok:false, error:string}>}
 */
export async function interpretPage({ moduleKey, moduleLabel, focalFacts, topics, context, company, knowledge } = {}) {
  const key = moduleKey == null ? '' : String(moduleKey);
  const label = moduleLabel || MODULE_LABELS[key] || key || '当前页';

  let ctx = context;
  if (!ctx || typeof ctx !== 'object') {
    try {
      ctx = buildAIContext({ company, knowledge });
    } catch {
      ctx = undefined;
    }
  }

  const lines = factLines(focalFacts);
  const topicList = Array.isArray(topics) ? topics.map((t) => String(t).trim()).filter(Boolean) : [];
  const allowed = Array.isArray(MODULE_NEXT_TARGETS[key]) ? MODULE_NEXT_TARGETS[key] : [];
  const allowedText = allowed.map((k) => `${k}（${MODULE_LABELS[k] || k}）`).join('、') || '（本页不提供跳转建议）';

  const prompt = [
    '你是「本页智能助手」，为用户当前所在的运营工作页做一段简短解读，并给出接下来最值得做的动作。',
    `当前页：${label}（模块 key：${key || 'unknown'}）。`,
    topicList.length ? `话题焦点：${topicList.join('、')}。` : '',
    '本页事实（由系统提供，是唯一可信的事实来源，不要编造数字、案例、疗效或来源）：',
    lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- （本页暂无可读信息）',
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "interpretation": "一段话，说明这一页现在说明了什么（≤80字，基于上面的本页事实）", "nextSteps": [ { "label": "动作文案（≤12字）", "module": "目标模块key", "why": "为什么现在做这个（≤40字）" } ] }',
    `nextSteps 的 module 只能取以下白名单之一：${allowedText}。请给 0~3 条。`,
    '硬约束：页面事实由系统提供，你只做解读与建议，绝不编造数字、案例、疗效或来源；信息不足就直说「信息不足」，不要臆测。',
  ].filter(Boolean).join('\n');

  let res;
  try {
    res = await chatOnce([{ role: 'user', content: prompt }], ctx, { temperature: 0.4 });
  } catch {
    return { ok: false, error: '解读失败：AI 请求异常，请重试' };
  }
  if (!res || res.ok !== true || !res.content) {
    return { ok: false, error: (res && res.error) || 'AI 返回为空，请重试' };
  }

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'AI 返回格式无法解析，请重试' };
  }

  const interpretation = typeof parsed.interpretation === 'string' ? parsed.interpretation.trim() : '';
  if (!interpretation) {
    return { ok: false, error: 'AI 未返回有效解读，请重试' };
  }

  if (!Array.isArray(parsed.nextSteps)) {
    return { ok: false, error: 'AI 未返回有效的下一步建议，请重试' };
  }

  const nextSteps = parsed.nextSteps
    .map((it) => {
      const o = it && typeof it === 'object' ? it : {};
      return {
        label: typeof o.label === 'string' ? o.label.trim() : '',
        module: typeof o.module === 'string' ? o.module.trim() : '',
        why: typeof o.why === 'string' ? o.why.trim() : '',
      };
    })
    .filter((s) => s.label && s.module && allowed.includes(s.module))
    .slice(0, 3);

  return { ok: true, interpretation, nextSteps };
}

/** 归一化模型返回的动作列表：只留白名单内的 module，最多 3 条。 */
function normalizeActions(raw, allowed) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it) => {
      const o = it && typeof it === 'object' ? it : {};
      return {
        label: typeof o.label === 'string' ? o.label.trim() : '',
        module: typeof o.module === 'string' ? o.module.trim() : '',
        why: typeof o.why === 'string' ? o.why.trim() : '',
      };
    })
    .filter((s) => s.label && s.module && allowed.includes(s.module))
    .slice(0, 3);
}

/**
 * 豆芽引导一轮：以「企业运营负责人」口吻对当前页做判断 + 讲清为什么现在做 + 给可点击动作。
 *
 * 与 interpretPage 的区别（产品口径升级）：
 *   - 旧版是「这一页说明了什么」的**旁白式解读**；
 *   - 新版是「你现在最该做什么、为什么是现在」的**上司式引导**，语气是负责人对老板，
 *     并且要求把结论落成可直接点过去的动作。
 *
 * 多轮：`history` 是本次会话已有的对话（[{role:'douya'|'user', text}]，由面板内存持有），
 * `question` 是本次老板的追问。两者一起决定模型这一轮说什么。
 *
 * @param {object} p
 * @param {string} p.moduleKey    当前模块 key
 * @param {string} [p.moduleLabel] 当前模块中文名
 * @param {Array<{label:string,value:string}>} [p.focalFacts] 本页事实（系统复算，唯一可信事实源）
 * @param {string[]} [p.topics]   话题关键词
 * @param {object} [p.context]    已组装的 buildAIContext 输出（优先）
 * @param {object} [p.company]    未传 context 时的企业对象（兜底组装）
 * @param {object} [p.knowledge]  未传 context 时的企业知识（兜底组装）
 * @param {Array<{role:string,text:string}>} [p.history] 本会话已有对话
 * @param {string} [p.question]   老板这一轮的追问（无则为本轮「该做什么」的开场引导）
 * @returns {Promise<{ok:true, reply:string, actions:Array<{label:string,module:string,why:string}>}
 *                  | {ok:false, error:string}>}
 */
export async function guideTurn({
  moduleKey,
  moduleLabel,
  focalFacts,
  topics,
  context,
  company,
  knowledge,
  history,
  question,
} = {}) {
  const key = moduleKey == null ? '' : String(moduleKey);
  const label = moduleLabel || MODULE_LABELS[key] || key || '当前页';

  let ctx = context;
  if (!ctx || typeof ctx !== 'object') {
    try {
      ctx = buildAIContext({ company, knowledge });
    } catch {
      ctx = undefined;
    }
  }

  const lines = factLines(focalFacts);
  const topicList = Array.isArray(topics) ? topics.map((t) => String(t).trim()).filter(Boolean) : [];
  const allowed = Array.isArray(MODULE_NEXT_TARGETS[key]) ? MODULE_NEXT_TARGETS[key] : [];
  const allowedText = allowed.map((k) => `${k}（${MODULE_LABELS[k] || k}）`).join('、') || '（本页不提供跳转建议）';

  const ask = question == null ? '' : String(question).trim();

  // 首轮指令（同时是给模型的「人设 + 语境 + 事实」载入块）。
  // 注意：这里的「本页智能助手」字样是 mock 后端的特征串，改名要同步改 mock_backend.cjs。
  const brief = [
    '你是「本页智能助手」背后的豆芽：这家企业的 AI 运营负责人。老板（用户）正站在下面这一页，你要像负责人向老板开口一样引导他做事。',
    `当前页：${label}（模块 key：${key || 'unknown'}）。`,
    topicList.length ? `话题焦点：${topicList.join('、')}。` : '',
    '本页事实（由系统提供，是唯一可信的事实来源，不要编造数字、案例、疗效或来源）：',
    lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- （本页暂无可读信息）',
    '',
    '说话方式（必须遵守）：',
    '1) 先给判断：这一页现在最要紧的是什么，一句话说清，敢下结论。',
    '2) 再讲为什么：为什么是「现在」做这件事（结合企业目标 / 档案 / 本页事实），而不是泛泛的正确话。',
    '3) 最后给动作：0~3 个可以直接点过去做的下一步，每个都要写清「为什么先做这个」。',
    '语气像运营负责人对老板：直接、有判断、不客套；不要复述数据、不要说「本页显示 / 如图 / 综上所述」、不要罗列条目凑字数。',
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "reply": "一段话，先判断后原因（≤120字，口语，像在跟老板说话）", "actions": [ { "label": "动作文案（≤12字）", "module": "目标模块key", "why": "为什么先做这个（≤40字）" } ] }',
    `actions 的 module 只能取以下白名单之一：${allowedText}。请给 0~3 条。`,
    '硬约束：事实由系统提供，你只做判断与建议，绝不编造数字、案例、疗效或来源；信息不足就直说「信息不足」，不要臆测。',
  ].filter(Boolean).join('\n');

  const messages = [{ role: 'user', content: brief }];
  if (Array.isArray(history)) {
    for (const m of history) {
      if (!m || typeof m !== 'object') continue;
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) continue;
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: text });
    }
  }
  if (ask) {
    messages.push({
      role: 'user',
      content: `老板追问：${ask}\n直接回答这个追问，别绕回套话；仍然要落到「为什么」和「现在该做什么 / 先做什么」上。`,
    });
  }

  let res;
  try {
    res = await chatOnce(messages, ctx, { temperature: ask ? 0.5 : 0.4 });
  } catch {
    return { ok: false, error: '豆芽没接上：AI 请求异常，请重试' };
  }
  if (!res || res.ok !== true || !res.content) {
    return { ok: false, error: (res && res.error) || 'AI 返回为空，请重试' };
  }

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'AI 返回格式无法解析，请重试' };
  }

  // 兼容：模型可能沿用旧字段名（interpretation / nextSteps），一并接住。
  const replyRaw = typeof parsed.reply === 'string' ? parsed.reply : parsed.interpretation;
  const reply = typeof replyRaw === 'string' ? replyRaw.trim() : '';
  if (!reply) {
    return { ok: false, error: 'AI 未返回有效引导，请重试' };
  }
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : parsed.nextSteps;
  const actions = normalizeActions(rawActions, allowed);

  return { ok: true, reply, actions };
}

// ==================== 经营方案引导（T19） ====================
// 老板第一优先（原话）：「点了某个方案都跳转到新媒体中心……跳过去做什么我都不知道，右边的
// 豆芽也没有引导，按理来说跳过去右边的豆芽是不是告诉你按照经营方案第一步做什么 第二步做什么」。
//
// 设计口径（team-lead 定稿，照做）：
//   - 不新增 prop、不改冻结签名、**不由 DirectionModule publish** —— 面板直接从 useDirection()
//     读当前企业的 active direction，自己算「当前进度 + 下一步」；
//   - 好处：任何模块切过来都能看到方案指引，不只是从方案页跳过来时才有；
//   - 无 active direction（或该企业无方案）→ 指引为空，面板行为与既有一致（不出现空块/报错）。
//
// 本段全部是纯函数 + 一个内存级「方案来源」事件通道（不落盘、不 import React）。
// 派生阶段清单的**唯一事实源**仍是 directionDirector.derivePlanSteps（由组件注入，见 opts.steps），
// 本文件不重复实现阶段派生逻辑，避免第二份事实源。

/** 把 planSteps 归一化成「扁平动作序列」（保留所属阶段与动作字段；不改变任何顺序）。 */
function flattenPlanActions(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  for (const s of list) {
    const step = s && typeof s === 'object' ? s : {};
    const stepId = typeof step.id === 'string' ? step.id : '';
    const stepTitle = typeof step.title === 'string' ? step.title : '';
    const actions = Array.isArray(step.actions) ? step.actions : [];
    for (const a of actions) {
      const act = a && typeof a === 'object' ? a : {};
      out.push({
        id: typeof act.id === 'string' ? act.id : '',
        title: typeof act.title === 'string' ? act.title.trim() : '',
        deliverable: typeof act.deliverable === 'string' ? act.deliverable.trim() : '',
        execModule: typeof act.execModule === 'string' ? act.execModule : '',
        stepId,
        stepTitle,
      });
    }
  }
  return out;
}

/**
 * 由 active direction 算出「方案引导」（纯函数，无副作用）。
 *
 * 「步」= 一条引导动作（checklist item，带 deliverable），非「阶段」。
 *   - currentOrdinal = 第一条未完成动作的 1-based 序号（全部完成时 = 总步数）；
 *   - next = 第一条未完成动作；nextNext = 其后第一条未完成动作（跳过已完成的）；
 *   - 已完成的动作**不会**被当成「下一步」。
 *
 * @param {object|null} direction 经营方向（含 planSteps / planProgress / id / name）
 * @param {{steps?: Array}} [opts] steps = 已解析的 planSteps（组件在 planSteps 为空时用
 *        derivePlanSteps(actions) 兜底后传入）；缺省时退回 direction.planSteps。
 * @returns {{
 *   hasPlan:boolean, directionId:string, directionName:string,
 *   total:number, doneCount:number, currentOrdinal:number, allDone:boolean,
 *   next:({id,title,deliverable,execModule,stepId,stepTitle,ordinal}|null),
 *   nextNext:({id,title,deliverable,execModule,stepId,stepTitle,ordinal}|null),
 *   actions:Array<{id,title,deliverable,execModule,stepId,stepTitle,ordinal}>
 * }}
 */
export function computePlanGuidance(direction, opts = {}) {
  const empty = {
    hasPlan: false,
    directionId: '',
    directionName: '',
    total: 0,
    doneCount: 0,
    currentOrdinal: 0,
    allDone: false,
    next: null,
    nextNext: null,
    actions: [],
  };
  const d = direction && typeof direction === 'object' ? direction : null;
  if (!d) return empty;

  const steps = Array.isArray(opts && opts.steps)
    ? opts.steps
    : (Array.isArray(d.planSteps) ? d.planSteps : []);
  const flat = flattenPlanActions(steps);
  if (!flat.length) return empty;

  const progress = d.planProgress && typeof d.planProgress === 'object' ? d.planProgress : {};
  const isDone = (id) => !!(id && progress[id]);

  const actions = flat.map((a, i) => ({ ...a, ordinal: i + 1 }));
  const doneCount = actions.reduce((n, a) => n + (isDone(a.id) ? 1 : 0), 0);

  const firstUndone = actions.findIndex((a) => !isDone(a.id));
  const allDone = firstUndone === -1;

  let next = null;
  let nextNext = null;
  if (!allDone) {
    next = actions[firstUndone];
    for (let i = firstUndone + 1; i < actions.length; i += 1) {
      if (!isDone(actions[i].id)) {
        nextNext = actions[i];
        break;
      }
    }
  }

  return {
    hasPlan: true,
    directionId: typeof d.id === 'string' ? d.id : '',
    directionName: typeof d.name === 'string' ? d.name : '',
    total: actions.length,
    doneCount,
    currentOrdinal: allDone ? actions.length : firstUndone + 1,
    allDone,
    next,
    nextNext,
    actions,
  };
}

/**
 * 把引导结果渲染成面板文案（纯函数）。hasPlan=false → null（面板据此不渲染，保持原行为）。
 * @param {ReturnType<typeof computePlanGuidance>} g
 * @returns {{header:string, next:string, nextNext:string, done:string}|null}
 */
export function planGuidanceText(g) {
  if (!g || !g.hasPlan) return null;
  const name = g.directionName || '当前方案';
  const header = `正在执行：《${name}》· 第 ${g.currentOrdinal} 步 / 共 ${g.total} 步`;
  const fmt = (s, withDeliverable) => {
    if (!s) return '';
    const dv = withDeliverable && s.deliverable ? `（产出：${s.deliverable}）` : '';
    return `第 ${s.ordinal} 步：${s.title}${dv}`;
  };
  if (g.allDone) {
    return { header, next: '', nextNext: '', done: `这套方案的 ${g.total} 步都已完成 🎉 可「调整经营方向」开启下一轮。` };
  }
  return {
    header,
    next: fmt(g.next, true),
    nextNext: g.nextNext ? `再下一步 ${fmt(g.nextNext, false)}` : '',
    done: '',
  };
}

/**
 * 构造「方案 → 模块」跳转意图（纯函数）。
 *
 * 由 DirectionModule 的「去执行」按钮调用：返回值既传给 onSelectModule
 * （App.handleSelectModule 已支持 { module, intent } 对象形式），也用于标记
 * 「本次从第几步过来」。execModule 为空 → 返回 null（调用方不跳转）。
 *
 * @param {{direction?:object, step?:object, action?:object}} p
 * @returns {{module:string, intent:object}|null}
 */
export function buildPlanExecIntent({ direction, step, action } = {}) {
  const d = direction && typeof direction === 'object' ? direction : {};
  const s = step && typeof step === 'object' ? step : {};
  const a = action && typeof action === 'object' ? action : null;
  const module = a && typeof a.execModule === 'string' ? a.execModule : '';
  if (!module) return null;
  return {
    module,
    intent: {
      kind: 'from_plan',
      directionId: typeof d.id === 'string' ? d.id : '',
      directionName: typeof d.name === 'string' ? d.name : '',
      stepId: typeof s.id === 'string' ? s.id : '',
      stepTitle: typeof s.title === 'string' ? s.title : '',
      actionId: a && typeof a.id === 'string' ? a.id : '',
      actionTitle: a && typeof a.title === 'string' ? a.title : '',
      deliverable: a && typeof a.deliverable === 'string' ? a.deliverable : '',
    },
  };
}

// ---- 「方案来源」内存级事件通道（不落盘、不 import React）----
// 用途：DirectionModule 点「去执行」时 setPlanFocus(intent)；ModuleAssistant 挂载时
// peek 一次并 clearPlanFocus()，用于提示「你从【第 N 步 · 动作名】过来」。
// 消费语义（挂载即清空）保证普通导航不会复用旧高亮；不违反「面板不留存任何内容」红线
// —— 这里只是一个内存级的一次性跳转标记，不写 localStorage、不跨模块会话。
let _planFocus = null;

export function setPlanFocus(focus) {
  _planFocus = focus && typeof focus === 'object' ? { ...focus } : null;
}

export function getPlanFocus() {
  return _planFocus;
}

export function clearPlanFocus() {
  _planFocus = null;
}

export default { guideTurn, interpretPage, MODULE_LABELS, MODULE_NEXT_TARGETS };
