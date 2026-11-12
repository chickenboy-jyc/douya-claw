/**
 * dshClient.js —— 把 DeepSeek Harness（dsh）当**进程外 agent 底座**驱动的 ACP 客户端。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么是这个形态（2026-11-11 实测确认，别再改成"换 runAgentLoop 内部实现"）
 * ═══════════════════════════════════════════════════════════════════════════
 *   `dsh` 只是 CLI（bin → lib/bin.js），**没有可编程对话导出**；
 *   `@deepseek-ai/dsh-agent-loop` 是 Cordis 插件，靠 `ctx.agents.create()` 驱动，
 *   要整棵插件树 + Session + Provider —— 直接当 impl 用等于重写宿主。
 *
 *   正路是 `@deepseek-ai/dsh-acp`：**JSON-RPC 2.0 stdio 服务器**。
 *   它自己的 README.zh 原话：「让受信程序通过标准 ACP 自动操作持久 DeepSeek Harness
 *   agent」「进程外 subagent、测试运行器与脚本化控制器适合选择它」。
 *   即：**它就是给"另一个 harness"准备的**，我们正好是那个"另一个 harness"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 启动方式（三处都是踩过坑才定下来的，别削）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① `ELECTRON_RUN_AS_NODE=1` + **同一个 exe** 跑 asar 内的 bin.js。
 *      dsh 没有独立 node，`resources/runtime/bin/node` 只是转发脚本，
 *      它 exec 的是 `$DSH_DESKTOP_NODE_EXECUTABLE`（= 主程序 exe）。
 *      实测：Electron 的 Node 模式**是支持 asar 的**，不需要解包。
 *   ② 路径必须是 **Windows 原生形式**（`C:\...`）。
 *      传 MSYS 形式 `/c/Users/...` 会被 Node 当相对路径拼成 `c:\c\Users\...`
 *      ⇒ `Cannot find module`。这个报错长得像"asar 不支持"，其实是路径问题，
 *      曾经据此误判为"必须解包 331 个包"，走了大弯路。
 *   ③ `--expose-internals` 不能省（dsh 内部用到 Node 内部模块）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 协议事实（initialize 实回，不是查文档抄的）
 * ═══════════════════════════════════════════════════════════════════════════
 *   protocolVersion              = 1
 *   agentInfo                    = { name: 'deepseek-harness-acp', version: '0.0.1' }
 *   agentCapabilities            = {
 *     mcpCapabilities:    { http: true },
 *     promptCapabilities: { image: false, audio: false, embeddedContext: false },
 *     sessionCapabilities:{ close: {}, list: {}, resume: {} },
 *   }
 *   authMethods = []   ← 服务器不需要身份验证，`authenticate` 立即成功
 *
 *   ★ v1 里这个字段叫 `agentCapabilities`；另有一个**少了前缀的写法并不存在**，
 *     按那个读会得到 undefined，然后"看起来像没能力"。
 *     此处故意不把错误写法原样写出来 —— 门禁按字面量扫源码，写了会被当成真代码。
 *
 *   stdout 只承载**换行分隔的 ACP JSON-RPC 帧**；日志全在 stderr。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 模型路由（这一条是真会拦住人的坑）
 * ═══════════════════════════════════════════════════════════════════════════
 *   `session/new` 公布的 model 是**两个组**：
 *     group 'deepseek-official' → 要裸 `DEEPSEEK_API_KEY`；
 *                                 本机没有 ⇒ 报
 *                                 `no API key for provider route "deepseek-official"`。
 *     group 'deepseek-account'  → 用 `~/.dsh/.credentials.yaml` 的
 *                                 `deepseek-account-platform/default` 平台 token，
 *                                 **本机唯一能直接走通的路由**。
 *   所以 acp profile 的 `cordis.patch.yml` 里把 provider 改成了 `deepseek-account`
 *   （见 `~/.dsh/profiles/acp/cordis.patch.yml`）。
 *   model 的取值是 **JSON 数组字符串**：`'["deepseek-account","deepseek-v4-pro"]'`，
 *   不是 `{provider, model}` 对象 —— 传对象会被当非法值。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 失败方向（写清楚，因为这里有一个 fail-open 的口子）
 * ═══════════════════════════════════════════════════════════════════════════
 *   `onPermission`：服务器发 `session/request_permission` 时怎么答。
 *     · `'allow'`（**默认**）→ 自动选 allow 选项。这是 **fail-open**：
 *       无人值守能跑下去，代价是"模型想干什么就让它干"。
 *       实测 cwd 内的文件写入**根本不会**触发权限询问，所以这个默认值在
 *       常规任务上不放大风险；但一旦触发（例如越出 workspace），
 *       它确实会放行 —— 因此**每次自动放行都打一条 warn 日志**，可审计。
 *     · `'deny'` → 自动选 reject 选项，任务会因此失败。要审计的话用这个。
 *     · `function(params) => 'allow' | 'deny' | optionId` → 自己判。
 *   spawn 失败 / 服务器异常退出 ⇒ **抛错**（fail-closed），不返回空结果冒充"跑完了"。
 *   这条与 backend.js 的铁律一致：不许"算出来了但没人读"，也不许"没跑却像跑完了"。
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { decodeOutput } = require('./childOutput');

/** ACP 帧是换行分隔的 JSON-RPC 2.0。 */
const ACP_PROTOCOL_VERSION = 1;

