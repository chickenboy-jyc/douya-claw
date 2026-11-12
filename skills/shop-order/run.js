// 加入购物车技能：调用上游货源商城（supplier.example.com）的加购接口。
// 真实接口（来自前端 bundle.js 反查）：
//   POST {base}/authapi/shoppingcart/addShoppingCart  body { goods:[{searchProductId,count,type:"",storeId}], isDeleteStockRegistration:false }
//   （fetchByAuth 默认拼 /authapi/ 前缀）
// 认证 token 由后端 skills.js 自动登录后注入 ctx.shop.token。
// 参数 goods：商品数组，每项 { searchProductId, count, type, storeId }。
function toObj(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

module.exports.run = async (params, ctx) => {
  if (!ctx.allowNetwork) throw new Error('网络调用未开启');
  const shop = ctx.shop || {};
  const baseURL = String(shop.baseURL || 'https://supplier.example.com').replace(/\/+$/, '');
  const token = String(shop.token || '').trim();
  if (!token) return '错误：商城未登录，无法加购。请在设置里填「商城账号」和「商城密码」。';

  const goods = Array.isArray(params.goods) ? params.goods : toObj(params.goods);
  if (!Array.isArray(goods) || goods.length === 0) {
    return '错误：购物车商品为空。请先查商品拿到 searchProductId，再确认要加购的商品和数量。';
  }
  // 规范化为商城字段（对齐前端真实结构）：{ searchProductId, count, type:"", storeId }
  // 前端 addShoppingCart 实际只传这 4 个字段，type 是空字符串而非 "0"
  const items = goods.map((g) => ({
    searchProductId: String(g.searchProductId || g.productId || g.id || '').trim(),
    count: Number(g.count || g.quantity || 1),
    type: String(g.type || ''),
    storeId: g.storeId != null ? String(g.storeId) : '',
  }));
  const url = baseURL + '/authapi/shoppingcart/addShoppingCart';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DouyaClaw/0.1.1',
    Accept: 'application/json',
    Authorization: token,
  };
  const body = { goods: items, isDeleteStockRegistration: false };
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
      return '加入购物车失败（resultID=' + j.resultID + '）：' + (j.message || '无更多信息');
    }
    return JSON.stringify({ isSuccess: true, message: '已加入购物车', data: j.data }, null, 2);
  } catch (e) {
    return '加入购物车失败：' + e.message;
  }
};
