/**
 * competitorSuggest —— 「AI 按企业资产库挑好竞品，用户打钩即可」的候选构建器（纯函数）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 一、老板原话与它对应的缺陷
 * ────────────────────────────────────────────────────────────────────────────
 *   「为什么竞品分析目前还是不准确？？有没有什么办法可以解决？首先 AI 不会自动帮我挑好竞品
 *     我要做成自动帮我挑好竞品 然后用户点打钩就行了 按照企业资产库来」
 *
 * 旧实现（CompetitorAnalysis.jsx 的 `autoAdopt` effect）只在**竞品名单为空**时自动采用
 * brain.competitors，而且采用后**直接写库**。两个后果：
 *   ① 名单非空（哪怕是错的、旧的）时，页面永远不会给出候选 —— 老板"AI 不会自动帮我挑"；
 *   ② 写库没有人工确认环节 —— 用户是在"AI 帮我挑"和"表已经被填了"之间失去控制感。
 *
 * 本模块只做一件事：把**已有的真实来源**整理成"可勾选候选"。它不发网络请求、不调模型、
 * 不写库 —— 写库只能由用户点「确认」触发（见 CompetitorAnalysis 的 `data-comp-pick` 面板）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 二、红线（违反即事故）
 * ────────────────────────────────────────────────────────────────────────────
 *   1. **禁止编造竞品名**。候选只能来自这四类真实来源：
 *        · web              —— 联网检索返回的 results / 结论（**可追溯到来源链接**）；
 *        · brain.competitors —— 企业大脑深度思考的产出；
 *        · asset.competitors —— 用户已经登记过的竞品；
 *        · keyword          —— 用户自己在搜索框里敲的词。
 *      **候选为空是正确结果**，不是缺陷。为空时返回 emptyReason 说明「这次没搜到同行」，
 *      下一步是**换个关键词再分析**（0.21.13 起不再把用户导向「去企业大脑补全资料」——
 *      老板原话：「为什么竞品分析还要去企业大脑里面补全」）。
 *      绝不"想 3-5 个凑满面板"（那与本轮 M2 修掉的"至少 3 条"是同一个病）。
 *   2. 自家品牌 / 旗下 IP 必须剔除（复用 selfBrandGuard.isSelfBrand，不另写一套归一化）。
 *   3. 纯函数、零副作用：可被 node 直接 import 做离线单测（不碰 React / store / localStorage）。
 */
import { isSelfBrand, normBrandName } from './selfBrandGuard.js';
import { normalizeBrain, hasBrain } from '../config/companyBrain.js';

/** 候选来源枚举。值会出现在 `data-comp-cand-source` 上，QA 靠它定位，改名等于改契约。 */
export const CAND_SOURCES = {
  BRAIN: 'brain', // 企业大脑深度思考产出
  EXISTING: 'existing', // 用户已登记（资产库）
  KEYWORD: 'keyword', // 用户搜索框输入
  WEB: 'web', // 【0.21.13】联网检索结果（groundedSearch 的 results/结论，带来源链接）
};

/** 来源中文标签（面板上直接显示，用户要能一眼看出"这条凭什么出现"）。 */
export const CAND_SOURCE_LABELS = {
  [CAND_SOURCES.BRAIN]: '企业大脑',
  [CAND_SOURCES.EXISTING]: '已登记',
  [CAND_SOURCES.KEYWORD]: '你输入的关键词',
  [CAND_SOURCES.WEB]: '联网检索',
};

/**
 * 来源基础分：越"用户自己确认过"的越靠前。
 * 已登记（用户亲手填的）> 联网检索（有链接可追）> 关键词（用户刚敲的）> 企业大脑（模型产出，可能未联网核实）。
 * 这不表示"企业大脑不可信"，只表示排序时把用户意图放前面 —— 面板是给用户做决定的。
 */
const SOURCE_BASE_SCORE = {
  [CAND_SOURCES.EXISTING]: 60,
  [CAND_SOURCES.WEB]: 58,
  [CAND_SOURCES.KEYWORD]: 55,
  [CAND_SOURCES.BRAIN]: 50,
};

/** 关键词切分：中英文逗号、顿号、分号、斜杠、空白都算分隔符。 */
const KEYWORD_SPLIT_RE = /[,，、;；/|｜\s]+/;

/** 把一段自由文本切成"可比较的词块"（≥2 字才算，单字噪声太大）。 */
function tokenize(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const out = [];
  for (const part of s.split(KEYWORD_SPLIT_RE)) {
    const t = part.trim();
    if (t.length >= 2) out.push(t);
  }
  return out;
}

/**
 * 与企业资产库的匹配度打分（0~100 之外不封顶，但只用于排序）。
 *
 * 做法刻意"笨"：把资产库的 industry / products / targetCustomers / profile 切成词块，
 * 看候选的「名字 + 理由」里出现了多少个词块。命中越多说明越相关。
 * 为什么不上相似度模型：本函数要能在 node 里离线跑、结果必须可复现（门禁要断言分数排序），
 * 引入任何随机性或远程调用都会让"排序稳定"这条不可证伪。
 *
 * @param {object} asset 营销资产
 * @param {string} haystack 候选名 + 理由
 * @returns {number}
 */
