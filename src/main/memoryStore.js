'use strict';
/**
 * 豆芽记忆 2.0 · 四层档案存储（A 阶段 #243）
 * ============================================================================
 * 设计总纲（2026-10-05 拍板）：
 *   记住「你是谁」，而不只是记住「你说过什么」。
 *   记忆可以增长，但事实必须有来源；记忆可以更新，但不能无证据漂移。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么是**四个物理文件**，而不是一个 memory.json 加四个字段
 * ────────────────────────────────────────────────────────────────────────────
 * 因为四层的**生命周期完全不同**，混在一个文件里就必然出这种事：
 *   · 项目结束后 project 条目该过期，却因为和 identity 躺在同一个文件里而一起被保住
 *   · 「我是谁」这类永不过期的事实，被某次项目清理整文件重写时顺手抹掉
 *   · 想给 prefs 设 TTL、给 identity 设永久，只能靠代码里的 if 分支硬编码
 * 物理分文件 ⇒ 生命周期、上限、TTL 都能**按层各自表达**，
 * 且「谁被动了」在文件系统层面就看得见（diff/备份/回滚都变得可行）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 两条不可协商的纪律
 * ────────────────────────────────────────────────────────────────────────────
 * ① **写入必须能被审计**：每次真正的落盘都往 ledger.jsonl 追加一行。
 *    为什么：记忆是「越用越懂你」，用户迟早会问"你凭什么记得我这个"。
 *    只有档案没有流水 ⇒ 答不出来。ledger 是**证据链**，不是日志。
 *
 * ② **失败绝不向上抛**：本模块所有导出函数都保证不抛。
 *    为什么：记忆是旁路（R5）。存储层一个 EACCES 把主任务打崩，
 *    是最典型的"辅助功能杀死主功能"。所以这里每个 fs 操作都自带 catch。
 *    ⚠️ 但"不抛"不等于"假装成功"：失败会体现在返回值的 ok:false / error 上，
 *       调用方（和门禁）能看见。静默成功才是真正要防的。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 与 memorySecretGate 的边界
 * ────────────────────────────────────────────────────────────────────────────
 * 本模块**不做任何敏感判定**，也不知道 Secret 是什么。
 * 它的契约是：**只写调用方交给它的东西**。
 * 敏感拦截是 memorySecretGate 的职责，且必须在**调用本模块之前**完成。
 * ⇒ 这样即使某一层漏了判定，问题也能被定位到"判定层"，
 *   而不是"存储层居然自己放过了密码"这种跨层扯皮。
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// 1. 四层定义
// ============================================================================

/** 四层档案的层名（顺序即注入顺序：越靠前越稳定、越重要）。 */
const MEMORY_LAYER = Object.freeze({
  IDENTITY: 'identity',   // 我是谁 —— 姓名/称呼/城市/语言/时区 …（近乎永久）
  ORGS: 'orgs',           // 我在哪工作 —— 公司与角色（长期，但会变）
  PREFS: 'prefs',         // 我习惯怎么做事 —— 沟通风格/工具偏好/禁忌（长期）
  PROJECTS: 'projects',   // 我当前在做什么 —— 在办项目（短周期，最容易过期）
});

/** 层顺序（数组，供遍历）。刻意与 MEMORY_LAYER 定义顺序一致。 */
const MEMORY_LAYERS = Object.freeze([
  MEMORY_LAYER.IDENTITY,
  MEMORY_LAYER.ORGS,
  MEMORY_LAYER.PREFS,
  MEMORY_LAYER.PROJECTS,
]);

/**
 * 每层的档案文件名。刻意不用 `memory_identity.json` 这类前缀：
 * 档案目录本身就是 `memory/`，再加前缀只是噪声。
 */
const LAYER_FILE = Object.freeze({
  [MEMORY_LAYER.IDENTITY]: 'identity.json',
  [MEMORY_LAYER.ORGS]: 'orgs.json',
  [MEMORY_LAYER.PREFS]: 'prefs.json',
  [MEMORY_LAYER.PROJECTS]: 'projects.json',
});

/** 追加式变更流水的文件名（UI 时间线的唯一数据源）。 */
const LEDGER_FILE = 'ledger.jsonl';

