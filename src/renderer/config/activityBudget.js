/**
 * 活动预算主体化模型 —— 常量层（AI 活动总监 · T04）
 *
 * 设计依据：docs/ACTIVITY-DIRECTOR-DESIGN.md §9（预算主体化表）、§16（命名与数据约定）
 *
 * 红线兑现：
 *  1. 【只做策划建议 · §9.4】每一套模型与每一次 buildBudget() 输出都携带 disclaimer：
 *     「以下为策划建议比例，不是实际市场报价，实际费用请以供应商报价为准。」
 *  2. 【每条比例回答为什么】items[].why 为必填，UI 必须展示，不允许出现无依据的比例。
 *  3. 【规模调整有依据 · §9.3】scaleAdjust 的每一次增减都回写 scaleRule.note 说明原因。
 *
 * 本文件为纯常量 + 纯函数：不 import React、不读写 localStorage、不发网络请求。
 */

/* ============================================================================
 * 1. 基础常量与构造helper
 * ==========================================================================*/

/** §9.4 强制声明：所有预算区块必须渲染 */
export const BUDGET_DISCLAIMER = '以下为策划建议比例，不是实际市场报价，实际费用请以供应商报价为准。';

/**
 * 预算科目类别。scaleAdjust 只对 promo / venue / guest 三类做规模调整，
 * 其余类别（content / material / travel / media / gift / other / reserve）不参与调整。
 * @type {Record<string, string>}
 */
export const BUDGET_CATEGORIES = {
  promo: '传播获量',
  venue: '场地搭建',
  guest: '嘉宾讲者',
  travel: '邀约接待差旅',
  content: '内容与课程',
  material: '物料',
  media: '摄影摄像剪辑',
  gift: '礼品与激励',
  other: '体验与其他',
  reserve: '备用',
};

/**
 * 构造预算科目。
 * @param {string} key snake_case
 * @param {string} label 中文名
 * @param {number} ratio 占比（合计需为 100）
 * @param {string} category 类别（见 BUDGET_CATEGORIES）
 * @param {string} why 为什么给这个比例（必填，UI 需展示）
 * @returns {Object} 科目
 */
const item = (key, label, ratio, category, why) => ({ key, label, ratio, category, why });

/**
 * 构造预算模型。
 * @param {string} subject 主体 key
 * @param {string|null} goalKey 目标 key（default 为 null）
 * @param {string} overallWhy 这一套分配背后的判断逻辑
 * @param {Array<Object>} items 科目（ratio 合计 100）
 * @returns {Object} BudgetModel
 */
const model = (subject, goalKey, overallWhy, items) => ({
  subject,
  goalKey: goalKey || null,
  items,
  overallWhy,
  disclaimer: BUDGET_DISCLAIMER,
});

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/* ============================================================================
 * 2. 四主体预算模型（§9.2）
 * ==========================================================================*/

/**
 * BUDGET_MODELS[subject] = { default, overrides: { [goalKey]: BudgetModel } }
 * 取用请走 getBudgetModel(subject, goalKey)，未命中 override 自动回退 default。
 * @type {Record<string, {default: Object, overrides: Object}>}
 */
