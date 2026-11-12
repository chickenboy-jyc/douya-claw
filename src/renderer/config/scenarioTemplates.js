/**
 * scenarioTemplates.js —— 真实营销场景模板注册中心（阶段六核心）。
 *
 * 目标：让厂家版 / 门诊版「一眼看出来这东西懂我」——不是增加页面，而是通过
 * 「项目模板 → 默认任务 → 现有 AI 能力」让运营人员从选模板开始，顺着推荐任务
 * 完成一次真实营销工作。
 *
 * 设计原则（对齐需求二十一「本阶段禁止」）：
 *  - 模板只做「结构 + 推荐任务」，不自动执行、不自动投放、不自动生成虚假数据；
 *  - 每个默认任务只带 taskType（capability 由 capabilityResolver.resolveCapabilityForType 派生），
 *    复用现有文案 / 媒体 / 活动 / GEO / 调研 / 分析等真实能力，不新造 AI 体系；
 *  - 厂家只能看厂家模板，门诊只能看门诊模板（companyType 决定，不写一堆 if）；
 *  - 真实优先：默认任务主体映射到「真实能力」（有后端或通用 AI 兜底），只有明确专属的
 *    各默认任务均落到已开通能力，用户「开始第一个任务」就能跑通。
 *
 * 数据结构（对齐需求四 ProjectTemplate 建议，静态配置第一阶段即可）：
 *   {
 *     key,            // 对齐 projectTypes.PROJECT_TYPES 的 type key
 *     label,          // 模板名
 *     icon,           // 图标
 *     goalId,         // 对齐 goalCatalog 的目标 id
 *     goal,           // 项目目标文案（创建后展示「项目目标」）
 *     desc,           // 一句话描述
 *     capabilities,   // 该模板会用到哪些能力（用于展示「懂我」标签）
 *     defaultTasks,   // [{ title, taskType, description? }] 推荐任务（不自动生成，用户确认后创建）
 *   }
 */

