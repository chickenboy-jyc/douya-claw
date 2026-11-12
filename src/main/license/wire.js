/**
 * 授权门接线
 * ================================================================
 *
 * 把 license/index.js 接到 Electron 启动链上。**改动面刻意做到最小**：
 * main.js 里只加 3 行（require + 调用 + 不必再改），其余全在这里。
 * 理由是这份 main.js 有 2724 行、正在发 rc.8，往里塞代码的风险远大于收益。
 *
 * ------------------------------------------------------------------
 * 时序（这是本文件最重要的一段，别改）
 * ------------------------------------------------------------------
 *
 *   createWindow()            ← 窗口先出来，用户看到界面
 *       ↓
 *   wireLicenseGate()         ← 挂在窗口之后，内部立刻返回，不等网络
 *       ↓
 *   [后台] gate.start() 读本地 → 立刻有结论 → 推给 UI
 *       ↓
 *   [后台] 网络校验 / 续期 / 心跳
 *
 * 为什么不能反过来：main.js 里 2026-10-22 那条注释已经写死了教训 ——
 * 「网络慢的时候，用户双击图标后要盯着空桌面等近 8 秒才看到窗口，
 *   那种体验和『打不开』几乎无法区分」。
 * 授权校验是网络请求，如果排在 createWindow 之前，等于把那个坑重新挖一遍，
 * 而且这次是挖在最显眼的地方（所有用户、每次启动）。
 *
 * ------------------------------------------------------------------
 * 这一层做了什么、没做什么（别对外宣称做了没做的）
 * ------------------------------------------------------------------
 *
 *   ✅ 启动闸：没授权 / 授权过期 / 被吊销 ⇒ 状态是 LOCKED，UI 应当挡住主功能
 *   ✅ 换机闸：指纹不符 ⇒ 服务端 403，拿到的包在别的机器上激活不了
 *   ✅ 拷贝闸：vault 绑指纹加密，拷走解不开
 *   ✅ 吊销闸：后台一键吊销，最长一个心跳周期（默认 4 小时）内生效
 *
 *   ❌ **没有**拦具体功能。要拦，得在关键 IPC handler 里加 `assertAllowed()`。
 *      这一步**故意没做**：哪些功能该拦、拦了之后用户看到什么，是产品决策。
 *      一刀切拦掉会让「授权快过期」的用户连设置页都打不开，反而更像坏了。
 */

'use strict';

const { ipcMain, safeStorage, app } = require('electron');
const { createLicenseGate, State, ALLOWED_STATES } = require('./index');
const { computeFingerprint, shortCode } = require('./fingerprint');

/** 全局单例。main.js 里只该调一次 wireLicenseGate。 */
let GATE = null;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-11-11 老板拍板：**默认只认账号密码，不再要求激活码**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原话：「激活码是不是太狠了 我觉得账号密码就够了 特么这个机器就是我啊」
 *
 * ── 为什么这个判断在技术上站得住（不是顺着老板说）────────────────────────
 *   这道闸原本想证明的是「你是不是这台机器被授权的使用者」。但身份其实**已经**由
 *   账号证明了，而且证据是硬的两条：
 *     ① 登录走 `api.example.com/api/login`，token 由平台签发；
 *     ② **用量上报就是按账号 token 走的** —— backend.js 的 `flushUsageReports()`
 *        第一行 `const token = authTokenCache; if (!token) return;`。
 *        也就是说"谁在用、用了多少"服务端本来就知道，机器码一个字节都没参与。
 *   ⇒ 授权码是**第二重身份证明**，对"认人"是重复的；它真正的功能只剩"限制装机数"
 *     （license-server.mjs 的 `MAX_SEATS`，默认 1）。
 *
 * ── 它为什么会变成事故（不是"用户体验不好"，是真的锁死）──────────────────
 *   · 机器码不稳：本机 `reg.exe` 被安全软件列入程序黑名单，
 *     fingerprint.js 里权重 100 的 `machineId` 直接读不到（`missing:["machineId"]`）。
 *     reg.exe 哪天被放行 / 被拦，机器码就跟着变 ⇒ **已激活的机器会突然失效**。
 *   · 两个闸互相锁死：登录被 402 拦（`/api/auth/*` 曾不在白名单）⇒ 红字冒充密码错误；
 *     激活面板又只挂在主界面 ⇒ 要登录才能激活、要激活才能登录。
 *     2026-11-11 已修（放行 auth + 激活卡上门口），但**根子在于它本来就不该是必答项**。
 *   · 老板自己的机器都要激活码，这个信号已经说明门槛过高。
 *
 * ── 现在的行为 ────────────────────────────────────────────────────────────
 *   默认 `account` 模式：**不创建 gate**，`getLicenseGate()` 返回 null。
 *   这不是"漏接线"，而是 `license/decide.js` 的**边界①**明文规定的合法状态：
 *   「没有 gate ⇒ 放行。没接线不等于没授权」。界面侧也自洽：
 *   `/api/license/status` 回 `{wired:false, allowed:true}`，而 App.jsx 的判据是
 *   `blocked = st.wired !== false && st.allowed === false` ⇒ 截图里那张激活卡自动消失。
 *
 * ── 代价（如实写在这里，不粉饰）──────────────────────────────────────────
 *   关掉之后，**"一份授权码只能装 N 台机器"这个限制在客户端没有了**。
 *   一个账号可以装在任意多台机器上。如果将来要靠装机数收钱，必须选下面任一条：
 *     · 把席位限制上移到**服务端按账号**做（usage 上报已经带 token，加个"在线设备数"即可）；
 *     · 或者用 `DOUYA_LICENSE_MODE=machine` 把这道闸开回来（代码全在，一行环境变量）。
 *
 * ── 为什么不删掉这些文件 ─────────────────────────────────────────────────
 *   `server/license-server.mjs` 还在 api.example.com 上跑着，`/api/license/issue|revoke`
 *   是现成的签发/吊销能力。删客户端等于把企业批量授权这条路也一起堵死。
 *   保留 + 默认不接线 = 需要时一个环境变量就能恢复，且不会有人误以为"没实现"。
 */
