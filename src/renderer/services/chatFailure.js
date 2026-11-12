/**
 * chatFailure —— 对话「失败态」的**单一归类入口** + 「进行中气泡」的收敛工具。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 【这一版修的是老板第 5 条，原话逐字】
 *   「豆芽助手现在真的失败了 他也不会提醒你失败了 而是文案告诉你停止了，
 *     但是对话框还是生成中（对话框的生成中不明显 改的显眼点。）」
 *
 * 这条抱怨里其实有**两件事**，本文件各管一半：
 *   (a) 失败说的不清楚 —— 后端收尾时只会 sendPhase('done', '已停止' / '已超时停止')
 *       （见 src/main/backend.js:3411、:4005），前端把这句话当「结束标签」渲染，
 *       用户看到的是「已停止」而不是「失败了 + 为什么 + 能不能重试」。
 *       ⇒ `classifyChatFailure` / `describeFailure`：把失败**分类**，并且**保留原始原因**
 *          （绝不吞掉 detail，那正是"含糊"的来源），不同类别的抬头两两不等。
 *   (b) 气泡永远停在「进行中」 —— 真 bug，机制见 `settleRunningTools` 的注释。
 * ════════════════════════════════════════════════════════════════════════
 */

/**
 * 失败类别。**顺序即优先级**（前面的先命中），见 classifyChatFailure。
 * @type {ReadonlyArray<string>}
 */
export const FAILURE_KINDS = Object.freeze([
  'cancel',   // 用户自己点了「停止」
  'timeout',  // 超时（内圈 180s / 任务层 210s / 主进程 240s 任一层到点）
  'auth',     // 鉴权失败（key 过期 / 401 / 403）
  'server',   // 后端返回错误（5xx / 上游模型报错）
  'network',  // 网络或代理断开（fetch 抛错）
  'busy',     // 同一个 key 上一个任务还在跑（JOB_BUSY）
  'empty',    // 接口回了空内容（不是成功）
  'unknown',  // 兜底：至少说"失败了"，不假装完成
]);

/** 各类别的抬头（短标签，用于错误气泡的第一行；**两两不等**是有意为之）。 */
const HEADLINE = {
  cancel: '你已取消',
  timeout: '超时没返回',
  auth: '鉴权失败',
  server: '服务端出错',
  network: '连不上豆芽',
  busy: '上一次还在跑',
  empty: '没拿到内容',
  unknown: '失败了',
};

/** 类别 → 抬头。未知类别退回「失败了」，绝不返回空串。 */
export function failureHeadline(kind) {
  return HEADLINE[kind] || HEADLINE.unknown;
}

/**
 * 抬头 → 类别（`failureHeadline` 的逆映射）。
 *
 * 为什么需要它：`describeFailure` 在**多个**落点被调用（任务收尾时写一次、渲染时再算一次、
 * 「被拒绝启动」那条也走它）。如果每次调用都无脑再拼一个抬头，用户会看到
 * 「超时没返回：超时没返回：上游超时…」这种叠词。
 * ⇒ 让本函数可**幂等**：正文已经以某个抬头开头时，直接认出类别、原样保留正文。
 *
 * @param {string} headline 抬头文本
 * @returns {string} 类别（认不出返回空串）
 */
export function failureKindFromHeadline(headline) {
  const h = String(headline || '').trim();
  const hit = Object.keys(HEADLINE).find((k) => HEADLINE[k] === h);
  return hit || '';
}

/** 从"已经带抬头"的正文里认出类别（不带头返回空串）。 */
function kindFromPrefixedText(text) {
  const t = String(text || '');
  const keys = Object.keys(HEADLINE);
  for (const k of keys) {
    const h = HEADLINE[k];
    if (t.indexOf(h + '：') === 0 || t === h) return k;
  }
  return '';
}


/** 关键短语正则（集中在此，便于一处增删）。 */
const RE_TIMEOUT = /超时|等待超时|timed?\s*-?out|timeout|stream-idle/i;
const RE_AUTH = /鉴权|未授权|无权限|unauthorized|forbidden|invalid[_\s-]*api|api[_\s-]*key|401|403/i;
const RE_SERVER = /\b5\d\d\b|服务器|服务端|internal\s*server|bad\s*gateway|upstream|上游/i;
const RE_NETWORK = /网络|断网|连不上|连接失败|failed\s*to\s*fetch|networkerror|econn\w*|enotfound|etimedout|proxy/i;
const RE_CANCEL = /取消|已停止|已中断|aborted|abort/i;
const RE_EMPTY = /空内容|没有内容|没给出内容|未返回内容|empty/i;

