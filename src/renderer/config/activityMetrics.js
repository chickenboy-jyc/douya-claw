/**
 * 活动指标字典 / 商业漏斗 / 目标倒推 —— 常量层（AI 活动总监 · T04）
 *
 * 设计依据：docs/ACTIVITY-DIRECTOR-DESIGN.md §6（目标倒推）、§7（Funnel）、§8（KPI 主体化）、§16（命名与数据约定）
 *
 * 本文件兑现的四条红线：
 *  1. 【跨主体禁止 · §8.5】KPI_DICT 按 subject 分桶存储，getKpi/getKpis 只返回该主体字段，
 *     物理上无法渲染他主体指标（而非靠 UI 判断）。
 *  2. 【不编造效果 · §6.2】每个倒推系数带 source 分级（industry_experience / user_history / user_input），
 *     输出恒为 [min, max] 区间，不产生点估计承诺。
 *  3. 【策划假设标注】所有倒推结果与漏斗目标值携带 assumption:true + note，UI 据此渲染 .act-assumption 灰底小字。
 *  4. 【字段不漂移 · §7.1】Funnel 不另建字段表，是 KPI_DICT 中 funnel:true 的有序子集。
 *
 * 本文件为纯常量 + 纯函数：不 import React、不读写 localStorage、不发网络请求。
 */

/* ============================================================================
 * 1. KPI 字典（唯一事实源）
 * ==========================================================================*/

/**
 * 构造 KPI 条目。
 * @param {string} key snake_case 字段名
 * @param {string} label 中文名
 * @param {string} unit 单位
 * @param {boolean} funnel 是否漏斗节点
 * @param {number} funnelOrder 漏斗顺序（0 表示非漏斗节点）
 * @param {string} caliber 口径描述（同名字段跨主体区分用）
 * @param {string} desc 业务说明
 * @returns {Object} KPI 条目
 */
const kpi = (key, label, unit, funnel, funnelOrder, caliber, desc) => ({
  key,
  label,
  unit,
  funnel,
  funnelOrder,
  caliber,
  desc,
});

/**
 * KPI 唯一事实源。按主体分桶 —— 跨主体字段不可见（§8.5 的技术保障）。
 *
 * 注意 signup / attend / exposure 跨主体同名但口径不同，统一用 caliber 字段区分：
 *  - manufacturer.attend = 到场医生数（人，线上取在线峰值）
 *  - clinic.attend        = 到场患者数（人，按到场签到计）
 *  - platform.attend      = 到场商家数（家，按到场企业计）
 *  - manufacturer.exposure = 行业媒体传播曝光（可选辅助）
 *  - clinic.exposure       = 本地活动信息触达人次（漏斗第一环）
 *  - doctor.exposure       = 内容曝光（漏斗第一环）
 *  - platform.exposure     = 平台侧 C 端触达曝光（仅 user_growth 目标启用，非漏斗节点）
 *
 * @type {Record<string, Array<Object>>}
 */
