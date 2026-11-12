/**
 * coreSearchScenes —— 「AI 搜索核心场景」采集协议（稳定的产品测量对象）。
 *
 * 设计依据：docs/AI搜索核心场景采集协议-v1.md（2026-09-10）。
 * 性质：纯常量 + 纯函数，不 import 框架、不读写 localStorage、不发网络。
 *
 * 核心原则（本轮纠偏）：
 *   「7/20」里的 20 必须是**产品定义的固定核心场景**，不是「后端这次实际问了几个问题」。
 *   否则 7/20 → 12/31 根本无法解释成「企业可见性发生变化」。
 *
 * 采集协议（两条数据流，必须分开）：
 *   - 核心场景（CoreSearchScene）：固定集合，负责形成**长期 baseline**（分母稳定、可比）。
 *   - 探索场景（explore）：豆芽临时发现的新问题，用于市场侦察，**不污染趋势基线**。
 *
 * CoreSearchScene 六字段：
 *   @property {string} sceneId        稳定 id（跨版本不变）
 *   @property {string} question       标准问句（测量工具的问句，采集层应按此盲测）
 *   @property {string} category       分类（选型对比/品牌认知/供应商/价格/资质/售后/应用）
 *   @property {string} importance     重要度 high/mid/low（决定 baseline 权重与展示优先级）
 *   @property {string} expectedIntent 预期意图（选型决策/品牌认知/采购询价/信任核验）
 *   @property {boolean} active        是否启用（停用不参与分母）
 *   @property {string[]} keywords     匹配关键词（后端问句与核心场景对齐用）
 */

/** 场景分类标签。 */
export const SCENE_CATEGORY_LABEL = {
  selection: '选型对比',
  brand: '品牌认知',
  supplier: '供应商/渠道',
  price: '价格行情',
  certification: '资质核验',
  after_sale: '售后服务',
  application: '应用场景',
};

/** 预期意图标签。 */
export const SCENE_INTENT_LABEL = {
  comparison: '选型决策',
  awareness: '品牌认知',
  purchase: '采购询价',
  trust: '信任核验',
};

/**
 * 20 个固定核心场景（口腔产业链 B2B 采购选型 AI 搜索问题）。
 *
 * 覆盖口腔设备/耗材采购决策链路：选型对比 → 品牌认知 → 供应商/渠道 → 价格 → 资质 → 售后 → 应用。
 * 注意：问题措辞是「品类级」，不是「品牌级」——衡量的是「企业在品类采购场景里被 AI 看见」，
 * 不是「XX 品牌被提到」，这样跨企业、跨周期才可比。
 *
 * 主体差异：本轮先做一套口腔产业链通用核心场景（四主体共同面对的市场）。
 * 后续 P2-G 主体重构时，再按主体拆场景集（厂家/平台/经销商/诊所各自聚焦场景不同）。
 */
export const CORE_SEARCH_SCENES = [
  { sceneId: 'css_001', question: '口腔机扩马达哪个牌子好', category: 'selection', importance: 'high', expectedIntent: 'comparison', active: true, keywords: ['机扩马达', '机扩'] },
  { sceneId: 'css_002', question: '根管治疗设备怎么选', category: 'selection', importance: 'high', expectedIntent: 'comparison', active: true, keywords: ['根管治疗设备', '根管治疗'] },
  { sceneId: 'css_003', question: '根测仪哪个品牌准', category: 'selection', importance: 'high', expectedIntent: 'comparison', active: true, keywords: ['根测仪', '根管长度测量'] },
  { sceneId: 'css_004', question: '3M树脂正品怎么辨别', category: 'brand', importance: 'high', expectedIntent: 'trust', active: true, keywords: ['3m树脂', '3m'] },
  { sceneId: 'css_005', question: '根管锉K锉有什么区别', category: 'selection', importance: 'mid', expectedIntent: 'comparison', active: true, keywords: ['根管锉', 'k锉'] },
  { sceneId: 'css_006', question: '光固化灯怎么选', category: 'selection', importance: 'mid', expectedIntent: 'comparison', active: true, keywords: ['光固化灯', '光固化'] },
  { sceneId: 'css_007', question: '口腔种植体品牌对比', category: 'selection', importance: 'mid', expectedIntent: 'comparison', active: true, keywords: ['种植体'] },
  { sceneId: 'css_008', question: '牙科高速手机哪个好', category: 'selection', importance: 'mid', expectedIntent: 'comparison', active: true, keywords: ['高速手机'] },
  { sceneId: 'css_009', question: '口腔消毒柜怎么选型', category: 'application', importance: 'mid', expectedIntent: 'comparison', active: true, keywords: ['消毒柜', '口腔消毒'] },
  { sceneId: 'css_010', question: '口腔诊所设备采购清单', category: 'application', importance: 'high', expectedIntent: 'purchase', active: true, keywords: ['设备采购', '采购清单'] },
  { sceneId: 'css_011', question: '牙科耗材进货渠道', category: 'supplier', importance: 'high', expectedIntent: 'purchase', active: true, keywords: ['耗材进货', '进货渠道'] },
  { sceneId: 'css_012', question: '口腔材料供应商推荐', category: 'supplier', importance: 'high', expectedIntent: 'purchase', active: true, keywords: ['供应商推荐', '材料供应商'] },
  { sceneId: 'css_013', question: '牙科电商平台哪家靠谱', category: 'supplier', importance: 'mid', expectedIntent: 'awareness', active: true, keywords: ['电商平台', '牙科电商'] },
  { sceneId: 'css_014', question: '牙科设备价格行情', category: 'price', importance: 'mid', expectedIntent: 'purchase', active: true, keywords: ['价格行情', '报价'] },
  { sceneId: 'css_015', question: '口腔器械械字号怎么查', category: 'certification', importance: 'high', expectedIntent: 'trust', active: true, keywords: ['械字号', '注册证'] },
  { sceneId: 'css_016', question: '口腔设备售后保障', category: 'after_sale', importance: 'mid', expectedIntent: 'trust', active: true, keywords: ['售后', '保修'] },
  { sceneId: 'css_017', question: '牙科树脂材料怎么选', category: 'selection', importance: 'mid', expectedIntent: 'comparison', active: true, keywords: ['树脂材料', '树脂选型'] },
  { sceneId: 'css_018', question: '口腔诊所数字化设备推荐', category: 'application', importance: 'mid', expectedIntent: 'awareness', active: true, keywords: ['数字化设备', '口扫'] },
  { sceneId: 'css_019', question: '牙科手机维修哪家好', category: 'after_sale', importance: 'low', expectedIntent: 'trust', active: true, keywords: ['手机维修', '牙科维修'] },
  { sceneId: 'css_020', question: '根管马达和普通马达区别', category: 'selection', importance: 'low', expectedIntent: 'comparison', active: true, keywords: ['根管马达', '普通马达'] },
];

