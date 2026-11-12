'use strict';
/**
 * 任务事件缓冲 + 断线重连补发（2026-10-19 第十八轮）
 *
 * 要解决的问题：渲染层刷新 / 关窗 / 网络抖动会让 fetch 断开，后端原来在
 * `res.on('close')` 里直接 abort 整个任务 —— 用户视角就是「活儿干到一半没了」。
 *
 * 现在改成：
 *   1. 客户端断开只「脱离」这条 SSE，不杀任务；任务继续跑完。
 *   2. 每个事件带单调递增 seq 并留在环形缓冲里。
 *   3. 重新连上（POST /api/chat/resume）时，从 fromSeq 之后补发，再切回实时流。
 *
 * 边界（必须诚实）：
 *   - 缓冲有上限（MAX_EVENTS / MAX_BYTES），超了丢最老的并在 resume 事件里报 truncated。
 *   - 任务结束后缓冲只保留 KEEP_AFTER_DONE_MS，过期回收（内存不能无限长）。
 *   - 任务跑到需要用户确认的闸门时，最多等 5 分钟；这期间重连接回来能继续回答。
 */

const MAX_EVENTS = 8000;                 // 单任务最多留多少个事件
const MAX_BYTES = 6 * 1024 * 1024;       // 单任务事件文本上限（约 6MB）
const KEEP_AFTER_DONE_MS = 10 * 60 * 1000; // 结束后缓冲再留 10 分钟（够刷新/重连取结果）
const MAX_TASKS = 12;                    // 同时在册的任务数上限（超出按最老的回收）
const MAX_IDLE_MS = 30 * 60 * 1000;      // 迟迟不结束的任务最多在册 30 分钟（防泄漏）

/** taskId -> stream */
const streams = new Map();

function sizeOf(ev) {
  try { return JSON.stringify(ev).length + 8; } catch { return 64; }
}

function writeTo(res, obj) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
    return true;
  } catch {
    return false;
  }
}

/** 建一条任务流。meta 只用于「有任务在后台跑」的提示，不做业务判断。 */
function createStream(taskId, meta) {
  const s = {
    taskId: String(taskId),
    meta: meta || {},
    events: [],
    bytes: 0,
    seq: 0,
    res: null,
    done: false,
    startedAt: Date.now(),
    endedAt: 0,
    dropped: 0,
    timer: null,
  };
  streams.set(s.taskId, s);
  sweep();
  return s;
}

/** 推一个事件：进缓冲 + 写给当前在线客户端。 */
function push(s, obj) {
  if (!s) return;
  // 心跳只用于保活，重连补发没有意义 —— 不占缓冲，否则几十分钟的任务全被心跳挤满。
  if (obj && obj.type === 'heartbeat') {
    writeTo(s.res, obj);
    return;
  }
  s.seq += 1;
  const ev = (obj && typeof obj === 'object') ? { ...obj, seq: s.seq } : { value: obj, seq: s.seq };
  s.events.push(ev);
  s.bytes += sizeOf(ev);
  while (s.events.length > MAX_EVENTS || s.bytes > MAX_BYTES) {
    const old = s.events.shift();
    s.bytes -= sizeOf(old);
    s.dropped += 1;
  }
  if (s.bytes < 0) s.bytes = 0;
  writeTo(s.res, ev);
}

/**
 * 把一条新的 SSE 接到任务流上：先补发 fromSeq 之后的历史，再切实时。
 * 若任务已结束，补发完直接结束连接。
 */
function attach(s, res, fromSeq) {
  const from = Number.isFinite(Number(fromSeq)) ? Math.max(0, Math.floor(Number(fromSeq))) : 0;
  s.res = res;
  writeTo(res, {
    type: 'resume',
    taskId: s.taskId,
    from,
    seq: s.seq,
    done: s.done,
    dropped: s.dropped,
    goal: (s.meta && s.meta.goal) || '',
    scope: (s.meta && s.meta.scope) || '',
  });
  for (const ev of s.events) {
    if (ev.seq <= from) continue;
    writeTo(res, ev);
  }
  if (s.done) {
    if (s.res === res) s.res = null;
    try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
  }
  return s;
}

/** 把当前这条 SSE 直接绑成任务的实时出口（不补发历史，用于全新任务）。 */
function bind(s, res) {
  if (!s) return;
  s.res = res;
}

/** 客户端断开：只摘掉这条连接，任务继续跑。 */
function detach(s, res) {
  if (!s) return false;
  if (s.res === res) {
    s.res = null;
    return true;
  }
  return false;
}

/** 任务收尾：标记完成、结束在线连接、安排缓冲回收。 */
function finish(s) {
  if (!s || s.done) return;
  s.done = true;
  s.endedAt = Date.now();
  const res = s.res;
  s.res = null;
  try { if (res && !res.writableEnded) res.end(); } catch { /* ignore */ }
  s.timer = setTimeout(() => { streams.delete(s.taskId); }, KEEP_AFTER_DONE_MS);
  if (s.timer && typeof s.timer.unref === 'function') s.timer.unref();
}

function get(taskId) {
  return streams.get(String(taskId || '')) || null;
}

/** 「还在后台跑」的清单（前端刷新后据此给出「接回来」入口）。已结束的一律不列。 */
function listActive() {
  const now = Date.now();
  const out = [];
  for (const s of streams.values()) {
    // 只报「还没结束」的：已结束的缓冲还留着是为了重连取结果，不该出现在「接回来」提示里。
    if (s.done) continue;
    // ★ 2026-02-16：内部子运行（第二执行实例 delegate）**不许**出现在这个清单里。
    //   它的出口是一个假 res，前端永远连不上 ⇒ 列出来就是"点得进去、接不回来"的假任务。
    //   判据来自 createStream 的 meta.internal（由 backend 按 payload.delegateDepth 打的标）。
    if (s.meta && s.meta.internal) continue;
    out.push({
      taskId: s.taskId,
      goal: (s.meta && s.meta.goal) || '',
      scope: (s.meta && s.meta.scope) || '',
      owner: (s.meta && s.meta.owner) || '',
      startedAt: s.startedAt,
      done: s.done,
      seq: s.seq,
      events: s.events.length,
      dropped: s.dropped,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

/** 回收：过期的已完成任务 + 超时未结束的僵尸任务 + 超出上限的最老任务。 */
function sweep() {
  const now = Date.now();
  for (const [id, s] of [...streams.entries()]) {
    if (s.done && now - s.endedAt > KEEP_AFTER_DONE_MS) { streams.delete(id); continue; }
    if (!s.done && now - s.startedAt > MAX_IDLE_MS) {
      try { finish(s); } catch { /* ignore */ }
    }
  }
  if (streams.size <= MAX_TASKS) return;
  const olds = [...streams.values()].sort((a, b) => a.startedAt - b.startedAt);
  while (streams.size > MAX_TASKS && olds.length) {
    const s = olds.shift();
    if (!s || s.res) continue; // 还连着客户端的先不动
    streams.delete(s.taskId);
  }
}

/** 仅供单测使用：清空注册表。 */
function _reset() {
  for (const s of streams.values()) {
    if (s.timer) { try { clearTimeout(s.timer); } catch { /* ignore */ } }
  }
  streams.clear();
}

module.exports = {
  createStream, push, attach, bind, detach, finish, get, listActive,
  MAX_EVENTS, MAX_BYTES, KEEP_AFTER_DONE_MS, MAX_TASKS,
  _reset,
};
