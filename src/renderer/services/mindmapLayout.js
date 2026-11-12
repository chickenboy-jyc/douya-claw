/**
 * mindmapLayout —— 思维导图的自动布局（纯函数，零 DOM；**不用 canvas measureText**）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么是「双向平衡树」而不是普通向右的大纲树】
 *   向右的树跟文件管理器没区别，"思维导图"要的是**根在中间、分支向两侧散开**。
 *   这一条是视觉特征，不是审美偏好：老板要的是"一眼看出这是一张图"。
 *   代价是纵向空间翻倍，所以一级分支必须**配平**（见 pickSides），否则一边空一边挤。
 *
 * 【为什么宽度靠字符估算，不量真实文字宽度】
 *   布局要能在 node 里直跑（单测、导出、AI 产物预览），canvas 只有浏览器有。
 *   中日韩按 1 个字宽、其余按 0.56 个字宽估算，误差落在 ±1 个字内，
 *   而节点左右各有 14px 内边距，这点误差看不出来。
 *   真正致命的不是精度，是"预览量了一遍、导出又量一遍"——两处不一致，导出的图会错位。
 *   一个纯函数、一份估算，两边必然一致。
 *
 * 【为什么坐标最后要整体平移】
 *   左右分组会让坐标出现负数。SVG 的 viewBox 从 0 开始，负坐标的节点会被裁掉。
 *   所以先在一个自由坐标系里算完，最后统一挪到 `pad` 起头 —— 比在每个节点上都加偏移量
 *   少一次"忘了加"的机会。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { indexDoc } from './mindmapModel.js';

export const MM_LAYOUT = Object.freeze({
  hGap: 56,
  vGap: 16,
  pad: 48,
  fontSize: 14,
  rootFontSize: 16,
  fontW: 600,
  lineH: 20,
  nodePadX: 14,
  nodePadY: 9,
  minW: 64,
  maxW: 220,
});

/**
 * 折行上限。超过就省略号 —— 导图上一个节点占 6 行就不是"节点"了，是段落。
 *
 * ⚠️ 为什么是 5 而不是 4：
 *   每行可用内宽 = maxW 220 − nodePadX 14×2 = **192px**，中文按 fontSize 14 量
 *   ⇒ 每行 13 字。`MM_LIMITS.maxTextLen` 是 60，13×4 = 52 **不够**，第 53~60 个字
 *   会被下面 `wrapLines` 的 `…` 分支吞掉；13×5 = **65 ≥ 60** 才够。
 *   注意 `maxTextLen` **不能**反过来降到 52：`normalizeDoc` 走 `cleanNodeText`，
 *   降上限等于降读存档的上限，会把存量 60 字节点静默砍成 52 并写回盘。
 *
 *   提到 5 只影响「本来就要 5 行」的节点（今天正是那批被截断的），
 *   1~4 行的存量节点行数、高度都不变。最坏高度 5×20 + 2×9 = 118px。
 *
 *   `charW()` 已改成按**实际字号**量（`charW(ch, fs)`，`fs` 从 `measureNode` 传下来），
 *   所以根本节点 16px ⇒ 每行 12 字，分支 14px ⇒ 每行 13 字：
 *     根   12×5 = **60，恰好等于 `maxTextLen`，余量 0**
 *     分支 13×5 = 65，余量 5
 *   这正是选 5 而不是 4 的原因：按 4 行算根只有 48，当场丢 12 个字。
 *
 *   ⚠️ 余量 0 是**合法但无缓冲**，不是故障：60 个字确实全看得见（②-b 的 join 逐字相同）。
 *      千万别把它「修」成正数 —— 唯一那条路是降 `maxTextLen`，而 `cleanNodeText`
 *      按它截断，降上限 = 降读存档上限 = 静默删存量（见上）。
 *
 *   ⚠️ 在 `charW` 参数化**之前**，根节点按 14 量却按 16 渲染：60 字被折成 13 字/行，
 *      最长行 13×16 = 208px 塞进 192px 内宽，单侧内边距从名义 14 被吃到 6，
 *      而 `w` 被 `clamp` 钳在 `maxW=220` 上，**44 条断言全绿**。今天由
 *      `unit-mindmap-layout.mjs` 的「折行预算」断言守这一条。
 *
 * ⚠️ 刻意**不导出**：这是布局的内部取舍，产品层没有第二个地方该读它。
 *    `scripts/smoke/unit-mindmap-layout.mjs` 里那三处断言写死字面 5 ——
 *    改成 import 这个常量会让它们变成「常量跟自己比」的恒真式，等于删掉断言。
 */
