// 统一工具调用协议（纯函数，可单测）
// ============================================================================
// 背景（2026-09-22 老板反馈 + 实测复现）：
//   豆芽会把「一次工具调用失败」直接当成「任务失败」——原地重试同一个失败调用，最后告诉用户"做不了"。
//   实测复现出**真正的机制**（不是"模型笨"，也不是"schema 没写 required"）：
//     ① tool_call 的 arguments 是**流式分片拼出来**的（backend.js handleLine 里 argsStr += …）；
//     ② 上游输出有上限：不给 max_tokens 时实测被截在 **8192**（usage.completion_tokens 恰好 8192，
//        finish_reason='length'）——实测 2 次里 1 次，`reasoning_effort='none'` 档甚至 2/2 被截；
//     ③ 被截断的 arguments 是**半截 JSON**（`Unterminated string in JSON at position N`）；
//     ④ 调用点是 `try { JSON.parse(...) } catch { params = {} }` —— **静默把参数整个清空**；
//     ⑤ 技能拿到零参数 ⇒ 报「错误：请提供目标文件路径」；
//     ⑥ 可模型**坚信自己已经给了参数**（它确实生成了，只是生成到一半被截），于是原样重发；
//     ⑦ 而 finish_reason 在这条链路里**从来没被读过**（全仓只有 2 处，都是写死 null 转发给前端）
//        ⇒ 没有任何人会告诉它"你这次是被截断的，不是漏写"。
//
// 本模块把「工具调用」从"各自 try/catch"变成**一套统一协议**：
//   调用前 → 参数解析 + 形态体检（normalizeToolArgs）
//   调用后 → 失败分类（classifyToolFailure）→ 记账（createRetryLedger）
//          → 连续失败升级为「换方案」（recoveryDirective）
//   收尾前 → 验证产物真的落地（verifyDeliverables）
//
// ★ 纪律：本模块只做**判断与出文案**，不做副作用（不写文件、不改状态）。
//   唯一涉及文件系统的是 verifyDeliverables，且只读（stat）。
'use strict';

const fs = require('fs');
const path = require('path');
/**
 * ★ 2026-02-16：`refuted` 的**三态判定**（证据 / 适用范围 / 代码版本）唯一真源。
 *   放在独立模块里而不是写在两个地方：`workflowState`（写账本）和本模块（读账本预热）
 *   必须用**同一条**判据，否则"写的人记了版本、读的人不认版本"这种事故一定会发生。
 *   它只 require fs/path/crypto ⇒ 与本模块无环。
 *
 * ★ 为什么写成 `require(path.join(__dirname, 'refuteScope'))` 而不是 `require('./refuteScope')`：
 *   本仓有多个门禁用 `new Function('module','exports','require',…)` 在**内存里**装载本文件跑变异
 *   （unit-tool-protocol / unit-tool-hardening-behavior / unit-delivery-protocol RC-H /
 *   unit-recovery-executor）。它们传进来的 `require` 是以 `scripts/smoke/` 为基准的，
 *   于是裸相对路径会按**调用方**解析 ⇒ MODULE_NOT_FOUND（把四个无关门禁一起打红）。
 *   按本文件所在目录解析在两种装载方式下都成立（那些装载器都正确传入了本文件的真实 `__dirname`）。
 */
const refuteScope = require(path.join(__dirname, 'refuteScope'));

// ============================ 1) 失败分类 ============================
// 为什么要分类：不同类的出路完全不同。
//   · 参数被截断 ⇒ 绝不能"原样重试"（重试一次会再被截一次），必须**缩短单次产出**或改用追加写入；
//   · 参数漏传   ⇒ 补上再调，原样重试同样无意义；
//   · 未配置/未登录 ⇒ 换任何参数都没用，只能去设置里连；
//   · 超时/中断   ⇒ 不该重试，该拆小或停下。
// 把"失败"当同一种东西处理，就是模型原地打转的根源。
// 2026-09-22 老板规范 §26 要求「工具层必须区分失败类型」，并给了**十类**的清单与各自的恢复方向。
// 本表即那十类（旧版只有 9 类，且把「权限」「路径」「环境」「验证工具」混在 PRECONDITION/RUNTIME 里 ——
// 混在一起就等于没有出路：四者的正确动作完全不同）。
const KIND = {
  ARGS_TRUNCATED: 'args_truncated',     // 参数被输出上限截断（半截 JSON）
  ARGS_MISSING: 'args_missing',         // 参数缺失 / 为空
  ARGS_INVALID: 'args_invalid',         // 参数存在但不合法（格式错）
  PATH_ERROR: 'path_error',             // 路径不存在 / 越界（规范 §26 path_error）
  PERMISSION_ERROR: 'permission_error', // 权限不足（规范 §26 permission_error）
  EXECUTION_ERROR: 'execution_error',   // 执行方式本身出错（规范 §26 execution_error）
  ENVIRONMENT_ERROR: 'environment_error', // 本机环境缺东西：命令不存在/端口占用/未安装（§26 environment_error）
  VERIFICATION_ERROR: 'verification_error', // **验证工具**自身出问题 ≠ 产品坏了（§26 verification_error / §23）
  PRECONDITION: 'precondition',         // 前置条件不满足（未连接 / 未登录 / 未配置）
  TIMEOUT: 'timeout',                   // 执行超时
  ABORTED: 'aborted',                   // 用户叫停
  UPSTREAM: 'upstream',                 // 上游/网络/模型侧问题
  RUNTIME: 'runtime',                   // 技能内部报错（其余情况）
  // 空结果（2026-10-22）：技能返回了空串 —— 既不是"成功"，也不是"报了错"。
  // 为什么单独立一类而不是扔进 UNKNOWN：物理成因是「技能 run() 忘了 return」/
  //   「进程被静默杀掉」/「上游返回空 body」，处置上要的是"看这个技能为什么一声不响"，
  //   跟 UNKNOWN（文案看不懂）完全不同。归到 UNKNOWN 会让审计里这两件事永远分不开。
  EMPTY_OUTPUT: 'empty_output',
  UNKNOWN: 'unknown',
};

/**
 * ★ 2026-11-09 新增：KIND 的合法取值集合。
 * 用途只有一个——校验「执行层传上来的 kind 是不是我们认得的那个」。
 * 为什么需要校验：外部传进来的任意字符串一旦被当 KIND 采信，会污染
 * failureSide / recoveryStrategyFor 的分支表（那两张表是按 15 类枚举写的）。
 */
const KIND_VALUES = new Set(Object.keys(KIND).map((k) => KIND[k]));

// 参数体检的**四态契约**（2026-09-22 老板规范）：
//   下游不许再靠「请提供 X」这类文案去猜"到底发生了什么" —— 错误原因必须在
//   **最靠近源头的地方确定一次**，然后一路传下去（classifyToolFailure / recoveryDirective /
//   retry ledger 都不该重新猜一遍）。
//   · truncated        半截 JSON（被输出上限截断）。**最高优先级**：绝不许反过来当成"模型漏写参数"，
//                      因为「请提供 path」很可能只是 params 被清空之后的**二次假象**。
//   · invalid_json     JSON 解析失败，或解析出来不是对象（格式真写错了）。
//   · missing_required JSON 合法、但缺必填参数。
//   · null             参数完整可用。
const PROBLEM = {
  TRUNCATED: 'truncated',
  INVALID_JSON: 'invalid_json',
  MISSING_REQUIRED: 'missing_required',
};

// 失败前缀：与 backend.js 的 FAILURE_RESULT_RE **同口径**（新增前缀要两处一起加）
const FAILURE_HEAD_RE = /^\s*(?:error\b|Error\b|错误|❌|操作失败|部署失败|回滚失败|搜索失败|失败\s*[：:]|[\u4e00-\u9fa5A-Za-z0-9_ ]{1,12}(?:失败|错误|超时|不存在|无效|不允许|拒绝)(?= *[：:（(，,\n]| *$)|请\s*(?:先|你)?(?:提供|告诉|指定|输入|给出)|请\s*先[^，。\n]{0,12}?(?:连接|配置|设置|登录|授权|绑定))/;

/** 这段文本**自己能不能被认成失败**（空串不算 —— 空串在入口处另有判据）。 */
function hasFailureHead(text) {
  const s = String(text == null ? '' : text);
  return !!s.trim() && FAILURE_HEAD_RE.test(s);
}

/** 空结果的失败底稿。开头的「错误：」是有意的 —— 见 ensureFailureHead 的说明。 */
const EMPTY_OUTPUT_STUB = '错误：技能没有返回任何内容（空结果）';

/**
 * ★★ 保证「已经判定为失败」的结果，**文本自己也能被认成失败**。
 * （2026-10-22，本轮最该记住的一条）
 *
 * ═══ 为什么需要它（这是我第二次踩同一个坑）═══
 *   失败分支会给结果**拼上一条处方**再返回给模型：
 *       return text + '\n' + recoveryDirective({kind, ...}) + breakerNote;
 *   而调用点紧接着又用 `!isFailureResult(result)` 判成功与否。于是：
 *     · 非空失败文本（`❌ 部署失败：…`）拼完仍以 `❌` 开头 ⇒ 仍判失败 ✓
 *     · **空结果**拼完变成 `"\n【工具调用失败 · …"` ⇒ 判据只认 `错误/失败：/error` 这些前缀，
 *       `【` 一个都不匹配 ⇒ 判**成功** ✗
 *   ⇒ 用户可见层完全反了：账本/熔断/执行记录都说失败，而 SSE 发 `ok:true`、
 *     履历记「完成」、成果卡照收、终态还能判 COMPLETE。修了判据却等于没修。
 *
 *   这与 2026-10-22 早些时候修的「闸门 directive 不以失败前缀开头 ⇒ 被记成成功」
 *   **是同一个坑**：把"是否失败"寄托在**拼接后的文本形态**上。所以这次不再逐处打补丁，
 *   而是把不变量立在这里：**governToolResult 的失败出口，返回值必须过得了 hasFailureHead**。
 *   门禁对 15 个 KIND 逐个断言这条不变量（见 unit-failure-side-*.mjs）。
 *
 * ⚠️ 只给"判了失败却不像失败"的文本补前缀；本来就以失败前缀开头的**一个字都不改**
 *   （本仓纪律：成功结果与既有失败文案都不许被顺手改写）。
 * @param {string} text 原始结果
 * @param {string} kind KIND 之一（决定补出来的前缀怎么称呼这次失败）
 * @returns {string}
 */
function ensureFailureHead(text, kind) {
  const s = String(text == null ? '' : text);
  if (hasFailureHead(s)) return s;
  // 空结果：用一句**以「错误：」开头**的实况说明当底稿（不是空串，也不是"（无输出）"）。
  if (!s.trim()) return EMPTY_OUTPUT_STUB;
  // 非空但判据认不出来（例如 "something went wrong at step 3"）：补一个带类型的前缀，
  // 保留原文——原文是模型唯一的线索，不许丢。
  return '错误（' + kindLabel(kind) + '）：' + s;
}

// 「像参数问题」的文案特征
const PARAM_FAIL_RE = /(请提供|缺少|必填|参数不合法|不是合法 JSON|不允许写到工作区外)/;
// 参数被截断的**决定性**特征：JSON 解析器自己说字符串没闭合（这是截断，不是模型写错格式）
const TRUNCATED_PARSE_RE = /(Unterminated string|Unexpected end of JSON|Unterminated (?:array|object)|Unexpected token }|position \d+)/i;
// 前置条件类
const PRECONDITION_RE = /(未连接|未登录|请先(?:在设置里)?连接|请先配置|未配置|没配置|token|凭证|凭据)/i;
// ↓ 以下四类按规范 §26 从 PRECONDITION/RUNTIME 里**拆出来**（混在一起会让四类共用一条错误的处方）。
// 路径类：路径不存在 / 越界。出路是「先去看真实的目录结构，再改路径」，不是改参数格式。
const PATH_ERROR_RE = /(ENOENT|no such file or directory|路径不存在|找不到(?:该|这个)?(?:文件|目录|路径)|不是合法(?:的)?路径|路径越界|不允许写到工作区外|outside the workspace)/i;
// 权限类：出路是「换目录 / 换执行方式 / 确实绕不开才请用户授权」，重试一万次都一样。
const PERMISSION_ERROR_RE = /(EACCES|EPERM|permission denied|access denied|权限不足|没有(?:该|此)?权限|无权(?:访问|写入)|禁止访问|拒绝访问|只读文件系统|read-only file system)/i;
// 环境类：本机缺东西（命令不存在 / 端口被占 / 运行时没装）。改参数无用，要换不依赖它的路。
// ★ 2026-10-23 补「磁盘满 / 配额满 / 句柄耗尽 / 内存不足」—— 由基准挑战 C1 抓到的真缺口：
//   实测 `classifyToolFailure('ENOSPC: no space left on device')` 返回 **unknown**，
//   于是 `failureSide` = unknown、`recoveryStrategyFor` 给出 **switch_method**（换工具/换命令形态）。
//   而磁盘满是**与环境有关、与工具无关**的：换个工具照样写不进去，处方应当走降级链（degrade_env）。
//   缺口为什么隐蔽：这几条 errno 是最"经典"的系统错误，却被当成了"看不懂的报错"。
const ENVIRONMENT_ERROR_RE = /(command not found|不是内部或外部命令|无法将.*识别为|EADDRINUSE|端口.*(?:被占用|已占用)|环境变量.*(?:未设置|不存在|缺失)|没有可用(?:的)?(?:浏览器|运行时)|未安装|not installed|ENOSPC|no space left on device|磁盘(?:空间)?(?:已)?(?:满|不足)|空间不足|disk (?:full|quota)|quota exceeded|配额(?:已)?(?:满|用尽|超出)|EMFILE|too many open files|ENOMEM|out of memory|内存不足|Cannot allocate memory)/i;
// 验证工具类：**验证工具自己**坏了（浏览器起不来 / CDP 连不上 / 截图失败 / 测试脚本自身报错）。
// ★ 这类必须与「产品坏了」分开（规范 §23）：把测试工具的问题误报成产品问题，会让开发去改不存在的东西。
const VERIFICATION_ERROR_RE = /(无法启动浏览器|浏览器(?:工具|进程|启动|驱动)?(?:失败|异常|崩溃)|CDP|DevTools|chrome(?:driver|-launcher)|puppeteer|playwright|截图失败|验证脚本(?:自身)?(?:报错|失败)|测试脚本(?:自身)?(?:报错|失败)|harnes|断言脚本)/i;
// 超时 / 中断
const TIMEOUT_RE = /(执行超过\s*[\d.]+\s*秒未返回|超时|timeout|timed out)/i;
const ABORT_RE = /(任务已被用户停止|已被用户停止|aborted)/i;
// 上游
const UPSTREAM_RE = /(upstream|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|网络|502|503|504)/i;

/**
 * 给一次工具失败定性。
 * @param {string} message 失败文案（技能返回值 或 error.message）
 * @param {{parseProblem?:string}} [ctx] 参数解析阶段已知的问题（最高优先）
 * @returns {string} KIND 之一
 */
function classifyToolFailure(message, ctx) {
  const s = String(message == null ? '' : message);
  // 参数解析阶段已定性 ⇒ 直接采信（比文案匹配更可靠：这是我们自己判定出来的）。
  // ★ 四态契约：源头定性一次，这里不再猜。'invalid' 是旧别名，保留兼容（防旧调用点回归）。
  if (ctx && ctx.parseProblem === PROBLEM.TRUNCATED) return KIND.ARGS_TRUNCATED;
  if (ctx && (ctx.parseProblem === PROBLEM.INVALID_JSON || ctx.parseProblem === 'invalid')) return KIND.ARGS_INVALID;
  if (ctx && ctx.parseProblem === PROBLEM.MISSING_REQUIRED) return KIND.ARGS_MISSING;
  // ★★ 2026-11-09 新增：**结构化优先于文案**。
  //   执行层（skills.js / procEvidence.js）已在最靠近源头的地方定性过，那条事实
  //   比下面任何正则都可靠；而正则依赖文案，"文案改一个字，分类就变"。
  //   诚实边界：这条只覆盖本仓自己抛的错（err.kind）；来自技能的纯文本错误仍走正则。
  if (ctx && typeof ctx.kind === 'string' && KIND_VALUES.has(ctx.kind)) {
    // 唯一例外：进程根本没起来（spawn 失败）时，"超时"这个 kind 一定是错的 ——
    // 没起的进程不会超时。这是防「上游把 spawn 失败误标成 timeout」的最后一道校验。
    const spawned = ctx.proc && ctx.proc.spawned === false;
    if (!(spawned && ctx.kind === KIND.TIMEOUT)) return ctx.kind;
    return KIND.ENVIRONMENT_ERROR;
  }
  // 结构化事实兜底：即便 kind 缺失，只要 proc 明确写着「我方超时」，就不许被文案带偏。
  if (ctx && ctx.proc && ctx.proc.timedOut === true && ctx.proc.killedByUs === true) return KIND.TIMEOUT;
  if (ctx && ctx.proc && ctx.proc.aborted === true) return KIND.ABORTED;
  // 空结果：**必须排在最前**（比任何文案匹配都前）。
  // 为什么不能靠下面的正则兜：所有正则都是"匹配某个词"，空串谁也匹配不上 ⇒ 落到 UNKNOWN ⇒
  // 「技能一声不响」和「文案看不懂」被审计记成同一类，处置方向却完全相反。
  if (!s.trim()) return KIND.EMPTY_OUTPUT;
  // JSON 截断特征：优先于"请提供"这类泛化文案 —— 截断才是**真因**，
  // 「请提供目标文件路径」只是**表象**（参数被清空后技能自然会这么报）。
  if (TRUNCATED_PARSE_RE.test(s)) return KIND.ARGS_TRUNCATED;
  if (ABORT_RE.test(s)) return KIND.ABORTED;
  if (TIMEOUT_RE.test(s)) return KIND.TIMEOUT;
  if (PRECONDITION_RE.test(s)) return KIND.PRECONDITION;
  // 规范 §26 的四类细分：**顺序有讲究** —— 必须在 PARAM_FAIL_RE / FAILURE_HEAD_RE 之前，
  // 否则「EACCES permission denied」这种会被泛化成 RUNTIME、"找不到文件"会被当成"缺参数"。
  // 验证工具类排在最前：它的文案里常同时出现"失败/报错"，早判才不会被归成普通 RUNTIME。
  if (VERIFICATION_ERROR_RE.test(s)) return KIND.VERIFICATION_ERROR;
  if (PERMISSION_ERROR_RE.test(s)) return KIND.PERMISSION_ERROR;
  if (PATH_ERROR_RE.test(s)) return KIND.PATH_ERROR;
  if (ENVIRONMENT_ERROR_RE.test(s)) return KIND.ENVIRONMENT_ERROR;
  if (PARAM_FAIL_RE.test(s)) return KIND.ARGS_MISSING;
  if (UPSTREAM_RE.test(s)) return KIND.UPSTREAM;
  if (FAILURE_HEAD_RE.test(s)) return KIND.RUNTIME;
  return KIND.UNKNOWN;
}

