/**
 * marketDiagnosis —— 「经营诊断面板」诊断服务。
 *
 * 2026-09-12 信息架构重排（包 B）：由 7 维扩为 **11 维**。
 * 老板原话：「经营诊断要多方面对比，比如声浪 活动 用户反馈，没有你就联网大模型去搜一下」，
 * 以及「经营诊断里面放 竞品对比 GEO SEO曝光对比 别的地方不要放了」——
 * 因此**竞品对比 / GEO / SEO 曝光对比 的唯一展示出口就是本模块**，
 * 本服务是这三项对比数据的唯一组装点。
 *
 * 设计契约：
 * 1. 主函数 diagnoseMarket(params, opts) 输出统一结构的 **11 个维度**，顺序固定（见 DIMENSION_ORDER）。
 *    每个维度：{ id, title, status, basis, source, needsVerify, finding, advice,
 *                actionLabel, actionModule }
 * 2. 数据来源优先级（与 geoExposure 一致）：
 *    - GEO 维度复用 diagnoseExposure 的真实实抓（问 AI 盲测 + 搜狗 site 收录）；
 *    - competitor / seo_exposure_compare / seo 由本地事实（asset.competitors、site 收录）实抓构建；
 *    - media_volume / content_activity / user_feedback 由一次 AI 联网检索补充；
 *    - market_share / blue_ocean 由 AI 联网检索；
 *    - do_now / optimize 综合归纳前面所有维度；AI 失败则规则化兜底。
 * 3. 数据诚实红线（三态必须显式标注，缺省一律按 inferred）：
 *    - basis='measured'（有实测数字支撑）→ UI 显示「实测」；
 *    - basis='inferred'（AI 推断）→ UI 显示「AI 推断」；
 *    - needsVerify=true（联网且无可靠源，只给档位）→ UI 显示「待核验」；
 *    - 信息不足**不得补全为事实**，禁止编造市场份额百分比 / 排名 / 收录量 / 粉丝数 / 疗效 / 案例 / 专家评价。
 * 4. 没有任何结论时 ok=false（让 UI 亮错误条 + 「重新诊断」），绝不用满屏兜底标签冒充「诊断成功」。
 *
 * 纯函数 + 一个 async 主函数，方便测试注入 searchFn / chatFn / geoProxy。
 */

import { chatOnce, searchWeb, geoProxy, fetchWebSearch } from '../api.js';
import {
  getCachedWebSearchHealth,
  checkWebSearchHealth,
  describeSource,
  describeSourceWithCount,
  SOURCE_KINDS,
} from './webSearchHealth.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';
import {
  diagnoseExposure,
  buildScanContext,
  inferCompanyType,
  COMPANY_TYPE_LABEL,
} from './geoExposure.js';
import { buildAiSearchVisibility } from './marketSignal.js';
import { detectGeoGap } from './douyaGeoGuide.js';
// 2026-09-21 缺陷修复：自家品牌 / 旗下 IP 的排除护栏。
// 根因：本模块的 11 维 prompt 只拿到 competitors，**从没拿到 brandIps**，于是在
// 「竞品名单为空 → 你必须自己联网找 3-5 家同业」的强制要求下，模型把自家子品牌
// （康健苗苗 → 上游货源）当成了竞品。详见 services/selfBrandGuard.js 头注释。
import {
  collectSelfBrandNames,
  excludeSelfBrands,
  findSelfBrandConflicts,
  selfBrandPromptLines,
} from './selfBrandGuard.js';

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean);
  if (typeof v === 'string') return [str(v)].filter(Boolean);
  return [];
}

/** 数据缺失时的诚实兜底文案。 */
const NO_DATA_FINDING = '这次没查到这一项的可靠情况';
const NO_DATA_ADVICE = '点右上角「重新诊断」让豆芽联网再查一次；也可以先在企业档案里把竞品、客户补全，豆芽下次能查得更准。';

/**
 * T11②（2026-09）真实联网检索参数。
 *
 * 背景：`searchWeb` 走内网网关的 enable_search，实测该网关**静默忽略**该参数（从不真的上网），
 * 于是经营诊断的「AI 联网诊断」实际上是纯模型推断。本模块现在在调 AI 前先跑**真检索**
 * （fetchWebSearch → 主进程直连 tavily/bocha），把真网页资料注入 prompt，11 维才有真材料。
 *
 * 参数刻意收敛：查询条数有硬上限（避免一次问太多导致检索失焦 + 拖慢老板的等待），
 * 每次条数 5，注入条数再截断一次（防 prompt 被撑爆）。
 */
/** 单次诊断最多发起的真实检索次数（硬编码上限）。 */
export const MAX_WEB_QUERIES = 3;
/** 每次真实检索的条数（5-8 之间）。 */
export const WEB_FACTS_PER_QUERY = 5;
/** 注入 prompt 的公开资料条数上限（聚合去重后仍可能偏多，再截断一次）。 */
export const WEB_FACTS_MAX_INJECT = 9;
/** 单次真实检索超时（毫秒）；3 次并行，总等待 ≈ 该值，保证「点一下」不至于干等太久。 */
export const WEB_SEARCH_TIMEOUT_MS = 8000;

/** 11 个维度的固定顺序（标题与 id）。顺序即 UI 渲染顺序，勿随意调整。 */
export const DIMENSION_ORDER = [
  { id: 'competitor', title: '竞品对比' },
  { id: 'geo', title: 'GEO' },
  { id: 'seo_exposure_compare', title: 'SEO 曝光对比' },
  { id: 'media_volume', title: '声浪' },
  { id: 'content_activity', title: '活动' },
  { id: 'user_feedback', title: '用户反馈' },
  { id: 'seo', title: 'SEO' },
  { id: 'market_share', title: '市场占有率' },
  { id: 'blue_ocean', title: '未来蓝海' },
  { id: 'do_now', title: '现在应该做什么' },
  { id: 'optimize', title: '怎么优化' },
];

/** 「联网补充」维度集合：这三个维度没有本地实测数据，只要不是实测就必须标「待核验」。 */
export const NET_SUPPLEMENT_IDS = ['media_volume', 'content_activity', 'user_feedback'];

/** 数据来源的展示口径（与 status 正交，供 UI 直接展示「来源：xxx」）。 */
export const SOURCE_LABEL = {
  measured: '实测',
  inferred: 'AI 推断',
  needsVerify: '待核验',
};

/** status → 中文标签（供 UI 渲染复用）。
 *
 * unknown 一律说「没查到」而不是「未知」（2026-09-12 收口）：
 * 老板原话「全是未知？？？我要这个有啥用」——「未知」看起来像系统坏了，
 * 「没查到」是实话 + 暗示可以再查一次。
 */
export const STATUS_LABEL = {
  strong: '强',
  weak: '弱',
  unknown: '没查到',
};

/** basis → 该结论的可靠性来源（红线：事实与推断不得混淆）。 */
export const BASIS_LABEL = {
  measured: '有实测数据',
  inferred: 'AI 推断',
  '': '',
};

/**
 * 把 AI 返回的任意 status 文本归一化为 strong / weak / unknown。
 *
 * 注意：新旧 prompt 都兼容 —— 老模型可能仍返回带「推断」字样的状态，
 * 这里统一交给 normalizeBasis 处理，status 本身只回答「偏强还是偏弱」。
 */
export function normalizeStatus(v) {
  const s = str(v).toLowerCase();
  if (!s) return 'unknown';
  if (/强|好|优|高|strong|good|pass|healthy|领先/.test(s)) return 'strong';
  if (/弱|差|低|不足|落后|poor|weak|bad|fail|low|risk|危机/.test(s)) return 'weak';
  return 'unknown';
}

/**
 * 归一化 basis（结论来源）：measured（有实测数字支撑）/ inferred（AI 推断）/ ''（无结论）。
 *
 * 兼容模型的各种写法：measured / measured_data / 实测 / 有数据 → measured；
 * inferred / 推断 / 推测 / estimated / 估计 → inferred。
 * 缺省策略：**只要给了 status 却没给 basis，一律按 inferred 处理** ——
 * 宁可在 UI 上多标一个「AI 推断」，也不能把推断伪装成实测（红线）。
 */
export function normalizeBasis(v, status) {
  const st = str(status) || '';
  if (!st || st === 'unknown') return '';
  const s = str(v).toLowerCase();
  if (/measured|实测|有数据|有据|数据支撑/.test(s)) return 'measured';
  if (/inferred|推断|推测|估算|估计|estimated|reason/.test(s)) return 'inferred';
  return 'inferred';
}

/**
 * 联网补充维度的来源标注归一（2026-09-14 老板拍板 C 项）。
 *
 * 三态标注交由联网大模型判断，但「实测」不是随便标的：模型说 measured 就必须给出 source。
 * 只标 measured 却拿不出来源的一律降级为 inferred —— 红线：不得把推断伪装成实测。
 * 降级后 deriveNeedsVerify 会照常给它打上「待核验」（inferred 且未自述有据）。
 *
 * @param {object} raw AI 原始返回
 * @returns {string} 'measured' | 'inferred' | ''
 */
function resolveNetBasis(raw) {
  const status = normalizeStatus(raw && raw.status);
  const basis = normalizeBasis(raw && raw.basis, status);
  if (basis === 'measured' && !str(raw && raw.source)) return 'inferred';
  return basis;
}

