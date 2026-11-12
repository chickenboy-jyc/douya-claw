/**
 * wanxProvider.js —— 主进程「通义万象 3.0」视频 / 图像生成能力（纯 Node，可单测）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么单独成模块（而不是塞进 backend.js）
 * ────────────────────────────────────────────────────────────────────────────
 * 与 webSearchProviders.js / visionProvider.js 同一范式：把「调外部生成接口」的逻辑
 * 抽出来，顶部**不 require electron**，于是能用 createRequire 注入假 fetch 做不联网单测。
 * backend.js 顶部挂着 skills/connectors/experts 等重依赖，塞进去就没法单测了。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 红线（本模块严格遵守，改代码前先读）
 * ────────────────────────────────────────────────────────────────────────────
 *   · apiKey **只在主进程**使用。`status()` / 任何返回值里**绝不**出现完整 key，
 *     只返回掩码（前 6 + 后 4）。日志同理。
 *   · 渲染层不直连外网：本仓库铁律。渲染层只能经 preload 的 IPC 通道进来。
 *   · **诚实红线**：HTTP 200 不等于成功。图片接口可能返回 200 但 content 为空
 *     （prompt 被拦截 / 审核未通过 / 上游降级），此时必须判 ok:false 并说清原因，
 *     绝不允许「没出图却返回 ok:true」。
 *   · 不引入任何第三方依赖，只用 Node 内置 fs / path / AbortController / fetch。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 实测事实（2026-10-21 用真实 key 打真接口确认，不是照文档抄的）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 视频：POST video-synthesis + `X-DashScope-Async: enable` ⇒ **异步**，
 *     立即返回 `{output:{task_id, task_status:'PENDING'}}`；
 *     查询用 `GET /api/v1/tasks/<task_id>`（**同一 host**，不是 dashscope.aliyuncs.com）。
 *     状态实测见过：PENDING → RUNNING → （终态）SUCCEEDED / FAILED。
 *     480P/5s 的一条任务实测跑了 **>3 分钟**，所以前端必须轮询、不能当同步接口等。
 *   · 图像：POST multimodal-generation/generation ⇒ **同步**，一次返回结果。
 *     产物在 `output.choices[0].message.content[0].image`，是 **OSS 签名 URL**，
 *     带 `Expires=`（实测约 19 小时）。⇒ **必须立刻下载落地**，不能把 URL 当长期地址存。
 *     实测输出 1792×2400（2K），usage 里有 output_image_type=qima_output_2k。
 *   · ⚠️ **提交时不做参数校验**：传 `resolution:"999P"` / `ratio:"99:1"` / `duration:3`
 *     照样返回 200 + PENDING，非法值要等调度阶段才暴露。所以**参数白名单必须由我们兜**，
 *     不能指望服务端拒绝。UI 只给已验证过的档位。
 *   · 鉴权失败的判别：用不存在的模型名能拿到 `{"code":"InvalidParameter","message":"Model not exist."}`
 *     ⇒ 说明 key 有效、只是模型名不对。key 无效/过期会是 401 + `InvalidApiKey`。
 */

const fs = require('fs');
const path = require('path');

/** 业务端点。⚠️ 这是专有 maas 域名，不是通用 dashscope.aliyuncs.com，别「顺手」改成公网域名。 */
const WANX_BASE = 'https://ws-hfltcztm31i9qmuv.cn-beijing.maas.aliyuncs.com';
const VIDEO_SUBMIT_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';
const IMAGE_GEN_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const TASK_QUERY_PATH = '/api/v1/tasks/';

const DEFAULT_VIDEO_MODEL = 'wan3.0-video';
const DEFAULT_IMAGE_MODEL = 'qwen-image-3.0-pro';

/** 提交超时（给足，视频提交本身是快的，慢在渲染）。 */
const SUBMIT_TIMEOUT_MS = 60000;
/** 查询超时：轮询频率高，必须短，否则一次卡住会拖死整条轮询。 */
const QUERY_TIMEOUT_MS = 20000;
/** 图片是同步接口，2K 出图实测几十秒，给 180s。 */
const IMAGE_TIMEOUT_MS = 180000;

/**
 * 视频参数白名单。
 * `verified:true` = 2026-10-21 用真实 key 实跑确认过；false = 未实跑，UI 上必须标「未验证」。
 * 为什么带这个标记：服务端提交时不校验（见文件头），所以「能不能用」只能靠我们记录，
 * 不给用户「看起来都支持」的错觉。
 */
const VIDEO_RESOLUTIONS = [
  { value: '480P', label: '480P（最快最省）', verified: true },
  { value: '720P', label: '720P', verified: false },
  { value: '1080P', label: '1080P（最贵）', verified: false },
];
const VIDEO_RATIOS = [
  { value: 'adaptive', label: '自适应（跟随内容）', verified: true },
  { value: '16:9', label: '16:9 横屏', verified: false },
  { value: '9:16', label: '9:16 竖屏（抖音/小红书）', verified: false },
  { value: '1:1', label: '1:1 方形', verified: false },
  // 2026-10-21 补素材能力时按契约补齐：官网有这三档，前端做选择器要用同一份清单
  { value: '21:9', label: '21:9 宽银幕', verified: false },
  { value: '4:3', label: '4:3 传统横屏', verified: false },
  { value: '3:4', label: '3:4 传统竖屏', verified: false },
];
/**
 * 时长档位。
 *
 * ★ 2026-10-21 补素材能力时按官方口径放开到 2~30，并加 `-1`（智能时长）。
 *   `-1` 的含义是「让模型按内容自己决定秒数」，不是「不限」，也不是 0 ——
 *   计费仍按**实际生成秒数**，所以提交时无法估出金额（见 reconcileUsage 的 askedSec<=0 分支）。
 *   `verified` 语义不变：只有 5 秒实测跑通过，其余档位一律挂 false，界面不得显示成「已验证」。
 */
const VIDEO_DURATIONS = [
  { value: -1, label: '智能时长（由模型决定）', verified: false },
  { value: 5, label: '5 秒', verified: true },
  { value: 10, label: '10 秒', verified: false },
  { value: 15, label: '15 秒', verified: false },
  { value: 20, label: '20 秒', verified: false },
  { value: 25, label: '25 秒', verified: false },
  { value: 30, label: '30 秒（上限）', verified: false },
];

/** 总额度默认 300 元（老板 2026-10-21 实充）。可在配置里改，UI 只读不写死。 */
const DEFAULT_TOTAL_BUDGET = 300;

/**
 * 单价表。
 *
 * 【2026-10-21 已按阿里云官方定价页核对，华北2（北京）地域，人民币】
 *   · `wan3.0-video`      —— **按秒**计费：480P 0.3 / 720P 0.6 / 1080P 1.2（元/秒）
 *     来源：help.aliyun.com/zh/model-studio/wan3-0-video
 *     计费规则：**只对成功生成的视频秒数计费，失败不计费、不占免费额度**。
 *   · `qwen-image-3.0-pro` —— **按张**计费（输出）：1K 0.3 / 2K 0.6（元/张），
 *     另加输入 0.024 元/张。来源：help.aliyun.com/zh/pai/billing-of-pai-model-service
 *     计费规则：只对成功生成的张数计费。本仓实测该模型出的是 **2K**（1792×2400，
 *     `usage.output_image_type = qima_output_2k`）⇒ 默认按 2K 的 0.6 算。
 *
 * ⚠️ 三条必须诚实的地方（不改，因为改了就是撒谎）：
 *   ① 这是**官方原价**，不含控制台的限时优惠 / 资源包折扣，实际账单可能更低；
 *   ② 视频是**按秒**不是按条 —— 一条 5 秒 480P 是 1.5 元，不是 0.3 元。搞错这个口径，
 *      300 元会被高估成「能出 1000 条」；
 *   ③ 单价仍允许用户在界面上改（`savePrefs`）：哪天官方调价或买了资源包，
 *      改一次后续估算立刻跟着变，不必等我们发版。
 */
const DEFAULT_PRICES = {
  // 元/秒
  video: { '480P': 0.3, '720P': 0.6, '1080P': 1.2 },
  // 元/张（`default` = 本模型实测输出档位 2K）
  image: { '1K': 0.3, '2K': 0.6, default: 0.6 },
};

/** 允许的状态枚举（实测见过的 + 文档口径），未知状态一律当"还在跑"处理但要如实回传原文。 */
const TASK_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  UNKNOWN: 'UNKNOWN',
};

