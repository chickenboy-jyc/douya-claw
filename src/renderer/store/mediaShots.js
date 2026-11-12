import { useEffect, useState } from 'react';

/**
 * 「本次生成」缩略图带的**会话级** store —— 让刚生成的缩略图跨模块切换不丢。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么要单独一个 store，而不是组件 useState】
 *   `VideoDesign` 由 `App.jsx` **条件渲染**（`effectiveModule === 'videodesign' && <VideoDesign/>`），
 *   切到别的模块组件就卸载。`mergeShot()` 是在**后台任务的 taskFn 里**被调用的
 *   （`startJob` 的 taskFn 跨卸载存活，见 `store/backgroundJobs.js`），
 *   它跑完时组件可能早已卸载 —— 那时 `setSessionShots(...)` 打在已卸载实例上，
 *   等于扔进黑洞。用户会重新遇到 0.21.25 那次报障：
 *   「我让他生图 切到别的地方去回来就没有了 图也没了」。
 *
 *   所以这份数据必须挂在**模块级单例**上（和 backgroundJobs 同一套思路：
 *   模块级 Map + 监听者集合 + useXxx 订阅），组件的生命期不再是数据的所有者。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么**不**写 localStorage（这一条是刻意选的，不是漏了）】
 *   这条带的标题是「本次生成」——它说的是**这一次用软件的过程中新出的东西**。
 *   如果写进 localStorage，重启之后带子里还挂着三天前的图，那就是**另一种谎报**：
 *   用户会以为"刚才生的"，而实际是上次的遗留。
 *   而「上次生成的还能看到」这件事**不由这里负责** —— 那是作品库（`wanxAssets` +
 *   主进程 `.index.json` + 目录扫描）的职责，它本来就跨重启存在（见
 *   `src/main/wanxProvider.js` 的 `listAssets`：保留 missing 条目 + 目录双源合并）。
 *   两个容器分工明确：**本次生成 = 会话内；历史留存 = 作品库**。
 *   所以本文件的存活边界就是"应用运行期间"，正好对上老板那句
 *   「切到别的地方去回来就没有了」要知道的那一层。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么按 scopeKey 隔离】
 *   与 `backgroundJobs` 的 key、表单持久化的 key 一致：`videodesign-shots-<companyId>`。
 *   切企业不串图 —— A 企业的产物不该出现在 B 企业的「本次生成」里。
 * ════════════════════════════════════════════════════════════════════════════
 */

/** 一条带子最多挂多少张（只影响"本次生成"这条带子的显示，不影响作品库）。 */
export const SESSION_SHOT_MAX = 80;

/** scopeKey -> Array<shot>。模块级单例：组件卸载不影响它。 */
const store = new Map();

/** 订阅者（任一 scopeKey 变化都通知；订阅侧自己按 key 取，量级极小）。 */
const listeners = new Set();

/** 通知所有订阅者。单个监听器抛错不影响其他人。 */
function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 忽略单个监听器异常 */ }
  }
}

/**
 * 一条记录能不能进带子。
 *
 * 只认**有本机路径**的：带子的意义是"点开就能看到像素"，
 * 没有 localPath 的条目（远端地址 / 纯记录）放进来只会变成一张点不开的空框。
 *
 * @param {any} item 候选条目
 * @returns {boolean}
 */
function usable(item) {
  return !!(item && typeof item === 'object' && String(item.localPath || ''));
}

/**
 * 取某个 scope 下的带子（**返回内部数组本身**，调用方只读，别 push）。
 *
 * @param {string} scopeKey 作用域键（`videodesign-shots-<companyId>`）
 * @returns {Array<object>}
 */
export function listSessionShots(scopeKey) {
  return store.get(String(scopeKey || '')) || [];
}

/**
 * 把一条新生成的产物并进带子。
 *
 * 去重按 `localPath`：同一次生成可能被 `mergeShot` 与后台 `loadAssets()` 各碰一次，
 * 重复插会让带子里出现两张一模一样的缩略图（用户会以为生成了两张）。
 * 新条目**放最前面**（倒序，最近的先看到）。
 *
 * @param {string} scopeKey 作用域键
 * @param {object} item `{id?, kind, localPath, bytes?, prompt?, ts?, taskId?}`
 * @returns {boolean} 是否真的插入了（false = 没有 localPath / 已存在过）
 */
export function addSessionShot(scopeKey, item) {
  const key = String(scopeKey || '');
  if (!key || !usable(item)) return false;
  const localPath = String(item.localPath);
  const cur = store.get(key) || [];
  if (cur.some((x) => String(x.localPath) === localPath)) return false;
  const one = Object.assign({}, item, {
    // 与主进程 `appendAsset` 的 id 风格区分开：这条是**渲染层本地**的临时条目，
    // 只为 React key / 灯箱定位用，不参与任何计费、提交与持久化判断。
    id: String(item.id || ('shot-' + localPath)),
    localPath,
    kind: item.kind === 'video' ? 'video' : 'image',
    bytes: Number(item.bytes) || 0,
    prompt: String(item.prompt || ''),
    ts: item.ts || new Date().toISOString(),
    missing: false, // 刚落盘就并进来的，文件一定在；真要没了由作品库那边如实标 missing
  });
  store.set(key, [one].concat(cur).slice(0, SESSION_SHOT_MAX));
  emit();
  return true;
}

/**
 * 清空某个 scope 的带子（用户点「清空」/ 换企业时用）。
 *
 * @param {string} scopeKey 作用域键
 * @returns {void}
 */
export function clearSessionShots(scopeKey) {
  const key = String(scopeKey || '');
  if (!store.has(key)) return;
  store.delete(key);
  emit();
}

/**
 * 订阅某个 scope 的带子。
 *
 * 返回的数组在内容不变时保持**同一个引用**（用 `store.get` 的数组本身），
 * 所以下游 `useMemo` / 依赖比较不会每次都判成"变了"。
 *
 * @param {string} scopeKey 作用域键
 * @returns {Array<object>} 带子（最近的在前）
 */
export function useSessionShots(scopeKey) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return listSessionShots(scopeKey);
}

export default { SESSION_SHOT_MAX, listSessionShots, addSessionShot, clearSessionShots, useSessionShots };
