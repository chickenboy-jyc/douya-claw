// file-read: 读取文件内容（文本 → 正文；图片 → 让视觉模型「看一眼并自证」）。
//
// ────────────────────────────────────────────────────────────────────────────
// 为什么本技能要能「看图」（用户报障，2026-02）
// ────────────────────────────────────────────────────────────────────────────
//   用户原话：「agent 功能……根本不能闭环 而且连个桌宠都不会做」
//   具体现象：让它把一张**全身**图抠成透明背景做桌宠形象，交付的图**只剩半身**。
//   而且它自己没发现 —— 因为它**没有能力看自己产出的图**：
//     · 本文件旧实现只有一行 `fs.readFileSync(full, 'utf-8')`，读 .png/.jpg 把二进制
//       当 UTF-8 解码 ⇒ 模型看到的是一堆 `\uFFFD` 问号，它既不知道图长什么样，
//       也不知道自己刚交付的图被裁成了半身；
//     · 而 `src/main/visionProvider.js` 早就有完整的「看图」能力（readImageAsDataUrl +
//       describeImage），主进程也早就在用它 —— 只是这条技能没接上。
//   ⇒ 本文件补的就是这一条：读图片时走视觉通道，拿到**画面描述**，
//     并让模型回答「主体是否完整 / 背景是否透明 / 有没有被裁切」这些**验收必需**的问题。
//
// ────────────────────────────────────────────────────────────────────────────
// 技能怎么拿到视觉配置（cfg）—— 已核实的真实情况，别再猜
// ────────────────────────────────────────────────────────────────────────────
//   技能的调用形态是 `runner(params, ctx)`（见 src/main/skills.js:403）。
//   那个 `ctx` 里**没有** baseURL / apiKey / visionModel —— 它只带
//   `allowNetwork / shop / geo / wx / signal / timeoutMs`（skills.js:384-401）。
//   所以本文件自己按「设置里存的东西存在哪」去取配置，取值顺序：
//     ① `ctx.vision` / `ctx.llm`（若将来 skills.js 真的注入了，自动生效，无需再改本文件）
//     ② `~/.douya-claw/config.json`（backend.defaultConfig 读的同一个文件；
//        `DOUYA_DATA_DIR` 可覆盖目录，供单测/多实例用）
//     ③ 环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_VISION_MODEL（backend 的第一优先级）
//     ④ 全都没有 ⇒ 传空 cfg，由 visionProvider 用内网网关默认值兜底
//
// ────────────────────────────────────────────────────────────────────────────
// 诚实红线（继承自 src/main/visionProvider.js，不许放宽）
// ────────────────────────────────────────────────────────────────────────────
//   · describeImage 返回 `ok:false`（含「HTTP 200 但 content 为空」这种静默空答）
//     ⇒ 本技能**必须**明说「视觉识别失败 … 我看不到这张图，不能凭猜测判断」，
//     **绝不**静默退化成空串，**绝不**假装看见了，**绝不**替这张图编一段描述。
//     失败文案**以「视觉识别失败：」开头**：这样上游 isFailureResult（只看开头前缀）
//     仍判为失败，不会把「没看见」记成一次成功调用。
//   · 返回值里**绝不**出现 apiKey（本文件不拼任何凭证，只把它交给 describeImage 发请求）。
//
// ────────────────────────────────────────────────────────────────────────────
// 非图片文件：行为**一字不变**（有回归断言，见 scripts/smoke/unit-see-own-output.mjs §4）
// ────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');

/**
 * 反控开关（**只给门禁/排查用**）：设 `SEE_OWN_ANTI=1` ⇒ 强行退回「把二进制当文本读」的
 * 旧行为，用来证明门禁里那条「不许吐 \uFFFD」的断言真的能分辨好坏（否则它可能恒绿）。
 */
const ANTI_TEXT_ONLY = process.env.SEE_OWN_ANTI === '1';

