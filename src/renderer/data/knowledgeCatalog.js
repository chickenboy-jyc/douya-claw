/**
 * knowledgeCatalog —— 第七阶段「学习站 / 口腔行业情报」静态配置层。
 *
 * 只放分类体系 + 角色学习维度 + 精选信息源种子，不做任何 AI 逻辑。
 * 通过 userRole + companyType 决定「为你推荐」的优先级。
 *
 * 第一版不做大型爬虫：精选 31 个高质量来源（S 官方 / A 专业 / B 营销技术；0.21.27 补了 1 个
 * 实测可用的中文健康源，同时把实测失效的中华口腔医学会 RSS 置空），
 * 信息聚合优先走 RSS/公开页面/搜索，AI 负责分类与摘要。
 */

// ==================== 六大分类体系 ====================
export const KNOWLEDGE_CATEGORIES = [
  {
    key: 'policy', label: '政策法规', icon: '⚖️',
    subs: ['医疗政策', '医保', '医疗器械', '行业监管', '广告/合规', '地方政策'],
  },
  {
    key: 'tech', label: '技术', icon: '🦷',
    subs: ['数字口腔', 'CAD/CAM', '口腔扫描', 'CBCT', '种植', '正畸', '修复', 'AI辅助诊疗', '数字化治疗'],
  },
  {
    key: 'ai', label: 'AI', icon: '🤖',
    subs: ['AI牙科', 'AI诊疗', 'AI办公', 'AI营销', 'AI搜索', 'GEO', '数字人', 'AI视频'],
  },
  {
    key: 'product', label: '产品', icon: '📦',
    subs: ['新产品', '新材料', '新设备', '新解决方案', '厂商动态'],
  },
  {
    key: 'industry', label: '行业', icon: '📈',
    subs: ['企业动态', '市场趋势', '连锁发展', '投融资', '渠道', '行业研究'],
  },
  {
    key: 'event', label: '展会/学术', icon: '🎪',
    subs: ['国内展会', '海外展会', '学术会议', '培训', '沙龙'],
  },
];

export function categoryLabel(key) {
  const c = KNOWLEDGE_CATEGORIES.find((x) => x.key === key);
  return c ? c.label : key;
}

// ==================== 角色学习维度（第二层 + 第三层） ====================
// 角色：operator(运营) / manufacturer(厂家运营) / doctor(医生) / owner(门诊经营者)
export const ROLE_LEARNING = {
  operator: {
    label: '📣 运营',
    sections: [
      { key: 'marketing', label: '营销', hints: ['品牌营销', '医疗营销', '内容营销', '活动营销', '私域'] },
      { key: 'newmedia', label: '新媒体', hints: ['小红书', '抖音', '视频号', '公众号', '朋友圈'] },
      { key: 'video', label: '短视频', hints: ['选题', '脚本', '拍摄', '剪辑', '发布'] },
      { key: 'live', label: '直播', hints: ['直播运营', '直播脚本', '直播间', '转化'] },
      { key: 'ai', label: 'AI', hints: ['AI办公', 'AI文案', 'AI视频', '数字人', 'GEO', 'AI搜索'] },
    ],
  },
  manufacturer: {
    label: '🏭 厂家',
    sections: [
      { key: 'product_tech', label: '产品技术', hints: ['新材料', '新设备', '新技术', '数字口腔', 'AI'] },
      { key: 'product_market', label: '产品市场', hints: ['新品', '产品趋势', '厂商动态', '竞品动态'] },
      { key: 'channel', label: '渠道', hints: ['招商', '经销商', '渠道趋势'] },
      { key: 'academic', label: '学术', hints: ['临床研究', '学术会议', '医生教育'] },
      { key: 'exhibition', label: '展会', hints: ['国内展会', '海外展会'] },
    ],
  },
  doctor: {
    label: '👨‍⚕️ 医生',
    sections: [
      { key: 'clinical', label: '临床', hints: ['种植', '正畸', '修复', '牙周', '儿牙', '牙体牙髓', '口腔外科', '数字化'] },
      { key: 'clinic_ops', label: '门诊经营', hints: ['获客', '到店', '复诊', '转介绍', '服务', '口碑'] },
      { key: 'platform', label: '平台获客', hints: ['美团', '高德地图', '百度地图', '抖音', '小红书', '视频号'] },
      { key: 'ai', label: 'AI', hints: ['AI办公', 'AI辅助', 'AI内容', 'AI工具'] },
    ],
  },
  owner: {
    label: '🏥 门诊经营者',
    sections: [
      { key: 'clinic_ops', label: '门诊经营', hints: ['同城获客', '平台运营', '美团', '地图', '私域', '用户运营', '活动'] },
      { key: 'project_ops', label: '项目运营', hints: ['种植', '正畸', '儿牙', '修复', '美学'] },
      { key: 'ai', label: 'AI', hints: ['AI办公', 'AI营销', 'GEO'] },
    ],
  },
};

