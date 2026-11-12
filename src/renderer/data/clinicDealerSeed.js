/**
 * 第十八/十九轮：牙医·诊所 与经销商 专属功能的种子数据。
 *
 * 【为什么是种子数据而不是接口】
 * 老板 2026-10-14 明确「先做界面与流程，数据用种子」——
 * 这批功能依赖的数据（库存水位、周边诊所、平台差评、电子病历）在现有系统里
 * **一个都没有**，上游货源商城只提供商品/价格。所以本文件先把「真实会长什么样」
 * 定死（字段、文案、量级都按真实业务填），将来接接口只需替换 fetch 实现，
 * 页面结构与流程不动。
 *
 * 每条数据都标了 `source: 'seed'`，页面上会明确标「示例数据」——
 * 不把假数据装成真结果（这批项目吃过"假绿"的亏）。
 */

/* ══════════════════════════════════════════════════════════
   1) 库存与自动补货（需求 1）
   ══════════════════════════════════════════════════════════ */

/** 耗材分类。`must` = 必需（断了会影响诊疗），否则非必须（可用同级替代/更便宜的）。 */
export const STOCK_CATEGORIES = [
  { key: 'mask', label: '口罩', must: true },
  { key: 'glove', label: '手套', must: true },
  { key: 'syringe', label: '一次性器械', must: true },
  { key: 'floss', label: '牙线', must: false },
  { key: 'cavity', label: '树脂充填材料', must: false },
  { key: 'paper', label: '牙科纸品', must: false },
];

/**
 * 库存条目。
 *  - qty / threshold：当前库存量 / 预警阈值（低于即需补货）
 *  - price：本单位进价（元）
 *  - alternatives：非必须耗材的可替代品（补货时优先挑优惠力度大的）
 */
export const SEED_STOCK = [
  { id: 's1', cat: 'mask', name: '一次性医用口罩 50 只/盒', qty: 8, threshold: 20, unit: '盒', price: 18, brand: '稳健', alternatives: ['稳健', '康迪'] },
  { id: 's2', cat: 'glove', name: '丁腈检查手套 100 只/盒', qty: 5, threshold: 15, unit: '盒', price: 32, brand: '爱康', alternatives: ['爱康', '蓝枫'] },
  { id: 's3', cat: 'syringe', name: '一次性口腔器械包', qty: 12, threshold: 25, unit: '包', price: 26, brand: '康迪', alternatives: ['康迪'] },
  { id: 's4', cat: 'floss', name: '无蜡牙线 50 m/卷', qty: 30, threshold: 10, unit: '卷', price: 9.5, brand: ' Oral-B', alternatives: ['Oral-B', '洁客', '冷酸灵'] },
  { id: 's5', cat: 'cavity', name: '光固化复合树脂 A2 4g', qty: 6, threshold: 8, unit: '支', price: 145, brand: '3M', alternatives: ['3M', '登士柏'] },
  { id: 's6', cat: 'paper', name: '牙科小号吸唾管包', qty: 24, threshold: 10, unit: '包', price: 14, brand: '洁客', alternatives: ['洁客', '康迪'] },
];

