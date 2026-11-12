/**
 * 验收清单的**机械读数**层：能从文件系统直接读到的事实，一律不交给判断方去"觉得"。
 * ============================================================================
 * 为什么单独一层（而不是让验收员用眼睛看）：
 *   本仓反复栽在同一件事上 —— **判据没有判别力**。如果「TypeScript 规范」这一项交给一次
 *   LLM 调用去回答，它看到交付物里有 .ts 文件就会说"看起来符合规范"，而真实情况可能是
 *   `"strict": false` 加 47 个 `any`。凡是能读盘判定的，就必须读盘判定。
 *
 * 这一层只产出**读数**（含判定），不做任何主观评价：
 *   · 每个 check 返回 `{ pass, evidence }`，evidence 是给人复核的具体数字与路径；
 *   · 读不到就是读不到 —— 返回 pass:false + 说明，绝不因为"没读到"而返回 pass:true；
 *   · 项目里**压根没有这类东西**（例如纯 JS 项目没有 tsconfig）⇒ 返回 `skip`，
 *     而不是判它不合格。**不适用 ≠ 不合格**，混起来会把正常交付判死。
 *
 * ⚠️ 本模块有副作用（读盘），因此它**不参与纯函数判定**：
 *   evaluateAcceptance 只吃它吐出来的结果对象；门禁可以直接喂假读数测判定公式，
 *   也可以对真实夹具跑本模块测读数本身。两层各自可测，互不牵连。
 */
'use strict';

const fs = require('fs');
const path = require('path');
// ⚠️ 单向依赖：readings → checklist。反向绝对不许加（checklist 是纯函数模块，
//   一旦它 require 了本模块，evaluateAcceptance 就带上了读盘副作用，
//   门禁再也没法喂假读数测判定公式）。
//   `acceptanceChecklist` 只导出常量与纯函数，require 它不会触发任何读盘。
const CHECK = require('./acceptanceChecklist');

/** 单文件超过这个行数算「超大单体文件」（与 acceptanceChecklist.MAX_SINGLE_FILE_LINES 同值，这里独立声明避免循环依赖）。 */
const MAX_LINES = 1200;

/** 代码类扩展名（用于「代码结构」这一项）。 */
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.py', '.go', '.java']);

/** TypeScript 类扩展名（用于「TypeScript 规范」这一项）。 */
const TS_EXTS = new Set(['.ts', '.tsx']);

/** 扫描 E2E 时跳过的目录（不跳过会扫进 node_modules，几十万个文件）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'release', 'build', '.cache', 'coverage']);

/** 「边界说明」三个维度 + 每维度的同义写法。命中任一即算覆盖该维度。 */
const BOUNDARY_DIMS = [
  ['能力范围', ['能力范围', '功能范围', '支持什么', '能做什么', 'capabilities']],
  ['已知限制', ['已知限制', '限制', '局限', '不能做什么', 'known limitations', 'limitations']],
  ['使用注意', ['使用注意', '注意事项', '使用说明', '注意', 'usage notes']],
];

/**
 * 「设计推演」各维度的**同义词表**。
 *
 * 【名字从哪来】名字**不在这里定义** —— 从 `acceptanceChecklist.designDimensionsFor()`
 * 取。这里只负责「同一个意思还能怎么写」。
 * 为什么这么分：维度名字是**产品口径**（老板定的），换个词就是换标准；
 * 同义词是**检测实现**（漏一个只是少命中，不改变标准）。两者混在一起，
 * 就会出现「改了一个检测用的词，标准也跟着变了」这种没人察觉的漂移。
 *
 * ⚠️ 关键词匹配是**弱证据**，只能当提示，不能单独定罪。
 *   例：文档写「胜利后播放庆祝动画」会命中「胜利」（覆盖了胜利判定）——
 *   严格说它确实提到了，但可能没写判定条件。这类模糊只能交给人/模型复核。
 *   唯一够强、可以机械判死的，是 `collectDesignCoverage` 里的那条：
 *   **完全没有设计文档**（path 为空）—— 那是硬事实，不是关键词猜测。
 */
const DESIGN_SYNONYMS = {
  // ── 通用 8 项 ──
  '风格定位': ['风格', '定位', '调性', '视觉语言', 'style', '美术风格'],
  '交互思路': ['交互', '操作流程', '操作逻辑', 'interaction', '玩法'],
  '视觉方案': ['视觉方案', '视觉', '配色方案', '美术方案', 'visual design', '界面方案'],
  '关卡/页面结构': ['关卡', '页面结构', '页面布局', '布局', '信息架构', 'structure', 'layout', '版式结构'],
  '细节彩蛋': ['彩蛋', '细节', '打磨', '隐藏内容', 'easter egg', '小细节'],
  '状态分支': ['状态', '分支', 'state', '空态', '异常态', '加载态分支'],
  '动效': ['动效', '动画', '过渡', 'transition', 'animation', '缓动'],
  '反馈逻辑': ['反馈', '提示', '反馈逻辑', 'feedback', 'toast'],

  // ── 游戏专属 6 项 ──
  '失败反馈': ['失败反馈', '失败', 'game over', '失败了', '输了', '重来'],
  '胜利判定': ['胜利判定', '胜利条件', '通关条件', '过关', 'win', '结算'],
  '音效提示': ['音效', '声音', 'bgm', '音乐', 'sound', 'sfx'],
  '界面美术风格': ['界面美术', '美术风格', '画风', '风格化', 'art style', '素材风格'],
  '难度梯度': ['难度', '难度梯度', '难度曲线', '关卡难度', 'difficulty'],
  '边界异常处理': ['边界', '异常处理', '极端情况', '超时', '崩溃', 'edge case', '容错'],

  // ── 网页专属 6 项 ──
  '配色': ['配色', '色板', '主色', '色系', 'color', 'palette'],
  '排版层次': ['排版', '层次', '字阶', '字号层级', 'typography', '信息层级'],
  'hover 反馈': ['hover', '悬停', '鼠标移入', 'hover 态', '悬浮反馈'],
  '加载状态': ['加载状态', '加载中', '加载失败', 'loading', '骨架屏', '转圈'],
  '移动端适配': ['移动端', '响应式', '适配', '断点', 'responsive', '手机端'],
  '留白': ['留白', '间距', '呼吸感', 'padding', 'spacing', '空隙'],

  // ── PPT 专属 4 项 ──
  '版式逻辑': ['版式', '版面', '栅格', 'layout 逻辑', '排版逻辑'],
  '配图建议': ['配图', '图片建议', '插图', '素材建议', 'image'],
  '信息层级': ['信息层级', '层级', '重点突出', 'hierarchy', '主次'],
  '动画节奏': ['动画节奏', '动画', '切换节奏', '转场', 'animation'],
};

