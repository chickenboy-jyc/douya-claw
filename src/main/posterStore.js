'use strict';

/**
 * 海报模式的落盘能力（主进程侧）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这个模块（与 `wanx:save` 的分工）
 * ────────────────────────────────────────────────────────────────────────────
 * 视频设计页前两个模式（文字生成 / 图片生成）的产物都是**远端 URL**，主进程能自己下载，
 * 所以 `wanx:save` 是「URL → 本地」。海报模式的画布内容**只存在于渲染层**（canvas 画完
 * 就是一堆像素，没有任何远端地址），主进程拿不到，只能由渲染层把 dataURL 递过来。
 * ⇒ 通道拆成两个：`wanx:save`（URL）与 `poster:export`（dataURL），互不干扰。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么是纯函数模块（不 require('electron')）
 * ────────────────────────────────────────────────────────────────────────────
 * 目录、对话框一律从参数进来。理由不是洁癖：本仓有 140+ 条单测是直接 `require()` 主进程
 * 模块来跑的（`scripts/smoke/unit-*.mjs`），一旦本文件顶层 `require('electron')`，
 * 单测就只能在 Electron 里跑 —— 那条路走不通，结果一定是「没人测，等上线才发现」。
 * ⇒ electron 只在 `registerIpc(deps)` 里被**当作参数接收**，本模块不引用它。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 安全（这几条是硬要求，不是可选优化）
 * ────────────────────────────────────────────────────────────────────────────
 * 1. dataUrl 必须以 `data:image/(png|jpeg);base64,` 开头；
 * 2. **解码后的字节必须真的是图片**（PNG magic / JPEG magic）——
 *    只校验前缀不够：渲染层（或将来某个脚本）传 `data:image/png;base64,<一段文本>` 时，
 *    前缀合法而内容是任意字节，写出去就是一个后缀 `.png` 的可执行体/配置体。
 *    ⇒ magic 校验是这条链上唯一能挡住「换个皮写盘」的关卡。
 * 3. `filename` / `name` 走 `path.basename` + 非法字符净化（路径穿越净化）；
 *    `savePath` 是用户**显式指定**的绝对路径，允许跨目录，但扩展名必须是图片。
 * 4. 单文件 32MB 上限（画布导出 8K PNG 约 10~20MB，32MB 留足余量）。
 * 5. 所有公开函数都不 throw，统一 `{ok:false, error}` —— IPC 层抛异常在渲染侧只会变成
 *    一个看不出原因的 rejected promise。
 *
 * 命名统一用「海报」以外的中性词：本模块只管「图片字节落盘」，不关心画的是什么。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 单文件上限：32MB。 */
const MAX_BYTES = 32 * 1024 * 1024;

/** 只认这两种 dataURL 前缀（`jpg` 不是合法 mime，但有的序列化器会写，宽收一格）。 */
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,/i;

/** PNG 文件头 8 字节。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG 文件头 3 字节（SOI + 第一个段的 FF）。 */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** `savePath` 允许的扩展名（小写，带点）。 */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];

/** `listProjects` 一次最多回多少条 —— 项目列表是「最近用的」，不是「全部归档」。 */
const PROJECT_LIST_MAX = 50;

/** Windows 保留设备名：叫 `con.json` 的文件写不进去，会抛 EPERM，提前改名。 */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// ============================================================================
// 路径工具
// ============================================================================

/**
 * 把「作品目录（或它的 posters 子目录）」归一成 posters 目录的绝对路径。
 *
 * 入参可能是 `<media>/posters`（main.js 传的就是这个），也可能是 `<media>`；
 * 幂等：传 `.../posters` 拿回来的还是 `.../posters`，不会变成 `.../posters/posters`。
 *
 * @param {string} baseDir 作品目录，或 posters 目录本身
 * @returns {string} posters 目录绝对路径
 */
function postersDir(baseDir) {
  const base = path.resolve(String(baseDir || '.'));
  if (path.basename(base).toLowerCase() === 'posters') return base;
  return path.join(base, 'posters');
}