/**
 * 把一次失败归到一个类别。
 *
 * 判据顺序有意写死：**取消 > 超时 > 鉴权 > 服务端 > 网络 > 占用 > 空结果 > 未知**。
 * 为什么「取消」排第一：用户主动停止时后端也会回一句「已停止」，若排在后面会被
 * 误判成服务端错误 —— 那等于把"你自己按的"说成"豆芽坏了"。
 *
 * @param {Object} [input]
 * @param {boolean} [input.cancelled] 用户是否点了停止
 * @param {boolean} [input.aborted] 底层 signal 是否被 abort
 * @param {boolean} [input.timedOut] 后台任务是否走了超时兜底
 * @param {number} [input.httpStatus] 后端 HTTP 状态码（若拿到）
 * @param {string} [input.code] 调用方约定码（JOB_TIMEOUT / JOB_BUSY / CONTENT_CHAT_TIMEOUT …）
 * @param {string} [input.note] 后台任务终态备注（超时 / 异常 / 失败 / 已完成）
 * @param {string} [input.message] 原始错误文本（**保留，不吞**）
 * @returns {string} FAILURE_KINDS 之一
 */
export function classifyChatFailure(input) {
  const o = input || {};
  const code = String(o.code || '');
  const note = String(o.note || '');
  const msg = String(o.message || '');
  const status = Number(o.httpStatus) || 0;

  if (o.cancelled === true) return 'cancel';
  if (code === 'JOB_BUSY') return 'busy';
  if (code === 'JOB_NO_KEY' || code === 'JOB_NO_FN') return 'unknown';

  // 幂等：正文已经是「超时没返回：…」这种本模块产出的形状 ⇒ 直接认回类别，
  // 不进入下面的正则链（否则「上一次还在跑：…」会被判成 unknown 再套一层抬头）。
  const prefixed = kindFromPrefixedText(msg);
  if (prefixed) return prefixed;

  if (o.timedOut === true || code === 'JOB_TIMEOUT' || code === 'CONTENT_CHAT_TIMEOUT'
    || note === '超时' || RE_TIMEOUT.test(msg)) {
    return 'timeout';
  }
  if (status === 401 || status === 403) return 'auth';
  if (RE_AUTH.test(msg)) return 'auth';
  if (status >= 500) return 'server';
  if (RE_SERVER.test(msg)) return 'server';
  if (o.aborted === true) return 'cancel';
  if (RE_NETWORK.test(msg)) return 'network';
  if (RE_CANCEL.test(msg) && !RE_SERVER.test(msg)) return 'cancel';
  if (RE_EMPTY.test(msg)) return 'empty';
  return 'unknown';
}

/**
 * 类别 → 「重试有没有意义」的提示语（给用户下一步动作，不是空话）。
 * @param {string} kind 失败类别
 * @returns {string} 下一步建议
 */
export function failureNextStep(kind) {
  switch (kind) {
    case 'timeout':
      return '点「重试」再来一次；任务太大就拆两步：先让它出大纲，再分段补内容。';
    case 'auth':
      return '去右上角「设置」检查 AI Key 是否过期，填好后再点「重试」。';
    case 'server':
      return '这是豆芽这边的服务端问题（不是你的操作），过一两分钟点「重试」。';
    case 'network':
      return '检查网络 / 代理后点「重试」；已经出来的内容不会丢。';
    case 'cancel':
      return '已经写出来的内容都保留在上面；要接着做就再发一次。';
    case 'busy':
      return '等上一个任务出结果，再点一次就行。';
    case 'empty':
      return '点「重试」再来一次；连续两次都空，就去「设置」换一个模型。';
    default:
      return '点「重试」再来一次；连续失败请把下面这句话发给客服。';
  }
}

/**
 * 把一次失败描述成**能直接渲染**的三段：类别 / 抬头 / 正文。
 *
 * 正文口径（有意为之）：`抬头：原始原因（下一步）` —— 原始原因**必须留在正文里**。
 * 因为老板抱怨的正是"含糊"：「已停止」三个字不带任何原因。分类只负责让用户
 * 一眼看出"是哪一类"，不负责替换事实。
 *
 * @param {Object} [input] 同 classifyChatFailure
 * @returns {{kind:string, headline:string, reason:string, text:string, next:string}}
 */
