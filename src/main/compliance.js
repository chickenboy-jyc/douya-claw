'use strict';
/**
 * 文案合规预检（2026-10-19 第十八轮）
 *
 * 为什么要有它：豆芽的用户是口腔门诊 / 器械厂商，发出去的内容受《广告法》
 * 《医疗广告管理办法》约束。绝对化用语、疗效承诺、编造数据是**真会罚款**的三类，
 * 而模型写营销稿时会本能地往这个方向漂（"最好的技术""100% 成功"）。
 * prompt 里的红线只能降低概率，发稿前还得有一道能看见的检查。
 *
 * 设计原则：
 *   - 纯本地规则，零网络依赖 —— 断网也能查，结果稳、可复现、可单测。
 *   - 只做「提示 + 给改法」，不自动改稿：改医疗表述要人确认（改错比不改更危险）。
 *   - 分级：block（明确高风险，必须改）/ warn（需谨慎、要有依据）/ info（提醒留意）。
 *   - 命中给位置和上下文片段，前端能直接高亮，不用人再找。
 */

/** 常见表达 → 更稳妥的写法（只给建议，不自动替换）。 */
const FIX_HINTS = {
  最好: '更合适 / 更适合你',
  最佳: '较优 / 推荐',
  最优: '较优',
  最强: '较强',
  第一: '领先 / 常见选择之一',
  唯一: '少见 / 少见的选择',
  顶级: '专业级 / 高规格',
  极致: '出色 / 讲究',
  国家级: '符合国家标准（如确有资质，请写明证书名称与编号）',
  世界级: '接轨国际标准（如确有依据，请写明）',
  '100%': '高比例（必须附可核查数据来源）',
  百分百: '高比例（必须附可核查数据来源）',
  根治: '改善 / 缓解（按诊疗规范表述）',
  治愈: '控制 / 改善（按诊疗规范表述）',
  治愈率: '临床研究数据（须注明样本量与出处）',
  保证治好: '按诊疗方案预期改善（不得承诺结果）',
  药到病除: '按医嘱治疗',
  立竿见影: '见效较快（个体有差异）',
  一次见效: '按疗程评估效果',
  无痛无风险: '舒适化诊疗，仍存在个体差异',
  零风险: '风险较低，具体以医生评估为准',
  无副作用: '可能有术后反应，遵医嘱护理',
  永久: '长期（不得承诺永久效果）',
  彻底解决: '明显改善',
  全网最低: '具体优惠以门店公示为准',
  史上最低: '具体优惠以门店公示为准',
};

/** 规则表：每条 = 一个可解释的检查项。 */
const RULES = [
  {
    id: 'abs-super',
    level: 'block',
    title: '绝对化用语',
    advice: '《广告法》第九条禁止"国家级""最高级""最佳"等绝对化用语，医疗类尤其敏感。',
    re: /(全国|行业|全网|全球|销量|口碑)(第一|领先|最好|最佳|最优)|排名第一|(最|顶)级|顶尖|极致|国家级|世界级|100%|百分百|唯一|独家|首家|首个|首创|no\.?\s*1/gi,
  },
  {
    id: 'cure-promise',
    level: 'block',
    title: '疗效承诺',
    advice: '医疗广告不得对疗效作保证性承诺，不得说明治愈率或有效率。',
    re: /根治|治愈率|保证治好|包治|药到病除|立竿见影|一次见效|永不复发|彻底(治好|解决|根除)|无痛无风险|零风险|无副作用|百分百(有效|安全)/g,
  },
  {
    id: 'cure-word',
    level: 'warn',
    title: '"治愈"类表述',
    advice: '建议改为"改善""控制""缓解"，并注明个体差异与需遵医嘱。',
    // 只收"治愈"：命中"治愈率"时由 cure-promise 报（block），这里再报一次只会让清单重复、噪音变大。
    re: /治愈(?!率)/g,
  },
  {
    id: 'data-unbacked',
    level: 'warn',
    title: '数据需可溯源',
    advice: '出现百分比/有效率/成功率时，必须能拿出样本量、时间与出处；拿不出就删掉数字。',
    re: /\d{1,3}(\.\d+)?\s*%\s*(的)?(有效率|成功率|满意度|治愈率|复购率|提升|降低)|(有效率|成功率|满意度)\s*(达|超过|高达)?\s*\d{1,3}(\.\d+)?\s*%/g,
  },
  {
    id: 'patient-testimonial',
    level: 'warn',
    title: '患者证言/案例',
    advice: '不得利用患者名义或形象作疗效证明；如要用案例，需取得书面授权并去掉疗效暗示。',
    re: /患者(说|反馈|亲述|自述)|真实案例|亲测|好评如潮|口碑爆棚|零差评|回头客\s*\d+/g,
  },
  {
    id: 'price-bait',
    level: 'warn',
    title: '价格诱导',
    advice: '价格/优惠需与实际一致，避免"史上最低""限时最后一天"这类无法核实的紧迫话术。',
    re: /史上最低|全网最低|跌破底价|限时最后一天|仅此一天|错过再无/g,
  },
  {
    id: 'child-claim',
    level: 'warn',
    title: '儿童相关表述',
    advice: '涉及儿童矫治/儿童口腔时，不得承诺效果或替代医生诊断，需写明"需专业评估"。',
    re: /儿童.{0,8}(保证|一定能|肯定能|必然|绝对)|(保证|绝对).{0,6}儿童/g,
  },
  {
    id: 'diagnosis-substitute',
    level: 'warn',
    title: '替代诊断',
    advice: '内容可以做科普，但不能替代面诊；建议补一句"具体方案需医生面诊评估"。',
    re: /不用(看医生|面诊|去医院)|自己(就能|在家)(治|解决)|替代(就医|面诊|医生)/g,
  },
];