/* ════════════════════════════════════════════════════════════════════════════
 * 图片 / 视频 / 音频输入（参考素材）—— 2026-10-21 补「视频设计支持上传图片」
 * ────────────────────────────────────────────────────────────────────────────
 * 老板原话：「图片生成和视频都是支持图片上传的吧 你要做的跟官网一样 / 你现在都不支持」。
 * 补之前 submitVideo 只发 prompt + resolution/ratio/duration，body 里**根本没有 media 字段**；
 * generateImage 只走文生图 —— 也就是说「上传图片」这条路从请求层就是断的，不是缺个 UI 按钮。
 *
 * ★ 为什么校验必须在本地做完（而不是等上游报错）
 *   本文件头已实测：上游**提交时不校验参数**（`resolution:"999P"` 照样 200 + PENDING）。
 *   素材同理，超限 / 格式不对要到调度阶段才炸 —— 用户等半分钟后拿到一句英文 code。
 *   所以这里逐项前置校验，错误文案必须说清「哪一项、实际值、上限值」。
 *
 * ★ 为什么 base64 在这里才编码
 *   IPC 只传 path/name/bytes/ext。20MB 图片转 base64 ≈ 27MB 字符串，在渲染层 ↔ 主进程
 *   之间往返一次是纯内存浪费；编码只发生在**提交前这一步**。
 *
 * ⚠️ 诚实边界（不许假装已经校验）：本模块只有 Node 内置能力，没有图像解码器、没有 ffprobe。
 *   所以**能校验的是**：存在性、扩展名白名单、体积、同类素材条数、首尾帧与参考素材互斥。
 *   **不能校验的是**：图片单边 240~8000px / 长宽比 ≤8:1 / **是否带透明通道**（PNG 的 alpha）、
 *   视频 ≥16fps / 单边 240~4096px、音视频时长（单段 1~15s、合计 ≤15s）、
 *   以及「有 reference_video 时 参考总时长+输出时长 ≤30」这条组合约束（要读视频时长才能算）。
 *   这几项超限时由上游在调度阶段拒绝，我们把上游的 message 原样带出去
 *   （见 queryTask 的 message 字段），不吞掉、也不谎称本地已验过。
 *   要补这几项得引入解码器/ffprobe，属于「加依赖」，本轮不做。
 * ════════════════════════════════════════════════════════════════════════════ */

const MB = 1024 * 1024;

/** 扩展名 → MIME。视频素材用图与 I2I 用图的合法集合不同，见 MEDIA_RULES。 */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/**
 * 各用途的体积上限 + 格式白名单（官方口径，2026-10-21 核对）。
 *
 * ★ 为什么不能合并成一套白名单：视频 media 的图**不收** gif/tiff（官方只列
 *   JPEG/JPG/PNG/BMP/WEBP），而 I2I 的图**收** GIF/TIFF。合并的后果是
 *   「拿 gif 当视频首帧」这种上游必拒的请求被我们放过去 —— 校验就白做了。
 */
const MEDIA_RULES = {
  videoImage: { maxBytes: 20 * MB, limitLabel: '20MB', unit: '张', exts: ['.jpg', '.jpeg', '.png', '.bmp', '.webp'] },
  videoVideo: { maxBytes: 100 * MB, limitLabel: '100MB', unit: '段', exts: ['.mp4', '.mov'] },
  videoAudio: { maxBytes: 15 * MB, limitLabel: '15MB', unit: '段', exts: ['.mp3', '.wav'] },
  editImage: { maxBytes: 10 * MB, limitLabel: '10MB', unit: '张', exts: ['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp', '.gif'] },
};

/** 视频 media 各类上限（官方口径）。顺序即 `Object.keys` 报错时提示的可选值顺序。 */
const VIDEO_MEDIA_MAX = { first_frame: 1, last_frame: 1, reference_image: 10, reference_video: 5, reference_audio: 5 };
const VIDEO_MEDIA_LABEL = {
  first_frame: '首帧图',
  last_frame: '尾帧图',
  reference_image: '参考图',
  reference_video: '参考视频',
  reference_audio: '参考音频',
};
/** 严格定位「第一帧 / 最后一帧」的素材，与「参考类」素材互斥。 */
const VIDEO_FRAME_TYPES = ['first_frame', 'last_frame'];
const VIDEO_REF_TYPES = ['reference_image', 'reference_video', 'reference_audio'];

/**
 * 互斥错误文案（独立常量）。
 * 为什么单独拎出来：上传好几个角色时前端很容易「首帧 + 参考图」一起发（看起来都像图），
 * 上游会直接 400，而用户看到的是英文 code。这条文案是我们能给的最有用的那句话，
 * 要有独立单测盯着它（见门禁 W12-c），不许在重构中被顺手改掉。
 */
const MUTEX_ERROR = '首帧/尾帧 不能和 参考图/参考视频/参考音频 同时使用（上游规则），请二选一';

/** I2I 参考图上限（官方 1~3 张；0 张 = 文生图）。 */
const MAX_EDIT_IMAGES = 3;

/** 字节数 → 人类可读（1 位小数，与官方「≤20MB」口径对齐）。 */
function fmtMB(bytes) {
  return (Number(bytes) / MB).toFixed(1) + 'MB';
}

/**
 * 本地文件 → data URL。**只在提交前调用**。
 *
 * @param {string} filePath 绝对路径
 * @param {object} rule MEDIA_RULES 里的某一项
 * @param {string} label 人话标签，用于报错定位（例：「第 2 张参考图」）
 * @returns {{ok:true, dataUrl:string, bytes:number, ext:string} | {ok:false, error:string}}
 */
function fileToDataUrl(filePath, rule, label) {
  const p = String(filePath || '').trim();
  const who = label || '素材';
  if (!p) return { ok: false, error: who + ' 没有给文件路径' };
  const ext = path.extname(p).toLowerCase();
  const exts = (rule && rule.exts) || [];
  if (exts.indexOf(ext) < 0) {
    return {
      ok: false,
      error: who + ' 的格式 ' + (ext || '（无扩展名）') + ' 不支持，只支持 ' + exts.map((e) => e.slice(1)).join('/'),
    };
  }
  let st;
  try { st = fs.statSync(p); }
  catch { return { ok: false, error: '找不到' + who + '对应的文件：' + p }; }
  if (!st.isFile()) return { ok: false, error: who + '对应的不是一个文件：' + p };
  const maxBytes = Number(rule && rule.maxBytes) || 0;
  if (maxBytes && st.size > maxBytes) {
    return { ok: false, error: who + ' ' + fmtMB(st.size) + '，超过 ' + (rule.limitLabel || fmtMB(maxBytes)) + ' 上限' };
  }
  let buf;
  try { buf = fs.readFileSync(p); }
  catch (e) { return { ok: false, error: who + ' 读取失败：' + ((e && e.message) || e) }; }
  if (!buf.length) return { ok: false, error: who + ' 是空文件（0 字节）：' + p };
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length, ext };
}

/** 素材单位：图论「张」，音视频论「段」。 */
function mediaUnitOf(type) {
  return type === 'reference_video' || type === 'reference_audio' ? '段' : '张';
}

/**
 * media 单条 → {type, url}。
 * `path`（本地绝对路径）优先于 `url`：path 会被逐项校验，先解析它才能把「文件不存在 /
 * 超限」这类问题暴露出来，而不是被一个看起来合法的 url 静默盖住。
 */
function resolveOneVideoMedia(item, type, seq) {
  const rule = type === 'reference_video' ? MEDIA_RULES.videoVideo
    : (type === 'reference_audio' ? MEDIA_RULES.videoAudio : MEDIA_RULES.videoImage);
  const label = '第 ' + seq + ' ' + mediaUnitOf(type) + VIDEO_MEDIA_LABEL[type];
  const p = String((item && item.path) || '').trim();
  if (p) {
    const r = fileToDataUrl(p, rule, label);
    if (!r.ok) return r;
    return { ok: true, url: r.dataUrl };
  }
  const u = String((item && item.url) || '').trim();
  if (u) return { ok: true, url: u };
  return { ok: false, error: label + ' 既没有 path 也没有 url（两者给其一）' };
}

/**
 * 校验 + 解析视频 `media` 数组。
 *
 * ★ 顺序语义：返回的数组**保持传入顺序**，一条不动。
 *   官方规则是「提示词里用「图1」「图2」指代素材，编号 = 同类素材在 media 里的出现顺序」，
 *   所以「上传好几个角色」能不能用对，完全取决于这个顺序有没有被我们重排/去重。
 *   这里既不排序也不分组，只是逐条解析后 push。
 *
 * @returns {{ok:true, media:Array<{type:string,url:string}>} | {ok:false, error:string}}
 */
function buildVideoMedia(list) {
  const arr = Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : [];
  if (!arr.length) return { ok: true, media: [] };

  const types = arr.map((x) => String(x.type || ''));
  const badType = types.find((t) => !VIDEO_MEDIA_MAX[t]);
  if (badType !== undefined) {
    return {
      ok: false,
      error: '未知的素材类型 ' + (badType || '（空）') + '，只支持 ' + Object.keys(VIDEO_MEDIA_MAX).join(' / '),
    };
  }

  // ① 互斥：先按「出现了哪几类」判，与排列顺序无关（首帧在前或在后都不许混）。
  const hasFrame = types.some((t) => VIDEO_FRAME_TYPES.indexOf(t) >= 0);
  const hasRef = types.some((t) => VIDEO_REF_TYPES.indexOf(t) >= 0);
  if (hasFrame && hasRef) return { ok: false, error: MUTEX_ERROR };

  const counts = {};
  const media = [];
  for (let i = 0; i < arr.length; i++) {
    const type = types[i];
    counts[type] = (counts[type] || 0) + 1;
    const max = VIDEO_MEDIA_MAX[type];
    if (counts[type] > max) {
      return { ok: false, error: VIDEO_MEDIA_LABEL[type] + '最多 ' + max + ' ' + mediaUnitOf(type) + '，当前 ' + counts[type] + ' ' + mediaUnitOf(type) };
    }
    const r = resolveOneVideoMedia(arr[i], type, counts[type]);
    if (!r.ok) return r;
    media.push({ type, url: r.url });
  }
  return { ok: true, media };
}

