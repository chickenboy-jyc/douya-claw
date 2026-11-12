/* 本模块的版式（双栏栅格 .co-cols / 右栏 .co-rail / 卡片 .co-card…）全在 ia-content.css。
   2026-10-14 补：这行 import 一直缺失 ⇒ 该文件从未被加载 ⇒ .co-cols 的
   display:grid / grid-template-columns 全不生效，运行时 computed 只有 `*` 命中，
   双栏塌成单列、右栏掉到主列下方（探针 grid-diag.mjs 实测 display=block / cols=none）。
   对照：HomeConsole 写了 import ia-dashboard.css、MarketMomentum 写了 ia-diagnosis.css，
   所以那两页正常。 */
import '../styles/ia-content.css';
// 0.21.9 老板第 6 条（内容创作改对话式 / 下滑切换 / 删模板与风格）新增样式。
// 独立成文件：ia-content.css 被多个页面共用，往里加类名容易撞（lint-css-collisions 专门抓）。
// 0.21.15 老板需求 5（去掉三级页 / 对话即生成 / 对话框加大）的样式追加在本文件**末尾**，
// 用的是全新的 co-log* / co-msg* 类，不改动别人的既有规则。
import '../styles/round16-content.css';
import PageBanner from '../components/PageBanner.jsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Input, Popover, Tag } from 'antd';
import Markdown from '../components/Markdown.jsx';
// Markdown → 纯文本的唯一真源（复制到剪贴板 / 卡片预览切片都走它）。
import { mdToPlain } from '../utils/mdToPlain.js';
import { useAssets, ASSET_TYPES } from '../store/assetStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompany } from '../store/companyStore.jsx';
// 后台任务：生成挂到全局 store ⇒ 切模块 / 切企业（App.jsx 用 key={company.id} 重建本页）
// 都不会把正在跑的那一次丢掉。本轮**只使用**它的公开接口，不改这个文件本身。
import { clearJob, startJob, useBackgroundJob } from '../store/backgroundJobs.js';
import LineIcon from '../components/LineIcon.jsx';
// 对话式创作的豆芽头像（复用仓库里已有的真图，不引外网图片）。
import douyaMascot from '../assets/douya/douya-mascot.webp';
// 生成动作的单一入口：prompt 组装 + 调接口 + 错误归一（见该文件头部的关系说明）。
import {
  CONTENT_CHAT_TIMEOUT_MS,
  contentChatJobKey,
  generateContentCopy,
  readLastRequest,
  writeLastRequest,
} from '../services/contentChat.js';
// 【第二十二轮 · 老板第 4 条】对话区滚动导航（回顶部 / 回最新 + 未读角标）。
// 【第二十二轮 · 老板第 5 条】失败归类（超时 / 网络 / 鉴权 / 服务端 / 取消）+ 生成中显眼气泡。
// 三样都是跨页共用的一份实现，不在本页另写一套滚动/失败逻辑。
import ScrollNav from '../components/ScrollNav.jsx';
import ChatGenerating from '../components/ChatGenerating.jsx';
import { describeFailure } from '../services/chatFailure.js';
// 【0.21.26 · 修「参考资料是假承诺」】把「选中的文件」变成「真带正文的 refs 文本」的纯逻辑：
// 扩展名分流（文本真读 / 二进制文档如实标未支持）、单文件 2 万字与合计 6 万字上限、
// 以及**界面状态与 prompt 文本同源于一份计划**（`planRefs`）—— 否则又会退回「界面说读了、实际没读」。
import {
  MAX_FILE_ENTRIES,
  READ_MAX_BYTES,
  applyReadResult,
  baseNameOf,
  makeRefEntry,
  planRefs,
} from '../services/contentRefs.js';

/**
 * 后台任务外圈超时相对内圈的余量（毫秒）。
 * 见 `send()` 里关于 `timeoutMs` 的注释：内圈先说话，外圈只兜底。
 */
const CONTENT_CHAT_TIMEOUT_MARGIN_MS = 30000;

/**
 * 【第二十三轮】服务端回「本次输出被模型预算上限截断」时，落在 `job.note` 上的那句话。
 *
 * 为什么要有常量而不是就地写死两个字面量：这句话在**两处**被判定
 *   ① 包 taskFn 时写进 `job.note`（见 `send()`）；
 *   ② 结算时用 `indexOf('上限')` 判断这条 turn 要不要挂提示（见 `useEffect`）。
 * 两处各写一份字面量，将来改文案就会出现"写了 note 但界面不显示提示"这类静默失配。
 * ⚠️ 判定用「上限」二字而不是整串相等：`backgroundJobs` 里 note 可能被包上别的前后缀
 *   （超时那条就是「超时」），按子串判更耐改。
 */
const TRUNCATED_NOTE = '已写到本次上限';

/**
 * 内容创作（合并容器）· 2026-10-12 界面整顿 P2
 *
 * 起因：原一级入口「内容与传播」（ContentOps：日常内容 | 活动策划）与
 * 「新媒体中心」（NewMediaCenter：生成文案 | 媒体投放）做的是同一件事的不同环节
 * —— 都是「把内容做出来、对外发出去」，各占一个一级入口属于重复。
 * 老板要求合并为一个「内容创作」。
 *
 * 合并范围（**只动入口归属，不动页面能力**）：
 *   · 「日常内容」 → DailyOps（朋友圈 / 社群 / 排版，一字未改）
 *   · 「生成文案」 → NewMediaWorkbench（原在新媒体中心里，一字未改）
 *   · 原「活动策划」页签**移出**本容器：活动相关全部收拢到「活动与档期」一个入口。
 *     ActivityPlanning 本身仍以 `huodong` key 在 App.jsx 可达（深链不破）。
 *     【0.21.21 · 老板 2026-10-21 更正】上面这句已过期：`ActivityPlanning.jsx` 及
 *     整个「活动与档期」板块已删除。`huodong` 深链现在由 App.jsx 的 LEGACY_MODULE_ALIAS
 *     归一到 `campaign`（营销专项 = 新版做活动方案）。**深链仍然不破**，但落点换了页。
 *   · 媒体投放（MediaPublish）独立成名，见导航「媒体与报价」。
 *
 * ============================================================================
 * 【0.21.15 · 老板需求 5】内容创作去掉三级页 + 对话即生成 + 对话框加大
 * ============================================================================
 * 老板原话（本轮逐字）：「现在内容创作点击创作还会跳转到三级页 我不要那个三级页了
 *   直接在对话输入后就自动开始生成，而且现在会出现生一半就中断掉了的问题，这个你需要修复一下。
 *   然后这个创作对话框要大一些 不然生成的内容放不下对吧」
 *
 * ── 改前的结构（**这就是"三级页"与"生一半就中断"的共同病根**）──────────────
 *   本页有两个视图态：`view === 'board'`（对话卡）与 `view === 'gen'`（整页换成
 *   NewMediaWorkbench）。于是同一件事被拆成三级：
 *     一级 侧栏「内容创作」→ 二级 对话卡（.co-creator）→ 三级 生成结果页（.co-gen-view）。
 *   而**真正发请求的组件**（NewMediaWorkbench）只在三级页挂载 ⇒
 *     · 说一句话之后，必须先跳页、再在那页**又点一次**「生成文案」才开始写；
 *     · 三级页里点「← 回到创作」= `setView('board')` ⇒ NewMediaWorkbench **unmount**，
 *       对话卡也是重新挂载（`goal`/`files`/`refText` 这些 state 全丢）；
 *     · `App.jsx:3565` 还给它挂了 `key={currentCompany.id}` ⇒ 切企业/重连也会整页重建。
 *   生成中只要发生上面任何一次重建，用户看到的就是：页面自己跳回去了、写的东西不见了、
 *   结果只剩半截 —— 老板说的「生一半就中断掉了」，在**内容创作这条链路上**的真因就是它
 *   （这条链路是 `POST /api/wenan/generate` 一次性返回，**没有** SSE/流式读取，
 *    所以不存在"reader 提前 break"那种流式中断；也不是 token 截断 —— 见下方"排查记录"）。
 *
 * ── 改后（本轮）──────────────────────────────────────────────────────────────
 *   ① `view` 这个 state **整体删除**：页面只有一个视图。对话卡常驻、永不因"结果出来了"而
 *      卸载；生成结果**追加在对话卡下方**的对话流里（.co-log）。
 *   ② 输入后**一次动作**就开写：回车（Shift+回车换行）或点「开始创作」→ 立即 push 一条
 *      用户消息 + 一条「正在写」气泡，同时把请求交给 backgroundJobs；不需要第二次点击。
 *   ③ 生成挂 `store/backgroundJobs.js`（key = `content-chat-<companyId>`）：
 *      切模块 / 切企业 / 页面重建都不会中断它，回来时结果自动落回对话流。
 *      失败/超时一律把「正在写」气泡换成**显式错误气泡 + 重试**，绝不停在半截。
 *   ④ 输入框 minRows 3 → 6、maxRows 8 → 16，卡片 min-height 46vh → 56vh；
 *      对话流自带独立滚动（max-height 62vh），长文不会把整页撑爆。
 *
 * ── 排查记录（"生一半就中断"逐条排除，写下来避免下一轮重查）────────────────
 *   1. 流式读取被中途 return？**不适用** —— 本链路是整包 JSON（geoProxy → 主进程
 *      /api/geo-proxy → fetch + `upstream.text()` + JSON.parse），没有任何 reader 循环。
 *   2. token 截断？**不在前端** —— 请求体里没有 max_tokens 字段，模型侧上限由豆芽AI
 *      工作台决定；前端能看到的只有"整包有没有回来"。
 *   3. 超时？**有一处，已定性**：主进程 `backend.js` 的 geo-proxy 有 120s 硬超时，到点
 *      abort 并返回「GEO 请求失败：请求超时」。精品文案是九章长 prompt + 五部分输出，
 *      最容易踩到；踩到时会**整包失败**（不是半截）。本轮在前端再加一道 180s 显式上限
 *      （services/contentChat.js），保证"挂住"也一定会变成一句人话错误。
 *   4. 状态被覆盖 / 组件卸载？**主因，已修** —— 见上面「改前的结构」。
 *   5. 结果没有可放的地方？**是** —— 三级页的 `.xm-result-body` 没有独立滚动，长文把页面
 *      撑长后用户只看到"前面一截"（老板后半句「内容放不下」正是这个）。本轮给了 .co-log-body。
 *
 * ── 关于「最近创作」「备用资料」两块示例内容 ─────────────────────────────────
 *   规矩不变：示例**只在视图层渲染、不写任何 store**（ContentOps 本身无持久化），
 *   用户生成第一篇 / 填了企业资料后真实数据自动顶上，示例整体退场。
 *
 * ============================================================================
 * 【第二十三轮 · 老板「并不是在对话框里生成」】对话流被两个 vh 顶出屏幕
 * ============================================================================
 * ── ① 老板原话（本轮逐字，team-lead 2026-10-19 转达）────────────────────────
 *   「现在内容创作点击后并不是在对话框里生成（对话框的意义何在？？而且对话框是不是有点小）
 *     ……整个页面重新设计下」
 *   ⚠️ 上一轮（0.21.15 需求 5）**已经把**「输入后直接开始生成、结果追加到对话流」做进去了，
 *     而且已经在线上包里 ⇒ 本轮不是"功能没做"，而是**结果落在屏幕外面他看不见**。
 *     所以本轮一件交互逻辑都没推翻，只改版式 + 补两条提示。
 *
 * ── ② 真根因：两个「占视口比例」的高度相加 = 118vh（逐个指到行）──────────────
 *   · `.co-card.co-chat { min-height: 56vh }` —— round16-content.css **第 250 行**
 *     （本文件第 646 行的创作卡用的就是这个类）；
 *   · `.co-log-body  { max-height: 62vh }` —— round16-content.css **第 317 行**
 *     （本文件第 774 行的对话流滚动体）。
 *   56vh + 62vh = **118vh** > 100vh。再叠加顶部 PageBanner(~90px+20px 外边距) /
 *   `.co-wrap` 里的 `.r15-note` / 卡与卡之间的 gap / 输入框下方工具条 ⇒
 *   对话流（`.co-log`，本文件第 765 行）**整体落在首屏以下**。
 *   于是老板的真实体验是：在输入框里打完字回车，页面**什么都不动**，
 *   答案生成在下方看不见的地方 —— 他说的「并不是在对话框里生成」就是这件事。
 *
 * ── ③ 上一轮那句「不再需要整页滚动」为什么是错的（必须写下来，避免再来一次）──
 *   上一轮的推理是：「对话流紧跟创作卡下方 ⇒ 用户刚在卡里说完就在原地看得到」。
 *   这个结论成立的前提是**「卡 + 流」同屏**，而它被 56vh + 62vh 直接否掉了。
 *   一句可以记住的话：**「相邻」不等于「可见」** —— 两个按视口比例取高的块竖着叠，
 *   第二块必然出屏。上一轮把「DOM 上挨着」当成了「视觉上看得到」，这是推理跳跃，不是实现 bug。
 *   ⇒ 本轮做法：① 删掉这两个 vh，高度改由 flex 分配（整块不超过一屏）；
 *     ② 滚动**只发生在对话流容器内部**（onScroll 维护 atBottomRef + 直接写 scrollTop），
 *        **禁用 `scrollIntoView`** —— 它滚的是外层页面，正是要修的那个症状。
 *
 * ── ④ 加大（老板第二问「对话框是不是有点小」）────────────────────────────────
 *   `max-width` 940 → **1120**（`.co-card.co-chat` 与 `.co-log` 两处）；
 *   输入框 `autoSize` minRows 6 → **8**、maxRows 16 → **18**（`data-co-chat-minrows`
 *   / `data-co-chat-maxrows` 两个锚点同步改值 —— 门禁脚本读的是属性，不是 autoSize）。
 *
 * ── ⑤ 「被上限截断」提示（服务端新增字段 `truncated`）──────────────────────
 *   链路：`/api/wenan/generate` 返回 `truncated` → `services/contentChat.js`
 *   `generateContentCopy` 透传 →（包一层 taskFn 写进 `job.note`，因为 backgroundJobs
 *   的 `settle` 只持久化 result/error/note 三个字段、result 已被正文占用）→
 *   结算时落到该条 assistant turn 的 `note` → 气泡正文下方渲染一行 `.co-msg-limit`。
 */

