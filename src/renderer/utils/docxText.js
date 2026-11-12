/**
 * docxText.js —— 从 .docx 文件提取纯文本（浏览器/Electron 渲染层可用）。
 *
 * 用途：媒体投放页「上传 word」入口（老板 2026-10-15 需求：留一个上传 word 或
 * 复制文章的地方，让 AI 按文章内容挑媒体）。.docx 本质是 zip，用浏览器原生的
 * DecompressionStream('deflate-raw') 解压 word/document.xml，再去掉 XML 标签
 * 拼回正文 —— 不引三方库（mammoth.js 约 1MB，本项目打包体积敏感）。
 *
 * 诚实边界（绝不假装成功）：
 *   · .txt / .md → 直接按 UTF-8 读；
 *   · .docx → zip 解析成功才返回文本；任何一个环节失败都返回 { ok:false, error }，
 *     由调用方提示用户「这个文件读不出，请复制正文粘贴」；
 *   · .pdf → 交给 services/pdfExtract.js（老板第 3 条「而且不支持看PDF」）；
 *   · 老 .doc（二进制格式）→ 明确不支持，返回 ok:false（不静默吐乱码）。
 *
 * 【为什么 PDF 走这里而不是让 ActivityChat 自己判后缀】
 *   上传入口不止一个（活动策划 / 媒体投放都用 extractFileText）。若只在
 *   ActivityChat 里加 `.pdf` 分支，媒体投放那边传 PDF 仍会走到「只支持 .docx / .txt」
 *   的兜底错误上，而两条链共用同一个 file input 组件形态 ⇒ 迟早要再改一次。
 *   后缀分发放到**唯一入口**，各页面只需要在自己的 accept 里放开 `.pdf`。
 *
 * 【为什么用静态 import 而不是动态 import('...')】
 *   pdfExtract.js 是纯 JS（不引 pdfjs，见该文件头注释），压缩后约 20KB，
 *   相对本项目 6-7MB 的产物可忽略；动态 import 会把「文件类型分发」变成异步时序问题
 *   （jsdom 下更难测），收益不抵复杂度。
 */

import { extractPdfText } from '../services/pdfExtract.js';

/** 从 ArrayBuffer 里按 zip 目录结构取出 word/document.xml 并解压为字符串。 */
async function readDocxXml(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 4 || u8[0] !== 0x50 || u8[1] !== 0x4b) {
    throw new Error('不是有效的 zip/docx 文件');
  }
  const view = new DataView(buf);
  // 1) 找 EOCD（End Of Central Directory）：从尾部向前扫 0x06054b50
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 目录损坏（找不到 EOCD）');
  const cdCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new Error('zip64 暂不支持');

  // 2) 扫中央目录，找 word/document.xml 的 local header 偏移
  const td = new TextDecoder();
  let localOffset = -1;
  let compSize = 0;
  let uncompSize = 0;
  let method = 0;
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break; // central directory file header
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    method = view.getUint16(p + 10, true);
    compSize = view.getUint32(p + 20, true);
    uncompSize = view.getUint32(p + 24, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (name === 'word/document.xml') {
      localOffset = view.getUint32(p + 42, true);
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (localOffset < 0) throw new Error('docx 里没有 word/document.xml');

  // 3) 读 local file header，定位数据起点
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('local header 签名不符');
  const lNameLen = view.getUint16(localOffset + 26, true);
  const lExtraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  // central 里的 compSize 为 0 时（部分生成器），退回从 dataStart 读到 cdOffset
  const dataEnd = compSize > 0 ? dataStart + compSize : cdOffset;
  const raw = u8.subarray(dataStart, Math.min(dataEnd, cdOffset || dataEnd));

  // 4) 解压：method 0 = stored（原样），8 = deflate（raw）
  let bytes;
  if (method === 0) {
    bytes = raw;
  } else if (method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前环境不支持 DecompressionStream');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error('不支持的压缩方式 method=' + method);
  }
  return td.decode(bytes);
}

/** document.xml → 纯文本：按 </w:p> 分段，段内取 <w:t> 文本，忽略 <w:tab/> 之外的样式。 */
function xmlToText(xml) {
  const paragraphs = xml.split(/<\/w:p>/);
  const lines = [];
  for (const para of paragraphs) {
    const texts = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(para)) !== null) {
      const piece = m[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
      if (piece) texts.push(piece);
    }
    const line = texts.join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 读取用户上传的文件，提取正文文本。
 * @param {File} file 浏览器 File 对象
 * @returns {Promise<{ok:true, text:string, name:string} | {ok:false, error:string}>}
 */
export async function extractFileText(file) {
  const name = String((file && file.name) || '');
  const lower = name.toLowerCase();
  try {
    if (lower.endsWith('.txt') || lower.endsWith('.md')) {
      const text = await file.text();
      return { ok: true, text: String(text || '').trim(), name };
    }
    if (lower.endsWith('.docx')) {
      const buf = await file.arrayBuffer();
      const xml = await readDocxXml(buf);
      const text = xmlToText(xml).trim();
      if (!text) return { ok: false, error: '这个 docx 里没读到文字（可能是纯图片型文档），请复制正文粘贴。' };
      return { ok: true, text, name };
    }
    if (lower.endsWith('.pdf')) {
      const buf = await file.arrayBuffer();
      const r = await extractPdfText(buf);
      if (!r || !r.ok) {
        const why = (r && r.error) || '没读到正文';
        return { ok: false, error: why + '（扫描件需要先 OCR 成文字层再传）' };
      }
      const text = String(r.text || '').trim();
      if (!text) return { ok: false, error: '这个 PDF 里没读到文字（可能是扫描件/纯图片），请复制正文粘贴。' };
      return { ok: true, text, name };
    }
    if (lower.endsWith('.doc')) {
      return { ok: false, error: '老版 .doc 格式读不了，请另存为 .docx，或直接复制正文粘贴。' };
    }
    return { ok: false, error: '只支持 .pdf / .docx / .txt，或直接复制正文粘贴。' };
  } catch (e) {
    return { ok: false, error: '读取失败：' + (e && e.message ? e.message : String(e)) };
  }
}
