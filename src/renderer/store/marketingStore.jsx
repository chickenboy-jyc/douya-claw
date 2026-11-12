import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { geoProxy } from '../api.js';
import {
  analyzeCompany,
  analysisToAsset,
  assetToAnalyzeInput,
} from '../services/companyProfile.js';
import { GOAL_GROUPS, routeForGoal } from './goalCatalog.js';
import { useCompany } from './companyStore.jsx';
import { syncAssetToKnowledge } from './companyKnowledgeStore.jsx';

/**
 * localStorage key：
 * - 资产按企业隔离：`douya-marketing-assets` = { [companyId]: asset }
 * - 营销目标挂在项目上：由 companyStore 的 project.goalId 承载（不再单独存）
 */
export const ASSETS_MAP_KEY = 'douya-marketing-assets';
export const ASSET_STORAGE_KEY = 'douya-marketing-asset'; // 老版本单份 key（迁移用）
export const GOAL_STORAGE_KEY = 'douya-marketing-goal'; // 老版本单份 key（迁移用，现已挂项目）

/** 数组字段（统一默认 []，编辑时兼容 string↔string[]） */
const ARRAY_FIELDS = [
  'coreSellingPoints',
  'targetCustomers',
  'competitors',
  'brandFacts',
  'expertResources',
  'successCases',
  'customerPains',
  'contentTaboos',
  'complianceWords',
];

/** 字符串字段（统一默认 ''） */
const STRING_FIELDS = [
  'companyName',
  'industry',
  'profile',
  'products',
  'brandTone',
  'marketingStrategy',
];

/** 企业营销资产 schema（13 字段 + 建档最小字段 + meta）。 */
export const EMPTY_ASSET = {
  companyName: '',
  industry: '',
  profile: '',
  products: '',
  coreSellingPoints: [],
  targetCustomers: [],
  competitors: [],
  brandTone: '',
  brandFacts: [],
  expertResources: [],
  successCases: [],
  customerPains: [],
  contentTaboos: [],
  complianceWords: [],
  marketingStrategy: '',
  meta: {
    builtAt: null,
    analyzedAt: null,
    degraded: false,
    source: 'manual',
  },
};

function cloneEmptyAsset() {
  return {
    companyName: '',
    industry: '',
    profile: '',
    products: '',
    coreSellingPoints: [],
    targetCustomers: [],
    competitors: [],
    brandTone: '',
    brandFacts: [],
    expertResources: [],
    successCases: [],
    customerPains: [],
    contentTaboos: [],
    complianceWords: [],
    marketingStrategy: '',
    meta: { builtAt: null, analyzedAt: null, degraded: false, source: 'manual' },
  };
}

function normalizeMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    builtAt: m.builtAt == null ? null : m.builtAt,
    analyzedAt: m.analyzedAt == null ? null : m.analyzedAt,
    degraded: !!m.degraded,
    source: m.source === 'ai' ? 'ai' : 'manual',
  };
}

function normalizeAsset(parsed) {
  const base = cloneEmptyAsset();
  const merged = { ...base, ...parsed, meta: normalizeMeta(parsed && parsed.meta) };
  for (const k of ARRAY_FIELDS) {
    if (!Array.isArray(merged[k])) merged[k] = [];
  }
  for (const k of STRING_FIELDS) {
    if (typeof merged[k] !== 'string') merged[k] = '';
  }
  return merged;
}

/**
 * 判断一个「AI 映射值」是不是空值（空数组 / 空串 / null / 空对象）。
 *
 * 用途见 mergeAiMapped：AI 刷新**不许用空值覆盖**已确认资产。
 * @param {unknown} v 待判定值
 * @returns {boolean} true = 空值（不应覆盖既有内容）
 */