export const KPI_DICT = {
  // §8.1 manufacturer：不得出现患者到店/留资/成交等 C 端获客指标
  manufacturer: [
    kpi('targetDoctors', '目标医生数', '人', false, 0, '策划输入项，非漏斗节点', '本次活动希望覆盖的目标医生总量'),
    kpi('invited', '邀请人数', '人', true, 1, '实际发出定向邀请的医生人数（不含泛传播触达）', '定向邀约覆盖量，决定报名上限'),
    kpi('signup', '报名医生数', '人', true, 2, '完成报名/回执的医生人数，同一医生只计一次', '已确认参会的医生数'),
    kpi('attend', '到场医生数', '人', true, 3, '实际到场的医生人数；线上会议取在线观看峰值人数', '到场是产生有效客户的前提'),
    kpi('effectiveCustomer', '有效客户数', '人', true, 4, '符合目标客户画像、可进入跟进管道的医生人数', '到场医生中真正值得跟进的部分'),
    kpi('productInquiry', '产品咨询数', '次', true, 5, '主动询问产品/报价/参数的次数（同一医生可多次计）', '兴趣信号，先于商机发生'),
    kpi('channelLead', '渠道线索数', '条', true, 6, '有经销/代理意向的线索条数', '渠道侧意向，仅招商类目标启用'),
    kpi('opportunity', '商机数', '个', true, 7, '进入销售跟进管道的商机个数', '活动最末端的商业结果'),
    kpi('exposure', '传播曝光', '次', false, 0, '行业媒体/社交传播曝光次数（曝光口径非人数）', '可选辅助指标，不进漏斗'),
  ],

  // §8.2 clinic：不得出现经销商招商/渠道线索
  clinic: [
    kpi('exposure', '触达曝光', '次', true, 1, '活动信息触达人次（曝光口径，非独立人数）', '本地获客的入口量'),
    kpi('signup', '报名人数', '人', true, 2, '完成报名的患者人数（按人计，非家庭单位）', '有明确意愿的人数'),
    kpi('attend', '到场人数', '人', true, 3, '实际到场的患者人数（按签到计）', '到场决定后续留资上限'),
    kpi('leads', '留资数', '条', true, 4, '留下可联系的有效信息条数', '可再次触达的资产'),
    kpi('consult', '有效咨询数', '次', true, 5, '完成有效项目咨询的次数', '进入方案沟通的次数'),
    kpi('visit', '到店数', '人', true, 6, '活动后到店的患者人数', '成交前的最后一环'),
    kpi('deal', '成交量', '单', true, 7, '实际成交订单数（按单计）', '活动商业结果'),
    kpi('referralCount', '转介绍数', '人', false, 0, '老客带来的新客人数', '仅 referral 目标启用，不进漏斗'),
  ],

  // §8.3 doctor：不得用企业招商模型
  doctor: [
    kpi('exposure', '曝光/触达', '次', true, 1, '内容曝光次数（自然 + 付费合计）', '内容被看到的量'),
    kpi('views', '观看人数', '人', true, 2, '直播/视频观看人数（峰值口径；若用累计需在复盘注明）', '真正进入内容的人数'),
    kpi('interactions', '互动数', '次', true, 3, '评论/提问/点赞/转发合计次数', '内容是否被认可的信号'),
    kpi('newFollowers', '新增粉丝', '人', true, 4, '活动期间净增关注人数（净增，非累计关注）', '沉淀下来的长期资产'),
    kpi('consults', '咨询数', '次', true, 5, '产生有效咨询的次数（不含无效闲聊）', '个人 IP 的商业结果'),
    kpi('spread', '专业传播', '次', false, 0, '同行转发/引用/讨论次数', '可选辅助指标，不进漏斗'),
  ],

  // §8.4 platform：不得用患者获客模型
  platform: [
    kpi('merchantInvite', '商家邀约数', '家', true, 1, '招商经理定向邀约的商家数（按企业计）', '定向邀约覆盖面'),
    kpi('merchantSignup', '商家报名数', '家', true, 2, '完成报名的商家数', '有意向的商家数'),
    kpi('attend', '到场商家数', '家', true, 3, '实际到场的商家数（按到场企业计，非人数）', '到场决定使用转化上限'),
    kpi('usage', '商家使用数', '家', true, 4, '完成开通/上线/试用的商家数', '从「知道」到「在用」'),
    kpi('active', '持续活跃商家数', '家', true, 5, '活动后 30 天仍活跃的商家数', '平台侧的真实留存'),
    kpi('convert', '后续转化', '家', false, 0, '签约/续费/付费的商家数', '可选辅助指标，不进漏斗'),
    kpi('exposure', 'C端触达曝光', '次', false, 0, '平台侧 C 端用户触达曝光（仅 user_growth 目标启用，且需二次确认平台确实面向 C 端）', '平台默认 B 端商家侧；C 端曝光仅特殊目标启用，不进商家漏斗'),
  ],
};

/**
 * 取某主体的 KPI 列表（副本，防外部改动常量）。未知主体返回 []。
 * @param {string} subject 主体 key
 * @returns {Array<Object>} KPI 列表
 */