/**
 * 失败的「归属侧」—— **唯一判据**，回答一句话：这次失败该怪工具/环境，还是该怪模型自己？
 * （2026-10-22，老板第 3 条建议「让工具错误和模型错误分别进入不同的处理流程」）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么必须单独有这条轴：现状是**两类错误进同一个流程**
 * ═══════════════════════════════════════════════════════════════════════
 *   审计读数（2026-10-22）：14 个 KIND 全都只被用来**生成给模型的文案**，
 *   没有任何一个改变执行行为；真正"拦下不执行"的三道闸判的全是**次数**，不是**性质**：
 *     · 熔断 `toolBreaker.allows()` —— 同一工具连续失败 ≥2 次 ⇒ 禁用该工具
 *     · 同策略升级 —— 同一策略签名失败 ≥2 次 ⇒ 拦下这一路
 *     · 参数不可用 —— 解析态为截断/非法 JSON ⇒ 不执行
 *   ⇒ 后果：模型连续两次把参数写截断（**模型写坏了**，工具一点毛病没有），
 *     熔断器会把 `file-write` 整个禁掉 —— 用一个**好工具被禁用**去惩罚模型的输出长度。
 *     这既是"两类错误没分开"，也是**归因错到相反方向**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三侧的划界（按"证据指向谁"分，不按"谁听起来更像")
 * ═══════════════════════════════════════════════════════════════════════
 *   · MODEL —— ARGS_TRUNCATED / ARGS_MISSING / ARGS_INVALID
 *       这三类的共同点：**参数是模型生成、我们再解析的产物**。参数残了/缺了/坏了，
 *       说明的是"模型的输出不合格"，工具本身**根本没被证明有毛病**（多半压根没执行到）。
 *       ⇒ 该走的路：改参数 / 拆小 / 分次追加（recoveryDirective 已写好这些话），
 *         再加账本的"同策略升级"兜住反复犯 —— **不该熔断工具**。
 *   · TOOL —— ENVIRONMENT_ERROR / PERMISSION_ERROR / PRECONDITION / VERIFICATION_ERROR / TIMEOUT
 *       这五类的共同点：**本机这个手段真的用不了**（缺依赖、没权限、没连上、验证工具自己崩、超时）。
 *       参数怎么改都没用 ⇒ 熔断 + 走降级链（DEGRADE_CHAIN 已按这几类预设好了下一层）。
 *   · UNKNOWN —— 其余（PATH_ERROR / RUNTIME / UPSTREAM / ABORTED / EXECUTION_ERROR / UNKNOWN）
 *       判不出来就**保守执法**：仍计入熔断（宁可多拦一次，也不放过一个真跑不起来的工具）。
 *       刻意不把 PATH_ERROR 归到 MODEL：路径不存在可能是模型给错，也可能是盘上真的没有，
 *       两种可能都存在 ⇒ 归 UNKNOWN，不替它选边。
 *
 * ⚠️ 本函数是**纯函数**（不读环境/文件/不调 LLM）⇒ 门禁可直接喂 kind 看输出，并做变异自证。
 * @param {string} kind KIND 之一
 * @returns {'model'|'tool'|'unknown'}
 */
const FAILURE_SIDE = { MODEL: 'model', TOOL: 'tool', UNKNOWN: 'unknown' };

function failureSide(kind) {
  if (kind === KIND.ARGS_TRUNCATED || kind === KIND.ARGS_MISSING || kind === KIND.ARGS_INVALID) {
    return FAILURE_SIDE.MODEL;
  }
  // 空结果归**工具侧**：模型把参数写坏了不会让技能一声不响（那种情况会明确报缺参数），
  //   空输出的成因在技能实现（漏 return）、进程（被静默杀掉）或上游（空 body）。
  //   ⇒ 计入熔断：连续两次一声不响的工具，本来就该被拦下来看看为什么。
  if (kind === KIND.EMPTY_OUTPUT) return FAILURE_SIDE.TOOL;
  if (kind === KIND.ENVIRONMENT_ERROR || kind === KIND.PERMISSION_ERROR || kind === KIND.PRECONDITION
      || kind === KIND.VERIFICATION_ERROR || kind === KIND.TIMEOUT) {
    return FAILURE_SIDE.TOOL;
  }
  return FAILURE_SIDE.UNKNOWN;
}

/** 这一类失败，原样重试有没有意义？—— 决定了重试账本的升级时机。 */
function isRetryable(kind) {
  // 参数类：**改对参数后**重试有意义（所以不能禁止重试，但绝不能原样重试）
  // 路径类：把路径改对后重试有意义（前提是先去确认真实结构）
  // 执行类：换个方式执行往往就好，值得再试
  // 权限/环境：不先换目录、不先补环境，重试一万次都一样 ⇒ 不可重试
  // 验证工具类：连"到底坏的是工具还是产品"都还没分清，重试无意义
  // 前置条件：不先去连/去配，重试一万次都一样 ⇒ 不可重试
  // 超时/中断：重试只会再等一遍 ⇒ 不可重试
  return kind === KIND.ARGS_TRUNCATED || kind === KIND.ARGS_MISSING ||
    kind === KIND.ARGS_INVALID || kind === KIND.RUNTIME || kind === KIND.UNKNOWN ||
    kind === KIND.PATH_ERROR || kind === KIND.EXECUTION_ERROR;
}

/** 人类可读的中文类名（用于给模型/用户解释）。 */
function kindLabel(kind) {
  const map = {
    [KIND.ARGS_TRUNCATED]: '参数被截断（生成到一半就断了）',
    [KIND.ARGS_MISSING]: '参数缺失',
    [KIND.ARGS_INVALID]: '参数不合法',
    [KIND.PATH_ERROR]: '路径不存在或越界',
    [KIND.PERMISSION_ERROR]: '权限不足',
    [KIND.EXECUTION_ERROR]: '执行方式出错',
    [KIND.ENVIRONMENT_ERROR]: '本机环境缺东西',
    [KIND.VERIFICATION_ERROR]: '验证工具自身出问题',
    [KIND.PRECONDITION]: '前置条件没满足（未连接/未配置）',
    [KIND.TIMEOUT]: '执行超时',
    [KIND.ABORTED]: '被用户叫停',
    [KIND.UPSTREAM]: '上游/网络问题',
    [KIND.RUNTIME]: '执行期报错',
    // ★ 2026-10-22 补：漏了这一条 ⇒ kindLabel('empty_output') 落回「未定性的失败」，
    //   与「单独立类是为了把'技能一声不响'和'文案看不懂'分开」的初衷**自相矛盾**。
    [KIND.EMPTY_OUTPUT]: '技能没有返回任何内容（空结果）',
    [KIND.UNKNOWN]: '未定性的失败',
  };
  return map[kind] || map[KIND.UNKNOWN];
}

// ============ 1b) 失败类型 → 恢复方向（规范 §26 的显式处方表）============
// 为什么要把这张表**显式写出来**（而不是散在 recoveryDirective 的 if/else 里）：
//   规范 §26 的实质要求是「**不同错误使用不同恢复策略**」。散着写的时候，
//   新增一类很容易顺手抄上一类的处方（那就等于没分类）。
//   这张表是"每类到底该干什么"的唯一真源，门禁逐类断言它两两不同。
const KIND_PLAYBOOK = {
  [KIND.ARGS_TRUNCATED]: '改「一次写多少」：先用最小可用版本落地，剩余部分用 mode:"append" 分次追加，或拆成多个小文件',
  [KIND.ARGS_MISSING]: '把缺的参数补齐再调；拿不到值就先去把值取到，不要空着重发',
  [KIND.ARGS_INVALID]: '照报错把这一项取值/格式改对再调',
  [KIND.PATH_ERROR]: '先确认真实目录结构（读目录/找入口），再按实际路径改；不要凭猜的路径重试',
  [KIND.PERMISSION_ERROR]: '换一个可写目录或换执行方式；确实绕不开才请用户授权一次，并说清需要授权什么',
  [KIND.EXECUTION_ERROR]: '换执行方式（换工具/换命令形态/拆成更小的步骤），而不是重发同一条命令',
  [KIND.ENVIRONMENT_ERROR]: '本机缺依赖导致这条路走不通 ⇒ 换一条不依赖它的路；确实只能靠它时，明确告诉用户需要装/开什么',
  [KIND.VERIFICATION_ERROR]: '★先分清「是验证工具坏了」还是「产品真坏了」：换一种验证方式复核，再下结论；不要把工具问题报成产品问题',
  [KIND.PRECONDITION]: '换一条不需要该前置条件的路；确实绕不开就说明"需要先连接/配置 X"，并把能做的部分先做完',
  [KIND.TIMEOUT]: '把任务拆小（少处理一点、分多步），或换更轻的做法',
  [KIND.ABORTED]: '用户主动叫停，不是失败：停下并汇报当前进度，不要重试',
  [KIND.UPSTREAM]: '换一条等价链路（换接口/换技能）继续；不行就如实说明是外部服务的问题',
  [KIND.RUNTIME]: '先看报错本身；与参数无关就换一种做法达到同样目的',
  // ★ 2026-10-22 补：漏了这一条 ⇒ 处方正文刚说"什么都没返回"，尾巴却让它
  //   "把报错原文看一遍"（它压根没有报错）。正文与尾巴互相打脸。
  [KIND.EMPTY_OUTPUT]: '不要原样重发：先去确认产物到底在不在（列目录/读回文件/查状态）；确实没产出就换一种能回显结果的做法',
  [KIND.UNKNOWN]: '先定性再动手：把报错原文看一遍，判断属于哪一类，再按那一类的方向走',
};

/** 取某一类的恢复方向（规范 §26 处方表）。 */
function kindPlaybook(kind) {
  return KIND_PLAYBOOK[kind] || KIND_PLAYBOOK[KIND.UNKNOWN];
}

// ============================ 2) 参数解析与体检 ============================
/**
 * 半截 JSON 的识别：括号/引号没配平，或解析器报「字符串没闭合」。
 * 只看形态，不依赖错误文本（错误文本在各 runtime 里不一样）。
 */
function looksTruncated(raw) {
  const s = String(raw == null ? '' : raw);
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  // 处在字符串里没闭合，或括号没配平 ⇒ 形态上就是被截断的
  return inStr || depth !== 0;
}

/**
 * 从半截 JSON 里**尽力**抠出已经完整的那几个字段，仅用于**诊断与如实汇报**。
 * 🔴 绝不用它去执行技能：半截 content 写进文件 = 产出一个残缺文件还宣称"做完了"，
 *    那正是本仓最忌讳的"假完成"。所以这里返回的内容**只用于说清楚发生了什么**。
 */
function salvageTruncatedArgs(raw) {
  const s = String(raw == null ? '' : raw);
  const out = {};
  // 只认「"key": "完整闭合的短字符串"」这种已闭合的键值对；
  // 长文本（含转义换行的 content）通常就是被截断的那个，能抠到也不采取。
  const re = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1];
    if (Object.prototype.hasOwnProperty.call(out, k)) continue;
    try { out[k] = JSON.parse(m[2]); } catch { /* 忽略救不出来的 */ }
  }
  return out;
}

/** 空值判定：空串 / 空数组算「没给」；数字 0 与布尔 false 是合法值。 */
function isEmptyValue(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 调用前体检：把模型给的 arguments 字符串变成可用参数，并把「形态是否健康」一并报出。
 *
 * ★ finish_reason 必须**进判据**，不能只当文案：
 *   上游说 finish_reason='length' ⇒ 整条 assistant 消息是被输出上限掐断的，
 *   此时"JSON 没闭合"就不是"格式没写对"，而是"根本没写完"。判据里带上它，
 *   才能保证永远不把"被截断"误判成"模型漏写参数"（那会让整条链路一直修错东西）。
 *
 * ★ 四态契约（problem 与 canExecute **分开表达** —— "是什么问题"与"能不能执行"不是一回事）：
 *   | 情形                       | problem          | canExecute | 执行？                          |
 *   | 半截 JSON（输出上限截断）   | truncated        | false      | ❌ 禁止（params 空，执行只会误导）|
 *   | JSON 解析失败 / 不是对象    | invalid_json     | false      | ❌ 禁止（同上）                  |
 *   | JSON 合法、但缺必填        | missing_required | **true**   | ✅ 照常执行（见下）              |
 *   | 参数完整 / 空参数且无必填   | null             | true       | ✅ 执行                          |
 *
 *   为什么 missing_required 仍然放行执行：此时 params 是**部分可用**的，技能自己会报
 *   「缺哪个参数」（信息比我们转述更准）；而且有些技能对缺省项有兜底默认值，在源头一刀切
 *   拦截反而会误杀本来能成功的调用。**"禁止执行"只留给"参数根本不可用"的那两态。**
 *
 * @param {string} rawArgs 模型给出的 arguments 原始串
 * @param {{params?:Array}} [manifest] 技能 manifest（必填声明的真源）
 * @param {{finishReason?:string}} [opts] 本轮上游结束原因（'length' = 被输出上限截断）
 * @returns {{ok:boolean, params:object, problem:(null|'truncated'|'invalid_json'|'missing_required'),
 *            canExecute:boolean, missing:string[], salvaged:object, rawLength:number,
 *            finishReason:string, lengthHit:boolean, reason:string}}
 */
function normalizeToolArgs(rawArgs, manifest, opts) {
  const raw = rawArgs == null ? '' : String(rawArgs);
  const finishReason = String((opts && opts.finishReason) || '');
  const lengthHit = finishReason === 'length'; // ★ 最高优先级信号
  const ps = (manifest && manifest.params) || [];
  const reqNames = ps.filter((p) => p && p.required === true).map((p) => p.name || p.key).filter(Boolean);
  const base = {
    ok: true, params: {}, problem: null, canExecute: true,
    missing: [], salvaged: {}, rawLength: raw.length, finishReason, lengthHit, reason: '',
  };

  // 空串 = 模型根本没给参数（合法：有些技能不需要参数）
  if (raw.trim() === '') {
    const missing = reqNames.slice();
    return {
      ...base,
      ok: missing.length === 0,
      // ★ 缺必填要在**源头**定性，别让下游从"技能报了什么"去反推
      problem: missing.length ? PROBLEM.MISSING_REQUIRED : null,
      missing,
      reason: missing.length ? '模型没有给出任何参数（必填：' + missing.join('、') + '）' : '',
    };
  }

  let parsed = null;
  let parseErr = null;
  try { parsed = JSON.parse(raw); } catch (e) { parseErr = e; }

  if (parseErr) {
    // 三个来源任一成立即判截断：形状启发式 / 解析器报错类型 / **上游明说 length**
    const truncated = looksTruncated(raw) || TRUNCATED_PARSE_RE.test(parseErr.message) || lengthHit;
    const salvaged = salvageTruncatedArgs(raw); // 仅用于诊断与如实汇报，**绝不拿去执行**
    const missing = reqNames.filter((n) => isEmptyValue(salvaged[n]));
    return {
      ...base,
      ok: false,
      params: {}, // ★ 绝不用半截参数去执行
      problem: truncated ? PROBLEM.TRUNCATED : PROBLEM.INVALID_JSON,
      canExecute: false, // ★ 参数不可用 ⇒ 禁止执行
      missing,
      salvaged,
      reason: (truncated
        ? '参数 JSON 没生成完（' + raw.length + ' 字符后被截断，字符串都没闭合'
          + (lengthHit ? '；上游结束原因=length，已确认是输出上限截断' : '') + '）'
        : '参数 JSON 格式不合法') + '：' + String(parseErr.message || '').slice(0, 120),
    };
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...base, ok: false, params: {}, problem: PROBLEM.INVALID_JSON, canExecute: false,
      missing: reqNames.slice(), reason: '参数不是一个对象',
    };
  }

  const missing = reqNames.filter((n) => isEmptyValue(parsed[n]));
  return {
    ...base,
    ok: missing.length === 0,
    params: parsed,
    // ★ 四态里最容易漏掉的一态：JSON 合法、但缺必填 ⇒ 定性，**但不禁执行**
    problem: missing.length ? PROBLEM.MISSING_REQUIRED : null,
    canExecute: true,
    missing,
    reason: missing.length ? ('缺必填参数：' + missing.join('、')) : '',
  };
}

// ============================ 3) 调用签名与重试账本 ============================
/** 短哈希（FNV-1a 32bit）：把长参数压成短签名，避免把整份 content 塞进记账键。 */
function shortHash(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 「**原样重发**」的判据：技能名 + 参数形状（键名集合 + **各值的内容哈希**）。
 * 一字不改地重发 ⇒ 签名完全相同 ⇒ 这是"原地打转"最强的客观证据。
 * ⚠️ 注意它**不适合**用来判"要不要换方案"：模型只要把 content 砍短一点，值哈希就变了，
 *    计数会归零 ⇒ 于是它可以无限"微调着重试"，永远不触发升级。判升级请用 toolCallSignature()。
 */
function buildCallSignature(name, params) {
  const p = params && typeof params === 'object' ? params : {};
  const keys = Object.keys(p).sort();
  const parts = keys.map((k) => k + '=' + shortHash(typeof p[k] === 'string' ? p[k] : JSON.stringify(p[k])));
  return String(name || '?') + '#' + keys.length + '[' + parts.join(',') + ']';
}

/**
 * 执行模式归一：把"语义上等于默认"的写法全部抹平。
 * 缺省 / '' / overwrite / w / truncate / default / new 都视为**默认（一次性覆盖）**⇒ 归一为空串。
 * 只有真的换了执行方式（例如 append）才保留下来，作为**策略变化**的证据。
 */
function normalizeExecMode(m) {
  const s = String(m == null ? '' : m).trim().toLowerCase();
  if (!s) return '';
  if (s === 'overwrite' || s === 'w' || s === 'truncate' || s === 'default' || s === 'new') return '';
  return s;
}

/**
 * 「**是不是同一个策略**」的判据 —— 这是"该不该换方案"的真判据。
 *
 *   signature = 工具名 + 归一化参数键集合 + 执行模式
 *               （**刻意不含参数值**）
 *
 * 为什么必须不含值：
 * - `file-write(path, content)` 失败后把 content 砍短一点再发 ⇒ **还是同一个策略**（"一次写完"），
 *   在被输出上限截断这种失败下，它一定会再失败一次。改值 ≠ 换方法。
 * - `file-write(path, content)` → `shell-exec("node … fs.writeFileSync …")` ⇒ 工具名变了 ⇒ **新策略**，账本重开。
 * - `file-write(mode="write")` → `file-write(mode="append")` ⇒ 模式变了 ⇒ **策略变化**，账本重开。
 * - 缺省 mode 与 `mode="overwrite"` 是**同一个策略**（归一后相同），不会把同一次调用误判成两次。
 *
 * @param {string} name 工具/技能名
 * @param {object} params 已归一化的参数
 * @param {{mode?:string}} [opts] 显式执行模式（执行器知道实际用了哪种时传进来，优先级最高）
 * @returns {string} 策略签名
 */
function toolCallSignature(name, params, opts) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const keys = Object.keys(p)
    .filter((k) => k !== 'mode' && !isEmptyValue(p[k])) // 空值等于"没给"；mode 单列一格，不混进键集合
    .sort();
  const mode = normalizeExecMode(opts && opts.mode != null ? opts.mode : p.mode);
  return String(name || '?') + '|' + keys.join(',') + '|' + (mode || '-');
}

