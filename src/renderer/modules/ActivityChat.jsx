import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, App as AntApp, Tag } from 'antd';
import Markdown from '../components/Markdown.jsx';
import { geoProxy } from '../api.js';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
// 【0.21.15 · 老板需求 7 + 需求 1】活动策划对话必须「后台跑 + 切页面不丢」。
// 生成走 store/backgroundJobs.js（超时兜底 + 同 key 不并发），会话正文自己落 localStorage。
import { startJob, useBackgroundJob, clearJob } from '../store/backgroundJobs.js';
// 【0.21.14 · 老板需求 1「档期只读化」】原先这里 import 了 `PromoCalendarPanel`
// （客户端录档期的抽屉）+ 两处「管理活动档期」文字链接。老板原话：
// 「档期活动，近期活动安排 这个难道不是 api.example.com 后台运营配置 这边显示的么？
//   为什么变成豆芽claw里面新建活动了？这不对…把豆芽claw里面新建活动一整套删了」
// ⇒ 本组件只保留「对话式做方案」能力，档期一律由 api.example.com 后台配置，客户端只读。
// 第十五轮（2026-10-15）老板需求「活动策划对话框要支持上传材料」：
// docx/txt 正文提取（老 .doc 诚实报不支持，见工具内注释）。
import { extractFileText } from '../utils/docxText.js';
// 【0.21.11 · 老板第 3 条】做活动方案必须按老板给的《口腔医疗行业活动策划与执行管理 Prompt》来。
// 提示词是资产，单独放 data/activityPlanPrompt.js（6000 字，写在组件里会读不下去）。
import { ACTIVITY_PLAN_PROMPT } from '../data/activityPlanPrompt.js';
// 【第二十二轮 · 老板第 4 条】「点击到最顶部 / 点击到最新对话」——对话区的滚动导航。
// 【第二十二轮 · 老板第 5 条】失败要明确（分类 + 原因 + 重试）、生成中要显眼（动效 + 耗时）。
// 两个都是跨页共用的东西，所以各只有**一份**实现，这里只是接进来：
//   · components/ScrollNav.jsx   —— 滚动判定 + 按钮 + 未读角标（纯函数可测）
//   · components/ChatGenerating.jsx —— 生成中的显眼气泡（含「已等 N 秒」）
//   · services/chatFailure.js    —— 失败归类（超时/网络/鉴权/服务端/取消…）与文案
import ScrollNav from '../components/ScrollNav.jsx';
import ChatGenerating from '../components/ChatGenerating.jsx';
import { describeFailure } from '../services/chatFailure.js';

/**
 * ActivityChat —— 对话式活动策划（2026-10-10 老板第 6 / 7 条）。
 *
 * 取代原「今天做什么」(TodayOps) 的一级入口。
 * 老板原话：「今天做什么直接删掉好了，太乱了，要简单明了，这是给笨蛋用的后台」
 *          「活动策划放在今天做什么上面，就是一个明确的活动策划，对话的形式即可」。
 *
 * 所以这一页只做一件事：**你说想办什么活动，豆芽给一套明确、能照做的方案**，全程对话。
 *
 * ══════════════════════════════════════════════════════════════════
 * 【0.21.15 · 老板需求 1「活动策划不会后台跑 切换一下页面就没有了」】
 *
 * 改前（0.21.14）：`messages` / `busy` 都是**组件内部 useState**，
 * 而本组件有两个挂载点（ActivityHub 的对话页签、DirectionModule 的经营方案位），
 * 用户一切页 → 组件卸载 → 对话与生成一起蒸发；再切回来是一片空白。
 *
 * 改后两条腿：
 *   ① **会话正文落盘**：`localStorage['douya-activity-chat:<companyId>:<variant>']`
 *      = { messages, pending, updatedAt }。挂载即恢复，切走切回条数一模一样。
 *      key 带 companyId（换企业不串号）+ variant（活动方案 / 经营方案两套对话互不污染）。
 *   ② **生成走后台任务**：`startJob('activity-chat-<variant>-<companyId>', …)`
 *      ⇒ 组件卸载不影响任务继续跑，任务自己把 AI 回复写回会话；
 *      进度/进行中状态从 `useBackgroundJob(jobKey)` 推导，**不再是组件局部 state**
 *      ⇒ 切回来能立刻看到「正在出方案」，不会出现「任务在跑但按钮显示可以再点」。
 *
 * 能力边界（照实写，不吹）：
 * - 走后端通用转发 /api/wenan/generate（type:'custom'）—— 后端没有 /api/activities/generate
 *   （契约见本仓 skill 的 references/api_contracts.md），故不臆造接口。
 * - 失败如实报错、给「再试一次」，绝不伪造一份方案糊弄。
 * - 方案可一键存入资产库（addAsset 内部自动回流企业大脑）。
 */