/**
 * 设计推演旧常量（保留导出，兼容既有门禁/调用点）。
 *
 * ⚠️ 新代码请用 `designDimsFor(kind)`。原来这里是**硬的 7 项**，与
 * `acceptanceChecklist` 各存一份 —— 两处一旦漂，就会出现「清单文案说 8 项、
 * 读数只查 7 项」而两边都绿。现在名字统一从 checklist 取，这里只补同义词。
 */
const DESIGN_DIMS = [];

/**
 * 按创作子类型生成待检测的维度表：`[[名字, [同义词...]], ...]`。
 *
 * @param {string} kind 创作子类型（game/web/ppt/visual，非法值会归一成 visual）
 * @returns {{kind:string, dims:Array<Array>, hasSpecific:boolean, note:string, baseCount:number}}
 */
function designDimsFor(kind) {
  const d = CHECK.designDimensionsFor(kind);
  const toEntry = (name) => [name, DESIGN_SYNONYMS[name] || [name]];
  const dims = d.all.map(toEntry);
  return {
    kind: d.kind,
    dims,
    hasSpecific: d.hasSpecific,
    note: d.note,
    baseCount: d.base.length,
    specificCount: d.specific.length,
  };
}


/** 把交付物清单归一成绝对路径数组（容忍 string / {path} / {name}）。 */
function normalizeDeliverables(deliverables, projectRoot) {
  const list = Array.isArray(deliverables) ? deliverables : [];
  // ★ root 必须先绝对化：传进来的常常是相对路径（如 'scripts/tmp-probe/_acc-fix'），
  //   若直接 join，交付物 'src/a.ts' 会变成 'root/root/src/a.ts' —— 于是每个文件都"读不到"。
  //   而"读不到"在下游会被当成 0 个 any ⇒ **假通过**。这类 fail-open 比判错更坏。
  const root = projectRoot ? path.resolve(String(projectRoot)) : '';
  const out = [];
  for (const d of list) {
    let p = '';
    if (typeof d === 'string') p = d;
    else if (d && typeof d === 'object') p = String(d.path || d.file || d.name || '');
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : (root ? path.join(root, p) : path.resolve(p));
    if (out.indexOf(abs) < 0) out.push(abs);
  }
  return out;
}

/** 安全读文本：不存在 / 不是文件 / 太大 / 读失败 ⇒ 返回 null（绝不抛）。 */
function readTextSafe(abs, maxBytes) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const cap = Number(maxBytes) > 0 ? Number(maxBytes) : 2 * 1024 * 1024;
    if (st.size > cap) {
      // 超大文件只读前 cap 字节：判定只需要结构，不需要全文
      const fd = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(cap);
      const n = fs.readSync(fd, buf, 0, cap, 0);
      fs.closeSync(fd);
      return buf.slice(0, n).toString('utf8');
    }
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 剥掉注释再统计。
 * 为什么必须剥：「代码里提到 any」和「代码里用了 any」是两件事。
 * 本仓在 unit-see-own-output 上为此付过代价 —— 注释里举例写出的字面量被当成真断言，
 * 直接把判据弄瞎。这里的同类错误是「注释写了 any 就判不合格」，属于误伤正确代码。
 */
function stripComments(src) {
  const s = String(src || '');
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && s[i] !== '\n') i++;
    } else if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      // 字符串整体保留（内部的 any 属于真实内容），但跳过转义
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i];
        if (s[i] === q) { i++; break; }
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** 统计 TypeScript 里 `any` 的用法个数（含 : any / as any / <any> / any[]）。 */
function countAnyUses(src) {
  const code = stripComments(src);
  const re = /(:\s*any\b|\bas\s+any\b|<any>|\bany\s*\[\])/g;
  const m = code.match(re);
  return m ? m.length : 0;
}