const MAX_LINES = 5;

/** 中日韩字符（含全角标点）按 1 个字宽，其余按 0.56（拉丁字母的通行均值）。 */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\u3040-\u30ff]/;

/**
 * 一个字占多宽。`fs` 是**该层实际的字号**，必须由调用方传下来。
 *
 * ⚠️ 为什么不再是「恒按 MM_LAYOUT.fontSize」：根节点按 rootFontSize(16) 渲染、
 *    却按 14 量字 ⇒ 每行多塞 1 个字（13 而不是 12），最长行 208px 塞进 192px 内宽，
 *    内边距被吃到 6px，而 `w` 恰好被 clamp 钳在 maxW 上 —— 肉眼看不出、断言也看不出。
 *
 * ⚠️ 也不许改成模块级可变变量（`let CUR_FS`）再临时赋值：那是个**必须手动复原**的
 *    全局量，`wrapLines` 里一旦抛异常就永久停在 16，同进程后续所有折行静默按 16 算。
 *    参数传参没有这个失败态。
 */
function charW(ch, fs) {
  return CJK_RE.test(ch) ? fs : fs * 0.56;
}

function textW(str, fs) {
  let w = 0;
  for (const ch of Array.from(str)) w += charW(ch, fs);
  return w;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * 按字符折行。中日韩逐字可断；ASCII 优先在空格断（不把英文单词劈成两半）。
 * 行数超过 MAX_LINES 时只留 MAX_LINES 行，末行末尾补 `…`。
 * 这个 `…` 分支对**手改过的存档 / 将来放宽 maxTextLen** 仍是必要防线，
 * 正常输入路径（≤ maxTextLen 个字）走不到它 —— 走得到就是容量算错了。
 */
function wrapLines(text, avail, fs) {
  const src = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!src) return [''];
  const lines = [];
  let cur = '';
  let curW = 0;
  for (const ch of Array.from(src)) {
    const w = charW(ch, fs);
    if (cur && curW + w > avail) {
      const sp = cur.lastIndexOf(' ');
      // 空格后面还有英文/数字 ⇒ 在那个空格断，别把单词切开
      if (sp > 0 && /[A-Za-z0-9]/.test(cur.charAt(sp + 1))) {
        lines.push(cur.slice(0, sp));
        cur = cur.slice(sp + 1) + ch;
        curW = textW(cur, fs);
      } else {
        lines.push(cur);
        cur = ch;
        curW = w;
      }
    } else {
      cur += ch;
      curW += w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= MAX_LINES) return lines;
  const kept = lines.slice(0, MAX_LINES);
  let last = kept[MAX_LINES - 1];
  while (last.length > 1 && textW(last + '…', fs) > avail) last = last.slice(0, -1);
  kept[MAX_LINES - 1] = last + '…';
  return kept;
}

/**
 * 量一个节点。返回 { w, h, lines }。
 * zh: 根字号比子节点大一号（16 / 14），这是"根在中间"的视觉支撑之一。
 *
 * ⚠️ 折行和宽度必须用**同一个** `fs`：折行按 14 量、宽度按 16 算，等于折行时以为
 *    一行装得下、渲染时超出内宽；反过来（折行按 16、宽度按 14）会白窄一截。
 */
export function measureNode(text, depth = 1) {
  const fs = depth === 0 ? MM_LAYOUT.rootFontSize : MM_LAYOUT.fontSize;
  const avail = MM_LAYOUT.maxW - MM_LAYOUT.nodePadX * 2;
  const lines = wrapLines(text, avail, fs);
  let maxLineW = 0;
  for (const l of lines) {
    maxLineW = Math.max(maxLineW, textW(l, fs));
  }
  const w = clamp(Math.ceil(maxLineW) + MM_LAYOUT.nodePadX * 2, MM_LAYOUT.minW, MM_LAYOUT.maxW);
  const h = lines.length * MM_LAYOUT.lineH + MM_LAYOUT.nodePadY * 2;
  return { w, h, lines, fontSize: fs };
}

/** 把坐标压到 2 位小数：SVG 字符串短一截，肉眼等价。 */
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * 一级分支配平：按 order 顺序遍历，谁当前更轻就放谁那边（贪心）。
 * 「更轻」按**子树总高**算，不是按节点数 —— 一个 8 个字的节点和一个 3 层子树，
 * 占的高度差好几倍，按节点数配平会直接把图压歪。
 *
 * 平手时先给右边：只有一个一级分支的场景（最常见）必须落在右侧，
 * 否则单分支的图会跑到根左边，看着像弄反了。
 */
function pickSides(rootKids, subH) {
  const left = [];
  const right = [];
  let lh = 0;
  let rh = 0;
  for (const k of rootKids) {
    const h = subH(k.id);
    if (rh <= lh) {
      right.push(k);
      rh += h + MM_LAYOUT.vGap;
    } else {
      left.push(k);
      lh += h + MM_LAYOUT.vGap;
    }
  }
  return { left, right };
}

/**
 * 主入口。返回 { nodes, edges, bbox }。
 *
 * 边界全部在这里兜住（不许死循环、不许 NaN）：
 *   · doc.nodes 为空 ⇒ 三个空数组式结果；
 *   · 折叠节点 ⇒ 自己的高度照占，子树完全不进布局；
 *   · parentId 指向不存在的节点 / 父子成环 ⇒ indexDoc 已把它们拍平到根下，
 *     这里再叠一层 seen 集合，任何遍历都不可能在环上转第二圈。
 */
export function layoutDoc(doc, opts = {}) {
  const idx = indexDoc(doc);
  const empty = { nodes: [], edges: [], bbox: { x: 0, y: 0, w: 0, h: 0 } };
  if (!idx.rootId) return empty;

  const L = { ...MM_LAYOUT, ...(opts && typeof opts === 'object' ? opts : {}) };
  const metrics = new Map();
  for (const [id, node] of idx.byId) {
    const depth = idx.depthOf.get(id) || 0;
    const m = measureNode(node.text, depth);
    metrics.set(id, { ...m, depth, color: Math.min(4, Math.max(0, depth)) });
  }

  // ── 后序算子树总高（含自身），Map 缓存 ⇒ O(n) ──────────────────────────
  const subH = new Map();
  const visiting = new Set();
  const calcSubH = (id) => {
    if (subH.has(id)) return subH.get(id);
    if (visiting.has(id)) return metrics.get(id).h; // 环兜底：当成叶子
    visiting.add(id);
    const node = idx.byId.get(id);
    const m = metrics.get(id);
    const kids = node && node.collapsed ? [] : idx.childrenOf[id] || [];
    let total = 0;
    kids.forEach((k, i) => {
      total += calcSubH(k.id);
      if (i) total += L.vGap;
    });
    const h = Math.max(m.h, total);
    visiting.delete(id);
    subH.set(id, h);
    return h;
  };
  // 先把所有子树高度算出来再排版：后面配平和摆位都只是查表，
  // 少一次"忘了先算"就会拿到 undefined，坐标全变 NaN（踩过）。
  for (const id of idx.byId.keys()) calcSubH(id);

  // ── 分配坐标 ────────────────────────────────────────────────────────────
  const pos = new Map();
  const seen = new Set();
  const place = (id, centerY, side, x) => {
    if (seen.has(id)) return; // 环 / 重复引用兜底
    seen.add(id);
    const m = metrics.get(id);
    const node = idx.byId.get(id);
    pos.set(id, { x, y: centerY - m.h / 2, side });
    const kids = node && node.collapsed ? [] : idx.childrenOf[id] || [];
    if (!kids.length) return;
    const total = kids.reduce((s, k, i) => s + subH.get(k.id) + (i ? L.vGap : 0), 0);
    let cursor = centerY - total / 2;
    for (const k of kids) {
      const kh = subH.get(k.id);
      const km = metrics.get(k.id);
      const kx = side === 'left' ? x - L.hGap - km.w : x + m.w + L.hGap;
      place(k.id, cursor + kh / 2, side, kx);
      cursor += kh + L.vGap;
    }
  };

  const rootId = idx.rootId;
  const rootM = metrics.get(rootId);
  const rootNode = idx.byId.get(rootId);
  const rootKids = rootNode && rootNode.collapsed ? [] : idx.childrenOf[rootId] || [];
  const { left, right } = pickSides(rootKids, (id) => subH.get(id));

  pos.set(rootId, { x: 0, y: -rootM.h / 2, side: 'root' });
  seen.add(rootId);
  const stackGroup = (group, side) => {
    if (!group.length) return;
    const total = group.reduce((s, k, i) => s + subH.get(k.id) + (i ? L.vGap : 0), 0);
    let cursor = -total / 2;
    for (const k of group) {
      const kh = subH.get(k.id);
      const km = metrics.get(k.id);
      const kx = side === 'left' ? -L.hGap - km.w : rootM.w + L.hGap;
      place(k.id, cursor + kh / 2, side, kx);
      cursor += kh + L.vGap;
    }
  };
  stackGroup(right, 'right');
  stackGroup(left, 'left');

  // ── 整体平移到正数区间（bbox 左上角 = pad）──────────────────────────────
  let minX = Infinity;
  let minY = Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  const dx = L.pad - minX;
  const dy = L.pad - minY;

  /**
   * ★★ 手拖位置覆盖（2026-11-10）——「随意拼凑」的实现点。
   *
   * 【为什么要改这里，而不是在 UI 里加个 transform】
   *   老板原话：「子框还是无法拖动……自然就无法随意拼凑了」。
   *   排查结论：拖拽手势是通的（能改父子关系），但**拖到空白处一律拒绝**
   *   （"拖到某个框上才会移动"），所以永远拼不出自己想要的版式。
   *   而 `normalizeDoc` 里其实**早就有 `x`/`y` 字段**（`makeNode` 也建了），
   *   只是本函数从来没读它 —— 一个"算出来了但没人读"的死字段（本仓明确的历史事故类型）。
   *
   * 【口径：doc 里的 x/y 是**世界坐标**，不是相对偏移】
   *   取舍过一次：用"相对布局位置的 offset"实现更省事（拖拽的位移量可以直接累加），
   *   但它有个致命手感问题 —— 增删节点会让树重新排版，手拖过的框会**跟着漂走**
   *   （基准变了），用户会觉得"我刚摆好的怎么又乱了"。
   *   存世界坐标则相反：结构怎么变，我摆的那一版原地不动。这才是「拼凑」的语义。
   *
   * 【为什么不会漂移（这是上一版不敢做的地方）】
   *   `dx/dy` 只由**树布局**的 pos 算出来（上面那段），不含手拖节点。
   *   于是换算关系是纯线性的：`内部坐标 = 世界坐标 - dx`，输出时 `+dx` 又还原。
   *   结构变了 ⇒ dx 变了 ⇒ 内部坐标跟着变 ⇒ **世界坐标恒定**。这正是要的效果。
   *
   * 【为什么 pinned 节点仍参与 bbox】
   *   下面的 bbox 用输出后的 `n.x/n.y` 算，所以拖到远处的框会被算进边界里，
   *   「适应窗口」不会把它切出画外。
   */
  for (const [id, p] of pos) {
    const n = idx.byId.get(id);
    if (!n) continue;
    // 根不认手拖：根被拖走等于整张图丢了参照系（模型层也不允许移动根）。
    if (id === rootId) continue;
    /**
     * ⚠️ 必须用 `typeof === 'number'` 判，**不能**用 `Number(n.x)` + `isFinite`。
     *   `Number(null) === 0` 且 `Number.isFinite(0) === true` ⇒ 每一个「没被拖过」
     *   的节点（`x: null`）都会被当成"钉在 (0,0)"，全部挤到画布左上角叠成一坨。
     *   这个坑当场踩过：49 条布局门禁一次红了 5 条，症状是"一级子节点全在左边、
     *   bbox 变成 0、边从错误的位置出发" —— 看起来像布局算法坏了，其实是 null 变成了 0。
     */
    if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    p.x = n.x - dx;
    p.y = n.y - dy;
    p.pinned = true;
  }

  const nodes = [];
  for (const [id, p] of pos) {
    const m = metrics.get(id);
    const node = idx.byId.get(id);
    nodes.push({
      id,
      x: r2(p.x + dx),
      y: r2(p.y + dy),
      w: m.w,
      h: m.h,
      lines: m.lines,
      depth: m.depth,
      side: p.side,
      color: m.color,
      text: node ? node.text : '',
      note: node ? node.note || '' : '',
      collapsed: !!(node && node.collapsed),
      childCount: (idx.childrenOf[id] || []).length,
      // 这一框是不是被手拖过（世界坐标被钉住）。UI 用它给个视觉提示，
      // 也让「归位」这一项知道该不该出现 —— 判据只在这一处算，别让 UI 自己再查一遍 doc。
      pinned: p.pinned === true,
    });
  }

  // ── 连线 ────────────────────────────────────────────────────────────────
  // 从父的**哪一侧**出发，取决于子在父的左边还是右边（用中心 x 判，而不是
  // 用 side 字段：手拖过的节点可能跨过父的中线，那时贴边出发才不难看）。
  const edges = [];
  for (const n of nodes) {
    const node = idx.byId.get(n.id);
    if (!node || node.collapsed) continue;
    for (const k of idx.childrenOf[n.id] || []) {
      const c = pos.get(k.id);
      const cm = metrics.get(k.id);
      if (!c) continue;
      const pCx = n.x + n.w / 2;
      const cCx = c.x + dx + cm.w / 2;
      const toRight = cCx >= pCx;
      const x1 = toRight ? n.x + n.w : n.x;
      const x2 = toRight ? c.x + dx : c.x + dx + cm.w;
      const y1 = n.y + n.h / 2;
      const y2 = c.y + dy + cm.h / 2;
      const mx = x1 + (x2 - x1) / 2;
      edges.push({
        fromId: n.id,
        toId: k.id,
        fromX: r2(x1),
        fromY: r2(y1),
        toX: r2(x2),
        toY: r2(y2),
        path: 'M ' + r2(x1) + ' ' + r2(y1) + ' C ' + r2(mx) + ' ' + r2(y1) + ' ' + r2(mx) + ' ' + r2(y2) + ' ' + r2(x2) + ' ' + r2(y2),
      });
    }
  }

  let bx1 = Infinity;
  let by1 = Infinity;
  let bx2 = -Infinity;
  let by2 = -Infinity;
  for (const n of nodes) {
    bx1 = Math.min(bx1, n.x);
    by1 = Math.min(by1, n.y);
    bx2 = Math.max(bx2, n.x + n.w);
    by2 = Math.max(by2, n.y + n.h);
  }
  const bbox = nodes.length
    ? { x: r2(bx1), y: r2(by1), w: r2(bx2 - bx1), h: r2(by2 - by1) }
    : { x: 0, y: 0, w: 0, h: 0 };

  return { nodes, edges, bbox };
}
