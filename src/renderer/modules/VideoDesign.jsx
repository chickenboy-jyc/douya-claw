/**
 * VideoDesign —— 「视频设计」一级页面（0.21.22 · 老板 2026-10-21 第二轮要求重做）。
 *
 * 【这一页现在长什么样】照即梦的分区做的，但配色沿用本仓（白底 + 绿主色）：
 *   ┌ 页头：标题 / 视频·图片模式切换 / 额度条
 *   ├ 常驻一行：所有作品默认存在 <本机目录>  + 打开文件夹
 *   ├ 左「素材」 · 中「创作」（提示词 + 成本 + 生成）· 右「参数」
 *   ├ 生成结果（进度 / 播放 / 本机路径 / 打开文件夹 / 接着改）
 *   ├ 作品库（历史图/视频，可拿来做二次修改）
 *   └ 账本（最近 20 笔估算）
 *
 * 【老板这一轮的四句话，对应到代码的四块】
 *   ①「把 api 给隐藏掉 放到设置里面去」——
 *      这一页**没有任何 key 输入框 / 掩码 / 保存按钮**。没配 key 时只留一句提示 +
 *      一个「去设置里配置」（调 props.onOpenSettings）。没传这个 prop 就只显示文字，
 *      不崩、不白屏。key 的明文从来不需要经过渲染层（上游请求全在主进程发）。
 *   ②「图片生成和视频都是支持图片上传的吧 你要做的跟官网一样」——
 *      视频有 首帧 / 尾帧 / 参考图(≤10) / 参考视频(≤5) / 参考音频(≤5)；图片有 参考图(1-3)。
 *      ★两组是**互斥**的：选了首尾帧就不能再加参考素材，反之亦然。互斥直接体现在 UI 上
 *      （另一组变灰 + 一句解释），不等提交报错。
 *   ③「做好的图视频在哪里也没有告知」——
 *      页头常驻一行「所有作品默认存在 <目录>」，可点开文件夹；每次生成成功的结果卡上
 *      给出**本机绝对路径** + 「打开文件夹」。远端签名地址只作兜底并标注会过期。
 *   ④「如果要在之前的图片视频上做二次修改 也没有」——
 *      底部作品库读历史产物，图片可「用作参考图 / 用作首帧」，视频可「用作参考视频」；
 *      当前结果卡上也有同样入口。点完自动切到对应模式并把光标放进提示词框。
 *
 * 【数字人为什么不单独开一个页签】
 *   上游没有「数字人」模型，它就是 reference_image + 一致性提示词。所以做成素材区的
 *   一个入口：往参考图槽位加图，同时把提示词前缀补成「图1 是主角，保持人物长相…」，
 *   多角色就是多加几张，自动编号 图1/图2/图3。老板要的「保持稳定输出」靠的是
 *   **同一组角色照在多条视频里重复使用**，不是靠某个开关。
 *
 * 【四条实测事实没变，别重写掉】（2026-10-21 用真实 key 打过真接口）
 *   ① 视频真的很慢：480P/5s 实测 2 分 17 秒出片，另一次 3 分钟还没结束。
 *      ⇒ 提交后立刻显示 task_id + 已等待秒数 + 手动「刷新状态」，轮询 5 秒、12 分钟上限。
 *      绝不能做成「点一下就干等」。
 *   ② 产物是**会过期的签名 URL**（OSS，约 19 小时）⇒ 拿到就 `wanxSave` 落本地，
 *      界面上给的是本机文件；远端地址只作兜底并明说会过期。
 *   ③ 上游提交时不校验参数（999P / 99:1 都返回 200）⇒ 档位只能由下拉框兜，不让手填。
 *   ④ 档位里 `verified:false` 的必须在标签后挂「（未验证）」。
 *
 * 【金额一律是「估算」】
 *   我们没有控制台账单接口，单价来自本地配置。所以金额处都带「估算」，
 *   取不到单价显示 `—` 而不是 0（0 会被读成免费）。视频是**按秒**计价、不是按条，
 *   这条说明必须在不展开的状态下就看得见（两者差 5～30 倍）。
 *
 * 【契约缺失时绝不白屏】
 *   主进程这一轮新增了 wanxPickMedia / wanxOpenFolder / wanxAssets / wanxMediaDir。
 *   这四条在新版主进程到位前可能不存在，所以**每一条调用前都判函数**，
 *   缺了就给一句「需要更新到新版」的提示。status.mediaDir / status.limits 缺失时用兜底值。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【0.21.25 · 第三态「海报」（源码见 `modules/PosterStudio.jsx`）】
 *
 *   老板要的是「给门诊小白的一键做海报」：选模板 → 改几个字 → 换张图 → 导出。
 *   落点没有另开一级页面，而是挂在「视频设计」的模式切换上，理由是这三件事对同一
 *   个用户是同一件事：**我要一张能发朋友圈的图**。视频 / 图片是从一句话生成，
 *   海报是从模板改，路径不同但目标一致，放一起用户不用记两个入口。
 *
 *   为什么用 **early return** 而不是去改下面三十多处 `mode === 'video' ? A : B`：
 *     ① 海报和视频/图片没有任何共用字段（那边是提示词 + 档位 + 素材槽，这边是
 *        图层数组 + 画布尺寸），硬塞进同一棵 JSX 树只会让两边都长出空壳；
 *     ② 三十多处三元逐个人工改三分支，是这一页回归风险最高的操作 —— 改错一处
 *        不报错，只是某个字段在某个模式下被写坏（本仓吃过这种亏）；
 *     ③ 分叉点在**所有 hooks 跑完之后**，hooks 数量不随模式变化，不会触发
 *        "Rendered fewer hooks than expected"。
 *
 *   模式切换器 `modeSwitch` 提成了**一个变量**，两个 return 共用一份 ——
 *   不许复制两份 Segmented（复制了以后加第四态必然只改一处）。
 *
 *   海报模式的四条硬约束（细节见 PosterStudio.jsx 文件头）：
 *     · 预览与导出共用同一份绘制函数 `drawPoster(ctx, doc, scale)`，杜绝「预览好看
 *       导出错位」；
 *     · 拖动同时听 pointer 与 mouse 两套事件（自动化验收派发的是 mouse 事件）；
 *     · 渲染层不碰磁盘、不直连外网：导入走 `file:readThumb`，导出走 `poster:export`；
 *     · `window.__posterTest` 是**产品能力**（让豆芽 Agent 能自己生成海报），
 *       每条钩子都必须真的改 state / 真的调 IPC。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, InputNumber, Segmented, Select, Table, Tag } from 'antd';
import PosterStudio from './PosterStudio.jsx';
import { startJob, useBackgroundJob } from '../store/backgroundJobs.js';
import { addSessionShot, useSessionShots } from '../store/mediaShots.js';
// 「AI 优化提示词」走 `api.js` 的 `chatOnce`（主进程 `/api/chat-once` 已注册）。
// ★ 不新开 IPC：这一页对 AI 的需求就是"一次一问一答"，和全仓其它 20 个调用点是同一个出口。
//   新开通道会绕开 chatOnce 里的「AI 未就绪」软门禁 ⇒ 没配 key 时仍把请求打出去，
//   用户看到的是转圈半天然后报网络错，而不是"去设置里填 key"。
import { chatOnce } from '../api.js';
import '../styles/videodesign.css';

/** 轮询间隔 / 上限：视频实测 >3 分钟，5 秒一次够灵敏也不至于打爆上游。 */
const POLL_INTERVAL_MS = 5000;
const POLL_LIMIT_MS = 12 * 60 * 1000;

/**
 * 图片生成的后台任务兜底超时 = 210 秒。
 *
 * ⚠️ **必须大于**主进程 provider 的 `IMAGE_TIMEOUT_MS`（`src/main/wanxProvider.js` = 180 秒）。
 * 两者是「谁先到点」的竞赛：如果 backgroundJobs 的兜底比上游自己的超时**更早**，
 * 我们会在一个**本来还能成**的请求上先把它掐死，然后把「上游还在等、我们已放弃」记成失败 ——
 * 那是我们自己制造的失败，用户看到的是「本来能出图却报错」。
 * 反过来（210 > 180）就正确：上游先超时并把原因如实返回，我们再把那句话显示出来。
 */
const IMAGE_JOB_TIMEOUT_MS = 210000;

/**
 * 视频（提交 + 轮询）的后台任务兜底超时 = 15 分钟。
 * 同样必须大于轮询上限 `POLL_LIMIT_MS`（12 分钟 = 720 秒），否则轮询还没走完就被兜底掐死。
 */
const VIDEO_JOB_TIMEOUT_MS = 900000;

/**
 * 「按原图尺寸再生成」的测量超时 = 8 秒。
 *
 * 量一张本机图的宽高只是读个头信息，正常 100ms 内就回来。8 秒是**兜底上限**：
 * 真拿不到（文件被移走 / 通道缺失 / jsdom 里 `<img>` 不触发 onload）就**放弃测量**，
 * 退化成"不传 size、按上游默认尺寸出图" —— 绝不许因为量尺寸把「生成」按钮卡住。
 */
const EDIT_BASE_TIMEOUT_MS = 8000;

/**
 * 读图尺寸时 `file:readThumb` 的 maxEdge。
 *
 * 传得比任何出图尺寸都大（4096），等于告诉主进程「别缩」：`readImageAsDataUrl` 的缩放
 * 系数是 `min(1, maxEdge/长边)`，默认 320 会把 1024 的图读成 320 ——
 * 那样"按原图尺寸"就成了"按缩略图尺寸"，错得毫无提示。
 */
const EDIT_BASE_PROBE_EDGE = 4096;

/**
 * 生成百分比的三条分母（老板 2026-10-24：「生成的时候没有百分比，没有AI优化提示词。」）
 *
 * 三条都是**实测/文案对齐**出来的数，不是拍的：
 *   · 图片 60 秒：对应本页从 0.21.22 起就一直给用户的那句「通常 20~60 秒」。
 *     分母必须和用户看到的那个区间一致 —— 用 180（provider 超时）算，前 3 分钟都只走到
 *     26%，用户会觉得"卡住了"；用 30 算，30 秒后条就满了但图还没出来，那是假进度。
 *   · 视频 PENDING 30 秒：排队一般十几秒就转 RUNNING，30 秒是观测到的上限量级。
 *   · 视频 RUNNING 137 秒 = 2 分 17 秒，本仓 2026-10-21 用真 key 打的 480P/5s 实测出片时间
 *     （见文件头「四条实测事实」第 ① 条）。用这个数，条走到满正好对上用户真实体感。
 *
 * ★ 铁律：**只有真拿到结果才允许 100**。失败 / 超时 / 轮询放弃一律不许 100 ——
 *   条满了但没结果，比没有条更误导（用户会以为"生成完了只是没显示出来"，于是去文件夹里翻）。
 */
const IMAGE_PROGRESS_DENOM_S = 60;
const VIDEO_PENDING_DENOM_S = 30;
const VIDEO_RUNNING_DENOM_S = 137;

/**
 * 「AI 优化提示词」的两套 system prompt。
 *
 * ★ 必须**真的不一样**（门禁会断言两次调用传的 system 内容不相等）：
 *   视频模型要的是「动」，图片模型要的是「静」。用同一套 prompt 的后果不是报错，
 *   是"优化完更像人话但更容易出废片" —— 视频提示词里堆满材质/色调，模型会理解成
 *   静态画面；图片提示词里堆满运镜，模型只能瞎猜。
 *
 * 两条共同的三条硬约束（写进 prompt 也写在这里，防止下一个人"顺手"放宽）：
 *   ① 只输出一段可直接提交的正文，不要解释、不要 Markdown、不要引号包裹；
 *   ② 不许改变用户的原意（换主体、加产品、改场景都是错）；
 *   ③ 反向提示词（负向）只作为"避开这些"的上下文，**不许**揉进正向提示词里 ——
 *      上游的 negativePrompt 是独立参数，混进正向等于把"不要水印"变成"要有水印"。
 */
const AI_PROMPT_VIDEO = [
  '你是短视频分镜提示词工程师。用户给你一句口语化的视频描述，你要改写成一段**可以直接提交给视频生成模型**的中文提示词。',
  '改写要点（按重要性排序）：',
  '1) 主体与动作：谁、在做什么，动作要具体到能被拍下来的程度（不要「展示专业」这种无法成像的词）。',
  '2) 镜头运动：明确写推/拉/摇/移/跟拍/固定机位中的一种，以及运动方向与幅度。',
  '3) 时长节奏：一句话描述里体现节拍（例如「前 2 秒…随后…」），不要写具体秒数参数。',
  '4) 画面连贯：写清镜头之间的关系，避免前后景突变、主体跳位。',
  '5) 保持用户原意：不许换主体、加产品、改场景。',
  '输出格式：只输出改写后的提示词正文，一段话，不要标题、不要编号、不要 Markdown、不要用引号包裹，不要任何解释。',
  '如果用户额外给了「要避开的」，那只是让你知道哪些东西不该出现在画面里，**不要**把它们写进提示词正文。',
].join('\n');

const AI_PROMPT_IMAGE = [
  '你是商业摄影提示词工程师。用户给你一句口语化的画面描述，你要改写成一段**可以直接提交给图片生成模型**的中文提示词。',
  '改写要点（按重要性排序）：',
  '1) 主体：主体是什么、数量、状态，写到能一眼认出。',
  '2) 构图：景别与视角（特写/中景/全景，平视/俯拍/仰拍），主体在画面中的位置。',
  '3) 光线：光源方向与性质（自然侧光/影棚柔光/逆光轮廓），明暗对比。',
  '4) 材质与色调：材质质感（金属/陶瓷/织物）、整体色调倾向。',
  '5) 画质：清晰、干净、无水印、高细节（不要写具体分辨率参数）。',
  '6) 保持用户原意：不许换主体、加产品、改场景。',
  '输出格式：只输出改写后的提示词正文，一段话，不要标题、不要编号、不要 Markdown、不要用引号包裹，不要任何解释。',
  '如果用户额外给了「要避开的」，那只是让你知道哪些东西不该出现在画面里，**不要**把它们写进提示词正文。',
].join('\n');

/**
 * 「AI 未配置」时那一句必须说清的三件事：去哪填、填了能怎样、这次不花钱。
 *
 * ★ 关键词「设置」和「额度」是门禁判据，改文案时必须留着：
 *   只说「AI 不可用」等于让用户自己猜；而用户最怕的是"点了下按钮扣了钱还没效果"。
 */
const AI_NEED_CONFIG_TEXT = '还没连上 AI：去「设置」填 API Key 就能用。这次不会扣你的生图/生视频额度。';

/** 表单持久化的 localStorage 前缀（按企业隔离，切企业不串提示词/素材）。 */
const FORM_STORAGE_PREFIX = 'douya-videodesign-form:';

/**
 * 作品库一次向主进程要多少条。
 *
 * ★ 0.21.25 从 50 提到 200（后端上限 500）。老板说的「之前生的图看不到」还有一层
 *   原因是**只取最近 50 条**：生成多了以后，早期的作品连列表都进不来，而界面上
 *   写着「共 N 件」= 其实只剩 50。真被截断时工作栏会如实说「只列最近 N 件，一共 M 件」。
 */
const ASSETS_LIMIT = 200;

/** 「本次生成」带子的作用域前缀（按企业隔离；存活边界见 store/mediaShots.js 文件头）。 */
const SHOTS_STORAGE_PREFIX = 'videodesign-shots-';

/** 合法模式枚举（localStorage 里的值不可信，只认这三个）。 */
const MODES = ['video', 'image', 'poster'];