/** exe 候选路径（按顺序找第一个存在的）。 */
function defaultExeCandidates() {
  const out = [];
  const la = process.env.LOCALAPPDATA;
  const pf = process.env.PROGRAMFILES;
  const pfx86 = process.env['PROGRAMFILES(X86)'];
  // 安装器建的目录名带空格；社区版/内测版目录名可能小写、带连字符，都兜一下。
  const names = ['DeepSeek Harness', 'deepseek-harness', 'dsh'];
  for (const base of [la && path.join(la, 'Programs'), pf, pfx86]) {
    if (!base) continue;
    for (const n of names) out.push(path.join(base, n, 'DeepSeek Harness.exe'));
  }
  return out;
}

/**
 * 定位 dsh 的可执行文件与 asar 内的 bin.js。
 *
 * 三条硬规矩（每条都对应一次踩过的坑）：
 *   ① **显式指定的路径不许被静默回落**。`exePath` / `DSH_EXECUTABLE` 给了就必须是它；
 *      不存在就报错。否则"我指了它、跑的却是另一个 exe"这种事故要几个月后才暴露。
 *   ② **MSYS 形式路径直接拦**。见下面的详细说明。
 *   ③ **bin.js 的存在性只在能看见 asar 内部时才断言**。
 *      纯 Node 的 fs **看不进 .asar**（Electron 主进程能）。在纯 Node 里
 *      `fs.existsSync('<...>/app.asar/dsh/.../bin.js')` 恒为 false，
 *      拿它判"路径错了"会得出完全错误的结论 —— 这条正是上面 ① 那个假错的来源。
 *
 * @param {{exePath?:string}} [opts]
 * @returns {{exe:string, bin:string, resources:string, source:string}}
 * @throws 找不到时抛错（**不猜、不返回空串**）
 */
