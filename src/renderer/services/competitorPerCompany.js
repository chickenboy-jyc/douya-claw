/**
 * competitorPerCompany.js —— 竞品分析「逐家检索」的取数内核（纯函数 + 可注入 searchFn）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么必须有这个文件（老板第三次投诉）
 * ────────────────────────────────────────────────────────────────────────────
 * 老板原话（2026-11-06，第三次）：「竞品分析又有很多内容搜不到的」。
 *
 * 病根不在提示词，在**检索次数**：`MarketMomentum.jsx` 每题只发**一条** query，
 * 且只把前 3 家名字拼进去（`names.slice(0, 3)`）：
 *     `${base} ${names.slice(0,3).join(' ')} 产品 价格 报价`
 * 而提示词把 5 家全交给模型（`要查的同行：${names.join('、')}`，MAX_ROWS.q1 = 5），
 * 又要求「某一家的产品和价位都查不到，就不要返回这一家」
 * ⇒ 第 4/5 家**从头到尾没有任何一条针对它的检索**，模型只能把它们整行删掉。
 * 结果就是老板看到的「一大堆内容搜不到」。
 *
 * 实测证据（KI-009 缺口审计 `release/_evidence-0.21.26-rc.1/gap-audit/ki009/REPORT.md`）：
 *   · 旧检索词 6 条里第三方口腔同行 **0/6**（3 条自家页 + 3 条明显跨行业）；
 *   · 把这批结果喂模型：**4/4 次返回 `{"competitors":[]}`** ⇒ 模型是严格守规矩的，
 *     它没材料就写空数组，问题在**没给它材料**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 本轮做法（唯一一件：把「一条 query 摊 3 家」换成「一家一条 query」）
 * ────────────────────────────────────────────────────────────────────────────
 *   · Q2（产品/价位）、Q3（最新动作）本质是 per-company 的 ⇒ **每家一条独立检索**，
 *     每家的 prompt 里只出现**这一家**的名字。资料按家隔离是**结构保证**，
 *     不是靠模型从一锅 15 条里自己认领（那种归属是不可证伪的）。
 *   · Q1（找名单）与 Q4（跨家综合）保持一条 —— 它们本来就是全局问题。
 *   · 并发上限 3（`PER_COMPANY_CONCURRENCY`）：5 家串行会把单次分析拖到 1 分钟以上，
 *     并发池写法与 `services/rssService.js` 的 `crawlSources` 同款（cursor + worker），
 *     本仓已有这个模式，不再造第二种。
 *   · **失败隔离**：单家检索抛错 / 0 条**不许中断整轮**，只把这家记进 `missing`；
 *     角标如实写「查了 Y 家，只有 X 家有实检」—— 既不撒谎，也不把空行塞回页面
 *     （老板原话：「没有数据就不要显示」）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 「有实检」的判据（可证伪，不是"我调过接口"）
 * ────────────────────────────────────────────────────────────────────────────
 * 一家算**有实检**要同时满足：
 *   ① 这次检索 `ok === true`（端点通、模型有回答）；
 *   ② `results.length > 0`（真拿到网页，不是"联网了但 0 条"）；
 *   ③ `matchCoveredCompetitors(results, [name])` 判定这家的名字**真的出现在结果正文里**
 *      —— 检索词带着这家名，返回的却是别的公司的页，那就不算查到了这家。
 * ③ 依赖 `groundedWebSearch.matchCoveredCompetitors` 读对字段（provider 归一化后正文叫
 * `content`）；旧实现只读 `snippet` ⇒ 恒判未覆盖，那正是「明明查到却报未检索」的来源。
 *
 * 运行单测：node scripts/smoke/unit-competitor-coverage.mjs
 */
import { matchCoveredCompetitors } from './groundedWebSearch.js';

/** 逐家检索的并发上限（5 家串行会让单次分析超过 1 分钟）。 */
export const PER_COMPANY_CONCURRENCY = 3;

/**
 * 逐家检索每条取几条（原先是 6 条摊给 3 家 + 一个意图，现在 4 条只服务 1 家）。
 * 检索额度与上下文长度都按"一家"收缩，总条数不比原来高。
 */
