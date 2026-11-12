// 交接单（handoff brief）—— 替补接管时该看到的那一页纸，而不是前任的全部上下文。
// ============================================================================
// 老板原话（2026-11-03）：
//   「尤其是替补 Agent：它必须知道前任尝试过什么、为什么失败、哪些办法不能再用。
//     不能接手后把前任失败的步骤再重复一遍。」
//   以及那句更硬的判断：
//   「如果几个 Agent 使用相同模型、相同上下文、相同判断方式，它们可能只是集体犯同一个错误。」
//
// 【本模块的定位：先造"换人时该给什么"，再造"另一个人"】
//   仓库现状查证（2026-11-03）：`highRiskParallel` 从用户答案一路存进工单并打印成
//   「并行模式：开启（双方案对比）」，**全仓零个消费者** —— 没有任何地方据此跑第二路。
//   也就是说"替补 Agent"在代码里根本不存在，只是工单上印着一行字。
//
//   为什么不先造第二个 runtime：那要动 runAgentLoop、产物隔离、择优判定三大块，
//   而"择优"又落回同一个模型判断 —— 恰是老板担心的"集体犯同一个错"。
//   真正便宜的、且能机械验证的第一步是：**把失败经验压成一份可交接的指令**。
//   换人时给的信息一旦不同，同一个模型也会走出不同的路；这是不需要第二个进程就能生效的部分。
//
// 【为什么必须真的把"禁止"写出来，而不是只给统计】
//   `strategySnapshot()` 里 `{count:2, lastKind:'environment_error'}` 这种数据，
//   模型看到了也不知道"所以呢"。交接单要做的是把它翻译成一句人话的禁令，
//   并且**同时给出还剩哪些方向没试** —— 只给禁令会把它逼成"什么都不做"，
//   那也是失败（老板批过"最后得出结论我做不了"）。
//
// 【不变量（门禁逐条钉住）】
//   ① 已证伪且未过期的策略，必须出现在 forbidden，且正文里必须标"不要再用"；
//   ② 试过但未证伪的，必须出现在 tried，正文里必须逐条列出（不许省略成"试过几次"）；
//   ③ notTried 与"已用过的动作类别"交集必须为空（不许把用过的说成没试过）；
//   ④ forbidden 的工具名不许出现在 notTried 指向的"还能做什么"里 —— 否则等于让替补去撞同一堵墙；
//   ⑤ 没有"已证伪"也没有"同策略反复失败"时，本模块**不输出**任何东西（返回 null），
//      不许在没有交接必要时塞一段废话进对话（老板批过长篇大论）。
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// 零、凭据脱敏（红线二）—— **所有写进正文的失败原文都必须先过这里**
// ════════════════════════════════════════════════════════════════════════════
/**
 * 把字符串里"看起来像凭据"的片段替换成 `***`。
 *
 * 【为什么必须有（不是防御性编程，是一条真实的泄漏路径）】
 *   交接单里的 `lastError` / `nextAction` 是**工具失败原文**（backend 侧截 300 字，这里再截 140），
 *   它会被拼进交接单正文 → 进替补的种子 prompt → **发给模型网关**。
 *   而一次 shell / ssh / 数据库调用失败的原文里，带上 token、连接串、`password=` 是常见形态。
 *   仓库里唯一的 `maskSecrets` 在 backend 且只作用于 **params 的键名**，
 *   对"已经变成一句话的错误文本"一格都管不到 —— 所以这里是那条路上**唯一**的拦截点。
 *
 * 【为什么是纯函数】
 *   它要能被单测直接调用、能被反控（改成 `return text` 时门禁必须变红），
 *   不许依赖运行时状态（配置、环境变量、文件）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 口径：**按值形态 + 按已知前缀 + 按 key 邻近**，不是"我认识的那几种写法"。
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版只挡得住五个和它同源的样例（`password=` / `Bearer <长>` / `sk-<16+>` / `scheme://u:p@h` / 32 位 hex），
 * 复验方拿 30 条真实形态一打，漏了 20 条：空格分隔、JSON 引号、全角冒号、下划线键名、
 * 密码里含 `@`、短 token、`Basic`/AWS/GitHub 前缀、私钥块、以及**base64 包一层**就全绕过。
 * ⇒ 现在的结构是"一网打尽式"，宁可多打码，也不许留下"看起来不像密码所以放过"的人肉判断。
 *
 * 规则（顺序有讲究：先长块、再前缀、再键值、最后形态兜底）：
 *   ① 私钥块（`-----BEGIN … PRIVATE KEY-----`，含 PEM 正文）
 *   ② URL/DSN 凭据 `scheme://user:pass@host` —— 密码里含 `@` 也吃得住（按"最后一个 `@` 之前全是 userinfo"）
 *   ③ 已知前缀的凭据：`sk-/rk-/pk-`、`sk_live_/sk_test_`、`ghp_/gho_/ghu_/ghs_/ghr_`、`github_pat_`、
 *      `AKIA…/ASIA…`、`xox?-`、`AIza…`、`glpat-`、`npm_`、`SG.<a>.<b>`、`eyJ…`（JWT）、
 *      `Bearer/Basic/Token/Digest <值>`
 *   ④ 键值邻近（**强键名**）：`password/secret/token/api_key/authorization/密码/密钥…`，
 *      宽口径（中英文、下划线前缀、JSON 引号、全角冒号）。
 *      ⚠️ 「空格分隔」这一支**分两种**：flag 形态（`--password`/`-p`）照样打；
 *      **裸键名 + 空格**要求值"像凭据"（≥6 且不像文件名/路径）——
 *      否则 `- password list.html（2048 B，…）` 这种**产物指纹行**的文件名会被吃掉。
 *   ⑤ 键值邻近（**弱键名**）：`session/sid/cookie/jwt/sig/nonce/csrf` ——
 *      这些词在英文句子里太常见，**必须带显式分隔符**（`=`/`:`）才算，否则会把
 *      `session 已过期` 这种正常句子打成马赛克
 *   ⑥ CLI 短参数：`-p<紧贴值>`、`-p <像口令的值>`、`-u 用户:口令`（保留用户名只打口令）——
 *      **`mkdir -p out/dir` / `mkdir -p target` 都不会被打码**，见规则旁的三条守卫
 *   ⑦ 长十六进制（≥24）：保留前 4 后 4，中间 `***`；**只有两条豁免** ——
 *      **带已知扩展名的文件名**（打码会让指针失效；判据只看扩展名，**不看有没有 `/`**）、
 *      **同一行内**的指纹标签（`sha1`/`hash`/`指纹` …，跨行不算，见 `labelContext`）。
 *      ⚠️ 另有三条被删掉，全是"拿版面位置当安全判据"，都被真实形态打穿过，别再凭存在感加回来：
 *         · `（`/`(`/`- ` 紧邻豁免 ⇒ 打穿了 `- <32hex>.bin（7 B，…）` 这条真泄漏；
 *         · "含 `/` 即路径" ⇒ 打穿了 `out/<32hex>.bin` / `C:/w/out/<32hex>.bin`；
 *         · "前 20 字符内有标签"（跨行版）⇒ 段首「指纹」给下一行裸 hex 开了后门。
 *      阈值取 24 而非 32：24 位十六进制正是会话串的常见长度，
 *      **宁可多打一条 mongo id，也不漏一条 session**（打多了只是少一条信息，漏一条是事故）。
 *   ⑧ base64 兜底：把疑似 base64 块**解码后重跑一遍规则**，解码结果里有凭据就整块打码
 *      （专门用来堵 `base64("…sk-…")` 这种"包一层就绕过"的形态）。
 *
 * ⚠️ 它的**唯一**目标是不泄漏："保持原文可读"不是它的事。
 *
 * 【幂等】所有规则的替换结果都不再匹配自身（`***` 不落在任何字符类里），
 *   所以"字段级脱敏一次 + 正文出口再脱敏一次"不会把掩码二次加工。
 *   `scripts/smoke/unit-handoff-redact.mjs` 的 A4 逐条钉住这条（30 条样例各跑两遍 == 跑一遍）。
 *
 * @param {unknown} text 任意输入（undefined / null / 对象 ⇒ 先转成字符串）
 * @returns {string} 脱敏后的文本
 */