const EXAMPLES = [
  '下个月办一场种植牙科普沙龙，想吸引 30 位周边居民',
  '五一做个老客回馈活动，预算控制在 5000 元内',
  '开学季面向家长的儿童齿科义诊',
];

// ══════════════════════════════════════════════════════════════════
// 会话持久化（模块级小 store —— 与 backgroundJobs.js 同一范式）
//
// 为什么不用「组件 useState + useEffect 写 localStorage」：
//   生成任务在组件卸载后仍会跑完并把 AI 回复写回会话。若组件手里还攥着一份旧
//   `messages` 快照，卸载期间的写入就会被下一次 setState 覆盖（丢消息）。
//   所以**唯一事实源放在模块级缓存 + localStorage**，组件只订阅、不持有权威副本。
// ══════════════════════════════════════════════════════════════════

/** 会话存 localStorage 的 key 前缀（整串见 conversationKey）。 */
const CONV_PREFIX = 'douya-activity-chat';
/** 最多保留多少条消息（防止 localStorage 无限长；一对问答 = 2 条）。 */
const MAX_MESSAGES = 40;

/** 模块级会话缓存：key → { messages, pending, updatedAt }。 */
const convCache = new Map();
/** 订阅者：key → Set<() => void>。 */
const convListeners = new Map();

/**
 * 拼会话存储 key。
 * @param {string} companyId 企业 id（空则用 'x'，避免未选企业时写到公共串里）
 * @param {string} variant 'activity' | 'business'
 * @returns {string}
 */
function conversationKey(companyId, variant) {
  return `${CONV_PREFIX}:${companyId || 'x'}:${variant || 'activity'}`;
}

/** 把任意输入规整成合法会话（绝不抛错，坏数据一律当空会话）。 */
function normalizeConversation(raw) {
  const out = { messages: [], pending: null, updatedAt: 0 };
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw.messages)) {
    out.messages = raw.messages
      .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'ai'))
      .map((m) => ({
        role: m.role,
        text: typeof m.text === 'string' ? m.text : '',
        error: typeof m.error === 'string' ? m.error : '',
        at: Number(m.at) || 0,
      }))
      .slice(-MAX_MESSAGES);
  }
  if (raw.pending && typeof raw.pending === 'object' && typeof raw.pending.ask === 'string') {
    out.pending = { ask: raw.pending.ask, at: Number(raw.pending.at) || 0 };
  }
  out.updatedAt = Number(raw.updatedAt) || 0;
  return out;
}

/**
 * 读会话（先缓存，再 localStorage；都没有则空会话）。
 * @param {string} key conversationKey 结果
 * @returns {{messages:Array, pending:object|null, updatedAt:number}}
 */
function readConversation(key) {
  if (convCache.has(key)) return convCache.get(key);
  let conv = { messages: [], pending: null, updatedAt: 0 };
  try {
    const raw = localStorage.getItem(key);
    conv = raw ? normalizeConversation(JSON.parse(raw)) : conv;
  } catch {
    conv = { messages: [], pending: null, updatedAt: 0 };
  }
  convCache.set(key, conv);
  return conv;
}

/**
 * 写会话（缓存 + localStorage + 通知订阅者）。**唯一的写入口**。
 * @param {string} key conversationKey 结果
 * @param {{messages:Array, pending:object|null}} next 新会话
 */
function writeConversation(key, next) {
  const conv = {
    messages: Array.isArray(next.messages) ? next.messages.slice(-MAX_MESSAGES) : [],
    pending: next.pending && typeof next.pending === 'object' ? next.pending : null,
    updatedAt: Date.now(),
  };
  convCache.set(key, conv);
  try {
    localStorage.setItem(key, JSON.stringify(conv));
  } catch { /* 配额满：内存里仍有，只是下次启动恢复不到 —— 不阻断用户 */ }
  const set = convListeners.get(key);
  if (set) {
    for (const fn of set) {
      try { fn(); } catch { /* 单个订阅者异常不影响其他人 */ }
    }
  }
}

