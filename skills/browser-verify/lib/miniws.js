'use strict';
/**
 * 极简 WebSocket 客户端（RFC6455），**只用 Node 标准库**（net/tls/crypto）。
 *
 * 为什么不用 `ws` 包：打包后 skills 位于 resources/skills/（asar 外），而 node_modules
 * 位于 app.asar 内 —— 技能里的 `require('ws')` 在打包形态下不可靠。用标准库自己实现
 * 才能保证「dev 与打包后行为一致」，且**不增加任何依赖/体积**。
 *
 * 只支持 CDP 需要的子集：客户端→服务端发**文本帧**（带掩码），服务端→客户端收文本帧
 * （无掩码），并处理 ping/pong/close 与分片。CDP 消息较大（截图 base64 可达数 MB），
 * 因此完整支持 126 / 127 两种扩展长度。
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @param {string} rawUrl
 * @returns {{secure:boolean, host:string, port:number, path:string}}
 */
function parseWsUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch (e) {
    throw new Error('非法 WebSocket 地址：' + rawUrl);
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('仅支持 ws/wss 地址：' + rawUrl);
  }
  const secure = u.protocol === 'wss:';
  return {
    secure,
    host: u.hostname,
    port: Number(u.port || (secure ? 443 : 80)),
    path: (u.pathname || '/') + (u.search || ''),
  };
}

class MiniWebSocket {
  /**
   * @param {string} rawUrl
   * @param {{maxPayload?:number}} [opts]
   */
  constructor(rawUrl, opts) {
    const o = opts || {};
    this.url = rawUrl;
    this.maxPayload = o.maxPayload || 64 * 1024 * 1024;
    this.readyState = 'connecting';
    this._buf = Buffer.alloc(0);
    this._frag = [];
    this._handlers = { open: [], message: [], close: [], error: [] };
    this._closed = false;
    this._connect();
  }

  /**
   * @param {'open'|'message'|'close'|'error'} ev
   * @param {Function} fn
   * @returns {this}
   */
  on(ev, fn) {
    if (!this._handlers[ev]) this._handlers[ev] = [];
    this._handlers[ev].push(fn);
    return this;
  }

  _emit(ev, a, b) {
    const list = this._handlers[ev] || [];
    for (const fn of list) {
      try {
        fn(a, b);
      } catch (e) {
        /* 监听器异常不应影响 socket 生命周期 */
      }
    }
  }

  _connect() {
    const info = parseWsUrl(this.url);
    const key = crypto.randomBytes(16).toString('base64');
    const head = [
      'GET ' + info.path + ' HTTP/1.1',
      'Host: ' + info.host + ':' + info.port,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n');

    const sock = info.secure
      ? tls.connect({ host: info.host, port: info.port, servername: info.host })
      : net.connect({ host: info.host, port: info.port });
    this._sock = sock;
    try {
      sock.setNoDelay(true);
    } catch (e) {
      /* 某些 socket 实现不支持，忽略 */
    }

    let handshaked = false;

    const onData = (d) => {
      if (!handshaked) {
        this._buf = Buffer.concat([this._buf, d]);
        const idx = this._buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const headText = this._buf.slice(0, idx).toString('latin1');
        const rest = this._buf.slice(idx + 4);
        this._buf = Buffer.alloc(0);

        const m = /^HTTP\/1\.1\s+(\d{3})/.exec(headText);
        if (!m || m[1] !== '101') {
          this._fail(new Error('WebSocket 握手失败：' + headText.split('\r\n')[0]));
          return;
        }
        const am = /sec-websocket-accept:\s*(\S+)/i.exec(headText);
        const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (!am || am[1] !== expect) {
          this._fail(new Error('WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）'));
          return;
        }
        handshaked = true;
        this.readyState = 'open';
        this._emit('open');
        if (rest.length) this._onBytes(rest);
        return;
      }
      this._onBytes(d);
    };

    const sendHandshake = () => {
      if (this._closed) return;
      try {
        sock.write(head);
      } catch (e) {
        this._fail(e);
      }
    };

    if (info.secure) sock.once('secureConnect', sendHandshake);
    else sock.once('connect', sendHandshake);

    sock.on('data', onData);
    sock.on('error', (e) => this._fail(e));
    sock.on('close', () => {
      const wasOpen = this.readyState !== 'closed';
      this.readyState = 'closed';
      if (wasOpen) this._emit('close');
    });
  }

  _fail(err) {
    if (this._closed && this.readyState === 'closed') return;
    this.readyState = 'closed';
    this._emit('error', err);
    try {
      if (this._sock && !this._sock.destroyed) this._sock.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  /** 拆帧（可跨多次 data 事件） */
  _onBytes(d) {
    this._buf = Buffer.concat([this._buf, d]);
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2);
        const lo = b.readUInt32BE(6);
        len = hi * 4294967296 + lo;
        off = 10;
      }
      if (len > this.maxPayload) {
        this._fail(new Error('WebSocket 帧过大：' + len + ' 字节（上限 ' + this.maxPayload + '）'));
        return;
      }
      let maskKey = null;
      if (masked) {
        if (b.length < off + 4) return;
        maskKey = b.slice(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return; // 帧还没收全
      let payload = b.slice(off, off + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      this._buf = b.slice(off + len);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      // ping → pong
      try {
        this._sendFrame(0xa, payload);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    if (opcode === 0xa) return; // pong
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this._frag.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this._frag);
      this._frag = [];
      // CDP 全程使用文本帧；二进制帧也按 utf8 输出以便诊断
      this._emit('message', full.toString('utf8'));
    }
  }

  _sendFrame(opcode, payload) {
    if (!this._sock || this._sock.destroyed) throw new Error('WebSocket 已关闭，无法发送');
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) {
      header = Buffer.alloc(2 + 4);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4 + 4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10 + 4);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode; // FIN=1
    mask.copy(header, header.length - 4);
    const maskedPayload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) maskedPayload[i] = data[i] ^ mask[i % 4];
    this._sock.write(Buffer.concat([header, maskedPayload]));
  }

  /** 发送文本帧 */
  send(text) {
    this._sendFrame(0x1, text);
  }

  /** 发送关闭帧并断开 */
  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this._sock && !this._sock.destroyed) {
        this._sendFrame(0x8, Buffer.alloc(0));
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (this._sock) this._sock.end();
    } catch (e) {
      /* ignore */
    }
    this.readyState = 'closed';
  }

  /**
   * 等握手完成。
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  waitOpen(timeoutMs) {
    const ms = timeoutMs || 10000;
    return new Promise((resolve, reject) => {
      if (this.readyState === 'open') return resolve();
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('WebSocket 连接超时（' + ms + 'ms）：' + this.url));
      }, ms);
      this.on('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
      this.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
      this.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('WebSocket 在握手前被关闭：' + this.url));
      });
    });
  }
}

module.exports = MiniWebSocket;
module.exports.parseWsUrl = parseWsUrl;
module.exports.WS_GUID = WS_GUID;
