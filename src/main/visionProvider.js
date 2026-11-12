/**
 * visionProvider.js —— 主进程「看图（图像识别）」能力（纯 Node，可单测）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么要有这个模块（背景）
 * ────────────────────────────────────────────────────────────────────────────
 * 在这之前，图片附件只走 OCR（image-ocr 技能）——只能读出图中的**文字**，
 * 读不到**画面**，系统提示还让模型对用户声明自己无法识别画面内容。
 * 本模块让豆芽真的「看」图：把图片编码成 dataURL 发到内网多模态模型，拿回**画面描述**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 实测踩过的坑（2026-09-15，见 scripts/verify/vision-capability-probe.cjs）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 视觉能力因模型而异：deepseek-v4-pro-wb 真能看见（首选）、qwen3.7-plus 能看见（备选）；
 *     glm-5.1 **会无视图片自信瞎编**（给它纯红图它答「透明」）——绝不可用作视觉模型；
 *     deepseek-v4-pro / qwen3.7-max / deepseek-flash 分别存在「静默空答 / 不支持多模态」问题。
 *   · 图片必须是 **dataURL**（`data:image/png;base64,...`）；裸 base64 会 400。
 *   · `max_tokens` 必须给足（≥900）：这是 reasoning 模型，预算会被 reasoning_content 吃掉，
 *     导致 **HTTP 200 但 content 为空**（静默空答陷阱）。本模块固定 VISION_MAX_TOKENS=1400。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 红线（本模块严格遵守）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 不引入任何第三方依赖，只用 Node 内置 fs / AbortController / fetch；
 *   · apiKey **只在主进程**使用，**绝不写进返回值**（返回值里不含任何 key 字段）；
 *   · **诚实红线**：HTTP 200 但 content 为空 / 只有 reasoning_content → 一律判 `ok:false`，
 *     绝不允许「没看到却返回 ok:true」——这正是「假看见」事故的根因。
 *   · 顶部**不** require electron；缩放降体积时才函数内 lazy require 且 try/catch 兜底，
 *     Electron 不可用（纯 node 单测）时自动退回原始字节。
 *
 * 为什么单独成模块：backend.js 顶部 require 了 skills/connectors/experts 等重依赖，
 * 在纯 node 单测里仍可 require，但把「看图」逻辑抽出来后能用 createRequire 直接注入假
 * fetch 做**不联网**单测（与 webSearchProviders.js 同一范式）。
 */

const fs = require('fs');
const path = require('path');

/** 扩展名 → MIME 映射（图片专用）。 */
const VISION_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/**
 * 默认视觉模型 = **deepseek-v4-pro-wb**（内网网关的名字；它背后就是 DeepSeek-V4.1-Flash）。
 *
 * 为什么名字看着像 pro 而老板说其实是 flash：内网网关只认这个名字，改名网关就不认，
 * 与 backend.js 的 DEFAULT_MODEL_INTERNAL 是同一条口径（那边有完整说明）。
 * 视觉走的是同一台内网网关，所以必须用同一个名字 —— 不同步会变成
 * 「聊天能回、发图不认」这种半瘫状态。
 *
 * 这里**刻意不做跨模型兜底**：若网关真的不支持图像输入，正确做法是换模型并写清原因，
 * 而不是偷偷退到另一个模型 —— 那会把「这个模型看不见图」伪装成「有时识别不准」，更难查。
 */
const DEFAULT_VISION_MODEL = 'deepseek-v4-pro-wb';
/** 视觉请求 max_tokens：必须 ≥900（reasoning 会吃掉预算 → 静默空答），固定 1400。 */
const VISION_MAX_TOKENS = 1400;
/** 默认超时（毫秒）：推理模型带图很慢，给足 150s（与探针一致）。 */
const VISION_TIMEOUT_MS = 150000;

