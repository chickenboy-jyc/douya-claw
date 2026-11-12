/**
 * 授权门 —— 「拿走也用不了」的闸
 * ================================================================
 *
 * 目标：把客户端连同 userData 一起拷到另一台机器，**那台机器用不了**。
 *
 * 三道闸，缺一不可
 * ---------------------------------------------------------------
 *   1. 载体加密（store.js）：拷过去的凭据解不开 ⇒ 拿不到 token。
 *   2. 指纹绑定（服务端）：token 里绑着签发时的指纹，换机器 token 对不上 ⇒ 服务端拒。
 *   3. 短期令牌 + 强制续期：token 12 小时过期，必须续 ⇒ 拔网线拖不过去。
 *
 * 三条都过了还有一条路：把「指纹计算」改成常量，让两台机器算出同一个指纹。
 * 这条**客户端永远堵不住**（代码在对方手里）。所以真正的止损在服务端：
 * 同一个授权码被两个不同 IP / 短时间内在多个指纹上反复激活，后台能看见、能一键吊销。
 * 这里不假装能防住它 —— 假装防住比承认防不住更危险，因为会让人放心地把
 * 真东西放进客户端。
 *
 * 三条铁律（都是踩过坑才写的）
 * ---------------------------------------------------------------
 *
 *   ⚠️ 铁律一：**绝不阻塞窗口**
 *   main.js 里 2026-10-22 那条注释写得很清楚：窗口创建必须排在网络探测之前，
 *   因为「网络慢的时候，用户双击图标后要盯着空桌面等近 8 秒才看到窗口，
 *   那种体验和『打不开』几乎无法区分」。
 *   授权校验也是网络请求 ⇒ **它必须跑在窗口建好之后**，而且是异步的。
 *   本模块的 `start()` 立刻返回，永远不 await 网络。
 *
 *   ⚠️ 铁律二：**服务端挂了不许锁用户**
 *   5xx / 超时 / 断网 一律视为「判断不了」，走本地缓存 + 宽限期。
 *   只有服务端**明确说不行**（401/403）才扣权限。
 *   反过来做的后果很实在：服务端一次重启，全网用户同时打不开软件，
 *   第二天你就得把这个功能整个关掉。
 *
 *   ⚠️ 铁律三：**时钟回拨要认出来**
 *   宽限期一旦用「墙上时钟的差值」来算，用户把系统时间往回拨就能永久停在宽限期。
 *   所以这里同时记 `lastOkAt`（最后成功校验的时刻）和 `graceUsedMs`（累计已用宽限）。
 *   时间倒退 ⇒ 判定为「不可信」，直接要求联网，而不是当成"还没到期"。
 *
 * 状态机
 * ---------------------------------------------------------------
 *
 *   UNACTIVATED ──activate()──▶ ACTIVE
 *                                  │  令牌临近过期，续期成功
 *                                  ├──────────────▶ ACTIVE
 *                                  │  网络失败 / 5xx，且在宽限内
 *                                  ├──────────────▶ GRACE
 *                                  │  服务端 401/403
 *                                  ├──────────────▶ REVOKED
 *                                  │  宽限用尽 / 时钟回拨
 *                                  └──────────────▶ EXPIRED
 *   GRACE ──续期成功──▶ ACTIVE
 *   GRACE ──宽限耗尽──▶ EXPIRED
 *   EXPIRED / REVOKED ──重新激活──▶ ACTIVE
 *
 * `LOCKED` 是给 UI 用的合成态：EXPIRED / REVOKED / UNACTIVATED 都是"不能正常用"，
 * UI 只关心"放不放行"，不该去记四个枚举。
 */

'use strict';

const { createVault, shortFp } = require('./store');
const { computeFingerprint, shortCode } = require('./fingerprint');

/** 服务端接口路径。集中在这里，改服务端时只改一处。 */
const PATHS = Object.freeze({
  activate: '/api/license/activate',
  verify: '/api/license/verify',
});

/** 默认参数。全部可被 opts 覆盖 —— 单测和验收必须能改，否则测不了过期。 */
const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.example.com',
  /** 网络超时。比 usage 上报的 10s 短：这是启动路径，不能让人干等。 */
  timeoutMs: 8000,
  /** 宽限期：连续这么久没能成功联网校验，就要求重新激活。 */
  graceMs: 72 * 3600 * 1000,
  /** 本地令牌提前多久视为"该续了"。留出余量，避免刚续完就过期。 */
  renewBeforeMs: 2 * 3600 * 1000,
  /** 后台心跳间隔。运行中定期续期，避免"用着用着突然过期"。 */
  heartbeatMs: 4 * 3600 * 1000,
  /** 时钟回拨容忍度。小于这个值的倒退当作系统对时，不追究。 */
  clockSkewToleranceMs: 5 * 60 * 1000,
});

