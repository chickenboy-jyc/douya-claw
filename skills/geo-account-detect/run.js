// 账号人设检测技能：调用自建后端（api.example.com）的账号人设/抓取接口。
// 接口契约（已冻结）：
//   POST /api/accounts/detect   {company_id, account_name, account_desc} -> {ok:true, persona:{...}}
//   POST /api/accounts/scrape   {company_id, account_url, platform?} -> {ok:true, account:{...}} 或 {ok:false, error, suggest:"manual"}
//   GET  /api/accounts?company_id= -> {ok:true, personas:[...]}
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

  const action = (str(params.action) || 'detect').toLowerCase();
  const companyId = str(params.company_id);
  if (!companyId) return '错误：请提供 company_id（先调「注册/编辑公司」注册公司）。';

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
  };

  try {
    // 列表：GET /api/accounts?company_id=
    if (action === 'list') {
      const url = baseURL + '/api/accounts?company_id=' + encodeURIComponent(companyId);
      const res = await fetch(url, { method: 'GET', headers, signal: ctx.signal });
      const j = await res.json().catch(() => null);
      if (!j) return '获取人设列表失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (j.ok !== true && j.detail) return '获取人设列表失败：' + j.detail;
      const personas = Array.isArray(j.personas) ? j.personas : (Array.isArray(j) ? j : []);
      return JSON.stringify({ ok: true, count: personas.length, personas }, null, 2).slice(0, 12000);
    }

    // 链接抓取：POST /api/accounts/scrape
    if (action === 'scrape') {
      const accountUrl = str(params.account_url);
      if (!accountUrl) return '错误：scrape 需要提供 account_url（账号链接）。';
      const body = { company_id: companyId, account_url: accountUrl };
      if (str(params.platform)) body.platform = str(params.platform);
      const res = await fetch(baseURL + '/api/accounts/scrape', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
      const j = await res.json().catch(() => null);
      if (!j) return '账号链接抓取失败（HTTP ' + res.status + '）';
      if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
      if (j.ok !== true) {
        if (j.suggest === 'manual') {
          return '账号链接抓取失败：' + (j.error || '无法自动抓取') + '。建议改为手动填写账号名/粉丝/作品数据，或上传截图。';
        }
        return '账号链接抓取失败：' + (j.detail || j.error || '未知错误');
      }
      return JSON.stringify({ ok: true, account: j.account || j }, null, 2).slice(0, 12000);
    }

    // 默认 detect：POST /api/accounts/detect
    const accountName = str(params.account_name);
    if (!accountName) return '错误：detect 需要提供 account_name（账号名）。';
    const body = { company_id: companyId, account_name: accountName };
    if (str(params.account_desc)) body.account_desc = str(params.account_desc);
    const res = await fetch(baseURL + '/api/accounts/detect', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j) return '账号人设生成失败（HTTP ' + res.status + '）';
    if (res.status === 401) return '登录已过期：' + ((j && j.detail) || '请重新连接自建后端');
    if (j.ok !== true && j.detail) return '账号人设生成失败：' + j.detail;
    return JSON.stringify({ ok: true, persona: j.persona || j }, null, 2).slice(0, 12000);
  } catch (e) {
    return '账号人设操作失败：' + e.message;
  }
};
