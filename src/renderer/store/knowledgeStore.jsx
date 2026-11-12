import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/**
 * knowledgeStore —— 第七阶段「学习站 / 口腔行业情报」数据层。
 *
 * 三个集合：
 * - KnowledgeSource：精选信息源（S/A/B 三层），配置式，非爬虫。
 * - KnowledgeArticle：资讯条目（标题/URL/分类/AI 摘要/适用人群/重要度），按原文留源。
 * - MyLearning：我的学习（articleId → status：learning/done/later），按企业隔离。
 *
 * 第一版不做大型爬虫，文章来自精选源 + 搜索聚合，AI 负责分类与摘要；
 * 每篇严格保留 source/url/published_at，AI 摘要基于原文，不虚构。
 */

export const SOURCES_KEY = 'douya-knowledge-sources';
export const ARTICLES_KEY = 'douya-knowledge-articles';
export const MY_LEARNING_KEY = 'douya-my-learning';

/** 学习状态枚举。 */
export const LEARNING_STATUS = {
  learning: '学习中',
  done: '已学完',
  later: '稍后看',
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

/**
 * 把任意日期字段解析成毫秒时间戳；解析不出来返回 0（**绝不返回 NaN**）。
 *
 * 为什么单独抽这一支：`published_at` 落库时是**字符串**（`'2026-09-15'` 或
 * `'2026-11-07T10:00:00.000Z'` 两种形态混用），而 JS 里两个字符串相减得 `NaN`。
 * 改前 `listArticles` 直接 `(b.published_at||b.created_at||0) - (a...)` ⇒ 比较器恒 NaN
 * ⇒ `sort` 当成 0 ⇒ **顺序完全不变**，「新的在前」全靠插入顺序碰巧成立（2026-11-07 实测）。
 *
 * @param {unknown} v 日期字符串 / 毫秒数 / 空值
 * @returns {number} 毫秒时间戳，无法解析时为 0
 */
export function toTimeMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return parsed;
  // 纯数字字符串（历史数据里可能有 `created_at: "1762300000000"`）按毫秒处理
  const asNum = Number(s);
  return Number.isFinite(asNum) ? asNum : 0;
}

/**
 * 一篇文章用于排序的时间戳：优先 `published_at`，没有（或解析不出来）再用 `created_at`。
 * @param {object} a 文章
 * @returns {number} 毫秒时间戳
 */
export function articleTimeOf(a) {
  const base = a && typeof a === 'object' ? a : {};
  return toTimeMs(base.published_at) || toTimeMs(base.created_at);
}

/**
 * 文章列表排序：新的在前，时间相同时保持入参原顺序（稳定）。
 *
 * 判据（门禁 entry-interact 的「排序」一节直接断言这一支）：
 *   · `'2026-09-15'` 与 `'2026-11-07T10:00:00.000Z'` 混排时必须重排 —— 旧实现（字符串相减）
 *     在 sort 后保持入参原序，这条断言对它**有区分力**；
 *   · 返回**新数组**，不改入参。
 *
 * @param {Array<object>} list 文章数组
 * @returns {Array<object>} 按时间倒序的新数组
 */
