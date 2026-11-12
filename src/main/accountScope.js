/**
 * 账号维度的产物隔离（生图 / 生视频 / 海报）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 要解决的问题（老板原话）
 * ════════════════════════════════════════════════════════════════════════════
 *   「生图 生视频 要隔离 不要别的账号生的 豆芽另一个账号也能看到」
 *
 * 修复前：产物目录是 `<workspace>/视频设计` —— **没有账号这一维**。
 *   同一台机器换账号登录，这个目录和里面的 `.index.json` 完全不变
 *   ⇒ 作品库（`wanx:assets`）、缩略图（`_refs`）、海报（`posters/`）、
 *     甚至 `app://` 的媒体授权根，全都照着同一个目录走
 *   ⇒ A 账号生成的图和视频，B 账号登录后**原样看得见、点得开**。
 *
 * 修法：产物目录改成 `<workspace>/视频设计/accounts/<账号段>`。
 *   本模块只负责回答四件事，**不碰 electron、不碰 IPC、不碰业务**：
 *     ① 账号 → 目录段（`accountSegment`，纯函数、可单独变异）；
 *     ② 账号 → 产物目录（`mediaDirFor`）/ 修复前的共享目录（`legacyMediaDir`）；
 *     ③ 「当前是哪个账号」的落盘读写（`readAccount` / `writeAccount` / `clearAccount`）；
 *     ④ 升级路径：把修复前遗留的共享产物搬进**待认领桶** `_unclaimed`，
 *        **不分配给任何账号**（`quarantineLegacy`）—— 见下面「★ 归属策略」。
 *
 * ★ 为什么不 require electron：本仓 140+ 条单测直接 `require` 主进程模块来跑
 *   （见 posterStore.js 头注同一条理由）。顶层引 electron 会让这批单测只能进 Electron 进程
 *   ⇒ 等于没有测试。所以这里只 require `path` / `fs` / `crypto`，
 *   连 dataDir 都由调用方传进来（主进程传 `app.getPath('userData')`）。
 *
 * ★★ 为什么**不复用** `memoryStore.safeOwnerSegment()`
 *   实测（本次修复的取证）：`safeOwnerSegment('潘一琪') === 'owner'`、
 *   `safeOwnerSegment('李四') === 'owner'` —— 它的规则是「非 `[A-Za-z0-9._@-]` 一律换成 `_`」，
 *   再把**纯下划线**结果归一成字面量 `'owner'`。于是**所有中文名账号塌进同一个桶**。
 *   拿它做产物隔离，等于「隔离了个寂寞」：中文名用户之间照样互相可见。
 *   ⇒ 本模块的目录段**必须带哈希**（见 `accountSegment`），前缀只负责可读性，不承担判别力。
 *   ⚠️ 本轮**不动** memoryStore（那是另一处同类缺陷，改动面完全不同），
 *      但**也不许**把它的规则搬过来用。
 *
 * ★ 目录段的三条硬要求（`accountSegment` 的实现就是为这三条写的）
 *   ① **可判别**：不同账号必须给不同段（含 `'潘一琪'` vs `'李四'`、`'潘一琪'` vs `'潘一琪2'`）；
 *   ② **不含路径分隔符**：段名会被拼进真实路径 ⇒ 绝不能出现 `/`、`\`，否则等于把目录穿越
 *      的能力交给"用户名"这个外部输入；
 *   ③ **不会穿越**：`'..'` 这类输入不能产生 `..` 段 —— 尾部恒带 `-<hash8>`，
 *      且前缀里开头的连续 `[._-]` 会被剥掉，所以不可能只剩点号。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 归属策略：旧共享目录**不分配给任何账号**（老板 2026-11-06 裁决）
 * ════════════════════════════════════════════════════════════════════════════
 * 判据原话（两条，都是否定式，别改写成肯定式）：
 *   「旧共享目录不能被静默分配给第一个登录的账号。」
 *   「旧数据无法可靠判断归属时，应保留为待认领的历史数据，而不是猜测归属。」
 *
 * 为什么「谁先登录就归谁」是错的（上一版就是那么写的，已被否掉）：
 *   · 它把**一次时序事件**（谁先启动应用）当成**归属证据**。共享目录里的文件
 *     本来就可能混着同一台机器上多个账号的产物 —— 搬给第一个登录的人，
 *     等于替用户做了一次他无法复核、也无法撤销的归属裁决。
 *   · 更糟的是它的不可逆性：文件一旦进了某个账号目录，而 `app://` 媒体授权根
 *     只放行**当前账号**目录 ⇒ 别的账号从那一刻起**连看到的机会都没有**了，
 *     连"这堆东西是谁的"这个疑问都不会出现在界面上。静默 + 不可逆 = 不该做。
 *   · 而"作品看不见"完全可以用**不猜归属**的方式解决（见下），
 *     所以这里不存在"要么猜、要么丢数据"的两难 —— 那是伪二选一。
 *
 * 本版做法（`quarantineLegacy`）：
 *   · 目标恒为 `<视频设计>/accounts/_unclaimed`，**不接受 username 参数**
 *     ——函数签名里没有它，调用方就没法"传个账号进来顺便领走"；
 *   · 只搬**目录层级**，不动文件内容；`.index.json` 里的 `localPath` 同步改前缀
 *     （`repairIndexPaths`），否则索引里每条都会 `missing:true`，
 *     "文件和索引的对应关系仍然完好"就成了一句空话；
 *   · 写 `<accounts>/.legacy-quarantined.json` 记录 `{ts, from, to, moved}` ——
 *     **没有** `by` / `account` 字段：这份标记只说明"什么时候把什么搬到了哪里"，
 *     不声明归属；
 *   · 幂等：标记存在即 `already-quarantined`；有失败项就不写标记，下次启动重试
 *     （已搬走的条目下次自然不在源目录下，所以重试是安全的）。
 *
 * ⚠️ 上一版（本分支开发期短暂存在、从未发布）用的是
 *   `.legacy-claimed.json` + 「谁先登录归谁」。本版**不再读**那个标记：
 *   跑过那一版的开发机上，存量已经在某个账号目录里了，`quarantineLegacy`
 *   只会把**剩下的**残留隔离出来，**不会**反向搬回 —— 数据不二次移动。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 产物根下的一级目录名（修复前是唯一的产物目录，现在只是父级）。 */
