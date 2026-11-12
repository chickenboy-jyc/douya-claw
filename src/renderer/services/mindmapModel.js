/**
 * mindmapModel —— 思维导图的数据模型（纯函数，零 DOM / 零 React / 零本地存储）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么是「扁平数组 + parentId」，不是嵌套 children】
 *   本地存储的读写、增量改一个节点、AI 产物归一，这三件事在嵌套结构上都是
 *   整棵树重建；扁平数组只要 `[...nodes, newOne]`。仓库里任务/子任务
 *   （`store/companyStore.jsx` 的 taskTree）已经是这个口径，不再造第二种。
 *
 * 【为什么每个函数都不改入参、只返回新 doc】
 *   界面侧要能「试一下再决定要不要采用」（比如 AI 加了一批节点前先算一遍是否超限）。
 *   就地改会让失败路径留下半棵脏树 —— 那是最难查的一类 bug。
 *
 * 【为什么所有限额都在这里，而不是在界面上拦】
 *   界面拦只能拦住"人点的"，AI 产物、本地存储里的旧数据、导入的文件
 *   全都绕过界面。限额只有落在模型层才是真的。
 *
 * 【为什么 normalizeDoc 不按 maxDepth 截断】
 *   它是「读用户已存的东西」，截断 = 静默删数据。深度限额只在**新增**路径
 *   （addChild / moveNode）上生效，AI 产物那条路走 addChild 自然受限。
 *   用户自己存的畸形深树，宁可照原样显示，也不要打开文件就少了一半。
 * ════════════════════════════════════════════════════════════════════════════
 */

export const MM_SCHEMA_VERSION = 1;

/**
 * 硬限额。全部在下面的函数里真的生效（不是摆着给 UI 读的常量）：
 *   · maxNodes      —— addChild / addChildren 达到上限直接失败；
 *   · maxDepth      —— 新节点的层级 > maxDepth 就失败（根 = 0 层，即最多 6 层）；
 *   · maxTextLen    —— 任何入口的文字都截断到这个长度，不许溢出到布局；
 *   · maxBranches   —— **根**的直接子节点上限（一级分支数量）。
 */
export const MM_LIMITS = Object.freeze({
  maxNodes: 300,
  maxDepth: 5,
  /**
   * ⚠️ **这个数是「存得下多少」，不是「图上看得见多少」。后者由布局容量保证。**
   *
   * 曾经差点把它从 60 降到 52（0.21.26，为修 ver-mm-live 报的「60 字静默截断」），
   * **实测否决**：`normalizeDoc` 对每个节点都走 `cleanNodeText`，而 `cleanNodeText`
   * 按这个上限截断 ⇒ **降上限 = 降读存档的上限**。存量用户盘里 60 字的节点，
   * 升级后读进来只剩 52 字（丢 8 个），下一次 `saveDoc` 把截断写回盘，不可恢复。
   * 这跟「normalizeDoc 按 maxDepth 截断」是同一类错：少一条还能补，错一条难查。
   *
   * 正确的修法是**加布局容量**，不是降这个数：`mindmapLayout.js` 的 MAX_LINES
   * 从 4 提到 5 ⇒ 中文每行 13 字 × 5 行 = **65 ≥ 60**，60 字中文一个都不丢。
   * MAX_LINES 只在行数超过它时才起作用，所以提到 5 **只影响「本来就要 5 行」的
   * 那批节点**（即今天被 `…` 截断的 53~60 字节点），1~4 行的存量节点一行不变、
   * 高度一分不涨。相比之下降上限是**全局降限**，还顺带把英文从 60 砍到 52。
   *
   * ⇒ **以后容量不够就加 MAX_LINES / 放宽 maxW，不许动这个数。**
   *    真要动这里，得先给老存档一条不截断的迁移路径，否则就是静默删数据。
   *
   * 这条约束由 `scripts/smoke/unit-mindmap-layout.mjs` **单边**锁住：
   *   · 布局容量必须 **≥** 这个数（写进去就看得全）；
   *   · 用「容量 + 1」个字必须出现 `…`（证明容量确实是那么大，不是恒真）。
   *   故意**不**写成「容量 === 上限」：那会强迫上限跟着布局参数变，
   *   布局一改窄就又要降上限 ⇒ 又回到删存量。
   */
  maxTextLen: 60,
  maxBranches: 12,
});

