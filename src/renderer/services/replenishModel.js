/**
 * replenishModel.js —— 「AI 补货」页的**唯一数据口径**（0.21.14 · 需求 3 · T01 共享底座）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【这个文件存在的理由：把「口径」和「界面」拆开】
 *   补货页要同时处理三件容易互相污染的事：上游商城的脏字段、本地常购清单、到货红点。
 *   如果这些都写在 `AIReplenish.jsx` 里，门禁只能靠挂组件 + 打桩，一个字段归一错就整页红。
 *   所以这里把**全部判断**做成纯函数（可单测），组件只负责渲染与调用。
 *
 * 【字段口径的每一条都有实测依据】（架构设计 §3.2，52 条真实样本）
 *   · 只认 6 个上游字段：`productId` / `name` / `price` / `discountPrice` / `hasStock` / `isNotShowPrice`。
 *   · 上游那个「市场价」字段（主进程已整条裁掉，见 `src/main/shopProducts.js` 的 6 字段投影）
 *     **不进模型**：52/52 与 `price` 完全相等，它不是「厂家建议价」而是 `price` 的拷贝。
 *     拿它当划线原价，今天算不出错，但上游哪天真给了不一样的价就会静默出错。
 *     ⚠️ 本文件的注释里**连它的字面名都不写**：AC-3.6c 门禁是
 *     「`grep` 该字面名 + `src/renderer/` = 0 命中」——注释里出现一次也算命中。
 *     那正是我们要的效果：渲染层连提都不该提它，提了迟早有人用。
 *   · 上游还有四个字段**一律不进模型**，理由各自独立（S6 唯一真源）：
 *     ① 商城自带的那个「折扣金额」字段恒 `0.0`（52/52）；
 *     ② 商城自带的「是否打折」标记有反例（实测 `2.0/1.5` 却标「不打折」）⇒ 不能当排序依据；
 *     ③ 销量字段（不是库存，也不能拿来暗示库存，AC-3.12b）；
 *     ④ 图片路径字段全带未解占位符 `{0}`，三种替换取回的都是 JSON 不是图片。
 *     ⚠️ 本文件**连它们的字面名都不写**（上面那个「市场价」同理）：AC-3.6c / AC-3.17b /
 *     AC-3.17c 的门禁形态就是「`grep` 该字面名 + `src/renderer/` = 0 命中」——
 *     注释里出现一次也算命中。那正是要的效果：渲染层连提都不该提，提了迟早有人用。
 *   · `hasStock` **三分法**（true / false / null）：缺失一律 `null`（未知），
 *     绝不用 `!!v`（会把「不知道」谎报成「没货」，那是编数据）。
 *
 * 【`null` 与 `0` 必须区分】
 *   `price === discountPrice`（实测 26/50 无折扣）→ `discountRate = 0`（**可比价**，只是没便宜）；
 *   `priceHidden` / `price <= 0` / `discountPrice` 缺失 → `null`（**不可比价**，从性价比排序中排除）。
 *   两者都写成 0 会让「价格隐藏」的商品被当成「0 折扣」混进排序 —— 上一版踩过。
 *
 * 【存储一律企业隔离】（S10）三个 key 都是 `{ [companyId]: ... }`；
 *   企业 id 缺失时**不写库**、返回 `{ok:false}`。
 */

/** 常购清单：`{ [companyId]: SubItem[] }` */
export const SUBS_KEY = 'douya-replenish-subs';
/** 上一轮库存快照：`{ [companyId]: { [subKey]: { hasStock: boolean, at: number } } }` */
export const STOCK_KEY = 'douya-replenish-stock';
/** 到货红点已读水位（ms）：`{ [companyId]: number }` */
export const SEEN_KEY = 'douya-replenish-seen';

/** 到货红点上限：超过显示 `99+`（S7）。 */
export const DOT_MAX = 99;

/**
 * 生成稳定键：小写 → 去掉空白与标点 → 保留中日韩字符与字母数字。
 *
 * 为什么要 slug 而不是直接用原文：
 *   常购清单与商城商品来自两个系统，同一个东西可能写成「3M 树脂 A2」/「3m树脂a2」，
 *   直接按原文比对会漏配（用户看到「未匹配」却明明有货）。
 * 为什么不用更激进的归一：**不做语义相似**（P1-3）。只做关键词/字符级归一，口径写死、可单测。
 *
 * @param {*} s 原始文本
 * @returns {string} 归一化键（空输入 → `''`）
 */
export function slug(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    // 保留：中日韩、字母、数字。其余（空格 / 标点 / 全角符号）一律去掉
    .replace(/[^\u4e00-\u9fa5\u3040-\u30ffa-z0-9]/g, '')
    .trim();
}

/**
 * 归一化金额（`null` / 空串 / 非有限数 → `null`；`0` 是合法金额）。
 * @param {*} v
 * @returns {number|null}
 */
export function toMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * `isNotShowPrice` 归一：**显式为真才算隐藏**（吃 `true` 与 `'1'` 两种编码）。
 * 不能写成 `v !== '0'`：字段缺失时 `undefined !== '0'` 为真，会把整批价格置空。
 * @param {*} v
 * @returns {boolean}
 */
export function normalizePriceHidden(v) {
  if (v === true) return true;
  return String(v === null || v === undefined ? '' : v).trim() === '1';
}

/**
 * 库存三分法归一：吃 `true/false/1/0/'1'/'0'/'true'/'false'`，无法识别一律 `null`（未知）。
 * **永不**从销量字段推库存（S11）。
 * @param {*} v
 * @returns {boolean|null}
 */
export function normalizeHasStock(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

/**
 * 折扣率（AC-3.17 / 3.17d）。
 *
 * ```
 * rate = (price > 0 && discountPrice != null && !priceHidden)
 *          ? (price - discountPrice) / price
 *          : null
 * ```
 * 不 clamp 下限（实测最高 0.537，没有负值样本；若上游给负数，也如实返回，让界面显示异常）。
 *
 * 单测锚点：`{20,10}`→`0.5`；`{10,10}`→`0`；`{0,0}`→`null`；`{10,null}`→`null`；`{10,8,hidden}`→`null`。
 *
 * @param {{price?:*, discountPrice?:*, priceHidden?:*}} p 商品（或已经是归一化后的 ShopProduct）
 * @returns {number|null} 0~1 之间的小数；`null` = 不可比价
 */
export function computeDiscountRate(p) {
  const it = p && typeof p === 'object' ? p : {};
  const price = toMoney(it.price);
  const discountPrice = toMoney(it.discountPrice);
  const hidden = it.priceHidden === true || normalizePriceHidden(it.isNotShowPrice);
  if (hidden) return null;
  if (price === null || price <= 0) return null;
  if (discountPrice === null) return null;
  return (price - discountPrice) / price;
}

/**
 * 归一化一条商城商品 → `ShopProduct`（契约见架构设计 §3.2）。
 * `name` 空白 ⇒ 返回 `null`（**该条整条丢弃**，不渲染空行）。
 *
 * @param {object} raw 上游商品（main 进程已裁成 6 字段，这里再兜一次，防有人直接塞原始报文）
 * @returns {object|null}
 */
export function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name === null || raw.name === undefined ? '' : raw.name).trim();
  if (!name) return null;
  const priceHidden = raw.priceHidden === true || normalizePriceHidden(raw.isNotShowPrice);
  const productId = String(
    raw.productId === null || raw.productId === undefined ? (raw.id === null || raw.id === undefined ? '' : raw.id) : raw.productId,
  ).trim();
  const item = {
    key: productId || slug(name),
    productId,
    name,
    // 价格隐藏 ⇒ 价格置 null（不显示、不参与比价）；null ≠ 0
    price: priceHidden ? null : toMoney(raw.price),
    discountPrice: priceHidden ? null : toMoney(raw.discountPrice),
    hasStock: normalizeHasStock(raw.hasStock),
    priceHidden,
    discountRate: null,
    // 规格键只由**商品名**派生：上游那个「规格」字段实测恒 `null`（AC-3.7b 已把它的字面名列为
    // 0 命中，故此处不写名字），品牌字段也不参与
    // 任何匹配或排序（AC-3.19 的判据是「本文件里连它的字面名都不出现」）。
    specKey: slug(name),
  };
  item.discountRate = computeDiscountRate(item);
  return item;
}

