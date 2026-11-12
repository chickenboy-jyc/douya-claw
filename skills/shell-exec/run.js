// shell-exec: 在 workspace 目录下执行系统命令
//
// ★★ 2026-10-10 改造（这段历史是本文件最重要的部分，**别改回去**）★★
//
// 原实现是 `execSync(cmd, { cwd, timeout, maxBuffer, encoding:'buffer', shell:true })`，
// 有两个致命问题 —— 它们分别对应老板反馈的「突然卡住」和「说话说一半中断」：
//
// 【问题①】同步派生在本机会 **100% 失败**
//   execSync 内部就是 spawnSync。本宿主上同步派生为 stdin 建具名管道会失败 ⇒
//       `spawnSync C:\Windows\system32\cmd.exe EBUSY`（实测 **6/6**，2~4ms 就返回）
//   触发条件**只是**「stdin 用管道」：同一台机、同一条命令，
//       默认 stdio        → 3/3 EBUSY
//       stdio:['ignore','pipe','pipe'] → 3/3 成功
//   （机制与更早的 `scripts/smoke/_spawn-safe.mjs` 一致：异步 spawn 不受影响。）
//
// 【问题②】一旦它真跑起来，会把**整个客户端冻住**
//   `src/main/skills.js` 是 `require()` 到**主进程内存**里、直接调 `runner(params, ctx)` 的，
//   所以 execSync 阻塞的是 Electron **主进程**的事件循环 ——
//   UI / IPC / 流式推送 / 托盘全部停摆，最长 默认 5 分钟、硬上限 10 分钟。
//   对照实验（同一台机，忙等 3 秒的命令）：
//       execSync（含修好 stdio 的版本）→ 耗时 3464ms，50ms 心跳 **跳了 0 次**，最大间隔 0ms
//       异步 spawn                    → 耗时 3430ms，心跳 **55 次**，最大间隔 63ms
//   ⇒ 用户看到的就是「突然卡住」；期间任何流式输出都发不出去 = 「说话说一半中断」。
//
// 【问题③】顺带修掉两个「写了但没生效」的保护
//   · `skills.js` 的超时保护是一支 `setTimeout` —— 它同样依赖事件循环。
//     主进程被 execSync 占死时它**根本不会 fire** ⇒ 那层超时形同虚设。
//   · 用户点「停止」走的是 `ctx.signal`，而 execSync **不看 AbortSignal** ⇒ 停不下来。
//   改成异步后两者都真正生效（见下方 spawnCollect 的 timer / onAbort）。
//
// 【结论】必须用**异步 spawn**。❌ 不能只加 stdio（那只是把"瞬间失败"换成"冻结几分钟"，
//   更难排查）；❌ 也不能只把 execSync 包一层 Promise（Promise 不会让同步调用变异步）。
//
// 改动后仍然保证：危险命令拦截未放宽、超时可配置与 clamp 语义不变、
// 导出契约（resolveTimeoutMs / buildExecOptions / decodeOutput / 三个常量）不变。
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
// 「python 是谁」的一份真源。★ 别在这里再写一份解析逻辑：
//   shell 字符串里的裸 `python` 由 cmd.exe 按 PATH 解析，所以本技能要做的事只有一件 ——
//   把真源解析到的解释器目录**前置**到子进程 PATH（外加 PYTHON_PATH），而不是另立一套判据。
//   （2026-10-23 端到端实测：缺了这一步，shell-exec 落到系统 python，
//     `import pptx` 报 ModuleNotFoundError，模型据此对用户说出「本机缺少组件」的假话。）
const { shellEnv: buildPythonShellEnv } = require('../../src/shared/pythonRuntime');

const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');