/** 空白合并 + 首尾裁剪 + 按 maxTextLen 截断。模型层唯一的文字清洗入口。 */
export function cleanNodeText(v) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return t.length > MM_LIMITS.maxTextLen ? t.slice(0, MM_LIMITS.maxTextLen) : t;
}

/** 生成一个带前缀的 id。`mindmapModel` 内部只用它做 doc id，节点 id 走 allocNodeId。 */
let __seq = 0;
export function genId(prefix = 'n') {
  __seq = (__seq + 1) % 46656; // 36^3，够一轮时间戳内不撞
  return prefix + '-' + Date.now().toString(36) + __seq.toString(36).padStart(3, '0');
}

/**
 * 分配节点 id：扫描现有 id 里 `n<数字>` 的最大值 +1。
 * 刻意不用时间戳 —— 节点 id 会进 SVG 的 `data-node-id`、单测夹具和报错文案，
 * 可读的短 id 排查起来便宜得多；撞号由 while 循环兜住。
 */
function allocNodeId(nodes) {
  let max = -1;
  for (const n of nodes) {
    const m = /^n(\d+)$/.exec(String(n && n.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  let id = 'n' + (max + 1);
  const used = new Set(nodes.map((n) => n && n.id));
  while (used.has(id)) id = 'n' + (Number(id.slice(1)) + 1);
  return id;
}

/** 新的空节点。x/y = null 表示"没被手动拖过，跟着自动布局走"。 */
function makeNode(id, parentId, order, text) {
  return { id, parentId, order, text, note: '', collapsed: false, x: null, y: null, color: null };
}

/**
 * 读一个"手摆坐标"：只有**真的是数字**才认，其余（null / undefined / 字符串 / NaN /
 * Infinity）一律回 `null`（= 没被拖过）。
 *
 * ⚠️ 这一个函数专门用来堵 `Number(null) === 0`。
 *   `Number.isFinite(Number(v))` 这种写法看着像校验，实际上把 `null`、`''`、`false`
 *   全都"洗"成合法的 0 —— 于是"未设置"和"钉在坐标 0"在数据上再也分不出来。
 *   本仓踩过两次（layout 覆盖循环 + normalizeDoc），第二次的症状是**全部子框叠在左上角**。
 */
function posOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 建一份只有根节点的文档。根的文字就是标题（导图里根 = 主题）。 */
export function createDoc(title) {
  const text = cleanNodeText(title) || '中心主题';
  const now = new Date().toISOString();
  return {
    schemaVersion: MM_SCHEMA_VERSION,
    id: genId('mm'),
    title: text,
    rootId: 'n0',
    nodes: [makeNode('n0', null, 0, text)],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 任何外部数据（本地存储、AI 产物、导入文件）进模型前都必须先过这里。
 * 非法输入返回 null（不抛）：调用方只需判空，不必写 try/catch。
 *
 * 它负责四件脏活：
 *   ① id 缺失 / 重复 ⇒ 补一个不撞的；
 *   ② rootId 丢失或指向不存在的节点 ⇒ 挑一个当根；
 *   ③ parentId 指向不存在的节点 / 指向自己 ⇒ 挂到根下（不是丢弃，丢弃等于删数据）；
 *   ④ 父子成环（A.parent=B、B.parent=A）⇒ 断开成根的子节点，否则先序遍历会死循环。
 */
export function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : null;
  if (!rawNodes || rawNodes.length === 0) return null;

  const picked = rawNodes.slice(0, MM_LIMITS.maxNodes);
  const used = new Set();
  const nodes = picked.map((n, i) => {
    const src = n && typeof n === 'object' ? n : {};
    let id = typeof src.id === 'string' ? src.id.trim() : '';
    if (!id || used.has(id)) {
      id = 'n' + i;
      while (used.has(id)) id = id + '_';
    }
    used.add(id);
    return {
      id,
      parentId: typeof src.parentId === 'string' && src.parentId ? src.parentId : null,
      order: Number.isFinite(Number(src.order)) ? Number(src.order) : i,
      text: cleanNodeText(src.text),
      note: String(src.note == null ? '' : src.note),
      collapsed: src.collapsed === true,
      // ⚠️ 必须 `typeof === 'number'` 判，**不能**写 `Number.isFinite(Number(src.x))`。
      //   `Number(null) === 0` 且 `Number.isFinite(0) === true` ⇒ 每一个「从没被拖过」
      //   的节点（`x: null` / 字段缺失）都会被改写成 `0`，等于"钉在世界原点"。
      //   下游 mindmapLayout 的手拖覆盖读到它，就把全部子节点叠到 (0,0)：
      //   症状是"只有根框位置对、其余全挤在左上角、拖也拖不动"（真踩过，见 0.21.27）。
      x: posOrNull(src.x),
      y: posOrNull(src.y),
      color: src.color == null ? null : src.color,
    };
  });

  // ② 选根：优先认声明，其次第一个"没有爹"的，最后退到第一个节点。
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let rootId = typeof raw.rootId === 'string' && byId.has(raw.rootId) ? raw.rootId : null;
  if (!rootId) {
    const orphan = nodes.find((n) => !n.parentId || !byId.has(n.parentId) || n.parentId === n.id);
    rootId = orphan ? orphan.id : nodes[0].id;
  }
  byId.get(rootId).parentId = null;

  // ③ 断悬空父
  for (const n of nodes) {
    if (n.id === rootId) continue;
    if (!n.parentId || n.parentId === n.id || !byId.has(n.parentId)) n.parentId = rootId;
  }

  // ④ 断环：从每个节点往上走，走回自己就改挂到根。
  //    步数上限用节点数兜底（理论上到不了，但脏数据什么都可能有）。
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  for (const n of nodes) {
    if (n.id === rootId) continue;
    let cur = parentOf.get(n.id);
    let steps = 0;
    let looped = false;
    while (cur && cur !== rootId && steps <= nodes.length) {
      if (cur === n.id) {
        looped = true;
        break;
      }
      cur = parentOf.get(cur);
      steps += 1;
    }
    if (looped || steps > nodes.length) parentOf.set(n.id, rootId);
  }
  for (const n of nodes) n.parentId = parentOf.get(n.id);

  const title = cleanNodeText(raw.title) || byId.get(rootId).text || '未命名导图';
  const root = byId.get(rootId);
  if (!root.text) root.text = title;

  return {
    schemaVersion: MM_SCHEMA_VERSION,
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId('mm'),
    title,
    rootId,
    nodes,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

/**
 * 建邻接索引。**布局、SVG、折叠都靠它**，避免各自再写一份遍历。
 *
 * 比 normalizeDoc 更狠的地方：把「从根走不到」的节点（悬空父、成环）直接重挂到根。
 * 因为布局是「从根开始往下画」的，走不到的节点画不出来 —— 与其让它们消失，
 * 不如拍平到一级分支上，用户至少还看得见、能删。
 */
export function indexDoc(doc) {
  const nodes = doc && Array.isArray(doc.nodes) ? doc.nodes.filter((n) => n && typeof n.id === 'string') : [];
  const byId = new Map();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);

  let rootId = doc && typeof doc.rootId === 'string' && byId.has(doc.rootId) ? doc.rootId : null;
  if (!rootId) {
    const orphan = [...byId.values()].find((n) => !n.parentId || !byId.has(n.parentId) || n.parentId === n.id);
    rootId = orphan ? orphan.id : byId.size ? byId.keys().next().value : null;
  }

  /** 原始父指针（已修悬空/自指），环留到下面按「从根可达」统一处理。 */
  const parentOf = new Map();
  for (const [id, n] of byId) {
    if (id === rootId) parentOf.set(id, null);
    else if (!n.parentId || n.parentId === id || !byId.has(n.parentId)) parentOf.set(id, rootId);
    else parentOf.set(id, n.parentId);
  }

  // 先从根做一遍可达性（只看原始父指针），走不到的一律改挂根
  const childrenOfRaw = {};
  for (const [id, p] of parentOf) {
    if (p == null) continue;
    if (!childrenOfRaw[p]) childrenOfRaw[p] = [];
    childrenOfRaw[p].push(id);
  }
  const reachable = new Set();
  if (rootId) {
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const c of childrenOfRaw[id] || []) stack.push(c);
    }
    for (const id of byId.keys()) if (!reachable.has(id)) parentOf.set(id, rootId);
  }

  const childrenOf = {};
  for (const [id, p] of parentOf) {
    if (p == null) continue;
    if (!childrenOf[p]) childrenOf[p] = [];
    childrenOf[p].push(byId.get(id));
  }
  for (const k of Object.keys(childrenOf)) {
    childrenOf[k].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)));
  }

  const depthOf = new Map();
  if (rootId) {
    const queue = [[rootId, 0]];
    const seen = new Set();
    while (queue.length) {
      const [id, d] = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      depthOf.set(id, d);
      for (const c of childrenOf[id] || []) queue.push([c.id, d + 1]);
    }
  }
  return { byId, rootId, childrenOf, depthOf };
}