/**
 * 单次视觉请求超时（毫秒）。describeImage 内部最多重试 1 次 ⇒ 最坏 2 × 60s = 120s，
 * 仍小于 manifest 里声明的 timeoutMs（150s），所以技能不会在自身超时前被宿主的
 * 技能超时保护掐断（那条文案是「技能执行超过 N 秒未返回」，会掩盖真实原因）。
 */
const VISION_REQUEST_TIMEOUT_MS = 60000;

/** visionProvider 不可用时的扩展名兜底（宁可判成图片并诚实报错，也不把它当文本吐乱码）。 */
const IMAGE_EXT_FALLBACK = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'];

/**
 * 自证导向的视觉提示词 —— 问的不是「这图好看吗」，而是「能不能交付」。
 * 四个问题与用户这次的报障一一对应：主体是什么 / 主体完整吗（是不是只剩半身）/
 * 背景真透明吗 / 有没有异常（空白、报错文字、抠图残影毛边）。
 */
const SEE_OWN_PROMPT = [
  '你是一位严格的图像质检员。你的任务不是夸这张图好看，而是判断它**能不能直接交付**。',
  '请**只依据这张图本身**作答：不要脑补、不要猜测、不要编造，看不清就写「看不清」。',
  '',
  '必须逐条回答下面四个问题，每条都要给出明确结论：',
  'a) 主体：画面主体是什么？（一句话说清：人／动物／物品／文字海报／截图／纯空白等，以及数量。）',
  'b) 完整性：主体是否**完整**？有没有被画布边缘切掉、是不是只剩一部分'
    + '（例如只有上半身／半身／缺头缺脚／缺一半）？'
    + '判断方法：看主体与画布四条边的交界处是不是被硬切断。'
    + '结论只写「完整」或「不完整（写明被切掉的是什么）」。',
  'c) 背景：背景是否透明？三选一回答：「真透明背景」／「纯白底」／「有底色（写出大致颜色）」。'
    + '注意：白色不等于透明，看不出透明通道就直说看不出。',
  'd) 异常：画面是否异常？逐项检查：是否空白或全黑、是否有报错文字或多余水印、'
    + '是否有明显残影／毛边／抠图残留（例如主体边缘一圈没清干净的底色）。',
  '',
  '输出格式（照抄这四个标题，不要加别的内容、不要写前言后语）：',
  '主体：…',
  '完整性：…',
  '背景：…',
  '异常：…',
  '',
  '纪律：任何一项你确实无法从图里判断，就写「看不清／无法判断」，'
    + '**绝不允许**用常识替它补一个答案 —— 一次「猜对了」不值得，一次「猜错了」会让下游把半成品当成品交付。',
].join('\n');

/**
 * 可注入的视觉实现（**单测/门禁专用**）：签名与 visionProvider.describeImage 同形，
 * 返回 `{ok, text, error}`。为 null 时走真实的 describeImage。
 * 选「显式注入钩子」而不是「require 缓存替换」的理由：缓存替换要求门禁在 require
 * 本文件**之前**先把 visionProvider 塞进 require.cache，顺序一错就静默走真网络；
 * 而注入钩子是本文件自己的一条明确分支，门禁还能顺带断言「传下去的 prompt 到底是不是自证那版」。
 * @type {null | ((p:{dataUrl:string,cfg:object,prompt:string,model:string})=>Promise<{ok:boolean,text?:string,error?:string}>)}
 */
let visionImplOverride = null;

/** 惰性加载主进程的视觉模块（加载失败**不抛**，由调用方转成诚实失败文案）。 */
function loadVisionModule() {
  try {
    // 与 skills/shell-exec/run.js require('../../src/shared/pythonRuntime') 同一条通路：
    // 仓库布局 <repo>/skills/file-read/../../src/main/visionProvider.js = <repo>/src/main/...
    return require('../../src/main/visionProvider.js');
  } catch (e) {
    return null;
  }
}