/** 对外状态枚举。 */
const State = Object.freeze({
  UNACTIVATED: 'UNACTIVATED',   // 从没激活过
  ACTIVE: 'ACTIVE',             // 有效，且刚和服务端对过
  GRACE: 'GRACE',               // 令牌在，但这段时间没能联网
  EXPIRED: 'EXPIRED',           // 宽限用尽 / 令牌彻底过期
  REVOKED: 'REVOKED',           // 服务端明确吊销
});

/** 状态 → 是否放行。**唯一的判据**，别在别处再写一遍 if。 */
const ALLOWED_STATES = new Set([State.ACTIVE, State.GRACE]);

/**
 * 创建授权门。
 *
 * @param {object} opts
 * @param {string}   opts.dataDir       凭据目录（Electron: app.getPath('userData')）
 * @param {string}  [opts.baseUrl]      服务端地址，默认 https://api.example.com
 * @param {object}  [opts.safeStorage]  Electron safeStorage；不传则用指纹派生加密
 * @param {number}  [opts.graceMs]      宽限期
 * @param {Function}[opts.fetchImpl]    注入 fetch（测试用）
 * @param {Function}[opts.now]          注入时钟（测试用）—— **测时钟回拨必须靠它**，
 *                                      否则只能去改系统时间，那在 CI 里没法跑
 * @param {Function}[opts.onChange]     状态变化回调 (state, detail)
 * @param {Function}[opts.log]          日志函数，默认 console.log
 */