/**
 * 校验 + 解析 I2I 的 `refImages`（0~3 张）。
 * 单图上限 10MB —— 比视频首帧的 20MB 小，这是官方两套口径，不能混用。
 */
function resolveRefImages(list) {
  const arr = Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : [];
  if (arr.length > MAX_EDIT_IMAGES) {
    return { ok: false, error: '参考图最多 ' + MAX_EDIT_IMAGES + ' 张，当前 ' + arr.length + ' 张' };
  }
  const urls = [];
  for (let i = 0; i < arr.length; i++) {
    const label = '第 ' + (i + 1) + ' 张参考图';
    const p = String(arr[i].path || '').trim();
    if (p) {
      const r = fileToDataUrl(p, MEDIA_RULES.editImage, label);
      if (!r.ok) return r;
      urls.push(r.dataUrl);
      continue;
    }
    const u = String(arr[i].url || '').trim();
    if (!u) return { ok: false, error: label + ' 既没有 path 也没有 url（两者给其一）' };
    urls.push(u);
  }
  return { ok: true, urls };
}

/**
 * 组装 I2I / T2I 的 `content` 数组。
 *
 * ★ 官方硬规则：**图在前、文在后**，且只允许 1 个 text 项（多了上游直接报错）。
 *   0 张参考图时退化成 T2I（只有 1 个 text），所以同一个函数能同时服务两条路。
 *   这个「顺序」和「1 个 text」是产品可用性的根：顺序错了模型会把图当附属物、把文字当主体。
 */
function buildImageContent(imageUrls, prompt) {
  const parts = imageUrls.map((u) => ({ image: u }));
  parts.push({ text: prompt });
  return parts;
}

/** key 掩码：只露前 6 后 4。长度不足 12 时全掩。 */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length < 12) return '*'.repeat(k.length);
  return k.slice(0, 6) + '…' + k.slice(-4);
}

/**
 * 配置文件名（放在 Electron userData 下，已在 .gitignore 覆盖范围内）。
 * 目录由调用方传（生产传 app.getPath('userData')），本模块不 require electron。
 */
function configPaths(dataDir) {
  const dir = String(dataDir || '');
  return {
    config: path.join(dir, 'wanx.json'),
    keyFile: path.join(dir, 'wanx-key.txt'),
    ledger: path.join(dir, 'wanx-spend.jsonl'),
  };
}

function readJsonSafe(p, fallback) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch { return fallback; }
}

/**
 * 取 key。优先级：环境变量 → 配置文件 → 纯文本 key 文件。
 * ⚠️ 绝不把 key 写进源码或仓库内文件（源码会进 git、会被打包进 asar，两处都不该有密钥）。
 */
function resolveKey(dataDir) {
  const env = String(process.env.DASHSCOPE_API_KEY || '').trim();
  if (env) return { key: env, from: 'env' };
  const p = configPaths(dataDir);
  const cfg = readJsonSafe(p.config, {});
  if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) {
    return { key: cfg.apiKey.trim(), from: 'config' };
  }
  try {
    const raw = fs.readFileSync(p.keyFile, 'utf8').trim();
    if (raw) return { key: raw, from: 'keyfile' };
  } catch { /* 没有就算了 */ }
  return { key: '', from: 'none' };
}

/**
 * 写 key（用户在界面上粘贴时走这里）。只落 userData，不进仓库。
 * @returns {{ok:boolean, masked?:string, error?:string}}
 */
function saveKey(dataDir, key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'key 不能为空' };
  if (k.length < 20) return { ok: false, error: 'key 看起来太短，请确认复制完整' };
  try {
    const p = configPaths(dataDir);
    const cfg = readJsonSafe(p.config, {});
    cfg.apiKey = k;
    cfg.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(p.config), { recursive: true });
    fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2), 'utf8');
    // 顺手把明文 key 文件清掉，避免两处各存一份、以后改了一处不生效
    try { fs.unlinkSync(p.keyFile); } catch { /* 没有就跳过 */ }
    return { ok: true, masked: maskKey(k) };
  } catch (e) {
    return { ok: false, error: '写入配置失败：' + ((e && e.message) || e) };
  }
}

function readPrefs(dataDir) {
  const p = configPaths(dataDir);
  const cfg = readJsonSafe(p.config, {});
  const prices = {
    video: Object.assign({}, DEFAULT_PRICES.video, (cfg.prices && cfg.prices.video) || {}),
    image: Object.assign({}, DEFAULT_PRICES.image, (cfg.prices && cfg.prices.image) || {}),
  };
  const totalBudget = Number.isFinite(Number(cfg.totalBudget)) && Number(cfg.totalBudget) > 0
    ? Number(cfg.totalBudget) : DEFAULT_TOTAL_BUDGET;
  return { prices, totalBudget };
}

/** 保存单价 / 总额度（用户按控制台账单校正后调）。 */
function savePrefs(dataDir, patch) {
  try {
    const p = configPaths(dataDir);
    const cfg = readJsonSafe(p.config, {});
    const inP = patch && patch.prices ? patch.prices : null;
    if (inP) {
      cfg.prices = cfg.prices && typeof cfg.prices === 'object' ? cfg.prices : {};
      if (inP.video) cfg.prices.video = Object.assign({}, cfg.prices.video || {}, inP.video);
      if (inP.image) cfg.prices.image = Object.assign({}, cfg.prices.image || {}, inP.image);
    }
    if (patch && Number.isFinite(Number(patch.totalBudget)) && Number(patch.totalBudget) > 0) {
      cfg.totalBudget = Number(patch.totalBudget);
    }
    cfg.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(p.config), { recursive: true });
    fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2), 'utf8');
    return { ok: true, prefs: readPrefs(dataDir) };
  } catch (e) {
    return { ok: false, error: '保存失败：' + ((e && e.message) || e) };
  }
}

/**
 * 失败冲正。
 *
 * 官方计费规则写明「**只对成功生成的视频秒数计费，失败不计费**」，而我们在 `submitVideo`
 * 里是**提交即记账**（那时还不知道成败）。任务是异步的，很可能几分钟后才失败 ——
 * 若不冲正，额度看板会永久少算这一笔，用户会以为自己没钱了。
 *
 * 做法：追加一条 `kind:'video_refund'`、`estimatedCost` 为**负数**的记录。
 * 不删原记录 —— 账本只追加不修改，这样「几时提交、几时判定失败」两条事实都在。
 * 幂等：同 taskId 已有冲正记录就跳过（轮询会重复调用本函数）。
 *
 * @returns {boolean} 是否真的写了一笔冲正
 */
function refundIfCharged(dataDir, taskId) {
  const id = String(taskId || '');
  if (!id) return false;
  const p = configPaths(dataDir);
  let raw = '';
  try { raw = fs.readFileSync(p.ledger, 'utf8'); } catch { return false; }
  const rows = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { /* 坏行跳过，不影响冲正 */ }
  }
  const already = rows.some((r) => r && r.kind === 'video_refund' && String(r.taskId || '') === id);
  if (already) return false;
  const src = rows.find((r) => r && r.kind === 'video' && String(r.taskId || '') === id);
  if (!src) return false; // 没记过账就不用冲（例如任务不是本机提交的）
  const c = Number(src.estimatedCost);
  if (!Number.isFinite(c) || c <= 0) return false;
  return recordSpend(dataDir, {
    ts: new Date().toISOString(),
    kind: 'video_refund',
    model: DEFAULT_VIDEO_MODEL,
    taskId: id,
    params: src.params || {},
    prompt: '',
    estimatedCost: -c,               // 负数：账本求和时自动抵掉
    costBasis: { unit: 'refund', reason: '上游任务失败/取消，官方不计费' },
    statusAtSubmit: 'FAILED',
    requestId: '',
  });
}

/**
 * 按上游回报的 `usage` 校正金额（2026-10-21 实测后新增）。
 *
 * 【为什么需要】实测一次 480P/5 秒成功后，上游在 `output` 之外给了可信的用量：
 *   `usage: { video_count:1, duration:5, SR:480, output_video_duration:5, fps:30, ratio:'16:9' }`
 * 也就是说「花了多少钱」这件事，**上游其实告诉了我们真值**，我们不必只靠「请求参数 × 单价」估。
 * 之前只在提交时按请求的 duration 记一笔，若上游实际出片秒数与请求不同（截断 / 重试 / 补帧），
 * 账本就会有一个不报错的偏差。
 *
 * 做法：秒数一致 ⇒ 什么都不写（绝大多数情况，账本不膨胀）；
 *       秒数不同 ⇒ 追加一条 `kind:'video_adjust'`，金额为**差额**（负数 = 退，正数 = 补）。
 * 幂等：同 taskId 已有 adjust 记录就跳过（轮询会重复调用）。
 *
 * @returns {boolean} 是否追加了校正记录
 */