/**
 * `yyyyMMdd-HHmmss` 本地时间戳（默认文件名用）。
 *
 * 为什么不用 ISO：Windows 文件名不允许 `:`，ISO 串必须再转义一次，转义后的样子
 * 反而不如「一眼看出是哪天哪秒」有用。
 *
 * @param {Date} [date] 注入点，便于单测
 * @returns {string}
 */
function stamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/**
 * 单段文件名净化：防路径穿越 + 去掉文件系统非法字符。
 *
 * 顺序有讲究：
 *   ① 先把反斜杠统一成正斜杠再 `basename` —— 在 POSIX 上 `basename('..\\..\\x')` 会
 *      原样返回，等于净化在 Linux/macOS 上直接失效；
 *   ② `basename` 吃掉 `../` / `../..` 前缀，`..` 单独出现时会被 `basename` 返回 `..`，
 *      所以还要把连续点替换掉；
 *   ③ 去掉首尾的点和空白（Windows 不允许以点结尾，且 `.xxx` 语义上是隐藏文件）。
 *
 * @param {*} input 原始名字（任意类型，非字符串一律当空）
 * @param {string} fallback 净化后为空时的兜底
 * @returns {string}
 */
function safeSeg(input, fallback) {
  const raw = typeof input === 'string' ? input : '';
  if (!raw) return fallback;
  let base = path.basename(raw.replace(/\\/g, '/'));
  // 非法字符（含控制字符）一律换成下划线：Windows 上这些字符直接 EINVAL
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  // 连续点（含 '..' 与 '...'）：既是路径穿越语义，也是「藏在后缀里」的常见手法
  base = base.replace(/\.{2,}/g, '_');
  base = base.trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (WIN_RESERVED_RE.test(base.replace(/\.[^.]*$/, ''))) base = '_' + base;
  return base || fallback;
}

/**
 * 扩展名归一：只产出 `'png'` / `'jpg'`，无法识别返回 `''`。
 *
 * @param {*} ext 例如 `'png'` / `'.JPEG'` / `'jpg'`
 * @returns {'png'|'jpg'|''}
 */
function normExt(ext) {
  const v = String(ext == null ? '' : ext).trim().toLowerCase().replace(/^\./, '');
  if (v === 'png') return 'png';
  if (v === 'jpg' || v === 'jpeg') return 'jpg';
  return '';
}

/**
 * `target` 是否在 `dir` 之内（不含 dir 自身）。
 *
 * `path.resolve` 之后再比相对路径：字符串前缀比较会被 `.../posters-evil` 骗过
 * （它以 `.../posters` 开头），`path.relative` 不会。
 *
 * @param {string} dir 目录
 * @param {string} target 待检路径
 * @returns {boolean}
 */
