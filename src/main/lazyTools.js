'use strict';
/**
 * lazyTools.js —— 技能「渐进披露」（progressive disclosure）的**纯函数层**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它守的是什么（实测数字，不是估计）
 * ═══════════════════════════════════════════════════════════════════════
 *   47 个技能的 tool schema 由 `src/shared/toolSchema.js:78 buildToolsFrom` 派生，全量
 *   **50,341 字节 / ≈11,900 tokens**，而 `backend.js` 的 turn 循环**每轮原样重发这一张表**。
 *   11 个真实任务、160 轮 trace 里总共只调用了 **11 个技能（149 次）**，**36 个技能从未被调用**；
 *   核心 8 个（shell-exec / file-read / file-write / file-list / file-search / web-fetch /
 *   image-info / image-ocr）合计 **4,861 字节**，覆盖 **142/149 = 95.3%** 的调用。
 *   ⇒ 每轮 50,341 → ≈5,000 字节 + 5 个元工具。省下来的是**每一轮**都付的钱。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 设计纪律（每条都有代价，写清楚是为了以后别改错）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **纯函数，无副作用**。本文件不 require backend / 不碰 fs / 不碰全局状态。
 *      理由与本仓 `secondRunner.pickDelegateTools` / `planDelegation` 同一条：
 *      逻辑抽成纯函数，门禁才能**真跑**它；内联在 `runAgentLoopInner` 里的话，
 *      门禁只能 grep 源码字面量 —— 那种判据挡不住"改一个字符就静默失效"。
 *      门禁见 `scripts/smoke/unit-lazy-tools.mjs`（L1–L16）。
 *   ② **默认关闭**。开关是 `payload.lazyTools === true`（只认布尔字面量 true，
 *      字符串 `'true'` / 数字 `1` / 其它 truthy 一律不算）。关闭时本模块**不被调用**，
 *      发送给模型的工具表与改动前逐字节相同 —— 这条由 `turnToolsFor` 一处负责（L11 真跑）。
 *   ③ **不许连带削减第二执行实例**。`backend.js` 的 `const tools` 必须保持全量表
 *      （`pickDelegateTools` / `planDelegation` 两处都要全量）；分层只作用于**本轮 body**。
 *      另外：第二实例的 payload 继承了 `lazyTools`，但它的元工具被 `noMetaTools` 裁掉了 ——
 *      连披露入口 `find_skills` 一起没了。若还开着披露，替补会只剩核心 8 个技能且**永远拉不回来**。
 *      ⇒ `isLazyEnabled` 里显式把 `noMetaTools === true` 判成关闭（见该函数注释）。
 *   ④ **披露是「逐个放出」，不是「一次全放」**。`buildTurnTools` 只放出 `disclosed` 里点名的 id，
 *      其余隐藏技能仍在表外（L8 配 L9 反空过：不 disclose 时那个 id 必须不在结果里）。
 *   ⑤ **匹配素材 ≠ 渲染素材**。「藏起来」只有在"拉得回来"的前提下才是优化 ——
 *      所以 `find_skills` 的命中率是承重指标，不是加分项。实测：拿截断 20 字的 brief 当匹配素材，
 *      18 个真实用户说法里 **16 个零命中**（89%）。⇒ 匹配读完整素材（`full`/`fullName` + 参数说明），
 *      渲染仍只读截断的 `brief`/`name`（L12p 用 1 万字垃圾证明两者不串）。
 *      中文长句再叠一层 **n-gram 补充**（`gramsOf`），但**精确命中永远排在模糊命中前面**（L15e）。
 *      这条的代价如实写在这里：n-gram 会让"无意义的中文串"碰巧命中几条
 *      （它和真描述共享 2-gram），所以零命中的兜底（如实说没搜到 + 全量清单）必须一直留着（L12h）。
 *   ⑥ **推荐关系只做「提升」，不做「扩张」**。藏起 36 个技能有个真实副作用：
 *      `ppt-generate` 描述里写着「⚠️ 默认不要用这个，请优先用 slides-generate」，
 *      但分层后 `slides-generate` 不在表里 ⇒ 模型转不过去，用户说「生成幻灯片」拿到 `.pptx`
 *      （产品默认该是 HTML 演示）。修法是 `referencedBy` + `planFindSkills` 里的
 *      「推荐 ∩ 已命中」双条件 —— **只把已经沾边的提升到必给，绝不引入没命中的**。
 *      去掉第二个条件就会变成"无脑跟随推荐"（`slides-generate` 会连带要求发布/截图两个工具），
 *      门禁 L17c 就是这条的靶子。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么 `skillIds` 必须由调用方传（而不是在这里"猜"哪些是技能）
 * ═══════════════════════════════════════════════════════════════════════
 *   全量工具表 = `payload.tools`（技能） + `META_TOOLS`（元工具：workflow_plan / find_skills …）。
 *   元工具**永远**要留给模型（它们是流程工具，不是可选技能），所以"哪些条目是技能"必须外部告知。
 *   真源是 `scanSkills()` 的 manifest 清单（`skills` 数组的 id）——`backend.js` 里现成有。
 *   传不进来时本模块**抛 TypeError**，而不是"什么都没有就当成技能全裁掉"：
 *   后者的症状是「模型突然连 workflow_plan 都看不见了」，而报错只有一行，排查成本差两个数量级。
 *
 * 导出（全部纯函数 / 常量）：
 *   CORE_SKILL_IDS        核心常驻档（8 个，永远发给模型）
 *   AUTO_DISCLOSE_TOP     find_skills 命中后自动披露的条数（3）
 *   NAME_MAX / DEFAULT_MAX_DESC_CHARS  摘要截断上限（见 skillBriefs 头注）
 *   isLazyEnabled(payload)                         开关判定（唯一入口）
 *   splitTools(allTools, skillIds)                 → { core, hidden }
 *   buildTurnTools(allTools, disclosed, skillIds)  → 本轮工具表
 *   turnToolsFor(allTools, disclosed, skillIds, payload) → 开关 + 分层（backend 只调这一个）
 *   skillBriefs(hidden, maxDescChars, metaById)    → [{id,name,brief,fullName,full}]
 *   matchSkills(briefs, query)                     → 匹配条目（朴素子串 + 零命中时 n-gram 降级）
 *   matchSkillsDetailed(briefs, query)             → 同上 + { via, terms, grams }（门禁要能断言走了哪一级）
 *   gramsOf(token)                                 → 2/3/4-gram 切片（n-gram 降级的原料）
 *   referencedBy(brief, hiddenIds, limit)          → 描述里显式写出的其它技能 id（推荐关系）
 *   idBoundaryPattern(id)                          → 词边界正则（shop-order ≠ mmm-shop-order）
 *   parseEnableList(raw)                           → id 数组
 *   planFindSkills(opts)                           → find_skills 的全部决策 + 给模型看的文本
 */

