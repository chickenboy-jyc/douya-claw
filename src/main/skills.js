// 技能插件系统 —— 对标原版 skillhub 的等价实现。
// 每个 skill 是一个子目录，含 manifest.json + 执行文件：
//  - runtime: 'js'（默认）：run.js，导出 function run(params, ctx)
//  - runtime: 'python'：entry 指向 .py（默认 run.py），其中 def main(params): return str
//  - runtime: 'command'：执行系统命令（默认禁用，需 SKILLS_ALLOW_COMMAND=1）
// 网络：js 技能默认允许（仅 web-fetch 用）；python 技能默认禁止，需 manifest.allowNetwork: true。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
// 「python 是谁」的一份真源（skills / shell-exec / 主进程 TTS 三处共用，见 resolvePython 的注释）
const sharedPython = require('../shared/pythonRuntime');

// 内存里的 run.js 模块缓存，避免每次调用都重新 require
const modCache = new Map();

// js 技能默认超时（毫秒）。与 python 分支（runPython）用同一个默认值，
// 避免"声明了保护、实际没有保护"：此前 js 技能完全没有超时，manifest.timeoutMs 被静默忽略。
const DEFAULT_SKILL_TIMEOUT_MS = 60000;

// 仅供单测断言：超时/中断后清理路径（finally）确实执行过，证明无定时器/监听器泄漏。
let _timeoutCleanupCount = 0;

// 毫秒 → 可读秒（60000→"60"、300→"0.3"），用于拼可读错误文案。
function toReadableSeconds(ms) {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : String(Number(s.toFixed(1)));
}

// 可读超时错误：带技能名 + 秒数，避免出现 "Command failed: C:\...\Temp\agentmvp_py_xxx.py ..." 这类看不懂的产物。
// ★ 2026-11-09：额外挂 `kind` / `proc` 结构化事实（不改一个字的文案）。
//   理由：上层原先只能靠「执行超过 N 秒」这段文案正则猜类型；文案一改，类型就漂。
//   现在定性发生在**最靠近源头的地方**，一路传下去（见 src/main/procEvidence.js）。
function skillTimeoutError(name, ms) {
  const e = new Error(
    `错误：技能「${name}」执行超过 ${toReadableSeconds(ms)} 秒未返回，已中断。长任务建议拆小或改用可分段的方式。`
  );
  e.kind = 'timeout';
  e.skillId = name;
  e.proc = { spawned: true, timedOut: true, killedByUs: true, timeoutMs: ms, skillId: name };
  return e;
}

// 可读中断错误（用户点了「停止」）。文案与 backend.js 的中断收尾话术一致，模型/用户一眼可辨。
function skillAbortedError(skillId) {
  const e = new Error('错误：任务已被用户停止。');
  e.kind = 'aborted';
  if (skillId) e.skillId = skillId;
  e.proc = { spawned: true, aborted: true, timedOut: false, killedByUs: true, skillId: skillId || null };
  return e;
}

/**
 * 给一次技能执行套上「超时 + 可中断」外壳。
 * 实现要点：用 Promise.race 的等价写法（先 settle 者胜），并且在每一条 settle 路径上
 * 都清理定时器与 abort 监听器（放在 finally 里），保证超时/中断后不泄漏。
 *
 * ★ 关键：onTimeout / onAbort 是**先于 settle 执行**的可选副作用钩子——用来在「超时/叫停」的
 *   同一时刻 abort 掉技能**内部**的 AbortController，从而让技能内正在挂起的 fetch 立即断开。
 *   否则只会 reject 走人，底层 fetch 继续挂到 undici 默认 300s（就是上一版的"假超时"）。
 *   顺序很关键：先跑钩子（同步 abort ⇒ 技能内 fetch 的 reject 走异步微任务），
 *   再同步 finalize 可读文案 ⇒ 先 settle 的一定是可读文案，绝不会被 "This operation was aborted" 覆盖。
 * @param {() => Promise<any>} invoke 真正执行技能的调用（惰性求值，避免未执行就起副作用）
 * @param {{name:string, timeoutMs:number, signal:AbortSignal|null, onTimeout?:()=>void, onAbort?:()=>void}} opts
 * @returns {Promise<any>}
 */
function runWithTimeoutAndAbort(invoke, opts) {
  const name = (opts && opts.name) || '技能';
  const timeoutMs = opts && opts.timeoutMs;
  const signal = opts && opts.signal;
  const onTimeout = opts && opts.onTimeout; // 可选：超时时先执行的副作用（abort 内部控制器）
  const onAbort = opts && opts.onAbort;     // 可选：外部叫停时先执行的副作用（同样 abort 内部控制器）
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let onSignalAbort = null;
    const finalize = (fn, val) => {
      if (settled) return;
      settled = true;
      try {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (signal && onSignalAbort) { signal.removeEventListener('abort', onSignalAbort); onSignalAbort = null; }
      } finally {
        // 无论正常完成 / 超时 / 中断，都会走到这里 ⇒ 计数增加，单测据此证明清理路径必执行。
        _timeoutCleanupCount += 1;
      }
      fn(val);
    };
    // ① 调用前就已被叫停：先 abort 内部控制器（技能即便被启动也会立刻看到已叫停），再立即结束，不启动技能。
    if (signal && signal.aborted) {
      if (typeof onAbort === 'function') { try { onAbort(); } catch { /* ignore */ } }
      finalize(reject, skillAbortedError());
      return;
    }
    // ② 执行中叫停：abort 时先 abort 内部控制器，再立刻结束本次调用。
    if (signal) {
      onSignalAbort = () => {
        if (typeof onAbort === 'function') { try { onAbort(); } catch { /* ignore */ } }
        finalize(reject, skillAbortedError());
      };
      signal.addEventListener('abort', onSignalAbort, { once: true });
    }
    // ③ 超时保护：到点先 abort 内部控制器，再以可读错误结束。timeoutMs 为 0/非有限值时不设超时。
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (typeof onTimeout === 'function') { try { onTimeout(); } catch { /* ignore */ } }
        finalize(reject, skillTimeoutError(name, timeoutMs));
      }, timeoutMs);
    }
    // ④ 真正执行技能：resolve / reject 都要经 finalize（统一清理）。
    Promise.resolve()
      .then(invoke)
      .then(
        (v) => finalize(resolve, v),
        (e) => finalize(reject, e)
      );
  });
}

