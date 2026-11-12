// AI 曝光对比技能：调用自建后端（api.example.com）的曝光对比接口。
// 接口契约（已冻结）：
//   POST /api/geo/exposure            {company_id, competitor_names:[], ai_platforms:[]} -> {ok:true, report_id, result:{...}, conclusion:"..."}
//   GET  /api/geo/exposure/reports?company_id= -> {ok:true, reports:[...]}
// 认证：Authorization: Bearer <token>，token 由 skills.js 注入 ctx.geo.token。
const NOT_CONNECTED = '请先在设置里连接自建后端';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function toArr(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(String(v));
    return Array.isArray(o) ? o : [];
  } catch {
    return [];
  }
}

module.exports.run = async (params, ctx) => {
  if (!ctx.allowNetwork) throw new Error('网络调用未开启');
  const geo = ctx.geo || {};
  const baseURL = String(geo.baseURL || 'https://api.example.com').replace(/\/+$/, '');
  const token = String(geo.token || '').trim();
  if (!token) return NOT_CONNECTED;

  const action = (str(params.action) || 'run').toLowerCase();
  const companyId = str(params.company_id);
  if (!companyId) return '错误：请提供 company_id（先调「注册/编辑公司」注册公司）。';

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
  };

  try {
    // 报告列表：GET /api/geo/exposure/reports?company_id=
    if (action === 'reports') {
      const url = baseURL + '/api/geo/exposure/reports?company_id=' + encodeURIComponent(companyId);
      const res = await fetch(url, { method: 'GET', headers, signal: ctx.signal });
      const j = await res.json().catch(() => null);
      if (!j) return '获取曝光报告列表失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (j.ok !== true && j.detail) return '获取曝光报告列表失败：' + j.detail;
      const reports = Array.isArray(j.reports) ? j.reports : (Array.isArray(j) ? j : []);
      return JSON.stringify({ ok: true, count: reports.length, reports }, null, 2).slice(0, 12000);
    }

    // 默认 run：POST /api/geo/exposure
    const body = {
      company_id: companyId,
      competitor_names: toArr(params.competitor_names),
      ai_platforms: toArr(params.ai_platforms),
    };
    const res = await fetch(baseURL + '/api/geo/exposure', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j) return 'AI 曝光对比失败（HTTP ' + res.status + '）';
    if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
    if (res.status === 403) return '无权使用该公司：' + ((j && j.detail) || 'company_id 不属于当前用户');
    if (j.ok !== true && j.detail) return 'AI 曝光对比失败：' + j.detail;
    return JSON.stringify(j, null, 2).slice(0, 16000);
  } catch (e) {
    return 'AI 曝光对比失败：' + e.message;
  }
};
