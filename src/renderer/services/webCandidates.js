/**
 * webCandidates.js —— 「联网找候选」通用服务（老板 2026-09「都要加入联网」）。
 *
 * 背景：企业的资产库里有一批「名单类字段」（竞品、医生专家资源、成功案例、核心卖点、
 * 客户痛点、目标客户…），过去只能靠人工手打。老板拍板：这类**外部可检索的公开事实/实体**
 * 都要能一键联网找候选，而不是只有首登那一步能联网。
 *
 * 本文件是整个「联网找候选」能力的**唯一数据出口**，职责单一：
 *   · 只调 groundedSearch（**真检索**：fetchWebSearch 实检 → 注入资料，见 groundedWebSearch.js）—— 不新增后端接口；
 *   · 只调 extractJSON（复用产品既有解析器，见 projectAI.js）—— 不另写解析器；
 *   · 只做「检索 → 解析 → 去重 → 过滤已登记」的数据处理，**不碰任何 UI、不写任何库**。
 *
 * 合规红线（硬约束）：
 *   1. 候选不得编造 —— 检索不到就返回空 + 诚实提示，绝不塞假名称；
 *   2. 失败不得静默成空数组 —— 用 ok:false 与「空结果」明确区分，让上层能给诚实错误态；
 *   3. 候选**永不自动写库** —— 是否落库由调用方（用户点「确认添加选中」）决定，本文件不写库。
 *
 * 说明（对设计文档中「返回 [{name, note}]」的细化）：
 *   P0-3 的硬约束要求「失败不许静默成空数组假装本来就没有」，单纯返回数组无法区分
 *   「检索失败」与「确实没检索到」。故本服务返回结构体 { ok, candidates, error }，
 *   其中 candidates 即约定的 [{name, note}]；ok:false 表示检索/输入失败（error 带原因），
 *   ok:true + candidates:[] 表示检索成功但没有可信结果。
 */

import { extractJSON } from './projectAI.js';
// T16：改走**真检索**（fetchWebSearch 实检 → 注入资料），不再走静默忽略 enable_search 的 searchWeb。
import { groundedSearch } from './groundedWebSearch.js';

/**
 * 候选类型 → 提示词配置。
 * name 用于给人看的场景描述，desc 是塞进 prompt 的检索目标，hint 是补充约束。
 * brand 一定是「品牌矩阵」场景（Onboarding 与服务皆可复用同一口径）。
 */
export const WEB_CANDIDATE_KINDS = {
  brand: {
    label: '旗下子品牌 / 产品线 IP',
    desc: '公开信息中提到的**旗下子品牌 / 产品线 IP 名称**',
    hint: '只输出品牌 / 产品线名称本身。',
  },
  competitor: {
    label: '竞品',
    desc: '同行业中的**主要竞争对手 / 竞品品牌名称**',
    hint: '只输出竞品的品牌或公司名称本身，不要输出本企业自己。',
  },
  expert: {
    label: '医生专家资源',
    desc: '公开资料里可查到的**医生 / 专家 / 行业意见领袖姓名**',
    hint: '只输出人名（可带一句头衔 / 单位）。',
  },
  case: {
    label: '成功案例',
    desc: '公开报道里可查到的**典型成功案例 / 合作案例**',
    hint: '每条给一个案例名称，或一句话概括的案例。',
  },
  selling: {
    label: '核心卖点',
    desc: '公开资料中常被强调的**核心卖点 / 产品优势**',
    hint: '每条给一个简短的卖点短语。',
  },
  pain: {
    label: '客户痛点',
    desc: '目标客户群体的**典型痛点 / 未被满足的需求**',
    hint: '每条给一个简短的痛点短语。',
  },
  audience: {
    label: '目标客户',
    desc: '该企业 / 行业面向的**目标客户人群**',
    hint: '每条给一个人群短语。',
  },
  // 「同名 / 相似企业主体」：首登识别认错时，让用户从多个同名/近名工商主体里挑一个。
  // 与其余 kind 同构（label/desc/hint 三字段）。
  // 刻意避开 web-candidates-mock.cjs detectKind 的全部特征串（旗下子品牌 / 产品线 IP 名称 /
  // 主要竞争对手 / 医生 / 专家 / 行业意见领袖姓名 / 典型成功案例 / 核心卖点 / 产品优势 /
  // 典型痛点 / 目标客户人群），否则会把既有 kind 的 mock 判定带偏。
  company: {
    label: '同名 / 相似企业主体',
    desc: '名称与你输入的企业**同名或高度相近的企业主体**（很可能是另一家不同工商主体）',
    hint: '每条给出该企业的工商全称；并在 note 里用「所在地 / 统一社会信用代码 / 成立时间」中至少一项，说明它与被检索主体的区别。',
  },
};

const DEFAULT_KIND = 'competitor';

/** 候选数量上限，避免一次刷屏。 */
const MAX_CANDIDATES = 12;

/** 单条名称的最大长度，超过按噪声丢弃（模型偶尔会回一句解释）。 */
const MAX_NAME_LEN = 60;

/** 典型的「检索不到」话术，行解析时直接丢弃，不当作候选。 */
const NOT_FOUND_RE = /未检索到|未找到|没有找到|无相关|查不到|暂不|不明确|无法找到|无公开|没有公开/;

function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 把任意入参规整成去空、去重的字符串数组。 */
function normalizeNameList(v) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  const seen = new Set();
  arr.forEach((item) => {
    const s = asStr(item);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  });
  return out;
}

/**
 * 组装联网检索的提示词。
 * @param {object} cfg WEB_CANDIDATE_KINDS 里的一项
 * @param {object} p { companyName, industry, extraHint, existing }
 * @returns {string}
 */
