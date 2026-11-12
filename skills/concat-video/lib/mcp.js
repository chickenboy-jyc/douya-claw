'use strict';
/**
 * mcp.js —— 技能与 Concat 之间唯一的一层：找可执行文件、开会话、包一层调用。
 *
 * ── 三条硬边界（都是踩出来的，改之前先读完）──────────────────────────────
 * ① **DOUYA_CONCAT_PATH 说了算**。用户显式配了一个不存在/非文件的路径时，
 *    必须如实报「没找到」，**绝不回落到自动探测**。否则「我把路径指到 A，它偷偷用了 B」
 *    会让用户以为自己配对了 —— 这是最难查的一类假成功。
 *    ⚠️ 注意 `findConcatExecutable()` 自身的语义是「显式路径不是文件就继续往下探」，
 *    所以这一层的判断**必须写在调用它之前**，不能指望下游。
 * ② **工具级失败与协议层失败分开**。`result.isError === true` 是"这件事没干成"，
 *    JSON-RPC `error` 是"连接/协议出问题"。两者混成一句话，模型会以为 Concat 不可用。
 * ③ **每个会话必须关**。不关就留 concat.exe 孤儿进程（本仓门禁会查残留进程）。
 */

const fs = require('fs');
const path = require('path');
const { errText, tailText } = require('./format');

const CLIENT_MODULE_PATH = path.join(__dirname, '..', '..', '..', 'src', 'main', 'mcpStdioClient.js');

/** 单次 tools/call 的兜底超时：导出与等导出可能跑好几分钟。 */
const CALL_TIMEOUT_MS = 600000;

const CONCAT_DOWNLOAD = 'https://github.com/jub0t/Concat/releases';
const CONCAT_INSTALL_HINT = 'C:\\Users\\<你的用户名>\\AppData\\Local\\Programs\\Concat\\concat.exe';

/** @param {string} p @returns {boolean} */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

let cachedModule = null;
let cachedModuleError = '';

/**
 * 加载仓库里的 MCP 客户端模块（纯 CJS、零依赖，可被普通 node 直接 require）。
 * @returns {object|null}
 */
function loadClientModule() {
  if (cachedModule) return cachedModule;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(CLIENT_MODULE_PATH);
    if (mod && typeof mod.createMcpStdioClient === 'function' && typeof mod.findConcatExecutable === 'function') {
      cachedModule = mod;
      return mod;
    }
    cachedModuleError = '模块导出的成员不对（缺 createMcpStdioClient / findConcatExecutable）';
    return null;
  } catch (e) {
    cachedModuleError = errText(e);
    return null;
  }
}

/**
 * 找 Concat 可执行文件。规则见文件头 ①。
 * @param {Record<string,string|undefined>=} env
 * @returns {{ok:true, path:string, source:string} | {ok:false, reason:string, explicit?:string}}
 */
function locateConcat(env) {
  const e = env || process.env;
  const explicit = typeof e.DOUYA_CONCAT_PATH === 'string' ? e.DOUYA_CONCAT_PATH.trim() : '';
  if (explicit) {
    if (isFile(explicit)) return { ok: true, path: explicit, source: 'DOUYA_CONCAT_PATH' };
    return { ok: false, reason: 'explicit-missing', explicit };
  }
  const mod = loadClientModule();
  if (!mod) return { ok: false, reason: 'client-module-missing' };
  const found = mod.findConcatExecutable();
  if (!found) return { ok: false, reason: 'not-found' };
  return { ok: true, path: found.path, source: String(found.source || 'auto') };
}

/**
 * 「没装」时的可读引导。**不抛异常、不崩**，就是把路指清楚。
 * @param {{reason:string, explicit?:string}} loc
 * @returns {string}
 */
