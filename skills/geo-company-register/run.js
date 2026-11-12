// 注册/编辑公司技能：调用自建后端（api.example.com）的公司 CRUD 接口。
// 接口契约（已冻结）：
//   POST   /api/companies            建公司  body {canonical_entity, entity_type, industry, core_associations[], target_audience[], forbidden_claims[], brand_desc}
//   GET    /api/companies            列公司（自动按当前用户过滤）
//   GET    /api/companies/{id}       公司详情
//   PUT    /api/companies/{id}       编辑公司（部分字段可省略）
//   DELETE /api/companies/{id}       删除公司
// 认证：Authorization: Bearer <token>（必须带 Bearer 前缀），token 由 skills.js 注入 ctx.geo.token。
// 响应：成功 {ok:true, ...}，失败 {detail:"..."}。
const NOT_CONNECTED = '请先在设置里连接自建后端';

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

function str(v) {
  return v == null ? '' : String(v).trim();
}

module.exports.run = async (params, ctx) => {
  if (!ctx.allowNetwork) throw new Error('网络调用未开启');
  const geo = ctx.geo || {};
  const baseURL = String(geo.baseURL || 'https://api.example.com').replace(/\/+$/, '');
  const token = String(geo.token || '').trim();
  if (!token) return NOT_CONNECTED;

  const action = (str(params.action) || 'create').toLowerCase();
  const companyId = str(params.company_id || params.id);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
  };

  try {
    // 列表：GET /api/companies
    if (action === 'list') {
      const res = await fetch(baseURL + '/api/companies', { method: 'GET', headers, signal: ctx.signal });
      const j = await res.json().catch(() => null);
      if (!j) return '获取公司列表失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (j.ok !== true && j.detail) return '获取公司列表失败：' + j.detail;
      const companies = Array.isArray(j.companies) ? j.companies : (Array.isArray(j) ? j : []);
      return JSON.stringify({ ok: true, count: companies.length, companies }, null, 2).slice(0, 12000);
    }

    // 详情：GET /api/companies/{id}
    if (action === 'get') {
      if (!companyId) return '错误：请提供 company_id（先 action=list 查列表拿公司 ID）。';
      const res = await fetch(baseURL + '/api/companies/' + encodeURIComponent(companyId), { method: 'GET', headers, signal: ctx.signal });
      const j = await res.json().catch(() => null);
      if (!j) return '获取公司详情失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (res.status === 403) return '无权访问该公司：' + ((j && j.detail) || 'company_id 不属于当前用户');
      if (j.ok !== true && j.detail) return '获取公司详情失败：' + j.detail;
      return JSON.stringify({ ok: true, company: j.company || j }, null, 2).slice(0, 12000);
    }

    // 编辑：PUT /api/companies/{id}
    if (action === 'update') {
      if (!companyId) return '错误：请提供 company_id（先 action=list 查列表拿公司 ID）。';
      const body = {};
      if (str(params.canonical_entity)) body.canonical_entity = str(params.canonical_entity);
      if (str(params.entity_type)) body.entity_type = str(params.entity_type);
      if (str(params.industry)) body.industry = str(params.industry);
      if (str(params.brand_desc)) body.brand_desc = str(params.brand_desc);
      if (params.core_associations != null) body.core_associations = toArr(params.core_associations);
      if (params.target_audience != null) body.target_audience = toArr(params.target_audience);
      if (params.forbidden_claims != null) body.forbidden_claims = toArr(params.forbidden_claims);
      const res = await fetch(baseURL + '/api/companies/' + encodeURIComponent(companyId), {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      const j = await res.json().catch(() => null);
      if (!j) return '编辑公司失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (res.status === 403) return '无权编辑该公司：' + ((j && j.detail) || 'company_id 不属于当前用户');
      if (j.ok !== true && j.detail) return '编辑公司失败：' + j.detail;
      return JSON.stringify({ ok: true, company: j.company || j }, null, 2).slice(0, 12000);
    }

    // 删除：DELETE /api/companies/{id}
    if (action === 'delete') {
      if (!companyId) return '错误：请提供 company_id（先 action=list 查列表拿公司 ID）。';
      const res = await fetch(baseURL + '/api/companies/' + encodeURIComponent(companyId), { method: 'DELETE', headers, signal: ctx.signal });
      const j = await res.json().catch(() => null);
      if (!j) return '删除公司失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (res.status === 403) return '无权删除该公司：' + ((j && j.detail) || 'company_id 不属于当前用户');
      if (j.ok !== true && j.detail) return '删除公司失败：' + j.detail;
      return JSON.stringify({ ok: true, message: '公司已删除', company_id: companyId }, null, 2);
    }

    // 默认 create：POST /api/companies
    const canonicalEntity = str(params.canonical_entity);
    if (!canonicalEntity) return '错误：注册公司需要提供 canonical_entity（公司标准名）。';
    const body = {
      canonical_entity: canonicalEntity,
      entity_type: str(params.entity_type),
      industry: str(params.industry),
      core_associations: toArr(params.core_associations),
      target_audience: toArr(params.target_audience),
      forbidden_claims: toArr(params.forbidden_claims),
      brand_desc: str(params.brand_desc),
    };
    const res = await fetch(baseURL + '/api/companies', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j) return '注册公司失败（HTTP ' + res.status + '）';
    if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
    if (j.ok !== true && j.detail) return '注册公司失败：' + j.detail;
    return JSON.stringify({ ok: true, company: j.company || j }, null, 2).slice(0, 12000);
  } catch (e) {
    return '公司操作失败：' + e.message;
  }
};