export function getKpis(subject) {
  const list = KPI_DICT[subject];
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({ ...item }));
}

/**
 * 取某主体的单个 KPI。跨主体取值恒返回 null —— 这是「跨主体禁止」在数据层的实现。
 * @param {string} subject 主体 key
 * @param {string} key KPI key
 * @returns {Object|null} KPI 条目
 */
export function getKpi(subject, key) {
  const list = KPI_DICT[subject];
  if (!Array.isArray(list)) return null;
  const hit = list.find((item) => item.key === key);
  return hit ? { ...hit } : null;
}

/**
 * 取某主体的漏斗节点 key（按 funnelOrder 升序）。
 * @param {string} subject 主体 key
 * @returns {string[]} 漏斗 key 列表
 */
export function getFunnelKeys(subject) {
  return getKpis(subject)
    .filter((item) => item.funnel === true)
    .sort((a, b) => a.funnelOrder - b.funnelOrder)
    .map((item) => item.key);
}

/* ============================================================================
 * 2. 倒推系数（REVERSE_COEFFICIENTS）
 * ==========================================================================*/

/**
 * 生成系数链 key（用于 history / overrides 索引，按 subject 分桶避免跨主体撞名）。
 * @param {string} from 上游 key
 * @param {string} to 下游 key
 * @returns {string} linkKey
 */
export function coefficientLinkKey(from, to) {
  return `${from}_to_${to}`;
}

/**
 * 构造一条倒推系数。ratio 语义：to / from 的转化率，因此 to = from / ratio。
 * @param {string} from 上游（更接近商业结果）
 * @param {string} to 下游（更接近触达）
 * @param {number} min 系数下界
 * @param {number} max 系数上界
 * @param {string} basis 默认取值依据（文案来自设计文档 §6.2）
 * @returns {Object} 系数条目
 */
const coef = (from, to, min, max, basis) => ({
  key: coefficientLinkKey(from, to),
  from,
  to,
  min,
  max,
  basis,
  source: 'industry_experience',
});

/**
 * 四主体的倒推链（末端 → 前端），区间与依据均来自设计文档 §6.2。
 * anchor = 用户输入的锚点末端节点。
 * @type {Record<string, {anchor: string, links: Array<Object>}>}
 */
export const REVERSE_COEFFICIENTS = {
  manufacturer: {
    anchor: 'opportunity',
    links: [
      coef('opportunity', 'effectiveCustomer', 0.2, 0.4, '学术/产品活动后形成明确商机的比例'),
      coef('effectiveCustomer', 'attend', 0.4, 0.6, '到场医生中真正构成目标客户的比例'),
      coef('attend', 'signup', 0.5, 0.7, '医生活动的到场率（已邀约确认的高于泛报名）'),
      coef('signup', 'invited', 0.3, 0.5, '定向邀约的报名转化'),
    ],
  },
  clinic: {
    anchor: 'deal',
    links: [
      coef('deal', 'consult', 0.1, 0.25, '高价项目的方案成交率'),
      coef('consult', 'visit', 0.5, 0.8, '到店后进入方案沟通的比例'),
      coef('visit', 'leads', 0.4, 0.6, '活动留资后的到店率'),
      coef('leads', 'attend', 0.5, 0.7, '现场完成有效留资的比例'),
      coef('attend', 'signup', 0.4, 0.6, '免费活动的报名到场率（收押金可显著提高）'),
      coef('signup', 'exposure', 0.03, 0.08, '本地生活类内容的曝光→报名转化'),
    ],
  },
  doctor: {
    anchor: 'consults',
    links: [
      coef('consults', 'newFollowers', 0.01, 0.05, '粉丝产生有效咨询的比例'),
      coef('newFollowers', 'interactions', 0.05, 0.15, '互动用户中关注的比例'),
      coef('interactions', 'views', 0.03, 0.1, '观看者产生互动的比例'),
      coef('views', 'exposure', 0.05, 0.15, '曝光进入直播间的比例'),
    ],
  },
  platform: {
    anchor: 'convert',
    links: [
      coef('convert', 'active', 0.2, 0.4, '活跃商家中达成商业转化的比例'),
      coef('active', 'usage', 0.5, 0.7, '使用后的留存活跃'),
      coef('usage', 'attend', 0.3, 0.5, '到场后的实际开通/使用'),
      coef('attend', 'merchantSignup', 0.5, 0.7, 'B 端活动的到场率'),
      coef('merchantSignup', 'merchantInvite', 0.25, 0.45, '招商经理定向邀约的报名转化'),
    ],
  },
};