export const BUDGET_MODELS = {
  manufacturer: {
    default: model(
      'manufacturer',
      null,
      '厂家活动的钱主要花在「让对的医生愿意来」和「来了之后相信你」两件事上：讲者与场地决定专业感知，邀约决定到场率，内容与体验区决定到场能否转成商机。',
      [
        item('guest', '嘉宾与讲者', 25, 'guest', '厂家活动的可信度来自讲者，讲者决定医生愿不愿意来'),
        item('venue', '场地与搭建', 20, 'venue', '学术场景的场地质感直接影响专业感知'),
        item('invite_travel', '医生邀请与差旅', 15, 'travel', 'B 端活动到场率的决定性变量，很多活动死在邀约'),
        item('content', '学术内容制作', 15, 'content', '课件/病例/视频是把到场转成有效客户的载体'),
        item('experience', '产品体验区', 10, 'other', '学术→商机的关键触点，缺了只剩品牌曝光'),
        item('promo', '传播', 10, 'promo', '厂家传播对象窄，投放大众渠道性价比低'),
        item('reserve', '备用', 5, 'reserve', '嘉宾变更/设备临时增补'),
      ],
    ),
    overrides: {
      channel_recruitment: model(
        'manufacturer',
        'channel_recruitment',
        '招商会的成败在「政策是否有说服力」+「重点经销商是否被认真接待」，因此资料与接待合计 35%。',
        [
          item('venue', '场地搭建', 20, 'venue', '招商需要能谈事的封闭空间，场地不追求排场'),
          item('policy_material', '招商政策与资料', 15, 'content', '政策算得清账才有人签，资料是转化主材'),
          item('dealer_invite', '经销商邀约接待', 20, 'travel', '重点经销商需要一对一接待，接待质量决定签约'),
          item('demo', '产品体验与样机', 15, 'other', '经销商要亲手看过才敢压货'),
          item('promo', '传播', 10, 'promo', '招商传播对象极窄，行业渠道定向即可'),
          item('guest', '嘉宾', 10, 'guest', '行业嘉宾用于背书，非招商会核心'),
          item('reserve', '备用', 10, 'reserve', '政策临时调整/重点客户追加接待'),
        ],
      ),
      exhibition: model(
        'manufacturer',
        'exhibition',
        '展会是注意力竞争，展位位置与搭建决定了自然流量上限。',
        [
          item('booth', '展位与搭建', 35, 'venue', '展位位置与搭建水平直接决定自然客流上限'),
          item('exhibit', '展品与体验', 20, 'other', '能上手体验的展品是留人的核心'),
          item('material', '物料与礼品', 15, 'material', '展会人流大，物料是低成本的批量触达'),
          item('travel', '人员差旅', 15, 'travel', '展台人力不足会直接损失接待量'),
          item('promo', '传播', 10, 'promo', '展会自带人流，额外投放边际收益低'),
          item('reserve', '备用', 5, 'reserve', '临时增补物料/物流'),
        ],
      ),
    },
  },

  clinic: {
    default: model(
      'clinic',
      null,
      '门诊活动的瓶颈永远是「人从哪来」，所以获客传播占比最高；现场体验决定到场能否转成留资与信任，是第二投入重点。',
      [
        item('promo', '获客传播', 35, 'promo', '门诊活动的瓶颈是「人从哪来」，传播占比必须最高'),
        item('onsite', '现场体验', 25, 'other', '体验决定留资与信任，是到场转留资的关键'),
        item('material', '内容物料', 20, 'material', '物料支撑现场与二次传播，可复用降低单次成本'),
        item('gift', '礼品', 10, 'gift', '到场诱因，但边际效应递减，不宜高配'),
        item('reserve', '备用', 10, 'reserve', '临时加投传播 / 加场'),
      ],
    ),
    overrides: {
      project_marketing: model(
        'clinic',
        'project_marketing',
        '项目转化的关键在「专业诊断 + 可决策的价格」，所以专家/设备与优惠补贴合计 45%。',
        [
          item('expert', '专家与检查设备', 25, 'guest', '高客单项目必须有专业诊断背书，否则无法建立信任'),
          item('onsite_check', '现场检查与方案', 25, 'other', '现场出方案是把意向推进到决策的关键动作'),
          item('promo', '获客传播', 20, 'promo', '项目类人群更窄，传播精准度优先于量'),
          item('subsidy', '项目优惠补贴', 20, 'other', '可决策的价格能显著缩短决策周期'),
          item('material_gift', '物料礼品', 10, 'material', '支撑现场体验与到店诱因'),
        ],
      ),
      referral: model(
        'clinic',
        'referral',
        '转介绍靠激励驱动，奖励与老客权益合计 50%。',
        [
          item('member_benefit', '老客权益与礼品', 30, 'gift', '老客先得到实惠，才有动力开口'),
          item('referral_reward', '转介绍奖励', 20, 'gift', '明确的奖励是转介绍的直接驱动力'),
          item('onsite', '活动体验', 20, 'other', '给老客一个带朋友来的场景'),
          item('promo', '传播', 15, 'promo', '活动声量用于提醒老客，不需要大规模获客'),
          item('material', '物料', 10, 'material', '转介绍卡/权益说明等交付物'),
          item('reserve', '备用', 5, 'reserve', '奖励临时加码'),
        ],
      ),
      brand: model(
        'clinic',
        'brand',
        '品牌类活动不追求当场成交，投入集中在「被看见」与「被信任」，传播与社区场景合计 60%。',
        [
          item('promo_content', '传播与内容', 35, 'promo', '品牌活动的产出是内容资产与社区认知'),
          item('community', '社区场地与义诊', 25, 'venue', '义诊/社区场景是门诊品牌最可信的落地形式'),
          item('material', '物料', 15, 'material', '现场视觉统一，强化品牌记忆'),
          item('gift', '礼品', 10, 'gift', '低门槛互动诱因'),
          item('staff', '人员', 10, 'other', '义诊需要足够的医生与助理人力'),
          item('reserve', '备用', 5, 'reserve', '临时加场/天气等突发'),
        ],
      ),
    },
  },

  doctor: {
    default: model(
      'doctor',
      null,
      '医生的核心资产是专业内容，内容制作必须最大头；个人账号自然流量有限，宣传与投流要单独留量；摄影摄像一次拍摄多次复用。',
      [
        item('content', '内容制作', 30, 'content', '医生的核心资产是专业内容，决定是否被信任'),
        item('promo', '宣传与投流', 20, 'promo', '个人账号自然流量有限，必须留出获量预算'),
        item('venue', '场地（或直播间搭建）', 20, 'venue', '线下小型沙龙或稳定直播环境'),
        item('media', '摄影摄像', 15, 'media', '个人 IP 需要持续素材，一次拍摄多次复用'),
        item('gift', '礼品互动', 10, 'gift', '提升互动率'),
        item('reserve', '备用', 5, 'reserve', '设备临时增补/投流追加'),
      ],
    ),
    overrides: {
      live_stream: model(
        'doctor',
        'live_stream',
        '直播的瓶颈是「开播时有没有人」，预约与投流优先；二次剪辑是把一场直播变成长期资产的关键。',
        [
          item('promo', '宣传与预约', 25, 'promo', '直播成败在开播瞬间有人，预约量决定初始权重'),
          item('equipment', '直播设备与场地', 25, 'venue', '画面与声音质量直接决定停留时长'),
          item('script', '内容策划与脚本', 20, 'content', '直播没有脚本必然跑题，脚本决定完播'),
          item('gift', '互动奖品', 15, 'gift', '奖品是拉互动率最直接的手段'),
          item('clip', '剪辑二次传播', 10, 'media', '切片是一场直播变长期资产的关键'),
          item('reserve', '备用', 5, 'reserve', '投流临时追加'),
        ],
      ),
      offline_salon: model(
        'doctor',
        'offline_salon',
        '线下沙龙的成本大头在场租与茶歇，但真正决定到场的是邀约与宣传，两者不可偏废。',
        [
          item('venue', '场地与茶歇', 25, 'venue', '小型沙龙的体验感主要来自场地与茶歇'),
          item('invite', '邀约与宣传', 20, 'promo', '线下到场成本高，邀约不精准等于空场'),
          item('media', '摄影', 15, 'media', '现场照片是后续内容与信任素材'),
          item('material', '内容物料', 15, 'material', '课件/手册支撑现场专业感'),
          item('gift', '礼品', 15, 'gift', '到场与互动诱因'),
          item('reserve', '备用', 10, 'reserve', '人数超预期/场地临时升级'),
        ],
      ),
    },
  },

  platform: {
    default: model(
      'platform',
      null,
      'B 端活动到场靠定向邀约而非广撒网，所以邀约接待占比最高；商家只信「别人怎么赚到钱」，案例内容与嘉宾是说服主材。',
      [
        item('invite', '商家邀约与接待', 25, 'travel', 'B 端活动到场靠定向邀约，不是靠广撒网'),
        item('venue', '场地与搭建', 20, 'venue', '商家对平台的实力判断部分来自现场'),
        item('case_content', '内容（案例/课件）', 20, 'content', '商家关心「别人怎么赚到钱」，案例是最强说服材料'),
        item('guest', '嘉宾', 15, 'guest', '行业嘉宾提升可信度'),
        item('promo', '平台宣传', 15, 'promo', '扩大平台侧声量'),
        item('reserve', '备用', 5, 'reserve', '临时增补接待/物料'),
      ],
    ),
    overrides: {
      merchant_training: model(
        'platform',
        'merchant_training',
        '培训的核心是课程本身，课程与讲师合计 30%；但商家不来等于零，邀约仍需 20%。',
        [
          item('course', '课程与讲师', 30, 'guest', '培训效果取决于课程是否可操作、讲师是否懂业务'),
          item('invite', '商家邀约', 20, 'travel', '培训到场率低是常态，定向邀约不能省'),
          item('venue', '场地', 20, 'venue', '实操培训需要可分组的场地'),
          item('material', '教材物料', 15, 'material', '训后能带走的教材决定执行落地率'),
          item('promo', '平台宣传', 10, 'promo', '培训以存量商家为主，无需大规模投放'),
          item('reserve', '备用', 5, 'reserve', '加开班次/临时增补教材'),
        ],
      ),
      industry_forum: model(
        'platform',
        'industry_forum',
        '行业论坛靠「规格」建立影响力：嘉宾与舞美合计 50%，传播用于放大行业声量。',
        [
          item('guest', '嘉宾', 25, 'guest', '论坛的规格由嘉宾分量决定'),
          item('stage', '场地舞美', 25, 'venue', '论坛是行业注意力的舞台，呈现质量即平台实力'),
          item('promo', '传播', 20, 'promo', '论坛的价值一半在会后传播，需预留'),
          item('invite', '邀约', 15, 'travel', '定向邀约保证到场商家质量'),
          item('material', '物料', 10, 'material', '会刊/手册等现场交付物'),
          item('reserve', '备用', 5, 'reserve', '嘉宾行程变更/临时增补'),
        ],
      ),
    },
  },
};

