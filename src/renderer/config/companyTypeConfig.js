/**
 * 四种业务主体配置驱动中心（companyTypeConfig）。
 *
 * 第二阶段核心：厂家/门诊/医生/平台不再写死多套页面，而是由本配置驱动 ——
 * onboarding 表单字段、默认营销目标、建议任务模板、能力入口、首页标题、导航顺序等
 * 全部从这里取，页面组件尽量复用。
 *
 * 五主体：manufacturer 口腔厂家 / clinic 口腔门诊 / doctor 口腔医生 / dealer 经销商 / platform 口腔平台。
 * key 与 store/companyStore.jsx 的 COMPANY_TYPE_KEYS 严格一致（顺序即 UI 展示顺序）。
 * 未知类型一律兜底 manufacturer（与 normalizeCompanyType 同策略，历史行为不变）。
 *
 * 已与 goalCatalog.js 的 GOAL_GROUPS / GOAL_ROUTES 对齐：defaultGoals[].id 必须命中
 * GOAL_ROUTES 的 key，否则 selectGoal 拿不到落地模块（缺口目标 module=null 也允许，前端提示）。
 */

/**
 * 【2026-10-19 第十九轮 · 老板第 9 条】侧栏顺序定稿（全身份统一）：
 *   豆芽助手 → 内容创作 → 竞品分析 → 活动与档期 → 媒体与报价 → 学习中心 → 企业大脑 → 经营方案
 *
 * 与 2026-10「五种身份界面差异化」的关系：那一轮用 moduleOrder 让每个身份的顺序各不相同，
 * 本轮老板直接给了一份全身份通用的顺序清单（原话「排序改一个 …」）。
 * 需求变更以最新为准 ⇒ moduleOrder 不再按身份分化，五个身份共用这一份。
 * **仍然分化的部分**：roles 过滤（门店运营只给诊所/医生、采购专区只给经销商），
 * 所以各身份看到的**集合**依旧不同，只是相对顺序一致。门禁 unit-role-diff-ui 已同步改判据
 * （从「五身份顺序两两不同」改为「五身份顺序 = 本清单，且角色专属项位置正确」）。
 *
 * 注意：workbench（豆芽助手）是 standalone 置顶组，不在本清单里 —— 它恒排第一。
 */
export const CANONICAL_MODULE_ORDER = [
  // 身份专属入口（roles 过滤后只对对应身份可见）排在主清单之前，紧随「豆芽助手」
  'storeops', 'dealerbuy',
  // 【0.21.20 · 老板 2026-10-21】`videodesign`（视频设计）紧跟 `content`：
  // 动线是「先写内容 → 再做视频/配图」。三处必须同序：本清单 / ModuleNav.MODULE_GROUPS /
  // unit-role-diff-ui.BOSS_ORDER（含 S1 的模块总数与 A1C 文案），漏一处就红。
  // 【0.21.21 · 老板 2026-10-21】`activity`（活动与档期）已从本清单删除 —— 整板块下线。
  // 清单长度 12 → 11，与 ModuleNav.MODULE_GROUPS 的组数、unit-role-diff-ui 的
  // BOSS_ORDER 长度必须同时是 11（S1 锁组数、A1C 锁长度与首尾）。
  // 【0.21.25 · 2026-11-02】新增 `mindmap`（思维导图），插在 `content` **正前面**：
  // 动线是「先理清结构 → 再写内容 → 再做视频」。清单长度回到 12，三处同序同数。
  // 【0.21.26 · 2026-11-09】新增 `videostudio`（视频精剪），插在 `videodesign` **正后面**：
  // 动线是「先让 AI 出素材 → 再把素材剪成成片」。它与 `videodesign` 是**两个模块**
  // （前者=通义万象云端生成，后者=本地 Concat 多轨剪辑），不许合并。
  // 清单长度 12 → 13，三处同序同数：本清单 / ModuleNav.MODULE_GROUPS /
  // unit-role-diff-ui.BOSS_ORDER（含 S1 的模块总数与 A1C 的长度断言）。
  'mindmap', 'content', 'videodesign', 'videostudio', 'intel', 'newmedia', 'learn', 'profile', 'direction',
  // 【0.21.16 · 老板第 6 条】AI 补货挪到**经营方案下面**（末位）。
  // 老板原话：「AI 补货放在经营方案下面。」
  // 上一版（0.21.14 需求 3）按「采购线」分类把它放在 dealerbuy 之后 ——
  // 分类对，但动线反：老板的心智是「先看我现在最该做什么（经营方案），再看该补什么货」。
  // 这一项必须与 ModuleNav.MODULE_GROUPS 的物理顺序、以及 unit-role-diff-ui 的 BOSS_ORDER
  // **三方同序**（且都要在末位），否则 A1c 先红（tail 判定）、A1 再逐位报错。
  'replenish',
];