/** 图片硬上限：超过直接拒绝（20MB）。 */
const HARD_MAX_BYTES = 20 * 1024 * 1024;
/** 内联上限：不超过此值直接原样转 dataURL（实测通过的量级 2.5MB）。 */
const INLINE_MAX_BYTES = 2.5 * 1024 * 1024;
/** 大图缩放后的最长边（像素）。 */
const DEFAULT_MAX_EDGE = 1600;
/** 缩放后 JPEG 质量。 */
const JPEG_QUALITY = 82;

/**
 * 视觉识别提示词：要求模型**只描述真实看到的内容**，看不清就说看不清。
 * 注意：措辞里刻意不出现「联网」等字样，避免诱导模型走检索。
 */
const VISION_PROMPT = [
  '你是一名严谨的图像识别助手。请**只描述你真实看到的内容**，不要脑补、不要猜测、不要编造。',
  '',
  '请按下面的顺序，用中文客观描述这张图片：',
  '1. 整体是什么：一句话说明这张图是什么（照片 / 截图 / 海报 / 表格 / 聊天记录 / 设计稿等）。',
  '2. 主体与数量：画面里有哪些主要对象、各有多少个，以及它们的相对位置关系。',
  '3. 布局结构：画面如何分块/分栏，重要元素分别在上/下/左/右哪个位置。',
  '4. 颜色与配色：主色调、背景色、强调色分别是什么。',
  '5. 图中可读的文字：把能看清的文字**原样抄写出来**（不翻译、不改写、不补全）；看不清的字用「□」代替。',
  '6. 细节与异常：值得注意的细节、被遮挡或模糊的地方、任何异常点。',
  '',
  '要求：',
  '- 只依据图片本身作答，不要引入图片之外的信息，也不要凭记忆补充。',
  '- 如果某个部分确实看不清，就明确写「看不清」，**不要根据常识猜测**。',
  '- 不要编造图中不存在的人、物、文字或数字。',
].join('\n');

/**
 * 判断扩展名是否为受支持的图片类型（容错：允许不带点、大小写不一）。
 * @param {unknown} ext
 * @returns {boolean}
 */
function isImageExt(ext) {
  if (typeof ext !== 'string') return false;
  let e = ext.trim().toLowerCase();
  if (!e) return false;
  if (e[0] !== '.') e = '.' + e;
  return Object.prototype.hasOwnProperty.call(VISION_MIME, e);
}

/**
 * 把二进制 buffer 编码成 dataURL。
 * @param {Buffer|Uint8Array} buffer
 * @param {string} mime
 * @returns {string} `data:<mime>;base64,<...>`
 */
function toDataUrl(buffer, mime) {
  const m = String(mime || 'image/png');
  return 'data:' + m + ';base64,' + Buffer.from(buffer).toString('base64');
}

/**
 * 从扩展名推断 MIME（未知扩展名兜底 image/png）。
 * @param {string} filePath
 * @returns {string}
 */
function mimeFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return VISION_MIME[ext] || 'image/png';
}

/**
 * 读取本地图片 → dataURL（**同步**）。
 *
 * 策略：
 *   · 文件不存在 / 非文件 / 读失败 → `{ok:false, error}`；
 *   · 原始字节 > 20MB → 直接拒绝（提示压缩）；
 *   · 原始字节 ≤ 2.5MB → 原样转 dataURL（实测可用量级）；
 *   · 原始字节 > 2.5MB → 尝试用 electron nativeImage 缩放 + 转 JPEG 降体积；
 *     若 electron 不可用或解码失败，**退回原始字节**，绝不抛错。
 *
 * @param {string} filePath
 * @param {{maxEdge?:number}} [opts]
 * @returns {{ok:true, dataUrl:string, mime:string, bytes:number} | {ok:false, error:string}}
 */