function reconcileUsage(dataDir, taskId, usage) {
  const id = String(taskId || '');
  if (!id || !usage || typeof usage !== 'object') return false;
  // 上游字段名实测为 `output_video_duration`（fallback 到 `duration`，两者实测同为 5）
  const actualSec = Number(usage.output_video_duration != null ? usage.output_video_duration : usage.duration);
  if (!Number.isFinite(actualSec) || actualSec <= 0) return false;

  const p = configPaths(dataDir);
  let raw = '';
  try { raw = fs.readFileSync(p.ledger, 'utf8'); } catch { return false; }
  const rows = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { /* 坏行跳过 */ }
  }
  if (rows.some((r) => r && r.kind === 'video_adjust' && String(r.taskId || '') === id)) return false;
  const src = rows.find((r) => r && r.kind === 'video' && String(r.taskId || '') === id);
  if (!src || !src.costBasis) return false;
  const perSec = Number(src.costBasis.perSecond);
  const askedSec = Number(src.costBasis.seconds);
  if (!Number.isFinite(perSec) || !Number.isFinite(askedSec)) return false;
  // 请求秒数未知（duration = -1 智能时长）⇒ 不做「差额」而是按真实秒数**补记一整笔**，
  // 否则这笔钱会永久不在账本里，用户以为额度还够，实际已经花掉了。
  if (askedSec > 0 && Math.abs(actualSec - askedSec) < 0.01) return false; // 一致 ⇒ 不写（不制造噪音记录）

  const diff = askedSec > 0
    ? Math.round((actualSec - askedSec) * perSec * 100) / 100
    : Math.round(actualSec * perSec * 100) / 100;
  return recordSpend(dataDir, {
    ts: new Date().toISOString(),
    kind: 'video_adjust',
    model: DEFAULT_VIDEO_MODEL,
    taskId: id,
    params: src.params || {},
    prompt: '',
    estimatedCost: diff, // 正数=补扣，负数=退还
    costBasis: { unit: 'per_second', perSecond: perSec, askedSeconds: askedSec, actualSeconds: actualSec },
    statusAtSubmit: 'SUCCEEDED',
    requestId: '',
  });
}

/** 估算一次视频成本（元）= 每秒单价 × 时长。
 *
 * ★ 必须乘时长：官方按**成功生成秒数**计费。早期版本只返回每秒单价，
 *   界面就会把「480P 0.3 元」显示成一条视频的价格，而实际一条 5 秒是 1.5 元。
 *   这个错会让 300 元额度被高估 5 倍（按 5 秒算）到 30 倍（按 30 秒算），
 *   是「估算口径错」里最贵的一种，所以这里不留接口只传分辨率的余地。
 *
 * 取不到单价 / 时长非法时返回 null，**不猜**（返回 0 会被读成免费）。
 */