/**
 * 每层的 TTL（天）。null = 永不过期。
 *
 * ⚠️ 关键设计：**TTL 到期是"降级"不是"删除"**。
 *    到期条目 status: active → stale，**内容仍留在文件里、仍可被审计**，
 *    只是不再注入模型。为什么不做删除：
 *    · 用户可能只是三个月没提这事，不代表它不成立（"我在做 X 项目"停了又开很正常）
 *    · 删除是不可逆的，而"暂时不注入"是可逆的
 *    · 真的想删，走 UI 的显式删除（那才是有意的），而不是靠时间悄悄蒸发
 */
const LAYER_TTL_DAYS = Object.freeze({
  [MEMORY_LAYER.IDENTITY]: null,   // 姓名/语言/时区不会自己过期
  [MEMORY_LAYER.ORGS]: 730,        // 两年：公司/角色相对稳定
  [MEMORY_LAYER.PREFS]: 365,       // 一年：习惯会变，但不会很快
  [MEMORY_LAYER.PROJECTS]: 90,     // 90 天：项目有明确周期，最容易过时
});

/**
 * 每层条目数硬上限。超出时**淘汰最不该留的**（见 evictEntries），不是简单截断。
 *
 * 为什么要有：记忆是注入进 system 消息的。不限量 ⇒
 * 聊得越久注入越长 ⇒ 迟早吃穿上下文预算，把主任务的预算挤没。
 * 记忆**绝不能**成为上下文预算的破坏者（它本来就是旁路）。
 */
const LAYER_MAX_ENTRIES = Object.freeze({
  [MEMORY_LAYER.IDENTITY]: 40,
  [MEMORY_LAYER.ORGS]: 60,
  [MEMORY_LAYER.PREFS]: 80,
  [MEMORY_LAYER.PROJECTS]: 60,
});

/** ledger 硬上限（行数）。超出时保留最近 N 行 —— 老流水仍可从备份找回。 */
const LEDGER_MAX_LINES = 2000;

/** 单条记忆 value 的最大字符数（超长截断，防一条记忆吃穿预算）。 */
const ENTRY_VALUE_MAX = 300;
/** 单条记忆 quote（出处原话）的最大字符数。 */
const ENTRY_QUOTE_MAX = 240;

// ============================================================================
// 2. 小型工具函数（本模块自足，不依赖 backend.js）
// ============================================================================

/** 单行化 + 截断（记忆内容里混入换行会破坏注入文本的结构）。 */
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * owner（登录用户）→ 档案子目录名。
 *
 * ⚠️ 为什么要做净化而不是直接用：
 *    owner 来自请求体（`payload.username`）。直接拼进路径 ⇒
 *    `username: '../../etc/x'` 就能让档案写到任意位置（路径穿越）。
 *    这里只保留安全字符，其余一律丢弃；净化后为空则整体拒绝写盘。
 */
function safeOwnerSegment(owner) {
  const raw = String(owner == null ? '' : owner).trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/[^A-Za-z0-9._@-]/g, '_')   // 只留白名单字符：分隔符、盘符、控制字符全被换成 _
    // ★★ 必须**全面消灭** ".."，不能只处理开头（2026-10-05 门禁 S2h 抓到）。
    //   首版只做了 `.replace(/^\.+/, '_')` ⇒ `'../../etc/passwd'` 净化成 `'__.._.._etc_passwd'`，
    //   **中间仍留着 ".."**。今天它无害（因为 `path.join` 只在分隔符边界识别 ".."，
    //   而这个字符串里已经没有分隔符），但这是**靠巧合安全**，不是靠设计安全：
    //   · 一旦有人把 owner 段改成手工拼接、或某平台对 ".." 有特殊解释，它立刻变成穿越
    //   · 另一个真实风险是**目录名碰撞**：'a/../b' 与 'a_.._b' 会落到同一段
    //   ⇒ 净化器的契约是"输出可安全用作单个路径段"，就该比"刚好够用"更严格。
    //   这里把任意位置的连续点（2 个及以上）整体替换掉，只保留单个点（用于 'a.b' 这类账号名）。
    .replace(/\.{2,}/g, '_')
    .replace(/^_+/, '_');
  // 兜底：净化后可能只剩点号或下划线（如 owner 全是非法字符），统一成固定串
  return cleaned === '' || /^[_]+$/.test(cleaned) ? 'owner' : cleaned;
}

/** 把毫秒时间戳渲染成 ledger 用的 ISO 串（便于人肉审计与时间线排序）。 */
function isoOf(ts) {
  try {
    return new Date(Number(ts) || Date.now()).toISOString();
  } catch {
    return '';
  }
}

