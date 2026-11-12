/**
 * geoExposure —— 新媒体 GEO 曝光度「诊断」（第 8 项改造：从报告改成真诊断）。
 *
 * 旧版问题：输出的是一份「报告」（summary + 各平台曝光等级 + 内容缺口 + 补齐建议），
 * 而且实抓分支 buildRealScanResult 里的 gaps / suggestions 是写死的模板，
 * 导致 B2B 企业（如卖给诊所/经销商的口腔器械电商）收到「入驻大众点评、打造医生个人IP、到店引流」
 * 这种面向患者的诊所获客建议 —— 与本企业完全无关。
 *
 * 新版契约：
 * 1. 输出「检查项」而不是「建议清单」：每条 check 必须有 status（pass/warn/fail/unknown）、
 *    severity、evidence（真实依据，找不到就 unknown）、why、可执行的 fix。
 * 2. 检查项由「企业客户类型」决定：B2B（机构客户）严禁出现本地生活 / 到店引流 /
 *    大众点评美团入驻 / 医生个人IP 这类检查项与建议。
 * 3. 实抓分支不再写死结论，而是把真实抓到的数据作为上下文交给 AI 生成同样的 checks 结构；
 *    AI 不可用时退化为「基于实抓数字的规则推导」，仍然不编造。
 *
 * 数据来源优先级（T16 起）：
 * 1. 豆芽工作台后端 /api/geo/exposure 真实可见度实抓（问AI盲测 + 搜狗 site 收录）；
 * 2. 降级：**真检索**（fetchWebSearch 实检 → 注入资料 → 模型据实作答，见 webSearchGrounded）；
 * 3. 再降级：内网模型（来源如实标「未联网 · 模型推断」）。
 */

import { chatOnce, geoProxy } from '../api.js';
import {
  getCachedWebSearchHealth,
  checkWebSearchHealth,
  describeSource,
  describeSourceWithCount,
  SOURCE_KINDS,
} from './webSearchHealth.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
// T16：GEO 曝光诊断的「联网检索」改走**真检索**（fetchWebSearch 实检 → 注入资料），
// 不再走静默忽略 enable_search 的 searchWeb（内网网关实测从不真的上网）。
import { searchWebGrounded } from './webSearch.js';
import { groundedHealth } from './groundedWebSearch.js';

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 判定为「机构客户」的关键词。 */
const B2B_HINTS = [
  '诊所', '口腔诊所', '牙科诊所', '口腔医院', '医院', '科室', '公立', '民营',
  '经销商', '代理商', '渠道商', '批发', '分销', '门店', '连锁',
  '企业', '机构', '工厂', '厂商', '采购', '供应链', 'B端', 'toB', 'b2b',
  '政府', '院校', '实验室', '集团', '工程', '项目方',
];

/** 判定为「个人消费者」的关键词。 */
const B2C_HINTS = [
  '患者', '个人消费者', '终端消费者', '个人用户', '宝妈', '学生', '家庭用户',
  '消费者', 'C端', 'toC', 'b2c', '到店', '散户',
];

/**
 * 推断企业客户类型：b2b（机构客户）/ b2c（个人消费者）/ unknown。
 * B2B 与 B2C 同时命中时，以命中数量多的一方为准，避免 B2B 企业因简介里出现「消费者」被误判。
 */
export function inferCompanyType(asset, company) {
  const a = asset || {};
  const c = company || {};
  const list = []
    .concat(Array.isArray(a.targetCustomers) ? a.targetCustomers : [])
    .concat(typeof a.targetCustomers === 'string' ? [a.targetCustomers] : [])
    .concat(Array.isArray(a.customerType) ? a.customerType : [])
    .concat(typeof a.customerType === 'string' ? [a.customerType] : [])
    .concat(Array.isArray(c.targetCustomers) ? c.targetCustomers : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean);

  const text = [
    list.join('、'),
    str(a.profile),
    str(a.businessModel || a.model),
    str(a.industry),
    str(c.industry),
    str(c.name),
  ].join(' ');

  let b2b = 0;
  let b2c = 0;
  for (const k of B2B_HINTS) if (text.includes(k)) b2b += 1;
  for (const k of B2C_HINTS) if (text.includes(k)) b2c += 1;
  if (b2b === 0 && b2c === 0) return 'unknown';
  return b2b >= b2c ? 'b2b' : 'b2c';
}