// ============================ 3a) 状态指纹：解冻（thaw）判据 ============================
// 【要根治的缺陷（2026-02-16 基准实测，不是推测）】
//   真实 Agent 生成并修复一个 Electron 海报工具时：第一轮安装/验收类 shell-exec 失败过若干次；
//   到第二轮、修复轮，它想重新执行安装或验收命令，被「同一做法已失败两次」**永久拦下** ——
//   于是它只能反复读文件、换写法，**再也没能真跑一次命令**，三轮终态都是 PARTIAL，
//   最后连源码字节都没改（自述改了、磁盘未变）。
//
// 【根因】记账键只含「工具 + 参数键 + 执行模式」（toolCallSignature），**不含世界的状态**：
//   · 产物字节已经变了（代码改过了、依赖装上了、工作区清过了）；
//   · 这已经是用户反馈后的**新一轮**（修复轮）；
//   · 命令原文也换了。
//   而账本看不出这些 —— 键算出来一模一样 ⇒ 旧失败被当成"此刻的失败" ⇒ 永久禁令。
//   ★ 这是「一次历史失败固化成永久禁令」的同一条病，只是载体从 `refuted` 换成了策略计数。
//
// 【修法】键里加一维**状态指纹**：`命令指纹 + 产物字节 hash + 反馈轮次 + 代码版本 hash`。
//   状态变了 ⇒ 这是**新情况**，旧的失败账不再适用于此刻 ⇒ **有限放行一次**（不是清零！），
//   并把放行原因记下来（可供审计/事后复盘）。状态没变 ⇒ 旧账照旧生效，第二次仍拦。
//
// 【四条护栏（缺一条就会变成有害功能）】
//   ① 完全相同的命令 + 完全相同的状态 ⇒ 键完全相同 ⇒ 计数照旧累加 ⇒ 仍拦（反控见门禁）；
//   ② 解冻**不是清零**：放行后这一次再失败，计数立刻回到上限 ⇒ 同状态下不会无限续杯；
//   ③ 解冻次数有上限（maxThaw，缺省 2）；跨状态累计还有**绝对上限**（缺省 maxSameMethod × (maxThaw+1)）；
//   ④ 危险操作门控（riskGate.js）在**执行点**，与本层完全无关，解冻碰不到它。
/** 同一策略最多解冻几次（状态变化换来的"再放行一次"）。缺省 2 次。 */
const THAW_DEFAULT_MAX = 2;

/**
 * 命令指纹：把「命令原文」压成短签名。
 * 为什么单独取：策略签名刻意**不含参数值**（判"换汤不换药"需要它不含值），
 * 但"命令本身换了一条"是**真换**，不该被当成同一个失败继续拦 —— 所以它在状态维里另算一格。
 * 只认这几个常见键；取不到就返回 ''（没有证据就不许放水）。
 * @param {object} params 已归一化的参数
 * @returns {string}
 */
function commandFingerprint(params) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  // 顺序固定 ⇒ 同一组参数永远算出同一个串
  const parts = [];
  for (const k of ['command', 'cmd', 'script', 'args', 'target']) {
    const v = p[k];
    if (isEmptyValue(v)) continue;
    // ★ 空白归一：`npm install` 与 `npm   install` 是**同一条命令**，不是"换了命令"。
    //   不归一的话，模型靠多加两个空格就能续一次杯 —— 那正是"换个写法继续原地打转"。
    const raw = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : JSON.stringify(v);
    parts.push(k + '=' + shortHash(raw));
  }
  return parts.join(',');
}

/**
 * 产物指纹：把「当前产物字节」压成短签名。
 * 接受三种形态（调用方有多少证据就给多少，**不许编**）：
 *   ① 字符串/数字 —— 直接当 hash（调用方自己算好的 sha1/字节数）；
 *   ② 数组，元素为字符串 —— 同上；
 *   ③ 数组，元素为 `{path, hash|sha1|sha256|bytes|size|mtime}` —— 逐个拼。
 * ★ 本函数**不读盘**（本模块纪律：不做副作用；verifyDeliverables 是唯一的 fs 例外）。
 *   产物 hash 由调用方（执行器/工作流）算好传进来 —— 谁看见字节，谁负责算。
 * @param {any} artifacts
 * @returns {string} 没有证据 ⇒ ''
 */
function artifactFingerprint(artifacts) {
  if (artifacts == null) return '';
  const list = Array.isArray(artifacts) ? artifacts : [artifacts];
  const parts = [];
  for (const a of list) {
    if (a == null) continue;
    if (typeof a === 'string' || typeof a === 'number') { parts.push(shortHash(String(a))); continue; }
    if (typeof a !== 'object') continue;
    const p = String(a.path || a.file || '');
    const h = (a.hash != null) ? a.hash : ((a.sha1 != null) ? a.sha1 : ((a.sha256 != null) ? a.sha256 : null));
    if (h != null) { parts.push(shortHash(p + ':' + String(h))); continue; }
    if (a.bytes != null) { parts.push(shortHash(p + ':' + String(a.bytes))); continue; }
    const sz = (a.size != null) ? String(a.size) : '';
    const mt = (a.mtime != null) ? String(a.mtime) : '';
    if (sz || mt) parts.push(shortHash(p + ':' + sz + ':' + mt));
  }
  return parts.join(',');
}

/**
 * 「这次重试时，世界是不是已经变了」—— 唯一的状态指纹构造点（单一真源）。
 *
 * 组成（四格，各自可缺省）：
 *   `c:` 命令指纹   `a:` 产物字节指纹   `r:` 反馈轮次   `k:` 代码版本指纹
 *
 * 🔴 **全部缺省必须返回空串**：那表示"拿不出状态证据"，此时行为与改造前**逐字一致**
 *   —— 没有证据就不许放水，这是本层最重要的 fail-closed 约定。
 *
 * @param {{command?:string, commandFingerprint?:string, params?:object,
 *          artifactHash?:string|number, artifacts?:any,
 *          round?:number, feedbackEpoch?:number, turn?:number, repairRound?:number,
 *          codeHash?:string}} o
 * @returns {string}
 */
function buildStateKey(o) {
  const s = (o && typeof o === 'object') ? o : {};
  // ★ 空白归一（与 commandFingerprint 同一条）：`npm install` 与 `npm   install` 是同一条命令，
  //   否则"改两个空格"就能换来一次放行 —— 那是换汤不换药，不是状态变化。
  const cmdRaw = String(s.command == null ? '' : s.command).trim().replace(/\s+/g, ' ');
  const cmdFp = cmdRaw
    ? shortHash(cmdRaw)
    : String(s.commandFingerprint || commandFingerprint(s.params) || '');
  const artHash = (s.artifactHash != null && String(s.artifactHash) !== '') ? String(s.artifactHash) : '';
  const artFp = artHash ? shortHash(artHash) : artifactFingerprint(s.artifacts);
  // 轮次：四个别名任一即可（不同调用方叫法不一样），取第一个**有效数字**。
  let round = 0;
  for (const k of ['round', 'feedbackEpoch', 'turn', 'repairRound']) {
    const n = Number(s[k]);
    if (Number.isFinite(n) && n > 0) { round = Math.floor(n); break; }
  }
  const codeFp = String(s.codeHash || '').trim() ? shortHash(String(s.codeHash).trim()) : '';
  if (!cmdFp && !artFp && round <= 0 && !codeFp) return '';
  return 'c:' + (cmdFp || '-') + '|a:' + (artFp || '-') + '|r:' + (round > 0 ? round : '-') + '|k:' + (codeFp || '-');
}

/**
 * 从「调用方的 opts」里取状态指纹。
 * 显式 `stateKey` 优先（调用方已经算好就别再算一遍）；否则按字段现算。
 * @param {object} o 传给 fail/strategyCountOf/allows 的 opts
 * @param {object} [params] 参数（用于在没有显式 command 时推命令指纹）
 * @returns {string} 拿不出证据 ⇒ ''（＝旧行为）
 */
function resolveStateKey(o, params) {
  const s = (o && typeof o === 'object') ? o : {};
  if (typeof s.stateKey === 'string' && s.stateKey.trim()) return s.stateKey.trim();
  return buildStateKey({
    command: s.command,
    commandFingerprint: s.commandFingerprint,
    params: s.params || params,
    artifactHash: s.artifactHash,
    artifacts: s.artifacts,
    round: s.round,
    feedbackEpoch: s.feedbackEpoch,
    turn: s.turn,
    repairRound: s.repairRound,
    codeHash: s.codeHash,
  });
}

/** 记账键 = 策略签名（+ 状态指纹）。状态缺省时**与旧键逐字相同**（保证旧账/旧调用点不失效）。 */
function retryKeyFor(baseSig, stateKey) {
  const sk = String(stateKey || '');
  return sk ? String(baseSig) + '#' + sk : String(baseSig);
}

/**
 * 重试账本：回答两个问题 —— ①这个方法是不是已经在原地打转？②打转够久了没有？
 * 老板定的规矩：**同一种方法最多重试 1 次**，第二次仍失败就换工具/换方案。
 *
 * **两级记账**（缺一不可）：
 * - `count` / `repeat` 走**逐字级**签名（含参数值）⇒ 判"是不是一字不改地重发"。
 * - `strategyCount` / `sameStrategy` / `escalate` 走**策略级**签名（工具+键+模式，不含值）
 *   ⇒ 判"是不是换汤不换药"。**升级由策略级驱动**：只把 content 改小一点不算换方法。
 *
 * ★ 2026-02-16 第三维：**状态**（见 3a 节头注）。记账键 = 策略签名 + 状态指纹
 *   （命令指纹 + 产物字节 hash + 反馈轮次 + 代码版本 hash）。
 *   状态变了 ⇒ 旧账不适用于此刻 ⇒ **有限放行一次**并记账；状态没变 ⇒ 旧账照旧生效。
 *   `byBase` 记的是**不带状态**的同一策略总账，用于两条护栏：解冻次数上限、绝对失败上限。
 *
 * @param {{maxSameMethod?:number, maxThaw?:number, maxTotalPerStrategy?:number}} [opts]
 */
