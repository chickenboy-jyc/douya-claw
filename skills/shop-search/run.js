// 查询商品技能：调用上游货源商城（supplier.example.com）真实接口。
// 真实接口（2026-08-19 用真实账号实测 + 前端 bundle.js 反查确认）：
//   POST {base}/api/product/list
//   body { categoryId:"", pageSize:24, pageIndex:1, exts:[], orderBy:0, keyword:"关键词" }
//   → 返回 { resultID, data:{ products:[商品...], totalCount, linkCategories:[相关分类...] } }
//   注意：入参是 keyword 单数 + 必须带默认字段；缺默认字段或写成 keywords 复数会返回 1301。
//   商品数组在 data.products；商品字段：searchProductId(加购必填) / productId / name / price / discountPrice / hasStock / uniformCode。
// orderBy 排序枚举（bundle.js 反查确认）：0=综合排序、1=销量(降序)、2=上架时间、3=价格。
//   销售导购场景默认 orderBy=1（销量排序），直接返回卖得最好的商品。
//   商品列表本身不返回销量数字，但 orderBy=1 时返回的数组顺序就是销量从高到低。
// 认证 token 由后端 skills.js 自动登录后注入 ctx.shop.token。
// 返回统一格式：{ resultID, isSuccess, message, data }，resultID=1200 表示成功。
module.exports.run = async (params, ctx) => {
  if (!ctx.allowNetwork) throw new Error('网络调用未开启');
  const shop = ctx.shop || {};
  const baseURL = String(shop.baseURL || 'https://supplier.example.com').replace(/\/+$/, '');
  const token = String(shop.token || '').trim();
  if (!token) return '错误：商城未登录，无法查询商品。请在设置里填「商城账号」和「商城密码」。';

  const keyword = String(params.keyword || '').trim();
  // orderBy：销量(1)=导购默认，价格(3)、上架时间(2)、综合(0) 可显式指定
  const orderByRaw = params.orderBy != null ? Number(params.orderBy) : 1;
  const orderBy = [0, 1, 2, 3].indexOf(orderByRaw) >= 0 ? orderByRaw : 1;
  const ORDER_NAMES = { 0: '综合', 1: '销量', 2: '上架时间', 3: '价格' };
  const url = baseURL + '/api/product/list';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DouyaClaw/0.1.1',
    Accept: 'application/json',
    Authorization: token,
  };
  // 前端真实入参：keyword 单数 + 默认字段（缺了会返回 1301）
  const body = {
    categoryId: '',
    pageSize: 24,
    pageIndex: 1,
    exts: [],
    orderBy: orderBy,
    keyword: keyword || '',
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

    // 精简成 LLM 需要的字段：searchProductId（加购必填）、productId、名称、价格、库存
    const slim = (products || []).slice(0, 50).map((p) => ({
      productId: p.productId != null ? p.productId : (p.id != null ? p.id : ''),
      searchProductId: p.searchProductId != null ? p.searchProductId : '',
      productName: p.productName || p.name || '',
      standard: p.standard || '',
      price: p.price != null ? p.price : (p.discountPrice != null ? p.discountPrice : ''),
      discountPrice: p.discountPrice != null ? p.discountPrice : '',
      stock: p.hasStock != null ? (p.hasStock ? '有货' : '无货') : (p.stock != null ? p.stock : ''),
      producer: p.producer || '',
      storeId: p.storeId != null ? p.storeId : '',
    }));

    // 相关分类（linkCategories）：每个 { id, name }，用于「购买后搭配推荐」
    const linkCategories = (data && Array.isArray(data.linkCategories))
      ? data.linkCategories.map((c) => ({ id: c.id || '', name: c.name || c.title || '' })).filter((c) => c.name)
      : [];

    return JSON.stringify({
      isSuccess: true,
      sortBy: ORDER_NAMES[orderBy] || '综合',
      sortByDesc: orderBy === 1 ? '按销量从高到低' : (ORDER_NAMES[orderBy] || '综合'),
      keyword: keyword,
      count: slim.length,
      totalCount: (data && data.totalCount != null) ? data.totalCount : slim.length,
      linkCategories: linkCategories.slice(0, 30),
      products: slim,
    }, null, 2).slice(0, 12000);
  } catch (e) {
    return '查询商品失败：' + e.message;
  }
};