/**
 * 核心常驻档：这 8 个技能**永远**发给模型。
 *
 * 选型依据是实测调用分布（11 个真实任务 / 149 次调用）：
 *   shell-exec 53、file-write 26、file-read 19、file-list 13、image-info 12、
 *   web-fetch 9、image-ocr 6、file-search 4 → 合计 142/149 = 95.3%。
 *
 * ⚠️ 这是**白名单**：每一项都必须是 `skills/` 下的真目录名。
 *   写错一个 id 不会有任何报错——它会静默地既不在核心档、也不在隐藏档
 *   （`splitTools` 按名字匹配，匹配不上就当它不存在），于是那个技能**彻底消失**。
 *   门禁 L1 逐项核真目录，就是为了拦这一类静默漏失。
 */
const CORE_SKILL_IDS = Object.freeze([
  'shell-exec',
  'file-read',
  'file-write',
  'file-list',
  'file-search',
  'web-fetch',
  'image-info',
  'image-ocr',
]);

/** find_skills 命中后**自动**披露的条数：一次拿到就能动手，不额外多一轮往返。 */
const AUTO_DISCLOSE_TOP = 3;

/** 摘要里 `name` 的字符上限。真实 manifest name 最长 21 字，16 足够认出来。 */
const NAME_MAX = 16;

/**
 * 摘要里单条 `brief` 的字符上限（默认 20）。
 *
 * ⚠️ 规格里写的是 40，这里改成 20，**保的是体积上限而不是那个数字**。
 *   39 条隐藏技能实测（汉字 UTF-8 占 3 字节 / 条，含 `- id —— name：brief` 这一行）：
 *     brief ≤ 40 字 ⇒ find_skills 的**清单文本 4,599 字节**（超上限）
 *     brief ≤ 24 字 ⇒ 3,945 字节
 *     brief ≤ 20 字 ⇒ **3,624 字节**（门禁 L6 卡 4,000，余 376 字节 ≈ 还能再加 4 个技能）
 *   这段文本会进对话历史、**每轮重发**，所以它是承重的：`find_skills` 一次回答的代价
 *   必须显著小于"每轮多发 4.5 万字节"，否则这个优化只是把成本挪了个位置。
 *   （JSON 中间态还会多出 `{"id":…,"name":…,"brief":…}` 的键名开销 ≈28 字节/条，
 *    那不是发给模型的东西 —— 门禁量的是**渲染后的文本**，见 L6d 的注释。）
 */
const DEFAULT_MAX_DESC_CHARS = 20;

/** 取工具条目的函数名（容错：'xxx' 这种纯字符串形式的条目也认）。 */
function toolName(t) {
  if (typeof t === 'string') return t.trim();
  if (!t || typeof t !== 'object') return '';
  const fn = t.function;
  if (fn && typeof fn.name === 'string') return fn.name.trim();
  if (typeof t.name === 'string') return t.name.trim();
  return '';
}

/** 取工具条目的描述文本。 */
function toolDescription(t) {
  if (!t || typeof t !== 'object') return '';
  const fn = t.function;
  if (fn && typeof fn.description === 'string') return fn.description;
  if (typeof t.description === 'string') return t.description;
  return '';
}

/**
 * 拼一条技能的**匹配素材**（只用于 `matchSkills`，**永远不渲染**）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么必须和渲染素材分开（这是实测出来的，不是洁癖）
 * ═══════════════════════════════════════════════════════════════════════
 *   `brief` 被截到 20 字是为了压**渲染**体积（它进对话历史、每轮重发，见
 *   `DEFAULT_MAX_DESC_CHARS`）。但拿它当**匹配**素材 ⇒ 描述第 20 字之后的内容全都搜不到。
 *   实测（真实 `skills/` 的 47 个 manifest，18 个真实用户说法）：
 *     用截断 20 字的 brief 匹配     ⇒ **16/18 零命中（89%）**
 *     用完整 description 匹配        ⇒ 11/18（61%）
 *     用完整 description + n-gram    ⇒  2/18（11%）
 *   典型：「安装包」—— 这三个字在 `package-app` 描述的第 40 字之后，
 *   brief 里只剩「把 Electron 工程真的打包…」，怎么查都查不到。
 *   ⇒ 匹配看 `full`（完整），渲染看 `brief`（截断）。两个目的，两份素材。
 *
 *   顺带把 `params[].label / hint / example` 也收进来：那些文字**本来就在
 *   `toolSchema.buildToolParameters` 生成的 schema 里发给模型了**，是模型真能看见的信息，
 *   拿它做匹配不是"猜"。「生成幻灯片」的唯一依据就在这里
 *   （`ppt-generate` 的 slides 参数 label 写着「幻灯片内容…」，它的 description 里没有「幻灯片」）。
 *
 * 内存代价：39 条 × 平均约 1.2KB ≈ 47KB 字符串，**不进上下文、不进每轮重发**，可忽略。
 *
 * @param {object|null} meta manifest（可能没有）
 * @param {object} tool 工具条目（meta 缺失时退回读 schema 里的 description）
 * @returns {string} 折叠空白后的完整匹配素材（可为空串）
 */