const MAX_HITS = 40;

/**
 * 给命中词找改法：先精确命中，再退化成「包含关系」（如「全国第一」用「第一」的改法）。
 * 找不到就留空 —— 宁可不说，也不要给一条瞎编的建议。
 */
function fixFor(match) {
  if (FIX_HINTS[match]) return FIX_HINTS[match];
  for (const k of Object.keys(FIX_HINTS)) {
    if (match.includes(k)) return FIX_HINTS[k];
  }
  return '';
}

function snippetOf(text, index, len) {
  const from = Math.max(0, index - 18);
  const to = Math.min(text.length, index + len + 18);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '');
}

/**
 * 检查一段文案。
 * @param {string} text
 * @returns {{ok:boolean, clean:boolean, total:number, block:number, warn:number, hits:Array, summary:string}}
 */
function checkText(text) {
  const src = String(text || '');
  if (!src.trim()) {
    return { ok: true, clean: true, total: 0, block: 0, warn: 0, hits: [], summary: '没有可检查的内容。' };
  }
  const hits = [];
  const seen = new Set();
  for (const rule of RULES) {
    // 正则带 g：每次用新建 RegExp，避免 lastIndex 在多次调用间串味（这类 bug 极难查）。
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    let guard = 0;
    while ((m = re.exec(src)) !== null && guard < 200) {
      guard += 1;
      const match = m[0];
      const key = rule.id + '|' + match.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({
          rule: rule.id,
          level: rule.level,
          title: rule.title,
          match,
          index: m.index,
          snippet: snippetOf(src, m.index, match.length),
          advice: rule.advice,
          fix: fixFor(match),
        });
      }
      if (m.index === re.lastIndex) re.lastIndex += 1; // 零长度匹配防死循环
    }
    if (hits.length >= MAX_HITS) break;
  }
  // 同一句里"绝对化用语"和"疗效承诺"都命中时，按严重度 + 出现顺序排，方便从上往下改。
  const rank = { block: 0, warn: 1, info: 2 };
  hits.sort((a, b) => (rank[a.level] - rank[b.level]) || (a.index - b.index));
  const cut = hits.slice(0, MAX_HITS);
  const block = cut.filter((h) => h.level === 'block').length;
  const warn = cut.filter((h) => h.level === 'warn').length;
  const summary = cut.length === 0
    ? '未发现违规表述，可以发。'
    : (block ? `有 ${block} 处高风险、必须改；` : '') + (warn ? `另有 ${warn} 处需谨慎。` : '');
  return { ok: true, clean: cut.length === 0, total: cut.length, block, warn, hits: cut, summary };
}

module.exports = { checkText, RULES, FIX_HINTS };
