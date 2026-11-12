/**
 * rssService —— 学习站「稳定资讯源」抓取服务。
 *
 * 目标：把「用户手动添加资讯」换成「系统自动抓取」。
 * 三条能力：
 * - parseFeed(xmlText)   纯正则解析 RSS2.0 <item> / Atom <entry>，零依赖
 * - pickSources(companyType, role)  按企业类型 + 角色挑选优先级最高的可用源（通用入口，行为未改）
 * - pickLearningSources(companyType, role)  学习中心专用：按「文献层优先」挑源，源数收敛到 5（0.21.16）
 * - judgeDentalRelevance(items)     抓回来的条目过一道「口腔相关」判断，AI 不可用则规则降级（0.21.16）
 * - crawlSources(sources, opts)     自带并发池抓取，返回 { items, failed }
 * - fetchJournalIssue(sourceCfg)    中华医学期刊网**当期目录**抓取器（不是 RSS，形态不同，单列）
 * - crawlJournalSources(sources)    两个口腔期刊串行抓取，产出与 crawlSources 同形的条目
 * - sortJournalFirst(items)         把期刊文献稳定地排到 RSS 条目之前（老板要的优先级）
 *
 * 设计约束：
 * - 抓取动作全部走主进程 /api/rss-fetch（api.js 的 fetchRss），渲染进程不直连外部站点。
 * - 不使用任何第三方 XML/并发库，避免打包体积与依赖风险。
 * - 任一源失败只记录 failed，不影响其它源，绝不让整次抓取失败。
 */

import { fetchRss, fetchJournalHtml } from '../api.js';
import { SEED_SOURCES, normalizeTitle, resolveLearningRole } from '../data/knowledgeCatalog.js';

/** 命名实体 → 字符（不含数字实体，数字实体单独处理）。 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

/** 去掉 CDATA 包裹，保留内部原文。 */
function stripCdata(s) {
  return String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** 反转义 XML/HTML 实体（数字实体 + 常见命名实体）。 */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const n = parseInt(dec, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ldquo|rdquo|hellip|mdash|ndash);/g, (_m, name) =>
      NAMED_ENTITIES[name] || '',
    );
}

/** 把 HTML 片段拍平成纯文本（去 script/style/标签）。 */
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/** 文本字段清洗：CDATA → 去 HTML → 反转义 → 折叠空白。 */
function cleanText(s) {
  return decodeEntities(stripHtml(stripCdata(s))).replace(/\s+/g, ' ').trim();
}

/** 链接字段清洗：CDATA → 反转义 → 去空白（不能折叠成空格）。 */
function cleanLink(s) {
  return decodeEntities(stripCdata(s)).replace(/\s+/g, '').trim();
}