function createRetryLedger(opts) {
  const o0 = (opts && typeof opts === 'object') ? opts : {};
  const maxSameMethod = (o0 && Number(o0.maxSameMethod)) > 0 ? Number(o0.maxSameMethod) : 2;
  // 解冻次数上限：状态变化最多换来几次"再放行一次"（缺省 2 次）
  const maxThaw = Number(o0.maxThaw) > 0 ? Number(o0.maxThaw) : THAW_DEFAULT_MAX;
  // 绝对上限：同一策略**跨状态**累计失败到这个数 ⇒ 无论状态怎么变都不再放行。
  // 🔴 这条是"不能取消全局次数上限"的落点：解冻是**有限宽容**，不是无限续杯。
  const hardCap = Number(o0.maxTotalPerStrategy) > 0
    ? Number(o0.maxTotalPerStrategy) : maxSameMethod * (maxThaw + 1);

  const seen = new Map();     // 逐字级 signature -> { count, kinds:{}, lastKind }
  const byStrategy = new Map();// (策略级 + 状态指纹) -> { count, kinds:{}, lastKind, stateKey }
  /**
   * 策略级（**不带**状态）的总账：strategy -> { total, thaws, lastState, inited, states, thawLog }
   * ★ 为什么与 byStrategy 分开：byStrategy 决定"此刻还允许试几次"（状态一变就换桶），
   *   byBase 决定"这条策略总共已经烧掉多少次"（不随状态清零）—— 两条护栏只认后者。
   */
  const byBase = new Map();
  const failedSig = new Set();// 失败过的签名（用于「结论审计」）
  /**
   * ★★ 「**本次运行真的失败过**」的桶键（`sig` 或 `sig#stateKey`）。
   *
   * 为什么必须有它（2026-02-16，复验方 P1 暴露的结构问题）：
   *   `seed()` 也会往 `byStrategy` 里写桶（那是"预热进来的额度"），而 `byStrategy` 是这两件事
   *   共用的容器 ⇒ 仅凭"桶里有 count"无法区分「本次失败的」和「上次预热进来的」。
   *   此前 `liveList()` 用 `seededMeta.has(base)` 来近似区分，副作用是
   *   「预热过 + 本轮继续失败」的**本次失败**被整条跳过（详见 liveList 头注）。
   *   ⇒ 用一个**独立的集合**记住"哪些桶是 fail() 写出来的"，判定与序列化彻底解耦
   *     （不去改桶对象的形状，避免影响 snapshot/落盘的口径）。
   */
  const liveBuckets = new Set();
  /**
   * ★★ 「本次运行里这条桶键**真的失败了几次**」：桶键 -> 次数。**只由 `fail()` 加一。**
   *
   * 为什么不直接用 `byStrategy.get(key).count`（复验方第三轮实测，就在相邻一格）：
   *   `seed()` 会把磁盘历史折成"额度"写进 `byStrategy`（纪律②：`count - 1`）。
   *   对**推不出状态指纹**的工具（`file-write` 只带 `{path}`、3 参 `shell-exec` 不带 command），
   *   本次 `fail()` 落的桶键**就是预热那个基键** ⇒ 额度与本次次数挤在**同一个计数器**上：
   *     · 磁盘历史 5 次 ⇒ 额度 4 进桶；本次再失败 2 次 ⇒ 桶里 `count = 6`
   *     · 实测扫描（本次固定失败 2 次）：seed=1/2/3/5 ⇒ 桶里 2/3/4/6，带 `#` 的永远 2
   *   于是正文会写「累计失败 6 次」—— 6 既不是 5、也不是 2、也不是 7，**它谁都不是**。
   *   交接单是要念给接手的人照着做的，这种数字比不说更糟。
   *   ⇒ 单开一本"只数 `fail()`"的账；`liveList()` 的次数**只从它取**。
   *     `byStrategy.count` 继续只服务它自己的读者（拦不拦、还允许试几次），两边谁也不借谁的数。
   */
  const liveCounts = new Map();
  /**
   * ★★ 2026-02-16（交接单红线一）：**本次运行里账本真的给出过 `escalate === true`** 的桶键。
   *
   * 为什么必须有它（这是本轮要修的那条红线）：
   *   `liveList()` 原来把 `refuted: false` 写死，理由是"live 失败没有'已证伪'的**证据**，
   *   不许替它下结论"—— 那句话对**磁盘三态判定**（证据/适用范围/代码版本）是对的，
   *   但它把另一件事一起挡掉了：**本次运行里刚刚反复撞墙**这条事实。
   *   而 `handoffBrief` 的禁令判据是 `refuted === true && stale !== true`
   *   ⇒ 本次刚失败 3 次的策略**永远进不了「不要再用」** ⇒ 替补照着前任刚撞过的墙再撞一遍。
   *   这正是老板那句话要防的："不能接手后把前任失败的步骤再重复一遍"。
   *
   * 与 `refuteState: 'live'` 的分工：那个字段表示"这条否定结论**不来自**磁盘三态判定"；
   * 本集合表示"账本在**本次运行**的执法维度上已经判它必须换方案"。两者互不替代。
   *
   * ⚠️ 记的是 `fail()` **真的返回过** `escalate === true` 的桶键（同一个键的唯一计算点），
   *   不在 `liveList()` 里另算一遍 `count >= maxSameMethod` —— 那会变成第二套口径。
   */
  const liveEscalated = new Set();
  /** 解冻事件流水（供调用方/门禁取证：哪条策略、因为什么状态变化、放行了几次）。 */
  const thawLog = [];
  /**
   * 从磁盘账本**预热**进来的元信息：
   * 策略签名 -> `{ refuted, refutedAt, refutedEvidence, refutedScope, refutedCodeVersion,
   *               nextAction, lastError, at }`。
   * ★ 与 byStrategy 分开存：byStrategy 决定"还允许试几次"，这里只负责"上次这条路为什么坏"，
   *   两者的寿命不同（次数会被消耗掉，原因要一直能说出来）。
   * ★ 2026-02-16：`refuted` 的**三字段原文**也一起存下来（不是存一个布尔结论），
   *   因为"这个否定结论还算不算数"必须**在读取那一刻**重新判（代码可能已经变了）。
   *   判定本身不在这里做，统一走 `refuteScope.projectRefute` —— 判据只有一个真源。
   */
  const seededMeta = new Map();
  /**
   * 预热时被判成 `stale` 的事件（"旧禁令因代码变更而作废"）。
   * ★ 为什么要留：老板要的是「记一条 refutedStale 事件（含哪个文件变了、旧 sha1、新 sha1）」。
   *   内存这一份供同一进程内的调用方/门禁取证；落盘那一份在 `workflowState.open()` 的 `refuteEvents`。
   */
  const refuteStaleEvents = [];
  let total = 0;

  return {
    /**
     * 记一次失败。
     * @param {string} name 工具/技能名
     * @param {object} params 归一化参数
     * @param {string} kind 失败类型
     * @param {{mode?:string, stateKey?:string, command?:string, artifactHash?:string|number,
     *          artifacts?:any, round?:number, feedbackEpoch?:number, turn?:number,
     *          repairRound?:number, codeHash?:string}} [o]
     *   状态四格**任一**给到即可（命令指纹 / 产物字节 hash / 反馈轮次 / 代码版本 hash）。
     *   一个都不给 ⇒ 状态指纹为空 ⇒ 行为与改造前逐字一致（**没有证据不放水**）。
     * @returns {{count:number, escalate:boolean, repeat:boolean, kind:string,
     *            strategyCount:number, sameStrategy:boolean, strategy:string,
     *            stateKey:string, thawed:boolean, thawReason:string,
     *            strategyTotal:number, thawsUsed:number, hardCap:number}}
     *   count    = 逐字级：这个签名失败了几次（含值哈希）
     *   repeat   = 是不是**一字不改**又失败了一次
     *   strategyCount = 策略级：**当前状态**下，同一个"工具+参数键+执行模式"失败了几次
     *   sameStrategy  = 是不是**换汤不换药**（参数值变了但策略没变）
     *   escalate = 是否已到该强制换方案的次数（**按策略级 + 当前状态计**）
     *   thawed   = 这一次是不是因为「状态已变化」而**有限放行**的（放行一次，不是清零）
     *   thawReason    = 放行/仍拦的**可读原因**（必须能直接念给用户与审计看）
     *   strategyTotal = 这条策略**跨状态**的累计失败次数（绝对上限按它算）
     */
    fail(name, params, kind, o) {
      const sig = buildCallSignature(name, params);
      const cur = seen.get(sig) || { count: 0, kinds: {}, lastKind: kind };
      cur.count += 1;
      cur.lastKind = kind;
      cur.kinds[kind] = (cur.kinds[kind] || 0) + 1;
      seen.set(sig, cur);

      const strat = toolCallSignature(name, params, o);
      const stateKey = resolveStateKey(o, params);
      const key = retryKeyFor(strat, stateKey);
      const sc = byStrategy.get(key) || { count: 0, kinds: {}, lastKind: kind, stateKey };
      sc.count += 1;
      sc.lastKind = kind;
      sc.kinds[kind] = (sc.kinds[kind] || 0) + 1;

      // ===== 状态维：世界变了没有？（唯一判定点，见 3a 节）=====
      let bs = byBase.get(strat);
      if (!bs) bs = { total: 0, thaws: 0, lastState: stateKey, inited: false, states: new Set(), thawLog: [] };
      bs.total += 1;
      bs.states.add(stateKey);
      let thawed = false;
      let thawReason = '';
      const stateChanged = bs.inited && bs.lastState !== stateKey;
      if (stateChanged) {
        if (bs.thaws < maxThaw) {
          bs.thaws += 1;
          thawed = true;
          // ★ 只放行**一次**：把当前状态桶的计数压到"还差一次到上限"，
          //   这一次再失败 ⇒ 计数立刻回到上限 ⇒ 同状态下不会无限续杯。
          sc.count = Math.min(sc.count, Math.max(1, maxSameMethod - 1));
          thawReason = '状态已变化（' + (bs.lastState || '（无状态证据）') + ' ⇒ ' + (stateKey || '（无状态证据）')
            + '）⇒ 有限放行一次（第 ' + bs.thaws + '/' + maxThaw + ' 次解冻）';
          const ev = {
            tool: String(name || '?'), strategy: strat,
            from: bs.lastState, to: stateKey, reason: thawReason, at: Date.now(),
          };
          bs.thawLog.push(ev);
          thawLog.push(ev);
        } else {
          // 解冻次数用尽：状态虽然又变了，但这条路已经试太多次 ⇒ 仍拦，且原因可读。
          sc.count = Math.max(sc.count, maxSameMethod);
          thawReason = '解冻次数已用尽（' + bs.thaws + '/' + maxThaw + '）：状态虽然又变了，'
            + '但这条策略已累计失败 ' + bs.total + ' 次 ⇒ 不再放行';
        }
      }
      bs.lastState = stateKey;
      bs.inited = true;
      byBase.set(strat, bs);

      // ★ 绝对上限（护栏③）：跨状态累计到顶 ⇒ 无论状态怎么变都必然 escalate。
      if (bs.total >= hardCap) {
        sc.count = Math.max(sc.count, maxSameMethod);
        if (!thawReason) {
          thawReason = '同一策略（跨状态）已累计失败 ' + bs.total + ' 次，达到绝对上限 '
            + hardCap + ' 次 ⇒ 不再放行';
        }
      }
      byStrategy.set(key, sc);
      // ★ 这个桶是**本次运行真的失败过**的（与 seed() 预热进来的桶区分开，见 liveBuckets 头注）。
      liveBuckets.add(key);
      // ★★ 本次运行的失败次数**另立一本**（不与 seed() 预热进来的额度共用计数器，见 liveCounts 头注）。
      liveCounts.set(key, (Number(liveCounts.get(key)) || 0) + 1);
      // ★★ 账本这一次**真的判了** `escalate === true`（同一处计算、同一个维度）⇒ 记下来，
      //    供 `liveList()` 如实投影成"本次运行已验证不通"（见 liveEscalated 头注）。
      if (sc.count >= maxSameMethod) liveEscalated.add(key);

      failedSig.add(sig);
      total += 1;
      return {
        count: cur.count,
        escalate: sc.count >= maxSameMethod,
        repeat: cur.count > 1,
        kind,
        strategyCount: sc.count,
        sameStrategy: sc.count > 1 && cur.count === 1, // 值变了(逐字级才算第1次) 但策略沿用 ⇒ 换汤不换药
        strategy: strat,
        stateKey,
        thawed,
        thawReason,
        strategyTotal: bs.total,
        thawsUsed: bs.thaws,
        hardCap,
      };
    },
    /** 同一个签名已经失败过几次（0 = 没失败过）。逐字级。 */
    countOf(name, params) {
      const e = seen.get(buildCallSignature(name, params));
      return e ? e.count : 0;
    },
    /**
     * 同一**策略**已经失败过几次（0 = 没失败过）。
     * 键 = 策略级（工具+参数键+模式）**+ 当前状态指纹**（状态缺省时与旧键逐字相同）。
     * ★ 状态变了 ⇒ 这里是新状态的计数（旧账不再适用）⇒ 这一个读数就是"还允许试几次"的真源。
     */
    strategyCountOf(name, params, o) {
      const strat = toolCallSignature(name, params, o);
      const e = byStrategy.get(retryKeyFor(strat, resolveStateKey(o, params)));
      if (e) return e.count;
      // 兜底：只有"不带状态"的旧账（磁盘预热 / 改造前的调用点）⇒ 按旧账读数。
      // 少了这一步，跨请求预热进来的账会因为调用方突然带上状态证据而**整个查不到**（读数归 0 ⇒ 误放行）。
      const legacy = byStrategy.get(strat);
      return legacy ? legacy.count : 0;
    },
    /**
     * 同一**策略**上一次失败的类型（没失败过 ⇒ UNKNOWN）。
     * ★ 为什么要这个读数：执行**之前**要回答"这一条该换成哪条路"，
     *   此时只知道"上一回这一类是怎么坏的"，而不能等这次坏了再问（那就晚了）。
     * ★ 状态感知：先查**当前状态**的桶；当前状态下没失败过，退到"不带状态"的旧账
     *   （否则状态一变就查不出上次是什么类型的失败，指令会退化成 UNKNOWN）。
     */
    lastKindOfStrategy(name, params, o) {
      const strat = toolCallSignature(name, params, o);
      const e = byStrategy.get(retryKeyFor(strat, resolveStateKey(o, params)));
      if (e) return e.lastKind;
      const legacy = byStrategy.get(strat);
      return legacy ? legacy.lastKind : KIND.UNKNOWN;
    },
    /**
     * ★★ 执行**之前**问一次：这一条是不是"状态已变化 ⇒ 该有限放行一次"？
     *
     * 这是解冻判据对外的**唯一查询口**（`fail()` 是记账口）：调用点（backend 的
     * `planRecoveryGate` / 熔断闸）在派发前拿它决定"拦不拦"，并把 `thawReason` 原样说给模型与审计。
     *
     * @param {string} name 工具名
     * @param {object} params 参数
     * @param {object} [o] 状态四格（stateKey / command / artifactHash / round / …）
     * @returns {{stateKey:string, lastState:string, stateChanged:boolean,
     *            thawAvailable:boolean, thawReason:string,
     *            thawsUsed:number, maxThaw:number,
     *            strategyCount:number, strategyTotal:number, hardCap:number}}
     */
    thawStateOf(name, params, o) {
      const strat = toolCallSignature(name, params, o);
      const stateKey = resolveStateKey(o, params);
      const bs = byBase.get(strat);
      const cur = byStrategy.get(retryKeyFor(strat, stateKey));
      const strategyCount = cur ? cur.count : 0;
      const strategyTotal = bs ? bs.total : strategyCount;
      const thawsUsed = bs ? bs.thaws : 0;
      const lastState = bs ? bs.lastState : stateKey;
      const stateChanged = !!(bs && bs.inited && bs.lastState !== stateKey);
      // 状态没变 ⇒ 不存在解冻（旧账照旧生效）；状态变了但次数用尽 ⇒ 也不放行（护栏③）
      const exhausted = stateChanged && thawsUsed >= maxThaw;
      const overHardCap = strategyTotal >= hardCap;
      const thawAvailable = !!(stateKey && (stateChanged || strategyCount === 0) && thawsUsed < maxThaw
        && !exhausted && !overHardCap);
      let thawReason = '';
      if (thawAvailable) {
        thawReason = stateChanged
          ? '状态已变化（' + (lastState || '（无状态证据）') + ' ⇒ ' + stateKey + '）⇒ 有限放行一次'
            + '（第 ' + (thawsUsed + 1) + '/' + maxThaw + ' 次解冻）；这一次再失败就仍按旧账拦下'
          : '当前状态下还没失败过 ⇒ 放行';
      } else if (overHardCap) {
        thawReason = '同一策略（跨状态）已累计失败 ' + strategyTotal + ' 次，达到绝对上限 '
          + hardCap + ' 次 ⇒ 不再放行';
      } else if (exhausted) {
        thawReason = '解冻次数已用尽（' + thawsUsed + '/' + maxThaw + '）：状态虽然又变了，'
          + '但这条策略已累计失败 ' + strategyTotal + ' 次 ⇒ 仍拦下';
      } else if (stateKey) {
        thawReason = '当前状态（' + stateKey + '）与上次失败时相同 ⇒ 旧账照旧生效'
          + '（已失败 ' + strategyCount + ' 次）';
      } else {
        thawReason = '调用方没有给出状态证据（产物 hash / 反馈轮次 / 命令指纹均为空）⇒ 按旧账判定，不放水';
      }
      return {
        stateKey, lastState, stateChanged,
        thawAvailable, thawReason,
        thawsUsed, maxThaw,
        strategyCount, strategyTotal, hardCap,
      };
    },
    /** 同一策略**跨状态**的累计失败次数（绝对上限按它算）。 */
    strategyTotalOf(name, params) {
      const bs = byBase.get(toolCallSignature(name, params, undefined));
      return bs ? bs.total : 0;
    },
    /** 解冻事件流水（哪条策略、因为什么状态变化、放行了几次）。 */
    thawEvents() { return thawLog.slice(); },
    /** 已解冻次数（同一策略；不传参数 ⇒ 全局累计）。 */
    thawCountOf(name, params) {
      if (name === undefined && params === undefined) return thawLog.length;
      const bs = byBase.get(toolCallSignature(name, params, undefined));
      return bs ? bs.thaws : 0;
    },
    get maxThaw() { return maxThaw; },
    get hardCap() { return hardCap; },
    /** 是否失败过（签名级）。 */
    hasFailed(name, params) {
      return failedSig.has(buildCallSignature(name, params));
    },
    get totalFailures() { return total; },
    get trackedCount() { return seen.size; },
    get trackedStrategies() { return byStrategy.size; },
    snapshot() {
      const out = {};
      for (const [k, v] of seen.entries()) out[k] = { count: v.count, lastKind: v.lastKind };
      return out;
    },
    strategySnapshot() {
      const out = {};
      for (const [k, v] of byStrategy.entries()) out[k] = { count: v.count, lastKind: v.lastKind };
      return out;
    },
    /**
     * 用磁盘上的失败账本预热本进程的账（跨请求/重启后接着算）。
     *
     * ★ 三条纪律（缺一条就会变成有害功能）：
     *   ① **不恢复 total / failedSig / seen**：它们是「本次运行」的统计口径，
     *      被上次的数据污染会让 totalFailures 之类的读数失真。只恢复 byStrategy（策略级）的 count ——
     *      seen 是逐字级签名（含参数值哈希），跨请求复用它没有意义，而策略级才是"方法"。
     *   ② **count 减 1 再落账**（`Math.max(0, n - 1)`）：环境可能已经变了（磁盘清了、依赖装好了、
     *      权限给了）。重启算一次宽容 —— 但只宽容一次，不是把账清零。
     *      所以「上次失败 2 次」重启后是 count=1 ⇒ 允许再试 1 次 ⇒ 再失败就 count=2 立刻拦住。
     *   ③ **不接受没有 sig 的条目**：宁可少恢复，不许恢复出一条算不出 key 的账。
     *   ④ ★ 2026-02-16：**refuted 必须在"读"的这一刻重新判一次**（证据 / 适用范围 / 代码版本）。
     *      `refutedCodeVersion` 与**此刻磁盘上同路径文件的 sha1**对不上 ⇒ 降级为 `stale`：
     *      **不跳过、允许重试**，并留一条 `refutedStale` 事件（点名哪个文件变了、旧 sha1、新 sha1）。
     *      旧格式记录（无版本）或 `refutedScope.files` 为空，同样按 stale —— 拿不出"代码没变"的证据，
     *      就不许把它当禁令（否则旧账本里那些无版本的 refuted 会永远吃老本，正是本次要根治的病）。
     *
     * @param {Array<{sig:string, tool?:string, paramKeys?:string[], mode?:string,
     *                count:number, lastKind?:string, refuted?:boolean,
     *                refutedEvidence?:object, refutedScope?:object, refutedCodeVersion?:object,
     *                nextAction?:string, lastError?:string, at?:number}>} attempts
     * @param {{now?:number, root?:string, readFile?:(abs:string)=>any}} [opts]
     *        `root`/`readFile` 只给门禁与沙箱用（生产环境走真实 fs）
     * @returns {{seeded:number, skipped:number, stale:number}}
     *          seeded=真的落了账的条数，skipped=没恢复的条数，stale=被判"需重试"的 refuted 条数
     */
    seed(attempts, opts) {
      const so = (opts && typeof opts === 'object') ? opts : {};
      if (!Array.isArray(attempts)) return { seeded: 0, skipped: 0, stale: 0 };
      let seeded = 0;
      let skipped = 0;
      let stale = 0;
      for (const a of attempts) {
        // 纪律③：算不出策略 key 的条目一律不收 —— 宁可少恢复，不许恢复出一条查不到的账。
        if (!a || typeof a !== 'object' || Array.isArray(a)) { skipped += 1; continue; }
        const sig = (typeof a.sig === 'string') ? a.sig.trim() : '';
        if (!sig) { skipped += 1; continue; }
        /**
         * ★ 纪律④：三态判定（这一步就是"读 refuted"的唯一时刻）。
         *   判成 stale ⇒ 记事件、计数；`seededMeta` 里存**原文**，读的时候再判一次
         *   （见 `seededOf`）—— 一次运行可能很长，代码在运行中也可能被改。
         */
        const proj = refuteScope.projectRefute(a, { root: so.root, readFile: so.readFile });
        if (proj.stale) {
          stale += 1;
          refuteStaleEvents.push(refuteScope.makeStaleEvent(
            a,
            { reasons: proj.reasons, changedFiles: proj.changedFiles },
            Number(so.now) > 0 ? Number(so.now) : Date.now(),
          ));
        }
        // 元信息先记：即使这次额度恰好用尽（减 1 后为 0），也仍要能说清"上次这条路为什么坏"。
        seededMeta.set(sig, {
          refuted: a.refuted === true,
          refutedAt: Number(a.refutedAt) > 0 ? Number(a.refutedAt) : (Number(a.at) || 0),
          refutedEvidence: (a.refutedEvidence && typeof a.refutedEvidence === 'object') ? a.refutedEvidence : null,
          refutedScope: (a.refutedScope && typeof a.refutedScope === 'object') ? a.refutedScope : null,
          refutedCodeVersion: (a.refutedCodeVersion && typeof a.refutedCodeVersion === 'object') ? a.refutedCodeVersion : null,
          nextAction: String(a.nextAction || '').slice(0, 200),
          lastError: String(a.lastError || '').slice(0, 300),
          at: Number(a.at) || 0,
          /**
           * ★ 2026-11-03：**未经宽容打折**的历史失败次数（磁盘上记的是几就是几）。
           * 为什么要单独存一份：纪律②会把 count 减 1 再落账（那是"还允许试几次"的额度口径），
           * 而交接单要回答的是另一个问题 ——「上任在这条路上到底撞了几次」。
           * 用打折后的额度去讲历史，会把"上次撞了 2 次"说成 1 次，
           * 于是交接单的「反复失败」判据（count >= 2）永远不成立 ⇒ 整份交接单静默不出。
           * 两个口径服务的对象不同，不能共用同一个数。
           */
          histCount: Math.max(0, Math.floor(Number(a.count) || 0)),
          /**
           * ★ 2026-02-16（第三轮）：**磁盘上那次失败属于哪一类**也一起存下来。
           * 为什么：`seededList()` 原来把 `lastKind` 从 `byStrategy.get(sig)` 取，
           * 而推不出状态指纹的工具（`file-write` / 无 command 的 `shell-exec`）本次 `fail()`
           * 写的就是**同一个桶** ⇒ 预热那一行的"失败类别"会被念成**这一轮**的类别。
           * 交接单里一行一个来源，类别也必须是那一行的来源的。
           * 磁盘上没有类别（老记录）⇒ 留空串，读的时候再退回桶里的值（见 seededList）。
           */
          lastKind: String(a.lastKind || ''),
        });
        // 纪律②：只宽容一次 —— 减 1 后为 0 就等于"这一条不恢复"。
        const count = Math.max(0, Math.floor(Number(a.count) || 0) - 1);
        if (count <= 0) { skipped += 1; continue; }
        const prev = byStrategy.get(sig);
        // 同一次运行里 seed 之后又 fail 过 ⇒ 取已知的更大值，别把已经涨上去的账改小。
        const next = prev ? Math.max(prev.count, count) : count;
        byStrategy.set(sig, {
          count: next,
          kinds: prev ? prev.kinds : {},
          lastKind: a.lastKind || (prev && prev.lastKind) || KIND.UNKNOWN,
        });
        // ★ 2026-02-16：跨状态总账也要预热 —— 否则"上次的账"不进绝对上限，
        //   跨请求重启一次就能再续一杯，永远到不了头。
        //   `lastState` 刻意留空字符串：磁盘账本里没有当时的产物/轮次证据 ⇒ 视为"无状态证据"，
        //   于是本次运行**第一次**带状态指纹的失败会被判成「状态已变化」⇒ 放行一次
        //   —— 与纪律②"重启宽容一次"同形，不重复给额度。
        const bPrev = byBase.get(sig);
        if (!bPrev) {
          byBase.set(sig, {
            total: next, thaws: 0, lastState: '', inited: true, states: new Set(['']), thawLog: [],
          });
        } else {
          bPrev.total = Math.max(bPrev.total, next);
          bPrev.inited = true;
        }
        // 纪律①：seen / failedSig / total 一律不动（它们是"本次运行"的口径）。
        seeded += 1;
      }
      return { seeded, skipped, stale };
    },
    /**
     * 这条策略在**上一次运行**里留下了什么 —— 用来在拦住它的时候说清"上次为什么坏"。
     *
     * ★ 2026-02-16：`refuted` 在这里是**重新判过**的结论，不是磁盘上的布尔值：
     *   · `refuted === true`  ⇒ 代码没变、证据齐全 ⇒ 这个否定结论仍然成立；
     *   · `stale === true`    ⇒ 代码变了 / 拿不出版本或范围 ⇒ **降级，允许重试**；
     *   · 两者都 false 且 `refuteState === 'none'` ⇒ 上次压根没判过证伪。
     *   ★ `refuted` 与 `stale` **互斥**，且 stale 时 `refuted` 必为 false ——
     *     这是为了让 `backend.js` 的 `seededRefuted: !!(seeded && seeded.refuted)` 在 stale 时自然算 false，
     *     旧字段名保持存在，调用点一个字都不用改。
     *
     * @returns {{refuted:boolean, stale:boolean, refuteState:'refuted'|'stale'|'none',
     *            staleReasons:Array, changedFiles:Array,
     *            refutedEvidence:(object|null), refutedScope:(object|null),
     *            refutedCodeVersion:(object|null),
     *            nextAction:string, lastError:string}|null} 没预热过 ⇒ null
     */
    seededOf(name, params, o) {
      const m = seededMeta.get(toolCallSignature(name, params, o));
      if (!m) return null;
      const p = refuteScope.projectRefute(m, {});
      return {
        refuted: p.refuted,
        stale: p.stale,
        refuteState: p.state,
        staleReasons: p.reasons,
        changedFiles: p.changedFiles,
        refutedEvidence: p.refutedEvidence,
        refutedScope: p.refutedScope,
        refutedCodeVersion: p.refutedCodeVersion,
        nextAction: m.nextAction,
        lastError: m.lastError,
      };
    },
    /**
     * 预热进来的**全部**交接候选（不是按签名去问某一条，而是"上次一共撞了哪些墙"）。
     *
     * ★ 为什么在这里而不是让调用方去翻 `seed()` 的参数：`refuted` 必须在**读的这一刻**重判
     *   （见 `seed` 纪律④与 `seededOf`）—— 磁盘上写着 refuted=true 不代表此刻还有效，
     *   代码版本一变旧禁令就作废。调用方自己翻参数就绕过了这道投影，会把过期禁令当成铁律。
     *   所以投影只有一处（`refuteScope.projectRefute`），本方法只是把它套到每一条上。
     *
     * @returns {Array<{sig:string, tool:string, count:number, histCount:number, lastKind:string,
     *                  refuted:boolean, stale:boolean, refuteState:string,
     *                  lastError:string, nextAction:string}>}
     */
    seededList() {
      const out = [];
      for (const [sig, m] of seededMeta.entries()) {
        const p = refuteScope.projectRefute(m, {});
        const bs = byStrategy.get(sig);
        /**
         * ★★ 这一行的数字**只取磁盘事实**（`m.histCount`），一个都不许从 `byStrategy` 借。
         *
         * 复验方第三轮实测：推不出状态指纹的工具（`file-write` / 无 command 的 `shell-exec`）
         * 本次 `fail()` 落的桶键**就是预热基键** ⇒ 桶里的 `count` 混着"本次又失败了几次"：
         *   磁盘历史 5 次 ⇒ 额度 4 进桶，本次再失败 2 次 ⇒ 桶里 6。
         * 这里若从桶里借（`count` / `histCount` / `total` 三个字段原来都借），
         * 预排行就会念出一个"上次 5 次 + 本次 2 次"的和 —— 那是两个来源的数，不属于任何一行。
         */
        const hist = Math.max(0, Math.floor(Number(m.histCount) || 0));
        out.push({
          sig,
          tool: String(sig.split('|')[0] || ''),
          // 三个数字**同一个口径**：磁盘上这条签名记了几次（累计、不分状态）。
          // 交接单讲事实，念的就是它。额度另放 `quota`，谁也不许拿额度讲历史。
          count: hist,
          histCount: hist,
          total: hist,
          /**
           * ★ 额度口径单独放：`byStrategy` 里"还允许试几次"（预热时已被纪律②减 1，
           *   之后还会被本次的失败和"状态变化解冻"改动）。**不参与正文**，只供审计与调用方参考。
           */
          quota: bs ? Number(bs.count) || 0 : 0,
          /**
           * ★★ 2026-02-16（复验方实测出的**生产最常见**那句假话）：**磁盘账给不出"同一状态"**。
           *
           * 实测形态：`seededList()` 给出 `count=2 / histCount=3 / total=3`，而交接单正文写成
           *   「shell-exec **同一状态下**已失败 3 次（execution_error）」
           * —— 那 3 次是**跨状态累计**。磁盘账本按**签名**累加，键里**没有状态指纹**
           * （状态指纹是 `sig#stateKey`，只活在本次运行的 `byStrategy` 里），
           * 于是"同一状态撞了几次"这个维度在预热账上**根本不存在**，写出来就是编的。
           *
           * 为什么必须在这里标（而不是让交接单去猜）：只有账本知道"我这个数字是怎么数出来的"。
           * ⇒ `stateKnown:false` = 「我数的是累计，不是同一个状态」，
           *   交接单据此改口成「累计失败 N 次（跨请求账，无状态指纹）」，
           *   **不许**再写"同一状态下"。
           * 缺省方向是**保守**：不知道就不许声称（见 handoffBrief 里的取值口径）。
           */
          stateKnown: false,
          /**
           * ★ 失败**类别**优先取磁盘上那一行记的（`seed()` 存进 `seededMeta.lastKind`）。
           * 退到桶里只在"磁盘老记录没记类别"时发生 —— 而那时桶里的值可能就是**这一轮**的类别，
           * 于是预排行会顶着本次的类别念上次的次数（一行两个来源）。见 seed() 里 lastKind 的注释。
           */
          lastKind: String(m.lastKind || '') || (bs && bs.lastKind) || KIND.UNKNOWN,
          /**
           * ★★ **来源必须由账本自己标**，不许指望调用方记得标。
           *   复验方第三轮实测的形态：调用方直接拿 `seededList()` 的条目去建交接单时没有 `from`，
           *   交接单只能落进"其余"那一支 ⇒ 磁盘账被说成「来源未标注」（第三句假话，比前两句更糟：
           *   前两句至少说了个具体的错来源，这句连来源都没了）。
           *   ⇒ 谁数的这条账，谁在这里写清楚。`handoffList()` 因此只要拼接，不用再加工。
           */
          from: 'seeded',
          refuted: p.refuted,
          /**
           * ★★ 2026-02-16（交接单「适用范围」）：这条否定结论**是从哪来的**。
           *   seeded = 磁盘跨请求旧账（`refuteScope.projectRefute` 重新判过的三态结论）
           *   ⇒ 正文据此写「历史请求里验证不通」，让替补知道这条禁令的**边界**：
           *     它属于上一次运行的世界，条件真的变了（代码/参数/环境）就该说明依据再试，
           *     而不是被一条无日期的旧结论永久封路（老板批过的那个病）。
           *   ⚠️ 与 `refuted` 分开：`refuted` 是结论，`refuteScope` 是**结论的适用范围**，
           *     两者都不许由调用方猜（谁数的这条账，谁标）。
           */
          refuteScope: 'disk',
          stale: p.stale,
          refuteState: p.state,
          lastError: m.lastError,
          nextAction: m.nextAction,
        });
      }
      return out;
    },
    /**
     * **本次运行内**失败过的策略（不是磁盘预热进来的那些），与 `seededList()` 同一投影形状。
     *
     * ★★ 2026-02-16 为什么必须有它（独立验收实测出的空转）：
     *   交接单原本只吃 `seededList()`，而 `seededMeta` 只在 `seed()` 里写、
     *   `seed()` 只在工作流`attempts()`（PPT 类）有内容时才被调用 ⇒ **一般任务 wfCtl=null** ⇒
     *   `seededList()` 恒为空 ⇒ 交接单恒为「0 字 / 禁令 0 条」⇒
     *   老板那句「替补必须知道前任尝试过什么」在**多数任务上根本没兑现**。
     *   ⇒ 补上"这一轮 live 失败账"这一路。
     *
     * ★ 三条纪律：
     *   ① **仍然是账本这一个真源**：数据只从本模块的 `liveBuckets`/`liveCounts`/`byStrategy` 取，
     *      调用方（backend）**不许**自己统计"哪些失败了"（那是第二套失败判定真源）；
     *   ② **不与预热账合并**：`seededMeta` 里有的那条，本方法照旧照实出（本次失败就是本次的事实），
     *      由 `handoffList()` **并排**给出两条 —— 一条 seeded（磁盘累计 + 上次的错误文本），
     *      一条 live（本次的次数），各自带自己的 `from`。
     *      🔴 2026-02-16 第三轮实测：之前这里是"按 base 跳过 + 由 handoffList 覆盖成一个数"，
     *      结果是**一行里挤了三个来源**（次数取本次、错误文本取上次），念出来没人知道那个 N 是谁的；
     *      现在不合并，就不会再出现"谁的数"这个问题（见 handoffList 头注）。
     *   ③ 键里带**状态指纹**（`sig#stateKey`）⇒ 这里按 `#` 前的基础签名合并，
     *      否则"同一条路在不同状态下各失败一次"会在交接单里变成好几条，把真正的重点冲淡。
     *
     * @returns {Array<{sig:string, tool:string, count:number, histCount:number, total:number,
     *                  repeated:boolean, lastKind:string,
     *                  refuted:boolean, stale:boolean, refuteState:string,
     *                  lastError:string, nextAction:string, from:'live'}>}
     */
    liveList() {
      const acc = new Map();  // 基础签名 -> { count(单桶最大), total(跨状态合计), lastKind, hasState }
      for (const [key, v] of byStrategy.entries()) {
        const full = String(key || '');
        const base = full.split('#')[0];
        if (!base) continue;
        /**
         * 🔴 **这里原来有一行 `if (seededMeta.has(base) || seededMeta.has(full)) continue;`，
         *    已换成"只认 fail() 写过的桶"** —— 那一行是复验方实测出的 P1：
         *    「预热过、本轮又继续失败」的策略会从**两个出口同时消失**。
         *
         * 机制（不是猜的，实测复现）：
         *   · 本方法按 **base** 跳过 ⇒ 只要预热里有这个 base，本次的失败桶整条被丢掉；
         *   · `seededList()` 只读 `seededMeta` 那份**旧快照**，且 `count` 取
         *     `byStrategy.get(确切基键)` —— 本次桶键是 `sig#stateKey` ⇒ 取不到 ⇒ count=0。
         *   ⇒ 预热 1 次 + 本次 2 次：liveList=[] / handoffList 只有一条 count=0 的旧账
         *     ⇒ `repeated=false`、无禁令 ⇒ **brief=null，该交接的时候完全不交接**。
         *   而"预热过又继续失败"恰恰是最该交接的那一类。
         *
         * 现在按**事实**过滤（`liveBuckets` = fail() 写过的桶），既不再误伤本次的失败，
         * 也不会把 `seed()` 预热进来的额度桶冒充成"本次失败"。
         * ⚠️ 并集**不合并**（第三轮）：`handoffList()` 只是把 seeded / live 两批拼在一起，
         *    各带各的 `from` 与各自的数字 —— 合成一个 N 的那一版刚被复验方实测推翻（见 R22）。
         */
        if (!liveBuckets.has(full)) continue;
        /**
         * ★★ 次数**只从 `liveCounts` 取**，不从桶 `v.count` 取：
         *   推不出状态指纹的工具（`file-write` / 无 command 的 `shell-exec`）桶键与预热基键**同键**，
         *   桶里的 `count` 混着"预热额度"（见 liveCounts 头注：磁盘 5 次 + 本次 2 次 ⇒ 桶里 6）。
         *   本方法回答的是"**本次运行**失败了几次"，所以只认 fail() 那本账。
         */
        const cn = Number(liveCounts.get(full)) || 0;
        if (cn <= 0) continue;
        const cur = acc.get(base) || { count: 0, total: 0, lastKind: KIND.UNKNOWN, hasState: false, escalated: false };
        // ★★ 「账本这次判过 escalate」也要按 base 合并（一个 base 下任一状态桶被判过 ⇒ 这条策略本次已到换方案阈值）。
        if (liveEscalated.has(full)) cur.escalated = true;
        // ★★ 两个维度**分开记**（2026-02-16 独立验收实测出的口径缺陷）：
        //   原来这里把各状态桶的 count 加成一个数，正文就写"已失败 2 次" ——
        //   而账本执法（`escalate = sc.count >= maxSameMethod`）用的**是单桶**。
        //   生产里 `shell-exec` 换个命令就算换状态 ⇒ 3 条不同命令各失败 1 次 ⇒
        //   正文"已失败 3 次"，账本那边其实每一条都只失败 1 次。两个维度两句话，正文一个字没标。
        //     · count = 该策略**单个状态桶**里的最大次数（"同一状态下最多连续失败几次"）
        //     · total = **跨状态**合计（"合计撞了几次"）
        cur.total += cn;
        if (cn > cur.count) cur.count = cn;
        // ★★ 状态维度**不能恒为 true**（复验方 P2，实测）：只有桶键里真的带 `#` 才算"有状态指纹"。
        //   生产真实调用形态是 3 参 `fail(name, params, kind)`，写入类工具只带 `{path}` ⇒
        //   `buildStateKey()` 返回空串 ⇒ 桶键就是 `file-write|path|-`（**没有 `#`**，压根没有状态维度）。
        //   此前这里写死 `stateKnown: true`，于是正文对 `file-write` 也声称"同一状态下已失败 2 次" ——
        //   按本仓自己立的规矩（"不知道就不许声称"），这正是"不知道却声称"。
        if (full.indexOf('#') > 0) cur.hasState = true;
        cur.lastKind = (v && v.lastKind) || cur.lastKind;
        acc.set(base, cur);
      }
      const out = [];
      for (const [sig, m] of acc.entries()) {
        /**
         * ★★ 2026-02-16（交接单红线一）：`refuted` **按事实判**，不再写死 false。
         *
         * 判据（两个，任一成立即"本次运行已验证不通"）：
         *   ① 本次运行里该策略**单个状态桶**失败 ≥ 2 次（`m.count`，与账本 escalate 同一维度）；
         *   ② 账本在本次运行中对该策略**真的返回过** `escalate === true`（`m.escalated`，
         *      见 `liveEscalated` 头注 —— 它可能是被预热额度推到阈值的，所以单独算一条）。
         * ⚠️ `m.total`（跨状态合计）**不参与**：两个状态各失败 1 次不等于"这条方法不通"，
         *   把它算进来会让"换个命令再试"这种正常探索被写进永久禁令。
         */
        const refutedNow = m.count >= 2 || m.escalated === true;
        out.push({
          sig,
          tool: String(sig.split('|')[0] || ''),
          count: m.count,
          histCount: m.count,
          total: m.total,
          // ★ 「要不要交接」只看 **count（同一状态桶）**：与账本的 escalate 同一个维度，
          //   否则会出现"账本说这条路还能试、交接单说它反复失败"的两套口径。
          repeated: m.count >= 2,
          lastKind: m.lastKind,
          /**
           * ★★ 与磁盘预热账的 `refuted` **同一个字段、不同来源**：这里 True 的含义是
           *   "**本次运行**已证明这条方法走不通"（scope='this-run'），不是磁盘三态判定。
           *   交接单据此把它写进「不要再用」，并标出适用范围的边界（见 handoffBrief 的正文）。
           */
          refuted: refutedNow,
          /** 这条否定结论的**适用范围**：本次运行（`disk` 只出现在 seededList）。 */
          refuteScope: refutedNow ? 'this-run' : '',
          stale: false,
          refuteState: 'live',
          lastError: '',
          nextAction: '',
          from: 'live',
          // ★ 由**桶键事实**推出，不是写死的常量：带 `#` 才是"同一状态桶"。
          stateKnown: m.hasState === true,
        });
      }
      return out;
    },
    /**
     * 交接单要用的**全部**失败账：跨请求预热账 + 本次运行内失败账（**唯一出口**）。
     *
     * 为什么把并集放在账本里、而不是让调用方拼两个数组：
     *   拼法一旦散落在调用方，就会出现"某处只拼了一半"的形态（这正是要修的那个 bug：
     *   只喂 seeded ⇒ 一般任务交接单恒空）。放在这里，接的人只有一个入口。
     *
     * ★★★ 2026-02-16 第三轮（复验方实测）：**并排给出，不合并、不覆盖。**
     *
     * 三轮修的都是同一句话，直到把它拆开才停：
     *   · 第一轮：`seeded.concat(live)` + `liveList()` 按 base 跳过 ⇒ 「预热过 + 本轮继续失败」
     *     会从两个出口同时消失 ⇒ **该交接时 brief=null**。
     *   · 第二轮：改成"按 base 合并、live 优先"（`count/histCount/repeated` 全取 live）⇒
     *     洞补上了，但**把相邻一格踩塌了**：本次只失败 1 次就把"预热 3 次"抹平成 1 次
     *     ⇒ `repeated=false` ⇒ 又是 **brief=null**（生产里 `refuted` 恒 false ⇒
     *     `forbidden/outOfReach` 恒空 ⇒ `repeated` 是**唯一**出单路径）。
     *   · 而合并出来的那一行本身也读不通：「次数取本次、错误文本取上次」，一行三个来源，
     *     盘上那个 5 次只剩在 `priorCount` 里、正文一个字没有。
     *
     * ⇒ 根子不是"哪一格算法错"，是**把两个来源的数字挤进一个 N**。所以这里不合并：
     *   `seededList()` 每条出**一行**（`from:'seeded'`，数字 = 磁盘累计，带上次错误文本），
     *   `liveList()` 每条出**一行**（`from:'live'`，数字 = 本次运行次数，不带上次文本）。
     *   同一条策略两次都失败 ⇒ 交接单里**两行**：宁可多一行，也不要一个数说不清是谁的。
     *   顺带解决的：`repeated` 由每一行自己的数字算，预热 3 次不会被本次 1 次抹平；
     *   `priorCount` 这种"留给审计但正文不念"的字段也就不需要了（它在正文里）。
     *
     * @returns {Array<object>} 每条形如 `seededList()` 的条目；`from` **只有两个取值**：
     *                          'seeded'（磁盘跨请求预热账）| 'live'（本次运行账）——
     *                          由两个 `*List()` **各自**标好，本方法只负责拼接、不做加工
     *                          （少一道"调用方记得标"的手工步骤，就少一种说不清来源的可能）。
     *                          seeded 行在前：它带"上次为什么坏"，信息量更大。
     */
    handoffList() {
      return this.seededList().concat(this.liveList());
    },
    /** 预热时被判成 stale 的事件（"这条旧禁令已经作废"）—— 供调用方/门禁取证。 */
    refuteEvents() { return refuteStaleEvents.slice(); },
    /** 预热时被判成 stale 的条数（stale 必须能单独数出来，既不算 refuted 也不算"正常"）。 */
    get staleCount() { return refuteStaleEvents.length; },
    get seededCount() { return seededMeta.size; },
  };
}

