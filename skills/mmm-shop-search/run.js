// 查询商品技能：调用上游货源商城（supplier.example.com）真实接口。
// 真实接口（实测证据）：
//   POST {base}/api/product/list
//   body { categoryId:"", pageSize:24, pageIndex:1, exts:[], orderBy:0, keyword:"关键词" }
//   → 信封 { resultID, action, message, isSuccess, data:{ products:[商品...], totalCount } }
//   注意①：keyword **必传**（不传返回空列表）——为空时本技能**不发出站请求**，直接提示。
//   注意②：此接口**免登录**——完全不带 Authorization 也返回 resultID 1200（token 可选）。
//   注意③：resultID===1200 成功；resultID===1323 表示登录超时。
// 价格语义（极易搞错）：上游 price 与 marketPrice **两者都是原价**，discountPrice 才是**折后价**。
//   对外统一表达为 listPrice（原价）与 netPrice（折后价）；
//   **绝不把 marketPrice 作为输出键**（对外只给 listPrice / netPrice）。
//   注：读取上游 marketPrice 是**正确的业务逻辑**（原价缺失时回落），故源码中用正常字面量读取；
//       红线只约束**输出对象**——其键集合绝不出现 marketPrice（由单测解析输出 JSON 断言）。
// orderBy 排序枚举：0=综合、1=销量(降序)、2=上架时间、3=价格（与 上游货源 一致）。
// 认证 token 由后端 skills.js 注入 ctx.shop.token，**可为空**（免登录）。

/**
 * 价格可见性判断。
 * 上游 isNotShowPrice 的**值是字符串 "0"**（表示"不隐藏价格"）。
 * 铁律：一律**显式字符串判等**，禁止布尔真值判断——否则数字 1 会被 `if (x)` 误判。
 * 字段缺省时视为可见（避免把正常商品误标为隐藏）。
 * @param {unknown} x isNotShowPrice 原始值
 * @returns {boolean}
 */
function isPriceVisible(x) {
  if (x == null) return true;
  return String(x) === '0';
}

/**
 * 把上游商品映射为对外精简字段（供模型使用）。
 * 只暴露 listPrice/netPrice，绝不透出上游原始价字段名。
 * @param {object} p 上游商品对象
 * @returns {{productId:(string|number), searchProductId:(string|number), productName:string, brandName:string, listPrice:(number|string), netPrice:(number|string), stock:(number|string), priceVisible:boolean, uniformCode:string}}
 */
function mapProduct(p) {
  const o = p || {};
  // 原价：price 优先，缺失时回落 marketPrice（二者都是原价，读它不是"透出"，是正确业务逻辑）
  const listPrice = o.price != null ? o.price : (o.marketPrice != null ? o.marketPrice : '');
  // 折后价
  const netPrice = o.discountPrice != null ? o.discountPrice : '';
  // 库存：优先 stock 字段；否则由 hasStock（布尔/字符串）翻译
  let stock = '';
  if (o.stock != null) stock = o.stock;
  else if (o.hasStock != null) {
    stock = (o.hasStock === true || o.hasStock === 'true') ? '有货'
      : ((o.hasStock === false || o.hasStock === 'false') ? '无货' : o.hasStock);
  }
  return {
    productId: o.productId != null ? o.productId : (o.id != null ? o.id : ''),
    searchProductId: o.searchProductId != null ? o.searchProductId : '', // 加购必填
    productName: o.productName || o.name || '',
    brandName: o.brandName || '',
    listPrice: listPrice,
    netPrice: netPrice,
    stock: stock,
    priceVisible: isPriceVisible(o.isNotShowPrice),
    uniformCode: o.uniformCode || '',
  };
}

module.exports.run = async (params, ctx) => {
  if (!ctx.allowNetwork) throw new Error('网络调用未开启');
  const shop = ctx.shop || {};
  const baseURL = String(shop.baseURL || 'https://supplier.example.com').replace(/\/+$/, '');
  const token = String(shop.token || '').trim(); // 免登录：可为空

  const keyword = String(params.keyword || '').trim();
  // keyword 必传：为空时**不发出站请求**，直接返回提示（避免"没结果"被误判为失败）。
  if (!keyword) {
    return '请先告诉我要查什么商品（关键词不能为空）。例如：「查一下牙膏」。';
  }

  // orderBy：销量(1)=导购默认；价格(3)、上架时间(2)、综合(0) 可显式指定
  const orderByRaw = params.orderBy != null ? Number(params.orderBy) : 1;
  const orderBy = [0, 1, 2, 3].indexOf(orderByRaw) >= 0 ? orderByRaw : 1;
  const ORDER_NAMES = { 0: '综合', 1: '销量', 2: '上架时间', 3: '价格' };
  const url = baseURL + '/api/product/list';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DouyaClaw/0.1.1',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = token; // 免登录：无 token 绝不附加 Authorization
  const body = {
    categoryId: '',
    pageSize: 24,
    pageIndex: 1,
    exts: [],
    orderBy: orderBy,
    keyword: keyword,
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    // signal 合成：技能自身 20s 超时 + 外部叫停（用户点「停止」/ 外层超时都会 abort ctx.signal），任一触发都能中止本次请求
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, ctrl.signal]) : ctrl.signal;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => null);
    if (!j) return 'HTTP ' + res.status + ' ' + url + '\n' + (await res.text()).slice(0, 2000);
    if (j.resultID === 1323) return '商城登录超时，请重新登录。';
    if (j.resultID !== 1200) {
      return '查询商品失败（resultID=' + j.resultID + '）：' + (j.message || '无更多信息');
    }
    const data = j.data;
    // 商品数组在 data.products（保留多形态兜底：list / 直接数组 / 单对象）
    let products = null;
    if (Array.isArray(data)) products = data;
    else if (data && Array.isArray(data.products)) products = data.products;
    else if (data && Array.isArray(data.list)) products = data.list;
    else if (data && Array.isArray(data.data)) products = data.data;
    else if (data) products = [data];

    // 精简成模型需要的字段：searchProductId（加购必填）、productId、名称、品牌、原价/折后价、库存
    const slim = (products || []).slice(0, 50).map(mapProduct);

    return JSON.stringify({
      isSuccess: true,
      sortBy: ORDER_NAMES[orderBy] || '综合',
      sortByDesc: orderBy === 1 ? '按销量从高到低' : (ORDER_NAMES[orderBy] || '综合'),
      keyword: keyword,
      count: slim.length,
      totalCount: (data && data.totalCount != null) ? data.totalCount : slim.length,
      products: slim,
    }, null, 2).slice(0, 12000);
  } catch (e) {
    return '查询商品失败：' + e.message;
  }
};

// 仅供单测直接验证价格映射与字符串陷阱（不影响技能运行时契约：run 为唯一入口）。
module.exports.__test = { mapProduct, isPriceVisible };