export const COMPANY_TYPE_LABEL = {
  b2b: '企业/机构客户（B2B）',
  b2c: '个人消费者（B2C）',
  unknown: '未明确（需先判断客户是机构还是个人）',
};

/** 硬性约束原文（B2B 严禁本地生活类建议），必须完整出现在 prompt 里。 */
export const B2B_FORBIDDEN_RULE =
  '你必须先判断该企业的客户是机构还是个人消费者，若为企业/机构客户，严禁输出本地生活、到店引流、大众点评美团入驻、医生个人IP 相关的检查项或建议，那些是面向患者的诊所获客动作，与本企业无关。';

/** 诊断 JSON 契约（AI 只准返回这个结构）。 */
export const EXPOSURE_JSON_TEMPLATE = [
  '{',
  '  "overallScore": 0,',
  '  "grade": "优/良/中/差",',
  '  "verdict": "一句话诊断结论：当前最大的问题是什么、先补哪里",',
  '  "checks": [',
  '    {',
  '      "id": "ai_visibility",',
  '      "name": "AI 问答可见度",',
  '      "dimension": "AI可见度",',
  '      "status": "pass|warn|fail|unknown",',
  '      "severity": "high|mid|low",',
  '      "evidence": "真实依据（引用实抓数字或检索到的页面，找不到就写 未获取到：原因）",',
  '      "why": "这项为什么重要（对本企业的获客链路意味着什么）",',
  '      "fix": {',
  '        "action": "一句话修复动作",',
  '        "steps": ["步骤1", "步骤2"],',
  '        "expect": "预期达到什么效果",',
  '        "effort": "低/中/高"',
  '      }',
  '    }',
  '  ],',
  '  "platformScores": [ { "platform": "平台名", "score": 0, "note": "一句话说明" } ],',
  '  "priorities": [ { "title": "优先做什么", "why": "为什么先做这个", "expect": "预期收益" } ],',
  '  "coverage": { "checked": 0, "unknown": 0 }',
  '}',
].join('\n');

/**
 * 构造诊断 prompt。
 * @param {object} p { brand, industry, companyType, targetCustomers, competitors, scanContext }
 */