/**
 * 性价比排序（AC-3.18）：两种口径由 `opts.preferDiscount` 选择。
 *
 * 口径 B（`opts.preferDiscount === true`，用户勾上「优先选打折的」）—— **主序 = 折扣率降序**：
 *   老板原话「补货的时候优先给他推荐目前打折的商品，**折扣大的优先补货**」
 *   +「用户可以设定一个值…**勾选**优先选择折扣商品」——那个勾选框的语义就是这个开关。
 *   排序键：① `discountRate` 降序 ② `discountPrice` 升序 ③ `key` 升序。
 *
 * 口径 A（默认，`preferDiscount` 不为真）—— **主序 = 现价升序，且不读 `discountRate`**：
 *   用户没勾「优先打折」时，他要比的只是价格。此时若还拿折扣率当次序键，
 *   等于偷偷替他做了「打折的更值」这个判断 —— 那是替他下结论，不是排序。
 *   排序键：① `discountPrice` 升序 ② `key` 升序（稳定兜底，同一批数据多次排序顺序一致）。
 *
 * 两种口径都**排除**不可比价的商品（`discountRate === null`：价格隐藏 / 原价 ≤ 0 / 缺现价）。
 * 判据直接用派生的 `discountRate`，**不在这里重写一遍隐藏判定** —— 重写就会出现
 * 「改口径只改一处」的老坑（`computeDiscountRate` 是唯一真源）。
 * 混进来的后果是：一排没有现价的商品靠位置暗示「它更划算」，那是编结论。
 *
 * `opts.maxPrice` 是「最高可接受单价」：给有限数时叠加 `discountPrice <= maxPrice`；
 * `null` / 缺失 / 非法 ⇒ **不截断**（不是「过滤掉全部」，也不是「按 0 处理」）。
 *
 * **两个分支必须能排出相反结果**，否则勾选框是个装饰：
 *   `X={200,100}`（率 0.5）/ `Y={8,8}`（率 0）⇒ `preferDiscount:true` 得 `[X,Y]`，
 *   `preferDiscount:false` 得 `[Y,X]`。只测一个分支等于没测这个开关。
 *
 * @param {Array} list ShopProduct[] 或任意可归一化的原始商品
 * @param {{preferDiscount?:boolean, maxPrice?:*}} [opts]
 * @returns {Array} 新数组（不改入参）
 */
export function sortValueProducts(list, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const preferDiscount = o.preferDiscount === true;
  // maxPrice 归一：`null` / 非数字 / 非有限数 / **非正数** ⇒ 一律视为「没设上限」（不截断）。
  // 为什么非正数也要放行（`0` / 负数）：
  //   `maxPrice: 0` 若照字面执行会得到**空结果集**，而页面只能显示「没有商品」——
  //   用户看到的是「这个平台没货」，实际是筛选条件把全部排除了。这类「安静地给出错误结论」
  //   比抛错难查得多。且业务上 0 元商品不存在（真 0 元 / 隐藏价已被上游 `discountRate === null`
  //   排除），故 `0` 必然不是用户本意，只能是「没填」或「误填」。
  // ⚠️ **拦截只能在 service 层做这一处**：UI 层不许再写一遍 `> 0` 判断 ——
  //   两处各写一遍就是「改口径只改一处」的老坑（同 `filterValueProducts` 的注释）。
  // ⚠️ 也不许改 `toMoney` 来实现这条：`toMoney` 同时服务 `parseSubsCsv` 的 `maxPrice` 字段，
  //   在那里 `0` 要保留原义（CSV 里写 0 是数据，不是 UI 空输入）。
  //
  // ⚠️ **`!Number.isFinite(rawMax)` 这一段，从公开 API 走不到**（别删，理由在下面）。
  //   实测 `toMoney` 的值域只有两种：`null`，或**有限数**（`'abc'` / `NaN` / `Infinity` / `''`
  //   全被归成 `null`）。所以当 `rawMax !== null` 时它必然是有限数 ⇒ 这个子条件恒为假，
  //   任何用例都覆盖不到它 —— 我试过给它写断言，写不出来，这是本文件**唯一**一条
  //   没有断言钉着的分支。
  //   留着它的理由是**它不是给现在写的，是给以后写的**：万一有人把 `toMoney` 改成返回 `NaN`
  //   （它是一个通用取数函数，改动的诱因存在），少了这一段就会变成 `max = NaN`，
  //   而 `Number(x.discountPrice) <= NaN` 恒为假 ⇒ **整批商品被无声滤光**，
  //   回到这条注释开头讲的那个「安静地给出错误结论」。
  //   ⇒ `toMoney` 的值域已由 `r0214-t01-model-probe.mjs` 的【0b】段钉住
  //     （12 个输入逐个断言「只可能是 null 或有限数」）。那条断言红了 = 有人动了 `toMoney`
  //     的契约，此时这一段就是唯一的护栏，**更不能删**。
  const rawMax = toMoney(o.maxPrice);
  const max = rawMax === null || !Number.isFinite(rawMax) || rawMax <= 0 ? null : rawMax;
  const arr = (Array.isArray(list) ? list : [])
    .map((x) => (x && typeof x === 'object' ? (x.discountRate === undefined || x.key === undefined ? normalizeProduct(x) : x) : null))
    .filter((x) => x && x.discountRate !== null && x.discountRate !== undefined)
    .filter((x) => x && x.discountPrice !== null && x.discountPrice !== undefined && Number.isFinite(Number(x.discountPrice)))
    .filter((x) => (max === null ? true : Number(x.discountPrice) <= max));
  const byKey = (a, b) => (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0);
  return arr.sort((a, b) => {
    const ap = Number(a.discountPrice);
    const bp = Number(b.discountPrice);
    if (preferDiscount) {
      // 口径 B：① 折扣率降序 ② 现价升序 ③ 稳定兜底
      const ar = Number(a.discountRate);
      const br = Number(b.discountRate);
      if (ar !== br) return br - ar;
      if (ap !== bp) return ap - bp;
      return byKey(a, b);
    }
    // 口径 A：① 现价升序 ② 稳定兜底（**不读 discountRate**）
    if (ap !== bp) return ap - bp;
    return byKey(a, b);
  });
}