const LICENSE_MODE_ACCOUNT = 'account';
const LICENSE_MODE_MACHINE = 'machine';

/**
 * 当前授权模式。默认 `account`（只认账号密码）。
 *
 * 为什么默认值写在**代码里**而不是只认环境变量：默认值就是产品决策，
 * 藏在一个必须手工设置的环境变量后面，等于让"默认行为"没有主人。
 * 环境变量只用来**覆盖**，不用来决定默认。
 *
 * @returns {'account'|'machine'}
 */
function resolveLicenseMode() {
  const raw = String(process.env.DOUYA_LICENSE_MODE || '').trim().toLowerCase();
  if (raw === LICENSE_MODE_MACHINE) return LICENSE_MODE_MACHINE;
  // 任何其它值（含拼错、空）一律回落到 account —— 失败方向选**不锁用户**那侧。
  // 拼错成 DOUYA_LICENSE_MODE=machien 的人想开机器绑定，结果没开成；
  // 反过来（拼错就锁死所有人）是绝不可接受的失效方向。
  return LICENSE_MODE_ACCOUNT;
}

/**
 * 接线。
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  覆盖服务端地址（测试/预发用）
 * @param {'account'|'machine'} [opts.mode] 覆盖授权模式（不传则读 env / 默认 account）
 * @returns {object|null} gate 实例；`account` 模式下**返回 null**（= 没接线 ⇒ 全放行）
 */
