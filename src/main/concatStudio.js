'use strict';

/**
 * concatStudio.js —— 「视频精剪」页面的**主进程常驻会话层**（Concat 0.2.9 · MCP over stdio）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件为什么存在（与 `skills/concat-video/` 的分工）
 * ═══════════════════════════════════════════════════════════════════════════
 * 技能侧（`skills/concat-video/lib/mcp.js` 的 `openSession`）的模型是
 * 「每次 action 开一次会话、`finally` 关掉」。那对**模型一次性调用**是对的：
 * 一次 render 就是一条命令，跑完就结束，开着不放纯属占内存。
 *
 * 但**编辑器不能用那个模型**。人拖一下时间轴会产生几十次 `clips_move` /
 * `clip_trim`；每次编辑都重新 `spawn(concat.exe)` + `initialize` 握手，
 * 每一步都要 1~2 秒（本机实测 concat.exe 冷启动到握手完成 ≈1.4s）。
 * 后果不是"慢一点"，而是「拖不动」—— 手指已经抬起来了，画面还在半秒前的状态。
 * ⇒ **编辑器必须常驻一条会话。** 这是本文件存在的唯一理由。
 *
 * 常驻的代价是「进程会一直活着」，所以必须配一条**空闲自动关**（见 IDLE_CLOSE_MS），
 * 否则用户进一次这个页面，concat.exe 就跟着豆芽进程活到关机（任务管理器里一条孤儿）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 六条实测事实（都是本机跑出来的，不是读文档读来的；改动前请重跑验证）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① **工程是「会话内对象」，不是「目录」**。实测：会话 A 里 `project_create`
 *      建好工程、加好片段，`close()` 后新开会话 B，直接 `timeline_read` 会返回
 *      `isError:true` + `code:notOpen`（原文：`...\p is not open - open it first`）。
 *      ⇒ 每次（重）建会话后，**必须**拿记住的工程目录重新 `project_open` 一次，
 *        否则用户看到的是「刚才还好好的，回来就报工程没打开」。
 *        这正是 `ensureSession()` 里那段 `project_open` 的由来，也是 `openPath`
 *        这个模块级变量存在的理由。
 *   ② **未保存的编辑在会话关闭时丢失**。实测：加完 clip 不调 `project_save` 就
 *      `close()`，`concat.json` 里只有 `{concat,name,video}`，**没有 tracks/clips**；
 *      加了 `project_save` 之后同一个文件里才有 `timelines[0].clips`。
 *      ⇒ 编辑器若只在"用户点保存"时才写盘，一次空闲自动关就等于丢掉 5 分钟的剪辑。
 *        所以这里对**每个写操作都自动 `project_save`**（见 autosave()），
 *        顺带让"退出应用"这条路径不必同步保存（赶不及，见 closeSession 的 force 分支）。
 *        代价是每次编辑多一次本地 JSON 写（工程文件几 KB，实测 <2ms），
 *        换的是「永远不丢用户的手工活」—— 这个交换在编辑器里是无脑划算的。
 *   ③ **写操作自己就把快照带回来了**。实测 `clip_add` / `track_add` / `edit_undo`
 *      的 `structuredContent` 里直接就有 `{canUndo,canRedo,media,project,timeline,createdId}` ——
 *      与 `timeline_read` 同形。任务书 F 条要求"写操作后再 `timeline_read` 一次"，
 *      目的是「前端一次 IPC 拿到新快照」；既然响应本身就带着，再来一次纯属多一个
 *      往返（拖拽热路径上这是 1/3 的额外延迟）。
 *      ⇒ 实现取「**优先用工具自带的快照，缺了才补 `timeline_read`**」，
 *        达成的结果与 F 条完全一致（一次 IPC 拿到 `{ok:true, ...snapshot}`），
 *        且更快。这是一处**有意偏离**，理由留在这里，不当暗改。
 *   ④ **`preview_frame` 不给 `output` 时内联返回 PNG**。实测返回形状：
 *      `content: [{type:'image', mimeType:'image/png', data:'<base64>'}, {type:'text', text:'...'}]`
 *      + `structuredContent: {height, time, width}`。图片在 **`content` 数组里**，
 *      不在 `structuredContent` 里 —— 后者只有尺寸和时间。
 *   ⑤ **`tracks[].index` 越大越在上层**。实测证据（技能侧同样记录过）：T1 放红底、
 *      T2 放蓝图并缩到 40% 移到右上，抽帧后右上角是蓝色、左侧仍是红色 ⇒ T2 盖住 T1。
 *      而 `timeline.tracks` 数组本身**可能不是按 index 排的**（`track_add` 新建的轨
 *      `t2` 会追加到数组末尾，且 index 为当前最大值）。⇒ 前端**必须按 index 排序**画轨道，
 *      不能靠数组下标，也不能靠数组倒序。
 *   ⑥ **`clips` 是扁平数组，靠 `clip.track` 归属**。`timeline_read` 里没有一个
 *      `tracks[].clips` 这样的嵌套结构，每个 clip 自己带 `track`（轨 id）。
 *      ⇒ 前端要画「哪条轨上有哪些片段」必须自己按 `clip.track` 分组。
 *        本文件的 `snapshot()` 把这件事**规范化**成前端直接能用的形状（见 normalizeSnapshot），
 *        但分组仍留给前端做 —— 因为分组结果与「轨道排序、播放头位置、缩放比例」都有关，
 *        在主进程里算等于把 UI 布局逻辑搬进 IPC，改一次布局要动两处。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三条硬约束
 * ═══════════════════════════════════════════════════════════════════════════
 *   · **绝不抛异常**。每个对外函数都返回 `{ok:false, error}`。主进程的 IPC handler
 *     外面另有一层 try/catch，但那是兜底，不是许可 —— 一个会抛的模块会让
 *     `ipcMain.handle` 把异常序列化成渲染层看不懂的 `Error invoking remote method`。
 *   · **绝不 require('electron')**。本仓 140+ 条单测（含本文件的 smoke）直接
 *     `require` 主进程模块在纯 node 里跑；顶层引 electron 会让它们只能在 Electron
 *     进程里跑 ⇒ 等于没有测试。对话框之类的能力由 `main.js` 提供，这里不碰。
 *   · **同一会话串行**。NDJSON 是单工流，同一个 client 上并发 `callTool` 会让
 *     「谁收到哪个响应」变得不可推理（客户端有 id 对应，但 Concat 侧对同一工程的
 *     并发修改本身是竞态）。所有调用都排进一条队列（见 enqueue）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { findConcatExecutable, createMcpStdioClient } = require('./mcpStdioClient');

// ── 常量（每个都有理由，别照着感觉调）──────────────────────────────────────

/**
 * 空闲多久自动关会话。
 * 5 分钟：比「人离开座位接个电话」长，比「用户关了页面去干别的」短。
 * 太短会在用户思考时反复重启（每次 1.4s 冷启动，体验比不关更差）；
 * 太长（30 分钟）等于本文件白写 —— 那条 concat.exe 会一直挂在任务管理器里。
 */
const IDLE_CLOSE_MS = 5 * 60 * 1000;

/** 握手超时。concat.exe 本机冷启动实测 ≈1.4s；给 20s 足够覆盖磁盘抖动。 */
const HANDSHAKE_TIMEOUT_MS = 20000;

/** 普通工具调用超时。工程文件本地读写，正常几十毫秒；120s 只防真卡死。 */
const CALL_TIMEOUT_MS = 120000;

/** 渲染/抽帧类超时（`preview_frame` 要合成整帧，1080p 实测数百毫秒到几秒）。 */
const PREVIEW_TIMEOUT_MS = 180000;

/** `export_wait` 可能跑几分钟；IPC 侧不透传它（前端轮询 `export_status`），仅兜底。 */
const EXPORT_WAIT_TIMEOUT_MS = 600000;

/**
 * `preview_frame` 内联返回的上限（base64 字符数）。
 * 3 MB ≈ 2.2 MB 原图。超过它就不再往渲染层塞 dataURL ——
 * 一次 IPC 传 10MB+ 的字符串会让渲染进程的主线程卡在反序列化上（画面直接白一下），
 * 而预览帧只是「拖时间轴时的小缩略图」，本来就不该有那个量级。
 * 超限的处理：先降一档分辨率重抽（见 previewFrame），仍超限才落临时文件。
 */
const PREVIEW_INLINE_MAX = 3 * 1024 * 1024;

/** 落盘预览图的存活时间：给渲染进程读完 `file://` 的机会，然后自己删掉。 */
const PREVIEW_TMP_TTL_MS = 60000;

/**
 * 标题的**可见默认样式**（实测出来的，不是审美偏好）。
 *
 * 为什么必须有这一层 —— 不给 `style` 时 `title_add` 落的是 Concat 的
 * `TextStyle::default()`（实测 schema：`color:"#ffffff"`、`fontWeight:700`、
 * `fontSize:0.09`、`strokeWidth:0`、`background:""`），也就是**纯白、无描边**。
 * 我们真跑抽帧验过：白底画面上加一段这样的标题，**一个暗像素都没有**
 * （`preview_frame` → rgb24 逐像素统计：darkPx=0，whitePx=76743）——
 * 用户看到的就是「点了加标题，什么都没出现」，正是老板说的那种「不可见的空背景」。
 *
 * 加上下面这套之后同一张帧 darkPx=865（= 白字外面那圈黑描边），深色/浅色画面都读得出：
 *   · `strokeWidth: 0.005` 是"以画面高度为单位的描边粗细" ⇒ 1080p 约 5.4px、
 *     240p 约 1.2px，足够在白墙上把白字勾出来，又不会糊成一坨；
 *   · `maxWidth: 0.9` 让长句在画面内换行并留 5% 边距。实测同一段 32 字标题：
 *     不设 ⇒ 文字横向占到 9..311（320 宽的帧，几乎贴边）；
 *     设 0.9 ⇒ 19..300，两侧各留约 6%。行数一样（67 行有字），只是不再顶边。
 *   · `background: ''` 保持无底板：底板是"综艺字幕"的做法，默认不替用户选。
 *
 * ⚠️ 这里的键名**照 `title_add` 的 `style` schema 原样抄**（23 个字段里的 9 个），
 *    不是我们自己起的名字。改之前先重跑 `node scripts/smoke/_probe-concat-tools.mjs
 *    --grep=title_add` 看一遍真实 schema。
 */
const TITLE_DEFAULT_STYLE = {
  fontSize: 0.09,
  fontWeight: 700,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 0.005,
  shadow: true,
  align: 'center',
  lineHeight: 1.2,
  maxWidth: 0.9,
  background: '',
};

/** 标题文字的长度上限（字符）。只是防呆：一次粘贴 10 万字的正文当标题没有意义。 */
const TITLE_MAX_CHARS = 500;

/**
 * 把用户输入的文字规范化成可以交给 `title_add` 的 `style.content`。
 *
 * **必须在这里挡掉空串**：实测 `title_add` 收到 `style.content: ""` 时会**成功**
 * 建出一个 `{kind:'text', text:''}` 的片段（`name` 变成 "Text"）—— 那正是
 * 一个不可见的空背景，而且它是"成功"的，前端连报错都没有。
 * 所以空文字在到达引擎之前就要被拒（见 EDIT_OPS.titleAdd 的 require）。
 *
 * @param {*} raw
 * @returns {string}
 */
function normalizeTitleText(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw);
  // 换行保留（标题可以多行），但把 CRLF 归一成 LF：Concat 的 `content`
  // 是"words themselves, newlines included"，混着 \r 会让它把 \r 画成一个方块。
  const text = s.replace(/\r\n?/g, '\n').trim();
  return text.length > TITLE_MAX_CHARS ? text.slice(0, TITLE_MAX_CHARS) : text;
}

// ── 模块级单例状态 ────────────────────────────────────────────────────────

/**
 * @typedef {{client:object, path:string, source:string, version:string, toolCount:number}} Session
 */

/** @type {Session|null} 当前常驻会话（null = 没开会话） */
let session = null;

/** @type {Promise<{ok:boolean, session?:Session, error?:string}>|null} 正在进行的启动（防并发重复 spawn） */
let starting = null;

/** 累计 spawn 次数。**只用于诊断/门禁**（"常驻会话只 spawn 一次"这条断言靠它）。 */
let spawnCount = 0;

