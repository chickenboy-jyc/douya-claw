import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { BRAIN_KEY, normalizeBrain, emptyBrain, hasBrain } from '../config/companyBrain.js';
import { loadTimeline, recordEvent } from '../services/companyTimeline.js';
import { loadGoals } from '../services/companyGoal.js';
import { loadPlanNodes } from '../services/planBrief.js';
import { loadCheckup } from '../services/checkupBrief.js';
// 第九维「活动档期（促销日历）」：与 plan/timeline/goals/checkup 同一模式（独立 key，读时挂载）。
// 纯 service，不 import React ⇒ 不会把 store 拖进纯服务的依赖图。
import { loadPromoRecords } from '../services/promoCalendar.js';

/**
 * Company 长期资产（Company Knowledge）数据层 —— 把企业画像从「一个 context 黑盒」拆成四类：
 *   - profile   CompanyProfile：企业基础资料 / 品牌定位 / 调性 / 产品 / 卖点 / 人群 / 竞品
 *   - facts     CompanyFact：可验证事实（成立时间 / 主营产品 / 公开资质）
 *   - rules     CompanyRule：品牌规则 / 内容禁区 / 合规要求
 *   - memories  CompanyMemory：AI 长期需要记住的信息（长期营销偏好 / 历史策略 / 重要决策）
 *
 * 四类按企业隔离：`douya-company-knowledge = { [companyId]: { profile, facts, rules, memories } }`。
 * 迁移自旧数据：Company.memory（facts/restrictions）与营销资产（brandTone/brandFacts/contentTaboos 等），
 * 迁移幂等——已有 knowledge 不再重复迁移；旧字段保留作兼容层，contextBuilder 优先读本 store、回退旧字段。
 */

// 纯数据模型已拆到 companyKnowledgeModel.js（无 React / 无 JSX）——
// 统一读取入口 services/companyContext.js 必须用**同一套归一化**，但它是纯 service：
// 若直接 import 本 .jsx，Node 直跑的单测会抛 `Unknown file extension ".jsx"`
// （本仓 directionRecommend / planGuidance 等确实走 Node 直跑、不经打包）。
// 故此处 import 后**原样 re-export**：对外 API 一个不少，调用方一行不改。
import {
  KNOWLEDGE_KEY,
  asStr,
  asArray,
  normalizeKnowledge,
  emptyKnowledge,
  normalizeBrandIp,
} from './companyKnowledgeModel.js';
export {
  KNOWLEDGE_KEY,
  normalizeKnowledge,
  emptyKnowledge,
  normalizeBrandIp,
} from './companyKnowledgeModel.js';

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// ==================== 旗下 IP / 子品牌（brandIps）====================
// 客户往往是品牌矩阵（母公司 + 多个子品牌/产品线 IP），公关危机必须逐个 IP 分别监控。
// 存在 profile.brandIps（profile 透传未知字段，故不需要动 companyStore 的白名单重建）。
// ⚠️ normalizeBrandIp / normalizeKnowledge / emptyKnowledge 已移到 companyKnowledgeModel.js（上方 import 后 re-export）；此处只留读取辅助。

/**
 * 从企业知识中读取旗下 IP 列表（容错：字段缺失/类型不对一律返回 []）。
 * @param {object|null} knowledge normalizeKnowledge 产出的知识对象
 * @returns {Array<{id:string, name:string, aliases:string[], note:string, enabled:boolean, createdAt:number}>}
 */
export function listBrandIps(knowledge) {
  const k = knowledge && typeof knowledge === 'object' ? knowledge : {};
  const profile = k.profile && typeof k.profile === 'object' ? k.profile : {};
  const raw = profile.brandIps;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeBrandIp)
    .filter((ip) => ip.name);
}

/** 读取主品牌（母公司名称）的别名数组（容错）。 */
export function listBrandMainAliases(knowledge) {
  const k = knowledge && typeof knowledge === 'object' ? knowledge : {};
  const profile = k.profile && typeof k.profile === 'object' ? k.profile : {};
  const raw = profile.brandMainAliases;
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((v) => {
    const s = asStr(v).trim();
    if (s && !out.includes(s)) out.push(s);
  });
  return out;
}

