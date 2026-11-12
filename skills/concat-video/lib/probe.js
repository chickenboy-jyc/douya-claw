'use strict';
/**
 * probe.js —— action=probe：本机到底有没有 Concat、什么版本、什么模式。
 *
 * 为什么这个 action 值得存在：没装的时候 render/inspect/frame 一定都失败，
 * 而"失败"这件事模型很容易猜错原因（会去装依赖、改参数、甚至编一句"本机不支持视频"）。
 * 让它可以先花一次调用问清楚，比让它在错误里瞎试便宜得多。
 *
 * 硬要求：**没装也不许抛**。返回可读引导即可。
 */

const { openSession } = require('./mcp');
const { errText, tailText } = require('./format');

/**
 * @param {{env?:Record<string,string|undefined>}=} opts
 * @returns {Promise<{installed:boolean, path:string, source:string, version:string, mode:string,
 *                    protocolVersion:string, toolCount:number, writesUnder:string[], message:string}>}
 */
async function probeConcat(opts) {
  const o = opts || {};
  const opened = await openSession({ env: o.env });
  if (!opened.ok) {
    return {
      installed: false,
      path: '',
      source: '',
      version: '',
      mode: '',
      protocolVersion: '',
      toolCount: 0,
      writesUnder: [],
      message: opened.message,
    };
  }
  const session = opened.session;
  try {
    const hs = session.handshake();
    const serverInfo = (hs && hs.serverInfo) || {};
    const ver = await session.call('concat_version', {});
    let version = String(serverInfo.version || '');
    let mode = '';
    let writesUnder = [];
    if (ver.ok && ver.data && typeof ver.data === 'object') {
      if (ver.data.concat) version = String(ver.data.concat);
      if (ver.data.mcp && ver.data.mcp.mode) mode = String(ver.data.mcp.mode);
      if (ver.data.mcp && Array.isArray(ver.data.mcp.writesUnder)) writesUnder = ver.data.mcp.writesUnder.map(String);
    }
    let toolCount = 0;
    try {
      const tools = await session.client.listTools();
      toolCount = Array.isArray(tools) ? tools.length : 0;
    } catch (e) {
      // 列工具失败不算致命：版本已经拿到了，照样能报"装了"
      toolCount = 0;
    }
    const stderrLine = tailText(session.client.stderrTail(3), 3, 160);
    return {
      installed: true,
      path: session.path,
      source: session.source,
      version: version || '未知',
      mode: mode || '未知',
      protocolVersion: String((hs && hs.protocolVersion) || ''),
      toolCount,
      writesUnder,
      message: stderrLine ? '（Concat 启动日志最后几行：' + stderrLine + '）' : '',
    };
  } catch (e) {
    return {
      installed: false,
      path: session.path,
      source: session.source,
      version: '',
      mode: '',
      protocolVersion: '',
      toolCount: 0,
      writesUnder: [],
      message: '错误：Concat 起来了，但探测版本信息失败：' + errText(e),
    };
  } finally {
    await session.close();
  }
}

/**
 * @param {object} r probeConcat 的返回值
 * @returns {string}
 */
function formatProbe(r) {
  if (!r || !r.installed) {
    return (r && r.message) || '错误：没找到 Concat（视频精剪引擎）。';
  }
  const lines = [];
  lines.push('Concat 已安装：' + r.version + '（' + r.mode + ' 模式）');
  lines.push('可执行文件：' + r.path + '（探测方式：' + r.source + '）');
  lines.push('本机可用工具：' + r.toolCount + ' 个；协商协议：' + (r.protocolVersion || '未知'));
  if (r.writesUnder.length) lines.push('允许写入的根目录：' + r.writesUnder.join('、'));
  if (r.message) lines.push(r.message);
  lines.push('现在可以用 action=render 出一段带标题/字幕/画中画的片子，或用 action=inspect 读已有工程。');
  return lines.join('\n');
}

module.exports = { probeConcat, formatProbe };