/**
 * 当前打开的工程目录（绝对路径，空串 = 没有工程）。
 * 存在的理由见文件头事实①：会话重建后要靠它把工程重新打开。
 */
let openPath = '';

/** @type {NodeJS.Timeout|null} 空闲关闭计时器 */
let idleTimer = null;

/** 串行队列的尾巴。所有工具调用都挂在它后面，见 enqueue()。 */
let queueTail = Promise.resolve();

/** 队列里还没跑完的步数（诊断用）。 */
let queueDepth = 0;

/** 最近一次操作的错误（诊断用，不影响返回值）。 */
let lastError = '';

/**
 * `hasAudio` 的真相缓存：`小写绝对路径 → boolean`。
 *
 * 为什么需要这个缓存（**这不是优化，是正确性**）：
 *   `timeline_read` 的 media 块**根本不报 hasAudio**（实测 0.2.9 只有
 *   `id/kind/name/path/duration/width/height` 七个键），只有 `media_probe` 才有。
 *   而渲染层的素材卡片用 `media.hasAudio` 决定要不要画小喇叭图标 ——
 *   如果我们把"没报"直接写成 `false`，那么**每一条有声音的视频都会被显示成"无声"**。
 *   这不是"字段缺失"，是**给出一个恒假的错误答案**，而症状看起来像
 *   "这软件识别不了音轨"，用户不会想到是主进程写死了 false。
 *
 * 于是：能拿到真相的地方（`media_probe`）就把真相记下来，拿不到就标
 * `hasAudioKnown:false`，让前端区分"确实没声音"与"还没探测过"，而不是替它猜。
 *
 * 为什么是 `importMedia` / `openProject` 去填，而不是在 `snapshot()` 里填：
 *   `snapshot()` 是**拖拽热路径**（每帧都可能调）。在里面按需 probe 会让
 *   首次快照多出 N 次往返（N = 素材数），表现为"第一次进页面卡一下"。
 *   而导入素材、打开工程是**一次性事件**，在那里花 50ms/个完全不影响手感。
 */
const audioCache = new Map();

/**
 * 从 `media_probe` 的返回里判断"这个文件有没有声音"。
 *
 * ⚠️ **实测事实（与直觉相反，踩过）**：`media_probe` 的返回里**没有 `hasAudio` 这个键**。
 *    0.2.9 实测返回的是：
 *      `{ kind:'video', duration, path, video:{codec,frameRate,...,width,height},
 *         audio: {channels,codec,index,language,sampleRate,title} | null,
 *         audioTracks: [ ...同上... ] }`
 *    所以判据是 `audio` 非空**或** `audioTracks` 非空，**不是** `d.hasAudio === true`
 *    （那样写恒为 false，症状是"每个有声音的视频都显示无声"，而代码看起来完全正常）。
 *    两个字段都给：`audio` 是"主音轨"，`audioTracks` 是全部音轨；只认一个会漏掉
 *    "多音轨但主音轨标记缺失"的文件。
 *
 * @param {object|null} d
 * @returns {boolean}
 */
function hasAudioOf(d) {
  const x = d && typeof d === 'object' ? d : {};
  if (x.audio && typeof x.audio === 'object') return true;
  if (Array.isArray(x.audioTracks) && x.audioTracks.length > 0) return true;
  // 兼容：万一将来 Concat 直接给了布尔（不依赖它，但给了就用）。
  return x.hasAudio === true;
}

/**
 * 探测若干素材的 hasAudio 并写进缓存。**失败不抛、不阻塞主流程**。
 *
 * @param {Session} s
 * @param {string[]} files 素材绝对路径
 * @returns {Promise<void>}
 */
