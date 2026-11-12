'use strict';

/**
 * artifactCustody —— 产物保管库（内容寻址）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块（它替代的是"事前拦截"那条死路）
 * ═══════════════════════════════════════════════════════════════════════════
 * 真实缺陷：跨请求续跑时，已经把产物（典型是 `.pptx`）做好的模型会重做一遍，
 * 把原产物覆盖掉。前四轮的做法都是"事前拦截"：猜哪条工具调用会重做，拦下它。
 * 这是猫鼠游戏，且**实测复发**：
 *   按工具名拦 → 模型换 `shell-exec`
 *   → 按命令文本拦 → 模型写个 `build_ppt.py` 再 `python build_ppt.py`
 *     （命令行里既没有 `.pptx`，也没有 `Presentation(`，也没有 `save`）
 *   → 窄表根本不命中。两次真跑 2/2 复发。
 *
 * 所以改成"**事后保管**"：不猜、不拦。本模块只保证两件事：
 *   1) 原件不可能丢 —— 每个被保管的版本都在内容寻址目录里留一份字节副本
 *      （`keep` 之后即使原路径被覆盖、被删除，`restore` 也能按字节写回）；
 *   2) 任何改动必然被发现 —— `check` / `audit` 用**内容 sha1** 比对，
 *      不是 `workflowState.artifactFingerprint` 那种 `{size, mtimeMs, slideCount}`
 *      （size+mtime 可伪造，同一毫秒两次写、mtime 被工具保留都不罕见）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与 `workflowState.artifactFingerprint` 的三个明确缺口（本模块逐个补上）
 * ═══════════════════════════════════════════════════════════════════════════
 *   缺口 1  只记 `{size, mtimeMs, slideCount}`，不是内容 sha1。
 *           → 本模块一律算 sha1（1MB 分块流式，内存恒定）。
 *   缺口 2  只覆盖 `.pptx`（源码里 `if (!/\.pptx$/i.test(...)) continue;`）。
 *           → 本模块**不看扩展名**：`.md` / `.png` / 无扩展名一律可保管。
 *   缺口 3  只拍一次不追踪（"它必须是验收通过那一刻的快照"），
 *           产物一旦被覆盖，后续没有任何地方会发现。
 *           → 本模块 `check` 每次都比、`audit` 批量比，并落 `artifact-changed` 事件。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计约束
 * ═══════════════════════════════════════════════════════════════════════════
 *   · **零副作用**：`require()` 本模块不建目录、不读盘、不写盘。一切 I/O 都从 `init()` 开始。
 *   · **不猜 dataDir**：`root` 一律由调用方传入（`workflowState.init()` 里是
 *     `path.join(dataDir, 'workflows')`）。本模块内部只再拼一层 `_custody`。
 *   · **只留一份基线语义**：`entry.sha1` 是"最近一次 `keep` 批准过的基线"，
 *     `entry.firstSha1` 是首次入库的 sha1，**永不改写**。`check` 永远拿当前 sha1
 *     跟基线比，`firstSha1` 只作为审计读数报出。
 *   · **旧版不 gc**：同一路径的所有修订版在磁盘上全部保留（"原件不丢"是本模块
 *     唯一的承诺）。只有 `_index.json` 里的 `revisions` 数组截到最近 20 条防膨胀。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 关于"副本只读"的实测结论（Windows / NTFS，Node 22.22.2）
 * ═══════════════════════════════════════════════════════════════════════════
 * **结论：`fs.chmodSync(p, 0o444)` 在 NTFS 上真的拦得住内容篡改，不是摆设。**
 * 这是两道防线里的**第一道**（先 EPERM，后 sha1），不是"尽力而为"的安慰剂。
 *
 * 实测依据（逐字保留输出，改这段注释前请先重跑复核）：
 *
 *   ── 第一轮（`scripts/tmp-probe/_custody/probe-readonly.mjs`）
 *   chmod 0o444 后 mode=444
 *   fs.writeFileSync -> writeFileSync 被拒: EPERM
 *   内容现在是 -> "ORIGINAL-CONTENT"
 *   fs.appendFileSync -> appendFileSync 被拒: EPERM
 *   fs.truncateSync -> truncateSync 被拒: EPERM
 *   fs.renameSync 覆盖 -> renameSync 被拒: EPERM
 *   fs.unlinkSync -> unlinkSync 成功（只读文件可删）
 *
 *   ── 第二轮（`scripts/tmp-probe/_custody/probe-readonly2.mjs`）
 *   fs.copyFileSync 覆盖 -> 被拒: EPERM
 *   fs.openSync(p,'w')+write -> 被拒: EPERM
 *   fs.openSync(p,'r+')+write -> 被拒: EPERM
 *   fs.rmSync -> 成功（未拦住）
 *
 *   ── 门禁里同结论复现（`unit-artifact-custody.mjs` C 组）
 *   保管物 mode = 0o444  size=19
 *   实测只读拦截：{"writeFileSync":"EPERM","appendFileSync":"EPERM","openW":"EPERM","renameOver":"EPERM"}
 *
 * ⚠️ 但**删除拦不住**（`unlink` / `rm` 照删），**提权/换账号写入也拦不住**。
 *   所以第二道防线必须留着，措辞是"第一道是 EPERM，第二道是 sha1"，不是"只靠 sha1"：
 *   `restore()` 写回前先校验保管物自身的 sha1，对不上就返回 `custody_copy_corrupt`，
 *   绝不把坏字节写回用户文件。这一层防的正是 EPERM 拦不住的那两类情形
 *   （有人去掉只读位后改写 / 以其他账号写入 / 整份副本被替换）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 目录归属：本目录**不得**被任何 prune / 清理逻辑触碰
 * ═══════════════════════════════════════════════════════════════════════════
 * 推荐接线（**与 `workflows/` 平级，不是它的子目录**）：
 *   init({ root: path.join(dataDir, 'custody'), subdir: '' })   ⇒ dir = <dataDir>/custody
 *
 * 为什么不能挂在 `workflows/` 下面：两者保留期语义不同，且是不可调和的。
 *   · `workflows/` 是**任务状态**，`KEEP_DAYS = 30`，过期就该清；
 *   · `<dataDir>/custody/` 是**产物原件**，承诺是**永久可用**。
 * 拿"30 天就清"的目录存"永久可用"的东西，是在赌清理逻辑的实现细节：
 *   `workflowState.prune()` 当前只 `readdirSync` 一层、只删 `*.json`，
 *   所以 `_custody` 这个**目录名**恰好不匹配 —— 安全**靠巧合**。
 *   哪天有人把 prune 改成递归、或改成"删所有过期项"，原件就全没了，
 *   而排查时没人会想到去 custody 里找。⇒ 目录必须平级，隔离由**位置**保证，
 *   不靠别人代码里的一个正则。
 *
 * 本目录的清理策略必须**单独实现且需显式授权**（例如用户主动"清空产物保管库"），
 * 绝不复用 `prune` 的 keepDays。代码里没有任何自动删除保管物的路径 —— 这是故意的。
 *
 * 存储布局（内容寻址 ⇒ 天然去重、天然不可变）
 *   <dir>/<sha1前2位>/<sha1>/<原文件名>   ← 字节副本（第一道防线：0444）
 *   <dir>/_index.json                    ← 规范化绝对路径 → 元数据
 *   <dir>/_events.jsonl                  ← 每行一条事件（追加，不改写）
 * 其中 `<dir>` = `path.join(root, subdir)`，`subdir` 默认 `'_custody'`；
 * 传 `subdir: ''` ⇒ `<dir>` 就是 `root` 本身（推荐接线用这个，少一层嵌套）。
 *
 * 对外接口（调用方只需 `init({root})` 然后 `keep/check/audit/restore/versions/events`）：
 *   init(opts)            -> { ok, dir, reason? }   opts = { root, subdir? }
 *   keep(filePath, ctx)   -> { ok, sha1, bytes, storePath, deduped } | { ok:false, reason }
 *   check(filePath)       -> { ok, sha1, bytes, changed, missing?, firstSha1, firstAt } | { ok:false, reason }
 *   audit(paths)          -> { ok, items, tampered, missing, unverified, index, counts }
 *   restore(filePath, opts?)
 *                         -> { ok, sha1, bytes, restoredTo, verifiedSha1, noop,
 *                              fromSha1, targetSha1, explicit, guardSha1, modeOk,
 *                              indexWritten, warnings } | { ok:false, reason }
 *                            opts.sha1 给出时 = **精确恢复到该历史版本**；
 *                            不给 = 恢复到最近一次基线（旧行为，逐字不变）。
 *                            ⚠️ 恢复是**显式操作**：`check()` / `audit()` 只读不改盘，
 *                            没有任何自动覆盖路径（门禁 V-API1 静态断言这一点）。
 *   versions(filePath)    -> { ok, path, baselineSha1, versions:[{sha1, bytes, at,
 *                              inIndex, inEvents, isBaseline, available}] } | { ok:false, reason }
 *                            ← 告诉调用方"这个路径有哪些版本可以精确恢复"
 *   events()              -> Event[]（按 at 升序）
 *   confirmRepair(by, note) -> { ok, reason, at, by, confirmedCorruptAt }
 *                            ← 索引修复的**唯一**人工确认出口（留名，append-only 落到事件流）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 索引损坏：不许静默降级（这是本模块最容易被忽略的一条）
 * ═══════════════════════════════════════════════════════════════════════════
 * `_index.json` 是这套机制**唯一**的元数据。它一坏，最省事的写法是 `return {}`，
 * 但那样每个路径都查不到基线 ⇒ `audit()` 把**全部**产物报成 `never_kept`
 * ⇒ "篡改检测"这个能力整体消失，而报告读起来像"这些文件本来就没保管过"。
 * **一个故障被报成一种正常状态** —— 这比崩溃难发现得多，因为报告全绿/全"未保管"。
 *
 * 现在的处置（`recoverIndex()`）：留证 → 从 `_events.jsonl` 重建 → 记凭证。
 *   · 坏文件改名成 `_index.json.corrupt-<ts>`（留证：事后能人肉看出坏成什么样）；
 *   · 从事件重建（事件是追加写、不改写，比索引更接近真相）；
 *   · 写 `_index.repair.json` 辅助凭证 + 一条 `index-corrupt` 事件。
 *
 * ★ **主凭证是 append-only 的事件流，`_index.repair.json` 只是辅助证据。**
 *   判定顺序是规格，不许换（`readIndexState()`）：
 *     1. `_index.json` 能解析 → 走原路径；
 *     2. `_index.json` 坏了   → `index_corrupt` + 立刻自救（origin=`file_bad`）；
 *     3. 索引好、但事件流里有 `index-corrupt` 且其后没有 `index-repair-confirmed`
 *        → **仍报 `index_corrupt`**（origin=`history_unconfirmed` / `history_incomplete`），
 *          **哪怕 `_index.repair.json` 已经不存在**；
 *     3.5 内容寻址目录里有对象、却没人认领 → `index_corrupt`（origin=`orphan_objects`）
 *          —— 只在前面三条都"没问题"时才占用 `origin`，但 `orphanCount` 永远照报；
 *     4. 有 `index-repair-confirmed` → `repaired:true` / `confirmed:true`，按索引正常报。
 *   为什么第 3 条这么写（代价是一段历史）：这个病在本模块出现过三次 ——
 *     ① 索引坏了 `return {}` ⇒ 全报 never_kept；
 *     ② 加 `_index.repair.json` ⇒ `unlink` 它就是全报 never_kept（"清理临时文件"就能触发）；
 *     ③ 就是现在：主凭证搬进事件流之后，删任何**文件**都改变不了结论方向。
 *   出口只有一个 —— `confirmRepair(by, note)`：**留名**才算修好。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 退化方向必须保守（第四条，方向性判据 —— 它管的不是某条语义，是"往哪边错"）
 * ═══════════════════════════════════════════════════════════════════════════
 * **删掉任何一个凭证文件，结论只能变得更谨慎（多报 `index_corrupt` / `unverified`），
 *   绝不许变得更宽松（退回 `never_kept` / `ok`）。**
 *
 * 门禁 G 组逐一实测四组，逐路径比较严重度序数、断言**不许有任何一条下降**：
 *   D1 删 `_index.json`        —— 事件还在 ⇒ 必须重建，不许当"首次使用"（旧实现正是这么当的）
 *   D2 删 `_index.repair.json` —— 仍报 `index_corrupt`（主凭证在事件流里）
 *   D3 删 `_events.jsonl`      —— 索引还健康 ⇒ `tampered`/`missing` 一条都不许丢
 *   D4 三个全删                —— **按内容寻址目录是否为空分两种**（team-lead 2026-10-23 裁决）：
 *        · 目录**非空** ⇒ `index_corrupt`（`origin:'orphan_objects'`），**不许** `never_kept`
 *        · 目录**空**   ⇒ `never_kept`（这才是真正的首次使用）
 *        这两种必须在输出上可区分。旧规格写的是"三个全删 ⇒ 报 never_kept 也可以"，
 *        那句是**错的**：目录里的对象本身就是"它被保管过"的证据。把它读成
 *        "从来没保管过"是同一个病的第六次，而且方向是变宽松。
 *
 * 为什么这条要单独立一条判据而不是分散在各地：每一次修法的动作都是"再加一个文件"，
 * 而每一个新文件都成了下一次被删掉的对象。钉住**方向**才不会被第四次绕过。
 * 反过来，方向性判据也**不能**替代具体语义 —— D4 那一格就是被"方向正确"掩盖的
 * 一个错误规格：删得越多结论越"宽松"看起来是合理的，直到有人指出目录本身是证据。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 孤儿对象：内容寻址目录本身就是证据（第五条，已实现的不变量）
 * ═══════════════════════════════════════════════════════════════════════════
 * **内容寻址目录里存在任何对象，却没有任何凭证认领它 ⇒ `index_corrupt`
 *   （`origin:'orphan_objects'`），不许报 `never_kept`。**
 *
 * 成因（都是真实可发生的，不是假想）：
 *   · 索引、辅助凭证、事件流三个文件都被人"清理"了，对象还在 ⇒ 旧实现报
 *     `never_kept`，报告读起来像"这些文件从来没让我管过"；
 *   · `keep()` 写完字节副本、还没写索引/事件就崩了（那一次的内容确实在，但没留档）；
 *   · 有人手工往目录里塞了东西。
 *
 * 判据（门禁 J 组）：五路"坏"与一个"正常"必须**逐个两两不同** ——
 *   `file_bad` / `history_unconfirmed` / `history_incomplete` / `orphan_objects` /
 *   真正的 `never_kept`（目录空且无任何凭证）。
 *   注意断法是**逐对比较**，不是"有四个值"：后者是集合非空的老病（长度 4 也可能是同一个值 ×4）。
 *
 * ⚠️ 一处对规格的**收窄**，理由必须留档，免得下一个人"按字面改回去"：
 *   "认领"的判定 = `_index.json` ∪ `_events.jsonl`，**两个来源都算**。
 *
 *   > **有界的证据不能证明无界的事实。** 「孤儿」的定义必须是「**任何**凭证都说不清它是谁」，
 *   > 而不是「索引里没有它」—— 索引有 `MAX_REVISIONS` 上限、会被裁剪，用它当全集判存在性，
 *   > 会让**改写次数多的正常产物永久假红**。假红的代价不是多一条告警，是**告警变成噪声**。
 *
 *   只按字面"没有一条索引引用它"会误伤一类完全正常的产物：索引只留最近
 *   `MAX_REVISIONS = 20` 条 revisions，更早的修订版会被裁掉，而磁盘副本**永不删除**。
 *   真正的孤儿语义是"没有任何凭证能说清它是谁"；事件流里有 keep 记录的，说得清。
 *   常驻证据：门禁 `trimmed_revisions` 探针（25 个修订版 ⇒ `orphanCount=0 / storeObjects=25`）。
 *
 * 扫描代价与分工：孤儿扫描要遍历整个内容寻址目录，代价随对象数线性增长。
 *   所以只有 `audit()`（**全局**出口）传 `scanStore:true`；`check` / `restore` / `keep`
 *   不做。孤儿本来也不是"某个文件"的属性 —— 它是"这个库里有东西没人认领"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 宽限期：一个会误报的告警等于没有告警（`orphan_pending`）
 * ═══════════════════════════════════════════════════════════════════════════
 * `keep()` 的中间态（字节副本已 rename 进目录、索引/事件还没写）在**另一个进程**的
 * `audit()` 眼里就是一个孤儿 —— 而这个窗口是「已知限制」第 1 条承认的设计现状。
 * 把它报成 `orphan_objects` 等于让一个**已知的正常中间态**天天报警。
 *
 * ⇒ 按对象目录的 `mtime` 分两档（确定性判据，不靠人调参）：
 *   · `now - mtime < orphanGraceMs`（默认 120000） ⇒ `orphan_pending`
 *     **不导致 `corrupt`**，但 `orphanPendingCount` / `origin` / `detail` 三处都必须点名；
 *   · 更旧 ⇒ `orphan_objects`（`corrupt:true`），并且**过了宽限期会自己升级**，
 *     不需要任何人去处理 —— 这是它能被接受的前提。
 *
 * 三个方向都不许撒谎：
 *   · `pendingCount` 必须照报（不报就等于"它没发生过"）；
 *   · 无条目的路径在 pending 期间报 `index_pending`，**不许**报 `never_kept` / `not_kept`
 *     （字节就在目录里躺着，说"没管过"是撒谎）；
 *   · `mtime` 取不到（NaN）⇒ **按真孤儿报**（未知不许当好消息）。
 *
 * 判据（门禁 J 组 J4/J5）：改 `mtime` 两个方向各断一次，**不靠等两分钟**。
 *   J4 mtime=now ⇒ pending、corrupt=false、pendingCount=1、item 报 index_pending
 *   J5 mtime=now-10min ⇒ 同一对象升级成 orphan_objects、corrupt=true
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 读了但没读到，必须报出来，不许折成"没有"（规则，带常驻判据）
 * ═══════════════════════════════════════════════════════════════════════════
 * **任何"我读了但没读到"的分支，必须报出来，不许折成"没有"。**
 *
 * 这条规则的来源是一次实测（门禁 D5 / S2b 探针，2026-10-23）：
 *   索引与事件流**同时**被截断时，`recoverIndex()` 把 `index-corrupt` 事件
 *   **追加**到那个被截断到半行的文件末尾 ⇒ 新事件被拼进半行垃圾里 ⇒ 整行 parse 不了
 *   ⇒ 下次 `scanEventHistory()` 读到 `corruptEvents === 0` ⇒ 结论悄悄变回"可信"，
 *   而此刻 `tampered` 已经从 1 掉到 0。
 *   一句话：**「事件流丢了记录」被读成了「没有坏过」。**
 *
 * 它值钱在**触发路径是修复动作本身**：不是外部并发、不是磁盘坏，而是我们为了修它
 * 而去追加的那条事件，把修复凭证写坏了。这与"自愈比不愈更坏"是同一个骨架：
 *
 *   > **一个用来保证"不许静默降级"的机制，自己也可能静默降级 —— 而且它降级的
 *   >   方向一定更宽松，因为它失败时看起来像"没有需要报的事"。**
 *
 * 落地（两处，缺一处这条规则就只是口号）：
 *   ① `historyIncomplete`：凭证在、事件流里却没有任何 corrupt 记录 ⇒ 按"未确认"处理；
 *   ② `badLines` / `allBad`：读到 N 行、行行都 parse 不出事件 ⇒ 凭证已废。
 *      旧返回值里**没有坏行数**，于是"5 行全垃圾"与"5 行全是我不管的事件"
 *      返回的对象**逐字相同** —— 同一个形状，两个相反的结论。
 *      判据（门禁 K 组）断两件事：两者 `lines` 相同（证明行数分不开）、
 *      `badLines` 不同（证明它是承重的，不是装饰）。
 *      方向：**部分坏行是正常形态**（追加写被强杀的末行），所以告警条件只能是
 *      `allBad`（`badLines === lines`），不能用 `badLines > 0`。
 *   ③ **根因**：`appendEvent()` 追加前先保证文件以换行结尾。
 *      ①②是把这件事**报出来**，③是让它**不再发生**。
 *
 *      > **只修"读的人看不出来"等于没修，如果"写的人"还在持续制造看不见。**
 *      > 判别方法：问「这个故障**下一次**还会不会发生」。会 ⇒ 你修的是观测，不是机制。
 *      > 这次的例子：`historyIncomplete` 让丢失可见了，但 `appendEvent` 还在往半行
 *      > 后面粘 —— 下一次照样丢一条。
 *
 *      补的那一个 `\n` 不改动任何既有字节（仍然 append-only），那半行垃圾留在原处
 *      当证据，只是它不再吃掉下一条事件。
 *      实测代价变化：末行半行从"`badLines:0`（被吃掉，看不见）"变成
 *      "`badLines:1`（可数）"—— 这正是修好的标志：**同样的坏状态，现在数字上看得出来。**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 接线契约：`audit()` 的出口顺序（`backend.js` 侧，本模块不实现出口）
 * ═══════════════════════════════════════════════════════════════════════════
 * 顺序必须是：`index.corrupt` → `unverified` → `tampered + missing`。
 *   **`index.corrupt` 会让 `counts` 本身不可信，所以它必须排在 counts 之前被读。**
 * 否则接线的人会先读 `counts.tampered`、看到 0、然后报"产物完好" —— 而实测
 * （索引与事件同时损坏那一组）正是 `tampered:1` 掉到 `tampered:0`。
 * 那不是"读数错了"，是"该说的话说不出来"。只看计数就会漏掉真实异动。
 * 出口**只报告、不否决交付**：拿一个可能损坏的元数据去否决交付，等于让
 * "保管工具的故障"变成"业务停工"。但"不否决"不等于"不报" —— 三档都必须出声。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 变异臂纪律（写在这里，是因为下一个人一定会想"再补一条臂"）
 * ═══════════════════════════════════════════════════════════════════════════
 * **一个变异臂只能证明它拆掉的那件事。** 两条不同的保证必须各有一条臂；
 * 靠拆 B 让 A 转红，只能把 A 写成依赖 B 结果的形式 —— 那时 A 已经不是原来那条判据了。
 * 变异臂覆盖不到的分工，必须用一条常驻判据写死（门禁 F12c / G6d 干的就是这个），
 * 否则下一个人会把它读成"覆盖缺口"并"补"一条假臂上去。
 * 现有七条臂的分工（每条都先自证替换命中次数 === 1）：
 *   M1 去比对 / M2 去内容寻址 / M3 折叠 missing / M4 摘掉索引重建 ⇒ 红"读数恢复"（F6/F6b）
 *   M5 拆掉"不许撒谎"分支 ⇒ 红"不许说 never_kept"（F5d/F5e）
 *   M6 拆掉历史凭证判定   ⇒ 红"删 repair.json 仍 index_corrupt"（D2b/D2c/F14c）
 *   M7 拆掉孤儿对象判定   ⇒ 红"三删 + 目录非空必须 index_corrupt"（D4/D4b/D4b2）
 *
 * ⚠️ **改名这种无害重构会让变异臂静默失效，而失效的臂永远显示绿。**（实测，2026-10-23）
 *    我把 `hist.unconfirmed` 改名成 `unconfirmed` 并引入 `histIncomplete` 之后，
 *    M6 的三条锚点**命中 0 处**，替换等于空跑 —— 而空跑的变异体与源码行为相同，
 *    所有"应该转红"的判据都还绿着。是 `G6a`（命中次数 === 1）当场把它拦下来的。
 *    ⇒ 所以每条臂的第一条判据不是"变异体让 X 转红"，而是"我的锚点真的只命中这一处"。
 *    这也是为什么锚点要写成**一整个语句块**而不是关键词：关键词在注释里也会命中。
 *
 * ⚠️ **手调常量会死。** `H7` 早期版本按"头注释前 200 行"找「已知限制」区块，
 *    头注释一长就只找到一半，红的时候看起来像模块缺了条目。修法**不是**把 200 改大
 *    （那种数字每加一段注释就得手调一次，调着调着就没人调了），而是改取法：
 *    从「已知限制」那一行起、到下一个块注释结束符为止，按**区块**取。
 *
 * ⚠️ **注释里别把星号与斜杠连写。**（与"模板字符串里写反引号注释 ⇒ 提前闭合"同族）
 *    我在块注释里写了那两个字面字符，JSDoc 当场提前闭合，整个文件
 *    `SyntaxError: Unexpected identifier 'scripts'` —— 而且 `node --check` 报的位置
 *    离真正的编辑点差了几百行。要写就拆开写"星号+斜杠"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 已知限制（明确接受，本轮不修 —— 但每条都写清具体后果）
 * ═══════════════════════════════════════════════════════════════════════════
 *   1) **同一路径并发 `keep` 非原子。**
 *      写入路径是 `tmp + rename`，`rename` 本身原子，但"读索引 → 改索引 → 写回"
 *      这个读-改-写序列不是原子的。两个进程同时对同一路径 keep 时，
 *      后写的那次会把前一次的 `firstSha1` / `revisions` 覆盖掉。
 *      具体后果：**产物字节一个都不会丢**（内容寻址目录里两份副本都在），
 *      丢的是"首次入库的 sha1"这条审计读数 —— 它会退化成后一次的值。
 *      不影响 `restore`（每种 sha1 都能按 `storePathFor` 找到）。
 *      **另一条后果（本版新增，且已被降级处理）**：这个窗口会让另一个进程的
 *      `audit()` 看到"字节已写、索引未写"的中间态 ⇒ 看起来像孤儿。
 *      处置**不是**写进本限制就算了，而是按 `mtime` 判成 `orphan_pending`
 *      （可见、可数、不告警），过 `orphanGraceMs` 自动升级成 `orphan_objects`。
 *      ⇒ 误报被降级成"待定"，真故障照样报。残留风险：若某次 `keep` 卡住超过
 *      宽限期两分钟（大文件 × 慢磁盘），它会先报一次 `orphan_objects`，
 *      下次 `audit` 又回到正常 —— 表现为一条会自己消失的告警。
 *   2) **无 fsync。** `_events.jsonl` 用 `appendFileSync`，`restore` 写回也没有 fsync。
 *      具体后果：掉电/强杀时最后几条事件可能只落在页缓存里而丢失，`restore` 写回
 *      的文件在极端情况下可能是截断的。**注意这与"模型覆盖产物"这个业务场景无关**
 *      —— 那类覆盖是进程存活期间的普通写，会落盘。这里丢的是"事故记录"而不是"原件"，
 *      因为原件副本是在 `keep` 时就写完的。
 *   3) **>200MB 的文件不保管。** 走 `unverified / reason:'too_large'`，不静默跳过。
 *      具体后果：超大产物**没有**"原件不丢"的保证 —— 它被覆盖就是真的没了，
 *      但 `audit` 会明确报 `too_large`，不会被误认为"已保管"。要覆盖这类文件，
 *      需要把 `MAX_FILE_BYTES` 调大或改成"只存 deltas"（后者是另一个设计，未做）。
 *   4) **`sanitizeName()` 不处理 Windows 保留名**（`CON` / `PRN` / `NUL` / `AUX` /
 *      `COM1..9` / `LPT1..9`）。具体后果：如果产物文件名恰好叫 `nul`，
 *      在 Windows 上 `copyFileSync` 会失败 ⇒ `keep` 返回 `store_write_failed`
 *      （**是显式失败，不会假成功**），但该产物就失去了保管。校验/转义未做。
 *   5) **索引的重建只依赖 `_events.jsonl` 一个来源。** 两者同时损坏时，实测
 *      （`scripts/tmp-probe/_custody/both-corrupt.mjs`，2026-10-23）**不是**"重建出空表"，
 *      而是**重建出一张残表** —— `_events.jsonl` 被截断后前几行仍是合法 JSON，
 *      重建只能救回**前缀那几条**。实测读数：只坏索引 ⇒ `rebuiltEntries=3`、
 *      `tampered 1 / missing 1`（完整恢复）；索引与事件同时坏 ⇒ `rebuiltEntries=1`、
 *      `tampered 0 / missing 0 / unverified 3`。
 *      **具体后果（本条最要紧的一句）**：原本**真被改过**的那个文件，计数从
 *      `tampered:1` 变成 `unverified(index_corrupt)` —— 于是交付报里那句
 *      「产物原件有异动，已保留原件副本，可 restore」会**因索引损坏而消失**。
 *      它不是"说错了"，是"该说的话说不出来"。⇒ 接线时必须**先看 `index.corrupt`**
 *      再看 `counts.tampered`；只看计数，索引损坏时就会漏掉真实异动。
 *      "已保管 vs 从未保管"的区分同时丢失，恢复手段只剩人工：拿
 *      `_index.json.corrupt-<ts>`（若没坏）或按内容寻址目录反推
 *      （`<dir>/<sha1 前2位>/<sha1>/<原文件名>` —— 能重建出"这份内容存在"，
 *      但同名不同路径时重建不出"它对应哪个原路径"）。
 *   6) **`restore` 的 noop 短路跳过保管物校验。** 当原文件内容已经等于基线时直接返回
 *      `{noop:true}`，不再 hash 保管副本。具体后果：若此刻保管副本自身已损坏，
 *      本次 `restore` 不会报 `custody_copy_corrupt`（下次真的需要写回时才会报）。
 *      这是刻意的取舍：把大文件每次都 hash 一遍的代价比这个窄缺口更大。
 *   7) **只读（0444）只在当前用户身份下实测过**，未做提权/换账号测试；
 *      且 `unlink` / `rm` 照删不拦。具体后果：见上文"第一道是 EPERM，第二道是 sha1"。
 *   8) ~~`_index.repair.json` 是唯一载体，删掉它语义就悄悄退回原样~~ —— **本版已修**。
 *      主凭证搬进 append-only 的 `_events.jsonl`，删掉辅助凭证文件**改变不了结论方向**
 *      （门禁 F14c / D2 / M6 三条独立证据钉住）。
 *      代价与残留：判定要读一遍事件流，`_events.jsonl` 越大 `audit()` 越慢
 *      （口径：每次 `audit` 全量读一次；按每天几百条增长，量级可接受，未做缓存）。
 *   9) **`confirmRepair()` 是人工动作，没有权限模型。** 任何能写 `_events.jsonl` 的
 *      代码/人都能"确认"一次修复，包括它自己（例如将来误把 `confirmRepair` 接进自动流程）。
 *      具体后果：一次错误的自动确认会把"我怀疑元数据"降级为"元数据可信" ——
 *      **方向是变宽松**，正是上一节要防的那一侧。本模块能做的只有三件事：
 *      确认必须留 `by`（空名拒绝）、必须落 append-only 事件流、必须记 `confirmedCorruptAt`
 *      （确认的是**哪一次**损坏，事后可查是谁、什么时候、认了哪一次）。
 *      **不做的理由**：权限模型属于调用方（Electron 主进程 / 未来的人机界面），
 *      在这里造一个"谁有权确认"的判据只会是猜的。
 *      ⇒ 接线时**不许**自动调用它；它只能由人触发。
 *  10) **孤儿扫描有上限 `MAX_STORE_SCAN_ENTRIES = 20000`。**
 *      **触发条件**：内容寻址目录里的对象数达到 20000 时，扫描在数到第 20000 个就停，
 *      `truncated:true`（`audit().index.storeTruncated`）。
 *      **那时的读数只是下界**：`orphanCount` 是"前 20000 个里有多少没人认领"，
 *      **不是全量**；`storeObjects` 同样只是下界。
 *      具体后果：对象超过 2 万个的库，孤儿数**可能少报**（不会多报）——
 *      方向是"少说"，不是"说错话"。若 20000 个里恰好都是有主的，而第 20001 个是孤儿，
 *      本次 `audit` **不会**报 `orphan_objects`。不许拿这个 0 当"没有孤儿"。
 *      未做的理由：全量扫描的耗时随对象数线性增长，而 `audit` 在交付路径上被调用；
 *      真到 2 万个对象时需要的是"存档/分库"策略，不是把这个数字调大。
 *      ⚠️ **这条路径本身未核验**（要造 2 万个对象才触发，门禁没测）——
 *      写在这里是为了让读到的人在超限时知道该怀疑什么，不是声称它验证过。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════════════════
 * 常量
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 单文件上限 200MB。超过 ⇒ 不保管 / 进 `unverified(reason:'too_large')`，绝不静默跳过。 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** `_index.json` 里每条路径最多留 20 条 revisions（磁盘副本不删）。 */
const MAX_REVISIONS = 20;

