'use strict';
/**
 * render.js —— action=render：按一份剪辑单，一口气把片子做出来。
 *
 * 编排顺序（每一步都对应一个已实测过的 Concat 工具）：
 *   project_create / project_open → media_import（去重）→ clip_add → clip_trim(in) → clips_move(挪回)
 *   → clip_trim(duration) → clip_update(patch) → clip_transform → clip_update(transitionIn)
 *   → keyframe_set… → title_add… → captions_add → timeline_read → export_start → export_wait
 *   → preview_frame → project_save → project_close
 *
 * 几处必须解释的"为什么这么绕"（都是实测结论，别照直觉改）：
 * ① **没有"建片段时直接给长度"的工具**。`clip_add` 只按素材原长落地，所以长度只能靠
 *    `clip_trim` 两刀切：先 `edge=start, delta=in` 切掉片头，再 `edge=end, delta=-(当前-目标)` 收尾。
 * ② **切片头会把片段在时间线上往右推**。实测：片段 0→3 秒，`edge=start delta=0.5` 之后变成
 *    0.5→3（start=0.5、duration=2.5、sourceStart=0.5）。所以要再用 `clips_move` 把它挪回
 *    用户要求的 start —— 否则每段带 in 的素材都会整体右移，接缝全错。
 * ③ **泳道顺序 = 叠放顺序**：`timeline.tracks` 越靠后越在上层（实测，见 lib/timeline.js 头注）。
 *    所以 tracks[0] 分配到 T1（最底），tracks[1] 到 T2…… 不够时用 `track_add` 现开一条（落在最上层）。
 * ④ **标题/字幕不指定泳道**，交给 Concat 自己找"画面之上"的空闲泳道（`title_add` 的 above /
 *    `captions_add` 的默认行为）。硬塞泳道 id 反而容易把字幕塞到画面下面被盖住。
 * ⑤ **导出是两段式**：`export_start` 立刻返回 job id，`export_wait` 才等。`export_wait` 的
 *    `timeoutSeconds` 默认 60、最大 600，到时还在跑就再调一次 —— 所以这里是个循环，
 *    而且循环必须受**本次调用的总时限**约束（不能把技能超时撑爆后才失败）。
 */

const fs = require('fs');
const path = require('path');

const { openSession } = require('./mcp');
const { parsePlan, planSummary } = require('./plan');
const { resolveAny, ensureDir, uniqueDir, safeSlug, isFile, workspace, stamp } = require('./paths');
const { fmtSeconds, fmtBytes } = require('./format');
const { readMp4Head } = require('./mp4');
const { readPngInfo } = require('./png');
const { describeTimeline } = require('./timeline');
const { resolveTransition } = require('./transitions');

/** 工作区下放工程的父目录名 */
const PROJECT_PARENT = 'concat-video';
/** 导出前留的安全余量：留一点时间给收尾（保存/关工程/抽帧） */
const FINISH_RESERVE_MS = 20000;

/**
 * 路径比较用的归一化：统一分隔符 + 小写 + 去掉 Windows 的 \\?\ 前缀。
 * Concat 回给我们的路径可能是 `C:\a\b`、`C:/a/b` 或 `\\?\C:\a\b`（writesUnder 里就是这种），
 * 直接字符串比较会在"其实同一个文件"上判不相等。
 * @param {string} p
 * @returns {string}
 */
function normPath(p) {
  let s = String(p == null ? '' : p).trim().replace(/^\\\\\?\\/, '');
  s = s.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return s.toLowerCase();
}

/**
 * @param {object} params 技能入参
 * @param {{deadline?:number}=} opts
 * @returns {Promise<string>} 技能返回文本（永不抛）
 */