/** 天数 → 毫秒。null/非法 ⇒ null（永不过期）。 */
function daysToMs(days) {
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 24 * 60 * 60 * 1000) : null;
}

// ============================================================================
// 3. 路径解析（根目录约定与 backend.js 一致）
// ============================================================================

/**
 * 解析档案根目录。
 *
 * 与 `backend.js:4301` 的 dataDir 约定**刻意保持一致**：
 *     dataDir = options.dataDir || os.homedir() + '/.douya-claw'
 * 并在其下二级目录 `memory/`。
 *
 * 为什么子目录而不是平铺：用户后来会打开 `~/.douya-claw` 看里面有什么。
 * 平铺会看到 identity.json / orgs.json / ledger.jsonl / tasks.json / config.json … 混在一起，
 * 而记忆四层 + 流水明显是**一组**东西 ⇒ 给它们一个自己的抽屉。
 *
 * @param {{dataDir?:string, root?:string}} [opts] root 直接指定档案根（优先，供单测）
 * @returns {string} 绝对路径
 */
function resolveMemoryRoot(opts) {
  const o = opts || {};
  if (o.root) return path.resolve(String(o.root));
  const base = o.dataDir
    ? String(o.dataDir)
    : path.join(require('os').homedir(), '.douya-claw');
  return path.join(base, 'memory');
}

/**
 * 解析某个 owner 的档案目录（owner 为空 ⇒ 返回 ''，表示"不可用"）。
 *
 * ⚠️ owner 为空必须返回空串而不是回落到"公共档案"：
 *    没有登录身份的请求如果能写公共档案，就等于**任何未登录调用方都能污染所有人的记忆**
 *    （下轮注入进的是真实用户的对话）。宁可这次不记，也不能记错人。
 */
function resolveOwnerDir(owner, opts) {
  const seg = safeOwnerSegment(owner);
  if (!seg) return '';
  return path.join(resolveMemoryRoot(opts), seg);
}

// ============================================================================
// 4. 原子写
// ============================================================================

/**
 * 原子写文本文件：先写 `xxx.tmp`，再 rename 覆盖目标。
 *
 * 为什么不能直接 writeFileSync 到目标：
 *   写到一半进程被杀 / 磁盘满 ⇒ 目标文件变成**半截 JSON** ⇒
 *   下次读取解析失败 ⇒ 按本模块的降级策略会当"空档案" ⇒ **用户的记忆整体丢失**（静默）。
 *   rename 在同一文件系统内是原子的：要么是旧内容，要么是新内容，不存在半截状态。
 *
 * ⚠️ tmp 文件名带 pid：同一 owner 在两个进程里并发写时，不会互相踩对方的临时文件。
 *   （真正的并发安全仍不保证 —— 那是调用方的串行责任，这里只保证"不会写坏"。）
 *
 * @returns {{ok:boolean, error?:string}}
 */
function atomicWrite(file, text) {
  const tmp = file + '.tmp' + process.pid;
  try {
    fs.writeFileSync(tmp, text);
  } catch (e) {
    // 写 tmp 就失败了：目标文件**完全没动**，这是最安全的失败
    try { fs.unlinkSync(tmp); } catch { /* 清不掉也不影响正确性 */ }
    return { ok: false, error: 'write_tmp_failed: ' + (e && e.message ? e.message : 'unknown') };
  }
  try {
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: 'rename_failed: ' + (e && e.message ? e.message : 'unknown') };
  }
}

// ============================================================================
// 5. 读
// ============================================================================

