// 「提示后可稍后」自动更新（T06 交互）：启动静默检查 → 有新版弹**左上角非模态卡片** →
// 点「立即更新」才**进度可见地自动下载** → 下载完**自动重启原地替换**成新版；点「稍后」则
// 退出程序时静默装好（下次打开即新版），且同版本不再重复弹（记住「稍后」）。
//
// onReady 在「无更新 / 已弹过卡片 / 出错兜底 / 超时」时**回调且只回调一次**，用于创建主窗口。
// 这样即便更新源网络不通或很慢，用户也一定能打开软件，且不会因多次回调开出多个窗口。
//
// push(state) 把更新状态推给渲染层左上角卡片；push 可缺省（默认 no-op），旧调用
// `initUpdater(() => ready++)` 仍完全兼容。state.phase ∈ {available, downloading, ready, error, none}。
//
// 🔴 关于 error 这个 phase（2026-09-22 补）：它**必须存在**，不能让失败落到 none 上。
//   none 的语义是「没有更新」，UpdatePrompt.jsx 见到它就 `return null` 把卡片整个收掉；
//   而「下载失败」若也走 none，用户看到的唯一变化就是「卡片消失了」——
//   也就是「点了立即更新，什么都没发生，没进度条也没提示」。老的 0.20.6 安装包
//   （resources/ 里缺 app-update.yml，downloadUpdate 必抛 ENOENT）实测就是这个现象。
//
// 关于旧注释「它会用远端旧版本覆盖本地补丁」的真实语义（避免误判为降级 bug）：
// 这**不是降级**。electron-updater 默认 allowDowngrade=false，远端版本 ≤ 本地时永不安装
// （见 node_modules/electron-updater/out/AppUpdater.js 的 isUpdateAvailable：仅 semver.gt 才返回 true）。
// 只有「某人跑的是本地手工补丁包、且其版本号低于线上已发布版本」时，自动更新才会用线上包覆盖该补丁——
// 这是正常的「拉齐到线上版本」行为，不是把新版降成旧版。故本实现不开 channel、不置 allowDowngrade。
const fs = require('fs');
const path = require('path');

// 渲染层推送目标（由 initUpdater 第二参数注入，缺省 no-op）；最近一次 available 的版本（供「稍后」记住）。
let pushState = () => {};
let lastAvailableVersion = '';

// 最近一次更新状态（available / downloading / ready / none）。
// 为什么必须留存：启动瞬间的首次检查里，update-available 是**先 pushState 再 fireReady()**，
// 而主窗口恰恰是在 fireReady 回调里才创建的 ⇒ 推送发生的那一刻渲染层根本还不存在，这次推送必然丢失。
// 实测后果：正常网速（检查 < 8s 超时闸）下「有新版本」卡片**永不出现**，只有网络慢到先触发 8s 超时闸、
// 窗口已建好之后 update-available 才到达时，卡片才碰巧显示 —— 一个「看网速才出现」的功能。
// 所以把状态留存在主进程，渲染层挂载后主动补拉一次（见 getLastState 与 preload 的 getUpdateState）。
let lastState = null;

// 用户主动触发的下载是否在进行中。用于把「下载失败」（必须让用户看见）与
// 「启动时的静默检查失败」（保持静默、不打扰）分开，避免同一个错误被展示两次。
let downloadInFlight = false;

// 自动更新不可用时的唯一出路：官网下载页。随失败状态一起推给卡片，渲染成「手动下载」按钮。
const MANUAL_DOWNLOAD_URL = 'https://api.example.com/download/';