/** 新增一个子节点。不改入参；超限额/父不存在/文字为空都返回 ok:false 而不是静默成功。 */
export function addChild(doc, parentId, text) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return { ok: false, doc, error: '导图数据不完整，没法新增节点。' };
  const idx = indexDoc(base);
  const parent = idx.byId.get(String(parentId == null ? '' : parentId));
  if (!parent) return { ok: false, doc: base, error: '找不到要挂载的父节点。' };
  const t = cleanNodeText(text);
  if (!t) return { ok: false, doc: base, error: '节点文字不能为空。' };
  if (base.nodes.length >= MM_LIMITS.maxNodes) {
    return { ok: false, doc: base, error: `一张图最多 ${MM_LIMITS.maxNodes} 个节点，先删掉一些再加。` };
  }
  const depth = (idx.depthOf.get(parent.id) || 0) + 1;
  if (depth > MM_LIMITS.maxDepth) {
    return { ok: false, doc: base, error: `最多 ${MM_LIMITS.maxDepth} 层，这一支已经到底了。` };
  }
  const siblings = idx.childrenOf[parent.id] || [];
  if (parent.id === idx.rootId && siblings.length >= MM_LIMITS.maxBranches) {
    return { ok: false, doc: base, error: `一级分支最多 ${MM_LIMITS.maxBranches} 条。` };
  }
  const order = siblings.reduce((m, s) => Math.max(m, Number(s.order) || 0), -1) + 1;
  const node = makeNode(allocNodeId(base.nodes), parent.id, order, t);
  return {
    ok: true,
    doc: { ...base, nodes: [...base.nodes, node], updatedAt: new Date().toISOString() },
    nodeId: node.id,
  };
}