function wireLicenseGate(opts = {}) {
  if (GATE) return GATE;   // 幂等：重复调用不重建

  const mode = opts.mode || resolveLicenseMode();
  if (mode !== LICENSE_MODE_MACHINE) {
    /**
     * account 模式：**刻意不创建 gate**。
     *
     * 为什么不是"创建一个永远 allowed 的 gate"：
     *   那种写法会让 `getLicenseGate()` 返回一个非 null 对象，
     *   于是所有"有没有接线"的判断都变成 true —— 包括 `/api/license/status` 的 `wired`。
     *   界面会显示一个"已接线、已通过"的假状态，日后想排查"到底有没有授权体系"
     *   会被这个假状态带偏。**返回 null 是唯一诚实的表达。**
     *
     * 也不注册 license:* 的 IPC：没接线就该表现得像没接线。
     * 若将来有人在渲染层 invoke 它们，会立刻拿到
     * "No handler registered" 并炸出来 —— 这是**可见的失败**，
     * 比返回一个假的 `{allowed:true}` 好（后者会让调用方以为授权体系在工作）。
     */
    console.log(
      '[license] 授权闸未启用（account 模式）：登录账号即可使用，不校验机器码。'
      + '（要启用机器绑定：设 DOUYA_LICENSE_MODE=machine 后重启）',
    );
    return null;
  }

  const baseUrl =
    opts.baseUrl ||
    process.env.DOUYA_LICENSE_URL ||
    'https://api.example.com';

  const dataDir = app.getPath('userData');

  GATE = createLicenseGate({
    dataDir,
    baseUrl,
    // safeStorage 传进去：Windows 下走 DPAPI，密钥绑当前用户+当前机器。
    // 拿不到时（部分 Linux 桌面）index.js 会自动退化为指纹派生，不用在这里判断。
    safeStorage,
    clientVersion: (() => {
      try { return app.getVersion(); } catch { return ''; }
    })(),
    onChange: (state, info) => {
      // 状态变了就推给渲染层。**推不出去也不影响授权判断** —— UI 下次主动拉也能拿到。
      try {
        const wins = require('electron').BrowserWindow.getAllWindows();
        for (const w of wins) {
          if (!w.isDestroyed() && w.webContents) {
            w.webContents.send('license:changed', { state, ...info });
          }
        }
      } catch { /* 窗口还没建好 / 已销毁，忽略 */ }
    },
  });

  // ── IPC ──────────────────────────────────────────────────────
  // 全部走 handle（渲染层 await），且每个都包 try/catch —— 授权相关的东西
  // 绝不能因为一个异常把渲染层的 ipcRenderer.invoke 卡死。

  ipcMain.handle('license:status', () => {
    try { return GATE.getStatus(); } catch (e) { return { error: String(e && e.message) }; }
  });

  ipcMain.handle('license:activate', async (_e, code) => {
    try { return await GATE.activate(code); } catch (e) { return { ok: false, detail: String(e && e.message) }; }
  });

  ipcMain.handle('license:retry', async () => {
    try { return await GATE.retry(); } catch (e) { return { ok: false, detail: String(e && e.message) }; }
  });

  ipcMain.handle('license:deactivate', () => {
    try { return GATE.deactivate(); } catch (e) { return { error: String(e && e.message) }; }
  });

  // 本机机器码（报障时念给客服）
  ipcMain.handle('license:machine', () => {
    try {
      const fp = computeFingerprint();
      return { short: shortCode(fp), strength: fp.strength, strong: fp.strong, missing: fp.missing };
    } catch {
      return { short: '--------', strength: 0, strong: false, missing: [] };
    }
  });

  // ── 启动（立刻返回）──────────────────────────────────────────
  try {
    GATE.start();
  } catch (e) {
    // start 内部已经兜底了，这里再兜一次：授权门自己炸了，也不能让主进程起不来
    console.error('[license] start 失败（不影响启动）：', e && e.message);
  }

  return GATE;
}

/** 供其它模块取当前 gate（没接线则返回 null）。 */
function getLicenseGate() {
  return GATE;
}

/**
 * 功能闸。给「需要确认授权才允许」的 IPC handler 用：
 *
 *   const { guard } = require('./license/wire');
 *   ipcMain.handle('chat:send', guard(async (e, payload) => { ... }));
 *
 * 未授权时**抛一个带 code 的错误**，渲染层据此显示激活引导。
 * 注意：这里只提供工具，**具体拦哪些 handler 是产品决策**，本文件不替你做。
 */
function guard(fn) {
  return async (...args) => {
    if (GATE && !GATE.isAllowed()) {
      const err = new Error('需要激活后才能使用该功能');
      err.code = 'LICENSE_REQUIRED';
      err.licenseState = GATE.getStatus().state;
      throw err;
    }
    return fn(...args);
  };
}

// `resolveLicenseMode` 导出**只为门禁能真跑它**。
// 它是纯函数（只读 env、不碰 electron、不碰网络），门禁可以用 `createRequire` + 给
// `electron` 打桩的方式把它整个 require 进来验证 —— 比在源码上跑正则可靠得多。
// 上一轮的教训：`unit-license-gate` 里"懒加载存在吗"那条断言曾因正则吃错字符而假红，
// 工具看错然后去否认证据。纯函数就该真调一次。
module.exports = {
  wireLicenseGate,
  getLicenseGate,
  guard,
  State,
  ALLOWED_STATES,
  resolveLicenseMode,
  LICENSE_MODE_ACCOUNT,
  LICENSE_MODE_MACHINE,
};
