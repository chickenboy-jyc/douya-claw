/**
 * pdfExtract.js —— 从 PDF 里提取**文字层**（不引三方库，浏览器/Electron 渲染层与 Node 测试同一份代码）
 *
 * ============================================================================
 * 【调用方式（UI 接入只需要这两行）】
 *
 *   import { extractPdfText } from '../services/pdfExtract.js';
 *
 *   const r = await extractPdfText(file);          // file 就是 <input type="file"> 拿到的 File
 *   if (r.ok) {
 *     materials.push({ name: file.name, text: r.text });   // 和 docxText.js 的 {name,text} 完全同形
 *   } else {
 *     message.warning(`《${file.name}》：${r.error}`);      // error 是给人看的一句话，直接展示
 *   }
 *
 *   ActivityChat.jsx 现有的 handleMaterial 就是「extractFileText(f) → r.ok ? 收下 : 提示」这个形态，
 *   把 .pdf 分支出这里即可，不需要任何 IPC / 主进程配合。
 *
 * 【返回值契约（一个字段都不许多说，全部稳定）】
 *   Promise<{
 *     ok: boolean,          // 只有**真的读到文字**才为 true
 *     text: string,         // 全文（按页用 \n\n 连接，已清掉空行与行尾空白）；失败时恒为 ''
 *     pages: number,        // 页数（失败时为 0 或已解析到的页数）
 *     pageTexts: string[],  // 每页一段，长度 === 读到的页数
 *     error: string,        // ok:true 时恒为 ''；ok:false 时是能给用户看的中文原因
 *   }>
 *   额外只多一个字段 `truncated: boolean`（超过 maxPages / maxChars 被截断时为 true，其余恒 false），
 *   调用方可以忽略它。
 *
 * 【入参】
 *   fileOrBuffer：
 *     · 浏览器 File / Blob（只要有 arrayBuffer()）；
 *     · Node Buffer / Uint8Array / ArrayBuffer（测试与主进程用）。
 *   opts.maxPages 默认 200，opts.maxChars 默认 400000。
 *
 * 【诚实边界 —— 绝不假装成功】
 *   · 加密 PDF（/Encrypt）→ ok:false「这个 PDF 有密码保护…」；
 *   · **扫描件（每页只有图，没有文字层）→ ok:false 且明确说「扫描图片，读不出文字」**，
 *     不许返回空字符串冒充成功（这是最常见的一种，必须能让用户看懂）；
 *   · 内嵌字体缺 ToUnicode 映射（Type0/CID 但没有 CMap）→ 读不出就不返回乱码，如实报错；
 *   · 文件损坏 / 根本不是 PDF → ok:false + 具体原因；任何情况都不向外抛异常。
 *
 * 【为什么不用 pdfjs-dist / pdf-parse】
 *   · 这两个包前者 ~10MB（含字体与 worker），后者是 Node 专用（浏览器侧跑不了），
 *     而本项目是打包体积敏感的桌面端（docxText.js 也是出于同样理由手写 zip 解析）；
 *   · 本项目只需要「文字层」这一件事，而且失败必须**可分辨**（扫描件 vs 加密 vs 字体缺映射），
 *     自建实现正好把这三类分开报，不用去猜三方库的报错文本。
 *   · 走渲染层而不是主进程：与 docxText.js 完全一致的既有约定（File → 文本），
 *     UI 侧零 IPC；若以后要挪进主进程，本文件是一个纯函数，`extractPdfText(buffer)` 原样可用。
 *
 * 【已知限制（写在这里，免得下一个人以为是 bug）】
 *   · 版式坐标是近似的：多栏排版可能把左右栏的文字交替拼在一起（不解析真实字宽）；
 *   · 只支持的流压缩：FlateDecode / ASCIIHexDecode / ASCII85Decode / RunLengthDecode；
 *     LZW / DCT / JPX / CCITT / JBIG2 会如实报「不支持的流压缩」（图片流本身也不需要解）；
 *   · 不支持表单域 / 注释 / 书签里的文字，只读页面内容流。
 * ============================================================================
 */

/** PDF 里的空白字符（含 \0，规范里算空白）。 */
const WS = ' \t\r\n\f\0';

/** 名字/数字的分隔符。 */
const DELIM = '()<>[]{}/%';

/** WinAnsiEncoding 里 0x80-0x9F 与 latin1 不同的那几个（其余与 latin1 一致）。 */
const WIN_ANSI_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178',
};

/** Differences 里最常见的字形名 → Unicode（只覆盖西文，够修正 WinAnsi 的偏移）。 */
const GLYPH_NAMES = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1',
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', endash: '\u2013', emdash: '\u2014',
  quoteleft: '\u2018', quoteright: '\u2019', quotedblleft: '\u201C',
  quotedblright: '\u201D', bullet: '\u2022', ellipsis: '\u2026', trademark: '\u2122',
  fi: '\uFB01', fl: '\uFB02', degree: '\u00B0', plusminus: '\u00B1',
  multiply: '\u00D7', divide: '\u00F7', mu: '\u00B5', copyright: '\u00A9',
  registered: '\u00AE', section: '\u00A7', paragraph: '\u00B6', periodcentered: '\u00B7',
};

// ────────────────────────────── 字节 / 字符串工具 ──────────────────────────────

