/**
 * platformOnboardingCatalog —— 「学习站 · 平台入驻」硬编码知识库。
 *
 * 定位：口腔机构（口腔门诊 / 口腔厂家）要上美团、高德、抖音、小红书、快手、
 * 视频号、腾讯地图等平台时，不用联网也不用问 AI，直接在学习站查到「怎么入驻」。
 *
 * 真实性约定（红线，改动前必读）：
 * 1. 本文件所有条目必须能追到来源，来源写在 source 字段（平台名 + 页面名 + URL）。
 * 2. verified: true  = 该条来自平台官方页面 / 官方规则中心 / 官方学习中心 / 政府公开文件。
 *    verified: false = 未检索到官方公开依据，或为行业通行做法整理 → UI 打「待核验」标。
 * 3. 费用、佣金、保证金、审核时长：查到官方口径才写；查不到一律写「以平台后台
 *    实际提示为准」，**绝不写具体金额**。第三方招商文章流传的数字一律不采信。
 * 4. 医疗广告合规部分依据《医疗广告管理办法》《广告法》及地方政府公开合规指引，
 *    属于法定要求，不随平台政策变化，但仍需以属地卫健/市场监管部门口径为准。
 *
 * 数据结构（按平台聚合）：
 *   平台 → { id, name, icon, category, entryType, verified, verifiedNote,
 *            officialUrl, summary,
 *            qualifications: [{ text, verified, note }],
 *            materials:      [{ text, required, verified }],
 *            steps:          [{ title, detail, verified }],
 *            pitfalls:       [{ text, verified }],
 *            reviewCycle: { text, verified },
 *            feeNote:     { text, verified },
 *            medicalCompliance: [string],
 *            source: [{ label, url, official }] }
 *
 * 条目级 verified 缺省时继承平台级 verified（见 resolveVerified）。
 */

// ==================== 入驻性质分组 ====================
export const ONBOARDING_GROUPS = [
  { key: 'local_life', label: '本地生活团购', icon: '🛒', hint: '上架团购套餐，承接同城到店' },
  { key: 'map_poi', label: '地图 / POI 标注', icon: '📍', hint: '被「附近的人」搜到并导航到店' },
  { key: 'content', label: '内容社区 / 短视频', icon: '🎬', hint: '认证 + 内容 + 投放获客' },
];

export function groupLabel(key) {
  const g = ONBOARDING_GROUPS.find((x) => x.key === key);
  return g ? g.label : key;
}

// ==================== 医疗广告合规（全平台通用，法定要求） ====================
// 依据：《中华人民共和国广告法》《医疗广告管理办法》，
// 并参考地方政府公开发布的合规指引（见 MEDICAL_COMPLIANCE_SOURCE）。
// 这部分是「法律要求」不是「平台规则」，但平台审核基本都按这套口径卡。
export const MEDICAL_AD_COMPLIANCE = [
  '发布前须取得《医疗广告审查证明》：任何形式的医疗广告（含平台店铺页、团购详情、短视频、直播、公众号）发布前都应向属地卫生健康行政部门申请审查，未经审查不得发布。',
  '医疗广告内容仅限于法定八项：医疗机构第一名称、地址、所有制形式、医疗机构类别、诊疗科目、床位数、接诊时间、联系电话，且须与《医疗机构执业许可证》载明内容一致。',
  '必须标注医疗机构第一名称和《医疗广告审查证明》文号；不得擅自剪辑、拼接、修改核准的广告成品样件，内容改动须重新申请审查。',
  '禁止表示功效、安全性的断言或保证，禁止保证治愈或隐含保证治愈，禁止宣传治愈率、有效率等诊疗效果。',
  '禁止使用患者术前术后对比照（形象代言）作宣传；禁止利用患者、卫生技术人员、医学教育科研机构及人员的名义或形象作证明。',
  '禁止使用「国家级」「最高级」「最佳」「第一」等绝对化用语；禁止「根治」「包治」「无痛」「100%」「永不复发」等疗效承诺表述。',
  '禁止与其他医疗机构比较或贬低他人，禁止使用广告代言人作推荐、证明。',
  '不得向未成年人及其相关媒介发布口腔正畸等可能影响未成年人身心健康的广告。',
  '不得以内部科室名义发布医疗广告；科室内容须以机构主体名义发布。',
];

export const MEDICAL_COMPLIANCE_SOURCE = {
  label: '汕头市市场监督管理局《汕头市医疗广告发布合规指引》（2026年第2号）',
  url: 'https://www.shantou.gov.cn/stssjgj/gkmlpt/content/2/2559/post_2559007.html?jump=true',
  official: true,
};

