/**
 * promoCalendarSeed —— 已录入的「活动档期」记录（数据层，纯常量，无逻辑）。
 *
 * ── 它从哪来（来源必须写在数据里，不写在注释里才叫可追溯）──────────────────────
 * 2026-10-11 老板提供了一张「MMM · 10 月活动日历」截图（989×1920），本文件的记录
 * **逐字来自该截图**。识别方式：仓库自带 `python-runtime` 的 RapidOCR + 像素几何测量
 * （横条 bbox 定日期跨度；小字用笔画行剖面做确定性判定），**不是目测**。
 *
 * ── 三条不许越界的纪律（老板 2026-10-11 明确要求）─────────────────────────────
 *  1. **保留原始名称**。`name` 一律照截图写，即使命名维度不统一（档期/机制/主题/品牌/券种
 *     五种逻辑混用）也不改名 —— 统一命名要等业务方确认，不许由程序"顺手改漂亮"。
 *  2. **两个名称存疑的原样保留**：`益锐品牌周`、`植体DAY`。它们是品牌名/大写英文，
 *     OCR 置信度偏低，`verify='pending'` 标注，等老板确认后才可改。
 *  3. **券面规则不得自行解释**。`下单满500元返999-50优惠券` 里的「999-50」到底是
 *     「满 999 减 50」的券面还是别的含义，截图没有书面说明 ⇒ `condition` **留空**、
 *     `verifyNote` 记下"待核实"，绝不在数据里写成「满 999 减 50」。
 *
 * ── 为什么是「种子」而不是直接写库 ────────────────────────────────────────────
 * 本应用当前**没有档期录入界面**。真实的读写路径是 localStorage 键 `douya-promo-calendar`
 * （形如 `{ [companyId]: { records: [...] } }`），由 `services/promoCalendar.js` 的
 * `loadPromoRecords` 读取：**store 优先，store 里该企业没有记录时才回落到本文件的种子**。
 * 这样今天就能用，将来接了录入界面 / api.example.com 档期接口，**只换数据源，不动上下文层**。
 *
 * ⚠️ 已知边界：种子按**企业名**匹配（见 PROMO_SEED_ALIASES）。这是"没有录入界面"阶段的
 *   权宜做法 —— 若某企业恰好同名会误命中。接真实数据源后此匹配应整体删除。
 */

/** 种子适用的企业名匹配词（小写包含匹配）。覆盖康健苗苗集团下的同名/近名主体。 */
export const PROMO_SEED_ALIASES = ['上游货源', '康健苗苗', 'miaomiao', 'supplier-b'];

/** 种子来源（写进每条记录，AI 与用户都能看到"这批档期是怎么来的"）。 */
export const PROMO_SEED_SOURCE = '老板 2026-10-11 提供的「MMM · 10月活动日历」截图（OCR 录入）';

/** 录入日期（ISO）。 */
export const PROMO_SEED_RECORDED_AT = '2026-10-11';

/**
 * 活动类型枚举。⚠️ 归类由豆芽按名称/机制判定，**不是用户确认的分类**
 * （见 PROMO_SEED_TYPE_BASIS）—— 只用于组织语言，不得作为业务事实引用。
 */
export const PROMO_SEED_TYPE_BASIS = '豆芽按名称归类，非用户确认';

/** 核实状态枚举：user=已录入（老板确认过这批档期） / pending=待核实（名称或规则存疑）。 */
export const PROMO_SEED_VERIFY = { USER: 'user', PENDING: 'pending' };

/**
 * 已录入的档期记录。
 *
 * 字段契约（老板指定的最小字段集，**每条都必须有**）：
 *   name        原始名称（截图逐字，不许改）
 *   startDate   开始日期 'YYYY-MM-DD'；周期活动为空串（用 recurring 表达）
 *   endDate     结束日期 'YYYY-MM-DD'；周期活动为空串
 *   type        活动类型（见 PROMO_SEED_TYPE_BASIS，豆芽归类）
 *   condition   适用条件；截图未给书面规则的**留空**（空 = 资料未记录，不编造）
 *   source      来源
 *   verify      核实状态
 *   kind        'campaign' 一次性档期 | 'recurring' 周期活动（固定周档期）
 *   recurring   周期规则 { freq:'weekly', byDay:1..7 }（ISO，1=周一 … 7=周日）；非周期为 null
 *   rawNote     截图原文小字（OCR 读数，原样保留、**不解释成规则**）
 *   verifyNote  存疑说明（为什么 verify=pending）
 *   aliases     别称（如老板口述时用的名字）；仅为可检索，不替代 name
 */
