/**
 * knowledgeAI —— 第七阶段「学习站」AI 服务。
 *
 * 复用 buildAIContext + chatOnce + extractJSON，不新建 Prompt 体系。
 * 三个能力：
 * - genArticleSummary   文章 AI 摘要（一句话 + 100~200 字 + 为什么重要 + 对谁有价值）
 * - genArticleInterpret AI 解读（结合 Company + CompanyType + UserRole + 资讯内容）
 * - genArticleTranslate 原文 → 中文翻译（0.21.11 第 4 条文章二级页「翻译」页签，中文原文不调模型）
 * - genTodayLearning    今日学习推荐（结合 Company + Role + 最近项目 + 最近任务，最多 5 条）
 *
 * 真实性铁律：摘要/解读严格基于原文，不虚构新闻、不编造来源、不把推测写成事实。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
// T16：行业资讯改走**真检索**（fetchWebSearch 实检 → 注入资料），不再走静默忽略 enable_search 的 searchWeb。
import { groundedSearch } from './groundedWebSearch.js';
import { companyTypeLabel, roleLabel, KNOWLEDGE_CATEGORIES } from '../data/knowledgeCatalog.js';

function arr(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

async function callLLM(messages, ctx, opts = {}) {
  let res;
  try {
    res = await chatOnce(messages, ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
      reasoningEffort: 'none',
    });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return { __error: (res && res.error) || 'AI 返回为空' };
  const parsed = extractJSON(res.content);
  if (parsed) return parsed;
  return { __raw: res.content };
}

/**
 * 文章 AI 摘要。严格基于原文，不添加原文没有的事实。
 * @param {object} p { company, asset, knowledge, article }
 * @returns {Promise<{oneLine,summaryLong,whyImportant,targetRoles,targetCompanyTypes,importance}|null>}
 */