/**
 * 孤儿对象扫描上限。超过 ⇒ `truncated:true`，读数是**下界**。
 * 这个常量只用来防"一次 audit 卡死"，不参与任何判定方向 —— 不许拿它当"扫了这么多就够了"。
 */
const MAX_STORE_SCAN_ENTRIES = 20000;

/**
 * 孤儿对象的宽限期（毫秒）。**默认 120000（2 分钟）**。
 *
 * 存在理由：`keep()` 的中间态（字节副本已 rename 进目录、索引/事件还没写）在另一个
 * 进程的 `audit()` 眼里就是一个孤儿。那个窗口在「已知限制」第 1 条里是被承认的设计现状，
 * 所以不能把它报成 `orphan_objects` —— 会误报的告警最终会被无视，连真报一起。
 *
 * 可被 `init({ orphanGraceMs })` 覆盖：门禁靠传小值/改 mtime 来测两个方向，
 * 不靠真的等两分钟（等出来的测试没人跑）。
 */
const ORPHAN_GRACE_MS = 120000;

/** sha1 分块大小：1MB。用 readSync 循环 ⇒ 流式、内存恒定，200MB 文件不会 OOM。 */
const CHUNK_BYTES = 1024 * 1024;

const CUSTODY_DIR_NAME = '_custody';
const INDEX_NAME = '_index.json';
const EVENTS_NAME = '_events.jsonl';

/**
 * 索引"我坏过一次、后来是重建的"这件事的**持久凭证**。
 * 它决定 `audit()` 能不能说 `never_kept`（详见 `readIndexState()` 的长注释）。
 * 人工确认修复结果之后，删掉这个文件即可恢复 `never_kept` 语义 —— 这是唯一的清除方式，
 * 没有任何代码路径会自动删它（否则"我坏过"这个事实又会被静默抹掉）。
 */
const INDEX_REPAIR_NAME = '_index.repair.json';

/** 事件 kind 常量（测试与接线处都引用这些字面量，改这里等于改契约）。 */
const KIND_KEPT = 'artifact-kept';
const KIND_KEPT_DEDUP = 'artifact-kept-dedup';
const KIND_CHANGED = 'artifact-changed';
const KIND_MISSING = 'artifact-missing';
const KIND_RESTORED = 'artifact-restored';
/**
 * 恢复前保护：**把将被覆盖的那一版先收进库**（2026-10-24，「指定版本恢复」引入）。
 *
 * 为什么必须是**独立的 kind**，而不是复用 `artifact-kept`：
 *   · `artifact-kept` 的语义是"产物落地/被验收这一刻的内容"，`by` 三个值
 *     (`landing-hook`/`conclude-fallback`/`resume-precheck`) 都描述**落地来源**；
 *     恢复前的那一版既不是落地、也不是验收，它是"我马上要动这个文件，先存一份"。
 *     塞进 `artifact-kept` 会让事后按 `by='landing-hook'` 筛出来的不全是落地，
 *     `by` 的语义就废了；
 *   · 事件链判据按 kind 精确序列断言（门禁 E7b），复用 kind 会让"这一次到底是落地
 *     还是恢复前保护"在读数上不可分辨。
 *
 * ⚠️ 它**不参与基线重建**（`rebuildIndexFromEvents` 只回放 kept 两种），但**参与认领**
 *   （`scanEventHistory().keptSha1s`）：恢复前保护写下的字节副本是一个真实存在的版本，
 *   不认领就会在索引重建后被报成孤儿 —— 那是把"我们自己刚做的事"说成"来路不明的对象"。
 */
const KIND_RESTORE_GUARD = 'artifact-restore-guard';
/**
 * 恢复失败（含"定位不到目标版本""保管副本坏了""写后哈希对不上"）。
 *
 * 为什么失败要**单独一个 kind**、而不是给 `artifact-restored` 加个 `ok:false` 字段：
 *   门禁 H4 的判据是"每条 `artifact-restored` 的 `verifiedSha1 === sha1`"。
 *   一旦允许失败也落这个 kind，`verifiedSha1` 就必须允许为空串 ⇒ H4 立刻退化成
 *   "要么相等要么空"，而"空"能覆盖掉几乎任何写坏的情形 —— 判据当场变成装饰。
 *   失败留痕的目的（老板要求「记录恢复结果及失败原因」）不需要污染成功事件的语义。
 */
const KIND_RESTORE_FAILED = 'artifact-restore-failed';
const KIND_INDEX_CORRUPT = 'index-corrupt';
/**
 * 人工确认"这次索引修复我认了"的唯一入口落点（`confirmRepair()` 写的就是它）。
 *
 * **为什么它是事件而不是一个文件**：文件能被"清理临时文件"顺手删掉；append-only 的
 * 事件流删掉会连同"曾经坏过"这件事一起消失 —— 那是往**宽松**方向的退化，见下文
 * 「退化方向必须保守」。所以：
 *   主凭证 = `_events.jsonl` 里的 `index-corrupt` / `index-repair-confirmed` 这一对；
 *   `_index.repair.json` 降级为**辅助证据**（好读、能人肉看，但删了不影响结论方向）。
 */
const KIND_INDEX_CONFIRMED = 'index-repair-confirmed';

/**
 * 模块级状态。**只在 `init()` 里赋值**，保证 require 阶段零 I/O。
 * @type {{root:string, dir:string, indexFile:string, eventsFile:string, orphanGraceMs:number}}
 */
let state = { root: '', dir: '', indexFile: '', eventsFile: '', orphanGraceMs: ORPHAN_GRACE_MS };

/* ═══════════════════════════════════════════════════════════════════════════
 * 小工具
 * ═══════════════════════════════════════════════════════════════════════════ */

/** @return {string} ISO 时间戳 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 把外部传入的路径解析成绝对路径。非法输入返回空串（调用方转成 `bad_path`）。
 * @param {*} p
 * @return {string}
 */