/**
 * 批量新增。逐个走 addChild —— 一次算好 order 的收益在 ≤12 条一级分支上不值一提，
 * 而「顺序严格递增、部分失败能返回已加的 id」这个契约更值钱。
 */
export function addChildren(doc, parentId, texts) {
  const list = (Array.isArray(texts) ? texts : []).map(cleanNodeText).filter(Boolean);
  if (!list.length) return { ok: false, doc, nodeIds: [], error: '没有可用的节点文字。' };
  let cur = doc;
  const nodeIds = [];
  let lastError = '';
  for (const t of list) {
    const r = addChild(cur, parentId, t);
    if (!r.ok) {
      lastError = r.error;
      break;
    }
    cur = r.doc;
    nodeIds.push(r.nodeId);
  }
  if (!nodeIds.length) return { ok: false, doc, nodeIds: [], error: lastError || '新增失败。' };
  return { ok: true, doc: cur, nodeIds };
}

export function updateNodeText(doc, id, text) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return { ok: false, doc, error: '导图数据不完整。' };
  const target = base.nodes.find((n) => n && n.id === id);
  if (!target) return { ok: false, doc: base, error: '找不到这个节点。' };
  const t = cleanNodeText(text);
  if (!t) return { ok: false, doc: base, error: '节点文字不能为空（想清空请直接删节点）。' };
  if (t === target.text) return { ok: true, doc: base };
  const nodes = base.nodes.map((n) => (n && n.id === id ? { ...n, text: t } : n));
  const next = { ...base, nodes, updatedAt: new Date().toISOString() };
  // 根的文字同步到 title：导出 Markdown 的第一行取 title，不同步会出现「标题还是旧的」
  if (id === base.rootId) next.title = t;
  return { ok: true, doc: next };
}