async function runRender(params, opts) {
  const p = params && typeof params === 'object' ? params : {};
  const o = opts || {};
  const deadline = Number.isFinite(o.deadline) && o.deadline > 0 ? o.deadline : (Date.now() + 540000);

  // ① 剪辑单校验：一次把问题说清，不要跑一半才炸
  const parsed = parsePlan(p.plan);
  if (!parsed.ok) {
    return '错误：剪辑单没通过校验，先改这几处再试（一共 ' + parsed.errors.length + ' 处）：\n  - ' +
      parsed.errors.join('\n  - ');
  }
  const plan = parsed.plan;
  if (!plan.export.output && p.output) plan.export.output = String(p.output);
  if (p.project) plan.project = String(p.project);
  if (plan.preview && plan.preview.time === null && p.time !== undefined && p.time !== '') {
    const t = Number(p.time);
    if (Number.isFinite(t) && t >= 0) plan.preview.time = t;
  }

  // ② 素材存在性先查（比"跑进 Concat 才报 notOpen/failed"清楚一百倍）
  const missing = [];
  const seen = new Set();
  for (const tr of plan.tracks) {
    for (const c of tr.clips) {
      const abs = resolveAny(c.media);
      c.mediaAbs = abs;
      if (!abs) {
        missing.push('（空路径）');
        continue;
      }
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (!isFile(abs)) missing.push(abs);
    }
  }
  if (missing.length) {
    return '错误：这些素材文件不存在，没法导入：\n  - ' + missing.join('\n  - ') +
      '\n相对路径是按工作区解析的；不确定位置就先列一下目录再写剪辑单。';
  }

  const opened = await openSession();
  if (!opened.ok) return opened.message;
  const session = opened.session;
  const warnings = [];
  let projectReady = false;
  let projDir = '';

  try {
    // ③ 建工程 / 复用工程
    const prepared = await prepareProject(session, plan);
    if (!prepared.ok) return prepared.message;
    projDir = prepared.dir;
    projectReady = true;
    // 复用工程是「接着往上加」，不删原内容 —— 原来的东西还在，成片会比这份剪辑单长，必须说清
    const existing = Number(prepared.existing) || 0;
    if (!prepared.created && existing > 0) {
      warnings.push('这个工程里原本已有 ' + existing + ' 个元素，本次是接着往上加的（没删你原来的内容），' +
        '所以成片总长会比这份剪辑单更长；想要一段干净的成片，就别传 project，让技能新建一个工程');
    } else if (!prepared.created && prepared.existingKnown === false) {
      // 计数没读出来：**不能**沉默。沉默会让用户以为这次是覆盖，实际是又叠了一层。
      warnings.push('没能读出这个工程原本有几个元素（读时间线那一步失败了），所以下面说的总长可能比你想的长：' +
        '如果你复用的是一个已经有内容的工程，原来的内容还在，本次是**接着往上加**的。' +
        '想确认就先用 action=inspect 看一眼，或者干脆别传 project、让技能新建一个工程');
    }

    // ④ 导入素材（去重；同一文件只导一次）
    const imported = await importMedia(session, projDir, plan);
    if (!imported.ok) return imported.message;

    // ⑤ 画面/声音：按泳道铺片段
    const tlForLanes = await session.call('timeline_read', { path: projDir });
    if (!tlForLanes.ok) {
      return '错误：读不到刚建好的工程时间线：' + tlForLanes.message;
    }
    const lanes = ((tlForLanes.data && tlForLanes.data.timeline && tlForLanes.data.timeline.tracks) || [])
      .map((t) => String(t.id));

    for (let ti = 0; ti < plan.tracks.length; ti += 1) {
      const laneRes = await ensureLane(session, projDir, lanes, ti);
      if (!laneRes.ok) return laneRes.message;
      const lane = laneRes.lane;
      const tr = plan.tracks[ti];
      for (const clip of tr.clips) {
        const media = imported.map.get(clip.mediaAbs);
        if (!media || !media.id) {
          return '错误：素材「' + clip.media + '」没能进 Concat 的素材库，后面没法用。';
        }
        const placed = await placeClip(session, projDir, media, lane, clip, warnings);
        if (!placed.ok) return placed.message;
      }
    }

    // ⑥ 标题
    for (const title of plan.titles) {
      const args = { path: projDir, start: title.start, above: true, style: buildTitleStyle(title) };
      if (title.duration !== null) args.duration = title.duration;
      if (title.offsetY !== null) args.offsetY = title.offsetY;
      const r = await session.call('title_add', args);
      if (!r.ok) {
        // 标题失败不该让整条片子白跑：记下来继续
        warnings.push('标题「' + title.text.slice(0, 20) + '」没加上：' + r.message);
      }
    }

    // ⑦ 字幕（一次调用铺整串，Concat 内部是一条可撤销的编辑）
    if (plan.captions.length) {
      const args = { path: projDir, captions: plan.captions.map((c) => ({ start: c.start, end: c.end, text: c.text })) };
      const cs = buildCaptionStyle(plan.captionStyle);
      if (cs.offsetY !== null) args.offsetY = cs.offsetY;
      if (Object.keys(cs.style).length) args.style = cs.style;
      const r = await session.call('captions_add', args);
      if (!r.ok) warnings.push(plan.captions.length + ' 条字幕没加上：' + r.message);
    }

    // ⑧ 读一次时间线：拿到真实总时长与元素数量（不靠剪辑单自己算）
    const tl = await session.call('timeline_read', { path: projDir });
    if (!tl.ok) {
      return '错误：读时间线失败，没法确认这条片子建成了什么样：' + tl.message;
    }
    const described = describeTimeline(tl.data, { maxClips: 20 });
    const stats = described.stats || {};
    const totalDur = Number(stats.duration) || 0;

    if (!stats.clips) {
      return '错误：时间线是空的，一个元素都没落上 —— 导出只会得到一条 0 秒的空文件，所以先不导了。\n' +
        '剪辑单摘要：' + planSummary(plan);
    }

    // ⑨ 保存（Concat 的编辑只存在内存里，不保存就跟没做过一样）
    const saved = await session.call('project_save', { path: projDir });
    if (!saved.ok) warnings.push('保存工程失败（成片能导出，但工程没法复用）：' + saved.message);

    // ⑩ 导出
    const outAbs = plan.export.output
      ? resolveAny(plan.export.output)
      : path.join(path.dirname(projDir), path.basename(projDir) + '.mp4');
    if (!outAbs) return '错误：算不出导出文件路径。';
    try {
      ensureDir(path.dirname(outAbs));
    } catch (e) {
      return '错误：导出目录建不出来：' + path.dirname(outAbs) + '（' + (e && e.message ? e.message : e) + '）';
    }

    const exported = await exportTimeline(session, projDir, plan, outAbs, deadline);
    if (!exported.ok) return exported.message;

    // ⑪ 抽一帧（自检"画面对不对"；失败只记警告，不推翻已经出好的片子）
    let framePath = '';
    let frameInfo = null;
    if (plan.preview !== false) {
      const want = plan.preview && plan.preview.time !== null && plan.preview.time !== undefined
        ? plan.preview.time
        : Math.min(1, totalDur > 0 ? totalDur / 2 : 1);
      const frameOut = plan.preview && plan.preview.output
        ? resolveAny(plan.preview.output)
        : path.join(path.dirname(projDir), path.basename(projDir) + '-预览.png');
      const frameArgs = { path: projDir, time: Math.max(0, want), output: frameOut };
      if (plan.preview && plan.preview.width) frameArgs.width = plan.preview.width;
      if (plan.preview && plan.preview.height) frameArgs.height = plan.preview.height;
      const fr = await session.call('preview_frame', frameArgs, { timeoutMs: 180000 });
      if (fr.ok) {
        framePath = frameOut;
        frameInfo = readPngInfo(frameOut);
        if (!frameInfo.ok) {
          warnings.push('取到的预览帧不像有效 PNG：' + frameInfo.error);
        }
      } else {
        warnings.push('预览帧没取成（不影响成片）：' + fr.message);
      }
    }

    // ⑫ 收尾：保存并关工程（不留"工程还开着"的状态给下一次调用）
    const closed = await session.call('project_close', { path: projDir, save: true });
    if (!closed.ok) warnings.push('关工程时出问题：' + closed.message);
    projectReady = false;

    return buildResultText({
      plan,
      projDir,
      outAbs,
      exported,
      stats,
      described,
      framePath,
      frameInfo,
      warnings,
    });
  } catch (e) {
    return '错误：出片过程中出现了没预料到的问题：' + (e && e.message ? e.message : String(e)) +
      (projDir ? '\n工程目录（可能只建了一半）：' + projDir : '');
  } finally {
    // 失败路径上尽量把工程关掉，别把一个半成品工程留在 Concat 里影响下一次调用
    if (projectReady && projDir) {
      try {
        await session.call('project_close', { path: projDir, save: false });
      } catch {
        /* 收尾失败不覆盖主错误 */
      }
    }
    await session.close();
  }
}