/**
 * 判断扩展名是不是受支持的图片。
 * 主路径用 visionProvider.isImageExt（唯一真源）；模块加载失败时用本文件的兜底清单。
 * @param {string} ext 含点扩展名（大小写不限）
 * @returns {boolean}
 */
function isImagePath(ext) {
  const v = loadVisionModule();
  if (v && typeof v.isImageExt === 'function') {
    try {
      return v.isImageExt(ext) === true;
    } catch (e) {
      // 掉进兜底
    }
  }
  return IMAGE_EXT_FALLBACK.indexOf(String(ext || '').toLowerCase()) >= 0;
}

/**
 * 读本机设置里的 config.json（与 backend.defaultConfig 同一个文件）。
 * 读不到/坏 JSON 一律返回空对象 —— 读配置失败绝不能连累「这个文件根本读不出来」。
 * @returns {object}
 */
function readConfigFile() {
  try {
    const dir = process.env.DOUYA_DATA_DIR
      ? String(process.env.DOUYA_DATA_DIR)
      : path.join(os.homedir(), '.douya-claw');
    const f = path.join(dir, 'config.json');
    if (!fs.existsSync(f)) return {};
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

/**
 * 解析视觉配置。顺序：ctx 注入 > config.json > 环境变量 > （空，由 provider 兜底）。
 * @param {object} [ctx] 技能第二参数（skills.js 注入的受限能力集）
 * @returns {{baseURL:string, apiKey:string, visionModel:string}}
 */
function resolveVisionCfg(ctx) {
  const out = { baseURL: '', apiKey: '', visionModel: '' };
  const injected = (ctx && (ctx.vision || ctx.llm)) || null;
  if (injected && typeof injected === 'object') {
    if (injected.baseURL) out.baseURL = String(injected.baseURL);
    if (injected.apiKey) out.apiKey = String(injected.apiKey);
    if (injected.visionModel) out.visionModel = String(injected.visionModel);
    else if (injected.model) out.visionModel = String(injected.model);
  }
  const j = readConfigFile();
  if (!out.baseURL) out.baseURL = String(j.baseURL || process.env.LLM_BASE_URL || '');
  if (!out.apiKey) out.apiKey = String(j.apiKey || process.env.LLM_API_KEY || '');
  if (!out.visionModel) out.visionModel = String(j.visionModel || process.env.LLM_VISION_MODEL || '');
  return out;
}

/**
 * 调视觉模型描述一张图（可被单测注入）。
 * @param {{dataUrl:string, cfg:object}} p
 * @returns {Promise<{ok:boolean, text:string, error:string}>}
 */
async function describeWithVision(p) {
  const payload = {
    dataUrl: p.dataUrl,
    cfg: p.cfg || {},
    prompt: SEE_OWN_PROMPT,
    model: (p.cfg && p.cfg.visionModel) || '',
  };
  let raw;
  try {
    if (typeof visionImplOverride === 'function') {
      raw = await visionImplOverride(payload);
    } else {
      const v = loadVisionModule();
      if (!v || typeof v.describeImage !== 'function') {
        return {
          ok: false,
          text: '',
          error: '视觉模块 src/main/visionProvider.js 不可用（describeImage 缺失）',
        };
      }
      raw = await v.describeImage({
        dataUrl: payload.dataUrl,
        cfg: payload.cfg,
        prompt: payload.prompt,
        timeoutMs: VISION_REQUEST_TIMEOUT_MS,
      });
    }
  } catch (e) {
    // 视觉层抛错（含超时/网络异常）也一律翻译成「诚实失败」，绝不冒泡成一条看不出原因的异常
    return { ok: false, text: '', error: (e && e.message) ? String(e.message) : String(e) };
  }
  const okFlag = !!(raw && raw.ok === true);
  const text = String((raw && raw.text) || '');
  const error = String((raw && raw.error) || '');
  // 诚实红线（第二道闸）：即使注入实现谎报 ok:true，只要 text 是空的也一律按失败处理。
  if (!okFlag || !text.trim()) {
    return { ok: false, text: '', error: error || '视觉模型没有返回任何描述（空答）' };
  }
  return { ok: true, text: text.trim(), error: '' };
}

/**
 * 从图片字节里读出宽高（**纯客观读数，不问模型**）。
 * 只解析文件头，不解码像素；认不出来就返回 null（诚实写「尺寸未知」，绝不猜）。
 * 支持 PNG / JPEG / GIF / BMP / WEBP（覆盖 visionProvider.VISION_MIME 的绝大多数）。
 * @param {Buffer} buf
 * @returns {{width:number, height:number}|null}
 */
function readImageSize(buf) {
  try {
    if (!buf || buf.length < 16) return null;

    // PNG：8 字节签名 + IHDR（宽高各 4 字节大端，位于 16/20）
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }

    // GIF：GIF87a / GIF89a，宽高各 2 字节小端
    if (buf.length >= 10 && buf.toString('ascii', 0, 4).indexOf('GIF8') === 0) {
      const w = buf.readUInt16LE(6);
      const h = buf.readUInt16LE(8);
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }

    // BMP：'BM' + DIB 头（宽 int32@18 / 高 int32@22，高可能为负）
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      const w = Math.abs(buf.readInt32LE(18));
      const h = Math.abs(buf.readInt32LE(22));
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }

    // JPEG：从 SOI 起逐段扫，遇到 SOFn 就取高/宽
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xff) { i += 1; continue; }
        // 无长度字段的标记：SOI / TEM / RSTn
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        const isSof = (marker >= 0xc0 && marker <= 0xc3)
          || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb)
          || (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          return w > 0 && h > 0 ? { width: w, height: h } : null;
        }
        i += 2 + len;
      }
      return null;
    }

    // WEBP：RIFF....WEBP + VP8 / VP8L / VP8X 三种块头各有一套编码
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') {
        const w = 1 + buf.readUIntLE(24, 3);
        const h = 1 + buf.readUIntLE(27, 3);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      if (fmt === 'VP8 ') {
        if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      if (fmt === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        const w = 1 + (bits & 0x3fff);
        const h = 1 + ((bits >> 14) & 0x3fff);
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      return null;
    }

    return null;
  } catch (e) {
    // 任何越界读都只意味着「这个头我认不出来」，绝不让读图失败在这里变成抛错
    return null;
  }
}