/** 连子孙一起删。**删根一律失败** —— 根没了整棵树就没有锚点了。 */
export function removeSubtree(doc, id) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return { ok: false, doc, removed: 0, error: '导图数据不完整。' };
  const idx = indexDoc(base);
  if (!idx.byId.has(id)) return { ok: false, doc: base, removed: 0, error: '找不到这个节点。' };
  if (id === idx.rootId) return { ok: false, doc: base, removed: 0, error: '根节点不能删除。' };
  const doomed = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (doomed.has(cur)) continue;
    doomed.add(cur);
    for (const c of idx.childrenOf[cur] || []) stack.push(c.id);
  }
  const nodes = base.nodes.filter((n) => !doomed.has(n && n.id));
  return {
    ok: true,
    doc: { ...base, nodes, updatedAt: new Date().toISOString() },
    removed: base.nodes.length - nodes.length,
  };
}

/**
 * 拖拽落点 → 「挂到谁下面 + 插在第几位」。
 *
 * 【规则变更记录：2026-11-10 由「唯一落点」改为「自由落点」】
 *   上一版（2026-11-09）只有唯一合法落点 = 祖父（一级分支则为主拼图），
 *   出处是当时那句「不许随意拼接」。实测结果是：**按住一个框基本拖不动** ——
 *   用户瞄准的永远是"想挂上去的那个框"，而唯一落点偏偏是它祖父，
 *   于是十次有九次落在画布上，只弹一句"只能拖到上一级"。
 *   现在的口径（老板原话）：「A-B-C 这个 C 可以拖到 A 后面、与 B 平行这样自由」。
 *   即：**任意节点都可以当父级**，并且可以在兄弟之间定点插入。
 *
 * 落点由 UI 按「鼠标落在目标框的哪一段」判定，这里只认三种意图：
 *   · `child`  —— 挂到目标下面，排在最后（拖到框的中间）。C 拖到 A 上 = 与 B 平行（B 在前）。
 *   · `before` —— 成为目标的**前一个兄弟**（拖到框的上边缘）。
 *   · `after`  —— 成为目标的**后一个兄弟**（拖到框的下边缘）。
 *
 * 【为什么合法性这里不算，要转手问 moveNode】
 *   环检测 / 子树深度 / 一级分支上限**只有一份实现**（moveNode 里那三段）。
 *   在这里再写一遍就是第二个真源：改一处漏一处，且两条口径会慢慢分叉
 *   —— 上一轮 `--discover` 恒绿就是"第二个实现"惹的祸。所以这里只负责**算出意图**，
 *   再拿 moveNode 试跑一次，把它的话原样带回去（`reason`）。
 *
 * 【分数 order 会不会把 order 弄成小数】
 *   不会。moveNode 落定后会把同一父级下的兄弟 order 重排成 0..n-1，
 *   这里给 `over.order ± 0.5` 只是"排它前面/后面"的表达方式，
 *   比"先删再插再数下标"少两次遍历，也不怕脏数据里 order 有重复。
 *
 * @param {object} doc 导图文档
 * @param {string} dragId 被拖的节点
 * @param {string} overId 鼠标松手时压在哪个节点上（空 = 没命中任何节点）
 * @param {'child'|'before'|'after'} zone 落点在目标框的哪一段
 * @returns {{ok:boolean, parentId:string, order:number, zone:string, reason:string}}
 */
