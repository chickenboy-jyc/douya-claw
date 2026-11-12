/**
 * mindmapAI —— 思维导图的四条 AI 通路（生成 / 展开 / 按框架重构 / 润色）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么 `chat` 是参数而不是直接 import 着用】
 *   单测必须能跑，且**不许真花钱调模型**。把出口做成可注入的参数，
 *   测试传一个返回固定字符串的假函数就能覆盖全部归一/容错分支；
 *   生产路径用默认值（真 `chatOnce`），调用方一个字都不多写。
 *
 * 【为什么解析用 `extractJSON` 而不自己写】
 *   模型返回带 ```json 围栏、前后带"好的，以下是……"是本仓每天都在发生的事。
 *   `projectAI.js` 的 `extractJSON` 已经把"围栏 + 前后废话 + 字符串里的花括号"处理过了，
 *   再写一份的结果是两处容错能力慢慢分叉 —— 一处能吃下的输出另一处吃不下。
 *
 * 【为什么归一这么啰嗦（cleanText / 整枝丢弃 / 截断 / 少于 2 个节点算失败）】
 *   模型最常见的三种坏产出：整段"暂无"、把 `children` 写成 `null`、一口气给 200 个节点。
 *   这三种如果直接进模型层，界面上的表现是"点了生成，导图空白/卡住"，没人知道为什么。
 *   所以这里把它们变成**一句人话的失败**（或一次温和的截断），而不是一个空白画布。
 *   失败时原始输出留在 `raw` 里给排查用，但**绝不放进给用户看的 error**（可能几千字）。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { chatOnce } from '../api.js';
// 解析器全仓唯一一份，见本文件头注释
import { extractJSON } from './projectAI.js';
import { MM_LIMITS, addChild, cleanNodeText, createDoc, indexDoc, outlineText } from './mindmapModel.js';

const defaultChat = (messages, context, opts) => chatOnce(messages, context, opts);

/** 结构化重构可选的四套框架。key 落库，label 给界面，desc 给用户看"这套框架在问什么"。 */
export const MM_AI_FRAMEWORKS = [
  { key: '5w2h', label: '5W2H', desc: '把一件事拆成 What/Why/Who/When/Where/How/How much 七个必答项' },
  { key: 'mckinsey7s', label: '麦肯锡 7S', desc: '战略、结构、制度、人员、技能、风格、共同价值观' },
  { key: 'pdca', label: 'PDCA', desc: '计划 → 执行 → 检查 → 处理，做成一个能转起来的循环' },
  { key: 'scqa', label: 'SCQA', desc: '情境 → 冲突 → 问题 → 答案，适合汇报与提案' },
];

/** 整句就等于"没数据"的取值。宁可判空（不渲染），也不要让"暂无"变成导图上的一个节点。 */
const NO_DATA_EXACT = /^(暂无|未查到|无|—|–|-|n\/a|na|待补充)$/i;
const PUNCT_RE = /[\s，。、；：,.;:（）()【】\[\]《》"'!！?？\-—~/|]/g;

/**
 * 模型输出 → 可用的节点文字。空字符串代表"这一枝不要"。
 * 与 `MarketMomentum.jsx` 的 `cleanValue` 同口径，额外多一步：按 maxTextLen 截断。
 */
export function cleanText(v) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (NO_DATA_EXACT.test(t)) return '';
  if (t.replace(PUNCT_RE, '').length < 1) return '';
  return cleanNodeText(t);
}

