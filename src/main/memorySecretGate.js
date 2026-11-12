'use strict';
/**
 * 豆芽记忆 2.0 · Secret 准入硬门（B 阶段）
 * ============================================================================
 * 设计总纲（2026-10-05 拍板）：
 *   记住「你是谁」，而不只是记住「你说过什么」。
 *   记忆可以增长，但事实必须有来源；记忆可以更新，但不能无证据漂移。
 *
 * 本模块只做一件事：**候选记忆 → 敏感检测 → REJECT / PASS**。
 * 它**没有能力写档案** —— 这是刻意的：就算本模块有 bug，也只可能多拦或少拦，
 * 不可能自己把东西写进 identity/orgs/prefs/projects。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ 与 backend.js 既有 maskSecrets 的关系（必须先读懂，否则会造出两套正则）
 * ────────────────────────────────────────────────────────────────────────────
 * 仓库里**已有**敏感字段判据（backend.js:314-362）：
 *     SECRET_KEY_RE      = /pass|pwd|secret|token/i
 *     SECRET_KEY_EXACT   = Set(apikey/api_key/private_key/access_key/…)
 *     SECRET_KEY_EXEMPT_RE = /(_path|_file)$/i
 *     maskSecrets(params)  → 把值替换为 '••••••'，**返回副本供前端展示**
 *
 * 两者**语义不同、不可互相替代**：
 *   · maskSecrets  = 「**展示**脱敏」→ 字段保留、值换成占位串 → 用于确认弹窗
 *   · 本模块       = 「**准入**拒收」→ 整条候选不放行、不进档案 → 用于记忆写入前
 *
 * 但**键名判据必须共用一份**，否则两边会漂移（改了一边忘了另一边 =
 * 某个新键名在弹窗里被遮住、却在记忆里明文落盘）。
 * ⇒ 所以本模块**优先复用 backend.js 导出的判据**；仅当拿不到时（单测独立 require）
 *   才回落到本文件内的等价副本，并且用单测断言**两套判据逐项一致**。
 */

// ============================================================================
// 1. 键名判据（与 backend.js 保持同源）
// ============================================================================

/**
 * 键名命中即视为「凭据」：password / passwd / pwd / secret / token（大小写无关）。
 * ⚠️ 与 backend.js:317 逐字一致；改一处必须改两处（由单测 S1 系列钉住）。
 */
const SECRET_KEY_RE = /pass|pwd|secret|token/i;

/**
 * 少量不含上述关键词、但语义上明确是凭据的精确键名（统一按小写比较）。
 * ⚠️ 与 backend.js:322-326 逐字一致。
 */
const SECRET_KEY_EXACT = new Set([
  'apikey', 'api_key', 'private_key', 'access_key',
  'key_content', 'key_data', 'key_body', 'private_key_content', 'private_key_data',
  'ssh_key', 'ssh_private_key', 'id_rsa',
]);

/**
 * 豁免：以 _path / _file 结尾的键指向的是**文件路径**而非密钥内容。
 * ⚠️ 与 backend.js:328 逐字一致。
 *
 * 为什么记忆层也要豁免：`key_path: 'keys/id_rsa'` 是路径、不是私钥内容，
 * 它**是有用的长期记忆**（"这台机器私钥在哪"），拦掉反而损害能力。
 */
const SECRET_KEY_EXEMPT_RE = /(_path|_file)$/i;

/** 判定「这个键名是否指向凭据内容」。与 maskSecrets 内联逻辑同构。 */
function isSecretKey(key) {
  if (typeof key !== 'string' || !key) return false;
  const kLow = key.toLowerCase();
  return (
    !SECRET_KEY_EXEMPT_RE.test(key) &&
    (SECRET_KEY_RE.test(key) || SECRET_KEY_EXACT.has(kLow))
  );
}

// ============================================================================
// 2. 值形态判据（maskSecrets 没有这一层 —— 这是本模块的增量）
// ============================================================================