// ====================企业类型归一化（四值 → 口径） ====================
// 背景：企业类型已从 2 种扩到 4 种（store/companyStore.jsx 的 COMPANY_TYPE_KEYS：
// manufacturer / clinic / doctor / platform）。学习站的内容数据（ROLE_LEARNING 角色、
// TUTORIAL_LIBRARY.companyTypes、article.target_company_types）仍是 clinic / manufacturer
// 两套口径，因此需要把 4 种企业类型折叠回两套内容口径，否则 doctor / platform 企业
// 在学习站里命中不到任何课程与推荐。
//
// 口径与 capabilities/registry.js 的 CAP_SET_OF_TYPE 保持一致：
//   doctor → C 端（患者/门诊）口径；platform → B 端（厂家）口径。
//
// 注意：data 层保持零依赖，这里不 import store，避免与 services → store 的引用成环。
// 映射键需与 COMPANY_TYPE_KEYS 同步维护。
export const LEARNING_TYPE_OF_COMPANY = {
  manufacturer: 'manufacturer',
  clinic: 'clinic',
  doctor: 'clinic',
  dealer: 'manufacturer', // 经销商沿用厂家 B 端口径（P2 再分化专属课程口径）
  platform: 'manufacturer',
};

/** 企业类型 → 学习内容口径（'clinic' | 'manufacturer'）。未知类型回落 'manufacturer'，与 LearningStation 的默认值一致。 */
export function learningCompanyType(companyType) {
  return LEARNING_TYPE_OF_COMPANY[String(companyType || '').trim()] || 'manufacturer';
}

/** 由 companyType + 角色推导「学习角色」。兼容 doctor / platform 两种企业类型。 */
export function resolveLearningRole(companyType, role) {
  // 医生角色优先（无论厂家/门诊，只要角色是医生）
  if (role === 'doctor') return 'doctor';
  // 医生个人企业：走医生学习视角（学临床、平台获客、个人 IP）
  if (companyType === 'doctor') return 'doctor';
  // 厂家与平台企业：走 B 端口径（产品技术、渠道、学术、展会）
  if (companyType === 'manufacturer' || companyType === 'platform') return 'manufacturer';
  if (role === 'owner' || role === 'admin') return 'owner';
  return 'operator';
}

export function roleLabel(key) {
  return (ROLE_LEARNING[key] && ROLE_LEARNING[key].label) || '运营';
}

/**
 * 企业类型中文标签。未知/旧值回落为「口腔厂家」，保持历史行为。
 * ⚠️ 本文件是**零依赖 data 层**（见文件头约定：不 import store / 不做 AI 逻辑），
 *    故此处**不 import config/companyTypeConfig.js**，而是**显式分支**，
 *    与 **SSOT `config/companyTypeConfig.js` 的 doctor/platform `label`（口腔医生 / 口腔平台）逐字对齐**；
 *    全仓类型中文名的唯一真源 = config 的 label 两行，本文件只是同步副本（data 层惯例）。
 * @param {string} companyType 企业类型 key
 * @returns {string}
 */
export function companyTypeLabel(companyType) {
  if (companyType === 'clinic') return '口腔门诊';
  if (companyType === 'doctor') return '口腔医生';
  if (companyType === 'dealer') return '经销商';
  if (companyType === 'platform') return '口腔平台';
  return '口腔厂家';
}

// ==================== 信息源层级 ====================
export const SOURCE_LEVELS = {
  official: { label: 'S·官方/权威', color: 'var(--c-brand-dark)', rank: 0 },
  professional: { label: 'A·专业媒体', color: 'var(--c-text-2)', rank: 1 },
  industry: { label: 'A·行业媒体', color: 'var(--c-text-2)', rank: 1 },
  marketing: { label: 'B·营销/技术', color: 'var(--c-warn)', rank: 2 },
};

