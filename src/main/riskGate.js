/**
 * riskGate.js —— 「危险操作门控」的**唯一判据**（G3，2026-10-24）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个文件为什么存在（要钉住的缺陷）
 * ═══════════════════════════════════════════════════════════════════════
 *   `shell-exec` 在授权分档里是 **auto** 档（`AUTH_TIER_BY_TOOL` 只覆盖 deploy/ssh/db 一类
 *   **技能名**），于是模型只要想跑 `chmod -R 777 <dir>` / `rm -rf <dir>` /
 *   `sed -i ... scripts/smoke/xxx.mjs` 这种「看起来在解决问题、副作用比问题本身更大」的命令，
 *   系统就会**原样执行**，既不拦、也不留痕、更不会说清范围。
 *   最坏的一条不是删文件，而是**改验收脚本本身**：它让"测试变绿"这件事失去意义，
 *   之后所有读数都不可信 —— 所以那一条必须**直接拦下**，不是"问一下"。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 设计纪律（每一条都有代价，写清楚是为了以后别改错）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **纯函数、零 fs**。`classifyRisk` 不读文件、不看时间、不写日志、不读环境变量。
 *      判定与文案全在这里，backend 只负责"拦"这个动作。
 *      ⇒ 单测可以直接断言判定结果，不必先摆环境；同一输入永远同一结论（取证可复现）。
 *      ⇒ 唯一的例外是 `isGateEnabled()`：那是**开关**，本来就该读环境。它和判据分开两个函数，
 *        是为了不让"要不要拦"污染"危不危险"这件事。
 *   ② **规则按通用形态匹配，绝不写死任何一次事故里的字面量**。
 *      规则里出现的路径族（`scripts/smoke|verify|...`）是**产品约定**，不是某一条测试命令；
 *      反之，任何"某次踩坑的具体目录/变量名"都不许进来 —— 那是背答案，不是能力。
 *      `scripts/smoke/unit-risk-gate.mjs` 有一条自证在盯这件事。
 *   ③ **目标必须从命令里解析出来**，文案里写出**解析到的实际路径**。
 *      写死一句话文案的后果是：换一个路径，用户看到的还是上一句话，等于没解释。
 *   ④ **误杀比漏放更贵**。`shell-exec` 是 auto 档，构建、跑测试、装依赖、grep 天天在跑。
 *      所以每条规则都**锚定命令段的首个词**（`head`），而不是在整串文本里找关键词：
 *      `grep "rm -rf" docs/` / `echo "chmod -R 777"` 这类**提到**危险词的命令一律不拦。
 *   ⑤ **两条互不替代的闸**：`needsUserConfirm`（backend）按**技能名/action 档位**决定要不要弹窗，
 *      本模块按**命令形态**决定要不要直接拦死。本模块不改那条闸的语义，只在它**之前**多一道。
 */

'use strict';

// ===========================================================================
// 一、常量：类别 / 等级
// ===========================================================================

/**
 * 危险等级。
 *   · `block`   —— **直接拦下，绝不执行**。判据是"执行下去就回不来了，而且回来也未必是原件"
 *                 （递归放开权限 / 递归强删 / 改验收脚本 / 丢未提交改动 / 删库）。
 *   · `confirm` —— 危险但**可协商**。判据是"可重建 / 可回滚"，例如删掉一个纯构建产物目录。
 *                 这类只要求用户明确点一下，不要求拦死。
 */
const RISK_LEVEL = Object.freeze({
  BLOCK: 'block',
  CONFIRM: 'confirm',
});

/** 危险类别。增删都要同步改 humanLabel 与单测里的预期表。 */
const RISK_CATEGORY = Object.freeze({
  /** 递归放开权限（`chmod -R 777` / `-R a+rwx` / `-R o+w` …） */
  RECURSIVE_PERMISSION: 'recursive-permission',
  /** 递归强删（`rm -rf` / `del /s /q` / `Remove-Item -Recurse -Force` …） */
  RECURSIVE_DELETE: 'recursive-delete',
  /** 篡改验收脚本/测试本身（`sed -i` / 重定向 / `tee` / `cp|mv` 覆盖写 … 打到验收路径族） */
  TAMPER_VERIFICATION: 'tamper-verification',
  /** 破坏性版本操作（`git reset --hard` / `git checkout --` / `git clean -f` …） */
  DESTRUCTIVE_VCS: 'destructive-vcs',
  /** 破坏性数据库操作（`DROP TABLE` / `TRUNCATE` / 无 where 的 `DELETE`） */
  DESTRUCTIVE_DB: 'destructive-db',
});

/** 类别 → 人话（文案里用，也便于用户/前端读取）。 */
const CATEGORY_LABEL = Object.freeze({
  [RISK_CATEGORY.RECURSIVE_PERMISSION]: '递归放开权限',
  [RISK_CATEGORY.RECURSIVE_DELETE]: '递归强制删除',
  [RISK_CATEGORY.TAMPER_VERIFICATION]: '篡改验收脚本',
  [RISK_CATEGORY.DESTRUCTIVE_VCS]: '丢弃未提交改动',
  [RISK_CATEGORY.DESTRUCTIVE_DB]: '不可撤销的数据库操作',
});

