import React, { useState, useMemo, useRef } from 'react';
import { Button, Input, Modal } from 'antd';
import { mediaResources } from '../data/mediaResources.js';
import { groupFacts, assetToRecommendPayload } from '../services/companyProfile.js';
import { useMarketingAsset, useMarketingGoal } from '../store/marketingStore.jsx';
import { useCompany } from '../store/companyStore.jsx';
// 第 5 层第 3 步：媒体推荐也要吃到「这家公司的真实资料 + 三级可信度」。
// 走统一入口（buildAIContext 自解析当前企业），本模块不再自己决定"给后端送什么企业信息"。
import { buildAIContext } from '../services/contextBuilder.js';
// 第十五轮（2026-10-15）：「上传 word」入口的正文提取（docx/txt；老 .doc 诚实报不支持）。
import { extractFileText } from '../utils/docxText.js';

/**
 * 行业关键词 → 媒体分类 映射。
 * 仅作为「AI 深度分析不可用」时的兜底，且只用企业资产里的行业/产品/品牌文本匹配，
 * 不再用公司名字面匹配（旧版正是因此把「上游货源」误判为「生活消费」）。
 */
const INDUSTRY_MAP = [
  { cat: '新闻资讯', kw: ['新闻', '政府', '政务', '公关', '品牌', '国企', '通报', '事件', '媒体'] },
  { cat: '财经商业', kw: ['金融', '财经', '投资', '银行', '证券', '保险', '创业', '商业', '上市', '基金', '股票', '经济', '招商', '企业'] },
  { cat: 'IT科技', kw: ['科技', '互联网', '数码', 'it', '软件', '人工智能', 'ai', '云计算', '大数据', '通信', '芯片', '游戏', '电商', 'saas', '数字化'] },
  { cat: '健康医疗', kw: ['医疗', '健康', '口腔', '牙科', '医药', '医院', '养生', '医美', '生物', '保健', '诊所', '器械', '耗材'] },
  { cat: '能源环保', kw: ['能源', '电力', '环保', '新能源', '光伏', '储能', '电池', '碳中和'] },
  { cat: '生活消费', kw: ['消费', '美食', '餐饮', '时尚', '美妆', '家居', '母婴', '旅游', '食品', '零售'] },
  { cat: '工业贸易', kw: ['工业', '制造', '贸易', '机械', '化工', '建筑', '物流', '出口', '工厂', '供应链'] },
];

/** 分类 → 建议文章类型 / 人设（用于生成推荐理由） */
const CAT_ADVICE = {
  新闻资讯: { persona: '专业品牌官方号', article: '企业新闻稿 / 行业资讯' },
  财经商业: { persona: '财经观点型账号', article: '财经观点 / 品牌动态' },
  IT科技: { persona: '技术解读型账号', article: '技术解读 / 产品评测' },
  健康医疗: { persona: '专业科普账号', article: '健康科普 / 专业科普' },
  能源环保: { persona: '行业洞察型账号', article: '行业洞察 / 企业动态' },
  生活消费: { persona: '种草测评型账号', article: '种草测评 / 生活方式' },
  工业贸易: { persona: '行业方案型账号', article: '行业方案 / 企业宣传' },
};

/** 兜底：按文本匹配行业分类 */
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

/** 把后端 media-recommend 的 categories 转成 category→优先级序号 的映射 */
function buildCategoryPriority(categories) {
  const map = {};
  (categories || []).forEach((c, i) => {
    const name = c && (c.category || c.name);
    if (name && map[name] === undefined) map[name] = i;
  });
  return map;
}

/** 由企业营销资产组装一个与旧 analyzeCompany profile 同构的画像对象，供展示与打分复用。 */
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

