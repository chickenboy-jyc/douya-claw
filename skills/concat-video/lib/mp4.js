'use strict';
/**
 * mp4.js —— 只读 mp4 的盒子头，用来证明「导出的是真 mp4，不是 0 字节空文件」。
 *
 * 判据取自 ISO/IEC 14496-12：文件第一个 box 是 ftyp，
 * 布局为 [4 字节长度][4 字节类型 "ftyp"][4 字节主品牌]。
 * 所以第 4~8 字节必须是 ascii 的 ftyp —— 这是本仓"产物合法性"的既有口径。
 */

const fs = require('fs');
const { errText } = require('./format');

/**
 * @param {string} file
 * @returns {{ok:boolean, bytes:number, boxSize:number, type:string, brand:string, hex:string, error:string}}
 */
function readMp4Head(file) {
  const base = { ok: false, bytes: 0, boxSize: 0, type: '', brand: '', hex: '', error: '' };
  let fd = null;
  try {
    const st = fs.statSync(file);
    base.bytes = st.size;
    if (st.size < 12) {
      base.error = '文件只有 ' + st.size + ' 字节，连盒子头都不够';
      return base;
    }
    const head = Buffer.alloc(12);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 12, 0);
    base.hex = head.toString('hex');
    base.boxSize = head.readUInt32BE(0);
    base.type = head.slice(4, 8).toString('latin1');
    base.brand = head.slice(8, 12).toString('latin1');
    base.ok = base.type === 'ftyp';
    if (!base.ok) base.error = '第 4~8 字节不是 ftyp（是 "' + base.type + '"），不是合法的 mp4/mov';
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

module.exports = { readMp4Head };