// 连接器管理器单例：由 backend.js 在 startBackend 里注入。
// 商城等外部服务的登录/token 统一由连接器层（connectors.js）管理，
// 技能不再自己散落登录逻辑。
let connectorMgr = null;
function setConnectorManager(mgr) {
  connectorMgr = mgr;
}

// 取连接器管理器单例（由 backend.js 在 startBackend 里注入）。
// 主进程（主窗 session 的免登注入）需要拿**同一个**实例读内存 token，故这里暴露只读 getter；
// 绝不在此 new 第二个 ConnectorManager —— 那会分叉出第二份 token 存储。
function getConnectorManager() {
  return connectorMgr;
}

function scanSkills(skillsDir) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(skillsDir)) {
    const dir = path.join(skillsDir, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.id = name;
      manifest.directory = dir;
      out.push(manifest);
    } catch (e) {
      console.error('[Skills] skip', name, '-', e.message);
    }
  }
  return out;
}

function loadRunner(manifest) {
  if (manifest.runtime === 'command') return null;
  const runPath = path.join(manifest.directory, 'run.js');
  if (!fs.existsSync(runPath)) throw new Error('missing run.js for skill ' + manifest.id);
  if (modCache.has(runPath)) return modCache.get(runPath);
  const mod = require(runPath);
  const runner = mod.run || mod.default;
  if (typeof runner !== 'function') throw new Error('run.js must export a run function');
  modCache.set(runPath, runner);
  return runner;
}

// 解析 Python 解释器路径 —— **真源已搬到 src/shared/pythonRuntime.js**。
//
// ★ 2026-10-23：这里原本自带一份实现，而 `skills/shell-exec` 的子进程按宿主 PATH 找 python、
//   主进程 TTS 的 `pythonBin()` 又是第三份 ⇒ 同一个产品里"python 是谁"有两个答案：
//   ppt-generate 用自带 runtime（有 python-pptx）成功，shell-exec 里 `import pptx` 却报
//   ModuleNotFoundError，模型据此对用户编出「本机缺少组件」的假话（实测见 e2e run-20261023042103）。
//   现在三处统一走 shared 里的同一个解析顺序；本函数只负责保持**原有的返回契约**（返回字符串路径）。
//
// 解析顺序（改就改 shared/pythonRuntime.js，别再在这里加分支）：
//   1. 环境变量 PYTHON_PATH（显式指定）
//   2. 打包内嵌的 python-runtime/（PYTHON_RUNTIME_DIR 或 process.resourcesPath）
//   3. 系统 PATH 上的 python / python3
function resolvePython() {
  return sharedPython.resolvePython().exe;
}

// Python 技能引导脚本：加载目标 run.py 的 main(params)，处理网络隔离，输出结果。
const PY_BOOTSTRAP = `
import sys, json, importlib.util, os, builtins
entry = sys.argv[1]
params = json.loads(sys.argv[2])
allow_net = os.environ.get('AGENT_ALLOW_NET', '0') == '1'
if not allow_net:
    _real = builtins.__import__
    _blocked = ('socket', 'urllib', 'http', 'requests', 'httpx', 'ftplib', 'telnetlib', 'smtplib', 'websocket', 'aiohttp')
    def _guard(name, *a, **k):
        if name.split('.')[0] in _blocked:
            raise ImportError('network disabled for this skill: ' + name)
        return _real(name, *a, **k)
    builtins.__import__ = _guard
spec = importlib.util.spec_from_file_location('skillmod', entry)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
result = mod.main(params)
print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))
`;