function matchBlobOf(meta, tool) {
  const parts = [];
  const desc = (meta && meta.description) || toolDescription(tool) || '';
  if (desc) parts.push(String(desc));
  const ps = (meta && Array.isArray(meta.params)) ? meta.params : [];
  for (const p of ps) {
    if (!p || typeof p !== 'object') continue;
    const label = String(p.label || p.name || p.key || '');
    const hint = String(p.hint == null ? '' : p.hint);
    const example = String(p.example == null ? '' : p.example);
    if (label) parts.push(label);
    if (hint) parts.push(hint);
    if (example) parts.push(example);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 把 `skillIds` 归一成 Set。
 * @param {Iterable<string>} skillIds 技能 id 真源（`scanSkills()` 的 id 清单）
 * @returns {Set<string>}
 * @throws {TypeError} 没传或类型不对时**抛错**（理由见文件头「为什么 skillIds 必须由调用方传」）
 */
function toSkillIdSet(skillIds) {
  if (skillIds instanceof Set) return skillIds;
  if (Array.isArray(skillIds)) return new Set(skillIds.map((s) => String(s == null ? '' : s).trim()).filter(Boolean));
  throw new TypeError(
    'lazyTools: skillIds 必须是技能 id 的数组或 Set（真源 = scanSkills() 的 manifest id 清单）。'
    + '不传会把元工具（workflow_plan / find_skills …）当成隐藏技能一起裁掉，症状是「模型连计划工具都看不见」。',
  );
}

/**
 * 从全量工具表里分出「核心档」与「可隐藏档」。
 *
 * @param {Array} allTools 全量表（`payload.tools` + `META_TOOLS`）
 * @param {Iterable<string>} skillIds 技能 id 真源（`skills` 数组的 id）
 * @returns {{core: Array, hidden: Array}}
 *   core   = 名字在 `CORE_SKILL_IDS` 里的**技能** + 所有**非技能**工具（元工具等，永远保留）
 *   hidden = 其余**技能**工具（会被 `find_skills` 按需放出）
 *
 * 判据只有一条：`name ∈ skillIds` ⇒ 这是技能；技能里再按 `CORE_SKILL_IDS` 分两档。
 * 不在 `skillIds` 里的一律不是技能 ⇒ 进 core（元工具、以及将来任何非技能工具）。
 */
function splitTools(allTools, skillIds) {
  const ids = toSkillIdSet(skillIds);
  const coreSet = new Set(CORE_SKILL_IDS);
  const core = [];
  const hidden = [];
  for (const t of Array.isArray(allTools) ? allTools : []) {
    const name = toolName(t);
    if (name && ids.has(name) && !coreSet.has(name)) hidden.push(t);
    else core.push(t);
  }
  return { core, hidden };
}

/**
 * 算本轮工具表（纯函数，无副作用，可重入）。
 *
 * @param {Array} allTools 全量表
 * @param {Iterable<string>} disclosed 已被披露的技能 id 集合
 * @param {Iterable<string>} skillIds 技能 id 真源
 * @returns {Array} 本轮要发给模型的表 —— **保持 `allTools` 的原顺序**（只做过滤，不重排）
 *
 * 三个性质（都门禁真跑）：
 *   · 「逐个放出」：只放出 `disclosed` 里点名的功能，其余隐藏技能仍在表外（L8/L9）；
 *   · 「无遗漏」：把 39 个隐藏 id 全加进 disclosed ⇒ 结果与全量表**逐名相等**（L4）；
 *   · 「幂等」：同一组 disclosed 调两次结果相同；disclosed 里有不存在的 id ⇒ 忽略，不抛错（L5）。
 */
function buildTurnTools(allTools, disclosed, skillIds) {
  const all = Array.isArray(allTools) ? allTools : [];
  const split = splitTools(all, skillIds);
  const hiddenIds = new Set(split.hidden.map(toolName).filter(Boolean));
  const shown = new Set();
  for (const id of iterableOf(disclosed)) {
    const v = String(id == null ? '' : id).trim();
    if (v) shown.add(v);
  }
  return all.filter((t) => {
    const name = toolName(t);
    if (!hiddenIds.has(name)) return true; // 核心技能 + 元工具：永远在
    return shown.has(name);                // 隐藏技能：只有被点名才放出
  });
}

/** 把任意「可能是可迭代也可能是 null」的东西安全展开成数组。 */
function iterableOf(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (x instanceof Set || x instanceof Map) return Array.from(x.keys());
  if (typeof x === 'object' && typeof x[Symbol.iterator] === 'function') return Array.from(x);
  return [];
}

/**
 * 开关判定 —— **整个渐进披露的唯一开关入口**。
 *
 * @param {object} payload 本次运行的 payload
 * @returns {boolean} true 才分层
 *
 * 两件事，缺一不可：
 *   ① `lazyTools === true`（严格布尔）。**默认 false**：`undefined` / `false` / 字符串 `'true'` /
 *      数字 `1` 全部是关闭。为什么不用 truthy：这个开关会改变模型看到的东西，
 *      必须"写错也关着"（fail-safe）——一个被前端误传成 `'true'` 的开关不该悄悄改变产品行为。
 *   ② `noMetaTools !== true`。这一条是**第二执行实例的活口**：替补的 payload 整份继承
 *      `lazyTools`，而它的元工具被裁掉了（`secondRunner.pickDelegateTools` 剔掉全部 metaNames），
 *      **披露入口 `find_skills` 随之消失**。此时若还分层，替补只剩核心 8 个技能，
 *      并且**没有任何手段**能把隐藏技能拉回来 —— "工具集变小"会变成"工具集残废"。
 *      ⇒ 没有控制器就不做分层，这是两件事必须同生同死的那一半。
 */
function isLazyEnabled(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  if (p.lazyTools !== true) return false;
  if (p.noMetaTools === true) return false;
  return true;
}

/**
 * ★ 开关的**生产者**（2026-11-11 补）—— 这个函数之前不存在，这正是本模块"写完从来没用过"的原因。
 *
 * 【缺陷形状（实测，不是推测）】
 *   `isLazyEnabled` 要求 `payload.lazyTools === true`，而 `payload` 是
 *   `handleChat` 里 `JSON.parse(raw)` 出来的**原始请求体**。全仓 grep `lazyTools:` 在
 *   `src/` 下**零命中**（除本文件自身）⇒ 没有任何前端或主进程会写这个字段
 *   ⇒ 恒 `undefined` ⇒ `isLazyEnabled` 恒 false ⇒ 分层逻辑从未执行过一次。
 *   本仓自己在 backend.js:2904 把这件事写成反面教材（"渐进披露 payload.lazyTools
 *   默认关着，结果全仓没有生产者"），但那个开关本身一直没接上。
 *
 * 【为什么把判据放在这里、而不是内联在 handleChat 里】
 *   内联的话门禁只能 grep 源码字面量，挡不住"改一个字符就静默失效"。
 *   放纯函数层，门禁能**真跑**四种组合（见 scripts/smoke/unit-lazy-wiring.mjs）。
 *
 * 【优先级与失败方向】
 *   ① 请求体显式给了布尔（true 或 false）⇒ 就用它。**表意优先于配置**：
 *      调用方（含第二执行实例、含将来的 API 调用方）最清楚这一次要不要分层。
 *   ② 没给 ⇒ 落到配置。配置的默认值是**开**（见 defaultConfig 的 lazyTools，
 *      可用 `DOUYA_LAZY_TOOLS=0` 或 config.json 的 `lazyTools:false` 关掉）。
 *   ③ 只认严格布尔。字符串 `'true'` / 数字 `1` 一律**不算**显式指定，会落到 ② ——
 *      与 `isLazyEnabled` 的严格布尔判据保持同一条口径（写错就回默认，不猜意图）。
 *
 * ⚠️ 为什么不在这里顺手处理 `noMetaTools`：那是 `isLazyEnabled` 的职责，且它必须在
 *   **最终判定处**生效（第二执行实例的 payload 继承 lazyTools 但元工具被裁）。
 *   本函数只决定"用户/配置这一侧想不想开"，不替运行时做"能不能开"的判断。
 *
 * @param {object} payload 原始请求体（只读 lazyTools）
 * @param {object} cfg 网关配置（defaultConfig 的产物，只读 lazyTools）
 * @returns {boolean} 应当写进 payload.lazyTools 的值
 */
function resolveLazySwitch(payload, cfg) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  if (p.lazyTools === true) return true;
  if (p.lazyTools === false) return false;
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  // 配置侧同样只认严格 false 为"关"：没配置 / 配错类型 / 老配置文件缺这一项，
  // 都落到默认开（这是产品当前的出厂行为，2026-11-11 由本人确认）。
  return c.lazyTools !== false;
}

/**
 * 「本轮该发给模型哪张表」—— backend 只调这一个函数（分层逻辑一处不散）。
 *
 * @param {Array} allTools 全量表（**必须**是全量，不是上一轮的结果）
 * @param {Iterable<string>} disclosed 已披露的技能 id
 * @param {Iterable<string>} skillIds 技能 id 真源
 * @param {object} payload 本次运行的 payload（只读 `lazyTools` / `noMetaTools`）
 * @returns {Array} 关闭时返回**全量表的副本**（行为与改动前一致）；开启时返回分层结果
 *
 * 关闭时返回 `slice()` 而不是原引用：调用方拿到的是"这一轮要发的东西"，
 * 不该能顺着它改到 `tools`（那是 `pickDelegateTools` / `planDelegation` 的入参）。
 */
function turnToolsFor(allTools, disclosed, skillIds, payload) {
  const all = Array.isArray(allTools) ? allTools : [];
  if (!isLazyEnabled(payload)) return all.slice();
  return buildTurnTools(all, disclosed, skillIds);
}

/** 字符级截断（不做省略号补齐，纯切）。 */
function clampChars(s, cap) {
  const str = String(s == null ? '' : s);
  const n = Math.max(0, Math.floor(cap));
  return str.length <= n ? str : str.slice(0, n);
}

/** 去换行 + 折叠空白 + 截断；超长补一个省略号。 */
function firstLineOf(text, cap) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const n = Math.max(4, Math.floor(cap));
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** 归一 `maxDescChars`（非法值退回默认，负数/0 会被抬到 4）。 */
function normalizeCap(maxDescChars) {
  const n = Number(maxDescChars);
  if (!Number.isFinite(n)) return DEFAULT_MAX_DESC_CHARS;
  return Math.max(4, Math.floor(n));
}

/**
 * 从 `metaById` 里取某个 id 的 manifest。支持 Map / 数组 / 普通对象三种形态
 * （backend 传的是 `skills` 数组直接建的 Map，门禁传数组或对象都行）。
 */
function metaOf(metaById, id) {
  if (!metaById || !id) return null;
  if (metaById instanceof Map) return metaById.get(id) || null;
  if (Array.isArray(metaById)) {
    const hit = metaById.find((m) => m && String(m.id || '') === id);
    return hit || null;
  }
  if (typeof metaById === 'object') {
    const hit = metaById[id];
    return (hit && typeof hit === 'object') ? hit : null;
  }
  return null;
}

/**
 * 给一批「隐藏技能」生成摘要 —— 只含 id + name + 截断后的一句话描述，供 find_skills 返回。
 *
 * @param {Array} hidden `splitTools` 出来的隐藏档
 * @param {number} maxDescChars 单条描述最大字符数（默认 20，理由见 DEFAULT_MAX_DESC_CHARS）
 * @param {Map|Array|object} metaById 可选：技能 manifest 索引（用来取中文 `name` 和完整匹配素材）。
 *   不传时 `name` 退回 id、`full` 退回工具 schema 里的 description —— **不编造**任何内容。
 * @returns {Array<{id:string,name:string,brief:string,fullName:string,full:string}>}
 *   `id`         工具名（模型要拿它传给 enable）
 *   `name`       中文名，**截到 NAME_MAX**，用于渲染
 *   `brief`      描述，**截到 maxDescChars**，用于渲染
 *   `fullName`   中文名**完整版**，只用于匹配（名字也可能超过 16 字而被截）
 *   `full`       完整匹配素材（description + params 文字），只用于匹配，**永不渲染**
 *
 * 体积是**渲染那两个字段**的第一约束：`brief`/`name` 会进对话历史并且**每轮重发**。
 * 实测 39 条清单文本 = 3,624 字节（门禁 L6d/L12n 卡 4,000）。
 * ⚠️ `fullName`/`full` 加进来**不会**改变渲染体积（`briefLine` 只读 id/name/brief，门禁 L12p 锁住），
 *   但会让 `JSON.stringify(briefs)` 变大 —— 所以体积判据量的是 `renderFindSkillsText` 的输出，
 *   不是这个数组的 JSON（理由见门禁 L6d 的注释）。
 */
function skillBriefs(hidden, maxDescChars = DEFAULT_MAX_DESC_CHARS, metaById = null) {
  const cap = normalizeCap(maxDescChars);
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(hidden) ? hidden : []) {
    const id = toolName(t);
    if (!id || seen.has(id)) continue; // 同名只留第一条（防将来表里出现重复条目时摘要也跟着重复）
    seen.add(id);
    const meta = metaOf(metaById, id);
    const rawName = (meta && (meta.name || meta.title)) || '';
    const rawDesc = (meta && meta.description) || toolDescription(t) || rawName || id;
    out.push({
      id,
      name: rawName ? clampChars(rawName, NAME_MAX) : id,
      brief: firstLineOf(rawDesc, cap),
      // 匹配素材（完整、不渲染）—— 名字也不截断，否则「生成演示文稿（网页版）」这种长名字会搜不到
      fullName: rawName ? String(rawName) : id,
      full: matchBlobOf(meta, t),
    });
  }
  return out;
}