/** 追加一条用户消息，并把「这道题等回答」标记进 pending。 */
function pushUserMessage(key, ask) {
  const cur = readConversation(key);
  const at = Date.now();
  writeConversation(key, {
    messages: [...cur.messages, { role: 'user', text: ask, error: '', at }],
    pending: { ask, at },
  });
}

/** 追加一条 AI 回复并解除 pending（成功/失败都走这里，保证 busy 一定回落）。 */
function pushAiMessage(key, msg) {
  const cur = readConversation(key);
  writeConversation(key, {
    messages: [...cur.messages, { role: 'ai', text: msg.text || '', error: msg.error || '', at: Date.now() }],
    pending: null,
  });
}

/**
 * 撤回最后一条「等回答」的用户消息（仅用于任务被拒绝启动时，保证会话里不留悬空提问）。
 * @param {string} key conversationKey 结果
 */
function rollbackPendingAsk(key) {
  const cur = readConversation(key);
  if (!cur.pending) return;
  const messages = cur.messages.slice();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') { messages.splice(i, 1); break; }
  }
  writeConversation(key, { messages, pending: null });
}

/** 清空整段会话（老板要求：清历史要有入口，不能只靠清 localStorage）。 */
function clearConversation(key) {
  writeConversation(key, { messages: [], pending: null });
}

/** 拿到（必要时创建）某个 key 的订阅者集合。 */
function ensureListenerSet(key) {
  let set = convListeners.get(key);
  if (!set) { set = new Set(); convListeners.set(key, set); }
  return set;
}

/**
 * 订阅某段会话。key 变了自动切到新的那段。
 * @param {string} key conversationKey 结果
 * @returns {{messages:Array, pending:object|null, updatedAt:number}}
 */
function useConversation(key) {
  const [, force] = useState(0);
  useEffect(() => {
    const set = ensureListenerSet(key);
    const fn = () => force((n) => n + 1);
    set.add(fn);
    // key 变化后立即对齐一次（否则会短暂显示上一段会话）
    force((n) => n + 1);
    return () => { set.delete(fn); };
  }, [key]);
  return readConversation(key);
}

/**
 * 把「角色提示词 + 企业画像 + 用户这句话」拼成给后端的要求。
 *
 * 【0.21.11 · 老板第 3 条】rolePrompt 由外部传入：
 *   · 活动页传 ACTIVITY_PLAN_PROMPT（老板给的那套完整活动策划 Prompt）；
 *   · 经营方案页传 BUSINESS_PLAN_PROMPT（同一体系那份经营战略 Prompt）。
 * 不传时退回原来那段精简要求（保证任何单点引用都不会因为缺参数而空转）。
 *
 * 关键：要它输出**明确**的东西（谁负责、多少钱、什么时间），而不是一堆泛泛而谈；
 * 同时立红线：数字必须标「估算/参考」，不许写没有输入支撑的空话。
 */
function buildPrompt(ask, asset, materialsText, rolePrompt) {
  const parts = [];
  const role = String(rolePrompt || '').trim();
  if (role) {
    parts.push('【角色与工作方法 · 必须严格遵守】');
    parts.push(role);
  } else {
    parts.push('【任务】给这家企业策划一场**明确、能直接落地**的活动。');
    parts.push(
      '【输出要求】直接用 Markdown 小标题分节，包含：\n' +
      '1. 活动名称 + 一句话定位\n' +
      '2. 目标（要达成什么，尽量可量化）\n' +
      '3. 时间 / 地点 / 参与对象\n' +
      '4. 活动流程（按时间顺序，每一步写清谁负责）\n' +
      '5. 要准备的物料与话术\n' +
      '6. 预算参考（分项列，能省则省）\n' +
      '7. 预期效果 + 怎么衡量',
    );
  }
  parts.push(
    '【硬要求】所有数字与承诺都标「估算 / 参考」，不要编造真实数据与来源；' +
    '不要写「根据企业画像」这类没有实际输入支撑的套话。信息不足就直说缺什么。' +
    '企业上下文里没有的内容（预算、人数、嘉宾、资质、往期数据）一律不许替它编。',
  );
  const ctx = [];
  if (asset && asset.companyName) ctx.push(`企业：${asset.companyName}`);
  if (asset && asset.brandTone) ctx.push(`品牌调性：${asset.brandTone}`);
  if (asset && (asset.coreSellingPoints || []).length) ctx.push(`核心卖点：${asset.coreSellingPoints.join('、')}`);
  if (asset && (asset.targetCustomers || []).length) ctx.push(`目标人群：${asset.targetCustomers.join('、')}`);
  if (asset && asset.profile) ctx.push(`企业画像：${asset.profile}`);
  if (asset && asset.industry) ctx.push(`行业：${asset.industry}`);
  if (ctx.length) parts.push(`【企业情况】\n${ctx.join('\n')}`);
  // 第十五轮：用户上传的材料（预算表 / 往期方案 / 商品清单…）原样进上下文，
  // 让方案按真实材料做，而不是只靠企业画像。截断到 6000 字防 prompt 爆炸。
  const mats = String(materialsText || '').trim();
  if (mats) parts.push(`【参考材料（用户上传，共 ${mats.length} 字）】\n${mats.slice(0, 6000)}`);
  parts.push(`【老板的想法】${ask}`);
  return parts.join('\n\n');
}