async function warmAudioCache(s, files) {
  for (const file of files) {
    if (!file || typeof file !== 'string') continue;
    const key = file.toLowerCase();
    if (audioCache.has(key)) continue;
    const r = await rawCall(s, 'media_probe', { path: file }, CALL_TIMEOUT_MS);
    if (!r.ok) continue; // 探测失败就别写缓存，下次再试（写 false 就成了假信息）
    audioCache.set(key, hasAudioOf(r.data));
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * 任意异常 → 一行可读文本。**永不抛**（`e` 可能是字符串、null、循环引用对象）。
 *
 * @param {*} e
 * @returns {string}
 */
function msgOf(e) {
  if (e === null || e === undefined) return '未知错误';
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && typeof e.message === 'string' && e.message) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 从 MCP `tools/call` 的原始结果里抠出结构化数据。
 *
 * Concat 的返回**同时**给两份：`structuredContent`（对象）与 `content[0].text`（同一份
 * JSON 的字符串）。优先取前者 —— 它省掉一次 `JSON.parse`，而且不会因为文本被截断而炸。
 *
 * @param {*} res
 * @returns {object|null}
 */
function dataOf(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
  const parts = Array.isArray(res.content) ? res.content : [];
  for (const c of parts) {
    if (c && c.type === 'text' && typeof c.text === 'string' && c.text) {
      try {
        const parsed = JSON.parse(c.text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* 不是 JSON 的文本（例如纯粹的说明文字），跳过 */
      }
    }
  }
  return null;
}

/**
 * 把工具级失败（`isError:true`）翻译成人能看懂的一句话。
 *
 * ⚠️ 工具级失败**不是**连接故障：`result.isError === true` 表示"这件事没干成"，
 *    与"连不上 Concat"是两件事。混成一句话会让前端以为引擎崩了、把整个页面切成错误态，
 *    而实际上只是「这个 clipId 不存在」。
 *
 * 错误码取自 Concat 自己（实测见过 notOpen / invalid / busy / noSuchProject / failed）。
 *
 * @param {string} tool
 * @param {object|null} data
 * @returns {string}
 */
function explainToolError(tool, data) {
  const err = data && data.error && typeof data.error === 'object' ? data.error : null;
  const code = err && err.code ? String(err.code) : (data && data.code ? String(data.code) : 'failed');
  const raw = (err && err.message) || (data && data.message) || '';
  const why = raw ? '（Concat 原话：' + raw + '）' : '';
  switch (code) {
    case 'notOpen':
      return '这个工程当前没打开（Concat 只接受已打开的工程）。' + why;
    case 'invalid':
      return '参数不被 Concat 接受。' + why;
    case 'busy':
      return 'Concat 正忙（同一时间只允许一个导出任务）。' + why;
    case 'noSuchProject':
    case 'notFound':
      return 'Concat 找不到这个工程或对象（目录被挪走/删掉，或 id 过期了）。' + why;
    default:
      return 'Concat 说「' + tool + '」这一步没做成 [code=' + code + ']。' + why;
  }
}

// ── 串行队列 ──────────────────────────────────────────────────────────────

/**
 * 把一次调用排进串行队列。**这是本文件正确性的地基**，不要绕过它。
 *
 * 为什么必须串行（而不是"客户端有 id 对应，并发也没事"）：
 *   · NDJSON 是单工流。客户端的 id 对应能保证"响应回到正确的 Promise"，
 *     但保证不了"Concat 内部处理顺序"——两个 `clips_move` 同时在路上，
 *     谁先落地取决于服务端调度，而编辑器的时间轴编辑**是有序语义**的
 *     （先删后加 ≠ 先加后删）。
 *   · 更现实的一条：`export_start` 之后紧跟 `clips_move`，并发时可能变成
 *     移动先落地、导出渲染的是移动后的画面，而用户看到的是"导出结果对不上"。
 *   ⇒ 队列把并发请求变成一条时间线，与用户的操作顺序一一对应。
 *
 * 为什么链本身必须 `.catch()` 兜住：
 *   如果某一步 reject，`queueTail` 就变成 reject 的 Promise，后续 `.then()`
 *   全部被跳过 —— 表现为"队列卡死"，之后每一次编辑都石沉大海（且没有任何报错）。
 *   这是队列实现最容易写错的一处，所以 `queueTail` 永远指向一个**已用 catch 兜平**的 Promise。
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
  queueDepth += 1;
  const run = queueTail.then(
    () => task(),
    // 上一步失败也要照跑（失败的是上一步的任务，不是队列）；
    // 这里再包一层 try 是为了 task 自己同步抛的极端情况。
    () => task(),
  );
  // 链本身永远是 resolved：既不让失败传播到后续任务，也不产生 unhandledRejection。
  queueTail = run.then(
    () => { queueDepth = Math.max(0, queueDepth - 1); },
    () => { queueDepth = Math.max(0, queueDepth - 1); },
  );
  return run;
}

// ── 会话生命周期 ──────────────────────────────────────────────────────────

/** 清掉空闲计时器（不开新计时器）。 */
function clearIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * 「刚刚用过」——重置空闲计时器。
 *
 * 每次成功调用后都要调，否则计时器从**启动时刻**起算：一个连续编辑了 4 分 50 秒的
 * 用户会在第 5 分钟被掐掉会话（正在拖的片段直接卡住）。重置的语义是"距上次使用"，
 * 不是"距启动"。
 *
 * `unref()`：计时器不该成为"进程为什么退不掉"的答案。本模块会被单测在纯 node 里
 * require 并调用，一个 ref 着的 5 分钟 timer 会让 `node xxx.mjs` 跑完不退出。
 */
function touch() {
  clearIdle();
  if (!session) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // 空闲关闭是"后台清理"，失败也无人在等结果 ⇒ 自己吞掉，不制造 unhandledRejection。
    closeSession({ reason: 'idle' }).catch(() => { /* 已在 closeSession 内部记录 */ });
  }, IDLE_CLOSE_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

/**
 * 起一条新会话：spawn + 握手 + `tools/list` + **把上次的工程重新打开**。
 *
 * 返回 `{ok:false, error}` 而不是抛异常 —— 三种失败（没装 / 打不开 / 握手超时）
 * 都要能说清楚原因给用户看，而"抛出去"在主进程里只会变成一句
 * `Error invoking remote method 'concat:probe'`。
 *
 * @returns {Promise<{ok:boolean, session?:Session, error?:string}>}
 */
async function startSession() {
  let loc = findConcatExecutable();
  if (!loc || !loc.path) {
    // 【2026-11-09 · 零操作补齐】新电脑没装 Concat 时：自动下载官方安装器 →
    // 静默安装 → 重新探测 → 直接连上。用户不点按钮、不填路径、不设环境变量。
    // 判据是「重新探测得到」，不是「安装器跑过了」；全链路失败才如实报错。
    let auto = null;
    try {
      auto = await require('./concatAutoInstall').ensureConcatInstalled({
        find: findConcatExecutable,
        onProgress: (msg) => { try { console.log('[concat] ' + msg); } catch { /* 日志不影响安装 */ } },
      });
    } catch (e) {
      auto = { ok: false, error: '自动安装模块异常：' + (e && e.message ? e.message : String(e)) };
    }
    if (!auto || !auto.ok) {
      return {
        ok: false,
        error: '本机没有 Concat（视频精剪引擎），已尝试自动安装但没成功：' +
          ((auto && auto.error) || '未知原因') +
          '。可手动从 https://github.com/jub0t/Concat/releases 安装后再打开本页。',
      };
    }
    loc = { path: auto.path, source: auto.source || 'auto-installed' };
  }

  /** @type {object} */
  let client = null;
  try {
    client = createMcpStdioClient({
      command: loc.path,
      args: ['--mcp'],
      // 单次调用的兜底超时。真正每次调用还会传精确的 timeoutMs。
      defaultTimeoutMs: CALL_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, error: '启动 Concat 失败：' + msgOf(e) };
  }

  // 计数放在 spawn 之后：createMcpStdioClient 内部已经同步 spawn 了，
  // 走到这里才算"真的起了一个进程"（门禁断言 spawns===1 依赖这个口径）。
  spawnCount += 1;

  try {
    await client.initialize({ timeoutMs: HANDSHAKE_TIMEOUT_MS });
  } catch (e) {
    const spawnErr = client && client.spawnError ? msgOf(client.spawnError) : '';
    let tail = '';
    try {
      tail = (client.stderrTail(6) || []).join(' | ');
    } catch { /* 拿不到就算了 */ }
    try { await client.close(); } catch { /* 已经没了 */ }
    // 进程已经起来却握手失败 ⇒ 大概率是版本不兼容或被杀软拦了。
    return {
      ok: false,
      error: 'Concat 启动了但握手没成功：' + (spawnErr || msgOf(e)) +
        (tail ? '（Concat 最后的输出：' + tail + '）' : '') +
        '。请确认版本是 0.2.9 或更高（MCP over stdio 从该版本起）。',
    };
  }

  // 工具清单：既用来报 probe 的 toolCount，也是一次"连接真的通了"的实证
  //（握手成功但 tools/list 失败，说明服务端半死，早发现比晚发现好）。
  let toolCount = 0;
  try {
    const tools = await client.listTools();
    toolCount = Array.isArray(tools) ? tools.length : 0;
  } catch (e) {
    lastError = 'tools/list 失败：' + msgOf(e);
  }

  const info = client.serverInfo && typeof client.serverInfo === 'object' ? client.serverInfo : {};
  /** @type {Session} */
  const s = {
    client,
    path: String(loc.path),
    source: String(loc.source || 'auto'),
    version: typeof info.version === 'string' && info.version ? info.version : '',
    toolCount,
  };

  // 会话意外退出（崩溃 / 被用户杀掉）：立刻把单例置空，下一次调用会重新 spawn。
  // 不这么做的话，后续每次调用都会打到一条死 client 上，全部报"不可用"，
  // 症状是"页面得重开一次才好"—— 而用户根本不知道要重开。
  client.on('exit', () => {
    if (session && session.client === client) {
      session = null;
      clearIdle();
    }
  });

  session = s;

  // 事实①：新会话里工程是"未打开"状态，必须显式重开。
  if (openPath) {
    const reopen = await rawCall(s, 'project_open', { path: openPath }, CALL_TIMEOUT_MS);
    if (!reopen.ok) {
      // 重开失败（工程被删/被 Concat 窗口占着）：清掉 openPath，让上层看到
      // "没有打开的工程"，而不是一直带着一个打不开的路径做后续所有操作。
      lastError = '重新打开上次的工程失败：' + reopen.error;
      openPath = '';
    }
  }

  touch();
  return { ok: true, session: s };
}

/**
 * 拿会话（必要时启动）。并发调用共享**同一个**启动 Promise，
 * 保证"同时来 3 个请求"也只 spawn 一次（否则一次点击会起 3 个 concat.exe）。
 *
 * @returns {Promise<{ok:boolean, session?:Session, error?:string}>}
 */
function ensureSession() {
  if (session && !session.client.isClosed()) return Promise.resolve({ ok: true, session });
  if (starting) return starting;
  if (session && session.client.isClosed()) {
    // 上一个会话已经死了（exit 事件可能还没到）：清干净再起。
    session = null;
    clearIdle();
  }
  starting = (async () => {
    try {
      return await startSession();
    } catch (e) {
      return { ok: false, error: '启动 Concat 会话时出现未预料的问题：' + msgOf(e) };
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/**
 * 在当前会话上直接调一个工具，**不经过队列**。
 *
 * 仅限 `startSession` 内部使用（那时我们已经在队列里，或者还没有会话可排队）。
 * 其余任何地方都必须走 `withSession` —— 绕过队列就是绕过本文件的唯一正确性保证。
 *
 * @param {Session} s
 * @param {string} tool
 * @param {object} args
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean, data:object|null, error?:string, raw?:*}>}
 */
async function rawCall(s, tool, args, timeoutMs) {
  try {
    const res = await s.client.callTool(tool, args || {}, {
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CALL_TIMEOUT_MS,
    });
    if (res && res.isError === true) {
      const data = dataOf(res);
      return { ok: false, data, error: explainToolError(tool, data), raw: res };
    }
    return { ok: true, data: dataOf(res), raw: res };
  } catch (e) {
    // 协议层失败（超时 / 子进程没了 / JSON-RPC error）走这里。
    let tail = '';
    try {
      tail = (s.client.stderrTail(6) || []).join(' | ');
    } catch { /* 忽略 */ }
    const code = e && e.code ? String(e.code) : 'rpc';
    let text;
    if (code === 'mcp-timeout') {
      text = 'Concat 在 ' + Math.round((timeoutMs || CALL_TIMEOUT_MS) / 1000) + ' 秒内没回应 [' + tool + ']。';
    } else {
      text = '与 Concat 的通信出错（协议层，不是工具报错）[' + tool + ']：' + msgOf(e) + '（code=' + code + '）';
    }
    if (tail) text += '（Concat 最后的输出：' + tail + '）';
    return { ok: false, data: null, error: text };
  }
}

/**
 * **所有对外能力的唯一入口**：排队 → 确保会话 → 执行 → 自动重置空闲计时。
 *
 * 任何一步失败都收敛成 `{ok:false, error}`，**绝不抛**。
 *
 * @template T
 * @param {(s:Session) => Promise<T>} task
 * @returns {Promise<T|{ok:false, error:string}>}
 */
function withSession(task) {
  return enqueue(async () => {
    try {
      const got = await ensureSession();
      if (!got.ok || !got.session) {
        lastError = got.error || '会话不可用';
        return { ok: false, error: lastError };
      }
      touch();
      return await task(got.session);
    } catch (e) {
      const text = msgOf(e);
      lastError = text;
      return { ok: false, error: '视频精剪执行时出现未预料的问题：' + text };
    }
  });
}

/**
 * 关掉会话。**幂等**，可以在 `app.on('before-quit')` 里直接调（不必 await）。
 *
 * 两种关法，区别只在"要不要优雅"：
 *   · 默认（空闲超时 / 用户手动关工程）：先 `project_save` 再优雅 close。
 *     虽然每个写操作都自动存过盘（见 autosave），这里再存一次的成本是一次本地 JSON 写，
 *     换的是"任何一条漏了自动存盘的代码路径都不会吃掉用户的手工活"。
 *   · `force:true`（应用退出）：**不保存、直接 SIGKILL**。
 *     退出时主进程马上就没了，等 3s 优雅关闭只会让用户看到窗口卡一下；
 *     而自动存盘已经把该写的都写了，强杀不会丢东西。
 *
 * @param {{force?:boolean, reason?:string}=} opts
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function closeSession(opts) {
  const o = opts || {};
  return enqueue(async () => {
    const s = session;
    clearIdle();
    session = null;
    if (!s) return { ok: true };
    try {
      if (o.force === true) {
        // Windows 上 process.kill 映射到 TerminateProcess，足够 terminates 子进程。
        const pid = s.client.pid;
        if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ }
        }
        try { await s.client.close(); } catch { /* 兜底，忽略 */ }
        return { ok: true };
      }
      if (openPath) {
        // 尽力保存；失败不影响"关掉"这个结果（会话还是要关的）。
        await rawCall(s, 'project_save', { path: openPath }, CALL_TIMEOUT_MS);
      }
      await s.client.close();
      return { ok: true };
    } catch (e) {
      lastError = '关闭 Concat 会话时出错：' + msgOf(e);
      return { ok: false, error: lastError };
    }
  });
}

// ── 快照规范化 ────────────────────────────────────────────────────────────

/**
 * 单个 clip 规范化。域外字段一律不带出去（前端拿到的是**稳定契约**，
 * 不是 Concat 的当前内部形状 —— 否则它升级一次小版本就可能让 UI 崩）。
 *
 * 只保留"UI 真的会画"的字段；`undefined` 的字段不写进对象
 * （前端可以用 `'speed' in clip` 判断"这一项要不要显示"）。
 *
 * @param {object} c
 * @returns {object}
 */
function normalizeClip(c) {
  const src = c && typeof c === 'object' ? c : {};
  /** @type {Record<string, *>} */
  const out = {
    id: String(src.id || ''),
    kind: String(src.kind || ''),
    track: String(src.track || ''),
    start: Number(src.start) || 0,
    end: Number(src.end) || 0,
    duration: Number(src.duration) || 0,
    sourceStart: Number(src.sourceStart) || 0,
  };
  if (typeof src.media === 'string' && src.media) out.media = src.media;
  // ⚠️ `muted` 是**布尔**，不是数值，所以它进不了下面那个 numeric 白名单 ——
  //    这正是它曾经被整条丢掉的现场原因（症状见下）。必须显式透传。
  //    为什么它重要到要单独写一行注释：
  //      ① 右栏「静音」勾选框绑的就是 `clip.muted`，字段一丢，勾选框永远是「没勾」，
  //         用户勾了静音、再读一次快照，界面又变回"有声音"；
  //      ② 「分离音频」之后 Concat 会给源视频置 `muted:true`（`clip_update.muted`
  //         的 schema 原话："A detach sets this on the video it took the sound from"），
  //         前端靠它判断"这段已经分离过、别再点一次"。字段丢了就会重复分离出两条音频。
  if (typeof src.muted === 'boolean') out.muted = src.muted;
  // `name` 的处理见下（不同 kind 上含义不同）。
  // ⚠️ `name` 在不同 kind 上含义不同：画面/声音片段上是**素材名**（实测 "src.mp4"），
  //    文字片段上可能是文字内容。所以只在"不是文字"时才把它当素材名带出去，
  //    否则前端会把一整段字幕文本画成片段的文件名。
  if (typeof src.name === 'string' && src.name && out.kind !== 'text') out.mediaName = src.name;
  if (typeof src.text === 'string') out.text = src.text;
  // 数值型可选字段：只有 Concat 真的报了这个键才带出去。
  const numeric = ['offsetY', 'volume', 'opacity', 'fadeIn', 'fadeOut', 'scale', 'offsetX', 'rotation', 'speed'];
  for (const k of numeric) {
    if (src[k] !== undefined && src[k] !== null && Number.isFinite(Number(src[k]))) {
      out[k] = Number(src[k]);
    }
  }
  // 关键帧：Concat 给的是"有哪几个属性被打了帧"的字符串数组。
  if (Array.isArray(src.keyframed) && src.keyframed.length) out.keyframed = src.keyframed.slice();
  return out;
}

/**
 * 把一个 clip 挂到它的素材名上。
 *
 * 为什么单独一步：`timeline_read` 的 clip 里 `name` 是**素材名**（实测 "src.mp4"），
 * 但同一个字段在文字片段上放的是文字内容。两者含义不同却同名 ——
 * 前端若直接把它当"显示名"用，文字片段会显示成一整段字幕文本。
 * ⇒ 这里按 kind 分流：video/image/audio 的 name 进 `mediaName`，text 的进 `text`。
 *
 * @param {object} clip 已 normalize 的 clip
 * @param {Map<string, string>} mediaNameById
 * @returns {object}
 */
function attachMediaName(clip, mediaNameById) {
  if (clip.media && mediaNameById.has(clip.media) && !clip.mediaName) {
    clip.mediaName = mediaNameById.get(clip.media);
  }
  return clip;
}

/**
 * 把 `timeline_read` / 写操作自带的原始快照，规范化成前端直接能用的结构。
 *
 * 规范化的两个理由（写在这里，是为了让后来人不要"顺手简化掉"）：
 *   ① **clips 是扁平的**（事实⑥）。原样给前端等于把"按 `clip.track` 分组"这件事
 *      甩给每一个调用点；只要有一处忘了分组，那个片段就会画到错误的轨道上。
 *      这里把归属信息（`track`）与轨道清单（含 `index`）一并给全，前端分组只需一行。
 *   ② **tracks 的数组顺序不可信**（事实⑤）。`track_add` 新建的轨会追加到数组末尾，
 *      而它的 `index` 是当前最大值 —— 也就是说"数组顺序"和"层叠顺序"目前恰好同向，
 *      但这是巧合，不是契约。把 `index` 显式给出去，前端按 index 排序画，
 *      将来 Concat 改了数组顺序也不会出现"图层突然上下颠倒"。
 *
 * @param {object|null} raw
 * @returns {object}
 */
function normalizeSnapshot(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const p = d.project && typeof d.project === 'object' ? d.project : {};
  const t = d.timeline && typeof d.timeline === 'object' ? d.timeline : {};

  const mediaList = Array.isArray(d.media) ? d.media : [];
  const mediaNameById = new Map();
  for (const m of mediaList) {
    if (m && typeof m.id === 'string') mediaNameById.set(m.id, String(m.name || ''));
  }

  const tracks = (Array.isArray(t.tracks) ? t.tracks : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ id: String(x.id || ''), index: Number(x.index) || 0 }))
    // 按 index 升序：index 越大越在上层（事实⑤），前端渲染层叠时从前往后画即可。
    .sort((a, b) => a.index - b.index);

  const clips = (Array.isArray(t.clips) ? t.clips : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => attachMediaName(normalizeClip(x), mediaNameById))
    // 时间顺序：Concat 目前已经排过，这里再兜一次（不同版本顺序不同是有可能的，
    // 而"时间轴渲染依赖时间顺序"这件事不能靠上游心情）。
    .sort((a, b) => a.start - b.start);

  const media = mediaList
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const p = String(m.path || '');
      const key = p.toLowerCase();
      // 真相只从 audioCache 来（见 warmAudioCache 的注释）。
      // 缓存里没有 ⇒ `hasAudioKnown:false`，前端据此显示"未知"而不是"无声"。
      const known = audioCache.has(key);
      return {
        id: String(m.id || ''),
        name: String(m.name || ''),
        path: p,
        kind: String(m.kind || ''),
        duration: Number(m.duration) || 0,
        width: Number(m.width) || 0,
        height: Number(m.height) || 0,
        // 兼容既有调用方：字段仍然是布尔（`if (m.hasAudio)` 照旧可用），
        // 但配一个 `hasAudioKnown` 让"未知"可被区分。
        hasAudio: known ? audioCache.get(key) : false,
        hasAudioKnown: known,
      };
    });

  return {
    project: {
      name: String(p.name || ''),
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      fps: Number(p.fps) || 0,
    },
    timeline: {
      id: String(t.id || ''),
      name: String(t.name || ''),
      duration: Number(t.duration) || 0,
      tracks,
      clips,
    },
    media,
    canUndo: d.canUndo === true,
    canRedo: d.canRedo === true,
  };
}