export const COMPANY_TYPE_CONFIG = {
  manufacturer: {
    key: 'manufacturer',
    label: '口腔厂家',
    shortLabel: '厂家',
    icon: '🏭',
    // Onboarding Step3 企业名称输入框 placeholder（组件不再写死二选一）
    namePlaceholder: '例如：康健苗苗集团',
    homeTitle: '厂家营销工作台',
    homeSub: '品牌 · 产品 · 医生 · 渠道 · 招商 · 学术 · 展会',
    desc: '适用于口腔医疗器械、种植体、正畸、材料、设备、数字化口腔等企业。',
    // 首登「选身份」卡面文案（与 label/desc 解耦：卡面用大白话，label/desc 保持 companyTypeLabel 全局输出不变）
    cardLabel: '厂家',
    cardDesc: '我是做产品的：生产或总代口腔设备、材料、器械、种植体、正畸，要招代理、做品牌和学术。',
    coreBusiness: ['品牌', '产品', '医生', '渠道', '招商', '学术', '展会'],
    // 左侧导航「一级模块优先顺序」（ModuleNav 读；命中排前、未列出的保持原相对顺序）。
    // 依据 coreBusiness 语义：厂家重「经营方案(规划)→内容与传播→新媒体→活动(展会/学术会)」。
    moduleOrder: CANONICAL_MODULE_ORDER,

    // Step3 企业基本资料（动态表单；key 落 companyKnowledgeStore.profile）
    onboardingFields: [
      { key: 'shortName', label: '企业简称', type: 'text', placeholder: '例如：康健苗苗' },
      { key: 'industry', label: '所属行业', type: 'text', placeholder: '例如：口腔医疗器械' },
      { key: 'summary', label: '企业简介', type: 'textarea', placeholder: '一句话介绍企业主营' },
      { key: 'products', label: '主营产品', type: 'text', placeholder: '例如：种植体、机扩马达、K锉' },
      { key: 'coreProducts', label: '核心产品', type: 'text', placeholder: '例如：XX 种植体' },
      { key: 'targetCustomers', label: '目标客户', type: 'text', placeholder: '例如：民营口腔诊所' },
      { key: 'market', label: '主要市场', type: 'text', placeholder: '例如：华东、华南' },
      { key: 'regions', label: '主要地区', type: 'text', placeholder: '例如：浙江、江苏' },
      { key: 'brandPositioning', label: '品牌定位', type: 'text', placeholder: '例如：高性价比种植体专家' },
      { key: 'website', label: '官网', type: 'text', placeholder: 'https://' },
      { key: 'wechat', label: '微信公众号', type: 'text', placeholder: '公众号名称' },
      { key: 'douyin', label: '抖音', type: 'text', placeholder: '抖音号' },
      { key: 'xiaohongshu', label: '小红书', type: 'text', placeholder: '小红书号' },
    ],

    // Step5 建议下一步（营销目标，id 对齐 goalCatalog）
    defaultGoals: [
      { id: 'factory-new-product', icon: '🚀', label: '新品推广' },
      { id: 'factory-zhaoshang', icon: '🤝', label: '招商获客' },
      { id: 'factory-education', icon: '👨‍⚕️', label: '医生/KOL营销' },
      { id: 'factory-brand', icon: '📣', label: '让更多人知道' },
      { id: 'factory-expo', icon: '🎯', label: '活动策划' },
      { id: 'factory-dealer', icon: '📝', label: '内容与传播' },
    ],

    // 选目标后自动生成的首批建议任务（capability 对齐 TodayOps CAP_LABEL）
    suggestedTasks: {
      'factory-new-product': [
        { title: '完善产品卖点', capability: 'content' },
        { title: '制定 7 天内容计划', capability: 'content' },
        { title: '生成首批小红书内容', capability: 'content' },
        { title: '制定媒体传播计划', capability: 'media' },
        { title: '设计新品发布活动', capability: 'activity' },
      ],
      'factory-zhaoshang': [
        { title: '梳理招商政策与卖点', capability: 'content' },
        { title: '生成招商邀约话术', capability: 'content' },
        { title: '制定招商媒体投放计划', capability: 'media' },
        { title: '策划线下招商会', capability: 'activity' },
      ],
      'factory-education': [
        { title: '梳理医生教育选题', capability: 'content' },
        { title: '制定医生科普内容计划', capability: 'content' },
        { title: '生成首批医生教育文案', capability: 'content' },
      ],
      'factory-brand': [
        { title: '制定品牌宣传内容策略', capability: 'geo' },
        { title: '生成品牌口碑内容', capability: 'content' },
        { title: '制定媒体投放计划', capability: 'media' },
      ],
      'factory-expo': [
        { title: '策划展会主题与亮点', capability: 'activity' },
        { title: '生成展会邀约文案', capability: 'content' },
        { title: '制定展前媒体预热计划', capability: 'media' },
      ],
      'factory-dealer': [
        { title: '梳理渠道招商内容', capability: 'content' },
        { title: '生成渠道合作文案', capability: 'content' },
      ],
    },
  },

  clinic: {
    key: 'clinic',
    label: '口腔门诊',
    shortLabel: '门诊',
    icon: '🦷',
    namePlaceholder: '例如：康健苗苗口腔门诊',
    homeTitle: '门诊营销工作台',
    homeSub: '患者 · 项目 · 获客 · 医生IP · 同城 · 私域',
    desc: '适用于口腔医院、连锁口腔、单体门诊及诊所。',
    cardLabel: '诊所 · 医生',
    cardDesc: '我是开门诊 / 做临床的：口腔医院、连锁、单体门诊，或医生个人做 IP 接诊。',
    coreBusiness: ['患者', '项目', '获客', '医生IP', '同城', '私域'],
    // 导航调序依据：门诊重「活动(到店/义诊)→内容获客→新媒体」，故 miaomiao 最前。
    moduleOrder: CANONICAL_MODULE_ORDER,

    onboardingFields: [
      { key: 'clinicType', label: '门诊类型', type: 'text', placeholder: '例如：连锁口腔 / 单体门诊' },
      { key: 'city', label: '所在城市', type: 'text', placeholder: '例如：杭州' },
      { key: 'address', label: '详细地址', type: 'text', placeholder: '例如：杭州市西湖区 XX 路' },
      { key: 'summary', label: '门诊简介', type: 'textarea', placeholder: '一句话介绍门诊' },
      { key: 'coreProjects', label: '核心项目', type: 'text', placeholder: '例如：种植、正畸、儿牙' },
      { key: 'doctorTeam', label: '医生团队', type: 'text', placeholder: '例如：主任医师 3 名' },
      { key: 'keyProjects', label: '重点项目', type: 'text', placeholder: '例如：种植体、隐形矫正' },
      { key: 'targetCustomers', label: '服务人群', type: 'text', placeholder: '例如：周边居民、白领' },
      { key: 'serviceRadius', label: '服务半径', type: 'text', placeholder: '例如：同城 5 公里' },
      { key: 'brandPositioning', label: '品牌定位', type: 'text', placeholder: '例如：家门口的口腔专家' },
      { key: 'wechat', label: '微信公众号', type: 'text', placeholder: '公众号名称' },
      { key: 'douyin', label: '抖音', type: 'text', placeholder: '抖音号' },
      { key: 'xiaohongshu', label: '小红书', type: 'text', placeholder: '小红书号' },
    ],

    defaultGoals: [
      { id: 'clinic-acquire', icon: '👥', label: '患者获客' },
      { id: 'clinic-project', icon: '🦷', label: '种植项目' },
      { id: 'clinic-doctor-ip', icon: '👨‍⚕️', label: '医生IP' },
      { id: 'clinic-private', icon: '❤️', label: '老客召回' },
      { id: 'clinic-event', icon: '🎯', label: '活动策划' },
      { id: 'clinic-brand', icon: '📣', label: '口碑传播' },
    ],

    suggestedTasks: {
      'clinic-acquire': [
        { title: '梳理获客渠道与卖点', capability: 'content' },
        { title: '制定同城内容计划', capability: 'content' },
        { title: '生成首批小红书内容', capability: 'content' },
        { title: '制定同城投放计划', capability: 'media' },
      ],
      'clinic-project': [
        { title: '梳理种植项目卖点', capability: 'content' },
        { title: '制定同城内容计划', capability: 'content' },
        { title: '生成 3 条短视频脚本', capability: 'content' },
        { title: '设计种植主题活动', capability: 'activity' },
        { title: '制定私域召回方案', capability: 'content' },
      ],
      'clinic-doctor-ip': [
        { title: '梳理医生人设定位', capability: 'content' },
        { title: '制定医生科普内容计划', capability: 'content' },
        { title: '生成首批医生IP文案', capability: 'content' },
      ],
      'clinic-private': [
        { title: '设计私域欢迎语与钩子', capability: 'content' },
        { title: '制定私域召回话术', capability: 'content' },
        { title: '生成私域朋友圈内容', capability: 'content' },
      ],
      'clinic-event': [
        { title: '策划到店活动主题', capability: 'activity' },
        { title: '生成活动邀约文案', capability: 'content' },
      ],
      'clinic-brand': [
        { title: '制定口碑内容策略', capability: 'geo' },
        { title: '生成品牌口碑内容', capability: 'content' },
        { title: '制定媒体投放计划', capability: 'media' },
      ],
    },
  },

  doctor: {
    key: 'doctor',
    label: '口腔医生',
    shortLabel: '医生',
    icon: '👨‍⚕️',
    namePlaceholder: '例如：康健苗苗医生个人品牌',
    homeTitle: '医生个人工作台',
    homeSub: '个人IP · 科普 · 粉丝 · 专业信任 · 咨询承接',
    desc: '适用于以个人身份做内容、做活动、承接咨询的执业口腔医生（种植/正畸/儿牙等专科医生）。',
    // doctor 不出现在首登卡面（首登选「诊所 · 医生」写 clinic，之后在「企业档案」改成 doctor），
    // 此处仅保留卡面文案配置，便于将来在档案编辑区按同一套字段渲染。
    cardLabel: '医生',
    cardDesc: '我是做临床 / 科普的口腔医生个人，想做个人 IP、涨粉、承接咨询。',
    coreBusiness: ['个人IP', '科普', '粉丝', '专业信任', '患者咨询', '同行影响'],
    // 导航调序依据：医生重「个人IP/科普(内容)→涨粉(新媒体)→学习方法(学习中心)」，故 content/learn 靠前。
    moduleOrder: CANONICAL_MODULE_ORDER,

    onboardingFields: [
      { key: 'doctorName', label: '医生姓名', type: 'text', placeholder: '例如：张医生' },
      { key: 'hospital', label: '执业机构', type: 'text', placeholder: '例如：XX 口腔医院' },
      { key: 'jobTitle', label: '职称 / 头衔', type: 'text', placeholder: '例如：主任医师 / 种植专科医生' },
      { key: 'specialty', label: '擅长项目', type: 'text', placeholder: '例如：种植、隐形矫正、儿牙' },
      { key: 'city', label: '所在城市', type: 'text', placeholder: '例如：杭州' },
      { key: 'summary', label: '个人简介', type: 'textarea', placeholder: '一句话介绍你的专业背景' },
      { key: 'targetAudience', label: '目标人群', type: 'text', placeholder: '例如：缺牙人群、正畸青年' },
      { key: 'ipPositioning', label: '人设定位', type: 'text', placeholder: '例如：讲人话的种植医生' },
      { key: 'contentFormats', label: '常用内容形式', type: 'text', placeholder: '例如：短视频口播 / 图文科普' },
      { key: 'consultChannel', label: '咨询承接方式', type: 'text', placeholder: '例如：私信预约 / 微信加好友' },
      { key: 'wechat', label: '微信公众号', type: 'text', placeholder: '公众号名称' },
      { key: 'douyin', label: '抖音', type: 'text', placeholder: '抖音号' },
      { key: 'xiaohongshu', label: '小红书', type: 'text', placeholder: '小红书号' },
      { key: 'videoAccount', label: '视频号', type: 'text', placeholder: '视频号名称' },
    ],

    defaultGoals: [
      { id: 'dentist-ip', icon: '👨‍⚕️', label: '个人IP' },
      { id: 'dentist-fans', icon: '📈', label: '账号涨粉' },
      { id: 'dentist-science', icon: '📚', label: '科普内容' },
      { id: 'dentist-trust', icon: '🛡️', label: '专业信任' },
      { id: 'dentist-patient', icon: '💬', label: '患者咨询' },
      { id: 'dentist-local', icon: '📍', label: '同城影响' },
    ],

    suggestedTasks: {
      'dentist-ip': [
        { title: '梳理医生人设与差异化标签', capability: 'content' },
        { title: '制定 30 天内容选题表', capability: 'content' },
        { title: '生成首批人设种草内容', capability: 'content' },
      ],
      'dentist-fans': [
        { title: '拆解对标账号的涨粉做法', capability: 'content' },
        { title: '制定涨粉内容计划', capability: 'content' },
        { title: '生成 5 条短视频口播脚本', capability: 'content' },
      ],
      'dentist-science': [
        { title: '梳理科普选题清单', capability: 'content' },
        { title: '生成首批口腔科普图文', capability: 'content' },
        { title: '制定视频号科普更新节奏', capability: 'media' },
      ],
      'dentist-trust': [
        { title: '梳理专业背书与资质素材', capability: 'content' },
        { title: '生成专业形象塑造内容', capability: 'content' },
        { title: '制定真实案例合规表达规范', capability: 'content' },
      ],
      'dentist-patient': [
        { title: '梳理私信咨询高频问题', capability: 'content' },
        { title: '生成咨询承接话术', capability: 'content' },
        { title: '设计粉丝答疑 / 直播活动', capability: 'activity' },
      ],
      'dentist-local': [
        { title: '梳理同城内容选题', capability: 'geo' },
        { title: '生成同城科普内容', capability: 'content' },
        { title: '设计线上答疑活动', capability: 'activity' },
      ],
    },
  },

  platform: {
    key: 'platform',
    label: '口腔平台',
    shortLabel: '平台',
    icon: '🌐',
    namePlaceholder: '例如：康健苗苗口腔平台',
    homeTitle: '平台增长工作台',
    homeSub: '商家 · 招商 · 城市沙龙 · 行业峰会 · 培训赋能',
    desc: '适用于口腔 SaaS、供应链/集采、诊所服务、行业媒体与会展等平台型企业。',
    cardLabel: '平台 · 运营',
    cardDesc: '我是做平台或服务的：口腔 SaaS、供应链集采、诊所服务商、行业媒体会展，帮别人做增长。',
    coreBusiness: ['商家', '招商', '城市沙龙', '行业峰会', '商家培训', '生态增长'],
    // 导航调序依据：平台重「活动(城市沙龙/峰会)→新媒体(招商内容)→经营方案」，故 miaomiao/newmedia 靠前。
    moduleOrder: CANONICAL_MODULE_ORDER,

    onboardingFields: [
      { key: 'platformType', label: '平台类型', type: 'text', placeholder: '例如：口腔 SaaS / 耗材供应链' },
      { key: 'shortName', label: '平台简称', type: 'text', placeholder: '例如：康健苗苗' },
      { key: 'platformProducts', label: '平台产品 / 服务', type: 'text', placeholder: '例如：诊所管理系统、耗材集采' },
      { key: 'summary', label: '平台简介', type: 'textarea', placeholder: '一句话介绍平台做什么' },
      { key: 'targetMerchants', label: '目标商家', type: 'text', placeholder: '例如：民营口腔门诊、区域服务商' },
      { key: 'merchantScale', label: '商家规模', type: 'text', placeholder: '例如：已入驻 800 家门诊' },
      { key: 'coverCities', label: '覆盖城市', type: 'text', placeholder: '例如：华东 12 城' },
      { key: 'growthModel', label: '增长模式', type: 'text', placeholder: '例如：城市合伙人 / 直营拓展' },
      { key: 'brandPositioning', label: '品牌定位', type: 'text', placeholder: '例如：口腔机构的增长伙伴' },
      { key: 'website', label: '官网', type: 'text', placeholder: 'https://' },
      { key: 'wechat', label: '微信公众号', type: 'text', placeholder: '公众号名称' },
      { key: 'douyin', label: '抖音', type: 'text', placeholder: '抖音号' },
      { key: 'xiaohongshu', label: '小红书', type: 'text', placeholder: '小红书号' },
    ],

    // 目标 id 用平台**自身**的 platform-* id（老板 2026-10 裁定：dealer/platform 独立成组，
    // 不再复用 factory-*）。id 逐字命中 goalCatalog.GOAL_GROUPS.platform。
    // ⚠️ 原文第六条 '机构拓展'（原 factory-clinic）对平台而言与「商家招商 / 入驻」是同一动作
    //    （拉机构/商家入驻），属重复项 ⇒ 不再单列；其 3 条建议任务已并入 platform-onboard。
    //    平台目标组仍含 platform-match（供需撮合）/ platform-compliance（平台合规）两个 module:null
    //    缺口目标，GoalSelector 分组 Tab 会照常展示；此处「建议下一步」只列 5 个可落地目标。
    defaultGoals: [
      { id: 'platform-onboard', icon: '🤝', label: '商家招商' },
      { id: 'platform-event', icon: '🎯', label: '城市沙龙 / 峰会' },
      { id: 'platform-merchant-ops', icon: '🎓', label: '商家培训' },
      { id: 'platform-case', icon: '📈', label: '商家增长' },
      { id: 'platform-brand', icon: '📣', label: '平台品牌' },
    ],

    suggestedTasks: {
      // 原 factory-zhaoshang（商家招商）+ factory-clinic（机构拓展）语义同为「拉商家/机构入驻」⇒ 合并
      'platform-onboard': [
        { title: '梳理平台招商政策与卖点', capability: 'content' },
        { title: '生成商家招商邀约文案', capability: 'content' },
        { title: '策划城市招商沙龙', capability: 'activity' },
        { title: '制定招商内容分发计划', capability: 'media' },
        { title: '梳理机构合作切入点', capability: 'content' },
        { title: '生成机构拓展触达文案', capability: 'content' },
        { title: '制定区域机构拓展计划', capability: 'media' },
      ],
      // 原 factory-expo（城市沙龙 / 峰会）
      'platform-event': [
        { title: '策划行业峰会主题与议程', capability: 'activity' },
        { title: '生成嘉宾与商家邀约文案', capability: 'content' },
        { title: '制定会前行业媒体预热计划', capability: 'media' },
      ],
      // 原 factory-education（商家培训）
      'platform-merchant-ops': [
        { title: '梳理商家培训选题', capability: 'content' },
        { title: '制定商家赋能课程大纲', capability: 'content' },
        { title: '生成首批商家培训内容', capability: 'content' },
      ],
      // 原 factory-channel（商家增长 / 标杆案例）
      'platform-case': [
        { title: '梳理商家增长案例', capability: 'content' },
        { title: '生成标杆商家案例内容', capability: 'content' },
        { title: '制定商家增长内容计划', capability: 'geo' },
      ],
      // 原 factory-brand（平台品牌）
      'platform-brand': [
        { title: '制定平台品牌内容策略', capability: 'geo' },
        { title: '生成平台品牌口碑内容', capability: 'content' },
        { title: '制定行业媒体投放计划', capability: 'media' },
      ],
    },
  },

  // 经销商（dealer）：老板 2026-10 裁决新增主体。
  // 目标已按经销商语义独立分化（「拓店 / 走量 / 管渠道」），不再复用 manufacturer 的 factory-*：
  // defaultGoals[].id 与 suggestedTasks 的键**逐字命中** goalCatalog.GOAL_GROUPS.dealer（dealer-*）。
  // onboardingFields 仍为 P0 占位（P2 再分化），不影响目标 id 的独立性。
  dealer: {
    key: 'dealer',
    label: '经销商',
    shortLabel: '经销商',
    icon: '🚚',
    cardLabel: '经销商',
    cardDesc: '我是卖货的：拿厂家的货做区域分销 / 二批，要拓店、走量、管渠道。',
    namePlaceholder: '例如：某某医疗器械有限公司',
    homeTitle: '经销商营销工作台',
    homeSub: '拓店 · 走量 · 渠道 · 动销 · 库存 · 返利',
    desc: '拿厂家货做区域分销 / 二批的经销商与代理商。',
    coreBusiness: ['拓店', '渠道', '动销', '库存', '返利', '终端'],
    // 导航调序依据：经销商重「经营方案(拓店/渠道)→活动(订货会)→内容与传播(动销)」，故 direction/miaomiao 靠前。
    moduleOrder: CANONICAL_MODULE_ORDER,

    // 后置选填字段（P0 复用 manufacturer 子集占位，P2 再分化）
    onboardingFields: [
      { key: 'region', label: '主要地区', type: 'text', placeholder: '例如：浙江、江苏' },
      { key: 'products', label: '主营产品', type: 'text', placeholder: '例如：种植体、耗材、器械' },
      { key: 'targetCustomers', label: '目标客户', type: 'text', placeholder: '例如：民营口腔诊所、连锁' },
      { key: 'market', label: '主要市场', type: 'text', placeholder: '例如：华东、华南' },
    ],

    // 目标 id 用经销商**自身**的 dealer-* id（逐字命中 goalCatalog.GOAL_GROUPS.dealer），label 用经销商语义。
    // ⚠️ 原复用条 'factory-dealer'（厂家语义「找经销商」）对经销商本身是错语义 ⇒ 已换成 dealer-sellthrough（终端动销）。
    //    经销商目标组另含 dealer-inventory（库存周转，module:null 缺口目标），此处不列入「建议下一步」，
    //    也不为其配建议任务（点进去只会显示「暂未开通」，配任务不会被消费）；GoalSelector 分组 Tab 仍会展示它。
    defaultGoals: [
      { id: 'dealer-expand', icon: '🏪', label: '拓店招商' },
      { id: 'dealer-sellthrough', icon: '📦', label: '渠道走量' },
      { id: 'dealer-distribute', icon: '🚀', label: '新品铺货' },
      { id: 'dealer-brand', icon: '📣', label: '区域口碑' },
      { id: 'dealer-orderfair', icon: '🎯', label: '订货会 / 活动' },
      { id: 'dealer-channel', icon: '🤝', label: '渠道维护' },
    ],

    suggestedTasks: {
      // 原 factory-zhaoshang（拓店招商）
      'dealer-expand': [
        { title: '梳理拓店政策与卖点', capability: 'content' },
        { title: '生成门店开发话术', capability: 'content' },
        { title: '制定区域拓店计划', capability: 'media' },
      ],
      // 原 factory-dealer（原意为「找经销商」= 厂家语义，对经销商错；换为终端动销）
      'dealer-sellthrough': [
        { title: '梳理渠道走量策略', capability: 'content' },
        { title: '生成渠道合作文案', capability: 'content' },
      ],
      // 原 factory-new-product（新品铺货）
      'dealer-distribute': [
        { title: '完善产品卖点', capability: 'content' },
        { title: '制定铺货推广计划', capability: 'content' },
        { title: '生成首批推广内容', capability: 'content' },
      ],
      // 原 factory-brand（品牌曝光 → 经销商为区域口碑）
      'dealer-brand': [
        { title: '制定区域口碑内容策略', capability: 'geo' },
        { title: '生成区域口碑内容', capability: 'content' },
      ],
      // 原 factory-expo（订货会 / 活动）
      'dealer-orderfair': [
        { title: '策划订货会主题与亮点', capability: 'activity' },
        { title: '生成订货会邀约文案', capability: 'content' },
      ],
      // 原 factory-channel（渠道维护）
      'dealer-channel': [
        { title: '梳理渠道维护清单', capability: 'content' },
        { title: '生成渠道回访话术', capability: 'content' },
      ],
    },
  },
};

