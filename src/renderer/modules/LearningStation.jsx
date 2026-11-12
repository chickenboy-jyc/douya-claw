import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Tabs,
  Button,
  Input,
  Select,
  Segmented,
  Pagination,
  Space,
  Empty,
  Modal,
  Spin,
  Drawer,
  Steps,
  Alert,
  Divider,
  App as AntApp,
} from 'antd';
import Markdown from '../components/Markdown.jsx';
import PageBanner from '../components/PageBanner.jsx';
// 【0.21.16 · 老板需求 6】「重要的还是对话框」——
// 复用第十七轮就存在的对话组件（经营方案/活动策划同一个），不自己再造一个输入框：
// 它自带会话落盘（切页面不丢）、后台任务、失败如实报错、示例一键提问。
// 【0.21.17 · 老板第 2 条】挂载点从「学习中心首屏」搬到「🎓 门诊运营教学」页签内部
// （老板原话「删了，对话框放在门诊运营教学里面 不要一进去就在顶部」）—— import 本身不变。
import ActivityChat from './ActivityChat.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset, useMarketingGoal } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { useDailyTasks } from '../store/dailyOpsStore.jsx';
// 【0.21.28】「示例内容，非实时资讯」标签的字色要按**当前主题**取值（见 SAMPLE_TAG_INK）。
// `useTheme` 是模块级单例的订阅 Hook（store/themeStore.js:202），不需要 Provider，
// 在 jsdom 里也能跑；返回值只有 'light' | 'dark'（两套主题），非法值内部已回落 'light'（默认白色）。
import { useTheme } from '../store/themeStore.js';
import {
  useKnowledgeSources,
  useKnowledgeArticles,
  useMyLearning,
  LEARNING_STATUS,
} from '../store/knowledgeStore.jsx';
import {
  KNOWLEDGE_CATEGORIES,
  ROLE_LEARNING,
  SOURCE_LEVELS,
  SEED_SOURCES,
  categoryLabel,
  resolveLearningRole,
  roleLabel,
  companyTypeLabel,
  learningCompanyType,
  normalizeTitle,
  // 【0.21.28 · 老板「还有教学 现在也是很糟糕的完全不能看」】
  // 6 篇运营 SOP 一直躺在 data/knowledgeCatalog.js 里（7467 字 / 30 个步骤 / 65 条验收），
  // 全仓此前**只有注释提到它，没有任何 import** —— 内容在库里，页面上一个字都没有。
  // 本轮把它接到「🎓 门诊运营教学」页签（`.learn-tut-card` 卡片网格，见下方 tabItems）。
  TUTORIAL_LIBRARY,
} from '../data/knowledgeCatalog.js';
import { genArticleSummary, genArticleInterpret, genArticleTranslate, genFetchIndustryNews, genPlainInterpret } from '../services/knowledgeAI.js';
// 【0.21.27 · 老板「学习中心内容十分糟糕，是不是根本爬不到内容」】
// 抓取结果的三态文案（全部失败 / 部分失败 / 真的没有新增）只有一处实现，纯函数可单测 ——
// 详见该文件头注释：改前「全挂」被统一说成「这次抓到的都是已有资讯，没有新增」。
import { describeFetchNotice } from '../services/learnFetchReport.js';
// 【0.21.16 · 老板需求 6】资讯源收口：
//   pickLearningSources = 分层挑源（口腔文献层最前、门诊视角剔除通用 AI/营销号、源数 10→5）；
//   judgeDentalRelevance = 抓回来的条目先过一道「AI 判断相关性」，AI 不可用则规则降级。
// 【0.21.16 · 老板第 1 条】中华医学期刊网当期目录（老板原话「这个不就是中华医学期刊网吗」）：
//   crawlJournalSources = 抓两个口腔期刊的当期目录；sortJournalFirst = 把文献稳定排到 RSS 之前。
import {
  crawlSources,
  crawlJournalSources,
  sortJournalFirst,
  JOURNAL_SOURCES,
  pickLearningSources,
  judgeDentalRelevance,
  sourceTierOf,
  LEARN_PER_SOURCE,
  LEARN_SOURCE_LIMIT,
  LITERATURE_PORTALS,
} from '../services/rssService.js';
// 【0.21.14 · 老板需求 2】「实操教学」→「门诊运营教学」：按 5 维诊所画像生成一页方案。
// 领域逻辑全在 services/ocpPlan.js（纯函数，可 node 单测）；本文件只做渲染与交互。
import { chatOnce } from '../api.js';
import {
  OCP_TOPICS,
  OCP_PROFILE_FIELDS,
  OCP_EMPTY_TEXT,
  OCP_ERROR_TEXT,
  basisOf,
  checklistOf,
  loadOcpPlan,
  loadOcpProfile,
  loadOcpProgress,
  parseOcpSections,
  saveOcpProfile,
  suggestOcpProfile,
  generateOcpPlan,
  toggleOcpProgress,
} from '../services/ocpPlan.js';
// 独立样式文件（共享知识 S2：禁止往 6697 行的 style.css 里加规则），类名一律 `.ocp-` 前缀。
import '../styles/ocp.css';
import {
  ONBOARDING_GROUPS,
  filterOnboardingPlatforms,
  countOnboardingVerified,
  groupLabel,
  resolveVerified,
} from '../data/platformOnboardingCatalog.js';
// 【0.21.9 · 老板第 7 条】「学习中心做成卡片形式，最好带图片」。
// 图片一律用仓库里已有的真实素材（assets/activity 那 6 张），**不引外网图片**：
// 桌面端离线时外链图必然裂图，而"破图"比没有图更难看。
import coverForum from '../assets/activity/cover-forum.webp';
import coverLaunch from '../assets/activity/cover-launch.webp';
import coverMeeting from '../assets/activity/cover-meeting.webp';
import coverPromo from '../assets/activity/cover-promo.webp';
import coverScience from '../assets/activity/cover-science.webp';
import coverCalendarEmpty from '../assets/activity/calendar-empty.webp';
// 卡片网格 / 封面 / 截断等新样式（不写进 style.css：那文件 6697 行、16 个模块共用）
import '../styles/round16-learn.css';
// 【0.21.11 · 老板第 4 条】文章二级页（原文 / 翻译 / AI解读）的样式，放在卡片样式之后
import '../styles/round16-learn-detail.css';

// 绿色主题 + Apple 极简（与项目其它模块保持一致）
const GREEN = 'var(--c-brand)';
const GREEN_DARK = 'var(--c-brand-dark)';
const GREEN_BG = 'var(--c-brand-tint)';
const FAINT = 'var(--c-text-3)';
const CARD = { background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 12, padding: 16 };

/**
 * 「示例内容，非实时资讯」标签的**字色**（按主题）。背景恒为 `var(--c-warn-tint)`。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么白色主题要单独给一个更深的值 —— 4.29:1 是实算出来的，不是感觉】
 *   白色主题下若沿用 `color: var(--c-warn)` 压 `background: var(--c-warn-tint)`，即
 *   `#9a6a00` 压 `#fbf3e3`（两值都在 styles/theme-tokens.css 的 `:root` 与
 *   `[data-theme="light"]` 两块里，逐字同值）。按 WCAG 2.x 相对亮度实算
 *   （每通道先做 sRGB 反伽马，L = 0.2126R + 0.7152G + 0.0722B，
 *   对比度 = (L_hi + 0.05) / (L_lo + 0.05)）：
 *       L(#9a6a00) = 0.17178   L(#fbf3e3) = 0.90156
 *       ⇒ (0.90156 + 0.05) / (0.17178 + 0.05) = 4.291 ⇒ **4.29:1**
 *   **低于 WCAG AA 正文下限 4.5:1** ⇒ 白底上一行 11.5px 的小字读不清，这是「教学不能看」
 *   的一部分（标签看不清也是不能看）。
 *   换成 `#7a5b00`（与 style.css 的 `.ai-gate-banner` 同一支人工调过的色）：
 *       L(#7a5b00) = 0.11620
 *       ⇒ (0.90156 + 0.05) / (0.11620 + 0.05) = 5.726 ⇒ **5.73:1** ✓ 过 AA。
 *   （上面两个 L 与两个比值都是脚本实算出来的，可复现：
 *     `L = 0.2126*srgb(R) + 0.7152*srgb(G) + 0.0722*srgb(B)`，`srgb(c)` 先 `c/255`
 *     再 `c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`。）
 *
 * 【原「绿主题这一处只有 3.87:1」那笔欠账：已随绿色主题下线一起作废，不是被放过】
 *   这段注释的上一版写着：绿主题（无 `data-theme`）下 `--c-warn` = `#B26A00` 压
 *   `--c-warn-tint` = `rgba(255,159,10,0.12)` 在 `.learn-card-media` 白底上合成 `#fff3e2`，
 *   实算只有 **3.87:1**；换成 `#7a5b00` 可到 5.77:1，但当时为了守住「默认主题像素不许漂」
 *   的红线**没有动**，并注明「要不要破例是视觉决策，已上报 team-lead」。
 *   2026-11-08 之后绿色主题被产品决策整条删除（用户：「主题色是绿色 就白色和深色就行了」），
 *   `store/themeStore.js` 的 `normalizeTheme` 只会返回 `'light' | 'dark'`，存量的 `'green'`
 *   值一律迁移成 `'light'`。于是本表原有的 `green` 键**再也取不到**（`learnTheme` 两个取值
 *   都有专用键，`||` 兜底永不触发），已删除 —— 那笔 3.87:1 的欠账是**分支连同欠账一起下线**，
 *   而不是被「允许不合格」。现在在线的是 `light`（5.73:1）与 `dark`（5.09:1），
 *   两套主题全部过 AA。
 *   连带说明：那条红线的口径也已同步改写 —— 判据基线从「绿主题逐像素不变」
 *   变成「白色默认态逐条不变」（见 `scripts/smoke/theme-default-snapshot.json`
 *   与 `scripts/smoke/theme-green-declarations.mjs` 的域说明）。
 *
 * 【深色主题为什么直接沿用令牌值】
 *   dark 下 `var(--c-warn)` 是 `#e3a33a`（亮黄），压 `rgba(227,163,58,.16)` 在 `#232725`
 *   上合成的 `#413b28` 附近：
 *       L(#e3a33a) = 0.42831   L(#413b28) = 0.04405
 *       ⇒ (0.42831 + 0.05) / (0.04405 + 0.05) = **5.09:1** ✓ 本来就合格。
 *     ⚠️ 这里**绝不能**图省事写成裸的 `'#7a5b00'`：深棕压深底实测只有 **1.77:1**，
 *     等于把深色主题弄瞎（比原来的问题更严重）。
 *
 * 【为什么不动令牌本身】
 *   `--c-warn` / `--c-warn-tint` 被 36~37 个选择器 + 另外 6 处 JSX 内联样式共用
 *   （PrCrisis.jsx:58,59,61,584 / CalendarView.jsx:37 / PlatformAccountMatrix.jsx:32），
 *   改令牌是「一次性动一片」的独立视觉决策，不在本单范围内。
 *
 * 【为什么改在 JSX 而不是 CSS】
 *   ① 本处配色本来就是 JSX 内联样式（`style={{ color, borderColor, background }}`），
 *      内联权重高于任何类选择器，写到 CSS 里必须 `!important` 才盖得住 —— 那是更脏的写法。
 *   ② `styles/round16-learn.css` 在 `unit-theme-cover-group-b.mjs` 的 E2（逐位置颜色序列棘轮）
 *      下**新增一条颜色声明就判红**，该文件本轮已确认零颜色声明（见其末尾头注释）。
 *   ③ 代价要说清：`unit-theme-cover-style-css.mjs` 只读 CSS 文件，**看不到 JSX 内联样式**，
 *      所以这道门禁不会替本处把关 —— 上面那两行对比度是手算后写进本注释的，别当成门禁结论。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * @type {{light: string, dark: string}}
 */
const SAMPLE_TAG_INK = {
  light: '#7a5b00', // 5.73:1 on #fbf3e3（沿用 var(--c-warn)=#9a6a00 只有 4.29:1）
  dark: 'var(--c-warn)', // #e3a33a · 亮黄压深底本来就合格，不动
};

/**
 * 【老板第 5 条】学习中心卡片列表的分页粒度。
 *
 * 为什么是 6：`.learn-grid` 是 `minmax(280px, 1fr)` 的两行网格，1280 视口下每行 3 张 ⇒
 * 6 条正好铺满两屏：一屏看「现在有什么」，再滚一屏就到尾，不用一直往下翻几十张卡；
 * 再多就还是「太长」，再少（4 条）则每页都翻、扫读效率反而低。
 *
 * 写成常量而不是各处写字面量：行业资讯与「我的学习」三个分组共用一个节奏，
 * 将来老板再调，只改这一行，不会出现某处 6 条、某处 10 条的割裂。
 */
const LEARN_PAGE_SIZE = 6;

/**
 * 【0.21.16 · 老板需求 6】学习中心的对话框提示词。
 *
 * 老板原话：「重要的还是对话框」「我前面说的那几个问题占比太大了 小一点 就是几个按钮点点就行了」。
 * 【0.21.17 · 老板第 2 条】位置又调了一次：对话框从「学习中心首屏」搬进「门诊运营教学」内部，
 * 且排在那 5 个按钮**下方**（原话「对话框放在门诊运营教学里面 不要一进去就在顶部」）。
 * ⇒ 提示词一个字没改，改的只是挂载位置；空态示例仍是这 5 个。
 *
 * 这份提示词只做三件事，多一句都不要：
 *   ① 站在「口腔门诊 / 口腔医生」视角回答；
 *   ② 涉及文献时**先说清是文献结论还是模型经验**，不许把模型推断说成文献；
 *   ③ 给能照着做的动作，不写空话。
 */
const LEARN_ASK_PROMPT = [
  '你在给一家口腔门诊（也可能是口腔医生本人）做学习答疑。',
  '回答要求：',
  '1. 先用一句话直接回答，再展开；能分点就分点，不要长篇大论。',
  '2. 涉及临床结论时必须标明「文献观点 / 指南共识 / 经验做法」中的哪一种；',
  '   不确定就写「这一点我不确定，建议查原文」，**绝不许把模型推断说成文献结论**。',
  '3. 不要编造具体文献标题、作者、期刊卷期与数据；没有确切出处就只给检索方向。',
  '4. 涉及门诊经营，给能直接照做的动作（谁做、几天、怎么判断有效）。',
  '5. 涉及医疗广告与诊疗合规，提醒以《医疗广告管理办法》和执业许可科目为准。',
].join('\n');

/**
 * 对话框空态的示例问题（= 老板说的「几个按钮点点就行」）。
 *
 * 为什么是这 5 个：前 4 个正是老板此前点名要的门诊经营问题（获客 / 采购 / 定价 / 价格战 / 复购），
 * 第 5 个是这一轮新增的「口腔文献怎么读」。点一下就发出去，不用自己打字。
 */
const LEARN_ASK_EXAMPLES = [
  '这周有什么值得看的口腔临床文献？帮我挑 3 篇并说清结论',
  '附近门诊都在降价，我不跟价还能怎么留住客人？',
  '耗材采购最容易多花钱的地方在哪，怎么识别？',
  '怎么跟患者解释价格，他才不会觉得贵？',
  '老患者做完一次就不回来了，复购怎么提？',
];

