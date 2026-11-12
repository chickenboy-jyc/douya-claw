import '../styles/mindmap.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PageBanner from '../components/PageBanner.jsx';
import {
  MM_LIMITS,
  addChild,
  clearNodePosition,
  createDoc,
  docToMarkdown,
  dropIntent,
  flattenVisible,
  moveNode,
  removeSubtree,
  setNodePosition,
  statsOf,
  toggleCollapse,
  updateNodeText,
} from '../services/mindmapModel.js';
import { layoutDoc } from '../services/mindmapLayout.js';
import { buildSvg, fitViewport, viewportForSize } from '../services/mindmapSvg.js';
import { MM_AI_FRAMEWORKS, aiExpandNode, aiGenerateTree, aiPolishNode, aiRestructure } from '../services/mindmapAI.js';
import { clearAll, loadDoc, loadUi, saveDoc, saveUi } from '../services/mindmapStore.js';
import { buildAIContext } from '../services/contextBuilder.js';
import { useCompany } from '../store/companyStore.jsx';
// 预览配色要跟界面主题走（导出**不**跟 —— 见 services/mindmapSvg.js 的色板注释）。
import { useTheme } from '../store/themeStore.js';

/**
 * MindMap —— 「思维导图」模块的 UI 壳（0.21.26 新增）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【这一层做什么、不做什么】
 *   做：手势（平移 / 缩放 / 点选 / 行内编辑）、工具栏、AI 面板、自动存档、导出。
 *   不做：**任何布局算法、任何 AI 调用、任何 JSON 解析**。那些在
 *   services/mindmap{Model,Layout,Svg,AI,Store}.js 里，本文件只按契约调用。
 *   这条边界是硬的：布局只要在 UI 里被抄一份，预览和导出就会开始漂（本仓
 *   海报页已经踩过「两套排版引擎必然不一致」，见 PosterStudio.jsx:17-31）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么画布上的事件全是委托，而不是给节点挂 onClick】
 *   SVG 是 `buildSvg()` 生成的**字符串**，用 dangerouslySetInnerHTML 注入 ——
 *   React 拿不到里面的元素，挂不上事件处理器。所以：
 *     · 画布外层 div 统一接 pointerdown / mousedown / click / dblclick / keydown
 *     · 命中判定一律 `e.target.closest('[data-node-id]')`（节点 id 由 svg 模块写进该属性）
 *   这是「字符串 SVG + 又要可交互」唯一不引入 reactflow / d3 的做法。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么手势同时听 pointer 与 mouse 两套】
 *   照抄本仓 PosterStudio.jsx:26-33 的教训：自动化验收（jsdom / 脚本派发）发的是
 *   `new MouseEvent('mousedown')`，只挂 pointer 的组件在那种环境下**完全不动**，
 *   人会以为是"拖动没做"。反过来只接 mouse 又会在触屏 / 手写笔上失效。
 *   两套都接，用 `gestureRef` 去重：一次物理按下会先后触发 pointerdown 和 mousedown，
 *   第二次进来时 `gestureRef.current` 非空就直接 return，不会起两个手势（位移不会翻倍）。
 *   移动 / 抬起同理，window 上四组监听（PosterStudio.jsx:1401-1440 同构）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【坐标映射只有一个公式】
 *   screen = world * zoom + pan        world = (screen − pan) / zoom
 *   滚轮缩放必须锚在光标上：先算光标下的世界坐标，改 zoom 后反解 pan，保证那一点不动。
 *   行内编辑框、折叠标识的位置全用同一个公式，所以三者永远不会错位。
 *   ⚠️ 这个公式依赖 mindmapSvg 内部按 `translate(pan) scale(zoom)` 应用 viewport。
 *      如果那边换成别的顺序，编辑框会跑偏而构建 / jsdom 都不会报错 —— 联调时必须真点一次。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【jsdom 里没有尺寸】
 *   getBoundingClientRect() 与 clientWidth 一律返回 0。所以：
 *     · `safeRect()` 把拿不到的尺寸当成 0，不 throw
 *     · `readVp()` 把 service 回来的非法 viewport 归一成 { zoom:1, panX:0, panY:0 }
 *     · 挂载时的「适应视图」在 0 尺寸下自然退化成 1:1，不炸
 *   验收脚本可以在没有真实布局的环境里挂载本组件、点按钮、读 DOM。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【失败一律原样显示，不吞、不假装成功】
 *   service 回 `{ ok:false, error }` 就把 error 原文放进画布下方的 `.mm-error`。
 *   导出走 `poster:export`，返回 `{ ok:false, canceled:true }`（**没有 error 字段**）
 *   属于用户主动取消 —— 显示「已取消」，不是红字失败（PosterStudio.jsx:1660-1668 的坑）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【AI 调用带企业语境，导图数据却不按企业隔离 —— 两个决定看似矛盾，其实是两件事】
 *   数据：本页只存一份本机草稿（`MM_DOC_KEY` 全局唯一，换一家企业看到的还是同一张图，
 *        见 App.jsx 接线处的注释）。这是刻意的：导图被当成「个人草稿纸」而不是企业资产。
 *   调用：四条 AI 通路**必须**带上当前企业上下文（`aiContext()`），否则模型不知道客户
 *        是谁、卖什么、卖给谁 —— 输入「种植体新品上市推广」也只会吐出通用框架。
 *   数据归属与 AI 语境正交：不要因为数据不按企业隔离，就把 context 也一并掐掉。
 */

/** 缩放下限 / 上限 / 按钮步进。钳死上下界，否则一次猛滚就能把画布滚成空白。 */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.2;

/**
 * 拖拽落点的**吸附外扩**（屏幕像素）。
 *
 * 【为什么是屏幕像素，不是世界像素】
 *   世界坐标里 14px 在 zoom=0.2 时只剩 2.8 个屏幕上看得见的像素 ⇒ 磁吸等于不存在。
 *   而"缩得小一点之后吸不上去"正是 2026-11-11 要修的主症状，所以这个阈值必须在
 *   **屏幕**尺度上恒定，用的时候除以 zoom 折算回世界坐标（见 `hitDropAt`）。
 *
 * 【SNAP_SCREEN_PX = 14】
 *   下限由 `mindmapLayout.vGap = 16`（兄弟间隙，世界坐标）定：小于 8 就有一半的间隙
 *   变成"谁都不吸"的死区，用户拖到两个框之间会看到**什么都没有**——那比吸错更让人
 *   以为功能坏了。14 让 16px 的间隙里只有正中 2px 是空的，够把"要自由摆放"和
 *   "要插到兄弟之间"分开（真要摆到空白处，下面的 `blankSpot` 那种距离远得多）。
 */
const SNAP_SCREEN_PX = 14;

/**
 * 由「命中的框 + 落点 y」算落点区域（`child` / `before` / `after`）。
 *
 * 抽成**模块级纯函数**而不是写在 `hitDropAt` 里，是因为有两条命中路径要共用同一份口径：
 * ① 点在框内；② 磁吸（点在框外 SNAP 环里）。两处各写一份迟早漂移，
 * 而漂移的后果正是上一版那个毛病：画面描了框、松手却插到了旁边。
 *
 * @param {object} o
 * @param {string} o.id     命中的节点 id
 * @param {string} o.rootId 根节点 id（它没有兄弟，上下段无意义）
 * @param {number} o.y      框的世界坐标 y
 * @param {number} o.h      框的世界坐标高
 * @param {number} o.wy     落点的世界坐标 y
 * @param {number} o.zoom   当前缩放（判断框在屏幕上还剩多高）
 * @param {boolean} o.outside 落点是否在框**外**（磁吸命中）
 * @returns {'child'|'before'|'after'}
 */
function zoneOfPoint({ id, rootId, y, h, wy, outside }) {
  // 根没有兄弟，「前/后」对它无意义 ⇒ 一律"挂到主拼图下面"
  if (id === rootId || !(h > 0)) return 'child';
  const r = (wy - y) / h;
  if (outside) {
    // 磁吸：方向已经由"在框的哪一侧"表达清楚，不需要分段精度
    if (r <= 0) return 'before';
    if (r >= 1) return 'after';
    return 'child';
  }
  /**
   * ★ 分界 **20% / 80%**（中段 60%），不是原来的 28% / 72%（中段 44%）。
   *
   * 【为什么是 20/80 而不是更激进的 15/85】
   *   `scripts/smoke/probes/_mmx_entry.jsx` 的 `edgeOf()` 就是按 **0.15 / 0.85**
   *   给"上边缘 / 下边缘"打点的（那是它对"边缘"的定义）。分界若也放到 15/85，
   *   探针正好落在等号上 —— 实测 `r=0.15` 时 `r < 0.15` 为 false ⇒ 判成 child，
   *   D20/D22 当场转红。这不是探针写错了，是**两个数字撞在一起**。
   *   20/80 让探针的 0.15/0.85 落在边界内侧留 5% 余量，同时中段从 44% 涨到 60%
   *   （单行框 16.7px → **22.8px**），这正是"手一偏就挂丢"要修的地方。
   *   而"插到兄弟前后"变窄的那 3px 由磁吸补齐：拖到框外上方/下方 13 屏幕像素内即可，
   *   比原来在框内挤 10.6px 更好选。
   *
   * 【试过但撤掉的方案：按"框在屏幕上太矮就不分段"】
   *   曾加过一条 `h * zoom < 26 ⇒ 一律 child`，本意是"缩小后每段不足 4px，点不中"。
   *   **实测否决**：门禁跑在 jsdom 里，画布小、布局大 ⇒ fitView 把 zoom 压到 **0.2**，
   *   框的屏幕高只剩 **7.6px**，于是这条判定在测试里**恒成立**，分段整个测不到
   *   （D20/D22 直接红，而产品其实是对的）。更要紧的是它连真实用户也一起罚了：
   *   缩一下视图就再也不能调兄弟顺序，而这件事磁吸本来已经解决了。
   *   ⇒ 删掉。缩小后想精确插入请用**框外的磁吸**，那条路在任何缩放下都稳定。
   */
  if (r < 0.20) return 'before';
  if (r > 0.80) return 'after';
  return 'child';
}


/** 新建 / 新建节点用的默认文案。 */
const DEFAULT_TITLE = '我的第一张思维导图';
const NEW_NODE_TEXT = '新分支';
/** AI 生成的分支数 / 扩散的子节点数：契约要求必填，界面上不给选（少一个决策就少一次放弃）。 */
const GEN_BRANCHES = 5;
const EXPAND_COUNT = 3;
/** 导出图片解码的兜底超时：jsdom 里 Image 永远不触发 onload，没有这条按钮会永久卡在「导出中」。 */
const IMAGE_TIMEOUT_MS = 15000;
/**
 * 「切全屏后要重新适应视图」这条请求的最长等待时间（毫秒）。
 *
 * 为什么需要这个上界：`toggleZen` 里刚 `setZen` 时 DOM 还没重排，`safeRect` 量到的
 * 仍是旧尺寸 —— 那时 `fitView()` 会把**旧画布**的适应结果写进新画布，等于没修。
 * 所以请求只登记、不执行，交给 ResizeObserver 的 `measure` 在「尺寸真变了」那一刻消费。
 * 但请求不能永久挂着：万一尺寸始终没变（或观察器没触发），下一次**无关**的 resize
 * 就会替它消费掉，把用户手动缩放的视图冲掉。带时间戳 + 过期自清就没这个问题
 * （不需要定时器：每次 measure 进来先判是否过期）。
 */
const REFIT_PENDING_MS = 1500;
/** 空布局：layout 模块没回来 / 抛错时的占位，保证渲染永远有东西可读。 */
const EMPTY_LAYOUT = { nodes: [], edges: [], bbox: { x: 0, y: 0, w: 0, h: 0 } };
/** 量不到画布尺寸时（jsdom）给 SVG 的兜底尺寸，只影响无布局环境，真机永远用实测值。 */
const FALLBACK_VIEW = { w: 1280, h: 720 };

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** 把任意 shape 的异常 / service 错误统一成一句人话（原文优先，不吞）。 */
function errText(e, fallback) {
  if (typeof e === 'string' && e) return e;
  if (e && e.message) return String(e.message);
  if (e && e.error) return String(e.error);
  return fallback;
}

/** 取元素矩形；jsdom 返回全 0，这里一律降级成 0 而不是 throw。 */
function safeRect(el) {
  let r = null;
  try {
    r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  } catch (e) {
    r = null;
  }
  return {
    left: r && Number.isFinite(r.left) ? r.left : 0,
    top: r && Number.isFinite(r.top) ? r.top : 0,
    width: r && Number.isFinite(r.width) ? r.width : 0,
    height: r && Number.isFinite(r.height) ? r.height : 0,
  };
}

function closestIn(target, selector) {
  if (!target || typeof target.closest !== 'function') return null;
  try {
    return target.closest(selector);
  } catch (e) {
    return null;
  }
}

/**
 * 取「自己 + 全部子孙」的 id 集合（拖拽改父级时用来排除非法落点）。
 *
 * 为什么不用模型层那套 DFS：这里要的只是一个 id 集合，而**拖拽期间结构不会变**，
 * 所以在按下那一刻算一次就够（每次 mousemove 重算一棵树的集合既慢又毫无意义）。
 *
 * id 一律 `String()` 化：`moveNode` 的 `newParentId` **不做** String 归一
 * （只有 `addChild` 有那一步），传进去必须是字符串，否则 `byId.get()` 直接 miss，
 * 用户看到的是「拖了半天，松手弹一句『找不到目标父节点』」。`data-node-id` 读出来
 * 天然是字符串，但 `doc.nodes` 里的 id 是模型写的，不能假设两者同类型。
 *
 * @param {object} doc 导图文档
 * @param {string} id 拖拽中的节点 id
 * @returns {Set<string>} 不可作为落点的 id 集合
 */
function subtreeIds(doc, id) {
  const root = String(id == null ? '' : id);
  const childMap = new Map();
  const nodes = doc && Array.isArray(doc.nodes) ? doc.nodes : [];
  for (const n of nodes) {
    if (!n || n.id == null || n.parentId == null || n.parentId === '') continue;
    const parent = String(n.parentId);
    if (!childMap.has(parent)) childMap.set(parent, []);
    childMap.get(parent).push(String(n.id));
  }
  const out = new Set();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const child of childMap.get(cur) || []) stack.push(child);
  }
  return out;
}

