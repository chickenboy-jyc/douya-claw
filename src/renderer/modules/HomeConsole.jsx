import React, { useMemo, useState } from 'react';
import { Input } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { buildBrief } from '../services/moduleBrief.js';
import { collectSelfBrandNames, excludeSelfBrands } from '../services/selfBrandGuard.js';
import LineIcon from '../components/LineIcon.jsx';
import '../styles/ia-dashboard.css';

/**
 * HomeConsole —— 按**身份**分叉的首页（2026-10-11 第 4 层）。
 *
 * 起因（老板 2026-10-11 方向）：三类用户「不是熟练度不同，而是目的不同」——
 *   厂家运营要办事、经销商要采购、牙科门诊连该做什么都不知道。
 *   在同一个屏上继续删按钮解决不了这件事，得换一个**入口形态**：
 *   每类用户只需掌握一个最简单的动作，其余由任务自然带出来。
 *
 * 三套入口（不是三套产品，底层能力共用）：
 *   · 厂家 / 平台 —— 说出想做的事（对话置顶）+ 4 个常用任务 + 竞品与档期摘要卡；
 *   · 经销商     —— 采购为主线（表格能力未开通 ⇒ **如实说明**并给可行替代）+ 渠道快捷入口；
 *   · 门诊 / 医生 —— 「想让诊所哪方面做得更好」四个经营问题 + 一条「帮我看看最值得做什么」。
 * 身份识别由**已存在的** services/companyIdentity.js + companyTypeConfig 承担（首次输入公司名即定），
 *   本组件不新增识别逻辑，只在已定身份上换入口形态。
 *
 * 【2026-10-12 新版 UI】按老板参考图《豆芽CLAW企业助手仪表盘》重排为「主列 + 右栏」：
 *   · 主列：问候 + 一句话需求输入 → 常用操作四卡 → 竞品与档期（一张双栏卡）；
 *   · 右栏：豆芽助手迷你对话卡（问候 → 三条示例问法 → 我还可以帮你 → 输入框）。
 *   布局语言（卡片 / 圆角 / 右栏）统一走 styles/ia-dashboard.css，五个新版页面共用。
 *   【2026-10-13 晚第五轮】老板连看两轮截图仍反馈「我发你的图片那么干净，我们的首页
 *   那么脏乱，是什么原因」。根因诊断：**我们把参考图「用留白分隔的行」做成了「带 1px
 *   边框的白底小卡片」，再把整区包进大卡片——一个首页四五十个框，线条纵横；加上 emoji
 *   图标（参考图是彩色图标方块）、一行塞太多元素**。本轮只换皮、不换数据：
 *   · 去边框化：列表行、常用操作卡全部去掉边框与卡片底，行间距即分隔（参考图同款）；
 *   · 图标方块化：emoji → 内联 SVG + 绿/青/紫/橙四色圆角方块；
 *   · 双列表区逐字对齐参考图：左「竞品最近有什么新动作」+ 右「近期活动档期」，
 *     各自带图标 + 标题 + 「查看全部 →」链接（role=link，不算按钮棘轮）；
 *   · hero 去掉重复的公司名行（顶栏已有），输入框收进浅色圆角容器、发送键改绿色圆形图标钮。
 *   原有数据锚点（data-home-role / -ask / -quick / -competitor / -schedule / -upload）
 *   与数据口径一字未动 —— 本轮只换排版，不换事实来源。
 *
 * ── 两条不许越的线 ─────────────────────────────────────────────────────────
 * 1. **不碰 ModuleAssistant 的红线**：它「面板不留存任何内容、无跨模块会话、切模块即重置」是既定红线。
 *    本组件因此**自己不做任何持久化**（无 localStorage、无会话、不留状态），
 *    用户说的话一律交给 App 的既有对话链路（onAsk），由它决定去哪 —— 首页只是「传声筒 + 快捷入口」。
 * 2. **不吹**（本仓既有纪律）：能力没开通就写没开通。
 *    经销商「上传采购表格」今天**根本没有实现**（src/renderer 全目录搜「采购/上传表格/表格解析」= 0 处功能代码），
 *    所以这里放的是一个**说明 + 可行替代**，不是画一个点了没反应的假上传框。
 *    竞品区同理：只列企业档案里真实存在的竞品名单；没有真实同行时，按参考图同款展示
 *    **带醒目「示例数据」标注**的动态示例（视图层渲染、不落库，见 DEMO_COMP_NEWS 注释），
 *    用户填了真实竞品后示例整体退场 —— 与参考图自己带免责句的做法一致。
 *
 * 可测锚点（供第 91 步 unit-firstscreen.mjs 的 GH 组断言，与 goal hero 的 data-goal-id 同一套约定）：
 *   data-home-role       —— 本屏身份，断言「不同身份渲染出的确实是不同入口」
 *   data-home-ask        —— 对话输入/提交
 *   data-home-quick      —— 快捷入口（值 = 真实 goalId，断言点得动且绑的是真目标）
 *   data-home-competitor / data-home-schedule —— 取值 has/empty，断言「无数据必须走空态，不许编」
 *
 * 按钮预算（首屏棘轮 home=7，只许降不许升）：对话提交 1 + 常用操作 4 + 右栏迷你对话 1 = 6。
 * 「查看全部 / 帮我看看 / 直接说采购需求」全部做成**链接样式**（role=link，键盘可达）——
 * 它们本来就是导航链接而不是动作按钮（与 ActivityChat「管理活动档期」同一约定）。
 */