/**
 * 读一次快照（走队列）。
 *
 * 工程元信息的两级来源：优先 `timeline_read` 自带的 `project` 块；**它是空的就补一次
 * `project_get`**。为什么需要这一级：`timeline_read` 的 `project` 块在**空工程**
 * （刚 create 完还没有任何片段）时实测是完整的，但在"工程文件被外部工具改过"
 * 或"打开了一个只有 concat.json 骨架的目录"时可能只回 `{name}`。
 * 那时前端会拿到 `width:0 height:0` 去算画布比例 —— 画面直接变形，
 * 而"变形"这个症状看起来像 CSS bug，查半天不会想到是主进程少了一个字段。
 *
 * @returns {Promise<object>} 失败时 `{ok:false, error}`；成功时 `{ok:true, ...snapshot}`
 */
function snapshot() {
  return withSession(async (s) => {
    if (!openPath) {
      return { ok: false, error: '还没有打开工程。请先新建或打开一个视频工程。', empty: true };
    }
    const r = await rawCall(s, 'timeline_read', { path: openPath }, CALL_TIMEOUT_MS);
    if (!r.ok) return { ok: false, error: r.error };
    const snap = normalizeSnapshot(r.data);
    // 只有"元信息不全"才多花一次往返（正常路径零成本，见上）。
    if (!snap.project.width || !snap.project.height || !snap.project.fps) {
      const pg = await rawCall(s, 'project_get', { path: openPath }, CALL_TIMEOUT_MS);
      if (pg.ok) {
        const fix = normalizeSnapshot({ project: projectBlockOf(pg.data) }).project;
        if (fix.width) snap.project.width = fix.width;
        if (fix.height) snap.project.height = fix.height;
        if (fix.fps) snap.project.fps = fix.fps;
        if (!snap.project.name && fix.name) snap.project.name = fix.name;
      }
    }
    return Object.assign({ ok: true }, snap);
  });
}

/**
 * 把 `project_get` 的返回整理成 `normalizeSnapshot` 认识的 `project` 块。
 *
 * ⚠️ `project_get` 的返回**不是** `timeline_read` 那种 `{project:{...}}` 包装：
 *    实测它是**扁平的工程文档**（`{concat, name, video:{width,height,rateNum,rateDen}, ...}`），
 *    尺寸在 `video` 子对象里、帧率是 `rateNum/rateDen` 两个整数。
 *    直接把它当 `{project: data}` 传进去会得到全零（因为 `data.width` 不存在）——
 *    那正好是"看起来跑通了但什么都没修好"，所以这里显式换算，不猜。
 *
 * @param {object|null} data
 * @returns {{name:string, width:number, height:number, fps:number}}
 */
function projectBlockOf(data) {
  const d = data && typeof data === 'object' ? data : {};
  const v = d.video && typeof d.video === 'object' ? d.video : {};
  const width = Number(v.width) || Number(d.width) || 0;
  const height = Number(v.height) || Number(d.height) || 0;
  const rateNum = Number(v.rateNum) || Number(d.rateNum) || 0;
  const rateDen = Number(v.rateDen) || Number(d.rateDen) || 0;
  // rateDen 为 0 时不能除（会得 Infinity）。此时如实回 0，让调用方走"未知"分支。
  const fps = rateNum > 0 && rateDen > 0 ? rateNum / rateDen : 0;
  return {
    name: typeof d.name === 'string' ? d.name : '',
    width,
    height,
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0,
  };
}

/**
 * 写操作后**顺手存盘**（事实②）。
 *
 * 为什么每个写操作都存：用户的预期是"剪映那样，改了就存"，而不是
 * "没点保存就白干了"。而本模块有一条"空闲 5 分钟自动关会话"的策略 ——
 * 若只在用户显式点保存时写盘，那次自动关闭就等于静默丢掉 5 分钟的剪辑
 * （实测：不 `project_save` 就 close，`concat.json` 里连 clips 都没有）。
 *
 * 失败**不算整体失败**：本次编辑本身是成功的（Concat 内存里已经改了），
 * 存盘失败只影响"关掉之后还在不在"。所以附 `autosaveError` 让上层能提示，但 `ok` 仍为 true。
 *
 * @param {Session} s
 * @returns {Promise<string>} 空串 = 成功，否则是错误文本
 */
async function autosave(s) {
  if (!openPath) return '';
  const r = await rawCall(s, 'project_save', { path: openPath }, CALL_TIMEOUT_MS);
  return r.ok ? '' : (r.error || '自动保存失败');
}

/**
 * 写操作的统一收尾：自动存盘 + 产出 `{ok:true, createdId?, ...snapshot}`。
 *
 * 快照的来源见文件头事实③：**优先用工具响应自带的**（它本来就有全套
 * `canUndo/canRedo/media/project/timeline`），只有响应里没有 `timeline` 时
 * 才补一次 `timeline_read`。这样拖拽热路径上每个编辑是 2 次 MCP 往返
 * （改动 + 存盘），而不是 3 次。
 *
 * @param {Session} s
 * @param {{ok:boolean, data:object|null, error?:string}=} res 写操作本身的返回
 * @returns {Promise<object>}
 */
async function finishWrite(s, res) {
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || '操作失败' };
  }
  const data = res.data && typeof res.data === 'object' ? res.data : {};
  const autosaveError = await autosave(s);

  let snap = null;
  if (data.timeline && typeof data.timeline === 'object') {
    snap = normalizeSnapshot(data);
  } else {
    const tl = await rawCall(s, 'timeline_read', { path: openPath }, CALL_TIMEOUT_MS);
    if (tl.ok) snap = normalizeSnapshot(tl.data);
  }

  /** @type {Record<string, *>} */
  const out = { ok: true };
  if (typeof data.createdId === 'string' && data.createdId) out.createdId = data.createdId;
  if (autosaveError) out.autosaveError = autosaveError;
  if (snap) Object.assign(out, snap);
  return out;
}

// ── 编辑操作表 ────────────────────────────────────────────────────────────

/**
 * `concat:edit` 的 op → Concat 工具 + 入参白名单。
 *
 * 为什么用**显式白名单**（`build` 一个个字段抄）而不是 `Object.assign({path}, args)`：
 *   ① 渲染层若能塞 `path`，就等于能操作**任意**工程（包括用户没在页面里打开的那个）——
 *      编辑器的所有操作必须锁死在 `openPath` 上，这是权限边界，不是代码洁癖；
 *   ② Concat 对未知字段的态度没有保证（可能报 invalid，也可能忽略），
 *      而"忽略"会让前端以为自己传参成功了，排查时看到的是一个静默无效的调用；
 *   ③ 每个字段的类型与单位都写在 `build` 里，等于把 schema 抄进了代码，
 *      Concat 改签名时这里会立刻表现为"参数不对"，而不是"功能慢慢怪掉"。
 *
 * @type {Record<string, {tool:string, require?:string[], build:function(object):object,
 *   timeoutMs?:number, requireCreated?:string}>}
 *
 * 段末那一个 `requireCreated` 是「**静默 no-op 探测器**」：有些 Concat 命令在
 * "这件事本来就不成立"时会**成功返回但什么都不做**（实测 `detachAudio` 打在
 * 无声视频 / 图片 / 标题片段上就是这样：`isError:false`、无 `createdId`、
 * clips 数量不变）。给这个字段填一句人话，`edit()` 就会在"命令说成功但没造出
 * 新对象"时把它翻成 `{ok:false, error:<那句话>}` —— 否则用户点三次都没反应，
 * 而界面上一次错误提示都没有（本仓最忌讳的那种静默）。
 */