// ==================== 平台入驻知识库 ====================
export const PLATFORM_ONBOARDING = [
  // ---------------------------------------------------------------- 美团 / 大众点评
  {
    id: 'meituan',
    name: '美团 / 大众点评',
    icon: '🦷',
    category: 'local_life',
    entryType: '自主入驻（口腔属医疗类目，需补行业资质）',
    verified: true,
    verifiedNote:
      '资质清单来自「美团规则中心」公开发布的行业资质要求；入驻流程与审核时效来自美团开店宝官方教程页。费用未在官方公开页面公示，已标待核验。',
    officialUrl: 'https://ecom.meituan.com/emis/intro/tutorial/chapter/2',
    summary:
      '口腔门诊同城到店的第一大入口。美团与大众点评已合并商家侧，统一走「美团开店宝 / 商家中心」认领门店 + 提交资质。',
    qualifications: [
      {
        text: '营业执照（在有效期内，经营范围覆盖实际经营服务）',
        verified: true,
      },
      {
        text: '医疗机构执业许可证',
        verified: true,
        note: '美团规则中心「齿科」类目明确列出的必需资质。',
      },
      {
        text: '公众聚集场所投入使用、营业前消防安全检查合格证',
        verified: true,
        note: '美团规则中心「齿科」类目明确列出的必需资质，常被忽略。',
      },
      {
        text: '《医疗广告审查证明》（涉及诊疗项目推广 / 团购页面宣传时）',
        verified: true,
        note: '平台行业资质清单未单列，但属法定要求：医疗广告发布前必须经卫健部门审查。',
      },
      {
        text: '诊疗科目须含口腔科；医师资质与上架项目匹配（如主推正畸需有相应资质）',
        verified: false,
        note: '行业通行审核口径，美团规则中心「齿科」条目未逐项单列，以开店宝资质上传页实际提示为准。',
      },
    ],
    materials: [
      { text: '门店营业执照照片 / 扫描件（有效期内、清晰完整、无遮挡、不反光）', required: true, verified: true },
      { text: '医疗机构执业许可证（诊疗科目含口腔科，加盖公章或原件拍摄）', required: true, verified: true },
      { text: '法定代表人 / 经营者身份证正反面（须与营业执照法人一致）', required: true, verified: true },
      { text: '门头照（含完整招牌，名称与营业执照 / 门店名一致）', required: true, verified: true },
      { text: '门店环境实景照（前台、诊室、设备；不得出现患者正脸）', required: true, verified: true },
      { text: '公众聚集场所投入使用、营业前消防安全检查合格证', required: true, verified: true },
      { text: '结算银行账户信息（公司对公账户或个体经营者账户）', required: true, verified: false },
      { text: '医疗广告审查证明（团购 / 推广页面涉及诊疗项目时）', required: true, verified: true },
      { text: '医师执业证书（平台按上架项目要求时补充）', required: false, verified: false },
    ],
    steps: [
      {
        title: '准备基础资料',
        detail: '门店营业执照（有效期内真实有效）+ 经营者身份证（须与营业执照法人一致）。资料均在线上入驻过程中拍照上传，无需提交实物。',
        verified: true,
      },
      {
        title: '注册 / 登录美团开店宝',
        detail: '首次使用先注册账号，注册成功后开始认领门店；已有开店宝账号可直接登录，从上次中断的环节恢复认领。',
        verified: true,
      },
      {
        title: '认领门店',
        detail: '门店若已被大众点评收录，直接搜索店名并绑定；搜索不到则创建新门店，提交店名、地址、电话、门头照片等资料。',
        verified: true,
      },
      {
        title: '提交资质并等待审核',
        detail: '按提示分别上传身份证正反面照片、营业执照照片，并完成实名认证。提交后平台对门店与资质进行审核，审核结果在 3 个工作日内以短信方式通知。',
        verified: true,
      },
      {
        title: '按「齿科」类目补充行业资质',
        detail: '上传医疗机构执业许可证、公众聚集场所投入使用营业前消防安全检查合格证；涉及诊疗项目推广的同步准备医疗广告审查证明。',
        verified: true,
      },
      {
        title: '搭团购结构与门店信息',
        detail: '按引流款（洁牙 / 检查）+ 主推款（补牙 / 美白）+ 高客单款（正畸 / 种植咨询）配置团购，每项写清适用人群、禁忌与是否含检查费。',
        verified: false,
      },
      {
        title: '上线后维护',
        detail: '保持电话畅通、营业时间（含节假日）准确，及时回复评价，尤其 24 小时内响应差评。',
        verified: false,
      },
    ],
    pitfalls: [
      { text: '门店名与营业执照 / 医疗机构执业许可证 / 门头照不一致 → 直接驳回', verified: true },
      { text: '资质照片模糊、反光、遮挡、翻拍或缺角 → 驳回，是最常见的失败原因', verified: true },
      { text: '门店已被他人认领 → 需在系统提示的认领人手机号非本人时点「申诉」，提交法人身份证、营业执照、营业场所证明重新认领', verified: true },
      { text: '团购文案出现「无痛」「根治」「最好」「保证不复发」等疗效承诺 / 绝对化用语 → 下架并可能处罚', verified: false },
      { text: '医师资质与主推项目不匹配（无相应资质主推正畸 / 种植）→ 下架并处罚', verified: false },
      { text: '刷评价 / 返现换好评 → 平台风控识别后降权甚至关店，且涉嫌不正当竞争', verified: false },
      { text: '只投推广不等真实评价积累就加预算 → 转化率低，钱花在漏斗漏的位置', verified: false },
    ],
    reviewCycle: {
      text: '官方口径：提交材料后审核结果在 3 个工作日内以短信通知。行业资质补充、团购商品审核时长未在官方页面公示，以开店宝后台实际进度为准。以上仅供参考，以平台实际为准。',
      verified: true,
    },
    feeNote: {
      text: '未在美团官方公开页面查到「齿科」类目统一的入驻费 / 保证金金额。平台规则中心仅说明资质要求会随法规调整。入驻相关的技术服务费、推广充值等以开店宝后台签约页与平台合同为准；第三方代办给出的报价不等同官方政策。',
      verified: false,
    },
    medicalCompliance: [
      ...MEDICAL_AD_COMPLIANCE,
      '美团平台侧：团购详情页若出现机构名、地址、联系方式并引导就诊，即可能被认定为医疗广告，需持有《医疗广告审查证明》。',
    ],
    source: [
      {
        label: '美团规则中心 · 《美团医药健康到店业务商户行业资质要求》（齿科条目）',
        url: 'https://rules-center.meituan.com/rules-detail/1528?commonType=20',
        official: true,
      },
      {
        label: '美团规则中心 · 《平台合作商户行业准入和资质规范》（齿科条目）',
        url: 'https://rules-center.meituan.com/rules-detail/97',
        official: true,
      },
      {
        label: '美团开店宝 · 官方教程《二、认领您的门店》（入驻四步 + 3 个工作日审核）',
        url: 'https://ecom.meituan.com/emis/intro/tutorial/chapter/2',
        official: true,
      },
      MEDICAL_COMPLIANCE_SOURCE,
    ],
  },

  // ---------------------------------------------------------------- 抖音团购 / 抖音来客
  {
    id: 'douyin',
    name: '抖音团购 / 抖音来客',
    icon: '🎵',
    category: 'local_life',
    entryType: '定向邀约准入（类目报白）',
    verified: true,
    verifiedNote:
      '入驻要求与齿科行业资质来自「抖音生活服务 - 学习中心」公开发布的《综合行业【齿科】经营类目管理规范》。保证金 / 佣金金额与审核时长未在官方页面公示，已标待核验。',
    officialUrl: 'https://www.lifexue.com/rule/detailhistory/247591087362',
    summary:
      '口腔（齿科）在抖音属「医疗健康 - 专科医疗机构 - 齿科」类目，仅支持到店服务，且仅支持抖音来客定向邀约准入 —— 不能像餐饮那样自主开通，必须先完成类目报白。',
    qualifications: [
      { text: '入驻主体为在中国大陆地区注册的个体工商户、企业或单位', verified: true },
      { text: '经营范围及经营期限在营业执照规定的经营范围及期限内', verified: true },
      { text: '经营类目：医疗健康 - 专科医疗机构 - 齿科（仅支持到店服务）', verified: true },
      { text: '仅支持抖音来客定向邀约准入（非开放类目）', verified: true },
      { text: '入驻主体一年内无重大医疗事故和相关舆情', verified: true },
      { text: '只能以机构整体入驻，不能以单独科室 / 部门入驻', verified: true },
      { text: '《医疗机构执业许可证》或《诊所备案凭证》', verified: true },
      { text: '医疗广告审查表（含样表）', verified: true },
      {
        text: '《医师执业证》—— 需上传 3 名从业医师的完整证书内页，含姓名、证书编码、执业范围、执业机构、发证机关、签发单位公章',
        verified: true,
      },
      { text: '《公共场所卫生许可证》', verified: true },
      { text: '基础资质距有效期截止应大于 15 天；资质证件不得借用、不得挂靠', verified: true },
      {
        text: '品牌商家需商标注册证（国际分类与经营类目匹配）+ 二级以内完整授权；连锁仅可认领控股直营或经商务部商业特许经营全国联网备案的加盟门店',
        verified: true,
      },
    ],
    materials: [
      { text: '三证合一营业执照原件扫描件，或加盖公章的复印件（个体户经营人签字摁手印）', required: true, verified: true },
      { text: '法定代表人 / 经营者二代身份证正反面（不支持电子版身份证；复印件需本人签字 + 手印）', required: true, verified: true },
      { text: '法定代表人 / 经营者有效联系方式', required: true, verified: true },
      { text: '《医疗机构执业许可证》或《诊所备案凭证》', required: true, verified: true },
      { text: '医疗广告审查表（含样表）', required: true, verified: true },
      { text: '3 名从业医师《医师执业证》完整内页', required: true, verified: true },
      { text: '《公共场所卫生许可证》', required: true, verified: true },
      { text: '商标注册证及授权书（品牌 / 连锁商家）', required: false, verified: true },
      { text: '门头实景照与门诊内部环境实拍图（无修图、不模糊、不反光）', required: true, verified: false },
      { text: '团购项目实拍图、套餐服务明细、预约须知、禁忌人群提示', required: true, verified: false },
      { text: '对公账户信息（用于团购核销资金结算）', required: true, verified: false },
    ],
    steps: [
      {
        title: '先确认准入方式：齿科是定向邀约类目',
        detail: '口腔不属于开放类目，必须在抖音来客完成「类目报白」才能创建团购。跳过报白直接尝试，无论提交多少次都选不到类目、建不了团购。',
        verified: true,
      },
      {
        title: '准备主体资质',
        detail: '三证合一营业执照（有效期剩余 > 15 天）、法定代表人 / 经营者二代身份证正反面、有效联系方式。所有证件主体名称与经营地址尽量保持完全一致。',
        verified: true,
      },
      {
        title: '准备齿科行业资质',
        detail: '《医疗机构执业许可证》或《诊所备案凭证》+ 医疗广告审查表（含样表）+ 3 名从业医师《医师执业证》完整内页 +《公共场所卫生许可证》。',
        verified: true,
      },
      {
        title: '提交类目报白审核',
        detail: '通过抖音来客 / 服务商 / 行业运营提交报白。不要用截图、过度修图或模糊反光的证件照片，这类问题最长会拖到数周。',
        verified: false,
      },
      {
        title: '报白通过后登录抖音来客认领 POI 门店',
        detail: '认领门店时核对门店名称、地址与导航定位点，定位偏差会直接影响核销与到店体验。',
        verified: false,
      },
      {
        title: '按平台要求缴纳类目保证金',
        detail: '金额以保证金收费标准官方页面与抖音来客后台实际提示为准，本库不提供具体数字。',
        verified: false,
      },
      {
        title: '创建团购套餐',
        detail: '按平台当期商品准入范围创建。历史公开口径中曾仅限洗牙与部分牙齿美白类（冷光美白、皓齿、植物美白），正畸 / 种植等是否开放以平台当期规范与后台可选类目为准。',
        verified: false,
      },
      {
        title: '内容引流与核销运营',
        detail: '短视频 / 直播承接同城流量，配合客服与预约链路完成到店核销；遵守《生活服务医疗服务类内容规范》等平台内容规范。',
        verified: true,
      },
    ],
    pitfalls: [
      { text: '所有证件主体名称、经营地址出现细微偏差 → 初审驳回（最常见失败原因）', verified: false },
      { text: '用截图、过度修图、模糊反光的证件照片 → 拉长审核周期', verified: false },
      { text: '项目描述触碰合规红线（疗效承诺、绝对化用语、术前术后对比）→ 驳回或下架', verified: false },
      { text: '误以为可自主开通：齿科属定向邀约，未报白无法创建团购', verified: true },
      { text: '医师执业证专业方向与上架项目不匹配 → 驳回', verified: false },
      { text: '团购商品超出平台当期准入品类 → 无法上架', verified: false },
      { text: '资质证件借用 / 挂靠 → 明确违规，会被清退', verified: true },
    ],
    reviewCycle: {
      text: '抖音官方《综合行业【齿科】经营类目管理规范》未公示统一审核时长。第三方经验多为 1~7 个工作日，未获官方确认。以抖音来客后台实际进度为准，仅供参考。',
      verified: false,
    },
    feeNote: {
      text: '抖音官方规范未公示齿科类目保证金与佣金的具体金额。网络流传的「保证金 20 万」「齿科佣金 10%」等数字来自 2023 年第三方文章，未获官方确认，不予采信。以保证金收费标准官方页面与抖音来客后台实际提示为准。',
      verified: false,
    },
    medicalCompliance: [
      ...MEDICAL_AD_COMPLIANCE,
      '抖音侧要求提交「医疗广告审查表（含样表）」，即平台把医疗广告前置审查作为齿科准入的硬性材料之一。',
      '团购详情页须写清禁忌人群与「效果因人而异，需面诊评估」，不得展示未经脱敏的病例与术前术后对比。',
    ],
    source: [
      {
        label: '抖音生活服务 - 学习中心 · 《综合行业【齿科】经营类目管理规范》',
        url: 'https://www.lifexue.com/rule/detailhistory/247591087362',
        official: true,
      },
      MEDICAL_COMPLIANCE_SOURCE,
    ],
  },

  // ---------------------------------------------------------------- 快手本地生活
  {
    id: 'kuaishou',
    name: '快手本地生活',
    icon: '🎥',
    category: 'local_life',
    entryType: '自主入驻（医疗专科类目资质以页面为准）',
    verified: false,
    verifiedNote:
      '通用入驻流程、材料与 1~5 个工作日审核时效来自快手大学官方《快手生活服务商家运营手册 - 入驻篇》；但「齿科 / 口腔」类目的具体行业资质清单未在快手官方公开页面查到，相关条目标为待核验。',
    officialUrl: 'https://university.kuaishou.com/rule/knowledge/1450',
    summary:
      '快手本地生活侧入驻流程在官方手册里写得比较完整（单店 / 连锁两条路）。医疗专科类目需在选择经营类目后按页面提示上传行业资质。',
    qualifications: [
      { text: '确认是个体工商户或企业法人 / 经营人', verified: true },
      { text: '核对营业执照在有效经营期限内', verified: true },
      { text: '售卖的商品和服务在营业执照显示的经营范围内', verified: true },
      { text: '商品和服务属于平台招商类目，并具备相关资质', verified: true },
      { text: '商品和服务完全符合法律及行业标准质量要求', verified: true },
      {
        text: '口腔 / 齿科类目行业资质：官方公开手册未逐项列出，行业通行需《医疗机构执业许可证》及医疗广告审查相关材料',
        verified: false,
        note: '以快手本地生活商家后台选择类目后「查看资质要求」页面实际提示为准。',
      },
      {
        text: '品牌商家需商标注册证原件或加盖商标注册方公章的复印件，否则不能使用相关品牌信息入驻',
        verified: true,
      },
    ],
    materials: [
      { text: '三证合一的营业执照原件扫描件，或加盖公司公章的营业执照复印件（距有效期截止 > 15 天）', required: true, verified: true },
      { text: '法定代表人或经营人身份证件（不支持电子版身份证）', required: true, verified: true },
      { text: '银行账户信息', required: true, verified: true },
      { text: '商标注册证 / 加盖公章复印件（品牌商家）', required: false, verified: true },
      { text: '门店电话、头图、内景图', required: true, verified: true },
      { text: '行业资质：选择经营类目后按页面要求上传（口腔类目具体清单待核验）', required: true, verified: false },
      { text: '对公账户信息（用于交易结算）', required: true, verified: false },
      { text: '医疗机构执业许可证、医疗广告审查相关材料、医师资质（口腔类目，待核验）', required: false, verified: false },
    ],
    steps: [
      {
        title: '确认入驻条件',
        detail: '主体类型、执照有效期、经营范围是否覆盖拟售服务、是否属于平台招商类目并具备相关资质、是否符合法律及行业标准质量要求。',
        verified: true,
      },
      {
        title: '选择入驻方式',
        detail: '单店商家：快手 App 或「本地生活商家后台」电脑版入驻；连锁商家（品牌 / 非品牌）只能在电脑版入驻。单店只能认领 1 个门店，连锁可认领多个。',
        verified: true,
      },
      {
        title: '单店 · 手机端入驻',
        detail: '快手 App → 左上角图标 →「团购·优惠」→「商家入驻」→「立即开店」→ 阅读同意协议 → 经营类型选「经营一家店」。',
        verified: true,
      },
      {
        title: '单店 · 电脑端入驻',
        detail: '登录 https://www.kwailocallife.com/ → 快手 App 扫码登录 → 门店类型选「经营一家店」→「搜索门店」→「查询」→「认领门店」→ 签署门店认领承诺书。',
        verified: true,
      },
      {
        title: '填写资质',
        detail: '门店信息（电话 / 头图 / 内景图）、企业 / 法人信息、行业资质、法人实名信息。资质要求在选择经营类目后可查看。',
        verified: true,
      },
      {
        title: '提交审核',
        detail: '官方口径：资质审核时间预计 1~5 个工作日（批量认领约 5 个工作日左右），在页面可查看进度并继续认领新门店。',
        verified: true,
      },
      {
        title: '发布商品（团购）',
        detail: '生活服务商家中心 → 商品管理 → 发布新商品 → 选类目与商品类型 → 选适用门店（仅已认领门店）→ 填名称头图、规格价格库存、购买须知、客服电话 / 退款政策等服务承诺 → 提交。',
        verified: true,
      },
      {
        title: '查看商品审核结果',
        detail: '在「商品管理 - 商品列表」找到对应商品，在「创建时间」一栏查看驳回原因。',
        verified: true,
      },
    ],
    pitfalls: [
      {
        text: '营业执照类型选错被驳回：统一社会信用代码由 18 位阿拉伯数字或大写英文字母组成（不使用 I、O、Z、S、V）',
        verified: true,
      },
      { text: '有效期录入错误被驳回：证件上无有效期默认为长期有效', verified: true },
      { text: '搜索不到要认领的门店 → 需备齐正确门店名称与地址、错误门店名称与地址（如有）、门店头图、联系人电话联系快手客服', verified: true },
      { text: '行业资质照片选错 → 进入行业资质补充界面，点击照片位置 →「已了解」→ 重新选择上传正确资质照片', verified: true },
      { text: '口腔 / 齿科类目资质清单以平台当期要求为准，勿照搬其他平台清单', verified: false },
      { text: '团购页面夸大疗效（「终身质保」「成功」等）→ 驳回且违反医疗广告规定', verified: false },
    ],
    reviewCycle: {
      text: '官方口径：资质审核预计 1~5 个工作日；批量认领约 5 个工作日左右。仅供参考，以快手本地生活商家后台实际进度为准。',
      verified: true,
    },
    feeNote: {
      text: '快手官方《入驻篇》手册未公示口腔类目保证金 / 佣金金额。平台规则中心另有《快手生活服务商家入驻及资质要求》与保证金规范，具体以商家后台实际提示为准；第三方招商文章流传的「免保证金 / 保证金金额」未获官方确认，不予采信。',
      verified: false,
    },
    medicalCompliance: [
      ...MEDICAL_AD_COMPLIANCE,
      '团购页面需展示医师资质与机构信息，明确禁忌人群（如严重牙周病患者慎做种植），并标注「效果因人而异」。',
    ],
    source: [
      {
        label: '快手大学 · 《快手生活服务商家运营手册 - 入驻篇》',
        url: 'https://university.kuaishou.com/rule/knowledge/1450',
        official: true,
      },
      MEDICAL_COMPLIANCE_SOURCE,
    ],
  },

  // ---------------------------------------------------------------- 高德地图
  {
    id: 'amap',
    name: '高德地图',
    icon: '📍',
    category: 'map_poi',
    entryType: '自主标注（免费）+ 付费增值（旺铺 / 商户通）',
    verified: false,
    verifiedNote:
      '高德官网（bgc.amap.com）仅提供商家入驻入口与「高德旺铺」产品介绍，未检索到公开发布的口腔 / 医疗类目行业资质细则，也未公示审核时效与资费。下方流程与时效来自高德商家中心官方说明的第三方转载，整条标为待核验，请以高德商家后台实际提示为准。',
    officialUrl: 'https://bgc.amap.com/',
    summary:
      '门店标注是被「附近的人」搜到并导航到店的基础设施。基础门店标注免费；「高德旺铺 / 商户通」属于付费增值服务，用于拿认证标识、团购与优先曝光。',
    qualifications: [
      { text: '营业执照（有效期内，经营范围包含实际经营项目）', verified: false },
      { text: '医疗行业需提供《医疗机构执业许可证》（行业资质信息需与营业资质一致）', verified: false },
      { text: '门店名称须与门脸照片上的招牌一致（分店可加括号备注）', verified: false },
      { text: '门脸照须现场实拍：门头清晰、图片真实、不得 PS / 涂抹、不得含其他平台或用途水印', verified: false },
      { text: '法人身份证 / 经营者身份证，须与营业执照法人信息一致', verified: false },
      { text: '资质须在有效期内，法人身份证号与资质匹配', verified: false },
    ],
    materials: [
      { text: '营业执照（真实拍摄上传原件图片，四角完整、公章可辨认、文字清晰无遮挡，避免反光与其他平台水印）', required: true, verified: false },
      { text: '门脸照（含完整招牌及周边环境，现场实拍，不可翻拍）', required: true, verified: false },
      { text: '店内环境照', required: true, verified: false },
      { text: '法人 / 经营者身份证正反面', required: true, verified: false },
      { text: '营业电话（可接通）与营业时间（含节假日安排）', required: true, verified: false },
      { text: '门店定位（拖动图面扎点选定，详细地址精确到门牌号）', required: true, verified: false },
      { text: '行业资质：医疗需《医疗机构执业许可证》', required: true, verified: false },
      { text: '经营场所备案（选填：工商官网经营场所备案截图、房产产权或租赁证明、合作协议等，有助于快速通过）', required: false, verified: false },
      { text: '品牌授权书 / 连锁证明（连锁品牌，用于开通多门店管理）', required: false, verified: false },
    ],
    steps: [
      {
        title: '进入入驻入口',
        detail: '高德地图 App →「我的」→「我的店铺」；或访问高德商家开放平台 bgc.amap.com 选择「我是商家」入驻。',
        verified: false,
      },
      {
        title: '认领或新增门店',
        detail: '方式一：滑动搜索框下的门店名称查找；方式二：搜索框输入店铺名称认领；方式三：都找不到时点右下角「添加新门店」。',
        verified: false,
      },
      {
        title: '确认门店名称与门店分类',
        detail: '门店名称需与门脸照招牌一致；门店分类需贴合实际经营种类，选错分类会影响审核结果。',
        verified: false,
      },
      {
        title: '确认门店位置与详细地址',
        detail: '建议在店铺现场操作（需开定位权限）；拖动图面扎点选定门店正门位置，详细地址精确到门牌号。',
        verified: false,
      },
      {
        title: '上传门脸照',
        detail: '现场实拍，门头清晰真实，不得翻拍、PS、涂抹，不得含其他平台水印。',
        verified: false,
      },
      {
        title: '上传营业执照',
        detail: '真实拍摄原件，营业执照与认领地址一致；四角完整、公章可辨认、文字清晰无遮挡。',
        verified: false,
      },
      {
        title: '补充更多信息',
        detail: '添加营业电话与营业时间；可上传经营场所证明（备案截图 / 产权或租赁证明 / 合作协议）以加快审核。',
        verified: false,
      },
      {
        title: '补充行业资质',
        detail: '医疗等行业需提供行业资质，且行业资质信息需与营业资质一致（名称、主体一致）。',
        verified: false,
      },
      {
        title: '提交审核',
        detail: '核对信息、勾选协议后提交。官方说明：绝大部分审核可在 24 小时内返回结果，遇节假日可能延长到 72 小时。',
        verified: false,
      },
      {
        title: '持续维护',
        detail: '定期检查信息是否被误改，更新节假日营业时间，鼓励到店患者留下真实评价。',
        verified: false,
      },
    ],
    pitfalls: [
      { text: '门店名称与门脸照招牌 / 资质不一致 → 驳回', verified: false },
      { text: '门店名里塞营销词（如「XX口腔 · 种植牙第一品牌」）→ 驳回，且涉医疗广告违规', verified: false },
      { text: '定位点偏移（落到商场中心或马路对面）→ 导航把患者带到错误入口，直接产生差评', verified: false },
      { text: '营业执照地址与实际门店地址不一致且无地址变更 / 分支机构证明 → 驳回', verified: false },
      { text: '门脸照翻拍 / PS / 带其他平台水印 → 驳回', verified: false },
      { text: '只标注不运营：电话无人接、营业时间错误 → 免费流量变成负面口碑', verified: false },
      { text: '第三方代办报价（旺铺 / 商户通年费）不等于官方政策，以高德商家后台实际报价为准', verified: false },
    ],
    reviewCycle: {
      text: '官方说明：绝大部分审核可在 24 小时内返回结果，遇节假日可能延长到 72 小时。该说明来自高德商家中心官方内容的第三方转载，未在高德官网公示，仅供参考，以商家后台实际进度为准。',
      verified: false,
    },
    feeNote: {
      text: '未在高德官方公开页面查到统一资费。基础门店标注为免费入口；「高德旺铺」「商户通」属付费增值服务，价格以高德商家后台实际报价为准。第三方站点流传的具体年费金额未获官方确认，不予采信。',
      verified: false,
    },
    medicalCompliance: [
      ...MEDICAL_AD_COMPLIANCE,
      '门店名称、相册与公告同样受医疗广告约束：不得出现疗效、排名、绝对化用语。',
    ],
    source: [
      { label: '高德商家开放平台（官方入驻入口与旺铺介绍）', url: 'https://bgc.amap.com/', official: true },
      MEDICAL_COMPLIANCE_SOURCE,
    ],
  },

  // ---------------------------------------------------------------- 腾讯地图
  {
    id: 'tencentmap',
    name: '腾讯地图',
    icon: '🗺️',
    category: 'map_poi',
    entryType: '免费标注（地主认证）',
    verified: true,
    verifiedNote:
      '入驻流程、审核时效、驳回原因与「全程免费」均来自腾讯位置服务官方 FAQ 与腾讯客服官方页。官方 FAQ 未单列医疗行业资质要求，该条标为待核验。',
    officialUrl: 'https://lbs.qq.com/FAQ/merchant_label_faq.html',
    summary:
      '腾讯地图商户标注（地主认证）官方明确免费，且信息会同步到微信「发送位置」等场景 —— 对依赖微信生态的口腔门诊是必做项。',
    qualifications: [
      { text: '各类企事业单位、个体工商户，均可对自己的经营场所 / 实体店铺申请商户标注', verified: true },
      { text: '须持有营业执照 —— 执照还在办理中不能做商户标注（可先在腾讯地图 App 走普通数据新增：名称、地址、坐标、电话、门店照）', verified: true },
      { text: '商户名称须与门脸照片的招牌一致；营业执照是判断实体店铺真实存在及合法经营的唯一依据', verified: true },
      { text: '认领时须上传营业执照上的法人信息，且营业执照地址应与店铺地址保持一致', verified: true },
      { text: '自注册成立 / 信息变更之日起需满 14 个工作日后再入驻（平台需进行库源更新）', verified: true },
      {
        text: '口腔 / 医疗行业资质：官方 FAQ 未单列，建议在「其他材料」中补充《医疗机构执业许可证》以加快审核',
        verified: false,
      },
    ],
    materials: [
      { text: '营业执照（有效期内）', required: true, verified: true },
      { text: '门头照 / 门店照（含招牌，与商户名称一致）', required: true, verified: true },
      { text: '详细街道地址（X 街道 X 号；商城内细化至 X 商城内 X 层）', required: true, verified: true },
      { text: '坐标位置（与地址指向一致）', required: true, verified: true },
      { text: '可接通的联系电话（工作人员会在提交后 1~3 天 08:00-18:00 电话核实）', required: true, verified: true },
      { text: '营业时间', required: true, verified: true },
      { text: '法人信息（与营业执照一致）', required: true, verified: true },
      { text: '经营场所备案（工商官网备案截图 / 房产产权或租赁证明 / 合作协议，有助于快速通过）', required: false, verified: true },
      { text: '《医疗机构执业许可证》（口腔行业建议补充）', required: false, verified: false },
    ],
    steps: [
      {
        title: '找到入口',
        detail: '微信关注公众号「腾讯位置服务」→ 左下角「我是地主」→「地主认证」；或微信搜「腾讯地图商户中心」小程序；或 PC 访问 https://lbs.qq.com/dev/console/merchantLabel/index 。',
        verified: true,
      },
      {
        title: '先检索是否已收录',
        detail: '新增标注时先在腾讯地图搜索是否已收录该商户，避免重复建点。',
        verified: true,
      },
      {
        title: '认领或创建',
        detail: '搜索有结果 → 认领（发现数据错误也可认领后修改）；查询无结果 → 点「没有我要的地点，马上创建」。',
        verified: true,
      },
      {
        title: '填写并上传资料',
        detail: '按页面提示填写名称、详细地址、坐标、电话、营业时间，上传门头照与营业执照等资质材料；代领需提交授权委托书。',
        verified: true,
      },
      {
        title: '提交审核',
        detail: '官方口径：审核时间为 48 小时内；提交后 1~2 天内可在「我标注的地点」列表查看是否通过。审核完成前信息不会生效，不必重复提交。',
        verified: true,
      },
      {
        title: '通过后的生效与展示',
        detail: '搜索一般在审核通过后 1 天内生效；是否会在底图默认展示名称由程序按地理位置、检索次数等因素自动控制，人工无法干预。',
        verified: true,
      },
      {
        title: '批量标注（连锁 / 多店）',
        detail: 'PC 访问 https://lbs.qq.com/dev/console/merchantLabel/uploadShops 批量上传；连锁品牌可在商户中心选择「连锁品牌」身份完成商标与主体资质认证后批量认领。',
        verified: true,
      },
      {
        title: '后续纠错',
        detail: '信息有误可走「地点纠错」：公众号「我是地主」→「地主认证」→「我标注的地点」→ 右上角「地点纠错」→ 选择错误类型并补充正确信息。',
        verified: true,
      },
    ],
    pitfalls: [
      { text: '名称不规范或错误：商户名称与门脸照片招牌不一致 → 未通过', verified: true },
      { text: '地址问题：未填写到 X 街道 X 号，或地址与坐标位置指向不一致 → 未通过', verified: true },
      { text: '电话错误（多位少位）/ 无法接通 / 不配合核实 → 未通过', verified: true },
      { text: '营业执照地址与店铺地址不一致，或法人信息未按要求上传 → 认领失败', verified: true },
      { text: '刚注册成立或刚变更信息就提交 → 需自成立 / 变更日起 14 个工作日后再入驻', verified: true },
      { text: '找第三方收费代办 → 官方明确标注与纠错全程免费，任何收费代办均非官方', verified: true },
      { text: '港澳台或外籍人士证件暂无法识别 → 需选择「他人代领」方式入驻', verified: true },
    ],
    reviewCycle: {
      text: '官方口径：审核时间 48 小时内；1~2 天内可查看结果，搜索一般在通过后 1 天内生效，底图名称展示依赖下月数据更新周期。仅供参考，以平台实际为准。',
      verified: true,
    },
    feeNote: {
      text: '腾讯位置服务官方 FAQ 明确：申请商户标注、已有商家标注错误修改均是免费，不收取任何费用，请勿相信任何个人或公司收费代提交。增值版本（基础版 / 营销版）权益未在公开页面公示价格，以商户中心实际为准。',
      verified: true,
    },
    medicalCompliance: [
      ...MEDICAL_AD_COMPLIANCE,
      '门店名称与相册不得出现疗效、排名、绝对化用语；POI 展示内容同样受《医疗广告管理办法》约束。',
    ],
    source: [
      {
        label: '腾讯位置服务 · 《商户标注常见问题》（官方 FAQ）',
        url: 'https://lbs.qq.com/FAQ/merchant_label_faq.html',
        official: true,
      },
      {
        label: '腾讯客服 · 《为什么我的审核结果"未通过"》',
        url: 'https://kf.qq.com/faq/230914uuaUZr230914mIZVZf.html',
        official: true,
      },
      MEDICAL_COMPLIANCE_SOURCE,
    ],
  },

  // ---------------------------------------------------------------- 微信视频号
  {
    id: 'shipinhao',
    name: '微信视频号',
    icon: '💚',
    category: 'content',
    entryType: '机构认证 + 行业资质（开店属本地生活定向准入）',
    verified: false,
    verifiedNote:
      '视频号机构认证、行业资质认证与视频号小店本地生活开店流程均来自微信官方页面；但「口腔 / 齿科」是否在视频号小店本地生活定向准入类目内、以及认证年费 / 保证金金额，未查到官方明确说明，相关条目标为待核验。',
    officialUrl: 'https://store.weixin.qq.com/chengzhang/webdoc/wiki/584/37585f2af4406691',
    summary:
      '两条路：一是「视频号机构认证 + 医疗行业资质」（做科普 / 品牌内容，官方明确涉及医疗科普需《医疗机构执业许可证》）；二是「视频号小店 - 本地生活」开店（需看定向准入标准）。',
    qualifications: [
      { text: '机构持证人：提交的资质材料所属主体应与认证的机构主体一致', verified: true },
      { text: '个人持证人：资质材料所属人应与视频号实名及出镜人一致', verified: true },
      { text: '涉及医疗科普内容，需提供《医疗机构执业许可证》申请行业资质', verified: true },
      { text: '本地生活开店：入驻主体应为中国大陆地区注册的企业（营业执照不得在企业经营异常名录中）', verified: true },
      { text: '本地生活开店：所售商品 / 选择的行业大类在营业执照经营范围内', verified: true },
      { text: '本地生活开店：法定代表人身份证正反面，法人须与营业执照一致（复印件需本人签名加盖入驻公司鲜章）', verified: true },
      { text: '目前仅支持使用身份证认证的视频号开启视频号小店 - 本地生活行业', verified: true },
      {
        text: '连锁店另需：商标注册证 / 受理通知书（TM 标需申请满六个月且无驳回复审）、授权书（非自有品牌需一级授权）、《品牌与门店管理关系声明及承诺函》',
        verified: true,
      },
      { text: '口腔 / 齿科是否在视频号小店本地生活定向准入类目内', verified: false, note: '未在官方公开页面查到明确说明，以「视频号小店 - 本地生活定向准入标准」页面实际可选类目为准。' },
    ],
    materials: [
      { text: '主体信息、营业执照扫描件 / 复印件', required: true, verified: true },
      { text: '法定代表人身份证正反面扫描件或复印件（复印件需本人签名 + 公司鲜章）', required: true, verified: true },
      { text: '结算账户、管理员信息', required: true, verified: true },
      { text: '《医疗机构执业许可证》（医疗行业资质 / 医疗科普内容）', required: true, verified: true },
      { text: '店铺 Logo、店铺名称（4~50 个字符，1 个中文算 2 个字符）、主营类目', required: true, verified: true },
      { text: '商标注册证 / 受理通知书 + 授权书（连锁 / 品牌店）', required: false, verified: true },
      { text: '肖像证明（店铺信息涉及人物肖像时）', required: false, verified: true },
      { text: '医疗广告审查证明（内容涉及机构 / 诊疗服务推广时）', required: false, verified: false },
    ],
    steps: [
      {
        title: '准备视频号与主体资质',
        detail: '注册并完善视频号（目前仅支持身份证认证的视频号开启本地生活行业）；备齐营业执照、法人身份证、结算账户、管理员信息。',
        verified: true,
      },
      {
        title: '企业 / 机构认证（电脑端）',
        detail: '登录「视频号助手」→ 选择「视频号机构认证」→ 完成主体验证 → 在填写主体信息页面选择「医疗」行业，并按页面提示上传《医疗机构执业许可证》等证明材料。',
        verified: true,
      },
      {
        title: '补充行业资质（手机端）',
        detail: '已完成机构认证但未做行业资质：进入「创作者中心」→ 轻触账号的「认证标识 > 未上传资质」→ 选择对应行业并上传证明材料。支持认证多个行业资质。',
        verified: true,
      },
      {
        title: '如需开店：进入开店入口',
        detail: '电脑浏览器打开 https://channels.weixin.qq.com/shop → 打开微信扫码 →「申请开店」。',
        verified: true,
      },
      {
        title: '提交商户信息',
        detail: '主体信息、营业执照、结算账户、法人身份证、管理员信息 → 确认经营意愿并签署开通协议。',
        verified: true,
      },
      {
        title: '提交门店信息',
        detail: '业务类型选「本地生活」；店铺类型选「单店 / 连锁店」；选择主营类目；上传店铺头像与名称（涉及名人 / 品牌需提供证明）。',
        verified: true,
      },
      {
        title: '类目申请（定向准入）',
        detail: '按《视频号小店「本地生活」定向准入标准》提交类目申请；口腔是否在可申请类目内，以页面实际可选为准。',
        verified: false,
      },
      {
        title: '内容发布与运营',
        detail: '发布医疗科普需已取得医疗行业资质；内容须遵守《微信视频号运营规范》与《微信视频号资质管理规范》，并符合医疗广告合规要求。',
        verified: true,
      },
    ],
    pitfalls: [
      { text: '资质材料所属主体与认证机构主体不一致 → 审核不通过', verified: true },
      { text: '资质已过期 / 即将到期未更新，或材料遮挡、模糊、信息缺失 → 不通过', verified: true },
      { text: '未完成医疗行业资质就发布医疗科普 / 诊疗相关内容 → 受限，需先补资质', verified: true },
      { text: '已在机构认证但行业类型选错 → 需取消认证后重新按规范完成对应类型认证（个人号）', verified: true },
      { text: '本地生活类目为定向准入，未通过类目申请无法上架团购 / 商品（齿科是否准入待核验）', verified: false },
      { text: '网络流传的「认证年费 300 元 / 每年 2 次认证机会」等数字未获官方确认，以后台实际提示为准', verified: false },
    ],
    reviewCycle: {
      text: '未在微信官方公开页面查到统一的审核时长（机构认证、行业资质、开店类目三段各不相同）。以视频号助手与视频号小店后台实际提示为准，仅供参考。',
      verified: false,
    },
    feeNote: {
      text: '微信官方《行业资质认证指引》明确：行业资质认证申请暂不需要收取审核费用。视频号企业 / 机构认证年费、本地生活保证金等具体金额未在官方公开页面查到统一标准，网络流传数字未获确认，不予采信。以视频号助手 / 小店后台实际提示为准。',
      verified: false,
    },
    medicalCompliance: [
      ...MEDICAL_AD_COMPLIANCE,
      '视频号侧：涉及医疗科普内容必须先完成行业资质认证（提交《医疗机构执业许可证》），否则发布医疗领域内容会受限。',
    ],
    source: [
      {
        label: '微信支持中心 · 《微信视频号资质管理规范》',
        url: 'https://support.weixin.qq.com/cgi-bin/mmsupportacctnodeweb-bin/pages/CgFuOjwO6qjjLeHW',
        official: true,
      },
      {
        label: '微信视频号 · 《行业资质认证指引》',
        url: 'https://findeross.weixin.qq.com/cgi-bin/mmfindernodelivecrmwebbroker-bin/helper-center/pages/92kQT7XxQQEu8SLL',
        official: true,
      },
      {
        label: '微信小店 · 《视频号小店「本地生活行业 - 开店入驻」流程指引》',
        url: 'https://store.weixin.qq.com/chengzhang/webdoc/wiki/584/37585f2af4406691',
        official: true,
      },
      MEDICAL_COMPLIANCE_SOURCE,
    ],
  },

  // ---------------------------------------------------------------- 小红书
  {
    id: 'xiaohongshu',
    name: '小红书',
    icon: '📕',
    category: 'content',
    entryType: '专业号认证 + 行业资质（投放走聚光）',
    verified: false,
    verifiedNote:
      '未检索到小红书官方公开发布的「口腔 / 齿科」类目入驻资质清单或聚光平台行业准入细则。以下流程与材料为行业通行做法整理，整条标为待核验；请以小红书专业号后台与聚光平台「推广资质认证」页面实际提示为准。',
    officialUrl: 'https://creator.xiaohongshu.com',
    summary:
      '小红书做口腔，核心是先拿到「专业号 / 企业机构认证 + 医疗行业资质」，再谈内容与投放。个人号发布诊疗内容风险高，容易被限流。',
    qualifications: [
      { text: '企业主体营业执照（行业经验：经营范围需含口腔医疗服务相关），个体户 / 个人店是否准入待核验', verified: false },
      { text: '《医疗机构执业许可证》（诊疗科目须含口腔科，主体名称与营业执照一致）', verified: false },
      { text: '医师执业证书（行业经验：常被要求提供多名医师资质，且专业方向须与内容 / 项目匹配）', verified: false },
      { text: '《医疗广告审查证明》/ 医疗广告审查表 —— 医疗内容与投放前的法定前置要求', verified: false },
      { text: '《放射诊疗许可证》（涉及牙片拍摄 / X 光 / CBCT 检查，行业经验提示为强制）', verified: false },
      { text: '医疗器械注册证（涉及种植系统、隐形矫治器等器械相关内容，行业经验提示）', verified: false },
    ],
    materials: [
      { text: '营业执照（有效期内、清晰）', required: true, verified: false },
      { text: '法定代表人身份证正反面；非法人认证需加盖公章的认证公函，并配合法人人脸识别', required: true, verified: false },
      { text: '《医疗机构执业许可证》', required: true, verified: false },
      { text: '医师执业证书（按页面要求提供数量）', required: true, verified: false },
      { text: '医疗广告审查相关材料', required: true, verified: false },
      { text: '门头与诊室实景照（用于门店 / 机构信息展示）', required: false, verified: false },
      { text: '行业资质盖章扫描件（按专业号后台页面要求上传）', required: true, verified: false },
    ],
    steps: [
      {
        title: '注册小红书专业号（企业主体）',
        detail: '使用企业信息注册专业号，不建议用个人号发布口腔诊疗相关内容。',
        verified: false,
      },
      {
        title: '完成专业号 / 企业机构认证',
        detail: '提交营业执照、法人身份证（法人认证需人脸识别；非法人认证需加盖公章的公函），审核通过后获得专业号权限。',
        verified: false,
      },
      {
        title: '完成「医疗健康」行业资质认证',
        detail: '在专业号后台按页面提示选择行业并上传《医疗机构执业许可证》等资质。路径以页面实际为准，未做行业资质认证就发种植 / 正畸内容存在限流风险。',
        verified: false,
      },
      {
        title: '如需投放：聚光平台推广资质认证',
        detail: '行业经验路径：聚光平台 → 广告 → 推广资质认证 → 添加行业资质 → 选择所在推广行业 → 上传所需行业资质（需先完成专业号认证）。以页面实际为准。',
        verified: false,
      },
      {
        title: '配置转化工具',
        detail: '如页面开放「留资卡」等营销工具，在专业号后台 - 营销工具中配置，用于私信场景的线索收集。',
        verified: false,
      },
      {
        title: '内容矩阵与发布',
        detail: '科普 / 种草 / 信任 / 活动四类轮换；全部内容须符合医疗广告合规要求（无绝对化用语、无疗效承诺、无术前术后对比）。',
        verified: false,
      },
    ],
    pitfalls: [
      { text: '未做专业号 / 行业资质认证就发布种植、正畸等诊疗内容 → 限流甚至封号风险（行业经验，待核验）', verified: false },
      { text: '医师执业证专业方向与内容 / 项目不匹配（全科医师讲种植）→ 驳回（行业经验，待核验）', verified: false },
      { text: '使用患者术前术后对比图作宣传 → 明确违规（属法定禁止情形，已核验）', verified: false },
      { text: '使用「成功」「终身质保」「最好」等承诺性 / 绝对化表述 → 违规', verified: false },
      { text: '直播演示手术过程 → 高风险，行业经验提示应以科普讲解为主（待核验）', verified: false },
      { text: '网络流传的认证费、保证金、佣金比例、首充门槛数字差异极大且未获官方确认，一律不予采信', verified: false },
    ],
    reviewCycle: {
      text: '未在小书书官方页面查到统一审核时长；行业经验多为 1~7 个工作日（认证与行业资质分两段），未获官方确认。以专业号后台 / 聚光平台实际进度为准。',
      verified: false,
    },
    feeNote: {
      text: '小红书官方未公开发布专业号认证费 / 口腔类目保证金的统一标准。网络流传的「600 元/年认证费」「保证金数千元」「佣金 5%~8%」「首充 5000 元起」等数字均来自第三方招商文章，未获官方确认，不予采信。以专业号后台与聚光平台实际提示为准。',
      verified: false,
    },
    medicalCompliance: [
      ...MEDICAL_AD_COMPLIANCE,
      '小红书内容即使以「科普 / 种草」形式出现，只要挂载机构名、地址、联系方式或引导私信就诊，即可能被认定为医疗广告。',
      '不得展示未经脱敏的病例、检查报告与术前术后对比图；如确需说明效果，须同时说明风险与个体差异。',
    ],
    source: [
      { label: '小红书创作服务平台（官方入口；未检索到口腔类目准入细则）', url: 'https://creator.xiaohongshu.com', official: true },
      MEDICAL_COMPLIANCE_SOURCE,
    ],
  },
];