export const PROJECT_TEMPLATE_REGISTRY = {
  // ==================== 厂家 ====================
  manufacturer: [
    {
      key: 'new_product',
      label: '新品推广',
      icon: '🚀',
      goalId: 'factory-new-product',
      goal: '新品认知 + 医生/渠道触达',
      desc: '新品上市传播与种草',
      capabilities: ['content', 'media', 'activity', 'kol', 'research', 'geo'],
      defaultTasks: [
        { title: '完善产品资料', taskType: 'research', description: '整理产品的参数、适应症、目标机构与渠道信息' },
        { title: '梳理核心卖点', taskType: 'content', description: '提炼产品对医生与患者的差异化卖点' },
        { title: '制定传播方向', taskType: 'geo', description: '确定新品传播的内容方向与关键词策略' },
        { title: '生成新媒体内容', taskType: 'content', description: '产出小红书/公众号等社媒内容' },
        { title: '媒体推荐', taskType: 'media', description: '推荐适合新品触达的行业媒体' },
        { title: '医生/KOL传播计划', taskType: 'kol', description: '规划医生教育与 KOL 合作传播' },
        { title: '新品活动方案', taskType: 'activity', description: '策划新品发布/体验活动' },
      ],
    },
    {
      key: 'zhaoshang',
      label: '招商',
      icon: '🤝',
      goalId: 'factory-zhaoshang',
      goal: '经销商 / 渠道获客',
      desc: '招商会与经销商拓展',
      capabilities: ['channel', 'content', 'media', 'activity', 'research'],
      defaultTasks: [
        { title: '招商卖点梳理', taskType: 'content', description: '梳理对经销商的合作价值与卖点' },
        { title: '招商资料整理', taskType: 'research', description: '整理产品手册、政策与资质资料' },
        { title: '招商内容', taskType: 'content', description: '生成招商邀约话术与内容' },
        { title: '招商媒体传播', taskType: 'media', description: '推荐招商触达媒体与渠道' },
        { title: '招商活动方案', taskType: 'activity', description: '策划线下招商会/加盟活动' },
        { title: '线索整理', taskType: 'channel', description: '整理经销商线索与跟进记录' },
      ],
    },
    {
      key: 'xinmeiti',
      label: '新媒体运营',
      icon: '✍️',
      goalId: 'factory-dealer',
      goal: '内容运营与渠道触达',
      desc: '月度内容运营与复盘',
      capabilities: ['geo', 'content', 'media', 'analysis'],
      defaultTasks: [
        { title: '本月内容方向', taskType: 'geo', description: '确定本月内容策略与关键词方向' },
        { title: '内容选题', taskType: 'content', description: '产出本月内容选题清单' },
        { title: '文案生成', taskType: 'content', description: '生成选题对应的文案' },
        { title: '图片/视频素材整理', taskType: 'research', description: '整理可复用的图片视频素材' },
        { title: '发布计划', taskType: 'media', description: '制定内容发布排期与渠道' },
        { title: '本周复盘', taskType: 'analysis', description: '复盘本周内容数据与优化方向' },
      ],
    },
    {
      key: 'activity',
      label: '展会/活动',
      icon: '🎯',
      goalId: 'factory-expo',
      goal: '展会与活动传播',
      desc: '展会/峰会/学术会',
      capabilities: ['activity', 'content', 'media', 'analysis'],
      defaultTasks: [
        { title: '活动目标', taskType: 'analysis', description: '明确展会/活动的目标与 KPI' },
        { title: '活动方案', taskType: 'activity', description: '策划活动主题、流程与亮点' },
        { title: '活动传播', taskType: 'content', description: '生成活动邀约与传播内容' },
        { title: '活动物料', taskType: 'content', description: '产出展板、折页等物料文案' },
        { title: '媒体传播', taskType: 'media', description: '推荐活动宣传媒体' },
        { title: '会后内容', taskType: 'content', description: '生成会后回顾与二次传播内容' },
      ],
    },
  ],

  // ==================== 门诊 ====================
  clinic: [
    {
      key: 'implant',
      label: '种植获客',
      icon: '🦷',
      goalId: 'clinic-project',
      goal: '种植项目精准获客',
      desc: '种植项目种草与到店',
      capabilities: ['content', 'activity', 'private_domain', 'research'],
      defaultTasks: [
        { title: '种植项目定位', taskType: 'research', description: '明确种植项目的定位与目标人群' },
        { title: '目标患者', taskType: 'research', description: '梳理目标患者画像与需求痛点' },
        { title: '项目卖点', taskType: 'content', description: '提炼种植项目的差异化卖点' },
        { title: '同城内容', taskType: 'content', description: '生成同城到店向内容（结合门诊位置）' },
        { title: '小红书内容', taskType: 'content', description: '产出种植项目小红书种草内容' },
        { title: '短视频脚本', taskType: 'content', description: '产出种植项目短视频脚本' },
        { title: '种植活动方案', taskType: 'activity', description: '策划种植沙龙/义诊等活动' },
        { title: '私域触达方案', taskType: 'private_domain', description: '设计私域触达与召回方案' },
      ],
    },
    {
      key: 'ortho',
      label: '正畸获客',
      icon: '🦷',
      goalId: 'clinic-project',
      goal: '正畸项目精准获客',
      desc: '正畸/儿牙项目获客',
      capabilities: ['content', 'activity', 'research'],
      defaultTasks: [
        { title: '正畸项目定位', taskType: 'research', description: '明确正畸项目定位与目标人群' },
        { title: '目标患者', taskType: 'research', description: '梳理正畸目标患者画像' },
        { title: '内容选题', taskType: 'content', description: '产出正畸内容选题清单' },
        { title: '小红书内容', taskType: 'content', description: '产出正畸小红书种草内容' },
        { title: '短视频脚本', taskType: 'content', description: '产出正畸短视频脚本' },
        { title: '医生专业内容', taskType: 'content', description: '生成医生科普/专业内容（不编造疗效与案例）' },
        { title: '活动方案', taskType: 'activity', description: '策划正畸沙龙/体验活动' },
      ],
    },
    {
      key: 'xinmeiti',
      label: '新媒体',
      icon: '✍️',
      goalId: 'clinic-visit',
      goal: '线上内容带到店',
      desc: '小红书/抖音/视频号运营',
      capabilities: ['geo', 'content'],
      defaultTasks: [
        { title: '本月内容方向', taskType: 'geo', description: '确定本月内容策略与方向' },
        { title: '选题规划', taskType: 'content', description: '产出本月选题规划' },
        { title: '小红书', taskType: 'content', description: '产出小红书到店内容' },
        { title: '视频号', taskType: 'content', description: '产出视频号内容脚本' },
        { title: '抖音', taskType: 'content', description: '产出抖音内容脚本' },
        { title: '朋友圈内容', taskType: 'content', description: '产出朋友圈触达内容' },
      ],
    },
    {
      key: 'doctor_ip',
      label: '医生IP',
      icon: '👨‍⚕️',
      goalId: 'clinic-doctor-ip',
      goal: '打造医生专家人设',
      desc: '医生定位与人设内容',
      capabilities: ['research', 'content', 'geo'],
      defaultTasks: [
        { title: '医生定位', taskType: 'research', description: '明确医生专业定位与差异化' },
        { title: '医生人设', taskType: 'content', description: '梳理医生人设与表达风格' },
        { title: '内容方向', taskType: 'geo', description: '确定医生 IP 内容方向与关键词' },
        { title: '科普选题', taskType: 'content', description: '产出医生科普选题清单' },
        { title: '短视频脚本', taskType: 'content', description: '产出医生科普短视频脚本' },
        { title: '小红书内容', taskType: 'content', description: '产出医生小红书内容' },
        { title: '视频号内容', taskType: 'content', description: '产出医生视频号内容' },
      ],
    },
  ],

  // ==================== 医生（个人） ====================
  // 语义：个人 IP / 科普内容 / 涨粉 / 粉丝答疑 / 咨询承接。
  // 与门诊（clinic）分化的关键：门诊写「项目获客/到店」，医生写「人设/涨粉/粉丝承接」；
  // 不出现种植/正畸等「项目」话术（那是门诊语义），goalId 全部取自 goalCatalog 的 dentist-* 目标。
  doctor: [
    {
      key: 'doctor_ip',
      label: '个人IP',
      icon: '👨‍⚕️',
      goalId: 'dentist-ip',
      goal: '打造医生个人品牌',
      desc: '人设定位与账号内容',
      capabilities: ['research', 'content', 'geo'],
      defaultTasks: [
        { title: '人设定位', taskType: 'research', description: '明确个人差异化定位与目标人群' },
        { title: '人设标签', taskType: 'content', description: '梳理人设标签与表达风格' },
        { title: '内容方向', taskType: 'geo', description: '确定个人 IP 内容方向与关键词' },
        { title: '人设种草内容', taskType: 'content', description: '产出首批人设种草内容' },
        { title: '短视频口播脚本', taskType: 'content', description: '产出人设类短视频口播脚本' },
        { title: '发布计划', taskType: 'media', description: '制定内容发布排期与渠道' },
      ],
    },
    {
      key: 'science',
      label: '科普内容',
      icon: '📚',
      goalId: 'dentist-science',
      goal: '持续产出科普内容',
      desc: '口腔科普图文与视频',
      capabilities: ['content', 'media', 'geo'],
      defaultTasks: [
        { title: '科普选题清单', taskType: 'content', description: '梳理口腔科普选题清单（不编造疗效）' },
        { title: '图文科普', taskType: 'content', description: '产出首批口腔科普图文' },
        { title: '短视频脚本', taskType: 'content', description: '产出科普短视频脚本' },
        { title: '更新节奏', taskType: 'media', description: '制定视频号/图文科普更新节奏' },
      ],
    },
    {
      key: 'fans',
      label: '涨粉',
      icon: '📈',
      goalId: 'dentist-fans',
      goal: '账号粉丝增长',
      desc: '涨粉内容与账号运营',
      capabilities: ['content', 'geo', 'analysis'],
      defaultTasks: [
        { title: '拆解对标账号', taskType: 'analysis', description: '拆解对标账号的涨粉做法' },
        { title: '涨粉内容计划', taskType: 'content', description: '制定涨粉内容计划' },
        { title: '口播脚本', taskType: 'content', description: '产出 5 条涨粉向短视频口播脚本' },
        { title: '数据复盘', taskType: 'analysis', description: '复盘账号数据与优化方向' },
      ],
    },
    {
      key: 'consult',
      label: '咨询承接',
      icon: '💬',
      goalId: 'dentist-patient',
      goal: '承接患者咨询',
      desc: '私信答疑与咨询转化',
      capabilities: ['content', 'activity'],
      defaultTasks: [
        { title: '高频问题梳理', taskType: 'content', description: '梳理私信咨询高频问题' },
        { title: '咨询承接话术', taskType: 'content', description: '生成咨询承接话术' },
        { title: '粉丝答疑活动', taskType: 'activity', description: '设计粉丝答疑 / 直播活动方案' },
      ],
    },
  ],

  // ==================== 平台 ====================
  // 语义：商家招商 / 城市沙龙 / 行业峰会 / 商家培训 / 生态增长。
  // goalId 用平台**自身**的 platform-* 目标（已按身份分化，序列逐字命中 goalCatalog.GOAL_GROUPS.platform，
  // 与 companyTypeConfig.platform.defaultGoals 一致）；不再复用 manufacturer 的 factory-*。
  platform: [
    {
      key: 'merchant_recruit',
      label: '商家招商',
      icon: '🤝',
      goalId: 'platform-onboard',
      goal: '商家入驻招商',
      desc: '招商政策与城市沙龙',
      capabilities: ['channel', 'content', 'media', 'activity', 'research'],
      defaultTasks: [
        { title: '招商政策梳理', taskType: 'content', description: '梳理平台招商政策与卖点' },
        { title: '招商邀约文案', taskType: 'content', description: '生成商家招商邀约文案' },
        { title: '商家线索整理', taskType: 'channel', description: '整理商家线索与跟进记录' },
        { title: '城市招商沙龙', taskType: 'activity', description: '策划城市招商沙龙' },
        { title: '招商内容分发', taskType: 'media', description: '制定招商内容分发计划' },
      ],
    },
    {
      key: 'salon',
      label: '城市沙龙 / 峰会',
      icon: '🎯',
      goalId: 'platform-event',
      goal: '城市沙龙与行业峰会',
      desc: '城市巡回沙龙 / 行业峰会',
      capabilities: ['activity', 'content', 'media'],
      defaultTasks: [
        { title: '峰会主题与议程', taskType: 'activity', description: '策划行业峰会主题与议程' },
        { title: '嘉宾与商家邀约', taskType: 'content', description: '生成嘉宾与商家邀约文案' },
        { title: '会前媒体预热', taskType: 'media', description: '制定会前行业媒体预热计划' },
        { title: '会后内容', taskType: 'content', description: '生成会后回顾与二次传播内容' },
      ],
    },
    {
      key: 'merchant_training',
      label: '商家培训',
      icon: '🎓',
      goalId: 'platform-merchant-ops',
      goal: '商家培训赋能',
      desc: '商家赋能课程与内容',
      capabilities: ['content', 'media'],
      defaultTasks: [
        { title: '培训选题梳理', taskType: 'content', description: '梳理商家培训选题' },
        { title: '培训课程大纲', taskType: 'content', description: '制定商家赋能课程大纲' },
        { title: '首批培训内容', taskType: 'content', description: '生成首批商家培训内容' },
        { title: '培训传播计划', taskType: 'media', description: '制定培训招募与传播计划' },
      ],
    },
    {
      key: 'ecosystem',
      label: '生态增长',
      icon: '📈',
      goalId: 'platform-case',
      goal: '商家增长与生态',
      desc: '标杆案例与商家增长',
      capabilities: ['content', 'geo', 'analysis'],
      defaultTasks: [
        { title: '增长案例梳理', taskType: 'content', description: '梳理标杆商家增长案例' },
        { title: '标杆案例内容', taskType: 'content', description: '生成标杆商家案例内容' },
        { title: '增长内容计划', taskType: 'geo', description: '制定商家增长内容计划' },
        { title: '生态数据复盘', taskType: 'analysis', description: '复盘商家增长数据与优化方向' },
      ],
    },
  ],

  // ==================== 经销商 ====================
  // 语义：拓店招商 / 渠道走量 / 订货会 / 终端动销。
  // 与厂家分化的关键：厂家写「品牌/学术/新品上市」，经销商只写「拿货拓店、铺到终端、把货卖掉」。
  // goalId 用经销商**自身**的 dealer-* 目标（已按身份分化，序列逐字命中 goalCatalog.GOAL_GROUPS.dealer，
  // 与 companyTypeConfig.dealer.defaultGoals 一致）；不再复用 manufacturer 的 factory-*。
  dealer: [
    {
      key: 'expand_store',
      label: '拓店招商',
      icon: '🏪',
      goalId: 'dealer-expand',
      goal: '拓店招商 / 门店开发',
      desc: '门店开发与签约',
      capabilities: ['channel', 'content', 'media', 'activity'],
      defaultTasks: [
        { title: '拓店政策梳理', taskType: 'content', description: '梳理拓店政策与返利卖点' },
        { title: '门店开发话术', taskType: 'content', description: '生成门店开发话术' },
        { title: '区域拓店计划', taskType: 'media', description: '制定区域拓店计划' },
        { title: '门店名单整理', taskType: 'channel', description: '整理目标门店名单与跟进记录' },
        { title: '签约活动方案', taskType: 'activity', description: '策划门店签约活动方案' },
      ],
    },
    {
      key: 'channel_sales',
      label: '渠道走量',
      icon: '📦',
      goalId: 'dealer-sellthrough',
      goal: '渠道走量与终端动销',
      desc: '终端动销与库存周转',
      capabilities: ['content', 'analysis'],
      defaultTasks: [
        { title: '走量策略梳理', taskType: 'content', description: '梳理渠道走量策略与卖点' },
        { title: '渠道合作文案', taskType: 'content', description: '生成渠道合作文案' },
        { title: '动销数据复盘', taskType: 'analysis', description: '复盘终端动销与库存数据' },
      ],
    },
    {
      key: 'order_fair',
      label: '订货会',
      icon: '🎯',
      goalId: 'dealer-orderfair',
      goal: '订货会 / 门店活动',
      desc: '订货会与门店促销活动',
      capabilities: ['activity', 'content', 'media'],
      defaultTasks: [
        { title: '订货会主题', taskType: 'activity', description: '策划订货会主题与亮点' },
        { title: '订货会邀约', taskType: 'content', description: '生成订货会邀约文案' },
        { title: '门店促销方案', taskType: 'activity', description: '设计门店促销活动方案' },
        { title: '宣传传播计划', taskType: 'media', description: '制定订货会宣传传播计划' },
      ],
    },
    {
      key: 'stock_dist',
      label: '新品铺货',
      icon: '🚀',
      goalId: 'dealer-distribute',
      goal: '新品区域铺货',
      desc: '新品铺货与终端陈列',
      capabilities: ['content', 'media', 'research'],
      defaultTasks: [
        { title: '新品资料整理', taskType: 'research', description: '整理新品参数与卖点资料' },
        { title: '铺货推广内容', taskType: 'content', description: '生成门店铺货推广内容' },
        { title: '铺货节奏计划', taskType: 'media', description: '制定区域铺货节奏计划' },
        { title: '终端陈列建议', taskType: 'content', description: '梳理重点门店终端陈列建议' },
      ],
    },
  ],
};

/**
 * 取某企业类型的场景模板（缺省回厂家，保证不崩）。
 *
 * 五主体各自命中自己的注册组：manufacturer / clinic / doctor / dealer / platform。
 * ⚠️ 历史陷阱：旧实现 `(clinic||doctor) ? clinic : manufacturer` 会让 dealer / platform 静默拿到
 *   厂家模板；补了新组也必须在这里「接线」，否则写了组却取不到（写了 ≠ 接线）。
 * 未知类型兜底 manufacturer，与 normalizeCompanyType 同策略，历史行为不变。
 */
export function getProjectTemplates(companyType) {
  return PROJECT_TEMPLATE_REGISTRY[companyType] || PROJECT_TEMPLATE_REGISTRY.manufacturer;
}

/** 按企业类型 + key 查单个场景模板（未命中返回 null）。 */
export function getProjectTemplate(companyType, key) {
  return getProjectTemplates(companyType).find((t) => t.key === key) || null;
}

export default PROJECT_TEMPLATE_REGISTRY;