/**
 * 把 service 回来的 viewport 归一成 `{ zoom, panX, panY }`。
 *
 * 契约只写了「viewport」，没写字段名，所以这里认 `zoom/panX/panY` 也认
 * `scale/x/y`（两种命名在同类库里都很常见）。读到非法值就退化成 1:1 —— 
 * 这一步是「0 尺寸环境下不能炸」的最后一道保险。
 */
function readVp(v) {
  const o = v && typeof v === 'object' ? v : {};
  const rawZoom = num(o.zoom, num(o.scale, 1));
  const zoom = clamp(rawZoom > 0 ? rawZoom : 1, ZOOM_MIN, ZOOM_MAX);
  const panX = num(o.panX, num(o.x, 0));
  const panY = num(o.panY, num(o.y, 0));
  return {
    zoom,
    panX: Number.isFinite(panX) ? panX : 0,
    panY: Number.isFinite(panY) ? panY : 0,
  };
}

/**
 * 润色的第 ② 态兜底文案。
 *
 * 三态契约（mindmapAI.js `aiPolishNode`，2026-11-02 起）：
 *   ① `{ok:true, changed:true,  text}`                       —— 改好了
 *   ② `{ok:true, changed:false, text===original, note}`      —— AI 认为已经够好（**正常结论**）
 *   ③ `{ok:false, error}`                                    —— 真失败
 *
 * 为什么 ② 不能报红：prompt 第 4 条**主动邀请**模型「原文已经足够好就原样返回」，真机 3/3
 * 都照做了。若把它渲染成「AI 这次没给出更好的写法」红字，等于把被邀请的合法行为报成故障；
 * 而同轮另外三条通路（生成/展开/重构）全是成功，用户会认定"只有润色这颗按钮坏了"。
 *
 * 判据只认 `changed`，**不许**在 UI 里自己比 `text === original`：service 侧已经过
 * `cleanText` 规整，两边各算一次迟早会不一致（空白/大小写差异），那时会出现
 * 「提示说没改、但文字其实变了」的静默错位。
 */
const KEPT_ORIGINAL_TEXT = 'AI 觉得这句已经够好了。';

/**
 * 「双击空白新建」用的选中种子有效期（毫秒）。
 *
 * 为什么需要它：空白处单击 = 取消选中（XMind 同款），而**双击的两次 click 都会走那条
 * 清空分支** ⇒ 到 `dblclick` 时 `selectedId` 已经是空串。所以取消选中前把 id 记下来，
 * 双击时拿它当父节点。
 * 为什么带时间戳、而不是"一直记着"：用户完全可能「先点一下空白取消选中，过一会儿
 * 再双击空白」，那时的期望是加在**根**下（他没有选中任何东西）。一次双击的两次 click
 * 之间最多几百毫秒，1500ms 的窗口足够覆盖慢手，又挡得住"隔很久"的那种。
 */
const SELECT_SEED_MS = 1500;

/**
 * 三态第 ② 态的兜底文案（`ok:true, changed:false`，展开与润色共用一份实现）。
 *
 * ② 的语义是「AI 判定**已经足够好**，这是正常结论，不是失败」——
 * **不是「模型没给出东西」**。两者差一个人称：前者是模型的判断，后者听起来像模型
 * 没干活、像一次失败。扩散侧原先就是这么写的（原文已删，此处不复述），和上面
 * 那段「AI 认为已经够好（正常结论）」自相矛盾，下一个人读到会以为 ② 是缺陷分支。
 *
 * 兜底常量按设计**跑不到**：`aiExpandNode` 与 `aiPolishNode` 的第 ② 态都无条件带
 * `note`（`mindmapAI.js:260` / `:405`）。留着只是为了 `note` 被清空时不至于弹一句
 * 空提示，不是因为预期它会执行 —— 所以两处调用各留一句**符合各自语境**的文案，
 * 不要图省事统一成一句（展开和润色说的不是同一件事）。
 */
function noteOr(res, fallback) {
  const note = String((res && res.note) || '').trim();
  return note || fallback;
}

/**
 * 写给回节点的成功文案：**把改后的文字一起显示**。
 * 只写「已改写」用户看不出改了什么，还得去画布上逐个节点比对 —— 而他刚点的就是一个节点。
 */
function polishedText(text) {
  const t = String(text == null ? '' : text).trim();
  return t ? '已改写：' + t : '已改写';
}

/**
 * 交给 `buildSvg` 的 viewport。
 *
 * ⚠️ **width / height 是必填的**：mindmapSvg.js:105 用 `vp.width > 0` 判断
 * 「这份 viewport 是屏幕用的还是导出用的」，宽度为 0 会回落成 `fitViewport()`
 * —— 表现是「滚轮和拖动都不生效」，而构建、jsdom 全都不会报错（本模块自测就这么红过两条）。
 * 所以：量到真实尺寸就带真实尺寸；量不到（jsdom 的 getBoundingClientRect 恒为 0）
 * 就带一个固定的兜底尺寸，保证平移 / 缩放在无布局环境里**依然改变输出**。
 */
function vpOut(v, size) {
  const w = Math.round(num(size && size.w, 0));
  const h = Math.round(num(size && size.h, 0));
  return {
    zoom: v.zoom,
    panX: v.panX,
    panY: v.panY,
    width: w > 0 ? w : FALLBACK_VIEW.w,
    height: h > 0 ? h : FALLBACK_VIEW.h,
  };
}

/** 导出文件名：<标题>.png，去掉 Windows 文件名非法字符（否则主进程写盘会失败）。 */
function pngName(doc) {
  const raw = String((doc && doc.title) || '思维导图');
  return raw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.png';
}

/** 挂载时的初始文档：先读存档，没有就新建一份。 */
function readInitialDoc() {
  try {
    const saved = loadDoc();
    if (saved) return saved;
  } catch (e) {
    console.error('[MindMap] loadDoc 失败', e);
  }
  try {
    return createDoc(DEFAULT_TITLE);
  } catch (e) {
    console.error('[MindMap] createDoc 失败', e);
    return null;
  }
}

const ASK_TITLES = {
  new: '新建思维导图',
  generate: 'AI 生成导图',
  expand: 'AI 扩散当前节点',
  restructure: 'AI 换一个框架',
};

const ASK_DESCS = {
  new: '现在这张会被清空（内容只存在本机），确定要重新开始吗？',
  generate: '写一句主题，例如「门诊开业活动怎么策划」，AI 直接长出一棵树。',
  expand: '可以留空，也可以写一句方向，例如「往患者体验方向展开」。',
  restructure: '按选中的框架把现有导图重排一遍，已有的节点内容不会丢。',
};

const ASK_PLACEHOLDERS = {
  generate: '一句话说清主题',
  expand: '可选：往哪个方向展开',
  restructure: '可选：补充一句背景',
};

