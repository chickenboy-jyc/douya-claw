'use strict';
/**
 * 目标地址校验（安全红线）。
 *
 * 只允许 http / https。**拒绝** file://、ftp://、data:、javascript:、chrome:// 等：
 *   - file:// 会绕过网络边界直接读本机文件（把 C:\... 的内容截进截图/正文里）；
 *   - javascript:/data: 注入等效于执行任意脚本。
 *
 * 内网地址（127.0.0.1 / 192.168.* / 10.* 等）**故意不拒绝**：部署验证场景就是要测
 * 「本机端口 / 内网 IP」上的站点。目标地址会原样记进结论的 evidence，保证可追溯。
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_URL_LEN = 2048;

/**
 * @param {unknown} raw 用户/模型传入的 url
 * @returns {{ok:true, url:string, host:string, port:string} | {ok:false, reason:string}}
 */
function validateUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) {
    return { ok: false, reason: 'url 为空：请提供要验证的网址（http:// 或 https:// 开头）' };
  }
  if (s.length > MAX_URL_LEN) {
    return { ok: false, reason: 'url 过长（超过 ' + MAX_URL_LEN + ' 字符）' };
  }
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return { ok: false, reason: 'url 不是合法网址：' + s };
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return {
      ok: false,
      reason:
        '仅允许 http/https 网址，拒绝协议 ' + u.protocol +
        '（出于安全，file://、ftp://、data:、javascript: 等一律不允许）',
    };
  }
  if (!u.hostname) {
    return { ok: false, reason: 'url 缺少主机名：' + s };
  }
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  return { ok: true, url: u.toString(), host: u.hostname, port: u.port || defaultPort };
}

module.exports = { validateUrl, ALLOWED_PROTOCOLS, MAX_URL_LEN };