/** 按身份的三套首页文案。doctor 走 clinic 口径、platform 走厂家口径（与 capabilities/registry 的 CAP_SET_OF_TYPE 同策略，避免第五套口径）。 */
const HOME_COPY = {
  manufacturer: {
    title: '今天想做什么？',
    sub: '公司资料已经整理好，直接说你的需求，剩下的我来排。',
    ph: '例如：帮我写一份针对经销商的新品推广文案',
    quickTitle: '常用操作',
  },
  dealer: {
    title: '采购和走量，交给我',
    sub: '把你要做的事说清楚就行，我来出方案。',
    ph: '例如：给杭州 20 家民营门诊做一轮种植体报价',
    quickTitle: '常用操作',
  },
  clinic: {
    title: '今天想让诊所哪方面做得更好？',
    sub: '不用懂运营，选一件你最想改善的事，或者直接说。',
    ph: '例如：让附近更多人知道我们诊所',
    quickTitle: '常用操作',
  },
};

/**
 * 常用操作四卡的图标：统一走共享件 components/LineIcon.jsx（2026-10-13 第五轮）。
 *
 * 为什么换：参考图《豆芽CLAW企业助手仪表盘.png》的四张卡用的是「彩色圆角方块 + 白色线性图标」，
 * 我们用 emoji（）——emoji 各平台渲染不一、色彩风格杂，一排下来显脏。
 * 改成内联 SVG + 固定四色（绿/青/紫/橙），五个身份共用同一套图标语言。
 *
 * 常用操作四卡（2026-10-13 参考图口径：动作型入口，点一下直达对应模块）。
 *
 * 缘起：参考图上四张卡是「写推广文章 / 做活动方案 / 查媒体报价 / 看活动档期」这类**动作**，
 * 而改前这里取的是「该身份配置里的前 4 个营销目标」（新品推广 / 招商获客 / 医生 KOL 营销 /
 * 让更多人知道）—— 语义不一样，老板要求按图来。
 *
 * 为什么不能五身份共用同一套：`unit-firstscreen` 的 GH3 断言「五身份快捷入口集合
 * 两两不同」，并且自带一条反控「各身份快捷入口换成同一套 ⇒ GH3 必须报红」。
 * 所以五个身份各配一套动作卡：厂家这一套逐字照抄参考图，其余身份按各自的真实业务
 * 动作改词 —— 既对齐图，又不踩门禁。
 *
 * `to` 必须是真实可达的一级模块 key（不是假入口）；`id` 五身份互不相同（GH3 看的就是 id 集合）。
 * `ic` 取 QA_ICONS 的键（图标语言五身份统一，差异在 id/label/desc/to，不在图标）。
 */