const MEDIA_ROOT_SEG = '视频设计';
/** 一级目录下装各账号目录的子目录名（隔离时**必须**跳过它，否则会自己搬自己）。 */
const ACCOUNTS_SUBDIR = 'accounts';
/** 待认领桶的段名：旧共享产物搬到这里，**不属于任何账号**。 */
const UNCLAIMED_SEGMENT = '_unclaimed';
/** 隔离动作的幂等标记（放在 accounts/ 下：它描述的是"这批历史数据的来历"）。 */
const LEGACY_QUARANTINE_MARK = '.legacy-quarantined.json';
/** 产物索引文件名（与 wanxProvider 的 INDEX_FILENAME 同值；那里没导出，门禁会逐字比对）。 */
const INDEX_FILENAME = '.index.json';
/** 「当前账号」的落盘文件名（放在 dataDir 下，与 auth-token.json 同级）。 */
const ACCOUNT_FILE = 'current-account.json';
/** 没有账号时的固定段名（未登录 / 账号信息缺失）。 */
const ANON_SEGMENT = 'anon';
/** 前缀最长多少字符（目录名总长可控，且留足 `-hash8` 的位置）。 */
const PREFIX_MAX = 24;
/** 哈希取前 8 位十六进制（32 bit，撞车概率对"同一台机器的账号数"绰绰有余）。 */
const HASH_LEN = 8;

/**
 * 计算短哈希（十六进制）。用 sha1 而不是自造的乘加哈希：
 * 本仓已有 `copyIntoRefs` 那种 `h = h*31+charCode` 的实现，它的碰撞特性没人验过；
 * 目录段的判别力是本次修复的**核心判据**，不该建立在"看起来够了"的自造算法上。
 *
 * @param {string} raw 原始输入
 * @returns {string} 十六进制摘要
 */
function sha1Hex(raw) {
  return crypto.createHash('sha1').update(String(raw), 'utf8').digest('hex');
}