/** 键名宽口径：中英文、允许 `DB_`/`--`/`.`/`-` 前缀，允许 `api-key` / `secret_key` 这类变体。 */
const SECRET_KEY_ALT = '[A-Za-z0-9_.\\-]*(?:'
  + 'password|passwd|passphrase|pwd'
  + '|private[_-]?key|client[_-]?secret|secret[_-]?key|secret'
  + '|access[_-]?token|access[_-]?key|refresh[_-]?token|id[_-]?token|auth[_-]?token'
  + '|api[_-]?key|api[_-]?token|apikey'
  + '|authorization|credentials?|token'
  + '|密码|口令|密钥|令牌'
  + ')';

/**
 * 键值规则：`<前置分隔><键名><分隔符><值>`。
 * 分隔符三支（缺一支就是复验方打过的那一批）：
 *   · `["']?[ \t]*[:=：＝][ \t]*["']?` —— `=` / `:` / 全角冒号 / `＝`，允许 JSON 引号
 *   · `[ \t]+`                        —— **空格分隔**（`--password hunter2`、`密码 123456`）
 * 值三支：双引号串 / 单引号串 / 裸串（不含空白与引号与常见标点）。
 */
const SECRET_KV_RE = new RegExp(
  '(^|[^A-Za-z0-9_.\\-])(' + SECRET_KEY_ALT + ')'
  + '(["\\\']?[ \\t]*(?:[:=：＝]|=>)[ \\t]*["\\\']?|[ \\t]+)'
  + '("[^"\\n]*"|\\\'[^\\\'\\n]*\\\'|[^\\s"\\\',;}\\]&]+)',
  'gi'
);

/** 产物指纹标签：命中这些词的 hex **不许**打码（另一个功能靠 sha1 指认产物）。 */
const FINGERPRINT_HINT_RE = /(sha-?1|sha-?256|sha-?512|md5|hash|digest|checksum|指纹|摘要)/i;

/**
 * 已知文件扩展名 —— 用来区分「文件名」与「凭据值」。
 * 为什么必须有这一条（复验方实测，跨工程师打架）：指纹段的一行长这样
 *   `   - password list.html（2048 B，2026-11-04T02:10:19.859Z）`
 * 文件名本身叫 `password list.html`，而「裸键名 + 空格分隔」那条规则把它吃成
 *   `   - password *** B，2026-11-04T02:10:19.859Z）`
 * **文件名和字节数一起没了** ⇒ 替补再也指认不出产物。同理 `token notes.md`、`secret keys.json`。
 */
const FILE_EXT_RE = /\.(?:html?|md|mjs|cjs|js|jsx|ts|tsx|json|css|scss|less|txt|pptx?|docx?|xlsx?|csv|png|jpe?g|gif|webp|svg|pdf|zip|7z|gz|tgz|tar|log|yml|yaml|ini|toml|xml|mp4|mov|mp3|wav|ttf|woff2?)(?![A-Za-z0-9])/i;

/**
 * 这个 token 是不是「文件」？判据**只有一条：它带已知扩展名**。
 *
 * 【三次"拿位置当判据"，删了三次，这是第三次】
 *   ① 「前 20 字符内有指纹标签就豁免」—— 真实指纹段的标签在**段首那一行**，离路径里的 hex
 *      有 40+ 字符 ⇒ 真实形态下**永远不触发**（豁免是死代码，打码照打）。
 *   ② 「紧邻 `- ` 或 `（` 的长 hex 豁免」—— 列表标记后面既可能是路径也可能是凭据。
 *      实锤：`- <32 位 hex 会话串>.bin（7 B，…）` 就是真泄漏形态，这条豁免把它放过去了。
 *   ③ 「含 `/` 就是路径」—— 同样是位置判据：它说的是"这串东西**在屏幕上的位置**长什么样"，
 *      而不是"这串东西**是什么**"。实测（这三条以前全部原样漏出）：
 *        `out/<32 位 hex>.bin`、`out\<32 位 hex>.bin`、`C:/w/out/<32 位 hex>.bin`
 *      连同 `R27_CORPUS` 第 12 条那条真身 `d41d8cd98f00b204e9800998ecf8427e` 加个目录前缀也漏。
 *      而同一串**裸名**是打码的 ⇒ 同一个威胁两个答案，差别只有 `/` 在不在。
 *      这就证明了 `/` 不是安全判据：凭据完全可以在某个目录里。
 *
 * ⇒ 唯一"能证明它是文件"的证据是**扩展名** —— 文件类型是 token 自己的属性，
 *   不是它在版面上的位置。代价：无扩展名的路径/文件名不再被豁免（实测真实工作区
 *   50 个顶层文件里无扩展名的 0 个，所以这个代价目前不落在任何真实数据上）。
 *
 * @param {string} tok
 * @returns {boolean}
 */
const looksLikePathToken = (tok) => {
  // 掐掉包裹的标点（`（2048 B`、`，`、`）` 这些不是 token 的一部分）
  const t = String(tok == null ? '' : tok).replace(/^[（(【\[「]+/, '').replace(/[）)】\]」，,。;；、]+$/, '');
  if (!t) return false;
  return FILE_EXT_RE.test(t);              // 以已知扩展名结尾（或扩展名后紧跟标点）
};

/**
 * 取 `offset` 之前、**同一行内**最多 20 字符的上下文（给"指纹标签紧邻"这条豁免用）。
 *
 * 为什么必须截到行首：标签是"这一串 hex 的说明"，跨行就不再说明它了。
 * 实测形态：`【工作区与产物指纹】\n  · 裸 hex 会话：<hex>` ——
 * 段首那个「指纹」二字离下一行的 hex 不到 20 字符，若不截行，
 * **整段里任何紧跟在段首标签后面的裸 hex 都会被豁免**（等于给指纹段开了个后门）。
 *
 * @param {string} str
 * @param {number} offset
 * @returns {string}
 */
const labelContext = (str, offset) => {
  const lineStart = str.lastIndexOf('\n', offset - 1) + 1;
  return String(str).slice(Math.max(lineStart, offset - 20), offset);
};

/**
 * 取 `str` 里包含 `[start,end)` 的那整个"非空白 token"。
 * 用于"这一串 hex 是不是某个文件名的一部分"这类判断（hex 规则要用）。
 * @param {string} str
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
const expandToken = (str, start, end) => {
  let a = start;
  let b = end;
  while (a > 0 && !/\s/.test(str.charAt(a - 1))) a--;
  while (b < str.length && !/\s/.test(str.charAt(b))) b++;
  return str.slice(a, b);
};

/**
 * 弱键名键值规则：`session` / `sid` / `cookie` / `jwt` / `sig` / `nonce` / `csrf` …
 *
 * 【为什么弱键名要单列一条】
 *   这些词在英文句子里太常见（`session 已过期`、`pass the test`），
 *   所以它们**必须带显式分隔符**（`=`/`:`），**不走**强键名那条"空格也算分隔符"的分支。
 *
 * 【一次被反控推翻的设计（记下来，别改回去）】
 *   第一版为了防误伤，要求弱键名**从词边界开始**（键名必须**以** `session`/`sid` 开头）。
 *   反控"把这条约束摘掉"跑出来 **116 通过 / 0 失败** —— 一条都没红。
 *   排查后发现：约束摘掉也不会误伤 `resident=1` / `consider=yes`，因为
 *   **真正的守卫是"键名必须在分隔符处结束"**（`resident` 里 `sid` 后面跟的是 `ent`，不是 `=`）。
 *   而那条约束却实打实地**漏了 6 种真实形态**（探针实测）：
 *     `PHPSESSID=…`、`JSESSIONID=…`、`connect.sid=…`（带前缀）、
 *     `session_id=…`、`session-id=…`（带后缀）、`mysid=…`
 *   ⇒ 改成和强键名一致的**宽前缀 + 可选后缀**，只保留"必须显式分隔符"这一条真守卫。
 *   教训：反控跑出"零失败"不等于反控写坏了，也可能是**被摘掉的那条东西本来就不承重**——
 *         那就该把它删掉，而不是给反控补一条能红的靶子。
 */
const SECRET_WEAK_KEY_ALT = '[A-Za-z0-9_.\\-]*(?:'
  + 'session|sessionid|sessid|sid|cookie|jwt|sig|signature|nonce|csrf|xsrf'
  + ')(?:[_-]?(?:id|token|key|value|s))?';