export function buildExposurePrompt(p = {}) {
  const brand = str(p.brand) || '（当前企业）';
  const typeKey = p.companyType || 'unknown';
  const typeLabel = COMPANY_TYPE_LABEL[typeKey] || COMPANY_TYPE_LABEL.unknown;
  const customers = (Array.isArray(p.targetCustomers) ? p.targetCustomers : [])
    .map((x) => str(x))
    .filter(Boolean);
  const competitors = (Array.isArray(p.competitors) ? p.competitors : [])
    .map((x) => str(x))
    .filter(Boolean);

  const lines = [];
  lines.push('你是 GEO（生成式引擎优化）诊断引擎。你的输出必须是「诊断结论」，不是营销策划报告。');
  lines.push('');
  lines.push('【诊断对象】');
  lines.push('品牌/企业：' + brand);
  if (str(p.industry)) lines.push('所属行业：' + str(p.industry));
  lines.push('客户类型：' + typeLabel);
  if (customers.length) lines.push('目标客户：' + customers.join('、'));
  if (competitors.length) lines.push('参考竞品：' + competitors.join('、'));
  lines.push('');

  if (str(p.scanContext)) {
    lines.push('【已实抓到的真实数据】（可直接引用为 evidence，不要改写数字）');
    lines.push(str(p.scanContext));
    lines.push('');
  } else {
    lines.push('【已实抓到的真实数据】无（后端实抓不可用）。请联网检索；检索不到的一律标 unknown，不要凭空推断。若你**无法访问实时网络**，请把所有检查项标为 unknown 并注明「未联网核实」，不要用模型记忆冒充检索结果。');
    lines.push('');
  }

  lines.push('【绝对约束】');
  lines.push('1. ' + B2B_FORBIDDEN_RULE);
  lines.push('2. 只有当「目标客户」里出现 患者 / 到店 / 个人消费者 时，才允许出现地图标注、大众点评、美团、本地生活、到店引流相关的检查项。');
  lines.push('3. 每条 check 的 evidence 必须引用【已实抓到的真实数据】或你联网检索到的具体页面；找不到证据就把 status 设为 unknown，并在 evidence 里写「未获取到：原因」。严禁编造数字、收录量、阅读量、粉丝数。');
  lines.push('4. status 为 fail 或 warn 的项，必须给出可执行的 fix（action + steps + expect + effort）；pass 项的 fix 可为空对象。');
  lines.push('5. coverage.checked 填有真实证据的 check 数量，coverage.unknown 填证据不足的 check 数量，两者之和必须等于 checks 长度。');
  lines.push('6. 检查项控制在 6-10 条，按对本企业获客的影响排序。');
  lines.push('7. 只返回一个 JSON 对象，不要 markdown 围栏、不要任何解释文字。');
  lines.push('8. 能力诚实兜底：若你无法访问实时网络，禁止用「未检索到」暗示「已联网查过且没有」——必须如实写明「未联网核实」。');
  lines.push('');
  lines.push('【可选检查维度】（按客户类型挑选，不要照抄）');
  lines.push('- AI 可见度：目标客户问 AI 时品牌是否被提及、是否被推荐为采购/合作渠道');
  lines.push('- 搜索收录：官网与内容页是否被搜索引擎收录（site 收录数）');
  lines.push('- 内容资产：是否有可被 AI 引用的结构化内容（产品页 / 参数 / 问答 / 案例 / 资质）');
  lines.push('- 关键词覆盖：目标客户真正会搜的采购/选型关键词是否有内容承接');
  lines.push('- 品牌一致性：全网品牌名、官网域名、主体信息是否一致（AI 引用需要可信主体）');
  lines.push('- 权威引用：是否有第三方行业站点、协会、媒体引用过本企业');
  lines.push('- 竞品对比：与竞品相比的可见度差距');
  if (typeKey === 'b2c') {
    lines.push('- 本地生活：地图标注、点评口碑、到店路径（仅 B2C 允许）');
  }
  lines.push('');
  lines.push('【输出 JSON 结构】');
  lines.push(EXPOSURE_JSON_TEMPLATE);
  return lines.join('\n');
}

/** 兼容旧命名的别名。 */
export const buildDiagnosePrompt = buildExposurePrompt;

/**
 * 构造 GEO 曝光的**精炼检索词**（品牌 + 行业 + 可见度/收录关键词 + 竞品）。
 *
 * T16 动机：诊断 prompt（buildExposurePrompt）很长，直接当检索词会被 deriveQuery 截断到 200 字，
 * 命中率极差。这里单独给出一句短检索词，避免「把整段 prompt 丢给搜索 API」。
 * @param {{brand?:string, industry?:string, companyType?:string, competitors?:Array|string}} p
 * @returns {string}
 */
export function buildExposureQuery(p = {}) {
  const brand = str(p.brand);
  const industry = str(p.industry);
  const comps = (Array.isArray(p.competitors) ? p.competitors : [])
    .map((x) => str(x))
    .filter(Boolean)
    .slice(0, 4);
  return [brand, industry, 'AI 搜索 可见度 官网收录 品牌 曝光', comps.join(' ')]
    .filter(Boolean)
    .join(' ');
}