/** project_create 的 video 参数 */
function videoArgs(plan) {
  return {
    width: plan.video.width,
    height: plan.video.height,
    rateNum: plan.video.rateNum,
    rateDen: plan.video.rateDen,
  };
}

/**
 * 建工程（或复用已存在的工程）。绝不删除任何已存在的目录 —— 撞名就换名。
 * @param {object} session
 * @param {object} plan
 * @returns {Promise<{ok:boolean, dir:string, created:boolean, existing:number, message:string}>}
 */
async function prepareProject(session, plan) {
  // 显式给了工程目录
  if (plan.project) {
    const dir = resolveAny(plan.project);
    if (isFile(path.join(dir, 'concat.json'))) {
      const r = await session.call('project_open', { path: dir });
      if (!r.ok) return { ok: false, dir, created: false, existing: 0, message: '错误：打不开已有工程「' + dir + '」：' + r.message };
      // 复用工程是**往上加**，不删原内容 —— 先数一下原本有多少元素，好如实告诉用户
      //
      // ⚠️ `existingKnown` 单独存在的理由（2026-11-08，由一次真实的偶发失败逼出来的）：
      //    `timeline_read` 在机器被压满时会超时（实测：整条单测链与外部构建并发跑时，
      //    这一步失败过一次 —— 同一次调用里「追加」照常发生、成片照常出，只有这个计数读不到）。
      //    原代码只写了成功分支，失败就**静默**退回 `existing = 0` ⇒ 提示不 push ⇒
      //    用户看到一段"正常"的成片，却不知道自己的工程又被叠了一层。
      //    而"以为覆盖了、其实叠了一层"正是这条提示存在的全部理由 —— 它不能在最难发现的
      //    那种情况（机器忙、计不出来）下恰好失效。所以把「没算出来」显式交出去，
      //    由调用方换成另一句话说明，而不是当作"原本就是空的"。
      let existing = 0;
      let existingKnown = false;
      const tl = await session.call('timeline_read', { path: dir });
      if (tl.ok && tl.data && tl.data.timeline && Array.isArray(tl.data.timeline.clips)) {
        existing = tl.data.timeline.clips.length;
        existingKnown = true;
      }
      return { ok: true, dir, created: false, existing, existingKnown, message: '' };
    }
    try {
      ensureDir(dir);
    } catch (e) {
      return { ok: false, dir, created: false, existing: 0, message: '错误：工程目录建不出来：' + dir + '（' + (e && e.message ? e.message : e) + '）' };
    }
    const r = await session.call('project_create', {
      location: path.dirname(dir),
      name: path.basename(dir),
      video: videoArgs(plan),
    });
    if (!r.ok) return { ok: false, dir, created: false, existing: 0, message: '错误：建工程失败「' + dir + '」：' + r.message };
    return { ok: true, dir, created: true, existing: 0, message: '' };
  }

  // 默认：工作区/<PROJECT_PARENT>/<名字>
  const parent = path.join(workspace(), PROJECT_PARENT);
  try {
    ensureDir(parent);
  } catch (e) {
    return { ok: false, dir: '', created: false, existing: 0, message: '错误：工作区里建不了工程父目录：' + parent + '（' + (e && e.message ? e.message : e) + '）' };
  }
  const slug = safeSlug(plan.name, '');
  let dir = uniqueDir(parent, slug);
  let r = await session.call('project_create', {
    location: parent,
    name: path.basename(dir),
    video: videoArgs(plan),
  });
  if (!r.ok) {
    // 并发/残留导致的重名：换一个带时间戳的名字再试一次（仍然不删任何东西）
    const alt = uniqueDir(parent, slug + '-' + stamp());
    const r2 = await session.call('project_create', {
      location: parent,
      name: path.basename(alt),
      video: videoArgs(plan),
    });
    if (!r2.ok) {
      return { ok: false, dir: '', created: false, existing: 0, message: '错误：建工程失败（两次都失败）：' + r.message + ' / ' + r2.message };
    }
    dir = alt;
    r = r2;
  }
  return { ok: true, dir, created: true, existing: 0, message: '' };
}