/** 候选供应商报价（同物不同牌，用来比「优惠力度」）。 */
export const SEED_SUPPLIER_QUOTES = [
  { itemId: 's1', supplier: '稳健医疗', brand: '稳健', price: 18, moq: 5, discount: '满 10 盒 9 折' },
  { itemId: 's1', supplier: '康迪优选', brand: '康迪', price: 15.3, moq: 10, discount: '新客 85 折' },
  { itemId: 's2', supplier: '爱康直供', brand: '爱康', price: 32, moq: 5, discount: '满 20 盒 88 折' },
  { itemId: 's2', supplier: '蓝枫医疗', brand: '蓝枫', price: 27.2, moq: 10, discount: '限时 85 折' },
  { itemId: 's4', supplier: 'Oral-B 旗舰', brand: 'Oral-B', price: 9.5, moq: 10, discount: '无优惠' },
  { itemId: 's4', supplier: '洁客官方', brand: '洁客', price: 7.1, moq: 20, discount: '限时 75 折' },
  { itemId: 's4', supplier: '冷酸灵专营', brand: '冷酸灵', price: 6.65, moq: 30, discount: '批发 70 折' },
  { itemId: 's6', supplier: '洁客直营', brand: '洁客', price: 14, moq: 10, discount: '满 20 包 9 折' },
  { itemId: 's6', supplier: '康迪优选', brand: '康迪', price: 11.9, moq: 20, discount: '新客 85 折' },
  // 器械包 / 树脂也各配了报价 —— 自证时发现这两项「触发补货但候选 0 家」，
  // 页面上会出现「无法比价」的空洞，比不给还糟。
  { itemId: 's3', supplier: '康迪直供', brand: '康迪', price: 26, moq: 5, discount: '满 30 包 9 折' },
  { itemId: 's3', supplier: '稳健医疗', brand: '稳健', price: 24.7, moq: 10, discount: '新客 95 折' },
  { itemId: 's5', supplier: '3M 授权经销', brand: '3M', price: 145, moq: 3, discount: '无优惠' },
  { itemId: 's5', supplier: '登士柏旗舰', brand: '登士柏', price: 128, moq: 6, discount: '限时 88 折' },
];

/** 补货策略：低于阈值触发；非必须耗材自动挑「折后单价」最低的。 */
export const RESTOCK_POLICY = {
  // 必需耗材：只看够不够，不管价格
  mustOnlyCheckQty: true,
  // 非必须耗材：折后单价最低优先
  nonMustPickCheapest: true,
  // 非必须耗材低于阈值时，给出「建议一次补到几天用量」
  nonMustTargetDays: 30,
};

/**
 * 算出补货建议（纯函数，可测）。
 * @returns {Array} 需补货条目：{ item, need, reason, quotes, best }
 */