/** 内容类资产（「最近创作」只列这些，避免把品牌素材/学习资料混进来）。 */
const CONTENT_ASSET_TYPES = [
  'copy', 'moments_copy', 'community_copy', 'article', 'social_post', 'document', 'ppt',
];

/**
 * 【0.21.9 · 老板第 6 条】内容风格选择器与「热门模板」一起删除（老板原话：「删模板与风格」）。
 * 但引擎仍然需要 style 这个入参（/api/wenan/generate 的 style 枚举），所以固定取默认值
 * 传给引擎 —— 这是"真参数取默认"，不是留了个假开关：页面上已经搜不到任何风格选择器。
 * 该默认值现在由 services/contentChat.js 持有（生成动作的唯一入口），本文件不再重复定义。
 */

/**
 * 「最近创作」「备用资料」两块空态区的示例内容（2026-10-13 对照参考图
 * 《豆芽助手内容创作平台.png》）。规矩同活动页示例卡：**只在视图层渲染、
 * 不写任何 store**（ContentOps 本身无持久化），用户生成第一篇 / 填了企业
 * 资料后真实数据自动顶上，示例整体退场。
 */
const DEMO_RECENT = [
  // 「种草」在首屏术语黑名单里（GB 门禁 = 0），参考图原词换成等价的「推广文案」。
  // 2026-10-13 第五轮：emoji → LineIcon 的 ic 键（去脏乱，与首页同一套图标语言）。
  // 2026-10-18 第十六轮：分类体系整体删除（老板第 1 条），示例记录不再挂分类标签，
  // 只留作品名与时间 —— 分类是旧版页签的遗物，模板/记录的标题本身就是内容名。
  { ic: 'pen', name: '小红书推广文案：儿童益生菌产品', at: '10-24 15:32' },
  { ic: 'rocket', name: '国庆活动推广方案', at: '10-23 11:20' },
  { ic: 'doc', name: '品牌故事：专注儿童营养 20 年', at: '10-22 09:45' },
];

/** 右栏「备用资料」示例行（真实资料填好后自动换成真值）。
 *  第十一轮：随右栏恢复。 */
const DEMO_REFS = [
  { ic: 'package', k: '康健苗苗产品资料', v: '2026-10-12' },
  { ic: 'doc', k: '品牌手册', v: '2026-09-28' },
  { ic: 'users', k: '用户画像报告', v: '2026-09-15' },
  { ic: 'doc', k: '行业白皮书', v: '2026-08-20' },
];

/**
 * 2026-10-18 第十六轮：模型选择（输入框下方，老板原话「做一个模型选择
 * 日常内容/精品文案 在这里进行 prompt 的切换」）。
 *   · daily  日常内容 —— 快稿 prompt：通知文案、朋友圈日更、科普短文，AI 一键成稿；
 *   · wenan  精品文案 —— 深度 prompt：品牌故事、产品深度稿、投放级长文案，调性更稳质感更高。
 * 旧的 CO_TABS 七分类页签（主页/营销文案/活动方案/社媒内容/产品文案/品牌故事/其他）
 * 已按老板「删除全部」指令移除，模板区不再按分类筛。
 */
const MODEL_OPTIONS = [
  { value: 'daily', label: '日常内容', desc: '300~500 字快稿：通知 / 朋友圈 / 日更科普，一键成稿' },
  { value: 'wenan', label: '精品文案', desc: '800~1500 字深度稿：品牌故事 / 投放长文案，3 个备选标题' },
];

/** 时间：今天 / 昨天 / 9-12（与首页最近更新同一口径，不新造一套）。 */
function fmtWhen(v) {
  const t = Number(v) || 0;
  if (!t) return '--';
  const d = new Date(t);
  if (!d.getTime()) return '--';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return '今天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return (d.getMonth() + 1) + '-' + d.getDate();
}

/**
 * 复制纯文本到剪贴板（主路径 clipboard API，Electron 非安全上下文时降级 execCommand）。
 * 与 NewMediaWorkbench 的 copyText 同口径 —— 那份没导出，且本轮不允许改那个文件，
 * 故此处在对话区内自备一份（20 行以内，逻辑单纯，无第二份真相风险）。
 *
 * 【0.21.25 报障「生的文章 不要有 ## ** 这种没有意义的符号」】
 * 这里出的是**纯文本**，所以必须先把 Markdown 标记剥掉 —— 剪贴板不经过渲染器，
 * 原来粘到公众号里就是 `## 最终文章` `**重点**` 原样可见。
 * 出口只有这一个函数（全文复制 / 后续任何复制都走它），所以在这一处转，
 * 而不是去改每个调用点。
 *
 * @param {string} text 要复制的文本（Markdown 原样传进来即可）
 * @returns {Promise<boolean>} 是否成功
 */