/**
 * 首登「选身份」卡面 key（固定 4 张，4 值，**不含 doctor**）。
 *
 * 与 store/companyStore.jsx 的 COMPANY_TYPE_KEYS（归一化白名单，5 值）**刻意解耦**：
 *   · COMPANY_TYPE_KEYS 必须保留 doctor（否则存量 doctor 企业被静默判成 manufacturer）；
 *   · 首登不出现 doctor 卡（医生合并进「诊所 · 医生」卡，写 clinic，之后在企业档案里改成 doctor）。
 * 顺序即展示顺序：厂家 / 诊所·医生 / 经销商 / 平台·运营。
 */
export const FIRST_RUN_TYPE_KEYS = ['manufacturer', 'clinic', 'dealer', 'platform'];

/**
 * 能力入口（首页「今天做什么 · 豆芽帮你做」区块），按类型差异化文案与顺序。
 *
 * ⚠️ 去重约定（老板第 8 条：「今天做什么里面太多功能重复了，不要有那么多重复的功能，
 *    特别是跟别的板块一样」）：
 * 这里**只放没有独立导航板块的能力**。以下三类已从本表移除，因为它们都在左侧导航有各自入口，
 * 放这里就是「点了就跳走」的重复入口：
 *   · `geo`      —— GEO 诊断展示只归「经营诊断」（老板第 7 条）；
 *   · `media`    —— 媒体投放 = 「新媒体中心」的「媒体投放」Tab；
 *   · `xinmeiti` —— 新媒体文案 = 「新媒体中心」的「生成文案」版块。
 * 保留：`huodong`（活动策划，无导航项）、`crisis`（公关危机，无导航项）、`workbench`（豆芽对话）。
 *
 * 【0.21.21 · 老板 2026-10-21】注：本表当前**没有任何消费者**（原消费者是 HomeConsole，
 * 它自 2026-10-18 起不再被 App 挂载）。这里刻意**不改** `huodong` 那几行：
 *   · 显示名「🎯 AI 活动总监」本身没说错 —— 它就是「做活动方案」这个能力；
 *   · 深链语义没变：App.jsx 的 LEGACY_MODULE_ALIAS 已把 `huodong` 归一到 `campaign`
 *     （营销专项），所以点下来落到的是**新版**的活动方案页，不是已删除的旧向导页。
 * 将来若把它挂回来，不需要再改这张表。
 */