function isEmptyMappedValue(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/**
 * 【0.21.14 · 修「刷新一句就把已确认资产洗掉」】AI 映射结果的合并策略：**只用非空值覆盖**。
 *
 * 缺陷现场（team-lead 复核确认）：
 *   · `analysisToAsset()` 对「用户确认/手填类」字段固定返回空值 ——
 *     `competitors: []`、`expertResources: []`、`successCases: []`、`customerPains: []`、
 *     `contentTaboos: []`、`complianceWords: []`、`brandTone: ''`（见 companyProfile.js:446-457）；
 *   · 而 `buildAsset` / `refreshAsset` 用 `{ ...prev, ...mapped }` 展开 ⇒
 *     **这些空值会把用户已经确认过的竞品清单 / 医生专家 / 成功案例 / 品牌调性静默清空**。
 *   后果：老板点一次「手动刷新画像」，商机库里确认过的数据就没了，且界面只显示「画像已刷新」。
 *
 * 修法边界（team-lead 明确要求）：
 *   · **只拦 AI 路径**：本函数仅被 `buildAsset` / `refreshAsset` 使用；
 *   · 用户**显式**编辑（`updateField` / `updateAsset`）语义**一个字没改** ——
 *     手动清空一个竞品、清空「品牌调性」输入框，仍然立刻生效（否则就是「修覆盖」修成「不能改」）；
 *   · 「非空值」照常覆盖（AI 新拿到的画像 / 卖点 / 事实库会写进去），
 *     且 prev 里没有的新字段同样能写入 ⇒ 刷新依然有作用，不会被这条策略变成空操作。
 *
 * @param {object} prev 当前资产
 * @param {object} mapped analysisToAsset 的产出
 * @returns {object} 合并结果（不修改入参）
 */
export function mergeAiMapped(prev, mapped) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const patch = mapped && typeof mapped === 'object' ? mapped : {};
  const next = { ...base };
  for (const key of Object.keys(patch)) {
    // meta 走各自调用点的显式赋值，这里不碰，避免把 analyzedAt 之类覆盖掉。
    if (key === 'meta') continue;
    if (isEmptyMappedValue(patch[key])) continue; // ← 空值不覆盖：这就是本次修复的核心一行
    next[key] = patch[key];
  }
  return next;
}