async function copyPlainText(text) {
  const t = text == null ? '' : mdToPlain(String(text));
  if (!t) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {
    /* 落到下面的降级路径 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = !!document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* 资产类型 → LineIcon 图标键（2026-10-13 第五轮：emoji → 共享线性图标）。 */
const ASSET_ICON = {
  copy: 'pen',
  moments_copy: 'doc',
  community_copy: 'users',
  article: 'doc',
  social_post: 'palette',
  document: 'doc',
  ppt: 'chart',
};

/* ============================================================================
 * 创作工作台（对话区 + 它的对话流）
 * ========================================================================== */
/**
 * @param {Object} props
 * @param {Object} props.asset 营销资产（企业资料）
 * @param {Array} props.assets 全部资产（「最近的快稿」读它）
 * @param {Object} props.currentCompany 当前企业
 * @param {Object} props.currentProject 当前项目
 * @param {Function} props.addAsset 存入产出
 * @param {Function} props.geoProxy 取数通道
 * @param {string} props.jobKey 后台任务键（content-chat-<companyId>）
 * @param {{busy:boolean,result:any,error:string,note:string,at:number}} props.job 该任务的状态
 * @param {Function} props.onSelectModule 跳模块
 */
function ContentWorkbench({
  asset, assets, currentCompany, currentProject, addAsset, geoProxy, jobKey, job, onSelectModule,
}) {
  const { message } = AntApp.useApp();
  const [goal, setGoal] = useState('');
  const [refProfile, setRefProfile] = useState(false);
  /**
   * 参考资料文件条目（**不是文件名数组**）。
   *
   * 【0.21.26 修缺陷】以前这里是 `string[]`，只有文件名 ⇒ 拼进 prompt 的只有文件名，
   * 卡片却承诺「生成时会参考这些内容」，等于骗用户。现在每一项都是
   * `{ id, name, path, kind, status, content, chars, error }`（见 `services/contentRefs.js`）：
   * `content` 是**真读到的正文**，`status` 是「已读取 / 未支持 / 读取失败」的可见状态。
   */
  const [files, setFiles] = useState([]);
  const [refText, setRefText] = useState('');
  /** 是否正在读盘（读多个文件时按钮要变成「正在读取…」，否则用户会重复点）。 */
  const [refBusy, setRefBusy] = useState(false);
  /**
   * 「日常内容 / 精品文章」——**一个 state 管两件事**（0.21.9 修的真 bug）。
   *
   * 历史：第十六轮这里有个 `mode` state（喂给生成 prompt），本轮老板第 6 条又加了个
   * `switchTab` state（控制下方"最近的快稿/精品稿"面板）。两者取值域相同（daily|wenan）、
   * 界面上各亮一半，于是出现：
   *   用户点下方「精品文章」→ 上方胶囊还亮着「日常内容」→ 真正进生成器的是胶囊那个值。
   * 用户会以为"我选了精品，为什么出来的是快稿"，这正是老板第 5 条抱怨的同类病：
   * **界面说 A、系统做 B**。而且老板第十六轮明确说过「不要分日常内容和精品文案」。
   * ⇒ 合并成一个：对用户来说"写快稿还是写精品稿"就是同一件事，
   *   两处控件（输入框底部胶囊 / 下方大切换）读写同一个 state，点哪边另一边都跟着亮。
   * 0.21.15 起它还有第三个用处：**每次发送时快照进这一轮消息**（`turn.mode`），
   *   所以后面再切模型也不会把已经写好的那篇"改口径"。
   */
  const [switchTab, setSwitchTab] = useState('daily');
  const switchRef = useRef(null);
  const fileRef = useRef(null);

  // ===== 对话流 =====
  /** 每一轮的一条消息。role='user' 是用户那句话；role='assistant' 是结果（可能 pending/error）。 */
  const [turns, setTurns] = useState([]);
  const [formError, setFormError] = useState('');
  const [savedTurnId, setSavedTurnId] = useState('');
  /**
   * 【全屏展开】结果区是否铺满窗口。
   *
   * 起因（老板原话）：「生成后 UI 真的很窄一条 看起来很累 要滑很久 能不能占比大一些
   * 比如全屏这样」。窄不是屏幕小 —— `.co-log` 硬写了 `max-width: 1120px`
   * （round16-content.css 里 `.co-log` 那一条），主列实际可用宽 1196px 被它封顶，
   * 窗口再宽也不涨；长是因为 `.co-wrap` 高度锁在 clamp(520px, 100vh - 212px, 880px)
   * 里，正文只能在这条竖直栏里滚。
   *
   * 只做「展开/收起」一个开关，不改默认版式：默认仍是原样的分栏，用户想铺满时点一下。
   * 开关本身必须挂在 `.co-log-hd`（turns > 0 才渲染）里，且必须是 `span role="link"`
   * 而不是 `<Button>` —— 既有的首屏按钮棘轮按 `container.querySelectorAll('button').length`
   * 数首屏按钮，多一个真按钮就会把它顶破。
   */
  const [logMax, setLogMax] = useState(false);
  /** 已经"认领"过的 job 时间戳：同一个 job.at 只结算一次，避免 effect 反复追加同一条结果。 */
  const consumedAt = useRef(0);
  /** 最近一次发送用的模型（重建组件后补气泡时用，避免依赖闭包里的旧 switchTab）。 */
  const modeRef = useRef('daily');
  /**
   * 同步发送锁。`busy` 来自 job 状态、要等一次 emit + 重渲染才更新，
   * 同一 tick 内连按两次回车时两次都读到 false ⇒ 会起两个 run，
   * 而 `startJob` 的 runId 世代号会让先那次的结果被静默丢弃（= 一条 pending 永远不结算）。
   */
  const sendingRef = useRef(false);
  const seqRef = useRef(0);
  const logRef = useRef(null);
  /**
   * 【第二十三轮】「用户现在是不是正贴着对话流底部」。
   *
   * 为什么必须是 ref 而不是 state：它只在 scroll / 追加消息这两处被读写，
   * 写进 state 会让每一帧滚动都触发重渲染（长文滚动会明显发涩）。
   *
   * 初始 `true`：新会话第一次出稿时用户显然"在看最新"，应该自动贴底。
   * 距离底部 **< 80px** 记为"在底部"：比 ScrollNav 的 24px 宽，
   * 因为这里的用途是「新消息到达时要不要贴底」——一个还在往上翻半屏的用户
   * 不该被拽走，而只差几十像素的抖动应该算"在看最新"。
   */
  const atBottomRef = useRef(true);
  /** 对话流是不是已经做过"首次贴底"（组件重建、恢复历史时要把 scrollTop 直接设到底）。 */
  const firstPaintRef = useRef(false);

  const busy = !!(job && job.busy);

  useEffect(() => { modeRef.current = switchTab; }, [switchTab]);

  /**
   * 【全屏展开】键盘：只有展开着的时候才挂监听，收起就摘掉 ——
   * 否则页面别处按 Escape（关下拉、退出输入法候选）会莫名把结果区收起来，
   * 也会白白占一份监听。写法照抄 VideoDesign.jsx 的 MediaLightbox：
   * 打开时挂、卸载时摘，`e.preventDefault` 前判空（jsdom 手造的合成事件没有这方法）。
   */
  useEffect(() => {
    if (!logMax) return undefined;
    const onKey = (e) => {
      if (!e || !e.key) return;
      if (e.key === 'Escape') {
        if (e.preventDefault) e.preventDefault();
        setLogMax(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [logMax]);

  /**
   * 【全屏展开】锁页面滚动：铺满期间背后那页不许跟着滚。
   *
   * ⚠️ 清理函数里必须**恢复成原来的值**而不是写死 `''`：本页可能在别处
   * （将来别的浮层）已经把 body 设成了 hidden，写空会把别人的锁一起拆掉。
   * ⚠️ 卸载时也要恢复（`return` 里的清理函数在卸载与依赖变化时都会跑）：
   * 用户展开着结果区直接切换模块时，本组件被卸载，不恢复的话整个 app 都滚不动。
   */
  useEffect(() => {
    if (!logMax) return undefined;
    if (typeof document === 'undefined' || !document.body) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [logMax]);

  /** 造一个稳定唯一的消息 id（同一毫秒内连发两次也不会撞）。 */
  function nextId(prefix) {
    seqRef.current += 1;
    return prefix + '-' + seqRef.current + '-' + Date.now();
  }

  // 企业资料四项：有值的才算「可引用」。空则引导去企业资料补，不伪造内容。
  const profileRows = useMemo(() => ([
    { k: '企业名称', v: (asset && asset.companyName) || '' },
    { k: '核心卖点', v: (asset && Array.isArray(asset.coreSellingPoints) ? asset.coreSellingPoints.join('、') : '') },
    { k: '目标人群', v: (asset && Array.isArray(asset.targetCustomers) ? asset.targetCustomers.join('、') : '') },
    { k: '品牌调性', v: (asset && asset.brandTone) || '' },
  ]), [asset]);
  const filledCount = profileRows.filter((r) => r.v).length;

  /**
   * 「使用企业资料」的清单本体（Popover 的 content）。
   *
   * 【0.21.28 为什么把它从卡内挪进浮层 —— 老板「这排按钮被挡住了」的真正收尾】
   *   上一轮把卡片从 `flex: 1 1 auto` 改成 `0 0 auto` 之后，底部工具条确实不再被裁；
   *   但真浏览器实测暴露出**同一个病的下一个受害者**：这块清单当时挂在 `.co-chat-composer`
   *   里，展开时自带 181px，而卡片的高度上限是 `max-height: calc(100vh - 212px)`
   *   （一层屏），于是"标题行 + 输入框 + 工具条 + 清单 + 标签"加起来必然超：
   *     · 1180x780「输入 10 行 + 展开清单」：内容 688 > 卡高 568 ⇒ 裁掉 122px；
   *     · 1180x670 同状态：内容 688 > 卡高 458 ⇒ 裁掉 232px；
   *   被裁的是**清单下半截 + 「主题已写」标签**，而 `overflow: hidden` 让用户滚也滚不出来。
   *   也就是说：只改 flex 是"把裁切从工具条转移到清单"，老板下次照样报。
   *
   *   为什么选浮层而不是下面几条：
   *     · 给卡片加 `overflow: auto` —— 会与本页唯一的滚动容器 `.co-page` 形成双滚动条
   *       （本文件 `:169` 那条注释反复警告过，是刻意不做的设计）；
   *     · 给 `.co-ref` 加 `max-height + overflow-y: auto` —— 能吃掉一部分，但要**用户在一个
   *       浮在输入框上方的 181px 小框里滚 4 行资料**，观感更差，且只是把裁切换成"框内滚"；
   *     · 把 `max-height` 调大 —— 那是挪断点（换个字号/多一行换行又开始裁），且实测
   *       `.co-wrap` 顶边真值 188px，一屏预算本来就是紧的，放大就会顶破整页。
   *   ⇒ 清单是**按需查看的辅助信息**，不是输入的一部分。让它浮起来，卡片高度就只由
   *     「标题行 + 输入框 + 工具条 + 标签」决定 —— 这些才是老板每次都要看到的东西。
   *
   * ⚠️ `data-co-refprofile="1"` **必须留在这个根节点上**：它是"清单真的渲染了"的锚点，
   *   而不是装饰。Popover 默认**首次打开才渲染**、关闭后不销毁（`destroyOnHidden={false}`，
   *   见下方用法），所以"打开的时候一定能在 DOM 里查到它"这条成立。
   * ⚠️ `filledCount` / `profileRows` 的取数逻辑一个字没改：开关文案、生成时读不读企业资料
   *   （`refProfile` 这个 state）全部沿用原路径。
   */
  const refPanel = (
    <div className="co-ref" data-co-refprofile="1">
      {profileRows.map((r) => (
        <div className="co-ref-row" key={r.k}>
          <span className="co-ref-k">{r.k}</span>
          <span className={'co-ref-v' + (r.v ? '' : ' empty')}>{r.v || '还没填'}</span>
        </div>
      ))}
      <div className="co-ref-note">
        豆芽生成时会读这些资料。缺的项可以到
        <span className="co-link" role="link" tabIndex={0} onClick={() => onSelectModule && onSelectModule('profile')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onSelectModule) onSelectModule('profile'); } }}>「企业大脑」</span>
        里补。
      </div>
    </div>
  );

  // 最近创作：真实资产 → 只取内容类，按更新时间倒序前 5 条。
  const recent = useMemo(() => {
    const list = (assets || [])
      .filter((a) => CONTENT_ASSET_TYPES.includes(a.type))
      .slice()
      .sort((a, b) => (Number(b.updatedAt || b.createdAt) || 0) - (Number(a.updatedAt || a.createdAt) || 0));
    return list.slice(0, 5);
  }, [assets]);

  /**
   * 切换面板要显示哪批记录。
   *   daily → 最近的内容类资产（快稿）
   *   wenan → 同一批里标题更长的（≥12 字，大致对应"长文/深度稿"）；一条都没有就退回全部，
   *           宁可少筛也不摆一个空面板（空面板会被当成"功能坏了"）。
   */
  const switchList = useMemo(() => {
    if (switchTab === 'daily') return recent;
    const longer = recent.filter((a) => String(a.name || '').length >= 12);
    return longer.length ? longer : recent;
  }, [switchTab, recent]);

  /**
   * 参考资料计划：**界面状态与真正拼进 prompt 的文本共用这一份**。
   *
   * 为什么不是「读的时候顺手算状态、发送时再另拼一遍文本」：那样两边很容易走偏
   * （本项目最常犯的错就是「写了但没生效」）。这里 `planRefs()` 一次算完：
   *   · `refPlan.items[i]` —— 右栏每个文件后面那行状态（已读取 N 字 / 未支持 / 读取失败…）
   *   · `refPlan.block`    —— `collectRefs()` 的返回值，原样交给 `generateContentCopy({refs})`
   * 于是「界面显示已读取 1234 字」和「prompt 里真有这 1234 字」是同一次计算的产物。
   */
  const refPlan = useMemo(() => planRefs(files, refText), [files, refText]);

  /**
   * 选文件 → 逐个读正文。**真读，读不了就如实标**。
   *
   * 通道（已核实，不要自己造）：
   *   · `window.api.pickFiles()`    → `{canceled, filePaths}`（preload.js:29）。给的是绝对路径，
   *     比 `<input type=file>` 可靠得多（Electron 里 input 拿不到磁盘路径）。
   *   · `window.api.readFileText()` → `{ok:true, content}` | `{ok:false, error}`（preload.js:32，
   *     main 侧 main.js:213，默认 2MB 上限、会自己去掉 UTF-8 BOM）。
   *
   * 分流规则见 `services/contentRefs.js` 的 `classifyFile()`：
   *   · 文本类（txt/md/csv/json/py/js/ts/html/css/log/xml/yml/yaml…）⇒ 真读正文；
   *   · 二进制文档（docx/doc/pdf/xlsx/xls/pptx/ppt）⇒ **不读**（本机无解析器，读了必是乱码），
   *     状态标「未支持，请粘贴」；
   *   · 其它未知扩展名 ⇒ 试读，失败就把 main 给的原因原样标出来。
   *
   * @returns {Promise<void>}
   */
  async function pickRefFiles() {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.pickFiles !== 'function' || typeof api.readFileText !== 'function') {
      // 浏览器 / 无 preload 环境：拿不到磁盘路径 ⇒ 回退到隐藏 input，只登记文件名
      // （状态会明确标「仅登记文件名」，不假装读过正文）。
      if (fileRef.current) fileRef.current.click();
      return;
    }
    let picked = null;
    try {
      picked = await api.pickFiles();
    } catch {
      picked = null;
    }
    if (!picked) {
      message.warning('打开文件选择失败，请重试');
      return;
    }
    if (picked.canceled) return;
    const paths = (picked.filePaths || []).filter(Boolean).slice(0, MAX_FILE_ENTRIES);
    if (!paths.length) return;
    // 同一路径重复选：直接跳过（否则同一份资料会被拼进 prompt 两遍，白烧 token）。
    const fresh = paths
      .filter((p) => !files.some((it) => it && it.path === p))
      .map((p) => makeRefEntry({ name: baseNameOf(p), path: p }));
    if (!fresh.length) return;
    setFiles((prev) => [...prev, ...fresh].slice(0, MAX_FILE_ENTRIES));
    setRefBusy(true);
    try {
      for (const entry of fresh) {
        if (entry.kind === 'binary') {
          // word / pdf / Excel / PPT：本机没有解析器。读出来是乱码，不如如实标「未支持」。
          setFiles((prev) => prev.map((it) => (it.id === entry.id ? { ...it, status: 'unsupported' } : it)));
          continue;
        }
        let res = null;
        try {
          res = await api.readFileText(entry.path, READ_MAX_BYTES);
        } catch (e) {
          res = { ok: false, error: (e && e.message) || '读取失败' };
        }
        setFiles((prev) => prev.map((it) => (it.id === entry.id ? applyReadResult(it, res) : it)));
      }
    } finally {
      setRefBusy(false);
    }
  }

  /**
   * 参考资料 → 交给生成器的 refs 文本（**含正文**）。
   *
   * 返回值形如 `【参考资料文件 foo.md】\n<正文>`；读不到正文的拼
   * `【参考资料文件 bar.docx（正文未读取：本机没有该格式的解析器…）】`。
   * 长度受 `PER_FILE_CHAR_LIMIT`（2 万字/文件）与 `TOTAL_CHAR_LIMIT`（6 万字合计）约束，
   * 截断会写进文本本身（「已截断至 N 字（原文 M 字）」），绝不静默。
   *
   * ⚠️ 这里**必须**直接用 `refPlan.block`，不要另拼一遍 —— 另拼就会把
   * 「界面显示已读取、prompt 里只有文件名」这个旧缺陷请回来。
   *
   * @returns {string} refs 文本（可能为空串）
   */
  function collectRefs() {
    return refPlan.block;
  }

  /**
   * 把最后一条「正在写」气泡就地改成显式错误。
   *
   * 【为什么必须有这个函数，而不是等 useEffect 结算】
   *   `backgroundJobs.js` 在 0.21.15 之后加了「同 key 不并发」：`startJob` 在任务已跑时会
   *   **直接返回 `{ok:false, code:'JOB_BUSY'}`，且完全不碰 store**（不写 busy、不动 at）。
   *   而我的结算逻辑全部挂在 `useEffect([job.at, job.busy, ...])` 上 —— `at` 没变 ⇒ effect
   *   不会跑 ⇒ 那条「正在写」气泡**永远停在 pending**。
   *   那正是老板说的「生一半就中断掉了」的观感，只是换了个触发点。所以这条路径必须显式兜住。
   *
   * @param {string} message 给用户看的一句话原因
   * @param {string} [code] 拒绝码（JOB_BUSY / JOB_NO_KEY / JOB_NO_FN），交给统一归类
   * @returns {void}
   */
  function failLastPending(message, code) {
    // 【第二十二轮·老板第 5 条 a】不再把这句拒绝原文裸着塞进气泡，而是走统一归类：
    // 「上一次还在跑：…」/「失败了：…」抬头两两不等，用户能分辨是哪一类。
    const desc = describeFailure({ code, message });
    const text = String(desc.text || '').trim() || '没能开始生成，点「重试」再来一次。';
    setTurns((prev) => {
      const idx = prev.map((t) => t.status).lastIndexOf('pending');
      if (idx < 0) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], status: 'error', error: text, refs: '' };
      return next;
    });
  }

  /**
   * **发送 = 立即开始生成**（老板需求 5 的 B 项）。
   *
   * 一次动作做完五件事，中间不需要第二次点击：
   *   ① 用户那句话进对话流；② 立刻挂一条「正在写」气泡（0 延迟反馈）；
   *   ③ 清空输入框（说完就发出去，跟任何对话框一样）；
   *   ④ 把"问的是哪一句"落盘（组件被重建后凭 job.at 认回来）；
   *   ⑤ 交给 backgroundJobs 真跑 —— 页面切走、企业切换都不影响它跑完。
   *
   * @param {string} [textOverride] 重试时直接给主题（不给就读输入框）
   * @returns {void}
   */
  function send(textOverride) {
    const topic = String(textOverride == null ? goal : textOverride).trim();
    if (!topic) {
      setFormError('先说一句想写什么 —— 比如「春季种植体优惠活动」，说完豆芽直接开始写。');
      return;
    }
    // `busy` 是渲染闭包里的值，同一 tick 内连发两次回车时两次都会读到 false。
    // `sendingRef` 是同步锁，补上这个窗口（否则会起第二个 run，前一个的 pending 永远不结算）。
    if (busy || sendingRef.current) return;

    const mode = switchTab === 'wenan' ? 'wenan' : 'daily';
    const refs = collectRefs();
    const sentAt = Date.now();

    setFormError('');
    setTurns((prev) => ([
      ...prev,
      { id: nextId('u'), role: 'user', text: topic, mode, at: sentAt },
      {
        id: nextId('a'), role: 'assistant', status: 'pending', topic, mode, refs, at: sentAt,
      },
    ]));
    setGoal('');
    writeLastRequest(jobKey, { topic, mode, sentAt, jobAt: 0 });
    consumedAt.current = 0;
    sendingRef.current = true;
    // 先清掉上一轮的 result/error：backgroundJobs 在 busy 期间会保留旧 result，
    // 不清的话"重新生成"的那几秒里，旧稿还挂在 store 上，逻辑一抖就会把旧稿当新稿结算。
    clearJob(jobKey);

    /**
     * 不 await：先把「正在写」渲染出去，任务本体在全局 store 里跑（这就是"切页不丢"的来源）。
     *
     * ★ `timeoutMs` 必须由**本模块**显式给定，不能吃 store 的默认值：
     *   `backgroundJobs.js` 的 `DEFAULT_JOB_TIMEOUT_MS = 120000`，而它的计时器在 taskFn
     *   **之前**就启动 ⇒ 会先于我在 contentChat 里的 180s 触发，用一句泛泛的
     *   「超过 120 秒没返回」把我这边更可操作的文案（"切成日常内容先出快稿"）挤掉。
     *   更关键的是：那是别人文件的默认值，随时可能被调小（调到 60s 我这页就废了）。
     *   所以外圈取**内圈 + 30s**，让内圈永远先说话，外圈只做兜底。
     */
    Promise.resolve(startJob(jobKey, () => generateContentCopy({
      geoProxy,
      companyId: currentCompany ? currentCompany.id : '',
      topic,
      mode,
      refs,
      asset,
    }).then((r) => (
      // ★【第二十三轮】把服务端的「本次被上限截断」标记翻成一句 note 带出去。
      //   通道只有三条 —— `backgroundJobs.js` 的 `settle` 只持久化
      //   `result` / `error` / `note`（该文件 198-205 行）：
      //     · `result` 已经被正文占用（`hasResult ? r.result : r.content`）；
      //     · `error` 一写就会被界面当成失败（正文会被丢掉）；
      //     · ⇒ 只能用 `note`。结算时再从 `job.note` 取回到那条 assistant turn 上。
      //   ⚠️ 只在**成功且真截断**时改返回值；其它情况原样透传，绝不碰 error 分支。
      r && r.ok && r.truncated === true ? { ...r, note: TRUNCATED_NOTE } : r
    )), { timeoutMs: CONTENT_CHAT_TIMEOUT_MS + CONTENT_CHAT_TIMEOUT_MARGIN_MS }))
      .then((r) => {
        // 只有"压根没启动"的三种拒绝会走到这里（store 没动过 ⇒ effect 收不到）。
        // 正常失败/超时都会由 store 落终态，交给上面的 useEffect 统一结算，避免双重结算。
        if (r && r.ok === false
          && (r.code === 'JOB_BUSY' || r.code === 'JOB_NO_KEY' || r.code === 'JOB_NO_FN')) {
          sendingRef.current = false;
          failLastPending(r.error, r.code);
        }
      })
      .catch(() => { sendingRef.current = false; });
  }

  /**
   * 把后台任务的状态**结算进对话流**。这是"生一半就中断"的第二半修复：
   *   · busy  → 界面上必须有且只有一条「正在写」气泡（组件被重建过就补一条，见 ①）；
   *   · 结束  → 「正在写」必须被换成结果或错误（见 ②③），不允许它留在 pending。
   * 依赖里只放 job 的四个标量，避免 job 对象换引用时重复结算。
   */
  useEffect(() => {
    const at = Number(job && job.at) || 0;
    if (!at) return;

    // ① 正在跑
    if (job && job.busy) {
      // 组件被重建过（切模块 / 切企业）时 ref 会归 false，但任务确实在跑 ⇒ 同步回锁上，
      // 让 `busy` 与 `sendingRef` 两个判据不会互相打架。
      sendingRef.current = true;
      setTurns((prev) => {
        if (prev.some((t) => t.status === 'pending')) return prev;
        const saved = readLastRequest(jobKey);
        const topic = saved && saved.topic ? saved.topic : '';
        const mode = saved ? saved.mode : modeRef.current;
        const out = [];
        // 组件被重建过（切模块 / 切企业）：把"问的那句"也补回来，否则只剩一个没有问题的答案
        if (topic && !prev.some((t) => t.role === 'user' && t.text === topic)) {
          out.push({
            id: 'u-restore-' + at, role: 'user', text: topic, mode, at,
          });
        }
        out.push({
          id: 'a-restore-' + at, role: 'assistant', status: 'pending', topic, mode, refs: '', at,
        });
        return [...prev, ...out];
      });
      return;
    }

    // ② 已经结算过同一个 job.at
    if (consumedAt.current === at) return;

    const content = job && job.result != null ? String(job.result) : '';
    const err = job && job.error ? String(job.error) : '';
    if (!content && !err) return; // 空 job（例如刚 clearJob 完）：什么都不做
    /**
     * 【第二十三轮】`job.note` —— 结算时一起带到那条 assistant turn 上。
     *
     * 目前它承载的唯一业务语义是「本次输出被上限截断」（`TRUNCATED_NOTE`，见 `send()`）；
     * `backgroundJobs.js` 里还会给它写「已完成 / 失败 / 超时 / 异常」，那些是**任务状态**，
     * 不是"内容不完整"，所以只落到 `done` 的 turn 上（错误气泡已经有自己的抬头），
     * 渲染侧再按「含『上限』二字」决定要不要多渲染一行提示（见气泡里 `.co-msg-limit`）。
     */
    const note = job && job.note ? String(job.note) : '';
    consumedAt.current = at;
    // 任务已落终态 ⇒ 放开同步发送锁（不放开的话下次点发送会被自己挡住，界面像"死了"）。
    sendingRef.current = false;

    const saved = readLastRequest(jobKey);
    /**
     * 认领判据：这次落地的结果，是不是「本页该展示的那一次」？
     *
     * 【它防什么】不能把**别处的旧结果**冒充成"刚写的这篇"。典型场景：本页 A 跑完、
     *   记录里 `jobAt = atA`；随后别处（另一窗口 / 上一次会话）留下的更旧结果若被读到，
     *   直接把旧稿贴到对话流里，用户会以为"我刚写的那篇就是这个"。
     *
     * 【为什么判据是 `at >= savedAt` 而不是原来的 `savedAt === at`】—— 实测到的两个坑：
     *   ① **会静默丢结果**：`writeLastRequest` 内部 try/catch 吞掉 localStorage 配额错误。
     *      一旦那次写失败，`savedAt` 会**停在上一轮的值**（比本次 at 小）⇒ 原判据 `=== at`
     *      恒 false ⇒ 没有 pending 时直接 `return prev` ⇒ 结果**永远落不下来**，
     *      而界面上连一句错误都没有。这正是老板说的「生一半就中断」，只是根因在判据里。
     *   ② **重建场景认不回自己的结果**：切模块 / 切企业后重挂，本挂载的 `consumedAt` 从 0 起，
     *      但记录可能已被写成别的值；原判据会让"我自己刚跑完的那篇"被判成别人的。
     *   ⇒ 改成**单调比较**：`store 的 at` 只要**不早于**记录的那次，就认为它是本页要展示的最新结果。
     *      真正该拒绝的只有一种：store 里的 at **更旧**（回退/串台），那才跳过。
     *
     * @type {boolean}
     */
    const savedAt = saved && saved.jobAt ? Number(saved.jobAt) || 0 : 0;
    const mine = !savedAt || at >= savedAt;
    if (saved && mine) writeLastRequest(jobKey, { jobAt: at });

    setTurns((prev) => {
      const idx = prev.map((t) => t.status).lastIndexOf('pending');
      if (idx >= 0) {
        // 更旧的结果不许覆盖更新的「正在写」气泡（否则一条过期的 at 会把新请求就地结掉）。
        if (!mine) return prev;
        const next = prev.slice();
        next[idx] = err
          ? { ...next[idx], status: 'error', error: err, refs: '' }
          : {
            ...next[idx], status: 'done', text: content, refs: '', note,
          };
        return next;
      }
      if (!mine) return prev;
      const out = [];
      const topic = saved && saved.topic ? saved.topic : '';
      const mode = saved ? saved.mode : modeRef.current;
      if (topic) {
        out.push({
          id: 'u-hyd-' + at, role: 'user', text: topic, mode, at,
        });
      }
      out.push(err
        ? {
          id: 'a-hyd-' + at, role: 'assistant', status: 'error', error: err, topic, mode, at,
        }
        : {
          id: 'a-hyd-' + at, role: 'assistant', status: 'done', text: content, topic, mode, at, note,
        });
      return [...prev, ...out];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobKey, job && job.busy, job && job.at, job && job.result, job && job.error, job && job.note]);

  /**
   * 【第二十二轮 · 老板第 4 条】原先这里每次多一条消息就 `logRef.scrollIntoView(...)`。
   * 两个问题被老板第 4 条一并暴露：
   *   ① 它滚的是**整页**（outer page），用户在对话流里往上翻历史时，新消息一到整页又被拽走；
   *   ② 没有"回顶部/回最新"入口，长文只能一路滑。
   *
   * 【第二十三轮 · 更正上一轮的一句错话 —— 别再照抄】
   *   上一轮在这段注释末尾写的是：「对话流紧跟创作卡下方，用户刚在卡里说完就在原地看得到，
   *   不再需要整页滚动这一步。」—— **这句是错的**，老板本轮反馈的就是它的后果。
   *   错在哪：那句话把「DOM 上相邻」当成了「视觉上可见」。而当时
   *   `.co-card.co-chat{min-height:56vh}`（round16-content.css 第 250 行）+
   *   `.co-log-body{max-height:62vh}`（同文件第 317 行）= 118vh > 100vh，
   *   对话流**整体在首屏以下** ⇒ 说完话页面不动、答案在屏幕外。
   *   所以本轮补下面这段**容器内**贴底（不是整页滚动）：
   *     · `onScroll` 维护 `atBottomRef`（距底 < 80px 记为"在底部"）；
   *     · `turns.length` 变化时：在底部 → 直接写 `scrollTop = scrollHeight`；
   *       不在底部 → **什么都不做**（用户正在翻历史，不许把他拽走）；
   *     · 首次渲染 / 组件重建恢复历史 → 直接把 `scrollTop` 设到底。
   *   ⚠️ 全程**不用 `scrollIntoView`** —— 它滚的是外层页面，正是本轮要修的症状。
   *   ⚠️ 与 <ScrollNav> 的分工：ScrollNav 负责"回顶部 / 回最新"两个按钮与未读数，
   *      本 effect 负责"新消息到达时贴不贴底"。两者都直接写 `scrollTop`，都只动这个容器。
   */
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const toBottom = () => {
      // 直接赋 scrollTop（不用 scrollTo/scrollIntoView）：只影响这个滚动容器本身。
      el.scrollTop = Number(el.scrollHeight) || 0;
      atBottomRef.current = true;
    };
    // ① 第一次渲染 / 组件重建（切模块、切企业）恢复历史：直接贴底，别让用户先看到最上面
    if (!firstPaintRef.current) {
      firstPaintRef.current = true;
      toBottom();
      return;
    }
    // ② 新消息到达：只有用户本来就在底部时才贴底
    if (atBottomRef.current) toBottom();
    // 依赖只放条数：正文在同一条里变长的情况本链路不存在（整包 JSON 一次返回）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length]);

  /**
   * 维护「用户是不是贴着底部」。
   *
   * 阈值 80px（比 ScrollNav 的 24px 宽）：这里判的是"新消息来了要不要自动贴底" ——
   * 只差几十像素的抖动算"在看最新"，而真的往上翻了半屏的用户绝不能被拽回来。
   * @param {Object} e React 的合成 scroll 事件
   * @returns {void}
   */
  function handleLogScroll(e) {
    const el = (e && e.currentTarget) || logRef.current;
    if (!el) return;
    const scrollTop = Number(el.scrollTop) || 0;
    const scrollHeight = Number(el.scrollHeight) || 0;
    const clientHeight = Number(el.clientHeight) || 0;
    // jsdom 里三个值恒为 0 ⇒ distance = 0 ⇒ 判定为"在底部"，与真浏览器首次加载的观感一致。
    const distance = scrollHeight - clientHeight - scrollTop;
    atBottomRef.current = distance < 80;
  }

  /**
   * 输入框回车 = 发送（老板需求 5 的 B 项）。
   * ⚠️ 三个不发的例外都要挡住，否则中文输入会出事：
   *   · Shift+回车 → 换行（用户想写多行）；
   *   · 输入法选词中的回车（isComposing）→ 那是"选字"，不是"发送"；
   *   · 正在写 → 不发（同一时间只跑一篇，避免两个请求互相覆盖结果）。
   */
  function handleKeyDown(e) {
    if (!e || e.key !== 'Enter') return;
    if (e.shiftKey) return;
    if (e.nativeEvent && e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  }

  /**
   * 失败那条的「重试」：**把这一轮摘掉再重发**，不在下面叠一条新的。
   * 为什么不是简单再 send 一次：那样用户会看到"同一个问题、两条回答，一条还是红的"，
   * 分不清哪条是有效的；重试的语义是"这一次再来一遍"，本来就该替换。
   * 只摘「这条 + 它前面那条用户消息」，其它轮次一条不动。
   * @param {Object} turn 失败的那条 assistant 消息
   * @returns {void}
   */
  function retryTurn(turn) {
    const topic = String((turn && turn.topic) || '').trim();
    if (!topic || busy) return;
    setTurns((prev) => {
      const idx = prev.findIndex((t) => t.id === (turn && turn.id));
      if (idx < 0) return prev; // 已经被结算/替换过：别把别人的消息误删
      const start = idx > 0 && prev[idx - 1].role === 'user' ? idx - 1 : idx;
      return prev.filter((_, i) => i < start || i > idx);
    });
    send(topic);
  }

  /** 复制一篇全文。 */
  async function copyTurn(text) {
    const ok = await copyPlainText(text);
    if (ok) message.success('已复制全文');
    else message.error('复制失败，请手动选中文本复制');
  }

  /** 存入项目产出（与工作台同名能力，落到同一套 assetStore）。 */
  function saveTurn(turn) {
    if (!currentCompany) {
      message.warning('当前没有企业上下文，无法保存');
      return;
    }
    const label = String((turn && turn.topic) || '').trim() || '内容创作';
    const name = `新媒体文案 · ${label.slice(0, 40)}`;
    addAsset({
      type: 'copy',
      companyId: currentCompany.id,
      projectId: currentProject ? currentProject.id : null,
      name,
      content: String((turn && turn.text) || ''),
      tags: ['文案', '内容创作'],
    });
    setSavedTurnId(turn.id);
    message.success('已存入项目产出，并同步到企业大脑');
  }

  /**
   * 输入框底部的模型胶囊：只换 prompt 模板，**不滚动**（用户还在写，跳走等于打断输入）。
   * 和下方大切换共用 state，所以两边永远同步亮。
   */
  function pickMode(k) {
    if (k !== 'daily' && k !== 'wenan') return;
    setSwitchTab(k);
  }

  /**
   * 下方大切换（老板第 6 条「点击下滑切换」）。三件事一起做才像"下滑切换"：
   *   ① 换面板内容 + 换生成 prompt（同一个 state）；② 平滑滚到内容区顶部；③ 入场下滑动画（CSS 的 co-drop，靠 key 重放）。
   * scrollIntoView 在 jsdom 里不存在 ⇒ try/catch，别让门禁环境因为一个视觉动作炸掉。
   */
  function switchTo(k) {
    if (k !== 'daily' && k !== 'wenan') return;
    setSwitchTab(k);
    try {
      if (switchRef.current && switchRef.current.scrollIntoView) {
        switchRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch { /* jsdom 无此 API */ }
  }

  const doneCount = turns.filter((t) => t.status === 'done').length;
  const errCount = turns.filter((t) => t.status === 'error').length;

  return (
    <div className="co-cols">
      {/* ===== 主列（参考图左 2/3）===== */}
      <div className="co-wrap">
        {/* 2026-10-18 第十六轮：删「日常内容 / 精品文案」两张独立入口卡（老板原话
            「不要分日常内容和精品文案」）—— 两者合并为下方「开始创作」卡里的
            模型选择器（日常内容 / 精品文案），在这里切 prompt，不再分家。 */}
        {/* 版式说明条（设计系统 v3 .r15-note 同款） */}
        <div className="r15-note">
          <LineIcon name="layers" size={13} />
          <span>第十六轮：分类页签已删 · 模型选择移入创作框下方，切 prompt 不切页面</span>
        </div>

        {/* ===== 一张对话卡：结果在上滚动 · 输入在下贴底 =====
            老板反复投诉的原话：「文案生成 输出的和对话框合并这个」/「现在内容创作点击后
            并不是在对话框里生成（对话框的意义何在？？）」。
            改前这里是**两张独立的 co-card**：输入卡 .co-card.co-chat（max-width 860）
            + 结果卡 .co-card.co-log（max-width 1120、margin-top 14）——
            两个宽度、两个圆角、两个边框、两个阴影，竖着叠在一起，用户看到的是
            "上面一个框写字，下面另起一个框看结果"，不是对话框。
            本轮把两张合成**一张**：一个外框，内部三段
              ① .co-chat-hd       标题行（flex 0 0 auto，永不收缩）
              ② .co-log-body      结果区（**唯一**滚动体：flex 1 1 auto / min-height 0 / overflow-y auto）
              ③ .co-chat-composer 输入区（flex 0 0 auto，贴在卡底，结果再多也挤不下去）
            ⇒ 观感 = 一个对话框：上面滚历史，下面写下一句。

            ⚠️ 只动渲染结构与 CSS：数据流（setTurns / startJob / 结算 useEffect）一个字没改。
            ⚠️ 门禁锚点全部原样保留，只是 data-co-log / -done / -err / -max 这四个
               从"另一张卡"搬到了**这张**卡上 —— 门禁按 [data-co-log] 取轮数，
               不能跟着那张卡一起消失（scripts/smoke/entry-interact.jsx 读它）。
            ⚠️ DOM 顺序必须是「结果在前、输入在后」：unit-copy-merge 第 3 条按
               data-co-chat-input 是否排在 data-co-log-body 之后来判"输入贴在结果下方"。 */}
        <section
          className={'co-card co-creator co-chat' + (logMax ? ' co-log-max' : '')}
          data-co-creator="1"
          data-co-chat-busy={busy ? '1' : '0'}
          data-co-log={turns.length}
          data-co-log-done={doneCount}
          data-co-log-err={errCount}
          data-co-log-max={logMax ? '1' : '0'}
        >
          <div className="co-chat-hd">
            <img className="co-chat-avatar" src={douyaMascot} alt="" aria-hidden="true" />
            <span className="co-chat-hello">想让我写点什么？</span>
            {/* 原来「创作对话 / 已写完 N 篇」是另一张卡的标题行文字，现在并到同一个标题行里：
                不再有第二个框去解释"下面这堆是什么"，它就在这张卡里。 */}
            {turns.length > 0 ? (
              <span className="co-log-note" data-co-log-note="1">
                {busy
                  ? '豆芽正在写 —— 可以切页面，回来结果还在'
                  : `已写完 ${doneCount} 篇${errCount ? `，${errCount} 篇没成功（下面可以重试）` : ''}`}
              </span>
            ) : null}
            <span className="co-chat-hint" data-co-chat-hint="1">
              说完直接开始写 · 回车发送，Shift+回车换行
            </span>
            {/* 【全屏展开】「展开 / 收起」。
                ⚠️ 必须是 `span role="link"`，不许换成 <button> 或 antd Button：
                  首屏按钮棘轮按 `container.querySelectorAll('button').length` 数，
                  而它在首屏（turns=0）**条件渲染不成立**，天然不进基数；
                  真写成 button 会在有结果时改变按钮口径，既不必要也不安全。
                ⚠️ 合并卡片后它的渲染条件仍是 turns.length > 0（与改前完全一致），
                  所以按钮基数一个都没变。 */}
            {turns.length > 0 ? (
              <span
                className="co-log-max-btn"
                role="link"
                tabIndex={0}
                data-co-log-max-btn="1"
                onClick={() => setLogMax((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLogMax((v) => !v); } }}
              >
                {logMax ? '收起' : '展开'}
              </span>
            ) : null}
          </div>

          {turns.length > 0 ? (
            <div className="co-log-body" ref={logRef} data-co-log-body="1" onScroll={handleLogScroll}>
              {turns.map((t) => (t.role === 'user' ? (
                <div className="co-msg co-msg-user" key={t.id} data-co-msg="user">
                  <div className="co-msg-user-t">{t.text}</div>
                  <div className="co-msg-meta">{t.mode === 'wenan' ? '精品文案' : '日常内容'}</div>
                </div>
              ) : (
                <div
                  className={'co-msg co-msg-ai' + (t.status === 'error' ? ' bad' : '')}
                  key={t.id}
                  data-co-msg="ai"
                  data-co-msg-status={t.status}
                >
                  {/* 【第二十二轮·老板第 5 条 c】「正在写」要**显眼**：三点跳动 + 文字「生成中」
                      + 「已等 N 秒」。旧版是一行灰字小点，用户根本扫不到（老板原话「不明显」）。
                      `data-co-msg-pending` 保留 —— 既有门禁按它判"pending 有没有收敛"。 */}
                  {t.status === 'pending' ? (
                    <div className="co-msg-pending" data-co-msg-pending="1">
                      <ChatGenerating text="生成中，豆芽正在写…（写完自动出现在这里，切页面也不会丢）" />
                    </div>
                  ) : null}

                  {t.status === 'done' ? (
                    <>
                      <div className="co-msg-body" data-co-msg-body="1"><Markdown>{t.text}</Markdown></div>
                      {/* 【第二十三轮】内容被上限截断时，正文下面补一行小字。
                          判据是「turn.note 里出现『上限』二字」—— note 由云端标记
                          `truncated` 经 contentChat → job.note 带上来（见 send() 与结算 effect）。
                          为什么必须显式说出来：老板上一轮抱怨的"生一半就中断"，一半是结构问题，
                          另一半是**半篇稿子看起来像整篇**——用户不知道是自己没要到还是被截了。 */}
                      {String(t.note || '').indexOf('上限') >= 0 ? (
                        <div className="co-msg-limit" data-co-msg-limit="1">
                          已写到本次上限，内容可能不完整
                        </div>
                      ) : null}
                      <div className="co-msg-ops">
                        <Button size="small" type="primary" onClick={() => { copyTurn(t.text); }}>复制全文</Button>
                        <Button size="small" onClick={() => saveTurn(t)} disabled={!currentCompany}>
                          {savedTurnId === t.id ? '已保存 ✓' : '存入产出'}
                        </Button>
                        {t.topic ? (
                          <Button size="small" onClick={() => send(t.topic)} disabled={busy}>用同一句重写</Button>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  {t.status === 'error' ? (() => {
                    // 【第二十二轮·老板第 5 条 a】失败要**分类说清**：抬头（超时 / 连不上 /
                    // 鉴权 / 服务端 / 你已取消 / 没拿到内容）两两不等，正文保留接口原始原因。
                    // 旧版只有一句「⚠️ 这篇没写完」+ 原始错误，用户分不出"该等"还是"该改配置"。
                    const fail = describeFailure({ message: t.error });
                    return (
                      <>
                        <div className="co-msg-err" data-co-msg-error="1" data-chat-failure={fail.kind}>
                          <span className="co-msg-err-t">⚠️ 这篇没写完 · {fail.headline}</span>
                          <span className="co-msg-err-d">{fail.text}</span>
                          <span className="co-msg-err-d">{fail.next}</span>
                        </div>
                        <div className="co-msg-ops">
                          {t.topic ? (
                            <Button size="small" type="primary" onClick={() => retryTurn(t)} disabled={busy}>重试</Button>
                          ) : null}
                        </div>
                      </>
                    );
                  })() : null}
                </div>
              )))}
              {/* 【第二十二轮·老板第 4 条】回顶部 / 回最新（未读角标）。
                  放在滚动容器最后一个子节点：sticky 贴在容器可视底边，不占内容高度。 */}
              <ScrollNav
                scrollerRef={logRef}
                count={turns.length}
                revision={turns.length + (busy ? 1 : 0)}
                topLabel="回到最上面"
                latestLabel="回到最新"
              />
            </div>
          ) : (
            /* 空态：还没写过时，结果区给一句人话（不是空白一片），且**不渲染任何 data-co-msg**。
               为什么不做成按钮卡片：首屏按钮棘轮只许降不许升，提示用纯文字最安全。 */
            <div className="co-chat-empty" data-co-chat-empty="1">
              <span className="co-chat-empty-t">还没开始写</span>
              <span className="co-chat-empty-d">
                在下面说一句想写什么，回车就开写。结果直接出现在这张卡里，就在你这句话的正上方。
              </span>
            </div>
          )}

          {/* 输入区：flex 0 0 auto ⇒ 永远贴在卡底可见；结果变多时压缩的是上面那个
              .co-log-body（它 min-height:0，天生让得开），输入框一个像素都不缩。 */}
          <div className="co-chat-composer">
            <Input.TextArea
              className="co-ta co-chat-ta"
              data-co-chat-input="1"
              /* 【第二十三轮】6/16 → 8/18（老板「对话框是不是有点小」）。
                 ⚠️ 这两个 data-* 是门禁锚点（scripts/smoke/entry-interact.jsx 读它们断言
                 "输入框被加大过"）—— 只改下面 autoSize 不改这里，断言就会与实际不符。 */
              data-co-chat-minrows={8}
              data-co-chat-maxrows={18}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => handleKeyDown(e)}
              autoSize={{ minRows: 8, maxRows: 18 }}
              placeholder={'直接说，比如：\n围绕春季种植牙优惠活动，突出「三人成团立减 500」，写一条公众号推文'}
            />

            <div className="co-chat-foot">
              {/* 模型胶囊。出处是**第十六轮**，不是第 6 条 —— 两个控件各有各的老板出处，
                  删任一个都会让一句原话落空，所以两个都留。
                  【证据分级（本项目硬规矩 E17）：**加了引号就必须能指到某份文档某一行；
                    指不到就改成转述** —— 转述可以被质疑，引文不会。】
                  · 第十六轮（本控件）：**只有一份手抄记录** —— `src/renderer/styles/ia-content.css`
                    的注释里当年记下的原句「输入框下面做一个模型选择 日常内容/精品文案 在这里进行prompt的切换」。
                    ⚠️ 手抄件不是原件：我们手上没有第十六轮的原始需求文件，所以这条的引文强度**低于**第 6 条
                    （后者本轮从老板手上逐字抄进了对照表，属于原件级）。承认这个差距，比含糊过去安全。
                    `docs/0.21.7-变更说明.md:11-12` 也写着「输入框下面做模型选择…在这里进行 prompt 模板切换」，
                    但那是**我们自己写的变更说明（转述）**，不许拿它当老板原话引用。
                  · 第 6 条（下方大切换）：**逐字原文**「内容创作 开始创作这里做成对话的形式 占比再大一些，
                    并且下面日常内容 和 精品文章 作为点击下滑切换的那种形式，删除选择模板 和风格」。
                    出处 = `docs/0.21.9-需求对照表.md` 的**第 6 条表行**（`grep -n '^| 6 |'` 可定位）。
                    ⚠️ 行号会随对照表增删漂移，所以按「表行 + grep 锚点」写，不按行号写。
                    它管的是**下方**「点击/下滑切换」那一个，**里面没有「模型胶囊」**。
                  ⚠️ 留档（team-lead 2026-10-19 逐字核出）：这里原先写的是「老板第 6 条原文要求
                  『底部…日常内容/精品文章胶囊 + 开始创作主按钮』」—— 那句**不是第 6 条的原话**，
                  是本轮自己的一段归纳被误当成了引文。**引号里的字必须逐字来自被引的那一条。**
                  ⇒ 为什么这比不写出处更危险：用引号包住一段不属于该轮的原话，读者看到「原文要求」
                  四个字就会停止思考；而这句话恰好是支撑「不许删这个控件」的**决策依据**。
                  两个控件读写同一个 switchTab，点哪边另一边都亮 —— 不再出现"上面亮日常、下面选了精品"的自相矛盾。
                  data-co-model 锚点是老约定（unit-usage-pick 系列在读），保留。 */}
              <div className="co-mode-pill" data-co-model-pick={MODEL_OPTIONS.length} role="radiogroup" aria-label="模型选择">
                {MODEL_OPTIONS.map((m) => (
                  <button
                    type="button"
                    key={m.value}
                    role="radio"
                    aria-checked={switchTab === m.value}
                    className={'co-mode-pill-btn' + (switchTab === m.value ? ' on' : '')}
                    data-co-model={m.value}
                    data-co-model-on={switchTab === m.value ? '1' : '0'}
                    title={m.desc}
                    onClick={() => pickMode(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="co-spacer" />
              {/* 「使用企业资料」保留：它控制的是生成时读不读企业资料的真实开关，不是装饰。
                  【0.21.28】清单改为 **Popover 浮层**（`content={refPanel}`），不再占卡片高度 ——
                  完整推导见 `refPanel` 上方的注释块。
                  ⚠️ 这里的结构与锚点**刻意不变**：
                    · 仍然是 `span role="link"` + `tabIndex`，**不许**换成 `<button>` 或 antd Button
                      —— 首屏按钮棘轮按 `button` 计数（`scripts/smoke/unit-firstscreen.mjs`，
                      content 登记值 6 里不包含它），换成真按钮就是**凭空加一个**，棘轮只许减不许增。
                    · `co-tool` 类名与「使用企业资料（N/4 项已有）」文案不变（`filledCount` 仍在算）。
                  ⚠️ 交互只保留**一个**切换来源：鼠标走 Popover 的 `trigger="click"` →
                  `onOpenChange` → `setRefProfile`；键盘走 `onKeyDown`。**span 上不要再挂
                  `onClick` 切换** —— 两处都切会互相抵消（点一下开、同一下又关，表现是"点不动"）。 */}
              <Popover
                trigger="click"
                placement="topLeft"
                open={refProfile}
                onOpenChange={(v) => setRefProfile(!!v)}
                content={refPanel}
                overlayClassName="co-ref-pop"
                /* 关掉时不销毁：① 清单的 `data-co-refprofile` 锚点在再次打开前仍可查；
                   ② 反复开关不必重新挂载（4 行资料，重建没有意义）。 */
                destroyOnHidden={false}
              >
                <span
                  className={'co-tool' + (refProfile ? ' on' : '')}
                  role="link"
                  tabIndex={0}
                  aria-expanded={refProfile ? 'true' : 'false'}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRefProfile((v) => !v); } }}
                >
                  使用企业资料{filledCount ? `（${filledCount}/4 项已有）` : '（还没填）'}
                </span>
              </Popover>
              {/* 这一个按钮既是"开始创作"也是"发送"：老板要的是"输入后就自动开始生成"，
                  回车已经能做到；按钮保留是给不习惯回车的人，也是老断言
                  「能力没删：首屏仍有开始创作入口」的落点（unit-firstscreen 的 content 按钮基数不变）。 */}
              <Button
                type="primary"
                className="co-start-btn"
                onClick={() => send()}
                disabled={busy}
                loading={busy}
              >
                {busy ? '正在写…' : '开始创作'}
              </Button>
            </div>

            {/* 【0.21.28】这里原来内联渲染 `{refProfile && <div className="co-ref" data-co-refprofile="1">…}`
                —— 已整段搬到上方 `refPanel` 常量里、由 `.co-tool` 的 Popover 承载。
                **不许**在这里再渲染一份：两份同 id 锚点会让"清单到底在不在卡里"这件事失去判据，
                而且卡内那一份正是把卡片撑破、被 `overflow: hidden` 裁掉的东西。 */}

            {formError ? <div className="co-chat-err" data-co-chat-error="1">⚠️ {formError}</div> : null}

            {(files.length > 0 || goal.trim()) && (
              <div className="co-chips">
                {goal.trim() ? <Tag className="co-chip">主题已写</Tag> : null}
                {/* ⚠️ `files` 自 0.21.26 起是**条目对象**而不是字符串：这里必须取 `entry.name`，
                    直接 `{entry}` 会渲染成 [object Object]（改了 state 形状就必须把每个消费点都改到）。
                    `title` 挂上状态文案，鼠标悬停能看出这个文件到底读没读到正文。 */}
                {files.map((entry, i) => (
                  <Tag
                    className="co-chip"
                    key={entry.id || (entry.name + '@' + i)}
                    title={(refPlan.items[i] || {}).text || ''}
                  >
                    {entry.name}
                  </Tag>
                ))}
              </div>
            )}
          </div>
        </section>
        {/* ===== 日常内容 / 精品文章：点击 → 下滑切换（老板第 6 条）=====
            老板原话：「日常内容/精品文章点击下滑切换」。
            三个动作是一个整体，缺一个就不像"切换"：
              ① 换内容；② 平滑滚到内容区顶部；③ 内容区入场下滑动画（@keyframes co-drop）。
            daily 面板 = 内容类资产的最近记录（文案「最近的快稿」）+ 去日常运营入口；
            wenan 面板 = 同一批记录里标题更长的（文案「最近的精品稿」）。
            两块都只读真实资产（assets），没有就老实显示示例/空态，不造假数据。 */}
        <section className="co-card co-switch" data-co-switch="1">
          <div className="co-switch-tabs" role="tablist" aria-label="日常内容或精品文章">
            <button
              type="button"
              role="tab"
              aria-selected={switchTab === 'daily'}
              className={'co-switch-tab' + (switchTab === 'daily' ? ' on' : '')}
              data-co-switch-tab="daily"
              data-co-switch-on={switchTab === 'daily' ? '1' : '0'}
              onClick={() => switchTo('daily')}
            >
              日常内容
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={switchTab === 'wenan'}
              className={'co-switch-tab' + (switchTab === 'wenan' ? ' on' : '')}
              data-co-switch-tab="wenan"
              data-co-switch-on={switchTab === 'wenan' ? '1' : '0'}
              onClick={() => switchTo('wenan')}
            >
              精品文章
            </button>
          </div>

          <div className="co-switch-body" ref={switchRef}>
            {/* key 跟着 switchTab 变 ⇒ 每次切换都重新挂载 ⇒ 动画会重放（不是只播一次）。 */}
            <div
              className="co-switch-panel co-drop"
              key={switchTab}
              data-co-switch-panel={switchTab}
              data-co-recent={recent.length}
            >
              <div className="co-sec-hd">
                <span className="co-sec-t">{switchTab === 'daily' ? '最近的快稿' : '最近的精品稿'}</span>
                {switchTab === 'daily' ? (
                  <span
                    className="co-sec-more"
                    role="link"
                    tabIndex={0}
                    data-co-godaily="1"
                    onClick={() => onSelectModule && onSelectModule('daily')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onSelectModule) onSelectModule('daily'); } }}
                  >
                    去日常运营 ›
                  </span>
                ) : (
                  <span className="co-sec-note">长文 / 深度稿</span>
                )}
              </div>

              {switchList.length === 0 ? (
                <>
                  <div className="co-list" data-co-recent-demo="1">
                    {DEMO_RECENT.map((a) => (
                      <div className="co-row co-row-demo" key={a.name}>
                        <span className="co-row-ic"><LineIcon name={a.ic} size={15} /></span>
                        <span className="co-row-bd">
                          <span className="co-row-t">{a.name}</span>
                          <span className="co-row-d">{a.at}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="co-demo-note">示例记录。生成的第一篇会落在你这里。</div>
                </>
              ) : (
                <div className="co-list">
                  {switchList.map((a) => (
                    <div className="co-row" key={a.id} data-co-recent-item={a.name}>
                      <span className="co-row-ic"><LineIcon name={ASSET_ICON[a.type] || 'doc'} size={15} /></span>
                      <span className="co-row-bd">
                        <span className="co-row-t">{a.name}</span>
                        <span className="co-row-d">{ASSET_TYPES[a.type] || '内容'} · {fmtWhen(a.updatedAt || a.createdAt)}</span>
                      </span>
                      <span
                        className="co-row-go"
                        role="link"
                        tabIndex={0}
                        onClick={() => setGoal(a.name)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setGoal(a.name); } }}
                      >
                        再用一次
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
        {/* 第十五轮融合区已按设计系统 v3 移至 banner 下第一块（见文件上方 co-fused）。 */}
      </div>

      {/* ===== 右栏（参考资料上传 / 备用资料）=====

          【0.21.9 · 老板第 6 条】右栏只剩两块：参考资料上传（真读文件）、
          备用资料（企业资料里已填/未填的真值）。模板与风格选择器已删。 */}
      <aside className="co-rail">
        {/* 2026-10-18 第十六轮：「内容风格」卡已删（风格选择器在创作框内保留，
            是真传参）。原卡位改为「参考资料上传」—— 老板第 2 条需求。 */}
        <section className="co-rail-card" data-co-refs-upload="1">
          <div className="co-rail-t">参考资料上传</div>
          <div className="co-rail-note" style={{ margin: '0 0 8px' }}
            title="文本类文件会读取正文；word / pdf / Excel / PPT 本机没有解析器，需要把正文粘贴到下方输入框">
            文本类文件（txt / md / csv 等）会读取正文；word / pdf / Excel 请粘贴到下方。
          </div>
          <span
            className="co-ref-upload-btn"
            role="link"
            tabIndex={0}
            onClick={() => { pickRefFiles(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickRefFiles(); } }}
          >
            <LineIcon name="folder" size={14} />
            {refBusy ? '正在读取…' : '选择文件（txt / md / csv / 代码等文本类）'}
          </span>
          {/* 真实文件选择走 window.api.pickFiles()（拿绝对路径）→ window.api.readFileText()（读正文）。
              能读的扩展名真读正文；docx/doc/pdf/xlsx/xls/pptx/ppt 本机没有解析器，
              读了必是乱码 ⇒ 只标「未支持，请粘贴」，不假装读过。
              下面的 <input type=file> 仅作浏览器 / 无 preload 环境的回退：那里拿不到磁盘路径，
              只能登记文件名，状态会明确标「仅登记文件名」。 */}
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              // 回退路径：只有 File 对象、没有磁盘路径 ⇒ 只登记文件名，状态标 name-only。
              const picked = Array.from(e.target.files || [])
                .filter(Boolean)
                .map((f) => ({
                  ...makeRefEntry({ name: f.name, path: '' }),
                  status: 'name-only',
                }));
              if (picked.length) setFiles((prev) => [...prev, ...picked].slice(0, MAX_FILE_ENTRIES));
              e.target.value = '';
            }}
          />
          {files.length > 0 ? (
            <div className="co-ref-files" data-co-ref-files={files.length}>
              {files.map((entry, i) => {
                const item = refPlan.items[i] || { tone: 'muted', text: '读取中…' };
                const toneColor = item.tone === 'ok' ? 'var(--c-success)'
                  : item.tone === 'bad' ? 'var(--c-danger)'
                    : item.tone === 'warn' ? 'var(--c-warn)'
                      : 'var(--c-text-3)';
                return (
                  <div
                    className="co-ref-file"
                    key={entry.id || entry.name + '@' + i}
                    data-co-ref-status={item.tone}
                    style={{ alignItems: 'flex-start' }}
                  >
                    <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', height: 20 }}>
                      <LineIcon name="doc" size={12} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className="co-ref-file-n" title={entry.path || entry.name}>{entry.name}</span>
                      {/* 每个文件都必须看得见「到底读没读到正文」——不能只显示文件名。 */}
                      <span style={{ fontSize: 11, lineHeight: 1.5, color: toneColor }}>{item.text}</span>
                    </span>
                    <span
                      className="co-ref-file-x"
                      role="link"
                      tabIndex={0}
                      aria-label={'移除 ' + entry.name}
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFiles((prev) => prev.filter((_, j) => j !== i)); } }}
                    >
                      ×
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
          <Input.TextArea
            className="co-ref-ta"
            value={refText}
            onChange={(e) => setRefText(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={'或直接粘贴参考资料正文：\n产品卖点、活动规则、参考范文……\n豆芽生成时会带上这些。'}
          />
          <div className="co-rail-note">
            {files.length || refText.trim()
              ? `已带 ${files.length} 个文件，其中 ${refPlan.items.filter((it) => it.tone === 'ok').length} 个读到了正文`
                + `${files.some((it) => it && it.status === 'unsupported') ? '；有格式读不出正文，请把正文粘贴到下方' : ''}`
                + `${refText.trim() ? ' + 粘贴正文' : ''}，发送时会一起交给豆芽。`
              : '还没有参考资料。可以不填——企业资料里已填的项会自动带上。'}
          </div>
        </section>

        <section className="co-rail-card" data-co-refs="1">
          <div className="co-rail-t">
            备用资料
            <span
              className="co-rail-more"
              role="link"
              tabIndex={0}
              onClick={() => onSelectModule && onSelectModule('profile')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onSelectModule) onSelectModule('profile'); } }}
            >
              管理
            </span>
          </div>
          <div className="co-rail-list">
            {filledCount > 0 ? (
              profileRows.map((r) => (
                <div
                  className="co-rail-row"
                  key={r.k}
                  role="link"
                  tabIndex={0}
                  onClick={() => onSelectModule && onSelectModule('profile')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onSelectModule) onSelectModule('profile'); } }}
                >
                  <span className="co-rail-k">{r.k}</span>
                  <span className={'co-rail-v' + (r.v ? '' : ' empty')}>{r.v ? '已填' : '还没填'}</span>
                </div>
              ))
            ) : (
              DEMO_REFS.map((r) => (
                <div className="co-rail-row co-rail-row-demo" key={r.k} data-co-refs-demo="1">
                  <span className="co-rail-ic"><LineIcon name={r.ic} size={15} /></span>
                  <span className="co-rail-k">{r.k}</span>
                  <span className="co-rail-v">{r.v}</span>
                </div>
              ))
            )}
          </div>
          <div className="co-rail-note">
            {filledCount > 0
              ? `已填 ${filledCount}/4 项，生成时会读这些。`
              : '○ 示例资料。去企业大脑填好后，这里显示真实资料。'}
          </div>
        </section>

        <section className="co-rail-card co-rail-advice" data-co-advice="1">
          <div className="co-rail-t">需要更快的内容？</div>
          <div className="co-rail-text">
            一句一句说也行 —— 去豆芽助手直接讲你要什么，它按你的企业资料来写。
          </div>
          <span
            className="co-rail-link"
            role="link"
            tabIndex={0}
            onClick={() => onSelectModule && onSelectModule('workbench')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onSelectModule) onSelectModule('workbench'); } }}
          >
            去豆芽助手 ›
          </span>
        </section>
      </aside>
    </div>
  );
}

/* ============================================================================
 * 容器：页头 + 对话工作台
 *
 * 【0.21.15 · 老板需求 5】`view` state（'board' | 'gen'）**整体删除**。
 * 历史留档（别再加回来）：
 *   · 0.21.11 老板第 1 条「内容创作里面的生成文案是不是可以删了」删的是**页签**，
 *     当时改成「点开始创作 → 原地换成生成结果（NewMediaWorkbench）→ 左上角回到创作」。
 *     那次改动达到了"不并列占页签"，但代价是**多了一级整页替换**。
 *   · 0.21.15 老板明确「点击创作还会跳转到三级页 我不要那个三级页了」⇒ 那一级也删。
 *     NewMediaWorkbench 的能力一件没丢：生成（本页对话区直连同一接口，见
 *     services/contentChat.js）、复制、存入产出、参考资料、企业资料读取都在；
 *     完整表单工作台仍以 `xinmeiti` 入口在 App.jsx 可达（深链不破）。
 * ⚠️ 为什么另一个 NewMediaWorkbench 入口不算"两份真相"：它是**另一条交付路径**
 *   （类型/风格/平台/人设都要手调的整页表单），本页是"说一句话就出稿"的对话路径。
 *   本轮**没有**在两个模块之间来回传 state —— 对话区自己持有自己的对话流，
 *   生成结果只落在 backgroundJobs 的一个 key 上，不存在第二份正文。
 * ========================================================================== */
export default function ContentOps({ geoProxy, onSelectModule }) {
  const { asset } = useMarketingAsset();
  const { assets, addAsset } = useAssets();
  const { currentCompany, currentProject } = useCompany();

  const companyId = currentCompany ? currentCompany.id : '';
  // 0.21.15：生成键按企业隔离。不用 `wenan-` 前缀 —— 那个前缀在 BackgroundJobsBar 里
  // 指向新媒体工作台整页，点「去看」会跳到看不见本篇结果的页面（见 services/contentChat.js）。
  const jobKey = contentChatJobKey(companyId);
  const job = useBackgroundJob(jobKey);

  return (
    <div className="merged-tabs co-page">
      {/* 【2026-10-12 P2】统一页头：复用既有 module-page-head 系列（不新造一套）。
          四个核心页面（首页 / 内容创作 / 活动与档期 / 竞品分析）用同一个页头句式：
          一句「这是什么」+ 一句「进来干什么」，用户不用猜。 */}
      {/*第十四轮（2026-10-14）顶部横幅：按老板效果图 docs/ref/06-hero-banner.jpg。
          原来这里只有一行标题文字，页面顶上空一块、完全没有品牌感。 */}
      <PageBanner
        ic="pen"
        title="内容创作"
        sub="一句话说清要写什么，豆芽就地开写，写完直接复制就能发。"
        slogan="好内容，是替品牌把话说清楚"
      />

      <ContentWorkbench
        asset={asset}
        assets={assets}
        currentCompany={currentCompany}
        currentProject={currentProject}
        addAsset={addAsset}
        geoProxy={geoProxy}
        jobKey={jobKey}
        job={job}
        onSelectModule={onSelectModule}
      />
    </div>
  );
}