function missingGuide(loc) {
  const r = (loc && loc.reason) || 'not-found';
  if (r === 'explicit-missing') {
    return '错误：DOUYA_CONCAT_PATH 指向的文件不存在或不是文件：' + String(loc.explicit) + '\n' +
      '你显式配置了这个路径，所以不会再自动去找别的安装位置（避免"以为配好了、实际用了另一个"）。\n' +
      '请把它改成本机 concat.exe 的真实完整路径，或删掉这个环境变量改用自动探测（默认位置：' + CONCAT_INSTALL_HINT + '）。';
  }
  if (r === 'client-module-missing') {
    return '错误：豆芽内部的 Concat 客户端模块加载失败（src/main/mcpStdioClient.js：' + (cachedModuleError || '未知原因') + '）。\n' +
      '这不是没装 Concat，而是豆芽自己的组件有问题，请把这个错误报给开发者。';
  }
  return '错误：没找到 Concat（视频精剪引擎），本机没装或装在了非默认位置。\n' +
    '怎么办：\n' +
    '  1) 下载：' + CONCAT_DOWNLOAD + ' （Windows 选 Concat_x.y.z_x64-setup.exe，用户级安装即可，不用管理员）\n' +
    '  2) 默认会装到 ' + CONCAT_INSTALL_HINT + '\n' +
    '  3) 装完回来说一句「检查 Concat 装好了吗」（action=probe），确认版本正常\n' +
    '  4) 如果装在别处：把环境变量 DOUYA_CONCAT_PATH 设成那个 concat.exe 的完整路径再试\n' +
    '这段期间「视频精剪」用不了；只想裁剪/拼接单轨，可以先用「处理音视频」技能。';
}

/**
 * 把工具返回的 structuredContent / 文本 JSON 抠出来。
 * @param {*} res
 * @returns {*}
 */