/**
 * 性价比模式的**筛选**（AC-3.16 / AC-3.16b）：只留「能比价」的，再按最高单价截断。
 *
 * 「能比价」的判据就是 `discountRate !== null`（AC-3.17 的六条锚点已把三种不可比价情形
 * 都折成 `null`：价格隐藏 / 原价 ≤ 0 / 现价缺失）。**不要**在这里再写一遍隐藏判定 ——
 * 两处各写一次，改口径时必然只改一处（这是本仓踩过的老坑）。
 *
 * `maxPrice` 为 `null` / 非法 ⇒ 不截断（不是「过滤掉全部」，也不是「按 0 处理」）。
 *
 * @param {Array} list 商品（原始或已归一化）
 * @param {{maxPrice?:*, preferDiscount?:boolean}} [opts]
 * @returns {Array} 已排序的新数组
 */
export function filterValueProducts(list, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  // 只做「筛条件 + 转调排序」，**不自己再写一遍过滤** ——
  // 上面 `sortValueProducts` 的 filter 链已经覆盖「可比价 / 有现价 / ≤ maxPrice」三件事，
  // 两处各写一遍就是「改口径只改一处」的老坑。本函数保留只是为了语义清晰（筛/排分开叫）。
  return sortValueProducts(list, { preferDiscount: o.preferDiscount === true, maxPrice: o.maxPrice });
}

/**
 * 折扣率的展示形态：整数百分比（UI 不显示 `0.537` 这种小数）。
 * `null`（不可比价）⇒ `''`（**不是** `0%`）。
 * @param {number|null} rate
 * @returns {string}
 */
export function formatDiscountRate(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return '';
  return Math.round(Number(rate) * 100) + '%';
}

// ---------------------------------------------------------------------------
// 采购量的三条纯规则（AC-3.26 / AC-3.27 / AC-3.28）
//
// 这三条是**唯一**从 `data/clinicDealerSeed.js` 的 `computeRestock()` 里移植过来的东西
// （逐条判定见 PRD §3.2b）：`need` 兜底 ≥1 / 报价取最低 / 纯函数形态。
// 与本地库存水位相关的那几条（`qty <= threshold` 触发、`threshold*1.5` 公式、
// `RESTOCK_POLICY` 的 30 天策略、必需/非必需二分）**全部不搬** —— 本轮没有库存件数
// 数据源（上游 `hasStock` 只是布尔，AC-3.12b），搬过来只能靠编数字驱动。
//
// ⚠️ 三个函数都**不吃默认参数指向种子数据**（AC-3.29：本文件里那类常量的前缀字面名必须 0 命中）。
// ---------------------------------------------------------------------------

/**
 * 这次要补多少件（AC-3.26）。
 *
 * 语义沿用旧实现的兜底：`Math.max(target - qty, 1)` —— 算出来是 0 或负数时也要给 1，
 * 否则「补货单上写着补 0 件」会成为死循环（用户点十次也不减库存）。
 *
 * 本轮 `qty`（已有量）恒按 0 计：上游只给 `hasStock` 布尔，没有件数（AC-3.12b），
 * 拿不到就按 0 说，不做「估计还剩几件」那种编数据的事。
 *
 * 单测锚点：`(8, 20) → 12`、`(20, 20) → 1`（不是 0）、`(0, 0) → 1`。
 *
 * @param {*} qty 已有件数
 * @param {*} target 目标件数
 * @returns {number} ≥ 1 的整数
 */
export function computeNeedQty(qty, target) {
  const have = toMoney(qty);
  const want = toMoney(target);
  const need = (want === null ? 0 : want) - (have === null ? 0 : have);
  const n = Math.ceil(need);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 一列报价里取最低（AC-3.27）：按 `final`（最终单价）升序取第一条。
 * 空数组 ⇒ `null`（**不返回 `undefined`**：下游写 `best.supplier` 时 `undefined` 会抛错，
 * 而 `null` 至少在 `if (best)` 里是安全的）。
 *
 * `final` 缺失时退回 `price`（旧实现里 `final = price * 1`，那个 `*1` 是预留乘数、从未实现，
 * 这里不假装它存在）。
 *
 * @param {Array} quotes `[{ supplier, brand, price, moq, final? }]`
 * @returns {object|null}
 */
export function pickCheapest(quotes) {
  const list = (Array.isArray(quotes) ? quotes : []).filter((q) => q && typeof q === 'object');
  if (!list.length) return null;
  const priced = list
    .map((q) => {
      const f = toMoney(q.final);
      const p = toMoney(q.price);
      const unit = f === null ? p : f;
      return { q, unit };
    })
    // 一个价格都没有的报价不参与比较（拿它当 0 元会把最贵的报成最便宜的）
    .filter((x) => x.unit !== null);
  if (!priced.length) return null;
  priced.sort((a, b) => (a.unit !== b.unit ? a.unit - b.unit : 0));
  return priced[0].q;
}

/**
 * 起订量对齐（AC-3.28，旧实现**完全没做**的那块）：`moq > 0` 时把数量向上取整到它的整数倍。
 *
 * 旧实现的 `need` 公式从没看过 `moq`，于是会算出「补 12 件，起订 10 件」这种下单会被拒的数。
 *
 * 单测锚点：`(12, 10) → 20`、`(12, 5) → 15`、`(12, 0) → 12`、`(12, null) → 12`。
 *
 * @param {*} need 需求量
 * @param {*} moq 起订量（`0` / 缺失 / 非法 ⇒ 不对齐）
 * @returns {number} ≥ 1 的整数
 */
export function applyMoq(need, moq) {
  const n = computeNeedQty(0, need);
  const step = toMoney(moq);
  if (step === null || step <= 0) return n;
  return Math.ceil(n / step) * step;
}

// ---------------------------------------------------------------------------
// 多商品批量补货（0.21.15 · 老板需求 9：「AI补货 要支持多商品补货 页面做的跟表格一样」）
//
// 这一节只放**判断**：一行补货量怎么解析、批量设数量能不能落、补货单怎么汇总、
// 批量请求怎么排队。表格长什么样、按哪个键排序、按钮叫什么，全部留在 `Replenish.jsx`。
//
// ⚠️ 为什么不把「数量」直接存成 `Number(e.target.value)`：
//   `Number('')` 是 `0`、`Number('abc')` 是 `NaN`。两者都会**安静地**变成「补 0 件」或
//   「补 NaN 件」，然后一路流进小计（`NaN` 金额）与合计（整单变 `NaN`）。
//   用户看到的是一张「什么都没发生」的表，而系统认为他补了东西。所以数量一律先过
//   `parseQtyInput`，**三态**（空 / 非数字 / < 1）各自给一句人话，且**拒绝写入**——
//   拒绝写 = 上一份合法值还在，界面不会跳成 0。
// ---------------------------------------------------------------------------

/**
 * 一行补货量的**唯一**解析口径（三态拒绝 + 上限归一）。
 *
 * 返回值是一份**判定书**而不是数字，好处是调用方能区分「用户没填」与「用户填错了」，
 * 也能把 `error` 原样贴到界面上（口径只存在一处，UI 不重复判断）。
 *
 * | 输入 | `ok` | `reason` | `value` | `error` |
 * |---|---|---|---|---|
 * | `5` / `'5'` | true | `ok` | `5` | `''` |
 * | `2.4` | true | `ok` | `3` | `''`（小数**向上取整**，与 `computeNeedQty` 同口径：宁可多买一件） |
 * | `null` / `undefined` / `''` / `'  '` | false | `empty` | `null` | `先填一个数量` |
 * | `'abc'` / `NaN` / `Infinity` / `{}` | false | `nan` | `null` | `数量只能填数字` |
 * | `0` / `-3` | false | `too-small` | `null` | `数量至少 1 件` |
 *
 * ⚠️ `0` 被**拒绝**而不是「当成没填」：上一版 `computeNeedQty(0, 0)` 会兜底成 1，
 *   但那是「补货量算出来是 0」的兜底，不是「用户明确填了 0」。用户填 0 只有两种可能：
 *   填错了，或者他以为 0 = 不补。两种都该被告知一句，而不是被静默改成 0 件或 1 件。
 *
 * @param {*} raw 输入框给的原始值
 * @returns {{ok:boolean, reason:'ok'|'empty'|'nan'|'too-small', value:number|null, error:string}}
 */
export function parseQtyInput(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'empty', value: null, error: '先填一个数量' };
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return { ok: false, reason: 'empty', value: null, error: '先填一个数量' };
  }
  if (typeof raw === 'object') {
    // `InputNumber` 在极端输入下会把内部对象塞回来；对象一律不当数字，避免 `Number({})` = NaN 的静默路径
    return { ok: false, reason: 'nan', value: null, error: '数量只能填数字' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: 'nan', value: null, error: '数量只能填数字' };
  }
  if (n < 1) {
    return { ok: false, reason: 'too-small', value: null, error: '数量至少 1 件' };
  }
  return { ok: true, reason: 'ok', value: Math.ceil(n), error: '' };
}