/**
 * 导入素材：同一绝对路径只导一次。
 * @param {object} session
 * @param {string} projDir
 * @param {object} plan
 * @returns {Promise<{ok:boolean, map:Map<string,{id:string,duration:number,kind:string,name:string}>, message:string}>}
 */
async function importMedia(session, projDir, plan) {
  const map = new Map();
  for (const tr of plan.tracks) {
    for (const clip of tr.clips) {
      const abs = clip.mediaAbs;
      if (!abs || map.has(abs)) continue;
      const r = await session.call('media_import', { path: projDir, file: abs }, { timeoutMs: 180000 });
      if (!r.ok) {
        return { ok: false, map, message: '错误：导入素材「' + abs + '」失败：' + r.message };
      }
      const createdId0 = r.data && r.data.createdId ? String(r.data.createdId) : '';
      const list = r.data && Array.isArray(r.data.media) ? r.data.media : [];
      let createdId = createdId0;
      let item = createdId0 ? list.find((m) => String(m.id) === createdId0) : null;
      // ★ 复用工程时这个分支一定会走到：`media_import` 对**已在素材库里**的路径是 no-op，
      //   返回的工程摘要里**没有 createdId**（实测：只有 canUndo/canRedo/media/project/timeline）。
      //   于是不能把"没有 createdId"当成失败 —— 要在返回的 media 列表里按 path 认回来，
      //   认回来之后后面的 clip_add 才有 mediaId 可用。
      if (!item) {
        const want = normPath(abs);
        item = list.find((m) => normPath(m.path) === want) || null;
        if (item) createdId = String(item.id);
      }
      if (!item || !createdId) {
        return {
          ok: false,
          map,
          message: '错误：导入「' + abs + '」后 Concat 既没返回素材 id、返回的素材库里也找不到它，后面用不了。',
        };
      }
      let duration = Number(item.duration);
      if (!(duration > 0)) {
        // 兜底：media_probe 单独问一次（图片素材在有些版本里 duration 为 0）
        const pr = await session.call('media_probe', { path: abs }, { timeoutMs: 120000 });
        if (pr.ok && pr.data) {
          duration = Number(pr.data.duration);
          if (!item.width && pr.data.width) item.width = pr.data.width;
          if (!item.height && pr.data.height) item.height = pr.data.height;
        }
      }
      map.set(abs, {
        id: createdId,
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        kind: String(item.kind || 'video'),
        name: String(item.name || path.basename(abs)),
      });
    }
  }
  return { ok: true, map, message: '' };
}

