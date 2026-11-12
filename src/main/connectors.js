// 连接器模块 —— 统一管理外部服务（商城、微信等）的连接与 token。
// 参考 Workbench 的「连接器」抽象：连接器 = 类型 + 授权方式 + 能力(tools) + 配置 + token。
// 支持两种授权方式：
//   - password：账号密码登录拿 token（如上游货源商城 supplier.example.com）
//   - oauth：OAuth2 授权码流程（如微信、第三方平台，通过 connectors.json 配置）
// 所有密钥/token 只存本机 userData，不外发。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REDIRECT_PATH = '/api/connectors/callback';
const STATE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 60 * 1000; // 商城 token 缓存 30 分钟

// ---- 连接器网络超时 ----
// 连接器层的 fetch（登录 / 业务查询 / OAuth token 交换）此前**全部没有超时**：
// 工作台/商城一旦不响应，getToken 会永久挂住 ⇒ 而 getToken 在 skills.js 的超时外壳**之外**被调用，
// 外壳在等"技能调用返回"、技能卡在登录上，两边一起死 —— manifest.timeoutMs 彻底沦为摆设。
// 这里按语义分档给每处 fetch 加单次超时：
const LOGIN_TIMEOUT_MS = 15000; // 登录是交互式操作：15 秒不起就该报错
const QUERY_TIMEOUT_MS = 20000; // 业务查询（商品列表 / 公司列表）稍宽
const TOKEN_TIMEOUT_MS = 15000; // 自定义连接器 tokenURL 换 token

// 供单测注入更短超时（生产不设 ⇒ 用上面档位）。避免单测真等 15 秒。
let _timeoutOverrideMs = 0;
function setConnectorTimeoutOverride(ms) {
  _timeoutOverrideMs = Number(ms) > 0 ? Number(ms) : 0;
}
function timeoutMsFor(fallback) {
  return _timeoutOverrideMs > 0 ? _timeoutOverrideMs : fallback;
}

// 把超时以 AbortSignal 形式挂到 fetch 上（node 20+ 支持 AbortSignal.timeout）。
function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

// 可读网络错误：把 "The operation was aborted due to timeout" / "fetch failed" 之类
// 原样丢给用户太含糊，转成能看懂的文案。AbortSignal.timeout 抛出的 err.name === 'TimeoutError'；
// undici 有时会把它包一层（TypeError: fetch failed，真正原因在 err.cause）⇒ 一并看 cause。
function readableNetError(e, ms) {
  const sec = ms / 1000;
  const shown = Number.isInteger(sec) ? String(sec) : String(Number(sec.toFixed(1)));
  const name = (e && e.name) || (e && e.cause && e.cause.name) || '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `连接超时（${shown} 秒），请检查工作台地址与网络`;
  }
  return (e && e.message) || String(e);
}

// ---- 极简 HS256 JWT（OAuth 回调 session 用）----
function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const data = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + sig;
}
function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    const data = h + '.' + p;
    const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    if (sig !== s) return null;
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
function makeSecret(dataDir) {
  return crypto.createHash('sha256').update('douya-claw::' + dataDir).digest('hex');
}