/** 读一个 JSON 文件；缺失/损坏/为空一律返回 fallback（绝不抛）。 */
function readJsonSafe(file, fallback) {
  try {
    if (!file || !fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    const j = JSON.parse(raw);
    return j == null ? fallback : j;
  } catch {
    // 损坏文件不删除、不覆盖，只是当空读到 —— 用户的原始字节仍在磁盘上，可人工抢救
    return fallback;
  }
}

/**
 * 读一整层档案。
 * @returns {{ok:boolean, layer:string, entries:Array, error?:string}}
 *          —— 文件不存在时 ok:true + entries:[] （"还没记过"不是错误）
 */
function readLayer(owner, layer, opts) {
  const dir = resolveOwnerDir(owner, opts);
  if (!dir) return { ok: false, layer, entries: [], error: 'owner_required' };
  if (!MEMORY_LAYERS.includes(layer)) {
    return { ok: false, layer, entries: [], error: 'unknown_layer:' + layer };
  }
  const file = path.join(dir, LAYER_FILE[layer]);
  const doc = readJsonSafe(file, null);
  if (doc == null) return { ok: true, layer, entries: [] };
  const entries = Array.isArray(doc) ? doc : (Array.isArray(doc.entries) ? doc.entries : []);
  return { ok: true, layer, entries: entries.filter((e) => e && typeof e === 'object' && e.key) };
}

/**
 * 读某个 owner 的全部四层（供注入层组装摘要）。
 * @returns {{ok:boolean, owner:string, layers:Object, total:number, errors:string[]}}
 */
function readAllLayers(owner, opts) {
  const out = { ok: true, owner: String(owner == null ? '' : owner), layers: {}, total: 0, errors: [] };
  const dir = resolveOwnerDir(owner, opts);
  if (!dir) {
    return { ok: false, owner: out.owner, layers: {}, total: 0, errors: ['owner_required'] };
  }
  for (const layer of MEMORY_LAYERS) {
    const r = readLayer(owner, layer, opts);
    if (!r.ok) out.errors.push(layer + ':' + (r.error || 'unknown'));
    out.layers[layer] = r.entries;
    out.total += r.entries.length;
  }
  return out;
}

// ============================================================================
// 6. 条目标量化与淘汰
// ============================================================================

/**
 * 规范化一条记忆条目（补齐字段 + 长度裁剪）。
 *
 * 字段表（设计稿 §4）：
 *   key            稳定标识（如 'user.name' / 'org.current' / 'pref.report_style'）
 *   value          值（字符串或简单结构，落盘前 JSON 化）
 *   source         来源：explicit_user / system / conversation / imported / inferred
 *   confidence     置信度 0~1
 *   firstSeen      首次出现时间戳（**只增不改**）
 *   lastSeen       最近一次出现时间戳
 *   confirmedCount 被确认次数（**只增不减** —— G2 守卫）
 *   status         active / stale / superseded / archived / pending_conflict
 *   supersedes     本条替代了哪条（key），形成可回溯链
 *   evidence       证据数组，每项至少含 quote（出处原话）—— G3 守卫
 */
function normalizeEntry(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const now = Date.now();
  const src = String(e.source || '');
  return {
    key: clip(e.key, 120),
    value: typeof e.value === 'string' ? clip(e.value, ENTRY_VALUE_MAX) : e.value,
    source: src,
    confidence: Number.isFinite(Number(e.confidence)) ? Math.max(0, Math.min(1, Number(e.confidence))) : 0,
    firstSeen: Number(e.firstSeen) || now,
    lastSeen: Number(e.lastSeen) || now,
    // ★ 只增不减：这里用 max 而不是直接赋值 —— 任何调用方都无法把计数改小
    confirmedCount: Math.max(0, Math.floor(Number(e.confirmedCount) || 0)),
    status: String(e.status || 'active'),
    supersedes: String(e.supersedes || ''),
    evidence: (Array.isArray(e.evidence) ? e.evidence : []).slice(0, 8).map((v) => ({
      quote: clip(v && v.quote, ENTRY_QUOTE_MAX),
      at: Number(v && v.at) || now,
      source: String((v && v.source) || src || ''),
    })),
  };
}

/**
 * 给条目排序，决定淘汰谁（保留前 max 个）。
 *
 * 排序键（优先级从高到低）：
 *   ① 非 active 的排最后（stale/superseded/archived 是"已降级"，不该挤掉活的）
 *   ② confirmedCount 大的优先（被反复确认的才是真记忆）
 *   ③ confidence 高的优先
 *   ④ lastSeen 新的优先
 *
 * ⚠️ 为什么不是简单 `slice(0, max)`：
 *    条目是按插入顺序追加的，直接截断等于"老的永远留着、新的永远进不来"，
 *    记忆就停止生长了 —— 而"越用越懂你"的前提正是**新的能进来**。
 */
function evictEntries(entries, max) {
  const n = Math.max(1, Math.floor(Number(max) || 1));
  if (!Array.isArray(entries)) return [];
  if (entries.length <= n) return entries.slice();
  const rank = (e) => (e && e.status === 'active' ? 0 : 1);
  const sorted = entries.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ca = Number(a && a.confirmedCount) || 0;
    const cb = Number(b && b.confirmedCount) || 0;
    if (ca !== cb) return cb - ca;
    const fa = Number(a && a.confidence) || 0;
    const fb = Number(b && b.confidence) || 0;
    if (fa !== fb) return fb - fa;
    return (Number(b && b.lastSeen) || 0) - (Number(a && a.lastSeen) || 0);
  });
  return sorted.slice(0, n);
}

