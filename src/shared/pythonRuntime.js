/**
 * pythonRuntime.js —— 「Python 解释器到底是谁」的**一份真源**。
 *
 * 【为什么必须存在这个文件】
 *   2026-10-23 真机端到端（`scripts/verify/e2e-pptx-real-task.mjs`，run-20261023042103）抓到一条
 *   **产品级缺陷**，症状看着像模型胡说，实际是同一语义养了三套实现：
 *
 *     · Python 技能（ppt-generate / excel-generate …）走 `src/main/skills.js:resolvePython()`
 *       → 用自带 `python-runtime/python.exe`（里面装了 python-pptx 1.0.2）→ 生成 pptx 成功；
 *     · `shell-exec` 用 `spawn` 且**没传 env** → 子进程按宿主 PATH 找 `python`
 *       → 落到**系统 python**（没装 pptx）→ `ModuleNotFoundError: No module named 'pptx'`；
 *     · 主进程的 TTS / 录音走 `src/main/main.js:pythonBin()` —— **第三套**，只看 PYTHON_RUNTIME_DIR。
 *
 *   后果：同一个产品里"python 是谁"有两个答案。模型先探测环境（turn 0 / turn 2 各失败一次），
 *   据此对用户写下「本机缺少解析该格式的组件，装依赖也没成功」——**这是一句假话**；
 *   而且这条假失败被算进 unresolved ⇒ 终态从 COMPLETE 掉到 PARTIAL。
 *
 * 【本文件做什么】
 *   只做一件事：给出**唯一的**解析顺序，并把结果翻译成两类调用方各自需要的东西
 *     · `resolvePython()`   → 解释器路径（给 execFile / spawn 当命令用）
 *     · `shellEnv()`        → 给 **shell 字符串** 用的环境（PATH 前置 + PYTHON_PATH）
 *   后者存在的原因是：`shell:true` 的命令行里写的是裸 `python`，由 cmd.exe 按 PATH 解析，
 *   光有解释器绝对路径没用 —— 必须让 PATH 自己指向对的那个。
 *
 * 【解析顺序（三处必须一致，改这里就是改全部）】
 *   1. `PYTHON_PATH`                  —— 显式指定优先（用户/测试可以硬覆写）
 *   2. `PYTHON_RUNTIME_DIR/python.exe` —— 打包时 main.js 设的环境变量
 *   3. `process.resourcesPath/python-runtime/python.exe` —— 打包内部的默认位置
 *   3.5 `<仓库根>/python-runtime/python.exe` —— **开发态 / 纯 node 脚本**用的那一档
 *   4. 裸 `python.exe` / `python3`     —— 交给系统 PATH（开发机常态）
 *
 * 【为什么必须有 3.5 这一档（2026-10-30 实测，不是推测）】
 *   上面 1~3 档在「纯 node 进程」里**全都落空**：
 *     · 纯 node 下没有 `process.resourcesPath`（那是 electron 主进程专有）；
 *     · dev 模式（`electron .`）下 `app.isPackaged === false` ⇒ main.js **不设** `PYTHON_RUNTIME_DIR`；
 *     · electron 的 `resourcesPath` 在 dev 下指向 `node_modules/electron/dist/resources`，里面没有 runtime。
 *   ⇒ 直接掉到第 4 档裸 `python.exe`。而不同机器上"裸 python"是谁完全不受控，
 *     本机实测它就是 `~/.workbuddy/binaries/python/versions/3.13.12` —— **一个包都没装**：
 *
 *       $ node -e "console.log(require('./src/shared/pythonRuntime.js').resolvePython())"
 *       { "exe": "python.exe", "source": "PATH" }
 *       $ python -c "import numpy"   →  ModuleNotFoundError: No module named 'numpy'
 *       $ ./python-runtime/python.exe -c "import numpy"  →  numpy 2.5.2  ✔（仓内自带那个）
 *
 *   症状极具误导性：技能报 `ModuleNotFoundError`，看上去像"用户环境缺依赖"，
 *   而真相是**仓库里明明躺着一个装好 numpy/PIL/python-pptx 的解释器，代码却没用它**。
 *   2026-10-30 `skills/cutout`（纯 numpy 实现）就是被这一档坑掉的：dev 下必炸，
 *   而门禁因为自己另写了一套 `findPython()`（第 2 档就命中仓内 runtime）**全绿** ——
 *   典型的「开发态全绿、真机死」。这正是老板说的"根本不能闭环"的同一种形态。
 *
 *   为什么不并进第 3 档：语义不同。第 3 档是"打包产物里的 runtime"（extraResources），
 *   3.5 档是"源码树里的 runtime"（仓库自带）。打包后前者存在、后者不存在（在 asar 里），
 *   两者天然互斥，分开写才能各自如实报 source，排障时一眼看出命中的是哪一个。
 *
 * 【纪律】
 *   · 每条候选都必须**真实存在**才算数（`exists` 可注入，便于单测不碰真盘）；
 *   · 走到第 4 档时 `shellEnv` **原样返回**环境，不做任何 PATH 改动
 *     ⇒ 开发机没有自带 runtime 时，行为与引入本文件之前**逐字相同**（不制造新差异）；
 *   · 只**前置** PATH，不替换 —— node / git / npm 等照常可用。
 */