/** Promise 版 setTimeout（轮询循环里用，比 setInterval 少一处要清理的句柄）。 */
function sleepMs(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 主进程没给 limits 时的兜底（与契约一致，别跟着改小）。 */
const DEFAULT_LIMITS = {
  video: { maxRefImages: 10, maxRefVideos: 5, maxRefAudio: 5 },
  image: { maxRefImages: 3 },
};

/** 数字人 / 角色的提示词前缀。多角色时 图1/图2/图3 由缩略图角标自动编号。 */
const CHARACTER_PREFIX = '图1 是主角，保持人物长相、发型、服装一致。';

/** 首尾帧与参考素材互斥时的那句话（UI 上要看得见，不是只在提交时报错）。 */
const EXCLUSIVE_NOTE = '首尾帧和参考素材是两种模式，只能选一种。';

/** 空素材池。`first_frame` / `last_frame` 各最多 1 张，其余按 limits 走。 */
function emptyMedia() {
  return {
    first_frame: [],
    last_frame: [],
    reference_image: [],
    reference_video: [],
    reference_audio: [],
  };
}

/** 金额格式化：取不到就显示 ——，绝不显示 0（0 会被读成免费）。 */
function money(v) {
  // ⚠️ 必须先挡 null / undefined / 空串：`Number(null) === 0`，直接 Number() 会把
  //    「没有单价」渲染成「¥0.00」—— 那正好是老板最容易被骗的那种显示（看起来免费）。
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return '¥' + (Math.round(n * 100) / 100).toFixed(2);
}

/** 状态中文 + 颜色。未知状态如实显示原文，不硬套成「成功」。 */
function statusView(s) {
  const v = String(s || '').toUpperCase();
  if (v === 'SUCCEEDED') return { text: '已完成', color: 'green' };
  if (v === 'FAILED') return { text: '失败', color: 'red' };
  if (v === 'CANCELED') return { text: '已取消', color: 'default' };
  if (v === 'RUNNING') return { text: '生成中', color: 'blue' };
  if (v === 'PENDING') return { text: '排队中', color: 'gold' };
  return { text: s ? String(s) : '未知', color: 'default' };
}

/**
 * 图片生成百分比。
 *
 * 纯函数（导出是为了让门禁能直接钉住边界，也为了让渲染路径只有这一份算法 ——
 * 两处各写一遍"8 + elapsed/60*80"的后果是，改分母时只改一处，另一处静默落后）。
 *
 * @param {{busy:boolean, phase:string, elapsed:number, result:object|null}} o
 *   · busy     后台任务是否在跑（`imageJob.busy`，跨卸载存活）
 *   · phase    `'idle'|'submit'|'gen'|'land'`（`data-vd-image-phase` 的同一个值）
 *   · elapsed  已等待秒数（来自 `job.startedAt`）
 *   · result   后台任务的终态结果（有 `localPath` 或 `imageUrl` 才算真拿到）
 * @returns {number|null} 0~100 的整数；**拿不到可信数时返回 null**（进度条不渲染）
 */
export function imageProgressPct(o) {
  const busy = !!(o && o.busy);
  const phase = String((o && o.phase) || '');
  const elapsed = Math.max(0, Number((o && o.elapsed) || 0) || 0);
  const r = (o && o.result) || null;
  if (busy) {
    // 落盘阶段（图已经回来了，正在写本机）：允许到 95，但**不许** 100 —— 写盘还可能失败。
    if (phase === 'land') return 95;
    // 8 → 88：起点 8 是为了"点了之后立刻有条"（0% 的空条看起来像没生效）。
    // 封顶 88 是显式的 `Math.min`，不靠除法自然封顶 —— 分母被改小时除法会直接冲过 100。
    return Math.min(88, Math.round(8 + Math.min(1, elapsed / IMAGE_PROGRESS_DENOM_S) * 80));
  }
  // ★ 只有真拿到结果才 100。失败 / 超时 / 没开始：null（不画条）。
  if (r && (r.localPath || r.imageUrl)) return 100;
  return null;
}

/**
 * 视频生成百分比。
 *
 * 分区间（`status` 来自上游任务状态，`statusView()` 用的是同一个字段）：
 *   · PENDING（排队中）：8 → 10，分母 30 秒。
 *   · RUNNING（生成中）：11 → 90，分母 137 秒（= 2 分 17 秒实测）。
 *     ★ 起点取 11 而不是 10：10 是 PENDING 的封顶，两边都用 10 的话
 *       「刚转 RUNNING」和「PENDING 到顶」在读数上完全一样，门禁（和人）都分不出来。
 *   · SUCCEEDED 但还在落盘：95。
 *   · 状态未知 / 首帧还没查到：null —— 不凭空给数。宁可没有条，也不要给一个假数。
 *
 * @param {{busy:boolean, elapsed:number, status:string, result:object|null}} o
 * @returns {number|null} 0~100 的整数；不可信时 null
 */
export function videoProgressPct(o) {
  const busy = !!(o && o.busy);
  const elapsed = Math.max(0, Number((o && o.elapsed) || 0) || 0);
  const status = String((o && o.status) || '').toUpperCase();
  const r = (o && o.result) || null;
  if (!busy) {
    // ★ 铁律：失败 / 超时 / 轮询放弃（busy=false 且没有结果）**绝不许 100**。
    if (r && (r.localPath || r.videoUrl)) return 100;
    return null;
  }
  if (status === 'PENDING') {
    return Math.min(10, Math.round(8 + Math.min(1, elapsed / VIDEO_PENDING_DENOM_S) * 2));
  }
  if (status === 'RUNNING') {
    return Math.min(90, Math.round(11 + Math.min(1, elapsed / VIDEO_RUNNING_DENOM_S) * 79));
  }
  // 上游说完成了、但我们还在落盘/还没落盘：95，不给 100（片还没进本机）。
  if (status === 'SUCCEEDED') return 95;
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 「@ 提及」与「套用原图尺寸」的纯函数
//
// 这三个函数**都导出**：它们是没有 React 依赖的纯逻辑，边界（`@图片12` 不能变成
// 「图1 2」、`100*100` 不能原样发给上游）最适合用单测直接钉住。
// 写在组件外面还有第二个理由：**编号的真源只能有一份** —— 如果提交处和插入处各算
// 一遍顺序，`@图片2` 迟早指到别的素材上，而这种错不会报错、只会出一张不对的图。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 素材槽在提交请求里的**摊平顺序**（`图N` 编号的唯一真源）。
 *
 * ★ 与 `submitVideo()` 组 `media[]` 的顺序、以及主进程 `buildVideoMedia`
 *   「保持传入顺序」的语义是同一个顺序（`src/main/wanxProvider.js:289-292`：
 *   官方规则是提示词里用「图1/图2」指代素材，编号 = 同类素材在 media 里的出现顺序）。
 *   改这里必须同步改/确认提交处，否则 `@图片2` 会指到另一张。
 */
const MEDIA_SLOT_ORDER = ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'];

/** 图片模式下唯一会进请求的槽位（`refImages` 只有参考图）。 */
const IMAGE_SLOT_ORDER = ['reference_image'];

/**
 * 提及编号的上限归一。
 *
 * ★ 三种输入必须区分开（这条是被实测咬出来的）：
 *   · **没传**（`undefined`/`null`/空串）⇒ `Infinity`：调用方明确表示"不设上限"；
 *   · **传了 0** ⇒ `0`：现场一张素材都没有，任何 `@图片N` 都指不到东西 ——
 *     早期版本把 0 也归成 `Infinity`，于是"清空素材后 @图片5 仍被转成 图5"、
 *     把一句**明确对不上**的引用喂给了模型，正是这次要防的那种错；
 *   · 传了正数 ⇒ 取整。
 *
 * @param {any} maxN 当前素材池里**真正会被提交**的素材数
 * @returns {number} 非负整数或 Infinity
 */
function mentionCap(maxN) {
  if (maxN === undefined || maxN === null || maxN === '') return Infinity;
  const n = Number(maxN);
  if (!Number.isFinite(n)) return Infinity;
  return Math.max(0, Math.floor(n));
}

/**
 * 把提示词里的 `@图片N` 归一成 `图N`（**只用于构造请求**，绝不回写 state）。
 *
 * 上游只认「图1/图2」这种写法（`wanxProvider.js:289-292` 的注释），而 `prompt`
 * 是零加工原样进 `body.input.messages[].content`（:1106）的，所以这个转换只能由我们做。
 *
 * 边界（都有单测）：
 *   · `@图片12` → `图12`（`\d+` 整体匹配，不会只换掉 `@图片1` 留下一个 `2`）
 *   · `@图片` 后面没有数字 → **原样不动**（那可能是用户真的想写「@图片」三个字）
 *   · `@图片N` 的 N 超出当前素材数（`maxN`）→ **原样不动**：
 *     静默换成 `图5` 等于告诉模型"去用第 5 张"，而现场只有 3 张 —— 那比不转更坏。
 *
 * @param {any} text 用户写的提示词
 * @param {number} [maxN] 当前会被提交的素材数（不传 = 不设上限）
 * @returns {string} 归一后的提示词（永不返回 null）
 */
export function normalizeMentionPrompt(text, maxN) {
  const cap = mentionCap(maxN);
  const s = text === null || text === undefined ? '' : String(text);
  return s.replace(/@图片([0-9]+)/g, (m, d) => {
    const n = Number(d);
    return Number.isInteger(n) && n >= 1 && n <= cap ? '图' + n : m;
  });
}

/**
 * 找出提示词里**指不到素材**的 `@图片N`（`normalizeMentionPrompt` 刻意不转的那些）。
 *
 * 用途：提交前给一句可见的提示。**不拦提交** —— 理由有二：
 *   ① `@` 本身可能是用户正常文本的一部分（邮箱、备注），拦住等于不让人提交；
 *   ② 拦住之后用户唯一的出路是删字，而"原样保留 + 一句说明"他能自己判断要不要改。
 *
 * @param {any} text 用户写的提示词
 * @param {number} [maxN] 当前会被提交的素材数
 * @returns {string[]} 超范围的原始片段（去重，如 `['@图片5']`）
 */
export function outOfRangeMentions(text, maxN) {
  const cap = mentionCap(maxN);
  const s = text === null || text === undefined ? '' : String(text);
  const re = /@图片([0-9]+)/g;
  const bad = [];
  let m = re.exec(s);
  while (m) {
    const n = Number(m[1]);
    const ok = Number.isInteger(n) && n >= 1 && n <= cap;
    if (!ok && bad.indexOf(m[0]) < 0) bad.push(m[0]);
    m = re.exec(s);
  }
  return bad;
}

/**
 * `@` 提及面板最多列多少项。
 *
 * 素材再多也不列全：面板是"贴着输入框的浮层"，列 80 行会盖住整页；而用户真正要
 * 引用的东西 99% 就在最前面（槽位 → 本次生成 → 最近的作品）。
 */
const MENTION_PANEL_MAX = 40;

/** 图片尺寸的合法总像素区间（与主进程 `wanxProvider.js:1057-1078` 的校验一致）。 */
const IMAGE_SIZE_MIN_PX = 512 * 512; // 262144
const IMAGE_SIZE_MAX_PX = 2048 * 2048; // 4194304

/**
 * 「套用原图尺寸」：把任意宽高钳到上游接受的区间，并给出 `宽*高` 字符串。
 *
 * 公式（等比缩放，长宽比不变）：
 *   · `px = w*h`；`px > MAX` ⇒ `scale = sqrt(MAX / px)`；`px < MIN` ⇒ `scale = sqrt(MIN / px)`；
 *   · 两边都乘 `scale` 后**取偶**（`round(v/2)*2`，偶数宽高是为了后续编码器不吃奇数边）；
 *   · 取偶可能让总像素又掉出区间（例如刚好在边界上），所以再夹最多 8 轮，
 *     每轮只做一次等比缩放 —— 收敛是二次的，两轮就到位。
 *
 * `provider` 只校验「格式是 `宽*高`（星号）」和「总像素在 512² ~ 2048² 之间」，
 * 不校验比例，所以钳位只需要管总像素。
 *
 * @param {any} w 原图宽（px）
 * @param {any} h 原图高（px）
 * @returns {string} `"1024*1024"`；宽高不可用时返回空串（调用方据此**不传** size）
 */
export function clampImageSize(w, h) {
  const W = Math.round(Number(w));
  const H = Math.round(Number(h));
  if (!(W > 0) || !(H > 0) || !Number.isFinite(W) || !Number.isFinite(H)) return '';
  const px = W * H;
  const first = px > IMAGE_SIZE_MAX_PX
    ? Math.sqrt(IMAGE_SIZE_MAX_PX / px)
    : (px < IMAGE_SIZE_MIN_PX ? Math.sqrt(IMAGE_SIZE_MIN_PX / px) : 1);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  let ow = even(W * first);
  let oh = even(H * first);
  for (let i = 0; i < 8; i += 1) {
    const p = ow * oh;
    if (p >= IMAGE_SIZE_MIN_PX && p <= IMAGE_SIZE_MAX_PX) break;
    const s = p > IMAGE_SIZE_MAX_PX
      ? Math.sqrt(IMAGE_SIZE_MAX_PX / p)
      : Math.sqrt(IMAGE_SIZE_MIN_PX / p);
    ow = even(ow * s);
    oh = even(oh * s);
  }
  return ow + '*' + oh;
}

/**
 * `prev → next` **只多了一个字符**、且那个字符就是 `ch` 时，返回它插进去的下标；否则 -1。
 *
 * ★ 为什么不用 `e.target.selectionStart - 1`：受控 textarea 在自动化里是
 *   「整串 set 值 + 派发 input」输入的（见 `scripts/smoke/entry-interact.jsx` 的 `type()`），
 *   那时 `selectionStart` 落在**串尾**，而实际插入点在中间 —— 用光标算会把 `@`
 *   认到错误的位置上，`@图片2` 就会替换掉串尾的字符。逐字符 diff 与光标无关，恒准。
 *
 * @param {string} prev 变化前的值
 * @param {string} next 变化后的值
 * @param {string} ch 期望新插入的那个字符（本文件里是 `'@'`）
 * @returns {number} 新字符的下标；不是"只多一个 ch"就 -1
 */
function insertedCharIndex(prev, next, ch) {
  const a = String(prev === null || prev === undefined ? '' : prev);
  const b = String(next === null || next === undefined ? '' : next);
  if (b.length !== a.length + 1) return -1;
  let i = 0;
  while (i < a.length && a.charAt(i) === b.charAt(i)) i += 1;
  return b.charAt(i) === ch ? i : -1;
}

/**
 * 读一张本机图片的**原始像素宽高**（用来"按原图尺寸再生成"）。
 *
 * 走 `file:readThumb`（`src/main/main.js:235-240`，preload 的通用 `invoke` 已经能调，
 * 不需要改 preload）：拿 dataUrl → `new Image()` → `naturalWidth/naturalHeight`。
 * ★ 探针的 `maxEdge` 传得**很大**（4096）：`readImageAsDataUrl` 只在"字节数超过
 *   2.5MB"时才用 nativeImage 缩放，且 `scale = min(1, maxEdge/edge)` —— 传 4096
 *   等于告诉我们"别缩"，否则拿回来的宽高是缩放后的（1024 的图会读成 320）。
 *
 * ⚠️ 必须有超时兜底：jsdom 里 `<img>` 的 onload **永远不触发**，没有兜底这个
 *   Promise 会一直挂着，按钮看起来"点了没反应"。拿不到就返回 null，调用方退化成
 *   **不传 size**（照旧出图），绝不许因此挡住提交。
 *
 * @param {Function} invoke `api.invoke(channel, ...args)`
 * @param {string} filePath 本机绝对路径
 * @returns {Promise<{w:number,h:number}|null>}
 */
function measureImageSize(invoke, filePath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), EDIT_BASE_TIMEOUT_MS);
    Promise.resolve()
      .then(() => invoke('file:readThumb', filePath, EDIT_BASE_PROBE_EDGE))
      .then((r) => {
        if (!r || r.ok !== true || !r.dataUrl) { finish(null); return; }
        if (typeof Image === 'undefined') { finish(null); return; }
        const img = new Image();
        img.onload = () => {
          const w = Number(img.naturalWidth) || 0;
          const h = Number(img.naturalHeight) || 0;
          finish(w > 0 && h > 0 ? { w, h } : null);
        };
        img.onerror = () => finish(null);
        img.src = String(r.dataUrl);
      })
      .catch(() => finish(null));
  });
}

/**
 * 把 AI 返回的正文清成「可以直接粘进输入框」的一段话。
 *
 * 为什么要清：模型即使被要求"不要 Markdown、不要引号"，仍会时不时包一层 ``` 或加个
 * 「改写后：」。不清的后果不是报错，是用户把围栏一起提交上去，出图质量莫名变差。
 * 清的程度刻意保守 —— 只剥围栏和最外层成对的引号，**不动正文内部的任何字**。
 *
 * @param {string} s 模型原文
 * @returns {string} 清理后的正文（可能为空串，调用方需判空）
 */
function cleanAiPrompt(s) {
  let out = String(s == null ? '' : s).trim();
  // ```lang\n...\n``` 整段围栏
  const fence = out.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) out = String(fence[1] || '').trim();
  // 「改写后：」「提示词：」这种前缀（只剥一个，避免吃掉正文里本来就有的冒号）
  out = out.replace(/^(改写后|优化后|提示词|提示词为|结果)\s*[:：]\s*/, '').trim();
  // 最外层成对的引号（中文/英文/书名号）
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['「', '」'], ['《', '》']];
  for (let i = 0; i < pairs.length; i += 1) {
    const a = pairs[i][0];
    const b = pairs[i][1];
    if (out.length > 1 && out.startsWith(a) && out.endsWith(b)) {
      out = out.slice(a.length, out.length - b.length).trim();
      break;
    }
  }
  return out;
}

/**
 * 绝对路径 → 相对 `root` 的路径（正斜杠分隔）；不在 root 下返回 ''。
 *
 * Windows 路径不分大小写，POSIX 分 —— 只在 root 长得像 Windows 路径时忽略大小写，
 * 免得在 macOS / Linux 上把 `/Users/x/video` 和 `/users/x/video` 当成同一个。
 */
function relUnder(p, root) {
  const clean = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const target = clean(p);
  const base = clean(root);
  if (!target || !base) return '';
  const win = /^[a-zA-Z]:\//.test(base) || base.startsWith('//');
  const t = win ? target.toLowerCase() : target;
  const b = win ? base.toLowerCase() : base;
  if (t === b) return '';
  if (!t.startsWith(b + '/')) return '';
  return target.slice(base.length + 1);
}