const SECRET_WEAK_KV_RE = new RegExp(
  '(^|[^A-Za-z0-9_.\\-])(' + SECRET_WEAK_KEY_ALT + ')'
  + '(["\\\']?[ \\t]*(?:[:=：＝]|=>)[ \\t]*["\\\']?)'
  + '("[^"\\n]*"|\\\'[^\\\'\\n]*\\\'|[^\\s"\\\',;}\\]&]+)',
  'gi'
);

/**
 * 不碰 base64 的一整套规则（`redactSecrets` 的 base64 兜底要靠它来判断"解码后是否含凭据"，
 * 分成两层是为了**避免递归**）。
 * @param {string} input
 * @returns {string}
 */
function redactCore(input) {
  let s = String(input == null ? '' : input);
  if (!s) return '';

  // ① 私钥块：先吃"BEGIN…END"整块，再兜底吃孤立头（正文可能被截断，END 丢了）
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '-----PRIVATE-KEY-REDACTED-----');
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, '-----PRIVATE-KEY-REDACTED-----');

  // ② URL/DSN 凭据。userinfo 取"到最后一个 `@` 为止"的整段 ——
  //    这样 `mysql://root:MyP@ssw0rd@10.0.0.1/db` 的密码含 `@` 也不会留下后半截。
  s = s.replace(/(^|[^A-Za-z0-9+.\-])([A-Za-z][A-Za-z0-9+.\-]*):\/\/([^\s/?#]*@)/g,
    (_m, pre, scheme, userinfo) => pre + scheme + '://' + (userinfo.indexOf(':') >= 0 ? '***:***@' : '***@'));

  // ③ 已知前缀
  s = s.replace(/\b(sk|rk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{6,}/g, (_m, p) => p + '-***'); // Stripe
  s = s.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{4,}/g, (_m, p) => p + '-***');        // OpenAI/Anthropic 等
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, 'gh*_***');                        // GitHub
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, 'github_pat_***');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, 'xox-***');                      // Slack
  s = s.replace(/\bAKIA[0-9A-Z]{12,}/g, 'AKIA***');                                // AWS access key id
  s = s.replace(/\bASIA[0-9A-Z]{12,}/g, 'ASIA***');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{16,}/g, 'AIza***');                           // Google
  s = s.replace(/\bglpat-[A-Za-z0-9_-]{8,}/g, 'glpat-***');                        // GitLab
  s = s.replace(/\bnpm_[A-Za-z0-9]{16,}/g, 'npm_***');
  s = s.replace(/\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'SG.***');          // SendGrid
  s = s.replace(/\bAC[0-9a-fA-F]{32}\b/g, 'AC***');                                // Twilio account SID
  // HTTP 认证方案后面的那串就是凭据本身（`Basic base64(user:pass)` 也在这里被吃）。
  // ⚠️ `Token` 是**英文常用词**：`Token notes.md` 这种文件名会被这条规则整个吃掉
  //    （复验方 P1 的孪生形态 —— 同为"把文件名当凭据"，所以共用 `looksLikePathToken` 同一个判据）。
  //    方案名大小写不敏感是为了吃 `bearer`，但值必须"不像文件名/路径"。
  s = s.replace(/\b(Bearer|Basic|Token|Digest|ApiKey)\s+([A-Za-z0-9._\-+/=]{4,})/gi,
    (m, scheme, val) => (looksLikePathToken(val) ? m : scheme + ' ***'));
  // JWT（三段式 base64url）
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, 'eyJ***');

  // ④ 键值邻近（强键名：保留键名与包裹引号，只换值）
  //
  // ⚠️ 「空格也算分隔符」这一支**必须收紧**（复验方实测：它把文件名吃掉了）。
  //    指纹段的真实一行是 `- password list.html（2048 B，2026-11-04T02:10:19.859Z）`，
  //    文件名就叫 `password list.html` —— 宽口径会把文件名连同字节数一起打掉。
  //    收紧规则（两条，与复验方给的口径一致）：
  //      ① **flag 形态**（`--password` / `-p`）⇒ 无论值长什么样都打（那是真正的命令行参数位）；
  //      ② **裸键名 + 空格** ⇒ 值必须"像凭据"才打：长度 ≥ 6 且不像文件名/路径。
  //    显式分隔符（`=` / `:` / 全角冒号）那一支**不收紧** —— `DB_PASSWORD=x` 没有歧义。
  s = s.replace(SECRET_KV_RE, (m, pre, key, sep, val) => {
    const first = val.charAt(0);
    const wrapped = (val.length >= 2 && (first === '"' || first === "'") && val.charAt(val.length - 1) === first);
    const sepIsSpaceOnly = !/[:=：＝]/.test(sep);
    const isFlagForm = /^-{1,2}/.test(key);
    if (sepIsSpaceOnly && !isFlagForm) {
      const inner = wrapped ? val.slice(1, -1) : val;
      const looksSecret = inner.length >= 6 && !FILE_EXT_RE.test(inner) && !looksLikePathToken(inner);
      if (!looksSecret) return m;   // 像文件名/路径、或太短 ⇒ 不动（保住产物指纹段）
    }
    return pre + key + sep + (wrapped ? first + '***' + first : '***');
  });

  // ⑤ 键值邻近（弱键名：**只认** `=`/`:`，键名允许宽前缀与 `_id`/`_token` 之类的后缀）
  s = s.replace(SECRET_WEAK_KV_RE, (m, pre, key, sep, val) => {
    const first = val.charAt(0);
    const wrapped = (val.length >= 2 && (first === '"' || first === "'") && val.charAt(val.length - 1) === first);
    return pre + key + sep + (wrapped ? first + '***' + first : '***');
  });

  // ⑥ CLI 短参数携带的口令。三种形态，各有守卫：
  //    a) `-p<紧贴值>`：`mysql -pS3cr3t`；紧贴形态几乎不存在非口令用法 ⇒ 直接打
  //       （`mkdir -p out` 是**分离**形态，不会走到这条）
  //    b) `-p <分离值>`：`sshpass -p hunter2 ssh …`，但 `-p` 后面跟目录名极常见
  //       （`mkdir -p target`），所以值必须**同时**满足三条才打：
  //       不含路径分隔符、**既有数字又有字母**、长度 ≥6 —— 三条缺一就会误伤构建脚本。
  //       `scripts/smoke/unit-handoff-redact.mjs` 的 K21 专门隔离"路径"这一条（值带数字且有 `/`）。
  //    c) `-u 用户:口令`：`curl -u admin:Passw0rd123` ⇒ 保留用户名，只打口令
  s = s.replace(/(^|\s)(-[uU]\s+)([^\s:]+):([^\s]+)/g,
    (_m, pre, flag, user) => pre + flag + user + ':***');
  s = s.replace(/(^|\s)(-[pP])([^\s\-][^\s]*)/g, (_m, pre, flag) => pre + flag + '***');
  s = s.replace(/(^|\s)(-[pP]\s+)([^\s]+)/g, (m, pre, flag, val) => {
    if (/[/\\]/.test(val)) return m;                                  // 路径 ⇒ 不是口令
    if (!/[0-9]/.test(val) || !/[A-Za-z]/.test(val)) return m;        // 纯字母/纯数字 ⇒ 多半是目录名
    if (val.length < 6) return m;
    return pre + flag + '***';
  });

  // ⑦ 长十六进制：保留前 4 后 4，中间 `***`。**两条豁免**（顺序即优先级）：
  //    a) **带已知扩展名的文件名**（主）：打码会让"指针失效"（`out/a1b2***5678.js` 谁都打不开）。
  //       ⚠️ 判据**只有扩展名这一条**，不看有没有 `/`：`out/<hex>.bin` 与裸 `<hex>.bin` 一样打码。
  //       先前那条"前 20 字符内有指纹标签"为什么不成立：真实指纹段的标签在**段首那一行**，
  //       离 hex 有 40+ 字符 ⇒ 在真实形态下永远不触发（复验方实测）。
  //       后来那条"含 `/` 即路径"为什么也删了：位置判据，实测把 `out/<32hex>.bin` 整串放行（已踩过）。
  //    b) 指纹标签在**同一行**内 20 字符里（辅）：`sha1 <hex>`、`md5:<hex>` 这种紧邻写法仍要认，
  //       否则"另一条功能印出来的 sha1"会被打码。⚠️ 只认同一行 —— 段首标签不许跨行开后门。
  //    阈值 24（会话串常态长度）：宁可多打一条 mongo id，也不漏一条 session。
  //
  //  ⚠️ 曾经还有第三条豁免：「紧邻 `（`/`(`/`- ` 这类行内分隔就不打码」（复验方 P2 建议）。
  //    实测**必须删掉**：`unit-second-runner` 的 R27b 把 32 位会话串放进指纹段的**文件名**里，
  //    渲染出来是 `   - <hex>.bin（7 B，<ISO>）` —— 前面正好是列表标记 `- `，
  //    于是这条豁免把一条真凭据护住了（325/1，漏出 d41d8cd9…427e）。
  //    根因：列表标记 `- ` 只是排版，标记后面的内容**可能是路径也可能是凭据**；
  //    真正决定"要不要打码"的应当是 token 自己的形状（a 条），不是它前面有没有装饰。
  //    删掉之后：路径照样由 a 条保住（路径必带 `/` 或扩展名），而裸 hex 无论排在哪都打码。
  s = s.replace(/\b[0-9a-fA-F]{24,}\b/g, (m, offset, whole) => {
    const str = String(whole);
    const tok = expandToken(str, offset, offset + m.length);
    if (looksLikePathToken(tok)) return m;                          // a) 产物路径：不许打码
    const ctx = labelContext(str, offset);
    if (FINGERPRINT_HINT_RE.test(ctx)) return m;                    // b) 指纹标签紧邻（**同一行内**）
    return m.slice(0, 4) + '***' + m.slice(-4);
  });

  return s;
}