const EDIT_OPS = {
  // 加一条轨。`bottom:true` 插到最底层（Concat 的语义），默认加到最上层。
  addTrack: {
    tool: 'track_add',
    build: (a) => ({ bottom: a.bottom === true }),
  },
  // 把素材库里的一个素材放到指定轨的指定时间。
  clipAdd: {
    tool: 'clip_add',
    require: ['mediaId', 'start'],
    build: (a) => ({
      mediaId: String(a.mediaId),
      trackId: a.trackId ? String(a.trackId) : '',
      start: Number(a.start) || 0,
      ripple: a.ripple === true,
    }),
  },
  // 一次把多个素材按顺序首尾相接铺上去（"全选素材 → 一键排成一条"）。
  clipsAddSequence: {
    tool: 'clips_add_sequence',
    require: ['mediaIds', 'start'],
    build: (a) => ({
      mediaIds: Array.isArray(a.mediaIds) ? a.mediaIds.map(String) : [],
      start: Number(a.start) || 0,
      trackId: a.trackId ? String(a.trackId) : null,
      ripple: a.ripple === true,
    }),
  },
  // 拖片段两端改长度。delta 为正=变长，为负=变短（Concat 的语义就是增量，不是目标值）。
  clipTrim: {
    tool: 'clip_trim',
    require: ['clipId', 'delta', 'edge'],
    build: (a) => ({
      clipId: String(a.clipId),
      delta: Number(a.delta) || 0,
      edge: a.edge === 'start' ? 'start' : 'end',
      ripple: a.ripple === true,
    }),
  },
  // 在时间点切开若干片段（"剪刀"工具）。
  clipsSplit: {
    tool: 'clips_split',
    require: ['clipIds', 'time'],
    build: (a) => ({
      clipIds: Array.isArray(a.clipIds) ? a.clipIds.map(String) : [],
      time: Number(a.time) || 0,
    }),
  },
  // 拖拽移动：一次可传多条，每条形如 {clipId, start, trackId}。
  clipsMove: {
    tool: 'clips_move',
    require: ['moves'],
    build: (a) => ({
      moves: (Array.isArray(a.moves) ? a.moves : [])
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({
          clipId: String(m.clipId || ''),
          start: Number(m.start) || 0,
          trackId: String(m.trackId || ''),
        })),
    }),
  },
  // 删除片段。
  clipsRemove: {
    tool: 'clips_remove',
    require: ['clipIds'],
    build: (a) => ({
      clipIds: Array.isArray(a.clipIds) ? a.clipIds.map(String) : [],
      ripple: a.ripple === true,
    }),
  },
  // 通用字段补丁（不透明度/音量/转场/滤镜等）。patch 原样透传 —— 它的键集合由
  // Concat 的文档定义且会随版本增长，这里白名单化等于每次升级都要改一次代码。
  // ⚠️ 但 `patch` 是**副本**，且拒绝 `id` / `trackId` 这类身份字段 ——
  //    改身份应该走 clipsMove，混进 patch 会让"这个片段去哪了"变得不可推理。
  clipUpdate: {
    tool: 'clip_update',
    require: ['clipId', 'patch'],
    build: (a) => {
      const src = a.patch && typeof a.patch === 'object' ? a.patch : {};
      /** @type {Record<string, *>} */
      const patch = {};
      for (const k of Object.keys(src)) {
        if (k === 'id' || k === 'trackId' || k === 'path') continue;
        patch[k] = src[k];
      }
      return { clipId: String(a.clipId), patch };
    },
  },
  // 画中画几何：缩放/位移/旋转/拉伸。
  clipTransform: {
    tool: 'clip_transform',
    require: ['clipId'],
    build: (a) => {
      /** @type {Record<string, *>} */
      const out = { clipId: String(a.clipId) };
      for (const k of ['scale', 'offsetX', 'offsetY', 'rotation', 'stretchX', 'stretchY']) {
        if (a[k] !== undefined && a[k] !== null && Number.isFinite(Number(a[k]))) out[k] = Number(a[k]);
      }
      return out;
    },
  },
  // 变速。speed 是倍率（2 = 两倍速）。
  clipSpeed: {
    tool: 'clip_speed',
    require: ['clipId', 'speed'],
    build: (a) => ({
      clipId: String(a.clipId),
      speed: Number(a.speed) || 1,
      ripple: a.ripple === true,
    }),
  },
  // 打关键帧。at 是**片段内归一化位置** 0..1（不是秒！）。
  keyframeSet: {
    tool: 'keyframe_set',
    require: ['clipId', 'property', 'at', 'value'],
    build: (a) => {
      const out = {
        clipId: String(a.clipId),
        property: String(a.property),
        at: Number(a.at) || 0,
        value: Number(a.value) || 0,
      };
      // ease 是四段贝塞尔 [x1,y1,x2,y2]；不传时用 Concat 的默认线性 [0,0,1,1]。
      if (Array.isArray(a.ease) && a.ease.length === 4) out.ease = a.ease.map(Number);
      return out;
    },
  },
  // 删关键帧。
  keyframeClear: {
    tool: 'keyframe_clear',
    require: ['clipId', 'property', 'at'],
    build: (a) => ({
      clipId: String(a.clipId),
      property: String(a.property),
      at: Number(a.at) || 0,
    }),
  },
  // 加标题。start 是时间线上的秒数；**text 是用户输入的原文，必填**。
  //
  // 【为什么 `text` 是必填，而不是"不给就用引擎默认"】
  //   本 op 早先只传 `start`（`require:['start']`），于是每次都落成 Concat 的
  //   `TextStyle::default()`：`content:"Your text"` + 纯白无描边。实测（真跑 0.3s 抽帧）
  //   两件事：① 文字永远是英文占位符 "Your text"，用户根本没有地方输入自己的字；
  //   ② 纯白压在浅色画面上**一个暗像素都没有**（darkPx=0）⇒ 看着就是"点了没反应"。
  //   所以：文字必填（空/纯空白由 require 的 trim 判定拦下）+ 默认样式换成
  //   TITLE_DEFAULT_STYLE（白字黑描边）。
  //
  // 【文字参数到底叫什么 —— 探针拉的真实 schema，不是猜的】
  //   `title_add` 的入参只有 7 个：`path / start / duration / style / offsetY /
  //   trackId / above`（required = `["path","start"]`）。文字**不在**顶层，而是
  //   嵌在 `style.content`（string，默认 "Your text"）里。`style` 共 23 个字段，
  //   其余是 fontSize / fontWeight / color / align / background / strokeWidth /
  //   strokeColor / shadow / maxWidth / lineHeight / fontFamily / runs / ...
  //   ⇒ 所以前端传 `text`，这里映射成 `style.content`；传 `style` 时**只允许**
  //     覆盖样式，`content` 一律以 `text` 为准（见 build 里的 `k === 'content'`）。
  titleAdd: {
    tool: 'title_add',
    require: ['start', 'text'],
    build: (a) => {
      const out = { start: Number(a.start) || 0 };
      if (a.duration !== undefined && a.duration !== null) out.duration = Number(a.duration) || 0;
      // 先铺一层可见默认样式，再让调用方覆盖（`content` 除外，它只认 a.text）。
      const style = Object.assign({}, TITLE_DEFAULT_STYLE);
      if (a.style && typeof a.style === 'object') {
        for (const k of Object.keys(a.style)) {
          if (k === 'content') continue;
          style[k] = a.style[k];
        }
      }
      style.content = normalizeTitleText(a.text);
      out.style = style;
      if (a.offsetY !== undefined && a.offsetY !== null) out.offsetY = Number(a.offsetY);
      if (a.trackId) out.trackId = String(a.trackId);
      if (a.above === true) out.above = true;
      return out;
    },
  },
  // 批量字幕。每条 {start, end, text}；offsetY 是相对画面高度的比例（默认 0.35）。
  captionsAdd: {
    tool: 'captions_add',
    require: ['captions'],
    build: (a) => ({
      captions: (Array.isArray(a.captions) ? a.captions : [])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          start: Number(c.start) || 0,
          end: Number(c.end) || 0,
          text: String(c.text === undefined || c.text === null ? '' : c.text),
        })),
      ...(a.style && typeof a.style === 'object' ? { style: a.style } : {}),
      ...(a.offsetY !== undefined && a.offsetY !== null ? { offsetY: Number(a.offsetY) } : {}),
    }),
  },
  // 时间线底色。background 是 Concat 的 oneOf 结构（颜色串 / null），原样透传。
  timelineBackground: {
    tool: 'timeline_background',
    require: ['background'],
    build: (a) => ({ background: a.background }),
  },
  // 时间线联动开关（改动一段时后面的片段是否跟着挪）。
  timelineLinkage: {
    tool: 'timeline_linkage',
    require: ['on'],
    build: (a) => ({ on: a.on === true }),
  },
  // ── 自动分离音轨（剪映的「分离音频」）──────────────────────────────────────
  //
  // 【先证伪的过程留在代码里，因为「它不存在」和「它存在但不叫这个名字」是两回事】
  //
  // 探针：真跑 `concat.exe --mcp` 的 `tools/list`（0.2.9，45 个工具），脚本是
  // `scripts/smoke/_probe-concat-tools.mjs`。逐个看过 schema 之后的结论：
  //
  // ① 45 个工具里**没有**任何一个叫 `clip_detach_audio` / `audio_detach` /
  //    `clip_split_audio` / `audio_extract` / `clip_unlink` / `clip_convert`。
  //    全部工具名原样抄在这里（省得下一个人再跑一遍）：
  //      concat_version, project_list, project_create, project_open, project_save,
  //      project_close, timeline_read, project_get, project_set_video, media_probe,
  //      media_import, edit_apply, edit_undo, edit_redo, clip_add,
  //      clips_add_sequence, clip_trim, clips_split, clips_move, clips_remove,
  //      clip_update, clip_mask, clip_stabilize, clip_frame, timeline_background,
  //      timeline_linkage, clip_transform, clip_speed, title_add, title_style_words,
  //      title_clear_word_styles, captions_add, keyframe_set, keyframe_clear,
  //      effect_layer_add, effect_key_set, track_add, effects_list, template_list,
  //      template_instantiate, export_start, export_status, export_wait,
  //      export_cancel, preview_frame
  //
  // ② 「把 clip 的 kind 改成 audio」这条路**走不通**：`clip_update` 的 `patch`
  //    里没有 `kind`（也没有 `trackId`）—— 它只有 muted / volume / audioStream /
  //    filters / fadeIn / fadeOut / opacity / crop / mask / text / name /
  //    blend / background / transitionIn / videoEffects / preservePitch。
  //    其中 `audioStream` 是"播哪一条音轨"，`muted` 是"静不静音"，都不是"拆出去"。
  //
  // ③ 真能力藏在**通用命令通道** `edit_apply` 里。它的 desc 原话是
  //    "Applies any one edit command to an open project, as one undoable step ...
  //     every edit the window can make is one"。它的 `command` 是
  //    `$defs.Command` 的 **54 分支 oneOf**（按 `op` 区分的 tagged union），
  //    其中两支正好是剪映那一对，schema 原文（`description` / `properties` 原样）：
  //      {"op":"detachAudio","clipId":"<video>"}
  //        desc: "Pulls a video clip's sound out into its own audio clip on a free
  //               lane (minting one if none is free), muting the video and moving
  //               its audio filters to the sound."
  //        properties: { op: {const:"detachAudio"}, clipId: {type:"string", description:"The video clip to detach from."} }
  //        required: ["op","clipId"]
  //      {"op":"reattachAudio","clipId":"<video 或它的音频片段>"}
  //        desc: "Undoes a detach: deletes the detached sound clip(s), unmutes the
  //               video and hands the sound's filters back."
  //    ⇒ 结论是**有原生能力**。op 名保持剪映语汇（clipDetachAudio），底层映射到
  //      `edit_apply` —— 与 `addTrack→track_add` 同一个模式：EDIT_OPS 面向"用户动作"，
  //      不是"引擎工具名"的镜像。`clip_update.muted` 的 schema 里也印着这句佐证：
  //      "A detach sets this on the video it took the sound from"。
  //
  // 【实测成功的形状】c2(video, T1, 0→2) --detachAudio--> c2 变 muted:true、
  //   新增 c3(kind:"audio", track:"T2", 0→2, media 同一个 m1)，`createdId === "c3"`。
  //
  // 【实测的坑（别删下面那个 requireCreated）】`detachAudio` 打在**没有声音**的
  //   片段上是**静默 no-op**：`isError:false`、返回里没有 `createdId`、clips 数量
  //   不变、muted 也没被置上（真跑过：无声 mp4 和 png 各一次，两次都是这样）。
  //   不查 createdId 的话，前端收到"成功"、时间轴上什么都没变、也没有报错。
  clipDetachAudio: {
    tool: 'edit_apply',
    require: ['clipId'],
    build: (a) => ({ command: { op: 'detachAudio', clipId: String(a.clipId) } }),
    requireCreated: '这段片段里没有可分离的音轨，所以没有生成音频片段'
      + '（无声视频 / 图片 / 标题 / 已经在音频轨上的片段都会是这样）。',
  },
  // 分离的逆操作（剪映的「还原音频」）。
  // ⚠️ 它**不新增**任何 clip（反而删掉一个），所以不能挂 `requireCreated`
  //    —— `createdId` 对它天然为空。判定成功的依据是新快照里视频片段的
  //    `muted` 回到 false 且音频片段减少（`finishWrite` 会把快照一起带回来）。
  clipReattachAudio: {
    tool: 'edit_apply',
    require: ['clipId'],
    build: (a) => ({ command: { op: 'reattachAudio', clipId: String(a.clipId) } }),
  },
};

// ── 对外能力：工程 ────────────────────────────────────────────────────────

/**
 * 探测引擎是否可用。**不污染会话状态**（失败也算一次正常探测结果）。
 *
 * 返回口径固定（前端/探测器都按这个读）：
 *   `{ ok, installed, version, toolCount, mode, path, error? }`
 *
 * @returns {Promise<{ok:boolean, installed:boolean, version:string, toolCount:number, mode:string, path:string, error?:string}>}
 */
function probe() {
  return enqueue(async () => {
    try {
      const got = await ensureSession();
      if (!got.ok || !got.session) {
        const loc = findConcatExecutable();
        return {
          ok: false,
          installed: false,
          version: '',
          toolCount: 0,
          mode: 'mcp-stdio',
          path: loc && loc.path ? String(loc.path) : '',
          error: got.error || 'Concat 会话不可用',
        };
      }
      touch();
      const s = got.session;
      return {
        ok: true,
        installed: true,
        version: s.version,
        toolCount: s.toolCount,
        mode: 'mcp-stdio',
        path: s.path,
      };
    } catch (e) {
      return {
        ok: false,
        installed: false,
        version: '',
        toolCount: 0,
        mode: 'mcp-stdio',
        path: '',
        error: msgForProbe(e),
      };
    }
  });
}

/** @param {*} e @returns {string} */
function msgForProbe(e) {
  return '探测 Concat 时出现未预料的问题：' + msgOf(e);
}

// ── 新建工程的默认落点（工作区根下的子目录）────────────────────────────────