/**
 * 「待核验」三态标记（红线：联网补来的维度只要不是实测，就必须显式标「待核验」）。
 *
 * 判据：
 * - 非联网补充维度（本地事实 / 实抓）不标；
 * - status 为 unknown（没查到）或 advice（建议型维度）不标 —— 那是「没数据」，不是「有结论但未核验」；
 * - basis=measured（有实测数字支撑）不标；
 * - 其余一律 true（缺省按「未核验」处理，宁多标不可漏标）；
 * - AI 若显式返回 needsVerify=false（自述有可靠来源），尊重之。
 *
 * @param {string} status strong|weak|advice|unknown
 * @param {string} basis measured|inferred|''
 * @param {boolean} net 该维度是否属于「联网补充」维度
 * @param {object} [raw] AI 原始返回
 * @returns {boolean}
 */
export function deriveNeedsVerify(status, basis, net, raw) {
  if (!net) return false;
  if (!status || status === 'unknown' || status === 'advice') return false;
  if (basis === 'measured') return false;
  if (raw && typeof raw === 'object' && raw.needsVerify === false) return false;
  return true;
}

/**
 * 组合出 UI 直接可用的状态标签。
 * @param {string} status strong / weak / unknown
 * @param {string} basis measured / inferred / ''
 * @param {boolean} [needsVerify] 是否「待核验」（联网补的维度且无实测支撑）
 * @returns {{label:string, tone:string, verify:boolean}}
 *   tone ∈ strong | weak | unknown | inferred-weak | inferred-strong；
 *   verify=true 时 UI 需在状态标签旁再补一个「待核验」标记。
 */
export function statusLabel(status, basis, needsVerify) {
  if (status === 'unknown' || !status) return { label: '没查到', tone: 'unknown', verify: false };
  const inferred = basis === 'inferred';
  const base = status === 'strong'
    ? { label: inferred ? '偏强 · AI 推断' : '强', tone: inferred ? 'inferred-strong' : 'strong' }
    : { label: inferred ? '偏弱 · AI 推断' : '弱', tone: inferred ? 'inferred-weak' : 'weak' };
  return { ...base, verify: needsVerify === true };
}


/** AI 联网检索的 JSON 契约（一次调用产出 11 个维度）。
 *
 * basis 字段是 2026-09-11 新增（用户实测反馈「全是未知，我要这个有啥用」）：
 * 实测确证 —— 老版 prompt 写着「检索不到的一律标 unknown」「没有真实数据就 status 标 unknown」，
 * 模型百分之百照办，维度齐刷刷返回 unknown，而 finding/advice 其实写得很有料。
 * 老板看到一堆「未知」标签，等于这个面板没有价值。
 *
 * 因此拆成两个正交维度：
 *   status = 结论是偏强还是偏弱（必须给！）
 *   basis  = 这个结论是「实测数字支撑」还是「AI 推断」（由 UI 据实标注，不混淆事实与推断）
 * 2026-09-12 再补第三态 needsVerify：联网且无可靠来源时标 true，UI 显示「待核验」（只给档位不给数字）。
 * 红线不变：**不得编造具体数字**（份额% / 排名 / 收录量 / 粉丝数 / 疗效 / 案例 / 专家评价）。
 */
export const MARKET_JSON_TEMPLATE = [
  '{',
  '  "competitor": { "status": "strong|weak", "basis": "measured|inferred", "finding": "我方 vs 竞品的差距现状", "advice": "怎么缩小差距" },',
  '  "geo": { "status": "strong|weak", "basis": "measured|inferred", "finding": "在 AI 搜索答案里的可见性现状", "advice": "怎么补 AI 搜索声量" },',
  '  "seo_exposure_compare": { "status": "strong|weak", "basis": "measured|inferred", "finding": "我方与竞品在搜索引擎收录/曝光上的对比", "advice": "怎么补 SEO 曝光" },',
  // 2026-09-14 老板拍板 C 项：这三个维度的来源标注**由联网大模型自己判断**，不再由代码硬编码成 inferred + needsVerify。
  //   查到可核验的公开来源 → basis="measured" 且把来源写进 source；只靠推断 → basis="inferred" 且 needsVerify=true。
  //   防护仍在：标了 measured 却不写 source 的，产品侧 resolveNetBasis 会降回 inferred（不许谎称实测）。
  '  "media_volume": { "status": "strong|weak", "basis": "measured|inferred", "source": "你据以判断的公开来源（检索不到就留空）", "finding": "声浪档位（强/中/弱）+ 依据", "advice": "怎么提升声浪", "needsVerify": true或false },',
  '  "content_activity": { "status": "strong|weak", "basis": "measured|inferred", "source": "你据以判断的公开来源（检索不到就留空）", "finding": "活动/内容发布活跃度的档位 + 依据", "advice": "怎么提升活动活跃度", "needsVerify": true或false },',
  '  "user_feedback": { "status": "strong|weak", "basis": "measured|inferred", "source": "你据以判断的公开来源（检索不到就留空）", "finding": "公开口碑/用户反馈的档位 + 依据", "advice": "怎么改善用户口碑", "needsVerify": true或false },',
  '  "seo": { "status": "strong|weak", "basis": "measured|inferred", "finding": "一句话现状", "advice": "怎么做/怎么优化" },',
  '  "market_share": { "status": "strong|weak", "basis": "measured|inferred", "finding": "一句话现状", "advice": "怎么做" },',
  '  "blue_ocean": { "status": "strong|weak", "basis": "measured|inferred", "finding": "增长空间/未被满足的机会", "advice": "怎么做" },',
  '  "do_now": { "finding": "当下最该做的 1-3 件事（按优先级）", "advice": "具体怎么落地" },',
  '  "optimize": { "finding": "可执行的优化路径", "advice": "分步骤怎么做" }',
  '}',
].join('\n');


/**
 * 构造经营诊断 prompt（11 维）。
 * @param {object} p { brand, industry, companyType, targetCustomers, competitors, selfBrands,
 *                     scanContext, webFacts, geoSummary, geoGapReason }
 *   · scanContext —— 后端爬虫**实抓**到的真实数据段；
 *   · webFacts    —— T11② 真实搜索引擎**实检**到的公开资料段（buildWebFactsContext 渲染，
 *                    失败时传空串 = 不注入；与 scanContext 语义区分，不可混用标题）。
 *   · selfBrands  —— 本企业自有品牌 / 旗下 IP（collectSelfBrandNames 产物）。
 *                    2026-09-21 新增：此前本函数**根本没有这个入参**，于是模型在
 *                    「竞品名单为空必须自己找 3-5 家同业」时把自家子品牌（上游货源）当竞品。
 *                    现在注入明确排除段；缺省不传 = 零注入（与改动前逐字一致）。
 */
