// 商城商品检索（主进程）—— 0.21.14 · 需求 3「AI 补货」的取数底座。
//
// 【为什么必须放主进程】(0.21.14 架构设计 §10.1 P2 / §9 V3)
//   `supplier.example.com` 实测：`OPTIONS` → 204 **零个** `access-control-*`；`POST` → 200 **同样无 ACAO**
//   ⇒ 渲染进程（`app://douya`）读不到响应体，只能主进程出网。
//   这与 `api.example.com`（会回显 `access-control-allow-origin: app://douya`）是**两个不同的结论**，
//   不许拿其中一个当另一个的证据。
//
// 【为什么不复用 connectors.js 的 shop-supplier-b】
//   那个连接器的 `login()` 恒返回「上游货源登录暂未开通」（`connectors.js:168-173`），
//   `tools` 只是声明、全仓无执行代码。本文件**只做 HTTP**，不碰任何连接器状态。
//
// 【只取 6 个字段】(0.21.14 架构设计 §3.2 / §10.3 第 6 条)
//   52 条真实样本实测：
//     · `marketPrice` 52/52 与 `price` 完全相等（不是「厂家建议价」，是拷贝）⇒ 整条丢弃；
//     · `discount` 52/52 恒 `0.0` ⇒ 不进模型；
//     · `isDiscount` 有反例（`price=3.2 / discountPrice=2.8` 却是 `false`）⇒ 不进排序；
//     · `standard` 52/52 为 `null`；`sellPartCount` 是销量不是库存；
//     · `picturePath` 全带未解占位符 `{0}` 且该域名取不到图。
//   `marketPrice` 在 `src/renderer/` 出现次数必须为 0（AC-3.6c 直接 grep 这条）——
//   所以本文件**也不返回它**：主进程多带一个字段，渲染层就多一次误用的机会。
//
// 容错底线（S11）：任何字段缺失 → `null` / `''`，**绝不 throw**（调用方拿到的永远是 `{ok}` 对象）。

'use strict';

/** 商城基址（可在 payload.baseURL 覆盖，仅用于联调；生产恒为默认值）。 */
const DEFAULT_BASE_URL = 'https://supplier.example.com';
/** 单次检索超时：8 秒（架构设计 §5 T01 第 3 条写死）。 */
const TIMEOUT_MS = 8000;
/** 单页上限（商城接口自身按 pageSize 截断，这里再兜一层，防上游忽略）。 */
const MAX_PAGE_SIZE = 50;

/** 上游错误码 → 用户可读中文（只映射语义，不回显原始 code 给用户）。 */
const RESULT_ID_LOGIN_EXPIRED = 1323;
const RESULT_ID_OK = 1200;

/**
 * 把任意输入归一成「有限数字」或 `null`。空串 / undefined / NaN / Infinity 一律 `null`。
 * 注意 `0` 是合法值（0 元、0 折扣都要能表达），不许被 `||` 吞掉。
 * @param {*} v 上游任意值
 * @returns {number|null}
 */
function toFiniteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 库存三分法归一（架构设计 §3.2「缺货判定」）。
 * 吃 `true` / `false` 两种布尔，以及 `'true'` / `'false'` / `'1'` / `'0'` / `1` / `0` 六种编码。
 * **缺失或无法识别 ⇒ `null`（未知），绝不 `!!v`** —— 那会把「不知道」谎报成「没货」。
 * @param {*} v 上游 hasStock
 * @returns {boolean|null}
 */
function normalizeHasStock(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null; // 未知：UI 显示「暂无数据」，既不参与同品类推荐，也不参与到货红点
}

/**
 * `isNotShowPrice` 归一：**显式为真才算隐藏**。
 * 实测该字段恒为字符串 `'0'`（52/52）。若写成 `v !== '0' → 隐藏`，
 * 字段一旦缺失（`undefined !== '0'` 为真）会把整批商品的价格全置空 —— 这是上一版踩过的坑。
 * @param {*} v 上游 isNotShowPrice
 * @returns {boolean}
 */
function normalizePriceHidden(v) {
  if (v === true) return true;
  return String(v === null || v === undefined ? '' : v).trim() === '1';
}

/**
 * 从上游原始商品对象里只挑 6 个字段，并做最小归一。
 * `name` 为空的商品**整条丢弃**（返回 `null`）—— 不渲染空行。
 * @param {object} raw 上游商品
 * @returns {object|null} `{ productId, name, price, discountPrice, hasStock, isNotShowPrice }`
 */
function pickProductFields(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name === null || raw.name === undefined ? '' : raw.name).trim();
  if (!name) return null;
  const productId = String(
    raw.productId === null || raw.productId === undefined ? (raw.id === null || raw.id === undefined ? '' : raw.id) : raw.productId,
  ).trim();
  return {
    productId,
    name,
    price: toFiniteNumber(raw.price),
    discountPrice: toFiniteNumber(raw.discountPrice),
    hasStock: normalizeHasStock(raw.hasStock),
    isNotShowPrice: normalizePriceHidden(raw.isNotShowPrice),
  };
}

