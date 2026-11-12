import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { syncAssetConclusionToKnowledge } from './companyKnowledgeStore.jsx';

/**
 * 统一资产对象（Asset）数据层 —— 阶段一「项目化 AI」底座。
 *
 * 资产可归属于 Workspace / Company / Project / Task 四层，通过 workspaceId / companyId /
 * projectId / taskId 表达归属，projectId / taskId 允许为空。type 覆盖文档 / 图片 / 视频 /
 * 音频 / 文案 / 文章 / PPT / 品牌素材 / 产品素材 / 医生素材 / 活动素材 / 其他。
 *
 * 与「企业营销画像」区分：营销画像（marketingStore.asset）是企业长期 Profile/Fact/Rule 的
 * 业务快照；本 Asset 表是文件 / 素材 / 内容产出的统一容器（未来 AI 生成结果、上传素材、
 * 项目资料都落这里）。第一阶段建数据底座 + 迁移容器，业务模块逐步接入。
 *
 * localStorage 持久化（数组 + 内存索引），key 用 douya- 前缀；读入时归一化补默认字段，
 * 兼容 snake_case 历史字段（workspace_id / file_url 等）。
 */

export const ASSETS_KEY = 'douya-assets';

/** 资产类型枚举。 */
export const ASSET_TYPES = {
  document: '文档',
  image: '图片',
  video: '视频',
  audio: '音频',
  copy: '文案',
  moments_copy: '朋友圈文案',
  community_copy: '社群文案',
  article: '文章',
  social_post: '社媒帖子',
  ppt: 'PPT',
  brand_material: '品牌素材',
  product_material: '产品素材',
  doctor_material: '医生素材',
  event_material: '活动素材',
  event_plan: '活动方案',
  media_plan: '媒体方案',
  crisis_report: '舆情报告',
  reference: '学习资料',
  material: '项目资料',
  other: '其他',
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function asStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

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

/** 归一化资产：兼容 snake_case 历史字段，补默认值。 */
export function normalizeAsset(a) {
  const base = a && typeof a === 'object' ? a : {};
  return {
    id: asStr(base.id),
    workspaceId: asStr(base.workspaceId || base.workspace_id),
    companyId: asStr(base.companyId || base.company_id),
    projectId: base.projectId == null && base.project_id == null ? null : asStr(base.projectId || base.project_id),
    taskId: base.taskId == null && base.task_id == null ? null : asStr(base.taskId || base.task_id),
    type: Object.prototype.hasOwnProperty.call(ASSET_TYPES, base.type) ? base.type : (base.type || 'other'),
    name: asStr(base.name) || '未命名资产',
    content: base.content == null ? null : base.content,
    filePath: asStr(base.filePath || base.file_url || base.fileUrl),
    mimeType: asStr(base.mimeType || base.mime_type),
    tags: asArray(base.tags),
    metadata: base.metadata && typeof base.metadata === 'object' ? base.metadata : {},
    createdBy: asStr(base.createdBy || base.created_by),
    createdAt: base.createdAt || base.created_at || Date.now(),
    updatedAt: base.updatedAt || base.updated_at || base.createdAt || Date.now(),
  };
}

function loadAssets() {
  const arr = loadJSON(ASSETS_KEY, []);
  return (Array.isArray(arr) ? arr : []).map(normalizeAsset);
}

const AssetContext = createContext(null);

export function AssetProvider({ children }) {
  const [assets, setAssets] = useState(loadAssets);

  // 持久化
  useEffect(() => {
    try {
      localStorage.setItem(ASSETS_KEY, JSON.stringify(assets));
    } catch {
      /* 忽略写失败 */
    }
  }, [assets]);

  // 派生索引（内存，避免每查询一次全量 filter 多次）
  const byCompany = useMemo(() => {
    const m = {};
    for (const a of assets) {
      if (a.companyId) (m[a.companyId] = m[a.companyId] || []).push(a);
    }
    return m;
  }, [assets]);
  const byProject = useMemo(() => {
    const m = {};
    for (const a of assets) {
      if (a.projectId) (m[a.projectId] = m[a.projectId] || []).push(a);
    }
    return m;
  }, [assets]);
  const byTask = useMemo(() => {
    const m = {};
    for (const a of assets) {
      if (a.taskId) (m[a.taskId] = m[a.taskId] || []).push(a);
    }
    return m;
  }, [assets]);
  const byWorkspace = useMemo(() => {
    const m = {};
    for (const a of assets) {
      if (a.workspaceId) (m[a.workspaceId] = m[a.workspaceId] || []).push(a);
    }
    return m;
  }, [assets]);

  const addAsset = useCallback((input) => {
    const a = normalizeAsset({ ...(input || {}), id: input && input.id ? input.id : uid(), createdAt: Date.now(), updatedAt: Date.now() });
    setAssets((prev) => [...prev, a]);
    // 结论类产物回流企业知识库记忆，让后续 AI 调用能读到「我们做过什么、得出过什么结论」。
    syncAssetConclusionToKnowledge(a.companyId, a);
    return a;
  }, []);

  const updateAsset = useCallback((id, patch) => {
    setAssets((prev) =>
      prev.map((a) => (a.id === id ? normalizeAsset({ ...a, ...(patch || {}), updatedAt: Date.now() }) : a)),
    );
  }, []);

  const removeAsset = useCallback((id) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /** 按归属查询：companyId 必填，projectId/taskId 可选过滤；返回按 updatedAt 倒序。 */
  const listAssets = useCallback(({ companyId, projectId, taskId, workspaceId } = {}) => {
    let list = assets;
    if (workspaceId) list = list.filter((a) => a.workspaceId === workspaceId);
    if (companyId) list = list.filter((a) => a.companyId === companyId);
    if (projectId != null) list = list.filter((a) => a.projectId === projectId);
    if (taskId != null) list = list.filter((a) => a.taskId === taskId);
    return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [assets]);

  const value = useMemo(
    () => ({
      assets,
      byCompany,
      byProject,
      byTask,
      byWorkspace,
      addAsset,
      updateAsset,
      removeAsset,
      listAssets,
    }),
    [assets, byCompany, byProject, byTask, byWorkspace, addAsset, updateAsset, removeAsset, listAssets],
  );

  return <AssetContext.Provider value={value}>{children}</AssetContext.Provider>;
}

export function useAssets() {
  const ctx = useContext(AssetContext);
  if (!ctx) throw new Error('useAssets 必须在 <AssetProvider> 子树内使用');
  return ctx;
}

export default AssetProvider;