const path = require('path');
const fs = require('fs');

/**
 * 源码树根（dev / 纯 node 脚本下的"仓库根"）。
 * `__dirname` 恒为 `<root>/src/shared` ⇒ 上两级就是根。
 * 打包后这里是 `app.asar`（asar 内**不含** python-runtime，它在 extraResources），
 * `exists` 会自然返回 false ⇒ 3.5 档静默跳过，不会盖掉第 3 档。
 */
const SRC_TREE_ROOT = path.resolve(__dirname, '..', '..');

/** 平台对应的解释器文件名 */
function exeName(platform) {
  return platform === 'win32' ? 'python.exe' : 'python3';
}

/**
 * 解析解释器。纯函数：所有外部依赖（env / resourcesPath / platform / exists）都可注入。
 * @param {{env?:object, resourcesPath?:string, platform?:string, exists?:(p:string)=>boolean,
 *          srcTreeRoot?:string|false}} [opts]
 *   srcTreeRoot —— 3.5 档的源码树根。默认 `path.resolve(__dirname,'..','..')`；
 *     测试可注入任意目录；显式传 `false` 关闭该档（用于证明"没有它就会掉到 PATH"）。
 * @returns {{exe:string, source:'PYTHON_PATH'|'PYTHON_RUNTIME_DIR'|'resourcesPath'|'srcTree'|'PATH'}}
 */
function resolvePython(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  // 默认 probes：process.resourcesPath 只有 electron 主进程里才有，普通 node 下是 undefined
  const resourcesPath = 'resourcesPath' in o ? o.resourcesPath : process.resourcesPath;
  const exists = typeof o.exists === 'function' ? o.exists : (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };
  const name = exeName(platform);

  // 1. 显式指定
  if (env && env.PYTHON_PATH && exists(env.PYTHON_PATH)) {
    return { exe: env.PYTHON_PATH, source: 'PYTHON_PATH' };
  }
  // 2. / 3. 打包内嵌
  const candidates = [];
  if (env && env.PYTHON_RUNTIME_DIR) {
    candidates.push({ exe: path.join(env.PYTHON_RUNTIME_DIR, name), source: 'PYTHON_RUNTIME_DIR' });
  }
  if (resourcesPath) {
    candidates.push({ exe: path.join(resourcesPath, 'python-runtime', name), source: 'resourcesPath' });
  }
  // 3.5 源码树自带的 runtime（dev / 纯 node 脚本；见头注「为什么必须有 3.5 这一档」）
  //    ★ 必须排在 resourcesPath **之后**：打包后两者不会同时为真（asar 里没有 python-runtime），
  //      但万一有（比如 `--dir` 手工拼的产物），打包产物里的那个才是"跟这次安装绑定"的那份。
  if (o.srcTreeRoot !== false) {
    const srcRoot = typeof o.srcTreeRoot === 'string' ? o.srcTreeRoot : SRC_TREE_ROOT;
    candidates.push({ exe: path.join(srcRoot, 'python-runtime', name), source: 'srcTree' });
  }
  for (const c of candidates) {
    if (exists(c.exe)) return { exe: c.exe, source: c.source };
  }
  // 4. 系统 PATH（裸名，由 shell 解析）
  return { exe: name, source: 'PATH' };
}

/**
 * 给「shell 字符串」准备子进程环境：把解析到的解释器所在目录**前置**到 PATH，并设 PYTHON_PATH。
 *
 * ★ 为什么还要设 PYTHON_PATH：任何调用方只要按 `resolvePython()` 的口径再找一次，
 *   拿到的就是同一个解释器 —— 不再有"父子进程各认一个 python"的分叉。
 *
 * @param {object} [baseEnv] 起始环境（默认 process.env 的浅拷贝）
 * @param {object} [opts]    同 resolvePython 的注入项
 * @returns {{env:object, exe:string, source:string, changed:boolean}}
 */
function shellEnv(baseEnv, opts) {
  const o = opts || {};
  const env = { ...(baseEnv || process.env) };
  const platform = o.platform || process.platform;
  let r;
  try {
    r = resolvePython({ ...o, env });
  } catch (_) {
    return { env, exe: exeName(platform), source: 'PATH', changed: false };
  }
  if (r.source === 'PATH') {
    // 没有自带 runtime：保持改前行为（PATH 一个字都不动）
    return { env, exe: r.exe, source: r.source, changed: false };
  }
  try {
    const dir = path.dirname(r.exe);
    const sep = platform === 'win32' ? ';' : ':';
    const oldPath = env.PATH || env.Path || '';
    env.PATH = oldPath ? dir + sep + oldPath : dir;
    // Windows 上 PATH/Path 是同一个变量的两个大小写别名，统一写一份，免得"改了 Path 读的是 PATH"
    if (platform === 'win32') env.Path = env.PATH;
    env.PYTHON_PATH = r.exe;
    return { env, exe: r.exe, source: r.source, changed: true };
  } catch (_) {
    // 环境构造失败绝不能连累命令执行：退回原环境
    return { env, exe: r.exe, source: r.source, changed: false };
  }
}

module.exports = { resolvePython, shellEnv, exeName };