/**
 * 把输入统一成 Uint8Array。
 * @param {File|Blob|Buffer|Uint8Array|ArrayBuffer|{arrayBuffer:Function}} input
 * @returns {Promise<Uint8Array>}
 */
async function toBytes(input) {
  if (!input) throw new Error('没有拿到文件内容');
  if (input instanceof Uint8Array) return input; // Buffer 是 Uint8Array 子类
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView && ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input.arrayBuffer === 'function') {
    const ab = await input.arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error('不支持的入参类型（需要 File / Blob / Buffer / Uint8Array）');
}

/** 字节 → 单字节字符串（索引与字节一一对应，便于正则扫描）。 */
function latin1(u8) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return out;
}

/** 单字节字符串 → 字节。 */
function bytesOf(str) {
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xff;
  return u8;
}

function skipWs(s, p) {
  while (p < s.length && WS.indexOf(s[p]) >= 0) p++;
  return p;
}

function isWs(ch) {
  return ch === undefined || WS.indexOf(ch) >= 0;
}

// ────────────────────────────── 解压 ──────────────────────────────

let zlibPromise = null;

/** 尽力拿到 node:zlib（Node / 主进程 / 测试）；拿不到返回 null（渲染层会退到 DecompressionStream）。 */
async function getZlib() {
  if (zlibPromise) return zlibPromise;
  zlibPromise = (async () => {
    try {
      // 用变量拼 specifier + @vite-ignore：Vite 打包渲染层时不会把 node:zlib 打进 browser bundle，
      // 运行时 import 失败 → 返回 null → 走 DecompressionStream 分支。
      const spec = 'node:' + 'zlib';
      const mod = await import(/* @vite-ignore */ spec);
      const z = mod && (mod.inflateSync ? mod : mod.default);
      return z && typeof z.inflateSync === 'function' ? z : null;
    } catch (e) {
      return null;
    }
  })();
  return zlibPromise;
}

/** FlateDecode：zlib 优先，渲染层退回 DecompressionStream。 */
async function inflate(u8) {
  const z = await getZlib();
  if (z) {
    try {
      return new Uint8Array(z.inflateSync(u8));
    } catch (e) { /* 有些生成器写的是 raw deflate，无 zlib 头 */ }
    try {
      return new Uint8Array(z.inflateRawSync(u8));
    } catch (e) { /* 落到 DecompressionStream */ }
  }
  if (typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined') {
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream(fmt));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) { /* 换下一种 */ }
    }
  }
  throw new Error('FlateDecode 解压失败（当前环境没有可用的 zlib / DecompressionStream）');
}

/** ASCIIHexDecode：忽略空白，奇数位补 0，遇 '>' 结束。 */
function asciiHexDecode(u8) {
  const out = [];
  let hi = -1;
  for (let i = 0; i < u8.length; i++) {
    const c = u8[i];
    if (c === 0x3e) break; // '>'
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4);
  return new Uint8Array(out);
}

function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** ASCII85Decode（含 'z' 缩写与 '~>' 终止符）。 */
function ascii85Decode(u8) {
  const out = [];
  let group = [];
  for (let i = 0; i < u8.length; i++) {
    const c = u8[i];
    if (c === 0x7e) break; // '~'
    if (c <= 0x20) continue; // 空白
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; } // 'z'
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let n = 0;
      for (let k = 0; k < 5; k++) n = n * 85 + group[k];
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const need = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (let k = 0; k < 5; k++) n = n * 85 + group[k];
    const four = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    for (let k = 0; k < need - 1; k++) out.push(four[k]);
  }
  return new Uint8Array(out);
}

/** RunLengthDecode。 */
function runLengthDecode(u8) {
  const out = [];
  let i = 0;
  while (i < u8.length) {
    const len = u8[i++];
    if (len === 128) break;
    if (len === undefined) break;
    if (len < 128) {
      for (let k = 0; k <= len && i < u8.length; k++) out.push(u8[i++]);
    } else {
      const b = u8[i++];
      for (let k = 0; k < 257 - len; k++) out.push(b);
    }
  }
  return new Uint8Array(out);
}

// ────────────────────────────── PDF 对象解析 ──────────────────────────────

/** 读一个 name（'/' 之后），返回 {value:'Name', end}。 */
function readName(s, p) {
  let i = p + 1;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (isWs(ch) || DELIM.indexOf(ch) >= 0) break;
    out += ch;
    i++;
  }
  return { value: out, end: i };
}

/** 读一个数字（可能带 +/-、小数点），返回 {value:number, end}。 */
function readNumber(s, p) {
  let i = p;
  let out = '';
  while (i < s.length && /[-+0-9.eE]/.test(s[i])) {
    // 只在合法位置接受 +/-（避免把 "1-2" 里的 - 吃掉，PDF 里不会出现，但稳妥）
    if ((s[i] === '-' || s[i] === '+') && out.length > 0) break;
    out += s[i];
    i++;
  }
  const v = parseFloat(out);
  return { value: Number.isFinite(v) ? v : 0, end: i };
}