export function dropIntent(doc, dragId, overId, zone) {
  const fail = (reason) => ({ ok: false, parentId: '', order: 0, zone: 'child', reason });
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return fail('导图数据不完整。');
  const idx = indexDoc(base);
  const id = dragId == null ? '' : String(dragId);
  const over = overId == null ? '' : String(overId);
  if (!idx.byId.has(id)) return fail('找不到要移动的节点。');
  if (id === idx.rootId) return fail('主拼图不能拖动。');
  if (!over || !idx.byId.has(over)) return fail('拖到某个框上才会移动。');
  if (over === id) return fail('拖回原位了。');

  const overNode = idx.byId.get(over);
  const z = zone === 'before' || zone === 'after' ? zone : 'child';
  let parentId;
  let order;
  // 根没有兄弟：上/下边缘对主拼图无意义，一律按"挂到主拼图下面"处理。
  if (z === 'child' || over === idx.rootId) {
    parentId = over;
    order = Number.MAX_SAFE_INTEGER;
  } else {
    parentId = overNode.parentId || idx.rootId;
    const at = Number(overNode.order);
    order = (Number.isFinite(at) ? at : 0) + (z === 'before' ? -0.5 : 0.5);
  }

  const probe = moveNode(base, id, parentId, order);
  if (!probe || probe.ok !== true) return fail((probe && probe.error) || '这里不能放。');
  return { ok: true, parentId, order, zone: z, reason: '' };
}

/**
 * 旧口径的「唯一合法落点」，**已废弃**，仅为存量 import 保留一版。
 *
 * 不要在新代码里用它：它现在与 UI 的真实行为不一致（UI 走 `dropIntent`）。
 * 保留它是因为「把它删掉」会让某个还在 require 它的旧脚本静默拿到 undefined
 * —— 那比多一个显式废弃函数更难查。新门禁 `unit-mindmap-drop-intent.mjs`
 * 会断言它**不再被任何生产代码引用**，所以它不会变成第二个真源。
 *
 * @deprecated 用 `dropIntent`。
 */
export function dragOnlyParent(doc, id) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return null;
  const idx = indexDoc(base);
  if (!idx.byId.has(id) || id === idx.rootId) return null;
  const node = idx.byId.get(id);
  const parent = node && node.parentId ? idx.byId.get(node.parentId) : null;
  if (!parent) return idx.rootId;
  return parent.parentId || idx.rootId;
}

/**
 * 换父 + 定点插入。
 * 防环只靠一条：新父不能是自己、也不能在自己的子树里 —— 子树判定用一次 DFS，
 * 比"往上找祖先"更直观（往上找要处理脏数据里的环，容易写成死循环）。
 */