// 命令超时（毫秒）。原实现硬编码 30000（30 秒），但「装依赖 / 构建项目」这类操作必然超过 30 秒
// （npm install / npm run build 冷启动动辄几分钟）⇒ 会把「豆芽自己把网站部署上去」的第一步就地杀死，
// 而且失败文案只有干巴巴的「命令执行失败」。现在改为可配置 + 合理默认：
//   · 优先 params.timeout_ms（渲染层/模型显式指定，字符串需强转）；
//   · 兜底默认 5 分钟（够覆盖绝大多数 npm install / npm run build）；
//   · 硬上限 10 分钟（再长就该拆小，避免命令永久挂住把任务卡死）。
// ★ 2026-10-10：改异步后这个超时是**真生效**的 —— 到点会 kill 掉整棵进程树并返回可读文案；
//   改造前它虽然也生效，但外层那层 setTimeout 保护是被同步阻塞吃掉的。
const DEFAULT_TIMEOUT_MS = 300000; // 5 分钟：覆盖绝大多数 npm install / npm run build
const MAX_TIMEOUT_MS = 600000;     // 10 分钟硬上限
const MIN_TIMEOUT_MS = 1000;       // 下限 1 秒，避免 0/负数把命令立刻杀掉
const MAX_BUFFER_BYTES = 1024 * 1024; // 输出累积上限：超了就不再往内存里加（进程照常跑完）
const MAX_OUTPUT_CHARS = 6000;        // 返回给模型的可见字符上限

/**
 * 纯函数：解析本次命令实际生效的超时值（毫秒）。抽出来便于单测直接断言，无需真跑命令。
 * @param {object} params 技能参数（渲染层传来的都是字符串）
 * @param {object} ctx 技能上下文（可选，ctx.timeoutMs 为外层包装器上界）
 * @returns {number} clamp 后的超时毫秒数
 */
function resolveTimeoutMs(params) {
  const raw = params && params.timeout_ms != null ? Number(params.timeout_ms) : NaN;
  let ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  if (ms > MAX_TIMEOUT_MS) ms = MAX_TIMEOUT_MS;
  if (ms < MIN_TIMEOUT_MS) ms = MIN_TIMEOUT_MS;
  return ms;
}

/**
 * 子进程环境：把**真正会被用到的那个 python 所在目录前置到 PATH**。
 *
 * ★ 2026-10-23 真机端到端抓到的缺陷（不是测试假象）：
 *   技能（ppt-generate / excel-generate …）走 skills.js 的 resolvePython()，它优先用
 *   自带 `python-runtime/python.exe` —— 那个解释器装了 python-pptx 等依赖。
 *   而本技能用 `spawn` 且**没有传 env** ⇒ 子进程按宿主 PATH 找 `python` ⇒ 落到**系统 python**（没装 pptx）。
 *   同一个产品里于是有两个 python：
 *     · ppt-generate 用自带 runtime → 成功
 *     · shell-exec 里 `python -c "import pptx"` → ModuleNotFoundError
 *   实测后果（e2e run-20261023042103）：模型先探测环境（turn 0/2 各失败一次），据此对用户写下
 *   「本机缺少解析该格式的组件，装依赖也没成功」——**这是一句假话**，自带 runtime 里 pptx 1.0.2 好好的；
 *   而且这条失败被算进 unresolved ⇒ 终态从 COMPLETE 掉到 PARTIAL。
 *
 * 现在解析顺序**只有一处**（src/shared/pythonRuntime.js），本函数只做"翻译"：
 *   拿到解释器绝对路径 ⇒ 目录前置到 PATH（只用 ';' / ':' 连接，不替换原有 PATH）＋ 设 PYTHON_PATH。
 * 解析落到系统 PATH（开发机没打包）时**原样返回**，与引入本文件之前逐字一致。
 */
function buildChildEnv(baseEnv) {
  return buildPythonShellEnv(baseEnv).env;
}

/**
 * 纯函数：构造子进程选项（便于单测断言真正传下去的值）。
 *
 * ★ `stdio` 是本次改造的**承重字段**，不是可选项：
 *   第一项必须是 `'ignore'`（不给子进程开 stdin 管道），否则在本宿主上会 EBUSY。
 *   单测对它有定点断言；不要"顺手"改成 'pipe' 或 'inherit'。
 *
 * @returns {{cwd:string,timeout:number,maxBuffer:number,encoding:string,shell:boolean,stdio:string[],windowsHide:boolean,env:object}}
 */
