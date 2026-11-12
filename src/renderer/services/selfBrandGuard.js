/**
 * selfBrandGuard —— 「本企业自有品牌 / 旗下 IP」护栏（竞品链路的公共闸门）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 一、为什么需要它（2026-09-21 老板实测缺陷）
 * ────────────────────────────────────────────────────────────────────────────
 * 企业档案里本来就写着品牌矩阵关系（BrandIpManager.jsx 注释：
 * 「康健苗苗 → 上游货源 / 舒雅星系 / 中齿云彩」），contextBuilder.js 也一直在
 * 注入「- 旗下品牌/IP：…」。但**所有「谁是竞品」的判定链路都没拿到这份名单**：
 *
 *   ① marketDiagnosis.js `buildMarketPrompt` 的参数表里没有 brandIps —— 而它偏偏在
 *      竞品名单为空时**强制**模型「自己联网找 3-5 家同业企业」（2026-09-14 老板 A 项）；
 *   ② marketDiagnosis.js `buildMarketSearchQueries` 用「行业 主要企业 品牌」找同业，
 *      检索命中的自家矩阵页里就有上游货源；
 *   ③ deepThink.js `buildCompetitorDiscoverQuery` 用「… 竞品 主要企业 同行 品牌」找候选，
 *      约束里只说「必须是资料里出现的」，没说「不许是你自己的品牌」。
 *
 * 结果：模型把自家子品牌「上游货源」写成了竞品 —— 它甚至在 finding 里自述
 * 「上游货源（HEALTH MIU MIU，与康健苗苗同属一个官网体系，实为关联品牌）」，
 * **写了矛盾却照做**。⇒ 缺的不是认知，是**没有被明确排除**。
 * 老板原话：「上游货源是康健苗苗下面的 上面都说了 还会把上游货源做成竞品」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 二、红线
 * ────────────────────────────────────────────────────────────────────────────
 *   1. 只做「排除 + 提示 + 事后检测」，**绝不**替模型下结论、绝不编造竞品；
 *   2. 排除必须**留痕**（`excludeSelfBrands` 返回 dropped），不许静默吞掉 ——
 *      「悄悄删掉一家真竞品」和「把自家品牌当竞品」一样是事故；
 *   3. 归一化必须能拦住写法差异：`上游货源` / `上游货源（HEALTH MIU MIU）` / `上游货源健康` 这类；
 *   4. 本模块**零依赖纯函数**，可被 node 直接 import 做离线单测（不碰 React store）。
 */

/** 企业名后缀：匹配「康健苗苗集团」这类写法时剥掉，避免自家母公司行漏网。 */
const CORP_SUFFIX_RE = /(股份有限公司|有限责任公司|有限公司|集团公司|集团|公司|企业)$/;

/**
 * 名称归一化：用于**比对**（不用于展示）。
 *
 * 步骤：① 去掉括号及其内容（中英文括号，浅层即可）→ ② 去掉一切非字母数字汉字
 *      → ③ 转小写 → ④ 去掉常见企业后缀。
 *
 * 例：
 *   '上游货源（HEALTH MIU MIU）' → '上游货源'
 *   '康健苗苗（杭州）医药有限公司' → '康健苗苗医药'（后缀只剥一次，保守）
 *   'MEI MIAO MIAO' → 'meimiaomiao'
 *
 * @param {unknown} v
 * @returns {string}
 */
export function normBrandName(v) {
  let s = typeof v === 'string' ? v : '';
  if (!s) return '';
  // ① 去括号内容（中英文 + 方括号，非贪婪）
  s = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '');
  // ② 去掉非字母数字汉字
  s = s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  // ③ 小写
  s = s.toLowerCase();
  // ④ 剥企业后缀（保留核心，长度 ≥2 才剥，避免把「集团」本身剥成空）
  const stripped = s.replace(CORP_SUFFIX_RE, '');
  if (stripped.length >= 2) s = stripped;
  return s;
}