/**
 * 批量设数量：把**一批** key 的补货量一起设成同一个值（老板说的「勾选/全选 → 统一设数量」）。
 *
 * 三种拒绝都是**全量拒绝**（一条也不改）：数量非法、一个都没勾、`keys` 不是数组。
 * 为什么不做「能设的设、不能设的跳过」：用户勾了 8 行、填了个非法值，界面上 8 行里
 * 有 5 行变了 3 行没变，是最难解释的状态。要么全改，要么一条不改 + 一句为什么。
 *
 * ⚠️ 返回的是**新的** `next` 映射（不改入参）。上层 `setQtyDraft(r.next)` 直接落。
 *
 * @param {Array<string>} keys 要设的行键
 * @param {*} raw 统一补货量的原始输入
 * @param {object} [prevMap] 当前的 `{ [key]: number }`
 * @returns {{ok:boolean, reason:string, error:string, keys:string[], next:object, changed:number}}
 */
export function applyBulkQty(keys, raw, prevMap) {
  const prev = prevMap && typeof prevMap === 'object' ? { ...prevMap } : {};
  const parsed = parseQtyInput(raw);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, error: parsed.error, keys: [], next: prev, changed: 0 };
  }
  const list = (Array.isArray(keys) ? keys : []).map((k) => String(k === null || k === undefined ? '' : k)).filter(Boolean);
  if (!list.length) {
    return { ok: false, reason: 'no-selection', error: '先勾选要补的商品', keys: [], next: prev, changed: 0 };
  }
  const next = { ...prev };
  list.forEach((k) => {
    next[k] = parsed.value;
  });
  return { ok: true, reason: 'ok', error: '', keys: list, next, changed: list.length };
}

/**
 * 把常买清单 + 库存匹配结果 + 补货量草稿拼成**表格的行模型**（表格唯一的取数口径）。
 *
 * 为什么放在 service 而不是组件的 `useMemo` 里：
 *   行模型里有四条口径（默认补货量 = `applyMoq(computeNeedQty(0, sub.qty), 0)`、
 *   库存三分法、单价 `null` 即「价格待定」、小计 = 单价 × 数量），任何一条写错都会
 *   让「合计金额」骗人。放在这里就能拿纯函数钉住，不用挂组件。
 *
 * 默认补货量的来源顺序：**用户草稿 → 清单里的 `qty` → 1**。
 *   `qtyDraft[key]` 缺失 / 非法（`0`、`NaN`、`''`）时一律退回 `sub.qty`——
 *   这里**不会**把非法值落成 0 行，因为 0 件在补货单里没有意义。
 *
 * @param {Array} subs 常买清单 `SubItem[]`
 * @param {object} [stockMap] `{ [subKey]: ShopProduct }` 本轮对上的商城商品
 * @param {object} [qtyMap] `{ [subKey]: number }` 用户改过的补货量
 * @returns {Array} 行模型数组（顺序与 `subs` 一致，不重排）
 */
export function buildReplenishRows(subs, stockMap, qtyMap) {
  const list = (Array.isArray(subs) ? subs : []).filter((s) => s && typeof s === 'object' && s.name);
  const stock = stockMap && typeof stockMap === 'object' ? stockMap : {};
  const qty = qtyMap && typeof qtyMap === 'object' ? qtyMap : {};
  return list.map((s) => {
    const key = String(s.key);
    const product = stock[key] && typeof stock[key] === 'object' ? stock[key] : null;
    const hasStock = product ? normalizeHasStock(product.hasStock) : null;
    const price =
      product && product.discountPrice !== null && product.discountPrice !== undefined ? toMoney(product.discountPrice) : null;
    const fallbackNeed = applyMoq(computeNeedQty(0, s.qty), 0);
    const drafted = parseQtyInput(qty[key]);
    const need = drafted.ok ? drafted.value : fallbackNeed;
    return {
      key,
      name: String(s.name),
      spec: String(s.spec === null || s.spec === undefined ? '' : s.spec),
      brand: String(s.brand === null || s.brand === undefined ? '' : s.brand),
      product,
      hasStock,
      price,
      need,
      // 价格未知 ⇒ 小计 `null`（界面写「—」），**不是 0 元**：0 元会让合计少算一笔却不留痕
      amount: price === null ? null : Math.round(price * need * 100) / 100,
    };
  });
}

