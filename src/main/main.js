const { app, BrowserWindow, session, protocol, ipcMain, screen, dialog, webUtils, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const backend = require('./backend');
// 子进程字节 → 文本的唯一真源（stderr 允许 GBK 回退；stdout→JSON/数值 一律严格 utf-8）
const { decodeOutput } = require('./childOutput');
const { startBackend, getConfig, runSapiRecognize, invalidateMemorySwitch, loadAuthToken } = backend;
const { getConnectorManager } = require('./skills');
// 「python 是谁」的一份真源（skills / shell-exec / 本文件的 pythonBin 三处共用）
const sharedPython = require('../shared/pythonRuntime');
const { volcanoRecognizeREST } = require('./stt_volcano');
const { volcanoTTS } = require('./tts_volcano');
const { initUpdater, updateAction, getLastState, checkNow } = require('./updater');
// 授权门（第三层技术防护 · 联网授权绑定）。
// 只 require 不启动 —— 真正的起点在 whenReady 里 createWindow() 之后，
// 原因是它内部会发网络请求，绝不能排在窗口创建之前（详见 license/wire.js 头注）。
const { wireLicenseGate } = require('./license/wire');
const { registerDevBridge } = require('./devBridge');
// 长期记忆存储（B 阶段 #247~#249）：IPC 层直接读写四层档案。
// ★ 只用它的**读函数 + 既有写入口**（updateLayer / appendLedger），不自己拼文件写入 ——
//   updateLayer 自带 TTL 降级与上限淘汰两个不变量，绕过它就会造出「记忆无限膨胀」。
const memoryStore = require('./memoryStore');
// 第三层能力：定时任务调度器（主进程内运行；纯依赖注入，可被单测直接 require）。
const { createScheduler, createHttpPost, buildToolsFromSkills } = require('./automations');
// 客服助手：渲染层提交的留言/反馈由主进程代理转发到自建后端（api.example.com/api/feedback）。
// ★ 2MB 上限在该模块内实施（唯一事实源）；本仓铁律「渲染层绝不直连外网」由它守住。
const supportProxy = require('./supportProxy');
// 商城商品检索（0.21.14 · 需求 3「AI 补货」）：supplier.example.com **实测零 CORS 头**，
// 渲染层连预检都过不去 ⇒ 只能主进程出网。频道名 `mmm:searchProducts` 与文件名解耦。
// ★ 该模块只投影 6 个字段（productId/name/price/discountPrice/hasStock/isNotShowPrice），
//   多一个都不往上带 —— 尤其 `marketPrice`（实测 52/52 等于 price，是拷贝不是建议价）。
const shopProducts = require('./shopProducts');
// 视频设计（通义万象 3.0 · 2026-10-21 老板需求）：视频合成 + 图像生成。
// ★ key 只在主进程使用，返回值只给掩码；渲染层经 IPC 调用，不直连外网（本仓铁律）。
// ★ 产物是**会过期的签名 URL** ⇒ 一律先下载到工作区再给前端本地路径。
const wanx = require('./wanxProvider');
// 视频精剪（剪映式的编辑器页面）：外部程序 Concat 0.2.9 的 **MCP over stdio** 会话层。
// ★ 与 `skills/concat-video/` 的分工要分清：那边是「模型一次性调用，每次 action 开关一次会话」，
//   这边是「人拖时间轴，必须**常驻一条会话**」—— 每次编辑重启 concat.exe 要 1~2 秒，
//   拖拽完全没法用。两套实现共存，互不引用。
// ★ 该模块**不 require electron**（本仓 140+ 条单测直接 require 主进程模块来跑），
//   所以对话框能力留在这个文件里（concat:pickMedia / concat:pickOutput）。
// ★ 退出时必须 closeSession()，否则 concat.exe 会变成孤儿进程留在任务管理器里。
const concatStudio = require('./concatStudio');
// 账号维度的产物隔离（2026-11-06 · 老板：「生图 生视频 要隔离 不要别的账号生的
// 豆芽另一个账号也能看到」）。产物目录 / 媒体授权根都按**当前账号**派生；
// 账号事实由 backend.js 在 `/api/auth/login` 与 `/api/auth/profile` 两处记进
// `<userData>/current-account.json`（主进程自己转发的上游响应，不必信任渲染层自报）。
// ★ 该模块**不 require electron**（本仓 140+ 条单测直接 require 主进程模块来跑）。
const accountScope = require('./accountScope');
// 窗口可见性判据（2026-10-22「双击图标没反应」排查）：抽成纯函数模块，**因为它必须能被单测**。
// ★ 写在本文件里就只能靠人工点几下"看起来没问题" —— 本文件 require('electron')，
//   在 node 里根本加载不起来，任何判据搬进来就等于放弃测试（本仓反复踩过这个坑）。
const { isRectVisible, exceedsWorkArea, centerIntoWorkArea } = require('./windowPlacement');

// 「开发工作台」（豆芽对话 → 开发板块）：项目目录树 / 读写代码 / 拉起微信开发者工具。
// 注册即生效，不依赖窗口就绪；所有写入都过 devBridge 的路径安全闸。
registerDevBridge();

// ---- 主窗口引用（**模块作用域**，不是 whenReady 内）----
// ★ 为什么必须放在这里：本文件有 6 处「发起请求的窗口，否则主窗口」的兜底
//   （win:control / win:isMaximized / file:pick / file:pickFolder / 素材选择 / 海报保存框）。
//   它原本声明在 `app.whenReady().then(() => { … })` 的函数体里 —— **那是另一个作用域**，
//   于是这 6 处在模块作用域里读到的是一个从未声明的名字。
//   它们写成 `BrowserWindow.fromWebContents(e.sender) || mainWindow`，因为 `||` 短路，
//   平时右侧不求值 ⇒ **不报错、功能看着正常**；只有 fromWebContents 返回空
//   （发送方 webContents 已销毁 / 不属于任何 BrowserWindow）时才抛
//   `ReferenceError: mainWindow is not defined`。
//   这与 2026-10-30 修掉的 `voiceState` 是同一族：看起来接好的线，其实一端悬空。
// ★ 为什么是「提到模块作用域」而不是「6 处各改 getAllWindows()[0]」：
//   后者会把语义从「主窗口」偷换成「任意一个窗口」（本文件还有桌宠窗口 petWindow），
//   是一个为了绕开作用域而引入的行为变化。提到模块作用域语义一字不变。
// ★ 单例保证：本应用有 requestSingleInstanceLock，且 createWindow 内有复用守卫，
//   所以这个变量永远只有一个实例，不需要按窗口区分。
let mainWindow;

// ============================================================================
// 「后台常驻」设置（托盘 / 关窗不退出 / 开机自启）
// ----------------------------------------------------------------------------
// 落盘到 userData/desktop.json，与后端业务配置 config.json 分开，避免互相污染。
// 读取一律「默认值 ∪ 磁盘值」，任何异常都回落到默认值，绝不因坏文件卡死启动。
// ============================================================================
const RESIDENT_DEFAULTS = {
  // 关闭主窗口时是否「最小化到托盘」继续常驻。
  // 默认 true：定时任务（每天早 9 点自动跑经营诊断等）要求进程在无人值守时仍存活，
  // 关窗即退会让定时任务彻底失效 —— 这比没有定时任务更糟（会静默漏跑）。
  closeToTray: true,
  // 是否已经给用户发过「已最小化到托盘」的一次性告知（只提示一次，避免打扰）。
  trayNoticeShown: false,
  // 开机自动启动。默认关闭：默认自启会惹人烦，必须由用户显式开启。
  openAtLogin: false,
  // 「生成对话记忆」（B 阶段 #249）：是否允许豆芽从对话中提取并记住上下文。
  //
  // ★ 默认 true，且这里是**唯一的权威默认值**（backend.js 的 memoryEnabled() 读不到文件时
  //   也按 true 处理 —— 两头一致，不会出现"设置页显示开、后端按关跑"的错位）。
  // ★ 为什么默认开而不是默认关：记忆是"越用越懂你"的核心能力。若因读不到设置就默认关掉，
  //   用户遇到的是"它怎么什么都不记得"，而这是一个**没有任何报错**的故障 ——
  //   比误记一条更糟（误记看得见、漏记看不见）。
  // ★ 语义边界：本开关**只关抽取，不关 Secret 拦截门**。Secret 是产品级硬规则
  //   （设计稿第 537 行），不提供"用户自行决定"的余地。关掉记忆后抽取器根本不跑，
  //   Secret 门自然没有被绕过的可能 —— 与"跳过一道本该执行的检查"是两件事。
  memoryEnabled: true,
};

/** 「后台常驻」设置文件路径（懒取，避免 app 未就绪时取值）。 */
function residentSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop.json');
}

/** 读取常驻设置：默认值打底 + 磁盘覆盖，字段类型不合法一律忽略。 */
function readResidentSettings() {
  let disk = {};
  try {
    const f = residentSettingsPath();
    if (fs.existsSync(f)) disk = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (e) {
    console.error('[resident] 读取 desktop.json 失败，使用默认值:', e.message);
    disk = {};
  }
  const out = { ...RESIDENT_DEFAULTS };
  if (typeof disk.closeToTray === 'boolean') out.closeToTray = disk.closeToTray;
  if (typeof disk.trayNoticeShown === 'boolean') out.trayNoticeShown = disk.trayNoticeShown;
  if (typeof disk.openAtLogin === 'boolean') out.openAtLogin = disk.openAtLogin;
  // ★ 严格判等：只有磁盘上**明确写着 false** 才算关闭。
  //   用 `!disk.memoryEnabled` 会把「字段缺失」也算成关闭 ⇒ 一次静默降级（记忆不再增长、无报错）。
  if (typeof disk.memoryEnabled === 'boolean') out.memoryEnabled = disk.memoryEnabled;
  return out;
}

/** 合并写入常驻设置，返回写入后的完整设置对象。 */
function writeResidentSettings(patch) {
  const merged = { ...readResidentSettings(), ...(patch || {}) };
  try {
    fs.writeFileSync(residentSettingsPath(), JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error('[resident] 写入 desktop.json 失败:', e.message);
  }
  return merged;
}

// ============================================================================
// 主题（2026-11-08 · 主题二期）：主进程必须**自己读得到**当前主题
// ----------------------------------------------------------------------------
// 【为什么不能只用渲染层的 localStorage】
//   `BrowserWindow.backgroundColor` 是**首帧之前**的窗口底色，必须在 `new BrowserWindow()`
//   那一刻就定下来；写晚了（等渲染层起来再 set）用户在深色主题下冷启动时早就看见一片
//   浅灰（原代码写死 `#f5f5f7`，注释还写着"与浅色主题的 --bg-window 一致"）。
//   而那一刻渲染进程还没起来，主进程读不到 localStorage。
//   ⇒ 渲染层每次切主题都经 `theme:set` 同步一份 JSON 到这里，主进程下次启动直接读它。
//
// 【文件位置】userData/theme.json，与 desktop.json / wanx.json 同目录、互不污染。
//   读取一律容错：文件缺失 / 坏 JSON / 非法值 ⇒ 回落 `light`（= 新默认），绝不因它卡启动。
//   绿色主题已下线（用户要求只留白 / 深）：老 theme.json 里的 `green` 由
//   `normalizeThemeKey` **显式**映射成 `light`（与渲染层 themeStore 同一口径）——
//   否则存量用户冷启动会拿到绿主题的窗口底色 #f5f5f7，而渲染完是白色的 #f6f7f7。
// ============================================================================
const THEME_DEFAULT_KEY = 'light';
const THEME_KEYS = ['light', 'dark'];

/**
 * 两套主题的窗口底色 —— 与 `src/renderer/styles/theme-tokens.css` 里
 * `--c-bg-window` 的两套值**逐位对齐**（白 #f6f7f7 / 深 #171a18）。
 * ⚠️ 改这里必须同时改那边，否则启动瞬间的底色和渲染完的底色会差一档（看得出来）。
 */
const THEME_WINDOW_BG = { light: '#f6f7f7', dark: '#171a18' };

/** 主题文件路径（懒取：`app.getPath` 在 app ready 之前不可用）。 */
function themeSettingsPath() {
  return path.join(app.getPath('userData'), 'theme.json');
}

/**
 * 归一化主题 key：只认两个合法值，其余一律回落默认（与渲染层 themeStore 同一口径）。
 * ★ 存量值 `green`（已下线的默认主题）⇒ `light`（新默认），语义等价、无需迁移文件。
 */
function normalizeThemeKey(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'green') return 'light';
  return THEME_KEYS.includes(s) ? s : THEME_DEFAULT_KEY;
}

/** 读存盘主题（读不到 / 读坏了 ⇒ 默认白色主题）。 */
function readStoredTheme() {
  try {
    const f = themeSettingsPath();
    if (!fs.existsSync(f)) return THEME_DEFAULT_KEY;
    const j = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    return normalizeThemeKey(j.theme);
  } catch (e) {
    console.error('[theme] 读取 theme.json 失败，按默认白色主题处理:', e.message);
    return THEME_DEFAULT_KEY;
  }
}

/** 写存盘主题，返回归一化后的 key。写失败也返回 key —— 本次会话的窗口底色照换不误。 */
function writeStoredTheme(theme) {
  const key = normalizeThemeKey(theme);
  try {
    fs.writeFileSync(themeSettingsPath(), JSON.stringify({ theme: key }, null, 2));
  } catch (e) {
    console.error('[theme] 写入 theme.json 失败:', e.message);
  }
  return key;
}

/**
 * 发一条系统通知。返回 { ok, error }，**绝不静默失败**：
 * 平台不支持 / 抛异常都如实回传，交给调用方（渲染层）决定是否降级成页内 toast。
 * @param {{title?:string, body?:string, silent?:boolean, onClick?:Function}} opts
 * @returns {{ok:boolean, error?:string}}
 */
function sendSystemNotification(opts = {}) {
  const title = String(opts.title || '豆芽');
  const body = String(opts.body || '');
  try {
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
      return { ok: false, error: '当前系统不支持系统通知' };
    }
    const n = new Notification({ title, body, silent: !!opts.silent });
    if (typeof opts.onClick === 'function') {
      n.on('click', () => { try { opts.onClick(); } catch {} });
    }
    n.show();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '通知发送失败' };
  }
}

// 自定义窗口控制按钮：关闭 / 最小化 / 最大化（放大/还原共用 toggleMax）
ipcMain.handle('win:control', (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  if (!w || w.isDestroyed()) return;
  if (action === 'minimize') w.minimize();
  else if (action === 'toggleMax') { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
  else if (action === 'close') w.close();
});

// 查询窗口当前是否最大化：渲染层顶栏按钮据此在 最大化□ / 还原❐ 之间切换图标。
// 只回答「发起请求的那个窗口」（fromWebContents），避免主窗与桌宠窗口互相串状态。
ipcMain.handle('win:isMaximized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  return !!(w && !w.isDestroyed() && w.isMaximized());
});

// ---- 主题（2026-11-08 · 主题二期）----
// 这两条只为解决「窗口底色必须在窗口创建前定下来」这一件事：
//   theme:get —— 渲染层查询主进程记的主题（`<html data-theme>` 仍以 localStorage 为准，
//                这里只是给「对一下账」留的口子，本轮 UI 不用它）。
//   theme:set —— 渲染层切主题后同步：落 userData/theme.json + 立刻换当前窗口底色。
// ★ 两条都不抛：主题存不上不能把切换动作带崩（用户点了没反应比存不住更糟）。
ipcMain.handle('theme:get', () => readStoredTheme());
ipcMain.handle('theme:set', (_e, theme) => {
  const key = writeStoredTheme(theme);
  // 立刻改当前窗口底色：否则「深色 → 绿色」之后窗口在 resize / 从最小化恢复时
  // 用来补白的那一帧仍是深色（Electron 的 backgroundColor 就是这段瞬时补白的颜色）。
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(THEME_WINDOW_BG[key]);
  } catch (e) {
    console.error('[theme] setBackgroundColor 失败（下次启动会自动修正）:', e.message);
  }
  return key;
});

// ---- 客服助手：留言/反馈提交（主进程代理；渲染层只经 preload 的 window.api.invoke）----
// 语义边界（照本仓「渲染层绝不直连外网」铁律 + GEO 代理同款范式）：
//   · 2MB 上限在 supportProxy.validateFeedbackPayload 里实施 ⇒ 超限在此**拒绝**、带明确
//     code/status(=413) 与中文提示，**绝不静默截断**；
//   · 该接口**无需鉴权**，转发时**不加** Authorization；
//   · 永不自抛：submitFeedback 已把网络/超时归一为 { ok:false, error }，这里再兜一层。
ipcMain.handle('support:submit', async (_e, payload = {}) => {
  try {
    return await supportProxy.submitFeedback(payload);
  } catch (e) {
    return { ok: false, error: '反馈提交失败：' + ((e && e.message) || e) };
  }
});

// ---- 本地文件选择（上传/让 AI 读本地文件）----
// 选文件：弹系统文件选择框，支持多选；返回 { canceled, filePaths }
ipcMain.handle('file:pick', async (e, opts = {}) => {
  const w = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const filters = [
    { name: '所有支持的文件', extensions: ['txt', 'md', 'csv', 'json', 'docx', 'doc', 'pdf', 'xlsx', 'xls', 'pptx', 'ppt', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'py', 'js', 'ts', 'html', 'css', 'log', 'xml', 'yml', 'yaml', 'zip'] },
    { name: '文档', extensions: ['docx', 'doc', 'pdf', 'txt', 'md'] },
    { name: '表格', extensions: ['xlsx', 'xls', 'csv'] },
    { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] },
    { name: '所有文件', extensions: ['*'] },
  ];
  const r = await dialog.showOpenDialog(w, {
    title: opts.title || '选择文件（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters,
  });
  if (r.canceled) return { canceled: true, filePaths: [] };
  return { canceled: false, filePaths: r.filePaths };
});

// 选文件夹：让 AI 浏览某目录
ipcMain.handle('file:pickFolder', async (e, opts = {}) => {
  const w = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const r = await dialog.showOpenDialog(w, {
    title: opts.title || '选择文件夹',
    properties: ['openDirectory'],
  });
  if (r.canceled) return { canceled: true, filePaths: [] };
  return { canceled: false, filePaths: r.filePaths };
});