/**
 * 为什么还需要「值形态」判据？
 * 键名判据只能拦住**命名字段**。但记忆是从**自然语言对话**里抽的，
 * 经常出现键名完全正常、值却是凭据的情况：
 *
 *   { key: 'note',  value: 'sk-<your-key>' }      ← OpenAI key
 *   { key: 'host',  value: 'mysql://root:P@ssw0rd@10.0.0.21:3306/db' }  ← 连接串含密码
 *   { key: 'info',  value: '-----BEGIN（私钥头）…' }     ← 私钥正文
 *   { key: 'server',value: 'root@8.149.243.48  密码 okzat911pp' }       ← 自然语言里的口令
 *
 * 只靠键名 ⇒ 上面四条**全部放行** ⇒ 直接落盘 + 下轮注入模型。
 * ⇒ 必须补「值形态」这一层。
 */

/** 私钥 / 证书块（PEM 头）。命中即拒收，无豁免。 */
const SECRET_VALUE_PEM_RE = /-----BEGIN[^-]{0,40}(PRIVATE KEY|RSA PRIVATE KEY|OPENSSH PRIVATE KEY|EC PRIVATE KEY|PGP PRIVATE KEY BLOCK|CERTIFICATE)-----/;

/** 主流厂商 token 的固定前缀形态（前缀足够独特，误伤率极低）。 */
const SECRET_VALUE_TOKEN_RES = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,           // OpenAI / Anthropic 系
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,       // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,      // GitHub token
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,        // GitLab PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,    // Slack
  /\bAKIA[0-9A-Z]{16}\b/,                // AWS Access Key ID
  /\bAIza[0-9A-Za-z_-]{35}\b/,           // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
];

/**
 * 带凭据的连接串：scheme://user:password@host
 * 只认「有 username:password@」这一形态（无认证信息的普通 URL 不动）。
 */
const SECRET_VALUE_URL_CRED_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/i;

/**
 * 自然语言里显式标注的口令：`密码 xxx` / `password: xxx` / `口令=xxx`
 * 需要**同时**出现标注词与一段像值的内容，避免把"我不知道密码"这类话误拦。
 */