/** 读一个字面量字符串（括号已配平，处理转义），返回字节。 */
function readLiteralString(s, p) {
  let i = p + 1;
  let depth = 1;
  const out = [];
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const nx = s[i + 1];
      i += 2;
      if (nx === 'n') out.push(0x0a);
      else if (nx === 'r') out.push(0x0d);
      else if (nx === 't') out.push(0x09);
      else if (nx === 'b') out.push(0x08);
      else if (nx === 'f') out.push(0x0c);
      else if (nx === '(') out.push(0x28);
      else if (nx === ')') out.push(0x29);
      else if (nx === '\\') out.push(0x5c);
      else if (nx === '\n') { /* 续行 */ }
      else if (nx === '\r') { if (s[i] === '\n') i++; }
      else if (nx >= '0' && nx <= '7') {
        let oct = nx;
        while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') { oct += s[i]; i++; }
        out.push(parseInt(oct, 8) & 0xff);
      } else if (nx === undefined) { break; }
      else out.push(nx.charCodeAt(0) & 0xff);
      continue;
    }
    if (ch === '(') { depth++; out.push(0x28); i++; continue; }
    if (ch === ')') {
      depth--;
      i++;
      if (depth === 0) break;
      out.push(0x29);
      continue;
    }
    out.push(ch.charCodeAt(0) & 0xff);
    i++;
  }
  return { value: new Uint8Array(out), end: i };
}

/** 读一个十六进制字符串 <...>。 */
function readHexString(s, p) {
  let i = p + 1;
  const out = [];
  let hi = -1;
  while (i < s.length && s[i] !== '>') {
    const v = hexVal(s.charCodeAt(i));
    i++;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4);
  return { value: new Uint8Array(out), end: i + 1 };
}

/**
 * 解析一个 PDF 值。
 * 值的表示：number = JS number；其余用带 t 标记的对象：
 *   {t:'name', v} / {t:'ref', n, g} / {t:'str', v:Uint8Array} / {t:'array', v:[]}
 *   / {t:'dict', v:{}} / {t:'bool', v} / {t:'null'}
 */
function parseValue(s, p) {
  p = skipWs(s, p);
  if (p >= s.length) return { value: { t: 'null' }, end: p };
  const c = s[p];

  if (c === '<' && s[p + 1] === '<') {
    const dict = {};
    let i = p + 2;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; }
      if (s[i] !== '/') {
        // 容错：字典里出现非法 token 时跳过一个值，绝不死循环
        const skip = parseValue(s, i);
        i = skip.end > i ? skip.end : i + 1;
        continue;
      }
      const key = readName(s, i);
      i = key.end;
      const val = parseValue(s, i);
      i = val.end > i ? val.end : i + 1;
      dict[key.value] = val.value;
    }
    return { value: { t: 'dict', v: dict }, end: i };
  }

  if (c === '[') {
    const arr = [];
    let i = p + 1;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      if (s[i] === ']') { i++; break; }
      const val = parseValue(s, i);
      i = val.end > i ? val.end : i + 1;
      arr.push(val.value);
    }
    return { value: { t: 'array', v: arr }, end: i };
  }

  if (c === '(') return readLiteralString(s, p);
  if (c === '<') return readHexString(s, p);
  if (c === '/') {
    const nm = readName(s, p);
    return { value: { t: 'name', v: nm.value }, end: nm.end };
  }

  if (s.startsWith('true', p)) return { value: { t: 'bool', v: true }, end: p + 4 };
  if (s.startsWith('false', p)) return { value: { t: 'bool', v: false }, end: p + 5 };
  if (s.startsWith('null', p)) return { value: { t: 'null' }, end: p + 4 };

  if (/[-+0-9.]/.test(c)) {
    const first = readNumber(s, p);
    // 可能是间接引用「N G R」
    let q = skipWs(s, first.end);
    if (/[0-9]/.test(s[q] || '')) {
      const second = readNumber(s, q);
      const r = skipWs(s, second.end);
      const after = s[r + 1];
      // R 后面可能是空白、分隔符（如 Kids [3 0 R 6 0 R] 里的 ']'）或文件末尾
      if (s[r] === 'R' && (after === undefined || isWs(after) || DELIM.indexOf(after) >= 0)) {
        return { value: { t: 'ref', n: first.value, g: second.value }, end: r + 1 };
      }
    }
    return { value: first.value, end: first.end };
  }

  // 未知 token：跳过 1 个字符，避免死循环
  return { value: { t: 'null' }, end: p + 1 };
}

/** Node = { value, stream:{start,end}|null }（stream 的 start/end 是**整文件字节下标**）。 */
function isNode(x) {
  return !!x && typeof x === 'object' && 'value' in x && 'stream' in x;
}

function valueOf(x) {
  return isNode(x) ? x.value : x;
}

function dictOf(x) {
  const v = valueOf(x);
  return v && v.t === 'dict' ? v.v : null;
}

/** 解引用后取字典（resources / font dict 经常是间接引用）。 */
function asDict(x, objects) {
  let v = valueOf(x);
  if (v && v.t === 'ref' && objects) {
    const n = objects.get(v.n);
    v = n ? n.value : null;
  }
  if (v && v.t === 'dict') return v.v;
  return null;
}

/** 解引用后取流对象节点（ToUnicode / Contents / XObject 用）。 */
function asStreamNode(x, objects) {
  if (isNode(x)) return x.stream ? x : null;
  const v = valueOf(x);
  if (v && v.t === 'ref' && objects) {
    const n = objects.get(v.n);
    return n && n.stream ? n : null;
  }
  return null;
}

