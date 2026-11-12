/**
 * VideoStudioModel —— 「视频精剪」页（`modules/VideoStudio.jsx`）的**纯函数层**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【这一份文件里只放「能算的东西」，一行 JSX 都不许有】
 *   时间 ↔ 像素映射、吸附、轨道排序、片段命中测试、裁剪钳制、导出参校验……
 *   全部搬到这里，好处有三个，每一个都是踩过坑才认得出来的：
 *
 *   ① **可被 node 直接 import 单测**。本仓 `scripts/smoke/unit-videostudio-model.mjs`
 *      直接 `import` 本文件（不经过 vite / 不经过 jsdom），所以这一层
 *      **绝对不许 `import react`**，也不许 `import '../styles/…css'`
 *      （node 认不出 `.css`，一旦引入，整套单测连启动都起不来）。
 *      这就是「纯函数层」四个字的**可执行含义**，不是一种风格偏好。
 *
 *   ② **时间轴的坐标换算是整页最容易错、又最难在界面上看错的地方**。
 *      `x = sec * pxPerSec - scrollLeft` 这一条写反了（少减一次 scrollLeft、
 *      或者把 `pxPerSec` 乘到 scrollLeft 上），表现是「滚动之后片段整体偏了」，
 *      而且**只在滚动之后**才偏 —— 不滚动怎么点都对。这种错靠人眼看截图是抓不住的，
 *      必须有一个能在 node 里跑、能算出具体数字的纯函数，再由单测逐位比对。
 *
 *   ③ **Concat 的硬约束必须在前端先钳一次**。片段不短于 1/60 秒、不短于媒体的可用长度、
 *      不允许负时长 —— 这些约束 Concat 自己也会拒（它是个 headless 引擎，拒的时候只回一个错），
 *      但**让用户拖到一半才失败**比拖不动糟糕得多。所以 `clampTrim()` 在拖动过程中
 *      就把越界的位移裁掉，用户手上感觉是「拖到头了」，而不是「松手之后弹个错」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【轨道顺序：为什么是「index 降序 = 视觉从上到下」，而不是升序】
 *   主进程回来的 `timeline.tracks` 只有 `{ id, index }`，而 `index` 的语义是
 *   **图层顺序（z-order）：index 越大越在上层**（主进程实测：T1 红底 + T2 蓝图缩 40%
 *   移到右上角，抽帧的右上角是蓝 ⇒ T2 盖住 T1）。
 *   时间轴 UI 的惯例（剪映 / PR / FCP 全都一样）是**上层轨道画在上面那一行**。
 *   两件事合起来 ⇒ 视觉顺序 = index **降序**：第一行是 index 最大的那条轨道。
 *
 *   ⚠️ 这里与任务书正文里「按 index 升序从上往下排」的字面写法**相反**，
 *   以任务书自己给的括注「（index 大的在上面）」为准 —— 那句才是语义，
 *   而且有主进程的抽帧实验作证。`unit-videostudio-model.mjs` 里有一条断言专门钉住
 *   这件事（`rows[0].index` 必须是最大的），谁都改不回去。
 *   另外：**绝不能用数组倒序**（`tracks.slice().reverse()`）。数组顺序是主进程
 *   内部实现细节，将来它换了插入顺序，倒序出来的行就全乱了；只有 `index` 是契约。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么片段是「扁平数组 + clip.track 归属」】
 *   snapshot 里 `timeline.clips` 是扁平的，靠 `clip.track` 认轨道。
 *   前端**不许**把它重组成「每轨一个数组」再存进 state —— 那样每做一次编辑
 *   都要把两套结构对齐一遍（撤销之后由主进程回来的快照是唯一真源，
 *   本地重组出来的副本必然漂移）。所有按轨取片段的动作都走 `clipsOnTrack()`，
 *   它是纯过滤，没有副本、没有缓存、不可能漂。
 */

/* ──────────────────────────────────────────────────────────────────────────
   常量：Concat 的硬约束 + 导出的枚举。**唯一定义处**，JSX 只许 import。
   ────────────────────────────────────────────────────────────────────────── */

/** 片段最短时长（秒）。Concat 硬约束：不短于 1/60 秒（= 一帧 @60fps）。 */
export const MIN_CLIP_SEC = 1 / 60;

/** 横向拖动/定位的吸附网格（秒）。0.1s 是剪映同类产品的手感，也是本页唯一的吸附步长。 */
export const GRID_SEC = 0.1;

/** 时间轴默认缩放（像素/秒）。缩放范围见 `ZOOM_RANGE`。 */
export const DEFAULT_PX_PER_SEC = 40;

/** 缩放上下限（像素/秒）。下限 6 ⇒ 1 分钟的项目只有 360px 宽；上限 320 ⇒ 1 秒占 320px。 */
export const ZOOM_RANGE = { min: 6, max: 320 };

/** 保底可见的时间轴长度（秒）。空工程也要能看见刻度，否则用户不知道该往哪拖。 */
export const MIN_TIMELINE_SPAN_SEC = 10;

/** 关键帧属性枚举（13 个）。**照主进程的 `keyframeSet.property` 词表抄，不许自造。** */
export const KEYFRAME_PROPERTIES = [
  'scale', 'offsetX', 'offsetY', 'rotation', 'opacity', 'volume',
  'maskX', 'maskY', 'maskWidth', 'maskHeight', 'maskRotation', 'maskRoundness', 'maskFeather',
];

/** 关键帧属性的中文名（属性面板的下拉框用；顺序与 `KEYFRAME_PROPERTIES` 一一对应）。 */
export const KEYFRAME_PROPERTY_LABELS = {
  scale: '缩放',
  offsetX: '横向位移',
  offsetY: '纵向位移',
  rotation: '旋转',
  opacity: '不透明度',
  volume: '音量',
  maskX: '蒙版 X',
  maskY: '蒙版 Y',
  maskWidth: '蒙版宽',
  maskHeight: '蒙版高',
  maskRotation: '蒙版旋转',
  maskRoundness: '蒙版圆角',
  maskFeather: '蒙版羽化',
};

/** x264/x265 的 preset 枚举。**顺序即速度由快到慢**，与 ffmpeg 文档一致。 */
export const EXPORT_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow',
];