// ---- 连接器类型注册表 ----
// 每种类型声明：id / name / icon / description / authMethod / configFields / tools /
// 授权函数（login 用于 password，OAuth 用 authorizeURL/tokenURL）。
const CONNECTOR_TYPES = [
  {
    id: 'shop-supplier-a',
    name: '上游货源商城',
    icon: '🛒',
    description: '口腔 B2B 商城，语音查商品、加入购物车',
    authMethod: 'password',
    configFields: [
      { key: 'baseURL', label: '商城地址', type: 'text', default: 'https://supplier.example.com', required: true },
      { key: 'account', label: '账号', type: 'text', required: true },
      { key: 'password', label: '密码', type: 'password', required: true },
      { key: 'token', label: 'Token（可选，手动填）', type: 'password' },
    ],
    tools: [
      { id: 'shop-search', name: '查询商品' },
      { id: 'shop-order', name: '加入购物车' },
    ],
    // password 授权：账号密码调 /login 换 token（返回 data.token）
    async login(config) {
      const baseURL = String(config.baseURL || 'https://supplier.example.com').replace(/\/+$/, '');
      const account = String(config.account || '').trim();
      const password = String(config.password || '');
      if (!baseURL || !account || !password) return { ok: false, error: '缺少账号或密码' };
      const loginMs = timeoutMsFor(LOGIN_TIMEOUT_MS);
      try {
        // 前端 fetchPost 默认拼 /api/ 前缀：真实登录接口 = POST {base}/api/login
        const res = await fetch(baseURL + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userName: account, password, autoLogin: false }),
          signal: timeoutSignal(loginMs),
        });
        const j = await res.json().catch(() => null);
        if (j && j.resultID === 1200 && j.data && j.data.token) {
          return { ok: true, token: String(j.data.token) };
        }
        return { ok: false, error: (j && j.message) || ('登录失败 resultID=' + (j && j.resultID)) };
      } catch (e) {
        return { ok: false, error: readableNetError(e, loginMs) };
      }
    },
    // 测试连接：调一个轻量接口验证 token 是否有效
    async test(config, token) {
      const baseURL = String(config.baseURL || 'https://supplier.example.com').replace(/\/+$/, '');
      const queryMs = timeoutMsFor(QUERY_TIMEOUT_MS);
      try {
        // 前端 fetchPost 默认 /api/ 前缀；查商品列表用 product/list，入参是 keyword 单数 + 默认字段
        const res = await fetch(baseURL + '/api/product/list', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: token,
          },
          body: JSON.stringify({ categoryId: '', pageSize: 24, pageIndex: 1, exts: [], orderBy: 0 }),
          signal: timeoutSignal(queryMs),
        });
        const j = await res.json().catch(() => null);
        if (!j) return { ok: false, error: 'HTTP ' + res.status };
        if (j.resultID === 1323) return { ok: false, error: '登录超时，请重新登录' };
        if (j.resultID === 1200) return { ok: true };
        return { ok: false, error: 'resultID=' + j.resultID + ' ' + (j.message || '') };
      } catch (e) {
        return { ok: false, error: readableNetError(e, queryMs) };
      }
    },
  },
  {
    id: 'shop-supplier-b',
    name: '上游货源商城',
    icon: '🛒',
    description: '口腔 B2B 商城，可查询商品（搜索免登录）',
    authMethod: 'password',
    configFields: [
      { key: 'baseURL', label: '商城地址', type: 'text', default: 'https://supplier.example.com', required: true },
      { key: 'account', label: '账号', type: 'text', required: true },
      { key: 'password', label: '密码', type: 'password', required: true },
      { key: 'token', label: 'Token（可选，手动填）', type: 'password' },
    ],
    tools: [
      { id: 'mmm-shop-search', name: '查询商品' },
      { id: 'mmm-shop-order', name: '加入购物车' },
    ],
    // 上游货源搜索接口**免登录**：无需 token 即可查询 ⇒ test 不强制登录、无 token 也可验连通性。
    // （置 true 后，ConnectorManager.test 不再「先登录再测」，避免被阻塞的 login 挡住「测试连接」。）
    optionalTokenTest: true,
    // ⛔ 阻塞（等凭证实测）：上游货源登录接口未经真实凭证验证。
    // 理由：/authapi/* 为**兜底路由**——乱编路径与真实路径返回**相同错误码**（1300），
    //       无法从响应证明任何登录路径存在 ⇒ 在拿到真实账号密码并实测前，不接入任何猜测路径。
    async login(config) {
      // TODO(阻塞:等凭证实测) 上游货源登录接口未经真实凭证验证。
      // 理由：/authapi/* 为兜底路由，乱编路径与真实路径返回相同错误码，无法从响应证明路径存在。
      // 在拿到真实账号密码并实测前，不接入任何登录路径，避免猜测。
      return { ok: false, error: '上游货源登录暂未开通' };
    },
    // 测试连接：调 POST {base}/api/product/list 验连通。
    // ⚠️ 与 上游货源 的真实差异①：上游货源 **keyword 必传**（不传返回空列表）⇒ 这里固定带 keyword。
    // ⚠️ 免登录差异②：Authorization 仅在 token 非空时附加（上游货源 必带）。
    async test(config, token) {
      const baseURL = String(config.baseURL || 'https://supplier.example.com').replace(/\/+$/, '');
      const queryMs = timeoutMsFor(QUERY_TIMEOUT_MS);
      try {
        const headers = { 'Content-Type': 'application/json' };
        const tok = String(token || '').trim();
        if (tok) headers.Authorization = tok; // 免登录：无 token 绝不附加 Authorization
        const res = await fetch(baseURL + '/api/product/list', {
          method: 'POST',
          headers,
          body: JSON.stringify({ categoryId: '', pageSize: 24, pageIndex: 1, exts: [], orderBy: 0, keyword: '牙膏' }),
          signal: timeoutSignal(queryMs),
        });
        const j = await res.json().catch(() => null);
        if (!j) return { ok: false, error: 'HTTP ' + res.status };
        if (j.resultID === 1323) return { ok: false, error: '登录超时，请重新登录' };
        if (j.resultID === 1200) return { ok: true };
        return { ok: false, error: 'resultID=' + j.resultID + ' ' + (j.message || '') };
      } catch (e) {
        return { ok: false, error: readableNetError(e, queryMs) };
      }
    },
  },
  {
    id: 'doudou-ai',
    name: '自建后端',
    icon: '🌱',
    description: 'GEO 内容营销：注册公司、生成 GEO 内容、账号人设检测、AI 曝光对比、口碑监测',
    authMethod: 'password',
    configFields: [
      { key: 'baseURL', label: '工作台地址', type: 'text', default: 'https://api.example.com', required: true },
      { key: 'account', label: '账号', type: 'text', required: true },
      { key: 'password', label: '密码', type: 'password', required: true },
      { key: 'token', label: 'Token（可选，手动填）', type: 'password' },
    ],
    tools: [
      { id: 'geo-company-register', name: '注册/编辑公司' },
      { id: 'geo-generate', name: '生成 GEO 内容' },
      { id: 'geo-account-detect', name: '账号人设检测' },
      { id: 'geo-ai-exposure', name: 'AI 曝光对比' },
      { id: 'geo-reputation', name: '口碑监测' },
    ],
    // password 授权：账号密码调 /api/login 换 token（返回 access_token，后续必须带 Bearer 前缀）
    async login(config) {
      const baseURL = String(config.baseURL || 'https://api.example.com').replace(/\/+$/, '');
      const account = String(config.account || '').trim();
      const password = String(config.password || '');
      if (!baseURL || !account || !password) return { ok: false, error: '缺少账号或密码' };
      const loginMs = timeoutMsFor(LOGIN_TIMEOUT_MS);
      try {
        const res = await fetch(baseURL + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: account, password }),
          signal: timeoutSignal(loginMs),
        });
        const j = await res.json().catch(() => null);
        if (j && j.access_token) {
          return { ok: true, token: String(j.access_token) };
        }
        return { ok: false, error: (j && j.detail) || ('登录失败 HTTP ' + res.status) };
      } catch (e) {
        return { ok: false, error: readableNetError(e, loginMs) };
      }
    },
    // 测试连接：调 GET /api/companies 验证 token 是否有效（必须带 Bearer 前缀）
    async test(config, token) {
      const baseURL = String(config.baseURL || 'https://api.example.com').replace(/\/+$/, '');
      const queryMs = timeoutMsFor(QUERY_TIMEOUT_MS);
      try {
        const res = await fetch(baseURL + '/api/companies', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
          },
          signal: timeoutSignal(queryMs),
        });
        const j = await res.json().catch(() => null);
        if (!j) return { ok: false, error: 'HTTP ' + res.status };
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: (j && j.detail) || '登录过期，请重新登录' };
        }
        if (j && j.ok === true) return { ok: true };
        return { ok: false, error: (j && j.detail) || ('HTTP ' + res.status) };
      } catch (e) {
        return { ok: false, error: readableNetError(e, queryMs) };
      }
    },
  },
];