/**
 * 账号 → 目录段。**纯函数**（同样的输入永远同样的输出，不读磁盘、不看环境）。
 *
 * 形状：`<可读 ASCII 前缀>-<sha1(raw) 前 8 位>`
 *   · 空 / 全空白 ⇒ 固定 `'anon'`（未登录时的桶，不与任何具名账号共用）；
 *   · 前缀只负责"人一眼能认出来"，**判别力全部来自哈希** —— 这是与
 *     `safeOwnerSegment` 塌桶缺陷的分界线：'潘一琪' 与 '李四' 的前缀都会退化成 'u'，
 *     但尾部哈希不同 ⇒ 段不同。
 *   · 输出恒有 `-<hash8>` 结尾 ⇒ 永远不会与 `anon` / `_unclaimed` 这两个固定桶同名
 *     （它们既没有连字符也没有哈希尾巴）。
 *
 * @param {string} username 账号名（任意 Unicode，允许空）
 * @returns {string} 可直接作为单级目录名的段（不含 `/`、`\`，不会是 `.` / `..`）
 */
function accountSegment(username) {
  const raw = username == null ? '' : String(username);
  if (!raw.trim()) return ANON_SEGMENT; // 全空白也算"没有账号"
  const hash = sha1Hex(raw).slice(0, HASH_LEN);
  // 非 `[A-Za-z0-9._-]` 的连续片段压成单个 '-'；中文会整段变成 '---'，随后被剥空。
  let prefix = raw.replace(/[^A-Za-z0-9._-]+/g, '-');
  prefix = prefix.replace(/^-+|-+$/g, ''); // 去首尾连字符（中间的 '-' 是合法可读分隔符）
  prefix = prefix.toLowerCase().slice(0, PREFIX_MAX);
  prefix = prefix.replace(/^[._-]+/, ''); // ★ 剥掉开头的点/下划线：这是"不会穿越"的关键一步
  if (!prefix || /^[._-]+$/.test(prefix)) prefix = 'u';
  return prefix + '-' + hash;
}

/**
 * 账号的产物目录：`<workspaceRoot>/视频设计/accounts/<段>`。
 *
 * @param {string} workspaceRoot 工作区根（主进程传 `AGENT_WORKSPACE` 或 `~/douya-claw-workspace`）
 * @param {string} username 账号名（空 ⇒ anon 桶）
 * @returns {string} 绝对路径（workspaceRoot 为空时是相对路径，由调用方保证非空）
 */
function mediaDirFor(workspaceRoot, username) {
  return path.join(String(workspaceRoot || ''), MEDIA_ROOT_SEG, ACCOUNTS_SUBDIR, accountSegment(username));
}

/**
 * 修复前的**共享**产物目录：`<workspaceRoot>/视频设计`。
 * 只用于两件事：① 升级时把里面的存量隔离到待认领桶；② 门禁断言"账号目录 ≠ 共享目录"。
 *
 * @param {string} workspaceRoot 工作区根
 * @returns {string} 绝对路径
 */
function legacyMediaDir(workspaceRoot) {
  return path.join(String(workspaceRoot || ''), MEDIA_ROOT_SEG);
}

/**
 * 待认领桶的绝对路径：`<workspaceRoot>/视频设计/accounts/<_unclaimed>`。
 *
 * 这是**唯一**允许接收旧共享产物的地方，而且它不属于任何账号：
 *   · 它不在 `mediaDirFor` 的值域里（那边恒有 `-<hash8>` 尾巴，见 `accountSegment`）；
 *   · 它不在 `app://` 的媒体授权根里（授权根只有"当前账号目录"一个）
 *     ⇒ 任何账号都不会在正常作品库里看到这批历史数据；
 *   · 它就在 `accounts/` 旁边 ⇒ 用户/支持人员在文件管理器里一眼能找到，
 *     需要人工认领时可以整体搬进某个账号目录 —— 但那必须是**人**的动作，不是代码的猜测。
 *
 * @param {string} workspaceRoot 工作区根
 * @returns {string} 绝对路径
 */
function unclaimedMediaDir(workspaceRoot) {
  return path.join(String(workspaceRoot || ''), MEDIA_ROOT_SEG, ACCOUNTS_SUBDIR, UNCLAIMED_SEGMENT);
}

/**
 * 「当前账号」的落盘路径：`<dataDir>/current-account.json`。
 * 与 `auth-token.json` 同级 —— 主进程两处（backend.js 记账 / main.js 读取）用**同一个** dataDir。
 *
 * @param {string} dataDir 数据目录（主进程 = `app.getPath('userData')`）
 * @returns {string} 绝对路径
 */
function accountFilePath(dataDir) {
  return path.join(String(dataDir || ''), ACCOUNT_FILE);
}

