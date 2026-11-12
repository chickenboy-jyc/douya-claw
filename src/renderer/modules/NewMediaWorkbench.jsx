import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button,
  Card,
  Input,
  Modal,
  Popover,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  Tooltip,
  App as AntApp,
} from 'antd';
import Markdown from '../components/Markdown.jsx';
// Markdown → 纯文本的唯一真源（复制到剪贴板 / 卡片预览切片都走它）。
import { mdToPlain } from '../utils/mdToPlain.js';
import douyaLogo from '../assets/douya/douya-logo.webp';
import { useMarketingAsset, useMarketingGoal } from '../store/marketingStore.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useAssets, ASSET_TYPES } from '../store/assetStore.jsx';
import { useMediaAccounts } from '../store/mediaAccountStore.jsx';
import { startJob, useBackgroundJob } from '../store/backgroundJobs.js';
import '../styles/ia-today.css';
import { mediaResources } from '../data/mediaResources.js';
import { GEO_PLATFORMS, getGeoPlatform } from '../data/geoPlatforms.js';
import { assetToRecommendPayload, groupFacts } from '../services/companyProfile.js';
import { complianceCheck } from '../api.js';
// 第 5 层第 3 步：文案生成也要吃到「这家公司的真实资料 + 三级可信度」。
// 走统一入口（buildAIContext 自解析当前企业），不在这里自己拼企业资料 ——
// 否则本模块会变成"第五个各自理解一次企业"的地方，正是第 5 层要消灭的。
import { buildAIContext } from '../services/contextBuilder.js';
// 2026-10-19 第十九轮：老板提供的长版 GEO prompt（九章，逐字保留）只套「精品文案」。
// 单独放 config/ 是因为它是纯文本资产 + 一个纯函数，不依赖 React / 网络，可被探针脚本直接读。
import { buildGeoPromptWenan } from '../config/geoContentPrompt.js';

// 发布平台（通用新媒体平台，非任何品牌预设）
const PLATFORMS = ['知乎', '小红书', '头条号', '百家号', '微博', '大鱼号', '企鹅号', '搜狐'];

// 文案类型 / 风格：做成点击卡片（单选），减少下拉填空
const TYPE_OPTIONS = [
  { value: 'gongzhonghao', icon: '📰', label: '公众号文章' },
  { value: 'huodong_wenan', icon: '🎉', label: '活动文案' },
  { value: 'xinmeiti', icon: '📱', label: '新媒体文案' },
  { value: 'custom', icon: '✨', label: '自定义文案' },
];
const STYLE_OPTIONS = [
  { value: 'professional', icon: '💼', label: '专业正式' },
  { value: 'casual', icon: '😄', label: '轻松活泼' },
  { value: 'marketing', icon: '📈', label: '营销推广' },
  { value: 'storytelling', icon: '📖', label: '故事叙述' },
];

function asList(v, keys = ['personas', 'list', 'data', 'items', 'articles', 'crises', 'results']) {
  if (!v || typeof v !== 'object') return [];
  if (Array.isArray(v)) return v;
  for (const k of keys) {
    if (Array.isArray(v[k])) return v[k];
  }
  return [];
}

/* ============================================================================
 * 【2026-10-10 老板第 3 条】「GEO 不如 api.example.com 里的 GEO 文章清晰」
 *   对齐网页版（ref_html/new-media-workspace.html）的信息密度：
 *     · 「🎯 AI 搜索评分」：四维进度条 + AI 搜索总分；
 *     · 「📝 AI 搜索文章库」：关键词 / 生成目标 / 平台 / 完整度 / 状态 / 生成日期 + 详情弹窗。
 *   诚实口径：接口拿不到就显示「--」并说明原因，绝不填假数字。
 *
 * ★ 2026-10-11 术语清剿（老板：「这个软件给笨蛋用的 很笨很笨的 根本懒得看一些内容」）：
 *   本节原先的标题与标签全是行业黑话（GEO / 引用度 / 就绪度…），用户看不懂 ——
 *   实测同一句话「暂未拿到 GEO 评分」在 17 个模块的首屏审计里被记为**术语命中**。
 *   现改成白话。⚠️ 只改**中文名与标题**，`visibility/citation/entity/discovery`
 *   这些 key 一律不动 —— 它们是接口字段名，改了就读不到数据（不是文案）。
 * ========================================================================== */

/** AI 搜索四维（key 与网页版一致；中文名是本端白话译法，不追求与网页版逐字相同） */
const GEO_DIM_LABELS = { visibility: '被搜到', citation: '被 AI 提到', entity: '企业信息准确', discovery: '容易发现' };
/** 维度进度条配色：绿 / 紫 / 绿 / 橙（暖色系，不用蓝黑） */
const GEO_DIM_COLORS = { visibility: '#30d158', citation: '#bf5af2', entity: '#1d7a36', discovery: '#ff9f0a' };
/** 文章「生成目标」→ 人话（key 与网页版一致；中文名同为本端白话译法） */
const ARTICLE_GOAL_LABELS = {
  visibility: '更容易被搜到',
  citation: '被 AI 提到',
  entity: '企业信息',
  discovery: '更容易被找到',
  entity_association_reinforcement: '企业信息更全',
  visibility_repair: '补回被搜到',
  citation_building: '被 AI 提到',
  search_discovery_boost: '搜索更容易找到',
};
/** 生成目标 → 展示文案（未知目标原样显示，不编造） */
function goalLabel(g) {
  return ARTICLE_GOAL_LABELS[g] || g || '--';
}
/** 时间戳 → 日期（只取前 10 位，与网页版一致） */
function fmtDay(s) {
  const t = String(s == null ? '' : s).trim();
  return t ? t.slice(0, 10) : '--';
}
/** 生成模式 → 人话 */
function modeLabel(m) {
  if (m === 'FACT_LOCKED') return '事实锁定';
  if (!m) return '--';
  return 'AI 搜索场景';
}

/**
 * 解析 /api/meimiaomiao/stats 的返回 → 我方品牌的 GEO 四维评分。
 * 返回结构里的 overall_scores 是「品牌名 → 各维度分」的嵌套对象（与网页版同一口径）。
 * @param {unknown} r 接口返回
 * @param {string} companyName 当前企业名（优先匹配它，其次「上游货源」，最后取第一个品牌）
 * @returns {{loaded:boolean, brand:string, dims:Array, overall:number|null}}
 */
function parseGeoScore(r, companyName) {
  const all = (r && r.check && r.check.overall_scores) || (r && r.overall_scores) || {};
  const keys = all && typeof all === 'object' ? Object.keys(all) : [];
  if (keys.length === 0) return { loaded: true, brand: '', dims: [], overall: null };
  const want = String(companyName || '').replace(/[（）()\s]/g, '');
  let ourKey = '';
  if (want) ourKey = keys.find((k) => k.replace(/[（）()\s]/g, '').includes(want)) || '';
  if (!ourKey) ourKey = keys.find((k) => k.indexOf('上游货源') !== -1) || keys[0];
  const os = all[ourKey] || {};
  const dims = ['visibility', 'citation', 'entity', 'discovery'].map((k) => ({
    key: k,
    label: GEO_DIM_LABELS[k],
    value: typeof os[k] === 'number' ? os[k] : 0,
  }));
  const overall = typeof os.overall === 'number' ? os.overall : (typeof os.geo === 'number' ? os.geo : null);
  return { loaded: true, brand: ourKey, dims, overall };
}

/** 从危机条目里取标题（兼容多种字段名） */
function crisisTitle(p) {
  return String(p && (p.title || p.topic || p.name || p.keyword || p.entity) || '').trim();
}
/** 危机是否「待处理」：level/status 未标记已处理 */
function crisisLevel(p) {
  const s = String(p && (p.level || p.status || p.signal) || '').toLowerCase();
  if (s.includes('red') || s.includes('红') || s.includes('高')) return 'r';
  if (s.includes('yellow') || s.includes('黄') || s.includes('中') || s.includes('待')) return 'y';
  if (s.includes('green') || s.includes('绿') || s.includes('低')) return 'g';
  return 'y';
}

// ===== 媒体智能推荐：行业映射 / 分类建议（与 MediaPublish 同款口径，内联复用） =====
const INDUSTRY_MAP = [
  { cat: '新闻资讯', kw: ['新闻', '政府', '政务', '公关', '品牌', '国企', '通报', '事件', '媒体'] },
  { cat: '财经商业', kw: ['金融', '财经', '投资', '银行', '证券', '保险', '创业', '商业', '上市', '基金', '股票', '经济', '招商', '企业'] },
  { cat: 'IT科技', kw: ['科技', '互联网', '数码', 'it', '软件', '人工智能', 'ai', '云计算', '大数据', '通信', '芯片', '游戏', '电商', 'saas', '数字化'] },
  { cat: '健康医疗', kw: ['医疗', '健康', '口腔', '牙科', '医药', '医院', '养生', '医美', '生物', '保健', '诊所', '器械', '耗材'] },
  { cat: '能源环保', kw: ['能源', '电力', '环保', '新能源', '光伏', '储能', '电池', '碳中和'] },
  { cat: '生活消费', kw: ['消费', '美食', '餐饮', '时尚', '美妆', '家居', '母婴', '旅游', '食品', '零售'] },
  { cat: '工业贸易', kw: ['工业', '制造', '贸易', '机械', '化工', '建筑', '物流', '出口', '工厂', '供应链'] },
];