/**
 * 补货单 / 表格底部的**合计**（老板要的「底部要有合计（条数 + 金额）」）。
 *
 * 口径三条：
 *   ① `count` 是**条数**（几行商品），`totalQty` 是**件数**（数量之和）——两者不可互相替代；
 *   ② 单价未知的那行**计入条数与件数，不计入金额**，并单独报到 `unpriced` 里，
 *      界面必须把这句说出来（否则用户以为合计就是全部）；
 *   ③ 金额四舍五入到分（`0.1 * 3` 这类浮点噪声不进界面）。
 *
 * @param {Array} items `[{ key, name, need, price }]`
 * @returns {{count:number, totalQty:number, totalAmount:number, priced:number, unpriced:number}}
 */
export function summarizeReplenishOrder(items) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === 'object');
  let totalQty = 0;
  let totalAmount = 0;
  let priced = 0;
  let unpriced = 0;
  list.forEach((it) => {
    const need = toMoney(it.need);
    const q = need === null || need <= 0 ? 0 : Math.ceil(need);
    totalQty += q;
    const price = toMoney(it.price);
    if (price === null) {
      unpriced += 1;
      return;
    }
    priced += 1;
    totalAmount += price * q;
  });
  return {
    count: list.length,
    totalQty,
    totalAmount: Math.round(totalAmount * 100) / 100,
    priced,
    unpriced,
  };
}

// ---------------------------------------------------------------------------
// 两页式补货（老板需求：第一页选商品 → 第二页补货清单，常买置顶，预设数量一键补）
//
// 【老板原话】
//   「AI补货 现在要做成商品管理页一样，第一页选商品，第二页是补货的商品页面（类似于购物车）
//    常买的始终置顶，一次性补货的排在常卖下面，并且要有价格显示。而且既然是常买的东西
//    为什么要加入清单 不应该是设定好数量点击确定他自动就给你加好了吗？
//    每次要补货的时候只要点一下就行了。」
//
// 【这一节只放判断，不放界面】
//   「常买还是一次性」怎么分、「预设数量」取哪个、「一键补货」补哪些、合计怎么加 ——
//   全部是纯函数。`Replenish.jsx` 只负责渲染与调用，因为这几条口径一旦写错，
//   界面上的表现是「数字看起来对、其实少算了一笔」，比抛错难查得多。
//
// 【为什么不需要新的 localStorage key】
//   老板说的「设定好数量」，在数据里**已经有了**：清单条目的 `qty`，CSV 那一列的字面名
//   就叫「每次补货数量」（见本文件 `CSV_COLUMNS`）。所以预设数量 = `qty`，
//   写回走既有的 `writeSubs`（同一个 key、同一套企业隔离），**不新开存储**。
//   ⇒ 不新增存储的另一个好处：老用户升级后，之前 CSV 里填的数量**立刻就是**默认预设，
//     不需要迁移脚本，也不会出现「预设全是 1」这种"升级即丢配置"。
// ---------------------------------------------------------------------------

/**
 * 补货清单的两个分组，**数组顺序就是渲染顺序**：常买恒在前，一次性恒在后。
 *
 * 这个常量存在的唯一目的是让「置顶」这件事**只有一个真源**：
 * 界面按它 `map`，断言按它比对。如果有人图省事在 JSX 里手写两块的先后，
 * 这条语义就有两份实现，改一处必然漏一处（本仓踩过的老坑）。
 */
export const CART_GROUPS = ['recurring', 'oneoff'];

/**
 * 常买商品的**预设数量**（老板说的「设定好数量」，设一次、以后每次都用它）。
 *
 * 取值的唯一来源是清单条目的 `qty`（CSV 列名「每次补货数量」）。
 * `null` / `''` / 非数字 / `< 1` 一律兜到 `1`：
 *   · 兜到 `1` 而不是 `0` —— 「补 0 件」在补货单里没有意义，且会让合计少算一笔还不留痕；
 *   · 兜到 `1` 而不是 `null` —— 预设必须是可执行的数量，`null` 没法直接下单。
 * 小数向上取整，与 `computeNeedQty` / `parseQtyInput` 同口径（宁可多买一件）。
 *
 * @param {object} sub 常买清单条目
 * @returns {number} ≥ 1 的整数
 */
export function presetQtyOf(sub) {
  const n = toMoney(sub && typeof sub === 'object' ? sub.qty : null);
  if (n === null || n < 1) return 1;
  return Math.ceil(n);
}

/**
 * 改一条常买商品的预设数量（老板的「设定好数量」，改完要能存下来）。
 *
 * 合法性判断**复用 `parseQtyInput`**，不在这里再写一遍：
 * 两处各写一份「什么算合法数量」就是「改口径只改一处」的老坑。
 * 非法输入 **不写库、不改清单**，把原因原样返回给界面 ——
 * 「原来那个值还在」比「静默变成 0 / NaN」安全得多。
 *
 * @param {Array} subsList 常买清单
 * @param {string} key 条目键
 * @param {*} raw 界面给的原始输入
 * @returns {{ok:boolean, next:Array, error:string, value:number|null, changed:boolean}}
 *   `next` 是**新数组**（不改入参；没改成时原样返回同一份内容）
 */
export function withPresetQty(subsList, key, raw) {
  const list = Array.isArray(subsList) ? subsList : [];
  const k = String(key === null || key === undefined ? '' : key);
  const parsed = parseQtyInput(raw);
  if (!parsed.ok) {
    return { ok: false, next: list, error: parsed.error, value: null, changed: false };
  }
  let changed = false;
  const next = list.map((s) => {
    if (!s || typeof s !== 'object' || String(s.key) !== k) return s;
    if (presetQtyOf(s) === parsed.value) return s;
    changed = true;
    return { ...s, qty: parsed.value };
  });
  return { ok: true, next, error: '', value: parsed.value, changed };
}

/**
 * **一键按预设补货**（老板那句「每次要补货的时候只要点一下就行了」）。
 *
 * 语义只有一句：把**全部常买**按各自的预设数量一次性放进补货清单，
 * 中间**不弹二次确认**、不需要再逐件点「加入清单」。
 *
 * 返回 `{ keys, qtyMap }` 而不是直接改 state，是为了让它可单测：
 * `keys` 交给 `setSelected`，`qtyMap` 合进 `setQtyDraft`，一次 state 更新完成。
 *
 * ⚠️ `keys` 的**顺序与清单顺序一致**，不是按 key 排序 ——
 *   清单是用户自己排的（CSV 里的行序），一键补货后清单里的先后不该变。
 *
 * @param {Array} subsList 常买清单
 * @returns {{keys:string[], qtyMap:object, count:number}}
 */