function nameOf(x) {
  const v = valueOf(x);
  return v && v.t === 'name' ? v.v : '';
}

function numOf(x) {
  const v = valueOf(x);
  return typeof v === 'number' ? v : NaN;
}

function arrOf(x) {
  const v = valueOf(x);
  return v && v.t === 'array' ? v.v : null;
}

/**
 * 扫描全文所有 `N G obj ... endobj`，建立对象表。
 * 不解析 xref 表：现代 PDF 大量使用对象流 + 交叉引用流，硬解 xref 反而更脆；
 * 按对象头暴力扫描，配 ObjStm 展开，覆盖面更广（pdf.js 的 recovery 模式同思路）。
 */
function scanObjects(raw) {
  const objects = new Map();
  const re = /(\d+)[ \t\r\n\f\0]+(\d+)[ \t\r\n\f\0]*obj\b/g;
  const heads = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    heads.push({ num: parseInt(m[1], 10), gen: parseInt(m[2], 10), at: m.index, body: m.index + m[0].length });
  }
  let consumedTo = -1;
  for (const h of heads) {
    if (h.at < consumedTo) continue; // 落在上一个流的数据里 → 是二进制噪声，不是对象头
    let parsed;
    try {
      const r = parseValue(raw, h.body);
      let value = r.value;
      let stream = null;
      let end = r.end;
      const q = skipWs(raw, end);
      if (raw.startsWith('stream', q)) {
        let s = q + 6;
        if (raw[s] === '\r') s++;
        if (raw[s] === '\n') s++;
        let len = -1;
        const d = value && value.t === 'dict' ? value.v : null;
        if (d && typeof d.Length === 'number') len = d.Length;
        let e = -1;
        if (len >= 0 && s + len <= raw.length) {
          // Length 有可能是错的：只有紧跟 endstream 才认
          const after = skipWs(raw, s + len);
          if (raw.startsWith('endstream', after) || raw.startsWith('endobj', after)) e = s + len;
        }
        if (e < 0) {
          const es = raw.indexOf('endstream', s);
          e = es < 0 ? raw.length : es;
          while (e > s && (raw[e - 1] === '\n' || raw[e - 1] === '\r')) e--;
        }
        stream = { start: s, end: e };
        const ie = raw.indexOf('endobj', e);
        end = ie < 0 ? raw.length : ie + 6;
      } else {
        const ie = raw.indexOf('endobj', end);
        end = ie < 0 ? raw.length : ie + 6;
      }
      parsed = { value, stream, end };
    } catch (e) {
      parsed = { value: { t: 'null' }, stream: null, end: h.body };
    }
    if (!objects.has(h.num)) objects.set(h.num, { value: parsed.value, stream: parsed.stream });
    consumedTo = parsed.end;
  }
  return objects;
}

/** 把流对象的数据解出来（处理 Filter 链）。 */
async function streamBytes(node, bytes) {
  if (!node || !node.stream) return null;
  let data = bytes.subarray(node.stream.start, node.stream.end);
  const d = dictOf(node) || {};
  const filters = [];
  const f = d.Filter;
  const fv = valueOf(f);
  if (fv && fv.t === 'name') filters.push(fv.v);
  else if (fv && fv.t === 'array') {
    for (const item of fv.v) {
      const n = nameOf(item);
      if (n) filters.push(n);
    }
  }
  for (const name of filters) {
    if (name === 'FlateDecode' || name === 'Fl') data = await inflate(data);
    else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHexDecode(data);
    else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85Decode(data);
    else if (name === 'RunLengthDecode' || name === 'RL') data = runLengthDecode(data);
    else throw new Error('不支持的流压缩：' + name);
  }
  return data;
}

/** 展开对象流（/Type /ObjStm），把它们里面的对象补进对象表（不覆盖真实对象）。 */
async function expandObjectStreams(objects, bytes) {
  const targets = [];
  for (const [num, node] of objects) {
    const d = dictOf(node);
    if (d && nameOf(d.Type) === 'ObjStm') targets.push({ num, node });
  }
  for (const { node } of targets) {
    let text = '';
    try {
      const data = await streamBytes(node, bytes);
      if (!data) continue;
      text = latin1(data);
    } catch (e) {
      continue; // 这条对象流解不出来就跳过，不影响其它对象
    }
    const d = dictOf(node) || {};
    const n = numOf(d.N);
    const first = numOf(d.First);
    if (!Number.isFinite(n) || !Number.isFinite(first) || first <= 0 || first > text.length) continue;
    const header = text.slice(0, first).trim();
    if (!header) continue;
    const tokens = header.split(/\s+/);
    const pairs = Math.min(n, Math.floor(tokens.length / 2));
    for (let i = 0; i < pairs; i++) {
      const objNum = parseInt(tokens[i * 2], 10);
      const off = parseInt(tokens[i * 2 + 1], 10);
      if (!Number.isFinite(objNum) || !Number.isFinite(off)) continue;
      const existing = objects.get(objNum);
      // 只补「缺的」或「读到 null 的空壳」，不覆盖文件里真实存在的对象
      if (existing && existing.value && existing.value.t !== 'null') continue;
      const r = parseValue(text, first + off);
      objects.set(objNum, { value: r.value, stream: null });
    }
  }
}