/**
 * 系数来源分级（§6.2）。rank 越小可信度越低；整体取链路上最低的一级（最保守）。
 * @type {Record<string, Object>}
 */
export const COEFFICIENT_SOURCES = {
  industry_experience: {
    key: 'industry_experience',
    label: '行业经验区间',
    rank: 0,
    note: '策划假设 · 依据：行业经验区间（非本企业历史数据，需以实际复盘校准）',
    requireSampleSize: false,
  },
  user_history: {
    key: 'user_history',
    label: '本企业历史活动',
    rank: 1,
    note: '依据：本企业已复盘活动的实际转化率（n={n}）',
    noteLowSample: '样本不足（n={n}），仅供参考',
    minSampleSize: 1,
    lowSampleThreshold: 3,
    requireSampleSize: true,
  },
  user_input: {
    key: 'user_input',
    label: '用户设定',
    rank: 2,
    note: '依据：用户设定（非系统推算）',
    requireSampleSize: false,
  },
};

/** 倒推/漏斗统一的策划假设声明（§6.3 UI 强制文案） */
export const REVERSE_ASSUMPTION_NOTE =
  '以下为策划用的目标模型，不是历史结果，也不是效果承诺。活动结束后请录入实际数据校准。';

/** 漏斗顶部强制文案（§7.3） */
export const FUNNEL_NOTE = '这是目标模型，不是实际结果。活动结束后录入实际数据。';

const roundInt = (n) => Math.ceil(Number(n) || 0);
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * 百分比文案（避免浮点误差，如 0.07 → '7%' 而非 '7.000000000000001%'）。
 * @param {number} v 小数
 * @returns {string} 百分比文案
 */
function pctText(v) {
  return `${round1(v * 100)}%`;
}

/**
 * 渲染某来源的 UI 灰底小字。
 * @param {string} source 来源分级
 * @param {number} sampleSize 样本量（user_history 用）
 * @returns {string} 说明文案
 */
export function getCoefficientNote(source, sampleSize) {
  const meta = COEFFICIENT_SOURCES[source] || COEFFICIENT_SOURCES.industry_experience;
  let text = meta.note.replace('{n}', String(sampleSize || 0));
  if (source === 'user_history') {
    const n = Number(sampleSize) || 0;
    if (n < (meta.lowSampleThreshold || 3)) {
      text += ` · ${meta.noteLowSample.replace('{n}', String(n))}`;
    }
  }
  return text;
}

/**
 * 解析某条链路最终使用的系数（优先级：user_input > user_history > industry_experience）。
 * @param {Object} link 系数条目
 * @param {Object} subjectHistory 该主体的历史系数 { [linkKey]: {min,max,sampleSize} }
 * @param {Object} overrides 用户覆盖 { [linkKey]: number|{min,max} }
 * @returns {{min:number, max:number, source:string, sampleSize:number, basis:string}}
 */
function resolveCoefficient(link, subjectHistory, overrides) {
  const ov = overrides[link.key];
  if (ov !== undefined && ov !== null) {
    const min = typeof ov === 'number' ? ov : Number(ov.min);
    const max = typeof ov === 'number' ? ov : Number(ov.max);
    if (min > 0 && max >= min) {
      return { min, max, source: 'user_input', sampleSize: 0, basis: link.basis };
    }
  }
  const hist = subjectHistory[link.key];
  if (hist && Number(hist.sampleSize) >= (COEFFICIENT_SOURCES.user_history.minSampleSize || 1)) {
    const min = Number(hist.min);
    const max = Number(hist.max);
    if (min > 0 && max >= min) {
      return {
        min,
        max,
        source: 'user_history',
        sampleSize: Number(hist.sampleSize) || 0,
        basis: link.basis,
      };
    }
  }
  return { min: link.min, max: link.max, source: 'industry_experience', sampleSize: 0, basis: link.basis };
}