function scoreAgainstAsset(asset, haystack) {
  const a = asset && typeof asset === 'object' ? asset : {};
  const text = String(haystack || '');
  if (!text) return 0;
  const fields = [a.industry, a.products, a.targetCustomers, a.profile];
  const seen = new Set();
  let hit = 0;
  for (const f of fields) {
    for (const t of tokenize(f)) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (text.includes(t)) hit += 1;
    }
  }
  // 每命中一个资产词块 +8 分，封顶 40：避免"资产库写得很长"的候选把其它来源压死。
  return Math.min(40, hit * 8);
}

/** asset.competitors 可能是字符串数组，也可能是 {name} 对象数组。 */
function readAssetCompetitors(asset) {
  const list = asset && Array.isArray(asset.competitors) ? asset.competitors : [];
  const out = [];
  for (const it of list) {
    const nm = typeof it === 'string' ? it.trim() : (it && typeof it === 'object' ? String(it.name || '').trim() : '');
    if (nm) out.push(nm);
  }
  return out;
}

/** 从 URL 里取主机名（只为写人话理由，不做严格解析；取不到就返回空串）。 */
function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const noScheme = s.replace(/^[a-z]+:\/\//i, '');
  const host = noScheme.split(/[/?#]/)[0];
  return host.length >= 3 ? host : '';
}

/**
 * 读「联网检索」来源 —— 第四类真实来源（0.21.13 新增）。
 *
 * 入参来自 `groundedSearch()` 的产出（results 或模型的结论数组），允许三种形状：
 *   · `['励齿商城', ...]`（纯名字）
 *   · `[{name, reason, url}]`（带理由/链接）
 *   · `[{company|brand, position|desc, link}]`（别名字段，和四问答里的 key 对齐）
 *
 * **只搬名字，不生成名字**：没有 name 的条目直接丢弃（宁缺勿造）。
 *
 * @param {unknown} input webResults 原始数组
 * @returns {Array<{name:string, reason:string, url:string}>}
 */
function readWebResults(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const it of list) {
    if (it == null) continue;
    const o = typeof it === 'string' ? { name: it } : (typeof it === 'object' ? it : null);
    if (!o) continue;
    const name = String(o.name || o.company || o.brand || '').trim();
    if (!name) continue;
    const reason = String(o.reason || o.position || o.desc || o.note || '').trim();
    const url = String(o.url || o.link || '').trim();
    out.push({ name, reason, url });
  }
  return out;
}

/**
 * 构建竞品候选。
 *
 * @param {object} input
 * @param {object} [input.asset] 营销资产（读 industry / products / targetCustomers / profile / competitors）
 * @param {object|null} [input.brain] 企业大脑（未归一化也可以，内部会 normalizeBrain）
 * @param {string} [input.keyword] 用户在搜索框输入的关键词（可含多个，用逗号/顿号/空格分隔）
 * @param {Array} [input.webResults] 联网检索结果（第四类真实来源，见 readWebResults）
 * @param {string[]} [input.selfBrands] collectSelfBrandNames 的产物（自家品牌/子品牌）
 * @returns {{candidates: Array<{id:string,name:string,reason:string,source:string,
 *   sourceLabel:string,verified:boolean,score:number,checked:boolean}>, emptyReason:string}}
 */
export function buildCompetitorCandidates(input) {
  const p = input && typeof input === 'object' ? input : {};
  const asset = p.asset && typeof p.asset === 'object' ? p.asset : {};
  const selfBrands = Array.isArray(p.selfBrands) ? p.selfBrands : [];
  const keywordRaw = typeof p.keyword === 'string' ? p.keyword : '';

  // ✓ 企业大脑是否"跑过"—— 决定 emptyReason 的措辞（跑过没产出 ≠ 没跑过）。
  const brainRan = hasBrain(p.brain);
  const brain = normalizeBrain(p.brain);
  const brainComps = Array.isArray(brain.competitors) ? brain.competitors : [];
  const assetComps = readAssetCompetitors(asset);
  const keywordComps = tokenize(keywordRaw);
  const webComps = readWebResults(p.webResults);

  /** 收集阶段：只做"来源 → 原始条目"的搬运，不做任何生成。 */
  const raw = [];
  // 联网检索：有链接可追 ⇒ verified=true；`order` 用来在**同分**时保留检索/模型给出的相关度顺序。
  for (let i = 0; i < webComps.length; i += 1) {
    const w = webComps[i];
    const host = hostOf(w.url);
    raw.push({
      name: w.name,
      verified: true,
      source: CAND_SOURCES.WEB,
      reason: w.reason || (host ? `联网检索到（${host}）` : '联网检索到的同行'),
      order: i,
    });
  }
  for (const c of brainComps) {
    const name = String((c && c.name) || '').trim();
    if (!name) continue;
    const src = String((c && c.source) || '');
    raw.push({
      name,
      // 企业大脑自带 source（web / industry / user）时优先用它；没写就按 industry 处理（保守：当未核实）。
      verified: src === 'web',
      source: CAND_SOURCES.BRAIN,
      reason: String((c && c.reason) || '').trim() || '企业大脑深度思考时推荐的同行',
    });
  }
  for (const name of assetComps) {
    raw.push({
      name,
      verified: true, // 用户亲手登记的，视为已确认（不需要联网核验）
      source: CAND_SOURCES.EXISTING,
      reason: '你已经登记过',
    });
  }
  for (const name of keywordComps) {
    raw.push({
      name,
      verified: true, // 用户刚敲进来的
      source: CAND_SOURCES.KEYWORD,
      reason: '你输入的关键词',
    });
  }

  // ✓ 过滤阶段：剔除自家品牌（含子品牌/别名）+ 按归一化名称去重。
  const byKey = new Map();
  let selfDropped = 0;
  for (const it of raw) {
    if (isSelfBrand(it.name, selfBrands)) { selfDropped += 1; continue; }
    const key = normBrandName(it.name) || it.name.toLowerCase();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, it);
      continue;
    }
    // 同一家出现多次（比如企业大脑和资产库都有）：保留"用户确认过"的那条，
    // 理由取信息量更大的那条（企业大脑通常带 reason，比「你已经登记过」有用）。
    const keepNew = (SOURCE_BASE_SCORE[it.source] || 0) > (SOURCE_BASE_SCORE[prev.source] || 0);
    const betterReason = it.reason.length > prev.reason.length ? it.reason : prev.reason;
    const winner = keepNew ? { ...it } : { ...prev };
    winner.reason = betterReason;
    // verified 取"或"：任一条来源能核实就算能核实（信息只增不减）。
    winner.verified = !!(it.verified || prev.verified);
    byKey.set(key, winner);
  }

  const candidates = [...byKey.values()].map((it) => {
    const haystack = it.name + ' ' + it.reason;
    // 联网检索来源带 `order`：同分时把检索顺序靠前的排前面（0.001 的权重只做同分微调，
    // 不会跨来源抢位 —— 跨来源顺序由 SOURCE_BASE_SCORE 决定）。
    const orderBonus = (it.source === CAND_SOURCES.WEB && typeof it.order === 'number')
      ? (webComps.length - it.order) * 0.001
      : 0;
    return {
      // id 用归一化名：面板的 React key / checkbox 定位都靠它，稳定且与展示名解耦。
      id: normBrandName(it.name) || it.name.toLowerCase(),
      name: it.name,
      reason: it.reason,
      source: it.source,
      sourceLabel: CAND_SOURCE_LABELS[it.source] || it.source,
      verified: !!it.verified,
      score: (SOURCE_BASE_SCORE[it.source] || 0) + scoreAgainstAsset(asset, haystack) + orderBonus,
      // 默认勾选：四类来源都是"有据可依"的，先勾上；用户点一下就能取消。
      checked: true,
    };
  });

  // 分数降序；同分按名称稳定排序（结果必须可复现，否则门禁无法断言顺序）。
  candidates.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return { candidates, emptyReason: candidates.length ? '' : buildEmptyReason({ brainRan, brainComps, assetComps, keywordComps, webComps, selfDropped }) };
}