/** 导出编码器枚举。`h264` 是兼容性最好的默认值（微信/手机/网页都能直接播）。 */
export const EXPORT_CODECS = ['h264', 'hevc'];

/** 导出参数的默认值。**任何一项缺省都落到这里**，界面上的初值也取这里。 */
export const DEFAULT_EXPORT_OPTIONS = {
  crf: 23,
  preset: 'medium',
  codec: 'h264',
  width: 1920,
  height: 1080,
};

/** 导出分辨率上限（宽/高各自的硬上限）。4K 是 3840，7680 已经给了 8K 的余量。 */
export const MAX_EXPORT_EDGE = 7680;

/* ──────────────────────────────────────────────────────────────────────────
   小工具
   ────────────────────────────────────────────────────────────────────────── */

/** 把任意输入压成一个**有限数**，否则给兜底值。NaN/Infinity/字符串全走兜底。 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 严格版 `num`：`null` / `undefined` / `''` 一律当**缺失**（返回 NaN），不折成 0。
 *
 * 为什么非要有这一条：`Number(null) === 0`、`Number('') === 0`。
 * 用 `num()` 判「有没有这个数」会把「主进程返回了 `fraction: null`（= 暂时算不出百分比）」
 * 误读成「进度是 0%」，于是界面画一条 0% 的空条 —— 正是老板骂过的那种误导。
 * 所以凡是「缺省 ≠ 0」的字段（进度、帧数）必须走这一条。
 */
function optNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  return num(v, NaN);
}