export function moveNode(doc, id, newParentId, order) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return { ok: false, doc, error: '导图数据不完整。' };
  const idx = indexDoc(base);
  if (!idx.byId.has(id)) return { ok: false, doc: base, error: '找不到要移动的节点。' };
  if (id === idx.rootId) return { ok: false, doc: base, error: '根节点不能移动。' };
  const parent = idx.byId.get(newParentId);
  if (!parent) return { ok: false, doc: base, error: '找不到目标父节点。' };
  if (parent.id === id) return { ok: false, doc: base, error: '不能把节点挂到自己身上。' };

  const subtree = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (subtree.has(cur)) continue;
    subtree.add(cur);
    for (const c of idx.childrenOf[cur] || []) stack.push(c.id);
  }
  if (subtree.has(parent.id)) return { ok: false, doc: base, error: '不能挂到自己的子节点下面。' };

  // 深度限制跟着整棵子树走：搬过去以后最深的那一代也不能超限
  let rel = 0;
  for (const sid of subtree) rel = Math.max(rel, (idx.depthOf.get(sid) || 0) - (idx.depthOf.get(id) || 0));
  const newDepth = (idx.depthOf.get(parent.id) || 0) + 1;
  if (newDepth + rel > MM_LIMITS.maxDepth) {
    return { ok: false, doc: base, error: `这一支搬到那里会超过 ${MM_LIMITS.maxDepth} 层。` };
  }
  if (parent.id === idx.rootId) {
    const others = (idx.childrenOf[idx.rootId] || []).filter((n) => n.id !== id).length;
    if (others >= MM_LIMITS.maxBranches) {
      return { ok: false, doc: base, error: `一级分支最多 ${MM_LIMITS.maxBranches} 条。` };
    }
  }

  const targetOrder = Number.isFinite(Number(order)) ? Number(order) : Number.MAX_SAFE_INTEGER;
  /**
   * ★★ 换父级时**必须清掉子树的手拖坐标**（2026-11-10）。
   *
   * 不清的后果：用户把一个框拖到新父级下面，结构上它已经在 B 那边了，
   * 但因为它的世界坐标被钉在旧位置，画面上它**还留在 A 旁边** ——
   * 于是连线和父子关系全部对不上，用户看到的是"拖了但它没过去"。
   * 这比"拖不动"更难理解（因为结构其实变了）。
   *
   * 为什么连整棵子树一起清：子节点的手拖坐标是相对"旧父级附近"摆的，
   * 父级搬家后那些坐标在新位置毫无意义，留着只会让整支散开。
   * ⇒ 搬家 = 回到自动排版。用户想再摆一次，再拖一次即可。
   */
  const subtreeIds = new Set(subtree);
  const moved = base.nodes.map((n) => {
    if (!n) return n;
    if (n.id === id) return { ...n, parentId: parent.id, order: targetOrder, x: null, y: null };
    if (subtreeIds.has(n.id)) return { ...n, x: null, y: null };
    return n;
  });
  // 兄弟 order 重排成 0..n-1：否则反复拖动会让 order 越拉越大，最后排序失真
  const groups = {};
  for (const n of moved) {
    if (!n || n.parentId == null) continue;
    if (!groups[n.parentId]) groups[n.parentId] = [];
    groups[n.parentId].push(n);
  }
  const orderById = new Map();
  for (const key of Object.keys(groups)) {
    groups[key]
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)))
      .forEach((n, i) => orderById.set(n.id, i));
  }
  const nodes = moved.map((n) => (n && orderById.has(n.id) ? { ...n, order: orderById.get(n.id) } : n));
  return { ok: true, doc: { ...base, nodes, updatedAt: new Date().toISOString() } };
}

/**
 * 把某个节点钉在指定的**世界坐标**（左上角，与 `layout.nodes` 的 x/y 同一坐标系）。
 *
 * 这是「随意拼凑」的唯一写入口：拖到空白处松手时由 UI 调用。
 * 合法性只判两件（其余都是 UI 的事）：
 *   · 节点必须存在、且**不是根** —— 根是整张图的参照系，钉住它等于让"适应窗口"失去意义；
 *   · 坐标必须是有限数 —— NaN 写进去会让整张图渲染成空白，而且很难查（NaN 不报错）。
 * 非法输入返回 `{ok:false}` 而不是抛：调用方在 UI 事件里，抛出去只会变成一个红框。
 *
 * @param {object} doc
 * @param {string} id
 * @param {number} x 世界坐标
 * @param {number} y 世界坐标
 * @returns {{ok:boolean, doc:object, error?:string}}
 */
export function setNodePosition(doc, id, x, y) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return { ok: false, doc, error: '导图数据不完整。' };
  const idx = indexDoc(base);
  if (!idx.byId.has(id)) return { ok: false, doc: base, error: '找不到要摆放的节点。' };
  if (id === idx.rootId) return { ok: false, doc: base, error: '根节点固定居中，不能拖走。' };
  const nx = Number(x);
  const ny = Number(y);
  // ⚠️ 判"真的是数字"，**不是**判"能转成数字"：`Number('12') === 12`、`Number(null) === 0`，
  //   宽松判会把上游传错类型（字符串 / null / undefined）静默洗成合法坐标，
  //   于是"钉在 0"和"没设置"再也没法区分 —— 同一个坑本仓已踩过两次（见 posOrNull）。
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(nx) || !Number.isFinite(ny)) {
    return { ok: false, doc: base, error: '位置不合法。' };
  }
  const nodes = base.nodes.map((n) => (n && n.id === id ? { ...n, x: nx, y: ny } : n));
  return { ok: true, doc: { ...base, nodes, updatedAt: new Date().toISOString() } };
}

