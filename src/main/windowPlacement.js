/**
 * 窗口位置判据（纯函数，2026-10-22）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么单独成文件
 * ═══════════════════════════════════════════════════════════════════════
 *   「窗口跑到屏幕外」是 Windows 上「应用打不开」最常见的原因之一，而它的判据是**纯几何**：
 *   给一组窗口矩形与一组工作区矩形，回答两句话 ——
 *     ① 用户现在看得见这个窗口吗？
 *     ② 看不见的话，应该把它放到哪里？
 *   把这两句话写进 main.js 的 showMainWindow 里，就**没法被单独测试**（那里 require 了 electron，
 *   在 node 里根本加载不起来），于是这类判据只能靠人工点几下"看起来没问题"——
 *   本仓反复踩过这个坑：判据一旦不可测，就等于没有判据。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 判据为什么用「交集比例」而不是「是否在范围内」
 * ═══════════════════════════════════════════════════════════════════════
 *   只用"窗口左上角在不在屏幕内"会放过一种很坏的情况：窗口左上角刚好在屏幕右下角里，
 *   整个窗口的 95% 在屏幕外 —— 探针判"在范围内"，用户只看到窄窄一条。
 *   只要求"完全在范围内"又会误伤：用户故意让窗口露出一点点是正常的拖动结果。
 *   所以取**可见面积比例**，阈值 0.5：露出不到一半就认为"抓不住、该拉回来"。
 *   为什么还要单独判"中心点"：窗口极大时（比工作区还大），交集比例天然很高，
 *   但中心点可能落在两块屏幕的缝隙里（多显示器布局），那种情况人也找不到它。
 *
 * ⚠️ 本文件不 require electron —— 坐标一律由调用方传入（DIP 单位，与 Electron 的
 *   getBounds / workArea 同单位），这样门禁可以直接喂数字。
 */

/** 可见面积比例低于这个值 ⇒ 认为用户抓不住窗口，该拉回。 */
const MIN_VISIBLE_RATIO = 0.5;
/** 居中时窗口最多占工作区的这个比例（比工作区还大的窗口要先缩，否则居中后四边仍然出界）。 */
const MAX_SIZE_RATIO = 0.92;

/** 两个矩形的交集面积（无交集返回 0）。 */
function overlapArea(a, b) {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  return ox * oy;
}

function area(r) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/**
 * 窗口现在看得见吗？
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口矩形
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas 各显示器工作区
 * @param {number} [minRatio]
 * @returns {boolean}
 */
function isRectVisible(bounds, workAreas, minRatio) {
  const b = bounds || {};
  const ws = Array.isArray(workAreas) ? workAreas : [];
  if (!(b.width > 0) || !(b.height > 0) || !ws.length) return false;
  const need = typeof minRatio === 'number' && minRatio > 0 ? minRatio : MIN_VISIBLE_RATIO;
  const total = area(b);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  for (const w of ws) {
    if (!w || !(w.width > 0) || !(w.height > 0)) continue;
    // ① 中心点落在某个工作区内 ⇒ 看得见（哪怕窗口很大，人也知道它在哪）
    if (cx >= w.x && cx <= w.x + w.width && cy >= w.y && cy <= w.y + w.height) return true;
    // ② 或者露出足够多（能抓到标题栏、能拖）
    if (overlapArea(b, w) / total >= need) return true;
  }
  return false;
}

