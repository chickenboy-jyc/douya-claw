'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

function clean(v) { return String(v == null ? '' : v).trim(); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function emptyStore() { return { schemaVersion: SCHEMA_VERSION, projects: [] }; }
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function validProjectShape(p) {
  return isObject(p)
    && typeof p.projectId === 'string' && typeof p.owner === 'string' && typeof p.threadId === 'string'
    && isObject(p.origin)
    && Array.isArray(p.turns) && Array.isArray(p.currentArtifacts) && Array.isArray(p.versions)
    && (p.validation == null || isObject(p.validation));
}
/**
 * 「这段话是不是在要一个**全新**的东西（不要粘到旧项目）」。
 *
 * 抽成独立函数是为了让 `continuationText` 与 `begin` 的 `allowImplicit` **共用同一份否决词表**。
 * 两处各写一份正则的话，一方加了词、另一方没加，就会出现"continue 认为是新东西、begin 认为该续接"
 * 这种自相矛盾 —— 而那正好是本函数被抽出来要防的那类漂移。
 */
function wantsNewThing(v) {
  const t = clean(v);
  if (!t) return false;
  // “再做一个完全不同的…”是新交付，不因同 thread 或“再做”二字粘到旧项目。
  return /(完全不同|另一个|新做|全新|新建|再做一个|再做一份)/.test(t);
}
function continuationText(v) {
  const t = clean(v);
  if (!t) return false;
  if (wantsNewThing(t)) return false;
  return /(继续|接着|再改|修改|优化|完善|绿色一点|在此基础上|原项目|同一项目|上一版|刚才|把.{0,20}(改|换|调|变))/.test(t);
}
function storedArtifactSignature(items) {
  return (Array.isArray(items) ? items : []).filter(isObject)
    .map((a) => clean(a.path) + ':' + (Number(a.size) || 0) + ':' + clean(a.sha1)).join('|');
}
function attachmentHit(project, items) {
  const wanted = new Set((Array.isArray(items) ? items : []).map((p) => clean(typeof p === 'object' ? (p.path || p.filePath) : p))
    .filter(Boolean).map((p) => p.replace(/[\\/]+/g, '/').toLowerCase()));
  if (!wanted.size) return false;
  return (Array.isArray(project.currentArtifacts) ? project.currentArtifacts : []).some((a) => {
    const p = clean(a && a.path).replace(/[\\/]+/g, '/').toLowerCase();
    return p && wanted.has(p);
  });
}

function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { store: emptyStore(), corrupt: false, error: '' };
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!j || j.schemaVersion !== SCHEMA_VERSION || !Array.isArray(j.projects)
      || j.projects.some((p) => !validProjectShape(p))) {
      return { store: emptyStore(), corrupt: true, error: '项目账 schema 或项目字段类型无法识别' };
    }
    return { store: j, corrupt: false, error: '' };
  } catch (e) {
    return { store: emptyStore(), corrupt: true, error: clean((e && e.message) || e) || '项目账损坏' };
  }
}

function atomicWrite(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 忽略清理错误 */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 忽略清理错误 */ }
  }
}

function artifactInfo(item) {
  const raw = item && typeof item === 'object' ? item : { path: item };
  const p = clean(raw.path);
  if (!p) return null;
  let size = Number(raw.size) || 0;
  let sha1 = clean(raw.sha1);
  try {
    const buf = fs.readFileSync(p);
    size = buf.length;
    sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  } catch { /* 文件稍后才落地：保留调用方已有事实，不编 hash */ }
  return { path: p, size, sha1 };
}

function artifactsOf(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const a = artifactInfo(item);
    if (!a || seen.has(a.path)) continue;
    seen.add(a.path);
    out.push(a);
  }
  return out;
}

function artifactSignature(items) {
  return storedArtifactSignature(artifactsOf(items));
}

function newProject(owner, threadId, projectId, originText, taskId, at) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: projectId || ('project_' + crypto.randomBytes(8).toString('hex')),
    owner,
    threadId,
    origin: { text: String(originText || ''), taskId: clean(taskId), at },
    turns: [],
    currentArtifacts: [],
    versions: [],
    validation: null,
    createdAt: at,
    updatedAt: at,
  };
}