/**
 * 疑似 base64 块（长度 ≥16 的 base64 字符连续串）。
 * ⚠️ 后面还会用"像不像 hash / 有没有指纹标签"把它排除掉，见 `redactSecrets`。
 */
const B64_CANDIDATE_RE = /[A-Za-z0-9+/]{16,}={0,2}/g;

/**
 * 对外入口：`redactCore` + base64 兜底。
 *
 * base64 兜底的判据（三道闸，缺一道就会把正文里正常的紧排文本误伤）：
 *   ① 不是纯十六进制（纯 hex 是 hash，归 ⑤ 管）；
 *   ② 前面 20 字符内没有产物指纹标签（`sha1 …` 这种不许碰）；
 *   ③ 解码结果"看起来像文本"（没有控制字符 / 替换符），**且解码后再跑一遍规则会被改动**
 *      ⇒ 说明它里面真的包着凭据 ⇒ 整块打码。
 *
 * @param {unknown} text
 * @returns {string}
 */
function redactSecrets(text) {
  const s = redactCore(text);
  if (!s) return '';
  return s.replace(B64_CANDIDATE_RE, (m, offset, whole) => {
    if (/^[0-9a-fA-F]+$/.test(m)) return m;                       // 闸①：纯 hex 不是 base64
    const ctx = labelContext(String(whole), offset);
    if (FINGERPRINT_HINT_RE.test(ctx)) return m;                   // 闸②：产物指纹豁免（**同一行内**）
    let dec = '';
    try { dec = Buffer.from(m, 'base64').toString('utf8'); } catch { return m; }
    if (!dec || dec.length < 6) return m;
    // 闸③：解码结果必须是可读文本（二进制块不动 —— 那是文件内容，不是凭据）
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(dec)) return m;
    if (redactCore(dec) === dec) return m;                         // 解码后没有凭据 ⇒ 放过
    return '***';
  });
}

/**
 * 五个动作类别。**刻意不在这里重新定义值域**：调用方传入全量，本模块只做差集。
 *
 * 为什么不在本模块 import `toolProtocol.RECOVERY_ACTION`：
 *   `toolProtocol` 将来要在熔断处引用本模块的话，反向 import 会成环
 *   （Node 的循环 require 会让其中一方拿到半截 exports，症状是"某个函数是 undefined"，
 *    而且要跑起来才报，非常难查）。所以值域由调用方给，本模块只消费。
 */

/**
 * 生成交接单。
 *
 * @param {{
 *   strategies?: Array<{sig?:string, tool?:string, count?:number, total?:number, lastKind?:string,
 *                       refuted?:boolean, stale?:boolean, refuteScope?:string,
 *                       lastError?:string, nextAction?:string,
 *                       stateKnown?:boolean}>,
 *   availableTools?: string[],
 *   actionsUsed?: string[],
 *   actionsAll?: string[],
 *   actionLabel?: Record<string,string>,
 *   kindLabel?: (k:string)=>string,
 *   unfinished?: Array<string|{step?:string, text?:string, label?:string}>,
 *   unfinishedMax?: number,
 *   unfinishedItemMax?: number,
 *   trigger?: string
 * }} input
 *   `strategies` 直接喂「账本里所有失败过的策略」即可，本模块自己分拣；
 *   `actionsUsed` 由调用方从 recoveryStrategyFor 汇总（**判定仍归 toolProtocol**，这里只做差集）。
 *   `availableTools` = 接手者**手里有哪些工具**（第二执行实例必须传，它拿到的是缩小后的工具集）。
 *     不传 ⇒ 一律视为可用（行为与改造前逐字相同）。
 *   `stateKnown` = **这个 count 是不是"同一个状态"里数出来的**（由账本声明）。
 *     `true` = live 账本（键带状态指纹）⇒ 正文可写「同一状态下已失败 N 次」；
 *     缺省 / `false` = 拿不出状态指纹（如磁盘预热账）⇒ 正文只许写「累计失败 N 次（跨请求账，无状态指纹）」。
 *     缺省取 false 是**保守方向**：不知道就不许声称。
 *   `refuteScope` = 这条否定结论**管到哪儿**（账本标：live = 'this-run' / seeded = 'disk'）。
 *     ⚠️ 它只决定正文那句「适用范围」，**不参与**"进不进禁令"的判定（判据只有 refuted && !stale）。
 *   `unfinished` = 「前任自己列进计划、但没交付的事」（backend 的 `openFailures()`）。
 *     元素允许纯字符串或 `{step}` / `{text}` / `{label}` 对象；空数组 ⇒ 整段不出现。
 *     `unfinishedMax`（默认 20）= 条数上限，**超出部分会在正文里写明「另有 N 条未展开」**（不许静默丢）；
 *     `unfinishedItemMax`（默认 240）= 单条字符上限，超长**就地截断**（保留开头 + `…`）。
 *     ★ 本模块**只渲染、不生产**：传值由接线方负责（拿不到就是空数组），这里绝不替它编。
 * @returns {null | {
 *   forbidden: Array<{sig:string, tool:string, lastKind:string, lastError:string, nextAction:string,
 *                     refuteScope:string, countText:string}>,
 *   outOfReach: Array<{sig:string, tool:string, lastKind:string, lastError:string, nextAction:string,
 *                      refuteScope:string}>,
 *   tried: Array<{sig:string, tool:string, count:number, total:number, lastKind:string,
 *                 lastError:string, usable:boolean, stateKnown:boolean}>,
 *   notTried: string[],
 *   unfinished: string[],
 *   unfinishedDropped: number,
 *   truncated: boolean,
 *   text: string
 * }} 无交接必要 ⇒ null
 *   ⚠️ 所有对外字段（含 `forbidden[i].lastError` / `nextAction`）**都是脱敏后的值** ——
 *   不是"只有拼好的 text 干净、对象层还是明文"（复验方 B7）。
 *   `truncated` 是**真布尔**（内容是否被删减），不是从正文里找那句话（复验方 B8）。
 */