/** 从任意形状里提取「名称 + 别名」扁平数组（支持 {name,aliases} / string / 混合）。 */
function flattenBrandEntries(list) {
  const out = [];
  const push = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) out.push(s);
  };
  (Array.isArray(list) ? list : []).forEach((it) => {
    if (!it) return;
    if (typeof it === 'string') { push(it); return; }
    if (typeof it !== 'object') return;
    // enabled === false 的 IP 视为「已停用」，不参与排除（尊重用户显式关闭）
    if (it.enabled === false) return;
    push(it.name);
    if (Array.isArray(it.aliases)) it.aliases.forEach(push);
    else if (typeof it.aliases === 'string') it.aliases.split(/[,，、;；\s]+/).forEach(push);
  });
  return out;
}

/**
 * 汇总「自家品牌名（含别名）」。数据来源与 contextBuilder 的 `- 旗下品牌/IP` 完全同源。
 *
 * @param {{company?:object, asset?:object, knowledge?:object}} p
 * @returns {string[]} 去重后的原始名称（展示用；比对请走 isSelfBrand）
 */
export function collectSelfBrandNames(p = {}) {
  const c = p.company && typeof p.company === 'object' ? p.company : {};
  const a = p.asset && typeof p.asset === 'object' ? p.asset : {};
  const k = p.knowledge && typeof p.knowledge === 'object' ? p.knowledge : {};
  const kp = k.profile && typeof k.profile === 'object' ? k.profile : {};

  const raw = [];
  // 母公司名（多个来源都可能是唯一有值的那处）
  [kp.companyName, a.companyName, c.name].forEach((v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) raw.push(s);
  });
  // 母公司别名（若登记过）
  flattenBrandEntries(kp.brandMainAliases).forEach((s) => raw.push(s));
  // 旗下品牌 / 子品牌 IP（本模块存在的核心理由）
  flattenBrandEntries(kp.brandIps).forEach((s) => raw.push(s));
  flattenBrandEntries(a.brandIps).forEach((s) => raw.push(s));

  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const n = normBrandName(s);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(s);
  }
  return out;
}

/**
 * 该名称是否属于「自家品牌 / 旗下 IP」。
 *
 * 判据：
 *   ① 归一化后**相等**（长度 ≥2）——如「上游货源」=「上游货源（HEALTH MIU MIU）」；
 *   ② 一方**包含**另一方，且较短方长度 ≥3 —— 用于拦住「上游货源健康」「上游货源商城」这类带业务后缀的写法。
 *      阈值取 3 而非 2 是刻意的：母公司名若被登记成两字简称（如「康健」），
 *      取 2 会把真竞品「康健口腔」误判成自家品牌 —— **悄悄删掉一家真竞品和把自家当竞品一样是事故**，
 *      所以这里宁可少判（只认精确匹配），由 dropped 留痕兜住边界情形。
 *
 * @param {unknown} name 待判定名称
 * @param {string[]} selfNames collectSelfBrandNames 的产物
 * @returns {boolean}
 */
export function isSelfBrand(name, selfNames) {
  const n = normBrandName(name);
  if (!n || n.length < 2) return false;
  for (const s of Array.isArray(selfNames) ? selfNames : []) {
    const m = normBrandName(s);
    if (!m || m.length < 2) continue;
    if (n === m) return true;
    if (Math.min(n.length, m.length) >= 3 && (n.includes(m) || m.includes(n))) return true;
  }
  return false;
}

/**
 * 把自家品牌从「竞品候选」里剔除，并**留痕**。
 *
 * @param {Array<string|object>} names 竞品候选（字符串，或含 name 字段的对象）
 * @param {string[]} selfNames collectSelfBrandNames 的产物
 * @returns {{kept:Array, dropped:Array<{name:string, reason:string}>}}
 */
export function excludeSelfBrands(names, selfNames) {
  const kept = [];
  const dropped = [];
  (Array.isArray(names) ? names : []).forEach((it) => {
    const nm = typeof it === 'string' ? it.trim() : (it && typeof it === 'object' ? String(it.name || '').trim() : '');
    if (!nm) return;
    if (isSelfBrand(nm, selfNames)) {
      dropped.push({ name: nm, reason: '本企业自有品牌 / 旗下 IP，不作为竞品' });
      return;
    }
    kept.push(it);
  });
  return { kept, dropped };
}

/**
 * 在**一段文本**里找出仍把自家品牌当竞品提的痕迹（事后检测，可证伪）。
 *
 * 用途：模型偶尔不守规矩（prompt 已明确排除仍写），此函数让「犯规」被抓到并按实标注，
 * 而不是靠人肉翻文本。返回命中的净名称（命中的自家名，最多 20 条）。
 *
 * @param {unknown} text
 * @param {string[]} selfNames
 * @returns {string[]}
 */
