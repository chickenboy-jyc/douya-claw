'use strict';
/**
 * png.js —— 只读 PNG 头，用来证明「预览帧不是占位图」。
 *
 * 为什么用 IHDR 而不是文件大小：一个 4 万字节的 PNG 完全可以是全黑的空帧；
 * IHDR 里的宽高是渲染器自己写进去的，跟工程/导出参数对得上才是真合成。
 * 偏移量按 PNG 规范：8 字节签名 + 4 字节长度 + 4 字节类型 = 16 起是 width，20 起是 height（大端 uint32）。
 */

const fs = require('fs');
const { errText } = require('./format');

const PNG_SIG_HEX = '89504e470d0a1a0a';

/**
 * @param {string} file
 * @returns {{ok:boolean, bytes:number, width:number, height:number, bitDepth:number,
 *            colorType:number, sig:string, chunkType:string, error:string}}
 */
function readPngInfo(file) {
  const base = { ok: false, bytes: 0, width: 0, height: 0, bitDepth: 0, colorType: 0, sig: '', chunkType: '', error: '' };
  let fd = null;
  try {
    const st = fs.statSync(file);
    base.bytes = st.size;
    const head = Buffer.alloc(33);
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, head, 0, 33, 0);
    if (read < 24) {
      base.error = '文件太短（只有 ' + read + ' 字节），不可能是有效 PNG';
      return base;
    }
    base.sig = head.slice(0, 8).toString('hex');
    base.chunkType = head.slice(12, 16).toString('ascii');
    const isPng = base.sig === PNG_SIG_HEX;
    if (!isPng) {
      base.error = '不是 PNG（签名 = ' + base.sig + '）';
      return base;
    }
    if (base.chunkType !== 'IHDR') {
      base.error = 'PNG 第一个块不是 IHDR（是 ' + base.chunkType + '）';
      return base;
    }
    base.width = head.readUInt32BE(16);
    base.height = head.readUInt32BE(20);
    base.bitDepth = head[24];
    base.colorType = head[25];
    base.ok = base.width > 0 && base.height > 0;
    if (!base.ok) base.error = 'IHDR 宽高为 0（' + base.width + 'x' + base.height + '）';
    return base;
  } catch (e) {
    base.error = errText(e);
    return base;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 关不掉不算判据 */ }
    }
  }
}

module.exports = { readPngInfo, PNG_SIG_HEX };