function createProjectLedger(options) {
  const opt = options && typeof options === 'object' ? options : {};
  const filePath = clean(opt.filePath);
  if (!filePath) throw new Error('projectLedger.filePath 必填');
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();

  function candidates(owner, threadId, store) {
    return store.projects.filter((p) => p && p.owner === owner && p.threadId === threadId);
  }

  function resolve(input) {
    const x = input && typeof input === 'object' ? input : {};
    const owner = clean(x.owner);
    const threadId = clean(x.threadId);
    const projectId = clean(x.projectId);
    if (!owner || !threadId) return { status: 'unavailable', reason: 'owner/threadId 不完整，不自动续接项目' };
    const read = safeRead(filePath);
    if (read.corrupt) return { status: 'error', reason: '项目账损坏：' + read.error, corrupt: true };
    const scoped = candidates(owner, threadId, read.store);
    if (projectId) {
      const hit = scoped.find((p) => p.projectId === projectId);
      if (hit) return { status: 'resolved', project: clone(hit) };
      // 明确给一个别的 owner/thread 的 id 也不能跨隔离域粘过去。
      const foreign = read.store.projects.find((p) => p && p.projectId === projectId);
      if (foreign) return { status: 'error', reason: 'projectId 不属于当前 owner+thread，已拒绝续接' };
      return { status: 'none', projectId };
    }
    const attached = scoped.filter((p) => attachmentHit(p, x.attachmentPaths));
    if (attached.length === 1) return { status: 'resolved', project: clone(attached[0]) };
    if (scoped.length === 1 && x.allowImplicit !== false) return { status: 'resolved', project: clone(scoped[0]) };
    if (scoped.length > 1 || attached.length > 1) {
      return {
        status: 'ambiguous', reason: '当前 thread 有多个项目，必须显式指定 projectId',
        candidates: scoped.map((p) => ({ projectId: p.projectId, origin: clone(p.origin), updatedAt: p.updatedAt })),
      };
    }
    return { status: 'none' };
  }

  function begin(input) {
    const x = input && typeof input === 'object' ? input : {};
    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * ★★ 2026-11-11 修「跟进消息让 agent 失忆」（老板报障：跑偏）
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * 【实测证据（真实 tasks.json + traces，同一个 session `s1794200490804`）】
     *   task_mw8umy5i  goal="给我用godot做一个 类似于愤怒小鸟的游戏"  proj=created
     *   task_mw92uxzb  goal="不是godot的啊"                        proj=none  originChars=0
     *   task_mw95gpb4  goal="不是 你没给我godot版本啊"              proj=none  originChars=0
     *   task_mw95gc36  goal="不是godot诶"                          proj=none  originChars=0
     *   第一条建了项目 `project_b00bca`（projects.json 里 origin.text 完整、threadId 一致），
     *   后三条**同 owner 同 thread** 却全部 `proj=none`、`candidateProjectId` 为空。
     *
     * 【为什么会这样（旧判据的两处叠加）】
     *   旧代码：`allowImplicit = projectId || allowImplicit===true || continuationText(originText)`
     *   而 `continuationText` 认的词是「继续/接着/再改/修改/优化/完善/…」——
     *   **用户的真实纠错句一个都不在里面**：「不是godot的啊」「太丑了吧」「内容太少」「你没给我X版本」。
     *   ⇒ `allowImplicit=false` ⇒ `resolve()` 里那条 `scoped.length===1 && allowImplicit!==false`
     *     不成立 ⇒ `status='none'` ⇒ `begin()` 见 `create!==true`（纠错句不含产物名词，
     *     所以 productiveTask=false）直接 return ⇒ `project=null` ⇒ `originText=''`
     *   ⇒ `resolveTaskGoal` 只能拿本轮那 9 个字当目标 ⇒ **任务目标变成「不是godot的啊」**。
     *
     *   于是模型既不知道用户原本要「用 godot 做愤怒小鸟」，也不知道自己做错了什么；
     *   它的补救动作是去 Desktop / Downloads 里翻找（trace step 9-11 实录），
     *   最后 shell-exec 找不到东西，撞 24 轮上限 ⇒ 用户看到的「跑偏 + 跑不完」是同一个病。
     *
     * 【修法与失败方向（这条要看清楚再动）】
     *   只放宽一档：**本轮没有要新产物**（`create !== true`）**且不是明确要新东西** ⇒
     *   允许隐式续接**唯一候选**项目。
     *   · 唯一候选才续接 —— 多候选仍返回 `ambiguous`，仍然要求显式 projectId（没放宽）；
     *   · 要新产物（`create===true`，例如同会话里「给我用godot做一个涂鸦跳跃」）**不放宽** ——
     *     那确实是新任务，粘到旧项目才是错（实测 `task_mwa5k33u` 就是这种，行为必须保持）；
     *   · 显式 `allowImplicit:false` 仍然能一票否决（`resolve` 里的旧判据没动）。
     *
     *   为什么选这个失败方向（宁可误粘，不可失忆）：
     *     误粘的代价 = 模型多读到一段旧需求，它通常仍看得懂"用户现在问的是别的"；
     *     失忆的代价 = 目标文本本身就是一句「不是godot的啊」，模型**没有任何办法**知道要做什么
     *     ⇒ 必然跑偏，而且用户得把需求重打一遍（这正是他连发三条纠错的原因）。
     *   两者不对称，所以默认值应该是"宁可多给背景"。
     */
    // ★ 显式 `allowImplicit:false` 必须能一票否决**隐式**那几条通路。
    //   第一版把新增判据直接 `||` 进去，结果调用方明确说"别自动续接"也照样续接了 ——
    //   门禁 C4 当场打红（status=resolved，期望 none）。这一条不是形式主义：
    //   第二执行实例 / 自动化那些调用方要的是"别替我猜"，吃掉它的否决权等于把它们也变成
    //   "会粘旧项目"的行为，而它们恰恰没有用户在旁边纠正。
    //   注意 `projectId` 仍走显式通路：显式指定不受这个否决影响（那不是"隐式"）。
    const implicitOk = x.allowImplicit === true
      || continuationText(x.originText)
      || (x.create !== true && !wantsNewThing(x.originText));
    const allowImplicit = !!clean(x.projectId) || (x.allowImplicit !== false && implicitOk);
    const decision = resolve(Object.assign({}, x, { allowImplicit }));
    if (decision.status === 'resolved') return decision;
    if (decision.status !== 'none' || x.create !== true) return decision;
    const read = safeRead(filePath);
    if (read.corrupt) return { status: 'error', reason: '项目账损坏：' + read.error, corrupt: true };
    const at = Number(x.at) || now();
    const project = newProject(clean(x.owner), clean(x.threadId), clean(x.projectId), x.originText, x.taskId, at);
    read.store.projects.push(project);
    try {
      atomicWrite(filePath, read.store);
      return { status: 'created', project: clone(project) };
    } catch (e) {
      return { status: 'error', reason: '项目账写入失败：' + clean((e && e.message) || e) };
    }
  }

  function recordTurn(input) {
    const x = input && typeof input === 'object' ? input : {};
    const projectId = clean(x.projectId);
    if (!projectId) return { ok: false, reason: 'projectId 为空' };
    const owner = clean(x.owner);
    const threadId = clean(x.threadId);
    if (!owner || !threadId) return { ok: false, reason: 'owner/threadId 不完整' };
    const read = safeRead(filePath);
    if (read.corrupt) return { ok: false, reason: '项目账损坏：' + read.error, corrupt: true };
    const project = read.store.projects.find((p) => p && p.projectId === projectId && p.owner === owner && p.threadId === threadId);
    if (!project) return { ok: false, reason: '项目不在当前 owner+thread 隔离域内' };
    const at = Number(x.at) || now();
    const taskId = clean(x.taskId);
    const feedback = String(x.feedbackText == null ? '' : x.feedbackText);
    const turn = {
      taskId, at,
      kind: x.kind === 'origin' ? 'origin' : 'feedback',
      feedback,
      plan: Array.isArray(x.plan) ? x.plan.map((v) => clean(v)).filter(Boolean).slice(0, 30) : [],
      failures: Array.isArray(x.failures) ? clone(x.failures).slice(0, 30) : [],
      artifacts: artifactsOf(x.artifacts),
      validation: x.validation && typeof x.validation === 'object' ? clone(x.validation) : null,
    };
    const idx = project.turns.findIndex((t) => t && t.taskId && t.taskId === taskId);
    if (idx >= 0) project.turns[idx] = Object.assign({}, project.turns[idx], turn);
    else project.turns.push(turn);
    project.turns = project.turns.slice(-50);
    // 旧签名严格使用账本已存 hash；此刻磁盘可能已是 v2，重读会把 v1 历史伪算成 v2。
    const previousSignature = storedArtifactSignature(project.currentArtifacts);
    const nextArtifacts = artifactsOf(x.artifacts);
    const nextSignature = storedArtifactSignature(nextArtifacts);
    // 续接轮可能只是改文案/补验收，不能因本轮没重新交文件就清空项目当前产物。
    if (nextArtifacts.length || x.replaceArtifacts === true) project.currentArtifacts = nextArtifacts;
    if (nextArtifacts.length && nextSignature !== previousSignature) {
      project.versions.push({ at, taskId, artifacts: clone(nextArtifacts) });
      project.versions = project.versions.slice(-30);
    }
    if (x.validation && typeof x.validation === 'object') project.validation = clone(x.validation);
    project.updatedAt = at;
    try {
      atomicWrite(filePath, read.store);
      return { ok: true, project: clone(project) };
    } catch (e) {
      return { ok: false, reason: '项目账写入失败：' + clean((e && e.message) || e) };
    }
  }

  function get(input) {
    const r = resolve(input);
    return r.status === 'resolved' ? r.project : null;
  }

  return { resolve, begin, recordTurn, get, filePath };
}