/**
 * 把 query 切成**朴素、可预测**的检索词（第一级匹配用）。
 *
 * 规则（两步，没有第三步）：
 *   ① 按空白切词；
 *   ② 每个词再按「中文 / 英文数字」交界切一次（`'做ppt' → ['做','ppt']`）。
 * 长度 < 2 的子词丢掉（单字像"做""的"几乎命中所有条目 ⇒ 等于没筛）。
 *
 * ⚠️ 为什么必须有第 ② 步（实测，不是偏好）：规格里给的示例 query 是 `"做PPT"`，
 *   而技能的 id/name/description 里写的是 `ppt-generate` / `生成PPT文件` / `**.pptx 文件**`。
 *   只做「整词子串匹配」时 `"做ppt"` 一个都命中不了（"做"和"PPT"中间没有分隔符），
 *   于是模型最自然的那句查询会 100% 落进"没搜到 ⇒ 返回全量清单"——功能可用但退化成一次空转。
 *   实测：加第 ② 步后 `"做PPT"` 命中 2 条（slides-generate / ppt-generate）。
 *
 * 🔴 第 ② 步**切不开中文内部**：`'做个演示文稿'` 仍然是一个整串 token。
 *   这是**故意**的 —— 中文内部怎么切需要语义知识（分词），而分词器是又一个大依赖、
 *   又会带来"有时切对有时切错"的不可预测性。中文内部的召回交给
 *   `matchSkills` 的**第二级 n-gram 降级**（只在第一级零命中时才启用，见那里的注释）。
 *
 * @param {string} q
 * @returns {Array<string>} 小写检索词
 */