/** 数字参数钳位（模型/界面都可能传怪值）。 */
function intIn(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 把模型给的树递归归一成 `[{text, children}]`。
 * 预算 `budget.left` 是全局节点数上限 —— 递归里每收一个减一，所以
 * "超 maxNodes 就截断"是沿着 DFS 顺序温柔截断，不是整批报错。
 */
function normTree(input, depth, budget) {
  if (!Array.isArray(input) || budget.left <= 0 || depth > MM_LIMITS.maxDepth) return [];
  const out = [];
  for (const item of input) {
    if (budget.left <= 0) break;
    const node = typeof item === 'string' ? { text: item } : item;
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const text = cleanText(node.text != null ? node.text : node.title != null ? node.title : node.name);
    if (!text) continue; // 空的整枝丢弃（含它的子孙）
    budget.left -= 1;
    out.push({ text, children: normTree(node.children, depth + 1, budget) });
  }
  return out;
}

/**
 * 中间树 → 合法 Doc。走 `addChild` 是为了让限额（节点数/深度/一级分支数）
 * **只有一处实现**：AI 产物和手工新增受同一套约束，不会出现"AI 能建出 40 条一级分支、
 * 用户自己点却建不出"的怪状态。
 */
function buildDoc(title, tree) {
  let doc = createDoc(title);
  const walk = (parentId, items) => {
    for (const it of items) {
      const r = addChild(doc, parentId, it.text);
      if (!r.ok) continue; // 超限就停在这一枝（截断，不报错）
      doc = r.doc;
      walk(r.nodeId, it.children);
    }
  };
  walk(doc.rootId, tree);
  return doc;
}

/**
 * 统一的"模型没给出可用结构"文案。四处共用一句，用户看到的口径就一致。
 *
 * 措辞刻意**不写"AI 没产出分支"**：这句话甩锅味重，而且四条通路的真实原因各不相同
 * （主题太宽、内容太少、节点太短、模型给了空数组）—— 一句共用文案没有资格断言原因，
 * 说错一次就是把用户往错的修法上引。所以只说用户能验证的事实（没拿到条目）
 * 和唯一的下一步（改输入再试）。
 */
const NO_BRANCHES = '这次没拿到可用条目：AI 返回的内容里拆不出分支。换个说法，或补一句你自己的思路再试。';

/**
 * 「这个节点已经够具体，不用再展开」这句结论的**最短信任长度**（字）。
 *
 * 为什么模型说了不算，还要拿字长去否决它：`children: null` 有两类成因，形状完全一样 ——
 *   ① 真的够具体（节点已经是"周三下午在公众号发种植牙科普"这种可执行描述）；
 *   ② 模型偷懒（用户点扩散，它嫌麻烦，回一句"已经够具体了"是最省力的答案）。
 * 4 个字的节点（「招商」「拓客」）不可能属于 ①，它只是**还没有内容**。
 * 用节点的客观属性去否决模型的主观结论，比猜它有没有偷懒可靠得多。
 * 误伤方向也是对的：让用户把节点写具体，而不是告诉他"已经够好"、他对着空气再点一次。
 */
const MM_MIN_EXPAND_LEN = 6;

/** 统一调用壳：把"调不通 / 返回非 JSON"这两类失败收成同一个形状，且永不 throw。 */
async function callJSON(chat, prompt, context, opts) {
  let res;
  try {
    res = await chat([{ role: 'user', content: prompt }], context, opts);
  } catch (e) {
    return { ok: false, error: 'AI 调用失败' + (e && e.message ? '：' + e.message : '') };
  }
  if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'AI 调用失败' };
  if (!res.content) return { ok: false, error: 'AI 未返回内容' };
  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'AI 返回的内容不是可解析的 JSON，再试一次。', raw: String(res.content) };
  }
  return { ok: true, parsed, raw: String(res.content) };
}