/**
 * 为什么没有候选 —— 必须区分清楚（两种情况的事实不同，用户要知道豆芽到底试过什么）：
 *   ① 企业大脑没跑过      → 说清「没跑过 + 这轮联网也没线索」；
 *   ② 跑过了但没产出竞品  → 说清「跑过但没产出，资产库也没登记」；
 *   ③ 有候选但全是自家品牌 → 检查子品牌登记是否写错（这其实是护栏在正确工作）。
 *
 * **下一步动作统一是「换个关键词再分析」（0.21.13 起）**：老板原话「为什么竞品分析还要去
 * 企业大脑里面补全」——竞品分析不该把用户导向企业大脑补资料。空态只允许两条出路：
 * 换关键词重跑 / 手动添加。所以本函数里禁止出现「去企业大脑补全资料」这类引导。
 */
function buildEmptyReason({ brainRan, brainComps, assetComps, keywordComps, webComps, selfDropped }) {
  if (selfDropped > 0) {
    return `拿到的 ${selfDropped} 个候选都属于本企业自有品牌 / 旗下 IP，已全部剔除（它们不是竞品）。`
      + '如果你的子品牌登记有误，请到「企业大脑 · 子品牌」核对；也可以换个关键词再分析。';
  }
  if (!brainRan) {
    return '企业大脑还没跑过深度思考，这一轮联网检索也没有拿回可用的同行线索，所以豆芽手上没有任何可推荐的竞品。'
      + '换个关键词再分析一次，也可以直接在下面手动添加。';
  }
  const others = (brainComps || []).length + (assetComps || []).length
    + (keywordComps || []).length + (webComps || []).length;
  if (others === 0) {
    return '企业大脑跑过了，但没有产出竞品，资产库里也还没登记过竞品。'
      + '换个关键词再分析一次，也可以直接在下面手动添加。';
  }
  return '暂时没有可勾选的候选。换个关键词再分析一次，也可以直接在下面手动添加。';
}

export default { buildCompetitorCandidates, CAND_SOURCES, CAND_SOURCE_LABELS };