function safeResolve(p) {
  if (typeof p !== 'string') return '';
  const s = p.trim();
  if (!s) return '';
  try {
    return path.resolve(s);
  } catch (err) {
    return '';
  }
}

/**
 * 路径规范化（`_index.json` 的 key 用这个，保证"同一个文件两种写法"只算一个 key）：
 *   · `path.resolve` 已在 `safeResolve` 里做过
 *   · Windows：`\` → `/`，盘符大写
 * 注意：**不做全小写**。全小写会篡改真实磁盘路径的大小写，`restore` 时可能落到
 * 另一个文件上（Windows 默认大小写不敏感，但网络盘/区分大小写的目录不是）。
 * 这里是"写法归一"，不是"身份归一"。
 * @param {string} absPath
 * @return {string}
 */
function normalizeKey(absPath) {
  let k = String(absPath);
  if (process.platform === 'win32') {
    k = k.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(k)) k = k.charAt(0).toUpperCase() + k.slice(1);
  }
  return k;
}

/**
 * 原文件名进存储目录前的净化：去掉 NTFS/POSIX 非法字符，限长 120。
 * 两层 sha1 目录已保证唯一性，文件名只为人眼可读。
 * @param {string} name
 * @return {string}
 */
function sanitizeName(name) {
  let s = String(name === undefined || name === null ? '' : name);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  s = s.replace(/^\.+$/, '_');
  if (!s) s = 'file';
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

/**
 * 内容寻址路径：`<root>/_custody/<sha1前2位>/<sha1>/<原文件名>`
 * ⚠️ 这个函数是"天然去重"的唯一实现点 —— 它必须**只依赖内容 sha1**，
 *    一旦引入时间戳/序号，"同内容只存一份"立刻失效。
 * @param {string} sha1Hex
 * @param {string} resolvedAbsPath
 * @return {string}
 */
function storePathFor(sha1Hex, resolvedAbsPath) {
  return path.join(state.dir, sha1Hex.slice(0, 2), sha1Hex, sanitizeName(path.basename(resolvedAbsPath)));
}

/**
 * 流式算 sha1（1MB 分块 readSync，内存恒定）。
 * @param {string} filePath 绝对路径
 * @return {{sha1:string, bytes:number}}
 */
function sha1OfFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const hash = crypto.createHash('sha1');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (!n) break;
      bytes += n;
      hash.update(n === CHUNK_BYTES ? buf : buf.subarray(0, n));
    }
    return { sha1: hash.digest('hex'), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `ctx` 只留可 JSON 化的原语，防止把大对象/循环引用写进事件。
 * @param {*} ctx
 * @return {object|null}
 */
function safeCtx(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return null;
  const out = {};
  const keys = Object.keys(ctx).slice(0, 24);
  for (const k of keys) {
    const v = ctx[k];
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > 400 ? v.slice(0, 400) : v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** @return {object|null} 未初始化 ⇒ 统一的失败返回值 */
function requireInit() {
  if (!state.dir) return { ok: false, reason: 'not_initialized' };
  return null;
}

/**
 * 目标路径是否落在保管库内部（防自吞）。
 * @param {string} resolvedAbsPath
 * @return {boolean}
 */
function insideCustody(resolvedAbsPath) {
  if (!state.dir) return false;
  const a = normalizeKey(resolvedAbsPath).toLowerCase();
  const b = normalizeKey(state.dir).toLowerCase();
  return a === b || a.startsWith(b + '/');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 索引 / 事件 的读写
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
 * 历史凭证：从 append-only 的事件流里判断"索引这件事到底可不可信"
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 扫 `_events.jsonl`，回答一个问题：**历史上坏过、而且没人确认修好，是不是还没结束？**
 *
 * 为什么不能只靠 `_index.repair.json`（这是本模块第三版修法，前两版的实际结局写在下面）：
 *   第一版：索引坏了 `return {}` ⇒ 全部 `never_kept`（故障被报成正常状态）。
 *   第二版：加了 repair 凭证文件 ⇒ 删掉那个文件就又退回 `never_kept`（同一个病，
 *           只是触发条件从"索引损坏"换成"清理临时文件"）。
 *   第三版（本函数）：主凭证搬进 **append-only 事件流**。删一个 markdown 大小的
 *           凭证文件不再改变结论方向，因为"曾经坏过"这件事在事件流里另有一份。
 *
 * 判定是**按时间顺序折叠**的，不是"有没有出现过"：
 *   `index-corrupt` 把它置为 pending；`index-repair-confirmed` 把它清掉。
 *   只有最后一个 `index-corrupt` 之后**没有**确认，才算"仍未确认"。
 *   ⇒ 连续坏两次只需确认一次是**不够**的（第一次的确认被第二次的 corrupt 清掉），
 *     这是有意为之：第二次损坏之后，上一次的"我核过了"就不能再代表现在。
 *
 * `eventsReadable:false` 有三种来源（文件不存在 / 读不了 / 空），它们对结论的影响不同，
 * 所以都带出来，由 `readIndexState()` 决定，不在这里替它拍结论。
 *
 * ★ `badLines` / `allBad`（第五个版本补）：**"读了但一行都没读出来"必须显形。**
 *   旧返回值里没有"坏行数"，于是这两种文件返回的对象**逐字相同**：
 *     · 5 行全是垃圾（`{bad1` …）        ⇒ {lines:5, kept:0, corrupt:0, confirm:0}
 *     · 5 行全是 `artifact-changed`       ⇒ {lines:5, kept:0, corrupt:0, confirm:0}
 *   前者是"事件流这个凭证已经废了"，后者是"这一类事件我不关心"。同一个形状、
 *   两个相反的结论 —— 只能靠 `badLines` 分开。判据 K 组钉的就是这件事：
 *   断言两者 `lines` 相同（证明行数分不开）、`badLines` 不同（证明它承重）。
 *
 *   注意方向：**部分坏行是正常形态**（追加写被强杀时末行只写了一半），
 *   所以不能用 `badLines > 0` 当告警条件，只能用 `allBad`（`badLines === lines`）。
 *
 * `keptSha1s` 是给孤儿对象检查用的：判断"目录里这个对象有没有人认领"时，
 * 索引和事件流是**两个独立的认领来源**，只认其中一个就会出现
 * "索引丢了 ⇒ 全部对象都成了孤儿"的假告警。
 *
 * @return {{exists:boolean, readable:boolean, lines:number, badLines:number,
 *           allBad:boolean, keptEvents:number, keptSha1s:string[],
 *           corruptEvents:number, confirmEvents:number, unconfirmed:boolean,
 *           lastCorruptAt:string, lastCorruptReason:string, lastConfirmAt:string,
 *           lastConfirmBy:string}}
 */
function scanEventHistory() {
  const out = {
    exists: false,
    readable: false,
    lines: 0,
    badLines: 0,
    allBad: false,
    keptEvents: 0,
    keptSha1s: [],
    guardEvents: 0,
    corruptEvents: 0,
    confirmEvents: 0,
    unconfirmed: false,
    lastCorruptAt: '',
    lastCorruptReason: '',
    lastConfirmAt: '',
    lastConfirmBy: '',
  };
  if (!state.eventsFile) return out;

  let raw = '';
  try {
    raw = fs.readFileSync(state.eventsFile, 'utf8');
    out.exists = true;
    out.readable = true;
  } catch (err) {
    // ENOENT ⇒ 文件本来就没有（首次使用）；其它 ⇒ 存在但读不了。两者都不能当成"没坏过"。
    out.exists = !(err && err.code === 'ENOENT');
    return out;
  }

  let pending = false;
  const keptSeen = new Set();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    out.lines += 1;
    let ev = null;
    try {
      ev = JSON.parse(line);
    } catch (err) {
      out.badLines += 1; // 单行坏了不影响别的行，但"坏了多少行"本身是读数
      continue;
    }
    if (!ev || typeof ev !== 'object') {
      // 能 parse 出来但不是事件对象（`null` / `123` / `"x"`）⇒ 同样是"读不出事件"
      out.badLines += 1;
      continue;
    }
    if (ev.kind === KIND_KEPT || ev.kind === KIND_KEPT_DEDUP) {
      out.keptEvents += 1;
      // 认领清单（给孤儿对象检查）。同一个 sha1 只记一次，免得数组被重复项撑大。
      if (typeof ev.sha1 === 'string' && ev.sha1 && !keptSeen.has(ev.sha1)) {
        keptSeen.add(ev.sha1);
        out.keptSha1s.push(ev.sha1);
      }
      continue;
    }
    /**
     * 恢复前保护写下的那一版：**计数归计数、认领归认领**。
     *   · 不并进 `keptEvents` —— 那个数字的门禁语义是"落地/验收了几次"，
     *     把保护也算进去会让它悄悄变大，而看数字的人不会去分辨；
     *   · 但它的 sha1 必须进 `keptSha1s`（认领清单），否则索引重建之后，
     *     我们自己刚写进去的字节副本会被 `orphanInfo` 报成"没人认领的对象"。
     */
    if (ev.kind === KIND_RESTORE_GUARD) {
      out.guardEvents += 1;
      if (typeof ev.sha1 === 'string' && ev.sha1 && !keptSeen.has(ev.sha1)) {
        keptSeen.add(ev.sha1);
        out.keptSha1s.push(ev.sha1);
      }
      continue;
    }
    if (ev.kind === KIND_INDEX_CORRUPT) {
      out.corruptEvents += 1;
      pending = true;
      out.lastCorruptAt = typeof ev.at === 'string' ? ev.at : '';
      out.lastCorruptReason = typeof ev.reason === 'string' ? ev.reason : '';
      continue;
    }
    if (ev.kind === KIND_INDEX_CONFIRMED) {
      out.confirmEvents += 1;
      pending = false;
      out.lastConfirmAt = typeof ev.at === 'string' ? ev.at : '';
      out.lastConfirmBy = typeof ev.by === 'string' ? ev.by : '';
    }
  }
  out.unconfirmed = pending;
  /* ★ "读了但一行都没读出来" —— 不许折成"没有记录"。
   *   部分坏行是正常形态（追加写被强杀的末行），全部坏行不是：
   *   ＞0 行、且行行都 parse 不出事件 ⇒ 这个凭证文件已经废了。
   *   判据方向：只有 `lines > 0` 才谈得上 `allBad`（空文件不是"全坏"，是"还没有内容"）。 */
  out.allBad = out.lines > 0 && out.badLines === out.lines;
  return out;
}

/**
 * 读"我坏过一次"的持久凭证。
 * ⚠️ 第三版起它**只是辅助证据**（给人看、好读），不再单独决定结论 ——
 *    删掉它不会让结论变宽松（那件事由 `scanEventHistory()` 兜）。
 * @return {{present:boolean, at:string, reason:string, backup:string, rebuiltEntries:number, eventsReadable:boolean}}
 */
function readRepairMarker() {
  const empty = { present: false, at: '', reason: '', backup: '', rebuiltEntries: 0, eventsReadable: false };
  if (!state.dir) return empty;
  const p = path.join(state.dir, INDEX_REPAIR_NAME);
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return empty; // 不存在 / 读不了 ⇒ 没有凭证（读不了本身已由索引那条兜）
  }
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    // 凭证自己坏了：仍然算"我坏过"（宁可少说 never_kept，不可多报）
    return Object.assign({}, empty, { present: true, reason: 'repair_marker_unreadable' });
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return Object.assign({}, empty, { present: true, reason: 'repair_marker_unreadable' });
  }
  return {
    present: true,
    at: typeof obj.at === 'string' ? obj.at : '',
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    backup: typeof obj.backup === 'string' ? obj.backup : '',
    rebuiltEntries: Number(obj.rebuiltEntries) || 0,
    eventsReadable: obj.eventsReadable === true,
  };
}

/**
 * 遍历内容寻址目录：`<dir>/<sha1前2位>/<sha1>/<原文件名>`。
 *
 * 为什么需要它：**目录本身就是证据。** 一份对象躺在那里，就证明"这个东西被保管过"，
 * 哪怕索引、凭证、事件流三个文件全被人删了 —— 那时旧实现会报 `never_kept`
 * （"从来没保管过"），而真相是"我不知道这是谁的，但我确定它存在"。
 * 这是同一个病的第六次：**一个故障被报成一种正常状态，方向是变宽松。**
 *
 * 扫描是**只读**的，且只认形状严格匹配的两层目录名（2 位十六进制 / 40 位十六进制），
 * 免得把 `_index.json.corrupt-<ts>` 之类的文件当成对象。
 *
 * `truncated:true` ⇒ 对象数超过 `MAX_STORE_SCAN_ENTRIES`，**本次读数只是下界**。
 * 宁可少报也不能因为怕慢就假装扫完了（那是把"没扫"读成"没有"）。
 *
 * @return {{exists:boolean, readable:boolean, objects:number, sha1s:string[],
 *           truncated:boolean}}
 */
function scanStoreObjects() {
  const out = { exists: false, readable: false, objects: 0, sha1s: [], entries: [], truncated: false };
  if (!state.dir) return out;

  let top = [];
  try {
    top = fs.readdirSync(state.dir, { withFileTypes: true });
    out.exists = true;
    out.readable = true;
  } catch (err) {
    // 连保管库目录都读不了 ⇒ exists 留着 false 并在调用方体现（不许当成"目录是空的"）
    out.exists = !(err && err.code === 'ENOENT');
    return out;
  }

  const two = new RegExp('^[0-9a-f]{2}$');
  const forty = new RegExp('^[0-9a-f]{40}$');
  const found = [];
  for (const ent of top) {
    if (out.truncated) break;
    if (!ent || !ent.isDirectory || !ent.isDirectory()) continue;
    const lvl1Name = typeof ent.name === 'string' ? ent.name : '';
    if (!two.test(lvl1Name)) continue; // `_custody` 自己的元数据文件 / 其它杂项目录一律不认
    let lvl2 = [];
    try {
      lvl2 = fs.readdirSync(path.join(state.dir, lvl1Name), { withFileTypes: true });
    } catch (err) {
      continue; // 单个前缀目录读不了 ⇒ 跳过（不把它当成"这里没有对象"，但也不中断整轮）
    }
    for (const sub of lvl2) {
      if (!sub || !sub.isDirectory || !sub.isDirectory()) continue;
      const sha1Name = typeof sub.name === 'string' ? sub.name : '';
      if (!forty.test(sha1Name)) continue;
      const dirPath = path.join(state.dir, lvl1Name, sha1Name);
      let files = [];
      try {
        files = fs.readdirSync(dirPath);
      } catch (err) {
        continue;
      }
      if (!files.length) continue; // 空目录不算对象（写了一半就退出的残留）
      /**
       * mtime = **这个对象最近一次被写**的时间，给"宽限期"用（见 `orphanInfo()`）。
       * 取目录本身的 mtime：`writeStoreCopy()` 是 `copy 到 tmp → rename 进目录`，
       * rename 会更新目录 mtime，所以它能反映"刚写完"。
       * 取不到（NaN）**不许**折成"很旧" —— 那样未知会被判成真孤儿；
       * 也不许折成"很新" —— 那样故障会被宽限期藏起来。原样带 NaN 出去，
       * 由 `orphanInfo()` 明确按"未知 ⇒ 按真孤儿报"处理（保守方向）。
       */
      let mtimeMs = NaN;
      try {
        mtimeMs = fs.statSync(dirPath).mtimeMs;
      } catch (err) {
        mtimeMs = NaN;
      }
      found.push({ sha1: sha1Name, mtimeMs });
      out.objects += 1;
      if (out.objects >= MAX_STORE_SCAN_ENTRIES) {
        out.truncated = true;
        break;
      }
    }
  }
  found.sort((a, b) => (a.sha1 < b.sha1 ? -1 : (a.sha1 > b.sha1 ? 1 : 0))); // 读数稳定
  out.entries = found;
  out.sha1s = found.map((f) => f.sha1);
  return out;
}

/**
 * 孤儿对象：内容寻址目录里有、但**没有任何凭证认领**的对象。
 *
 * 认领来源有两个，缺一不可：
 *   · `_index.json`（`sha1` / `firstSha1` / `lastSha1` / `revisions[].sha1`）；
 *   · `_events.jsonl` 里的 `artifact-kept` / `artifact-kept-dedup`。
 *
 * ⚠️ 为什么把事件流也算认领（这条是我对规格的**收窄**，理由必须写清，否则下一个人会
 *   "按字面改回去"）：索引只保留最近 `MAX_REVISIONS = 20` 条 revisions，更早的修订版
 *   会被裁掉，但磁盘副本**永不删除**。若只认索引，任何被改写超过 20 次的正常产物都会
 *   永久多出一批"孤儿" ⇒ 永久 `index_corrupt` ⇒ 告警变成噪声 ⇒ 最后没人看告警。
 *   "孤儿"要表达的是**没有任何凭证能说清它是谁**；能说清的（事件流里有 keep 记录）
 *   不是孤儿，只是索引里没留档。两者处置完全不同。
 *
 * 所以真正的孤儿只剩这几种成因：
 *   · 三个凭证文件全被删/全被清空，而对象还在（← 这一条就是 D4 要报的那件事）；
 *   · `keep` 写完了字节副本、还没写索引/事件就崩了（下次 `audit` 会指出来）；
 *   · 有人手工往目录里塞了东西。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 宽限期：一个会误报的告警等于没有告警（`orphan_pending`）
 * ═══════════════════════════════════════════════════════════════════════════
 * 成因第二条有一个**确定会发生的误报窗口**：另一个进程正在 `keep` 的中间态
 *   —— 字节副本已经 rename 进目录、索引/事件还没写。这几十毫秒里，
 *   本进程的 `audit()` 看到的就是一个"没人认领的对象"。
 *
 * 而这个模块自己写明了"同一路径并发 `keep` 非原子"（见「已知限制」第 1 条），
 * 也就是说这个窗口是**设计上承认存在**的。那么把它报成 `orphan_objects` 等于
 * **让一个已知的正常中间态天天报警**。后果不是"多一条告警"，而是：
 * **告警变成噪声 ⇒ 最后连真报也没人看。**
 *
 * ⇒ 用 mtime 做一个**确定性**判据，不靠人调参：
 *   · 对象最近被写的时间在 `orphanGraceMs` 之内 ⇒ `orphan_pending`（**可见但不报错**）
 *   · 早于宽限期                          ⇒ `orphan_objects`（真孤儿，`corrupt:true`）
 * 宽限期过后它会**自己升级**成 `orphan_objects` —— 不需要人去处理，这是它能被接受的前提。
 * 也就是说：`orphan_pending` 不是"把问题藏起来"，是"给正在写的那个进程一点时间"。
 *
 * 两个方向都必须不撒谎：
 *   · `pendingCount` 必须照报（不许因为"它不导致告警"就静默略过）；
 *   · mtime **取不到**时按"真孤儿"处理（未知不许当好消息 —— 见 `scanStoreObjects()`）。
 *
 * @param {Object<string,object>} idx
 * @param {Object} hist `scanEventHistory()` 的返回值
 * @return {{count:number, sha1s:string[], pendingCount:number, pendingSha1s:string[],
 *           graceMs:number, store:Object}}
 */
function orphanInfo(idx, hist) {
  const store = scanStoreObjects();
  const ref = new Set();
  const idxObj = idx && typeof idx === 'object' ? idx : {};
  const keys = Object.keys(idxObj);
  for (const k of keys) {
    const e = idxObj[k];
    if (!e || typeof e !== 'object') continue;
    if (typeof e.sha1 === 'string' && e.sha1) ref.add(e.sha1);
    if (typeof e.firstSha1 === 'string' && e.firstSha1) ref.add(e.firstSha1);
    if (typeof e.lastSha1 === 'string' && e.lastSha1) ref.add(e.lastSha1);
    const revs = Array.isArray(e.revisions) ? e.revisions : [];
    for (const r of revs) {
      if (r && typeof r.sha1 === 'string' && r.sha1) ref.add(r.sha1);
    }
  }
  const kept = hist && Array.isArray(hist.keptSha1s) ? hist.keptSha1s : [];
  for (const s of kept) {
    if (typeof s === 'string' && s) ref.add(s);
  }

  const graceMs = Number.isFinite(state.orphanGraceMs) && state.orphanGraceMs >= 0
    ? state.orphanGraceMs
    : ORPHAN_GRACE_MS;
  const now = Date.now();
  const orphans = [];
  const pendings = [];
  for (const ent of store.entries) {
    if (ref.has(ent.sha1)) continue;
    const mt = ent.mtimeMs;
    /* mtime 未知（NaN）⇒ **按真孤儿报**。理由：未知不许当好消息。
     * 反过来（折成"刚写完"⇒ pending）就等于给"读不到 mtime"开了一个永久豁免。 */
    const recent = Number.isFinite(mt) && (now - mt) < graceMs;
    if (recent) pendings.push(ent.sha1);
    else orphans.push(ent.sha1);
  }
  return {
    count: orphans.length,
    sha1s: orphans,
    pendingCount: pendings.length,
    pendingSha1s: pendings,
    graceMs,
    store,
  };
}

/**
 * 从 `_events.jsonl` 重建索引。
 *
 * **为什么能重建**：事件里每条 `artifact-kept` / `artifact-kept-dedup` 都带
 * `{path, sha1, bytes, at}`，而索引条目要的正是"每个路径最近一次被 keep 批准的内容"
 * 加上首次入库信息。事件是**追加写、不改写**的，所以它比索引更接近真相。
 *
 * **为什么必须重建**：不重建的话，一次索引损坏会让"篡改检测"这个能力整体消失，
 * 而报告里只会显示一堆 `never_kept` —— 看起来像"这些文件本来就没保管过"。
 * 这正是那个病：**一个故障被报成一种正常状态。**
 *
 * @return {{idx:Object, eventsReadable:boolean, eventsLines:number, entries:number}}
 */
function rebuildIndexFromEvents() {
  const out = { idx: {}, eventsReadable: false, eventsLines: 0, entries: 0 };
  if (!state.eventsFile) return out;
  let raw = '';
  try {
    raw = fs.readFileSync(state.eventsFile, 'utf8');
    out.eventsReadable = true;
  } catch (err) {
    return out; // 事件也读不到 ⇒ 无从重建（调用方据此**不许**再说 never_kept）
  }
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    out.eventsLines += 1;
    let ev = null;
    try {
      ev = JSON.parse(line);
    } catch (err) {
      continue; // 单行坏了不影响其余行（追加写的最后一行的典型形态）
    }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind !== KIND_KEPT && ev.kind !== KIND_KEPT_DEDUP) continue;
    const key = typeof ev.path === 'string' ? ev.path : '';
    const sha1 = typeof ev.sha1 === 'string' ? ev.sha1 : '';
    if (!key || !sha1) continue;
    const at = typeof ev.at === 'string' ? ev.at : '';
    const bytes = Number(ev.bytes) || 0;
    const prev = (out.idx[key] && typeof out.idx[key] === 'object') ? out.idx[key] : null;
    const revisions = prev && Array.isArray(prev.revisions) ? prev.revisions.slice() : [];
    const lastRev = revisions.length ? revisions[revisions.length - 1] : null;
    const lastRevSha1 = lastRev && typeof lastRev.sha1 === 'string' ? lastRev.sha1 : '';
    if (lastRevSha1 !== sha1) revisions.push({ sha1, bytes, at });
    out.idx[key] = {
      sha1,
      bytes,
      firstAt: prev && prev.firstAt ? prev.firstAt : at,
      firstSha1: prev && prev.firstSha1 ? prev.firstSha1 : sha1,
      lastSha1: sha1,
      lastAt: at,
      revisions: revisions.slice(-MAX_REVISIONS),
    };
  }
  out.entries = Object.keys(out.idx).length;
  return out;
}