/**
 * 取第 index 条泳道；不够就现开一条（track_add 落在最上层）。
 * @param {object} session
 * @param {string} projDir
 * @param {string[]} lanes 可变数组（新建的会被 push 进来复用）
 * @param {number} index
 * @returns {Promise<{ok:boolean, lane:string, message:string}>}
 */
async function ensureLane(session, projDir, lanes, index) {
  if (lanes[index]) return { ok: true, lane: lanes[index], message: '' };
  const r = await session.call('track_add', { path: projDir });
  if (!r.ok) return { ok: false, lane: '', message: '错误：开新泳道失败：' + r.message };
  const id = r.data && r.data.createdId ? String(r.data.createdId) : '';
  if (!id) return { ok: false, lane: '', message: '错误：开新泳道后 Concat 没返回泳道 id。' };
  lanes.push(id);
  return { ok: true, lane: lanes[index], message: '' };
}

/**
 * 把一段素材落到指定泳道的指定位置，并按剪辑单设置长度/位移/特效。
 * @returns {Promise<{ok:boolean, clipId:string, duration:number, message:string}>}
 */
async function placeClip(session, projDir, media, lane, clip, warnings) {
  const label = clip.mediaAbs || clip.media;
  const start = Math.max(0, Number(clip.start) || 0);
  const add = await session.call('clip_add', {
    path: projDir,
    mediaId: media.id,
    trackId: lane,
    start,
  }, { timeoutMs: 120000 });
  if (!add.ok) return { ok: false, message: '错误：把「' + label + '」放到泳道 ' + lane + ' 失败：' + add.message };
  const clipId = add.data && add.data.createdId ? String(add.data.createdId) : '';
  if (!clipId) return { ok: false, message: '错误：Concat 放下「' + label + '」但没返回片段 id。' };

  const mediaDur = media.duration > 0 ? media.duration : (media.kind === 'video' ? 0 : 5);
  let inSec = Math.max(0, Number(clip.in) || 0);
  if (mediaDur > 0 && inSec >= mediaDur - 0.05) {
    // 要的起点已经越过素材尾部。此时"夹到 mediaDur-0.05"只会留一个 0.05 秒的碎片，
    // 几乎肯定不是用户想要的结果 ⇒ 改回从片头开始，并明说这件事。
    warnings.push('「' + path.basename(label) + '」只有 ' + fmtSeconds(mediaDur) +
      '，要的起点第 ' + fmtSeconds(inSec) + ' 秒已经在片尾之后，已改成从片头开始');
    inSec = 0;
  }
  const available = mediaDur > 0 ? Math.max(0.05, mediaDur - inSec) : 0;

  if (inSec > 0.001) {
    const tr = await session.call('clip_trim', { path: projDir, clipId, edge: 'start', delta: inSec });
    if (!tr.ok) return { ok: false, message: '错误：「' + label + '」切片头 ' + fmtSeconds(inSec) + ' 失败：' + tr.message };
    // 切片头会把片段右推 in 秒（实测），挪回用户要的位置
    const mv = await session.call('clips_move', {
      path: projDir,
      moves: [{ clipId, start, trackId: lane }],
    });
    if (!mv.ok) return { ok: false, message: '错误：「' + label + '」挪回 ' + fmtSeconds(start) + ' 失败：' + mv.message };
  }

  let want = clip.duration === null || clip.duration === undefined ? available : Number(clip.duration);
  if (!(want > 0)) want = available;
  if (available > 0 && want > available + 0.001) {
    warnings.push('「' + path.basename(label) + '」可用长度只有 ' + fmtSeconds(available) +
      '，要求 ' + fmtSeconds(want) + '，已按可用长度出片');
    want = available;
  }
  if (available > 0 && Math.abs(want - available) > 0.001) {
    const tr2 = await session.call('clip_trim', {
      path: projDir,
      clipId,
      edge: 'end',
      delta: -(available - want),
    });
    if (!tr2.ok) return { ok: false, message: '错误：「' + label + '」长度改成 ' + fmtSeconds(want) + ' 失败：' + tr2.message };
  }

  // 片段参数（一次 patch 提交，减少调用次数）
  const patch = {};
  if (clip.opacity !== null) patch.opacity = clip.opacity;
  if (clip.fadeIn !== null) patch.fadeIn = clip.fadeIn;
  if (clip.fadeOut !== null) patch.fadeOut = clip.fadeOut;
  if (clip.volume !== null) patch.volume = clip.volume;
  if (clip.transition) {
    const tid = resolveTransition(clip.transition.id);
    if (!tid.ok) return { ok: false, message: '错误：' + tid.message };
    if (tid.id) patch.transitionIn = { id: tid.id, duration: clip.transition.duration };
  }
  if (Object.keys(patch).length) {
    const pu = await session.call('clip_update', { path: projDir, clipId, patch });
    if (!pu.ok) {
      // 转场/音量这类是"锦上添花"，失败记警告比整条片子失败更有用
      warnings.push('「' + path.basename(label) + '」的片段参数没设上：' + pu.message);
    }
  }

  // 位移/缩放/旋转
  const hasTransform = clip.scale !== null || clip.offsetX !== null || clip.offsetY !== null || clip.rotation !== null;
  if (hasTransform) {
    const targs = { path: projDir, clipId };
    if (clip.scale !== null) targs.scale = clip.scale;
    if (clip.offsetX !== null) targs.offsetX = clip.offsetX;
    if (clip.offsetY !== null) targs.offsetY = clip.offsetY;
    if (clip.rotation !== null) targs.rotation = clip.rotation;
    const tf = await session.call('clip_transform', targs);
    if (!tf.ok) warnings.push('「' + path.basename(label) + '」的缩放/位移没设上：' + tf.message);
  }

  // 关键帧动画
  for (const kf of clip.keyframes) {
    const kargs = { path: projDir, clipId, property: kf.property, at: kf.at, value: kf.value };
    if (kf.ease) kargs.ease = kf.ease;
    const kr = await session.call('keyframe_set', kargs);
    if (!kr.ok) warnings.push('「' + path.basename(label) + '」的关键帧 ' + kf.property + '@' + kf.at + ' 没设上：' + kr.message);
  }

  return { ok: true, clipId, duration: want, message: '' };
}