/** 资讯源分层 → 卡片上的小标签（老板要「一眼看出这是文献还是媒体」）。 */
const LEARN_TIER_LABELS = {
  literature: '口腔文献',
  dental_professional: '口腔专业媒体',
  dental_academic: '口腔权威机构',
  // 0.21.27 补的中文健康源（大众健康，不是口腔专业媒体 —— 标签如实写）
  health_zh: '中文健康媒体',
  product: '器械耗材',
  industry_zh: '行业媒体',
  ai_marketing: 'AI/营销',
};

/**
 * 【0.21.9 · 老板第 7 条】文章卡封面图映射表（来源：src/renderer/assets/activity/ 六张真图）。
 *
 * 为什么按"分类 + 标题关键词"两张表来选，而不是随机/按 id 取模：
 *   同一篇文章的封面必须**稳定**（刷新不变、换机器不变），否则用户会觉得"页面在乱跳"；
 *   而按分类映射又能让"政策法规"看起来像政策、"技术"看起来像技术，比纯轮转有语义。
 *
 * 顺序即优先级：关键词表在前（更具体），分类表兜底，最后才用通用图。
 * 为什么 policy 配 coverForum（论坛/会议合影）：六张图里没有纯"文件/印章"图，
 * 论坛横幅是其中最像"正式场合发布"的一张；这属于**装饰性配图**，不承载事实。
 */
/**
 * 封面候选池：六张真图（`assets/activity/`）。
 *
 * 【0.21.12 · 老板第 3 条】「所有首图都一样」。
 * 改前：`COVER_KEYWORD_RULES` 每条规则只映射**一张**图、`COVER_BY_CATEGORY` 每个分类也只有一张，
 *       RSS 抓来的文章大多没有自带图（`a.image` 为空）⇒ 全部落到同一个分类的同一张图上，
 *       一屏十几张卡长得一模一样。分类本身没错，错在「一个分类只有一张图」。
 * 改后：每条规则/每个分类给的是**一组**候选（2~3 张），用文章 id（没有则标题）做稳定 hash 取模。
 *       同一篇文章永远同一张（刷新不变、换机器不变），但不同文章会散开。
 */
const COVER_KEYWORD_RULES = [
  { srcs: [coverScience, coverMeeting], words: ['科普', '研究', '临床', '论文', '指南', '循证', '儿童', '预防'] },
  { srcs: [coverPromo, coverLaunch], words: ['促销', '优惠', '活动', '双十一', '大促', '券', '折扣', '获客'] },
  { srcs: [coverLaunch, coverPromo], words: ['新品', '上市', '发布', '首发', '融资', '投融资'] },
  { srcs: [coverMeeting, coverForum], words: ['大会', '论坛', '峰会', '年会', '会议', '连锁', '渠道', '经销商'] },
];

const COVER_BY_CATEGORY = {
  policy: [coverForum, coverMeeting],
  tech: [coverScience, coverLaunch],
  ai: [coverScience, coverForum],
  product: [coverLaunch, coverPromo],
  industry: [coverMeeting, coverForum],
  operation: [coverMeeting, coverPromo, coverScience],
  marketing: [coverPromo, coverLaunch],
  finance: [coverForum, coverMeeting],
};

/** 全部候选（分类/关键词都没命中时的兜底池，按 hash 摊开，不集中到一张）。 */
const COVER_POOL = [coverForum, coverScience, coverPromo, coverLaunch, coverMeeting];

/** 稳定 hash（djb2 变体）：同一字符串永远同一结果，不依赖 Math.random / 日期。 */
function stableHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 给一篇文章挑封面。纯函数：同一篇文章永远同一张图。
 * @param {object} a 文章（读 id / category / sub_category / title）
 * @returns {string} 图片地址（webpack/vite 处理后的 asset url）
 */
export function coverForArticle(a) {
  const it = a && typeof a === 'object' ? a : {};
  const hay = String(it.title || '') + ' ' + String(it.sub_category || '');
  const key = String(it.id || it.title || 'x');
  for (const rule of COVER_KEYWORD_RULES) {
    if (rule.words.some((w) => w && hay.includes(w))) {
      const pool = rule.srcs || [rule.src];
      return pool[stableHash(key) % pool.length];
    }
  }
  const byCat = COVER_BY_CATEGORY[String(it.category || '')] || COVER_POOL;
  return byCat[stableHash(key) % byCat.length];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 文章缩略图（0.21.11 · 老板第 4 条「图片要获取那篇文章的图片」「有的很长很长 这个缩略起来」）。
 *
 * 取图顺序：**文章自带图（a.image，来自 RSS 条目）** → 分类/关键词映射的默认封面。
 * 为什么要有 onError 回退：外站图会 404、会防盗链（referer 被拦就直接裂），
 * 桌面端离线时更是必然裂 —— 一旦裂了当场换成仓库里的真图，用户永远看不到破图占位。
 * 「缩略起来」靠 CSS 定位（.learn-cover 固定 16:9 + object-fit: cover），
 * 不管原图是 200×2000 还是 4000×600，卡片高度都一样，不会再出现"有的很长很长"。
 */
function ArticleCover({ article, className = '' }) {
  const own = String((article && article.image) || '');
  const fallback = coverForArticle(article);
  const [src, setSrc] = useState(own || fallback);
  useEffect(() => {
    setSrc(own || fallback);
  }, [own, fallback]);
  return (
    <img
      className={className ? `learn-cover ${className}` : 'learn-cover'}
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      data-learn-cover={article && article.id}
      data-cover-source={own && src === own ? 'article' : 'fallback'}
      onError={() => {
        // 只回退一次：已经换成默认封面还失败（仓库图都被删了），就让它停在那儿，不无限重试。
        if (src !== fallback) setSrc(fallback);
      }}
    />
  );
}

function formatDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('zh-CN');
}

/** 按 published_at 归入时间桶：today/7d/30d/older；空或非法归 older。 */
function timeBucket(a) {
  const t = new Date(a.published_at).getTime();
  if (Number.isNaN(t)) return 'older';
  const diff = Date.now() - t;
  if (diff < DAY_MS) return 'today';
  if (diff < 7 * DAY_MS) return '7d';
  if (diff < 30 * DAY_MS) return '30d';
  return 'older';
}

/** 1~5 推荐指数渲染成五颗星（点亮/灰）。 */
function renderStars(n) {
  const val = Math.max(0, Math.min(5, Number(n) || 0));
  return (
    <span className="learn-stars">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{ color: i <= val ? GREEN : 'var(--c-border)' }}>
          {i <= val ? '★' : '☆'}
        </span>
      ))}
    </span>
  );
}

/**
 * importance → 必读角标（≥5「强烈推荐」/ =4「建议优先读」/ 其余不标）。
 * 低频克制：不新造交互，仅复用现有标签色板。
 */
function mustReadTag(importance) {
  const n = Number(importance) || 0;
  if (n >= 5) return <span className="learn-mustread top">强烈推荐</span>;
  if (n === 4) return <span className="learn-mustread high">建议优先读</span>;
  return null;
}

/** 置顶必读区阈值：importance≥4 视为「必读」。 */
function isMustRead(a) {
  return (Number(a && a.importance) || 0) >= 4;
}