function isInside(dir, target) {
  const d = path.resolve(dir);
  const rel = path.relative(d, path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 同名文件已存在时追加 `-2` / `-3`…（只用于自动命名的场景）。
 *
 * 存在的理由：批量导出同一秒内可能连点两次，同名覆盖会让用户「少了一张图」却看不出来。
 * 用户显式给的 `savePath` 不走这里 —— 那是明确的覆盖意图。
 *
 * @param {string} p 目标路径
 * @returns {string} 不冲突的路径
 */
function dedupe(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  for (let n = 2; n <= 999; n += 1) {
    const cand = path.join(dir, stem + '-' + n + ext);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, stem + '-' + Date.now() + ext);
}

// ============================================================================
// 图片字节：校验 + 宽高解析（不引新依赖）
// ============================================================================

/**
 * 解析图片宽高。拿不到就回 `{width:null, height:null}`，**绝不抛**。
 *
 * PNG：IHDR 固定是第一个 chunk，宽高在文件头偏移 16 / 20 处（大端 uint32）。
 * JPEG：逐段扫描，找 SOF0~SOF15（排除 C4=DHT / C8=JPG / CC=DAC，它们同段号但不是 SOF），
 *       段内布局 `FF Cx | len(2) | precision(1) | height(2) | width(2) | …`。
 *       不装 image-size 之类的依赖：本仓打包体积敏感，而这两个格式的头部解析只有十几行。
 *
 * @param {Buffer} buf 图片字节
 * @param {'png'|'jpeg'} kind 已由 magic 判定过的格式
 * @returns {{width: number|null, height: number|null}}
 */
function imageSize(buf, kind) {
  const none = { width: null, height: null };
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return none;
    if (kind === 'png') {
      // 8 字节签名 + 4 字节长度 + 4 字节类型 + 宽高各 4 字节 = 24
      if (buf.length < 24) return none;
      if (buf.slice(12, 16).toString('latin1') !== 'IHDR') return none;
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (!w || !h) return none;
      return { width: w, height: h };
    }
    // JPEG
    let i = 2; // 跳过 SOI
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      let m = buf[i + 1];
      // 段与段之间允许有 0xFF 填充字节
      while (m === 0xff && i + 2 < buf.length) { i += 1; m = buf[i + 1]; }
      // 无长度的独立标记：TEM(01) / RSTn(D0~D7) / SOI(D8)
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
      // EOI(D9) / SOS(DA)：再往后是熵编码数据，不会再有 SOF
      if (m === 0xd9 || m === 0xda) return none;
      const len = buf.readUInt16BE(i + 2);
      const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSof) {
        if (i + 9 > buf.length) return none;
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        if (!w || !h) return none;
        return { width: w, height: h };
      }
      if (len < 2) return none; // 长度非法：与其死循环，不如放弃
      i += 2 + len;
    }
    return none;
  } catch {
    return none;
  }
}

/**
 * dataURL 的**形状**校验（前缀 + 非空），不碰字节。
 *
 * 单独抽出来的理由：`poster:export` 在「弹保存对话框」之前要先用它截一次 ——
 * 前端递来的东西根本不合法时，不该先让用户挑一个保存位置、挑完再告诉他"保存失败"。
 * 只有一处实现，就不会出现「弹窗前后的校验口径不一样」这种只在某些路径上才暴露的偏差。
 *
 * @param {*} dataUrl 待检输入
 * @returns {{ok:true, m:RegExpExecArray} | {ok:false, error:string}}
 */
function checkDataUrlShape(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    return { ok: false, error: 'dataUrl 为空（需要 data:image/png;base64,... 形式的字符串）' };
  }
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) {
    return { ok: false, error: 'dataUrl 不是受支持的图片格式（只接受 data:image/png;base64, 或 data:image/jpeg;base64,）' };
  }
  return { ok: true, m };
}

/**
 * 解 dataURL 并做**内容**校验（magic）。
 *
 * 为什么先按 base64 长度粗估再解码：32MB 图的 base64 字符串约 43MB，先 `Buffer.from`
 * 一遍纯属白烧内存；粗估能挡下绝大多数「超限」输入，随后的精确长度检查兜底。
 *
 * @param {*} dataUrl 渲染层递过来的字符串
 * @returns {{ok:true, buf:Buffer, kind:'png'|'jpeg', ext:'png'|'jpg', mimeExt:'png'|'jpg'}
 *          | {ok:false, error:string}}
 */