export const PROMO_SEED = [
  // ══════════ 周期性档期（每周固定；老板要求：作为周期规则保存，不是某个月的具体日期）══════════
  {
    id: 'promo-weekly-implant-day',
    name: '植体DAY',
    kind: 'recurring',
    recurring: { freq: 'weekly', byDay: 1 },
    startDate: '',
    endDate: '',
    type: '周期',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.PENDING,
    verifyNote: '名称待核实：截图为「植体DAY」（OCR 置信 0.76），末段大写英文是否原样、还是「植体日」需老板确认',
    rawNote: '',
    aliases: [],
  },
  {
    id: 'promo-weekly-anesthesia',
    name: '麻药特价',
    kind: 'recurring',
    recurring: { freq: 'weekly', byDay: 3 },
    startDate: '',
    endDate: '',
    type: '周期',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.USER,
    verifyNote: '',
    rawNote: '',
    aliases: [],
  },
  {
    id: 'promo-weekly-thursday-coupon',
    name: '周四优惠券',
    kind: 'recurring',
    recurring: { freq: 'weekly', byDay: 4 },
    startDate: '',
    endDate: '',
    type: '周期',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.PENDING,
    verifyNote: '截图该格下方有小字，但未能可靠识别成完整规则，故未落为「适用条件」',
    // 小字**原样**保留 OCR 读数，不做语义解释 —— 它读起来不完整，说明是残句，不能当规则用。
    rawNote: '同时存在优先其他优惠券活动',
    aliases: [],
  },

  // ══════════ 10 月一次性档期 ═════════
  {
    id: 'promo-2026-10-nationalday',
    name: '国庆活动',
    kind: 'campaign',
    recurring: null,
    startDate: '2026-10-01',
    endDate: '2026-10-07',
    type: '档期',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.USER,
    verifyNote: '',
    rawNote: '',
    aliases: [],
  },
  {
    id: 'promo-2026-10-monthstart-coupon',
    name: '月初优惠券',
    kind: 'campaign',
    recurring: null,
    startDate: '2026-10-01',
    endDate: '2026-10-07',
    type: '券',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.USER,
    verifyNote: '',
    rawNote: '',
    aliases: [],
  },
  {
    id: 'promo-2026-10-yirui-week',
    name: '益锐品牌周',
    kind: 'campaign',
    recurring: null,
    startDate: '2026-10-08',
    endDate: '2026-10-18',
    type: '品牌',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.PENDING,
    verifyNote: '名称待核实：放大 6 倍复核仍为「益锐」（OCR 置信 0.83），是品牌名，需老板确认是否为「益锐」二字',
    rawNote: '',
    aliases: [],
  },
  {
    id: 'promo-2026-10-recharge',
    name: '充值送',
    kind: 'campaign',
    recurring: null,
    startDate: '2026-10-15',
    endDate: '2026-10-17',
    type: '机制',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.USER,
    verifyNote: '',
    rawNote: '',
    aliases: [],
  },
  {
    id: 'promo-2026-10-order500-coupon',
    name: '下单满500元返999-50优惠券',
    kind: 'campaign',
    recurring: null,
    startDate: '2026-10-19',
    endDate: '2026-10-25',
    type: '券',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.PENDING,
    verifyNote:
      '券面规则待核实：名称中的「999-50」含义未获书面说明，不得自行解释为「满 999 减 50」或任何折扣规则',
    rawNote: '',
    // 老板口述时把它称作「满额送券活动」—— 记下别称便于检索，但**不替代**原始名称。
    aliases: ['满额送券活动'],
  },
  {
    id: 'promo-2026-10-double11-pre',
    name: '双十一抢先购',
    kind: 'campaign',
    recurring: null,
    startDate: '2026-10-20',
    endDate: '2026-10-31',
    type: '主题',
    condition: '',
    source: PROMO_SEED_SOURCE,
    recordedAt: PROMO_SEED_RECORDED_AT,
    verify: PROMO_SEED_VERIFY.USER,
    verifyNote: '',
    rawNote: '',
    aliases: [],
  },
];

export default { PROMO_SEED, PROMO_SEED_ALIASES, PROMO_SEED_SOURCE, PROMO_SEED_RECORDED_AT };