/**
 * 按 TTL 把过期条目**降级**（active → stale）。**不删除**。
 *
 * @returns {{entries:Array, staled:string[]}}
 */
function applyTtl(entries, layer, now) {
  const ttlMs = daysToMs(LAYER_TTL_DAYS[layer]);
  if (!ttlMs) return { entries: Array.isArray(entries) ? entries : [], staled: [] };
  const t = Number(now) || Date.now();
  const staled = [];
  const out = (Array.isArray(entries) ? entries : []).map((e) => {
    if (!e || e.status !== 'active') return e;
    const last = Number(e.lastSeen) || 0;
    if (last && t - last > ttlMs) {
      staled.push(String(e.key || ''));
      return Object.assign({}, e, { status: 'stale' });
    }
    return e;
  });
  return { entries: out, staled };
}

// ============================================================================
// 7. 写
// ============================================================================

/**
 * 覆写一整层档案（原子 + 按上限淘汰 + TTL 降级）。
 *
 * @param {{owner:string, layer:string, entries:Array, dataDir?:string, root?:string, now?:number}} opts
 * @returns {{ok:boolean, layer:string, written:number, evicted:number, staled:string[], error?:string}}
 */
function writeLayer(opts) {
  const o = opts || {};
  const layer = String(o.layer || '');
  const result = { ok: false, layer, written: 0, evicted: 0, staled: [], error: '' };

  if (!MEMORY_LAYERS.includes(layer)) {
    result.error = 'unknown_layer:' + layer;
    return result;
  }
  const dir = resolveOwnerDir(o.owner, o);
  if (!dir) {
    result.error = 'owner_required';
    return result;
  }

  try {
    // ★★ 必须先规范化，再走 TTL / 淘汰 —— 顺序不能换。
    //
    //  这是实测抓到的真 bug（2026-10-05，探针 mem-store-probe）：
    //  首版 writeLayer 拿 `o.entries` 原样往下走，而 applyTtl 判 `e.status !== 'active'`、
    //  evictEntries 按 `e.status === 'active'` 排序。调用方（Reconciler / 单测 / 任何直接调用者）
    //  传进来的裸条目**没有 status 字段** ⇒ `undefined !== 'active'` 恒真 ⇒
    //      · TTL 判定整段被跳过：200 天前的 projects 条目**永远不会降级**
    //      · 淘汰排序退化成"全部非 active"：confirmedCount 这条关键 tiebreak 形同虚设
    //  而 updateLayer 因为自己在外面调了 normalizeEntry ⇒ 同一个存储类**两条入口行为不一致**：
    //  走 updateLayer 正确、走 writeLayer 错误。这种"一个入口对、一个入口错"是最难查的形态。
    //
    //  ⇒ 治本方式不是"提醒调用方记得规范化"，而是**把规范化变成存储层自己的保证**：
    //     凡是经过 writeLayer 落盘的条目，一律先过 normalizeEntry。
    //     调用方给什么形状都行，落盘的一定是完整 schema ⇒ 上面两个判定不可能再被绕过。
    const normalized = (Array.isArray(o.entries) ? o.entries : []).map(normalizeEntry);
    const { entries: afterTtl, staled } = applyTtl(normalized, layer, o.now);
    const kept = evictEntries(afterTtl, LAYER_MAX_ENTRIES[layer]);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LAYER_FILE[layer]);
    const w = atomicWrite(file, JSON.stringify(kept, null, 2));
    if (!w.ok) {
      result.error = w.error || 'write_failed';
      return result;
    }
    result.ok = true;
    result.written = kept.length;
    result.evicted = Math.max(0, afterTtl.length - kept.length);
    result.staled = staled;
    return result;
  } catch (e) {
    result.error = 'store_error: ' + (e && e.message ? e.message : 'unknown');
    return result;
  }
}

/** ledger 的变更类型（UI 时间线按此渲染图标/文案）。 */
const LEDGER_OP = Object.freeze({
  ADD: 'ADD',                 // 新增一条记忆
  UPDATE: 'UPDATE',           // 更新既有记忆的值
  CONFIRM: 'CONFIRM',         // 再次确认（值没变，计数 +1）
  SUPERSEDE: 'SUPERSEDE',     // 新条目替代旧条目
  CONFLICT: 'CONFLICT',       // 冲突待裁决
  DECAY: 'DECAY',             // TTL 到期降级
  EVICT: 'EVICT',             // 超上限淘汰
  REJECT: 'REJECT',           // 被 Secret 硬门拒收（只记事实，不含原文）
});