/**
 * 由「一次检索返回」判定来源文案（T16 诚实化；T18 收口撒谎窗口）：
 *   · 真检索实现（返回体含 results 字段，即 searchWebGrounded 或其等价实现）→
 *     用**本次检索的直接证据**（groundedHealth）诚实标注：「联网检索（X 实检 N 条）」/「未确认」/「未联网」；
 *   · 旧式实现（仅 {ok, content}，无 results 字段）→ **本轮没有拿到任何检索结果**，即无「本轮直接证据」。
 *
 * ⚠️ T18 撒谎窗口收口（QA T17 实测复现）：
 *   探针缓存（getCachedWebSearchHealth / checkWebSearchHealth）只能回答「联网**通不通**」，
 *   **绝不能**用于「本轮实检到 N 条」这种需要**本轮直接证据**的表述。
 *   T16 旧实现在此 `describeSource(kind, fallbackHealth)`：当探针缓存 available:true（webApi:true、
 *   probeCount:9）时，会谎称「联网检索（tavily 实检 9 条）」——而本轮一个页面都没拿到。
 *
 *   故此处**一律回退到最保守档**（未确证 / 联网状态未确认）：
 *     · 探针已确证「未联网」（available === false）→ 沿用「未联网」档（如「未联网 · 模型推断」）；
 *     · 其余（含探针说通 available:true / 未知 null）→「模型分析（联网状态未确认）」。
 *   两条都不含「实检」字样、都不出现「联网检索」，即**不得**用探针缓存冒充本轮实检条数。
 *
 *   为何 available:true 不保留「联网检索」字样？因为 res 无 results 字段 = 来源不明（可能是调用方
 *   注入的自定义实现，未必是联网），且本轮确未拿到资料 —— 宁可少说、绝不多说（over-claim 是红线）。
 *
 * @param {object} res 检索返回
 * @param {string} kind SOURCE_KINDS
 * @param {object} fallbackHealth 探针缓存 health —— 仅用于判定「是否已确证未联网」，不再用于实检条数
 * @returns {string}
 */
export function pickGroundedSource(res, kind, fallbackHealth) {
  if (res && Array.isArray(res.results)) {
    const n = res.results.length;
    return describeSourceWithCount(kind, groundedHealth(res), n);
  }
  // 无本轮直接证据 → 只允许两条保守档：已确证未联网 / 未确证。绝不出现「实检 N 条」。
  const avail = fallbackHealth && typeof fallbackHealth === 'object' ? fallbackHealth.available : null;
  return describeSource(kind, { available: avail === false ? false : null });
}

/** 可见度概率 → 中文等级。 */
function probLevel(prob) {
  const p = Number(prob) || 0;
  if (p >= 0.6) return '高';
  if (p >= 0.2) return '中';
  if (p > 0) return '低';
  return '未收录';
}

/**
 * 把后端实抓结果转成给 AI 看的上下文文本（纯客观数字，不做结论）。
 */
export function buildScanContext(result, brand) {
  const r = result || {};
  const self = r.self || {};
  const comps = Array.isArray(r.competitors) ? r.competitors : [];
  const lines = [];
  lines.push('- 我方（' + (str(self.name) || str(brand) || '当前企业') + '）：AI 盲测提及概率 ' + Math.round((num(self.mention_prob)) * 100) + '%；搜狗 site 官网收录 ' + (self.indexed_count == null ? '未获取到' : self.indexed_count + ' 条') + '；情感倾向 ' + (str(self.sentiment_cn) || '未获取到'));
  if (Array.isArray(self.questions) && self.questions.length) {
    lines.push('  盲测提问与结果：');
    for (const q of self.questions.slice(0, 10)) {
      const qq = str((q && (q.question || q.q || q.prompt)) || '');
      const hit = q && (q.mentioned || q.hit);
      lines.push('    · ' + (qq || '（未记录问题）') + ' → ' + (hit ? '提及我方' : '未提及我方'));
    }
  }
  for (const c of comps) {
    if (!c) continue;
    lines.push('- 竞品（' + (str(c.name) || '竞品') + '）：AI 盲测提及概率 ' + Math.round(num(c.mention_prob) * 100) + '%；官网 site 收录 ' + (c.indexed_count == null ? '未获取到' : c.indexed_count + ' 条'));
  }
  if (str(r.conclusion)) lines.push('- 后端原始结论：' + str(r.conclusion));
  return lines.join('\n');
}