function tokenizeQuery(q) {
  const raw = String(q == null ? '' : q).trim();
  if (!raw) return [];
  const out = [];
  for (const word of raw.split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
    // 中文 / 英文数字 交界切开：'做ppt' → '做' + 'ppt'；'打包exe' → '打包' + 'exe'
    const pieces = lower.match(/[a-z0-9_\-\.]+|[\u4e00-\u9fff]+/g) || [];
    for (const p of pieces) {
      if (p.length >= 2 && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** n-gram 的阶数下限（**2 必须留**，理由见 `gramsOf`）。 */
const NGRAM_MIN = 2;
/** n-gram 的阶数上限（4 阶已足够覆盖「路演材料」这种四字词，再往上只是噪声）。 */
const NGRAM_MAX = 4;

/**
 * 把一个中文 token 切成 **2-gram / 3-gram / 4-gram 全量**（第二级匹配的原料）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么需要它（实测）
 * ═══════════════════════════════════════════════════════════════════════
 *   `tokenizeQuery` 切不开中文内部，所以 `'做个演示文稿'` 是一个整串。
 *   而技能描述里写的是「做演示文稿」（没有"个"）⇒ 整串不是任何描述的连续子串
 *   ⇒ 第一级必然零命中。真实的用户就是这么打字的（"做个…" "查一下…"），
 *   这不是乱输，是自然口语。18 个真实说法里 16 个属于这一类。
 *
 * 为什么 **2-gram 不能省**（不能只切 3/4 阶）：
 *   `'打包应用'` 的 3-gram 是 `['打包应','包应用']`，而 `package-app` 描述里写的是
 *   「打包桌面应用」—— `'打包应'` 不连续 ⇒ 只有 2-gram 的 `'打包'` / `'应用'` 能命中。
 *
 * 为什么**不做** 1-gram：
 *   单字（"做""的""个"）几乎命中所有条目，等于把"筛选"变成"全给"。
 *
 * 为什么只切**纯中文**的 gram（实测，不是洁癖）：
 *   `'做excel'` 这种中英混排 token 若按字符切片，会切出 `'ex'` / `'exc'` 这类拉丁碎片 ——
 *   它们命中面又大又没有语义（'ex' 会同时命中 excel-*、project-scaffold…）。
 *   ⇒ gram 必须是**整段汉字**；中日混排里拉丁那一段交给第一级的子串匹配（它本来就够准）。
 *
 * @param {string} token 一个检索词
 * @param {Array<string>} [sink] 可选累加器（便于跨 token 去重）
 * @returns {Array<string>} 去重后的 gram 列表（保序：先 2-gram 全部，再 3-gram，再 4-gram）
 */
function gramsOf(token, sink) {
  const s = String(token == null ? '' : token);
  const acc = Array.isArray(sink) ? sink : [];
  if (s.length < NGRAM_MIN) return acc;
  for (let n = NGRAM_MIN; n <= NGRAM_MAX; n += 1) {
    for (let i = 0; i + n <= s.length; i += 1) {
      const g = s.slice(i, i + n);
      if (!/^[\u4e00-\u9fff]+$/.test(g)) continue; // 只留纯汉字 gram（理由见头注）
      if (!acc.includes(g)) acc.push(g);
    }
  }
  return acc;
}

/** 打分权重：id 最可信，名字次之，正文最弱（与改动前的规则一致，只是现在支持多词累加）。 */
const SCORE_ID = 3;
const SCORE_NAME = 2;
const SCORE_TEXT = 1;

/**
 * 用一批检索词给全部条目打分并排序（两级共用同一套打分，避免"两级两套口径"）。
 *
 * 取字段的优先级就是**反控的接口**：
 *   · name 取 `fullName || name`（完整名优先，退回截断名）
 *   · 正文取 `full || brief`（完整素材优先，退回截断 brief）
 *   ⇒ 把 `skillBriefs` 里的 `full` 去掉，本函数自动退回截断 brief —— 门禁的反控正是靠它。
 *
 * @param {Array} list 条目
 * @param {Array<string>} terms 检索词 / gram
 * @returns {Array} 命中的条目，按分数降序、同分保持原序
 */
function scoreEntries(list, terms) {
  const scored = [];
  for (let i = 0; i < list.length; i += 1) {
    const b = list[i] || {};
    const id = String(b.id || '').toLowerCase();
    const nm = String(b.fullName || b.name || '').toLowerCase();
    const tx = String(b.full || b.brief || '').toLowerCase();
    let score = 0;
    for (const tk of terms) {
      if (!tk) continue;
      if (id.includes(tk)) score += SCORE_ID;
      else if (nm.includes(tk)) score += SCORE_NAME;
      else if (tx.includes(tk)) score += SCORE_TEXT;
    }
    if (score > 0) scored.push({ item: list[i], score, at: i });
  }
  scored.sort((x, y) => (y.score - x.score) || (x.at - y.at));
  return scored.map((x) => x.item);
}

/**
 * find_skills 的匹配逻辑（纯函数）+ **走了哪一级**的读数。
 *
 * @param {Array} briefs `skillBriefs` 的输出
 * @param {string} query 查询词，空则返回全部
 * @returns {{matched: Array, via: 'exact'|'ngram'|'none', terms: Array<string>, grams: Array<string>}}
 *   `via` = **第一级有没有命中**：`exact` 有 / `ngram` 无（靠第二级找回）/ `none` 两级都空。
 *          此时**必须**走"如实说没搜到 + 全量清单"。
 *
 * ── 两级结构（顺序是纪律，不是实现细节）────────────────────────────────
 *   第一级（精确）：`tokenizeQuery` 的词做子串匹配（id 3 / name 2 / 正文 1 分）。
 *   第二级（模糊）：中文 token 切成 2/3/4-gram 再打一遍分。
 *
 *   ★ 两级**都要跑**，但结果的顺序是「第一级的命中整体排在第二级的命中前面」，
 *     第二级只**补充**不**插入**。
 *
 *   为什么第二级不许插到前面（实测）：「生成」是全部 `*-generate` 技能的高频词，
 *     `'生成'` 这一个 gram 就能命中 17/47 个技能。若让 n-gram 参与主排序，
 *     「做PPT」这种第一级已经精确命中的查询会被一堆弱命中稀释，甚至把正主挤出前 3。
 *     ⇒ 精确命中永远先说话，模糊只填后面。
 *
 *   为什么第二级也不许"只在零命中时"才跑（实测，这条是被真实说法逼出来的）：
 *     「部署网站」第一级能命中 **1 条**（`browser-verify` 的描述里有"部署网站"四个字连写），
 *     `deploy-static`（正主）不在其中 —— 若按"非零就不降级"，正主会被一条弱命中永久挡在门外。
 *     实测：改成"两级都跑、精确优先"之后，「部署网站」的前 3 条变成
 *     `[browser-verify, deploy-static, deploy-node]`（正主进来了）。
 *   ⇒ 判据是 `matched` 的**前缀**，不是"跑了几级"。
 */
function matchSkillsDetailed(briefs, query) {
  const list = Array.isArray(briefs) ? briefs : [];
  const q = String(query == null ? '' : query).trim();
  if (!q) return { matched: list.slice(), via: 'none', terms: [], grams: [] }; // 空 query ⇒ 全量清单
  const terms = tokenizeQuery(q);
  if (!terms.length) return { matched: list.slice(), via: 'none', terms: [], grams: [] };

  // ── 第一级：精确子串 ──────────────────────────────────────────────
  const exact = scoreEntries(list, terms);

  // ── 第二级：n-gram，只补在后面 ────────────────────────────────────
  const grams = [];
  for (const tk of terms) gramsOf(tk, grams);
  if (!grams.length) return { matched: exact, via: exact.length ? 'exact' : 'none', terms, grams: [] };
  const fuzzy = scoreEntries(list, grams);

  // 同一 id 只按"第一次出现"的位次算：精确命中已经占位的不再重复追加
  const seen = new Set(exact.map((b) => String((b && b.id) || '')));
  const extra = fuzzy.filter((b) => !seen.has(String((b && b.id) || '')));
  const matched = exact.concat(extra);
  return { matched, via: exact.length ? 'exact' : (matched.length ? 'ngram' : 'none'), terms, grams };
}

/**
 * find_skills 的匹配逻辑（对外签名与改动前一致：只返回数组）。
 * 需要知道"走了哪一级"（`via`）时用 `matchSkillsDetailed`。
 *
 * 匹配规则**朴素且可预测**：query 经 `tokenizeQuery` 切成检索词，每个词对 id/name/正文做
 * **大小写不敏感子串匹配**；零命中时降级到 2/3/4-gram 再匹一遍。
 * 🔴 仍然**不做**拼音 / 同义词 / 语义检索：那些"有时能搜到有时搜不到"的行为排查成本太高，
 *   而查不到时的兜底是"如实说没搜到 + 给全量清单"，那条路永远可用、且模型看到的是真清单。
 */
function matchSkills(briefs, query) {
  return matchSkillsDetailed(briefs, query).matched;
}

/**
 * 「推荐关系」最多补披露几条（上限）。
 *
 * 为什么需要上限：推荐关系是**技能作者手写的自由文本**，不是结构化字段。
 * 今天只有 `ppt-generate → slides-generate` 这一条，明天可能有人在描述里写一长串
 * "也可以看看 a / b / c / d / e"。上限把"作者写多了"的影响封在 2 条以内，
 * 不让它把一次拉取变成第二个全量表。
 */
const REFER_LIMIT = 2;

/**
 * 把一个 id 变成**词边界**正则。
 *
 * ⚠️ 为什么必须是边界匹配（这条有专门的门禁 L17e）：
 *   `shop-order` 是 `mmm-shop-order` 的**子串**。裸 `text.includes(id)` 会让
 *   "描述里提到了 mmm-shop-order" 被误判成"推荐了 shop-order" —— 于是模型拿到一个
 *   完全不相干的技能，而没有任何东西报警。
 *   两侧都不许是 `[a-z0-9-]`：左边挡住 `mmm-` 这种前缀，右边挡住 `shop-orders` 这种后缀。
 *   （`i` 标志下 `[a-z0-9-]` 连大写也挡，`shop-orderX` 同样不算命中。）
 *
 * @param {string} id 技能 id（只含 `[a-z0-9-]`，仍做转义以防将来出现别的字符）
 * @returns {RegExp}
 */
function idBoundaryPattern(id) {
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<![a-z0-9-])' + esc + '(?![a-z0-9-])', 'i');
}

/**
 * 找一个技能**描述里显式写出的其它技能 id**（推荐关系），纯函数。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它修的是**分层本身引入的功能性回归**（不是匹配率问题）
 * ═══════════════════════════════════════════════════════════════════════
 *   改前 47 个技能全在表里 ⇒ 模型看到 `ppt-generate` 时会同时看到 `slides-generate`，
 *   读到它描述里那句「⚠️ 默认不要用这个，请优先用 slides-generate」就能转过去。
 *   **分层后只披露了 `ppt-generate`，它推荐的目标不在表里 ⇒ 模型转不过去** ——
 *   用户说「生成幻灯片」，最终拿到的是 `.pptx`，而产品默认应该是 `slides-generate`
 *   （HTML 演示、可截图自检、可发布）。这是"藏起来"造成的真实退化。
 *
 * ── 为什么**不能**无脑跟随推荐 ────────────────────────────────────────
 *   `slides-generate` 描述里推荐了 `browser-verify` / `deploy-static`，但那是
 *   「做完之后再用」的**后续步骤**（发布、截图自检），不是替代品。无脑跟随会平白
 *   多披露 4,260 字节的工具，而且把"选工具"变成"报菜名"。
 *   ⇒ 本函数只负责"描述里提到了谁"；**要不要给**由 `planFindSkills` 用
 *     「∩ 已在本轮命中列表里」这条再筛一道（见那里的注释）。
 *
 * ── 为什么读 `full` 而不是 `brief` ──────────────────────────────────
 *   `brief` 被截到 20 字。`ppt-generate` 的描述第 20 字之后才提到 `slides-generate`，
 *   用 `brief` 会**永远**找不到这条推荐 —— 那和本项目刚刚修掉的匹配缺陷是同一个坑。
 *
 * @param {object} brief 一条 brief（`skillBriefs` 的输出）
 * @param {Iterable<string>} hiddenIds 候选 id 池（只认隐藏档里的技能；核心技能不需要推荐）
 * @param {number} [limit] 最多返回几条（默认 `REFER_LIMIT`）
 * @returns {Array<string>} 被提到的 id，**按在文本里首次出现的先后**排序（作者的行文顺序就是他的强调顺序）
 */
function referencedBy(brief, hiddenIds, limit) {
  const selfId = String((brief && brief.id) || '');
  const text = (String((brief && brief.full) || '') + ' ' + String((brief && brief.fullName) || '')).trim();
  if (!text) return [];
  const capRaw = Number(limit);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : REFER_LIMIT;
  const hits = [];
  for (const raw of iterableOf(hiddenIds)) {
    const id = String(raw == null ? '' : raw).trim();
    if (!id || id === selfId) continue;
    const pat = idBoundaryPattern(id);
    const m = pat.exec(text);
    if (!m) continue;
    hits.push({ id, at: m.index });
  }
  hits.sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
  return hits.slice(0, cap).map((h) => h.id);
}

/**
 * 解析 `enable` 参数：逗号 / 顿号 / 空格 / 分号分隔的 id 串，也接受数组。
 * @param {string|Array} raw
 * @returns {Array<string>} 去空、去重、保序
 */
function parseEnableList(raw) {
  const parts = Array.isArray(raw) ? raw.map((x) => String(x == null ? '' : x)) : String(raw == null ? '' : raw).split(/[,，、;；\s]+/);
  const out = [];
  for (const p of parts) {
    const v = String(p == null ? '' : p).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 清单里每条技能一行的渲染（id + name + brief）。
 *
 * ⚠️ **只读 id / name / brief 这三个字段**，绝不读 `full` / `fullName`。
 *   这一行是"匹配素材不参与渲染"这条纪律的唯一出口 —— 门禁 L12p 用一份
 *   `full` 被改成 1 万字的条目来验：渲染字节数必须一字不差。
 */
function briefLine(b) {
  const id = String((b && b.id) || '');
  const name = String((b && b.name) || '') || id;
  const brief = String((b && b.brief) || '');
  return '- ' + id + ' —— ' + name + (brief && brief !== name ? '：' + brief : '');
}

/**
 * 匹配列表最多展开多少行。
 *
 * 为什么必须有这个上限：n-gram 降级之后，一个宽 query（如「生成幻灯片」）单次可能命中
 * 十几到几十条。全渲染会让**一次回答**从 269 字节涨到几 KB，而这段文本同样进对话历史、
 * 每轮重发 —— 那等于用"按需拉取省下来的钱"去买"一次拉取的全量清单"。
 * ⇒ 渲染层截到 8 条 + 一句「另有 N 条」，但 `matched` 数组本身**保持完整**（门禁要能断言）。
 */
const MATCH_RENDER_MAX = 8;

/**
 * 给模型看的文本（纯函数，独立于 planFindSkills，便于单测）。
 *
 * 诚实红线：**什么都没搜到时必须如实说"没搜到"并附全量清单**，不许静默返回空字符串
 * （模型拿到空字符串只会再试一次同样的 query ⇒ 白烧一轮，而且它不知道自己在白烧）。
 *
 * 「推荐补披露」的呈现纪律：**必须说清来源**。
 *   凭空多给两个工具，模型会以为是随机的、或者以为都得用；写清"这是 top1 自己推荐的替代品"，
 *   它才知道该怎么选。这段文字只在真有推荐时出现，空 query 清单**一个字节都不变**（L17h 锁住）。
 */
function renderFindSkillsText(r) {
  const o = r && typeof r === 'object' ? r : {};
  const briefs = Array.isArray(o.briefs) ? o.briefs : [];
  const matched = Array.isArray(o.matched) ? o.matched : [];
  const enabled = Array.isArray(o.enabled) ? o.enabled : [];
  const unknown = Array.isArray(o.unknown) ? o.unknown : [];
  const alreadyCore = Array.isArray(o.alreadyCore) ? o.alreadyCore : [];
  const referred = Array.isArray(o.referred) ? o.referred.map(String) : [];
  const referredBy = String(o.referredBy || '').trim();
  const referredSet = new Set(referred);
  const q = String(o.query || '').trim();
  const lines = [];

  const markOf = (b) => {
    const id = String((b && b.id) || '');
    if (!referredSet.has(id)) return '';
    return '（' + (referredBy || 'top1') + ' 的推荐：优先用这个）';
  };

  if (q && matched.length) {
    lines.push('【匹配「' + q + '」的技能：' + matched.length + ' 条' + (matched.length > MATCH_RENDER_MAX ? '，只列前 ' + MATCH_RENDER_MAX + ' 条' : '') + '】');
    for (const b of matched.slice(0, MATCH_RENDER_MAX)) lines.push(briefLine(b) + markOf(b));
    if (matched.length > MATCH_RENDER_MAX) {
      lines.push('- （另有 ' + (matched.length - MATCH_RENDER_MAX) + ' 条未列出，用更具体的关键词再查）');
    }
  } else if (q) {
    // ★ 反静默返回空：如实说没搜到，并把全量清单给出来（这也是它唯一"该多说话"的场合）
    lines.push('【没搜到匹配「' + q + '」的技能】下面是全部 ' + briefs.length + ' 个可用技能，请从里面挑一个 id 传给 enable：');
    for (const b of briefs) lines.push(briefLine(b));
  } else {
    lines.push('【核心工具之外还有 ' + briefs.length + ' 个专用技能（都要先披露，才会在下一轮出现在你的工具表里）】');
    for (const b of briefs) lines.push(briefLine(b));
    if (briefs.length) lines.push('要用其中某个：把它的 id 传给 enable，或用 query 描述你要做的事。');
  }

  if (enabled.length) {
    lines.push('✅ 已披露：' + enabled.join('、') + ' —— **下一轮它们会直接出现在你的工具表里，直接调用即可，不需要再调本工具**。');
    if (referred.length && referredBy) {
      // 不说清"为什么多给了这两个"，模型会以为都要用，或者以为是随机的
      lines.push('（其中 ' + referred.join('、') + ' 不是关键词直接命中的，而是 ' + referredBy
        + ' 的描述里写着"优先用这个"才一并披露 —— 做这件事请按 ' + referredBy + ' 的推荐选，别用 ' + referredBy + ' 自己。）');
    }
  } else if (q && matched.length) {
    lines.push('（这次没有新披露任何技能。）');
  }
  if (alreadyCore.length) {
    lines.push('（' + alreadyCore.join('、') + ' 属于核心常驻技能，本来就在你的工具表里，不需要披露。）');
  }
  if (unknown.length) {
    // 不认识的 id 必须点名，否则模型会以为"已经披露过了"然后在下一轮调不到、原地打转
    lines.push('⚠️ 这些 id 不存在（未列出）：' + unknown.join('、') + '。请只使用上面清单里的 id。');
  }
  return lines.join('\n');
}

/**
 * find_skills 的**全部决策**（纯函数）：查什么、命中什么、自动披露什么、给模型说什么。
 *
 * backend 那一侧只做三件事：调本函数、把 `enabled` 加进 `disclosedSkillIds`、把 `text` 回灌。
 * 决策逻辑一处不散 —— 这是"能被门禁真跑"的前提。
 *
 * @param {object} opts
 *   allTools        全量工具表（`payload.tools` + `META_TOOLS`）
 *   skillIds        技能 id 真源
 *   disclosed       已披露的 id 集合（**只读**，本函数不改它）
 *   query/enable    模型给的参数
 *   metaById        可选 manifest 索引（取中文 name + 完整匹配素材）
 *   maxDescChars/top 可选覆盖（默认 20 / 3）
 * @returns {{query:string, briefs:Array, matched:Array, matchedTotal:number, via:string,
 *   auto:Array<string>, referred:Array<string>, referredBy:string, enabled:Array<string>,
 *   unknown:Array<string>, alreadyCore:Array<string>, hiddenCount:number, disclosedBefore:number,
 *   disclosedAfter:number, text:string}}
 *   `via` / `referred` / `referredBy` / `matchedTotal` / `terms` / `grams` 是**新增**字段；
 *   已有字段一个都没改名、没改语义（`backend.js` 的 handler 依赖它们）。
 *   ⚠️ `referred` 只留在纯函数返回值上供门禁断言 —— `backend.js` 不许动，所以 trace 里没有它。
 */
function planFindSkills(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const all = Array.isArray(o.allTools) ? o.allTools : [];
  const split = splitTools(all, o.skillIds);
  const briefs = skillBriefs(split.hidden, o.maxDescChars, o.metaById);
  const q = String(o.query == null ? '' : o.query).trim();
  const enableIds = parseEnableList(o.enable);
  const found = matchSkillsDetailed(briefs, q);
  const matched = found.matched;

  const topRaw = Number(o.top);
  const top = Number.isFinite(topRaw) && topRaw > 0 ? Math.floor(topRaw) : AUTO_DISCLOSE_TOP;
  // 只有**给了 query** 才自动披露 top N：空 query 是"看清单"，此时"前 3 条"没有任何语义
  const auto = (q ? matched.slice(0, top) : []).map((b) => String((b && b.id) || '')).filter(Boolean);

  const hiddenIds = new Set(briefs.map((b) => b.id));
  const coreNames = new Set(split.core.map(toolName).filter(Boolean));

  /**
   * ── 推荐补披露：**只提升「推荐 ∩ 已命中」，绝不引入未命中的** ────────────
   *
   * 三个条件必须同时成立，缺一个都不补：
   *   ① top1 的**完整描述**里显式写了这个 id（技能作者自己说的语义）
   *   ② 它**已在本轮 `matched` 里**（说明它确实沾边 —— 这条是反过度披露的闸门）
   *   ③ 它仍是隐藏技能、且还没被 `auto` 拿走（去重）
   *
   * 为什么 ② 不能省：`slides-generate` 推荐的 `browser-verify` / `deploy-static` 是
   *   "做完之后再用"的后续步骤，不是替代品。去掉 ② 就会平白多披露 4,260 字节，
   *   而且模型会以为"发布会话也要现在做"。门禁 L17c 就是拿这条当靶子的。
   *
   * 为什么 ① 必须读完整描述：`ppt-generate` 在第 20 字之后才提到 `slides-generate`，
   *   读截断 brief 会永远找不到 —— 和刚修掉的匹配缺陷同一个坑。
   */
  const matchedIds = new Set(matched.map((b) => String((b && b.id) || '')).filter(Boolean));
  const topOne = (q && matched.length) ? matched[0] : null;
  const referredBy = topOne ? String(topOne.id || '') : '';
  const referred = [];
  /**
   * ⚠️ 这里向 `referencedBy` 要**全部**推荐（不预先截断），截断放在过滤之后。
   *   为什么顺序不能反（实测）：「做个演示文稿」的 top1 是 `slides-generate`，它的描述里
   *   按行文顺序提到 `ppt-generate` → `deploy-static` → `browser-verify`。
   *   若在 `referencedBy` 里先截到 2 条，前两条恰好是"已在 top3"和"没命中"两个无效项，
   *   真正的候选还没轮到就被切没了 —— 一条**后续步骤**推荐会占掉替代品的名额。
   *   ⇒ 先按 matched/去重过滤，最后才按 REFER_LIMIT 截。上限的效果不变（L17f 仍卡 2 条）。
   */
  for (const id of referencedBy(topOne, hiddenIds, Number.MAX_SAFE_INTEGER)) {
    if (referred.length >= REFER_LIMIT) break;  // ← 真上限在这里
    if (!matchedIds.has(id)) continue;   // ② 反过度披露：推荐了但这轮没命中 ⇒ 不是替代品
    if (auto.includes(id)) continue;     // ③ 去重：top3 里已经有了
    if (!hiddenIds.has(id)) continue;    // ③ 只补隐藏技能（核心技能不用披露）
    if (referred.includes(id)) continue;
    referred.push(id);
  }

  const enabled = [];
  const unknown = [];
  const alreadyCore = [];
  for (const id of enableIds) {
    if (hiddenIds.has(id)) {
      if (!enabled.includes(id)) enabled.push(id);
    } else if (coreNames.has(id)) {
      if (!alreadyCore.includes(id)) alreadyCore.push(id);
    } else if (!unknown.includes(id)) {
      unknown.push(id);
    }
  }
  for (const id of auto) if (!enabled.includes(id)) enabled.push(id);
  for (const id of referred) if (!enabled.includes(id)) enabled.push(id);

  const disclosedBefore = iterableOf(o.disclosed).length;
  const text = renderFindSkillsText({ query: q, briefs, matched, enabled, unknown, alreadyCore, referred, referredBy });

  return {
    query: q,
    briefs,
    matched,
    matchedTotal: matched.length,
    via: found.via,
    terms: found.terms,
    grams: found.grams,
    auto,
    referred,
    referredBy: referred.length ? referredBy : '',
    enabled,
    unknown,
    alreadyCore,
    hiddenCount: briefs.length,
    disclosedBefore,
    // 只报"本次之后会有多少"（集合口径，不是数组拼接口径 —— 重复披露不会虚增）
    disclosedAfter: new Set([...iterableOf(o.disclosed), ...enabled].map(String)).size,
    text,
  };
}

module.exports = {
  CORE_SKILL_IDS,
  AUTO_DISCLOSE_TOP,
  NAME_MAX,
  DEFAULT_MAX_DESC_CHARS,
  MATCH_RENDER_MAX,
  NGRAM_MIN,
  NGRAM_MAX,
  REFER_LIMIT,
  SCORE_ID,
  SCORE_NAME,
  SCORE_TEXT,
  isLazyEnabled,
  // 2026-11-11：开关的**生产者**。导出给 backend 用，也给门禁真跑四种优先级组合。
  resolveLazySwitch,
  splitTools,
  buildTurnTools,
  turnToolsFor,
  skillBriefs,
  matchSkills,
  matchSkillsDetailed,
  gramsOf,
  referencedBy,
  idBoundaryPattern,
  tokenizeQuery,
  parseEnableList,
  renderFindSkillsText,
  planFindSkills,
};