// ==================== 精选信息源种子（S/A/B 三层） ====================
// 只收录可核实、稳定公开的官方/权威/专业来源。url 为官网/栏目入口。
//
// rssUrl 说明（重要）：凡是填了 rssUrl 的源，都是 2026-09 用 node fetch 实测过
// 「HTTP 200 + 返回 <item>/<entry> 有效条目」的真实可用订阅地址；
// 凡是 rssUrl 为 '' 并标注「无公开RSS」的，表示实测无可用公开订阅（404/403/WAF/非 XML），
// 未实测过的一律留空，绝不臆造地址。
export const SEED_SOURCES = [
  // ---- S 级：中国官方/权威 ----
  // 【0.21.27 复测修正，2026-11-07 本机 curl 逐跳实测】
  //   http://www.cndent.com/rss → **301**（响应头 `X-Redirect-By: WordPress`）跳到 /feed；
  //   http://www.cndent.com/feed → 200 但**只有 2~4 条 <item>**，而且传输经常挂住不结束
  //   （curl 收到 16KB 后 timeout），主进程那边同样容易判失败；
  //   更关键的是这 2~4 条里多数是「新华社时政通稿」转载，不是口腔资讯 —— 放进门诊学习内容
  //   只会让老板觉得「内容十分糟糕」。⇒ 订阅地址置空（= 本站没有可用公开订阅），
  //   源条目本身保留（官网入口仍可用于「手动添加」与跳转）。
  //   ⚠️ 不许把 rssUrl 改回 http://www.cndent.com/rss：那是一条会 301 到 /feed 的慢链接，
  //      抓取侧只会得到「失败」，而失败再被渲染成「今天没有新内容」就是本轮要修的那个假话。
  { id: 'csa', name: '中华口腔医学会', url: 'https://www.cndent.com', rssUrl: '', country: 'CN', language: 'zh', category: 'policy', source_level: 'official', enabled: true },
  // 实测：/rss.xml → 404；无公开RSS
  { id: 'nmpa', name: '国家药品监督管理局', url: 'https://www.nmpa.gov.cn', rssUrl: '', country: 'CN', language: 'zh', category: 'policy', source_level: 'official', enabled: true },
  // 实测：/rss.xml → 404；无公开RSS
  { id: 'nhsa', name: '国家医保局', url: 'https://www.nhsa.gov.cn', rssUrl: '', country: 'CN', language: 'zh', category: 'policy', source_level: 'official', enabled: true },
  // 实测：/rss.xml → 404；无公开RSS
  { id: 'nhc', name: '国家卫生健康委员会', url: 'https://www.nhc.gov.cn', rssUrl: '', country: 'CN', language: 'zh', category: 'policy', source_level: 'official', enabled: true },
  // 无公开RSS（数据库下载页）
  { id: 'nmpa_udi', name: '药监局 UDI 数据库', url: 'https://udi.nmpa.gov.cn/download.html', rssUrl: '', country: 'CN', language: 'zh', category: 'product', source_level: 'official', enabled: true },
  // ---- S 级：海外官方/权威 ----
  // 实测：/rss.xml 返回 500 错误页、/en/rss 与 /en/publications/ada-news/rss 均 404；无公开RSS
  { id: 'ada', name: '美国牙医协会 ADA', url: 'https://www.ada.org', rssUrl: '', country: 'US', language: 'en', category: 'tech', source_level: 'official', enabled: true },
  // 实测：https://www.fdiworlddental.org/rss.xml → 200，RSS2.0，有 <item>
  { id: 'fdi', name: '世界牙科联盟 FDI', url: 'https://www.fdiworlddental.org', rssUrl: 'https://www.fdiworlddental.org/rss.xml', country: 'INT', language: 'en', category: 'tech', source_level: 'official', enabled: true },
  // 实测：多个 rss 路径均返回「Not found」；无公开RSS
  { id: 'fda', name: '美国 FDA', url: 'https://www.fda.gov', rssUrl: '', country: 'US', language: 'en', category: 'policy', source_level: 'official', enabled: true },
  // 实测：https://tools.cdc.gov/api/v2/resources/media/132608.rss → 200，RSS2.0，有 <item>
  { id: 'cdc', name: '美国 CDC', url: 'https://www.cdc.gov', rssUrl: 'https://tools.cdc.gov/api/v2/resources/media/132608.rss', country: 'US', language: 'en', category: 'policy', source_level: 'official', enabled: true },
  // 实测：https://www.who.int/rss-feeds/news-english.xml → 200，有 <item>
  { id: 'who_news', name: '世界卫生组织 WHO 新闻', url: 'https://www.who.int/news', rssUrl: 'https://www.who.int/rss-feeds/news-english.xml', country: 'INT', language: 'en', category: 'policy', source_level: 'official', enabled: true },
  // ---- A 级：专业行业媒体 ----
  // 实测：/rss 与 /feed 均被 Cloudflare 拦截（403）；无公开RSS
  { id: 'dentaleconomics', name: 'Dental Economics', url: 'https://www.dentaleconomics.com', rssUrl: '', country: 'US', language: 'en', category: 'industry', source_level: 'professional', enabled: true },
  // 实测：https://www.dentistry.co.uk/feed/ → 200，RSS2.0，有 <item>
  { id: 'dentistryuk', name: 'Dentistry.co.uk', url: 'https://www.dentistry.co.uk', rssUrl: 'https://www.dentistry.co.uk/feed/', country: 'UK', language: 'en', category: 'industry', source_level: 'professional', enabled: true },
  // 实测：/feed/ → 415 Unsupported Media Type；无公开RSS
  { id: 'dentaltribune', name: 'Dental Tribune', url: 'https://www.dental-tribune.com', rssUrl: '', country: 'INT', language: 'en', category: 'industry', source_level: 'professional', enabled: true },
  // 实测：/rss.php 403、/rss 404；无公开RSS
  { id: 'kq88', name: '口腔88网', url: 'https://www.kq88.com', rssUrl: '', country: 'CN', language: 'zh', category: 'tech', source_level: 'professional', enabled: true },
  // 实测：/rss 返回站点维护页；无公开RSS
  { id: 'yayi360', name: '牙医在线', url: 'https://www.iyayi.com', rssUrl: '', country: 'CN', language: 'zh', category: 'tech', source_level: 'professional', enabled: true },
  // 实测：/rss 与 /rss/all 均 404；无公开RSS
  { id: 'medlive', name: '梅斯医学', url: 'https://www.medlive.cn', rssUrl: '', country: 'CN', language: 'zh', category: 'tech', source_level: 'professional', enabled: true },
  // 实测：/rss 与 /rss/news 均返回 HTML 首页；无公开RSS
  { id: 'dxy', name: '丁香园', url: 'https://www.dxy.cn', rssUrl: '', country: 'CN', language: 'zh', category: 'tech', source_level: 'professional', enabled: true },
  // 实测：https://www.dentalnews.com/feed/ → 200，RSS2.0，有 <item>
  { id: 'dentalnews', name: 'Dental News（国际牙科资讯）', url: 'https://www.dentalnews.com', rssUrl: 'https://www.dentalnews.com/feed/', country: 'US', language: 'en', category: 'industry', source_level: 'professional', enabled: true },
  // 实测：https://www.dentalproductsreport.com/rss → 200，有 <item>
  { id: 'dentalproducts', name: 'Dental Products Report（器械耗材）', url: 'https://www.dentalproductsreport.com', rssUrl: 'https://www.dentalproductsreport.com/rss', country: 'US', language: 'en', category: 'product', source_level: 'professional', enabled: true },
  // 实测：https://www.medicaldesignandoutsourcing.com/feed/ → 200，有 <item>
  { id: 'medicaldesign', name: 'Medical Design & Outsourcing（器械设计）', url: 'https://www.medicaldesignandoutsourcing.com', rssUrl: 'https://www.medicaldesignandoutsourcing.com/feed/', country: 'US', language: 'en', category: 'product', source_level: 'professional', enabled: true },
  // 实测：https://medicalxpress.com/rss-feed/ → 200，有 <item>
  { id: 'medicalxpress', name: 'Medical Xpress（医学研究速报）', url: 'https://medicalxpress.com', rssUrl: 'https://medicalxpress.com/rss-feed/', country: 'INT', language: 'en', category: 'tech', source_level: 'professional', enabled: true },
  // 实测：https://www.tmtpost.com/rss.xml → 200，有 <item>
  { id: 'tmtpost', name: '钛媒体', url: 'https://www.tmtpost.com', rssUrl: 'https://www.tmtpost.com/rss.xml', country: 'CN', language: 'zh', category: 'industry', source_level: 'professional', enabled: true },
  // 实测：https://www.chinanews.com.cn/rss/importnews.xml → 200，有 <item>
  { id: 'chinanews', name: '中国新闻网', url: 'https://www.chinanews.com.cn', rssUrl: 'https://www.chinanews.com.cn/rss/importnews.xml', country: 'CN', language: 'zh', category: 'industry', source_level: 'professional', enabled: true },
  // 【0.21.27 · 补中文源】实测（2026-11-07 本机 curl）：https://www.chinanews.com.cn/rss/health.xml
  //   → 200，`text/xml`，**25 条 <item>**，中文健康新闻（立冬防寒 / 老年慢病 / 医疗合作…）。
  //   它是**大众健康媒体**，不是口腔专业媒体 —— 所以不和 dental_professional 混层，
  //   单列 `health_zh`（中文健康/医学媒体，口腔相邻）；口腔相关与否仍交给
  //   judgeDentalRelevance（AI 判 + 关键词规则降级）再筛一道，不在源层面假装它专业。
  { id: 'chinanews_health', name: '中国新闻网 · 健康', url: 'https://www.chinanews.com.cn/health/', rssUrl: 'https://www.chinanews.com.cn/rss/health.xml', country: 'CN', language: 'zh', category: 'industry', source_level: 'professional', enabled: true },
  // ---- B 级：营销/技术 ----
  // 官网新闻页无订阅；无公开RSS
  { id: 'meituan_news', name: '美团口腔动态', url: 'https://www.meituan.com/news', rssUrl: '', country: 'CN', language: 'zh', category: 'industry', source_level: 'marketing', enabled: true },
  // 无公开RSS
  { id: 'xiaohongshu_trend', name: '小红书行业趋势', url: 'https://www.xiaohongshu.com', rssUrl: '', country: 'CN', language: 'zh', category: 'ai', source_level: 'marketing', enabled: true },
  // 实测：/rss → 404；无公开RSS
  { id: 'deepseek_news', name: 'DeepSeek 官方动态', url: 'https://www.deepseek.com', rssUrl: '', country: 'CN', language: 'zh', category: 'ai', source_level: 'marketing', enabled: true },
  // 实测：https://openai.com/news/rss.xml → 200，RSS2.0，有 <item>
  { id: 'openai_news', name: 'OpenAI 官方', url: 'https://openai.com/news', rssUrl: 'https://openai.com/news/rss.xml', country: 'US', language: 'en', category: 'ai', source_level: 'marketing', enabled: true },
  // 实测：https://www.qbitai.com/feed → 200，有 <item>
  { id: 'qbitai', name: '量子位（AI 前沿）', url: 'https://www.qbitai.com', rssUrl: 'https://www.qbitai.com/feed', country: 'CN', language: 'zh', category: 'ai', source_level: 'marketing', enabled: true },
  // 实测：https://www.woshipm.com/feed → 200，有 <item>
  { id: 'woshipm', name: '人人都是产品经理', url: 'https://www.woshipm.com', rssUrl: 'https://www.woshipm.com/feed', country: 'CN', language: 'zh', category: 'ai', source_level: 'marketing', enabled: true },
  // 实测：https://www.yunyingpai.com/feed → 200，有 <item>
  { id: 'yunyingpai', name: '运营派（营销运营实操）', url: 'https://www.yunyingpai.com', rssUrl: 'https://www.yunyingpai.com/feed', country: 'CN', language: 'zh', category: 'industry', source_level: 'marketing', enabled: true },
  // 实测：https://www.geekpark.net/rss → 200，有 <item>
  { id: 'geekpark', name: '极客公园', url: 'https://www.geekpark.net', rssUrl: 'https://www.geekpark.net/rss', country: 'CN', language: 'zh', category: 'ai', source_level: 'marketing', enabled: true },
  // 实测：https://rss.sina.com.cn/tech/rollnews.xml → 200，有 <item>
  { id: 'sina_tech', name: '新浪科技', url: 'https://tech.sina.com.cn', rssUrl: 'https://rss.sina.com.cn/tech/rollnews.xml', country: 'CN', language: 'zh', category: 'ai', source_level: 'marketing', enabled: true },
];