/**
 * 读「当前账号」。**任何异常都返回 null**，绝不抛：
 * 调用点在 `wanxMediaDir()` 里，那里一抛就是整条产物链（保存 / 列表 / 缩略图）一起坏。
 *
 * @param {string} dataDir 数据目录
 * @returns {{id:string|number, username:string, ts:number}|null}
 *   文件不存在 / 不可解析 / 结构不对 / username 为空 ⇒ null
 */
function readAccount(dataDir) {
  try {
    const p = accountFilePath(dataDir);
    if (!p || !fs.existsSync(p)) return null;
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object') return null;
    const username = String(obj.username == null ? '' : obj.username);
    if (!username.trim()) return null; // 没有用户名 = 没有账号归属，按未登录处理
    return {
      id: (obj.id === 0 || obj.id) ? obj.id : '',
      username,
      ts: Number(obj.ts) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * 写「当前账号」：原子写（先写 tmp 再 rename）。
 *
 * 为什么必须原子：这个文件在**每次启动 / 每次登录 / 每次 profile 校验**时被读，
 * 而写发生在登录回调里。非原子写一旦在中间被杀（用户关窗口 / 断电），
 * 留下一个半截 JSON ⇒ `readAccount` 返回 null ⇒ 产物目录退回 `anon` 桶
 * ⇒ 用户会看到"我的作品全没了"（而文件其实一个没少）。原子写让这种状态不可能存在。
 *
 * @param {string} dataDir 数据目录
 * @param {{id?:string|number, username?:string}} user 账号信息（通常来自上游 `json.user`）
 * @returns {boolean} 是否真的写下去了（username 为空 ⇒ 返回 false 且**不覆盖**原文件）
 */
function writeAccount(dataDir, user) {
  try {
    const u = user && typeof user === 'object' ? user : {};
    const username = String(u.username == null ? '' : u.username);
    if (!username.trim()) return false; // ★ 别把已有的正确账号信息擦成空
    const rec = {
      id: (u.id === 0 || u.id) ? u.id : '',
      username,
      ts: Date.now(),
    };
    const p = accountFilePath(dataDir);
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
    fs.renameSync(tmp, p); // 同目录 rename 是原子的（Windows 上跨盘才不是，这里不会跨盘）
    return true;
  } catch {
    return false;
  }
}

/**
 * 清掉「当前账号」（登出时调）。异常一律吞掉：登出失败不该由记账文件决定。
 *
 * @param {string} dataDir 数据目录
 * @returns {void}
 */
function clearAccount(dataDir) {
  try {
    const p = accountFilePath(dataDir);
    if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch { /* 删不掉就当没这回事：readAccount 会读到旧值，最坏是多看一个账号的作品 */ }
}

/**
 * 把一个条目从 `src` 搬到 `dst`。**逐项独立**，不从里面抛。
 *
 * 先 rename（同盘最快、原子）；失败（跨盘 / 目标已存在 / 权限）再 cp + 尽力 rm。
 * `force:false` + `errorOnExist:false` + 事先 `existsSync(dst)` 三重保证**不覆盖**已有文件。
 *
 * @param {string} src 源
 * @param {string} dst 目标
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function moveEntry(src, dst) {
  try {
    if (fs.existsSync(dst)) return { ok: false, error: 'exists' }; // ★ 不覆盖：目标已有同名
    try {
      fs.renameSync(src, dst);
      return { ok: true };
    } catch { /* 落到下面的复制路径 */ }
    try {
      fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
    } catch (e) {
      return { ok: false, error: 'cp:' + ((e && e.message) || e) };
    }
    // 复制成功才算"搬过"；删原件的失败**不计入** failed（原件还在 ≠ 数据丢失，
    // 且下次启动会因为"目标已存在"而不再重复搬）。这里只尽力。
    try { fs.rmSync(src, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 把一个目录里的产物索引 `items[].localPath` 从 `fromDir` 前缀改写成 `toDir` 前缀。
 *
 * 为什么非它不可：索引里存的是**绝对路径**（`wanxProvider.appendAsset` 写 `localPath` 原样值）。
 * 文件整体搬了目录之后，索引里每条路径都指向一个不存在的旧位置
 * ⇒ `listAssets` 把**每一条**都标成 `missing:true`
 * ⇒ 用户看到的是"一堆裂图 + 打不开的历史作品"，
 *    而"文件内容和索引关系仍然完好"这句话就变成了自欺（索引确实搬过来了，但它已经全废了）。
 *
 * 三条实现约束：
 *   ① **只做字符串前缀替换**，不做 `path.resolve` 归一 —— 存量路径可能来自另一台机器 /
 *      另一个 `AGENT_WORKSPACE`，归一化会把它改写成这台机器上"看起来合理"但其实不对的路径；
 *   ② 前缀必须按**分隔符边界**匹配（`from + sep`）：否则 `/ws/视频设计2/a.png`
 *      会被 `/ws/视频设计` 前缀命中，改出一个不存在的路径；
 *   ③ 解析失败 ⇒ `{ok:false, reason:'parse'}` 且**一个字节都不写**：
 *      索引本身有人工价值（`listAssets` 对坏索引的处置是"保留原文件、按空列表处理"），
 *      迁移路径更不该是唯一一个把坏索引覆盖掉的地方。
 *
 * 原子写：先写 tmp 再 rename（与 `writeAccount` 同一理由 —— 迁移中被打断不该留下半截索引）。
 *
 * @param {string} indexFile 索引文件绝对路径（`<dir>/.index.json`）
 * @param {string} fromDir 旧目录（绝对路径）
 * @param {string} toDir 新目录（绝对路径）
 * @returns {{ok:boolean, reason?:string, changed:number, total:number}}
 *   reason ∈ `args`（参数空）/ `read`（读不到）/ `parse`（不是合法 JSON 或缺 items）/ `write`（写不下去）
 */
function repairIndexPaths(indexFile, fromDir, toDir) {
  const file = String(indexFile || '');
  const from = String(fromDir || '');
  const to = String(toDir || '');
  if (!file || !from || !to) return { ok: false, reason: 'args', changed: 0, total: 0 };

  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { ok: false, reason: 'read', changed: 0, total: 0 }; }

  let obj = null;
  try { obj = JSON.parse(raw); }
  catch { return { ok: false, reason: 'parse', changed: 0, total: 0 }; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) {
    return { ok: false, reason: 'parse', changed: 0, total: 0 };
  }

  const fromPrefix = from + path.sep;
  // Windows 路径大小写不敏感（盘符/目录名大小写在真实磁盘上是同一个位置）。
  // 只在**比较**时折叠大小写，改写后的字符串仍然取原路径的真实尾巴。
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const cmpFrom = fold(fromPrefix);

  let changed = 0;
  for (const it of obj.items) {
    if (!it || typeof it !== 'object') continue;
    const lp = typeof it.localPath === 'string' ? it.localPath : '';
    if (!lp) continue;
    if (!fold(lp).startsWith(cmpFrom)) continue;
    const next = path.join(to, lp.slice(fromPrefix.length));
    if (next !== lp) { it.localPath = next; changed += 1; }
  }
  if (changed === 0) return { ok: true, changed: 0, total: obj.items.length };

  try {
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    return { ok: false, reason: 'write', changed: 0, total: obj.items.length };
  }
  return { ok: true, changed, total: obj.items.length };
}

/**
 * 升级隔离：把修复前共享目录里的存量产物，**整体搬进待认领桶**（不猜归属）。
 *
 * ★ 函数签名里**没有 username** —— 这是本版归属策略最直接的落实：
 *   调用方即使想"顺手把存量给当前账号"也没有参数可传。
 *   主进程侧的调用点（`ensureLegacyQuarantine`）因此也不需要知道当前是哪个账号。
 *
 * 为什么需要它：修完隔离之后，老用户的历史作品还躺在 `<workspace>/视频设计/` 下
 * （媒体文件、`.index.json`、`_refs/`、`posters/`）。不处理的话，用户升级后
 * 看到的是"我之前的作品全没了" —— 那不是隔离，那是观感上的数据丢失。
 * 搬到 `_unclaimed` 之后：一个字节都没丢、不会被任何账号看见、也不会被任何账号"顺手认领"。
 *
 * 逐项独立：一项失败不中止其余项；**有失败就不写标记** ⇒ 下次启动重试
 * （已搬走的条目下次自然不在源目录里，所以重试天然幂等）。
 *
 * ⚠️ 绝不删 legacy 根目录本身：`视频设计/` 是 `accounts/` 的父级，
 *   删掉它连同所有账号目录一起没了。
 *
 * @param {{workspaceRoot?:string}} opts 工作区根（**不接收** username，见上）
 * @returns {{ok:boolean, reason:string, moved:string[], failed:Array<{name:string,error:string}>,
 *            from:string, to:string, index:{ok:boolean, reason?:string, changed:number, total:number}}}
 *   reason ∈ `already-quarantined` / `no-legacy` / `empty` / `done` / `partial`
 */
function quarantineLegacy(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const workspaceRoot = String(o.workspaceRoot || '');
  const moved = [];
  const failed = [];
  const root = legacyMediaDir(workspaceRoot);
  const accountsRoot = path.join(root, ACCOUNTS_SUBDIR);
  const dest = unclaimedMediaDir(workspaceRoot);
  const noIndex = { ok: false, reason: 'skipped', changed: 0, total: 0 };
  const result = (ok, reason, index) => ({
    ok, reason, moved, failed, from: root, to: dest, index: index || noIndex,
  });

  // ① 已经隔离过 ⇒ 幂等返回，**不**碰任何东西（否则第二次会把待认领桶里的东西再搬一遍）
  const mark = path.join(accountsRoot, LEGACY_QUARANTINE_MARK);
  try { if (fs.existsSync(mark)) return result(true, 'already-quarantined'); }
  catch { /* 标记读不到 ⇒ 当作没隔离过，继续往下走（宁可重试，不要漏搬） */ }

  // ② 修复前就没用过这个功能 ⇒ 没有 legacy 目录，无事可做（**不**凭空建目录）
  let names = [];
  try {
    if (!fs.existsSync(root)) return result(false, 'no-legacy');
    const st = fs.statSync(root);
    if (!st || !st.isDirectory()) return result(false, 'no-legacy');
    names = fs.readdirSync(root);
  } catch {
    return result(false, 'no-legacy'); // 列不出来 = 当没有，绝不瞎搬
  }
  // ★ 必须跳过 `accounts` 自身：它就是目标目录的父级，搬它等于自我嵌套
  const entries = names.filter((n) => n && n !== ACCOUNTS_SUBDIR);
  if (!entries.length) return result(true, 'empty');

  // ③ 逐项搬（一项失败不中止其余项）
  try { fs.mkdirSync(dest, { recursive: true }); }
  catch (e) {
    failed.push({ name: '(mkdir)', error: String((e && e.message) || e) });
    return result(false, 'partial');
  }
  for (const name of entries) {
    const r = moveEntry(path.join(root, name), path.join(dest, name));
    if (r.ok) moved.push(name);
    else failed.push({ name, error: r.error });
  }

  // ④ 索引跟着改前缀。**只修已经在待认领桶里的那一份**：
  //    若 `.index.json` 没搬过去（比如目标已有同名索引 = 冲突），那说明
  //    这一桶里已经有一份"属于它自己"的索引，去改源目录的那份没有任何好处
  //    （源目录已不在任何授权根里，没人会去读它）。
  const index = repairIndexPaths(path.join(dest, INDEX_FILENAME), root, dest);

  // ⑤ 只有**全成功**才写标记。有失败 ⇒ 不写，下次启动重试（部分成功的项下次自然不在了）
  if (failed.length === 0) {
    try {
      fs.mkdirSync(accountsRoot, { recursive: true });
      // 标记内容里**刻意不含** by / account：它只回答"什么时候把什么搬到了哪里"，
      // 不回答"这批东西归谁"。写进去就等于替用户做了归属裁决（正是本轮被否掉的那件事）。
      fs.writeFileSync(mark, JSON.stringify({
        ts: Date.now(),
        from: root,
        to: dest,
        moved: moved.slice(),
      }, null, 2), 'utf8');
    } catch { /* 标记写不下去：下次启动会重试，因为源目录下已经没有可搬的东西 ⇒ reason=empty */ }
    return result(true, 'done', index);
  }
  return result(false, 'partial', index);
}

module.exports = {
  accountSegment,
  mediaDirFor,
  legacyMediaDir,
  unclaimedMediaDir,
  accountFilePath,
  readAccount,
  writeAccount,
  clearAccount,
  quarantineLegacy,
  repairIndexPaths,
  // 常量也导出：门禁要断言"标记文件名 / 账号子目录名 / 待认领桶名"与实现一致，
  // 硬编码在门禁里就是手抄副本，改了实现门禁也不会红。
  MEDIA_ROOT_SEG,
  ACCOUNTS_SUBDIR,
  UNCLAIMED_SEGMENT,
  LEGACY_QUARANTINE_MARK,
  INDEX_FILENAME,
  ACCOUNT_FILE,
  ANON_SEGMENT,
};