// 把底层错误翻译成用户能看懂、且**能照着做**的一句话。
// 为什么必须区分：ENOENT + app-update.yml 是「本机安装包缺自动更新配置」，
// 跟网络毫无关系 —— 这种时候告诉用户「请检查网络」是误导，他会一直重试一直失败。
// 正确做法是直接把他引到手动下载（那是唯一出路）。
function friendlyUpdateMessage(raw, scene) {
  const m = String(raw || '');
  if (/ENOENT/.test(m) && /app-update\.yml/i.test(m)) {
    return '当前安装版本缺少自动更新配置，自动更新暂不可用。请点「手动下载」到官网下载最新版安装。';
  }
  return scene === 'check'
    ? '连不上更新服务器，请检查网络后重试'
    : '更新下载失败，请检查网络后重试；也可以点「手动下载」到官网获取最新版。';
}

// 让「下载失败」变成一个**用户看得见**的状态（卡片留在原地显示原因 + 手动下载出口），
// 而不是让它被吞成 none 把卡片弄没。
function reportDownloadFailure(raw, action) {
  emit({
    phase: 'error',
    version: lastAvailableVersion,
    message: friendlyUpdateMessage(raw, 'download'),
    detail: String(raw || '').slice(0, 400),
    manualUrl: MANUAL_DOWNLOAD_URL,
    // 「稍后」也会后台下载，失败同样要提示：用户以为「不点它也会自己装好」，实际不会。
    action: action === 'later' ? 'later' : 'download',
  });
}

// 记录 + 推送：所有状态出口都走这里，保证「留存的」与「推出去的」永远一致。
function emit(state) {
  lastState = state;
  pushState(state);
}

function initUpdater(onReady, push) {
  // 懒加载：electron-updater 在未打包（dev）模式下依赖未就绪，延迟到真正需要时才加载。
  const { autoUpdater } = require('electron-updater');
  const url = process.env.UPDATE_URL || 'https://api.example.com/download/';
  pushState = typeof push === 'function' ? push : () => {};

  // —— 单次触发守卫：无论结果 / 超时 / 多次事件，onReady 只调用一次（防双开 / 防卡死）。——
  let readyFired = false;
  const fireReady = () => {
    if (readyFired) return;
    readyFired = true;
    if (onReady) onReady();
  };

  // —— 超时闸（8s）：更新源网络不通 / 很慢导致 checkForUpdates 迟迟不回调时，也必须放行。
  // 否则主窗口的创建完全挂在 updater 回调上，用户会打不开软件。超时与任何结果都只放行一次。——
  const TIMEOUT_MS = 8000;
  const timer = setTimeout(() => {
    console.error('[Updater] 检查更新超时（' + TIMEOUT_MS + 'ms），放行启动。');
    fireReady();
  }, TIMEOUT_MS);

  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
  } catch (e) {
    console.error('[Updater] setFeedURL failed:', e && e.message ? e.message : e);
    clearTimeout(timer);
    fireReady();
    return;
  }

  autoUpdater.autoDownload = false; // T06 核心改动：先弹左上角卡片，点「立即更新」才下载
  autoUpdater.autoInstallOnAppQuit = true; // 「稍后」路径落地关键：退出时自动静默安装

  autoUpdater.on('update-available', (info) => {
    // 有新版：立即放行主窗口（卡片非模态，不打断操作），清超时避免后续误报「超时」。
    clearTimeout(timer);
    const version = info && info.version ? info.version : '?';
    lastAvailableVersion = version;
    // 手动检查的答复必须**在这里给出**，且早于下面的「已选稍后」判断：
    // 卡片会因「该版本已选稍后」而不弹，但用户是自己点的「检查更新」，必须拿到确定答复。
    settleManualCheck({ ok: true, phase: 'available', version });
    console.log('[Updater] 发现新版本 v' + version + '，弹出左上角更新卡片。');
    // 同版本已选「稍后」→ 不重复弹卡片（防每次开机都弹），但仍放行窗口。
    if (version !== readDismissedVersion()) {
      emit({ phase: 'available', version });
    } else {
      console.log('[Updater] 该版本已选「稍后」，本次不再弹卡片（退出时静默安装）。');
    }
    fireReady();
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = p && typeof p.percent === 'number' ? p.percent : 0;
    const mb = (n) => (n ? (n / 1048576).toFixed(1) : '?');
    console.log('[Updater] 下载进度 ' + pct.toFixed(1) + '% (' + mb(p.transferred) + '/' + mb(p.total) + ' MB)');
    emit({ phase: 'downloading', version: lastAvailableVersion, percent: pct, transferred: p.transferred, total: p.total });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // 下载完成：推「ready」让卡片显示「正在自动重启更新」，2.5s 宽限后原地静默升级（自动替换）。
    // 先清超时（已下载完成，肯定要放行）。
    clearTimeout(timer);
    const version = info && info.version ? info.version : '?';
    emit({ phase: 'ready', version });
    // 本包是 oneClick:false 的向导式 NSIS：isSilent=true 才能在原地静默升级，
    // 否则用户会面对一个要一路点「下一步」的安装向导；forceRunAfter=true 让程序重启。
    // 留 2.5s 宽限，让卡片先把「正在自动重启更新」显示出来，体验更顺。
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true);
    }, 2500);
  });

  autoUpdater.on('update-not-available', () => {
    clearTimeout(timer);
    settleManualCheck({ ok: true, phase: 'none' });
    emit({ phase: 'none' });
    fireReady();
  });

  autoUpdater.on('error', (e) => {
    // 网络 / 服务器异常兜底放行，避免程序变砖；不弹阻塞式致命框。
    const raw = e && e.message ? e.message : String(e);
    console.error('[Updater] error:', raw);
    clearTimeout(timer);
    // 「检查更新」按钮的问答通道（只有用户主动点了检查时，才有人在等这个结果）。
    settleManualCheck({ ok: false, message: friendlyUpdateMessage(raw, 'check') });
    // 🔴 不许把「失败」降级成 none —— none 会让卡片整个消失，
    //   用户看到的就是「点了立即更新没反应」。两种情形要继续保留当前画面：
    //   ① 已经在展示失败态（updateAction 的 catch 抢先把 error 推了出去）；
    //   ② 下载正在进行中（错误由 updateAction 的 catch 统一展示，避免同一错误展示两次）。
    if (lastState && lastState.phase === 'error') { fireReady(); return; }
    if (downloadInFlight) { fireReady(); return; }
    emit({ phase: 'none' });
    fireReady();
  });

  autoUpdater.checkForUpdates().catch((e) => {
    console.error('[Updater] checkForUpdates failed:', e && e.message ? e.message : e);
    clearTimeout(timer);
    fireReady();
  });
}