const SECRET_VALUE_LABELED_RE = /(?:密码|口令|passwd|password|pwd|secret|token|api[\s_-]?key)\s*[:：=是为]?\s*[`"']?([A-Za-z0-9!@#$%^&*_+\-=.,]{6,})/i;

/** PEM 头的短形态（用于报 reason，不参与判定）。 */
function looksLikePem(v) {
  return SECRET_VALUE_PEM_RE.test(v);
}

/**
 * 判定「这个值本身是否像凭据」。
 * @param {unknown} value
 * @returns {{hit:boolean, reason:string}} reason 仅用于审计日志，**不含原文**
 */
function isSecretValue(value) {
  if (value == null) return { hit: false, reason: '' };
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (!v || v.length < 6) return { hit: false, reason: 'too_short' };

  if (looksLikePem(v)) return { hit: true, reason: 'pem_private_key_block' };

  for (let i = 0; i < SECRET_VALUE_TOKEN_RES.length; i++) {
    if (SECRET_VALUE_TOKEN_RES[i].test(v)) return { hit: true, reason: 'token_prefix_' + i };
  }

  if (SECRET_VALUE_URL_CRED_RE.test(v)) return { hit: true, reason: 'url_with_credentials' };

  const lm = v.match(SECRET_VALUE_LABELED_RE);
  // 标注命中后还要过一次「像不像密钥内容」：纯中文词（如"密码错误"）不算。
  if (lm && lm[1] && /[A-Za-z0-9]/.test(lm[1]) && lm[1].length >= 6) {
    return { hit: true, reason: 'labeled_credential' };
  }

  return { hit: false, reason: '' };
}

// ============================================================================
// 3. 准入硬门
// ============================================================================

/** 三态：拒收（不存）/ 通过。刻意**没有**「存但降低置信度」这一态。 */
const GATE_VERDICT = Object.freeze({
  REJECT: 'REJECT',
  PASS: 'PASS',
});

/**
 * 拒收时的三个事实（老板钉扎第三条：不是低置信度记忆，是直接拒收）。
 * 放在返回值里，让调用方与 UI 都能如实呈现，而不是"悄悄存了但标记低分"。
 */
const REJECT_FLAGS = Object.freeze({
  REJECTED: 'REJECTED',           // 已判定为敏感
  NOT_STORED: 'NOT_STORED',       // 未写入任何档案文件
  NOT_INJECTED: 'NOT_INJECTED',   // 不会进入 system memory 注入
});

/**
 * Secret 准入硬门。
 *
 * 这是记忆写入路径上**唯一**的敏感判定入口。Reconciler 必须在写入前调用它，
 * 且**只认 REJECT / PASS**：REJECT ⇒ 一个字节都不许落盘。
 *
 * 设计要点：
 *   · **不看置信度**。source=inferred、confidence=0.1 的候选同样拒收 ——
 *     低置信度不是安全的理由（它照样会被注入对话）。这是与「普通低价值记忆」的分界线。
 *   · **不做「折中」**。不提供"脱敏后存"——记忆一旦脱敏就失去信息价值，
 *     存一个 '••••••' 只是自欺。要留就留**指位符**（由调用方提供），否则拒。
 *   · **失败即拒**（fail-closed）。本函数内部任何异常都返回 REJECT，
 *     绝不因为"检测器坏了"而放行。
 *
 * @param {{key?:string, value?:unknown, source?:string, confidence?:number, quote?:string}} candidate
 * @returns {{verdict:string, reason:string, flags:string[], key:string}}
 *          —— 返回值**不含任何原文**，可安全写进审计流水。
 */
function memorySecretGate(candidate) {
  try {
    if (!candidate || typeof candidate !== 'object') {
      // 非对象：无法判定 ⇒ fail-closed 拒收（宁可少记，不可误存）。
      return reject('non_object_candidate', '');
    }

    const key = typeof candidate.key === 'string' ? candidate.key : '';

    // ── 判据①：键名 ──────────────────────────────────────────────────
    if (key && isSecretKey(key)) {
      return reject('secret_key_name:' + key, key);
    }

    // ── 判据②：值形态（key 与 value 都要看，value 优先）───────────────
    const vHit = isSecretValue(candidate.value);
    if (vHit.hit) {
      return reject('secret_value:' + vHit.reason, key);
    }
    // quote（原话出处）同样会被 UI 展示、且会写进流水 ⇒ 也要过形态检测。
    const qHit = isSecretValue(candidate.quote);
    if (qHit.hit) {
      return reject('secret_in_quote:' + qHit.reason, key);
    }

    return { verdict: GATE_VERDICT.PASS, reason: '', flags: [], key };
  } catch (e) {
    // fail-closed：检测器自身出错也拒收，绝不因为"检测不了"而放行。
    return reject('gate_error:' + (e && e.message ? e.message : 'unknown'), '');
  }
}

function reject(reason, key) {
  return {
    verdict: GATE_VERDICT.REJECT,
    reason,
    flags: [REJECT_FLAGS.REJECTED, REJECT_FLAGS.NOT_STORED, REJECT_FLAGS.NOT_INJECTED],
    key: key || '',
  };
}

// ============================================================================
// 4. 批量入口（Reconciler 用）
// ============================================================================

/**
 * 对一批候选做准入。返回**只含通过项**的数组 + 拒收统计。
 *
 * ⚠️ 关键：拒收项**不进入 passed**，因此调用方**没有任何机会**误把它们写进档案 ——
 * 这是"权限边界"而非"函数命名"的落实方式（老板钉扎第二条的同源要求）。
 *
 * @param {Array} candidates
 * @returns {{passed:Array, rejected:Array, rejectedCount:number, passedCount:number}}
 */
function filterMemoryCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const passed = [];
  const rejected = [];
  for (const c of list) {
    const r = memorySecretGate(c);
    if (r.verdict === GATE_VERDICT.PASS) passed.push(c);
    else rejected.push({ key: r.key, reason: r.reason, flags: r.flags });
  }
  return {
    passed,
    rejected,
    rejectedCount: rejected.length,
    passedCount: passed.length,
  };
}

module.exports = {
  // 判据源（与 backend.js 同源，单测断言逐项一致）
  SECRET_KEY_RE,
  SECRET_KEY_EXACT,
  SECRET_KEY_EXEMPT_RE,
  isSecretKey,
  isSecretValue,
  // 准入硬门
  GATE_VERDICT,
  REJECT_FLAGS,
  memorySecretGate,
  filterMemoryCandidates,
  // 供单测独立验证值形态各分支
  SECRET_VALUE_PEM_RE,
  SECRET_VALUE_TOKEN_RES,
  SECRET_VALUE_URL_CRED_RE,
  SECRET_VALUE_LABELED_RE,
};