// ==================== 取用 / 过滤函数 ====================

/** 条目级 verified 缺省时继承平台级 verified。 */
export function resolveVerified(item, platform) {
  if (!item) return false;
  if (typeof item.verified === 'boolean') return item.verified;
  return !!platform?.verified;
}

/** 按 id 取平台定义；取不到返回 null。 */
export function getOnboardingPlatform(id) {
  const k = String(id || '').trim();
  if (!k) return null;
  return PLATFORM_ONBOARDING.find((p) => p.id === k) || null;
}

/**
 * 关键词 + 分组过滤。
 * 关键词命中范围：平台名、入驻性质、简介、资质、材料、步骤、常见坑。
 */
export function filterOnboardingPlatforms({ keyword = '', group = 'all' } = {}) {
  const kw = String(keyword || '').trim().toLowerCase();
  return PLATFORM_ONBOARDING.filter((p) => {
    if (group && group !== 'all' && p.category !== group) return false;
    if (!kw) return true;
    const hay = [
      p.name,
      p.entryType,
      p.summary,
      ...(p.qualifications || []).map((x) => x.text),
      ...(p.materials || []).map((x) => x.text),
      ...(p.steps || []).map((x) => `${x.title} ${x.detail}`),
      ...(p.pitfalls || []).map((x) => x.text),
    ]
      .join(' ')
      .toLowerCase();
    return hay.indexOf(kw) >= 0;
  });
}

/** 统计：已核验 / 待核验 平台数，用于顶部提示。 */
export function countOnboardingVerified() {
  const verified = PLATFORM_ONBOARDING.filter((p) => !!p.verified).length;
  return { verified, total: PLATFORM_ONBOARDING.length, pending: PLATFORM_ONBOARDING.length - verified };
}

export default {
  ONBOARDING_GROUPS,
  PLATFORM_ONBOARDING,
  MEDICAL_AD_COMPLIANCE,
  groupLabel,
  resolveVerified,
  getOnboardingPlatform,
  filterOnboardingPlatforms,
  countOnboardingVerified,
};