function readImageAsDataUrl(filePath, opts = {}) {
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { ok: false, error: '未提供图片路径' };
    }
    const p = filePath;
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return { ok: false, error: '图片不存在或无法访问：' + ((e && e.message) || String(e)) };
    }
    if (!st.isFile()) {
      return { ok: false, error: '路径不是文件：' + p };
    }
    if (st.size > HARD_MAX_BYTES) {
      return {
        ok: false,
        error: '图片过大（' + (st.size / (1024 * 1024)).toFixed(1) + 'MB），请压缩后再发',
      };
    }
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch (e) {
      return { ok: false, error: '读取图片失败：' + ((e && e.message) || String(e)) };
    }
    const mime = mimeFromPath(p);

    // 小图直接原样内联
    if (buf.length <= INLINE_MAX_BYTES) {
      return { ok: true, dataUrl: toDataUrl(buf, mime), mime, bytes: buf.length };
    }

    // 大图：尝试 electron nativeImage 缩放降体积（函数内 lazy require，失败退回原图）
    try {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromBuffer(buf);
      if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
        const sized = img.getSize();
        const edge = Math.max(sized.width, sized.height) || 1;
        const maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : DEFAULT_MAX_EDGE;
        const scale = Math.min(1, maxEdge / edge);
        let out = img;
        if (scale < 1) {
          const resizeOpts = sized.width >= sized.height
            ? { width: Math.max(1, Math.round(sized.width * scale)) }
            : { height: Math.max(1, Math.round(sized.height * scale)) };
          out = img.resize(resizeOpts);
        }
        const jpg = out.toJPEG(JPEG_QUALITY);
        if (jpg && jpg.length) {
          return { ok: true, dataUrl: toDataUrl(jpg, 'image/jpeg'), mime: 'image/jpeg', bytes: jpg.length };
        }
      }
    } catch (e) {
      // Electron 不可用（纯 node 单测）/ 解码失败 → 退回原始字节
    }
    return { ok: true, dataUrl: toDataUrl(buf, mime), mime, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 读取响应体文本（兼容 `.text()` 与只用 `.json()` 的桩实现）。
 * @param {object} res
 * @returns {Promise<string>}
 */
async function readBodyText(res) {
  try {
    if (res && typeof res.text === 'function') {
      const t = await res.text();
      if (t != null) return String(t);
    }
  } catch (e) {
    // text() 抛错 → 尝试 json()
  }
  try {
    if (res && typeof res.json === 'function') {
      return JSON.stringify(await res.json());
    }
  } catch (e) {
    return '';
  }
  return '';
}

/**
 * 带超时的 fetch：AbortController 负责真正中断网络，Promise.race 负责兜底
 * （即使注入的 fetch 不理会 signal，也不会把调用方挂死）。
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {object} opts
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(fetchImpl, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const req = Promise.resolve().then(() => fetchImpl(url, { ...opts, signal: ctrl.signal }));
  // 超时先返回时，真正的 fetch 之后可能仍以 AbortError 拒绝 → 提前吞掉，避免 unhandledRejection
  req.catch(() => {});
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try { ctrl.abort(); } catch { /* 注入实现可能无 abort */ }
      reject(new Error('视觉识别超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
  return Promise.race([req, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 让视觉模型描述一张图片（OpenAI 兼容 /chat/completions）。
 *
 * @param {object} p
 * @param {string} p.dataUrl       图片 dataURL（必须 `data:image/...;base64,...`）
 * @param {object} [p.cfg]         配置：{ baseURL, apiKey, visionModel }
 * @param {Function} [p.fetchImpl] 可注入的 fetch（默认全局 fetch；单测注入假实现）
 * @param {number} [p.timeoutMs]   单次请求超时，默认 VISION_TIMEOUT_MS
 * @param {string} [p.model]       覆盖模型（优先于 cfg.visionModel）
 * @param {string} [p.prompt]      覆盖提示词
 * @returns {Promise<{ok:boolean, text:string, model:string, ms:number, status:number, error:string}>}
 */
async function describeImage({ dataUrl, cfg, fetchImpl, timeoutMs, model, prompt } = {}) {
  // ms 字段在无返回值时也要有：放在 try 外层，异常也能量到耗时
  const cfgObj = cfg || {};
  const baseURL = String(cfgObj.baseURL || 'http://192.168.80.99:10003/v1').replace(/\/+$/, '');
  const apiKey = cfgObj.apiKey || '';
  const useModel = model || cfgObj.visionModel || DEFAULT_VISION_MODEL;
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : VISION_TIMEOUT_MS;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const url = baseURL + '/chat/completions';

  const headers = { 'Content-Type': 'application/json' };
  // 内网网关 apiKey 为空时不发 Authorization（与 backend.authHeaders 同口径）
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

  // 防泄漏红线：任何要返回出去的字符串（含上游错误片段）都先剔除 apiKey 原文。
  // 上游正常情况下不会回显 key，但这是「返回值绝不含 apiKey」的硬保证，成本极低。
  const redact = (s) => {
    const out = String(s == null ? '' : s);
    return apiKey ? out.split(apiKey).join('***') : out;
  };

  const body = JSON.stringify({
    model: useModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || VISION_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: VISION_MAX_TOKENS,
    temperature: 0.2,
  });

  const t0 = Date.now();
  let lastErr = '';
  let lastStatus = 0;

  // 超时 / 网络错误 / HTTP 非 2xx 重试 1 次（推理模型带图偶发挂着不回 header）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(doFetch, url, { method: 'POST', headers, body }, ms);
      lastStatus = res ? res.status : 0;
      const raw = await readBodyText(res);
      const snippet = String(raw || '').slice(0, 200);

      if (!res || !res.ok) {
        // HTTP 非 2xx → 失败（重试一次）；错误里带 200 字符原文片段，便于排查
        lastErr = '视觉模型返回 HTTP ' + (res ? res.status : '无响应') + (snippet ? '：' + snippet : '');
        continue;
      }

      let j = null;
      try {
        j = JSON.parse(raw);
      } catch (e) {
        return {
          ok: false, text: '', model: useModel,
          ms: Date.now() - t0, status: lastStatus, error: '视觉模型返回非 JSON',
        };
      }

      const choice = (j && j.choices && j.choices[0]) || {};
      const msg = choice.message || {};
      const content = String(msg.content == null ? '' : msg.content);
      const reasoning = String(msg.reasoning_content == null ? '' : msg.reasoning_content);
      const trimmed = content.trim();

      // ★ 诚实红线：200 但 content 为空 → 一律失败，绝不 ok:true
      if (!trimmed) {
        // 上游实测偶发「200 但只回 reasoning_content、不回 content」（同图复跑即成功，
        // completion_tokens 仅 ~330、远未触顶，故不是预算问题）。这类空答值得重试：
        // 计入 lastErr 后 continue 走下一轮，两轮都空才落下失败。
        // 注意：continue 只影响重试次数，**不影响诚实红线** —— 绝不允许任何一轮空内容变成 ok:true。
        lastErr = reasoning.trim()
          ? '模型只返回了思考过程、没有给出回答'
          : '视觉模型返回空内容（可能是该模型不支持图像输入，或 max_tokens 被思考过程占满）';
        continue;
      }

      return {
        ok: true, text: redact(trimmed), model: useModel,
        ms: Date.now() - t0, status: lastStatus, error: '',
      };
    } catch (e) {
      // 超时 / 网络错误 → 记下原因，重试
      lastErr = (e && e.message) ? e.message : String(e);
    }
  }

  return {
    ok: false, text: '', model: useModel,
    ms: Date.now() - t0, status: lastStatus,
    error: redact(lastErr) || '视觉识别失败',
  };
}

module.exports = {
  VISION_MIME,
  DEFAULT_VISION_MODEL,
  VISION_MAX_TOKENS,
  VISION_TIMEOUT_MS,
  VISION_PROMPT,
  isImageExt,
  toDataUrl,
  readImageAsDataUrl,
  describeImage,
};
