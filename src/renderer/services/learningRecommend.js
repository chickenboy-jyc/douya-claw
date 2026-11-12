/**
 * learningRecommend —— 学习站「为你推荐」AI 智能推荐服务。
 *
 * 旧逻辑只按文章的 target_roles / target_company_types 硬字段过滤，RSS 抓取的资讯没有这些字段，
 * 导致「生成了很多文章但推荐里一片空白」。这个服务让 AI 直接读企业画像 + 文章池，
 * 挑出最适合「当前企业 + 当前角色」现在就看的 3-5 篇，并给出「为什么推荐给你」的理由。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';

function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 精简文章列表给 AI 看（只保留标题 + 摘要前 60 字），限制数量。 */
function articlesText(articles) {
  const list = Array.isArray(articles) ? articles : [];
  return list
    .slice(0, 15)
    .map((a, i) => {
      const summary = (a.summary || a.summary_long || '').replace(/\s+/g, ' ').slice(0, 60);
      return `${i + 1}. [${a.id}] ${a.title || '（无标题）'}${summary ? ' —— ' + summary : ''}`;
    })
    .join('\n');
}

const REASON_RULE = [
  '每条「reason / 为什么推荐」必须结合「当前企业画像 + 当前角色」来写，明确说明这篇内容对这家企业的什么环节、这个角色的什么工作有帮助，',
  '例如「企业主营种植体、当前目标是获客，这篇讲民营门诊采购决策的能帮运营写出更对症的销售话术」。',
  '禁止输出「很有用」「值得学习」这类空话；信息不足时写明「缺少 X 信息」。',
].join('');

/**
 * AI 推荐文章。
 *
 * @param {Array} articles 文章池（[{id,title,summary,summary_long}]）
 * @param {object} p { currentCompany, asset, knowledge, role, companyType, learningRole, learningRoleLabel }
 * @param {object} [opts] { chatFn, temperature }
 * @returns {Promise<Array<{articleId:string, reason:string, importance:number}>>} 失败返回 []
 */
export async function genArticleRecommendations(articles, p = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  if (!Array.isArray(articles) || articles.length === 0) return [];

  const ctx = buildAIContext({
    company: p.currentCompany,
    asset: p.asset,
    knowledge: p.knowledge,
    role: p.role || 'admin',
    goalLabel: '',
  });

  const prompt = [
    '你是口腔行业的「学习推荐官」。请从下面的行业资讯池里，挑出最适合「这家企业 + 当前这个角色」现在就看的 3-5 篇。',
    `企业类型：${p.companyType || '未知'}。`,
    `当前角色：${p.learningRoleLabel || p.role || '未知'}。`,
    '',
    '【资讯池】',
    articlesText(articles),
    '',
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "list": [ { "articleId": "资讯池里的 id", "reason": "为什么推荐给这家企业的这个角色（一句话，必须结合企业画像）", "importance": 5 } ] }',
    'articleId 必须严格取自资讯池里方括号内的 id；importance 是 1-5 的推荐指数，按从高到低排序，最多 5 条。',
    REASON_RULE,
    '不得编造文章内容；资讯池里没有的信息不要自己脑补。',
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

  const raw = Array.isArray(parsed.list) ? parsed.list : [];
  const validIds = new Set((Array.isArray(articles) ? articles : []).map((a) => asStr(a && a.id)));

  return raw
    .map((it) => {
      const articleId = asStr(it && it.articleId);
      const importance = Math.min(5, Math.max(1, Math.round(Number(it && it.importance) || 3)));
      return { articleId, reason: asStr(it && it.reason), importance };
    })
    .filter((it) => it.articleId && validIds.has(it.articleId))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 5);
}

export default { genArticleRecommendations };