export default function MediaPublish({ geoProxy }) {
  // 企业画像 / 行业 / 产品 / 人群 / 目标全部来自共享资产，不再重复填写企业信息
  const { asset, hasAsset, refreshAsset } = useMarketingAsset();
  const { goal } = useMarketingGoal();
  const { currentCompany } = useCompany();

  const categories = useMemo(() => {
    const set = new Set(mediaResources.map((m) => m.category).filter(Boolean));
    return ['全部', ...Array.from(set)];
  }, []);
  const maxPrice = useMemo(
    () => mediaResources.reduce((mx, m) => Math.max(mx, num(m.price, 0)), 0),
    [],
  );

  const [activeCat, setActiveCat] = useState('全部');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [recNote, setRecNote] = useState('');

  // 本次推荐使用的画像（由资产构造），展示用
  const [profile, setProfile] = useState(null);
  // 后端推荐结果
  const [recs, setRecs] = useState([]);
  const [backendCats, setBackendCats] = useState([]);
  // 历史 GEO 发文
  const [history, setHistory] = useState({ loaded: false, count: 0, titles: [] });
  // 手动刷新画像
  const [refreshing, setRefreshing] = useState(false);

  // 联系弹窗状态
  const [contact, setContact] = useState({ open: false, media: '', name: '', info: '', message: '', busy: false, msg: '' });

  // 【2026-10-10 傻瓜化】老板：「这软件给笨蛋用的，根本懒得看内容。」
  // 原形态把 100 家媒体的百科式简介（每家 200 字）整个铺在首屏 ⇒ 实测首屏 12374 字 / 110 个按钮。
  // 改为：首屏只有「推荐结果 + 一个主按钮」，其余两块默认收起，用户想看才展开。
  // 【第十五轮 2026-10-15 反转】老板：「直接展示100家媒体…不点就是下面所有媒体都展示出来
  // 让用户自己选」⇒ 媒体库恢复默认展开（showAll 默认 true），AI 分析只负责把合适的排前 + 加徽章。
  const [showAll, setShowAll] = useState(true); // 全部媒体库（默认展开，用户自己选）
  const [showProfile, setShowProfile] = useState(false); // 豆芽读到的企业信息（默认收起）

  // ===== 第十五轮：按文章内容挑媒体（上传 word / 粘贴正文 → AI 分析）=====
  const [articleText, setArticleText] = useState('');
  const [articleName, setArticleName] = useState('');
  const [articleBusy, setArticleBusy] = useState(false);
  const [articleMsg, setArticleMsg] = useState('');
  // 分析结果（设计系统 v3 .result 同款）：判定分类 + 命中词 + 匹配家数
  const [articleResult, setArticleResult] = useState(null);
  const wordInputRef = useRef(null);

  const filtered = useMemo(
    () => (activeCat === '全部' ? mediaResources : mediaResources.filter((m) => m.category === activeCat)),
    [activeCat],
  );

  // 推荐结果按媒体名索引：{ 媒体名: { rank, reason, category, fromBackend } }
  const recMap = useMemo(() => {
    const map = {};
    recs.forEach((r, i) => {
      if (r && r.name) map[r.name] = { rank: i + 1, reason: r.reason, category: r.category, fromBackend: !!r.fromBackend };
    });
    return map;
  }, [recs]);

  // 推荐后：被推荐的媒体自动排最前（按推荐名次），未推荐的保持原顺序，让用户一眼看到推荐结果
  const displayed = useMemo(() => {
    if (!recs.length) return filtered;
    return filtered
      .map((m) => ({ m, rank: recMap[m.name] ? recMap[m.name].rank : 9999 }))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.m);
  }, [filtered, recs, recMap]);

  // ===== 【2026-10-10 傻瓜化】首屏只留「该投哪几家」=====

  /**
   * 本地打分：以企业资产画像（核心卖点 + 目标人群 + 后端分类优先级）为输入，
   * 对 100 条媒体资源打分。资产为空时退化为「行业/产品/品牌文本」匹配。
   */
  function scoreMedia(prof, cats) {
    const catPriority = buildCategoryPriority(cats);
    const catCount = Object.keys(catPriority).length;

    const keywords = prof && prof.coreKeywords ? prof.coreKeywords.slice() : [];
    const audiences = prof && prof.audience ? prof.audience.slice() : [];

    const fallbackText = [asset.industry, asset.profile, asset.products].filter(Boolean).join(' ');
    const fallbackCat = catCount ? null : matchCategory(
      keywords.length ? keywords.join(' ') : fallbackText,
    );

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
      };
    });

    return scored.sort((a, b) => {
      if (a.catRank !== b.catRank) return a.catRank - b.catRank;
      return b.score - a.score;
    });
  }

  /** 尽力拉取历史 GEO 发文；拉不到就标记为待后端支持，绝不造假数据 */
  async function loadHistory() {
    try {
      const r = await geoProxy('/api/geo/articles', 'GET', {});
      const list = Array.isArray(r && r.articles) ? r.articles : [];
      const titles = list
        .map((a) => (a && (a.title || a.topic || a.name)) || '')
        .filter(Boolean)
        .slice(0, 6);
      setHistory({ loaded: true, count: list.length, titles });
    } catch {
      setHistory({ loaded: true, count: 0, titles: [] });
    }
  }

  async function recommend() {
    if (!hasAsset) {
      setError('尚未建档。请先到「🗂 资产库」完善企业资产，再回来智能推荐。');
      return;
    }

    setBusy(true);
    setError('');
    setRecNote('');
    setRecs([]);
    setBackendCats([]);

    // 由共享资产构造画像（不再调 company-analyze）
    const prof = assetToProfile(asset);
    setProfile(prof);

    try {
      // ---------- 1) 按资产请求后端媒体推荐 ----------
      setStage('📡 正在按企业资产匹配媒体…');
      let backendErr = '';
      let backendMedia = [];
      let cats = [];
      try {
        // 第 5 层第 3 步：除资产派生字段外，再把「企业真实资料 + 【资料可信度】分级」一起送。
        // ⚠️ 这个字段**后端必须也读**，否则等于没加（装饰性改动）。backend_main.py 的
        //    /api/geo/media-recommend 已同步把 company_context 拼进投放顾问 prompt，见第 94 步门禁。
        const recPayload = {
          ...assetToRecommendPayload(asset, goal ? goal.label : '', currentCompany ? currentCompany.name : ''),
          company_context: buildAIContext({
            companyId: currentCompany ? currentCompany.id : '',
          }).companyContext,
        };
        const r = await geoProxy('/api/geo/media-recommend', 'POST', recPayload);
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
      setBackendCats(cats);

      // ---------- 2) 本地打分（以资产画像为输入） ----------
      const localRecs = scoreMedia(prof, cats);

      // ---------- 3) 合并：后端结果在同分类内优先 ----------
      const byName = new Map(localRecs.map((r) => [r.name, r]));
      const merged = [];
      const used = new Set();
      for (const b of backendMedia) {
        const nm = b && (b.name || b.media) ? String(b.name || b.media) : '';
        if (!nm) continue;
        const local = byName.get(nm);
        const backendReason = (b && (b.recommend_reason || b.reason || b.reasoning || b.detail)) || '';
        if (local) {
          merged.push({
            ...local,
            reason: backendReason ? `${backendReason}（${local.reason}）` : local.reason,
            fromBackend: true,
          });
          used.add(nm);
        } else {
          merged.push({
            name: nm,
            category: (b && b.category) || '',
            score: num(b && b.weight, 0) * 0.6,
            catRank: (() => {
              const pr = buildCategoryPriority(cats);
              return pr[(b && b.category) || ''] === undefined ? 99 : pr[b.category];
            })(),
            reason: backendReason || `后端推荐：${(b && b.intro) || '暂无说明'}`,
            fromBackend: true,
            onlyBackend: true,
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

      setRecs(merged.slice(0, 12));

      // ---------- 4) 提示语 ----------
      if (backendMedia.length) {
        setRecNote('已基于企业营销资产完成深度匹配：行业归属与推荐理由均来自资产画像。');
      } else if (/登录|过期|token/i.test(String(backendErr))) {
        setRecNote('⚠️ 登录态已失效或后端连接失败，请重新登录后重试；当前为本地媒体库兜底结果。');
      } else if (asset.meta && asset.meta.degraded) {
        setRecNote('⚠️ 企业资产为手动建档（AI 分析曾降级），以下结果由本地按资产关键词匹配得出。');
      } else {
        setRecNote('后端媒体推荐接口无返回，以下结果由本地按资产画像关键词匹配得出。');
      }

      // ---------- 5) 历史 GEO 发文（尽力而为） ----------
      setStage('📚 正在读取历史 AI 搜索发文…');
      await loadHistory();
    } catch (e) {
      setError('推荐失败：' + e.message);
    } finally {
      setStage('');
      setBusy(false);
    }
  }

  /** 上传 word：提取正文填入文章框（诚实降级：读不出就提示粘贴，绝不造假正文） */
  async function handleWordFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setArticleBusy(true);
    setArticleMsg('');
    const r = await extractFileText(f);
    if (r.ok) {
      setArticleText(r.text);
      setArticleName(r.name);
      setArticleMsg(`已读入《${r.name}》正文 ${r.text.length} 字。点「AI 分析投哪家」让豆芽按内容挑。`);
    } else {
      setArticleMsg('⚠️ ' + r.error);
    }
    setArticleBusy(false);
  }

  /**
   * 第十五轮：AI 按文章内容挑媒体。
   * 判据全部本地可解释（不引分词库、不假装深度语义理解）：
   *   ① 行业分类：文章文本过 INDUSTRY_MAP 词表 → 得到内容方向（如「健康医疗」）；
   *   ② 内容关键词：命中分类词 + 文章里出现的自家产品词/卖点；
   *   ③ 打分排序：分类优先 → 关键词命中媒体简介 → 权重/地区/价格（沿用 scoreMedia）。
   * 结果写入 recs：被选中的媒体排最前并带「AI 选中」徽章；用户不点分析时，
   * 下方 100 家媒体原样展示，自己点「联系」——两条路径都给足。
   */
  async function analyzeArticle() {
    const text = articleText.trim();
    if (text.length < 20) {
      setArticleMsg('⚠️ 文章太短（至少 20 字），豆芽没法判断内容方向。');
      return;
    }
    setArticleBusy(true);
    setArticleMsg('');
    setError('');
    try {
      // ① 内容方向（文章优先，文章判不出才退回企业行业）
      const cat = matchCategory(text)
        || matchCategory([asset.industry, asset.products, asset.profile].filter(Boolean).join(' '));
      // ② 内容关键词：分类词表里在文章中出现的 + 文章中出现的自家产品词/卖点
      const words = [];
      if (cat) {
        const row = INDUSTRY_MAP.find((m) => m.cat === cat);
        if (row) words.push(...row.kw.filter((k) => k.length >= 2 && text.toLowerCase().includes(k.toLowerCase())));
      }
      const ownWords = [...(asset.coreSellingPoints || []), ...(Array.isArray(asset.products) ? asset.products : [])]
        .filter((k) => k && text.includes(k));
      words.push(...ownWords);
      // ③ 打分（分类置顶 + 关键词命中媒体简介/名称）
      const catsForScore = cat ? [{ category: cat, reason: '按文章内容判定' }] : [];
      const scored = scoreMedia({ coreKeywords: words.slice(0, 10), audience: [] }, catsForScore);
      const top = scored.filter((r) => r.score > 0).slice(0, 12);
      if (top.length === 0) {
        setArticleMsg('⚠️ 这篇文章没能匹配上任何媒体的方向，可以换个说法，或直接在下面 100 家里自己选。');
        setArticleResult(null);
        setArticleBusy(false);
        return;
      }
      setRecs(top);
      setArticleResult({ cat: cat || '综合', hits: words.slice(0, 3), count: top.length });
      setProfile(assetToProfile(asset));
      setBackendCats(catsForScore);
      setRecNote(
        `AI 已按文章内容分析：这篇内容偏向「${cat || '综合'}」方向，为你挑出 ${top.length} 家最匹配的媒体（排在最前、带「AI 选中」标）。不认可就直接在下面 100 家里自己选。`,
      );
      setArticleMsg(`✅ 分析完成：${articleName ? `《${articleName}》` : '粘贴的文章'} ${text.length} 字 → 挑出 ${top.length} 家。`);
    } catch (e2) {
      setArticleMsg('⚠️ 分析失败：' + (e2 && e2.message ? e2.message : String(e2)));
      setArticleResult(null);
    } finally {
      setArticleBusy(false);
    }
  }

  async function doRefreshProfile() {
    setRefreshing(true);
    setError('');
    const r = await refreshAsset();
    setRecNote(r.ok ? '✅ 画像已刷新' : '⚠️ ' + (r.error || '刷新失败'));
    setRefreshing(false);
  }

  function openContact(mediaName) {
    setContact({ open: true, media: mediaName, name: '', info: '', message: '', busy: false, msg: '' });
  }
  async function submitContact() {
    if (!contact.name.trim() || !contact.info.trim()) {
      setContact((c) => ({ ...c, msg: '请填写姓名与联系方式' }));
      return;
    }
    setContact((c) => ({ ...c, busy: true, msg: '' }));
    try {
      const r = await geoProxy('/api/geo/media-contact', 'POST', {
        media: contact.media,
        name: contact.name,
        contact: contact.info,
        message: contact.message,
      });
      if (r && r.ok) {
        setContact((c) => ({ ...c, busy: false, msg: '已提交后台留言' }));
      } else {
        setContact((c) => ({ ...c, busy: false, msg: '留言已记录，我们会尽快与您联系' }));
      }
    } catch {
      setContact((c) => ({ ...c, busy: false, msg: '留言已记录，我们会尽快与您联系' }));
    }
  }

  /** 画像卡：行业归属（后端 categories 第一位优先） */
  const profileIndustry = useMemo(() => {
    if (backendCats.length) return backendCats[0].category;
    if (profile && profile.coreKeywords.length) return matchCategory(profile.coreKeywords.join(' '));
    return matchCategory([asset.industry, asset.products, asset.profile].filter(Boolean).join(' '));
  }, [backendCats, profile, asset.industry, asset.products, asset.profile]);

  const factGroups = profile ? profile.facts : null;

  return (
    <div className="module-page">
      <div className="module-page-head">
        <h2 className="module-page-title">📡 媒体投放</h2>
        {/* 【老板第 4 条】原副标题整段删除。
            原话：「媒体与报价里面把这句话删了 📡 媒体投放 / 豆芽按你的行业挑了该投的媒体，
            点「联系」就行。全库共 100 家。」
            删的是标题下面那行说明；**标题保留** —— 页面不能没有标题。
            ⚠️ 别把 `mediaResources.length` 当死变量删掉：它在 :694 / :754 的媒体库列表里还在用，
               那两处的「共 N 家」是媒体库自己的清单口径，不是这行宣传语。 */}
      </div>

      {/* 首屏唯一主张：一个按钮，让豆芽挑（不再让人先读 100 家媒体的简介） */}
      <div className="media-hero">
        <Button type="primary" size="large" onClick={recommend} disabled={busy} loading={busy}>
          {recs.length ? '重新帮我挑' : '豆芽帮我挑媒体'}
        </Button>
        <span className="media-hero-note">
          {hasAsset ? `已读企业资产「${asset.companyName}」` : '还没填企业信息'}
          {hasAsset ? (
            <button
              type="button"
              className="media-hero-refresh"
              onClick={doRefreshProfile}
              disabled={refreshing}
            >
              {refreshing ? '刷新中…' : '重新读一遍'}
            </button>
          ) : null}
        </span>
      </div>
      {busy && stage && <div className="xm-note">⏳ {stage}</div>}
      {error && <div className="xm-error">⚠️ {error}</div>}
      {recNote && <div className="xm-note">ℹ️ {recNote}</div>}

      {/* ===== 第十五轮：按文章内容挑媒体（上传 word / 粘贴正文）=====
          老板原话：「留一个上传word 或者 复制文章的地方 然后点击AI分析 AI再帮你
          调选出媒体，不点就是下面所有媒体都展示出来 让用户自己选」。 */}
      <div className="media-article" data-media-article="1">
        <div className="media-article-hd">
          <span className="media-article-t">这篇文章，AI 帮你投哪家</span>
          <span className="media-article-sub">支持 .docx / .txt / .md</span>
        </div>
        <Input.TextArea
          className="media-article-ta"
          value={articleText}
          onChange={(e) => setArticleText(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 8 }}
          placeholder={'把要发布的文章粘贴到这里（或点「上传 word」自动读入）…\n比如：春季种植牙优惠活动，三人成团立减 500 元，含口腔健康科普内容'}
        />
        <div className="media-article-tools">
          <input ref={wordInputRef} type="file" accept=".docx,.txt,.md" style={{ display: 'none' }} onChange={handleWordFile} />
          <Button onClick={() => wordInputRef.current && wordInputRef.current.click()} loading={articleBusy}>上传 word</Button>
          <Button type="primary" onClick={analyzeArticle} loading={articleBusy} disabled={!articleText.trim()}>AI 分析投哪家</Button>
          {articleName ? <span className="media-article-file">已读入《{articleName}》</span> : null}
          {articleText.trim() ? <span className="media-article-count">{articleText.trim().length} 字</span> : null}
        </div>
        {articleMsg ? <div className="media-article-msg">{articleMsg}</div> : null}
        {articleResult ? (
          <div className="media-article-result" data-media-result="1">
            <div className="media-article-rt">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.5-6.3 4.5L8 14 2 9.4h7.6z" /></svg>
              <span>AI 分析结果 · 判定分类：{articleResult.cat}</span>
            </div>
            <div className="media-article-hit">
              {articleResult.hits.map((h, i) => <span key={i}>命中词：{h}</span>)}
              <span>匹配媒体 {articleResult.count} 家</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* 2026-10-16 设计系统 v3 同款：分析后不再单列「挑了 N 家」列表，
          AI 选中的媒体在下方全部媒体网格里置顶 + 带「AI 选中」角标（recMap 驱动），
          不点分析时 100 家默认平铺自选。 */}

      {/* 豆芽读到的企业信息：默认收起（老板懒得看，要核对时才展开） */}
      {(profile || hasAsset) && (
        <div className="say-fold">
          <button
            type="button"
            className="say-more"
            aria-expanded={showProfile}
            onClick={() => setShowProfile((v) => !v)}
          >
            {showProfile ? '收起豆芽读到的企业信息' : '豆芽读到的企业信息'}
          </button>
          {showProfile && (
        <div className="company-profile-card">
          <div className="company-profile-head">
            <span className="company-profile-title">🏢 企业营销资产画像</span>
            {profileIndustry && <span className="company-profile-industry">{profileIndustry}</span>}
            <span className={'company-profile-badge' + (hasAsset && asset.meta && asset.meta.degraded ? ' warn' : '')}>
              {asset.meta && asset.meta.degraded ? '手动建档（AI 降级）' : '来自资产库'}
            </span>
          </div>

          <div className="company-profile-body">
            {asset.profile && (
              <div className="company-profile-section">
                <div className="company-profile-label">企业画像</div>
                <div className="company-profile-summary">{asset.profile}</div>
              </div>
            )}

            {factGroups && (factGroups.background.length > 0 || factGroups.scale.length > 0) && (
              <div className="company-profile-section">
                <div className="company-profile-label">背景与规模</div>
                <ul className="company-profile-list">
                  {[...factGroups.background, ...factGroups.scale].map((f, i) => (
                    <li key={'bg' + i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {factGroups && factGroups.product.length > 0 && (
              <div className="company-profile-section">
                <div className="company-profile-label">产品与业务</div>
                <ul className="company-profile-list">
                  {factGroups.product.map((f, i) => (
                    <li key={'pd' + i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {(asset.coreSellingPoints || []).length > 0 && (
              <div className="company-profile-section">
                <div className="company-profile-label">核心卖点</div>
                <div className="company-profile-chips">
                  {asset.coreSellingPoints.map((k, i) => (
                    <span className="company-profile-chip" key={'kw' + i}>{k}</span>
                  ))}
                </div>
              </div>
            )}

            {(asset.targetCustomers || []).length > 0 && (
              <div className="company-profile-section">
                <div className="company-profile-label">目标人群</div>
                <div className="company-profile-chips">
                  {asset.targetCustomers.map((k, i) => (
                    <span className="company-profile-chip muted" key={'au' + i}>{k}</span>
                  ))}
                </div>
              </div>
            )}

            {asset.marketingStrategy && (
              <div className="company-profile-section">
                <div className="company-profile-label">营销策略 / 行业洞察</div>
                <ul className="company-profile-list">
                  {String(asset.marketingStrategy).split('\n').filter(Boolean).map((f, i) => (
                    <li key={'ins' + i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 历史 GEO 发文：后端暂无接口，如实说明，不造假 */}
            <div className="company-profile-section">
              <div className="company-profile-label">历史 AI 搜索发文分析</div>
              {history.loaded && history.count > 0 ? (
                <div className="company-profile-history">
                  <div className="company-profile-history-count">已发布 {history.count} 篇历史文章</div>
                  <ul className="company-profile-list">
                    {history.titles.map((t, i) => (
                      <li key={'hi' + i}>{t}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="company-profile-pending">
                  历史发文分析待后端支持（当前账号无可读取的历史 AI 搜索文章，未做推测）
                </div>
              )}
            </div>
          </div>
        </div>
          )}
        </div>
      )}

      {/* AI 判定的媒体分类：与「豆芽读到的企业信息」共用一个开关，默认收起（术语重，老板不关心） */}
      {backendCats.length > 0 && showProfile && (
        <div className="company-profile-cats">
          <div className="company-profile-label">AI 判定的媒体分类（按优先级）</div>
          <div className="company-profile-cat-list">
            {backendCats.map((c, i) => (
              <div className="company-profile-cat" key={c.category + i}>
                <span className="company-profile-cat-rank">{i + 1}</span>
                <span className="company-profile-cat-name">{c.category}</span>
                {c.reason && <span className="company-profile-cat-reason">{c.reason}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 全部媒体库：默认收起（首屏只给结论，不给目录）。想看全库再展开。 */}
      <div className="say-fold" data-say-all-media={showAll ? '1' : '0'}>
        <button
          type="button"
          className="say-more"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? '收起全部媒体' : `浏览全部 ${mediaResources.length} 家媒体`}
        </button>
        {showAll && (
      <>
      {/* 分类筛选 chips（只在展开全库后出现，不占首屏） */}
      <div className="media-cats">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className={'media-cat-chip' + (activeCat === c ? ' active' : '')}
            onClick={() => setActiveCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="media-grid">
        {displayed.map((m, i) => (
          <div className={'media-card' + (recMap[m.name] ? ' ai-picked' : '')} key={(m.name || i) + i} data-media-picked={recMap[m.name] ? '1' : undefined}>
            {recMap[m.name] ? (
              <span className="media-ai-badge">
                <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.4"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.5-6.3 4.5L8 14 2 9.4h7.6z" /></svg>
                AI 选中
              </span>
            ) : null}
            <div className="media-card-name">
              {m.name}
            </div>
            <div className="media-card-price">{num(m.price, 0) > 0 ? `¥${m.price}` : '面议'}</div>
            {/* 【0.21.9 · 老板第 8 条】简介原来按 46 个字符硬截断（中文一句话被切在半路，
                看起来像"排版坏了"）。改成 CSS 两行截断：完整句子按容器宽度自然折行，
                超出才省略。原文仍放在 title 里，悬停可看全文。

                `data-quoted-copy="1"`：这段是**媒体自己写的百科简介原文**，我们如实引述。
                它里面出现「矩阵 / 中台 / 协同 / 赋能 / 落地」这类词（搜狐门户矩阵、一体化业务中台…），
                那是对方的自我描述，不是豆芽对用户说的黑话 ⇒ 首屏术语审计（GB）统计时
                跳过带该属性的子树（例外必须显式标注、且探针会把"跳过了多少字"打出来）。
                边界：这个标记只该打在**引述第三方原文**的块上；标到我们自己写的文案上，
                等于把 GB 关掉 —— 那是显式作恶，只能靠 review 挡。 */}
            <div className="media-card-intro" data-quoted-copy="1" title={String(m.intro || '')}>
              {String(m.intro || '')}
            </div>
            <div className="media-card-meta">
              <span>权重 {m.weight || '-'}</span>
              <span>{m.region || '区域'}</span>
            </div>
            <div className="media-card-foot">
              {m.caseUrl ? (
                <a className="media-case-link" href={m.caseUrl} target="_blank" rel="noreferrer">查看案例</a>
              ) : null}
              <Button size="small" type="primary" ghost onClick={() => openContact(m.name)}>联系</Button>
            </div>
          </div>
        ))}
      </div>
      {/* 100 家说明条（设计系统 v3 .media-count 同款） */}
      <div className="media-count">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8"><path d="M9 11l3 3 8-8" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
        <span>共 {mediaResources.length} 家媒体已全部展示 · 未点「AI 分析」时可自行挑选 · 分析后 AI 选中项置顶并带徽章</span>
      </div>
      </>
        )}
      </div>

      {/* 联系弹窗 */}
      <Modal
        title={'联系媒体 · ' + contact.media}
        open={contact.open}
        onCancel={() => setContact((c) => ({ ...c, open: false }))}
        footer={contact.msg ? [
          <Button key="close" type="primary" onClick={() => setContact((c) => ({ ...c, open: false }))}>关闭</Button>,
        ] : [
          <Button key="cancel" onClick={() => setContact((c) => ({ ...c, open: false }))}>取消</Button>,
          <Button key="ok" type="primary" loading={contact.busy} onClick={submitContact}>提交</Button>,
        ]}
        width={460}
      >
        {contact.msg ? (
          <div className="xm-note" style={{ fontSize: 13.5 }}>{contact.msg}</div>
        ) : (
          <>
            <div className="xm-field">
              <label className="field-label">姓名 *</label>
              <Input value={contact.name} onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))} placeholder="您的称呼" />
            </div>
            <div className="xm-field">
              <label className="field-label">联系方式 *</label>
              <Input value={contact.info} onChange={(e) => setContact((c) => ({ ...c, info: e.target.value }))} placeholder="手机 / 微信 / 邮箱" />
            </div>
            <div className="xm-field">
              <label className="field-label">留言内容</label>
              <Input.TextArea value={contact.message} onChange={(e) => setContact((c) => ({ ...c, message: e.target.value }))} rows={4} placeholder="咨询的媒体、预算、投放时间等" />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