/**
 * 默认工程父目录的段名：`<工作区根>/concat-projects`。
 * 单独一段而不是直接扔在工作区根下：工作区根是**所有任务共用**的一个目录
 *（产物、网页、幻灯片都在里面），工程目录混进去会让人分不清哪些是"剪辑工程"。
 */
const CONCAT_PROJECTS_SEG = 'concat-projects';

/** 新建工程没给名字时的默认名（与前端「新建工程」按钮的语义一致）。 */
const DEFAULT_PROJECT_NAME = '未命名工程';

/**
 * 重名递增的探测上限。
 * 递增本身是为了**不覆盖**已有工程（见 uniqueProjectName），但它的探测
 * （`existsSync`）与随后的 `project_create` 之间没有原子性，理论上可以一路撞；
 * 给个上限的唯一目的是**绝不死循环**，撞满就按原名交出去让 Concat 自己报错。
 */
const MAX_PROJECT_NAME_TRIES = 999;

/**
 * 工作区根解析器（由 `main.js` 启动时注入，见 `setWorkspaceRootResolver`）。
 *
 * ⚠️ **为什么这里不自己解析一遍工作区根**：本仓对「工作区根」有一条纪律 ——
 *   同一个路径**只能有一处表达式**（当前那一处是 `main.js` 的 `workspaceRootDir()`，
 *   产物目录 / 账号配置 / 隔离认领 6 个调用点共用它）。
 *   在这里再抄一份，两份某天漂移（一处认启动时的环境变量、另一处回落到用户主目录），
 *   就会派生出「新建的工程落进 A 目录，而工作区里看到的是 B」，且两边都"成功"了，最难查。
 *   所以本模块只**持有**别人给的解析函数，不产生第二份表达式
 *   （连这行注释里都不写那道表达式本身，免得被"重复表达式"的静态检查当成真代码）。
 *
 * @type {(() => string)|null}
 */
let workspaceRootOf = null;

/**
 * 注入工作区根解析器。由 `main.js` 在启动时调用**一次**。
 *
 * 传的是**函数本身**而不是调用结果：工作区根所依赖的那个环境变量是主进程启动过程中
 * 才设上的（见 main.js 里对它的赋值），值必须在真正要用的那一刻才求，
 * 否则模块加载顺序一变，这里就永久固化成"加载时的那个值"（通常是空的 ⇒ 落到用户主目录）。
 *
 * @param {(() => string)|null|undefined} fn 返回工作区根绝对路径的解析函数
 * @returns {void}
 */
function setWorkspaceRootResolver(fn) {
  workspaceRootOf = typeof fn === 'function' ? fn : null;
}

/**
 * 默认的工程父目录：`<工作区根>/concat-projects`。
 *
 * 返回 `''` 表示拿不到（主进程没注入解析器 / 解析函数抛了 / 解析结果为空）——
 * 纯 node 单测直接 `require` 本模块时就是这种情形，此时由调用方如实报错，
 * **绝不猜一个路径**（猜出来的路径可能正好是用户某个真实目录）。
 *
 * @returns {string} 绝对路径；拿不到 ⇒ ''
 */
function defaultProjectsLocation() {
  if (!workspaceRootOf) return '';
  let root = '';
  try {
    root = String(workspaceRootOf() || '');
  } catch {
    return '';
  }
  if (!root) return '';
  return path.join(root, CONCAT_PROJECTS_SEG);
}

/**
 * 在 `location` 下挑一个**不撞已有目录**的工程名。
 *
 * ★ 为什么必须递增：`project_create` 的语义是「在 `<location>/<name>` 上建（已存在即覆盖）」。
 *   前端「新建工程」固定传 `name:'未命名工程'`，用户连点两次，第二次就会把第一个工程
 *   **原地覆盖** —— 那不是"多了一个工程"，是不可逆的数据丢失。
 *   递增成「未命名工程 2」只是多一个目录，用户看得懂、也能自己删。
 *
 * ★ 显式传进来的名字同样递增：本模块只知道"这个目录已经占用了"，
 *   分不清调用方是想"再建一个同名的"还是"想覆盖"——而这两种意图里，
 *   只有"再建一个"能被递增正确服务，"覆盖"是不可逆的。所以一律让位于不丢数据。
 *
 * @param {string} location 父目录（调用方保证已存在）
 * @param {string} baseName 基础名（已 trim，非空）
 * @returns {string} 可用的工程名（与 `location` 拼起来不撞任何已有目录）
 */
function uniqueProjectName(location, baseName) {
  if (!fs.existsSync(path.join(location, baseName))) return baseName;
  for (let i = 2; i <= MAX_PROJECT_NAME_TRIES; i += 1) {
    const candidate = baseName + ' ' + i;
    if (!fs.existsSync(path.join(location, candidate))) return candidate;
  }
  return baseName;
}

/**
 * 打开工程。有 `path` 就打开既有的，否则在 `location` 下新建 `name`。
 *
 * ⚠️ 两种情形都会**改变 openPath**，也就是说"用户当前在编辑哪个工程"由这一条决定。
 *    切换工程时不主动关掉上一个（Concat 支持同时打开多个），只是从此以后所有
 *    编辑都作用在新工程上 —— 与编辑器"切换项目"的直观一致。
 *
 * ⚠️ **新建分支的两个兜底都必须在主进程做**（不在前端）：
 *    · `location` 缺省 ⇒ 落到 `<工作区根>/concat-projects`（不存在则建出来）；
 *    · `name` 缺省 ⇒ `未命名工程`；`<location>/<name>` 已存在 ⇒ 自动递增成「 2」「 3」…
 *    理由：调用「新建工程」的地方不止前端一个（技能、未来的 Agent 工具都会调），
 *    前端兜底必然漏；这里是**唯一的收敛点**，补一次就全补上了。
 *
 * @param {{path?:string, location?:string, name?:string, video?:object}=} args
 * @returns {Promise<object>}
 */
function openProject(args) {
  const a = args && typeof args === 'object' ? args : {};
  const wantPath = typeof a.path === 'string' ? a.path.trim() : '';
  return withSession(async (s) => {
    if (wantPath) {
      const r = await rawCall(s, 'project_open', { path: wantPath }, CALL_TIMEOUT_MS);
      if (!r.ok) return { ok: false, error: '打不开工程「' + wantPath + '」：' + r.error };
      openPath = wantPath;
      // 打开工程是**一次性事件**：在这里把所有素材的 hasAudio 一次问清
      //（从磁盘打开的工程走不到 importMedia，不在这里填就永远是"未知"）。
      const snap = normalizeSnapshot(r.data);
      await warmAudioCache(s, snap.media.map((m) => m.path));
      // 缓存填好之后重读一次，让返回的快照立刻带上正确的 hasAudio。
      const tl = await rawCall(s, 'timeline_read', { path: wantPath }, CALL_TIMEOUT_MS);
      return Object.assign({ ok: true }, tl.ok ? normalizeSnapshot(tl.data) : snap);
    }

    // ★ 兜底一：`location` 缺省 ⇒ 用工作区根下的 `concat-projects`。
    //   修复前这里要求 location 与 name **都给**，缺一个就 return 一句
    //   「新建工程需要 location（放工程的目录）与 name（工程名）。」——
    //   而前端「新建工程」只传 name（VideoStudio.jsx 的 doNew），
    //   于是用户点「新建」永远只看得到这句报错，功能等于不可用。
    let location = typeof a.location === 'string' ? a.location.trim() : '';
    if (!location) location = defaultProjectsLocation();
    if (!location) {
      return {
        ok: false,
        error: '新建工程需要 location（放工程的目录）：调用方没有给，且主进程没有注入默认工作区根。',
      };
    }
    // 目录不存在就建出来（首次使用默认目录时它**一定**不存在）。
    // 建不出来必须如实报错 —— 静默继续只会让 Concat 抛一个用户读不懂的
    // 「location 不存在」，排障时还得回来猜是哪一层没建。
    try {
      fs.mkdirSync(location, { recursive: true });
    } catch (e) {
      return { ok: false, error: '建不了工程目录：' + location + '（' + msgOf(e) + '）' };
    }
    // ★ 兜底二：`name` 缺省 ⇒ `未命名工程`；重名 ⇒ 递增（不覆盖已有工程）。
    const nameIn = typeof a.name === 'string' ? a.name.trim() : '';
    const name = uniqueProjectName(location, nameIn || DEFAULT_PROJECT_NAME);
    /** @type {Record<string, *>} */
    const call = { location, name };
    if (a.video && typeof a.video === 'object') {
      const v = a.video;
      // 四个数必须同时给：Concat 的 schema 里 width/height/rateNum/rateDen 是必需的。
      // 只给宽高会让它回落默认值，而"我设了 1080p 它却出 720p"是最难解释的一类 bug。
      const vid = {
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
        rateNum: Number(v.rateNum) || 0,
        rateDen: Number(v.rateDen) || 1,
      };
      if (vid.width > 0 && vid.height > 0 && vid.rateNum > 0) call.video = vid;
    }
    const r = await rawCall(s, 'project_create', call, CALL_TIMEOUT_MS);
    if (!r.ok) return { ok: false, error: '新建工程失败：' + r.error };
    // project_create 会把工程建在 <location>/<name> 并打开它。
    openPath = path.join(location, name);
    // 新建的工程素材库一定是空的 ⇒ 没有需要 warm 的东西。
    //（这里不留 `warmAudioCache` 的空调用，见本文件对"不要写空壳代码"的一贯口径。）
    const snap = normalizeSnapshot(r.data);
    return Object.assign({ ok: true }, snap);
  });
}

/**
 * 关闭当前工程。
 *
 * `save` 默认 **false**（与 Concat 的 schema 一致）—— 但本模块对每个写操作都自动存过盘，
 * 所以这个默认值不会造成数据丢失，只是"关掉一个已经存过的工程"。
 *
 * @param {{save?:boolean}=} args
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function closeProject(args) {
  const a = args && typeof args === 'object' ? args : {};
  return withSession(async (s) => {
    if (!openPath) return { ok: true };
    const target = openPath;
    const r = await rawCall(s, 'project_close', { path: target, save: a.save === true }, CALL_TIMEOUT_MS);
    // 无论 Concat 怎么说，主进程侧的"当前工程"都必须清掉：
    // 留着它会让下一次 `concat:edit` 打到一个已关闭的工程上，报 notOpen。
    openPath = '';
    if (!r.ok) return { ok: false, error: '关闭工程失败：' + r.error };
    return { ok: true };
  });
}

// ── 对外能力：素材 ────────────────────────────────────────────────────────

/**
 * 导入素材（可多个）。返回新素材 id 列表 + 最新快照。
 *
 * ⚠️ **同一个文件重复导入是 no-op**（Concat 的语义：已在素材库里的路径不再加）。
 *    这时响应里没有 `createdId`，我们就从快照的 media 里按 path 反查 id ——
 *    否则前端会看到"导入了但没返回 id"，接着拿空 id 去加片段，报一个看不懂的错。
 *
 * @param {{files:string[]}=} args
 * @returns {Promise<object>}
 */