export function sortArticlesByTimeDesc(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map((a, i) => ({ a, i, t: articleTimeOf(a) }))
    .sort((x, y) => (y.t - x.t) || (x.i - y.i))
    .map((x) => x.a);
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 归一化 KnowledgeSource。 */
export function normalizeSource(s) {
  const base = s && typeof s === 'object' ? s : {};
  return {
    id: asStr(base.id),
    name: asStr(base.name) || '未命名来源',
    url: asStr(base.url),
    country: asStr(base.country),
    language: asStr(base.language),
    category: asStr(base.category),
    source_level: ['official', 'professional', 'industry', 'marketing'].includes(base.source_level)
      ? base.source_level
      : (base.source_level || 'professional'),
    rss_url: asStr(base.rss_url || base.rssUrl),
    enabled: base.enabled !== false,
    last_crawled_at: base.last_crawled_at || base.lastCrawledAt || null,
  };
}

/** 归一化 KnowledgeArticle。 */
export function normalizeArticle(a) {
  const base = a && typeof a === 'object' ? a : {};
  return {
    id: asStr(base.id),
    source_id: asStr(base.source_id || base.sourceId),
    title: asStr(base.title) || '未命名资讯',
    url: asStr(base.url),
    published_at: asStr(base.published_at || base.publishedAt),
    category: asStr(base.category),
    sub_category: asStr(base.sub_category || base.subCategory),
    summary: asStr(base.summary),
    summary_long: asStr(base.summary_long || base.summaryLong),
    why_important: asStr(base.why_important || base.whyImportant),
    content: base.content == null ? null : base.content,
    // 【0.21.11 · 老板第 4 条】文章自带配图（RSS 条目里的 media:thumbnail / enclosure 等）。
    // 这里是**白名单式**归一化 —— 不加这一行，抓取时带进来的 image 会被静默丢掉，
    // 页面上就永远只有那 6 张按分类硬映射的图，正是老板说的「图片要获取那篇文章的图片」。
    image: asStr(base.image),
    author: asStr(base.author),
    country: asStr(base.country),
    target_roles: asArray(base.target_roles || base.targetRoles),
    target_company_types: asArray(base.target_company_types || base.targetCompanyTypes),
    importance: Number(base.importance) || 3,
    kind: base.kind === 'tutorial' ? 'tutorial' : 'news',
    interpretation: asStr(base.interpretation),
    // 【0.21.27 · 学习中心「首屏拿假数据冒充真实资讯」】内置示例标记。
    // 只有用户**主动点「看看示例」**才写入；卡片据此打「示例内容，非实时资讯」标并**不给**「读全文」，
    // 保证「页面上出现无 url 的文章卡」只可能是用户自己选的示例，而不是默认首屏。
    is_sample: base.is_sample === true,
    created_at: base.created_at || base.createdAt || Date.now(),
    updated_at: base.updated_at || base.updatedAt || Date.now(),
  };
}

const SourceContext = createContext(null);
const ArticleContext = createContext(null);
const MyLearningContext = createContext(null);

/**
 * 产品内置示例资讯（设计系统 v3 学习中心同款六条）。
 *
 * 【0.21.27 · 老板「学习中心内容十分糟糕，是不是根本爬不到内容」】
 * 这六条**曾经**在 localStorage 没有文章时被自动写进 articles，等于让一个假资讯列表
 * 顶在首屏冒充「今天抓到的内容」：
 *   · 每条 `url: ''` ⇒ 卡片没有「打开原文」，点「读全文」只会看到「这篇没抓到正文」；
 *   · 因为 `allArticles.length` 永远 ≥ 6，`LearningStation.jsx` 的**诚实空态永远不可能出现**；
 *   · 它们还被 `useEffect` 落进 localStorage ⇒ 用户删都删不掉（当时也没有删除入口）。
 * 现在**不再自动灌入**：只有用户在全空且抓取失败的空态里**主动点「看看示例」**才写入，
 * 写入时逐条带 `is_sample: true`，卡片据此打「示例内容，非实时资讯」并隐藏「读全文」。
 *
 * ⚠️ 常量本身保留（不删）：它仍是「界面长什么样」的离线素材，只是**不许当真实资讯**。
 */
const SEED_ARTICLES = [
  {
    id: 'seed-policy-1', source_id: '', author: '豆芽内置示例',
    title: '口腔诊所采购新规解读：设备准入有哪些变化',
    url: '', published_at: '2026-10-15', category: 'policy', sub_category: '医疗政策',
    summary: '设备准入新规逐条解读：哪些品类需要补认证、采购合同怎么签更稳妥。',
    why_important: '设备准入直接影响采购合规，新规后这些品类要注意。',
    importance: 5,
  },
  {
    id: 'seed-tech-1', source_id: '', author: '豆芽内置示例',
    title: '综合治疗机水路消毒实操：门诊 5 步法',
    url: '', published_at: '2026-10-14', category: 'tech', sub_category: '院感',
    summary: '从日常消毒到定期监测，门诊水路消毒的 5 个执行步骤与记录模板。',
    why_important: '水路消毒是检查高频项，步骤与记录缺一不可。',
    importance: 5,
  },
  {
    id: 'seed-product-1', source_id: '', author: '豆芽内置示例',
    title: '上游货源平台商家入驻指引（2026 版）',
    url: '', published_at: '2026-10-13', category: 'product', sub_category: '厂商动态',
    summary: '上游货源平台商家入驻全流程：资质要求、材料清单与审核周期。',
    why_important: '平台入驻是线上经营第一步，材料备齐可少跑两趟。',
    importance: 5,
  },
  {
    id: 'seed-industry-1', source_id: '', author: '豆芽内置示例',
    title: '儿牙早矫市场观察',
    url: '', published_at: '2026-10-12', category: 'industry', sub_category: '市场趋势',
    summary: '儿童早期矫治需求持续上升，舒雅星系系列终端反馈汇总。',
    importance: 3,
  },
  {
    id: 'seed-industry-2', source_id: '', author: '豆芽内置示例',
    title: '门诊排班管理实务',
    url: '', published_at: '2026-10-11', category: 'industry', sub_category: '行业研究',
    summary: '从预约到椅位调度，一份可直接抄的排班表。',
    importance: 3,
  },
  {
    id: 'seed-ai-1', source_id: '', author: '豆芽内置示例',
    title: 'AI 搜索时代的内容传播',
    url: '', published_at: '2026-10-10', category: 'ai', sub_category: 'AI搜索',
    summary: 'AI 搜索时代，牙科内容如何被 DeepSeek / 豆包推荐。',
    importance: 3,
  },
];

export function KnowledgeProvider({ children }) {
  const [sources, setSources] = useState(() =>
    (Array.isArray(loadJSON(SOURCES_KEY, [])) ? loadJSON(SOURCES_KEY, []) : []).map(normalizeSource),
  );
  const [articles, setArticles] = useState(() => {
    const loaded = Array.isArray(loadJSON(ARTICLES_KEY, [])) ? loadJSON(ARTICLES_KEY, []) : [];
    // 【0.21.27】**不再**用 SEED_ARTICLES 顶首屏：本地没有文章就是空数组，
    // 由 LearningStation 触发一次真实抓取，抓不到就显示诚实空态（见该文件的 autoFetch effect）。
    //
    // 顺手清掉**老版本已经灌进去的**内置示例（`seed-*` + 无原文链接 + 没有 is_sample 标）。
    // 为什么必须清：改前只要用户打开过一次学习中心，那 6 条就被 useEffect 落进了 localStorage
    // ⇒ 只改初始化逻辑的话，**存量用户的首屏仍然是 6 张点进去看不到正文的假卡片**。
    // 用户主动点「看看示例」写入的那批带 `is_sample: true`，不在清理范围内（下次打开还在）。
    return loaded
      .filter((a) => {
        const id = String((a && a.id) || '');
        const isLegacySeed = id.startsWith('seed-') && !(a && a.is_sample) && !(a && a.url);
        return !isLegacySeed;
      })
      .map(normalizeArticle);
  });
  const [myLearning, setMyLearning] = useState(() => {
    const m = loadJSON(MY_LEARNING_KEY, {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  });

  useEffect(() => {
    try { localStorage.setItem(SOURCES_KEY, JSON.stringify(sources)); } catch { /* 忽略 */ }
  }, [sources]);
  useEffect(() => {
    try { localStorage.setItem(ARTICLES_KEY, JSON.stringify(articles)); } catch { /* 忽略 */ }
  }, [articles]);
  useEffect(() => {
    try { localStorage.setItem(MY_LEARNING_KEY, JSON.stringify(myLearning)); } catch { /* 忽略 */ }
  }, [myLearning]);

  // ---------- Source ----------
  const addSource = useCallback((input) => {
    const s = normalizeSource({ ...(input || {}), id: input && input.id ? input.id : uid() });
    setSources((prev) => [...prev, s]);
    return s;
  }, []);
  const updateSource = useCallback((id, patch) => {
    setSources((prev) => prev.map((s) => (s.id === id ? normalizeSource({ ...s, ...(patch || {}) }) : s)));
  }, []);
  const removeSource = useCallback((id) => {
    setSources((prev) => prev.filter((s) => s.id !== id));
  }, []);
  const listSources = useCallback(() => sources.slice(), [sources]);

  // ---------- Article ----------
  const addArticle = useCallback((input) => {
    const a = normalizeArticle({ ...(input || {}), id: input && input.id ? input.id : uid(), created_at: Date.now(), updated_at: Date.now() });
    setArticles((prev) => [...prev, a]);
    return a;
  }, []);
  const updateArticle = useCallback((id, patch) => {
    setArticles((prev) => prev.map((a) => (a.id === id ? normalizeArticle({ ...a, ...(patch || {}), updated_at: Date.now() }) : a)));
  }, []);
  const removeArticle = useCallback((id) => {
    setArticles((prev) => prev.filter((a) => a.id !== id));
  }, []);
  /**
   * 写入 6 条内置示例（**只能在用户主动点「看看示例」时调用**）。
   * 幂等：已经存在的示例不会重复追加；返回这次真正新增的条数。
   * @returns {number} 新增条数
   */
  const addSampleArticles = useCallback(() => {
    const have = new Set(articles.map((a) => a.id));
    const pending = SEED_ARTICLES.filter((s) => !have.has(s.id));
    if (pending.length === 0) return 0;
    const next = pending.map((s) => normalizeArticle({ ...s, is_sample: true }));
    setArticles((prev) => {
      // 再判一次：两次快速点击时，第二次的 `articles` 可能还是旧快照
      const haveNow = new Set(prev.map((a) => a.id));
      const add = next.filter((s) => !haveNow.has(s.id));
      return add.length > 0 ? [...prev, ...add] : prev;
    });
    return next.length;
  }, [articles]);
  const listArticles = useCallback(() => sortArticlesByTimeDesc(articles), [articles]);

  // ---------- MyLearning ----------
  const setLearningStatus = useCallback((articleId, companyId, status) => {
    setMyLearning((prev) => {
      const next = { ...prev };
      const key = `${companyId || '*'}:${articleId}`;
      if (status) next[key] = status;
      else delete next[key];
      return next;
    });
  }, []);
  const getLearningStatus = useCallback((articleId, companyId) => {
    return myLearning[`${companyId || '*'}:${articleId}`] || null;
  }, [myLearning]);
  const listMyLearning = useCallback((companyId) => {
    const prefix = `${companyId || '*'}:`;
    return Object.entries(myLearning)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, status]) => ({ articleId: k.slice(prefix.length), status }))
      .filter((x) => x.articleId);
  }, [myLearning]);

  const sourceValue = useMemo(() => ({ sources, addSource, updateSource, removeSource, listSources }), [sources, addSource, updateSource, removeSource, listSources]);
  const articleValue = useMemo(() => ({ articles, addArticle, updateArticle, removeArticle, addSampleArticles, listArticles }), [articles, addArticle, updateArticle, removeArticle, addSampleArticles, listArticles]);
  const learningValue = useMemo(() => ({ myLearning, setLearningStatus, getLearningStatus, listMyLearning }), [myLearning, setLearningStatus, getLearningStatus, listMyLearning]);

  return (
    <SourceContext.Provider value={sourceValue}>
      <ArticleContext.Provider value={articleValue}>
        <MyLearningContext.Provider value={learningValue}>{children}</MyLearningContext.Provider>
      </ArticleContext.Provider>
    </SourceContext.Provider>
  );
}

export function useKnowledgeSources() {
  const ctx = useContext(SourceContext);
  if (!ctx) throw new Error('useKnowledgeSources 必须在 <KnowledgeProvider> 子树内使用');
  return ctx;
}
export function useKnowledgeArticles() {
  const ctx = useContext(ArticleContext);
  if (!ctx) throw new Error('useKnowledgeArticles 必须在 <KnowledgeProvider> 子树内使用');
  return ctx;
}
export function useMyLearning() {
  const ctx = useContext(MyLearningContext);
  if (!ctx) throw new Error('useMyLearning 必须在 <KnowledgeProvider> 子树内使用');
  return ctx;
}

export default KnowledgeProvider;