/** 归一化单条 check（AI 输出可能缺字段，这里全部兜底，绝不因为脏数据崩 UI）。 */
export function normalizeCheck(c, i = 0) {
  const base = c && typeof c === 'object' ? c : {};
  const st = str(base.status).toLowerCase();
  const status = ['pass', 'warn', 'fail', 'unknown'].includes(st) ? st : 'unknown';
  const sev = str(base.severity).toLowerCase();
  const severity = ['high', 'mid', 'low'].includes(sev) ? sev : (status === 'fail' ? 'high' : status === 'warn' ? 'mid' : 'low');
  const fixRaw = base.fix && typeof base.fix === 'object' ? base.fix : {};
  const steps = Array.isArray(fixRaw.steps) ? fixRaw.steps.map((s) => str(s)).filter(Boolean) : [];
  const name = str(base.name) || ('检查项 ' + (i + 1));
  return {
    id: str(base.id) || ('chk_' + i),
    name,
    dimension: str(base.dimension) || '其他',
    status,
    severity,
    evidence: str(base.evidence),
    why: str(base.why),
    fix: {
      action: str(fixRaw.action),
      steps,
      expect: str(fixRaw.expect),
      effort: str(fixRaw.effort),
    },
  };
}

function normalizePlatformScore(p) {
  const base = p && typeof p === 'object' ? p : {};
  const platform = str(base.platform || base.name);
  if (!platform) return null;
  let score = num(base.score, NaN);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { platform, score, note: str(base.note) };
}

function normalizePriority(p) {
  const base = p && typeof p === 'object' ? p : {};
  const title = str(base.title || base.add);
  if (!title) return null;
  return { title, why: str(base.why), expect: str(base.expect || base.how) };
}

/** 归一化 AI 返回的整个 JSON。 */
function normalizeResult(obj, source, realScan) {
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const checks = (Array.isArray(o.checks) ? o.checks : []).map(normalizeCheck);

  let checked = 0;
  let unknown = 0;
  for (const c of checks) {
    if (c.status === 'unknown') unknown += 1;
    else checked += 1;
  }
  const covRaw = o.coverage && typeof o.coverage === 'object' ? o.coverage : {};
  const coverage = {
    checked: Number.isFinite(num(covRaw.checked, NaN)) ? num(covRaw.checked, 0) : checked,
    unknown: Number.isFinite(num(covRaw.unknown, NaN)) ? num(covRaw.unknown, 0) : unknown,
  };
  if (coverage.checked + coverage.unknown !== checks.length) {
    coverage.checked = checked;
    coverage.unknown = unknown;
  }

  let overallScore = num(o.overallScore, NaN);
  if (!Number.isFinite(overallScore)) {
    // 兜底：按 check 状态折算，不用编造的分数
    const total = checks.length || 1;
    const got = checks.reduce((s, c) => s + (c.status === 'pass' ? 100 : c.status === 'warn' ? 55 : c.status === 'fail' ? 15 : 40), 0);
    overallScore = Math.round(got / total);
  }
  overallScore = Math.max(0, Math.min(100, Math.round(overallScore)));

  const grade = str(o.grade) || (overallScore >= 80 ? '优' : overallScore >= 60 ? '良' : overallScore >= 40 ? '中' : '差');

  return {
    ok: true,
    overallScore,
    grade,
    verdict: str(o.verdict) || str(o.summary),
    checks,
    platformScores: (Array.isArray(o.platformScores) ? o.platformScores : []).map(normalizePlatformScore).filter(Boolean),
    priorities: (Array.isArray(o.priorities) ? o.priorities : []).map(normalizePriority).filter(Boolean),
    coverage,
    source,
    realScan: realScan || null,
    error: '',
  };
}

