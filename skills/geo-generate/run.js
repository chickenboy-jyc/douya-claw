// 生成 GEO 内容技能：调用自建后端（api.example.com）的 GEO 生成接口。
// 接口契约（已冻结）：POST /api/geo/generate，请求体 = 原字段 + company_id（必填）。
//   company_id 由后端查 companies 拿档案，brand 字段仍返回兼容。
// 认证：Authorization: Bearer <token>，token 由 skills.js 注入 ctx.geo.token。
// 响应：成功 {ok:true, content, article_id, ...}，失败 {detail:"..."}。
const NOT_CONNECTED = '请先在设置里连接自建后端';

function str(v) {
  return v == null ? '' : String(v).trim();
}

module.exports.run = async (params, ctx) => {
  if (!ctx.allowNetwork) throw new Error('网络调用未开启');
  const geo = ctx.geo || {};
  const baseURL = String(geo.baseURL || 'https://api.example.com').replace(/\/+$/, '');
  const token = String(geo.token || '').trim();
  if (!token) return NOT_CONNECTED;

  const companyId = str(params.company_id);
  if (!companyId) return '错误：请先注册公司拿到 company_id，再生成 GEO 内容（可先调「注册/编辑公司」）。';

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
  };

  // 透传请求体：company_id 必填，其余字段原样带上（topic/content_type/platform/account_name 等）
  const body = { ...params, company_id: companyId };

  try {
    const res = await fetch(baseURL + '/api/geo/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // 透传外部叫停信号（用户点「停止」/ 外层超时都会 abort 它）⇒ 技能内挂起的请求可被即时取消
      signal: ctx.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j) return '生成 GEO 内容失败（HTTP ' + res.status + '）';
    if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
    if (res.status === 403) return '无权使用该公司：' + ((j && j.detail) || 'company_id 不属于当前用户');
    if (j.ok !== true && j.detail) return '生成 GEO 内容失败：' + j.detail;
    return JSON.stringify(j, null, 2).slice(0, 16000);
  } catch (e) {
    return '生成 GEO 内容失败：' + e.message;
  }
};