// ============================ 4) 处方文案 ============================
/**
 * 按**错误类型**给出路。这是"从失败中恢复"的可执行部分：
 * 不同类型给的动作必须不同，否则模型没有可执行的信息，只能原地重试。
 * @param {{kind:string, skill:string, missing?:string[], escalate?:boolean, count?:number, salvageHint?:string}} o
 */
function recoveryDirective(o) {
  const kind = o && o.kind ? o.kind : KIND.UNKNOWN;
  const skill = (o && o.skill) || '这个技能';
  const missing = (o && o.missing) || [];
  const L = [];
  L.push('【工具调用失败 · ' + kindLabel(kind) + '】');
  L.push('· **这不等于任务失败**：只是"这一次调用"没成。别把这句话当结论汇报给用户，也别原地重发同一个调用。');

  if (kind === KIND.ARGS_TRUNCATED) {
    L.push('· 真因：你这次给出的参数**内容太长，生成到一半被输出上限截断**了（参数不是漏写，是没写完）。');
    L.push('· 所以**原样重试一定会再被截一次**。必须改变"一次写多少"：');
    L.push('  1) 把这次要写的内容**砍到最小可用版本**先落地（能跑起来就行，细节后面再补）；');
    L.push('  2) 剩下的部分**分多次追加**写进同一个文件（写文件时加 "mode":"append"，每次只写一段），不要试图一次写完；');
    L.push('  3) 也可以改成**多条更小的文件**，而不是一个巨大的文件。');
    if (o && o.salvageHint) L.push('· ' + o.salvageHint);
  } else if (kind === KIND.ARGS_MISSING) {
    L.push('· 真因：这次调用**确实少给了参数**' + (missing.length ? '（缺：' + missing.join('、') + '）' : '') + '。');
    L.push('· 把缺的补上再调；如果这个值你拿不到，就先换一条路把它取到，不要空着重发。');
  } else if (kind === KIND.ARGS_INVALID) {
    L.push('· 真因：参数给了但**格式/取值不合法**。照报错把这一项改对再调。');
  } else if (kind === KIND.PATH_ERROR) {
    L.push('· 真因：**路径本身不对**（文件/目录不存在，或写到了工作区之外）。改参数格式没用，得改路径。');
    L.push('· 正确做法：**先去看真实的目录结构**（列目录 / 找项目入口和路由），确认真实位置之后再写。');
    L.push('· ⚠️ 不要凭"应该有这个目录"去猜；也不要因为路径一次没对上就断定"这个项目改不了"。');
    L.push('· 🔴 同一个任务里如果还有**其它同名/同类的路径**，一并核对 —— 只改错的那一个、漏掉其它，任务仍然没完成。');
  } else if (kind === KIND.PERMISSION_ERROR) {
    L.push('· 真因：**权限不足**（目标位置不可写 / 需要更高权限）。这不是参数问题。');
    L.push('· 正确做法：① 换一个**可写的位置**（先写到你能写的地方，再想办法搬运）；② 或换执行方式（用有权限的那个通道去做）；');
    L.push('  ③ 确实绕不开时才请用户授权**一次**，并说清楚"需要授权什么、授权之后我能继续做什么"。');
    L.push('· ⚠️ 原样重试一定还是同样的权限错误，不要重发。');
  } else if (kind === KIND.EXECUTION_ERROR) {
    L.push('· 真因：**执行方式本身出了问题**（同一条命令/同一种调用形态在这台机器上走不通）。');
    L.push('· 正确做法：**换执行方式** —— 换工具、换命令形态、把一个大动作拆成几个小步骤分别执行。');
    L.push('· ⚠️ 重发同一条命令不算换方式。');
  } else if (kind === KIND.ENVIRONMENT_ERROR) {
    L.push('· 真因：**本机环境缺东西**（命令不存在 / 端口被占 / 依赖没装）。改参数不会好。');
    L.push('· 正确做法：**换一条不依赖这个环境条件的路**把任务做下去（换工具、换端口、换实现方式）。');
    L.push('· 如果确实只有这条路能走，就直接告诉用户"需要先装/先开 X"，并把**不依赖它**的那部分先做完。');
  } else if (kind === KIND.VERIFICATION_ERROR) {
    L.push('· ★ 真因待定：**是"验证工具"自己出了问题**（浏览器起不来 / 连接不上 / 截图失败 / 测试脚本自身报错），**不等于产品坏了**。');
    L.push('· 现在最要紧的是**分诊**：先换一种方式复核（换验证手段、换端口、重跑一次、或换用命令行方式检查）。');
    L.push('· 🔴 **禁止**把验证工具的问题报成产品问题（那会让别人去改不存在的东西）；也**禁止**因为"验证没跑成"就宣布完成或宣布任务失败。');
    L.push('· 分诊结论只有三种：① 只是工具问题 ⇒ 换工具重新验证；② 产品确实有问题 ⇒ 修产品；③ 还是分不清 ⇒ 如实说明"验证手段不可用，结论未确认"。');
  } else if (kind === KIND.PRECONDITION) {
    L.push('· 真因：**前置条件没满足**（多半是账号/连接没配好）。改参数或重试都不会好。');
    L.push('· 正确做法：**换一条不需要这个前置条件的路**把任务做下去；如果确实绕不开，就直接告诉用户"需要先在设置里连上 X"，并把你能做的那部分先做完。');
  } else if (kind === KIND.TIMEOUT) {
    L.push('· 真因：这次执行**超时**了。原样重试只会再等一遍。');
    L.push('· 正确做法：把任务**拆小**（少处理一点、分多步），或者换一个更轻的做法。');
  } else if (kind === KIND.EMPTY_OUTPUT) {
    // 空结果不是"报错"，所以**不能**套用上面任何一条"照报错改参数"的处方 ——
    // 它的问题是"没有报错、也没有产出"，模型的自然反应会是"那大概成了吧"或"原样再发一次"，
    // 这两个都错：前者把"没产出"当结果，后者在同一个坑里再摔一次。
    L.push('· 真因：这次调用**什么都没返回**（既没有报错、也没有产出）。这不代表它成功了。');
    L.push('· 先确认它到底有没有做成 —— 去**看真实产物在不在**（列目录 / 读回文件 / 查状态），不要靠感觉。');
    L.push('· 若产物确实不在，**不要原样重发同一个调用**：换一种能回显结果的做法（换工具、加输出、把动作拆小重做一次）。');
  } else if (kind === KIND.ABORTED) {
    L.push('· 这是**用户主动叫停**的，不是失败。停下来汇报当前进度即可，不要重试。');
  } else if (kind === KIND.UPSTREAM) {
    L.push('· 真因：上游/网络问题，多半与你给的参数无关。');
    L.push('· 换一条等价的路（换接口/换技能）继续；实在不行就如实说明是外部服务的问题。');
  } else {
    L.push('· 先看报错本身；如果它与你给的参数无关，就**换一种做法**达到同样目的。');
  }
  // ★ 处方表兜底：任何一类（含以后新增、上面忘了写分支的）都至少拿到**这一类该走的方向**。
  //   这条让 KIND_PLAYBOOK 真正进入模型看到的文本，而不是一个没人读的常量。
  L.push('· 这一类失败的**标准出路**：' + kindPlaybook(kind) + '。');

  if (o && o.escalate) {
    L.push('· ⚠️ **同一策略（同一个工具 + 同一组参数 + 同一执行模式）已经失败 '
      + (o.strategyCount || o.count || 2) + ' 次了。禁止再重复它。**');
    if (o.sameStrategy) {
      L.push('· 特别提醒：你**改过参数内容，但做法没变** —— 这叫换汤不换药，在同一个失败上它一定会再失败一次'
        + '（典型：把一个几万字节的文件"砍短一点"再发一遍）。');
      L.push('· 真正算换了方法的是**换执行方式**：写文件改用 "mode":"append" 分次追加 / 换一个工具（如 shell-exec 调 node 脚本写）/ 把一个大文件拆成几个小文件。');
    }
    L.push('· 现在必须换方案：换一个技能 / 换一条链路 / 换一种产出形式。换完在回复里说明你换了什么、为什么。');
  } else {
    L.push('· 同一处**最多再试 1 次**；再失败就必须换方法，不要在同一个失败上原地打转。');
  }
  L.push('· 只有在**所有可行路径都试过**之后才允许下"做不到"的结论，且必须说明你试过哪几条路、各自为什么不行。');
  return L.join('\n');
}