// ===== 树杀：连「python 起的孙进程」一起杀 =====
// 缺陷（实测坐实）：`execFile` 的 `signal` 选项在 abort 时只对**直接子进程**做 TerminateProcess，
//   **不杀孙进程**。而 python 技能里普遍是 `subprocess.run(cmd)` 起外部二进制
//   （`skills/media-edit/run.py:16`，六个 action 全部 `-y` 直写最终输出路径）。
//   于是用户按「停止」后：父进程死了、回调正常报 AbortError（界面显示"已取消"）、
//   而 ffmpeg 变成孤儿**继续往盘上写**，最终留下一个半成品文件。
//   产品里原先 `grep -rn taskkill src/` **零命中** —— 完全没有树杀。
//   门禁：scripts/smoke/unit-skill-abort-tree.mjs（T4 孙进程必须死 / T5 见证文件冻结）。
//
// ★ 两条实测出来的硬约束（别"优化"回去；反例读数都在上面那个门禁的头注里）：
//   ① **必须先树杀、再让直系子进程死**。`taskkill /T` 靠遍历 ParentProcessId 找子进程，
//      父进程先没 ⇒ taskkill 直接报「错误: 没有找到进程 "xxx"」（exit=128），**孙进程一直活着**
//      （实测：同一时刻先 `cp.kill()` 再 taskkill，孙进程到采样结束仍在写，字节还在涨）。
//      ⇒ 所以这里**不自己杀直系子进程**，整棵树统一交给 taskkill。
//   ② **不能同步等它落定**。`taskkill` 在本机实测 **~800-890ms** 才真正落地
//      （`taskkill /?` 只要 80ms ⇒ 慢的不是进程启动，是树枚举 + 逐个终止）。
//      spawnSync 会把事件循环冻住 ~890ms：Electron 主进程一冻，所有窗口的 IPC 一起卡；
//      而且 abort→reject 的延迟会被拉长到 ~890ms，直接打红既有门禁
//      `unit-skill-abort.mjs` 的 C1-i（<300ms，它守的是"按了停止立刻有反应"）。
//      ⇒ Windows 走**异步** `spawn`（发起即返回，不等落定）；POSIX 的 `kill(2)` 是瞬时的，
//        仍走同步递归（见下）。
//
// ⚠️ 已知残余缺口（本轮有意不修，如实登记，别顺手改）：
//    · **超时**路径仍只有 execFile 自己的 TerminateProcess ⇒ 超时同样不杀孙进程。
//      修它必须连同 `unit-skill-timeout.mjs` 的判据一起改，属于另一件事；
//    · `runCommand`（command 类型技能）依旧丢弃 options，命中面为 0，见 runSkill 里的登记。

/**
 * 收集某进程的全部后代 pid（POSIX 用；Windows 不需要 —— 交给 `taskkill /T`）。
 * 深度优先，`pgrep -P` 拿不到（无子进程 / 无 pgrep）就当作没有后代。
 * @param {number} pid 根进程
 * @param {number[]} acc 结果累加器（也用于防环）
 * @returns {number[]} 后代 pid（父在前、子在后）
 */
function collectDescendants(pid, acc) {
  let out = '';
  try {
    out = execFileSync('pgrep', ['-P', String(pid)], {
      stdio: ['ignore', 'pipe', 'pipe'], // 与 Windows 分支同口径：显式 stdio，不开管道 stdin
      encoding: 'utf8',
      timeout: 2000,
    });
  } catch {
    // pgrep 在没有匹配子进程时以退出码 1 结束（execFileSync 会抛）——这是正常情况，不是错误
    return acc;
  }
  for (const token of String(out).split(/\s+/)) {
    const child = Number(token);
    if (!Number.isInteger(child) || child <= 0) continue;
    if (child === pid || acc.includes(child)) continue; // 防环 / 防重复
    acc.push(child);
    collectDescendants(child, acc);
  }
  return acc;
}

/**
 * 杀掉一棵进程树：`pid` 以及它的**所有后代**。
 *
 * 失败不抛（进程可能已经死了，这在 abort 场景里是常态），只返回布尔。
 * 返回 true 表示**终止已发起/已执行**，**不表示已经落定**（Windows 上 taskkill 落定要 ~890ms）。
 *
 * @param {number} pid 树根（直系子进程的 pid；通常是 execFile 返回的 ChildProcess.pid）
 * @returns {boolean} 是否成功发起/执行了终止
 */