function buildExecOptions(params) {
  return {
    cwd: WORKSPACE,
    timeout: resolveTimeoutMs(params),
    maxBuffer: MAX_BUFFER_BYTES,
    encoding: 'buffer',            // 保留字段：spawn 下由 decodeOutput 自行解码
    shell: true,                   // 保持"能写 npm install / dir 这类 shell 语句"的语义
    stdio: ['ignore', 'pipe', 'pipe'], // ★ 修 EBUSY 的承重点（见文件头【问题①】）
    windowsHide: true,             // 别弹出黑窗口
    // ★ 让 `python` 指向自带的 runtime（见 buildChildEnv 的说明）。缺了这行，
    //   模型用 shell-exec 探测 python 环境会得到假阴性，进而对用户说出错误结论。
    env: buildChildEnv(),
  };
}

// 子进程字节解码器：**唯一真源在 `src/main/childOutput.js`**（本轮从本文件原样提取出去的）。
//
// ★ 为什么必须共享、而且这里不许再留副本：
//   「GBK 与 UTF-8 各解一遍、比 U+FFFD 数量、平手取 UTF-8」这套判据，仓里一共有 9 处
//   stderr 读取点要用（MCP 子进程、打包、桌面验证、浏览器启动、语音、SAPI…）。
//   抄成 9 份副本的那天起就注定漂移：有人只改了其中一处，另一处的乱码就会"修好了又回来"，
//   而且没有任何门禁看得出来。⇒ 只留一份，其余全部 require 它。
//   （`scripts/smoke/unit-child-output-decode.mjs` 的 A 段直接判「全仓 `function decodeOutput`
//     命中数恰好 1」，多一份就红。）
//
// ⚠️ 跨树 require 的通路与 `src/shared/pythonRuntime` 完全同款：仓库布局下解析到
//   `<repo>/src/main/childOutput.js`；打包布局下解析到 `resources/src/main/childOutput.js`
//   —— 那一份是靠 electron-builder.yml 的 extraResources 显式搬过去的（见该文件注释）。
//   改这里的路径前先看 `unit-package-closure.mjs` 的 P7，它专门判这条通路。
const { decodeOutput } = require('../../src/main/childOutput');

// 「这条命令到底在调用哪个程序、带什么开关、目标是哪」的**唯一解析真源**（2026-11 改造）。
// ★ 为什么 require 门控那份、而不是在本文件里再写一套切词：
//   系统级拦截的判据要从「整串子串匹配」换成「按命令头 + 参数 + 目标判定」（理由见
//   SC 段注释），而「切段 / 剥 sudo 之类包装 / 归一化命令名（去路径去 .exe 转小写）/ 拆开关」
//   这套解析 `src/main/riskGate.js` 里已经有了，且被 `scripts/smoke/unit-risk-gate.mjs`
//   133 条断言盯着。技能这边另写一份，就是两份切词逻辑并存的开始 —— 它们今天一致，
//   半年后必然不一致，而且没有任何读数看得出来（本仓纪律：同一件事只能有一处真源）。
// ⚠️ 打包通路：`skills/` 与 `src/` 都在 asar 之外的两棵树上，所以这条跨树 require
//   必须在 `electron-builder.yml` 的 extraResources 里有对应搬运条目，否则**打包产物里
//   每一次 shell-exec 调用都会在 require 阶段抛 Cannot find module**（那一节注释里
//   记着同款事故已经发生过三次）。`unit-package-closure.mjs` 的 P7 会直接判这条。
const {
  collectCommands,
  splitDashFlags,
  splitWinFlags,
  hasRecursiveFlag,
} = require('../../src/main/riskGate');

// 毫秒 → 可读秒（300000→"300"、1500→"1.5"）
function toReadableSeconds(ms) {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : String(Number(s.toFixed(1)));
}

/**
 * 杀掉整棵子进程树。
 * ⚠️ 必须杀树：因为 `shell:true`，child 本身是 cmd.exe，真正干活的命令是它的**子进程**；
 *    只 `child.kill()` 会把 cmd.exe 杀掉而留下孤儿子进程继续跑。
 * @param {import('child_process').ChildProcess|null} child
 */