export async function genArticleSummary(p = {}, opts = {}) {
  const ctx = buildAIContext({ company: p.company, asset: p.asset, knowledge: p.knowledge });
  const a = p.article || {};
  const title = String(a.title || '');
  const content = String(a.content || a.summary || '').slice(0, 4000);
  const source = String(a.author || a.source_id || '');
  const messages = [
    {
      role: 'user',
      content: [
        `你是口腔行业情报编辑。请为下面这篇文章生成摘要与标签，严格基于原文，不得增加原文没有的事实、数据或来源。`,
        `标题：${title}`,
        `来源：${source || '（未知）'}`,
        `原文内容：\n${content || '（无正文，仅标题）'}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "oneLine": "一句话摘要（≤40字）", "summaryLong": "100~200字摘要", "whyImportant": "为什么值得关注（≤80字）", "targetRoles": ["operator","doctor","owner","manufacturer 中适用人群"], "targetCompanyTypes": ["clinic","manufacturer 中适用企业类型"], "importance": 1~5 整数推荐指数 }`,
        `targetRoles 取值：operator(运营)/doctor(医生)/owner(门诊经营者)/manufacturer(厂家)；targetCompanyTypes 取值：clinic(门诊)/manufacturer(厂家)。`,
        `如原文信息不足，明确说明「资料不足」，不得编造。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) return { oneLine: '', summaryLong: parsed.__raw, whyImportant: '', targetRoles: [], targetCompanyTypes: [], importance: 3 };
  return {
    oneLine: typeof parsed.oneLine === 'string' ? parsed.oneLine : '',
    summaryLong: typeof parsed.summaryLong === 'string' ? parsed.summaryLong : '',
    whyImportant: typeof parsed.whyImportant === 'string' ? parsed.whyImportant : '',
    targetRoles: arr(parsed.targetRoles),
    targetCompanyTypes: arr(parsed.targetCompanyTypes),
    importance: Number(parsed.importance) || 3,
  };
}

/**
 * AI 解读：结合当前企业 + 企业类型 + 用户角色 + 资讯内容，回答「是什么/为什么/影响/怎么做/继续学什么」。
 * @param {object} p { company, asset, knowledge, project, goalLabel, role, companyType, article }
 */
export async function genArticleInterpret(p = {}, opts = {}) {
  const ctx = buildAIContext({ company: p.company, asset: p.asset, knowledge: p.knowledge, project: p.project, goalLabel: p.goalLabel });
  const a = p.article || {};
  const companyType = p.companyType || 'manufacturer';
  const role = p.role || 'operator';
  const cname = (p.company && p.company.name) || (p.asset && p.asset.companyName) || '当前企业';
  const projName = (p.project && p.project.name) || '';
  const goalLabel = p.goalLabel || '';
  const content = String(a.content || a.summary || a.title || '').slice(0, 4000);
  const messages = [
    {
      role: 'user',
      content: [
        `你是口腔行业顾问。请结合当前企业上下文，为这篇资讯做「对我有什么影响」的解读。`,
        `当前企业：${cname}（${companyTypeLabel(companyType)}）；用户角色：${roleLabel(role)}${projName ? `；当前项目：${projName}` : ''}${goalLabel ? `；营销目标：${goalLabel}` : ''}。`,
        `资讯标题：${a.title || ''}`,
        `资讯内容：\n${content}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "what": "这件事是什么（≤60字）", "why": "为什么值得关注（≤60字）", "impact": "对你有什么影响（结合当前企业/角色，≤120字）", "action": "你可以怎么做（给出可执行建议，≤120字）", "next": ["推荐继续学习的内容1", "内容2"] }`,
        `严格基于原文与企业上下文，不编造；impact 必须结合当前企业类型与角色具体化。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) return { what: '', why: '', impact: parsed.__raw, action: '', next: [] };
  return {
    what: typeof parsed.what === 'string' ? parsed.what : '',
    why: typeof parsed.why === 'string' ? parsed.why : '',
    impact: typeof parsed.impact === 'string' ? parsed.impact : '',
    action: typeof parsed.action === 'string' ? parsed.action : '',
    next: arr(parsed.next),
  };
}

/**
 * 【0.21.11 · 老板第 4 条】「翻译」：把外文原文翻成中文，供文章二级页的「翻译」页签用。
 *
 * 原话：「点击后进入文章二级页 二级页再显示 原文 翻译 还有AI解读」。
 *
 * 两条诚实边界：
 *   ① **原文本来中文就不调 AI** —— 直接返回 { sameLang: true }，页面显示「原文就是中文，不需要翻译」，
 *      不为了凑一个页签去烧一次模型、更不假装翻了些什么；
 *   ② 译文只能来自原文，**不许补原文没有的事实**；原文只有摘要时，就在 note 里说清楚
 *      「这里翻译的是摘要，不是全文」（否则读者会以为拿到的是整篇译文）。
 *
 * @param {object} p { article, company, asset, knowledge }
 * @returns {Promise<{sameLang?:boolean,title_zh?:string,body_zh?:string,note?:string}|null>}
 */
export async function genArticleTranslate(p = {}, opts = {}) {
  const a = p.article || {};
  const title = String(a.title || '');
  const content = String(a.content || a.summary_long || a.summary || '').trim();
  const hasFullText = !!(a.content && String(a.content).trim());

  // 中文判定：CJK 字符占非空白字符的比例 > 20% 视为中文原文（标题 + 正文一起看，
  // 避免「标题是中文、正文是英文」这种混合稿被误判）。
  const sample = (title + ' ' + content).slice(0, 4000);
  const nonSpace = sample.replace(/\s/g, '');
  const cjk = (sample.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (nonSpace.length > 0 && cjk / nonSpace.length > 0.2) {
    return { sameLang: true };
  }
  if (!content) return null;

  const ctx = buildAIContext({ company: p.company, asset: p.asset, knowledge: p.knowledge });
  const messages = [
    {
      role: 'user',
      content: [
        '你是口腔医疗行业的专业译者。请把下面这段外文原文翻译成简体中文。',
        '硬要求：只翻译原文里存在的内容，不许补充原文没有的事实、数据或结论；专有名词（品牌、器械型号、法规名）保留原文并可在括号里给中文；数字与单位原样保留。',
        hasFullText ? '这次给的是全文，请完整翻译。' : '这次只拿到摘要（不是全文），只翻译摘要即可，不要补写全文。',
        `标题：${title}`,
        `原文：\n${content.slice(0, 6000)}`,
        '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
        '{ "title_zh": "标题的中文译文", "body_zh": "正文中文译文（保留段落，用 \\n 分段）", "note": "一句话说明（例如只翻译了摘要、术语处理方式），没有就空串" }',
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) {
    return { title_zh: title, body_zh: String(parsed.__raw), note: '模型未按格式返回，以下是原始译文' };
  }
  const bodyZh = typeof parsed.body_zh === 'string' ? parsed.body_zh : '';
  if (!bodyZh.trim()) return null;
  return {
    title_zh: typeof parsed.title_zh === 'string' ? parsed.title_zh : title,
    body_zh: bodyZh,
    note: typeof parsed.note === 'string' ? parsed.note : '',
  };
}

/**
 * 今日学习推荐：结合 Company + Role + 最近项目 + 最近任务，最多 5 条，每条带推荐理由。
 * @param {object} p { company, asset, knowledge, project, role, companyType, goalLabel, recentTasks, articlePool }
 */
export async function genTodayLearning(p = {}, opts = {}) {
  const ctx = buildAIContext({ company: p.company, asset: p.asset, knowledge: p.knowledge, project: p.project, goalLabel: p.goalLabel });
  const companyType = p.companyType || 'manufacturer';
  const role = p.role || 'operator';
  const cname = (p.company && p.company.name) || (p.asset && p.asset.companyName) || '当前企业';
  const projName = (p.project && p.project.name) || '';
  const recentTasks = arr(p.recentTasks).slice(0, 5).join('、');
  // 文章池：把可选文章标题喂给 AI，让它从池里挑
  const pool = (Array.isArray(p.articlePool) ? p.articlePool : [])
    .slice(0, 30)
    .map((a, i) => `${i + 1}. ${a.title}${a.category ? `（${a.category}）` : ''}`)
    .join('\n');
  const messages = [
    {
      role: 'user',
      content: [
        `你是口腔行业学习推荐引擎。请为当前用户推荐「今天最值得学」的内容，最多 5 条，每条都要有理由。`,
        `当前企业：${cname}（${companyTypeLabel(companyType)}）；用户角色：${roleLabel(role)}${projName ? `；当前项目：${projName}` : ''}${recentTasks ? `；最近任务：${recentTasks}` : ''}。`,
        `候选文章池（从池中挑选，编号引用）：\n${pool || '（暂无文章池）'}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "items": [ { "index": 文章池编号, "reason": "为什么今天值得学（结合角色/项目，≤60字）" } ] }`,
        `优先推荐与当前项目/任务/角色强相关的文章；若无文章池或匹配不到，返回空 items。不得编造文章。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) return { items: [] };
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .map((it) => ({
      index: Number(it && it.index) || 0,
      reason: String((it && it.reason) || ''),
    }))
    .filter((it) => it.index > 0);
  return { items: items.slice(0, 5) };
}

/**
 * AI 联网抓取行业资讯：替代「手动添加资讯」，成为资讯池的第一来源。
 * T16：改走**真检索**（groundedSearch = fetchWebSearch 实检 → 注入资料 → 模型据实作答），
 * 不再走静默忽略 enable_search 的 searchWeb；一次返回结构化资讯数组。
 * 真实性铁律：每条必须来自真实检索结果，必须带真实来源，禁止编造标题/来源/数据。
 * @param {object} p { company, asset, knowledge, project, goalLabel, companyType, role, count }
 * @param {object} [opts] { temperature, fetchFn, chatFn }（后两个仅供测试注入替身）
 * @returns {Promise<Array<{title,url,source,category,summaryLong,whyImportant,targetRoles,targetCompanyTypes,importance,publishedAt}>|null>}
 */
export async function genFetchIndustryNews(p = {}, opts = {}) {
  const ctx = buildAIContext({
    company: p.company,
    asset: p.asset,
    knowledge: p.knowledge,
    project: p.project,
    goalLabel: p.goalLabel,
  });
  const companyType = p.companyType || 'manufacturer';
  const role = p.role || 'operator';
  const cname = (p.company && p.company.name) || (p.asset && p.asset.companyName) || '当前企业';
  const projName = (p.project && p.project.name) || '';
  const goalLabel = p.goalLabel || '';
  const count = Number(p.count) || 8;
  const catKeys = KNOWLEDGE_CATEGORIES.map((c) => c.key).join('/');
  const prompt = [
    `你是口腔行业情报采集员。请联网检索「口腔医疗行业」最近 1~2 周的公开资讯（政策、技术、AI、产品、行业动态、展会/学术等），结合当前企业画像，返回 ${count} 条最相关的。`,
    `当前企业：${cname}（${companyTypeLabel(companyType)}）；用户角色：${roleLabel(role)}${projName ? `；当前项目：${projName}` : ''}${goalLabel ? `；营销目标：${goalLabel}` : ''}。`,
    `每条资讯必须是真实检索到的（真实标题 + 真实来源名称 + 真实或可核实的链接），严格禁止编造标题、来源或数据。`,
    `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
    `{ "items": [ { "title": "资讯标题", "url": "原文链接(可空)", "source": "来源媒体/机构名称", "category": "分类key", "summaryLong": "100~180字摘要", "whyImportant": "为什么值得关注(≤80字)", "targetRoles": ["适用角色"], "targetCompanyTypes": ["适用企业类型"], "importance": 1~5整数, "publishedAt": "发布日期(YYYY-MM-DD，不确定则空)" } ] }`,
    `category 只能取：${catKeys}。`,
    `targetRoles 取值：operator(运营)/doctor(医生)/owner(门诊经营者)/manufacturer(厂家)；targetCompanyTypes 取值：clinic(门诊)/manufacturer(厂家)。`,
    `优先返回与当前企业类型、项目、目标强相关的资讯；检索不到真实内容时就返回空 items，绝不编造。`,
    `若你**无法访问实时网络**，请直接返回空 items，不要用训练记忆里的资讯冒充「最近 1~2 周的公开资讯」。`,
  ].join('\n');

  let res;
  try {
    // T16：改走**真检索**（groundedSearch = fetchWebSearch 实检 → 注入资料 → 模型据实作答）。
    // 显式给精炼检索词 —— 否则上面这段长 prompt 会被 deriveQuery 截断成 200 字检索词，命中率极差。
    res = await groundedSearch(prompt, {
      query: '口腔医疗行业 最近资讯 政策 技术 AI 产品 行业动态',
      context: ctx,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
      fetchFn: typeof opts.fetchFn === 'function' ? opts.fetchFn : undefined,
      chatFn: typeof opts.chatFn === 'function' ? opts.chatFn : undefined,
    });
  } catch {
    return null;
  }
  if (!res || res.ok !== true || !res.content) return null;
  // groundedSearch 已把 content 解析进 data；content 有值但解析失败时再兜一次。
  const parsed = res.data || (res.content ? extractJSON(res.content) : null);
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const items = parsed.items
    .map((it) => {
      const o = it && typeof it === 'object' ? it : {};
      return {
        title: typeof o.title === 'string' ? o.title.trim() : '',
        url: typeof o.url === 'string' ? o.url.trim() : '',
        source: typeof o.source === 'string' ? o.source.trim() : '',
        category: typeof o.category === 'string' && KNOWLEDGE_CATEGORIES.some((c) => c.key === o.category) ? o.category : '',
        summaryLong: typeof o.summaryLong === 'string' ? o.summaryLong : '',
        whyImportant: typeof o.whyImportant === 'string' ? o.whyImportant : '',
        targetRoles: arr(o.targetRoles),
        targetCompanyTypes: arr(o.targetCompanyTypes),
        importance: Math.max(1, Math.min(5, Number(o.importance) || 3)),
        publishedAt: typeof o.publishedAt === 'string' && o.publishedAt.trim() ? o.publishedAt.trim() : '',
      };
    })
    .filter((it) => it.title);
  if (items.length === 0) return null;
  return items;
}

/**
 * AI 通俗解读（「帮我看懂」）：把一条行业资讯翻译成非专业用户也能秒懂的大白话，
 * 并落到「对本企业意味着什么 + 今天能做什么」。区别于 genArticleInterpret 的「业务影响」视角，
 * 这里假设读者是不懂行业术语的运营新人或老板。
 * 真实性铁律：soWhat 必须从企业画像推导，禁止空话；信息不足时明确标注。
 * @param {object} p { article, company, asset, knowledge, companyType, role }
 * @returns {Promise<{plain,analogy,soWhat,todo:Array<{action,output}>}|null>}
 */
export async function genPlainInterpret(p = {}, opts = {}) {
  const ctx = buildAIContext({ company: p.company, asset: p.asset, knowledge: p.knowledge });
  const a = p.article || {};
  const companyType = p.companyType || 'manufacturer';
  const role = p.role || 'operator';
  const cname = (p.company && p.company.name) || (p.asset && p.asset.companyName) || '当前企业';
  const content = String(a.content || a.summary_long || a.summary || a.title || '').slice(0, 4000);
  const messages = [
    {
      role: 'user',
      content: [
        `你是口腔行业的「翻译官」。假设读者是不懂行业术语的运营新人或老板，请把下面这条资讯讲成大白话，并落到「对这家企业意味着什么 + 今天能做什么」。`,
        `当前企业：${cname}（${companyTypeLabel(companyType)}）；用户角色：${roleLabel(role)}。`,
        `资讯标题：${a.title || ''}`,
        `资讯内容：\n${content || '（无正文，仅标题）'}`,
        `只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：`,
        `{ "plain": "大白话讲这条说了啥，100~180字，零术语", "analogy": "一句话类比让人秒懂", "soWhat": "对该企业具体意味着什么（必须引用企业画像中的行业/产品/目标客户/竞品/营销目标等具体信息）", "todo": [ { "action": "今天就能做的具体动作", "output": "这一步的产出物" } ] }`,
        `soWhat 硬约束：必须从企业画像推导，明确引用具体信息（如「你们主打种植体、客户是民营门诊」），禁止写「有助于提升品牌」「值得关注」这类空话；画像信息不足时写明「企业画像中缺少 X 信息，无法判断」。`,
        `todo 给 3 条，每条都要有明确产出物（如「一版朋友圈文案」「一份竞品对比表」），不允许「加强」「优化」这类没有宾语的动词。`,
        `严格基于原文，不编造；原文信息不足就如实说明。`,
      ].join('\n'),
    },
  ];
  const parsed = await callLLM(messages, ctx, opts);
  if (!parsed || parsed.__error) return null;
  if (parsed.__raw) return { plain: '', analogy: '', soWhat: parsed.__raw, todo: [] };
  const todo = (Array.isArray(parsed.todo) ? parsed.todo : [])
    .map((it) => ({
      action: typeof it === 'string' ? it : (it && typeof it.action === 'string' ? it.action : ''),
      output: it && typeof it === 'object' && typeof it.output === 'string' ? it.output : '',
    }))
    .filter((it) => it.action)
    .slice(0, 3);
  return {
    plain: typeof parsed.plain === 'string' ? parsed.plain : '',
    analogy: typeof parsed.analogy === 'string' ? parsed.analogy : '',
    soWhat: typeof parsed.soWhat === 'string' ? parsed.soWhat : '',
    todo,
  };
}

export default {
  genArticleSummary,
  genArticleInterpret,
  genArticleTranslate,
  genTodayLearning,
  genFetchIndustryNews,
  genPlainInterpret,
};