/**
 * 索引坏了之后的自救：**留证 → 重建 → 记账**。三步缺一不可。
 *   ① 把坏文件改名成 `_index.json.corrupt-<ts>`（留证：事后能人肉看出坏成什么样）；
 *   ② 从事件重建并写回（尽力恢复能力，不做"反正坏了就算了"）；
 *   ③ 落一个持久凭证 `_index.repair.json` + 一条 `index-corrupt` 事件
 *      （否则下一次读就是"干净的索引"，故障再次被静默）。
 * @param {string} reason
 * @return {Object} 与 `readIndexState()` 同形
 */
function recoverIndex(reason) {
  const at = nowIso();
  let backup = '';
  try {
    backup = state.indexFile + '.corrupt-' + at.replace(/[:.]/g, '-');
    fs.renameSync(state.indexFile, backup);
  } catch (err) {
    // 改名失败（被占用/权限）：退化成复制留证，原文件保留 —— 不许因为留证失败就跳过错
    try {
      backup = state.indexFile + '.corrupt-' + at.replace(/[:.]/g, '-');
      fs.copyFileSync(state.indexFile, backup);
    } catch (err2) {
      backup = '';
    }
  }

  const rebuilt = rebuildIndexFromEvents();
  // 重建出来的内容立刻写回：否则每次读都要重建，且下一次 keep 会把 {} 当基线
  try {
    writeIndex(rebuilt.idx);
  } catch (err) {
    // 写不回去也要返回重建结果（本次调用仍可用）
  }

  const marker = {
    at,
    reason,
    backup,
    rebuiltEntries: rebuilt.entries,
    eventsReadable: rebuilt.eventsReadable,
    eventsLines: rebuilt.eventsLines,
  };
  try {
    fs.writeFileSync(path.join(state.dir, INDEX_REPAIR_NAME), JSON.stringify(marker, null, 2) + '\n', 'utf8');
  } catch (err) {
    // 凭证写不下去：本次调用仍然返回 ok:false（本次是安全的），
    // 但下次读就会看到"干净的索引" —— 这是本模块已知的一个窄缺口，见文件头「已知限制」。
  }
  appendEvent({
    at,
    kind: KIND_INDEX_CORRUPT,
    reason,
    backup: normalizeKey(backup),
    rebuiltEntries: rebuilt.entries,
    eventsReadable: rebuilt.eventsReadable,
    eventsLines: rebuilt.eventsLines,
  });

  return {
    ok: false,
    reason: 'index_corrupt',
    detail: reason,
    idx: rebuilt.idx,
    backup,
    rebuilt: true,
    rebuiltEntries: rebuilt.entries,
    eventsReadable: rebuilt.eventsReadable,
    marker: true,
  };
}

/**
 * 读 `_index.json`。**不许静默降级成 `{}`**。
 *
 * 旧实现（已删）任何异常都 `return {}`。后果不是"少一点元数据"，而是：
 * 索引一坏 ⇒ 每个路径都查不到基线 ⇒ `audit()` 把**全部**产物报成
 * `never_kept` ⇒ "篡改检测"这个能力整体消失，而报告读起来像
 * "这些文件本来就没保管过"。**一个故障被报成一种正常状态。**
 *
 * 判定顺序是固定的，**顺序本身就是规格**（team-lead 2026-10-23 裁决）：
 *   1. `_index.json` 能解析                        → 走原路径
 *   2. `_index.json` 坏了（读不了/parse 失败/形状不对）→ `index_corrupt`（origin=file_bad）+ 立刻自救
 *   3. `_index.json` 好、但历史事件里存在 `index-corrupt` 且其后没有
 *      `index-repair-confirmed`                     → **仍报 `index_corrupt`**
 *                                                     （origin=history_unconfirmed / history_incomplete）
 *   3.5 内容寻址目录里有对象、却没有任何凭证认领      → `index_corrupt`（origin=orphan_objects）
 *   4. 有 `index-repair-confirmed`                 → `repaired:true`，允许按索引正常报
 * 第 3.5 条在 `applyOrphans()` 里，只在前面都"没问题"时占用 `origin`（细节见该函数）。
 * 第 3 条是第三版的核心：**主凭证是 append-only 的事件流，不是 `_index.repair.json`。**
 * 删掉那个文件之后结论必须**保持不变**（仍报 index_corrupt），否则就是同一个病的第三次：
 * 一次"清理临时文件"让"我不知道管没管过"重新变成"从来没保管过"。
 *
 * 另外补掉了一个同源缺口（第 2.5 条）：**索引文件被删掉**（ENOENT）时，旧实现当成
 * "首次使用"⇒ 全部 `never_kept`，而事件流里明明有 keep 记录。现在只要事件里有过
 * `artifact-kept`，就按"索引丢了"处理 ⇒ 从事件重建 + 报 `index_corrupt`。
 * 只有"索引没有 **且** 事件里一条 keep 都没有"才算真的首次使用。
 *
 * @return {{ok:boolean, idx:Object<string,object>, reason:string, detail:string,
 *           origin:string, backup:string, rebuilt:boolean, rebuiltEntries:number,
 *           eventsReadable:boolean, repaired:boolean, confirmed:boolean,
 *           marker:Object, history:Object, historyIncomplete:boolean,
 *           orphanCount:number, orphanSha1s:string[], storeObjects:number,
 *           storeReadable:boolean, storeTruncated:boolean}}
 */
function readIndexState(opts) {
  const core = readIndexStateCore();
  const wantStore = !!(opts && opts.scanStore === true);
  return (wantStore ? applyOrphans(core, core.history, core.idx) : core);
}

/**
 * 在核心判定之上加一条**全局**不变量：**内容寻址目录里的对象必须有人认领。**
 *
 * 位置说明（这是规格的一部分）：它是决策顺序的**第 3.5 条** ——
 *   1 能解析 → 2 文件坏了 → 3 历史坏过没人确认 → **3.5 有孤儿对象** → 4 已确认。
 * 之所以排在第 3 条之后：前三件事说明"这份元数据不可信"，
 * 而孤儿说的是"有东西存在、可我完全不知道它是谁"。两者同时成立时，
 * 前面那三件更紧急（它们指向"去修索引/去确认"），孤儿信息也不丢 ——
 * 它由 `orphanCount` 独立带出，**不靠 `origin` 一个字段承载**。
 *
 * 只对 `ok === true` 的结果升级：已经 `ok:false` 时再改 `origin` 会把
 * "文件坏了"这条更具体的信息盖掉（那正是"两个语义合并"）。
 *
 * @param {Object} base `readIndexStateCore()` 的返回值
 * @param {Object} hist `scanEventHistory()` 的返回值
 * @param {Object<string,object>} idx 本次判定实际采用的索引（含重建结果）
 * @return {Object} 同形
 */
function applyOrphans(base, hist, idx) {
  const info = orphanInfo(idx, hist);
  const rec = Object.assign({}, base, {
    orphanCount: info.count,
    orphanSha1s: info.sha1s,
    /* 宽限期内的"待定孤儿"：**不导致 corrupt，但必须出现在输出里且计数**。
     * 静默略过就等于把它变成了"没发生过"——那是这个模块一直在治的病。 */
    orphanPendingCount: info.pendingCount,
    orphanPendingSha1s: info.pendingSha1s,
    orphanGraceMs: info.graceMs,
    storeObjects: info.store.objects,
    storeReadable: info.store.readable === true,
    storeTruncated: info.store.truncated === true,
    /* 历史读数在这里**统一归一**：核心判定有 6 条出口，逐条补三个字段必然漏一条
     * （漏的那条会让 `audit()` 报 0 —— 又一个"没读到"被读成"没有"）。 */
    historyLines: (hist && Number(hist.lines)) || 0,
    historyBadLines: (hist && Number(hist.badLines)) || 0,
    historyAllBad: !!(hist && hist.allBad === true),
  });
  /* ★ 这一行是 M7 变异臂的靶子：拆掉它 ⇒ "三删 + 目录非空"会退回 never_kept。
   *   条件里 `rec.ok === true` 不能省：已经不可信时不要覆盖更具体的原因。 */
  if (info.count > 0 && rec.ok === true) {
    return Object.assign({}, rec, {
      ok: false,
      reason: 'index_corrupt',
      /* 数量是证据，不是形容词 —— 调用方一眼能看出是"1 个说不清"还是"300 个说不清" */
      detail: 'orphans:' + info.count,
      origin: 'orphan_objects',
      historyIncomplete: false,
      confirmed: false,
    });
  }
  /* 只有"待定孤儿"时：`ok` 保持 true（不报错），但 `origin` 与 `detail` 必须把这件事
   * 写在脸上 —— 否则调用方看到的是一份"完全健康"的报告，而实际上有一批对象说不清是谁的。 */
  if (info.pendingCount > 0 && rec.ok === true) {
    return Object.assign({}, rec, {
      origin: 'orphan_pending',
      detail: 'orphans_pending:' + info.pendingCount,
    });
  }
  return rec;
}

/**
 * 核心判定（不含孤儿对象那一条全局不变量）。
 * 拆成两个函数是因为孤儿扫描要**遍历整个内容寻址目录**，代价随对象数线性增长；
 * `keep()` / `check()` / `restore()` 每次调用都做一遍不合理。
 * 分工：`audit()` 是**全局**出口，它扫；单文件操作不扫（孤儿本来也不是"某个文件"的属性）。
 * 名字里带 Core 就是提醒：**不许**在别处直接调用它而绕过不变量检查。
 * @return {Object} 同 `readIndexState()`
 */
function readIndexStateCore() {
  const hist = scanEventHistory();
  const none = {
    ok: true,
    idx: {},
    reason: '',
    detail: '',
    origin: '',
    backup: '',
    rebuilt: false,
    rebuiltEntries: 0,
    eventsReadable: hist.readable,
    repaired: false,
    confirmed: false,
    marker: readRepairMarker(),
    history: hist,
  };
  if (!state.indexFile) return none;
  /* `repaired` = **历史上坏过**（辅助凭证在，或事件流里有 corrupt 记录，或有人确认过）。
   * 第三个版本起它不再等价于"可信"：可信与否看 `ok` / `confirmed`。
   * 所以不能再用 marker 一个文件来算它 —— 删了 marker 不等于没坏过。
   * ⚠️ 第四个来源 `confirmEvents > 0`：存在一条 `index-repair-confirmed` 就**证明**坏过
   *   （确认这个动作有对象）。漏掉它的后果实测可见：事件流整份损坏、人工确认之后
   *   `repaired:false` 而 `confirmEvents:1`，于是 `confirmed` 也报 false ——
   *   "确认过"这件事在读数上没有留下痕迹。 */
  const repaired = none.marker.present || hist.corruptEvents > 0 || hist.confirmEvents > 0;
  none.repaired = repaired;

  /**
   * ★★ 历史缺失（第四个版本补，实测发现）：**辅助凭证在、事件流里却找不到任何 corrupt 记录**
   *   ⇒ 事件流不可信（被截断 / 被删 / 最后一行坏掉），而不是"没坏过"。
   *
   * 发现经过（这一条不是想出来的，是测出来的）：索引与事件**同时**被截断的探针场景里，
   *   `recoverIndex()` 把 `index-corrupt` 事件**追加**到那个被截断到半行的文件末尾 ——
   *   于是新事件被拼进那半行垃圾里，整行 parse 不了 ⇒ 下一次 `scanEventHistory()`
   *   读到 `corruptEvents === 0` ⇒ `unconfirmed === false` ⇒ **结论悄悄变回"可信"**，
   *   而此刻 `tampered` 已经从 1 掉到 0（重建只救回前缀一条）。
   *   也就是说：**"事件流丢了记录" 被读成了 "没有坏过"** —— 同一个病的第五次。
   *
   * 所以判定要多一条：`repaired && corruptEvents === 0` ⇒ 历史缺失 ⇒ 按未确认处理。
   * 方向永远是保守那一侧：我不知道有没有人确认过，就当我没看见确认。
   *
   * ★★ 第五个版本再加一条：`hist.allBad`（读到 N 行、行行都是垃圾）。
   *   `repaired` 那两个来源都要求"有凭证"，可如果凭证文件**本身**整份都 parse 不了呢？
   *   那时 `repaired` 可能是 false（没有 marker、也没有一条能 parse 的 corrupt 事件），
   *   于是 `histIncomplete` 为 false ⇒ `ok:true` ⇒ "元数据可信"。
   *   而真相是：**我把凭证读了，一行都没读出来。** 又一次"读了但没读到"折成"没有"。
   *   ⇒ `allBad` 与 `histIncomplete` 是同一类事实（凭证不可用），归到同一个判定，
   *     但用 `detail` 分开（`history_all_bad` vs `history_incomplete`），
   *     不许把两种成因压成同一个字符串 —— 那正是"两个语义合并"。
   */
  const histAllBad = hist.allBad === true;
  const histIncomplete = (repaired && hist.corruptEvents === 0 && hist.confirmEvents === 0) || histAllBad;
  const unconfirmed = hist.unconfirmed || histIncomplete;
  /* 这四个值必须互不相同（门禁 J 组逐对断言），因为处置完全不同：
   *   file_bad           → 去看 .corrupt-<ts> 留证、看重建救回几条
   *   history_unconfirmed→ 去找人 confirmRepair（凭证在，记录也在，就是没人认）
   *   history_incomplete → 凭证读不出/记录丢了，先查事件流为什么坏，再确认
   *   orphan_objects     → 对象在、没人认领：先查是谁删了索引，别急着确认 */
  const histOrigin = histIncomplete ? 'history_incomplete' : 'history_unconfirmed';
  /* 三路 detail：`history_all_bad`（读到全坏）/ `history_incomplete`（凭证在、记录丢了）/
   * `history_unconfirmed`（记录在、就是没人认）。三者的处置不同，所以不许共用同一个字符串。
   * ⚠️ 第一版我把它写成了二选一（`allBad ? all_bad : incomplete`），结果
   *   "记录在、只是没人确认"这一路被错标成了 `history_incomplete` —— 实测出来的。 */
  const histDetail = histAllBad
    ? 'history_all_bad'
    : (histIncomplete ? 'history_incomplete' : 'history_unconfirmed');
  none.historyIncomplete = histIncomplete;
  none.historyAllBad = histAllBad;
  none.historyBadLines = hist.badLines;

  /** 统一出口：坏索引自救之后，把"辅助凭证 + 历史"一起带上。 */
  const afterRecover = (detail) => {
    const rec = recoverIndex(detail);
    rec.origin = 'file_bad';
    rec.marker = readRepairMarker();
    rec.repaired = true;
    rec.confirmed = false;
    /* 自救之后重新读一遍历史，`historyIncomplete` 按**实测**算。
     * 旧写法直接写 false —— 那是在"自救成功"和"凭证读出来了"之间做了个假设：
     * 追加那条 `index-corrupt` 事件如果被拼进了半行垃圾里，`corruptEvents` 仍然是 0。 */
    const recHist = scanEventHistory();
    rec.history = recHist;
    rec.historyAllBad = recHist.allBad === true;
    rec.historyBadLines = recHist.badLines;
    rec.historyIncomplete = recHist.allBad === true
      || (recHist.corruptEvents === 0 && recHist.confirmEvents === 0);
    return rec;
  };

  let raw = '';
  try {
    raw = fs.readFileSync(state.indexFile, 'utf8');
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      // 读不了 ≠ 没有。权限/占用等一律按"坏"处理。
      return afterRecover('index_read_failed:' + ((err && err.code) || 'ERR'));
    }
    /* ★ 第 2.5 条：索引文件**不见了**。要么真的首次使用，要么被删了。
     *   判据：事件流里有没有 keep 记录 —— 有 ⇒ 索引丢了，不是没建过。 */
    if (hist.readable && hist.keptEvents > 0) return afterRecover('index_missing_but_events_exist');
    if (unconfirmed) {
      // 索引没了、但历史上坏过且没确认 ⇒ 不许说 never_kept
      return Object.assign({}, none, {
        ok: false, reason: 'index_corrupt', detail: histDetail,
        origin: histOrigin, repaired, confirmed: false, historyIncomplete: histIncomplete,
      });
    }
    return none;
  }
  if (!raw.trim()) {
    /* 空文件：正常 init 写的就是 `{}`。但"被清空"和"刚建好"长得一样，
     * 同样用事件流来分辨 —— 这条与上面的 ENOENT 分支必须一致，
     * 否则清空索引就成了绕过检测的后门。 */
    if (hist.readable && hist.keptEvents > 0) return afterRecover('index_empty_but_events_exist');
    if (unconfirmed) {
      return Object.assign({}, none, {
        ok: false, reason: 'index_corrupt', detail: histDetail,
        origin: histOrigin, repaired, confirmed: false, historyIncomplete: histIncomplete,
      });
    }
    return none;
  }
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return afterRecover('index_parse_failed');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return afterRecover('index_shape_invalid');
  }

  /* ★ 第 3 条：索引此刻是好的，但历史上有一次"坏过"没人确认。
   *   `ok:false` 是刻意的：`ok` 表达的是"这份元数据现在可不可信"，
   *   而不是"这个 JSON 文件能不能被 JSON.parse"。后者由 origin/detail 区分。
   *   `idx` 仍然带出去（obj）—— 不许因为"不可全信"就把可用信息一起丢掉。 */
  if (unconfirmed) {
    return {
      ok: false,
      idx: obj,
      reason: 'index_corrupt',
      detail: histDetail,
      origin: histOrigin,
      historyIncomplete: histIncomplete,
      historyAllBad: histAllBad,
      historyBadLines: hist.badLines,
      backup: none.marker.backup,
      rebuilt: false,
      rebuiltEntries: none.marker.rebuiltEntries,
      eventsReadable: hist.readable,
      repaired: true,
      confirmed: false,
      marker: none.marker,
      history: hist,
    };
  }

  return {
    ok: true,
    idx: obj,
    reason: '',
    detail: '',
    origin: '',
    backup: none.marker.backup,
    rebuilt: false,
    rebuiltEntries: none.marker.rebuiltEntries,
    eventsReadable: hist.readable,
    repaired,
    /* 只有"历史上坏过 **且** 之后有人确认过"才算 confirmed。
     * 没坏过时它也是 false —— 那时"确认"这个动作没有对象，说 true 是虚报。 */
    confirmed: repaired && !unconfirmed,
    historyIncomplete: histIncomplete,
    historyAllBad: histAllBad,
    historyBadLines: hist.badLines,
    marker: none.marker,
    history: hist,
  };
}