/**
 * 算一个"居中且不出界"的目标矩形。
 * @param {{x:number,y:number,width:number,height:number}} bounds 当前窗口矩形（用它保留尺寸）
 * @param {{x:number,y:number,width:number,height:number}} workArea 目标工作区
 * @param {number} [maxRatio]
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function centerIntoWorkArea(bounds, workArea, maxRatio) {
  const b = bounds || {};
  // ★★ 2026-10-22 复审 P1-2：**"没有面积的屏"必须和"没有屏"同等对待**。
  //   原来只判 `!workArea`，而远程桌面断开/显示驱动重置期间，Windows 报给 Electron 的
  //   工作区是 `{x:0,y:0,width:0,height:0}` —— 它不是空值，所以照样往下走，于是：
  //     width  = max(200, min(1180, round(0*0.92))) = 200
  //     height = max(150, min(780,  round(0*0.92))) = 150
  //     x      = round(0 + (0-200)/2) = -100
  //   ⇒ 窗口被压成 200×150 并挪到负坐标。而这条路径会被 'show' / 'restore' /
  //     display-metrics-changed 触发（远程桌面重连必然触发），之后窗口**再也长不回来**。
  //   用户看到的是"重连一下，豆芽变成一个小方块了"。
  const FB = { x: 0, y: 0, width: 1280, height: 720 };
  const raw = workArea || {};
  const w = (raw.width > 0 && raw.height > 0)
    ? { x: Number(raw.x) || 0, y: Number(raw.y) || 0, width: raw.width, height: raw.height }
    : FB;
  const cap = typeof maxRatio === 'number' && maxRatio > 0 ? maxRatio : MAX_SIZE_RATIO;
  const width = Math.max(200, Math.min(b.width || w.width, Math.round(w.width * cap)));
  const height = Math.max(150, Math.min(b.height || w.height, Math.round(w.height * cap)));
  return {
    x: Math.round(w.x + (w.width - width) / 2),
    y: Math.round(w.y + (w.height - height) / 2),
    width,
    height,
  };
}

/**
 * 窗口**大得放不下**吗？（放不下 ⇒ 无论放哪都有一部分永远在屏外）
 *
 * 与 `isRectVisible` 是两个独立的问题，必须分开判：
 *   · 看得见 = 用户能找到它、能抓到它；
 *   · 放得下 = 它的**四边都落在屏幕里**。
 *   一个 1180×780 的窗口放在 1646×1029 的屏上，中心点、交集比例都达标（判"看得见"正确），
 *   但换到 1366×720 的笔记本工作区上，底部输入区就永远在屏外 —— 此时"看得见"却"用不了"。
 *   这正是 `centerIntoWorkArea` 的 92% 兜底要出手的时刻，而它此前**永远等不到**：
 *   调用点只判了 isRectVisible，中心点规则先一步短路了。
 *
 * ⚠️ 容器取「窗口**实际覆盖到**的那几块屏的并集包围盒」，不是"中心所在那块屏"。
 *   看着绕，但这是唯一能同时满足两件事的取法：
 *     ① 单屏笔记本上 1180×780 vs 1366×720 ⇒ 必须判"放不下"（否则修不掉原缺陷）；
 *     ② 用户在双屏上把一个窗口横跨两块屏拖着用 ⇒ 必须判"放得下"
 *        （它的右边落在第二块屏上、照样能点；拽回来反而把他的布局弄乱，
 *         这正是 ensureWindowOnScreen 里"刻意不把跨屏算成问题"那句注释的意思）。
 *   用"中心所在那块屏"做容器，条件② 必然失败：2600 宽 > 1646 宽 ⇒ 被误判、被拽走。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas
 * @returns {boolean}
 */
function exceedsWorkArea(bounds, workAreas) {
  const b = bounds || {};
  const ws = (Array.isArray(workAreas) ? workAreas : []).filter((w) => w && w.width > 0 && w.height > 0);
  if (!(b.width > 0) || !(b.height > 0)) return false;
  if (!ws.length) return true;   // 一块屏都不知道 ⇒ 当它装不下（交给调用方拉回）

  // 只有"真的和窗口有重叠"的屏才参与比较：窗口根本不在的屏，不该给它当容器。
  // 一个都没重叠（窗口整个在屏外）时退回全部 —— 反正 isRectVisible 那边已经判看不见了。
  const overlapped = ws.filter((w) => overlapArea(b, w) > 0);
  const pool = overlapped.length ? overlapped : ws;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const w of pool) {
    x1 = Math.min(x1, w.x);
    y1 = Math.min(y1, w.y);
    x2 = Math.max(x2, w.x + w.width);
    y2 = Math.max(y2, w.y + w.height);
  }
  return b.width > (x2 - x1) || b.height > (y2 - y1);
}

module.exports = {
  MIN_VISIBLE_RATIO,
  MAX_SIZE_RATIO,
  overlapArea,
  isRectVisible,
  exceedsWorkArea,
  centerIntoWorkArea,
};