// ===========================================================================
// 二、开关（唯一读环境变量的地方）
// ===========================================================================

/**
 * 门控总开关，**默认开**。
 *
 * 为什么"关"要宽松、认 `off`：`DOUYA_RISK_GATE=false` / `off` / `no` / `0` 都算关 ——
 * 用户以为关掉了其实还在拦，比"关不掉"更糟（他会据此给出错误的结论）。
 *
 * ★ 为什么 `classifyRisk` 自己不读这个开关：判据要能被单测**直接断言**，
 *   而且"危不危险"和"要不要拦"是两个问题。把两者混在一个函数里，
 *   将来想知道"这条命令到底危险吗"就必须先摆环境 —— 取证成本一下就上去了。
 *   所以这里分成两个函数：`classifyRisk`（纯判定）+ `isGateEnabled`（纯开关）。
 *
 * @returns {boolean} true = 闸门生效（默认）；false = 闸门关闭（只判定、不拦）
 */
function isGateEnabled() {
  const v = String(process.env.DOUYA_RISK_GATE == null ? '' : process.env.DOUYA_RISK_GATE).trim();
  if (!v) return true;                                  // 未设置 ⇒ 开
  return !/^(0|false|off|no|disable|disabled)$/i.test(v); // 只认明确的"关"
}

// ===========================================================================
// 三、命令解析（纯字符串处理，零 fs）
// ===========================================================================

/** 命令参数可能落在哪些键上（不同技能的习惯不同，全看一遍比猜一个稳）。 */
const COMMAND_KEYS = Object.freeze(['command', 'cmd', 'shell', 'script', 'commandLine', 'cmdline']);
/** SQL 参数可能落在哪些键上。 */
const SQL_KEYS = Object.freeze(['sql', 'query', 'statement']);

/**
 * 取出"要执行的命令文本"。非对象 / 无该字段 / 空串一律返回 ''。
 * @param {unknown} params 技能参数
 * @returns {string}
 */