function importMedia(args) {
  const a = args && typeof args === 'object' ? args : {};
  const files = Array.isArray(a.files) ? a.files.filter((f) => typeof f === 'string' && f) : [];
  return withSession(async (s) => {
    if (!openPath) {
      return { ok: false, error: '还没有打开工程，无法导入素材。请先新建或打开一个视频工程。' };
    }
    if (!files.length) return { ok: false, error: '没有选择任何素材文件。' };

    /** @type {Array<{id:string,name:string,path:string}>} */
    const imported = [];
    /** @type {string[]} */
    const errors = [];
    /** @type {object|null} */
    let lastSnap = null;

    for (const file of files) {
      const r = await rawCall(s, 'media_import', { path: openPath, file }, CALL_TIMEOUT_MS);
      if (!r.ok) {
        errors.push(path.basename(file) + '：' + r.error);
        continue;
      }
      const data = r.data && typeof r.data === 'object' ? r.data : {};
      lastSnap = normalizeSnapshot(data);
      let id = typeof data.createdId === 'string' ? data.createdId : '';
      let name = path.basename(file);
      if (!id && lastSnap) {
        // 已经导入过：按路径反查（Concat 回报的 path 是绝对路径，大小写不敏感比较）。
        const hit = lastSnap.media.find((m) => String(m.path || '').toLowerCase() === file.toLowerCase());
        if (hit) { id = hit.id; name = hit.name || name; }
      }
      if (id) imported.push({ id, name, path: file });
      else errors.push(path.basename(file) + '：Concat 没返回素材 id');
    }

    const savedError = await autosave(s);
    // 导入是**一次性事件**，正好在这里把 hasAudio 的真相取回来
    //（`timeline_read` 不报这个字段，理由见 warmAudioCache 的注释）。
    // 放在 autosave 之后：先保证"编辑已落盘"，再花时间做探测 —— 顺序反了的话
    // 一次探测失败会让本该成功的导入看起来慢了。
    if (imported.length) await warmAudioCache(s, imported.map((x) => x.path));
    // ⚠️ 必须**重新读一次**快照：上面 warmAudioCache 填的是缓存，而 lastSnap 是
    //   在探测**之前**算好的（那时缓存还是空的 ⇒ hasAudio 全是 false）。
    //   直接把它返回给前端，用户看到的还会是"导入成功但没声音"。
    const tl = await rawCall(s, 'timeline_read', { path: openPath }, CALL_TIMEOUT_MS);
    if (tl.ok) lastSnap = normalizeSnapshot(tl.data);

    /** @type {Record<string, *>} */
    const out = { ok: imported.length > 0, imported };
    if (errors.length) out.error = errors.join('；');
    if (savedError) out.autosaveError = savedError;
    if (lastSnap) Object.assign(out, lastSnap);
    return out;
  });
}

/**
 * 探测一个素材文件（不解码、不导入）。用于"拖进来先看它多大、有没有声音"。
 *
 * @param {{file:string}=} args
 * @returns {Promise<object>}
 */
function probeMedia(args) {
  const a = args && typeof args === 'object' ? args : {};
  const file = typeof a.file === 'string' ? a.file.trim() : '';
  if (!file) return Promise.resolve({ ok: false, error: '缺少 file（素材绝对路径）。' });
  return withSession(async (s) => {
    const r = await rawCall(s, 'media_probe', { path: file }, CALL_TIMEOUT_MS);
    if (!r.ok) return { ok: false, error: r.error };
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    const hasAudio = hasAudioOf(d);
    // probe 成功就顺手填缓存：调用方拿了结果之后前端的素材卡片也该立刻正确，
    // 不必等下一次 import/open 才把真相写进去。
    audioCache.set(file.toLowerCase(), hasAudio);
    return {
      ok: true,
      kind: String(d.kind || ''),
      duration: Number(d.duration) || 0,
      width: Number(d.video && d.video.width) || Number(d.width) || 0,
      height: Number(d.video && d.video.height) || Number(d.height) || 0,
      hasAudio,
      // 顺带把编码细节带上：前端"这个文件能不能直接用"（比如 hevc 某些机器性能差）
      // 迟早会需要它，而 media_probe 已经付过这次解析成本了，白扔可惜。
      videoCodec: String((d.video && d.video.codec) || ''),
      audioCodec: String((d.audio && d.audio.codec) || ''),
    };
  });
}

// ── 对外能力：编辑 ────────────────────────────────────────────────────────

/**
 * 执行一次编辑。**前端只用这一个入口做所有改动**（不开 20 条 IPC 通道）。
 *
 * @param {{op:string, args?:object}=} payload
 * @returns {Promise<object>} `{ok:true, createdId?, ...snapshot}` 或 `{ok:false, error}`
 */
function edit(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const op = typeof p.op === 'string' ? p.op : '';
  const rawArgs = p.args && typeof p.args === 'object' ? p.args : {};

  const spec = EDIT_OPS[op];
  if (!spec) {
    // 未知 op **必须报错**。静默成功会让前端在拼错 op 时"点了没反应但界面以为改好了"，
    // 而时间轴其实是旧的 —— 用户会以为是自己拖错了。
    return Promise.resolve({ ok: false, error: '未知的编辑操作：' + (op || '(空)') });
  }

  for (const need of spec.require || []) {
    const v = rawArgs[need];
    const missing = v === undefined || v === null
      || (Array.isArray(v) && v.length === 0)
      // 字符串按"去掉首尾空白之后还有没有东西"算：
      // `titleAdd` 的 `text` 传 '   ' 与传 '' 是同一件事（Concat 收到空 content
      // 会建出一个 `text:''` 的不可见片段，而且是"成功"的），所以这里一并拦掉。
      || (typeof v === 'string' && v.trim() === '')
      || v === '';
    if (missing) {
      return Promise.resolve({ ok: false, error: '操作「' + op + '」缺少参数 ' + need + '。' });
    }
  }

  return withSession(async (s) => {
    if (!openPath) {
      return { ok: false, error: '还没有打开工程，无法编辑。请先新建或打开一个视频工程。' };
    }

    /** @type {Record<string, *>} */
    const built = spec.build(rawArgs);
    // path 永远由主进程注入，绝不用前端传的（见 EDIT_OPS 头部的权限边界说明）。
    built.path = openPath;

    // timeline_background / timeline_linkage 需要 timelineId。前端多半不知道这个 id
    //（它得先读快照才能拿到），而"少一个参数就报少一个参数"是很差的开发体验。
    // ⇒ 缺了就从当前快照补一次，这是本模块唯一一处"替前端查 id"的地方。
    if (spec.tool === 'timeline_background' || spec.tool === 'timeline_linkage') {
      if (!built.timelineId) {
        const tl = await rawCall(s, 'timeline_read', { path: openPath }, CALL_TIMEOUT_MS);
        const d = tl.ok ? (tl.data || {}) : {};
        const tid = d && d.timeline && d.timeline.id ? String(d.timeline.id) : '';
        if (!tid) return { ok: false, error: '读不到时间线 id，无法设置' + (spec.tool === 'timeline_background' ? '底图' : '联动') + '。' };
        built.timelineId = tid;
      }
    }

    // clip_add 的 trackId 缺省：用快照里 index 最小的那条轨（也就是最底层）。
    // 理由：用户"把素材拖进时间轴"时的直觉是"放到当前轨道上"，而新工程只有默认轨道，
    // 不给默认值会让每一次"拖第一个素材"都失败一次。
    if (spec.tool === 'clip_add' && !built.trackId) {
      const tl = await rawCall(s, 'timeline_read', { path: openPath }, CALL_TIMEOUT_MS);
      const snap = tl.ok ? normalizeSnapshot(tl.data) : null;
      const first = snap && snap.timeline.tracks.length ? snap.timeline.tracks[0].id : '';
      if (!first) return { ok: false, error: '这个工程里一条轨道都没有，请先加一条轨道。' };
      built.trackId = first;
    }

    const res = await rawCall(s, spec.tool, built, spec.timeoutMs || CALL_TIMEOUT_MS);

    // 「命令说成功但什么都没做」的拦截（见 EDIT_OPS 头部 `requireCreated` 的说明）。
    // 只对声明了它的 op 生效 —— 其余 op（clipsMove / clipTrim / clipUpdate …）
    // 本来就不该造出新对象，拿 createdId 当成功判据会把它们全判成失败。
    if (spec.requireCreated && res.ok) {
      const made = res.data && typeof res.data === 'object' ? res.data.createdId : '';
      if (typeof made !== 'string' || !made) {
        // 不 autosave：Concat 侧什么都没改（clips 数量与 muted 都没动，实测过），
        // 存盘只会把"一次没有效果的操作"写进磁盘。
        return { ok: false, error: spec.requireCreated, noCreated: true };
      }
    }

    return finishWrite(s, res);
  });
}

/**
 * 撤销 / 重做。两者返回同形状（都带新快照），区别只有工具名。
 *
 * @param {string} tool 'edit_undo' | 'edit_redo'
 * @returns {Promise<object>}
 */
function historyStep(tool) {
  return withSession(async (s) => {
    if (!openPath) return { ok: false, error: '还没有打开工程。' };
    const res = await rawCall(s, tool, { path: openPath }, CALL_TIMEOUT_MS);
    // ⚠️ 撤销/重做**不自动存盘**：它们改的是"内存里的工程状态"，
    //    立刻存盘会把用户的"我刚才那步撤错了、想再做回来"变成不可恢复的。
    //    存盘仍然会发生（下一次任何写操作、或关会话时），语义上等价于编辑器的"稍后写盘"。
    if (!res.ok) return { ok: false, error: res.error };
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    /** @type {Record<string, *>} */
    const out = { ok: true };
    let snap = null;
    if (data.timeline && typeof data.timeline === 'object') {
      snap = normalizeSnapshot(data);
    } else {
      const tl = await rawCall(s, 'timeline_read', { path: openPath }, CALL_TIMEOUT_MS);
      if (tl.ok) snap = normalizeSnapshot(tl.data);
    }
    if (snap) Object.assign(out, snap);
    return out;
  });
}

/** @returns {Promise<object>} */
function undo() {
  return historyStep('edit_undo');
}

/** @returns {Promise<object>} */
function redo() {
  return historyStep('edit_redo');
}

// ── 对外能力：预览帧 ──────────────────────────────────────────────────────

/**
 * 从 MCP 结果里取出内联图片（事实④：图片在 `content` 数组里，不在 structuredContent）。
 *
 * @param {*} res
 * @returns {{b64:string, mimeType:string}|null}
 */
function pickInlineImage(res) {
  if (!res || typeof res !== 'object') return null;
  const parts = Array.isArray(res.content) ? res.content : [];
  for (const c of parts) {
    if (!c || typeof c !== 'object') continue;
    if (c.type !== 'image') continue;
    if (typeof c.data !== 'string' || !c.data) continue;
    return {
      b64: c.data,
      mimeType: typeof c.mimeType === 'string' && c.mimeType ? c.mimeType : 'image/png',
    };
  }
  return null;
}

/**
 * 抽一帧当预览图，返回**内联 dataURL**（不写盘，前端 `<img src>` 直接用）。
 *
 * ⚠️ 体积控制（见 PREVIEW_INLINE_MAX）：一次 IPC 传 10MB+ 的字符串会让渲染进程
 *    卡在反序列化上（画面白一下，看起来像崩溃）。所以：
 *      ① 首选用调用方给的 width/height（前端传缩略图尺寸，例如 640×360）；
 *      ② 仍然超限就**降一档分辨率重抽**（最多两次），直到进线；
 *      ③ 还超限才落 `os.tmpdir()` 的临时文件，且**不回 dataURL**，
 *         改回 `{ok:true, file, tooLarge:true}`，由上层决定要不要改用 file:// 读。
 *         临时文件 60s 后自动删（PREVIEW_TMP_TTL_MS），不留垃圾。
 *
 * @param {{time:number, width?:number, height?:number}=} args
 * @returns {Promise<{ok:boolean, dataUrl?:string, width?:number, height?:number, file?:string, tooLarge?:boolean, error?:string}>}
 */