function buildHandoffBrief(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const list = Array.isArray(i.strategies) ? i.strategies : [];
  const kindLabel = typeof i.kindLabel === 'function' ? i.kindLabel : ((k) => String(k || '未定性'));
  const labelOf = (i.actionLabel && typeof i.actionLabel === 'object') ? i.actionLabel : {};

  /**
   * ★★ 2026-02-16（独立验收受控实测）：**接手者手里有没有这个工具**。
   *
   * 实测形态：账本里 3 条（file-search ×2 / web-fetch ×2 / file-write ×2），
   * 而替补只拿到 [file-write, file-read, shell-exec] —— 3 条里 **2 条是纯噪声**，
   * 而且恰好就是 `DELEGATE_DENY_TOOLS` 明确剔掉的那一族。
   * 危害不是"数字难看"：搜索类失败正是"有动作无进展"最常见的成因，
   * 于是多数真实场景下交接单大半是**替补无法重放、也无法"换个条件再试"的空话**。
   * ⇒ 对不可用的条目**改口**：不说"别再用 X"（它压根用不了），而说清"这条路你手里没有，
   *   请说明你打算怎么绕" —— 用它**提要求**，而不是用它**禁止**。
   *
   * 缺省（不传 `availableTools`）⇒ 一律视为可用，行为与改造前**逐字相同**：
   * 主实例那条接线（续跑注入）不该因为替补特有的概念而变。
   */
  const toolAvail = Array.isArray(i.availableTools)
    ? new Set(i.availableTools.map((x) => String(x || '').trim()).filter(Boolean))
    : null;
  const usableOf = (tool) => (toolAvail ? toolAvail.has(tool) : true);

  const forbidden = [];
  const outOfReach = [];  // 已证伪、但接手者**手里没有**这个工具 ⇒ 不是禁令，是"你得绕"
  const tried = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const sig = String(s.sig || '').trim();
    const n = Number(s.count) || 0;
    if (!sig || n <= 0) continue;   // 没失败过 / 算不出 key ⇒ 不是一条交接信息
    const tool = String(s.tool || sig.split('|')[0] || '').trim();
    const lastKind = String(s.lastKind || 'unknown');
    /**
     * ★★ 2026-02-16（复验方 B2，实测泄漏）：**先脱敏，再截断**。
     *
     * 原来是 `String(s.lastError).slice(0, 140)` 先截，出口再整段脱敏。后果不是理论问题：
     *   原文 = `'A'×120 + ' mysql://root:S3cr3tPassw0rd@10.0.0.1/db'`
     *   截断后 = `…AAAA mysql://root:S3cr3t`   ← `@` 被切掉 ⇒ 连接串规则不匹配
     *   ⇒ 密码前缀原样进了发往模型网关的正文。
     *   同类：40 位 hex 被切到 19 位之后就不再匹配 `{32,}`，19 位原文照留。
     *
     * 所以顺序只能是「**先整串脱敏 → 再截断**」：脱敏打过码的那一段最多变成 `***`，
     * 后面怎么切都不再有秘密可言。⚠️ 这条顺序**不许**为了任何理由调回去。
     *
     * 同时这也解决了 B7：`forbidden/outOfReach/tried` 里的 `lastError`/`nextAction`
     * **字段本身**就是脱敏后的值 —— 不是"只有拼好的 text 干净，对象层还是明文"。
     * 今天 trace 只落工具名所以没漏，但那是"下一行代码就会漏"的形态。
     */
    const lastError = redactSecrets(String(s.lastError || '')).slice(0, 140);
    const nextAction = redactSecrets(String(s.nextAction || '')).slice(0, 140);
    // ★ 两个次数的**维度必须分开写**（独立验收实测：把 count 当成"总次数"会讲假话）。
    //   count = **同一状态桶**内的次数（与账本拦不拦它是同一个维度，见 file 头注「两个 count 不许混用」）
    //   total = **跨状态**合计（换过命令/换过产物字节都算换状态），只作补充说明。
    const total = Number(s.total) > 0 ? Number(s.total) : n;
    /**
     * ★★ 这个数字**到底是不是"同一个状态"里数出来的** —— 由账本声明，本模块不许自己假设。
     *
     * 复验方实测的生产形态（seeded 预热账，比 live 更常见）：
     *   `count=2 / histCount=3 / total=3` 被写成「**同一状态下**已失败 3 次」——
     *   那 3 次其实是**跨状态累计**。磁盘账按签名累加、键里没有状态指纹 ⇒
     *   "同一状态撞了几次"这个维度在预热账上根本不存在。
     *
     * 所以缺省是 **false（不许声称）**：拿不出"状态已知"的证据，就不许在正文里写"同一状态下"。
     * 只有账本显式 `stateKnown: true`（live 账本，键是 `sig#stateKey`）才走同一状态措辞。
     */
    const stateKnown = s.stateKnown === true;
    // ★ 这条账是**从哪来的**（live = 本次运行 / seeded = 磁盘跨请求预热）。
    //   它只影响"没有状态指纹时"那句补充该怎么写：本次的账不能说成"跨请求账"（那是另一句假话）。
    const from = String(s.from || '');
    /**
     * ★★ 2026-02-16（交接单「适用范围」）：这条否定结论**管到哪儿**。
     *   `'this-run'` = 本次运行里刚验证不通（账本 liveList 判的）；
     *   `'disk'`     = 历史请求里验证不通（账本 seededList 判的）；
     *   `''` / 其它  = 来源未标注（老调用点 / 手写条目）⇒ 正文不许替它编一个范围。
     * ⚠️ 它**只影响正文那句话**，不参与"要不要进禁令"的判定 —— 判据是 `refuted && !stale`，
     *   见下面那行；不许再加"scope 必须是 disk"之类的额外条件（那正是红线一）。
     */
    const refuteScope = String(s.refuteScope || '');
    const usable = usableOf(tool);
    // ★ stale 的**不算禁令**：那是"代码/环境已经变了，旧结论作废"。
    //   把它写成"不要再用"会把替补推回老板批过的那个病 —— 一次历史失败永久封路。
    if (s.refuted === true && s.stale !== true) {
      if (usable) forbidden.push({ sig, tool, lastKind, lastError, nextAction, count: n, total, stateKnown, from, refuteScope });
      else outOfReach.push({ sig, tool, lastKind, lastError, nextAction, count: n, total, stateKnown, from, refuteScope });
    } else {
      tried.push({ sig, tool, count: n, total, lastKind, lastError, usable, stateKnown, from, refuteScope });
    }
  }

  // 动作类别的差集：用过的排除掉，剩下的才是"你还可以往这个方向走"。
  const used = new Set((Array.isArray(i.actionsUsed) ? i.actionsUsed : []).map((x) => String(x || '').trim()).filter(Boolean));
  const all = (Array.isArray(i.actionsAll) ? i.actionsAll : []).map((x) => String(x || '').trim()).filter(Boolean);
  const notTried = all.filter((a) => !used.has(a));

  // ★ 交接必要性：既没有硬禁令、也没有"同策略反复失败"、也没有"你手里没有的那条路"，就没有必要交接。
  //   实测形态：偶发一次超时不该被当成"前任失败过"来讲 —— 那会让替补畏手畏脚。
  //   **`repeated` 用每一行自己的 `count`**，而账本给的是**两个来源各一行**（见 `handoffList()`）：
  //     · seeded 行：count = 磁盘按签名累计的次数 ⇒ 正文「累计失败 N 次（跨请求账，无状态指纹）」；
  //     · live 行：count = **本次运行**的次数（账本 `liveCounts`）⇒ 正文「本次运行中同一状态下已失败 N 次」。
  //   两行都是"正文上那个 N ≥ 2 才算反复"，所以判据与措辞同源。
  //   🔴 不许再把两个来源**覆盖成一个数**：上一版把 histCount 覆盖成本次的 1 次 ⇒
  //   「预热 3 次 + 本次 1 次」被判成"没反复" ⇒ brief=null（生产里这是**唯一**出单路径）。
  //   跨状态合计（`total`）只在 live 分支当补充读数，**不参与**这个判断。
  const repeated = tried.some((t) => t.count >= 2);
  if (!forbidden.length && !outOfReach.length && !repeated) return null;

  /**
   * 次数怎么说 —— **先说清这个数字是哪个来源、哪个维度数出来的，再说数字**。
   *
   * 来源**三支各写各的，不许落进一个 else**（复验方第三轮就是靠这一格抓到"把一句假话
   * 换成另一句"：`from` 只分了 `=== 'live'` 与"其余"两支，于是 `'seeded+live'` 落进 else，
   * 那个 N 明明是本次的次数，却被说成"跨请求账"）：
   *   · `live`    = 本次运行（账本的 `liveCounts` 数出来的，见 toolProtocol 里 liveCounts 头注）
   *   · `seeded`  = 磁盘跨请求预热账（按签名累计，没有状态维度）
   *   · `unknown` = 没标来源 ⇒ **不许猜它是哪一段的**，就写"来源未标注"
   * 状态维度另说（`stateKnown`）：只有桶键真的带 `#` 才许写"同一状态下"。
   *
   * 为什么 live 那句必须带「本次运行中」：交接单里同一个工具**可能出现两行** ——
   * 上次一行（`累计失败 5 次（跨请求账）`）、本次一行（`本次运行中同一状态下已失败 2 次`），
   * 见 `handoffList()` 头注。两行都只说"已失败 N 次"而不说是哪一次运行的，等于又把账说混。
   */
  const countText = (t) => {
    const from = (t.from === 'live') ? 'live' : ((t.from === 'seeded') ? 'seeded' : 'unknown');
    if (!t.stateKnown) {
      const scope = (from === 'live') ? '本次运行累计'
        : ((from === 'seeded') ? '跨请求账' : '来源未标注');
      return '累计失败 ' + t.count + ' 次（' + scope + '，无状态指纹）';
    }
    const base = ((from === 'live') ? '本次运行中同一状态下已失败 ' : '同一状态下已失败 ') + t.count + ' 次';
    // 状态已知时只剩一种来源可能：磁盘账恒 `stateKnown:false`（见 seededList），
    // 所以没标 `from` 也不会把"跨请求账"说成"同一状态"—— 这一支不牵扯"哪一段时间"。
    return (t.total > t.count) ? (base + '（跨状态合计 ' + t.total + ' 次）') : base;
  };

  // ★ 次数那句话渲染时才用得上，但**判定**不用它 ⇒ 在渲染前统一补齐（一处口径）。
  for (const f of forbidden) f.countText = countText(f);

  /**
   * 适用范围的人话标签。
   *   this-run ⇒ 本次运行已验证不通（禁令只限这一次执行）
   *   disk     ⇒ 历史请求里验证不通（来自跨请求旧账）
   *   其它     ⇒ 空串：**不许替它编一个范围**（老调用点/手写条目没有这个信息）
   */
  const scopeLabel = (scope) => (scope === 'this-run'
    ? '本次运行已验证不通'
    : ((scope === 'disk') ? '历史请求里验证不通' : ''));

  /**
   * 「还没做完的事」—— 入参 `unfinished`，元素允许 `{step}` / `{text}` / `{label}` / 纯字符串。
   *
   * 为什么这段**必须活到最后**：它是唯一"接下来该做什么"的信息，
   * 前面那些段（禁令/试过/未试方向）都是"别做什么"。cap 之后把它砍掉，
   * 等于把交接单里唯一的前进方向砍掉 —— 那正是老板批过的"最后只剩下做不了"。
   *
   * ★★ 2026-02-16（复验方 B4）两条硬纪律，都与"别静默丢东西"有关：
   *   ① **不许静默丢条目**：上限要么做成显式参数（`unfinishedMax`，默认 20），
   *      要么在正文写「另有 N 条未展开」。上一版是 `slice(0,8)` 收货 + `slice(0,6)` 渲染，
   *      10 条只出 6 条、另外 4 条连个数都不给 —— 读的人会以为事情只剩 6 件。
   *   ② **单条超长就地截断**（保留开头可读部分 + `…`），不许把整段换成
   *      "（内容过长，详见 trace）"这种指针 —— 那是把唯一的前进方向换成了一个地址。
   *   两个上限（收货 / 渲染）现在**只有一个真源**：`UNFINISHED_MAX`。
   */
  const UNFINISHED_MAX = (Number(i.unfinishedMax) > 0 ? Math.floor(Number(i.unfinishedMax)) : 20);
  const UNFINISHED_ITEM_MAX = (Number(i.unfinishedItemMax) > 0 ? Math.floor(Number(i.unfinishedItemMax)) : 240);

  /** 单条就地截断（先脱敏再截断：顺序与 lastError 同一条纪律，见上面 B2 那段）。 */
  const clipText = (x, max) => {
    const s = String(x == null ? '' : x).trim();
    const cap = (Number(max) > 8) ? Math.floor(Number(max)) : 8;
    return (s.length <= cap) ? s : (s.slice(0, cap - 1) + '…');
  };

  const rawUnfinished = (Array.isArray(i.unfinished) ? i.unfinished : [])
    .map((x) => {
      if (x == null) return '';
      if (typeof x === 'string') return redactSecrets(x).trim();
      if (typeof x === 'object') {
        const v = (typeof x.step === 'string' && x.step)
          || (typeof x.text === 'string' && x.text)
          || (typeof x.label === 'string' && x.label)
          || '';
        return redactSecrets(String(v)).trim();
      }
      return redactSecrets(String(x)).trim();
    })
    .filter(Boolean);
  const unfinishedList = rawUnfinished.slice(0, UNFINISHED_MAX);
  const unfinishedDropped = Math.max(0, rawUnfinished.length - unfinishedList.length);

  const UNFINISHED_HEAD = '· **还没做完的事**（前任自己列进计划、但没交付的 —— 接手时一并考虑，别当成已经做完了）：';

  /**
   * 渲染「还没做完的事」。`itemMax` 由 cap 逐级压小（240 → 120 → 60 → 24 → 8），
   * 但**任何一级都不许把条目丢掉不说**：`dropped > 0` 时必带一行「另有 N 条未展开」。
   *
   * @param {number} itemMax 单条字符上限
   * @returns {string}
   */
  const buildUnfinishedBlock = (itemMax) => {
    if (!unfinishedList.length && unfinishedDropped <= 0) return '';
    const lines = [UNFINISHED_HEAD];
    for (const x of unfinishedList) lines.push('   - ' + clipText(x, itemMax));
    if (unfinishedDropped > 0) {
      lines.push('   - （另有 ' + unfinishedDropped + ' 条未展开 —— 是篇幅上限，不是没有）');
    }
    return lines.join('\n');
  };

  /**
   * ★★ 总长硬上限（老板批过长篇大论；而"每节最多 5 条"只管单节，满配仍有 5-6 KB）。
   * 6000 字是"能读完"与"信息够用"的折中：正文最终会进替补的种子 prompt。
   */
  const CAP = 6000;

  /**
   * ★★ 「适用范围」的一行总述（复验方 B3：**硬截之后也必须活下来**）。
   *
   * 为什么它比"每节几条"更重要：禁令一旦失去适用范围说明，替补就会把
   * "历史请求里验证不通"读成"现在也不通" —— 那正是老板批过的"一次历史失败永久封路"。
   * 所以它有一份**短版本**，专门给硬截兜底用（和正文里那一段是同一句话的两个粒度）。
   *
   * ⚠️ 这里**不重复工具名**：每条的适用范围已经在它自己 bullet 的尾巴上；
   *   重复工具名会把正文撑长，也会让"某工具出现在哪一行"这类判据难以对齐。
   */
  const SCOPE_ONE_LINE = (() => {
    const anyRun = forbidden.some((f) => f.refuteScope === 'this-run');
    const anyDisk = forbidden.some((f) => f.refuteScope === 'disk');
    if (!anyRun && !anyDisk) return '';
    const parts = [];
    if (anyRun) parts.push('标「本次运行已验证不通」的只限这一次执行');
    if (anyDisk) parts.push('标「历史请求里验证不通」的来自跨请求旧账');
    return '· **这些禁令的适用范围**（' + parts.join('；')
      + '；条件真的变了（换了参数/换了环境/代码改了）就说明依据再试一次，这不算违反交接）。';
  })();

  /**
   * 分段渲染。`lv` = 降级级别（0 完整 / 1 未试方向砍到 2 条 / 2 细节只留 2 条 / 3 每节只留 1 条）。
   *
   * ★ 段序是**有意的**，别随意调整：
   *   ① 历史禁令（磁盘账）→ ② 你手里没有的路 → ③ 试过但未否定 →
   *   ④ **本次运行**的禁令（放在 ③ 之后：它和 ③ 讲的是同一批行，
   *      而 ③ 里那行是"上次的次数"、④ 里是"本次的次数"，两行并排才读得通）→
   *   ⑤ 适用范围 → ⑥ 还没做完的事 → ⑦ 还没试过的方向 → 收尾要求。
   *
   * @param {number} lv 降级级别
   * @param {{omitUnfinished?:boolean, omitScope?:boolean}} [opt]
   *   硬截兜底时用：这两段会在尾部单独拼一份（避免重复），所以从"头"里摘掉。
   * @returns {string}
   */
  const compose = (lv, opt) => {
    const o = (opt && typeof opt === 'object') ? opt : {};
    const detail = (lv >= 3) ? 1 : ((lv >= 2) ? 2 : 5);   // 每节最多几条细节
    const dirMax = (lv >= 3) ? 1 : ((lv >= 1) ? 2 : 4);   // 「还没试过的方向」最多几条

    const L = [];
    L.push('【交接：上一个执行者在这个点上没走通，以下是它留下的账，不是要你再试一遍】');
    if (i.trigger) L.push('触发：' + String(i.trigger));

    // 禁令按**适用范围**分红：历史账（disk/未标注）与本次账（this-run）分开说，边界才清楚。
    const diskBan = forbidden.filter((f) => f.refuteScope !== 'this-run');
    const runBan = forbidden.filter((f) => f.refuteScope === 'this-run');

    if (diskBan.length) {
      L.push('· **已被证明走不通，不要再用**（' + diskBan.length + ' 条）：');
      for (const f of diskBan.slice(0, detail)) {
        L.push('   - ' + f.tool + '（' + kindLabel(f.lastKind) + '）'
          + (f.lastError ? '：' + f.lastError : '')
          + (f.nextAction ? ' ｜ 上次给的替代方向：' + f.nextAction : '')
          + (scopeLabel(f.refuteScope) ? ' ｜ 适用范围：' + scopeLabel(f.refuteScope) : ''));
      }
      if (diskBan.length > detail) L.push('   - （另有 ' + (diskBan.length - detail) + ' 条同类，略）');
    }

    if (outOfReach.length) {
      // ★ 这一块是**要求**不是禁令：它连重放都做不到，说"不要再用"等于说了句废话。
      L.push('· **这些路你手里没有**（' + outOfReach.length + ' 条，工具不在你的工具集里 —— '
        + '前任在这些路上撞过墙，而你连重放都做不到）：');
      for (const f of outOfReach.slice(0, detail)) {
        L.push('   - ' + f.tool + '（' + kindLabel(f.lastKind) + '）'
          + (f.lastError ? '：' + f.lastError : '')
          + ' ⇒ 这个工具**你手里没有**；别把时间花在它身上；请直接说明你打算**怎么绕开这一类动作**。'
          + (scopeLabel(f.refuteScope) ? ' ｜ 适用范围：' + scopeLabel(f.refuteScope) : ''));
      }
      if (outOfReach.length > detail) L.push('   - （另有 ' + (outOfReach.length - detail) + ' 条同类，略）');
    }

    if (tried.length) {
      L.push('· 试过但**还没被否定**（可以再用，但必须换条件，不能原样重来）：');
      for (const t of tried.slice(0, detail)) {
        L.push('   - ' + t.tool + ' ' + countText(t) + '（' + kindLabel(t.lastKind) + '）'
          + (t.lastError ? '：' + t.lastError : '')
          + (t.usable ? '' : ' ｜ ⚠️ 这个工具**你手里没有** ⇒ 不用重放，说明你打算怎么绕'));
      }
      if (tried.length > detail) L.push('   - （另有 ' + (tried.length - detail) + ' 条，略）');
    }

    if (runBan.length) {
      L.push('· **本次运行已验证不通，不要再用**（' + runBan.length
        + ' 条 —— 前任在**这一次运行里刚撞过**，条件大概率没变，别照着原样再试一遍）：');
      for (const f of runBan.slice(0, detail)) {
        L.push('   - ' + f.tool + ' ' + f.countText + '（' + kindLabel(f.lastKind) + '）'
          + (f.lastError ? '：' + f.lastError : '')
          + ' ｜ 适用范围：本次运行已验证不通'
          + (f.nextAction ? ' ｜ 上次给的替代方向：' + f.nextAction : ''));
      }
      if (runBan.length > detail) L.push('   - （另有 ' + (runBan.length - detail) + ' 条同类，略）');
    }

    // ★ 「适用范围」段：让替补知道每条禁令的**边界**（本次 vs 历史），
    //   否则"不要再用"会被它读成永久封路（那是老板批过的病）。
    if (SCOPE_ONE_LINE && o.omitScope !== true) L.push(SCOPE_ONE_LINE);

    if (o.omitUnfinished !== true) {
      const ub = buildUnfinishedBlock(UNFINISHED_ITEM_MAX);
      if (ub) L.push(ub);
    }

    if (notTried.length) {
      L.push('· **还没试过的方向**（按这个顺序考虑，别在已否定的方向上再花时间）：');
      notTried.slice(0, dirMax).forEach((a, k) => {
        L.push('   ' + (k + 1) + '. ' + (labelOf[a] || a));
      });
    }

    L.push('· 你接手的第一件事：说清你打算走**哪一条还没试过的方向**、为什么这次会不一样。');
    L.push('· 如果这几条方向你都判断走不通，就直接说"这个任务在当前条件下做不了"，并**逐条说明每条为什么不行**'
      + ' —— 那也是有价值的结论，比再撞一次墙强。');
    return L.join('\n');
  };

  /**
   * ⚠️ 脱敏必须在**量长度之前**做：红线二要求"所有写进正文的 lastError/nextAction 都先过 redactSecrets"，
   *   如果把脱敏留到最后、而 cap 先按原文量长度，就会出现"cap 之后又变短/变长"的口径漂移。
   *   （字段级已经在收货时就脱敏过一遍，这里是**第二道**，防的是 `kindLabel`/`trigger` 这类旁路。）
   */
  const composeRedacted = (lv, opt) => redactSecrets(compose(lv, opt));

  let text = composeRedacted(0);
  let level = 0;
  for (const lv of [1, 2, 3]) {
    if (text.length <= CAP) break;
    text = composeRedacted(lv);
    level = lv;
  }

  /**
   * ★★ `truncated` 是**真布尔**，不是"正文里有没有那句提示"（复验方 B8）：
   *   用 `text.indexOf('（交接内容过长，已截断）') >= 0` 判定的话，
   *   只要某条 `lastError` 自带这句话就能骗过它 —— 那是把读数建在被检查的内容上。
   *   现在的语义：**内容有没有被删减**（降级到 lv>0 也算，因为条目真的少了）。
   */
  let truncated = level > 0;

  /**
   * ★★ 兜底硬截（lv 3 仍然超长）。
   *
   * 优先级（复验方 B3 要求，逐条落在这里）：
   *   ① 未试方向砍到 2 条 —— lv1；
   *   ② forbidden / tried 的细节压到 2 条 + "另有 N 条" —— lv2；再压到 1 条 —— lv3；
   *   ③ 仍然超长 ⇒ 硬截**前面的部分**，并追加「（交接内容过长，已截断）」；
   *      但这两段**不参与被截**，而是**单独拼在尾部**：
   *        · 「这些禁令的适用范围」（失去它 = 禁令变成永久封路）
   *        · 「还没做完的事」（失去它 = 只剩"别做什么"）
   */
  if (text.length > CAP) {
    truncated = true;
    const notice = '（交接内容过长，已截断）';
    const reserveHead = 240;   // 给"头"留个下限，否则尾部说明会把正文挤成一句话
    let tail = '';
    // 逐级压小单条上限（不许整段换占位句）；任何一级都保留「另有 N 条」的显式说明
    for (const itemMax of [UNFINISHED_ITEM_MAX, 120, 60, 24, 8]) {
      tail = [SCOPE_ONE_LINE, buildUnfinishedBlock(itemMax), notice].filter(Boolean).join('\n');
      if (tail.length + reserveHead <= CAP) break;
    }
    const budget = Math.max(0, CAP - tail.length - 2);
    let head = composeRedacted(3, { omitUnfinished: true, omitScope: true });
    if (head.length > budget) {
      let cut = head.slice(0, budget);
      const nl = cut.lastIndexOf('\n');
      // 只在"切在行首不吃掉大半内容"时才按行边界切，否则宁可切在半句上（也要守住 cap）
      if (nl > budget / 2) cut = cut.slice(0, nl);
      head = cut;
    }
    text = [head, tail].filter((x) => x !== '').join('\n');
  }
  // 兜底（理论上到不了）：极端输入下仍超 cap ⇒ 硬切。上面已保证"适用范围 + 还没做完的事"
  // 只占很小一段，所以即使走到这一步，它们也不会被整段砍掉。
  if (text.length > CAP) { text = text.slice(0, CAP); truncated = true; }

  return {
    forbidden, outOfReach, tried, notTried,
    unfinished: unfinishedList,
    unfinishedDropped,
    truncated,
    text,
  };
}