/**
 * 字节数 → 人可读。
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' 字节';
  return (n / 1024).toFixed(1) + ' KB';
}

/**
 * 尺寸 → `W × H` 或 `尺寸未知`（认不出来就直说，不猜）。
 * @param {{width:number,height:number}|null} size
 * @returns {string}
 */
function formatDims(size) {
  return size && size.width > 0 && size.height > 0 ? size.width + ' × ' + size.height : '尺寸未知';
}

/** 读文件头多少个字节（够解析所有受支持格式的宽高；不把整张大图读进内存）。 */
const HEAD_BYTES = 262144;

/**
 * 只读文件**头部**若干字节（用于解析宽高）。整张图随后由 visionProvider 读，不重复读全量。
 * @param {string} full
 * @param {number} [n]
 * @returns {Buffer|null}
 */
function readHead(full, n) {
  const want = Number(n) > 0 ? Number(n) : HEAD_BYTES;
  let fd = null;
  try {
    fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(want);
    const got = fs.readSync(fd, buf, 0, want, 0);
    return buf.slice(0, got);
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 关不掉也不影响读数 */ } }
  }
}

/**
 * 读图片：走视觉通道拿画面描述（诚实红线在这里落地）。
 * @param {string} shown   给模型看的原始路径（绝对/相对，原样回显）
 * @param {string} full    磁盘绝对路径
 * @param {object} ctx     技能第二参数
 * @returns {Promise<string>}
 */