export function buildPresetPick(subsList) {
  const list = (Array.isArray(subsList) ? subsList : []).filter((s) => s && typeof s === 'object' && s.name);
  const keys = [];
  const qtyMap = {};
  list.forEach((s) => {
    const key = String(s.key === null || s.key === undefined ? '' : s.key);
    if (!key) return;
    // 同一 key 在清单里出现两次时只补一次（后一条覆盖前一条的数量，与 `readSubs` 的"先出现"语义不冲突：
    // 那种脏数据本来就不该存在，这里只保证"不会补两遍"）
    if (Object.prototype.hasOwnProperty.call(qtyMap, key)) {
      qtyMap[key] = presetQtyOf(s);
      return;
    }
    keys.push(key);
    qtyMap[key] = presetQtyOf(s);
  });
  return { keys, qtyMap, count: keys.length };
}

/**
 * 第二页「补货清单」（购物车）的**唯一取数口径**：分组 + 行模型 + 合计。
 *
 * 分组判据只有一条：**这个 key 在不在常买清单里**。
 *   · 在 ⇒ `recurring`（常买组，永远置顶）
 *   · 不在 ⇒ `oneoff`（一次性组，永远排在后面）
 * 为什么不用"用户点的是哪个按钮"来判断：同一个商品可能今天从搜索加、明天从常买勾，
 * 用按钮来源记分组会让同一件商品在两次操作里落到不同组 —— 分组必须是**商品的属性**，不是操作路径。
 *
 * key 天然不相交，靠的是两套前缀：常买条目 `sub:<slug(name)>`（`buildSubItem`），
 * 商城商品 `<productId>` 或 `slug(name)`（`normalizeProduct`）。所以按 key 归属不会误判。
 *
 * 价格口径与第一页表格**完全一致**：只认 `discountPrice`（现价），缺失/价格隐藏 ⇒ `null`
 * ⇒ 界面写「价格待定」、`amount` 也 `null`（**不是 0 元**：0 元会让合计少算一笔却不留痕）。
 *
 * @param {Array<string>} picked 已挑中的常买键
 * @param {Array} subs 常买清单
 * @param {object} [stockMap] `{ [subKey]: ShopProduct }`
 * @param {object} [qtyMap] `{ [key]: number }` 用户改过的数量（常买 / 一次性共用一个草稿表，key 不冲突）
 * @param {Array} [oneOff] 一次性商品（已归一化的 ShopProduct[]）
 * @returns {{recurring:Array, oneoff:Array, all:Array, summary:object, counts:object}}
 */
export function buildCartModel(picked, subs, stockMap, qtyMap, oneOff) {
  const pickSet = new Set(
    (Array.isArray(picked) ? picked : [])
      .map((k) => String(k === null || k === undefined ? '' : k))
      .filter(Boolean),
  );
  const subList = (Array.isArray(subs) ? subs : []).filter((s) => s && typeof s === 'object' && s.name);
  const presetByKey = {};
  subList.forEach((s) => {
    presetByKey[String(s.key)] = presetQtyOf(s);
  });

  // 常买组：只保留「这次被挑中的」，顺序跟随清单顺序（清单是用户自己排的，不重排）
  const recurring = buildReplenishRows(subList, stockMap, qtyMap)
    .filter((r) => pickSet.has(String(r.key)))
    .map((r) => ({
      ...r,
      group: CART_GROUPS[0],
      preset: presetByKey[String(r.key)] || 1,
      isOneOff: false,
    }));

  // 一次性组：不在常买清单里的商品
  const once = (Array.isArray(oneOff) ? oneOff : [])
    .filter((p) => p && typeof p === 'object' && p.name)
    .map((p) => {
      const key = String(p.key === null || p.key === undefined ? '' : p.key);
      // 与 `buildReplenishRows` 同口径：只认现价，缺失 ⇒ null（价格待定），不拿原价冒充现价
      const price =
        p.discountPrice === null || p.discountPrice === undefined ? null : toMoney(p.discountPrice);
      const drafted = parseQtyInput(qtyMap && typeof qtyMap === 'object' ? qtyMap[key] : null);
      const need = drafted.ok ? drafted.value : 1;
      return {
        key,
        name: String(p.name),
        spec: '',
        brand: '',
        product: p,
        hasStock: normalizeHasStock(p.hasStock),
        price,
        need,
        amount: price === null ? null : Math.round(price * need * 100) / 100,
        group: CART_GROUPS[1],
        preset: null, // 一次性商品没有预设（它本来就不在常买清单里）
        isOneOff: true,
      };
    })
    // 同一件商品被加两次时只留一条（数量以草稿为准），否则合计会被重复计算
    .filter((r, i, arr) => arr.findIndex((x) => x.key === r.key) === i)
    // 与常买清单里已有的商品撞 key 时，归常买组（宁可少一条一次性，也不要同一件货算两笔钱）
    .filter((r) => !Object.prototype.hasOwnProperty.call(presetByKey, r.key));

  const all = recurring.concat(once);
  const summary = summarizeReplenishOrder(all);
  return {
    recurring,
    oneoff: once,
    all,
    summary,
    counts: {
      recurring: recurring.length,
      oneoff: once.length,
      total: all.length,
      totalQty: summary.totalQty,
    },
  };
}

/**
 * 并发受限的批量执行器（**部分成功**语义）。
 *
 * 老板的诉求是「不要让用户点 10 次」。10 件商品串行查（`await` 一个再下一个）在真实
 * 网络下就是 10 个来回，用户盯着一个转圈；全量并发又会被上游频控（本仓既有注释记着
 * 「并发 10 个只会更快被拦」）。所以取中间的 `limit`（组件传 3）：比串行快数倍，
 * 又不至于一次打满。
 *
 * 三条纪律：
 *   · **单件失败不影响其它件**：`worker` 抛错只记在该位，其余照跑（`results[i].ok === false`）；
 *   · **结果顺序与入参一致**（按 index 落位，不是「谁先回来谁在前」）—— 否则表格行会跳；
 *   · `limit` 非法 / 大于总数 ⇒ 归一到 `[1, list.length]`，绝不允许 0 或 `NaN`
 *     （0 会让 `Promise.all([])` 直接返回，`results` 全是空洞 —— 静默空过）。
 *
 * @template T
 * @param {Array<T>} list 待处理项
 * @param {number} limit 并发上限
 * @param {(item:T, index:number)=>Promise<any>} worker 单项处理逻辑
 * @returns {Promise<{results:Array<{ok:boolean, value:any, error:string}>, okCount:number, failCount:number}>}
 */
