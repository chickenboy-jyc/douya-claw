/**
 * douyaGeoGuide —— 豆芽「AI 搜索声量补救」引导流（纯函数，无副作用，可测试）。
 *
 * 用户需求（2026-09-10）：豆芽能看到 GEO/SEO 声量不足 → 点击后主动生成文章 →
 * 告知找哪些媒体发文 → 每一步都有引导 → 给出合理预算。豆芽不能代替你去媒体平台发文，但能引导。
 *
 * 设计红线：
 *   - 数据诚实：媒体与预算全部来自 `data/mediaResources.js` 真实报价，绝不编造价格；
 *   - 只对「AI 搜索曝光」维度识别不足（方向下降 / 搜不到 / 核心场景覆盖不足），其余维度不触发；
 *   - 选题由企业画像（产品/卖点/人群）规则化拼装，不调模型；正文生成在 UI 层调 /api/wenan/generate；
 *   - 媒体「发文」需人工，引导文案明确「豆芽不能代发」，只给链接 + 话术 + 预算。
 */

import { mediaResources } from '../data/mediaResources.js';

// ==================== 企业行业 → 媒体分类优先级 ====================
// 口腔/牙科/医疗企业 → 健康医疗类媒体最贴合，其次财经商业（企业动态）、新闻资讯（品牌背书）、IT科技（数字化）。
const INDUSTRY_CATEGORY_RANK = [
  { kw: ['口腔', '牙科', '医疗', '医药', '医院', '诊所', '器械', '耗材', '义齿', '种植', '正畸'], cats: ['健康医疗', '财经商业', '新闻资讯', 'IT科技'] },
  { kw: ['金融', '投资', '电商', '交易', '平台', '商业', '供应链', '采购', '批发'], cats: ['财经商业', 'IT科技', '新闻资讯', '健康医疗'] },
  { kw: ['科技', '软件', '人工智能', '数字化', 'saas', '互联网'], cats: ['IT科技', '财经商业', '新闻资讯', '健康医疗'] },
];

/** 兜底分类优先级（未命中任何行业时）。 */
const DEFAULT_CATEGORY_RANK = ['新闻资讯', '财经商业', 'IT科技', '健康医疗'];

function asList(v) {
  return Array.isArray(v) ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : [];
}

function num(v, d = 0) {
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : d;
}

/** 按企业画像文本判定分类优先级。 */
function categoryRankFor(asset) {
  const a = asset || {};
  const text = [a.industry, a.products, a.profile, asList(a.coreSellingPoints).join(' '), asList(a.targetCustomers).join(' ')].join(' ');
  for (const row of INDUSTRY_CATEGORY_RANK) {
    if (row.kw.some((k) => text.includes(k))) return row.cats;
  }
  return DEFAULT_CATEGORY_RANK;
}

/** 某分类在优先级里的序号（越小越优先）。 */
function catRank(cats, category) {
  const i = cats.indexOf(category);
  return i === -1 ? 99 : i;
}

// ==================== 1) 识别「AI 搜索曝光不足」 ====================
/**
 * 判断 AI 搜索曝光维度是否「不足」，触发豆芽补救引导。
 *
 * @param {Object|null} dimension feed.dimensions 里的 ai_search_exposure 项
 *   { id, label, change:{direction}, visibility:{state, mentioned, total, prob, sourceState} }
 * @returns {{ gap:boolean, kind:string|null, reason:string, coverage:number|null }}
 *   kind: 'down'|'not_found'|'low_coverage'|null
 */