// ────────────────────────────── 字体 / 编码 ──────────────────────────────

/** 十六进制（大写）→ 字符串，按 UTF-16BE 解释（ToUnicode 的 dst 用）。 */
function hexToUnicode(hex) {
  const h = String(hex || '');
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) {
    const code = parseInt(h.slice(i, i + 4), 16);
    if (!Number.isFinite(code)) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/** 十六进制字符串补齐到偶数位（CMap 的 src/dst 偶尔写成单数字）。 */
function padHex(hex) {
  const h = String(hex || '').toUpperCase();
  return h.length % 2 ? '0' + h : h;
}

/** 解析 ToUnicode CMap：codeLen + (code→unicode) 映射表（bfchar / bfrange 都支持）。 */
function parseCMap(text) {
  const map = new Map();
  let codeLen = 0;

  const csRe = /begincodespacerange([\s\S]*?)endcodespacerange/;
  const cs = csRe.exec(text);
  if (cs) {
    const m = /<([0-9A-Fa-f]+)>/.exec(cs[1]);
    if (m && m[1].length % 2 === 0) codeLen = m[1].length / 2;
  }

  const blockRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let b;
  while ((b = blockRe.exec(text)) !== null) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let p;
    while ((p = pairRe.exec(b[1])) !== null) {
      const src = padHex(p[1]);
      map.set(src, hexToUnicode(p[2]));
      if (!codeLen) codeLen = src.length / 2;
    }
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  let rb;
  while ((rb = rangeRe.exec(text)) !== null) {
    // 形式一：<lo> <hi> <dst>
    const triRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let t;
    while ((t = triRe.exec(rb[1])) !== null) {
      const lo = parseInt(t[1], 16);
      const hi = parseInt(t[2], 16);
      const dstHex = t[3].toUpperCase();
      const dstBase = parseInt(dstHex, 16);
      const digits = t[1].length;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      for (let code = lo; code <= hi; code++) {
        const dstCode = dstBase + (code - lo);
        map.set(code.toString(16).toUpperCase().padStart(digits, '0'), String.fromCharCode(dstCode));
      }
      if (!codeLen && digits % 2 === 0) codeLen = digits / 2;
    }
    // 形式二：<lo> <hi> [<d1> <d2> ...]
    const arrRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    let a;
    while ((a = arrRe.exec(rb[1])) !== null) {
      const lo = parseInt(a[1], 16);
      const digits = a[1].length;
      const items = a[3].match(/<([0-9A-Fa-f]*)>/g) || [];
      items.forEach((it, idx) => {
        const hex = it.replace(/[<>]/g, '').toUpperCase();
        map.set((lo + idx).toString(16).toUpperCase().padStart(digits, '0'), hexToUnicode(hex));
      });
      if (!codeLen && digits % 2 === 0) codeLen = digits / 2;
    }
  }

  return { map, codeLen };
}

/** 简单字体的 256 项编码表（默认 WinAnsi，再按 Differences 修正）。 */
function buildSimpleTable(dict) {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    if (WIN_ANSI_HIGH[i]) table[i] = WIN_ANSI_HIGH[i];
    else if (i >= 0x20 && i !== 0x7f) table[i] = String.fromCharCode(i);
    else table[i] = '';
  }
  const enc = valueOf(dict.Encoding);
  if (enc && enc.t === 'dict') {
    const diffs = arrOf(enc.v.Differences);
    if (diffs) {
      let code = 0;
      for (const item of diffs) {
        const v = valueOf(item);
        if (typeof v === 'number') { code = v; continue; }
        const nm = nameOf(v);
        if (!nm) continue;
        let ch = GLYPH_NAMES[nm] || '';
        if (!ch) {
          const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(nm);
          const u = /^u([0-9A-Fa-f]{4,6})$/.exec(nm);
          if (uni) ch = String.fromCharCode(parseInt(uni[1], 16));
          else if (u) ch = String.fromCharCode(parseInt(u[1], 16));
        }
        if (code >= 0 && code < 256) table[code] = ch;
        code++;
      }
    }
  }
  return table;
}

/**
 * 为一个字体字典建立解码器。
 * @returns {{kind:'cmap'|'simple'|'undecodable', codeLen:number, map?:Map, table?:string[]}}
 */
async function buildFont(fontRef, bytes, objects) {
  const d = asDict(fontRef, objects);
  if (!d) return { kind: 'simple', codeLen: 1, table: buildSimpleTable({}) };
  const subtype = nameOf(d.Subtype);
  const isType0 = subtype === 'Type0';
  let codeLen = isType0 ? 2 : 1;

  if (d.ToUnicode !== undefined) {
    try {
      const node = asStreamNode(d.ToUnicode, objects);
      const data = node ? await streamBytes(node, bytes) : null;
      if (data && data.length) {
        const parsed = parseCMap(latin1(data));
        if (parsed.map.size) {
          if (parsed.codeLen) codeLen = parsed.codeLen;
          return { kind: 'cmap', codeLen, map: parsed.map };
        }
      }
    } catch (e) { /* ToUnicode 坏了就往下走 */ }
  }

  if (isType0) return { kind: 'undecodable', codeLen: 2 };
  return { kind: 'simple', codeLen: 1, table: buildSimpleTable(d) };
}