function commandTextOf(params) {
  if (!params || typeof params !== 'object') return '';
  for (const k of COMMAND_KEYS) {
    const v = params[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 取出"要执行的 SQL 文本"。
 * @param {unknown} params 技能参数
 * @returns {string}
 */
function sqlTextOf(params) {
  if (!params || typeof params !== 'object') return '';
  for (const k of SQL_KEYS) {
    const v = params[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 把命令文本按 shell 分隔符切成"命令段"。
 * 分隔符：换行 / `;` / `&&` / `||` / `|` / `&`；引号内的分隔符**不算**。
 *
 * 为什么要切段：`rm -rf a && npm i` 里只有前半截是危险动作，后半截是正常的；
 * 把整串当一个命令会让规则既难写又容易误判（"整串里出现了 rm -rf" ⇒ grep 也会中招）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSegments(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || ch === '&') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * 把一段命令切成词（去掉包裹的引号，保留内容）。重定向符号 `>` / `>>` 各自成为一个词。
 * @param {string} seg
 * @returns {string[]}
 */
function splitTokens(seg) {
  const out = [];
  const s = String(seg == null ? '' : seg);
  let cur = '';
  let has = false;
  let quote = '';
  const flush = () => { if (has) { out.push(cur); cur = ''; has = false; } };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      cur += ch; has = true; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '>') {
      flush();
      if (s[i + 1] === '>') { out.push('>>'); i += 1; } else { out.push('>'); }
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    cur += ch; has = true;
  }
  flush();
  return out;
}

/** 包装命令：它们自己不干活，真正的命令在它们后面。 */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'setsid', 'ionice', 'nice', 'xargs']);
/** 嵌套 shell：`bash -c "…"` / `powershell -c "…"` / `cmd /c "…"`。 */
const NESTED_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh', 'cmd']);

/**
 * 归一化命令名：去掉目录前缀与可执行后缀，转小写。
 * `C:\Windows\System32\cmd.exe` → `cmd`；`/usr/bin/rm` → `rm`；
 * `C:\Windows\System32\format.com` → `format`（★ `.com` 是真的可执行后缀：
 * Windows 自带的磁盘格式化程序就叫 `format.com`，只剥 `.exe` 会把它当成另一个程序，
 * 于是 `C:\Windows\System32\format.com D:` 逃过"命令头精确匹配"这一类判据）。
 * @param {string} w
 * @returns {string}
 */
function normalizeHead(w) {
  const s = String(w == null ? '' : w).trim();
  if (!s) return '';
  const base = s.split(/[\\/]/).pop() || s;
  return base.replace(/\.(?:exe|com|bat|cmd)$/i, '').toLowerCase();
}

/**
 * 剥掉 sudo/env/nice 这类包装，让 `head` 落到真正干活的命令上。
 * 会顺带跳过包装命令自己的选项与选项值（`sudo -u root rm -rf /x`）。
 * @param {string[]} toks
 * @returns {string[]}
 */
function stripWrappers(toks) {
  let t = toks.slice();
  let guard = 0;
  const VALUED = /^-(?:u|g|U|p|C|n|c|t)$/; // 这些开关后面**跟一个值**
  while (t.length && guard < 8) {
    guard += 1;
    if (!WRAPPERS.has(normalizeHead(t[0]))) break;
    t = t.slice(1);
    while (t.length && (t[0].charAt(0) === '-' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) {
      const valued = VALUED.test(t[0]);
      t = t.slice(1);
      if (valued && t.length) t = t.slice(1);
    }
  }
  return t;
}

/**
 * 把命令文本展开成「简单命令」列表。嵌套 shell 会被递归展开一层（最多 3 层）。
 *
 * @param {string} text 命令文本
 * @param {number} [depth] 递归深度（内部用）
 * @returns {Array<{head:string, args:string[], tokens:string[], text:string}>}
 */
function collectCommands(text, depth) {
  const d = Number(depth) || 0;
  const out = [];
  if (d > 3) return out;
  for (const seg of splitSegments(text)) {
    let toks = stripWrappers(splitTokens(seg));
    if (!toks.length) continue;
    const head = normalizeHead(toks[0]);
    if (NESTED_SHELLS.has(head)) {
      const i = toks.findIndex((x) => /^(?:-c|-command|\/c|\/k|-e)$/i.test(x));
      if (i >= 0 && toks.length > i + 1) {
        const inner = toks.slice(i + 1).join(' ');
        for (const sub of collectCommands(inner, d + 1)) out.push(sub);
        continue;
      }
    }
    out.push({ head, args: toks.slice(1), tokens: toks, text: seg });
  }
  return out;
}

/**
 * 拆 `-x` 形式的开关与其余参数（Windows 风格的 `/s` 由各规则自己处理，
 * 因为 `/srv` 这种**真实路径**也长得像开关，全局当开关会误判）。
 * @param {string[]} args
 * @returns {{flags:string[], rest:string[]}}
 */
function splitDashFlags(args) {
  const flags = [];
  const rest = [];
  for (const t of args || []) {
    if (typeof t === 'string' && t.length > 1 && t.charAt(0) === '-') flags.push(t);
    else rest.push(t);
  }
  return { flags, rest };
}

/** Windows 风格开关（只在 del/rd/rmdir 这类命令里认，避免把 `/srv` 当开关）。 */
const WIN_FLAGS = new Set(['/s', '/q', '/f', '/c', '/d', '/r', '/i', '/p', '/t', '/y', '/a', '/b', '/e', '/g', '/h', '/k', '/l', '/m', '/n', '/o', '/u', '/v', '/w', '/x']);

/**
 * 拆 Windows 风格开关（仅用于 del/rd/rmdir/format 一类）。
 * @param {string[]} args
 * @returns {{flags:string[], rest:string[]}}
 */
function splitWinFlags(args) {
  const flags = [];
  const rest = [];
  for (const t of args || []) {
    if (typeof t === 'string' && WIN_FLAGS.has(t.toLowerCase())) flags.push(t.toLowerCase());
    else rest.push(t);
  }
  return { flags, rest };
}

// ===========================================================================
// 四、路径族判据（"这是不是验收脚本/测试"）
// ===========================================================================

/**
 * 验收脚本目录族。这是**产品约定**（判定产品好坏的那把尺子放在哪里），
 * 不是某一条测试命令的路径 —— 换任何库、任何文件名，只要落在这几个目录下都算。
 */
const VERIFY_DIR_RE = /(?:^|[\\/])scripts[\\/](?:smoke|verify|challenges|tmp-probe)(?:[\\/]|$)/i;
/** 测试文件命名约定：`*.test.*` / `*.spec.*`。 */
const VERIFY_TESTFILE_RE = /[^\\/]\.(?:test|spec)\.[A-Za-z0-9]+$/i;

/**
 * 这个路径词是不是落在「验收脚本/测试」路径族里。
 * @param {string} tok
 * @returns {boolean}
 */
function isVerificationPath(tok) {
  const s = String(tok == null ? '' : tok).trim();
  if (!s || s.length > 400) return false;
  return VERIFY_DIR_RE.test(s) || VERIFY_TESTFILE_RE.test(s);
}

/**
 * 可重建产物目录：删掉它们之后**一条构建命令就能一模一样重建**，所以只降级到 confirm。
 *
 * ★ 这份白名单的纪律：只收「由构建命令一次生成、不会被手工修改」的目录名。
 *   常被手工打补丁 / 手工 link 的依赖目录**故意不在**这里 —— 缺省即"不可重建 ⇒ block"，
 *   保守方向永远是好的一侧。
 */
const DISPOSABLE_DIRS = new Set([
  'dist', 'build', 'out', 'output', 'target', 'coverage', 'tmp', 'temp',
  '.cache', '.next', '.nuxt', '.output', '.turbo', '.parcel-cache', '.svelte-kit',
  '.nyc_output', '.eslintcache', '.rollup.cache', '.tsbuildinfo',
]);

/**
 * 目标是不是「相对路径 + 可重建产物目录」。
 * 绝对路径 / 家目录 / 含 `..` / 目录名不在白名单 → 一律不算（⇒ 走 block）。
 * @param {string} target
 * @returns {boolean}
 */
function isDisposableTarget(target) {
  const raw = String(target == null ? '' : target).trim().replace(/^["']|["']$/g, '');
  if (!raw) return false;
  if (/^[\\/]/.test(raw)) return false;          // 绝对路径（含 Windows 盘根）
  if (/^[A-Za-z]:[\\/]/.test(raw)) return false; // 盘符路径
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return false;
  if (raw.split(/[\\/]/).includes('..')) return false;
  const parts = raw.split(/[\\/]/).filter((x) => x && x !== '.');
  if (!parts.length) return false;
  return DISPOSABLE_DIRS.has(parts[parts.length - 1].toLowerCase());
}

// ===========================================================================
// 五、权限模式判据（`777` / `a+rwx` / `o+w` …）
// ===========================================================================

/**
 * 这个 chmod 模式是否**放开了全局可写位**（"谁都能改"）。
 *
 * 只认"放开"，不认"收紧"：`go-w` / `o-w` 这类减法一律返回 false ——
 * 那是在**修**权限问题，拦住它等于把唯一的正确做法也一起拦了。
 *
 * @param {string} mode chmod 的模式参数
 * @returns {boolean}
 */
function isWorldWritableMode(mode) {
  const m = String(mode == null ? '' : mode).trim();
  if (!m) return false;
  // 八进制：看"其他人"那一位有没有写权限（2）
  if (/^[0-7]{3,4}$/.test(m)) return (parseInt(m.slice(-1), 8) & 2) === 2;
  // 符号式：按逗号拆成若干 clause，逐条看「给谁 + 加/减 + 哪些位」
  for (const clause of m.split(',').map((x) => x.trim()).filter(Boolean)) {
    const mm = clause.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/);
    if (!mm) continue;
    const who = mm[1] || '';   // 空 = 所有人（等价 a）
    const op = mm[2];
    const bits = mm[3];
    if (op === '-') continue;                    // 减权限不是放开
    if (!bits.includes('w')) continue;           // 没加写位
    const affectsOthers = who === '' || who.includes('a') || who.includes('o');
    if (affectsOthers) return true;
  }
  return false;
}

/** 递归开关（`-R` / `-r` / `-Rv` / `--recursive`）。 */
function hasRecursiveFlag(flags) {
  return (flags || []).some((f) => /^--recursive$/i.test(f) || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(f));
}
/** 强制开关（`-f` / `-Rf` / `--force`）。 */
function hasForceFlag(flags) {
  return (flags || []).some((f) => /^--force$/i.test(f) || /^-[A-Za-z]*f[A-Za-z]*$/.test(f));
}
/** 就地编辑开关（`-i` / `-i.bak` / `--in-place`）。 */
function hasInPlaceFlag(flags) {
  return (flags || []).some((f) => /^--in-place(=.*)?$/i.test(f) || /^-i/.test(f) || /^-[A-Za-z]*i[A-Za-z]*$/.test(f));
}

// ===========================================================================
// 六、文案模板
// ===========================================================================

/**
 * 三段说明的**内容**在这里生成，格式统一由 buildMessage 拼。
 *
 * 三条纪律：
 *   ① 每一段都要写出**解析到的实际目标**（不是"某个目录"这种空话）；
 *   ② 段内不用句号/分号 —— 这三个标签会被"是否说清了"的判据按行切分核对内容，
 *      句读符号会把一句完整的话切碎，看起来像"没说完"；
 *   ③ "可逆"必须给出**能不能回滚 + 为什么**，"替代"必须给出**更小的、能达成同样目的的做法**。
 */
const COPY = {
  [RISK_CATEGORY.RECURSIVE_PERMISSION]: (t) => ({
    range: '会递归改动 ' + t + ' 整棵目录树（含全部子目录与文件）的权限位，把「谁都能写」这一位打开，范围远大于你这次要修的那一个目录',
    reversible: '不可逆 —— 原有权限位不会被保存下来，没有事先备份就无法还原成原来的样子',
    alternative: '只给真正需要写的那一个目录加最小权限，例如 chmod -R u+rwX,go-w ' + t + ' 或 chown -R <当前用户> ' + t,
  }),
  [RISK_CATEGORY.RECURSIVE_DELETE]: (t) => ({
    range: '会递归强删 ' + t + ' 整棵目录树，目录里的本地修改、未提交的补丁、离线准备好的文件会一并消失',
    reversible: '不可逆 —— 递归删除不进回收站，被删内容若不在版本记录里就找不回来',
    alternative: '先用 ls -la ' + t + ' 看清里面有什么，再把要删的缩到具体那一个子路径（或只重装坏掉的那一个包），必要时先整目录备份再动手',
  }),
  [RISK_CATEGORY.TAMPER_VERIFICATION]: (t) => ({
    range: '改的是验收脚本本身 ' + t + ' —— 这是判定产品好坏的那把尺子，不是被测代码',
    reversible: '不可逆 —— 就地覆盖原文件且没有留下 .bak 副本，原来的断言找不回来',
    alternative: '改被测代码让这条断言真的转绿；若确属预期变更，走评审后显式改断言并写清理由，不要为了让测试通过而改测试',
  }),
  [RISK_CATEGORY.DESTRUCTIVE_VCS]: (t) => ({
    range: '会丢掉 ' + t + ' 上全部未提交的本地改动（工作区里还没提交的内容会被直接覆盖）',
    reversible: '不可逆 —— 未提交的改动不在任何版本记录里，丢弃后无法再用 git 找回',
    alternative: '先 git stash 或 git diff > 补丁文件 把改动存下来再动，或只回退具体那一个文件而不是整棵工作区',
  }),
  [RISK_CATEGORY.DESTRUCTIVE_DB]: (t) => ({
    range: '会不可撤销地清掉数据库里的 ' + t + '（整表或整库的数据与结构）',
    reversible: '不可逆 —— 执行完没有回滚点，除非事先有备份或整段包在事务里且尚未提交',
    alternative: '先 SELECT 出范围与行数、导出备份，再在事务里执行并在确认影响面之后提交，需要删除时带上精确的 where 条件',
  }),
};

/**
 * 组装回灌给模型的文案。
 *
 * ★★ 必须以**失败前缀**开头（`错误：`）。本仓有一条不变式：判了失败的结果，
 *    文本自己也得能被 `isFailureResult` 认成失败，否则会被记成"完成"
 *    （`scripts/smoke/unit-failure-side-split.mjs` 钉着这条）。
 * ★ 命令原文原样带上：这是事后唯一能对上"到底想跑什么"的证据。
 *
 * @param {object} o
 * @returns {string}
 */
function buildMessage(o) {
  const label = CATEGORY_LABEL[o.category] || o.category;
  const head = o.level === RISK_LEVEL.BLOCK
    ? '错误：这条命令被「危险操作门控」判为' + label + '，**已拦下、没有执行**。'
    : '错误：这条命令被「危险操作门控」判为' + label + '，执行前需要用户明确确认。';
  const lines = [
    head,
    '',
    '命令（' + (o.name || 'shell-exec') + '）：' + o.command,
    '',
    '· 范围：' + o.range,
    '· 可逆：' + o.reversible,
    '· 替代：' + o.alternative,
    '',
  ];
  if (o.level === RISK_LEVEL.BLOCK) {
    lines.push(
      '不要再原样重发这条命令 —— 重发只会被同一条判据再拦一次。'
      + '请先用一句话向用户说清上面三点，然后按「替代」那一行的做法去达成同样目的；'
      + '如果用户确实要求承担这个风险，请让用户自己确认，并改用范围更小的那一步。',
    );
  } else {
    lines.push(
      '用户已拒绝或尚未确认，本次**没有执行**。'
      + '请不要原样重发；按「替代」那一行的做法缩小范围后再来，或先向用户说明范围与不可逆性。',
    );
  }
  return lines.join('\n');
}

// ===========================================================================
// 七、规则表
// ===========================================================================
/**
 * ★ 规则表就是"产品对危险操作的口径"，所以它是一个**可被单测直接变异的数据结构**
 *   （`__rules` 导出就是为了这个：清空它 ⇒ 正例表必须全红；把 block 全改成 confirm
 *    ⇒ "必须拦下"那几条必须转红）。规则写成函数里的 if-else 就做不到这种自证。
 *
 * 每条规则：
 *   {
 *     category: RISK_CATEGORY.*,
 *     level: RISK_LEVEL.*,
 *     why: string,                // 这条规则在防什么（人话，便于审阅）
 *     match(view) -> null | { targets: string[] } // 命中即返回解析到的目标
 *   }
 *
 * 顺序 = 优先级（**第一个命中的说了算**）：
 *   篡改验收 > 递归权限 > 丢改动 > 删库 > 递归删除（可重建）> 递归删除（其它）
 *   —— 篡改验收放最前，因为它和"改被测代码"长得一样，必须先被识别出来。
 */
const __rules = [
  // ── 1. 篡改验收脚本/测试本身 ────────────────────────────────────────────
  {
    category: RISK_CATEGORY.TAMPER_VERIFICATION,
    level: RISK_LEVEL.BLOCK,
    why: '验收脚本是判定产品好坏的尺子：为了让它变绿而改它，等于把测量仪器的指针掰弯',
    match(view) {
      const hits = [];
      for (const c of view.commands) {
        const { head, args, flags } = normalizeArgs(c);
        // (a) 就地编辑：sed -i / perl -i / gawk -i inplace
        const inPlaceEdit = (head === 'sed' || head === 'gsed') && hasInPlaceFlag(flags);
        const perlEdit = (head === 'perl' || head === 'ruby') && flags.some((f) => /^-[A-Za-z]*i/.test(f));
        // (b) 重定向写：> / >> 到验收脚本
        const redir = [];
        for (let i = 0; i < c.tokens.length - 1; i += 1) {
          if (c.tokens[i] === '>' || c.tokens[i] === '>>') redir.push(c.tokens[i + 1]);
        }
        // (c) tee：直接写文件
        const teeTargets = head === 'tee' ? args.filter((a) => a.charAt(0) !== '-') : [];
        // (d) cp / mv / install：**目的路径**是验收脚本（读它不算篡改）
        let copyDest = [];
        if (head === 'cp' || head === 'mv' || head === 'install' || head === 'copy') {
          const rest = args.filter((a) => a.charAt(0) !== '-');
          if (rest.length >= 2) copyDest = [rest[rest.length - 1]];
        }
        // (e) 删除/截断验收脚本
        const delTargets = (head === 'rm' || head === 'del' || head === 'erase'
          || head === 'truncate' || head === 'rmdir' || head === 'rd')
          ? args.filter((a) => a.charAt(0) !== '-' && !WIN_FLAGS.has(a.toLowerCase()))
          : [];
        const cand = [].concat(
          inPlaceEdit || perlEdit ? args.filter((a) => a.charAt(0) !== '-') : [],
          redir, teeTargets, copyDest, delTargets,
        );
        for (const t of cand) {
          if (isVerificationPath(t) && !hits.includes(t)) hits.push(t);
        }
        // 就地编辑/重定向都没有落到验收路径族时，本段不算篡改（改 src/ 是正常开发）
      }
      return hits.length ? { targets: hits } : null;
    },
  },

  // ── 2. 递归放开权限 ─────────────────────────────────────────────────────
  {
    category: RISK_CATEGORY.RECURSIVE_PERMISSION,
    level: RISK_LEVEL.BLOCK,
    why: '递归 chmod 到"谁都能写"是安全问题：范围是整棵树，而且原权限位不会留底',
    match(view) {
      const hits = [];
      for (const c of view.commands) {
        const { head, flags, rest } = normalizeArgs(c);
        if (head !== 'chmod') continue;              // 只收 chmod：chown 改的是属主，不是写位
        if (!hasRecursiveFlag(flags)) continue;      // 非递归不拦（chmod 644 file 是日常操作）
        const mode = rest[0] || '';
        const targets = rest.slice(1);
        if (!isWorldWritableMode(mode)) continue;    // 没放开全局写位就不拦
        for (const t of (targets.length ? targets : ['(未写出目标)'])) {
          if (!hits.includes(t)) hits.push(t);
        }
      }
      return hits.length ? { targets: hits } : null;
    },
  },

  // ── 3. 破坏性版本操作 ───────────────────────────────────────────────────
  {
    category: RISK_CATEGORY.DESTRUCTIVE_VCS,
    level: RISK_LEVEL.BLOCK,
    why: '未提交的改动不在任何记录里，reset --hard / checkout -- / clean -f 会让它永久消失',
    match(view) {
      const hits = [];
      for (const c of view.commands) {
        if (c.head !== 'git') continue;
        const sub = String(c.args[0] || '').toLowerCase();
        const { flags, rest } = splitDashFlags(c.args.slice(1));
        const flagText = flags.join(' ');
        if (sub === 'reset' && /--hard/.test(flagText)) {
          const ref = rest.filter((x) => x !== '--')[0];
          hits.push(ref || '(当前 HEAD 指向的提交)');
        } else if (sub === 'checkout') {
          const dd = c.args.indexOf('--');
          if (dd >= 0) {
            const paths = c.args.slice(dd + 1).filter((x) => x && x.charAt(0) !== '-');
            hits.push(paths.length ? paths.join(' / ') : '(整棵工作区)');
          } else if (rest.length === 1 && rest[0] === '.') {
            hits.push('(整棵工作区)');
          }
        } else if (sub === 'clean' && flags.some((f) => /^-[A-Za-z]*f/.test(f))) {
          const paths = rest.filter((x) => x.charAt(0) !== '-');
          hits.push(paths.length ? paths.join(' / ') : '(整棵工作区里未跟踪的文件)');
        } else if (sub === 'restore' && rest.length) {
          const paths = rest.filter((x) => x.charAt(0) !== '-');
          if (paths.length) hits.push(paths.join(' / '));
        } else if (sub === 'stash' && /^(drop|clear)$/i.test(String(c.args[1] || ''))) {
          hits.push('(stash 里的改动)');
        }
      }
      return hits.length ? { targets: hits } : null;
    },
  },

  // ── 4. 破坏性数据库操作 ─────────────────────────────────────────────────
  {
    category: RISK_CATEGORY.DESTRUCTIVE_DB,
    level: RISK_LEVEL.BLOCK,
    why: 'DROP / TRUNCATE / 无 where 的 DELETE 执行完就回不来了，而"修数据问题"很少真的需要它们',
    match(view) {
      const hits = [];
      const scan = (text) => {
        const t = String(text || '');
        const found = [];
        const add = (x) => { if (x && !found.includes(x)) found.push(x); };
        let m;
        const reDrop = /\bdrop\s+(?:table|database|schema|index|view)\s+(?:if\s+exists\s+)?([`"'\[]?[A-Za-z0-9_.$-]+[`"'\]]?)/gi;
        while ((m = reDrop.exec(t))) add('表/库 ' + m[1].replace(/[`"'\]]/g, ''));
        const reTrunc = /\btruncate\s+(?:table\s+)?([`"'\[]?[A-Za-z0-9_.$-]+[`"'\]]?)/gi;
        while ((m = reTrunc.exec(t))) add('表 ' + m[1].replace(/[`"'\]]/g, ''));
        // 无 where 的 DELETE：整表删。有 where 的是正常数据操作，不拦。
        const reDel = /\bdelete\s+from\s+([`"'\[]?[A-Za-z0-9_.$-]+[`"'\]]?)([^;]*)/gi;
        while ((m = reDel.exec(t))) {
          if (!/\bwhere\b/i.test(m[2] || '')) add('表 ' + m[1].replace(/[`"'\]]/g, ''));
        }
        for (const x of found) if (!hits.includes(x)) hits.push(x);
      };
      if (view.sql) scan(view.sql);
      // 命令行里只有**数据库客户端**才扫 SQL —— 否则 `grep "drop table" docs/` 会被误杀
      const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'mongo', 'mongosh', 'redis-cli', 'clickhouse-client']);
      for (const c of view.commands) {
        if (DB_CLIENTS.has(c.head)) scan(c.text);
      }
      return hits.length ? { targets: hits } : null;
    },
  },

  // ── 5. 递归删除（可重建产物目录）⇒ confirm ─────────────────────────────
  {
    category: RISK_CATEGORY.RECURSIVE_DELETE,
    level: RISK_LEVEL.CONFIRM,
    why: '纯构建产物删掉后一条构建命令就能一模一样重建 ⇒ 可逆，只需用户点一下，不必拦死',
    match(view) {
      const hits = collectRecursiveDeletes(view);
      if (!hits.length) return null;
      return hits.every((t) => isDisposableTarget(t)) ? { targets: hits } : null;
    },
  },

  // ── 6. 递归删除（其它目标）⇒ block ─────────────────────────────────────
  {
    category: RISK_CATEGORY.RECURSIVE_DELETE,
    level: RISK_LEVEL.BLOCK,
    why: '递归强删的范围由路径决定，而路径里往往有本地补丁/离线文件 —— 删了就没有第二份',
    match(view) {
      const hits = collectRecursiveDeletes(view);
      return hits.length ? { targets: hits } : null;
    },
  },
];

/**
 * 从已展开的命令里收集「递归删除」的目标。
 * 覆盖三族写法（Windows / PowerShell / Unix），因为它们在生产里真的都会出现：
 *   · Unix：`rm -rf <t>` / `rm -r -f <t>`
 *   · cmd ：`del /s /q <t>` / `rd /s /q <t>` / `rmdir /s /q <t>`
 *   · PS  ：`Remove-Item -Recurse -Force <t>` / `ri -Recurse <t>`
 *
 * @param {{commands:Array}} view
 * @returns {string[]} 解析到的目标（去重、保序）
 */
function collectRecursiveDeletes(view) {
  const hits = [];
  const push = (t) => {
    const s = String(t == null ? '' : t).replace(/^["']|["']$/g, '');
    if (s && !hits.includes(s)) hits.push(s);
  };
  for (const c of view.commands) {
    const { head, flags, rest } = normalizeArgs(c);
    // Unix / PowerShell
    const unixLike = head === 'rm' || head === 'remove-item' || head === 'ri' || head === 'del' || head === 'erase';
    const psRec = flags.some((f) => /^-recurse$/i.test(f));
    if (unixLike && (hasRecursiveFlag(flags) || psRec)) {
      const targets = rest.filter((x) => x !== '--');
      if (targets.length) targets.forEach(push);
      else push('(命令里没有写出具体目标)');
      continue;
    }
    // cmd 风格：del /s /q、rd /s /q、rmdir /s /q
    if (head === 'del' || head === 'erase' || head === 'rd' || head === 'rmdir') {
      const win = splitWinFlags(c.args);
      const slashFlags = c.args.filter((a) => WIN_FLAGS.has(String(a).toLowerCase()));
      if (slashFlags.length) {
        const targets = win.rest.filter((x) => !WIN_FLAGS.has(String(x).toLowerCase()));
        if (targets.length) targets.forEach(push);
        else push('(命令里没有写出具体目标)');
      }
    }
  }
  return hits;
}

/**
 * 把一条展开后的简单命令拆成 `{head, flags, rest}`（统一 `-x` 与 `/x` 的取法）。
 * @param {{head:string,args:string[]}} c
 * @returns {{head:string, flags:string[], rest:string[], args:string[]}}
 */
function normalizeArgs(c) {
  const dash = splitDashFlags(c.args || []);
  const win = splitWinFlags(c.args || []);
  const psRec = (c.args || []).filter((a) => /^-recurse$/i.test(a));
  const flags = dash.flags.concat(psRec);
  const rest = dash.rest.filter((x) => !WIN_FLAGS.has(String(x).toLowerCase()));
  return { head: c.head, flags, rest, args: c.args || [], winFlags: win.flags };
}

// ===========================================================================
// 八、对外主函数
// ===========================================================================

/**
 * 判定一次技能调用是不是「危险操作」。
 *
 * @param {{name?:string, params?:object}} input 技能名与参数（与 runSkill 收到的同一份）
 * @returns {{
 *   risky: boolean,
 *   level: ('block'|'confirm'|null),
 *   category: (string|null),
 *   categoryLabel: string,
 *   targets: string[],
 *   range: string, reversible: string, alternative: string,
 *   command: string,
 *   message: string
 * }} 判定结果（**纯函数**：同输入同输出，不读文件/时间/环境）
 */
function classifyRisk(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const name = String(src.name || '');
  const params = src.params;
  const command = commandTextOf(params);
  const sql = sqlTextOf(params);

  const empty = {
    risky: false, level: null, category: null, categoryLabel: '',
    targets: [], range: '', reversible: '', alternative: '',
    command: command || sql, message: '',
  };
  if (!command && !sql) return empty;

  const view = { name, command, sql, commands: collectCommands(command, 0) };
  for (const rule of __rules) {
    let hit = null;
    try {
      hit = rule.match(view);
    } catch {
      // 判据自己出错时**不许把调用放过去**，也不许抛（抛了会打断整轮执行）。
      // 保守方向：当作命中，交给人看。这条只在规则写错时才会走到。
      hit = { targets: ['(判据异常，无法解析目标)'] };
    }
    if (!hit || !hit.targets || !hit.targets.length) continue;
    const targets = hit.targets.slice(0, 6);
    const t = targets.join(' / ');
    const copy = (COPY[rule.category] || (() => ({ range: t, reversible: '不可逆', alternative: '改用范围更小的做法' })))(t);
    return {
      risky: true,
      level: rule.level,
      category: rule.category,
      categoryLabel: CATEGORY_LABEL[rule.category] || rule.category,
      targets,
      range: copy.range,
      reversible: copy.reversible,
      alternative: copy.alternative,
      command: command || sql,
      message: buildMessage({
        name: name || 'shell-exec',
        command: command || sql,
        category: rule.category,
        level: rule.level,
        range: copy.range,
        reversible: copy.reversible,
        alternative: copy.alternative,
      }),
    };
  }
  return empty;
}

module.exports = {
  classifyRisk,
  RISK_CATEGORY,
  RISK_LEVEL,
  isGateEnabled,
  // 以下三个只为单测/审计而导出（产品代码不该依赖它们）
  __rules,
  isWorldWritableMode,
  isVerificationPath,
  isDisposableTarget,

  // ═══════════════════════════════════════════════════════════════════════
  // 命令解析纯函数：**导出给 skills/shell-exec 复用，产品代码可以依赖**
  // ═══════════════════════════════════════════════════════════════════════
  // ★ 为什么要把它们导出，而不是让技能自己再写一份（2026-11 改造的根因）：
  //   `skills/shell-exec/run.js` 原先是拿一条**整串子串匹配**的黑名单
  //   （`cmd.toLowerCase().includes('format')`）当系统级危险操作判据。子串匹配对
  //   「命令」这件事从一开始就是错的维度 —— 它分不清「命令头叫 format」和
  //   「参数里/输出里出现了 format 这几个字母」，于是：
  //     · `powershell -Command "Get-Process | Format-List Name,Id"` ⇒ 命中 `format` ⇒ 被拦
  //     · `app-setup.exe /S /norestart`（NSIS 静默安装的标配参数）⇒ 命中 `restart` ⇒ 被拦
  //     · `msiexec /i a.msi /qn /norestart`（MSI 静默安装的标配参数）⇒ 同上
  //   用户让豆芽「装一个已经下载好的安装包」，四条路线（静默装 / cmd start / Start-Process /
  //   查是否已装）全被同一句话挡回，用户据此得出「豆芽没有这个功能」的错误结论。
  //   ⇒ 判定必须换维度：**按解析出的命令头 + 参数 + 目标**判，而不是在整串里找字母。
  //   而这套解析本文件已经有了、且被 `unit-risk-gate.mjs` 133 条断言盯着（切段 / 剥包装 /
  //   归一化命令名 / 拆开关）。技能那边只要 require 这一次，就**天然与门控同口径**；
  //   另写一份的结果一定是两份切词逻辑，日后必然漂移（本仓纪律：同一件事只能有一处真源）。
  //
  // ⚠️ 纪律不变：`classifyRisk` 仍然是**纯函数、零 fs、不读环境**。下面导出的也全是纯字符串
  //   函数（不读文件、不看时间、不读环境变量）—— 只是把已有的内部函数暴露出去，不改语义。
  collectCommands,
  normalizeHead,
  splitSegments,
  splitTokens,
  stripWrappers,
  splitDashFlags,
  splitWinFlags,
  hasRecursiveFlag,
  hasForceFlag,
};
