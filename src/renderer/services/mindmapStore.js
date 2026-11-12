/**
 * mindmapStore —— 思维导图的本地持久化（单文档自动保存，不做多文档列表）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么只做"单文档自动保存"】
 *   目标用户是门诊老板/前台，他们的心智是"这就是我的那张图"，不是"文件管理"。
 *   多文档列表要多一套命名、打开、删除、重名处理的界面，收益接近零。
 *   导出 Markdown 就是"另存为"的出口。
 *
 * 【为什么每个函数都 try/catch，且失败静默】
 *   localStorage 在隐私模式、配额满、企业策略下都会直接抛。
 *   这时候不该让整个模块白屏 —— 退化成"这次改了不保存"，用户下次打开看到旧版，
 *   但他至少还能用。仓库里 `store/mediaAccountStore.jsx` 是同一个理由。
 *
 * 【为什么读出来还要过 normalizeDoc】
 *   存进去的是上一个版本的形状，读出来可能是下下个版本在读旧数据；
 *   中间还可能被别的进程/手改搞脏。模型层的 normalizeDoc 是唯一的"脏数据闸门"，
 *   这里如果直接 `JSON.parse` 就返回，等于绕过它。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { normalizeDoc } from './mindmapModel.js';

export const MM_DOC_KEY = 'douya-mindmap-doc';
/** 视图偏好（zoom / panX / panY 等）。与文档分开存：换设备看同一张图，视图重新适配反而更好。 */
export const MM_UI_KEY = 'douya-mindmap-ui';

function ls() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 某些环境下连访问 localStorage 这个标识符都会抛
  }
}

/** 读文档。脏数据 / 没有 / 读不了 一律 null（调用方据此回落到"新建一张图"）。 */
export function loadDoc() {
  try {
    const store = ls();
    if (!store) return null;
    const raw = store.getItem(MM_DOC_KEY);
    if (!raw) return null;
    return normalizeDoc(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** @returns {boolean} 是否真的写进去了（失败不抛，只回报 false） */
export function saveDoc(doc) {
  try {
    const store = ls();
    if (!store || !doc) return false;
    // 写之前过一遍归一：保证落盘的形状永远是当前 schema，而不是界面手里的半成品
    const clean = normalizeDoc(doc);
    if (!clean) return false;
    store.setItem(MM_DOC_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** 读视图偏好。任何异常都返回空对象 —— 调用方拿它 spread 进默认值即可。 */
export function loadUi() {
  try {
    const store = ls();
    if (!store) return {};
    const raw = store.getItem(MM_UI_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 合并式保存（只覆盖传进来的字段，其余保留）。 */
export function saveUi(patch) {
  try {
    const store = ls();
    if (!store) return false;
    const next = { ...loadUi(), ...(patch && typeof patch === 'object' ? patch : {}) };
    store.setItem(MM_UI_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** 清空（导出/重置用）。失败不抛 —— 清不掉也不该让界面崩。 */
export function clearAll() {
  try {
    const store = ls();
    if (!store) return;
    store.removeItem(MM_DOC_KEY);
    store.removeItem(MM_UI_KEY);
  } catch {
    /* 隐私模式 / 配额：静默降级为"没清掉"，下次还能读到旧图，比崩了好 */
  }
}