/**
 * 把「账本预热出来的失败账」直接压成一份交接单。
 *
 * ★ 为什么要有这一层（而不是让 backend 自己拼 `strategies` 数组）：
 *   backend 里那段代码在 `runAgentLoop` 的闭包里，依赖 Electron 运行时 ——
 *   单测里根本整装启动不了，于是"字段口径有没有接错"这一半**永远钉不住**。
 *   本仓在这上面栽过一次：`acceptanceToTerminal` 零生产调用点、`highRiskParallel` 零消费者，
 *   都是"写了但没接上/接错了"的类型。判定必须能被单独跑、单独变异。
 *
 * 【口径纪律：两个 count 不许混用】
 *   `count`     = 账本"还允许试几次"的额度口径（seed 时被减 1 宽容过）。
 *   `histCount` = "上任在这条路上真撞了几次"的事实口径。
 *   交接单讲的是历史，所以只认 `histCount`。用额度讲历史会把"撞了 2 次"说成 1 次，
 *   于是「反复失败」判据（count >= 2）永不成立 ⇒ 整份交接单静默不出 —— 症状是"功能在，但从不触发"。
 *
 * @param {{
 *   seeded?: Array<{sig?:string, tool?:string, count?:number, histCount?:number, total?:number,
 *                   lastKind?:string, refuted?:boolean, stale?:boolean,
 *                   lastError?:string, nextAction?:string}>,
 *   availableTools?: string[],
 *   hasToolHistory?: boolean,
 *   actionsAll?: string[],
 *   actionLabel?: Record<string,string>,
 *   kindLabel?: (k:string)=>string,
 *   actionOf?: (kind:string)=>string,
 *   trigger?: string
 * }} input
 *   `actionOf` 由调用方注入（生产环境传 `(k) => recoveryStrategyFor({kind:k}).action`）——
 *   本模块不 import toolProtocol（成环），也不自己维护 kind→动作 表（两套表必然漂移）。
 * @returns {{brief: object|null, reason: string, usedActions: string[]}}
 *   reason ∈ 'no-prev' | 'context-has-tool-history' | 'no-handoff-needed' | 'ok'
 */