// —— 已忽略版本持久化（落盘 userData/updater.json）——
// 「稍后」的版本记住后，下次开机（同版本）不再弹卡片；读/写失败一律 fail-safe 当「没忽略过」。
function dismissedFilePath() {
  let userData = '';
  try {
    const { app } = require('electron');
    userData = app.getPath('userData');
  } catch (e) {
    userData = '';
  }
  return userData ? path.join(userData, 'updater.json') : '';
}

function readDismissedVersion() {
  const f = dismissedFilePath();
  if (!f) return '';
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    return obj && typeof obj.dismissedVersion === 'string' ? obj.dismissedVersion : '';
  } catch (e) {
    return '';
  }
}

function writeDismissedVersion(version) {
  const f = dismissedFilePath();
  if (!f || !version) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ dismissedVersion: version }), 'utf8');
  } catch (e) {
    // fail-safe：落盘失败不影响更新流程
  }
}

// 渲染层卡片点击「立即更新 / 稍后」经主进程 IPC 驱动此处（见 main.js 的 'update:action'）。
// 'download'：立即后台下载（下载完自动重启替换）。
// 'later'：记住该版本已忽略（下次开机同版本不再弹），但仍后台下载，退出时静默装上。
// 'dismiss'：把失败提示收掉（否则同一进程内它会一直挂在左上角，用户关不掉）。
//
// 🔴 必须 async 且必须 await downloadUpdate()（2026-09-22 修）：
//   downloadUpdate() 失败时返回的是 **rejected Promise**。原实现直接把它丢掉 ⇒
//   ① 变成「无人处理的 rejection」；② 失败经 error 监听被降级成 phase:'none'（卡片消失）；
//   ③ 主进程同步返回 {ok:true}，渲染层以为成功了。
//   三者叠加 = 用户点「立即更新」后**毫无反馈**（没进度条、没提示、卡片直接不见）。
//   现在把失败显式接住，并推一个 phase:'error' 让卡片留在原地说明原因。
async function updateAction(action) {
  const { autoUpdater } = require('electron-updater');

  if (action === 'dismiss') {
    emit({ phase: 'none' });
    return { ok: true };
  }
  if (action !== 'download' && action !== 'later') {
    return { ok: false, error: '未知的更新动作：' + String(action) };
  }

  // 「稍后」先同步落盘：既有契约要求同一 tick 内就记住该版本（见 unit-updater-guard 第 5 节）。
  if (action === 'later') writeDismissedVersion(lastAvailableVersion);

  downloadInFlight = true;
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    const raw = e && e.message ? e.message : String(e);
    console.error('[Updater] downloadUpdate 失败:', raw);
    reportDownloadFailure(raw, action);
    return { ok: false, error: raw };
  } finally {
    downloadInFlight = false;
  }
}