function createLicenseGate(opts) {
  const o = opts || {};
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (o[k] !== undefined && o[k] !== null) cfg[k] = o[k];
  }

  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const doFetch = typeof o.fetchImpl === 'function' ? o.fetchImpl : globalThis.fetch;
  const log = typeof o.log === 'function' ? o.log : (m) => console.log(String(m));
  const onChange = typeof o.onChange === 'function' ? o.onChange : null;

  const vault = createVault({
    dataDir: o.dataDir,
    safeStorage: o.safeStorage,
    getFingerprint: () => computeFingerprint(),
  });

  /** 内存态。落盘的是 `record`，它才是真相；这里只是缓一份免得反复解密。 */
  let state = State.UNACTIVATED;
  let record = null;      // { licenseCode, token, tokenExpiresAt, lastOkAt, graceUsedMs, firstSeenAt, seats }
  let lastDetail = '';    // 给人看的一句话，UI 直接显示
  let verifying = false;
  let heartbeatTimer = null;
  let started = false;

  function setState(next, detail) {
    const changed = next !== state || detail !== lastDetail;
    state = next;
    lastDetail = detail || '';
    if (changed && onChange) {
      try {
        onChange(state, { detail: lastDetail, allowed: ALLOWED_STATES.has(state), record: publicRecord() });
      } catch {
        // 回调炸了不能影响授权判断
      }
    }
  }

  /** 对外只暴露必要字段。**不返回 token 本身** —— 它会流进渲染层/日志。 */
  function publicRecord() {
    if (!record) return null;
    return {
      licenseCode: record.licenseCode,
      tokenExpiresAt: record.tokenExpiresAt,
      lastOkAt: record.lastOkAt,
      graceUsedMs: record.graceUsedMs,
      seats: record.seats,
      fpShort: shortCode(computeFingerprint()),
    };
  }

  /**
   * 用本地 record 推导「现在该是什么状态」。
   * 这是纯计算，不碰网络 —— 启动瞬间就能给出结论，窗口不必等。
   */
  function deriveFromLocal() {
    if (!record || !record.token) return { state: State.UNACTIVATED, detail: '还没激活' };

    const t = now();

    // ① 时钟回拨检测。**必须在所有时间比较之前做**。
    if (record.lastOkAt && t < record.lastOkAt - cfg.clockSkewToleranceMs) {
      return {
        state: State.EXPIRED,
        detail: '系统时间被往回调过，需要联网重新验证',
        clockRollback: true,
      };
    }

    // ② 令牌硬过期：本地就知道过期了，不必等网络。
    if (record.tokenExpiresAt && t > record.tokenExpiresAt) {
      const overdue = t - record.tokenExpiresAt;
      // 给一点余量：令牌刚过期几分钟、但还在宽限期额度内，仍然放行进 GRACE
      const graceLeft = cfg.graceMs - (record.graceUsedMs || 0);
      if (overdue < graceLeft) {
        return { state: State.GRACE, detail: `令牌已过期 ${Math.round(overdue / 60000)} 分钟，请联网续期` };
      }
      return { state: State.EXPIRED, detail: '授权已过期，请联网续期' };
    }

    // ③ 距上次成功校验过了多久 —— 决定是 ACTIVE 还是 GRACE
    const sinceOk = record.lastOkAt ? t - record.lastOkAt : Infinity;
    if (sinceOk <= cfg.renewBeforeMs) {
      return { state: State.ACTIVE, detail: '授权有效' };
    }
    const graceLeft = cfg.graceMs - (record.graceUsedMs || 0) - sinceOk;
    if (graceLeft > 0) {
      return { state: State.GRACE, detail: `已 ${fmtDuration(sinceOk)} 没能联网，还剩 ${fmtDuration(graceLeft)} 宽限` };
    }
    return { state: State.EXPIRED, detail: '长时间未能联网验证，请联网后重试' };
  }

  /** 把一次「无法判断」折算进宽限额度。只在**确实没网/服务端错**时调用。 */
  function consumeGrace(reason) {
    if (!record) return;
    const t = now();
    // 用「距上次成功校验的间隔」累加，而不是每次 +1 次心跳 ——
    // 否则心跳频率一变，宽限的实际时长就跟着变，没法向用户解释。
    if (record.lastOkAt) {
      const delta = Math.max(0, t - record.lastOkAt);
      // 只在 delta 明显大于上次已计入的量时补差，避免重复累加
      const already = record.graceChargedFor || 0;
      if (delta > already) {
        record.graceUsedMs = (record.graceUsedMs || 0) + (delta - already);
        record.graceChargedFor = delta;
      }
    }
    lastDetail = reason || lastDetail;
    try { vault.write(record); } catch { /* 记账失败不阻塞 */ }
  }

  /** 统一的请求封装：AbortController + 超时，**永不 throw**。 */
  async function post(pathName, body) {
    const url = String(cfg.baseUrl).replace(/\/+$/, '') + pathName;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const resp = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      let json = null;
      try {
        json = await resp.json();
      } catch {
        json = null;
      }
      return { ok: resp.ok, status: resp.status, json };
    } catch (e) {
      // 断网 / DNS 失败 / 超时 —— 全部归为「判断不了」，不是「拒绝」
      return { ok: false, status: 0, json: null, networkError: true, error: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 与服务端对一次。
   * @returns {{ verdict:'ok'|'denied'|'unknown', detail:string }}
   *   ok      —— 服务端确认有效，刷新本地时间戳
   *   denied  —— 服务端明确说不行（401/403），扣权限
   *   unknown —— 判断不了（网络/5xx/畸形响应），保留现状，走宽限
   */
  async function verifyOnce() {
    if (verifying) return { verdict: 'unknown', detail: '正在校验中，跳过本次' };
    if (!record || !record.token) return { verdict: 'denied', detail: '本地没有令牌' };
    verifying = true;
    try {
      const fp = computeFingerprint();
      const r = await post(PATHS.verify, {
        token: record.token,
        fingerprint: fp.id,
        fingerprintStrength: fp.strength,
        licenseCode: record.licenseCode,
        clientVersion: o.clientVersion || '',
        platform: `${process.platform}/${process.arch}`,
      });

      // 网络问题 / 5xx：判断不了
      if (r.networkError) return { verdict: 'unknown', detail: `连不上授权服务（${r.error || '网络错误'}）` };
      if (r.status >= 500 || r.status === 429) {
        return { verdict: 'unknown', detail: `授权服务暂时不可用（HTTP ${r.status}）` };
      }
      // 明确拒绝
      if (r.status === 401 || r.status === 403) {
        const why = (r.json && (r.json.error || r.json.reason)) || `HTTP ${r.status}`;
        return { verdict: 'denied', detail: String(why) };
      }
      if (!r.ok) return { verdict: 'unknown', detail: `授权服务返回 HTTP ${r.status}` };
      if (!r.json || r.json.ok !== true) return { verdict: 'unknown', detail: '授权服务响应格式不对' };

      return {
        verdict: 'ok',
        detail: '授权有效',
        payload: r.json,
      };
    } finally {
      verifying = false;
    }
  }

  /**
   * 启动。**立刻返回，永远不 await 网络**（铁律一）。
   * 本地先给结论（窗口据此决定显示什么），网络校验在后台跑。
   */
  function start() {
    if (started) return getStatus();
    started = true;

    // ① 本地读盘 + 推导（同步、极快）
    const r = vault.read();
    if (r.ok) {
      record = r.data;
    } else if (r.reason === vault.Reason.DECRYPT_FAILED) {
      // 换机器/被复制 —— 这是最需要说清楚的一种失败
      record = null;
      setState(State.UNACTIVATED,
        `本机的授权凭据解不开（上次是在 ${r.fpShortStored || '另一台机器'} 上激活的），需要重新激活`);
      log(`[license] vault 解不开：存的是 ${r.fpShortStored}，当前 ${shortCode(computeFingerprint())}`);
      return getStatus();
    } else if (r.reason === vault.Reason.CORRUPT) {
      // 文件写坏了：自愈，删掉重来，不算用户的错
      record = null;
      vault.clear();
      setState(State.UNACTIVATED, '授权文件已损坏，需要重新激活');
      return getStatus();
    } else {
      record = null;
      setState(State.UNACTIVATED, '还没激活');
      return getStatus();
    }

    const local = deriveFromLocal();
    setState(local.state, local.detail);

    // ② 后台校验（不 await）
    if (ALLOWED_STATES.has(local.state) || local.state === State.EXPIRED) {
      // EXPIRED 也要试一次：可能只是久没联网，联网就能救回来
      refresh('startup').catch(() => { /* 内部已兜底 */ });
    }

    // ③ 心跳
    scheduleHeartbeat();

    return getStatus();
  }

  /** 后台刷新一次状态。供 start / 心跳 / 手动重试共用。 */
  async function refresh(trigger) {
    const v = await verifyOnce();

    if (v.verdict === 'ok') {
      const p = v.payload || {};
      record.lastOkAt = now();
      record.graceUsedMs = 0;
      record.graceChargedFor = 0;
      if (p.token) record.token = String(p.token);
      if (p.expiresAt) record.tokenExpiresAt = Number(p.expiresAt);
      else if (p.expiresInSec) record.tokenExpiresAt = now() + Number(p.expiresInSec) * 1000;
      if (p.seats != null) record.seats = p.seats;
      vault.write(record);
      setState(State.ACTIVE, (p.message && String(p.message)) || '授权有效');
      return { ok: true };
    }

    if (v.verdict === 'denied') {
      // 服务端明确拒绝：可能是吊销、可能是令牌被改过、可能是绑定了别的机器
      const revokedHint = /revoke|吊销|作废/i.test(v.detail);
      record = record || null;
      if (record) {
        // 令牌已经没用了，清掉免得下次还拿它去撞
        record.token = '';
        vault.write(record);
      }
      setState(revokedHint ? State.REVOKED : State.EXPIRED,
        revokedHint ? `授权已被吊销：${v.detail}` : `授权校验没通过：${v.detail}`);
      return { ok: false, denied: true };
    }

    // unknown：判断不了。保持现有状态，只把时间能耗记进宽限。
    consumeGrace(v.detail);
    const local = deriveFromLocal();
    setState(local.state, local.state === State.GRACE || local.state === State.EXPIRED
      ? `${local.detail}（${v.detail}）`
      : local.detail);
    return { ok: false, unknown: true };
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) return;
    const tick = async () => {
      heartbeatTimer = null;
      try {
        if (ALLOWED_STATES.has(state)) await refresh('heartbeat');
      } catch { /* 永不抛 */ }
      if (started) {
        heartbeatTimer = setTimeout(tick, cfg.heartbeatMs);
        // unref：别因为一个心跳定时器把进程钉住（Electron 主进程退出时不该被它拦住）
        if (heartbeatTimer.unref) heartbeatTimer.unref();
      }
    };
    heartbeatTimer = setTimeout(tick, cfg.heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  /** 停掉心跳（退出/测试用）。 */
  function stop() {
    started = false;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /**
   * 激活。
   * @param {string} code 授权码
   * @returns {{ ok:boolean, state:string, detail:string }}
   */
  async function activate(code) {
    const licenseCode = String(code || '').trim();
    if (!licenseCode) {
      return { ok: false, state, detail: '请输入授权码' };
    }

    const fp = computeFingerprint();
    const r = await post(PATHS.activate, {
      licenseCode,
      fingerprint: fp.id,
      fingerprintStrength: fp.strength,
      clientVersion: o.clientVersion || '',
      platform: `${process.platform}/${process.arch}`,
      machine: shortCode(fp),
    });

    if (r.networkError) {
      return { ok: false, state, detail: `连不上授权服务：${r.error || '网络错误'}` };
    }
    if (r.status >= 500) {
      return { ok: false, state, detail: `授权服务暂时不可用（HTTP ${r.status}），请稍后再试` };
    }
    if (!r.ok || !r.json || r.json.ok !== true) {
      const why = (r.json && (r.json.error || r.json.reason)) || `HTTP ${r.status}`;
      return { ok: false, state, detail: String(why) };
    }

    const j = r.json;
    record = {
      licenseCode,
      token: String(j.token || ''),
      tokenExpiresAt: j.expiresAt ? Number(j.expiresAt) : now() + Number(j.expiresInSec || 43200) * 1000,
      lastOkAt: now(),
      graceUsedMs: 0,
      graceChargedFor: 0,
      firstSeenAt: now(),
      seats: j.seats != null ? j.seats : null,
    };

    const w = vault.write(record);
    if (!w.ok) {
      // 存不下去 = 下次启动又要激活，这是必须告诉用户的
      setState(State.ACTIVE, '激活成功，但凭据无法保存到本机（磁盘权限？），下次启动需要重新激活');
      return { ok: true, state: State.ACTIVE, detail: lastDetail, warn: 'vault_write_failed' };
    }

    setState(State.ACTIVE, '激活成功');
    scheduleHeartbeat();
    return { ok: true, state: State.ACTIVE, detail: '激活成功' };
  }

  /** 主动触发一次校验（UI 上「重试」按钮用）。 */
  async function retry() {
    const v = await refresh('manual');
    return { ...v, status: getStatus() };
  }

  /** 解除授权（换机前用）。 */
  function deactivate() {
    stop();
    record = null;
    vault.clear();
    setState(State.UNACTIVATED, '已解除本机授权');
    return getStatus();
  }

  /** 同步读状态 —— UI 随时可调，不碰磁盘不碰网络。 */
  function getStatus() {
    const fp = computeFingerprint();
    return {
      state,
      allowed: ALLOWED_STATES.has(state),
      detail: lastDetail,
      record: publicRecord(),
      machine: shortCode(fp),
      fingerprint: {
        id: fp.id,
        strength: fp.strength,
        strong: fp.strong,
        missing: fp.missing,
        version: fp.version,
      },
      vaultMode: vault.mode(),
      graceMs: cfg.graceMs,
    };
  }

  return {
    start,
    stop,
    activate,
    deactivate,
    retry,
    getStatus,
    isAllowed: () => ALLOWED_STATES.has(state),
    // 给测试开的口子：能拿到内部 refresh，也能读原始 record
    __test: {
      refresh,
      /**
       * 注入一份 record。
       * ⚠️ 必须顺手重算 state —— 只改 record 不改 state，会让对象停留在
       *    「record 说已激活、state 说未授权」的自相矛盾状态。第一版就是这样，
       *    结果反控（已授权时 guard 必须放行）永远红着，看着像 guard 坏了，
       *    实际是钩子自己把对象搞脏了。测试钩子造出来的状态也得是合法状态。
       */
      setRecord: (r) => {
        record = r;
        if (r) {
          const d = deriveFromLocal();
          setState(d.state, d.detail);
        } else {
          setState(State.UNACTIVATED, '还没激活');
        }
      },
      getRecord: () => record,
      deriveFromLocal,
      verifyOnce,
    },
  };
}

/** 毫秒 → 「2 天 3 小时」这种人话。 */
function fmtDuration(ms) {
  const abs = Math.abs(Number(ms) || 0);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  if (d > 0) return `${d} 天${h > 0 ? ' ' + h + ' 小时' : ''}`;
  if (h > 0) return `${h} 小时${m > 0 ? ' ' + m + ' 分' : ''}`;
  return `${m} 分钟`;
}

module.exports = {
  createLicenseGate,
  State,
  PATHS,
  DEFAULTS,
  ALLOWED_STATES,
  fmtDuration,
};