export function buildMarketPrompt(p = {}) {
  const brand = str(p.brand) || '（当前企业）';
  const typeLabel = COMPANY_TYPE_LABEL[p.companyType] || COMPANY_TYPE_LABEL.unknown;
  const customers = asList(p.targetCustomers);
  const competitors = asList(p.competitors);
  const selfBrands = asList(p.selfBrands);
  const selfBrandLines = selfBrandPromptLines(selfBrands);

  const lines = [];
  lines.push('你是企业经营诊断引擎，为一家企业做「竞品对比 / GEO / SEO 曝光对比 / 声浪 / 活动 / 用户反馈 / SEO / 市场占有率 / 未来蓝海 / 现在应该做什么 / 怎么优化」十一个维度的诊断。');
  lines.push('你只输出诊断结论，不写营销策划报告；所有结论必须基于真实检索数据，绝不编造。');
  lines.push('');
  lines.push('【诊断对象】');
  lines.push('企业：' + brand);
  if (str(p.industry)) lines.push('行业：' + str(p.industry));
  lines.push('客户类型：' + typeLabel);
  if (customers.length) lines.push('目标客户：' + customers.join('、'));
  if (selfBrandLines.length) {
    lines.push('');
    lines.push(...selfBrandLines);
  }
  if (competitors.length) {
    lines.push('竞品：' + competitors.join('、'));
  } else {
    // 2026-09-14 老板拍板 A 项：企业没登记竞品名单时，绝不允许退化成「请先补充竞品信息」这种空话，
    // 一律由大模型自己联网把同业竞品找出来做对比。老板原话：「直接交给联网大模型 他会告诉你的」。
    lines.push('竞品：（企业尚未登记，需要你自己联网找）');
    lines.push('');
    lines.push('【本次特别要求 · 竞品名单缺失】企业没有提供竞品名单，你必须自己联网检索「' + brand + '」所在行业 / 区域 / 品类的主要同业企业（3-5 家），');
    lines.push('把它们作为本次竞品对比的基准，并在 finding 里写明你检索到的具体是谁。');
    lines.push('禁止因此返回 unknown，也禁止只回复「请先补充竞品信息」这类空话 —— 那是失职，不是诚实。');
    lines.push('若确实检索不到任何同业企业，就以「该品类的一般经营水平」为对照基准，并在 finding 里说明这是行业基准、而非某家具体竞品。');
    if (selfBrandLines.length) {
      // 2026-09-21 补：上面这条「必须自己找 3-5 家」是**压力源**——
      // 模型在凑不满数量时最容易顺手把自家子品牌算进去。这里再重申一次排除，并给出出路。
      lines.push('⚠️ 特别注意：上述「本企业自有品牌 / 旗下 IP」里的名字**一家都不能算**。');
      lines.push('它们在检索结果里出现，恰恰说明那是本企业自己的页面 / 报道，不是同业对手。');
      lines.push('排除它们之后同业不足 3 家，就按实际数量写（1-2 家也合格），绝不允许拿自家品牌凑数。');
    }
  }
  lines.push('');

  if (str(p.scanContext)) {
    lines.push('【已实抓到的真实数据】（可直接引用为 evidence，不要改写数字）');
    lines.push(str(p.scanContext));
    lines.push('');
  } else {
    lines.push('【已实抓到的真实数据】无（本轮未取到实测数字）。');
    lines.push('注意：这不等于「你什么都不能说」。请改用联网检索 + 行业通识给出定性判断，见下方第 1 条。');
    lines.push('');
  }

  // T11②：真实搜索引擎实检到的公开资料（与上面的「实抓」区分——那是后端爬虫，这里是外部搜索引擎）。
  // 由 buildWebFactsContext 渲染；失败时不注入（此处为空串），成功但 0 条时是一段如实的「没搜到」说明。
  if (str(p.webFacts)) {
    lines.push(str(p.webFacts));
    lines.push('');
  }

  if (str(p.geoSummary)) {
    lines.push('【GEO / AI 搜索曝光现状】（来自实抓）');
    lines.push(str(p.geoSummary));
    if (str(p.geoGapReason)) lines.push('结论：AI 搜索声量不足（' + str(p.geoGapReason) + '）');
    lines.push('');
  }

  lines.push('【最重要的输出要求 —— 先读懂这条，它决定你的输出合不合格】');
  lines.push('老板要的是「能拿去行动的方向」，不是「没数据所以我不知道」。');
  lines.push('1. 每个维度都必须给出明确结论：status 只能取 strong（偏强）或 weak（偏弱）之一，**不允许用 unknown 逃避判断**。');
  lines.push('   依据 = 你联网检索到的公开信息 + 该行业的一般商业常识（如「B2B 器械采购的决策链通常靠经销商与学术信任，纯 SEO 流量占比低」这类通识）。');
  lines.push('2. 若结论来自推断而非实测数字，把 basis 标成 "inferred"；有实测数字支撑则标 "measured"。');
  lines.push('   UI 会据实把 inferred 标注为「AI 推断」，所以你可以放心基于推理作答 —— 但绝不能把它伪装成实测。');
  lines.push('3. 数据来源诚实三态（红线）：');
  lines.push('   - 有实测数字支撑 → basis 标 "measured"；UI 显示「实测」。');
  lines.push('   - 查阅到公开信息后做推断 → basis 标 "inferred"；UI 显示「AI 推断」。');
  lines.push('   - 查不到可靠来源、只能给档位（强/中/弱）→ 把 needsVerify 标 true，finding 里写清你依据什么给的档位；');
  lines.push('     UI 会显示「待核验」。此时**不许编造具体数字**，只给档位与方向。');
  lines.push('   声浪 / 活动 / 用户反馈 这三个维度的 basis 与 needsVerify **由你根据检索结果自行判断**（2026-09-14 老板拍板 C 项）：');
  lines.push('   检索到可核验的公开来源（媒体报道 / 活动页 / 公开评价聚合）→ basis 标 "measured"，并把来源写进该维的 source 字段；');
  lines.push('   只能推断、拿不到可核验来源 → basis 标 "inferred" 且 needsVerify 标 true。标了 measured 却没写 source 会被产品降级为 AI 推断。');
  lines.push('4. **绝对不许编造具体数字 / 案例 / 专家评价 / 疗效**。以下一律禁止：市场份额百分比、行业排名名次、营收、粉丝数、收录量、SKU 精确数量、治疗效果、专家背书。');
  lines.push('   ❌ 反面：「市场份额约 12%」「行业排名第 3」「官网收录约 5000 条」「某专家推荐」');
  lines.push('   ✅ 正面：「未检索到公开份额数据；从渠道覆盖与平台 SKU 规模看，该企业相对励齿商城处于劣势」');
  lines.push('5. finding 必须说清「判断是什么 + 凭什么这么判断」；advice 必须是可执行动作，先易后难，不要泛泛而谈。');
  lines.push('6. do_now 与 optimize 要综合前面维度归纳（含实抓到的 GEO 现状）。do_now 至少给 1 条今天就能开始做的事。');
  lines.push('7. 若检索到的内容涉及医疗疗效承诺，只做「合规风险提示」，不要复制其疗效表述，也不要把疗效当作论据。');
  lines.push('8. 只返回一个 JSON 对象，不要 markdown 围栏、不要任何解释文字。');
  lines.push('');
  lines.push('【输出 JSON 结构】');
  lines.push(MARKET_JSON_TEMPLATE);
  return lines.join('\n');
}

// ==================== T11② 真实检索（查询构造 / 执行 / 注入 / 来源） ====================

/**
 * 构造经营诊断用的真实检索查询（≤ MAX_WEB_QUERIES 条，覆盖企业本身 / 竞品 / 声浪三类）。
 *
 * 覆盖意图：
 *   · 企业本身 —— 「公司公开信息」类维度的事实来源（成立 / 融资 / 业务）；
 *   · 竞品     —— 老板 A 项的关键：企业没登记竞品名单时，靠检索把同业「捞」出来；
 *   · 声浪舆情 —— 媒体报道 / 新闻类公开信息。
 * 词条刻意短、每次只承载一个意图，避免一次问太多导致检索失焦。
 *
 * 2026-09-21 补 `selfBrands`：检索词里**不得把自家品牌 / 旗下 IP 当竞品词**。
 * 场景（老板实测）：`asset.competitors` 若被上游污染（deepThink 竞品发现曾把子品牌当候选），
 * 查询会变成「康健苗苗 上游货源 …」——等于主动去检索自家品牌并当成同业，越搜越错。
 * 过滤后名单为空 → 退回行业维度找同业（正确方向）。缺省不传 = 与改动前逐字一致。
 *
 * @param {{brand?:string, industry?:string, competitors?:Array|string, selfBrands?:Array|string}} params
 * @returns {string[]} 去重后的检索词列表；无企业名时为空数组（无从检索）
 */
export function buildMarketSearchQueries(params = {}) {
  const brand = str(params.brand);
  const industry = str(params.industry);
  const selfBrands = asList(params.selfBrands);
  // 自家品牌先从竞品词里剔掉（剔掉了谁由 selfBrandGuard.excludeSelfBrands 留痕，
  // 这里只需保证检索词里不出现自家品牌）
  const competitors = excludeSelfBrands(asList(params.competitors), selfBrands).kept;
  if (!brand) return [];

  const queries = [];
  // ① 企业本身（公司公开信息）
  queries.push([brand, industry, '公司 成立 融资 业务'].filter(Boolean).join(' '));
  // ② 竞品 / 同业（老板 A 项：本地名单缺失也要联网把同业找出来）
  if (competitors.length) {
    queries.push([brand, competitors.slice(0, 3).join(' ')].filter(Boolean).join(' '));
  } else if (industry) {
    queries.push(industry + ' 主要企业 品牌');
  } else {
    queries.push(brand + ' 同业 竞争对手 主要企业');
  }
  // ③ 声浪 / 舆情（媒体报道类）
  queries.push(brand + ' 媒体报道 新闻');

  // 去重（保留顺序）+ 硬上限
  const out = [];
  for (const q of queries) {
    const s = str(q);
    if (s && !out.includes(s)) out.push(s);
  }
  const list = out.slice(0, MAX_WEB_QUERIES);
  return list;
}

/**
 * 单次真实检索（带超时兜底，**永不抛**）。
 * 超时兜底是必要的：注入的 fetchFn 若不理会 timeoutMs，也不该把整个诊断挂死。
 *
 * @param {string} query
 * @param {(q:string, o?:object)=>Promise<object>} fetchFn 检索实现（默认 fetchWebSearch）
 * @returns {Promise<{query:string, ok:boolean, provider:string, results:Array, error:string}>}
 */
