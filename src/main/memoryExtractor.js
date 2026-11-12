'use strict';
/**
 * 豆芽记忆 2.0 · 抽取器 Extractor（A 阶段 #244 之一）
 * ============================================================================
 * 设计总纲：记住「你是谁」，而不只是记住「你说过什么」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 本模块的**唯一职责**：从对话文本里**提议**候选记忆。
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 它**没有写权限**，也**不知道档案长什么样** —— 这是老板钉扎第二条的落实点：
 *        「Extract 和 Write 必须彻底分开 …… 做成**真实权限边界**，而不是函数命名」
 *
 *    权限边界怎么体现（不是靠函数名叫 extract 就完了）：
 *      · 本模块**不 require memoryStore**，拿不到任何写函数 ⇒ 结构上写不了档案
 *      · 返回值是**纯候选数组**，字段与档案 schema 只共享 key/value 两个
 *      · 候选要变成档案，必须经过 Secret 硬门 → Reconciler → memoryStore，
 *        这三步都在**别的模块**里。本模块无从绕过。
 *    ⇒ 抽取器有 bug 的最坏后果是「产出垃圾候选」或「漏抽」，
 *      **不可能**直接污染 identity/orgs/prefs/projects。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么用规则而不是 LLM（2026-10-05 拍板）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 零成本、零延迟 ⇒ 不需要为"旁路"再引入一个可能挂住的依赖（R5 天然满足）
 *   · **完全可确定性测试** ⇒ 门禁可以精确断言"这句话该抽出什么、不该抽什么"
 *   · 覆盖面窄是已知代价：只抓**显式自我介绍类**表述，隐含偏好留给后续版本
 *   LLM 抽取的成本/延迟/降级**未评估**，明确不在本轮范围。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 三条硬纪律
 * ────────────────────────────────────────────────────────────────────────────
 * ① **无 quote 不产出**（G3 出处守卫的源头）：每条候选必须带"用户原话"。
 *    为什么在抽取层就卡死：Reconciler 再拦是第二道防线，但如果抽取器能产出无出处候选，
 *    下游一旦漏判就直接落盘 ⇒ 「记忆可以更新，但不能无证据漂移」在源头就被破了。
 *
 * ② **抽取器不做价值判断**：不决定"该不该记"、不做冲突处理、不合并。
 *    它只回答"这句话里有没有可记的事实"。判断留给 Reconciler。
 *    这样职责单一 ⇒ 出问题能精确定位到"抽错了"还是"判错了"。
 *
 * ③ **绝不抛**：任何输入（null / 非字符串 / 超大文本）都必须返回数组。
 */

// ============================================================================
// 1. 层与来源常量
// ============================================================================

/**
 * 「这段 role:'user' 文本其实是我们自己注入的系统提示」的判据 —— **向 intentGate 借，不在这里另写**。
 *
 * 为什么允许 require 它（本模块的"权限边界"讲的是**不 require memoryStore**，不是"零依赖"）：
 *   · `intentGate.js` 是**纯函数、零依赖**的判定模块，require 它拿不到任何写盘能力，
 *     不破坏"抽取器结构上写不了档案"这条边界；
 *   · 前缀判据必须**全仓只有一条**：`lastRealUserText` 与这里若各写一份，
 *     注入文案改一次标点就会出现"意图判定认得、记忆抽取不认得"的分裂 ——
 *     那正是 2026-02-16 独立验收实测出的身份档案被污染事故的成因。
 */
const { isSystemInjectedText } = require('./intentGate');

/** 与 memoryStore 的层名保持一致（此处**复制常量而非 import**，见模块头「权限边界」）。 */
const LAYER = Object.freeze({
  IDENTITY: 'identity',
  ORGS: 'orgs',
  PREFS: 'prefs',
  PROJECTS: 'projects',
});