export function detectGeoGap(dimension) {
  const d = dimension || {};
  if (d.id !== 'ai_search_exposure') {
    return { gap: false, kind: null, reason: '', coverage: null };
  }
  const change = d.change || {};
  const vis = d.visibility || {};

  // 1) 趋势下降（有基线）
  if (change.direction === 'down') {
    return { gap: true, kind: 'down', reason: 'AI 搜索曝光相比基线在下降', coverage: null };
  }

  // 2) 搜了但没搜到 → 可见性偏低
  if (vis.state === 'not_found') {
    return { gap: true, kind: 'not_found', reason: '核心搜索场景里暂未发现企业被 AI 提及', coverage: null };
  }

  // 3) 有可见性但核心场景覆盖不足（< 50%）
  if (vis.state === 'visible' && vis.mentioned != null && vis.total != null && vis.total > 0) {
    const coverage = vis.mentioned / vis.total;
    if (coverage < 0.5) {
      return { gap: true, kind: 'low_coverage', reason: `只在 ${vis.mentioned}/${vis.total} 个核心场景被提及，覆盖不足`, coverage };
    }
  }

  return { gap: false, kind: null, reason: '', coverage: null };
}

// ==================== 2) 选题清单（企业画像规则化，不调模型） ====================
/**
 * 基于企业画像 + 缺口类型，产出 3 个 GEO 选题。选题标题带企业产品/卖点，角度随缺口类型变化。
 *
 * @param {Object} p { asset, company, gapKind }
 * @returns {Array<{title:string, angle:string, why:string}>}
 */
export function buildGeoArticleTopics(p = {}) {
  const asset = p.asset || {};
  const company = p.company || {};
  const gapKind = p.gapKind || 'not_found';

  const brand = String(company.name || asset.companyName || '企业').trim();
  const products = asList(asset.products ? [asset.products] : []).join('、') || String(asset.products || '');
  const sells = asList(asset.coreSellingPoints);
  const audience = asList(asset.targetCustomers);

  const productText = products || (sells.length ? sells.join('、') : '核心产品');
  const audienceText = audience.length ? audience.join('、') : '目标客户';

  const angleByKind = {
    not_found: { angle: '采购选型科普', why: '先让 AI 在采购决策类提问里能引用你，把品牌名与可验证参数写进答案' },
    down: { angle: '强化优势 + 权威背书', why: '曝光在下滑，用行业观点与数据背书重新把品牌拉回候选池' },
    low_coverage: { angle: '补齐缺失场景', why: '只在少数场景被提及，按核心采购场景逐条补内容' },
  };
  const base = angleByKind[gapKind] || angleByKind.not_found;

  return [
    {
      title: `${brand}｜${productText}采购选型指南（${audienceText}适用）`,
      angle: base.angle,
      why: base.why,
    },
    {
      title: `${brand}${productText}：核心参数 / 资质 / 售后一次讲清`,
      angle: base.angle,
      why: '结构化的一问一答最容易被 AI 引用，答案里带可验证数据',
    },
    {
      title: `为什么${audienceText}都在关注${productText}？${brand}的选型要点`,
      angle: base.angle,
      why: '用目标客户真实会问的问题切入，提高命中概率',
    },
  ];
}

// ==================== 3) 推荐媒体（真实报价，不编造） ====================
/**
 * 从媒体资源库推荐适合企业发文的媒体。
 *
 * @param {Object} p { asset, limit }
 * @returns {Array<{name:string, category:string, price:number, priceText:string, region:string, weight:number, intro:string, reason:string}>}
 */