/** 取启用的核心场景（默认全部 active=true）。 */
export function getActiveCoreScenes() {
  return CORE_SEARCH_SCENES.filter((s) => s.active !== false);
}

/** 核心场景总数（稳定分母，跨周期可比）。 */
export function coreSceneTotal() {
  return getActiveCoreScenes().length;
}

/** 按 sceneId 找场景。 */
export function getCoreSceneById(sceneId) {
  return CORE_SEARCH_SCENES.find((s) => s.sceneId === sceneId) || null;
}

/**
 * 归一化文本：去空白、转小写（供问句对齐用）。
 */
export function normalizeSceneText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, '').toLowerCase();
}

/**
 * 判断后端问句是否命中某个核心场景。
 * 规则：问句归一化后，包含核心场景任一 keyword（归一化），即视为命中该核心场景。
 * 可解释、可测试，不依赖相似度模型。
 *
 * @param {string} question 后端实际问句
 * @param {Object} scene CoreSearchScene
 * @returns {boolean}
 */
export function matchScene(question, scene) {
  const q = normalizeSceneText(question);
  if (!q) return false;
  const kws = Array.isArray(scene.keywords) ? scene.keywords : [];
  return kws.some((k) => {
    const kk = normalizeSceneText(k);
    return kk && q.includes(kk);
  });
}

/**
 * 采集协议对齐：把后端实际问句集合对齐到核心场景清单。
 *
 * @param {Array<{question:string, mentioned:boolean}>} backendScenes 后端实抓问句（已归一化）
 * @param {Array<Object>} [coreScenes] 核心场景清单（默认全部启用）
 * @returns {{
 *   coreMentioned: number,        // 核心场景中被 AI 提及的数量
 *   coreCovered: number,          // 本轮实际覆盖（后端问到了）的核心场景数
 *   coreTotal: number,            // 核心场景总数（稳定分母）
 *   coreMissedSceneIds: string[], // 清单里有但本轮未覆盖的核心场景 id（诚实标注覆盖不全）
 *   exploreScenes: Array,         // 后端问了但不在核心清单里的（探索场景，不进基线）
 * }}
 */
export function alignScenesToCore(backendScenes, coreScenes = getActiveCoreScenes()) {
  const scenes = Array.isArray(backendScenes) ? backendScenes : [];
  const core = Array.isArray(coreScenes) ? coreScenes : [];

  const coveredSceneIds = new Set();
  const exploreScenes = [];
  let coreMentioned = 0;

  for (const s of scenes) {
    const q = s && s.question;
    // 找命中的核心场景（一个问句只归入第一个命中的核心场景）
    const hit = core.find((c) => matchScene(q, c));
    if (hit) {
      coveredSceneIds.add(hit.sceneId);
      if (s.mentioned) coreMentioned += 1;
    } else if (q) {
      // 不在核心清单里 → 探索场景（市场侦察，不进基线）
      exploreScenes.push({ question: q, mentioned: !!s.mentioned });
    }
  }

  const coreMissedSceneIds = core
    .filter((c) => !coveredSceneIds.has(c.sceneId))
    .map((c) => c.sceneId);

  return {
    coreMentioned,
    coreCovered: coveredSceneIds.size,
    coreTotal: core.length,
    coreMissedSceneIds,
    exploreScenes,
  };
}

export default {
  CORE_SEARCH_SCENES,
  SCENE_CATEGORY_LABEL,
  SCENE_INTENT_LABEL,
  getActiveCoreScenes,
  coreSceneTotal,
  getCoreSceneById,
  normalizeSceneText,
  matchScene,
  alignScenesToCore,
};