/**
 * 用字体解码一段 PDF 字节串。
 * @returns {{text:string, missing:number, total:number}}
 */
function decodeWithFont(font, bytes) {
  if (!font) font = { kind: 'simple', codeLen: 1, table: buildSimpleTable({}) };
  let text = '';
  let missing = 0;
  let total = 0;
  if (font.kind === 'undecodable') {
    return { text: '', missing: bytes.length, total: bytes.length };
  }
  if (font.kind === 'cmap') {
    const step = Math.max(1, font.codeLen);
    for (let i = 0; i + step <= bytes.length; i += step) {
      total++;
      let hex = '';
      for (let k = 0; k < step; k++) hex += bytes[i + k].toString(16).toUpperCase().padStart(2, '0');
      const hit = font.map.get(hex);
      if (hit === undefined) missing++;
      else text += hit;
    }
    return { text, missing, total };
  }
  // simple
  for (let i = 0; i < bytes.length; i++) {
    total++;
    const ch = font.table[bytes[i]];
    if (ch === undefined) missing++;
    else text += ch;
  }
  return { text, missing, total };
}

// ────────────────────────────── 内容流 → 文本 ──────────────────────────────

/** 内容流词法分析：只产出我们关心的 token（operator / number / string / array 分隔）。 */
function* lexContent(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    if (c === '(') {
      const r = readLiteralString(s, i);
      yield { type: 'str', value: r.value };
      i = r.end > i ? r.end : i + 1;
      continue;
    }
    if (c === '<') {
      if (s[i + 1] === '<') {
        // 内联字典（如 /Span << /ActualText (...) >> BDC）：整体跳过
        let depth = 0;
        while (i < n) {
          if (s[i] === '<' && s[i + 1] === '<') { depth++; i += 2; continue; }
          if (s[i] === '>' && s[i + 1] === '>') { depth--; i += 2; if (depth <= 0) break; continue; }
          i++;
        }
        continue;
      }
      const r = readHexString(s, i);
      yield { type: 'str', value: r.value };
      i = r.end > i ? r.end : i + 1;
      continue;
    }
    if (c === '[') { yield { type: '[' }; i++; continue; }
    if (c === ']') { yield { type: ']' }; i++; continue; }
    if (c === '/') {
      const r = readName(s, i);
      yield { type: 'name', value: r.value };
      i = r.end > i ? r.end : i + 1;
      continue;
    }
    if (c === '{' || c === '}') { i++; continue; }
    if (/[-+0-9.]/.test(c)) {
      const r = readNumber(s, i);
      yield { type: 'num', value: r.value };
      i = r.end > i ? r.end : i + 1;
      continue;
    }
    // operator：连续的非分隔、非空白字符（含 ' 与 " 两个运算符）
    let op = '';
    while (i < n && !isWs(s[i]) && DELIM.indexOf(s[i]) < 0) { op += s[i]; i++; }
    if (!op) { i++; continue; }
    yield { type: 'op', value: op };
  }
}

/**
 * 从一页的内容流文本里抽文字。
 * 版式是**近似**的：只按文本矩阵的 y 变化断行（不解析字宽），够读方案类文档。
 * @param {string} content 内容流（latin1 字符串）
 * @param {(name:string)=>object} fontFor 字体名 → 解码器
 * @returns {{text:string, ops:number, missing:number, total:number}}
 */
function extractFromContent(content, fontFor) {
  const out = [];
  const stack = [];
  let arrayStack = null; // 正在收集的 TJ 数组

  let font = null;
  let fontSize = 12;
  let curX = 0;
  let curY = 0;
  let lastY = null;
  let ops = 0;
  let missing = 0;
  let totalChars = 0;

  const emit = (str) => {
    if (!str) return;
    if (lastY !== null && Math.abs(curY - lastY) > Math.max(1.5, fontSize * 0.35)) out.push('\n');
    out.push(str);
    lastY = curY;
  };

  const show = (bytes) => {
    const r = decodeWithFont(font, bytes);
    ops++;
    totalChars += r.total;
    missing += r.missing;
    emit(r.text);
  };

  for (const tok of lexContent(content)) {
    if (tok.type === '[') { arrayStack = []; continue; }
    if (tok.type === ']') { stack.push({ t: 'array', v: arrayStack || [] }); arrayStack = null; continue; }
    if (tok.type === 'num' || tok.type === 'name' || tok.type === 'str') {
      if (arrayStack) arrayStack.push(tok);
      else stack.push(tok);
      continue;
    }
    // operator
    const op = tok.value;
    if (op === 'Tf') {
      const nameTok = stack.filter((x) => x.type === 'name').pop();
      const sizeTok = stack.filter((x) => x.type === 'num').pop();
      font = nameTok ? fontFor(nameTok.value) : font;
      if (sizeTok && sizeTok.value > 0) fontSize = sizeTok.value;
    } else if (op === 'Td' || op === 'TD') {
      const nums = stack.filter((x) => x.type === 'num');
      if (nums.length >= 2) {
        curX += nums[nums.length - 2].value;
        curY += nums[nums.length - 1].value;
      }
    } else if (op === 'Tm') {
      const nums = stack.filter((x) => x.type === 'num');
      if (nums.length >= 6) {
        curX = nums[nums.length - 2].value;
        curY = nums[nums.length - 1].value;
      }
    } else if (op === 'T*') {
      curY -= fontSize * 1.2;
    } else if (op === 'Tj') {
      const strTok = stack.filter((x) => x.type === 'str').pop();
      if (strTok) show(strTok.value);
    } else if (op === "'") {
      curY -= fontSize * 1.2;
      const strTok = stack.filter((x) => x.type === 'str').pop();
      if (strTok) show(strTok.value);
    } else if (op === '"') {
      curY -= fontSize * 1.2;
      const strTok = stack.filter((x) => x.type === 'str').pop();
      if (strTok) show(strTok.value);
    } else if (op === 'TJ') {
      const arrTok = stack.filter((x) => x.t === 'array').pop();
      if (arrTok) {
        for (const el of arrTok.v) {
          if (el.type === 'str') show(el.value);
          else if (el.type === 'num' && el.value <= -120) emit(' '); // 字距大 → 当空格
        }
      }
    } else if (op === 'BT') {
      curX = 0;
      curY = 0;
      lastY = null;
    }
    stack.length = 0;
    arrayStack = null;
  }

  return { text: out.join(''), ops, missing, total: totalChars };
}