export async function mapWithConcurrency(list, limit, worker) {
  const arr = Array.isArray(list) ? list : [];
  const rawLimit = toMoney(limit);
  const room = arr.length;
  const lanes = Math.max(1, Math.min(rawLimit === null ? 1 : Math.floor(rawLimit), room || 1));
  const results = new Array(room);
  let cursor = 0;
  const pump = async () => {
    // 每条「车道」自己抢号：`cursor` 是唯一的共享游标，先抢到先跑 ⇒ 天然限流且不重不漏
    while (cursor < room) {
      const i = cursor;
      cursor += 1;
      try {
        const value = await worker(arr[i], i);
        results[i] = { ok: true, value, error: '' };
      } catch (e) {
        results[i] = { ok: false, value: null, error: (e && e.message) || String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  const okCount = results.filter((r) => r && r.ok === true).length;
  return { results, okCount, failCount: room - okCount };
}

/**
 * 切一行 CSV（支持双引号包裹，`""` 转义）。
 * 不用正则一把梭：引号里的逗号一旦被切错，错误会以「列数不对」的形式出现在很远的地方。
 * @param {string} line 单行
 * @returns {string[]} 字段数组
 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** CSV 表头 → 内部字段名（按列名取值，顺序可变）。 */
const CSV_COLUMNS = {
  name: 'name',
  商品名称: 'name',
  spec: 'spec',
  规格: 'spec',
  brand: 'brand',
  品牌: 'brand',
  maxprice: 'maxPrice',
  最高可接受单价: 'maxPrice',
  最高单价: 'maxPrice',
  qty: 'qty',
  每次补货数量: 'qty',
  数量: 'qty',
};

/**
 * 由一行表单数据构造常购清单条目（`key` 由 `name` 派生，同名视为同一行）。
 * @param {{name?:*, spec?:*, brand?:*, maxPrice?:*, qty?:*, addedAt?:*}} input
 * @returns {object|null} `null` = name 为空
 */
export function buildSubItem(input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = String(i.name === null || i.name === undefined ? '' : i.name).trim();
  if (!name) return null;
  return {
    key: 'sub:' + slug(name),
    name,
    spec: String(i.spec === null || i.spec === undefined ? '' : i.spec).trim(),
    brand: String(i.brand === null || i.brand === undefined ? '' : i.brand).trim(),
    maxPrice: toMoney(i.maxPrice),
    qty: toMoney(i.qty),
    addedAt: Number.isFinite(Number(i.addedAt)) ? Number(i.addedAt) : Date.now(),
  };
}

/**
 * 解析常购清单 CSV（AC-3.10/3.11）。
 *
 * 契约：
 *   · UTF-8，允许 BOM（首列剥 `\ufeff`）；
 *   · 表头固定语义、**按列名取值，顺序可变**：`name`（必填）/ `spec` / `brand` / `maxPrice` / `qty`；
 *   · 缺 `name` 列 ⇒ `{ok:false}`，**一个字都不写**；
 *   · 空行 / 全空行跳过；`maxPrice` 非数字 ⇒ `null`（**不产生 NaN**）；
 *   · 同 `slug(name)` 视为同一行，重复不再加（保留先出现的那条）。
 *
 * ⚠️ 只接受 `.csv`：`main.js` 的 `file:readText` 用 `buf.toString('utf8')`，
 *    xlsx 是 ZIP 二进制，读出来是乱码 —— 扩展名拦截在组件层做（本函数只吃文本）。
 *
 * @param {string} text CSV 全文
 * @returns {{ok:boolean, items:Array, skipped:number, error?:string}}
 */
export function parseSubsCsv(text) {
  const raw = String(text === null || text === undefined ? '' : text);
  if (!raw.trim()) return { ok: false, items: [], skipped: 0, error: '这份表格是空的' };
  // 只剥**首个字符**的 BOM：`trim()` 不会去掉它，留着会让首列表头变成 '\ufeffname' 而匹配不上
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = body.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { ok: false, items: [], skipped: 0, error: '这份表格是空的' };

  const header = splitCsvLine(lines[0]).map((h) => String(h).replace(/^\ufeff/, '').trim());
  const colIndex = {};
  header.forEach((h, i) => {
    const key = CSV_COLUMNS[h.toLowerCase()] || CSV_COLUMNS[h];
    if (key && colIndex[key] === undefined) colIndex[key] = i;
  });
  if (colIndex.name === undefined) {
    return { ok: false, items: [], skipped: 0, error: '表格缺少「商品名称」列' };
  }

  const items = [];
  const seen = new Set();
  let skipped = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const pick = (k) => (colIndex[k] === undefined ? '' : String(cells[colIndex[k]] === undefined ? '' : cells[colIndex[k]]).trim());
    const item = buildSubItem({
      name: pick('name'),
      spec: pick('spec'),
      brand: pick('brand'),
      maxPrice: pick('maxPrice'),
      qty: pick('qty'),
    });
    if (!item) {
      skipped += 1;
      continue;
    }
    if (seen.has(item.key)) {
      skipped += 1;
      continue;
    }
    seen.add(item.key);
    items.push(item);
  }
  return { ok: true, items, skipped };
}

/**
 * 常购清单 ↔ 商城商品的三级匹配（Q5，**绝不猜**）。
 *   ① `slug(name)` 精确相等；
 *   ② `slug(清单name)` 被 `slug(商品name)` 包含，且**唯一命中**；
 *   ③ 都不中 ⇒ `null`（组件标 `data-rp-unmatched`「未匹配」，**不参与缺货/到货判定**）。
 *
 * 为什么第 ② 步要求「唯一」：包含式匹配天然会多命中
 *   （清单写「树脂」会命中「3M 树脂」「树脂 A2」「光固化树脂」）。多命中时随便挑一个 =
 *   替用户决定买哪家，那是编结论。宁可标「未匹配，点这里手动选」。
 *
 * @param {object} sub 常购清单条目
 * @param {Array} products 归一化后的商品列表
 * @returns {object|null} 命中的商品（第 ② 步多命中也返回 `null`）
 */
export function matchSubToProduct(sub, products) {
  const s = sub && typeof sub === 'object' ? sub : {};
  const list = (Array.isArray(products) ? products : []).filter((x) => x && x.name);
  const target = slug(s.name);
  if (!target) return null;

  // ① 精确
  const exact = list.filter((p) => slug(p.name) === target);
  if (exact.length) return exact[0];

  // ② 包含（唯一命中才算）
  const loose = list.filter((p) => slug(p.name).includes(target));
  if (loose.length === 1) return loose[0];
  return null;
}

/**
 * 到货判定（AC-3.14 / PRD Q3）：上一次快照 `hasStock === false` 且本次 `true` ⇒ 到货 +1。
 *
 * 三分法的处理（S11）：
 *   · 本次 `null`（未知）⇒ **不判到货**，且**保留上一轮快照**（不知道就不改记录，也不清零）；
 *   · 本次 `false` ⇒ 记 `false`（下一轮若转 `true` 就是到货）；
 *   · 本次 `true` 且上一轮 `false` ⇒ 到货（`at` 记为本次时间，并打上 `arrived: true`）。
 *
 * `arrived: true` 这个标记是给**侧栏红点**用的（`App.jsx` 只读不写）：
 *   红点数是「到货件数」，不是「在库件数」。如果只按 `hasStock === true` 数，
 *   第一轮就把全部在库商品报成「刚到货」——那是编数据。所以红点只数显式打标的记录，
 *   且一旦打标就**保留到用户看过为止**（即使中途又缺货，也不能悄悄抹掉那条「到过货」的提醒）。
 *
 * @param {object} prevMap 上一轮快照 `{ [key]: { hasStock, at, arrived? } }`
 * @param {Array} entries 本次结果 `[{ key, hasStock }]`
 * @param {number} [now] 本次时间戳，缺省 `Date.now()`
 * @returns {{arrived: string[], next: object, changed: boolean}}
 */
export function diffStock(prevMap, entries, now) {
  const prev = prevMap && typeof prevMap === 'object' ? prevMap : {};
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const next = {};
  const arrived = [];
  const changedKeys = new Set();

  // 先原样继承上一轮（本次没查到的 key 不凭空消失，否则「上一轮缺货、这轮没查」会被当成清零）
  Object.keys(prev).forEach((k) => {
    const p = prev[k];
    if (p && typeof p === 'object') {
      next[k] = {
        hasStock: p.hasStock === true,
        at: Number.isFinite(Number(p.at)) ? Number(p.at) : at,
        // 未读的到货标记要继承下去，否则「到货 → 本轮没查到」会把红点吞掉
        arrived: p.arrived === true,
      };
    }
  });

  (Array.isArray(entries) ? entries : []).forEach((e) => {
    if (!e || !e.key) return;
    const key = String(e.key);
    const now2 = normalizeHasStock(e.hasStock);
    if (now2 === null) return; // 未知：不判到货、不动快照
    const before = next[key];
    if (now2 === true && before && before.hasStock === false) {
      arrived.push(key);
      next[key] = { hasStock: true, at, arrived: true };
      changedKeys.add(key);
      return;
    }
    if (!before || before.hasStock !== now2) {
      // 库存状态变了但**不是**「缺货 → 有货」：保留原有到货标记，不清零、不新打标
      next[key] = { hasStock: now2, at, arrived: before ? before.arrived === true : false };
      changedKeys.add(key);
    }
  });

  return { arrived, next, changed: changedKeys.size > 0 };
}

/**
 * 数「到货红点」（S7 语义：**到货 SKU 件数**，不是总件数、不是缺货数）。
 * 只数 `at > seen` 的到货记录（水位之后）；`seen` 缺失 ⇒ 全部计入。
 *
 * @param {Array} arrived 本次到货的 key 列表
 * @param {object} nextMap 本次落库的快照
 * @param {number} seen 已读水位（ms）
 * @returns {number} 0 表示不渲染红点
 */
export function countArrived(arrived, nextMap, seen) {
  const list = Array.isArray(arrived) ? arrived : [];
  const map = nextMap && typeof nextMap === 'object' ? nextMap : {};
  const watermark = Number.isFinite(Number(seen)) ? Number(seen) : 0;
  return list.filter((k) => {
    const rec = map[k];
    if (!rec) return false;
    const at = Number(rec.at);
    return Number.isFinite(at) ? at > watermark : false;
  }).length;
}

// ---------------------------------------------------------------------------
// 存储读写（三个 key，全部 `{ [companyId]: ... }` 企业隔离）
// ---------------------------------------------------------------------------

/**
 * 安全读一个 `{ [companyId]: T }` 映射。`localStorage` 不可用 / 内容坏掉 ⇒ `{}`。
 * @param {string} key localStorage key
 * @returns {object}
 */
function readMap(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/**
 * 安全写一个 `{ [companyId]: T }` 映射里的单个企业条目。
 * 企业 id 缺失 ⇒ **不写库**（S10），返回 `false`。
 * @param {string} key localStorage key
 * @param {string} companyId
 * @param {*} value 该企业的值
 * @returns {boolean} 是否写入
 */
function writeMapEntry(key, companyId, value) {
  const cid = String(companyId === null || companyId === undefined ? '' : companyId).trim();
  if (!cid) return false;
  try {
    const map = readMap(key);
    map[cid] = value;
    window.localStorage.setItem(key, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读常购清单（按企业）。
 * @param {string} companyId
 * @returns {Array} `SubItem[]`（缺失 / 坏数据 ⇒ `[]`）
 */
export function readSubs(companyId) {
  const cid = String(companyId === null || companyId === undefined ? '' : companyId).trim();
  if (!cid) return [];
  const v = readMap(SUBS_KEY)[cid];
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && x.name) : [];
}

/**
 * 写常购清单（按企业）。企业 id 缺失 ⇒ 不写、返回 `false`。
 * @param {string} companyId
 * @param {Array} items SubItem[]
 * @returns {boolean}
 */
export function writeSubs(companyId, items) {
  return writeMapEntry(SUBS_KEY, companyId, Array.isArray(items) ? items : []);
}

/**
 * 读上一轮库存快照（按企业）。
 * @param {string} companyId
 * @returns {object} `{ [subKey]: { hasStock, at } }`
 */
export function readStockSnapshot(companyId) {
  const cid = String(companyId === null || companyId === undefined ? '' : companyId).trim();
  if (!cid) return {};
  const v = readMap(STOCK_KEY)[cid];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * 写本轮库存快照（按企业）。
 * @param {string} companyId
 * @param {object} snapshot `{ [subKey]: { hasStock, at } }`
 * @returns {boolean}
 */
export function writeStockSnapshot(companyId, snapshot) {
  return writeMapEntry(STOCK_KEY, companyId, snapshot && typeof snapshot === 'object' ? snapshot : {});
}

/**
 * 读到货红点已读水位（ms）。缺失 ⇒ `0`。
 * @param {string} companyId
 * @returns {number}
 */
export function readSeen(companyId) {
  const cid = String(companyId === null || companyId === undefined ? '' : companyId).trim();
  if (!cid) return 0;
  const v = readMap(SEEN_KEY)[cid];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/**
 * 写到货红点已读水位（进入「AI 补货」页即清零），并派发红点重算事件（S8）。
 * @param {string} companyId
 * @param {number} [now] 缺省 `Date.now()`
 * @returns {boolean} 是否写入
 */
export function markReplenishSeen(companyId, now) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const ok = writeMapEntry(SEEN_KEY, companyId, at);
  if (ok) dispatchNavDotsRefresh('replenish-seen');
  return ok;
}

/**
 * 红点上限归一（S7）：`> 99` 显示 `99+`；`<= 0` 不渲染（返回 `''`）。
 * @param {number} n
 * @returns {string} 可直接塞进 DOM 的文本（空串 = 不渲染）
 */
export function formatDot(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return v > DOT_MAX ? '99+' : String(Math.floor(v));
}

/**
 * 通知「红点该重算了」（S8）：组件之间不互相 import，只发 window 事件；
 * `App.jsx` 是唯一监听者与唯一计算方。
 * @param {string} [reason] 触发原因（仅调试用）
 */
export function dispatchNavDotsRefresh(reason) {
  try {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('douya:navdots-refresh', { detail: { reason: reason || '' } }));
  } catch {
    /* 非浏览器环境（单测）静默：红点刷新是增强，不是正确性前提 */
  }
}