function estimateVideoCost(prices, resolution, duration) {
  const p = (prices && prices.video) || {};
  const perSec = p[String(resolution || '')];
  const sec = Number(duration);
  if (!Number.isFinite(Number(perSec))) return null;
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.round(Number(perSec) * sec * 100) / 100;
}
function estimateImageCost(prices) {
  const p = (prices && prices.image) || {};
  const v = p.default;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/** 追加一条账本（jsonl，一行一笔，只追加不覆盖）。 */
function recordSpend(dataDir, entry) {
  try {
    const p = configPaths(dataDir);
    fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
    fs.appendFileSync(p.ledger, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 失败尝试的合法 `stage`。**白名单写死**：写错 stage 等于「失败里又丢一层信息」，
 * 而我们做这件事的全部目的就是「下次查得到」。所以不合法的值一律落成 `'submit'`
 * （提交阶段是绝大多数失败发生的地方），绝不把用户传进来的随意字符串抄进账本。
 */
const ATTEMPT_STAGES = ['validate', 'submit', 'query', 'network', 'media'];

/**
 * 追加一条**失败尝试**记录（2026-10-24 新增）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要它（这是老板那次「视频生成不出来」真正卡住的地方）
 * ────────────────────────────────────────────────────────────────────────────
 * 老板机器上的 `wanx-spend.jsonl` 里只有 1 条视频记录（还是我们 10-21 开发时打的），
 * 10-24 / 10-30 那几次点「生成视频」**一行都没有**。原因是结构性的：
 * `recordSpend` 只在**拿到 taskId 之后**才调用 ⇒ 在此之前的所有 early-return
 * （prompt 为空 / 没 key / 参数非法 / 素材校验不过 / 网络异常 / HTTP 非 2xx /
 * 200 但没有 task_id）**一条痕迹都不留**。于是「为什么失败」这件事在用户机器上
 * 彻底不可观测 —— 我们只能靠猜。
 * ⇒ 提交路径上**每一条失败返回前**都调本函数，把那一刻掌握的全部信息落盘。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★★ 硬红线：这里**绝对不许写 `estimatedCost` / `costBasis` ★★
 * ────────────────────────────────────────────────────────────────────────────
 * `readLedger` 会把 `Number(o.estimatedCost)` 累加进 `spent`，`budgetSummary` 又用
 * `spent` 算剩余额度。失败尝试一旦带上金额，额度就会**凭空减少** ——
 * 用户会看到「我什么都没生成成功，钱却少了」。官方口径也写明失败不计费。
 * 所以写入字段是**固定白名单式**构造的（逐字段挑选，不是 Object.assign 展开）：
 * 谁往这里加字段都得先想清楚会不会被 readLedger 当成钱。
 * 唯一标记是 `ok:false`（`recordSpend` 那边的成功行补了 `ok:true`，两侧对称）。
 *
 * 文件与 `recordSpend` **同一个**（`configPaths.ledger`）、同一行 JSON 格式：
 * 老板/我们排障时用同一套办法（读 `%APPDATA%/douya-claw/wanx-spend.jsonl`）就能看到
 * 失败的来龙去脉，不必再去翻另一个我们没告诉过他的文件。
 *
 * @param {string} dataDir Electron userData 目录
 * @param {object} entry {kind, model?, stage, error, prompt?, params?,
 *                        httpStatus?, code?, requestId?}
 * @returns {boolean} 是否真的写了一行（吞错，绝不因「留痕失败」影响主流程）
 */
function recordAttempt(dataDir, entry) {
  try {
    const a = entry && typeof entry === 'object' ? entry : {};
    const kind = a.kind === 'image' ? 'image' : 'video';
    const stage = ATTEMPT_STAGES.indexOf(String(a.stage || '')) >= 0 ? String(a.stage) : 'submit';
    const p = configPaths(dataDir);
    // ⚠️ 逐字段构造（不展开 entry）：见上方红线，`estimatedCost` 漏进来就会改额度。
    const row = {
      ts: new Date().toISOString(),
      ok: false,
      kind,
      model: String(a.model || (kind === 'image' ? DEFAULT_IMAGE_MODEL : DEFAULT_VIDEO_MODEL)),
      stage,
      error: String(a.error || '（未提供原因）'),
      prompt: String(a.prompt || '').slice(0, 120),
      params: a.params && typeof a.params === 'object' ? a.params : {},
    };
    // 上游给的排障钥匙：有就带上，没有就不写这个字段（不写空串冒充「上游没给」以外的含义）
    if (a.httpStatus !== undefined && a.httpStatus !== null && a.httpStatus !== '') row.httpStatus = a.httpStatus;
    if (a.code) row.code = String(a.code);
    if (a.requestId) row.requestId = String(a.requestId);
    fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
    fs.appendFileSync(p.ledger, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 读账本（尾部 limit 条 + 汇总）。坏行跳过但计数，不静默。
 *
 * ★ 2026-10-24：`ok:false` 的**失败尝试行**（见 recordAttempt）与计费行同文件但不同义，
 *   因此这里把它们从 `spent` / `count` / `items` 里**分流**出去，只单独报 `attempts`：
 *     · `spent` —— 当然不能算（它们是 0 元，算了也是 0，但语义上不该混进账单）；
 *     · `count` —— 界面上叫「最近 N 笔（估算）」，把失败也算一笔会让老板以为花过钱；
 *     · `items` —— 同理，界面每行都显示 `￥金额`，没有金额的行会显示成 `￥—`，
 *                 看起来像一条 0 元消费记录，误导性大于信息量。
 *   失败原因要看，就去读文件（`wanx-spend.jsonl` 里 `ok:false` 的那些行）——
 *   这正是老板/我们排障时真实的动作。**没有隐藏**：`attempts` 这个计数如实回传。
 */
function readLedger(dataDir, limit) {
  const p = configPaths(dataDir);
  let raw = '';
  try { raw = fs.readFileSync(p.ledger, 'utf8'); } catch { return { items: [], spent: 0, count: 0, badLines: 0, attempts: 0 }; }
  const lines = raw.split('\n').filter((l) => l.trim());
  let spent = 0;
  let badLines = 0;
  let attempts = 0;
  const all = [];
  for (const l of lines) {
    let o = null;
    try { o = JSON.parse(l); } catch { badLines += 1; continue; }
    if (!o || typeof o !== 'object') { badLines += 1; continue; }
    // 失败尝试行：只计数，不进账单（见函数头）。`recordSpend` 从不写 ok:false ⇒ 不误伤。
    if (o.ok === false) { attempts += 1; continue; }
    const c = Number(o.estimatedCost);
    if (Number.isFinite(c)) spent += c;
    all.push(o);
  }
  const n = Math.max(1, Number(limit) || 30);
  return { items: all.slice(-n).reverse(), spent, count: all.length, badLines, attempts };
}

/**
 * 额度汇总。remaining 用「总额度 − 估算已用」。
 * ⚠️ 字段名与语义都要能自证：`estimated:true` 表示这是估算，不是账单。
 */
function budgetSummary(dataDir) {
  const prefs = readPrefs(dataDir);
  const led = readLedger(dataDir, 1);
  const spent = Math.round(led.spent * 100) / 100;
  return {
    ok: true,
    totalBudget: prefs.totalBudget,
    spent,
    remaining: Math.round((prefs.totalBudget - spent) * 100) / 100,
    count: led.count,
    badLines: led.badLines,
    estimated: true,
    prices: prefs.prices,
  };
}

/** 统一错误归一化：把网络错、HTTP 错、业务错都变成 {ok:false, error, detail, httpStatus, code, requestId}。 */
function normalizeError(e, extra) {
  const out = Object.assign({ ok: false }, extra || {});
  if (e && e.name === 'AbortError') {
    out.error = '请求超时（上游没在限定时间内返回）';
    out.kind = 'timeout';
    return out;
  }
  if (e && e.httpStatus) {
    out.httpStatus = e.httpStatus;
    out.code = e.code || '';
    out.requestId = e.requestId || '';
    out.error = e.message || ('HTTP ' + e.httpStatus);
    return out;
  }
  out.error = (e && e.message) || String(e || '未知错误');
  out.kind = 'network';
  return out;
}

/** 带超时的 fetch。返回 {status, json, text}；不抛业务错，交给调用方判。 */
async function httpJson(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从上游错误体里提炼人话。
 * 上游形态：{"code":"InvalidParameter","message":"Model not exist.","request_id":"..."}
 */
function upstreamMessage(json, text, status) {
  if (json && (json.message || json.code)) {
    const code = json.code ? '[' + json.code + '] ' : '';
    return code + (json.message || ('HTTP ' + status));
  }
  const t = String(text || '').slice(0, 200);
  return t || ('HTTP ' + status);
}

/**
 * 提交视频任务（异步）。
 * @param {object} o {prompt, resolution, ratio, duration, negativePrompt,
 *                    media?:[{type, path?, url?}], audio?, seed?, promptExtend?}
 * @returns {Promise<{ok:boolean, taskId?:string, status?:string, requestId?:string, estimatedCost?:number|null, error?:string}>}
 */
async function submitVideo(dataDir, o) {
  const a = o && typeof o === 'object' ? o : {};
  const prompt = String(a.prompt || '').trim();
  // ⚠️ 从这一行以下的**每一条失败返回**都必须先 recordAttempt 再返回（2026-10-24）：
  //    在此之前的所有 early-return 都不留痕，正是「失败零留痕」的根因，见 recordAttempt 头注。
  //    返回值本身**一个字都不许改**（现有门禁按文案断言）。
  if (!prompt) {
    recordAttempt(dataDir, {
      kind: 'video', stage: 'validate', error: 'prompt 为空', prompt: '',
      params: { resolution: String(a.resolution || ''), ratio: String(a.ratio || ''), duration: a.duration },
    });
    return { ok: false, error: '请先写视频描述（prompt 不能为空）' };
  }
  const { key } = resolveKey(dataDir);
  if (!key) {
    recordAttempt(dataDir, {
      kind: 'video', stage: 'validate', error: '未配置 API Key', prompt,
      params: { resolution: String(a.resolution || ''), ratio: String(a.ratio || ''), duration: a.duration },
    });
    return { ok: false, error: '还没有配置 API Key（请在上面粘贴你的 key）', needKey: true };
  }

  const resolution = String(a.resolution || '480P');
  const ratio = String(a.ratio || 'adaptive');

  // ★ 时长：无视频输入时是整数 [2,30]，`-1` = 智能时长。
  //   上游提交时不校验（传 3 也返回 200 + PENDING），所以这条白名单只能我们兜。
  const rawDur = (a.duration === undefined || a.duration === null || a.duration === '') ? 5 : Number(a.duration);
  if (!(rawDur === -1 || (Number.isInteger(rawDur) && rawDur >= 2 && rawDur <= 30))) {
    const durErr = '时长必须是 -1（智能时长）或 2~30 之间的整数，当前 ' + String(a.duration);
    recordAttempt(dataDir, {
      kind: 'video', stage: 'validate', error: durErr, prompt,
      params: { resolution, ratio, duration: a.duration },
    });
    return { ok: false, error: durErr };
  }
  const duration = rawDur;

  // ★ 素材：校验全部在本地做完（存在性 / 扩展名 / 体积 / 条数 / 首尾帧互斥），
  //   有任何一条不过就直接返回人话错误，一个字节都不会发出去，也不记账。
  const mediaRes = buildVideoMedia(a.media);
  if (!mediaRes.ok) {
    recordAttempt(dataDir, {
      kind: 'video', stage: 'media', error: mediaRes.error, prompt,
      params: { resolution, ratio, duration },
    });
    return { ok: false, error: mediaRes.error, stage: 'media' };
  }
  const media = mediaRes.media;

  const body = {
    model: DEFAULT_VIDEO_MODEL,
    input: { prompt },
    parameters: { resolution, ratio, duration },
  };
  if (a.negativePrompt) body.input.negative_prompt = String(a.negativePrompt);
  // ⚠️ `media` 为空时**绝不**传空数组：上游对 `media:[]` 的容忍度未知（可能被当非法），
  //   而不传这个 key 是官方文档里 T2V 的标准形态。空数组零收益、纯风险。
  if (media.length) body.input.media = media;
  if (typeof a.audio === 'boolean') body.parameters.audio = a.audio;
  if (typeof a.promptExtend === 'boolean') body.parameters.prompt_extend = a.promptExtend;
  if (a.seed !== undefined && a.seed !== null && String(a.seed).trim() !== '') {
    const sd = Number(a.seed);
    if (!(sd === -1 || (Number.isInteger(sd) && sd >= 0 && sd <= 2147483647))) {
      const seedErr = 'seed 必须是 -1 或 0~2147483647 的整数，当前 ' + String(a.seed);
      recordAttempt(dataDir, {
        kind: 'video', stage: 'validate', error: seedErr, prompt,
        params: { resolution, ratio, duration, seed: a.seed },
      });
      return { ok: false, error: seedErr };
    }
    body.parameters.seed = sd;
  }

  let r;
  try {
    r = await httpJson(WANX_BASE + VIDEO_SUBMIT_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(body),
    }, SUBMIT_TIMEOUT_MS);
  } catch (e) {
    // 网络层失败（超时 / DNS / TLS / 连接被拒）。normalizeError 已经把 kind/httpStatus/
    // code/requestId/error 归一好，这里**原样**把返回值返回（结构不许改），
    // 但账本要留痕：`stage:'network'` 才能和「上游明确拒绝（submit）」区分开 ——
    // 前者该重试、该查代理；后者该查 key/模型/参数。混在一起就等于没归因。
    const ne = normalizeError(e, { stage: 'submit' });
    recordAttempt(dataDir, {
      kind: 'video', stage: 'network', error: ne.error,
      httpStatus: ne.httpStatus, code: ne.code, requestId: ne.requestId,
      prompt,
      params: {
        resolution, ratio, duration, mediaKinds: media.map((m) => m.type),
        // `kind` 是行级字段（video/image），不能再塞网络错误分类 ⇒ 放在 params 里
        errorKind: ne.kind || '',
      },
    });
    return ne;
  }

  if (r.status < 200 || r.status >= 300) {
    const e = new Error(upstreamMessage(r.json, r.text, r.status));
    e.httpStatus = r.status;
    e.code = (r.json && r.json.code) || '';
    e.requestId = (r.json && r.json.request_id) || '';
    const ne = normalizeError(e, { stage: 'submit' });
    recordAttempt(dataDir, {
      kind: 'video', stage: 'submit', error: ne.error,
      httpStatus: ne.httpStatus, code: ne.code, requestId: ne.requestId,
      prompt,
      params: { resolution, ratio, duration, mediaKinds: media.map((m) => m.type) },
    });
    return ne;
  }
  const out = (r.json && r.json.output) || {};
  const taskId = out.task_id || '';
  if (!taskId) {
    const noIdErr = '上游返回 200 但没有 task_id（响应结构变了？）';
    recordAttempt(dataDir, {
      kind: 'video', stage: 'submit', error: noIdErr,
      httpStatus: r.status, requestId: (r.json && r.json.request_id) || '',
      prompt,
      params: { resolution, ratio, duration, mediaKinds: media.map((m) => m.type) },
    });
    return { ok: false, error: noIdErr, raw: String(r.text || '').slice(0, 300) };
  }
  const prefs = readPrefs(dataDir);
  const estimatedCost = estimateVideoCost(prefs.prices, resolution, duration);
  recordSpend(dataDir, {
    ts: new Date().toISOString(),
    // 2026-10-24：成功行补一个 `ok:true`。只加这一个字段，别的字段一个不动 ——
    // `recordAttempt` 的失败行是 `ok:false`，两侧对称后，「这一行是不是一次计费」一眼可判。
    ok: true,
    kind: 'video',
    model: DEFAULT_VIDEO_MODEL,
    taskId,
    params: { resolution, ratio, duration, mediaKinds: media.map((m) => m.type) },
    prompt: prompt.slice(0, 120),
    estimatedCost,
    // 记下「按什么算出来的」，方便日后和真账单对账（只记一个总数是没法复算的）
    costBasis: { unit: 'per_second', perSecond: (prefs.prices.video || {})[resolution], seconds: duration },
    statusAtSubmit: out.task_status || TASK_STATUS.PENDING,
    requestId: (r.json && r.json.request_id) || '',
  });
  return {
    ok: true,
    taskId,
    status: out.task_status || TASK_STATUS.PENDING,
    requestId: (r.json && r.json.request_id) || '',
    estimatedCost,
    // 前端要拿它给用户回话：「已带上 2 张参考图 / 1 张首帧」——不是「提交成功」四个字了事
    mediaCount: media.length,
    mediaKinds: media.map((m) => m.type),
  };
}

/**
 * 查询视频任务。返回结构对前端友好，并且**如实回传上游原文**（排障靠它）。
 * 成功时把视频 URL 一并取出（实测在 output.video_url）。
 */
async function queryTask(dataDir, taskId) {
  const id = String(taskId || '').trim();
  if (!id) return { ok: false, error: '缺少 taskId' };
  const { key } = resolveKey(dataDir);
  if (!key) return { ok: false, error: '还没有配置 API Key', needKey: true };

  let r;
  try {
    r = await httpJson(WANX_BASE + TASK_QUERY_PATH + encodeURIComponent(id), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key },
    }, QUERY_TIMEOUT_MS);
  } catch (e) { return normalizeError(e, { stage: 'query', taskId: id }); }

  if (r.status < 200 || r.status >= 300) {
    const e = new Error(upstreamMessage(r.json, r.text, r.status));
    e.httpStatus = r.status;
    e.code = (r.json && r.json.code) || '';
    e.requestId = (r.json && r.json.request_id) || '';
    return normalizeError(e, { stage: 'query', taskId: id });
  }
  const out = (r.json && r.json.output) || {};
  const status = String(out.task_status || TASK_STATUS.UNKNOWN);
  const videoUrl = out.video_url || (out.results && out.results.video_url) || '';
  // 失败/取消 ⇒ 官方不计费，把提交时记的那笔冲正掉（幂等，轮询多次只冲一次）
  if (status === TASK_STATUS.FAILED || status === TASK_STATUS.CANCELED) {
    refundIfCharged(dataDir, id);
  }
  // 成功且上游回报了 usage ⇒ 用**真实秒数**校正金额（实测字段：output_video_duration / SR）
  const usage = (r.json && r.json.usage) || out.usage || null;
  if (status === TASK_STATUS.SUCCEEDED && usage) {
    reconcileUsage(dataDir, id, usage);
  }
  return {
    ok: true,
    taskId: id,
    status,
    done: status === TASK_STATUS.SUCCEEDED || status === TASK_STATUS.FAILED || status === TASK_STATUS.CANCELED,
    failed: status === TASK_STATUS.FAILED || status === TASK_STATUS.CANCELED,
    videoUrl,
    submitTime: out.submit_time || '',
    scheduledTime: out.scheduled_time || '',
    // 失败时上游会给 message/code；成功时会给 usage（实测在**顶层**，与 output 平级）。
    // 早期只读 out.usage ⇒ 实测那次 usage 丢失，页面拿不到真实秒数 ⇒ 现已两处都取。
    message: out.message || out.code || '',
    usage: usage,
    raw: r.json,
  };
}

/**
 * 生成图片（同步，一次返回）。
 *
 * 两条路走同一个接口、同一个函数：
 *   · `refImages` 为空 ⇒ 文生图（T2I），content 只有 1 个 text；
 *   · `refImages` 1~3 张 ⇒ 图生图（I2I），content = N 个 image（**在前**）+ 1 个 text（**在后**）。
 *
 * ★ I2I 必须把 `prompt_extend_mode` 强制成 `'direct'`：官方明确 I2I 只接受 direct，
 *   传 `'agent'` 上游 400。调用方传了别的值也一律覆盖 —— 让上游去拒是纯粹的往返浪费。
 *
 * ⚠️ 产物是**会过期的签名 URL**（图片 24 小时），调用方要立刻 downloadMedia 落地。
 */
async function generateImage(dataDir, o) {
  const a = o && typeof o === 'object' ? o : {};
  const prompt = String(a.prompt || '').trim();
  // ⚠️ 与 submitVideo 同一条纪律：**每一条失败返回**都先 recordAttempt 再返回（2026-10-24）。
  //    图片失败同样要留痕 —— 老板看到的是「图没出来」，我们手上不能又是一片空白。
  //    返回值本身**一个字都不许改**（unit-wanx-provider 的 W7/W13 按文案断言）。
  const imageParams = () => ({
    size: String(a.size || ''),
    n: a.n,
    seed: a.seed,
    refCount: Array.isArray(a.refImages) ? a.refImages.length : 0,
  });
  if (!prompt) {
    recordAttempt(dataDir, {
      kind: 'image', stage: 'validate', error: 'prompt 为空', prompt: '',
      params: imageParams(),
    });
    return { ok: false, error: '请先写画面描述（prompt 不能为空）' };
  }
  const { key } = resolveKey(dataDir);
  if (!key) {
    recordAttempt(dataDir, {
      kind: 'image', stage: 'validate', error: '未配置 API Key', prompt,
      params: imageParams(),
    });
    return { ok: false, error: '还没有配置 API Key（请在上面粘贴你的 key）', needKey: true };
  }

  // 参考图：0~3 张，逐张校验（存在性 / 格式 / 单图 ≤10MB），超限前不发请求。
  const refRes = resolveRefImages(a.refImages);
  if (!refRes.ok) {
    recordAttempt(dataDir, {
      kind: 'image', stage: 'media', error: refRes.error, prompt,
      params: imageParams(),
    });
    return { ok: false, error: refRes.error, stage: 'refImages' };
  }
  const refUrls = refRes.urls;

  const parameters = { prompt_extend: a.promptExtend !== false };
  if (a.negativePrompt) parameters.negative_prompt = String(a.negativePrompt);
  // ★ 有参考图 ⇒ 强制 direct（见函数头）。没有参考图则**不传**这个 key：
  //   文生图下它是可选的，传一个我们没验证过的取值只会多一个上游拒绝的理由。
  if (refUrls.length) parameters.prompt_extend_mode = 'direct';

  // size 用**星号**（`1024*1024`）；`1024x1024` 是 OpenAI 兼容协议的写法，这条不走那套。
  if (a.size !== undefined && a.size !== null && String(a.size).trim() !== '') {
    const size = String(a.size).trim();
    if (!/^\d+\*\d+$/.test(size)) {
      const sizeErr = 'size 必须写成「宽*高」（中间是星号，不是 x 或 ×），例如 1024*1024，当前 ' + size;
      recordAttempt(dataDir, {
        kind: 'image', stage: 'validate', error: sizeErr, prompt,
        params: imageParams(),
      });
      return { ok: false, error: sizeErr };
    }
    const wh = size.split('*').map(Number);
    const px = wh[0] * wh[1];
    if (!(px >= 512 * 512 && px <= 2048 * 2048)) {
      const pxErr = 'size 总像素必须在 512×512 ~ 2048×2048 之间，当前 ' + wh[0] + '×' + wh[1];
      recordAttempt(dataDir, {
        kind: 'image', stage: 'validate', error: pxErr, prompt,
        params: imageParams(),
      });
      return { ok: false, error: pxErr };
    }
    parameters.size = size;
  }
  if (a.n !== undefined && a.n !== null && String(a.n).trim() !== '') {
    const n = Number(a.n);
    if (!Number.isInteger(n) || n < 1 || n > 6) {
      const nErr = 'n 必须是 1~6 的整数，当前 ' + String(a.n);
      recordAttempt(dataDir, {
        kind: 'image', stage: 'validate', error: nErr, prompt,
        params: imageParams(),
      });
      return { ok: false, error: nErr };
    }
    parameters.n = n;
  }
  if (a.seed !== undefined && a.seed !== null && String(a.seed).trim() !== '') {
    const sd = Number(a.seed);
    if (!(sd === -1 || (Number.isInteger(sd) && sd >= 0 && sd <= 2147483647))) {
      const seedErr = 'seed 必须是 -1 或 0~2147483647 的整数，当前 ' + String(a.seed);
      recordAttempt(dataDir, {
        kind: 'image', stage: 'validate', error: seedErr, prompt,
        params: imageParams(),
      });
      return { ok: false, error: seedErr };
    }
    parameters.seed = sd;
  }

  const body = {
    model: DEFAULT_IMAGE_MODEL,
    input: { messages: [{ role: 'user', content: buildImageContent(refUrls, prompt) }] },
    parameters,
  };

  let r;
  try {
    r = await httpJson(WANX_BASE + IMAGE_GEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    }, IMAGE_TIMEOUT_MS);
  } catch (e) {
    const ne = normalizeError(e, { stage: 'image' });
    recordAttempt(dataDir, {
      kind: 'image', stage: 'network', error: ne.error,
      httpStatus: ne.httpStatus, code: ne.code, requestId: ne.requestId,
      prompt,
      // `kind` 是行级字段（video/image），网络错误分类只能放 params（同 submitVideo）
      params: Object.assign(imageParams(), { errorKind: ne.kind || '' }),
    });
    return ne;
  }

  if (r.status < 200 || r.status >= 300) {
    const e = new Error(upstreamMessage(r.json, r.text, r.status));
    e.httpStatus = r.status;
    e.code = (r.json && r.json.code) || '';
    e.requestId = (r.json && r.json.request_id) || '';
    const ne = normalizeError(e, { stage: 'image' });
    recordAttempt(dataDir, {
      kind: 'image', stage: 'submit', error: ne.error,
      httpStatus: ne.httpStatus, code: ne.code, requestId: ne.requestId,
      prompt,
      params: Object.assign(imageParams(), { errorKind: ne.kind || '' }),
    });
    return ne;
  }

  // ★ 诚实红线：200 不代表出图了。content 为空 / 只有 text（审核拒绝说明）都必须判失败。
  const choices = (r.json && r.json.output && r.json.output.choices) || [];
  const content = (choices[0] && choices[0].message && choices[0].message.content) || [];
  const imgItem = content.find((c) => c && (c.image || (c.type === 'image' && c.image)));
  const textItems = content.filter((c) => c && c.text).map((c) => c.text);
  if (!imgItem || !imgItem.image) {
    const upstreamText = textItems.join(' ').slice(0, 300);
    recordAttempt(dataDir, {
      kind: 'image', stage: 'submit',
      error: '上游返回 200 但没有图片（多半是提示词被内容审核拦下了）',
      prompt,
      params: Object.assign(imageParams(), {
        finishReason: (choices[0] && choices[0].finish_reason) || '',
        // 把上游的解释文字带进留痕：排障时「为什么没图」就在这一句里
        upstreamText: upstreamText.slice(0, 120),
      }),
    });
    return {
      ok: false,
      error: '上游返回 200 但没有图片（多半是提示词被内容审核拦下了）',
      upstreamText,
      finishReason: (choices[0] && choices[0].finish_reason) || '',
      raw: String(r.text || '').slice(0, 400),
    };
  }
  const usage = (r.json && r.json.usage) || null;
  const prefs = readPrefs(dataDir);
  const estimatedCost = estimateImageCost(prefs.prices);
  recordSpend(dataDir, {
    ts: new Date().toISOString(),
    kind: 'image',
    model: DEFAULT_IMAGE_MODEL,
    params: { promptExtend: a.promptExtend !== false, refCount: refUrls.length },
    prompt: prompt.slice(0, 120),
    estimatedCost,
    // 记下真实输出档位（上游给的），这样「为什么按 2K 计价」日后可复算
    costBasis: {
      unit: 'per_image',
      perImage: (prefs.prices.image || {}).default,
      outputTier: (usage && usage.output_image_type) || '',
    },
    statusAtSubmit: 'SUCCEEDED',
    requestId: (r.json && r.json.request_id) || '',
  });
  return {
    ok: true,
    imageUrl: imgItem.image,
    usage,
    requestId: (r.json && r.json.request_id) || '',
    estimatedCost,
    refCount: refUrls.length,
    // 签名 URL 有效期由 OSS 自己带，这里只提醒调用方尽快落地
    expiresHint: '这是会过期的签名地址，保存到本地后才能长期使用',
  };
}

/** 从 URL 猜扩展名（拿不到就按 bin）。 */
function extFromUrl(u, fallback) {
  try {
    const p = new URL(String(u)).pathname;
    const e = path.extname(p).toLowerCase();
    if (e && e.length <= 6 && /^\.[a-z0-9]+$/.test(e)) return e;
  } catch { /* ignore */ }
  return fallback || '.bin';
}

/**
 * 把远端签名 URL 下载到本地（**必须**：视频/图片 URL 都会过期）。
 * @param {object} o {url, dir, filename}
 */
async function downloadMedia(o) {
  const a = o && typeof o === 'object' ? o : {};
  const url = String(a.url || '');
  const dir = String(a.dir || '');
  if (!url) return { ok: false, error: '缺少下载地址' };
  if (!dir) return { ok: false, error: '缺少保存目录' };

  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 300000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      return { ok: false, error: '下载失败：HTTP ' + res.status, httpStatus: res.status };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: '下载失败：拿到 0 字节（地址多半已过期）' };
    const ext = extFromUrl(url, a.fallbackExt || '.bin');
    const base = String(a.filename || '').trim() || ('wanx-' + Date.now());
    const safe = base.replace(/[\\/:*?"<>|]+/g, '_');
    const full = path.join(dir, safe + ext);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, buf);
    return { ok: true, path: full, bytes: buf.length };
  } catch (e) {
    return normalizeError(e, { stage: 'download' });
  } finally {
    clearTimeout(timer);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 资产索引 —— `{产物目录}/.index.json`
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要：产物落在用户的「视频设计」目录里，但目录里只有一堆 wanx-<时间戳>.mp4，
 * 找不到「这条是哪个 prompt 出的、用了哪几张参考图」。索引把这条线索留下来。
 *
 * ⚠️ 这个 json 写在**用户的产物目录**里，因此三种人为破坏都必须扛住：
 *   ① 手动编辑成非法 JSON（记事本另存、写了一半断电）⇒ 读要 try/catch，页面不能打不开；
 *   ② 手动删了某个产物文件 ⇒ **列表里仍然保留这条记录**（`missing:true`），
 *      索引记录更不删 —— 用户也许只是把它移到了别处，删了就再也找不回这条了。
 *      （2026-10-24 修正：旧实现在 listAssets 里用 existsSync 过滤掉，
 *        结果"文件被挪走"直接变成"我生成的东西没了"，正是老板抱怨的那一句。）
 *   ③ 文件根本不存在（第一次用）⇒ 当空列表，不是错误。
 * ════════════════════════════════════════════════════════════════════════════ */

const INDEX_FILENAME = '.index.json';

function indexPathOf(mediaDir) {
  return path.join(String(mediaDir || ''), INDEX_FILENAME);
}

/** ts 取值统一成毫秒数（索引里存 ISO 字符串，但老数据可能是数字，两种都认）。 */
function tsValue(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const t = Date.parse(String(ts || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 读索引。**任何异常都不向上抛**。
 * @returns {{ok:true, items:Array} | {ok:false, items:Array, error:string}}
 */
function readAssetIndex(mediaDir) {
  const p = indexPathOf(mediaDir);
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, items: [] }; // 还没生成过：不是错误
    return { ok: false, items: [], error: '资产索引读取失败：' + ((e && e.message) || e) };
  }
  let obj = null;
  try { obj = JSON.parse(raw); }
  catch { return { ok: false, items: [], error: '资产索引文件已损坏（不是合法 JSON），本次按空列表处理；原文件未删除' }; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) {
    return { ok: false, items: [], error: '资产索引结构异常（缺少 items 数组），本次按空列表处理；原文件未删除' };
  }
  return { ok: true, items: obj.items.filter((x) => x && typeof x === 'object') };
}

/**
 * 追加一条资产记录（`wanx:save` 落地成功后调用）。
 *
 * 索引损坏时的处置：**先把坏文件改名备份成 `.index.corrupt-<ts>.json`，再写新文件**。
 * 直接覆盖会把用户的全部历史静默清掉；而「因为文件坏了就永远不再写入」会让功能彻底死掉。
 *
 * @param {string} mediaDir 产物目录（= 前端看到的「存到哪儿」）
 * @param {object} patch {kind, localPath, bytes, prompt?, params?, taskId?, mediaKinds?}
 * @returns {{ok:true, asset:object} | {ok:false, error:string}}
 */
function appendAsset(mediaDir, patch) {
  const dir = String(mediaDir || '');
  if (!dir) return { ok: false, error: '缺少资产目录' };
  const a = patch && typeof patch === 'object' ? patch : {};
  const asset = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    kind: a.kind === 'video' ? 'video' : 'image',
    localPath: String(a.localPath || ''),
    bytes: Number(a.bytes) || 0,
    ts: new Date().toISOString(),
    prompt: String(a.prompt || '').slice(0, 200),
  };
  if (a.params && typeof a.params === 'object') asset.params = a.params;
  if (a.taskId) asset.taskId = String(a.taskId);
  if (Array.isArray(a.mediaKinds) && a.mediaKinds.length) asset.mediaKinds = a.mediaKinds.map(String);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const cur = readAssetIndex(dir);
    let items = cur.items;
    if (!cur.ok) {
      try { fs.renameSync(indexPathOf(dir), indexPathOf(dir) + '.corrupt-' + Date.now()); }
      catch { /* 备份失败也不能挡住这次写入 */ }
      items = [];
    }
    items.push(asset);
    fs.writeFileSync(indexPathOf(dir), JSON.stringify({ version: 1, items }, null, 2), 'utf8');
    return { ok: true, asset };
  } catch (e) {
    return { ok: false, error: '写入资产索引失败：' + ((e && e.message) || e) };
  }
}

/** 目录扫描认的媒体后缀 → kind（`{kind:'image'}` / `{kind:'video'}`）。 */
const SCAN_EXT_KIND = {
  '.mp4': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.gif': 'image',
};

/**
 * 路径比较用的归一化（只用于「这条索引记录 vs 目录里那个文件是不是同一个」）。
 * Windows 路径大小写不敏感、分隔符两种都有人写，不归一化就会把同一个文件算成两条。
 *
 * @param {string} p 任意路径
 * @returns {string} 归一化后的小写正斜杠路径
 */
function normPathKey(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .trim()
    .toLowerCase();
}

/**
 * 列出最近 N 条资产（按 ts 倒序，默认 50）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【2026-10-24 行为变更 —— 老板原话「之前生的图可以看到 并不是再次打开后就没有了」】
 *
 * 旧实现在这里做了两件会把用户历史**吃掉**的事：
 *   ① `.filter((it) => fs.existsSync(it.localPath))` —— 文件一旦被移动 / 改名 /
 *      清理磁盘，**整条记录从列表里消失**。用户看到的是「我之前生成的东西没了」，
 *      而页面既不说原因、也没法补救（索引里那条明明还在，是我们自己把它藏了）。
 *      这正是老板抱怨的那句话。⇒ 现在**保留条目**并标 `missing:true`，
 *      由前端显示「文件不在（可能被移动或删除）」+ 原路径，人能自己去找回来。
 *   ② 只认索引 ⇒ **索引里没有的文件等于不存在**。
 *      实测证据（2026-10-24 本机）：`~/douya-claw-workspace/视频设计/` 里有
 *      `e2e-1792565175595.mp4`（10-21 14:46）与 `image-...png`（10-24 16:46）两个文件，
 *      而 `.index.json` 只有 image 那一条 —— 视频文件好好的躺在目录里，
 *      作品库里**根本不存在**（索引功能 10-21 才随 da466cb 引入，更早的产物没记录）。
 *      ⇒ 现在索引 + 目录**双源合并**：目录里能认出来的媒体文件，
 *      索引里没有也要补一条（`fromDir:true`，ts 取 mtime）。
 *      这样"文件还在"就一定看得见，与"有没有写过索引"解耦。
 *
 * 读索引失败（损坏 / 结构异常）时依然 `ok:true` + `error` 说明，**不抛**：
 * 页面必须能开。此时目录扫描还会兜回一部分历史，比"空列表 + 一句损坏"有用得多。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * @param {string} mediaDir 产物目录
 * @param {number} [limit] 最多返回多少条（1~500，默认 50）
 * @returns {{ok: true, dir: string, items: Array<object>, missingCount: number,
 *   indexCount: number, fileCount: number, total: number, error?: string}}
 *   · `missingCount` —— 列表里「有记录但本机文件不在」的条数（前端要如实说出来）
 *   · `indexCount` / `fileCount` —— 索引条数 / 目录扫描补充的条数（排障用）
 *   · `total` —— 合并去重后的总条数（未截断前），前端说「共 N 件」用它
 */
function listAssets(mediaDir, limit) {
  const dir = String(mediaDir || '');
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const r = readAssetIndex(dir);
  const merged = [];
  const seen = new Set();
  let missingCount = 0;

  // ① 索引里的记录：**一条都不丢**
  r.items.forEach((it) => {
    const localPath = String(it.localPath || '');
    const key = normPathKey(localPath);
    if (key) {
      if (seen.has(key)) return; // 同一条被写了两次（历史上重复 append）：只留第一条
      seen.add(key);
    }
    let exists = false;
    if (localPath) {
      try { exists = fs.existsSync(localPath); } catch { exists = false; }
    }
    if (!exists) missingCount += 1;
    merged.push(Object.assign({}, it, { localPath, missing: !exists }));
  });
  const indexCount = merged.length;

  // ② 目录里的文件：索引没记的补一条（「文件还在就必须看得见」）
  let fileCount = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; } // 目录还不存在：不是错误
  names.forEach((name) => {
    const kind = SCAN_EXT_KIND[path.extname(name).toLowerCase()];
    if (!kind) return; // 索引文件、.corrupt 备份、用户自己放的 txt 一律不认
    if (name.charAt(0) === '.') return; // 隐藏文件 / .index.json
    const full = path.join(dir, name);
    const key = normPathKey(full);
    if (seen.has(key)) return; // 索引里已经有了
    let st = null;
    try { st = fs.statSync(full); } catch { st = null; }
    if (!st || !st.isFile()) return;
    seen.add(key);
    const ts = Number.isFinite(st.mtimeMs) ? new Date(st.mtimeMs).toISOString() : '';
    merged.push({
      id: 'file-' + normPathKey(name),
      kind,
      localPath: full,
      bytes: Number(st.size) || 0,
      ts,
      prompt: '',
      fromDir: true, // 告诉前端：这条是目录里捡回来的，没有 prompt / params
      missing: false,
    });
    fileCount += 1;
  });

  // ③ 倒序 + 截断。missingCount / total 说的是**全量**，不受 limit 影响。
  merged.sort((x, y) => tsValue(y.ts) - tsValue(x.ts));
  const out = {
    ok: true,
    dir,
    items: merged.slice(0, n),
    missingCount,
    indexCount,
    fileCount,
    total: merged.length,
  };
  if (!r.ok) out.error = r.error;
  return out;
}

/** 面向前端的「能力/配置」自检：有 key 没 key、模型名、可选参数、额度。 */
function status(dataDir, mediaDir) {
  const { key, from } = resolveKey(dataDir);
  const prefs = readPrefs(dataDir);
  return {
    ok: true,
    hasKey: !!key,
    keyFrom: from,
    masked: maskKey(key),
    base: WANX_BASE,
    videoModel: DEFAULT_VIDEO_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
    options: {
      resolutions: VIDEO_RESOLUTIONS,
      ratios: VIDEO_RATIOS,
      durations: VIDEO_DURATIONS,
    },
    /**
     * 产物落盘目录（绝对路径）。前端要把「存到哪儿」显示出来 ——
     * 用户找不到文件时第一句话就是「存哪了」，不给路径等于让他自己翻磁盘。
     * 由调用方传入（主进程的 wanxMediaDir()），本模块不自己拼工作区路径。
     */
    mediaDir: String(mediaDir || ''),
    /** 素材上限，前端做「最多加 10 张」这类前置提示时直接读这里，别各写一份。 */
    limits: {
      video: {
        maxRefImages: VIDEO_MEDIA_MAX.reference_image,
        maxRefVideos: VIDEO_MEDIA_MAX.reference_video,
        maxRefAudio: VIDEO_MEDIA_MAX.reference_audio,
      },
      image: { maxRefImages: MAX_EDIT_IMAGES },
    },
    /**
     * 计费口径元信息 —— 界面必须把它显示出来，否则用户看到「480P 0.3 元」
     * 会以为一条视频 3 毛（实际是按秒，5 秒 = 1.5 元）。
     */
    pricing: {
      video: {
        unit: 'per_second',
        unitLabel: '元/秒',
        note: '按成功生成的视频秒数计费，失败不计费',
        source: 'help.aliyun.com/zh/model-studio/wan3-0-video',
      },
      image: {
        unit: 'per_image',
        unitLabel: '元/张',
        outputTier: '2K',
        note: '按成功生成的张数计费（另加输入 0.024 元/张），本模型实测输出 2K',
        source: 'help.aliyun.com/zh/pai/billing-of-pai-model-service',
      },
    },
    budget: budgetSummary(dataDir),
    totalBudget: prefs.totalBudget,
  };
}

module.exports = {
  WANX_BASE,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_IMAGE_MODEL,
  TASK_STATUS,
  VIDEO_RESOLUTIONS,
  VIDEO_RATIOS,
  VIDEO_DURATIONS,
  DEFAULT_TOTAL_BUDGET,
  DEFAULT_PRICES,
  MIME_BY_EXT,
  MEDIA_RULES,
  VIDEO_MEDIA_MAX,
  MAX_EDIT_IMAGES,
  MUTEX_ERROR,
  maskKey,
  resolveKey,
  saveKey,
  readPrefs,
  savePrefs,
  budgetSummary,
  readLedger,
  recordSpend,
  recordAttempt,
  ATTEMPT_STAGES,
  refundIfCharged,
  reconcileUsage,
  estimateVideoCost,
  estimateImageCost,
  fileToDataUrl,
  buildVideoMedia,
  resolveRefImages,
  buildImageContent,
  submitVideo,
  queryTask,
  generateImage,
  downloadMedia,
  readAssetIndex,
  appendAsset,
  listAssets,
  status,
};