function loadKnowledgeMap() {
  try {
    const raw = localStorage.getItem(KNOWLEDGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

// ==================== 公司画像中枢（Company Brain）====================
// brain 独立 key（douya-company-brain），按 companyId 隔离：{ [companyId]: brain }。
// 不并入 douya-company-knowledge 四类知识，避免污染四主体知识逻辑。

/** 读 brain map（容错：异常/非法结构一律回 {}）。 */
function loadBrainMap() {
  try {
    const raw = localStorage.getItem(BRAIN_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/**
 * 一次性迁移（保留函数位）：brain 是全新独立 key，无历史数据需要迁移，空即可。
 * 未来 schema 升级时在此做一次性迁移。
 * @returns {object} 当前 brain map
 */
export function migrateBrainOnce() {
  return loadBrainMap();
}

/**
 * 一次性迁移：从旧 Company.memory + 营销资产生成四类知识，写回 knowledge map。
 * 幂等：仅当该公司还没有 knowledge 时才迁移。返回迁移后的完整 map（对象）。
 */
export function migrateKnowledgeOnce() {
  const map = loadKnowledgeMap();
  let dirty = false;

  // 旧企业（含 memory）
  let companies = [];
  try {
    const raw = localStorage.getItem('douya-companies');
    if (raw) {
      const p = JSON.parse(raw);
      companies = Array.isArray(p) ? p : [];
    }
  } catch {
    companies = [];
  }

  // 旧营销资产 map
  let assetsMap = {};
  try {
    const raw = localStorage.getItem('douya-marketing-assets');
    if (raw) {
      const p = JSON.parse(raw);
      assetsMap = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    }
  } catch {
    assetsMap = {};
  }

  for (const c of companies) {
    if (!c || !c.id) continue;
    const cid = String(c.id);
    if (map[cid]) continue; // 已迁移，跳过

    const mem = c.memory && typeof c.memory === 'object' ? c.memory : {};
    const asset = assetsMap[cid] || {};
    const profile = {
      brandPositioning: asStr(asset.brandTone),
      industry: asStr(asset.industry),
      products: asStr(asset.products),
      summary: asStr(asset.profile),
      coreSellingPoints: asArray(asset.coreSellingPoints),
      targetCustomers: asArray(asset.targetCustomers),
      competitors: asArray(asset.competitors),
    };
    const facts = asArray(asset.brandFacts).concat(asArray(mem.facts));
    const rules = asArray(asset.contentTaboos).concat(asArray(asset.complianceWords)).concat(asArray(mem.restrictions));
    const memories = [];

    map[cid] = normalizeKnowledge({ profile, facts, rules, memories });
    dirty = true;
  }

  if (dirty) {
    try {
      localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(map));
    } catch {
      /* 忽略写失败 */
    }
  }
  return map;
}

/** 数组去重追加（返回新数组，不改原数组）。 */
function mergeUnique(base, extra) {
  return extra.reduce((acc, v) => (acc.includes(v) ? acc : acc.concat(v)), base);
}

/**
 * 资产回流知识库：把营销资产的画像字段与事实/规则同步写入某企业的四类知识（直接操作 localStorage，幂等）。
 * - profile 字段用资产值覆盖：companyName / brandPositioning(brandTone) / industry / products /
 *   summary(profile) / coreSellingPoints / targetCustomers / competitors
 * - facts 用 asset.brandFacts 追加（去重，保留已有手动事实）
 * - rules 用 asset.contentTaboos + asset.complianceWords 追加（去重，保留已有手动规则）
 * 纯函数、不依赖 React Context，供 marketingStore 直接导入，避免与 provider 的循环依赖。
 * @param {string|number} companyId
 * @param {object} asset 营销资产对象
 * @returns {object|null} 写回后的该企业知识（归一化）；companyId 缺失或 asset 无效时返回 null
 */
// ==================== 知识库变更订阅器 ====================
// 纯函数（syncAssetToKnowledge / syncAssetConclusionToKnowledge）直接写 localStorage，
// 但 Provider 的 in-memory state 只在 mount 时读一次，同页写入无法被感知（storage 事件仅跨标签页触发）。
// 因此提供模块级订阅：纯函数写入后广播，Provider 订阅后 setMap(loadKnowledgeMap()) 重新加载，
// 保证「营销画像 / AI 产物回流知识库」在当次会话内即时被 getKnowledge 读到。
const knowledgeListeners = new Set();
export function subscribeKnowledgeChange(fn) {
  knowledgeListeners.add(fn);
  return () => knowledgeListeners.delete(fn);
}
function notifyKnowledgeChange() {
  knowledgeListeners.forEach((fn) => {
    try { fn(); } catch { /* 忽略单个监听器异常 */ }
  });
}

export function syncAssetToKnowledge(companyId, asset) {
  const cid = companyId ? String(companyId) : '';
  if (!cid || !asset || typeof asset !== 'object') return null;
  const a = asset;
  const map = loadKnowledgeMap();
  const cur = normalizeKnowledge(map[cid]);

  cur.profile = {
    ...cur.profile,
    companyName: asStr(a.companyName),
    brandPositioning: asStr(a.brandTone),
    industry: asStr(a.industry),
    products: asStr(a.products),
    summary: asStr(a.profile),
    coreSellingPoints: asArray(a.coreSellingPoints),
    targetCustomers: asArray(a.targetCustomers),
    competitors: asArray(a.competitors),
  };
  cur.facts = mergeUnique(cur.facts, asArray(a.brandFacts));
  cur.rules = mergeUnique(cur.rules, asArray(a.contentTaboos).concat(asArray(a.complianceWords)));

  map[cid] = cur;
  try {
    localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(map));
  } catch {
    /* 忽略写失败 */
  }
  notifyKnowledgeChange();
  return cur;
}

// ==================== AI 产物结论回流 ====================
// 各模块的 AI 产物（竞品报告 / 活动方案 / 文案 / 学习资料等）此前只进资产库（Asset），
// 从不回流企业知识库，导致后续 AI 调用读不到「我们做过什么、得出过什么结论」。
// 这里把「结论类」Asset 的名称 + 内容摘要作为一条企业长期记忆（memories）幂等写入。
const CONCLUSION_TYPE_LABEL = {
  document: '分析报告',
  event_plan: '活动方案',
  event_material: '活动素材',
  crisis_report: '舆情报告',
  media_plan: '媒体方案',
  copy: '文案',
  moments_copy: '朋友圈文案',
  community_copy: '社群文案',
  article: '文章',
  social_post: '社媒帖子',
  reference: '学习资料',
};
const CONCLUSION_CONTENT_MAX = 200;   // 记忆正文截断长度（防撑爆 AI 上下文）
const MEMORIES_MAX = 60;              // 单企业记忆条数上限（超出丢最旧）

export function syncAssetConclusionToKnowledge(companyId, asset) {
  const cid = companyId ? String(companyId) : '';
  if (!cid || !asset || typeof asset !== 'object') return null;
  const label = CONCLUSION_TYPE_LABEL[asset.type];
  if (!label) return null; // 非结论类产物（图片/视频/品牌素材等）不回填
  const name = asStr(asset.name);
  const content = asset.content != null ? String(asset.content) : '';
  if (!name && !content) return null;
  return syncConclusionToKnowledge(cid, { label, name, content });
}

/**
 * 通用「结论 / 经营决策」回流企业记忆（memories）。
 * 供「结论类 Asset」（syncAssetConclusionToKnowledge）与「经营决策类一级对象」
 * （Direction 经营方向 / Campaign 营销专项）共用同一套幂等写入逻辑。
 *
 * @param {string|number} companyId
 * @param {{ label: string, name: string, content: string }} payload
 * @returns {object|null} 写回后的该企业知识（归一化）；companyId 缺失或 name/content 均空时返回 null
 */
export function syncConclusionToKnowledge(companyId, { label, name, content } = {}) {
  const cid = companyId ? String(companyId) : '';
  if (!cid) return null;
  const l = asStr(label);
  const n = asStr(name);
  const c = content != null ? String(content) : '';
  if (!n && !c) return null;

  const body = c.replace(/\s+/g, ' ').trim();
  const trimmed = body.length > CONCLUSION_CONTENT_MAX ? body.slice(0, CONCLUSION_CONTENT_MAX) + '…' : body;
  const key = `${l}《${n || '未命名'}》`;
  const memory = trimmed ? `${key}：${trimmed}` : key;

  const map = loadKnowledgeMap();
  const cur = normalizeKnowledge(map[cid]);
  // 幂等：同名同类型已存在则跳过
  if (cur.memories.some((m) => String(m).startsWith(key))) return cur;
  cur.memories = cur.memories.concat(memory);
  if (cur.memories.length > MEMORIES_MAX) cur.memories = cur.memories.slice(cur.memories.length - MEMORIES_MAX);

  map[cid] = cur;
  try {
    localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(map));
  } catch {
    /* 忽略写失败 */
  }
  // 阶段一：结论/决策按时间段沉淀进企业档案时间轴（「本月做了什么」），与 memories 并行记录。
  recordEvent(cid, { label: key, kind: l });
  notifyKnowledgeChange();
  return cur;
}

const KnowledgeContext = createContext(null);

export function CompanyKnowledgeProvider({ children }) {
  const [map, setMap] = useState(() => {
    migrateKnowledgeOnce();
    return loadKnowledgeMap();
  });

  // 订阅纯函数写入：外部 store（marketingStore/assetStore）经纯函数写 localStorage 后，
  // 这里重新加载 map，保证 getKnowledge 当次会话内即时读到最新回流数据。
  useEffect(() => subscribeKnowledgeChange(() => setMap(loadKnowledgeMap())), []);

  // 持久化
  useEffect(() => {
    try {
      localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(map));
    } catch {
      /* 忽略写失败 */
    }
  }, [map]);

  // ==================== 公司画像中枢（brain）====================
  const [brainMap, setBrainMap] = useState(() => {
    migrateBrainOnce();
    return loadBrainMap();
  });

  // brain 持久化（独立 key，不污染四类知识）
  useEffect(() => {
    try {
      localStorage.setItem(BRAIN_KEY, JSON.stringify(brainMap));
    } catch {
      /* 忽略写失败 */
    }
  }, [brainMap]);

  /**
   * 读某企业四类知识（归一化；无则空知识）。附带第五维「时间轴」+ 第六维「企业目标（方向盘）」
   * + 第七维「已排方案（日历）」+ 第八维「企业体检结论」+ 第九维「活动档期（促销日历）」。
   * plan / timeline / goals / checkup / promos 完全对称：都是外部数据源（独立 key）在读取时挂载。
   * checkup 走独立 key `douya-company-checkup`（**不进 facts/rules/memories**），
   * AI 上下文里以「AI 假设」抬头注入 —— 既不丢豆芽的判断，也不污染企业事实。
   * promos 走独立 key `douya-promo-calendar`（见 services/promoCalendar.js），
   * 是「活动档期」事实层：让活动策划知道下周在跑什么、哪些档期在同期重叠。
   */
  const getKnowledge = useCallback((companyId) => {
    const cid = companyId ? String(companyId) : '';
    if (!cid) return emptyKnowledge();
    return {
      ...normalizeKnowledge(map[cid]),
      timeline: loadTimeline(cid),
      goals: loadGoals(cid),
      plan: loadPlanNodes(cid),
      checkup: loadCheckup(cid),
      promos: loadPromoRecords(cid),
    };
  }, [map]);

  /** 更新某企业 profile（浅合并）。 */
  const updateProfile = useCallback((companyId, patch) => {
    const cid = String(companyId || '');
    if (!cid) return;
    setMap((prev) => {
      const cur = normalizeKnowledge(prev[cid]);
      cur.profile = { ...cur.profile, ...(patch && typeof patch === 'object' ? patch : {}) };
      return { ...prev, [cid]: cur };
    });
  }, []);

  /** 读某企业旗下 IP / 子品牌列表（已归一化）。 */
  const getBrandIps = useCallback((companyId) => listBrandIps(getKnowledge(companyId)), [getKnowledge]);

  /**
   * 整体覆盖写入某企业旗下 IP 列表（先归一化再写，脏数据自然被过滤）。
   * 注意：不在这里同步调用 notifyKnowledgeChange——Provider 的持久化 effect 在 render 之后才写
   * localStorage，同tick 广播会让监听器读回旧值覆盖刚写入的 state；故延迟一拍再广播。
   */
  const setBrandIps = useCallback((companyId, ips) => {
    const cid = String(companyId || '');
    if (!cid) return;
    const list = (Array.isArray(ips) ? ips : []).map(normalizeBrandIp).filter((ip) => ip.name);
    setMap((prev) => {
      const cur = normalizeKnowledge(prev[cid]);
      cur.profile = { ...cur.profile, brandIps: list };
      return { ...prev, [cid]: cur };
    });
    setTimeout(() => notifyKnowledgeChange(), 0);
  }, []);

  /** 读主品牌（母公司名称）的别名数组。 */
  const getBrandMainAliases = useCallback((companyId) => listBrandMainAliases(getKnowledge(companyId)), [getKnowledge]);

  /** 写入主品牌别名数组（去重去空）。 */
  const setBrandMainAliases = useCallback((companyId, aliases) => {
    const cid = String(companyId || '');
    if (!cid) return;
    const list = (Array.isArray(aliases) ? aliases : [])
      .map((x) => asStr(x).trim())
      .filter((v, i, arr) => !!v && arr.indexOf(v) === i);
    setMap((prev) => {
      const cur = normalizeKnowledge(prev[cid]);
      cur.profile = { ...cur.profile, brandMainAliases: list };
      return { ...prev, [cid]: cur };
    });
    setTimeout(() => notifyKnowledgeChange(), 0);
  }, []);

  const addFact = useCallback((companyId, fact) => {
    const cid = String(companyId || '');
    const v = asStr(fact);
    if (!cid || !v) return;
    setMap((prev) => {
      const cur = normalizeKnowledge(prev[cid]);
      if (!cur.facts.includes(v)) cur.facts = cur.facts.concat(v);
      return { ...prev, [cid]: cur };
    });
  }, []);

  const addRule = useCallback((companyId, rule) => {
    const cid = String(companyId || '');
    const v = asStr(rule);
    if (!cid || !v) return;
    setMap((prev) => {
      const cur = normalizeKnowledge(prev[cid]);
      if (!cur.rules.includes(v)) cur.rules = cur.rules.concat(v);
      return { ...prev, [cid]: cur };
    });
  }, []);

  const addMemory = useCallback((companyId, memory) => {
    const cid = String(companyId || '');
    const v = asStr(memory);
    if (!cid || !v) return;
    setMap((prev) => {
      const cur = normalizeKnowledge(prev[cid]);
      if (!cur.memories.includes(v)) cur.memories = cur.memories.concat(v);
      return { ...prev, [cid]: cur };
    });
  }, []);

  /**
   * 「结论 / 经营决策」回流企业记忆（memories + 时间轴）。
   * 供外部消费方（如「本页智能助手」面板）把一段结论记入企业大脑，不必直接 import 纯函数。
   * 内部走 syncConclusionToKnowledge（同文件纯函数，幂等 + 写后 notifyKnowledgeChange 广播）。
   * @param {string|number} companyId
   * @param {{ label: string, name: string, content: string }} payload
   * @returns {object|null} 写回后的该企业知识；companyId 缺失或 name/content 均空时返回 null
   */
  const recordConclusion = useCallback((companyId, payload) => {
    const cid = companyId ? String(companyId) : '';
    if (!cid) return null;
    return syncConclusionToKnowledge(cid, payload && typeof payload === 'object' ? payload : {});
  }, []);

  const removeFromList = useCallback((companyId, key, value) => {
    const cid = String(companyId || '');
    const v = asStr(value);
    if (!cid || !v || !['facts', 'rules', 'memories'].includes(key)) return;
    setMap((prev) => {
      const cur = normalizeKnowledge(prev[cid]);
      cur[key] = cur[key].filter((x) => x !== v);
      return { ...prev, [cid]: cur };
    });
  }, []);

  // ---- 公司画像中枢（brain）方法 ----

  /** 读某企业 brain（归一化；无则 emptyBrain()）。 */
  const getBrain = useCallback((companyId) => {
    const cid = companyId ? String(companyId) : '';
    if (!cid) return emptyBrain();
    return normalizeBrain(brainMap[cid]);
  }, [brainMap]);

  /** 整体覆盖写入某企业 brain（normalizeBrain 后浅合并 map，按 cid 覆盖）。 */
  const setBrain = useCallback((companyId, brain) => {
    const cid = String(companyId || '');
    if (!cid) return;
    setBrainMap((prev) => ({ ...prev, [cid]: normalizeBrain(brain) }));
  }, []);

  /** 浅合并更新某企业 brain（取现有 brain 归一化后浅合并 patch，再 normalizeBrain 写回）。 */
  const updateBrain = useCallback((companyId, patch) => {
    const cid = String(companyId || '');
    if (!cid) return;
    setBrainMap((prev) => {
      const cur = normalizeBrain(prev[cid]);
      const merged = normalizeBrain({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) });
      return { ...prev, [cid]: merged };
    });
  }, []);

  /** 删除某企业 brain（重置为空，下次 getBrain 返回 emptyBrain()）。 */
  const clearBrain = useCallback((companyId) => {
    const cid = String(companyId || '');
    if (!cid) return;
    setBrainMap((prev) => {
      if (!(cid in prev)) return prev;
      const next = { ...prev };
      delete next[cid];
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      map,
      getKnowledge,
      updateProfile,
      getBrandIps,
      setBrandIps,
      getBrandMainAliases,
      setBrandMainAliases,
      addFact,
      addRule,
      addMemory,
      recordConclusion,
      removeFromList,
      brainMap,
      getBrain,
      setBrain,
      updateBrain,
      clearBrain,
    }),
    [map, getKnowledge, updateProfile, getBrandIps, setBrandIps, getBrandMainAliases, setBrandMainAliases, addFact, addRule, addMemory, recordConclusion, removeFromList, brainMap, getBrain, setBrain, updateBrain, clearBrain],
  );

  return <KnowledgeContext.Provider value={value}>{children}</KnowledgeContext.Provider>;
}

export function useCompanyKnowledge() {
  const ctx = useContext(KnowledgeContext);
  if (!ctx) throw new Error('useCompanyKnowledge 必须在 <CompanyKnowledgeProvider> 子树内使用');
  return ctx;
}

export default CompanyKnowledgeProvider;