function buildHandoffFromSeeded(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const seeded = Array.isArray(i.seeded) ? i.seeded : [];
  // 上次没有任何失败账 ⇒ 没有前任，也就没有交接。
  if (!seeded.length) return { brief: null, reason: 'no-prev', usedActions: [] };
  // ★ 接手者上下文里已经有过工具调用 ⇒ 那些失败过程就在它眼前，再讲一遍"上任"是往已知信息里兑水。
  //   判据用**语义**（有没有 tool 消息），不用"第几轮"这种位置判据：
  //   续跑可能在第 1 轮，同一任务连聊可能在第 9 轮，位置判据会把两种情况都判错。
  if (i.hasToolHistory === true) return { brief: null, reason: 'context-has-tool-history', usedActions: [] };

  const actionOf = typeof i.actionOf === 'function' ? i.actionOf : (() => '');
  const usedActions = [];
  for (const s of seeded) {
    if (!s || typeof s !== 'object') continue;
    let act = '';
    try { act = String(actionOf(s.lastKind) || '').trim(); } catch { act = ''; }
    if (act && usedActions.indexOf(act) < 0) usedActions.push(act);
  }

  const brief = buildHandoffBrief({
    strategies: seeded.map((s) => ({
      sig: s.sig,
      tool: s.tool,
      // 两个维度都往下传（见 buildHandoffBrief 里 countText 的口径）：
      //   count = 历史事实口径（seeded=histCount 的**累计**；live=同一状态桶次数）
      //   total = 跨状态合计（只有 live 账才有这个区分；seeded 上它等于累计）
      count: (Number(s.histCount) > 0 ? Number(s.histCount) : Number(s.count) || 0),
      total: Number(s.total) > 0 ? Number(s.total) : 0,
      /**
       * ★★ 状态指纹能不能拿出证据 —— **只有账本显式说 `true` 才算 true**。
       *
       * 这一行是「seeded 分支别再讲假话」的承重件：`seededList()` 里是 `stateKnown:false`
       * （磁盘按签名累计、没有状态指纹），于是正文只会写「累计失败 N 次（跨请求账，无状态指纹）」。
       * 若把这里写成 `s.stateKnown !== false`（或干脆不传），预热账又会声称"同一状态下" ——
       * 那正是复验方在 seeded 分支抓到的假话，而 `unit-handoff-brief` 的 E15 会因此转红。
       */
      stateKnown: s.stateKnown === true,
      // ★ 来源也要往下传：没有状态指纹时，"累计"那句的**范围**（跨请求账 / 本次运行累计）
      //   取决于这条账是谁给的（见 countText）。不传 ⇒ 本次的账会被说成"跨请求账"，又一句假话。
      from: s.from,
      lastKind: s.lastKind,
      refuted: s.refuted,
      stale: s.stale,
      // ★ 判定结论的**适用范围**（live='this-run' / seeded='disk'）必须原样往下传：
      //   丢在这里，正文就只能说"不要再用"而说不出"这条禁令管到哪儿"，
      //   替补会把一次历史失败读成永久封路（老板批过的病）。
      refuteScope: s.refuteScope,
      lastError: s.lastError,
      nextAction: s.nextAction,
    })),
    // ★ 接手者手里有哪些工具（第二执行实例必须传：它拿到的是缩小后的工具集）。
    //   不传 ⇒ 一律视为可用（主实例那条接线行为不变）。
    availableTools: i.availableTools,
    actionsUsed: usedActions,
    actionsAll: i.actionsAll,
    actionLabel: i.actionLabel,
    kindLabel: i.kindLabel,
    /**
     * ★ 「前任列进计划但没做完的事」**原样透传**。
     *   本层不生产、不推导、不补默认文案：拿不到就是空数组（`buildHandoffBrief` 里空数组 ⇒ 整段不出现）。
     *   真实数据（backend 的 `openFailures()`）由接线方在这一层之外提供 —— 见本任务的范围边界。
     */
    unfinished: i.unfinished,
    trigger: i.trigger,
  });
  if (!brief || !brief.text) return { brief: null, reason: 'no-handoff-needed', usedActions };
  return { brief, reason: 'ok', usedActions };
}