function killTree(child) {
  if (!child || child.killed || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
    }
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* 已经退出 */ }
  }
}

/**
 * 异步执行一条命令并收集输出。**这就是"不阻塞主进程"的落点**：
 * 全程只注册事件回调，不做任何同步等待。
 *
 * 与 execSync 版本的行为对齐：
 *   · 输出按 stdout+stderr 合并返回（命令行习惯），超长截断；
 *   · 超时 ⇒ kill 进程树 + 可读文案（调用方无需自己判断 killed/SIGTERM）；
 *   · 非零退出 ⇒ 「命令执行失败：」+ stderr 摘要（文案与改造前一致，有门禁依赖它）。
 *
 * ★ 多出来的能力（改造前"写了但没生效"的两条，现在真生效）：
 *   · `opts.timeout` 到点会**真的**中断命令（事件循环没被占，timer 能 fire）；
 *   · `ctx.signal` abort（用户点停止）会**真的**杀掉命令，不再"停不下来"。
 *
 * @param {string} cmd 完整命令行
 * @param {ReturnType<typeof buildExecOptions>} opts
 * @param {{signal?:AbortSignal}} [ctx]
 * @returns {Promise<string>} 始终 resolve（失败也以可读文案返回，交给上层判失败）
 */
function spawnCollect(cmd, opts, ctx) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [], {
        cwd: opts.cwd,
        shell: opts.shell,
        stdio: opts.stdio,
        windowsHide: opts.windowsHide,
        // ★ 必须把 env 真正传给子进程：构造出来不用 = 白改（buildChildEnv 的注释里有实测后果）
        env: opts.env || process.env,
      });
    } catch (e) {
      resolve('命令执行失败：\n' + ((e && e.message) || String(e)));
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const capPush = (arr, buf) => {
      if (outBytes >= opts.maxBuffer) return;      // 到上限就不再累积（进程继续跑完）
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      outBytes += b.length;
      arr.push(b);
    };

    const signal = ctx && ctx.signal;
    const onAbort = () => { aborted = true; killTree(child); };

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && signal.addEventListener) {
        try { signal.removeEventListener('abort', onAbort); } catch (_) { /* ignore */ }
      }
      resolve(text);
    };

    // ① 真超时：到点杀整棵树。文案与原 execSync 版本一致（有门禁/文档引用它）。
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeout);

    // ② 真可中止：用户点「停止」⇒ 立刻杀命令（改造前 execSync 停不下来）。
    if (signal) {
      if (signal.aborted) { aborted = true; killTree(child); }
      else if (signal.addEventListener) {
        try { signal.addEventListener('abort', onAbort, { once: true }); } catch (_) { /* ignore */ }
      }
    }

    child.stdout.on('data', (d) => capPush(outChunks, d));
    child.stderr.on('data', (d) => capPush(errChunks, d));

    // 派生子进程本身失败（含本宿主上的 EBUSY 类错误）：以可读文案返回，不抛。
    child.on('error', (e) => {
      finish('命令执行失败：\n' + ((e && e.message) || String(e)));
    });

    child.on('close', (code) => {
      const stdoutText = decodeOutput(Buffer.concat(outChunks));
      const stderrText = decodeOutput(Buffer.concat(errChunks));
      const detail = stderrText.trim().slice(0, 2000);

      if (timedOut) {
        finish(`错误：命令超过 ${toReadableSeconds(opts.timeout)} 秒被中断，长任务建议拆小（例如先 npm install 再 npm run build）。\n${detail || ''}`);
        return;
      }
      if (aborted) {
        finish('错误：任务已被用户停止。');
        return;
      }
      if (code !== 0) {
        finish('命令执行失败：\n' + (detail || stdoutText.trim().slice(0, 2000) || ('退出码 ' + code)));
        return;
      }
      const merged = (stdoutText + (stderrText ? (stdoutText ? '\n' : '') + stderrText : '')).trim();
      const out = merged || '(命令执行成功，无输出)';
      finish(out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) + '\n…(输出过长已截断)' : out);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SC 段：系统级危险操作拦截（2026-11 重写）
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 这一整段为什么被重写 —— 一次**用户报的真实故障**，不是理论问题 ★★
 *
 * 用户让豆芽「装一个已经下载好的大肥鱼安装包」，模型试了四条路线：
 *     ① 静默安装 `"…\dafeiyu-pet-setup.exe" /S`
 *     ② `start "" "…\setup.exe"`
 *     ③ `powershell -Command "Start-Process -FilePath '…\setup.exe'"`
 *     ④ 查是否已装 `reg query "HKLM\…\Uninstall" /s /f "dafeiyu"`
 * 全部被同一句「错误：该命令已被拦截（涉及系统级危险操作）」挡回，用户据此得出
 * 「豆芽是不是没有装软件这个功能」的错误结论。
 *
 * 旧实现只有一行判据：
 *     const blocked = ['format','shutdown','restart','logoff','rm -rf /','del /f /s C:','rd /s /q C:'];
 *     if (blocked.some((b) => cmd.toLowerCase().includes(b))) return '…已被拦截…';
 *
 * 它有**三个**各自独立的缺陷，每一个单独都足以造成上面那种故障：
 *
 * 【缺陷① 判定的维度错了：对整条命令做子串匹配】
 *   `includes()` 分不清「命令头叫 format」和「这串文字里出现了 format 这几个字母」：
 *     · `powershell -Command "Get-Process | Format-List Name,Id"` ⇒ 命中 `format` ⇒ 被拦
 *       （**模型查"这个软件装了没"的最常用写法**，直接废）
 *     · `powershell -Command "Get-Service | Format-Table"`        ⇒ 命中 `format` ⇒ 被拦
 *     · `app-setup.exe /S /norestart`（NSIS 静默安装标配参数）    ⇒ 命中 `restart` ⇒ 被拦
 *     · `msiexec /i app.msi /qn /norestart`（MSI 静默安装标配）   ⇒ 命中 `restart` ⇒ 被拦
 *   ⇒ 命中率读数（2026-11 用一次性探针在同一个用例表上实测，脚本放在 `scripts/tmp-probe/`
 *     草稿区、不入库因此没法用 require 复活）：合法命令 **5/7 被误拦**、真正危险的 6/6 也拦住了
 *     —— 也就是说旧黑名单**既误杀又没漏放**，但误杀的代价远大于它挡下的东西。
 *   现在改成 **按解析出的「命令头 + 参数 + 目标」判定**：
 *     · `format` / `shutdown` / `restart` / `logoff` 一族 ⇒ 只有**命令头**等于它才拦；
 *       管道切开后那一段的命令头是 `format-list` / `format-table` ⇒ 合法，放行。
 *     · `/norestart`、`-NoRestart` 这类**参数**永远不构成拦截理由（它们只说明"装完别重启"）。
 *
 * 【缺陷② 命中之后什么都不说清】
 *   旧文案只有一句话，**不带命中的是哪个词**。模型和用户都无法判断该改什么，
 *   于是四条路线只会越试越偏（真正的病灶就在这里：一次拦截被浪费成了四次盲试）。
 *   现在文案里写出**解析到的实际命中项与判定依据**（哪个命令头 / 哪个开关 / 哪个目标触发），
 *   并给出「你想做的事大概率是另一条命令」的引导 —— 那正是本次故障里模型最需要的那句话。
 *   ⚠️ 首行必须仍然是 `错误：该命令已被拦截（涉及系统级危险操作）`：
 *      本仓有不变式 —— 判了失败的结果，文本自己也要能被 `isFailureResult` 认成失败，
 *      否则这次"没执行"会被记账成"完成"（`scripts/smoke/unit-failure-side-split.mjs` 钉着）。
 *
 * 【缺陷③ 把「命令名」和「命令名+危险参数+危险目标」塞进同一个列表】
 *   前四个是**命令名**（format/shutdown/restart/logoff），后三个是**组合形态**
 *   （`rm -rf /` / `del /f /s C:` / `rd /s /q C:`）。当字符串塞在一起，说明判定维度
 *   从一开始就是错的。现在分成两条各自表达清楚的规则：
 *     · 规则一「命令头即危险程序」（纯命令名匹配）
 *     · 规则二「递归/强制删除 + 目标指向盘根或系统根目录」（命令头 + 开关 + 目标三段都要命中）
 *   ⇒ `rm -rf ./dist` 这种正常清理**不拦**（它由 `src/main/riskGate.js` 那一道闸按范围判，
 *     本段只管"会把整机带走"的那一类）。
 *
 * ★ 为什么规则表是一个**可被门禁清空的数据结构**（`__systemBlockRules`）：
 *   否则无法证明「B 组读数之所以是绿的，是因为真的在判」，而不是因为判据恒 false。
 *   `scripts/smoke/unit-shellexec-blocklist.mjs` 的 C 组就靠把它清空来反控。
 */

/**
 * 危险**程序**（命令头）→ 拦截说明。
 *
 * 匹配口径：`collectCommands()` 解析出的 `head`（已去路径、去 `.exe`、转小写）。
 * 所以 `C:\Windows\System32\shutdown.exe` ⇒ `shutdown`，而 `Format-List` ⇒ `format-list`
 * （不是 `format`）—— 这正是本段要的精度。
 */
const BLOCKED_HEADS = [
  {
    head: 'format',
    why: '它会格式化整个分区/卷，那个分区上的数据会全部丢失',
    hint: '如果你只是想「格式化输出」，请用 Format-List / Format-Table（那只是 PowerShell 的显示格式，不会触发这条判定）。',
  },
  {
    head: 'format-volume',
    why: 'Format-Volume 会格式化整个卷，那个卷上的数据会全部丢失',
    hint: '如果你只是想「格式化输出」，请用 Format-List / Format-Table（那只是 PowerShell 的显示格式，不会触发这条判定）。',
  },
  {
    head: 'shutdown',
    why: '它会关机/重启这台机器，正在跑的任务与未保存的工作会一起丢掉',
    hint: '如果你想重启的是某个**服务或程序**，请用对应的命令（例如 net stop <服务名> / net start <服务名>，或 PowerShell 的 Restart-Service），那不会触发这条判定。',
  },
  {
    head: 'restart',
    why: '它会重启这台机器，正在跑的任务与未保存的工作会一起丢掉',
    hint: '同上：重启服务请用 Restart-Service，不要重启整机。',
  },
  {
    head: 'restart-computer',
    why: 'Restart-Computer 会重启这台机器，正在跑的任务与未保存的工作会一起丢掉',
    hint: '如果你想重启的是某个服务，请用 Restart-Service -Name <服务名>。',
  },
  {
    head: 'stop-computer',
    why: 'Stop-Computer 会关闭这台机器，正在跑的任务与未保存的工作会一起丢掉',
    hint: '如果你想停的是某个进程/服务，请用 Stop-Process / Stop-Service 并点名目标。',
  },
  {
    head: 'logoff',
    why: '它会注销当前登录会话，这个会话里没保存的东西会一起丢掉',
    hint: '如果你只是想关掉某个程序，请用 Stop-Process -Name <进程名>，不要注销整个会话。',
  },
];

/** 会「删东西」的命令头（Unix / cmd / PowerShell 三族都收）。 */
const DELETE_HEADS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'deltree', 'remove-item', 'ri']);