/** title_add.style 只放用户真的写了的字段 —— 其余交给 Concat 的默认值 */
function buildTitleStyle(t) {
  const s = { content: t.text };
  if (t.fontSize !== null) s.fontSize = t.fontSize;
  if (t.color) s.color = t.color;
  if (t.fontWeight !== null) s.fontWeight = t.fontWeight;
  if (t.align) s.align = t.align;
  if (t.background) s.background = t.background;
  if (t.strokeWidth !== null) s.strokeWidth = t.strokeWidth;
  if (t.strokeColor) s.strokeColor = t.strokeColor;
  if (t.fontFamily) s.fontFamily = t.fontFamily;
  if (t.italic !== null) s.italic = t.italic;
  if (t.opacity !== null) s.opacity = t.opacity;
  return s;
}

/** captions_add 的 style / offsetY 拆分 */
function buildCaptionStyle(cs) {
  const style = {};
  if (cs.fontSize !== null) style.fontSize = cs.fontSize;
  if (cs.color) style.color = cs.color;
  if (cs.fontWeight !== null) style.fontWeight = cs.fontWeight;
  if (cs.align) style.align = cs.align;
  if (cs.background) style.background = cs.background;
  if (cs.strokeWidth !== null) style.strokeWidth = cs.strokeWidth;
  if (cs.strokeColor) style.strokeColor = cs.strokeColor;
  return { offsetY: cs.offsetY, style };
}