/**
 * 索引是否"不可全信"：`ok === false` —— 也就是**本次坏** 或 **历史坏过且没人确认**。
 * 判据集中在一处，免得 `audit` / `check` / `restore` 各写一遍还写得不一致。
 *
 * ⚠️ 第三个版本起**不许再看 `repaired`**。原因（这个坑我踩了，留档）：
 *   `repaired` 现在的意思是"**历史上**坏过"，它是永久为真的历史事实 ——
 *   `confirmRepair()` 之后它依然是 true。若还拿它当"不可信"，那么**人工确认之后
 *   仍然永远报 `index_corrupt`**，出口就形同不存在（实测：F14f 红，
 *   confirmRepair 成功后两条仍是 index_corrupt）。
 *   ⇒ 可信与否看 `ok`；"坏过没有"看 `repaired`；"认过没有"看 `confirmed`。三个问题三个字段。
 * @param {Object} ix `readIndexState()` 的返回值
 * @return {boolean}
 */
function indexSuspect(ix) {
  return !!(ix && ix.ok === false);
}

/**
 * 人工确认"这次索引修复我认了" —— 本模块**唯一**的可操作开关。
 *
 * 为什么必须有这个入口：`index-corrupt` 事件一旦落进 append-only 的事件流，
 * 在没人确认之前 `audit()` 会一直报 `index_corrupt`。这是保守方向，但如果没有
 * 出口，一条历史事件就会让这个库**永久**处于"元数据不可信"状态 —— 那种噪声
 * 会被人无视，最后等于没有告警。所以要有一个**显式、留名、可审计**的出口，
 * 而不是"删个文件就当修好了"（那正是前一版的残洞）。
 *
 * `by` 必填且非空：不许"一句话就洗白"。留名意味着这件事有人负责 ——
 * 空字符串会让审计链上出现一条无法追责的确认记录，比不确认更坏。
 *
 * 落点是 append-only 的 `_events.jsonl`：
 * `{kind:'index-repair-confirmed', by, note, at, confirmedCorruptAt}`。
 * 额外记 `confirmedCorruptAt`（它确认的是**哪一次**损坏），这样"确认了一次、
 * 之后又坏一次"在读数上可分辨 —— 后一次损坏仍然 pending。
 *
 * @param {string} by 确认人（必填，非空）
 * @param {string} [note] 备注（可空）
 * @return {{ok:boolean, reason:string, at:string, by:string, confirmedCorruptAt:string}}
 */
function confirmRepair(by, note) {
  const notReady = requireInit();
  if (notReady) return { ok: false, reason: notReady.reason, at: '', by: '', confirmedCorruptAt: '' };
  const who = typeof by === 'string' ? by.trim() : '';
  if (!who) {
    // 显式失败，绝不"当成功了" —— 一条匿名确认会让整条审计链失去追责能力
    return { ok: false, reason: 'by_required', at: '', by: '', confirmedCorruptAt: '' };
  }
  const hist = scanEventHistory();
  const marker = readRepairMarker();
  if (!hist.readable) {
    /* 事件流读不了 ⇒ 确认记不进去 ⇒ 不能返回成功。
     * 也不许复用 `by_required`：两种失败的处置完全不同（一个补名字，一个修文件）。 */
    return { ok: false, reason: 'events_unreadable', at: '', by: who, confirmedCorruptAt: '' };
  }
  /* ★ "有没有坏过"有**两个**独立来源：事件流里的 corrupt 记录，或辅助凭证文件。
   *   任一存在就说明该有人来确认 —— 事件流被截断时记录会丢，但凭证可能还在；
   *   凭证被删时记录还在。只认其中一个，就会出现"另一个没了 ⇒ 无事可确认"的滑稽结论。
   *   ★ 第三个来源：`hist.allBad`（整份事件流都是垃圾）。
   *     它同样说明"这里有东西坏了"，不把它算进来的后果是**这条告警没有出口** ——
   *     一个没有出口的告警最终会被人无视，等于没有告警。 */
  const brokeRecord = hist.corruptEvents > 0 || marker.present || hist.allBad === true;
  if (!brokeRecord) {
    // 真没坏过就没什么可确认的。返回 false，免得凭空造出一条确认记录。
    return { ok: false, reason: 'no_corrupt_record', at: '', by: who, confirmedCorruptAt: '' };
  }
  /* 历史缺失（有凭证、事件流里却没记录）⇒ **不许**当成"已经确认过"。
   * 那时我们连"上一次确认是谁"都读不出来，唯一安全的动作是**再写一条确认**。 */
  const histIncomplete = (marker.present && hist.corruptEvents === 0) || hist.allBad === true;
  if (!hist.unconfirmed && !histIncomplete) {
    // 已经确认过了（幂等）：不重复写事件，避免事件流被幂等调用灌满
    return { ok: true, reason: 'already_confirmed', at: hist.lastConfirmAt, by: hist.lastConfirmBy || who, confirmedCorruptAt: hist.lastCorruptAt };
  }

  const at = nowIso();
  const wrote = appendEvent({
    at,
    kind: KIND_INDEX_CONFIRMED,
    by: who,
    note: typeof note === 'string' ? note : '',
    confirmedCorruptAt: hist.lastCorruptAt,
    confirmedCorruptReason: hist.lastCorruptReason || (histIncomplete ? 'history_incomplete' : ''),
    corruptEvents: hist.corruptEvents,
    historyIncomplete: histIncomplete,
  });
  if (!wrote) {
    return { ok: false, reason: 'append_failed', at: '', by: who, confirmedCorruptAt: hist.lastCorruptAt };
  }
  return { ok: true, reason: '', at, by: who, confirmedCorruptAt: hist.lastCorruptAt };
}

/**
 * 原子写索引（tmp + rename；rename 失败退化成直写）。
 * @param {Object<string, object>} idx
 * @return {boolean}
 */
function writeIndex(idx) {
  if (!state.indexFile) return false;
  const body = JSON.stringify(idx, null, 2) + '\n';
  const tmp = state.indexFile + '.tmp' + process.pid;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, state.indexFile); // Windows 上等价 MOVEFILE_REPLACE_EXISTING
    return true;
  } catch (err) {
    try {
      fs.writeFileSync(state.indexFile, body, 'utf8');
      return true;
    } catch (err2) {
      return false;
    }
  }
}

/**
 * 追加一条事件。事件是审计的唯一来源，写失败也不能中断业务（返回 false 由调用方忽略）。
 *
 * ★★ **追加前必须保证文件以换行结尾。**（第五个版本补，实测发现，这是"修复动作
 *    破坏修复凭证"那条链的**根因**）
 *
 * 实测经过：`_events.jsonl` 被截断到**半行**（强杀/断电的正常形态）之后，
 *   `appendFileSync` 把新事件拼在那半行后面 ⇒ 两者连成一行 ⇒ 整行 parse 不了
 *   ⇒ 新写的那条 `index-corrupt` / `index-repair-confirmed` **凭空消失**。
 *   于是"我刚修好"和"我从来没修过"在读数上一模一样，而 `historyIncomplete`
 *   只是这件事的**症状**，不是它本身。
 *
 * 修法只是**补一个换行**，不动任何既有字节（仍然是 append-only）：
 *   读最后一个字节 → 不是 `\n` 就先写一个 `\n` → 再写事件。
 *   那半行垃圾仍然留在文件里（它是证据，不许悄悄抹掉），但它不再吃掉下一条事件。
 *
 * 残留代价（明确接受）：多写的那一个 `\n` 让"末行是半行"这件事在下一次读时
 *   表现为"1 条坏行 + 1 条好行"，即 `badLines:1` 而不是 `badLines:0`。
 *   这正是我们想要的：**它是可数的。**
 *
 * @param {object} ev
 * @return {boolean}
 */