export const TYPE_QUICK_ACTIONS = {
  manufacturer: [
    { key: 'huodong', icon: '🎯', name: '🎯 AI 活动总监', desc: '招商会 / 展会 / 学术会' },
    { key: 'crisis', icon: '🚨', name: '公关危机', desc: '舆情监测与应对' },
    { key: 'workbench', icon: '🌱', name: 'AI 对话', desc: '自由提问 / 执行任务' },
  ],
  clinic: [
    { key: 'huodong', icon: '🎯', name: '🎯 AI 活动总监', desc: '沙龙 / 义诊 / 种植项目' },
    { key: 'crisis', icon: '🚨', name: '公关危机', desc: '口碑舆情监测' },
    { key: 'workbench', icon: '🌱', name: 'AI 对话', desc: '自由提问 / 执行任务' },
  ],
  doctor: [
    { key: 'huodong', icon: '🎯', name: '🎯 AI 活动总监', desc: '线上直播 / 粉丝答疑' },
    { key: 'crisis', icon: '🚨', name: '公关危机', desc: '个人口碑与舆情' },
    { key: 'workbench', icon: '🌱', name: 'AI 对话', desc: '自由提问 / 执行任务' },
  ],
  platform: [
    { key: 'huodong', icon: '🎯', name: '🎯 AI 活动总监', desc: '城市沙龙 / 行业峰会' },
    { key: 'crisis', icon: '🚨', name: '公关危机', desc: '商家舆情监测' },
    { key: 'workbench', icon: '🌱', name: 'AI 对话', desc: '自由提问 / 执行任务' },
  ],
  dealer: [
    { key: 'huodong', icon: '🎯', name: '🎯 AI 活动总监', desc: '订货会 / 门店活动' },
    { key: 'crisis', icon: '🚨', name: '公关危机', desc: '渠道口碑与舆情' },
    { key: 'workbench', icon: '🌱', name: 'AI 对话', desc: '自由提问 / 执行任务' },
  ],
};

