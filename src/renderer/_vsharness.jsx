/**
 * _vsharness —— 「视频精剪」的真浏览器验收壳（临时文件，交付前删除）。
 *
 * 【为什么必须有它】jsdom 里 `window.api` 的 IPC 是假的、没有真队列、没有真定时器竞争，
 *   "播放时编辑要等多久"这种问题在 jsdom 里根本量不出来 —— 上一轮思维导图就是这么
 *   自证全绿、用户装包仍拖不动的。
 *
 * 【这里模拟的是主进程的哪条真约束】
 *   `src/main/concatStudio.js` 的 `enqueue()`：**所有** concat 调用排同一条串行 Promise 链。
 *   本壳用同样的形状（一个 chain + 每次 350ms 抽帧 / 120ms 编辑）复现，
 *   于是"抽帧挤占编辑"这件事在浏览器里可以被量出来（毫秒数，不是感觉）。
 *
 * 暴露给 Playwright 的接口：
 *   window.__vsReady      —— 组件已挂载
 *   window.__vsLog        —— [{name, t0, t1}]，每次 IPC 的起止时刻
 *   window.__vsSnap()     —— 当前时间轴快照（用来判断"字幕真的加进去了"）
 *   window.__vsReset()    —— 清空日志
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import VideoStudio from './modules/VideoStudio.jsx';
import './styles/videostudio.css';
import './style.css';

/* ── 假的时间轴 ───────────────────────────────────────────────────────────── */
function makeTimeline() {
  return {
    duration: 12,
    tracks: [
      { id: 'T1', index: 0, kind: 'video', name: '视频 1' },
      { id: 'T2', index: 1, kind: 'video', name: '视频 2' },
    ],
    clips: [
      { id: 'c1', track: 'T1', kind: 'video', start: 0, end: 6, media: 'a.mp4', volume: 1 },
      { id: 'c2', track: 'T1', kind: 'video', start: 6, end: 12, media: 'b.mp4', volume: 1 },
    ],
  };
}
let timeline = makeTimeline();
let nextId = 100;

/* ── 串行队列（复刻 concatStudio.enqueue 的形状） ─────────────────────────── */
let chain = Promise.resolve();
const log = [];
function enqueue(name, fn, ms) {
  const run = chain.then(async () => {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms)); // 模拟真实耗时
    const out = fn();
    const t1 = performance.now();
    log.push({ name, t0, t1 });
    return out;
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

const PREVIEW_MS = 350;  // 1080p 抽帧实测数百毫秒
const EDIT_MS = 120;     // 本地工程读写，几十毫秒量级
// `?slowprobe=1` ⇒ 探测走 8 秒（模拟"本机没装引擎、正在下载安装"那条路，
// 也就是老板看到"一整块灰"的现场）。用来验「探测中」那屏到底长什么样。
const PROBE_MS = /slowprobe=1/.test(location.search) ? 8000 : 80;
// `?failprobe=1` ⇒ 探测失败（模拟本机装不上引擎）。用来验失败那屏有没有把原因说出来。
const PROBE_FAIL = /failprobe=1/.test(location.search);

function snapshot() {
  return { ok: true, project: { name: 'harness' }, media: [], timeline: JSON.parse(JSON.stringify(timeline)) };
}

function applyOp(op, args) {
  if (op === 'captionsAdd') {
    const list = Array.isArray(args && args.captions) ? args.captions : [];
    for (const c of list) {
      timeline.clips.push({
        id: 'cap' + (nextId += 1), track: 'T2', kind: 'caption',
        start: Number(c.start) || 0, end: Number(c.end) || 0, text: String(c.text || ''),
      });
    }
    return snapshot();
  }
  return snapshot();
}

window.api = {
  concatProbe: () => enqueue('probe', () => (PROBE_FAIL
    ? { ok: false, installed: false, error: '本机没有 Concat（视频精剪引擎），已尝试自动安装但没成功：下载超时' }
    : { ok: true, installed: true, version: '0.2.9', toolCount: 18, mode: 'mcp-stdio', path: 'C:/harness/concat.exe' }), PROBE_MS),
  concatOpen: () => enqueue('open', () => { timeline = makeTimeline(); return snapshot(); }, EDIT_MS),
  concatSnapshot: () => enqueue('snapshot', () => snapshot(), 60),
  concatPickMedia: async () => ({ canceled: false, filePaths: [] }),
  concatImportMedia: (a) => enqueue('import', () => snapshot(), EDIT_MS),
  concatEdit: (a) => enqueue('edit:' + ((a && a.op) || '?'), () => applyOp(a && a.op, (a && a.args) || {}), EDIT_MS),
  concatPreviewFrame: () => enqueue('frame', () => ({ ok: true, dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }), PREVIEW_MS),
  concatUndo: () => enqueue('undo', () => snapshot(), EDIT_MS),
  concatRedo: () => enqueue('redo', () => snapshot(), EDIT_MS),
  pickFolder: async () => ({ canceled: true, filePaths: [] }),
  concatPickOutput: async () => ({ canceled: true }),
  concatExportStart: () => enqueue('exportStart', () => ({ ok: true, job: 'j1' }), 100),
  concatExportStatus: () => enqueue('exportStatus', () => ({ ok: true, state: 'done', percent: 100 }), 50),
  concatExportCancel: () => enqueue('exportCancel', () => ({ ok: true }), 50),
  concatClose: () => enqueue('close', () => ({ ok: true }), 50),
};

window.__vsLog = log;
window.__vsSnap = () => JSON.parse(JSON.stringify(timeline));
window.__vsReset = () => { log.length = 0; };

/* ── 模型替身 ──────────────────────────────────────────────────────────────
 * 「AI 切字幕」要真的走一遍 `chatOnce` 才会验到接线（不只是验证函数）。
 * 这里把 `/api/chat-once` 拦下来，回一段**固定**模型输出：
 *   · 第一条故意给两个分句（测 splitLong 会不会按标点切）
 *   · 中间给一条超长（>18 字，测硬切上限）
 *   · 一条带列表符号的（测清洗）
 * ⚠️ 替身只替代「模型说了什么」，不替代「我们怎么排轴」—— 排轴仍走真实 `layoutCaptions`。
 */
localStorage.setItem('agent-settings', JSON.stringify({ apiKey: 'stub-key', baseURL: 'http://127.0.0.1:10119/v1' }));
const STUB_LINES = [
  '很多人以为种植牙越贵越好，其实关键在骨结合',
  '我们用的都是德国进口的种植体，五年留存率有临床数据支撑，而且每位医生都要经过三轮种植培训才能上手操作，这点对门店很关键',
  '- 到店可以先做一次免费的口腔 CT 检查',
];
const realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
window.fetch = async (url, opt) => {
  const u = String(url || '');
  if (u.indexOf('/api/chat-once') >= 0) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, content: JSON.stringify({ lines: STUB_LINES }) }),
    };
  }
  return realFetch ? realFetch(url, opt) : { ok: false, status: 404, json: async () => ({}) };
};
window.__vsStubLines = STUB_LINES;

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(VideoStudio, { companyId: 'harness' }));
window.__vsReady = true;