// ============================ 5) 完成前验证 ============================
/**
 * 收尾前的产物验证：成果卡里列的文件，真的存在吗？是空的吗？
 * 为什么必须有这一步：模型完全可能"说做完了"却没落地（本仓已有「防嘴炮兜底」），
 * 也可能写了个 0 字节文件。**验证通过才允许收尾**，失败就打回去修。
 * @param {Array<{path:string,name?:string}>} items
 * @param {{fsModule?:object, maxCheck?:number}} [opts] fsModule 便于单测注入
 * @returns {{checked:number, ok:boolean, missing:string[], unreadable:string[], empty:string[], oversized:string[]}}
 *
 * ★ 规范 §23「不要把验证工具的问题误报成产品问题」在本函数里的落点：
 *   「文件不存在（ENOENT）」与「**读不到**（EACCES/EPERM/EIO/…）」是**两件完全不同的事** ——
 *   前者是产品真没做出来，后者是**验证这一侧**出的问题（文件可能好好的）。
 *   旧实现把两者一起塞进 missing ⇒ 会把"读不到"报成"根本没生成出来"，让人去改不存在的东西。
 *   所以单独分出 unreadable：它**同样不通过验证**（无法确认就不许说完成），但说法必须不同。
 */
function verifyDeliverables(items, opts) {
  const fsm = (opts && opts.fsModule) || fs;
  const maxCheck = (opts && Number(opts.maxCheck)) > 0 ? Number(opts.maxCheck) : 50;
  const list = Array.isArray(items) ? items.slice(0, maxCheck) : [];
  const missing = [], unreadable = [], empty = [], oversized = [];
  let checked = 0;
  for (const it of list) {
    const p = it && it.path;
    if (!p) continue;
    checked += 1;
    let st = null;
    try {
      st = fsm.statSync(p);
    } catch (e) {
      // 分诊：ENOENT = 真的没有这个文件；其余（EACCES/EPERM/EIO/EBUSY…）= 验证侧读不到。
      const code = (e && e.code) || '';
      if (code === 'ENOENT' || code === 'ENOTDIR') missing.push(p);
      else unreadable.push(p + '（' + (code || '读取失败') + '）');
      continue;
    }
    if (!st.isFile()) { missing.push(p); continue; }
    if (st.size === 0) { empty.push(p); continue; }
    // 半截文件特征：声明是 HTML 但看不到收尾标签 ⇒ 极可能是被截断写进去的
    if (/\.(html?|htm)$/i.test(p) && st.size > 0) {
      let head = '';
      try {
        const fd = fsm.openSync(p, 'r');
        const buf = Buffer.alloc(Math.min(st.size, 65536));
        fsm.readSync(fd, buf, 0, buf.length, 0);
        fsm.closeSync(fd);
        head = buf.toString('utf8').toLowerCase();
      } catch { /* 读不到就不判 */ }
      if (head && !/<\/html>/.test(head) && st.size < 65536) oversized.push(p);
    }
  }
  return {
    checked,
    // ⚠️ unreadable 也必须让 ok=false：**无法确认 ≠ 通过**（不许因为"读不到"就默认它没问题）
    ok: checked > 0 && missing.length === 0 && unreadable.length === 0 && empty.length === 0 && oversized.length === 0,
    missing, unreadable, empty, oversized,
  };
}

/** 验证不通过时打回给模型的指令（必须具体到"哪个文件、什么问题"）。 */
function verificationDirective(v) {
  const L = [];
  L.push('【收尾前自检未通过】你说的成果有文件没真正落地，**先别结束**：');
  if (v.missing.length) L.push('· 这些路径**根本不存在**：' + v.missing.join('、'));
  if (v.unreadable && v.unreadable.length) {
    // §23：这是验证侧的问题，不能断言文件没生成
    L.push('· 这些文件**存在但读不到**（' + v.unreadable.join('、') + '）—— 这可能是**读取/权限**的问题，');
    L.push('  不等于"没生成"。请换一种方式确认（换读取方式 / 换目录 / 用命令查看文件大小），确认之后再收尾。');
  }
  if (v.empty.length) L.push('· 这些文件是**空的（0 字节）**：' + v.empty.join('、'));
  if (v.oversized.length) L.push('· 这些文件**内容不完整**（看起来是被截断的半截文件）：' + v.oversized.join('、'));
  L.push('· 请现在补齐/重写它们。如果是"一次写太长被截断"，就改用**分次追加**（写文件时加 "mode":"append"）把它补完。');
  L.push('· 补完再看一眼文件确实有内容、能打开，然后才结束并汇报。');
  return L.join('\n');
}

/**
 * 收尾时给**用户**看的诚实状态报告（注意：不是给模型看的打回指令，口吻与用途都不同）。
 *
 * 为什么必须有：收尾前的自检**只允许补一轮**，补完就不再验证了。于是「第二次仍然没修好」
 * 会一路走到收尾，把残缺文件当成果发出去、界面还显示「完成」——这正是老板规范里禁掉的
 * 「**文件写出来了所以完成**」。所以收尾时必须再静默核一次（只读、不再打回），坏就明说坏在哪。
 *
 * 可信出口只有两个：COMPLETE（产物存在 + 验证通过）/ BLOCKED（已试过恢复、确实没做出来）。
 */
function honestStatusReport(v) {
  const L = [];
  L.push('【实话实说】这一轮**没有完全做成**，所以我不能说"完成了"：');
  if (v.missing.length) L.push('· 这些文件**根本没生成出来**：' + v.missing.join('、'));
  if (v.unreadable && v.unreadable.length) {
    // §23：分诊 —— 读不到 ≠ 没生成。说错方向会让人去改不存在的东西。
    L.push('· 这些文件**存在但读不到**（' + v.unreadable.join('、') + '）：这更像**我这边验证/读取**的问题，');
    L.push('   **不代表文件没做出来**。我会换一种方式确认；在确认之前，我既不说"做好了"，也不说"没做出来"。');
  }
  if (v.empty.length) L.push('· 这些文件是**空的（0 字节）**：' + v.empty.join('、'));
  if (v.oversized.length) L.push('· 这些文件**只写了一半**（内容不完整）：' + v.oversized.join('、'));
  L.push('· 已经让它补过一轮，仍然没补好，所以先如实告诉你，而不是拿半成品当成果。');
  L.push('· 接下来可以：换一种做法重做（比如把一个大文件拆成几个小文件、或改用分次追加），或者你说先做哪一部分，我按优先级来。');
  return L.join('\n');
}

// ============ 3) 工具级熔断（2026-09-23）============
// 【为什么必须有这一层】
//   重试账本（createRetryLedger）只**记录**"这个方法在打转"，并把它写进一条给模型的提示。
//   但记录 ≠ 拦截：账本从来不阻止下一次调用。于是现实里出现的是 ——
//   浏览器启动失败 → 模型读到"换个方式"的提示 → **又启动了一次浏览器** → 再失败 → 再启动……
//   每一轮都真花钱，最后把任务预算烧穿，交付一个半成品。
//   根因不是提示写得不好，是**提示没有强制力**：语言层面的劝告拦不住一个正在重试的循环。
//   ⇒ 熔断必须落在**执行点**上：同一个签名失败到阈值，就直接**不让它再被执行**。
//
// 【与账本的分工】（两者都要，不是二选一）
//   · 账本 = 诊断：这类失败是什么、该怎么换、是不是换汤不换药 → 生成给模型的话。
//   · 熔断 = 执法：到阈值就**关闭该工具**，并强制给出降级链上的下一步。
const BREAKER_DEFAULT_MAX = 2;

/**
 * 工具熔断器。按「工具名」计数（不是按签名）——
 * 因为要防的场景是"这个工具本机就是跑不起来"，此时参数怎么变都没用。
 *
 * ★★ 2026-10-22（老板第 3 条建议）：**上面这句注释此前与实现相反** ——
 *    `fail()` 对**所有**失败计数，包括「模型把参数写截断」这类**模型侧**失败，
 *    于是模型连续两次输出过长，就把 `file-write` 整个禁掉了。
 *    熔断的前提是"工具本机跑不起来"，而参数类失败恰恰**证明不了**这一点（多半压根没执行到）。
 *    ⇒ 现在按 `failureSide(kind)` 分流：**MODEL 侧不计数**，仍返回 `counted: false`；
 *      这类失败由账本的「同策略升级」拦（判据是策略签名重复，不是禁用工具）。
 *
 * ★★ 2026-02-16：**状态感知**（与账本同一条判据、同一份状态指纹 `buildStateKey`）。
 *   熔断的键原本只有**工具名**（连参数都不看）⇒「同一种做法已失败两次」会**跨轮永久生效**：
 *   基准实测里，第一轮安装/验收命令失败过两次 ⇒ 第二轮、修复轮的 `shell-exec` 直接被关死，
 *   Agent 只能反复读文件、换写法，三轮终态都是 PARTIAL，源码字节一个没改。
 *   ⇒ 现在：状态指纹变了（产物字节变了 / 命令换了 / 是用户反馈后的新一轮 / 代码版本变了）
 *     ⇒ **有限放行一次**（把计数压回"还差一次到上限"，**不是清零**），并记一条解冻事件；
 *     解冻次数有上限（`maxThaw`，缺省 2）⇒ 状态可以变很多次，但不会变成无限续杯。
 *   ⇒ 状态没变、或解冻额度用尽 ⇒ 行为与改造前**逐字一致**（仍拦、不许被"解冻"绕过）。
 * @param {{maxConsecutive?:number, maxThaw?:number}} [opts]
 */