class ConnectorManager {
  constructor({ dataDir, baseURL, cfg }) {
    this.dataDir = dataDir;
    this.baseURL = baseURL || 'http://127.0.0.1:10119';
    this.cfg = cfg || {}; // 运行时配置（含 shopAccount/shopPassword/shopBaseURL/shopApiKey）
    this.secret = makeSecret(dataDir);
    this.stateMap = new Map(); // OAuth: state -> { connectorId, exp }
    this.tokensPath = path.join(dataDir, 'connector-tokens.json');
    this.configPath = path.join(dataDir, 'connectors.json');
    this.oauthConfig = this._loadOAuthConfig();
    this.tokenStore = this._loadTokens();
    this.tokenCache = new Map(); // id -> { token, ts }（内存缓存，加速）
  }

  _loadOAuthConfig() {
    if (fs.existsSync(this.configPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch (e) {
        console.error('[Connectors] bad connectors.json:', e.message);
      }
    }
    const fallback = path.join(process.cwd(), 'connectors.json');
    if (fs.existsSync(fallback)) {
      try {
        return JSON.parse(fs.readFileSync(fallback, 'utf8'));
      } catch {}
    }
    return [];
  }

  _loadTokens() {
    if (fs.existsSync(this.tokensPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.tokensPath, 'utf8'));
      } catch {}
    }
    return {};
  }

  _saveTokens() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.tokensPath, JSON.stringify(this.tokenStore, null, 2));
  }

  // 内置商城连接器配置：从 config.json 的 shop* 字段读
  getShopConfig() {
    const c = this.cfg || {};
    return {
      baseURL: c.shopBaseURL || 'https://supplier.example.com',
      account: c.shopAccount || '',
      password: c.shopPassword || '',
      token: c.shopApiKey || '',
    };
  }

  // 上游货源商城连接器配置：从 config.json 的 mmm* 字段读（独立命名空间，与 shop* 严格区分）
  getMmmConfig() {
    const c = this.cfg || {};
    return {
      baseURL: c.mmmBaseURL || 'https://supplier.example.com',
      account: c.mmmAccount || '',
      password: c.mmmPassword || '',
      token: c.mmmApiKey || '',
    };
  }

  // 内置 GEO 工作台连接器配置：从 config.json 的 geo* 字段读
  getGeoConfig() {
    const c = this.cfg || {};
    return {
      baseURL: c.geoBaseURL || 'https://api.example.com',
      account: c.geoAccount || '',
      password: c.geoPassword || '',
      token: c.geoApiKey || '',
    };
  }

  // 按连接器 id 返回对应配置（doudou-ai=GEO 工作台 / shop-supplier-b=上游货源 / 其它=上游货源 商城）
  // ⚠️ 兜底分支保持 getShopConfig()，未知 id 的既有行为不变。
  _configFor(id) {
    if (id === 'doudou-ai') return this.getGeoConfig();
    if (id === 'shop-supplier-b') return this.getMmmConfig();
    return this.getShopConfig();
  }

  // 返回连接器类型目录（不含函数）
  types() {
    return CONNECTOR_TYPES.map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon,
      description: t.description,
      authMethod: t.authMethod,
      configFields: t.configFields || [],
      tools: t.tools || [],
    }));
  }

  _type(id) {
    return CONNECTOR_TYPES.find((t) => t.id === id) || null;
  }

  // 从 tokenStore 或缓存读 token；过期返回 null
  _cachedToken(id) {
    const hit = this.tokenCache.get(id);
    if (hit && Date.now() - hit.ts < TOKEN_TTL_MS) return hit.token;
    const tok = this.tokenStore[id];
    if (tok && tok.access_token) {
      if (tok.expires_at && tok.expires_at > Date.now()) {
        this.tokenCache.set(id, { token: tok.access_token, ts: Date.now() });
        return tok.access_token;
      }
      // 无 expires_at（商城 token）则按 30 分钟 TTL 判断
      if (!tok.expires_at && tok.obtained_at && Date.now() - tok.obtained_at < TOKEN_TTL_MS) {
        this.tokenCache.set(id, { token: tok.access_token, ts: Date.now() });
        return tok.access_token;
      }
    }
    return null;
  }

  _storeToken(id, token, expiresAt) {
    this.tokenStore[id] = {
      access_token: token,
      expires_at: expiresAt || null,
      obtained_at: Date.now(),
    };
    this.tokenCache.set(id, { token, ts: Date.now() });
    this._saveTokens();
  }

  // 注入外部 token（如登录时拿到的 access_token），供 GEO 代理直接复用，
  // 免去用户在设置里再填一次豆芽账号密码。
  injectToken(id, token, expiresAt) {
    if (!token) return;
    this._storeToken(id, token, expiresAt || null);
  }

  // 连接器实例列表（含连接状态），统一展示商城 + OAuth 连接器
  list() {
    const now = Date.now();
    for (const [k, v] of this.stateMap) if (v.exp < now) this.stateMap.delete(k);
    const out = [];

    // 1) 内置商城连接器 + GEO 工作台连接器
    for (const t of CONNECTOR_TYPES) {
      const cfg0 = this._configFor(t.id);
      const tok = this._cachedToken(t.id);
      out.push({
        id: t.id,
        type: t.id,
        name: t.name,
        icon: t.icon,
        description: t.description,
        authMethod: t.authMethod,
        connected: !!tok,
        configured: !!(cfg0.account && cfg0.password),
        config: {
          baseURL: cfg0.baseURL,
          account: cfg0.account,
          passwordSet: !!cfg0.password,
          tokenSet: !!cfg0.token,
        },
      });
    }

    // 2) OAuth 连接器（connectors.json）
    for (const c of this.oauthConfig) {
      const tok = this._cachedToken(c.id);
      out.push({
        id: c.id,
        type: c.type || 'oauth-generic',
        name: c.name,
        icon: c.icon || '🔗',
        description: c.description || '',
        authMethod: 'oauth',
        connected: !!tok,
        configured: true,
        config: { name: c.name },
      });
    }
    return out;
  }

  // 连接：password 类型走登录；oauth 类型返回授权 URL
  async connect(typeId) {
    const t = this._type(typeId);
    if (!t) return { ok: false, error: '未知连接器类型: ' + typeId };
    if (t.authMethod === 'password') {
      const config = this._configFor(typeId);
      // 手动填了 token 优先 —— 但**必须先证明它还有效**，否则「优先」会变成死锁。
      //
      // 【2026-10-12 实测定位】用户设置里手填的 token 是个 11 位值（不是会话 token），
      //   服务端对它的加购请求返回 resultID:1323「登录超时，请重新登录」（已用真实请求证实）。
      //   旧逻辑「手填 token 优先、且不验证」⇒ connect() 每次都把这个死 token 存回去，
      //   配置里的账号密码**从头到尾没被用过** ⇒ 用户反复重试永远失败、也无法自愈，
      //   表面症状就是「上游货源 下单接口挂了」——而服务端三个接口（首页 / 登录 / 加购）
      //   实测全部正常，挂的是本地这条 token 优先分支。
      //   现在：手填 token 先用 t.test 验一次；通过才采用，不通过就继续走账号密码登录。
      //
      //   为什么不改 t.test() 的返回结构：既有单测断言 上游货源 test() 的返回值
      //   「逐字一致」（deepEqual 两个字段），加字段会让那条回归红。故这里只判 v.ok。
      //
      //   对上游货源（optionalTokenTest: true）无影响：它的 test 免登录，手填 token 同样验得过。
      if (config.token) {
        const v = await t.test(config, String(config.token));
        if (v && v.ok) {
          this._storeToken(typeId, config.token);
          return { ok: true, name: t.name };
        }
        // 手填 token 无效：不报错、不采用，继续往下走账号密码登录（自愈路径）。
        // 但若同时没有账号密码，login 只会说「缺少账号或密码」——用户不知道该去清空
        // 那个闯祸的 Token 字段，故这里把话说全（旧行为：返回「缺少账号或密码」）。
        if (!config.account || !config.password) {
          return {
            ok: false,
            error:
              '设置里手动填的 Token 已失效（服务端返回「登录超时」），且没有可用的账号密码。' +
              '请清空「Token」字段，改用商城账号密码登录。',
          };
        }
      }
      const r = await t.login(config);
      if (r.ok) {
        this._storeToken(typeId, r.token);
        return { ok: true, name: t.name };
      }
      return { ok: false, error: r.error || '登录失败' };
    }
    // oauth：走授权 URL（见 getAuthUrl）
    return { ok: false, error: '该连接器需通过 OAuth 授权，请使用授权链接' };
  }

  // 断开：清除 token
  disconnect(id) {
    delete this.tokenStore[id];
    this.tokenCache.delete(id);
    this._saveTokens();
    return { ok: true };
  }

  // 测试连接：password 类型调用 test()，oauth 类型校验 token 是否在
  async test(id) {
    const t = this._type(id);
    if (t && t.authMethod === 'password') {
      const config = this._configFor(id);
      let token = this._cachedToken(id);
      // 免登录连接器（token 可选，如上游货源搜索 optionalTokenTest=true）：无 token 也可直接测连通性，
      // 不强制「先登录再测」——否则被阻塞的 login() 会挡住「测试连接」。上游货源/doudou-ai 不受影响（未置该标志）。
      const optionalToken = t.optionalTokenTest === true;
      if (!token && !optionalToken) {
        // 先尝试登录再测
        const r = await this.connect(id);
        if (!r.ok) return r;
        token = this._cachedToken(id);
      }
      if (!token && !optionalToken) return { ok: false, error: '无可用 token' };
      const r = await t.test(config, token || '');
      if (!r.ok && !optionalToken) {
        // 测试失败可能是 token 过期：清缓存重登一次再测（免登录连接器无登录可重试，直接返回）
        this.tokenCache.delete(id);
        const c2 = await this.connect(id);
        if (c2.ok) {
          const r2 = await t.test(config, this._cachedToken(id));
          return r2;
        }
      }
      return r;
    }
    const tok = this._cachedToken(id);
    return tok ? { ok: true } : { ok: false, error: '未连接' };
  }

  // 拿 token（password 类型自动登录+过期重登；手动 token 优先）
  async getToken(id) {
    const t = this._type(id);
    const cached = this._cachedToken(id);
    if (cached) return cached;
    if (t && t.authMethod === 'password') {
      const r = await this.connect(id);
      if (r.ok) return this._cachedToken(id) || '';
      return '';
    }
    // oauth：读持久化 token（无自动刷新，过期则空）
    const tok = this.tokenStore[id];
    return (tok && tok.access_token) || '';
  }

  // 同步取 token（供主进程 webRequest.onBeforeSendHeaders 注入请求头用）。
  // ⚠️ onBeforeSendHeaders 的回调不能 await（await 会挂住请求、或把 Promise 当 token 注入），
  // 故这里**只读内存**：tokenCache（Map）与构造时已加载进内存的 tokenStore，绝不读盘、不联网登录。
  // 无 token 或已过期 → 返回 null（调用方据此不注入，绝不注入空串）。
  getTokenSync(id) {
    if (!id) return null;
    try {
      return this._cachedToken(id) || null;
    } catch {
      return null;
    }
  }

  // 连接状态（供 runSkill 快速判断）
  getStatus(id) {
    const t = this._type(id);
    if (t && t.authMethod === 'password') {
      const c = this._configFor(id);
      return {
        configured: !!(c.account && c.password) || !!c.token,
        connected: !!this._cachedToken(id),
      };
    }
    return { configured: true, connected: !!this._cachedToken(id) };
  }

  // ---- OAuth2 授权码流程（保留）----
  getAuthUrl(connectorId) {
    const c = this.oauthConfig.find((x) => x.id === connectorId);
    if (!c) return null;
    const state = crypto.randomBytes(16).toString('hex');
    this.stateMap.set(state, { connectorId, exp: Date.now() + STATE_TTL_MS });
    const redirectUri = c.redirectUri || this.baseURL + REDIRECT_PATH;
    const u = new URL(c.authorizeURL);
    u.searchParams.set('client_id', c.clientId || '');
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', state);
    if (c.scope) u.searchParams.set('scope', c.scope);
    return { url: u.toString(), redirectUri };
  }

  async handleCallback(query) {
    const { code, state } = query;
    if (!code || !state) return { ok: false, error: 'missing code or state' };
    const entry = this.stateMap.get(state);
    if (!entry || entry.exp < Date.now()) return { ok: false, error: 'invalid or expired state' };
    this.stateMap.delete(state);
    const c = this.oauthConfig.find((x) => x.id === entry.connectorId);
    if (!c) return { ok: false, error: 'unknown connector' };
    const redirectUri = c.redirectUri || this.baseURL + REDIRECT_PATH;
    const tokenMs = timeoutMsFor(TOKEN_TIMEOUT_MS);
    try {
      const body = new URLSearchParams({
        client_id: c.clientId || '',
        client_secret: c.clientSecret || '',
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const res = await fetch(c.tokenURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: timeoutSignal(tokenMs),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'token exchange failed' };
      this.tokenStore[c.id] = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
        obtained_at: Date.now(),
      };
      this._saveTokens();
      return { ok: true, name: c.name };
    } catch (e) {
      return { ok: false, error: readableNetError(e, tokenMs) };
    }
  }
}

module.exports = {
  ConnectorManager,
  CONNECTOR_TYPES,
  signJWT,
  verifyJWT,
  // 超时档位（供单测断言 15000/20000 确实被用上）
  CONNECTOR_TIMEOUTS: { login: LOGIN_TIMEOUT_MS, query: QUERY_TIMEOUT_MS, token: TOKEN_TIMEOUT_MS },
  // 单测注入更短超时（生产不调用 ⇒ 用默认档位）
  setConnectorTimeoutOverride,
};