export function findSelfBrandConflicts(text, selfNames) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const hits = [];
  for (const name of Array.isArray(selfNames) ? selfNames : []) {
    const raw = typeof name === 'string' ? name.trim() : '';
    if (!raw) continue;
    // 用**原始名**在原文里找（归一化会破坏原文，无法定位）；
    // 中文名直接 includes；含英文/空格的名字用去空白后的宽松匹配。
    const loose = normBrandName(raw);
    const hit = s.includes(raw) || (loose.length >= 3 && normBrandName(s).includes(loose));
    if (hit && !hits.includes(raw)) hits.push(raw);
    if (hits.length >= 20) break;
  }
  return hits;
}

/**
 * 生成注入 prompt 的「自家品牌/IP」排除段（数组，供调用方 push 进 lines）。
 *
 * 文案刻意直白且**带因果**：告诉模型「这不是竞品」，并说明这条信息来自企业档案，
 * 避免它在「必须找 3-5 家同业」的压力下又把自家算进去。
 *
 * @param {string[]} selfNames
 * @returns {string[]} 空数组 = 没有可排除项（零注入，与改动前逐字一致）
 */
export function selfBrandPromptLines(selfNames) {
  const list = (Array.isArray(selfNames) ? selfNames : []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  if (!list.length) return [];
  return [
    '【本企业自有品牌 / 旗下 IP —— 它们**不是竞品**】',
    list.map((n) => '· ' + n).join('\n'),
    '以上名称属于本企业自己（母公司及其子品牌 / 产品线 IP，来自企业档案）。',
    '**严禁**把它们列为竞品、算进竞品数量、或写进竞品候选清单；它们是我方的不同门面，不是外部对手。',
    '若你检索到的资料里出现这些名字，请把它们当作「我方信息」，而不是同业。',
    '若排除后同业企业不足 3 家，就按实际数量作答（1-2 家也可以），**不要为了凑数把自家品牌算进去**。',
  ];
}

/**
 * 从结构化竞品对比结果里剔除「自家品牌行」——渲染层最后一道闸。
 *
 * 为什么必须在渲染层再拦一次（而不是只靠生成时过滤）：
 *   对比矩阵来自**持久化的** job.result，可能生成于「上游护栏还没上线」的时候，
 *   旧结果不清掉就会被一直渲染。所以每次渲染都按**当前**企业档案里的自有品牌重判一次。
 *
 * 红线：
 *   · 我方那一行（`isUs === true`）**保留** —— 它本来就是自家，不是「被误当竞品」；
 *   · 剔除必须留痕（返回 `dropped`），交调用方在报告顶部按实说明，不许静默消失；
 *   · 雷达分值（`view.scores`）同步删除，避免「行没了、雷达里还在」的错位。
 *
 * 本函数是纯函数（只依赖 isSelfBrand），故从 `modules/CompetitorAnalysis.jsx` 抽到此处，
 * 让它能被离线单测覆盖 —— 渲染层护栏此前是**零测试覆盖**的。
 *
 * @param {object|null} view 结构化结果（mergeManual 之后）
 * @param {string[]} selfBrands collectSelfBrandNames 的产物
 * @returns {{view:object|null, dropped:string[]}}
 */
export function filterSelfBrandRows(view, selfBrands) {
  if (!view || !Array.isArray(view.rows)) return { view, dropped: [] };
  const dropped = [];
  const rows = view.rows.filter((r) => {
    if (!r) return false;
    if (r.isUs === true) return true;
    if (isSelfBrand(r.name, selfBrands)) { dropped.push(r.name); return false; }
    return true;
  });
  if (dropped.length === 0) return { view, dropped: [] };
  const scores = { ...(view.scores || {}) };
  for (const n of dropped) delete scores[n];
  return { view: { ...view, rows, scores }, dropped };
}

export default {
  normBrandName,
  collectSelfBrandNames,
  isSelfBrand,
  excludeSelfBrands,
  findSelfBrandConflicts,
  selfBrandPromptLines,
  filterSelfBrandRows,
};