export function describeFailure(input) {
  const o = input || {};
  const kind = classifyChatFailure(o);
  const headline = failureHeadline(kind);
  const raw = String(o.message == null ? '' : o.message).trim();
  const next = failureNextStep(kind);
  // 默认原因按类别给一句人话（没有原始原因时才用），保证正文永远非空。
  const fallback = {
    cancel: '这次任务在完成前被停下了（不是出错）。',
    timeout: '等太久没有返回，我已放弃等待（不是完成）。',
    auth: 'AI 鉴权没通过，请求被拒绝。',
    server: '后端返回了错误状态。',
    network: '请求没能送出去（网络或代理断了）。',
    busy: '同一个任务上一次还在跑。',
    empty: '接口回了空内容，这一版什么都没写出来。',
    unknown: '这一版没做成，原因没拿到。',
  }[kind] || '这一版没做成。';
  const reason = raw || fallback;
  // 原因里已经带类别抬头时不重复加（避免「超时：超时：…」这种叠词）。
  const already = reason.indexOf(headline) === 0;
  const text = already ? reason : `${headline}：${reason}`;
  return { kind, headline, reason, text, next };
}

/**
 * ★ 「进行中」气泡的收敛工具（老板第 5 条 b 项的真 bug 修复）
 *
 * ── 失败后为什么气泡还停在「进行中」—— 具体到哪一步漏了 ──────────────────
 * `豆芽助手` 的工具步骤是**两条消息配对**推进的：
 *   ① 后端每开始一个动作 → 前端 push 一条 `{role:'tool_call', status:'running'}`；
 *   ② 该动作结束 → 后端发 `__tool_result__` 事件 → 前端把**那一行**改成 done/error。
 * 气泡里「进行中…」的唯一判据就是 `status === 'running'`（App.jsx 的 ToolGroup）。
 *
 * 而失败/终止路径**永远等不到 ②**：
 *   · backend.js:3411 `sendPhase('done', byTimeout ? '已超时停止' : '已停止')` 后直接 res.end()；
 *   · backend.js:4005 上游响应中断时同理 `sendPhase('done','上游响应中断已停止')`；
 *   · 前端 `j.type==='phase'` 分支**只** setWfPhase（把"已停止"这句文案贴到组头上），
 *     既不扫 tool_call，也没有任何地方把 running 改成终态；
 *   · `finally` 里只做 flushAssistantNow / setBusy(false) / setThinking(false) / persist，
 *     **同样没有扫 tool_call**。
 *   ⇒ 于是：文案说「已停止」，而那条 ⏳「进行中…」芯片永远留着；并且 `persistStore`
 *     会把这个 running 状态**写进磁盘**，重启后还在 —— 用户看到的就是"永远在生成中"。
 *     顺带还有一个副作用：`thinking` 气泡的渲染条件是「最后一条消息不是 tool_call」，
 *     所以恰好是 tool_call 结尾时，连「正在处理…」都不显示，只剩那条卡住的「进行中…」。
 *
 * 本函数就是补上那一步：任务一旦落终态（成功/失败/超时/取消都一样），
 * 把**所有**还挂在 running 的工具步骤收敛成终态，并留下可判定的 `interrupted` 标记。
 *
 * 为什么是纯函数（不在组件里就地 setState）：
 *   jsdom 里测不出滚动与动画，但「running → 终态」这个判断必须能被**直接断言**。
 *   抽成纯函数后：输入一批消息、输出一批消息，边界（无工具消息 / 已终态 / 混合）
 *   全都能在 node 侧逐条钉住，不依赖渲染。
 *
 * @param {Array<Object>} messages 会话消息数组（不改原数组）
 * @param {{reason?:string, kind?:string}} [opts] 收尾原因（用于给步骤留话）
 * @returns {{messages:Array<Object>, settled:number}} settled = 这次收敛了几条
 */
export function settleRunningTools(messages, opts) {
  const list = Array.isArray(messages) ? messages : [];
  const o = opts || {};
  const reason = String(o.reason || '').trim();
  const kind = String(o.kind || 'unknown');
  let settled = 0;
  let changed = false;
  const out = list.map((m) => {
    if (!m || m.role !== 'tool_call' || m.status !== 'running') return m;
    settled += 1;
    changed = true;
    // 不编造"做完了"：没等到结果就是没等到结果，如实标成中断。
    return {
      ...m,
      status: 'error',
      interrupted: true,
      failKind: kind,
      failReason: reason,
      result: String(m.result || '') || '这一步没等到结果就结束了（不是完成）',
    };
  });
  // 没有任何需要收敛的：**原样返回同一个引用**，避免调用方无谓重渲染。
  return { messages: changed ? out : list, settled };
}

export default describeFailure;