const CAT_ADVICE = {
  新闻资讯: { persona: '专业品牌官方号', article: '企业新闻稿 / 行业资讯' },
  财经商业: { persona: '财经观点型账号', article: '财经观点 / 品牌动态' },
  IT科技: { persona: '技术解读型账号', article: '技术解读 / 产品评测' },
  健康医疗: { persona: '专业科普账号', article: '健康科普 / 专业科普' },
  能源环保: { persona: '行业洞察型账号', article: '行业洞察 / 企业动态' },
  生活消费: { persona: '种草测评型账号', article: '种草测评 / 生活方式' },
  工业贸易: { persona: '行业方案型账号', article: '行业方案 / 企业宣传' },
};

/**
 * 复制文本到剪贴板。
 * 主路径用 navigator.clipboard.writeText；Electron 里页面走 http 协议时
 * clipboard API 可能不可用（非安全上下文）或被拒，这里降级到 textarea + execCommand('copy')。
 * @param {string} text 要复制的内容
 * @returns {Promise<boolean>} 是否复制成功；调用方据此决定是否 toast
 */
async function copyText(text) {
  const t = String(text == null ? '' : text);
  if (!t) return false;
  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(t);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, t.length);
      ok = !!document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * 把 Markdown 文案按 ## / ### 标题切成若干段，供「分段复制」使用。
 * 无标题时返回空数组（前端据此隐藏「分段复制」按钮）。
 * @returns {Array<{title:string, content:string}>}
 */
function splitSections(md) {
  const text = String(md || '');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  let head = '';
  for (const line of lines) {
    const m = /^(#{2,4})\s+(.*)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { title: m[2].trim() || '未命名小节', content: line };
    } else if (cur) {
      cur.content += '\n' + line;
    } else {
      head += (head ? '\n' : '') + line;
    }
  }
  if (cur) out.push(cur);
  if (head.trim()) out.unshift({ title: '开头', content: head.trim() });
  return out.filter((s) => String(s.content || '').trim());
}

/**
 * 「分段复制」用的纯文本：先剥掉 Markdown 标记，再去掉**首行的标题**。
 *
 * 为什么必须额外去标题：`splitSections()` 把标题行也算进了 `content`（第一行就是
 * `## 事件评估`），而 title 已经由弹层单独显示、并且复制成功的 toast 里也报了。
 * 不摘掉的话，用户粘出来每一段都顶着一行重复的小节名。
 *
 * 为什么能按「首行是否等于 title」判断：`mdToPlain()` 会把 `## 事件评估` 变成
 * `事件评估`，正好等于 `splitSections()` 给的 title。而「开头」这一段的 title
 * 是硬编码的「开头」、内容里并没有这一行 ⇒ 无法误删正文。
 *
 * @param {{title:string, content:string}} section splitSections 的一段
 * @returns {string} 纯文本（无 Markdown 标记、无重复标题行）
 */
function sectionPlainText(section) {
  const plain = mdToPlain(String((section && section.content) || ''));
  const title = String((section && section.title) || '').trim();
  const lines = plain.split('\n');
  if (title && lines.length && lines[0].trim() === title) lines.shift();
  return lines.join('\n').trim();
}

/** 按文本匹配行业分类（兜底） */
function matchCategory(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  let target = null;
  let best = 0;
  for (const m of INDUSTRY_MAP) {
    const hit = m.kw.filter((k) => t.includes(k.toLowerCase())).length;
    if (hit > best) { best = hit; target = m.cat; }
  }
  return target;
}

function num(v, d = 0) {
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : d;
}

/** 把后端 media-recommend 的 categories 转成 category→优先级序号 映射 */
function buildCategoryPriority(categories) {
  const map = {};
  (categories || []).forEach((c, i) => {
    const name = c && (c.category || c.name);
    if (name && map[name] === undefined) map[name] = i;
  });
  return map;
}

/** 由企业营销资产组装一个与旧 analyzeCompany profile 同构的画像对象，供打分复用。 */
function assetToProfile(asset) {
  const a = asset || {};
  const coreSellingPoints = Array.isArray(a.coreSellingPoints) ? a.coreSellingPoints : [];
  const targetCustomers = Array.isArray(a.targetCustomers) ? a.targetCustomers : [];
  const brandFacts = Array.isArray(a.brandFacts) ? a.brandFacts : [];
  const insights = a.marketingStrategy
    ? String(a.marketingStrategy).split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    summary: String(a.profile || '').trim(),
    brandFacts,
    coreKeywords: coreSellingPoints,
    audience: targetCustomers,
    insights,
    facts: groupFacts(brandFacts),
  };
}

/** 本地打分：对媒体库打分，返回带权重/价格/地区的推荐条目（按分类优先级 + 得分排序）。 */
function scoreMedia(prof, cats, asset) {
  const catPriority = buildCategoryPriority(cats);
  const catCount = Object.keys(catPriority).length;

  const keywords = prof && prof.coreKeywords ? prof.coreKeywords.slice() : [];
  const audiences = prof && prof.audience ? prof.audience.slice() : [];

  const fallbackText = [asset.industry, asset.profile, asset.products].filter(Boolean).join(' ');
  const fallbackCat = catCount ? null : matchCategory(
    keywords.length ? keywords.join(' ') : fallbackText,
  );
  const maxPrice = mediaResources.reduce((mx, m) => Math.max(mx, num(m.price, 0)), 0);

  const scored = mediaResources.map((m) => {
    const name = String(m.name || '');
    const intro = String(m.intro || '');
    const haystack = (name + ' ' + intro).toLowerCase();

    let categoryScore = 0;
    let catRank = null;
    if (catCount && catPriority[m.category] !== undefined) {
      catRank = catPriority[m.category];
      categoryScore = (catCount - catRank) * 9;
    } else if (fallbackCat && m.category === fallbackCat) {
      categoryScore = 8;
    }

    const hits = keywords.filter((k) => k && haystack.includes(String(k).toLowerCase()));
    const keywordScore = Math.min(hits.length * 4, 16);

    const audHits = audiences.filter((a) => a && haystack.includes(String(a).toLowerCase()));
    const audienceScore = Math.min(audHits.length * 2, 6);

    const weightScore = num(m.weight, 0) * 0.6;
    const regionScore = m.region && String(m.region).includes('全国') ? 2 : 0;
    const price = num(m.price, 0);
    const priceScore = price <= 0 ? 3 : Math.max(0, Math.min(3, ((maxPrice - price) / (maxPrice || 1)) * 3));

    const score = categoryScore + keywordScore + audienceScore + weightScore + regionScore + priceScore;

    const catReasonRow = (cats || []).find((c) => c && (c.category || c.name) === m.category);
    const advice = CAT_ADVICE[m.category] || { persona: '专业品牌官方号', article: '品牌动态 / 行业资讯' };
    const parts = [];
    if (catReasonRow && catReasonRow.reason) {
      parts.push(`AI 判定首选「${m.category}」类：${catReasonRow.reason}`);
    } else if (categoryScore > 0) {
      parts.push(`匹配 AI 判定的「${m.category}」类媒体`);
    }
    if (hits.length) parts.push(`命中企业画像关键词 ${hits.slice(0, 3).join(' / ')}`);
    if (audHits.length) parts.push(`覆盖目标人群 ${audHits.slice(0, 2).join(' / ')}`);
    parts.push(`权重 ${m.weight || '-'}、${m.region || '区域'}覆盖、市场价 ¥${m.price || '面议'}，适合发布${advice.article}，建议人设：${advice.persona}`);
    if (!hits.length && !audHits.length && !categoryScore) {
      parts.push('（该企业资产与本站媒体库暂无直接关键词命中，按权重与性价比排序）');
    }

    return {
      name,
      category: m.category,
      score,
      catRank: catRank === null ? 99 : catRank,
      reason: parts.join('；'),
      hits,
      weight: m.weight || '-',
      price: m.price || '面议',
      region: m.region || '-',
    };
  });

  return scored.sort((a, b) => {
    if (a.catRank !== b.catRank) return a.catRank - b.catRank;
    return b.score - a.score;
  });
}