/* ============================================================================
 * 3. 规模调整（§9.3）
 * ==========================================================================*/

/**
 * 规模调整规则。
 * 说明：设计文档「> 10 万：场地/嘉宾 +5，传播 −5」若按字面执行会导致合计 105%，
 * 因此实现为「场地与嘉宾**合计** +5（按两者现有比例分摊），传播 −5」，保证合计恒为 100。
 * @type {Record<string, Object>}
 */
export const SCALE_RULES = {
  small: {
    key: 'small',
    label: '1 万以下',
    deltas: { promo: 5, venue: -5 },
    note: '小预算必须把钱花在「让人知道」上，场地从简',
  },
  standard: {
    key: 'standard',
    label: '1 万 ~ 10 万',
    deltas: {},
    note: '标准比例，不做规模调整',
  },
  large: {
    key: 'large',
    label: '10 万以上',
    deltas: { promo: -5, venue: 5, guest: 5 },
    note: '大规模活动靠现场质量与行业影响形成口碑，边际传播效率下降（场地与嘉宾合计 +5，按现有比例分摊）',
  },
};

/**
 * 按总预算命中规模规则。
 * @param {number|null} totalBudget 总预算（元）
 * @returns {Object} 规则（含 applied 标记；总预算无效时按 standard 处理）
 */