/**
 * 起导出 → 循环等 → 校验产物。
 * @param {object} session
 * @param {string} projDir
 * @param {object} plan
 * @param {string} outAbs
 * @param {number} deadline
 * @returns {Promise<{ok:boolean, job:string, status:object, mp4:object, message:string}>}
 */
async function exportTimeline(session, projDir, plan, outAbs, deadline) {
  const e = plan.export || {};
  const args = { path: projDir, output: outAbs };
  if (e.crf !== null) args.crf = Math.round(e.crf);
  if (e.preset) args.preset = e.preset;
  if (e.codec) args.codec = e.codec;
  if (e.width !== null) args.width = Math.round(e.width);
  if (e.height !== null) args.height = Math.round(e.height);
  if (e.rateNum !== null && e.rateDen !== null) {
    args.rateNum = Math.round(e.rateNum);
    args.rateDen = Math.round(e.rateDen);
  }

  const st = await session.call('export_start', args, { timeoutMs: 120000 });
  if (!st.ok) {
    return { ok: false, job: '', status: null, mp4: null, message: '错误：起导出任务失败：' + st.message };
  }
  const job = st.data && st.data.job ? String(st.data.job) : '';
  if (!job) {
    return { ok: false, job: '', status: null, mp4: null, message: '错误：Concat 起了导出任务但没返回 job id，没法等它。' };
  }

  let last = null;
  // 循环等：每轮最多等 300 秒（export_wait 上限 600），但总时长不能超过本次调用的时限
  for (let round = 0; round < 200; round += 1) {
    const leftMs = deadline - FINISH_RESERVE_MS - Date.now();
    if (leftMs <= 5000) {
      return {
        ok: false,
        job,
        status: last,
        mp4: null,
        message: '错误：导出还没结束就到了本次调用的时间上限（job=' + job + '）。\n' +
          '任务可能仍在 Concat 里跑完 —— 稍后去看一眼产物文件是否出现；要一次等更久，就把片子切短或分几次导。',
      };
    }
    const chunk = Math.max(15, Math.min(300, Math.floor(leftMs / 1000) - 10));
    const w = await session.call('export_wait', { job, timeoutSeconds: chunk }, { timeoutMs: (chunk + 120) * 1000 });
    if (!w.ok) {
      return { ok: false, job, status: last, mp4: null, message: '错误：等导出时出错：' + w.message };
    }
    last = w.data || {};
    const state = String(last.state || '');
    if (state === 'done') break;
    if (state === 'failed') {
      const why = last.error || last.message || '（Concat 没给原因）';
      return { ok: false, job, status: last, mp4: null, message: '错误：Concat 导出失败：' + String(why) };
    }
    if (state === 'cancelled') {
      return { ok: false, job, status: last, mp4: null, message: '错误：导出被取消了（job=' + job + '）。' };
    }
    // running：继续下一轮
    if (round === 199) {
      return { ok: false, job, status: last, mp4: null, message: '错误：等导出的轮次用完了还没结束（job=' + job + '）。' };
    }
  }

  // 硬判据：文件真的存在、真的是 mp4
  const mp4 = readMp4Head(outAbs);
  if (!mp4.ok || mp4.bytes <= 0) {
    return {
      ok: false,
      job,
      status: last,
      mp4,
      message: '错误：导出流程说完成了，但产物不合法：' + (mp4.error || '文件为空') +
        '\n文件：' + outAbs + '（' + fmtBytes(mp4.bytes) + '，头 12 字节 ' + (mp4.hex || '无') + '）',
    };
  }
  return { ok: true, job, status: last, mp4, message: '' };
}