/** 剥掉 JSONC 的注释与尾逗号，再 parse（tsconfig 允许注释）。 */
function parseJsonc(src) {
  let s = String(src || '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 从起点向上找 tsconfig.json（最多 6 层，防跑出仓库）。
 * 为什么向上找：交付物可能在 src/xxx 里，tsconfig 在项目根。
 */
function findTsconfig(startDirs, projectRoot) {
  const seen = new Set();
  const queue = [];
  for (const d of startDirs) if (d) queue.push(d);
  if (projectRoot) queue.push(String(projectRoot));
  for (let p of queue) {
    let cur = p;
    for (let hop = 0; hop < 6 && cur && cur !== path.dirname(cur); hop++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const cand = path.join(cur, 'tsconfig.json');
      if (fs.existsSync(cand)) return cand;
      cur = path.dirname(cur);
    }
  }
  return '';
}

/** 在项目里找 E2E 痕迹（配置 / 用例文件 / 目录），深度受限。 */
function findE2E(projectRoot) {
  const root = String(projectRoot || '');
  if (!root || !fs.existsSync(root)) return { found: [], config: '' };
  const found = [];
  let config = '';
  const walk = (dir, depth) => {
    if (depth > 3 || found.length > 40) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (/^(e2e|tests?|playwright|cypress)$/i.test(e.name) && depth <= 2) found.push(abs + '/');
        walk(abs, depth + 1);
        continue;
      }
      if (/^playwright\.config\.[cm]?[jt]s$/.test(e.name) || /^cypress\.config\.[cm]?[jt]s$/.test(e.name)) {
        config = abs;
      } else if (/\.(spec|e2e)\.[cm]?[jt]sx?$/.test(e.name)) {
        found.push(abs);
      }
    }
  };
  walk(root, 0);
  return { found, config };
}

/**
 * 检查一段文本覆盖了哪些维度。
 *
 * @returns {{covered:string[], missing:string[], hits:object}}
 *   `hits` 是**这次新加的**：`{维度名: 命中的那个词}`。
 *
 * 【为什么要记录命中词】因为子串匹配会**串味**，而串味是肉眼看不出来的。
 *   实测（2026-11-03，`scripts/tmp-probe/_design-probe.mjs` 场景 4）：
 *   一份**游戏**设计文档里写「状态分支：暂停/结束/加载」，拿去按**网页**维度查，
 *   结果「加载状态」被判成「已覆盖」—— 因为它命中了裸词「加载」。
 *   纯看结论（加载状态 已覆盖）根本发现不了这是误判；
 *   带上命中词（加载状态 ← 命中「加载」）就能一眼看出它只是撞词了。
 *   ⇒ 弱证据必须**可复核**，否则它会伪装成强证据。
 */
function coverageOf(text, dims) {
  const t = String(text || '');
  const covered = [];
  const missing = [];
  const hits = {};
  for (const [name, keys] of dims) {
    const hitKey = keys.find((k) => t.indexOf(k) >= 0);
    if (hitKey) { covered.push(name); hits[name] = hitKey; } else missing.push(name);
  }
  return { covered, missing, hits };
}

function pass(evidence) { return { pass: true, evidence }; }
function fail(evidence) { return { pass: false, evidence }; }
function skip(evidence) { return { result: 'skip', evidence }; }

// ══════════════ 方案探索：从设计文档里数「有几个方案、有没有比较、有没有选」 ══════════════
//
// 【为什么必须自己数，而不是问模型「你做了几个方案」】
//   老板原话：「至少形成几个有实质区别的方案，而不是换颜色、换标题冒充多个方案。」
//   "我做了三个方案"是**自述**，改成"我做了三个"一行字就绕过去了。
//   方案个数是**文档结构事实**：有几个并列的方案小标题，就能数出来。
//
// 【识别边界 —— 这里最容易误伤，先读完再改】
//   只认**标题行 / 独立加粗行 / 列表项开头**，不认正文里随机出现的「方案」二字。
//   （正文写「本方案采用 Canvas」很常见，把这种算成一个方案会让个数虚高。）
//   标识只允许「数字 / 单个字母 / 中文数字 / 甲乙丙丁」：
//     「方案A：…」「方案 2」「方案一」「**方案B**」「- 方案三」
//   刻意**不匹配**「优化方案」「方案对比」「方案设计」——
//     它们后面跟的字不在允许集合里，所以不会被当成方案标识。
//     这个坑很实在：把「方案对比」当成一个方案，会让"只有一版"被判成"两版"。
//
// 【相似度为什么只做提示】
//   中文短段落的字符二元组天然高度重合（同一产品、同一技术栈，词一定大面积重叠）。
//   拿它判死必然误伤 —— 本仓在"关键词命中算不算证据"上已经栽过一次。
//   所以它只进读数，供模型复核；判死只认「方案个数」这一条硬事实。
const OPT_ID_CHARS = '0-9A-Za-z一二三四五六七八九十甲乙丙丁';
/** 从一行标题里抽方案标识（归一成小写字母/阿拉伯数字/中文数字）；抽不到返回 ''。 */
function optionIdOf(title) {
  const t = String(title || '');
  // 允许「方案A」「方案 A」「方案：A」「方案一」「方案 1」；标识后面不许紧跟同类字符
  const m = new RegExp('方案\\s*[:：]?\\s*([' + OPT_ID_CHARS + '])(?![0-9A-Za-z\\u4e00-\\u9fa5])').exec(t);
  if (m) return m[1].toLowerCase();
  const m2 = new RegExp('(?:^|[^0-9A-Za-z])(' + OPT_ID_CHARS + ')\\s*方案').exec(t);
  if (m2) return m2[1].toLowerCase();
  return '';
}