function appendEvent(ev) {
  if (!state.eventsFile) return false;
  let line = '';
  try {
    line = JSON.stringify(ev) + '\n';
  } catch (err) {
    return false;
  }
  let prefix = '';
  try {
    const st = fs.statSync(state.eventsFile);
    if (st.size > 0) {
      const fd = fs.openSync(state.eventsFile, 'r');
      try {
        const buf = Buffer.alloc(1);
        const read = fs.readSync(fd, buf, 0, 1, st.size - 1);
        if (read === 1 && buf[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    /* 读不到末尾（文件不存在 / 被占用）⇒ 不补换行，交给 appendFileSync 自己的结果。
     * 这里**不许**返回 false：写不进去是调用方要处理的事，读末尾失败不是。 */
    prefix = '';
  }
  try {
    fs.appendFileSync(state.eventsFile, prefix + line, 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * init
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 初始化保管库。可重复调用（幂等），每次都会把内部状态切到新的 root。
 * @param {{root:string, subdir?:string}} opts
 *   `root`   —— **必须是绝对路径**（调用方自己拼好，本模块不猜 dataDir）
 *   `subdir` —— 在 root 下再拼一层的目录名，默认 `'_custody'`。
 *               传 `''` 表示"root 本身就是保管库目录"（推荐接线用这个：
 *               `init({ root: path.join(dataDir, 'custody'), subdir: '' })`
 *               ⇒ dir = `<dataDir>/custody`，与 `workflows/` 平级）。
 * @return {{ok:boolean, dir:string, reason?:string}}
 */
function init(opts) {
  const rootIn = opts && typeof opts === 'object' ? opts.root : '';
  const rootStr = typeof rootIn === 'string' ? rootIn.trim() : '';
  if (!rootStr) return { ok: false, dir: '', reason: 'root_required' };
  if (!path.isAbsolute(rootStr)) return { ok: false, dir: '', reason: 'root_not_absolute' };

  const subRaw = opts && typeof opts === 'object' ? opts.subdir : undefined;
  if (subRaw !== undefined && typeof subRaw !== 'string') {
    return { ok: false, dir: '', reason: 'subdir_invalid' };
  }
  // 只允许单层相对目录名：不许 `..`、不许绝对路径、不许路径分隔符 ——
  // 否则调用方一个笔误就能把保管库指到 root 外面去。
  const subdir = subRaw === undefined ? CUSTODY_DIR_NAME : subRaw.trim();
  if (subdir && (path.isAbsolute(subdir) || subdir.indexOf('..') >= 0
    || subdir.indexOf('/') >= 0 || subdir.indexOf('\\') >= 0)) {
    return { ok: false, dir: '', reason: 'subdir_invalid' };
  }

  let resolvedRoot = '';
  try {
    resolvedRoot = path.resolve(rootStr);
  } catch (err) {
    return { ok: false, dir: '', reason: 'root_invalid' };
  }

  /* `orphanGraceMs`：孤儿对象的宽限期，默认 `ORPHAN_GRACE_MS`。
   * 传 `undefined` ⇒ 用默认；传其它非负有限数 ⇒ 用它（门禁就是靠传小值来测两个方向，
   * 不靠真的等两分钟）。**负数 / NaN / 字符串一律拒绝**，不许静默回落到默认 ——
   * 一个"我设了但它偷偷用默认"的参数，比没有这个参数更坏。 */
  const graceRaw = opts && typeof opts === 'object' ? opts.orphanGraceMs : undefined;
  let orphanGraceMs = ORPHAN_GRACE_MS;
  if (graceRaw !== undefined) {
    if (typeof graceRaw !== 'number' || !Number.isFinite(graceRaw) || graceRaw < 0) {
      return { ok: false, dir: '', reason: 'orphan_grace_invalid' };
    }
    orphanGraceMs = graceRaw;
  }

  const dir = subdir ? path.join(resolvedRoot, subdir) : resolvedRoot;
  const indexFile = path.join(dir, INDEX_NAME);
  const eventsFile = path.join(dir, EVENTS_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, dir: '', reason: 'mkdir_failed:' + ((err && err.code) || 'ERR') };
  }

  if (!fs.existsSync(indexFile)) {
    try {
      fs.writeFileSync(indexFile, '{}\n', 'utf8');
    } catch (err) {
      return { ok: false, dir: '', reason: 'index_create_failed:' + ((err && err.code) || 'ERR') };
    }
  }
  if (!fs.existsSync(eventsFile)) {
    try {
      fs.writeFileSync(eventsFile, '', 'utf8');
    } catch (err) {
      return { ok: false, dir: '', reason: 'events_create_failed:' + ((err && err.code) || 'ERR') };
    }
  }

  state = { root: resolvedRoot, dir, indexFile, eventsFile, orphanGraceMs };
  return { ok: true, dir, orphanGraceMs };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 内部：写一份字节副本（只读尽力而为）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 把 `src` 字节复制成 `dst` 的保管副本，写完后 chmod 0o444。
 * 目标已存在时先解只读再删（修损坏副本用）。
 * @param {string} src
 * @param {string} dst
 * @return {{ok:boolean, reason?:string}}
 */
function writeStoreCopy(src, dst) {
  let tmp = '';
  try {
    try {
      if (fs.existsSync(dst)) {
        try { fs.chmodSync(dst, 0o666); } catch (err) { /* 尽力 */ }
        fs.unlinkSync(dst);
      }
    } catch (err) {
      // 删不掉就让下面的 copy 报错，别假装成功
    }
    tmp = dst + '.tmp' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
    try { fs.chmodSync(dst, 0o444); } catch (err) { /* 只读是尽力而为，见文件头说明 */ }
    return { ok: true };
  } catch (err) {
    if (tmp) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err2) { /* ignore */ }
    }
    return { ok: false, reason: (err && err.code) || 'copy_failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * keep —— 纳入保管
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 把一个产物纳入保管。
 *
 * 幂等语义：同一内容重复 `keep` ⇒ 不重复写盘，返回 `deduped:true`，
 * 但**仍然记一条事件**（`artifact-kept-dedup`），这样"某路径被重复验收"这件事
 * 在事件流里仍然可见（不是被吞掉）。
 *
 * @param {string} filePath 产物路径（相对/绝对都行，内部 resolve）
 * @param {object} [ctx] 附加说明（stage / workflowId / by 之类），只留原语，写进事件
 * @return {{ok:true, sha1:string, bytes:number, storePath:string, deduped:boolean}
 *         | {ok:false, reason:string}}
 */
function keep(filePath, ctx) {
  const notReady = requireInit();
  if (notReady) return notReady;

  const resolved = safeResolve(filePath);
  if (!resolved) return { ok: false, reason: 'bad_path' };
  if (insideCustody(resolved)) return { ok: false, reason: 'inside_custody' };

  let st = null;
  try {
    st = fs.statSync(resolved);
  } catch (err) {
    const code = (err && err.code) || 'ERR';
    return { ok: false, reason: code === 'ENOENT' ? 'not_found' : 'stat_failed:' + code };
  }
  if (!st.isFile()) return { ok: false, reason: 'not_a_file' };
  if (st.size > MAX_FILE_BYTES) {
    // 大文件不进保管库：不静默跳过、不尝试读进内存（这里连 sha1 都不算，直接报原因）
    return { ok: false, reason: 'too_large', bytes: st.size, limit: MAX_FILE_BYTES };
  }

  let hashed = null;
  try {
    hashed = sha1OfFile(resolved);
  } catch (err) {
    return { ok: false, reason: 'hash_failed:' + ((err && err.code) || 'ERR') };
  }
  const sha1 = hashed.sha1;
  const bytes = hashed.bytes; // 用真实读到的字节数，不信 statSync

  const storePath = storePathFor(sha1, resolved);
  const storeDir = path.dirname(storePath);
  try {
    fs.mkdirSync(storeDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'mkdir_failed:' + ((err && err.code) || 'ERR') };
  }

  // ── 内容寻址 ⇒ 已有同名目录就是同一内容。仍做一次廉价的 size 校验修损坏。
  let deduped = false;
  let existed = false;
  try {
    existed = fs.existsSync(storePath);
  } catch (err) {
    existed = false;
  }
  if (existed) {
    let sizeOk = false;
    try {
      sizeOk = fs.statSync(storePath).size === bytes;
    } catch (err) {
      sizeOk = false;
    }
    if (!sizeOk) {
      const fixed = writeStoreCopy(resolved, storePath);
      if (!fixed.ok) return { ok: false, reason: 'store_write_failed:' + fixed.reason };
      deduped = false;
    } else {
      deduped = true;
    }
  } else {
    const wrote = writeStoreCopy(resolved, storePath);
    if (!wrote.ok) return { ok: false, reason: 'store_write_failed:' + wrote.reason };
    deduped = false;
  }

  // ── 索引
  const key = normalizeKey(resolved);
  const at = nowIso();
  // ★ 用 `readIndexState().idx`：索引坏掉时它已经从事件重建过（而不是空 `{}`），
  //   所以接下来的 keep 不会把"重建出来的基线"覆盖成一条孤零零的新记录。
  const idx = readIndexState().idx;
  const prev = (idx[key] && typeof idx[key] === 'object') ? idx[key] : null;
  const prevRevisions = (prev && Array.isArray(prev.revisions)) ? prev.revisions : [];
  const revisions = prevRevisions.slice();
  const lastRev = revisions.length ? revisions[revisions.length - 1] : null;
  const lastRevSha1 = lastRev && typeof lastRev.sha1 === 'string' ? lastRev.sha1 : '';
  if (lastRevSha1 !== sha1) {
    revisions.push({ sha1, bytes, at });
  }
  const trimmed = revisions.slice(-MAX_REVISIONS);

  idx[key] = {
    sha1,
    bytes,
    firstAt: prev && typeof prev.firstAt === 'string' && prev.firstAt ? prev.firstAt : at,
    firstSha1: prev && typeof prev.firstSha1 === 'string' && prev.firstSha1 ? prev.firstSha1 : sha1,
    lastSha1: sha1,
    lastAt: at,
    revisions: trimmed,
  };
  const indexed = writeIndex(idx);
  if (!indexed) return { ok: false, reason: 'index_write_failed' };

  appendEvent({
    at,
    kind: deduped ? KIND_KEPT_DEDUP : KIND_KEPT,
    path: key,
    sha1,
    bytes,
    storePath: normalizeKey(storePath),
    deduped,
    ctx: safeCtx(ctx),
  });

  return { ok: true, sha1, bytes, storePath, deduped };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * check —— 拍一次当前状态，跟基线比
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 拍一次当前状态（**不改变保管物**，也不改变基线），回答"现在跟入库时比有没有变"。
 *
 * @param {string} filePath
 * @return {{ok:true, sha1:string, bytes:number, changed:boolean, missing:boolean,
 *           firstSha1:string, firstAt:string, baselineSha1:string}
 *         | {ok:false, reason:string}}
 */
function check(filePath) {
  const notReady = requireInit();
  if (notReady) return notReady;

  const resolved = safeResolve(filePath);
  if (!resolved) return { ok: false, reason: 'bad_path' };

  const key = normalizeKey(resolved);
  const ix = readIndexState();
  const idx = ix.idx;
  const entry = (idx[key] && typeof idx[key] === 'object') ? idx[key] : null;
  if (!entry || typeof entry.sha1 !== 'string' || !entry.sha1) {
    /**
     * ★ 没有条目时，**不许**一律说 `not_kept`。
     *   索引不可全信（刚坏过 / 历史上坏过）⇒ 我们不知道它是不是从来没管过 ⇒
     *   说 `index_corrupt`。"不知道"比一个方向明确的假答案安全：
     *   `not_kept` 会让调用方认为"这文件不需要管"，而 `index_corrupt` 会让它去修索引。
     */
    if (indexSuspect(ix)) return { ok: false, reason: 'index_corrupt', detail: ix.detail, backup: ix.backup };
    return { ok: false, reason: 'not_kept' };
  }

  const firstSha1 = typeof entry.firstSha1 === 'string' && entry.firstSha1 ? entry.firstSha1 : entry.sha1;
  const firstAt = typeof entry.firstAt === 'string' ? entry.firstAt : '';
  const baseBytes = Number(entry.bytes) > 0 ? Number(entry.bytes) : 0;

  // ── 原路径不见了：保管物的价值就在这一刻兑现
  let st = null;
  let statCode = '';
  try {
    st = fs.statSync(resolved);
  } catch (err) {
    statCode = (err && err.code) || 'ERR';
  }
  if (!st) {
    if (statCode === 'ENOENT') {
      const at = nowIso();
      appendEvent({ at, kind: KIND_MISSING, path: key, sha1: entry.sha1, bytes: baseBytes });
      idx[key] = Object.assign({}, entry, { lastSha1: '', lastAt: at, lastMissingAt: at, lastBytes: 0 });
      writeIndex(idx);
      return {
        ok: true,
        sha1: entry.sha1,
        bytes: baseBytes,
        changed: true,
        missing: true,
        firstSha1,
        firstAt,
        baselineSha1: entry.sha1,
      };
    }
    return { ok: false, reason: 'stat_failed:' + statCode };
  }
  if (!st.isFile()) return { ok: false, reason: 'not_a_file' };
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: 'too_large', bytes: st.size, limit: MAX_FILE_BYTES };

  let cur = null;
  try {
    cur = sha1OfFile(resolved);
  } catch (err) {
    return { ok: false, reason: 'hash_failed:' + ((err && err.code) || 'ERR') };
  }

  // ★ 唯一的"变没变"判据：内容 sha1 比对。
  //   （门禁的变异臂 M1 就是把这行改成 `false`，对应反向判据必须转红。）
  const changed = cur.sha1 !== entry.sha1;

  if (changed) {
    const at = nowIso();
    appendEvent({
      at,
      kind: KIND_CHANGED,
      path: key,
      fromSha1: entry.sha1,
      toSha1: cur.sha1,
      fromBytes: baseBytes,
      toBytes: cur.bytes,
    });
    // 只更新"追踪字段"，**不动基线** —— 基线只能由 keep() 提升。
    // 否则一次 check 就会把篡改后的内容洗成合法基线。
    idx[key] = Object.assign({}, entry, { lastSha1: cur.sha1, lastAt: at, lastBytes: cur.bytes });
    writeIndex(idx);
  }

  return {
    ok: true,
    sha1: cur.sha1,
    bytes: cur.bytes,
    changed,
    missing: false,
    firstSha1,
    firstAt,
    baselineSha1: entry.sha1,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * audit —— 批量核验，三态分开
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 审计一批产物。三态**严格分开**：
 *   · `tampered`   —— 内容变了（当前 sha1 ≠ 基线 sha1）
 *   · `missing`    —— **保管过、现在原路径没了**（真事故，要人处理）
 *   · `unverified` —— **无法核验**：路径非法 / 权限不足 / 单文件超 200MB /
 *                     该路径**从未保管过**（`reason:'never_kept'`）/ 已保管但路径存在且
 *                     从未 keep 过的存在文件（`reason:'not_kept'`）/ 保管副本本身丢了
 *
 * ⚠️ `missing` 只放 `kept === true`：「**保管过、现在不见了**」（报警）与
 *   「**从来没让我管过**」（无从核验）是两件事。折在一起，审计报告就会出现
 *   「missing 1 个」而实际一个原件都没丢 —— 那个数字就不可判读了。
 *   具体分流：
 *     · ENOENT + 有索引条目  ⇒ `missing`（status:'missing', kept:true）
 *     · ENOENT + 无索引条目  ⇒ `unverified / never_kept`（kept:false）
 *     · 存在 + 无索引条目    ⇒ `unverified / not_kept`（kept:false）
 *     · **索引不可全信时**（本次坏 / 历史上坏过，凭证仍在）：
 *       上面两种"无索引条目"一律改记 `index_corrupt`，**不许**说 never_kept / not_kept。
 *       因为"管过没有"这个断言只能由索引给出，而索引是我们刚刚证明不可信的那个东西。
 *
 * `unverified` 既不许折进 `tampered`（那是冤枉），也不许折进"正常"（那是瞒报）。
 *
 * `index` 单独报索引健康度（`corrupt` / `repaired` / `backup` / `rebuiltEntries`），
 * 不许只体现在 `unverified.reason` 里 —— 那样调用方看到 "unverified 3" 无从判断该修什么。
 *
 * `counts` 是给调用方的省事读数（不必自己数三数组长度）：
 *   `{ total, ok, tampered, missing, unverified }`，其中
 *   `ok + tampered.length + missing.length + unverified.length === total` 恒成立。
 *
 * 本函数**不写事件**（`check` 才是"发现即落事件"的入口）：审计是只读动作，
 * 同一个被篡改文件被 audit 十次不该产生十条重复事件。需要留痕就调 `check`。
 * ⚠️ 唯一的例外：索引损坏时 `recoverIndex()` 会落一条 `index-corrupt` 事件 ——
 *   那是"库自己的事故"，只发生一次（因为修完索引就健康了），不属于审计的重复留痕。
 *
 * @param {string[]} paths
 * @return {{ok:true, items:object[], tampered:object[], missing:object[],
 *           unverified:object[], index:object, counts:object}}
 */
function audit(paths) {
  const notReady = requireInit();
  if (notReady) {
    return {
      ok: false,
      reason: notReady.reason,
      items: [],
      tampered: [],
      missing: [],
      unverified: [],
      index: {
        corrupt: false, corruptNow: false, origin: '', suspect: false, repaired: false,
        confirmed: false, reason: '', detail: '', backup: '', rebuiltEntries: 0,
        eventsReadable: false, markerAt: '', orphanCount: 0, orphanPendingCount: 0,
        orphanGraceMs: 0, storeObjects: 0,
        storeReadable: false, storeTruncated: false,
        historyLines: 0, historyBadLines: 0, historyAllBad: false,
        lastCorruptAt: '', lastConfirmAt: '', lastConfirmBy: '',
      },
      counts: { total: 0, ok: 0, tampered: 0, missing: 0, unverified: 0 },
    };
  }

  const list = Array.isArray(paths) ? paths : [];
  const items = [];
  const tampered = [];
  const missing = [];
  const unverified = [];
  /* ★ `scanStore:true`：只有 `audit()` 做孤儿对象扫描。
   *   理由见 `readIndexStateCore()` 的注释 —— 它要遍历整个内容寻址目录，
   *   代价随对象数线性增长，而孤儿是**全局**事实，不属于任何单次 `check`。 */
  const ix = readIndexState({ scanStore: true });
  const idx = ix.idx;
  /**
   * ★★ 索引不可全信（刚坏 / 历史上坏过）时，**没有条目的路径不许说 `never_kept`**。
   *
   * 为什么：`never_kept` 是一句断言 —— "这些文件从来没让我管过"。索引正是唯一
   * 记录"管过没有"的东西。它坏过一次之后，从事件重建**通常**能恢复，但如果
   * `_events.jsonl` 也一起坏了/被清了呢？那时重建结果就是空表，
   * 而报告会显示"全部 never_kept" —— 一个故障被完整地伪装成一种正常状态。
   *
   * ⇒ 只要凭证还在，没有条目一律记 `index_corrupt`：
   *   "我不知道这是没管过还是元数据丢了" —— 这个答案不会骗人，且它指的方向是
   *   "去修索引"，而 `never_kept` 指的方向是"什么都不用做"。
   *
   * 凭证的清除方式只有一个：人工确认后删掉 `_index.repair.json`。没有任何代码会自动删。
   */
  const suspect = indexSuspect(ix);
  /**
   * ★ 第三档：`index_pending`（本版新增）。
   *
   * `ix.ok === true`（索引本身可信）但内容寻址目录里有**宽限期内的待定孤儿**时，
   * 对"没有索引条目"的路径说 `never_kept` 仍然是**撒谎**：字节就在目录里躺着。
   * 只是这个谎比 `index_corrupt` 轻 —— 它大概率是"另一个进程正在 keep"。
   *
   * 三档故意分开，因为它们指的方向不同：
   *   index_corrupt ⇒ 去修索引 / 去确认修复（真故障）
   *   index_pending ⇒ 等一会儿再看（正常中间态）—— **不报错，但不说"没管过"**
   *   never_kept    ⇒ 什么都不用做（真的没有）
   * 压成两档的话，中间态要么变成误报（告警变噪声），要么变成谎言（故障被报成正常）。
   * ⚠️ 它**不**影响 `index.corrupt`（那是 `ok === false` 的事）——
   *   团队裁决：pending 不导致告警，但必须可见。
   */
  const pendingCount = Number(ix.orphanPendingCount) || 0;
  const absentReason = suspect ? 'index_corrupt' : (pendingCount > 0 ? 'index_pending' : 'never_kept');
  const absentReasonExists = suspect ? 'index_corrupt' : (pendingCount > 0 ? 'index_pending' : 'not_kept');

  for (let i = 0; i < list.length; i += 1) {
    const rawIn = list[i];
    const resolved = safeResolve(rawIn);
    if (!resolved) {
      const it = { path: String(rawIn === undefined ? '' : rawIn), status: 'unverified', reason: 'bad_path' };
      items.push(it);
      unverified.push(it);
      continue; // eslint-disable-line no-continue
    }
    const key = normalizeKey(resolved);
    const entry = (idx[key] && typeof idx[key] === 'object') ? idx[key] : null;
    const firstSha1 = entry && typeof entry.firstSha1 === 'string' && entry.firstSha1
      ? entry.firstSha1
      : (entry && typeof entry.sha1 === 'string' ? entry.sha1 : '');
    const firstAt = entry && typeof entry.firstAt === 'string' ? entry.firstAt : '';

    let st = null;
    let statCode = '';
    try {
      st = fs.statSync(resolved);
    } catch (err) {
      statCode = (err && err.code) || 'ERR';
    }

    if (!st) {
      if (statCode === 'ENOENT') {
        /**
         * ★ 这里必须分成两件事，不许折进同一个 `missing` 数字：
         *
         *   `missing`     = **保管过、现在不见了** ⇒ 真事故，要人处理。
         *   `never_kept`  = **从来没让我管过** ⇒ 无从核验，进 `unverified`。
         *
         * 折叠的后果：一个"从未保管过的路径"就能让审计报告出现「missing 1 个」，
         * 而实际上**一个原件都没丢**。这跟"一次工具执行失败 ≠ 某个根因假设已被证伪"
         * 是同一类错误 —— 同一个字段不许承担两种语义。
         */
        if (!entry) {
          const it = {
            path: key,
            status: 'unverified',
            reason: absentReason,
            kept: false,
            sha1: '',
            bytes: 0,
            firstSha1: '',
            firstAt: '',
          };
          items.push(it);
          // ★ never_kept / index_corrupt：无从核验 ⇒ 进 unverified 栏（**不许**进 missing —— 见门禁 M3 变异臂）
          unverified.push(it);
          continue; // eslint-disable-line no-continue
        }
        const it = {
          path: key,
          status: 'missing',
          kept: true,
          sha1: entry.sha1,
          bytes: Number(entry.bytes) || 0,
          firstSha1,
          firstAt,
        };
        items.push(it);
        missing.push(it);
      } else {
        const it = {
          path: key,
          status: 'unverified',
          reason: 'stat_failed:' + statCode,
          kept: !!entry,
          firstSha1,
          firstAt,
        };
        items.push(it);
        unverified.push(it);
      }
      continue; // eslint-disable-line no-continue
    }

    if (!st.isFile()) {
      const it = { path: key, status: 'unverified', reason: 'not_a_file', kept: !!entry, firstSha1, firstAt };
      items.push(it);
      unverified.push(it);
      continue; // eslint-disable-line no-continue
    }

    if (st.size > MAX_FILE_BYTES) {
      const it = {
        path: key,
        status: 'unverified',
        reason: 'too_large',
        bytes: st.size,
        limit: MAX_FILE_BYTES,
        kept: !!entry,
        firstSha1,
        firstAt,
      };
      items.push(it);
      unverified.push(it);
      continue; // eslint-disable-line no-continue
    }

    let cur = null;
    try {
      cur = sha1OfFile(resolved);
    } catch (err) {
      const it = {
        path: key,
        status: 'unverified',
        reason: 'io_error:' + ((err && err.code) || 'ERR'),
        kept: !!entry,
        firstSha1,
        firstAt,
      };
      items.push(it);
      unverified.push(it);
      continue; // eslint-disable-line no-continue
    }

    if (!entry) {
      // 从未保管过 ⇒ 没有基线可核验。不能算"正常"（那等于假装核验过）。
      const it = {
        path: key,
        status: 'unverified',
        reason: absentReasonExists,
        kept: false,
        sha1: cur.sha1,
        bytes: cur.bytes,
        firstSha1: '',
        firstAt: '',
      };
      items.push(it);
      unverified.push(it);
      continue; // eslint-disable-line no-continue
    }

    // 保管副本本身还在不在（副本丢了 ⇒ 无法核验，也不算篡改）
    const storePath = storePathFor(entry.sha1, resolved);
    let storeExists = false;
    try {
      storeExists = fs.existsSync(storePath);
    } catch (err) {
      storeExists = false;
    }
    if (!storeExists) {
      const it = {
        path: key,
        status: 'unverified',
        reason: 'custody_copy_missing',
        sha1: cur.sha1,
        bytes: cur.bytes,
        baselineSha1: entry.sha1,
        firstSha1,
        firstAt,
      };
      items.push(it);
      unverified.push(it);
      continue; // eslint-disable-line no-continue
    }

    const same = cur.sha1 === entry.sha1;
    if (same) {
      const it = {
        path: key,
        status: 'ok',
        sha1: cur.sha1,
        bytes: cur.bytes,
        baselineSha1: entry.sha1,
        firstSha1,
        firstAt,
      };
      items.push(it);
    } else {
      const it = {
        path: key,
        status: 'tampered',
        sha1: cur.sha1,
        bytes: cur.bytes,
        baselineSha1: entry.sha1,
        fromSha1: entry.sha1,
        toSha1: cur.sha1,
        fromBytes: Number(entry.bytes) || 0,
        toBytes: cur.bytes,
        firstSha1,
        firstAt,
      };
      items.push(it);
      tampered.push(it);
    }
  }

  return {
    ok: true,
    items,
    tampered,
    missing,
    unverified,
    /**
     * ★ 索引自身的健康度**必须单独报出来**，不许只体现在 `unverified` 的 reason 里。
     *   理由：`unverified` 是个混合桶（路径非法 / 太大 / 没保管过 / 索引坏了），
     *   调用方看到 "unverified 3" 无法判断该修什么。索引是这套机制唯一的元数据，
     *   它坏没坏是一件需要被一眼看见的事。
     *   `repaired:true` ⇒ 历史上坏过、现在是从事件重建的（凭证仍在，见 INDEX_REPAIR_NAME）。
     */
    index: {
      /* `corrupt` = **这份元数据此刻可不可信**（本次坏 或 历史坏过没确认）。
       * 不要再拿它当"JSON 文件能不能 parse"读 —— 那是 `corruptNow`。 */
      corrupt: ix.ok === false,
      /**
       * `corruptNow` = 这次的 `_index.json` 文件本身坏了。
       * 与 `corrupt` 分开报，是因为**两个语义的处置不同**：
       *   corruptNow:true  ⇒ 去看 `_index.json.corrupt-<ts>` 留证、看重建救回了几条；
       *   corrupt:true + corruptNow:false ⇒ 文件是好的，但历史上有一次损坏没人
       *                                     `confirmRepair(by, note)` 认过。
       * 把它们压成一个值，就等于"两个语义合并"——那正是本模块要治的第二种病。
       */
      corruptNow: ix.origin === 'file_bad',
      origin: ix.origin || '',
      suspect,
      repaired: ix.repaired === true,
      confirmed: ix.confirmed === true,
      reason: ix.ok === false ? ix.reason : (ix.confirmed === true ? 'index_repair_confirmed' : ''),
      detail: ix.detail || '',
      backup: ix.backup || '',
      rebuiltEntries: Number(ix.rebuiltEntries) || 0,
      eventsReadable: ix.eventsReadable === true,
      markerAt: ix.marker && ix.marker.at ? ix.marker.at : '',
      /**
       * 历史凭证（append-only 事件流）里的原貌。**删文件删不掉它**，这就是它存在的理由。
       * `historyReadable:false` 本身也是一种事实：事件流没了 ⇒ 上面的 `repaired`
       * 只能来自辅助凭证，可信度更低。不许把它读成"没坏过"。
       */
      historyReadable: ix.history ? ix.history.readable === true : false,
      /* ⚠️ `historyUnconfirmed` 报的是**生效的**判定（含 historyIncomplete），
       * 不是裸的 `hist.unconfirmed`。第一次写这里时报的是裸值，于是
       * "事件流被截断 ⇒ 记录丢了 ⇒ 看起来已确认"这个漏斗在读数上是隐形的。 */
      historyUnconfirmed: ix.ok === false && ix.origin === 'history_unconfirmed',
      historyIncomplete: ix.historyIncomplete === true,
      /* ★ "读了 N 行、行行都是垃圾"必须单独可见。它与 `historyReadable:false`
       * 是两件事：一个是"文件打不开"，一个是"打开了、读到了、但没有一行能用"。
       * 压成一个值就是"两个语义合并"。
       * ⚠️ `historyLines` 必须和 `historyBadLines` 一起报：只报坏行数的话，
       *   "读了 5 行、5 行全坏"和"读了 5 行、1 行坏"在读数上要靠心算才能分开，
       *   而"全坏"与"部分坏"是两个完全相反的结论（前者凭证已废，后者是正常形态）。 */
      historyLines: Number(ix.historyLines) || 0,
      historyBadLines: Number(ix.historyBadLines) || 0,
      historyAllBad: ix.historyAllBad === true,
      /**
       * ★★ 孤儿对象（本版新增的不变量）：内容寻址目录里有、却没有任何凭证认领的对象数。
       *   `orphanCount > 0` ⇒ `corrupt:true` 且 `origin:'orphan_objects'`（除非已被更具体的
       *   原因占用 —— 那时这个数字仍然照报，信息不丢）。
       *   `storeTruncated:true` ⇒ 对象数超过扫描上限，`orphanCount` 只是**下界**。
       *   `storeReadable:false` ⇒ 目录都读不了，这个 0 **不是**"没有孤儿"，是"没看到"。
       *
       * ★ `orphanPendingCount` = 宽限期内的"待定孤儿"（可能另一个进程正在 keep）。
       *   **它不导致 `corrupt`**，但**必须照报** —— 静默略过就等于"它没发生过"。
       *   `orphanGraceMs` 一并报出，让读的人知道"多近算待定"，不用去翻源码里的常量。
       */
      orphanCount: Number(ix.orphanCount) || 0,
      orphanPendingCount: Number(ix.orphanPendingCount) || 0,
      orphanGraceMs: Number(ix.orphanGraceMs) || 0,
      storeObjects: Number(ix.storeObjects) || 0,
      storeReadable: ix.storeReadable === true,
      storeTruncated: ix.storeTruncated === true,
      lastCorruptAt: ix.history && ix.history.lastCorruptAt ? ix.history.lastCorruptAt : '',
      lastConfirmAt: ix.history && ix.history.lastConfirmAt ? ix.history.lastConfirmAt : '',
      lastConfirmBy: ix.history && ix.history.lastConfirmBy ? ix.history.lastConfirmBy : '',
    },
    counts: {
      total: items.length,
      ok: items.length - tampered.length - missing.length - unverified.length,
      tampered: tampered.length,
      missing: missing.length,
      unverified: unverified.length,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * restore —— "原件永久可用"的兑现
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── 版本定位：库内已有凭证（索引 ∪ 事件流），**只认本路径的** ──────────────
 *
 * 为什么候选集要同时取索引和事件流（2026-10-24）：
 *   · 索引的 `revisions` 有 `MAX_REVISIONS = 20` 上限，会被裁剪，**磁盘副本永不删除**；
 *     只按索引找 ⇒ 第 21 版之前的版本"库里明明有、却恢复不了"，而那恰恰是最需要恢复的
 *     "很久以前那一版"；
 *   · 事件流是 append-only 的主凭证（见文件头第 129 行），更接近真相。
 * 这与 `orphanInfo()` 的"认领"判定用的是同一套来源，语义一致：**说得清它是什么，
 * 就允许取回；说不清就拒绝。**
 *
 * ⚠️ 反过来的边界：只按 sha1 在**全库**找是**错的**。那样"把 A 文件的第 3 版写进 B 文件"
 *   会看起来完全合法（内容寻址目录里确实有这个对象，sha1 也真的对得上）。
 *   恢复的对象必须是"**这个路径**曾经有过的那一版"，所以 path 必须逐字匹配。
 *
 * @param {string} key `normalizeKey()` 后的绝对路径
 * @param {object|null} entry 索引里该路径的条目
 * @return {Map<string, {sha1:string, bytes:number, at:string, inIndex:boolean, inEvents:boolean}>}
 */
function knownVersionsFor(key, entry) {
  const out = new Map();
  const HEX40 = new RegExp('^[0-9a-f]{40}$');
  const add = (sha1, bytes, at, where) => {
    const s = typeof sha1 === 'string' ? sha1.trim().toLowerCase() : '';
    if (!HEX40.test(s)) return;
    const hit = out.get(s);
    if (hit) {
      if (where === 'index') hit.inIndex = true; else hit.inEvents = true;
      if (!hit.bytes && Number(bytes) > 0) hit.bytes = Number(bytes);
      if (!hit.at && at) hit.at = String(at);
      return;
    }
    out.set(s, {
      sha1: s,
      bytes: Number(bytes) > 0 ? Number(bytes) : 0,
      at: at ? String(at) : '',
      inIndex: where === 'index',
      inEvents: where === 'events',
    });
  };
  if (entry) {
    add(entry.sha1, entry.bytes, entry.lastAt, 'index');
    add(entry.lastSha1, 0, entry.lastAt, 'index');
    add(entry.firstSha1, 0, entry.firstAt, 'index');
    const revs = Array.isArray(entry.revisions) ? entry.revisions : [];
    for (const r of revs) {
      if (r && typeof r === 'object') add(r.sha1, r.bytes, r.at, 'index');
    }
  }
  let evs = [];
  try { evs = events(); } catch (err) { evs = []; }
  for (const ev of evs) {
    if (!ev) continue; // eslint-disable-line no-continue
    if (ev.kind !== KIND_KEPT && ev.kind !== KIND_KEPT_DEDUP && ev.kind !== KIND_RESTORE_GUARD) continue; // eslint-disable-line no-continue
    if (String(ev.path || '') !== key) continue; // eslint-disable-line no-continue
    add(ev.sha1, ev.bytes, ev.at, 'events');
  }
  return out;
}

/**
 * 列出某个路径**可被精确恢复**的历史版本（只读，不动任何文件）。
 *
 * 存在的理由：`restore(path, { sha1 })` 要求调用方给出一个 sha1，而"给出哪个"不该靠
 * 调用方自己去读 `events()` 拼 —— 那会把"哪些版本算数"的判定散到模块外面，
 * 两处实现迟早不一致（本仓最贵的病之一）。这里是那份判定的**唯一**出口。
 *
 * `available` = 内容寻址目录里是否真有这个对象（廉价的 existsSync，**不**校验哈希：
 * 逐个流式哈希 20 个 200MB 的副本会把这个只读查询变成重活；哈希校验由 `restore` 自己做）。
 *
 * @param {string} filePath
 * @return {{ok:true, path:string, baselineSha1:string, versions:Array<object>}
 *         | {ok:false, reason:string}}
 */
function versions(filePath) {
  const notReady = requireInit();
  if (notReady) return notReady;
  const resolved = safeResolve(filePath);
  if (!resolved) return { ok: false, reason: 'bad_path' };

  const key = normalizeKey(resolved);
  const ix = readIndexState();
  const entry = (ix.idx[key] && typeof ix.idx[key] === 'object') ? ix.idx[key] : null;
  const baseline = entry && typeof entry.sha1 === 'string' ? entry.sha1 : '';
  if (!baseline) {
    if (indexSuspect(ix)) return { ok: false, reason: 'index_corrupt', detail: ix.detail, backup: ix.backup };
    return { ok: false, reason: 'not_kept' };
  }

  const known = knownVersionsFor(key, entry);
  const list = [];
  for (const rec of known.values()) {
    let available = false;
    try { available = fs.existsSync(storePathFor(rec.sha1, resolved)); } catch (err) { available = false; }
    list.push({
      sha1: rec.sha1,
      bytes: rec.bytes,
      at: rec.at,
      inIndex: rec.inIndex,
      inEvents: rec.inEvents,
      isBaseline: rec.sha1 === baseline,
      available,
    });
  }
  // 基线排最前，其余按时间倒序（最近的在前）；时间缺失的排最后 —— 排序只为好读，不参与判定。
  list.sort((a, b) => {
    if (a.isBaseline !== b.isBaseline) return a.isBaseline ? -1 : 1;
    const ta = Date.parse(a.at) || 0;
    const tb = Date.parse(b.at) || 0;
    if (ta !== tb) return tb - ta;
    return a.sha1.localeCompare(b.sha1);
  });
  return { ok: true, path: key, baselineSha1: baseline, versions: list };
}

/**
 * 安全写入：`copyFileSync` 到同目录临时文件 → **校验临时文件的 sha1** → 原子 `rename`。
 *
 * 为什么要先校验临时文件：只校验来源（保管副本）是不够的 —— 复制途中被截断、磁盘满、
 * 杀毒软件改字节，都能让"源是对的、落地的是坏的"。校验点必须放在**即将顶替目标的那份
 * 字节**上，而不是它上游。
 *
 * ⚠️ 旧实现里 `rename` 失败后会退化成 `writeFileSync(resolved, readFileSync(storePath))`
 *   —— 那条路**先截断目标再写**，中途失败就把用户文件变成半截垃圾。已删除，理由：
 *   `rename` 失败意味着"目标被占用/无权限"，此时目标**本来就是原样未动**的，
 *   而这正是我们想要的结局；用一次原地重写去换"看起来成功了"，换到的是真正的数据损失。
 *   （见 `restore` 里 `write_failed` 分支：目标未动是**可断言**的读数，不是安慰。）
 *
 * @param {string} srcPath 源（保管副本，只读 0444）
 * @param {string} dstPath 目标（原路径）
 * @param {string} expectedSha1 落地字节必须等于它
 * @return {{ok:true} | {ok:false, reason:string, actual?:string}}
 */
function writeAtomic(srcPath, dstPath, expectedSha1) {
  let tmp = '';
  try {
    try {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    } catch (err) {
      const code = (err && err.code) || 'ERR';
      if (code !== 'EEXIST') return { ok: false, reason: 'mkdir:' + code };
    }
    // 目标可能是只读（保管副本本身 0444 / 被别的工具设过只读）⇒ 先解只读，否则 Windows 上 rename 覆盖会 EPERM
    try {
      if (fs.existsSync(dstPath)) fs.chmodSync(dstPath, 0o666);
    } catch (err) { /* 尽力：解不掉就让下面的 rename 报真实原因 */ }
    tmp = dstPath + '.restore' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.copyFileSync(srcPath, tmp);
    const h = sha1OfFile(tmp);
    if (h.sha1 !== expectedSha1) {
      try { fs.unlinkSync(tmp); } catch (err2) { /* ignore */ }
      return { ok: false, reason: 'tmp_verify_mismatch', actual: h.sha1 };
    }
    fs.renameSync(tmp, dstPath);
    return { ok: true };
  } catch (err) {
    if (tmp) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err2) { /* ignore */ }
    }
    return { ok: false, reason: (err && err.code) || 'ERR' };
  }
}

/**
 * 恢复前保护：把**当前盘上这一版**收进库（字节副本 + 版本记录 + 事件）。
 *
 * 与 `keep()` 的差别（**故意不合并**）：
 *   · 不动基线 `sha1`/`lastSha1` —— 基线是"check 拿什么当参照"，它由 `restore` 在
 *     写成功后统一前移到目标版本；这里提前改了会让 `check()` 在"恢复失败"的场景下
 *     把基线错指到一个用户刚被覆盖掉的内容上；
 *   · 落 `KIND_RESTORE_GUARD` 而不是 `KIND_KEPT`（语义见常量注释）。
 *
 * 代价（明确接受）：`keep()` 的 `inside_custody` / `too_large` / `not_a_file` 判据
 * 这里要重新判一遍 —— 因为走的是不同的事件 kind，不能直接复用 `keep()` 的返回值。
 *
 * @param {string} resolved
 * @param {string} key
 * @param {{sha1:string, bytes:number}} cur 恢复前的当前内容（已算好，不重复哈希）
 * @return {{ok:boolean, applied?:boolean, sha1?:string, bytes?:number, deduped?:boolean, reason?:string}}
 */
function guardCurrentVersion(resolved, key, cur) {
  if (insideCustody(resolved)) return { ok: false, reason: 'inside_custody' };
  if (cur.bytes > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };

  const storePath = storePathFor(cur.sha1, resolved);
  let existed = false;
  try { existed = fs.existsSync(storePath); } catch (err) { existed = false; }
  let deduped = true;
  if (existed) {
    let sizeOk = false;
    try { sizeOk = fs.statSync(storePath).size === cur.bytes; } catch (err) { sizeOk = false; }
    if (!sizeOk) {
      const fixed = writeStoreCopy(resolved, storePath);
      if (!fixed.ok) return { ok: false, reason: 'store_write_failed:' + fixed.reason };
      deduped = false;
    }
  } else {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
    } catch (err) {
      return { ok: false, reason: 'mkdir_failed:' + ((err && err.code) || 'ERR') };
    }
    const wrote = writeStoreCopy(resolved, storePath);
    if (!wrote.ok) return { ok: false, reason: 'store_write_failed:' + wrote.reason };
    deduped = false;
  }

  const at = nowIso();
  // 版本必须进索引 revisions，否则"恢复完之后想把刚才那一版找回来"会查不到
  // （索引上限 20 条，但事件流兜底 —— 见 `knownVersionsFor`）。
  try {
    const ix2 = readIndexState();
    const e2 = (ix2.idx[key] && typeof ix2.idx[key] === 'object') ? ix2.idx[key] : null;
    if (e2) {
      const revs = Array.isArray(e2.revisions) ? e2.revisions.slice() : [];
      const lastRev = revs.length ? revs[revs.length - 1] : null;
      if (!lastRev || lastRev.sha1 !== cur.sha1) revs.push({ sha1: cur.sha1, bytes: cur.bytes, at });
      ix2.idx[key] = Object.assign({}, e2, { revisions: revs.slice(-MAX_REVISIONS) });
      writeIndex(ix2.idx);
    }
  } catch (err) { /* 索引写失败不影响"字节副本已经在库里"这个事实，事件仍会落 */ }

  appendEvent({
    at,
    kind: KIND_RESTORE_GUARD,
    path: key,
    sha1: cur.sha1,
    bytes: cur.bytes,
    storePath: normalizeKey(storePath),
    deduped,
    ctx: { by: 'restore-guard' },
  });
  return { ok: true, applied: true, sha1: cur.sha1, bytes: cur.bytes, deduped };
}

/** 恢复失败留痕。字段与 `KIND_RESTORED` 对齐（`sha1` = 想恢复到的版本），便于同一套查询复用。 */
function appendRestoreFailed(o) {
  const at = nowIso();
  appendEvent({
    at,
    kind: KIND_RESTORE_FAILED,
    path: o.key,
    sha1: o.target || '',
    fromSha1: o.from || '',
    reason: o.reason,
    explicit: o.explicit === true,
    extra: safeCtx(o.extra),
  });
}

/**
 * 恢复失败后，当前文件是否还等于"恢复前那一版"。
 * `null` = 恢复前本来就没有文件；`false` = 被动过了（这时必须报警，不许说"没事"）。
 * @param {string} resolved
 * @param {{sha1:string}|null} cur
 * @return {boolean|null}
 */
function currentIntactState(resolved, cur) {
  if (!cur) {
    try { return !fs.existsSync(resolved); } catch (err) { return null; }
  }
  try {
    return sha1OfFile(resolved).sha1 === cur.sha1;
  } catch (err) {
    return false;
  }
}

/**
 * 把某个路径的**基线**前移到指定版本（只改 `_index.json`，不碰磁盘上的产物）。
 *
 * 抽成函数只有一个理由：**同一段语义写两遍就会有两个版本**。这里有两个调用点
 * （真写盘成功后、以及"文件已经等于目标版本但基线还没指过去"的 noop 分支），
 * 两处必须**逐字一致**，否则"恢复成功"与"check 说变了"迟早对不上。
 *
 * @param {string} key
 * @param {object|null} entry 调用方读到的条目（索引又变过时以新读到的为准）
 * @param {string} target 目标 sha1
 * @param {number} bytes 目标字节数（0 ⇒ 沿用原条目的）
 * @return {boolean} 索引是否写成功
 */
function moveBaseline(key, entry, target, bytes) {
  try {
    const ix = readIndexState();
    const e2 = (ix.idx[key] && typeof ix.idx[key] === 'object') ? ix.idx[key] : entry;
    if (!e2) return false;
    const at = nowIso();
    const revs = Array.isArray(e2.revisions) ? e2.revisions.slice() : [];
    const lastRev = revs.length ? revs[revs.length - 1] : null;
    if (!lastRev || lastRev.sha1 !== target) revs.push({ sha1: target, bytes: Number(bytes) || 0, at });
    ix.idx[key] = Object.assign({}, e2, {
      sha1: target,
      bytes: Number(bytes) > 0 ? Number(bytes) : (Number(e2.bytes) || 0),
      firstAt: (typeof e2.firstAt === 'string' && e2.firstAt) ? e2.firstAt : at,
      firstSha1: (typeof e2.firstSha1 === 'string' && e2.firstSha1) ? e2.firstSha1 : target,
      lastSha1: target,
      lastAt: at,
      revisions: revs.slice(-MAX_REVISIONS),
    });
    return !!writeIndex(ix.idx);
  } catch (err) {
    return false;
  }
}

/**
 * 恢复后的权限检查（**只测量，不改盘**）。
 *
 * 用在 noop 分支：这次没动过字节，所以也不该动 mode —— 但它到底是"可写"还是
 * "被锁成只读"，恰恰是要求 7 要回答的问题，不能报 `null` 糊过去（`null` 只该表示
 * "不是本次操作的产物"，不该表示"我没看"）。
 *
 * @param {string} resolved
 * @return {{mode:number, modeOk:boolean, modeNote:string}}
 */
function measureWritable(resolved) {
  let mode = 0;
  let hasOwnerWrite = false;
  try {
    mode = fs.statSync(resolved).mode & 0o777;
    hasOwnerWrite = (mode & 0o200) !== 0;
  } catch (err) {
    return { mode: 0, modeOk: false, modeNote: 'stat_' + ((err && err.code) || 'ERR') };
  }
  try {
    fs.accessSync(resolved, fs.constants.W_OK);
    return { mode, modeOk: hasOwnerWrite, modeNote: hasOwnerWrite ? '' : 'owner_write_bit_off' };
  } catch (err) {
    return { mode, modeOk: false, modeNote: 'access_W_denied' };
  }
}

/**
 * 把保管物按字节写回原路径。
 *
 * 写回前**先校验保管副本自身的 sha1**：对不上就返回 `custody_copy_corrupt`，
 * 绝不把坏字节写进用户文件（这是 EPERM 之后真正的第二道防线）。
 *
 * **幂等**：如果原文件当前内容已经等于保管物 ⇒ 不写盘、不落事件，
 * 返回 `{ ok:true, noop:true }`。幂等不是优化，是必需：接线策略是
 * "check 到改动就 restore"，同一份产物在一次 run 里可能被 restore 多次，
 * 若每次都落一条 `artifact-restored`，`_events.jsonl` 会无限膨胀到无法审计。
 *
 * **两种恢复（2026-10-24 扩展）**：
 *   · `restore(path)`             —— 恢复到最近一次基线（`_index.json` 的 `sha1`）。行为与旧版逐字一致。
 *   · `restore(path, { sha1 })`   —— **精确恢复到指定历史版本**。目标必须在
 *     `knownVersionsFor()` 的候选集里（库内已有凭证且属于本路径），
 *     绝不接受调用方给的外部路径作恢复源。
 *   为什么需要第二种（老板原话）：「4 页 PPT 修正成 3 页后，既能保留合法的新版本，
 *   也能在需要时精确恢复原来的 4 页版本。」只有"恢复到最近一次"时，被修正掉的旧版本
 *   虽然字节还在库里，却没有任何办法取出来 —— 承诺是空的。
 *
 * **恢复前保护**：真写盘之前，先把**当前盘上那一版**收进库（`guardCurrentVersion`）。
 *   不做这一步，"恢复"自己就是一次不可逆损失：当前内容可能从没被 `keep` 过
 *   （用户手改的、模型重做的那一版），覆盖掉就再也拿不回来 —— 那正是本项目要防的事故，
 *   只是换成了"我们自己干的"。保护失败 ⇒ **放弃恢复**，不做没有退路的操作。
 *
 * **基线随之前移**：写成功且哈希验证通过后，`_index.json` 的 `sha1` 改成目标版本。
 *   不这么做的话，下一次 `check()` 会把这个**我们自己刚恢复的、合法的**版本报成
 *   `changed`，而"check 到改动就 restore"的接线会立刻把文件再覆盖回去 ——
 *   用户精确恢复了一次，十分钟后它自己变回去了，且两步都各有各的道理。
 *
 * @param {string} filePath
 * @param {{sha1?:string}} [opts] 指定要恢复到的版本（**键不存在** = 恢复到基线；
 *   键存在但值不是 40 位十六进制 ⇒ `bad_sha1`，绝不退化成"恢复基线"）
 * @return {{ok:true, sha1:string, bytes:number, restoredTo:string, verifiedSha1:string,
 *           noop:boolean, fromSha1:string, targetSha1:string, explicit:boolean,
 *           guardSha1:string, mode:number, modeOk:boolean, indexWritten:boolean,
 *           baselineMoved?:boolean, warnings:string[]}
 *         | {ok:false, reason:string}}
 */
function restore(filePath, opts) {
  const notReady = requireInit();
  if (notReady) return notReady;

  const resolved = safeResolve(filePath);
  if (!resolved) return { ok: false, reason: 'bad_path' };

  const opt = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const hasSha1Key = Object.prototype.hasOwnProperty.call(opt, 'sha1');
  const wantRaw = (hasSha1Key && opt.sha1 !== undefined && opt.sha1 !== null)
    ? String(opt.sha1).trim().toLowerCase()
    : '';
  const explicit = hasSha1Key;

  /**
   * ⚠️ 显式给了 `sha1` 但值不合法（空串 / undefined / 不是 40 位十六进制）时**不许**
   *   静默退化成本文的"恢复到基线"。
   *
   *   那是最危险的一种降级：调用方拿不到版本号（查询失败、变量名写错、上游返回 null），
   *   于是这次调用悄悄变成"用基线覆盖当前文件"，而返回值看起来完全正常 ——
   *   **一个故障被报成一次成功**，和本模块头注释里反复出现的那个病同源。
   *   所以只认"**键不存在**"为旧语义；键在但值不合法 ⇒ `bad_sha1`，一个字节都不动。
   */
  if (explicit && !new RegExp('^[0-9a-f]{40}$').test(wantRaw)) {
    appendRestoreFailed({
      key: normalizeKey(resolved), target: wantRaw, from: '', reason: 'bad_sha1', explicit: true,
    });
    return { ok: false, reason: 'bad_sha1', sha1: wantRaw };
  }

  const key = normalizeKey(resolved);
  const ix = readIndexState();
  const idx = ix.idx;
  const entry = (idx[key] && typeof idx[key] === 'object') ? idx[key] : null;
  if (!entry || typeof entry.sha1 !== 'string' || !entry.sha1) {
    // 同 `check`：索引不可全信时，说"不知道"而不是"从来没管过"
    if (indexSuspect(ix)) return { ok: false, reason: 'index_corrupt', detail: ix.detail, backup: ix.backup };
    return { ok: false, reason: 'not_kept' };
  }

  const baseBytes = Number(entry.bytes) || 0;
  const baseline = entry.sha1;

  /* ── ① 目标版本定位（只在库内已有凭证里找）──────────────────────────────── */
  let target = baseline;
  let targetBytes = baseBytes;
  if (explicit && wantRaw !== baseline) {
    const known = knownVersionsFor(key, entry);
    const rec = known.get(wantRaw);
    if (!rec) {
      /* 库里没有"这个路径的这一版"的记录 ⇒ **明确拒绝**，而不是"找不到就当没这回事"。
       * 当前文件一个字节都不动（此时还没走到任何写盘代码），这一点由门禁 V6b 断言。 */
      appendRestoreFailed({
        key, target: wantRaw, from: '', reason: 'version_not_claimed',
        explicit: true, extra: { knownCount: known.size },
      });
      return {
        ok: false, reason: 'version_not_claimed',
        sha1: wantRaw, known: known.size, baselineSha1: baseline,
      };
    }
    target = wantRaw;
    targetBytes = Number(rec.bytes) || 0;
  }

  /* ── ② 当前状态（一次算清：幂等要用，恢复前保护也要用）──────────────────── */
  let curStat = null;
  try {
    curStat = fs.statSync(resolved);
  } catch (err) {
    curStat = null; // 不存在 / 读不了 ⇒ 走"新建"路径
  }
  if (curStat && !curStat.isFile()) {
    appendRestoreFailed({ key, target, from: '', reason: 'not_a_file', explicit });
    return { ok: false, reason: 'not_a_file' };
  }
  let cur = null;
  if (curStat) {
    try {
      cur = sha1OfFile(resolved);
    } catch (err) {
      const code = (err && err.code) || 'ERR';
      appendRestoreFailed({ key, target, from: '', reason: 'hash_failed:' + code, explicit });
      return { ok: false, reason: 'hash_failed:' + code };
    }
  }

  // ── ③ 幂等短路：原文件已经是目标那一版 ⇒ **不写字节**
  //    放在校验保管物之前是**故意的**：文件既然已经正确，就不必为了一次
  //    空操作去 hash 一遍保管副本（大文件上这是实打实的时间）。
  if (cur && cur.sha1 === target) {
    /**
     * ⚠️ 字节不动 ≠ 什么都不用做：**基线可能还没指到它**。
     *   真实场景：用户手工把文件改回旧版，再来要求"恢复到这一版" —— 此时
     *   `cur.sha1 === target` 但 `entry.sha1` 还是别的版本。若就此返回：
     *     · `check()` 会把这个刚刚"恢复成功"的文件报成 `changed`；
     *     · `audit()` 会把它报成 `tampered`。
     *   **一次成功的恢复后面紧跟一条"被篡改"**，自相矛盾，而且方向是让人不再相信审计。
     *
     * ⇒ 基线不同就前移，并落一条 `noop:true` 的事件把它记下来。
     * ⚠️ 基线已经等于目标时**必须**保持"零写盘、零事件"：重复 `restore` 是常态
     *   （接线策略是"check 到改动就 restore"），每条都落事件会把 `_events.jsonl`
     *   撑到无法审计 —— 门禁 R-idem3 / R-idem7 量的就是这一点。
     */
    const resolvedBytes = targetBytes > 0 ? targetBytes : cur.bytes;
    const needAlign = baseline !== target;
    let aligned = false;
    let perm = measureWritable(resolved);
    if (needAlign) {
      aligned = moveBaseline(key, entry, target, resolvedBytes);
      perm = measureWritable(resolved);
      appendEvent({
        at: nowIso(),
        kind: KIND_RESTORED,
        path: key,
        sha1: target,
        bytes: resolvedBytes,
        verifiedSha1: cur.sha1 === target ? target : cur.sha1,
        fromSha1: cur.sha1,
        baselineBefore: baseline,
        explicit,
        guardSha1: '',
        guardDeduped: false,
        noop: true,
        mode: perm.mode.toString(8),
        modeOk: perm.modeOk,
        modeNote: perm.modeNote,
        indexWritten: aligned,
      });
    }
    return {
      ok: true,
      sha1: target,
      bytes: resolvedBytes,
      restoredTo: resolved,
      verifiedSha1: cur.sha1 === target ? target : cur.sha1,
      noop: true,
      fromSha1: cur.sha1,
      targetSha1: target,
      explicit,
      guardSha1: '',
      mode: perm.mode,
      modeOk: perm.modeOk,
      /* 语义（别读错）：`indexWritten:false` + `baselineMoved:false` + `ok:true`
       * = **索引本来就对，无需改动**，不是"写失败"。真写失败会配 `warnings`。 */
      indexWritten: aligned,
      baselineMoved: needAlign,
      warnings: needAlign && !aligned ? ['index_write_failed'] : [],
    };
  }

  /* ── ④ 恢复前保护：先把将被覆盖的那一版收进库（详见 `guardCurrentVersion`）── */
  let guard = { ok: true, applied: false, sha1: '', bytes: 0, deduped: false, reason: '' };
  if (cur) {
    guard = guardCurrentVersion(resolved, key, cur);
    if (!guard.ok) {
      /* 保护不成功 ⇒ **不恢复**。没有退路就不动手 —— 这条顺序是硬要求：
       * 恢复的目的就是"把成果拿回来"，一个自己会弄丢成果的恢复不配叫恢复。 */
      appendRestoreFailed({
        key, target, from: cur.sha1, reason: 'guard_failed:' + guard.reason,
        explicit, extra: { guardReason: guard.reason },
      });
      return {
        ok: false, reason: 'guard_failed:' + guard.reason, sha1: target,
        fromSha1: cur.sha1, currentIntact: true,
      };
    }
  }

  const storePath = storePathFor(target, resolved);
  let storeHashed = null;
  try {
    storeHashed = sha1OfFile(storePath);
  } catch (err) {
    appendRestoreFailed({
      key, target, from: cur ? cur.sha1 : '', reason: 'custody_copy_missing',
      explicit, extra: { guardSha1: guard.sha1 || '' },
    });
    return {
      ok: false, reason: 'custody_copy_missing', sha1: target,
      guardSha1: guard.sha1 || '', currentIntact: currentIntactState(resolved, cur),
    };
  }
  if (storeHashed.sha1 !== target) {
    /* 保管副本自身的 sha1 对不上 ⇒ 立刻停手，一个字节都不写。
     * 这一条是 EPERM 之后的第二道防线（见文件头第 74-78 行）。 */
    appendRestoreFailed({
      key, target, from: cur ? cur.sha1 : '', reason: 'custody_copy_corrupt',
      explicit, extra: { guardSha1: guard.sha1 || '', actual: storeHashed.sha1 },
    });
    return {
      ok: false, reason: 'custody_copy_corrupt', expected: target, actual: storeHashed.sha1,
      guardSha1: guard.sha1 || '', currentIntact: currentIntactState(resolved, cur),
    };
  }
  if (!(targetBytes > 0)) targetBytes = storeHashed.bytes;

  const prevMode = curStat ? (curStat.mode & 0o777) : null;
  const wrote = writeAtomic(storePath, resolved, target);
  if (!wrote.ok) {
    /* 写失败：目标是**原样未动**的（`writeAtomic` 只做"临时文件 + 原子 rename"，
     * 旧实现里那条 `writeFileSync` 原地重写的降级路已删除，理由见 `writeAtomic` 注释）。
     * `currentIntact` 就是这条结论的读数，不让调用方去信一句"应该没事"。 */
    appendRestoreFailed({
      key, target, from: cur ? cur.sha1 : '', reason: 'write_failed:' + wrote.reason,
      explicit, extra: { guardSha1: guard.sha1 || '', prevMode },
    });
    return {
      ok: false, reason: 'write_failed:' + wrote.reason, sha1: target,
      guardSha1: guard.sha1 || '', currentIntact: currentIntactState(resolved, cur),
    };
  }

  /* ── ⑤ 恢复后验证：从**磁盘**重算，必须逐字节等于请求的目标版本 ────────────
   * 不信 `writeAtomic` 的返回值，也不信"临时文件校验过了"—— 这里量的是目标路径上
   * 真实躺着的那份字节。对不上就是失败，并且尽力回滚到恢复前那一版。 */
  let verified = '';
  try {
    verified = sha1OfFile(resolved).sha1;
  } catch (err) {
    verified = '';
  }
  if (verified !== target) {
    let rollback = 'none';
    if (guard.ok && guard.sha1) {
      const gs = storePathFor(guard.sha1, resolved);
      const rb = writeAtomic(gs, resolved, guard.sha1);
      rollback = rb.ok ? 'ok' : ('failed:' + rb.reason);
    }
    appendRestoreFailed({
      key, target, from: cur ? cur.sha1 : '', reason: 'verify_mismatch',
      explicit, extra: { actual: verified, rollback },
    });
    return {
      ok: false, reason: 'verify_mismatch', sha1: target, verifiedSha1: verified,
      guardSha1: guard.sha1 || '', rollback,
      currentIntact: rollback === 'ok' ? true : currentIntactState(resolved, cur),
    };
  }

  /* ── ⑥ 权限：**不许把保管副本的 0444 带过来** ──────────────────────────────
   * 保管副本是只读的（第一道防线），但那是"库里的字节不许改"，不是"用户的原件不许改"。
   * 恢复出来的文件如果不可写，用户下一步就编辑不了它 —— 那等于用一次恢复把产物锁死，
   * 而报告上写着"恢复成功"。所以：显式给一个可写 mode，并**验证**它真的可写。
   *   · 原来的 mode 若带 owner-write 位 ⇒ 保留（不篡改用户自己的 0600 之类）
   *   · 否则（只读 / 新文件）            ⇒ 0644
   */
  const wantMode = (prevMode !== null && (prevMode & 0o200) !== 0) ? prevMode : 0o644;
  let modeOk = false;
  let modeNote = '';
  try {
    fs.chmodSync(resolved, wantMode);
    const st2 = fs.statSync(resolved);
    const hasOwnerWrite = (st2.mode & 0o200) !== 0;
    let accessOk = false;
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
      accessOk = true;
    } catch (err) {
      accessOk = false;
      modeNote = 'access_W_denied';
    }
    modeOk = hasOwnerWrite && accessOk;
  } catch (err) {
    modeOk = false;
    modeNote = (err && err.code) || 'ERR';
  }

  /* ── ⑦ 基线前移 + 审计 ───────────────────────────────────────────────────
   * 基线必须跟着目标版本走（理由见 JSDoc「基线随之前移」）。
   * 索引写失败**不改判 ok**：字节已经正确落地并验证过，说"恢复失败"是假红；
   * 但 `indexWritten:false` 必须报出来，因为它意味着"下一次 check 会把它当改动"，
   * 那是真隐患。宁可多一个要人看的读数，不可少一个。 */
  const at = nowIso();
  // 与 noop 分支共用同一个实现：同一语义写两遍就会有两个版本（见 `moveBaseline`）
  const indexWritten = moveBaseline(key, entry, target, targetBytes);

  appendEvent({
    at,
    kind: KIND_RESTORED,
    path: key,
    sha1: target,          // 保留旧字段名：门禁 H4 断言 verifiedSha1 === sha1
    bytes: targetBytes,
    verifiedSha1: verified,
    fromSha1: cur ? cur.sha1 : '',
    baselineBefore: baseline,
    explicit,
    guardSha1: guard.sha1 || '',
    guardDeduped: guard.deduped === true,
    mode: wantMode.toString(8),
    modeOk,
    modeNote,
    indexWritten,
  });

  const warnings = [];
  if (!modeOk) warnings.push('mode_not_writable' + (modeNote ? ':' + modeNote : ''));
  if (!indexWritten) warnings.push('index_write_failed');

  return {
    ok: true,
    sha1: target,
    bytes: targetBytes,
    restoredTo: resolved,
    verifiedSha1: verified,
    noop: false,
    fromSha1: cur ? cur.sha1 : '',
    targetSha1: target,
    explicit,
    guardSha1: guard.sha1 || '',
    mode: wantMode,
    modeOk,
    indexWritten,
    warnings,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * events —— 审计读数
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 读全部事件，按 `at` 升序（同一毫秒内保持文件里的先后）。
 * 坏行跳过（事件流不能因为一行脏数据整段作废）。
 * @return {object[]}
 */
function events() {
  if (!state.eventsFile) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(state.eventsFile, 'utf8');
  } catch (err) {
    return [];
  }
  const out = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const s = lines[i].trim();
    if (!s) continue; // eslint-disable-line no-continue
    let ev = null;
    try {
      ev = JSON.parse(s);
    } catch (err) {
      continue; // eslint-disable-line no-continue
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue; // eslint-disable-line no-continue
    ev.seq = i;
    out.push(ev);
  }
  out.sort((a, b) => {
    const ta = Date.parse(a.at) || 0;
    const tb = Date.parse(b.at) || 0;
    if (ta !== tb) return ta - tb;
    return a.seq - b.seq;
  });
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 导出
 * ═══════════════════════════════════════════════════════════════════════════ */

module.exports = {
  init,
  keep,
  check,
  audit,
  restore,
  versions,
  events,
  confirmRepair,
};