/**
 * 追加一行 ledger（追加写，不重写整个文件）。
 *
 * ⚠️ 为什么追加而不是读-改-写：
 *    ledger 是高频写的（每次记忆变更一行）。读-改-写在并发下会丢行，
 *    而且文件越大越慢（O(n) 每次）。追加是 O(1) 且天然不丢已写入的行。
 *
 * ⚠️ 超上限时的裁剪是唯一的重写点，且**先写 tmp 再 rename**：
 *    否则裁剪过程中崩溃会丢掉全部历史。裁剪本身尽量低频（每 LEDGER_MAX_LINES 次一次）。
 *
 * 幂等性说明：本函数**不检查重复**。重复的流水行是可接受的（多一条事实记录），
 * 而"为了去重去读整个文件"会把 O(1) 退化回 O(n) —— 得不偿失。
 *
 * @param {{owner:string, op:string, layer?:string, key?:string, detail?:object,
 *          dataDir?:string, root?:string, now?:number}} opts
 * @returns {{ok:boolean, appended:boolean, error?:string}}
 */
function appendLedger(opts) {
  const o = opts || {};
  const out = { ok: false, appended: false, error: '' };
  const dir = resolveOwnerDir(o.owner, o);
  if (!dir) {
    out.error = 'owner_required';
    return out;
  }
  try {
    const now = Number(o.now) || Date.now();
    const row = {
      ts: now,
      at: isoOf(now),
      op: String(o.op || ''),
      layer: String(o.layer || ''),
      key: clip(o.key, 120),
    };
    // detail 里**绝不允许出现原文**：调用方负责（拒收时只传 reason），
    // 这里再兜一层长度限制，避免 detail 把流水撑爆。
    if (o.detail && typeof o.detail === 'object') {
      const d = {};
      for (const k of Object.keys(o.detail)) {
        const v = o.detail[k];
        d[k] = typeof v === 'string' ? clip(v, 200) : v;
      }
      row.detail = d;
    }

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LEDGER_FILE);
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    out.ok = true;
    out.appended = true;

    // —— 低频裁剪：只在明显超限时才重写 ——
    const lineCount = countLines(file);
    if (lineCount > LEDGER_MAX_LINES * 1.5) {
      trimLedger(file, LEDGER_MAX_LINES);
    }
    return out;
  } catch (e) {
    out.error = 'ledger_error: ' + (e && e.message ? e.message : 'unknown');
    return out;
  }
}

/** 数一个文件的行数（失败返回 0，绝不抛）。 */
function countLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return 0;
    let n = 0;
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++;
    return raw.endsWith('\n') ? n : n + 1;
  } catch {
    return 0;
  }
}

/** 把 ledger 裁到最近 keep 行（原子：先写 tmp 再 rename）。 */
function trimLedger(file, keep) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length <= keep) return { ok: true, kept: lines.length };
    const tail = lines.slice(lines.length - keep);
    return atomicWrite(file, tail.join('\n') + '\n');
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'unknown' };
  }
}

/**
 * 读 ledger（供 UI 时间线 / 门禁核对）。
 *
 * `limit` 的语义是**返回最近 N 条有效记录**，不是"只扫最近 N 行原始文本"。
 *
 * ⚠️ 这两种语义差别很大，且首版搞错了（2026-10-05 门禁 S5h 抓到）：
 *   首版 `lines.slice(-limit)` ⇒ limit 作用在**原始行**上，
 *   于是「末尾有一行损坏 + limit:1」会返回**空数组** —— 用户点开时间线什么也看不到，
 *   而实际上前面躺着几千条完好记录。损坏行**吃掉了配额**，这是典型的功能性缺陷。
 *   ⇒ 正确顺序：先解析（跳损坏），再对**解析成功的行**取最近 N 条。
 *
 * 为实现"从末尾倒着找够 N 条"，这里倒序遍历并在拿满后立即停止 ——
 * 避免为了 limit:20 去解析上百万行（时间线只需要最近几条，不该是 O(全量)）。
 */