/** 获取某类型的配置（缺省回厂家）。 */
export function getTypeConfig(type) {
  return COMPANY_TYPE_CONFIG[type] || COMPANY_TYPE_CONFIG.manufacturer;
}

/** 获取某类型的能力入口（缺省回厂家）。 */
export function getQuickActions(type) {
  return TYPE_QUICK_ACTIONS[type] || TYPE_QUICK_ACTIONS.manufacturer;
}

/**
 * 企业类型中文标签（四值）。UI 展示统一入口，替代各组件里 `type === 'clinic' ? … : …` 的二选一写死。
 * 未知 / 空值兜底「口腔厂家」——与 normalizeCompanyType 同策略，历史行为不变。
 * @param {string} type 企业类型 key
 * @returns {string}
 */
export function companyTypeLabel(type) {
  const cfg = COMPANY_TYPE_CONFIG[type];
  return (cfg || COMPANY_TYPE_CONFIG.manufacturer).label;
}

/**
 * 企业类型图标（四值）。兜底 🏭，语义同 companyTypeLabel。
 * @param {string} type 企业类型 key
 * @returns {string}
 */
export function companyTypeIcon(type) {
  const cfg = COMPANY_TYPE_CONFIG[type];
  return (cfg || COMPANY_TYPE_CONFIG.manufacturer).icon;
}

/**
 * 企业类型短标签（四值，用于空间紧凑处）。兜底「厂家」。
 * @param {string} type 企业类型 key
 * @returns {string}
 */
export function companyTypeShortLabel(type) {
  const cfg = COMPANY_TYPE_CONFIG[type];
  return (cfg || COMPANY_TYPE_CONFIG.manufacturer).shortLabel;
}

export default COMPANY_TYPE_CONFIG;