/** 把数字夹在 [lo, hi] 之间。 */
function clampNum(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * 抹掉浮点尾数（10 位小数）。
 *
 * 为什么需要：`Math.round(0.25 / 0.1) * 0.1` 得到 `0.30000000000000004`。
 * 这个数直接写进 `concatEdit` 的 `start` 里，Concat 会照收（它能接受任意浮点），
 * 但界面上的时间码会显示成 `00:00.3` 而内部是 `0.30000000000000004`，
 * 下一次吸附再叠一次误差 ⇒ 片段的边界会缓慢漂移，撤销一次就对不上。
 * 10 位小数远小于任何一帧的时长（1/60 ≈ 0.0167），所以抹掉是安全的。
 */
function tidy(v) {
  return Math.round(v * 1e10) / 1e10;
}

/* ──────────────────────────────────────────────────────────────────────────
   1. 轨道排序 —— 视觉从上到下
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 把主进程回的 `tracks` 排成**视觉行序**（第 0 行 = 时间轴最上面那一条）。
 *
 * `index` 是图层顺序（越大越在上层），而时间轴把上层画在上面 ⇒ 按 index **降序**。
 * 详见文件头「轨道顺序」一段。返回值不修改入参（每次都是新对象）。
 *
 * @param {Array<{id:string,index:number}>} tracks 主进程回的轨道数组（顺序不可信）
 * @returns {Array<{id:string,index:number,displayRow:number}>} 视觉行序，displayRow 从 0 起
 */
export function sortTracksForDisplay(tracks) {
  const arr = Array.isArray(tracks) ? tracks : [];
  const cleaned = arr
    .filter((t) => t && typeof t === 'object' && t.id !== undefined && t.id !== null)
    .map((t) => ({ id: String(t.id), index: num(t.index, 0) }));
  // 降序：index 大的排前面。同 index 时按 id 字典序兜底 —— 保证排序**确定**，
  // 否则 Array.prototype.sort 在等值项上的相对顺序依赖引擎实现，刷新一次就可能换行。
  cleaned.sort((a, b) => (b.index - a.index) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cleaned.map((t, i) => ({ ...t, displayRow: i }));
}

/**
 * 推断某条轨道是视频轨还是音频轨。
 *
 * 为什么只能「推断」：snapshot 的 `tracks` 只有 `{id,index}`，**没有 kind 字段**。
 * 但每个 clip 有 `kind`（'video' | 'audio' | 'image' | 'title' …）。
 * 所以规则是：这条轨道上**所有**片段都是 `audio` ⇒ 音频轨；否则视频轨。
 * 空轨道按视频轨算（新建的空轨默认是视频轨，音频轨在界面上另有 `+ 音频轨` 的入口）。
 *
 * 这是**显示层**的推断，只影响轨道前面的 `V2` / `A1` 标签和配色，
 * 不参与任何编辑决策 —— 缩写成一句话：猜错了只是标签难看，不会改错东西。
 *
 * @param {string} trackId
 * @param {Array<{track:string,kind:string}>} clips 扁平片段数组
 * @returns {'audio'|'video'}
 */
export function trackKindOf(trackId, clips) {
  const on = (Array.isArray(clips) ? clips : []).filter((c) => c && String(c.track) === String(trackId));
  if (!on.length) return 'video';
  return on.every((c) => String(c.kind) === 'audio') ? 'audio' : 'video';
}

/**
 * 轨道行首的短标签：`V2` / `A1`。
 *
 * 用轨道自己的 `index` 而不是 `displayRow`：`index` 是图层号，用户的心智是
 * 「V2 盖住 V1」，而行号会随着「加一条轨」整体变化，用它当标签会让所有轨道改名。
 *
 * @param {{id:string,index:number}} track
 * @param {Array} clips
 * @returns {string}
 */
export function trackLabelFor(track, clips) {
  const t = track && typeof track === 'object' ? track : {};
  const kind = trackKindOf(t.id, clips);
  const prefix = kind === 'audio' ? 'A' : 'V';
  return prefix + String(num(t.index, 0));
}

/* ──────────────────────────────────────────────────────────────────────────
   2. 时间 ↔ 像素
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 秒 → 时间轴内的横向像素（相对**可视区左边缘**）。
 *
 * 公式：`x = sec * pxPerSec - scrollLeft`。
 * `scrollLeft` 必须减（不是加）：时间轴是一个 `overflow-x:auto` 的容器，
 * 内部轨道的 `left` 是相对于**内容**的，而鼠标事件的 `clientX` 是相对于**视口**的。
 * 两套坐标系之间的差就是 `scrollLeft`，忘了减，滚动之后片段会整体往右偏一个滚动量。
 *
 * @param {number} sec
 * @param {{pxPerSec?:number, scrollLeft?:number}} opts
 * @returns {number}
 */
export function secondsToX(sec, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const px = num(o.pxPerSec, DEFAULT_PX_PER_SEC);
  const sl = num(o.scrollLeft, 0);
  return tidy(num(sec, 0) * px - sl);
}

/**
 * 时间轴内的横向像素 → 秒。`secondsToX` 的逆运算。
 *
 * @param {number} x 相对可视区左边缘的像素
 * @param {{pxPerSec?:number, scrollLeft?:number}} opts
 * @returns {number}
 */
export function xToSeconds(x, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const px = num(o.pxPerSec, DEFAULT_PX_PER_SEC);
  const sl = num(o.scrollLeft, 0);
  if (px <= 0) return 0;
  return tidy((num(x, 0) + sl) / px);
}

/**
 * 吸附到网格（默认 0.1s 网格）。
 *
 * 为什么一定要吸附：不吸附的话，一次拖动会产生 `3.7421875` 这种数，
 * Concat 能收，但用户事后永远对不齐两个片段的首尾 —— 差 0.03 秒在黑场里是一帧白闪。
 * 剪映同类产品全都吸附到 0.1s，这是行业手感，不是偷懒。
 *
 * 边界：`grid <= 0` / 非数 ⇒ 原样返回（**退化为不吸附**，而不是返回 0）。
 * 返回 0 会把所有片段吸到时间轴零点，那是灾难性的。
 *
 * @param {number} sec
 * @param {number} [grid]
 * @returns {number}
 */
export function snapToGrid(sec, grid) {
  const g = num(grid, GRID_SEC);
  const s = num(sec, 0);
  if (!(g > 0)) return tidy(s);
  return tidy(Math.round(s / g) * g);
}

/* ──────────────────────────────────────────────────────────────────────────
   3. 片段查询 / 命中测试
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 取某条轨道上的全部片段，按 `start` 升序（同 start 时按 id 兜底，保证确定）。
 *
 * **返回的是过滤出来的引用，不是深拷贝** —— 调用方只读。这样点击命中测试
 * 拿到的一定是 state 里那个对象本身，`===` 比较能直接用。
 *
 * @param {Array<object>} clips 扁平片段数组
 * @param {string} trackId
 * @returns {Array<object>}
 */
export function clipsOnTrack(clips, trackId) {
  const arr = Array.isArray(clips) ? clips : [];
  const id = String(trackId);
  return arr
    .filter((c) => c && String(c.track) === id)
    .sort((a, b) => (num(a.start, 0) - num(b.start, 0))
      || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

/**
 * 命中测试：某轨在某时刻命中了哪个片段。
 *
 * 区间取 **左闭右开** `[start, end)`。为什么不是闭区间：
 *   两个片段首尾相接时（前一个 end === 后一个 start），闭区间会让**两个都命中**，
 *   「点一下选中谁」就变成靠遍历顺序决定 —— 用户点一百次可能选到两个不同的东西。
 *   左闭右开让交接点恒定归右边那个，符合「点在切口上 = 想选后一段」的直觉。
 *
 * 同轨重叠时取**最靠后的那个**（start 大的赢；start 相同时数组里靠后的赢）。
 * 为什么是「最靠后的」而不是「最靠前的」：片段是按添加顺序追加的，
 * 后加的在视觉上压在先加的上面（时间轴里重叠片段的绘制顺序 = 数组顺序），
 * 所以「最后命中」= 「用户看见的最上层那块」。这和 `sortTracksForDisplay` 的
 * 「上层在视觉上优先」是同一条原则的两个面。
 *
 * @param {Array<object>} clips 扁平片段数组
 * @param {string} trackId
 * @param {number} sec
 * @returns {object|null}
 */
export function clipHitTest(clips, trackId, sec) {
  // 时刻必须是**有限数**。NaN 不许被兜成 0 —— 兜成 0 会让「算不出时刻」这种程序错误
  // 表现成「选中了 0 秒处那一段」，用户以为自己点错了，而真因是一个 NaN 在往上冒。
  const raw = Number(sec);
  if (!Number.isFinite(raw)) return null;
  const t = raw;
  const on = clipsOnTrack(clips, trackId);
  let hit = null;
  for (const c of on) {
    const s = num(c.start, 0);
    const e = num(c.end, s);
    if (t >= s && t < e) hit = c;
  }
  return hit;
}

/**
 * 时间轴总长度 = 所有片段 `end` 的最大值（空工程给 0）。
 *
 * 为什么不用 `timeline.duration`：那个字段由主进程算，但**用户拖完还没松手**、
 * 或者本地做了一次乐观更新时，它可能比片段实际末端短。取两者较大值，
 * 保证「最后一段永远在可视范围里」。见 `timelineSpanOf()`。
 *
 * @param {Array<object>} clips
 * @returns {number}
 */
export function estimateTimelineDuration(clips) {
  const arr = Array.isArray(clips) ? clips : [];
  let max = 0;
  for (const c of arr) {
    if (!c) continue;
    const e = num(c.end, num(c.start, 0) + num(c.duration, 0));
    if (e > max) max = e;
  }
  return tidy(max);
}

/**
 * 时间轴**该画多长**（刻度尺的跨度）：
 *   主进程给的 duration 与「片段实际末端」取大，再与 `MIN_TIMELINE_SPAN_SEC` 取大。
 * 合成一个函数是为了让 JSX 只调一次、只算一次，避免两处各算一套而后不一致。
 *
 * @param {{duration?:number}} timeline
 * @param {Array<object>} clips
 * @returns {number}
 */
export function timelineSpanOf(timeline, clips) {
  const dur = num(timeline && timeline.duration, 0);
  const est = estimateTimelineDuration(clips);
  const span = Math.max(dur, est, MIN_TIMELINE_SPAN_SEC);
  return tidy(span);
}

/* ──────────────────────────────────────────────────────────────────────────
   4. 刻度尺
   ────────────────────────────────────────────────────────────────────────── */

/** 刻度步长候选（秒）。从密到疏，挑第一个「标签放得下」的。 */
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

/** 两个主刻度标签之间至少要有多少像素，否则文字会叠在一起变成一团墨。 */
const RULER_MIN_LABEL_PX = 56;

/** 每多少个刻度出一个「主刻度」（更高的刻线 + 文字标签）。 */
const RULER_MAJOR_EVERY = 5;

/**
 * 生成刻度尺上的刻线。
 *
 * 步长是**自适应**的：同一个 `duration` 在 6px/s（缩到最小）和 320px/s（放到最大）下，
 * 步长必须差两个数量级，否则要么糊成一片、要么 3 个刻度撑满一屏。
 * 判据是 `step * pxPerSec >= 56px`（一个 `00:00` 标签大约要这么宽）。
 *
 * `major` 标记每 5 个刻线里的第 1 个（含第 0 个），主刻度画高刻线 + 文字。
 * `label` 用 `formatTimecode`，与时间码显示同一套格式 —— 两处格式不一致
 * 会让用户对不上「尺子上写 01:05.0、下面时间码写 1:05」。
 *
 * 边界：duration <= 0 / pxPerSec <= 0 ⇒ 返回空数组（**不是**一个 0 刻度）。
 * 返回 `[{sec:0}]` 会让调用方以为「有一根刻线」，而实际上尺子是空的。
 *
 * @param {number} duration 秒
 * @param {number} pxPerSec
 * @returns {Array<{sec:number, label:string, major:boolean}>}
 */
export function buildRulerTicks(duration, pxPerSec) {
  const dur = num(duration, 0);
  const px = num(pxPerSec, DEFAULT_PX_PER_SEC);
  if (!(dur > 0) || !(px > 0)) return [];
  let step = RULER_STEPS[RULER_STEPS.length - 1];
  for (const s of RULER_STEPS) {
    if (s * px >= RULER_MIN_LABEL_PX) { step = s; break; }
  }
  const ticks = [];
  // 上限防呆：极端参数（duration 十小时 + 步长 0.1）下循环会生成 36 万个刻度，
  // 直接把渲染进程打死。2000 根刻线已经远超一屏能显示的密度，够用且安全。
  const MAX_TICKS = 2000;
  // 用「整数索引 × 步长」累加，而不是 `sec += step` 一路加下去 —— 后者叠 2000 次
  // 浮点误差能漂到 0.05 秒，刻度会和片段对不上。
  const count = Math.min(Math.floor(dur / step) + 1, MAX_TICKS);
  for (let i = 0; i < count; i += 1) {
    const sec = tidy(i * step);
    ticks.push({
      sec,
      label: formatTimecode(sec),
      major: i % RULER_MAJOR_EVERY === 0,
    });
  }
  return ticks;
}

/* ──────────────────────────────────────────────────────────────────────────
   5. 时间码
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 秒 → `MM:SS.d`（一位小数，剪映同款口径）。
 *
 * ⚠️ 必须先把秒换成**整十分之一秒**再拆位，不能分别 `Math.floor(sec/60)` 和
 * `Math.round(sec%60)`。后者的经典坏法：59.96 秒 ⇒ 分 0、秒 round(59.96)=60
 * ⇒ 显示 `00:60.0`。先量化到 600 个十分之一秒再拆，进位自然发生 ⇒ `01:00.0`。
 *
 * 负数 / NaN / Infinity 一律按 0 处理：时间码是给人读的，`-00:00.3` 没有任何意义，
 * 而 `NaN:NaN` 会让人以为程序坏了。
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatTimecode(sec) {
  const s = Math.max(0, num(sec, 0));
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const ss = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(d);
}

/**
 * 秒 → `12.3s` 这类**时长**文案（素材列表用）。
 * 与 `formatTimecode` 分开：素材的时长不需要「分:秒.十分位」那么正式，
 * 而时间轴的时间码需要。两处混用会让素材列表里出现一堆 `00:03.4`，很吵。
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  const s = Math.max(0, num(sec, 0));
  if (s < 60) return (Math.round(s * 10) / 10).toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const r = Math.round((s - m * 60) * 10) / 10;
  return m + 'm' + String(Math.round(r)).padStart(2, '0') + 's';
}

/**
 * 字节 → 人类可读（导出结果的「共 12.3 MB」）。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const b = num(bytes, 0);
  if (b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (Math.round(v * 10) / 10) + ' ' + units[i];
}

/* ──────────────────────────────────────────────────────────────────────────
   6. 裁剪钳制 —— Concat 的硬约束在前端先钳一次
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 把「用户拖出来的裁剪位移」钳到合法范围内。
 *
 * 参数语义（与 `concatEdit` 的 `clipTrim` 完全一致）：
 *   `delta` 是**正数**表示「往右缩」——
 *     · `edge === 'start'`：片段起点右移 delta ⇒ 片段变短，`sourceStart` 也右移 delta；
 *     · `edge === 'end'`：片段终点右移 delta ⇒ 片段变长。
 *   负数表示反向。
 *
 * 五条硬约束（前三条来自 Concat，后两条来自「时间轴不能出现负数」）：
 *   C1 新时长 ≥ `MIN_CLIP_SEC`（1/60 秒）—— Concat 拒绝更短的片段；
 *   C2 start 边左拖时，`sourceStart + delta >= 0` —— 不能从媒体开头之前取材；
 *   C3 end 边右拖时，`sourceStart + 新时长 <= mediaDuration` —— 不能超出媒体长度；
 *   C4 片段起点 `start >= 0` —— 时间轴零点左边没有东西；
 *   C5 片段终点 `end >= MIN_CLIP_SEC` —— 由 C1 + C4 共同保证，这里再挡一次。
 *
 * 返回 `{ delta }`：被钳之后**实际允许**的位移。`reason` 只在钳制真的发生时出现，
 * 界面据此把光标/提示改成「到头了」，而不是静默吞掉用户的拖动。
 * `reason === undefined` ⇒ 原样通过，界面什么都不用显示。
 *
 * `mediaDuration` 传 `null`/`undefined`（标题片段、或者拿不到媒体时长）时跳过 C3。
 * 跳过是**有意的**：宁可让 Concat 事后拒一次，也不要因为拿不到时长就把用户的拖动
 * 死死锁在某个猜出来的上限上。
 *
 * @param {object} clip 片段（需要 start/end/duration/sourceStart，缺省按安全默认值）
 * @param {'start'|'end'} edge
 * @param {number} deltaSec 用户拖出来的位移（秒），正数 = 往右
 * @param {number|null} [mediaDuration] 该片段取材的媒体总时长（秒）
 * @returns {{delta:number, reason?:string}}
 */
export function clampTrim(clip, edge, deltaSec, mediaDuration) {
  const c = clip && typeof clip === 'object' ? clip : {};
  const start = num(c.start, 0);
  const dur = Math.max(MIN_CLIP_SEC, num(c.duration, num(c.end, start) - start));
  const srcStart = num(c.sourceStart, 0);
  const delta = num(deltaSec, 0);
  const mediaDur = mediaDuration === null || mediaDuration === undefined
    ? null
    : num(mediaDuration, NaN);

  if (edge === 'end') {
    // C1：新时长 = dur + delta >= MIN
    let lo = MIN_CLIP_SEC - dur;
    // C3：sourceStart + dur + delta <= mediaDur ⇒ delta <= mediaDur - srcStart - dur
    let hi = Number.POSITIVE_INFINITY;
    if (Number.isFinite(mediaDur) && mediaDur > 0) hi = mediaDur - srcStart - dur;
    let d = delta;
    let reason;
    if (d < lo) { d = lo; reason = 'min-duration'; }
    if (d > hi) { d = hi; reason = 'media-end'; }
    // 极端情形：媒体本身就比 MIN 还短（1/60 秒的素材），lo 可能 > hi。
    // 此时以 C1 为准（Concat 对「太短」的拒绝是无条件的），并把结果兜回 0 位移，
    // 免得返回一个负位移反而把片段弄得更短。
    if (lo > hi) { d = 0; reason = 'media-end'; }
    return reason ? { delta: tidy(d), reason } : { delta: tidy(d) };
  }

  // edge === 'start'（默认走这里：非法 edge 一律按 start 处理，比抛错安全）
  let lo = -Number.MAX_SAFE_INTEGER;
  let hi = Number.POSITIVE_INFINITY;
  const reasons = [];
  // C1：新时长 = dur - delta >= MIN ⇒ delta <= dur - MIN
  const c1 = dur - MIN_CLIP_SEC;
  if (c1 < hi) hi = c1;
  // C2：srcStart + delta >= 0 ⇒ delta >= -srcStart
  if (-srcStart > lo) lo = -srcStart;
  // C4：start + delta >= 0 ⇒ delta >= -start
  if (-start > lo) lo = -start;
  let d = delta;
  if (d > hi) { d = hi; reasons.push('min-duration'); }
  if (d < lo) {
    d = lo;
    // 分辨「卡在哪」：是被时间轴零点挡住（-start 更大）还是被媒体开头挡住。
    reasons.push(-start >= -srcStart ? 'timeline-zero' : 'media-start');
  }
  if (lo > hi) { d = 0; reasons.push('min-duration'); }
  return reasons.length ? { delta: tidy(d), reason: reasons[0] } : { delta: tidy(d) };
}

/**
 * 裁剪提示的中文文案（界面用）。未知原因不显示任何东西（返回空串）。
 * @param {string} reason
 * @returns {string}
 */
export function describeTrimReason(reason) {
  switch (String(reason || '')) {
    case 'min-duration': return '片段已到最短（1/60 秒）';
    case 'media-end': return '已到素材末尾';
    case 'media-start': return '已到素材开头';
    case 'timeline-zero': return '已到时间轴起点';
    default: return '';
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   7. 导出参数校验
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 校验导出选项，返回 `{ ok, errors: string[], value }`。
 *
 * `value` 永远是一个**填满默认值**的合法对象（哪怕 `ok === false`），
 * 这样界面在报错的同时还能把输入框回填成上次的值，而不是清空 —— 清空会让用户
 * 以为自己的设置丢了，然后重新填一遍。
 *
 * 为什么 crf 上限是 255 而不是 51：ffmpeg 的 `-crf` 对 x264/x265 实际是 0~51，
 * 但 Concat 的主进程契约写的是 0~255（它把 crf 透传给不同编码器，hevc 的
 * 某些封装接受更宽的范围）。前端**按契约校验**，不自作聪明收紧 —— 收紧了就等于
 * 「主进程能接受的参数，界面先拦掉了」，那是更难查的错。
 *
 * 宽高的额外要求是**偶数**：H.264/H.265 的 4:2:0 色度抽样要求宽高均为偶数，
 * 奇数宽高的结果不是报错而是「宽度悄悄变成奇数-1」，用户拿到的 mp4 尺寸
 * 和自己填的不一样。所以前端直接拦，并说清为什么。
 *
 * @param {{crf?:number,preset?:string,codec?:string,width?:number,height?:number}} opts
 * @returns {{ok:boolean, errors:string[], value:{crf:number,preset:string,codec:string,width:number,height:number}}}
 */
export function validateExportOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const errors = [];

  const crfRaw = o.crf === undefined || o.crf === null || o.crf === '' ? DEFAULT_EXPORT_OPTIONS.crf : o.crf;
  const crf = num(crfRaw, NaN);
  if (!Number.isFinite(crf)) errors.push('CRF 必须是数字（0~255）');
  else if (crf < 0 || crf > 255) errors.push('CRF 必须在 0~255 之间');
  else if (Math.round(crf) !== crf) errors.push('CRF 必须是整数');

  const presetRaw = o.preset === undefined || o.preset === null || o.preset === '' ? DEFAULT_EXPORT_OPTIONS.preset : o.preset;
  const preset = String(presetRaw);
  if (!EXPORT_PRESETS.includes(preset)) errors.push('preset 只能是 ' + EXPORT_PRESETS.join(' / '));

  const codecRaw = o.codec === undefined || o.codec === null || o.codec === '' ? DEFAULT_EXPORT_OPTIONS.codec : o.codec;
  const codec = String(codecRaw);
  if (!EXPORT_CODECS.includes(codec)) errors.push('编码只能是 ' + EXPORT_CODECS.join(' / '));

  const checkEdge = (label, raw, def) => {
    const v = raw === undefined || raw === null || raw === '' ? def : raw;
    const n = num(v, NaN);
    if (!Number.isFinite(n)) { errors.push(label + '必须是数字'); return def; }
    if (n !== Math.round(n)) { errors.push(label + '必须是整数'); return Math.round(n); }
    if (n < 2) { errors.push(label + '不能小于 2'); return Math.max(2, n); }
    if (n > MAX_EXPORT_EDGE) { errors.push(label + '不能超过 ' + MAX_EXPORT_EDGE); return Math.min(n, MAX_EXPORT_EDGE); }
    if (n % 2 !== 0) { errors.push(label + '必须是偶数（H.264 的色度抽样要求）'); return n - 1; }
    return n;
  };
  const width = checkEdge('宽度', o.width, DEFAULT_EXPORT_OPTIONS.width);
  const height = checkEdge('高度', o.height, DEFAULT_EXPORT_OPTIONS.height);

  return {
    ok: errors.length === 0,
    errors,
    value: {
      crf: Number.isFinite(crf) ? clampNum(Math.round(crf), 0, 255) : DEFAULT_EXPORT_OPTIONS.crf,
      preset: EXPORT_PRESETS.includes(preset) ? preset : DEFAULT_EXPORT_OPTIONS.preset,
      codec: EXPORT_CODECS.includes(codec) ? codec : DEFAULT_EXPORT_OPTIONS.codec,
      width,
      height,
    },
  };
}

/**
 * 导出阶段 → 中文。
 *
 * 为什么必须翻译：`stage` 是 Concat 内部流水线的原文（`cutout` / `mixing audio` /
 * `muxing` …），直接把英文摆到界面上，用户只会觉得「这软件怎么还没汉化」。
 * 未知阶段**原样返回**而不是塞一个「处理中」—— 推进度条的组件要能看见
 * 「主进程报了一个我不认识的阶段」，那说明主进程加了新阶段，界面该补翻译，
 * 统一显示「处理中」会把这个信号彻底埋掉。
 *
 * @param {string} stage
 * @returns {string}
 */
export function describeExportStage(stage) {
  const raw = String(stage === undefined || stage === null ? '' : stage).trim();
  if (!raw) return '处理中';
  const key = raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  switch (key) {
    case 'probe': case 'probing': case 'analyze': case 'analyzing': return '解析素材';
    case 'cutout': case 'matte': return '抠像';
    case 'stabilize': case 'stabilizing': case 'stabilise': return '稳定';
    case 'render': case 'rendering': case 'encode': case 'encoding': return '渲染';
    case 'mixing audio': case 'audio': case 'mixing': case 'mix': return '混音';
    case 'mux': case 'muxing': case 'mux audio': return '封装';
    case 'cut': case 'cutting': case 'trim': return '裁剪';
    case 'concat': case 'joining': return '拼接';
    case 'queued': case 'pending': case 'waiting': return '排队中';
    case 'done': case 'finished': case 'complete': case 'completed': return '完成';
    case 'canceled': case 'cancelled': return '已取消';
    case 'failed': case 'error': return '失败';
    default: return raw;
  }
}

/**
 * 导出进度百分比（0~100 的整数），拿不到可信数字时返回 `null`。
 *
 * **`null` 与 `0` 是两件事**，这一条是刻意区分的（老板此前为「没有百分比进度条」
 * 骂过一轮，那一轮的教训是：拿不到数字时画一条 0% 的空条，用户会以为任务卡住了，
 * 比不画条更误导）。所以：
 *   · `fraction` 是有限数 ⇒ 用它；
 *   · 否则若 `framesTotal > 0` ⇒ 用 `framesDone / framesTotal`；
 *   · 都拿不到 ⇒ `null`，界面**不渲染**进度条，只显示阶段文字。
 *
 * @param {{fraction?:number, framesDone?:number, framesTotal?:number}} status
 * @returns {number|null}
 */
export function exportPercent(status) {
  const s = status && typeof status === 'object' ? status : {};
  const f = optNum(s.fraction);
  if (Number.isFinite(f)) return clampNum(Math.round(f * 100), 0, 100);
  const done = optNum(s.framesDone);
  const total = optNum(s.framesTotal);
  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
    return clampNum(Math.round((done / total) * 100), 0, 100);
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
   8. 导出状态归一化
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 导出状态的归一化小写值。
 *
 * ⚠️ 为什么不能直接 `state === 'running'`：`state` 是 Concat **原样透传**上来的
 * （主进程 `concatStudio.exportStatus()` 里就是 `String(d.state || '')`，没做大小写归一），
 * 实测可能是 `running` / `RUNNING` / `Rendering` 里的任意一种。
 * 只要一个的大小写对不上，「继续轮询」的判据立刻失效 ⇒ 导出在第一次查询后就停住，
 * 进度条永远不动，而日志里一个字都没有 —— 本仓最忌讳的那种「静默坏掉」。
 *
 * @param {string} s
 * @returns {string}
 */
export function normState(s) {
  return String(s === undefined || s === null ? '' : s).trim().toLowerCase();
}

/** 终态集合：落到这些状态才算这次导出结束（不再轮询）。 */
export const TERMINAL_STATES = [
  'done', 'finished', 'complete', 'completed', 'failed', 'error', 'canceled', 'cancelled',
];

/**
 * 是否是终态。
 *
 * 调用方的判据必须是「**不是终态就继续轮询**」，而不是「等于 running 才继续」：
 * 未知状态 / 空字符串一律按「还在跑」处理，另有 1 小时上限兜底。
 * 「保守地继续」比「乐观地停」安全一个数量级 —— 停早了用户只能重开一次导出。
 *
 * @param {string} s 原始 state
 * @returns {boolean}
 */
export function isTerminalState(s) {
  return TERMINAL_STATES.indexOf(normState(s)) >= 0;
}

/* ──────────────────────────────────────────────────────────────────────────
   9. 媒体辅助
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 媒体类型 → 图标。主进程给 `kind`（'video' | 'audio' | 'image'），
 * 但**不保证**枚举封闭（未来可能有 'gif' / 'seq'），所以默认落 `🎞`。
 * @param {string} kind
 * @returns {string}
 */
export function mediaIcon(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'audio': return '🎵';
    case 'image': return '🖼';
    case 'video': return '🎞';
    default: return '🎞';
  }
}

/**
 * 媒体是否带音轨。`hasAudio` 可能缺省（主进程没探到），此时按「未知」处理：
 * 只有明确 `true` 才算有音轨 —— 自动分离音轨的询问框据此决定要不要弹。
 * @param {{hasAudio?:boolean, kind?:string}} media
 * @returns {boolean}
 */
export function mediaHasAudio(media) {
  const m = media && typeof media === 'object' ? media : {};
  if (m.hasAudio === true) return true;
  return false;
}

/** 媒体查找表：id → media。JSX 里每次按 mediaId 拿媒体都走它，避免各处 `find` 写歪。 */
export function indexMedia(media) {
  const map = new Map();
  const arr = Array.isArray(media) ? media : [];
  for (const m of arr) {
    if (m && m.id !== undefined && m.id !== null) map.set(String(m.id), m);
  }
  return map;
}

/** 按 id 取媒体（找不到返回 null）。 */
export function findMedia(mediaOrMap, mediaId) {
  if (!mediaId && mediaId !== 0) return null;
  const key = String(mediaId);
  if (mediaOrMap instanceof Map) return mediaOrMap.get(key) || null;
  const arr = Array.isArray(mediaOrMap) ? mediaOrMap : [];
  for (const m of arr) {
    if (m && String(m.id) === key) return m;
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
   10. 「一键铺开」：按素材类型分组 + 选轨
   ──────────────────────────────────────────────────────────────────────────
   下面这段是全仓唯一有**实测证据**支撑的 Concat 行为记录，改动前请先读完。

   探针（真跑 concat.exe，非推断）测出 `clips_add_sequence` 的语义：
     · `start` 是**第一段**的起点，后续片段按各自 duration 首尾相接
       （实测：两段 1s/2s 从 start=0 铺 ⇒ start 0 / 1；从 start=5 铺 ⇒ 5 / 6）。
     · 不给 `trackId` ⇒ 落在**最低 index 的轨道**上，**不会**自动建轨。
     · 轨道**没有类型字段**（`tracks[]` 里只有 `{id, index}`）。所谓「音频轨」只是
       界面约定，引擎层面任意轨都能放任意片段。
     · 视频 + 纯音频混在一个数组里**不报错**，会全部堆到同一条轨上
       （实测：audio 片段落在 T1，kind:'audio' 挂在视频轨里）。
       ⇒ 所以 UI 必须**自己按类型分组**，不能把素材库整个丢进去。
     · `start` 与已有片段**重叠**时，Concat 会把新片段顺延到不重叠处
       （实测：T4 已有 0~3 的音频，再以 start=0 铺视频 ⇒ 落到 start=3）；
       不重叠时 `start` 原样作数（实测：空轨 start=0 → 0，非空轨 start=7 → 7）。
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 把素材库按「该进哪类轨」分成两组。
 *
 * `image` 归到 visual：图片也是画面素材，剪映里同样上 V 轨。
 * `kind` 缺省按 `video` 处理（与 `mediaIcon` 的兜底口径一致）。
 * 保持**原有顺序** —— 用户看到的素材库顺序就是他期望的成片顺序。
 *
 * @param {Array<{id:string,kind?:string}>} mediaList
 * @returns {{visual:Array, audio:Array}} 两个新数组，不改动入参
 */
export function splitMediaByKind(mediaList) {
  const visual = [];
  const audio = [];
  const arr = Array.isArray(mediaList) ? mediaList : [];
  for (const m of arr) {
    if (!m || m.id === undefined || m.id === null) continue;
    if (String(m.kind || 'video').toLowerCase() === 'audio') audio.push(m);
    else visual.push(m);
  }
  return { visual, audio };
}

/**
 * 为某一类素材挑一条轨道 id；挑不到返回 `null`（调用方负责建轨）。
 *
 * 规则与理由：
 *   · 只认 `trackKindOf` 推断出来的同类轨（空轨算视频轨，见该函数注释）；
 *   · 多条同类轨时取 **index 最小**的那条 —— 剪映的默认落点是主轨（V1 / A1，
 *     也就是最下面那条）。取最小 index 而不是「优先空轨」：优先空轨会导致
 *     连点两次「一键铺开」第二次跑到 V2 去，用户看到的是片段莫名分家。
 *   · **不在这里兜底造轨** —— 纯函数不该有副作用；建轨由 UI 明确发 `addTrack`，
 *     这样「点一下按钮到底是几个 IPC」在 JSX 里看得见。
 *
 * @param {Array<{id:string,index:number}>} tracks
 * @param {Array} clips 扁平片段数组（用于推断轨道类型）
 * @param {'video'|'audio'} kind
 * @returns {string|null}
 */
export function pickTrackForKind(tracks, clips, kind) {
  const want = kind === 'audio' ? 'audio' : 'video';
  const arr = Array.isArray(tracks) ? tracks : [];
  let best = null;
  let bestIndex = Infinity;
  for (const t of arr) {
    if (!t || t.id === undefined || t.id === null) continue;
    if (trackKindOf(t.id, clips) !== want) continue;
    const idx = optNum(t.index);
    const key = Number.isFinite(idx) ? idx : 0;
    if (best === null || key < bestIndex) {
      best = String(t.id);
      bestIndex = key;
    }
  }
  return best;
}

/* ──────────────────────────────────────────────────────────────────────────
   11. 分离音频（剪映的「分离音频」）—— 「能不能分离」与「分离之后怎么读回结果」
   ──────────────────────────────────────────────────────────────────────────
   底层能力是 Concat 的原生命令 `edit_apply {op:'detachAudio', clipId}`
   （主进程 `EDIT_OPS.clipDetachAudio`）。它做三件事：把视频片段的音轨拆成一条
   独立的 `kind:'audio'` 片段（落到一条空着的轨上）、把原视频**静音**、把音频
   滤镜搬到新片段上。实测形状：`c2(video,T1,0→2)` → `c2.muted=true` +
   `c3(audio,T2,0→2,media 同源)`，返回 `createdId === 'c3'`。

   ⚠️ 三条实测事实决定了下面这两个函数必须存在（都不是假想的防御）：
     ① **对没有声音的片段，这条命令是静默 no-op**：`isError:false`、无 `createdId`、
        clips 数量不变、`muted` 也不置。真跑过无声 mp4 与 png 各一次。
        主进程已经用 `requireCreated` 把它翻成 `ok:false`，但**在点之前**就该
        告诉用户"这段没音轨"—— 那是 `canDetachAudio()` 的职责，它省掉一次
        必然失败的 IPC，而不是替代主进程的判定。
     ② **落到哪条轨是引擎决定的**（"a free lane, minting one if none is free"），
        前端不预测、只读回。所以 `findDetachedAudioClip()` 是**事后**从快照里认人。
     ③ **音频片段与源片段共用同一个 `media`**，所以「哪个新片段是这次拆出来的」
        只能靠「id 不在分离前的那份清单里」来认，不能靠 media 认（同一素材可能
        在时间轴上已经有好几段）。
   ────────────────────────────────────────────────────────────────────────── */

/** 新标题的默认时长（秒）。与 `CAPTION_SEC` 同一套手感：够读一句话，又不用马上改。 */
export const DEFAULT_TITLE_SEC = 3;

/**
 * 标题文字上限（字符）。**与主进程的 `TITLE_MAX_CHARS` 是同一个数**：
 * 界面在这里拦住是为了让"输入框里能看到自己超了多少"，主进程那边是最后一道闸。
 */
export const MAX_TITLE_CHARS = 500;

/**
 * 规范化用户输入的标题文字。**必须与主进程的 `normalizeTitleText` 同口径**：
 * 换成 LF、去首尾空白、截到 `MAX_TITLE_CHARS`。
 *
 * 为什么前端也要做一次（而不是只靠主进程）：界面要用它的结果决定
 * 「加标题」按钮**能不能点**（空白文字点了就是一次必然失败的 IPC），
 * 而按钮的 disabled 只能在渲染层算。
 *
 * @param {*} raw
 * @returns {string}
 */
export function normalizeTitleText(raw) {
  const s = raw === undefined || raw === null ? '' : String(raw);
  const text = s.replace(/\r\n?/g, '\n').trim();
  return text.length > MAX_TITLE_CHARS ? text.slice(0, MAX_TITLE_CHARS) : text;
}

/**
 * 这段片段**能不能**分离音频，以及不能的话为什么。
 *
 * 判据（按顺序，第一条命中即返回）：
 *   1. 片段本身得是 `kind === 'video'` —— 图片 / 标题 / 已经是音频的片段都没有
 *      "从画面里拆出声音"这回事（对它们发 detachAudio 是静默 no-op，实测过）；
 *   2. `clip.muted === true` ⇒ 判定"已经分离过"：这是 Concat 自己的标记
 *      （`clip_update.muted` 的 schema 原文："A detach sets this on the video it
 *      took the sound from"），再点一次只会得到另一条重复的音频片段；
 *   3. 素材要**明确**有音轨（`hasAudio === true`）。`hasAudioKnown === false`
 *      （还没探测过）时**放行但带一句提示** —— 主进程负责探测，界面不该替它猜；
 *      `hasAudio === false` 则直接拦，给出"这个素材没有音轨"。
 *
 * @param {object} clip 扁平片段
 * @param {{id:string, hasAudio?:boolean, hasAudioKnown?:boolean}|null} media 该片段的素材
 * @returns {{ok:boolean, reason?:string, warn?:string}}
 */
export function canDetachAudio(clip, media) {
  const c = clip && typeof clip === 'object' ? clip : {};
  const kind = String(c.kind || '');
  if (kind === 'audio') return { ok: false, reason: '这本来就是一条音频片段' };
  if (kind !== 'video') return { ok: false, reason: '只有视频片段才有音轨可以分离' };
  if (!c.media) return { ok: false, reason: '这段片段没有关联素材文件' };
  if (c.muted === true) return { ok: false, reason: '这段已经分离过（它现在是静音状态）' };
  const m = media && typeof media === 'object' ? media : null;
  if (!m) {
    // 素材没在素材库的清单里（工程被外部改过）：不拦，让引擎去判。
    return { ok: true, warn: '这条片段的素材不在素材库里，分离结果以引擎为准' };
  }
  if (m.hasAudioKnown !== true) {
    return { ok: true, warn: '这个素材还没探测过音轨，若分离失败说明它本身是无声的' };
  }
  if (m.hasAudio !== true) return { ok: false, reason: '这个素材本身没有音轨（无声视频）' };
  return { ok: true };
}

/**
 * 从"分离前后两份片段清单"里认出**这次新拆出来的音频片段**。
 *
 * 这么认而不按 media 认，是因为同一素材可能已经在时间轴上有多段（事实③）。
 * 排序偏好：轨道与源片段不同 + 起点与源片段一致的那一条先认（实测 detach 出来的
 * 音频片段 `start/end` 与源片段完全相同，落在另一条轨上）；都对不上就退回"第一条新增的音频"。
 *
 * @param {Array<object>} beforeClips 分离前的扁平片段清单
 * @param {Array<object>} afterClips 分离后的扁平片段清单
 * @param {string} sourceClipId 被分离的视频片段 id
 * @returns {object|null} 新音频片段（没有则 null —— 那说明引擎静默 no-op 了）
 */
export function findDetachedAudioClip(beforeClips, afterClips, sourceClipId) {
  const before = Array.isArray(beforeClips) ? beforeClips : [];
  const after = Array.isArray(afterClips) ? afterClips : [];
  const seen = new Set();
  for (const c of before) {
    if (c && c.id !== undefined && c.id !== null) seen.add(String(c.id));
  }
  const src = before.find((c) => c && String(c.id) === String(sourceClipId)) || null;
  const srcMedia = src && src.media ? String(src.media) : '';
  const fresh = after.filter((c) => c
    && c.id !== undefined && c.id !== null
    && !seen.has(String(c.id))
    && String(c.kind) === 'audio'
    && (!srcMedia || String(c.media || '') === srcMedia));
  if (!fresh.length) return null;
  const exact = fresh.find((c) => src
    && String(c.track) !== String(src.track)
    && Math.abs(num(c.start, 0) - num(src.start, 0)) < 1e-6);
  return exact || fresh[0];
}

/**
 * 分离成功后给用户的一句实话：新片段 id、落在哪条轨、覆盖哪一段。
 * 分离是"落到哪条轨由引擎决定"的操作（事实②），所以这句提示是用户唯一的反馈。
 *
 * @param {object|null} audioClip `findDetachedAudioClip` 的结果
 * @returns {string}
 */
export function describeDetachResult(audioClip) {
  const a = audioClip && typeof audioClip === 'object' ? audioClip : null;
  if (!a) return '引擎没有生成音频片段（这条视频可能没有音轨）';
  return '已分离出独立音频片段 ' + String(a.id)
    + '，落在轨道 ' + String(a.track)
    + '，' + formatTimecode(num(a.start, 0)) + ' → ' + formatTimecode(num(a.end, 0));
}