/** 生成时间戳 → 「8月20日 15:04」这种好读的样子（方案卡右上角那行小字）。 */
function ocpStamp(t) {
  const n = Number(t);
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 一张主题卡的空方案骨架（未生成 / 失败时的初始态）。
 * 独立成函数而不是内联对象字面量：避免每次渲染都造新引用，让 React 的浅比较有意义。
 */
function emptyOcpPlan() {
  return { text: '', sections: [], checklist: [], error: '', generatedAt: 0 };
}

/**
 * 门诊运营教学面板（0.21.14 · 老板需求 2）。
 *
 * 老板原话：「学习中心那个实操教学改成 门诊运营教学 教牙医和门诊的医生如何去运营自己的诊所……
 *            要有专业的方案，不是每个诊所都一样的那种。」
 *
 * 形态（架构设计 §1.5 / §3.5，已定案）：
 *   · 顶部 5 维诊所画像（规模 / 科室 / 区域 / 客单价带 / 主推服务）——「不是每个诊所都一样」的抓手；
 *     缺项照样能生成，但页面标「依据不完整」、提示词里写「未填写」，绝不编造数字。
 *   · 5 张固定主题卡，顺序固定：traffic → purchase → pricing → price_war → retention。
 *   · 每卡一份「一页方案」：现状判断 / 分步骤 / 可直接说的话 / 容易踩的坑 + 可勾选的验收清单。
 *   · 缓存 douya-ocp-cache 命中就不再调模型（省钱且不抖）；勾选进度 douya-ocp-progress 按企业隔离。
 *
 * ⚠️ P1（下一轮）：接联网检索并在方案顶部强制标来源（实检 N 条 / 未联网 · 模型推断）。
 *    本轮只用模型自身知识，**不标来源也不谎称联网**；那里只改 generateOcpPlan 的取数一步。
 *
 * @param {{companyId:string, companyName:string, chatFn?:Function, chatSlot?:React.ReactNode}} props
 *        chatFn 仅测试注入（默认走 chatOnce），生产不传。
 *        chatSlot —— 由外部插入的「问豆芽」入口 + 对话框（0.21.17 · 老板第 2 条）。
 *        插在**胶囊按钮之后、画像折叠之前**：这样它既是「几个按钮」的正下方，
 *        又保证进入本页签后**第一屏就能看见入口**（不埋在折叠区、不排在 5 张卡下面）。
 *        ⚠️ 学习中心是它目前唯一的调用方；不传就是 null，OcpPanel 行为与本轮之前完全一致。
 */
function OcpPanel({ companyId, companyName, chatFn = chatOnce, chatSlot = null }) {
  const { getKnowledge, updateProfile } = useCompanyKnowledge();

  // getKnowledge 的引用会随 store 内 map 变化而变；用 ref 承接，避免把它放进
  // 「切企业重新读画像」的 effect 依赖里导致每敲一个字就重读一次。
  const getKRef = useRef(getKnowledge);
  getKRef.current = getKnowledge;
  const readStore = useCallback((cid) => getKRef.current(cid), []);

  // ---- 5 维画像 ----
  const [profile, setProfile] = useState(() => loadOcpProfile(companyId, { getKnowledge: readStore }));
  // ---- 每张卡的方案（{ [topicId]: { text, sections, checklist, error, generatedAt } }）----
  const [plans, setPlans] = useState(() => buildPlans(companyId));
  // ---- 每张卡的勾选进度（{ [topicId]: { checked, done } }）----
  const [progress, setProgress] = useState(() => buildProgress(companyId));
  // 正在生成的主题 id（'' = 空闲）；只用一个字符串而不是 5 个布尔，避免状态发散。
  const [busy, setBusy] = useState('');

  /** 读 5 张卡各自的缓存方案。 */
  function buildPlans(cid) {
    const out = {};
    OCP_TOPICS.forEach((t) => {
      const cached = cid ? loadOcpPlan(cid, t.id) : null;
      if (!cached) {
        out[t.id] = emptyOcpPlan();
        return;
      }
      // 只解析一次：sections 是渲染真源，checklist 从 sections 里取，避免两套解析口径。
      const sections = parseOcpSections(cached.text);
      out[t.id] = {
        text: cached.text,
        sections,
        checklist: checklistOf(sections),
        error: '',
        generatedAt: cached.generatedAt,
      };
    });
    return out;
  }

  /** 读 5 张卡各自的勾选进度（按企业隔离，S10）。 */
  function buildProgress(cid) {
    const out = {};
    OCP_TOPICS.forEach((t) => {
      out[t.id] = cid ? loadOcpProgress(cid, t.id) : { checked: [], done: false };
    });
    return out;
  }

  /**
   * 切企业 / 首次挂载：重读画像、缓存与进度。
   * 只依赖 companyId —— 同企业内的编辑由各自的事件处理器同步，不需要这里的 effect 兜底。
   */
  useEffect(() => {
    const stored = loadOcpProfile(companyId, { getKnowledge: readStore });
    // 预填映射（设计 §1.5）：只填空位，不覆盖用户已经填过的维度。
    const sugg = suggestOcpProfile((() => {
      const k = getKRef.current(companyId);
      return k && k.profile ? k.profile : null;
    })());
    const merged = { ...stored };
    OCP_PROFILE_FIELDS.forEach((f) => {
      if (!merged[f.key] && sugg[f.key]) merged[f.key] = sugg[f.key];
    });
    setProfile(merged);
    setPlans(buildPlans(companyId));
    setProgress(buildProgress(companyId));
    setBusy('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  /**
   * 改一维画像：立刻回写 `profile.ocpProfile`（不新增 key），并刷新本页 state。
   * 写库走 store 的 updateProfile，保证与其它模块读到的同一份内存态一致。
   */
  function changeField(key, value) {
    const next = { ...profile, [key]: value };
    setProfile(next);
    saveOcpProfile(companyId, { [key]: value }, { updateProfile });
  }

  /** 生成 / 重新生成某主题方案。失败只写错误态，**绝不往正文塞半截方案**。 */
  async function runGenerate(topicId, force) {
    if (busy) return;
    setBusy(topicId);
    let r = null;
    try {
      r = await generateOcpPlan({
        companyId,
        companyName,
        profile,
        topic: topicId,
        chatFn,
        force,
      });
    } catch {
      r = null;
    }
    setBusy('');
    if (!r || !r.ok) {
      setPlans((prev) => ({ ...prev, [topicId]: { ...emptyOcpPlan(), error: OCP_ERROR_TEXT } }));
      return;
    }
    setPlans((prev) => ({
      ...prev,
      [topicId]: {
        text: r.text,
        sections: r.sections,
        checklist: r.checklist,
        error: '',
        generatedAt: r.generatedAt,
      },
    }));
  }

  /** 勾 / 取消一条验收项（按企业 + 主题隔离写库）。 */
  function toggleCheck(topicId, idx, total) {
    const next = toggleOcpProgress(companyId, topicId, idx, total);
    setProgress((prev) => ({ ...prev, [topicId]: next }));
  }

  const basis = basisOf(profile);

  return (
    <div className="ocp-wrap" data-ocp-compact="1">
      {/* ---------- 【0.21.16 · 老板需求 6】一行话 + 一排按钮 ----------
          老板原话：「门诊运营教学的对话呢？我前面说的那几个问题占比太大了 小一点
                     就是几个按钮点点就行了 重要的还是对话框」

          改前：一句两行长文（牙医会看牙…）+ 5 维画像表单 + 5 张各带「生成方案 + 暂无数据」的大卡，
                整块把对话挤到屏幕外。
          改后：① 标题行压成一行；② 5 个主题变成一排**胶囊按钮**（点一下就直接生成那一项）；
                ③ 画像表单收进折叠（不填也能生成，只是标「依据不完整」）；
                ④ 5 张卡仍在 DOM 里（门禁契约），但默认只有一行标题 + 一个按钮那么高，
                   生成出方案的那张才展开成整行宽。 */}
      <div className="ocp-head">
        <span className="ocp-head-t">门诊经营 5 件事</span>
        <span className="ocp-head-sub">点一个按钮直接出方案；想问别的，下面「问豆芽」里直接说。</span>
      </div>

      <div className="ocp-pills" data-ocp-pills={OCP_TOPICS.length}>
        {OCP_TOPICS.map((t) => {
          const plan = plans[t.id] || emptyOcpPlan();
          return (
            <button
              key={`pill-${t.id}`}
              type="button"
              className={'ocp-pill' + (plan.text ? ' is-done' : '')}
              data-ocp-pill={t.id}
              title={t.desc}
              disabled={!!busy}
              onClick={() => runGenerate(t.id, !!plan.text)}
            >
              {t.short}
              {plan.text ? ' · 已有' : ''}
            </button>
          );
        })}
      </div>

      {/* 【0.21.17 · 老板第 2 条】外部插入的「问豆芽」入口 + 对话框。
          位置刻意放在胶囊**之后**、画像折叠与 5 张卡**之前** —— 理由见函数头 JSDoc。 */}
      {chatSlot}

      {/* ---------- 5 维诊所画像（收进折叠）：填了更贴合，不填也能生成但标「依据不完整」 ---------- */}
      <details className="ocp-profile-fold" data-ocp-profile-fold="1">
        <summary className="ocp-profile-sum">
          诊所情况（选填）· <span data-ocp-basis-fold="1">{basis.label}</span>
        </summary>
        <div className="ocp-profile" data-ocp-profile="1">
          <div className="ocp-profile-hd">
            <div>
              <div className="ocp-profile-title">先说清你这间诊所的情况</div>
              <div className="ocp-profile-sub">
                3 台椅位和 12 台椅位的打法完全不同 —— 这 5 项决定方案贴不贴合你。
              </div>
            </div>
            <span
              className="ocp-basis"
              data-ocp-basis={basis.complete ? 'complete' : 'incomplete'}
              data-ocp-basis-text="1"
            >
              {basis.label}
            </span>
          </div>
          <div className="ocp-fields">
            {OCP_PROFILE_FIELDS.map((f) => (
              <div className="ocp-field" key={f.key}>
                <label className="ocp-field-label" htmlFor={`ocp-f-${f.key}`}>{f.label}</label>
                <Input
                  id={`ocp-f-${f.key}`}
                  size="small"
                  value={profile[f.key] || ''}
                  placeholder={f.placeholder}
                  maxLength={40}
                  data-ocp-field={f.key}
                  onChange={(e) => changeField(f.key, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      </details>

      {/* ---------- 5 张固定主题卡（顺序即渲染顺序，不许变） ----------
          `data-ocp-compact` 让 5 张卡变成「一排小按钮 + 生成后的那张展开成整行」，
          规则写在 styles/round16-learn.css（ocp.css 不在本轮可改范围，故用属性选择器
          `.ocp-topics[data-ocp-compact]` 提高优先级覆盖，不加 !important）。 */}
      <div className="ocp-topics" data-ocp-compact="1">
        {OCP_TOPICS.map((t) => {
          const plan = plans[t.id] || emptyOcpPlan();
          const prog = progress[t.id] || { checked: [], done: false };
          return (
            <div
              className={'ocp-card' + (plan.sections.length > 0 ? ' ocp-card-wide' : '')}
              data-ocp-topic={t.id}
              data-ocp-filled={plan.sections.length > 0 ? '1' : '0'}
              key={t.id}
            >
              <div className="ocp-card-hd">
                <div>
                  <div className="ocp-card-title">{t.title}</div>
                  <div className="ocp-card-desc">{t.desc}</div>
                </div>
                <div className="ocp-card-actions">
                  {plan.generatedAt ? <span className="ocp-stamp">{ocpStamp(plan.generatedAt)}</span> : null}
                  <Button
                    size="small"
                    type={plan.text ? 'default' : 'primary'}
                    loading={busy === t.id}
                    disabled={!!busy && busy !== t.id}
                    data-ocp-generate={t.id}
                    onClick={() => runGenerate(t.id, !!plan.text)}
                  >
                    {plan.text ? '重新生成' : '生成方案'}
                  </Button>
                </div>
              </div>

              {plan.error ? (
                // 错误态：固定一句「方案暂时生成不出来，请稍后再试」，**不放任何方案正文**。
                <div className="ocp-error" data-ocp-error="1">{OCP_ERROR_TEXT}</div>
              ) : plan.sections.length > 0 ? (
                <div className="ocp-body" data-ocp-body={t.id}>
                  {plan.sections.map((sec, i) => (
                    <div
                      className={'ocp-sec' + (sec.kind === 'checklist' ? ' ocp-check-sec' : '')}
                      key={`${t.id}-${sec.kind}-${i}`}
                      data-ocp-section={i}
                      data-ocp-kind={sec.kind}
                    >
                      <div className="ocp-sec-t">{sec.title}</div>
                      {sec.kind === 'checklist' ? (
                        <div className="ocp-checks">
                          {sec.items.map((item, j) => {
                            const on = prog.checked.includes(j);
                            return (
                              <label className={'ocp-check' + (on ? ' ocp-check-on' : '')} key={`c-${j}`} data-ocp-check={j}>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() => toggleCheck(t.id, j, sec.items.length)}
                                />
                                <span>{item}</span>
                              </label>
                            );
                          })}
                          <div className="ocp-check-progress">
                            已勾 {prog.checked.length} / {sec.items.length}
                            {prog.done ? ' · 这件事做完了' : ''}
                          </div>
                        </div>
                      ) : (
                        <ul className="ocp-sec-list">
                          {sec.items.map((item, j) => (
                            <li key={`i-${j}`}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                // 空态：固定四个字，不加解释句（共享知识 S5）。
                <div className="ocp-empty" data-ocp-empty="1">{OCP_EMPTY_TEXT}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function LearningStation({ onSelectModule, ocpChatFn }) {
  const { message } = AntApp.useApp();
  const { currentCompany, currentProject, companyProjects, currentRole } = useCompany();
  const { asset } = useMarketingAsset();
  const { goal } = useMarketingGoal();
  const { getKnowledge } = useCompanyKnowledge();
  const { addAsset } = useAssets();
  const { addDailyTask, listDailyTasks } = useDailyTasks();
  const { sources, addSource, listSources } = useKnowledgeSources();
  const { addArticle, updateArticle, removeArticle, addSampleArticles, listArticles } = useKnowledgeArticles();
  const { setLearningStatus, listMyLearning } = useMyLearning();

  const companyType = currentCompany?.type || 'manufacturer';
  const companyId = currentCompany?.id || '';
  // 门诊运营教学的「诊所名称」：优先当前企业名，其次资产库里的公司名（缺省时提示词写「未填写」）。
  const companyNameForOcp = String(
    (currentCompany && currentCompany.name) || (asset && asset.companyName) || '',
  ).trim();
  const role = currentRole || 'operator';
  // 企业类型已扩到 4 种（manufacturer/clinic/doctor/platform），而学习站内容数据仍是
  // clinic/manufacturer 两套口径。这里折叠一次，保证 doctor / platform 企业也能命中课程与推荐。
  const contentCompanyType = learningCompanyType(companyType);
  const learningRole = resolveLearningRole(companyType, role);
  const knowledge = getKnowledge(companyId);
  const goalLabel = goal?.label || '';
  const ctx = { company: currentCompany, asset, knowledge, goalLabel };

  const allArticles = useMemo(() => listArticles(), [listArticles]);
  const sourcesList = useMemo(() => listSources(), [listSources]);

  // ---- 首次加载播种 30 个精选信息源（一次性） ----
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (sources.length === 0) {
      SEED_SOURCES.forEach((s) => addSource(s));
      seededRef.current = true;
    }
  }, [sources.length, addSource]);

  // ---- 第十五轮（2026-10-15）：原 Tab 1「今日学习」整块删除（老板要求），
  //      其专属 state / 抓取兜底 / AI 挑选逻辑一并移除，不留死代码。 ----

  // ---- 行业资讯 ----
  const [fetchBusy, setFetchBusy] = useState(false);
  const [fetchResult, setFetchResult] = useState(null); // 抓取结果摘要 { added, skipped }
  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addCategory, setAddCategory] = useState(undefined);
  const [addContent, setAddContent] = useState('');
  const [addSaving, setAddSaving] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState('all');
  // 【老板第 5 条】行业资讯的页码（1-based）。越界夹回见下方 useEffect。
  const [feedPage, setFeedPage] = useState(1);
  // 【老板第 5 条】「我的学习」三个分组**各自**独立页码：`{ learning: 2, done: 1 }`。
  // 用一个对象而不是三个 useState：分组是 `renderGroup(statusKey)` 循环渲染出来的，
  // 在循环里吊 hooks 会违反 hooks 规则，用对象存才能做到「组内独立、互不干扰」。
  const [groupPages, setGroupPages] = useState({});

  function openAddModal() {
    setAddTitle('');
    setAddUrl('');
    setAddCategory(undefined);
    setAddContent('');
    setAddOpen(true);
  }

  /**
   * 抓取资讯（两级兜底）：本地 RSS 优先，不足再 AI 联网补足。
   *
   * 【0.21.16 · 老板需求 6】第一级的两处收口（改前 → 改后）：
   *   ① 挑源：`pickSources(…, 10)`（10 个源，含 AI/营销号）→ `pickLearningSources(…, 5)`
   *      （口腔文献层排最前、门诊视角剔除通用 AI/营销号）；
   *   ② 条数：`perSource: 6`（10×6=60 条）→ `perSource: LEARN_PER_SOURCE`（5×4=20 条）；
   *   ③ 新增一道**相关性闸门** `judgeDentalRelevance`：抓回来的条目先让 AI 判断
   *      「值不值得推荐给口腔门诊」，不合格的剔除；AI 不可用时退回关键词白名单规则。
   *      ⚠️ 这道闸门**永不把结果清空**，也**永不谎报**（返回的 mode 如实进 UI 提示）。
   *
   * 【0.21.16 · 老板第 1 条】再加一级、并且排在**最前面**：
   *   0️⃣ 中华医学期刊网的当期目录（`crawlJournalSources`）—— 老板原话「优先中华医学期刊口腔文献」。
   *      它走的是「目录页解析」而不是 RSS，所以单独一级；抓到的条目同样过 `judgeDentalRelevance`
   *      （文献层白名单，不会被关键词误杀）。**抓不到就如实进 `journalFailed` 上报**，
   *      绝不当成「今天没有新文献」——那是上一轮学习中心的红线。
   *
   * @param {number} [targetCount=10] 期望补足的条数（只影响第二级 AI 补足的请求量）
   * @returns {Promise<{addedArticles:Array, localAdded:number, aiAdded:number, skipped:number,
   *                    judgeMode:'ai'|'rule'|'', judgeDropped:number,
   *                    journalAdded:number, journalTotal:number, journalFailed:Array<{name:string,error:string}>,
   *                    rssAdded:number, rssTotal:number, rssFailed:Array<{name:string,error:string}>,
   *                    rssError:string}>}
   */
  async function crawlNews(targetCount = 10) {
    const addedArticles = [];
    let localAdded = 0;
    let aiAdded = 0;
    let skipped = 0;
    // 相关性判断方式 / 被剔掉的条数 —— 只为把真实发生的事显示出来
    let judgeMode = '';
    let judgeDropped = 0;
    // 期刊目录这一级的结果（成功几条 / 失败原因），UI 与提示语都要如实显示
    let journalAdded = 0;
    let journalFailed = [];
    // 【0.21.27 · 老板「是不是根本爬不到内容」】RSS 这一级的失败**必须收**：
    // 改前只解构 `{ items }`，`failed` 被整个丢掉 ⇒ 5 个源全挂时界面一个字都不提，
    // 最后统一落到「这次抓到的都是已有资讯，没有新增」（把全挂读成了没新内容）。
    let rssAdded = 0;
    let rssTotal = 0;
    let rssFailed = [];
    let rssError = '';
    const journalTotal = JOURNAL_SOURCES.filter((s) => s && String(s.entry || '').trim()).length;

    const existing = listArticles();
    const seen = new Set(existing.map((a) => normalizeTitle(a.title)));
    const seenUrl = new Set(existing.map((a) => (a.url ? String(a.url).trim() : '')).filter(Boolean));
    const pushArticle = (n) => {
      const norm = normalizeTitle(n.title);
      if (seen.has(norm) || (n.url && seenUrl.has(n.url))) {
        skipped += 1;
        return null;
      }
      seen.add(norm);
      if (n.url) seenUrl.add(n.url);
      return addArticle({
        title: n.title,
        url: n.url || '',
        // 0.21.11 第 4 条：文章自带配图（RSS 条目里的 media:thumbnail / image enclosure 等）
        image: n.image || '',
        category: n.category || '',
        summary_long: n.summary_long || n.summaryLong || '',
        why_important: n.why_important || '',
        target_roles: n.targetRoles || [],
        target_company_types: n.targetCompanyTypes || [],
        importance: n.importance || 3,
        author: n.author || n.source || '',
        source_id: n.source_id || '',
        country: n.country || '',
        published_at: n.published_at || n.publishedAt || new Date().toISOString(),
      });
    };

    // 第 0 级（最高优先级）：中华医学期刊网当期目录 —— 老板「优先中华医学期刊口腔文献」。
    // 单独 try：期刊站挂了不能连累后面的 RSS 与 AI 兜底，但**失败必须上报**（进 journalFailed）。
    try {
      const jr = await crawlJournalSources(JOURNAL_SOURCES, { perSource: LEARN_PER_SOURCE });
      journalFailed = Array.isArray(jr.failed) ? jr.failed : [];
      if (jr.items.length > 0) {
        // 与 RSS 条目走**同一道**相关性闸门（不另造一套判据）
        const gate = await judgeDentalRelevance(jr.items, { chatFn: chatOnce });
        judgeMode = gate.mode;
        judgeDropped += gate.dropped;
        const before = seen.size;
        sortJournalFirst(gate.items).forEach((it) => {
          const a = pushArticle(it);
          if (a) addedArticles.push(a);
        });
        journalAdded = seen.size - before;
      }
    } catch (e) {
      journalFailed = [{ name: '中华医学期刊网', error: (e && e.message) || '抓取异常' }];
    }

    // 第一级：本地 RSS 抓取（不走 AI，真实来源、零成本）
    try {
      const sources = pickLearningSources(companyType, role, LEARN_SOURCE_LIMIT);
      rssTotal = sources.length;
      if (sources.length > 0) {
        const { items, failed } = await crawlSources(sources, {
          perSource: LEARN_PER_SOURCE,
          concurrency: 4,
        });
        // 【诚实红线】逐个源的失败要留着：抓通几个、哪几个没通，UI 必须说得出来
        rssFailed = Array.isArray(failed) ? failed : [];
        // 相关性闸门：AI 先判，AI 不可用退回规则（永不空屏、永不谎报）
        const gate = await judgeDentalRelevance(items, { chatFn: chatOnce });
        judgeMode = gate.mode;
        judgeDropped += gate.dropped;
        const before = seen.size;
        gate.items.forEach((it) => {
          const a = pushArticle(it);
          if (a) addedArticles.push(a);
        });
        rssAdded = seen.size - before;
      }
    } catch (e) {
      // 【诚实红线】整级异常同样要记账 —— 改前这里只有一句注释，等于把「抓取挂了」静默吞掉
      rssError = (e && e.message) || 'RSS 抓取异常';
      rssFailed = [{ name: '本地 RSS 抓取', error: rssError }];
    }
    // 「本地抓取」= 期刊目录 + RSS 两级之和（两者都不花 AI 的钱，都是真实来源）
    localAdded = journalAdded + rssAdded;

    // 第二级：本地不足阈值，AI 联网补足
    if (localAdded < 5) {
      const news = await genFetchIndustryNews({
        ...ctx,
        project: currentProject,
        role: learningRole,
        companyType,
        goalLabel,
        count: Math.max(4, targetCount - localAdded),
      });
      if (news && news.length) {
        const before = seen.size;
        news.forEach((n) => {
          const a = pushArticle({
            title: n.title,
            url: n.url || '',
            category: n.category || '',
            summary_long: n.summaryLong || '',
            why_important: n.whyImportant || '',
            target_roles: n.targetRoles || [],
            target_company_types: n.targetCompanyTypes || [],
            importance: n.importance || 3,
            author: n.source || '',
            published_at: n.publishedAt || new Date().toISOString(),
          });
          if (a) addedArticles.push(a);
        });
        aiAdded = seen.size - before;
      }
    }

    return {
      addedArticles,
      localAdded,
      aiAdded,
      skipped,
      judgeMode,
      judgeDropped,
      journalAdded,
      journalTotal,
      journalFailed,
      rssAdded,
      rssTotal,
      rssFailed,
      rssError,
    };
  }

  /**
   * 抓取今日资讯：本地 RSS 优先（快、真实、免费），不足 5 条再用 AI 联网补足到 10 条。
   *
   * 【0.21.27 · 老板「是不是根本爬不到内容」】三态如实报（全部失败 / 部分失败 / 真的没有新增）：
   * 文案统一由 `services/learnFetchReport.js` 生成，本函数只负责把结果落进 state 并弹出来。
   * 改前「一条没抓到」不分青红皂白就说「这次抓到的都是已有资讯，没有新增」——
   * 那是把「5 个源 + 期刊目录 + AI 兜底全挂」读成「今天没有新内容」，属于**说假话**。
   */
  async function fetchIndustryNews() {
    if (fetchBusy) return;
    setFetchBusy(true);
    setFetchResult(null);
    try {
      const raw = await crawlNews(10);
      const payload = {
        added: (raw.localAdded || 0) + (raw.aiAdded || 0),
        localAdded: raw.localAdded || 0,
        aiAdded: raw.aiAdded || 0,
        skipped: raw.skipped || 0,
        judgeMode: raw.judgeMode || '',
        judgeDropped: raw.judgeDropped || 0,
        journalAdded: raw.journalAdded || 0,
        journalTotal: raw.journalTotal || 0,
        journalFailed: Array.isArray(raw.journalFailed) ? raw.journalFailed : [],
        rssAdded: raw.rssAdded || 0,
        rssTotal: raw.rssTotal || 0,
        rssFailed: Array.isArray(raw.rssFailed) ? raw.rssFailed : [],
        rssError: raw.rssError || '',
      };
      setFetchResult(payload);
      const notice = describeFetchNotice(payload);
      if (notice.text) {
        if (notice.level === 'success') message.success(notice.text);
        else if (notice.level === 'warning') message.warning(notice.text);
        else message.info(notice.text);
      }
      // 明细单独一条：哪几个源没通、为什么没通（中文源名，不印内部 id）
      if (notice.level !== 'success' && notice.detail) message.warning(notice.detail);
    } finally {
      setFetchBusy(false);
    }
  }

  // ---- 【0.21.27】进页面自动抓一次 ----
  // 改前：首屏直接吃 `SEED_ARTICLES`（6 条 url 为空的假资讯），抓取只能靠用户去点那个按钮。
  // 现在：本地已有「带原文链接」的真实文章 ⇒ 不动；否则挂载后自动跑一次抓取。
  // 只跑一次（`autoFetchedRef`）—— `hasRealArticle` 会随抓取结果变化，进依赖数组会变成循环抓取。
  const autoFetchedRef = useRef(false);
  const hasRealArticle = allArticles.some((a) => /^https?:\/\//i.test(String(a.url || '')));
  useEffect(() => {
    if (autoFetchedRef.current) return;
    autoFetchedRef.current = true;
    if (hasRealArticle) return;
    fetchIndustryNews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 空态里的「看看示例」：用户主动点了才写内置示例（带 is_sample 标，卡片会标「示例内容，非实时资讯」）。 */
  function showSampleArticles() {
    const n = addSampleArticles();
    if (n > 0) message.info(`已放入 ${n} 条示例内容（不是实时资讯），点「抓取今日资讯」才会去抓真实内容`);
    else message.info('示例内容已经在列表里了');
  }

  /** 删除一条资讯（本地列表，不影响源站）。 */
  function deleteArticle(a) {
    if (!a) return;
    removeArticle(a.id);
    message.success('已从列表删除（源站内容不受影响）');
  }

  /** 抓取结果的三态文案（纯函数，见 services/learnFetchReport.js）；没抓过就是 null。 */
  const fetchNotice = useMemo(() => (fetchResult ? describeFetchNotice(fetchResult) : null), [fetchResult]);

  async function submitAddArticle() {
    const title = addTitle.trim();
    if (!title) {
      message.warning('请填写资讯标题');
      return;
    }
    const url = addUrl.trim();
    const norm = normalizeTitle(title);
    const dup = listArticles().some(
      (a) => normalizeTitle(a.title) === norm || (url && a.url && String(a.url).trim() === url),
    );
    if (dup) {
      message.warning('该资讯已存在');
      return;
    }
    const article = addArticle({
      title,
      url,
      category: addCategory || '',
      content: addContent.trim() || null,
      published_at: new Date().toISOString(),
    });

    if (addContent.trim()) {
      setAddSaving(true);
      try {
        const summary = await genArticleSummary({ company: currentCompany, asset, knowledge, article });
        if (summary) {
          updateArticle(article.id, {
            summary: summary.oneLine || '',
            summary_long: summary.summaryLong || '',
            why_important: summary.whyImportant || '',
            target_roles: summary.targetRoles || [],
            target_company_types: summary.targetCompanyTypes || [],
            importance: Number(summary.importance) || 3,
          });
          message.success('已添加资讯并生成 AI 摘要');
        } else {
          message.warning('已添加资讯，但 AI 摘要生成失败，已保留原文');
        }
      } finally {
        setAddSaving(false);
      }
    } else {
      message.success('已添加资讯');
    }
    setAddOpen(false);
  }

  const filteredArticles = useMemo(() => {
    return allArticles.filter((a) => {
      if (categoryFilter !== 'all' && a.category !== categoryFilter) return false;
      if (timeFilter !== 'all' && timeBucket(a) !== timeFilter) return false;
      return true;
    });
  }, [allArticles, categoryFilter, timeFilter]);

  // ---- 【老板第 5 条】行业资讯分页 ----
  // 只切「当前页那几条」交给渲染，`learn-grid` 的列数一个字不动：分页只减条数，不改网格。
  const feedPageCount = Math.max(1, Math.ceil(filteredArticles.length / LEARN_PAGE_SIZE));
  // 读的时候先夹一次，别等 useEffect：否则数据变少的那一帧会先渲染出空白再被纠正（闪一下）。
  const feedPageSafe = Math.min(feedPage, feedPageCount);
  const pagedArticles = useMemo(() => {
    const start = (feedPageSafe - 1) * LEARN_PAGE_SIZE;
    return filteredArticles.slice(start, start + LEARN_PAGE_SIZE);
  }, [filteredArticles, feedPageSafe]);

  /**
   * 页码越界夹回。
   *
   * 为什么必须守这一道、不能只在筛选回调里 `setFeedPage(1)`：
   * 条数变化有**两条**来源 ——
   *   ① 用户点筛选/切时间段（回调里已经回第 1 页）；
   *   ② 「抓取今日资讯」异步补数据、手动添加、或文章被删（**不经过任何筛选回调**）。
   * 只守住 ① 的话，用户停在第 5 页时数据掉到 2 条，就会看到一片空白，
   * 而且这一页**不会自己恢复**——用户只会当成 bug 报上来。所以条数一变就校一次页码。
   */
  useEffect(() => {
    if (feedPage !== feedPageSafe) setFeedPage(feedPageSafe);
  }, [feedPage, feedPageSafe]);

  // ---- 第十五轮：原 Tab「为你推荐」整块删除（老板要求），aiRec / runAIRecommend /
  //      recommended / roleSections 一并移除；必读置顶区（mustRead）被「行业资讯」复用，保留。 ----

  // ---- 必读置顶区：importance≥4 且命中当前角色 / 企业类型，最多 3 篇（不足则不显示）----
  const mustRead = useMemo(() => {
    return allArticles
      .filter(isMustRead)
      .filter(
        (a) =>
          (a.target_roles || []).includes(learningRole) ||
          (a.target_company_types || []).includes(contentCompanyType),
      )
      .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
      .slice(0, 3);
  }, [allArticles, learningRole, contentCompanyType]);

  // ---- Tab 4：我的学习 ----
  const myLearning = useMemo(() => listMyLearning(companyId), [listMyLearning, companyId]);
  const learningMap = useMemo(() => {
    const m = {};
    myLearning.forEach((x) => {
      m[x.articleId] = x.status;
    });
    return m;
  }, [myLearning]);
  const learnedArticles = useMemo(() => {
    return myLearning
      .map((x) => ({ article: allArticles.find((a) => a.id === x.articleId), status: x.status }))
      .filter((x) => x.article);
  }, [myLearning, allArticles]);

  // ---- 右栏「我的学习」统计（设计系统 v3 同款，真实口径：加入 / 学完 / 稍后再看）----
  const learnStats = useMemo(() => ({
    total: myLearning.length,
    done: myLearning.filter((x) => x.status === 'done').length,
    later: myLearning.filter((x) => x.status === 'later').length,
  }), [myLearning]);

  // 右栏「记录 ›」跳转「我的学习」页签用（Tabs 受控化）
  const [learnTab, setLearnTab] = useState('feed');

  // 【0.21.28】当前主题（'light' | 'dark'，绿色主题已下线），只用来给「示例内容」标签选字色。
  // 必须在组件顶层调用一次：`renderArticleCard` 是逐篇文章调用的普通函数，
  // 在它里面调 Hook 会让 Hook 顺序随文章数变化（React 的 Hook 规则不允许）。
  const learnTheme = useTheme();

  // 【0.21.17 · 老板第 2 条】「问豆芽」对话框展开状态。
  // 默认**收起**（老板抱怨过原来那块「那么大一个」），但入口按钮常驻可见 ⇒ 不是「找不到」。
  // 收起只是不挂载 ActivityChat：会话正文与后台任务都在 store/localStorage 里（组件头注释 §1/§2），
  // 展开时读回来的就是同一段对话，不会因为收起而丢。
  const [askOpen, setAskOpen] = useState(false);

  // 【0.21.28】运营 SOP 卡片的展开状态：`{ [tutId]: true }`。
  // ⚠️ 故意**不落 localStorage**：这是「浏览态」（现在在看哪一篇），不是学习进度。
  //    进度只有一处真源 —— OCP 的 `toggleOcpProgress`（按 companyId 隔离，见 ocpPlan.js）。
  //    两套状态都叫「学习」，混进同一张表会让「换企业进度不串」那条企业隔离判据失效。
  const [tutOpen, setTutOpen] = useState({});

  // ---- AI 解读弹窗 ----
  const [interpretOpen, setInterpretOpen] = useState(false);
  const [interpretLoading, setInterpretLoading] = useState(false);
  const [interpretMarkdown, setInterpretMarkdown] = useState('');
  const [interpretTitle, setInterpretTitle] = useState('');

  // ---- 「帮我看懂」通俗解读（存回 article.interpretation，卡片内展开，不弹窗）----
  const [plainBusyId, setPlainBusyId] = useState(null);

  async function doPlainInterpret(a) {
    if (!a || plainBusyId) return;
    setPlainBusyId(a.id);
    try {
      const result = await genPlainInterpret({
        ...ctx,
        companyType,
        role,
        article: a,
      });
      if (result) {
        updateArticle(a.id, { interpretation: JSON.stringify(result) });
      } else {
        message.error('AI 解读失败，请重试');
      }
    } finally {
      setPlainBusyId(null);
    }
  }

  /** 解析卡片缓存的通俗解读 JSON。 */
  function plainInterp(a) {
    if (!a || !a.interpretation) return null;
    try {
      const o = JSON.parse(a.interpretation);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }

  // ---- 【0.21.16 · 老板需求 6】原「实操教学 checklist 勾选进度」一整套已删 ----
  // 老板要求把「原来的实操清单（N 篇）· 想看细节点这里」这块删掉，勾选进度只服务那一块，
  // 一并不留（`douya-tutorial-progress` 这个 localStorage 键从此不再读写；老机器上残留的
  // 旧值不会报错、也不会被任何地方读到 —— 不主动清，避免顺手删掉用户数据）。

  function openInterpret(a) {
    setInterpretTitle(a.title);
    setInterpretMarkdown('');
    setInterpretLoading(true);
    setInterpretOpen(true);
    (async () => {
      const result = await genArticleInterpret({
        ...ctx,
        project: currentProject,
        role: learningRole,
        companyType,
        article: a,
      });
      if (result) {
        const parts = [
          `**这是什么**：${result.what || '—'}`,
          `**为什么值得关注**：${result.why || '—'}`,
          `**对你的影响**：${result.impact || '—'}`,
          `**你可以怎么做**：${result.action || '—'}`,
          result.next && result.next.length
            ? `**继续学习**：\n${result.next.map((n) => `- ${n}`).join('\n')}`
            : '',
        ];
        setInterpretMarkdown(parts.filter(Boolean).join('\n\n'));
      } else {
        setInterpretMarkdown('');
        message.error('AI 解读失败，请重试');
      }
      setInterpretLoading(false);
    })();
  }

  // ---- 【0.21.11 · 老板第 4 条】文章二级页 ----
  // 原话：「这个缩略起来 点击后进入文章二级页 二级页再显示 原文 翻译 还有AI解读」。
  //
  // 为什么做成页内二级页、而不是再开一个 Modal：正文要能长距离滚动去读，翻译和解读
  // 还要能来回切；640px 宽的弹窗里读长文是折磨，而且和「缩略列表」的层级分不出来。
  //
  // 注意这里**不是**按路由跳转（本仓没有路由）：用 detailArticle 这一个 state 切换，
  // 返回时列表的筛选 / 页签 / 滚动位置都还在，读者不会"回去以后找不到刚才那篇"。
  const [detailArticle, setDetailArticle] = useState(null);
  const [detailTab, setDetailTab] = useState('original');
  const [trBusy, setTrBusy] = useState(false);
  const [trResult, setTrResult] = useState(null); // {sameLang} | {failed:true} | {title_zh,body_zh,note}
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState(null); // {what,why,impact,action,next}

  function openDetail(a) {
    if (!a) return;
    setDetailArticle(a);
    setDetailTab('original');
    setTrResult(null);
    setAiResult(null);
    setTrBusy(false);
    setAiBusy(false);
  }

  function closeDetail() {
    setDetailArticle(null);
    setTrResult(null);
    setAiResult(null);
    setTrBusy(false);
    setAiBusy(false);
  }

  /** 翻译：中文原文由 genArticleTranslate 直接返回 { sameLang:true }，不烧模型。 */
  async function loadDetailTranslate() {
    const a = detailArticle;
    if (!a || trBusy) return;
    setTrBusy(true);
    try {
      const r = await genArticleTranslate({ ...ctx, article: a });
      // 失败别静默：返回 null 时记成 failed，页面给「重试一次」，而不是永远转圈
      setTrResult(r || { failed: true });
    } catch {
      setTrResult({ failed: true });
    } finally {
      setTrBusy(false);
    }
  }

  /** AI 解读：复用详情页已有的 genArticleInterpret（五段结构），结果只留在本页。 */
  async function loadDetailAI() {
    const a = detailArticle;
    if (!a || aiBusy) return;
    setAiBusy(true);
    try {
      const r = await genArticleInterpret({
        ...ctx,
        project: currentProject,
        role: learningRole,
        companyType,
        article: a,
      });
      if (r) setAiResult(r);
      else message.error('AI 解读失败，请重试');
    } catch {
      message.error('AI 解读失败，请重试');
    } finally {
      setAiBusy(false);
    }
  }

  // ---- 加入项目弹窗 ----
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectArticle, setProjectArticle] = useState(null);
  const [projectModalProjectId, setProjectModalProjectId] = useState(null);

  function openProjectModal(a) {
    setProjectArticle(a);
    setProjectModalProjectId(null);
    setProjectModalOpen(true);
  }

  function confirmAddToProject() {
    const a = projectArticle;
    if (!a) return;
    if (!companyId) {
      message.warning('当前无企业上下文，无法保存');
      return;
    }
    addAsset({
      type: 'reference',
      companyId,
      projectId: projectModalProjectId || null,
      name: a.title,
      content: a.summary_long || a.summary || '',
      tags: a.category ? [a.category] : [],
      metadata: {
        source_url: a.url || '',
        source_id: a.source_id || '',
        category: a.category || '',
      },
    });
    message.success('已加入项目资料');
    setProjectModalOpen(false);
  }

  // ---- 通用操作 ----
  function joinLearning(a) {
    if (!companyId) {
      message.warning('当前无企业上下文');
      return;
    }
    setLearningStatus(a.id, companyId, 'learning');
    message.success('已加入学习');
  }

  function toTodayContent(a) {
    if (!companyId) {
      message.warning('当前无企业上下文');
      return;
    }
    addDailyTask({
      companyId,
      type: 'article',
      title: a.title,
      content: a.summary_long || a.summary || '',
      channel: '公众号',
    });
    message.success('已加入今日任务');
    if (onSelectModule) onSelectModule('daily');
  }

  function statusSwitcher(a) {
    const current = learningMap[a.id] || 'learning';
    return (
      <Space size={6} wrap>
        <Segmented
          size="small"
          value={current}
          options={[
            { label: '学习中', value: 'learning' },
            { label: '已学完', value: 'done' },
            { label: '稍后看', value: 'later' },
          ]}
          onChange={(v) => {
            setLearningStatus(a.id, companyId, v);
            message.success('已更新学习状态');
          }}
        />
        <Button
          size="small"
          onClick={() => {
            setLearningStatus(a.id, companyId, null);
            message.success('已移除');
          }}
        >
          移除
        </Button>
      </Space>
    );
  }

  // ---- 统一内容卡片（行业资讯 / 为你推荐 / 我的学习 复用） ----
  function renderArticleCard(a, extraActions = null, recReason = null) {
    const source = sourcesList.find((s) => s.id === a.source_id);
    const sourceName = (source && source.name) || a.author || '未知来源';
    const sourceLevel = source ? SOURCE_LEVELS[source.source_level] : null;
    // 【0.21.16 · 老板需求 6】按源 id 反查它属于哪一层，给卡片打「口腔文献 / 专业媒体」标，
    // 让老板一眼看出「这条是文献还是杂资讯」。反查而不落库：source_tier 存不进 article
    // （knowledgeStore.normalizeArticle 是白名单，本轮不改 store）。
    const sourceTier = LEARN_TIER_LABELS[sourceTierOf(a.source_id)] || '';
    const summaryLong = a.summary_long || a.summary || '';
    const targets = Array.from(new Set((a.target_roles || []).map(roleLabel)));
    const comps = Array.from(new Set((a.target_company_types || []).map(companyTypeLabel)));
    const hasTargets = targets.length > 0 || comps.length > 0;
    const interp = a.kind === 'tutorial' ? null : plainInterp(a);
    const interpBusy = plainBusyId === a.id;

    return (
      <div className="learn-card learn-card-media" key={a.id}>
        {/* 封面图：老板第 7 条「最好带图片」+ 0.21.11 第 4 条「图片要获取那篇文章的图片」。
            取图优先级与裂图回退都在 ArticleCover 里；固定 16:9 缩略，长图不会把卡撑高。 */}
        <ArticleCover article={a} />
        <div className="learn-card-bd">
          {recReason ? (
            <div className="learn-rec-reason" style={{ background: GREEN_BG, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
              <span style={{ color: GREEN_DARK, fontWeight: 700 }}>为什么推荐给你：</span>
              <span style={{ color: 'var(--c-text)' }}>{recReason}</span>
            </div>
          ) : null}

          {/* 一行：分类小标签 + 来源（12px 灰） */}
          <div className="learn-meta">
            {a.category ? (
              <span className="learn-tag">
                {categoryLabel(a.category)}
                {a.sub_category ? ` · ${a.sub_category}` : ''}
              </span>
            ) : null}
            <span>{sourceName}</span>
            {a.published_at ? <span>· {formatDate(a.published_at)}</span> : null}
            {sourceTier ? (
              <span className={'learn-tag tier' + (sourceTier === '口腔文献' ? ' is-lit' : '')} data-learn-tier={sourceTier}>
                {sourceTier}
              </span>
            ) : null}
            {sourceLevel ? <span className="learn-tag muted">{sourceLevel.label}</span> : null}
            {/* 【0.21.27】示例内容必须**显著**标出来：它不是实时资讯，也没有原文链接。
                没有这一条时，用户会把内置示例当成「今天抓到的内容」—— 正是老板说的「内容十分糟糕」。
                【0.21.28】字色改走 `SAMPLE_TAG_INK[learnTheme]`：白色主题沿用
                `var(--c-warn)`(#9a6a00) 压 `var(--c-warn-tint)`(#fbf3e3) 只有 **4.29:1**，
                低于 WCAG AA 正文 4.5:1 ⇒ 11.5px 的小字看不清。light → #7a5b00 = **5.73:1**。
                实算过程、以及「原绿主题那 3.87:1 为何随绿色主题下线一起作废」都写在
                `SAMPLE_TAG_INK` 上方的注释里。
                ⚠️ 别改成裸 `'#7a5b00'`：深棕压深色主题的底只有 1.77:1。 */}
            {a.is_sample ? (
              <span
                className="learn-tag sample"
                data-learn-sample="1"
                style={{ color: SAMPLE_TAG_INK[learnTheme] || SAMPLE_TAG_INK.light, borderColor: '#f0c987', background: 'var(--c-warn-tint)' }}
              >
                示例内容，非实时资讯
              </span>
            ) : null}
          </div>

          {/* 标题：2 行截断（16px / 600）。
              【0.21.11 · 老板第 4 条】改前是 <a target="_blank"> 直接跳源站；
              现在是**进页内二级页**（原文 / 翻译 / AI解读），源站链接挪到二级页右上。
              为什么用 span role="link" 而不是 <button>：这本来就是「跳转」语义，
              而且首屏按钮棘轮 learn=39，把标题改成 button 会把首屏按钮数凭空顶高
              （为压数字再把 button 改回 div 就属欺骗门禁，见 unit-firstscreen.mjs 顶部纪律）。 */}
          <div className="learn-title-row">
            <div className="learn-title">
              <span
                className="learn-title-link"
                role="link"
                tabIndex={0}
                data-learn-open={a.id}
                onClick={() => openDetail(a)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDetail(a);
                  }
                }}
              >
                {a.title}
              </span>
            </div>
            {mustReadTag(a.importance)}
          </div>

          {/* 摘要：3 行截断（13px / 行高 1.7） */}
          {summaryLong ? <div className="learn-summary">{summaryLong}</div> : null}

          {a.why_important ? (
            <div className="learn-why" style={{ background: GREEN_BG }}>
              <span style={{ color: GREEN_DARK, fontWeight: 700 }}>为什么值得看：</span>
              {a.why_important}
            </div>
          ) : null}

          {hasTargets ? (
            <div className="learn-fit">
              适合谁：
              {targets.length > 0 ? <span>{targets.join('、')}</span> : null}
              {targets.length > 0 && comps.length > 0 ? <span> · </span> : null}
              {comps.length > 0 ? <span>{comps.join('、')}</span> : null}
            </div>
          ) : null}

          {/* 底部一行：推荐指数 + 读全文（高频动作常驻）。
              【0.21.11 · 老板第 4 条】按钮从「查看原文」改成「读全文」→ 进页内二级页；
              源站外链保留在二级页右上角，仍然一键可达，只是不再让读者一出卡片就跳走。 */}
          <div className="learn-foot">
            <div className="learn-importance">
              <span className="learn-importance-label" style={{ color: FAINT }}>
                推荐指数
              </span>
              {renderStars(a.importance)}
            </div>
            {/* 【0.21.27】示例内容没有原文：不给「读全文」（点进去只会看到「这篇没抓到正文」）。
                真实资讯照旧给「读全文」→ 页内二级页。 */}
            {a.is_sample ? (
              <span className="learn-sample-note" style={{ color: FAINT, fontSize: 12.5 }}>
                示例内容 · 无原文链接
              </span>
            ) : (
              <Button size="small" onClick={() => openDetail(a)}>
                读全文
              </Button>
            )}
          </div>

          {/* 其余动作一个不丢，收进「更多」里（<details>，无需 JS 状态）。
              展开前只露 2 个高频动作（解读类），展开后是加入学习/项目/做内容。
              为什么要收起来：一张卡 6 个按钮并排时，卡片高度被按钮撑满，
              正文反而看不见 —— 这是老板说"排版乱"的一个直接来源。 */}
          <details className="learn-more">
            <summary className="learn-more-sum">更多操作</summary>
            <Space wrap size={8} className="learn-actions">
              <Button size="small" onClick={() => openInterpret(a)}>
                让AI帮我解读
              </Button>
              {a.kind !== 'tutorial' ? (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  loading={interpBusy}
                  onClick={() => (interp ? null : doPlainInterpret(a))}
                >
                  {interp ? '✓ 已看懂' : '🧐 帮我看懂'}
                </Button>
              ) : null}
              <Button size="small" onClick={() => joinLearning(a)}>
                加入学习
              </Button>
              <Button size="small" onClick={() => openProjectModal(a)}>
                加入项目
              </Button>
              <Button size="small" onClick={() => toTodayContent(a)}>
                用这个做今天内容
              </Button>
              {/* 【0.21.27】补上「删除」入口：`removeArticle` 早就写在 store 里，但全仓没有一个 UI 调用
                  ⇒ 文章（包括以前自动灌进来的内置示例）只增不减，用户删不掉。
                  用 <span role="link"> 而不是 <Button>：本页首屏有按钮棘轮（unit-firstscreen），
                  这里只是一次低优先级的破坏性操作，与标题「进二级页」同一形态。 */}
              <span
                role="link"
                tabIndex={0}
                className="learn-del"
                data-learn-delete={a.id}
                style={{ color: 'var(--c-danger)', cursor: 'pointer', fontSize: 13, userSelect: 'none' }}
                onClick={() => deleteArticle(a)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    deleteArticle(a);
                  }
                }}
              >
                删除这条
              </span>
              {extraActions}
            </Space>
          </details>

          {interp ? (
            <div className="learn-plain" style={{ background: GREEN_BG, borderRadius: 10, padding: 12, marginTop: 10 }}>
              {interp.plain ? (
                <div className="learn-plain-row">
                  <span className="learn-plain-k" style={{ color: GREEN_DARK, fontWeight: 700 }}>大白话</span>
                  <span className="learn-plain-v">{interp.plain}</span>
                </div>
              ) : null}
              {interp.analogy ? (
                <div className="learn-plain-row">
                  <span className="learn-plain-k" style={{ color: GREEN_DARK, fontWeight: 700 }}>一句话类比</span>
                  <span className="learn-plain-v">{interp.analogy}</span>
                </div>
              ) : null}
              {interp.soWhat ? (
                <div className="learn-plain-row">
                  <span className="learn-plain-k" style={{ color: GREEN_DARK, fontWeight: 700 }}>对我意味着什么</span>
                  <span className="learn-plain-v">{interp.soWhat}</span>
                </div>
              ) : null}
              {interp.todo && interp.todo.length > 0 ? (
                <div className="learn-plain-row">
                  <span className="learn-plain-k" style={{ color: GREEN_DARK, fontWeight: 700 }}>今天可以做</span>
                  <div className="learn-plain-todos">
                    {interp.todo.map((t, i) => (
                      <div className="learn-plain-todo" key={i}>
                        <span>· {t.action}</span>
                        {t.output ? <span className="learn-plain-output" style={{ color: FAINT }}>（产出：{t.output}）</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // ---- 【0.21.11 · 老板第 4 条】文章二级页：原文 / 翻译 / AI解读 ----
  // 三段都是"没有就直说"：没正文就说没正文、中文原文就说不用翻译、解读没跑就摆按钮，
  // 不拿占位文字冒充内容（本模块一直按这条走）。
  function renderArticleDetail() {
    const a = detailArticle;
    if (!a) return null;
    const source = sourcesList.find((s) => s.id === a.source_id);
    const sourceName = (source && source.name) || a.author || '未知来源';
    const body = String(a.content || '').trim();
    const summaryText = String(a.summary_long || a.summary || '').trim();
    const text = body || summaryText;
    const paras = text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const targets = Array.from(new Set((a.target_roles || []).map(roleLabel)));
    const comps = Array.from(new Set((a.target_company_types || []).map(companyTypeLabel)));

    const detailTabs = [
      {
        key: 'original',
        label: '原文',
        children: (
          <div className="learn-detail-sec">
            {paras.length === 0 ? (
              <Empty description="这篇没抓到正文，去右上角「打开原文」看源站" />
            ) : (
              <div className="learn-detail-body">
                {paras.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            )}
            {!body && summaryText ? (
              <div className="learn-detail-note">
                说明：这里显示的是抓取到的<b>摘要</b>，不是全文 —— 全文请看源站。
              </div>
            ) : null}
          </div>
        ),
      },
      {
        key: 'translate',
        label: '翻译',
        children: (
          <div className="learn-detail-sec">
            {!trResult ? (
              <div className="learn-detail-empty">
                <div className="learn-detail-empty-t">这篇要是外文，可以翻成中文看</div>
                <Button type="primary" loading={trBusy} onClick={loadDetailTranslate}>
                  翻译成中文
                </Button>
                <div className="learn-detail-empty-h">
                  中文原文不用翻 —— 点了只会告诉你「不需要翻译」，不会为了填满页签硬编一段译文。
                </div>
              </div>
            ) : trResult.failed ? (
              <div className="learn-detail-empty">
                <div className="learn-detail-empty-t">这次没翻成功</div>
                <Button loading={trBusy} onClick={loadDetailTranslate}>
                  重试一次
                </Button>
              </div>
            ) : trResult.sameLang ? (
              <div className="learn-detail-empty">
                <div className="learn-detail-empty-t">原文就是中文，不需要翻译</div>
                <div className="learn-detail-empty-h">要看内容请切到「原文」页签。</div>
              </div>
            ) : (
              <>
                {trResult.title_zh ? <div className="learn-detail-t2">{trResult.title_zh}</div> : null}
                <div className="learn-detail-body">
                  {String(trResult.body_zh || '')
                    .split(/\n+/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                </div>
                {trResult.note ? (
                  <div className="learn-detail-note">译者说明：{trResult.note}</div>
                ) : null}
              </>
            )}
          </div>
        ),
      },
      {
        key: 'ai',
        label: 'AI 解读',
        children: (
          <div className="learn-detail-sec">
            {aiBusy ? (
              <div className="learn-detail-empty">
                <Spin />
                <div className="learn-detail-empty-h">豆芽正在读这篇…</div>
              </div>
            ) : !aiResult ? (
              <div className="learn-detail-empty">
                <div className="learn-detail-empty-t">让豆芽按你的企业和角色解读这篇</div>
                <Button type="primary" onClick={loadDetailAI}>
                  开始解读
                </Button>
              </div>
            ) : (
              <div className="learn-detail-interp">
                {[
                  ['这是什么', aiResult.what],
                  ['为什么值得关注', aiResult.why],
                  ['对你的影响', aiResult.impact],
                  ['你可以怎么做', aiResult.action],
                ]
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div className="learn-detail-row" key={k}>
                      <div className="learn-detail-k">{k}</div>
                      <div className="learn-detail-v">{v}</div>
                    </div>
                  ))}
                {aiResult.next && aiResult.next.length > 0 ? (
                  <div className="learn-detail-row">
                    <div className="learn-detail-k">继续学习</div>
                    <div className="learn-detail-v">
                      {aiResult.next.map((n, i) => (
                        <div key={i}>· {n}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ),
      },
    ];

    return (
      <div className="learn-detail" data-learn-detail={a.id}>
        <div className="learn-detail-top">
          <Button type="text" className="learn-detail-back" onClick={closeDetail}>
            ← 返回列表
          </Button>
          {a.url ? (
            <Button size="small" href={a.url} target="_blank" rel="noreferrer">
              打开原文 ↗
            </Button>
          ) : null}
        </div>

        <ArticleCover article={a} className="learn-detail-cover" />

        <div className="learn-detail-hd">
          <div className="learn-meta">
            {a.category ? (
              <span className="learn-tag">
                {categoryLabel(a.category)}
                {a.sub_category ? ` · ${a.sub_category}` : ''}
              </span>
            ) : null}
            <span>{sourceName}</span>
            {a.published_at ? <span>· {formatDate(a.published_at)}</span> : null}
          </div>
          <h1 className="learn-detail-title">{a.title}</h1>
          {a.why_important ? <div className="learn-detail-why">{a.why_important}</div> : null}
          {targets.length > 0 || comps.length > 0 ? (
            <div className="learn-fit">
              适合谁：
              {targets.length > 0 ? <span>{targets.join('、')}</span> : null}
              {targets.length > 0 && comps.length > 0 ? <span> · </span> : null}
              {comps.length > 0 ? <span>{comps.join('、')}</span> : null}
            </div>
          ) : null}
        </div>

        <Tabs activeKey={detailTab} onChange={setDetailTab} items={detailTabs} />

        {/* 列表页的高频动作在二级页里也留一份：读完就地处理，不用退回列表再找这张卡 */}
        <Space wrap size={8} className="learn-detail-actions">
          <Button size="small" onClick={() => openInterpret(a)}>
            让AI帮我解读
          </Button>
          <Button size="small" onClick={() => joinLearning(a)}>
            加入学习
          </Button>
          <Button size="small" onClick={() => openProjectModal(a)}>
            加入项目
          </Button>
          <Button size="small" onClick={() => toTodayContent(a)}>
            用这个做今天内容
          </Button>
        </Space>
      </div>
    );
  }

  // ---- 置顶「这几篇必读」区块（行业资讯 / 为你推荐 复用）----
  // 无匹配文章时整块不渲染（返回 null），不留空框、不显示假数据。
  function renderMustReadBlock() {
    if (mustRead.length === 0) return null;
    return (
      <div className="learn-mustread-box">
        <div className="learn-mustread-box-title">📌 这几篇必读</div>
        <div className="learn-mustread-rows">
          {mustRead.map((a) => (
            <div className="learn-mustread-row" key={a.id}>
              <span className="learn-mustread-row-title">{a.title}</span>
              {mustReadTag(a.importance)}
              {/* 去读：有原文则跳原文，否则复用「AI 解读」——不新造交互 */}
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer">
                  <Button size="small" type="primary">
                    去读
                  </Button>
                </a>
              ) : (
                <Button size="small" type="primary" onClick={() => openInterpret(a)}>
                  去读
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---- Tab：平台入驻（硬编码知识库，不联网、不走 AI） ----
  const [ptKeyword, setPtKeyword] = useState('');
  const [ptGroup, setPtGroup] = useState('all');
  const [ptOpen, setPtOpen] = useState(false);
  const [ptCurrent, setPtCurrent] = useState(null);

  const ptStats = useMemo(() => countOnboardingVerified(), []);
  const ptList = useMemo(
    () => filterOnboardingPlatforms({ keyword: ptKeyword, group: ptGroup }),
    [ptKeyword, ptGroup],
  );

  function openPlatform(p) {
    setPtCurrent(p);
    setPtOpen(true);
  }

  /** 核验状态标签：verified=true 绿标，false 打「待核验」。 */
  function verifiedTag(ok) {
    return <span className={`learn-pt-tag ${ok ? 'ok' : 'pending'}`}>{ok ? '✓ 已核验' : '⚠ 待核验'}</span>;
  }

  /** 通用条目行：内容 + 备注 + 待核验标。 */
  function renderPtItem(text, ok, note, dot) {
    return (
      <div className="learn-pt-item" key={text}>
        <span className="learn-pt-item-dot">{dot || '·'}</span>
        <span>
          {text}
          {note ? <span className="learn-pt-item-note">{note}</span> : null}
          {ok ? null : (
            <span className="learn-pt-tag pending" style={{ marginLeft: 6 }}>
              待核验
            </span>
          )}
        </span>
      </div>
    );
  }

  function renderPlatformCard(p) {
    return (
      <div
        className="learn-pt-card"
        key={p.id}
        role="button"
        tabIndex={0}
        onClick={() => openPlatform(p)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPlatform(p);
          }
        }}
      >
        <div className="learn-pt-card-top">
          <span className="learn-pt-card-icon">{p.icon}</span>
          <span className="learn-pt-card-name">{p.name}</span>
          {verifiedTag(!!p.verified)}
        </div>
        <div>
          <span className="learn-pt-tag muted">{groupLabel(p.category)}</span>
        </div>
        <div className="learn-pt-card-summary">{p.summary}</div>
        <div className="learn-pt-card-foot">
          <span>{p.entryType}</span>
          <span style={{ color: GREEN_DARK, fontWeight: 600 }}>
            {(p.steps || []).length} 步 · 查看指引 →
          </span>
        </div>
      </div>
    );
  }

  /** 平台详情（Drawer）：资质 / 材料 / 步骤 / 坑 / 周期 / 费用 / 合规 / 来源。 */
  function renderPlatformDetail() {
    const p = ptCurrent;
    if (!p) return null;
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 24 }}>{p.icon}</span>
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--c-text)' }}>{p.name}</span>
          {verifiedTag(!!p.verified)}
          <span className="learn-pt-tag muted">{groupLabel(p.category)}</span>
        </div>

        <Alert
          type={p.verified ? 'success' : 'warning'}
          showIcon
          style={{ marginBottom: 14 }}
          message={p.verified ? '该平台核心要求已核对官方来源' : '该平台存在待核验条目，请以平台后台实际提示为准'}
          description={<span style={{ fontSize: 12.5, lineHeight: 1.7 }}>{p.verifiedNote}</span>}
        />

        <div className="learn-pt-kv">
          <span className="learn-pt-kv-k">入驻性质</span>
          <span className="learn-pt-kv-v">{p.entryType}</span>
        </div>

        {p.officialUrl ? (
          <div style={{ marginBottom: 14 }}>
            <a href={p.officialUrl} target="_blank" rel="noreferrer">
              <Button size="small" type="primary" ghost>
                打开官方入驻页 / 规则页
              </Button>
            </a>
          </div>
        ) : null}

        {/* 资质要求 */}
        <div className="learn-pt-block">
          <div className="learn-pt-section">📋 入驻前准备 · 资质要求</div>
          {(p.qualifications || []).map((q) =>
            renderPtItem(q.text, resolveVerified(q, p), q.note, '✓'),
          )}
        </div>

        {/* 材料清单 */}
        <div className="learn-pt-block">
          <div className="learn-pt-section">📦 所需材料清单</div>
          {(p.materials || []).map((m) => (
            <div className="learn-pt-item" key={m.text}>
              <span className="learn-pt-item-dot">·</span>
              <span>
                {m.text}
                <span className="learn-pt-tag muted" style={{ marginLeft: 6 }}>
                  {m.required === false ? '选填' : '必填'}
                </span>
                {resolveVerified(m, p) ? null : (
                  <span className="learn-pt-tag pending" style={{ marginLeft: 6 }}>
                    待核验
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>

        {/* 入驻流程 */}
        <div className="learn-pt-block">
          <div className="learn-pt-section">🪜 入驻流程</div>
          <Steps
            direction="vertical"
            size="small"
            current={(p.steps || []).length}
            items={(p.steps || []).map((s) => ({
              title: (
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {s.title} {verifiedTag(resolveVerified(s, p))}
                </span>
              ),
              description: (
                <span style={{ fontSize: 12.5, color: 'var(--c-text-2)', lineHeight: 1.75 }}>{s.detail}</span>
              ),
            }))}
          />
        </div>

        {/* 常见坑 */}
        <div className="learn-pt-block">
          <div className="learn-pt-section" style={{ color: 'var(--c-warn)' }}>
            ⚠️ 常见坑 / 驳回原因
          </div>
          {(p.pitfalls || []).map((x) => (
            <div className="learn-pt-item learn-pt-warn" key={x.text}>
              <span className="learn-pt-item-dot">!</span>
              <span>
                {x.text}
                {resolveVerified(x, p) ? null : (
                  <span className="learn-pt-tag pending" style={{ marginLeft: 6 }}>
                    待核验
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>

        {/* 周期 / 费用 */}
        <div className="learn-pt-block">
          <div className="learn-pt-section">⏱ 审核周期与费用</div>
          <div className="learn-pt-kv">
            <span className="learn-pt-kv-k">审核周期</span>
            <span className="learn-pt-kv-v">
              {p.reviewCycle?.text || '—'}
              {p.reviewCycle ? (
                <span style={{ marginLeft: 6 }}>{verifiedTag(!!p.reviewCycle.verified)}</span>
              ) : null}
            </span>
          </div>
          <div className="learn-pt-kv">
            <span className="learn-pt-kv-k">费用说明</span>
            <span className="learn-pt-kv-v">
              {p.feeNote?.text || '—'}
              {p.feeNote ? (
                <span style={{ marginLeft: 6 }}>{verifiedTag(!!p.feeNote.verified)}</span>
              ) : null}
            </span>
          </div>
        </div>

        {/* 口腔行业特有提醒（医疗广告合规） */}
        <div className="learn-pt-block">
          <div className="learn-pt-compliance">
            <div className="learn-pt-compliance-title">🚫 口腔行业特有提醒 · 医疗广告合规红线</div>
            {(p.medicalCompliance || []).map((c) => (
              <div className="learn-pt-compliance-item" key={c}>
                <span style={{ flexShrink: 0 }}>·</span>
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>

        <Divider style={{ margin: '4px 0 12px' }} />

        {/* 来源 */}
        <div className="learn-pt-block">
          <div className="learn-pt-section">🔗 资料来源</div>
          {(p.source || []).map((s) => (
            <div className="learn-pt-source" key={s.url + s.label}>
              <span className="learn-pt-tag ok" style={{ marginRight: 6 }}>
                {s.official ? '官方' : '第三方'}
              </span>
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.label}
                </a>
              ) : (
                <span>{s.label}</span>
              )}
            </div>
          ))}
        </div>

        <div className="learn-pt-disclaimer">
          说明：本指引为静态知识库，平台政策会随时调整。带「待核验」标的条目未取得官方公开依据，
          仅供准备材料的方向参考，最终以平台商家后台 / 官方规则页实际提示为准。费用与审核时长一律不提供
          未经官方确认的具体数字。
        </div>
      </>
    );
  }

  // ---- Tab 4 分组渲染 ----
  /**
   * 【老板第 5 条】每个分组各自分页（学习进度 / 已学完 / 稍后再看 三个页码互不影响）。
   *
   * 为什么页码 state 存在外层的 `groupPages` 对象里、而不是本函数内的 useState：
   * 本函数是**普通渲染函数**（按 statusKey 被调用三次），在里面吊 hooks 会违反 hooks 规则
   * （调用顺序随分组条数变化而变）。所以 state 提到组件层，用 `{[statusKey]: page}` 存。
   */
  function renderGroup(statusKey) {
    const items = learnedArticles.filter((x) => x.status === statusKey);
    if (items.length === 0) return null;
    const pageCount = Math.max(1, Math.ceil(items.length / LEARN_PAGE_SIZE));
    // 读的时候再夹一次：把一篇「学习中」标成「已学完」会让来源分组变短，
    // 而页码 state 不会自己往回走；不夹就会渲染出一个空白分组（且不会自愈）。
    const page = Math.min(Math.max(1, Number(groupPages[statusKey]) || 1), pageCount);
    const visible = items.slice((page - 1) * LEARN_PAGE_SIZE, page * LEARN_PAGE_SIZE);
    return (
      <div key={statusKey}>
        <div className="learn-group-title">
          {LEARNING_STATUS[statusKey] || statusKey}（{items.length}）
        </div>
        <div className="learn-grid">
          {visible.map(({ article }) => renderArticleCard(article, statusSwitcher(article)))}
        </div>
        {/* 条数本来就 ≤6 的分组不渲染分页器：一个「只有 1 页」的分页器只会让人以为还有下一页。 */}
        {items.length > LEARN_PAGE_SIZE && (
          <div className="learn-pager">
            <Pagination
              size="small"
              current={page}
              pageSize={LEARN_PAGE_SIZE}
              total={items.length}
              showSizeChanger={false}
              showTotal={(n) => `共 ${n} 条`}
              onChange={(p) => setGroupPages((prev) => ({ ...prev, [statusKey]: p }))}
            />
          </div>
        )}
      </div>
    );
  }

  const categoryOptions = [
    { label: '全部分类', value: 'all' },
    ...KNOWLEDGE_CATEGORIES.map((c) => ({ label: `${c.icon} ${c.label}`, value: c.key })),
  ];

  const tabItems = [
    {
      key: 'feed',
      label: <span data-learn-tab="feed">行业资讯</span>,
      children: (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div className="learn-toolbar">
            <Button type="primary" onClick={fetchIndustryNews} loading={fetchBusy}>
              🔄 抓取今日资讯
            </Button>
            <Button onClick={openAddModal}>手动添加</Button>
            <Select
              style={{ width: 180 }}
              value={categoryFilter}
              // 换分类必须回第 1 页：停在第 5 页去筛「政策」，命中的 2 条全在第 1 页，
              // 用户看到的是空白 —— 那条 useEffect 虽然也会夹回，但语义上「换了筛选 = 重新看」，
              // 这里显式回第 1 页，读代码的人不用去追 effect 才敢确认。
              onChange={(v) => {
                setCategoryFilter(v);
                setFeedPage(1);
              }}
              options={categoryOptions}
            />
            <Segmented
              value={timeFilter}
              onChange={(v) => {
                setTimeFilter(v);
                setFeedPage(1);
              }}
              options={[
                { label: '全部', value: 'all' },
                { label: '今日', value: 'today' },
                { label: '7天', value: '7d' },
                { label: '30天', value: '30d' },
                { label: '更早', value: 'older' },
              ]}
            />
          </div>

          {/* ---------- 【0.21.16 · 老板需求 6 / 老板第 1 条】口腔文献入口 ----------
              老板原话：「我的建议是从 中华医学期刊里面 找口腔文献 阅读」、
                        「medjournals.cn 诶 你说这个网站不存在嘛？？这个不就是中华医学期刊网吗？」
              事实（别再写成「这个站不可用」）：
                · 自动抓取侧：中华医学期刊网的**当期目录已经接通**（crawlJournalSources →
                  fetchJournalIssue，解析 zhkqyxzz / zhkqzjx 两个子站的目录页），并且
                  sortJournalFirst 保证文献永远排在 RSS 条目之前；
                · 这两站没有 RSS 订阅，但目录页结构稳定、可解析 —— 「没有 RSS」≠「抓不到」；
                · 右边的入口只是给「用户想自己去站内检索全文」用的，不是抓取能力的替代品。 */}
          <div className="learn-lit" data-learn-lit="1">
            <span className="learn-lit-t">优先读口腔文献</span>
            <span className="learn-lit-note">
              抓取会先解析中华医学期刊网的当期目录（中华口腔医学杂志 / 中华口腔正畸学杂志），
              再补专业媒体源；想自己检索全文，点右边。
            </span>
            {LITERATURE_PORTALS.map((p) => (
              <a
                key={p.id}
                className="learn-lit-link"
                href={p.url}
                target="_blank"
                rel="noreferrer"
                title={p.note}
                data-learn-lit-portal={p.id}
              >
                {p.name} ↗
              </a>
            ))}
          </div>

          {/* ---------- 【0.21.28 · 老板「还有教学 现在也是很糟糕的完全不能看」】----------
              这一段「本次抓取：中华医学期刊 0 篇 · 本地 RSS 0 条 · 跳过重复 0 条 ·
              抓通 0/7 个源 · AI 未连接 … 未抓通的源：中华口腔医学杂志、…」实测 **223 字**，
              原先**裸挂在首屏**最显眼的位置 —— 抓不到时，老板打开学习中心看到的就是这一大段运维日志。
              它不是假话（诚实红线要它必须在），但它的读者是**排查的人**，不是老板。
              ⇒ 收进默认收起的 <details>（summary 一句话说清它是干什么的）。
              ⚠️ 一个字都不许删：这是「为什么抓不到」的唯一线索（见下方空态与 learnFetchReport.js）。
              ⚠️ 也不许把它挪进「空态分支」里 —— 抓到时（fetchResult 有值但 allArticles 为空）
                 同样是排查现场，两种情形都要能展开看到。 */}
          {fetchResult && (
            <details className="learn-fetch-details" data-learn-fetch-details="1">
              <summary className="learn-fetch-summary">抓取明细（排查用）</summary>
              <div className="learn-fetch-hint" style={{ color: FAINT, fontSize: 12.5 }}>
                本次抓取：
                {/* 【老板第 1 条】中华医学期刊当期目录是**最高优先级**的一级，单独报数；
                    【0.21.27】「本地」改成「本地 RSS」并把期刊那几条**拆出来**，否则期刊篇数被数两遍。 */}
                中华医学期刊 {fetchResult.journalAdded || 0} 篇
                {' · '}本地 RSS {fetchResult.rssAdded || 0} 条
                {fetchResult.aiAdded ? ` + AI 补充 ${fetchResult.aiAdded} 条` : ''}
                · 跳过重复 {fetchResult.skipped} 条
                {/* 抓通几个源 / 几个没通 —— 这一行是老板「是不是根本爬不到内容」的直接答复 */}
                {fetchNotice && fetchNotice.attempted > 0
                  ? ` · 抓通 ${fetchNotice.okCount}/${fetchNotice.attempted} 个源`
                  : ''}
                {/* 【0.21.16 · 老板需求 6】把「挑了几个源 / 相关性是怎么判的」如实说出来 ——
                    老板说的是「AI 先帮我判断一下」，那判断方式就该让他看得见：
                    ai = 模型判的；rule = 模型没连上，退回关键词规则判的（降级但不空屏）。 */}
                {fetchResult.judgeMode === 'ai' ? ' · AI 已筛掉无关内容' : ''}
                {fetchResult.judgeMode === 'rule'
                  ? ` · AI 未连接，按关键词筛（已剔 ${fetchResult.judgeDropped || 0} 条）`
                  : ''}
                {/* 【诚实红线】没抓通的源**逐个列出来**（中文名）：
                    不许把「抓不到」渲染成「今天没有新内容」。期刊与 RSS 一起报，不再只报期刊那一级。
                    这里只列源名（原因走提示条，避免把这一行撑成一大段看不懂的技术报错）。 */}
                {fetchNotice && fetchNotice.namesText ? ` · 未抓通的源：${fetchNotice.namesText}` : ''}
              </div>
            </details>
          )}

          {renderMustReadBlock()}

          {/* ---------- 【0.21.27】首屏三态：正在抓 / 诚实空态 / 有内容 ----------
              改前这里只有一句「还没有资讯，点抓取…」，而且**永远不可能出现** ——
              store 在 localStorage 为空时自动灌了 6 条内置示例（url 全空），
              于是首屏永远有 6 张点进去看不到正文的假卡片。 */}
          {allArticles.length === 0 && fetchBusy ? (
            <div className="learn-fetch-loading" data-learn-loading="1" style={{ padding: '28px 0', textAlign: 'center', color: FAINT }}>
              <Spin size="small" />
              <span style={{ marginLeft: 10 }}>正在抓取今日资讯…（先解析中华医学期刊当期目录，再补权威源）</span>
            </div>
          ) : allArticles.length === 0 ? (
            /* ---------- 【0.21.28】空态：第一层「说人话 + 给真去处」，第二层才是运维明细 ----------
               改前的现场（老板原话「还有教学 现在也是很糟糕的完全不能看」，实测 chars 835 / 按钮 5）：
                 首屏 = PageBanner + 说明条 + 3 个工具栏控件 + 一条 223 字运维日志 + Empty
                        + 2 个按钮（重试抓取 / 看看示例）。**没有一个字是真内容**。
               本轮拆成两层：
                 ① 这一块（首屏可见）：一句人话说清「没抓到 + 为什么」，
                    然后给**两个真有东西**的去处（6 篇运营 SOP / 平台入驻指南）——
                    那两个页签的内容是硬编码知识库，不联网、不走 AI，抓不到资讯也照样能看。
                 ② 上面的 `<details data-learn-fetch-details>`（默认收起）：逐个源名的抓取明细。
               诚实红线：文案不许写成「暂无内容 · 敬请期待」——
               抓不到就直说抓不到、说清几个源没通、并给出「现在就能看的」替代去处。 */
            <div className="learn-empty-honest" data-learn-empty-honest="1">
              <Empty
                description={(
                  <span className="learn-empty-desc" data-learn-empty-desc="1">
                    今天的行业资讯没抓到
                  </span>
                )}
              />
              <p className="learn-empty-lead" data-learn-empty-lead="1">
                {fetchNotice && fetchNotice.attempted > 0
                  ? `${fetchNotice.attempted} 个源里只通了 ${fetchNotice.okCount} 个，这一轮一条可用资讯也没拿到 —— 多半是网络断了，或者本地抓取服务（127.0.0.1:10119）没起来。`
                  : '还没抓到资讯。点「重试抓取」会先解析中华医学期刊网的当期目录，再补专业媒体源，不足时用 AI 联网补充。'}
                {' '}抓取失败不影响下面两个页签：运营实操与平台入驻指南都是硬编码知识库，
                不联网、不走 AI，现在就能看。
              </p>
              <div className="learn-empty-actions" data-learn-empty-actions="1">
                <Space wrap>
                  {/* ⚠️ 这两个出口**不许因为「按钮数变多」被删**：
                      unit-firstscreen 的 `learn` 棘轮是「实测值登记」，不是「压到某个数」。
                      它们正是「抓不到就明说，别拿假数据糊我」的落地形态（老板 0.21.27 原话）。 */}
                  <Button type="primary" onClick={fetchIndustryNews} loading={fetchBusy}>
                    重试抓取
                  </Button>
                  {/* ⚠️ 文案里**不许出现「SOP」**：它在本仓首屏术语黑名单里
                      （`probes/_say_audit_entry.jsx:151` 的 JARGON），learn 模块要求术语 0 处。
                      「实操」是老板自己的用词（「原来的实操清单（2 篇）」），所以用他的词。 */}
                  <Button onClick={() => setLearnTab('tutorial')}>
                    去看 {TUTORIAL_LIBRARY.length} 篇运营实操
                  </Button>
                  <Button onClick={() => setLearnTab('onboarding')}>去看平台入驻指南</Button>
                  <Button onClick={showSampleArticles}>看看示例</Button>
                </Space>
              </div>
            </div>
          ) : filteredArticles.length === 0 ? (
            <Empty description="暂无匹配的资讯" />
          ) : (
            <>
              <div className="learn-grid">{pagedArticles.map((a) => renderArticleCard(a))}</div>
              {/* 分页器放在列表**下方**（老板说的顺序：先看内容再翻页）。
                  只有真多于一页才渲染：1 页的分页器是纯噪音，还白占一行高度。 */}
              {filteredArticles.length > LEARN_PAGE_SIZE && (
                <div className="learn-pager">
                  <Pagination
                    size="small"
                    current={feedPageSafe}
                    pageSize={LEARN_PAGE_SIZE}
                    total={filteredArticles.length}
                    showSizeChanger={false}
                    showTotal={(n) => `共 ${n} 条`}
                    onChange={(p) => setFeedPage(p)}
                  />
                </div>
              )}
            </>
          )}
        </Space>
      ),
    },
    {
      // 【0.21.14 · 老板需求 2】页签 label「实操教学」→「门诊运营教学」（老板原话口径）。
      // ⚠️ key 与 data-learn-tab 的锚点值 `tutorial` **一个字不动** —— 它是门禁与深链的锚点，
      //    老板只要求改页签叫什么，没要求改锚点。改锚点会让 D3/D4 与深链一起红。
      key: 'tutorial',
      label: <span data-learn-tab="tutorial">🎓 门诊运营教学</span>,
      children: (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <OcpPanel
            companyId={companyId}
            companyName={companyNameForOcp}
            chatFn={ocpChatFn}
            chatSlot={(
              <>
                {/* ── 入口：一进本页签、第一屏就看得见的一排（老板第 2 条） ─────────────
                    老板原话：「学习中心里面为什么会有那么大一个活动策划？？删了，
                              对话框放在门诊运营教学里面 不要一进去就在顶部」
                    ＋ 主理人追加的验收口径：进入本页签后**第一屏必须看见「开始对话」这个入口本身**。

                    ⇒ 入口做成**结构性**保证，而不是「大概能看见」：
                      · 它是本页签里第 3 个块（标题行 → 5 个胶囊 → 这里），
                        排在画像折叠与 5 张卡**之前** —— 任何视口高度都轮不到它掉出首屏；
                      · 它是真 <button>（不是文字链），且**不包在任何 <details> 里**；
                      · 默认收起对话框、按钮常驻：既满足「别那么大」，也不会让人找不到。
                    ⚠️ 收起的只是**挂载**，不是数据：会话正文在 localStorage、进行中任务在后台任务 store，
                       展开时原样读回来（ActivityChat 头注释 §1/§2 就是为了这个）。 */}
                <div className="ocp-chat-entry" data-learn-chat-entry="1">
                  <button
                    type="button"
                    className={'ocp-chat-btn' + (askOpen ? ' is-open' : '')}
                    data-learn-chat-start="1"
                    aria-expanded={askOpen ? 'true' : 'false'}
                    onClick={() => setAskOpen((v) => !v)}
                  >
                    💬 问豆芽 · {askOpen ? '收起对话' : '开始对话'}
                  </button>
                  <span className="ocp-chat-hint">
                    口腔文献、临床问题、诊所经营都能问；说一句就行。
                  </span>
                </div>

                {/* ── 对话框：点入口后**就地**展开在这排下面（仍在 5 个胶囊之下、5 张卡之上） ──
                    · embedded ⇒ 不渲染 ActivityChat 自己那行「活动策划」页头（老板点名要删的标题）；
                    · variant="learn" ⇒ 会话 key 仍是 `douya-activity-chat:<企业>:learn`，
                      换的只是挂载位置，历史不会丢（落盘 key 没动，这是「切页面不丢」的前提）。
                    ⚠️ 仍然**不改** ActivityChat.jsx 本体：活动页与经营方案共用它，改它会波及两处。 */}
                {askOpen ? (
                  <div className="learn-ask" data-learn-ask="1">
                    <ActivityChat
                      embedded
                      variant="learn"
                      rolePrompt={LEARN_ASK_PROMPT}
                      welcome="今天想弄明白什么？"
                      examples={LEARN_ASK_EXAMPLES}
                      placeholder="例如：这周有什么值得看的口腔临床文献？/ 患者嫌贵怎么解释？"
                      saveLabel="存入素材库"
                      saveNamePrefix="学习笔记"
                      saveTags={['学习中心', '豆芽生成']}
                      sendBusyText="豆芽在查资料、组织答案…"
                    />
                  </div>
                ) : null}
              </>
            )}
          />

          {/* ══════════════════════════════════════════════════════════════════════
              【运营 SOP · 6 篇】—— 这三代历史必须留着，否则下一轮又会有人删回去
              ══════════════════════════════════════════════════════════════════════
              第一代（0.21.14）：`<details data-ocp-legacy>` 折叠条，标题「原来的实操清单（N 篇）· 想看细节点这里」。
              第二代（0.21.16 · 老板需求 6）：老板原话逐字
                「原来的实操清单（2 篇）· 想看细节点这里删掉」
                ⇒ 那一整个 `<details>` 渲染块删除。**删的是这个丑陋的折叠外壳，不是这 6 篇内容**：
                   6 篇一直躺在 `data/knowledgeCatalog.js` 的 `TUTORIAL_LIBRARY` 里（一条没动）。
                   注意老板说的是「2 篇」而实际有 6 篇 —— 当时那个折叠条只露出 2 条，
                   他看到的只是一个碍眼的折叠外壳，不是「这 6 篇不许出现」。
              第三代（0.21.28 · 本轮）：老板原话
                「还有现在的学习中心 内容也十分糟糕，是不是根本爬不到内容」
                「还有教学 现在也是很糟糕的完全不能看」
                ⇒ 把 6 篇做成**正经卡片**（`.learn-tut-card` 网格，点开就看见步骤 / 验收 / 坑），
                  不是复活那个 `<details data-ocp-legacy>`。
              ⚠️ 形态上的区别是刻意的，别改回去：
                 · 不用 `<details>/<summary>` 外壳，卡片头是真 `<button>`（可点、可 aria-expanded）；
                 · 类名必须 `.learn-tut-card`，**不是** `.learn-card` ——
                   `entry-interact.jsx:3666` 用「`.learn-card` 数量必须为 0」守着
                   「假资讯不许顶首屏」，用 `.learn-card` 会给那条判据制造假冲突；
                 · 展开状态只在本组件 `useState`（浏览态），**不**落 localStorage
                   —— 进度真源只有 OCP 那一套（`toggleOcpProgress`，按 companyId 隔离）。
              ⚠️ 数据顺序按 `TUTORIAL_LIBRARY` 原序渲染，不许重排（老板没提排序 = 保持库里顺序）。
              ⚠️⚠️ **这 6 篇里 `checklist` / `pitfalls` 的文字一个字都不许改写、摘要、截断。**
                 其中 `tut-content-compliance`「牙科内容合规红线清单（发布前必查）」的 `pitfalls`
                 是**合规红线**（例如「团购文案出现『无痛』『根治』『最好』『保证不复发』等
                 绝对化/疗效承诺词，属违规」）—— 改写一个字就可能把"违规词"改成"不算违规"，
                 那是法务风险，不是文案优化。
                 所以：要截断只许截 `intro`（已由 `.learn-summary` 做 2 行截断，见 CSS:705 注释）；
                 `steps` / `checklist` / `pitfalls` 三块**无 max-height、无 overflow、无 line-clamp**，
                 一律完整渲染（`.learn-tut-detail` 只有 flex + gap，见 round16-learn.css:708）。
                 ⇒ 卡片高度不够就让它长高（`.learn-tut-card.is-open { grid-column: 1 / -1 }` 已横跨整行），
                   不许为了"整齐"去裁掉红线。
           */}
          <div className="learn-tut-lib" data-learn-tut-lib="1">
            <div className="learn-tut-lib-head">
              <span className="learn-tut-lib-title">运营实操 · {TUTORIAL_LIBRARY.length} 篇</span>
              <span className="learn-tut-lib-note">
                不联网、不走 AI，照着一步步做就能上线。点标题展开「怎么做 / 验收清单 / 常见坑」。
              </span>
            </div>
            <div className="learn-tut-grid">
              {TUTORIAL_LIBRARY.map((t) => {
                const open = !!tutOpen[t.id];
                return (
                  <div
                    key={t.id}
                    /* ⚠️ 卡面（背景/描边/圆角/阴影）故意复用 `.learn-card-media`：
                       `unit-theme-cover-group-b.mjs` 的 E2 是「逐位置颜色序列」棘轮，
                       round16-learn.css **新增一条带颜色的规则就判红**（会被算成"多换了一处"）。
                       `.learn-tut-card` 只负责版式 —— 详见该 CSS 文件末尾那段头注释。 */
                    className={'learn-tut-card learn-card-media' + (open ? ' is-open' : '')}
                    data-tut-card="1"
                    data-tut-id={t.id}
                  >
                    <button
                      type="button"
                      className="learn-tut-card-hd"
                      data-tut-toggle={t.id}
                      aria-expanded={open ? 'true' : 'false'}
                      onClick={() => setTutOpen((prev) => ({ ...prev, [t.id]: !prev[t.id] }))}
                    >
                      <span className="learn-tut-card-title">{t.title}</span>
                      {/* 次要行/摘要的**墨色**分别来自 `.learn-meta` / `.learn-summary`
                          （三套主题都已覆盖），所以这里不写任何颜色类，也不会新增颜色声明。 */}
                      <span className="learn-tut-card-meta learn-meta">
                        <span className="learn-tut-card-badge">{t.difficulty}</span>
                        <span>{t.minutes} 分钟</span>
                        <span>{t.steps.length} 步 · {t.checklist.length} 项验收 · {t.pitfalls.length} 个坑</span>
                      </span>
                    </button>
                    <p className="learn-tut-card-intro learn-summary">{t.intro}</p>
                    {open ? (
                      <div className="learn-tut-detail" data-tut-detail="1">
                        <div className="learn-tut-sec">
                          <div className="learn-tut-sec-title">怎么做 · {t.steps.length} 步</div>
                          <ol className="learn-tut-steps">
                            {t.steps.map((s, i) => (
                              <li className="learn-tut-step" key={`${t.id}-step-${i}`}>
                                <span className="learn-tut-num">{i + 1}</span>
                                <span className="learn-tut-step-bd">
                                  <b className="learn-tut-step-t">{s.t}</b>
                                  <span className="learn-tut-step-d">{s.d}</span>
                                </span>
                              </li>
                            ))}
                          </ol>
                        </div>
                        <div className="learn-tut-sec">
                          <div className="learn-tut-sec-title">验收清单 · {t.checklist.length} 项</div>
                          {/* ⚠️ 这里的方框是**静态样式**，不是可点的 checkbox：
                              真能勾就会造出第二套「学习进度」真源，和 OCP 那套（按 companyId 落库）
                              打架，「换企业进度不串」那条隔离判据会开始骗人。 */}
                          <ul className="learn-tut-checks">
                            {t.checklist.map((c, i) => (
                              <li className="learn-tut-check" key={`${t.id}-check-${i}`}>
                                <span className="learn-tut-check-box" aria-hidden="true" />
                                <span className="learn-tut-check-t">{c}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="learn-tut-sec">
                          <div className="learn-tut-sec-title">常见坑 · {t.pitfalls.length} 条</div>
                          <ul className="learn-tut-pits">
                            {t.pitfalls.map((p, i) => (
                              <li className="learn-tut-pit" key={`${t.id}-pit-${i}`}>{p}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </Space>
      ),
    },
    {
      key: 'onboarding',
      label: <span data-learn-tab="onboarding">🧭 平台入驻</span>,
      children: (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div className="learn-hint" style={{ color: FAINT }}>
            口腔机构上美团、高德、抖音、小红书、快手、视频号、腾讯地图的入驻指引（硬编码知识库，不联网、
            不走 AI）。{ptStats.verified}/{ptStats.total} 个平台的核心要求已核对官方来源，其余标「待核验」。
          </div>

          <div className="learn-toolbar">
            <Input.Search
              allowClear
              style={{ width: 260 }}
              placeholder="搜平台 / 资质 / 材料（如：执业许可证）"
              value={ptKeyword}
              onChange={(e) => setPtKeyword(e.target.value)}
            />
            <Segmented
              value={ptGroup}
              onChange={setPtGroup}
              options={[
                { label: '全部', value: 'all' },
                ...ONBOARDING_GROUPS.map((g) => ({ label: `${g.icon} ${g.label}`, value: g.key })),
              ]}
            />
            <span className="learn-hint" style={{ color: FAINT }}>
              共 {ptList.length} 个平台
            </span>
          </div>

          <div className="learn-pt-disclaimer">
            <b style={{ color: GREEN_DARK }}>使用方式：</b>先看「资质要求」准备硬性门槛 → 按「材料清单」
            备齐扫描件 → 照「入驻流程」一步步提交 → 提交前对照「常见坑」自查一遍。
            <b style={{ color: 'var(--c-warn)' }}>医疗广告合规红线</b>在每个平台详情页底部，发布任何内容前必看。
          </div>

          {ptList.length === 0 ? (
            <Empty description="没有匹配的平台，换个关键词试试" />
          ) : (
            <div className="learn-pt-grid learn-grid">{ptList.map(renderPlatformCard)}</div>
          )}
        </Space>
      ),
    },
    {
      key: 'mine',
      label: <span data-learn-tab="mine">我的学习</span>,
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {myLearning.length === 0 ? (
            <Empty description="还没有加入学习的内容，去「今日学习」或「行业资讯」把想学的加入进来" />
          ) : (
            <>
              {renderGroup('learning')}
              {renderGroup('done')}
              {renderGroup('later')}
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="module-page r15-page">
      {/* 【0.21.11 · 老板第 4 条】二级页与列表页是同一个 return 里的两套内容，
          不 early-return —— 下面的「添加资讯 / AI 解读 / 加入项目 / 入驻指引」四个弹层
          都挂在这棵树里，early-return 会让二级页上的「加入项目」点了没反应。 */}
      {detailArticle ? (
        renderArticleDetail()
      ) : (
        <>
          {/* 第十五轮统一版式：与其他四个重做页面同款 PageBanner 页头 */}
          <PageBanner
            ic="book"
            title="学习中心"
            sub="资讯按「口腔文献优先」抓；想问什么，进「门诊运营教学」里说。"
            slogan="每天十分钟，把专业补齐"
          />

          {/* ══════════════════════════════════════════════════════════════
              【0.21.17 · 老板第 2 条】首屏那个大对话框已**搬走**
              ══════════════════════════════════════════════════════════════
              老板原话（逐字）：「学习中心里面为什么会有那么大一个活动策划？？删了，
                                对话框放在门诊运营教学里面 不要一进去就在顶部」

              上一轮（0.21.16 需求 6）把它放在首屏当主体，代价是：
                · ActivityChat 不传 embedded 时会渲染自己那个「活动策划」页头（含一行 20 字说明），
                  于是学习中心首屏顶着一行**「活动策划」** —— 老板看到的就是这个；
                · 顶部一大块把资讯列表整个推到屏幕外。
              ⇒ 本轮：整块从首屏移除，连同 ActivityChat 一起搬进「🎓 门诊运营教学」页签，
                并且排在 5 个主题按钮**下方**（不是页签顶部），见下面 tutorial 那一项。
              ⇒ 组件本体 ActivityChat.jsx **一个字没改**（活动页 / 经营方案共用它）。 */}
          {/* 2026-10-16 设计系统 v3 同款版式说明条：说明本轮删了两个旧页签 */}
          <div className="r15-note" style={{ margin: '14px 0 4px' }}>
            <span>资讯按「口腔文献优先」抓取，一次最多 5 个权威源；门诊经营在<b>门诊运营教学</b>里。</span>
          </div>

          {/* 2026-10-16 设计系统 v3 双栏：主列 Tabs + 右栏（我的学习 / 热门专题） */}
          <div className="r15-cols">
            <div className="r15-main">
              <Tabs
                activeKey={learnTab}
                onChange={setLearnTab}
                items={tabItems}
                style={{ marginTop: 4 }}
                tabBarStyle={{ borderBottom: '1px solid var(--c-border)' }}
              />
            </div>
            <aside className="r15-rail">
              <div className="r15-card">
                <div className="r15-card-t">
                  我的学习
                  <span className="r15-card-link" role="link" tabIndex={0} onClick={() => setLearnTab('mine')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLearnTab('mine'); } }}>记录 ›</span>
                </div>
                <div className="r15-stat-row"><span className="r15-stat-t">加入学习</span><span className="r15-stat-v">{learnStats.total} 篇</span></div>
                <div className="r15-stat-row"><span className="r15-stat-t">已学完</span><span className="r15-stat-v">{learnStats.done} 篇</span></div>
                <div className="r15-stat-row"><span className="r15-stat-t">稍后再看</span><span className="r15-stat-v">{learnStats.later} 篇</span></div>
              </div>
              <div className="r15-card">
                <div className="r15-card-t">热门专题</div>
                <div className="r15-chips">
                  <span className="r15-chip">儿牙矫治</span>
                  <span className="r15-chip">设备采购</span>
                  <span className="r15-chip">诊所运营</span>
                  <span className="r15-chip">院感控制</span>
                  <span className="r15-chip">医保合规</span>
                  <span className="r15-chip">种植修复</span>
                </div>
              </div>
            </aside>
          </div>
        </>
      )}

      {/* 添加资讯 */}
      <Modal
        title="添加资讯"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={submitAddArticle}
        okText="添加"
        cancelText="取消"
        confirmLoading={addSaving}
        width={520}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="field-label">标题 *</div>
            <Input
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              placeholder="资讯标题"
            />
          </div>
          <div>
            <div className="field-label">原文链接</div>
            <Input
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div>
            <div className="field-label">分类</div>
            <Select
              style={{ width: '100%' }}
              value={addCategory}
              placeholder="选择分类"
              allowClear
              onChange={setAddCategory}
              options={KNOWLEDGE_CATEGORIES.map((c) => ({
                label: `${c.icon} ${c.label}`,
                value: c.key,
              }))}
            />
          </div>
          <div>
            <div className="field-label">正文（可选，填了会自动生成 AI 摘要）</div>
            <Input.TextArea
              value={addContent}
              onChange={(e) => setAddContent(e.target.value)}
              rows={5}
              placeholder="粘贴正文内容，AI 将据此生成摘要、标签与推荐指数"
            />
          </div>
        </div>
      </Modal>

      {/* AI 解读 */}
      <Modal
        title={interpretTitle ? `AI 解读 · ${interpretTitle}` : 'AI 解读'}
        open={interpretOpen}
        onCancel={() => setInterpretOpen(false)}
        footer={null}
        width={640}
      >
        {interpretLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: FAINT, fontSize: 13 }}>AI 正在解读…</div>
          </div>
        ) : interpretMarkdown ? (
          <div className="learn-interpret">
            <Markdown>{interpretMarkdown}</Markdown>
          </div>
        ) : (
          <Empty description="暂无解读结果" />
        )}
      </Modal>

      {/* 加入项目 */}
      <Modal
        title="加入项目资料"
        open={projectModalOpen}
        onCancel={() => setProjectModalOpen(false)}
        onOk={confirmAddToProject}
        okText="保存"
        cancelText="取消"
        width={480}
      >
        {projectArticle ? (
          <div>
            <div style={{ marginBottom: 6, fontSize: 13.5, color: 'var(--c-text)', fontWeight: 600 }}>
              {projectArticle.title}
            </div>
            <div style={{ marginBottom: 12, fontSize: 12.5, color: FAINT }}>
              将这篇资讯保存为项目的「学习资料」资产，可在资产库中查看。
            </div>
            <div className="field-label">关联项目（可选）</div>
            <Select
              style={{ width: '100%' }}
              allowClear
              placeholder="不关联项目"
              value={projectModalProjectId}
              onChange={setProjectModalProjectId}
              options={(companyProjects || []).map((p) => ({ label: p.name, value: p.id }))}
            />
          </div>
        ) : null}
      </Modal>

      {/* 平台入驻详情 */}
      <Drawer
        title={ptCurrent ? `🧭 入驻指引 · ${ptCurrent.name}` : '平台入驻指引'}
        placement="right"
        width={720}
        open={ptOpen}
        onClose={() => setPtOpen(false)}
        destroyOnClose
      >
        {renderPlatformDetail()}
      </Drawer>
    </div>
  );
}