/**
 * 目标倒推（纯函数）。
 *
 * 算法：从用户输入锚点出发，逐级向前倒推，to = ceil(from / ratio)。
 *  - value：取系数中位（mid = (min+max)/2）算出的中位值，供图表/排版使用；
 *  - range：在「上一级取 value」的前提下，本级系数分别取上下界得到的 [min, max]，
 *    即 `range = [ceil(prev/max), ceil(prev/min)]`。
 *    （刻意不做全链路极值传播，否则 6 级链路会把区间放大到失去策划意义；
 *      区间口径写在每条 chain 的 rangeBasis 里，不隐藏。）
 *
 * @param {string} subject 主体 key
 * @param {Object|number} input 锚点，{ key, value } 或纯数字（取该主体默认 anchor）
 * @param {Object} [options] { history, overrides, goalKey }
 * @param {Object} [options.history] { [subject]: { [linkKey]: {min,max,sampleSize} } }
 * @param {Object} [options.overrides] { [linkKey]: number|{min,max} } 用户手动覆盖
 * @param {string} [options.goalKey] 目标 key（仅回显）
 * @returns {Object|null} ReverseGoal（§6.1 结构，额外带 assumption/warnings）；未知主体返回 null
 */
export function reverseGoal(subject, input, options = {}) {
  const model = REVERSE_COEFFICIENTS[subject];
  if (!model) return null;

  const kpis = getKpis(subject);
  const labelOf = (key) => {
    const hit = kpis.find((k) => k.key === key);
    return hit ? hit.label : key;
  };

  const rawInput = typeof input === 'number' ? { key: model.anchor, value: input } : (input || {});
  const anchorKey = rawInput.key || model.anchor;
  const anchorValue = roundInt(rawInput.value);
  const warnings = [];

  if (anchorKey !== model.anchor) {
    warnings.push(`锚点「${labelOf(anchorKey)}」不是该主体的默认末端节点（${labelOf(model.anchor)}），将按其所在链路位置倒推。`);
  }
  if (!(anchorValue > 0)) {
    warnings.push('锚点目标值需大于 0，当前按 0 处理，倒推结果无意义。');
  }

  const history = (options.history && options.history[subject]) || {};
  const overrides = options.overrides || {};

  const chain = [
    {
      key: anchorKey,
      label: labelOf(anchorKey),
      value: anchorValue,
      range: [anchorValue, anchorValue],
      ratio: null,
      ratioRange: null,
      basis: '用户设定的目标锚点',
      source: 'user_input',
      editable: true,
      assumption: true,
      note: getCoefficientNote('user_input', 0),
      rangeBasis: '锚点为用户直接设定，无区间',
    },
  ];

  // 已产出节点的值（用于下一级倒推的 from）
  const produced = { [anchorKey]: anchorValue };
  let usedLinks = 0;
  let worstSource = null;
  let worstSampleSize = Infinity;

  model.links.forEach((link) => {
    const fromValue = produced[link.from];
    if (!(fromValue > 0)) return; // 锚点不在该链路上时，跳过多余环节

    const rc = resolveCoefficient(link, history, overrides);
    const min = Math.max(rc.min, 0.0001);
    const max = Math.max(rc.max, min);
    const mid = (min + max) / 2;

    const value = roundInt(fromValue / mid);
    const range = [roundInt(fromValue / max), roundInt(fromValue / min)];

    chain.push({
      key: link.to,
      label: labelOf(link.to),
      value,
      range,
      ratio: `${pctText(min)}~${pctText(max)}`,
      ratioRange: [min, max],
      basis: rc.basis,
      source: rc.source,
      sampleSize: rc.source === 'user_history' ? rc.sampleSize : undefined,
      editable: true,
      assumption: true,
      note: getCoefficientNote(rc.source, rc.sampleSize),
      rangeBasis: `在上游「${labelOf(link.from)}」取中位 ${fromValue} 的前提下，本级转化率取 ${pctText(min)}~${pctText(max)} 所得区间`,
    });

    produced[link.to] = value;
    usedLinks += 1;

    const rank = (COEFFICIENT_SOURCES[rc.source] || COEFFICIENT_SOURCES.industry_experience).rank;
    if (worstSource === null || rank < worstSource.rank) worstSource = COEFFICIENT_SOURCES[rc.source];
    if (rc.source === 'user_history') worstSampleSize = Math.min(worstSampleSize, rc.sampleSize);
  });

  if (usedLinks === 0) {
    warnings.push(`锚点「${labelOf(anchorKey)}」不在该主体的倒推链路上，未产生任何倒推结果。`);
  }

  const source = worstSource ? worstSource.key : 'user_input';
  const sampleSize = worstSampleSize === Infinity ? 0 : worstSampleSize;

  return {
    subject,
    goalKey: options.goalKey || null,
    input: { key: anchorKey, label: labelOf(anchorKey), value: anchorValue },
    chain,
    source,
    sampleSize,
    assumptionNote: REVERSE_ASSUMPTION_NOTE,
    sourceNote: getCoefficientNote(source, sampleSize),
    warnings,
    assumption: true,
  };
}