export const PER_COMPANY_COUNT = 4;

/**
 * 逐家检索的意图后缀。
 *
 * Q2 与 Q3 分开而不是合成一条：这两问要的**证据类型**不同
 * （产品/价目页 vs 新闻/公告页），合成一条会让检索词变成大杂烩，
 * 模型也得更长地推理"哪半句回答哪一问"。
 */
export const PER_COMPANY_SUFFIX = {
  product: '产品 价格 报价',
  moves: '最新动态 新品 活动 2026',
};

/** 去空白字符串（非字符串一律）。 */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 大小写不敏感的包含判据（拼词去重用）。 */
function hasPart(parts, p) {
  const k = p.toLowerCase();
  return parts.some((x) => x.toLowerCase() === k);
}

/**
 * 构造「只针对某一家」的检索词。
 *
 * 与旧实现的三处差别（每处都是为了"这一条只查这家"）：
 *   ① **不再 slice(0,3)** —— 调用方对每家各调一次，家数由名单长度决定；
 *   ② **不再拼 `base`** —— base = 「我方企业名 + 行业」，把它塞进逐家检索词会把
 *      自家页面一起捞回来（审计实测 6 条里 3 条是自家页，就是 base 里的企业名造的）；
 *      这里只带**行业约束**，主体是这家同行自己；
 *   ③ 用户填的关键词仍然带上（它是用户点名要看的角度），与行业名重复时去重。
 *
 * @param {{name?:string, industry?:string, keyword?:string, kind?:'product'|'moves'}} input
 * @returns {string} 形如「时代天使 口腔医疗器械 产品 价格 报价」；name 为空 ⇒ ''
 */
export function buildPerCompanyQuery(input = {}) {
  const name = str(input.name);
  if (!name) return '';
  const industry = str(input.industry);
  const keyword = str(input.keyword);
  const suffix = PER_COMPANY_SUFFIX[input.kind] || PER_COMPANY_SUFFIX.product;
  const parts = [name];
  if (industry && !hasPart(parts, industry)) parts.push(industry);
  if (keyword && !hasPart(parts, keyword)) parts.push(keyword);
  parts.push(suffix);
  return parts.join(' ');
}

/**
 * 并发池（cursor + worker，与 `rssService.crawlSources` 同一套写法）。
 *
 * 为什么用池而不是 `Promise.all(list.map(...))`：5 家一起打检索端点会被限流，
 * 而且本轮还有第二条链路（模型作答）在抢同一个网关；上限压到 3 才稳。
 *
 * @template T,R
 * @param {T[]} list 待处理项
 * @param {number} concurrency 并发上限（会被夹到 [1, 8]）
 * @param {(item:T, index:number)=>Promise<R>} worker 单项处理器
 * @returns {Promise<R[]>} 与输入**同序**的结果数组
 */