export function getScaleRule(totalBudget) {
  const total = Number(totalBudget);
  if (!isFinite(total) || total <= 0) return { ...SCALE_RULES.standard, applied: false };
  if (total < 10000) return { ...SCALE_RULES.small, applied: true };
  if (total <= 100000) return { ...SCALE_RULES.standard, applied: false };
  return { ...SCALE_RULES.large, applied: true };
}

/**
 * 按类别把增减量分摊到科目（组内按现有比例加权，保证合计不变）。
 * @param {Array<Object>} items 科目
 * @param {Object} deltas { [category]: number }
 * @returns {{items: Array<Object>, unapplied: string[]}}
 */
function applyDeltas(items, deltas) {
  const out = items.map((it) => ({ ...it, baseRatio: it.ratio, adjustDelta: 0 }));
  const unapplied = [];

  Object.keys(deltas).forEach((cat) => {
    const delta = deltas[cat];
    if (!delta) return;
    const group = out.filter((it) => it.category === cat);
    if (group.length === 0) {
      unapplied.push(cat);
      return;
    }
    const groupTotal = group.reduce((s, it) => s + it.baseRatio, 0);
    group.forEach((it) => {
      const share = groupTotal > 0 ? it.baseRatio / groupTotal : 1 / group.length;
      it.ratio = Math.max(0, round1(it.baseRatio + delta * share));
      it.adjustDelta = round1(it.ratio - it.baseRatio);
    });
  });

  // 归一到 100：浮点与取整误差补到占比最大的科目上
  const sum = out.reduce((s, it) => s + it.ratio, 0);
  const diff = round1(100 - sum);
  if (Math.abs(diff) >= 0.05 && out.length > 0) {
    let target = out[0];
    out.forEach((it) => {
      if (it.ratio > target.ratio) target = it;
    });
    target.ratio = round1(target.ratio + diff);
    target.adjustDelta = round1(target.ratio - target.baseRatio);
  }

  return { items: out, unapplied };
}