/**
 * 从上游响应里尽力找出「商品数组」。
 * 上游 `data` 的形状没有公开文档（我们是通过 `connectors.js:184` 的连通性探针知道的），
 * 所以这里按候选键逐个试，找不到数组就返回空数组 —— **不猜数据结构之外的东西**。
 * @param {object} j 上游 JSON
 * @returns {Array}
 */
function extractProductList(j) {
  if (!j || typeof j !== 'object') return [];
  const data = j.data;
  const candidates = [
    j.products,
    j.list,
    j.records,
    j.rows,
    data && data.products,
    data && data.list,
    data && data.records,
    data && data.rows,
    data,
    j.result && j.result.list,
    j.result,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * 从上游响应里尽力读出「命中总数」（只用于 UI 显示与联调取证，缺失即 0）。
 * @param {object} j 上游 JSON
 * @returns {number}
 */
function extractTotalCount(j) {
  const data = j && j.data;
  const v = (j && j.totalCount) || (data && data.totalCount) || (j && j.total) || (data && data.total);
  const n = toFiniteNumber(v);
  return n === null ? 0 : n;
}

/**
 * 把网络层异常转成用户可读文案（脱敏：不回显 URL / 堆栈 / 上游原文）。
 * @param {Error} e 异常
 * @returns {string}
 */
function readableNetError(e) {
  const name = (e && e.name) || (e && e.cause && e.cause.name) || '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return '商城暂时没响应，稍后再试';
  }
  return '商城暂时没响应，稍后再试';
}

/**
 * 检索商城商品（免登录，`keyword` 必传 —— 不传上游返回空列表）。
 *
 * @param {object} [payload] 入参
 * @param {string} [payload.keyword] 关键词（必填）
 * @param {number} [payload.pageSize] 单页条数（默认 20，上限 50）
 * @param {number} [payload.pageIndex] 页码（从 1 开始）
 * @param {string} [payload.baseURL] 仅供联调覆盖，生产不要传
 * @returns {Promise<{ok:boolean, products?:Array, totalCount?:number, count?:number, error?:string, message?:string, kind?:string}>}
 *   失败时**只有** `{ok:false, error, message, kind}`，绝不抛异常、绝不返回上游原始报文。
 *   `kind` 只用于区分文案归属：`protocol`（协议/风控）vs `network`（超时/断网）——
 *   两者对用户说的话必须不一样，混成一句就等于把故障说成「没有商品」。
 */
async function searchProducts(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const keyword = String(p.keyword === null || p.keyword === undefined ? '' : p.keyword).trim();
  if (!keyword) return { ok: false, error: '请输入要搜索的商品名称' };
  const size = Math.min(Math.max(toFiniteNumber(p.pageSize) || 20, 1), MAX_PAGE_SIZE);
  const index = Math.max(toFiniteNumber(p.pageIndex) || 1, 1);
  const baseURL = String(p.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  let res;
  try {
    res = await fetch(baseURL + '/api/product/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // 免登录：绝不附加 Authorization
      body: JSON.stringify({ categoryId: '', pageSize: size, pageIndex: index, exts: [], orderBy: 0, keyword }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // `error` 是渲染层的既有读法；`message` 是 PRD AC-3.6b 断言 3 的写法。
    // 两个字段同值不冲突：调用方读哪个都能拿到同一句人话。
    const msg = readableNetError(e);
    return { ok: false, error: msg, message: msg, kind: 'network' };
  }

  const j = await res.json().catch(() => null);
  if (!j || typeof j !== 'object') {
    // 上游回了非 JSON（网关错误页 / 空体）：只透出 HTTP 状态码，不透出报文。
    // ⚠️ 文案与「超时」那条**必须分开**（AC-3.23 vs AC-3.24）：
    //    这里是「连上了但协议不对」⇒「查不到商品」；超时/断网才是「没响应」。
    //    把两种折成同一句，界面就没法把「故障」和「没有商品」分开说，
    //    而 PRD 要求这三种「没有」严格分层（暂无数据 / 当前没货 / 查不到）。
    return { ok: false, error: '商城暂时查不到商品，稍后再试', message: '商城暂时查不到商品，稍后再试', kind: 'protocol' };
  }

  const resultID = toFiniteNumber(j.resultID);
  if (resultID === RESULT_ID_LOGIN_EXPIRED) {
    return { ok: false, error: '登录已过期，请退出后重新登录' };
  }
  if (resultID !== RESULT_ID_OK) {
    // 其余错误码一律折成同一句可读文案；原始 code 不返回（避免用户看到无从处理的内部数字）。
    // 归属同上：这是**协议级失败**（风控 / 改版），不是超时 ⇒ 说「查不到商品」。
    return { ok: false, error: '商城暂时查不到商品，稍后再试', message: '商城暂时查不到商品，稍后再试', kind: 'protocol' };
  }

  const products = extractProductList(j).map(pickProductFields).filter(Boolean);
  return { ok: true, products, count: products.length, totalCount: extractTotalCount(j) };
}

module.exports = {
  searchProducts,
  // 导出纯函数供单测直接打桩（不经过网络）
  pickProductFields,
  normalizeHasStock,
  normalizePriceHidden,
  extractProductList,
  DEFAULT_BASE_URL,
  TIMEOUT_MS,
};
