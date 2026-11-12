/**
 * genBrandIps —— 公关危机「AI 生成旗下 IP / 子品牌候选」服务。
 *
 * 用户痛点：品牌矩阵（母公司 + 多个子品牌/产品线 IP）需要逐个登记才能分开监控舆情，
 * 但用户常常不知道要登记哪些、也懒得一个个手动加。这个服务让 AI 读企业画像，
 * 推断它可能有的子品牌 / 产品线 / 服务 IP，并给出「为什么该监控它」的理由，供用户勾选登记。
 *
 * 硬约束：只推断、不编造。画像里没有依据的候选一律不生成；每条都带 reason 说明推导依据。
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { extractJSON } from './projectAI.js';

function asStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function asArray(v) {
  return Array.isArray(v) ? v.map((x) => asStr(x)).filter(Boolean) : [];
}

/** 把企业画像精简成给 AI 看的文本。 */
function profileText(p) {
  const prof = (p.knowledge && p.knowledge.profile) || {};
  const asset = p.asset || {};
  const lines = [];
  const companyName = asStr(asset.companyName || prof.companyName || (p.currentCompany && p.currentCompany.name));
  if (companyName) lines.push(`企业名称：${companyName}`);
  const pos = asStr(prof.brandPositioning || asset.brandTone);
  if (pos) lines.push(`品牌定位：${pos}`);
  const ind = asStr(prof.industry || asset.industry);
  if (ind) lines.push(`行业：${ind}`);
  const products = asStr(prof.products || asset.products);
  if (products) lines.push(`产品 / 服务：${products}`);
  const selling = asArray(prof.coreSellingPoints || asset.coreSellingPoints);
  if (selling.length) lines.push(`核心卖点：${selling.join('、')}`);
  const customers = asArray(prof.targetCustomers || asset.targetCustomers);
  if (customers.length) lines.push(`目标人群：${customers.join('、')}`);
  const competitors = asArray(prof.competitors || asset.competitors);
  if (competitors.length) lines.push(`竞品：${competitors.join('、')}`);
  return lines.length ? lines.join('\n') : '（企业画像尚未填写完整）';
}

/** 已有的 IP 名称 + 别名，供 AI 去重（避免重复生成已登记的）。 */
function existingText(p) {
  const list = [];
  asArray(p.existingNames).forEach((n) => list.push(n));
  return list.length ? list.join('、') : '';
}

const REASON_RULE = [
  '每个候选都必须从企业画像里推导：它应是「母公司业务下可能独立成品牌 / 产品线 / 服务」的对象，',
  'reason 必须说明推导依据（引用画像里的行业 / 产品 / 定位），禁止编造一个画像里完全没提到的新品牌名。',
  '画像信息不足、确实推不出子品牌时，返回空数组而不是硬凑。',
].join('');

const FACT_RULE = '禁止编造企业信息。子品牌名称若画像里没明确写，只能基于已有产品线/业务方向做合理命名推断，并在 note 里写「AI 推断，请核对」。';

/**
 * AI 生成旗下 IP / 子品牌候选。
 *
 * @param {object} p { currentCompany, asset, knowledge, existingNames, companyType }
 * @param {object} [opts] { chatFn, temperature }
 * @returns {Promise<Array<{name:string, aliases:string[], note:string, reason:string}>>}
 *          失败返回 []
 */
export async function genBrandIps(p = {}, opts = {}) {
  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const ctx = buildAIContext({
    company: p.currentCompany,
    asset: p.asset,
    knowledge: p.knowledge,
    role: 'admin',
  });

  const exist = existingText(p);
  const prompt = [
    '你是口腔行业品牌架构顾问。请帮这家企业梳理「需要单独做舆情监控的旗下 IP / 子品牌 / 产品线」。',
    '目的：公关舆情要按品牌分开监控，母公司口碑好不等于每个子品牌都没问题。',
    '',
    '【企业画像】',
    profileText(p),
    exist ? `【已登记的 IP（不要再重复生成）】\n${exist}` : '',
    '',
    '只返回一个 JSON 对象（不要解释、不要 markdown 围栏）：',
    '{ "ips": [ { "name": "子品牌/产品线名称", "aliases": ["其他叫法1", "其他叫法2"], "note": "一句定位说明", "reason": "为什么该单独监控它（推导依据）" } ] }',
    'ips 给 2-6 个；aliases 给 0-2 个；note 一句话说清它是什么；reason 必须写清从画像哪条信息推导出它。',
    REASON_RULE,
    FACT_RULE,
  ].filter(Boolean).join('\n');

  let res;
  try {
    res = await chatFn([{ role: 'user', content: prompt }], ctx, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.5,
      reasoningEffort: 'none',
    });
  } catch {
    return [];
  }
  if (!res || res.ok !== true || !res.content) return [];

  const parsed = extractJSON(res.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const raw = Array.isArray(parsed.ips) ? parsed.ips : [];
  const existSet = new Set(p.existingNames.map((n) => asStr(n).toLowerCase()).filter(Boolean));

  return raw
    .map((it) => {
      const name = asStr(it && it.name);
      if (!name) return null;
      if (existSet.has(name.toLowerCase())) return null; // 已登记，跳过
      return {
        name,
        aliases: asArray(it && it.aliases).slice(0, 3),
        note: asStr(it && it.note),
        reason: asStr(it && it.reason),
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

export default { genBrandIps };