async function searchOneQuery(query, fetchFn) {
  let timer = null;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => fetchFn(query, { count: WEB_FACTS_PER_QUERY, timeoutMs: WEB_SEARCH_TIMEOUT_MS })),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('检索超时（' + (WEB_SEARCH_TIMEOUT_MS + 3000) + 'ms）')),
          WEB_SEARCH_TIMEOUT_MS + 3000,
        );
      }),
    ]);
    return {
      query,
      ok: !!(raw && raw.ok === true),
      provider: (raw && raw.provider) || 'none',
      results: Array.isArray(raw && raw.results) ? raw.results : [],
      error: (raw && raw.error) || '',
    };
  } catch (e) {
    return { query, ok: false, provider: 'none', results: [], error: (e && e.message) || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 执行一批真实检索（并行），并聚合成一份可注入 prompt 的资料清单。
 *
 * 诚实的核心：**严格区分「失败」与「成功但没结果」**——
 *   · 全部 ok:false / 抛异常        → allFailed=true（调用方据此不注入资料段、来源走保守文案）；
 *   · 至少一条 ok:true              → anyOk=true；此时 results 仍可能为空（端点通但确实没搜到）。
 * 该区分是红线（绝不在失败时假装有材料）的结构保证。
 *
 * @param {string[]} queries 检索词（≤ MAX_WEB_QUERIES）
 * @param {(q:string, o?:object)=>Promise<object>} fetchFn 检索实现
 * @returns {Promise<{queries:Array, anyOk:boolean, allFailed:boolean, results:Array, provider:string}>}
 */
export async function runMarketWebSearch(queries, fetchFn) {
  const list = Array.isArray(queries) ? queries.filter((q) => str(q)) : [];
  const per = await Promise.all(list.map((q) => searchOneQuery(q, fetchFn)));

  const anyOk = per.some((p) => p.ok === true);
  const allFailed = per.length > 0 && per.every((p) => p.ok !== true);

  // 聚合去重（优先按 URL；无 URL 时按「标题|摘要前缀」去重）
  const seen = new Set();
  const results = [];
  for (const p of per) {
    for (const r of p.results) {
      const url = str(r && r.url);
      const key = url || (str(r && r.title) + '|' + str(r && r.content).slice(0, 60));
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      results.push(r);
    }
  }

  const provider =
    (per.find((p) => p.ok === true && p.provider && p.provider !== 'none') || {}).provider
    || (per[0] && per[0].provider)
    || 'none';

  return { queries: per, anyOk, allFailed, results, provider };
}

/**
 * 单条检索结果「是否可用」：title 或 content 去空白后至少一个非空才算可用。
 *
 * V4-B3 加固（2026-09）：检索端点可能返回 ok:true 但每条都是空白壳
 * （provider 通了却没解析出正文，title / content 全空、只剩 URL）。
 * 过去 buildWebFactsContext 只看 `results.length > 0` 就渲染「【已实检到的公开资料】」，
 * 等于对模型**假承诺「你有资料」**，实际一条可用资料都没有（违反本轮红线：
 * 本轮没拿到可用资料，就绝不出现「联网检索」字样 / 绝不假装有材料）。
 * 只有 URL 不算可用（有链接无正文，模型无法据以作答）。
 *
 * 非导出：仅供本模块 buildWebFactsContext 与 diagnoseMarket 共用，
 * 保证「渲染用的集合」与「计数用的集合」是**同一个**（避免来源标出虚高的「实检 N 条」）。
 *
 * @param {object} r 单条检索结果
 * @returns {boolean}
 */
function isUsableWebResult(r) {
  if (!r || typeof r !== 'object') return false;
  return str(r.title).length > 0 || str(r.content).length > 0;
}

/** 过滤出可用的检索结果（V4-B3：全空壳必须与真正的 0 条走同一分支）。 */
function usableWebResults(list) {
  return (Array.isArray(list) ? list : []).filter(isUsableWebResult);
}

/**
 * 把真实检索结果渲染成注入 11 维 prompt 的「公开资料」段。
 *
 * 三种情形语义严格区分（红线：绝不在失败时假装有材料）：
 *   · failed=true（检索全部失败）→ 返回 ''，**不注入任何资料段**；
 *   · 成功但 0 条**可用**资料（含「端点返回了若干条但全是空壳」）→ 注入**如实的
 *     「本次未检索到相关公开资料」说明**（让模型知道它没有材料，别编）；
 *   · 有可用资料 → 渲染 [n] 标题 / URL / 摘要 + 要求（已覆盖的维度 finding 必须与资料一致并注明依据）。
 *
 * 「可用」由 isUsableWebResult 判定：title 或 content 去空白后至少一个非空；只有 URL 不算可用。
 *
 * 段标题用「已实检到的公开资料」而非「已实抓到的真实数据」——后者是 scanContext（后端爬虫实抓）的语义，
 * 二者必须可区分，不可互相冒充。
 *
 * @param {{results?:Array, failed?:boolean}} outcome runMarketWebSearch 的产物（取 results / allFailed）
 * @returns {string}
 */
export function buildWebFactsContext(outcome = {}) {
  // V4-B3：先过滤掉空壳条目（title/content 全空）——全空壳必须与真正的 0 条走同一分支
  // （不渲染资料段、改渲染如实的「没搜到」说明），绝不向模型假承诺「有资料」。
  const results = usableWebResults(outcome.results);
  if (outcome.failed === true) return '';

  if (results.length === 0) {
    return [
      '【本次联网检索结果】',
      '本次未检索到相关公开资料（已调用真实搜索引擎，但未返回可用结果）。',
      '【要求】不得因此编造公开事实；资料未覆盖的维度，按行业通识给定性判断，basis 一律标 inferred。',
    ].join('\n');
  }

  const list = results.slice(0, WEB_FACTS_MAX_INJECT);
  const lines = ['【已实检到的公开资料】（来自真实搜索引擎，请优先依据这些资料作答）'];
  list.forEach((r, i) => {
    const title = str(r && r.title) || '(无标题)';
    const url = str(r && r.url);
    const content = str(r && r.content);
    lines.push(`[${i + 1}] ${title}`);
    if (url) lines.push(`URL: ${url}`);
    lines.push(`摘要: ${content || '(无摘要)'}`);
    lines.push('');
  });
  lines.push('【要求】凡上述资料已覆盖的维度，finding 必须与之一致并注明依据；资料未覆盖的维度，按行业通识给定性判断（basis 标 inferred）。');
  return lines.join('\n');
}

/**
 * 由「本次真实检索的成败」**直接解析**出用于来源标注的 health（比再跑一次探针更直接、更准）。
 *
 * 判据（红线：本轮没拿到资料，就绝不出现「联网检索」字样）：
 *   · 未发起检索（如无企业名）→ 退回探针缓存（保持原有行为）；
 *   · 拿到 ≥1 条资料            → { available:true, webApi:true } → 允许「联网检索（X 实检 N 条）」；
 *   · 端点可达但 0 条           → { available:null } → 「模型分析（联网状态未确认）」（未确证拿到外部资料）；
 *   · 本次检索全部失败          → { available:false } → 「未联网 · 模型推断」。
 *
 * 特别注意：**绝不**在本次检索失败时改用探针缓存的 available:true 冒充「联网检索」——
 * 本轮一份资料都没注入，诊断就是纯模型推断。
 *
 * @param {{anyOk:boolean, allFailed:boolean, results:Array, provider:string}} outcome
 * @param {boolean} searchAttempted 本轮是否真的发起了检索
 * @param {number} injected 实际注入 prompt 的资料条数
 * @returns {object|null} 供 describeSource / describeSourceWithCount 使用的 health
 */
export function resolveWebSourceHealth(outcome, searchAttempted, injected) {
  if (!searchAttempted) return getCachedWebSearchHealth();
  const n = Number(injected) > 0 ? Number(injected) : 0;
  const provider = (outcome && outcome.provider) || 'none';
  if (outcome && outcome.anyOk === true && n > 0) {
    return { available: true, webApi: true, provider, probeCount: n };
  }
  if (outcome && outcome.anyOk === true) {
    return { available: null, webApi: false, provider, probeCount: 0 };
  }
  return { available: false, webApi: false, provider, probeCount: 0 };
}

/**
 * 把 exposure 的 checks 摘要成一行行文本，供第二段 AI 归纳 do_now/optimize 时参考。
 */
export function exposureChecksText(exposure) {
  if (!exposure || exposure.ok !== true || !Array.isArray(exposure.checks) || !exposure.checks.length) {
    return '';
  }
  const lines = [];
  if (str(exposure.verdict)) lines.push('诊断结论：' + str(exposure.verdict));
  for (const c of exposure.checks) {
    const st = str(c.status) || 'unknown';
    const evidence = str(c.evidence) || '未获取到证据';
    lines.push(`- [${st}] ${str(c.name)}：${evidence}`);
  }
  return lines.join('\n');
}

// ==================== 维度组装（纯函数） ====================

/**
 * GEO 维度：优先用实抓可见性 + detectGeoGap（measured）；
 * 实抓拿不到数据时（vis.state 非 visible/not_found），退回 AI 的定性判断（inferred）。
 *
 * 2026-09-11 改动：老版本这里拿不到实抓就一律 unknown，导致老板看到「未知」。
 * 现在 AI 也产出一个 geo 判断兜底，但**必须标 inferred**，绝不冒充实测。
 */
export function buildGeoDimension(vis, geoGap, aiGeo, webHealth = null) {
  const gap = !!(geoGap && geoGap.gap);
  let status = 'unknown';
  let basis = '';
  let source = 'AI 搜索实抓（问 AI 盲测 + 搜索引擎 site 收录）';
  let finding = NO_DATA_FINDING;
  let advice = NO_DATA_ADVICE;

  if (vis && vis.state === 'visible') {
    basis = 'measured';
    source = 'AI 搜索实抓（实测）';
    if (gap) {
      status = 'weak';
      finding = str(vis.summary) || 'AI 搜索可见性核心场景覆盖不足';
      advice = '核心采购场景被 AI 提及的覆盖率不足，需要补一批可被 AI 引用的内容，把品牌重新写进采购决策答案里。';
    } else {
      status = 'strong';
      finding = str(vis.summary) || '企业在核心 AI 搜索场景中被提及';
      advice = '保持内容更新与权威引用，防止曝光回落。';
    }
  } else if (vis && vis.state === 'not_found') {
    basis = 'measured';
    source = 'AI 搜索实抓（实测）';
    status = 'weak';
    finding = str(vis.summary) || '核心搜索场景暂未发现企业被 AI 提及';
    advice = '优先补齐核心选型场景内容，让 AI 在采购决策提问里能引用本品牌。';
  } else {
    const st = normalizeStatus(aiGeo && aiGeo.status);
    if (st !== 'unknown') {
      status = st;
      basis = 'inferred';
      source = describeSource(SOURCE_KINDS.WEB, webHealth);
      finding = str(aiGeo && aiGeo.finding) || finding;
      advice = str(aiGeo && aiGeo.advice) || advice;
    }
  }

  return {
    id: 'geo',
    title: 'GEO',
    status,
    basis,
    source,
    needsVerify: deriveNeedsVerify(status, basis, false, aiGeo),
    finding,
    advice,
    actionLabel: status === 'weak' ? '补声量' : '',
    actionModule: '',
  };
}

/** SEO 维度：实抓 site 收录数规则基线，叠加 AI 联网结果。 */
export function buildSeoDimension(vis, raw, webHealth = null) {
  const indexed = vis && typeof vis.indexed === 'number' ? vis.indexed : null;
  const aiStatus = normalizeStatus(raw && raw.status);
  let status = 'unknown';
  let basis = '';
  let source = '搜索引擎 site 收录实抓 + ' + describeSource(SOURCE_KINDS.WEB, webHealth);
  let finding = str(raw && raw.finding) || NO_DATA_FINDING;
  let advice = str(raw && raw.advice) || NO_DATA_ADVICE;

  // 优先信 AI 有据结论；否则退回实抓 site 收录数推导。
  if (aiStatus !== 'unknown' && finding !== NO_DATA_FINDING) {
    status = aiStatus;
    basis = normalizeBasis(raw && raw.basis, aiStatus);
    source = (basis === 'measured' && webHealth && webHealth.available === true)
      ? '联网检索（含实测数字）'
      : describeSource(SOURCE_KINDS.WEB, webHealth);
  } else if (indexed != null) {
    // 实抓到的收录条数属于实测数据，basis 记 measured
    basis = 'measured';
    source = '搜索引擎 site 收录实抓（实测）';
    if (indexed > 0) {
      status = 'strong';
      finding = `官网已被搜索引擎收录（site 收录 ${indexed} 条）`;
      advice = '继续扩大收录与关键词覆盖，保持自然可见度。';
    } else {
      status = 'weak';
      finding = '官网暂无搜索引擎收录（site 收录 0 条）';
      advice = '提交 sitemap、补齐产品/资质/案例等静态页，并获取行业站点外链，让搜索引擎能收录官网。';
    }
  } else if (finding !== NO_DATA_FINDING) {
    // AI 给了文字但没给状态：文字保留，状态诚实标 unknown（无 basis）。
    status = 'unknown';
  }

  return {
    id: 'seo',
    title: 'SEO',
    status,
    basis,
    source,
    needsVerify: deriveNeedsVerify(status, basis, false, raw),
    finding,
    advice,
    actionLabel: status === 'weak' ? '去发文' : '',
    actionModule: status === 'weak' ? 'media' : '',
  };
}


/**
 * 竞品维度：优先用实抓的竞品曝光对比（measured），其次用 AI 的定性对比（inferred）。
 *
 * 【2026-09-12 缺陷修复】此前 `comps.length === 0` 时**直接 early-return**，把 AI 已经
 * 给出的竞品结论整个丢掉 —— 而同文件的 buildSeoExposureCompare 是「先 AI 后实测」，
 * 两个同类维度兜底顺序相反（是 bug，不是设计）。更糟的是：
 *   - buildMarketPrompt（L246）白纸黑字要求「每个维度都必须给出明确结论，不允许用 unknown
 *     逃避判断」，competitor 又是 JSON 模板首键 → AI 本来就会给强/弱判断，代码却把它扔了；
 *   - 老板原话「竞品分析…在经营诊断里面变成不知道了？什么都没有了……没有你就联网大模型去搜一下」
 *     —— 他要的正是「本地没有就联网补」。
 * 现改为与 buildSeoExposureCompare 一致的优先级：
 *   ① 实抓竞品曝光对比（measured）
 *   ② AI 定性对比（inferred）：有本地名单则叠加本地事实；无名单则纯联网推断并标「待核验」
 *   ③ 仅本地名单（无 AI、无实抓）
 *   ④ 全无：给「重新诊断」的动作指引，而不是只教用户手填
 *
 * actionModule 指向 'intel'（经营诊断自身）：竞品对比现在**只在经营诊断内嵌展示**，
 * 不再依赖 LEGACY_MODULE_ALIAS 把 'competitor' 兜到 'intel'。
 *
 * 2026-09-21 新增 `selfBrands`（本企业自有品牌 / 旗下 IP，见 selfBrandGuard）：
 *   · 本地名单里若混进了自家品牌（上游 deepThink 竞品发现曾被污染），先剔除再展示，
 *     否则维度卡会理直气壮地写「已登记竞品：上游货源」；
 *   · AI 仍把自家品牌写进 finding 时，产出 `selfBrandWarning`（**按实报告，不替用户改写文本**）。
 */
export function buildCompetitorDimension(competitors, exposure, aiCompetitor, webHealth = null, selfBrands = []) {
  const selfList = asList(selfBrands);
  const rawComps = asList(competitors);
  const { kept: comps, dropped: selfDropped } = excludeSelfBrands(rawComps, selfList);
  const hasLocal = comps.length > 0;

  const gapCheck =
    exposure && exposure.ok === true && Array.isArray(exposure.checks)
      ? exposure.checks.find((c) => c.id === 'competitor_gap' || c.dimension === '竞品对比')
      : null;

  // 【2026-09 修复】只有 gapCheck 给出**真实判定**（fail/warn/pass）时才算「实抓到的竞品对比」。
  // 后端实抓常常返回 competitor_gap 的 status='unknown'（未取到对比数据）——
  // 过去 `if (gapCheck && gapCheck.status)` 把 'unknown' 也当命中，于是 basis 被标成 measured、
  // 且**盖掉了 AI 已经给出的定性对比结论**（连它联网检索到的具体同业名一起丢掉），
  // 最终老板看到「竞品对比：不知道 / 什么都没有了」。这正是 2026-09-12 早退缺陷的同类问题（是 bug，不是设计）：
  // 无判定 = 没结论，不能冒充实测，更不该压过 AI 的定性结论。
  const gapVerdict =
    gapCheck && (gapCheck.status === 'fail' || gapCheck.status === 'warn' || gapCheck.status === 'pass')
      ? gapCheck.status
      : '';

  const aiStatus = normalizeStatus(aiCompetitor && aiCompetitor.status);
  const aiFinding = str(aiCompetitor && aiCompetitor.finding);

  let status = 'unknown';
  let basis = '';
  let source = hasLocal ? `本地事实（竞品名单：${comps.join('、')}）` : describeSource(SOURCE_KINDS.WEB, webHealth);
  let finding = hasLocal
    ? `已登记竞品：${comps.join('、')}，但本轮未获得竞品声量对比数据。`
    : '本轮联网没取到可用的竞品对比结论。';
  let advice = hasLocal
    ? '待采集到竞品声量后，再给出差异化建议。'
    : '点右上角「重新诊断」——豆芽会自己联网把同业竞品找出来做对比，不需要你先填竞品名单。';

  if (gapVerdict) {
    // ① 真实实测的竞品曝光对比（最高可信度）。
    basis = 'measured';
    source = '竞品曝光实抓（实测）';
    if (gapVerdict === 'fail' || gapVerdict === 'warn') {
      status = 'weak';
      finding = str(gapCheck.evidence) || finding;
      advice = (gapCheck.fix && str(gapCheck.fix.action)) || '针对竞品被提及的场景补齐对等内容，拉开差异化。';
    } else {
      status = 'strong';
      finding = str(gapCheck.evidence) || '竞品声量对比暂无明显差距。';
      advice = '保持差异化内容更新，防止被反超。';
    }
  } else if (aiStatus !== 'unknown') {
    // ② AI 定性对比：本地没有名单也照用（老板要的就是「本地没有就联网补」）。
    status = aiStatus;
    // 无本地名单时不存在任何本地实测来源 → 一律按 AI 推断记录，绝不标成实测。
    basis = hasLocal ? normalizeBasis(aiCompetitor && aiCompetitor.basis, aiStatus) : 'inferred';
    source = hasLocal
      ? describeSource(SOURCE_KINDS.WEB, webHealth) + ' + 本地竞品名单'
      : describeSource(SOURCE_KINDS.WEB, webHealth);
    finding = aiFinding || finding;
    advice = str(aiCompetitor && aiCompetitor.advice) || advice;
  } else if (aiFinding) {
    // ②b AI 给了实质 finding，却没给出可用的 strong/weak（模型偶发不守「不许用 unknown」的硬规定）。
    //     老板 A 项验收点：竞品名单为空时，**检索到的具体同业名必须能看到** —— 丢掉这段 finding 是 bug。
    //     status 照实保持 unknown（不自作主张替模型下结论），只保留它写出的 finding 文本。
    finding = aiFinding;
    advice = str(aiCompetitor && aiCompetitor.advice) || advice;
    source = hasLocal
      ? describeSource(SOURCE_KINDS.WEB, webHealth) + ' + 本地竞品名单'
      : describeSource(SOURCE_KINDS.WEB, webHealth);
  }
  // ③ / ④ 落到初始化时按 hasLocal 预置好的默认文案。

  // 全无来源时，来源标注要照实说「没来源」，不能谎称「联网检索」。
  // 仅当既无本地名单、又没拿到任何 AI 结论文本时，才成立。
  if (status === 'unknown' && !hasLocal && !aiFinding) {
    source = '暂无来源（本地无竞品名单，本轮联网也未取到结论）';
  }

  // 待核验（红线加固）：无本地名单 = 没有任何实测支撑的纯联网推断 → 一律标「待核验」，
  // 不让模型的 self-report（needsVerify:false）把推断伪装成已核验。
  let needsVerify = deriveNeedsVerify(status, basis, !hasLocal, aiCompetitor);
  if (!hasLocal && (status === 'strong' || status === 'weak')) needsVerify = true;

  // 自家品牌事后检测（2026-09-21）：prompt 已明确排除，模型仍犯规时必须**被抓到并如实说出**，
  // 而不是靠人肉翻 finding。命中即产出 warning 文案，交 UI 显著展示。
  const conflicts = findSelfBrandConflicts(aiFinding, selfList);
  const selfBrandWarning = conflicts.length
    ? '⚠️ 这一轮 AI 仍把本企业自有品牌当成了竞品：' + conflicts.join('、')
      + '。它们属于你自己（母公司 / 子品牌），不是外部对手，请点「重新诊断」重跑。'
    : '';
  const selfBrandNote = selfDropped.length
    ? '已从竞品名单中剔除自家品牌：' + selfDropped.map((d) => d.name).join('、')
    : '';

  return {
    id: 'competitor',
    title: '竞品对比',
    status,
    basis,
    source,
    needsVerify,
    finding,
    advice,
    selfBrandWarning,
    selfBrandNote,
    actionLabel: '展开对比矩阵',
    actionModule: 'intel',
  };
}

/** 市场占有率维度：AI 结果，弱时指向经营建议。 */
export function buildMarketShareDimension(raw, webHealth = null) {
  const status = normalizeStatus(raw && raw.status);
  const basis = normalizeBasis(raw && raw.basis, status);
  return {
    id: 'market_share',
    title: '市场占有率',
    status,
    basis,
    source: describeSource(SOURCE_KINDS.WEB, webHealth),
    needsVerify: deriveNeedsVerify(status, basis, false, raw),
    finding: str(raw && raw.finding) || NO_DATA_FINDING,
    advice: str(raw && raw.advice) || NO_DATA_ADVICE,
    actionLabel: status === 'weak' ? '看经营建议' : '',
    actionModule: status === 'weak' ? 'direction' : '',
  };
}

/** 未来蓝海维度：AI 结果，始终指向经营建议。 */
export function buildBlueOceanDimension(raw, webHealth = null) {
  const status = normalizeStatus(raw && raw.status);
  const basis = normalizeBasis(raw && raw.basis, status);
  return {
    id: 'blue_ocean',
    title: '未来蓝海',
    status,
    basis,
    source: describeSource(SOURCE_KINDS.WEB, webHealth),
    needsVerify: deriveNeedsVerify(status, basis, false, raw),
    finding: str(raw && raw.finding) || NO_DATA_FINDING,
    advice: str(raw && raw.advice) || NO_DATA_ADVICE,
    actionLabel: '看经营建议',
    actionModule: 'direction',
  };
}

/**
 * SEO 曝光对比维度（2026-09-12 新增，老板第 7 条）。
 *
 * 数据来源：我方 site 收录（实抓，measured）+ 竞品收录（联网补）。
 * 缺数据兜底：「本轮未取到收录数据，点重新诊断」。
 */
export function buildSeoExposureCompare(vis, raw, competitors, webHealth = null) {
  const comps = asList(competitors);
  const indexed = vis && typeof vis.indexed === 'number' ? vis.indexed : null;
  const aiStatus = normalizeStatus(raw && raw.status);
  const aiFinding = str(raw && raw.finding);

  let status = 'unknown';
  let basis = '';
  let source = '搜索引擎 site 收录实抓 + ' + describeSource(SOURCE_KINDS.WEB, webHealth);
  let finding = aiFinding || '本轮未取到收录数据';
  let advice = str(raw && raw.advice)
    || '点右上角「重新诊断」再联网查一次；先在企业档案补全竞品，豆芽下次能对比双方的收录与曝光。';

  if (aiStatus !== 'unknown' && aiFinding) {
    status = aiStatus;
    basis = normalizeBasis(raw && raw.basis, aiStatus);
    source = (basis === 'measured' && webHealth && webHealth.available === true)
      ? '联网检索（含实测数字）'
      : describeSource(SOURCE_KINDS.WEB, webHealth);
  } else if (indexed != null) {
    basis = 'measured';
    source = '搜索引擎 site 收录实抓（实测）';
    if (indexed > 0) {
      status = 'strong';
      finding = comps.length
        ? `我方官网已被搜索引擎收录（site 收录 ${indexed} 条）；竞品收录数据本轮未取到，尚未形成完整对比。`
        : `我方官网已被搜索引擎收录（site 收录 ${indexed} 条）；未登记竞品，暂无双向对比。`;
      advice = comps.length
        ? '逐项对比竞品的关键词覆盖，优先补齐落后于竞品的词与页面。'
        : '先在企业档案补全竞品名单，豆芽才能做「我方 vs 竞品」的收录对比。';
    } else {
      status = 'weak';
      finding = '我方官网暂无搜索引擎收录（site 收录 0 条），曝光对比处于劣势起点。';
      advice = '提交 sitemap、补齐产品/资质/案例等静态页并获取外链，先让官网被收录，再谈对比。';
    }
  }

  return {
    id: 'seo_exposure_compare',
    title: 'SEO 曝光对比',
    status,
    basis,
    source,
    needsVerify: deriveNeedsVerify(status, basis, false, raw),
    finding,
    advice,
    actionLabel: '',
    actionModule: '',
  };
}

/**
 * 声浪维度（2026-09-12 新增，老板第 5 条：没有就联网大模型去搜）。
 *
 * 数据来源：联网检索（公开媒体报道 / 社交讨论量）。
 * 缺数据兜底：「AI 推断 · 待核验」——只给档位，不给具体数字。
 * 该维度无本地实测源，因此只要不是实测（几乎必然）就标 needsVerify=true。
 */
export function buildMediaVolume(raw, webHealth = null) {
  const status = normalizeStatus(raw && raw.status);
  const basis = resolveNetBasis(raw);
  return {
    id: 'media_volume',
    title: '声浪',
    status,
    basis,
    source: webHealth && webHealth.available === true && str(raw && raw.source)
      ? str(raw && raw.source)
      : describeSource(SOURCE_KINDS.WEB, webHealth),
    needsVerify: deriveNeedsVerify(status, basis, true, raw),
    finding: str(raw && raw.finding) || '联网没查到公开的声浪数据（媒体报道 / 社交讨论量）',
    advice: str(raw && raw.advice)
      || '先在企业档案补全企业名与行业关键词，豆芽再联网查一次公开报道与讨论量；查不到时只给档位，不编造数字。',
    actionLabel: '',
    actionModule: '',
  };
}

/**
 * 活动维度（2026-09-12 新增，老板第 5 条）。
 *
 * 数据来源：本地活动清单（activityStore，若可用，measured）+ 联网补充（AI 推断）。
 * @param {object} raw AI 结果
 * @param {number} activityCount 本地已登记活动数量（可选；来自调用方的只读统计）
 */
export function buildContentActivity(raw, activityCount, webHealth = null) {
  const n = Number(activityCount) > 0 ? Number(activityCount) : 0;
  const aiStatus = normalizeStatus(raw && raw.status);
  const basis = resolveNetBasis(raw);

  let status = aiStatus;
  let effBasis = basis;
  let source = describeSource(SOURCE_KINDS.WEB, webHealth);
  let finding = str(raw && raw.finding) || '联网没查到公开的活动 / 内容发布数据';
  let advice = str(raw && raw.advice)
    || '先在「活动策划」里登记 1-2 场活动，豆芽可据本地清单 + 联网公开信息给出活跃度判断。';

  // 本地清单是实测事实，优先用于「活跃度是否有基线」这件事。
  if (n > 0) {
    source = `本地活动清单（已登记 ${n} 场，实测）+ ` + describeSource(SOURCE_KINDS.WEB, webHealth);
    effBasis = 'measured';
    if (status === 'unknown') {
      status = 'strong';
      finding = `本地已登记 ${n} 场活动（实测事实）；联网未取到行业对标数据，活跃度暂无外部参照。`;
      advice = '保持活动登记习惯，豆芽会按本地清单持续跟踪活跃度变化。';
    }
  }

  return {
    id: 'content_activity',
    title: '活动',
    status,
    basis: effBasis,
    source,
    needsVerify: deriveNeedsVerify(status, effBasis, true, raw),
    finding,
    advice,
    actionLabel: '',
    actionModule: '',
  };
}

/**
 * 用户反馈维度（2026-09-12 新增，老板第 5 条）。
 *
 * 数据来源：联网检索（公开评价 / 口碑）。缺数据兜底：「AI 推断 · 待核验」。
 */
export function buildUserFeedback(raw, webHealth = null) {
  const status = normalizeStatus(raw && raw.status);
  const basis = resolveNetBasis(raw);
  return {
    id: 'user_feedback',
    title: '用户反馈',
    status,
    basis,
    source: webHealth && webHealth.available === true && str(raw && raw.source)
      ? str(raw && raw.source)
      : describeSource(SOURCE_KINDS.WEB, webHealth),
    needsVerify: deriveNeedsVerify(status, basis, true, raw),
    finding: str(raw && raw.finding) || '联网没查到公开的用户评价 / 口碑数据',
    advice: str(raw && raw.advice)
      || '联网未取到公开评价时，先在企业档案补全产品与客户画像；涉及疗效 / 功效的评价只做合规提示，不复制其表述。',
    actionLabel: '',
    actionModule: '',
  };
}

/**
 * 规则化兜底：基于前面维度的强弱势归纳「现在该做什么 / 怎么优化」。
 * AI 归纳失败时使用，保证面板永远有可读结论，而不是空着。
 */
export function fallbackSynthesis(deps = []) {
  const weakDims = deps.filter((d) => d && d.status === 'weak');
  const strongDims = deps.filter((d) => d && d.status === 'strong');

  const weakNames = weakDims.map((d) => d.title).join('、');
  const strongNames = strongDims.map((d) => d.title).join('、');
  const weakAdvices = weakDims.map((d) => str(d.advice)).filter(Boolean);

  if (weakDims.length === 0 && strongDims.length === 0) {
    // AI 归纳整体失败时的最后兜底。
    // 2026-09-11：老文案是「当前数据不足，暂无法给出明确的行动优先级」——
    // 老板看到这句等于什么都没得到。改为给出「无论如何都该先做的第一件事」，
    // 至少让用户今天有活可干（不涉及编造数据，只是流程性的起步动作）。
    return {
      doNowFinding: '豆芽这次没拿到可靠的诊断结论，先别急着投钱；按下面顺序把地基补上。',
      doNowAdvice: '1）在企业设置里补齐「竞品清单 + 主要产品 + 目标客户」——这是后面所有诊断的输入；'
        + '2）确认官网/商城能被搜索引擎收录（提交 sitemap）；'
        + '3）把最近 3 个月已成交的客户来源记一次账，先知道自己客户从哪来。',
      optimizeFinding: '先把诊断的输入数据补齐，再谈优化路径。',
      optimizeAdvice: '数据补齐后重跑一次诊断：那时每个维度都会给出具体方向和动作。',
    };
  }

  if (weakDims.length) {
    return {
      doNowFinding: `优先补强：${weakNames}。`,
      doNowAdvice: weakAdvices.join('；') || '逐项补齐短板，先易后难。',
      optimizeFinding: `围绕短板（${weakNames}）逐项优化，先易后难。`,
      optimizeAdvice: weakAdvices.join('；') || '把最弱的一项先做起来，跑通再扩。',
    };
  }

  return {
    doNowFinding: `当前整体表现较好（${strongNames || '已有维度'}较强），重在保持并扩大优势。`,
    doNowAdvice: strongDims.map((d) => str(d.advice)).filter(Boolean).join('；') || '把优势动作常态化。',
    optimizeFinding: '持续迭代，把优势转成可复制的打法。',
    optimizeAdvice: '把已验证的有效动作沉淀为标准流程，再放大投放。',
  };
}

/**
 * 「现在应该做什么」——综合归纳维度，不参与强弱评分。
 *
 * status 固定为 'advice'（不是 unknown）：
 * 这两个维度回答的是「该干什么」，本身没有「强/弱」语义，
 * 老版本给它们标 unknown，导致 UI 上活生生多出两个「未知」标签（用户实测反馈）。
 * UI 遇到 'advice' 不渲染状态标签。
 */
export function buildDoNowDimension(raw, deps) {
  const fb = fallbackSynthesis(deps);
  return {
    id: 'do_now',
    title: '现在应该做什么',
    status: 'advice',
    basis: '',
    source: '归纳前序维度（本地规则兜底 + AI 归纳）',
    needsVerify: false,
    finding: str(raw && raw.finding) || fb.doNowFinding,
    advice: str(raw && raw.advice) || fb.doNowAdvice,
    actionLabel: '',
    actionModule: '',
  };
}

/** 「怎么优化」——同 do_now，status 固定 'advice'，不渲染状态标签。 */
export function buildOptimizeDimension(raw, deps) {
  const fb = fallbackSynthesis(deps);
  return {
    id: 'optimize',
    title: '怎么优化',
    status: 'advice',
    basis: '',
    source: '归纳前序维度（本地规则兜底 + AI 归纳）',
    needsVerify: false,
    finding: str(raw && raw.finding) || fb.optimizeFinding,
    advice: str(raw && raw.advice) || fb.optimizeAdvice,
    actionLabel: '',
    actionModule: '',
  };
}

/**
 * 组装 11 个维度（顺序固定 = DIMENSION_ORDER 的顺序）。
 * @param {object} p { vis, geoGap, exposure, competitors, aiParsed, activityCount, webHealth, selfBrands }
 *   · webHealth —— 可选：数据来源标注所依据的联网健康度。
 *     diagnoseMarket 会传入「本次真实检索的直接证据」（resolveWebSourceHealth），
 *     使各维来源与顶层 source 口径一致；不传时回退到同步读探针缓存（保持既有单测行为）。
 *   · selfBrands —— 可选：本企业自有品牌 / 旗下 IP（2026-09-21 竞品护栏）。不传 = 零行为变化。
 */
export function buildDimensions({ vis, geoGap, exposure, competitors, aiParsed, activityCount, webHealth, selfBrands } = {}) {
  const ai = aiParsed && typeof aiParsed === 'object' && !Array.isArray(aiParsed) ? aiParsed : {};

  // 数据来源诚实化（2026-09-14）：整套维度的「来源」标注由联网健康度驱动 ——
  // webHealth 可由调用方**显式传参**（本次真实检索的直接证据）；缺省同步读一次探针缓存（不阻塞主流程）。
  // 默认保守：缓存缺失（null）时各维输出「模型分析（联网状态未确认）」，绝不许默认成「联网检索」。
  const health = webHealth !== undefined ? webHealth : getCachedWebSearchHealth();
  // 自家品牌护栏（2026-09-21）：竞品维度用它剔污染 + 事后检测。缺省 [] = 与改动前逐字一致。
  const selfList = Array.isArray(selfBrands) ? selfBrands : [];

  const competitor = buildCompetitorDimension(competitors, exposure, ai.competitor, health, selfList);
  const geo = buildGeoDimension(vis, geoGap, ai.geo, health);
  const seoExposure = buildSeoExposureCompare(vis, ai.seo_exposure_compare, competitors, health);
  const mediaVolume = buildMediaVolume(ai.media_volume, health);
  const contentActivity = buildContentActivity(ai.content_activity, activityCount, health);
  const userFeedback = buildUserFeedback(ai.user_feedback, health);
  const seo = buildSeoDimension(vis, ai.seo, health);
  const marketShare = buildMarketShareDimension(ai.market_share, health);
  const blueOcean = buildBlueOceanDimension(ai.blue_ocean, health);

  // do_now / optimize 综合归纳前面 9 个维度（不含自身）。
  const deps = [competitor, geo, seoExposure, mediaVolume, contentActivity, userFeedback, seo, marketShare, blueOcean];
  const doNow = buildDoNowDimension(ai.do_now, deps);
  const optimize = buildOptimizeDimension(ai.optimize, deps);

  return [competitor, geo, seoExposure, mediaVolume, contentActivity, userFeedback, seo, marketShare, blueOcean, doNow, optimize];
}

/**
 * 统计一批维度里「有结论」的比例（strong/weak 均算有结论）。
 * 供 UI 提示「本轮 N/11 个维度拿到了明确结论」，也供测试断言用。
 * @param {Array} dims buildDimensions 的输出
 * @returns {{concluded:number, total:number, inferred:number, needsVerify:number, unknown:number}}
 */
export function summarizeDimensions(dims) {
  const list = Array.isArray(dims) ? dims : [];
  const concluded = list.filter((d) => d && (d.status === 'strong' || d.status === 'weak')).length;
  const inferred = list.filter((d) => d && d.basis === 'inferred').length;
  const needsVerify = list.filter((d) => d && d.needsVerify === true).length;
  return { concluded, total: list.length, inferred, needsVerify, unknown: list.length - concluded };
}

/**
 * 执行经营诊断（主函数）。
 *
 * 流程：① GEO 实抓 → ② 真实联网检索（T11②，注入 11 维 prompt）→ ③ 一次 AI 归纳 11 维 → ④ 组装。
 *
 * @param {object} params { company, asset, knowledge, brain, activityCount }
 * @param {object} opts { searchFn, chatFn, geoProxy, fetchWebSearch, webSearch, temperature }
 *   · searchFn      —— AI（联网）补全实现，默认 searchWeb；单测注入假实现（与真检索互不干扰）；
 *   · chatFn        —— 内网模型补全实现，默认 chatOnce；
 *   · fetchWebSearch—— **真检索**实现，默认 fetchWebSearch（主进程 /api/web-search）；单测注入假实现可离线跑；
 *   · webSearch     —— 传 false 可显式关闭本轮真实检索（仅供测试/特殊场景）。
 * @returns {Promise<{
 *   ok:boolean, dimensions:Array, summary:Object, source:string, error:string,
 *   raw:{ exposure:Object|null, vis:Object, geoGap:Object, ai:Object|null, web:Object }
 * }>}
 */
export async function diagnoseMarket(params = {}, opts = {}) {
  const searchFn = typeof opts.searchFn === 'function' ? opts.searchFn : searchWeb;
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const proxyFn = typeof opts.geoProxy === 'function' ? opts.geoProxy : geoProxy;
  const ctx = buildAIContext(params);
  // T16：本轮**真检索**实现（默认主进程 fetchWebSearch；单测注入假实现可离线跑）。
  // 提前定义 —— 既供本函数 11 维真检索用，也下传给 geoExposure 让其 GEO 降级分支同样走真检索。
  const fetchWebSearchFn = typeof opts.fetchWebSearch === 'function' ? opts.fetchWebSearch : fetchWebSearch;

  const company = params.company || {};
  const asset = params.asset || {};
  const knowledge = params.knowledge || {};
  const brain = params.brain || null;
  const activityCount = Number(params.activityCount) > 0 ? Number(params.activityCount) : 0;

  const brand = str(company.name) || str(asset.companyName);
  const industry = str(asset.industry);
  const targetCustomers = asList(asset.targetCustomers);
  const competitors = asList(asset.competitors);
  const companyType = inferCompanyType(asset, company);

  // 2026-09-21 缺陷修复（老板实测：「上游货源是康健苗苗下面的 上面都说了 还会把上游货源做成竞品」）：
  // 本企业自有品牌 / 旗下 IP（母公司名 + profile.brandIps 及其别名）。
  // 与 contextBuilder 的「- 旗下品牌/IP」同源 —— 这份名单以前只进对话写作，**从没进过竞品判定**，
  // 于是模型在「必须自己找 3-5 家同业」时把自家子品牌当竞品。此处补上，并一路传到：
  //   ① buildMarketSearchQueries（检索词不拿自家品牌当竞品词）
  //   ② buildMarketPrompt（prompt 里明确排除）
  //   ③ buildDimensions → buildCompetitorDimension（剔污染 + 事后检测）
  // knowledge 拿不到时退回空数组 = 零行为变化（不误报）。
  const selfBrands = collectSelfBrandNames({ company, asset, knowledge });

  // 1) GEO 曝光诊断（真实实抓；内部自带联网/内网降级）。
  let exposure = null;
  let exposureError = '';
  try {
    // T16：把真检索实现（fetchWebSearchFn）下传给 geoExposure，其 GEO 降级分支也走真检索；
    // 仅当调用方**显式**注入 searchFn 时才透传（保持单测/特殊场景的注入优先级不变）。
    const exposureOpts = { chatFn, geoProxy: proxyFn, temperature: opts.temperature, fetchFn: fetchWebSearchFn };
    if (typeof opts.searchFn === 'function') exposureOpts.searchFn = opts.searchFn;
    exposure = await diagnoseExposure(
      { company, asset, knowledge, brain },
      exposureOpts,
    );
  } catch (e) {
    exposureError = e && e.message ? e.message : String(e);
  }

  const scan = exposure && exposure.ok ? exposure.realScan : null;
  const vis = buildAiSearchVisibility(scan);
  const geoGap = detectGeoGap({ id: 'ai_search_exposure', change: null, visibility: vis });

  // 2) AI 联网诊断（11 维一次调用；competitor / geo / seo_exposure_compare 亦会被本地事实覆盖）。
  const scanContext = scan ? buildScanContext(scan, brand) : '';
  const checksContext = exposureChecksText(exposure);
  const promptContext = [scanContext, checksContext].filter(Boolean).join('\n');

  // 2a) T11②：在调 AI 之前先跑**真实联网检索**，把真网页资料注入 prompt 作为 11 维的材料。
  //     这一步才是「AI 联网诊断」名副其实的关键 —— searchWeb 的 enable_search 是空头支票
  //     （内网网关静默忽略该参数，从不真的上网），过去 11 维全靠模型训练记忆 + 企业资料库。
  //     老板 A 项：「竞品名单缺失时，让模型自己联网把同业找出来」—— 现在才真的能做到。
  //     （fetchWebSearchFn 已在函数开头定义，并已下传给 geoExposure。）
  const searchQueries = buildMarketSearchQueries({ brand, industry, competitors, selfBrands });
  const searchAttempted = searchQueries.length > 0 && opts.webSearch !== false;
  let webOutcome = { queries: [], anyOk: false, allFailed: false, results: [], provider: 'none' };
  if (searchAttempted) {
    try {
      webOutcome = await runMarketWebSearch(searchQueries, fetchWebSearchFn);
    } catch (e) {
      webOutcome = { queries: [], anyOk: false, allFailed: true, results: [], provider: 'none', error: (e && e.message) || String(e) };
    }
  }
  // V4-B3：先按「可用性」过滤（title/content 至少一个非空），空壳条目不算资料。
  // 注入用的集合与计数用的集合必须是**同一个** —— 否则来源会标出虚高的「联网检索（N 实检）」。
  const usableResults = usableWebResults(webOutcome.results);
  // 实际注入 prompt 的条数（渲染时按 WEB_FACTS_MAX_INJECT 截断，来源标注的 N 必须与之一致）。
  const injectedCount = Math.min(usableResults.length, WEB_FACTS_MAX_INJECT);
  // 失败 → ''（不注入，绝不假装有材料）；成功但 0 条可用 → 如实的「没搜到」说明；有可用资料 → 渲染资料段。
  const webFacts = buildWebFactsContext({ results: usableResults, failed: webOutcome.allFailed });

  const prompt = buildMarketPrompt({
    brand,
    industry,
    companyType,
    targetCustomers,
    competitors,
    selfBrands,
    scanContext: promptContext,
    webFacts,
    geoSummary: vis && vis.summary ? vis.summary : '',
    geoGapReason: geoGap && geoGap.gap ? geoGap.reason : '',
  });

  let aiParsed = null;
  // 数据来源诚实化：来源标注改用**本次真实检索的直接证据**（比再跑一次探针更准）——
  // 本轮真检索拿到资料 → 「联网检索（X 实检 N 条）」；端点通但 0 条 → 未确认；全失败 → 未联网。
  // 未发起检索（如无企业名）时才退回同步读探针缓存（不阻塞主流程）。
  const sourceHealth = resolveWebSourceHealth(webOutcome, searchAttempted, injectedCount);
  if (!sourceHealth) { checkWebSearchHealth().catch(() => {}); }
  let source = describeSourceWithCount(SOURCE_KINDS.WEB, sourceHealth, injectedCount);
  let res = null;
  try {
    res = await searchFn(prompt, { temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3 });
  } catch {
    res = null;
  }
  if (!res || res.ok !== true || !res.content) {
    // 降级到内网模型。来源照实说：这条路径没走 searchWeb。
    if (injectedCount > 0 && sourceHealth && sourceHealth.available === true) {
      // 但本轮真检索确实拿到了资料并已注入 → 如实写「联网资料 + 内网模型归纳」，不谎称也没抹掉。
      source = describeSourceWithCount(SOURCE_KINDS.WEB, sourceHealth, injectedCount) + ' + 内网模型归纳';
    } else {
      source = describeSource(SOURCE_KINDS.INTERNAL, sourceHealth);
    }
    try {
      res = await chatFn([{ role: 'user', content: prompt }], ctx, { temperature: 0.3, reasoningEffort: 'none' });
    } catch {
      res = null;
    }
  }
  if (res && res.ok === true && res.content) {
    const j = extractJSON(res.content);
    if (j && typeof j === 'object' && !Array.isArray(j)) aiParsed = j;
  }
  // 收集 AI 侧真实失败原因（如 "LLM HTTP 503 Service is too busy（已自动重试 2 次）"），
  // 供下方红线分支如实呈现——2026-10-15 老板实测：公网 DeepSeek 间歇 503，
  // 老文案「请检查网络」把用户引向错误方向（网络与 key 都正常，纯粹是服务端过载）。
  const aiError = res && res.ok !== true && res.error ? String(res.error) : '';

  // 3) 组装 11 个维度。来源标注与顶层 source 同源（都用本次检索的直接证据），口径一致。
  const dimensions = buildDimensions({ vis, geoGap, exposure, competitors, aiParsed, activityCount, webHealth: sourceHealth, selfBrands });
  const summary = summarizeDimensions(dimensions);

  // 红线：一个明确结论都没拿到时，绝不许把兜底标签包装成「诊断成功」返回。
  //
  // 2026-09-12 收口（老板实测反馈「现在跑出来都是未知，我要这个有啥用？」）：
  // 老逻辑只判断 dimensions 是否为空数组，而 buildDimensions 永远返回固定数量维度
  // （拿不到数据就是满屏兜底），于是 ok 恒为 true —— 联网与内网双双失败时，
  // 老板看到的是一次「成功」的诊断，满屏标签写着「没查到」，既没有报错也不提示重试。
  // 失败就该老实报失败，让 UI 亮出错误条 + 「重新诊断」。
  if (summary.concluded === 0) {
    // 如实区分两种失败，不再一刀切「请检查网络」（2026-10-15 修）：
    // ① 联网检索已拿到资料、只是 AI 归纳没成 → 检索是通的，问题在模型服务（多为 503 过载），
    //    重试即可恢复，文案要指向「重新诊断」而不是「检查网络」；
    // ② 检索也没拿到 → 才需要提示检查检索源/key。
    const aiReason = aiError || '模型未返回内容';
    const error = aiParsed
      ? '经营诊断这次没跑出任何明确结论，点「重新诊断」再试一次。'
      : (injectedCount > 0
        ? `经营诊断失败：已联网检索到 ${injectedCount} 条资料，但 AI 模型暂时不可用（${aiReason}）。点「重新诊断」重试，通常一两次即可恢复。`
        : `经营诊断失败：联网检索未拿到资料，AI 模型也未返回可用结论（${aiReason}）。请检查检索 Key 与模型服务后点「重新诊断」。`);
    return {
      ok: false,
      dimensions,
      summary,
      source,
      error,
      raw: { exposure, vis, geoGap, ai: aiParsed, web: webOutcome, selfBrands },
    };
  }

  return {
    ok: true,
    dimensions,
    summary,
    source,
    error: exposureError,
    raw: { exposure, vis, geoGap, ai: aiParsed, web: webOutcome, selfBrands },
  };
}

export default {
  DIMENSION_ORDER,
  NET_SUPPLEMENT_IDS,
  STATUS_LABEL,
  BASIS_LABEL,
  SOURCE_LABEL,
  normalizeStatus,
  normalizeBasis,
  deriveNeedsVerify,
  statusLabel,
  buildMarketPrompt,
  buildMarketSearchQueries,
  runMarketWebSearch,
  buildWebFactsContext,
  resolveWebSourceHealth,
  buildDimensions,
  summarizeDimensions,
  diagnoseMarket,
};