function killProcessTree(pid) {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 0) return false;
  if (process.platform === 'win32') {
    // `/T` 才是树杀（只 `/F` 只杀父进程，python 起的 ffmpeg 会变孤儿）—— 这是本缺陷的正解。
    try {
      const killer = spawn('taskkill', ['/PID', String(root), '/T', '/F'], {
        // ★ 显式 stdio：本宿主上"默认 stdio 的同步派生"会假报 EBUSY（见 scripts/smoke/_spawn-safe.mjs 的一手对照实验）
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // 必须吃掉输出（管道写满会卡住 taskkill）；必须挂 'error' 监听（taskkill 起不来时
      // 未捕获的 'error' 事件会把主进程崩掉 —— 比"杀不掉进程"更糟）。
      if (killer.stdout) killer.stdout.resume();
      if (killer.stderr) killer.stderr.resume();
      killer.on('error', () => {});
      return Number.isInteger(killer.pid);
    } catch {
      return false;
    }
  }
  // POSIX：先递归取后代，**从最深的开始杀**。
  // （若先杀父，后代会被挂到 init 上，仍在按遍历顺序执行的后半段就可能漏杀；
  //   而且 `process.kill` 是瞬时系统调用，同步做完全没问题，不必像 Windows 那样异步。）
  try {
    let any = false;
    const descendants = collectDescendants(root, []);
    for (const p of descendants.reverse()) {
      try { process.kill(p, 'SIGKILL'); any = true; } catch { /* 可能已自行退出 */ }
    }
    try { process.kill(root, 'SIGKILL'); any = true; } catch { /* 可能已自行退出 */ }
    // 若子进程恰好是进程组组长（将来若给 execFile 加 detached: true），整组一起杀更彻底；
    // 不是组长时这里会抛 ESRCH，属正常，忽略。
    try { process.kill(-root, 'SIGKILL'); any = true; } catch { /* 不是组长 */ }
    return any;
  } catch {
    return false;
  }
}

// ★ 第 3 参 options 是「用户叫停」的唯一入口（由 runSkill 的第 4 参原样传下来）。
//   修复前签名只有 (manifest, params)，且 runSkill 的 python 分支写的是
//   `return runPython(manifest, params)` —— options 在那一行整个丢弃，
//   于是 **25 个 python 技能结构性不可取消**：用户按「停止」后 turn 已结束、
//   工具结果已写成失败，而 python 子进程还在跑、还在往盘上写，直到自然结束。
//   （实测：abort 后 +4523ms 才 reject，盘上仍写出 `DONE`、541 字节。）
function runPython(manifest, params, options) {
  return new Promise((resolve, reject) => {
    // 与 js 分支同口径：null / undefined 都归一成 null；非 AbortSignal 的假值一律当"没有信号"。
    const signal = (options && options.signal) || null;
    // ① 调用前就已被叫停：连进程都不起。
    //   放在最前面 —— 否则会先 spawn 再被 abort，留下一个短命进程的假读数
    //   （"它死了"可能只是"它还没起来"）。这一步连临时引导文件都不写。
    if (signal && signal.aborted) return reject(skillAbortedError());
    const py = resolvePython();
    const entry = path.join(manifest.directory, manifest.entry || 'run.py');
    if (!fs.existsSync(entry)) {
      return reject(new Error('missing ' + (manifest.entry || 'run.py') + ' for skill ' + manifest.id));
    }
    const tmp = path.join(os.tmpdir(), 'agentmvp_py_' + manifest.id + '_' + Date.now() + '.py');
    try {
      fs.writeFileSync(tmp, PY_BOOTSTRAP);
    } catch (e) {
      return reject(new Error('failed to write python bootstrap: ' + e.message));
    }
    const allowNet = manifest.allowNetwork === true; // python 技能默认禁网，需显式开启
    const args = [tmp, entry, JSON.stringify(params)];
    const env = { ...process.env, AGENT_ALLOW_NET: allowNet ? '1' : '0', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }; // 强制 python 以 UTF-8 写 stdout，避免中文 GBK 乱码 / emoji 崩溃
    // 超时默认 60s（OCR 首次加载 onnx 模型、视频/大文件生成都可能超过 15s）；manifest 可用 timeoutMs 覆盖
    const timeout = Number(manifest.timeoutMs) || DEFAULT_SKILL_TIMEOUT_MS;
    // ★★ 这里**故意不再给 execFile 传 `signal`**（这是本轮树杀修复的关键，理由见下，别改回去）。
    //
    //   历史教训（原注释保留）：`{ timeout, env, encoding, signal }` 直接写会在 signal 为
    //   null / undefined 时被 execFile **同步**校验抛 ERR_INVALID_ARG_TYPE，所以曾经必须用
    //   `...(signal ? { signal } : {})` 条件展开。现在整条 `signal` 通路都不走 execFile 了
    //   ⇒ 空值陷阱从根上消失；而"没有信号"这条路径的 options 与从前**逐字节一致**
    //   （依旧只有 timeout / env / encoding 三项）。
    //
    //   为什么不传：Node 内部的 abort 处理在 `signal` 上注册得比我们早，abort 时会**先**
    //   把直系子进程 TerminateProcess 掉，我们后注册的处理器再去 taskkill /T 时，
    //   父进程已经没了 ⇒ taskkill 报「没有找到进程」，**孙进程照样活着**（实测反例）。
    //   而且只杀直系子进程这本身也杀不到孙进程。
    //   ⇒ 终止职责整体移交给下面自己注册的 abort 处理器（树杀 + 立即 reject）。
    const execOpts = { timeout, env, encoding: 'utf8' };
    let cp = null;          // execFile 的返回值（ChildProcess），树杀要用它的 pid
    let settled = false;
    let onAbort = null;
    // 统一收口：清理 abort 监听（防泄漏）+ 只 settle 一次
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        onAbort = null;
      }
      fn(val);
    };
    try {
      cp = execFile(py, args, execOpts, (err, stdout, stderr) => { // 显式 utf8：与上方 env 对齐，父进程按 UTF-8 读子进程输出
        fs.unlink(tmp, () => {});
        if (err) {
          // ★ 用户叫停 ≠ 超时，必须**先判 abort**。现在 abort 由我们自己的处理器先 settle，
          //   下面这条判据实际已走不到；但它必须**原样保留**：一旦将来有人把 signal 又传回
          //   execFile，这条是唯一的兜底（abort 时 Node 给 err.name='AbortError' /
          //   err.code='ABORT_ERR'，而 killed 与 signal 都是 undefined ⇒ 超时判据对它不成立，
          //   会一路落到 `new Error(stderr || err.message)`，用户看到英文原串）。
          if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return finish(reject, skillAbortedError());
          // 超时被杀：execFile 会置 killed=true / signal=SIGTERM，此时 stderr 常为空，
          // err.message 是带临时文件路径的 "Command failed: C:\...\Temp\agentmvp_py_xxx.py ..."（用户看不懂）
          // ⇒ 换成带技能名与秒数的可读文案。（判据保持原样，不要因为有 abort 分支就删它）
          const timedOut = err.killed === true;
          // ★ 2026-11-09 改：去掉原来的 `|| err.signal === 'SIGTERM'`。
          //   为什么必须去掉（本轮要钉住的缺陷）：Node 的 execFile 超时路径**一定**同时置
          //   `killed=true`，所以 killed 已是充分判据；而「外部把它杀掉」（杀软 / 系统 /
          //   另一个实例的 taskkill /T）只会给出 signal='SIGTERM'、killed=false。
          //   原判据把这两种情况混成一种 ⇒ 一条被外部杀掉的命令会被报成「执行超过 N 秒未返回」，
          //   用户据此去「拆小任务 / 加超时」，而真正该查的是谁在杀进程。
          if (timedOut) return finish(reject, skillTimeoutError(manifest.id, timeout));
          // 非超时失败：把「谁杀的 / 退出码多少」作为事实挂上去，文案原样保留。
          const e2 = new Error(stderr || err.message);
          try {
            e2.kind = 'runtime';
            e2.skillId = manifest.id;
            e2.proc = {
              spawned: true, timedOut: false, killedByUs: false,
              termSignal: err.signal || null,
              exitCode: (typeof err.code === 'number') ? err.code : null,
              skillId: manifest.id,
            };
          } catch { /* 取证失败不许影响执行 */ }
          return finish(reject, e2);
        }
        finish(resolve, stdout.trim());
      });
    } catch (e) {
      // execFile 同步抛（例如参数非法）：临时引导文件要清掉，错误照原样抛给上层
      fs.unlink(tmp, () => {});
      return finish(reject, e);
    }
    if (signal) {
      // ★ 顺序硬要求：**先发起树杀，再 reject**。
      //   killProcessTree 在 Windows 上是"发起即返回"（taskkill 落定要 ~890ms，绝不等它），
      //   在 POSIX 上是瞬时完成。因此这里不会拖慢「按了停止立刻有反应」这条判据
      //   （unit-skill-abort.mjs C1-i：abort→reject < 300ms）。
      onAbort = () => {
        killProcessTree(cp && cp.pid);
        finish(reject, skillAbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // 竞态兜底：execFile 起进程之后、addEventListener 之前就被叫停 ⇒ abort 事件已经错过了
      // （AbortSignal 不会重放），必须在这里补一次，否则这一次叫停会**静默失效**。
      if (signal.aborted) onAbort();
    }
  });
}

function runCommand(manifest, params) {
  return new Promise((resolve, reject) => {
    if (!process.env.SKILLS_ALLOW_COMMAND) {
      return reject(new Error('command-type skills are disabled (set SKILLS_ALLOW_COMMAND=1)'));
    }
    const cmd = manifest.command;
    const args = (manifest.args || []).map((a) => String(params[a] != null ? params[a] : a));
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// ===== 失败自恢复（工具层）=====
// 背景（2026-09-22 实测反馈）：豆芽会把「工具调用失败」直接当成「任务失败」——原地重试同一个失败调用，
// 最后告诉用户"做不了"。可复现的例子：`file-write` 返回「错误：请提供目标文件路径」，模型看到这句话
// 既不知道缺的是哪个**参数名**，也不知道还有别的路可走，只能原样重来或放弃。
//
// ★ 设计取舍（关键，别改回去）：只在技能**已经返回失败之后**给结果追加指引，**绝不做事前拦截**。
//   事前拦截（发现必填参数为空就不执行、直接返回错误）看着更"省一次调用"，但它会改变
//   「原本能跑通的调用」的行为：一旦某个技能声明的必填参数其实可空、或技能自己会兜默认值，
//   拦截就变成**回归**（把本来能成的活儿拦死）。事后增强只改写一条**已经失败**的文案
//   ⇒ 不可能拦死任何正常调用，零回归。
//
// 契约：
//   · **只增强「失败」结果**：结果开头必须是失败前缀（与 backend.js 的 isFailureResult 同口径），
//     成功结果一律不碰 —— 否则会给一次成功的调用挂上"失败恢复指引"，把模型带沟里。
//   · 两个入口**任一**成立才插手：
//     ① 报错文案本身就是参数问题（缺参 / 格式不合法 / 路径越界）；
//     ② 本技能声明的必填参数这次确实没给（即使文案用的是"为空"这类不自带关键词的说法，
//        例如 mmm-shop-order 的「错误：购物车商品为空」——它就是 goods 没给，但文案里没有"请提供"）。
//   · 追加的文字**不改动开头**，所以上游 isFailureResult（只看开头前缀）仍判为失败，记账口径不变。
//   · 幂等：已带标记则原样返回，避免同一结果被增强两次。
const RECOVERY_MARK = '【失败恢复指引';
// ★ 2026-11-11：findstr 查中文漏检的指引标记（幂等用，见 attachEncodingHint）
const ENCODING_MARK = '【查找方式有问题';
// 失败前缀：与 backend.js 的 FAILURE_RESULT_RE 同口径（新增前缀时两处要一起加）
const FAILURE_HEAD_RE = /^\s*(?:error\b|Error\b|错误|❌|操作失败|部署失败|回滚失败|搜索失败|失败\s*[：:]|[\u4e00-\u9fa5A-Za-z0-9_ ]{1,12}(?:失败|错误|超时|不存在|无效|不允许|拒绝)(?= *[：:（(，,\n]| *$)|请\s*(?:先|你)?(?:提供|告诉|指定|输入|给出)|请\s*先[^，。\n]{0,12}?(?:连接|配置|设置|登录|授权|绑定))/;
// 「像参数问题」的文案特征（入口①）
const PARAM_FAIL_RE = /(请提供|缺少|必填|参数不合法|不是合法 JSON|不允许写到工作区外)/;

/**
 * 给「参数类失败」的结果追加可自恢复指引（不改动开头、幂等）。
 * @param {{id?:string,name?:string,params?:Array}} manifest 技能 manifest（必填声明的真源）
 * @param {object} params 本次调用实际传入的参数
 * @param {string} result 技能返回文本
 * @returns {string} 原文本，或「原文本 + 指引」
 */
function attachRecoveryHint(manifest, params, result) {
  const s = typeof result === 'string' ? result : result == null ? '' : String(result);
  if (!s || s.includes(RECOVERY_MARK)) return s;
  // ★ 只增强失败结果：成功结果一律不碰（否则会给一次成功的调用挂上"失败恢复指引"）
  if (!FAILURE_HEAD_RE.test(s)) return s;
  const ps = (manifest && manifest.params) || [];
  const given = params && typeof params === 'object' ? params : {};
  // 空串 / 空数组视为「没给」；数字 0 与布尔 false 是合法值，不能被 falsy 误伤。
  const isEmpty = (v) => {
    if (v == null) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    return false;
  };
  const req = ps.filter((p) => p && p.required === true);
  const miss = req.filter((p) => isEmpty(given[p.name || p.key]));
  const looksParamFail = PARAM_FAIL_RE.test(s);
  // 两个入口任一成立才插手：①文案本身就是参数问题；②必填参数确实没给（覆盖"为空"这类不含关键词的文案）
  if (!looksParamFail && !miss.length) return s;
  const name = (manifest && (manifest.name || manifest.id)) || '技能';
  const lines = [];
  lines.push('');
  lines.push('—— ' + RECOVERY_MARK + '（自动附加）】——');
  lines.push(looksParamFail
    ? '· 这属于「调用参数」问题（通常意味着本次**没有真正执行**、没有留下副作用）。'
    : '· 本技能这次**有必填参数没给**，报错很可能与它有关：先把它补齐，再判断是不是还有别的原因。');
  lines.push('· **这不等于任务失败**：不要就此停下，也不要把这句话当成结论汇报给用户。');
  if (req.length) {
    lines.push('· 本技能声明的必填参数：' + req.map((p) => (p.name || p.key) + (p.label ? '（' + p.label + '）' : '')).join('、'));
    lines.push('· 本次**缺/不合法**的是：' + (miss.length ? miss.map((p) => p.name || p.key).join('、') : '（必填项都在，问题出在取值格式，请照上面的报错修正）'));
  }
  if (ps.length) {
    lines.push('· 本技能完整参数表：' + ps.map((p) => (p.name || p.key) + (p.required === true ? '*' : '')).join('、') + '（带 * 为必填）');
  }
  lines.push('· 接下来按顺序做，**不要原样重复调用**（漏掉的参数不会自己出现）：');
  lines.push('  1) 补齐上面缺的参数后，重新调用「' + name + '」；参数形如 {' + ps.map((p) => '"' + (p.name || p.key) + '":"…"').join(', ') + '}');
  lines.push('  2) 如果这个值你**不是漏传、而是拿不到**，就换一条路先把它取到（用别的技能 / 别的入口），再回来做这一步。');
  lines.push('  3) 同一处最多再试 1 次；再失败就必须换方法，不要在同一个失败上原地打转。');
  lines.push('  4) 只有在**所有可行路径都试过**之后才允许下「做不到」的结论，且必须说明你试过哪几条路、各自为什么不行。');
  return s + '\n' + lines.join('\n');
}

async function runSkill(manifest, params = {}, cfg = {}, options = {}) {
  if (manifest.runtime === 'python') {
    // 微信接口技能：运行时注入 AppID/AppSecret（后端在设置里存，跑 Python 前塞进 params）
    if (manifest.id === 'wechat-api') {
      params = { ...params, appid: cfg.wxAppId || '', secret: cfg.wxAppSecret || '' };
    }
    // ★ 修复：原代码是 `return runPython(manifest, params)` —— options 在这一行整个丢弃，
    //   于是下面 js 分支的 `const signal = (options && options.signal) || null` 对 python 技能
    //   永远走不到，"用户叫停"对 25 个 python 技能**结构性失效**。
    //   门禁：scripts/smoke/unit-skill-abort.mjs（C1 停止后不再写盘 / C2 起进程前叫停不 spawn）。
    return runPython(manifest, params, options);
  }
  if (manifest.runtime === 'command') {
    // ⚠️ 同型缺陷：runCommand(manifest, params) 同样丢弃 options ⇒ command 类型技能不可取消。
    //   当前 47 个技能里 **0 个** command 类型（25 python + 22 js），命中面为 0，故本轮不修；
    //   将来出现 command 技能时，必须先按 runPython 的口径把 options 接上再上线。
    return runCommand(manifest, params);
  }
  const runner = loadRunner(manifest);
  // ctx 给技能提供受限能力：后端基础地址、是否允许联网、商城 API 配置等
  const shop = (cfg && cfg.shop) || {
    baseURL: cfg && cfg.shopBaseURL,
    account: cfg && cfg.shopAccount,
    password: cfg && cfg.shopPassword,
    apiKey: cfg && cfg.shopApiKey,
    token: cfg && cfg.shopToken,
    productUrl: cfg && cfg.shopProductUrl,
    orderUrl: cfg && cfg.shopOrderUrl,
  };
  // 商城技能（shop-search / shop-order）通过连接器层拿 token（自动登录 + 缓存 + 过期重登）
  if (/^shop-/.test(manifest.id || '')) {
    if (connectorMgr) {
      shop.token = await connectorMgr.getToken('shop-supplier-a');
    }
    if (!shop.token) {
      return '错误：商城未连接。请打开右上角「设置」→「商城」→「上游货源商城」，填写账号密码，点「测试连接」成功后，再回来加购。';
    }
  }
  // 上游货源商城技能（mmm-shop-search / mmm-shop-order）：路由到连接器 shop-supplier-b。
  // ⚠️ 关键差异（实测）：上游货源搜索**免登录** —— 不强制 token，拿不到 token 不是错误，
  //    否则「没填凭证就用不了」会让搜索功能等于没做。故这里**不设 token 强制门**。
  // ⚠️ 不能依赖上面的 `cfg.shop` 短路：mmm 配置来源是独立的 cfg.mmm*，**必须显式构造对象**。
  // 注：/^shop-/ 不会误匹配 mmm-shop-*（后者以 'm' 开头）——已单测断言。
  let shopCtx = shop;
  if (/^mmm-shop-/.test(manifest.id || '')) {
    shopCtx = {
      baseURL: (cfg && cfg.mmmBaseURL) || 'https://supplier.example.com',
      account: cfg && cfg.mmmAccount,
      password: cfg && cfg.mmmPassword,
      apiKey: cfg && cfg.mmmApiKey,
      token: '',
    };
    // 免登录：能拿到 token 就带上（自动登录/手填均可能命中），拿不到就吞掉异常继续，绝不阻断。
    if (connectorMgr) {
      try {
        const t = await connectorMgr.getToken('shop-supplier-b');
        shopCtx.token = t || ((cfg && cfg.mmmApiKey) || '');
      } catch {
        shopCtx.token = (cfg && cfg.mmmApiKey) || '';
      }
    } else {
      shopCtx.token = (cfg && cfg.mmmApiKey) || '';
    }
  }
  // GEO 技能（geo-*）通过连接器层拿 token（自动登录 + 缓存 + 过期重登），注入 ctx.geo
  const geo = (cfg && cfg.geo) || {
    baseURL: (cfg && cfg.geoBaseURL) || 'https://api.example.com',
  };
  if (/^geo-/.test(manifest.id || '')) {
    if (connectorMgr) {
      geo.token = await connectorMgr.getToken('doudou-ai');
    }
    if (!geo.token) {
      return '请先在设置里连接自建后端（右上角「设置」→「小程序」→ 填写自建后端账号密码 → 点「测试连接」成功后，再回来使用）。';
    }
  }
  const ctx = {
    allowNetwork: true,
    shop: shopCtx,
    geo,
    wx: { appId: cfg.wxAppId || '', appSecret: cfg.wxAppSecret || '' },
  };
  // 有效超时：显式 options.timeoutMs（单测/特殊调用）> manifest.timeoutMs > 默认（与 python 分支同值）。
  const manifestTimeoutMs = Number(manifest.timeoutMs) || DEFAULT_SKILL_TIMEOUT_MS;
  const overrideMs = Number(options && options.timeoutMs);
  const effectiveTimeoutMs = Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : manifestTimeoutMs;
  // 第 4 参可选、完全向后兼容：不传 options 时 signal 为 null，行为等同于「只加超时保护」。
  const signal = (options && options.signal) || null;
  // ★ 内部 AbortController = 「超时」与「外部叫停」两个信号源的**统一汇入点**。
  //   交给技能的是**内部 signal**（不是外部 signal）：超时路径下外部 signal 自始至终是 null，
  //   若把它交给技能，超时后技能内正在挂起的 fetch 不会断开，会一直跑到 undici 默认 300s（假超时）。
  const innerCtrl = new AbortController();
  ctx.signal = innerCtrl.signal;
  ctx.timeoutMs = effectiveTimeoutMs;
  const result = await runWithTimeoutAndAbort(
    () => runner(params, ctx),
    {
      name: manifest.id || manifest.name || '技能',
      timeoutMs: effectiveTimeoutMs,
      signal,
      onTimeout: () => innerCtrl.abort(),
      onAbort: () => innerCtrl.abort(),
    }
  );
  const out = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  // 参数类失败 ⇒ 追加可自恢复指引（只增强一条**已经失败**的文案，不改开头、幂等；详见 attachRecoveryHint 注释）
  return attachEncodingHint(manifest, params, attachRecoveryHint(manifest, params, out));
}

// ===== 找中文却用了 findstr：补一条"你这条路必然漏"的指引（2026-11-11）=====
/**
 * 为什么需要这一条（老板 2026-11-11 复盘事故的第 3 条，因果链的起点）：
 *   那轮任务里模型用 `findstr` 去核中文（文件是 UTF-8），**必然找不到**。
 *   它看到"没有输出"就当成"文件里没有这个中文"，于是白白烧掉两轮，
 *   最后收尾时那两处"未补救的工具失败"把终态锁成 PARTIAL。
 *
 * ★ 这个失败**没有失败信号**，这是它最难查的地方：
 *   `findstr` 在 UTF-8 文件上查中文，返回的是「exit 1 + 空输出」，stderr 一个字都没有。
 *   而 `attachRecoveryHint` 只在**结果开头像失败**时才插手 ⇒ 这条路上它永远不会触发。
 *   所以必须单独有一条判据，且判据不能是"看报错"，只能是"看命令 + 看结果像不像真的查到了"。
 *
 * ★ 判据（四条同时成立才追加，宁少不多）：
 *   ① 技能是 shell-exec；② 命令里出现 `findstr`（词边界）；
 *   ③ 命令里含非 ASCII（说明要查的是中文/全角）；④ 结果**看起来没真查到**：
 *      空 / 是失败文案 / 结果里一个非 ASCII 字符都没有。
 *   ★ 第 ④ 条是关键：如果 findstr 真的匹配到了中文（文件是 GBK 之类），
 *     结果里一定带中文 ⇒ 不加提示 ⇒ 「成功结果一个字都不改」的纪律仍然成立。
 *
 * ★ 行为：只在末尾**追加**说明，不改开头 —— 上游 isFailureResult 只看开头，记账口径不变。
 *
 * @param {{id?:string,name?:string}} manifest
 * @param {object} params
 * @param {string} result
 * @returns {string} 原文本，或「原文本 + 编码指引」
 */
function attachEncodingHint(manifest, params, result) {
  const s = typeof result === 'string' ? result : result == null ? '' : String(result);
  // ★★ 幂等守卫**只判标记**，绝不可以写成 `if (!s || ...) return s`。
  //   第一版就是那样写的，后果正好错过最该拦的场景：
  //     findstr 查中文（UTF-8 文件）返回的就是**空输出 + exit 1**，
  //     `!s` 成立 ⇒ 直接 return ⇒ 指引永远不出现。
  //     实测（probe_enc 用例 1「事故形态：findstr查中文+空输出」）当场红。
  //   空结果在这里恰恰是**最需要提示**的信号，不是"没什么可说"。
  if (s.includes(ENCODING_MARK)) return s;
  const id = String((manifest && (manifest.id || manifest.name)) || '');
  if (id !== 'shell-exec') return s;
  const cmd = String((params && params.command) || '');
  if (!cmd) return s;
  // ② findstr（词边界；大小写不敏感）
  if (!/(^|[^A-Za-z0-9_-])findstr([^A-Za-z0-9_-]|$)/i.test(cmd)) return s;
  // ③ 要查的东西里有非 ASCII
  if (!/[^\x00-\x7F]/.test(cmd)) return s;
  // ④ 结果看起来没真查到（真有中文命中就不插手）
  const looksEmpty = !s.trim();
  const looksFailed = FAILURE_HEAD_RE.test(s);
  const noCjkInResult = !/[^\x00-\x7F]/.test(s);
  if (!(looksEmpty || looksFailed || noCjkInResult)) return s;

  const L = [];
  L.push('');
  L.push('—— ' + ENCODING_MARK + '（自动附加）】——');
  L.push('· 你用了 `findstr` 去查**中文**，而它默认按当前代码页（ANSI/GBK）解码文件内容。');
  L.push('  工作区里的文本文件基本都是 **UTF-8** ⇒ `findstr` 查中文**几乎必然查不到**，');
  L.push('  而且它不会报错（exit 1 + 空输出），所以「没输出」**不代表文件里没有这句话**。');
  L.push('· 换句话说：这次的结果**不能**当作"文件里没有/不含中文"的证据。');
  L.push('· 换这两条路之一重查（Windows 默认自带第一条）：');
  L.push('  1) PowerShell：`powershell -NoProfile -Command "Select-String -Path \'文件\' -Pattern \'中文\' -Encoding UTF8"`');
  L.push('  2) 有 rg 时：`rg -n \'中文\' 文件`');
  L.push('· 也可以直接用 file-read 把文件读出来自己看（中文查找最容易的兜底路）。');
  L.push('· ⚠️ 不要原样重发同一条 findstr；也不要把"查不到"写进结论。');
  return s + L.join('\n');
}

module.exports = {
  scanSkills,
  runSkill,
  resolvePython,
  setConnectorManager,
  getConnectorManager,
  // 对外暴露默认超时值，便于单测断言「js 与 python 用同一默认 60000」
  DEFAULT_SKILL_TIMEOUT_MS,
  // 失败自恢复：给「参数类失败」追加可自恢复指引（单测直接断言纯函数，无需真跑技能）
  attachRecoveryHint,
  attachEncodingHint,
  RECOVERY_MARK,
  // 单测钩子：证明超时/中断后的清理路径（finally）确实执行、无定时器泄漏
  __testing: { getCleanupCount: () => _timeoutCleanupCount },
};
