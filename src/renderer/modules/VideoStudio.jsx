/**
 * VideoStudio —— 「视频精剪」一级页面（module key `videostudio`，剪映式三栏编辑器）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【这一页和「视频设计」（`VideoDesign.jsx`）是**两个模块**，不是一件事】
 *   · `videodesign` = 通义万象 3.0 **AI 生成**视频/图片（云端出片，一次一问答）；
 *   · `videostudio` = 本页 = 把**已有素材**（视频/音频/图片）剪成一条成片并导出 mp4
 *     （本地 Concat 引擎，多轨 · 字幕 · 变速 · 关键帧 · 导出）。
 *   老板原话：「新做的 concat 一定也有问题 比如导入视频 视频与音频轨道 你可以参考剪映
 *   对吧 以及导出 mp4 格式 核心功能都要有」。
 *   所以**不许**把它塞进 VideoDesign（那是 3481 行、语义完全不同的另一个模块）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【★ 为什么预览区只有「抽帧静态图 + 时间码」，没有真正的播放器】
 *   Concat 是一个 **headless MCP 引擎**（`concat.exe`），它对渲染层只暴露两件事：
 *   ① `concatPreviewFrame({ time })` —— 在**指定的某一时刻**抽一张 PNG（base64 dataUrl）；
 *   ② `concatExportStart/Status` —— 整条时间轴渲染成 mp4。
 *   **没有**「实时播放流」这个通道：没有 push 帧的 IPC、没有本地 http 流地址、
 *   没有帧缓冲。所以这一页在物理上做不到 60fps 播放。
 *
 *   ★ 因此本页刻意做三件「诚实」的事，别自作聪明改掉：
 *     1. 预览区左上角常驻角标「帧预览 · 点位抽帧」——用户一眼就知道这不是播放器；
 *     2. 空格触发的「播放」= **把播放头按 4 次/秒往前推、每步抽一帧**（见 `tickPlay`），
 *        它不是 `requestAnimationFrame` 假动画。抽帧有 ~200ms 防抖，所以实际观感
 *        就是「一张一张翻」，这是引擎能力的天花板，不是没做完；
 *     3. 不写任何「假装在播」的 CSS 动画/CSS 滤镜。宁可看起来慢，也不骗人
 *        （本仓最忌讳的就是「看起来像做完了」）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么所有编辑都只走 `concatEdit` 这一个入口】
 *   op 词表（`addTrack` / `clipAdd` / `clipsMove` / `clipTrim` / `clipsSplit` /
 *   `clipsRemove` / `clipUpdate` / `clipTransform` / `clipSpeed` / `keyframeSet` …）
 *   是主进程**钉死的契约**。渲染层不许自己维护一份「本地时间轴」再想办法同步过去 ——
 *   那是两套真源，撤销/重做一定会漂。这里的规矩是：
 *     · 用户拖动时**只在本地画 ghost**（视觉），一个 IPC 都不发；
 *     · 用户**松手那一下**才发一次 `concatEdit`；
 *     · 主进程回的 `{ok, createdId, ...snapshot}` 直接整体替换 `snap`。
 *   这一条同时解决了两个问题：① 拖动时不会把 concat.exe 打爆（一次拖动只发 1 个请求，
 *   而不是 60 个）；② 撤销栈里一次拖动只占 **1 步**（按帧发请求的话，撤销一次只退一帧，
 *   用户要按 60 下 Ctrl+Z 才能退回拖动前——这是同类产品里非常经典的 bug）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么时间轴上的片段是「按 `clip.track` 过滤出来的」，不重组成每轨数组】
 *   snapshot 的 `timeline.clips` 是**扁平数组**，归属靠 `clip.track`。
 *   一旦在前端把它重组成 `{trackId: [clips]}`，就多了一份副本；而撤销之后
 *   主进程回来的快照是唯一真源 ⇒ 副本必然漂移（典型症状：撤销两次之后，
 *   时间轴上的片段回到原位了，但点它弹出来的属性面板还是旧值）。
 *   所以所有「按轨取片段」都走模型层的 `clipsOnTrack()` —— 纯过滤、零副本。
 *   轨道行序同理走 `sortTracksForDisplay()`：`index` 越大越在上层，
 *   而时间轴把上层画在上面 ⇒ 视觉行序是 index **降序**（详见模型层文件头）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么抽帧要 200ms 防抖 + 单飞】
 *   `concatPreviewFrame` 每次调用都会让 concat.exe 真去解码一帧。拖动播放头时
 *   pointermove 一秒能发 100+ 次事件 ⇒ 100+ 个解码请求排队，引擎会被打满，
 *   表现是「越拖越卡，最后整个应用假死几秒」。200ms 是实测的折中：
 *   人手拖动的停顿感看不出来（<200ms 用户认为还是连续的），而请求量降到 5/秒。
 *
 *   ⚠️ **光有防抖不够**（2026-11-10 补齐）：防抖只解决"手抖连发"，解决不了
 *   「请求比间隔慢」。播放时播放头每 250ms 走一格、每格都会要一帧，而一帧要
 *   100~600ms —— 于是队列照样净增长；又因为这些抽帧和「导入素材」「改片段」
 *   排的是主进程里**同一条串行队列**（`concatStudio.enqueue`），
 *   用户看到的就是「点导入要等很久 / 偶尔超时报错」。
 *   所以抽帧统一走 `createLatestTask`（并发恒 ≤ 1、忙时只保留最新一帧、
 *   忙完必补最后一帧），队列深度钉死在 1。逻辑与门禁见
 *   `services/latestTask.js` 与 `scripts/smoke/unit-latest-task.mjs`。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么要有 `hasConcatApi()` 守卫】
 *   主进程侧的 `concat*` 通道由另一个 agent 并行落地。渲染层先跑起来的窗口期里，
 *   `window.api.concatSnapshot` 是 `undefined` —— 不守卫就是
 *   `TypeError: window.api.concatSnapshot is not a function` ⇒ 整个模块白屏，
 *   而且用户看到的只是一片空白（React 错误边界在这个仓没铺到页面级）。
 *   所以：探测不到就渲染一张「视频引擎未就绪」的诚实空态，而不是崩。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../styles/videostudio.css';
import {
  DEFAULT_EXPORT_OPTIONS,
  DEFAULT_PX_PER_SEC,
  DEFAULT_TITLE_SEC,
  EXPORT_CODECS,
  EXPORT_PRESETS,
  GRID_SEC,
  KEYFRAME_PROPERTIES,
  KEYFRAME_PROPERTY_LABELS,
  MAX_EXPORT_EDGE,
  MAX_TITLE_CHARS,
  MIN_TIMELINE_SPAN_SEC,
  ZOOM_RANGE,
  buildRulerTicks,
  canDetachAudio,
  clampTrim,
  clipHitTest,
  clipsOnTrack,
  describeDetachResult,
  describeExportStage,
  describeTrimReason,
  estimateTimelineDuration,
  exportPercent,
  findDetachedAudioClip,
  findMedia,
  formatBytes,
  formatDuration,
  formatTimecode,
  indexMedia,
  isTerminalState,
  mediaHasAudio,
  mediaIcon,
  normState,
  normalizeTitleText,
  pickTrackForKind,
  secondsToX,
  snapToGrid,
  sortTracksForDisplay,
  splitMediaByKind,
  timelineSpanOf,
  trackKindOf,
  trackLabelFor,
  validateExportOptions,
  xToSeconds,
} from './VideoStudioModel.js';
// 抽帧的「单飞 + 最新优先」执行器（见文件里预览那段的长注释与 unit-latest-task 门禁）。
import { createLatestTask } from '../services/latestTask.js';
// 字幕 AI：模型只负责断句，时间轴由 layoutCaptions 纯算术排（见 services/videoCaptionAI.js 头注）。
import {
  DEFAULT_CPS as CAPTION_CPS,
  DEFAULT_MAX_CHARS as CAPTION_MAX_CHARS,
  genCaptionLines,
  layoutCaptions,
} from '../services/videoCaptionAI.js';

/* ──────────────────────────────────────────────────────────────────────────
   常量
   ────────────────────────────────────────────────────────────────────────── */

/** 单条轨道行高（px）。拖动时纵向位移 / 这个数 = 跨了几条轨。 */
const TRACK_H = 48;

/** 轨道行首标签槽宽度（px）。与 `.vs-track-head` 的 `flex-basis` 必须一致。 */
const HEAD_W = 52;

/** 抽帧防抖（ms）。理由见文件头「为什么抽帧要 200ms 防抖」。 */
const PREVIEW_DEBOUNCE_MS = 200;

/**
 * **播放中**的抽帧节拍（ms）。
 *
 * 【2026-11-10 修「很卡」（老板原话）】
 *   改之前播放时抽帧和停着时用同一个 200ms 防抖，而播放头每 `TICK_MS=250` 动一次 ⇒
 *   每次都在下一次变动前触发 ⇒ **恒为 4 帧/秒**。而主进程侧抽帧和编辑排的是**同一条
 *   串行队列**（`concatStudio.enqueue`），单帧 1080p 实测 100~600ms。
 *   于是播放期间队列被抽帧占满，用户此刻做的任何编辑（拖片段 / 加字幕 / 切分）
 *   都要先排队等一帧 —— 这就是"卡"。`createLatestTask` 只保证**不积压**，
 *   但保证不了"编辑不用等"。
 *   ⇒ 播放时把节拍放到 700ms（≈1.4 帧/秒）：预览仍然在动（肉眼够用），
 *     但两帧之间有 300ms 以上的空档，编辑请求能立刻拿到队列。
 *   ⚠️ 停着时**仍是 200ms** —— 拖时间轴要跟手，这里不能一起变慢。
 */
const PLAY_PREVIEW_MS = 700;

/** 导出状态轮询间隔（ms）。契约要求 500ms。 */
const EXPORT_POLL_MS = 500;

/** 「播放」时播放头的前进节拍（ms）。4 次/秒，与抽帧防抖同量级。 */
const TICK_MS = 250;

/** 轮询上限（次）。500ms × 7200 = 1 小时，超时按失败处理，避免定时器永远挂着。 */
const EXPORT_POLL_LIMIT = 7200;

/** 预览抽帧的目标尺寸。小一点解码快；真导出是走导出管线，与这个无关。 */
const PREVIEW_W = 720;
const PREVIEW_H = 405;

/** 新字幕的默认单条时长（秒）。 */
const CAPTION_SEC = 3;

/**
 * 判定「`window.api` 上有没有 Concat 通道」。
 *
 * 只要求**核心 9 个**（探测 / 打开 / 快照 / 编辑 / 选素材 / 导入 / 抽帧 / 撤销 / 重做）。
 * 导出、取消导出这类可选通道缺失时不让整页瘫掉 —— 缺哪个，哪个功能自己降级并说明，
 * 见 `callApi()`。这样做的好处：主进程分两批落地时，UI 能用的部分立刻能用。
 *
 * @returns {boolean}
 */
function hasConcatApi() {
  if (typeof window === 'undefined') return false;
  const api = window.api;
  if (!api || typeof api !== 'object') return false;
  const required = [
    'concatProbe', 'concatOpen', 'concatSnapshot', 'concatEdit',
    'concatPickMedia', 'concatImportMedia', 'concatPreviewFrame',
    'concatUndo', 'concatRedo',
  ];
  return required.every((k) => typeof api[k] === 'function');
}

/**
 * 调一个 `concat*` 通道，**永不抛错**（抛错在这里统一折成 `{ok:false,error}`）。
 *
 * 为什么不用 try/catch 分散在二十个调用点：那样一定会有漏的，而漏掉的那一处
 * 就是一个「点了没反应 + 控制台红字」的 bug。统一入口之后，「通道不存在」和
 * 「通道内部抛错」在 UI 上是同一句话，都能被 toast 显示出来。
 *
 * @param {string} name `window.api` 上的方法名
 * @param {any} [arg] 单参数（契约里所有 concat 通道都只收一个对象）
 * @returns {Promise<object>} 结果对象；失败时至少含 `{ok:false, error}`
 */