/**
 * AI 不可用时的确定性兜底：只用实抓数字推导检查项，不写死行业建议、不涉及本地生活。
 */
export function checksFromRealScan(result, brand) {
  const r = result || {};
  const self = r.self || {};
  const comps = Array.isArray(r.competitors) ? r.competitors : [];
  const selfProb = num(self.mention_prob);
  const selfIdx = self.indexed_count;
  const bestComp = comps.reduce((m, c) => Math.max(m, num(c && c.mention_prob)), 0);
  const checks = [];

  checks.push({
    id: 'ai_visibility',
    name: 'AI 问答可见度',
    dimension: 'AI可见度',
    status: selfProb > 0 ? (selfProb >= 0.2 ? 'pass' : 'warn') : 'fail',
    severity: selfProb > 0 ? 'mid' : 'high',
    evidence: '后端问AI盲测：我方提及概率 ' + Math.round(selfProb * 100) + '%' + (comps.length ? '，竞品最高 ' + Math.round(bestComp * 100) + '%' : '') + '（数据来源：豆芽工作台 /api/geo/exposure 实抓）',
    why: '目标客户越来越先用 AI 问「该找谁采购/合作」，AI 不提及就等于在采购清单里缺席',
    fix: {
      action: '补齐可被 AI 引用的采购决策类内容',
      steps: [
        '梳理目标客户真实会问的选型/采购问题（参数、资质、价格区间、售后、配送）',
        '按一问一答结构发布到官网问答页与行业平台，答案里带品牌名与可验证参数',
        '每条内容保证有明确主体、时间、可验证数据，便于被引用',
      ],
      expect: 'AI 在同类采购提问中出现本品牌的概率提升，且引用来源可追溯',
      effort: '中',
    },
  });

  checks.push({
    id: 'search_index',
    name: '官网搜索收录',
    dimension: '搜索收录',
    status: selfIdx == null ? 'unknown' : (selfIdx > 0 ? 'pass' : 'fail'),
    severity: selfIdx == null ? 'mid' : (selfIdx > 0 ? 'low' : 'high'),
    evidence: selfIdx == null
      ? '未获取到：后端未返回 site 收录数（可能抓取失败或域名未提交），此处不做推断'
      : '搜狗 site 收录 ' + selfIdx + ' 条（数据来源：豆芽工作台 /api/geo/exposure 实抓）',
    why: '搜索引擎不收录，AI 就没有可信内容可引用，再好的产品页也进不了推荐链路',
    fix: {
      action: '提交并扩大官网收录',
      steps: ['提交 sitemap 到主流搜索引擎站长平台', '补充产品/资质/案例等静态页，避免全站动态渲染', '获取行业站点与协会的正规外链'],
      expect: 'site 收录数从 0 增长到可被检索到的量级',
      effort: '中',
    },
  });

  if (comps.length) {
    const gap = bestComp - selfProb;
    checks.push({
      id: 'competitor_gap',
      name: '竞品可见度差距',
      dimension: '竞品对比',
      status: gap > 0.2 ? 'fail' : gap > 0 ? 'warn' : 'pass',
      severity: gap > 0.2 ? 'high' : 'mid',
      evidence: '实抓对比：我方 ' + Math.round(selfProb * 100) + '% vs 竞品最高 ' + Math.round(bestComp * 100) + '%（' + comps.map((c) => str(c && c.name)).filter(Boolean).join('、') + '）',
      why: 'AI 推荐位有限，竞品被提及就意味着我方少一次进入客户候选池的机会',
      fix: {
        action: '针对竞品被提及的场景补齐对等内容',
        steps: ['记录竞品被 AI 提及的具体提问场景', '在同样场景发布更完整、参数更透明的对应内容', '每月复测一次提到率，观察差距收窄'],
        expect: '与头部竞品的提及率差距逐步收窄',
        effort: '中',
      },
    });
  }

  return checks;
}