/** 收集一页用到的字体：name → 解码器（并发的 ToUnicode 只解一次）。 */
async function buildPageFonts(resources, bytes, objects) {
  const map = new Map();
  const resDict = asDict(resources, objects);
  if (!resDict) return map;
  const fontDict = asDict(resDict.Font, objects);
  if (!fontDict) return map;
  for (const [name, ref] of Object.entries(fontDict)) {
    try {
      map.set(name, await buildFont(ref, bytes, objects));
    } catch (e) {
      map.set(name, { kind: 'undecodable', codeLen: 2 });
    }
  }
  return map;
}

/** 这一页有没有图片 XObject（用来区分「扫描件」和「空页」）。 */
function pageHasImage(resources, objects) {
  const resDict = asDict(resources, objects);
  if (!resDict) return false;
  const xobj = asDict(resDict.XObject, objects);
  if (!xobj) return false;
  for (const ref of Object.values(xobj)) {
    const d = asDict(ref, objects);
    if (!d) continue;
    if (nameOf(d.Subtype) === 'Image') return true;
    // Form XObject 里面也可能套着图片，这里不递归：够用
  }
  return false;
}

// ────────────────────────────── 页面收集 ──────────────────────────────

/** 走 /Root → /Pages 树收集页面（顺序正确）；拿不到就退回「所有 /Type /Page 按对象号」。 */
function collectPages(objects) {
  const pages = [];
  let catalog = null;
  for (const node of objects.values()) {
    const d = dictOf(node);
    if (d && nameOf(d.Type) === 'Catalog') { catalog = d; break; }
  }
  const seen = new Set();
  const visit = (node, inheritedRes, depth) => {
    if (!node || depth > 64) return;
    const d = dictOf(node);
    if (!d) return;
    const res = d.Resources !== undefined ? d.Resources : inheritedRes;
    const type = nameOf(d.Type);
    if (type === 'Pages') {
      const kids = arrOf(d.Kids) || [];
      for (const kid of kids) {
        const child = valueOf(kid);
        if (child && child.t === 'ref') {
          if (seen.has(child.n)) continue;
          seen.add(child.n);
          visit(objects.get(child.n), res, depth + 1);
        }
      }
      return;
    }
    if (type === 'Page') pages.push({ dict: d, resources: res });
  };

  if (catalog && catalog.Pages !== undefined) {
    const p = valueOf(catalog.Pages);
    if (p && p.t === 'ref') {
      seen.add(p.n);
      visit(objects.get(p.n), catalog.Resources, 0);
    }
  }

  if (!pages.length) {
    const found = [];
    for (const [num, node] of objects) {
      const d = dictOf(node);
      if (d && nameOf(d.Type) === 'Page') found.push({ num, dict: d, resources: d.Resources });
    }
    found.sort((a, b) => a.num - b.num);
    for (const f of found) pages.push({ dict: f.dict, resources: f.resources });
  }
  return pages;
}

/** 一页 → 正文文本。 */
async function pageTextOf(page, bytes, objects) {
  const d = page.dict;
  const contentsVal = d.Contents;
  const refs = [];
  const cv = valueOf(contentsVal);
  if (cv && cv.t === 'ref') refs.push(cv);
  else if (cv && cv.t === 'array') {
    for (const item of cv.v) {
      const iv = valueOf(item);
      if (iv && iv.t === 'ref') refs.push(iv);
    }
  }

  let content = '';
  for (const ref of refs) {
    const node = asStreamNode(ref, objects);
    if (!node) continue;
    const data = await streamBytes(node, bytes);
    if (data) content += latin1(data) + '\n';
  }

  const hasImage = pageHasImage(page.resources, objects);
  if (!content) return { text: '', ops: 0, missing: 0, total: 0, hasImage };

  const fonts = await buildPageFonts(page.resources, bytes, objects);
  const r = extractFromContent(content, (name) => fonts.get(name) || null);
  return { ...r, hasImage };
}