/**
 * 系统根目标（**精确匹配**，不做前缀匹配）。
 * ★ 为什么不做前缀：`/usr/local/lib/node_modules/x` 是正常工作目录，前缀匹配会把
 *   `rm -rf /usr/local/...` 一起拦掉 —— 而这类"清理某个具体子目录"恰恰是日常操作。
 *   这里要拦的是「目标本身就是根/系统根」那一种。
 */
const SYSTEM_ROOT_TARGETS = new Set([
  // POSIX
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys',
  '/var', '/opt', '/root', '/home', '/System', '/Library', '/Applications',
  // Windows（normalize 后是小写、分隔符统一成反斜杠）
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\users',
  '%systemroot%', '%systemdrive%', '%windir%', '$env:systemroot', '$env:systemdrive',
]);

/**
 * 纯函数：这个目标词是不是「盘根 / 系统根目录」。
 *
 * 认这些形态（去引号后比较）：
 *   · 盘根：`C:` / `C:\` / `C:/` / `C:\*` / `C:*`
 *   · POSIX 根：`/` / `//` / `/*`
 *   · 系统根目录名：见 `SYSTEM_ROOT_TARGETS`（精确匹配）
 *
 * @param {string} tok 解析出的目标词
 * @returns {boolean}
 */
function isRootOrSystemTarget(tok) {
  let s = String(tok == null ? '' : tok).trim();
  s = s.replace(/^["']+/, '').replace(/["']+$/, '');
  if (!s) return false;
  const low = s.toLowerCase();
  // POSIX 根：全是分隔符，或分隔符后跟通配（`/` `//` `/*`）
  if (/^\/+$/.test(low)) return true;
  if (/^\/+\*+$/.test(low)) return true;
  // Windows 盘根：`C:` / `C:\` / `C:/` / `C:\*`
  if (/^[a-z]:$/.test(low)) return true;
  if (/^[a-z]:[\\/]+$/.test(low)) return true;
  if (/^[a-z]:[\\/]*\*+$/.test(low)) return true;
  // 系统根目录（去掉尾部分隔符后精确匹配）
  const key = low.replace(/[\\/]+$/, '');
  if (!key) return false;
  return SYSTEM_ROOT_TARGETS.has(key) || SYSTEM_ROOT_TARGETS.has(key.replace(/\//g, '\\'));
}

/**
 * 规则一：命令头就是危险程序。
 * @param {string} cmd 命令原文
 * @returns {{hit:string, basis:string, hint:string}|null}
 */
function matchBlockedHead(cmd) {
  for (const c of collectCommands(cmd, 0)) {
    for (const rule of BLOCKED_HEADS) {
      if (c.head !== rule.head) continue;
      return {
        hit: c.head,
        basis: '这一段的命令头就是 ' + c.head + '，而不是参数或输出里出现的字样；' + rule.why,
        hint: rule.hint,
      };
    }
  }
  return null;
}

/**
 * 规则二：递归/强制删除 + 目标指向盘根或系统根目录。
 *
 * 三段**都要**命中才拦（这是本规则存在的全部意义：单看命令名 `rm` / `del` 是日常命令）：
 *   ① 命令头属于 `DELETE_HEADS`
 *   ② 带递归开关（Unix `-r/-R/-rf`、PowerShell `-Recurse`、cmd `/s`）
 *   ③ 目标里有一个是盘根/系统根（`isRootOrSystemTarget`）
 *
 * @param {string} cmd 命令原文
 * @returns {{hit:string, basis:string, hint:string}|null}
 */
function matchRootRecursiveDelete(cmd) {
  for (const c of collectCommands(cmd, 0)) {
    if (!DELETE_HEADS.has(c.head)) continue;
    const args = c.args || [];
    const dash = splitDashFlags(args);
    const win = splitWinFlags(args);
    const recursive = hasRecursiveFlag(dash.flags)
      || args.some((a) => /^-re(curse|s)$/i.test(a))     // -Recurse / -Recurse 的缩写 -Res
      || win.flags.indexOf('/s') >= 0;                    // cmd 风格 del /s、rd /s
    if (!recursive) continue;
    // 目标 = 既不是 `-开关`、也不是 `/开关` 的那些词（`splitWinFlags` 已把 `/x` 挑走）
    const targets = win.rest.filter((t) => t !== '--' && String(t).charAt(0) !== '-');
    for (const t of targets) {
      if (!isRootOrSystemTarget(t)) continue;
      const switchText = dash.flags.concat(win.flags).join(' ');
      return {
        hit: (c.tokens || []).join(' '),
        basis: '命令头是 ' + c.head + '，带了递归开关 ' + switchText
          + '，而目标是 ' + t + '（盘根/系统根目录）—— 递归强删会把这台机器上的一切一起删掉',
        hint: '如果只是要删某个具体的误装目录，请把目标写到那一个子路径（例如 D:\\soft\\xxx），不要指向盘根。',
      };
    }
  }
  return null;
}

/**
 * 规则表（**顺序 = 优先级**）。
 * ★ 这是一个可被门禁清空的数据结构，不是写死在 if-else 里：门禁的清空臂靠它证明
 *   「B 组的绿真的来自判定」。字段：
 *   `{ id, why, match(cmd) -> null | {hit, basis, hint} }`
 */
const __systemBlockRules = [
  { id: 'blocked-program-head', why: '命令头就是危险程序（format / shutdown / 关机重启注销一族）', match: matchBlockedHead },
  { id: 'root-recursive-delete', why: '递归强删 + 目标指向盘根/系统根目录', match: matchRootRecursiveDelete },
];

/**
 * 组装拦截文案。
 *
 * ★ 首行**必须**是 `错误：该命令已被拦截（涉及系统级危险操作）`：本仓不变式 ——
 *   判了失败的结果，文本自己也要能被 `isFailureResult` 认成失败；有测试/文档引用这句话。
 * ★ 第二行必须写出**解析到的实际命中项与判定依据**：模型据此才知道"该改哪一处"，
 *   而不是像本次故障那样把四条路线挨个重试一遍。
 *
 * @param {{hit:string, basis:string, hint:string}} v 命中详情
 * @returns {string}
 */
function buildBlockedMessage(v) {
  const lines = [
    '错误：该命令已被拦截（涉及系统级危险操作）',
    '命中项：' + v.hit + '（' + v.basis + '）',
  ];
  if (v.hint) lines.push(v.hint);
  lines.push('这条判定只看**命令头 / 开关 / 目标**，不会因为命令里出现某个词就拦 —— 换一种更精确的写法通常就能做成你想做的事。');
  return lines.join('\n');
}

/**
 * 判定一条命令是否属于「系统级危险操作」（**纯函数**，不派生任何进程）。
 * @param {string} cmd 命令原文
 * @returns {{ruleId:string, hit:string, basis:string, hint:string, message:string}|null}
 */
function classifySystemBlock(cmd) {
  const text = String(cmd == null ? '' : cmd);
  if (!text.trim()) return null;
  for (const rule of __systemBlockRules) {
    let hit = null;
    try {
      hit = rule.match(text);
    } catch (e) {
      // 判据自己出错时**不放行**也不抛：保守方向取"拦下并说清"，交给人看。
      hit = { hit: '(判据异常)', basis: '拦截判据自身出错：' + ((e && e.message) || String(e)), hint: '请把这条命令报给开发者。' };
    }
    if (!hit) continue;
    return {
      ruleId: rule.id,
      hit: hit.hit,
      basis: hit.basis,
      hint: hit.hint || '',
      message: buildBlockedMessage(hit),
    };
  }
  return null;
}

async function run(params, ctx) {
  if (!params.command) return '错误：请提供要执行的命令';
  const cmd = String(params.command).trim();
  // 安全拦截：系统级危险操作（判据见上方 SC 段；**按命令头/开关/目标判，不做整串子串匹配**）
  const blocked = classifySystemBlock(cmd);
  if (blocked) return blocked.message;
  const opts = buildExecOptions(params);
  return spawnCollect(cmd, opts, ctx);
}

module.exports = {
  run,
  resolveTimeoutMs,
  buildExecOptions,
  buildChildEnv,   // 导出供门禁直接断言「PATH 是否指向真源解析出的那个 python」
  decodeOutput,
  killTree,
  spawnCollect,
  // 系统级拦截判据（导出供 `scripts/smoke/unit-shellexec-blocklist.mjs` 直接断言 + 反控）。
  // `__systemBlockRules` 是**可变**的规则表：清空它 ⇒ 所有本该拦的命令必须全部放行，
  // 这是"B 组的绿不是恒真"的证明手段。
  classifySystemBlock,
  buildBlockedMessage,
  isRootOrSystemTarget,
  __systemBlockRules,
  BLOCKED_HEADS,
  DELETE_HEADS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
};