function unresolvedOf(project) {
  if (!isObject(project) || !isObject(project.validation)) return [];
  const v = project.validation;
  const out = [];
  for (const r of (v.acceptance && Array.isArray(v.acceptance.results) ? v.acceptance.results : [])) {
    if (r && r.severity === 'must' && !['pass', 'not-applicable'].includes(r.outcome)) {
      out.push(clean(r.id) + (r.why ? '：' + clean(r.why) : ''));
    }
  }
  const rt = v.runtime && v.runtime.evaluation;
  if (rt && ['fail', 'unverified'].includes(rt.status)) out.push('运行验收：' + clean(rt.why));
  return out.filter(Boolean).slice(0, 20);
}

/** 下一轮注入：origin、反馈、当前产物 hash、上次验收与未解决项。 */
function projectPrompt(project) {
  if (!isObject(project)) return '';
  const origin = isObject(project.origin) ? project.origin : {};
  const lines = ['【同一项目持续交付账（程序持久化，不是模型自述）】',
    'projectId：' + clean(project.projectId),
    '最初需求原话：' + String(origin.text || ''),
    '最初 taskId：' + String(origin.taskId || '')];
  const feedback = (Array.isArray(project.turns) ? project.turns : [])
    .filter((t) => t && t.kind === 'feedback' && t.feedback).slice(-5);
  if (feedback.length) {
    lines.push('最近反馈原文：');
    feedback.forEach((t) => lines.push('· ' + t.feedback));
  }
  const artifacts = (Array.isArray(project.currentArtifacts) ? project.currentArtifacts : []).filter(isObject);
  lines.push('当前产物（path + size + sha1）：');
  if (artifacts.length) artifacts.forEach((a) => lines.push('· ' + clean(a.path) + ' | ' + (Number(a.size) || 0) + ' | ' + clean(a.sha1)));
  else lines.push('· （尚无）');
  const validation = isObject(project.validation) ? project.validation : null;
  if (validation) {
    lines.push('上次验证：' + String((validation.acceptance && validation.acceptance.verdict)
      || (validation.runtime && validation.runtime.evaluation && validation.runtime.evaluation.status) || '已记录'));
  } else lines.push('上次验证：（尚无）');
  const open = unresolvedOf(project);
  lines.push('未解决项：' + (open.length ? open.join('；') : '（无记录）'));
  lines.push('必须在上述同一项目产物上修改，不要另起无关项目；未改动的产物可复用已通过的对应证据，'
    + '任何产物改动后必须重跑受影响的验收。');
  return lines.join('\n');
}

function ambiguityPrompt(decision) {
  if (!decision || decision.status !== 'ambiguous') return '';
  const lines = ['【项目续接需要用户明确选择】当前 thread 有多个项目，不能猜最近一个。请让用户指定 projectId：'];
  (decision.candidates || []).forEach((c) => lines.push('· ' + c.projectId + '：' + String((c.origin && c.origin.text) || '')));
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  createProjectLedger,
  projectPrompt,
  ambiguityPrompt,
  unresolvedOf,
  artifactsOf,
  // 两个判据导出给门禁**直接喂文本**验证（unit-project-continuity）。
  // 不导出的话门禁只能 grep 源码字面量 —— 那种判据挡不住"改一个字符就静默失效"，
  // 而本条修的恰恰是"正则词表漏了用户的真实说法"，属于最需要真跑的那类。
  wantsNewThing,
  continuationText,
  _safeRead: safeRead,
  _atomicWrite: atomicWrite,
};