/** 字符二元组集合（去掉空白与标点）。中文按 2-gram，英文/数字也按 2-gram，够用。 */
function bigramsOf(s) {
  const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Jaccard 相似度。任一为空 ⇒ 0（没有证据就说"不像"，不虚构相似）。 */
function jaccardOf(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 分区词表（**受控**，与 `designMolds.MOLDS[].skeleton` 同一套概念）。
 *
 * ★ 为什么必须是受控词表而不是"任意名词"：这张表要用来判"两个方案的骨架是不是同一个"。
 *   如果允许自由词，那任何两个方案都会抽出不同的骨架 ⇒ 判据永远不触发（恒绿）；
 *   反过来若词表太宽，随便说句话就能凑出三个分区 ⇒ 恒红。
 *   受控的有限集合是这两个失效模式的唯一夹缝。
 *
 * 每项 `[文档里可能出现的词, 规范化分区]`；同一分区可以有多种写法。
 * 刻意没有收「对比」——「对比优势」「对比同行」这类用法会把对照栏误算进骨架。
 */
const SECTION_WORDS = [
  ['导航', 'nav'], ['菜单栏', 'nav'],
  ['首屏', 'hero'], ['主视觉', 'hero'], ['hero', 'hero'], ['头图', 'hero'], ['banner', 'hero'],
  ['卡片', 'cards'], ['卡片组', 'cards'], ['网格', 'cards'],
  ['对开', 'split'], ['左右分栏', 'split'], ['左文右图', 'split'], ['图文交替', 'split'],
  ['正文', 'prose'], ['长文', 'prose'], ['段落流', 'prose'],
  ['指标条', 'metrics'], ['数据条', 'metrics'], ['关键指标', 'metrics'],
  ['表格', 'table'],
  ['引语', 'quote'], ['大字引语', 'quote'],
  ['图墙', 'gallery'], ['相册', 'gallery'], ['瀑布流', 'gallery'],
  ['行动区', 'cta'], ['预约表单', 'cta'], ['按钮区', 'cta'], ['表单', 'cta'],
  ['页脚', 'footer'], ['底部信息', 'footer'],
  ['时间轴', 'timeline'],
  ['步骤', 'steps'], ['流程', 'steps'], ['三步', 'steps'], ['四步', 'steps'],
  ['对照栏', 'compare'], ['三栏对照', 'compare'], ['左右对照', 'compare'],
];

/**
 * 解析设计文档里的并列方案。
 *
 * @param {string} src 文档全文
 * @returns {{count:number, ids:string[], labels:string[],
 *            compare:boolean, compareWhy:string,
 *            chosen:string, chosenWhy:string,
 *            similarPairs:Array<{a:string,b:string,sim:number}>}}
 *   `count` 是**去重后的方案个数**（同一个标识写了两次只算一个 —— 目录+正文会重复出现）。
 */
function parseDesignOptions(src) {
  const text = String(src || '');
  const empty = {
    count: 0, ids: [], labels: [], compare: false, compareWhy: '',
    chosen: '', chosenWhy: '', similarPairs: [],
  };
  if (!text) return empty;

  const lines = text.split(/\r?\n/);
  const marks = []; // { idx, level, id, label }
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let level = 0;
    let title = '';
    const mHead = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/.exec(ln);
    if (mHead) { level = mHead[1].length; title = mHead[2]; }
    else {
      const mBold = /^\s*\*\*(.+?)\*\*\s*$/.exec(ln);
      if (mBold) { level = 7; title = mBold[1]; }
      else {
        const mList = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(ln);
        if (mList) { level = 8; title = mList[1]; }
      }
    }
    if (!level) continue;
    const id = optionIdOf(title);
    if (id) marks.push({ idx: i, level, id, label: String(title).trim() });
  }
  if (!marks.length) return empty;

  // 去重：同一标识只保留**第一次**出现（目录项也会命中，正文才是真内容；
  // 但因为后面的段越长越可能是正文，所以取"同名里最长的段"更稳）。
  const segsOf = (m, next) => lines.slice(m.idx + 1, next).join('\n');
  const byId = new Map();
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    // 段尾：下一个方案标记；没有下一个就到最后
    const next = k + 1 < marks.length ? marks[k + 1].idx : lines.length;
    const body = segsOf(m, next);
    const prev = byId.get(m.id);
    if (!prev || body.length > prev.body.length) byId.set(m.id, { ...m, body });
  }
  const opts = [...byId.values()];

  // 相似度成对比较（只报超出阈值的对，供人复核）
  const grams = opts.map((o) => bigramsOf(o.body));
  const similarPairs = [];
  for (let i = 0; i < opts.length; i++) {
    for (let j = i + 1; j < opts.length; j++) {
      const sim = jaccardOf(grams[i], grams[j]);
      if (sim >= CHECK.DESIGN_OPTION_SIMILAR_MAX) {
        similarPairs.push({ a: opts[i].id, b: opts[j].id, sim: Number(sim.toFixed(3)) });
      }
    }
  }

  /**
   * ★★ 2026-11-03：**结构级**比对 —— 治「换颜色、换标题冒充多个方案」。
   *
   * 为什么字符相似度（上面的 similarPairs）判不了这件事，必须另做一层：
   *   老板原话是「至少形成几个有实质区别的方案，**而不是换颜色、换标题冒充**」。
   *   而「方案A：绿色清新风／方案B：蓝色科技风」这两段的**分区骨架完全一样**、
   *   文字却几乎不重合 —— 字符 Jaccard 会算出很低的相似度，于是被当成两个方案放过去。
   *   也就是说：字符相似度对"换皮"这件事是**失效的**（它抓的是同义改写，不是同构）。
   *
   * 做法：把每个方案段落里出现的**分区词**按顺序抽成骨架，再比骨架。
   *   词表受控（有限几个），所以这不是自由文本比对，误伤面小得多。
   *   并且只在**两边都抽得出 ≥3 个分区**时才判 —— 抽不出来（模型没写结构）就不判，
   *   不许拿"没说"当"没有"。这条保守边界和 `count===0 不判` 是同一条纪律。
   *
   * 强弱证据定位：这是**强读数**（结构调整是事实），可以和"方案个数"一样直接判死。
   * 而 similarPairs 仍然是弱读数（只进 extra 供模型复核）—— 两者的差别在于
   *   "骨架一样"是可核对的，"文字像"不是。
   */
  const shapeOf = (body) => {
    const s = String(body || '');
    const hits = [];
    for (const [word, canon] of SECTION_WORDS) {
      let from = 0;
      for (;;) {
        const at = s.indexOf(word, from);
        if (at < 0) break;
        hits.push({ at, canon });
        from = at + word.length;
      }
    }
    hits.sort((a, b) => a.at - b.at);
    const seq = [];
    for (const h of hits) if (seq[seq.length - 1] !== h.canon) seq.push(h.canon);
    return seq;
  };
  const shapePairs = [];
  const shapes = opts.map((o) => shapeOf(o.body));
  for (let i = 0; i < opts.length; i++) {
    for (let j = i + 1; j < opts.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      // 只判"两边都写得清结构"的对；抽不出结构的对不判（不许拿沉默当证据）
      if (a.length < 3 || b.length < 3) continue;
      const same = a.join('>') === b.join('>');
      if (same) shapePairs.push({ a: opts[i].id, b: opts[j].id, shape: a.join(' > ') });
    }
  }

  // —— 比较段：优先认 markdown 表格（结构），其次认「同时出现 ≥2 个方案标识 + ≥2 个比较词」——
  const CMP_WORDS = ['功能', '审美', '可用性', '创新', '成本', '维护', '复杂度', '性能', '取舍', '优劣', '对比', '比较'];
  let compare = false;
  let compareWhy = '';
  {
    const tableRows = lines.filter((ln) => (ln.match(/\|/g) || []).length >= 2);
    if (tableRows.length >= 3) { compare = true; compareWhy = '有 markdown 比较表（' + tableRows.length + ' 行）'; }
    else {
      const hitW = CMP_WORDS.filter((w) => text.indexOf(w) >= 0);
      const idHits = opts.filter((o) => new RegExp('方案\\s*[:：]?\\s*' + o.id, 'i').test(text)).length;
      if (hitW.length >= 2 && idHits >= 2) {
        compare = true;
        compareWhy = '有比较词 ' + hitW.slice(0, 4).join('/') + '，且同时提到 ' + idHits + ' 个方案';
      } else {
        compareWhy = '没有比较表；比较词命中 ' + hitW.length + ' 个、被同时提到的方案 ' + idHits + ' 个';
      }
    }
  }

  // —— 选定：必须有"选/推荐/采用"这类动作词，且**紧跟着某个方案标识** ——
  //   只判"出现了'推荐'二字"会被「推荐做法是…」骗过去，所以要求后半句对得上某个方案。
  let chosen = '';
  let chosenWhy = '没有写明选哪个方案';
  {
    const VERB = '(?:选定|采用|推荐|选择|定为|定稿|就用|取|走)';
    for (const o of opts) {
      const re = new RegExp(VERB + '[^。\\n]{0,16}方案\\s*[:：]?\\s*' + o.id, 'i');
      const re2 = new RegExp('方案\\s*[:：]?\\s*' + o.id + '[^。\\n]{0,12}' + '(?:胜出|入选|更优|最优|推荐|采用|就用)', 'i');
      const m = re.exec(text) || re2.exec(text);
      if (m) { chosen = o.id; chosenWhy = m[0].slice(0, 60); break; }
    }
  }

  return {
    count: opts.length,
    ids: opts.map((o) => o.id),
    labels: opts.map((o) => o.label),
    compare, compareWhy, chosen, chosenWhy, similarPairs,
    // 结构级读数（强）：骨架完全相同的方案对。空数组 = 没抓到换皮，不等于"一定不同"。
    shapePairs,
    shapes: opts.map((o, k) => ({ id: o.id, shape: shapes[k].join(' > ') })),
  };
}