export function recommendGeoMedia(p = {}) {
  const asset = p.asset || {};
  const limit = p.limit || 6;
  const cats = categoryRankFor(asset);
  const keywords = asList(asset.coreSellingPoints).concat(asList(asset.targetCustomers));

  const text = [asset.industry, asset.products, asset.profile].filter(Boolean).join(' ');

  const scored = mediaResources.map((m) => {
    const name = String(m.name || '');
    const intro = String(m.intro || '');
    const hay = (name + ' ' + intro).toLowerCase();
    const catR = catRank(cats, m.category);
    const price = num(m.price, 0);
    const hits = keywords.filter((k) => k && hay.includes(String(k).toLowerCase()));
    // 分类优先 + 关键词命中 + 权重 + 性价比（价格越低越靠前，但面议排后）
    const score = (100 - catR) * 100 + hits.length * 20 + num(m.weight, 0) * 2 + (price > 0 ? Math.max(0, 20 - price / 100) : -50);
    return { name, category: m.category, price, priceText: m.price || '面议', region: m.region || '', weight: num(m.weight, 0), intro, reason: hits.length ? `命中画像关键词 ${hits.slice(0, 2).join(' / ')}` : `匹配「${m.category}」类媒体`, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ==================== 4) 预算（三档，真实价格累加） ====================
/**
 * 基于推荐媒体真实报价，产出三档预算。
 *
 * @param {Array} mediaList recommendGeoMedia 的产物
 * @returns {{ tiers:Array<{label:string, mediaCount:number, articleCount:number, total:number, note:string}>, hasPrice:boolean }}
 */
export function calcGeoBudget(mediaList) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const priced = list.filter((m) => m.price > 0).sort((a, b) => a.price - b.price);
  if (priced.length === 0) {
    return { tiers: [], hasPrice: false };
  }

  const sum = (n) => priced.slice(0, n).reduce((s, m) => s + m.price, 0);

  const tiers = [];
  const defs = [
    { label: '入门 · 先跑起来', n: 3, articleCount: 3, note: '3 家媒体各发 1 篇，先把品牌写进采购决策答案里' },
    { label: '标准 · 形成覆盖', n: 5, articleCount: 5, note: '5 家媒体各发 1 篇，覆盖健康医疗 + 财经 + 新闻多类阵地' },
    { label: '强化 · 拉开差距', n: 8, articleCount: 8, note: '8 家媒体各发 1 篇，配合复测验证曝光是否回升' },
  ];
  for (const d of defs) {
    const n = Math.min(d.n, priced.length);
    if (n <= 0) continue;
    tiers.push({ label: d.label, mediaCount: n, articleCount: d.articleCount, total: sum(n), note: d.note });
  }
  return { tiers, hasPrice: true };
}

// ==================== 5) 完整引导流（分步文案 + 产物） ====================
/**
 * 组装豆芽 GEO 声量补救的完整引导流（诊断 → 文章 → 媒体 → 预算）。
 *
 * @param {Object} p { asset, company, gap }
 * @returns {{
 *   steps:Array<{key:string, title:string, sub:string}>,
 *   diagnosis:string,
 *   topics:Array,
 *   media:Array,
 *   budget:{tiers:Array, hasPrice:boolean},
 *   disclaimer:string,
 * }}
 */
export function buildGeoGuide(p = {}) {
  const asset = p.asset || {};
  const gap = p.gap || { kind: null, reason: '' };
  const company = p.company || {};
  const brand = String(company.name || asset.companyName || '企业').trim();

  const topics = buildGeoArticleTopics({ asset, company, gapKind: gap.kind });
  const media = recommendGeoMedia({ asset, limit: 8 });
  const budget = calcGeoBudget(media);

  const diagnosis = `豆芽发现「${brand}」的 AI 搜索声量不足：${gap.reason || '核心采购场景覆盖不足'}。`
    + '这意味着目标客户在用 AI 问「该找谁采购/合作」时，你的品牌很少出现在答案里。'
    + '豆芽可以帮你把文章写出来、告诉你去哪发、大概花多少钱——但发文这一步需要你亲自去媒体平台完成。';

  return {
    steps: [
      { key: 'diagnosis', title: '为什么不足', sub: '先看清楚问题在哪' },
      { key: 'article', title: '豆芽写文章', sub: '生成可直接发的 GEO 文章' },
      { key: 'media', title: '去哪发文', sub: '推荐媒体 + 发文入口' },
      { key: 'budget', title: '大概花多少', sub: '三档预算，价格透明' },
    ],
    diagnosis,
    topics,
    media,
    budget,
    disclaimer: '豆芽不能代替你去媒体平台注册、发文或付费——这些需要你亲自完成。豆芽给你的是：写好的文章、该发哪些媒体、发文的链接、以及每档要花多少钱。',
  };
}

export default {
  detectGeoGap,
  buildGeoArticleTopics,
  recommendGeoMedia,
  calcGeoBudget,
  buildGeoGuide,
};