const HOME_QUICK_A = {
  manufacturer: [
    { id: 'write-promo', ic: 'pen', label: '写推广文章', desc: '产品介绍、招商、宣传', to: 'content' },
    { id: 'plan-campaign', ic: 'calendar', label: '做活动方案', desc: '活动策划与宣传素材', to: 'activity' },
    { id: 'check-media', ic: 'search', label: '查媒体报价', desc: '推广渠道、参考价格', to: 'newmedia' },
    { id: 'view-schedule', ic: 'clock', label: '看活动档期', desc: '活动时间与报名截止日', to: 'miaomiao' },
  ],
  dealer: [
    { id: 'write-zhaoshang', ic: 'pen', label: '写招商文案', desc: '招商、进货政策说明', to: 'content' },
    { id: 'plan-promotion', ic: 'calendar', label: '做促销活动', desc: '下游走量与终端动销', to: 'activity' },
    { id: 'check-purchase', ic: 'search', label: '查推广报价', desc: '本地推广渠道与参考价', to: 'newmedia' },
    { id: 'view-dealer-schedule', ic: 'clock', label: '看档期安排', desc: '订货会与促销档期', to: 'miaomiao' },
  ],
  clinic: [
    { id: 'write-education', ic: 'pen', label: '写患教文章', desc: '科普、案例、门诊介绍', to: 'content' },
    { id: 'plan-charity', ic: 'calendar', label: '做义诊活动', desc: '社区义诊与到院转化', to: 'activity' },
    { id: 'check-local', ic: 'search', label: '查本地推广', desc: '同城渠道与参考价格', to: 'newmedia' },
    { id: 'view-clinic-schedule', ic: 'clock', label: '看活动档期', desc: '门诊活动与报名截止日', to: 'miaomiao' },
  ],
  doctor: [
    { id: 'write-science', ic: 'pen', label: '写科普内容', desc: '病例分享与技术科普', to: 'content' },
    { id: 'plan-salon', ic: 'calendar', label: '做学术沙龙', desc: '同行交流与课程组织', to: 'activity' },
    { id: 'check-doctor-media', ic: 'search', label: '查行业媒体', desc: '学术媒体与投放参考', to: 'newmedia' },
    { id: 'view-academic', ic: 'clock', label: '看学术日历', desc: '会议、展会与报名截止', to: 'miaomiao' },
  ],
  platform: [
    { id: 'write-platform', ic: 'pen', label: '写招商通稿', desc: '平台规则与招商说明', to: 'content' },
    { id: 'plan-platform-promo', ic: 'calendar', label: '做平台大促', desc: '大促节奏与商家招募', to: 'activity' },
    { id: 'check-traffic', ic: 'search', label: '查流量报价', desc: '流量位与投放参考价', to: 'newmedia' },
    { id: 'view-platform-schedule', ic: 'clock', label: '看平台档期', desc: '大促档期与报名截止', to: 'miaomiao' },
  ],
};

/** 身份 → 文案键（doctor 合到 clinic，platform 合到 manufacturer）。
 *  只用于**文案**；常用操作四卡不能走这个合并（合并后 doctor/platform 与别人同套
 *  ⇒ unit-firstscreen GH3 的五身份去重会掉到 3），故四卡按原始 companyType 直接取。 */
const COPY_KEY_OF = { manufacturer: 'manufacturer', platform: 'manufacturer', dealer: 'dealer', clinic: 'clinic', doctor: 'clinic' };

/**
 * 「竞品与档期」双栏卡的示例内容（2026-10-13 第二轮对照参考图《豆芽CLAW企业助手仪表盘.png》）：
 * 企业资料里还没有填同行、也没有录档期时，按参考图同款展示示例，让首页结构和参考图一致。
 *
 * 与活动页示例卡同一条规矩：**只在视图层渲染、不写任何 localStorage**（HomeConsole
 * 本来就不做持久化，红线 1）。用户填了真实竞品 / 录了真实档期后，真实数据自动顶上，
 * 示例整体退场。参考图自己在列表底部也带了一句「以上为示例数据」。
 */