/** 本机绝对路径 → 受限媒体地址；取不到（不在授权目录内）返回 ''。 */
function mediaUrlOf(p, mediaDir) {
  const s = String(p || '').trim();
  if (!s) return '';
  // 远端签名地址 / 内联数据 / blob 原样用：它们本来就不需要本地授权
  if (/^(https?|data|blob):/i.test(s)) return s;
  // 作品库二次修改时可能已经把地址存成了 URL
  if (/^app:\/\//i.test(s)) return s;
  const rel = relUnder(s, mediaDir);
  if (!rel) return '';
  return 'app://douya/__media/' + rel.split('/').map(encodeURIComponent).join('/');
}

/** 路径取文件名（作品库要把绝对路径变成给人看的短名）。 */
function baseName(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function extOf(p) {
  const n = baseName(p);
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i).toLowerCase() : '';
}

/** 时间戳（ms 或 ISO）→ 本地「月-日 时:分」。取不到就空串，不显示 Invalid Date。 */
function tsText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 字节 → 人话（0 / 缺失就不显示括号）。 */
function sizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

/**
 * 这件作品「现在能不能真的看到像素」。
 *
 * 三态（老板原话「之前生的图可以看到 并不是再次打开后就没有了」）：
 *   ① 有本机文件       ⇒ `localPath` 有值且 `missing !== true` ⇒ 能预览 / 能播放
 *   ② 有记录但文件不在 ⇒ `missing === true` 或 `localPath` 为空 ⇒ **仍然出现在列表里**，
 *      给占位 + 原因 + 原路径，也能点开灯箱看元信息（只是没有像素）
 *   ③ 完全没记录       ⇒ 连记录都没有（主进程现在会按目录扫回来，这一档只可能出现在
 *      真被清过的老索引上）
 *
 * ★ 旧代码是 `const hasFile = !!a.localPath;` —— 它把「有路径但文件已经不在」
 *   当成「有文件」，于是 `<video src>` 指向死路径、一片黑，用户只能猜。
 *
 * @param {object} a 作品条目（主进程 listAssets 的出参 / 本次生成带的条目）
 * @returns {boolean} 是否真的能渲染出像素
 */
function assetHasFile(a) {
  return !!(a && a.localPath) && a.missing !== true;
}

/**
 * 条目的类型文案（视频 / 图片）。
 * 未知一律按图片算：目录扫描只认这两类，多一个类型文案反而会造出"第三态"。
 *
 * @param {object} a 作品条目
 * @returns {string} 「视频」/「图片」
 */
function kindText(a) {
  return a && a.kind === 'video' ? '视频' : '图片';
}

/**
 * 全屏灯箱 —— 即梦那种「点缩略图 → 看大图 / 播视频」。
 *
 * 【为什么写在同一个文件里而不是拆成 components/MediaLightbox.jsx】
 *   它只服务这一页，而"本机绝对路径 → 受限媒体地址"的规则（`mediaUrlOf` + `mediaDir`
 *   授权目录判断）也只在这一页，拆出去要么把这两个一起搬走、要么两个文件互相 import
 *   形成环。为拆而拆的收益是负的。
 *
 * 【交互清单】
 *   · 键盘：`←` 上一件 / `→` 下一件 / `Esc` 关闭（绑在 window 上，焦点在哪都生效）
 *   · 点遮罩关闭；底部工作栏「关闭」按钮关闭；舞台两侧 `‹` `›` 也是活的
 *   · 打开期间锁 `body` 滚动（不锁的话滚轮带着背后那页长文跑，大图没动，看着像"卡住了"）
 *   · 视频 `muted` + `autoPlay` 起步：不静音自动播放会"惊吓"用户，想听声音自己开
 *   · **文件不在的条目照样能打开**：显示「文件不在」+ 原路径 + 元信息，不给播放器
 *     （禁用「用作参考图」这类会失败的操作 —— 给入口就要能用，不能点了才报错）
 *
 * @param {object} props
 * @param {Array<object>} props.items 当前可切换的条目（作品库**筛选后**的结果 / 本次生成带）
 * @param {number} props.index 当前条目下标
 * @param {Function} props.onClose 关闭
 * @param {(delta:number) => void} props.onStep 切换（+1 下一件 / -1 上一件，循环）
 * @param {Function} [props.onUseAs] `useAssetAs(asset, target)` 的转发（没有就不给按钮）
 * @param {Function} [props.onEditImage] 「在这张图上继续改」= 套用成参考图 + 记住原图尺寸。
 *   与 `onUseAs` 分开是因为它多一步（读原图宽高），而 `onUseAs` 是通用转发、不该带副作用。
 * @param {Function} [props.onOpenFolder] 打开所在文件夹
 * @param {string} [props.mediaDir] 授权媒体根（`mediaUrlOf` 判相对路径用）
 * @returns {React.ReactElement|null}
 */
function MediaLightbox({ items, index, onClose, onStep, onUseAs, onEditImage, onOpenFolder, mediaDir }) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const i = total ? Math.max(0, Math.min(total - 1, Number(index) || 0)) : 0;
  const cur = total ? list[i] : null;

  // 键盘：只在开着的时候挂监听，关掉就摘 —— 否则会跟页面上别的地方抢方向键。
  useEffect(() => {
    const onKey = (e) => {
      if (!e || !e.key) return;
      if (e.key === 'Escape') {
        if (e.preventDefault) e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowRight') {
        if (e.preventDefault) e.preventDefault();
        onStep(1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        if (e.preventDefault) e.preventDefault();
        onStep(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onClose, onStep]);

  // 锁页面滚动：打开期间背后那页不许跟着滚。
  useEffect(() => {
    if (typeof document === 'undefined' || !document.body) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!cur) return null;

  const p = String(cur.localPath || '');
  const hasFile = assetHasFile(cur);
  const isVideo = cur.kind === 'video';
  const src = hasFile ? mediaUrlOf(p, mediaDir || '') : '';

  return (
    <div
      className="vd-lb"
      data-vd-lightbox="1"
      data-vd-lb-nofile={hasFile ? '0' : '1'}
      role="dialog"
      aria-modal="true"
      aria-label="作品预览"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* 舞台：两侧切换键 + 主媒体（图片全屏 contain / 视频播放器） */}
      <div className="vd-lb-stage">
        <Button
          className="vd-lb-nav vd-lb-prev"
          aria-label="上一件"
          disabled={total <= 1}
          onClick={() => onStep(-1)}
        >‹</Button>

        {!hasFile ? (
          <div className="vd-lb-lost" data-vd-lb-lost>
            <div className="vd-lb-lost-title">文件不在</div>
            <div className="vd-lb-lost-why">本机文件已不在（可能被移动或删除）。记录还在，路径是：</div>
            <code className="vd-lb-lost-path">{p || '（这条记录没有本机路径）'}</code>
          </div>
        ) : isVideo ? (
          <video
            className="vd-lb-media"
            data-vd-lb-media="video"
            src={src || undefined}
            controls
            muted
            autoPlay
            preload="metadata"
          />
        ) : (
          <img className="vd-lb-media" data-vd-lb-media="image" src={src || undefined} alt={String(cur.prompt || '作品')} />
        )}

        <Button
          className="vd-lb-nav vd-lb-next"
          aria-label="下一件"
          disabled={total <= 1}
          onClick={() => onStep(1)}
        >›</Button>
      </div>

      {/* 底部工作栏：序号 / 类型 / 文件名 / 体积 / 时间 / 描述摘要 / 能干的活 */}
      <div className="vd-lb-bar" data-vd-lb-bar>
        <span className="vd-lb-pos" data-vd-lb-pos>{i + 1} / {total}</span>
        <span className="vd-lb-kind">{kindText(cur)}</span>
        <code className="vd-lb-name">{baseName(p) || '（无文件名）'}</code>
        {sizeText(cur.bytes) ? <span className="vd-hint">{sizeText(cur.bytes)}</span> : null}
        {tsText(cur.ts) ? <span className="vd-hint">{tsText(cur.ts)}</span> : null}
        <span className="vd-lb-prompt" title={String(cur.prompt || '')}>
          {String(cur.prompt || '').slice(0, 40) || '（这条没有描述）'}
        </span>
        <div className="vd-lb-acts">
          <Button size="small" disabled={!p} onClick={() => onOpenFolder && onOpenFolder(p)}>打开所在文件夹</Button>
          {isVideo ? (
            <Button size="small" disabled={!hasFile || !onUseAs} onClick={() => onUseAs && onUseAs(cur, 'video_ref')}>
              用作参考视频
            </Button>
          ) : (
            <>
              {/* 「在这张图上继续改」：老板原话「没办法在原有的图片上编辑」。
                  与下面「用作参考图」的唯一区别是它**顺便记住原图宽高**（按原图尺寸出图）。
                  ★ 措辞刻意写全 —— 老文案「以此图再改」看不出会发生什么。 */}
              <Button
                size="small"
                type="primary"
                data-vd-lb-edit
                disabled={!hasFile || !onEditImage}
                onClick={() => onEditImage && onEditImage(cur)}
              >
                在这张图上继续改
              </Button>
              <Button size="small" disabled={!hasFile || !onUseAs} onClick={() => onUseAs && onUseAs(cur, 'image_ref')}>
                用作参考图
              </Button>
              <Button size="small" disabled={!hasFile || !onUseAs} onClick={() => onUseAs && onUseAs(cur, 'video_first')}>
                用作首帧
              </Button>
            </>
          )}
          <Button size="small" type="primary" onClick={onClose}>关闭</Button>
        </div>
      </div>
    </div>
  );
}

/** 素材文件描述统一成 {path,name,bytes,ext} —— 本地选的与作品库来的长得一样。 */
function asFile(f) {
  const p = String((f && f.path) || '');
  if (!p) return null;
  return {
    path: p,
    name: (f && f.name) || baseName(p),
    bytes: Number(f && f.bytes) || 0,
    ext: (f && f.ext) || extOf(p),
    // 主进程会把参考图复制一份进媒体根（为了缩略图能走受限协议），只为显示用
    thumbPath: String((f && f.thumbPath) || ''),
  };
}

/**
 * 素材池 → 可直接 JSON 化的瘦身副本。
 *
 * 只留 `{path,name,bytes}` 三个字段：素材里可能有 `File` 对象 / 主进程句柄 / 缩略图临时路径，
 * 那些**序列化不了**（JSON.stringify 会把 File 变成 `{}`），存进去等于存了个空壳，
 * 下次读出来就是一堆「有槽位但没文件」的死缩略图。而重新生成时渲染层只用到 `path`，
 * 所以这三个字段足够。
 * @param {object} m 素材池（`emptyMedia()` 的形状）
 * @returns {object} 瘦身后的素材池
 */
function slimMedia(m) {
  const out = emptyMedia();
  if (!m || typeof m !== 'object') return out;
  Object.keys(out).forEach((k) => {
    const arr = Array.isArray(m[k]) ? m[k] : [];
    out[k] = arr
      .map((f) => ({
        path: String((f && f.path) || ''),
        name: String((f && f.name) || ''),
        bytes: Number((f && f.bytes) || 0),
      }))
      .filter((f) => !!f.path);
  });
  return out;
}

/**
 * 读 localStorage 里的素材池 —— **逐字段白名单 + 类型校正**。
 * localStorage 里的东西不可信：可能是旧版本写的、可能被人手工改过、也可能是别的模块写坏的。
 * 校正后的形状必须与 `asFile()` 产出一致，否则 `renderSlot` 里读 `f.thumbPath` 会炸。
 * @param {any} raw 反序列化出来的原始值
 * @returns {object} 素材池
 */
function readMedia(raw) {
  const out = emptyMedia();
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(out).forEach((k) => {
    const arr = Array.isArray(raw[k]) ? raw[k] : [];
    out[k] = arr
      .filter((x) => x && typeof x === 'object' && typeof x.path === 'string' && x.path)
      .slice(0, 20)
      .map((x) => ({
        path: x.path,
        name: typeof x.name === 'string' && x.name ? x.name : baseName(x.path),
        bytes: Number(x.bytes) || 0,
        ext: extOf(x.path),
        // 缩略图临时路径不持久化（下次进来重新生成时由主进程再给）
        thumbPath: '',
      }));
  });
  return out;
}

/** 表单的兜底默认值。读不到 / 读坏了都回落到这里，绝不返回 undefined 字段。 */
function defaultForm() {
  return {
    mode: 'video',
    vPrompt: '',
    iPrompt: '',
    vNeg: '',
    vSeed: null,
    vRes: '480P',
    vRatio: 'adaptive',
    vDur: 5,
    vExtend: true,
    vAudio: false,
    iNeg: '',
    iSeed: null,
    iExtend: true,
    vMedia: emptyMedia(),
    iMedia: emptyMedia(),
  };
}

/**
 * 从 localStorage 恢复表单（切模块 / 切企业回来时不用重打一遍提示词）。
 * @param {string} key `douya-videodesign-form:<companyId>`
 * @returns {object} 类型已校正的表单快照
 */
function readForm(key) {
  const def = defaultForm();
  let raw = null;
  try { raw = localStorage.getItem(key); } catch (e) { return def; }
  if (!raw) return def;
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { return def; }
  if (!j || typeof j !== 'object') return def;

  const asStr = (v, d) => (typeof v === 'string' ? v : d);
  const asBool = (v, d) => (typeof v === 'boolean' ? v : d);
  /** 种子 / 时长这类要「数字或 null」的字段：空串 / null / NaN 一律回 null。 */
  const asNumOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const dur = asNumOrNull(j.vDur);
  return {
    mode: MODES.indexOf(j.mode) >= 0 ? j.mode : 'video',
    vPrompt: asStr(j.vPrompt, ''),
    iPrompt: asStr(j.iPrompt, ''),
    vNeg: asStr(j.vNeg, ''),
    vSeed: asNumOrNull(j.vSeed),
    vRes: asStr(j.vRes, '480P'),
    vRatio: asStr(j.vRatio, 'adaptive'),
    vDur: dur === null ? 5 : dur,
    vExtend: asBool(j.vExtend, true),
    vAudio: asBool(j.vAudio, false),
    iNeg: asStr(j.iNeg, ''),
    iSeed: asNumOrNull(j.iSeed),
    iExtend: asBool(j.iExtend, true),
    vMedia: readMedia(j.vMedia),
    iMedia: readMedia(j.iMedia),
  };
}

/**
 * 写表单快照。
 *
 * 照 `services/contentChat.js` 里 `writeLastRequest` 的写法：**try/catch 吞掉配额错误**。
 * localStorage 满了 / 隐私模式禁用，都不该让一次生成失败 —— 这只是「回来能不能认回来」的便利。
 * @param {string} key `douya-videodesign-form:<companyId>`
 * @param {object} patch 当前表单值
 * @returns {void}
 */
function writeForm(key, patch) {
  const p = patch || {};
  const def = defaultForm();
  try {
    localStorage.setItem(key, JSON.stringify({
      mode: MODES.indexOf(p.mode) >= 0 ? p.mode : def.mode,
      vPrompt: String(p.vPrompt || ''),
      iPrompt: String(p.iPrompt || ''),
      vNeg: String(p.vNeg || ''),
      vSeed: Number.isFinite(Number(p.vSeed)) && p.vSeed !== null && p.vSeed !== '' ? Number(p.vSeed) : null,
      vRes: String(p.vRes || def.vRes),
      vRatio: String(p.vRatio || def.vRatio),
      vDur: Number.isFinite(Number(p.vDur)) ? Number(p.vDur) : def.vDur,
      vExtend: p.vExtend !== false,
      vAudio: p.vAudio === true,
      iNeg: String(p.iNeg || ''),
      iSeed: Number.isFinite(Number(p.iSeed)) && p.iSeed !== null && p.iSeed !== '' ? Number(p.iSeed) : null,
      iExtend: p.iExtend !== false,
      vMedia: slimMedia(p.vMedia),
      iMedia: slimMedia(p.iMedia),
    }));
  } catch (e) {
    /* localStorage 满了也不该让生成失败 */
  }
}

/**
 * @param {object} props
 * @param {object} [props.api] 注入用（`window.api` 的替身）；缺省取 `window.api`。
 *   探针/单测里给一个假 api 就能在 jsdom 里验「有没有真的调那几条通道」，不会去碰真接口。
 * @param {Function} [props.onOpenSettings] 打开「设置」面板（key 现在在那里配）。
 *   没有这个 prop 时只显示一句文字提示，绝不 assume 它存在。
 * @param {string} [props.companyId] 当前企业 id。用于**按企业隔离**的后台任务键与表单持久化键，
 *   缺省 `'x'`（单测 / 无企业场景）。缺了它切企业会串结果。
 * @param {Function} [props.chatOnce] 「AI 优化提示词」用的 AI 出口，注入用。
 *   缺省就是 `api.js` 的 `chatOnce`（打主进程 `/api/chat-once`）。
 *   ★ 这个缝**是给门禁用例的**：不注入的话用例只能连真网络，那样的用例既跑不稳
 *   也验不了「AI 没配 / AI 报错」这两条最要紧的分支。产品运行时永远走默认值。
 */
export default function VideoDesign({ api: apiProp, onOpenSettings, companyId, chatOnce: chatOnceProp } = {}) {
  const api = useMemo(
    () => apiProp || (typeof window !== 'undefined' ? window.api : null) || {},
    [apiProp],
  );

  /**
   * 「AI 优化提示词」的生效出口。
   * ★ 只读 prop、不缓存到 ref：注入方换了函数要立刻生效（用例会在同一棵树里换桩）。
   */
  const chatFn = chatOnceProp || chatOnce;

  // ── 后台任务键 / 表单键 ──────────────────────────────────────────────────
  //
  // ★ 为什么生成状态不再放在组件里（本次修复的正题）：
  //   本页由 `App.jsx` **条件渲染**（`effectiveModule === 'videodesign' && <VideoDesign/>`），
  //   切到别的模块组件就卸载。旧写法把 busy/result/error 全放在组件 useState 里 ⇒
  //   ① `await api.wanxImage()` 的 promise 不会因为卸载而取消，跑完后 `setIResult`
  //      打在**已卸载实例**上，结果彻底丢 —— 用户原话「切到别的地方去回来就没有了 图也没了」；
  //   ② 错误只写局部 `iErr`，卸载后那行等于扔进黑洞 —— 「也没提示哪里有问题」；
  //   ③ 图片侧连秒数都没有，只有按钮转圈，而后端超时是 3 分钟 —— 「等半天没生出来」。
  //   仓库里 `store/backgroundJobs.js` 就是为这三件事写的（文件头第一句就是本段的问题描述），
  //   所以这里**接它**，而不是另发明一套。
  const companyKey = String(companyId || 'x');
  /** 图片任务键：按企业隔离，切企业不串图。 */
  const imageJobKey = 'videodesign-image-' + companyKey;
  /** 视频任务键：同上。 */
  const videoJobKey = 'videodesign-video-' + companyKey;
  /** 表单持久化键：只保结果不保输入，等于让用户切回来重打一遍提示词。 */
  const formKey = FORM_STORAGE_PREFIX + companyKey;
  /** 「本次生成」带子的作用域键：与上面两个同样按企业隔离。 */
  const shotsKey = SHOTS_STORAGE_PREFIX + companyKey;

  const imageJob = useBackgroundJob(imageJobKey);
  const videoJob = useBackgroundJob(videoJobKey);
  /** 终态一律来自后台任务 ⇒ 跨卸载存活。 */
  const imageResult = imageJob.result || null;
  /** 视频终态同理。 */
  const videoResult = videoJob.result || null;
  /**
   * 「本次生成」带子。
   *
   * ★ 来源是 `store/mediaShots.js` 的**模块级单例**，不是组件 useState ——
   *   `mergeShot()` 在后台任务的 taskFn 里被调用，那时组件可能已经卸载；
   *   `setSessionShots` 打在已卸载实例上等于扔进黑洞，用户会重新遇到
   *   「切到别的地方去回来就没有了 图也没了」。存活边界与取舍见该文件文件头。
   */
  const sessionShots = useSessionShots(shotsKey);

  /** 首帧快照：惰性 `useState(() => …)` 直接从这里取初值，避免"先渲染空表单再刷一下"。 */
  const savedForm = useMemo(() => readForm(formKey), [formKey]);

  // ── 自检 / 额度 / 账本 ───────────────────────────────────────────────────
  const [status, setStatus] = useState(null);
  const [budget, setBudget] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [mediaDirFromApi, setMediaDirFromApi] = useState('');

  // ── 模式 / 提示词 ────────────────────────────────────────────────────────
  // 0.21.25：加入第三个模式 'poster'（海报）。见文件头「第三态：海报」一节。
  const [mode, setMode] = useState(() => savedForm.mode); // 'video' | 'image' | 'poster'
  const [vPrompt, setVPrompt] = useState(() => savedForm.vPrompt);
  const [iPrompt, setIPrompt] = useState(() => savedForm.iPrompt);
  const promptRef = useRef(null);

  // ── `@` 提及面板 ────────────────────────────────────────────────────────
  //
  // 老板原话：「我要套用生成出来的图片或者视频 现在没办法套用 没有办法 @图片1 图片2 这样」。
  //
  // `mentionAt` = **刚敲进来的那个 `@` 的下标 + 1**（也就是光标该在的位置）；-1 = 面板关着。
  // 存下标而不是存"开着/关着"，是因为插入时要把它替换成 `@图片N` —— 存了位置才不会
  // 又把编号追加到末尾（那是 `insertToken` 的老行为，它有自己的用例，**不许改**）。
  const [mentionAt, setMentionAt] = useState(-1);
  /** 面板里键盘高亮到第几项（Enter 选的就是它）。 */
  const [mentionIdx, setMentionIdx] = useState(0);

  // ── 「在这张图上继续改」的原图尺寸 ────────────────────────────────────────
  /** `{path, w, h}`：点了「在这张图上继续改」并**真读到**原图宽高时才有值。 */
  const [editBase, setEditBase] = useState(null);
  /** 读尺寸失败时的那句话（空串 = 没有话要说）。 */
  const [editBaseTip, setEditBaseTip] = useState('');
  /** 测量请求的序号：快速连点两张图时，只认最后一次的结果（否则尺寸会串到别人身上）。 */
  const editBaseReqRef = useRef(0);

  // ── 「AI 优化提示词」────────────────────────────────────────────────────
  //
  // 老板原话：「没有AI优化提示词。」
  // ★ 它只调 `chatFn`（= `chatOnce` → 主进程 `/api/chat-once`），**绝不碰 wanx**：
  //   优化提示词不生成、不上传、不落盘，因此**不扣任何生图/生视频额度**。
  //   下一个人若想"顺手"在这里加一次试生成看看效果 —— 禁止：那会真花用户的钱，
  //   而且用户点的是"优化文字"，不是"生成"。
  const [aiBusy, setAiBusy] = useState(false);
  /** AI 失败原因（非「未配置」那一档）。空串 = 无错误。 */
  const [aiErr, setAiErr] = useState('');
  /** AI 未配置（`code === 'AI_NOT_CONFIGURED'`）：单独一句话，落点是「设置」。 */
  const [aiNeedConfig, setAiNeedConfig] = useState(false);
  /**
   * 撤销用的原文：`{ text, mode }`。
   * ★ 只留**一份**（最近一次），不做多级撤销 —— 用户点第二次优化时，想要回到的是
   *   "上一次 AI 给我的那句"，而不是十步之前自己写的草稿。多级撤销还得配一个 UI 面板，
   *   为一个辅助功能加面板不划算。
   */
  const [aiUndo, setAiUndo] = useState(null);

  // ── 视频参数 ────────────────────────────────────────────────────────────
  const [vRes, setVRes] = useState(() => savedForm.vRes);
  const [vRatio, setVRatio] = useState(() => savedForm.vRatio);
  const [vDur, setVDur] = useState(() => savedForm.vDur);
  const [vNeg, setVNeg] = useState(() => savedForm.vNeg);
  const [vSeed, setVSeed] = useState(() => savedForm.vSeed);
  const [vExtend, setVExtend] = useState(() => savedForm.vExtend);
  const [vAudio, setVAudio] = useState(() => savedForm.vAudio);
  // `vTask` 只剩一个职责：**进行中的进度展示**（statusText / task_id / lastError）。
  // 终态（成没成、存在哪）一律读 `videoResult`，所以切走再回来不会丢。
  const [vTask, setVTask] = useState(null);
  const [vTip, setVTips] = useState('');
  const [tick, setTick] = useState(0); // 只为让「已等待 N 秒」往前走

  // ── 图片参数 ────────────────────────────────────────────────────────────
  const [iNeg, setINeg] = useState(() => savedForm.iNeg);
  const [iSeed, setISeed] = useState(() => savedForm.iSeed);
  const [iExtend, setIExtend] = useState(() => savedForm.iExtend);
  // 落盘阶段标记：**只影响文案**、不影响结果，所以允许是组件局部 state
  // （组件卸载后它会丢，但丢的只是「正在存到本机…」这半句，结果本身在后台任务里）。
  const [landPhase, setLandPhase] = useState('');
  // 表单校验提示（"请先写一句画面描述"）。它不是**生成错误**，所以单独放，
  // 不与 `imageJob.error` 混在一起 —— 后者要跨卸载存活，前者不需要。
  const [imageTip, setImageTip] = useState('');

  // ── 素材（两种模式各一份，互不覆盖）──────────────────────────────────────
  const [vMedia, setVMedia] = useState(() => savedForm.vMedia);
  const [iMedia, setIMedia] = useState(() => savedForm.iMedia);
  const [mediaTip, setMediaTip] = useState('');

  // ── 作品库 ──────────────────────────────────────────────────────────────
  const [assets, setAssets] = useState([]);
  const [assetsErr, setAssetsErr] = useState('');
  const [assetsMissing, setAssetsMissing] = useState(false);
  /** 「有记录但本机文件已不在」的条数（主进程给的 missingCount，取不到就用本地数）。 */
  const [assetsMissingCount, setAssetsMissingCount] = useState(0);
  /** 主进程说「一共多少条」（= listAssets 的 total，**不受 limit 截断**）。 */
  const [assetsTotal, setAssetsTotal] = useState(0);

  // ── 作品库工作栏（筛选 / 搜索 / 计数）—— 纯前端过滤，不改主进程 ────────────
  const [libFilter, setLibFilter] = useState('all'); // 'all' | 'image' | 'video'
  const [libQuery, setLibQuery] = useState('');

  // ── 灯箱（全屏看大图 / 播视频）───────────────────────────────────────────
  // `{ items, index }`：items 是**当时那一批**（作品库筛选后的结果 / 本次生成带），
  // 左右切换只在这批里循环 —— 跟即梦一致，不会切到被筛掉的东西上。
  const [lightbox, setLightbox] = useState(null);

  // ── 单价 / 总额度 ────────────────────────────────────────────────────────
  const [budgetEdit, setBudgetEdit] = useState(false);
  const [prefsDraft, setPrefsDraft] = useState(null);
  const [prefsMsg, setPrefsMsg] = useState('');

  const refresh = useCallback(async () => {
    setLoadErr('');
    try {
      const st = await api.wanxStatus();
      if (!st || st.ok !== true) {
        setLoadErr((st && st.error) || '读取配置失败');
        return;
      }
      setStatus(st);
      setBudget(st.budget || null);
      // 保存目录：优先用 status.mediaDir；没有就问 wanxMediaDir（这条通道可能还没到位）
      let dir = st.mediaDir || '';
      if (!dir && typeof api.wanxMediaDir === 'function') {
        try {
          const d = await api.wanxMediaDir();
          if (d && d.ok === true && d.dir) dir = d.dir;
        } catch (e) { /* 取不到目录不影响别的：界面上会兜底成一句文字 */ }
      }
      if (dir) setMediaDirFromApi(dir);
      const led = await api.wanxLedger(20);
      setLedger((led && led.items) || []);
      // 首次进来把表单档位设成「已验证」的那一档，避免用户一上手就选到没跑过的参数
      const firstOk = ((st.options && st.options.resolutions) || []).find((x) => x.verified);
      if (firstOk) setVRes((cur) => cur || firstOk.value);
    } catch (e) {
      setLoadErr((e && e.message) || '读取配置失败');
    }
  }, [api]);

  /** 作品库：读历史产物。通道不存在时给一句「需要更新到新版」，不崩。 */
  const loadAssets = useCallback(async () => {
    if (typeof api.wanxAssets !== 'function') { setAssetsMissing(true); return; }
    setAssetsMissing(false);
    try {
      const r = await api.wanxAssets({ limit: ASSETS_LIMIT });
      if (!r || r.ok !== true) { setAssetsErr((r && r.error) || '读取作品库失败'); return; }
      setAssetsErr('');
      const list = Array.isArray(r.items) ? r.items : [];
      setAssets(list);
      // 「一共多少条」以主进程的 total 为准；老主进程没有这个字段 ⇒ 退化成"这次拿到几条"
      const total = Number(r.total);
      setAssetsTotal(Number.isFinite(total) && total >= list.length ? total : list.length);
      // 「其中 N 件本机文件已不在」——主进程新口径；老主进程没有这个字段就前端自己数
      const miss = Number(r.missingCount);
      if (Number.isFinite(miss)) {
        setAssetsMissingCount(Math.max(0, miss));
      } else {
        setAssetsMissingCount(list.filter((a) => a && !assetHasFile(a)).length);
      }
      if (r.dir) setMediaDirFromApi((cur) => cur || r.dir);
    } catch (e) {
      setAssetsErr((e && e.message) || '读取作品库失败');
    }
  }, [api]);

  /**
   * 把「刚生成的那一条」立刻并进作品库 + 本次生成带。
   *
   * 为什么必须本地并、而不是等一次 `loadAssets()` 重拉：
   *   `wanxSave` 落盘成功后要再走一次 IPC 往返才能看到新条目，中间那段时间结果区
   *   只有一张大图 / 一个大播放器 —— 老板原话「生完之后看不到缩略图」。
   *   本地先并 ⇒ 缩略图**同步**出现；`loadAssets()` 随后对齐（真值仍以主进程为准，
   *   本地这条只是提前显示，不参与任何计费 / 提交判断）。
   *
   * ⚠️ 两个写入点，缺一个就会各丢一半：
   *   · `setAssets`（组件 state）—— 立刻反映在**作品库**列表里；
   *   · `addSessionShot`（模块级单例）—— 结果区的「本次生成」带子。
   *     它**必须**走模块级 store：本函数是在后台任务的 taskFn 里被调用的，
   *     那时组件可能已经卸载（用户切到别的模块去了），`setAssets` 会被 React 丢弃。
   *
   * @param {object} item `{id?, kind, localPath, bytes, prompt, ts?, taskId?}`
   * @returns {void}
   */
  const mergeShot = useCallback((item) => {
    if (!item || !item.localPath) return;
    const one = Object.assign({}, item, {
      id: item.id || ('local-' + String(item.localPath)),
      ts: item.ts || new Date().toISOString(),
      missing: false,
    });
    setAssets((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      if (list.some((a) => a && (a.id === one.id || a.localPath === one.localPath))) return list;
      return [one].concat(list);
    });
    addSessionShot(shotsKey, one);
  }, [shotsKey]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadAssets(); }, [loadAssets]);

  /**
   * 表单持久化（一条统一写回，不给每个字段各挂一个 effect）。
   * 切到别的模块 → 组件卸载 → 回来时 `useState(() => savedForm.x)` 把提示词/档位/素材一起还原。
   */
  useEffect(() => {
    writeForm(formKey, {
      mode,
      vPrompt,
      iPrompt,
      vNeg,
      vSeed,
      vRes,
      vRatio,
      vDur,
      vExtend,
      vAudio,
      iNeg,
      iSeed,
      iExtend,
      vMedia,
      iMedia,
    });
  }, [formKey, mode, vPrompt, iPrompt, vNeg, vSeed, vRes, vRatio, vDur, vExtend, vAudio,
    iNeg, iSeed, iExtend, vMedia, iMedia]);

  // 「已等待 N 秒」的心跳：任何一个后台任务在跑就走 1 秒一次，全部结束立刻停（省电也省渲染）。
  // ★ 判据是**后台任务**的 busy，不是组件局部状态 —— 否则切走再回来秒数会归零。
  const anyJobBusy = imageJob.busy || videoJob.busy;
  useEffect(() => {
    if (!anyJobBusy) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyJobBusy]);

  const hasKey = !!(status && status.hasKey);
  const limits = (status && status.limits) || DEFAULT_LIMITS;
  const maxVideoRefImages = (limits.video && limits.video.maxRefImages) || DEFAULT_LIMITS.video.maxRefImages;
  const maxRefVideos = (limits.video && limits.video.maxRefVideos) || DEFAULT_LIMITS.video.maxRefVideos;
  const maxRefAudio = (limits.video && limits.video.maxRefAudio) || DEFAULT_LIMITS.video.maxRefAudio;
  const maxImageRefImages = (limits.image && limits.image.maxRefImages) || DEFAULT_LIMITS.image.maxRefImages;

  const mediaDir = (status && status.mediaDir) || mediaDirFromApi || '';
  const mediaDirText = mediaDir || '（未取到保存目录）';

  /** 聚焦提示词框（从作品库点完「用作参考图」后，光标要落在这里让人接着改）。 */
  const focusPrompt = useCallback(() => {
    setTimeout(() => {
      const el = promptRef.current;
      if (!el) return;
      try { el.focus(); } catch (e) { /* ignore */ }
      try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    }, 30);
  }, []);

  /**
   * 聚焦提示词框并把光标放到第 `pos` 个字符之后（插入 `@图片N ` 之后要接着打字）。
   *
   * antd 的 `TextArea` ref 上有 `resizableTextArea.textArea`（底层 DOM）—— 但那是
   * **实现细节**，版本一换就可能没了。所以这里三层兜底，任何一层成功即可：
   *   ① 底层 textarea + `setSelectionRange`
   *   ② ref 自己就是 textarea / 有 focus
   *   ③ 什么都不成 ⇒ 至少聚焦（**绝不能因为设光标失败让插入本身失败**）
   *
   * @param {number} pos 目标光标位置（越界会被夹到合法范围）
   * @returns {void}
   */
  const focusPromptAt = useCallback((pos) => {
    const target = Math.max(0, Number(pos) || 0);
    const run = () => {
      const el = promptRef.current;
      if (!el) return;
      // ① antd TextArea：真正能设光标的是底层的原生 textarea
      const inner = (el.resizableTextArea && el.resizableTextArea.textArea) || null;
      if (inner && typeof inner.focus === 'function') {
        try {
          inner.focus();
          if (typeof inner.setSelectionRange === 'function') {
            const len = String(inner.value || '').length;
            const at = Math.min(target, len);
            inner.setSelectionRange(at, at);
          }
          return;
        } catch (e) { /* 落到下面继续兜底 */ }
      }
      // ② ref 自己就是原生控件
      try {
        el.focus();
        if (typeof el.setSelectionRange === 'function') {
          const len = String(el.value || '').length;
          const at = Math.min(target, len);
          el.setSelectionRange(at, at);
        }
      } catch (e) { /* ignore：设光标失败不影响插入 */ }
    };
    // requestAnimationFrame 让 React 先把新 value 冲上去，再设光标；jsdom 里没有 rAF 就退 setTimeout。
    try {
      const raf = typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame : null;
      if (raf) raf(run);
      else setTimeout(run, 0);
    } catch (e) {
      setTimeout(run, 0);
    }
  }, []);

  // ── 素材：选文件 / 加槽位 / 删槽位 ───────────────────────────────────────
  /**
   * 选本机文件。通道不存在时**只提示不抛**（主进程可能还没更新到这一版）。
   * @returns {Promise<Array|null>} 取消 / 失败都返回 null（调用方直接 return 即可）
   */
  const pickFiles = async (kind, multiple) => {
    if (typeof api.wanxPickMedia !== 'function') {
      setMediaTip('选本机素材需要更新到新版：当前版本还没有这个入口。');
      return null;
    }
    try {
      const r = await api.wanxPickMedia({ kind, multiple });
      if (!r) return null;
      if (r.canceled) return null; // 用户自己关掉了选择框，不是错误
      if (r.ok !== true) { setMediaTip((r && r.error) || '读取所选文件失败'); return null; }
      const list = Array.isArray(r.files) ? r.files.map(asFile).filter(Boolean) : [];
      if (!list.length) return null;
      setMediaTip('');
      return list;
    } catch (e) {
      setMediaTip((e && e.message) || '读取所选文件失败');
      return null;
    }
  };

  /** 槽位规格：名字 / 文件类型 / 上限 / 所属组（frame 与 ref 互斥）。 */
  const slotSpec = useCallback((k) => {
    if (k === 'first_frame') return { name: '首帧', kind: 'image', max: 1, group: 'frame' };
    if (k === 'last_frame') return { name: '尾帧', kind: 'image', max: 1, group: 'frame' };
    if (k === 'reference_image') {
      return { name: '参考图', kind: 'image', max: mode === 'video' ? maxVideoRefImages : maxImageRefImages, group: 'ref' };
    }
    if (k === 'reference_video') return { name: '参考视频', kind: 'video', max: maxRefVideos, group: 'ref' };
    return { name: '参考音频', kind: 'audio', max: maxRefAudio, group: 'ref' };
  }, [mode, maxVideoRefImages, maxImageRefImages, maxRefVideos, maxRefAudio]);

  const mediaOf = (k) => (mode === 'video' ? vMedia[k] : iMedia[k]) || [];
  const framesUsed = vMedia.first_frame.length + vMedia.last_frame.length;
  const refsUsed = vMedia.reference_image.length + vMedia.reference_video.length + vMedia.reference_audio.length;
  const frameLocked = refsUsed > 0;
  const refLocked = framesUsed > 0;
  const allUsed = mode === 'video' ? framesUsed + refsUsed : iMedia.reference_image.length;

  /**
   * 加素材前的准入判据（互斥 / 上限）。
   *
   * @param {string} k 槽位键
   * @returns {string} `''` = 可以加；否则是**要显示给用户的那句话**
   *
   * ★ 抽出来只为一件事：`@` 提及面板里选中一张「作品库 / 本次生成」的图时，必须
   *   **先知道它能不能加进去**，才能算出它会落在第几号 —— 编号必须和提交顺序一致。
   *   两处各写一遍判据，迟早改了一边忘另一边：那时编号看似对、素材其实没加进去，
   *   出的图就指到了别处，而且不报错。
   */
  const slotGuard = (k) => {
    const spec = slotSpec(k);
    // 互斥只在视频模式成立（图片模式只有参考图，别被视频模式里剩下的帧卡住）
    const lockFrame = mode === 'video' && frameLocked;
    const lockRef = mode === 'video' && refLocked;
    if (spec.group === 'frame' && lockFrame) return EXCLUSIVE_NOTE;
    if (spec.group === 'ref' && lockRef) return EXCLUSIVE_NOTE;
    const room = spec.max - mediaOf(k).length;
    if (room <= 0) return '「' + spec.name + '」最多 ' + spec.max + ' 个，先删一个再加。';
    return '';
  };

  /**
   * 往槽位加文件。
   * · `preset` 来自作品库（已经有本机路径，不用再弹选择框）
   * · 加首尾帧会**清空参考素材**，加参考素材会**清空首尾帧** —— 两组互斥，
   *   与其让用户在提交时报错，不如当场把另一组撤掉并说一句。
   *
   * @param {string} k 槽位键
   * @param {Array<object>} [preset] 现成的文件（不传就弹本机选择框）
   * @returns {Promise<boolean>} 真的加进去了没有（`@` 提及面板据此决定要不要插编号）
   */
  const addToSlot = async (k, preset) => {
    const spec = slotSpec(k);
    const blocked = slotGuard(k);
    if (blocked) { setMediaTip(blocked); return false; }
    const cur = mediaOf(k);
    const room = spec.max - cur.length;
    const files = preset || await pickFiles(spec.kind, spec.max > 1);
    if (!files || !files.length) return false;
    // ★ 参考图/参考视频/尾帧被手动换掉之后，「按原图尺寸出图」的依据就不成立了 ——
    //   图已经换成另一张，再把上一张的宽高发给上游，等于给新图套了个别人的画布。
    setEditBase(null);
    setEditBaseTip('');
    const take = files.slice(0, room);
    // ★ 选多了必须说出来。之前这里是静默 `slice(0, room)`：用户点「参考图」选了 12 张、
    //   上限 10，多出来的 2 张**无声消失**，界面上只看到计数 10/10，人会以为自己少选了两张。
    //   老板原话是「上传好几个角色」—— 一次选 5 张只进 3 张却不吭声，等于让他反复试。
    //   这条提示放在下面互斥提示之后覆盖（"东西丢了"比"旧的被清空"更需要被看见）。
    const droppedTip = files.length > take.length
      ? '选了 ' + files.length + ' 个，「' + spec.name + '」最多 ' + spec.max + ' 个，只加进了前 ' + take.length + ' 个。'
      : '';

    if (mode === 'video') {
      setVMedia((prev) => {
        if (spec.group === 'frame') {
          // 加首帧/尾帧：只清参考素材，**不动另一张帧**（首帧和尾帧是同一组的搭档）
          return Object.assign({}, prev, {
            reference_image: [],
            reference_video: [],
            reference_audio: [],
            [k]: take.slice(0, 1),
          });
        }
        return Object.assign({}, prev, {
          first_frame: [],
          last_frame: [],
          [k]: (prev[k] || []).concat(take),
        });
      });
      if (spec.group === 'frame' && refsUsed > 0) setMediaTip('已切到首尾帧模式，原来的参考素材已清空。');
      if (spec.group === 'ref' && framesUsed > 0) setMediaTip('已切到参考素材模式，原来的首帧/尾帧已清空。');
      if (droppedTip) setMediaTip(droppedTip);
    } else {
      setIMedia((prev) => Object.assign({}, prev, {
        reference_image: (prev.reference_image || []).concat(take),
      }));
      if (droppedTip) setMediaTip(droppedTip);
    }
    return true;
  };

  const removeFromSlot = (k, idx) => {
    // 删素材 ⇒ 参考图集变了，「按原图尺寸」的那张可能已经不在了，清掉依据。
    setEditBase(null);
    setEditBaseTip('');
    const drop = (arr) => arr.filter((_x, i) => i !== idx);
    if (mode === 'video') setVMedia((prev) => Object.assign({}, prev, { [k]: drop(prev[k] || []) }));
    else setIMedia((prev) => Object.assign({}, prev, { [k]: drop(prev.reference_image || []) }));
  };

  const clearMedia = () => {
    setEditBase(null);
    setEditBaseTip('');
    if (mode === 'video') setVMedia(emptyMedia());
    else setIMedia(emptyMedia());
    setMediaTip('');
  };

  /** 角色 / 数字人：本质就是往参考图里加图 + 补一句一致性前缀。 */
  const addCharacter = async () => {
    // 互斥只在视频模式成立（图片模式没有首尾帧，别被视频模式剩下的帧卡住）
    if (mode === 'video' && refLocked) { setMediaTip(EXCLUSIVE_NOTE); return; }
    const files = await pickFiles('image', true);
    if (!files || !files.length) return;
    // 参考图集变了 ⇒ 之前那张「原图尺寸」不再对应，清掉依据
    setEditBase(null);
    setEditBaseTip('');
    const max = mode === 'video' ? maxVideoRefImages : maxImageRefImages;
    const setter = mode === 'video' ? setVMedia : setIMedia;
    // ★ 与 addToSlot 同一个病：`slice` 静默丢文件。这里是老板「一次上传好几个角色」的入口，
    //   选 5 张只进 3 张却不吭声，人会以为图没选上、又选一遍。
    //   所以「丢没丢」必须在**闭包外**算出来 —— 闭包里 setMediaTip 会在渲染期执行，不能这么干。
    const already = (mode === 'video' ? vMedia.reference_image : iMedia.reference_image) || [];
    const room = Math.max(0, max - already.length);
    const droppedCount = Math.max(0, files.length - room);
    setter((prev) => {
      const cur = prev.reference_image || [];
      const take = files.slice(0, Math.max(0, max - cur.length));
      if (!take.length) return prev;
      return Object.assign({}, prev, { reference_image: cur.concat(take) });
    });
    const setPrompt = mode === 'video' ? setVPrompt : setIPrompt;
    setPrompt((p) => (String(p || '').indexOf('图1 是主角') >= 0 ? p : CHARACTER_PREFIX + String(p || '')));
    if (droppedCount > 0) {
      setMediaTip('选了 ' + files.length + ' 张，参考图最多 ' + max + ' 张，只加进了前 ' + room + ' 张（少的那 ' + droppedCount + ' 张没加）。');
    } else {
      setMediaTip('');
    }
    focusPrompt();
  };

  /** 「插入 图N」：把编号塞进提示词，让模型知道哪张是主角 / 哪张是道具。 */
  const insertToken = (n) => {
    const token = '图' + n;
    const re = new RegExp(token + '(?![0-9])');
    const setPrompt = mode === 'video' ? setVPrompt : setIPrompt;
    setPrompt((p) => {
      const s = String(p || '');
      if (re.test(s)) return s;
      return s ? s.replace(/\s+$/, '') + ' ' + token + ' ' : token + ' ';
    });
    focusPrompt();
  };

  // ── `@` 提及：可引用素材的**唯一编号表** ──────────────────────────────────
  /**
   * 当前能 `@` 到的素材，编号 `n` 从 1 连续。
   *
   * 【顺序为什么必须是这样】
   *   编号 `N` 在提示词里最终变成 `图N`，而 `图N` 指代的是**提交时那个数组里的第 N 个**。
   *   所以这里的摊平顺序 == `submitVideo()` 组 `media[]` 的顺序 == `wanxVideo` 的
   *   `['first_frame','last_frame','reference_image','reference_video','reference_audio']`
   *   == 图片模式下 `refImages` 的顺序。**只有一份派生**（就这里），提交处也读它，
   *   绝不各算一遍 —— 那是"编号看着对、图却指错"的唯一成因。
   *
   * 【除了槽位，还要接上「本次生成」和「作品库」】
   *   老板要的是「套用**生成出来的**图片或视频」，他的素材此刻大概率还不在槽位里。
   *   这两类条目排在槽位之后，选中时**先套用进参考槽、再插编号**（见 `pickMention`），
   *   所以它们最终也会落进上面那个数组里，编号依旧一致。
   *
   * @type {Array<{n:number, from:'slot'|'shot'|'asset', slot?:string, path:string,
   *   name:string, kind:'image'|'video', bytes:number, asset?:object}>}
   */
  const mentionList = useMemo(() => {
    const pool = mode === 'video' ? vMedia : iMedia;
    const keys = mode === 'video' ? MEDIA_SLOT_ORDER : IMAGE_SLOT_ORDER;
    const out = [];
    const seen = Object.create(null);
    keys.forEach((k) => {
      (pool[k] || []).forEach((f) => {
        const p = String((f && f.path) || '');
        if (!p || seen[p]) return;
        seen[p] = true;
        out.push({
          from: 'slot', slot: k, path: p,
          name: String((f && f.name) || baseName(p)),
          kind: k === 'reference_video' ? 'video' : 'image',
          bytes: Number((f && f.bytes) || 0),
        });
      });
    });
    // 本次生成（会话内的新产物）：最近的在前，和缩略图带的顺序一致
    (sessionShots || []).forEach((s) => {
      const p = String((s && s.localPath) || '');
      if (!p || seen[p] || !assetHasFile(s)) return;
      seen[p] = true;
      out.push({
        from: 'shot', path: p, name: baseName(p) || kindText(s),
        kind: s.kind === 'video' ? 'video' : 'image',
        bytes: Number((s && s.bytes) || 0), asset: s,
      });
    });
    // 作品库：**只要本机文件还在的**（`missing` 的条目套不进请求，混进来只会是个点了报错的编号）
    (assets || []).forEach((a) => {
      const p = String((a && a.localPath) || '');
      if (!p || seen[p] || !assetHasFile(a)) return;
      seen[p] = true;
      out.push({
        from: 'asset', path: p, name: baseName(p) || kindText(a),
        kind: a.kind === 'video' ? 'video' : 'image',
        bytes: Number((a && a.bytes) || 0), asset: a,
      });
    });
    // 图片模式只有参考图（refImages 也只收图）⇒ 视频素材剔掉，不留一个指不到东西的编号
    const usableList = mode === 'image' ? out.filter((x) => x.kind === 'image') : out;
    return usableList.map((x, i) => Object.assign({}, x, { n: i + 1 }));
  }, [mode, vMedia, iMedia, sessionShots, assets]);

  /** 会被提交的素材数（= `图N` 的合法上限）：视频按摊平后的条数，图片按参考图张数。 */
  const slotMentionCount = useMemo(() => {
    if (mode !== 'video') return (iMedia.reference_image || []).length;
    return MEDIA_SLOT_ORDER.reduce((acc, k) => acc + ((vMedia[k] || []).length), 0);
  }, [mode, vMedia, iMedia]);

  /** 面板里真正渲染（也真正参与上下键选择）的那一段。 */
  const mentionShown = useMemo(() => mentionList.slice(0, MENTION_PANEL_MAX), [mentionList]);

  /**
   * 提示词框的键盘处理：**只在面板开着时**接管。
   *
   * 面板没开时这里一个字都不做（直接 return）—— 这一点很重要：`Enter` 在 textarea 里
   * 是换行，`↑`/`↓` 是移动光标，接管了就等于把这页的输入体验改坏。既有用例里
   * 有直接往提示词框打字的断言，它们不会被这条逻辑影响。
   *
   * @param {any} e React 键盘事件
   * @returns {void}
   */
  const onPromptKeyDown = (e) => {
    if (!e || mentionAt < 0 || !mentionShown.length) return;
    const key = String(e.key || '');
    if (key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      setMentionAt(-1);
      return;
    }
    if (key === 'ArrowDown') {
      if (e.preventDefault) e.preventDefault();
      setMentionIdx((i) => (Number(i) + 1) % mentionShown.length);
      return;
    }
    if (key === 'ArrowUp') {
      if (e.preventDefault) e.preventDefault();
      setMentionIdx((i) => (Number(i) - 1 + mentionShown.length) % mentionShown.length);
      return;
    }
    if (key === 'Enter' && !e.shiftKey) {
      // Shift+Enter 仍然是换行：那是写多行描述的常规操作，不该被面板吃掉
      if (e.preventDefault) e.preventDefault();
      const i = Math.max(0, Math.min(mentionShown.length - 1, Number(mentionIdx) || 0));
      pickMention(mentionShown[i]);
    }
  };

  /** 关掉提及面板。 */
  const closeMention = () => {
    if (mentionAt >= 0) setMentionAt(-1);
  };

  /**
   * 提示词输入：写 state + 识别「刚敲进来的那一个字符是 `@`」。
   *
   * ★ 只在**输入**时识别，不在 `setVPrompt` 的其它调用点识别（AI 改写、插入编号、角色前缀）——
   *   否则 AI 返回的句子里只要带一个 `@` 就会弹出面板。
   *
   * @param {any} e antd/React 的 change 事件
   * @returns {void}
   */
  const onPromptChange = (e) => {
    const value = String((e && e.target && e.target.value) || '');
    const prev = String((mode === 'video' ? vPrompt : iPrompt) || '');
    if (mode === 'video') setVPrompt(value);
    else setIPrompt(value);
    const at = insertedCharIndex(prev, value, '@');
    if (at >= 0 && mentionList.length) {
      setMentionAt(at + 1);
      setMentionIdx(0);
      return;
    }
    // 面板开着但那个 `@` 已经被删掉/改掉了 ⇒ 关掉，别留一个指不到位置的浮层
    if (mentionAt >= 0 && value.charAt(mentionAt - 1) !== '@') setMentionAt(-1);
  };

  /**
   * 把光标处的 `@` 换成 `@图片N `（**插入在光标处，不是追加到末尾**）。
   *
   * 「光标处」不读实时的 `selectionStart`：面板打开时记下的 `mentionAt`（`@` 的下标 +1）
   * 才是那个位置的真源 —— 用户点面板那一下，焦点可能已经离开 textarea，
   * 那一刻的 `selectionStart` 是 0 或旧值。位置失效（`@` 已被删）时退化成追加，
   * 与老的 `insertToken` 同样"至少把编号给到用户"，但**不改 `insertToken` 本身**。
   *
   * @param {number} n 素材编号（1 起，来自 `mentionList`）
   * @returns {void}
   */
  const insertMentionToken = (n) => {
    const num = Number(n);
    if (!(Number.isInteger(num) && num > 0)) { setMentionAt(-1); return; }
    const token = '@图片' + num + ' ';
    const setPrompt = mode === 'video' ? setVPrompt : setIPrompt;
    const cur = String((mode === 'video' ? vPrompt : iPrompt) || '');
    const at = mentionAt >= 0 ? mentionAt - 1 : -1;
    const atIsToken = at >= 0 && at < cur.length && cur.charAt(at) === '@';
    const next = atIsToken
      ? cur.slice(0, at) + token + cur.slice(at + 1)
      : (cur && !/\s$/.test(cur) ? cur + ' ' : cur) + token;
    setPrompt(next);
    setMentionAt(-1);
    setMentionIdx(0);
    focusPromptAt(atIsToken ? at + token.length : next.length);
  };

  /**
   * 加入素材后它会落到第几号（**必须与提交顺序一致**，算法见 `mentionIndexAfterAdd`）。
   *
   * @param {string} slot 目标槽位键（只可能是 `reference_image` / `reference_video`）
   * @returns {number} 1 起的编号
   */
  const mentionIndexAfterAdd = (slot) => {
    const pool = mode === 'video' ? vMedia : iMedia;
    // 加参考素材会清空首尾帧（`addToSlot` 的互斥规则），所以帧在这一步贡献 0
    const keys = mode === 'video'
      ? ['reference_image', 'reference_video', 'reference_audio']
      : ['reference_image'];
    let n = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const c = (pool[k] || []).length;
      if (k === slot) return n + c + 1; // 追加在该组末尾
      n += c;
    }
    return n + 1;
  };

  /**
   * 面板里选中一项：槽位里的直接插编号；「本次生成 / 作品库」的先套用进参考槽再插编号。
   *
   * 为什么非槽位的要先套用：`图N` 只对**提交数组里的第 N 个**有意义。只把
   * `@图片5` 写进提示词而第 5 个素材根本不存在，等于让模型去猜 —— 那正是老板
   * 「没办法套用」的另一半。套用 + 插编号一次做完，用户不用记两步。
   *
   * @param {object} item `mentionList` 的一项
   * @returns {void}
   */
  const pickMention = (item) => {
    if (!item) { setMentionAt(-1); return; }
    if (item.from === 'slot') { insertMentionToken(item.n); return; }
    if (mode === 'image' && item.kind === 'video') {
      // 理论上 image 模式列表里已经把视频剔掉了，这里只是兜底（列表逻辑将来被改坏时不至于静默）
      setMediaTip('图片模式只能套用图片；视频素材请在「视频」模式下当参考视频用。');
      setMentionAt(-1);
      return;
    }
    const slot = item.kind === 'video' ? 'reference_video' : 'reference_image';
    const blocked = slotGuard(slot);
    if (blocked) { setMediaTip(blocked); setMentionAt(-1); return; }
    const n = mentionIndexAfterAdd(slot);
    const f = asFile({ path: item.path, name: item.name, bytes: item.bytes });
    if (!f) { setMediaTip('这件素材没有本机文件，没法套用。'); setMentionAt(-1); return; }
    // 判据刚过（同一个 `slotGuard`），这里必定能加进去；不等 promise 就插编号，
    // 否则用户在面板上点一下要等一拍才有反应。
    addToSlot(slot, [f]);
    insertMentionToken(n);
  };

  /**
   * 读一张图的**原始宽高**并记下来（「按原图尺寸再生成」的依据）。
   *
   * @param {object} asset 作品条目（要有 `localPath`）
   * @returns {void}
   */
  const measureEditBase = (asset) => {
    const p = String((asset && asset.localPath) || '');
    const seq = editBaseReqRef.current + 1;
    editBaseReqRef.current = seq;
    setEditBase(null);
    setEditBaseTip('');
    if (!p) return;
    const invoke = api && typeof api.invoke === 'function' ? api.invoke : null;
    if (!invoke) {
      // 通道缺失（老主进程 / 假 api）不是错误：不传 size 照旧出图
      setEditBaseTip('这个版本读不到图片原始尺寸，本次按上游默认尺寸出图。');
      return;
    }
    measureImageSize(invoke, p).then((dim) => {
      if (editBaseReqRef.current !== seq) return; // 期间又点了别的图，这次的结果作废
      if (!dim) {
        setEditBaseTip('没读到这张图的原始宽高，本次按上游默认尺寸出图。');
        return;
      }
      setEditBase({ path: p, w: dim.w, h: dim.h });
      setEditBaseTip('');
    }).catch(() => {
      if (editBaseReqRef.current !== seq) return;
      setEditBaseTip('没读到这张图的原始宽高，本次按上游默认尺寸出图。');
    });
  };

  /**
   * 「在这张图上继续改」：套用成参考图（**走同一个 `useAssetAs`**）+ 记住原图尺寸。
   *
   * ★ 没有另写一套套用逻辑：套用规则（互斥、上限、去重、焦点）只有 `useAssetAs`
   *   一份，这里只是"套用成功之后再量一下原图多宽"。
   *
   * @param {object} asset 作品条目 / 结果卡条目 `{localPath, bytes}`
   * @returns {void}
   */
  const continueEditOnImage = (asset) => {
    const ok = useAssetAs(asset, 'image_ref');
    if (!ok) return;
    measureEditBase(asset);
  };

  // ── 打开文件夹（缺通道时只提示）──────────────────────────────────────────
  const openFolder = async (target, reveal) => {
    const p = String(target || mediaDir || '');
    if (!p) { setMediaTip('还不知道保存目录：先点一下页面刷新。'); return; }
    if (typeof api.wanxOpenFolder !== 'function') {
      setMediaTip('打开文件夹需要更新到新版；本机路径已经写在下面，可以直接复制。');
      return;
    }
    try {
      const r = await api.wanxOpenFolder({ path: p, reveal: reveal !== false });
      if (!r || r.ok !== true) setMediaTip((r && r.error) || '打开文件夹失败');
      else setMediaTip('');
    } catch (e) {
      setMediaTip((e && e.message) || '打开文件夹失败');
    }
  };

  // ── 存到本机：签名 URL → 本机文件（★ 必须，URL 会过期）────────────────────────
  const land = async (payload) => {
    if (!payload || !payload.url) return { ok: false, error: '没有可下载的地址' };
    try {
      return await api.wanxSave(payload);
    } catch (e) {
      return { ok: false, error: (e && e.message) || '保存失败' };
    }
  };

  // ── 视频：提交 / 轮询（整段跑在后台任务里）──────────────────────────────
  /**
   * 轮询到终态（或轮询上限）。
   *
   * ★ 为什么用 `while + await sleepMs` 而不是原来的 `setInterval`：
   *   `setInterval` 的句柄必须挂在组件上（`pollTimer.current`），组件卸载时那个 cleanup
   *   会把轮询一起清掉 —— 这正是"切走就不再继续"的另一半原因。放进后台任务的 async 函数里，
   *   循环的生命周期就等于任务本身：组件卸了它照样跑完、照样落终态。
   *
   * ⚠️ 红线：`ipcRenderer.invoke` **无法被 AbortSignal 中断**。所以这里不接 signal：
   *   超时兜底（backgroundJobs 到点）只是"不再写终态"，**上游那个任务并没有被取消**。
   *   界面上因此绝不能出现"已取消"，顶多说"已放弃等待、可以再查一次"。
   *
   * @param {{taskId:string, meta:{prompt:string, params:object, mediaKinds:string[]},
   *          submitAt?:number, estimatedCost?:number, immediate?:boolean}} p
   * @returns {Promise<{ok:boolean, result?:object, error?:string}>} 与 startJob 的 taskFn 同构
   */
  const pollVideo = async (p) => {
    const taskId = String((p && p.taskId) || '');
    if (!taskId) return { ok: false, error: '没有可查询的任务号' };
    const meta = (p && p.meta) || { prompt: '', params: {}, mediaKinds: [] };
    const submitAt = Number((p && p.submitAt) || 0) || Date.now();
    // 本次**轮询**的起点。与 submitAt 分开：手动「刷新状态」时 submitAt 可能是 20 分钟前，
    // 直接拿它算 12 分钟上限会立刻判超时。
    const since = Date.now();
    /**
     * 「第一次不睡」开关。
     * ⚠️ 它必须在**每轮开头**被消费掉（`skipWait = false`），不能只写成
     *   `if (first) { first = false; await sleep; }` —— 那样第二轮 first 已经是 false，
     *   会**一次都不睡**地连着打上游（实测能在一秒内打几十次查询接口）。
     *   正确语义：只有第一轮可以免等（用户刚点「刷新状态」，要立刻看到一次结果）。
     */
    let skipWait = !!(p && p.immediate);
    /** 一次查询的循环。上限到了就如实返回，绝不静默挂着。 */
    for (;;) {
      if (!skipWait) await sleepMs(POLL_INTERVAL_MS);
      skipWait = false;
      if (Date.now() - since > POLL_LIMIT_MS) {
        return { ok: false, error: '轮询超过 12 分钟仍未结束（任务可能还在跑，可手动点「刷新状态」再查）' };
      }
      let r;
      try { r = await api.wanxQuery(taskId); } catch (e) { r = { ok: false, error: (e && e.message) || '查询失败' }; }
      if (!r || r.ok !== true) {
        // 单次查询失败**不中止轮询**：网络抖一下就放弃会让用户以为任务没了。
        setVTask((t) => (t ? Object.assign({}, t, { lastError: (r && r.error) || '查询失败' }) : t));
        continue;
      }
      const view = statusView(r.status);
      setVTask({
        taskId,
        status: r.status,
        statusText: view.text,
        done: !!r.done,
        failed: !!r.failed,
        message: r.message || '',
        videoUrl: r.videoUrl || '',
        submitAt,
        localPath: '',
      });
      if (!r.done) continue;
      if (r.failed) {
        return {
          ok: false,
          error: r.message ? '上游说这条视频失败：' + r.message : '上游说这条视频生成失败',
        };
      }
      const result = {
        taskId,
        status: r.status,
        statusText: view.text,
        done: true,
        failed: false,
        message: r.message || '',
        videoUrl: r.videoUrl || '',
        submitAt,
        localPath: '',
        bytes: 0,
        saveError: '',
        estimatedCost: (p && p.estimatedCost != null) ? p.estimatedCost : null,
        prompt: meta.prompt || '',
        params: meta.params || {},
        mediaKinds: meta.mediaKinds || [],
      };
      if (r.videoUrl) {
        // ★ 立刻存到本机：签名 URL 约 19 小时就失效
        const saved = await land(Object.assign({}, meta, {
          url: r.videoUrl,
          filename: 'video-' + taskId,
          fallbackExt: '.mp4',
          kind: 'video',
          taskId,
        }));
        if (saved && saved.ok) {
          result.localPath = saved.path || '';
          result.bytes = saved.bytes || 0;
        } else {
          result.saveError = (saved && saved.error) || '保存到本机失败';
        }
        // ★ 顺序不能反：先本地并（缩略图立刻可见），再后台对齐（loadAssets 重拉）。
        //   反了就还是"生完看不到缩略图" —— 那一次 IPC 往返期间结果区是空的。
        if (saved && saved.ok) {
          mergeShot({
            id: (saved.asset && saved.asset.id) || undefined,
            kind: 'video',
            localPath: saved.path || '',
            bytes: saved.bytes || 0,
            prompt: meta.prompt || '',
            taskId,
          });
        }
        try { await refresh(); await loadAssets(); } catch (e) { /* 刷新失败不改出片结果 */ }
      }
      return { ok: true, result };
    }
  };

  /** 当前模式的提示词（两种模式各存一份，互不覆盖）。 */
  const curPrompt = mode === 'video' ? vPrompt : iPrompt;
  /** 当前模式的负向提示词 —— 只作为"要避开的"上下文交给 AI，绝不揉进正向。 */
  const curNeg = mode === 'video' ? vNeg : iNeg;
  /** 撤销条只在**被优化的那个模式**下显示：切到另一个模式还挂着"撤销"会让人以为要撤那边。 */
  const aiUndoHere = aiUndo && aiUndo.mode === mode;

  /**
   * AI 优化提示词（老板原话「没有AI优化提示词」）。
   *
   * 三条不可动摇的行为（用例逐条钉住）：
   *   ① **失败时绝不动 textarea** —— 用户最怕的是"优化失败把原文吃了"；
   *   ② 成功才覆盖，并且同时给出「已按 AI 建议改写 · 撤销」，撤销回**原文**；
   *   ③ 只调 `chatFn`，不碰 wanx，不扣额度。
   *
   * @returns {Promise<void>}
   */
  const optimizePrompt = async () => {
    const isVideo = mode === 'video';
    const raw = String((isVideo ? vPrompt : iPrompt) || '');
    const text = raw.trim();
    if (!text) return;          // 按钮本来就是 disabled，这里再挡一次（键盘/程序触发）
    if (aiBusy) return;         // 并发双击：只允许一次在飞
    setAiErr('');
    setAiNeedConfig(false);
    setAiBusy(true);
    try {
      const neg = String((isVideo ? vNeg : iNeg) || '').trim();
      const user = (isVideo ? '【原始视频描述】\n' : '【原始画面描述】\n')
        + text
        + (neg ? ('\n\n【要避开的（不要写进正文）】\n' + neg) : '');
      const messages = [
        { role: 'system', content: isVideo ? AI_PROMPT_VIDEO : AI_PROMPT_IMAGE },
        { role: 'user', content: user },
      ];
      const r = await chatFn(messages, {
        // context 只做归属标识，不带任何产物路径（避免把本机路径发到模型侧）
        scene: isVideo ? 'videodesign-video-prompt' : 'videodesign-image-prompt',
      }, { temperature: 0.7, maxTokens: 900 });
      // ★★ 先判 ok，再谈覆盖。顺序反了就是"失败也把原文吃掉"（用例 R4 反控咬这一条）。
      if (!r || r.ok !== true) {
        const code = String((r && r.code) || '');
        if (code === 'AI_NOT_CONFIGURED') {
          setAiNeedConfig(true);
        } else {
          setAiErr(String((r && r.error) || 'AI 优化失败'));
        }
        return;
      }
      const cleaned = cleanAiPrompt(r.content);
      if (!cleaned) {
        setAiErr('AI 返回了空内容，没敢替换你的原文');
        return;
      }
      if (isVideo) setVPrompt(cleaned);
      else setIPrompt(cleaned);
      setAiUndo({ text: raw, mode: isVideo ? 'video' : 'image' });
    } catch (e) {
      // 抛错同样是"失败"：文案要说明原文没被改动
      setAiErr((e && e.message) || 'AI 优化失败');
    } finally {
      setAiBusy(false);
    }
  };

  /**
   * 撤销 AI 改写：把 textarea 恢复成点「AI 优化」之前那一份原文。
   *
   * @returns {void}
   */
  const undoAiPrompt = () => {
    if (!aiUndo) return;
    if (aiUndo.mode === 'video') setVPrompt(aiUndo.text);
    else setIPrompt(aiUndo.text);
    setAiUndo(null);
    setAiErr('');
    setAiNeedConfig(false);
  };

  const submitVideo = async () => {
    const raw = String(vPrompt || '').trim();
    if (!raw) { setVTips('请先写一句视频描述'); return; }
    if (videoJob.busy) return; // 同 key 连点：交给任务层拦，这里先挡一下免得多打一次上游
    const mediaList = [];
    // ★ 顺序 = `MEDIA_SLOT_ORDER`（也就是 `@` 提及的编号表）。两边读同一个常量，
    //   否则 `@图片2` 会指到另一条素材 —— 这种错不报错，只出一段不对的片子。
    MEDIA_SLOT_ORDER.forEach((t) => (vMedia[t] || []).forEach((f) => mediaList.push({ type: t, path: f.path })));
    // `@图片N` → `图N`：上游只认「图1/图2」这种写法（`wanxProvider.js:289-292`）。
    // ★ **只转这一次请求，不回写 state** —— 用户屏幕上必须一直是他自己写的 `@图片1`，
    //   被我们悄悄改掉的话，下次他再想改那句话就找不到自己写的东西了。
    const p = normalizeMentionPrompt(raw, mediaList.length);
    const badMentions = outOfRangeMentions(raw, mediaList.length);
    // 超范围引用：**不拦提交**，只说一句。拦住的代价是用户为了提交得先删字，
    // 而 `@` 也可能是他正常文本的一部分（邮箱/备注）—— 那不是我们该替他决定的事。
    setVTips(badMentions.length
      ? ('提示词里 ' + badMentions.join('、') + ' 没有对应素材（当前只有 ' + mediaList.length
        + ' 个），这几处原样保留了，模型可能看不懂。')
      : '');
    const params = { resolution: vRes, ratio: vRatio, duration: vDur };
    const meta = { prompt: p, params, mediaKinds: mediaList.map((m) => m.type) };
    await startJob(videoJobKey, async () => {
      let r;
      try {
        r = await api.wanxVideo({
          prompt: p,
          resolution: vRes,
          ratio: vRatio,
          duration: vDur,
          negativePrompt: vNeg || undefined,
          media: mediaList.length ? mediaList : undefined,
          audio: vAudio,
          seed: Number.isFinite(Number(vSeed)) ? Number(vSeed) : undefined,
          promptExtend: vExtend,
        });
      } catch (e) {
        return { ok: false, error: (e && e.message) || '提交失败' };
      }
      if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || '提交失败' };
      const submitAt = Date.now();
      setVTask({
        taskId: r.taskId, status: r.status, statusText: statusView(r.status).text,
        submitAt, done: false, failed: false, estimatedCost: r.estimatedCost, localPath: '',
      });
      // 额度立刻变（提交即计费，这也是「估算」而不是「结算」的原因）
      try { await refresh(); } catch (e) { /* 额度刷新失败不影响出片 */ }
      // 提交之后的等待 + 查询 + 落盘**全在这一个任务里**：组件卸载也照跑。
      return pollVideo({ taskId: r.taskId, meta, submitAt, estimatedCost: r.estimatedCost });
    }, { timeoutMs: VIDEO_JOB_TIMEOUT_MS });
  };

  /** 手动查一次（轮询超时后、或用户切回来时用）。超时后 busy 已经是 false，可以直接再起一次任务。 */
  const queryNow = async () => {
    const id = String((videoResult && videoResult.taskId) || (vTask && vTask.taskId) || '');
    if (!id) return;
    if (videoJob.busy) return;
    const prev = videoResult || {};
    const kinds = (Array.isArray(prev.mediaKinds) && prev.mediaKinds.length)
      ? prev.mediaKinds
      : ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']
        .filter((t) => (vMedia[t] || []).length);
    const meta = {
      prompt: prev.prompt || vPrompt,
      params: prev.params || { resolution: vRes, ratio: vRatio, duration: vDur },
      mediaKinds: kinds,
    };
    await startJob(videoJobKey, () => pollVideo({
      taskId: id,
      meta,
      submitAt: prev.submitAt || Date.now(),
      estimatedCost: prev.estimatedCost,
      immediate: true, // 用户主动点的「刷新状态」，立刻查一次，不再等 5 秒
    }), { timeoutMs: VIDEO_JOB_TIMEOUT_MS });
  };

  // ── 图片：生成（提交 + 落盘整段跑在后台任务里）──────────────────────────────
  /**
   * 图片生成。
   *
   * 与视频同一个病、同一个修法：`await api.wanxImage()`（后端超时 180 秒）期间组件一旦卸载，
   * 结果和错误都打在已卸载实例上 ⇒ 用户"图没了、也没提示"。
   * 现在整段（请求 + 落盘 + 刷新）都在 `startJob` 的 taskFn 里，状态写进跨卸载存活的后台任务。
   *
   * ⚠️ 红线：`ipcRenderer.invoke` **无法被 AbortSignal 中断**，所以这里连 signal 都不接。
   *   超时兜底只是"不再写终态"，上游请求仍在跑；文案里不出现"已取消"。
   */
  const genImage = async () => {
    const raw = String(iPrompt || '').trim();
    if (!raw) { setImageTip('请先写一句画面描述'); return; }
    if (imageJob.busy) return;
    const refs = (iMedia.reference_image || []).map((f) => ({ path: f.path }));
    // 与视频侧同一套：只转请求，不回写 state（屏幕上一直是用户写的 `@图片1`）
    const p = normalizeMentionPrompt(raw, refs.length);
    const badMentions = outOfRangeMentions(raw, refs.length);
    setImageTip(badMentions.length
      ? ('提示词里 ' + badMentions.join('、') + ' 没有对应素材（当前只有 ' + refs.length
        + ' 张参考图），这几处原样保留了，模型可能看不懂。')
      : '');
    // 「在这张图上继续改」⇒ 按原图尺寸再生成。
    // ★ 钳位在渲染层做完：上游对 size 是**硬校验**（总像素 512²~2048²，格式必须 `宽*高`），
    //   原图 4000×3000 直接发过去会被拒 —— 那种失败看起来像"模型坏了"，其实是参数错了。
    //   拿不到尺寸（`editBase` 为空）就不传 size，让上游用它自己的默认尺寸。
    const size = editBase ? clampImageSize(editBase.w, editBase.h) : '';
    await startJob(imageJobKey, async () => {
      try {
        const r = await api.wanxImage({
          prompt: p,
          negativePrompt: iNeg || undefined,
          promptExtend: iExtend,
          refImages: refs.length ? refs : undefined,
          seed: Number.isFinite(Number(iSeed)) ? Number(iSeed) : undefined,
          size: size || undefined,
        });
        if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || '生成失败' };
        // 落盘阶段：只为了让文案从"正在生成"变成"正在存到本机"，失败也不改变结果
        setLandPhase('land');
        // ★ 图片同理：签名 URL 落本机才算真的拿到
        const saved = await land({
          url: r.imageUrl,
          filename: 'image-' + Date.now(),
          fallbackExt: '.png',
          kind: 'image',
          prompt: p,
          params: { promptExtend: iExtend, refCount: refs.length, size: size || '' },
          mediaKinds: refs.length ? ['reference_image'] : [],
        });
        const savedOk = !!(saved && saved.ok);
        const result = {
          imageUrl: r.imageUrl || '',
          localPath: savedOk ? (saved.path || '') : '',
          bytes: savedOk ? (saved.bytes || 0) : 0,
          saveError: savedOk ? '' : ((saved && saved.error) || '保存到本机失败'),
          estimatedCost: r.estimatedCost,
          usage: r.usage,
          prompt: p,
        };
        // ★ 与视频同理：落盘即并进作品库 + 本次生成带，不等一次完整重拉。
        if (savedOk) {
          mergeShot({
            id: (saved.asset && saved.asset.id) || undefined,
            kind: 'image',
            localPath: saved.path || '',
            bytes: saved.bytes || 0,
            prompt: p,
          });
        }
        try { await refresh(); await loadAssets(); } catch (e) { /* 刷新失败不改结果 */ }
        // ⚠️ result 必须**非 null**：`startJob` 判成功的条件是
        //    `r.ok === true && (result 非空 或 content 非空)`，只返回 `{ ok:true }` 会被记成失败。
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: (e && e.message) || '生成失败' };
      } finally {
        setLandPhase('');
      }
    }, { timeoutMs: IMAGE_JOB_TIMEOUT_MS });
  };

  // ── 作品库 → 二次修改 ───────────────────────────────────────────────────
  /**
   * 把一件历史作品塞进当前表单。
   *
   * @param {object} asset 作品库条目（本地绝对路径）
   * @param {'image_ref'|'video_first'|'video_ref'} target
   * @returns {boolean} 这件作品**现在是不是已经在目标槽位里**（本来就在也算 true）。
   *   返回值只给「在这张图上继续改」用：它要判断"套用成功了没有"，成功了才去量原图尺寸。
   *   老调用点（结果卡 / 灯箱 / 作品库）忽略返回值，行为一个字没变。
   */
  const useAssetAs = (asset, target) => {
    const f = asFile({ path: asset && asset.localPath, name: baseName(asset && asset.localPath), bytes: asset && asset.bytes });
    if (!f) { setMediaTip('这件作品没有本机文件，没法接着改。'); return false; }
    // 槽位被手动换掉了 ⇒ 上一张图的「原图尺寸」不再成立
    setEditBase(null);
    setEditBaseTip('');
    if (target === 'image_ref') {
      setMode('image');
      const cur = iMedia.reference_image || [];
      if (cur.some((x) => x.path === f.path)) { focusPrompt(); return true; }
      if (cur.length >= maxImageRefImages) {
        setMediaTip('参考图最多 ' + maxImageRefImages + ' 张，先删一张。');
        return false;
      }
      setIMedia(Object.assign({}, iMedia, { reference_image: cur.concat([f]) }));
      focusPrompt();
      return true;
    }
    setMode('video');
    if (target === 'video_first') {
      setVMedia(Object.assign({}, vMedia, {
        first_frame: [f],
        reference_image: [],
        reference_video: [],
        reference_audio: [],
      }));
      if (refsUsed > 0) setMediaTip('已切到首尾帧模式，原来的参考素材已清空。');
      focusPrompt();
      return true;
    }
    const cur = vMedia.reference_video || [];
    if (cur.some((x) => x.path === f.path)) { focusPrompt(); return true; }
    if (cur.length >= maxRefVideos) {
      setMediaTip('参考视频最多 ' + maxRefVideos + ' 段，先删一段。');
      return false;
    }
    setVMedia(Object.assign({}, vMedia, {
      first_frame: [],
      last_frame: [],
      reference_video: cur.concat([f]),
    }));
    if (framesUsed > 0) setMediaTip('已切到参考素材模式，原来的首帧/尾帧已清空。');
    focusPrompt();
    return true;
  };

  // ── 灯箱（点缩略图看大图 / 播视频）──────────────────────────────────────
  /**
   * 打开灯箱。
   *
   * `items` 传**当时那一批**（作品库是筛选后的结果、本次生成带是会话内的结果），
   * 这样左右切换只在用户看得见的那批里循环 —— 切到被筛掉的东西上会让人莫名其妙。
   *
   * @param {Array<object>} items 这一批条目
   * @param {number} index 点在谁身上（下标越界一律夹到合法范围，不抛）
   * @returns {void}
   */
  const openLightbox = useCallback((items, index) => {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
    setLightbox({ items: list, index: i });
  }, []);

  const closeLightbox = useCallback(() => setLightbox(null), []);

  /** 左右切换（**循环**：最后一件的下一件是第一件 —— 即梦也是这样）。 */
  const stepLightbox = useCallback((delta) => {
    setLightbox((cur) => {
      if (!cur || !Array.isArray(cur.items) || !cur.items.length) return cur;
      const n = cur.items.length;
      if (n <= 1) return cur;
      const d = Number(delta) || 0;
      return Object.assign({}, cur, { index: ((Number(cur.index) || 0) + d + n) % n });
    });
  }, []);

  // ── 单价 / 总额度保存 ───────────────────────────────────────────────────
  const openBudgetEdit = () => {
    const b = budget || {};
    const pr = (b.prices) || {};
    setPrefsDraft({
      totalBudget: b.totalBudget || 300,
      video480: (pr.video && pr.video['480P']) != null ? pr.video['480P'] : '',
      video720: (pr.video && pr.video['720P']) != null ? pr.video['720P'] : '',
      video1080: (pr.video && pr.video['1080P']) != null ? pr.video['1080P'] : '',
      image: (pr.image && pr.image.default) != null ? pr.image.default : '',
    });
    setPrefsMsg('');
    setBudgetEdit(true);
  };

  const saveBudgetEdit = async () => {
    const d = prefsDraft || {};
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
    const patch = {
      totalBudget: num(d.totalBudget),
      prices: {
        video: {
          '480P': num(d.video480), '720P': num(d.video720), '1080P': num(d.video1080),
        },
        image: { default: num(d.image) },
      },
    };
    // 未填的不传（savePrefs 是深合并，传 undefined 会被忽略，不会把已有值抹掉）
    Object.keys(patch.prices.video).forEach((k) => {
      if (patch.prices.video[k] === undefined) delete patch.prices.video[k];
    });
    if (patch.prices.image.default === undefined) delete patch.prices.image.default;
    try {
      const r = await api.wanxSavePrefs(patch);
      if (r && r.ok) { setPrefsMsg('已保存'); setBudgetEdit(false); await refresh(); }
      else setPrefsMsg((r && r.error) || '保存失败');
    } catch (e) {
      setPrefsMsg((e && e.message) || '保存失败');
    }
  };

  // ── 渲染：档位（未验证的挂标记）───────────────────────────────────────────
  const opts = (status && status.options) || {};
  const withFlag = (list) => (list || []).map((x) => ({
    value: x.value,
    label: x.label + (x.verified ? '' : '（未验证）'),
  }));
  const resOpts = withFlag(opts.resolutions);
  const ratioOpts = withFlag(opts.ratios);
  const durOpts = (opts.durations && opts.durations.length)
    ? withFlag(opts.durations)
    : (() => {
      // 主进程还没给 durations 时兜底成 2..30 + 智能时长（契约里就是这么写的）
      const list = [{ value: -1, label: '智能时长（未验证）' }];
      for (let s = 2; s <= 30; s += 1) list.push({ value: s, label: s + ' 秒（未验证）' });
      return list;
    })();

  // ── 「已等待 N 秒」（两边都有，起点取后台任务的 startedAt）────────────────────
  //
  // ★ 为什么起点不是 `vTask.submitAt` / 组件里的某个时间戳：那些值随组件卸载一起消失，
  //   用户切走再回来秒数会**归零**，看起来像刚点过 —— 而他其实已经等了两分钟。
  //   `job.startedAt` 存在模块级 store 里，跨卸载存活，所以秒数会接着往前走。
  const imageElapsed = imageJob.busy && imageJob.startedAt
    ? Math.max(0, Math.floor((Date.now() - imageJob.startedAt) / 1000))
    : 0;
  /**
   * 图片阶段：**只影响文案**，不影响结果 ⇒ 允许是组件局部 state（`landPhase`）。
   * 不在生成中一律 'idle'（QA 靠 `data-vd-image-phase` 读它）。
   */
  const imagePhase = !imageJob.busy
    ? 'idle'
    : (landPhase === 'land' ? 'land' : (imageElapsed < 3 ? 'submit' : 'gen'));
  /**
   * 图片进度文案。
   *
   * ★ **分母必须写进文案**（老板「没有百分比」，但这个百分比是我们按典型耗时估的，
   *   不是上游给的）。只给一条没解释的条，用户看不懂"为什么卡在 88" ——
   *   那就等于把"没有百分比"换成了"有个看不懂的百分比"。
   *   秒数照旧保留（来自后台任务 startedAt，跨卸载存活）。
   */
  let imagePhaseText = '';
  if (imagePhase === 'land') {
    imagePhaseText = '图片出来了，正在存到本机…';
  } else if (imagePhase === 'submit') {
    imagePhaseText = '正在提交给通义万象（按通常 20~60 秒估）…';
  } else if (imageElapsed > IMAGE_PROGRESS_DENOM_S) {
    imagePhaseText = '比通常慢，仍在生成（按通常 20~60 秒估，已等 ' + imageElapsed + ' 秒）';
  } else {
    imagePhaseText = '正在生成，按通常 20~60 秒估（已等 ' + imageElapsed + ' 秒）';
  }
  /** 图片百分比（纯函数算，渲染只消费结果；不可信时 null ⇒ 不画条）。 */
  const imagePct = imageProgressPct({
    busy: imageJob.busy,
    phase: imagePhase,
    elapsed: imageElapsed,
    result: imageResult,
  });
  /** 图片结果区是否需要渲染"有内容"的外壳（没有内容时容器照样在，只是不带卡片样式）。 */
  const imageBodyVisible = !!(imageJob.busy || imageJob.error || imageResult);

  const videoElapsed = videoJob.busy && videoJob.startedAt
    ? Math.max(0, Math.floor((Date.now() - videoJob.startedAt) / 1000))
    : 0;
  /**
   * 视频展示用的合并视图：**进行中**的进度来自局部 `vTask`（statusText / task_id / lastError），
   * **终态**一律来自后台任务 `videoResult`。后者跨卸载存活，所以"切回来还有"。
   */
  const vState = videoResult
    ? Object.assign({}, vTask || {}, videoResult, { done: true })
    : (vTask || null);
  // tick 只是触发器：让 imageElapsed / videoElapsed 每秒重算一次
  void tick;

  /**
   * 视频百分比。
   * ★ 数据源必须与卡片上的状态**同源**（`vState.status`），否则会出现
   *   "标签写生成中、条还停在排队"这种自相矛盾的画面。
   * ★ `vState` 为 null（一次都没提交过 / 首帧还没查到状态）⇒ pct 为 null ⇒ 不画条。
   */
  const videoPct = videoProgressPct({
    busy: videoJob.busy,
    elapsed: videoElapsed,
    status: (vState && vState.status) || '',
    result: videoResult,
  });

  /**
   * 视频进度文案。**分母写进文案**（480P/5 秒实测 2 分 17 秒，见文件头实测事实 ①）。
   * 三档分开写是为了让用户知道"现在卡在排队还是卡在生成" —— 这两件事该做的动作完全不同
   * （排队只能等，生成超时可以去点「刷新状态」）。
   */
  const vStatusUpper = String((vState && vState.status) || '').toUpperCase();
  const VIDEO_DENOM_NOTE = '按 480P/5 秒实测约 2 分 17 秒估';
  let videoPhaseText = '已提交，正在出片（' + VIDEO_DENOM_NOTE + '）';
  if (vStatusUpper === 'PENDING') videoPhaseText = '已提交，在排队（' + VIDEO_DENOM_NOTE + '）';
  else if (vStatusUpper === 'RUNNING') videoPhaseText = '正在出片（' + VIDEO_DENOM_NOTE + '）';
  else if (vStatusUpper === 'SUCCEEDED') videoPhaseText = '片出来了，正在存到本机…';

  /**
   * 进度条 = 一条细轨 + 一个**看得见的百分比数字**（复用 `.vd-bar > i` 的既有样式，不新造一套）。
   *
   * `pct === null` ⇒ 返回 null，**不渲染**。这一条是刻意的：
   *   拿不到可信数字时画一条 0% 的空条，用户会以为"任务卡住了"；
   *   画一条满的，用户会以为"生成完了只是没显示"。两种都比没有条更误导。
   *
   * 0.21.25 修复（老板原话「图像视频生成没有生成的百分比进度条」）：
   *   百分比以前只写进了 `aria-valuenow` / `data-vd-progress-pct` —— **页面上一个字都没有**，
   *   4px 的深绿填充压在浅灰底上也几乎看不出在动。现在外面包一层 `.vd-pct`，
   *   右侧跟一个 `.vd-pct-num` 显示 `"37%"`，用户能直接读到数字。
   *
   * 属性位置是**契约**，别随手挪：
   *   · `data-vd-progress-pct` 留在 `.vd-bar` 上（既有读取方按这个位置找）；
   *   · `data-vd-progress-kind` **`.vd-bar` 与 wrapper 上都写**：
   *     `scripts/smoke/cases/videodesign-progress-ai.jsx:293,370` 用的是**同一元素**复合选择器
   *     `[data-vd-progress-pct][data-vd-progress-kind="image"]`，只挪到 wrapper 会当场找不到元素。
   *   · 数字上 `aria-hidden="true"`：`role="progressbar"` 已经有 `aria-valuenow`，重复朗读没意义。
   *
   * @param {number|null} pct 0~100
   * @param {string} kind `'image'|'video'`（只用于读数/诊断，不影响样式）
   * @returns {any} React 节点或 null
   */
  const renderPctBar = (pct, kind) => {
    if (pct === null || pct === undefined) return null;
    const n = Number(pct);
    if (!Number.isFinite(n)) return null;
    const v = Math.max(0, Math.min(100, Math.round(n)));
    return (
      <div className="vd-pct" data-vd-progress-kind={kind}>
        <div
          className="vd-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={v}
          data-vd-progress-pct={v}
          data-vd-progress-kind={kind}
        >
          <i style={{ width: v + '%' }} />
        </div>
        <span className="vd-pct-num" data-vd-progress-num={v} aria-hidden="true">
          {v}%
        </span>
      </div>
    );
  };

  const b = budget || {};
  const spendPct = b.totalBudget > 0 ? Math.min(100, Math.round((Number(b.spent) || 0) / b.totalBudget * 100)) : 0;

  /**
   * 单条视频 / 单张图片的估算成本，按官方计费方式算：
   *   · 视频 = 每秒单价 × 时长（官方按成功生成的**秒数**计费，不是按条）
   *   · 图片 = 每张单价
   * 取不到就 null，界面上显示 `—`，绝不用 0 顶（0 会被读成免费）。
   */
  const vPerSec = b.prices && b.prices.video ? Number(b.prices.video[vRes]) : NaN;
  const durNum = Number(vDur);
  const vCost = Number.isFinite(vPerSec) && Number.isFinite(durNum) && durNum > 0
    ? Math.round(vPerSec * durNum * 100) / 100
    : null;
  const iCost = b.prices && b.prices.image ? Number(b.prices.image.default) : NaN;
  const remaining = Number(b.remaining);
  // 「照这个档位还能出多少次」—— 比「还剩 180 元」有用得多，老板要的是数量
  const vCapacity = vCost > 0 && Number.isFinite(remaining) ? Math.floor(remaining / vCost) : null;
  const iCapacity = iCost > 0 && Number.isFinite(remaining) ? Math.floor(remaining / iCost) : null;

  const ledgerCols = [
    {
      title: '时间', dataIndex: 'ts', width: 110,
      render: (v) => (v ? String(v).replace('T', ' ').slice(5, 16) : '—'),
    },
    {
      title: '类型', dataIndex: 'kind', width: 88,
      // `video_refund` = 任务失败后的冲正记录（负数金额）。它必须单独显示，
      // 否则用户看到一正一负两笔会以为「怎么重复扣钱了」。
      render: (v) => {
        if (v === 'video') return <Tag color="purple">视频</Tag>;
        if (v === 'video_refund') return <Tag color="green">失败冲正</Tag>;
        // 按上游真实秒数校正的差额记录（实测 usage.output_video_duration）
        if (v === 'video_adjust') return <Tag color="gold">用量校正</Tag>;
        return <Tag color="cyan">图片</Tag>;
      },
    },
    {
      title: '参数', width: 150,
      render: (_v, r) => {
        const p = r.params || {};
        if (r.kind === 'video') return [p.resolution, p.duration ? p.duration + 's' : '', p.ratio].filter(Boolean).join(' / ') || '—';
        return p.promptExtend === false ? '关闭提示词扩写' : '默认';
      },
    },
    {
      title: '估算', dataIndex: 'estimatedCost', width: 100,
      render: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return '—';
        // 负数 = 冲正，写成「¥3.00 退回」比「¥-3.00」好读
        if (n < 0) return <span className="vd-refund">{money(Math.abs(n))} 退回</span>;
        return money(n);
      },
    },
    {
      title: '描述（前 30 字）', dataIndex: 'prompt',
      render: (v) => (v ? String(v).slice(0, 30) : '—'),
    },
  ];

  // ── 渲染：素材槽位 ──────────────────────────────────────────────────────
  const renderSlot = (k) => {
    const spec = slotSpec(k);
    const list = mediaOf(k);
    // 互斥只对视频模式成立：图片模式没有首尾帧，不该被视频模式里剩下的帧锁住
    const locked = mode === 'video'
      && ((spec.group === 'frame' && frameLocked) || (spec.group === 'ref' && refLocked));
    const full = list.length >= spec.max;
    return (
      <div
        className={'vd-slot' + (locked ? ' is-locked' : '')}
        key={k}
        data-vd-slot={k}
        data-vd-disabled={locked ? '1' : '0'}
      >
        <div className="vd-slot-head">
          <span className="vd-slot-name">{spec.name}</span>
          <span className="vd-slot-cap">{list.length}/{spec.max}</span>
        </div>
        <div className="vd-thumbs">
          {list.map((f, i) => (
            <div className="vd-thumb" key={f.path + '-' + i} data-vd-thumb={k + '-' + i}>
              {spec.kind === 'image' ? (
                mediaUrlOf(f.thumbPath || f.path, mediaDir)
                  ? <img className="vd-thumb-img" src={mediaUrlOf(f.thumbPath || f.path, mediaDir)} alt="" />
                  // 取不到受限地址时不渲染 <img>（src="" 会朝当前页发一次请求，看着更像坏了）
                  : <span className="vd-thumb-icon" title={f.name}>图</span>
              ) : (
                <span className="vd-thumb-icon">{spec.kind === 'video' ? '视频' : '音频'}</span>
              )}
              {/* 参考图统一挂「图N」角标：提示词里的 图1/图2 就是照它对号入座的 */}
              {k === 'reference_image' || spec.max > 1 ? (
                <span className="vd-thumb-tag">{k === 'reference_image' ? '图' + (i + 1) : String(i + 1)}</span>
              ) : null}
              <button
                type="button"
                className="vd-thumb-del"
                title="移除"
                onClick={() => removeFromSlot(k, i)}
              >×</button>
            </div>
          ))}
          {!full ? (
            <div
              className={'vd-add' + (locked ? ' is-locked' : '')}
              role="button"
              tabIndex={locked ? -1 : 0}
              aria-disabled={locked ? 'true' : 'false'}
              title={locked ? EXCLUSIVE_NOTE : '点击选择本机文件'}
              onClick={() => { if (!locked) addToSlot(k); }}
              onKeyDown={(e) => {
                if (locked) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addToSlot(k); }
              }}
            >
              <span className="vd-add-plus">＋</span>
              <span className="vd-add-name">{locked ? '已锁定' : spec.name}</span>
            </div>
          ) : null}
        </div>
        {k === 'reference_video' ? <span className="vd-slot-hint">单段 ≤15 秒</span> : null}
      </div>
    );
  };

  const refChips = (mode === 'video' ? vMedia.reference_image : iMedia.reference_image) || [];
  /**
   * 作品库条目。
   *
   * ★ 2026-10-21 修：这里原来是 `.filter((a) => a && a.localPath)` ——
   *   本机文件已丢失的作品会被**从作品库里静默抹掉**。而"文件丢了"恰恰是最常见的现场：
   *   用户把「视频设计」文件夹挪走 / 清理磁盘 / 换机器。结果是他之前生成的东西
   *   凭空消失，页面只写「共 N 件」，既不解释也没法处理 ——
   *   这正是老板第 ③ 条「做好的图视频在哪里也没有告知」的同一类病。
   *   附带后果：`useAssetAs` 里那句「这件作品没有本机文件，没法接着改。」
   *   成了**永远走不到的死代码**（UI 筛掉了所有会触发它的条目）。
   *
   *   现在全部保留，渲染时用 `data-vd-nofile` 标出哪些没有本机文件，
   *   并显式说明"为什么不能改"，而不是让它消失。
   *
   * ★ 2026-10-24 再往前一步（老板「之前生的图可以看到 并不是再次打开后就没有了」）：
   *   ① 三态判定改成 `assetHasFile()`：`有文件` / `有记录但文件不在` / `连记录都没有`。
   *      旧代码 `!!a.localPath` 会把"路径还在、文件已被删"当成有文件 ⇒ `<video>` 一片黑。
   *   ② 加工作栏（筛选 全部/图片/视频 + 按描述或文件名搜索），过滤是**纯前端**的，
   *      「共 N 件」说的是筛完之后的数量（`data-vd-lib-count`），总数另有一处说明。
   *   ③ 每张卡片的媒体区可点开灯箱 —— 旧代码只能「打开文件夹」，等于让人自己去翻磁盘。
   */
  const allLibItems = (assets || []).filter((a) => a && (a.localPath || a.id || a.prompt));

  /**
   * 工作栏过滤后的条目（**纯前端**；主进程只管给出全部记录，不管筛选）。
   * 搜索覆盖「描述 + 文件名」：老板记不住描述时往往是靠文件名找的。
   * @type {Array<object>}
   */
  const libItems = useMemo(() => {
    const q = String(libQuery || '').trim().toLowerCase();
    return allLibItems.filter((a) => {
      if (libFilter === 'image' && a.kind === 'video') return false;
      if (libFilter === 'video' && a.kind !== 'video') return false;
      if (!q) return true;
      const hay = (String(a.prompt || '') + ' ' + baseName(a.localPath || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    // allLibItems 每次渲染都是新数组，所以依赖写 `assets`（真源）而不是它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, libFilter, libQuery]);

  /** 作品库里「有记录但本机文件已不在」的条数（前端自己数一遍，胜过只信主进程一个数）。 */
  const libMissingCount = allLibItems.filter((a) => !assetHasFile(a)).length;

  /**
   * 渲染：本次生成的缩略图带。
   *
   * 为什么要有它：结果区原来只有「最后那一条」的大图/大播放器，同一任务连出几条时
   * 前面的当场就看不见了（老板「生完之后看不到缩略图」）。这条带子按会话累积，
   * 点任意一张进灯箱。它**不依赖** `wanxAssets` 重拉，所以生成成功的瞬间就有。
   *
   * @returns {React.ReactElement|null}
   */
  const renderSessionStrip = () => {
    if (!sessionShots || !sessionShots.length) return null;
    return (
      <div className="vd-strip" data-vd-strip>
        <div className="vd-strip-head">
          <span className="vd-strip-title">本次生成</span>
          <span className="vd-hint">共 {sessionShots.length} 件 · 点缩略图看大图 / 播视频</span>
        </div>
        <div className="vd-strip-items">
          {sessionShots.map((s, si) => {
            const ok = assetHasFile(s);
            const key = s.id || s.localPath || ('shot-' + si);
            const src = ok ? mediaUrlOf(s.localPath, mediaDir) : '';
            return (
              <div
                className={'vd-shot' + (ok ? '' : ' is-lost')}
                key={key}
                data-vd-shot={key}
                data-vd-shot-kind={s.kind === 'video' ? 'video' : 'image'}
                data-vd-shot-nofile={ok ? '0' : '1'}
                role="button"
                tabIndex={0}
                aria-label={'查看第 ' + (si + 1) + ' 件（' + kindText(s) + '）'}
                onClick={() => openLightbox(sessionShots, si)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(sessionShots, si); }
                }}
              >
                <div className="vd-shot-media">
                  {!ok ? (
                    <span className="vd-thumb-icon">文件不在</span>
                  ) : s.kind === 'video' ? (
                    <>
                      <video className="vd-shot-video" src={src || undefined} muted preload="metadata" />
                      {/* 播放角标：不加的话"这张静止图到底是图还是视频"完全看不出来 */}
                      <span className="vd-play-badge" aria-hidden="true">▶</span>
                    </>
                  ) : (
                    <img className="vd-shot-img" src={src || undefined} alt="" loading="lazy" />
                  )}
                </div>
                <span className="vd-shot-name">{baseName(s.localPath) || kindText(s)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── 渲染：结果卡 ────────────────────────────────────────────────────────
  const renderVideoResult = () => {
    /**
     * 数据来源只有 `vState`（= 进行中的 vTask ⊕ 终态 videoResult）。
     * 旧版这里读的是组件局部 `vTask` —— 切走卸载就没了，正是用户报的那半个 bug。
     */
    const v = vState;
    if (!v) return null;
    /**
     * 任务已经落成"失败"（没有 result、也不在跑、但有 error）时，卡片上的 Tag
     * 不能再显示**最后一次轮询**看到的状态（那会是「排队中」/「生成中」）——
     * 用户会看到上面红字说失败、下面标签说生成中，两句话打架。
     * 这一档保留整张卡（而不是干脆不渲染），因为「刷新状态」按钮就在这里，
     * 超时文案里那句「点刷新状态能再查」必须点得到。
     */
    const settledFailed = !videoResult && !videoJob.busy && !!videoJob.error;
    const view = settledFailed ? { color: 'red', text: '失败' } : statusView(v.status);
    const tagText = settledFailed ? '失败' : (v.statusText || view.text);
    const done = !!v.done && !settledFailed;
    return (
      <div className="vd-result" data-vd-task={v.taskId} data-vd-video-done={done ? '1' : '0'} data-vd-video-progress-pct={videoPct === null ? '' : String(videoPct)}>
        <div className="vd-result-head">
          <Tag color={view.color}>{tagText}</Tag>
          <code className="vd-mono">{v.taskId}</code>
          {/* 「已等待」只在**真的在跑**时显示：任务已经结束（失败/超时）还挂着
              「已等待 0 秒…」等于告诉用户「还在等」，那是假进度。 */}
          {!done && videoJob.busy ? <span className="vd-hint">已等待 {videoElapsed} 秒…</span> : null}
          <Button size="small" onClick={queryNow}>刷新状态</Button>
        </div>
        {/* 视频进度条：排队/生成/落盘各有区间；失败或超时是 null ⇒ 不画条（绝不给假 100）。 */}
        {renderPctBar(videoPct, 'video')}
        {!done && videoJob.busy ? (
          <div className="vd-progress">
            <span className="vd-progress-text">{videoPhaseText}</span>
          </div>
        ) : null}
        {v.lastError ? <div className="vd-warn">上一次查询失败：{v.lastError}（仍在继续重试）</div> : null}
        {v.message ? <div className="vd-warn">上游说明：{v.message}</div> : null}
        {v.localPath ? (
          <div className="vd-file">
            <span>已存到本机：</span>
            <code>{v.localPath}</code>
            {sizeText(v.bytes) ? <span className="vd-hint">（{sizeText(v.bytes)}）</span> : null}
          </div>
        ) : null}
        {v.saveError ? (
          <Alert
            type="warning"
            showIcon
            message={'保存到本机失败：' + v.saveError + ' —— 片已生成，但只在临时链接上，链接约 19 小时过期'}
          />
        ) : null}
        {v.videoUrl && !v.localPath ? (
          <div className="vd-warn">
            远端地址会过期（约 19 小时），别直接拿去用：
            <a href={v.videoUrl} target="_blank" rel="noreferrer">打开</a>
          </div>
        ) : null}
        {v.localPath ? (
          <video className="vd-video" src={mediaUrlOf(v.localPath, mediaDir) || undefined} controls />
        ) : null}
        {v.localPath ? (
          <div className="vd-acts">
            <Button size="small" onClick={() => openFolder(v.localPath, true)}>打开文件夹</Button>
            <Button size="small" onClick={() => useAssetAs({ localPath: v.localPath, bytes: v.bytes }, 'video_ref')}>
              用作参考视频
            </Button>
            <span className="vd-hint">参考视频单段 ≤15 秒</span>
          </div>
        ) : null}
      </div>
    );
  };

  /**
   * 图片结果卡。数据源是**后台任务的 result**（`imageJob.result`），不是组件局部 state ——
   * 这是"切走再回来图还在"的关键。
   */
  const renderImageResult = () => {
    const r = imageResult;
    if (!r) return null;
    return (
      <div className="vd-result" data-vd-image-card>
        {r.localPath ? (
          <div className="vd-file">
            <span>已存到本机：</span>
            <code>{r.localPath}</code>
            {sizeText(r.bytes) ? <span className="vd-hint">（{sizeText(r.bytes)}）</span> : null}
          </div>
        ) : null}
        {r.saveError ? (
          <Alert
            type="warning"
            showIcon
            message={'保存到本机失败：' + r.saveError + ' —— 图已生成，但只在临时链接上，链接约 19 小时过期'}
          />
        ) : null}
        <img className="vd-img" alt="生成结果" src={mediaUrlOf(r.localPath, mediaDir) || r.imageUrl || undefined} />
        {r.localPath ? (
          <div className="vd-acts">
            <Button size="small" onClick={() => openFolder(r.localPath, true)}>打开文件夹</Button>
            {/* 「以此图再改」文案没动（既有入口），但改走 `continueEditOnImage`：
                顺带记住原图宽高，下一张就按原图尺寸出。 */}
            <Button size="small" onClick={() => continueEditOnImage({ localPath: r.localPath, bytes: r.bytes })}>
              以此图再改
            </Button>
            <Button size="small" onClick={() => useAssetAs({ localPath: r.localPath, bytes: r.bytes }, 'video_first')}>
              以此作首帧
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  // ── 模式切换器（**只有一份**）────────────────────────────────────────────
  //
  // 视频 / 图片两个 return 与下面的海报 return 共用这一个变量。
  // 早期写法是在 JSX 里就地写 `<Segmented …/>`，加第三态时最省事的做法是
  // 「再复制一份、只多一个 option」—— 那就是典型的「改一处忘一处」：
  // 以后加第四态 / 改标签文案，两份必然分叉，而两份都能跑、都不会报错。
  //
  // `data-vd-mode` 挂在 Segmented **自身**（antd 会把未识别的 props 透到根 div），
  // 不另加一层 wrapper —— 外层 `.vd-head` 是 flex，多一层 div 会改变 `flex: 0 0 auto` 的生效对象，
  // 属于"为了加测试锚点顺手改了版式"，不干。
  const modeSwitch = (
    <Segmented
      className="vd-mode"
      data-vd-mode={mode}
      value={mode}
      onChange={(v) => setMode(v)}
      options={[
        { label: '视频', value: 'video' },
        { label: '图片', value: 'image' },
        { label: '海报', value: 'poster' },
      ]}
    />
  );

  //
  // ── 第三态：海报（early return）─────────────────────────────────────────
  //
  // 【为什么在这里 early return，而不是去改下面三十多处 `mode === 'video' ? A : B`】
  //   这一页的视频 / 图片两态是"同一个表单换字段"，三十多处三元分支是那个设计的
  //   合理产物。但海报是**另一套东西**：三栏布局、自己的 state、自己的 canvas、
  //   自己的导出通道，与"提示词 + 档位 + 素材槽"没有任何共用字段。
  //   把每一处三元都改成三分支，等于让海报的空壳跟着视频表单一起渲染一遍
  //   （空素材槽、空额度、空账本），既浪费又容易在对不上的分支里崩。
  //
  //   所以取最小改法：**所有 hooks / useMemo / useCallback 都跑完之后**（不能在中间
  //   return —— hooks 数量会随模式变化，React 直接报 "Rendered fewer hooks"），
  //   在这里分叉。视频 / 图片两条路的代码一行没动，回归风险接近 0。
  //   代价是切到海报时上方那些 fetch（status / ledger / assets）仍然会跑一次 ——
  //   它们本来就挂在挂载时，与模式无关，可以接受。
  //
  if (mode === 'poster') {
    return (
      <div className="vd-page">
        <div className="vd-head">
          <div className="vd-head-main">
            <h2 className="vd-title">视频设计</h2>
            <p className="vd-sub">一句话出图出视频，或者直接套模板做一张海报</p>
          </div>
          {modeSwitch}
        </div>
        <PosterStudio mediaDir={mediaDirText} />
      </div>
    );
  }

  return (
    <div className="vd-page">
      <div className="vd-head">
        <div className="vd-head-main">
          <h2 className="vd-title">视频设计</h2>
          <p className="vd-sub">
            通义万象 3.0 · 一句话出视频 / 出图，改图改片都在这一页
          </p>
        </div>
        {modeSwitch}
        <div className="vd-budget" data-vd-budget>
          <div className="vd-budget-row">
            <span className="vd-budget-label">已用（估算）</span>
            <span className="vd-budget-val vd-spent">{money(b.spent)}</span>
          </div>
          <div className="vd-budget-row">
            <span className="vd-budget-label">剩余（估算）</span>
            <span className="vd-budget-val vd-left" data-vd-remaining={b.remaining}>
              {money(b.remaining)}
            </span>
          </div>
          <div className="vd-bar"><i style={{ width: spendPct + '%' }} /></div>
          {/* 【2026-10-21 核对过官方定价页】这句话必须出现在**不展开**的状态下：
              用户看到「480P 0.3 元」很容易当成一条视频三毛，而实际是按秒，5 秒就是 1.5 元。
              这个差别 5～30 倍，藏进设置面板里等于误导。 */}
          <div className="vd-fine">
            计费方式：视频按成功生成的<strong>秒数</strong>计价，图片按张；<strong>失败不计费</strong>。
          </div>
          <button type="button" className="vd-link" onClick={budgetEdit ? () => setBudgetEdit(false) : openBudgetEdit}>
            {budgetEdit ? '收起' : '改单价'}
          </button>
        </div>
      </div>

      {/* 常驻：作品存在哪。老板原话「做好的图视频在哪里也没有告知」 */}
      <div className="vd-dirbar" data-vd-mediadir>
        <span className="vd-dirbar-label">所有作品默认存在</span>
        <code className="vd-dirbar-path">{mediaDirText}</code>
        <Button size="small" onClick={() => openFolder('', false)}>打开文件夹</Button>
      </div>

      {loadErr ? <Alert type="error" showIcon message={'读取配置失败：' + loadErr} /> : null}
      {mediaTip ? <div className="vd-warn vd-tip" data-vd-tip>{mediaTip}</div> : null}

      {/* key 已经不在这页了：没配时只留一句提示 + 一个去设置的入口 */}
      {status && !hasKey ? (
        <div className="vd-keynote" data-vd-key-missing>
          <span>还没配置通义万象的 key。key 在「设置」里填，这一页不显示也不保存。</span>
          {typeof onOpenSettings === 'function' ? (
            <Button size="small" type="primary" onClick={() => onOpenSettings()}>去设置里配置</Button>
          ) : (
            <span className="vd-hint">去「设置」填好 key 再回来刷新这一页。</span>
          )}
        </div>
      ) : null}

      {budgetEdit ? (
        <div className="vd-panel">
          <div className="vd-panel-title">
            单价与总额度
            <span className="vd-hint">改完以后页面所有金额都按新单价重算。单价来自你的控制台，不是我们定的。</span>
          </div>
          <div className="vd-grid4">
            <label className="vd-field">
              <span>总额度（元）</span>
              <InputNumber min={0} value={prefsDraft && prefsDraft.totalBudget}
                onChange={(v) => setPrefsDraft(Object.assign({}, prefsDraft, { totalBudget: v }))} />
            </label>
            <label className="vd-field">
              <span>视频 480P（元/秒）</span>
              <InputNumber min={0} step={0.1} value={prefsDraft && prefsDraft.video480}
                onChange={(v) => setPrefsDraft(Object.assign({}, prefsDraft, { video480: v }))} />
            </label>
            <label className="vd-field">
              <span>视频 720P（元/秒）</span>
              <InputNumber min={0} step={0.1} value={prefsDraft && prefsDraft.video720}
                onChange={(v) => setPrefsDraft(Object.assign({}, prefsDraft, { video720: v }))} />
            </label>
            <label className="vd-field">
              <span>视频 1080P（元/秒）</span>
              <InputNumber min={0} step={0.1} value={prefsDraft && prefsDraft.video1080}
                onChange={(v) => setPrefsDraft(Object.assign({}, prefsDraft, { video1080: v }))} />
            </label>
            <label className="vd-field">
              <span>图片 2K（元/张）</span>
              <InputNumber min={0} step={0.1} value={prefsDraft && prefsDraft.image}
                onChange={(v) => setPrefsDraft(Object.assign({}, prefsDraft, { image: v }))} />
            </label>
          </div>
          <div className="vd-row-end">
            {prefsMsg ? <span className="vd-hint">{prefsMsg}</span> : null}
            <Button onClick={saveBudgetEdit} type="primary" size="small">保存</Button>
          </div>
        </div>
      ) : null}

      <div className="vd-work">
        {/* ── 左：素材 ─────────────────────────────────────────────────── */}
        <section className="vd-col vd-materials">
          <div className="vd-col-head">
            <span className="vd-col-title">素材</span>
            {allUsed > 0 ? (
              <button type="button" className="vd-link" onClick={clearMedia}>清空</button>
            ) : (
              <span className="vd-hint">点方块选本机文件</span>
            )}
          </div>

          <div
            className="vd-role"
            role="button"
            tabIndex={0}
            onClick={addCharacter}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addCharacter(); }
            }}
          >
            <span className="vd-role-title">角色 / 数字人</span>
            <span className="vd-role-sub">加 1-3 张正脸照，人物才稳定</span>
          </div>

          <div className="vd-slots">
            {mode === 'video' ? (
              <>
                {renderSlot('first_frame')}
                {renderSlot('last_frame')}
                {renderSlot('reference_image')}
                {renderSlot('reference_video')}
                {renderSlot('reference_audio')}
              </>
            ) : (
              renderSlot('reference_image')
            )}
          </div>

          {mode === 'video' && (frameLocked || refLocked) ? (
            <div className="vd-exclusive" data-vd-exclusive>{EXCLUSIVE_NOTE}</div>
          ) : null}
          <div className="vd-note">
            同一组角色照在多条视频里重复使用，人物才不跑形。
          </div>
        </section>

        {/* ── 中：创作区 ───────────────────────────────────────────────── */}
        {/* `data-vd-edit-base`：当前有没有"按原图尺寸出图"的依据（`宽x高` 或空）。
            放在 section 上而不是临时状态里，是为了让验收能直接读到读数，不用猜。 */}
        <section
          className="vd-col vd-compose"
          data-vd-edit-base={editBase ? (editBase.w + 'x' + editBase.h) : ''}
        >
          <label className="vd-field vd-prompt-field">
            <span>
              {mode === 'video' ? '视频描述' : '画面描述'} <em className="vd-req">必填</em>
            </span>
            {/* ★ 这里**不许换成别的组件**：`scripts/smoke/cases/videodesign-media-refs.jsx`
                用 `.vd-compose textarea` 定位它。`@` 提及只在这个 TextArea 上挂事件。 */}
            <Input.TextArea
              ref={promptRef}
              rows={5}
              data-vd-prompt={mode === 'video' ? 'video' : 'image'}
              value={mode === 'video' ? vPrompt : iPrompt}
              onChange={onPromptChange}
              onKeyDown={onPromptKeyDown}
              onBlur={closeMention}
              placeholder={mode === 'video'
                ? '例：诊所前台，牙医给儿童患者检查牙齿，镜头缓慢推进，明亮自然光'
                : '例：牙科诊所宣传图，白色背景，一支正畸托槽特写，产品摄影，干净高光'}
            />
            {/* 一句话说清 `@` 能干什么（老板原话「没有办法 @图片1 图片2 这样」）。
                顺手把「这次会有几个素材一起提交」写出来 —— 编号的上限就是它，
                用户不用试出来。 */}
            <span className="vd-hint vd-mention-tip" data-vd-mention-tip data-vd-mention-max={slotMentionCount}>
              输入 <b>@</b> 可以引用素材（图1、图2…），编号会插在光标处；上下键选、回车确认、Esc 关闭
              {slotMentionCount > 0 ? '（当前 ' + slotMentionCount + ' 个素材会随这次生成一起提交）' : ''}
            </span>
            {mentionAt >= 0 && mentionList.length ? (
              <div
                className="vd-mention"
                data-vd-mention="1"
                data-vd-mention-count={mentionList.length}
                role="listbox"
                aria-label="选择要引用的素材"
              >
                <div className="vd-mention-head">选一张素材，编号插到光标处</div>
                <div className="vd-mention-list">
                  {mentionShown.map((it, i) => {
                    const thumb = it.kind === 'video' ? '' : mediaUrlOf(it.path, mediaDir);
                    return (
                      <div
                        className={'vd-mention-item' + (i === mentionIdx ? ' is-active' : '')}
                        key={it.from + '|' + (it.slot || '') + '|' + it.path}
                        data-vd-mention-item={it.n}
                        data-vd-mention-from={it.from}
                        role="option"
                        aria-selected={i === mentionIdx ? 'true' : 'false'}
                        onMouseEnter={() => setMentionIdx(i)}
                        onClick={() => pickMention(it)}
                      >
                        <span className="vd-mention-no">图{it.n}</span>
                        {thumb ? (
                          <img className="vd-mention-thumb" src={thumb} alt="" />
                        ) : (
                          <span className="vd-mention-thumb vd-mention-thumb-none">{kindText(it)}</span>
                        )}
                        <span className="vd-mention-name" title={it.path}>{it.name || '（无文件名）'}</span>
                        <span className="vd-mention-from">
                          {it.from === 'slot' ? '已在素材区' : '点一下套用'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </label>

          {/* ── AI 优化提示词（老板原话「没有AI优化提示词」）──────────────────
              ★ 只调 `chatFn`（`chatOnce` → `/api/chat-once`），**绝不碰 wanx**：
                不生成、不上传、不落盘 ⇒ **不扣任何生图/生视频额度**。
                下一个人若要在这里"顺手"加一次试生成，先想清楚那是在花用户的钱。
              ★ 空提示词时按钮 disabled：不能让用户点了才发现"没输入"。
              ★ 失败时 textarea 一个字都不动（覆盖只在 `r.ok === true` 之后发生）。 */}
          <div className="vd-airow" data-vd-ai-row>
            <Button
              size="small"
              data-vd-ai-optimize
              loading={aiBusy}
              disabled={!String(curPrompt || '').trim() || aiBusy}
              onClick={optimizePrompt}
            >
              AI 优化
            </Button>
            <span className="vd-hint" data-vd-ai-state>
              {aiBusy ? '优化中…（不会生成，也不会扣额度）' : '只改文字，不生成、不扣额度'}
            </span>
            {aiUndoHere ? (
              <>
                <span className="vd-tip" data-vd-ai-applied>已按 AI 建议改写</span>
                <Button size="small" type="link" data-vd-ai-undo onClick={undoAiPrompt}>撤销</Button>
              </>
            ) : null}
          </div>
          {aiNeedConfig ? (
            <Alert type="warning" showIcon data-vd-ai-need-config message={AI_NEED_CONFIG_TEXT} />
          ) : null}
          {!aiNeedConfig && aiErr ? (
            <Alert
              type="error"
              showIcon
              data-vd-ai-error
              message={aiErr + ' —— 提示词没被改动'}
            />
          ) : null}

          {refChips.length ? (
            <div className="vd-chips">
              <span className="vd-chips-label">把编号写进描述</span>
              {refChips.map((f, i) => (
                <button type="button" className="vd-chip" key={f.path + i} onClick={() => insertToken(i + 1)}>
                  插入 图{i + 1}
                </button>
              ))}
            </div>
          ) : null}

          <div className="vd-costrow">
            {mode === 'video' ? (
              <span className="vd-hint" data-vd-video-cost={vCost === null ? '' : vCost}>
                本条估算 {money(vCost)}
                {Number.isFinite(vPerSec) ? '（' + money(vPerSec) + '/秒 × ' + (durNum > 0 ? durNum : '实际') + ' 秒）' : ''}
                {vCapacity !== null ? ' · 还能出 ' + vCapacity + ' 条' : ''}
              </span>
            ) : (
              <span className="vd-hint" data-vd-image-cost={Number.isFinite(iCost) ? iCost : ''}>
                每张估算 {money(iCost)}
                {iCapacity !== null ? ' · 还能出 ' + iCapacity + ' 张' : ''}
              </span>
            )}
            {/* 「按原图尺寸出图」的两个读数：拿到了就说尺寸，没拿到就说明为什么没按原图。
                两者都不显示时（没点过「在这张图上继续改」）这里是空的 —— 不占位、不误导。 */}
            {mode !== 'video' && editBase ? (
              <span className="vd-hint" data-vd-edit-base-size={editBase.w + 'x' + editBase.h}>
                按原图 {editBase.w}×{editBase.h} 出图（超范围会等比缩到 512²~2048²）
              </span>
            ) : null}
            {mode !== 'video' && editBaseTip ? (
              <span className="vd-hint vd-warn" data-vd-edit-base-tip>{editBaseTip}</span>
            ) : null}
            {/* loading / 禁用一律取后台任务的 busy：切走再回来按钮还是"在跑"，
                不会变回可点（旧版跑完把 busy 置 false 时会诱导用户重点一次）。 */}
            <Button
              type="primary"
              size="large"
              loading={mode === 'video' ? videoJob.busy : imageJob.busy}
              disabled={!hasKey}
              onClick={() => (mode === 'video' ? submitVideo() : genImage())}
            >
              {mode === 'video' ? '生成视频' : '生成图片'}
            </Button>
          </div>

          {/* 图片进度：必须**看得见秒数**，不许只剩按钮转圈。
              后端 provider 的图片超时是 180 秒，用户可能真要等一两分钟；
              旧版这段时间界面一个字都没有 —— 这就是「等半天没生出来」的直接原因。 */}
          {mode !== 'video' && imageJob.busy ? (
            <div className="vd-progress" data-vd-image-progress-live>
              <span className="vd-progress-text">{imagePhaseText}</span>
              {imageElapsed < 3 ? <span className="vd-hint">已等待 {imageElapsed} 秒</span> : null}
              {renderPctBar(imagePct, 'image')}
            </div>
          ) : null}

          {/* 视频进度：保留原有的「已等待 N 秒」，起点改成后台任务的 startedAt。
              0.21.25 起多了一条百分比（老板「生成的时候没有百分比」）。 */}
          {mode === 'video' && videoJob.busy ? (
            <div className="vd-progress" data-vd-video-progress-live>
              <span className="vd-progress-text">{videoPhaseText}</span>
              <span className="vd-hint">已等待 {videoElapsed} 秒</span>
              {renderPctBar(videoPct, 'video')}
            </div>
          ) : null}

          {/* 校验提示（不是生成错误：它不需要跨卸载存活） */}
          {imageTip ? <Alert type="warning" showIcon message={imageTip} /> : null}
          {vTip ? <Alert type="warning" showIcon message={vTip} /> : null}

          {/* ★ 图片错误必须**可见且跨卸载存活**：读的是后台任务的 error。
              超时和「上游拒绝」必须是两句不同的话 —— 前者该再点一次，后者该改提示词/配置。 */}
          {imageJob.timedOut ? (
            <Alert
              type="error"
              showIcon
              data-vd-image-timeout-alert
              message={'超过 210 秒没返回，已放弃（可以再点一次）'}
            />
          ) : null}
          {!imageJob.timedOut && imageJob.error ? (
            <Alert type="error" showIcon data-vd-image-error-alert message={imageJob.error} />
          ) : null}

          {/* 视频错误同理：终态来自后台任务，切走再回来还看得见。 */}
          {videoJob.timedOut ? (
            <Alert
              type="error"
              showIcon
              data-vd-video-timeout-alert
              message={'超过 900 秒没出片，已放弃等待（上游的任务可能还在跑，点「刷新状态」能再查）'}
            />
          ) : null}
          {!videoJob.timedOut && videoJob.error ? (
            <Alert type="error" showIcon data-vd-video-error-alert message={videoJob.error} />
          ) : null}
          <div className="vd-note">
            {mode === 'video'
              ? '视频是异步任务：提交后要等两三分钟，可以先去做别的，回来还能接着看。'
              : '图片是同步返回：一次请求直接出图，通常十几秒到一分钟；万一上游卡住，最多 3 分钟就会报错。'}
          </div>
        </section>

        {/* ── 右：参数 ─────────────────────────────────────────────────── */}
        <aside className="vd-col vd-params">
          <div className="vd-col-head"><span className="vd-col-title">参数</span></div>
          {mode === 'video' ? (
            <>
              <label className="vd-field">
                <span>分辨率</span>
                <Select value={vRes} onChange={setVRes} options={resOpts} />
              </label>
              <label className="vd-field">
                <span>画面比例</span>
                <Select value={vRatio} onChange={setVRatio} options={ratioOpts} />
              </label>
              <label className="vd-field">
                <span>时长</span>
                <Select value={vDur} onChange={setVDur} options={durOpts} />
              </label>
              <label className="vd-check">
                <input type="checkbox" checked={vAudio} onChange={(e) => setVAudio(e.target.checked)} />
                <span>带配音（模型按描述自动配声音）</span>
              </label>
              <label className="vd-check">
                <input type="checkbox" checked={vExtend} onChange={(e) => setVExtend(e.target.checked)} />
                <span>自动扩写描述</span>
              </label>
              <label className="vd-field">
                <span>反向提示词 <em className="vd-opt">可选</em></span>
                <Input value={vNeg} onChange={(e) => setVNeg(e.target.value)} placeholder="不想出现：文字, 水印, 变形" />
              </label>
              <label className="vd-field">
                <span>种子 <em className="vd-opt">可选</em></span>
                <InputNumber className="vd-num" min={0} value={vSeed} onChange={setVSeed} placeholder="留空随机" />
              </label>
            </>
          ) : (
            <>
              <label className="vd-check">
                <input type="checkbox" checked={iExtend} onChange={(e) => setIExtend(e.target.checked)} />
                <span>自动扩写描述</span>
              </label>
              <label className="vd-field">
                <span>反向提示词 <em className="vd-opt">可选</em></span>
                <Input value={iNeg} onChange={(e) => setINeg(e.target.value)} placeholder="不想出现：文字, 水印, 低清晰度" />
              </label>
              <label className="vd-field">
                <span>种子 <em className="vd-opt">可选</em></span>
                <InputNumber className="vd-num" min={0} value={iSeed} onChange={setISeed} placeholder="留空随机" />
              </label>
            </>
          )}
        </aside>
      </div>

      {/* ── 结果：两种模式的结果都在，切模式不会把正在跑的任务藏起来 ──────
          ★ 图片任务容器**无条件渲染**：即使还没生成过任何东西，`data-vd-image-job`
            这些锚点也必须在 DOM 里 —— 否则自动化验收（和用户自己）在"还没开始时"
            根本读不到状态，只能靠"有结果"来推断，那恰恰是本次 bug 的形态。 */}
      <section className="vd-results" data-vd-results>
        <div className="vd-col-head"><span className="vd-col-title">生成结果</span></div>

        {/* 「本次生成」缩略图带：落盘即出现（不依赖 wanxAssets 重拉），点开是灯箱。
            放在图片任务容器之上 —— 它是这一轮的"总览"，下面才是逐次任务的详情。 */}
        {renderSessionStrip()}

        <div
          className={'vd-imgjob' + (imageBodyVisible ? ' vd-result' : '')}
          data-vd-image-job={imageJobKey}
          data-vd-image-busy={imageJob.busy ? '1' : '0'}
          data-vd-image-elapsed={String(imageElapsed)}
          data-vd-image-phase={imagePhase}
          data-vd-image-error={imageJob.error ? '1' : '0'}
          data-vd-image-timeout={imageJob.timedOut ? '1' : '0'}
          data-vd-image-done={imageResult ? '1' : '0'}
          data-vd-image-progress-pct={imagePct === null ? '' : String(imagePct)}
        >
          {/* 进度条放在 busy 判断**之外**：出图之后这里要显示 100（失败/超时是空属性、不画条）。
              条在 busy 期间会和上面创作区那条同时存在，两处读数由 `imageProgressPct` 同一份算法
              算出，永远一致（门禁会断言这一点）。 */}
          {renderPctBar(imagePct, 'image')}
          {imageJob.busy ? (
            <div className="vd-progress">
              <span className="vd-progress-text">{imagePhaseText}</span>
              {imageElapsed < 3 ? <span className="vd-hint">已等待 {imageElapsed} 秒</span> : null}
            </div>
          ) : null}
          {renderImageResult()}
          {mode !== 'video' && !imageBodyVisible ? (
            <div className="vd-note">还没有图片结果。点上面的「生成图片」就开始。</div>
          ) : null}
        </div>

        {renderVideoResult()}

        {!(vState || imageBodyVisible || sessionShots.length) ? (
          <div className="vd-note vd-results-empty">
            还没有生成结果。出片后会告诉你存在哪，也能直接拿来接着改。
          </div>
        ) : null}
      </section>

      {/* ── 作品库（带工作栏：筛选 / 搜索 / 计数 / 刷新 / 打开目录）────────── */}
      <section className="vd-library">
        <div className="vd-col-head">
          <span className="vd-col-title">作品库</span>
          <span className="vd-hint">点缩略图看大图 / 播视频 · 点下面的按钮就能接着改</span>
        </div>

        {/* 工作栏：即梦那种「全部 / 图片 / 视频 + 搜索 + 计数」。纯前端过滤，不动主进程。 */}
        <div className="vd-libbar" data-vd-libbar>
          <Segmented
            className="vd-filter"
            value={libFilter}
            onChange={(v) => setLibFilter(v)}
            options={[
              { label: '全部', value: 'all' },
              { label: '图片', value: 'image' },
              { label: '视频', value: 'video' },
            ]}
          />
          <Input
            className="vd-search"
            allowClear
            value={libQuery}
            onChange={(e) => setLibQuery(e.target.value)}
            placeholder="按描述或文件名搜索"
          />
          <span className="vd-hint vd-lib-count" data-vd-lib-count data-vd-lib-total={allLibItems.length}>
            共 {libItems.length} 件
          </span>
          {assetsTotal > allLibItems.length ? (
            <span className="vd-hint" data-vd-lib-truncated>
              （只列最近 {allLibItems.length} 件，一共 {assetsTotal} 件）
            </span>
          ) : null}
          {libMissingCount > 0 || assetsMissingCount > 0 ? (
            <span className="vd-hint vd-lib-missing" data-vd-lib-missing>
              {/* 取两者较大值：主进程数是**全量**的（可能多于这次拉回来的 200 条），
                  前端数是**当前这批**的。宁可多说也不少说 —— 少说会让用户以为文件都在。 */}
              其中 {Math.max(libMissingCount, assetsMissingCount)} 件本机文件已不在（记录还在，见下方说明）
            </span>
          ) : null}
          <Button size="small" onClick={() => loadAssets()}>刷新</Button>
          <Button size="small" onClick={() => openFolder('', false)}>打开作品目录</Button>
        </div>

        {assetsMissing ? (
          <div className="vd-note">作品库需要更新到新版才显示；已经生成的成品仍在上面那个目录里。</div>
        ) : null}
        {assetsErr ? <Alert type="warning" showIcon message={'作品库读取失败：' + assetsErr} /> : null}
        {!assetsMissing && !libItems.length ? (
          <div className="vd-note">
            {allLibItems.length
              ? '当前筛选/搜索条件下没有作品。点「全部」或清空搜索再看。'
              : '这里还是空的。生成一次，作品就会出现在这。'}
          </div>
        ) : null}
        <div className="vd-assets">
          {libItems.map((a, ai) => {
            // 三态：有文件 / 有记录但文件不在 / 没记录。文件不在照样列出来，只是不给「接着改」。
            const hasFile = assetHasFile(a);
            const cardKey = a.id || a.localPath || ('idx-' + ai);
            const src = hasFile ? mediaUrlOf(a.localPath, mediaDir) : '';
            return (
            <figure
              className={'vd-asset' + (hasFile ? '' : ' is-lost')}
              key={cardKey}
              data-vd-asset={cardKey}
              data-vd-nofile={hasFile ? '0' : '1'}
            >
              {/* 媒体区可点：点开灯箱看大图 / 播视频。文件不在也能点（能看元信息 + 原路径）。 */}
              <div
                className="vd-asset-media"
                role="button"
                tabIndex={0}
                aria-label={'查看第 ' + (ai + 1) + ' 件（' + kindText(a) + '）'}
                onClick={() => openLightbox(libItems, ai)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(libItems, ai); }
                }}
              >
                {!hasFile ? (
                  <span className="vd-thumb-icon">文件不在</span>
                ) : a.kind === 'video' ? (
                  <>
                    <video className="vd-asset-video" src={src || undefined} muted preload="metadata" />
                    {/* 播放角标：不加的话"这张静止图到底是图还是视频"完全看不出来 */}
                    <span className="vd-play-badge" aria-hidden="true">▶</span>
                  </>
                ) : (
                  <img className="vd-asset-img" src={src || undefined} alt="" loading="lazy" />
                )}
                <span className="vd-asset-kind">{kindText(a)}</span>
              </div>
              <figcaption className="vd-asset-meta">
                <span className="vd-asset-prompt">{String(a.prompt || '（没有描述）').slice(0, 16)}</span>
                <span className="vd-hint">{tsText(a.ts)}</span>
              </figcaption>
              <div className="vd-asset-acts">
                {!hasFile ? (
                  <span className="vd-hint" data-vd-asset-lost>本机文件已不在，没法接着改（可能被移动或删除）。</span>
                ) : a.kind === 'video' ? (
                  <Button size="small" onClick={() => useAssetAs(a, 'video_ref')}>用作参考视频</Button>
                ) : (
                  <>
                    {/* 措辞更明确的入口：老板「没办法在原有的图片上编辑」。
                        它 = 「用作参考图」+ 记住原图宽高（出图按原图尺寸）。 */}
                    <Button size="small" type="primary" data-vd-asset-edit onClick={() => continueEditOnImage(a)}>
                      在这张图上继续改
                    </Button>
                    <Button size="small" onClick={() => useAssetAs(a, 'image_ref')}>用作参考图</Button>
                    <Button size="small" onClick={() => useAssetAs(a, 'video_first')}>用作首帧</Button>
                  </>
                )}
              </div>
              {/* 文件不在时把原路径也写出来：用户能照着自己去磁盘上找回来 */}
              {!hasFile && a.localPath ? (
                <code className="vd-asset-lostpath">{a.localPath}</code>
              ) : null}
            </figure>
            );
          })}
        </div>
      </section>

      {/* ── 账本 ─────────────────────────────────────────────────────── */}
      <div className="vd-panel">
        <div className="vd-panel-title">
          最近 20 笔（提交时记的估算，不是官方账单）
          <span className="vd-hint">共 {b.count || 0} 笔{b.badLines ? '，其中 ' + b.badLines + ' 行读取失败' : ''}</span>
        </div>
        <Table
          size="small"
          rowKey={(r, i) => (r.requestId || r.taskId || String(i)) + '-' + i}
          columns={ledgerCols}
          dataSource={ledger}
          pagination={false}
          locale={{ emptyText: '还没有记录 —— 生成一次就会出现在这里' }}
        />
      </div>

      {/* ── 灯箱：全屏看大图 / 播视频（← → 切换、Esc 关闭、点遮罩关闭）────── */}
      {lightbox ? (
        <MediaLightbox
          items={lightbox.items}
          index={lightbox.index}
          onClose={closeLightbox}
          onStep={stepLightbox}
          onUseAs={useAssetAs}
          onEditImage={continueEditOnImage}
          onOpenFolder={(p) => openFolder(p, true)}
          mediaDir={mediaDir}
        />
      ) : null}
    </div>
  );
}