function readLedger(owner, opts) {
  const o = opts || {};
  const dir = resolveOwnerDir(owner, o);
  if (!dir) return { ok: false, rows: [], error: 'owner_required' };
  try {
    const file = path.join(dir, LEDGER_FILE);
    if (!fs.existsSync(file)) return { ok: true, rows: [] };
    const raw = fs.readFileSync(file, 'utf8');
    const limit = Number.isFinite(Number(o.limit)) && Number(o.limit) > 0 ? Number(o.limit) : 0;
    const lines = raw.split('\n').filter((l) => l.trim());

    const rows = [];
    // 从最后一行往前扫：limit 只约束**成功解析**的行数。
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        rows.push(JSON.parse(lines[i]));
        if (limit && rows.length >= limit) break;   // 拿满即停，不解析更早的行
      } catch {
        // 单行损坏：跳过，且**不消耗配额**（修复点就在这一行注释所描述的行为上）
      }
    }
    rows.reverse();   // 倒序扫出来的，翻回时间正序（时间线从上到下按时间递增看）
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, rows: [], error: e && e.message ? e.message : 'unknown' };
  }
}

// ============================================================================
// 8. 面向调用方的高层入口
// ============================================================================

/**
 * 先读后写的辅助：读出整层、交给 mutate 回调改、再写回。
 *
 * ⚠️ 为什么单独提供：Reconciler 需要"读现有 → 决策 → 写回"，如果调用方自己拼，
 *    很容易忘了 TTL 降级和上限淘汰（于是记忆无限膨胀）。
 *    走这个入口 ⇒ 两个不变量自动生效。
 *
 * @param {{owner:string, layer:string, mutate:(entries:Array)=>{entries:Array, changed?:boolean},
 *          dataDir?:string, root?:string, now?:number}} opts
 * @returns {{ok:boolean, changed:boolean, before:number, after:number, evicted:number, staled:string[], error?:string}}
 */
function updateLayer(opts) {
  const o = opts || {};
  const layer = String(o.layer || '');
  const res = { ok: false, changed: false, before: 0, after: 0, evicted: 0, staled: [], error: '' };
  if (!MEMORY_LAYERS.includes(layer)) { res.error = 'unknown_layer:' + layer; return res; }
  if (typeof o.mutate !== 'function') { res.error = 'mutate_required'; return res; }

  const dir = resolveOwnerDir(o.owner, o);
  if (!dir) { res.error = 'owner_required'; return res; }

  const r = readLayer(o.owner, layer, o);
  if (!r.ok) { res.error = r.error || 'read_failed'; return res; }
  res.before = r.entries.length;

  let next;
  try {
    const m = o.mutate(r.entries.map(normalizeEntry));
    next = Array.isArray(m) ? m : (m && Array.isArray(m.entries) ? m.entries : r.entries);
  } catch (e) {
    // mutate 是调用方代码，它抛了不能连累档案：原样保留，如实报错
    res.error = 'mutate_failed: ' + (e && e.message ? e.message : 'unknown');
    res.after = r.entries.length;
    return res;
  }

  const w = writeLayer({
    owner: o.owner, layer, entries: next.map(normalizeEntry), dataDir: o.dataDir, root: o.root, now: o.now,
  });
  res.ok = w.ok;
  res.error = w.error || '';
  res.after = w.written;
  res.evicted = w.evicted;
  res.staled = w.staled;
  res.changed = w.ok && JSON.stringify(next.map((x) => x && x.key)) !== JSON.stringify(r.entries.map((x) => x && x.key))
    ? true
    : (w.ok && Number(o.now || 0) > 0);
  return res;
}

/**
 * 原子地落一批变更：多个层的改动 + 对应 ledger 行。
 *
 * ⚠️ "原子"的诚实边界：这**不是数据库事务**，跨文件的强一致性无法在纯 fs 上做到。
 *    这里的语义是**尽力而为 + 可审计**：
 *      · 每层各自原子（不会出现半截文件）
 *      · 任一层失败则**停止后续层**，但已写入的层不回滚（回滚需要快照，成本更高）
 *      · 无论成功失败，ledger 都记一行 —— 所以"写了一半"这件事**事后查得出来**
 *    这类场景（记忆）里，"丢了半条记忆"远好于"为了强一致把主任务拖死"。
 *
 * @param {{owner:string, changes:Array<{layer:string, entries:Array, op?:string, key?:string, detail?:object}>,
 *          ledgerRows?:Array<{op:string, key:string, detail?:object}>,
 *          dataDir?:string, root?:string, now?:number}} opts
 * @returns {{ok:boolean, applied:number, failedAt:string, layers:Object, ledger:number, errors:string[]}}
 */