function createToolBreaker(opts) {
  const max = (opts && Number(opts.maxConsecutive)) > 0 ? Number(opts.maxConsecutive) : BREAKER_DEFAULT_MAX;
  const maxThaw = Number(opts && opts.maxThaw) > 0 ? Number(opts.maxThaw) : THAW_DEFAULT_MAX;
  const fails = new Map();   // name -> 连续失败次数
  const kinds = new Map();   // name -> 最后一次失败类型（决定降级链）
  const openedAt = new Map();// name -> 熔断时的次序
  // ★ 状态维（2026-02-16）：上一次失败时世界长什么样 / 已经解冻过几次 / 解冻流水
  const states = new Map();  // name -> 上一次失败时的状态指纹（'' = 当时没有状态证据）
  const thaws = new Map();   // name -> 已解冻次数
  const thawLog = [];
  let seq = 0;

  /**
   * ★ 解冻判据（**唯一**一处）：有状态证据 + 状态确实变了 + 额度没用尽。
   *   🔴 `fail()` 与 `allows()` **必须共用这一条** —— 两处各写一份，
   *     迟早出现"查询说放行、记账说没放行"（或反之）的那种鬼故事。
   */
  const canThaw = (tool, sk) => !!sk && states.has(tool) && states.get(tool) !== sk && (thaws.get(tool) || 0) < maxThaw;

  return {
    /** 记一次**成功** ⇒ 清零（成功是唯一能证明"这条路通了"的证据；解冻额度一并归还）。 */
    ok(name) {
      const n = String(name || '?');
      fails.delete(n); kinds.delete(n); openedAt.delete(n);
      states.delete(n); thaws.delete(n);
    },
    /**
     * 记一次失败。
     * @param {string} name 工具名
     * @param {string} kind 失败类型
     * @param {{stateKey?:string, command?:string, artifactHash?:string|number, artifacts?:any,
     *          round?:number, feedbackEpoch?:number, turn?:number, repairRound?:number,
     *          codeHash?:string}} [o] 状态四格（与账本同源；一个都不给 ⇒ 旧行为）
     * @returns {{name:string, count:number, tripped:boolean, kind:string, max:number,
     *            counted?:boolean, thawed?:boolean, thawReason?:string, stateKey?:string}}
     *   `counted === false` ⇒ 这次失败是**模型侧**的，没有计入熔断（也不清零、不续命）。
     *   `thawed === true`   ⇒ 这次是"状态已变化 ⇒ 有限放行一次"后的那一次失败（放行已记账）。
     */
    fail(name, kind, o) {
      const n = String(name || '?');
      // ★ 模型侧失败不进熔断计数。注意三条纪律：
      //   ① 不清零（它不是成功，不能给已熔断的工具"续命"）；
      //   ② 不改 kinds（否则 kindOf() 会被模型侧失败覆盖，降级链判断跟着跑偏）；
      //   ③ 仍如实返回当前计数，让调用方知道自己没被计入。
      // ★ 第四条（2026-02-16）：模型侧失败也**不许触发解冻** —— "参数又写坏了"
      //   不是"世界变了"，拿它去解锁一个真跑不起来的工具，正是最危险的那种放水。
      if (failureSide(kind) === FAILURE_SIDE.MODEL) {
        return { name: n, count: fails.get(n) || 0, tripped: false, kind, max, counted: false, thawed: false, thawReason: '', stateKey: resolveStateKey(o, null) };
      }
      const sk = resolveStateKey(o, null);
      const prevState = states.get(n);
      const usedThaw = thaws.get(n) || 0;
      // ★ 解冻判据（与账本同形）：有状态证据 + 状态确实变了 + 额度没用尽
      const stateChanged = !!sk && prevState !== undefined && prevState !== sk;
      let thawed = false;
      let thawReason = '';
      let c;
      if (canThaw(n, sk)) {
        thawed = true;
        thaws.set(n, usedThaw + 1);
        // ★ 放行**一次**：压到"还差一次到上限"（不是清零）—— 这一次再失败立刻回到上限。
        c = Math.max(1, max - 1);
        thawReason = '状态已变化（' + (prevState || '（无状态证据）') + ' ⇒ ' + sk
          + '）⇒ 有限放行一次（第 ' + (usedThaw + 1) + '/' + maxThaw + ' 次解冻）';
        thawLog.push({ name: n, from: prevState, to: sk, reason: thawReason, at: Date.now() });
      } else {
        c = (fails.get(n) || 0) + 1;
        if (stateChanged) {
          thawReason = '解冻次数已用尽（' + usedThaw + '/' + maxThaw + '）：状态虽然又变了，'
            + '但 ' + n + ' 已连续失败 ' + c + ' 次 ⇒ 仍拦下';
        }
      }
      fails.set(n, c);
      kinds.set(n, kind);
      states.set(n, sk);
      const tripped = c >= max;
      if (tripped && !openedAt.has(n)) openedAt.set(n, ++seq);
      return { name: n, count: c, tripped, kind, max, counted: true, thawed, thawReason, stateKey: sk };
    },
    /**
     * 这个工具现在允许被调用吗？（熔断后必须返回 false —— 这是本模块存在的意义）
     * @param {string} name 工具名
     * @param {object} [o] 状态四格（`stateKey` / `command` / `artifactHash` / `round` / …）。
     *   不传 ⇒ 与改造前逐字一致（只看连续失败次数）。
     */
    allows(name, o) {
      const n = String(name || '?');
      const sk = resolveStateKey(o, null);
      // ★ 与 fail() 共用**同一条**解冻判据（见 canThaw 头注）
      if (canThaw(n, sk)) return true;
      return (fails.get(n) || 0) < max;
    },
    /** 已熔断的工具名列表（按熔断次序）。 */
    openList() { return [...openedAt.keys()]; },
    openCount(name) { return fails.get(String(name || '?')) || 0; },
    kindOf(name) { return kinds.get(String(name || '?')) || KIND.UNKNOWN; },
    /** 上一次失败时的状态指纹（'' = 当时没有状态证据；undefined = 还没失败过）。 */
    stateOf(name) { return states.get(String(name || '?')); },
    /** 已解冻次数。 */
    thawCountOf(name) { return thaws.get(String(name || '?')) || 0; },
    /** 解冻事件流水（哪次状态变化换来了哪次放行）。 */
    thawEvents() { return thawLog.slice(); },
    get max() { return max; },
    get maxThaw() { return maxThaw; },
    snapshot() { const o = {}; for (const [k, v] of fails.entries()) o[k] = { count: v, kind: kinds.get(k) }; return o; },
  };
}

/**
 * 预设**降级链**：某个验证手段用不了时，按顺序退到"还能真验证点什么"的下一层。
 * 【为什么要预设】失败之后最危险的两种反应是：① 原地再试一遍（烧预算）；② 干脆不验了还说"完成"（假绿）。
 *   降级链就是为了堵住这两头 —— 明确告诉模型"退到哪一层"，而且那一层必须**真的能验证**。
 * 顺序 = 从"最接近真实"到"最弱但仍有判别力"，绝不包含"什么都不验"。
 */
const VERIFY_LEVELS = [
  { level: 'visual', label: '真实浏览器渲染验证', desc: '真的把页面打开、真的看渲染结果与交互' },
  { level: 'http', label: 'HTTP 可达性与内容断言', desc: '服务能起来、返回 200、页面里确实含关键内容' },
  { level: 'headless_logic', label: '无头跑页面业务逻辑', desc: '把页面里的 JS 逻辑抽出来在 Node 里真跑一遍，断言输出' },
  { level: 'static_struct', label: '静态结构断言', desc: '断言 HTML/JS 里的结构、脚本块、关键节点确实存在' },
];

/** 环境/验证工具自身不可用 ⇒ 走降级链（顺序即优先级）。 */
const DEGRADE_CHAIN = {
  [KIND.ENVIRONMENT_ERROR]: ['http', 'headless_logic', 'static_struct'],
  [KIND.VERIFICATION_ERROR]: ['http', 'headless_logic', 'static_struct'],
  [KIND.PERMISSION_ERROR]: ['static_struct'],
  [KIND.PRECONDITION]: ['static_struct'],
  [KIND.TIMEOUT]: ['static_struct'],
};

/**
 * 取降级链（层级对象数组）。不在表里的失败类型返回空数组 —— **刻意不兜底**：
 * 给一个"万能降级链"会让人误以为任何失败都能降级，而参数类/截断类失败的正确动作是
 * **改参数重试**，不是降级。空数组让调用方必须显式处理。
 */
function degradeChainFor(kind) {
  const levels = DEGRADE_CHAIN[kind];
  if (!levels) return [];
  return levels.map((lv) => VERIFY_LEVELS.find((v) => v.level === lv)).filter(Boolean);
}

/**
 * 熔断后给模型的指令。**核心是"别再调这个工具了"必须是一句硬话**，
 * 并明确指定降级链的下一层（否则模型只会换个参数再撞一次）。
 * @param {{name:string, kind:string, count:number, max:number}} trip
 */
function breakerDirective(trip) {
  const t = trip || {};
  const name = String(t.name || '这个工具');
  const kind = t.kind || KIND.UNKNOWN;
  const chain = degradeChainFor(kind);
  // ★ 处方**只算一次**：下面「走不到降级链」那一支、以及新增的路线阶梯那一支，都引用这同一个结果。
  //   `recoveryStrategyFor` 是"该做什么"的唯一真源（五类动作）—— 本函数不许再养一份。
  const rs = recoveryStrategyFor({ kind });
  const L = [];
  L.push('【工具已熔断·不会再被执行】' + name + ' 已连续失败 ' + (t.count || 0) + ' 次'
    + (t.max ? '（上限 ' + t.max + ' 次）' : '') + '，失败类型：' + kindLabel(kind) + '。');
  if (kind === KIND.ENVIRONMENT_ERROR || kind === KIND.VERIFICATION_ERROR) {
    L.push('· 判定：**本机这个验证手段跑不起来**，不是你的产出有问题。这两件事必须分开说。');
  }
  if (chain.length) {
    L.push('· 接下来按这个顺序换验证方式（能验证多少算多少，但**不许跳过不验**）：');
    for (const c of chain) L.push('   ' + (chain.indexOf(c) + 1) + '. ' + c.label + '：' + c.desc);
    L.push('· 走到哪一层就把话说哪一层：**功能已验 / 仅结构已验 / 未验证**，三选一如实说，不许含糊。');
  } else if (kind === KIND.EMPTY_OUTPUT) {
    // 空结果没有"报错/参数"可改，套用下面那句会给出**做不到的指令**（改哪个参数？
    // 它连一个字节都没返回）。这类要的是"先确认有没有做成"。
    L.push('· 这个工具连续两次**一声不响**：多半是技能实现或进程侧的问题，不是你参数的问题。');
    L.push('· 正确动作：先去确认此前那次到底有没有产出（列目录 / 读回文件 / 查状态），再换一种**会回显结果**的做法。');
  } else {
    // ★ 2026-10-23：这句话原来是一句**写死的泛化处方**「改参数/换做法后重试，不是降级」。
    //   问题是它对着所有走不到上面的 KIND 都这么说 —— 包括 `unknown`（文案看不懂的失败）。
    //   而"该改什么"这件事，`recoveryStrategyFor` 已经按失败类型答过一遍了（五类动作）。
    //   两处各写一份 ⇒ 同一种失败在熔断器和恢复器里被开出**不同处方**，而且先说话的是信息更少的那一个
    //   （backend.js 里 `toolBreaker.allows()` 在 `planRecoveryGate()` 之前，实测拦下者是熔断器）。
    //   所以这里不再自造处方，**改成引用同一份判据**：单一真源，措辞也一致。
    L.push('· 这一类失败的正确动作是**' + RECOVERY_ACTION_LABEL[rs.action] + '**；依据：' + rs.why + '。');
  }
  // ★ 路线阶梯（2026-11-03）—— 治老板原话「只会用一种方案 / 卡住就自查，自查没有任何用」。
  //
  // 【改造前给了什么】只有 `RECOVERY_ACTION_LABEL[SWITCH_METHOD]` 那一句
  //   「换执行方式（换工具 / 换命令形态 / 拆成多条更小的调用）」。那是一个**动作类别**，
  //   不是一条具体路线。实测形态：模型照着这三个词，把同一件事换个写法再做一遍 ——
  //   策略签名（工具 + 参数键 + 执行模式）根本没变，于是立刻再撞一次，然后回一句"我做不了"。
  //   **只报类别等于没要求它想**，这就是"楞、只用一种方案"的机制层解释。
  //
  // 【为什么改成"写两条 + 二选一"而不是再加几个类别】类别再多也还是它自己去套模板。
  //   要求它把**两条互不相同的具体路线**并排写出来，它才被迫做一次比较；
  //   二选一之后还必须说理由，理由是唯一能事后检查"它到底想没想"的痕迹。
  //
  // 【为什么不预置候选路线】预置等于替它猜内容，猜错了照着执行更糟。
  //   降级链之所以预置得成，是因为"验证层级"只有有限四层；而"这件事还能怎么做"是无穷的 ——
  //   两者不是同一类东西，不能照抄。
  //
  // 【它有没有被遵守，不靠它自称】下一次调用的策略签名就是读数：真换路 ⇒ 新签名 ⇒ 账本新桶；
  //   没换 ⇒ 老桶继续累加、继续拦。这一段只负责把要求说清楚，判定仍归账本与熔断器。
  //
  // 【与收尾模式的关系】backend 在熔断拦截处若已进入 wrapUpMode，会在本指令**之后**再压一条
  //   「不要换工具了，直接把现状写成结论」。后说的覆盖先说的，这里不重复判 wrapUpMode ——
  //   在 toolProtocol 里再判一次就是第二个真源。
  if (rs.action === RECOVERY_ACTION.SWITCH_METHOD) {
    L.push('· **先别动手。** 动手前先写清两条**没试过的**路线，再二选一（硬要求，不是建议）：');
    L.push('   路线A：第一步具体做什么 —— 它最可能怎么失败（各一句）');
    L.push('   路线B：同上 —— 它最可能怎么失败（各一句）');
    L.push('   选哪条、为什么（一句）。');
    L.push('· 「换个参数 / 换个文件名 / 把同一件事拆成两次」**不算新路线**；'
      + '「再自查一遍」也不算 —— 自查用的是同一套判断方式，读数不会变，那不是换路，是原地重读。');
    L.push('· 下一条调用必须能对上你选的那条路线；对不上就说明你还按老办法在做。');
  }
  L.push('· **不要再调用 ' + name + '**（本轮它已被关闭）。再调一次也不会被执行。');
  return L.join('\n');
}

/**
 * 交付缺口清单：把「还缺什么」算出来（**只出清单，不出判决**）。
 *
 * 🔴 为什么这里不判三态（2026-09-23 改）：本函数初版叫 `adjudicateDelivery`，自己返回一套
 *   COMPLETE / DELIVERED_WITH_GAP / BLOCKED。但仓库里**已经有一支**规范锚定的状态机
 *   —— `classifyTerminalState`（deliveryProtocol.js，UI 与正常收尾路径都在用）。两支**词表不同、
 *   语义重叠**的状态机并存 ⇒ 迟早出现"同一个任务两个终态"。故：**判决权归 deliveryProtocol，
 *   这里只负责清单**（一支状态机原则）。
 *
 * 另一处原始缺陷（同源）：本函数当时被 `require` 进 backend 却**零调用** —— 等于没做。
 *   这正是「写了 ≠ 接线」。现在它真的进了 reportBudget 的收尾输出。
 *
 * @param {{delivered?:number, expected?:number, verifyGap?:string, unresolved?:number}} o
 * @returns {{gap:string[]}} gap 为空字符串数组 = 本次确实没有未闭环项（不是"没算"）
 */
function buildDeliveryGap(o) {
  const s = o && typeof o === 'object' ? o : {};
  const delivered = Number(s.delivered) || 0;
  const expected = Number(s.expected) || 0;
  const gap = [];
  if (expected > 0 && delivered < expected) gap.push('还差 ' + (expected - delivered) + ' 项没交付');
  if (Number(s.unresolved) > 0) gap.push('还有 ' + Number(s.unresolved) + ' 件没闭环');
  if (s.verifyGap) gap.push(String(s.verifyGap));
  if (!delivered && !gap.length) gap.push('什么都没交付出来');
  return { gap };
}

// ==================== 5b) 恢复执行器（2026-10-05 老板拍板）====================
// 本段承担四条契约的「判定 + 产物契约」半边（执行接线在 backend.js）：
//   契约③ 同策略失败必须升级 —— 而且必须是**执法**不是劝告 ⇒ 本段产出 `blocked`（执行前拦下）
//   契约④ 恢复器**永不产终态** ⇒ 只产出 {action, result, evidence}；本段连状态词表都拿不到
//   契约② 恢复成功不能代替复验 ⇒ recoveryEvidenceGate 只认「复验读数」，不认自称成功
//   契约① 动作选择 ≠ 成功状态 ⇒ RECOVERY_ACTION 与状态词表的值域**零交集**
//
// ⚠️ 命名纪律：这些字段刻意**不叫** status / state ——
//   一旦恢复层能吐出一个"看起来像状态"的词，下游就会有人拿它当状态用，那正是"两支状态机"的开端。
//   本段唯一的输出语义是「下一个动作是什么」，判决权不在这里。
const RECOVERY_ACTION = Object.freeze({
  FIX_ARGS: 'fix_args',               // 参数/截断类：改参数、分批继续
  SWITCH_METHOD: 'switch_method',     // 同策略重复失败：换执行方式（真换，不是把内容改小一点）
  DEGRADE_VERIFY: 'degrade_verify',   // 验证工具类：换一种验证方式复核
  DEGRADE_ENV: 'degrade_env',         // 环境/权限/前置条件类：走降级链、换一条不依赖它的路
  STOP: 'stop',                       // 用户叫停：停下汇报，不重试
});