/* ============================================================================
 * 3. 漏斗（KPI_DICT 的有序子集）
 * ==========================================================================*/

/**
 * 由倒推结果生成漏斗（§7.2）。
 *
 * 关键：stages 完全来自 KPI_DICT[subject] 中 funnel:true 的有序子集，
 * 不新增任何字段名；倒推链里不在漏斗中的节点（如 platform.convert）放入 extraTargets，避免丢数据。
 *
 * @param {string} subject 主体 key
 * @param {Object|null} reverse reverseGoal() 的输出（可为 null，则 target 全为 null）
 * @returns {Object} ActivityFunnel
 */
export function buildFunnel(subject, reverse) {
  const kpis = getKpis(subject);
  const funnelKpis = kpis
    .filter((item) => item.funnel === true)
    .sort((a, b) => a.funnelOrder - b.funnelOrder);

  const chainMap = {};
  if (reverse && Array.isArray(reverse.chain)) {
    reverse.chain.forEach((node) => {
      chainMap[node.key] = node;
    });
  }

  const stages = funnelKpis.map((item) => {
    const hit = chainMap[item.key];
    return {
      key: item.key,
      label: item.label,
      unit: item.unit,
      caliber: item.caliber,
      order: item.funnelOrder,
      target: hit ? hit.value : null,
      targetRange: hit ? hit.range : null,
      actual: null,
      assumption: true,
      targetSource: hit ? hit.source : null,
      targetNote: hit ? hit.note : null,
    };
  });

  // 倒推链中未进漏斗的节点（如 platform 的 convert）：保留但不列为 stage
  const stageKeys = stages.map((s) => s.key);
  const extraTargets = (reverse && Array.isArray(reverse.chain) ? reverse.chain : [])
    .filter((node) => stageKeys.indexOf(node.key) === -1)
    .map((node) => ({
      key: node.key,
      label: node.label,
      target: node.value,
      targetRange: node.range,
      actual: null,
      assumption: true,
      why: '该指标为可选辅助指标，不参与主线漏斗',
    }));

  // 未参与倒推的可选 KPI（如 exposure / spread / referralCount），供 UI 单独展示
  const optionalKpis = kpis
    .filter((item) => item.funnel === false)
    .map((item) => ({
      key: item.key,
      label: item.label,
      unit: item.unit,
      caliber: item.caliber,
      target: chainMap[item.key] ? chainMap[item.key].value : null,
      actual: null,
      assumption: true,
    }));

  return {
    subject,
    stages,
    extraTargets,
    optionalKpis,
    isTargetModel: true,
    note: FUNNEL_NOTE,
    assumptionNote: REVERSE_ASSUMPTION_NOTE,
    assumption: true,
  };
}