/**
 * 交付物的「共同祖先目录」当项目根。
 * 为什么需要推导：调用方常常只给一堆绝对路径的交付物，不给项目根。
 * 没有根就没法扫 E2E / 找 tsconfig ⇒ 那一整组会全部"核验不了"，
 * 而"核验不了"最容易被顺手读成"通过"。推导一个根，比默默跳过诚实。
 */
function deriveProjectRoot(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return '';
  let dirs = list.map((f) => path.dirname(f));
  let common = '';
  for (let hop = 0; hop < 8; hop++) {
    const uniq = Array.from(new Set(dirs));
    if (uniq.length <= 1) { common = uniq[0] || ''; break; }
    dirs = uniq.map((d) => path.dirname(d));
  }
  if (!common) common = path.dirname(list[0]);
  // ★ 只取「交付物的共同目录」不够：单个交付物时共同目录就是它自己所在的子目录
  //   （例如 …/_acc-fix/src），于是同项目里的 e2e/ 扫不到 ⇒ G3-3 假红。
  //   向上找到第一个带项目标识的目录才算根；找不到才退回共同目录。
  const MARKERS = ['package.json', 'tsconfig.json', '.git', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
  let cur = common;
  for (let hop = 0; hop < 6 && cur && cur !== path.dirname(cur); hop++) {
    for (const m of MARKERS) {
      try { if (fs.existsSync(path.join(cur, m))) return cur; } catch { /* 读不到就继续往上 */ }
    }
    cur = path.dirname(cur);
  }
  return common;
}

/**
 * 采集机械读数。
 *
 * @param {{deliverables?:Array, projectRoot?:string, taskType?:string, level?:string}} input
 * @returns {{mech:object, extra:object, projectRoot:string}}
 *   mech  —— 可直接喂给 evaluateAcceptance 的机械项结论（键 = 清单 id）
 *   extra —— 给判断方当证据用的补充读数（设计推演覆盖度 / 空壳信号）
 */
function collectAcceptanceReadings(input) {
  const c = input || {};
  const files = normalizeDeliverables(c.deliverables, c.projectRoot);
  const projectRoot = c.projectRoot ? path.resolve(String(c.projectRoot)) : deriveProjectRoot(files);
  const mech = {};
  // 创作子类型决定「查哪些设计维度」。缺省归一成 visual（只查通用 8 项，最不易误伤）。
  const kindDims = designDimsFor(c.creativeKind);
  const extra = {
    files, projectRoot, designCoverage: null, designOptions: null, shellSignals: [],
    creativeKind: kindDims.kind, designNote: kindDims.note,
  };

  const tsFiles = files.filter((f) => TS_EXTS.has(path.extname(f).toLowerCase()));
  const codeFiles = files.filter((f) => CODE_EXTS.has(path.extname(f).toLowerCase()));
  const mdFiles = files.filter((f) => /\.(md|markdown|txt)$/i.test(f));

  // ★ 一个交付物都没有 ⇒ 第三组整组跳过，不判不合格。
  //   为什么：'什么都没交' 这件事由 G1-4 / G4-1 判（它们才知道是不是三层全空），
  //   让工程规范组跟着喊"不合格"只会制造一堆噪音项，把真正的结论埋掉。
  if (!files.length) {
    for (const id of ['G3-1', 'G3-2', 'G3-3', 'G3-4']) {
      mech[id] = skip('本轮没有任何交付物 ⇒ 工程规范无从核验（是否"什么都没交"由 G1-4 / G4-1 判）');
    }
    extra.designCoverage = {
      path: '', base: { covered: [], missing: kindDims.dims.slice(0, kindDims.baseCount).map((d) => d[0]) },
      specific: { covered: [], missing: kindDims.dims.slice(kindDims.baseCount).map((d) => d[0]) },
      kind: kindDims.kind, hasSpecific: kindDims.hasSpecific, note: kindDims.note,
      docExists: false,
    };
    // 空交付物时方案数必然是 0，但**不在这里判**："什么都没交"由 G1-4 / G4-1 判，
    // 这里跟着喊只会制造第二条同义红项，把真结论埋掉（同 G3 组的既有纪律）。
    extra.designOptions = {
      count: 0, ids: [], labels: [], compare: false, compareWhy: '没有任何交付物',
      chosen: '', chosenWhy: '', similarPairs: [], shapePairs: [], shapes: [], path: '',
    };
    return { mech, extra, projectRoot };
  }

  // ── G3-1 TypeScript 规范 ──
  // 纯 JS 项目（没有 .ts/.tsx 交付物）⇒ skip，不是不合格。
  // ★ 判据必须挂在**交付物**上，不能挂在"仓库里有没有 tsconfig"上：
  //   实测踩到过——交付物只有 .jsx，但项目根有 tsconfig.json ⇒ 老写法走进 else 分支，
  //   tsFiles 为空、any 用量自然 0 ⇒ 判 pass。那是个**空判据**：它什么也没检查就说通过了。
  {
    if (!tsFiles.length) {
      mech['G3-1'] = skip('交付物里没有 .ts/.tsx ⇒ 本项无适用对象（不拿仓库里有 tsconfig 充数）');
    } else {
      const tsconfig = findTsconfig(files.map((f) => path.dirname(f)), projectRoot);
      if (!tsconfig) {
        mech['G3-1'] = fail('有 ' + tsFiles.length + ' 个 .ts/.tsx 交付物，但没找到 tsconfig.json ⇒ 无法证明严格模式');
      } else {
        const raw = readTextSafe(tsconfig, 256 * 1024);
        const j = raw ? parseJsonc(raw) : null;
        const opts = (j && j.compilerOptions) || {};
        const strict = opts.strict === true;
        let anyTotal = 0;
        let unreadable = 0;
        const anyDetail = [];
        for (const f of tsFiles) {
          const src = readTextSafe(f);
          if (src == null) { unreadable++; anyDetail.push(path.basename(f) + ':读不到'); continue; }
          const n = countAnyUses(src);
          anyTotal += n;
          if (n > 0) anyDetail.push(path.basename(f) + ':' + n);
        }
        const ev = path.basename(tsconfig) + ' strict=' + (strict ? 'true' : String(opts.strict))
          + '；any 用量=' + anyTotal + (anyDetail.length ? '（' + anyDetail.join(', ') + '）' : '');
        // ★ 读不到的文件不许当成「0 个 any」蒙过去（实测踩到：路径拼错时三个 .ts 全"读不到"，
        //   而这一项照样判 pass=true —— 判据在最该拦住的地方放行了）。读不全 = 核不了 = 不合格。
        mech['G3-1'] = (unreadable === 0 && strict && anyTotal === 0)
          ? pass(ev)
          : fail(ev + (unreadable ? ' ⇒ 有 ' + unreadable + ' 个文件读不到，无法证明 any=0' : ' ⇒ 要求 strict=true 且 any=0'));
      }
    }
  }

  // ── G3-2 代码结构 ──
  {
    if (!codeFiles.length) {
      mech['G3-2'] = skip('没有可统计的源码交付物 ⇒ 本项不适用');
    } else {
      let maxLines = 0;
      let maxFile = '';
      let readable = 0;
      for (const f of codeFiles) {
        const src = readTextSafe(f);
        if (src == null) continue;
        readable++;
        const n = src.split('\n').length;
        if (n > maxLines) { maxLines = n; maxFile = f; }
      }
      if (!readable) mech['G3-2'] = fail('源码交付物一个都读不到 ⇒ 无法核验结构');
      else {
        const ev = '最大单文件 ' + maxLines + ' 行（' + path.basename(maxFile) + '），阈值 ' + MAX_LINES
          + '；共核 ' + readable + ' 个源码文件';
        mech['G3-2'] = maxLines <= MAX_LINES ? pass(ev) : fail(ev + ' ⇒ 需按职责拆分');
      }
    }
  }

  // ── G3-3 E2E 测试 ──
  {
    const e2e = findE2E(projectRoot);
    const cases = e2e.found.filter((f) => !f.endsWith('/'));
    if (e2e.config || cases.length) {
      mech['G3-3'] = pass('配置=' + (e2e.config ? path.basename(e2e.config) : '无')
        + '；用例 ' + cases.length + ' 个' + (cases.length ? '（' + cases.slice(0, 3).map((f) => path.basename(f)).join(', ') + '）' : ''));
    } else {
      mech['G3-3'] = fail('项目里没找到 playwright/cypress 配置，也没有 *.spec.* / *.e2e.* 用例');
    }
  }

  // ── G3-4 边界说明 ──
  {
    let best = null;
    for (const f of mdFiles) {
      const src = readTextSafe(f);
      if (src == null) continue;
      const cov = coverageOf(src, BOUNDARY_DIMS);
      if (!best || cov.covered.length > best.cov.covered.length) best = { f, cov };
    }
    if (!best) mech['G3-4'] = fail('交付物里没有 .md/.txt 说明文档 ⇒ 缺能力范围/已知限制/使用注意');
    else if (best.cov.missing.length === 0) {
      mech['G3-4'] = pass(path.basename(best.f) + ' 覆盖：' + best.cov.covered.join('/'));
    } else {
      mech['G3-4'] = fail(path.basename(best.f) + ' 缺：' + best.cov.missing.join('/'));
    }
  }

  // ══════════════ 设计推演覆盖度（创作类专属，按子类型查）══════════════
  //
  // 【证据强度分层 —— 这一层最容易搞错，先读完再改】
  //   · 强证据：**完全没有设计文档**（mdFiles 为空，或一个都读不到）。
  //     这是硬事实，不涉及任何语义猜测 ⇒ 可以机械判 G2-1 不合格。
  //   · 弱证据：有文档，但某些维度没命中关键词。
  //     关键词是子串匹配，写「胜利后播放庆祝动画」就命中「胜利判定了吗」——
  //     它确实提到了，但可能没写判定条件。**这种模糊只能交给模型复核，机械判死必然误伤。**
  //   ⇒ 所以：强证据写进 mech（会真的改变结论）；弱证据只写进 extra（提示，供模型参考）。
  //
  // 【为什么这条以前没有】修前 extra.designCoverage 采集了 7 个通用维度的覆盖度，
  //   但只塞进提示词，没有任何代码据此行动 —— 采集了不消费，等于白采。
  //   现在把强证据那半接上判定，弱证据那半保持提示，两边都说清。
  {
    const baseDims = kindDims.dims.slice(0, kindDims.baseCount);
    const specDims = kindDims.dims.slice(kindDims.baseCount);

    let best = null;
    for (const f of mdFiles) {
      const src = readTextSafe(f);
      if (src == null) continue;
      const baseCov = coverageOf(src, baseDims);
      const specCov = specDims.length ? coverageOf(src, specDims) : { covered: [], missing: [] };
      const score = baseCov.covered.length + specCov.covered.length;
      if (!best || score > best.score) best = { f, baseCov, specCov, score };
    }

    const docExists = !!best;
    extra.designCoverage = docExists
      ? {
        path: best.f,
        docExists: true,
        kind: kindDims.kind,
        hasSpecific: kindDims.hasSpecific,
        note: kindDims.note,
        base: best.baseCov,
        specific: best.specCov,
      }
      : {
        path: '',
        docExists: false,
        kind: kindDims.kind,
        hasSpecific: kindDims.hasSpecific,
        note: kindDims.note,
        base: { covered: [], missing: baseDims.map((d) => d[0]) },
        specific: { covered: [], missing: specDims.map((d) => d[0]) },
      };

    // ★★ 强证据落判定：创作类任务**一份设计文档都没有** ⇒ G2-1 机械不合格。
    //   老板原话：「最小可运行版本只是验证底座，不等于交付成果」——
    //   只交代码不交设计，就是拿底座当成果。
    //   为什么敢机械判：这里判的不是"设计好不好"，而是"设计文档存不存在"，
    //   是不依赖语义判断的硬事实。至于文档里写得够不够，仍交 G2-1/G2-2 的模型判断。
    //
    //   ⚠️ 只对有交付物的创作类生效。空交付物已在上面的 `!files.length` 分支跳过 ——
    //     "什么都没交"由 G1-4 / G4-1 判，不在这里重复喊。
    if (CHECK.normalizeTaskType(c.taskType) === CHECK.TASK_TYPES.CREATIVE && !docExists) {
      mech['G2-1'] = fail(
        '创作类任务交付了 ' + files.length + ' 个文件，但其中没有任何 .md/.txt 设计推演文档 ⇒ '
        + '只交了「验证底座」，没交设计（最小可运行版本不等于交付成果）'
      );
    }

    // ══════════════ 方案探索与取舍（G2-4）══════════════
    //
    // 【这一条治的是什么】老板原话：「设计能力不能只靠一句'请认真设计'解决」
    //   「至少形成几个有实质区别的方案，而不是换颜色、换标题冒充多个方案」。
    //   G2-1 查「想过哪些维度」，一个方案把 8 个维度全提到就能满分 ——
    //   但「比较并取舍」一步都没做。那是两件不同的事，必须分开判。
    //
    // 【强证据有两条：方案个数 < 2；或两个方案的**分区骨架完全相同**】
    //   数标题是结构事实，不依赖语义判断。
    //   ★ 2026-11-03 补第二条，起因是一次自查发现的漏洞：
    //     原来只数个数 ⇒ 写「方案A：绿色清新风／方案B：蓝色科技风」就能过闸，
    //     而那正是老板点名要治的「换颜色、换标题冒充多个方案」。
    //     实测证据：这两个方案段落的字符 Jaccard 很低（文字几乎不重合）⇒ 老办法抓不到；
    //     但分区骨架都是 nav > hero > cards > footer ⇒ 结构级比对一眼看穿。
    //     **字符相似度对"换皮"是失效的**，因为它抓的是同义改写，不是同构。
    //   similarPairs（字符级）仍然只进 extra 供模型复核 —— 强弱证据分层不变：
    //     "骨架一样"可核对，"文字像"不可核对。
    //
    // ⚠️ 扫**所有** md 文件取方案数最多的那一份，而不是只看覆盖度最高的那份：
    //   实测写法里方案常单独放一个文件（如 design.md + options.md），
    //   只看一份会把「写了三版方案」判成「一版都没有」。宁可多看，不可漏判。
    if (CHECK.normalizeTaskType(c.taskType) === CHECK.TASK_TYPES.CREATIVE) {
      let bestOpt = null;
      for (const f of mdFiles) {
        const src = readTextSafe(f);
        if (src == null) continue;
        const o = parseDesignOptions(src);
        if (!bestOpt || o.count > bestOpt.count || (o.count === bestOpt.count && o.compare && !bestOpt.compare)) {
          bestOpt = { ...o, path: f };
        }
      }
      extra.designOptions = bestOpt || {
        count: 0, ids: [], labels: [], compare: false, compareWhy: '没有任何设计文档',
        chosen: '', chosenWhy: '', similarPairs: [], shapePairs: [], shapes: [], path: '',
      };
      if (bestOpt && bestOpt.count > 0 && bestOpt.count < CHECK.DESIGN_OPTIONS_MIN) {
        mech['G2-4'] = fail(
          '设计文档里只找到 ' + bestOpt.count + ' 个方案（' + (bestOpt.labels[0] || bestOpt.ids[0]) + '）⇒ '
          + '创作类至少要给出 ' + CHECK.DESIGN_OPTIONS_MIN + ' 个结构上真的不同的方案再动手。'
          + '「换颜色 / 换标题 / 同一套做法加个变体」不算第二个方案。'
        );
      } else if (bestOpt && bestOpt.shapePairs && bestOpt.shapePairs.length) {
        // ★★ 方案个数够了，但骨架一模一样 —— 这就是"换颜色冒充两版"。
        //   只在两边都抽得出 ≥3 个分区时才可能有这条读数（见 parseDesignOptions 的保守边界），
        //   所以不会因为"模型没写结构"而误判。
        const p = bestOpt.shapePairs[0];
        mech['G2-4'] = fail(
          '方案 ' + p.a + ' 与方案 ' + p.b + ' 的版面骨架**完全相同**（' + p.shape + '）⇒ '
          + '这是"换颜色 / 换标题冒充两个方案"，不是结构上真的不同。'
          + '结构不同的意思是分区顺序或栏数不同（例：首屏→卡片 与 首屏→左右对开→指标条）。'
        );
      }
      // count === 0 时**不判**：那说明这份文档没按"方案"这个结构写，
      // 到底算不算偷懒需要看内容 —— 硬判会误伤"用别的词表达多版探索"的写法（如「路线A/路线B」）。
      // 这条读数会进 extra，让审查与用户都看得见。
    }
  }

  // ── 补充读数：空壳信号（供判断方参考，只报信号不下结论）──
  // 为什么只报信号：`<button>` 没有 onclick 也可能是事件委托，靠它定罪必然误伤。
  // 这类读数的用途是**提示判断方去看一眼**，不是替他判。
  {
    for (const f of files) {
      if (!/\.(html|htm)$/i.test(f)) continue;
      const src = readTextSafe(f);
      if (src == null) continue;
      const buttons = (src.match(/<button\b/gi) || []).length;
      const handlers = (src.match(/addEventListener|onclick|onClick|@click/g) || []).length;
      if (buttons > 0 && handlers === 0) {
        extra.shellSignals.push(path.basename(f) + '：' + buttons + ' 个 <button> 但零事件绑定（可能是死按钮，需人工确认）');
      }
    }
  }

  return { mech, extra, projectRoot };
}

module.exports = {
  MAX_LINES,
  BOUNDARY_DIMS,
  DESIGN_DIMS,
  DESIGN_SYNONYMS,
  designDimsFor,
  normalizeDeliverables,
  readTextSafe,
  stripComments,
  countAnyUses,
  parseJsonc,
  findTsconfig,
  findE2E,
  coverageOf,
  optionIdOf,
  parseDesignOptions,
  bigramsOf,
  jaccardOf,
  deriveProjectRoot,
  collectAcceptanceReadings,
};