function pickData(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
  const parts = Array.isArray(res.content) ? res.content : [];
  const text = parts
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * 工具级错误 → 中文人话。
 * 错误码来自 Concat 自己（实测见过：failed / notOpen / invalid / busy / noSuchProject）。
 * @param {string} tool
 * @param {string} code
 * @param {string} raw
 * @returns {string}
 */
function explainToolError(tool, code, raw) {
  const why = raw ? '（Concat 原话：' + raw + '）' : '';
  switch (code) {
    case 'notOpen':
      return '这个工程当前没打开，Concat 只接受"已打开的工程"。通常是前面建工程那一步就失败了。' + why;
    case 'invalid':
      return '参数不被 Concat 接受。' + why;
    case 'busy':
      return 'Concat 正在忙（同一时间只允许一个导出任务），等它结束再试。' + why;
    case 'noSuchProject':
    case 'notFound':
      return 'Concat 找不到这个工程或对象（目录被挪走/删掉，或 id 过期了）。' + why;
    case 'failed':
      return 'Concat 说这一步没做成。' + why;
    default:
      return 'Concat 报了一个错误 [code=' + code + ']。' + why;
  }
}

/**
 * 开一个会话：spawn concat.exe --mcp + 完成 initialize 握手。
 * 失败时**不抛**，返回 {ok:false, message}（调用方直接把 message 交给用户）。
 *
 * @param {{env?:Record<string,string|undefined>}=} opts
 * @returns {Promise<{ok:true, session:object} | {ok:false, message:string, loc:object}>}
 */
async function openSession(opts) {
  const o = opts || {};
  const loc = locateConcat(o.env);
  if (!loc.ok) return { ok: false, loc, message: missingGuide(loc) };
  const mod = loadClientModule();
  if (!mod) return { ok: false, loc, message: missingGuide({ reason: 'client-module-missing' }) };

  let client = null;
  try {
    client = mod.createMcpStdioClient({ command: loc.path, args: ['--mcp'], defaultTimeoutMs: CALL_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, loc, message: '错误：启动 Concat 失败：' + errText(e) };
  }

  /** 最后几行 stderr（裁剪过），报错时附上 */
  const stderrTail = () => {
    try {
      return tailText(client.stderrTail(6), 6, 240);
    } catch {
      return '';
    }
  };

  try {
    await client.initialize();
  } catch (e) {
    const spawnMsg = client && client.spawnError ? client.spawnError.message : '';
    const tail = stderrTail();
    await safeClose(client);
    return {
      ok: false,
      loc,
      message: '错误：Concat 启动了但握手没成功：' + (spawnMsg || errText(e)) +
        (tail ? '（Concat 最后的输出：' + tail + '）' : ''),
    };
  }

  const session = {
    client,
    path: loc.path,
    source: loc.source,
    /** @returns {{serverInfo:object|null, protocolVersion:string|null}} */
    handshake() {
      return { serverInfo: client.serverInfo, protocolVersion: client.negotiatedProtocolVersion };
    },
    /**
     * 调一个工具，永不抛。
     * @param {string} name
     * @param {object=} args
     * @param {{timeoutMs?:number, onProgress?:Function}=} callOpts
     * @returns {Promise<{ok:boolean, data:*, code:string, message:string, raw:*, name:string}>}
     */
    async call(name, args, callOpts) {
      const opt = callOpts || {};
      const timeoutMs = Number.isFinite(opt.timeoutMs) && opt.timeoutMs > 0 ? opt.timeoutMs : CALL_TIMEOUT_MS;
      try {
        const res = await client.callTool(name, args || {}, {
          timeoutMs,
          onProgress: opt.onProgress,
        });
        return normalizeResult(name, res);
      } catch (e) {
        const code = e && e.code ? String(e.code) : 'rpc';
        let message;
        if (code === 'mcp-timeout') {
          message = 'Concat 在 ' + Math.round(timeoutMs / 1000) + ' 秒内没回应 [' + name + ']，按超时处理。' +
            '导出很长的片子时需要更久，可以切成小段或调大超时。';
        } else {
          message = '与 Concat 的通信出错了（协议层，不是工具报错）：' + errText(e);
          if (e && e.rpcCode !== undefined) message += '（JSON-RPC 错误码 ' + String(e.rpcCode) + '）';
        }
        const tail = stderrTail();
        if (tail) message += '（Concat 最后的输出：' + tail + '）';
        return { ok: false, data: null, code, message, raw: null, name };
      }
    },
    /** @returns {Promise<void>} */
    async close() {
      await safeClose(client);
    },
    /** @returns {boolean} 子进程是否已退出（给孤儿进程检查用） */
    isClosed() {
      try {
        return client.isClosed();
      } catch {
        return true;
      }
    },
  };
  return { ok: true, session, loc };
}

/**
 * @param {string} name
 * @param {*} res
 * @returns {{ok:boolean, data:*, code:string, message:string, raw:*, name:string}}
 */
function normalizeResult(name, res) {
  const data = pickData(res);
  const isErr = !!(res && res.isError === true);
  if (!isErr) return { ok: true, data, code: '', message: '', raw: res, name };
  let code = 'tool-error';
  let raw = '';
  if (data && data.error && typeof data.error === 'object') {
    if (data.error.code) code = String(data.error.code);
    if (data.error.message) raw = String(data.error.message);
  }
  if (!raw && data && typeof data.text === 'string') raw = data.text;
  if (!raw) {
    const parts = Array.isArray(res && res.content) ? res.content : [];
    raw = parts.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join(' ');
  }
  return { ok: false, data, code, message: explainToolError(name, code, raw), raw: res, name };
}

/**
 * 关会话：先让 MCP 客户端走自己的优雅关闭（关 stdin → SIGTERM → SIGKILL）。
 * 关不掉也不抛，但会在返回值里体现 —— 调用方据此判断有没有孤儿风险。
 * @param {object} client
 * @returns {Promise<{ok:boolean, forced:boolean, error:string}>}
 */
async function safeClose(client) {
  if (!client) return { ok: true, forced: false, error: '' };
  try {
    const r = await client.close();
    return { ok: true, forced: !!(r && r.forced), error: '' };
  } catch (e) {
    return { ok: false, forced: false, error: errText(e) };
  }
}

module.exports = {
  loadClientModule,
  locateConcat,
  missingGuide,
  openSession,
  safeClose,
  pickData,
  explainToolError,
  CALL_TIMEOUT_MS,
  CONCAT_DOWNLOAD,
  CONCAT_INSTALL_HINT,
  CLIENT_MODULE_PATH,
};