export default function ActivityChat({
  onSelectModule,
  embedded = false,
  draft = '',
  // ---- 0.21.11：泛化为「方案对话器」，A 活动方案 / B 经营方案 共用一套 UI ----
  variant = 'activity',
  rolePrompt = ACTIVITY_PLAN_PROMPT,
  welcome = '你想办一场什么活动？',
  examples = EXAMPLES,
  placeholder = '说说你想办的活动，例如：下个月办一场种植牙科普沙龙',
  saveLabel = '存入素材库',
  saveNamePrefix = '活动策划',
  saveTags = ['活动策划', '豆芽生成'],
  sendBusyText = '豆芽正在给你出方案…',
}) {
  const { message } = AntApp.useApp();
  const { currentCompany } = useCompany();
  const { asset } = useMarketingAsset();
  const { addAsset } = useAssets();

  const companyId = currentCompany ? String(currentCompany.id || '') : '';
  const storeKey = conversationKey(companyId, variant);
  const jobKey = `activity-chat-${variant}-${companyId || 'x'}`;

  // 会话正文：唯一事实源是 localStorage（见上方模块级 store），组件只订阅。
  const conv = useConversation(storeKey);
  const messages = conv.messages;

  // 进行中状态：**从后台任务推导**，不做组件局部 state。
  // 这样「切走再切回」时按钮状态与真实任务一致（旧版切回来 busy=false 会诱导用户重点一次）。
  const job = useBackgroundJob(jobKey);
  const busy = !!job.busy;

  const [input, setInput] = useState('');
  // 第十五轮：上传的材料（{ name, text }）。读不出正文的文件不进列表（不假装有材料）。
  const [materials, setMaterials] = useState([]);
  const matRef = useRef(null);
  const bodyRef = useRef(null);

  // 2026-10-16 设计系统 v3：活动页改单页平铺，本组件嵌入「对话式做方案」卡（embedded）。
  // 看板入口卡把诉求带进来（draft 变化即预填输入框，不自动发送；空串只聚焦不改输入）。
  useEffect(() => {
    if (draft) setInput(draft);
  }, [draft]);

  // 【第二十二轮 · 老板第 4 条】原先这里是「每来一条消息就 el.scrollTop = scrollHeight」。
  // 那个做法有两个毛病，被老板第 4 条一并暴露出来：
  //   ① 用户正在往上翻历史时，新消息一到就被**硬拽**到底部 —— 想看的那段话直接找不到了；
  //   ② 没有"回顶部/回最新"的入口，长对话只能一路滑。
  // 现在滚动全部交给 <ScrollNav>（见下方 JSX）：它只在**用户本来就在底部**时才继续贴底，
  // 不在底部时改为在「回到最新」上记未读条数。逻辑只有一份，三个对话区共用。

  // ── 断线兜底：pending 还在但任务已不在跑 ⇒ 上一轮被硬中断（刷新 / 关应用 / 崩溃）。
  //    必须落一条**如实**的提示，否则这道题会一直「悬空」，看着像还在转圈。
  //    不会误判：startJob 是同步置 busy=true 的，所以本 effect 在「刚发出」时读到的一定是 busy。
  //    【第二十二轮·老板第 5 条 a】文案不再是一句笼统的「没跑完」，而是走统一归类：
  //    超时 → 「超时没返回：超过 N 秒…」；被硬中断 → 「失败了：上次这条没跑完…」。
  //    两类抬头**两两不等**，用户一眼能分出"该等"还是"该重发"。
  useEffect(() => {
    if (job.busy) return;
    if (!conv.pending) return;
    const desc = job.timedOut && job.error
      ? describeFailure({ timedOut: true, note: job.note, message: job.error })
      : describeFailure({ note: '异常', message: '上次这条没跑完（页面刷新或应用被关掉了），再发一次就行' });
    pushAiMessage(storeKey, { role: 'ai', text: '', error: desc.text });
  }, [storeKey, job.busy, job.at, job.runId, job.timedOut, job.error, job.note, conv.pending]);


  /**
   * 发送：先把用户这句话落盘，再交给后台任务跑。
   * 生成结果由任务自己写回会话 —— 组件此刻就算卸载了，回复也不会丢。
   */
  async function send(text) {
    const ask = String(text != null ? text : input).trim();
    if (!ask || busy) return;
    setInput('');

    // 材料随本次提问一起进上下文（每次都用当前列表，删掉的材料立即失效）。
    const materialsText = materials.map((m) => `──《${m.name}》──\n${m.text}`).join('\n\n');
    const prompt = buildPrompt(ask, asset, materialsText, rolePrompt);

    pushUserMessage(storeKey, ask);

    const res = await startJob(jobKey, async ({ signal }) => {
      // 【需求 7】把任务的 AbortSignal 透传给 geoProxy：超时兜底能真正掐断这条请求，
      // 而不是「状态说超时了、socket 还挂着」。
      let r = null;
      try {
        r = await geoProxy('/api/wenan/generate', 'POST', {
          type: 'custom',
          style: 'marketing',
          topic: ask,
          extra: prompt,
          online: true,
          personas: [],
          platforms: [],
        }, { signal });
      } catch (e) {
        // 请求层抛错（网络断 / 被中断）：**由任务自己**把如实原因写进会话。
        // 不能指望组件补一条 —— 组件此刻可能已经卸载（用户切去别的页面了）。
        //
        // 【第二十二轮·老板第 5 条 b】被 abort 的那条**不再补消息**：
        //   `signal.aborted` 说明是任务层超时兜底掐断的（backgroundJobs 到点先 abort 再落终态），
        //   而终态落下来以后，下面的「断线兜底」effect 会写一条**如实的超时提示**。
        //   旧版这里还会 push 一条 `The user aborted a request.`（英文原文）——
        //   于是用户看到两条互相打脸的报错：一条「超过 210 秒没返回」，一条英文。
        if (signal && signal.aborted) throw e;
        const desc = describeFailure({ message: (e && e.message) || '' });
        pushAiMessage(storeKey, { role: 'ai', text: '', error: desc.text });
        throw e;
      }
      if (!r || r.ok === false) {
        // 失败原因**原样保留**（老板抱怨的就是"含糊"），只在前面加一个能分辨的抬头。
        const desc = describeFailure({ httpStatus: r && r.status, message: (r && r.error) || '' });
        pushAiMessage(storeKey, { role: 'ai', text: '', error: desc.text });
        return { ok: false, error: desc.text };
      }
      const content = (r && (r.content || r.text || r.result)) || '';
      if (!content) {
        const desc = describeFailure({ message: '豆芽这次没给出内容，请再试一次' });
        pushAiMessage(storeKey, { role: 'ai', text: '', error: desc.text });
        return { ok: false, error: desc.text };
      }
      // 成功：AI 回复由**任务**写回会话 ⇒ 组件卸载了也不丢。
      pushAiMessage(storeKey, { role: 'ai', text: String(content) });
      return { ok: true, content: String(content) };
      // 超时三层必须严格递增，否则短的那层先掐断，用户看到的就是「生成到一半没了」：
      //   geoProxy 自己 180s（api.js:GEO_PROXY_TIMEOUT_MS）
      //   < 本任务 210s（外层兜底，来这里说明内层没按时返回）
      //   < 主进程 /api/geo-proxy 240s（backend.js，最后一道，绝不先断）
      // 原来是 150s —— 比 geoProxy 的 180s 还短，长方案会被任务层提前 abort。
    }, { timeoutMs: 210000 });

    // 任务被拒绝启动（同 key 已有任务在跑）⇒ 撤回刚才那条悬空提问，并明确告诉用户原因。
    if (res && res.code === 'JOB_BUSY') {
      rollbackPendingAsk(storeKey);
      message.warning('上一个方案还在跑，等它出结果再点一次');
      return;
    }
    // 超时 / 异常：任务侧的 catch 已把「如实报错」写进会话，这里不再补一条，避免重复。
  }

  /** 把最后一条 AI 方案存进资产库（自动回流企业大脑）。 */
  function saveLastPlan() {
    const last = [...messages].reverse().find((m) => m.role === 'ai' && m.text);
    if (!last) return;
    const firstUser = messages.find((m) => m.role === 'user');
    const name = `${saveNamePrefix} · ${String((firstUser && firstUser.text) || '方案').slice(0, 30)}`;
    addAsset({
      type: 'copy',
      companyId: currentCompany ? currentCompany.id : '',
      projectId: null,
      name,
      content: last.text,
      tags: saveTags,
    });
    message.success('已存入「素材库」，并同步到企业大脑');
  }

  /** 清空历史对话（老板要求：要有清空入口，不能只靠清 localStorage）。 */
  function clearHistory() {
    clearConversation(storeKey);
    // 顺手清掉后台任务状态：否则全局指示条还会挂着一条属于这段对话的旧结果。
    clearJob(jobKey);
    message.success('对话已清空');
  }

  /** 上传材料：docx/txt 提取正文进列表；读不出的如实提示，绝不塞空材料。 */
  async function handleMaterial(e) {
    const files = Array.from((e && e.target && e.target.files) || []);
    e.target.value = '';
    if (!files.length) return;
    const ok = [];
    const errs = [];
    for (const f of files) {
      const r = await extractFileText(f);
      if (r.ok && r.text) ok.push({ name: r.name, text: r.text });
      else errs.push(`《${f.name}》：${(r && r.error) || '没读到正文'}`);
    }
    if (ok.length) setMaterials((prev) => [...prev, ...ok].slice(0, 6));
    if (errs.length) message.warning(errs.join('；'));
    if (ok.length) message.success(`已读入 ${ok.length} 份材料，下次发送时带上`);
  }

  const hasPlan = messages.some((m) => m.role === 'ai' && m.text);
  const hasHistory = messages.length > 0;

  return (
    <div
      className={'module-page act-chat' + (embedded ? ' act-chat-embedded' : '')}
      data-plan-chat={variant}
      data-act-chat-key={storeKey}
      data-act-chat-count={messages.length}
      data-act-chat-busy={busy ? '1' : '0'}
    >
      {/* embedded（嵌入活动页「对话式做方案」卡）时不重复渲染页头——卡片头由外层 ab-sec-hd 承担。
          0.21.14：原先这里的「管理活动档期」文字链接已删（档期只读，客户端无写入口）。 */}
      {embedded ? null : (
      <div className="module-page-head">
        <div className="module-page-title">活动策划</div>
        <div className="module-page-sub">
          直接说你想办什么活动，豆芽给你一套能照着做的方案。
        </div>
      </div>
      )}

      <div className="act-chat-body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="act-chat-welcome">
            <div className="act-chat-hello">{welcome}</div>
            <div className="act-chat-hint">随便说一句就行，例如：</div>
            <div className="act-chat-examples">
              {examples.map((t) => (
                <button key={t} type="button" className="act-chat-ex" onClick={() => send(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            // 【第二十二轮·老板第 5 条 a】失败那条要说清「是哪一类 + 为什么 + 能不能重试」。
            // 类别由统一归类函数从**错误原文**推断（会话落盘的字段没变，不加第二份状态）：
            // 超时 / 连不上 / 鉴权 / 服务端 / 取消 / 空结果，抬头两两不等。
            const fail = m.error ? describeFailure({ message: m.error }) : null;
            // 重试要重发"上一次问的那句"：往前找最近一条用户消息（找不到就不给按钮，别造假动作）。
            let retryAsk = '';
            if (fail) {
              for (let k = i - 1; k >= 0; k -= 1) {
                if (messages[k] && messages[k].role === 'user' && messages[k].text) {
                  retryAsk = messages[k].text;
                  break;
                }
              }
            }
            return (
              <div className={'act-msg ' + m.role} key={i} data-act-msg={m.role}>
                <div className="act-msg-avatar">{m.role === 'user' ? '我' : '🌱'}</div>
                <div className="act-msg-bubble">
                  {fail ? (
                    <div className="act-msg-err" data-chat-failure={fail.kind}>
                      <div>⚠️ {fail.text}</div>
                      <div className="act-msg-err-next">{fail.next}</div>
                      {retryAsk ? (
                        <div className="act-msg-err-retry">
                          <Button size="small" type="primary" onClick={() => send(retryAsk)} disabled={busy}>
                            重试
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <Markdown>{m.text}</Markdown>
                  )}
                </div>
              </div>
            );
          })
        )}
        {/* 【第二十二轮·老板第 5 条 c】生成中要**显眼**：三点跳动 + 文字「生成中」+「已等 N 秒」。
            旧版只有一行灰字，用户扫不到；现在这行是对话区底部最显眼的一格。
            `data-act-typing` 保留 —— 既有门禁（caseActivityChatPersist）按它判"生成中在不在"。 */}
        {busy ? (
          <div className="act-msg ai" data-act-typing="1">
            <div className="act-msg-avatar">🌱</div>
            <ChatGenerating text={`生成中，${sendBusyText}`} />
          </div>
        ) : null}
        {/* 「可以切页面」是这次改动的正面回答，直接写在跑的那一行下面，不让用户猜。 */}
        {busy ? (
          <div className="act-chat-bgnote">已转到后台跑，切到别的页面也会继续，回来就能看到结果</div>
        ) : null}
        {/* 【第二十二轮·老板第 4 条】回顶部 / 回最新（未读角标）。
            放在滚动容器的**最后一个子节点**：sticky 定位让它贴在容器可视底边，
            又不占内容高度（见 styles/chat-ux.css 顶部说明）。 */}
        <ScrollNav
          scrollerRef={bodyRef}
          count={messages.length}
          revision={messages.length + (busy ? 1 : 0)}
          topLabel="回到最上面"
          latestLabel="回到最新"
        />
      </div>


      {hasHistory ? (
        <div className="act-chat-actions">
          {hasPlan ? (
            <Button size="small" onClick={saveLastPlan}>{saveLabel}</Button>
          ) : null}
          {/* 清空入口常驻（不只在「有方案」时出现）—— 上一版只有出了方案才能清，
              用户想丢掉一段失败的对话时无路可走。 */}
          <Button size="small" type="text" onClick={clearHistory} data-act-clear="1">清空对话</Button>
        </div>
      ) : null}

      {/* 第十五轮：上传材料条（预算表 / 往期方案 / 商品清单，pdf/docx/txt）。
          用非 button 元素承载「上传」动作之外的展示，上传本身仍是真 file input。
          第二十三轮·老板第 3 条：accept 补 .pdf —— 此前只有 docx/txt/md，
          pdfExtract 模块虽已就绪但入口不放行，用户根本选不到 PDF 文件。 */}
      <div className="act-chat-materials" data-act-materials={materials.length}>
        <input ref={matRef} type="file" accept=".pdf,.docx,.txt,.md" multiple style={{ display: 'none' }} onChange={handleMaterial} />
        <span
          className="act-chat-mat-btn"
          role="link"
          tabIndex={0}
          onClick={() => matRef.current && matRef.current.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (matRef.current) matRef.current.click(); } }}
        >
          📎 上传材料
        </span>
        {materials.length === 0 ? (
          <span className="act-chat-mat-hint">有预算表、往期方案或商品清单？传上来（支持 PDF / Word / txt），豆芽照着做</span>
        ) : (
          materials.map((m, i) => (
            <Tag
              key={m.name + i}
              closable
              onClose={() => setMaterials((prev) => prev.filter((_, j) => j !== i))}
              className="act-chat-mat-tag"
            >
              {m.name}（{m.text.length} 字）
            </Tag>
          ))
        )}
      </div>

      <div className="act-chat-input">
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          autoSize={{ minRows: 1, maxRows: 4 }}
          onPressEnter={(e) => {
            if (!e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <Button type="primary" onClick={() => send()} loading={busy} disabled={!input.trim() || busy}>
          发送
        </Button>
      </div>
    </div>
  );
}