async function readImage(shown, full, ctx) {
  const v = loadVisionModule();
  let bytes = 0;
  try {
    bytes = fs.statSync(full).size;
  } catch (e) {
    bytes = 0;
  }
  let size = null;
  try {
    size = readImageSize(readHead(full));
  } catch (e) {
    size = null;
  }
  const head = '图片 ' + shown + '（' + formatDims(size) + ' / ' + formatSize(bytes) + '）';

  if (!v || typeof v.readImageAsDataUrl !== 'function') {
    return [
      '视觉识别失败：视觉模块 src/main/visionProvider.js 不可用（readImageAsDataUrl 缺失）',
      head,
      '我看不到这张图，不能凭猜测判断它的画面内容，也不会替它编一段描述。',
      '可以先用「识别图片」拿到客观读数（尺寸／透明通道／主体包围盒是否贴边）；要真的看画面，需要修复视觉模块。',
    ].join('\n');
  }

  const data = v.readImageAsDataUrl(full);
  if (!data || data.ok !== true || !data.dataUrl) {
    const why = (data && data.error) || '读取图片失败';
    return [
      '视觉识别失败：' + why,
      head,
      '我看不到这张图，不能凭猜测判断它的画面内容，也不会替它编一段描述。',
      '可以先用「识别图片」拿到客观读数（尺寸／透明通道／主体包围盒是否贴边）。',
    ].join('\n');
  }

  const cfg = resolveVisionCfg(ctx);
  const r = await describeWithVision({ dataUrl: data.dataUrl, cfg });
  if (!r.ok) {
    return [
      '视觉识别失败：' + (r.error || '视觉识别失败'),
      head,
      '我看不到这张图，不能凭猜测判断它的画面内容，也不会替它编一段描述。',
      '接下来可以：① 用「识别图片」拿客观读数（尺寸／透明通道／主体包围盒是否贴边）；'
        + '② 把图放进对话让用户自己确认；③ 检查设置里的视觉模型是否可用。'
        + '**不要**在没看到图的情况下断言它是什么样。',
    ].join('\n');
  }

  return head + '画面描述：\n' + r.text;
}

module.exports.run = async function (params, ctx) {
  if (!params || !params.path) return '错误：请提供要读取的文件路径（绝对路径或相对于工作区）';
  const p = String(params.path).trim();
  const full = path.isAbsolute(p) ? p : path.resolve(WORKSPACE, p);
  if (!fs.existsSync(full)) return '错误：文件不存在 — ' + p;
  if (fs.statSync(full).isDirectory()) return '错误：这是一个目录，请用"列文件"查看 — ' + p;

  // 图片分支：走视觉通道（SEE_OWN_ANTI=1 时强行退回旧的 utf-8 直读，供反控使用）
  if (!ANTI_TEXT_ONLY && isImagePath(path.extname(full))) {
    return readImage(p, full, ctx);
  }

  // 非图片：行为与引入图片分支之前**逐字相同**
  const content = fs.readFileSync(full, 'utf-8');
  const lines = content.split('\n').length;
  const size = Buffer.byteLength(content, 'utf-8');
  const head = content.length > 8000 ? content.slice(0, 8000) + '\n…(文件过大，只显示前 8000 字符)' : content;
  return `${p}（${lines} 行 / ${size} 字节）:\n\`\`\`\n${head}\n\`\`\``;
};

/**
 * 注入视觉实现（**仅供门禁/单测**，不联网）。传 null 恢复真实实现。
 * @param {null|Function} fn
 */
module.exports.__setVisionImpl = function (fn) {
  visionImplOverride = typeof fn === 'function' ? fn : null;
};

// 便于单测直接对纯函数求值（不经过 run()，也不碰网络）
module.exports.SEE_OWN_PROMPT = SEE_OWN_PROMPT;
module.exports.isImagePath = isImagePath;
module.exports.readImageSize = readImageSize;
module.exports.resolveVisionCfg = resolveVisionCfg;
module.exports.formatDims = formatDims;
module.exports.formatSize = formatSize;