export async function mapPool(list, concurrency, worker) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return [];
  const limit = Math.min(Math.max(1, Number(concurrency) || 1), 8, arr.length);
  const out = new Array(arr.length);
  let cursor = 0;
  async function run() {
    while (cursor < arr.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await worker(arr[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return out;
}

/**
 * 把一次「逐家检索」的返回归一成一行（**永不抛**：单家失败只填这一行）。
 *
 * @param {string} name 目标同行
 * @param {object|null} hit groundedSearch 的返回（异常时传 null）
 * @param {(data:any)=>Array} parse 该题的解析器（只解析、不做家数裁剪）
 * @returns {{name:string, query:string, ok:boolean, grounded:boolean,
 *            results:number, hit:boolean, items:Array, error:string}}
 */
function toRow(name, query, hit, parse) {
  const results = Array.isArray(hit && hit.results) ? hit.results : [];
  const ok = !!(hit && hit.ok === true && hit.content);
  let items = [];
  if (ok) {
    try {
      items = parse ? (parse(hit.data) || []) : [];
    } catch (e) {
      items = [];
    }
  }
  // ③ 名字必须真的出现在检索结果里，才算"查到了这家"（见文件头「有实检」的定义）。
  const covered = ok && results.length > 0
    ? matchCoveredCompetitors(results, [name]).covered.length === 1
    : false;
  return {
    name,
    query,
    ok,
    grounded: !!(hit && hit.grounded === true),
    results: results.length,
    hit: covered,
    items: Array.isArray(items) ? items : [],
    error: (hit && hit.error) || '',
  };
}

/**
 * 逐家真检索（Q2/Q3 共用）：每家一条 query、一条 prompt、一次 groundedSearch。
 *
 * 失败隔离：单家抛错 / 0 条 / 名字没出现在结果里 ⇒ 只记进 `missing`，整轮继续。
 *
 * @param {object} input
 * @param {string[]} input.names 要查的同行（Q1 的产出，最多 MAX_ROWS.q1 家）
 * @param {'product'|'moves'} input.kind 这一问的意图
 * @param {string} [input.industry] 行业约束（来自营销资产）
 * @param {string} [input.keyword] 用户填的关键词
 * @param {(name:string)=>string} input.questionOf 逐家 prompt 生成器（只含这一家）
 * @param {(data:any)=>Array} input.parse 该题的解析器
 * @param {(question:string, opts:object)=>Promise<object>} input.searchFn 检索函数
 *        （产品里传 groundedSearch；单测传假实现）
 * @param {number} [input.concurrency] 并发上限（默认 3）
 * @param {number} [input.count] 每家取几条（默认 4）
 * @returns {Promise<{rows:Array, covered:string[], missing:string[],
 *                    total:number, results:number, anyHit:boolean}>}
 */
export async function searchEachCompany(input = {}) {
  const names = (Array.isArray(input.names) ? input.names : []).map((n) => str(n)).filter(Boolean);
  const questionOf = typeof input.questionOf === 'function' ? input.questionOf : () => '';
  const parse = typeof input.parse === 'function' ? input.parse : () => [];
  const searchFn = typeof input.searchFn === 'function' ? input.searchFn : null;
  const count = Number(input.count) > 0 ? Number(input.count) : PER_COMPANY_COUNT;
  const concurrency = Number(input.concurrency) > 0
    ? Number(input.concurrency) : PER_COMPANY_CONCURRENCY;

  if (!names.length) {
    return { rows: [], covered: [], missing: [], total: 0, results: 0, fetched: 0, anyHit: false };
  }
  if (!searchFn) {
    // 没有检索函数 = 这一轮压根没联网。**不伪造**：全部记进 missing，由调用方如实说话。
    const rows = names.map((name) => toRow(name, '', null, parse));
    return {
      rows, covered: [], missing: names, total: names.length, results: 0, fetched: 0, anyHit: false,
    };
  }

  const rows = await mapPool(names, concurrency, async (name) => {
    const query = buildPerCompanyQuery({
      name, industry: input.industry, keyword: input.keyword, kind: input.kind,
    });
    let hit = null;
    try {
      hit = await searchFn(questionOf(name), { query, count, temperature: 0.2 });
    } catch (e) {
      // 单家异常**不许**中断整轮 —— 这是老板那条「又有很多内容搜不到」里最容易被忽略的一格：
      // 以前一条 query 覆盖 3 家，一家抛错就 3 家一起没了。
      hit = null;
    }
    return toRow(name, query, hit, parse);
  });

  const covered = rows.filter((r) => r.hit && r.items.length > 0).map((r) => r.name);
  const missing = rows.filter((r) => !covered.includes(r.name)).map((r) => r.name);
  // `results` = **命中这几家**的结果条数之和（`fetched` 才是拉回来的全部条数）。
  // 为什么这么算：角标写「联网实检 N 条」时，N 必须是**真的用在这几家身上**的条数 ——
  // 把"搜了但没点名"的条目也算进去，就又是一次"看起来很充分"（0.21.9 已经为此改过一次口径）。
  const fetched = rows.reduce((s, r) => s + (r.results || 0), 0);
  const results = rows.reduce((s, r) => s + (r.hit ? (r.results || 0) : 0), 0);
  return {
    rows, covered, missing, total: names.length, results, fetched, anyHit: covered.length > 0,
  };
}

/**
 * 把「逐家」的条目按 Q1 名单顺序合并（同名只保留第一次出现，且**只认目标那家**）。
 *
 * 为什么要按目标名过滤：模型偶尔会把材料里顺带提到的别家写成 `name`
 * （「X 用的是 Y 的方案」）。那种行挂到 X 的位置上是错的归属 —— 直接丢掉，
 * 它在 Y 自己那一轮里本来就有机会被查到。
 *
 * @param {Array<{name:string, items:Array}>} rows searchEachCompany 的 rows
 * @param {(item:object)=>string} nameOf 从条目里取名字
 * @param {number} limit 最多保留几条
 * @returns {Array<object>} 合并后的条目
 */
export function mergeCompanyItems(rows, nameOf, limit) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const target = str(row && row.name);
    for (const it of Array.isArray(row && row.items) ? row.items : []) {
      const nm = typeof nameOf === 'function' ? str(nameOf(it)) : '';
      // 没点名 ⇒ 认这一轮的目标（这一轮的 prompt 只问了这一家）；点了别人的名 ⇒ 丢。
      if (nm && target && nm !== target) continue;
      const key = target || nm;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(it);
      if (out.length >= (Number(limit) > 0 ? Number(limit) : out.length)) return out;
    }
  }
  return out;
}

/**
 * 覆盖率角标文案（老板能直接看到的那句）。
 *
 * 口径来源：死代码 `modules/CompetitorAnalysis.jsx:1925-1937` 的 `searchCoverage` 角标
 * —— 那一套是 0.21.9 为「勾 6 家只查 2 家，角标还写实检 8 条」造的，口径正确，
 * 只是它挂在一个**没人挂载**的模块上（`MarketIntel.jsx` 自己也没被 App 挂载）。
 * 本轮把它搬到这里：数字是**家数**，不是结果条数。
 *
 * 三条纪律：
 *   ① 有覆盖也有缺口 ⇒ 明说「X / Y 家」并**点名**缺口，不说「全部竞品都有实检依据」；
 *   ② 一家都没有 ⇒ 说清是"没拿到实检"，并交代结论是谁给的（模型），提醒当假设看；
 *   ③ 不为了让角标好看而把空行塞回页面（老板原话：「没有数据就不要显示」）。
 *
 * @param {{total?:number, covered?:string[], missing?:string[], modelFilled?:boolean}} c
 * @returns {string} 空串代表"没什么可说的"（total 为 0 时不印角标）
 */
export function coverageBadge(c = {}) {
  const total = Number(c.total) > 0 ? Number(c.total) : 0;
  if (!total) return '';
  const covered = Array.isArray(c.covered) ? c.covered.filter(Boolean) : [];
  const missing = Array.isArray(c.missing) ? c.missing.filter(Boolean) : [];
  if (covered.length > 0) {
    const head = `本轮实检覆盖 ${covered.length} 家 / 共 ${total} 家`;
    if (!missing.length) return `${head}，每家都拿到了实检资料。`;
    return `${head}：${missing.join('、')} 没检索到，本次不给这 ${missing.length} 家下结论。`;
  }
  if (c.modelFilled) {
    return `本轮没拿到实检结果（未联网 / 检索失败），${total} 家全部由模型补全 —— 请把结论当假设看。`;
  }
  return `本轮 ${total} 家同行一家都没检索到（未联网 / 检索失败），所以这 ${total} 家都没有结论。`;
}

/** 单题来源那一行的覆盖附注（Q2/Q3 才有）：` · 3/5 家有实检`。 */
export function coverageHint(c = {}) {
  const total = Number(c.total) > 0 ? Number(c.total) : 0;
  if (!total) return '';
  const covered = Array.isArray(c.covered) ? c.covered.filter(Boolean) : [];
  return ` · ${covered.length}/${total} 家有实检`;
}

export default {
  PER_COMPANY_CONCURRENCY,
  PER_COMPANY_COUNT,
  PER_COMPANY_SUFFIX,
  buildPerCompanyQuery,
  mapPool,
  searchEachCompany,
  mergeCompanyItems,
  coverageBadge,
  coverageHint,
};