function resolveDshPaths(opts) {
  const o = opts || {};
  const explicit = o.exePath ? String(o.exePath) : process.env.DSH_EXECUTABLE ? String(process.env.DSH_EXECUTABLE) : null;
  const where = o.exePath ? 'exePath 选项' : 'DSH_EXECUTABLE 环境变量';

  // ★ MSYS/Git-Bash 形式（`/c/Users/...`、`/home/x`）在 Windows 上不是绝对路径。
  //   Node 会把它当相对路径拼成 `c:\c\Users\...`，最终报
  //   `Cannot find module 'c:\c\Users\...\app.asar\...\bin.js'`。
  //   这个错**极像"Electron 的 Node 模式不支持 asar"**，我们据此误判过一次，
  //   差点去解包 331 个包。所以显式拦掉，给出可操作提示。
  //   在 Windows 上任何以 `/` 开头的路径都是非法输入，所以判据就是首字符是 `/`。
  const assertNotMsys = (p) => {
    if (process.platform === 'win32' && /^\//.test(p)) {
      throw new Error(
        'dshClient: 收到 MSYS/Git-Bash 形式路径 ' +
          JSON.stringify(p) +
          '\n请改用 Windows 原生形式，例如 C:\\Users\\...\\DeepSeek Harness.exe' +
          '\n（Windows 上以 / 开头的路径不是绝对路径，会被拼成 c:\\c\\... 然后报一个看起来像"asar 不支持"的错）',
      );
    }
  };
  const isFile = (p) => {
    try {
      return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  let exe = null;
  let source = '';
  if (explicit) {
    assertNotMsys(explicit);
    if (!isFile(explicit)) {
      throw new Error(
        'dshClient: ' +
          where +
          ' 指定的可执行文件不存在：' +
          explicit +
          '\n（显式指定不会被自动探测覆盖 —— 静默改用别的 exe 会让"我指了它、跑的却是另一个"这种事故查不出来）',
      );
    }
    exe = explicit;
    source = where;
  } else {
    const cands = defaultExeCandidates();
    for (const c of cands) {
      assertNotMsys(c);
      if (isFile(c)) {
        exe = c;
        break;
      }
    }
    if (!exe) {
      throw new Error(
        'dshClient: 找不到 DeepSeek Harness 可执行文件。已尝试：\n  ' +
          cands.join('\n  ') +
          '\n可用 DSH_EXECUTABLE 环境变量或 exePath 选项指定。',
      );
    }
    source = '自动探测';
  }

  // exe 在 `<install>/DeepSeek Harness.exe`，资源在同级 resources/
  const resources = path.join(path.dirname(exe), 'resources');
  const asar = path.join(resources, 'app.asar');
  if (!fs.existsSync(asar)) {
    throw new Error('dshClient: 找到 exe 但同级 resources/app.asar 不存在：' + asar + '\n（安装不完整？）');
  }
  const bin = path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  // 见规矩 ③：纯 Node 看不进 asar，所以只在 Electron 里才断言 bin.js 真的在。
  const inElectron = typeof process.versions.electron === 'string';
  if (inElectron && !fs.existsSync(bin)) {
    throw new Error('dshClient: app.asar 内找不到 dsh bin.js：' + bin + '\n（Harness 版本不匹配？期望路径 dsh/node_modules/@deepseek-ai/dsh/lib/bin.js）');
  }
  return { exe, bin, resources, source };
}

/**
 * 从 ACP 的 `session/new` 返回里挑出「模型路由」组，用于把 provider/model 拆开。
 * 提出来是为了让调用方不必自己记 `'["provider","model"]'` 这个字符串格式。
 *
 * @param {Array<object>} configOptions
 * @returns {{groups:Array<{group:string,name:string,models:Array<{value:string,name:string}>}>,
 *            current:string|null, valueFor:(provider:string,model:string)=>string, parse:(v:string)=>{provider:string,model:string}|null}}
 */
function modelRoute(configOptions) {
  const opt = (configOptions || []).find((o) => o && o.id === 'model');
  const groups = [];
  for (const g of (opt && opt.options) || []) {
    const models = [];
    for (const m of g.options || []) models.push({ value: m.value, name: m.name });
    groups.push({ group: g.group, name: g.name, models });
  }
  return {
    groups,
    current: opt ? opt.currentValue : null,
    valueFor(provider, model) {
      return JSON.stringify([String(provider), String(model)]);
    },
    parse(v) {
      try {
        const a = JSON.parse(String(v));
        if (Array.isArray(a) && a.length === 2) return { provider: String(a[0]), model: String(a[1]) };
      } catch {
        /* 不是数组字符串 */
      }
      return null;
    },
  };
}

/**
 * 把调用方给的 model 说法解析成 `set_config_option` 真正要的那个值。
 *
 * ★ 这个函数存在的原因（真踩过）：`set_config_option` 的 value 必须是
 *   **JSON 数组字符串** `'["provider","model"]'`。直接透传裸模型名
 *   `'deepseek-v4-pro'` 会被服务器拒绝：
 *     `[-32602] Invalid params: unknown model option: deepseek-v4-pro`
 *   头注里写着"不是对象"并不妨碍代码里透传错的形态 —— 所以判据要落在代码上：
 *   **裸名必须靠服务器公布的选项表反查 provider**，绝不自己猜一个（猜错就是这条报错）。
 *
 * 接受三种写法：
 *   · 已是 `'["p","m"]'` 形态 ⇒ 原样返回；
 *   · 裸 model 名（`deepseek-v4-pro` / 显示名 `DeepSeek-V4-Pro`）⇒ 查表补 provider；
 *   · `{provider, model}` 对象 ⇒ 拼串。
 * 查不到 ⇒ **抛错并列出可用项**（不静默回落到默认模型 —— 那会让"我要 pro、跑的是 flash"
 * 这种事故查不出来）。
 *
 * @param {Array<object>} configOptions session/new 返回的选项表
 * @param {string|object} wanted
 * @returns {string}
 */
function resolveModelValue(configOptions, wanted) {
  const mr = modelRoute(configOptions);
  // ① 已是数组字符串：只校验它确实在公布列表里，防止拼错 provider
  if (typeof wanted === 'string' && /^\s*\[/.test(wanted)) {
    const parsed = mr.parse(wanted);
    if (!parsed) throw new Error('dshClient: model 数组字符串解析失败：' + JSON.stringify(wanted));
    const hit = mr.groups.some((g) => g.group === parsed.provider && g.models.some((m) => mr.parse(m.value) && mr.parse(m.value).model === parsed.model));
    if (!hit) {
      throw new Error(
        'dshClient: 服务器未公布该 model 选项 ' + JSON.stringify(wanted) + '\n可用：\n' + describeModelGroups(mr),
      );
    }
    return wanted;
  }
  // ② 对象形态
  let wantModel = '';
  let wantProvider = '';
  if (wanted && typeof wanted === 'object') {
    wantProvider = String(wanted.provider || '');
    wantModel = String(wanted.model || '');
  } else {
    wantModel = String(wanted || '');
  }
  if (!wantModel) throw new Error('dshClient: resolveModelValue 收到空 model');
  // ③ 裸名/显示名 ⇒ 查表
  const hits = [];
  for (const g of mr.groups) {
    if (wantProvider && g.group !== wantProvider) continue;
    for (const m of g.models) {
      const parsed = mr.parse(m.value);
      if (!parsed) continue;
      if (parsed.model === wantModel || m.name === wantModel) hits.push({ group: g.group, value: m.value, parsed });
    }
  }
  if (hits.length === 1) return hits[0].value;
  if (hits.length > 1) {
    // 同名模型出现在多个 provider 组里 ⇒ 必须由调用方指定 provider，别替它选。
    throw new Error(
      'dshClient: model ' + JSON.stringify(wantModel) + ' 在多个 provider 下都存在，请显式指定 provider：\n' +
        hits.map((h) => '  ' + h.group + ' → ' + h.value).join('\n'),
    );
  }
  throw new Error(
    'dshClient: 服务器没公布 model ' + JSON.stringify(wantModel) + '\n可用：\n' + describeModelGroups(mr),
  );
}

function describeModelGroups(mr) {
  const out = [];
  for (const g of mr.groups) {
    for (const m of g.models) out.push('  [' + g.group + '] ' + m.name + '  →  ' + m.value);
  }
  return out.length ? out.join('\n') : '  (服务器没有公布任何 model 选项)';
}


/**
 * 建一个 dsh ACP 客户端。**一个客户端 = 一个服务器进程**，可开多个会话
 * （README 明说：一个连接可以同时运行多个会话，彼此独立）。
 *
 * @param {{exePath?:string, profile?:string, cwd?:string, model?:string, effort?:string,
 *          onPermission?:'allow'|'deny'|Function, logger?:{info:Function,warn:Function,error:Function},
 *          promptTimeoutMs?:number, startTimeoutMs?:number}} [options]
 */
function createDshClient(options) {
  const o = options || {};
  const log = o.logger || {
    info: (m) => console.log('[dsh]', m),
    warn: (m) => console.warn('[dsh]', m),
    error: (m) => console.error('[dsh]', m),
  };
  const profile = String(o.profile || 'acp');
  const defaultCwd = o.cwd ? path.resolve(String(o.cwd)) : process.cwd();
  const promptTimeoutMs = Number(o.promptTimeoutMs) > 0 ? Number(o.promptTimeoutMs) : 15 * 60 * 1000;
  const startTimeoutMs = Number(o.startTimeoutMs) > 0 ? Number(o.startTimeoutMs) : 30 * 1000;
  const onPermission = o.onPermission === undefined ? 'allow' : o.onPermission;

  /** @type {import('child_process').ChildProcess|null} */
  let child = null;
  let starting = null;
  let disposed = false;
  let nextId = 1;
  const pending = new Map(); // id → {resolve, reject, method}
  const sessionUpdates = new Map(); // sessionId → Array<params>（仅在 prompt 期间收集）
  let stdoutBuf = '';
  /**
   * stderr 的**原始字节**（不在这里解字符）。
   * 为什么留 Buffer 而不是留字符串：`decodeOutput()` 要同时看 GBK / UTF-8 两种解法的
   * U+FFFD 数量才能判，**必须拿到完整字节**；先 toString 再拼就已经把信息丢了。
   * 只在真要展示的时候（进程退出、拼进 failAll）解一次。
   */
  let stderrTail = Buffer.alloc(0);
  /** ACP 是 UTF-8 的 JSON-RPC 流。用 StringDecoder 而不是逐块 toString('utf8')：
   *  一个中文字符的 3 个字节**可能被 TCP/pipe 切成两块**，逐块解会把半个字符解成 U+FFFD，
   *  于是 JSON 里的中文变成 `�`（协议本身没坏，内容坏了）。StringDecoder 会把
   *  不完整的多字节尾巴留在内部，等下一块到了再一起吐。 */
  const stdoutDecoder = new StringDecoder('utf8');
  let serverInfo = null;

  function send(obj) {
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error('dshClient: 服务器 stdin 不可写（进程未启动或已退出）');
    }
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error('dshClient: ' + method + ' 超时 ' + timeoutMs + 'ms'));
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }
      pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
        method,
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function failAll(reason) {
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
  }

  function pickPermissionOption(params) {
    const opts = (params && params.options) || [];
    const allow = opts.find((x) => /allow/i.test(String(x.optionId || '')) || /allow/i.test(String(x.kind || '')));
    const deny = opts.find((x) => /reject|deny/i.test(String(x.optionId || '')) || /reject|deny/i.test(String(x.kind || '')));
    let decision = 'allow';
    if (typeof onPermission === 'function') {
      try {
        decision = onPermission(params);
      } catch (e) {
        log.warn('onPermission 抛错，按 deny 处理：' + e.message);
        decision = 'deny';
      }
    } else {
      decision = onPermission;
    }
    if (decision === 'deny') return (deny || opts[0] || {}).optionId;
    if (decision && decision !== 'allow') return decision; // 已是 optionId
    // fail-open：默认放行。**每次自动放行都留痕**，否则无人值守时等于没有审计面。
    const chosen = (allow || opts[0] || {}).optionId;
    log.warn(
      '自动放行权限询问：' +
        JSON.stringify((params && params.toolCall && params.toolCall.title) || '') +
        ' → optionId=' +
        chosen,
    );
    return chosen;
  }

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // stdout 只应有协议帧。出现非 JSON ⇒ 有插件在污染 stdout，必须让它可见。
      log.warn('stdout 出现非 JSON 内容（有插件在污染协议通道）：' + line.slice(0, 200));
      return;
    }
    if (msg.method) {
      // ── 服务器 → 客户端 ──
      if (msg.method === 'session/update') {
        const sid = msg.params && msg.params.sessionId;
        const arr = sessionUpdates.get(sid);
        if (arr) arr.push(msg.params);
        return;
      }
      if (msg.method === 'session/request_permission') {
        const optionId = pickPermissionOption(msg.params);
        reply(msg.id, { outcome: { outcome: 'selected', optionId } });
        return;
      }
      // 其余服务端请求：一律空成功回复，避免对端永久挂起（挂起比报错更难查）。
      if (msg.id != null) {
        log.warn('未处理的服务端请求，空成功回复：' + msg.method);
        reply(msg.id, {});
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) {
      const e = msg.error;
      p.reject(new Error(p.method + ' → [' + e.code + '] ' + (e.message || JSON.stringify(e))));
    } else {
      p.resolve(msg.result);
    }
  }

  function attach(childProc) {
    childProc.stdout.on('data', (d) => {
      // ACP 通道：协议规定 UTF-8 ⇒ 用 StringDecoder（不是 decodeOutput，也不逐块 toString）。
      // 见上方 stdoutDecoder 的注释：逐块 toString 会把跨块的多字节中文解成 U+FFFD。
      stdoutBuf += stdoutDecoder.write(d);
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, i).trim();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (line) handleLine(line);
      }
    });
    childProc.stderr.on('data', (d) => {
      // ★ 2026-11-11 修（门禁 unit-child-output-decode B1 抓出来的）：
      //   原来这一行是裸 `d.toString('utf8')`。它最终会拼进 failAll 的报错文案
      //   （下面 exit 处理器里的 `\nstderr 尾部:\n` + stderrTail）—— 那是**给人看**的文本，
      //   按仓库既定口径（childOutput.js 头注）必须走 decodeOutput()。
      //   不这么做的后果不是"报错"，而是报错里的中文全变成 `�`：
      //   dsh 在中文 Windows 上按 GBK 写 stderr 时，用户拿到的唯一诊断线索是一串乱码。
      //   保留字节不保留字符的理由见 stderrTail 的声明处。
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      stderrTail = Buffer.concat([stderrTail, buf]);
      // 只留尾部 8KB（原来是按字符切 4000；改按字节切，真实占用略有不同但同量级）。
      // 为什么要截：dsh 是长任务（最长 15 分钟），stderr 可能被刷到几 MB。
      if (stderrTail.length > 8192) stderrTail = stderrTail.subarray(stderrTail.length - 8192);
    });
    childProc.stdin.on('error', (e) => log.warn('stdin 错误：' + e.message));
    childProc.on('exit', (code, signal) => {
      child = null;
      starting = null;
      // 这里才是唯一需要"给人看"的时机 ⇒ 此时才解字符，且走 decodeOutput（GBK / UTF-8 择优）。
      const tailText = stderrTail.length ? decodeOutput(stderrTail) : '';
      failAll(
        'dshClient: 服务器进程退出 code=' + code + ' signal=' + signal + (tailText ? '\nstderr 尾部:\n' + tailText : ''),
      );
    });
  }

  /** 启动服务器（幂等）。 */
  async function start() {
    if (disposed) throw new Error('dshClient: 已 dispose，不能再用');
    if (child) return;
    if (starting) return starting;
    const paths = resolveDshPaths({ exePath: o.exePath });
    starting = (async () => {
      const proc = spawn(paths.exe, ['--expose-internals', paths.bin, '--profile', profile], {
        cwd: defaultCwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child = proc;
      attach(proc);
      const init = await request(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
        startTimeoutMs,
      );
      serverInfo = {
        protocolVersion: init && init.protocolVersion,
        agentInfo: (init && init.agentInfo) || null,
        agentCapabilities: (init && init.agentCapabilities) || null,
        authMethods: (init && init.authMethods) || [],
        exe: paths.exe,
        profile,
      };
      log.info(
        '服务器就绪 protocolVersion=' +
          serverInfo.protocolVersion +
          ' agent=' +
          JSON.stringify(serverInfo.agentInfo) +
          ' sessionCapabilities=' +
          JSON.stringify((serverInfo.agentCapabilities || {}).sessionCapabilities || null),
      );
      return serverInfo;
    })();
    try {
      return await starting;
    } catch (e) {
      // 启动失败不留半死进程
      try {
        if (child) child.kill();
      } catch {
        /* ignore */
      }
      child = null;
      throw e;
    } finally {
      starting = null;
    }
  }

  /**
   * 新会话。
   * @param {{cwd?:string, mcpServers?:Array<object>, model?:string|object, effort?:string}} [opts]
   * @returns {Promise<{sessionId:string, configOptions:Array<object>, modelRoute:object}>}
   */
  async function newSession(opts) {
    const s = opts || {};
    await start();
    const cwd = path.resolve(String(s.cwd || defaultCwd));
    const r = await request('session/new', { cwd, mcpServers: s.mcpServers || [] }, startTimeoutMs);
    const sid = r && r.sessionId;
    if (!sid) throw new Error('dshClient: session/new 没返回 sessionId：' + JSON.stringify(r));
    const opts_ = r.configOptions || [];
    // ★ 顺序要紧：先拿到 configOptions 再解析 model —— 解析函数要靠它反查 provider。
    if (s.model) {
      const value = resolveModelValue(opts_, s.model);
      await setConfigOption(sid, 'model', value);
    }
    if (s.effort) await setConfigOption(sid, 'reasoning_effort', String(s.effort));
    return { sessionId: sid, configOptions: opts_, modelRoute: modelRoute(opts_) };
  }

  /**
   * 改会话配置（model / reasoning_effort）。返回值带完整 configOptions 现状。
   * @param {string} sessionId
   * @param {string} configId
   * @param {string} value
   */
  async function setConfigOption(sessionId, configId, value) {
    const r = await request('session/set_config_option', { sessionId, configId, value }, startTimeoutMs);
    return r;
  }

  /**
   * 发一轮提示词，流式消费更新。
   *
   * ★ `runOpts.signal` 的语义很关键，别省：外层（runSkill 的 runWithTimeoutAndAbort）
   *   超时或用户叫停时**只会 reject 那个 Promise，不会替你停底层进程**。
   *   不把 signal 接进来，dsh 会在后台继续跑、继续写文件，而豆芽已经把这轮判成失败
   *   ⇒ 出现「一个没人管的第二执行者」，正是 agentRuntime.js 头注要堵的那个洞。
   *   这里接到 signal 就调 `session/cancel`（停稳式：取消 → drain → flush），
   *   然后**抛错**告诉调用方"这轮是叫停的，不是正常完成"。
   *
   * @param {string} sessionId
   * @param {string|Array<{type:string,text?:string}>} prompt 纯文本或 ACP content 块数组
   * @param {{onUpdate?:(u:object)=>void, timeoutMs?:number, signal?:AbortSignal}} [runOpts]
   * @returns {Promise<{stopReason:string, text:string, thoughts:string, updates:Array<object>,
   *                    toolCalls:Array<{toolCallId:string,title:string,kind:string,status:string,
   *                                     rawInput:object|null,content:Array<object>|null}>}>}
   */
  async function prompt(sessionId, prompt, runOpts) {
    const ro = runOpts || {};
    const blocks = typeof prompt === 'string' ? [{ type: 'text', text: String(prompt) }] : prompt;
    if (!Array.isArray(blocks) || !blocks.length) {
      throw new TypeError('dshClient.prompt: prompt 必须是非空字符串或 content 块数组');
    }
    const signal = ro.signal || null;
    if (signal && signal.aborted) {
      throw new Error('dshClient.prompt: 调用前就已被叫停，未提交提示词');
    }
    // 若上一轮没清，先清 —— 否则本轮 updates 会混进上一轮的尾巴
    if (sessionUpdates.has(sessionId)) sessionUpdates.delete(sessionId);
    const bag = [];
    sessionUpdates.set(sessionId, bag);

    // 流式转发：轮询太脏，改用每个帧到达时立刻回调
    const originalPush = bag.push.bind(bag);
    bag.push = (v) => {
      if (typeof ro.onUpdate === 'function') {
        try {
          ro.onUpdate(v);
        } catch (e) {
          log.warn('onUpdate 回调抛错（已忽略，不影响协议）：' + e.message);
        }
      }
      return originalPush(v);
    };

    let aborted = false;
    let onAbort = null;
    if (signal) {
      onAbort = () => {
        aborted = true;
        // 不 await：事件处理器里不能阻塞；失败也不致命（下面 still 靠 aborted 标记判结果）
        cancel(sessionId).catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const r = await request(
        'session/prompt',
        { sessionId, prompt: blocks },
        Number(ro.timeoutMs) > 0 ? Number(ro.timeoutMs) : promptTimeoutMs,
      );
      if (aborted) {
        // 服务器已停稳，但这一轮不能算"正常完成"—— 调用方必须看得见这是叫停。
        throw new Error('dshClient.prompt: 已被叫停（已发送 session/cancel 并等待停稳）');
      }
      return summarize(r, bag);
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (sessionUpdates.get(sessionId) === bag) sessionUpdates.delete(sessionId);
    }
  }

  function summarize(r, bag) {
    const texts = [];
    const thoughts = [];
    const calls = new Map();
    for (const p of bag) {
      const u = (p && p.update) || p || {};
      const kind = u.sessionUpdate;
      if (kind === 'agent_message_chunk' && u.content && u.content.type === 'text') texts.push(u.content.text);
      else if (kind === 'agent_thought_chunk' && u.content && u.content.type === 'text') thoughts.push(u.content.text);
      else if (kind === 'tool_call') {
        calls.set(u.toolCallId, {
          toolCallId: u.toolCallId,
          title: u.title,
          kind: u.kind,
          status: u.status || 'pending',
          rawInput: u.rawInput || null,
          content: null,
        });
      } else if (kind === 'tool_call_update' && u.toolCallId) {
        const c = calls.get(u.toolCallId) || { toolCallId: u.toolCallId, title: '', kind: '', rawInput: null };
        if (u.status) c.status = u.status;
        if (u.content) c.content = u.content;
        if (u.title) c.title = u.title;
        calls.set(u.toolCallId, c);
      }
    }
    return {
      stopReason: (r && r.stopReason) || 'unknown',
      text: texts.join(''),
      thoughts: thoughts.join(''),
      updates: bag.slice(),
      toolCalls: Array.from(calls.values()),
    };
  }

  /** 取消该会话进行中的提示词。 */
  async function cancel(sessionId) {
    if (!child) return;
    try {
      await request('session/cancel', { sessionId }, 5000);
    } catch (e) {
      log.warn('session/cancel 失败（不致命）：' + e.message);
    }
  }

  /** 关闭会话（停稳式：取消、drain、持久化 flush、释放 agent 作用域）。 */
  async function close(sessionId) {
    if (!child) return;
    try {
      await request('session/close', { sessionId }, 60 * 1000);
    } catch (e) {
      log.warn('session/close 失败（不致命）：' + e.message);
    }
    sessionUpdates.delete(sessionId);
  }

  /** 列出已持久化、可恢复的会话。 */
  async function listSessions(filter) {
    await start();
    const params = {};
    if (filter && filter.cwd) params.cwd = path.resolve(String(filter.cwd));
    return request('session/list', params, startTimeoutMs);
  }

  /** 恢复一个已持久化的会话（不回放历史更新）。 */
  async function resumeSession(sessionId, opts) {
    await start();
    const s = opts || {};
    return request('session/resume', { sessionId, cwd: path.resolve(String(s.cwd || defaultCwd)), mcpServers: s.mcpServers || [] }, startTimeoutMs);
  }

  /** 服务器信息（未启动时为 null）。 */
  function info() {
    return serverInfo;
  }

  /** 释放：关 stdin → 等退出 → 必要时 kill。**不抛**。 */
  async function dispose() {
    disposed = true;
    const proc = child;
    child = null;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      proc.once('exit', fin);
      const t = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        fin();
      }, 2000);
      if (t.unref) t.unref();
    });
    failAll('dshClient: 已 dispose');
  }

  return {
    start,
    newSession,
    setConfigOption,
    prompt,
    cancel,
    close,
    listSessions,
    resumeSession,
    info,
    dispose,
    /** 供门禁断言协议事实，不用去读源码猜。 */
    get serverInfo() {
      return serverInfo;
    },
  };
}

module.exports = {
  createDshClient,
  resolveDshPaths,
  modelRoute,
  resolveModelValue,
  ACP_PROTOCOL_VERSION,
};