export function computeRestock(stock = SEED_STOCK, quotes = SEED_SUPPLIER_QUOTES) {
  const out = [];
  for (const it of stock) {
    if (it.qty > it.threshold) continue;
    const cat = STOCK_CATEGORIES.find((c) => c.key === it.cat);
    const isMust = !!cat?.must;
    const qs = quotes
      .filter((q) => q.itemId === it.id)
      .map((q) => ({ ...q, final: Number((q.price * 1).toFixed(2)) }))
      .sort((a, b) => a.final - b.final);

    // 必需：按缺口补足到 1.5 倍阈值；非必须：补到 targetDays 用量（这里用阈值近似换算）
    const target = isMust ? Math.ceil(it.threshold * 1.5) : Math.max(it.threshold * 2, it.qty + it.threshold);
    const need = Math.max(target - it.qty, 1);

    out.push({
      item: it,
      isMust,
      need,
      reason: isMust
        ? `必需耗材，现有 ${it.qty}${it.unit} 低于阈值 ${it.threshold}${it.unit}`
        : `非必须耗材，现有 ${it.qty}${it.unit} 低于阈值 ${it.threshold}${it.unit}，可顺带比价`,
      quotes: qs,
      best: qs[0] || null,
    });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════
   2) 周边竞品（需求 3）
   ══════════════════════════════════════════════════════════ */

export const SEED_NEARBY = {
  center: { name: '康健苗苗·上海浦东金桥社区', address: '浦东新区金桥路 588 弄', radiusKm: 3 },
  // 按「用户获取难度」排的竞品（不是按距离——近的不一定抢你客）
  competitors: [
    {
      id: 'c1', name: '泰康口腔·金桥店', distKm: 0.6, rating: 4.6, reviews: 1284,
      perCapita: 780, strength: '品牌连锁 · 医保定点',
      weak: '无夜间门诊', adSpend: '高（美团+大众点评双开）',
      note: '距离最近，靠品牌与医保拉客，价格偏高。',
    },
    {
      id: 'c2', name: '佳美口腔门诊部', distKm: 1.2, rating: 4.4, reviews: 876,
      perCapita: 620, strength: '价格低·洗牙 99',
      weak: '口碑一般，差评集中在"等待久"', adSpend: '中（点评投放为主）',
      note: '主打低价洗牙引流，到店转化强。',
    },
    {
      id: 'c3', name: '维乐口腔', distKm: 1.8, rating: 4.8, reviews: 632,
      perCapita: 1150, strength: '医生技术口碑好·种植',
      weak: '不做活动，不进点评', adSpend: '低（靠自然流量）',
      note: '技术派，客单价最高，但主动获客几乎为零 —— 这是可抢的缺口。',
    },
    {
      id: 'c4', name: '牙博士口腔', distKm: 2.1, rating: 4.2, reviews: 421,
      perCapita: 560, strength: '社区团购，9.9 洗牙',
      weak: '技师流动大', adSpend: '高（社区团购刷单）',
      note: '用 9.9 洗牙做钩子，靠后端加项赚钱。',
    },
    {
      id: 'c5', name: '美奥口腔', distKm: 2.4, rating: 4.5, reviews: 358,
      perCapita: 890, strength: '种植套餐促销',
      weak: '距离偏远', adSpend: '中',
      note: '客群偏中老年，家庭决策为主。',
    },
    {
      id: 'c6', name: '康贝口腔', distKm: 2.7, rating: 4.1, reviews: 204,
      perCapita: 480, strength: '离地铁口近',
      weak: '环境一般', adSpend: '中',
      note: '位置好但产品老，靠位置吃自然客流。',
    },
    {
      id: 'c7', name: '微笑口腔·社区店', distKm: 2.9, rating: 4.3, reviews: 156,
      perCapita: 520, strength: '社区熟客多',
      weak: '数字化程度低', adSpend: '低',
      note: '最像你现在的处境 —— 可作为直接对标样本。',
    },
  ],
};

/** 运营建议（按「可抢的缺口」排序，不是按竞品强弱）。 */
export const SEED_OPS_ACTIONS = [
  {
    id: 'a1', title: '抢「维乐口腔」的技术口碑缺口', priority: 'high',
    basis: '维乐评分 4.8 但几乎不做获客（不做活动、不进点评）',
    actions: [
      '把「种植/正畸」做成案例墙（术前术后对比 + 主诊医生资历）',
      '在小红书铺「医生科普」内容，抢「维乐不投的搜索词」',
      '上线美团点评门店页，先拿评分与评价数',
    ],
    expect: '3 个月内容量产 40 条，点评评分进区域前 3',
  },
  {
    id: 'a2', title: '避开「牙博士 9.9 洗牙」的价格战', priority: 'high',
    basis: '牙博士用 9.9 洗牙做钩子，牙线/手套等低毛利品不要跟着降',
    actions: [
      '洗牙定价对齐市场（不做最低，做"含拍片+免费涂氟"的组合）',
      '把牙线、手套、一次性用品做成"到店即送"，替代价格让利',
      '老客转介绍给 2 倍赠品（成本远低于降价）',
    ],
    expect: '客单价不降，到店转化率提升',
  },
  {
    id: 'a3', title: '在「高德/百度地图」把位置流量做实', priority: 'mid',
    basis: '6 家竞品里只有 2 家在做点评；地图端几乎没人做',
    actions: [
      '补全高德门店信息（营业时间、停车、医保），标记「可预约」',
      '导航落地页写清「距 XX 地铁站 X 米」—— 位置是社区诊所最大优势',
      '在小区门口/电梯投放二维码，直接导流到本店预约',
    ],
    expect: '地图搜索「附近牙科」进入前 3',
  },
  {
    id: 'a4', title: '抓「泰康夜间空白」', priority: 'low',
    basis: '泰康 4.6 分但无夜间门诊，而周边写字楼加班人群多',
    actions: [
      '评估延长到 20:30 的成本与收益（护士/医生排班）',
      '若可行，先做每周二/四夜诊试运行',
      '夜诊做成差异化卖点（加班人群刚需）',
    ],
    expect: '填补时段空白，不与泰康正面比价',
  },
];

/* ══════════════════════════════════════════════════════════
   3) 活动预告 / 薅羊毛（需求 2）
   ══════════════════════════════════════════════════════════ */

export const SEED_CAMPAIGNS = [
  {
    id: 'k1', title: '上游货源 · 九月口腔健康月', org: '上游货源口腔',
    period: '2026-09-01 ~ 2026-09-30',
    prizes: [
      { name: '洁牙券', value: '价值 380 元 × 10 张', need: '关注 + 转发朋友圈' },
      { name: '种植体补贴', value: '最高立减 1500 元', need: '预约到院评估' },
      { name: '老客回馈', value: '满 3000 送儿童涂氟 3 次', need: '老客带新客' },
    ],
    how: ['小程序 →「健康月」活动页报名', '或到院扫码，护士协助领取', '名额有限，先到先得'],
    deadline: '2026-09-25',
    status: 'ongoing',
  },
  {
    id: 'k2', title: '康健苗苗 · 老客带新客返现', org: '康健苗苗',
    period: '长期有效',
    prizes: [
      { name: '带新客返现', value: '新客消费满 500，双方各得 100 元券', need: '老客在朋友圈/社群转发推荐' },
    ],
    how: ['在「企业大脑 → 转介绍」生成专属海报', '新客扫码登记并到院', '券在下次消费时自动抵扣'],
    deadline: '长期',
    status: 'ongoing',
  },
  {
    id: 'k3', title: '上海市口腔医学会 · 儿童窝沟封闭公益', org: '学会公益',
    period: '2026-10-15 ~ 2026-11-15',
    prizes: [
      { name: '窝沟封闭', value: '免费（指定机构，需提前报名）', need: '6-12 岁适龄儿童' },
    ],
    how: ['线上报名登记适龄儿童', '收到短信后到指定机构', '需家长全程陪同'],
    deadline: '2026-11-08',
    status: 'upcoming',
  },
  {
    id: 'k4', title: '暑期学生��正补贴（已结束）', org: '康健苗苗',
    period: '2026-07-01 ~ 2026-08-31',
    prizes: [{ name: '学生正畸', value: '暑期 8 折', need: '凭学生证' }],
    how: ['到院登记'],
    deadline: '2026-08-31',
    status: 'ended',
  },
];

/* ══════════════════════════════════════════════════════════
   4) 电子病历（需求 6）
   ══════════════════════════════════════════════════════════ */

/** 牙位（FDI 记法）：象限 1-4 × 恒牙1-8/乳牙1-5。 */
export const SEED_PATIENTS = [
  {
    id: 'pt1', name: '张*明', gender: '男', age: 42, phone: '138****6621',
    lastVisit: '2026-09-18', tags: ['种植修复', 'VIP'],
    records: [
      {
        id: 'r1', date: '2026-09-18', tooth: '26', toothName: '左上第一磨牙',
        type: '根管治疗', toothCode: 'P', doctor: '李医生',
        note: '自发痛 3 天，冷热刺激痛加重。X 线示根尖暗影。',
        ai: '根尖周炎可能性大（置信度 中高）。建议根管预备后行根管充填，'
          + '若疼痛未缓解需考虑根管超填/遗漏根管，建议 CBCT 复核。',
        attachments: ['xray-26.png'],
      },
      {
        id: 'r2', date: '2026-06-02', tooth: '16', toothName: '右上第一磨牙',
        type: '树脂充填', toothCode: 'F', doctor: '李医生',
        note: '近中龋，备洞后充填。',
        ai: '近中邻面龋，未及髓，处理方式恰当。建议 6 个月复查。',
        attachments: [],
      },
    ],
  },
  {
    id: 'pt2', name: '李*华', gender: '女', age: 29, phone: '139****3388',
    lastVisit: '2026-08-30', tags: ['正畸'],
    records: [
      {
        id: 'r3', date: '2026-08-30', tooth: '11-22', toothName: '上下前牙列',
        type: '正畸复诊', toothCode: 'O', doctor: '王医生',
        note: '排牙第 6 个月，牙列排齐中线略偏。',
        ai: '进度符合预期。建议本次调整弓丝，加内收力矩改善中线。',
        attachments: ['oral-photo.png'],
      },
    ],
  },
  {
    id: 'pt3', name: '王*强', gender: '男', age: 8, phone: '137****9900',
    lastVisit: '2026-09-05', tags: ['儿童', '首次'],
    records: [
      {
        id: 'r4', date: '2026-09-05', tooth: '64', toothName: '左下第一乳磨牙',
        type: '窝沟封闭', toothCode: 'S', doctor: '李医生',
        note: '深窝沟，已封闭。',
        ai: '封闭剂保留良好。建议 6 个月复查封闭剂完整性。',
        attachments: [],
      },
    ],
  },
];

/* ══════════════════════════════════════════════════════════
   5) 经销商：批量采购 + 优惠商品
   ══════════════════════════════════════════════════════════ */

/** 阶梯价：qty 为「起订量档位」，该档及以上按 unitPrice 结算。 */
export const SEED_BULK_PRODUCTS = [
  {
    id: 'p1', name: '一次性医用口罩 50 只/盒', spec: '50 只/盒', cat: '防护',
    tiers: [
      { qty: 5, unitPrice: 18 },
      { qty: 20, unitPrice: 16.2 },
      { qty: 50, unitPrice: 14.4 },
    ],
    stock: 12800, moq: 5, hot: true,
  },
  {
    id: 'p2', name: '丁腈检查手套 100 只/盒', spec: '100 只/盒', cat: '防护',
    tiers: [
      { qty: 5, unitPrice: 32 },
      { qty: 20, unitPrice: 28.8 },
      { qty: 50, unitPrice: 25.6 },
    ],
    stock: 8600, moq: 5, hot: true,
  },
  {
    id: 'p3', name: '光固化复合树脂 A2 4g', spec: '4g/支', cat: '材料',
    tiers: [
      { qty: 3, unitPrice: 145 },
      { qty: 10, unitPrice: 130.5 },
      { qty: 30, unitPrice: 116 },
    ],
    stock: 2400, moq: 3, hot: true,
  },
  {
    id: 'p4', name: '无蜡牙线 50m/卷', spec: '50m/卷', cat: '耗材',
    tiers: [
      { qty: 10, unitPrice: 9.5 },
      { qty: 50, unitPrice: 8.1 },
      { qty: 100, unitPrice: 6.7 },
    ],
    stock: 21000, moq: 10,
  },
  {
    id: 'p5', name: '牙科小号吸唾管包', spec: '100 支/包', cat: '耗材',
    tiers: [
      { qty: 10, unitPrice: 14 },
      { qty: 50, unitPrice: 11.9 },
      { qty: 200, unitPrice: 10.5 },
    ],
    stock: 5600, moq: 10,
  },
  {
    id: 'p6', name: '一次性口腔器械包', spec: '独立包装', cat: '器械',
    tiers: [
      { qty: 5, unitPrice: 26 },
      { qty: 30, unitPrice: 23.4 },
      { qty: 100, unitPrice: 20.8 },
    ],
    stock: 9400, moq: 5, hot: true,
  },
];

/** 限时优惠专区。 */
export const SEED_PROMOS = [
  {
    id: 'pr1', title: '开学季 · 防护用品囤货节', productId: 'p1',
    from: 18, to: 13.5, tag: '限时 7 折', endAt: '2026-09-30',
    note: '一次囤 20 盒以上再叠 200 减',
  },
  {
    id: 'pr2', title: '材料节 · 树脂买 10 送 1', productId: 'p3',
    from: 145, to: 130.5, tag: '买 10 送 1', endAt: '2026-10-15',
    note: '赠品同批次随机发货',
  },
  {
    id: 'pr3', title: '耗材清仓 · 牙线 100 盒', productId: 'p4',
    from: 9.5, to: 6.7, tag: '直降 30%', endAt: '2026-09-20',
    note: '库存有限，售完即止',
  },
];

export const SEED_META = {
  dataSource: 'seed',
  note: '当前为示例数据（seed）。接入真实接口后，页面结构与流程不变。',
  updatedAt: '2026-10-14',
};