function loadAssetsMap() {
  try {
    const raw = localStorage.getItem(ASSETS_MAP_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/** 读某企业的资产；无则回退老单份 key（迁移场景）；再兜底空资产。 */
function loadAssetFor(companyId) {
  const map = loadAssetsMap();
  if (companyId && map[companyId]) return normalizeAsset(map[companyId]);
  try {
    const legacy = localStorage.getItem(ASSET_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed && typeof parsed === 'object') return normalizeAsset(parsed);
    }
  } catch {
    /* 忽略 */
  }
  return cloneEmptyAsset();
}

const GoalContext = createContext(null);
const AssetContext = createContext(null);

/**
 * 营销状态 Provider：资产按「企业」隔离，目标按「项目」承载。
 * 依赖 CompanyProvider（外层包裹），读取当前企业/项目。
 */
export function MarketingProvider({ children }) {
  const { currentCompanyId, currentProject, setProjectGoal } = useCompany();

  // ===================== 资产（按企业隔离） =====================
  const [asset, setAsset] = useState(() => loadAssetFor(currentCompanyId));
  const [status, setStatus] = useState(() => {
    const a = loadAssetFor(currentCompanyId);
    if (a.meta.builtAt == null && !(a.companyName && String(a.companyName).trim())) return 'idle';
    return a.meta.degraded ? 'degraded' : 'ready';
  });
  const [error, setError] = useState('');

  // 迁移：老单份资产 → 当前企业（仅一次）
  useEffect(() => {
    try {
      const legacy = localStorage.getItem(ASSET_STORAGE_KEY);
      if (!legacy || !currentCompanyId) return;
      const map = loadAssetsMap();
      if (!map[currentCompanyId]) {
        map[currentCompanyId] = JSON.parse(legacy);
        localStorage.setItem(ASSETS_MAP_KEY, JSON.stringify(map));
      }
      localStorage.removeItem(ASSET_STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
  }, [currentCompanyId]);

  // 切换企业：重新加载该企业资产
  useEffect(() => {
    const a = loadAssetFor(currentCompanyId);
    setAsset(a);
    setStatus(
      a.meta.builtAt != null || (a.companyName && String(a.companyName).trim())
        ? a.meta.degraded ? 'degraded' : 'ready'
        : 'idle',
    );
    setError('');
  }, [currentCompanyId]);

  const hasAsset = useMemo(
    () => !!(asset.companyName && String(asset.companyName).trim()) || asset.meta.builtAt != null,
    [asset],
  );

  const assetRef = useRef(asset);
  useEffect(() => {
    assetRef.current = asset;
  }, [asset]);

  // 资产变化即持久化（按当前企业写回 map），并同步回流企业知识库（画像 + 事实 + 规则）。
  useEffect(() => {
    if (asset.meta.builtAt != null || (asset.companyName && String(asset.companyName).trim())) {
      try {
        const map = loadAssetsMap();
        map[currentCompanyId] = asset;
        localStorage.setItem(ASSETS_MAP_KEY, JSON.stringify(map));
      } catch {
        /* 忽略写失败 */
      }
      // 资产更新 → 同步写入 companyKnowledgeStore（幂等纯函数，避免循环依赖）
      syncAssetToKnowledge(currentCompanyId, asset);
    }
  }, [asset, currentCompanyId]);

  // ===================== 营销目标（挂在当前项目） =====================
  const goal = useMemo(() => {
    const goalId = currentProject && currentProject.goalId;
    if (!goalId) return null;
    for (const g of GOAL_GROUPS) {
      for (const item of g.goals) {
        if (item.id === goalId) {
          const route = routeForGoal(item.id);
          return {
            groupId: g.id,
            goalId: item.id,
            label: item.label,
            icon: g.icon,
            module: route.module,
            steps: route.steps || [],
            gap: route.gap,
          };
        }
      }
    }
    return null;
  }, [currentProject]);

  const route = useMemo(
    () => (goal ? routeForGoal(goal.goalId) : { module: null, steps: [], gap: '' }),
    [goal],
  );

  const selectGoal = useCallback(
    (goalId) => {
      setProjectGoal(goalId);
      return routeForGoal(goalId);
    },
    [setProjectGoal],
  );

  const clearGoal = useCallback(() => {
    setProjectGoal(null);
  }, [setProjectGoal]);

  const goalLabelRef = useRef('');
  useEffect(() => {
    goalLabelRef.current = goal ? goal.label : '';
  }, [goal]);

  /**
   * 建档：调 analyzeCompany 深度分析，成功后映射 13 字段并落盘；失败保留手填字段并标记降级。
   */
  const buildAsset = useCallback(async (input) => {
    const companyName = String((input && input.companyName) || '').trim();
    if (!companyName) {
      setError('请填写公司名称');
      return { ok: false, degraded: true, error: '请填写公司名称' };
    }
    setStatus('analyzing');
    setError('');
    const now = new Date().toISOString();
    const industry = String((input && input.industry) || '').trim();
    const brandDesc = String((input && input.brandDesc) || '').trim();
    const products = String((input && input.products) || '').trim();
    const audience = String((input && input.audience) || '').trim();

    const ares = await analyzeCompany(geoProxy, {
      companyName,
      industry,
      brandDesc,
      products,
      audience,
      goal: goalLabelRef.current,
    });

    if (ares.ok && ares.profile) {
      const mapped = analysisToAsset(ares.profile, { companyName, industry, brandDesc, products, audience });
      // mergeAiMapped：AI 只覆盖**非空值** —— 见该函数注释（不再把用户确认过的竞品/专家/案例清空）。
      setAsset((prev) => ({
        ...cloneEmptyAsset(),
        ...mergeAiMapped(prev, mapped),
        companyName,
        industry,
        meta: { builtAt: now, analyzedAt: now, degraded: false, source: 'ai' },
      }));
      setStatus('ready');
      return { ok: true, degraded: false, error: '' };
    }

    const audienceList = audience
      .split(/[、，,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setAsset((prev) => ({
      ...cloneEmptyAsset(),
      ...prev,
      companyName,
      industry,
      profile: brandDesc || (prev && prev.profile) || '',
      products: products || (prev && prev.products) || '',
      targetCustomers: audienceList.length ? audienceList : (prev && prev.targetCustomers) || [],
      meta: { builtAt: now, analyzedAt: null, degraded: true, source: 'manual' },
    }));
    setError(ares.error || 'AI 分析不可用，已保留手动填写的企业信息');
    setStatus('degraded');
    return { ok: false, degraded: true, error: ares.error || 'AI 分析不可用' };
  }, []);

  const refreshAsset = useCallback(async () => {
    const input = assetToAnalyzeInput(assetRef.current);
    if (!input.companyName) {
      setError('请先完善企业名称后再刷新画像');
      return { ok: false, degraded: true, error: '请先完善企业名称' };
    }
    setStatus('analyzing');
    setError('');
    const now = new Date().toISOString();

    const ares = await analyzeCompany(geoProxy, {
      ...input,
      goal: goalLabelRef.current,
    });

    if (ares.ok && ares.profile) {
      const mapped = analysisToAsset(ares.profile, input);
      // mergeAiMapped：同上 —— 刷新不再清空已确认的竞品 / 医生专家 / 成功案例 / 品牌调性。
      // ⚠️ 用户手动清空仍走 updateField / updateAsset，语义未改（那才是「用户显式表态」）。
      setAsset((prev) => ({
        ...mergeAiMapped(prev, mapped),
        companyName: input.companyName,
        industry: input.industry,
        meta: { ...prev.meta, analyzedAt: now, degraded: false, source: 'ai' },
      }));
      setStatus('ready');
      return { ok: true, degraded: false, error: '' };
    }

    setAsset((prev) => ({
      ...prev,
      meta: { ...prev.meta, analyzedAt: null, degraded: true, source: 'manual' },
    }));
    setError(ares.error || '刷新失败');
    setStatus('degraded');
    return { ok: false, degraded: true, error: ares.error || '刷新失败' };
  }, []);

  const updateField = useCallback((key, value) => {
    setAsset((prev) => {
      const next = { ...prev };
      if (ARRAY_FIELDS.includes(key)) {
        if (Array.isArray(value)) {
          next[key] = value.map((v) => String(v).trim()).filter(Boolean);
        } else if (typeof value === 'string') {
          next[key] = value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        } else {
          next[key] = [];
        }
      } else if (STRING_FIELDS.includes(key)) {
        next[key] = String(value == null ? '' : value);
      } else {
        next[key] = value;
      }
      return next;
    });
  }, []);

  const updateAsset = useCallback((patch) => {
    setAsset((prev) => {
      if (!patch || typeof patch !== 'object') return prev;
      const next = { ...prev, ...patch };
      if (patch.meta) next.meta = { ...prev.meta, ...patch.meta };
      return next;
    });
  }, []);

  const resetAsset = useCallback(() => {
    setAsset(cloneEmptyAsset());
    setStatus('idle');
    setError('');
    try {
      const map = loadAssetsMap();
      delete map[currentCompanyId];
      localStorage.setItem(ASSETS_MAP_KEY, JSON.stringify(map));
    } catch {
      /* 忽略 */
    }
  }, [currentCompanyId]);

  const goalValue = useMemo(
    () => ({ goal, goals: GOAL_GROUPS, selectGoal, clearGoal, route }),
    [goal, selectGoal, clearGoal, route],
  );

  const assetValue = useMemo(
    () => ({
      asset,
      hasAsset,
      status,
      error,
      buildAsset,
      refreshAsset,
      updateField,
      updateAsset,
      resetAsset,
    }),
    [asset, hasAsset, status, error, buildAsset, refreshAsset, updateField, updateAsset, resetAsset],
  );

  return (
    <GoalContext.Provider value={goalValue}>
      <AssetContext.Provider value={assetValue}>{children}</AssetContext.Provider>
    </GoalContext.Provider>
  );
}

export function useMarketingGoal() {
  const ctx = useContext(GoalContext);
  if (!ctx) throw new Error('useMarketingGoal 必须在 <MarketingProvider> 子树内使用');
  return ctx;
}

export function useMarketingAsset() {
  const ctx = useContext(AssetContext);
  if (!ctx) throw new Error('useMarketingAsset 必须在 <MarketingProvider> 子树内使用');
  return ctx;
}

export default MarketingProvider;