// 渲染层挂载后补拉：拿到「本次启动以来最近一次更新状态」（没有任何状态时返回 null）。
// 这是「启动瞬间那次推送必然丢失」的兜底 —— 卡片靠它才能在正常网速下出现。
function getLastState() {
  return lastState;
}

// ============================================================================
// 手动检查更新（设置 → 高级配置 的「检查更新」按钮）
// ----------------------------------------------------------------------------
// 和启动时的自动检查**共用同一套事件**，但结果必须直接回给调用方，不能只靠卡片推送：
//   · 卡片在「该版本已选稍后」时**故意不弹**（见 update-available 分支），
//     可用户是自己点的按钮，这时必须给出明确答复，不能什么都不显示；
//   · 卡片只在「有新版」时存在，用户想知道「是不是最新」时它根本不显示。
// 所以这里把结果 resolve 出去，渲染层拿到就能立刻说「已是最新版本」或「发现 vX」。
// ============================================================================
const MANUAL_CHECK_TIMEOUT_MS = 15000;
let pendingCheck = null;

// 结束当前手动检查（幂等：没有进行中的检查时什么都不做）。
function settleManualCheck(result) {
  if (!pendingCheck) return;
  clearTimeout(pendingCheck.timer);
  const done = pendingCheck.done;
  pendingCheck = null; // 先清空再回调，避免回调里再次触发同一条路径
  done(result);
}

// 主动检查一次。返回 { ok:true, phase:'available', version } / { ok:true, phase:'none' } /
// { ok:false, message }。连点复用同一次请求，避免并发打更新源。
function checkNow() {
  if (pendingCheck) return pendingCheck.promise;
  const { autoUpdater } = require('electron-updater');
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  const timer = setTimeout(
    () => settleManualCheck({ ok: false, message: '检查超时，请稍后再试' }),
    MANUAL_CHECK_TIMEOUT_MS
  );
  pendingCheck = { timer, promise, done: settle };
  try {
    // 结果由上面的 update-available / update-not-available / error 监听统一回填。
    autoUpdater.checkForUpdates().catch(() => {
      settleManualCheck({ ok: false, message: '连不上更新服务器，请检查网络后重试' });
    });
  } catch (e) {
    // 典型场景：开发模式 / 未打包时没有更新源配置，此时给出可读提示而不是崩掉。
    settleManualCheck({ ok: false, message: '当前环境不支持检查更新' });
  }
  return promise;
}

module.exports = { initUpdater, updateAction, getLastState, checkNow };