// 拖拽文件：Electron 里 File 对象拿不到真实路径，用 webUtils.getPathForFile 取绝对路径
ipcMain.handle('file:getPath', async (e, file) => {
  try { return webUtils.getPathForFile(file); } catch { return ''; }
});

// 读文件文本（企业大脑/资产库上传用）：只读 utf-8 文本，返回 { ok, content } 或 { ok:false, error }
ipcMain.handle('file:readText', async (_e, p, maxBytes) => {
  const target = String(p || '');
  if (!target) return { ok: false, error: 'empty path' };
  const fs = require('fs');
  const MAX = Number(maxBytes) > 0 ? Number(maxBytes) : 2 * 1024 * 1024; // 默认 2MB 上限
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    if (st.size > MAX) return { ok: false, error: '文件过大（' + Math.round(st.size / 1024) + 'KB，超过 ' + Math.round(MAX / 1024) + 'KB 上限）' };
    const buf = fs.readFileSync(target);
    // 去掉 UTF-8 BOM
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, content: text, size: st.size, name: require('path').basename(target) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 图片缩略图：给渲染层做附件小图预览用（strictly non-fatal，失败返回 {ok:false}）
// 返回契约（冻结）：{ ok:true, dataUrl } | { ok:false, error }。渲染层用
// window.api.invoke('file:readThumb', p, 320) 调用，无需改 preload.js。
ipcMain.handle('file:readThumb', async (_e, p, maxEdge) => {
  try {
    const { readImageAsDataUrl } = require('./visionProvider');
    return readImageAsDataUrl(String(p || ''), { maxEdge: Number(maxEdge) > 0 ? Number(maxEdge) : 320 });
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- 商城商品检索（0.21.14 · 需求 3「AI 补货」）----
// 渲染层调用（**唯一正确形态**，与 `file:readThumb` 同一套 preload 约定）：
//   `window.api?.invoke?.('mmm:searchProducts', { keyword, pageSize })`
// ⚠️ preload 只 expose 了 `window.api.invoke(channel, ...args)` 这一个通用口，
//    没有 `window.douya.mmm.*` 这种命名空间 —— 不要按名字猜一个不存在的方法。
// 返回契约（冻结）：{ ok:true, products:[6 字段], totalCount, count } | { ok:false, error }
// ★ 任何 throw 都 catch 成 {ok:false}：这条通道断网 / 商城维护 / 登录过期都必须给界面
//   一个可渲染的空态，绝不允许 reject 到渲染层（那会变成一个白屏）。
ipcMain.handle('mmm:searchProducts', async (_e, payload) => {
  try {
    return await shopProducts.searchProducts(payload);
  } catch (e) {
    return { ok: false, error: '商城暂时没响应，稍后再试' };
  }
});

// ---- 打开成果文件 / 在资源管理器定位 / 打开工作区 ----
// 用系统默认程序打开一个文件（或打开一个文件夹窗口）
ipcMain.handle('file:openPath', async (_e, p) => {
  const target = String(p || '');
  if (!target) return { ok: false, error: 'empty path' };
  try {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// 在资源管理器（Finder）里选中并定位到该文件
ipcMain.handle('file:showInFolder', async (_e, p) => {
  const target = String(p || '');
  if (!target) return { ok: false, error: 'empty path' };
  try {
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// 【0.21.21 · 老板 2026-10-21】`mmclaw:schedule-tab` IPC 已删除。
//
// 它原本只为一件事存在：在**上游货源档期 iframe**（内嵌 api.example.com 的档期页）里切到
// 「我要报名」页签 —— 因为跨源 iframe 的 contentWindow 受同源策略保护，渲染进程拿不到
// 页面内的 switchTab()，只能由主进程用 webFrameMain.executeJavaScript 作用在真正的 frame 上。
//
// 档期页在 workbench 侧同步下线、iframe 外壳（renderer/modules/MiaomiaoSchedule.jsx）也一并
// 删除（老板原话「那个页也下线」），这个通道已经没有任何调用方 —— 留在主进程里等于开着一个
// 「能对任意匹配到的 frame 执行脚本」的口子，属于**只增攻击面、零收益**，故整段删除。
// ⚠️ 不要因为「也许以后还要」把它挂回来：真需要时按当时的 frame 结构重写，
//    别把一个已经没人调的白名单通道复活成死代码。

// 打开工作区文件夹
ipcMain.handle('file:openWorkspace', async (_e, p) => {
  const target = String(p || process.env.AGENT_WORKSPACE || '');
  if (!target) return { ok: false, error: 'empty workspace' };
  try {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================================================
// 视频设计（通义万象 3.0）IPC 通道
// ----------------------------------------------------------------------------
// 为什么全部走 IPC：本仓铁律「渲染层绝不直连外网」+ apiKey 只能在主进程。
// 通道设计的三条约定：
//   ① 一律 `invoke` 拿纯数据；**任何一个返回值里都不含完整 key**（只有掩码）。
//   ② 生成产物（视频/图片）是**会过期的签名 URL**，所以 `wanx:save` 一律先下载落地，
//      前端拿的是本地绝对路径 —— 把签名 URL 当长期地址存下来，过几小时就全变成死链。
//   ③ 出错不抛异常，统一 `{ok:false, error}`（含上游 code / request_id，排障靠它）。
// ============================================================================
/**
 * 工作区根（产物目录的父级）。
 *
 * 单独抽一个函数**只有一个理由**：`wanxMediaDir()` / `applyAccountScope()` /
 * `ensureLegacyQuarantine()` 必须用**同一个表达式**算根。两份表达式只要有一天漂移
 * （比如一边认 `AGENT_WORKSPACE`、另一边回落到 homedir），隔离会把文件搬进一个目录、
 * 而读写发生在另一个目录 —— 症状是"作品没了"，且两边都"成功"了，最难查。
 *
 * @returns {string} 工作区根绝对路径
 */
function workspaceRootDir() {
  return process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');
}

/**
 * 当前登录账号名（没有登录态 ⇒ 空串）。**唯一**的账号读取点。
 *
 * ★ 为什么单独抽出来：`wanxMediaDir()`（产物目录）和 `wanxConfigDir()`（配置 + 账本）
 *   必须用**同一个**读取结果。以前只有 wanxMediaDir 一处读者，多一个读者就必须合并 ——
 *   否则两份读法某天漂移（比如一边认 username、另一边退回 id），会派生出
 *   「产物在 A 账号目录、配置在 B 账号目录」的分裂，症状是「作品看得见但提示未配置 key」，
 *   而且两边都"成功"了，最难查。
 *
 * ★ 异常一律吞成空串（= 未登录桶）：调用点在产物链与配置链上，一抛就是两条链一起坏。
 *
 * @returns {string} 账号名；没有登录态 / 读不到 ⇒ ''
 */
function currentAccountUser() {
  try {
    const acc = accountScope.readAccount(app.getPath('userData'));
    return (acc && acc.username) || '';
  } catch { return ''; }
}

/**
 * 落盘目录：工作区下的 `视频设计/accounts/<当前账号段>`，用户能一眼找到。
 *
 * ⚠️ 修复前这里返回 `path.join(root, '视频设计')` —— **没有账号这一维**是本次修复的病根：
 *   同一台机器换账号登录，目录与其中的 `.index.json` 完全不变 ⇒ 作品库互相可见。
 *   本函数是**唯一派生点**（6 个调用点：缩略图副本 / openFolder 默认目录 / listAssets /
 *   mediaDir / status / save + posterStore 的惰性 dir()），所以只改这里就够，调用点一个都不用动。
 *
 * ⚠️ `app.getPath('userData')` 在 app ready 之前**不能调**（会抛）。本函数的调用点
 *   全都在 `whenReady` 之后（`wanx:*` handler 里 / posterStore 的惰性回调 / whenReady 内），
 *   这条约束必须保持；`catch` 只是兜底，不作为"可以提前调"的许可。
 *   兜底语义：拿不到账号 ⇒ 退回未登录桶（`anon`），**不会**退回共享目录。
 *
 * @returns {string} 产物目录绝对路径
 */
function wanxMediaDir() {
  return accountScope.mediaDirFor(workspaceRootDir(), currentAccountUser());
}

/**
 * 视频设计「配置 + 账本」根：`<userData>/wanx/<账号段>`。
 *
 * ★ 老板 2026-11-06 裁决原话：「怎么可以用同一个？？这不是坑么 这个api是我的」
 *   修复前：配置 / key / 账本三份文件全在 `<userData>` **根**下 —— 它们是在
 *   "没有账号这一维"的时期写的 ⇒ 甲配的通义万象 key，乙登录后照用，
 *   **账单记在甲头上**；额度与账本也混在一起。
 *   修复后：按账号段分目录，乙登录后看到的是一份干净的空白配置，账记在乙自己名下。
 *
 * ★ 为什么在 main.js 换根、而不是给 wanxProvider 那 14 个函数加账号参数：
 *   provider 显式**不 require electron**（头注写明：140+ 条单测直接 require 它）。
 *   把「现在是哪个账号」挡在主进程边界上，provider 继续是"给我一个目录我就干活"的纯模块。
 *   代价是这里必须**只有一处**换根 —— 任何一处漏换，那一处就还是全局配置（门禁 K6 钉这条）。
 *
 * ★ 与 `wanxMediaDir()` 同一条约束：`app.getPath('userData')` 在 app ready 之前**不能调**
 *   （会抛）。本函数所有调用点都在 `whenReady` 之后（`wanx:*` handler 内），这条必须保持。
 *   ★ 同一条推论：账号来源必须走 `currentAccountUser()`，与产物目录**同一个**读取结果 ——
 *     两边各读一次看起来一样，但那是两份实现，漂移的代价见该函数头注。
 *
 * @returns {string} 配置根目录绝对路径（文件名仍由 provider 的 configPaths 拼）
 */
function wanxConfigDir() {
  return path.join(app.getPath('userData'), 'wanx', accountScope.accountSegment(currentAccountUser()));
}

/**
 * 读老的**全局**配置里的 apiKey（`<userData>/wanx.json`，即换根之前的那一份）。
 *
 * ★ 只在两种地方用：`wanx:status` 里做「你有一份历史 Key 待认领」的**提示**，
 *   以及 `wanx:importLegacyKey` 这个**显式**导入动作。**绝不参与**正常取 key：
 *   正常取 key 只看 `wanxConfigDir()`，所以 legacy key 不会自动生效到任何账号。
 *   （把它当回落值 = 让乙继续用甲的 key，正是本轮要修的缺陷本身。）
 *
 * ★ 为什么不放进 wanxProvider：provider 不该知道「legacy / 迁移」这个概念 ——
 *   它的契约只有"给我一个目录我就干活"。迁移语义属于主进程的接线层。
 *
 * @returns {string} apiKey；文件不存在 / 不可解析 / 没有 apiKey ⇒ ''
 */
function readLegacyWanxKey() {
  try {
    const p = path.join(app.getPath('userData'), 'wanx.json');
    if (!fs.existsSync(p)) return '';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && typeof j.apiKey === 'string' && j.apiKey.trim()) || '';
  } catch { return ''; }
}

/**
 * legacy key 的掩码 —— **直接复用** `wanx.maskKey`，不另写一份。
 *
 * ★ 2026-11-06 修正：本函数原本自己拼 `slice(0,6) + '...' + slice(-4)`，
 *   注释还写着"与 provider 同口径"，实测三处都不同：
 *     · 短 key 阈值：provider 是 `length < 12`，那份是 `length > 10`（11 位就走了掩码）
 *     · 省略号：provider 用 `…`（U+2026 单字符），那份用 `...`（三个点）
 *     · 短 key 掩码：provider 是 `'*'.repeat(len)`，那份恒 `'***'`
 *   ⇒ 同一个 key 在两处会显示成两种样子，用户会以为不是同一个。
 *   而且"provider 没导出所以只能自己写"这个理由本身是错的：`maskKey` 一直在
 *   `module.exports` 里（provider 的 `status()` 也用它在对外返回体里回掩码）——
 *   它本来就承担展示层语义，复用不会污染纯模块。
 *
 * @param {string} k 明文 key
 * @returns {string} 掩码（与 provider 逐字同一实现）
 */
function maskKeyForLegacy(k) {
  return wanx.maskKey(k);
}

/**
 * 启动时把修复前共享目录里的存量产物隔离到**待认领桶**（`accounts/_unclaimed`）。
 *
 * ★ 归属策略（2026-11-06 老板裁决，两条原文）：
 *     「旧共享目录不能被静默分配给第一个登录的账号。」
 *     「旧数据无法可靠判断归属时，应保留为待认领的历史数据，而不是猜测归属。」
 *   ⇒ 本函数**不接收账号名**，也**不在登录回调里调用**：它只在启动时跑一次，
 *     与"当前是哪个账号"完全无关。`quarantineLegacy` 的签名里同样没有 username ——
 *     两道门（签名 + 调用点）同时关掉"顺手判给当前账号"的可能。
 *
 * ★ 为什么必须在 `applyAccountScope` **之前**调：
 *   隔离是**移动文件**，而 `applyAccountScope` 刷新 `app://` 的媒体授权根。
 *   先搬再刷，"授权根指向的目录"里已经是最终状态；反过来做则有一瞬间
 *   授权根正指着一个正在被搬空的目录（缩略图请求打进去只会拿到 404/403）。
 *
 * ★ 为什么不把 `_unclaimed` 加进媒体授权根：它不属于任何账号。
 *   加进去就等于让当前登录的人能直接浏览这批"不知道是谁的"历史数据
 *   —— 那和"判给第一个登录的账号"是同一种错误的两个变体（都是替用户做归属裁决）。
 *   留在授权根外，媒体协议那边按 fail-closed 直接 403。
 *
 * ★ 为什么在这里（模块作用域）而不是像 `applyAccountScope` 那样放进单实例锁的 else 块：
 *   （⚠️ 这句别写成完整的条件式字面量：`unit-window-placement.mjs` 的 G11/G11b 用裸
 *    indexOf 定位那一行的代码形态，注释里写全了会把锚点拽到注释上 ⇒ G11b 假红。）
 *   本函数不引用 `setAppMediaRoots`（只引用 `accountScope` 与 `workspaceRootDir`），
 *   块内块外都能用。放模块作用域离 `workspaceRootDir` 更近，读起来是一组。
 *
 * 异常一律吞掉：隔离失败最坏的结果是"存量留在原地"，下一次启动还会重试
 * （有失败项时不写标记，见 `quarantineLegacy` ⑤）。启动流程不该被它卡住。
 *
 * @returns {{ok:boolean, reason:string}|null} `quarantineLegacy` 的读数；抛异常 ⇒ null
 */
function ensureLegacyQuarantine() {
  try {
    return accountScope.quarantineLegacy({ workspaceRoot: workspaceRootDir() });
  } catch {
    return null; // 不阻断启动：存量原地不动，下一轮启动再试
  }
}

/**
 * 把用户挑的图片复制一份到 `<媒体根>/_refs/`，供缩略图走受限媒体协议显示。
 *
 * 为什么需要副本：渲染页是 `app://douya`，主窗 `webSecurity` 开着 ⇒ 页面上加载
 * `file://` 必被拦（这就是缩略图裂图的成因）。而媒体协议只开放「视频设计」一个目录，
 * 用户挑的图可能在任意盘 ⇒ 先落一份副本，缩略图读副本，上传仍读原图。
 *
 * 文件名带一个由绝对路径算出的短哈希：同一个文件重复挑不产生新副本，
 * 不同目录的同名文件也不会互相覆盖。失败返回 ''（调用方据此显示占位）。
 */
function copyIntoRefs(src, refsDir) {
  try {
    const abs = path.resolve(String(src || ''));
    if (!abs) return '';
    // 已经就在 _refs 里（例如作品库二次修改选回来的）⇒ 直接用，不再复制一遍
    const rel = path.relative(path.resolve(refsDir), abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
    const base = path.basename(abs).replace(/[\\/:*?"<>|]+/g, '_');
    let h = 0;
    for (let i = 0; i < abs.length; i += 1) h = (h * 31 + abs.charCodeAt(i)) | 0;
    const dest = path.join(refsDir, (h >>> 0).toString(36) + '-' + base);
    if (fs.existsSync(dest)) return dest;
    fs.mkdirSync(refsDir, { recursive: true });
    fs.copyFileSync(abs, dest);
    return fs.existsSync(dest) ? dest : '';
  } catch {
    return '';
  }
}

/**
 * 选参考素材（图片 / 视频 / 音频）。
 *
 * ★ 只回 `path/name/bytes/ext`（图片多一个 `thumbPath`），**绝不在这里把内容编码成 base64**：
 *   20MB 图片转 base64 ≈ 27MB 字符串，走一次 IPC 往返是纯内存浪费。
 *   编码只在提交前由 wanxProvider.fileToDataUrl 做（那时才知道上限是哪一档：
 *   视频首帧 20MB / I2I 单图 10MB —— 在选文件这一步分不清用途）。
 *   `thumbPath` 是复制出来的缩略图副本（见 copyIntoRefs），只为显示，不参与上传。
 */
ipcMain.handle('wanx:pickMedia', async (e, opts) => {
  try {
    const a = opts && typeof opts === 'object' ? opts : {};
    const kind = a.kind === 'video' || a.kind === 'audio' ? a.kind : 'image';
    const FILTERS = {
      image: [{ name: '图片（jpg/png/webp/bmp）', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
      video: [{ name: '视频（mp4/mov）', extensions: ['mp4', 'mov'] }],
      audio: [{ name: '音频（mp3/wav）', extensions: ['mp3', 'wav'] }],
    };
    const TITLES = { image: '选择参考图片', video: '选择参考视频', audio: '选择参考音频' };
    const w = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const r = await dialog.showOpenDialog(w, {
      title: TITLES[kind],
      // 单选时不带 multiSelections：多选会让「只想要一张首帧」的流程变成要手动退掉多余项
      properties: a.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: FILTERS[kind],
    });
    if (r.canceled) return { ok: true, files: [], canceled: true };
    const refsDir = path.join(wanxMediaDir(), '_refs');
    const files = (r.filePaths || []).map((p) => {
      let bytes = 0;
      try { bytes = fs.statSync(p).size; } catch { bytes = 0; }
      const one = { path: p, name: path.basename(p), bytes, ext: path.extname(p).toLowerCase() };
      // ★ 缩略图要用受限媒体协议显示，而媒体授权根只有「视频设计」一个目录。
      //   用户挑的图可以在任意盘任意目录 ⇒ 复制一份进 `<媒体根>/_refs/`，缩略图读副本。
      //   `path` 保持原文件不变（提交时读的还是原图，语义没动）；复制失败就留空，
      //   界面显示占位而不是裂图 —— 宁可没有缩略图，也不要让渲染进程去读授权根外面。
      if (kind === 'image') {
        const copy = copyIntoRefs(p, refsDir);
        if (copy) one.thumbPath = copy;
      }
      return one;
    });
    return { ok: true, files };
  } catch (err) {
    return { ok: false, files: [], error: (err && err.message) || '选择文件失败' };
  }
});

/**
 * 打开产物目录 / 在资源管理器里定位某个文件。
 * `shell.openPath` **有返回值**（失败时是错误字符串），必须判断 —— 不判断就会出现
 * 「点了没反应，也没有报错」，用户只能以为按钮坏了。
 */
ipcMain.handle('wanx:openFolder', async (_e, opts) => {
  try {
    const a = opts && typeof opts === 'object' ? opts : {};
    const target = String(a.path || '').trim();
    if (a.reveal && target) {
      // showItemInFolder 找不到文件时**静默什么都不做**（没有返回值），
      // 所以先自己判一次 —— 否则用户点了「在文件夹中显示」会看到「没反应，也没报错」。
      if (!fs.existsSync(target)) return { ok: false, error: '文件已不在原位置（可能被移动或删除）：' + target };
      shell.showItemInFolder(target);
      return { ok: true, dir: path.dirname(target) };
    }
    const dir = target || wanxMediaDir();
    // 只对默认产物目录做创建：用户自己传进来的路径不该被我们悄悄新建
    if (!target) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建不出来就交给 openPath 报错 */ }
    }
    const err = await shell.openPath(dir);
    if (err) return { ok: false, dir, error: '打开文件夹失败：' + err };
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '打开文件夹失败' };
  }
});

/** 最近生成的产物（读产物目录里的 .index.json；索引坏了也只返回空列表 + error，不抛）。 */
ipcMain.handle('wanx:assets', (_e, opts) => {
  try {
    const a = opts && typeof opts === 'object' ? opts : {};
    return wanx.listAssets(wanxMediaDir(), a.limit);
  } catch (e) {
    return { ok: false, dir: wanxMediaDir(), items: [], error: (e && e.message) || '读取资产列表失败' };
  }
});

/** 产物目录本身（前端显示「存到哪儿」+ 一键打开）。 */
ipcMain.handle('wanx:mediaDir', () => {
  try { return { ok: true, dir: wanxMediaDir() }; }
  catch (e) { return { ok: false, dir: '', error: (e && e.message) || '读取产物目录失败' }; }
});

ipcMain.handle('wanx:status', () => {
  // 第二个参数是产物目录：status 要把「存到哪儿」和素材上限一起吐给界面。
  // 目录的唯一事实源仍然是下面的 wanxMediaDir()，provider 不自己拼工作区路径。
  try {
    const st = wanx.status(wanxConfigDir(), wanxMediaDir());
    // ★ 老的全局 key（`<userData>/wanx.json`）只做**提示**、**绝不自动生效**：
    //   它是在"没有账号这一维"的时期写下的，无法可靠判断属于谁。
    //   按老板裁决，这种情况保留为待认领、由人决定，不替用户猜。
    //   ⇒ 只往 status 里挂一个 `legacyKey` 字段（掩码），前端要不要显示由人决定；
    //     真正迁移必须走 `wanx:importLegacyKey` 这个显式动作。
    try {
      const legacyKey = readLegacyWanxKey();
      if (legacyKey && !st.hasKey) {
        st.legacyKey = { available: true, masked: maskKeyForLegacy(legacyKey) };
      }
    } catch { /* 探测失败不影响 status —— 界面上少一行提示，比整个设置页打不开好 */ }
    return st;
  }
  catch (e) { return { ok: false, error: (e && e.message) || '读取配置失败' }; }
});

ipcMain.handle('wanx:saveKey', (_e, key) => {
  try { return wanx.saveKey(wanxConfigDir(), key); }
  catch (e) { return { ok: false, error: (e && e.message) || '保存失败' }; }
});

/**
 * 把老的全局 key **复制**到当前账号的配置里（登出 / 换账号后各自独立）。
 *
 * ★ 语义是「复制」，**不是「搬走」**：原件 `<userData>/wanx.json` 一个字节都不动。
 *   理由与产物隔离同源 —— 那个文件是在无法判断归属的时期写下的，
 *   删掉它就再也无法把 key 交给另一个**可能才是真正主人**的账号。
 * ★ 必须是**显式动作**（人在界面上点一下），不在任何自动流程里调用：
 *   自动导入等于把"这批配置归当前账号"这个猜测写进代码，而判据恰恰是
 *   「旧数据无法可靠判断归属时，应保留为待认领的历史数据，而不是猜测归属」。
 *
 * @returns {{ok:boolean, masked?:string, error?:string}} 与 `wanx:saveKey` 同形状
 */
ipcMain.handle('wanx:importLegacyKey', () => {
  try {
    const legacyKey = readLegacyWanxKey();
    if (!legacyKey) return { ok: false, error: '没有可导入的历史 Key' };
    return wanx.saveKey(wanxConfigDir(), legacyKey);
  } catch (e) { return { ok: false, error: (e && e.message) || '导入失败' }; }
});

ipcMain.handle('wanx:savePrefs', (_e, patch) => {
  try { return wanx.savePrefs(wanxConfigDir(), patch); }
  catch (e) { return { ok: false, error: (e && e.message) || '保存失败' }; }
});

ipcMain.handle('wanx:budget', () => {
  try { return wanx.budgetSummary(wanxConfigDir()); }
  catch (e) { return { ok: false, error: (e && e.message) || '读取账本失败' }; }
});

ipcMain.handle('wanx:ledger', (_e, limit) => {
  try { return wanx.readLedger(wanxConfigDir(), limit); }
  catch (e) { return { ok: false, error: (e && e.message) || '读取账本失败' }; }
});

ipcMain.handle('wanx:video', async (_e, args) => {
  try { return await wanx.submitVideo(wanxConfigDir(), args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '提交失败' }; }
});

ipcMain.handle('wanx:query', async (_e, taskId) => {
  try { return await wanx.queryTask(wanxConfigDir(), taskId); }
  catch (e) { return { ok: false, error: (e && e.message) || '查询失败' }; }
});

ipcMain.handle('wanx:image', async (_e, args) => {
  try { return await wanx.generateImage(wanxConfigDir(), args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '生成失败' }; }
});

// 下载落地：签名 URL → 工作区本地文件。返回本地绝对路径供前端预览 / 打开文件夹。
// ⚠️ `fallbackExt` 与 `kind` 两者都认：渲染层传的是 `fallbackExt`（见 VideoDesign.jsx 的 land()），
//   而早期只有 `kind`。只认 kind 时，视频会因为 `a.kind !== 'video'` 落到 `.png` —— 存出来的
//   视频文件后缀是 .png，播放器打不开，而字节数是正常的（不报错、最难查）。两个都接住。
// 落地成功后追加资产索引（`.index.json`）：目录里只有一堆 wanx-<ts>.mp4 时，
// 用户没法回答「这条是哪个 prompt 出的、用了哪几张参考图」，索引就是为这个问题存在的。
ipcMain.handle('wanx:save', async (_e, args) => {
  try {
    const a = args || {};
    const kind = a.kind === 'video' ? 'video' : 'image';
    const r = await wanx.downloadMedia({
      url: a.url,
      dir: wanxMediaDir(),
      filename: a.filename,
      fallbackExt: a.fallbackExt || (kind === 'video' ? '.mp4' : '.png'),
    });
    if (!r.ok) return r;
    // 落地成功后追加资产记录。「写索引失败」不影响「文件已经存下来了」这个事实，
    // 所以只附带 indexError，仍然 ok:true —— 把已经成功的保存说成失败，用户会重复下一遍。
    const rec = wanx.appendAsset(wanxMediaDir(), {
      kind,
      localPath: r.path,
      bytes: r.bytes,
      prompt: a.prompt,
      params: a.params,
      taskId: a.taskId,
      mediaKinds: a.mediaKinds,
    });
    if (rec.ok) return Object.assign({}, r, { asset: rec.asset });
    return Object.assign({}, r, { indexError: rec.error });
  } catch (e) { return { ok: false, error: (e && e.message) || '保存失败' }; }
});

// ---- 海报模式（视频设计页第三个模式）的落盘能力 ----
// 与 wanx:save 的区别：wanx 是「URL → 本地」，海报是「渲染层已经画好的 dataURL → 本地」，
// 画布内容只存在于渲染层，主进程拿不到，所以必须由渲染层把字节递过来。
// 实现放在 ./posterStore.js 且**不 require electron**：本仓 140+ 条单测直接 require 主进程
// 模块来跑，顶层引 electron 会让那批单测只能进 Electron 进程 ⇒ 等于没有测试。
// 目录口径复用上面的 wanxMediaDir()，不另造来源（否则「作品在哪」会有两个答案）。
// 父窗口直接给模块作用域的 mainWindow：保存对话框还在等它时窗口可能已被销毁，
// 所以顺手做 isDestroyed 判定，拿不到就退化成无父窗口（只影响是否模态，功能不受影响）。
const posterStore = require('./posterStore');
posterStore.registerIpc({
  ipcMain,
  dialog,
  dir: () => path.join(wanxMediaDir(), 'posters'),
  mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
});

// 工作区根的**唯一**表达式交给 concatStudio（见下方 `workspaceRootDir` 的头注）：
// 它不许 require electron、也不许自己再写一份，所以由这里把函数**本身**注入进去。
// 传函数而不是调用结果：`AGENT_WORKSPACE` 是启动过程中才设上的（见本文件对
// `process.env.AGENT_WORKSPACE` 的赋值），值必须在「真正要建工程」那一刻才求。
concatStudio.setWorkspaceRootResolver(workspaceRootDir);

// ---- 视频精剪（Concat 0.2.9 · MCP over stdio）的 14 条 IPC ----
// 设计口径（改之前先读完会少踩很多坑）：
//   ① **`concat:edit` 一条通道吃掉所有编辑**。前端只用一个入口、靠 `op` 分流，
//      不开「每条 Concat 工具一条通道」（那会是 20+ 条，且每加一个工具就要动 preload）。
//      未知 op **明确报错**，不静默成功 —— 静默成功会让前端在拼错 op 时
//      "点了没反应但界面以为改好了"，时间轴其实是旧的。
//   ② **写操作自己就把新快照带回来了**（`{ok:true, createdId?, ...snapshot}`）。
//      前端一次 IPC 拿到结果，不用再 invoke 一次 `concat:snapshot` ——
//      拖拽热路径上少一个往返就是少 1/3 的延迟。
//   ③ **这两个通道必须有主进程**：`pickMedia` / `pickOutput` 要 `dialog`，
//      而 `concatStudio.js` 不许 require electron（本仓 140+ 条单测在纯 node 里 require 它）。
//      所以"选文件"留在这里，"操作工程"在模块里 —— 这不是随意切分，是被测试约束逼出来的。
//   ④ 全部 `try/catch` 返回 `{ok:false, error}`，与 `wanx:*` 那批一致；
//      即便 concatStudio 自己承诺不抛，外层也要兜住 —— 一个抛出去的异常在这里
//      会变成渲染层看不懂的 `Error invoking remote method 'concat:xxx'`。
ipcMain.handle('concat:probe', async () => {
  try { return await concatStudio.probe(); }
  catch (e) { return { ok: false, installed: false, toolCount: 0, mode: 'mcp-stdio', path: '', version: '', error: (e && e.message) || '探测失败' }; }
});

// 有 path 就打开既有工程，否则用 location+name 新建一个。
ipcMain.handle('concat:open', async (_e, args) => {
  try { return await concatStudio.openProject(args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '打开工程失败' }; }
});

ipcMain.handle('concat:close', async (_e, args) => {
  try { return await concatStudio.closeProject(args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '关闭工程失败' }; }
});

ipcMain.handle('concat:snapshot', async () => {
  try { return await concatStudio.snapshot(); }
  catch (e) { return { ok: false, error: (e && e.message) || '读取工程失败' }; }
});

ipcMain.handle('concat:importMedia', async (_e, args) => {
  try { return await concatStudio.importMedia(args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '导入素材失败' }; }
});

// 选素材：视频 / 音频 / 图片三组 + 全部文件，可多选。
// `all` 那组必须留：用户的素材可能是 .mts / .flv / .gif，卡在三组过滤器上会变成
// 「我的文件在选择框里看不见」—— 那是用户无法自助解决的问题。
ipcMain.handle('concat:pickMedia', async () => {
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const opts = {
      title: '选择要导入的素材',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] },
        { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    };
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (!r || r.canceled) return { ok: false, canceled: true, files: [] };
    return { ok: true, files: Array.isArray(r.filePaths) ? r.filePaths : [] };
  } catch (e) { return { ok: false, files: [], error: (e && e.message) || '选择素材失败' }; }
});

// 选导出位置：另存为 .mp4。defaultName 由渲染层按工程名给，缺省用「视频精剪.mp4」。
ipcMain.handle('concat:pickOutput', async (_e, args) => {
  try {
    const a = args && typeof args === 'object' ? args : {};
    const defaultName = typeof a.defaultName === 'string' && a.defaultName.trim()
      ? a.defaultName.trim()
      : '视频精剪.mp4';
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const opts = {
      title: '导出视频',
      defaultPath: path.join(app.getPath('videos') || app.getPath('documents'), defaultName),
      filters: [{ name: '视频', extensions: ['mp4'] }],
    };
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true, path: '' };
    // 用户在另存为框里手打掉后缀时补回来 —— Concat 按扩展名决定封装格式，
    // 没有 .mp4 会写出一堆识别不了的文件。
    let out = r.filePath;
    if (!/\.mp4$/i.test(out)) out += '.mp4';
    return { ok: true, path: out };
  } catch (e) { return { ok: false, path: '', error: (e && e.message) || '选择导出位置失败' }; }
});

// 唯一的编辑入口。op 见 src/main/concatStudio.js 的 EDIT_OPS（16 个）。
ipcMain.handle('concat:edit', async (_e, payload) => {
  try { return await concatStudio.edit(payload || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '编辑失败' }; }
});

// 抽一帧当预览图。返回 dataURL（不写盘），前端直接塞 <img src>。
ipcMain.handle('concat:previewFrame', async (_e, args) => {
  try { return await concatStudio.previewFrame(args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '取预览帧失败' }; }
});

ipcMain.handle('concat:exportStart', async (_e, args) => {
  try { return await concatStudio.exportStart(args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '导出失败' }; }
});

// 进度查询**原样透传** Concat 的字段（前端只轮询这一条；不阻塞，取消按钮才点得动）。
ipcMain.handle('concat:exportStatus', async (_e, args) => {
  try { return await concatStudio.exportStatus(args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '查询导出进度失败' }; }
});

ipcMain.handle('concat:exportCancel', async (_e, args) => {
  try { return await concatStudio.exportCancel(args || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || '取消导出失败' }; }
});

ipcMain.handle('concat:undo', async () => {
  try { return await concatStudio.undo(); }
  catch (e) { return { ok: false, error: (e && e.message) || '撤销失败' }; }
});

ipcMain.handle('concat:redo', async () => {
  try { return await concatStudio.redo(); }
  catch (e) { return { ok: false, error: (e && e.message) || '重做失败' }; }
});

// ---- 语音录音状态（主进程采集，绕开浏览器麦克风） ----
let voiceState = { proc: null, chunks: [], timer: null, active: false, sender: null, finishing: false, deviceName: '', hasSound: false, lastSoundAt: 0 };

// 静音检测自动断句：录到声音后，连续静音超过该时长就自动识别并发送（不用再点一次停止）。
const VOICE_THRESHOLD = 400; // LEVEL 振幅超过它视为"有声音"（正常说话 > 1000，静音 < 100）
const SILENCE_MS = 2000;      // 静音持续 2 秒触发自动断句
const NO_SPEECH_MS = 5000;    // 开麦后一直没说话，超过该时长自动静默关闭麦克风（不识别、不报错）

// 把 asar 内的 mic_record.py 写出到真实临时文件（外部 python 进程无法读取 asar）
let micScriptPath = null;
function getMicScriptPath() {
  if (micScriptPath && fs.existsSync(micScriptPath)) return micScriptPath;
  const inside = path.join(app.getAppPath(), 'src/main/mic_record.py');
  const tmp = path.join(app.getPath('temp'), 'douya_mic_record.py');
  fs.writeFileSync(tmp, fs.readFileSync(inside));
  micScriptPath = tmp;
  return tmp;
}

function pythonBin() {
  // ★ 2026-10-23：这里原本是**第三份**「python 是谁」的实现（只看 PYTHON_RUNTIME_DIR，不认 PYTHON_PATH、
  //   也不查存在性）。三份实现意味着同一个产品里 python 可能是三个不同的解释器 ——
  //   端到端实测已因此让模型对用户编出「本机缺少组件」的假话（见 src/shared/pythonRuntime.js 头部）。
  //   现在统一走 shared 的真源，这里仅保留函数名（多处调用方依赖它）。
  return sharedPython.resolvePython().exe;
}

// ---- TTS 语音合成（菇菇语音回复，火山豆包 TTS 2.0） ----
// 合成语音：返回音频文件绝对路径（失败返回 null）
async function synthTts(text, voice) {
  const cfg = getConfig();
  const apiKey = (cfg && cfg.ttsApiKey) || (cfg && cfg.asrApiKey) || (cfg && cfg.apiKey);
  if (!apiKey) return null;
  const voiceName = voice || (cfg && cfg.ttsVoice) || 'zh_female_tianmeixiaoyuan_uranus_bigtts';
  const outDir = path.join(app.getPath('userData'), 'tts');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, 'tts_' + Date.now() + '.mp3');
  try {
    const audioBuf = await volcanoTTS(apiKey, text, voiceName);
    fs.writeFileSync(outPath, audioBuf);
    return outPath;
  } catch (e) {
    console.error('[tts]', e && e.message);
    return null;
  }
}

ipcMain.handle('tts:speak', async (_e, text) => {
  if (!text || !String(text).trim()) return { ok: false };
  const p = await synthTts(String(text).slice(0, 500));
  if (p) {
    try {
      const data = fs.readFileSync(p);
      return { ok: true, data: data.toString('base64'), format: 'mp3' };
    } catch (e) {
      console.error('[tts] read file error', e.message);
      return { ok: false };
    }
  }
  return { ok: false };
});


async function finishVoice() {
  // 防止自动超时与手动停止并发触发两次
  if (voiceState.finishing) return;
  voiceState.finishing = true;

  const sender = voiceState.sender;
  voiceState.active = false;
  if (voiceState.timer) { clearTimeout(voiceState.timer); voiceState.timer = null; }

  const proc = voiceState.proc;
  voiceState.proc = null;
  if (proc) { try { proc.kill('SIGKILL'); } catch {} }

  // 给 python 一点时间 flush 并退出
  await new Promise((r) => setTimeout(r, 350));

  const pcm = Buffer.concat(voiceState.chunks.length ? voiceState.chunks : [Buffer.alloc(0)]);
  voiceState.chunks = [];

  // 计算 PCM 最大振幅，判断是否真正录到声音
  let maxAmp = 0;
  for (let i = 1; i < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i - 1));
    if (v > maxAmp) maxAmp = v;
  }

  let result = { text: '' };
  if (pcm.length < 800) {
    result = { error: '录音太短，请重试（按住说话至少 1 秒）' };
  } else if (maxAmp < 300) {
    result = {
      error:
        '麦克风没录到声音：当前设备没有输入。请到「设置 → 麦克风」测试并换一个设备，或检查麦克风是否被系统静音。',
    };
  } else {
    let text = '';
    let lastErr = '';
    const cfg = getConfig();
    if (cfg && cfg.asrApiKey) {
      try {
        text = await volcanoRecognizeREST(cfg.asrApiKey, pcm);
      } catch (e) {
        lastErr = e.message;
      }
    }
    if (text) result = { text };
    else result = { error: lastErr || '识别为空，请再清楚地说一遍' };
  }

  if (sender) sender.send('voice:result', result);
  voiceState.finishing = false;
  voiceState.sender = null;
}

// 停止录音（不阻塞：立即结束进程，识别结果稍后通过 voice:result 推送）
function stopRecording() {
  voiceState.active = false;
  if (voiceState.timer) { clearTimeout(voiceState.timer); voiceState.timer = null; }
  const proc = voiceState.proc;
  voiceState.proc = null;
  if (proc) { try { proc.kill('SIGKILL'); } catch {} }
}

// 静默取消录音：开麦后一直没说话（NO_SPEECH_MS 内无声音），自动关闭麦克风。
// 不识别、不报错，只发 voice:cancelled 通知前端复位 UI。
function cancelVoice() {
  if (!voiceState.active || voiceState.finishing) return;
  voiceState.active = false;
  if (voiceState.timer) { clearTimeout(voiceState.timer); voiceState.timer = null; }
  const proc = voiceState.proc;
  voiceState.proc = null;
  if (proc) { try { proc.kill('SIGKILL'); } catch {} }
  voiceState.chunks = [];
  voiceState.hasSound = false;
  const sender = voiceState.sender;
  voiceState.sender = null;
  if (sender && !sender.isDestroyed()) sender.send('voice:cancelled');
}

ipcMain.handle('voice:start', (event, device) => {
  // 正在识别中则不允许立即重开，避免状态错乱
  if (voiceState.finishing) return { started: false, busy: true };
  if (voiceState.active) return { started: true };

  let proc;
  try {
    const args = ['--stream'];
    if (typeof device === 'number' && !Number.isNaN(device)) args.push('--device', String(device));
    proc = require('child_process').spawn(pythonBin(), [getMicScriptPath(), ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    event.sender.send('voice:error', '启动录音失败：' + e.message);
    return { started: false };
  }

  voiceState.proc = proc;
  voiceState.active = true;
  voiceState.sender = event.sender;
  voiceState.chunks = [];
  voiceState.deviceName = '';
  voiceState.hasSound = false;
  voiceState.lastSoundAt = Date.now();

  proc.stdout.on('data', (d) => voiceState.chunks.push(Buffer.from(d)));
  proc.stderr.on('data', (d) => {
    // 【解码分类：stderr 且末尾会进 console.error 给人看 → GBK 回退】
    //   这条流里既有 `LEVEL `/`DEVICE ` 这种**纯 ASCII 控制行**（decodeOutput 对纯 ASCII
    //   原样返回，不影响 parseInt / startsWith 的判据），也有 `[mic]` 之外的**异常文案**
    //   ——后者会走下面 `console.error('[mic]', t)`，中文 Windows 上按 utf-8 硬解就是一串 `�`。
    //   实测依据见 src/main/childOutput.js 头部（cmd.exe stderr 是 cp936）。
    const s = decodeOutput(d);
    for (const line of s.split('\n')) {
      const t = line.trim();
      if (t.startsWith('LEVEL ')) {
        const v = parseInt(t.slice(6), 10);
        const now = Date.now();
        // 静音检测：录到声音后，连续静音 SILENCE_MS 自动断句（识别 + 发送），无需再点一次停止
        if (Number.isFinite(v) && v >= VOICE_THRESHOLD) {
          voiceState.hasSound = true;
          voiceState.lastSoundAt = now;
        }
        // 无声音超时：开麦后一直没说话（NO_SPEECH_MS），自动静默关闭，不识别不报错
        if (!voiceState.hasSound && !voiceState.finishing && voiceState.active && now - voiceState.lastSoundAt >= NO_SPEECH_MS) {
          cancelVoice();
          return;
        }
        if (voiceState.hasSound && !voiceState.finishing && now - voiceState.lastSoundAt >= SILENCE_MS) {
          finishVoice();
        }
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('voice:level', Number.isFinite(v) ? v : 0);
        }
      } else if (t.startsWith('DEVICE ')) {
        voiceState.deviceName = t.slice(7) || '';
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('voice:device', voiceState.deviceName);
        }
      } else if (t && !t.startsWith('[mic]')) {
        console.error('[mic]', t);
      }
    }
  });
  proc.on('error', (e) => {
    if (voiceState.active && event.sender && !event.sender.isDestroyed()) {
      event.sender.send('voice:error', '录音进程异常：' + e.message);
    }
  });

  // 最长 30 秒自动停止并识别
  voiceState.timer = setTimeout(() => finishVoice(), 30000);
  return { started: true, deviceName: voiceState.deviceName };
});

ipcMain.handle('voice:stop', () => {
  if (!voiceState.active) return { stopped: true };
  // 立即结束进程并解锁 UI，识别结果稍后通过 voice:result 推送
  stopRecording();
  finishVoice();
  return { stopped: true };
});

// 列出所有输入设备（供设置页选择麦克风）
ipcMain.handle('voice:listDevices', () => {
  return new Promise((resolve) => {
    const ps = require('child_process').spawn(pythonBin(), [getMicScriptPath(), '--list'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    // 【解码分类：stdout → JSON.parse ⇒ **严格 utf-8，不做 GBK 回退**】
    //   mic_record.py --list 输出的是 JSON。JSON 规范只允许 UTF-8，给 JSON 做 GBK 回退
    //   会把本来正确的 JSON 解成乱码从而解析失败 —— 那是拿"显示问题"换"功能故障"。
    //   这里显式写 'utf8'（等价于裸 toString()，但把意图钉死，避免后人"顺手统一"成 decodeOutput）。
    //   同理 python 侧的编码由 skills.js 的 PYTHONIOENCODING/PYTHONUTF8 强制为 utf-8。
    ps.stdout.on('data', (d) => (out += d.toString('utf8')));
    ps.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve([]); }
    });
    ps.on('error', () => resolve([]));
  });
});

// 测试某设备的录音电平，返回最大振幅（整数），用于设置页电平表
ipcMain.handle('voice:testLevel', (_e, device) => {
  return new Promise((resolve) => {
    const args = ['--test'];
    if (typeof device === 'number' && !Number.isNaN(device)) args.push('--device', String(device));
    const ps = require('child_process').spawn(pythonBin(), [getMicScriptPath(), ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    // 【解码分类：stdout → parseInt ⇒ 严格 utf-8，不做 GBK 回退】
    //   mic_record.py --test 只吐一个 ASCII 整数（如 "1234"）。这属于"结构化取值"，
    //   一旦允许 GBK 回退，将来有人给它加个中文状态行就可能把数字本身解坏。
    //   纯 ASCII 下 utf8 与 gbk 结果相同，所以这里**没有**乱码风险，保持严格即可。
    ps.stdout.on('data', (d) => (out += d.toString('utf8')));
    ps.on('close', () => {
      const v = parseInt(out.trim(), 10);
      resolve(Number.isFinite(v) ? v : 0);
    });
    ps.on('error', () => resolve(0));
  });
});

// ---- 工作记录持久化（append-only 事件日志为权威真源；旧 sessions.json 只读兼容回退） ----
// ★ 2026-11-04 运行底座 P2：原来 writeStore 用 fs.writeFileSync 全量覆盖 sessions.json，
//   一次半行写入 / 崩溃就能把全部会话抹掉且没有任何历史可退。现在只往
//   `sessions.events.jsonl` append（每行一条全量快照，阶段 1 形态），不覆盖、不双写。
//   ⚠️ 旧 sessions.json **从今往后只读**：它只是「迁移前的存量」，回退条件在下面收紧到
//      只有「事件文件不存在 / 大小为 0」两种。文件名、IPC 通道名与返回契约一字不改。
const sessionEventLog = require('./sessionEventLog');
const STORE_PATH = path.join(app.getPath('userData'), 'sessions.json');
const SESSION_EVENT_PATH = path.join(app.getPath('userData'), 'sessions.events.jsonl');
sessionEventLog.init({ dir: app.getPath('userData') });

/** 旧快照的回退条件：**只允许**「事件文件不存在」或「事件文件大小为 0」。 */
function legacyStoreAvailable() {
  try {
    return fs.statSync(SESSION_EVENT_PATH).size === 0;
  } catch {
    return true;   // 读不到 stat ⇒ 事件文件不存在
  }
}

function readStore() {
  const rb = sessionEventLog.rebuild();
  if (rb.suspect) {
    console.error('[store] sessions.events.jsonl 中间坏行（疑似数据损坏），只返回最后已知状态，拒绝回退旧快照',
      rb.suspectLines || []);
  }
  if (rb.ok && rb.data && typeof rb.data === 'object') return rb.data;
  // ★ 事件文件存在且非空，却拿不到完整快照（全坏行 / 合法空态 / hadEvents:false）⇒
  //   **绝不回退**旧 sessions.json。回退会让「迁移后全部会话永久丢失且旧快照永不更新」：
  //   新写入只进事件日志，旧文件停在迁移前那一刻，每次重开都把用户踢回那一刻。
  //   旧文件 mtime 更新也不构成理由 —— 它已经不是真源了。
  if (!legacyStoreAvailable()) {
    console.error('[store] sessions.events.jsonl 已存在且非空但没有完整快照，拒绝回退旧快照',
      { badLines: rb.badLines, hadEvents: rb.hadEvents, seq: rb.seq, trailingBadLine: rb.trailingBadLine });
    return { currentId: null, items: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { currentId: null, items: {} };
  }
}
function writeStore(obj) {
  // 只 append 事件日志；**不**再写 STORE_PATH（不双写、不覆盖）。
  try {
    sessionEventLog.appendSnapshot(obj || { currentId: null, items: {} });
  } catch { /* 旁路：持久化失败不影响 IPC 返回契约 */ }
}
ipcMain.handle('store:get', () => readStore());
ipcMain.handle('store:set', (_e, obj) => {
  writeStore(obj || { currentId: null, items: {} });
  return true;
});

// ---- 单实例锁 ----
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // ★★ 2026-10-22：原来这里只有一行 app.quit() —— 用户双击图标"什么都没发生"，
  //   而真实原因（已经有一个豆芽在跑）**一个字都没告诉他**。这是"打不开"投诉里
  //   最容易被误判成"程序坏了"的一种。
  //
  //   正常情况下用户看不到这个框：第二次启动会唤醒第一个实例的 'second-instance'
  //   监听，那边会把窗口召回到前台。能看到它的只有两种真故障：
  //     · 第一个实例还卡在启动流程里，'second-instance' 监听尚未注册；
  //     · 第一个实例崩过 / 被强杀过，锁却没释放（残留进程）。
  //   两种都值得说清楚，而不是让用户对着一个"没反应"的图标反复双击。
  try {
    dialog.showErrorBox(
      '豆芽AI 已经在运行',
      '豆芽AI 已经启动过了，请在任务栏或系统托盘里找它的图标。\n\n'
      + '如果找不到窗口，说明之前那次启动没有正常完成。请打开任务管理器，'
      + '结束所有「豆芽AI」进程后再重新打开。'
    );
  } catch { /* 对话框本身失败也不能挡住退出 */ }
  app.quit();
} else {
  // ---- 注册 app:// 为特权 scheme ----
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);

  // ---- 麦克风权限 ----
  function setupPermissions() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(['media', 'microphone', 'audioCapture', 'audio'].includes(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission) => {
      return ['media', 'microphone', 'audioCapture', 'audio'].includes(permission);
    });
  }

  // ---- 【0.21.21 · 老板 2026-10-21】`setupMmclawAuthInjection()` 已删除 ----
  // 它原本只为一件事存在：给**内嵌的上游货源档期 iframe**（https://api.example.com 的档期页）
  // 免登 —— EXE 的 token 存在 app://douya 源的 localStorage，跨源 iframe 读不到，
  // 故由主进程在 webRequest.onBeforeSendHeaders 上给 `https://api.example.com/api/*`
  // 注入 `Authorization: Bearer <token>`。
  //
  // 档期页在 workbench 侧下线、iframe 外壳（renderer/modules/MiaomiaoSchedule.jsx）也删了
  // （老板原话「那个页也下线」）⇒ 这段注入没有任何 frame 会命中，属于纯死代码。
  // 删掉它的额外收益：**少一个向外部域自动附加自家 token 的全局钩子**，
  // 这是安全面上实打实的收敛（哪怕它原来只匹配一个很窄的 URL 通配）。
  //
  // ⚠️ 别把它当成「客服助手反馈也要用」而挂回来：反馈转发走的是**主进程 fetch**
  //    （见本文件顶部关于 api.example.com/api/feedback 的说明），根本不经过 session 的
  //    webRequest，所以删掉它不影响反馈功能。
  // ⚠️ `getConnectorManager` / `getTokenSync` 本身**保留** —— 它们还有其它消费者，
  //    这里删的只是「往 api.example.com 请求头里塞 token」这一个调用点。

  // MIME 类型映射
  function mimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      // 参考图允许 webp / bmp（见 wanx:pickMedia 的 filters），产物也可能是 webp。
      // 给成 octet-stream 时 <img> 不报错但也不显示 —— 看着就像"裂图"，很难查。
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
      '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      // 登录页背景视频/音频：打包后走 app:// 自定义协议，必须给对 MIME，
      // 否则 <video> 会拿到 application/octet-stream 而拒绝播放（黑屏）。
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    };
    return map[ext] || 'application/octet-stream';
  }

  // 工作区目录
  process.env.AGENT_WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');

  // ★ mainWindow 不在这里声明 —— 它在模块作用域（见文件上方 `let mainWindow;` 的注释）。
  //   这里是 `app.whenReady()` 的回调体，是**另一个作用域**；在这里再声明一次会遮蔽外层，
  //   让模块作用域那 6 处兜底重新读到一个悬空名字（这正是 2026-10-30 修掉的那个 bug 的形状）。
  let petWindow;

  // ---- 后台常驻状态 ----
  // tray：系统托盘（召回主窗 / 退出 / 开关）；isQuitting：真退出标志。
  // ⚠️ isQuitting 是托盘应用最容易踩的坑：没有它，「关闭窗口」拦截会连托盘「退出」一起拦掉，
  // 导致应用再也退不掉。只有在 before-quit（或托盘「退出豆芽」）时才置 true。
  let tray = null;
  let isQuitting = false;
  // 定时任务调度器（第三层能力）。在 startBackend + createTray 之后装配并启动。
  let automations = null;

  // ---- 桌宠窗口 ----
  let petCollapsed = true; // 默认收起
  const PET_MARGIN = 16; // 与屏幕右下角的边距
  const PET_SIZE_COLLAPSED = { width: 208, height: 118 };
  const PET_SIZE_EXPANDED = { width: 340, height: 480 };

  // 计算桌宠右下角锚定坐标（紧贴屏幕右下，留边距）
  function petBottomRight(size) {
    const { workArea } = screen.getPrimaryDisplay();
    return {
      x: Math.round(workArea.x + workArea.width - size.width - PET_MARGIN),
      y: Math.round(workArea.y + workArea.height - size.height - PET_MARGIN),
    };
  }

  function applyPetBounds(size) {
    if (!petWindow || petWindow.isDestroyed()) return;
    const b = petWindow.getBounds();
    // 保持右下角锚定不变，向左上方扩展/收缩
    petWindow.setBounds({
      x: b.x + b.width - size.width,
      y: b.y + b.height - size.height,
      width: size.width,
      height: size.height,
    }, true);
  }

  function createPetWindow() {
    if (petWindow) { try { petWindow.focus(); } catch {} return; }
    const pos = petBottomRight(PET_SIZE_COLLAPSED);
    petWindow = new BrowserWindow({
      ...PET_SIZE_COLLAPSED,
      ...pos,
      frame: false,
      // 用户要求透明背景 + 删外框：窗体完全透明，图片悬浮在桌面。
      // 内容区（pet-collapsed / pet-expanded）的半透明深色背景由 CSS 兜底，
      // 保证 Windows 上可见 + 展开态对话框可读。
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
        webSecurity: false, // 允许在 app:// 页面里播放 file:// 的 TTS 音频（混合内容限制）
      },
    });
    // macOS 专用，Windows 会抛异常
    if (process.platform === 'darwin') {
      try { petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
      try { petWindow.setAlwaysOnTop(true, 'floating'); } catch {}
    }
    try { petWindow.removeMenu(); } catch {}
    // 阻止拖文件触发窗口导航（Electron 拖文件进窗口默认会跳转到该文件）
    petWindow.webContents.on('will-navigate', (e, url) => {
      if (url && url !== petWindow.webContents.getURL()) e.preventDefault();
    });

    petWindow.on('closed', () => { petWindow = null; });

    if (!app.isPackaged) {
      petWindow.loadURL('http://localhost:5174');
    } else {
      petWindow.loadURL('app://douya/dist/renderer-pet/index.html');
    }
  }

  // 桌宠 IPC：展开/收起/关闭
  ipcMain.handle('pet:expand', () => {
    petCollapsed = false;
    applyPetBounds(PET_SIZE_EXPANDED);
  });
  ipcMain.handle('pet:collapse', () => {
    petCollapsed = true;
    applyPetBounds(PET_SIZE_COLLAPSED);
  });
  ipcMain.handle('pet:toggle', () => {
    if (petCollapsed) {
      petCollapsed = false;
      applyPetBounds(PET_SIZE_EXPANDED);
    } else {
      petCollapsed = true;
      applyPetBounds(PET_SIZE_COLLAPSED);
    }
  });
  ipcMain.handle('pet:close', () => {
    if (petWindow && !petWindow.isDestroyed()) petWindow.close();
  });

  function createWindow() {
    // 单例守卫：防止 updater 多次回调导致一次性打开多个窗口。
    // ★ 2026-10-22：原来只 focus()，但**隐藏**到托盘的窗口在 Windows 上拿不到焦点、
    //   也不会因此出现 ⇒ 那次调用等于什么也没做。召回要走统一的 showMainWindow()。
    // ⚠️ 守卫条件必须带 !isDestroyed()，否则会**无限递归**：
    //   showMainWindow 见 isDestroyed ⇒ 调 createWindow ⇒ createWindow 见 mainWindow 非空
    //   ⇒ 调回 showMainWindow ⇒ …… 栈溢出。已销毁的残留对象先清掉再建。
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
      return;
    }
    mainWindow = null;
    // ★★ 2026-10-22：**初始几何必须自己算**。原来只写死 width/height、不给 x/y，
    //   位置完全交给操作系统 —— 而 show 默认就是 true（构造即显示），
    //   于是"冷启动时窗口落在屏幕外"这条路**完全没有护栏**（三点：1409 / initUpdater 回调 /
    //   macOS activate 都直连本函数）。实测过的真身：窗口 rect 底边比屏幕底多出 544px。
    //   现在用同一个判据模块算：居中 + 比所在屏大时缩到 92%（1366×768 上 1180×780 就超了）。
    //   ⚠️ createWindow 只在 app ready 之后被调用（whenReady / updater 回调 / activate），
    //      所以这里用 screen 是安全的；取不到就退回写死的尺寸，绝不让它把窗口创建带崩。
    let geo = { width: 1180, height: 780 };
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      geo = centerIntoWorkArea({ width: 1180, height: 780 }, wa);
    } catch (e) {
      console.error('[window] 取屏幕工作区失败，退回默认尺寸:', e && e.message);
    }
    mainWindow = new BrowserWindow({
      ...geo,
      frame: false, // 去掉原生 Windows 标题栏（XP 那排），改用自定义 macOS 顶栏
      // 窗口底色 = 用户上次选的那套主题的 `--c-bg-window`（2026-11-08 · 主题二期）。
      // 原来这里写死 `#f5f5f7`（绿主题的浅灰），注释是「避免启动瞬间闪黑屏」——
      // 它对浅色有效，但深色主题下就变成**深色应用先闪一片浅灰**，比闪黑更刺眼。
      // 现在按 userData/theme.json 两选一（白 / 深），并且渲染层切主题时会经 `theme:set`
      // 同步更新（见该 handler 里的 setBackgroundColor）。
      backgroundColor: THEME_WINDOW_BG[readStoredTheme()],
      resizable: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
        // 登录页背景视频要求「带声音自动播放」：Chromium 默认拦截带声自动播放，
        // 这里显式放开（autoplayPolicy 是 Electron 31 合法的 WebPreferences 字段）。
        // 仅作用于本应用自己的窗口，属于主进程可控范围，风险可控。
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    try { mainWindow.removeMenu(); } catch {}
    // 阻止拖文件触发窗口导航（Electron 拖文件进窗口默认会跳转到该文件）
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (url && url !== mainWindow.webContents.getURL()) e.preventDefault();
    });

    // 【0.21.21 · 老板 2026-10-21】原「上游货源档期 iframe 在 api.example.com 里，
    // 产品硬性要求不要在 iframe 内重新打开」这条约束的**宿主已经没了**
    // （档期页下线 + iframe 外壳删除）。但下面这条 api.example.com 的 deny **刻意保留**：
    //   · 它属于**产品策略**（workbench 是自家站点，不要从客户端里弹原生新窗口），
    //     不是「只服务那一个 iframe」的实现细节；
    //   · 客服助手 / 学习中心将来若出现指向 api.example.com 的链接，仍应走这条统一策略；
    //   · 删掉它反而是一处**行为放宽**（从 deny 变 allow），与本轮「删功能」不是一回事。
    // 判据只看目标 URL 的 host；其余链接保持 allow（学习中心文章 / 平台官网 / 案例原文
    // 依赖 Electron 默认开新窗，一并 deny 会造成功能回归）。
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (host === 'api.example.com' || host.endsWith('.api.example.com')) return { action: 'deny' };
      } catch { /* URL 解析失败：按普通外链放行，保持既有行为 */ }
      return { action: 'allow' };
    });

    if (!app.isPackaged) {
      mainWindow.loadURL('http://localhost:5173');
    } else {
      mainWindow.loadURL('app://douya/dist/renderer/index.html');
    }

    // 最大化状态变化主动推送给渲染层（只在主窗订阅，桌宠窗口不推送）。
    // 渲染层据此把顶栏按钮在 最大化□ / 还原❐ 之间切换，并覆盖「双击拖动区最大化」等情况。
    const pushMaxState = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try { mainWindow.webContents.send('win:maximized-changed', mainWindow.isMaximized()); } catch {}
    };
    mainWindow.on('maximize', pushMaxState);
    mainWindow.on('unmaximize', pushMaxState);

    // 关窗不退出：closeToTray 打开时，× 只是把主窗收进托盘（hide），进程继续值守。
    // 真退出（托盘「退出豆芽」/ before-quit）时 isQuitting=true，这里放行真正的 close。
    mainWindow.on('close', (e) => {
      if (isQuitting) return;
      if (!readResidentSettings().closeToTray) return; // 用户选择了「关闭窗口即退出」
      e.preventDefault();
      mainWindow.hide();
      maybeNotifyTrayOnce();
    });

    mainWindow.on('closed', () => { mainWindow = null; });

    // ---- OS 侧召回兜底（2026-10-22）----
    // 问题：位置校正此前**只有一个调用点**（showMainWindow）。而用户把窗口弄回眼前的路
    // 远不止那一条 —— 任务栏点击、Alt+Tab、Win+↑、双击任务栏缩略图、从最小化拖出来……
    // 全都在 OS 内部完成，electron 只是"通知你一声"。这些路径会让一个 70% 在屏外的窗口
    // 照原样回到屏外，用户看到的是"点了没反应"或"窗口只露一条边"。
    //
    // 为什么选 'restore' / 'show'：它们是这些 OS 动作**共同的汇合点**（窗口从"不在前台"
    // 变成"在前台"必然经过其中之一），而且**不是我们主动调的**（我们自己的 show() 会触发
    // 'show'，但那时位置已经是对的，ensureWindowOnScreen 会判"看得见"直接返回 false 不做任何事）。
    // 幂等 + 上面那道 ensuringWindow 闸 ⇒ 不会自激。
    mainWindow.on('restore', () => ensureWindowOnScreen(mainWindow, 'restore'));
    mainWindow.on('show', () => ensureWindowOnScreen(mainWindow, 'show'));
  }

  // ---- 系统托盘 / 关窗常驻 / 系统通知 / 开机自启 ----

  /**
   * 系统托盘图标：优先用含 16/32px 多尺寸的 .ico（Windows 托盘最清晰），
   * 其他平台回落到 .png。两个文件都随 `src/main/**` 打进 asar，无需改打包配置。
   */
  function trayIcon() {
    const ico = path.join(__dirname, 'tray-icon.ico');
    const png = path.join(__dirname, 'tray-icon.png');
    const pick = process.platform === 'win32'
      ? (fs.existsSync(ico) ? ico : png)
      : (fs.existsSync(png) ? png : ico);
    try {
      const img = nativeImage.createFromPath(pick);
      if (img && !img.isEmpty()) return img;
    } catch (e) {
      console.error('[tray] 加载托盘图标失败:', e.message);
    }
    // 兜底：1x1 透明像素。宁可图标空白，也绝不让「图标缺失」把整个托盘创建流程带崩。
    return nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    );
  }

  /**
  /**
   * 把窗口拉回到「用户真的看得见」的位置，返回是否移动过（2026-10-22）。
   *
   * 为什么需要：**「打不开」最常见的真身是「窗口在屏幕外」**，而本文件的窗口位置此前
   *   **没有任何约束** —— createWindow 不传 x/y，showMainWindow 也只是 restore+show。
   *   于是这些场景都会让窗口出现在看不见的地方，用户点了图标却什么都没有：
   *     · 上次在 2560×1600 的显示器上把窗口放到右下角，后来换了 1366×768 的屏；
   *     · 拔掉外接显示器后，窗口坐标停在已不存在的那个屏上；
   *     · 系统缩放到 150% 后，还原位置按物理像素算，落到了工作区外面。
   *   实测读数（本机 1646×1029 的工作区上抓到过）：窗口 rect 的底边到 1573，
   *   比屏幕底多出 544px —— 窗口**存在、可见标记为真、但人看不见**。
   *
   * 判据（宁可多拉一次，也不要让用户面对一个看不见的窗口）：
   *   ① 「窗口中心落在某个显示器的 workArea 内」**或**「与某个 workArea 的交集 ≥ 窗口面积一半」
   *      ⇒ 认为看得见；否则要拉回。
   *   ② 看得见但「比它**覆盖到的那几块屏的并集**还大」⇒ 同样要处理（底部输入区/右侧按钮在屏外）。
   *   拉回的目标是**窗口自己所在那块屏**（getDisplayMatching），不是主屏 —— 双屏用户在副屏
   *   工作，搬去主屏虽然"看得见"，却把他的布局搬走了。
   *   为什么还要求面积一半：窗口只露出细窄一条时，用户抓不到标题栏，拖不回来。
   */
  // 防重入（2026-10-22）：加了 OS 侧召回监听（'restore' / 'show'）之后，本函数有可能
  //   在自己的 setBounds 引发的连锁事件里被再次调用。校正本身是幂等的（第二次会判"看得见"
  //   直接返回 false），但没必要让它跑两遍 —— 一道闸比"祈祷幂等"更结实。
  let ensuringWindow = false;
  // "拿不到可用工作区"的日志闸（远程桌面断开期间这类事件会连续触发，只吵一次）
  let warnedBadArea = false;
  function ensureWindowOnScreen(win, why) {
    if (ensuringWindow) return false;
    if (!win || win.isDestroyed()) return false;
    let b;
    // ★ 用 getNormalBounds：对**最大化**窗口，getBounds 给的是最大化后的矩形，
    //   而 setBounds 在 Windows 上只改"还原矩形"、可见位置不变 ⇒ 校正会静默失效。
    //   getNormalBounds 给的正是"还原后会在哪"，那才是该校正的东西。
    try { b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds(); } catch { return false; }

    let workAreas, hostArea;
    try {
      workAreas = screen.getAllDisplays().map((d) => d.workArea);
      // ★ 用 getDisplayMatching 而不是主屏：双屏用户在副屏工作，
      //   把窗口拽到主屏虽然"看得见"，但会把他手上的窗口搬走。取交集最大的那块屏。
      hostArea = screen.getDisplayMatching(b).workArea;
    } catch (e) {
      // screen 在 app ready 之前调用会抛。showMainWindow 正常只在 ready 后走，
      // 但这里不赌时序：取不到就放弃这次校正（不改行为，只拆掉一颗地雷）。
      return false;
    }

    // 两件事要分开判（判据在 windowPlacement.js，纯函数，可被门禁直接喂数字）：
    //   ① 看不见（跑到所有屏外面 / 只露一条窄边）⇒ 拉回来
    //   ② 看得见，但**比它覆盖到的那几块屏还大**（1366×720 的笔记本上 1180×780 就超了）
    //      ⇒ 右侧的窗口按钮 / 底部的输入区永远在屏外，同样等于"用不了"
    //   刻意不把"窗口跨两块屏"算成问题：那是用户的正常拖动结果，拽回来反而打断他
    //   （exceedsWorkArea 的容器取的是"覆盖到的屏的并集包围盒"，正是为了保住这一点）。
    const visible = isRectVisible(b, workAreas);
    const tooBig = exceedsWorkArea(b, workAreas);
    if (visible && !tooBig) return false;

    // ★★ 2026-10-22 复审 P1-2：**目标屏必须可用，否则不许动窗口**。
    //   远程桌面断开/重连期间，Windows 报的工作区是 0×0（实测过）。原来这里不做检查，
    //   centerIntoWorkArea 拿到 0×0 会把窗口压成下限 200×150 并落到负坐标 ——
    //   而这条路径由 'show'/'restore'/display-metrics-changed 触发，远程桌面重连必然命中，
    //   之后窗口**长不回来**。用户看到的是"重连一下，豆芽变成一个小方块"。
    //   centerIntoWorkArea 内部也已对 0×0 做了兜底（不会再产出 200×150），这里再拦一道：
    //   连"往哪儿放"都不知道的时候，**什么都不做**才是唯一安全的选择。
    if (!(hostArea && hostArea.width > 0 && hostArea.height > 0)) {
      if (!warnedBadArea) {
        warnedBadArea = true;   // 只吵一次：这类事件会连续触发，逐条打日志会淹掉启动日志
        console.warn('[window] 拿不到可用的工作区（' + (why || '') + '）⇒ 本轮不校正，保持窗口原样：'
          + JSON.stringify(hostArea || null));
      }
      return false;
    }
    warnedBadArea = false;

    // ★ 2026-10-22 复审 P2-2：最大化 + "比屏大"这两个条件同时成立时**不要动**。
    //   最大化窗口的尺寸是系统给的，用户没要求它变小；真放不下（任务栏/副屏配置异常）时
    //   unmaximize→setBounds→maximize 会让窗口**每恢复一次就闪一下**。而它至少是可见的，
    //   闪烁的代价大于收益。这条只跳过 ②，仍然覆盖 ①（看得见 + 放不下 才跳过）。
    const wasMax = (() => { try { return win.isMaximized(); } catch { return false; } })();
    if (wasMax && visible) return false;

    const target = centerIntoWorkArea(b, hostArea);
    ensuringWindow = true;
    try {
      // 最大化状态下 setBounds 只改还原矩形 ⇒ 先还原、改完再最大化回去。
      if (wasMax) { try { win.unmaximize(); } catch { /* ignore */ } }
      win.setBounds(target);
      if (wasMax) { try { win.maximize(); } catch { /* ignore */ } }
      console.log('[window] 位置/尺寸不可用（' + (why || '') + (visible ? ' · 窗口比屏大' : ' · 在屏外') + '）⇒ 已校正：'
        + JSON.stringify({ from: b, to: target, host: hostArea }));
      return true;
    } catch (e) {
      console.error('[window] 拉回窗口失败:', e && e.message);
      return false;
    } finally {
      ensuringWindow = false;
    }
  }

  /**
   * 召回主窗口：无论主窗是「被隐藏」（关窗常驻时是 hide 而非销毁）还是「已销毁」，
   * 都能正确回到用户面前 —— 对隐藏窗口 show()，对已销毁窗口重建（createWindow 内含单例守卫）。
   * 这是**所有召回入口的唯一收敛点**：托盘单击/双击、托盘菜单「显示主窗口」、通知点击、
   * 二实例唤醒、updater 回调，全部走它，不允许任何一处自己调 show()（门禁 E2 组守着）。
   */
  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      // ★ 2026-10-22：重建分支原来直接 return，**绕过了位置校正**。
      //   createWindow 自己已经用 centerIntoWorkArea 算过初始几何，但那条路会静默降级：
      //   `screen.getPrimaryDisplay()` 抛异常时 geo 退回 {width,height} 而**没有 x/y**，
      //   位置又交还给了操作系统。重建是"用户正在等一个窗口出现"的时刻，这里的兜底成本
      //   只有一次纯函数计算，值得。
      if (mainWindow && !mainWindow.isDestroyed()) ensureWindowOnScreen(mainWindow, 'showMainWindow:recreated');
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    // ★ 顺序：先 show（让 Windows 认可它该出现），再校正位置 —— 反过来在隐藏窗口上
    //   setBounds，有些 Windows 版本会保留旧的还原位置，白做。
    ensureWindowOnScreen(mainWindow, 'showMainWindow');
    // ★ focus 必须排在**校正之后**（2026-10-22）：否则一个 70% 在屏外的窗口会先出现在
    //   原位、拿到焦点、再当众跳到屏幕中央 —— 用户看到的是"窗口闪了一下又变了"，
    //   比直接出现在对的位置更像故障。
    try { mainWindow.focus(); } catch { /* 窗口刚被销毁时 focus 会抛，忽略 */ }
  }

  /** 真退出：置 isQuitting 后走正常 quit 流程（close 拦截器会放行）。 */
  function quitApp() {
    isQuitting = true;
    app.quit();
  }

  /**
   * 首次「关窗 → 常驻」时给一次系统通知，消除「点了 × 却还在跑」的认知落差。
   * 只提示一次（trayNoticeShown 落盘）；通知发不出去时不落标记，宁可下次再试，
   * 也不要因一次失败就让用户永远收不到告知。
   */
  function maybeNotifyTrayOnce() {
    if (readResidentSettings().trayNoticeShown) return;
    const r = sendSystemNotification({
      title: '豆芽仍在后台为你工作 🌱',
      body: '关闭窗口不会退出豆芽，它已最小化到系统托盘。要完全退出，请右键托盘图标选「退出豆芽」。',
      onClick: () => showMainWindow(),
    });
    if (r.ok) writeResidentSettings({ trayNoticeShown: true });
    else console.error('[tray] 首次常驻通知未送达:', r.error);
  }

  /** 应用「开机自启」并落盘；返回最终是否开启。 */
  function applyLoginItem(enabled) {
    const on = !!enabled;
    try {
      app.setLoginItemSettings({ openAtLogin: on });
    } catch (e) {
      console.error('[resident] setLoginItemSettings 失败:', e.message);
    }
    writeResidentSettings({ openAtLogin: on });
    return on;
  }

  /** 用系统真实的自启状态校正本地记录（用户可能在系统设置里改过）。 */
  function syncLoginItemFromSystem() {
    try {
      const real = !!app.getLoginItemSettings().openAtLogin;
      if (real !== readResidentSettings().openAtLogin) writeResidentSettings({ openAtLogin: real });
    } catch {}
  }

  /** 构建托盘菜单：显示主窗 / 常驻开关 / 开机自启开关 / 退出。 */
  function buildTrayMenu() {
    const s = readResidentSettings();
    return Menu.buildFromTemplate([
      { label: '豆芽 · 后台值守中 🌱', enabled: false },
      { type: 'separator' },
      { label: '显示主窗口', click: () => showMainWindow() },
      {
        label: '关闭窗口时保持后台常驻',
        type: 'checkbox',
        checked: !!s.closeToTray,
        click: (item) => { writeResidentSettings({ closeToTray: !!item.checked }); },
      },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: !!s.openAtLogin,
        click: (item) => { applyLoginItem(!!item.checked); refreshTrayMenu(); },
      },
      { type: 'separator' },
      // 后续「定时任务」入口预留位（此处仅占位，不误导：明确标注即将上线）。
      { label: '定时任务（即将上线）', enabled: false },
      { type: 'separator' },
      { label: '退出豆芽', click: () => quitApp() },
    ]);
  }

  /** 重建托盘菜单（开关状态变化后刷新勾选）。 */
  function refreshTrayMenu() {
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
  }

  /** 创建系统托盘。失败时诚实降级（退化为普通窗口应用），不抛断启动。 */
  function createTray() {
    if (tray && !tray.isDestroyed()) return tray;
    try {
      tray = new Tray(trayIcon());
    } catch (e) {
      console.error('[tray] 创建托盘失败，应用将退化为普通窗口行为:', e.message);
      tray = null;
      return null;
    }
    tray.setToolTip('豆芽CLAW');
    refreshTrayMenu();
    // Windows 习惯：左键单击 / 双击托盘图标都召回主窗口（幂等，重复点击无副作用）。
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    return tray;
  }

  // 渲染层请求发系统通知（后续「定时任务跑完告知结果」等会调用）。
  // 返回 { ok, error }：ok=false 表示系统不支持/发送失败，调用方须降级成页内提示（绝不静默）。
  ipcMain.handle('notify:send', (_e, payload = {}) => {
    const p = payload || {};
    return sendSystemNotification({
      title: p.title,
      body: p.body,
      silent: p.silent,
      onClick: () => showMainWindow(),
    });
  });

  // 读取「后台常驻」设置（供设置页显示开关状态）。
  ipcMain.handle('resident:getSettings', () => {
    const s = readResidentSettings();
    let notificationSupported = false;
    try { notificationSupported = !!(Notification && Notification.isSupported && Notification.isSupported()); } catch {}
    return {
      closeToTray: !!s.closeToTray,
      openAtLogin: !!s.openAtLogin,
      notificationSupported,
      platform: process.platform,
    };
  });

  // 修改「后台常驻」设置（关闭窗口是否常驻 / 是否开机自启）。
  ipcMain.handle('resident:setSettings', (_e, patch = {}) => {
    const p = patch || {};
    if (typeof p.closeToTray === 'boolean') {
      writeResidentSettings({ closeToTray: p.closeToTray });
      refreshTrayMenu();
    }
    if (typeof p.openAtLogin === 'boolean') {
      applyLoginItem(p.openAtLogin);
      refreshTrayMenu();
    }
    const s = readResidentSettings();
    return { closeToTray: !!s.closeToTray, openAtLogin: !!s.openAtLogin };
  });

  // ---- 定时任务 IPC（数据文件 automations.json 归主进程所有，不新开 HTTP 路由）----
  // 均回传「纯数据」，任何异常都由渲染层 try/catch 后页内提示（不静默）。
  ipcMain.handle('automation:list', () => (automations ? automations.listItems() : []));
  ipcMain.handle('automation:create', (_e, input = {}) => {
    if (!automations) throw new Error('定时任务调度器尚未就绪');
    return automations.createItem(input || {});
  });
  ipcMain.handle('automation:update', (_e, id, patch = {}) => {
    if (!automations) throw new Error('定时任务调度器尚未就绪');
    return automations.updateItem(String(id || ''), patch || {});
  });
  ipcMain.handle('automation:remove', (_e, id) => {
    if (!automations) return false;
    return automations.removeItem(String(id || ''));
  });
  ipcMain.handle('automation:runNow', async (_e, id) => {
    if (!automations) throw new Error('定时任务调度器尚未就绪');
    return automations.runNow(String(id || ''));
  });
  ipcMain.handle('automation:runs', (_e, q = {}) => (automations ? automations.listRuns(q || {}) : []));

  // ---- 长期记忆 IPC（B 阶段 #247/#248/#249）----
  // ==========================================================================
  // 为什么需要这一层：A 阶段的记忆模块**零 IPC 出口**（main.js 完全没 require memory*），
  // 于是渲染层读不到任何数据 —— 做 UI 只会做成空壳。这一层就是那个缺口。
  //
  // ★ 三条设计纪律：
  //   ① **读接口只读**：不暴露任何写函数给渲染层（写路径只由主进程自己走 memorySidePath）。
  //   ② **删除用「标 archived」而不是物理删除**：记忆是证据链，删了就没法向用户解释
  //      "你凭什么曾经记得这个"。归档 + 记流水 ⇒ 可回溯（见 memoryStore 的 LEDGER_OP）。
  //   ③ **owner 为空返回空、绝不回落公共档案**：否则任何未登录调用方都能读到别人的记忆。
  //      （这条是 A 阶段就定下的底线，IPC 层只是把它继续贯彻。）
  // ==========================================================================

  /** 取当前操作者标识。IPC 拿不到 payload，故用登录态；未登录时返回空串（⇒ 读不到任何档案）。 */
  const memoryOwner = () => {
    try {
      const tok = loadAuthToken && loadAuthToken();
      if (tok && tok.username) return String(tok.username);
    } catch { /* 取不到就当作未登录，绝不猜 */ }
    return '';
  };

  // 读四层档案（UI 主体数据源）
  ipcMain.handle('memory:read', () => {
    const owner = memoryOwner();
    // owner 为空 ⇒ 返回一个**结构完整但全空**的结果。
    // 为什么不抛错：UI 需要区分"没登录"与"出错"两种状态来给不同文案；
    // 抛错会让渲染层只能显示一个笼统的失败提示。
    if (!owner) {
      return { ok: false, owner: '', error: 'owner_required', layers: { identity: [], orgs: [], prefs: [], projects: [] }, total: 0 };
    }
    const r = memoryStore.readAllLayers(owner, { dataDir: app.getPath('userData') });
    return {
      ok: r.ok,
      owner,
      error: r.errors && r.errors.length ? r.errors.join(',') : '',
      layers: r.layers || { identity: [], orgs: [], prefs: [], projects: [] },
      total: r.total || 0,
    };
  });

  // 读变更流水（UI 时间线数据源）
  ipcMain.handle('memory:ledger', (_e, query = {}) => {
    const owner = memoryOwner();
    if (!owner) return { ok: false, owner: '', error: 'owner_required', rows: [] };
    const limit = Number(query && query.limit) || 200;
    const r = memoryStore.readLedger(owner, { dataDir: app.getPath('userData'), limit });
    return { ok: r.ok, owner, error: r.error || '', rows: r.rows || [] };
  });

  // 删除一条记忆（标 archived + 记流水，**不是物理删除**）
  ipcMain.handle('memory:archive', (_e, input = {}) => {
    const owner = memoryOwner();
    if (!owner) return { ok: false, error: 'owner_required' };
    const layer = String((input && input.layer) || '');
    const key = String((input && input.key) || '');
    if (!layer || !key) return { ok: false, error: 'layer_and_key_required' };

    const dataDir = app.getPath('userData');
    // ★ 走 memoryStore 的既有写入口（updateLayer），不自己拼文件写入：
    //   updateLayer 会自动带上 TTL 降级与上限淘汰两个不变量。
    const r = memoryStore.updateLayer({
      owner,
      layer,
      dataDir,
      mutate: (entries) => entries.map((e) => (
        e && e.key === key ? Object.assign({}, e, { status: 'archived' }) : e
      )),
    });
    if (!r.ok) return { ok: false, error: r.error || 'archive_failed' };

    // 记流水：**删也必须留痕**（这是它区别于"物理删除"的关键）
    const lg = memoryStore.appendLedger({
      owner,
      op: memoryStore.LEDGER_OP.SUPERSEDE,
      layer,
      key,
      detail: { verdict: 'ARCHIVE', reason: 'user_deleted_from_ui' },
      dataDir,
    });
    return { ok: lg.ok, error: lg.error || '' };
  });

  // 记忆开关：读
  ipcMain.handle('memory:getSettings', () => {
    const s = readResidentSettings();
    return { enabled: s.memoryEnabled !== false, owner: memoryOwner() };
  });

  // 记忆开关：写（改完立刻生效，不等 2s 缓存 TTL）
  ipcMain.handle('memory:setSettings', (_e, patch = {}) => {
    const p = patch || {};
    if (typeof p.enabled === 'boolean') {
      writeResidentSettings({ memoryEnabled: p.enabled });
      // ★ 必须主动清缓存：否则用户关掉开关后，后端最多还要 2s 才跟上 ——
      //   那 2 秒里的对话仍会被记下来，用户看到的是"我关了它还在记"。
      try { invalidateMemorySwitch(); } catch { /* 清缓存失败不影响写入 */ }
    }
    const s = readResidentSettings();
    return { enabled: s.memoryEnabled !== false };
  });

  // ── 账号产物隔离 · 忘记当前账号（登出时由渲染层调用）──────────────────────────
  // 为什么需要这条通道：产物目录是按「当前账号」派生的，而账号事实落在
  // `<userData>/current-account.json`。只清 localStorage 的话，主进程**仍然**按上一个
  // 账号派生产物目录 ⇒ 登出后（或被下一个人在未登录态打开时）作品库、海报、缩略图
  // 依旧指着前一个账号的目录，隔离在"登出"这个动作上破了一个口。
  //
  // 语义是"忘记"，不是"删除"：只删账号标识 + 把派生目录刷回未登录桶（`anon`），
  // **一个产物文件都不动**（用户重新登录同一个账号，作品还在原处）。
  // 返回值恒为 `{ok:true}`：渲染层的登出流程不该被一条记账清理卡住。
  ipcMain.handle('account:forget', () => {
    try { accountScope.clearAccount(app.getPath('userData')); } catch { /* 删不掉也照常刷根 */ }
    try { setAppMediaRoots([wanxMediaDir()]); } catch { /* 刷新失败 ⇒ 媒体 403（fail-closed） */ }
    return { ok: true };
  });

  /**
   * 把「产物目录 + app:// 媒体授权根」切到指定账号（2026-11-06 · 产物隔离）。
   *
   * ★ 两个"为什么放在这里"（都踩过，别挪）：
   *   ① 为什么在 `if (!gotLock) { ... }` 块里、而不是跟 `wanxMediaDir()` 一起放模块作用域：
   *      `setAppMediaRoots` **声明在这个块内**（KI-006 段），块外的代码看不到它 ——
   *      放到块外，严格模式下会抛 ReferenceError，`unit-no-undef` 也会直接判红
   *      （实测读数：main.js:381 "setAppMediaRoots" 未绑定）。块内的函数声明会 hoist 到块顶，
   *      所以下面的 `whenReady` 与上面的 `account:forget` 都能正常调到它。
   *   ② 为什么在 KI-005 的那对切片标记**之前**、而不是紧贴 `setAppMediaRoots`：
   *      `scripts/security/ki005` 的探针把两个标记之间的源码原样抠出来
   *      `new Function` 执行，作用域里**只有** app/path/fs/mimeType/Response/URL/console/session。
   *      本函数引用了 `accountScope` / `workspaceRootDir`（主进程模块作用域），
   *      塞进那段切片等于给探针埋一个必然 ReferenceError 的雷。放在切片外，两边互不干扰。
   *      ⚠️ 这段注释里**刻意不写出标记原文**：探针用 `indexOf` 取第一次出现的位置，
   *        注释里写一遍就会把切片起点拽到注释中间（块注释被提前闭合 ⇒ 探针直接语法错）。
   *
   * ★ 这个函数里**只有一件事**：把媒体授权根刷到当前账号的产物目录。
   *
   * ★★ 旧共享目录的归属处理**刻意不在这里**（2026-11-06 老板裁决，原文见
   *   `ensureLegacyQuarantine` 的头注）。存量走 `ensureLegacyQuarantine()`：
   *   启动时一次、目标恒为 `accounts/_unclaimed`、签名里不收 username。
   *   这两个动作的绑定关系必须**保持断开** —— 本函数签名里带着 username，
   *   把"搬运存量"塞回来实在太顺手了；一旦塞回来，"第一次登录的账号顺手收下
   *   全部存量"就会原样复活，而那正是被老板否掉的那一版。
   *   ⇒ 谁要动这里，先回答一句："凭什么判定这批文件属于**这个**账号？"
   *
   * 为什么必须刷授权根：媒体协议的白名单只有"当前账号目录"这一个。
   *   不跟着走的后果是双向的：新账号的缩略图 403（fail-closed，功能坏）；
   *   而旧账号目录仍留在白名单里，等于隔离只做了"保存"这一半。
   *
   * try/catch：刷新失败不该阻断登录（最坏是一段时间内图片 403，产物本身不受影响）。
   *
   * @param {string} username 账号名（空 ⇒ 未登录，目录退 anon 桶；本函数**不消费**它）
   * @returns {void}
   */
  function applyAccountScope(username) {
    // 目录派生自己会读「当前账号」（wanxMediaDir → accountScope.readAccount），
    // 所以这里**用不到** username；保留形参只是不想改两个调用点的签名。
    // ★ 这个 `void` 是个路标：它明说"入参被**有意**忽略"，
    //   防止后来的人觉得"账号都在这儿了，顺手把存量搬给它吧"。
    void username;
    try {
      setAppMediaRoots([wanxMediaDir()]);
    } catch { /* 授权根刷新失败 ⇒ 媒体 403（fail-closed），但产物本身不受影响 */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KI-005 · app:// 授权根解析（★ 回归探针按 `KI-005 BEGIN/END` 标记切片，
  //         改这一段的结构必须同步 scripts/tmp-probe/_ki005 下的探针）
  //
  // 修复前的写法（ed5eec5 与 0.21.25 RC asar 内逐字节相同）：
  //   path.join(app.getAppPath(), decodeURIComponent(url).split('/').join(path.sep))
  // 三个缺口叠在一起：
  //   ① 解码发生在 Chromium 归一化**之后** ⇒ 双重编码的 %2e%2e%2f 能活到解码后才还原；
  //   ② 只把 `/` 换成分隔符 ⇒ `..%5c` 里的反斜杠在 Windows 上照样是分隔符；
  //   ③ path.join 归约完**从不校验**结果是否还在应用目录内。
  // 于是 `app://douya/%2e%2e%2foutside%2fsecret.txt` 能读到应用目录外的任意文件
  // （真 Electron 31.7.7 实测 200 + 越界文件全文，见 _ki005/logs/before.log）。
  //
  // 现在是一条完整的安全链：解码到稳定 → 拒非法段 → 解析 → 词法边界 → realpath 二次校验。
  // 白名单以外一律 403，文件不存在才 404 —— 两者不能混。
  // ⚠️ 不要用关闭 webSecurity 的方式"解决"这里：那会放开整个渲染进程的文件访问面。
  // ⚠️ KI-006（视频缩略图）只允许**新增授权根**，不许放宽下面的判断。
  // ═══════════════════════════════════════════════════════════════════════════
  // KI-005 BEGIN
  const APP_ASSET_HOST = 'douya';
  const APP_ASSET_DECODE_ROUNDS = 5;

  // ── KI-006（缩略图/媒体）· 媒体授权根 ──────────────────────────────────────────
  // 渲染页是 `app://douya`，主窗 webSecurity 默认开 ⇒ 从它加载 `file://` 必被拦
  // （这正是缩略图裂图的成因）。解法不是关 webSecurity，而是让媒体也走 app://，
  // 但只开放**一个明确的目录**。
  //
  // 为什么用"保留路径段"而不是另起一个 host（`app://media/…`）：
  //   `registerSchemesAsPrivileged({ standard: true })` 下 host 不同就是**不同 origin**，
  //   而我们给资源回的头是 `Cross-Origin-Resource-Policy: same-origin`——
  //   `<img src="app://media/…">` 从 `app://douya` 页面发起属于 no-cors 跨源读，会被 CORP 挡掉。
  //   同 host 同 origin 就没有这个问题，也不必为媒体单独开 CORS。
  //
  // ★ 前缀必须在**解码到稳定之后**判（见 decodeRelPath）：按原始 pathname 判的话
  //   `/%5f%5fmedia/..%2f..%2fx` 不匹配前缀 → 落回应用根，等于给了一条绕过前缀的路。
  const APP_MEDIA_SEG = '__media';

  // 媒体根由主进程在 ready 阶段用 wanxMediaDir() 灌进来 —— 本段会被 KI-005 的探针
  // 原样抠出来 `new Function` 执行，作用域里只有 app/path/fs/mimeType/Response/URL/console/session，
  // **没有 os，也没有 getPath**，所以这里绝不能自己推导 homedir。
  const APP_MEDIA_ROOTS = [];
  function setAppMediaRoots(list) {
    APP_MEDIA_ROOTS.length = 0;
    const seen = new Set();
    for (const p of (Array.isArray(list) ? list : [])) {
      const s = String(p || '').trim();
      if (!s) continue;
      let abs = '';
      try { abs = path.resolve(s); } catch { continue; }
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      if (seen.has(key)) continue;
      seen.add(key);
      APP_MEDIA_ROOTS.push(abs);
    }
    return APP_MEDIA_ROOTS.slice();
  }
  function appMediaRoots() { return APP_MEDIA_ROOTS.slice(); }

  /** 授权根目录白名单。★ 别往里塞"任意本地目录"，那等于把漏洞原样放回去。 */
  function appAssetRoots() {
    const roots = [];
    try {
      const p = app.getAppPath();
      if (p) roots.push(path.resolve(p));
    } catch { /* 取不到根 = 没有根 = 全拒 */ }
    return roots;
  }

  function realpathOrNull(p) {
    try { return fs.realpathSync(p); } catch { return null; }
  }

  /** 词法边界：必须**等于根**，或落在 `根 + 分隔符` 之下。Windows 不分大小写。 */
  function isInsideRoot(target, root) {
    const norm = (s) => {
      let v = path.resolve(String(s));
      if (process.platform === 'win32') v = v.toLowerCase();
      return v;
    };
    const t = norm(target);
    const r = norm(root);
    if (t === r) return true;
    const pref = r.endsWith(path.sep) ? r : r + path.sep;
    return t.startsWith(pref);
  }

  function parseAppUrl(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl || '')); } catch { return { error: 'bad_url' }; }
    if (String(u.protocol || '').toLowerCase() !== 'app:') return { error: 'bad_scheme' };
    if (String(u.hostname || '').toLowerCase() !== APP_ASSET_HOST) return { error: 'bad_host' };
    return { u };
  }

  /**
   * `app://douya/…` 的 pathname → 已校验的路径段数组。成功 `{ segs }`；失败 `{ error }`。
   *
   * ★ 这条链**同时服务应用根与媒体根**：两边用同一套解码/归一/边界判断，不允许哪一边弱一点。
   *   两条路由各自独立验收（KI-006 / KI-006-缩略图），但边界链只有这一份实现。
   */
  function decodeRelPath(rawPathname) {
    // u.pathname 仍是百分号编码（`%2f` 不是 URL 的分隔符）⇒ 必须自己解码。
    let rel = String(rawPathname || '');
    // ★ 反复解码到稳定：`%252e%252e%252f` 只有全解开才现形。
    //   只解一次的话它变成"文件不存在"的 404 —— 看着安全，其实只是没解出来。
    for (let i = 0; i < APP_ASSET_DECODE_ROUNDS; i++) {
      let next;
      try { next = decodeURIComponent(rel); } catch {
        // 首轮就解不动 = 畸形编码，直接拒；后续轮解不动只说明遇到了字面 `%`，
        // 到此为止继续走边界检查（这一步不可能绕过下面的 `..` 判定）。
        if (i === 0) return { error: 'bad_encoding' };
        break;
      }
      if (next === rel) break;
      rel = next;
    }
    if (rel.includes('\0')) return { error: 'nul_byte' };

    // URL 的 pathname 一定以 `/` 开头，那是"相对应用根"的写法 —— 只摘掉这一个。
    // ★ 别在这里用 path.isAbsolute()：`/index.html` 在 Windows 上也是 absolute，
    //   用它当判据会把**每一个正常请求**都拒成 403。
    if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1);
    // 摘掉一个之后不许还是分隔符 / 盘符：那是在指定自己的根（`//host`、`C:`），拒。
    //   ⚠️ 这两个判断必须在"两种分隔符归一"之前做 —— 归一之后 UNC 的 `\\` 会被抹成单个。
    if (rel.startsWith('/') || rel.startsWith('\\')) return { error: 'unc_path' };
    if (/^[a-zA-Z]:/.test(rel)) return { error: 'abs_drive' };
    // 两种分隔符都当分隔符：Windows 上 `..\..\x` 与 `../../x` 等价，只管 `/` 会漏。
    const segs = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (segs.some((s) => s === '..')) return { error: 'parent_segment' };
    if (!segs.length) return { error: 'empty_path' };
    // Windows 会把**每个路径分量**的尾随点与空格剥掉（`.. ` ≡ `..`、`...` ≡ 空）。
    // 现在 Node 用 `\\?\` 前缀把这种名字原样交给系统，所以 `.. ` 实测读不到东西（404）；
    // 但"今天不炸"不是"安全" —— 那是实现细节，不是我们自己的判断。
    // ⇒ 判等必须在剥之后做，凡是会被系统改写的名字一律拒（正常静态资源不会有这种名字）。
    for (const s of segs) {
      if (s.replace(/[. ]+$/, '') !== s) return { error: 'win_name_normalized' };
    }

    return { segs };
  }

  /** 已校验的段 → 某个授权根内的绝对路径。边界判据只有这一份。 */
  function resolveUnderRoots(segs, roots, kind) {
    if (!roots.length) return { error: kind === 'media' ? 'no_media_root' : 'no_root' };
    for (const root of roots) {
      const abs = path.resolve(root, segs.join(path.sep));
      if (!isInsideRoot(abs, root)) continue;
      // 二次校验：根内的软链 / junction 指向根外时，纯词法边界看不出来。
      //   取不到 realpath（文件不存在 / asar 内路径）不算错，交给后面的 stat 定 404。
      const real = realpathOrNull(abs);
      if (real) {
        const realRoot = realpathOrNull(root) || root;
        if (!isInsideRoot(real, realRoot)) return { error: 'symlink_escape' };
      }
      return { abs, kind };
    }
    return { error: 'outside_root' };
  }

  /**
   * `app://douya/<rel>` → 授权根内的绝对路径。成功 `{ abs, kind }`；
   * 失败 `{ error }`（error 只是原因代号，绝不回显真实路径）。
   *
   * 路由：第一段是 `__media` ⇒ 媒体根；其余 ⇒ 应用根。
   *   媒体路由**不接受根外的任何东西**，和 `..` 一样当越界处理。
   */
  function resolveAppAsset(rawUrl) {
    const p = parseAppUrl(rawUrl);
    if (p.error) return { error: p.error };
    const d = decodeRelPath(p.u.pathname);
    if (d.error) return { error: d.error };
    if (d.segs[0] === APP_MEDIA_SEG) {
      const rest = d.segs.slice(1);
      if (!rest.length) return { error: 'empty_path' };
      return resolveUnderRoots(rest, appMediaRoots(), 'media');
    }
    return resolveUnderRoots(d.segs, appAssetRoots(), 'asset');
  }

  function denyAppAsset(code) {
    // 原因只进主进程日志；响应体里不回显任何真实路径，避免二次信息泄漏。
    try { console.warn('[app://] 拒绝越权资源请求:', code); } catch { /* 日志失败不影响拒绝 */ }
    return new Response('Forbidden: ' + code, {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // KI-010 · 读方鉴权：授权根内的资源**只允许应用自己**读
  //
  // 边界（能走多远）和鉴权（谁有权走）是两件事。只做前者时，任意网页 origin 都能
  // `fetch('app://douya/.env')` 把根内文件读走（实测 200 + 全文）。于是"根有多大"就等于
  // "能漏多少"：开发态 app.getAppPath() 是仓库根，`.env` / 源码 / node_modules 全在根内；
  // 打包态根是 app.asar，一旦有人把证书 / token 打进去，就是一条无鉴权外泄通道。
  //
  // ⚠️ 别在这里读 `Origin` 头做判断 —— 实测**它不存在**（handler 只收到 accept / user-agent），
  //    所以"按 Origin 回不同 ACAO"是个看似合理、实则无效的假修复。真正的判据在下方
  //    installAppAssetOriginGuard() 的 webRequest 层：那里能拿到 `details.frame.url`。
  //
  // 响应头只做"不该给的东西不给"：不回 `ACAO: *`，CORP 收到 same-origin。
  //   应用自己的页面是同源读，本来不需要 ACAO（打包入口页实测 4 个脚本/样式请求全 200）。
  const APP_ASSET_ORIGIN = 'app://douya';

  /**
   * 读方鉴权（webRequest 层）：只允许**应用自身 origin 的 frame** 发起的 app:// 请求。
   *
   * 判据用 `details.frame.url`（实测能区分：在 app 页面里是 `app://douya/…`，
   * 在外部 http 页面或其跨源 iframe 里是 `http://…`）。
   *
   * ⚠️ 只判 `frame.url` 是不够的，有一条实测过的绕过：
   *    **子帧导航**（`<iframe src="app://douya/x.html">`）时 `frame.url` 还是空串
   *    （新文档尚未提交），于是落进"取不到 ⇒ 放行"，结果**任意网页都能把应用页面
   *    嵌进自己的页面里并成功渲染**（实测 loaded）。保密性靠同源策略兜住了，但
   *    XS-Leaks（用 onload 探测根内某文件是否存在）与点击劫持都能做。
   *    ⇒ 子帧导航必须按 `details.frame.parent.url`（父帧）判，不能按自己判。
   *
   * 四类情形（顺序不能乱）：
   *   ① subFrame 导航  ⇒ 父帧必须是 app://douya，否则 cancel
   *   ② 无 frame（主进程 net.fetch）/ mainFrame 导航 ⇒ 放行（拦掉会打死启动与后端）
   *   ③ about:blank 帧 ⇒ 有父帧就按父帧判（版本差异时兜底）
   *   ④ 其它 ⇒ frame.url 必须属于 app://douya
   */
  function installAppAssetOriginGuard(ses) {
    const isOwnUrl = (u) => {
      const s = String(u || '').trim().toLowerCase();
      return s === APP_ASSET_ORIGIN || s.startsWith(APP_ASSET_ORIGIN + '/');
    };
    const parentUrlOf = (frame) => {
      try { return frame && frame.parent ? String(frame.parent.url || '') : ''; } catch { return ''; }
    };
    const deny = (code, seen, url) => {
      // 越权读：直接取消，连状态码都不给外部页面（403 会告诉它"这个文件存在"）
      try { console.warn('[app://] 拒绝非本应用来源的读取:', code, seen, '→', url); } catch { /* 日志失败不影响拒绝 */ }
      return { cancel: true };
    };
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = String((details && details.url) || '');
      if (!url.toLowerCase().startsWith('app:')) return callback({});
      const resourceType = String((details && details.resourceType) || '');
      let frameUrl = '';
      try { frameUrl = details.frame && details.frame.url ? String(details.frame.url) : ''; } catch { frameUrl = ''; }
      const parentUrl = parentUrlOf(details.frame);

      // ① 子帧导航：frame.url 还是空的，只能看父帧（这是嵌入的入口）
      if (resourceType === 'subFrame') {
        if (isOwnUrl(parentUrl)) return callback({});
        return callback(deny('subframe_from_foreign_parent', parentUrl || '(no-parent)', url));
      }
      // ② 主进程 net.fetch（无 frame）/ 主窗口 mainFrame 导航
      //    ⚠️ 已知边界（不是 bug）：mainFrame 导航时 `frame.url` 报的是**上一个文档**的 URL，
      //    因此"从 http 页面导航到 app://"会被这里拦掉。今天的应用没有"点外链再跳回应用"
      //    的流程，所以不影响；将来若要加这种流程，需在这里放开 mainFrame 导航并补独立用例，
      //    不要对着现象乱改判据。
      if (!details.frame) return callback({});
      if (!frameUrl) {
        if (!parentUrl) return callback({});           // mainFrame 导航早期：放行
        return isOwnUrl(parentUrl)
          ? callback({})
          : callback(deny('empty_frame_url_foreign_parent', parentUrl, url));
      }
      // ③ about:blank 帧：实测 fetch 时上报的是父页 URL，这里按父帧兜底
      if (frameUrl.trim().toLowerCase() === 'about:blank') {
        if (!parentUrl) return callback({});
        return isOwnUrl(parentUrl) ? callback({}) : callback(deny('blank_frame_foreign_parent', parentUrl, url));
      }
      // ④ 正常路径：frame 自身必须属于应用
      if (isOwnUrl(frameUrl)) return callback({});
      return callback(deny('foreign_frame', frameUrl, url));
    });
  }

  /**
   * 把文件的 [start,end] 包成 web ReadableStream。
   *
   * ★ 为什么不再 `fs.readFileSync` 整个文件：视频动辄几十上百 MB，整读等于把
   *   一份视频完整塞进主进程内存（还要再复制一份给 Response）。走流只占一个 chunk。
   *   只用全局 `ReadableStream` + 注入的 `fs`，不 require 任何东西 —— 本段要能被
   *   KI-005 的探针原样 `new Function` 执行。
   */
  function fileStreamBody(filePath, start, end) {
    let rs = null;
    return new ReadableStream({
      start(controller) {
        try {
          rs = fs.createReadStream(filePath, { start, end });
        } catch (e) {
          try { controller.error(e); } catch { /* 已经关了 */ }
          return;
        }
        rs.on('data', (chunk) => {
          try {
            // 零拷贝视图：Buffer 本身就是 Uint8Array，但它的 byteOffset 不一定为 0。
            controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
          } catch { try { rs.destroy(); } catch { /* 忽略 */ } }
        });
        rs.on('end', () => { try { controller.close(); } catch { /* 已经关了 */ } });
        rs.on('error', (e) => { try { controller.error(e); } catch { /* 已经关了 */ } });
      },
      cancel() { try { if (rs) rs.destroy(); } catch { /* 忽略 */ } },
    });
  }

  function notFoundResponse() {
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  function rangeNotSatisfiable(total) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}`, 'cache-control': 'no-store' },
    });
  }

  // app:// 协议处理
  //
  // 媒体走的是同一条路由（`app://douya/__media/<rel>`），所以这里不需要第二套 handler：
  // 边界、MIME、Range/206、流式读取对应用资源和媒体文件完全一致。
  const appAssetHandler = (request) => {
    const resolved = resolveAppAsset(request && request.url);
    if (resolved.error) return denyAppAsset(resolved.error);
    const filePath = resolved.abs;
    try {
      const stat = fs.statSync(filePath);
      // 目录不是资源。以前 readFileSync 会抛 EISDIR 落到 404，现在显式判，
      // 免得哪天换成别的读法就变成"能列目录"。
      if (!stat.isFile()) return notFoundResponse();
      const total = stat.size;
      const headers = {
        'content-type': mimeType(filePath),
        'cache-control': 'no-cache',
        // ⚠️ 绝不能写回 '*'：那等于把授权根里的每个文件对任意网页开放（实测过，见 KI-010）。
        //     不让发 ACAO 只是纵深防御的第二层，第一层是上面的 webRequest 守卫。
        'Cross-Origin-Resource-Policy': 'same-origin',
        // 媒体文件（登录页背景视频）需要按字节区间拉取，声明支持 Range。
        'Accept-Ranges': 'bytes',
      };
      const bodyFor = (s, e) => (typeof ReadableStream === 'function'
        ? fileStreamBody(filePath, s, e)
        : fs.readFileSync(filePath).subarray(s, e + 1));

      // 支持 HTTP Range：Chromium 对 <video> 会发 Range 请求，返回 206 才能稳定起播/循环。
      const rangeHeader = request.headers.get('range') || request.headers.get('Range');
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
      if (m) {
        let start;
        let end;
        if (m[1] === '') {
          // ★ 后缀区间 `bytes=-N` 是**最后 N 字节**，不是"从第 0 字节到第 N 字节"。
          //   原实现两处都当 0 起，于是 `bytes=-5` 返回的是**前 6 字节**（实测 206/6）。
          //   视频播到尾部时 Chromium 就会发这种请求，拿错数据表现为卡住或时长错乱。
          const n = m[2] === '' ? 0 : parseInt(m[2], 10);
          if (!Number.isFinite(n) || n <= 0) return rangeNotSatisfiable(total);
          start = Math.max(0, total - n);
          end = total - 1;
        } else {
          start = parseInt(m[1], 10);
          end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
          if (!Number.isFinite(start)) start = 0;
          if (!Number.isFinite(end) || end >= total) end = total - 1;
        }
        if (total === 0 || start > end || start >= total) return rangeNotSatisfiable(total);
        return new Response(bodyFor(start, end), {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }
      if (total === 0) {
        return new Response('', { status: 200, headers: { ...headers, 'Content-Length': '0' } });
      }
      return new Response(bodyFor(0, total - 1), {
        status: 200,
        headers: { ...headers, 'Content-Length': String(total) },
      });
    } catch (e) {
      return notFoundResponse();
    }
  };
  // KI-005 END

  app.whenReady().then(() => {
    // 注册 app:// 资源处理器（授权根解析见上方 KI-005 段）
    protocol.handle('app', appAssetHandler);
    // KI-006（缩略图）：媒体授权根只有「当前账号的产物目录」这一个。
    //   必须在 handle 之前/之后都行，但**必须**在第一个媒体请求之前 —— 没灌进来时
    //   媒体路由返回 403（fail-closed），不会退回应用根。
    //
    // ★ 2026-11-06 产物隔离 · 两步，顺序**不能换**：
    //   ① `ensureLegacyQuarantine()` —— 把修复前共享目录里的存量产物搬进
    //      `accounts/_unclaimed`，**不分配给任何账号**（裁决原文见该函数头注）。
    //      必须在刷授权根**之前**：先搬完再刷，授权根指向的目录才是最终状态；
    //      反过来会有一瞬间授权根正指着一个正在被搬空的目录。
    //   ② `applyAccountScope(...)` —— 把媒体授权根刷到当前账号的产物目录。
    //   为什么 ① 只在这里做、**不**放进登录回调：登录回调是唯一"知道现在是哪个账号"
    //      的代码位置，把"知道账号"和"搬运存量"摆在一起，就一定有人把它们连起来
    //      —— 那正是被老板否掉的那一版。隔离动作的签名（`quarantineLegacy` 不收
    //      username）和调用点（启动时一次、与账号无关）一起把这条路堵死。
    //   账号取**已持久化**的那一个（上次登录记在 `<userData>/current-account.json`）：
    //   启动这一刻渲染层还没发 `/api/auth/profile`，只能信磁盘。
    ensureLegacyQuarantine();
    let startupAccount = null;
    try { startupAccount = accountScope.readAccount(app.getPath('userData')); }
    catch { startupAccount = null; }
    applyAccountScope((startupAccount && startupAccount.username) || '');
    // KI-010：读方鉴权必须挂在 webRequest 上 —— handler 里拿不到 Origin，
    //   只有这里能看到发起请求的 frame.url。两行缺一不可：没有守卫 = 任意网页可读根内文件。
    installAppAssetOriginGuard(session.defaultSession);

    setupPermissions();

    const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
    if (app.isPackaged) process.env.PYTHON_RUNTIME_DIR = path.join(process.resourcesPath, 'python-runtime');
    const skillsDir = path.join(base, 'skills');
    startBackend({
      skillsDir,
      dataDir: app.getPath('userData'),
      // ★ 2026-11-06 产物隔离：账号变了就立刻把产物目录与媒体授权根切过去。
      //   为什么不等下一次 `wanx:*`：登录后到第一次点「生成」之间，用户会先看作品库 /
      //   海报页 —— 那几次读取必须已经是新账号的目录，否则他看到的是上一个账号的作品。
      // 注意这里**只传名字**：钩子的职责是"切目录"，不负责记账号（记账在 backend.js 两处）。
      onAccountChange: (user) => applyAccountScope(String((user && user.username) || '').trim()),
    });

    // ---- 长期记忆：把主进程侧的档案根告给后端（B 阶段 #252 配套）----
    // 时序注意：**必须**在 startBackend 之后调用 —— startBackend 内部才会把 dataDir 记下来
    // （memoryDataDir = dataDir），在此之前调等于什么都没设置。
    //
    // ★ 这行解决的是"双根分叉"这一整类 bug：
    //   后端的抽取/落盘走 memoryStore.resolveMemoryRoot({dataDir}) ⇒ `userData/memory/owner/`；
    //   而记忆 IPC 三层读写**天然**也走 app.getPath('userData') ⇒ 同一个根。
    //   但后端在**单测 / 独立进程**里可能用别的 dataDir（缺省还会回落 ~/.douya-claw/memory）。
    //   一旦两个根不一致，症状是**静默的**：UI 显示"记忆是空的"，而磁盘上其实有文件。
    //   ⇒ 在这里显式对齐，并让后端把它写进启动日志，排障时一眼能看出来。
    try {
      const bp = backend.getMemoryWritePath && backend.getMemoryWritePath();
      if (bp && bp.dataDir) console.log('[Memory] write path ready: ' + bp.dataDir);
    } catch { /* 仅日志，失败不影响启动 */ }

    // 【0.21.21 · 老板 2026-10-21】这里原来是 `setupMmclawAuthInjection();`
    // （为上游货源档期 iframe 往 api.example.com/api/* 注入登录态）。档期页连同 iframe 外壳
    // 一起下线后，该函数已整段删除，调用点同步移除 —— 见上方 646 行附近的说明。
    // ⚠️ 留个空注释而不是直接抹掉这一行，是为了让 diff 一眼能看出「这里曾经有一步」，
    //    避免后人以为启动流程本来就少一环。

    // 自动更新（T06：左上角卡片 + 一键自动更新）：启动静默检查 → 有新版推卡片 → 点「立即更新」下载 → 自动替换。
    // updater 内部有 8s 超时闸 + 单次触发守卫：网络不通也能正常打开软件、不会双开。
    // 仅打包后启用；开发模式（app.isPackaged=false）跳过，避免 dev 下无意义检查。
    // 需要彻底关闭时用 DOUYA_DISABLE_UPDATER=1。
    //
    // ★★ 2026-10-22：**窗口必须先建，不能藏在 initUpdater 的回调里**。
    //   原来窗口的创建是这个 if/else 的两个分支各调一次（更新分支走回调、非更新分支直调），
    //   而 initUpdater 内部要**先**做完那次带 8s 超时闸的静默检查才会回调 ——
    //   于是网络慢的时候，用户双击图标后要盯着空桌面等近 8 秒才看到窗口。
    //   那种体验和"打不开"几乎无法区分（用户会开始反复双击，进而撞上单实例锁）。
    //   窗口是启动的第一优先级，不该排在一次网络探测后面。
    createWindow();
    // 【第三层技术防护 · 授权门】
    //   **必须**排在 createWindow() 之后。它内部先读本地凭据（很快、同步），
    //   再在后台发一次网络校验（慢）。排在窗口之前的话，网络慢时用户就要盯着
    //   空桌面等 —— 那正是 2026-10-22 修掉的那个"与打不开无法区分"的毛病。
    //   函数本身立刻返回，不等网络；内部炸了也只影响功能可用性，不影响启动。
    //   临时关掉：DOUYA_DISABLE_LICENSE=1
    if (process.env.DOUYA_DISABLE_LICENSE !== '1') {
      try {
        wireLicenseGate();
      } catch (e) {
        console.error('[license] 接线失败（不影响启动）：', e && e.message);
      }
    }
    // 【0.21.19 · 老板第 4 条】「删掉右下角那个小的豆芽悬浮窗」。
    // 原来的两条启动分支里都是 `createWindow(); createPetWindow();`，现在只建主窗。
    // ⚠️ 只删「创建」这个动作，**函数本体一行没删**：
    //    createPetWindow()（下方）、PET_SIZE_COLLAPSED / PET_SIZE_EXPANDED、petBottomRight()、
    //    applyPetBounds()、四个 pet:* IPC handler、vite.config.pet.cjs、src/renderer-pet/、
    //    以及 scripts/build/package.mjs 里那段桌宠构建自证，全部原样保留。
    //    理由（team-lead 定）：① 老板要的是「看不见它」，不建窗口即达成，用户侧零差别；
    //    ② 拆构建链会连带拔掉 package.mjs 里「桌宠产物是否真的重建过」那条已修好的回归防线，
    //       而本轮根本不需要碰它；③ 老板反复改主意是常态，回滚成本是「加回两行」。
    // 已知残留（本轮不处理）：dist/renderer-pet 仍会构建并打进安装包（约 1.6MB 无效体积），
    // 属于「已知浪费」，动它就要改 package.mjs 的自证段，风险 > 收益，留作后续单独一轮。

    if (process.env.DOUYA_DISABLE_UPDATER !== '1' && app.isPackaged) {
      // push：把更新状态推给渲染层左上角卡片；主窗口不可见（常驻托盘隐藏）时降级为系统通知一次。
      let updateNoticeShown = false;
      const pushUpdateState = (state) => {
        if (!state) return;
        // 卡片需要 available / downloading / ready **三种**状态：进度条与「正在自动重启更新」都靠它。
        // 主窗口可见 ⇒ 一律推给渲染层（none 用于收起卡片）。
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isVisible()) {
            mainWindow.webContents.send('update:state', state);
            return;
          }
          // 主窗口存在但不可见（已最小化到托盘）：只有「有新版」值得用系统通知喊一声，
          // 且每个可用版本只提示一次；进度/完成不打扰用户（托盘里看不见，通知也只会更吵）。
          if (state.phase !== 'available') return;
          if (!updateNoticeShown) {
            updateNoticeShown = true;
            const r = sendSystemNotification({
              title: '豆芽AI 有新版可用',
              body: '点这里完成更新',
              onClick: () => showMainWindow(),
            });
            if (!r.ok) updateNoticeShown = false; // 发不出去则下次再试，不静默吞掉
          }
          return;
        }
        // 主窗口**尚未创建**（启动瞬间的首次检查）：这不是「用户把窗口收进托盘了」，而是窗口还没生出来。
        // 此处的状态不会被丢：updater.js 已把它留存，渲染层挂载后会经 update:getState 主动补拉。
        // 这里**不发系统通知**——否则用户会先收到一个「点这里完成更新」的托盘通知，点开却什么都没发生
        //（卡片还没挂上），既误导又白打扰一次。
      };
      // ★ 回调仍然是「确保主窗存在」，但**不能是裸 createWindow()**（2026-10-22 复审 P1-1）。
      //   createWindow 的单例守卫在 2026-10-22 从 `focus()` 改成了 `showMainWindow()`
      //   （那是为了修"隐藏到托盘的窗口叫不出来"）。两者叠加之后语义悄悄变了：
      //   用户在检查更新期间把窗口收进托盘 ⇒ 回调触发 ⇒ 窗口被**拉回前台并抢焦点**。
      //   用户什么都没点，窗口自己跳出来 —— 比"叫不出来"更容易被当成故障。
      //   所以这里显式表达本意：只在窗口**不存在**时补建；还活着就一个手指头都不碰。
      initUpdater(() => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      }, pushUpdateState);
    }

    // 渲染层挂载后补拉当前更新状态：修复「启动瞬间那次推送发生在窗口创建之前、必然丢失」——
    // 没有这条，正常网速下「有新版本」卡片永远不出现（下载也不会被触发，因为它要用户点卡片上的按钮）。
    ipcMain.handle('update:getState', async () => {
      try {
        return getLastState() || null;
      } catch (err) {
        console.error('[Updater] update:getState failed:', err && err.message ? err.message : err);
        return null;
      }
    });

    // 渲染层卡片点击「立即更新 / 稍后」经此 IPC 驱动主进程更新动作（见 updater.js 的 updateAction）。
    // 🔴 必须 await 并把真实结果回给渲染层：updateAction 内部 await 了 downloadUpdate()，
    //   不 await 就会「立刻返回 ok:true」而把失败丢掉 —— 渲染层以为成功了，于是什么都不提示，
    //   用户看到的就是「点了立即更新没反应」（2026-09-22 实测 0.20.6 现场即此）。
    ipcMain.handle('update:action', async (e, action) => {
      try {
        return await updateAction(action);
      } catch (err) {
        console.error('[Updater] update:action failed:', err && err.message ? err.message : err);
        return { ok: false, error: (err && err.message) ? err.message : String(err) };
      }
    });

    // 设置 → 高级配置 的「检查更新」：手动触发一次检查并**直接拿到结果**。
    // 不能只依赖左上角卡片 —— 卡片只在「有新版」时才存在，用户想知道「是不是最新」时它不显示。
    ipcMain.handle('update:check', async () => {
      try {
        return await checkNow();
      } catch (err) {
        console.error('[Updater] update:check failed:', err && err.message ? err.message : err);
        return { ok: false, message: '检查更新失败，请稍后再试' };
      }
    });

    // 设置 → 高级配置 的「当前版本」：读打包时写进包里的版本号（package.json.version）。
    // 之前界面**没有任何地方**显示当前版本，用户无法判断自己是不是最新版。
    ipcMain.handle('app:getVersion', async () => {
      try {
        return app.getVersion();
      } catch (err) {
        console.error('[App] app:getVersion failed:', err && err.message ? err.message : err);
        return '';
      }
    });

    // 托盘常驻：必须早于任何关窗动作创建，保证「关窗之后」一定有召回入口。
    syncLoginItemFromSystem();
    createTray();

    // ---- 定时任务：装配并启动调度器 ----
    // 启动时机：必须在 startBackend（端口已监听）与 createTray（通知目标已就绪）之后。
    // 执行通道 = 回环 HTTP 自调用 POST /api/chat（与用户聊天同一条代码路径），读 SSE 到结束。
    const BACKEND_BASE = 'http://127.0.0.1:' + (Number(process.env.BACKEND_PORT) || 10119);
    automations = createScheduler({
      // ★ 必须用 app.getPath('userData')：绝不硬编码，否则会分叉出 ~/.douya-claw 幽灵目录。
      dataDir: app.getPath('userData'),
      now: () => Date.now(),
      readResidentSettings,
      // 通知目标复用既有 sendSystemNotification（返回 {ok,error}，ok:false 时调度器会记日志降级不静默）
      notify: (title, body, opts) => sendSystemNotification({ title, body, silent: !!(opts && opts.silent) }),
      post: createHttpPost({ baseURL: BACKEND_BASE, logger: console }),
      // 工具表与用户聊天同形状：真源是 src/shared/toolSchema.js（App.jsx / renderer-pet 共用），
      // automations.js 里是它的 CJS 等价副本（主进程是 CJS，同步 require 不了 ESM）。
      // 两份实现由 scripts/smoke/unit-tool-schema-parity.mjs 做行为级对拍，单独改一边必转红。
      getTools: async () => {
        try {
          const r = await fetch(BACKEND_BASE + '/api/skills');
          if (!r || r.ok !== true) return [];
          const skills = await r.json();
          return buildToolsFromSkills(skills);
        } catch (e) {
          console.error('[automations] 取技能表失败（本轮不带技能）:', e && e.message);
          return [];
        }
      },
      intervalMs: 30000, // 短周期轮询（非裸 setTimeout）
      logger: console,
    });
    automations.start().catch((e) => console.error('[automations] 启动对账失败:', e && e.message));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // ---- 显示器拓扑变化（2026-10-22）----
    // 用户在软件**运行期间**拔掉外接屏、改分辨率、改缩放 —— 这些都不会经过任何一次
    // showMainWindow，窗口就静静留在了已不存在的坐标上。等他下次切回豆芽，才发现窗口
    // 在屏外（这时 'show' / 'restore' 监听会兜住，但提前处理体验更好，也避免他先看到
    // 一个正在被搬动的窗口）。
    // 事件语义：display-removed = 少了一块屏；display-metrics-changed = 分辨率/缩放/工作区变了。
    try {
      screen.on('display-removed', () => ensureWindowOnScreen(mainWindow, 'display-removed'));
      screen.on('display-metrics-changed', () => ensureWindowOnScreen(mainWindow, 'display-metrics-changed'));
    } catch (e) {
      console.error('[window] 注册显示器变化监听失败（不影响启动）:', e && e.message);
    }
  }).catch((e) => {
    // ★★ 2026-10-22：启动流程**任何一步**抛异常，原来会形成永久死局 ——
    //   进程在跑（单实例锁已被它持有）⇒ 用户再双击图标立刻静默 quit ⇒
    //   任务栏和托盘里却什么都没有 ⇒ **除了杀进程，用户没有任何出路**。
    //   这里做两件事：① 把真实堆栈留证（控制台 + 日志）；
    //             ② 尽力把「窗口 + 托盘」这两个存活底线生出来，至少让用户能操作、能重试。
    console.error('[boot] 启动流程抛异常（进入降级恢复）:', e && e.stack ? e.stack : e);
    try {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    } catch (e2) {
      console.error('[boot] 降级恢复：建窗口也失败:', e2 && e2.message);
    }
    try {
      createTray();
    } catch (e3) {
      console.error('[boot] 降级恢复：建托盘也失败:', e3 && e3.message);
    }
    // ★ 2026-10-22 复审 P2-3：渲染层**一定会**调用这几个 IPC（左上角更新卡片 + 设置页的
    //   「当前版本」）。它们的注册排在 startBackend 之后，一旦启动流程挂在更前面就一个都没注册，
    //   渲染层会收到 `No handler registered for 'update:getState'` 之类的拒绝 ——
    //   界面表现为卡片报错 / 版本号空白，而这正好发生在"已经出过一次错"的时候，
    //   用户会以为是两个独立的故障。这里补一组**安全默认值**（不是假装成功）。
    //   重复注册会抛，所以逐个 try 掉：已经注册过的那个保持原样（那是更好的实现）。
    const safeHandle = (channel, fn) => { try { ipcMain.handle(channel, fn); } catch { /* 已注册，保留原实现 */ } };
    safeHandle('update:getState', async () => null);
    safeHandle('update:action', async () => ({ ok: false, error: '启动过程出错，更新功能本次不可用' }));
    safeHandle('update:check', async () => ({ ok: false, message: '启动过程出错，暂时无法检查更新' }));
    safeHandle('app:getVersion', async () => { try { return app.getVersion(); } catch { return ''; } });
    // 两个底线都没立起来 ⇒ 只能明确告诉用户，而不是继续跑一个"幽灵进程"。
    // 判断依据用 BrowserWindow.getAllWindows() 而不是 mainWindow：窗口可能建出来了但渲染失败。
    let alive = false;
    try { alive = BrowserWindow.getAllWindows().length > 0; } catch { /* ignore */ }
    if (!alive) {
      try {
        dialog.showErrorBox(
          '豆芽AI 启动失败',
          '启动过程中出现错误，软件无法正常打开。\n\n'
          + '错误信息：' + (e && e.message ? e.message : String(e)) + '\n\n'
          + '请把这个错误信息反馈给我们。'
        );
      } catch { /* ignore */ }
      try { isQuitting = true; app.quit(); } catch { /* ignore */ }
    }
  });

  app.on('second-instance', () => {
    // 二次启动（用户又点了一次图标）：把可能已收进托盘的主窗召回到前台。
    // closeToTray 下主窗是 hide 而非销毁，这里必须 show()，不能只 focus()。
    showMainWindow();
  });

  // 真退出前置位：托盘「退出豆芽」与系统退出都会走到这里，放行 close 拦截器。
  app.on('before-quit', () => {
    isQuitting = true;
    // 定时任务停机钩子：① 标记「本次为干净退出」，避免下次启动把「退出时正在跑的任务」误判成漏跑；
    // ② 停掉轮询，避免退出过程中再触发新的执行。
    try { if (automations) automations.markCleanQuit(); } catch (e) { console.error('[automations] 干净退出标记失败:', e && e.message); }
    try { if (automations) automations.stop(); } catch { /* ignore */ }
    // 视频精剪的 Concat 子进程必须在这里收掉，否则退出后 concat.exe 残留成了孤儿进程
    //（用户下次开机看到一条莫名其妙的 concat.exe，且它会占着之前打开过的工程目录）。
    // ★ `force: true`：退出路径上不能等优雅关闭的 3 秒（窗口会卡一下），
    //   而"每个写操作都自动存过盘"保证了强杀不丢数据（见 concatStudio 文件头事实②）。
    // ★ 不 await：`before-quit` 不是异步钩子，等它反而可能拖住退出；`closeSession`
    //   内部是幂等的，进程被带走时最坏结果是 concat.exe 比我们晚几十毫秒死。
    try { if (concatStudio) concatStudio.closeSession({ force: true, reason: 'app-quit' }).catch(() => { /* 已在内部记录 */ }); } catch { /* ignore */ }
  });

  // 关掉所有窗口不再一律退出：closeToTray 打开时留在托盘常驻（定时任务的运行前提）。
  // 只有「正在真退出」或「用户关闭了常驻」才真正退出进程。
  app.on('window-all-closed', () => {
    if (isQuitting) return;                          // 正在退出，交给 quit 流程
    if (process.platform === 'darwin') return;       // macOS 惯例：常驻 Dock
    if (readResidentSettings().closeToTray) return;  // 常驻：留在托盘，绝不 app.quit()
    app.quit();                                      // 用户显式选择「关闭即退出」
  });
}