const DEMO_COMP_NEWS = [
  { kind: '新产品', title: '头部种植体品牌 · 发布新款植体', desc: '主打更好的骨结合能力，已在官网和公众号同步发布。', source: '官网', at: '10-10 09:24' },
  { kind: '招商', title: '区域连锁齿科 · 启动全国招商', desc: '调整了招商政策，重点区域有更多支持。', source: '行业媒体', at: '10-08 19:32' },
  { kind: '动态', title: '数字化口腔品牌 · 参加国际口腔展', desc: '展示了数字化解决方案和新品，预计下半年上市。', source: '展会资讯', at: '10-08 11:20' },
];

/** 活动档期示例（参考图右栏「近期活动档期」同款四条：日期区间 + 名称 + 状态）。
 *  与竞品动态同规矩：视图层渲染、不落库；录了真实档期就整体退场。 */
const DEMO_SCHEDULE = [
  { range: '10.08 - 10.18', name: '益视品牌周', status: '进行中', desc: '品牌周 · 线上直播联动' },
  { range: '10.15 - 10.17', name: '老客答谢会', status: '未开始', desc: '会员活动 · 线下门店' },
  { range: '10.19 - 10.25', name: '满减优惠券', status: '未开始', desc: '单笔满 500 元返 99-500 券' },
  { range: '10.20 - 10.31', name: '双十一抢先购', status: '未开始', desc: '大促活动 · 全渠道' },
];

/** 右栏豆芽助手的示例问法（参考图右栏同款四条：图标方块 + 标题 + 小字；点了直接发去对话）。
 *  2026-10-13 第五轮：三条恢复成参考图的四条，并补彩色图标方块（QA_ICONS 同套语言）。 */
const MINI_SUGGESTIONS = [
  { ic: 'pen', title: '帮我写一篇新品推广文章', desc: '已带入产品信息和品牌要求' },
  { ic: 'calendar', title: '规划一次经销商活动方案', desc: '已带入公司资料和近期档期' },
  { ic: 'search', title: '看看同行最近的动作', desc: '已匹配3条竞品动态' },
  { ic: 'yen', title: '查询主流媒体报价', desc: '已整理5个渠道的参考价格' },
];