/**
 * 取消手动位置（「归位」）—— 把 x/y 清回 null，让树布局重新接管。
 * 与 `setNodePosition` 是同一对操作；分成两个函数而不是传一个 null，
 * 是因为两件事的**权限不同**：钉住要判坐标系，归位什么都不用判（清字段永远安全）。
 * @returns {{ok:boolean, doc:object, error?:string}}
 */
export function clearNodePosition(doc, id) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return { ok: false, doc, error: '导图数据不完整。' };
  const idx = indexDoc(base);
  if (!idx.byId.has(id)) return { ok: false, doc: base, error: '找不到这个节点。' };
  const nodes = base.nodes.map((n) => (n && n.id === id ? { ...n, x: null, y: null } : n));
  return { ok: true, doc: { ...base, nodes, updatedAt: new Date().toISOString() } };
}

/** 根不许折叠：折叠根 = 整张图空屏，用户会以为文件坏了。 */
export function toggleCollapse(doc, id) {
  const base = doc && Array.isArray(doc.nodes) ? doc : null;
  if (!base) return { ok: false, doc, error: '导图数据不完整。' };
  const idx = indexDoc(base);
  const target = idx.byId.get(id);
  if (!target) return { ok: false, doc: base, error: '找不到这个节点。' };
  if (id === idx.rootId) return { ok: false, doc: base, error: '根节点不能折叠。' };
  const nodes = base.nodes.map((n) => (n && n.id === id ? { ...n, collapsed: !n.collapsed } : n));
  return { ok: true, doc: { ...base, nodes, updatedAt: new Date().toISOString() } };
}

/** 先序遍历出"看得见"的节点（跳过折叠节点的整棵子树），带 depth 的浅拷贝。 */
export function flattenVisible(doc) {
  const idx = indexDoc(doc);
  if (!idx.rootId) return [];
  const out = [];
  const stack = [[idx.rootId, 0]];
  const seen = new Set();
  while (stack.length) {
    const [id, depth] = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = idx.byId.get(id);
    if (!node) continue;
    // 折叠的节点**自己还在**，只是子节点不进列表 —— 否则折叠一下这个节点就消失了
    out.push({ ...node, depth });
    if (node.collapsed) continue;
    const kids = idx.childrenOf[id] || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i].id, depth + 1]);
  }
  return out;
}

/**
 * 喂给 AI 的缩进大纲（"根\n  一级A\n    二级A1"）。
 * 刻意**不过滤折叠**：折叠只是"人此刻不想看"，AI 要的是完整结构。
 */
export function outlineText(doc) {
  const idx = indexDoc(doc);
  if (!idx.rootId) return '';
  const lines = [];
  const walk = (id, depth) => {
    const node = idx.byId.get(id);
    if (!node) return;
    lines.push('  '.repeat(depth) + (node.text || ''));
    for (const c of idx.childrenOf[id] || []) walk(c.id, depth + 1);
  };
  walk(idx.rootId, 0);
  return lines.join('\n');
}

/**
 * 给用户导出的 Markdown。
 * 根的文字就是 `# 标题`，所以列表从**根的子节点**开始 —— 否则第一行标题与
 * 第一条列表一字不差，导出稿看着像重复了一遍。
 */
export function docToMarkdown(doc) {
  const idx = indexDoc(doc);
  if (!idx.rootId) return '';
  const title = (doc && doc.title) || idx.byId.get(idx.rootId).text || '未命名导图';
  const lines = ['# ' + title];
  const walk = (id, depth) => {
    for (const c of idx.childrenOf[id] || []) {
      lines.push('  '.repeat(Math.max(0, depth - 1)) + '- ' + (c.text || ''));
      walk(c.id, depth + 1);
    }
  };
  walk(idx.rootId, 1);
  return lines.join('\n') + '\n';
}

export function statsOf(doc) {
  const idx = indexDoc(doc);
  let depth = 0;
  let leaves = 0;
  let collapsed = 0;
  for (const n of idx.byId.values()) {
    depth = Math.max(depth, idx.depthOf.get(n.id) || 0);
    if (!(idx.childrenOf[n.id] || []).length) leaves += 1;
    if (n.collapsed) collapsed += 1;
  }
  return { nodes: idx.byId.size, depth, leaves, collapsed };
}
