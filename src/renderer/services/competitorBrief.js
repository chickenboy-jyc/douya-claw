/**
 * competitorBrief —— 「我是谁」那一段自我介绍（拼进竞品分析四题 prompt 的 `ctx`）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 一、为什么把它从 MarketMomentum.jsx 抽出来（KI-009 缺口 G2）
 * ────────────────────────────────────────────────────────────────────────────
 * 这一段原来埋在 `modules/MarketMomentum.jsx` 里的一个 14 行局部函数（未导出），
 * 后果很具体：**node 测不了**。而 KI-009 剩下的那一半缺口恰好就要断言它的输出
 * （「品牌矩阵有没有进 prompt」），所以只能先把它变成可 import 的纯函数。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 二、它修的是什么（老板实测：自家子公司被写进同行名单）
 * ────────────────────────────────────────────────────────────────────────────
 * 事实链（每一环都有读数，都在 `release/_evidence-0.21.26-rc.1/gap-audit/ki009-fix/`）：
 *   ① `selfBrandGuard.isSelfBrand` 的判据**没错**：
 *      `汉斯夫（杭州）医学科技有限公司` 归一化成 `汉斯夫医学科技`，与 `康健苗苗` 无共同子串
 *      ⇒ 拦不住是**正确**的（它在等用户把 `汉斯夫` 登记进品牌矩阵）；
 *   ② 用户把 `汉斯夫` 登记进 selfBrands 之后，`isSelfBrand(...)` = **true**
 *      ⇒ **判据不需要改**，改判据反而会开始误删真竞品；
 *   ③ 真正缺的是：本函数把 企业名/行业/定位/主营/关键词 都告诉了模型，**唯独没告诉它
 *      「哪些牌子是我自己的」**。模型不知道 `汉斯夫` 是自家的，自然照检索结果把它写进同行 ——
 *      实测 1/4 次。
 *   ⇒ 所以这里新增**第 6 条**：品牌矩阵，并明写「这些都不是同行，不许写进同行名单」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 三、红线
 * ────────────────────────────────────────────────────────────────────────────
 *   1. **零注入**：`selfBrands` 为空数组时，输出必须与改动前**逐字一致**（5 条、无第 6 条）。
 *      这是本模块唯一的兼容性约束，门禁 S5 逐字断言它。
 *   2. **不出空标题**：任何一项没值就不出现，绝不许输出「行业：」「定位：」这种空壳。
 *   3. 纯函数、零依赖、零副作用（不碰 React / store / localStorage），可被 node 直接 import。
 *   4. 分隔符保持 `；`（与改动前一致），内部品牌用 `、` 连接。
 */
import { normBrandName } from './selfBrandGuard.js';

/** 各字段的空值兜底（`undefined` / `null` / 数字 / 对象都不许把拼接搞崩）。 */
function str(v) {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

/**
 * 把 selfBrands 洗成「去重后的非空字符串数组」（保持登记顺序，展示用）。
 *
 * @param {unknown} selfBrands collectSelfBrandNames 的产物（也可能是任意畸形输入）
 * @returns {string[]}
 */
function cleanBrandList(selfBrands) {
  const list = Array.isArray(selfBrands) ? selfBrands : [];
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const s = str(it);
    if (!s) continue;
    const key = normBrandName(s) || s.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * 拼「我的企业」自我介绍。
 *
 * @param {object} [input]
 * @param {object} [input.asset] 营销资产（读 companyName / industry / profile / products）
 * @param {object|null} [input.company] 当前企业（asset 没有 companyName 时兜底读 name）
 * @param {string} [input.keyword] 用户在搜索框输入的关键词
 * @param {string[]} [input.selfBrands] 自家品牌 / 旗下 IP（collectSelfBrandNames 的产物）
 * @returns {string} 一句话自我介绍（`；` 连接；全空时给兜底句）
 */
export function buildSelfBrief(input) {
  const p = input && typeof input === 'object' ? input : {};
  const asset = p.asset && typeof p.asset === 'object' ? p.asset : {};
  const company = p.company && typeof p.company === 'object' ? p.company : {};

  const parts = [];

  const name = str(asset.companyName) || str(company.name);
  if (name) parts.push(`我的企业：${name}`);
  const industry = str(asset.industry);
  if (industry) parts.push(`行业：${industry}`);
  const profile = str(asset.profile);
  if (profile) parts.push(`定位：${profile}`);
  const products = str(asset.products);
  if (products) parts.push(`我主营：${products}`);
  const k = str(p.keyword);
  if (k) parts.push(`我这次关注的关键词：${k}`);

  // 【第 6 条 · KI-009 缺口 G2】品牌矩阵：只在真的登记过时才出现（零注入是兼容性约束）。
  const brands = cleanBrandList(p.selfBrands);
  if (brands.length) {
    parts.push(`本企业/旗下品牌（这些都不是同行，不许写进同行名单）：${brands.join('、')}`);
  }

  return parts.length ? parts.join('；') : '（我的企业资料还没填，请按常见行业常识判断）';
}

export default { buildSelfBrief };