/**
 * 来源标签。规则抽取器抓到的都是**用户显式表述** ⇒ 一律 explicit_user。
 * 为什么不给规则命中打低分："我叫潘一琪"是用户自述，它就是高置信事实，
 * 不是推测。confidence 的差别留给以后的 LLM 抽取（inferred ≤ 0.40）。
 */
const SOURCE_EXPLICIT_USER = 'explicit_user';

/** 各类规则的置信度基线（显式自述统一很高；带歧义的略低）。 */
const CONF = Object.freeze({
  NAME: 0.98,        // 「我叫 X」
  CITY: 0.90,        // 「我在 X」（可能指常住/当前工作地，略低）
  ORG: 0.92,         // 「我在 X 公司/集团」
  ROLE: 0.90,        // 「我是 X 的 Y」
  EMAIL: 0.95,       // 「我邮箱是 X」
  PREF: 0.85,        // 「我喜欢/我习惯/不要用 X」
  PROJECT: 0.80,     // 「我正在做 X」（最容易过期，置信度最低）
});

const VALUE_MAX = 200;
const QUOTE_MAX = 200;

// ============================================================================
// 2. 小工具
// ============================================================================

/** 单行化 + 截断（与 memoryStore.clip 同语义，此处自足实现以保持零依赖）。 */
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 去掉值首尾可能粘上的标点/助词（「我叫潘一琪。」⇒「潘一琪」）。 */
function trimValue(v) {
  return String(v == null ? '' : v)
    .replace(/^[\s「『"'\u3000]+/, '')
    .replace(/[\s」』"'\u3000。，,．.!！?？;；:：、]+$/, '')
    .trim();
}

/**
 * 值是否"看起来像个人名/地名/组织名"。
 *
 * ⚠️ 为什么需要这层筛：规则抽取最大的风险是**误抽**。
 *   「我叫你别这么做」会被 `我叫(.+)` 匹配到 `你别这么做` —— 必须挡掉。
 *   判据刻意保守：长度 1~20，且**不含**明显是句子成分的词。
 *   ⚠️ 诚实边界：规则永远抓不全，这里只保证"抓到的像样"，不保证"像样的都抓到"。
 */
function looksLikeEntity(v) {
  const t = String(v || '').trim();
  if (!t) return false;
  if (t.length > 20) return false;
  // 含这些词 ⇒ 几乎肯定不是名字/地名，而是半句话
  if (/[别不没是要会能想该去的了吗呢吧啊哦呀嗯]/.test(t) && t.length > 4) return false;
  if (/[，,。.!！?？;；:：、]/.test(t)) return false;
  return true;
}

/** 从整段文本里定位命中的原话句子（截断到 QUOTE_MAX）。 */
function quoteOf(text, index, matchLen) {
  const t = String(text || '');
  const start = Math.max(0, t.lastIndexOf('\n', index) + 1);
  let end = t.indexOf('\n', index);
  if (end === -1) end = t.length;
  const line = t.slice(start, end).trim();
  if (line) return clip(line, QUOTE_MAX);
  return clip(t.slice(index, index + Math.max(matchLen, 40)), QUOTE_MAX);
}

/** 构造一条候选。**quote 为空 ⇒ 返回 null**（G3 在源头执行）。 */
function candidate(layer, key, value, confidence, quote) {
  const q = clip(quote, QUOTE_MAX);
  if (!q) return null;                       // ★ 无出处不产出，永不例外
  const v = trimValue(value);
  if (!v) return null;                       // 空值无意义
  return {
    layer,
    key,
    value: clip(v, VALUE_MAX),
    source: SOURCE_EXPLICIT_USER,
    confidence,
    quote: q,
  };
}

// ============================================================================
// 3. 规则表
// ============================================================================

/**
 * 角色词表（**单一来源**）。
 *
 * ⚠️ 为什么抽成常量而不是在两处各写一份字面量：
 *   已经有三条规则都要认角色（`role` / `org_of_role` / `org_do_role`）。
 *   词表复制三份 ⇒ 下次加一个"牙科咨询师"就得记得改三处，
 *   而**漏改一处不会报错**，只会表现为"某个句式抓不到"（静默漏抽，最难发现的那种）。
 *   ⇒ 单一来源 + 用 RegExp 拼装。
 */
const ROLE_WORDS_SRC = 'PM|CTO|CEO|CFO|COO|CIO|产品经理|项目经理|技术负责人|架构师|工程师'
  + '|设计师|运营|市场|销售|总监|经理|主管|负责人|老板|创始人|合伙人|法人|总经理';

const ROLE_WORDS_RE = new RegExp('(' + ROLE_WORDS_SRC + ')');

/**
 * 每条规则：正则 + 取哪一组 + 生成哪个 key。
 *
 * ⚠️ 规则顺序**有意义**：`order` 用于稳定输出（同一条消息里多条规则命中时按此排序），
 *    避免"同样的输入两次跑出不同顺序"⇒ 测试不可复现。
 */
const RULES = [
  // ── identity ──────────────────────────────────────────────────────────
  {
    id: 'name',
    order: 10,
    layer: LAYER.IDENTITY,
    key: 'user.name',
    confidence: CONF.NAME,
    re: /(?:^|[，,。.！!？?\s])(?:我叫|我的名字是|我的名字叫|我是)\s*([^\s，,。.！!？?；;：:、]{1,20})/g,
    guard: (m) => looksLikeEntity(m[1]),
    // 「我是康健苗苗的PM」不该抽成名字 ⇒ 由 guard + 后续 rule 的 key 区分
    make: (m, q) => candidate(LAYER.IDENTITY, 'user.name', m[1], CONF.NAME, q),
  },
  {
    id: 'email',
    order: 20,
    layer: LAYER.IDENTITY,
    key: 'user.email',
    confidence: CONF.EMAIL,
    re: /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    guard: () => true,
    make: (m, q) => candidate(LAYER.IDENTITY, 'user.email', m[1], CONF.EMAIL, q),
  },
  {
    id: 'city',
    order: 30,
    layer: LAYER.IDENTITY,
    key: 'user.city',
    confidence: CONF.CITY,
    re: /(?:^|[，,。.！!？?\s])(?:我家在|我住在|我常住|我人在|我在)\s*([^\s，,。.！!？?；;：:、]{1,20})/g,
    guard: (m) => looksLikeEntity(m[1]) && /市|区|县|杭州|北京|上海|深圳|广州|成都|南京|苏州|武汉|西安|重庆|天津|宁波|厦门|长沙|青岛|济南|合肥|福州|郑州|昆明|大连|无锡|佛山|东莞/.test(m[1]),
    make: (m, q) => candidate(LAYER.IDENTITY, 'user.city', m[1], CONF.CITY, q),
  },

  // ── orgs ──────────────────────────────────────────────────────────────
  {
    id: 'org',
    order: 40,
    layer: LAYER.ORGS,
    key: 'org.current',
    confidence: CONF.ORG,
    re: /(?:^|[，,。.！!？?\s])(?:我在|我就职于|我任职于|我所在的?公司是|我们公司是)\s*([^\s，,。.！!？?；;：:、]{1,24}?)(?:公司|集团|上班|工作|做|$)/g,
    guard: (m) => looksLikeEntity(m[1]) && String(m[1]).length >= 2,
    make: (m, q) => candidate(LAYER.ORGS, 'org.current', m[1], CONF.ORG, q),
  },
  {
    id: 'role',
    order: 50,
    layer: LAYER.ORGS,
    key: 'org.role',
    confidence: CONF.ROLE,
    re: new RegExp('(?:我的?(?:职位|岗位|角色)是|我是(?:做|负责))([^\\s，,。.！!？?；;：:、]{2,20})', 'g'),
    guard: (m) => looksLikeEntity(m[1]),
    make: (m, q) => candidate(LAYER.ORGS, 'org.role', m[1], CONF.ROLE, q),
  },
  {
    // 「我在<组织>做<角色>」—— 与上一条同族，中文里另一种最常见的自我职位表述。
    // ⚠️ 为什么必须单独补（2026-10-05 端到端门禁 E6 抓到）：
    //   上面那条 org 规则 `(?:我在|…)(…)(?:公司|集团|上班|工作|做|$)` 只吃到了**组织**，
    //   尾部的 `做` 被当作终止符就丢了，**角色没人接** ⇒
    //   「我在康健苗苗做产品经理」只落一条 org.current，org.role 永远空。
    //   实测对比：
    //     「我是康健苗苗的产品经理」⇒ org.current + org.role（两条都对）
    //     「我在康健苗苗做产品经理」⇒ 只有 org.current（**角色漏抽**）
    //   两句表达的是同一个事实，漏抽一句就是**静默丢事实**（不报错、只表现为"豆芽不记得我是干嘛的"）。
    //   ⇒ 补上，并复用同一份角色词表（ROLE_WORDS），避免两处词表漂移。
    id: 'org_do_role',
    order: 46,
    layer: LAYER.ORGS,
    key: 'org.role',
    confidence: CONF.ROLE,
    re: new RegExp(
      '(?:我在|我在|我就职于|我任职于)([^\\s，,。.！!？?；;：:、]{2,20}?)(?:公司|集团)?'
      + '(?:做|当|担任|干|负责)(' + ROLE_WORDS_SRC + ')', 'g'),
    guard: (m) => String(m[1]).length >= 2 && String(m[2]).length >= 1,
    make: (m, q) => [
      candidate(LAYER.ORGS, 'org.current', m[1], CONF.ORG, q),
      candidate(LAYER.ORGS, 'org.role', m[2], CONF.ROLE, q),
    ].filter(Boolean),
  },
  {
    // 「我是<组织>的<角色>」—— 中文里最常见的自我职位表述之一。
    // ⚠️ 为什么单列一条而不是塞进 role：
    //   实测「我是康健苗苗的PM」被 name 规则以 `我是(.+)` **贪婪吃掉**（抓到「康健苗苗的PM」，
    //   虽被 guard 挡掉，但也没人接住它）⇒ 整句零候选。这是抽取**漏抽**的真实形态：
    //   不是"抓错了"，而是"该抓的没抓到"，而漏抽**不会报错**，只能靠用例发现。
    //   这条规则要求同时给出组织与角色，命中即产出**两条**（org.current + org.role）。
    // 说明：make 返回数组，主循环会展开（见 extractFromText）。
    id: 'org_of_role',
    order: 45,
    layer: LAYER.ORGS,
    key: 'org.role',
    confidence: CONF.ROLE,
    re: new RegExp(
      '我是([^\\s，,。.！!？?；;：:、]{2,20}?)的(' + ROLE_WORDS_SRC + ')', 'g'),
    guard: (m) => String(m[1]).length >= 2 && String(m[2]).length >= 1,
    make: (m, q) => [
      candidate(LAYER.ORGS, 'org.current', m[1], CONF.ORG, q),
      candidate(LAYER.ORGS, 'org.role', m[2], CONF.ROLE, q),
    ].filter(Boolean),
  },

  // ── prefs ─────────────────────────────────────────────────────────────
  {
    id: 'pref_like',
    order: 60,
    layer: LAYER.PREFS,
    key: 'pref.like',
    confidence: CONF.PREF,
    re: /(?:^|[，,。.！!？?\s])(?:我喜欢|我偏好|我习惯|我倾向于|我一般用)\s*([^\n，,。！？!?；;、]{2,40})/g,
    guard: (m) => trimValue(m[1]).length >= 2,
    make: (m, q) => candidate(LAYER.PREFS, 'pref.like', m[1], CONF.PREF, q),
  },
  {
    id: 'pref_avoid',
    order: 61,
    layer: LAYER.PREFS,
    key: 'pref.avoid',
    confidence: CONF.PREF,
    re: /(?:^|[，,。.！!？?\s])(?:不要用|别用|我不喜欢|我讨厌|禁用|避免用)\s*([^\n，,。！？!?；;、]{2,40})/g,
    guard: (m) => trimValue(m[1]).length >= 2,
    make: (m, q) => candidate(LAYER.PREFS, 'pref.avoid', m[1], CONF.PREF, q),
  },
  {
    id: 'pref_lang',
    order: 62,
    layer: LAYER.PREFS,
    key: 'pref.language',
    confidence: 0.95,
    re: /(?:以后|请|要)?(?:用|讲|说)\s*(中文|简体中文|繁体中文|英文|英语|日文|日语)\s*(?:回[答复]|交流|沟通)/g,
    guard: () => true,
    make: (m, q) => candidate(LAYER.PREFS, 'pref.language', m[1], 0.95, q),
  },

  // ── projects ──────────────────────────────────────────────────────────
  {
    id: 'project',
    order: 70,
    layer: LAYER.PROJECTS,
    key: 'project.current',
    confidence: CONF.PROJECT,
    re: /(?:^|[，,。.！!？?\s])(?:我正在做|我在做|我最近在|我目前在|这个项目是)\s*([^\n，,。！？!?；;、]{2,40})/g,
    guard: (m) => trimValue(m[1]).length >= 2,
    make: (m, q) => candidate(LAYER.PROJECTS, 'project.current', m[1], CONF.PROJECT, q),
  },
];

// ============================================================================
// 4. 主入口
// ============================================================================

/**
 * 从一段文本里抽取候选记忆。
 *
 * @param {string} text 用户原始消息（单条）
 * @param {{maxCandidates?:number, maxTextLen?:number}} [opts]
 * @returns {Array<{layer,key,value,source,confidence,quote}>} 候选数组（可能为空）
 *          —— **永不抛**；任何异常都退化为返回已抽到的部分或空数组。
 */
function extractFromText(text, opts) {
  const o = opts || {};
  const maxCandidates = Number.isFinite(Number(o.maxCandidates)) ? Number(o.maxCandidates) : 20;
  const maxTextLen = Number.isFinite(Number(o.maxTextLen)) ? Number(o.maxTextLen) : 20000;

  const out = [];
  try {
    if (typeof text !== 'string' || !text.trim()) return out;
    const t = text.length > maxTextLen ? text.slice(0, maxTextLen) : text;

    const hits = [];
    for (const rule of RULES) {
      // 每条规则独立 try：一条规则写坏了不该让整轮抽取归零
      try {
        const re = new RegExp(rule.re.source, rule.re.flags);
        let m;
        let guardCount = 0;
        while ((m = re.exec(t)) !== null) {
          guardCount += 1;
          if (guardCount > 200) break;                 // 防病态输入导致死循环
          if (m.index === re.lastIndex) re.lastIndex += 1;   // 防零宽匹配死循环
          if (typeof rule.guard === 'function' && !rule.guard(m)) continue;
          const made = rule.make(m, quoteOf(t, m.index, m[0].length));
          // make 允许返回单条、数组（一条规则产出多个事实）或 null。
          // 数组形态主要用于「我是X的Y」这类一句话含两个事实的表述。
          if (Array.isArray(made)) {
            for (const one of made) if (one) hits.push({ order: rule.order, ruleId: rule.id, c: one });
          } else if (made) {
            hits.push({ order: rule.order, ruleId: rule.id, c: made });
          }
        }
      } catch {
        // 单条规则异常：跳过该规则，其余规则继续
      }
    }

    // 稳定排序：先按规则 order，再按出现位置（此处位置信息已丢失，用插入序兜底）
    hits.sort((a, b) => (a.order - b.order));
    for (const h of hits) {
      if (out.length >= maxCandidates) break;
      out.push(h.c);
    }
    // ★★ 必须去重（2026-10-05 端到端门禁抓到）。
    //   为什么：多条规则会命中**同一个事实**。最典型的是
    //     「我在康健苗苗做产品经理」同时被 org（只吃组织）和 org_do_role（组织+角色）命中
    //   ⇒ 产出两条一模一样的 `org.current = 康健苗苗`。
    //   不去重的后果不是报错，而是下游 Reconciler 把第二条判成 **CONFIRM**
    //   ⇒ 用户**随口说的一句话被算成"说了两次"**（confirmedCount 虚增）。
    //   而 confirmedCount 是"越用越确信"的计量单位 ⇒ 虚增就直接污染了可信度排序。
    //   ⚠️ 更早的教训：`dedupeCandidates` 早就写好了、也导出了，但**从来没人调用它**
    //   ——「写了 ≠ 接线」，函数存在不等于行为存在。
    return dedupeCandidates(out);
  } catch {
    return out;      // ★ 永不抛
  }
}

/**
 * 从会话消息数组里抽取（只取**用户**消息 —— 助手说的话不是关于用户的事实）。
 *
 * @param {Array<{role?:string, content?:string}>} messages
 * @returns {Array} 合并去重后的候选
 */
function extractFromMessages(messages) {
  const out = [];
  try {
    const list = Array.isArray(messages) ? messages : [];
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      // 只看用户消息。助手说自己"我叫豆芽"跟用户身份无关，抽出来就是污染。
      if (m.role && m.role !== 'user') continue;
      // ★★ 2026-02-16（独立验收实测出的真实事故）：**系统注入的提示不是用户说的话**。
      //   聊天循环里有若干处注入走的是 `role:'user'` +「（系统提示：…」这一形态
      //   （replan 训话 / 收尾要求 / 第二执行实例的结论回灌）。原来这里**只按 role 过滤**
      //   ⇒ 注入正文里的任何句子都会被当成"用户亲口说的事实"抽进档案：
      //   实测把第二实例自己编的「我的名字叫小豆」抽成 `identity/user.name = 小豆`,
      //   confidence 0.98，`source=explicit_user` —— **模型生成的任意文本可以写进用户身份档案**。
      //   判据**不在这里另写一条前缀规则**：复用 `intentGate.isSystemInjectedText`
      //   （`lastRealUserText` 用的同一条），前缀文案将来再改标点也只有一处要改。
      if (isSystemInjectedText(m.content)) continue;
      const c = extractFromText(m.content);
      for (const x of c) out.push(x);
    }
  } catch {
    return out;
  }
  // ★ 跨消息同样要去重（同一句话在历史里出现多次是常态：
  //   「我叫潘一琪」此前提过、这轮又提 ⇒ 不该产出两条候选——
  //   那是"用户提了两次"（该由 Reconciler 判 CONFIRM）而不是"一句话里说了两遍"）。
  return dedupeCandidates(out);
}

/**
 * 按 (layer,key,value) 去重（保留首个）。
 * ⚠️ 这里只做**机械去重**，不做价值判断 —— 该不该记是 Reconciler 的事。
 */
function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || typeof c !== 'object') continue;
    const sig = String(c.layer) + '|' + String(c.key) + '|' + String(c.value);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  return out;
}

module.exports = {
  LAYER,
  SOURCE_EXPLICIT_USER,
  CONF,
  RULES,
  extractFromText,
  extractFromMessages,
  dedupeCandidates,
  // 供门禁定点验证
  clip,
  trimValue,
  looksLikeEntity,
  quoteOf,
  // ★ 导出 candidate 的唯一理由：它是 G3 源头守卫（"无 quote 不产出"）的**载体**。
  //   不导出 ⇒ 门禁只能从 extractFromText 外部观察，而所有规则都走 quoteOf（恒非空）
  //   ⇒ "quote 为空"这条路径**永远喂不进** ⇒ 守卫删掉了也没人发现（2026-10-05 实测：
  //   变异 M1 删掉 `if (!q) return null;` 后门禁**全绿**）。导出后才能定点断言。
  candidate,
};