function commit(opts) {
  const o = opts || {};
  const out = { ok: false, applied: 0, failedAt: '', layers: {}, ledger: 0, errors: [] };
  const dir = resolveOwnerDir(o.owner, o);
  if (!dir) { out.errors.push('owner_required'); return out; }

  const changes = Array.isArray(o.changes) ? o.changes : [];
  for (const c of changes) {
    if (!c || !c.layer) { out.errors.push('bad_change'); continue; }
    const w = writeLayer({
      owner: o.owner, layer: c.layer, entries: c.entries, dataDir: o.dataDir, root: o.root, now: o.now,
    });
    out.layers[c.layer] = { ok: w.ok, written: w.written, evicted: w.evicted, staled: w.staled };
    if (!w.ok) {
      out.failedAt = c.layer;
      out.errors.push(c.layer + ':' + (w.error || 'write_failed'));
      break;                  // 停止后续层（不回滚已写的，见函数注释）
    }
    out.applied += 1;
  }

  // ── ledger：两条来源都要写 ─────────────────────────────────────────────
  // ★★ 这里修的是一个**真实接线缺口**（2026-10-05 端到端门禁 E11~E13 抓到）：
  //   上游 `toCommitChanges()` 的契约是返回**两个独立字段**：
  //     · changes    —— 每层一条"整层覆写"，只有 { layer, entries }
  //     · ledgerRows —— 每条判定的**语义行** { op, key, detail{verdict,reason,value,supersedes} }
  //   而本函数首版**只从 changes 里捡 op/key/detail** ⇒ changes 上根本没有这些字段
  //   ⇒ 每行 ledger 只有 `op:'update'` 和 layer，**key 是空的、detail 也没有**。
  //   后果不是报错，是**静默退化成"什么也查不出来"**：
  //   用户问"你凭什么记得我叫潘一琪"，从 ledger 里读不到任何一条能对应上的记录
  //   —— 而 ledger 的全部存在意义就是回答这个问题。
  //   ⇒ 现在两条都写：changes 上的 op/key/detail（老调用方）+ ledgerRows（新契约）。
  //     为什么要保留 changes 那一路：兼容既有调用方（它们把语义直接挂在 changes 上）。
  for (const c of changes) {
    const op = c && c.op ? c.op : LEDGER_OP.UPDATE;
    const l = appendLedger({
      owner: o.owner, op, layer: c && c.layer, key: c && c.key, detail: c && c.detail,
      dataDir: o.dataDir, root: o.root, now: o.now,
    });
    if (l.ok) out.ledger += 1;
    else out.errors.push('ledger:' + (l.error || 'unknown'));
  }
  const rows = Array.isArray(o.ledgerRows) ? o.ledgerRows : [];
  for (const row of rows) {
    if (!row) continue;
    const op = row.op ? row.op : LEDGER_OP.UPDATE;
    // ⚠️ layer 从 detail 里取不到就留空 —— 语义行的归属层由判定产生方决定，
    //    这里不猜（猜错会让后续按层筛选的 UI 显示到错误的层上）。
    const lg = appendLedger({
      owner: o.owner, op, layer: row.layer || '', key: row.key || '', detail: row.detail || null,
      dataDir: o.dataDir, root: o.root, now: o.now,
    });
    if (lg.ok) out.ledger += 1;
    else out.errors.push('ledger:' + (lg.error || 'unknown'));
  }

  out.ok = out.errors.length === 0;
  return out;
}

module.exports = {
  // 层定义
  MEMORY_LAYER,
  MEMORY_LAYERS,
  LAYER_FILE,
  LAYER_TTL_DAYS,
  LAYER_MAX_ENTRIES,
  LEDGER_FILE,
  LEDGER_MAX_LINES,
  LEDGER_OP,
  ENTRY_VALUE_MAX,
  ENTRY_QUOTE_MAX,
  // 路径
  resolveMemoryRoot,
  resolveOwnerDir,
  safeOwnerSegment,
  // 读
  readLayer,
  readAllLayers,
  readLedger,
  // 写
  writeLayer,
  updateLayer,
  appendLedger,
  commit,
  // 内部（供门禁做定点验证）
  atomicWrite,
  normalizeEntry,
  evictEntries,
  applyTtl,
  clip,
};