function decodeDataUrl(dataUrl) {
  const shape = checkDataUrlShape(dataUrl);
  if (!shape.ok) return shape;
  const m = shape.m;
  const payload = dataUrl.slice(m[0].length);
  if (!payload) return { ok: false, error: 'dataUrl 的 base64 内容为空' };

  const estimate = Math.floor((payload.length * 3) / 4);
  if (estimate > MAX_BYTES + 4) {
    return { ok: false, error: '图片超过上限 32MB（base64 估算约 ' + (estimate / 1048576).toFixed(1) + 'MB）' };
  }

  let buf;
  try {
    buf = Buffer.from(payload, 'base64');
  } catch (e) {
    return { ok: false, error: 'base64 解码失败：' + ((e && e.message) || '未知错误') };
  }
  if (!buf || !buf.length) return { ok: false, error: 'base64 解码后是 0 字节' };
  if (buf.length > MAX_BYTES) {
    return { ok: false, error: '图片超过上限 32MB（实际 ' + (buf.length / 1048576).toFixed(1) + 'MB）' };
  }

  let kind = '';
  if (buf.length >= PNG_MAGIC.length && buf.slice(0, PNG_MAGIC.length).equals(PNG_MAGIC)) kind = 'png';
  else if (buf.length >= JPEG_MAGIC.length && buf.slice(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) kind = 'jpeg';
  if (!kind) {
    return { ok: false, error: '解码后的字节不是 PNG/JPEG（magic 校验失败）：拒绝把非图片内容写成图片文件' };
  }

  const mimeExt = m[1].toLowerCase() === 'png' ? 'png' : 'jpg';
  return { ok: true, buf, kind, ext: kind === 'png' ? 'png' : 'jpg', mimeExt };
}

// ============================================================================
// 公开能力
// ============================================================================

/**
 * `poster:export` 的落盘实现：把 dataURL 落成磁盘上的图片文件（本体，不含弹窗）。
 *
 * 两条分支（这里**只看 `savePath` 有没有值**，不看别的；「有没有这个键」的判定只在
 * `registerIpc` 一处 —— 同一件事不能有两个真源）：
 *   · `savePath` 有值 ⇒ 直接写该路径，父目录不存在就建。**不弹任何对话框** ——
 *     无人值守自动化（`scripts/smoke` 里的 e2e）必须能走这条，弹窗会把自动化卡死。
 *   · `savePath` 为空 ⇒ 落到 `dir`（海报目录）下自动命名；同名追加 `-2`/`-3`，
 *     所以「导出」连点两次是两张图，不是覆盖。**本函数永远不弹对话框**。
 *     （三档语义里的「键在但空串 = 导出」也走这条 —— 判定在 `registerIpc`，不在这里，
 *      同一件事不能有两个真源。）
 *
 * 扩展名口径：**以字节为准**。`ext` / mime 只用于「默认文件名长什么样」；
 * 若渲染层声明的扩展名与实际字节不符（声明 png、字节是 jpeg），按实际字节取名并回一个
 * `warning` —— 写一个后缀是 .png 的 JPEG，播放器/看图器会打不开，而字节数完全正常，
 * 这是最难查的一类问题（本仓 `wanx:save` 早期就踩过「视频存成 .png」）。
 *
 * @param {{dataUrl?:*, ext?:*, filename?:*, savePath?:*, dir?:string}} [opts]
 * @returns {{ok:true, path:string, bytes:number, sha1:string, width:number|null,
 *            height:number|null, warning?:string} | {ok:false, error:string}}
 */
function writeDataUrl(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  try {
    const dec = decodeDataUrl(o.dataUrl);
    if (!dec.ok) return dec;

    const wanted = normExt(o.ext) || dec.mimeExt;
    const actual = dec.ext;
    let warning = '';
    if (wanted !== actual) {
      warning = '渲染层声明 ' + wanted + '，实际字节是 ' + actual + '（已按实际字节处理）';
    }

    const dir = postersDir(o.dir);
    const rawSave = typeof o.savePath === 'string' ? o.savePath.trim() : '';
    let target = '';
    let explicit = false;

    if (rawSave) {
      const abs = path.resolve(rawSave);
      const e = path.extname(abs).toLowerCase();
      if (!IMAGE_EXTS.includes(e)) {
        return {
          ok: false,
          error: 'savePath 的扩展名必须是 .png / .jpg / .jpeg，收到「'
            + (e || '（无扩展名）') + '」：' + abs,
        };
      }
      target = abs;
      explicit = true;
      if (normExt(e) && normExt(e) !== actual && !warning) {
        warning = 'savePath 声明 ' + normExt(e) + '，实际字节是 ' + actual;
      }
    } else {
      const given = safeSeg(o.filename, '');
      let name = '';
      if (given) {
        name = /\.(png|jpe?g)$/i.test(given) ? given : given + '.' + actual;
      } else {
        name = '海报-' + stamp() + '.' + actual;
      }
      target = path.join(dir, name);
      // 兜底：safeSeg 已经把分隔符吃掉了，这里再按 resolved 路径验一次 ——
      // 净化函数将来被谁改坏，也不至于让写盘目标跑出海报目录。
      if (!isInside(dir, target)) {
        return { ok: false, error: '文件名净化后仍试图越出海报目录，已拒绝：' + String(o.filename) };
      }
    }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (e) {
      return { ok: false, error: '创建目录失败：' + path.dirname(target) + '（' + ((e && e.message) || '') + '）' };
    }
    if (!explicit) target = dedupe(target);

    fs.writeFileSync(target, dec.buf);

    const sha1 = crypto.createHash('sha1').update(dec.buf).digest('hex');
    const size = imageSize(dec.buf, dec.kind);
    const out = {
      ok: true,
      path: target,
      bytes: dec.buf.length,
      sha1,
      width: size.width,
      height: size.height,
    };
    if (warning) out.warning = warning;
    return out;
  } catch (e) {
    return { ok: false, error: (e && e.message) || '保存海报失败' };
  }
}

/**
 * `poster:saveProject` 的实现：项目 JSON 落到 `<posters>/projects/<name>.json`。
 *
 * 为什么不落 `listProjects` 同一个目录：同目录下「工程文件」和「导出的图片」混在一起，
 * 用户按时间找最近那张图时会被一堆 .json 打断；分开放也让「清理导出目录」变得安全。
 *
 * 内容先 `JSON.parse` 一遍再写：写一个坏 JSON 出去，问题会推迟到「下次打开项目」才暴露，
 * 那时现场早没了 —— 宁可这一次失败并把原因说清楚。
 *
 * @param {{json?:*, name?:string, dir?:string}} [opts]
 * @returns {{ok:true, path:string, bytes:number} | {ok:false, error:string}}
 */
function saveProject(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  try {
    let content = '';
    if (typeof o.json === 'string') content = o.json;
    else if (o.json && typeof o.json === 'object') content = JSON.stringify(o.json, null, 2);
    else return { ok: false, error: 'json 为空（需要项目对象或 JSON 字符串）' };
    if (!content) return { ok: false, error: 'json 序列化后为空' };

    try {
      JSON.parse(content);
    } catch (e) {
      return { ok: false, error: 'json 不是合法 JSON：' + ((e && e.message) || '解析失败') };
    }

    const dir = path.join(postersDir(o.dir), 'projects');
    let name = safeSeg(o.name, '');
    if (!name) name = '项目-' + stamp();
    if (!/\.json$/i.test(name)) name += '.json';

    const target = path.join(dir, name);
    if (!isInside(dir, target)) {
      return { ok: false, error: '项目名净化后越界，已拒绝：' + String(o.name) };
    }
    fs.mkdirSync(dir, { recursive: true });
    // 同名覆盖：这是「保存工程」的语义（用户就是要更新那一份），不 dedupe。
    fs.writeFileSync(target, content, 'utf8');
    return { ok: true, path: target, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '保存项目失败' };
  }
}

/**
 * `poster:readProject` 的实现。
 *
 * @param {string|{path?:string}} input 项目文件绝对路径（也接受 `{path}` 形状，宽收一格）
 * @returns {{ok:true, json:*, path:string} | {ok:false, error:string}}
 */
function readProject(input) {
  try {
    const raw = typeof input === 'string'
      ? input
      : (input && typeof input === 'object' && typeof input.path === 'string' ? input.path : '');
    if (!raw) return { ok: false, error: 'path 为空（需要项目文件的绝对路径）' };
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) return { ok: false, error: '项目文件不存在：' + abs };
    const text = fs.readFileSync(abs, 'utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '项目文件不是合法 JSON：' + abs + '（' + ((e && e.message) || '解析失败') + '）' };
    }
    return { ok: true, json, path: abs };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '读取项目失败' };
  }
}