/**
 * 规模调整（纯函数）：按总预算调整科目占比，合计恒为 100。
 * @param {Array<Object>} items 科目（来自 BUDGET_MODELS）
 * @param {number|null} totalBudget 总预算（元）
 * @returns {Array<Object>} 新科目数组（每项带 baseRatio / adjustDelta，未调整时 adjustDelta 为 0）
 */
export function scaleAdjust(items, totalBudget) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const rule = getScaleRule(totalBudget);
  if (!rule.applied) {
    return items.map((it) => ({ ...it, baseRatio: it.ratio, adjustDelta: 0 }));
  }
  return applyDeltas(items, rule.deltas).items;
}

/* ============================================================================
 * 4. 组装
 * ==========================================================================*/

/**
 * 取预算模型：优先目标级 override，未命中回退主体 default。
 * @param {string} subject 主体 key
 * @param {string} [goalKey] 目标 key
 * @returns {Object|null} BudgetModel（副本）
 */
export function getBudgetModel(subject, goalKey) {
  const group = BUDGET_MODELS[subject];
  if (!group) return null;
  const hit = goalKey && group.overrides ? group.overrides[goalKey] : null;
  const picked = hit || group.default;
  if (!picked) return null;
  return {
    ...picked,
    items: picked.items.map((it) => ({ ...it })),
  };
}

/**
 * 组装预算方案（纯函数）。
 *
 * 支持两种调用：buildBudget({ subject, goalKey, total }) 或 buildBudget(subject, total, { goalKey })。
 *
 * @param {Object|string} subject 主体 key 或参数对象
 * @param {number|null} [totalBudget] 总预算（元）
 * @param {Object} [options] { goalKey }
 * @returns {Object} 预算方案（携带 disclaimer 与 assumption:true）；未知主体返回 null
 */
export function buildBudget(subject, totalBudget, options = {}) {
  let sub = subject;
  let goalKey = options.goalKey || null;
  let total = totalBudget;

  if (subject && typeof subject === 'object') {
    sub = subject.subject;
    goalKey = subject.goalKey || null;
    total = subject.total;
  }

  const picked = getBudgetModel(sub, goalKey);
  if (!picked) return null;

  const totalNum = Number(total);
  const hasTotal = isFinite(totalNum) && totalNum > 0;
  const rule = getScaleRule(hasTotal ? totalNum : null);
  const adjusted = scaleAdjust(picked.items, hasTotal ? totalNum : null);

  const items = adjusted.map((it) => ({
    key: it.key,
    label: it.label,
    ratio: it.ratio,
    baseRatio: it.baseRatio,
    adjustDelta: it.adjustDelta,
    category: it.category,
    categoryLabel: BUDGET_CATEGORIES[it.category] || '其他',
    why: it.why,
    amount: hasTotal ? Math.round((totalNum * it.ratio) / 100) : null,
    amountText: hasTotal ? `约 ${Math.round((totalNum * it.ratio) / 100)} 元` : '待填总预算',
  }));

  return {
    subject: sub,
    goalKey: goalKey || null,
    modelKey: picked.goalKey || 'default',
    total: hasTotal ? totalNum : null,
    overallWhy: picked.overallWhy,
    items,
    scaleRule: { key: rule.key, label: rule.label, note: rule.note, applied: rule.applied },
    disclaimer: BUDGET_DISCLAIMER,
    assumption: true,
    note: '以上为策划建议的比例分配，不是实际市场报价；实际费用请以供应商报价为准，并按复盘结果校准下一场。',
  };
}

export default {
  BUDGET_MODELS,
  BUDGET_DISCLAIMER,
  BUDGET_CATEGORIES,
  SCALE_RULES,
  getScaleRule,
  scaleAdjust,
  getBudgetModel,
  buildBudget,
};