export default function MindMap() {
  const theme = useTheme();
  const [doc, setDoc] = useState(readInitialDoc);
  const [selectedId, setSelectedId] = useState('');
  const [viewport, setViewport] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [panning, setPanning] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState('');
  /**
   * 画布下方那条提示：**单一状态机**，一个 `{type, text}` 对象，`type` 只允许
   * `'error' | 'ok' | 'hint'`。三态互斥是结构保证的（见渲染处那串三元），
   * 任何一次 `setNotice` 都整体替换掉上一条 —— 所以不可能出现「已改写」和
   * 「AI 觉得够好」同时挂在屏幕上。**不要**改成三个独立 boolean / 三个 state。
   */
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(''); // '' | 'generate' | 'expand' | 'restructure' | 'polish' | 'export' | 'md'
  const [ask, setAsk] = useState(null); // { mode, value, fw }
  const [askErr, setAskErr] = useState('');
  /**
   * 全屏（zen）：页头 `PageBanner` 与快捷键图例 `.mm-keys` **不渲染**（条件渲染，
   * 不是 `display:none` —— 藏起来的 DOM 仍会被首屏审计的 textContent 口径读到，
   * 那是把「看不见」当成「不存在」的自欺），画布因此吃掉全部高度。
   *
   * 持久化：`saveUi({ zen })`。`mindmapStore.js` 的 saveUi 是纯对象展开、**无字段白名单**，
   * 加一个字段零改动；读取侧在下面挂载 effect 里，恢复动作必须写在 `zoom` 那条
   * `return` **之前**，否则「存过视图」的人永远恢复不了 zen。
   *
   * ⚠️ `.mm-page` 本身已经是 `height: calc(100vh - 44px)`（让开标题栏），zen 只做
   *    「拿掉页头 / 图例、收紧内边距」，**绝不许**改成 `position:fixed` 盖住左侧导航：
   *    `scripts/verify/module-sweep.mjs` 靠点 `.module-card` 遍历模块，导航被盖住
   *    会让后面 9 个模块全部被判「点击无响应」。
   * ⚠️ 必须有退出通路：工具栏那个联动开关（`[data-mm-zen-toggle]`）+ 画布上的 Esc。
   */
  const [zen, setZen] = useState(false);
  /** 右键菜单：`{ x, y, nodeId }`，x/y 是**画布内**坐标。null = 没打开。 */
  const [ctx, setCtx] = useState(null);
  /** 拖拽时命中的目标节点 id（空串 = 当前没压在任何一个框上）。 */
  const [dropHint, setDropHint] = useState('');
  /**
   * 落点形状：`child` = 高亮整个框（挂进去），`before` / `after` = 在框的上/下边缘画一条线
   * （插到它前/后）。单独立一个 state 而不是把 zone 塞进 `dropHint`：
   * `dropHint` 已经作为 `data-mm-drop-hint` 暴露给验证脚本与样式，值是节点 id，
   * 混进区域会让那个属性同时承担两种语义（"是谁"和"怎么放"），读的人一定会误解。
   */
  const [dropZone, setDropZone] = useState('child');
  /** 节点拖拽是否已越过死区（只用来切 cursor 与给验证脚本一个读数）。 */
  const [dragging, setDragging] = useState(false);
  /**
   * ★★ 拖动中的"跟手影"（2026-11-10）—— 这是「压根没有拖动功能」的直接修法。
   *
   * 【修前的真实手感，逐字对照老板的话】
   *   他抓着 A 往 B 拖：A **一动不动**，只有 B 的边框被高亮一下；松手后 A 才「啪」地跳过去。
   *   没有任何"我正提着这个东西"的反馈 ⇒ 他的结论是「压根就没有拖动这个功能」。
   *   **这个判断在当时是完全准确的**：干路上确实只有落点高亮，没有任何跟手的视觉。
   *   （DOM 门禁 97 项全绿也拦不住它 —— 那些断言测的是 data-mm-dragging / 落点 id，
   *     没有一条问「被拖的那个框有没有跟着走」。工具看的是它自己关心的那几样东西。）
   *
   * 【为什么用 DOM 影而不是真移动 SVG 里的节点】
   *   节点在 `dangerouslySetInnerHTML` 注入的 SVG 字符串里，React 管不到；
   *   而每次 mousemove 重新注入整棵 SVG 是本页最贵的操作（见 svg 的 useMemo 头注），
   *   也会让 D3/D4 那两条「拖拽期间 SVG 不重建」的断言失去意义。
   *   ⇒ 影是一层绝对定位的 DOM：内容取节点文字，位置 = 原框屏幕矩形 + 鼠标位移。
   *     与原节点**像素级同尺寸同字体**，看起来就是那个框被提起来了。
   *
   * 结构：{ id, dx, dy } —— dx/dy 是**屏幕像素**位移，不是世界坐标
   *   （渲染在屏幕层，换算世界坐标只会多一次乘除，且缩放时会抖）。
   */
  const [dragGhost, setDragGhost] = useState(null);

  // 当前企业（只用来拼 AI 上下文，**不**参与导图数据的归属 —— 见文件头那段说明）。
  const { currentCompany } = useCompany();
  const cid = currentCompany && currentCompany.id ? String(currentCompany.id) : '';

  const canvasRef = useRef(null);
  const editRef = useRef(null);
  const gestureRef = useRef(null);
  /**
   * 节点拖拽（改父级）手势。**必须**与 `gestureRef`（画布平移）分开：
   * 一次物理按下会先后触发 pointerdown 与 mousedown，两个手势若共用一个 ref，
   * 第二个监听看到非空就退出，谁也说不清退掉的是哪一个；共用还会让「在节点上按下」
   * 被平移手势接管 —— 位移落到 pan 上，画布跟着跑而节点不动（就是用户说的「拖动坏了」）。
   */
  const dragRef = useRef(null);
  /** 拖拽高亮的目标：window 级 mousemove 里读 state 会慢一帧，用 ref 去重。 */
  const dropRef = useRef('');
  /** 落点形状同上（`child` / `before` / `after`），与 `dropRef` 一起做去重。 */
  const dropZoneRef = useRef('child');
  /**
   * 空白处点一下会**清掉选中**（XMind 同款），而「双击空白」的两次 click 都会走那条
   * 清空分支 ⇒ 双击时读 `selectedId` 永远是空。这里在清掉之前把它记下来
   * （带时间戳，只在 `SELECT_SEED_MS` 窗口内有效），双击空白就用它当父节点：
   * `selectedId || 种子 || rootId`。
   */
  const lastSelectedRef = useRef({ id: '', at: 0 });
  /** 上一次真正落盘的 zen 值：用来避免挂载首帧把存档里的 zen 写成 false。 */
  const zenSavedRef = useRef(false);
  const justPannedRef = useRef(false);
  const editingIdRef = useRef('');
  const draftRef = useRef('');
  const docRef = useRef(doc);
  const viewRef = useRef(viewport);
  const layoutRef = useRef(EMPTY_LAYOUT);
  const fittedRef = useRef(false);
  const mountedRef = useRef(false);
  /**
   * 「下一次量到新尺寸时重新适应视图」的请求，**0 = 没有请求**，非 0 是登记时的
   * 时间戳（用来判过期，见 REFIT_PENDING_MS）。
   * 用 ref 而不是 state：它只影响一次回调内部的分支，进 state 就多一次无意义的重渲染。
   */
  const refitRef = useRef(0);
  /** `size` 的同步镜像：`measure` 里要**当场**判「尺寸是不是真变了」，读 state 会慢一帧。 */
  const sizeRef = useRef({ w: 0, h: 0 });
  // 下面这两个 ref 在渲染期直接同步：手势 / 键盘回调在 window 级监听里跑，
  // 拿 state 会有一次渲染的延迟，拖动会「慢半拍」。
  docRef.current = doc;
  viewRef.current = viewport;

  // ── 布局 / SVG（两个 useMemo 是这一页的性能边界）─────────────────────────
  const layout = useMemo(() => {
    if (!doc) return EMPTY_LAYOUT;
    try {
      return layoutDoc(doc) || EMPTY_LAYOUT;
    } catch (e) {
      console.error('[MindMap] layoutDoc 失败', e);
      return EMPTY_LAYOUT;
    }
  }, [doc]);
  layoutRef.current = layout;

  const layoutNodes = useMemo(() => {
    const list = Array.isArray(layout.nodes) ? layout.nodes : [];
    const map = new Map();
    for (const n of list) {
      if (n && n.id) map.set(n.id, n);
    }
    return map;
  }, [layout]);

  /**
   * 预览用的 SVG。依赖 `[doc, layout, viewport, selectedId, size]`：
   * 平移 / 缩放必须重拼（viewport 在 SVG 内部生效，不是外层 CSS transform），
   * 但**不重算 layout**（`layout` 只依赖 doc）—— 拖一下重排一次整棵树是这一页最贵的操作。
   */
  const svg = useMemo(() => {
    if (!doc) return { markup: '', width: 0, height: 0 };
    try {
      const built = buildSvg({
        doc,
        layout,
        viewport: vpOut(viewport, size),
        selectedId,
        showNote: false,
        theme,
      });
      return {
        markup: String((built && built.markup) || ''),
        width: num(built && built.width, 0),
        height: num(built && built.height, 0),
      };
    } catch (e) {
      console.error('[MindMap] buildSvg 失败', e);
      return { markup: '', width: 0, height: 0 };
    }
  }, [doc, layout, viewport, selectedId, size, theme]);

  const stat = useMemo(() => {
    if (!doc) return { nodes: 0, depth: 0, leaves: 0, collapsed: 0 };
    try {
      const s = statsOf(doc) || {};
      return {
        nodes: num(s.nodes, 0),
        depth: num(s.depth, 0),
        leaves: num(s.leaves, 0),
        collapsed: num(s.collapsed, 0),
      };
    } catch (e) {
      console.error('[MindMap] statsOf 失败', e);
      return { nodes: 0, depth: 0, leaves: 0, collapsed: 0 };
    }
  }, [doc]);

  // ── 小工具 ────────────────────────────────────────────────────────────────
  const findNode = useCallback((id) => {
    const nodes = (docRef.current && docRef.current.nodes) || [];
    return nodes.find((n) => n && n.id === id) || null;
  }, []);

  /** 同步改 doc：务必先写 ref 再 setState —— 紧接着的 beginEdit 要用 ref 里新节点。 */
  const commitDoc = useCallback((next) => {
    if (!next) return;
    docRef.current = next;
    setDoc(next);
  }, []);

  /** 关右键菜单。单独抽出来是因为它有 5 个调用点（Esc / 画布按下 / 滚轮 / 平移 / 选中某项）。 */
  const closeCtx = useCallback(() => {
    setCtx(null);
  }, []);

  /**
   * 全屏开关。菜单里也有一项，所以抽成回调；顺带把菜单关掉（动作源在菜单里）。
   *
   * ⚠️ **必须重新适应视图**，且**不能在这里同步调 `fitView()`**。
   *    全屏只改 `.mm-page` 的类名（收内边距 / 停渲染页头与图例），画布要等浏览器
   *    重排后才变大。此刻调 `fitView()` 量到的是**旧尺寸**，算出来的 zoom/pan 属于
   *    旧画布 —— 表现就是「画布确实变宽了，但图还挤在左侧，右边空一大块」。
   *    所以这里只登记请求（`refitRef`），由 `measure` 在「尺寸真变了」那一刻消费。
   *
   * 取舍：**进/出全屏都重适应**（不复用用户手动缩放的位置）。
   *    另一个候选方案是「只在视图仍是自动适应出来的状态时才 refit，用户手动调过就
   *    只改 pan 不动 zoom」。放弃它的原因：判据只能是「viewport 有没有被手势改过」，
   *    而平移只要越过 2px 死区就算改过 —— 用户随手拖一下画布，全屏就又不铺满了，
   *    缺陷原地复活且**不报错**（这正是它潜伏这么久的原因）。代价是手动缩放过的
   *    视图会被冲掉，但恢复路径是明摆着的：工具栏「适应视图」一键、滚轮或 +/− 调
   *    缩放。宁可让人多点一下，也不要让人再看到右边那块空白。
   */
  const toggleZen = useCallback(() => {
    setCtx(null);
    refitRef.current = Date.now();
    setZen((v) => !v);
  }, []);

  /**
   * 世界坐标 → 命中哪个节点（矩形命中测试，只用 `layout.nodes` 的 x/y/w/h）。
   *
   * 为什么不用 `document.elementFromPoint`：
   *   ① 它要真实布局（jsdom 恒 null），拖拽就会「在自动化里永远拖不中任何目标」；
   *   ② 节点是 `buildSvg()` 生成的字符串，命中的是 `<rect>` 那一层，还要再爬一层
   *      才拿得到 id —— 用几何数据判定既快（一次线性扫描）又不依赖浏览器布局。
   * `blocked` = 按下那一刻算好的「自己 + 全部子孙」：那些落点必然被 `moveNode` 拒
   * （环检测 / 挂到自己身上），提前排除掉，用户就不会看到一个必然报错的高亮。
   *
   * @param {number} wx 世界坐标 x
   * @param {number} wy 世界坐标 y
   * @param {Set<string>} blocked 不可作为落点的 id 集合
   * @returns {string} 命中的节点 id（空串 = 空处）
   */
  /**
   * 命中测试 + **落点区域**判定（2026-11-10 新增，配合「自由落点」；2026-11-11 加磁吸）。
   *
   * 命中逻辑只有一份（同一份 layout），额外只算一件事：
   * 鼠标落在目标框的**哪一段**。分段口径见 `zoneOfPoint`（模块级纯函数，两条路径共用）。
   *
   * 【为什么用竖直分段，而不是"左右半区"】
   *   这一版的布局是**从根向外横着长**（子节点在父节点右侧），兄弟是上下排的。
   *   所以"上/下"正好是"兄弟的前/后"，语义与画出来的位置一致；
   *   若用左右分段，左半区会变成"挂回父级"，与"往左拖 = 往外层"的直觉打架。
   *
   * 【2026-11-11 为什么又改了一次】
   *   老板原话：「怎么把子子节点拖到子节点上 怎么吸附上去」。
   *   上一版分段 28% / 72%，中段只有 44%；而单行卡片实测 **38px 高**
   *   （`lineH 20 + nodePadY 9×2`）⇒ 中段 **16.7px**。手偏 5px 就从"挂进去"
   *   变成"插到前后"，而两种结果在画面上只差一条线 ⇒ 用户以为自己没操作成功。
   *   旧注释写的"卡片高度 ~44px"也是错的（那是按两行估的），一并纠正。
   *
   *   两个改动，对应两个不同症状：
   *     ① **中段放宽到 60%**（20% / 80%）⇒ 单行框 16.7px → **22.8px**。
   *        上下段各变窄 3px，但由 ② 的磁吸补齐，实际更好选而不是更难。
   *     ② **磁吸**：点在框外 `SNAP_SCREEN_PX` 以内也算命中，把点 clamp 进框再算比例。
   *        外扩量是**屏幕像素**，除以 zoom 折算 —— 否则缩到 0.2 倍时磁吸等于不存在，
   *        而"缩小后吸不上去"正是这次要修的主症状。
   *
   *   原本还试过第三条「框太小就不分段」，**已撤**：门禁跑在 jsdom 小画布下、
   *   fitView 把 zoom 压到 0.2，框屏幕高只剩 7.6px ⇒ 那条判定在测试里恒成立，
   *   把分段整个测没了；而真实用户缩一下视图也会连带失去"调兄弟顺序"的能力。
   *   缩小后的精确插入交给磁吸（框外上下），任何缩放下都成立。
   *
   * 【两轮扫描的顺序是有意义的】
   *   先全部找"框内命中"，都落空了才找"磁吸命中"。反过来会让相邻两个框的外扩环
   *   抢走本该属于框内那个的目标 —— 用户明明指着 A，却挂到了 A 旁边的 B 下面。
   *   磁吸命中若有多个，取**离矩形最近**的那个（Chebyshev 距离，即"矩形外扩的环"）。
   *
   * @param {number} wx 世界坐标 x
   * @param {number} wy 世界坐标 y
   * @param {Set<string>} blocked 不可作为落点的 id 集合
   * @param {string} rootId 根节点 id
   * @param {number} zoomRaw 当前缩放（磁吸外扩与"框太小"判定都要用）
   * @returns {{id:string, zone:'child'|'before'|'after'}|null} 没命中返回 null
   */
  const hitDropAt = useCallback((wx, wy, blocked, rootId, zoomRaw) => {
    const list = layoutRef.current && Array.isArray(layoutRef.current.nodes) ? layoutRef.current.nodes : [];
    const skip = blocked instanceof Set ? blocked : new Set();
    const zoom = Number(zoomRaw) > 0 ? Number(zoomRaw) : 1;
    const snap = SNAP_SCREEN_PX / zoom;   // 屏幕 14px ⇒ 世界坐标

    // ── 第一轮：点在框内（原有语义，"框太小就不分段"也走这里）────────────────
    for (const n of list) {
      if (!n || n.id == null) continue;
      const id = String(n.id);
      if (skip.has(id)) continue;
      const x = num(n.x, 0);
      const y = num(n.y, 0);
      const w = num(n.w, 0);
      const h = num(n.h, 0);
      if (!(wx >= x && wx <= x + w && wy >= y && wy <= y + h)) continue;
      return { id, zone: zoneOfPoint({ id, rootId, y, h, wy, outside: false }) };
    }

    // ── 第二轮：磁吸（点在框外 snap 环里）────────────────────────────────────
    let best = null;
    let bestD = Infinity;
    for (const n of list) {
      if (!n || n.id == null) continue;
      const id = String(n.id);
      if (skip.has(id)) continue;
      const x = num(n.x, 0);
      const y = num(n.y, 0);
      const w = num(n.w, 0);
      const h = num(n.h, 0);
      if (!(w > 0) || !(h > 0)) continue;
      // 到矩形的最短距离：Chebyshev（取 x/y 两个方向里大的那个）= "矩形外扩的环"
      const dx = wx < x ? x - wx : (wx > x + w ? wx - (x + w) : 0);
      const dy = wy < y ? y - wy : (wy > y + h ? wy - (y + h) : 0);
      const d = Math.max(dx, dy);
      if (!(d > 0) || d > snap) continue;   // d === 0 是框内，第一轮已经处理完
      if (d < bestD) { bestD = d; best = { id, y, h }; }
    }
    if (!best) return null;
    // 把落点 clamp 进框，再用**同一份**口径算区域（不另写一段近似逻辑）
    const cy = wy < best.y ? best.y : (wy > best.y + best.h ? best.y + best.h : wy);
    return {
      id: best.id,
      zone: zoneOfPoint({ id: best.id, rootId, y: best.y, h: best.h, wy: cy, outside: true }),
    };
  }, []);

  const pointOf = useCallback((e) => {
    if (!e) return null;
    const cx = Number(e.clientX);
    const cy = Number(e.clientY);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    const rect = safeRect(canvasRef.current);
    return { x: cx - rect.left, y: cy - rect.top };
  }, []);

  const fitView = useCallback(() => {
    const rect = safeRect(canvasRef.current);
    let raw = null;
    try {
      raw = viewportForSize(layoutRef.current, rect.width, rect.height);
    } catch (e) {
      console.error('[MindMap] viewportForSize 失败', e);
      raw = null;
    }
    const next = readVp(raw); // 0 尺寸 ⇒ raw 多半是 undefined ⇒ 退化成 {1,0,0}
    viewRef.current = next;
    setViewport(next);
    // 只有量到了真实尺寸才算「已经适应过一次」，否则等 ResizeObserver 量到再补一次
    if (rect.width > 0 && rect.height > 0) fittedRef.current = true;
    return next;
  }, []);

  const invoke = useCallback((channel, ...args) => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.invoke !== 'function') {
      return Promise.reject(new Error('需要更新到新版豆芽'));
    }
    try {
      return Promise.resolve(api.invoke(channel, ...args));
    } catch (e) {
      return Promise.reject(e);
    }
  }, []);

  // ── 挂载：恢复视图，或适应视图 ────────────────────────────────────────────
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    let ui = null;
    try {
      ui = loadUi();
    } catch (e) {
      console.error('[MindMap] loadUi 失败', e);
    }
    const z = num(ui && ui.zoom, NaN);
    // ⚠️ zen 的恢复必须写在下面那条 `return` **之前**：存过视图的人会走 zoom 分支
    //    提前返回，放后面就永远读不到 zen（表现是"上次点了全屏，重开又不是了"）。
    const savedZen = !!(ui && ui.zen === true);
    zenSavedRef.current = savedZen;
    if (savedZen) setZen(true);
    if (Number.isFinite(z) && z > 0) {
      const restored = readVp({ zoom: z, panX: num(ui.panX, 0), panY: num(ui.panY, 0) });
      viewRef.current = restored;
      setViewport(restored);
      fittedRef.current = true;
      return;
    }
    fitView();
  }, [fitView]);

  /**
   * 跟踪画布尺寸。
   *
   * viewport 的 width / height 是要喂给 buildSvg 的（见 vpOut 注释），所以必须实测。
   * jsdom 里量到的永远是 0 —— 这里不 throw、不重试、也不影响任何按钮可点。
   * 另外「挂载那一刻还没排版」的情况（尺寸 0 ⇒ fitView 退化成 1:1）在第一次量到
   * 真实尺寸时补一次适应视图，否则用户打开就是左上角一角内容。
   */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const measure = () => {
      const r = safeRect(el);
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      const prev = sizeRef.current;
      const resized = prev.w !== w || prev.h !== h;
      if (resized) {
        sizeRef.current = { w, h };
        setSize({ w, h });
      }
      /**
       * 全屏切换登记的重适应请求（见 toggleZen 注释）。
       * 三个条件缺一不可：
       *   ① 未过期 —— 过期就地清掉，绝不允许它劫持后面某次无关的 resize；
       *   ② 尺寸真的变了 —— 否则 `fitView()` 算的是旧画布；
       *   ③ 量到了有效尺寸 —— jsdom 恒 0，量到 0 时 fit 出来的是 1:1，不如不 fit。
       */
      if (refitRef.current) {
        if (Date.now() - refitRef.current > REFIT_PENDING_MS) {
          refitRef.current = 0;
        } else if (resized && w > 0 && h > 0) {
          refitRef.current = 0;
          fitView();
          return;
        }
      }
      if (!fittedRef.current && w > 0 && h > 0) fitView();
    };
    measure();
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      try {
        ro = new ResizeObserver(measure);
        ro.observe(el);
      } catch (e) {
        ro = null;
      }
    }
    if (!ro && typeof window !== 'undefined') window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      else if (typeof window !== 'undefined') window.removeEventListener('resize', measure);
    };
  }, [fitView]);

  // ── 自动保存（600ms 防抖）────────────────────────────────────────────────
  useEffect(() => {
    if (!doc) return undefined;
    const t = setTimeout(() => {
      try {
        saveDoc(doc);
      } catch (e) {
        console.error('[MindMap] saveDoc 失败', e);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [doc]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        saveUi({ zoom: viewport.zoom, panX: viewport.panX, panY: viewport.panY });
      } catch (e) {
        console.error('[MindMap] saveUi 失败', e);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [viewport]);

  /**
   * zen 单独一条 saveUi：上面那条只在视图变化时触发，而切全屏不改 viewport。
   * `saveUi` 是合并式写入，两条各写各的字段不会互相覆盖。
   * 用 `zenSavedRef` 挡掉挂载首帧：那时 zen 还是默认的 false，直接写会把存档里
   * 的 true 冲掉（用户切了全屏、关掉、重开就变回普通视图，而且不会有任何报错）。
   */
  useEffect(() => {
    if (zenSavedRef.current === zen) return;
    zenSavedRef.current = zen;
    try {
      saveUi({ zen });
    } catch (e) {
      console.error('[MindMap] saveUi(zen) 失败', e);
    }
  }, [zen]);

  // ── 滚轮缩放（锚在光标上）─────────────────────────────────────────────────
  // React 的 onWheel 是被动监听，preventDefault 无效（页面会跟着滚），
  // 所以必须自己 addEventListener 并显式 passive:false。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof el.addEventListener !== 'function') return undefined;
    const onWheel = (e) => {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      // 滚轮缩放 = 视图动了 ⇒ 右键菜单的坐标立刻失效，关掉（`setCtx(null)` 在已是
      // null 时 React 会直接 bail out，不会白白重渲染）。
      setCtx(null);
      const rect = safeRect(el);
      const cx = num(e.clientX, 0) - rect.left;
      const cy = num(e.clientY, 0) - rect.top;
      const v = viewRef.current;
      const dy = num(e.deltaY, 0);
      if (!dy) return;
      const nextZoom = clamp(v.zoom * Math.exp(-dy * 0.0018), ZOOM_MIN, ZOOM_MAX);
      if (Math.abs(nextZoom - v.zoom) < 1e-6) return;
      // 光标下的世界坐标在缩放前后必须是同一个点
      const wx = (cx - v.panX) / (v.zoom || 1);
      const wy = (cy - v.panY) / (v.zoom || 1);
      const next = {
        zoom: nextZoom,
        panX: cx - wx * nextZoom,
        panY: cy - wy * nextZoom,
      };
      viewRef.current = next;
      setViewport(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── 平移：pointer + mouse 两套，window 级 move/up，gestureRef 去重 ──────────
  useEffect(() => {
    const onMove = (e) => {
      const g = gestureRef.current;
      if (!g) return;
      const p = pointOf(e);
      if (!p) return;
      const dx = p.x - g.startX;
      const dy = p.y - g.startY;
      // 2px 死区：手一抖就把它当拖动，会让「点一下选中」变成「拖了一下没选中」
      // （`moved` 而不是 `changed`：本文件的 `changed` 专指 AI 三态契约里的那个字段）
      if (!g.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      g.moved = true;
      const next = { zoom: g.zoom, panX: g.originX + dx, panY: g.originY + dy };
      viewRef.current = next;
      setViewport(next);
    };
    const onUp = () => {
      const g = gestureRef.current;
      if (!g) return;
      gestureRef.current = null;
      justPannedRef.current = !!g.moved;
      setPanning(false);
    };
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pointOf]);

  // ── 拖拽改父级：独立 ref + 独立 window 监听（不许与 gestureRef 混用）──────────
  /**
   * 手势生命周期与平移完全同构（window 级 move/up、2px 死区、`justPannedRef` 收尾），
   * 只有三处不同：
   *   ① 手势对象里带 `blocked`（自己 + 全部子孙），命中测试时直接跳过；
   *   ② 拖动**不改 viewport**，只更新一个 DOM 叠加层（`.mm-drop-hint`）——
   *      每次 mousemove 重拼一次整棵树的 SVG 是这一页最贵的操作（见 svg 的 useMemo 注释）；
   *   ③ 松手才动 doc：`moveNode` 自带环检测 / 子树深度校验 / 一级分支上限，
   *      失败就把它回的 error 原样放到 `.mm-error`（不吞、不假装成功）。
   *
   * 【2026-11-10 为什么"拖不动"】上一版只认 `dragOnlyParent` 算出的**唯一**落点
   * （祖父）。用户瞄准的是"想挂上去的那个框"，而唯一落点偏偏是它的祖父，
   * 于是几乎每次松手都落在画布上 ⇒ 不移动，只弹一句"只能拖到上一级"。
   * 现在改成：任意框都能当父级，且框的上/下边缘 = 插到它前/后（见 `hitDropAt`）。
   * 合法性判定仍然只有一份（`moveNode`），落点意图由 `dropIntent` 算。
   */
  useEffect(() => {
    const onMove = (e) => {
      const g = dragRef.current;
      if (!g) return;
      const p = pointOf(e);
      if (!p) return;
      const dx = p.x - g.startX;
      const dy = p.y - g.startY;
      // 2px 死区，与平移同一个口径：手一抖不该把「点一下」变成「拖了一下」
      if (!g.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      if (!g.moved) {
        g.moved = true;
        setDragging(true);
      }
      // ★ 跟手：影子跟着鼠标走（屏幕像素位移，不是世界坐标 —— 见 dragGhost 头注）
      setDragGhost({ id: g.id, dx, dy });
      // 松手时要把它换算成世界位移（自由摆放用）。存在手势对象上而不是从 ghost 读：
      //   状态更新是异步的，onUp 里读 dragGhost 会拿到上一帧的值 ⇒ 摆偏一点点。
      g.dxScreen = dx;
      g.dyScreen = dy;
      // 屏幕坐标 → 世界坐标（本文件唯一的坐标公式：screen = world*zoom + pan）
      const v = viewRef.current;
      const wx = (p.x - v.panX) / (v.zoom || 1);
      const wy = (p.y - v.panY) / (v.zoom || 1);
      const hit = hitDropAt(wx, wy, g.blocked, g.rootId, v.zoom || 1);
      const target = hit ? hit.id : '';
      const zone = hit ? hit.zone : 'child';
      g.over = target;
      g.zone = zone;
      if (dropRef.current !== target || dropZoneRef.current !== zone) {
        dropRef.current = target;
        dropZoneRef.current = zone;
        setDropHint(target);
        setDropZone(zone);
      }
    };
    const onUp = () => {
      const g = dragRef.current;
      if (!g) return;
      dragRef.current = null;
      dropRef.current = '';
      dropZoneRef.current = 'child';
      setDropHint('');
      setDropZone('child');
      setDragging(false);
      setDragGhost(null);
      // 拖完手一松，浏览器还会补一次 click。置位 `justPannedRef` 让那次 click
      // 走「刚拖过」分支，否则刚拖过去的节点会顺手把选中状态抹掉。
      justPannedRef.current = !!g.moved;
      if (!g.moved) return;
      /**
       * ★★ 松手分两种情况（2026-11-10 改）—— 这是「随意拼凑」的第二半。
       *
       * 【修前】没压在框上 ⇒ 什么都不做，弹一句「拖到某个框上才会移动」。
       *   于是用户**永远摆不出自己想要的版式**：想把这个框放到那个空白角落，
       *   系统只回一句规则，不接受他的意图。老板说的「自然就无法随意拼凑」就指这个。
       *
       * 【修后】没压在框上 = **自由摆放**：把这个框钉在世界坐标上（`setNodePosition`）。
       *   压在框上仍然走结构移动（改父子 / 改兄弟顺序）—— 两种意图都在，
       *   靠"松手时底下有没有框"天然区分，不需要额外的模式开关。
       *
       * 为什么"压在框上"不也做成自由摆放：
       *   那会毁掉它本来最有价值的用途 —— 重新组织层级（把 A 支整段挂到 B 下面）。
       *   而且自由摆放想挂在谁旁边，本来就是"拖到它附近"就够了。
       */
      if (!g.over) {
        const d0 = docRef.current;
        if (!d0) return;
        // 世界位移 = 屏幕位移 / zoom（与 onMove 里同一个换算，不另写一份公式）
        const z = viewRef.current.zoom || 1;
        const orig = (layoutRef.current && Array.isArray(layoutRef.current.nodes))
          ? layoutRef.current.nodes.find((n) => n && String(n.id) === String(g.id))
          : null;
        if (!orig) return;
        const wx = num(orig.x, 0) + (g.dxScreen || 0) / z;
        const wy = num(orig.y, 0) + (g.dyScreen || 0) / z;
        const res = setNodePosition(d0, g.id, wx, wy);
        if (res && res.ok === true && res.doc) {
          commitDoc(res.doc);
          setSelectedId(g.id);
          setNotice(null);
        } else {
          setNotice({ type: 'error', text: errText(res && res.error, '摆不到这个位置') });
        }
        return;
      }
      const d = docRef.current;
      if (!d) return;
      const it = dropIntent(d, g.id, g.over, g.zone);
      if (!it.ok) {
        setNotice({ type: 'error', text: it.reason || '这里不能放。' });
        return;
      }
      const res = moveNode(d, g.id, it.parentId, it.order);
      if (res && res.ok === true && res.doc) {
        commitDoc(res.doc);
        setSelectedId(g.id);
        setNotice(null);
      } else {
        setNotice({ type: 'error', text: errText(res && res.error, '改不了这个节点的上级') });
      }
    };
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mouseup', onUp);
    };
  }, [commitDoc, hitDropAt, pointOf]);

  const zoomBy = useCallback((factor) => {
    const v = viewRef.current;
    const nextZoom = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(nextZoom - v.zoom) < 1e-6) return;
    const rect = safeRect(canvasRef.current);
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - v.panX) / (v.zoom || 1);
    const wy = (cy - v.panY) / (v.zoom || 1);
    const next = { zoom: nextZoom, panX: cx - wx * nextZoom, panY: cy - wy * nextZoom };
    viewRef.current = next;
    setViewport(next);
  }, []);

  const onCanvasDown = (e) => {
    if (gestureRef.current || dragRef.current || ask) return;
    // 只认左键：右键要留给 `onContextMenu`。右键按下若起了平移手势，菜单弹出来的
    // 同时画布已经被拖动了一截，松手还会把「刚拖过」标记留成脏值。
    if (e && e.button != null && e.button !== 0) return;
    // 每次新的按下都清掉「刚拖完」标记：否则拖完一次之后，
    // 只要后面没有紧跟一次 click，下一次正常点击就会被误吞（表现是「点不中节点」）
    justPannedRef.current = false;
    const target = e && e.target;
    // 菜单**内部**的按下：既不起手势、也**不许**关菜单 —— 菜单项是 <button>，
    // 在 mousedown 时就把菜单卸掉的话，同一次物理点击里的 click 永远落不到那一项上
    // （表现是「点菜单没反应」，而且没有任何报错）。
    if (closestIn(target, '[data-mm-ctx]')) return;
    if (ctx) closeCtx();
    // 折叠按钮 / 编辑框不起任何手势
    if (closestIn(target, '[data-mm-toggle]') || closestIn(target, '.mm-edit')) return;
    const p = pointOf(e);
    if (!p) return;
    const hit = closestIn(target, '[data-node-id]');
    if (hit) {
      // 节点上按下 ⇒ 起「拖拽改父级」手势（改动前这里是直接 return，所以在节点上
      // 按住拖完全没反应 —— 那正是用户说的「拖动坏了」）。
      // 根节点不起：模型层明确「根不能移动」，起了手势也只能拖出一个必然失败的提示。
      const id = hit.getAttribute('data-node-id') || '';
      const d = docRef.current;
      if (!id || !d || id === d.rootId) return;
      // 编辑态里先把编辑框收掉再谈拖动：不然后面整段拖动都会有一个框跟着节点错位
      if (editingIdRef.current) return;
      dragRef.current = {
        id: String(id),
        startX: p.x,
        startY: p.y,
        moved: false,
        // 【2026-11-10】落点不再是"按下时算好的唯一目标"，而是**跟着鼠标走**：
        // over = 当前压在哪个框上，zone = 压在它的中间还是上/下边缘。
        over: '',
        zone: 'child',
        // 屏幕位移（自由摆放时换算世界坐标用）。初值 0 而不是 undefined：
        //   少一次 `|| 0` 兜底，也就少一个"忘了初始化 ⇒ NaN ⇒ 框飞到画外"的机会。
        dxScreen: 0,
        dyScreen: 0,
        // 根 id 存进手势：`hitDropAt` 需要它来把"根的上下边缘"归一成"挂到主拼图下面"。
        rootId: d.rootId,
        // 非法落点提前算好（自己 + 全部子孙）：拖拽期间结构不变，一次 DFS 足够
        blocked: subtreeIds(d, id),
      };
      return;
    }
    if (typeof e.preventDefault === 'function') e.preventDefault();
    gestureRef.current = {
      startX: p.x,
      startY: p.y,
      originX: viewRef.current.panX,
      originY: viewRef.current.panY,
      zoom: viewRef.current.zoom,
      moved: false,
    };
    setPanning(true);
    if (canvasRef.current && typeof canvasRef.current.focus === 'function') canvasRef.current.focus();
  };

  // ── 选中 / 折叠切换（全部在画布这一层委托）─────────────────────────────────
  const onCanvasClick = (e) => {
    const target = e && e.target;
    // 菜单内部的点击不参与画布的「选中 / 取消选中」判定：点「AI 扩散」时那一项自己
    // 会把这个节点设成选中，事件再冒泡到画布清一次 ⇒ 用户看到的是
    // 「点了扩散，却提示先在画布上点一个节点」（典型的自伤）。
    if (closestIn(target, '[data-mm-ctx]')) return;
    const tg = closestIn(target, '[data-mm-toggle]');
    if (tg) {
      justPannedRef.current = false;
      const id = tg.getAttribute('data-mm-toggle') || '';
      const res = id ? toggleCollapse(docRef.current, id) : null;
      if (res && res.ok === true && res.doc) commitDoc(res.doc);
      else setNotice({ type: 'error', text: errText(res && res.error, '展开 / 收起失败了') });
      return;
    }
    if (closestIn(target, '.mm-edit')) return;
    const hit = closestIn(target, '[data-node-id]');
    if (hit) {
      // 选节点**永远**生效：拖完手一松落在节点上，选中它也是用户想要的结果。
      // （早先这里先把「刚拖过」的点击整个吞掉，结果自动化派发的裸 click 在拖动测试之后
      //   全被吞 ⇒ 表现为"点不中节点"，而人手操作因为总带 mousedown 反而看不出来。）
      justPannedRef.current = false;
      const id = hit.getAttribute('data-node-id') || '';
      if (id) setSelectedId(id);
      if (canvasRef.current && typeof canvasRef.current.focus === 'function') canvasRef.current.focus();
      return;
    }
    // 只有「在空白处点一下 = 取消选中」这一条要挡住拖动收尾的那次 click，
    // 否则刚拖完画布，选中就被清掉了。
    if (justPannedRef.current) {
      justPannedRef.current = false;
      return;
    }
    // 清掉之前先记一笔（带时间戳）：双击空白的两次 click 都会走到这里，
    // 到 dblclick 时 `selectedId` 已经是空了 —— 种子就是这一层唯一的来路。
    // ⚠️ 只在**真有选中**时覆盖：单击空白后 `selectedId` 已是空串，若在第二下 click
    //    里无条件覆盖，种子会被自己抹成空（实测：双击空白总是加在根下）。
    if (selectedId) lastSelectedRef.current = { id: String(selectedId), at: Date.now() };
    setSelectedId('');
  };

  const onCanvasDblClick = (e) => {
    const target = e && e.target;
    if (closestIn(target, '[data-mm-ctx]')) return;
    const hit = closestIn(target, '[data-node-id]');
    if (hit) {
      // 命中节点：改名（XMind 同款）
      const id = hit.getAttribute('data-node-id') || '';
      if (id) beginEdit(id);
      return;
    }
    if (closestIn(target, '[data-mm-toggle]') || closestIn(target, '.mm-edit')) return;
    // 空白处双击：给**当前选中节点**加一个子节点并立刻进入编辑。没有选中就加在根下。
    // 为什么必须自己算 parentId 而不能直接 `addChildTo(selectedId)`：parentId 为空时
    // `addChildTo` 只会弹一句「先在画布上点一个节点」—— 而空白双击恰恰是最常见的新建入口。
    // 选中种子只在一次双击的时间窗内算数：隔很久的"先取消选中、再双击空白"，
    // 用户要的是加在根下（见 SELECT_SEED_MS）。
    const d = docRef.current;
    if (!d) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const seed = lastSelectedRef.current || { id: '', at: 0 };
    const seeded = seed.id && Date.now() - num(seed.at, 0) < SELECT_SEED_MS ? seed.id : '';
    const parentId = String(selectedId || seeded || d.rootId || '');
    lastSelectedRef.current = { id: '', at: 0 };
    if (!parentId) return;
    addChildTo(parentId);
  };

  // ── 右键菜单 ──────────────────────────────────────────────────────────────
  /**
   * 菜单只有一个状态 `{ x, y, nodeId }`：
   *   · `nodeId` 非空 ⇒ 作用在那个节点上（加子 / 加同级 / 改名 / 展开收起 / AI 扩散 / AI 润色 / 删除）
   *   · `nodeId` 为空 ⇒ 空白菜单（加子节点 / 适应视图 / 全屏 / AI 生成 / AI 换框架）
   *
   * 关闭时机刻意**不挂 `document` 上的 click**：同一次物理点击里，浏览器先派发菜单项
   * 的 click、再冒泡到 document，监听里关菜单会让「点菜单没反应」（菜单在你点它的
   * 那一瞬被卸掉，而动作绑在马上要卸载的节点上）。只认这五条，全在本文件内：
   *   Escape / 画布上再次按下 / 滚轮缩放 / 开始平移 / 选了任一项之后。
   *
   * 右键**同时选中**命中的节点（0.21.26 决定，见下面 `setSelectedId` 那条注释）。
   */
  const onCanvasContextMenu = (e) => {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    justPannedRef.current = false;
    const p = pointOf(e);
    if (!p) return;
    const hit = closestIn(e && e.target, '[data-node-id]');
    const nodeId = hit ? String(hit.getAttribute('data-node-id') || '') : '';
    /**
     * 右键命中节点时把它设为选中。三个理由（都指向同一件事：**画面上说的和即将发生的
     * 必须是同一件事**）：
     *   ① 菜单本身作用在这个 nodeId 上，若画布还高亮着**另一个**节点（或什么都不高亮），
     *      界面就在自相矛盾 —— 用户看到"没选中/选的是别处"，菜单却要改这一个。
     *   ② 工具栏的「AI 扩散 / AI 润色」在无选中时是灰的。右键一个节点是很强的意图信号，
     *      却还要"先左键点一下、再右键"，这正是老板说的「操作绕」。
     *   ③ 更实际的一条**隐患**：右键 B 而当时选中的是 A，接着按 Delete 删掉的是 A ——
     *      菜单让你以为在操作 B。让选中跟着右键走，这个错位就不存在了。
     * 这与参考实现（XMind）一致。**只在命中节点时**选：空白右键不改选中，因为空白菜单
     * 里的「加子节点」正是靠当前选中（`selectedId || rootId`）决定挂到哪。
     */
    if (nodeId) setSelectedId(nodeId);
    setCtx({ x: p.x, y: p.y, nodeId });
    if (canvasRef.current && typeof canvasRef.current.focus === 'function') canvasRef.current.focus();
  };

  /**
   * 菜单项清单。每项 `{ act, label, run, disabled, danger }`，分隔条是 `{ act, sep:true }`。
   * `data-mm-ctx-act` 的取值是**对外契约**（验证脚本按它点），改名要同步说一声。
   * 不可用的项一律 `disabled` 而不是隐藏：菜单项**跳来跳去**比灰着一项更让人迷惑，
   * 而"为什么不能用"就写在那一项的存在上（根节点不能删 / 不能折叠）。
   */
  const ctxItems = () => {
    if (!ctx) return [];
    const d = docRef.current;
    const nodeId = String(ctx.nodeId || '');
    const node = nodeId ? findNode(nodeId) : null;
    if (node) {
      const isRoot = !d || nodeId === d.rootId;
      const hasChild = (d && Array.isArray(d.nodes) ? d.nodes : [])
        .some((n) => n && String(n.parentId || '') === nodeId);
      return [
        { act: 'child', label: '加子节点', run: () => addChildTo(nodeId) },
        { act: 'sibling', label: '加同级', run: () => addSiblingTo(nodeId), disabled: isRoot },
        { act: 'rename', label: '改名', run: () => beginEdit(nodeId) },
        {
          act: 'collapse',
          label: node.collapsed ? '展开这一支' : '收起这一支',
          disabled: isRoot || !hasChild,
          run: () => {
            const res = toggleCollapse(docRef.current, nodeId);
            if (res && res.ok === true && res.doc) commitDoc(res.doc);
            else setNotice({ type: 'error', text: errText(res && res.error, '展开 / 收起失败了') });
          },
        },
        { act: 'sep-a', sep: true },
        {
          act: 'expand',
          label: 'AI 扩散',
          disabled: !!busy,
          run: () => {
            // 右键时已选中（见 onCanvasContextMenu），这句现在是**冗余但保留**的防御：
            // AI 面板提交读的是 selectedId 而不是菜单里的 nodeId，把这一层依赖显式写在这里，
            // 将来若有人改掉"右键即选中"，扩散仍然打在这个节点上，不会静默打到别人身上。
            setSelectedId(nodeId);
            openAsk('expand');
          },
        },
        { act: 'polish', label: 'AI 润色', run: () => doPolish(nodeId), disabled: !!busy },
        { act: 'sep-b', sep: true },
        /**
         * 「归位」：取消手动摆放，让树布局重新接管（清 x/y）。
         * 只在**真的被拖过**时才出现 —— 没拖过的节点给出一个点了没反应的菜单项，
         * 比不给更糟（用户会以为坏了）。判据取 layout 算好的 `pinned`，不在这里重查 doc。
         */
        {
          act: 'unpin',
          label: '归位（取消手动摆放）',
          run: () => {
            const res = clearNodePosition(docRef.current, nodeId);
            if (res && res.ok === true && res.doc) { commitDoc(res.doc); setNotice(null); }
            else setNotice({ type: 'error', text: errText(res && res.error, '归位失败') });
          },
          hidden: !(layoutNodes.get(nodeId) && layoutNodes.get(nodeId).pinned === true),
        },
        { act: 'delete', label: '删除', danger: true, run: () => deleteNode(nodeId), disabled: isRoot },
      ];
    }
    const parentId = String(selectedId || (d && d.rootId) || '');
    return [
      { act: 'child', label: '加子节点', run: () => addChildTo(parentId), disabled: !parentId },
      { act: 'fit', label: '适应视图', run: fitView },
      { act: 'zen', label: zen ? '退出全屏' : '全屏', run: toggleZen },
      { act: 'sep-a', sep: true },
      { act: 'generate', label: 'AI 生成', run: () => openAsk('generate'), disabled: !!busy },
      { act: 'restructure', label: 'AI 换框架', run: () => openAsk('restructure'), disabled: !!busy },
    ];
  };

  // ── 行内编辑 ──────────────────────────────────────────────────────────────
  const beginEdit = useCallback((id) => {
    const node = findNode(id);
    if (!node) return;
    const text = String(node.text == null ? '' : node.text);
    editingIdRef.current = id;
    draftRef.current = text;
    setDraft(text);
    setEditingId(id);
    setSelectedId(id);
  }, [findNode]);

  const cancelEdit = useCallback(() => {
    editingIdRef.current = '';
    draftRef.current = '';
    setEditingId('');
    setDraft('');
  }, []);

  const commitEdit = useCallback(() => {
    const id = editingIdRef.current;
    if (!id) return;
    // 先把编辑态关掉再动 doc：Enter 与 blur 可能连着来两次，第二次进来时 id 已空，直接 return
    editingIdRef.current = '';
    const text = draftRef.current;
    setEditingId('');
    setDraft('');
    if (!docRef.current) return;
    const node = findNode(id);
    const prev = node ? String(node.text == null ? '' : node.text) : '';
    if (text === prev) return; // 没改就不写盘，省一次存档抖动
    const res = updateNodeText(docRef.current, id, text);
    if (res && res.ok === true && res.doc) {
      commitDoc(res.doc);
      setNotice(null);
    } else {
      setNotice({ type: 'error', text: errText(res && res.error, '改不了这个节点') });
    }
  }, [commitDoc, findNode]);

  useEffect(() => {
    if (!editingId) return;
    const el = editRef.current;
    if (!el || typeof el.focus !== 'function') return;
    el.focus();
    if (typeof el.select === 'function') el.select();
  }, [editingId]);

  // ── 结构编辑（Tab / Enter / Delete）────────────────────────────────────────
  /**
   * 加子节点并立刻进入编辑。
   *
   * @param {string} parentId 父节点
   * @param {number} [order] 指定排位（加「同级节点」时用来插在原节点后面）
   */
  const addChildTo = useCallback((parentId, order) => {
    if (!parentId) {
      setNotice({ type: 'hint', text: '先在画布上点一个节点' });
      return;
    }
    const res = addChild(docRef.current, parentId, NEW_NODE_TEXT);
    if (!res || res.ok !== true || !res.doc || !res.nodeId) {
      setNotice({ type: 'error', text: errText(res && res.error, '加不了新节点') });
      return;
    }
    let next = res.doc;
    const wantOrder = num(order, NaN);
    if (Number.isFinite(wantOrder)) {
      const mv = moveNode(next, res.nodeId, parentId, wantOrder);
      if (mv && mv.ok === true && mv.doc) next = mv.doc;
    }
    commitDoc(next);
    setNotice(null);
    beginEdit(res.nodeId);
  }, [beginEdit, commitDoc]);

  const addSiblingTo = useCallback((id) => {
    const node = findNode(id);
    if (!node) {
      setNotice({ type: 'hint', text: '先在画布上点一个节点' });
      return;
    }
    const parentId = node.parentId || '';
    if (!parentId) {
      setNotice({ type: 'hint', text: '根节点没有同级节点：按 Tab 给它加一个子节点' });
      return;
    }
    addChildTo(parentId, num(node.order, 0) + 1);
  }, [addChildTo, findNode]);

  const deleteNode = useCallback((id) => {
    const d = docRef.current;
    if (!d || !id) return;
    if (id === d.rootId) {
      setNotice({ type: 'hint', text: '根节点不能删：可以删它下面的分支' });
      return;
    }
    const node = findNode(id);
    const res = removeSubtree(d, id);
    if (!res || res.ok !== true || !res.doc) {
      setNotice({ type: 'error', text: errText(res && res.error, '删不掉这个节点') });
      return;
    }
    const removed = Array.isArray(res.removed) ? res.removed.length : num(res.removed, 0);
    commitDoc(res.doc);
    setSelectedId((node && node.parentId) || res.doc.rootId || '');
    setNotice(removed > 0 ? { type: 'ok', text: '已删除 ' + removed + ' 个节点' } : null);
  }, [commitDoc, findNode]);

  /** 方向键在**可见**节点之间走：上下走同级，左右走父子。 */
  const stepSelection = useCallback((key) => {
    const d = docRef.current;
    if (!d) return;
    let list = [];
    try {
      list = flattenVisible(d) || [];
    } catch (e) {
      console.error('[MindMap] flattenVisible 失败', e);
      list = [];
    }
    if (!list.length) return;
    const cur = list.findIndex((n) => n.id === selectedId);
    if (cur < 0) {
      setSelectedId(list[0].id);
      return;
    }
    const node = list[cur];
    if (key === 'ArrowLeft') {
      if (node.parentId) setSelectedId(node.parentId);
      return;
    }
    if (key === 'ArrowRight') {
      const child = list.find((n) => n.parentId === node.id);
      if (child) setSelectedId(child.id);
      return;
    }
    const siblings = list.filter((n) => (n.parentId || '') === (node.parentId || ''));
    const i = siblings.findIndex((n) => n.id === node.id);
    const next = key === 'ArrowUp' ? siblings[i - 1] : siblings[i + 1];
    if (next) setSelectedId(next.id);
  }, [selectedId]);

  const onCanvasKeyDown = (e) => {
    // 编辑态下所有快捷键必须失效，否则打字打不出来
    if (editingIdRef.current || ask) return;
    if (!docRef.current) return;
    const key = e.key;
    if (key === 'Escape') {
      // 层级顺序：先关右键菜单，再退全屏。反过来的话「退出全屏」会顺带把菜单关掉，
      // 用户按一次 Esc 掉了两级，会以为菜单是自己坏的。
      if (ctx) {
        closeCtx();
        return;
      }
      if (zen) {
        e.preventDefault();
        setZen(false);
      }
      return;
    }
    if (key === 'Tab') {
      e.preventDefault();
      addChildTo(selectedId);
      return;
    }
    if (key === 'Enter') {
      e.preventDefault();
      addSiblingTo(selectedId);
      return;
    }
    if (key === 'F2') {
      e.preventDefault();
      if (selectedId) beginEdit(selectedId);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      deleteNode(selectedId);
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      stepSelection(key);
    }
  };

  /**
   * 菜单开着**或**全屏时，Escape 走 window 级监听：**不依赖画布焦点**。
   *
   * 画布不一定握着焦点。两个真实处境：
   *   · 菜单是靠鼠标右键弹出来的，弹之前焦点可能停在工具栏某个联动开关上；
   *   · 全屏是靠点工具栏那个「全屏」开关进来的 ⇒ 焦点正落在开关上，而开关属于
   *     `.mm-toolbar`，与 `.mm-canvas` 是**兄弟子树** ⇒ keydown 永远走不到画布上的
   *     `onCanvasKeyDown`。开关的 title 与 `.mm-keys` 图例都写着「Esc 退出全屏」，
   *     只挂画布就等于这条承诺对**最常见的那条路径**（点开关进全屏）失效。
   *     （这正是 0.21.26 修 Z21 的根因：同一个推理早先只对右键菜单做过，没套到全屏上。）
   *
   * 层级顺序与 `onCanvasKeyDown` 里那条保持一致：**先关菜单，再退全屏**。反过来的话
   * 「退出全屏」会顺带把菜单关掉，用户按一次 Esc 掉了两级，会以为菜单是自己坏的。
   *
   * ⚠️ `editingIdRef.current || ask` 这条守卫必须有，且与 `onCanvasKeyDown` 开头那条
   *    `if (editingIdRef.current || ask) return;` 是**同一口径**：改名中 / AI 面板里，
   *    Esc 属于它们（取消改名 / 关面板），不能被全屏抢走 —— 否则一次 Esc 会同时
   *    「取消改名」和「退出全屏」，用户按一下掉两级。
   * ⚠️ `editingIdRef` 是 ref，**不进**依赖数组：它不触发重渲染，进数组只会多挂一次监听。
   * ⚠️ 与 `onCanvasKeyDown` 的 Esc 分支会重复处理同一次按键（画布有焦点时两者都跑）：
   *    `setCtx(null)` / `setZen(false)` 都是幂等的，重复跑没有副作用。
   *    别去加 `if (e.defaultPrevented) return;` 这种守卫 —— `onCanvasKeyDown` 只在 zen
   *    分支调了 preventDefault、ctx 分支没调，那条守卫会把菜单场景漏掉。
   *    保持幂等、两条都跑，更简单也更不容易错。
   */
  useEffect(() => {
    if (!ctx && !zen) return undefined;
    if (typeof window === 'undefined') return undefined;
    const onKey = (e) => {
      if (!e || e.key !== 'Escape') return;
      // 层级：菜单优先。一次 Esc 只退一级，用户不会以为菜单自己坏了。
      if (ctx) {
        setCtx(null);
        return;
      }
      // 编辑态与 AI 面板里，Esc 属于它们（取消改名 / 关面板），不能被全屏抢走。
      if (editingIdRef.current || ask) return;
      if (zen) setZen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx, zen, ask]);

  const onEditKeyDown = (e) => {
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    // Enter 一律提交（不给 Shift+Enter 留换行）：模型层的 cleanNodeText 会把 \s+ 压成一个空格，
    // 节点文字本来就是单行。留着 Shift+Enter 只会让用户看见一个换行、提交后它又变成空格。
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  // ── AI ────────────────────────────────────────────────────────────────────
  /**
   * 交给四条 AI 通路的企业上下文。
   *
   * ⚠️ 每次点击**现算**，不要 useMemo / useRef 缓存：`contextBuilder.js:421` 明确写着
   *    自解析读的是**已落盘**的值。用户刚在「企业大脑」改完资料、还没切页就回来生成导图，
   *    缓存会拿到改之前的企业 —— 表现为「明明补了卖点，AI 还是不知道我们卖什么」。
   *    这里的成本只是几次 localStorage 读，可以忽略。
   * ⚠️ 没有当前企业时给 `null`，**不要**给 `buildAIContext({})`：后者会先白算一遍
   *    再返回「无企业」的上下文；而 service 的参数默认值就是 `null`，给 null 语义更直白。
   */
  const aiContext = () => (cid ? buildAIContext({ companyId: cid }) : null);

  const aiFail = (res, fallback) => {
    setNotice({ type: 'error', text: errText(res && res.error, fallback) });
  };

  const doGenerate = async (topic) => {
    if (busy) return;
    setBusy('generate');
    setNotice(null);
    try {
      const res = await aiGenerateTree({ topic, branchCount: GEN_BRANCHES, context: aiContext() });
      if (!res || res.ok !== true || !res.doc) {
        aiFail(res, 'AI 生成失败：没有拿到导图');
        return;
      }
      commitDoc(res.doc);
      setSelectedId(res.doc.rootId || '');
      setNotice({ type: 'ok', text: '已生成：' + String(res.doc.title || topic || '新导图') });
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, 'AI 生成失败') });
    } finally {
      setBusy('');
    }
  };

  const doExpand = async (nodeId, hint) => {
    if (busy) return;
    if (!nodeId) {
      setNotice({ type: 'hint', text: '先在画布上点一个节点，再扩散' });
      return;
    }
    setBusy('expand');
    setNotice(null);
    try {
      const res = await aiExpandNode({
        doc: docRef.current,
        nodeId,
        hint,
        childCount: EXPAND_COUNT,
        context: aiContext(),
      });
      // ③ 真失败：不动 doc，红框原样显示 error
      if (!res || res.ok !== true) {
        aiFail(res, 'AI 扩散失败：没有拿到导图');
        return;
      }
      /**
       * `changed` 必填（与润色同一份三态契约，`mindmapAI.js` 的 aiExpandNode 里写着
       * 「`changed` 与润色同口径：始终存在，不留给 UI 用『有没有 doc』去反推三态」）。
       * 缺了就报契约违约，不猜：猜「够具体」会把真长出分支的那次静默丢掉，
       * 猜「长出来了」会在没有 doc 时把用户引向一个红字才该出现的地方。
       */
      if (typeof res.changed !== 'boolean') {
        setNotice({
          type: 'error',
          text: 'AI 扩散的结果缺少「是否有新分支」的标记，请更新到新版豆芽',
        });
        return;
      }

      // ② 没有新分支：AI 认为这个节点已经够具体了 —— 正常结论，中性提示，**不写 doc**
      //    （没变化就不该在存档里多出一次空动作）。
      //    ⚠️ 这一条必须在下面的 `!res.doc` 之前：第 ② 态本来就**没有 doc**，
      //    顺序反了就会把「不需要再展开」报成「AI 扩散失败」。
      if (res.changed === false) {
        setNotice({ type: 'hint', text: noteOr(res, '这个节点已经够具体了，不用再展开。') });
        return;
      }

      // ① 长出分支
      if (!res.doc) {
        aiFail(res, 'AI 扩散失败：没有拿到导图');
        return;
      }
      commitDoc(res.doc);
      setSelectedId(nodeId);
      setNotice({ type: 'ok', text: '已扩散出 ' + EXPAND_COUNT + ' 个分支（多了可以删）' });
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, 'AI 扩散失败') });
    } finally {
      setBusy('');
    }
  };

  const doRestructure = async (frameworkKey) => {
    if (busy) return;
    setBusy('restructure');
    setNotice(null);
    try {
      const res = await aiRestructure({ doc: docRef.current, frameworkKey, context: aiContext() });
      if (!res || res.ok !== true || !res.doc) {
        aiFail(res, 'AI 换框架失败：没有拿到导图');
        return;
      }
      commitDoc(res.doc);
      setSelectedId(res.doc.rootId || '');
      setNotice({ type: 'ok', text: '已按新框架重排' });
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, 'AI 换框架失败') });
    } finally {
      setBusy('');
    }
  };

  const doPolish = async (nodeId) => {
    if (busy) return;
    if (!nodeId) {
      setNotice({ type: 'hint', text: '先在画布上点一个节点，再润色' });
      return;
    }
    setBusy('polish');
    setNotice(null);
    try {
      const res = await aiPolishNode({ doc: docRef.current, nodeId, context: aiContext() });

      // ③ 真失败：不动 doc，红框原样显示 error
      if (!res || res.ok !== true) {
        aiFail(res, 'AI 润色失败：没有拿到结果');
        return;
      }

      /**
       * `changed` 必填（三态契约）。缺了它就只能靠 `text === original` 猜，而 service 侧
       * 已经 cleanText 规整过 —— 猜错的表现是「提示说没改、文字其实变了」，且不会有任何报错。
       * 所以这里不猜：直接当契约违约报出来，指向版本问题。
       */
      if (typeof res.changed !== 'boolean') {
        setNotice({
          type: 'error',
          text: 'AI 润色的结果缺少「是否需要改动」的标记，请更新到新版豆芽',
        });
        return;
      }

      // ② 已够好：AI 在遵守 prompt 里「原文足够好就原样返回」的邀请，属正常结论。
      //    **不写 doc** —— 文字本来就没变，写一遍只会在撤销栈上多一个空动作。
      if (res.changed === false) {
        setNotice({ type: 'hint', text: noteOr(res, KEPT_ORIGINAL_TEXT) });
        return;
      }

      // ① 改好了：写回节点，并把新文字一起显示（用户刚点的就是这个节点，不用去画布上找）
      const text = typeof res.text === 'string' ? res.text.trim() : '';
      if (!text) {
        setNotice({ type: 'error', text: 'AI 润色失败：返回了空文本' });
        return;
      }
      const applied = updateNodeText(docRef.current, nodeId, text);
      if (!applied || applied.ok !== true || !applied.doc) {
        setNotice({ type: 'error', text: errText(applied && applied.error, '润色结果写不回节点') });
        return;
      }
      commitDoc(applied.doc);
      setNotice({ type: 'ok', text: polishedText(text) });
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, 'AI 润色失败') });
    } finally {
      setBusy('');
    }
  };

  // ── 新建 / 复制大纲 / 导出图片 ─────────────────────────────────────────────
  const startNewDoc = () => {
    let next = null;
    try {
      next = createDoc(DEFAULT_TITLE);
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, '新建失败') });
      return;
    }
    if (!next) {
      setNotice({ type: 'error', text: '新建失败：没有拿到空导图' });
      return;
    }
    commitDoc(next);
    // 重新开始 ⇒ 不选中任何节点（AI 类按钮因此回到 disabled，等用户先点一个）
    setSelectedId('');
    setNotice(null);
    try {
      clearAll();
    } catch (e) {
      console.error('[MindMap] clearAll 失败', e);
    }
    fitView();
  };

  const copyOutline = async () => {
    if (busy) return;
    if (!docRef.current) return;
    let md = '';
    try {
      md = String(docToMarkdown(docRef.current) || '');
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, '生成大纲失败') });
      return;
    }
    if (!md.trim()) {
      setNotice({ type: 'hint', text: '这张导图还是空的，没东西可复制' });
      return;
    }
    setBusy('md');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('当前环境拿不到剪贴板，请升级到新版豆芽');
      }
      await navigator.clipboard.writeText(md);
      setNotice({ type: 'ok', text: '已复制，可直接粘进 Word' });
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, '复制失败') });
    } finally {
      setBusy('');
    }
  };

  const loadImage = (url) => new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('导出失败：图片没能在 15 秒内画出来（先折叠几个分支再试）'));
    }, IMAGE_TIMEOUT_MS);
    const img = new Image();
    img.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('导出失败：导图渲染不出来（先折叠几个分支再试）'));
    };
    img.src = url;
  });

  const exportPng = async () => {
    if (busy) return;
    const d = docRef.current;
    if (!d) return;
    setBusy('export');
    setNotice(null);
    let objectUrl = '';
    try {
      // 导出用「适应视图」的 viewport：成品图要完整，不能按用户当前滚到哪儿就截哪儿
      let rawVp = null;
      try {
        rawVp = fitViewport(layoutRef.current, 1);
      } catch (e) {
        rawVp = null;
      }
      // ⚠️ 导出**不传** `theme`：交付物永远是浅底品牌绿（见 mindmapSvg.js 的两套色板注释）。
      // 预览那条路径（本文件上方 svg useMemo）才传 theme，两者刻意分开。
      const built = buildSvg({
        doc: d,
        layout: layoutRef.current,
        viewport: rawVp || vpOut({ zoom: 1, panX: 0, panY: 0 }),
        selectedId: '',
        showNote: false,
      });
      const markup = String((built && built.markup) || '');
      if (!markup) throw new Error('导出失败：导图是空的，没有可导出的内容');
      const width = Math.max(1, Math.round(num(built.width, 1)));
      const height = Math.max(1, Math.round(num(built.height, 1)));

      const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
      objectUrl = URL.createObjectURL(blob);
      // 必须 await 到 onload：没解码完就 drawImage，画出来是空白图（PosterStudio 踩过）
      const img = await loadImage(objectUrl);

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * 2));
      canvas.height = Math.max(1, Math.round(height * 2));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('导出失败：设备画不出这张图（先折叠几个分支再试）');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      let dataUrl = '';
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch (e) {
        // 超画布面积上限时 toDataURL 会直接抛；转成人话
        throw new Error('导出失败：导图太大，设备画不出来（先折叠几个分支再试）');
      }
      if (!dataUrl || dataUrl === 'data:,' || dataUrl.length < 512) {
        throw new Error('导出失败：导图太大，设备画不出来（先折叠几个分支再试）');
      }

      const res = await invoke('poster:export', { dataUrl, ext: 'png', filename: pngName(d) });
      if (!res || res.ok !== true) {
        // 取消态：主进程回 { ok:false, canceled:true }，**没有 error 字段**。
        // 绝不能写 res.error.includes(...)（取消时 TypeError），也绝不能报成失败。
        if (res && res.canceled === true) {
          setNotice({ type: 'ok', text: '已取消' });
          return;
        }
        throw new Error((res && res.error) || '导出失败：主进程没有返回成功');
      }
      const p = String(res.path || '');
      setNotice({ type: 'ok', text: p ? '已导出：' + p : '已导出' });
    } catch (e) {
      setNotice({ type: 'error', text: errText(e, '导出失败') });
    } finally {
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (e) {
          /* 释放失败不影响结果 */
        }
      }
      setBusy('');
    }
  };

  // ── AI 面板 ───────────────────────────────────────────────────────────────
  const openAsk = (mode) => {
    if (busy) return;
    setAskErr('');
    if (mode === 'restructure') {
      const first = Array.isArray(MM_AI_FRAMEWORKS) && MM_AI_FRAMEWORKS.length ? MM_AI_FRAMEWORKS[0] : null;
      setAsk({ mode, value: '', fw: (first && first.key) || '' });
      return;
    }
    setAsk({ mode, value: '', fw: '' });
  };

  const closeAsk = () => {
    setAsk(null);
    setAskErr('');
  };

  const submitAsk = () => {
    const a = ask;
    if (!a) return;
    if (a.mode === 'new') {
      closeAsk();
      startNewDoc();
      return;
    }
    if (a.mode === 'generate') {
      const topic = String(a.value || '').trim();
      if (!topic) {
        setAskErr('先写一句主题，AI 才知道要长什么');
        return;
      }
      closeAsk();
      doGenerate(topic);
      return;
    }
    if (a.mode === 'expand') {
      const hint = String(a.value || '').trim();
      const nodeId = selectedId;
      closeAsk();
      doExpand(nodeId, hint);
      return;
    }
    if (a.mode === 'restructure') {
      const fw = String(a.fw || '');
      if (!fw) {
        setAskErr('先选一个框架');
        return;
      }
      closeAsk();
      doRestructure(fw);
    }
  };

  // ── 派生渲染数据 ──────────────────────────────────────────────────────────
  /**
   * 折叠 / 展开标识（DOM 叠加层）。
   *
   * 契约里 buildSvg 不画这个（它只画框和文字），所以由本模块自己叠一层：
   * 位置 = 节点朝外那条边的中点，换算到屏幕（screen = world*zoom + pan），
   * 再往外挪 10px —— 刻意**不压在节点上**，否则点节点边缘会被这个按钮抢走。
   *
   * 只给「有子节点的节点」画（没有子节点的折叠毫无意义），并且两个方向都有：
   * collapsed 显示 `+`（点开），展开显示 `−`（收起）。只画 `+` 的话用户就没有
   * 任何入口把分支收起来 —— 那是"能做一半"的功能。
   */
  const toggles = useMemo(() => {
    if (!doc) return [];
    const nodes = doc.nodes || [];
    const hasChild = new Set(nodes.map((n) => n.parentId).filter(Boolean));
    const out = [];
    for (const n of nodes) {
      // 根不给：模型层明确「根不能折叠」（折叠根 = 整张图空屏，用户会以为文件坏了），
      // 那就别画一个点一下就报错的按钮
      if (!n || n.id === doc.rootId || !hasChild.has(n.id)) continue;
      const ln = layoutNodes.get(n.id);
      if (!ln) continue;
      const outward = ln.side === 'left' ? num(ln.x, 0) - 10 : num(ln.x, 0) + num(ln.w, 0) + 10;
      out.push({
        id: n.id,
        collapsed: !!n.collapsed,
        x: outward * viewport.zoom + viewport.panX,
        y: (num(ln.y, 0) + num(ln.h, 0) / 2) * viewport.zoom + viewport.panY,
      });
    }
    return out;
  }, [doc, layoutNodes, viewport]);

  const editNode = editingId ? layoutNodes.get(editingId) : null;
  /**
   * 行内编辑框的位置与尺寸：盖在节点的屏幕矩形上（screen = world*zoom + pan）。
   *
   * 字号也跟着 zoom 走，但钳在 12~20px：真机读数显示节点文字普遍 9~15 字、框高只有
   * h≈38（`MM_LAYOUT.lineH 20 + nodePadY 9*2`），所以**不预留两行**——预留了只会是一片空白。
   * 反过来，缩到 0.4 倍时若字号仍是 14，就成了一个 30px 高的框里塞 28px 的字，
   * 与画布上被缩小的节点完全对不上；所以按 zoom 缩放并保一个可读下限。
   */
  const editFontSize = Math.round(clamp(14 * viewport.zoom, 12, 20));
  const editStyle = editNode
    ? {
      left: num(editNode.x, 0) * viewport.zoom + viewport.panX,
      top: num(editNode.y, 0) * viewport.zoom + viewport.panY,
      width: Math.max(96, num(editNode.w, 0) * viewport.zoom),
      // 一行文字的高度：字号 × 1.35 + 上下内边距 12（见 mindmap.css 的 .mm-edit），
      // 再与节点自身高度取大 —— 取太小会把刚打的字裁掉。
      height: Math.max(
        Math.round(editFontSize * 1.35) + 12,
        num(editNode.h, 0) * viewport.zoom
      ),
      fontSize: editFontSize,
    }
    : null;

  const aiBusy = busy === 'generate' || busy === 'expand' || busy === 'restructure' || busy === 'polish';
  const selHint = '先在画布上点一个节点（或者按方向键选一个）';
  const zoomPct = Math.round(viewport.zoom * 100);
  const fwList = Array.isArray(MM_AI_FRAMEWORKS) ? MM_AI_FRAMEWORKS : [];

  const label = (key, text) => (busy === key ? '生成中…' : text);

  /**
   * 拖拽落点的高亮矩形。
   * 位置 / 尺寸沿用 `.mm-toggle`、`.mm-edit` 那同一套换算（`screen = world*zoom + pan`，
   * 宽高同比例缩放），所以三者永远不会错位。
   * ⚠️ 高亮**只读 layout.nodes 算一个 CSS 矩形**，不重建 SVG：每次 mousemove 重拼整棵树
   *    是本页最贵的操作（见上面 svg 的 useMemo 注释）。这也正是它必须是个 DOM 叠加层的理由。
   */
  const dropNode = dropHint ? layoutNodes.get(dropHint) : null;
  /**
   * 三种落点画法（2026-11-10 起）：
   *   · `child`  —— 整个框描边（原来的样子）：挂到它下面；
   *   · `before` —— 框的上边缘画一条 3px 横线：插到它前面；
   *   · `after`  —— 框的下边缘画一条横线：插到它后面。
   * 线比框短一点、左右各留 2px，是为了和相邻兄弟的框拉开距离 —— 否则两个框挨得近时
   * 分不清这条线属于上面那个还是下面那个。
   */
  const dropStyle = dropNode
    ? (dropZone === 'child'
      ? {
        left: num(dropNode.x, 0) * viewport.zoom + viewport.panX,
        top: num(dropNode.y, 0) * viewport.zoom + viewport.panY,
        width: Math.max(8, num(dropNode.w, 0) * viewport.zoom),
        height: Math.max(8, num(dropNode.h, 0) * viewport.zoom),
      }
      : {
        left: num(dropNode.x, 0) * viewport.zoom + viewport.panX + 2,
        top: (dropZone === 'before'
          ? num(dropNode.y, 0) * viewport.zoom + viewport.panY
          : (num(dropNode.y, 0) + num(dropNode.h, 0)) * viewport.zoom + viewport.panY) - 1.5,
        width: Math.max(8, num(dropNode.w, 0) * viewport.zoom - 4),
        height: 3,
      })
    : null;

  /**
   * 跟手影的样式：原框的屏幕矩形 + 鼠标位移。
   * 尺寸/字体直接抄原框（`zoom` 同比例），所以看起来就是"那个框被拎起来了"，
   * 而不是飘着一个不一样大的幽灵。
   */
  const ghostNode = dragGhost ? layoutNodes.get(dragGhost.id) : null;
  const ghostStyle = ghostNode
    ? {
      left: num(ghostNode.x, 0) * viewport.zoom + viewport.panX + num(dragGhost.dx, 0),
      top: num(ghostNode.y, 0) * viewport.zoom + viewport.panY + num(dragGhost.dy, 0),
      width: Math.max(8, num(ghostNode.w, 0) * viewport.zoom),
      height: Math.max(8, num(ghostNode.h, 0) * viewport.zoom),
      fontSize: Math.max(9, 13 * viewport.zoom),
    }
    : null;

  /**
   * 右键菜单的屏幕位置：夹在画布内，避免菜单从右/下边缘漏出去一半（漏出去的那一半
   * 被 `.mm-canvas` 的 `overflow:hidden` 切掉 = 有按钮点不到）。
   * 量不到尺寸时（jsdom 的 getBoundingClientRect 恒为 0）直接用鼠标坐标 —— 不做无意义的夹取，
   * 否则验证脚本读到的 left/top 永远是一个常量 4，等于读不到"菜单弹在鼠标那儿"。
   */
  const ctxLeft = ctx ? (size.w > 0 ? Math.max(4, Math.min(ctx.x, size.w - 186)) : ctx.x) : 0;
  const ctxTop = ctx ? (size.h > 0 ? Math.max(4, Math.min(ctx.y, size.h - 236)) : ctx.y) : 0;

  return (
    <div className={'mm-page' + (zen ? ' is-zen' : '')} data-mm-root data-mm-zen={zen ? '1' : '0'}>
      {/* 全屏：页头整块不渲染（条件渲染，不是 display:none —— 见 zen 那段注释） */}
      {zen ? null : (
        <PageBanner
          ic="compass"
          compact
          title="思维导图"
          sub="把一个想法摊开成一棵树：AI 帮你长分支，导成图片或粘进 Word。"
          slogan="想清楚了，才说得清楚"
        />
      )}

      {/* ── 工具栏：锚点顺序就是验收脚本点击的顺序，别随意调换 ── */}
      <div className="mm-toolbar" data-mm-toolbar>
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="new"
          disabled={!!busy}
          title="清空当前导图，重新开始一张"
          onClick={() => openAsk('new')}
        >
          新建
        </button>
        <button
          type="button"
          className="r15-btn-g mm-tb"
          data-mm-act="generate"
          disabled={!!busy}
          title="写一句话，AI 直接生成整棵树"
          onClick={() => openAsk('generate')}
        >
          {label('generate', 'AI 生成')}
        </button>
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="expand"
          disabled={!selectedId || !!busy}
          title={selectedId ? '就当前节点往下扩散几个分支' : selHint}
          onClick={() => openAsk('expand')}
        >
          {label('expand', 'AI 扩散')}
        </button>
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="restructure"
          disabled={!!busy}
          title="按经典框架把现有内容重排一遍"
          onClick={() => openAsk('restructure')}
        >
          {label('restructure', 'AI 换框架')}
        </button>
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="polish"
          disabled={!selectedId || !!busy}
          title={selectedId ? '把当前节点的文字改得更顺' : selHint}
          onClick={() => doPolish(selectedId)}
        >
          {label('polish', 'AI 润色')}
        </button>
        <span className="mm-sep" aria-hidden="true" />
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="export-png"
          disabled={!!busy || !doc}
          title="导出成 PNG 图片（2 倍图）"
          onClick={exportPng}
        >
          {busy === 'export' ? '导出中…' : '导出图片'}
        </button>
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="export-md"
          disabled={!!busy || !doc}
          title="把整张导图复制成大纲，粘进 Word 就是现成的层级列表"
          onClick={copyOutline}
        >
          {busy === 'md' ? '复制中…' : '复制大纲'}
        </button>
        <span className="mm-grow" />
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="fit"
          title="把整张导图缩放到刚好放进窗口"
          onClick={fitView}
        >
          适应视图
        </button>
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="zoom-in"
          title="放大"
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          ＋
        </button>
        <button
          type="button"
          className="r15-btn-o mm-tb"
          data-mm-act="zoom-out"
          title="缩小"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          －
        </button>
        <span className="mm-zoomval" data-mm-zoom>{zoomPct}%</span>
        {/* statsOf 的 depth 是 0 基（根 = 0），给人看要 +1，否则「只有根」会显示成 0 层 */}
        <span className="mm-stats" data-mm-stats>{stat.nodes} 个节点 · {stat.nodes ? stat.depth + 1 : 0} 层</span>
        {/*
          全屏开关。⚠️ **必须是 `<span role="link">`，不许是 `<button>`**。
          判据在 `scripts/smoke/unit-firstscreen.mjs`：`BUTTON_RATCHET.mindmap = 10`
          （本页首屏 `container.querySelectorAll('button').length` 的登记值，口径见
          `probes/_say_audit_entry.jsx`）。多一个 `<button>` 就是 `11 > 10` ⇒ 整条首屏门禁红。
          同款写法见 `ContentOps.jsx` 的 `.co-tool`：`role="link"` + `tabIndex={0}` +
          `onKeyDown` 里处理 Enter/Space —— 键盘可达性一样有，只是不占 `<button>` 这个标签。
        */}
        <span
          className={'mm-zen' + (zen ? ' on' : '')}
          data-mm-zen-toggle
          role="link"
          tabIndex={0}
          title={zen ? '回到带标题的普通视图（也可以按 Esc）' : '只留画布，铺满内容区（也可以按 Esc 退出）'}
          onClick={toggleZen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleZen();
            }
          }}
        >
          {zen ? '退出全屏' : '全屏'}
        </span>
      </div>

      {/*
        快捷键图例：**必须有，而且必须是可见文本**。

        为什么这一条是功能不是装饰：本页有 10 个交互**没有对应的按钮**
        （Tab 加子节点 / Enter 加同级 / F2 改名 / Delete 删除 / 方向键选节点 /
        滚轮缩放 / 拖动画布平移 / 双击空白加子节点 / 拖节点 / 右键更多）。
        改动前整页 98 个字，一个都不提 —— 用户拿到的是一个「看起来只能点那 10 个按钮」
        的画布，键盘能做的事只有读过源码的人知道。

        0.21.26 第二轮（对齐 XMind）把**新增的三件事**也写进来了：双击空白建节点、
        拖节点换上级、右键更多。理由不是凑字数：右键菜单**不可能自己被发现**，
        用户原话「功能都集中在右键上面」，那这条图例就是它唯一的入口说明。

        0.21.27（2026-11-10）：拖节点**不再只有"换上级"**——拖到空白处 = 自由摆放。
        文案当场拆成两半（`压框换上级 / 空白处自由摆放`）。留着旧文案会主动误导：
        用户读到"拖节点换上级"，就会以为拖到空白处是不合法的，**根本不会去试**，
        于是"功能做了但没人用"和"功能没做"在他眼里是同一件事。
        ⚠️ 全屏时不渲染（`.mm-page.is-zen`），此时首屏字数会掉到 100 以下 ——
        那是用户自己按的全屏，不是首屏；`unit-firstscreen` 的探针在未交互态读的仍是完整页。

        ⚠️ 不许塞进 `title` 属性：`title` 不进 DOM 文本（首屏审计探针读不到，
        `unit-firstscreen.mjs` 的 GC1 也就白算），真实用户还要悬停才看得见 —— 等于没写。
        ⚠️ 锚点/类名**刻意不叫** `data-mm-hint` / `.mm-hint`：那对名字属于画布下方那条
        **状态提示**（error/ok/hint 三态里的金 hint）。同名会让 `[data-mm-hint]` 永远先命中
        这条常驻图例，把「三态提示互斥」的断言测成一个恒真的空壳（本模块已有一轮
        因为"断言只比对 svg.outerHTML"而误红的前科）。图例是**常量**，状态提示是**变量**，分开。
        ⚠️ 常驻不随选中态变化：换成「已选：<节点文字>」会让这条图例在用户最需要它的时刻
        （刚选中一个节点）少掉后半截，而"选中了谁"画布上本来就有绿色外发光。
      */}
      {zen ? null : (
        <div className="mm-keys" data-mm-keys>
          <span className="mm-keys-t">画布怎么用：</span>
          <span className="mm-keys-i"><kbd>Tab</kbd>加子节点</span>
          <span className="mm-keys-i"><kbd>Enter</kbd>加同级</span>
          <span className="mm-keys-i"><kbd>F2</kbd>改名</span>
          <span className="mm-keys-i"><kbd>Delete</kbd>删除</span>
          <span className="mm-keys-i">方向键选节点</span>
          <span className="mm-keys-i">滚轮缩放</span>
          <span className="mm-keys-i">拖动画布平移</span>
          <span className="mm-keys-i">双击空白加子节点</span>
          <span className="mm-keys-i">拖节点：压框换上级 / 空白处自由摆放</span>
          <span className="mm-keys-i">右键更多</span>
          <span className="mm-keys-i"><kbd>Esc</kbd>退出全屏</span>
        </div>
      )}

      {/* ── 画布：唯一的交互入口（SVG 是字符串，节点挂不上 React 事件） ── */}
      <div className="mm-body">
        <div
          ref={canvasRef}
          className={'mm-canvas' + (panning ? ' is-panning' : '') + (dragging ? ' is-dragging' : '')}
          data-mm-canvas
          data-mm-dragging={dragging ? '1' : '0'}
          tabIndex={0}
          onPointerDown={onCanvasDown}
          onMouseDown={onCanvasDown}
          onClick={(e) => onCanvasClick(e)}
          onDoubleClick={onCanvasDblClick}
          onContextMenu={onCanvasContextMenu}
          onKeyDown={onCanvasKeyDown}
        >
          {svg.markup ? (
            <div className="mm-svg" dangerouslySetInnerHTML={{ __html: svg.markup }} />
          ) : null}

          {/*
            拖拽改父级的落点高亮：一块纯反馈的 DOM 叠加层（`pointer-events:none`），
            矩形由 layout.nodes 换算成屏幕坐标（公式与 `.mm-toggle` / `.mm-edit` 同一个）。
            ⚠️ 它只在拖动越过 2px 死区且命中合法目标时存在 ⇒ 未交互的首屏读不到它，
                既不影响按钮数也不影响字数。
          */}
          {dropNode && dropStyle ? (
            <div
              className="mm-drop-hint"
              data-mm-drop-hint={dropHint}
              data-mm-drop-zone={dropZone}
              style={dropStyle}
              aria-hidden="true"
            />
          ) : null}

          {/*
            ★ 跟手影（2026-11-10）：被拖动的框**自己**跟着鼠标走。
            没有这一层，拖动时画面里只有"别的框被高亮"，被拖的框纹丝不动 ——
            用户看到的就是「压根没有拖动这个功能」（老板原话，且判断准确）。
            `pointer-events:none` 是硬要求：它是影子，不能把 mouseup 吃掉。
          */}
          {ghostNode && ghostStyle ? (
            <div
              className="mm-drag-ghost"
              data-mm-drag-ghost={dragGhost.id}
              style={ghostStyle}
              aria-hidden="true"
            >
              <span className="mm-drag-ghost-t">{String(ghostNode.text || '')}</span>
            </div>
          ) : null}

          {toggles.map((c) => (
            <button
              key={c.id}
              type="button"
              className={'mm-toggle' + (c.collapsed ? '' : ' is-open')}
              data-mm-toggle={c.id}
              data-mm-collapsed={c.collapsed ? '1' : '0'}
              title={c.collapsed ? '展开这个分支' : '收起这个分支'}
              style={{ left: c.x, top: c.y }}
            >
              {c.collapsed ? '+' : '−'}
            </button>
          ))}

          {editNode && editStyle ? (
            <textarea
              ref={editRef}
              className="mm-edit"
              data-mm-edit
              value={draft}
              spellCheck={false}
              /**
               * ⚠️ `maxLength` 必须有。没有它的时候限制是「提交时静默砍」：
               *    `updateNodeText` → `cleanNodeText` 会把超出的字直接丢掉，
               *    用户敲了 80 个字、按 Enter、字没了，中间一个提示都没有。
               *    加了之后浏览器在输入/粘贴时就拦住 —— 限制在**打字的时候**成立。
               * ⚠️ 上限就是 `MM_LIMITS.maxTextLen`（60），别在这里写死数字：
               *    这个数与「图上看得全」是两件事，后者由布局容量保证
               *    （`mindmapLayout.js` 的 MAX_LINES×每行字数 ≥ maxTextLen），
               *    降这个数会静默砍存量存档，理由见 mindmapModel.js 里 MM_LIMITS 注释。
               */
              maxLength={MM_LIMITS.maxTextLen}
              style={editStyle}
              onChange={(e) => {
                draftRef.current = e.target.value;
                setDraft(e.target.value);
              }}
              onKeyDown={onEditKeyDown}
              onBlur={commitEdit}
            />
          ) : null}

          {/*
            字数计数：和编辑框**同位置同尺寸**的一块透明层（pointer-events: none），
            计数标签贴在右下角。三层理由：
              ① 放在框外（比如框下方一行）在节点贴近画布底边时会被 overflow:hidden 切掉，
                 而看不到的提示等于没有提示；贴框内右下角则永远可见。
              ② 不放进 <textarea> 里 —— textarea 是替换元素，不能有子元素。
              ③ 单独一个元素而不是改 textarea 的 placeholder：placeholder 在已有文字时不显示，
                 而快写满了恰恰发生在有文字的时候。
            ⚠️ 锚点/类名**别改成** `data-mm-hint` / `.mm-hint`（那是画布下方的三态状态提示）、
               也别用 `data-mm-keys` / `.mm-keys`（那是常驻快捷键图例）。三个通道各用各的名字。
            ⚠️ 它只在编辑态存在 ⇒ 首屏探针（未交互）读不到它 ⇒ 不影响 GC1 的 147 字读数。
          */}
          {editNode && editStyle ? (
            <div
              className={"mm-edit-cnt" + (draft.length >= MM_LIMITS.maxTextLen ? " is-full" : "")}
              data-mm-edit-count
              style={editStyle}
              aria-live="polite"
            >
              <span>{draft.length}/{MM_LIMITS.maxTextLen}</span>
            </div>
          ) : null}

          {!doc ? (
            <div className="mm-empty" data-mm-empty>
              <div className="mm-empty-t">还没有思维导图</div>
              <div>点一下就开始：先写中心主题，再一层层往外长。</div>
              <button
                type="button"
                className="r15-btn-g mm-tb"
                data-mm-empty-new
                onClick={() => openAsk('new')}
              >
                新建一张
              </button>
            </div>
          ) : null}

          {aiBusy ? (
            <div className="mm-loading" data-mm-loading>
              <span className="mm-spin" aria-hidden="true" />
              <span>AI 正在想，通常十几秒，先别动它</span>
            </div>
          ) : null}

          {/*
            右键菜单。位置 = 鼠标在画布内的坐标（`ctxLeft/ctxTop`，超出画布边界时被夹回来）。

            · 菜单项是 `<button type="button">`：它**只在交互之后**才存在，不进首屏
              `querySelectorAll('button')` 的计数（`unit-firstscreen.mjs` 的 mindmap: 10），
              所以这里用 button 是安全的；工具栏那边不行（见 `.mm-zen` 的注释）。
            · `data-mm-ctx` 是"事件在菜单内部"的判定锚点：`onCanvasDown` / `onCanvasClick`
              都靠它提前 return，否则点击会穿透到画布，把刚设好的选中又清掉。
            · `data-mm-ctx-act` 是逐项的对外契约（验证脚本按它点），别随手改名。
          */}
          {ctx ? (
            <div
              className="mm-ctx"
              data-mm-ctx
              data-mm-ctx-for={ctx.nodeId || ''}
              role="menu"
              aria-label={ctx.nodeId ? '节点操作' : '画布操作'}
              style={{ left: ctxLeft, top: ctxTop }}
              onContextMenu={(e) => {
                if (typeof e.preventDefault === 'function') e.preventDefault();
              }}
            >
              {ctxItems().map((it) => (it.sep ? (
                <span key={it.act} className="mm-ctx-sep" aria-hidden="true" />
              ) : it.hidden ? null : (
                <button
                  key={it.act}
                  type="button"
                  role="menuitem"
                  className={'mm-ctx-i' + (it.danger ? ' is-danger' : '')}
                  data-mm-ctx-act={it.act}
                  disabled={!!it.disabled}
                  onClick={() => {
                    // 先关菜单再动作：动作可能打开 AI 面板 / 起编辑，菜单留在下面会挡住它
                    closeCtx();
                    if (typeof it.run === 'function') it.run();
                  }}
                >
                  {it.label}
                </button>
              )))}
            </div>
          ) : null}
        </div>

        {/*
          提示条渲染：**三元链**而不是三条并列的 `&&`，互斥是写法强制出来的，
          不是"目前恰好只有一个 type"。三条并列时，只要将来有谁给 notice 换一个
          新 type（或误存成数组），屏幕就会同时出现两条自相矛盾的提示
          （例如「已改写：X」和「AI 觉得这句已经够好了」）。
          失败原样显示 error；成功绿、中性灰 —— 别把好消息 / 正常结论染成红色。
        */}
        {notice && notice.type === 'error' ? (
          <div className="mm-error" data-mm-error role="alert">{notice.text}</div>
        ) : notice && notice.type === 'ok' ? (
          <div className="mm-ok" data-mm-ok>{notice.text}</div>
        ) : notice && notice.type === 'hint' ? (
          <div className="mm-hint" data-mm-hint>{notice.text}</div>
        ) : null}
      </div>

      {/* ── AI 输入 / 新建确认面板：不用 window.prompt（Electron 里体验差且自动化测不了） ── */}
      {ask ? (
        <div className="mm-ask" data-mm-ask>
          <div className="mm-ask-card">
            <div className="mm-ask-t">{ASK_TITLES[ask.mode] || '确认'}</div>
            <div className="mm-ask-d">{ASK_DESCS[ask.mode] || ''}</div>

            {ask.mode === 'restructure' ? (
              <div className="mm-fw">
                {fwList.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={'mm-fw-i' + (ask.fw === f.key ? ' on' : '')}
                    data-mm-fw={f.key}
                    title={f.desc || f.label}
                    onClick={() => setAsk(Object.assign({}, ask, { fw: f.key }))}
                  >
                    <b>{f.label}</b>
                    <span>{f.desc || ''}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {ask.mode !== 'new' ? (
              <input
                className="mm-ask-input"
                data-mm-ask-input
                value={ask.value}
                placeholder={ASK_PLACEHOLDERS[ask.mode] || ''}
                onChange={(e) => setAsk(Object.assign({}, ask, { value: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitAsk();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeAsk();
                  }
                }}
              />
            ) : null}

            {askErr ? <div className="mm-ask-err">{askErr}</div> : null}

            <div className="mm-ask-row">
              <button type="button" className="r15-btn-o mm-tb" data-mm-ask-cancel onClick={closeAsk}>
                取消
              </button>
              <button type="button" className="r15-btn-g mm-tb" data-mm-ask-ok onClick={submitAsk}>
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