async function callApi(name, arg) {
  const api = typeof window === 'undefined' ? null : window.api;
  if (!api || typeof api[name] !== 'function') {
    return { ok: false, error: '视频引擎未就绪：缺少通道 ' + name };
  }
  try {
    const res = arg === undefined ? await api[name]() : await api[name](arg);
    if (res === undefined || res === null) {
      return { ok: false, error: name + ' 没有返回结果' };
    }
    return res;
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 有限数兜底（`Number('')` 是 0，所以这里显式挡掉空串）。 */
function n(v, d) {
  if (v === null || v === undefined || v === '') return d === undefined ? 0 : d;
  const x = Number(v);
  return Number.isFinite(x) ? x : (d === undefined ? 0 : d);
}

/**
 * 从 `pickFolder`（`file:pickFolder`）的返回里抠出目录路径。抠不到 ⇒ `''`。
 *
 * ★ **主读 `filePaths[0]`**：main.js 那个 handler 的返回契约是
 *   `{ canceled: boolean, filePaths: string[] }` —— 路径只在数组里。
 *   修复前本文件读的是 `r.path || r.filePath`，两个字段都不存在 ⇒ 恒为 ''，
 *   于是「打开工程」选了文件夹也毫无反应（被当成用户取消静默 return 掉了）。
 * ★ 兼容分支（`r.path` / `r.filePath` / 直接回字符串）不是"猜"，是给
 *   「将来 preload 换返回形态」留的安全垫：任何一种形态都比静默好。
 *
 * @param {any} r `api.pickFolder()` 的返回值（可能是 undefined / string / 对象）
 * @returns {string} 目录绝对路径；拿不到 ⇒ ''
 */
function folderPathOf(r) {
  if (typeof r === 'string') return r.trim();
  if (!r || typeof r !== 'object') return '';
  const list = Array.isArray(r.filePaths) ? r.filePaths : [];
  for (let i = 0; i < list.length; i += 1) {
    if (typeof list[i] === 'string' && list[i].trim()) return list[i].trim();
  }
  if (typeof r.path === 'string' && r.path.trim()) return r.path.trim();
  if (typeof r.filePath === 'string' && r.filePath.trim()) return r.filePath.trim();
  return '';
}

/**
 * 导出状态归一化 / 终态判定都在模型层（`VideoStudioModel.js` 的 `normState` /
 * `isTerminalState`）—— 放那边的理由是它们**能在 node 里单测**，而这里不行。
 * 已在本文件顶部一起 import。
 */

/* ──────────────────────────────────────────────────────────────────────────
   受控数字/文本输入框
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 属性面板用的受控输入框。
 *
 * 为什么要**本地 state + 失焦/回车才提交**，而不是 onChange 直接 `concatEdit`：
 *   ① 每次按键都发 IPC 会把撤销栈塞满（输入 `1920` 会留下 4 步），用户按一次
 *      Ctrl+Z 只退掉一个字符，体验是「撤销坏了」；
 *   ② 输入到一半的值多半是非法的（`1`、`19`、`192`…），发过去会被 Concat 拒。
 *   ⇒ 打字只改本地，失焦/回车才提交一次。
 *
 * `value` 变化时（切换选中片段 / 撤销回来）同步回本地 —— 用 `lastProp` 记录上一次
 * 外部值，避免用户正在打字时被一次外部刷新打断。
 *
 * @param {{label:string, value:number|string, type?:string, min?:number, max?:number,
 *          step?:number, unit?:string, onCommit:(v:any)=>void}} props
 * @returns {any}
 */
function NumField({ label, value, type, min, max, step, unit, onCommit }) {
  const kind = type || 'number';
  const [text, setText] = useState(String(value === undefined || value === null ? '' : value));
  const lastProp = useRef(value);
  useEffect(() => {
    if (lastProp.current !== value) {
      lastProp.current = value;
      setText(String(value === undefined || value === null ? '' : value));
    }
  }, [value]);
  const commit = () => {
    lastProp.current = value;
    if (kind === 'text') {
      if (text !== String(value === undefined || value === null ? '' : value)) onCommit(text);
      return;
    }
    const num = Number(text);
    if (!Number.isFinite(num)) { setText(String(value)); return; }
    let v = num;
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    if (v !== n(value)) onCommit(v);
    else setText(String(v));
  };
  return (
    <div className="vs-field">
      <label htmlFor={'vs-f-' + label}>{label}</label>
      <input
        id={'vs-f-' + label}
        type={kind}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        min={min}
        max={max}
        step={step === undefined ? 'any' : step}
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); }
          if (ev.key === 'Escape') { setText(String(value)); ev.currentTarget.blur(); }
        }}
      />
      {unit ? <span className="vs-unit">{unit}</span> : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   主组件
   ────────────────────────────────────────────────────────────────────────── */

/**
 * 「视频精剪」页。
 *
 * @param {{companyId?:string}} props `companyId` 只用于日志/诊断，Concat 工程是**本机**的，
 *        不随企业切换（与思维导图同一策略：草稿不挂企业维度）。
 * @returns {any} React 节点
 */
export default function VideoStudio(props) {
  const companyId = props && props.companyId ? String(props.companyId) : '';

  /* ── 引擎 / 快照 ─────────────────────────────────────────────────────── */
  const [apiOk, setApiOk] = useState(false);
  const [probe, setProbe] = useState(null);
  const [probed, setProbed] = useState(false);
  const [snap, setSnap] = useState(null);
  const [busy, setBusy] = useState(false);
  /** 正在导入的素材数（0 = 没在导入）。只用来把「导入素材」按钮变成可读的进度提示。 */
  const [importingN, setImportingN] = useState(0);
  const [toast, setToast] = useState(null);

  /* ── 视图状态 ───────────────────────────────────────────────────────── */
  const [selIds, setSelIds] = useState([]);
  const [playhead, setPlayhead] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [preview, setPreview] = useState({ url: '', time: 0, error: '', busy: false });
  const [ghost, setGhost] = useState(null);
  const [mediaGhost, setMediaGhost] = useState(null);

  /* ── 导出 ───────────────────────────────────────────────────────────── */
  const [exportOpen, setExportOpen] = useState(false);
  const [exportOpts, setExportOpts] = useState(DEFAULT_EXPORT_OPTIONS);
  const [exportPath, setExportPath] = useState('');
  const [exportJob, setExportJob] = useState(null);

  /* ── 关键帧输入 ─────────────────────────────────────────────────────── */
  const [kfProp, setKfProp] = useState('scale');
  const [kfAt, setKfAt] = useState(0);
  const [kfVal, setKfVal] = useState(1);

  /* ── 字幕批量输入 ───────────────────────────────────────────────────── */
  const [captionText, setCaptionText] = useState('');
  /** AI 切过之后带回来的"每行大约几秒"；为空数组时退回固定 `CAPTION_SEC`。 */
  const [captionSecs, setCaptionSecs] = useState([]);
  const [captionAiBusy, setCaptionAiBusy] = useState(false);
  /** 引擎探测已经跑了多久（秒）。只在探测中递增 —— 见下面「引擎状态」那段注释。 */
  const [probeSecs, setProbeSecs] = useState(0);

  /* ── 文字标题 ───────────────────────────────────────────────────────── */
  /**
   * 标题弹层。为什么是**弹层**而不是左栏里塞一个输入框：
   *   左栏已经有两个面板（素材库 is-grow + 批量字幕），再加一个会在
   *   900px 高的窗口上把素材库挤到看不见（`.vs-left` 是 flex column，
   *   非 grow 的面板太多就会互相压扁）。用既有的 `.vs-mask/.vs-dialog`
   *   承载输入，布局零风险，而且「点加标题 ⇒ 弹出输入框」正是剪映的手感。
   */
  const [titleOpen, setTitleOpen] = useState(false);
  const [titleText, setTitleText] = useState('');

  /* ── ref ────────────────────────────────────────────────────────────── */
  const scrollRef = useRef(null);
  const laneRefs = useRef({});
  const dragRef = useRef(null);
  const detachRef = useRef(null);
  const playheadRef = useRef(0);
  const playSpanRef = useRef(MIN_TIMELINE_SPAN_SEC);

  /* ── 派生态（**全部**从 snap 算，不另存副本）────────────────────────── */
  const project = snap && snap.project ? snap.project : null;
  /** 「有没有工程」的布尔位：只在 null ↔ 非 null 时变，可以安全当 effect 依赖。 */
  const hasSnap = !!snap;
  const timeline = snap && snap.timeline ? snap.timeline : null;
  const clips = useMemo(() => (timeline && Array.isArray(timeline.clips) ? timeline.clips : []), [timeline]);
  const mediaList = useMemo(() => (snap && Array.isArray(snap.media) ? snap.media : []), [snap]);
  const tracksRaw = useMemo(() => (timeline && Array.isArray(timeline.tracks) ? timeline.tracks : []), [timeline]);
  /** 视觉行序：第 0 行 = 时间轴最上面 (index 最大)。 */
  const rows = useMemo(() => sortTracksForDisplay(tracksRaw), [tracksRaw]);
  const mediaMap = useMemo(() => indexMedia(mediaList), [mediaList]);
  const span = useMemo(() => timelineSpanOf(timeline, clips), [timeline, clips]);
  const contentWidth = Math.max(240, Math.round(span * pxPerSec) + HEAD_W);
  const selected = useMemo(
    () => clips.filter((c) => c && selIds.indexOf(String(c.id)) >= 0),
    [clips, selIds],
  );
  const single = selected.length === 1 ? selected[0] : null;

  useEffect(() => { playheadRef.current = playhead; }, [playhead]);
  /** 播放状态的最新值（给定时器回调读，避免把 `playing` 挂进受门禁钉住的依赖数组）。 */
  const playingRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { playSpanRef.current = span; }, [span]);

  /** 统一的 toast：3 秒后自己消失。 */
  const showToast = useCallback((msg, isError) => {
    if (!msg) return;
    setToast({ msg: String(msg), isError: !!isError });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  /* ────────────────────────────────────────────────────────────────────
     引擎探测：挂载时跑一次
     ──────────────────────────────────────────────────────────────────── */
  /**
   * 【2026-11-10 修「功能这一块是灰色的」】
   *
   * 改之前的事实（逐行核过）：
   *   ① `probed=false` 时整页只渲染一句「正在连接视频引擎…」（第 2090 行那个 return），
   *      **顶栏、面板、任何可点的东西都没有** —— 用户看到的就是一整块灰；
   *   ② 首次在一台没装过 Concat 的机器上打开时，`concat:probe` 会走
   *      `concatAutoInstall.ensureConcatInstalled()`：**下载安装包 + 静默安装**，
   *      这期间没有任何进度回传（主进程只 `console.log`），页面上也没有计时；
   *   ③ `probe` 这个 state **从头到尾没有被渲染过**（全文件只有 setProbe 和 !probed 两处），
   *      所以探测失败时用户拿不到任何原因，只会看到「还没有工程」+ 两个点了报错的按钮。
   *   ⇒ 这三条叠起来的现场就是老板那句「输入字幕 还有功能这一块是灰色的」：
   *      他根本没进到剪辑器，字幕输入框压根没渲染过。
   *
   * 现在的口径：**探测期也要说人话**。
   *   · 计时（`probeSecs`）：让"正在准备"和"卡死了"能被用户自己区分；
   *   · 20 秒后出现「重新探测」，60 秒后文案改为"首次使用要下载安装，通常 1~2 分钟"；
   *   · 探测失败时把 `probe.error` **原样**显示出来（不吞），并给手动安装链接。
   */
  useEffect(() => {
    let alive = true;
    const ok = hasConcatApi();
    setApiOk(ok);
    if (!ok) { setProbed(true); return undefined; }
    callApi('concatProbe').then((res) => {
      if (!alive) return;
      setProbe(res && res.ok ? res : { ok: false, error: (res && res.error) || '引擎探测失败' });
      setProbed(true);
      // 探测通过就顺手拉一次快照：如果主进程那边已经有打开着的工程，直接接上。
      if (res && res.ok) {
        callApi('concatSnapshot').then((s) => {
          if (alive && s && s.ok && s.timeline) setSnap(s);
        });
      }
    });
    return () => { alive = false; };
  }, []);

  /** 探测期间的秒表：只在「有通道但还没探完」时跑，探完即停（不留后台定时器）。 */
  useEffect(() => {
    if (!apiOk || probed) { setProbeSecs(0); return undefined; }
    const id = setInterval(() => setProbeSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [apiOk, probed]);

  /** 重试探测：按钮触发（探测失败 / 等太久）。成功后顺手接上已有工程。 */
  const doReprobe = useCallback(async () => {
    setProbed(false);
    setProbeSecs(0);
    setProbe(null);
    const res = await callApi('concatProbe');
    setProbe(res && res.ok ? res : { ok: false, error: (res && res.error) || '引擎探测失败' });
    setProbed(true);
    if (res && res.ok) {
      const s = await callApi('concatSnapshot');
      if (s && s.ok && s.timeline) setSnap(s);
    }
  }, []);

  /* ────────────────────────────────────────────────────────────────────
     抽帧预览：200ms 防抖 + **单飞 / 最新优先**
     ──────────────────────────────────────────────────────────────────── */
  /**
   * 【2026-11-10 修「播放时特别卡、经常出错」】
   * 原来这个 effect 的依赖里有 `snap`（整个时间轴快照对象），而 `snap` 在**每一次**
   * 编辑调用返回后都会换一个新对象 ⇒ 每改一次就重抽一帧；再叠加播放时 `playhead`
   * 每 250ms 变一次 ⇒ 每 250ms 又一个抽帧请求。
   *
   * 关键在**主进程那边抽帧和导入/编辑排的是同一条串行队列**（`concatStudio.enqueue`）：
   * 一帧要 100~600ms，而播放每秒产生 4 个请求 ⇒ 队列只进不出地净增长。
   * 用户看到的就是「点导入要等半天、偶尔直接超时报错」。
   *
   * 两条修法，缺一不可：
   *   ① 依赖从 `snap` 换成 `frameSig`（只反映"画面内容变了没"的短字符串）——
   *      选中片段、切面板这类不影响画面的状态变化不再触发抽帧；
   *   ② 抽帧走 `createLatestTask`（并发恒 ≤ 1、忙时只保留最新一帧、忙完必补最后一帧）
   *      —— 队列深度被钉死在 1，播放再久也不会积压。
   */
  const frameSig = useMemo(() => {
    const t = snap && snap.timeline ? snap.timeline : null;
    if (!t) return '';
    const clips = Array.isArray(t.clips) ? t.clips : [];
    // 只取"决定这一帧长什么样"的字段：谁、从哪开始、到哪结束。
    // 不取 id 之外的元信息（音量/静音都不影响画面），否则勾一下静音也会重抽一帧。
    return clips.map((c) => String(c.id) + ':' + Number(c.start) + '-' + Number(c.end)).join('|')
      + '@' + (Number(t.duration) || 0);
  }, [snap]);

  // 组件卸载后不许再 setState：抽帧是异步的，最后一帧常常在切页之后才回来。
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const previewTaskRef = useRef(null);
  if (!previewTaskRef.current) {
    previewTaskRef.current = createLatestTask(async ({ time }) => {
      const res = await callApi('concatPreviewFrame', { time, width: PREVIEW_W, height: PREVIEW_H });
      if (!aliveRef.current) return;
      if (res && res.ok && res.dataUrl) {
        setPreview({ url: res.dataUrl, time, error: '', busy: false });
      } else {
        setPreview({ url: '', time, error: (res && res.error) || '抽帧失败', busy: false });
      }
    });
  }

  /**
   * 编辑在飞时**先不抽帧**（见 `PLAY_PREVIEW_MS` 的长注释）。
   * 为什么要这个额外的闸门：播放节拍放到 700ms 之后，仍有一半的时间点和编辑撞上
   * （一帧 600ms 时，700ms 的间隔里只剩 100ms 空档）。所以再加一条：
   * **有编辑在等结果就不排帧** —— 用户的操作永远优先于"把预览图刷新一下"。
   */
  const editBusyRef = useRef(false);

  /**
   * 播放中：**按固定节拍**抽帧，与播放头的 tick 解耦。
   *
   * ★ 这里踩过一次坑，记下来：第一版把节拍塞进下面那个防抖 effect 里
   *   （`delay = playing ? 700 : 200`），结果播放时**一帧都不抽**——
   *   因为 `playhead` 每 250ms 变一次就是一次依赖变化，每次变化都 `clearTimeout`，
   *   700ms 的定时器永远等不到自己触发。播放头走得很顺、画面却冻在开头。
   *   ⇒ 播放中必须用 `setInterval`（自己的节拍），不能借用防抖。
   */
  useEffect(() => {
    if (!apiOk || !hasSnap || !playing) return undefined;
    const id = setInterval(() => {
      // 编辑优先：这一刻正在等编辑结果就跳过这一帧（下一拍再补）。
      if (editBusyRef.current) return;
      if (previewTaskRef.current) previewTaskRef.current.run({ time: playheadRef.current });
    }, PLAY_PREVIEW_MS);
    return () => clearInterval(id);
  }, [apiOk, hasSnap, playing]);

  useEffect(() => {
    if (!apiOk || !hasSnap || playing) return undefined;
    if (editBusyRef.current) return undefined;
    setPreview((p) => ({ ...p, busy: true }));
    const t = setTimeout(() => {
      // 延时到点时如果已经开始播放，这一帧让给播放节拍（它有自己的 setInterval）。
      // ★ 为什么用 ref 而不是把 `playing` 挂进依赖数组：
      //   依赖数组必须恰好是 `[apiOk, hasSnap, frameSig, playhead]` ——
      //   `unit-latest-task.mjs` 的 W3 逐字符钉住它，守的是"snap 不许进来"
      //   （snap 每次编辑都换对象 ⇒ 每改一次抽一帧，那正是播放卡顿的根因）。
      //   多挂一个键就会让那条门禁红；红得对：它不认识的新键必须先证明必要性。
      if (playingRef.current) return;
      if (previewTaskRef.current) previewTaskRef.current.run({ time: playhead });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // ⚠️ 依赖里**故意没有** `snap`：它每次编辑后都是新对象，挂上去等于"每改一次抽一帧"。
    //    "有没有工程"这一层用 `hasSnap`（只在 null↔非 null 时变），画面内容用 `frameSig`。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOk, hasSnap, frameSig, playhead]);

  /* ────────────────────────────────────────────────────────────────────
     「播放」= 播放头按 4 次/秒往前推（不是播放器，见文件头）
     ──────────────────────────────────────────────────────────────────── */
  const togglePlay = useCallback(() => {
    if (!snap) return;
    setPlaying((p) => !p);
  }, [snap]);

  useEffect(() => {
    if (!playing || !snap) return undefined;
    const id = setInterval(() => {
      const next = playheadRef.current + TICK_MS / 1000;
      const limit = playSpanRef.current;
      if (next >= limit) {
        setPlayhead(limit);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, snap]);

  /* ────────────────────────────────────────────────────────────────────
     编辑（唯一入口）
     ──────────────────────────────────────────────────────────────────── */
  const applyEdit = useCallback(async (op, args) => {
    if (!apiOk) { showToast('视频引擎未就绪', true); return { ok: false }; }
    // 打上"编辑在飞"标记：抽帧的 effect 见到它就跳过这一轮（编辑优先于预览刷新）。
    editBusyRef.current = true;
    let res;
    try {
      res = await callApi('concatEdit', { op, args: args || {} });
    } finally {
      editBusyRef.current = false;
    }
    if (res && res.ok && res.timeline) {
      setSnap(res);
      if (res.createdId !== undefined && res.createdId !== null) setSelIds([String(res.createdId)]);
      return res;
    }
    showToast((res && res.error) || ('编辑失败：' + op), true);
    return res || { ok: false };
  }, [apiOk, showToast]);

  const applySnapshotAction = useCallback(async (name, arg) => {
    editBusyRef.current = true;
    let res;
    try {
      res = await callApi(name, arg);
    } finally {
      editBusyRef.current = false;
    }
    if (res && res.ok && res.timeline) {
      setSnap(res);
      setSelIds([]);
      return res;
    }
    if (res && res.ok === false) showToast(res.error || (name + ' 失败'), true);
    return res;
  }, [showToast]);

  /* ────────────────────────────────────────────────────────────────────
     工程：新建 / 打开 / 保存
     ──────────────────────────────────────────────────────────────────── */
  const doNew = useCallback(async () => {
    if (!apiOk) { showToast('视频引擎未就绪', true); return; }
    setBusy(true);
    const res = await callApi('concatOpen', { name: '未命名工程' });
    setBusy(false);
    if (res && res.ok) {
      if (res.timeline) { setSnap(res); } else {
        const s = await callApi('concatSnapshot');
        if (s && s.ok && s.timeline) setSnap(s);
      }
      setSelIds([]); setPlayhead(0); setExportJob(null); setExportPath('');
      showToast('已新建工程');
      return;
    }
    showToast((res && res.error) || '新建工程失败', true);
  }, [apiOk, showToast]);

  /**
   * 打开已有工程。
   *
   * ⚠️ 契约里**没有**「选工程目录」的通道（只有 `concatOpen({path})`）。
   *   所以这里复用 preload 里**已经存在**的 `pickFolder`（`file:pickFolder`）去拿目录，
   *   再把它当 `path` 传给 `concatOpen`。这条不是新开通道，是既有能力的复用；
   *   如果哪天主进程补了专用 picker，只需改这一个函数的实现，调用点不动。
   *
   * ⚠️ **返回契约是 `{ canceled, filePaths }`**（见 main.js 的 `file:pickFolder`）：
   *   路径在 `filePaths` 数组里，**没有** `path` / `filePath` 这两个字段。
   *   修复前这里读的是 `r.path || r.filePath` ⇒ 恒为 ''，被下面当成「用户取消」
   *   静默 return —— 用户看到的就是「选了文件夹，一点反应都没有，也没有报错」。
   *   现在：先取 `filePaths[0]`，同时保留对 `r.path` / `r.filePath` / 直接回字符串的
   *   兼容（万一将来 preload 换了返回形态）；并把「用户取消」与「选完了却拿不到路径」
   *   分开处理 —— 后者是**我们的契约问题**，必须 toast 出来，不许静默。
   */
  const doOpen = useCallback(async () => {
    if (!apiOk) { showToast('视频引擎未就绪', true); return; }
    const api = typeof window === 'undefined' ? null : window.api;
    if (!api || typeof api.pickFolder !== 'function') {
      showToast('当前环境不支持选择文件夹（需要在桌面版里用）', true);
      return;
    }
    let r = null;
    try {
      r = await api.pickFolder();
    } catch (e) {
      showToast('选择目录失败：' + ((e && e.message) || String(e)), true);
      return;
    }
    const target = folderPathOf(r);
    if (!target) {
      // 用户主动取消：正常操作，静默返回（不报错）。
      if (r && typeof r === 'object' && r.canceled === true) return;
      // 没取消却拿不到路径：契约对不上，必须让用户知道，否则又是"点了没反应"。
      showToast('没能拿到你选的文件夹路径，请重试', true);
      return;
    }
    setBusy(true);
    const res = await callApi('concatOpen', { path: target });
    setBusy(false);
    if (res && res.ok) {
      if (res.timeline) setSnap(res);
      else {
        const s = await callApi('concatSnapshot');
        if (s && s.ok && s.timeline) setSnap(s);
      }
      setSelIds([]); setPlayhead(0); setExportJob(null); setExportPath('');
      showToast('已打开工程');
      return;
    }
    showToast((res && res.error) || '打开工程失败', true);
  }, [apiOk, showToast]);

  const doSave = useCallback(async () => {
    if (!snap) return;
    setBusy(true);
    const res = await callApi('concatClose', { save: true });
    setBusy(false);
    if (res && res.ok === false) { showToast(res.error || '保存失败', true); return; }
    showToast('已保存');
  }, [snap, showToast]);

  /* ────────────────────────────────────────────────────────────────────
     素材导入
     ──────────────────────────────────────────────────────────────────── */
  const doImport = useCallback(async () => {
    if (!snap) { showToast('先新建或打开一个工程', true); return; }
    const picked = await callApi('concatPickMedia');
    if (!picked || !picked.ok) {
      if (picked && picked.error) showToast(picked.error, true);
      return;
    }
    const files = Array.isArray(picked.files) ? picked.files : [];
    if (!files.length) return;
    setBusy(true);
    setImportingN(files.length);
    /*
     * 【为什么先给一句"正在导入 N 个文件"】`media_import` 是**一个文件一次** IPC，
     *   中间还要对每个文件做一次 `media_probe`（取音轨真相）。十个文件就是二十来次
     *   串行往返，几秒到几十秒都有可能，而这期间界面只有一个禁用的按钮 ——
     *   老板的原话是「无法上传视频」，实际是**它在上传，但没有任何进度**。
     *   这里不假造进度条（主进程没有 per-file 回调），只如实说清"多少个、可能要等"。
     */
    showToast('正在导入 ' + files.length + ' 个素材…大文件可能要等十几秒');
    const res = await callApi('concatImportMedia', { files });
    setBusy(false);
    setImportingN(0);
    /*
     * ⚠️ 这里**不能**再要求 `res.timeline` 才算成功。
     *   `importMedia` 的返回是「素材导进去了 + 快照」两件事拼起来的：`timeline_read`
     *   偶发失败时它会不带 `timeline` 回来（`ok:true` 仍然成立）。原先的
     *   `res.ok && res.timeline` 会把这种"其实已经导好了"的情况报成"导入失败"，
     *   用户接着再导一次 —— 而同一个路径重复导入是 no-op，于是彻底卡死在这里。
     */
    if (res && res.ok) {
      if (res.timeline) setSnap(res);
      const cnt = Array.isArray(res.imported) ? res.imported.length : files.length;
      /*
       * ⚠️ 部分失败必须说出来。`importMedia` 把「成功的 id 列表」和「失败的说明」
       *   放在同一个响应里（`ok: imported.length > 0` + `error: 'a.mp4：…；b.mov：…'`）。
       *   原先这里只看 `ok`，一旦部分成功就只弹「导入了 N 个素材」，
       *   `res.error` 被整条丢掉 —— 用户看到"导入成功"，却少了两段素材，只能怀疑是 bug。
       */
      if (res.error) {
        showToast('导入了 ' + cnt + ' 个，有 ' + (files.length - cnt) + ' 个没进来：' + res.error, true);
      } else {
        showToast('导入了 ' + cnt + ' 个素材');
      }
      /*
       * 【为什么「导入时就问要不要自动分离音轨」仍然不做 —— 但分离本身已经能用了】
       *
       * 这一段以前写着「契约里没有能表达它的 op，所以没实现」。**那句话现在过期了**：
       * 主进程已补上 `EDIT_OPS.clipDetachAudio`（底层是 Concat 的原生命令
       * `edit_apply {op:'detachAudio', clipId}`，schema 里 detach 的定义原话是
       * "Pulls a video clip's sound out into its own audio clip on a free lane ..."）。
       *
       * 但「导入时」仍然不是问这句话的时机，理由不是"做不到"而是**问得太早**：
       *   `media_import` 只把文件放进素材库，**时间轴上还没有片段**；而 detachAudio
       *   的对象是一个 **clip**（`clipId`），不是 media。导入完就问，用户回答了也只能
       *   先记着，等他真的把卡片拖上时间轴之后再去补那一次调用 —— 那是一个跨越两步的
       *   隐式状态，用户第二次导入时会对不上是哪一段。
       * ⇒ 分离入口放在**用户能看见那一段的时候**：选中片段 → 右栏「分离音频」。
       *   `mediaHasAudio()` 在这里仍然有用：素材卡片上的「· 有音轨」就是它画的，
       *   它让用户在选择之前就知道这一段有没有声音可拆。
       */
    } else {
      showToast((res && res.error) || '导入失败', true);
    }
  }, [snap, mediaList, showToast]);

  /**
   * 一键铺开：把素材库里**全部**素材按类型分组，首尾相接地铺到时间线上。
   *
   * 为什么不是「把整个素材库丢给 clips_add_sequence 就完事」—— 实测（探针真跑
   * concat.exe）证明：Concat 的轨道**没有类型字段**（`tracks[]` 只有 `{id,index}`），
   * 一段视频和一段音频混在同一个数组里不会报错，而是**全部堆到同一条轨**上，
   * 音频片段就那样挂在视频轨里。所以必须先在界面层分组：
   *   · 视频 / 图片 → 最低 index 的视频轨（V1，剪映的默认落点）；
   *   · 纯音频 → 最低 index 的音频轨（A1）；**一条都没有就先建一条**（建在最底层）。
   *
   * 关于 `start`：实测它是**第一段**的起点，后续按各自时长首尾相接；
   * 且当它与该轨已有片段重叠时，Concat 会把新片段顺延到不重叠处（不是报错）。
   * 所以按钮语义如实定为「从播放头铺开」，重叠时由引擎顺延 —— 不在界面层假装挡掉。
   *
   * 关于 IPC 次数：分组后最多两次 `clipsAddSequence`（视觉一次、音频一次），
   * 加上可能的一次 `addTrack`。这是「一个用户动作 = 多次写」的例外，所以写在这里
   * 说明白：**不能合并成一次**，因为两次的目标轨不同，而 op 一次只吃一条轨。
   */
  const doSequenceAll = useCallback(async () => {
    if (!snap) { showToast('先新建或打开一个工程', true); return; }
    if (busy) return;
    const groups = splitMediaByKind(mediaList);
    if (!groups.visual.length && !groups.audio.length) {
      showToast('素材库还是空的，先导入素材', true);
      return;
    }
    const start = Math.max(0, n(playhead, 0));
    let placed = 0;

    // ① 视觉素材 → 视频轨
    if (groups.visual.length) {
      const trackId = pickTrackForKind(tracksRaw, clips, 'video');
      const res = await applyEdit('clipsAddSequence', {
        mediaIds: groups.visual.map((m) => String(m.id)),
        start,
        trackId: trackId || '',
      });
      if (!res || !res.ok) return; // applyEdit 内部已经弹过错误
      placed += groups.visual.length;
    }

    // ② 音频素材 → 音频轨（没有就现建一条）
    if (groups.audio.length) {
      let trackId = pickTrackForKind(tracksRaw, clips, 'audio');
      if (!trackId) {
        /*
         * 建轨后新轨 id 从「前后差集」里取，不依赖 createdId：
         * `track_add` 的返回是否带 createdId 未在契约里写死，而差集是确定性的。
         * 注：刚建好的空轨会被 trackKindOf 判成视频轨（空轨默认视频），
         * 所以标签会短暂显示 V0；等下面第二段把音频铺进去，它就变成 A0 了。
         * 这段中间态只在同一次 async 处理里存在，用户看不到。
         */
        const beforeIds = new Set(tracksRaw.map((t) => String(t.id)));
        const added = await applyEdit('addTrack', { bottom: true });
        if (!added || !added.ok) return;
        const nextTracks = (added.timeline && Array.isArray(added.timeline.tracks))
          ? added.timeline.tracks : [];
        const fresh = nextTracks.find((t) => t && !beforeIds.has(String(t.id)));
        trackId = fresh ? String(fresh.id)
          : (typeof added.createdId === 'string' ? added.createdId : '');
      }
      if (!trackId) { showToast('音频轨创建失败', true); return; }
      const res = await applyEdit('clipsAddSequence', {
        mediaIds: groups.audio.map((m) => String(m.id)),
        start,
        trackId,
      });
      if (!res || !res.ok) return;
      placed += groups.audio.length;
    }

    if (placed) {
      const parts = [];
      if (groups.visual.length) parts.push(groups.visual.length + ' 段画面');
      if (groups.audio.length) parts.push(groups.audio.length + ' 段音频');
      showToast('已从 ' + formatTimecode(start) + ' 铺开 ' + parts.join(' + '));
    }
  }, [snap, busy, mediaList, playhead, tracksRaw, clips, applyEdit, showToast]);

  /* ────────────────────────────────────────────────────────────────────
     分离音频 / 还原音频（剪映的「分离音频」）
     ────────────────────────────────────────────────────────────────────
     · 「分离音频」把选中视频片段的音轨拆成一条独立音频片段（可单独调音量 / 单独切 /
       单独删或抵消）；Concat 侧是原生命令 `edit_apply {op:'detachAudio'}`。
     · 它**一定**要读回结果再报喜：这条命令打在没声音的片段上是**静默 no-op**
       （实测 `isError:false`、无 `createdId`、clips 数量不变）。主进程已经用
       `requireCreated` 把它翻成 `ok:false`，这里再用 `findDetachedAudioClip()`
       从新快照里认一次人，提示里写清"新片段 id + 落在哪条轨 + 覆盖哪一段" ——
       落在哪条轨由引擎决定，用户唯一的反馈就是这句提示。
     ──────────────────────────────────────────────────────────────────── */
  const doDetachAudio = useCallback(async () => {
    const c = single;
    if (!c) return;
    // 点之前先判一次：省掉一次必然失败的 IPC，并说清为什么不行（模型层可单测）。
    const gate = canDetachAudio(c, findMedia(mediaMap, c.media));
    if (!gate.ok) { showToast(gate.reason || '这段不能分离音频', true); return; }
    const before = clips;
    const res = await applyEdit('clipDetachAudio', { clipId: String(c.id) });
    if (!res || !res.ok) return; // applyEdit 已经弹过错误（含"没有可分离的音轨"）
    const after = res.timeline && Array.isArray(res.timeline.clips) ? res.timeline.clips : [];
    const fresh = findDetachedAudioClip(before, after, String(c.id));
    showToast((gate.warn ? gate.warn + '。' : '') + describeDetachResult(fresh), !fresh);
  }, [single, mediaMap, clips, applyEdit, showToast]);

  /**
   * 还原音频：删掉拆出去的音频片段、把视频的 `muted` 关回去（Concat 的 `reattachAudio`）。
   * 视频片段和它拆出来的音频片段都可以作为入口（schema 原话："The video clip - or its
   * detached sound."）。它**不新增**任何片段，所以没有 createdId 可报 —— 判定成功的
   * 依据是新快照（音频片段少一条、视频片段不再是 muted）。
   */
  const doReattachAudio = useCallback(async () => {
    const c = single;
    if (!c) return;
    const res = await applyEdit('clipReattachAudio', { clipId: String(c.id) });
    if (!res || !res.ok) return;
    const remains = res.timeline && Array.isArray(res.timeline.clips) ? res.timeline.clips : [];
    showToast('已还原音频（时间轴现在还有 ' + remains.length + ' 段）');
  }, [single, applyEdit, showToast]);

  /* ────────────────────────────────────────────────────────────────────
     文字标题（Concat 的 title_add）
     ────────────────────────────────────────────────────────────────────
     ⚠️ 这里是本页**唯一**能给标题输入文字的地方。在此之前 `titleAdd` 只有 op、
     没有文字参数 ⇒ 每次落成的都是 Concat 的默认 `content:"Your text"`，
     而且默认样式是「纯白无描边」——白底画面上抽帧里一个暗像素都没有（实测
     darkPx=0），用户看到的就是「点了加标题什么都没出现」。
     现在：文字必须由用户输入（空文字按钮不可点），样式由主进程的
     `TITLE_DEFAULT_STYLE` 兜底成白字黑描边。
     ──────────────────────────────────────────────────────────────────── */
  const doAddTitle = useCallback(async () => {
    const text = normalizeTitleText(titleText);
    if (!text) { showToast('先输入要显示的文字', true); return; }
    const start = Math.max(0, n(playhead, 0));
    // `above:true`：标题落在画面**上方**的轨道（schema 原话："so words sit over the
    // video rather than under it"）。不给 trackId 时引擎自己找一条空轨。
    const res = await applyEdit('titleAdd', {
      start,
      duration: DEFAULT_TITLE_SEC,
      text,
      above: true,
    });
    if (res && res.ok) {
      setTitleText('');
      setTitleOpen(false);
      showToast('已加标题「' + text + '」· ' + formatTimecode(start) + ' 起 ' + DEFAULT_TITLE_SEC + ' 秒');
    }
  }, [titleText, playhead, applyEdit, showToast]);

  /* ────────────────────────────────────────────────────────────────────
     撤销 / 重做
     ──────────────────────────────────────────────────────────────────── */
  const doUndo = useCallback(async () => {
    const res = await callApi('concatUndo');
    if (res && res.ok && res.timeline) { setSnap(res); setSelIds([]); return; }
    if (res && res.ok === false && res.error) showToast(res.error, true);
  }, [showToast]);
  const doRedo = useCallback(async () => {
    const res = await callApi('concatRedo');
    if (res && res.ok && res.timeline) { setSnap(res); setSelIds([]); return; }
    if (res && res.ok === false && res.error) showToast(res.error, true);
  }, [showToast]);

  /* ────────────────────────────────────────────────────────────────────
     播放头 / 选中
     ──────────────────────────────────────────────────────────────────── */
  const seekTo = useCallback((sec) => {
    const v = Math.max(0, n(sec, 0));
    setPlayhead(snapToGrid(v, 0.01));
  }, []);

  const selectClip = useCallback((clip, additive) => {
    if (!clip) { setSelIds([]); return; }
    const id = String(clip.id);
    setSelIds((prev) => {
      if (!additive) return [id];
      return prev.indexOf(id) >= 0 ? prev.filter((x) => x !== id) : prev.concat([id]);
    });
  }, []);

  /* ────────────────────────────────────────────────────────────────────
     拖动会话（move / trim）—— 只在松手时发一次 IPC
     ──────────────────────────────────────────────────────────────────── */
  const detach = useCallback(() => {
    const fn = detachRef.current;
    detachRef.current = null;
    if (typeof fn === 'function') fn();
  }, []);

  useEffect(() => () => { detach(); }, [detach]); // 卸载时把 window 监听摘掉

  /** 事件坐标 → 轨道内容坐标（秒）。lane 的 rect 已含滚动偏移，故 scrollLeft 传 0。 */
  const secAtClientX = useCallback((laneEl, clientX) => {
    if (!laneEl) return 0;
    const r = laneEl.getBoundingClientRect();
    return Math.max(0, xToSeconds(clientX - r.left, { pxPerSec, scrollLeft: 0 }));
  }, [pxPerSec]);

  const beginSession = useCallback((onMove) => {
    const move = (ev) => { onMove(ev, false); };
    const up = (ev) => { onMove(ev, true); cleanup(); };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragRef.current = null;
      setGhost(null);
      detachRef.current = null;
    };
    detachRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, []);

  /** 片段主体按下 = 开始「移动」（横向吸附 0.1s、纵向跨轨）。 */
  const beginMove = useCallback((ev, clip) => {
    if (!clip) return;
    ev.preventDefault();
    ev.stopPropagation();
    selectClip(clip, ev.shiftKey);
    dragRef.current = {
      kind: 'move',
      clipId: String(clip.id),
      origin: clip,
      x0: ev.clientX,
      y0: ev.clientY,
      row0: Math.max(0, rows.findIndex((r) => String(r.id) === String(clip.track))),
    };
    setGhost({
      kind: 'move',
      clipId: String(clip.id),
      start: n(clip.start, 0),
      end: n(clip.end, 0),
      track: clip.track,
      reason: '',
    });
    beginSession((e2, isUp) => {
      const d = dragRef.current;
      if (!d || d.kind !== 'move') return;
      // ★ 横向：先把「原始起点 + 原始位移」吸到 0.1s 网格，再减回原始起点。
      //   不要直接吸附「位移量」——那样起点 3.33s 的片段一拖就跳到 3.3s，
      //   即使位移是 0 也会瞬移。吸附必须作用在**绝对时刻**上。
      const rawDelta = (e2.clientX - d.x0) / pxPerSec;
      const targetStart = Math.max(0, snapToGrid(n(d.origin.start, 0) + rawDelta, GRID_SEC));
      const dur = Math.max(0, n(d.origin.end, 0) - n(d.origin.start, 0));
      // 纵向：位移 / 行高 = 跨了几行。clamp 到 [0, rows.length-1]，
      // 拖出时间轴上下边缘时**当作停在最上/最下一行**，而不是取消操作。
      const rowDelta = Math.round((e2.clientY - d.y0) / TRACK_H);
      const rowIdx = Math.max(0, Math.min(rows.length - 1, d.row0 + rowDelta));
      const target = rows[rowIdx];
      const trackId = target ? String(target.id) : String(d.origin.track);
      setGhost({ kind: 'move', clipId: d.clipId, start: targetStart, end: targetStart + dur, track: trackId, reason: '' });
      dragRef.current = { ...d, pendingStart: targetStart, pendingTrack: trackId };
      if (isUp) {
        const moved = Math.abs(targetStart - n(d.origin.start, 0)) > 1e-6 || trackId !== String(d.origin.track);
        dragRef.current = null;
        if (moved) {
          applyEdit('clipsMove', { moves: [{ clipId: d.clipId, start: targetStart, trackId }] });
        }
      }
    });
  }, [rows, pxPerSec, beginSession, selectClip, applyEdit]);

  /** 左右边缘 6px 热区按下 = 开始「裁剪」。 */
  const beginTrim = useCallback((ev, clip, edge) => {
    if (!clip) return;
    ev.preventDefault();
    ev.stopPropagation();
    selectClip(clip, false);
    dragRef.current = { kind: 'trim', clipId: String(clip.id), edge, origin: clip, x0: ev.clientX };
    setGhost({
      kind: 'trim',
      clipId: String(clip.id),
      start: n(clip.start, 0),
      end: n(clip.end, 0),
      track: clip.track,
      reason: '',
    });
    const md = findMedia(mediaMap, clip.media);
    const mediaDuration = md && n(md.duration, 0) > 0 ? n(md.duration, 0) : null;
    beginSession((e2, isUp) => {
      const d = dragRef.current;
      if (!d || d.kind !== 'trim') return;
      const raw = (e2.clientX - d.x0) / pxPerSec;
      const res = clampTrim(d.origin, d.edge, raw, mediaDuration);
      const start0 = n(d.origin.start, 0);
      const end0 = n(d.origin.end, 0);
      const gs = d.edge === 'start' ? start0 + res.delta : start0;
      const ge = d.edge === 'end' ? end0 + res.delta : end0;
      setGhost({
        kind: 'trim',
        clipId: d.clipId,
        start: Math.min(gs, ge),
        end: Math.max(gs, ge),
        track: d.origin.track,
        reason: res.reason || '',
      });
      if (isUp) {
        dragRef.current = null;
        if (Math.abs(res.delta) > 1e-6) {
          applyEdit('clipTrim', { clipId: d.clipId, delta: res.delta, edge: d.edge });
        }
      }
    });
  }, [pxPerSec, mediaMap, beginSession, selectClip, applyEdit]);

  /* ────────────────────────────────────────────────────────────────────
     素材拖到轨道（HTML5 drag&drop）
     ──────────────────────────────────────────────────────────────────── */
  const onMediaDragStart = useCallback((ev, m) => {
    try {
      ev.dataTransfer.setData('text/plain', String(m.id));
      ev.dataTransfer.effectAllowed = 'copy';
    } catch (e) { /* 某些环境下 setData 会抛，不影响后续 */ }
    setMediaGhost({ mediaId: String(m.id), name: m.name || '素材', sec: 0, trackId: null });
  }, []);

  const onLaneDragOver = useCallback((ev, track) => {
    if (!mediaGhost) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) { /* ignore */ }
    // 落点同样吸附 0.1s —— 拖放和拖动移动必须用**同一个吸附口径**，
    // 否则用户会看到「自己拖的同一位置，两种操作落点不一样」。
    const sec = snapToGrid(secAtClientX(ev.currentTarget, ev.clientX), GRID_SEC);
    setMediaGhost((g) => (g ? { ...g, sec, trackId: String(track.id) } : g));
  }, [mediaGhost, secAtClientX]);

  const onLaneDrop = useCallback(async (ev, track) => {
    if (!mediaGhost) return;
    ev.preventDefault();
    const sec = snapToGrid(secAtClientX(ev.currentTarget, ev.clientX), GRID_SEC);
    const mediaId = mediaGhost.mediaId;
    setMediaGhost(null);
    await applyEdit('clipAdd', { mediaId, trackId: String(track.id), start: Math.max(0, sec) });
  }, [mediaGhost, secAtClientX, applyEdit]);

  /* ────────────────────────────────────────────────────────────────────
     片段操作：分割 / 删除 / 加轨
     ──────────────────────────────────────────────────────────────────── */
  const doSplit = useCallback(async () => {
    if (!snap) return;
    let ids = selIds.slice();
    if (!ids.length) {
      // 没选中任何片段时：把「播放头下压着的所有片段」都切一刀。
      // 这是剪映的实际行为（S 键是「在播放头处切」，不要求先选中）。
      ids = clips
        .filter((c) => {
          if (!c) return false;
          const s = n(c.start, 0);
          const e = n(c.end, 0);
          return playhead > s + 1e-6 && playhead < e - 1e-6;
        })
        .map((c) => String(c.id));
    } else {
      // 选中的片段也必须在播放头**内部**才能切（切在边界上 Concat 会拒）。
      ids = ids.filter((id) => {
        const c = clips.find((x) => x && String(x.id) === id);
        if (!c) return false;
        return playhead > n(c.start, 0) + 1e-6 && playhead < n(c.end, 0) - 1e-6;
      });
    }
    if (!ids.length) { showToast('播放头不在任何片段内部，切不了'); return; }
    await applyEdit('clipsSplit', { clipIds: ids, time: playhead });
  }, [snap, selIds, clips, playhead, applyEdit, showToast]);

  const doRemove = useCallback(async () => {
    if (!selIds.length) { showToast('先点选要删除的片段'); return; }
    const res = await applyEdit('clipsRemove', { clipIds: selIds.slice() });
    if (res && res.ok) setSelIds([]);
  }, [selIds, applyEdit, showToast]);

  const doAddTrack = useCallback(async (audio) => {
    // 音频轨加到底部：剪映里音频轨永远在视频轨下面，`bottom:true` 就是这个语义。
    await applyEdit('addTrack', audio ? { bottom: true } : {});
  }, [applyEdit]);

  /* ────────────────────────────────────────────────────────────────────
     键盘快捷键
     ──────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (ev) => {
      const t = ev.target;
      const tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || (t && t.isContentEditable);
      if (editable) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const step = ev.shiftKey ? 1 : 0.1;

      if (mod && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault();
        if (ev.shiftKey) doRedo(); else doUndo();
        return;
      }
      if (mod && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); doRedo(); return; }
      if (mod && (ev.key === 'b' || ev.key === 'B')) { ev.preventDefault(); doSplit(); return; }
      if (mod) return; // 其余的 Ctrl 组合交给系统（复制粘贴等）

      if (ev.key === ' ') { ev.preventDefault(); togglePlay(); return; }
      if (ev.key === 's' || ev.key === 'S') { ev.preventDefault(); doSplit(); return; }
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); doRemove(); return; }
      if (ev.key === 'Escape') { setPlaying(false); setSelIds([]); return; }
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        setPlaying(false);
        setPlayhead((p) => snapToGrid(Math.max(0, p - step), 0.01));
        return;
      }
      if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        setPlaying(false);
        setPlayhead((p) => snapToGrid(Math.min(playSpanRef.current, p + step), 0.01));
        return;
      }
      if (ev.key === 'Home') { ev.preventDefault(); setPlayhead(0); return; }
      if (ev.key === 'End') { ev.preventDefault(); setPlayhead(playSpanRef.current); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, doSplit, doRemove, togglePlay]);

  /* ────────────────────────────────────────────────────────────────────
     播放头跟随（用模型层的 secondsToX 带 scrollLeft，判断是否滚出视口）
     ──────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScreenX = secondsToX(playhead, { pxPerSec, scrollLeft }); // 相对可视区左边缘
    const viewW = el.clientWidth - HEAD_W;
    if (onScreenX < 0 || onScreenX > viewW) {
      el.scrollLeft = Math.max(0, playhead * pxPerSec - viewW / 2);
    }
  }, [playhead, pxPerSec, scrollLeft]);

  /* ────────────────────────────────────────────────────────────────────
     导出：picker → start → 500ms 轮询
     ──────────────────────────────────────────────────────────────────── */
  const beginExport = useCallback(async () => {
    if (!snap) { showToast('先新建或打开一个工程', true); return; }
    const v = validateExportOptions(exportOpts);
    if (!v.ok) { showToast('导出参数不对：' + v.errors[0], true); return; }
    const picked = await callApi('concatPickOutput', {
      defaultName: ((project && project.name) || '未命名工程') + '.mp4',
    });
    if (!picked || !picked.ok) {
      if (picked && picked.error) showToast(picked.error, true);
      return;
    }
    if (!picked.path) return; // 用户取消
    setExportPath(picked.path);
    const res = await callApi('concatExportStart', {
      output: picked.path,
      crf: v.value.crf,
      preset: v.value.preset,
      codec: v.value.codec,
      width: v.value.width,
      height: v.value.height,
    });
    if (!res || !res.ok || !res.job) {
      setExportJob({
        job: '',
        state: 'failed',
        stage: '',
        error: (res && res.error) || '导出启动失败',
        output: picked.path,
      });
      return;
    }
    setExportJob({
      job: String(res.job),
      state: 'running',
      stage: '',
      fraction: null,
      framesDone: 0,
      framesTotal: 0,
      output: picked.path,
      error: '',
    });
  }, [snap, exportOpts, project, showToast]);

  const exportJobId = exportJob && exportJob.job ? exportJob.job : '';
  const exportState = exportJob && exportJob.state ? exportJob.state : '';
  useEffect(() => {
    // 判据是「**不是终态就继续**」，不是「等于 running 才继续」—— 理由见 normState() 的注释。
    if (!exportJobId || isTerminalState(exportState)) return undefined;
    let alive = true;
    let polls = 0;
    const id = setInterval(async () => {
      polls += 1;
      if (polls > EXPORT_POLL_LIMIT) {
        setExportJob((e) => (e && e.job === exportJobId ? { ...e, state: 'failed', error: '导出超时（超过 1 小时没有结束）' } : e));
        return;
      }
      const res = await callApi('concatExportStatus', { job: exportJobId });
      if (!alive) return;
      if (!res || !res.ok) {
        setExportJob((e) => (e && e.job === exportJobId
          ? { ...e, state: 'failed', error: (res && res.error) || '查询导出状态失败' }
          : e));
        return;
      }
      setExportJob((e) => {
        if (!e || e.job !== exportJobId) return e;
        const next = {
          ...e,
          state: res.state || e.state,
          stage: res.stage || e.stage,
          fraction: res.fraction === undefined ? e.fraction : res.fraction,
          framesDone: res.framesDone === undefined ? e.framesDone : res.framesDone,
          framesTotal: res.framesTotal === undefined ? e.framesTotal : res.framesTotal,
          file: res.file || e.file,
          bytes: res.bytes === undefined ? e.bytes : res.bytes,
          error: res.error || '',
        };
        return next;
      });
    }, EXPORT_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [exportJobId, exportState]);

  const cancelExport = useCallback(async () => {
    if (!exportJobId) return;
    const res = await callApi('concatExportCancel', { job: exportJobId });
    if (res && res.ok === false && res.error) { showToast(res.error, true); return; }
    setExportJob((e) => (e ? { ...e, state: 'canceled', stage: '' } : e));
  }, [exportJobId, showToast]);

  const openExportFolder = useCallback(async () => {
    const file = (exportJob && (exportJob.file || exportJob.output)) || exportPath;
    if (!file) return;
    const api = typeof window === 'undefined' ? null : window.api;
    try {
      if (api && typeof api.showInFolder === 'function') await api.showInFolder(file);
      else if (api && typeof api.openPath === 'function') await api.openPath(file);
      else showToast('打不开文件夹：缺少系统通道', true);
    } catch (e) {
      showToast('打不开文件夹：' + ((e && e.message) || String(e)), true);
    }
  }, [exportJob, exportPath, showToast]);

  /* ────────────────────────────────────────────────────────────────────
     渲染：顶部
     ──────────────────────────────────────────────────────────────────── */
  const totalText = formatTimecode(span);

  const renderTopBar = () => (
    <div className="vs-top">
      <div className="vs-top-left">
        <span className="vs-projname" title={project ? project.name : ''}>
          {project ? (project.name || '未命名工程') : '视频精剪'}
        </span>
        {project ? (
          <span className="vs-projmeta">
            {project.width || 1920}×{project.height || 1080} · {project.fps || 30}fps · 共 {clips.length} 段
          </span>
        ) : null}
      </div>
      <div className="vs-top-mid">
        <button type="button" className="vs-btn is-primary" onClick={doNew} disabled={!apiOk || busy} data-vs-act="new">新建</button>
        <button type="button" className="vs-btn" onClick={doOpen} disabled={!apiOk || busy} data-vs-act="open">打开</button>
        <button type="button" className="vs-btn" onClick={doSave} disabled={!snap || busy} data-vs-act="save">保存</button>
        <span className="vs-top-sep" />
        <button
          type="button"
          className="vs-btn is-icon"
          onClick={doUndo}
          disabled={!snap || !snap.canUndo}
          title="撤销 (Ctrl+Z)"
          data-vs-act="undo"
        >↺</button>
        <button
          type="button"
          className="vs-btn is-icon"
          onClick={doRedo}
          disabled={!snap || !snap.canRedo}
          title="重做 (Ctrl+Shift+Z)"
          data-vs-act="redo"
        >↻</button>
        <span className="vs-top-sep" />
        <button type="button" className="vs-btn" onClick={doSplit} disabled={!snap} title="在播放头处分割 (S)" data-vs-act="split">分割</button>
        <button
          type="button"
          className="vs-btn"
          onClick={() => setTitleOpen(true)}
          disabled={!snap}
          title="在播放头处加一段文字标题（会弹出输入框，填你要显示的字）"
          data-vs-act="title-open"
        >＋ 标题</button>
        <button type="button" className="vs-btn" onClick={doRemove} disabled={!selIds.length} title="删除选中片段 (Delete)" data-vs-act="remove">删除</button>
      </div>
      <div className="vs-top-right">
        <button
          type="button"
          className="vs-btn is-primary"
          onClick={() => setExportOpen(true)}
          disabled={!apiOk}
          data-vs-act="export-open"
        >导出 mp4</button>
      </div>
    </div>
  );

  /* ────────────────────────────────────────────────────────────────────
     渲染：左栏（素材库）
     ──────────────────────────────────────────────────────────────────── */
  const renderMedia = () => (
    <div className="vs-panel is-grow">
      <div className="vs-panel-hd">
        <span>素材库</span>
        <span className="vs-count">{mediaList.length}</span>
      </div>
      <div style={{ padding: '8px 8px 0' }}>
        <button
          type="button"
          className="vs-btn"
          style={{ width: '100%' }}
          onClick={doImport}
          disabled={!snap || busy}
          title={importingN > 0 ? '正在导入 ' + importingN + ' 个素材…' : '选择视频 / 音频 / 图片导入到当前工程'}
          data-vs-act="import"
        >{importingN > 0 ? '导入中…（' + importingN + ' 个）' : '＋ 导入素材'}</button>
        {/*
          「一键铺开」：素材库 → 时间线的批量落位，剪映里最常用的一步。
          按钮语义按**实测**写：从播放头铺开、首尾相接、重叠时引擎会顺延。
          所以文案不写「追加到末尾」（那会与实测不符），也不写「不重叠地插入」
          （引擎确实会避让，但避让结果不是「插空」而是「顺延到第一个不冲突处」）。
        */}
        <button
          type="button"
          className="vs-btn"
          style={{ width: '100%', marginTop: 6 }}
          onClick={doSequenceAll}
          disabled={!snap || busy || mediaList.length === 0}
          title="把素材库里全部素材从播放头开始首尾相接铺到轨道上（画面进 V 轨、音频进 A 轨）"
          data-vs-act="sequence-all"
        >⇥ 一键铺开（从播放头）</button>
      </div>
      <div className="vs-panel-bd" style={{ paddingTop: 8 }}>
        {mediaList.length === 0 ? (
          <p className="vs-hint" style={{ padding: '10px 2px' }}>
            还没有素材。点上面的「导入素材」选视频 / 音频 / 图片，
            导入后把卡片拖到右边的轨道上就能剪。
          </p>
        ) : (
          mediaList.map((m) => {
            const kind = String(m.kind || 'video');
            return (
              <div
                key={m.id}
                className="vs-media-item"
                draggable
                onDragStart={(ev) => onMediaDragStart(ev, m)}
                onDragEnd={() => setMediaGhost(null)}
                title={m.path || m.name || ''}
                data-vs-media={m.id}
              >
                {/*
                  素材缩略图：Concat 只提供「按时刻抽时间轴帧」的通道，
                  **没有**「为某个素材单独出缩略图」的接口（`concatPreviewFrame` 的入参是
                  timeline 的 time，不是 mediaId）。所以这里用「类型块 + 文件名 + 时长」代替，
                  不做假缩略图（拿任意一帧冒充会误导用户以为那是这个素材的首帧）。
                */}
                <span className={'vs-media-thumb is-' + kind}>{mediaIcon(kind)}</span>
                <span className="vs-media-meta">
                  <span className="vs-media-name">{m.name || '（未命名）'}</span>
                  <span className="vs-media-sub">
                    {formatDuration(n(m.duration, 0))}
                    {m.width && m.height ? ' · ' + m.width + '×' + m.height : ''}
                    {mediaHasAudio(m) ? ' · 有音轨' : ''}
                  </span>
                </span>
                <span className="vs-media-add">拖到轨道</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  /* ────────────────────────────────────────────────────────────────────
     渲染：中上（预览 + 走带）
     ──────────────────────────────────────────────────────────────────── */
  const renderPreview = () => (
    <div className="vs-preview">
      <div className="vs-preview-stage">
        {/* 角标：诚实标注这不是播放器（见文件头） */}
        <span className="vs-preview-badge">帧预览 · 点位抽帧</span>
        <span className="vs-preview-badge is-right">{project ? (project.fps || 30) + 'fps' : '—'}</span>
        {preview.url ? (
          <img className="vs-preview-frame" src={preview.url} alt={'第 ' + formatTimecode(preview.time) + ' 帧预览'} />
        ) : (
          <div className="vs-preview-ph">
            {preview.busy ? '正在抽帧…'
              : (preview.error ? preview.error
                : '把播放头拖到任意位置，这里显示那一刻的画面')}
          </div>
        )}
        <span className="vs-preview-time">{formatTimecode(preview.time)}</span>
      </div>
      <div className="vs-transport">
        <button
          type="button"
          className="vs-btn is-icon"
          onClick={() => { setPlaying(false); seekTo(playhead - 0.1); }}
          title="后退 0.1s (←)"
        >◀</button>
        <button
          type="button"
          className="vs-btn is-icon"
          onClick={togglePlay}
          disabled={!snap}
          title={playing ? '暂停（逐帧游走）' : '逐帧游走（非实时播放）'}
          data-vs-act="play"
        >{playing ? '❚❚' : '▶'}</button>
        <button
          type="button"
          className="vs-btn is-icon"
          onClick={() => { setPlaying(false); seekTo(playhead + 0.1); }}
          title="前进 0.1s (→)"
        >▶|</button>
        <span className="vs-tc">
          {formatTimecode(playhead)}
          <span className="vs-tc-total"> / {totalText}</span>
        </span>
        {playing ? <span className="vs-projmeta">逐帧游走中…</span> : null}
        <span className="vs-zoom">
          <span>缩放</span>
          <input
            type="range"
            min={ZOOM_RANGE.min}
            max={ZOOM_RANGE.max}
            step="1"
            value={pxPerSec}
            onChange={(ev) => setPxPerSec(n(ev.target.value, DEFAULT_PX_PER_SEC))}
            aria-label="时间轴缩放"
          />
          <span>{pxPerSec}px/s</span>
        </span>
      </div>
    </div>
  );

  /* ────────────────────────────────────────────────────────────────────
     渲染：下（时间轴）
     ──────────────────────────────────────────────────────────────────── */
  const renderClip = (c) => {
    if (!c) return null;
    const id = String(c.id);
    const g = ghost && ghost.kind !== 'media' && ghost.clipId === id ? ghost : null;
    const st = g ? g.start : n(c.start, 0);
    const en = g ? g.end : n(c.end, 0);
    const left = secondsToX(st, { pxPerSec, scrollLeft: 0 });
    const width = Math.max(3, (en - st) * pxPerSec);
    const isSel = selIds.indexOf(id) >= 0;
    const kind = String(c.kind || '');
    const cls = 'vs-clip'
      + (kind === 'audio' ? ' is-audio' : '')
      + ((kind === 'title' || c.text) ? ' is-title' : '')
      + (isSel ? ' is-selected' : '')
      + (g ? ' is-ghosting' : '');
    const label = c.text || c.mediaName || (kind === 'audio' ? '音频' : '片段');
    return (
      <div
        key={id}
        className={cls}
        style={{ left: left + 'px', width: width + 'px' }}
        data-vs-clip={id}
        title={label + ' · ' + formatTimecode(st) + ' → ' + formatTimecode(en)}
        onPointerDown={(ev) => beginMove(ev, c)}
      >
        <span
          className="vs-clip-handle is-start"
          onPointerDown={(ev) => beginTrim(ev, c, 'start')}
          title="拖动裁剪入点"
        />
        <span className="vs-clip-label">{label}</span>
        <span
          className="vs-clip-handle is-end"
          onPointerDown={(ev) => beginTrim(ev, c, 'end')}
          title="拖动裁剪出点"
        />
        {g && g.reason ? <span className="vs-clip-reason">{describeTrimReason(g.reason)}</span> : null}
      </div>
    );
  };

  const renderTimeline = () => {
    const ticks = buildRulerTicks(span, pxPerSec);
    const lanes = rows.map((t) => {
      const kind = trackKindOf(t.id, clips);
      const on = clipsOnTrack(clips, t.id);
      const isTarget = mediaGhost && String(mediaGhost.trackId) === String(t.id);
      return (
        <div className={'vs-track' + (isTarget ? ' is-target' : '')} key={t.id} data-vs-track={t.id}>
          <div className="vs-track-head">
            <span className={'vs-track-label' + (kind === 'audio' ? ' is-audio' : '')}>{trackLabelFor(t, clips)}</span>
          </div>
          <div
            className={'vs-track-lane' + (isTarget ? ' is-hover' : '')}
            ref={(el) => { laneRefs.current[t.id] = el; }}
            onDragOver={(ev) => onLaneDragOver(ev, t)}
            onDragLeave={() => setMediaGhost((g) => (g ? { ...g, trackId: null } : g))}
            onDrop={(ev) => onLaneDrop(ev, t)}
            onPointerDown={(ev) => {
              // 点空白处：移动播放头 + 取消选中（不区分左右键，保持简单可预期）
              setSelIds([]);
              seekTo(secAtClientX(ev.currentTarget, ev.clientX));
            }}
          >
            {on.map(renderClip)}
            {isTarget && mediaGhost ? (
              <span
                className="vs-drop-ghost"
                style={{
                  left: secondsToX(mediaGhost.sec, { pxPerSec, scrollLeft: 0 }) + 'px',
                  width: Math.max(40, 60) + 'px',
                }}
              >
                {mediaGhost.name}
              </span>
            ) : null}
          </div>
        </div>
      );
    });

    return (
      <div className="vs-timeline">
        <div className="vs-tl-bar">
          <span className="vs-tl-title">时间轴</span>
          <span>{rows.length} 条轨道</span>
          <span className="vs-spacer" />
          <button type="button" className="vs-btn" onClick={() => doAddTrack(false)} disabled={!snap} data-vs-act="add-video-track">＋ 视频轨</button>
          <button type="button" className="vs-btn" onClick={() => doAddTrack(true)} disabled={!snap} data-vs-act="add-audio-track">＋ 音频轨</button>
        </div>
        <div
          className="vs-tl-scroll"
          ref={scrollRef}
          onScroll={(ev) => setScrollLeft(ev.currentTarget.scrollLeft)}
        >
          <div className="vs-tl-inner" style={{ width: contentWidth + 'px' }}>
            <div
              className="vs-ruler"
              style={{ marginLeft: HEAD_W + 'px' }}
              onPointerDown={(ev) => seekTo(secAtClientX(ev.currentTarget, ev.clientX))}
            >
              {ticks.map((tk) => (
                <span key={'tick-' + tk.sec}>
                  <span
                    className={'vs-tick' + (tk.major ? ' is-major' : '')}
                    style={{ left: Math.round(tk.sec * pxPerSec) + 'px' }}
                  />
                  {tk.major ? (
                    <span className="vs-tick-label" style={{ left: Math.round(tk.sec * pxPerSec) + 'px' }}>
                      {tk.label}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
            {lanes}
            {/* 播放头：画在**内容坐标系**里（left = sec * pxPerSec），
                这样横向滚动时它跟着内容一起走，不需要在滚动事件里重算。 */}
            <div
              className="vs-playhead"
              style={{ left: (HEAD_W + secondsToX(playhead, { pxPerSec, scrollLeft: 0 })) + 'px' }}
              data-vs-playhead={Math.round(playhead * 10) / 10}
            />
          </div>
        </div>
      </div>
    );
  };

  /* ────────────────────────────────────────────────────────────────────
     渲染：右栏（属性面板）
     ──────────────────────────────────────────────────────────────────── */
  const renderProps = () => {
    if (!snap) return null;
    if (!single) {
      return (
        <div className="vs-panel is-grow">
          <div className="vs-panel-hd">
            <span>属性</span>
            {selIds.length > 1 ? <span className="vs-count">{selIds.length} 段</span> : null}
          </div>
          <div className="vs-panel-bd">
            <p className="vs-props-empty">
              {selIds.length > 1
                ? '选中了 ' + selIds.length + ' 段。属性面板一次只编辑一段 —— 点其中一段即可。'
                : '点时间轴上的一段，这里就能改变换 / 不透明度 / 音量 / 淡入淡出 / 变速。'}
            </p>
            <div className="vs-group">
              <div className="vs-group-title">工程</div>
              <div className="vs-kv"><span>画布</span><span>{(project && project.width) || 1920}×{(project && project.height) || 1080}</span></div>
              <div className="vs-kv"><span>帧率</span><span>{(project && project.fps) || 30} fps</span></div>
              <div className="vs-kv"><span>片段数</span><span>{clips.length}</span></div>
              <div className="vs-kv"><span>时间轴长度</span><span>{formatTimecode(estimateTimelineDuration(clips))}</span></div>
            </div>
          </div>
        </div>
      );
    }

    const c = single;
    const isAudio = String(c.kind) === 'audio';
    const md = findMedia(mediaMap, c.media);
    const mediaDuration = md && n(md.duration, 0) > 0 ? n(md.duration, 0) : null;

    return (
      <div className="vs-panel is-grow">
        <div className="vs-panel-hd">
          <span>属性</span>
          <span className="vs-count">{isAudio ? '音频' : (c.text ? '字幕/标题' : '视频')}</span>
        </div>
        <div className="vs-panel-bd">
          <div className="vs-clipname" title={c.mediaName || c.text || ''}>
            {c.text || c.mediaName || String(c.kind || '片段')}
          </div>
          <div className="vs-kv"><span>入点</span><span>{formatTimecode(n(c.start, 0))}</span></div>
          <div className="vs-kv"><span>出点</span><span>{formatTimecode(n(c.end, 0))}</span></div>
          <div className="vs-kv"><span>时长</span><span>{formatDuration(n(c.duration, n(c.end, 0) - n(c.start, 0)))}</span></div>
          <div className="vs-kv"><span>轨道</span><span>{String(c.track)}</span></div>

          {/*
            「分离音频」/「还原音频」—— 剪映里视频片段的右键第一项。
            为什么判据用 canDetachAudio() 而不是 `disabled={!isVideo}`：
            图片 / 标题 / 无声视频 / 已经分离过的片段，点了都是**静默 no-op**
            （实测 Concat 会回 ok 但什么都不做），所以这里必须提前拦住并说清原因，
            而不是让用户点三次、时间轴上什么都没有。
          */}
          {(() => {
            const detachGate = canDetachAudio(c, md);
            const canReattach = String(c.kind) === 'audio' || c.muted === true;
            if (!detachGate.ok && !canReattach) {
              return (
                <div className="vs-group" style={{ marginTop: 12 }}>
                  <div className="vs-group-title">音频</div>
                  <p className="vs-hint">{detachGate.reason || '这段片段没有可分离的音轨'}</p>
                </div>
              );
            }
            return (
              <div className="vs-group" style={{ marginTop: 12 }}>
                <div className="vs-group-title">音频</div>
                {detachGate.ok ? (
                  <button
                    type="button"
                    className="vs-btn"
                    style={{ width: '100%' }}
                    onClick={doDetachAudio}
                    title="把这段视频的声音拆成一条独立音频片段（之后可以单独调音量 / 单独切 / 单独删）"
                    data-vs-act="detach-audio"
                  >分离音频</button>
                ) : null}
                {canReattach ? (
                  <button
                    type="button"
                    className="vs-btn"
                    style={{ width: '100%', marginTop: detachGate.ok ? 6 : 0 }}
                    onClick={doReattachAudio}
                    title="把拆出去的音频片段并回这段视频（删掉独立音频片段、取消静音）"
                    data-vs-act="reattach-audio"
                  >还原音频</button>
                ) : null}
                {detachGate.warn ? <p className="vs-hint">{detachGate.warn}</p> : null}
              </div>
            );
          })()}

          <div className="vs-group" style={{ marginTop: 12 }}>
            <div className="vs-group-title">变换</div>
            <NumField
              label="缩放"
              value={n(c.scale, 1)}
              min={0.01}
              max={20}
              step={0.01}
              unit="×"
              onCommit={(v) => applyEdit('clipTransform', { clipId: String(c.id), scale: v })}
            />
            <NumField
              label="横向位移"
              value={n(c.offsetX, 0)}
              min={-10000}
              max={10000}
              unit="px"
              onCommit={(v) => applyEdit('clipTransform', { clipId: String(c.id), offsetX: v })}
            />
            <NumField
              label="纵向位移"
              value={n(c.offsetY, 0)}
              min={-10000}
              max={10000}
              unit="px"
              onCommit={(v) => applyEdit('clipTransform', { clipId: String(c.id), offsetY: v })}
            />
            <NumField
              label="旋转"
              value={n(c.rotation, 0)}
              min={-3600}
              max={3600}
              unit="°"
              onCommit={(v) => applyEdit('clipTransform', { clipId: String(c.id), rotation: v })}
            />
          </div>

          <div className="vs-group">
            <div className="vs-group-title">外观</div>
            <NumField
              label="不透明度"
              value={Math.round(n(c.opacity, 1) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              onCommit={(v) => applyEdit('clipUpdate', { clipId: String(c.id), patch: { opacity: v / 100 } })}
            />
            <NumField
              label="音量"
              value={Math.round(n(c.volume, 1) * 100)}
              min={0}
              max={200}
              step={1}
              unit="%"
              onCommit={(v) => applyEdit('clipUpdate', { clipId: String(c.id), patch: { volume: v / 100 } })}
            />
            <NumField
              label="淡入"
              value={n(c.fadeIn, 0)}
              min={0}
              max={mediaDuration || 600}
              step={0.1}
              unit="s"
              onCommit={(v) => applyEdit('clipUpdate', { clipId: String(c.id), patch: { fadeIn: v } })}
            />
            <NumField
              label="淡出"
              value={n(c.fadeOut, 0)}
              min={0}
              max={mediaDuration || 600}
              step={0.1}
              unit="s"
              onCommit={(v) => applyEdit('clipUpdate', { clipId: String(c.id), patch: { fadeOut: v } })}
            />
            <div className="vs-field">
              <label htmlFor="vs-f-muted">静音</label>
              <input
                id="vs-f-muted"
                type="checkbox"
                checked={!!c.muted}
                onChange={(ev) => applyEdit('clipUpdate', { clipId: String(c.id), patch: { muted: ev.target.checked } })}
              />
              <span className="vs-unit">整段不出声</span>
            </div>
          </div>

          <div className="vs-group">
            <div className="vs-group-title">变速</div>
            <NumField
              label="速度"
              value={n(c.speed, 1)}
              min={0.0625}
              max={16}
              step={0.0625}
              unit="×"
              onCommit={(v) => applyEdit('clipSpeed', { clipId: String(c.id), speed: v })}
            />
            <div className="vs-field">
              <button type="button" className="vs-btn" style={{ flex: '1 1 0' }} onClick={() => applyEdit('clipSpeed', { clipId: String(c.id), speed: 0.5 })}>0.5×</button>
              <button type="button" className="vs-btn" style={{ flex: '1 1 0' }} onClick={() => applyEdit('clipSpeed', { clipId: String(c.id), speed: 1 })}>1×</button>
              <button type="button" className="vs-btn" style={{ flex: '1 1 0' }} onClick={() => applyEdit('clipSpeed', { clipId: String(c.id), speed: 2 })}>2×</button>
            </div>
            <p className="vs-hint">Concat 允许 0.0625× ~ 16×（超出会被拒）。</p>
          </div>

          <div className="vs-group">
            <div className="vs-group-title">关键帧</div>
            <div className="vs-field">
              <label htmlFor="vs-f-kfprop">属性</label>
              <select id="vs-f-kfprop" value={kfProp} onChange={(ev) => setKfProp(ev.target.value)}>
                {KEYFRAME_PROPERTIES.map((p) => (
                  <option key={p} value={p}>{KEYFRAME_PROPERTY_LABELS[p] || p}</option>
                ))}
              </select>
            </div>
            <NumField label="位置" value={kfAt} min={0} max={1} step={0.01} unit="0~1" onCommit={setKfAt} />
            <NumField label="值" value={kfVal} step={0.01} onCommit={setKfVal} />
            <div className="vs-field">
              <button
                type="button"
                className="vs-btn"
                style={{ flex: '1 1 0' }}
                onClick={() => applyEdit('keyframeSet', {
                  clipId: String(c.id), property: kfProp, at: Math.max(0, Math.min(1, n(kfAt, 0))), value: n(kfVal, 0),
                })}
              >设关键帧</button>
              <button
                type="button"
                className="vs-btn"
                style={{ flex: '1 1 0' }}
                onClick={() => applyEdit('keyframeClear', {
                  clipId: String(c.id), property: kfProp, at: Math.max(0, Math.min(1, n(kfAt, 0))),
                })}
              >清除</button>
            </div>
            <p className="vs-hint">位置 0 = 片段入点，1 = 出点。</p>
          </div>

          <div className="vs-group">
            <button type="button" className="vs-btn is-danger" style={{ width: '100%' }} onClick={doRemove}>
              删除这段 (Delete)
            </button>
          </div>
        </div>
      </div>
    );
  };

  /* ────────────────────────────────────────────────────────────────────
     渲染：字幕批量添加（放左栏下方）
     ──────────────────────────────────────────────────────────────────── */
  /**
   * 【2026-11-10 加 AI】老板原话：「输入字幕 还有功能这一块是灰色的 **并没有AI功能**」。
   *   改之前这里只有「贴文本 + 固定 3 秒一条」，等于让用户自己断句、自己数秒 —— 手摇表格。
   *   现在一行文案进来，AI 负责断句，`layoutCaptions()` 负责排时间轴（两条职责分开的原因
   *   见 services/videoCaptionAI.js 头注：模型算时间必然重叠/越界，且每次都不一样）。
   *   ★ 灰掉的按钮必须**说清为什么灰**：两个按钮下面那行灰提示就是干这个的
   *     （"先贴一段文案"／"AI 正在切…"／"已切 N 条，可直接加"）。
   */
  const captionLines = String(captionText).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const captionPlan = layoutCaptions(captionLines, { startAt: 0, cps: CAPTION_CPS });
  const captionPlanSec = captionPlan.length ? captionPlan[captionPlan.length - 1].end : 0;

  const doAiCaptions = async () => {
    if (!snap || captionAiBusy) return;
    if (!captionText.trim()) { showToast('先贴一段口播稿或文案，AI 才能切', true); return; }
    setCaptionAiBusy(true);
    const res = await genCaptionLines({
      script: captionText,
      maxChars: CAPTION_MAX_CHARS,
      duration: span,
    });
    setCaptionAiBusy(false);
    if (!res.ok) { showToast(res.error || 'AI 切字幕失败', true); return; }
    setCaptionText(res.lines.join('\n'));
    // 用与「加字幕」**同一套**排轴算法算一遍时长：界面显示的数字必须等于真加进时间轴的。
    const laid = layoutCaptions(res.lines, { startAt: playhead, cps: CAPTION_CPS });
    setCaptionSecs(laid.map((c) => Math.round((c.end - c.start) * 100) / 100));
    showToast('AI 切了 ' + res.lines.length + ' 条，约 '
      + (laid.length ? Math.round((laid[laid.length - 1].end - laid[0].start) * 10) / 10 : 0) + ' 秒');
  };

  const renderCaptions = () => (
    <div className="vs-panel">
      <div className="vs-panel-hd">
        <span>字幕</span>
        <span className="vs-panel-note">{captionLines.length ? captionLines.length + ' 条 · 约 ' + (Math.round(captionPlanSec * 10) / 10) + 's' : 'AI 断句'}</span>
      </div>
      <div className="vs-panel-bd">
        <div className="vs-field is-wide">
          <label htmlFor="vs-f-caption">贴一段口播稿/文案，AI 自动断句并排好时长</label>
          <textarea
            id="vs-f-caption"
            rows={3}
            value={captionText}
            onChange={(ev) => { setCaptionText(ev.target.value); setCaptionSecs([]); }}
            placeholder={'把整段口播稿贴进来 —— AI 会切成每条不超过 ' + CAPTION_MAX_CHARS + ' 字的字幕\n也可以自己一行一条写'}
            style={{
              width: '100%',
              fontSize: 12,
              fontFamily: 'inherit',
              color: 'var(--loc-vs-text)',
              background: 'var(--loc-vs-panel2)',
              border: '1px solid var(--loc-vs-line)',
              borderRadius: 6,
              padding: '6px 7px',
              resize: 'vertical',
            }}
          />
        </div>
        <div className="vs-row2">
          <button
            type="button"
            className="vs-btn is-primary"
            data-vs-act="caption-ai"
            disabled={!snap || captionAiBusy || !captionText.trim()}
            onClick={doAiCaptions}
            title={!captionText.trim() ? '先在上面贴一段文案' : '让 AI 断句并算好每条时长'}
          >{captionAiBusy ? 'AI 正在切…' : 'AI 切字幕'}</button>
          <button
            type="button"
            className="vs-btn"
            data-vs-act="caption-add"
            disabled={!snap || !captionText.trim()}
            onClick={async () => {
              if (!captionLines.length) return;
              // 依次排列：从播放头起，每条时长优先用 AI 算的，没有就退回固定值。
              let t = playhead;
              const captions = captionLines.map((text, i) => {
                const dur = captionSecs.length === captionLines.length && captionSecs[i] > 0
                  ? captionSecs[i] : CAPTION_SEC;
                const start = Math.round(t * 100) / 100;
                t += dur;
                return { start, end: Math.round(t * 100) / 100, text };
              });
              const res = await applyEdit('captionsAdd', { captions });
              if (res && res.ok) {
                setCaptionText(''); setCaptionSecs([]);
                showToast('加了 ' + captions.length + ' 条字幕');
              }
            }}
          >加字幕</button>
        </div>
        <div className="vs-panel-note">
          {!captionText.trim()
            ? '先贴一段文案 —— 贴好后两个按钮就亮了'
            : (captionAiBusy
              ? '正在按意群断句，通常几秒'
              : (captionSecs.length
                ? 'AI 已排好每条时长，直接点「加字幕」'
                : '没切过也能加：按每行 ' + CAPTION_SEC + ' 秒排'))}
        </div>
      </div>
    </div>
  );

  /* ────────────────────────────────────────────────────────────────────
     渲染：导出弹层
     ──────────────────────────────────────────────────────────────────── */
  const renderExportDialog = () => {
    if (!exportOpen) return null;
    const pct = exportPercent(exportJob || {});
    // 一律走归一化值，不跟 Concat 的原始大小写赌（见 normState 的注释）。
    const st = normState(exportState);
    const failed = st === 'failed' || st === 'error';
    const done = st === 'done' || st === 'finished' || st === 'complete' || st === 'completed';
    const canceled = st === 'canceled' || st === 'cancelled';
    const running = !!exportJob && !!exportJob.job && !failed && !done && !canceled;
    const outFile = (exportJob && (exportJob.file || exportJob.output)) || exportPath;

    /** 条 + 右侧百分数字。`pct === null` ⇒ 不画条（见模型层 exportPercent 的注释）。 */
    const pctBar = () => {
      if (pct === null) return null;
      return (
        <div className="vs-pct">
          <div
            className="vs-bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={pct}
            data-vs-progress-pct={pct}
          >
            <i style={{ width: pct + '%' }} />
          </div>
          <span className="vs-pct-num" data-vs-progress-num={pct} aria-hidden="true">{pct}%</span>
        </div>
      );
    };

    return (
      <div className="vs-mask" role="dialog" aria-modal="true" aria-label="导出 mp4">
        <div className="vs-dialog">
          <div className="vs-dialog-hd">
            <span>导出 mp4</span>
            <button type="button" className="vs-btn is-ghost" onClick={() => setExportOpen(false)}>关闭</button>
          </div>
          <div className="vs-dialog-bd">
            {outFile ? <span className="vs-outpath">{outFile}</span> : null}

            <div className="vs-field">
              <label htmlFor="vs-f-codec">编码</label>
              <select
                id="vs-f-codec"
                value={exportOpts.codec}
                disabled={running}
                onChange={(ev) => setExportOpts((o) => ({ ...o, codec: ev.target.value }))}
              >
                {EXPORT_CODECS.map((cd) => <option key={cd} value={cd}>{cd}</option>)}
              </select>
            </div>
            <div className="vs-field">
              <label htmlFor="vs-f-preset">preset</label>
              <select
                id="vs-f-preset"
                value={exportOpts.preset}
                disabled={running}
                onChange={(ev) => setExportOpts((o) => ({ ...o, preset: ev.target.value }))}
              >
                {EXPORT_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <NumField
              label="CRF"
              value={exportOpts.crf}
              min={0}
              max={255}
              step={1}
              unit="0~255"
              onCommit={(v) => setExportOpts((o) => ({ ...o, crf: v }))}
            />
            <NumField
              label="宽度"
              value={exportOpts.width}
              min={2}
              max={MAX_EXPORT_EDGE}
              step={2}
              unit="px"
              onCommit={(v) => setExportOpts((o) => ({ ...o, width: v }))}
            />
            <NumField
              label="高度"
              value={exportOpts.height}
              min={2}
              max={MAX_EXPORT_EDGE}
              step={2}
              unit="px"
              onCommit={(v) => setExportOpts((o) => ({ ...o, height: v }))}
            />
            <p className="vs-hint">宽高必须是偶数（H.264 的色度抽样要求），上限 {MAX_EXPORT_EDGE}。</p>

            {running ? (
              <div style={{ marginTop: 14 }}>
                <div className="vs-stage-row">
                  <span className="vs-stage-name">{describeExportStage(exportJob && exportJob.stage)}</span>
                  {exportJob && n(exportJob.framesTotal, 0) > 0 ? (
                    <span>
                      {(exportJob.framesDone || 0)} / {exportJob.framesTotal} 帧
                    </span>
                  ) : null}
                </div>
                {pctBar()}
                {pct === null ? <p className="vs-hint">引擎还没报出可用的进度数字，先显示阶段。</p> : null}
              </div>
            ) : null}

            {done ? (
              <div className="vs-ok">
                导出完成 · {exportJob && exportJob.bytes ? formatBytes(exportJob.bytes) : '已写入文件'}
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="vs-btn" onClick={openExportFolder}>打开文件夹</button>
                </div>
              </div>
            ) : null}

            {canceled ? <div className="vs-err">已取消导出。</div> : null}
            {failed ? <div className="vs-err">{exportJob && exportJob.error ? exportJob.error : '导出失败'}</div> : null}
          </div>
          <div className="vs-dialog-ft">
            <button
              type="button"
              className="vs-btn"
              onClick={() => setExportOpen(false)}
              disabled={running}
            >关闭</button>
            <span className="vs-spacer" />
            {running ? (
              <button type="button" className="vs-btn is-danger" onClick={cancelExport}>取消导出</button>
            ) : (
              <button
                type="button"
                className="vs-btn is-primary"
                onClick={beginExport}
                disabled={!snap}
                data-vs-act="export-start"
              >{done ? '再导一次' : '开始导出'}</button>
            )}
          </div>
        </div>
      </div>
    );
  };

  /* ────────────────────────────────────────────────────────────────────
     渲染：加标题弹层
     ────────────────────────────────────────────────────────────────────
     文案刻意写成「画面上要显示的字」：老板的原始症状正是"加了标题什么都看不见"，
     所以输入框的 label / placeholder / 说明都必须能让人一眼看出"我填的东西会出现在
     画面上"，而不是一个"样式对象里某个叫 content 的字段"。
     ──────────────────────────────────────────────────────────────────── */
  const renderTitleDialog = () => {
    if (!titleOpen) return null;
    const clean = normalizeTitleText(titleText);
    const tooLong = String(titleText || '').replace(/\r\n?/g, '\n').trim().length > MAX_TITLE_CHARS;
    return (
      <div className="vs-mask" role="dialog" aria-modal="true" aria-label="加文字标题">
        <div className="vs-dialog">
          <div className="vs-dialog-hd">
            <span>加文字标题</span>
            <button type="button" className="vs-btn is-ghost" onClick={() => setTitleOpen(false)}>关闭</button>
          </div>
          <div className="vs-dialog-bd">
            <div className="vs-field is-wide">
              <label htmlFor="vs-f-title">画面上要显示的字（可多行）</label>
              <textarea
                id="vs-f-title"
                rows={4}
                value={titleText}
                onChange={(ev) => setTitleText(ev.target.value)}
                placeholder={'例如：第一章 · 出发\n（会原样显示在画面中央）'}
                data-vs-title-input="1"
                style={{
                  width: '100%',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  color: 'var(--loc-vs-text)',
                  background: 'var(--loc-vs-panel2)',
                  border: '1px solid var(--loc-vs-line)',
                  borderRadius: 6,
                  padding: '7px 8px',
                  resize: 'vertical',
                }}
              />
            </div>
            <div className="vs-kv">
              <span>出现在</span>
              <span>{formatTimecode(Math.max(0, n(playhead, 0)))} 起，{DEFAULT_TITLE_SEC} 秒，画面中央</span>
            </div>
            <div className="vs-kv"><span>轨道</span><span>自动放到画面之上的一条空轨</span></div>
            <p className="vs-hint">
              默认白字 + 黑描边（压在浅色画面上也看得见），长句会在画面内自动换行；
              加完之后在右栏可以改不透明度 / 位移。
            </p>
            {tooLong ? <p className="vs-err">文字超过 {MAX_TITLE_CHARS} 字，只保留前 {MAX_TITLE_CHARS} 字。</p> : null}
            {!clean ? <p className="vs-hint">还没有输入文字 —— 空标题会变成一段看不见的空片段，所以这里挡住了。</p> : null}
          </div>
          <div className="vs-dialog-ft">
            <span className="vs-spacer" />
            <button type="button" className="vs-btn" onClick={() => setTitleOpen(false)}>取消</button>
            <button
              type="button"
              className="vs-btn is-primary"
              onClick={doAddTitle}
              disabled={!snap || !clean}
              data-vs-act="add-title"
            >加到时间轴</button>
          </div>
        </div>
      </div>
    );
  };

  /* ────────────────────────────────────────────────────────────────────
     渲染：空态 / 未就绪
     ──────────────────────────────────────────────────────────────────── */
  const renderNotReady = (title, sub, actions) => (
    <div className="vs-empty">
      <span className="vs-empty-icon">✂️</span>
      <span className="vs-empty-title">{title}</span>
      <span className="vs-empty-sub">{sub}</span>
      {actions ? <div className="vs-empty-actions">{actions}</div> : null}
    </div>
  );

  /* ── 主渲染 ─────────────────────────────────────────────────────────── */
  // ★ 顺序有讲究：`probed` 之前不判 `apiOk`。
  //   两个 state 的初值都是 false，而 `apiOk` 是挂载后的 effect 才置位 ——
  //   若先判 apiOk，首帧会闪一下「当前环境没有视频引擎」（截图里就是一条假报错）。
  if (!probed) {
    /*
     * 探测中。**不许**只留一句「正在连接」——那句话在用户眼里和卡死没区别，
     * 而首次使用真的可能跑 1~2 分钟（本机没装 Concat ⇒ 自动下载 + 静默安装）。
     * 这里给三样东西：在做什么、已经多久、什么时候可以点重试。
     */
    const tired = probeSecs >= 20;
    const slow = probeSecs >= 60;
    return (
      <div className="vs-page" data-vs-root="1" data-vs-probing="1">
        {renderTopBar()}
        <div className="vs-body">
          {renderNotReady(
            '正在准备视频引擎（已 ' + probeSecs + ' 秒）',
            (slow
              ? '首次使用需要下载并安装剪辑引擎，通常 1~2 分钟。安装期间这里不会动，属于正常现象。'
              : '正在检查本机的剪辑引擎。装过的话几秒就好。')
            + (tired ? '等太久了可以点「重新探测」再试一次。' : ''),
            <>
              {tired ? (
                <button type="button" className="vs-btn is-primary" onClick={doReprobe} data-vs-act="reprobe">重新探测</button>
              ) : null}
              <span className="vs-empty-hint">这一步只在本机准备引擎，不需要联网登录。</span>
            </>,
          )}
        </div>
      </div>
    );
  }

  if (!apiOk) {
    /*
     * 优雅降级：主进程的 concat 通道还没落地时，这一页必须存在、必须说人话、必须不崩。
     * 文案里点名缺什么，方便下一个 agent 一眼定位（而不是看到「加载中」转圈）。
     */
    return (
      <div className="vs-page" data-vs-root="1">
        {renderTopBar()}
        <div className="vs-body">
          {renderNotReady(
            '当前环境没有视频引擎',
            '这一页要用的 Concat 通道（api.concatProbe / concatEdit / concatPreviewFrame …）没有注册到渲染层。'
            + '桌面版里应该自带，网页预览里没有 —— 换成桌面版打开这一页即可。',
            <>
              <button
                type="button"
                className="vs-btn"
                onClick={() => { const ok = hasConcatApi(); setApiOk(ok); if (!ok) showToast('还没有就绪，稍后再试', true); }}
              >重试连接</button>
            </>,
          )}
        </div>
      </div>
    );
  }

  if (probe && probe.ok === false) {
    /*
     * 探测失败。★ 把 `probe.error` **原样**显示出来，不许吞：
     *   改之前这个 state 从头到尾没被渲染过，用户只看到「还没有工程」+
     *   两个点了就报错的按钮 —— 那属于"界面在、原因不在"。
     */
    return (
      <div className="vs-page" data-vs-root="1" data-vs-probe-failed="1">
        {renderTopBar()}
        <div className="vs-body">
          {renderNotReady(
            '视频引擎没能启动',
            String(probe.error || '未知原因'),
            <>
              <button type="button" className="vs-btn is-primary" onClick={doReprobe} data-vs-act="reprobe-failed">重试</button>
            </>,
          )}
        </div>
        {toast ? <div className={'vs-toast' + (toast.isError ? ' is-error' : '')}>{toast.msg}</div> : null}
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="vs-page" data-vs-root="1">
        {renderTopBar()}
        <div className="vs-body">
          {renderNotReady(
            '还没有工程',
            '「视频精剪」先把素材导进一个工程，再在时间轴上剪，最后导出 mp4。'
            + '新建一个空工程开始，或者打开已有的工程目录接着剪。',
            <>
              <button type="button" className="vs-btn is-primary" onClick={doNew} disabled={busy} data-vs-act="new-empty">新建工程</button>
              <button type="button" className="vs-btn" onClick={doOpen} disabled={busy} data-vs-act="open-empty">打开已有工程</button>
            </>,
          )}
        </div>
        {toast ? <div className={'vs-toast' + (toast.isError ? ' is-error' : '')}>{toast.msg}</div> : null}
      </div>
    );
  }

  return (
    <div className="vs-page" data-vs-root="1" data-vs-company={companyId}>
      {renderTopBar()}
      <div className="vs-body">
        <div className="vs-left">
          {renderMedia()}
          {renderCaptions()}
        </div>
        <div className="vs-center">
          {renderPreview()}
          {renderTimeline()}
        </div>
        <div className="vs-right">
          {renderProps()}
        </div>
      </div>
      {renderExportDialog()}
      {renderTitleDialog()}
      {toast ? <div className={'vs-toast' + (toast.isError ? ' is-error' : '')}>{toast.msg}</div> : null}
    </div>
  );
}