/* ============================================================================
 * 4. 复盘回流：把实际数据升级为 user_history 系数
 * ==========================================================================*/

/**
 * 由复盘实际值计算各链路的真实转化率。
 * @param {string} subject 主体 key
 * @param {Object} actualMap { [kpiKey]: number } 复盘录入的实际值
 * @returns {Array<{linkKey:string, from:string, to:string, ratio:number, valid:boolean, reason:string}>}
 */
export function computeActualRatios(subject, actualMap) {
  const model = REVERSE_COEFFICIENTS[subject];
  const map = actualMap || {};
  if (!model) return [];
  return model.links.map((link) => {
    const fromValue = Number(map[link.from]);
    const toValue = Number(map[link.to]);
    if (!(fromValue > 0) || !(toValue > 0)) {
      return {
        linkKey: link.key,
        from: link.from,
        to: link.to,
        ratio: null,
        valid: false,
        reason: `缺少「${link.from}」或「${link.to}」的实际值`,
      };
    }
    const ratio = fromValue / toValue;
    if (!(ratio > 0) || ratio > 1) {
      return {
        linkKey: link.key,
        from: link.from,
        to: link.to,
        ratio,
        valid: false,
        reason: `实际转化率 ${round1(ratio * 100)}% 超出 (0,100%] 合理区间，疑似口径不一致，已跳过`,
      };
    }
    return { linkKey: link.key, from: link.from, to: link.to, ratio, valid: true, reason: '' };
  });
}

/**
 * 复盘数据回流：把本场实际转化率并入历史系数，source 自动升级为 user_history，sampleSize 累加。
 *
 * 区间口径：min/max 取历史观测包络（而非收窄），避免用单场数据冒充稳定规律；
 * sampleSize 每并一场 +1，n < 3 时 UI 追加「样本不足」提示。
 *
 * @param {Object} history 现有历史系数 { [subject]: { [linkKey]: {min,max,sampleSize,avg} } }
 * @param {string} subject 主体 key
 * @param {Object} actualMap { [kpiKey]: number } 复盘实际值
 * @returns {{history:Object, updated:Array<Object>, skipped:Array<Object>}} 不可变更新
 */
export function updateCoefficientHistory(history, subject, actualMap) {
  const base = history && typeof history === 'object' ? history : {};
  const ratios = computeActualRatios(subject, actualMap);
  const subjectHistory = { ...(base[subject] || {}) };
  const updated = [];
  const skipped = [];

  ratios.forEach((item) => {
    if (!item.valid) {
      skipped.push({ linkKey: item.linkKey, from: item.from, to: item.to, reason: item.reason });
      return;
    }
    const old = subjectHistory[item.linkKey];
    const n = (old && Number(old.sampleSize)) || 0;
    const oldAvg = old && Number(old.avg) ? Number(old.avg) : item.ratio;
    const nextN = n + 1;
    const next = {
      min: old && Number(old.min) ? Math.min(Number(old.min), item.ratio) : item.ratio,
      max: old && Number(old.max) ? Math.max(Number(old.max), item.ratio) : item.ratio,
      avg: (oldAvg * n + item.ratio) / nextN,
      sampleSize: nextN,
      source: 'user_history',
      lastRatio: item.ratio,
    };
    subjectHistory[item.linkKey] = next;
    updated.push({ linkKey: item.linkKey, from: item.from, to: item.to, ratio: item.ratio, sampleSize: nextN });
  });

  return {
    history: { ...base, [subject]: subjectHistory },
    updated,
    skipped,
  };
}

export default {
  KPI_DICT,
  getKpis,
  getKpi,
  getFunnelKeys,
  REVERSE_COEFFICIENTS,
  COEFFICIENT_SOURCES,
  reverseGoal,
  buildFunnel,
  updateCoefficientHistory,
};