/** 规整一页的文本：行尾去空白、空白行折叠、去掉连续空格。 */
function normalizePageText(s) {
  if (!s) return '';
  const lines = s.split(/\r\n|\r|\n/).map((line) => line.replace(/[ \t\u00a0]+$/g, '').replace(/^[ \t\u00a0]+/g, ''));
  const kept = [];
  let blank = 0;
  for (const line of lines) {
    if (!line.trim()) {
      blank++;
      if (blank > 1) continue;
      kept.push('');
    } else {
      blank = 0;
      kept.push(line);
    }
  }
  return kept.join('\n').trim();
}

// ────────────────────────────── 对外入口 ──────────────────────────────

/**
 * 提取 PDF 文字层。
 * @param {File|Blob|Buffer|Uint8Array|ArrayBuffer|{arrayBuffer:Function}} fileOrBuffer
 * @param {{maxPages?:number, maxChars?:number}} [opts]
 * @returns {Promise<{ok:boolean, text:string, pages:number, pageTexts:string[], error:string, truncated:boolean}>}
 */
export async function extractPdfText(fileOrBuffer, opts = {}) {
  const maxPages = Number.isFinite(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : 200;
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 400000;

  const fail = (error, extra = {}) => ({
    ok: false,
    text: '',
    pages: extra.pages || 0,
    pageTexts: extra.pageTexts || [],
    error,
    truncated: !!extra.truncated,
  });

  let bytes;
  try {
    bytes = await toBytes(fileOrBuffer);
  } catch (e) {
    return fail((e && e.message) || '读不到文件内容');
  }

  if (!bytes || bytes.length < 8) return fail('这个文件是空的或太短，不像是 PDF');
  if (bytes.length > 64 * 1024 * 1024) return fail('这个 PDF 太大了（超过 64MB），请拆分后再传');

  let raw;
  try {
    raw = latin1(bytes);
  } catch (e) {
    return fail('文件读取失败：' + ((e && e.message) || String(e)));
  }

  if (raw.trim() === '') return fail('文件是空的，读不出内容');

  const head = latin1(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (head.indexOf('%PDF-') < 0) return fail('这不是 PDF 文件（找不到 %PDF- 文件头），请确认格式');

  // 加密：有 /Encrypt 就必须声明读不了，不能把密文当文字吐给用户
  if (/\/(Encrypt)\b/.test(raw)) {
    return fail('这个 PDF 有密码保护（已加密），需要先去掉密码再上传');
  }

  try {
    const objects = scanObjects(raw);
    if (!objects.size) return fail('这个 PDF 的结构解析不了（可能是文件损坏或被截断）');
    await expandObjectStreams(objects, bytes);

    const pages = collectPages(objects);
    if (!pages.length) return fail('这个 PDF 里没找到可读的页面（文件可能已损坏）');

    const pageTexts = [];
    let truncated = false;
    let opsTotal = 0;
    let missingTotal = 0;
    let charTotal = 0;
    let imagePages = 0;
    let textPages = 0;

    const limit = Math.min(pages.length, maxPages);
    if (pages.length > maxPages) truncated = true;

    for (let i = 0; i < limit; i++) {
      let r;
      try {
        r = await pageTextOf(pages[i], bytes, objects);
      } catch (e) {
        r = { text: '', ops: 0, missing: 0, total: 0, hasImage: false };
      }
      const txt = normalizePageText(r.text);
      pageTexts.push(txt);
      opsTotal += r.ops || 0;
      missingTotal += r.missing || 0;
      charTotal += r.total || 0;
      if (r.hasImage) imagePages++;
      if (txt) textPages++;
    }

    const joined = pageTexts.filter((t) => t).join('\n\n');
    if (joined) {
      // 有文字就成功（哪怕只有一页），超过 maxChars 就截断并如实标 truncated
      let text = joined;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
      }
      return { ok: true, text, pages: limit, pageTexts, error: '', truncated };
    }

    // —— 到这里一页文字都没读到，必须分清「扫描件」和「其它」，绝不返回空串冒充成功 ——
    if (opsTotal === 0 && imagePages > 0) {
      return fail(
        `这个 PDF 是扫描件（${imagePages} 页只有图片、没有文字层），读不出文字 —— 请发文字版，或把要参考的几段直接粘贴给我`,
        { pages: limit, pageTexts, truncated }
      );
    }
    if (missingTotal >= charTotal && charTotal > 0) {
      return fail(
        '这个 PDF 的字体没有带 Unicode 映射（内嵌字体缺 ToUnicode），强行解码只会得到乱码，所以没有硬取 —— 请导出成"文字版 PDF"或直接粘贴正文',
        { pages: limit, pageTexts, truncated }
      );
    }
    if (imagePages > 0) {
      return fail(
        '这个 PDF 里没有可提取的文字（只有图片内容），读不出文字 —— 请发文字版或直接粘贴正文',
        { pages: limit, pageTexts, truncated }
      );
    }
    return fail('这个 PDF 里没有可提取的文字（页面可能是空的或只有图形）', {
      pages: limit,
      pageTexts,
      truncated,
    });
  } catch (e) {
    return fail('PDF 解析失败：' + ((e && e.message) || String(e)));
  }
}

export default extractPdfText;