// ══════════════════════════════════════════════════════════════════════════
// ① 从一句话主题生成整棵树
// ══════════════════════════════════════════════════════════════════════════
export async function aiGenerateTree({ chat = defaultChat, topic, branchCount = 4, context = null } = {}) {
  try {
    const t = cleanText(topic);
    if (!t) return { ok: false, error: '先写一个主题再来生成。' };
    const n = intIn(branchCount, 2, MM_LIMITS.maxBranches, 4);
    const prompt = [
      '你是口腔门诊的经营顾问，现在要把用户给的一个主题拆成一张思维导图。',
      `主题：${t}`,
      `一级分支数量：${n} 条左右（可以有 1-2 条浮动）。`,
      '每个一级分支下面给 2-4 个二级要点；确有必要的二级要点下面再给 1-3 个三级要点，最多到三级。',
      '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
      '{ "title": "导图标题（不超过 18 字）", "branches": [ { "text": "一级分支", "children": [ { "text": "二级要点", "children": [ { "text": "三级要点" } ] } ] } ] }',
      '硬约束：',
      '1. 每个节点的文字不超过 18 个字，写短句不写段落。',
      '2. 分支之间不许重复、不许同义换词凑数。',
      '3. 不许编造事实：不知道的数字、机构名、政策条款一律不写，宁可写得概括。',
      '4. 节点文字里不要出现序号前缀（不要"1."、"①"、"一、"）。',
      '5. 如果这个主题太空泛、拆不出有意义的分支，直接返回 {"branches": null}，不要硬凑。',
    ].join('\n');

    const r = await callJSON(chat, prompt, context, { temperature: 0.5 });
    if (!r.ok) return r;
    const parsed = r.parsed;
    if (parsed.branches === null) {
      // 不写"AI 认为…"：判断是模型下的，但**后果是用户的输入造成的**，文案要指到他能改的地方。
      return { ok: false, error: '这个主题太宽泛，展开不出有意义的分支。写具体一点再试。' };
    }
    const budget = { left: MM_LIMITS.maxNodes - 1 }; // 根占掉 1 个名额
    const tree = normTree(parsed.branches, 1, budget);
    const title = cleanText(parsed.title) || t;
    const doc = buildDoc(title, tree);
    if (doc.nodes.length < 2) return { ok: false, error: NO_BRANCHES, raw: r.raw };
    return { ok: true, doc, title: doc.title, count: doc.nodes.length };
  } catch (e) {
    return { ok: false, error: 'AI 生成失败' + (e && e.message ? '：' + e.message : '') };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ② 给某个节点补子节点
// ══════════════════════════════════════════════════════════════════════════
/**
 * 扩散一个节点。**三态**，与 `aiPolishNode` 同口径：
 *   ① `{ok:true, changed:true,  doc, nodeIds, count}`            —— 补上了
 *   ② `{ok:true, changed:false, unchanged:true, note}`           —— 这个节点已经够具体（**正常结论**）
 *   ③ `{ok:false, error}`                                        —— 真失败（含"节点太短，判不了"）
 *
 * 为什么 ② 是结论而不是失败：「不该再往下展开」本身是有信息量的判断；只报红的话，
 * 用户会以为是自己点错了按钮或功能坏了，而中性提示是在**告诉他判断依据**。
 *
 * 为什么 ② 的 `doc` 省略、而 ① 必须有：② 里文档一个字都没变，给出去只会被写回一遍，
 * 在撤销栈上留下一个空动作。调用方**先看 `changed`，再看 `doc`**。
 *
 * @returns {Promise<
 *   {ok:true, doc:object, nodeIds:string[], count:number, changed:true}
 * | {ok:true, nodeIds:[], count:0, changed:false, unchanged:true, note:string}
 * | {ok:false, error:string, raw?:string}>}
 */
export async function aiExpandNode({ chat = defaultChat, doc, nodeId, hint = '', childCount = 4, context = null } = {}) {
  try {
    const idx = indexDoc(doc);
    const node = idx.byId.get(nodeId);
    if (!node) return { ok: false, error: '找不到要展开的节点。' };
    const depth = idx.depthOf.get(nodeId) || 0;
    if (depth + 1 > MM_LIMITS.maxDepth) {
      return { ok: false, error: `最多 ${MM_LIMITS.maxDepth} 层，这个节点已经到底了。` };
    }
    if (doc.nodes.length >= MM_LIMITS.maxNodes) {
      return { ok: false, error: `一张图最多 ${MM_LIMITS.maxNodes} 个节点，先删掉一些再展开。` };
    }
    const n = intIn(childCount, 2, MM_LIMITS.maxBranches, 4);
    const prompt = [
      '你是口腔门诊的经营顾问，现在要给思维导图里的一个节点补下一层子节点。',
      `整张图的大纲（缩进表示层级）：\n${outlineText(doc)}`,
      `要展开的节点：「${node.text}」`,
      hint ? `用户对这次展开的额外要求：${cleanText(hint) || hint}` : '用户没有额外要求。',
      `请给出 ${n} 条左右子节点，每条下面可以再带 1-2 条下一层，最多两层。`,
      '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
      '{ "children": [ { "text": "子节点", "children": [ { "text": "再下一层" } ] } ] }',
      '硬约束：',
      '1. 每个节点的文字不超过 18 个字。',
      '2. 只能顺着「' + node.text + '」往下想，不要跳到别的分支上去。',
      '3. 与大纲里已有的内容重复的，不要再给。',
      '4. 不许编造事实：没有依据的数字和机构名一律不写。',
      // 第 5 条必须和代码里的 `MM_MIN_EXPAND_LEN` 闸门写成**同一句话**：
      // 只写"够具体就返回 null"、代码却按字长否决，就成了"prompt 邀请、代码判罚"——
      // 润色那条已经踩过（模型 3/3 照做、被判失败）。所以把闸门条件提前告诉模型。
      `5. 只有「${node.text}」已经足够具体（写清了做什么、给谁做、怎么做）时，才返回 {"children": null}；`
        + `它很短（不到 ${MM_MIN_EXPAND_LEN} 个字）时不要用这个回答，那说明它还没有内容，请给出具体子节点。`,
    ].join('\n');

    const r = await callJSON(chat, prompt, context, { temperature: 0.5 });
    if (!r.ok) return r;
    const parsed = r.parsed;
    if (parsed.children === null) {
      /**
       * 三态的第二态：**模型说这个节点已经够具体**。
       *
       * 这与润色是同一个病：prompt 第 5 条主动邀请它「再往下只会重复就返回 null」，
       * 它照做了，旧代码却判 `ok:false` —— 界面报红，用户以为自己点错了功能。
       * 但这里多一层风险：`null` 也可能是模型偷懒（见 `MM_MIN_EXPAND_LEN` 注释），
       * 所以先过字长闸门，闸门不过就仍是**真失败**、并告诉用户该改什么。
       *
       * ② 态**不带 `doc`**：文档一个字都没变，带出去只会在撤销栈上多一个空动作，
       * 也会让"没改"看起来像"改了"。UI 必须先看 `changed`，不许先看 `doc`。
       */
      if (cleanNodeText(node.text).length < MM_MIN_EXPAND_LEN) {
        return {
          ok: false,
          error: `这个节点太短，AI 判断不了该往哪展开 —— 先把它写具体一点（至少 ${MM_MIN_EXPAND_LEN} 个字）。`,
          raw: r.raw,
        };
      }
      return {
        ok: true,
        nodeIds: [],
        count: 0,
        changed: false,
        unchanged: true,
        note: '这个节点已经够具体了，不用再展开。',
      };
    }
    const budget = { left: MM_LIMITS.maxNodes - doc.nodes.length };
    const tree = normTree(parsed.children != null ? parsed.children : parsed.branches, 1, budget);
    if (!tree.length) return { ok: false, error: NO_BRANCHES, raw: r.raw };

    let out = doc;
    const nodeIds = [];
    const walk = (parentId, items) => {
      for (const it of items) {
        const added = addChild(out, parentId, it.text);
        if (!added.ok) continue;
        out = added.doc;
        nodeIds.push(added.nodeId);
        walk(added.nodeId, it.children);
      }
    };
    walk(nodeId, tree);
    if (!nodeIds.length) return { ok: false, error: NO_BRANCHES, raw: r.raw };
    // `changed` 与润色同口径：**始终存在**，不留给 UI 用"有没有 doc"去反推三态。
    return { ok: true, doc: out, nodeIds, count: nodeIds.length, changed: true };
  } catch (e) {
    return { ok: false, error: 'AI 展开失败' + (e && e.message ? '：' + e.message : '') };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 换一套框架重排整张图
// ══════════════════════════════════════════════════════════════════════════
export async function aiRestructure({ chat = defaultChat, doc, frameworkKey, context = null } = {}) {
  try {
    const fw = MM_AI_FRAMEWORKS.find((f) => f.key === frameworkKey);
    if (!fw) return { ok: false, error: '不认识的框架，请从列表里选一个。' };
    const idx = indexDoc(doc);
    if (!idx.rootId) return { ok: false, error: '导图是空的，没有可重构的内容。' };
    const outline = outlineText(doc);
    if (!outline) return { ok: false, error: '导图是空的，没有可重构的内容。' };

    const prompt = [
      '你是口腔门诊的经营顾问，现在要用一套成熟框架把用户现有的思维导图重新组织一遍。',
      `框架：${fw.label} —— ${fw.desc}。`,
      `现有内容：\n${outline}`,
      '请保留原有内容里的**事实与意图**，只按框架重新分层归类；原有内容里没有的，不要凭空补。',
      '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
      '{ "title": "重构后的标题（不超过 18 字）", "branches": [ { "text": "框架的一个维度", "children": [ { "text": "归到这类的原内容" } ] } ] }',
      '硬约束：',
      '1. 一级分支必须就是这套框架的维度（' + fw.label + '），不要自创维度。',
      '2. 每个节点的文字不超过 18 个字。',
      '3. 原文里某条内容归不进任何维度时，宁可放进"其他"也不要硬塞。',
      '4. 不许编造事实：原文没有的数字、机构名、政策条款一律不写。',
      // 这一条是 team-lead 的产品判断，不是实验结论 —— 两者分开记：
      // · 产品理由（成立）：框架维度**天生重叠**（同一件事既可算 What 也可算 How much），
      //   所以必须显式要求"归到最贴切的那一处"，否则用户看到两份会当成 bug 来删。
      // · 实效（**未被证明**）：2026-11-02 用真模型 A/B，小输入 n=5、大输入 n=3，
      //   加与不加的重复组数差异全落在采样噪声里（小输入 0.20 vs 0.60、大输入 5.00 vs 2.33，
      //   方向相反、区间重叠）。⇒ 这条约束**不保证**能减少重复，它只表达意图。
      //   真要确定性去重只能在归一里删节点（会删模型产出），那是另一个产品决定。
      '5. 每一条内容只放在最贴切的一个维度下（框架维度之间会重叠，挑一处放，不要两边都抄一份）。',
      '6. 如果现有内容太少、不足以按这套框架重构，返回 {"branches": null}。',
    ].join('\n');

    const r = await callJSON(chat, prompt, context, { temperature: 0.3 });
    if (!r.ok) return r;
    const parsed = r.parsed;
    if (parsed.branches === null) {
      // 重构和扩散不同：这里失败用户**有明确下一步**（去补内容 / 换一套框架），所以仍是 ③，
      // 文案也只指行动，不解释"AI 怎么想的"。
      return { ok: false, error: '现有内容太少，这套框架重构不出东西来。先多写几条再试，或换一套框架。' };
    }
    const budget = { left: MM_LIMITS.maxNodes - 1 };
    const tree = normTree(parsed.branches, 1, budget);
    const fallbackTitle = cleanText(doc.title) || cleanText(idx.byId.get(idx.rootId).text) || '未命名导图';
    const title = cleanText(parsed.title) || fallbackTitle;
    const next = buildDoc(title, tree);
    if (next.nodes.length < 2) return { ok: false, error: NO_BRANCHES, raw: r.raw };
    return { ok: true, doc: next, title: next.title, count: next.nodes.length, framework: fw.key };
  } catch (e) {
    return { ok: false, error: 'AI 重构失败' + (e && e.message ? '：' + e.message : '') };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 润色一个节点的文字
// ══════════════════════════════════════════════════════════════════════════
/**
 * 润色。**三态**，不是成功/失败两态。
 *
 * 为什么必须有三态（真机实测逼出来的，不是设计洁癖）：
 *   prompt 第 4 条明确**邀请**模型「原文已经足够好就原样返回」。真模型三次都照做了，
 *   而旧代码把「原样返回」判成 `ok:false` —— **prompt 邀请了一个行为，代码把它判成失败**。
 *   用户看到的是「AI 这次没给出更好的写法」红字，但模型什么都没做错，是契约缺一态。
 *   「AI 认为已经够好」是**正常结论**，不是错误；它和「模型挂了/返回空」必须分开，
 *   否则 UI 只能二选一：要么把正常结论报成红字（吓用户），要么把真故障当成功（吞错）。
 *
 * `changed` **始终存在**（true/false）：UI 不许靠 `text === original` 自己猜，
 * 两边各算一次迟早不一致（比如原文字被 cleanText 规整过、或大小写/空白差异）。
 *
 * ② 里 `text` 仍然给 `original`，UI 不必为 null 做特判；② 里**不给 `raw`**
 * （原文就是这句话本身，带出去只会让 UI 以为要展示排查信息）。只有 ③ 才带 `raw`。
 *
 * @returns {Promise<
 *   {ok:true, text:string, original:string, changed:true}
 * | {ok:true, text:string, original:string, changed:false, unchanged:true, note:string}
 * | {ok:false, error:string, raw?:string}>}
 */
export async function aiPolishNode({ chat = defaultChat, doc, nodeId, context = null } = {}) {
  try {
    const idx = indexDoc(doc);
    const node = idx.byId.get(nodeId);
    if (!node) return { ok: false, error: '找不到要润色的节点。' };
    const original = cleanText(node.text);
    if (!original) return { ok: false, error: '这个节点还没有文字，先写点内容再润色。' };
    const siblings = (idx.childrenOf[node.parentId] || []).map((s) => s.text).filter((s) => s && s !== node.text);

    const prompt = [
      '你是中文写作编辑，现在要把思维导图里一个节点的文字改得更准确、更好读。',
      `这句话在导图里的位置：上级是「${(idx.byId.get(node.parentId) || {}).text || '（根）'}」。`,
      `原文：${original}`,
      siblings.length ? `与它并列的节点有：${siblings.join('、')}（不要和它们撞词）。` : '它没有并列节点。',
      '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
      '{ "text": "改写后的一句话" }',
      '硬约束：',
      '1. 不超过 18 个字，必须是一句话，不要拆成两句。',
      '2. 保持原意，不要新增事实、不要加油添醋，不许编造数字或机构名。',
      '3. 不要加序号前缀，不要加引号，不要在结尾加句号。',
      '4. 如果原文已经足够好、改不出更好的，原样返回同一句话即可。',
    ].join('\n');

    const r = await callJSON(chat, prompt, context, { temperature: 0.4 });
    if (!r.ok) return r;
    const next = cleanText(r.parsed.text);
    // ② 模型返回空 / 全是「暂无」被清空 ⇒ 这是**真失败**（它没按契约给 text），不是"够好了"。
    //    两者必须分开：一个让用户重试，一个让用户知道"不用改了"。
    if (!next) {
      return { ok: false, error: 'AI 这次没返回可用的文字，再试一次。', raw: r.raw };
    }
    // ② 模型说"原样就好" —— 这是被 prompt 邀请的合法结论，不是失败。
    if (next === original) {
      return {
        ok: true,
        text: original,
        original,
        changed: false,
        unchanged: true,
        note: 'AI 觉得这句已经够好了。',
      };
    }
    return { ok: true, text: next, original, changed: true };

  } catch (e) {
    return { ok: false, error: 'AI 润色失败' + (e && e.message ? '：' + e.message : '') };
  }
}