// ==================== 实操教学库（可直接照着做的 SOP） ====================
// 定位：不是「道理」，是「今天照着做就能上线」的动作清单。
// 每篇结构：steps（怎么做，≥4 步）/ checklist（验收清单，≥4 项，可勾）/ pitfalls（常见坑，≥3 条）。
// audience 用学习角色 key：operator / manufacturer / doctor / owner（与 ROLE_LEARNING 一致）。
export const TUTORIAL_LIBRARY = [
  {
    id: 'tut-meituan-entry',
    title: '美团 / 大众点评口腔品类入驻与起量 SOP',
    // doctor：⚠️ 待裁决（见四主体适配说明）。本课前置《医疗机构执业许可证》+ 消防安全检查合格证，
    // 属「机构开店」而非「医生个人 IP / 内容」范畴，按「宁可少推荐」原则暂不开放给 doctor。
    audience: ['owner', 'operator'],
    companyTypes: ['clinic'],
    difficulty: '入门',
    minutes: 25,
    intro: '口腔门诊在美团/点评上拿到第一批真实到店，靠的不是投钱，而是「资质齐全 + 团购结构对 + 评价冷启动」。',
    steps: [
      { t: '备齐资质材料', d: '营业执照、医疗机构执业许可证、诊疗科目、医生执业证书与职称、门头照与诊室实景照（≥6 张，无患者正脸）。先在「美团开店宝/点评商家版」提交行业资质预审，避免反复驳回。' },
      { t: '选对经营品类与门店定位', d: '主营品类选「口腔/齿科」，门店标签勾选洗牙、补牙、拔牙、正畸、种植等实际开展项目；定位到门牌号，服务半径按实际覆盖 3~5 公里填写。' },
      { t: '搭三层团购结构', d: '引流款（洁牙/检查套餐，低价高转化）+ 主推款（补牙/美白，贡献利润）+ 高客单款（正畸/种植，走咨询留资）。引流款必须有明确的到店路径和二次转化话术。' },
      { t: '评价冷启动', d: '开业/上新首月，用「到店后引导真实评价」替代刷评：前台在结算时当面邀请，配合合规的满意度回访，禁止以返现换好评（平台会判罚且违规）。' },
      { t: '数据复盘与调价', d: '每周看曝光→访问→下单→到店四级漏斗，访问低改主图与标题，下单低改价格与套餐内容，到店低改预约链路与客服话术。' },
    ],
    checklist: [
      '营业执照 + 医疗机构执业许可证已上传并通过审核',
      '门店定位精确到门牌号，电话可接通',
      '至少 6 张实景图（门头/前台/诊室/设备），无患者正脸',
      '团购已配齐引流款、主推款、高客单款三类',
      '每个团购都写清适用人群、禁忌与是否含检查费',
      '评价回复 SOP 已建好，24 小时内响应差评',
    ],
    pitfalls: [
      '用「最低价洁牙」冲量但不做二次转化，赔本且拉低客单，后续涨价差评暴涨',
      '团购文案出现「无痛」「根治」「最好」「保证不复发」等绝对化/疗效承诺词，属违规',
      '医生资质与主推项目不匹配（如无正畸资质主推正畸），会被平台下架并处罚',
      '刷评价/返现求好评：美团风控识别后会降权甚至关店，且涉嫌不正当竞争',
      '只投推广不等评价积累就加大预算，转化率低，钱花在漏斗漏的位置',
    ],
  },
  {
    id: 'tut-map-poi',
    title: '高德 / 百度地图门店标注与POI运营',
    // doctor：⚠️ 待裁决（见四主体适配说明）。门店 POI 标注是机构行为（需营业执照 + 执业许可证），
    // 与「医生个人 IP / 内容」定位不符，按「宁可少推荐」原则暂不开放给 doctor。
    audience: ['owner', 'operator'],
    companyTypes: ['clinic'],
    difficulty: '入门',
    minutes: 20,
    intro: '地图是本地口腔门诊被「附近的人」找到的第一入口。标注做对，等于免费拿到一个高意向流量位。',
    steps: [
      { t: '认领门店', d: '下载「高德地图商户版」「百度地图商户中心」，搜索自家门店名；搜不到就点「新增门店/认领」，按营业执照上的 exact 名称提交，避免名称不一致被驳回。' },
      { t: '提交资质并等待审核', d: '上传营业执照、医疗机构执业许可证、门头照与法人/经办人身份证明。医疗行业审核更严，名称必须与执业许可证一致，通常 1~3 个工作日。' },
      { t: '完善 POI 信息', d: '填全营业时间（含周末）、电话、科室/主营项目、停车与地铁信息、门店相册（门头+前台+诊室）。主营项目里把「洗牙、补牙、拔牙、正畸、种植、儿牙」等真实开展项填进去，这是搜索命中关键。' },
      { t: '挂地图专属权益', d: '在商户后台配置「地图到店券/预约入口」，让从地图进来的人有明确的下一步动作，而不是只看个地址。' },
      { t: '持续维护', d: '每周检查一次信息是否被用户误改；鼓励到店患者在地图留下真实评价；节假日更新营业时间，避免「白跑一趟」差评。' },
    ],
    checklist: [
      '门店名称与医疗机构执业许可证完全一致',
      '高德、百度、腾讯地图三端均已认领成功',
      '电话可接通且有人接（非占线/空号）',
      '营业时间、停车、交通信息填写完整',
      '主营项目标签覆盖了门诊真实开展的品类',
      '门头照清晰可辨认，与导航终点一致',
    ],
    pitfalls: [
      '门店名里塞营销词（如「XX口腔·种植牙第一品牌」），会被审核驳回或要求改名',
      'POI 定位点落在商场中心或马路对面，导航把患者带到错误入口，直接产生差评',
      '只标注不运营：电话无人接、营业时间错误，等于把免费流量变成负面口碑',
      '找第三方代标注泄露营业执照原件照片，存在被冒用风险，尽量自行在官方后台提交',
    ],
  },
  {
    id: 'tut-doctor-ip',
    title: '医生个人 IP 与权威性建设（0 到 1）',
    // doctor：✅ 明确该看 —— 本课就是为医生个人写的（个人 IP / 专业形象 / 内容输出）。
    // platform：❌ 不给 —— 平台企业不做医生个人 IP。
    audience: ['doctor', 'owner'],
    companyTypes: ['clinic', 'manufacturer', 'doctor'],
    difficulty: '进阶',
    minutes: 35,
    intro: '患者选口腔医生，本质是选「可信」。权威感来自可被验证的资质 + 持续稳定的专业输出，不是人设包装。',
    steps: [
      { t: '锁定一个细分方向', d: '不要做「什么都会的口腔医生」。选一个能长期输出的方向：如儿牙早矫、显微根管、种植修复、牙周维护。细分越清晰，患者越容易记住并转介绍。' },
      { t: '把资质摆到台面上', d: '在主页/简介里写清：执业医师资格、职称、主攻方向、年限、学会任职、进修与培训经历。所有信息必须真实可查，禁止虚构头衔。' },
      { t: '建立内容生产节奏', d: '固定每周 2~3 条：一条病例科普（去标识化，不得暴露患者信息）、一条常见误区澄清、一条治疗过程答疑。用「问题—原理—选择—注意」四段结构，短而具体。' },
      { t: '做权威背书', d: '参加学会继续教育、发表科普文章、参与行业会议分享，把这些真实经历同步到账号主页，形成可信证据链。' },
      { t: '设计咨询闭环', d: '每条内容都要有明确的下一步：评论答疑、私信预约、到面诊评估。把「看内容的人」变成「能联系到你的人」。' },
    ],
    checklist: [
      '个人简介中资质、职称、主攻方向全部真实且可查证',
      '已选定并坚持一个细分方向（不是全科泛讲）',
      '每周固定产出 2~3 条内容，连续 4 周不断更',
      '病例内容已做去标识化处理（无姓名/面部/病历号）',
      '主页留有明确的咨询/预约入口',
      '内容中出现疗效、风险时已加「需面诊评估」提示',
    ],
    pitfalls: [
      '晒患者术前术后对比图未脱敏，违反患者隐私与《医疗广告管理办法》',
      '使用「最好」「第一」「根治」「无痛」等绝对化用语，属医疗广告违规',
      '虚构「XX学会常委」「XX专家」等头衔，一旦被举报，账号与门诊都会受罚',
      '内容天天换方向，患者记不住你擅长什么，转介绍无从谈起',
      '只发专业术语不看患者视角，播放量高但无人咨询',
    ],
  },
  {
    id: 'tut-content-compliance',
    title: '牙科内容合规红线清单（发布前必查）',
    // doctor：✅ 该看 —— 医生发科普同样受《医疗广告管理办法》约束（禁疗效承诺、禁术前术后对比）。
    // platform：✅ 该看 —— 平台方需要这套口径去审核平台上商家的医疗内容；
    //           且本课不含「患者到店 / 医患转化 / 门诊成交」等 C 端成交内容，不触碰 platform 红线。
    audience: ['operator', 'owner', 'doctor', 'manufacturer'],
    companyTypes: ['clinic', 'manufacturer'],
    difficulty: '入门',
    minutes: 15,
    intro: '口腔属于医疗行业，内容一旦踩线不只是删帖，可能触发广告违法处罚。这份清单是发布前的最后一道闸。',
    steps: [
      { t: '先判断是不是「医疗广告」', d: '只要内容里出现机构名称/地址/联系方式，或指向具体诊疗服务并引导就诊，就可能被认定为医疗广告，需要按广告合规处理。' },
      { t: '禁词自查', d: '删除或替换：根治、包治、无痛、绝对、最、第一、保证、永不复发、100%、特效、专家推荐、治愈率 XX%。改成「需面诊评估」「个体差异较大」「以检查结果为准」。' },
      { t: '疗效与案例处理', d: '不得使用患者名义/形象作证明；不得展示未经脱敏的病历、检查报告、术前术后对比图；如确需说明效果，必须同时说明风险与个体差异。' },
      { t: '资质与许可核对', d: '投放/发布涉及具体诊疗项目的内容前，确认该诊疗科目已在《医疗机构执业许可证》登记，且主诊医生具备相应资质。' },
      { t: '留痕与复核', d: '建立「发布前双人复核」制度，把每篇内容的审核人、审核时间、修改记录存档，出问题时可追溯。' },
    ],
    checklist: [
      '全文无「根治/包治/无痛/最/第一/保证」等绝对化词语',
      '未使用患者名义、形象或病例作疗效证明',
      '所有影像资料已完成脱敏（无姓名、面部、病历号）',
      '涉及诊疗项目的内容与该机构执业许可科目一致',
      '涉及医生出镜的，其资质与出镜身份一致',
      '已留存审核记录（审核人 + 时间 + 版本）',
    ],
    pitfalls: [
      '把「科普」当挡箭牌：只要挂了机构名和联系方式，科普也会被认定为广告',
      '用患者聊天截图当好评素材，属于利用患者作证明，明确违规',
      '投放信息流时未取得《医疗广告审查证明》，被平台拒审或下架',
      '厂家在内容里替门诊写疗效承诺，风险由发布方和品牌方共担',
      '用「医生个人号」绕开机构审核，出问题仍会追责到执业机构',
    ],
  },
  {
    id: 'tut-private-community',
    title: '私域社群 0 到 1（患者/客户不流失）',
    audience: ['operator', 'owner', 'manufacturer'],
    companyTypes: ['clinic', 'manufacturer'],
    difficulty: '进阶',
    minutes: 30,
    intro: '公域是一次性流量，私域才是复诊与转介绍的主阵地。社群的价值不在人数，在有响应、有节奏、有转化路径。',
    steps: [
      { t: '明确社群定位', d: '一个社群只服务一类人：如「正畸随访群」「儿牙家长群」「种植术后维护群」「经销商技术服务群」。定位清楚，内容才好做，成员才不屏蔽。' },
      { t: '设计入群钩子与路径', d: '到店/咨询后由专人邀请入群，话术要说明「进群能得到什么」（术后答疑、复查提醒、专属答疑时段），并当面完成添加，不放一张易被忽略的海报。' },
      { t: '固定内容节奏', d: '每周固定栏目：周一科普、周三答疑（医生固定时段在线）、周五案例/提醒。节奏稳定，成员才会养成查看习惯。' },
      { t: '设好运营规则', d: '群规写明：禁广告、禁人身攻击、隐私问题转私聊、答疑时间范围。置顶公告保持更新，新成员入群自动推送。' },
      { t: '建立转化与召回机制', d: '按治疗阶段做标签（术后 1 周/1 月/复查期），到期主动提醒复查；对沉默成员做一对一回访而不是群内刷屏。' },
    ],
    checklist: [
      '社群定位单一明确，不是「什么都聊的大杂烩」',
      '入群路径已跑通（到店 → 专人邀请 → 当面添加）',
      '每周固定栏目表已排出且连续执行 4 周以上',
      '群规已置顶，答疑时段与医生排班已确认',
      '成员按治疗阶段/客户类型打标签，能定向触达',
      '有明确的复查提醒与沉默召回动作记录',
    ],
    pitfalls: [
      '把群当广告位天天发促销，成员屏蔽后社群彻底失效',
      '在群内讨论患者具体病情，泄露隐私且违反医疗信息安全要求',
      '承诺「群里随时问医生都能回」但无人值守，信任崩塌更快',
      '只拉人不分层，术后患者和新咨询客户混在一起，内容无法命中',
      '用机器人刷活跃度，真实成员察觉后反而降低信任',
    ],
  },
  {
    id: 'tut-moments-calendar',
    title: '门诊朋友圈内容日历（一个月照着发）',
    audience: ['operator', 'owner'],
    companyTypes: ['clinic'],
    difficulty: '入门',
    minutes: 20,
    intro: '门诊朋友圈不是发广告，是让附近的人持续看到「这家门诊在认真做事」。稳定输出比爆款更重要。',
    steps: [
      { t: '确定内容四象限', d: '专业科普（让人信任）、门诊日常（让人熟悉）、患者故事（让人共情，须脱敏并获同意）、服务信息（让人知道怎么找你）。四类轮换，不做纯广告号。' },
      { t: '排出月度日历', d: '按周定主题：第1周口腔常识、第2周常见误区、第3周门诊日常与团队、第4周案例答疑与活动。每周 3~4 条，固定发布时间（早 8 点 / 午 12 点 / 晚 8 点）。' },
      { t: '建立素材池', d: '随手拍：整洁的诊室、消毒流程、器械封装、医生讲解模型、团队培训。素材真实即可，不需要精致修图，反而是「真实感」建立信任。' },
      { t: '统一表达模板', d: '每条按「问题/场景 → 为什么 → 怎么做 → 什么时候该来门诊」写，结尾一句明确的行动指引（如「洗牙前先做检查，预约可私信」）。' },
      { t: '每月复盘选题', d: '记录每条的咨询量（多少人因此私信/到店），把高咨询选题加入下月复用清单，低互动选题换角度或淘汰。' },
    ],
    checklist: [
      '本月四周主题已排定，每周 3~4 条',
      '内容四象限齐全，纯广告内容占比低于 20%',
      '所有患者相关内容已完成脱敏或已获书面同意',
      '全文无绝对化用语与疗效承诺',
      '发布时间固定在每天 3 个时段之一',
      '每条都留有明确的下一步行动指引',
    ],
    pitfalls: [
      '一天连发 5 条刷屏，被大量屏蔽，等于自断渠道',
      '只发活动海报不带任何解释，用户不知道这对他有什么用',
      '直接转发厂家素材，多个门诊发同一张图，完全失去辨识度',
      '患者照片未获同意就发布，涉及肖像权与医疗隐私双重风险',
      '从不回复评论私信，流量进来也接不住',
    ],
  },
];

// ==================== 推荐指数（重要度） ====================
export const IMPORTANCE_STARS = [1, 2, 3, 4, 5];

// ==================== 去重辅助 ====================
/** 标题归一化（去空格/标点，用于相似度去重）。 */
export function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[\s，。、：；！？【】「」""''《》（）()\-—_·]/g, '');
}

export default {
  KNOWLEDGE_CATEGORIES,
  ROLE_LEARNING,
  SOURCE_LEVELS,
  SEED_SOURCES,
  IMPORTANCE_STARS,
  LEARNING_TYPE_OF_COMPANY,
  categoryLabel,
  resolveLearningRole,
  roleLabel,
  companyTypeLabel,
  learningCompanyType,
  normalizeTitle,
};