function buildPrompt(cfg, p) {
  const lines = [
    `请联网检索「${p.companyName}」${p.industry ? `（所属行业：${p.industry}）` : ''}的${cfg.desc}。`,
    '只返回一个 JSON 对象，不要 markdown 代码围栏、不要任何解释文字：',
    '{ "candidates": [ { "name": "名称或短语", "note": "一句话说明（可留空）" } ] }',
    `最多给 8 条；每条 name 都必须能从上一步检索到的公开信息里得到，${cfg.hint}`,
  ];
  if (p.extraHint) lines.push(`补充要求：${p.extraHint}`);
  if (p.existing.length) lines.push(`以下已经登记过，不要再返回：${p.existing.join('、')}。`);
  lines.push('查不到任何结果时返回 { "candidates": [] }。禁止编造不存在的名称或短语。');
  lines.push('若你**无法访问实时网络**，请直接返回 { "candidates": [] }，不要用训练记忆里的名称冒充「联网检索所得」。');
  return lines.join('\n');
}

/**
 * 解析模型返回文本为候选数组。
 * 优先 extractJSON（契约是 { candidates: [...] } 或直接数组）；
 * 解析不出 JSON 时回退「每行一个名称」的行解析（兼容模型直接列名称的情况）。
 * @param {string} text
 * @returns {Array<{name:string, note:string}>}
 */
function parseCandidates(text) {
  const raw = String(text || '');
  const parsed = extractJSON(raw);

  let arr = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.candidates)) arr = parsed.candidates;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) arr = parsed.items;

  if (Array.isArray(arr)) {
    return arr
      .map((it) => {
        if (typeof it === 'string') return { name: asStr(it), note: '' };
        if (it && typeof it === 'object') {
          return {
            name: asStr(it.name) || asStr(it.title) || asStr(it.value),
            note: asStr(it.note) || asStr(it.reason) || asStr(it.desc) || asStr(it.description),
          };
        }
        return { name: '', note: '' };
      })
      .filter((c) => c.name);
  }

  // 回退：按行解析
  return raw
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*•·\d.、)）(（]+/, '').trim())
    .filter((s) => s && s.length <= MAX_NAME_LEN && !NOT_FOUND_RE.test(s))
    .map((s) => ({ name: s, note: '' }));
}

/**
 * 联网检索某一类字段的候选。
 *
 * @param {object} p
 * @param {string} p.kind           候选类型，见 WEB_CANDIDATE_KINDS（brand/competitor/expert/case/selling/pain/audience）
 * @param {string} p.companyName    检索主体（企业名 / 母公司名），必填
 * @param {string} [p.industry]     行业，辅助检索
 * @param {string[]} [p.existing]   已登记的名称，会被过滤掉（去重）
 * @param {string} [p.extraHint]    额外检索提示
 * @param {number} [p.temperature]  采样温度（默认 0.2，偏向稳定事实）
 * @param {object} [opts]           仅供测试注入：{ fetchFn, chatFn }（真检索/模型实现的替身）
 * @returns {Promise<{ok:boolean, candidates:Array<{name:string, note:string}>, error:string}>}
 *          ok:false → 输入缺失或联网失败（error 说明原因，不可当作「本来就没有」）；
 *          ok:true  → 检索成功；candidates 为空表示确实没检索到可信结果。
 */
export async function fetchWebCandidates(p = {}, opts = {}) {
  const cfg = WEB_CANDIDATE_KINDS[p.kind] || WEB_CANDIDATE_KINDS[DEFAULT_KIND];
  const companyName = asStr(p.companyName);
  if (!companyName) {
    return { ok: false, candidates: [], error: '请先填写企业名称，豆芽才能检索。' };
  }

  const existing = normalizeNameList(p.existing);
  const prompt = buildPrompt(cfg, {
    companyName,
    industry: asStr(p.industry),
    extraHint: asStr(p.extraHint),
    existing,
  });

  let res = null;
  try {
    // T16：改走**真检索**（groundedSearch = fetchWebSearch 实检 → 注入资料）。
    // 显式给精炼检索词（企业名 + 行业 + 候选类型），否则含 existing 长列表的 prompt 会被截断成检索词。
    res = await groundedSearch(prompt, {
      query: [companyName, asStr(p.industry), cfg.label, '公开信息 名单'].filter(Boolean).join(' '),
      temperature: typeof p.temperature === 'number' ? p.temperature : 0.2,
      fetchFn: typeof opts.fetchFn === 'function' ? opts.fetchFn : undefined,
      chatFn: typeof opts.chatFn === 'function' ? opts.chatFn : undefined,
    });
  } catch (e) {
    res = null;
  }

  const text = res && res.ok === true && res.content ? String(res.content) : '';
  if (!text.trim()) {
    const reason = res && res.error ? res.error : '在线检索暂不可用';
    return { ok: false, candidates: [], error: `${reason}，请稍后重试或手动添加。` };
  }

  const existSet = new Set(existing.map((s) => s.toLowerCase()));
  const seen = new Set();
  const candidates = [];
  for (const c of parseCandidates(text)) {
    const name = asStr(c.name);
    if (!name || name.length > MAX_NAME_LEN) continue;
    const key = name.toLowerCase();
    if (existSet.has(key) || seen.has(key)) continue; // 已登记 / 本轮重复 → 过滤
    seen.add(key);
    candidates.push({ name, note: asStr(c.note) });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  if (candidates.length === 0) {
    return { ok: true, candidates: [], error: '没检索到明确的候选，可手动添加。' };
  }
  return { ok: true, candidates, error: '' };
}

export default { fetchWebCandidates, WEB_CANDIDATE_KINDS };