const RECOVERY_ACTION_LABEL = {
  [RECOVERY_ACTION.FIX_ARGS]: '改参数后重试（把这一次要写的东西变小 / 分批追加，不要原样重发）',
  [RECOVERY_ACTION.SWITCH_METHOD]: '换执行方式（换工具 / 换命令形态 / 拆成多条更小的调用）',
  [RECOVERY_ACTION.DEGRADE_VERIFY]: '换一种验证方式（按降级链退到下一层：能验多少算多少，但不许跳过不验）',
  [RECOVERY_ACTION.DEGRADE_ENV]: '换一条不依赖这个环境条件的路（降级 / 绕开）；确实绕不开就如实说需要先装/先开什么',
  [RECOVERY_ACTION.STOP]: '停下并汇报当前进度（这是用户主动叫停，不是失败）',
};

/** 同一策略失败到几次就必须换方案（与 createRetryLedger 的默认值同源：同一种方法最多试 2 次）。 */
const RECOVERY_MAX_SAME_METHOD = 2;

/**
 * 失败类型 + 是否已在同一策略上打转 ⇒ **下一个动作**（是动作，不是状态，也不是判决）。
 * 顺序即优先级：`sameStrategy`（值变了但做法没变）最高 —— 这时"再改一次参数"没有意义。
 * @param {{kind?:string, sameStrategy?:boolean, escalate?:boolean}} o
 * @returns {{action:string, why:string}}
 */
function recoveryStrategyFor(o) {
  const s = o && typeof o === 'object' ? o : {};
  const kind = s.kind || KIND.UNKNOWN;
  // 用户主动叫停：任何"重试"都是错的，先停下来汇报。
  if (kind === KIND.ABORTED) return { action: RECOVERY_ACTION.STOP, why: '用户主动叫停，重试没有意义' };
  // 换汤不换药：参数值变了但（工具 + 参数键 + 执行模式）没变 ⇒ 再改一次参数还是同一个坑。
  if (s.sameStrategy === true) {
    return { action: RECOVERY_ACTION.SWITCH_METHOD, why: '参数值变了但做法没变（换汤不换药），同一个坑会再踩一次' };
  }
  // 参数类：方向是**改**参数（缩短单次产出 / 补齐 / 改取值 / 改路径），不是换工具。
  if (kind === KIND.ARGS_TRUNCATED || kind === KIND.ARGS_MISSING ||
      kind === KIND.ARGS_INVALID || kind === KIND.PATH_ERROR) {
    return { action: RECOVERY_ACTION.FIX_ARGS, why: '改参数就能成，但必须真的改，原样重发一定再失败一次' };
  }
  // 验证工具类：先分清"是工具坏了"还是"产品坏了"，所以动作是**换一种验证方式**。
  if (kind === KIND.VERIFICATION_ERROR) {
    return { action: RECOVERY_ACTION.DEGRADE_VERIFY, why: '先分清是验证工具自身出问题，还是产品真有问题' };
  }
  // 环境/权限/前置条件：改参数、重试一万次都一样 ⇒ 只能降级或绕开。
  if (kind === KIND.ENVIRONMENT_ERROR || kind === KIND.PERMISSION_ERROR || kind === KIND.PRECONDITION) {
    return { action: RECOVERY_ACTION.DEGRADE_ENV, why: '环境/权限/前置条件问题，改参数不会变好' };
  }
  // 其余（执行方式出错 / 超时 / 运行期报错 / 未定性）：换执行方式。
  return { action: RECOVERY_ACTION.SWITCH_METHOD, why: '执行方式本身要换（同一条命令/同一种形态在这台机器上走不通）' };
}

/**
 * 「这一次失败**够不够**判成『这个方法已证伪』」—— 唯一判定点。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须单独成一个纯函数（而不是写在 backend 的 governToolResult 里）
 * ═══════════════════════════════════════════════════════════════════════════
 *   `governToolResult` 是 `runAgentLoop` 内部的闭包，依赖 Electron 运行时，**单测里整装启动不了**。
 *   而"判定点"正是最需要被单独钉住的那一半：
 *     · 失败**一次**就记证伪 ⇒ 老板批的原始缺陷（一次历史失败固化成永久禁令）原封不动地回来了；
 *     · 阈值/条件写错 ⇒ 要么永远不记（机制白做），要么一失败就记（更糟）。
 *   所以判据留在这里（纯函数、可单独跑、可单独变异），backend 只负责把它产出的 `one`
 *   原样交给 `workflowState` 落账 —— 与 `recoveryStrategyFor` / `gradeVerifyEvidence` 同一条纪律：
 *   **判据必须有单一真源，不许在 backend 里再养一份。**
 *
 * 🔴 判定条件是**且**，两条缺一不可：
 *   ① `escalate === true`：同一**策略**（工具 + 参数键 + 执行模式，不含参数值）已失败到上限。
 *      —— 这不是"这次运气不好"，是"这个做法反复不行"。
 *   ② `strategy` 非空：算不出策略 key 的账**不许落**（落进去也查不到，等于污染账本）。
 *
 * 产出的 `one` 里三字段的口径见 `refuteScope` 模块头注★（`files` = **实现文件**，不是数据文件）。
 *
 * @param {{tool?:string, params?:object, kind?:string, text?:string,
 *          escalate?:boolean, strategy?:string, strategyCount?:number,
 *          nextAction?:string, lastError?:string, now?:number,
 *          root?:string, readFile?:(abs:string)=>any}} o
 *   `root` / `readFile` 只给门禁与沙箱用（生产走真实 fs）。
 * @returns {{refute:boolean, why:string, one:(object|null)}}
 *   `refute=true` 时 `one` 可直接交给 `workflowState.recordRefuted` / `store.refute`。
 */
function refuteDecision(o) {
  const s = (o && typeof o === 'object') ? o : {};
  const tool = String(s.tool || '').trim();
  const sig = String(s.strategy || '').trim();
  const now = Number(s.now) > 0 ? Number(s.now) : Date.now();
  const no = (why) => ({ refute: false, why, one: null });
  if (s.escalate !== true) {
    return no('失败次数未到阈值（escalate=false）⇒ 只是一次运气不好，不是"方法已证伪"');
  }
  if (!sig) return no('算不出策略签名 ⇒ 落进去也查不到，不许落账');
  if (!tool) return no('没有工具名 ⇒ 算不出实现文件范围');
  const scopeOpts = { root: s.root, readFile: s.readFile };
  /**
   * 范围 = 实现文件（必须） + 目标数据文件（只在失败原因明确指向时，见 `dataFilesFor`）。
   * ★ 去重且保持顺序：实现文件在前（审计时第一眼就该看到"是哪个办法的代码"）。
   */
  const files = [];
  const push = (rel) => { if (rel && files.indexOf(rel) < 0) files.push(rel); };
  for (const f of refuteScope.implFilesFor(tool, scopeOpts)) push(f);
  for (const f of refuteScope.dataFilesFor({ tool, params: s.params, kind: s.kind }, scopeOpts)) push(f);
  const paramKeys = (s.params && typeof s.params === 'object' && !Array.isArray(s.params))
    ? Object.keys(s.params).filter((k) => k !== 'mode' && !isEmptyValue(s.params[k])).sort().slice(0, 40)
    : [];
  const one = {
    sig,
    tool,
    // 证据：**让这次判定成立的那一次真实失败的原文**（recordRefuted 内部截断到 2000 字符）
    errorText: String(s.text === undefined || s.text === null ? '' : s.text),
    // 判据里拿不到进程退出码（工具结果是文本，不是进程对象）⇒ 显式 null，不许编一个 0 出来
    exitCode: null,
    files,
    paramKeys,
    count: Math.max(0, Math.floor(Number(s.strategyCount) || 0)),
    lastKind: String(s.kind || 'unknown').slice(0, 40),
    nextAction: String(s.nextAction || '').slice(0, 200),
    lastError: String(s.lastError || '').slice(0, 300),
    at: now,
  };
  return {
    refute: true,
    why: '同一策略已失败 ' + one.count + ' 次（到阈值）⇒ 这个做法已证伪；'
      + '范围=' + (files.length ? files.join('、') : '（空 ⇒ 判定侧会按 stale 允许重试）'),
    one,
  };
}

/**
 * 恢复执行器。
 *
 * 🔴 契约④：它**只产出** {action, result, evidence}，永远不产出终态 ——
 *   终态只归 deliveryProtocol 里那**唯一**一个状态机入口（本模块不引用它，也就没有那个能力）。
 *   所以本段的产物里连 status / state 这类字段名都不存在（结构上就产不出来）。
 *
 * @param {{maxSameMethod?:number}} [opts]
 */
function createRecoveryExecutor(opts) {
  const maxSameMethod = (opts && Number(opts.maxSameMethod)) > 0
    ? Number(opts.maxSameMethod) : RECOVERY_MAX_SAME_METHOD;
  const log = [];
  return {
    /**
     * 执行**之前**问一次：这一条还允许真的执行吗？
     * @param {{name?:string, params?:object, strategyCount?:number, lastKind?:string, sameStrategy?:boolean,
     *          seeded?:boolean, seededRefuted?:boolean, seededLastError?:string,
     *          thawed?:boolean, stateChanged?:boolean, thawReason?:string, stateKey?:string}} o
     *   seeded* 三个字段由调用方从 `ledger.seededOf(name, params, o)` 取来再传进来 ——
     *   本函数**不持有账本**，只负责把"上次为什么坏"写进拦截文案。
     *   ★ 2026-02-16：`thawed` / `stateChanged` / `thawReason` / `stateKey` 由调用方从
     *     `ledger.thawStateOf(name, params, o)` 取来再传进来 —— 状态指纹的**唯一真源是账本**，
     *     本函数不自己算状态（两处各算一份 ⇒ 迟早算出两个结论）。
     * @returns {{action:string, blocked:boolean, directive:string, evidence:object}}
     */
    plan(o) {
      const s = o && typeof o === 'object' ? o : {};
      const name = String(s.name || '?');
      const strategyCount = Math.max(0, Number(s.strategyCount) || 0);
      const lastKind = s.lastKind || KIND.UNKNOWN;
      // ★ 契约③的执法判据：同一个策略（工具 + 同一组参数键 + 同一执行模式）已经失败到上限 ⇒ 不许再执行它。
      //   注意拦的是**重复**，不是**失败**：第一次失败不会被拦（下面单测里有控制组钉住这一点）。
      const blocked = strategyCount >= maxSameMethod;
      /**
       * ★★ 解冻（2026-02-16）：状态已变化 ⇒ 这一条**有限放行一次**。
       *   要根治的缺陷：第一轮命令失败过两次 ⇒ 第二轮/修复轮想重跑安装或验收命令时被永久拦下
       *   ⇒ 三轮都是 PARTIAL、源码字节一个没改。产物变了 / 命令换了 / 是新反馈轮 ⇒ 那是**新情况**，
       *   旧账不适用于此刻。
       *   🔴 放行**不是清零**：这一次再失败，账本的计数立刻回到上限（见 ledger.fail 的
       *   `sc.count = Math.min(sc.count, maxSameMethod - 1)`），同状态下不会无限续杯。
       */
      const thawed = s.thawed === true || s.stateChanged === true;
      const thawReason = String(s.thawReason || '');
      const finalBlocked = blocked && !thawed;
      const why = recoveryStrategyFor({ kind: lastKind, sameStrategy: s.sameStrategy === true, escalate: finalBlocked });
      const evidence = {
        name, kind: lastKind, strategyCount, maxSameMethod,
        sameStrategy: s.sameStrategy === true, reason: why.why,
        // 跨请求记忆（纯增量字段）：这次的账里有多少是**上一次运行**留下来的
        seeded: s.seeded === true,
        seededRefuted: s.seededRefuted === true,
        seededLastError: String(s.seededLastError || '').slice(0, 160),
        // 状态维（纯增量字段）：放行/拦下都**必须**说得出原因
        stateKey: String(s.stateKey || ''),
        thawed,
        thawReason: thawReason.slice(0, 300),
      };
      let directive = '';
      if (finalBlocked) {
        // ⚠️ 前缀刻意沿用**既有的"未执行"约定**（与 backend 里 `argsInfo.canExecute === false`
        //   那条回灌同形）：这段文本必须被系统**自己的失败判定**认成"没执行"。
        //   否则它会被当成**成功** —— 那会（a）给工具熔断器清零、（b）触发一次本不该发生的
        //   "恢复后复验"（没执行就谈不上恢复生效）。用同一套约定，才能让两条路走同一个判定。
        directive = 'error: 本次调用没有执行（同一策略已耗尽，已拦下）：' + name
          + ' 这个做法（同一工具 + 同一组参数键 + 同一执行模式）已经失败 ' + strategyCount
          + ' 次（上限 ' + maxSameMethod + ' 次），失败类型：' + kindLabel(lastKind) + '。\n'
          + '· 这一条已经**不会再被执行**：重发也不会执行。\n'
          + '· 现在应该做的**下一个动作**：' + RECOVERY_ACTION_LABEL[why.action] + '。\n'
          + '· 依据：' + why.why + '。';
        // ★ 2026-02-16：**为什么仍拦**必须说得出原因（可读原因是硬要求，不是加分项）。
        //   状态变了但额度用尽 / 达到绝对上限 / 状态压根没变 —— 三种情况各一句，
        //   模型拿到之后才知道"该换方法"而不是"再改一次参数试试"。
        if (thawReason) {
          directive += '\n·（状态判定）' + thawReason + '。';
        }
        // ★ 跨请求记忆：这一条是**上一次运行**就记下的账 ⇒ 必须说清"上次为什么坏"，
        //   否则模型会把它当成"这次运气不好"，换个说法再试一遍，重启一次就白记一次。
        //   注意这是**附加**在原有拦截文案之后，不替换任何既有内容（既有门禁按既有子串断言）。
        if (s.seeded === true) {
          const lastErr = String(s.seededLastError || '').trim() || '（上次没留下具体报错）';
          directive += '\n'
            + '·（跨请求记忆）这条路在上一次运行里就失败过，原因是：' + lastErr + '。\n'
            + '  所以这次不是"运气不好"，是同一个坑。换方法；除非证据表明环境和上次不同（如磁盘已清、依赖已装、权限已给），\n'
            + '  那种情况请先说明依据，再重试一次。';
        }
      }
      // ★ 放行也要留痕：解冻放行是**有限**的，必须让模型知道"这是最后一次机会"，
      //   否则它会把放行当成"可以再来一轮"，下一次被拦时已经没有任何预算了。
      if (thawed && !finalBlocked) {
        directive = '（状态已变化 · 有限放行一次）' + name + '：' + (thawReason || '状态已变化')
          + '。这一次**只有一次机会**：再失败就会按旧账拦下，请先把做法真的换掉或确认环境已经不同。';
      }
      return { action: why.action, blocked: finalBlocked, directive, evidence };
    },
    /**
     * 记一次恢复动作的**执行产物**。
     * ★ 契约④：只允许 action / result / evidence 三个键 —— 恢复动作**不能宣布任何结果状态**。
     * @param {{action?:string, result?:any, evidence?:any}} o
     */
    record(o) {
      const s = o && typeof o === 'object' ? o : {};
      const entry = {
        action: s.action,
        result: s.result,
        evidence: s.evidence,
      };
      log.push(entry);
      return entry;
    },
    get count() { return log.length; },
    entries() { return log.slice(); },
    snapshot() { return { count: log.length, actions: log.map((x) => x.action) }; },
  };
}

/**
 * 恢复动作的产物能不能当「已完成」的证据？—— **只认复验读数**（契约②）。
 *
 * 🔴 刻意**不读** result / status / ok 这类"自称"字段：
 *   恢复器说自己"好了"不算证据（那等于让它自证）；只有跑过一遍复验、且复验说通过，才算。
 *   所以"删掉恢复后的复验调用"这件事会在这里**必然**变成 false —— 这就是契约②的执法点。
 *
 * @param {{reverification?:{ran?:boolean, ok?:boolean}}} o 恢复动作的产物（含复验读数）
 * @returns {boolean} true = 可以作为"已完成"的证据
 */
function recoveryEvidenceGate(o) {
  const s = o && typeof o === 'object' ? o : {};
  const rev = s.reverification;
  if (!rev || rev.ran !== true) return false;   // 没跑过复验 ⇒ 不算
  if (rev.ok === false) return false;           // 复验说没通过 ⇒ 不算
  return true;
}

module.exports = {
  KIND,
  KIND_PLAYBOOK,
  PROBLEM,
  FAILURE_HEAD_RE,
  // 「已经判了失败的结果，文本自己也得认得出是失败」这条不变量的实现（2026-10-22）
  hasFailureHead,
  ensureFailureHead,
  EMPTY_OUTPUT_STUB,
  PARAM_FAIL_RE,
  classifyToolFailure,
  isRetryable,
  FAILURE_SIDE,
  failureSide,
  kindLabel,
  kindPlaybook,
  looksTruncated,
  salvageTruncatedArgs,
  isEmptyValue,
  normalizeToolArgs,
  shortHash,
  buildCallSignature,
  normalizeExecMode,
  toolCallSignature,
  createRetryLedger,
  // ===== 状态指纹：解冻（2026-02-16）——「状态已变化 ⇒ 有限放行一次」的唯一判据 =====
  THAW_DEFAULT_MAX,
  commandFingerprint,
  artifactFingerprint,
  buildStateKey,
  resolveStateKey,
  retryKeyFor,
  recoveryDirective,
  verifyDeliverables,
  verificationDirective,
  honestStatusReport,
  createToolBreaker,
  breakerDirective,
  degradeChainFor,
  buildDeliveryGap,
  VERIFY_LEVELS,
  DEGRADE_CHAIN,
  BREAKER_DEFAULT_MAX,
  // ===== 恢复执行器（2026-10-05）：四条契约的判定半边 =====
  RECOVERY_ACTION,
  RECOVERY_ACTION_LABEL,
  RECOVERY_MAX_SAME_METHOD,
  recoveryStrategyFor,
  createRecoveryExecutor,
  recoveryEvidenceGate,
  // ===== refuted 判定点（2026-02-16）：够不够判"这个方法已证伪" =====
  refuteDecision,
};