/**
 * `poster:listProjects` 的实现：按 mtime 倒序最多 50 条。
 *
 * `projects` 目录还不存在时返回**空列表而不是错误**：第一次进海报模式就是这个状态，
 * 把它做成错误会让渲染层在正常路径上先显示一条红字。
 *
 * 单个文件 stat 失败（边读边删 / 权限）只跳过该条，不让整张列表变空 ——
 * 列表是「帮用户找回上次的工程」，为一条坏记录把 49 条好记录一起丢掉不值。
 *
 * @param {string} baseDir 作品目录（或 posters 目录本身）
 * @returns {{ok:true, dir:string, items:Array<{name:string,path:string,mtimeMs:number,bytes:number}>}
 *          | {ok:false, dir:string, items:[], error:string}}
 */
function listProjects(baseDir) {
  const dir = path.join(postersDir(baseDir), 'projects');
  try {
    if (!fs.existsSync(dir)) return { ok: true, dir, items: [] };
    const items = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/\.json$/i.test(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      items.push({ name, path: full, mtimeMs: st.mtimeMs, bytes: st.size });
    }
    items.sort((a, b) => (b.mtimeMs - a.mtimeMs) || String(a.name).localeCompare(String(b.name)));
    return { ok: true, dir, items: items.slice(0, PROJECT_LIST_MAX) };
  } catch (e) {
    return { ok: false, dir, items: [], error: (e && e.message) || '读取项目列表失败' };
  }
}