/** 按候选标签顺序取第一个非空文本值（支持 content:encoded 这类带命名空间前缀的标签）。 */
function pickOne(block, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  for (let i = 0; i < list.length; i += 1) {
    const tag = String(list[i] || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const m = String(block || '').match(re);
    if (m && m[1]) {
      const v = cleanText(m[1]);
      if (v) return v;
    }
  }
  return '';
}

/** 取条目链接：RSS 用 <link>url</link>，Atom 用 <link rel="alternate" href="..."/>。 */
function pickLink(block) {
  const text = String(block || '');
  const inline = text.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (inline && inline[1]) {
    const v = cleanLink(inline[1]);
    if (v) return v;
  }
  const links = text.match(/<link\b[^>]*>/gi) || [];
  let fallback = '';
  for (let i = 0; i < links.length; i += 1) {
    const relMatch = links[i].match(/rel\s*=\s*["']([^"']*)["']/i);
    const hrefMatch = links[i].match(/href\s*=\s*["']([^"']*)["']/i);
    const rel = relMatch ? String(relMatch[1]).toLowerCase() : '';
    const href = hrefMatch ? decodeEntities(hrefMatch[1]).trim() : '';
    if (!href) continue;
    if (rel === 'alternate' || rel === '') return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

/**
 * 取条目自带的配图地址（0.21.11 · 老板第 4 条「图片要获取那篇文章的图片」）。
 *
 * 为什么要按这个顺序找：RSS 里图片出现在很多地方，越靠前越可信 ——
 *   ① `<media:thumbnail url>`（WordPress/Joomla 系最常见，专供缩略图）；
 *   ② `<media:content url medium="image">` / `type="image/*"`；
 *   ③ `<enclosure type="image/*" url>` —— **必须校验 type**：播客源的 enclosure 是音频，
 *      拿来当封面就是一个个破图（这是本仓最容易犯的那类"看着有值其实是错的"）；
 *   ④ `<itunes:image href>`；
 *   ⑤ 正文里第一张 `<img src>`（description / content:encoded 都可能带）。
 * 只接受 http(s) 绝对地址；相对路径一律丢弃（页面上放不出来，不如让上层回退到默认封面）。
 *
 * @param {string} block 单个 <item>/<entry> 的原始 XML 片段（未清洗，含标签）
 * @returns {string} 图片地址；找不到返回空串（**绝不返回占位串**）
 */
function pickImage(block) {
  const text = String(block || '');
  const attrOf = (tagText, name) => {
    const m = String(tagText || '').match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const tags = (re) => text.match(re) || [];

  const thumb = tags(/<media:thumbnail\b[^>]*>/gi);
  for (const t of thumb) {
    const u = attrOf(t, 'url');
    if (u) return u;
  }
  const mediaContent = tags(/<media:content\b[^>]*>/gi);
  for (const t of mediaContent) {
    const u = attrOf(t, 'url');
    const type = attrOf(t, 'type');
    const medium = attrOf(t, 'medium');
    if (u && (/^image\//i.test(type) || medium.toLowerCase() === 'image')) return u;
  }
  const enclosures = tags(/<enclosure\b[^>]*>/gi);
  for (const t of enclosures) {
    const u = attrOf(t, 'url');
    const type = attrOf(t, 'type');
    if (u && /^image\//i.test(type)) return u;
  }
  const itunes = tags(/<itunes:image\b[^>]*>/gi);
  for (const t of itunes) {
    const u = attrOf(t, 'href') || attrOf(t, 'url');
    if (u) return u;
  }
  const img = text.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  if (img && img[1]) {
    const u = decodeEntities(img[1]).trim();
    if (u) return u;
  }
  return '';
}

/** 只放行 http(s) 绝对地址（相对路径在渲染层是破图，不如空着回退默认封面）。 */
function httpUrlOrEmpty(u) {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

/**
 * 解析 RSS2.0 / Atom 源文本。
 * @param {string} xmlText 原始 XML 文本
 * @returns {Array<{title:string, link:string, pubDate:string, description:string, image:string}>}
 */
export function parseFeed(xmlText) {
  const text = String(xmlText == null ? '' : xmlText);
  if (!text) return [];

  const blocks = [];
  let m = null;
  const reItem = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  while ((m = reItem.exec(text)) !== null) blocks.push(m[1]);
  if (blocks.length === 0) {
    const reEntry = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
    while ((m = reEntry.exec(text)) !== null) blocks.push(m[1]);
  }

  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const title = pickOne(b, ['title']);
    const link = pickLink(b);
    if (!title && !link) continue;
    const pubDate = pickOne(b, ['pubDate', 'published', 'updated', 'dc:date', 'date']);
    const description = pickOne(b, ['description', 'summary', 'content:encoded', 'content']);
    out.push({
      title: title || '(无标题)',
      link,
      pubDate,
      description: description.slice(0, 600),
      // 0.21.11 第 4 条：条目自带配图（没有就空串，由上层回退默认封面）
      image: httpUrlOrEmpty(pickImage(b)),
    });
  }
  return out;
}

/** 各学习角色对六大分类的优先级（越靠前越优先）。 */
const ROLE_CATEGORY_PRIORITY = {
  operator: ['ai', 'industry', 'tech', 'policy', 'product', 'event'],
  manufacturer: ['product', 'tech', 'industry', 'policy', 'event', 'ai'],
  doctor: ['tech', 'policy', 'product', 'industry', 'event', 'ai'],
  owner: ['industry', 'ai', 'tech', 'policy', 'product', 'event'],
};

/** 来源层级权重（S 官方最优先）。 */
const LEVEL_RANK = { official: 0, professional: 1, industry: 1, marketing: 2 };

// ══════════════════════════════════════════════════════════════════
// 【0.21.16 · 老板需求 6】学习中心资讯源分层挑源
//
// 老板原话：「学习中心现在会给我推荐很多乱七八糟的牙医内容 AI先帮我判断一下我的建议是
//            从 中华医学期刊里面 找口腔文献 阅读。」
//
// 改前（pickSources(companyType, role, 10) + perSource 6）：
//   一次最多 10 个源 × 每源 6 条 = 60 条，而其中 qbitai / woshipm / yunyingpai /
//   geekpark / sina_tech / tmtpost / chinanews / openai_news 这 8 个是**通用 AI / 营销 / 科技号**，
//   跟口腔一点关系都没有 —— 这就是老板说的「乱七八糟的牙医内容」的真实成分。
//
// 改后：按「层」挑源，文献层无条件排最前；门诊视角**直接剔除**通用 AI / 营销层；
//   总源数从 10 压到 5（每源 4 条 ⇒ 上限 20 条，改前 60 条），并把选择结果做成纯函数，
//   可以在 node 里直接断言（scripts/smoke/entry-interact.jsx 的 caseLearnFocus）。
// ══════════════════════════════════════════════════════════════════

/**
 * 每个学习角色的「层优先级」（越靠前越优先）。
 *
 * manufacturer 是 B 端口径（厂家/经销商/平台），器械耗材与 AI 前沿对它是**真需求**，
 * 所以它保留 ai_marketing 层；门诊/医生/老板视角只关心口腔临床与门诊经营，故剔除。
 */
const LEARN_TIER_ORDER = {
  // 门诊/医生/老板视角：文献 → 口腔专业媒体 → 中文健康媒体 → 海外口腔机构 → 中文泛行业兜底
  //
  // 【0.21.27 · 老板「是不是根本爬不到内容」】这一版把 `health_zh` 插在 dental_academic 之前：
  //   改前实测这一组挑出来是 `csa`(死源) + dentalnews/dentistryuk/medicalxpress + fdi ——
  //   4 条英文 + 1 条抓不到，中文一条都没有，这就是「内容十分糟糕」的可证成分。
  //   现在 csa 的订阅地址已置空（见 knowledgeCatalog 注释），空出来的位置给中文健康源，
  //   5 个源变成「4 条口腔专业（英文）+ 1 条中文健康」；中文**口腔**内容由
  //   Journal 那一级（中华口腔医学杂志 / 中华口腔正畸学杂志当期目录）保证，实测每期 19~22 篇。
  clinic: ['literature', 'dental_professional', 'health_zh', 'dental_academic', 'industry_zh'],
  manufacturer: ['literature', 'product', 'dental_professional', 'health_zh', 'dental_academic', 'industry_zh', 'ai_marketing'],
};

/**
 * 源 id → 层。**只登记本仓 SEED_SOURCES 里真实存在的 id**，不臆造源。
 *
 * 分层依据（逐条可核对 src/renderer/data/knowledgeCatalog.js 的 SEED_SOURCES）：
 *   literature          口腔文献 / 学术权威（中华口腔医学会，发布学术与继续教育内容）
 *   dental_academic     海外口腔/医学官方机构（FDI / WHO / CDC）
 *   dental_professional 口腔专业媒体与医学研究速报
 *   product             器械耗材与产品技术（厂家视角的真需求）
 *   health_zh           **中文健康/医学媒体**（口腔相邻，不是口腔专业媒体；0.21.27 补）
 *   industry_zh         中文行业媒体（泛行业，口腔相关性弱，只做兜底）
 *   ai_marketing        AI / 营销 / 科技号（与口腔无关，门诊视角剔除）
 */
const SOURCE_TIER = {
  csa: 'literature',
  fdi: 'dental_academic',
  who_news: 'dental_academic',
  cdc: 'dental_academic',
  dentalnews: 'dental_professional',
  dentistryuk: 'dental_professional',
  medicalxpress: 'dental_professional',
  dentalproducts: 'product',
  medicaldesign: 'product',
  tmtpost: 'industry_zh',
  chinanews: 'industry_zh',
  // 【0.21.27 · 补中文源】实测可用的中文健康 RSS（25 条/次）。单独一层而不是塞进
  // dental_professional：它是大众健康媒体，装成"口腔专业媒体"就是给用户一个错误预期。
  chinanews_health: 'health_zh',
  qbitai: 'ai_marketing',
  woshipm: 'ai_marketing',
  yunyingpai: 'ai_marketing',
  geekpark: 'ai_marketing',
  sina_tech: 'ai_marketing',
  openai_news: 'ai_marketing',
  // 0.21.16 · 老板第 1 条：中华医学期刊网的**两个口腔期刊**。
  // 它们不在 SEED_SOURCES 里（不是 RSS 源，走 fetchJournalIssue 解析当期目录），
  // 但同样是「口腔文献层」——登记进来有两个实际作用：
  //   ① isDentalRelevantByRule 的白名单放行（权威文献不需要靠关键词自证与口腔有关）；
  //   ② sourceTierOf('zhkqyx') → 'literature'，UI 能打「口腔文献」标。
  // ⚠️ 它们不会出现在 pickLearningSources 的结果里（那边只遍历 SEED_SOURCES），
  //    所以不存在「同一份内容被 RSS 抓一遍、又被目录抓一遍」的重复。
  zhkqyx: 'literature',
  zhkqzjx: 'literature',
};

/** 一次学习中心抓取最多挑几个源（老板「源数量下降，不要刷屏」）。 */
export const LEARN_SOURCE_LIMIT = 5;

/** 每源取几条（与 LEARN_SOURCE_LIMIT 一起决定资讯量上限 5×4=20，改前 10×6=60）。 */
export const LEARN_PER_SOURCE = 4;

/**
 * 「口腔文献层」的源 id 白名单。
 *
 * 用途有二：
 *   ① 挑源时无条件排最前（tier = literature）；
 *   ② AI 相关性判断不可用、退回规则过滤时，这些源的条目**一律放行**
 *      （权威源不需要靠关键词证明自己跟口腔有关）。
 */
export const LITERATURE_SOURCE_IDS = Object.freeze(
  Object.keys(SOURCE_TIER).filter((id) => SOURCE_TIER[id] === 'literature'),
);

/**
 * 口腔文献检索入口（**不是 RSS 源，不参与 crawlSources**）。
 *
 * 口径如实描述（2026-10-20 逐条 curl 实测，别再用「不存在 / 不可用」这类容易被误读的说法）：
 *   · `www.medjournals.cn` 是**中华医学会系列期刊的官方门户**（`<title>中华医学期刊网</title>`），
 *     口腔科学专科页 `serialjournal/getAllJournals.do?type=3&specialtyId=30` 能直接列出口腔期刊；
 *   · 单刊承载在 `*.yiigle.com` 子站，**当期目录页结构稳定、可解析**（见 fetchJournalIssue）；
 *   · 这两站都**没有公开 RSS**，所以这里不伪造 rssUrl —— 但它们不是「不可用」：
 *     文献正文已经通过 fetchJournalIssue 直接解析入库，这两个入口只负责「用户想自己去查」。
 */
export const LITERATURE_PORTALS = Object.freeze([
  {
    id: 'medjournals',
    name: '中华医学期刊网',
    url: 'https://www.medjournals.cn',
    note: '中华医学会系列期刊的官方门户；口腔科学专科页可直接列出《中华口腔医学杂志》等口腔期刊。该站没有 RSS 订阅，但当期目录页结构稳定，已通过 fetchJournalIssue 直接解析入库，不需要用户手动点。',
  },
  {
    id: 'yiigle',
    name: '中华医学期刊全文库',
    url: 'https://www.yiigle.com',
    note: '期刊全文检索入口：按关键词 / 作者检索口腔文献全文。该站无 RSS 订阅，全文检索仍需点过去自己查（当期目录已自动抓取，不占这个入口）。',
  },
]);

// ══════════════════════════════════════════════════════════════════
// 【0.21.16 · 老板第 1 条】中华医学期刊网「当期目录」抓取器
//
// 老板原话：「medjournals.cn 诶 你说这个网站不存在嘛？？这个不就是中华医学期刊网吗？」
// —— 上一轮只说过「没有公开 RSS」，被理解成「这个站不可用」了。事实是：
//   · 目录页**可抓且结构化**，每期几十篇真口腔文献（不是牙医软文）；
//   · 只是它没有 RSS，属于「另一种形态」，所以不能硬塞进 parseFeed，单列这一套。
//
// 为什么必须单列（而不是往 crawlSources 里塞一个假 rssUrl）：
//   ① 返回单元是「一篇文章 + 期刊 + 卷期 + 页码 + DOI」，比 RSS item 富；
//   ② 入口 URL 的**扩展名和期号都不统一**（月刊 `.htm`、季刊 `.jhtml`），不能拼规律；
//   ③ 抓取必须带 cookie jar（见 src/main/backend.js 的 /api/journal-issue 说明），
//      与 /api/rss-fetch 的无状态逐跳抓取不是同一条通路。
// ══════════════════════════════════════════════════════════════════

/**
 * 口腔期刊源配置。
 *
 * `entry` 是**当期目录页**的完整地址（写死配置，不按 CN 号推算式推导 —— 两刊格式不同）：
 *   · 中华口腔医学杂志：`.../CN112144202609/index.htm?tplReset=qikan`（月刊，2026 年 61 卷 09 期）
 *   · 中华口腔正畸学杂志：`.../CN115797202603/index.jhtml?tplReset=qikan`（季刊，2026 年 33 卷 03 期）
 *
 * ⚠️ **期号会变**：跨期之后上面这两个 entry 就指向旧的一期了。两条更新途径：
 *   ① 不用管 —— `fetchJournalIssue` 会**先抓 `home` 首页**，从首页里自动发现当期入口
 *      （首页有 `<a href="/CN…/index.htm?tplReset=qikan">`，实测两刊都能抠到），
 *      发现成功就完全不用改代码；
 *   ② 万一站点改版导致首页抠不到，`entry` 作为回落值仍能用，此时**手工改这里的 entry**
 *      （哪怕只是把期号 202609 改成 202610）即可，不用动其它任何代码。
 * 返回值里的 `entryMode` 会如实告诉调用方这次走的是 'discovered' 还是 'config'。
 */
export const JOURNAL_SOURCES = Object.freeze([
  Object.freeze({
    id: 'zhkqyx',
    name: '中华口腔医学杂志',
    host: 'https://zhkqyxzz.yiigle.com',
    home: 'https://zhkqyxzz.yiigle.com/',
    entry: 'https://zhkqyxzz.yiigle.com/CN112144202609/index.htm?tplReset=qikan',
  }),
  Object.freeze({
    id: 'zhkqzjx',
    name: '中华口腔正畸学杂志',
    host: 'https://zhkqzjxzz.yiigle.com',
    home: 'https://zhkqzjxzz.yiigle.com/',
    entry: 'https://zhkqzjxzz.yiigle.com/CN115797202603/index.jhtml?tplReset=qikan',
  }),
]);

/** 期刊源 id 列表（判断「这条是不是期刊文献」用）。 */
export const JOURNAL_SOURCE_IDS = Object.freeze(JOURNAL_SOURCES.map((s) => s.id));

/** 当期目录页里「一篇文章标题」的锚点类名 —— 结构自证就靠它。 */
const ISSUE_TITLE_MARKER = 'class="Current_Title"';

/**
 * 从期刊首页 HTML 里抠出「当期目录」入口。
 *
 * 实测（2026-10-20）两刊首页都带这一行：
 *   `<a href="/CN112144202609/index.htm?tplReset=qikan" target="_self">`
 *   `<a id="nav_curr" href="/CN115797202603/index.jhtml?tplReset=qikan" target="_self">最新发表</a>`
 * 注意扩展名 .htm / .jhtml 两种都要认 —— 这正是「不能拼规律」的原因。
 *
 * @param {string} homeHtml 期刊首页 HTML
 * @param {{host?:string}} [sourceCfg] 源配置（拼绝对地址用）
 * @returns {{url:string, ok:boolean}} 抠不到时 ok:false、url 为空串（**不猜地址**）
 */
export function discoverIssueEntry(homeHtml, sourceCfg) {
  const text = String(homeHtml == null ? '' : homeHtml);
  const cfg = sourceCfg && typeof sourceCfg === 'object' ? sourceCfg : {};
  if (!text) return { url: '', ok: false };
  const m = text.match(/href\s*=\s*["'](\/CN[0-9]{6,}\/index\.(?:htm|jhtml)\?tplReset=qikan)["']/i);
  if (!m || !m[1]) return { url: '', ok: false };
  const path = m[1];
  if (/^https?:\/\//i.test(path)) return { url: path, ok: true };
  const host = String(cfg.host || '').replace(/\/+$/, '');
  if (!host) return { url: '', ok: false };
  return { url: host + path, ok: true };
}

/** 把目录页按「文章标题锚点」切成一块块（每块 = 一篇文章的完整 DOM 片段）。 */
function splitArticleBlocks(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  const positions = [];
  let i = src.indexOf(ISSUE_TITLE_MARKER);
  while (i !== -1) {
    positions.push(i);
    i = src.indexOf(ISSUE_TITLE_MARKER, i + ISSUE_TITLE_MARKER.length);
  }
  for (let k = 0; k < positions.length; k += 1) {
    const start = positions[k];
    const end = k + 1 < positions.length ? positions[k + 1] : src.length;
    out.push(src.slice(start, end));
  }
  return out;
}

/** 取某个 class 的 `<p>` 内文本（先截到对应的 `</p>`，避免把后面的兄弟节点吃进来）。 */
function pickPText(block, className) {
  const re = new RegExp(`class="${className}"[^>]*>([\\s\\S]*?)<\\/p>`, 'i');
  const m = String(block || '').match(re);
  return m && m[1] ? cleanText(m[1]) : '';
}

/** 取某个 class 的 `<p>` 的**原始**内 HTML（要自己再拆 <span> 时用）。 */
function pickPRaw(block, className) {
  const re = new RegExp(`class="${className}"[^>]*>([\\s\\S]*?)<\\/p>`, 'i');
  const m = String(block || '').match(re);
  return m && m[1] ? m[1] : '';
}

/**
 * 解析「当期目录」页 HTML → 文章数组（纯函数，无网络，可离线夹具断言）。
 *
 * 站点真实结构（两刊一致，2026-10-20 实测原文）：
 * ```html
 * <p class="Current_Title"><a href="https://rs.yiigle.com/cmaid/1695296"
 *    title="前牙美学区种植软组织增量的临床决策：结缔组织移植与软组织替代材料的选择"
 *    target="_blank">前牙美学区种植软组织增量的临床决策：…</a></p>
 * <p class="curr_eng" style="display:none;">Clinical decision-making for soft-tissue augmentation…</p>
 * <p class="current_author">赵伟 陈江</p>
 * <p class="current_tip">中华口腔医学杂志<span>2026,61(9):1251-1257   DOI: 10.3760/cma.j.cn112144-20260509-00296</span></p>
 * ```
 *
 * **失败的诚实性（红线）**：抓不到 / 结构变了 / 被重定向到登录页 → 一律 `ok:false` + 具体原因，
 * **绝不返回 `ok:true` + 空数组** 冒充「今天没有新文献」。
 *
 * @param {string} htmlText 目录页 HTML
 * @param {{id?:string, name?:string}} [sourceCfg] 源配置
 * @returns {{ok:boolean, items:Array<object>, error:string, sourceId:string, name:string,
 *            issueLabel:string, publishedAt:string}}
 */
export function parseJournalIssue(htmlText, sourceCfg) {
  // 先剥掉 HTML 注释：注释里出现的 `<title>` / `class="Current_Title"` 会把下面每一处
  // 正则都骗过去（离线夹具的说明注释就是这么把 issueLabel 取成一句中文注释的 —— 实测踩过）。
  const text = String(htmlText == null ? '' : htmlText).replace(/<!--[\s\S]*?-->/g, '');
  const cfg = sourceCfg && typeof sourceCfg === 'object' ? sourceCfg : {};
  const sourceId = String(cfg.id || '');
  const name = String(cfg.name || '');
  const fail = (error) => ({
    ok: false,
    items: [],
    error,
    sourceId,
    name,
    issueLabel: '',
    publishedAt: '',
  });

  if (!text.trim()) return fail('期刊目录页为空（主进程没有拿到任何内容）');

  // ① 结构自证：必须真的存在文章标题锚点，否则视为「站点改版 / 被重定向到登录页或首页」
  const blocks = splitArticleBlocks(text);
  if (blocks.length === 0) {
    return fail(
      '页面结构变化：未找到 class="Current_Title"（站点可能改版，或该地址被重定向到登录页 / 首页）',
    );
  }

  // ② 期号与出版日期：取页面上**原文写着**的两个值，不推断
  const titleTag = (text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const issueLabel = cleanText(titleTag).split('-')[0] || '';
  const pubMatch = text.match(/出版日期\s*[：:]\s*(\d{4}-\d{2}-\d{2})/);
  const publishedAt = pubMatch ? pubMatch[1] : '';

  // ③ 逐篇解析
  const items = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const anchor = block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const anchorTag = block.match(/<a\b[^>]*>/i);
    const hrefMatch = anchorTag ? anchorTag[0].match(/href\s*=\s*["']([^"']*)["']/i) : null;
    const titleAttrMatch = anchorTag ? anchorTag[0].match(/\btitle\s*=\s*["']([^"']*)["']/i) : null;
    const url = hrefMatch ? decodeEntities(hrefMatch[1]).trim() : '';
    // 标题优先取 <a title="…">：内文里可能夹 `inline_graphic` 公式图（正畸刊实测有），
    // 取属性值最干净；没有 title 属性时再退回内文（cleanText 会剥掉 <img>）。
    const titleFromAttr = titleAttrMatch ? cleanText(titleAttrMatch[1]) : '';
    const titleFromInner = anchor && anchor[1] ? cleanText(anchor[1]) : '';
    const title = titleFromAttr || titleFromInner;
    if (!title) continue;

    const tipRaw = pickPRaw(block, 'current_tip');
    const journal = cleanText(String(tipRaw).split('<span')[0] || '') || name;
    const tipSpan = tipRaw.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    const citation = tipSpan && tipSpan[1] ? cleanText(tipSpan[1]) : '';
    const doiMatch = citation.match(/DOI\s*[：:]\s*([^\s]+)/i);

    items.push({
      title,
      titleEn: pickPText(block, 'curr_eng'),
      authors: pickPText(block, 'current_author'),
      journal,
      citation,
      doi: doiMatch ? doiMatch[1] : '',
      url: /^https?:\/\//i.test(url) ? url : '',
      publishedAt,
      issueLabel,
      sourceId,
    });
  }

  // ④ 有锚点但一条都没解析出来 —— 同样是结构变了，必须报错而不是交空数组
  if (items.length === 0) {
    return fail(
      `页面结构变化：找到 ${blocks.length} 处标题锚点，但没有一条能解析出标题与链接`,
    );
  }

  return { ok: true, items, error: '', sourceId, name, issueLabel, publishedAt };
}

/** 安全地调一次抓取（异常一律转成 { ok:false, error }，绝不让调用方 try/catch 满天飞）。 */
async function safeFetchHtml(fetchFn, url) {
  try {
    const r = await fetchFn(url);
    if (!r || typeof r !== 'object') return { ok: false, error: '抓取无返回' };
    return r;
  } catch (e) {
    return { ok: false, error: (e && e.message) || '抓取异常' };
  }
}

/**
 * 抓一份期刊的**当期目录**并解析成文章数组。
 *
 * 流程：先抓 `home` 自动发现当期入口 → 发现失败则回落到配置的 `entry` → 解析 → 结构自证。
 *
 * @param {{id:string, name:string, host:string, home:string, entry:string}} sourceCfg 期刊源配置
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn] 抓取实现（默认走主进程 /api/journal-issue 的 fetchJournalHtml）
 * @param {boolean} [opts.discover=true] 是否先尝试从首页自动发现当期入口
 * @returns {Promise<{ok:boolean, items:Array<object>, error:string, sourceId:string, name:string,
 *            entry:string, entryMode:'discovered'|'config', discoverError:string,
 *            issueLabel:string, publishedAt:string}>}
 */
export async function fetchJournalIssue(sourceCfg, opts = {}) {
  const cfg = sourceCfg && typeof sourceCfg === 'object' ? sourceCfg : {};
  const sourceId = String(cfg.id || '');
  const name = String(cfg.name || '');
  const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : fetchJournalHtml;
  const base = {
    ok: false,
    items: [],
    error: '',
    sourceId,
    name,
    entry: '',
    entryMode: 'config',
    discoverError: '',
    issueLabel: '',
    publishedAt: '',
  };

  if (!cfg.entry) {
    return { ...base, error: '期刊源配置缺失（没有配置当期目录入口 entry）' };
  }

  // ---- 第一步：试着从期刊首页自动发现「当期」入口（这样跨期不用改代码）----
  if (opts.discover !== false && cfg.home) {
    const home = await safeFetchHtml(fetchFn, cfg.home);
    if (home && home.ok === true && home.text) {
      const found = discoverIssueEntry(home.text, cfg);
      if (found.ok) {
        base.entry = found.url;
        base.entryMode = 'discovered';
      } else {
        base.discoverError = '期刊首页未找到当期入口链接，回落到配置的入口';
      }
    } else {
      base.discoverError = `期刊首页抓取失败（${(home && home.error) || '无内容'}），回落到配置的入口`;
    }
  }
  // ---- 第二步：回落到配置的入口（不是猜的地址，是 JOURNAL_SOURCES 里人工核对过的）----
  if (!base.entry) {
    base.entry = String(cfg.entry);
    base.entryMode = 'config';
  }

  // ---- 第三步：抓目录页 ----
  const page = await safeFetchHtml(fetchFn, base.entry);
  if (!page || page.ok !== true || !page.text) {
    return {
      ...base,
      error: `期刊目录页抓取失败：${(page && page.error) || '无内容'}`,
    };
  }

  // ---- 第四步：解析（结构变了会在这里 ok:false，绝不冒充「今天没有新文献」）----
  const parsed = parseJournalIssue(page.text, cfg);
  if (!parsed.ok) return { ...base, error: parsed.error };

  return {
    ...base,
    ok: true,
    items: parsed.items,
    issueLabel: parsed.issueLabel,
    publishedAt: parsed.publishedAt,
  };
}

/**
 * 抓所有期刊源的当期目录，产出**与 crawlSources 同形**的条目（可直接过 judgeDentalRelevance /
 * pushArticle，不用上层为它写第二套映射）。
 *
 * 串行抓（只有两个源）：同一站点并发容易被反爬，而且总量很小，串行的确定性更重要。
 *
 * @param {Array<object>} [sources=JOURNAL_SOURCES] 期刊源配置
 * @param {object} [opts] 透传 fetchJournalIssue（fetchFn / discover）+ perSource
 * @returns {Promise<{items:Array<object>, failed:Array<{name:string,error:string}>}>}
 */
export async function crawlJournalSources(sources, opts = {}) {
  const list = (Array.isArray(sources) ? sources : JOURNAL_SOURCES).filter(
    (s) => s && typeof s.entry === 'string' && s.entry.trim(),
  );
  const perSource = Number(opts && opts.perSource) > 0 ? Number(opts.perSource) : LEARN_PER_SOURCE;
  const items = [];
  const failed = [];
  const seen = new Set();

  for (let i = 0; i < list.length; i += 1) {
    const cfg = list[i];
    const name = String(cfg.name || cfg.id || '未知期刊');
    const res = await fetchJournalIssue(cfg, opts);
    if (!res.ok) {
      // 诚实：抓不到就进 failed 上报原因，绝不静默当成「没有新文献」
      failed.push({ name, error: res.error || '抓取失败' });
      continue;
    }
    const slice = res.items.slice(0, perSource);
    for (let k = 0; k < slice.length; k += 1) {
      const it = slice[k];
      const titleKey = normalizeTitle(it.title);
      const urlKey = String(it.url || '').trim();
      if (titleKey && seen.has(titleKey)) continue;
      if (urlKey && seen.has(urlKey)) continue;
      if (titleKey) seen.add(titleKey);
      if (urlKey) seen.add(urlKey);
      const brief = [it.titleEn, it.citation].filter(Boolean).join(' · ');
      items.push({
        title: it.title,
        url: it.url || '',
        summary_long: brief,
        image: '',
        published_at: it.publishedAt || res.publishedAt || '',
        // 作者位置上放**真实作者**（论文场景下比期刊名有用），期刊名走 __sourceName
        author: it.authors || name,
        category: 'tech',
        source_id: it.sourceId || cfg.id || '',
        country: 'CN',
        __sourceName: name,
        __sourceLevel: 'official',
        __category: 'tech',
        // 与 RSS 条目同构：跑同一条相关性闸门，且命中文献层白名单 → 不会被误判掉
        __sourceTier: 'literature',
      });
    }
  }

  return { items, failed };
}

/** 这条条目是不是来自期刊目录抓取器（而不是 RSS）。 */
export function isJournalSource(sourceId) {
  return JOURNAL_SOURCE_IDS.includes(String(sourceId || ''));
}

/**
 * 把期刊文献**稳定地**排到 RSS 条目之前（老板要的「优先中华医学期刊口腔文献」）。
 *
 * 为什么要一个显式函数、而不是「反正我是先抓期刊的」：
 *   抓取顺序会被以后的重构（并发池、失败重试、缓存命中）打乱，而「文献在最前」是老板
 *   明确的优先级要求 —— 只有把它写成一次稳定的分区排序，才不会被顺手改回去。
 * 稳定性：同组内保持原顺序（Array.prototype.sort 在老引擎上不稳定，故用两数组拼接）。
 *
 * @param {Array<object>} items 任意顺序的条目
 * @returns {Array<object>} 期刊文献在前、其余在后（新数组，不改入参）
 */
export function sortJournalFirst(items) {
  const list = Array.isArray(items) ? items : [];
  const head = [];
  const tail = [];
  for (let i = 0; i < list.length; i += 1) {
    const it = list[i];
    const id = it && (it.source_id != null ? it.source_id : it.sourceId);
    if (isJournalSource(id)) head.push(it);
    else tail.push(it);
  }
  return head.concat(tail);
}

/**
 * 源的层归属（未登记的源按 source_level 兜底，绝不返回 undefined）。
 * @param {{id:string, source_level?:string}} s 源配置
 * @returns {string} 层名
 */
function tierOf(s) {
  const id = String((s && s.id) || '');
  if (hasTier(id)) return SOURCE_TIER[id];
  return s && s.source_level === 'official' ? 'dental_academic' : 'industry_zh';
}

/** tier 表里是否登记过这个 id（用 hasOwnProperty，避免原型链上的同名字段骗过判断）。 */
function hasTier(id) {
  return Object.prototype.hasOwnProperty.call(SOURCE_TIER, id) && !!SOURCE_TIER[id];
}

/**
 * 按源 id 查它属于哪一层（UI 打「口腔文献 / 专业媒体」标用）。
 *
 * 为什么从 id 反查而不是把 tier 存进 article：
 *   knowledgeStore.normalizeArticle 是**白名单式**归一化（新字段会被静默丢掉），
 *   而本轮不改 store；源 id 本来就随 article 一起落库，用它反查最稳、零迁移。
 * @param {string} id 源 id
 * @returns {string} 层名；未登记返回 ''
 */
export function sourceTierOf(id) {
  const key = String(id || '');
  return hasTier(key) ? SOURCE_TIER[key] : '';
}

/**
 * 按「层」挑选学习中心的资讯源（0.21.16 · 老板需求 6）。
 *
 * 与 pickSources 的分工：`pickSources` 保持原样（10 个源，按分类+层级打分），
 * 它是通用入口、别的调用方可能还在用；本函数是**学习中心专用**的收口策略，
 * 不动别人的默认行为（施工边界：改 pickSources 会连带影响其它页面）。
 *
 * 规则：
 *   1. 只保留配了 rssUrl 且启用中的源（与 crawlSources 的入参要求一致）；
 *   2. 只保留当前角色层级表里登记过的层 —— 门诊视角的 ai_marketing 层整层剔除；
 *   3. 同层内：中文源优先，其次按层级（官方 > 专业 > 营销）与角色分类偏好；
 *   4. 结果不足 2 个时退回 pickSources，**绝不返回空数组**（否则整页一条资讯都没有）。
 *
 * @param {string} companyType 'clinic' | 'manufacturer' | 'doctor' | 'platform' | 'dealer'
 * @param {string} role 用户角色
 * @param {number} [limit=LEARN_SOURCE_LIMIT] 最多几个源
 * @returns {Array<{id,name,category,source_level,country,language,url,rssUrl,tier}>}
 */
export function pickLearningSources(companyType, role, limit = LEARN_SOURCE_LIMIT) {
  const learningRole = resolveLearningRole(companyType, role);
  const tierOrder = learningRole === 'manufacturer'
    ? LEARN_TIER_ORDER.manufacturer
    : LEARN_TIER_ORDER.clinic;
  const rolePriority = ROLE_CATEGORY_PRIORITY[learningRole] || ROLE_CATEGORY_PRIORITY.operator;
  const max = Number(limit) > 0 ? Number(limit) : LEARN_SOURCE_LIMIT;

  const scored = [];
  SEED_SOURCES.forEach((s) => {
    if (!s || s.enabled === false) return;
    if (typeof s.rssUrl !== 'string' || !s.rssUrl.trim()) return;
    const tier = tierOf(s);
    const tierIdx = tierOrder.indexOf(tier);
    // 不在本角色层级表里的层 = 不想要的噪音（门诊视角的 AI/营销号就走这条被剔掉）
    if (tierIdx < 0) return;
    const catIdx = rolePriority.indexOf(s.category);
    const cat = catIdx < 0 ? 99 : catIdx;
    const lv = Object.prototype.hasOwnProperty.call(LEVEL_RANK, s.source_level)
      ? LEVEL_RANK[s.source_level]
      : 3;
    const lang = s.language === 'zh' ? 0 : 1;
    scored.push({
      s,
      tier,
      // 层是第一判据（×1000 保证跨层不可被其它因子翻盘），层内再比中文 / 分类 / 层级
      score: tierIdx * 1000 + lang * 100 + cat * 4 + lv,
    });
  });

  scored.sort((a, b) => a.score - b.score);
  const picked = scored.slice(0, max).map((x) => ({
    id: x.s.id,
    name: x.s.name,
    category: x.s.category,
    source_level: x.s.source_level,
    country: x.s.country,
    language: x.s.language,
    url: x.s.url,
    rssUrl: x.s.rssUrl,
    tier: x.tier,
  }));

  if (picked.length >= 2) return picked;
  // 兜底：层级表把源筛没了（比如以后有人改坏了 tier 表）也必须有内容可抓
  return pickSources(companyType, role, max).map((s) => ({ ...s, tier: tierOf(s) }));
}

// ══════════════════════════════════════════════════════════════════
// 【0.21.16 · 老板需求 6】「AI 先帮我判断一下」—— 相关性闸门
//
// 老板要的是「别把乱七八糟的东西推给我」，所以抓回来的条目在**入库前**过一道判断：
//   · AI 可用 → 让模型按标题逐条判「口腔临床 / 门诊经营」相关性，只留相关的；
//   · AI 不可用（未配置 / 超时 / 返回坏格式）→ 退回**规则过滤**（文献源白名单 + 关键词），
//     并且**绝不因此一条都不显示**（这是硬要求：降级可以差一点，不能空屏）。
// ══════════════════════════════════════════════════════════════════

/** 口腔 / 门诊相关关键词（规则兜底用；命中任一即视为相关）。 */
const DENTAL_KEYWORDS = [
  '口腔', '牙', '齿科', '种植', '正畸', '修复', '牙周', '根管', '龋', '氟', '智齿', '洁牙', '洗牙',
  '义齿', '颌', '黏膜', '颞下', '儿牙', '正颌', '美白', '贴面', '牙椅', '椅位', '诊所', '门诊',
  '患者', '医师', '医生', '诊疗', '临床', '病历', '院感', '消毒', '灭菌', '医保', '医疗', '器械',
  '耗材', '文献', '期刊', '研究', '循证', '指南', '共识', '学术', '继续教育', '评审', '集采',
  'dental', 'dentistry', 'tooth', 'teeth', 'oral', 'implant', 'orthodont', 'periodont', 'caries',
  'endodont', 'prosthodont', 'clinic', 'patient', 'clinical',
];

/**
 * 规则版相关性判断（AI 不可用时的降级路径）。
 * @param {{title?:string, summary_long?:string, __sourceName?:string, __sourceTier?:string, source_id?:string}} it 条目
 * @returns {boolean} true = 与口腔临床 / 门诊经营相关
 */
export function isDentalRelevantByRule(it) {
  const id = String((it && it.source_id) || '');
  if (LITERATURE_SOURCE_IDS.includes(id)) return true; // 文献源白名单：无条件放行
  const tier = String((it && it.__sourceTier) || '');
  if (tier === 'literature') return true;
  const text = `${(it && it.title) || ''} ${(it && it.summary_long) || ''}`.toLowerCase();
  if (!text.trim()) return false;
  return DENTAL_KEYWORDS.some((k) => text.includes(k));
}

/** 从模型输出里抠出第一个 JSON 数组（容忍 ```json 包裹与前后废话）。 */
function parseIndexArray(text) {
  const raw = String(text == null ? '' : text);
  const m = raw.match(/\[[\s\S]*?\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    return arr
      .map((v) => (typeof v === 'number' ? v : parseInt(String(v), 10)))
      .filter((v) => Number.isFinite(v));
  } catch {
    return null;
  }
}

/** 相关性判断的提示词（逐条编号，只要保留的序号，输出越短越不容易跑偏）。 */
function buildRelevancePrompt(items) {
  const lines = items.map((it, i) => `${i + 1}. ${String((it && it.title) || '').slice(0, 90)}`);
  return [
    '你是口腔医疗行业的内容编辑。下面是一批抓取回来的资讯标题，编号列出。',
    '请判断每一条**是否值得推荐给一家口腔门诊 / 口腔医生阅读**。',
    '判定标准（只留两类）：',
    '  ① 口腔临床：诊断、治疗、技术、材料、循证、指南、病例、学术研究进展；',
    '  ② 门诊经营：患者管理、获客、定价、复购、团队、合规、医保、器械耗材采购。',
    '下列一律**不要**：与口腔无关的通用科技/AI 新闻、公众号营销课、产品经理文章、',
    '与医疗无关的财经时政、纯广告与软文。',
    '只输出一个 JSON 数组，元素是**要保留的编号**（整数），不要任何解释、不要代码块。',
    '如果一条都不相关，输出 []。',
    '',
    ...lines,
  ].join('\n');
}

/**
 * 相关性闸门：抓回来的条目先过 AI 判断，不合格的剔掉；AI 不可用则退回规则过滤。
 *
 * ⚠️ 三条不可妥协的行为：
 *   ① **永不空屏** —— 无论 AI 还是规则，若过滤后一条不剩，就保留原样（宁可杂，不可空）；
 *   ② **永不谎报** —— 返回的 `mode` 如实说明这次是 AI 判的还是规则判的，UI 据此显示；
 *   ③ **不阻塞** —— 异常一律吞掉走降级，抓取失败不能让整次浏览失败。
 *
 * @param {Array<object>} items crawlSources 返回的条目
 * @param {object} [opts]
 * @param {Function} [opts.chatFn] 补全实现（调用方注入 chatOnce；不传 = 纯规则模式）
 * @param {number} [opts.maxJudge=20] 一次最多送几条给模型（省 token，其余走规则）
 * @returns {Promise<{items:Array<object>, mode:'ai'|'rule', judged:number, dropped:number, error:string}>}
 */
export async function judgeDentalRelevance(items, opts = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (list.length === 0) {
    return { items: [], mode: 'rule', judged: 0, dropped: 0, error: '' };
  }

  /** 规则过滤（降级路径，也是 AI 路径的兜底）。 */
  const byRule = () => {
    const kept = list.filter((it) => isDentalRelevantByRule(it));
    // 永不空屏：规则把所有条目都判死时，保留原样而不是交白卷
    const out = kept.length > 0 ? kept : list;
    return {
      items: out,
      mode: 'rule',
      judged: list.length,
      dropped: list.length - out.length,
      error: '',
    };
  };

  const fn = typeof opts.chatFn === 'function' ? opts.chatFn : null;
  if (!fn) return byRule();

  const maxJudge = Number(opts.maxJudge) > 0 ? Number(opts.maxJudge) : 20;
  const head = list.slice(0, maxJudge);
  const tail = list.slice(maxJudge);

  let res = null;
  try {
    res = await fn(
      [{ role: 'user', content: buildRelevancePrompt(head) }],
      null,
      // 15s 硬上限：这道闸门只是给抓取结果打个筛，卡住 1 分钟比不做筛选更糟
      // （用户点「抓取今日资讯」会一直转圈）。超时 → ok:false → 走规则降级。
      { temperature: 0, maxTokens: 400, timeoutMs: 15000 },
    );
  } catch (e) {
    res = { ok: false, content: '', error: (e && e.message) || '相关性判断异常' };
  }

  if (!res || res.ok === false) {
    const r = byRule();
    return { ...r, error: String((res && res.error) || 'AI 不可用') };
  }

  const idx = parseIndexArray(res.content);
  if (!idx) {
    // 模型没按格式回 —— 当它不可用处理（不猜、不硬凑）
    const r = byRule();
    return { ...r, error: 'AI 返回格式无法解析' };
  }

  const keep = new Set(
    idx
      .map((n) => n - 1)
      .filter((i) => i >= 0 && i < head.length),
  );
  const keptHead = head.filter((_it, i) => keep.has(i));
  // 超出 maxJudge 的条目没经过模型判断，按规则判（不连坐丢掉）
  const keptTail = tail.filter((it) => isDentalRelevantByRule(it));
  const out = keptHead.concat(keptTail);
  // 永不移除全部：AI 把 20 条全判死时，至少把文献源白名单里的条目留下
  const safe = out.length > 0 ? out : head.filter((it) => isDentalRelevantByRule(it));
  const final = safe.length > 0 ? safe : list;
  return {
    items: final,
    mode: 'ai',
    judged: head.length,
    dropped: list.length - final.length,
    error: '',
  };
}

/**
 * 按企业类型 + 角色挑选可用的 RSS 源（已按优先级排序）。
 * 只返回配置了 rssUrl 且启用中的源；层级高、分类匹配、中文源优先。
 * @param {string} companyType 'clinic' | 'manufacturer'
 * @param {string} role 用户角色
 * @param {number} [limit=10] 最多返回几个源
 * @returns {Array<{id,name,category,source_level,url,rssUrl,language,country}>}
 */
export function pickSources(companyType, role, limit = 10) {
  const learningRole = resolveLearningRole(companyType, role);
  const priority = ROLE_CATEGORY_PRIORITY[learningRole] || ROLE_CATEGORY_PRIORITY.operator;
  const max = Number(limit) > 0 ? Number(limit) : 10;

  const scored = SEED_SOURCES.filter(
    (s) => s && s.enabled !== false && typeof s.rssUrl === 'string' && s.rssUrl.trim(),
  ).map((s) => {
    const catIdx = priority.indexOf(s.category);
    const p = catIdx < 0 ? 99 : catIdx;
    const lv = Object.prototype.hasOwnProperty.call(LEVEL_RANK, s.source_level)
      ? LEVEL_RANK[s.source_level]
      : 3;
    const lang = s.language === 'zh' ? 0 : 1;
    return { s, score: p * 10 + lv * 2 + lang };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((x) => ({
    id: x.s.id,
    name: x.s.name,
    category: x.s.category,
    source_level: x.s.source_level,
    country: x.s.country,
    language: x.s.language,
    url: x.s.url,
    rssUrl: x.s.rssUrl,
  }));
}

/** 把任意日期字符串转成 ISO 字符串；解析失败返回空串。 */
function toIso(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString();
}

/**
 * 并发抓取多个 RSS 源，返回去重后的条目与失败清单。
 * @param {Array<{id,name,category,source_level,rssUrl}>} sources 待抓源（未配 rssUrl 的会被跳过）
 * @param {object} [opts] { perSource=6, concurrency=4 }
 * @returns {Promise<{items:Array<object>, failed:Array<{name:string, error:string}>}>}
 */
export async function crawlSources(sources, opts = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter(
    (s) => s && typeof s.rssUrl === 'string' && s.rssUrl.trim(),
  );
  const perSource = Number(opts && opts.perSource) > 0 ? Number(opts.perSource) : 6;
  const concurrencyRaw = Number(opts && opts.concurrency) > 0 ? Number(opts.concurrency) : 4;
  const concurrency = Math.min(Math.max(1, concurrencyRaw), 8);

  const items = [];
  const failed = [];
  const seen = new Set();
  let cursor = 0;

  /** 单个 worker：不断从队列取源，抓取 + 解析 + 去重入池。 */
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      const s = list[idx];
      const name = String((s && s.name) || (s && s.rssUrl) || '未知来源');

      let res = null;
      try {
        res = await fetchRss(s.rssUrl);
      } catch (e) {
        res = { ok: false, error: (e && e.message) || '抓取异常' };
      }
      if (!res || res.ok !== true || !res.text) {
        failed.push({ name, error: (res && res.error) || '抓取失败（无内容）' });
        continue;
      }

      let parsed = [];
      try {
        parsed = parseFeed(res.text);
      } catch (e) {
        parsed = [];
      }
      if (!parsed.length) {
        failed.push({ name, error: 'RSS 解析为空（可能不是标准 RSS/Atom）' });
        continue;
      }

      const slice = parsed.slice(0, perSource);
      for (let i = 0; i < slice.length; i += 1) {
        const it = slice[i];
        const titleKey = normalizeTitle(it.title);
        const linkKey = String(it.link || '').trim();
        if (titleKey && seen.has(titleKey)) continue;
        if (linkKey && seen.has(linkKey)) continue;
        if (titleKey) seen.add(titleKey);
        if (linkKey) seen.add(linkKey);
        items.push({
          title: it.title,
          url: it.link || '',
          summary_long: it.description || '',
          // 0.21.11 第 4 条：把条目自带配图一路带进 article.image（空串 = 上层回退默认封面）
          image: it.image || '',
          published_at: toIso(it.pubDate) || new Date().toISOString(),
          author: name,
          category: s.category || '',
          source_id: s.id || '',
          country: s.country || '',
          __sourceName: name,
          __sourceLevel: s.source_level || '',
          __category: s.category || '',
          // 0.21.16 · 老板需求 6：把源的分层带进条目，规则兜底过滤与 UI 标注都要用
          __sourceTier: s.tier || '',
        });
      }
    }
  }

  const pool = [];
  for (let i = 0; i < concurrency; i += 1) pool.push(worker());
  await Promise.all(pool);

  return { items, failed };
}

export default {
  parseFeed,
  pickSources,
  // 0.21.16 · 老板需求 6：学习中心专用的分层挑源 + 相关性闸门
  pickLearningSources,
  judgeDentalRelevance,
  isDentalRelevantByRule,
  crawlSources,
  // 0.21.16 · 老板第 1 条：中华医学期刊网当期目录（不是 RSS，单列一套）
  JOURNAL_SOURCES,
  JOURNAL_SOURCE_IDS,
  LITERATURE_PORTALS,
  discoverIssueEntry,
  parseJournalIssue,
  fetchJournalIssue,
  crawlJournalSources,
  isJournalSource,
  sortJournalFirst,
};