function previewFrame(args) {
  const a = args && typeof args === 'object' ? args : {};
  const time = Number(a.time);
  if (!Number.isFinite(time) || time < 0) {
    return Promise.resolve({ ok: false, error: 'time 必须是大于等于 0 的秒数。' });
  }
  let wantW = Number(a.width) > 0 ? Math.round(Number(a.width)) : 0;
  let wantH = Number(a.height) > 0 ? Math.round(Number(a.height)) : 0;

  return withSession(async (s) => {
    if (!openPath) return { ok: false, error: '还没有打开工程，抽不出预览帧。' };

    /** @type {{b64:string, mimeType:string}|null} */
    let img = null;
    let lastW = wantW;
    let lastH = wantH;
    let lastErr = '';

    // 最多三次：原尺寸 → 一半 → 再一半。每次都会重新合成一帧（Concat 端成本不高，
    // 320×240 实测 <100ms），比"传一个 8MB 字符串过去"便宜得多。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      /** @type {Record<string, *>} */
      const call = { path: openPath, time };
      if (lastW > 0) call.width = lastW;
      if (lastH > 0) call.height = lastH;
      const r = await rawCall(s, 'preview_frame', call, PREVIEW_TIMEOUT_MS);
      if (!r.ok) {
        lastErr = r.error;
        return { ok: false, error: '抽帧失败（第 ' + time + ' 秒）：' + r.error };
      }
      const got = pickInlineImage(r.raw);
      if (!got) {
        const d = r.data && typeof r.data === 'object' ? r.data : {};
        // 没有内联图但回报了尺寸：说明这个版本的 Concat 换成了"只写盘"，
        // 那我们就没有 dataURL 可给。如实报错，不伪造。
        return {
          ok: false,
          error: 'Concat 没有返回内联图片（这个版本可能只支持写盘）。' +
            (d.width ? '（回报尺寸 ' + d.width + '×' + d.height + '）' : ''),
        };
      }
      img = got;
      const d = r.data && typeof r.data === 'object' ? r.data : {};
      if (Number(d.width) > 0) lastW = Math.round(Number(d.width));
      if (Number(d.height) > 0) lastH = Math.round(Number(d.height));
      if (img.b64.length <= PREVIEW_INLINE_MAX) break;
      // 超限 → 减半再抽一次。
      if (lastW <= 0 || lastH <= 0) break;
      lastW = Math.max(64, Math.floor(lastW / 2));
      lastH = Math.max(36, Math.floor(lastH / 2));
      img = null;
    }

    if (!img) {
      return { ok: false, error: lastErr || '抽帧没有拿到可用的图片。' };
    }

    if (img.b64.length <= PREVIEW_INLINE_MAX) {
      return {
        ok: true,
        dataUrl: 'data:' + img.mimeType + ';base64,' + img.b64,
        width: lastW,
        height: lastH,
      };
    }

    // 三条路都试过还是超限：落临时文件，不回内联（见本函数头部 ③）。
    try {
      const ext = img.mimeType === 'image/jpeg' ? '.jpg' : '.png';
      const file = path.join(os.tmpdir(), 'douya-concat-preview-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
      fs.writeFileSync(file, Buffer.from(img.b64, 'base64'));
      const t = setTimeout(() => {
        try { fs.unlinkSync(file); } catch { /* 已被删或正被读，忽略 */ }
      }, PREVIEW_TMP_TTL_MS);
      if (typeof t.unref === 'function') t.unref();
      return {
        ok: true,
        dataUrl: '',
        file,
        tooLarge: true,
        width: lastW,
        height: lastH,
        error: '预览图太大（' + Math.round(img.b64.length / 1024) + 'KB base64），已落盘但没有内联返回；请把 width/height 调小一些。',
      };
    } catch (e) {
      return { ok: false, error: '预览图太大且落盘失败：' + msgOf(e) };
    }
  });
}

// ── 对外能力：导出 ────────────────────────────────────────────────────────

/**
 * 开始导出。
 *
 * Concat 的导出是**异步任务**：`export_start` 立刻返回 `{job}`，进度靠
 * `export_status` 轮询（或 `export_wait` 阻塞等）。前端用轮询，因为一次 IPC
 * 阻塞几分钟会让"取消导出"按钮都点不动。
 *
 * @param {{output:string, crf?:number, preset?:string, codec?:string, width?:number, height?:number}=} args
 * @returns {Promise<{ok:boolean, job?:string, output?:string, error?:string}>}
 */
function exportStart(args) {
  const a = args && typeof args === 'object' ? args : {};
  const output = typeof a.output === 'string' ? a.output.trim() : '';
  if (!output) return Promise.resolve({ ok: false, error: '请先选择导出位置（.mp4 文件）。' });

  return withSession(async (s) => {
    if (!openPath) return { ok: false, error: '还没有打开工程，无法导出。' };

    /** @type {Record<string, *>} */
    const call = { path: openPath, output };
    if (a.crf !== undefined && a.crf !== null && Number.isFinite(Number(a.crf))) call.crf = Math.round(Number(a.crf));
    if (typeof a.preset === 'string' && a.preset) call.preset = a.preset;
    if (typeof a.codec === 'string' && a.codec) call.codec = a.codec;
    if (Number(a.width) > 0) call.width = Math.round(Number(a.width));
    if (Number(a.height) > 0) call.height = Math.round(Number(a.height));

    // 导出前存一次盘：导出读的是**磁盘上的工程**（实测：不存盘时 exported 的片子
    // 与内存里的编辑不一致）。这一条比"每个写操作都存盘"更关键 ——
    // 它是"导出结果对不对"的直接原因。
    await autosave(s);

    const r = await rawCall(s, 'export_start', call, CALL_TIMEOUT_MS);
    if (!r.ok) return { ok: false, error: '导出没能开始：' + r.error };
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    const job = typeof d.job === 'string' ? d.job : '';
    if (!job) return { ok: false, error: 'Concat 没有返回任务号，导出状态将无法跟踪。' };
    return { ok: true, job, output: typeof d.output === 'string' ? d.output : output };
  });
}

/**
 * 查导出进度。**原样透传** Concat 的字段，并额外补一组归一化别名。
 *
 * 两种等法，由调用方选（都在这一条通道上，不另开一条）：
 *   · 默认 —— 查一次就回（前端 `setInterval` 轮询）。**交互式界面的正确选择**：
 *     一次 IPC 阻塞几分钟会让"取消导出"按钮都点不动（渲染层那个 Promise 还没 settle）。
 *   · 传了 `waitMs` / `waitSeconds` —— 走 Concat 的 `export_wait` **阻塞等到结束**
 *     （最长 600s，这是 Concat 自己的上限）。适合脚本化/无 UI 的场景，
 *     或"导出很短、只想 await 一个结果"的调用方。
 *
 * ⚠️ 字段名的实测差异（任务书里写的是 framesDone/framesTotal，实际是 frame/total）：
 *    实测 `export_status` 返回 `{fraction, frame, total, state, job, output, path}`，
 *    完成时追加 `{stage, width, height}`。所以这里**两套都给**：
 *    原字段（`frame`/`total`）保证不会因为 Concat 升级而变化，
 *    归一化别名（`framesDone`/`framesTotal`/`file`）让前端只认一套名字。
 *
 * @param {{job:string, waitMs?:number, waitSeconds?:number}=} args
 * @returns {Promise<object>}
 */
function exportStatus(args) {
  const a = args && typeof args === 'object' ? args : {};
  const job = typeof a.job === 'string' ? a.job.trim() : '';
  if (!job) return Promise.resolve({ ok: false, error: '缺少 job（导出任务号）。' });

  // 阻塞等待的时长：优先 waitSeconds（Concat 的原生单位，上限 600），
  // 其次 waitMs（前端更方便），都没有就是纯查询。
  let waitSeconds = 0;
  if (Number.isFinite(Number(a.waitSeconds)) && Number(a.waitSeconds) > 0) {
    waitSeconds = Math.min(600, Math.round(Number(a.waitSeconds)));
  } else if (Number.isFinite(Number(a.waitMs)) && Number(a.waitMs) > 0) {
    waitSeconds = Math.min(600, Math.max(1, Math.round(Number(a.waitMs) / 1000)));
  }

  return withSession(async (s) => {
    let data = null;
    if (waitSeconds > 0) {
      // export_wait 自己就是"等到结束或超时才回"，所以它需要的超时必须**大于**它自己
      // 的等待上限，否则我们会在 Concat 还在等的时候就先判它超时（那会得到一个
      // "任务明明在跑却说通信超时"的假故障）。
      const r = await rawCall(
        s, 'export_wait',
        { job, timeoutSeconds: waitSeconds },
        waitSeconds * 1000 + 30000,
      );
      if (!r.ok) return { ok: false, error: r.error };
      data = r.data && typeof r.data === 'object' ? r.data : {};
    } else {
      const r = await rawCall(s, 'export_status', { job }, CALL_TIMEOUT_MS);
      if (!r.ok) return { ok: false, error: r.error };
      data = r.data && typeof r.data === 'object' ? r.data : {};
    }

    const framesDone = Number(data.frame) || 0;
    const framesTotal = Number(data.total) || 0;
    const fraction = Number.isFinite(Number(data.fraction))
      ? Number(data.fraction)
      : (framesTotal > 0 ? framesDone / framesTotal : 0);
    /** @type {Record<string, *>} */
    const out = {
      ok: true,
      job,
      state: String(data.state || ''),
      stage: String(data.stage || ''),
      framesDone,
      framesTotal,
      fraction: Math.max(0, Math.min(1, fraction)),
      file: typeof data.output === 'string' ? data.output : '',
      // 原样透传：前端/排障需要看到 Concat 真正说了什么。
      raw: data,
    };
    if (Number(data.width) > 0) out.width = Number(data.width);
    if (Number(data.height) > 0) out.height = Number(data.height);
    if (data.error) out.error = msgOf(data.error);
    // 阻塞模式额外告诉调用方"这是等到结束的结果，不是瞬时快照"，
    // 免得前端把一次 wait 的结果误当成"刚开始就渲染完了"。
    if (waitSeconds > 0) out.waited = true;
    return out;
  });
}

/**
 * 取消导出。
 *
 * ⚠️ 取消是**异步生效**的：`export_cancel` 只是递了个话，任务可能还要几百毫秒
 *    才真的停下来。所以返回 `{ok:true}` 表示"取消请求已发出"，不代表"已经停了"；
 *    前端应继续轮询 `export_status` 直到 `state === 'cancelled'`。
 *
 * @param {{job:string}=} args
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function exportCancel(args) {
  const a = args && typeof args === 'object' ? args : {};
  const job = typeof a.job === 'string' ? a.job.trim() : '';
  if (!job) return Promise.resolve({ ok: false, error: '缺少 job（导出任务号）。' });
  return withSession(async (s) => {
    const r = await rawCall(s, 'export_cancel', { job }, CALL_TIMEOUT_MS);
    if (!r.ok) return { ok: false, error: '取消失败：' + r.error };
    return { ok: true };
  });
}

// ── 诊断 ──────────────────────────────────────────────────────────────────

/**
 * 门禁/排障用的读数。**不启动会话、不改变任何状态**。
 *
 * `spawns` 是「本进程累计 spawn 过几个 concat.exe」—— smoke 用它钉住
 * 「常驻会话只 spawn 一次」这条承诺（每次编辑都重启是本文件要解决的第一个问题，
 * 而"没有重启"这件事只有计数器能证明）。
 *
 * @returns {{spawns:number, alive:boolean, pid:number|null, openPath:string, queued:number, version:string, toolCount:number, lastError:string, idle:boolean}}
 */
function debug() {
  const alive = !!(session && !session.client.isClosed());
  return {
    spawns: spawnCount,
    alive,
    pid: alive ? session.client.pid : null,
    openPath,
    queued: queueDepth,
    version: session ? session.version : '',
    toolCount: session ? session.toolCount : 0,
    lastError,
    idle: idleTimer !== null,
  };
}

module.exports = {
  // 会话生命周期
  probe,
  closeSession,
  // 工程
  openProject,
  closeProject,
  snapshot,
  // 素材
  importMedia,
  probeMedia,
  // 编辑
  edit,
  undo,
  redo,
  // 预览 / 导出
  previewFrame,
  exportStart,
  exportStatus,
  exportCancel,
  // 诊断（门禁用；不是业务接口）
  _debug: debug,
  // 工作区根解析器注入点：`main.js` 启动时把它的**唯一**表达式（`workspaceRootDir`）交进来。
  // 外露它是因为本模块不许 require electron、也不许自己再写一份工作区根表达式。
  setWorkspaceRootResolver,
  // 「新建工程」的两个兜底的外露只给门禁/探针用（纯函数，不需要 Concat 也能验证）：
  // 默认落点 `<工作区根>/concat-projects` 与重名递增（防覆盖）。
  _defaultProjectsLocation: defaultProjectsLocation,
  _uniqueProjectName: uniqueProjectName,
  // `project_get` 的换算（门禁要钉 rateNum/rateDen 的除法边界，见 projectBlockOf 注释）
  _projectBlockOf: projectBlockOf,
  // 常量外露：门禁要断言"空闲关闭真的有 5 分钟这条策略"，而不是靠注释。
  IDLE_CLOSE_MS,
  PREVIEW_INLINE_MAX,
  EDIT_OPS,
  // 标题的可见默认样式 + 文字规范化：门禁要断言"默认样式真的看得见"
  // （纯白无描边 = 白底上 darkPx 为 0，那是本缺口 ② 的原始症状），
  // 以及"空文字不许变成不可见片段"。外露它们是为了让断言打在数据上，不是打在注释上。
  TITLE_DEFAULT_STYLE,
  TITLE_MAX_CHARS,
  _normalizeTitleText: normalizeTitleText,
};