/**
 * 交接单正文的**具名出口**。
 *
 * 为什么要有这个函数，而不是在 backend 里直接写 `brief.text`：
 *   `unit-asset-registry` 的 R6d/R6e 把 backend 里 `role:'system'` 的注入点数**钉住**，
 *   那道棘轮的反向证明前提是「这些注入的 content 全是具名常量或具名函数，
 *   没有一处是按角色编号查表选出来的」。`brief.text` 这种随手取字段的形态会让
 *   "具名"这一层可读性丢失（虽然 R6f 仍会查查表形态）。走具名函数，值完全同一份。
 *
 * ⚠️ 这里**只做取值**，不做加工：一旦在这里加 trim/截断/改写，backend trace 里记的
 *   全文与模型真正看到的文本就不是同一份了 —— 而"事后能逐字核对接手者看到了什么"
 *   正是上一轮加 trace 全文的唯一目的。
 *
 * @param {null|object} brief buildHandoffBrief/buildHandoffFromSeeded 的产物
 * @returns {string} 正文；拿不到就返回空串（调用方据此不注入）
 */
function handoffBriefText(brief) {
  if (!brief || typeof brief !== 'object') return '';
  return String(brief.text || '');
}

module.exports = { buildHandoffBrief, buildHandoffFromSeeded, handoffBriefText, redactSecrets };

