// 口碑监测技能：调用自建后端（api.example.com）的危机/口碑接口。
// 接口契约（已冻结）：
//   POST  /api/crisis/analyze        原字段 + company_id -> 分析一条舆情，返回公开回复+私信回复建议
//   GET   /api/crisis/list?company_id=&level=&status=&limit= -> {ok:true, items:[...]}
//   GET   /api/crisis/trend?company_id=&days=30 -> {ok:true, trend:[...], level_dist:{...}}
//   PATCH /api/crisis/{id}/status    {status:"handled"} -> {ok:true}
// 认证：Authorization: Bearer <token>，token 由 skills.js 注入 ctx.geo.token。
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

  const action = (str(params.action) || 'analyze').toLowerCase();
  const companyId = str(params.company_id);
  if (!companyId) return '错误：请提供 company_id（先调「注册/编辑公司」注册公司）。';

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
  };

  try {
    // 清单：GET /api/crisis/list?company_id=&level=&status=&limit=
    if (action === 'list') {
      const q = new URLSearchParams({ company_id: companyId });
      if (str(params.level)) q.set('level', str(params.level));
      if (str(params.status)) q.set('status', str(params.status));
      const limit = Number(params.limit) > 0 ? Number(params.limit) : 50;
      q.set('limit', String(limit));
      const res = await fetch(baseURL + '/api/crisis/list?' + q.toString(), { method: 'GET', headers, signal: ctx.signal });
      const j = await res.json().catch(() => null);
      if (!j) return '获取危机清单失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (j.ok !== true && j.detail) return '获取危机清单失败：' + j.detail;
      const items = Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : []);
      return JSON.stringify({ ok: true, count: items.length, items }, null, 2).slice(0, 12000);
    }

    // 趋势：GET /api/crisis/trend?company_id=&days=30
    if (action === 'trend') {
      const days = Number(params.days) > 0 ? Number(params.days) : 30;
      const q = new URLSearchParams({ company_id: companyId, days: String(days) });
      const res = await fetch(baseURL + '/api/crisis/trend?' + q.toString(), { method: 'GET', headers, signal: ctx.signal });
      const j = await res.json().catch(() => null);
      if (!j) return '获取舆情趋势失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (j.ok !== true && j.detail) return '获取舆情趋势失败：' + j.detail;
      return JSON.stringify(j, null, 2).slice(0, 12000);
    }

    // 标记已处理：PATCH /api/crisis/{id}/status
    if (action === 'status') {
      const crisisId = str(params.crisis_id || params.id);
      if (!crisisId) return '错误：status 需要提供 crisis_id（危机记录 ID，从 list 结果里拿）。';
      const body = { status: str(params.status) || 'handled' };
      const res = await fetch(baseURL + '/api/crisis/' + encodeURIComponent(crisisId) + '/status', {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      const j = await res.json().catch(() => null);
      if (!j) return '更新危机状态失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (res.status === 403) return '无权操作该危机：' + ((j && j.detail) || '记录不属于当前用户');
      if (j.ok !== true && j.detail) return '更新危机状态失败：' + j.detail;
      return JSON.stringify({ ok: true, crisis_id: crisisId, status: body.status }, null, 2);
    }

    // 默认 analyze：POST /api/crisis/analyze
    const postText = str(params.post_text);
    if (!postText) return '错误：analyze 需要提供 post_text（舆情正文）。';
    const body = { ...params, company_id: companyId, post_text: postText };
    const res = await fetch(baseURL + '/api/crisis/analyze', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j) return '舆情分析失败（HTTP ' + res.status + '）';
    if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
    if (res.status === 403) return '无权使用该公司：' + ((j && j.detail) || 'company_id 不属于当前用户');
    if (j.ok !== true && j.detail) return '舆情分析失败：' + j.detail;
    return JSON.stringify(j, null, 2).slice(0, 16000);
  } catch (e) {
    return '口碑监测操作失败：' + e.message;
  }
};