/**
 * 实抓分支：把真实数据喂给 AI 生成 checks；AI 不可用则退化为基于实抓数字的推导。
 * 两条路与 LLM 分支最终收敛到同一套 schema。
 */
async function diagnoseFromRealScan(result, brand, meta, opts) {
  const scanContext = buildScanContext(result, brand);
  const prompt = buildExposurePrompt({
    brand,
    industry: meta.industry,
    companyType: meta.companyType,
    targetCustomers: meta.targetCustomers,
    competitors: meta.competitors,
    scanContext,
  });

  let parsed = null;
  // 数据来源诚实化（T16）：默认改走**真检索**（searchWebGrounded）；来源由本次检索的**直接证据**决定。
  // 旧式探针缓存仅作「注入的旧实现」回退用（见 pickGroundedSource），不再是主判据。
  const webHealth = getCachedWebSearchHealth();
  if (!webHealth) { checkWebSearchHealth().catch(() => {}); }
  const searchFn = typeof opts.searchFn === 'function' ? opts.searchFn : searchWebGrounded;
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  // 显式精炼检索词，避免把整段诊断 prompt 截断成 200 字检索词。
  const query = str(opts.query) || buildExposureQuery({ brand, industry: meta.industry, competitors: meta.competitors });

  let res = null;
  try {
    res = await searchFn(prompt, { temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3, query, fetchFn: opts.fetchFn, chatFn });
  } catch {
    res = null;
  }
  let source;
  if (!res || res.ok !== true || !res.content) {
    // 降级到内网模型：没走真检索，来源照实标「未联网」。
    source = describeSource(SOURCE_KINDS.SCAN_INTERNAL, webHealth);
    try {
      res = await chatFn([{ role: 'user', content: prompt }], opts.ctx, { temperature: 0.3, reasoningEffort: 'none' });
    } catch {
      res = null;
    }
  } else {
    source = pickGroundedSource(res, SOURCE_KINDS.SCAN_WEB, webHealth);
  }
  if (res && res.ok === true && res.content) {
    const j = extractJSON(res.content);
    if (j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.checks) && j.checks.length) {
      parsed = j;
    }
  }

  if (parsed) {
    return normalizeResult(parsed, source, result);
  }

  // 退化：只用实抓数字推导，仍然输出 checks 结构
  const checks = checksFromRealScan(result, brand);
  const checked = checks.filter((c) => c.status !== 'unknown').length;
  const unknown = checks.length - checked;
  const got = checks.reduce((s, c) => s + (c.status === 'pass' ? 100 : c.status === 'warn' ? 55 : c.status === 'fail' ? 15 : 40), 0);
  const overallScore = checks.length ? Math.round(got / checks.length) : 0;
  return {
    ok: true,
    overallScore,
    grade: overallScore >= 80 ? '优' : overallScore >= 60 ? '良' : overallScore >= 40 ? '中' : '差',
    verdict: '已按后端实抓数据完成规则化诊断（AI 生成不可用，以下结论均由实抓数字推导，未做主观推断）。',
    checks,
    platformScores: [],
    priorities: checks
      .filter((c) => c.status === 'fail' || c.status === 'warn')
      .slice(0, 3)
      .map((c) => ({ title: c.fix.action || c.name, why: c.why, expect: c.fix.expect })),
    coverage: { checked, unknown },
    source: '后端实抓（规则推导）',
    realScan: result,
    error: '',
  };
}