/**
 * 注册四个 IPC 通道（`poster:export` / `poster:saveProject` / `poster:readProject`
 * / `poster:listProjects`）。
 *
 * 依赖全部由调用方（main.js）注入，理由见文件头：单测要能直接 require 本模块，
 * 而 electron 的 `ipcMain` / `dialog` 只有真进程里有。
 *
 * @param {{ipcMain:object, dialog?:object, dir:(()=>string)|string,
 *          mainWindow?:(()=>(object|null))|object}} deps
 * @returns {void}
 */
function registerIpc(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const ipc = d.ipcMain;
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new TypeError('registerIpc(deps) 需要 { ipcMain }（带 handle 方法）');
  }
  const getDir = typeof d.dir === 'function' ? d.dir : () => d.dir;
  const getWindow = typeof d.mainWindow === 'function' ? d.mainWindow : () => d.mainWindow;
  const dlg = d.dialog || null;

  // ---- 1. 导出图片 ----
  // ★ 三档语义，判据是「`savePath` 这个键**在不在**」，**不是**「值非不非空」。
  //
  //   档 1 · `savePath` 是非空字符串 ⇒ 显式绝对路径，无人值守（自动化只走这条）
  //   档 2 · `savePath` 键在、值是空串 ⇒ 界面上的「导出」：落作品目录、自动命名、**不弹窗**
  //   档 3 · 根本没有 `savePath` 键 ⇒ 界面上的「另存为…」：弹系统保存框
  //
  // 为什么必须按「键在不在」判：渲染层（PosterStudio.jsx）已经按这套语义写好了，
  // 空串就是「导出」的显式信号。用「值非空」当判据会把「导出」当成「另存为」——
  // 用户点一下"导出"就弹一个系统保存框，与豆芽一贯做法（生成结果自动落盘 + 给绝对路径
  // + 「打开文件夹」，视频设计页全程不弹框）相反，是一条用户立刻能感觉到的退步。
  // ⇒ 适配渲染层，不要让渲染层改。
  ipc.handle('poster:export', async (_e, args) => {
    try {
      const a = args && typeof args === 'object' ? args : {};
      const hasSaveKey = Object.prototype.hasOwnProperty.call(a, 'savePath');
      const sv = typeof a.savePath === 'string' ? a.savePath.trim() : '';
      const explicitSave = sv.length > 0;

      // 档 1：显式绝对路径 —— 不弹窗、直接写（父目录 mkdir -p 在 writeDataUrl 里）
      if (explicitSave) {
        return writeDataUrl({
          dataUrl: a.dataUrl, ext: a.ext, filename: a.filename, savePath: a.savePath, dir: getDir(),
        });
      }

      // 档 2：键在但为空串 = 界面上的「导出」⇒ 走 writeDataUrl 的**自动命名**分支。
      // 复用它（而不是在这里另拼一个文件名）的理由：「导出」和「另存为」的默认名必须是
      // 同一套实现，否则会出现"对话框里叫 A、自动落盘叫 B"这种只在某条路径上暴露的偏差。
      // 同名文件由 writeDataUrl 追加 -2/-3：连点两次"导出"应该是两张图，不是覆盖。
      if (hasSaveKey) {
        // 形状校验必须放在写盘之前：非法 dataUrl 不该先走完整条写出路径再失败
        // （那会白建目录、白解码，而且错误信息离真正的原因更远）。
        const preAuto = checkDataUrlShape(a.dataUrl);
        if (!preAuto.ok) return preAuto;
        return writeDataUrl({
          dataUrl: a.dataUrl, ext: a.ext, filename: a.filename, dir: getDir(),
        });
      }

      // 档 3：完全没有 savePath 键 = 界面上的「另存为…」⇒ 弹保存对话框。
      // 弹窗前先做形状校验：让用户挑完保存位置才告诉他"这张图不合法"，是很糟的体验。
      const pre = checkDataUrlShape(a.dataUrl);
      if (!pre.ok) return pre;
      if (!dlg || typeof dlg.showSaveDialog !== 'function') {
        return { ok: false, error: '当前环境没有保存对话框，且未提供 savePath：无法确定保存位置' };
      }
      const dir = postersDir(getDir());
      const wantExt = normExt(a.ext) || 'png';
      const defaultName = '海报-' + stamp() + '.' + wantExt;
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建目录失败不该拦住弹窗 */ }

      const dialogOpts = {
        title: '保存海报',
        defaultPath: path.join(dir, defaultName),
        filters: [
          { name: 'PNG 图片', extensions: ['png'] },
          { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      };
      const win = getWindow();
      const canParent = win && typeof win === 'object'
        && (typeof win.isDestroyed !== 'function' || !win.isDestroyed());
      const res = canParent
        ? await dlg.showSaveDialog(win, dialogOpts)
        : await dlg.showSaveDialog(dialogOpts);

      if (!res || res.canceled || !res.filePath) return { ok: false, canceled: true };

      // 用户可能在对话框里把后缀删掉（只输名字）：补一个，否则 writeDataUrl 会按
      // 「扩展名不是图片」拒绝，用户看到的是「保存失败」而不是「请补后缀」。
      let chosen = String(res.filePath);
      const ce = path.extname(chosen).toLowerCase();
      if (!IMAGE_EXTS.includes(ce)) chosen = chosen + '.' + wantExt;

      return writeDataUrl({
        dataUrl: a.dataUrl, ext: a.ext, filename: a.filename, savePath: chosen, dir,
      });
    } catch (e) {
      return { ok: false, error: (e && e.message) || '导出海报失败' };
    }
  });

  // ---- 2. 保存工程 ----
  ipc.handle('poster:saveProject', (_e, args) => {
    try {
      const a = args && typeof args === 'object' ? args : {};
      return saveProject({ json: a.json, name: a.name, dir: getDir() });
    } catch (e) {
      return { ok: false, error: (e && e.message) || '保存项目失败' };
    }
  });

  // ---- 3. 读取工程 ----
  ipc.handle('poster:readProject', (_e, p) => {
    try {
      return readProject(p);
    } catch (e) {
      return { ok: false, error: (e && e.message) || '读取项目失败' };
    }
  });

  // ---- 4. 工程列表 ----
  ipc.handle('poster:listProjects', (_e) => {
    try {
      return listProjects(getDir());
    } catch (e) {
      return { ok: false, dir: '', items: [], error: (e && e.message) || '读取项目列表失败' };
    }
  });
}

module.exports = {
  postersDir,
  writeDataUrl,
  saveProject,
  readProject,
  listProjects,
  registerIpc,
  // 单测要按上限造数据，导出来避免测试里再抄一遍常量（抄一遍就会各自漂移）
  MAX_BYTES,
};