export default function NewMediaWorkbench({ geoProxy, onSelectModule, initialTopic, initialStyle, initialMode, initialRefs }) {
  // 读取共享营销资产：卖点 / 目标人群 / 品牌调性作为文案上下文，不再重复填企业信息
  const { asset, hasAsset } = useMarketingAsset();
  const { goal } = useMarketingGoal();
  const { currentCompany, currentProject } = useCompany();
  const { addAsset, listAssets, assets } = useAssets();
  // 平台账号资产：按企业隔离保存到 localStorage，注册完回填后可以一键跳转发文页
  const { accounts, saveAccount, removeAccount, listForCompany, getAccount } = useMediaAccounts();
  const { message } = AntApp.useApp();
  const companyId = currentCompany ? currentCompany.id : '';

  // ===== 媒体智能推荐（复用媒体发文同款打分逻辑，内联到本模块） =====
  const [mediaRec, setMediaRec] = useState({ busy: false, stage: '', error: '', note: '', recs: [] });

  // 平台账号矩阵：每个平台的输入框草稿（受控），失焦即写入 store
  const [draft, setDraft] = useState({}); // { [platformKey]: { account, homepage } }
  // 切换企业时清空草稿，避免把 A 企业的账号误存到 B 企业
  useEffect(() => { setDraft({}); }, [companyId]);

  // 2026-10-18 第十六轮：从「创作工作台」交接来的主题 / 风格 / 模型 / 参考资料。
  // 为什么用 effect 而不是默认值：这个组件常驻挂载（Tabs destroyInactiveTabPane=false），
  // 用户在工作台改完主题再点「生成文案」时，props 变化必须同步进表单，否则看到的是旧值/空值。
  useEffect(() => {
    if (initialTopic) setTopic(initialTopic);
    if (initialStyle) setStyle(initialStyle);
    if (initialMode) setMode(initialMode);
    if (initialRefs) setRefs(initialRefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTopic, initialStyle, initialMode, initialRefs]);

  // ===== 选项卡（仅剩次级能力：数据看板 / 媒体推荐）=====
  // 说明：原「文案生成」是这里的一个二级 tab（老板第 6 条：生成文案要单独一个版块、不要藏起来）。
  // 现「✍️ 生成文案」已提升为本页**独立、常驻可见的版块**（见下方 id="nm-copy"），不再是 tab。
  const [tab, setTab] = useState('dash'); // dash | media

  // ===== GEO 文章库（老板第 3 条）：是否展开全部 + 当前查看的文章详情 =====
  const [articlesAll, setArticlesAll] = useState(false);
  const [articleDetail, setArticleDetail] = useState(null);

  // ===== 文案生成（保留原契约：/api/wenan/generate，type/style 用枚举码，开关字段 online）=====
  const [type, setType] = useState('gongzhonghao');
  const [style, setStyle] = useState('professional');
  const [topic, setTopic] = useState('');
  const [extra, setExtra] = useState('');
  // 2026-10-18 第十六轮：模型选择（日常内容 / 精品文案）与参考资料，
  // 由「创作工作台」页签的「生成文案」按钮交接过来（initial* props）。
  const [mode, setMode] = useState(initialMode || 'daily');
  const [refs, setRefs] = useState(initialRefs || '');
  const [webSearch, setWebSearch] = useState(false);
  const [personas, setPersonas] = useState([]);
  const [personaSel, setPersonaSel] = useState([]);
  const [platformSel, setPlatformSel] = useState([]);

  // 后台任务：生成走全局 store，切换模块不丢
  const jobKey = `wenan-${currentCompany ? currentCompany.id : 'x'}`;
  const job = useBackgroundJob(jobKey);
  const busy = !!(jobKey && job.busy);
  const result = jobKey ? job.result : null;
  const error = jobKey ? job.error : '';
  const [formError, setFormError] = useState('');
  const [savedName, setSavedName] = useState('');

  // ===== 「生成前豆芽先看一眼」：企业分析 + 平台账号 =====
  //
  // 用户诉求（2026-09-11）：
  //   「生成文案是不是要根据你的企业进行分析，然后创建完账号、根据平台账号来生成，
  //     如果直接点是不是要有一个引导」
  // 落地为三件事：
  //   ① 把豆芽读到/读不到的企业档案显式摆出来（不再是角落里一句「已读取企业资产」）；
  //   ② 发布平台只在**已登记账号**里选，并把平台名 + 账号一起喂给生成接口（按平台口吻写）；
  //   ③ 前置没齐时点「生成文案」不弹红字，弹一张「还差什么 → 怎么补」的引导卡。

  // 【2026-10-10 老板第 5 条】「已登记的平台账号」派生已下线：
  // 账号矩阵移除后，平台改为在生成表单里直接从 GEO_PLATFORMS 多选（见下方"发到哪些平台"）。
  // mediaAccountStore 仍在，历史登记数据未删。

  /** 豆芽实际会读到的企业档案字段（与下方 generate() 注入的上下文严格一一对应）。 */
  const assetFields = useMemo(() => ([
    { k: '企业名称', v: String(asset.companyName || '').trim() },
    { k: '核心卖点', v: (asset.coreSellingPoints || []).join('、') },
    { k: '目标人群', v: (asset.targetCustomers || []).join('、') },
    { k: '品牌调性', v: String(asset.brandTone || '').trim() },
    { k: '企业画像', v: String(asset.profile || '').trim() },
  ]), [asset]);

  /**
   * 老板第 6 条：「文案与诊断又无法识别了……那这个企业大脑有没有应用过去？」
   * → 把「企业资产库的数据到底有没有被文案用上」变成用户看得见的东西。
   * 与 assetFields 同源（useMarketingAsset），单独提炼「卖点 / 人群 / 调性」三项做来源标注，
   * 不新增任何数据链路，只把既有 generate() 已注入的企业资产**显式标出来**。
   */
  const assetFrom = useMemo(() => ([
    { k: '卖点', ok: (asset.coreSellingPoints || []).length > 0 },
    { k: '人群', ok: (asset.targetCustomers || []).length > 0 },
    { k: '调性', ok: !!String(asset.brandTone || '').trim() },
  ]), [asset]);

  const missingAsset = useMemo(
    () => assetFields.filter((f) => !f.v),
    [assetFields],
  );

  /**
   * 生成前置检查：返回「还差什么」。空数组代表可以放心生成。
   * 每一项都带一句「为什么差这个」+ 一个可点的去处，不是单纯报错。
   */
  function precheckGaps() {
    const gaps = [];
    if (!hasAsset) {
      gaps.push({
        id: 'asset',
        title: '豆芽还不认识你的企业',
        why: '没有企业档案，写出来的只会是放之四海而皆准的通用稿，看不出是你家。',
        action: '去建企业档案',
        go: () => { if (onSelectModule) onSelectModule('asset'); },
      });
    } else if (missingAsset.length >= 3) {
      gaps.push({
        id: 'asset-thin',
        title: `企业档案还缺 ${missingAsset.length} 项（${missingAsset.map((f) => f.k).join('、')}）`,
        why: '缺的这几项正好是决定「写给谁看、凭什么信你」的关键，补齐后文案差别很大。',
        action: '去补档案',
        go: () => { if (onSelectModule) onSelectModule('asset'); },
      });
    }
    // 2026-10-10 老板第 5 条：账号矩阵已下线 → 不再把「没登记平台账号」当成生成前置门槛。
    // 平台改为在生成表单里直接多选，发文走「🚀 打开发文平台」直达创作后台。
    if (!topic.trim()) {
      gaps.push({
        id: 'topic',
        title: '还没写主题',
        why: '主题决定这篇写什么。哪怕只写一句「春季种植体促销」也好过空着。',
        action: '知道了，我去填',
        go: null,
      });
    }
    return gaps;
  }

  // 引导卡（点「生成文案」前置不齐时出现；可直接「先按现有信息生成」跳过）
  const [guide, setGuide] = useState(null); // { gaps: [...] } | null

  // ===== 数据看板（真实后端数据，拉不到显示「--」与刷新提示，绝不造假）=====
  // geo：GEO 思维评分（老板第 3 条对齐网页版），null 表示还没拿到。
  const [dash, setDash] = useState({ loading: false, articles: [], crisis: [], personas: [], geo: null, loaded: false });

  const loadDash = useCallback(async () => {
    setDash((d) => ({ ...d, loading: true }));
    const out = { articles: [], crisis: [], personas: [], geo: null, loaded: true };
    // 切换企业后重新拉取：把当前企业信息带进请求（query/body），与后端隔离口径一致
    const q = { company_id: currentCompany ? currentCompany.id : '', company_name: currentCompany ? currentCompany.name : '' };
    // GEO 文章
    try {
      const r = await geoProxy('/api/geo/articles', 'GET', q);
      if (r && r.ok) out.articles = asList(r, ['articles', 'list', 'data', 'items']);
    } catch { /* 忽略 */ }
    // GEO 思维评分（与网页版 api.example.com 新媒体工作台同一数据源）
    try {
      const r = await geoProxy('/api/meimiaomiao/stats', 'GET', q);
      out.geo = parseGeoScore(r, currentCompany ? currentCompany.name : '');
    } catch {
      // 拿不到就如实标记为「未拿到」，UI 显示「--」，不编数字
      out.geo = { loaded: true, brand: '', dims: [], overall: null, failed: true };
    }
    // 危机列表
    try {
      const r = await geoProxy('/api/crisis/list', 'GET', q);
      if (r && r.ok) out.crisis = asList(r, ['crises', 'list', 'items', 'data', 'results']);
    } catch { /* 忽略 */ }
    // 账号人设
    try {
      const r = await geoProxy('/api/geo/personas', 'GET', q);
      if (r && r.ok) {
        out.personas = asList(r, ['personas', 'list', 'data', 'items']);
        setPersonas(out.personas);
      }
    } catch { /* 忽略 */ }
    setDash({ ...out, loading: false });
  }, [geoProxy, currentCompany]);

  useEffect(() => { loadDash(); }, [loadDash]);

  // 挂载时读取「竞品对比 → 营销文案」联动数据，预填主题 / 补充要求
  useEffect(() => {
    let raw = null;
    try { raw = localStorage.getItem('douya-competitor-to-wenan'); } catch { raw = null; }
    if (!raw) return;
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        const comps = Array.isArray(j.competitors) && j.competitors.length ? j.competitors.join('、') : '';
        const who = comps || j.companyName || '竞品';
        if (j.goal || comps || j.companyName) {
          setTopic(`基于竞品对比（${who}）策划差异化营销文案`);
        }
        if (j.summary) setExtra(String(j.summary));
      }
    } catch { /* 忽略解析失败 */ }
    try { localStorage.removeItem('douya-competitor-to-wenan'); } catch { /* 忽略 */ }
  }, []);

  // ===== 媒体智能推荐：读资产 → 调 /api/geo/media-recommend → 本地打分 → 合并排序 =====
  async function recommendMedia() {
    if (!hasAsset) {
      setMediaRec((m) => ({ ...m, error: '尚未建档。请先到「🗂 资产库」完善企业资产，再回来智能推荐。', recs: [], note: '', stage: '' }));
      return;
    }
    setMediaRec({ busy: true, stage: '📡 正在按企业资产匹配媒体…', error: '', note: '', recs: [] });
    try {
      const prof = assetToProfile(asset);

      // 1) 请求后端媒体推荐
      let backendErr = '';
      let backendMedia = [];
      let cats = [];
      try {
        const r = await geoProxy(
          '/api/geo/media-recommend',
          'POST',
          assetToRecommendPayload(asset, goal ? goal.label : '', currentCompany ? currentCompany.name : ''),
        );
        if (r && r.ok) {
          const rec = r.recommend || {};
          backendMedia = Array.isArray(rec.media) ? rec.media : [];
          cats = (Array.isArray(rec.categories) ? rec.categories : []).map((c) => ({
            category: c && (c.category || c.name),
            reason: (c && (c.reason || c.recommend_reason)) || '',
          })).filter((c) => c.category);
          cats = cats.map((c) => ({ ...c, reason: c.reason === '按行业自动匹配' ? '' : c.reason }));
        } else {
          backendErr = (r && r.error) || '后端媒体推荐接口无返回';
        }
      } catch { backendErr = '连接后端失败'; }

      // 2) 本地打分（以资产画像为输入）
      const localRecs = scoreMedia(prof, cats, asset);

      // 3) 合并：后端结果在同分类内优先
      const byName = new Map(localRecs.map((r) => [r.name, r]));
      const merged = [];
      const used = new Set();
      for (const b of backendMedia) {
        const nm = b && (b.name || b.media) ? String(b.name || b.media) : '';
        if (!nm) continue;
        const local = byName.get(nm);
        const backendReason = (b && (b.recommend_reason || b.reason || b.reasoning || b.detail)) || '';
        if (local) {
          merged.push({ ...local, reason: backendReason ? `${backendReason}（${local.reason}）` : local.reason, fromBackend: true });
          used.add(nm);
        } else {
          const pr = buildCategoryPriority(cats);
          const cat = (b && b.category) || '';
          merged.push({
            name: nm,
            category: cat,
            score: num(b && b.weight, 0) * 0.6,
            catRank: pr[cat] === undefined ? 99 : pr[cat],
            reason: backendReason || `后端推荐：${(b && b.intro) || '暂无说明'}`,
            fromBackend: true,
            onlyBackend: true,
            weight: (b && b.weight) != null ? String(b.weight) : '-',
            price: (b && b.price) || '面议',
            region: (b && b.region) || '-',
          });
          used.add(nm);
        }
      }
      for (const l of localRecs) {
        if (!used.has(l.name)) merged.push(l);
      }

      merged.sort((a, b) => {
        if ((a.catRank ?? 99) !== (b.catRank ?? 99)) return (a.catRank ?? 99) - (b.catRank ?? 99);
        const ab = a.fromBackend ? 1 : 0;
        const bb = b.fromBackend ? 1 : 0;
        if (ab !== bb) return bb - ab;
        return (b.score || 0) - (a.score || 0);
      });

      // 4) 提示语
      let note = '';
      if (backendMedia.length) {
        note = '已基于企业营销资产完成深度匹配：行业归属与推荐理由均来自资产画像。';
      } else if (/登录|过期|token/i.test(String(backendErr))) {
        note = '⚠️ 登录态已失效或后端连接失败，请重新登录后重试；当前为本地媒体库兜底结果。';
      } else if (asset.meta && asset.meta.degraded) {
        note = '⚠️ 企业资产为手动建档（AI 分析曾降级），以下结果由本地按资产关键词匹配得出。';
      } else {
        note = '后端媒体推荐接口无返回，以下结果由本地按资产画像关键词匹配得出。';
      }

      setMediaRec({ busy: false, stage: '', error: '', note, recs: merged.slice(0, 12) });
    } catch (e) {
      setMediaRec({ busy: false, stage: '', error: '推荐失败：' + e.message, note: '', recs: [] });
    }
  }

  // ===== 平台账号矩阵：草稿读写 + 一键发文 + 复制账号信息 =====

  /** 取某平台的输入值：优先草稿，其次 store 已保存值。 */
  function draftValue(key, field) {
    const d = draft[key];
    if (d && d[field] !== undefined) return d[field];
    const saved = getAccount(companyId, key);
    return saved ? saved[field] || '' : '';
  }

  function setDraftValue(key, field, value) {
    setDraft((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), [field]: value } }));
  }

  /** 失焦自动保存：账号/主页都空则视为删除该条登记。 */
  function saveDraft(key) {
    const d = draft[key];
    if (!d) return;
    if (!companyId) {
      message.warning('未选择企业，账号无法保存');
      return;
    }
    const rec = saveAccount(companyId, key, { account: d.account || '', homepage: d.homepage || '', note: '' });
    if (rec) message.success('已保存账号');
    else message.info('已清空该平台账号');
  }

  /** 复制「平台名｜账号｜主页链接｜发文页URL」。 */
  async function copyAccountInfo(p) {
    const saved = getAccount(companyId, p.key);
    const account = saved ? saved.account : '';
    const homepage = saved ? saved.homepage : '';
    if (!account && !homepage) {
      message.info('先填写账号或主页链接，再复制');
      return;
    }
    const text = [p.name, account || '（未填写账号）', homepage || '（未填写主页）', p.publishUrl || '（该平台暂不支持直达发文页）'].join('｜');
    const ok = await copyText(text);
    if (ok) message.success('已复制账号信息');
    else message.error('复制失败，请手动选择文本复制');
  }

  /** 一键发文：跳到已登录的创作者后台发文页。 */
  function gotoPublish(p) {
    if (!p.publishUrl) {
      message.info(p.name + ' 暂不支持一键发文，请先手动打开发文页');
      return;
    }
    window.open(p.publishUrl, '_blank', 'noopener,noreferrer');
  }

  // ===== 文案生成 =====
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.force] 跳过前置引导，直接生成（用户在引导卡里选了「先按现有信息生成」）
   */
  async function generate(opts = {}) {
    // 硬门槛：主题与补充全空 → 没有任何可写的输入，引导也没用
    if (!topic.trim() && !extra.trim()) {
      setFormError('请至少填写「主题」或「补充内容」');
      setGuide(null);
      return;
    }
    // 软门槛：前置不齐 → 先给引导卡（列出差什么、为什么差、去哪儿补），不弹红字
    if (!opts.force) {
      const gaps = precheckGaps();
      if (gaps.length) {
        setFormError('');
        setGuide({ gaps });
        return;
      }
    }
    setGuide(null);

    // 从共享资产注入上下文（卖点 / 目标人群 / 品牌调性 / 企业画像），与用户手填 extra 合并
    const ctxParts = [];
    if (asset.companyName) ctxParts.push(`企业：${asset.companyName}`);
    if (asset.brandTone) ctxParts.push(`品牌调性：${asset.brandTone}`);
    if ((asset.coreSellingPoints || []).length) ctxParts.push(`核心卖点：${asset.coreSellingPoints.join('、')}`);
    if ((asset.targetCustomers || []).length) ctxParts.push(`目标人群：${asset.targetCustomers.join('、')}`);
    if (asset.profile) ctxParts.push(`企业画像：${asset.profile}`);

    // 平台与账号：按「已登记的平台账号」写，让文案贴合该平台的读者与口吻
    const pickedPlatforms = (platformSel || [])
      .map((k) => getGeoPlatform(k))
      .filter(Boolean);
    if (pickedPlatforms.length) {
      const detail = pickedPlatforms.map((p) => {
        const acc = getAccount(companyId, p.key);
        const who = acc && acc.account ? acc.account : '该平台账号未填昵称';
        return `${p.name}｜账号：${who}｜读者：${p.audience || '—'}`;
      });
      ctxParts.push(`发布平台与账号（请按各平台的读者与语气分别适配，不要写成同一篇）：\n${detail.join('\n')}`);
    }
    const assetCtx = ctxParts.length ? `【企业资产上下文】\n${ctxParts.join('\n')}` : '';
    // 第 5 层第 3 步：把「企业真实资料 + 资料可信度抬头」一起带上。
    // 取的是统一入口的 companyContext（含【资料可信度】分级），后端 /api/wenan/generate
    // 会把它作为「补充：」拼进 user prompt（backend_main.py 已核），所以数据真的到模型。
    // 缺省（没公司 / 没资料）时它是空串，不注入 —— 改造前后一致。
    const companyCtx = buildAIContext({
      companyId: currentCompany ? currentCompany.id : '',
    }).companyContext;
    // 2026-10-19 第十七轮：prompt 升级。老板反馈「生成文案的 prompt 不够好」——
    // 原版只有一句风格描述（快稿=短句口语 / 深度稿=有质感），缺三样真东西：
    //   ① 交付规格（多少字、几个标题、什么结构）——不说，模型就自由发挥，长度结构全随机；
    //   ② 口腔医疗行业合规红线——上游货源是持证口腔 B2B，文案踩「绝对化用语 / 疗效承诺 /
    //      编造治愈率」就是违规物料，这一条比文采重要；
    //   ③ 参考资料使用规则——用户传了资料却照样编价格编活动，资料等于白传。
    // ↑ 这三条是 WRITE_BASE_RULES 存在的理由。
    //
    // 2026-10-19 第十九轮：精品文案改吃老板给的长版 GEO prompt（config/geoContentPrompt.js，
    // 九章全文、逐字保留）。两个模式的 prompt 从此**分家**，不再是「共享基座 + 模式差异」：
    //   · wenan（精品文案）→ buildGeoPromptWenan()，不再拼 WRITE_BASE_RULES；
    //   · daily（日常快稿）→ 仍是 WRITE_BASE_RULES + 快稿规格，一字未动。
    //
    // ⚠️ wenan 为什么不再拼 WRITE_BASE_RULES（取舍，别「顺手」加回来）：
    //   1. 交付形态正面冲突：第 1 条「直接给成稿：标题 + 正文 + 收尾，不要开场白」与长版
    //      第八章「五部分输出」（事件评估 / 文章方案 / 最终文章 / 核查报告 / GEO 自检）撞车 ——
    //      模型看到「只要成稿」就会砍掉后四部分，而老板恰恰要核查报告当人工复核依据。
    //   2. 合规红线重复：第 2 条的绝对化用语 / 疗效承诺 / 编造资质，已被长版第三章「品牌与产品
    //      事实管理规则」（A/B/C/D 事实分级 + 禁止空洞推断 + 医疗行业特殊要求）与第九章
    //      「不可违反的底线」10 条完整覆盖，颗粒度更细。两套规则叠加，模型只会挑一套执行。
    //   3. 篇幅口径失效：原 wenan 分支写死「正文 800~1500 字、3 个备选标题」，而长版里
    //      「期望文章长度」是**输入项**，由第四 / 五章按事件价值与读者决定 —— 两处一起给，长度不可控。
    //   4. 第 3 条「以参考资料为准」在长版里已升级为第三章事实分级 + 第六章第 5 条引用规则。
    //   → wenan 只留长版一套规则。WRITE_BASE_RULES **不删**：它既是 daily 的现役规则，
    //     也是 wenan 出问题时的回滚资产（把下面的 isWenan 三分支改回三元就回滚了）。
    //
    // ⚠️ companyCtx 仍必须留在第一位（unit-chain-tier-wiring C1 契约：企业上下文 +
    //    资料可信度抬头是「补充：」段的开头）。写作指令插在它之后、assetCtx 之前。
    //    wenan 分支往长版的「B. 品牌与产品事实库」槽位里放的是**指针**而不是副本 ——
    //    企业资料正文只在第一位出现一次，不重复烧 token，也不会让模型以为是两份来源。
    const WRITE_BASE_RULES = [
      '【写作要求（通用）】',
      '1. 直接给成稿：标题 + 正文 + 收尾，不要写「以下是为您生成的文案」这类开场白和解释。',
      '2. 口腔医疗行业红线（硬性，违反任何一条即不可用）：不用「最好/第一/顶尖/根治/100%/彻底解决」等绝对化或疗效承诺用语；不编造治愈率、患者案例、资质证书；不贬低其他机构；资料里没有的价格、活动、数据一律不许写。',
      '3. 提供了【参考资料】时，内容以资料为准：活动规则、价格、参数、卖点必须出自资料，与资料冲突的表述以资料为准；资料没覆盖的地方用稳妥表述，不要脑补。',
      '4. 给了发布平台就按平台适配长度与语气（如小红书口语化带话题标签、公众号用小标题分节、知乎重论证），不要一篇通吃。',
      '5. 中文书面语，杜绝翻译腔；每段只讲一件事。',
    ].join('\n');
    // 精品文章（wenan）走长版 GEO prompt；日常快稿（daily）走原来的精简版。理由见上。
    const isWenan = mode === 'wenan';
    const modeInstruction = isWenan
      ? buildGeoPromptWenan({
          topic, // A. 本次事件信息 / 事件描述
          refs, // A. 可用的原始资料（改走长版 A 槽位，故 base 的 refsBlock 在 wenan 分支不再重复带）
          companyCtx, // B. 品牌与产品事实库（只传指针，正文留在第一位）
          platforms: pickedPlatforms.map((p) => p.name), // C. 发布渠道
          audience: '', // C. 目标读者：本工作台没有这个输入项，如实留空，不硬编默认值
          goal: '', // C. 主要目标：同上
        })
      : '\n【写作模式：日常内容（快稿）】\n- 正文 300~500 字；给 1 个主标题（可附 1 个备选），结构从简：一句入题 + 要点 + 收尾行动号召。\n- 口语化、短句，像门店小编日常发的内容，拿来就能发。\n- 不堆砌形容词，不硬凑金句。';
    // 参考资料（工作台上传的文件名 + 粘贴正文）一并带上，让生成有据可依。
    // daily 照旧；wenan 的 refs 已进长版 prompt 的「A. 可用的原始资料」，这里不再重复带。
    const refsBlock = refs.trim() ? `【用户提供的参考资料】\n${refs.trim()}` : '';
    const baseRules = isWenan ? '' : WRITE_BASE_RULES;
    const refsPart = isWenan ? '' : refsBlock;
    // 拼接顺序不变：companyCtx 永远第一位（C1 契约）。isWenan 时 baseRules / refsPart 为空，
    // filter(Boolean) 跳过，最终 = 企业上下文 + 长版 prompt（含 A/B/C 槽位与输出顺序约束）
    // + 企业资产上下文 + 用户补充。
    const mergedExtra = [companyCtx, baseRules, modeInstruction, assetCtx, refsPart, extra.trim()].filter(Boolean).join('\n\n');

    setFormError('');
    // 后台任务：生成期间切换模块不丢
    await startJob(`wenan-${currentCompany ? currentCompany.id : 'x'}`, async () => {
      const r = await geoProxy('/api/wenan/generate', 'POST', {
        type,
        style,
        topic,
        extra: mergedExtra,
        online: webSearch,
        personas: personaSel,
        platforms: pickedPlatforms.map((p) => p.name),
      });
      if (!r || !r.ok) {
        return { ok: false, content: '', error: (r && r.error) || '生成失败' };
      }
      const content = r.content || r.text || r.result || (typeof r === 'object' ? JSON.stringify(r) : String(r));
      return { ok: !!content, content: String(content), error: '生成失败' };
    });
  }

  const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

  // 文案分段（按 ## / ### 标题），无标题时为空数组 → 隐藏「分段复制」
  const sections = useMemo(() => (result ? splitSections(resultText) : []), [result, resultText]);

  // ===== 合规预检（2026-10-19 第十八轮）=====
  // 口腔门诊/器械厂商发出去的内容受《广告法》《医疗广告管理办法》约束，
  // 「最好/第一/100% 成功/根治」这类词是真会罚款的。生成完自动扫一遍，也可手动重扫。
  // 规则在主进程（src/main/compliance.js），纯本地：断网可用、不花 token、结果可复现。
  const [compliance, setCompliance] = useState(null);
  const [compBusy, setCompBusy] = useState(false);
  const runCompliance = useCallback(async (text) => {
    const t = String(text || '').trim();
    if (!t) { setCompliance(null); return; }
    setCompBusy(true);
    const r = await complianceCheck(t);
    setCompliance(r);
    setCompBusy(false);
  }, []);
  useEffect(() => {
    if (!result) { setCompliance(null); return; }
    runCompliance(resultText);
    // 只在「结果变了」时重扫：resultText 由 result 派生，依赖 result 一个就够。
  }, [result]);

  // 存入项目产出 + 同步企业大脑（addAsset 内部自动调 syncAssetConclusionToKnowledge 回流）
  function saveCopyAndSync() {
    if (!result || !currentCompany) {
      setFormError('当前无企业上下文，无法保存');
      return;
    }
    const label = (topic || '').trim() || '新媒体文案';
    const name = `新媒体文案 · ${label.slice(0, 40)}`;
    addAsset({
      type: 'copy',
      companyId: currentCompany.id,
      projectId: currentProject ? currentProject.id : null,
      name,
      content: resultText,
      tags: ['文案', '新媒体'],
    });
    setSavedName(name);
    message.success('已存入项目产出，并同步到企业大脑');
  }

  // 【2026-10-10 老板第 5 条】已登记账号 key 集合的派生已随账号矩阵一起下线。

  // ===== 素材库（老板第 5 条）：本企业已存下的素材，最近 12 条 =====
  // 依赖 assets 状态：addAsset 后本组件要能立刻看到新素材（直接读 store 快照会拿到旧的）。
  const materials = useMemo(
    () => (companyId ? listAssets({ companyId }) : []),
    [companyId, listAssets, assets],
  );

  // ===== 派生：数据看板统计 =====
  const articleCount = dash.articles.length;
  const crisisCount = dash.crisis.length;
  const crisisPending = dash.crisis.filter((c) => crisisLevel(c) !== 'g').length;
  const personaCount = dash.personas.length;

  // 「📌 今天要处理」版块已下线（2026-10-10 老板第 5 条：进生成文章页要清爽、直接就是生文章）。
  // 待发布 / 危机等待办改由「数据看板」Tab 与「公关危机」模块各自呈现。

  // 最近危机（取标题，最多 5 条）
  const recentCrisis = dash.crisis.slice(0, 5);

  // ===== GEO 文章库（老板第 3 条）：列出「关键词 / 目标 / 平台 / 就绪度 / 状态 / 日期」，
  // 不再只显示「标题 + 状态」。默认最多 10 篇（与网页版 loadArticles 同一口径），可展开全部。
  const articleRows = articlesAll ? dash.articles : dash.articles.slice(0, 10);
  const geoScore = dash.geo;

  return (
    <div className="module-page">
      {/* ===== 页头 ===== */}
      <div className="hd-header">
        <div className="hd-header-logo">
          <img src={douyaLogo} alt="" draggable="false" style={{ width: 18, height: 18, objectFit: 'contain' }} />
          新媒体工作台 · 内容创作管理
        </div>
        <div className="hd-header-actions">
          {/* 原「✍️ 生成文案」按钮已移除：生成文案已提升为本页第一、常驻可见的版块（老板第 6 条），
              header 再放一个同名按钮纯属重复，且它只会 scroll 到已在视口内的版块、点击无可见变化。 */}
          <Button onClick={loadDash} loading={dash.loading} disabled={dash.loading}>↻ 刷新数据</Button>
        </div>
      </div>

      {/* GEO 曝光度诊断展示已移除（老板第 7 条：GEO 诊断展示只归「经营诊断」，别处不放，避免重复）。
          本页只保留「生成文案」这一主业；要看 GEO 体检请到「经营诊断」。 */}

      {/* 平台账号矩阵已下线（2026-10-10 老板第 5 条：「生成文章删掉账号矩阵」）。

          原链路太长：先注册 → 回填账号 → 才能发文。现改为文末「🚀 快捷打开发文平台」，
          不登记账号，直接点开各平台创作者后台发文页。
          注：mediaAccountStore 与相关函数（draftValue/saveDraft/copyAccountInfo 等）保留未用，
          不删历史数据、不影响已在别处（如平台账号矩阵组件）的登记。 */}
      {/* ===== ✍️ 生成文案（独立版块，常驻可见）=====
          老板第 6 条：「现在生成文案给我单独在新媒体中心里面放一个版块。」
          原来它是「文案与诊断」里的一个二级 tab，用户得先点进 tab 才看得到 → 现提升为本页第一版块。 */}
      <div className="hd-dash-card nmc-copy" id="nm-copy">
        <div className="hd-dash-hd">✍️ 生成文案</div>
          <div className="hd-dash-bd">
            <div className="xm-form">
              {/* 豆芽读到的企业：把「生成依据」显式摆出来，而不是角落一句「已读取资产」 */}
              <div className={'wz-read' + (hasAsset && missingAsset.length < 3 ? '' : ' wz-read-warn')}>
                <div className="wz-read-hd">
                  <span className="wz-read-title">
                    {hasAsset ? `豆芽读到的「${asset.companyName || currentCompany?.name || '当前企业'}」` : '豆芽还没读到你的企业'}
                  </span>
                  <span className="wz-read-count">
                    {assetFields.filter((f) => f.v).length}/{assetFields.length} 项齐全
                  </span>
                </div>
                {/* 老板第 6 条：把「企业资产库的数据到底有没有被用上」摆到台面上 —— 显式标注本次生成带出了哪些资产 */}
                <div className="wz-from">
                  <span className="wz-from-label">已从企业资产库带出</span>
                  {assetFrom.map((f) => (
                    <span className={'wz-from-chip' + (f.ok ? ' ok' : ' miss')} key={f.k}>
                      {f.ok ? '✓' : '✕'} {f.k}
                    </span>
                  ))}
                  <span className="wz-from-hint">
                    {assetFrom.every((f) => f.ok)
                      ? '写文案时会自动带上这三项，不用重复填'
                      : '带 ✕ 的还没录进来，文案里只能瞎猜 —— 去补一下更准'}
                  </span>
                </div>
                {hasAsset ? (
                  <div className="wz-read-list">
                    {assetFields.map((f) => (
                      <div className={'wz-read-row' + (f.v ? '' : ' miss')} key={f.k}>
                        <span className="wz-read-k">{f.k}</span>
                        <span className="wz-read-v" title={f.v}>
                          {f.v ? (f.v.length > 46 ? f.v.slice(0, 46) + '…' : f.v) : '缺 —— 写文案时会瞎猜'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="wz-read-hint">
                    没有企业档案，写出来只会是通用稿。豆芽建议先花两分钟建档，之后每篇文案都会自动带上你的卖点与人设。
                  </div>
                )}
                {(missingAsset.length > 0 || !hasAsset) && onSelectModule ? (
                  <button type="button" className="wz-read-link" onClick={() => onSelectModule('asset')}>
                    {hasAsset ? `去补齐缺的 ${missingAsset.length} 项 →` : '去建企业档案 →'}
                  </button>
                ) : null}
              </div>
              <div className="xm-field">
                <label className="field-label">文案类型</label>
                <div className="choice-row">
                  {TYPE_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      className={'choice-chip' + (type === o.value ? ' active' : '')}
                      onClick={() => setType(o.value)}
                    >
                      <span className="choice-icon">{o.icon}</span>
                      <span>{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="xm-field">
                <label className="field-label">风格</label>
                <div className="choice-row">
                  {STYLE_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      className={'choice-chip' + (style === o.value ? ' active' : '')}
                      onClick={() => setStyle(o.value)}
                    >
                      <span className="choice-icon">{o.icon}</span>
                      <span>{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="xm-field">
                <label className="field-label">模型</label>
                <div className="choice-row">
                  {[
                    { value: 'daily', label: '日常内容', icon: '⚡' },
                    { value: 'wenan', label: '精品文案', icon: '✨' },
                  ].map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      className={'choice-chip' + (mode === o.value ? ' active' : '')}
                      onClick={() => setMode(o.value)}
                      data-nm-model={o.value}
                    >
                      <span className="choice-icon">{o.icon}</span>
                      <span>{o.label}</span>
                    </button>
                  ))}
                </div>
                <div className="wz-plat-hint">
                  {mode === 'wenan'
                    ? '精品文案：800~1500 字深度稿，3 个备选标题 + 分节结构，适合品牌故事与深度投放。'
                    : '日常内容：300~500 字快稿，1 个主标题拿来就能发，适合通知与日更。'}
                </div>
              </div>

              <div className="xm-field">
                <label className="field-label">主题</label>
                <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={hasAsset ? `围绕「${asset.companyName}」写什么？如：春季口腔种植优惠活动` : '如：春季口腔种植优惠活动'} />
              </div>

              <div className="xm-field">
                <label className="field-label">补充内容</label>
                <Input.TextArea
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  rows={3}
                  placeholder="产品卖点、目标人群、注意事项等"
                />
              </div>

              {refs.trim() ? (
                <div className="xm-field">
                  <label className="field-label">参考资料（来自创作工作台）</label>
                  <Input.TextArea
                    value={refs}
                    onChange={(e) => setRefs(e.target.value)}
                    rows={3}
                    placeholder=""
                  />
                  <div className="wz-plat-hint">这些内容会随生成一起交给豆芽；可在这里继续改。</div>
                </div>
              ) : null}

              <div className="xm-switches">
                <label className="xm-switch"><Switch checked={webSearch} onChange={setWebSearch} /> 联网搜索（联网补充最新行业信息）</label>
              </div>

              <div className="xm-field">
                <label className="field-label">账号人设</label>
                <Select
                  mode="multiple"
                  allowClear
                  value={personaSel}
                  onChange={setPersonaSel}
                  style={{ width: '100%' }}
                  placeholder="可多选，不选中则不限定人设"
                  options={personas.map((p) => ({
                    value: p.id != null ? p.id : (p.account_name || p.name),
                    label: p.name || p.account_name || p.persona || String(p),
                  }))}
                />
              </div>

              <div className="xm-field">
                <label className="field-label">发到哪些平台（可不选，豆芽按内容自动适配）</label>
                <Select
                  mode="multiple"
                  allowClear
                  value={platformSel}
                  onChange={setPlatformSel}
                  style={{ width: '100%' }}
                  placeholder="多选，豆芽会按各平台读者分别适配口吻"
                  options={GEO_PLATFORMS.map((p) => ({
                    value: p.key,
                    label: `${p.icon} ${p.name}`,
                  }))}
                />
                <div className="wz-plat-hint">
                  选中的平台，豆芽会按各平台读者的口气分别写，不是一稿复制粘贴。
                </div>
              </div>

              <div className="xm-actions">
                <Button type="primary" onClick={() => generate()} disabled={busy} loading={busy}>
                  {busy ? '生成中（可切换页面，回来结果仍在）' : '生成文案'}
                </Button>
                <Button
                  onClick={() => {
                    setTopic(''); setExtra(''); setPersonaSel([]); setPlatformSel([]);
                    setFormError(''); setGuide(null);
                  }}
                  disabled={busy}
                >
                  清空
                </Button>
              </div>

              {(error || formError) && <div className="xm-error">⚠️ {error || formError}</div>}
            </div>

            {result && (
              <div className="xm-result">
                <div className="xm-result-head">
                  <span>生成结果</span>
                  <div className="xm-result-ops">
                    <Button
                      size="small"
                      type="primary"
                      onClick={async () => {
                        const ok = await copyText(mdToPlain(resultText));
                        if (ok) message.success('已复制全文');
                        else message.error('复制失败，请手动选中文本复制');
                      }}
                    >
                      📋 复制全文
                    </Button>
                    {sections.length > 1 ? (
                      <Popover
                        trigger="click"
                        placement="bottomRight"
                        title="按小节复制"
                        content={(
                          <div className="xm-copy-pop">
                            {sections.map((s, i) => (
                              <div className="xm-copy-item" key={i}>
                                <span className="xm-copy-title" title={s.title}>{s.title}</span>
                                <Button
                                  size="small"
                                  type="link"
                                  onClick={async () => {
                                    const ok = await copyText(sectionPlainText(s));
                                    if (ok) message.success('已复制：' + s.title);
                                    else message.error('复制失败，请手动选中文本复制');
                                  }}
                                >
                                  复制这段
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      >
                        <Button size="small">分段复制</Button>
                      </Popover>
                    ) : null}
                    <Button size="small" onClick={saveCopyAndSync} disabled={busy || !currentCompany}>
                      {savedName ? '已保存 ✓' : '存入产出并同步'}
                    </Button>
                    <Button size="small" onClick={() => generate()} disabled={busy} loading={busy}>重新生成</Button>
                  </div>
                </div>
                <div className="xm-result-body"><Markdown>{resultText}</Markdown></div>
                {/* 合规预检：发出去之前先把「绝对化用语 / 疗效承诺 / 编造数据」挑出来 */}
                <div
                  className={'wz-comp' + (compliance && compliance.clean === false ? ' has' : '')}
                  data-compliance={compliance ? (compliance.clean ? 'clean' : String(compliance.total)) : 'idle'}
                >
                  <div className="wz-comp-hd">
                    <span className="wz-comp-t">合规预检</span>
                    {compBusy ? <span className="wz-comp-s">正在检查…</span> : null}
                    {!compBusy && compliance && compliance.ok === false
                      ? <span className="wz-comp-s bad">{compliance.error}</span> : null}
                    {!compBusy && compliance && compliance.ok !== false && compliance.clean
                      ? <span className="wz-comp-s ok">未发现违规表述，可以发</span> : null}
                    {!compBusy && compliance && compliance.ok !== false && !compliance.clean
                      ? <span className="wz-comp-s bad">{compliance.summary}</span> : null}
                    <Button size="small" type="link" onClick={() => runCompliance(resultText)} disabled={compBusy}>
                      重扫
                    </Button>
                  </div>
                  {compliance && compliance.ok !== false && !compliance.clean ? (
                    <div className="wz-comp-list">
                      {compliance.hits.map((h, i) => (
                        <div className={'wz-comp-item ' + h.level} key={i}>
                          <span className="wz-comp-lv">{h.level === 'block' ? '必须改' : '注意'}</span>
                          <span className="wz-comp-m">「{h.match}」</span>
                          <span className="wz-comp-a">
                            {h.advice}{h.fix ? '（建议：' + h.fix + '）' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
            {!result && !busy && !error && !formError && (
              <div className="xm-empty">
                填好上面的信息，点「生成文案」就行。
                {precheckGaps().length > 0
                  ? ' 缺的东西豆芽会先问你一句。'
                  : ' 豆芽会按你的企业信息和平台来写。'}
              </div>
            )}
          </div>
        </div>

      {/* ===== 📚 素材库（2026-10-10 老板第 5 条：生成文章 → 然后素材库）===== */}
      <div className="hd-dash-card nmc-assets" id="nm-assets" style={{ marginBottom: 14 }}>
        <div className="hd-dash-hd">
          📚 素材库（{materials.length}）
          {onSelectModule ? (
            <span className="hd-refresh" onClick={() => onSelectModule('asset')}>打开完整资产库 →</span>
          ) : null}
        </div>
        <div className="hd-dash-bd">
          {materials.length === 0 ? (
            <div className="hd-dash-empty">
              还没有素材。上面生成的内容点「存入项目产出」后，会自动出现在这里。
            </div>
          ) : (
            <div className="nmc-asset-list">
              {materials.slice(0, 12).map((a) => (
                <div className="nmc-asset-item" key={a.id || a.name}>
                  <span className="nmc-asset-badge">{ASSET_TYPES[a.type] || '素材'}</span>
                  <span className="nmc-asset-name" title={a.name}>{a.name}</span>
                  <span className="nmc-asset-time">
                    {a.updatedAt ? new Date(a.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== 🚀 快捷打开发文平台（2026-10-10 老板第 5 条）=====
          不用登记账号，点一下直接进各平台创作者后台发文页；账号矩阵已下线（见上方注释）。 */}
      <div className="hd-dash-card nmc-publish" id="nm-publish" style={{ marginBottom: 14 }}>
        <div className="hd-dash-hd">
          🚀 打开发文平台
          <span className="hd-refresh">点开就进创作后台，不用再找入口</span>
        </div>
        <div className="hd-dash-bd">
          <div className="nmc-plat-row">
            {GEO_PLATFORMS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={'nmc-plat-btn' + (p.publishUrl ? '' : ' disabled')}
                title={p.publishUrl ? ('打开发文页：' + p.publishUrl) : '该平台发文入口未确认，暂不支持直达'}
                onClick={() => gotoPublish(p)}
              >
                <span className="nmc-plat-icon">{p.icon}</span>
                <span className="nmc-plat-name">{p.name}</span>
              </button>
            ))}
          </div>
          <div className="nmc-plat-hint">
            发文要你本人登录平台完成，豆芽不能代发；上面生成好的文章直接复制过去贴即可。
          </div>
        </div>
      </div>

      {/* ===== 次级能力：数据看板 / 媒体推荐（用 tab 切换）===== */}
      <div className="hd-tabs">
        <button className={'hd-tab' + (tab === 'dash' ? ' active' : '')} onClick={() => setTab('dash')}>
          📊 数据看板
        </button>
        <button className={'hd-tab' + (tab === 'media' ? ' active' : '')} onClick={() => setTab('media')}>
          📣 媒体推荐
          <span className="hd-tab-count">AI</span>
        </button>
      </div>

      {/* ===== 数据看板 tab ===== */}
      {tab === 'dash' && (
        <>
          <div className="hd-dash-grid">
            {/* 核心指标卡 */}
            <div className="hd-dash-card">
              <div className="hd-dash-hd">
                核心数据
                <span className="hd-refresh" onClick={loadDash}>刷新</span>
              </div>
              <div className="hd-dash-bd">
                <div className="hd-dash-sr">
                  {/* 老板第 3 条：网页版第一格是「GEO总分」，这里对齐（拿不到显示 --）；
                      2026-10-11 术语清剿：标题改白话，key/取值逻辑不动 */}
                  <div className="hd-dash-st">
                    <div className="v">
                      {geoScore && geoScore.overall != null ? Number(geoScore.overall).toFixed(1) : '--'}
                    </div>
                    <div className="l">AI 搜索总分</div>
                  </div>
                  <div className="hd-dash-st">
                    <div className="v">{dash.loaded ? articleCount : '--'}</div>
                    <div className="l">AI 搜索文章</div>
                  </div>
                  <div className={'hd-dash-st' + (crisisPending > 0 ? ' danger' : '')}>
                    <div className={'v' + (crisisPending > 0 ? ' r' : '')}>{dash.loaded ? crisisPending : '--'}</div>
                    <div className="l">危机待处理</div>
                  </div>
                  <div className="hd-dash-st ppl">
                    <div className="v p">{dash.loaded ? personaCount : '--'}</div>
                    <div className="l">发文账号</div>
                  </div>
                  <div className="hd-dash-st good">
                    <div className="v g">{PLATFORMS.length}</div>
                    <div className="l">覆盖平台</div>
                  </div>
                </div>
                {!dash.loaded && (
                  <div className="hd-dash-empty">
                    正在加载实时数据…
                  </div>
                )}
                <div className="hd-note-row g">
                  <span className="hd-dot" />
                  数据来自自建后端真实接口，点击「刷新」同步最新状态
                </div>
              </div>
            </div>

            {/* 🎯 AI 搜索评分（老板第 3 条：对齐网页版「GEO思维评分」四维条；2026-10-11 改白话标题） */}
            <div className="hd-dash-card">
              <div className="hd-dash-hd">
                🎯 AI 搜索评分
                <span className="nmc-geo-note">
                  {geoScore && geoScore.brand ? geoScore.brand : (dash.loaded ? '' : '加载中…')}
                </span>
              </div>
              <div className="hd-dash-bd">
                {geoScore && geoScore.dims && geoScore.dims.length > 0 ? (
                  <div className="nmc-geo-dims">
                    {geoScore.dims.map((d) => (
                      <div className="nmc-geo-row" key={d.key}>
                        <span className="nmc-geo-name">{d.label}</span>
                        <div className="nmc-geo-bar">
                          <div
                            className="nmc-geo-fill"
                            style={{
                              width: Math.min(100, Math.max(0, Number(d.value) || 0)) + '%',
                              background: GEO_DIM_COLORS[d.key] || '#30d158',
                            }}
                          />
                        </div>
                        <span className="nmc-geo-val">{Number(d.value || 0).toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="hd-dash-empty">
                    {dash.loaded
                      ? '暂未拿到 AI 搜索评分。点右上「↻ 刷新数据」再试一次。'
                      : '加载中…'}
                  </div>
                )}
                <div className="hd-note-row g">
                  <span className="hd-dot" />
                  被搜到 / 被 AI 提到 / 企业信息准确 / 容易发现 四维评分，数值来自自建后端真实接口
                </div>
              </div>
            </div>

            {/* 危机预警卡 */}
            <div className="hd-dash-card">
              <div className="hd-dash-hd">🚨 危机预警</div>
              <div className="hd-dash-bd">
                {recentCrisis.length > 0 ? (
                  recentCrisis.map((c, i) => {
                    const lv = crisisLevel(c);
                    const t = crisisTitle(c) || '(无标题危机)';
                    return (
                      <div className="hd-dash-ct" key={i}>
                        <span className="ct-ic">
                          <span className={'hd-dot'} style={{
                            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                            background: lv === 'r' ? 'var(--c-danger)' : lv === 'g' ? 'var(--c-success)' : 'var(--c-warn)',
                          }} />
                        </span>
                        <span className="ct-tx">{t}</span>
                        <span className="ct-tag">
                          <Tag color={lv === 'r' ? 'red' : lv === 'g' ? 'green' : 'orange'} style={{ margin: 0 }}>
                            {lv === 'r' ? '高危' : lv === 'g' ? '正常' : '关注'}
                          </Tag>
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="hd-dash-empty">
                    {dash.loaded ? '暂无危机舆情记录' : '加载中…'}
                  </div>
                )}
                {dash.loaded && recentCrisis.length === 0 && (
                  <div className="hd-note-row g"><span className="hd-dot" />当前无待处理危机，品牌舆情平稳</div>
                )}
              </div>
            </div>
          </div>

          {/* 📝 AI 搜索文章库（2026-10-10 老板第 3 条：对齐网页版的列与详情弹窗；
              2026-10-11 术语清剿：标题改白话，列名「就绪度」→「完整度」） */}
          <div className="hd-dash-card nmc-geo-lib" style={{ marginBottom: 14 }}>
            <div className="hd-dash-hd">
              📝 AI 搜索文章库（{articleCount} 篇）
              <span className="hd-refresh" onClick={() => onSelectModule && onSelectModule('media')}>去媒体发文 →</span>
            </div>
            <div className="hd-dash-bd">
              {dash.articles.length > 0 ? (
                <>
                  <Table
                    className="nmc-geo-table"
                    size="small"
                    rowKey={(a, i) => String((a && a.id) != null ? a.id : i)}
                    dataSource={articleRows}
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                    onRow={(a) => ({ onClick: () => setArticleDetail(a), style: { cursor: 'pointer' } })}
                    columns={[
                      {
                        title: '关键词',
                        key: 'topic',
                        width: 230,
                        render: (_, a) => {
                          const kw = String((a && (a.topic || a.mode || a.title)) || '--');
                          return (
                            <span className="nmc-geo-kw" title={kw}>
                              {(a && a.published_url ? '✅ ' : '📝 ') + kw}
                            </span>
                          );
                        },
                      },
                      {
                        title: '生成目标',
                        key: 'goal',
                        width: 120,
                        render: (_, a) => <span className="nmc-geo-goal">{goalLabel(a && a.geo_task_goal)}</span>,
                      },
                      { title: '平台', key: 'platform', width: 90, render: (_, a) => (a && a.platform) || '--' },
                      {
                        title: '完整度',
                        key: 'readiness',
                        width: 80,
                        render: (_, a) => (a && a.geo_readiness != null && a.geo_readiness !== '' ? a.geo_readiness : '--'),
                      },
                      {
                        title: '状态',
                        key: 'status',
                        width: 90,
                        render: (_, a) => (
                          <Tag color={a && a.published_url ? 'green' : 'orange'} style={{ margin: 0 }}>
                            {a && a.published_url ? '已发布' : '草稿'}
                          </Tag>
                        ),
                      },
                      {
                        title: '生成日期',
                        key: 'created',
                        width: 110,
                        render: (_, a) => <span className="nmc-geo-dim">{fmtDay(a && a.created_at)}</span>,
                      },
                      {
                        title: '操作',
                        key: 'ops',
                        width: 100,
                        render: (_, a) => (
                          a && a.published_url ? (
                            <a
                              className="nmc-geo-link"
                              href={a.published_url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              查看 ↗
                            </a>
                          ) : (
                            <Button
                              size="small"
                              type="link"
                              style={{ padding: 0 }}
                              onClick={(e) => { e.stopPropagation(); setArticleDetail(a); }}
                            >
                              查看
                            </Button>
                          )
                        ),
                      },
                    ]}
                  />
                  {dash.articles.length > 10 ? (
                    <div className="nmc-geo-more">
                      {articlesAll ? (
                        <span className="nmc-geo-more-tx">已显示全部 {dash.articles.length} 篇</span>
                      ) : (
                        <Button size="small" onClick={() => setArticlesAll(true)}>
                          查看全部（{dash.articles.length} 篇）
                        </Button>
                      )}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="hd-dash-empty">
                  {dash.loaded
                    ? '还没有文章。点上面「生成文案」写第一篇。'
                    : '加载中…'}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ===== 媒体推荐 tab ===== */}
      {tab === 'media' && (
        <div className="hd-dash-card">
          <div className="hd-dash-hd">
            📣 媒体智能推荐
            <Button size="small" type="primary" ghost onClick={recommendMedia} loading={mediaRec.busy}>
              {mediaRec.recs.length ? '重新推荐' : 'AI 智能推荐'}
            </Button>
          </div>
          <div className="hd-dash-bd">
            {!hasAsset && (
              <div className="hd-dash-empty">
                尚未建档。建议先到「🗂 资产库」完善企业资产，AI 才能按画像精准推荐。
              </div>
            )}
            {mediaRec.busy && <div className="xm-note">⏳ {mediaRec.stage}</div>}
            {mediaRec.error && <div className="xm-error">⚠️ {mediaRec.error}</div>}
            {mediaRec.note && <div className="xm-note">ℹ️ {mediaRec.note}</div>}

            {mediaRec.recs.length > 0 ? (
              <div className="media-rec-list" style={{ marginTop: 0 }}>
                {mediaRec.recs.map((r, i) => (
                  <div className="media-rec-item" key={r.name + i}>
                    <div className="media-rec-rank">{i + 1}</div>
                    <div className="media-rec-body">
                      <div className="media-rec-name">
                        {r.name}
                        {r.category && <Tag color="green" style={{ marginLeft: 6 }}>{r.category}</Tag>}
                        {r.fromBackend && <Tag color="green" style={{ marginLeft: 6 }}>AI 推荐</Tag>}
                        <span className="media-rec-weight">权重 {r.weight}</span>
                      </div>
                      <div className="media-rec-reason">{r.reason}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              !mediaRec.busy && !mediaRec.error && (
                <div className="hd-dash-empty">
                  点「AI 智能推荐」，AI 会先深度分析企业背景 / 产品 / 规模，再据此匹配媒体资源。
                  <br />
                  <Button type="link" style={{ padding: 0 }} onClick={() => onSelectModule && onSelectModule('media')}>
                    前往媒体发文（完整媒体库）→
                  </Button>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* ===== 生成前置引导卡：直接点「生成文案」但前置没齐时出现 ===== */}
      <Modal
        title="豆芽先跟你对一下"
        open={!!guide}
        onCancel={() => setGuide(null)}
        footer={null}
        width={520}
        destroyOnClose
      >
        {guide ? (
          <div className="wz-guide">
            <div className="wz-guide-sub">
              还差 {guide.gaps.length} 项。补齐后豆芽写出来的才像「你家的文案」，而不是通用稿。
            </div>
            {guide.gaps.map((g) => (
              <div className="wz-guide-item" key={g.id}>
                <div className="wz-guide-item-hd">
                  <span className="wz-guide-item-title">{g.title}</span>
                </div>
                <div className="wz-guide-item-why">为什么要在意：{g.why}</div>
                {g.go ? (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    onClick={() => {
                      g.go();
                      setGuide(null);
                    }}
                  >
                    {g.action}
                  </Button>
                ) : (
                  <span className="wz-guide-item-hint">{g.action}</span>
                )}
              </div>
            ))}
            <div className="wz-guide-foot">
              <Button onClick={() => setGuide(null)}>先不生成</Button>
              {topic.trim() || extra.trim() ? (
                <Button type="primary" onClick={() => { setGuide(null); generate({ force: true }); }}>
                  先按现有信息生成
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ===== AI 搜索文章详情（2026-10-10 老板第 3 条）=====
          网页版点一行会弹出「输入 → 输出」详情；桌面端此前只能看到标题，看不出这篇写了什么。
          字段缺失一律显示「--」，不用假数据填空。 */}
      <Modal
        title={articleDetail ? `文章详情 #${articleDetail.id != null ? articleDetail.id : '--'}` : '文章详情'}
        open={!!articleDetail}
        onCancel={() => setArticleDetail(null)}
        footer={null}
        width={720}
        destroyOnClose
      >
        {articleDetail ? (
          <div className="nmc-geo-detail">
            <div className="nmc-geo-detail-hd">📤 输入</div>
            <div className="nmc-geo-detail-grid">
              <div><span className="k">关键词 / 主题</span><span className="v">{articleDetail.topic || '--'}</span></div>
              <div><span className="k">生成目标</span><span className="v">{goalLabel(articleDetail.geo_task_goal)}</span></div>
              <div><span className="k">品牌</span><span className="v">{articleDetail.brand || '--'}</span></div>
              <div><span className="k">目标平台</span><span className="v">{articleDetail.platform || '--'}</span></div>
              <div><span className="k">生成模式</span><span className="v">{modeLabel(articleDetail.mode)}</span></div>
              <div><span className="k">使用人</span><span className="v">{articleDetail.username || '--'}</span></div>
              <div>
                <span className="k">完整度</span>
                <span className="v">
                  {articleDetail.geo_readiness != null && articleDetail.geo_readiness !== ''
                    ? `${articleDetail.geo_readiness} 分`
                    : '--'}
                </span>
              </div>
              <div><span className="k">生成日期</span><span className="v">{fmtDay(articleDetail.created_at)}</span></div>
            </div>
            {articleDetail.input_material ? (
              <>
                <div className="nmc-geo-detail-hd">✏️ 输入的原始素材</div>
                <pre className="nmc-geo-pre">{String(articleDetail.input_material)}</pre>
              </>
            ) : null}
            <div className="nmc-geo-detail-hd">📥 输出（豆芽生成的文章）</div>
            <pre className="nmc-geo-pre">{String(articleDetail.content || articleDetail.preview || '（文章内容为空）')}</pre>
            {articleDetail.published_url ? (
              <div className="nmc-geo-detail-foot">
                <a href={articleDetail.published_url} target="_blank" rel="noreferrer">打开发布页 ↗</a>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