/**
 * 执行 GEO 曝光度诊断。
 * @param {object} params { company, asset, knowledge, goalLabel }
 * @param {object} opts { geoProxy, searchFn, chatFn, temperature }
 * @returns {Promise<{ok:boolean, overallScore:number, grade:string, verdict:string, checks:Array,
 *   platformScores:Array, priorities:Array, coverage:{checked:number,unknown:number},
 *   source:string, error:string}>}
 */
export async function diagnoseExposure(params = {}, opts = {}) {
  // T16：默认改走**真检索**（searchWebGrounded）；显式注入的 searchFn 仍优先（单测/特殊场景）。
  const searchFn = typeof opts.searchFn === 'function' ? opts.searchFn : searchWebGrounded;
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const proxyFn = typeof opts.geoProxy === 'function' ? opts.geoProxy : geoProxy;
  const ctx = buildAIContext(params);
  const fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : undefined;

  const company = params.company || {};
  const asset = params.asset || {};
  const brand = str(company.name) || str(asset.companyName);
  const industry = str(asset.industry);
  const targetCustomers = (Array.isArray(asset.targetCustomers) ? asset.targetCustomers : [])
    .map((x) => str(x))
    .filter(Boolean);
  const competitors = (Array.isArray(asset.competitors) ? asset.competitors : [])
    .map((x) => str(x))
    .filter(Boolean);
  const companyType = inferCompanyType(asset, company);

  const meta = { industry, companyType, targetCustomers, competitors };

  // ===== 1) 后端实抓优先 =====
  if (brand) {
    try {
      const r = await proxyFn('/api/geo/exposure', 'POST', { company_name: brand, competitor_names: competitors });
      if (r && r.ok === true && r.result && r.result.metric_method === 'real_scan') {
        return await diagnoseFromRealScan(r.result, brand, meta, { ...opts, searchFn, chatFn, ctx });
      }
    } catch {
      /* 后端不可用则降级 */
    }
  }

  // ===== 2) 降级：内网 LLM 联网检索 =====
  const prompt = buildExposurePrompt({ brand, industry, companyType, targetCustomers, competitors, scanContext: '' });

  let res = null;
  // 数据来源诚实化（T16）：来源由本次真检索的**直接证据**决定（有实检结果 → 「联网检索（X 实检 N 条）」）；
  // 探针缓存仅作「旧式注入实现」回退用。
  const webHealth = getCachedWebSearchHealth();
  if (!webHealth) { checkWebSearchHealth().catch(() => {}); }
  const query = buildExposureQuery({ brand, industry, companyType, competitors });
  try {
    res = await searchFn(prompt, { temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3, query, fetchFn, chatFn });
  } catch {
    res = null;
  }
  let source;
  if (!res || res.ok !== true || !res.content) {
    source = describeSource(SOURCE_KINDS.INTERNAL, webHealth);
    try {
      res = await chatFn([{ role: 'user', content: prompt }], ctx, { temperature: 0.3, reasoningEffort: 'none' });
    } catch {
      res = null;
    }
  } else {
    source = pickGroundedSource(res, SOURCE_KINDS.WEB, webHealth);
  }
  if (!res || res.ok !== true || !res.content) {
    return {
      ok: false,
      overallScore: 0,
      grade: '',
      verdict: '',
      checks: [],
      platformScores: [],
      priorities: [],
      coverage: { checked: 0, unknown: 0 },
      source,
      error: (res && res.error) || '诊断失败',
    };
  }

  const parsed = extractJSON(res.content);
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  if (!Array.isArray(obj.checks) || !obj.checks.length) {
    return {
      ok: false,
      overallScore: 0,
      grade: '',
      verdict: '',
      checks: [],
      platformScores: [],
      priorities: [],
      coverage: { checked: 0, unknown: 0 },
      source,
      error: '诊断结果无法解析（未返回 checks 结构）',
    };
  }

  return normalizeResult(obj, source, null);
}

export default { diagnoseExposure, buildExposurePrompt, buildExposureQuery, pickGroundedSource, inferCompanyType, B2B_FORBIDDEN_RULE };