/**
 * 结果文本。格式照 skills/slides-generate 的口径：
 *   「已生成XXX：<绝对路径>（…）」
 * 因为后端会从返回文本里正则扒绝对路径做成果卡（backend.js 的 extractPaths），
 * 所以路径必须**原样**出现，不能包在括号或引号里被拆开。
 */
function buildResultText(ctx) {
  const { plan, projDir, outAbs, exported, stats, described, framePath, frameInfo, warnings } = ctx;
  const status = exported.status || {};
  const totalFrames = status.total || status.frame || 0;
  const frameRate = plan.video.fps;
  const dur = Number(stats.duration) || (totalFrames && frameRate ? totalFrames / frameRate : 0);
  const kinds = stats.summary ? '，含 ' + stats.summary : '';

  const head = '已生成视频：' + outAbs + '（时长 ' + fmtSeconds(dur) +
    ' / ' + plan.video.width + '×' + plan.video.height + ' / ' + frameRate + 'fps' +
    (totalFrames ? ' / ' + totalFrames + ' 帧' : '') +
    ' / ' + fmtBytes(exported.mp4 ? exported.mp4.bytes : 0) +
    (plan.export.codec ? ' / ' + plan.export.codec : '') +
    kinds + '）';

  const lines = [head];
  lines.push('工程目录：' + projDir + '（要接着改就用 Concat 打开这个文件夹，或用 action=inspect 读时间线）');
  if (framePath) {
    const wh = frameInfo && frameInfo.ok ? '第 ' + frameInfo.width + '×' + frameInfo.height + ' 像素，' + fmtBytes(frameInfo.bytes) : '';
    lines.push('预览帧：' + framePath + '（' + (wh ? wh + '，' : '') + '自检「画面对不对」用，PNG 可直接打开看）');
  }
  if (described && described.text) {
    lines.push('');
    lines.push('时间线实况：');
    lines.push(described.text);
  }
  if (warnings && warnings.length) {
    lines.push('');
    lines.push('注意（' + warnings.length + ' 条，没影响出片）：');
    for (const w of warnings.slice(0, 8)) lines.push('  - ' + w);
    if (warnings.length > 8) lines.push('  - … 还有 ' + (warnings.length - 8) + ' 条');
  }
  return lines.join('\n');
}

module.exports = { runRender, buildResultText };