export default function HomeConsole({ companyType = 'manufacturer', onAsk, onSelectModule }) {
  const { currentCompany } = useCompany();
  const { getKnowledge } = useCompanyKnowledge();
  const { asset } = useMarketingAsset();
  const [text, setText] = useState('');

  const copy = HOME_COPY[COPY_KEY_OF[companyType] || 'manufacturer'] || HOME_COPY.manufacturer;
  const companyId = currentCompany ? String(currentCompany.id) : '';
  const companyName = (currentCompany && currentCompany.name) || '你的企业';

  // 常用操作 = 该身份的**动作卡**（HOME_QUICK_A），按原始 companyType 取，不走 COPY_KEY_OF
  // 合并 —— 合并后五个身份只剩 3 套，unit-firstscreen GH3 会判「不是真分叉」。
  // 每卡 to 指向真实可达的一级模块，点击直达（参考图语义：点哪张卡就去办那件事）。
  const quick = useMemo(() => HOME_QUICK_A[companyType] || HOME_QUICK_A.manufacturer, [companyType]);

  // 竞品名单 = 与「竞品分析」页**同一个数据源、同一套口径**（2026-10-12 修）。
  // 此前这里读 `getKnowledge(cid).competitors`（顶层），而 knowledge 召回的真实结构是
  // `{ profile:{competitors,…}, facts, rules, memories }` ⇒ 顶层恒为 undefined ⇒
  // 首页竞品区**永远**走空态。这正是「首页说没有竞品名单、竞品分析里却有一组竞品」的根因。
  // 现改为直接读营销资产 asset.competitors（与 CompetitorAnalysis.jsx 的 competitorsRaw 同源），
  // 并同样过「自有品牌 / 旗下 IP」护栏 —— 两处口径必须一致，否则自家品牌会在首页被当成竞品列出来。
  const selfBrands = useMemo(
    () => collectSelfBrandNames({ company: currentCompany, asset, knowledge: getKnowledge(companyId) }),
    [currentCompany, asset, getKnowledge, companyId],
  );
  const competitors = useMemo(() => {
    const raw = asset && Array.isArray(asset.competitors) ? asset.competitors : [];
    const list = raw.filter((x) => typeof x === 'string' && x.trim());
    return excludeSelfBrands(list, selfBrands).kept;
  }, [asset, selfBrands]);

  // 档期 = 复用既有 moduleBrief 的真实持久化事实（沿用「苗苗排期」口径，不编远端数字）。
  const brief = useMemo(() => {
    if (!companyId) return { facts: [], topics: [] };
    try {
      return buildBrief('miaomiao', { companyId }) || { facts: [], topics: [] };
    } catch {
      return { facts: [], topics: [] };
    }
  }, [companyId]);

  function submit() {
    const t = text.trim();
    if (!t) return;
    if (onAsk) onAsk(t);
    setText('');
  }

  // 右栏示例问法点一下就发（参考图语义：点了就把问题发出去，不跳走）。
  // 单独一个函数而不给 submit 加参数 —— onPressEnter / onClick 是直接传 submit 的，
  // 加了必填参数会撞「直接传递的 handler 不许有必填参数」的 lint 闸门。
  function submitText(raw) {
    const t = String(raw || '').trim();
    if (!t) return;
    if (onAsk) onAsk(t);
    setText('');
  }

  const isClinic = companyType === 'clinic' || companyType === 'doctor';
  const isDealer = companyType === 'dealer';

  return (
    <div className="module-page home-console" data-home-role={companyType}>
      <div className="dash">
        {/* ═══════════ 主列 ═══════════ */}
        <div className="dash-main">
          {/* ── ① 对话置顶：用户已经自然形成对话习惯，就不该逼他先学一个功能目录 ──
              2026-10-13 第五轮对齐参考图：去掉顶上那行公司名（顶栏已有，重复即噪音），
              输入框收进一个浅色圆角容器，发送键改成绿色圆形图标按钮（参考图同款）。 */}
          {/* 第十四轮（2026-10-14）横幅化：左侧插画 + 光晕，中间标题与输入框，
              右侧手写体标语 —— 与内容创作 / 活动与档期 / 竞品分析 同一套外观
              （基准图 docs/ref/06-hero-banner.jpg）。 */}
          <div className="dash-hero">
            <div className="dash-hero-ic" aria-hidden="true">
              <span className="dash-hero-ic-halo" />
              <LineIcon name="rocket" size={38} variant="plain" />
            </div>
            <div className="dash-hero-main">
            <h2 className="dash-hero-title">{copy.title}</h2>
            </div>
            <div className="dash-hero-slogan" aria-hidden="true">
              <span className="dash-hero-slogan-t">把每一次经营，都变成可复制的动作</span>
              <svg className="page-banner-slogan-line" viewBox="0 0 120 10" preserveAspectRatio="none">
                <path d="M2 7 C 30 2, 90 2, 118 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </div>
          </div>

          {/* 第十四轮：输入框与快捷胶囊下沉为独立白卡（不再塞进横幅里）。
              探针 banner-persist.mjs 实测把输入框放横幅内会让首页「横幅」高 251px，
              而其它四页都是 106px —— 首页会显得是个「大绿盒子」，与其余页面不一致。
              现在横幅= 插画+标题+标语（固定 106px），输入框是它下面一块白卡。 */}
          <div className="dash-ask-card">
            <div className="dash-hero-ask">
              <Input
                className="home-ask-input"
                data-home-ask="input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPressEnter={submit}
                placeholder={copy.ph}
                aria-label="说一句你想做的事"
              />
              <button type="button" className="home-ask-btn" data-home-ask="submit" onClick={submit} aria-label="发送">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></svg>
              </button>
            </div>
            {/* 快捷提问（原右栏「豆芽助手」卡里的三条示例问法）。
                2026-10-14 第七轮：右栏整条撤掉（老板：「左中右结构让人觉得乱」），
                这三条并到输入框正下方 —— 一行三个胶囊，点一下即发送，
                说明文字（desc）整条去掉，只留动作本身。 */}
            <div className="home-ask-sugs">
              {MINI_SUGGESTIONS.map((s) => (
                <span
                  className="home-ask-sug"
                  key={s.title}
                  role="link"
                  tabIndex={0}
                  onClick={() => submitText(s.title)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); submitText(s.title); } }}
                  title={s.title}
                >
                  {s.title}
                </span>
              ))}
            </div>
          </div>

          {/* ── ② 常用操作：参考图口径 —— 每张卡是一个真实动作，点一下直达办这件事的模块 ──
              第五轮：区块标题只留「常用操作」四个字（参考图同款，去掉 emoji 和副标题），
              卡片改「彩色图标方块 + 粗体标题 + 灰色小字」的扁平样式，不再套边框盒子。 */}
          <div className="dash-sec home-quick">
            <div className="dash-sec-hd">
              <span className="dash-sec-title">{copy.quickTitle}</span>
            </div>
            <div className="qa-grid">
              {quick.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="qa-card"
                  data-home-quick={g.id}
                  onClick={() => onSelectModule && onSelectModule(g.to)}
                >
                  <LineIcon name={g.ic} size={22} />
                  <span className="qa-card-label">{g.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── ③ 竞品与档期（2026-10-13 第五轮：逐字对齐参考图的双列表区）──
              参考图《豆芽CLAW企业助手仪表盘.png》主列下部就是左右两个独立列表区：
              左「竞品最近有什么新动作」3 条、右「近期活动档期」4 条。
              第五轮「去边框化」核心：行与行之间只用留白分隔，不再给每行套 1px 边框
              小白盒——参考图的干净全靠这个，我们此前一个首页四五十个框，线多显乱。
              GH5 门禁：无数据时 data-home-competitor / data-home-schedule 两个锚点
              必须存在且为 empty ⇒ 两区不删，空态时放参考图同款示例（带「示例」标注，
              视图层渲染、不落库），有真实数据时示例整体退场。 */}
          <div className="dash-sec home-comp-sched">
            <div className="home-cs-cols">
              <div className="home-cs-col" data-home-competitor={competitors.length > 0 ? 'has' : 'empty'}>
                <div className="home-cs-hd">
                  <span className="home-cs-ic home-cs-ic-comp">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M3 21V9M9 21V4M15 21v-8M21 21v-13" /></svg>
                  </span>
                  <span className="home-cs-t">竞品最近有什么新动作</span>
                  <span
                    role="link"
                    tabIndex={0}
                    className="home-cs-more"
                    onClick={() => onSelectModule && onSelectModule('intel')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectModule && onSelectModule('intel'); } }}
                  >
                    查看全部 →
                  </span>
                </div>
                {competitors.length > 0 ? (
                  <ul className="home-comp-list">
                    {competitors.slice(0, 4).map((c, i) => (
                      <li key={i} className="home-comp-item">{c}</li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <ul className="home-comp-list" data-home-comp-demo="1">
                      {DEMO_COMP_NEWS.map((n, i) => (
                        <li key={i} className="home-comp-item home-comp-demo">
                          <span className="home-comp-title">{n.title}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="home-sec-note home-demo-note">以上为示例数据，实际以真实来源为准。</p>
                  </>
                )}
              </div>
              <div className="home-cs-col" data-home-schedule={brief.facts.length > 0 ? 'has' : 'empty'}>
                <div className="home-cs-hd">
                  <span className="home-cs-ic home-cs-ic-sched">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
                  </span>
                  <span className="home-cs-t">近期活动档期</span>
                  <span
                    role="link"
                    tabIndex={0}
                    className="home-cs-more"
                    onClick={() => onSelectModule && onSelectModule('miaomiao')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectModule && onSelectModule('miaomiao'); } }}
                  >
                    查看全部 →
                  </span>
                </div>
                {brief.facts.length > 0 ? (
                  <ul className="home-fact-list">
                    {brief.facts.slice(0, 3).map((f, i) => (
                      <li key={i} className="home-fact">
                        <span className="home-fact-label">{f.label}</span>
                        <span className="home-fact-value">{f.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <>
                    <ul className="home-fact-list" data-home-sched-demo="1">
                      {DEMO_SCHEDULE.map((s, i) => (
                        <li key={i} className="home-fact home-fact-demo">
                          <span className="home-fact-name">{s.name}</span>
                          <span className="home-fact-st">{s.status}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="home-sec-note home-demo-note">以上为示例数据。在「活动与档期」录入真实档期后，这里换成你的排期。</p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ── ④ 门诊专属：连需求都说不清时，产品不该把决定任务的责任全推回用户 ── */}
          {isClinic && (
            <div className="dash-sec home-worth">
              <div className="dash-sec-hd">
                <span className="dash-sec-title">不知道从哪里开始？</span>
              </div>
              <p className="home-sec-note">
                依据你已填的门诊资料给一条能马上做的建议；资料不够我会明说，不会替你猜。
              </p>
              <span
                role="link"
                tabIndex={0}
                className="dash-sec-more"
                data-home-worth="1"
                onClick={() => onSelectModule && onSelectModule('direction')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectModule && onSelectModule('direction');
                  }
                }}
              >
                帮我看看现在最值得做什么 →
              </span>
            </div>
          )}

          {/* ── ⑤ 经销商专属：采购是主线。表格能力**尚未开通**，如实说明并给替代路径 ── */}
          {isDealer && (
            <div className="dash-sec home-upload" data-home-upload="building">
              <div className="dash-sec-hd">
                <span className="dash-sec-title">把采购表格放到这里</span>
              </div>
              <p className="home-upload-note">
                上传表格自动整理产品、规格、数量 —— 这个还在做，<strong>暂时没开通</strong>。
                现在你可以直接说采购需求，我来帮你整理成清单。
              </p>
              <span
                role="link"
                tabIndex={0}
                className="dash-sec-more"
                data-home-upload-ask="1"
                onClick={() => onAsk && onAsk('我要采购一批口腔耗材，请帮我整理成清单')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onAsk && onAsk('我要采购一批口腔耗材，请帮我整理成清单');
                  }
                }}
              >
                直接说采购需求 →
              </span>
            </div>
          )}
        </div>

      {/* ═══════════ 右栏（参考区 / 副工作区）═══════════
          第十一轮（2026-10-14）恢复：老板参考图是「左边选大区 / 中间工作区 /
          右边参考区」三栏。第八轮我按「三栏并排是乱的结构性来源」把右栏删了，
          属于误判——右栏不是多余的装饰，它承载「随时能问的助手 + 示例问法」，
          是主工作区的一部分。
          内容沿用删栏前的同款（问候 / 四条示例问法 / 我还可以帮你 / 输入框），
          但 emoji 头像换成品牌绿渐变 + LineIcon（与助手页头像同款）。 */}
        <aside className="dash-rail">
          <div className="mini-chat">
            <div className="mini-chat-hd">
              <span className="mini-chat-avatar"><LineIcon name="sparkle" size={16} /></span>
              <span className="mini-chat-name">豆芽助手</span>
            </div>
            <div className="mini-chat-hello">
              你说一件事就行，我按{companyName}的资料给你答案。
            </div>
            <div className="mini-chat-sugs">
              {MINI_SUGGESTIONS.map((s) => (
                <span
                  className="mini-chat-sug"
                  key={s.title}
                  role="link"
                  tabIndex={0}
                  onClick={() => submitText(s.title)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); submitText(s.title); } }}
                  title={s.title}
                >
                  <LineIcon name={s.ic} size={16} />
                  <span className="mini-chat-sug-t">{s.title}</span>
                </span>
              ))}
            </div>
            <div className="mini-chat-help">
              <div className="rail-card-hd">我还可以帮你</div>
              <div className="help-list">
                {(HELP_OF_TYPE[COPY_KEY_OF[companyType]] || HELP_OF_TYPE.manufacturer).map((h) => (
                  <div className="help-item" key={h}>
                    <span className="help-item-ic">✓</span>
                    <span>{h}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mini-chat-row">
              <Input
                className="home-mini-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPressEnter={submit}
                placeholder="输入你的问题"
                aria-label="问豆芽助手"
              />
              <button
                type="button"
                className="mini-chat-send"
                onClick={submit}
                disabled={!text.trim()}
                aria-label="发送"
                title="发送"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></svg>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** 各身份「我可以帮你」清单（照实写，不吹能力）。 */
const HELP_OF_TYPE = {
  // 2026-10-13 厂家三项对照参考图《豆芽CLAW企业助手仪表盘.png》右栏「我还可以帮你」。
  // 参考图原文写的是「分析竞品的市场打法」，但「打法」在首屏术语黑名单里
  //    （unit-firstscreen 的 GB 组）⇒ 按项目纪律改成「市场动作」，意思不变。
  manufacturer: [
    '分析竞品的市场动作',
    '生成活动宣传物料',
    '定制内容发布计划',
  ],
  dealer: [
    '把采购需求整理成清单',
    '写渠道合作与回访话术',
    '策划订货会与门店活动',
    '盯区域口碑与动销数据',
  ],
  clinic: [
    '写朋友圈 / 社群 / 小红书内容',
    '设计到店活动与义诊',
    '盯同城竞品动态',
    '告诉你现在最值得做的一件事',
  ],
};

/** 快捷入口卡的一句话说明（与 defaultGoals 的 id 对应；未知 id 回落通用文案）。 */
const GOAL_DESC = {
  'factory-new-product': '从卖点到发布节奏，一套做全',
  'factory-zhaoshang': '政策、话术、邀约一次到位',
  'factory-education': '选题、内容、分发排成计划',
  'factory-brand': '让更多人搜得到、信得过',
  'factory-expo': '主题、流程、物料全排好',
  'factory-dealer': '渠道内容与传播节奏',
  'clinic-acquire': '同城内容 + 到店 + 私域承接',
  'clinic-project': '项目卖点与到店转化',
  'clinic-doctor-ip': '医生人设与科普内容',
  'clinic-private': '老客召回与复购话术',
  'clinic-event': '到店活动一整套方案',
  'clinic-brand': '口碑内容与传播策略',
  'dentist-ip': '人设定位与首批内容',
  'dentist-fans': '对标拆解与涨粉计划',
  'dentist-science': '科普选题与更新节奏',
  'dentist-trust': '专业背书与合规表达',
  'dentist-patient': '咨询承接与答疑活动',
  'dentist-local': '同城选题与线上答疑',
  'dealer-expand': '拓店政策与开发话术',
  'dealer-sellthrough': '走量策略与合作文案',
  'dealer-distribute': '铺货推广计划与内容',
  'dealer-brand': '区域口碑内容策略',
  'dealer-orderfair': '订货会主题与邀约',
  'dealer-channel': '渠道维护清单与回访',
  'platform-onboard': '招商政策与商家邀约',
  'platform-event': '峰会主题与议程',
  'platform-merchant-ops': '培训选题与课程大纲',
  'platform-case': '标杆案例与增长内容',
  'platform-brand': '平台品牌内容策略',
};
// 2026-10-13：常用操作四卡改成动作型（每张卡自带 desc），此处不再被引用。
// 保留这张表 —— 它是「营销目标 → 一句说明」的真实口径，与经营方案/目标选择共用同一套 id，
// 将来首页若要把四卡换回目标型，直接接上即可，不必重新编词。
function goalDesc(id) {
  return GOAL_DESC[id] || '说一句话，豆芽帮你做';
}
