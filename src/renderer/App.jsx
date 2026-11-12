/** 第十九轮（老板第 3 条）：聊天页不再渲染 PageBanner（标题「豆芽助手」+ 副标题 + slogan
 *  那一整条属于说明性文案，老板点名要删）。组件文件保留为回滚资产，故也不再 import。 */
import DealerPurchase from './modules/DealerPurchase.jsx';
import StoreOps from './modules/StoreOps.jsx';
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Button, Input, Modal, ConfigProvider, App as AntApp, Checkbox, theme as antdTheme } from 'antd';
import { geoProxy, setTenantContext } from './api.js';
import { buildToolsFrom } from '../shared/toolSchema.js';
import ModuleNav from './modules/ModuleNav.jsx';
// 0.21.14 共享底座：导航红点的数据源。
// ★ 这里只 import **纯函数与只读取数**，不 import 任何组件 —— 组件之间不互相 import（S8），
//   红点的「算」在 App.jsx（唯一计算方），「显示」在 ModuleNav（受控 prop），
//   「什么时候该重算」靠 window 事件 `douya:navdots-refresh`（本文件是唯一监听者）。
// 【0.21.21 · 老板 2026-10-21】`loadSchedules` / `countUnreadSchedules` 的 import 已移除：
//   它们只服务于「活动与档期」侧栏卡上的未读档期红点，而那张卡本轮整块下线
//   （老板原话「技术部做了个一样的 整个活动与档期删除」）。红点数据源少一路，
//   换来的直接收益是：切企业时不再为一个看不见的红点白打一次档期接口。
//   ⚠️ `services/scheduleFeed.js` 本体**不删** —— Replenish（AI 补货）仍在用它的
//    `loadSchedules` / `pickReplenishBanner`，且它是 promo 上下文的数据源。
import { readStockSnapshot, readSeen as readReplenishSeen, countArrived } from './services/replenishModel.js';
import NewMediaWorkbench from './modules/NewMediaWorkbench.jsx';
import MediaPublish from './modules/MediaPublish.jsx';
// 【0.21.21 · 老板 2026-10-21】`ActivityPlanning`（旧版「活动策划」向导页，module key `huodong`）
// 已随「活动与档期」整板块下线而删除。深链 `huodong` 现在由 LEGACY_MODULE_ALIAS 归一到
// `campaign`（营销专项 = 真正的「做活动方案」能力），**能力不删、页面换家**。
import PrCrisis from './modules/PrCrisis.jsx';
import DailyOps from './modules/DailyOps.jsx';
import ContentOps from './modules/ContentOps.jsx';
// 【0.21.20 · 老板 2026-10-21】「视频设计」：通义万象 3.0 出视频 / 出图。见 modules/VideoDesign.jsx。
import VideoDesign from './modules/VideoDesign.jsx';
// 【0.21.26 · 老板 2026-11-09】「视频精剪」：本机 Concat 引擎的多轨剪辑器（剪映式）。
// 与上面的「视频设计」**是两个模块**：那个是通义万象云端生成，这个是把已有素材剪成成片
// 并导出 mp4。见 modules/VideoStudio.jsx 文件头。
import VideoStudio from './modules/VideoStudio.jsx';
import CompanyProfile from './modules/CompanyProfile.jsx';
import NewMediaCenter from './modules/NewMediaCenter.jsx';
import MarketMomentum from './modules/MarketMomentum.jsx';
import CampaignModule from './modules/CampaignModule.jsx';
import DirectionModule from './modules/DirectionModule.jsx';
import LearningStation from './modules/LearningStation.jsx';
// 【0.21.21 · 老板 2026-10-21】`MiaomiaoSchedule`（内嵌 api.example.com 档期页的 iframe 外壳，
// module key `miaomiao`）已删。档期页在 workbench 侧同步下线（老板原话「那个页也下线」），
// 外壳留着只会指向一个 404 页面。深链 `miaomiao` 由 LEGACY_MODULE_ALIAS 归一成 `workbench`。
// 【0.21.14 · 需求 3】AI 补货：单独的一级功能（老板原话「新增一个AI补货功能 单独开一个功能」）。
// 导航项在 ModuleNav.jsx（key='replenish'，无 roles ⇒ 全身份可见），到货红点在下方 navDots 统一算。
import Replenish from './modules/Replenish.jsx';
// 【0.21.25 · 2026-11-02】思维导图：AI 生成 / 扩散 / 换框架 + 自研画布。
// 这一页**完全不需要 geoProxy、也不需要 companyId** —— 它一次外网请求都不发，
// 全部经 services/mindmap*.js（纯函数）与 api.js 的 chatOnce（AI 四条通路）。
// 不接 currentCompany 的 key：导图数据按本机 localStorage 单文档存，
// 换企业不该把用户的导图清掉（这是"我的草稿"，不是"企业的资产"）。
import MindMap from './modules/MindMap.jsx';
import Markdown from './components/Markdown.jsx';
import DouyaUsageGuide from './components/DouyaUsageGuide.jsx';
import GoalSelector from './components/GoalSelector.jsx';
import GoalGuide from './components/GoalGuide.jsx';
import GoalPlanPreview from './components/GoalPlanPreview.jsx';
import CompanyGuide from './components/CompanyGuide.jsx';
import AssetPanel from './components/AssetPanel.jsx';
import WorkflowSteps from './components/WorkflowSteps.jsx';
// 首登改造（onboarding-v2）：屏 2–4 的新流程组件。旧 Onboarding.jsx 保留为回滚资产（未改动）。
import OnboardingV2 from './components/OnboardingV2.jsx';
import CompanyHome from './components/CompanyHome.jsx';
import CompanySwitcher from './components/CompanySwitcher.jsx';
// 【0.21.21 · 老板 2026-10-21】`ActivityHub`（「活动与档期」页，module key `activity`）已删。
// 老板原话：「这个功能删了 workbench里面这个也删了 技术部做了个一样的 整个活动与档期删除」。
// 删除范围是**板块**，不是能力：
//   · 侧栏「活动与档期」卡片、看板 / 周视图 / 月历 / 挡期日历 —— 全删；
//   · 做活动方案的能力**留着**：`campaign`（营销专项，CampaignModule）仍在，
//     经营方案（DirectionModule）/ 学习中心（LearningStation）里内嵌的 ActivityChat 一字未动，
//     `config/activitySubjects.js`、`data/activityPrompts.js`、`store/activityStore.jsx` 也全部保留。
// ⚠️ 老存档 / 深链里的 `activity` 一律由 LEGACY_MODULE_ALIAS 归一成 `workbench`，
//    否则会落到一个已删除的分支 ⇒ 主体区整块白屏（首登完成时就会踩到，见 handleOnboardDone）。
import ProjectDetail from './components/ProjectDetail.jsx';
// 2026-10-18 第十六轮：HomeConsole 已不再直接渲染 —— 「首页」入口已删，
// 老存档的 home 由 LEGACY_MODULE_ALIAS 归一成 workbench（见下方对话区分支条件），
// 其快捷入口收进聊天空态欢迎区（WELCOME_QUICK）。文件保留备查，不再 import。
// 【0.21.21】它内部那几张「看活动档期 / 看档期安排 → miaomiao」的卡片**不会再被渲染**
// （整个文件未挂载），故本轮不动它；`miaomiao` 已由 LEGACY_MODULE_ALIAS 兜住，即使将来
// 有人把它挂回来也不会白屏。
import LineIcon from './components/LineIcon.jsx';
// 【2026-11-08 · 主题二期】设置弹窗第 8 张卡「外观」用的三件套。
// `useTheme` 是本轮**唯一**的消费者：它订阅 themeStore，切换后本组件重渲染 ⇒ 卡片上的
// 「已选中」即时跟着变。色值一个都不在这里，全在 styles/theme-tokens.css。
import { THEME_ORDER, THEME_LABELS, setTheme as setAppTheme, useTheme } from './store/themeStore.js';
// 【2026-11-03】对话输出的「过程折叠 / 结论前置」两块：自查卡折叠组 + 收尾结论块。
// 单独成组件的理由与 ToolRunningChip 相同 —— 能被 SSR/jsdom 真渲染断言
// （scripts/smoke/unit-chat-verdict.mjs）。老板原话：「怎么复查根本不重要建议折叠掉」
// 「最后没完成啥也不知道」。
import ReviewGroup, { ChatVerdict, GateReport, PendingActions, mergeGateReport, mergePendingActions } from './components/ReviewGroup.jsx';
import CompanyBrain from './components/CompanyBrain.jsx';
import ModuleAssistant from './components/ModuleAssistant.jsx';
import BackgroundJobsBar from './components/BackgroundJobsBar.jsx';
import SupportAssistant from './components/SupportAssistant.jsx';
// 「我的记忆」（设置弹窗第 5 张卡）：四层档案 + 变更流水 + 删除。
// 数据全部经 preload 的 memory* 通道读主进程，本组件**没有任何直接碰文件的能力**。
import MemoryCenter from './components/MemoryCenter.jsx';
// 「开发工作台」：豆芽对话里的开发板块（写代码 / 改小程序 / 改网页）。与经营侧数据隔离。
import DevWorkbench from './components/DevWorkbench.jsx';
// 「定时任务」：2026-10-10 老板第 6 条删掉「今天做什么」后，它原先唯一的入口（TodayOps 的 Tab）
// 一并消失。这里按「开发工作台」的既有先例（不新增一级导航卡）挂进「豆芽对话」的第三个页签，
// 保证「让豆芽到点自己干活」这个能力不丢。
import Automations from './modules/Automations.jsx';
// 第十九轮（2026-10-19 · 老板第 3 条）：「经营对话 / 开发工作台 / 定时任务」合并成一个任务栏，
// 顶部只留一个「对话 / 工作」大号居中切换。
//   · ScopeSwitch：那个大切换（两种模式下同一个组件、同一个位置观感）；
//   · TaskCenter：统一任务栏（对话绿 / 开发黄 / 定时紫，按 updatedAt 混排）；
//   · autoTitle：按内容自动取任务名（纯函数，可裸测）。
import ScopeSwitch from './components/ScopeSwitch.jsx';
import TaskCenter from './components/TaskCenter.jsx';
// 0.21.11 · 老板第 7 条：右栏「历史成果」抽成独立组件（按任务栏的行语言重做，可被探针单独渲染）
import HistoryPanel from './components/HistoryPanel.jsx';
import { autoTitle } from './services/autoTitle.js';
// ══════════════════════════════════════════════════════════════════════════
// 【第二十二轮 · 老板第 4 条 / 第 5 条】对话体验三件套（本文件只负责"接线"）
//   ① ScrollNav        —— 回顶部 / 回最新 + 未读角标（老板第 4 条）
//   ② ChatGenerating   —— 生成中的**显眼**运行态：三点动效 + 文字「生成中」+「已等 N 秒」
//   ③ ToolRunningChip  —— 工具步骤的「进行中」芯片（抽出来是为了让 data-pending 可被断言）
//   ④ services/chatFailure.js —— 失败归类 + `settleRunningTools`（"永远生成中"的真 bug 修复）
// 四个都在别处各只有一份实现，三个对话区共用；本文件不重复写滚动/失败逻辑。
import ScrollNav from './components/ScrollNav.jsx';
import ChatGenerating from './components/ChatGenerating.jsx';
import ToolRunningChip from './components/ToolRunningChip.jsx';
import { describeFailure, settleRunningTools } from './services/chatFailure.js';

// 开发会话存在 localStorage（与经营侧完全隔离，见 services/devProject.js 头注释）：
// 统一任务栏要混排它们，所以这里**只按原样读**，不改它的任何取数/规范化逻辑。
// 0.21.11 唯一的例外是 removeSession：任务栏现在能删条目，开发会话的删除只能走
// devProject 自己的 API（直接改 localStorage 会绕过它的 normalizeSession / 上限裁剪）。
import {
  loadProjects as loadDevProjects,
  loadSessions as loadDevSessions,
  removeSession as removeDevSession,
} from './services/devProject.js';
import { useCompany } from './store/companyStore.jsx';
import { useCompanyKnowledge } from './store/companyKnowledgeStore.jsx';
import { useAssets } from './store/assetStore.jsx';
import { useActivity } from './store/activityStore.jsx';
import { useMarketingGoal, useMarketingAsset } from './store/marketingStore.jsx';
import { buildContext } from './services/contextBuilder.js';
import { MODULE_LABELS } from './services/moduleAssistant.js';
import { resolveCapability, moduleForCapability, resolveCapabilityForType } from './services/capabilityResolver.js';
import { getCapability } from './capabilities/registry.js';
import { createTaskAssetSaver } from './services/taskExecutor.js';
// onboarding-v2：模型连通性实测（屏 2 与设置面板共用同一契约）与「补连即补算」体检。
import { testLLM as runLLMTest } from './services/llmTest.js';
import { runCompanyCheckup } from './services/companyCheckup.js';
import { loadCheckup } from './services/checkupBrief.js';
import { isAiReady, needAiConfig } from './services/aiReadiness.js';
// T20：「让豆芽做」→ 带任务跳对话页 → 自动开跑。
// brief 组装 / 一次性守卫 / 收尾（任务回写 + 资产落库）都收敛到 taskBrief.js 这一份事实源，
// App 只负责「写交接单 → 切对话页 → 消费一次」的编排，可测逻辑全部在 service 里。
import {
  CONVERSATION_MODULE,
  buildTaskBrief,
  createAutoRunGate,
  consumeAutoRun,
  finalizeAutoRunTask,
  isConversationModule,
} from './services/taskBrief.js';
// 0.8.0：品牌形象统一走 assets/douya（由豆芽AI 形象素材规范化而来，webp 透明底）。
// 原先 login-logo.png / pet-character.png 是同一张 1290x2162 竖图（各 1.6MB），已弃用。
import douyaLogo from './assets/douya/douya-logo.webp';

// 后台地址：默认是 Electron 本地服务（10119）。
// 允许 window.__DOUYA_BACKEND__ 覆盖 —— 供真实浏览器验收（scripts/verify）在
// 10119 被桌面应用占用的机器上，把 mock 后端挂到别的空闲地址运行，避免"验错对象"。
// 生产环境不注入该全局，行为与原先完全一致。
const BACKEND =
  (typeof window !== 'undefined' && window.__DOUYA_BACKEND__) || 'http://127.0.0.1:10119';

// 判断运行环境：内网（192.168.80.99 / 10003） vs 公网（api.deepseek.com）
function detectEnv(baseURL) {
  const u = baseURL || '';
  if (u.includes('192.168.80.99') || u.includes('10003')) return 'intranet';
  if (u.includes('api.deepseek.com')) return 'public';
  return '';
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('agent-settings') || '{}');
  } catch {
    return {};
  }
}

// 【P1】首登第8步选定的经营方向：约定用此 localStorage key 传递「待铺方向」。
// 约定值结构：JSON.stringify({ companyId, directionKey })。
// TodayOps 挂载时读取本 key，仅铺 directionKey 对应的完整链路；
// 注意：TodayOps 侧独立声明同一字符串常量，此处无需导出，字符串保持一致即可；
// TodayOps 消费后需清空此 key。
const ONBOARD_DIRECTION_KEY = 'douya-onboard-direction';
function saveOnboardDirection(companyId, directionKey) {
  try {
    if (!companyId || !directionKey) return;
    localStorage.setItem(ONBOARD_DIRECTION_KEY, JSON.stringify({ companyId, directionKey }));
  } catch {
    /* 隐私模式等异常静默，不影响首登流程 */
  }
}

function packMessages(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * 成果卡 / 历史成果的「过程脚本」过滤（2026-09-17）。
 * 用户原话：「导出的东西很多都是 py 格式的……让他改一下服务器的东西，他会生产很多 py，
 * 并没有告诉你结果是什么」。实测本地 deliverables.json：**40 条里 33 条是过程脚本**
 * （`_probe.py`×7 / `_patch.py` / `_check.py` / `_syntax.py` / `_fix.js` / `_show.js` /
 *  `_tmp_resize720.py` / `gen_cds2026_v3.py` / `pdf_to_word.py` …），真正的产物只有几个 index.html。
 * 后端已在源头拦截（backend.js 的 isProcessScript），此处**双保险**：
 * ① 兜住**历史遗留数据**（老记录已落在 deliverables.json 里，后端过滤救不了它们）；
 * ② 兜住将来别的写入路径。
 * fail-safe：过滤后若为空，**回退显示原列表** —— 免得「任务只产出一个脚本」时成果卡变空。
 * `.js` 故意不滤（网页产物常是 .js），带 `_` / `tmp_` 前缀的临时件仍会被拦住。
 */
const DELIV_PROCESS_RE = /(^|[\\/])(_|tmp[_-]|temp[_-])[^\\/]*$|\.(py|sh|bash|bat|cmd|ps1)$/i;
function filterDeliverables(items) {
  const list = Array.isArray(items) ? items : [];
  const kept = list.filter((it) => it && !DELIV_PROCESS_RE.test(String(it.path || it.name || '')));
  return kept.length ? kept : list;
}

/* 【0.21.11 · 老板第 7 条】成果类型判定（delivKind / DELIV_KINDS）与「常用能力」四条清单
   （RAIL_CAPS）已随右栏一起搬进 components/HistoryPanel.jsx —— 它们只服务于那一个面板，
   留在 App.jsx 里就是两处各存一份、早晚改歪一处。 */

/**
 * 把连续的 tool_call 消息合并成一个「工具组」。
 * 目的：豆芽干活时（抓网页/读文件/进目录…）不再「做一步刷一行」，只显示当前正在做的一条，
 * 已完成的收进折叠。数据层不动，只在渲染前聚合，滚动/历史都兼容。
 */
/**
 * 工具名 → 人话（渲染层最后一道防线）。
 * 2026-09-22：老板实测反馈「很多不必要给用户看的还是会给用户看」，其中一部分**不是模型说的**，
 * 而是这里渲染出来的 —— 旧代码是 `t.label || t.tool`，当后端 SKILL_ACTION 表没登记该技能时，
 * `label` 为空就**把 shell-exec / file-write 这类英文工具名直接显示给用户看**。
 * 所以渲染层不能只做「兜底显示原值」：含中文就当人话用，纯英文标识符一律翻译，查不到也不外露真名。
 */
const TOOL_HUMAN = {
  'shell-exec': '运行检查', 'ssh-exec': '连接服务器', 'file-write': '写入文件',
  'file-read': '读取文件', 'file-list': '整理目录', 'file-search': '查找文件',
  'file-rename': '重命名文件', 'web-fetch': '读取网页', 'web-search': '联网查找',
  'browser-verify': '检查页面效果', 'image-ocr': '识别图片文字', 'image-info': '读取图片信息',
  'image-edit': '处理图片', 'image-compress': '压缩图片', 'doc-read': '读取文档',
  'zip-pack': '打包文件', 'wechat-api': '调用微信接口', 'shop-search': '查询商品',
  'shop-order': '加入购物车', 'gif-make': '合成动画', 'video-make': '生成视频',
  'media-edit': '处理音视频', 'data-analyze': '分析数据', 'chart-generate': '画图表',
  'ppt-generate': '生成幻灯片', 'excel-generate': '生成表格', 'docx-generate': '生成文档',
  'pdf-generate': '生成 PDF', 'project-scaffold': '搭建项目', 'miniprogram-scaffold': '生成小程序',
};

function humanStep(t) {
  const raw = String((t && (t.label || t.tool)) || '').trim();
  if (!raw) return '处理中';
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw; // 已经是人话（后端给了中文动作标签）
  return TOOL_HUMAN[raw] || '处理中';          // 英文工具名：翻译；查不到也不把真名露给用户
}

/**
 * 渲染前把消息聚合成组：
 *   · 连续 `tool_call` → 一个工具组（避免「做一步刷一行」）。
 *   · 连续 `role==='review'` → 一个自查组（2026-11-03）。
 *
 * 【为什么自查也要聚合】老板原话「中间豆芽怎么想怎么复查 根本不重要建议折叠掉」。
 *   改前每轮自查各占一张全展开的卡片，一次任务的对话物理顺序是
 *   `[用户] → [豆芽正文] → [自查×4] → [复检×1]` ⇒ 用户滚到底看到的是**最后一张自查卡**，
 *   而不是结论。聚合后由 `ReviewGroup` 渲染成一条默认收起的折叠条。
 * ⚠️ 函数名与位置被 `unit-user-facing-output.mjs`（U3 系列按源码定位）依赖，不许改名。
 */
function groupToolCalls(messages) {
  const out = [];
  let group = null;
  let rgroup = null;
  for (const m of messages) {
    if (m && m.role === 'tool_call') {
      if (!group) {
        group = { __group: 'tools', tools: [] };
        out.push(group);
      }
      group.tools.push(m);
      rgroup = null;
      continue;
    }
    if (m && m.role === 'review') {
      if (!rgroup) {
        rgroup = { __group: 'review', rounds: [] };
        out.push(rgroup);
      }
      rgroup.rounds.push(m);
      group = null;
      continue;
    }
    group = null;
    rgroup = null;
    out.push(m);
  }
  return out;
}

/** 豆芽工具组：当前正在做（单条或多条并行）+ 已完成折叠（不逐条堆叠刷屏）。 */
function ToolGroup({ tools, resultLabel, unresolved, state }) {
  const done = tools.filter((t) => t.status === 'done');
  const failed = tools.filter((t) => t.status && t.status !== 'done' && t.status !== 'running');
  const running = tools.filter((t) => t.status === 'running');
  const doneCount = done.length;
  const failedCount = failed.length;

  // 2026-09-22 改（老板提案第 1、2 条）：工具事件数 **不等于** 任务完成。
  //   旧文案「已完成 N 步，M 步异常」有两个毛病：①它宣称"完成"，而任务可能根本没做完；
  //   ②"异常"和"完成"同框出现，用户看到的是自相矛盾的一句话。
  //   现改为中性措辞；失败如实说"没做成"，但绝不与"完成"同时出现。
  // 未闭环失败数：**优先用后端账本口径**（后端会销账：同技能后来做成了就销掉，见 markStep）。
  // 前端自己的 failedCount 是事件级计数、只增不减 —— 工具报错过就永远算它失败，
  // 会把**已经修好的步骤**也报成问题（"3 步异常"里可能 3 步后来都成了）。所以账本口径必须以后端为准。
  const openFailed = (typeof unresolved === 'number') ? unresolved : failedCount;
  const totalSteps = doneCount + failedCount;
  const summaryText = openFailed > 0
    ? `处理过程（${totalSteps} 步，其中 ${openFailed} 步没做成）`
    : `处理过程（${totalSteps} 步）`;
  // 老板提案第 4 条：UI 必须拿**最终状态**渲染，而不是拿工具历史渲染。
  //   resultLabel = 后端算出的终态人话（完成 / 还没做完（我不会说完成了）/ 卡住了…），
  //   只在"本轮最后一组工具"上显示；历史里的旧工具组退回中性文案。
  // 【2026-10-21】折叠块标题只放「是什么」，不放引擎元数据。
  //   旧写法把 `处理过程（27 步，其中 3 步没做成）` 直接当标题 ⇒ 老板原话「一堆内容找不到重点」。
  //   而 src/main/deliveryProtocol.js 的 TOOL_CHURN_RE 明令禁止把过程统计写进回答（finalReport
  //   还用 clean() 过滤）——协议在模型侧禁噪音，渲染层自己却在造噪音。故步数降级为标题内尾部的灰色小字。
  const headText = resultLabel || '处理过程';
  // 老板提案第 4 条（2026-09-23 真正接线）：UI 必须拿**终态**渲染，不能拿工具历史渲染。
  //   此前后端只把 label 文案传进来，而状态机判决（COMPLETE/PARTIAL/BLOCKED）**从没送到前端**
  //   ⇒ 前端只能拿工具历史猜"做完了没"。现在终态作为独立字段渲染成一枚芯片，与文案并存。
  // 【第四档】2026-02-16：`BLOCKED_WITH_DIAGNOSIS` 必须在这里有一项。
  // ⚠️ 漏了不会报错 —— 下面 `TERMINAL_CHIP[state]` 取到 undefined ⇒ `terminalChip` 返回 null
  //   ⇒ 芯片**整枚消失**，用户只看到文案、看不到状态（静默降级，比显示错更难看懂）。
  //   文案选"卡住但有诊断"：一眼区分于 BLOCKED 的"需你介入" —— 它已经把问题定位到可复现，
  //   用户要做的是"照着步骤跑一次"，不是"给我提供个东西"。
  // ★ 顺序无关（这是对象字面量，不是 if 链）；但**键必须存在**，这是 `TERMINAL_CHIP` 的唯一纪律。
  const TERMINAL_CHIP = {
    COMPLETE: '完成',
    PARTIAL: '未完成',
    BLOCKED: '需你介入',
    BLOCKED_WITH_DIAGNOSIS: '卡住但有诊断',
  };

  const terminalChip = (state && TERMINAL_CHIP[state])
    ? <span className={'tg-terminal tg-terminal-' + String(state).toLowerCase()}>{TERMINAL_CHIP[state]}</span>
    : null;

  // 已完成/异常折叠块：单条与多条 running 场景共用
  const history = (doneCount > 0 || failedCount > 0) && (
    <details className="tool-group-history">
      <summary>{headText}<span className="tg-stepcount">{summaryText}</span></summary>
      <ul className="tool-group-list">
        {done.map((t, k) => <li key={k}><span className="tg-ok">✓</span>{humanStep(t)}</li>)}
        {failed.map((t, k) => <li key={k}><span className="tg-err">✕</span>{humanStep(t)}</li>)}
      </ul>
    </details>
  );

  if (running.length > 0) {
    // 【第二十二轮 · 老板第 5 条 b】「进行中」那一块抽成 components/ToolRunningChip.jsx。
    // 抽出去的唯一理由是**可断言**：老板报的「失败了但对话框还在生成中」的真身就是这块芯片
    // 在失败路径上没人收敛（机制见 services/chatFailure.js 的 settleRunningTools）。
    // 它内联在 App.jsx 里时，jsdom 挂不起整棵树 ⇒ 「running 时有没有 data-pending」永远无法被
    // 自动验证，只能靠人眼；抽出来后一条渲染断言就能给出正控。
    // 只搬渲染、不搬 humanStep（那条函数被 unit-user-facing-output 的 U3 系列按源码定位，不能动）。
    return (
      <ToolRunningChip steps={running.map((t) => humanStep(t))}>
        {history}
      </ToolRunningChip>
    );
  }


  return (
    <div className={'msg-tool-group ' + (failedCount > 0 ? 'error' : 'done')}>
      <span className="tool-chip-icon">{failedCount > 0 ? '' : '✓'}</span>
      <span className="tool-chip-name">{headText}</span>
      {terminalChip}
      {(doneCount > 0 || failedCount > 0) && (
        <details className="tool-group-history">
          <summary>查看明细</summary>
          <ul className="tool-group-list">
            {done.map((t, k) => <li key={k}><span className="tg-ok">✓</span>{humanStep(t)}</li>)}
            {failed.map((t, k) => <li key={k}><span className="tg-err">✕</span>{humanStep(t)}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * 往前找最近一条**用户消息**的正文（纯函数）。
 *
 * 【第二十二轮 · 老板第 5 条 a】失败卡上的「重试」要重发"上一次问的那句"。
 * 为什么不在消息对象上存一份副本：那等于把同一句话存两份，一旦用户续跑/改口就会漂移。
 * 按顺序往前找是**现算**的，永远和正文一致。
 *
 * @param {Array<Object>} list 消息数组（displayMessages 亦可：工具组没有 role，自动跳过）
 * @param {number} idx 失败那条 assistant 的下标
 * @returns {string} 用户原话；找不到返回空串（调用方据此不渲染重试按钮，绝不造假动作）
 */
function prevUserText(list, idx) {
  const arr = Array.isArray(list) ? list : [];
  for (let k = Math.min(Number(idx) || 0, arr.length) - 1; k >= 0; k -= 1) {
    const m = arr[k];
    if (m && m.role === 'user' && m.content) return String(m.content);
  }
  return '';
}

// 附件缩略图：按文件路径懒加载图片小图（dataURL 不落消息对象，只做内存内缓存）
const IMG_ATTACH_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const __thumbCache = new Map(); // path+':'+size -> dataUrl | ''

function AttachThumb({ path: p, size = 320, className = 'attach-thumb' }) {
  const [src, setSrc] = useState(() => __thumbCache.get(p + ':' + size) || '');
  useEffect(() => {
    if (!p || !IMG_ATTACH_RE.test(p)) return undefined;
    const key = p + ':' + size;
    if (__thumbCache.has(key)) {
      setSrc(__thumbCache.get(key));
      return undefined;
    }
    let alive = true;
    (async () => {
      try {
        const api = typeof window !== 'undefined' ? window.api : null;
        if (!api || typeof api.invoke !== 'function') return;
        const r = await api.invoke('file:readThumb', p, size);
        const url = r && r.ok && r.dataUrl ? r.dataUrl : '';
        __thumbCache.set(key, url);
        if (alive && url) setSrc(url);
      } catch {
        /* 缩略图是纯装饰，失败必须静默 */
      }
    })();
    return () => { alive = false; };
  }, [p, size]);
  if (!src) return null;
  return (
    <img
      className={className}
      src={src}
      alt=""
      draggable={false}
      onError={() => {
        // 图片损坏：清空并移除缓存，避免重复请求（deps 未变不会触发重试）
        __thumbCache.delete(p + ':' + size);
        setSrc('');
      }}
    />
  );
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTokens(n) {
  if (n == null) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M tok';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k tok';
  return n + ' tok';
}

/**
 * 【0.21.11】主进程定时任务列表 → 任务栏条目。取数有两处（首次挂载、删完一条后重取），
 * 映射只留这一份，避免两处慢慢长成不一样（任务栏里显示的名字/时间口径必须一致）。
 * @param {Array} list window.api.automationList() 的返回（可能不是数组）
 * @returns {Array<{id:string,name:string,enabled:boolean,time:string}>}
 */
function mapAutomations(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map((a) => ({
    id: String((a && a.id) || ''),
    name: String((a && a.name) || '未命名定时任务'),
    enabled: !!(a && a.enabled),
    time: a && a.nextRunAt ? '下次 ' + fmtTime(a.nextRunAt) : (a && a.lastRunAt ? '上次 ' + fmtTime(a.lastRunAt) : ''),
  }));
}

/**
 * 设置 → 高级配置：当前版本 + 检查更新。
 *
 * 做成**自包含小组件**而不是往 App 里再塞 state：
 * App 的 hooks 已经很长，多塞两个 state 容易和别处冲突；这里自己管自己的版本号与检查状态。
 *
 * 为什么需要它：在此之前界面**没有任何地方**显示当前版本，左上角卡片又只在「有新版」时才出现
 * ⇒ 用户永远无法判断自己是哪一版、是不是最新。
 *
 * 状态一律说人话（用户是老板，不看日志）：
 *   正在检查… / 已是最新版本 vX / 发现新版本 vY，稍后点左上角卡片上的「立即更新」 / 连不上更新服务器…
 */
function VersionCard() {
  const [version, setVersion] = useState('');
  // null=还没查过；'checking'=正在检查；其余是主进程回的结果对象
  const [checking, setChecking] = useState(null);

  useEffect(() => {
    let alive = true;
    if (window.api && typeof window.api.getAppVersion === 'function') {
      window.api.getAppVersion()
        .then((v) => { if (alive) setVersion(v || ''); })
        .catch(() => { /* 拿不到版本号就不显示，不打扰用户 */ });
    }
    return () => { alive = false; };
  }, []);

  const onCheck = () => {
    if (checking === 'checking') return;
    setChecking('checking');
    if (!window.api || typeof window.api.checkUpdate !== 'function') {
      setChecking({ ok: false, message: '当前版本不支持检查更新' });
      return;
    }
    window.api.checkUpdate()
      .then((r) => setChecking(r || { ok: false, message: '检查更新失败，请稍后再试' }))
      .catch(() => setChecking({ ok: false, message: '检查更新失败，请稍后再试' }));
  };

  let statusText = '';
  if (checking === 'checking') {
    statusText = '正在检查…';
  } else if (checking && checking.ok && checking.phase === 'available') {
    statusText = '发现新版本 v' + checking.version + '，稍后点左上角卡片上的「立即更新」即可';
  } else if (checking && checking.ok && checking.phase === 'none') {
    statusText = version ? '已是最新版本 v' + version : '已是最新版本';
  } else if (checking && !checking.ok) {
    statusText = checking.message || '检查更新失败，请稍后再试';
  }

  return (
    <div className="settings-card">
      <div className="settings-card-title"> 版本与更新</div>
      <div className="field-label">当前版本</div>
      <div className="version-row">
        <span className="version-num">{version ? 'v' + version : '读取中…'}</span>
        <Button size="small" onClick={onCheck} disabled={checking === 'checking'}>
          {checking === 'checking' ? '检查中…' : '检查更新'}
        </Button>
      </div>
      {statusText ? <p className="hint">{statusText}</p> : null}
      <p className="hint">有新版时，左上角会弹出更新卡片，点「立即更新」就能自动换好、自动重开，不用再手动下载安装包。</p>
    </div>
  );
}

/**
 * 【2026-10-14 第八轮】豆芽助手 · 一个入口。
 * 原来分「智能对话 / 方案生成 / 数据分析 / 知识问答」四个模式（外加任务协助），
 * 老板判定这是「把次要开关摆在主视线里」——四个模式的 chips 完全一样、只是换了句
 * placeholder，用户根本不会去切换（左侧已有项目/历史，模式是第三层冗余）。
 * 现在合并成一个「豆芽助手」：一个输入框、一个 placeholder、一组快捷指令。
 * ph = 输入框提示；chips = 快捷指令（点了填进输入框，不擅自发送）。
 */
/**
 * 【第十一轮2026-10-14】是否挂「全局本页助手栏」（280px 的 ModuleAssistant）。
 * 老板选定方案：**只保留内嵌右栏** —— 四页恢复内嵌参考区后，
 * 再挂这条全局助手栏会变成两条助手并排且内容重复。
 * 想切回全局栏：把这个常量改成 true 即可（ModuleAssistant 组件本身未改动）。
 */
const SHOW_GLOBAL_ASSISTANT = false;

const CHAT_ASSIST = {
  ph: '说一件事就行，比如：帮我做一场种植牙科普沙龙',
  chips: ['深挖一件事', '出一份方案', '对比几个选项', '写成一篇稿'],
};

/**
 * 2026-10-18 第十六轮：设置二级板块的「标题 + 一句人话说明」。
 * 老板反馈「很多人看不懂不知道怎么用」⇒ 每个二级页顶部都说清「这是什么、能干嘛」。
 */
const SETTINGS_PANEL_META = {
  model: { name: '联网模型', sub: 'AI 怎么连、联网搜索开不开 —— 一般只用第一次' },
  shop: { name: '商城', sub: '购物地址与订单相关设置' },
  miniprogram: { name: '小程序', sub: '绑定微信小程序，「生成小程序」技能要用' },
  advanced: { name: '高级配置', sub: '模型名 / 麦克风 / 语音 / 版本更新 —— 平时不用动' },
  memory: { name: '我的记忆', sub: '豆芽记住了什么，可查看、可删除' },
  // 【0.21.22 · 老板 2026-10-21 第 5 条】「把 api 给隐藏掉 放到设置里面去」。
  // 视频设计页上**一个 key 输入框都不留**了，key / 额度 / 产物目录全部收进这里。
  // ★ 别把这一项删掉只留 entry card —— 二级页标题会读不到 name，出现「只有返回、没有标题」的空壳。
  videodesign: { name: '视频设计', sub: '通义万象的 key、额度与作品存放位置' },
  account: { name: '账号', sub: '当前登录的人、思考过程显不显示、使用指南与退出' },
  // 【2026-11-08 · 主题二期】第 8 张卡「外观」。放在**最后**是刻意的：
  // 前 7 张卡的顺序一个都没动 ⇒ 绿色主题下用户看到的设置面板与改造前一模一样，
  // 只是末尾多了一张卡（新增功能，不属于「改变现状」）。
  // ★ 这个键名同时是 `settingsPanel` 的状态值，二级页标题会读 `name` ——
  //   只加 entry card 不加这一项会出现「只有返回、没有标题」的空壳。
  theme: { name: '外观', sub: '绿色 / 白色 / 深色 —— 点一下立刻换，只改这台电脑' },
};

/**
 * 欢迎区示例对话（2026-10-13 对齐参考图《豆芽助手智能工作台》）。
 * 只在一条真实对话都没有时出现；用户发出第一条消息后整块让位。
 * 内容写死为示例：不读企业数据、不触发任何请求 —— 点用户气泡才真正发出。
 */
/** 第十三轮（2026-10-14）：欢迎区能力胶囊，对齐基准图 04-assistant.jpg 那一排。
 *  每条都对应真实存在的能力，不吹。
 *  ⚠️ 第十九轮（2026-10-19 · 老板第 3 条）起**不再渲染** ——「空态只保留一个极简欢迎语」。
 *     数据留在这里当回滚资产（要恢复就把下面 render 里的 JSX 加回去）。 */
const WELCOME_CAPS = [
  { ic: 'chat', t: '智能问答' },
  { ic: 'doc', t: '方案生成' },
  { ic: 'chart', t: '数据分析' },
  { ic: 'search', t: '知识检索' },
  { ic: 'check', t: '任务协助' },
];

/**
 * 2026-10-18 第十六轮：原「首页」的模块快捷入口，收进合并后聊天页的空态欢迎区
 * （首页与豆芽助手已合并成一个对话框 —— 老板第 3 条）。
 * 每一条都直达真实模块，点了就跳过去，不假扮成对话。
 */
const WELCOME_QUICK = [
  { k: 'intel', label: '竞品分析' },
  { k: 'content', label: '内容创作' },
  // 【0.21.21】「活动与档期」快捷入口已删（整板块下线）。这里**不能**只删侧栏卡而留着它 ——
  // 那会变成一颗「点了就跳到豆芽助手」的假按钮（activity 已被别名兜到 workbench），
  // 属于老板最烦的那种「点了没反应 / 跳错地方」。位置由「视频设计」补上：同在内容生产动线上。
  { k: 'videodesign', label: '视频设计' },
  { k: 'newmedia', label: '媒体与报价' },
  { k: 'learn', label: '学习中心' },
  // 【0.21.9 修正】profile 的显示名必须与侧栏一致：老板第 4 条已把它统一成「企业大脑」，
  // 这里漏改会让空态快捷入口写「企业资料」、侧栏写「企业大脑」—— 用户会以为是两个地方。
  { k: 'profile', label: '企业大脑' },
];

/**
 * 示例问答内容（一条假问题 + 一条假回答）。
 * ⚠️ 第十九轮（2026-10-19 · 老板第 3 条）起**不再渲染** ——「空态只保留一个极简欢迎语」。
 *    数据留在这里当回滚资产，别顺手删（里面是逐字对齐过的文案基线）。
 */
const WELCOME_DEMO = {
  q: '帮我分析一下奥齿泰在种植牙领域的市场表现，以及他们的核心优势是什么？',
  a: '已为你整理相关信息，以下是奥齿泰在种植牙领域的市场表现与核心优势：',
  sections: [
    {
      t: '1. 市场表现',
      items: [
        '2024 年全球种植牙市场增速：奥齿泰约 12.8%，在全球排名第 3 位。',
        '中国市场：2024 年在国产品牌中排名前列，市场份额约 6.3%，增长率 15% 以上。',
        '主要增长点：数字化种植、即刻负重、全瓷基冠等高端解决方案的需求持续上升。',
      ],
    },
    {
      t: '2. 核心优势',
      // 两列网格（参考图《豆芽助手智能工作台》同款）：六条并列要点竖排会拉得很长。
      grid: true,
      items: [
        '技术领先：表面处理技术（如 SA 处理）、数字化导板、即刻负重等。',
        '产品线丰富：覆盖不同骨条件和预算的多规格种植体。',
        '性价比优势：相较欧美品牌，价格更具竞争力。',
        '全球化布局：产品覆盖 70+ 国家和地区。',
        '数字化支持：提供数字化种植方案、CAD/CAM 修复等解决方案。',
        '专业服务：完善的培训体系和技术支持。',
      ],
    },
  ],
};

/**
 * 【0.21.10】流读取「空闲」看门狗 —— 治「挂机一段时间后输入框点不进去」。
 *
 * 为什么前端**必须**有这一层：
 *   电脑休眠唤醒 / 切 Wi-Fi / 代理掉线之后，socket 会进入半死状态：既不报错也不来数据，
 *   `await reader.read()` 永久 pending。此时 try 块永不退出 ⇒ finally 里的 setBusy(false)
 *   永远执行不到 ⇒ busy 恒为 true ⇒ 输入框 `disabled={busy && ...}` ⇒ 用户点不进去、打不了字。
 *   老板原话完全吻合：「挂机一段时间再去用就会出现，随机性的，重启可能就好了」。
 *
 * 后端已经有 heartbeat(6s/次) + stream-idle(120s) 兜底，但那只覆盖「上游模型卡死」这一种；
 * 连接本身死掉的时候，后端发什么前端都收不到 —— 所以「多久没收到字节」只能由前端自己判。
 *
 * 空闲语义（每收到一个 chunk 就重置计时器），**不是**总时长上限：
 * 长任务跑十分钟也不该被误杀。阈值 180s = 30 个心跳周期，足够宽松，
 * 又能在用户真正卡住时几十秒内自愈，不必重启应用。
 *
 * 【2026-10-21】后端已补任务级心跳（15s/次，覆盖工具执行期），本阈值只兜「连接真的死了」，故放宽到 180s。
 */
const STREAM_IDLE_MS = 180000;
function readWithIdle(reader, ms) {
  const limit = typeof ms === 'number' && ms > 0 ? ms : STREAM_IDLE_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('stream-idle-timeout'));
    }, limit);
    reader.read().then(
      (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
      (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 【第二十三轮】「在等你」与「在干活」必须分开显示（老板原话：「会反复问你要你回答，
 * 你不回答他就不做」）。
 *
 * 旧写法的问题：后端 `waitClarify` / `waitMaterial` 会挂起最长 **5 分钟**（300000ms），
 * 期间后端每 15s 发一次心跳 ⇒ 前端这条流不会断 ⇒ `thinking` 恒为 true ⇒ 对话区底部
 * 一直挂着 `ChatGenerating`「生成中，豆芽正在想…」+「已等 N 秒」。
 * 用户看到秒表从 12 秒走到 4 分 58 秒，会以为**模型在算**，实际是**在等他回答**。
 * 这是同一个事实被界面讲错了两遍，所以拆成两段文案、两个锚点。
 */
const WAIT_CLARIFY_TEXT = '在等你回答';
const WAIT_MATERIAL_TEXT = '在等你提供素材';
// 【2026-11-09】plan_gate 的等待态。必须与「生成中」区分：后端在等用户点头（最长 180 秒），
// 把这段等待说成「豆芽正在想」就是第二十三轮那个病（用户以为它卡了/在瞎算）。
const WAIT_PLAN_TEXT = '在等你确认计划';
const WAIT_HINT_TEXT = '不答也行，我会先按最佳判断往下做';

/**
 * 挂起超时 / 被跳过之后落进对话区的系统小字（**不是** alert）。
 *
 * 为什么要写这两句：后端超时会发 `{type:'clarify_result', cancelled:true}`
 * （backend.js 的 `waitClarify` 返回 null 分支），旧前端**不读 cancelled 字段**、
 * 只把卡片清掉 ⇒ 卡片凭空消失，用户不知道发生了什么，只觉得「它又不做了」。
 */
const NOTICE_CLARIFY_SKIPPED = '等了一会儿没等到你的回答，我先按最佳判断往下做了。';
const NOTICE_MATERIAL_SKIPPED = '等了一会儿没等到素材，我先按最佳判断往下做了。';

/* ═══════════════════════════════════════════════════════════════════════════
 * 授权引导（2026-11-09）
 *
 * 【为什么必须和"拦闸"一起上】
 *   主进程那边 `/api/chat` 已经会返回 402 了。如果界面上没有激活入口，
 *   没授权的用户就会被关在门外**且没有任何自救办法** —— 那比"不拦"坏得多。
 *   所以这个组件的定位不是"提示"，是**唯一的进门钥匙**。
 *
 * 【为什么内联在本文件，不单开组件文件】
 *   本仓有门禁（S8）：渲染层组件之间不许互相 import。为了一个面板去破那条规矩，
 *   代价是以后每个组件都能开始互相引用 —— 那笔账不值得。
 *
 * 【三条不动摇的边界】
 *   ① 查不到状态 ⇒ **不挡人**（`wired:false` / 请求失败 / 后端没起来）。
 *      铁律：服务端挂了不许锁用户。把"我不知道"当成"不许用"是最容易让产品打不开的错。
 *   ② `allowed` 由主进程算好再下发，界面**不自己按 state 枚举判**。
 *      在 UI 里再写一份枚举，两处迟早漂移，漂移的后果是"界面说能用、后端 402"。
 *   ③ 激活成功后立刻**重新查一次**，而不是直接把 allowed 置 true。
 *      令牌是主进程写的，界面自己乐观放行等于两份真相。
 * ═══════════════════════════════════════════════════════════════════════════ */
const LICENSE_STATE_LABEL = {
  UNACTIVATED: '还没激活',
  ACTIVATED: '已激活',
  EXPIRED: '授权已到期',
  REVOKED: '授权已被吊销',
  LOCKED: '本机授权不可用',
  TAMPERED: '授权文件被改动过',
  FINGERPRINT_MISMATCH: '授权和这台机器对不上',
  UNKNOWN: '暂时查不到授权状态',
};

function LicenseGuardHost({ inline } = {}) {
  // null = 还没查过（这段时间什么都不弹：宁可晚一拍，也不要在正常用户面前闪一下弹窗）
  const [st, setSt] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [machine, setMachine] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/license/status`);
      const j = await r.json();
      const next = (j && typeof j === 'object') ? j : { wired: false, allowed: true };
      setSt(next);
      return next;
    } catch {
      // 后端没起来 / 请求失败 ⇒ 不挡人（边界①）
      const next = { wired: false, allowed: true, detail: '查不到授权状态' };
      setSt(next);
      return next;
    }
  }, []);

  useEffect(() => {
    refresh();
    // 状态会自己变（心跳续期 / 后台吊销 / 到期）⇒ 定期对一次表；
    // 窗口重新可见时也立刻查（用户关了又开，不该还看到过期的那一屏）。
    const t = setInterval(refresh, 60000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    // 主进程拦下一个请求时会立刻吼一声（见 /api/chat 的 402 处理）⇒ 不等轮询，马上对表。
    window.addEventListener('douya:license-required', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('douya:license-required', onVis);
    };
  }, [refresh]);

  // 只有"真的接线了、而且真的不允许"才拦。查不到 ≠ 不许用。
  const blocked = !!(st && st.wired !== false && st.allowed === false);

  useEffect(() => {
    if (!blocked || machine) return;
    let alive = true;
    fetch(`${BACKEND}/api/license/machine`)
      .then((r) => r.json())
      .then((j) => { if (alive && j && j.short) setMachine(String(j.short)); })
      .catch(() => { /* 拿不到机器码不影响激活，只是少一个自助报障的手段 */ });
    return () => { alive = false; };
  }, [blocked, machine]);

  const doActivate = async () => {
    const v = String(code || '').trim();
    if (!v || busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch(`${BACKEND}/api/license/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: v }),
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.ok) {
        setCode('');
        setMsg('激活成功，正在进入…');
        // 边界③：不乐观放行，重新查一次真状态。
        const next = await refresh();
        if (next && next.allowed === false) setMsg('已提交，但授权还没生效，请稍后重试或联系客服。');
      } else {
        setMsg(String((j && (j.detail || j.error)) || '激活失败，请检查激活码'));
      }
    } catch (e) {
      setMsg('连不上本地服务，请稍后重试');
    } finally { setBusy(false); }
  };

  const label = LICENSE_STATE_LABEL[String((st && st.state) || '')] || '授权需要处理';
  const days = Number(st && st.daysLeft);

  // ── 同一份内容，两种外壳 ────────────────────────────────────────────────
  // 【为什么要两种外壳（2026-11-11 老板："我现在豆芽进去要先激活 但是没有激活的地方"）】
  //   实测根因不是"组件没写"，是**它到不了**：这个组件当时只挂在主界面那个 return 里，
  //   而它前面有 1 个登录分支 + 3 个提前 return（首登引导 / 我的企业 / 无企业兜底）。
  //   ⇒ 首登用户（恰恰是最可能从没激活过的人）永远看不到激活入口。
  //
  //   两种外壳的分工：
  //     · 默认 → `<Modal>`：盖在界面上，**拦住**已经进来但没授权的人。这是墙，必须挡。
  //     · inline → 内联卡片：放在**登录页**，排在登录表单下面，**不遮挡登录**。
  //       为什么不遮挡：登录和授权是两个独立的闸（登录验的是平台账号，授权验的是本机码），
  //       把登录表单盖住等于用第二道闸去堵第一道 —— 用户既登不进也激活不了。
  const body = (
    <div style={{ padding: inline ? 0 : '8px 4px 2px' }}>
      <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: 0.2, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--c-text-2)', marginBottom: 18 }}>
        {inline
          ? '粘贴激活码即可调用 AI。登录仍然照常，两者互不影响。'
          : '粘贴激活码即可继续使用。激活码和这台电脑绑定，换机需要重新申请。'}
      </div>

      <div style={{ fontSize: 13, color: 'var(--c-text-2)', marginBottom: 6 }}>激活码</div>
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onPressEnter={doActivate}
        placeholder="DOUYA-XXXX-XXXX-XXXX"
        size={inline ? 'middle' : 'large'}
        autoFocus={!inline}
        disabled={busy}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 1 }}
      />

      <Button
        type="primary"
        size={inline ? 'middle' : 'large'}
        block
        onClick={doActivate}
        loading={busy}
        disabled={!String(code || '').trim()}
        style={{ marginTop: 12, borderRadius: 10, height: inline ? 36 : 42, fontWeight: 600 }}
      >
        激活
      </Button>

      {msg && (
        <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.6, color: msg.indexOf('成功') >= 0 ? 'var(--c-brand)' : '#d4380d' }}>
          {msg}
        </div>
      )}

      {Number.isFinite(days) && days > 0 && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--c-text-2)' }}>
          授权还剩 {days} 天，建议现在续期。
        </div>
      )}

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--c-border)' }}>
        <div style={{ fontSize: 12.5, color: 'var(--c-text-2)', lineHeight: 1.7 }}>
          本机机器码
          <span style={{ marginLeft: 8, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600, color: 'var(--c-text)' }}>
            {machine || '读取中…'}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--c-text-2)', marginTop: 6, lineHeight: 1.7 }}>
          激活不了就把这串机器码发给客服，让他给你对一台新机器的码。
        </div>
        <Button size="small" type="link" style={{ paddingLeft: 0, marginTop: 2 }} onClick={() => { setMsg(''); refresh(); }}>
          重新检查
        </Button>
      </div>
    </div>
  );

  // inline：登录页形态。没被拦就**什么都不画**（不在正常用户面前闪烁）。
  if (inline) {
    if (!blocked) return null;
    return <div className="login-license-card">{body}</div>;
  }

  return (
    <Modal
      open={blocked}
      footer={null}
      closable={false}
      maskClosable={false}
      keyboard={false}
      width={440}
      centered
      title={null}
    >
      {body}
    </Modal>
  );
}

export default function App() {
  const [sessions, setSessions] = useState({ currentId: null, items: {} });
  // 2026-10-18 第十六轮：聊天区分区（老板第 3 条：首页跟豆芽助手合并，做成类似豆包的
  // 对话框，在聊天区区分「对话」和「工作」）。
  //   · chat = 日常对话（问答 / 方案 / 分析）—— 与旧行为完全一致；
  //   · work = 工作区（开发类 agent 任务）—— 后端会跑双 AI 自检 + 复检 + 对话汇报。
  // 两个分区共用同一套会话机制，会话对象带 scope 字段区分，互不串扰。
  const [chatScope, setChatScope] = useState(() => {
    try { return localStorage.getItem('douya-chat-scope') === 'work' ? 'work' : 'chat'; } catch { return 'chat'; }
  });
  const messages = sessions.items[sessions.currentId]?.messages || [];
  // 渲染前把连续的工具调用聚合成组，避免「做一步刷一行」
  const displayMessages = useMemo(() => groupToolCalls(messages), [messages]);
  // 2026-09-22（老板提案第 4 条）：最后一个工具组承载「任务最终状态」，避免 UI 拿工具历史当任务状态。
  // 只有这一组会显示后端算出的终态（完成 / 还没做完 / 卡住了），历史里的旧组只显示中性计数。
  const lastToolsIndex = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i] && displayMessages[i].__group === 'tools') return i;
    }
    return -1;
  }, [displayMessages]);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // 【2026-10-14 第八轮】对话模式已合并为「豆芽助手」单入口，chatMode 状态一并删除：
  // 四个模式的 chips 完全相同、只换了 placeholder，属于用户不会用到的第三层开关。
  // 「能叫停」：本次任务的 taskId（随 /api/chat 发给后端）+ 是否显示停止按钮。
  // 停止按钮只对**正在跑的对话任务**生效，与录音的「停止」是两回事。
  const taskIdRef = useRef('');
  /**
   * 【第二十二轮 · 老板第 5 条 a】用户是否点了「停止」。
   *
   * 为什么要单独记一个 ref：`stopTask()` 只是 POST /api/abort，后端随后会**优雅收尾**
   * （回一段报告再 res.end()），前端这条 fetch 既可能正常结束也可能抛错。没有这个标记时，
   * 「你自己按了停止」会和「网络断了」共用同一句失败文案 —— 那等于把用户的操作说成故障。
   * 收尾处（send 的 catch / finally）读它来决定归到「你已取消」还是别的类。
   */
  const cancelRef = useRef(false);

  const [canStop, setCanStop] = useState(false);
  // 断线续跑（第十八轮）：后端还有任务在跑时，这里存它的摘要，界面上给一条「接回来」提示。
  const [activeTask, setActiveTask] = useState(null);
  const [thinking, setThinking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // 当前主题（2026-11-08 · 主题二期）：订阅 themeStore，「外观」卡据此高亮当前项。
  // ★ 必须放在组件顶层（Hook 规则），不能挪进 `settingsPanel === 'theme'` 的条件块里。
  // ★ 这个 hook 是纯订阅：切换主题的动作走 `setAppTheme`（nextTheme 这一路本轮没用上，
  //   因为老板要的是三选一，不是"点一下轮着换"）。
  const themeNow = useTheme();
  // 把主题同步给主进程（2026-11-08 · 主题二期）。
  // 为什么这一句在 App 里而不是 themeStore 里：themeStore 属于主题地基那一刀，本轮不动它；
  // 而主进程只需要"每次主题变化时被告知一声"，App 是必然挂载且已经订阅了主题的地方。
  // 效果：① 落 userData/theme.json ⇒ 下次冷启动 `BrowserWindow.backgroundColor` 就是对的；
  //       ② 立刻换当前窗口底色 ⇒ 切主题后 resize / 恢复最小化那一帧不再补错色。
  // ★ 挂载时也会跑一次（themeNow 初值 = 存盘值），正好把"渲染层才是权威"这件事对齐给主进程。
  // ★ 环境里没有 window.api（jsdom 单测 / 浏览器预览）时静默跳过 —— 主题本身不受影响。
  useEffect(() => {
    try {
      const api = typeof window !== 'undefined' ? window.api : null;
      if (api && typeof api.setTheme === 'function') api.setTheme(themeNow);
    } catch {
      // 主进程通道缺失不该影响配色：localStorage + data-theme 已经独立生效。
    }
  }, [themeNow]);
  // 常驻「使用指南」弹窗开合（入口在标题栏；老板：「页面有个教程这样更方便一些」）
  const [showUsageGuide, setShowUsageGuide] = useState(false);
  // 设置弹窗内的一级板块选择：null = 显示四张入口卡；非 null = 显示对应二级内容。
  // 取值：'model'（联网模型）/ 'shop'（商城）/ 'miniprogram'（小程序）/ 'advanced'（高级配置）。
  const [settingsPanel, setSettingsPanel] = useState(null);
  // ---- 视频设计（通义万象）配置（0.21.22 · 老板第 5 条「把 api 放到设置里面去」）----
  // 铁律没变：渲染层不直连外网，也**不持有 key 明文**——
  // 用户在这里输入后立刻走 wanx:saveKey 落 userData/wanx.json，回显只取 status.masked（掩码）。
  // 下面所有金额都来自本地账本 + 本地单价配置，是**估算**，不是控制台账单。
  const [wanxSt, setWanxSt] = useState(null);
  const [wanxKeyDraft, setWanxKeyDraft] = useState('');
  const [wanxKeyMsg, setWanxKeyMsg] = useState('');
  const [wanxKeyBusy, setWanxKeyBusy] = useState(false);
  // 「历史 Key 待认领」的导入状态。分账号之前写下的全局 key 不会自动生效
  //（判据：无法可靠判断归属时保留为待认领，不猜），只能由人在界面上点一下显式复制。
  const [wanxLegacyMsg, setWanxLegacyMsg] = useState('');
  const [wanxLegacyBusy, setWanxLegacyBusy] = useState(false);
  const [wanxLedgerRows, setWanxLedgerRows] = useState([]);
  const [wanxDirMsg, setWanxDirMsg] = useState('');
  // 顶栏窗口按钮：是否最大化。由主程序 win:isMaximized（初查）+ win:maximized-changed（推送）驱动，
  // 据此在「最大化 □」与「还原 ❐」之间切换图标。
  const [winMaximized, setWinMaximized] = useState(false);
  // 登录页背景视频：加载失败 → 回落绿色渐变（不空屏）；带声自动播放被拦截 → 展示「开启声音」兜底按钮。
  const [loginVideoFailed, setLoginVideoFailed] = useState(false);
  const [loginVideoBlocked, setLoginVideoBlocked] = useState(false);
  // 联网检索 key 是否已配置：后端 /api/config 只回布尔状态，绝不回显 key 原文。
  const [tavilyConfigured, setTavilyConfigured] = useState(false);
  // ---- 模块切换（左侧导航卡片）----
  // 旧 key 归位：`geo` / `competitor` 的独立展示已下线（其唯一出口归并进「经营诊断」，
  // 老板反馈 #7）。但 localStorage 里可能残留旧值、外部深链也可能还在用这两个 key。
  // 若直接把它们从白名单里删掉，会**静默落到 today** —— 正是老板抱怨的
  // 「点了经营方案就跳到今天做什么」那类病。故显式重定向到 intel（它们的新家）。
  const LEGACY_MODULE_ALIAS = {
    geo: 'intel',
    competitor: 'intel',
    // 【0.21.21】`today` 原来归一到 `activity`；`activity` 已整块下线 ⇒ 这里必须**直接**
    // 改到 workbench。⚠️ 别想着「today→activity→workbench 会两级传递」——`effectiveModule`
    // 只查一次表、不递归，中间值就是终点。写成两级会渲染一个已删除的分支 ⇒ 白屏。
    today: 'workbench',
    // 【2026-10-19 第十九轮 · 老板第 1 条】「首页」入口已删（与豆芽助手重复）。
    // 老存档 / 深链里的 `home` 仍可能出现，统一归一到 workbench —— 否则会落到一个
    // 侧栏没有任何高亮的孤儿分支（2026-10-18 那版是靠 home 分支渲染聊天页兜住的，
    // 入口删了就不该再依赖它）。
    home: 'workbench',
    // ─── 【0.21.21 · 老板 2026-10-21】「活动与档期」整板块下线的三张归位表 ───────────
    // 这张表是本轮**唯一的防白屏总闸**：`effectiveModule`（下方 ~916 行）与 localStorage
    // 初值都查它，而每一处 `setActiveModule` / `onSelectModule(...)` 最终都要经过
    // `effectiveModule` 才会命中渲染分支。故只要这里兜住，就算还有遗漏的
    // `onSelectModule('activity')`，结果也是「落到豆芽助手」而不是「主体区一片空白」。
    //
    //   ① activity = 原「活动与档期」页（ActivityHub）。删除后**没有新家**，统一回 workbench。
    //      三处最危险的入口全靠它兜：
    //        · 首登完成（handleOnboardDone 里原本无条件 setActiveModule('activity')）
    //        · 上游货源档期页的「← 返回」（原 setActiveModule('activity')，随 miaomiao 一起没了）
    //        · 老存档 douya-active-module = 'activity'
    //   ② huodong = 旧版「活动策划」向导页（ActivityPlanning）。**能力保留、页面换家**：
    //      按老板「保留做活动方案能力」的决策，归一到 `campaign`（营销专项 = CampaignModule，
    //      就是「一句话生成活动方案」那一页）。全仓 30+ 处深链指向 `huodong`
    //      （companyTypeConfig 的模块目录、capabilityResolver、marketMomentumRoute、
    //      moduleBrief / moduleAssistant、CompetitorAnalysis、goalCatalog 的 routeForGoal），
    //      在这里一刀归位比逐个改那 30 处安全，也不会漏。
    //   ③ miaomiao = 内嵌 api.example.com 档期页的 iframe 外壳（MiaomiaoSchedule）。
    //      档期页在 workbench 侧同步下线 ⇒ 外壳留着只是个 404 容器，故一并删除，深链回 workbench。
    activity: 'workbench',
    huodong: 'campaign',
    miaomiao: 'workbench',
  };
  const [activeModule, setActiveModule] = useState(() => {
    const raw = localStorage.getItem('douya-active-module');
    const m = LEGACY_MODULE_ALIAS[raw] || raw;
    // 【0.21.9 收尾】白名单删掉 'home'：上一行 `LEGACY_MODULE_ALIAS[raw]` 已把 home 归一成
    // workbench，这里再留 'home' 就是一条永远走不到的入口 —— 后人会以为首页还活着。
    // 【0.21.14 · 需求 3】白名单加 'replenish'（AI 补货）。它是**全身份可见**的一级入口
    // （ModuleNav 里不写 roles），所以这里必须放行，否则刷新后会被兜底回 workbench，
    // 表现成「点了 AI 补货，重开又回到豆芽助手」—— 一个只在重启后出现的失忆 bug。
    // 【0.21.20 · 老板 2026-10-21】白名单加 'videodesign'（视频设计）。理由同上一条：
    // 它是全身份可见的一级入口，不放行的话刷新后会被兜底回 workbench，
    // 表现成「进了视频设计，重开又回到豆芽助手」—— 只在重启后出现的失忆 bug。
    // 【0.21.21】白名单删 'activity' / 'huodong' / 'miaomiao'：三个 key 都已被上面那张
    // 别名表归一（`activity→workbench`、`huodong→campaign`、`miaomiao→workbench`），
    // 留在白名单里就是三条永远走不到的入口 —— 后人会以为活动与档期还活着。
    // 【0.21.21 · 老板 2026-10-21 补漏】白名单加 'storeops' / 'dealerbuy'。
    //   这是一个**在本轮之前就存在**的失忆 bug（不是这次改动引入的），顺手补掉：
    //   两者都是身份专属入口（storeops 只给 clinic/doctor、dealerbuy 只给 dealer），
    //   ModuleNav 里能点、App 里有渲染分支，却一直被漏在这张白名单之外 ⇒
    //   「诊所点了门店运营 / 经销商点了采购专区，重开软件又回到豆芽助手」。
    //   判据和上面 replenish / videodesign 那两条完全一样：**有渲染分支的一级入口必须放行**。
    // ⚠️ 维护提醒：这张表是手写的，加一个一级入口就要同步加一次，漏了就只在「重启后」暴露。
    //   `scripts/smoke/unit-spa-route.mjs` 已对「别名目标可达」做断言，但**不覆盖这条白名单**
    //   （它管的是深链归位，不是持久化）。改这张表时请顺手跑一次真实的重启复现：
    //   进目标页 → 关掉 → 重开 → 确认还在那一页。
    const validModules = ['daily', 'learn', 'project', 'goal', 'asset', 'brain', 'workbench', 'xinmeiti', 'media', 'campaign', 'direction', 'crisis', 'content', 'videodesign', 'videostudio', 'profile', 'newmedia', 'intel', 'replenish', 'storeops', 'dealerbuy', 'mindmap'];
    return validModules.includes(m) ? m : 'workbench';
  });
  // P2：跨模块回流意图（市场与声势 → 营销专项）。仅在 MarketMomentum 触发回流时非空，
  // 由消费方页面读一次后清空（onIntentConsumed），避免普通导航后残留触发。
  // 【0.21.21】消费方只剩 `campaign`（CampaignModule）。原来 ActivityPlanning 也接这一份，
  // 它随「活动与档期」删掉后，`huodong` 深链会先被别名归一到 `campaign`，
  // 所以 `routeIntent` 的 `confirm_brief` / `adjust` 两种 kind **全部由 campaign 分支接住**——
  // 那条分支里的 initialBrief / initialActivityId / onIntentConsumed 三个 prop 一个都不能少。
  const [routeIntent, setRouteIntent] = useState(null);
  // T05-3「一跳即见结论」：企业资产库（模块 profile）的初始 Tab。
  // 【0.21.9 · 老板第 4 条】默认 Tab 从 'asset' 改成 'brain'：「以企业大脑为核心」，
  // 资产 / 子品牌降为两个胶囊按钮。进页面先看到企业大脑的内容，而不是一张资产表单。
  const [profileTab, setProfileTab] = useState('brain');
  // 离开 profile 模块后复位为默认 Tab：这样下次经普通导航（左侧菜单/其它入口）进来仍落在「企业大脑」，
  // 不会被上一次「去资产 / 子品牌」的残留状态带偏。
  useEffect(() => {
    if (activeModule !== 'profile') setProfileTab('brain');
  }, [activeModule]);
  // 打开企业大脑并指定 Tab（供引导卡「补资料 / 看体检结论」调用）。
  function openProfileTab(tabKey) {
    setProfileTab(tabKey === 'brand' || tabKey === 'asset' ? tabKey : 'brain');
    setActiveModule('profile');
  }
  /**
   * 【0.21.21 · 老板 2026-10-21】`mmTab` 已随「上游货源档期」(miaomiao) 一起删除。
   *
   * 这个 state 原本只服务于「活动与档期 → 厂家报名入口」那一下：点它要把内嵌的
   * workbench 档期页直接开到「我要报名」页签，靠 ① iframe src 带 tab 参数
   * ② 主进程在子 frame 里执行 switchTab()（main.js 的 mmclaw:schedule-tab）两条路实现。
   * 档期页在 workbench 侧下线、iframe 外壳（MiaomiaoSchedule.jsx）也一并删了，
   * 这两个消费点全没了 ⇒ state 留着就是一段永不触发的死状态，故整块删除。
   * ⚠️ `main.js` 里的 `mmclaw:schedule-tab` IPC 与 `setupMmclawAuthInjection`
   *    （向 api.example.com/api/* 注入登录态实现免登）同步删除，别再单独把它们挂回来。
   */
  // P0-2：目标引导面板状态（点选有步骤的目标后进入，可随时跳过）
  const [guideGoalId, setGuideGoalId] = useState(null);
  // 营销目标卡片化：点卡片先进 AI 方案预览（previewGoalId），确认后才真正建项目
  const [previewGoalId, setPreviewGoalId] = useState(null);
  const [previewGoalLabel, setPreviewGoalLabel] = useState('');
  // 退出引导：清零并切到指定落地模块
  const exitGuide = (module) => {
    setGuideGoalId(null);
    if (module) setActiveModule(module);
  };
  // 模块切换统一入口：兼容「字符串（普通导航）」与「{ module, intent }（跨模块回流）」两种调用。
  // 普通导航清空回流意图；回流导航把 intent 交给目标模块消费（P2 正式跨模块回流）。
  function handleSelectModule(target) {
    if (target && typeof target === 'object' && target.module) {
      setActiveModule(target.module);
      setRouteIntent(target.intent || null);
    } else {
      setRouteIntent(null);
      setActiveModule(target);
    }
  }
  // 营销目标 + 企业营销资产（阶段二 P0 共享状态，来自 MarketingProvider）
  const { goal } = useMarketingGoal();
  const { asset } = useMarketingAsset();
  // 多企业 + 项目 + 任务（阶段三 IA，来自 CompanyProvider）
  const { companies, currentCompany, currentProject, currentRole, currentWorkspaceRole, currentTask, workspace, setCurrentTask, setAccount, completeTaskByAI } = useCompany();
  // 【2026-10-12 新版 UI】右栏「关键任务」= 本企业真实落库的活动（activityStore），
  // 不编演示数据；没有就显示空态引导。
  const { listActivities } = useActivity();
  const railTasks = useMemo(() => {
    const cid = currentCompany ? String(currentCompany.id) : '';
    if (!cid) return [];
    try {
      const list = listActivities({ companyId: cid }) || [];
      return list.slice(0, 3).map((a) => ({
        id: a.id,
        name: a.name || '未命名活动',
        status: a.status || '',
        when: a.startDate || a.createdAt || '',
      }));
    } catch {
      return [];
    }
  }, [listActivities, currentCompany]);
  const { getKnowledge, updateProfile, addFact, addRule } = useCompanyKnowledge();
  const { listAssets, addAsset, updateAsset } = useAssets();
  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';
  // ──────────────────────────────────────────────────────────────────────────
  // 侧栏红点（0.21.14 · S7 语义 / S8 单一真源）
  //
  //   replenish = 到货 SKU **件数**（上一轮快照里判过到货、且 `at` 晚于已读水位）
  //   ~~activity = 未读新档期条数~~ —— 【0.21.21】随「活动与档期」侧栏卡一起删除，
  //   见下方 effect 里的说明。
  //
  // 两条硬约束：
  //   ① **只算不编**：拿不到数就是 0（ModuleNav 收到 0 不渲染红点），绝不拿「活动总数」
  //      或「商品总数」冒充未读数 —— 那会让红点变成一个永远消不掉的红点。
  //   ② **本组件是唯一计算方与唯一监听者**（S8）。业务页改完水位只负责派发
  //      `douya:navdots-refresh`，不自己算红点、也不直接改这里的 state。
  // ──────────────────────────────────────────────────────────────────────────
  const navCid = currentCompany && currentCompany.id ? String(currentCompany.id) : '';
  const [navDots, setNavDots] = useState({});
  // 刷新信号：监听事件只做「+1」，真正的重算收敛在下面唯一的 effect 里，
  // 这样「什么时候算」和「怎么算」只有一处实现，不会出现两个入口算出两个结果。
  const [navDotsTick, setNavDotsTick] = useState(0);
  useEffect(() => {
    function onNavDotsRefresh() {
      setNavDotsTick((t) => t + 1);
    }
    window.addEventListener('douya:navdots-refresh', onNavDotsRefresh);
    return () => window.removeEventListener('douya:navdots-refresh', onNavDotsRefresh);
  }, []);
  useEffect(() => {
    if (!navCid) {
      setNavDots({});
      return;
    }
    // 本地可算的部分先出（同步、零网络）：到货红点来自 localStorage 快照，
    // 没必要为了它等一次 HTTP；断网时它也应该照常显示。
    let local = {};
    try {
      const snap = readStockSnapshot(navCid);
      // 只有被 diffStock 判过「到货」的记录才算数（`arrived === true`）；
      // 从第一轮就在库的商品不会被误报成「刚到货」。
      const arrivedKeys = Object.keys(snap).filter((k) => snap[k] && snap[k].arrived === true);
      local = { replenish: countArrived(arrivedKeys, snap, readReplenishSeen(navCid)) };
    } catch {
      // 快照坏掉 / localStorage 不可用 ⇒ 不报红点（不编一个数字糊上去）
      local = { replenish: 0 };
    }
    setNavDots(local);
    // 【0.21.21 · 老板 2026-10-21】这里原有一段 `loadSchedules().then(...)`
    // 去算 `navDots.activity`（未读档期条数）。「活动与档期」侧栏卡已整块删除，
    // 没有任何组件再消费这个 key ⇒ 整段删掉。收益是实打实的：
    // 切企业 / 每次 navDots 重算都不再为一个**看不见的红点**白打一次档期接口。
    // ⚠️ 顺带保留了这段 effect 的语义边界：只剩本地同步计算，**没有任何网络请求**
    //    ⇒ 断网时到货红点照常显示（这是原来就要的行为，不是本轮新增）。
    // ⚠️ `alive` 守卫也随之删除（没有异步回调了，不可能在卸载后 setState）。
  }, [navCid, navDotsTick]);
  // P0-3：切换企业引导横幅（轻提示，不强制弹窗）
  const [showCompanyGuide, setShowCompanyGuide] = useState(false);
  const prevCompanyRef = useRef(null);
  useEffect(() => {
    const id = currentCompany && currentCompany.id;
    if (prevCompanyRef.current !== null && prevCompanyRef.current !== id) {
      setGuideGoalId(null); // 切换企业时重置目标引导态
      setPreviewGoalId(null);
      setPreviewGoalLabel('');
      setShowCompanyGuide(true);
    }
    prevCompanyRef.current = id || null;
  }, [currentCompany && currentCompany.id]);

  // 当前项目资料（type=material 的资产，注入 AI 上下文）
  const projectMaterials = useMemo(() => {
    if (!currentCompany || !currentProject) return [];
    return listAssets({ companyId: currentCompany.id, projectId: currentProject.id }).filter((a) => a.type === 'material');
  }, [currentCompany, currentProject, listAssets]);

  // T20 任务资产落库器（按 taskId + type 去重；与 TodayOps 里同一实现，供「让豆芽做」自动开跑收尾复用）。
  const saveTaskAsset = useMemo(
    () => createTaskAssetSaver({ addAsset, updateAsset, listAssets }),
    [addAsset, updateAsset, listAssets],
  );

  /**
   * T20：任务 → 能力 → 默认资产 type（无则兜底 document）。
   * 与 TodayOps.assetTypeFor 口径一致（同一 resolveCapabilityForType）；此处重写是为让
   * 「让豆芽做」在跳转后（TodayOps 已卸载）仍能落库，不依赖已卸载组件的闭包。
   */
  function assetTypeForTask(task) {
    const capId = resolveCapabilityForType(
      (task && (task.taskType || task.capability)) || '',
      companyType,
      currentProject && currentProject.type,
    );
    const cap = getCapability(capId);
    return (cap && cap.assetType) || 'document';
  }

  // ---- 顶层视图路由：onboarding / companies / workbench（持久化，刷新/重启恢复）----
  const [view, setView] = useState(() => {
    const v = localStorage.getItem('douya-view');
    if (v === 'onboarding' || v === 'companies' || v === 'workbench') return v;
    return 'workbench';
  });
  // 视图持久化
  useEffect(() => {
    localStorage.setItem('douya-view', view);
  }, [view]);
  // 目标不再强制首屏：默认进「今日运营」首页，目标从导航/首页入口进入（GoalSelector 内部处理无目标态）
  //
  // 【旧 key 归一的**运行时**护栏】不能只在 useState 初始化时归一。
  // 已下线独立展示的 `geo` / `competitor`，仍可能由**运行时**跳转写入
  // （如 BackgroundJobsBar 点「竞品对比分析」任务条 → onSelectModule('competitor')）。
  // 若无条件直接 `= activeModule`，这类跳转会落到**不存在的渲染分支** →
  // 内容区整块空白（比"退回首页"更糟）。故这里统一按别名归一后再渲染。
  const effectiveModule = LEGACY_MODULE_ALIAS[activeModule] || activeModule;
  // 模块（workbench 内部）持久化：切走再切回恢复到上次模块，避免重置回「今日运营」
  useEffect(() => {
    localStorage.setItem('douya-active-module', activeModule);
  }, [activeModule]);

  // ---- 豆芽对话内的两个分区：对话（经营对话）/ 工作（开发工作台）（持久化）----
  // 第十九轮（老板第 3 条）：原来的三个小页签（经营对话 / 开发工作台 / ⏰ 定时任务）
  // 换成**一个**「对话 / 工作」大号居中切换。定时任务不再是页签，入口收进统一任务栏
  // 底部那一组（点进去仍是 wbTab='automation'）—— 所以 wbTab 的三个取值**一个没减少**，
  // 持久化 key `douya-workbench-tab` 也原样不动（用户上次停在哪，重开还在哪）。
  const [wbTab, setWbTab] = useState(() => {
    const v = localStorage.getItem('douya-workbench-tab');
    return v === 'dev' || v === 'automation' ? v : 'chat';
  });
  useEffect(() => {
    localStorage.setItem('douya-workbench-tab', wbTab);
  }, [wbTab]);
  /** 「对话 / 工作」大切换：聊天页放主区顶部居中，开发工作台由 App 传进去放它主列顶部。 */
  const wbTabsSlot = <ScopeSwitch tab={wbTab} onChange={setWbTab} />;

  // 第十九轮（老板第 3 条）第 6 点：任务栏点「开发任务」→ 切到 wbTab='dev' 并把它定位到那条会话。
  // 三个字段都要有：projectId / sessionId 交给 DevWorkbench，nonce 负责「同一条任务点第二次也要生效」
  //（只比数值的话，用户点了 A → 在开发台手动切到 B → 再点 A，props 没变、effect 不重跑 ⇒ 不动）。
  const [devFocus, setDevFocus] = useState({ projectId: '', sessionId: '', nonce: 0 });

  // ---- 统一任务栏的数据（对话会话 + 开发会话按 updatedAt 混排；定时任务单独一组）----
  // 会话数据的主人是 App 自己的 sessions 状态，开发会话的主人是 localStorage（devProject.js）。
  // 这里只读一次做展示；点开发任务时再让 DevWorkbench 自己 reload，避免两处状态互相覆盖。
  const [devSessionTick, setDevSessionTick] = useState(0);
  useEffect(() => {
    // 切到任务栏/开发台时刷新一次开发会话，保证「刚在开发台新建的会话」马上出现在任务栏里。
    if (wbTab === 'dev' || wbTab === 'chat') setDevSessionTick((n) => n + 1);
  }, [wbTab]);
  const [autoItems, setAutoItems] = useState([]);
  const [autoAvailable, setAutoAvailable] = useState(false);
  /**
   * 定时任务取数（数据归主进程 window.api.automation*）。
   * 浏览器 / 无 IPC 环境**没有**这个能力 ⇒ 只显示「定时任务」这一行入口，
   * 不去假装读到了空列表（那会骗用户「你没建过任务」）。
   * 抽成函数而不是只写在 effect 里：0.21.11 任务栏支持删定时任务，删完要立刻重取。
   * @returns {Promise|null} 无 IPC 能力时返回 null（不是失败，是"本环境没有"）
   */
  function loadAutos() {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.automationList !== 'function') {
      setAutoAvailable(false);
      setAutoItems([]);
      return null;
    }
    setAutoAvailable(true);
    return api.automationList()
      .then((list) => setAutoItems(mapAutomations(list)))
      .catch(() => setAutoItems([]));
  }
  useEffect(() => {
    loadAutos();
    // 切页时重取一次即可；组件卸载后的 setState 在 React 18 是无声 no-op，不做 alive 守卫。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wbTab]);

  const taskBarItems = useMemo(() => {
    const chatItems = Object.values(sessions.items).map((s) => ({
      key: 'chat:' + s.id,
      kind: 'chat',
      id: s.id,
      title: s.title || '新对话',
      time: fmtTime(s.updatedAt),
      updatedAt: Number(s.updatedAt) || 0,
    }));
    let devItems = [];
    try {
      const projects = loadDevProjects();
      const nameOf = (id) => {
        const p = projects.find((x) => x.id === id);
        return p ? p.name : '';
      };
      devItems = loadDevSessions().map((s) => ({
        key: 'dev:' + s.id,
        kind: 'dev',
        id: s.id,
        projectId: s.projectId,
        title: s.title || nameOf(s.projectId) || '开发会话',
        time: fmtTime(s.updatedAt),
        updatedAt: Number(s.updatedAt) || 0,
      }));
    } catch {
      // localStorage 不可用（隐私模式等）：任务栏只显示对话，不白屏
      devItems = [];
    }
    // 业务要求：三类任务**按 updatedAt 倒序混排**（不是先分块再排）——
    // 这样「刚刚动过的那件事」永远在最上面，符合同一个栏里「一条时间线」的直觉。
    return chatItems.concat(devItems).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // devSessionTick 是「让上面这段重算一次」的触发器（localStorage 不是响应式的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.items, devSessionTick]);

  const currentTaskKey = useMemo(() => {
    if (wbTab === 'dev') return devFocus.sessionId ? 'dev:' + devFocus.sessionId : '';
    if (wbTab === 'automation') return 'auto:entry';
    if (wbTab === 'chat' && sessions.currentId) return 'chat:' + sessions.currentId;
    return '';
  }, [wbTab, devFocus.sessionId, sessions.currentId]);

  /**
   * 任务栏点一条任务：按种类分流，**只换视图与定位，不改任何业务数据**。
   * @param {{kind:string,id:string,projectId?:string}} it
   */
  function openTaskFromBar(it) {
    if (!it) return;
    if (it.kind === 'dev') {
      setDevFocus((prev) => ({
        projectId: it.projectId || '',
        sessionId: it.id || '',
        nonce: (prev.nonce || 0) + 1,
      }));
      setWbTab('dev');
      setActiveModule('workbench');
      return;
    }
    // 对话任务：会话本身带 scope（'chat' | 'work'），点它就把分区也拨过去，
    // 否则「工作区里那条对话」点开后会停在对话分区、看着像没反应。
    // 这里一次 setSessions 完成（不串两次 setState），避免读到上一轮的旧快照。
    const item = sessions.items[it.id];
    if (!item) return;
    const sc = item.scope === 'work' ? 'work' : 'chat';
    if (sc !== chatScope) {
      setChatScope(sc);
      try { localStorage.setItem('douya-chat-scope', sc); } catch { /* 隐私模式静默 */ }
    }
    const next = { ...sessions, currentId: it.id };
    setSessions(next);
    persistStore(next);
    setWbTab('chat');
    setActiveModule('workbench');
  }

  /**
   * 【0.21.11 · 「任务栏是可以删除的」】删任务栏里的一条任务。
   *
   * 三类任务的"删除"是三种完全不同的操作，这里按 kind 分流，**不假装同一个 API**：
   *   · chat：App 自己的 sessions.items（真实聊天历史）→ 删这一条 + 把当前会话重选到同分区最新一条；
   *   · dev ：localStorage 的 dev session → 走 devProject.removeSession（它带 normalize 与上限裁剪，
   *           直接改 localStorage 会绕过）；
   *   · auto：主进程排期，见 deleteAutoTask（那是"会自己干活的定时器"，删错影响更大，单独拆函数）。
   *
   * 有意不做的两件事：
   *   · 不删 `/api/deliverables` 里的成果文件 —— 删聊天记录 ≠ 删交付物。成果右栏是独立存储，
   *     用户删一条脏对话不该连带丢掉那份报告；
   *   · 删完不自动补一条空会话 —— 自动补会让人以为"没删掉"（列表里永远躺着一条"新对话"）。
   *     下次发消息时 ensureSession 会按需新建。
   * @param {{kind:string,id:string,projectId?:string}} it 任务栏条目（TaskCenter 原样回传）
   */
  function deleteTask(it) {
    if (!it) return;
    if (it.kind === 'dev') {
      removeDevSession(it.id);
      // localStorage 不是响应式的，靠这个 tick 让 taskBarItems 重算
      setDevSessionTick((n) => n + 1);
      // 删的正好是开发台当前打开的那条 ⇒ 清掉定位，否则开发台会挂在一个已不存在的 sessionId 上
      if (devFocus.sessionId === it.id) {
        setDevFocus({ projectId: '', sessionId: '', nonce: (devFocus.nonce || 0) + 1 });
      }
      return;
    }
    // ---- 经营对话 ----
    const victim = sessions.items[it.id];
    if (!victim) return;
    const items = { ...sessions.items };
    delete items[it.id];
    let currentId = sessions.currentId;
    if (currentId === it.id) {
      const sameScope = Object.values(items)
        .filter((x) => (x.scope || 'chat') === (victim.scope || 'chat'))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      currentId = sameScope.length ? sameScope[0].id : null;
    }
    const next = { currentId, items };
    setSessions(next);
    persistStore(next);
  }

  /**
   * 【0.21.11】删一条定时任务（真排期，走主进程 automation:remove）。
   * 删完**重取**列表，不做乐观就地删除 —— 主进程若因权限/文件锁失败，
   * 就地删会显示"已删"，下次启动它又回来，比不删更糟。
   * @param {string} id 定时任务 id
   */
  function deleteAutoTask(id) {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.automationRemove !== 'function') return;
    api.automationRemove(String(id || ''))
      .then(() => loadAutos())
      .catch(() => { /* 失败就保持原样：用户会看到它还在这儿，再点一次即可，不谎报已删 */ });
  }


  // ---- 堵串企业：企业/项目切换时，同步租户上下文 + 清空旧会话（防止旧企业对话/上下文残留）----
  const prevCompanyIdRef = useRef(null);
  useEffect(() => {
    const cid = (currentCompany && currentCompany.id) || null;
    const pid = (currentProject && currentProject.id) || null;
    // 统一企业上下文（四类知识 + 项目/任务 + 角色），随 geoProxy 请求带给豆芽AI工作台，
    // 让 GEO / 媒体 / 活动 / 危机 / 新媒体 等业务模块的 AI 也能基于企业完整画像深度思考。
    const ctx = buildContext({
      workspace,
      company: currentCompany,
      asset,
      knowledge: getKnowledge(cid),
      project: currentProject,
      task: currentTask,
      role: currentRole || 'admin',
      workspaceRole: currentWorkspaceRole || 'admin',
      goalLabel: (goal && goal.label) || '',
      projectMaterials,
    });
    // 同步 geoProxy 租户上下文（id 头 + 企业内容上下文）
    setTenantContext({
      companyId: cid,
      projectId: pid,
      workspaceId: (workspace && workspace.id) || null,
      role: currentRole || 'admin',
      contextText: ctx.text,
    });
    // 企业发生切换 → 清空会话，下次发言自动新开会话（新上下文），旧企业对话不再残留
    if (cid !== prevCompanyIdRef.current) {
      prevCompanyIdRef.current = cid;
      setSessions({ currentId: null, items: {} });
    }
  }, [currentCompany, currentProject, workspace, currentRole, asset, goal, currentTask, currentWorkspaceRole, getKnowledge, projectMaterials]);

  // ---- 第二阶段第三步：资产库（企业画像）→ 四类知识 Profile 打通 ----
  // AssetPanel 建档/刷新/编辑写 marketingStore.asset（13 项画像），这里把 Profile 类项
  // 实时同步进 companyKnowledgeStore.profile，让 buildAIContext 读到的 Profile 始终是最新的，
  // 而不是 migrateKnowledgeOnce 迁移时的旧快照。用签名去重，值未变不重复写。
  const profileSigRef = useRef('');
  useEffect(() => {
    if (!currentCompany || !asset) return;
    const cid = currentCompany.id;
    const isBuilt = !!((asset.companyName && String(asset.companyName).trim()) || (asset.meta && asset.meta.builtAt != null));
    const facts = isBuilt
      ? (Array.isArray(asset.brandFacts) ? asset.brandFacts : []).map((x) => String(x).trim()).filter(Boolean)
      : [];
    const rules = isBuilt
      ? [].concat(asset.contentTaboos || [], asset.complianceWords || []).map((x) => String(x).trim()).filter(Boolean)
      : [];
    const sig = JSON.stringify([
      isBuilt, asset.companyName, asset.brandTone, asset.industry, asset.products, asset.profile,
      asset.coreSellingPoints, asset.targetCustomers, asset.competitors, facts, rules,
    ]);
    if (profileSigRef.current === cid + '|' + sig) return;
    profileSigRef.current = cid + '|' + sig;
    updateProfile(cid, {
      companyName: isBuilt ? asset.companyName || '' : '',
      brandPositioning: isBuilt ? asset.brandTone || '' : '',
      industry: isBuilt ? asset.industry || '' : '',
      products: isBuilt ? asset.products || '' : '',
      summary: isBuilt ? asset.profile || '' : '',
      coreSellingPoints: isBuilt ? asset.coreSellingPoints || [] : [],
      targetCustomers: isBuilt ? asset.targetCustomers || [] : [],
      competitors: isBuilt ? asset.competitors || [] : [],
    });
    // 事实/规则同步进知识库（addFact/addRule 语义：去重追加，保留已有手动内容）
    facts.forEach((f) => addFact(cid, f));
    rules.forEach((r) => addRule(cid, r));
  }, [asset, currentCompany, updateProfile, addFact, addRule]);

  // 执行任务（今日运营 →「执行」/「继续工作」入口）：
  // 把任务的描述/目标/要求/输出格式组装成可执行指令，预填到输入框并切到对应模块，
  // 让「选任务 → 执行」真正把上下文接进对话，AI 按任务要求干活（阶段四 AI Context 闭环）。
  // capability 由 taskType 派生（resolveCapability），落地模块由 moduleForCapability 派生（单一来源）。
  function handleRunTask(task) {
    if (!task) return;
    setCurrentTask(task.id);
    const cap = resolveCapability(task.taskType || task.capability);
    const mod = moduleForCapability(cap);
    if (mod === 'workbench') {
      const lines = [];
      if (task.description) lines.push('【任务描述】' + task.description);
      if (task.goal) lines.push('【任务目标】' + task.goal);
      if (task.requirements) lines.push('【任务要求】' + task.requirements);
      if (task.outputFormat) lines.push('【输出格式】' + task.outputFormat);
      const brief = lines.length
        ? '执行任务「' + task.title + '」：\n' + lines.join('\n') + '\n请开始。'
        : '执行任务「' + task.title + '」。';
      setInput(brief);
    }
    setActiveModule(mod);
  }

  // ---- T20：「让豆芽做」→ 带任务跳对话页 → 自动开跑（当场生成、当场看到）----
  // 老板 2026-09「第二优先」：点「让豆芽做」后不该跑完静默扔进「待审核」，要带着任务跳到
  // 豆芽对话页、当场生成、当场展示。用一张**一次性交接单**在「今日运营」与「对话页」之间传递。
  const [pendingAutoRun, setPendingAutoRun] = useState(null);

  /**
   * 「让豆芽做」派发（**新**入口，不改 handleRunTask 既有「执行 / 继续工作」行为）：
   *   组装 brief（单一事实源 buildTaskBrief）→ 写一次性交接单（带 claim 守卫）→ 切到豆芽对话页。
   * 真正的「自动发送 + 收尾」交给下面的 effect 消费**一次**完成。
   * @param {object} task 任务对象
   */
  function handleAutoRunTask(task) {
    if (!task) return;
    setCurrentTask(task.id); // 带着任务：AI 上下文（buildContext）会带上这条任务
    setPendingAutoRun({
      taskId: task.id,
      task,
      brief: buildTaskBrief(task),
      gate: createAutoRunGate(), // 一次性认领守卫：StrictMode 双跑 / 重挂载都不重复发送
      assetType: assetTypeForTask(task),
    });
    setWbTab('chat'); // 必须落在「经营对话」页签，否则对话界面未挂载、自动开跑无处可发
    setActiveModule(CONVERSATION_MODULE); // 'workbench'（豆芽对话页）
  }

  // 消费一次：对话页 → 自动发送 → 收尾（任务回写→review + 资产落库）；
  //          非对话模块 → 回退为仅预填、**不**自动发送；消费后清空交接单。
  useEffect(() => {
    if (!pendingAutoRun) return;
    const prefill = (b) => setInput(b);
    if (!isConversationModule(effectiveModule)) {
      // 目标不是对话页 → 回退为仅预填（保持既有行为），绝不强发到不支持的模块
      consumeAutoRun({ pending: pendingAutoRun, module: effectiveModule, prefill }).then((res) => {
        if (res && res.action !== 'none') setPendingAutoRun(null);
      });
      return;
    }
    consumeAutoRun({
      pending: pendingAutoRun,
      module: effectiveModule,
      // 直接把 brief 传给 send（不走 setInput 再读 state —— 那样读不到本轮刚设的值）
      send: (brief) => send(brief),
      prefill,
      // 收尾：对话页产出的正文 → 任务回写（→ 待审核）+ 资产落库，两样产出都不丢
      finalize: (content) =>
        finalizeAutoRunTask({
          task: pendingAutoRun.task,
          content,
          completeTaskByAI,
          saveAsset: saveTaskAsset,
          assetType: pendingAutoRun.assetType,
          companyId: currentCompany && currentCompany.id,
          projectId: currentProject ? currentProject.id : null,
          aiInput: pendingAutoRun.brief,
        }),
    })
      // action==='none' 说明这次守卫已被另一次 effect 触发认领（StrictMode 双跑）→ 不清空，交给认领方收尾
      .then((res) => { if (res && res.action !== 'none') setPendingAutoRun(null); })
      .catch(() => setPendingAutoRun(null));
    // 依赖只取「交接单 + 目标模块」：send / saveTaskAsset / 公司取自派发时闭包，避免中途重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoRun, effectiveModule]);

  const [listening, setListening] = useState(false);
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceDevice, setVoiceDevice] = useState('');
  // 本次要随消息一起发送的本地文件附件 { path, name }
  const [attachments, setAttachments] = useState([]);
  // 拖拽高亮遮罩开关（全局拖拽时显示）
  const [dragOver, setDragOver] = useState(false);
  // 历史成果列表（跨会话持久化，从后端 /api/deliverables 拉取，展示在右侧历史面板）
  const [historyDels, setHistoryDels] = useState([]);
  // 【0.21.11 · 老板第 7 条】过滤后的成果列表。抽出来是因为右栏现在要用它算**条数**
  // （分组标题右侧那个数字），如果在 JSX 里再调一次 filterDeliverables，
  // 同一份数据会被算两遍、两处口径也可能哪天改歪一处。
  const histDels = useMemo(() => filterDeliverables(historyDels), [historyDels]);
  // 右侧历史面板开关（默认收起，点「历史」展开/收起）
  // 【2026-10-12 新版 UI】右栏按参考图默认展开（常用能力 / 关键任务 / 历史成果）。
  // 旧默认是收起（false）；没有测试依赖它的开合状态，故按新设计改为展开。
  // 第八轮（2026-10-14）：右侧「历史成果」栏默认**收起**。
  // 旧版默认展开，一进来就是「对话被右边一条成果栏挤窄」的观感；
  // 成果属于事后查看的次要信息，需要时点右上角「历史」展开即可。
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  // 左侧会话列表同样是次要信息（用户原话「用户要知道这些干嘛」）：
  // 从常驻 250px 侧栏改成抽屉，默认不占版面，点页头的「对话记录」才浮出。
  // 左侧任务栏（第十九轮改造）：老板第 3 条要求「一个任务栏」，所以它**默认常驻**
  // （旧版是抽屉语义、默认收起）。
  // 【0.21.11 · 老板第 7 条】再进一步：「豆芽助手里面任务栏常在 不要隐藏掉」。
  // ⇒ 现在**没有任何入口能把它置 false**：右上角「对话记录」按钮与任务栏头部的 `×` 都已删除。
  //   state 仍保留（默认 true、传给 TaskCenter 的 open），这样"常在"是通过
  //   「删掉关闭入口」实现的，而不是把默认值写死成字面量 —— 组件契约与回滚路径都还在。
  const [sessionsOpen] = useState(true);
  /**
   * 客服反馈面板开关（0.21.11 · 老板第 8 条）。
   *
   * 起因：老板原话「账号和设置客服反馈 放顶部吧。一个小按钮即可 右边的客服反馈可以删掉了」。
   * 之前 SupportAssistant 自带一个右下角常驻胶囊（.support-fab），压在内容上、
   * 还让 .module-page 不得不多留 64px 底部内边距躲它。现在改成：
   *   · 顶栏一个「反馈」小按钮（本 state）控制开关；
   *   · 浮动胶囊传 hideFab 隐藏，面板本体照旧复用（表单/历史一条代码没动）。
   */
  const [supportOpen, setSupportOpen] = useState(false);
  // 顶栏「更多」下拉（第八轮：使用指南 / 思考过程 / 退出收进这里）
  // 登录态
  const [authed, setAuthed] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  // 无企业时强制锁定 onboarding（含删除全部企业后）；有企业后不再抢视图
  useEffect(() => {
    if (authed && companies.length === 0 && view !== 'onboarding') {
      setView('onboarding');
    }
  }, [authed, companies.length, view]);

  const saved = loadSettings();
  // 归一化 baseURL：补全 http:// 协议前缀（用户手填地址常漏协议，导致后端 fetch 报 "Failed to parse URL"）。
  const _rawBaseURL = (saved.baseURL || '').trim() || 'http://192.168.80.99:10003/v1';
  const savedBaseURL = /^https?:\/\//i.test(_rawBaseURL) ? _rawBaseURL : 'http://' + _rawBaseURL;
  const isPublicDeepSeek = /api\.deepseek\.com/.test(savedBaseURL);
  // 模型名归一化（0.21.10 口径：内网 pro-wb ≡ 公网 flash，两边**名不同、物相同**）：
  //   ① 空值 / 旧别名 deepseek-chat → 本环境默认（内网 deepseek-v4-pro-wb，公网 deepseek-flash）；
  //   ② 跨环境把「对面环境的同族名」换算回本环境 —— 内网名拿到公网不认、公网名拿到内网也不认，
  //      必须换（两者背后都是 V4.1-Flash，互换不掉档）；
  //   ③ 内网网关只认 deepseek-v4-pro-wb，**不许**写成 deepseek-v4-flash-wb（那名字不存在）；
  //   ④ **不**覆盖显式写下的 deepseek-v4-pro（公网真 pro）：老配置的默认值迁移由主进程 config
  //      的 modelMigrated 标记一次性完成，用户之后显式改回 pro 不会再被覆盖。
  const _rawModel = saved.model || '';
  let savedModel = _rawModel;
  if (!_rawModel || _rawModel === 'deepseek-chat') savedModel = isPublicDeepSeek ? 'deepseek-flash' : 'deepseek-v4-pro-wb';
  else if (isPublicDeepSeek && (_rawModel === 'deepseek-v4-pro-wb' || _rawModel === 'deepseek-v4-flash-wb')) savedModel = 'deepseek-flash';
  else if (!isPublicDeepSeek && (_rawModel === 'deepseek-flash' || _rawModel === 'deepseek-v4-flash-wb')) savedModel = 'deepseek-v4-pro-wb';
  else if (!isPublicDeepSeek && _rawModel === 'deepseek-v4-pro') savedModel = 'deepseek-v4-pro-wb';
  const [cfg, setCfg] = useState({
    baseURL: savedBaseURL,
    apiKey: saved.apiKey || '',
    model: savedModel || (isPublicDeepSeek ? 'deepseek-flash' : 'deepseek-v4-pro-wb'),
    enableSearch: saved.enableSearch ?? true,
    asrApiKey: saved.asrApiKey || '',
    ttsApiKey: saved.ttsApiKey || '',
    wxAppId: saved.wxAppId || '',
    wxAppSecret: saved.wxAppSecret || '',
    shopBaseURL: saved.shopBaseURL || 'https://supplier.example.com',
    shopAccount: saved.shopAccount || '',
    shopPassword: saved.shopPassword || '',
    shopApiKey: saved.shopApiKey || '',
    shopProductUrl: saved.shopProductUrl || '',
    shopOrderUrl: saved.shopOrderUrl || '',
    // 上游货源商城（supplier.example.com）：独立 mmm* 命名空间。
    // mmmPassword（上游货源登录密码）≠ shopPassword（上游货源 商城密码）≠ shopApiKey（上游货源 登录凭证），三者互不替代。
    mmmBaseURL: saved.mmmBaseURL || 'https://supplier.example.com',
    mmmAccount: saved.mmmAccount || '',
    mmmPassword: saved.mmmPassword || '',
    mmmApiKey: saved.mmmApiKey || '',
    // 0.8.0：工作台入口从裸 IP 124.222.215.53 换成 api.example.com（登录用的就是 api.example.com 的账号）。
    // 老用户 localStorage 里存的还是旧 IP → 一次性迁移；否则会拿 workbench 的 token 去打旧实例，全 401。
    geoBaseURL: /^https?:\/\/124\.222\.215\.53\/?$/.test(String(saved.geoBaseURL || '').trim())
      ? 'https://api.example.com'
      : (saved.geoBaseURL || 'https://api.example.com'),
    geoAccount: saved.geoAccount || '',
    geoPassword: saved.geoPassword || '',
    geoApiKey: saved.geoApiKey || '',
    // 联网检索 key：不回显后端原文（GET /api/config 不返回），仅沿用本机 localStorage 草稿。
    tavilyApiKey: saved.tavilyApiKey || '',
  });

  // 连接器管理状态（参考 Workbench 连接器方案：本地连接器 + 状态 + 测试连接）
  const [connectors, setConnectors] = useState([]);
  const [connBusy, setConnBusy] = useState(false);
  const [connMsg, setConnMsg] = useState('');
  // connMsg 归属的连接器 id：同一视图里有多张连接器卡时，只让被测的那张显示提示，避免重复文案。
  const [connMsgFor, setConnMsgFor] = useState('');
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestMsg, setLlmTestMsg] = useState('');

  // 麦克风设备选择（null = 自动）
  const [micDevice, setMicDevice] = useState(() => {
    const v = parseInt(localStorage.getItem('douya-mic-device') || '', 10);
    return Number.isNaN(v) ? null : v;
  });
  const [micDevices, setMicDevices] = useState([]);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTesting, setMicTesting] = useState(false);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const sendRef = useRef(null);
  // 「补连即补算」守卫：同一企业同一会话只补跑一次体检（避免反复触发 / 重复烧 token）。
  // 用 useRef（跨渲染稳定的 Set）而非 state，避免额外渲染。
  const checkupTriedRef = useRef(new Set());
  // 登录页背景视频元素（用于「带声自动播放被拦截」时的兜底重播）
  const loginVideoRef = useRef(null);

  // 专家（顶栏已移除切换下拉；expertId 固定为空 = 通用对话，不强制注入商城导购人格）
  const [experts, setExperts] = useState([]);
  const [expertId, setExpertId] = useState('');
  const [skills, setSkills] = useState([]);

  // 工作流 Agent 状态：阶段/进度、计划、素材请求、确认请求
  const [wfPhase, setWfPhase] = useState({ phase: '', label: '', progress: 0 });
  const [wfPlan, setWfPlan] = useState([]);
  // 【2026-11-09】plan_gate：复杂/不可逆任务才弹的计划确认卡（{id, steps, reasons}）。
  // 与上面 wfPlan 的分工：wfPlan 是「正在按这个计划做」的进度展示（不打断），
  // 这里是「还没开始，等你点头」的确认卡。两者别混用 —— 混了就等于又变成无条件弹窗，
  // 而那正是用户当初要求去掉的东西。
  const [wfPlanAck, setWfPlanAck] = useState(null);
  const [wfMaterial, setWfMaterial] = useState(null); // {id, prompt}
  const [wfConfirm, setWfConfirm] = useState(null); // {id, name, params, label, target}
  const [wfConfirmRemember, setWfConfirmRemember] = useState(false); // 本任务内是否不再询问该服务器（勾选框状态）
  const [matInput, setMatInput] = useState('');
  const [wfClarify, setWfClarify] = useState(null); // {id, questions, context}
  const [clarifyInput, setClarifyInput] = useState('');
  const [clarifySel, setClarifySel] = useState([]); // 每题选中的选项

  /**
   * 【第二十三轮】往当前会话追加一条**系统小字**（role: 'notice'）。
   *
   * 为什么用消息而不是 banner / alert：
   *   · 老板对打断感的容忍度极低，`alert` 会卡住整条流；
   *   · banner 是一次性状态，刷新就没了，用户回头翻记录时看不到「当时发生过什么」；
   *   · 落成一条消息则天然跟着会话持久化（persistStore 会存），滚回去也读得到。
   *
   * 为什么不会污染发给模型的上下文：`packMessages()` 只挑 role === 'user' | 'assistant'，
   * notice 会被过滤掉；`groupToolCalls()` 对非 tool_call 一律原样透传，所以渲染层照常拿到。
   *
   * @param {string} text 提示正文（空串直接忽略，绝不落一条空气泡）
   * @param {string} [sid] 目标会话 id；不传则用当前会话。
   *   为什么要能显式指定：流式过程中用户可能切到别的会话，而这条 assistant 回复
   *   属于发起任务时的那个 `sid`。提示必须和它同会话，否则会挂到用户刚切过去的那个
   *   会话上 —— 那等于把"别处发生的事"说成"这里发生的事"。
   * @returns {void}
   */
  function pushNotice(text, sid) {
    const t = String(text || '').trim();
    if (!t) return;
    setSessions((prev) => {
      const target = sid || prev.currentId;
      const item = prev.items[target];
      if (!item) return prev; // 没有对应会话就不硬造，避免把提示挂到别的会话上
      const last = item.messages[item.messages.length - 1];
      // 同一条提示紧挨着重复出现时不叠加（例如续跑 + 主链路各收到一次同 id 的 result）
      if (last && last.role === 'notice' && last.content === t) return prev;
      return {
        ...prev,
        items: {
          ...prev.items,
          [target]: { ...item, messages: [...item.messages, { role: 'notice', content: t }], updatedAt: Date.now() },
        },
      };
    });
  }
  const [showThinking, setShowThinking] = useState(() => {
    const v = localStorage.getItem('douya-show-thinking');
    return v === null ? true : v !== '0';
  });
  // 是否正在深度思考（收到 reasoning 流时置 true，开始出正文/tool 时置 false），用于实时展示思考状态
  const [liveThinking, setLiveThinking] = useState(false);

  // 【第二十二轮 · 老板第 4 条】原先这里是「每来一条消息就无条件 scrollTo 到底部」。
  // 被老板第 4 条暴露的两个毛病：
  //   ① 用户往上翻历史时，新消息一到就被**硬拽**回底部 —— 想看的那段话直接找不到了
  //      （老板原话「这样就不用上滑下滑了」隐含的前提就是"别抢我的滚动位置"）；
  //   ② 没有"回顶部/回最新"入口，长对话只能一路滑。
  // 现在滚动交给 <ScrollNav>（挂在 `.chat` 内，见对话区 JSX）：
  //   · 用户本来就在底部 → 新内容继续贴底（行为与改前一致）；
  //   · 用户不在底部 → **一动不动**，改为在「回到最新」上记未读条数。
  // 这里只保留「思考过程块自己滚到最新」——那是 <details> 内部滚动，与对话区滚动无关。
  useEffect(() => {
    document.querySelectorAll('.reasoning-content').forEach((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, thinking]);

  // 全局拖拽：整个窗口都能拖文件进聊天窗，拖入时显示高亮遮罩
  useEffect(() => {
    const onDragOver = (e) => { e.preventDefault(); setDragOver(true); };
    const onDragLeave = (e) => { if (e.relatedTarget === null) setDragOver(false); };
    const onDrop = (e) => { e.preventDefault(); setDragOver(false); if (dropHandlerRef.current) dropHandlerRef.current(e); };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // 启动时加载工作记录（持久化），没有则建一个空会话
  useEffect(() => {
    if (window.api && window.api.invoke) {
      window.api
        .invoke('store:get')
        .then((store) => {
          const items = (store && store.items) || {};
          const keys = Object.keys(items);
          if (keys.length) {
            let cid = store.currentId && items[store.currentId] ? store.currentId : null;
            if (!cid) {
              cid = keys
                .map((k) => items[k])
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id;
            }
            setSessions({ currentId: cid, items });
          } else {
            const id = 's' + Date.now();
            setSessions({
              currentId: id,
              items: { [id]: { id, title: '新对话', messages: [], updatedAt: Date.now() } },
            });
          }
        })
        .catch(() => {});
    }
  }, []);

  // 拉取技能（用于构建 tools 传给后端）
  useEffect(() => {
    fetch(`${BACKEND}/api/skills`)
      .then((r) => r.json())
      .then(setSkills)
      .catch(() => {});
  }, []);

  // 拉取专家列表（顶栏切换角色用）
  useEffect(() => {
    fetch(`${BACKEND}/api/experts`)
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list) && list.length) setExperts(list);
      })
      .catch(() => {});
  }, []);

  // 拉取历史成果（右侧历史面板，跨会话保留；登录后按账号过滤，只拉当前用户自己的）
  useEffect(() => {
    if (authed) loadHistoryDels();
  }, [authed, authUser]);

  // 登录校验：启动时读本地 token，向后端 /api/auth/profile 验证有效性
  useEffect(() => {
    const token = localStorage.getItem('douya-auth-token');
    if (!token) return;
    fetch(`${BACKEND}/api/auth/profile?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.ok) {
          const j = await r.json().catch(() => null);
          setAuthUser(j || null);
          setAuthed(true);
          return;
        }
        // ★★★ 2026-11-11 修：只有「上游明确否掉这个 token」才许清凭据。
        //
        //   改前这里是一行 `r.ok ? r.json() : Promise.reject(...)`，然后 `.catch` 里
        //   无差别 `removeItem('douya-auth-token')`。后果（实测，不是推测）：
        //   未激活机器上 `/api/auth/profile` 恒回 **402**（授权闸，见 backend.js 的
        //   LICENSE_BYPASS）⇒ `r.ok === false` ⇒ 走进 catch ⇒ **把用户的登录态删了**。
        //   于是每次启动都销毁一次凭据：用户被迫重新登录，而重新登录当时也被 402 拦
        //   ⇒ 产品永久打不开。**这不是"拦一下"，是拦的时候顺手破坏了用户的数据。**
        //
        //   判据要区分「这个 token 是假的」和「现在验不了」：
        //     · 401 / 403 —— 上游明确拒绝 ⇒ 这才是真的无效，清掉是对的（否则每次启动都白试）。
        //     · 402（本机未授权）/ 5xx（上游故障）/ 网络失败 —— 都属于**我不知道**，
        //       一律保留凭据，只是这次不进主界面。下次启动/网络恢复后还能验。
        //   铁律与 LicenseGuardHost 的边界①同源：把"我不知道"当成"不许用"会锁死产品；
        //   这里是它的孪生版本 —— 把"我不知道"当成"你的凭据是坏的"会**删掉**用户的东西。
        if (r.status === 401 || r.status === 403) {
          localStorage.removeItem('douya-auth-token');
          localStorage.removeItem('douya-auth-user');
        }
      })
      .catch(() => {
        // 网络层失败（后端没起来 / 断网）：同样**不清凭据**。
      });
  }, []);

  // 登录后拉取 token 用量
  useEffect(() => {
    if (authed && authUser) {
      const uname = authUser.username || authUser.name || '';
      fetch(`${BACKEND}/api/usage?username=${encodeURIComponent(uname)}`)
        .then((r) => r.json()).then((j) => setUsage(j)).catch(() => {});
    }
  }, [authed, authUser]);

  // 从后端预填配置
  useEffect(() => {
    fetch(`${BACKEND}/api/config`)
      .then((r) => r.json())
      .then((c) => {
        setCfg((prev) => {
          const next = { ...prev };
          if (!next.baseURL && c.baseURL) next.baseURL = c.baseURL;
          if (!next.apiKey && c.apiKey) next.apiKey = c.apiKey;
          if (!next.model && c.model) next.model = c.model;
          if (typeof c.enableSearch === 'boolean') next.enableSearch = c.enableSearch;
          if (!next.asrApiKey && c.asrApiKey) next.asrApiKey = c.asrApiKey;
          if (!next.ttsApiKey && c.ttsApiKey) next.ttsApiKey = c.ttsApiKey;
          if (!next.wxAppId && c.wxAppId) next.wxAppId = c.wxAppId;
          if (!next.wxAppSecret && c.wxAppSecret) next.wxAppSecret = c.wxAppSecret;
          if (!next.shopBaseURL && c.shopBaseURL) next.shopBaseURL = c.shopBaseURL;
          if (!next.shopAccount && c.shopAccount) next.shopAccount = c.shopAccount;
          if (!next.shopPassword && c.shopPassword) next.shopPassword = c.shopPassword;
          if (!next.shopApiKey && c.shopApiKey) next.shopApiKey = c.shopApiKey;
          if (!next.shopProductUrl && c.shopProductUrl) next.shopProductUrl = c.shopProductUrl;
          if (!next.shopOrderUrl && c.shopOrderUrl) next.shopOrderUrl = c.shopOrderUrl;
          if (!next.mmmBaseURL && c.mmmBaseURL) next.mmmBaseURL = c.mmmBaseURL;
          if (!next.mmmAccount && c.mmmAccount) next.mmmAccount = c.mmmAccount;
          if (!next.mmmPassword && c.mmmPassword) next.mmmPassword = c.mmmPassword;
          if (!next.mmmApiKey && c.mmmApiKey) next.mmmApiKey = c.mmmApiKey;
          if (!next.geoBaseURL && c.geoBaseURL) next.geoBaseURL = c.geoBaseURL;
          if (!next.geoAccount && c.geoAccount) next.geoAccount = c.geoAccount;
          if (!next.geoPassword && c.geoPassword) next.geoPassword = c.geoPassword;
          if (!next.geoApiKey && c.geoApiKey) next.geoApiKey = c.geoApiKey;
          localStorage.setItem('agent-settings', JSON.stringify(next));
          return next;
        });
        // 检索 key 不回显原文，仅用后端回传的布尔状态显示「已配置 / 未配置」
        setTavilyConfigured(!!c.tavilyConfigured);
      })
      .catch(() => {});
  }, []);

  // 顶栏窗口按钮：初次查询当前最大化状态 + 订阅主程序推送。
  // preload 已暴露 api.on，直接复用，不新增暴露面；事件只由主窗发出（桌宠窗口不推送）。
  useEffect(() => {
    if (!(window.api && window.api.invoke)) return;
    let alive = true;
    window.api
      .invoke('win:isMaximized')
      .then((v) => { if (alive) setWinMaximized(!!v); })
      .catch(() => {});
    if (window.api.on) {
      window.api.on('win:maximized-changed', (v) => setWinMaximized(!!v));
    }
    return () => { alive = false; };
  }, []);

  // 登录页背景视频：尽力「带声自动播放」。若被 Chromium 策略拦截（视频仍在暂停），
  // 尝试再触发一次；仍失败则亮出「开启声音」兜底按钮（用户点击＝有效手势，可正常起播）。
  // 全程不修改 muted —— 老板明确要求保留声音，绝不静默消音。
  useEffect(() => {
    if (authed || loginVideoFailed) return;
    const v = loginVideoRef.current;
    if (!v) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      if (v.paused) {
        try {
          const p = v.play && v.play();
          if (p && typeof p.catch === 'function') {
            p.catch(() => { if (!cancelled) setLoginVideoBlocked(true); });
          }
        } catch {
          if (!cancelled) setLoginVideoBlocked(true);
        }
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [authed, loginVideoFailed]);

  // 打开设置时拉取麦克风设备列表
  useEffect(() => {
    if (showSettings && window.api && window.api.invoke) {
      window.api.invoke('voice:listDevices').then((list) => {
        if (Array.isArray(list)) setMicDevices(list);
      }).catch(() => {});
    }
  }, [showSettings]);

  /**
   * 读视频设计配置（key 掩码 / 额度 / 产物目录 / 账本）。
   * ⚠️ 只在**真的打开这一屏**时才拉：设置弹窗一开就发一串 IPC 是浪费，
   *    而且这条链在旧版主进程上不存在，早拉会平白多出一句「需要更新到新版」的红字。
   */
  const loadWanxCfg = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.wanxStatus !== 'function') {
      setWanxSt({ ok: false, error: '这一版主进程还没有视频设计的通道，需要更新到新版客户端' });
      return;
    }
    try {
      const st = await api.wanxStatus();
      setWanxSt(st || { ok: false, error: '读取配置失败' });
      if (typeof api.wanxLedger === 'function') {
        const led = await api.wanxLedger(10);
        setWanxLedgerRows((led && Array.isArray(led.items)) ? led.items : []);
      }
    } catch (e) {
      setWanxSt({ ok: false, error: (e && e.message) || '读取配置失败' });
    }
  }, []);

  useEffect(() => {
    if (showSettings && settingsPanel === 'videodesign') loadWanxCfg();
  }, [showSettings, settingsPanel, loadWanxCfg]);

  /**
   * 保存视频设计 Key。
   * 语义与「我的记忆」一致：**即时生效**，不参与弹窗底部那个「保存」按钮 ——
   * key 是走 IPC 落盘的独立事实，如果还要用户再点一次「保存」，就会出现
   * 「我明明填了但没点保存」这种说不清的状态。
   */
  async function saveWanxKey() {
    const api = typeof window !== 'undefined' ? window.api : null;
    const v = String(wanxKeyDraft || '').trim();
    if (!v) { setWanxKeyMsg('先粘贴 Key 再保存'); return; }
    if (!api || typeof api.wanxSaveKey !== 'function') {
      setWanxKeyMsg('这一版主进程还没有保存通道，需要更新到新版客户端');
      return;
    }
    setWanxKeyBusy(true);
    setWanxKeyMsg('');
    try {
      const r = await api.wanxSaveKey(v);
      if (!r || r.ok !== true) {
        setWanxKeyMsg('保存失败：' + ((r && r.error) || '未知错误'));
        return;
      }
      // 输入框立刻清空：留着一串明文躺在输入框里，等于把刚藏起来的东西又摆回屏幕上
      setWanxKeyDraft('');
      setWanxKeyMsg('已保存，只存在这台电脑上');
      await loadWanxCfg();
    } catch (e) {
      setWanxKeyMsg('保存失败：' + ((e && e.message) || '未知错误'));
    } finally {
      setWanxKeyBusy(false);
    }
  }

  /**
   * 把「历史（无账号归属）Key」复制到当前账号。
   *
   * ★ 语义是**复制不是搬走**：主进程那段只读 `<userData>/wanx.json` 再写当前账号的
   *   `wanx-key.txt`，原件一个字节不动 —— 所以这里绝不能提示「已迁移」，
   *   否则用户会以为原件没了、进而以为别的账号也跟着变了。
   * ★ 也别在这里做「顺便清空 legacy 提示」这种自作聪明的状态改写：
   *   导入成功后直接重拉 status，让**主进程的读数**决定这一行还该不该出现
   *   （导入成功 ⇒ hasKey 变真 ⇒ status 不再挂 legacyKey ⇒ 这行自动消失）。
   */
  async function importLegacyWanxKey() {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.wanxImportLegacyKey !== 'function') {
      setWanxLegacyMsg('这一版主进程还没有导入通道，需要更新到新版客户端');
      return;
    }
    setWanxLegacyBusy(true);
    setWanxLegacyMsg('');
    try {
      const r = await api.wanxImportLegacyKey();
      if (!r || r.ok !== true) {
        setWanxLegacyMsg('导入失败：' + ((r && r.error) || '未知错误'));
        return;
      }
      setWanxLegacyMsg('已复制到当前账号，原件仍保留在原来的位置');
      await loadWanxCfg();
    } catch (e) {
      setWanxLegacyMsg('导入失败：' + ((e && e.message) || '未知错误'));
    } finally {
      setWanxLegacyBusy(false);
    }
  }

  /** 打开视频设计产物目录。`shell.openPath` 有返回值，失败必须说出来 —— 否则就是「点了没反应」。 */
  async function openWanxFolder() {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.wanxOpenFolder !== 'function') {
      setWanxDirMsg('这一版主进程还没有打开目录的通道，需要更新到新版客户端');
      return;
    }
    setWanxDirMsg('');
    try {
      const r = await api.wanxOpenFolder({});
      if (!r || r.ok !== true) setWanxDirMsg('打开失败：' + ((r && r.error) || '未知错误'));
    } catch (e) {
      setWanxDirMsg('打开失败：' + ((e && e.message) || '未知错误'));
    }
  }

  // 视频设计面板的派生值：JSX 里到处写三层可选链会看不清到底在判什么。
  const wanxHasKey = !!(wanxSt && wanxSt.ok === true && wanxSt.hasKey);
  /**
   * 「历史 Key 待认领」的提示数据。
   * ★ 只认 `available === true`：主进程**只在当前账号还没配 key 时**才挂这个字段
   *   （`wanx:status` 里那句 `if (legacyKey && !st.hasKey)`），所以这里不需要再判 hasKey，
   *   更不要在前端自己造一条"要不要显示"的规则 —— 两个地方各判一半，早晚不一致。
   */
  const wanxLegacy = (wanxSt && wanxSt.legacyKey && wanxSt.legacyKey.available === true)
    ? wanxSt.legacyKey
    : null;
  const wanxKeyFromLabel = (() => {
    const from = (wanxSt && wanxSt.keyFrom) || 'none';
    if (from === 'env') return '来自环境变量 DASHSCOPE_API_KEY（优先级最高，会盖过这里填的）';
    if (from === 'config') return '来自这台电脑的设置';
    if (from === 'keyfile') return '来自旧的明文 key 文件';
    return '';
  })();
  const wanxMediaDirText = (wanxSt && wanxSt.mediaDir) || '';
  const wanxBudgetObj = (wanxSt && wanxSt.budget) || null;
  const wanxCfgErr = (wanxSt && wanxSt.ok === false) ? (wanxSt.error || '读取失败') : '';
  const wanxMoney = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—');
  const WANX_KIND_LABEL = { video: '视频', image: '图片', video_refund: '视频退款', video_adjust: '视频差额' };

  function persistStore(obj) {
    if (window.api && window.api.invoke) window.api.invoke('store:set', obj).catch(() => {});
  }

  function ensureSession() {
    if (sessions.currentId && sessions.items[sessions.currentId]) return sessions.currentId;
    const id = 's' + Date.now();
    const next = {
      currentId: id,
      items: {
        ...sessions.items,
        [id]: {
          id,
          title: '新对话',
          messages: [],
          updatedAt: Date.now(),
          companyId: (currentCompany && currentCompany.id) || null,
          projectId: (currentProject && currentProject.id) || null,
          scope: chatScope,
        },
      },
    };
    setSessions(next);
    persistStore(next);
    return id;
  }

  function newChat() {
    const id = 's' + Date.now();
    const next = {
      currentId: id,
      items: {
        ...sessions.items,
        [id]: {
          id,
          title: '新对话',
          messages: [],
          updatedAt: Date.now(),
          companyId: (currentCompany && currentCompany.id) || null,
          projectId: (currentProject && currentProject.id) || null,
          scope: chatScope,
        },
      },
    };
    setSessions(next);
    persistStore(next);
  }

  // 切换分区（对话 / 工作）：记住选择；旧会话没有 scope 字段时按 'chat' 兼容。
  //
  // ⚠️ 2026-10-19 第十九轮：本函数**当前没有调用点** —— 老板第 3 条把头条那对分区小页签
  // 换成了「对话 / 工作」大切换（它切的是 wbTab：经营对话 ↔ 开发工作台）。
  // 聊天内「工作分区」（chatScope='work'，走后端双 AI 自检）这个能力**没有删**：
  // 任务栏点开一条 scope=work 的历史会话时，openTaskFromBar 会把分区拨回去。
  // 保留本函数是为了「分区还能被重新挂回界面」这条退路（恢复时不用重写逻辑）。
  function switchChatScope(scope) {
    const s = scope === 'work' ? 'work' : 'chat';
    setChatScope(s);
    try { localStorage.setItem('douya-chat-scope', s); } catch { /* 忽略 */ }
    // 切到另一分区时，把当前会话拨到该分区**已有**的最新一条（没有就空着，
    // 用户发第一句话时 ensureSession 会按新 scope 建）—— 不把 A 分区的会话拖进 B 分区。
    const inScope = Object.values(sessions.items)
      .filter((x) => (x.scope || 'chat') === s)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const next = {
      currentId: inScope.length ? inScope[0].id : null,
      items: sessions.items,
    };
    setSessions(next);
    persistStore(next);
  }

  /** 切会话（同样在第十九轮后被任务栏的 openTaskFromBar 取代，保留为退路）。 */
  function switchSession(id) {
    if (id === sessions.currentId) return;
    const next = { ...sessions, currentId: id };
    setSessions(next);
    persistStore(next);
  }

  function onMicDeviceChange(v) {
    const num = v === 'auto' ? null : parseInt(v, 10);
    setMicDevice(num);
    localStorage.setItem('douya-mic-device', num === null ? '' : String(num));
  }

  async function testMic() {
    if (!window.api || !window.api.invoke) return;
    setMicTesting(true);
    setMicTestLevel(0);
    const t0 = Date.now();
    let peak = 0;
    while (Date.now() - t0 < 1300) {
      const lvl = await window.api.invoke('voice:testLevel', micDevice);
      if (lvl > peak) peak = lvl;
      setMicTestLevel(lvl);
      await new Promise((r) => setTimeout(r, 130));
    }
    setMicTestLevel(peak);
    setMicTesting(false);
  }

  // 工具 schema 派生统一走 src/shared/toolSchema.js —— 与桌宠（src/renderer-pet/App.jsx）
  // **共用同一份真源**。上次两处各写一份，结果修了主窗、漏了桌宠（桌宠包一直硬编码 required: []）。
  // 该模块负责：① params[].required 透传（真源是 manifest）② additionalProperties:false
  // ③ 参数形状/用法提示（用文字描述，不改 JSON 类型 —— 见该文件头部的取舍说明）。
  function buildTools() {
    return buildToolsFrom(skills);
  }

  // ---- 语音事件 ----
  useEffect(() => {
    if (!window.api || !window.api.on) return;
    const onResult = (r) => {
      setListening(false);
      setVoiceProcessing(false);
      if (r && r.error) {
        alert('语音识别失败：' + r.error);
      } else if (r && r.text) {
        setInput(r.text);
        setTimeout(() => sendRef.current && sendRef.current(r.text), 120);
      }
    };
    const onError = (msg) => {
      setListening(false);
      setVoiceProcessing(false);
      alert('语音识别失败：' + msg);
    };
    const onLevel = (lvl) => setVoiceLevel(lvl);
    const onDevice = (name) => setVoiceDevice(name);
    const onCancelled = () => { setListening(false); setVoiceProcessing(false); setVoiceLevel(0); };
    window.api.on('voice:result', onResult);
    window.api.on('voice:error', onError);
    window.api.on('voice:level', onLevel);
    window.api.on('voice:device', onDevice);
    window.api.on('voice:cancelled', onCancelled);
    return () => {};
  }, []);

  async function toggleVoice() {
    if (busy && !listening) return;

    // 正在听 → 立即停止并识别（结果稍后通过 voice:result 推送，UI 立即解锁）
    if (listening) {
      setListening(false);
      setVoiceProcessing(true);
      try {
        await window.api.invoke('voice:stop');
      } catch (e) {
        setVoiceProcessing(false);
        alert('停止录音失败：' + e.message);
      }
      return;
    }

    try {
      setListening(true);
      setVoiceLevel(0);
      setVoiceProcessing(false);
      const res = await window.api.invoke('voice:start', micDevice);
      if (!res || !res.started) {
        setListening(false);
        alert(res && res.busy ? '正在识别中，请稍候…' : '无法启动录音，请确认麦克风已连接');
      } else if (res.deviceName) {
        setVoiceDevice(res.deviceName);
      }
    } catch (e) {
      setListening(false);
      alert('无法启动录音：' + e.message);
    }
  }

  // ---- 发送消息 ----
  /**
   * 首页「开始」：把用户说的那句话交给**既有**对话链路（send），不新建任何会话机制。
   *
   * 为什么不自己发请求：ModuleAssistant 的红线是「面板不留存内容、无跨模块会话」，
   *   而首页要兑现「任务只说一句话」⇒ 唯一合规的做法是**复用**已有对话页（workbench），
   *   首页只当传声筒。本函数不写 localStorage、不建 session、不留任何状态。
   *
   * 软门禁一致性：未连 AI 时 `send` 会静默 return（表现成"点了没反应"）。
   *    首页必须当场给反馈，所以先用**同一个** needKey 判据拦一次并打开设置 ——
   *    与顶部 ai-gate-banner 同源，不新增第二套判断。
   */
  function homeAsk(text) {
    const t = String(text || '').trim();
    if (!t) return;
    if (needKey) {
      setShowSettings(true);
      loadConnectors();
      return;
    }
    // 直连对话页：wbTab 若停在上次的 dev/automation，切过去会看不见对话区 ⇒ 显式拨回 chat。
    setWbTab('chat');
    setActiveModule('workbench');
    send(t);
  }

  // 2026-10-13：首页常用操作按参考图改成动作型（直达对应模块）后，这里不再需要
  // 「按 goal 直接开方案预览」的中转函数（原 homeQuickGoal）。方案预览本身仍在
  // —— 经营方案 / 目标选择走的还是同一条链路，只是不再由首页四卡触发，故删掉死代码、
  // 不留悬空回调。

  async function send(voiceText) {
    // 等待澄清回复：主输入框的发送走回复路由（不新开 fetch，后端 await 已挂起、会自动续流）
    if (wfClarify) {
      const ans = (voiceText || input).trim() || buildClarifyAnswer();
      if (!ans) return;
      const userMsg = { role: 'user', content: ans };
      setSessions((prev) => {
        const sid2 = prev.currentId;
        const item = prev.items[sid2];
        if (!item) return prev;
        return { ...prev, items: { ...prev.items, [sid2]: { ...item, messages: [...item.messages, userMsg], updatedAt: Date.now() } } };
      });
      setClarifyInput('');
      setClarifySel([]);
      postClarify(ans);
      return;
    }

    const text = (voiceText || input).trim();
    if (!text || busy) return;

    // 软门禁「主入口」（任务书 §五 P0-2）：未连上 AI 时禁止发起新对话。
    // 理由——「派活」就是通过对话发生的，禁了对话才真正落实「没办法开展」；
    // 复用既有 needKey 判据（= needAiConfig(...) 同源判定，与主进程 backend.js 一致），不新增第二套判断；
    // 只禁这一条主入口，
    // 浏览 / 资产库 / 手动建档建项目全部保留（「能看能填」）。
    if (needKey) return;

    const sid = ensureSession();

    // 本次任务的唯一 ID：停止按钮据此 /api/abort 精确叫停这一次任务
    const taskId = 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    taskIdRef.current = taskId;
    cancelRef.current = false; // 新的一轮：清掉上一轮的"用户已取消"标记
    setCanStop(true);

    const attachList = attachments.map((a) => ({ path: a.path, name: a.name }));
    const userMsg = { role: 'user', content: text, attachments: attachList };
    const asstMsg = { role: 'assistant', content: '', reasoning: '' };

    // 写入会话
    setSessions((prev) => {
      const item = prev.items[sid] || { id: sid, title: '新对话', messages: [], updatedAt: Date.now() };
      const isFirst = item.messages.filter((m) => m.role === 'user').length === 0;
      const newMsgs = [...item.messages, userMsg, asstMsg];
      const updated = {
        ...item,
        // 第十九轮（老板第 3 条）：按内容自动取名字。
        // 旧写法是 `text.slice(0, 24)` 原样硬截 —— 任务栏里会出现
        // 「帮我写一条春季种植体的朋友圈文案，再配三个标题」这种又长又带口头语的行。
        title: isFirst ? autoTitle(text, '新对话') : item.title,
        messages: newMsgs,
        updatedAt: Date.now(),
      };
      return { ...prev, items: { ...prev.items, [sid]: updated } };
    });

    setInput('');
    setAttachments([]);
    setBusy(true);
    setThinking(true);
    setWfPhase({ phase: '', label: '', progress: 0, unresolved: null, state: null });
    setWfPlan([]);
    setWfMaterial(null);
    setWfConfirm(null);
    setMatInput('');

    let acc = '';
    let accReasoning = '';

    // 流式渲染节流：模型每流一个 token 就 setState 会导致整条消息列表反复重渲染（消息越多越卡）。
    // 这里用「累积 + requestAnimationFrame 合并」的方式，一帧最多刷一次状态，显著降低卡顿。
    let pendingContent = null;
    let rafId = null;
    const flushAssistant = () => {
      rafId = null;
      if (pendingContent === null) return;
      const { content, reasoning } = pendingContent;
      pendingContent = null;
      setSessions((prev) => {
        const item = prev.items[sid];
        if (!item) return prev;
        const msgs = item.messages.slice();
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') { idx = i; break; }
        }
        if (idx < 0) return prev;
        msgs[idx] = { ...msgs[idx], content, reasoning };
        return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: msgs } } };
      });
    };
    function writeAssistant(content, reasoning) {
      pendingContent = { content, reasoning };
      if (rafId === null) rafId = requestAnimationFrame(flushAssistant);
    }
    const flushAssistantNow = () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      if (pendingContent !== null) {
        const { content, reasoning } = pendingContent;
        pendingContent = null;
        setSessions((prev) => {
          const item = prev.items[sid];
          if (!item) return prev;
          const msgs = item.messages.slice();
          let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') { idx = i; break; }
          }
          if (idx < 0) return prev;
          msgs[idx] = { ...msgs[idx], content, reasoning };
          return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: msgs } } };
        });
      }
    };

    /**
     * 【第二十二轮 · 老板第 5 条 a】把「这一轮失败了」**显式落到消息上**。
     *
     * 改前：失败只会往正文里拼一句话 —— 网络异常拼「 请求失败：xxx」、`stream-idle-timeout`
     * 拼一段提示、后端报错拼「\n <错误原文>」。三种都长得像**正文**，没有"失败"这个语义，
     * 界面上也没有重试入口。用户看到的是一段混着错误的回答，正是老板说的
     * 「他也不会提醒你失败了，而是文案告诉你停止了」。
     *
     * 改后：正文照旧保留（已经流出来的半截内容不丢，这很重要），另外在消息上打
     * `failed + failureKind/Headline/Text/Next` 四个字段 ⇒ 渲染成一张**失败卡**：
     * 类别抬头（超时 / 连不上 / 鉴权 / 服务端 / 你已取消 / 没拿到内容）+ 原始原因 + 下一步 + 重试。
     *
     * @param {{kind:string, headline:string, reason:string, text:string, next:string}} desc
     * @returns {void}
     */
    const markFailure = (desc) => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pendingContent = null;
      setSessions((prev) => {
        const item = prev.items[sid];
        if (!item) return prev;
        const msgs = item.messages.slice();
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') { idx = i; break; }
        }
        if (idx < 0) return prev;
        msgs[idx] = {
          ...msgs[idx],
          content: acc,
          reasoning: accReasoning,
          failed: true,
          failureKind: desc.kind,
          failureHeadline: desc.headline,
          failureText: desc.reason,
          failureNext: desc.next,
        };
        return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: msgs } } };
      });
    };

    /** 后端在流里报的错（`j.error`）——先记下，流结束后统一落成失败卡，不混进正文。 */
    let lastStreamError = '';
    try {
      const res = await fetch(`${BACKEND}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...packMessages(messages), userMsg],
          attachments: attachList,
          taskId,
          // 运行底座 P0：把当前会话 id 作为稳定关联键传给后端，落到任务 trace 的每条事件上。
          // `sid` = ensureSession() 的返回值 = 当前会话 id（等价于 sessions.currentId；
          // 新建会话时只有用 sid 才不会读到 setSessions 生效前的旧值）。只加这一个字段。
          sessionId: sid,
          // 同一稳定会话内的项目账只能按这个 sid 续接；临时任务 id 不能充当 thread。
          threadId: sid,
          // 2026-10-18 第十六轮：分区（对话 / 工作）。work 时后端跑双 AI 自检 + 复检 + 汇报。
          scope: chatScope,
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          model: cfg.model,
          enableSearch: cfg.enableSearch,
          expert: expertId,
          tools: buildTools(),
          username: authUser?.username || authUser?.name || '',
          // 工作空间 → 企业 → 项目 → 任务 上下文（统一 buildAIContext 生成，后端注入为 system）
          context: buildContext({
            workspace,
            company: currentCompany,
            asset,
            knowledge: getKnowledge(currentCompany && currentCompany.id),
            project: currentProject,
            task: currentTask,
            role: currentRole || 'admin',
            workspaceRole: currentWorkspaceRole || 'admin',
            goalLabel: (goal && goal.label) || '',
          }),
        }),
      });

      // 【第二十二轮 · 老板第 5 条 a】HTTP 非 2xx **以前完全没判**：直接把错误页当流去读，
      // 读完 acc 是空 → 落到一句「(模型未返回内容)」⇒ 看着像"没内容"，而不是"失败了"。
      // 现在先看状态码，把服务端给的原文带出来（截 300 字防刷屏），交给统一归类。
      if (!res || res.ok === false) {
        let detail = '';
        try { detail = String(await res.text()).slice(0, 300); } catch { detail = ''; }
        // ★ 402 = 主进程的授权闸拦下了（见 backend.js `/api/chat` 那段）。
        //   为什么先发事件再抛：轮询是 60 秒一次，被吊销的人可能在这 60 秒里发消息，
        //   而这时界面上还没有弹窗 —— 他只会看到"发失败"，不知道是授权问题。
        //   发一个事件让授权面板**立刻**对一次表，比等下一次轮询靠谱。
        if (res && res.status === 402) {
          try { window.dispatchEvent(new CustomEvent('douya:license-required')); } catch { /* 旧环境没有 CustomEvent 也不影响主线 */ }
          const err = new Error('需要激活后才能继续使用');
          err.__httpStatus = 402;
          err.__licenseRequired = true;
          throw err;
        }
        const err = new Error(detail || ('HTTP ' + ((res && res.status) || '???')));
        err.__httpStatus = (res && res.status) || 0;
        throw err;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        // 【0.21.10】用带空闲看门狗的 read 取代裸 reader.read()，见 readWithIdle 的注释。
        const { done, value } = await readWithIdle(reader);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const raw = t.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const j = JSON.parse(raw);

            if (j.__tool__) {
              // id 由后端随事件下发（旧流不带 id，此时存 undefined，不编造），用于把结果精确贴回对应的工具行
              const toolMsg = { role: 'tool_call', id: j.id, tool: j.__tool__, label: j.label || j.__tool__, silent: !!j.silent, status: 'running', result: '' };
              setSessions((prev) => {
                const item = prev.items[sid];
                if (!item) return prev;
                return {
                  ...prev,
                  items: { ...prev.items, [sid]: { ...item, messages: [...item.messages, toolMsg] } },
                };
              });
              continue;
            }

            if (j.__tool_result__) {
              const tr = j.__tool_result__;
              // 有 id → 只认 id 精确匹配（不再要求 status==='running'，重复结果也只会落回同一行，不会贴错）；
              // 无 id（旧流/旧持久化消息）→ 退回既有逻辑（同名 + 最后一个 running），行为与改动前完全一致。
              // 两条路都保持「找不到就静默跳过」：不抛异常、不改动消息数组。
              // ok 由后端随结果下发；只有明确指出 false 才判失败（status='error'），
              // 缺省/undefined（旧流、旧持久化消息）一律按成功处理，保持与改动前逐项一致。
              const hasId = tr.id !== undefined && tr.id !== null && tr.id !== '';
              const doneStatus = tr.ok === false ? 'error' : 'done';
              setSessions((prev) => {
                const item = prev.items[sid];
                if (!item) return prev;
                const msgs = item.messages.slice();
                let hit = -1;
                if (hasId) {
                  for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].role === 'tool_call' && msgs[i].id === tr.id) {
                      hit = i;
                      break;
                    }
                  }
                } else {
                  for (let i = msgs.length - 1; i >= 0; i--) {
                    if (
                      msgs[i].role === 'tool_call' &&
                      msgs[i].tool === tr.name &&
                      msgs[i].status === 'running'
                    ) {
                      hit = i;
                      break;
                    }
                  }
                }
                if (hit >= 0) {
                  msgs[hit] = { ...msgs[hit], status: doneStatus, result: String(tr.result) };
                }
                return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: msgs } } };
              });
              continue;
            }

            if (j.type === 'phase') {
              // unresolved：后端账本口径的"未闭环失败数"（已销账的不算）。null = 后端没给，退回事件级计数。
              // state：后端状态机的终态判决（COMPLETE/PARTIAL/BLOCKED）。null = 后端没给（例如还在跑）。
              // sid：这个终态属于**哪个会话**。收尾结论块只在"就是当前这条会话"时渲染 ——
              //   否则切到另一条历史对话时，会把上一个任务的「按你的要求做完了」挂在无关对话上（说假话）。
              setWfPhase({
                phase: j.phase,
                label: j.label || '',
                progress: j.progress || 0,
                unresolved: (typeof j.unresolved === 'number') ? j.unresolved : null,
                state: j.state || null,
                sid,
              });
              if (j.phase === 'done') {
                refreshUsage();
                /**
                 * ★ 【第二十二轮 · 老板第 5 条 b】后端**已经宣布结束**的那一刻就收敛工具步骤。
                 *
                 * `sendPhase('done', …)` 的 label 可能是「已停止 / 已超时停止 / 上游响应中断已停止」
                 * （backend.js:3411 / :4005）—— 老板看到的就是这句"停止了"，而对话里那条
                 * 「⏳ 进行中…」还挂着。这里不等流自然结束，一收到终态就把 running 全部收敛，
                 * 用户最晚在这一帧就能看到"没做成"，而不是继续等。
                 */
                setSessions((prev) => {
                  const item = prev.items[sid];
                  if (!item) return prev;
                  const r2 = settleRunningTools(item.messages, {
                    reason: j.label || '这次任务在完成前结束了',
                  });
                  if (!r2.settled) return prev;
                  return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: r2.messages } } };
                });
              }
              continue;
            }
            if (j.type === 'selfcheck') {
              // 2026-10-18 第十六轮：双 AI 自检事件（后端 agentReview.js）。
              // phase='continue' = 自查发现没做完，回灌续跑；phase='audit' = 复检结论。
              // 作为一条 role='review' 消息落进会话，渲染成「豆芽自查卡」。
              const reviewMsg = {
                role: 'review',
                phase: j.phase,
                round: j.round || 0,
                missing: Array.isArray(j.missing) ? j.missing : [],
                pass: j.pass,
                summary: j.summary || '',
              };
              setSessions((prev) => {
                const item = prev.items[sid];
                if (!item) return prev;
                return {
                  ...prev,
                  items: { ...prev.items, [sid]: { ...item, messages: [...item.messages, reviewMsg], updatedAt: Date.now() } },
                };
              });
              continue;
            }
            if (j.type === 'gate_report') {
              // 【2026-11-03】闸门清单：本次任务里**因为需要用户在场而没执行**的步骤。
              // 改前这些步骤只在后端日志里，用户看到的是一份"做完了"的报告 + 几个没交付的东西，
              // 不知道差在哪。落成一条 role='gate_report' 消息，渲染成默认收起的折叠条
              // （见下方 render 分支）：一行说清"有 N 步没执行"，点开才看明细。
              // ⚠️ 事件字段名与后端约定固定（type/total/items/unattended），不要重命名。
              const gateMsg = {
                role: 'gate_report',
                total: j.total || 0,
                blocked: j.blocked || 0,
                items: Array.isArray(j.items) ? j.items : [],
              };
              setSessions((prev) => {
                const item = prev.items[sid];
                if (!item) return prev;
                // ★ 用 mergeGateReport 而不是 append：闸门清单是「当前状态」不是「事件流水」。
                //   后端签名去重只在内容没变时拦得住；一旦又拦了新东西、或同一件事的 count 递增，
                //   它还会再发一次。老老实实 append 的话，用户在长任务里会看到好几条
                //   「有 N 步没执行」叠在一起 —— 和修前那 7 段重复是同一个病。
                return {
                  ...prev,
                  items: { ...prev.items, [sid]: { ...item, messages: mergeGateReport(item.messages, gateMsg), updatedAt: Date.now() } },
                };
              });
              continue;
            }
            if (j.type === 'heartbeat') {
              // 后端深度思考期间的保活信号：据此维持「正在思考」状态，让用户知道没卡死
              setLiveThinking(!!j.thinking);
              continue;
            }
            if (j.type === 'plan') {
              setWfPlan(Array.isArray(j.steps) ? j.steps : []);
              continue;
            }
            // 【2026-11-09】plan_gate：只有 CONFIRM 档（不可逆/多步/有歧义）后端才会发这个事件。
            // QUEUE/SILENT 档后端照旧直接放行 ⇒ 这里静默，不打扰（保住用户要的"去掉确认弹窗"体感）。
            if (j.type === 'plan_ack') {
              setWfPlan(Array.isArray(j.steps) ? j.steps : []);
              setWfPlanAck({
                id: j.id,
                steps: Array.isArray(j.steps) ? j.steps : [],
                reasons: Array.isArray(j.reasons) ? j.reasons : [],
              });
              continue;
            }
            // 【2026-11-09】待批队列：无人值守/QUEUE 档里"没敢擅自做"的动作清单。
            // 与 gate_report 分开落消息：那个说"几件没做"（损失），这个说"这几件等你点头"（待办）。
            if (j.type === 'pending_actions') {
              const paMsg = {
                role: 'pending_actions',
                total: j.total || 0,
                items: Array.isArray(j.items) ? j.items : [],
              };
              setSessions((prev) => {
                const item = prev.items[sid];
                if (!item) return prev;
                return {
                  ...prev,
                  items: { ...prev.items, [sid]: { ...item, messages: mergePendingActions(item.messages, paMsg), updatedAt: Date.now() } },
                };
              });
              continue;
            }
            if (j.type === 'material') {
              setWfMaterial({ id: j.id, prompt: j.prompt || '需要你提供素材' });
              continue;
            }
            if (j.type === 'material_result') {
              // 【第二十三轮】后端超时/被跳过时发的是 {cancelled:true}（backend.js 里
              // waitMaterial 返回 null 的分支）。旧写法只清卡片、不读这个字段 ⇒
              // 弹窗凭空消失，用户完全不知道发生了什么。现在补一条对话区可见的系统小字。
              const matSkipped = j.cancelled === true;
              setWfMaterial(null);
              setMatInput('');
              if (matSkipped) pushNotice(NOTICE_MATERIAL_SKIPPED, sid);
              continue;
            }
            if (j.type === 'confirm') {
              setWfConfirm({ id: j.id, name: j.name, params: j.params || {}, label: j.label || '', target: j.target || '' });
              setWfConfirmRemember(false); // 每次新确认都重置勾选，避免上一次的勾选被带到下一次（安全底线）
              continue;
            }
            if (j.type === 'confirm_result') {
              setWfConfirm(null);
              continue;
            }
            if (j.type === 'clarify') {
              const qs = Array.isArray(j.questions) ? j.questions : [];
              setWfClarify({ id: j.id, questions: qs, context: j.context || '' });
              setClarifySel(qs.map(() => ''));
              setClarifyInput('');
              continue;
            }
            if (j.type === 'deliverables') {
              const dmsg = { role: 'deliverable', items: Array.isArray(j.items) ? j.items : [], workspace: j.workspace || '' };
              setSessions((prev) => {
                const item = prev.items[sid];
                if (!item) return prev;
                return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: [...item.messages, dmsg] } } };
              });
              loadHistoryDels();
              refreshUsage();
              continue;
            }
            if (j.type === 'clarify_result') {
              // 【第二十三轮】同 material_result：cancelled === true 就是「等超时了、
              // 我按最佳判断继续」，必须让用户看到，否则卡片一消失他只觉得"它又不动了"。
              // ⚠️ 用户主动点「跳过」走的是 /api/clarify 空串那条路，后端回的是
              // clarify_result 且**不带** cancelled ⇒ 这里不会误报，静默清卡的行为不变。
              const clrSkipped = j.cancelled === true;
              setWfClarify(null);
              setClarifyInput('');
              setClarifySel([]);
              if (clrSkipped) pushNotice(NOTICE_CLARIFY_SKIPPED, sid);
              continue;
            }
            if (j.type === 'pick_files') {
              // AI 主动索要本地文件：弹系统文件选择框，选完回传路径，后端会继续读内容
              const pid = j.id;
              const hint = j.hint || '请选择需要处理的本地文件';
              (async () => {
                try {
                  let paths = [];
                  if (window.api && window.api.pickFiles) {
                    const r = await window.api.pickFiles();
                    paths = (r && r.filePaths) || [];
                  }
                  await fetch(`${BACKEND}/api/pick-files`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: pid, paths }),
                  });
                } catch {
                  try {
                    await fetch(`${BACKEND}/api/pick-files`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ id: pid, paths: [] }),
                    });
                  } catch {}
                }
              })();
              continue;
            }
            if (j.type === 'pick_files_result') {
              continue;
            }

            if (j.error) {
              // 【第二十二轮 · 老板第 5 条 a】旧写法把错误塞进正文（`acc += '\n ' + j.error`）——
              // 于是"失败"这件事在界面上长得像一段回答，用户读完也不知道这次算不算成功。
              // 现在只**记下**原文，流结束后统一落成失败卡（见下方 lastStreamError 分支）。
              lastStreamError = String(j.error || '');
              refreshUsage();
              continue;
            }

            // 后端在工具轮把模型思考过程以自定义事件一次性推来，实时展示
            if (j.type === 'reasoning' || j.reasoning) {
              const t = j.type === 'reasoning' ? (j.text || '') : (j.reasoning || '');
              if (t) {
                accReasoning += t;
                setLiveThinking(true);
                writeAssistant(acc, accReasoning);
              }
              continue;
            }

            const reasoning =
              (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.reasoning_content) || '';
            if (reasoning) {
              accReasoning += reasoning;
              setLiveThinking(true);
              writeAssistant(acc, accReasoning);
            }

            const delta =
              (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
            if (delta) {
              acc += delta;
              setLiveThinking(false);
              writeAssistant(acc, accReasoning);
            }
          } catch {
            /* partial / keep-alive */
          }
        }
      }

      // 【第二十二轮 · 老板第 5 条 a】流里的错误 / 空响应都不再拼进正文，而是落成失败卡。
      if (lastStreamError) {
        markFailure(describeFailure({
          message: lastStreamError,
          cancelled: cancelRef.current === true,
        }));
      } else if (!acc && !accReasoning) {
        // 空响应**不是成功**：旧版写一句「(模型未返回内容)」当正文，用户看不出这次失败了。
        markFailure(describeFailure({ message: '模型没有返回任何内容（这不是完成，是失败了）' }));
      }
    } catch (e) {
      // 【第二十二轮 · 老板第 5 条 a】三类失败**分开说**（旧版只有两句：空闲超时一段长文案，
      // 其余一律「请求失败：xxx」，且都不是"失败卡"、没有重试入口）：
      //   · 空闲看门狗 → 超时类（说明"已自动结束，可以直接重发"）
      //   · 用户点了停止 → 取消类（说明"不是出错，是你要它停的"）
      //   · 其余（网络断 / 5xx / 解析炸）→ 按状态码与原文归类（网络 / 服务端 / 鉴权）
      if (e && e.message === 'stream-idle-timeout') {
        markFailure(describeFailure({
          timedOut: true,
          message: '连接长时间没有响应（常见于电脑休眠唤醒、切换网络、代理断开），已自动结束本次请求',
        }));
      } else if (cancelRef.current === true) {
        markFailure(describeFailure({
          cancelled: true,
          message: (e && e.message) || '',
        }));
      } else {
        markFailure(describeFailure({
          httpStatus: e && e.__httpStatus,
          message: (e && e.message) || String(e || ''),
        }));
      }
    } finally {
      // 先把可能还挂在 rAF 里的最后一帧内容落盘，再收尾
      flushAssistantNow();
      setBusy(false);
      setThinking(false);
      setCanStop(false);
      cancelRef.current = false;
      /**
       * ★ 【第二十二轮 · 老板第 5 条 b】「对话框还是生成中」的**收口**。
       *
       * 老板原话：「他也不会提醒你失败了 而是文案告诉你停止了，但是对话框还是生成中」。
       * 根因（完整机制见 services/chatFailure.js 的 settleRunningTools）：
       *   工具步骤的「⏳ 进行中…」由 `status==='running'` 决定，而它只会在
       *   `__tool_result__` 事件到达时被改成终态；**失败/超时/停止路径永远等不到那个事件**
       *   （后端 sendPhase('done','已停止') 后直接 res.end()），本 finally 以前又不扫 tool_call
       *   ⇒ 芯片永远「进行中…」，而且会被 persistStore 写进磁盘，重启后还在。
       * 现在：无论成功还是失败，收尾时都把还挂着的 running 步骤**如实收敛成"没等到结果"**。
       */
      setSessions((prev) => {
        const item = prev.currentId ? prev.items[prev.currentId] : null;
        if (!item) return prev;
        const res = settleRunningTools(item.messages, {
          reason: lastStreamError || '这次任务在完成前结束了',
        });
        if (!res.settled) return prev;
        return {
          ...prev,
          items: { ...prev.items, [prev.currentId]: { ...item, messages: res.messages } },
        };
      });
      // 持久化最新会话
      setSessions((prev) => {
        persistStore(prev);
        return prev;
      });
    }


    // 【T20】把本次产出的最终正文返回给调用方 —— 「让豆芽做」自动开跑要用它做任务回写 + 资产落库。
    // 未产出内容时返回空串，由 finalizeAutoRunTask 自行判断（空内容不回写，宁缺毋滥）。
    return acc;
  }

  // ---- 叫停当前对话任务 ----
  // 只 POST /api/abort（不 abort 前端 fetch）——这样后端能优雅收尾：回一段「已完成/停在哪/产出文件」
  // 的报告再 res.end()，用户看得到进度、也能立刻接着「改口」。
  async function stopTask() {
    const tid = taskIdRef.current;
    if (!tid) return;
    // 【第二十二轮·老板第 5 条 a】记下"是用户主动停的"，收尾时据它归到「你已取消」，
    // 而不是被误判成网络/服务端故障。
    cancelRef.current = true;
    setCanStop(false); // 立刻隐藏按钮，防连点

    // 【第二十三轮】停止 = 本次任务所有挂起卡片一并作废。
    //
    // 为什么这四行是必须的（实证，不是防御性编程）：后端在 waitClarify / waitMaterial 挂起时，
    // 用户点停止 ⇒ /api/abort 让 waitClarify 返回 null ⇒ 紧接着 `bailIfAborted(tc)` 为真
    //   ⇒ 后端**直接 return**（backend.js:4612-4613 那一行 before `send({type:'clarify_result'})`）。
    // 也就是说：**后端根本不会发 clarify_result**。前端若不在这里自己清，`wfClarify` 就永久非空。
    // 而 `send()` 开头有一条 `if (wfClarify) { … postClarify(ans); return; }` 的无条件改道 ⇒
    // 用户想开新话题，打的任何字都会被当成「回答澄清」POST 到 /api/clarify，后端 404（id 已废），
    // 消息静默丢失。这是"卡片残留吃掉用户消息"最狠的一条路径，必须在这里断掉。
    setWfClarify(null);
    setClarifyInput('');
    setClarifySel([]);
    setWfMaterial(null);
    setMatInput('');
    setWfConfirm(null);
    setWfConfirmRemember(false);

    try {
      await fetch(`${BACKEND}/api/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: tid }),
      });
    } catch {
      /* 网络异常忽略：任务本身另有 /api/abort 优雅收尾，断线也不会被杀 */
    }
  }

  // ---- 断线续跑：把后端还在跑（或刚跑完、还在保留期）的任务接回来 ----
  // 触发场景：刷新页面、切走再回来、网络抖动导致 SSE 断开。
  // 后端 taskStream 留着完整事件（带 seq），这里从头补一遍，重建这条回复，然后继续实时跟。
  async function resumeInto(task) {
    const tid = task && task.taskId;
    if (!tid || busy) return;
    const sid = ensureSession();
    const asstMsg = { role: 'assistant', content: '', reasoning: '' };
    setSessions((prev) => {
      const item = prev.items[sid] || { id: sid, title: '接回的任务', messages: [], updatedAt: Date.now() };
      return {
        ...prev,
        items: { ...prev.items, [sid]: { ...item, messages: [...item.messages, asstMsg], updatedAt: Date.now() } },
      };
    });
    setActiveTask(null);
    setBusy(true);
    setThinking(true);
    setCanStop(true);
    taskIdRef.current = tid;
    setWfPhase({ phase: '', label: '', progress: 0, unresolved: null, state: null });

    let acc = '';
    let accReasoning = '';
    let raf = null;
    let pending = null;
    const flush = () => {
      raf = null;
      if (!pending) return;
      const snap = pending;
      pending = null;
      setSessions((prev) => {
        const item = prev.items[sid];
        if (!item) return prev;
        const msgs = item.messages.slice();
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') { msgs[i] = { ...msgs[i], content: snap.c, reasoning: snap.r }; break; }
        }
        return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: msgs } } };
      });
    };
    const write = (c, r) => { pending = { c, r }; if (raf === null) raf = requestAnimationFrame(flush); };
    const addMsg = (m) => setSessions((prev) => {
      const item = prev.items[sid];
      if (!item) return prev;
      // ★ 闸门清单是「当前有哪些事没做」= 状态，不是事件流水 ⇒ 同会话只留一条（后来者覆盖）。
      //   否则后端每更新一次（又拦了新东西 / count 递增），用户就多看到一条「有 N 步没执行」。
      const msgs = (m && m.role === 'gate_report')
        ? mergeGateReport(item.messages, m)
        : [...item.messages, m];
      return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: msgs, updatedAt: Date.now() } } };
    });
    const patchTool = (tr) => setSessions((prev) => {
      const item = prev.items[sid];
      if (!item) return prev;
      const msgs = item.messages.slice();
      let hit = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== 'tool_call') continue;
        if (tr.id !== undefined && tr.id !== null && tr.id !== '' ? msgs[i].id === tr.id : (msgs[i].tool === tr.name && msgs[i].status === 'running')) { hit = i; break; }
      }
      if (hit >= 0) msgs[hit] = { ...msgs[hit], status: tr.ok === false ? 'error' : 'done', result: String(tr.result) };
      return { ...prev, items: { ...prev.items, [sid]: { ...item, messages: msgs } } };
    });

    try {
      const res = await fetch(`${BACKEND}/api/chat/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: tid, fromSeq: 0 }),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        // 【0.21.10】同上：断线续跑这条链路也要有空闲看门狗，否则「接回任务」卡住同样会让 busy 恒真。
        const { done, value } = await readWithIdle(reader);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const raw = t.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const j = JSON.parse(raw);
            if (j.type === 'resume_error') { acc += '\n（' + (j.error || '任务已结束') + '）'; write(acc, accReasoning); continue; }
            if (j.type === 'resume') continue;
            if (j.__tool__) {
              addMsg({ role: 'tool_call', id: j.id, tool: j.__tool__, label: j.label || j.__tool__, silent: !!j.silent, status: 'running', result: '' });
              continue;
            }
            if (j.__tool_result__) { patchTool(j.__tool_result__); continue; }
            if (j.type === 'phase') {
              setWfPhase({
                phase: j.phase,
                label: j.label || '',
                progress: j.progress || 0,
                unresolved: (typeof j.unresolved === 'number') ? j.unresolved : null,
                state: j.state || null,
                sid,
              });
              continue;
            }
            if (j.type === 'selfcheck') {
              addMsg({ role: 'review', phase: j.phase, round: j.round || 0, missing: Array.isArray(j.missing) ? j.missing : [], pass: j.pass, summary: j.summary || '' });
              continue;
            }
            // 【2026-11-03】闸门清单也要能在**续跑补播**里还原：这条路径是刷新/切走再回来
            // 时从头重放事件缓冲，主链路（上方 SSE 分支）有的消息类型这里少一个，
            // 用户重进对话就会看到"少了一步"的空白。字段与主链路严格一致。
            if (j.type === 'gate_report') {
              addMsg({ role: 'gate_report', total: j.total || 0, blocked: j.blocked || 0, items: Array.isArray(j.items) ? j.items : [] });
              continue;
            }
            if (j.type === 'plan') { setWfPlan(Array.isArray(j.steps) ? j.steps : []); continue; }
            if (j.type === 'material') { setWfMaterial({ id: j.id, prompt: j.prompt || '需要你提供素材' }); continue; }
            if (j.type === 'confirm') { setWfConfirm({ id: j.id, name: j.name, params: j.params || {}, label: j.label || '', target: j.target || '' }); continue; }
            if (j.type === 'clarify') { setWfClarify({ id: j.id, questions: Array.isArray(j.questions) ? j.questions : [], context: j.context || '' }); continue; }
            // 【第二十三轮】补上三个 `*_result` 分支 —— 这是「卡片残留吃掉用户消息」的第三条路径。
            //
            // 为什么必须有：续跑（刷新页面 / 切走再回来 / 断线重连）时，前端是**从头补播**
            // 后端的事件缓冲（fromSeq: 0）。旧代码只处理了 material / confirm / clarify 三个
            // **入站**事件，没处理它们的 `*_result` ⇒ 补播到「卡片弹出」时 setWfCard(...) 生效，
            // 补播到「用户已答/已超时」那条 result 时却无人清卡 ⇒ 卡片永久挂在那儿。
            // 后果与 stopTask 那条完全相同：`send()` 被 `if (wfClarify)` 改道，用户新输入丢失。
            // 行为与主链路严格一致（清对应 state；超时另给一条小字）。
            if (j.type === 'material_result') {
              const matSkippedR = j.cancelled === true;
              setWfMaterial(null);
              setMatInput('');
              if (matSkippedR) addMsg({ role: 'notice', content: NOTICE_MATERIAL_SKIPPED });
              continue;
            }
            if (j.type === 'confirm_result') { setWfConfirm(null); continue; }
            if (j.type === 'clarify_result') {
              const clrSkippedR = j.cancelled === true;
              setWfClarify(null);
              setClarifyInput('');
              setClarifySel([]);
              if (clrSkippedR) addMsg({ role: 'notice', content: NOTICE_CLARIFY_SKIPPED });
              continue;
            }
            if (j.type === 'deliverables') { addMsg({ role: 'deliverable', items: Array.isArray(j.items) ? j.items : [], workspace: j.workspace || '' }); continue; }
            if (j.type === 'heartbeat') { setLiveThinking(!!j.thinking); continue; }
            if (j.error) { acc += '\n ' + j.error; write(acc, accReasoning); continue; }
            if (j.type === 'reasoning' || j.reasoning) {
              const r = j.type === 'reasoning' ? (j.text || '') : (j.reasoning || '');
              if (r) { accReasoning += r; write(acc, accReasoning); }
              continue;
            }
            const r2 = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.reasoning_content) || '';
            if (r2) accReasoning += r2;
            const d = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
            if (d) acc += d;
            if (r2 || d) write(acc, accReasoning);
          } catch { /* partial */ }
        }
      }
      if (!acc && !accReasoning) write('（这个任务已经结束，但没留下可读的正文）', '');
    } catch (e) {
      if (e && e.message === 'stream-idle-timeout') {
        // 【0.21.10】同主链路：断线续跑卡死时也要给出可执行的下一步，且 busy 必须归位（finally 里已保证）。
        acc += '\n⏱ 接回任务时长时间没有响应，已放弃接回。任务本身可能仍在后台跑，过一会儿可以再点「接回来」；'
          + '也可以直接重新发送，不用重启应用。';
      } else {
        acc += '\n 接回任务失败：' + e.message;
      }
      write(acc, accReasoning);
    } finally {
      if (raf !== null) { cancelAnimationFrame(raf); flush(); }
      setBusy(false);
      setThinking(false);
      setCanStop(false);
      setSessions((prev) => { persistStore(prev); return prev; });
      loadHistoryDels();
      refreshUsage();
    }
  }

  sendRef.current = send;

  // 断线续跑（第十八轮）：定时问后端「还有没有任务在跑」。刷新、切走再回来、断网恢复后，
  // 都能在对话区顶部看到「有个任务还在后台跑 · 接回来」，点了从事件缓冲补播到最新。
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (busy) return; // 自己正在流式接收时不需要提示
      try {
        const r = await fetch(`${BACKEND}/api/chat/active`);
        if (!alive) return;
        const j = await r.json();
        const list = (j.tasks || []).filter((t) => !t.done);
        setActiveTask(list[0] || null);
      } catch { /* 后端未就绪：静默 */ }
    };
    poll();
    const iv = setInterval(poll, 15000);
    return () => { alive = false; clearInterval(iv); };
  }, [busy]);

  // 拉取历史成果（侧栏「成果」区块，跨会话保留；按当前登录账号隔离）
  function loadHistoryDels() {
    const uname = authUser?.username || authUser?.name || '';
    fetch(`${BACKEND}/api/deliverables?username=${encodeURIComponent(uname)}`)
      .then((r) => r.json())
      .then((j) => setHistoryDels(Array.isArray(j.items) ? j.items : []))
      .catch(() => {});
  }
  // 把一批绝对路径（或 file:// / http 链接）去重后加入附件列表
  function addAttachmentPaths(paths) {
    if (!paths || !paths.length) return;
    // 图片附件提示：图片只能走 OCR 读文字，链路本身正常；这里打一条日志便于排查
    const IMG_EXT_RE = /\.(png|jpe?g|bmp|webp|gif)$/i;
    if (paths.some((p) => p && IMG_EXT_RE.test(p))) {
      console.log('[Attach] 收到图片，发送后豆芽会读取图片里的文字（OCR）');
    }
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.path));
      const add = paths
        .filter((p) => p && !existing.has(p))
        .map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
      return [...prev, ...add];
    });
  }
  // 点按钮：弹系统文件选择框（可多选）
  async function pickFiles() {
    if (!window.api || !window.api.pickFiles) return;
    try {
      const r = await window.api.pickFiles();
      addAttachmentPaths(r && r.filePaths);
    } catch {}
  }
  // 把拖拽 DataTransfer 解析成一批本地文件路径，加入附件。
  // 优先读 files；files 为空时（拖网页/浏览器里的图片）兜底解析 text/uri-list 与 text/plain。
  function handleDropFiles(e) {
    e.preventDefault();
    const dt = e.dataTransfer;
    const paths = [];
    if (dt && dt.files && dt.files.length) {
      for (const f of dt.files) {
        let p = '';
        if (window.api && window.api.getPathForFile) p = window.api.getPathForFile(f);
        if (!p && f.path) p = f.path;
        if (p) paths.push(p);
      }
    } else {
      const uriList = (dt && dt.getData('text/uri-list')) || '';
      const plain = (dt && dt.getData('text/plain')) || '';
      const raw = (uriList || plain || '').trim();
      if (raw) {
        for (const token of raw.split(/\s+/)) {
          const s = token.replace(/^<|>$/g, '').trim();
          if (!s) continue;
          if (/^file:\/\//i.test(s)) {
            // file:// URL 还原成本地路径（Windows /C:/xxx -> C:/xxx）
            try {
              const u = new URL(s);
              let p = decodeURIComponent(u.pathname);
              if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
              if (p) paths.push(p);
            } catch { paths.push(s); }
          } else if (/^https?:\/\//i.test(s)) {
            // 拖网页里的图片/文件：没有本地路径，把 URL 作为附件（name 取最后一段）
            paths.push(s);
          }
        }
      }
    }
    if (!paths.length) {
      alert('没识别到可处理的文件，请拖本地文件（图片/文档/代码/表格）');
      return;
    }
    addAttachmentPaths(paths);
  }
  // 用 ref 保存最新的 handleDropFiles，避免全局拖拽监听器闭包捕获到旧实现（空依赖 useEffect 的隐患）
  const dropHandlerRef = useRef(handleDropFiles);
  useEffect(() => { dropHandlerRef.current = handleDropFiles; });
  function onDragOver(e) {
    e.preventDefault();
  }
  // 「继续改」：把历史成果加入附件，并预填一句需求 + 聚焦输入框
  function continueEdit(d) {
    if (!d || !d.path) return;
    addAttachmentPaths([d.path]);
    setInput('帮我改一下这个文件，需求是：');
    setTimeout(() => { if (inputRef.current && inputRef.current.focus) inputRef.current.focus(); }, 50);
  }

  // 素材索要与确认门：把用户决定回传后端，继续挂起的 Agent 循环
  //
  // 【第二十三轮】不再「无条件当成功」。
  // 旧写法是 `try { await fetch(...) } catch {}` + 无条件清卡：后端若回 404
  // （`waitMaterial` 已经超时 5 分钟、id 已作废），前端既不检查状态码也不打日志，
  // 界面看起来"提交成功"、卡片照常消失，而**用户刚打的那段素材彻底没了**。
  // 现在：非 2xx 一律 console.warn 带 id；内容非空时回填到主输入框，让用户不至于白打。
  // ⚠️ 请求体字段名与结构**一个字都没动**（后端正按「空串 = 跳过」处理，不能改）。
  async function postMaterial(content) {
    const id = wfMaterial && wfMaterial.id;
    if (!id) return;
    let badStatus = 0; // 0 = 成功 / 未拿到响应码；>0 = HTTP 非 2xx；-1 = 网络异常
    try {
      const r = await fetch(`${BACKEND}/api/material`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, content: content || '' }),
      });
      if (!r.ok) badStatus = r.status || -1;
    } catch (e) {
      badStatus = -1;
      console.warn('[material] 网络异常，提交可能没送到后端 id=' + id, e && e.message);
    }
    if (badStatus > 0) {
      // 后端明确回了一个非 2xx：id 基本可以断定已过期（超时/已被跳过/任务已结束）
      console.warn('[material] 提交被拒绝，id 可能已过期 id=' + id + ' status=' + badStatus);
      const t = String(content || '').trim();
      // 只在内容非空、且主输入框确实是空的时回填 —— 避免覆盖用户正在打的字
      if (t && !String(input || '').trim()) setInput(t);
    }
    setWfMaterial(null);
    setMatInput('');
  }
  /**
   * 【2026-11-09】plan_gate 的提交：同意 / 不同意。
   *
   * 语义（与 backend /api/plan-ack 一致）：
   *   · ack='ok'  → 用户点头，后端把本轮升级为「按计划执行」
   *   · ack='no'  → 用户不同意，后端要求模型**先别动手**、先问清怎么改
   *   · 请求失败/404（id 已超时失效）→ 只清卡片，不打日志骗人：超时本来就会让后端按
   *     "未获授权"继续，前端这里不需要替它做任何决定。
   */
  async function resolvePlanAck(ack) {
    const id = wfPlanAck && wfPlanAck.id;
    if (!id) { setWfPlanAck(null); return; }
    try {
      await fetch(`${BACKEND}/api/plan-ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ack: ack === 'ok' ? 'ok' : 'no' }),
      });
    } catch { /* 网络失败不阻断 UI：后端超时后会按"未获授权"继续，不会误判成同意 */ }
    setWfPlanAck(null);
  }
  async function resolveConfirm(allow) {
    const id = wfConfirm && wfConfirm.id;
    if (!id) return;
    try {
      await fetch(`${BACKEND}/api/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, allow: !!allow, remember: !!allow && !!wfConfirmRemember }),
      });
    } catch {}
    setWfConfirm(null);
  }
  function buildClarifyAnswer() {
    const qs = (wfClarify && wfClarify.questions) || [];
    let ans = '';
    qs.forEach((qq, i) => {
      const qText = typeof qq === 'string' ? qq : qq.q || '';
      const sel = clarifySel[i] || '';
      ans += '• ' + qText + '\n  → ' + (sel || '(未选)') + '\n';
    });
    if (clarifyInput.trim()) ans += '补充：' + clarifyInput.trim() + '\n';
    return ans.trim();
  }
  /**
   * 把澄清回答回传后端（后端 await 一直挂着，收到即续流）。
   *
   * 【第二十三轮】与 postMaterial 同样加上状态检查：
   * 旧写法 `catch {}` + 无条件清卡，在后端已超时（`waitClarify` 回 null、id 作废）时会
   * **静默吞掉用户这段回答** —— 用户以为答完了，其实后端早不等了，界面上什么提示都没有。
   * 现在非 2xx 时 console.warn 带 id，内容非空则回填主输入框。
   * ⚠️ 请求体结构保持 `{ id, answer }` 不变（后端按「空串 = 跳过」在改，不能动）。
   *
   * @param {string} content 回答正文；空串 = 「跳过，按最佳判断直接做」
   * @returns {Promise<void>}
   */
  async function postClarify(content) {
    const id = wfClarify && wfClarify.id;
    if (!id) return;
    let badStatus = 0; // 0 = 成功 / 未拿到响应码；>0 = HTTP 非 2xx；-1 = 网络异常
    try {
      const r = await fetch(`${BACKEND}/api/clarify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, answer: content || '' }),
      });
      if (!r.ok) badStatus = r.status || -1;
    } catch (e) {
      badStatus = -1;
      console.warn('[clarify] 网络异常，回答可能没送到后端 id=' + id, e && e.message);
    }
    if (badStatus > 0) {
      console.warn('[clarify] 提交被拒绝，id 可能已过期 id=' + id + ' status=' + badStatus);
      const t = String(content || '').trim();
      // 用户点「跳过」时 content 为空 ⇒ 不需要回填任何东西
      if (t && !String(input || '').trim()) setInput(t);
    }
    setWfClarify(null);
    setClarifyInput('');
    setClarifySel([]);
  }

  // ---- 登录 / 退出 ----
  async function doLogin() {
    if (loginBusy) return;
    if (!loginUser.trim() || !loginPass) {
      setLoginErr('请输入账号和密码');
      return;
    }
    setLoginBusy(true);
    setLoginErr('');
    try {
      const r = await fetch(`${BACKEND}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser.trim(), password: loginPass }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        localStorage.setItem('douya-auth-token', j.access_token);
        localStorage.setItem('douya-auth-user', JSON.stringify(j.user || {}));
        setAuthUser(j.user || null);
        setAccount(j.user || null);
        setAuthed(true);
      } else {
        // ★★★ 2026-11-11 修：402 说的**不是**"密码错了"。
        //
        //   改前这一行是 `setLoginErr(j.detail)`，而主进程 402 的 body 里
        //   `detail` 恰好就是「还没激活」⇒ 登录页红字显示"还没激活"。
        //   实测（真 HTTP）：`POST /api/auth/login` ⇒ 402
        //     {"code":"LICENSE_REQUIRED","detail":"还没激活","path":"/api/auth/login"}
        //   于是用户看到"还没激活"以为要先去激活、去找激活入口（找不到），
        //   而另一部分人会以为是密码问题去反复改密码。**一句话把两个方向都指错了。**
        //
        //   现在这个分支理论上不该再触发（`/api/auth/*` 已进白名单）；
        //   留着是为了"新版界面 + 旧版主进程"这种升级中间态 —— 那时候用户至少能看懂发生了什么。
        if (j && (j.code === 'LICENSE_REQUIRED' || j.error === 'LICENSE_REQUIRED')) {
          setLoginErr('本机授权还没激活，登录请求被拦下了。请看下方的激活输入框；激活后重新登录。');
          // 让授权面板立刻对一次表（登录页那份是 inline 形态，会被这个事件唤醒）
          try { window.dispatchEvent(new CustomEvent('douya:license-required')); } catch { /* 旧环境没有 CustomEvent 不影响主线 */ }
        } else {
          setLoginErr((j && j.detail) || '用户名或密码错误');
        }
      }
    } catch (e) {
      setLoginErr('无法连接登录服务器');
    } finally {
      setLoginBusy(false);
    }
  }
  function doLogout() {
    localStorage.removeItem('douya-auth-token');
    localStorage.removeItem('douya-auth-user');
    // ★ 2026-11-06 产物隔离：还要清掉**主进程侧**的账号标识。
    //   产物目录（生图/生视频/海报）由主进程按"当前账号"派生，账号事实落在
    //   `<userData>/current-account.json`。只清 localStorage 的话，登出后主进程
    //   仍按上一个账号派生 ⇒ 未登录态打开作品库，看到的还是前一个账号的东西。
    //   ⚠️ 必须 try/catch 且判存在：通道缺失（老 preload / 主进程未 ready）不许阻断登出。
    try { window.api && window.api.accountForget && window.api.accountForget(); } catch { /* 通道缺失不阻断登出 */ }
    setAuthUser(null);
    setAuthed(false);
  }
  function refreshUsage() {
    const uname = authUser && (authUser.username || authUser.name || '');
    fetch(`${BACKEND}/api/usage?username=${encodeURIComponent(uname)}`)
      .then((r) => r.json())
      .then((j) => setUsage(j))
      .catch(() => {});
  }

  // ---- 成果文件：打开 / 定位 ----
  function openDeliverable(p) {
    if (window.api && window.api.openPath) {
      window.api.openPath(p).catch(() => {});
    }
  }
  function showDeliverableInFolder(p) {
    if (window.api && window.api.showInFolder) {
      window.api.showInFolder(p).catch(() => {});
    }
  }
  function openWorkspace(p) {
    if (window.api && window.api.openWorkspace) {
      window.api.openWorkspace(p).catch(() => {});
    }
  }

  // ---- 设置 ----
  /**
   * 把一份配置落库：localStorage['agent-settings'] + 后端 /api/config。
   * 注：联网检索 key 不回显（GET /api/config 不返回它），因此「输入框为空」= 用户未改动，
   * 必须从提交体里剔除，否则会把主程序已保存的 key 覆盖为空字符串。
   * @param {object} next 要落库的完整配置（缺省用当前 cfg）
   */
  function persistSettings(next) {
    const c = next && typeof next === 'object' && !('nativeEvent' in next) ? next : cfg;
    localStorage.setItem('agent-settings', JSON.stringify(c));
    const payload = { ...c };
    if (!payload.tavilyApiKey) delete payload.tavilyApiKey;
    // 同步保存到后端 config.json（火山语音 key / 联网检索 key 在主程序读取，必须落盘到 config.json）
    fetch(`${BACKEND}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(() => { if (c.tavilyApiKey) setTavilyConfigured(true); })
      .catch(() => {});
  }

  /** 设置面板「保存」：沿用原行为（落当前 cfg + 关闭面板）。 */
  function saveSettings() {
    persistSettings(cfg);
    setShowSettings(false);
    // 「补连即补算」：用户刚把 AI 接上（填 Key / 或切到内网网关）→ 若当前企业从未体检过，补跑一次
    if (isAiReady({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })) maybeRunCheckupForCurrent();
  }

  /**
   * 补跑一次企业体检（任务书 §五 P0-5「连上后自动补跑一次体检」）。
   * 触发点 = 用户**主动连上 AI** 的动作（applyLLMPatch / saveSettings），而非 cfg 任意变化：
   *   · 若当前无企业（新用户在屏 2 连上时企业尚未创建）→ 跳过；
   *   · 若该企业已体检过 → 跳过；
   *   · 同企业本会话已尝试过（checkupTriedRef）→ 跳过，避免反复触发 / 重复烧 token；
   * 体检失败一律静默（不弹错、不白屏）。结论落独立 key `douya-company-checkup`，
   * **在「企业资产库 → 企业大脑」Tab（模块 `profile`，CompanyBrain「 企业体检结论」）里展示**。
   * 历史注释曾写「之后可在「经营诊断」看到」——**与实现不符**：「经营诊断」(`MarketMomentum`)
   *    跑的是 `diagnoseMarket`（11 维市场诊断），体检结论并不在那里展示。此处已修正为事实。
   */
  function maybeRunCheckupForCurrent() {
    const co = currentCompany;
    const cid = co && co.id;
    if (!cid) return;
    if (checkupTriedRef.current.has(cid)) return;
    if (loadCheckup(cid)) return;
    checkupTriedRef.current.add(cid);
    try {
      runCompanyCheckup({
        currentCompany: co,
        knowledge: getKnowledge(cid),
        role: currentRole,
        companyName: co.name,
        companyType: co.type,
      }).catch(() => {});
    } catch { /* 忽略：补算失败不影响主流程 */ }
  }

  /**
   * 「把豆芽喂饱」引导卡的「跑一次企业体检」入口（**用户主动点击 ⇒ 语义 = 重跑**）。
   *
   * 刻意**不复用 maybeRunCheckupForCurrent()**：那个带三个 guard（同会话只跑一次 / 已体检过跳过 /
   *    无企业跳过），是「连上 AI 后自动补算一次」的语义。用户**主动点**要的是「现在就重跑一遍」，
   *    复用它会得到「点了毫无反应」（同会话点第二次必然被 checkupTriedRef 拦掉）。
   * 本函数不带任何 guard：只要当前有企业就真跑一次；返回 Promise 供调用方上 loading 态防重复点击。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  function runCheckupNow() {
    const co = currentCompany;
    const cid = co && co.id;
    if (!cid) return Promise.resolve({ ok: false, error: '当前没有企业' });
    return runCompanyCheckup({
      currentCompany: co,
      knowledge: getKnowledge(cid),
      role: currentRole,
      companyName: co.name,
      companyType: co.type,
    })
      .then((r) => ({ ok: !!(r && r.ok), error: (r && r.error) || '' }))
      .catch((e) => ({ ok: false, error: (e && e.message) || '体检失败' }));
  }

  /**
   * 屏 2「连上 AI」实测通过后回写全局配置（对应架构风险 E4 / 任务书 C3）：
   * setCfg(next) → needKey（由 aiReadiness 同源判定）立即变假 → 工作台软门禁提示条消失；
   * 同时落 localStorage + 后端 /api/config，并清除「AI 待连」记账标记。
   * @param {{baseURL?:string, apiKey?:string, model?:string}} patch
   */
  function applyLLMPatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    persistSettings(next);
    try { localStorage.removeItem('douya-ai-pending'); } catch { /* 忽略 */ }
    // 屏 2 场景下企业尚未创建 → 内部会因无 currentCompany 而跳过，不影响首登流程
    if (isAiReady({ apiKey: next.apiKey, baseURL: next.baseURL })) maybeRunCheckupForCurrent();
  }

  // ---- 运行环境一键切换（内网/公网）：点击即填充三项并立即生效 ----
  function applyEnv(env) {
    const presets = {
      intranet: {
        baseURL: 'http://192.168.80.99:10003/v1',
        model: 'deepseek-v4-pro-wb',
      },
      public: {
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      },
    };
    const preset = presets[env];
    if (!preset) return;
    // 直接构造 next 对象写 localStorage 与后端，不依赖 setCfg 后的旧 cfg 闭包，确保立即生效
    // 注意：apiKey 不随环境预设切换（安全起见不内置 key），保留用户当前填写的 key
    const next = { ...cfg, baseURL: preset.baseURL, model: preset.model };
    setCfg(next);
    localStorage.setItem('agent-settings', JSON.stringify(next));
    // 同 saveSettings：不回显的检索 key 若为空则剔除，避免误清空主程序已存的 key。
    const payload = { ...next };
    if (!payload.tavilyApiKey) delete payload.tavilyApiKey;
    fetch(`${BACKEND}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  // ---- 连接器 ----
  function loadConnectors() {
    fetch(`${BACKEND}/api/connectors`)
      .then((r) => r.json())
      .then((list) => setConnectors(Array.isArray(list) ? list : []))
      .catch(() => {});
  }
  function testConnector(id) {
    setConnBusy(true);
    setConnMsg('');
    setConnMsgFor(id);
    fetch(`${BACKEND}/api/connectors/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((r) => {
        setConnMsg(r && r.ok ? '✓ 连接成功' : '✗ 连接失败：' + ((r && r.error) || '未知错误'));
        loadConnectors();
      })
      .catch((e) => setConnMsg('✗ 请求失败：' + e.message))
      .finally(() => setConnBusy(false));
  }
  function disconnectConnector(id) {
    setConnMsg('');
    setConnMsgFor(id);
    fetch(`${BACKEND}/api/connectors/${encodeURIComponent(id)}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then(() => {
        setConnMsg('已断开');
        loadConnectors();
      })
      .catch((e) => setConnMsg('✗ 请求失败：' + e.message));
  }

  // 一键诊断：用当前模型接入配置，实测 LLM 网关连通性与 key 有效性。
  // 契约与首登屏 2 共用 services/llmTest.js（POST /api/llm/test）；用户可见提示文案保持原样。
  function testLLM() {
    setLlmTesting(true);
    setLlmTestMsg('');
    runLLMTest({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })
      .then((r) => {
        if (r && r.ok) {
          setLlmTestMsg(`✓ 模型连接成功（${r.latencyMs}ms）· 返回「${r.reply}」`);
        } else if (r && r.network) {
          setLlmTestMsg('✗ 请求失败：' + (r.error || '请求失败'));
        } else {
          setLlmTestMsg('✗ ' + ((r && r.error) || '连接失败'));
        }
      })
      .finally(() => setLlmTesting(false));
  }

  // AI 可用性判据（单一事实源 services/aiReadiness.js，与主进程 backend.js 同源）：
  // **不是**「有没有填 Key」—— 内网模型网关零配置登录即用（老板原话「填 API 或者账号」的账号那条）。
  // 只有「无 Key 且 baseURL 是公网 DeepSeek」才真的连不上、才需要提示去配置。
  const needKey = needAiConfig({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  const connShopConnected = !!(connectors.find((c) => c.id === 'shop-supplier-a') || {}).connected;
  const connGeoConnected = !!(connectors.find((c) => c.id === 'doudou-ai') || {}).connected;
  // 上游货源商城连接器（shop-supplier-b）由 T02 落地；此处先按 id 取状态，未接入时恒为「未连接」。
  const connMmmConnected = !!(connectors.find((c) => c.id === 'shop-supplier-b') || {}).connected;
  // 2026-10-18 第十六轮：会话抽屉只显示**当前分区**的会话（旧会话无 scope 字段按 'chat' 兼容），
  // 避免「对话」里混进开发任务记录、两个分区互相打扰。
  // ⚠️ 2026-10-19 第十九轮：任务栏改成一个栏混排三类任务（taskBarItems），**不再按分区过滤**
  // （同一个栏里既要有对话也要有开发任务），故本变量当前没有调用点，保留为退路。
  const sessionList = Object.values(sessions.items)
    .filter((s) => (s.scope || 'chat') === chatScope)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // 未登录：渲染覆盖全屏的登录卡片（账号密码与自建后端一致）
  if (!authed) {
    return (
      <ConfigProvider
        theme={{
          // 【0.21.25 · 2026-11-08】这 4 个分支（未登录 / 初始化引导 / 我的企业 / 无企业兜底）
          // 原先只给了 `token`、**缺 `algorithm`** ⇒ 深色主题下这几页里的 antd 组件
          // （输入框、弹窗、下拉、日期选择）仍是浅色一套，压在深底上像补丁。
          // 顶层 `:3558` 那一处一直是对的，这里补齐成同一个口径：
          // 绿 / 白照旧 defaultAlgorithm（今天的样子一个像素不变），深色才切 darkAlgorithm，
          // 并把主色抬到与 `--c-brand` 深色值（#3cc47c）一致（沿用 #0E7D59 在深底上会发闷）。
          algorithm: themeNow === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: themeNow === 'dark' ? '#3cc47c' : '#0E7D59',
            borderRadius: 12,
          },
        }}
      >
        <div className="login-overlay">
          {/* 背景视频：保留声音（不 muted）。加载失败则隐藏，自动回落 overlay 的绿色渐变底。 */}
          {!loginVideoFailed && (
            <video
              ref={loginVideoRef}
              className="login-bg-video"
              src="./login-bg.mp4"
              autoPlay
              loop
              playsInline
              preload="auto"
              onError={() => setLoginVideoFailed(true)}
            />
          )}
          {/* 半透明浅色遮罩：压住视频亮度，保证白底毛玻璃卡片与文字清晰可读（不用黑/深色叠底） */}
          <div className="login-mask" aria-hidden="true" />
          {/* 带声自动播放被拦截时的兜底：点击后借用户手势正常起播，绝不静默静音 */}
          {loginVideoBlocked && !loginVideoFailed && (
            <button
              type="button"
              className="login-sound-pill"
              onClick={() => {
                const v = loginVideoRef.current;
                try {
                  const p = v && v.play && v.play();
                  if (p && typeof p.catch === 'function') p.catch(() => {});
                } catch { /* 忽略：极端情况下手动播放仍失败，静默即可 */ }
                setLoginVideoBlocked(false);
              }}
            >
              开启声音
            </button>
          )}
          <div className="login-card">
            <img src={douyaLogo} className="login-logo-img" alt="豆芽CLAW" draggable="false" />
            <div className="login-title">豆芽CLAW 登录</div>
            <div className="login-sub">厂家 / 经销商账号登录 · 自建后端</div>
            <div className="login-field">
              <input
                className="login-input"
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                placeholder="账号 / 用户名"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }}
              />
            </div>
            <div className="login-field">
              <input
                className="login-input"
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="密码"
                onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }}
              />
            </div>
            {loginErr && <div className="login-err">{loginErr}</div>}
            <button className="login-btn" onClick={doLogin} disabled={loginBusy}>
              {loginBusy ? '登录中…' : '登录'}
            </button>
          </div>

          {/* ★ 2026-11-11（老板："我现在豆芽进去要先激活 但是没有激活的地方"）
              激活入口放在**门口**，而且**不遮挡登录表单**。
              理由见 LicenseGuardHost 头注：登录验的是平台账号、授权验的是本机码，
              是两个独立的闸；把登录盖住等于用第二道闸去堵第一道 ⇒ 既登不进也激活不了。 */}
          <LicenseGuardHost inline />
        </div>
      </ConfigProvider>
    );
  }

  // 首登完成：切工作台；若带引导信号则复用 routeIntent 机制进入 campaign 一句话生成器
  function handleOnboardDone(guide) {
    setView('workbench');
    // 【P0】无条件把落地模块切回一个**保底入口**：老用户/新增企业时若之前浏览过别的模块，
    // localStorage 的 douya-active-module 会残留（如 'campaign'），先置保底再由下面
    // campaign 出口覆盖。
    // 【0.21.21 · 老板 2026-10-21】保底从 'activity' 改成 'workbench'。
    //   ⚠️ 这是一条**无条件**执行的跳转，也是删板块最容易炸的地方：'activity' 分支
    //   已随 ActivityHub 一起删除，若这里不改，新用户建完档进来看到的就是**整块白屏**
    //   （侧栏还在、主体区空），而且因为是无条件执行，每次首登都会复现。
    //   选 workbench 而不是别的：首登后用户本来就该先见豆芽助手（首页与助手已合并），
    //   且它是唯一「永远存在」的入口；真正要铺方案的那条出口在下面用 campaign 覆盖。
    setActiveModule('workbench');
    if (guide && guide.guide && guide.brief) {
      setRouteIntent({
        kind: 'confirm_brief',
        briefTitle: guide.brief,
        briefReason: '来自首次建档的当前经营重点',
        source: 'onboarding',
        sourceChangeId: null,
      });
      // 「让豆芽开始规划（一句话描述）」出口：覆盖上面的 today，行为保持不变。
      setActiveModule('campaign');
    }
    // 【P1】第8步选定的经营方向：写入「待铺方向」记录，供 TodayOps 挂载时消费。
    // 仅当同时带 directionKey 与 companyId 时写入；未带 directionKey 的出口语义 = 铺全部方向。
    if (guide && guide.directionKey && guide.companyId) {
      saveOnboardDirection(guide.companyId, guide.directionKey);
    }
  }

  // 已登录：按视图路由。onboarding（首次/添加企业）> companies（我的企业列表）> workbench
  if (view === 'onboarding') {
    return (
      <ConfigProvider
        theme={{
          // 【0.21.25 · 2026-11-08】这 4 个分支（未登录 / 初始化引导 / 我的企业 / 无企业兜底）
          // 原先只给了 `token`、**缺 `algorithm`** ⇒ 深色主题下这几页里的 antd 组件
          // （输入框、弹窗、下拉、日期选择）仍是浅色一套，压在深底上像补丁。
          // 顶层 `:3558` 那一处一直是对的，这里补齐成同一个口径：
          // 绿 / 白照旧 defaultAlgorithm（今天的样子一个像素不变），深色才切 darkAlgorithm，
          // 并把主色抬到与 `--c-brand` 深色值（#3cc47c）一致（沿用 #0E7D59 在深底上会发闷）。
          algorithm: themeNow === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: themeNow === 'dark' ? '#3cc47c' : '#0E7D59',
            borderRadius: 12,
          },
        }}
      >
        <OnboardingV2
          llmDefaults={{ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model }}
          onLLMChange={applyLLMPatch}
          onDone={handleOnboardDone}
        />

        {/* ★ 2026-11-11 补：这个分支原来**没有**激活面板。
            实测根因就是这里 —— 面板只挂在主界面那个 return 里，而首登用户 / 无企业用户
            走的是提前 return，永远到不了。首登用户恰恰是最可能从没激活过的人。 */}
        <LicenseGuardHost />
      </ConfigProvider>
    );
  }

  if (view === 'companies') {
    return (
      <ConfigProvider
        theme={{
          // 【0.21.25 · 2026-11-08】这 4 个分支（未登录 / 初始化引导 / 我的企业 / 无企业兜底）
          // 原先只给了 `token`、**缺 `algorithm`** ⇒ 深色主题下这几页里的 antd 组件
          // （输入框、弹窗、下拉、日期选择）仍是浅色一套，压在深底上像补丁。
          // 顶层 `:3558` 那一处一直是对的，这里补齐成同一个口径：
          // 绿 / 白照旧 defaultAlgorithm（今天的样子一个像素不变），深色才切 darkAlgorithm，
          // 并把主色抬到与 `--c-brand` 深色值（#3cc47c）一致（沿用 #0E7D59 在深底上会发闷）。
          algorithm: themeNow === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: themeNow === 'dark' ? '#3cc47c' : '#0E7D59',
            borderRadius: 12,
          },
        }}
      >
        <CompanyHome
          onSelect={() => setView('workbench')}
          onAdd={() => setView('onboarding')}
          onBack={() => setView('workbench')}
        />

        {/* ★ 2026-11-11 补：这个分支原来**没有**激活面板。
            实测根因就是这里 —— 面板只挂在主界面那个 return 里，而首登用户 / 无企业用户
            走的是提前 return，永远到不了。首登用户恰恰是最可能从没激活过的人。 */}
        <LicenseGuardHost />
      </ConfigProvider>
    );
  }

  // workbench（缺省）：有企业进工作台；无企业兜底进初始化引导
  if (!currentCompany) {
    return (
      <ConfigProvider
        theme={{
          // 【0.21.25 · 2026-11-08】这 4 个分支（未登录 / 初始化引导 / 我的企业 / 无企业兜底）
          // 原先只给了 `token`、**缺 `algorithm`** ⇒ 深色主题下这几页里的 antd 组件
          // （输入框、弹窗、下拉、日期选择）仍是浅色一套，压在深底上像补丁。
          // 顶层 `:3558` 那一处一直是对的，这里补齐成同一个口径：
          // 绿 / 白照旧 defaultAlgorithm（今天的样子一个像素不变），深色才切 darkAlgorithm，
          // 并把主色抬到与 `--c-brand` 深色值（#3cc47c）一致（沿用 #0E7D59 在深底上会发闷）。
          algorithm: themeNow === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: themeNow === 'dark' ? '#3cc47c' : '#0E7D59',
            borderRadius: 12,
          },
        }}
      >
        <OnboardingV2
          llmDefaults={{ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model }}
          onLLMChange={applyLLMPatch}
          onDone={handleOnboardDone}
        />

        {/* ★ 2026-11-11 补：这个分支原来**没有**激活面板。
            实测根因就是这里 —— 面板只挂在主界面那个 return 里，而首登用户 / 无企业用户
            走的是提前 return，永远到不了。首登用户恰恰是最可能从没激活过的人。 */}
        <LicenseGuardHost />
      </ConfigProvider>
    );
  }

  return (
    // 【2026-11-08 · 主题二期】antd 也要跟着主题走，否则深色主题下**设置弹窗本身是一块白板**——
    // 而切换配色的入口恰恰就在那个弹窗里，用户会以为"点了没生效"。
    // 绿 / 白两套照旧用 defaultAlgorithm（= 今天的样子，一个像素都不变）；
    // 深色才切 darkAlgorithm，并把主色抬到与 `--c-brand` 深色值（#3cc47c）一致 ——
    // 直接沿用 #0E7D59 在深底上会发闷、按钮文字对比度也不够。
    // 注：输入框那几条 `style.css:1074-1097` 用的是 `var(--c-surface)` / `var(--text)`，
    // 本身已经会翻转，与这里的 darkAlgorithm 是同一个方向，不会打架。
    <ConfigProvider
      theme={{
        algorithm: themeNow === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: themeNow === 'dark' ? '#3cc47c' : '#0E7D59',
          borderRadius: 10,
        },
      }}
    >
    <AntApp>
    <div className="app">
      {/* ========= 自定义顶栏（居中标题 + 右侧功能 + 最右窗口按钮） ========= */}
      <div className="titlebar">
        <span className="titlebar-title"><span className="titlebar-logo" />豆芽CLAW</span>
        <div className="titlebar-actions">
          {/* 【0.21.10 老板第 2 条】顶栏只留「设置 / 我的企业 / 使用者名字」。
              老板原话：「顶部只保留设置和我的企业 以及使用者名字 别的都删掉」。
              「更多」下拉整个删除，它原先装的四件事各自搬家：
                · 显示思考过程 / 使用指南 / 退出登录 → 设置面板「账号」卡（见 settings-board）
                · 我的企业 → 由右侧 CompanySwitcher 承担（它本来就是切企业的入口）
              ⚠️ 别把下拉加回来：.titlebar-more / .titlebar-more-mask / .titlebar-more-item
                 三个类名**全仓零 CSS 定义**，那个 mask 是 0×0 空 div —— 既盖不住也点不到，
                 点页面空白根本关不掉，只能再点一次「更多」才逃得出去。
             */}
          {authUser && (
            <span className="titlebar-user" title={authUser.username || authUser.name || ''}>
              {authUser.username || authUser.name || ''}
            </span>
          )}
          {/* 【0.21.11 · 老板第 8 条】账号 / 设置 / 反馈 三个小按钮放回顶栏。
              老板原话：「账号和设置客服反馈 放顶部吧。一个小按钮即可 右边的客服反馈可以删掉了」。
              ⚠️ 这是修 0.21.10 留下的**真 bug**：上一版按「顶部只保留设置和我的企业以及使用者名字」
                 删掉了「更多」下拉，却没把设置/账号按钮补回来 —— 全仓 `setShowSettings(true)`
                 只剩 AI 门禁条里那一处，needKey 为假时设置面板**没有任何入口**（老板问「设置哪去了」）。
              三个按钮都走同一条 IPC-free 路径（打开已有的设置弹窗 / 反馈面板），不新增能力。
              data-topbar-* 是给门禁用的锚点：以后再调样式也不会把入口弄丢。 */}
          <button
            type="button"
            className="titlebar-btn"
            data-topbar="account"
            title="账号：当前登录 / 思考过程 / 使用指南 / 退出登录"
            onClick={() => { setSettingsPanel('account'); setShowSettings(true); loadConnectors(); }}
          >
            账号
          </button>
          <button
            type="button"
            className="titlebar-btn"
            data-topbar="settings"
            title="设置：模型 / 商城 / 小程序 / 高级配置 / 我的记忆"
            onClick={() => { setSettingsPanel(null); setShowSettings(true); loadConnectors(); }}
          >
            设置
          </button>
          <button
            type="button"
            className={'titlebar-btn' + (supportOpen ? ' on' : '')}
            data-topbar="feedback"
            title="客服反馈：留言直达豆芽团队"
            onClick={() => setSupportOpen((v) => !v)}
          >
            反馈
          </button>
        </div>
        {/* 窗口控制按钮：Windows 习惯的右上角位置；保留圆角可爱风，符号 − □ × 常显 */}
        <div className="win-controls">
          <button
            className="win-btn win-btn-min"
            onClick={() => window.api && window.api.invoke('win:control', 'minimize')}
            aria-label="最小化"
            title="最小化"
          >
            <span className="win-glyph">−</span>
          </button>
          <button
            className="win-btn win-btn-max"
            onClick={() => window.api && window.api.invoke('win:control', 'toggleMax')}
            aria-label={winMaximized ? '还原' : '最大化'}
            title={winMaximized ? '还原' : '最大化'}
          >
            <span className="win-glyph">{winMaximized ? '❐' : '□'}</span>
          </button>
          <button
            className="win-btn win-btn-close"
            onClick={() => window.api && window.api.invoke('win:control', 'close')}
            aria-label="关闭"
            title="关闭"
          >
            <span className="win-glyph">×</span>
          </button>
        </div>
      </div>

      {/* ========= 软门禁提示条（onboarding-v2 §五）：连不上 AI 可以进、能看能填，但不给派活 =========
          单一判据 needKey = needAiConfig(...)（services/aiReadiness.js 单一事实源，与主进程同源；
          注意**不是**「有没有填 Key」—— 内网网关零配置登录即用也算已连）；不弹模态、不拦路由、不白屏。
          连上后（applyLLMPatch / 设置保存）needKey 立即变假 → 本提示条消失。 */}
      {needKey && (
        <div className="ai-gate-banner">
          <span className="ai-gate-text"> AI 还没连上，豆芽无法识别你的企业、也不会派活</span>
          <button
            type="button"
            className="ai-gate-btn"
            onClick={() => { setShowSettings(true); loadConnectors(); }}
          >
            去连 AI
          </button>
        </div>
      )}

      {/* ========= 主体（侧栏 + 对话） ========= */}
      {showCompanyGuide && (
        <CompanyGuide onClose={() => setShowCompanyGuide(false)} onNavigate={(m) => { setShowCompanyGuide(false); setActiveModule(m); }} />
      )}
      {goal && !guideGoalId && <WorkflowSteps onSelectModule={setActiveModule} activeModule={effectiveModule} />}
      {/* 全局后台任务指示条：豆芽在后台做什么，用户随时看得见、点得到 */}
      <BackgroundJobsBar onSelectModule={setActiveModule} />
      {/* 客服助手：**面板保留、右下角浮动胶囊删除**（0.21.11 · 老板第 8 条
          「右边的客服反馈可以删掉了」）。入口改到顶栏「反馈」小按钮，
          受控开合由 supportOpen 管；hideFab 让组件不再渲染那个压内容的圆形按钮。 */}
      <SupportAssistant open={supportOpen} onOpenChange={setSupportOpen} hideFab />
      <div className="app-body">
        <ModuleNav activeModule={effectiveModule} onSelect={setActiveModule} companyType={companyType} navDots={navDots} />
        {/* T20 起「让豆芽做」走 onAutoRunTask（带任务跳对话页自动开跑）；onRunTask 在本模块已无人引用，已移除（ProjectDetail 侧仍保留）。 */}
        {/* 【2026-10-18 第十六轮】首页与豆芽助手已合并为上方同一个对话框
            （`effectiveModule === 'workbench'` 且分区为 chat 时渲染它，见下方分支条件）。 */}
        {/* 【0.21.21 · 老板 2026-10-21】原「活动与档期」分支（ActivityHub）已删除。
            整板块下线：侧栏卡、看板 / 周视图 / 月历、上游货源档期（miaomiao，内嵌 workbench 页）
            全没了。老存档 / 深链里的 `activity` / `miaomiao` 由 LEGACY_MODULE_ALIAS 兜到
            workbench，**不会**落到一个不存在的分支上（那样主体区会整块白屏）。
            ⚠️ 这里删掉的是**分支**，不是「做活动方案」的能力 —— 那个能力在
            `campaign`（营销专项）分支与经营方案 / 学习中心内嵌的 ActivityChat 里，都还在。 */}
        {effectiveModule === 'daily' && <DailyOps key={currentCompany ? currentCompany.id : 'x'} onSelectModule={setActiveModule} />}
        {effectiveModule === 'learn' && <LearningStation key={currentCompany ? currentCompany.id : 'x'} onSelectModule={setActiveModule} />}
        {/* 门店运营（牙医/诊所专属，老板 2026-10-14 需求 1~6）：
            库存自动补货 / 3 公里周边竞品 / 活动预告（薅羊毛）/ AI 电子病历 /
            公关危机与课程学习的入口。侧栏只对 clinic、doctor 显示（ModuleNav 里按 roles 过滤），
            所以这里直接路由即可，不用再判身份。 */}
        {effectiveModule === 'storeops' && <StoreOps key={currentCompany ? currentCompany.id : 'x'} onSelectModule={setActiveModule} />}
        {/* 采购专区（经销商专属，老板 2026-10-14：批量采购 + 优惠商品）。 */}
        {effectiveModule === 'dealerbuy' && <DealerPurchase key={currentCompany ? currentCompany.id : 'x'} />}
        {/* 【0.21.14 · 需求 3】AI 补货（单独的一级功能，全身份可见）。
            ⚠️ 必须把 geoProxy 传进去：页面要用它当取数层（探针里是空实现，
            不传就会真打本机 api/geo-proxy，backend.js 那条超时 120s）。 */}
        {effectiveModule === 'replenish' && <Replenish key={currentCompany ? currentCompany.id : 'x'} geoProxy={geoProxy} />}
        {effectiveModule === 'project' && <ProjectDetail key={currentCompany ? currentCompany.id : 'x'} onSelectModule={setActiveModule} onRunTask={handleRunTask} />}
        {effectiveModule === 'goal' && (previewGoalId ? (
          <GoalPlanPreview
            key={previewGoalId}
            goalId={previewGoalId}
            goalLabel={previewGoalLabel}
            onBack={() => { setPreviewGoalId(null); setPreviewGoalLabel(''); }}
            onStartGuide={(gid) => setGuideGoalId(gid)}
            onDone={() => { setPreviewGoalId(null); setPreviewGoalLabel(''); setActiveModule('project'); }}
          />
        ) : guideGoalId ? (
          <GoalGuide key={currentCompany ? currentCompany.id : 'x'} goalId={guideGoalId} onExit={exitGuide} onSelectModule={exitGuide} />
        ) : (
          <GoalSelector
            key={currentCompany ? currentCompany.id : 'x'}
            onSelectModule={setActiveModule}
            onStartGuide={setGuideGoalId}
            onPreviewGoal={(gid, label) => { setPreviewGoalId(gid); setPreviewGoalLabel(label || ''); }}
            companyType={companyType}
          />
        ))}
        {effectiveModule === 'asset' && <AssetPanel key={currentCompany ? currentCompany.id : 'x'} />}
        {effectiveModule === 'brain' && <CompanyBrain key={currentCompany ? currentCompany.id : 'x'} />}
        {effectiveModule === 'workbench' && wbTab === 'dev' && (
          /* 第十九轮（老板第 3 条）第 6 点：任务栏点「开发任务」时把定位信息传下去。
             focusNonce 负责「同一条任务点第二次也要生效」（见 devFocus 的注释）。 */
          <DevWorkbench
            tabsSlot={wbTabsSlot}
            focusProjectId={devFocus.projectId}
            focusSessionId={devFocus.sessionId}
            focusNonce={devFocus.nonce}
          />
        )}
        {effectiveModule === 'workbench' && wbTab === 'automation' && (
          <div className="module-page">
            {/* 定时任务页顶部用同一个「对话 / 工作」切换：位置/尺寸与另两种模式完全一致，
                两项都不高亮（它不属于这两者），点任一项就离开本页 —— 不会出现「进来出不去」。 */}
            <div className="scope-switch-wrap">{wbTabsSlot}</div>
            <Automations key={currentCompany ? currentCompany.id : 'x'} />
          </div>
        )}
        {/* 【2026-10-18 第十六轮】首页与豆芽助手合并（老板第 3 条）：
            「首页」不再渲染独立的今日运营页，而是与「豆芽助手」渲染**同一个**豆包式对话框，
            聊天区内部分「对话 / 工作」两个分区。今日运营看板的快捷入口收进聊天空态欢迎区，
            数据看板随左侧导航各模块直达（内容/活动/媒体等页都在）。
            key 带上 companyType ⇒ 身份被纠正后立刻重渲染，不残留上一套入口。 */}
        {/* 2026-10-18 第十六轮：合并后的「豆包式对话框」——「首页」与「豆芽助手」
            共用这一个渲染分支。wbTab 仅对 workbench 入口有意义（dev/automation 子页签）；
            home 入口无条件进对话区。 */}
        {effectiveModule === 'workbench' && wbTab === 'chat' && (
        <>
      {/* ========= 左侧：统一任务栏（第十九轮 · 老板第 3 条）=========
          老板原话：「经营对话 开发工作台 定时任务全部合并成一起 直接从颜色区分
          对话是绿色的 开发是黄色的 一个任务栏 做成现在市面上大模型的那种」。
          旧版这里是「对话记录」抽屉（只装经营对话一种），三个页签挂在它头顶 ——
          现在改成常驻任务栏，一个列表里混排三类任务（绿 / 黄 / 紫），
          顶部那个三页签则换成主区中央的「对话 / 工作」大切换（见下方）。 */}
      <TaskCenter
        open={sessionsOpen}
        items={taskBarItems}
        currentKey={currentTaskKey}
        autoItems={autoItems}
        autoAvailable={autoAvailable}
        onPick={openTaskFromBar}
        onGoAutomation={() => { setWbTab('automation'); setActiveModule('workbench'); }}
        onNewChat={() => { newChat(); }}
        onDeleteTask={deleteTask}
        onDeleteAuto={deleteAutoTask}
      />

      {/* ========= 主对话区 ========= */}
      {/* 2026-10-18 第十六轮：首页与豆芽助手合并后，HomeConsole 不再渲染，
          但身份锚点 data-home-role 是 e2e 身份门禁（unit-identity-e2e A1/C1/C2）的
          唯一读数口 —— 锚点随合并迁移到这里，保证「首页注入身份」仍可被真实验证。
          第十九轮：挂 .wb-apple —— 本轮「Apple 圆润观感」的全部样式都以它为作用域祖先，
          保证只影响聊天页、别的模块一个像素不动。 */}
      <div className="main wb-apple" data-home-role={companyType}>
        {/* 第八轮（2026-10-14）：页头只在空态出现，且只剩下名字。
            ①旧版这里挂了 5 个「模式按钮」（智能对话/方案生成/数据分析/知识问答/任务协助），
              用户反馈「上面搞了一堆分类，不如直接放聊天框上面」⇒ 模式切换整块拿掉，
              能力不减（模式只换 placeholder 与快捷指令，不碰对话引擎）。
            ②旧版还带一句角色介绍副标题，属于自说自话的次要信息 ⇒ 一并删。
            ③有对话时页头完全不占地方 —— 主视线只留给「对话内容 + 输入框」这两件事。 */}
        {/* 第十九轮（老板第 3 条）：整条 PageBanner（「豆芽助手」+ 副标题 + slogan）已删除 ——
            老板原话「页面里面删除哪些字 什么豆芽AI怎么用 遇到问题怎么办全部删除」。
            组件文件保留（回滚资产），只是本页不再渲染。 */}

        {/* 2026-10-18 第十六轮：聊天区分区（对话 / 工作）—— 老板第 3 条「跟豆包一样在聊天区
            区分对话和工作」。work 分区的 agent 任务会跑双 AI 自检 + 复检 + 对话汇报
            （后端 runAgentLoop 收尾处，见 backend.js / agentReview.js）。
            第十九轮（老板第 3 条）：三个小页签 + 那行说明文字全删，只留**一个**大号居中切换。
            它切的是 wbTab（对话=经营对话 / 工作=开发工作台），
            `data-scope-tab` 两个锚点原样保留（验收脚本按它定位）。
            说明：聊天内「工作分区」（chatScope='work'，走后端双 AI 自检）仍然保留，
            只是不再占用这个头条开关 —— 从任务栏点开一条 scope=work 的历史会话时，
            分区会自动拨回去（见 openTaskFromBar）。 */}
        <div className="scope-switch-wrap" data-chat-scope={chatScope}>
          {wbTabsSlot}
        </div>
        {/* 断线续跑提示：刷新/断网后任务仍在后台跑，一键接回并补播已发生的过程 */}
        {activeTask && !busy && (
          <div className="chat-resume-bar" data-chat-resume={activeTask.taskId}>
            <span className="chat-resume-dot" />
            <span className="chat-resume-txt">
              有个任务还在后台跑{activeTask.goal ? '：' + activeTask.goal : ''}
            </span>
            <span className="chat-resume-hint">刷新或断网都不会打断它</span>
            <button className="chat-resume-btn" onClick={() => resumeInto(activeTask)}>接回来</button>
            <button className="chat-resume-x" title="先不接" onClick={() => setActiveTask(null)}>×</button>
          </div>
        )}
        {/* 右上角次要开关（0.21.11 · 老板第 7 条）。
            老板原话：「豆芽助手里面任务栏常在 不要隐藏掉，历史成果换个UI根据任务栏来 简单干净点 现在有点乱」。
            ⇒ 这里原来有两个按钮（对话记录 / 历史成果）：
              · 「对话记录」**删除** —— 任务栏从本轮起常驻，没有"收起来"这个动作了；
              · 「历史成果」保留 —— 它是右栏的唯一开关，不属于任务栏。
            sessionsOpen 这个 state 仍然保留（默认 true），TaskCenter 的 open 契约不变；
            只是**没有任何入口能把它置 false**，这正是「常在」的实现方式：
            不是把默认值改大，而是把"能关掉它"的按钮删掉。 */}
        <div className="main-toggles">
          <button
            className={'toggle-btn' + (rightPanelOpen ? ' open' : '')}
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
            title={rightPanelOpen ? '收起历史成果栏' : '展开历史成果栏'}
          >
            历史成果
          </button>
        </div>

        <div className="chat" ref={scrollRef} onDrop={handleDropFiles} onDragOver={onDragOver}>
          {messages.length === 0 && (
            <div className="welcome welcome-min">
              {/* 第十九轮（老板第 3 条）：「空态只保留一个极简欢迎语」。
                  已删掉两整块说明性内容（组件文件都留着，属回滚资产）：
                    · 能力胶囊行（WELCOME_CAPS：智能问答/方案生成/数据分析/知识检索/任务协助）
                    · 示例问答气泡（WELCOME_DEMO：一条假问题 + 一条假回答）
                  保留下来的只有「一行欢迎语」+ 原来的模块快捷入口
                  （WELCOME_QUICK：那是能直达真实页面的导航，不是说明文案，
                   老板要删的是「哪些字」，不是「哪些功能」）。 */}
              <span className="welcome-min-dot" aria-hidden="true" />
              <div className="welcome-min-text">说一句，就开始</div>
              <div className="welcome-quick-row" data-welcome-quick="1">
                {WELCOME_QUICK.map((q) => (
                  <span
                    key={q.k}
                    className="welcome-quick"
                    role="link"
                    tabIndex={0}
                    data-welcome-quick={q.k}
                    onClick={() => handleSelectModule(q.k)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectModule(q.k); } }}
                  >
                    {q.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 第十九轮（老板第 3 条）：「什么豆芽AI怎么用 / 遇到问题怎么办全部删除」。
              这里原本常驻一整块 DouyaUsageGuide（三步上手 + 能问什么 + 结果落哪 + 遇到问题）。
              老板点名删的就是它 —— 只取消本页**渲染**，组件文件与它的单测基线一行没动。
              要恢复：把 guide（DouyaUsageGuide）重新挂回这里，props 传
              onPickSample = needKey || busy 时为 undefined 的 send（旧注释里那条守卫不能丢）。
              标题栏那个「使用指南」弹窗仍然在（那是用户主动点的入口，不是页面上的字）。
              ⚠️ 本注释刻意不写出那段 JSX 的字面量：scripts/smoke/unit-usage-pick.mjs 是按
              「源码里出现几处该组件」来判的，写出字面量会让它**假绿**。 */}

          {displayMessages.map((m, i) => (
            <React.Fragment key={i}>
              {m.__group === 'tools' && (
                <ToolGroup
                  tools={m.tools}
                  resultLabel={(i === lastToolsIndex && wfPhase.phase === 'done') ? wfPhase.label : ''}
                  unresolved={(i === lastToolsIndex && wfPhase.phase === 'done') ? wfPhase.unresolved : null}
                  state={(i === lastToolsIndex && wfPhase.phase === 'done') ? wfPhase.state : null}
                />
              )}
              {/* 【第二十三轮】系统小字：挂起超时 / 被跳过这类「发生了什么」的交代。
                  刻意不做成 assistant 气泡 —— 它不是豆芽说的话，也不是用户说的话；
                  用一个居中的灰色小行，读得到、抢不到注意力，且 data-msg-notice="1"
                  让门禁能断言「超时后界面上确实出现了一句交代」。 */}
              {m.role === 'notice' && (
                <div className="msg-notice" data-msg-notice="1">{m.content}</div>
              )}
              {/* 【2026-11-03】闸门清单：本次任务里「需要你在场才能做、所以没执行」的步骤。
                  默认收起的折叠条 —— 一行说清有几处没做，点开才看明细。
                  刻意不用按钮（首屏按钮棘轮会红），也不写任何"无人值守"之类内部术语：
                  用户只需要知道**哪一步没做**、**为什么**。
                  组件抽进 ReviewGroup.jsx 是为了能被 SSR 断言（scripts/smoke/unit-chat-verdict.mjs F 段）：
                  这里的 total（几件事没做）与 blocked（被拦次数之和）不是一回事，写反了就是对用户说假话。 */}
              {m.role === 'gate_report' && (
                <GateReport total={m.total} blocked={m.blocked} items={m.items} />
              )}
              {/* 【2026-11-09】待批队列：无人值守 / QUEUE 档里"没敢擅自做"的清单。
                  与上面那条**分开渲染**：上面是"没做"（损失），这里是"等你点头"（待办）。
                  用户睡一觉回来，最该看到的是这条。 */}
              {m.role === 'pending_actions' && (
                <PendingActions total={m.total} items={m.items} />
              )}
              {m.role === 'deliverable' && (
                <div className="msg-deliverable">
                  <div className="deliverable-title"> 本次成果已生成</div>
                  <div className="deliverable-ws">工作区：{m.workspace}</div>
                  <ul className="deliverable-list">
                    {filterDeliverables(m.items).slice(0, 2).map((it, k) => (
                      <li key={k}>
                        <div className="deliverable-row">
                          <div className="deliverable-row-info">
                            <span className="deliverable-name">{it.name}</span>
                            <span className="deliverable-path">{it.path}</span>
                          </div>
                          <div className="deliverable-actions">
                            <button
                              className="deliverable-btn"
                              onClick={() => openDeliverable(it.path)}
                              title="用默认程序打开/预览这个文件"
                            >
                              打开
                            </button>
                            <button
                              className="deliverable-btn ghost"
                              onClick={() => showDeliverableInFolder(it.path)}
                              title="在资源管理器里定位到这个文件"
                            >
                              定位
                            </button>
                            <button
                              className="deliverable-btn ghost"
                              onClick={() => continueEdit(it)}
                              title="把这个文件加入附件并预填修改需求"
                            >
                              继续改
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {filterDeliverables(m.items).length > 2 && (
                    <details className="deliverable-more">
                      <summary>还有 {filterDeliverables(m.items).length - 2} 个文件</summary>
                      <ul className="deliverable-list">
                        {filterDeliverables(m.items).slice(2).map((it, k) => (
                          <li key={k}>
                            <div className="deliverable-row">
                              <div className="deliverable-row-info">
                                <span className="deliverable-name">{it.name}</span>
                                <span className="deliverable-path">{it.path}</span>
                              </div>
                              <div className="deliverable-actions">
                                <button
                                  className="deliverable-btn"
                                  onClick={() => openDeliverable(it.path)}
                                  title="用默认程序打开/预览这个文件"
                                >
                                  打开
                                </button>
                                <button
                                  className="deliverable-btn ghost"
                                  onClick={() => showDeliverableInFolder(it.path)}
                                  title="在资源管理器里定位到这个文件"
                                >
                                  定位
                                </button>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="deliverable-footer">
                    <button className="deliverable-btn ws" onClick={() => openWorkspace(m.workspace)}>
                      打开工作区文件夹
                    </button>
                    <span className="deliverable-hint">点「打开」直接预览，点「定位」跳转到文件所在位置</span>
                  </div>
                </div>
              )}
              {/* 【2026-11-03】自查/复检：多轮聚合成**一条默认收起的折叠条**。
                  改前每轮各渲染一张全展开的卡（missing 列表全量铺开），一次任务的对话
                  顺序是 [用户] → [正文] → [自查×4] → [复检×1] ⇒ 用户滚到底看到的是
                  最后一张自查卡，不知道结论。现在 summary 一行说清「几轮 / 还差几项 /
                  复检有无意见」，明细点开才看。组件见 components/ReviewGroup.jsx。 */}
              {m.__group === 'review' && (
                <ReviewGroup rounds={m.rounds} />
              )}
              {(m.role === 'user' || m.role === 'assistant') && (
                <div className={'msg ' + m.role}>
                  {m.role === 'assistant' ? (
                    <div className="msg-asst-col">
                      {m.content && (
                        <div className="msg-bubble">
                          <Markdown>{m.content}</Markdown>
                        </div>
                      )}
                      {/* 【第二十二轮 · 老板第 5 条 a】失败卡：说清「失败了 + 哪一类 + 为什么 + 下一步」，
                          并给「重试」。改前失败只是正文里一句「请求失败：xxx」，没有失败语义、没有退路，
                          和老板说的「文案告诉你停止了」是同一类毛病。
                          半截正文（m.content）照旧留在上面 —— 已经流出来的内容不丢。 */}
                      {m.failed ? (
                        <div className="msg-fail" data-chat-failure={m.failureKind || 'unknown'}>
                          <div className="msg-fail-head">
                            <span aria-hidden="true">⚠️</span>
                            <span>这次没做成</span>
                            <span className="msg-fail-kind">{m.failureHeadline || '失败'}</span>
                          </div>
                          {m.failureText ? <div className="msg-fail-reason">{m.failureText}</div> : null}
                          {m.failureNext ? <div className="msg-fail-next">{m.failureNext}</div> : null}
                          <div className="msg-fail-ops">
                            {(() => {
                              const ask = prevUserText(displayMessages, i);
                              return ask ? (
                                <Button
                                  size="small"
                                  type="primary"
                                  disabled={busy}
                                  onClick={() => send(ask)}
                                >
                                  重试
                                </Button>
                              ) : null;
                            })()}
                          </div>
                        </div>
                      ) : null}
                      {m.reasoning && showThinking && (
                        /* 默认折叠（2026-09-17 修）：原来写成 open={busy || liveThinking}，
                           于是**任务进行中会自动展开**思考全文。而 DeepSeek 的 reasoning_content
                           经常是英文、且动辄几千字 ⇒ 用户看到的就是满屏英文字符不停往下滚。
                           用户原话：「他会发很多字符 很多英文」—— 这里正是主因。
                           改为默认折叠：实时进度仍由 summary 文案提示（「 正在深度思考…（实时）」），
                           想看全文点一下即可，不再自动铺满屏幕。
                           注：open={false} 只在首次挂载时生效；用户手动展开后，React 因 prop
                           未变化不会回写，展开状态得以保留。 */
                        <details className="reasoning-block" open={false}>
                          <summary>
                            {busy || liveThinking ? ' 正在深度思考…（实时）' : ' 思考过程'}
                          </summary>
                          <pre className="reasoning-content">{m.reasoning}</pre>
                        </details>
                      )}
                    </div>
                  ) : (
                    <div className="msg-user-col">
                      {m.content && (
                        <div className="msg-bubble">
                          <Markdown>{m.content}</Markdown>
                        </div>
                      )}
                      {m.attachments && m.attachments.length > 0 && (
                        <div className="msg-attach-list">
                          {m.attachments.map((a, k) => (
                            <span className="msg-attach" key={k}>
                              <AttachThumb path={a.path} size={640} className="msg-attach-thumb" />
                              {a.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))}

          {/* 【2026-11-03】收尾结论块：任务结束后，对话**末尾**要有一句"这事到底做完了没有"。
              改前终态只有一枚芯片，挂在「最后一组工具」上 —— 那组常常在上百行之前
              （老板原话「最后没完成啥也不知道」）。这里只用后端状态机的三档判决说人话，
              不出现工具名 / 英文字段名；没有终态时退回后端给的中文 label。
              ⚠️ 必须**同会话**才渲染（wfPhase.sid === 当前会话）：wfPhase 是全局状态，
                 切到另一条历史对话时它不会被清空，不判 sid 就会把上一个任务的结论
                 挂在无关对话末尾 —— 那是一句假话。
              data-chat-verdict 供 scripts/smoke/unit-chat-verdict.mjs 定位。 */}
          {wfPhase.phase === 'done' && wfPhase.sid === sessions.currentId && (
            <ChatVerdict
              state={wfPhase.state}
              unresolved={wfPhase.unresolved}
              label={wfPhase.label}
            />
          )}

          {/* 需求澄清：对话内联提问气泡（替代原 Modal 弹窗） */}
          {wfClarify && (
            <div className="msg-clarify">
              <div className="clarify-bubble-head"> 我想先确认几件事</div>
              <div className="clarify-context">
                {wfClarify.context
                  ? wfClarify.context + ' —— 选一下，或直接在下方输入框回复：'
                  : '动手前先对齐一下需求，选一下，或直接在下方输入框回复：'}
              </div>
              <div className="clarify-questions">
                {(wfClarify.questions && wfClarify.questions.length)
                  ? wfClarify.questions.map((qq, i) => {
                      if (typeof qq === 'string') {
                        return (
                          <div className="clarify-q" key={i}>
                            <div className="clarify-q-text">{i + 1}. {qq}</div>
                            <Input.TextArea
                              value={clarifyInput}
                              onChange={(e) => setClarifyInput(e.target.value)}
                              rows={2}
                              placeholder="在这里补充你的想法…"
                            />
                          </div>
                        );
                      }
                      const opts = Array.isArray(qq.options) ? qq.options : [];
                      return (
                        <div className="clarify-q" key={i}>
                          <div className="clarify-q-text">{i + 1}. {qq.q}</div>
                          <div className="clarify-opts">
                            {opts.map((o, k) => (
                              <button
                                key={k}
                                type="button"
                                className={'opt-chip' + (clarifySel[i] === o ? ' selected' : '')}
                                onClick={() => {
                                  const n = clarifySel.slice();
                                  n[i] = o;
                                  setClarifySel(n);
                                }}
                              >
                                {o}
                              </button>
                            ))}
                          </div>
                          {qq.allowFree && (
                            <Input
                              value={clarifyInput}
                              onChange={(e) => setClarifyInput(e.target.value)}
                              placeholder="或者你自己说…"
                              style={{ marginTop: 6 }}
                            />
                          )}
                        </div>
                      );
                    })
                  : <div className="clarify-q">请告诉我你对这个任务的期望（目标 / 范围 / 偏好）。</div>}
              </div>
              <div className="clarify-actions">
                <Button size="small" type="primary" onClick={() => postClarify(buildClarifyAnswer())}>确认</Button>
                {/* 【第二十三轮】「跳过」这个词本身没说清后果 —— 用户以为是「这事不做了」，
                    实际是「按你的最佳判断直接做」。按钮文字保持「跳过」（老板认这个词），
                    把语义补在 title 和下方那行 hint 里，不新增视觉噪音。
                    ⚠️ payload 仍是 {id, answer: ''}，后端正按「空串 = 跳过」处理，不要改结构。 */}
                <Button
                  size="small"
                  onClick={() => postClarify('')}
                  title="跳过 = 不再问细节，直接按最佳判断做"
                >
                  跳过
                </Button>
                <span className="clarify-hint">也可以直接在下方输入框回复；点「跳过」我就按最佳判断先做。</span>
              </div>
            </div>
          )}

          {/* 【第二十二轮 · 老板第 5 条 c】生成中要**显眼**。
              改前这里是一行灰色「正在处理…」+ 一个小 spinner，输入框 placeholder 才变「生成中…」，
              用户视线在对话区根本扫不到（老板原话「对话框的生成中不明显 改的显眼点」）。
              现在换成 ChatGenerating：三点跳动 + 文字「生成中」+「已等 N 秒」，
              并带 data-chat-generating / data-pending 两个锚点供门禁正控反控。
              条件保持不变（最后一条是工具组时由工具芯片自己显示"进行中"，不双显）。

              【第二十三轮】加一层分流：wfClarify / wfMaterial 非空时**不许**再显示「生成中」。
              原因见 WAIT_CLARIFY_TEXT 上方的注释 —— 后端在等用户，最长等 5 分钟，
              而旧界面把这段等待说成「豆芽正在想」，用户自然以为它卡了/在瞎算。
              ⚠️ 刻意**不**复用 ChatGenerating：它的「已等 N 秒」在这里只会放大焦虑
                 （用户会盯着秒表走到 5 分钟），而且它的 aria-label / data-pending 语义
                 都是「生成中」，复用它等于把错误说法换个字号继续说一遍。
                 所以这里换成一个朴素气泡 + 独立锚点 data-chat-waiting="1"。 */}
          {thinking &&
            messages.length > 0 &&
            messages[messages.length - 1]?.role !== 'tool_call' && (
              (wfClarify || wfMaterial || wfPlanAck) ? (
                <div className="msg assistant">
                  <div
                    className="chat-wait"
                    data-chat-waiting="1"
                    role="status"
                    aria-live="polite"
                    aria-label={wfClarify ? WAIT_CLARIFY_TEXT : (wfPlanAck ? WAIT_PLAN_TEXT : WAIT_MATERIAL_TEXT)}
                  >
                    <span className="chat-wait-title" data-chat-wait-title="1">
                      {wfClarify ? WAIT_CLARIFY_TEXT : (wfPlanAck ? WAIT_PLAN_TEXT : WAIT_MATERIAL_TEXT)}
                    </span>
                    <span className="chat-wait-hint">{WAIT_HINT_TEXT}</span>
                  </div>
                </div>
              ) : (
                <div className="msg assistant">
                  <ChatGenerating text="生成中，豆芽正在想…" />
                </div>
              )
            )}
          {/* 【第二十二轮 · 老板第 4 条】回顶部 / 回最新（未读角标）。
              作为 `.chat` 的最后一个子节点：sticky 贴在滚动容器可视底边，不占内容高度。
              `revision` 带上"最后一条正文长度"——流式输出时条数不变但内容在长，
              只靠条数判断会让"贴底"停住。 */}
          <ScrollNav
            scrollerRef={scrollRef}
            count={messages.length}
            revision={
              messages.length
              + String((messages[messages.length - 1] && messages[messages.length - 1].content) || '').length
              + (thinking ? 1 : 0)
            }
            topLabel="回到最上面"
            latestLabel="回到最新"
          />
        </div>


        {attachments.length > 0 && (
          <div className="attach-bar">
            {attachments.map((a, k) => (
              <span className="attach-chip" key={a.path + k}>
                <AttachThumb path={a.path} size={320} />
                {a.name}
                <button
                  className="attach-del"
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== k))}
                  title="移除"
                >
                  ×
                </button>
              </span>
            ))}
            <span className="attach-hint">发送时会一并读取这些文件给豆芽</span>
          </div>
        )}

        <div className="inputbar">
          <button
            className="attach-btn"
            onClick={pickFiles}
            disabled={busy}
            title="上传/选择本地文件（也可直接拖文件进窗口）"
          >
            <LineIcon name="upload" size={18} variant="plain" />
          </button>
          <Input.TextArea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            data-home-ask="input"
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              busy
                ? '生成中…'
                : needKey
                  ? '请先点击右上角「设置」配置 API Key'
                  : CHAT_ASSIST.ph + '（Enter 发送 / Shift+Enter 换行）'
            }
            disabled={busy && !listening && !wfClarify}
            autoSize={{ minRows: 1, maxRows: 5 }}
            onDrop={handleDropFiles}
            onDragOver={onDragOver}
          />
          {canStop && (
            <Button danger onClick={stopTask} title="停止这次任务（已完成的成果会保留，可立刻改口接着说）">
              停止
            </Button>
          )}
          {/* 这里必须用无参箭头包裹 send —— 不许把函数**直接**挂给 onClick。
              原因：React 会把**合成事件对象**当成第一个实参传给处理器，而 send(voiceText) 第一行
              就是 `(voiceText || input).trim()` ⇒ 事件对象（真值）没有 trim ⇒ 抛
              `TypeError: (voiceText || input).trim is not a function`，且中断发生在 setSessions
              之前 ⇒ 用户看到的是「点了发送完全没反应」（2026-09-20 修）。
              上面 onPressEnter 一直是无参调用 `send()`，所以回车正常、按钮失灵 —— 现象很反直觉。
              回归护栏：scripts/verify/chat-send-verify.mjs（静态闸门 + 变异反控 + 真浏览器点击）。
              本注释刻意**不写出那个坏写法的字面量**，否则会污染静态闸门与 grep 判据。 */}
          <Button
            type="primary"
            onClick={() => send()}
            disabled={(busy && !listening && !wfClarify) || needKey}
            title={needKey ? '还没连上 AI，先点上方黄色提示条的「去连 AI」' : undefined}
            data-home-ask="submit"
          >
            发送
          </Button>
        </div>
      </div>

      {/* ========= 右侧：历史成果面板 =========
          【0.21.11 · 老板第 7 条】整块抽成 components/HistoryPanel.jsx，并按**任务栏的行语言**重做。
          老板原话：「历史成果换个UI根据任务栏来 简单干净点 现在有点乱」。

          改前（内联在这里的一坨，一条成果占 3 行）：名字 / 一整条绝对路径 / 三个等宽按钮，
          外加「常用能力」是图标 + 双行卡片 —— 两条成果就占满一屏。
          改后（与 TaskCenter 同构，一条成果占 1 行）：圆点（类型色）+ 文件名（单行省略）+ 类型标签，
          点整行 = 打开，指针移上去才出现「定位 / 继续改」，绝对路径退到 title。

          为什么抽成组件：内联 JSX 没法单独渲染 ⇒ 这块 UI 只能靠肉眼验。
          抽出来以后 scripts/smoke/unit-assistant-panel.mjs 能对它做真实点击断言
          （点整行打开 / 点「定位」不触发打开 / 三种类型的圆点与标签对得上）。 */}
      <HistoryPanel
        open={rightPanelOpen}
        items={histDels}
        tasks={railTasks}
        onClose={() => setRightPanelOpen(false)}
        onOpen={(p) => openDeliverable(p)}
        onLocate={(p) => showDeliverableInFolder(p)}
        onContinueEdit={(d) => continueEdit(d)}
        onSelectModule={(k) => setActiveModule(k)}
      />
        </> )}
        {effectiveModule === 'xinmeiti' && <NewMediaWorkbench key={currentCompany ? currentCompany.id : 'x'} geoProxy={geoProxy} onSelectModule={setActiveModule} />}
        {effectiveModule === 'media' && <MediaPublish key={currentCompany ? currentCompany.id : 'x'} geoProxy={geoProxy} />}
        {/* 【0.21.21 · 老板 2026-10-21】旧版「活动策划」分支（ActivityPlanning，key `huodong`）已删除。
            深链 `huodong` 由 LEGACY_MODULE_ALIAS 归一到 `campaign` ⇒ 落到下面这个
            营销专项分支，页面换了、能力没丢（这就是老板要保留的「做活动方案」）。
            ⚠️ `initialBrief` / `onIntentConsumed` 这两个 prop 必须由 campaign 分支接住 ——
            `huodong` 归位后 `routeIntent.kind === 'confirm_brief'` 会全部流到这里，
            漏接就等于「首登建档后豆芽自动铺的方案丢了」。 */}
        {effectiveModule === 'campaign' && (
          <CampaignModule
            key={currentCompany ? currentCompany.id : 'x'}
            onSelectModule={handleSelectModule}
            initialActivityId={routeIntent && routeIntent.kind === 'adjust' ? routeIntent.campaignId : null}
            initialBrief={routeIntent && routeIntent.kind === 'confirm_brief' ? { title: routeIntent.briefTitle, reason: routeIntent.briefReason, source: routeIntent.source, sourceChangeId: routeIntent.sourceChangeId } : null}
            onIntentConsumed={() => setRouteIntent(null)}
          />
        )}
        {/* T19 修复（T21 阻断级）：「去执行 →」会回传 { module, intent } 对象，必须接 handleSelectModule
            （兼容字符串与对象两形式，并把 intent 交给目标模块消费）。此前误接裸 setActiveModule，
            对象被直接塞进 activeModule → 所有 effectiveModule === 'xxx' 全不命中 → 主体区白屏。 */}
        {effectiveModule === 'direction' && <DirectionModule key={currentCompany ? currentCompany.id : 'x'} onSelectModule={handleSelectModule} />}
        {effectiveModule === 'crisis' && <PrCrisis key={currentCompany ? currentCompany.id : 'x'} geoProxy={geoProxy} onSelectModule={setActiveModule} />}
        {/* 竞品对比的独立渲染已下线（老板反馈 #7：竞品对比 / GEO / SEO 曝光对比
            只允许在「经营诊断」出现）。**改注释前先核对事实**（2026-10-21 核）：
              · 导航「竞品分析」(`k: 'intel'`) 渲染的是 `modules/MarketMomentum.jsx`（见本文件
                下方 `effectiveModule === 'intel'` 那行）；
              · `modules/CompetitorAnalysis.jsx`（那份维度矩阵）**当前没有任何挂载点** ——
                `MarketMomentum` 里 `CompetitorAnalysis` 出现 0 次，唯一引用它的是
                `modules/MarketIntel.jsx`，而 MarketIntel 本身也没被 App 挂载。
            旧注释写的「由 MarketMomentum 内嵌 CompetitorAnalysis 渲染（MarketMomentum.jsx:416）」是
            **过期描述**，曾把下一个人引到错误文件上，故按事实改写。
            旧 key 由 LEGACY_MODULE_ALIAS 重定向到 intel。 */}

        {/* ===== 合并后的容器入口 ===== */}
        {/* 【0.21.25 · 2026-11-02】思维导图：紧接在「内容创作」之前，动线是「先理清结构 → 再写内容」。
            ⚠️ 这一条是 `unit-module-registry.mjs` R2 的命门 —— 侧栏有 mindmap 而这里没有分支，
               用户点进去主体区一片空白。写法必须保持 `effectiveModule === 'mindmap'` **单引号**，
               该门禁用 `/effectiveModule\s*===\s*'([a-z][a-z0-9]*)'/g` 抽表，
               改成双引号它就抽不到，然后整条 R2 在空集合上假绿。
            不传 key={companyId}：导图是本机草稿，不随企业切换（理由见文件顶部 import 处注释）。 */}
        {effectiveModule === 'mindmap' && <MindMap />}
        {effectiveModule === 'content' && <ContentOps key={currentCompany ? currentCompany.id : 'x'} geoProxy={geoProxy} onSelectModule={setActiveModule} />}
        {/* 【0.21.20 · 老板 2026-10-21】视频设计：紧接「内容创作」，动线是「写完内容接着出视频/配图」。
            这一页**不需要 geoProxy** —— 它一次外网请求都不发，全部经主进程 IPC
            （`window.api.wanx*`）走 `wanxProvider.js`，符合本仓「渲染层绝不直连外网」铁律。 */}
        {/* 【0.21.22】onOpenSettings：视频设计页已经没有 key 输入框了，
            没配 key 时那一页只剩下「去设置里配置」——这个回调就是它的唯一落点，
            必须**直接落到 videodesign 二级页**，不能让用户自己在一级卡里再找一遍。 */}
        {effectiveModule === 'videodesign' && (
          <VideoDesign
            key={currentCompany ? currentCompany.id : 'x'}
            companyId={currentCompany ? String(currentCompany.id) : 'x'}
            onOpenSettings={() => { setSettingsPanel('videodesign'); setShowSettings(true); }}
          />
        )}
        {/* 【0.21.26 · 老板 2026-11-09】视频精剪：紧接「视频设计」，动线是「AI 出素材 → 剪辑成片」。
            ⚠️ 这一条同样是 `unit-module-registry.mjs` R2 的命门 —— 侧栏有 videostudio
               而这里没有分支，用户点进去主体区一片空白。写法必须保持
               `effectiveModule === 'videostudio'` **单引号**（该门禁用
               `/effectiveModule\s*===\s*'([a-z][a-z0-9]*)'/g` 抽表）。
            这一页**只需要本机 IPC**（`window.api.concat*`），不发任何外网请求，
            所以和「视频设计」不同：它不接 geoProxy，也不接 onOpenSettings。
            不传 key={companyId}：Concat 工程是**本机**的，不随企业切换
            （与思维导图同一策略：本机草稿不挂企业维度）。 */}
        {effectiveModule === 'videostudio' && <VideoStudio />}
        {effectiveModule === 'profile' && <CompanyProfile key={currentCompany ? currentCompany.id : 'x'} initialTab={profileTab} />}
        {effectiveModule === 'newmedia' && <NewMediaCenter key={currentCompany ? currentCompany.id : 'x'} geoProxy={geoProxy} onSelectModule={setActiveModule} />}
        {effectiveModule === 'intel' && <MarketMomentum key={currentCompany ? currentCompany.id : 'x'} geoProxy={geoProxy} onSelectModule={handleSelectModule} />}
        {/* 【0.21.21 · 老板 2026-10-21】上游货源档期分支（MiaomiaoSchedule，key `miaomiao`）已删除。
            它原本是 iframe 内嵌 api.example.com 的档期页（免登由主进程往 api.example.com/api/*
            注入 Authorization 头实现）。档期页在 workbench 侧同步下线（老板原话「那个页也下线」），
            外壳留着就是个指向 404 的容器，故连外壳一起删。深链 `miaomiao` 归一到 workbench。
            ⚠️ 既然这页没了，`main.js` 里只服务它的两条基础设施也一并删除，别单独挂回来：
               · `mmclaw:schedule-tab` IPC（往子 frame 里执行 switchTab）
               · `setupMmclawAuthInjection()`（webRequest 注入登录态）
            客服助手的反馈转发走的是**主进程 fetch**（不经过 session webRequest），不受影响。 */}

      {/* GEO 独立渲染已下线（老板反馈 #7）。**事实核对（2026-10-21）**：旧注释说「GEO 曝光明细
          现由经营诊断的 GEO 维度卡内嵌 `<GeoDiagnose embedded />` 渲染」——与代码不符，
          `MarketMomentum.jsx` 里 `GeoDiagnose` 出现 0 次，全仓也没有第二处挂载点
          （`components/GeoDiagnose.jsx` 目前是**未挂载**的组件）。
          即：GEO 曝光这一块当前没有 UI 入口，需要时再单独接线，别照旧注释去找。 */}

      {/* ========= 本页智能助手（右侧 rail；workbench 独立块不装） =========
          第十一轮（2026-10-14）：**整体停挂**（老板选定「只保留内嵌右栏」）。
          原因：老板参考图是「左大区 / 中工作区 / 右参考区」三栏，恢复内嵌右栏后，
          本页再挂这条 280px 的全局助手栏就变成**两条助手并排**、内容还重复
          （内嵌的「创作助手/风格/资料」与全局的「豆芽助手」都是问一句生成）。
          现在每个页面的右栏 = 该页专属参考区：
            home  → 豆芽助手（问候 + 示例问法 + 输入框）
            content → 创作助手 / 内容风格 / 备用资料
            ~~activity → 热门模板 / 资源库 / 策划建议~~（0.21.21 整板块下线，该右栏已无宿主）
            intel → AI 竞品洞察 / 机会点 / 相关竞品
          ModuleAssistant 组件源码**一个字未动**（「不留存/ 无跨模块会话」红线保持），
          将来要换回全局栏，只需把下面这行常量改成 true 即可（组件内部不动）。 */}
      {SHOW_GLOBAL_ASSISTANT && effectiveModule !== 'workbench' && (
        <ModuleAssistant
          key={effectiveModule}
          moduleKey={effectiveModule}
          moduleLabel={MODULE_LABELS[effectiveModule] || '工作台'}
          companyType={companyType}
          company={currentCompany}
          companyId={currentCompany ? currentCompany.id : ''}
          onSelectModule={handleSelectModule}
        />
      )}
      </div>{/* /app-body */}

      {/* ========= 素材索要弹窗 ========= */}
      {/* 【第二十三轮】「跳过」补语义：旧界面只有一个「跳过」按钮，用户不知道点了会怎样
          （其实是「不给素材，按最佳判断先做」）。补一句小字 + 按钮 title，不加额外控件。
          ⚠️ onCancel 仍走 postMaterial('')，请求体仍是 {id, content} —— 后端正按空串语义改，不许动结构。 */}
      <Modal
        title="需要素材"
        open={!!wfMaterial}
        onOk={() => postMaterial(matInput)}
        onCancel={() => postMaterial('')}
        okText="提交"
        cancelText="跳过"
        cancelButtonProps={{ title: '跳过 = 不给素材，直接按最佳判断做' }}
        width={480}
      >
        <p className="confirm-prompt">{wfMaterial && wfMaterial.prompt}</p>
        <Input.TextArea
          value={matInput}
          onChange={(e) => setMatInput(e.target.value)}
          rows={5}
          placeholder="粘贴或描述素材内容（图片可贴路径/链接，数据可贴文本）…"
        />
        <div className="material-skip-hint">不填也能继续：点「跳过」我就按最佳判断先做。</div>
      </Modal>

      {/* ========= 计划确认弹窗（plan_gate，2026-11-09）========= */}
      {/* 只在后端判成 CONFIRM 档（不可逆 / 多步 / 有歧义）时才出现。
          普通小改动后端直接放行、这里永不弹 —— 保住用户要的"别老弹窗"。 */}
      <Modal
        title="先跟你对一下计划"
        open={!!wfPlanAck}
        onOk={() => resolvePlanAck('ok')}
        onCancel={() => resolvePlanAck('no')}
        okText="按这个做"
        cancelText="改一下"
        cancelButtonProps={{ title: '改一下 = 先别动手，让他先问你想要怎么改' }}
        width={520}
      >
        <p className="confirm-prompt">
          这件事会改动环境，做错不好回退，所以先摆出来给你看：
        </p>
        <ol className="pgate-steps">
          {((wfPlanAck && wfPlanAck.steps) || []).map((s, k) => <li key={k}>{s}</li>)}
        </ol>
        {wfPlanAck && wfPlanAck.reasons && wfPlanAck.reasons.length ? (
          <div className="pgate-why">
            为什么问你：{wfPlanAck.reasons.join('；')}
          </div>
        ) : null}
        <div className="material-skip-hint">
          点「改一下」我不会动手，会先问你想要怎么调整。
        </div>
      </Modal>

      {/* ========= 确认操作弹窗 ========= */}
      <Modal
        title="确认操作"
        open={!!wfConfirm}
        onOk={() => resolveConfirm(true)}
        onCancel={() => resolveConfirm(false)}
        okText="允许"
        cancelText="取消"
        okButtonProps={{ danger: wfConfirm && wfConfirm.name === 'shell-exec' }}
        width={480}
      >
        <p>
          即将执行技能：<b>{wfConfirm && wfConfirm.name}</b>
          {wfConfirm && wfConfirm.name === 'shell-exec' ? '（ 会在工作区执行命令）' : ''}
        </p>
        <pre className="confirm-params">
          {wfConfirm ? JSON.stringify(wfConfirm.params, null, 2) : ''}
        </pre>
        {wfConfirm && wfConfirm.target ? (
          <Checkbox
            checked={wfConfirmRemember}
            onChange={(e) => setWfConfirmRemember(!!(e && e.target && e.target.checked))}
          >
            本任务内不再询问该服务器（{wfConfirm.target}）
          </Checkbox>
        ) : null}
      </Modal>

      {/* 需求澄清已改为对话内联气泡（见上方 msg-clarify），不再使用 Modal 弹窗 */}

      {/* ========= 设置弹窗 ========= */}
      <Modal
        title="设置"
        open={showSettings}
        onOk={saveSettings}
        onCancel={() => { setSettingsPanel(null); setShowSettings(false); }}
        okText="保存"
        cancelText="取消"
        width={480}
      >
        <p className="hint">所有配置只保存在这台电脑上，不上传。登录后就能用 —— 下面这些按需要再看，不看也完全没问题。</p>

        {/* 一级：板块入口卡（2026-10-18 第十六轮：每张卡补一句「这是什么」的大白话，
            老板反馈「很多人看不懂不知道怎么用」—— 干名词卡片等于没说。
            图标用 LineIcon 与全站一致；desc 走既有 .settings-board-desc 样式。 */}
        {settingsPanel === null && (
          <div className="settings-board">
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('model')}>
              <span className="settings-board-icon"><LineIcon name="globe" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">联网模型</span>
                <span className="settings-board-desc">AI 怎么连：选内网或公网、填密钥</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('shop')}>
              <span className="settings-board-icon"><LineIcon name="package" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">商城</span>
                <span className="settings-board-desc">购物地址与订单相关设置</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('miniprogram')}>
              <span className="settings-board-icon"><LineIcon name="doc" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">小程序</span>
                <span className="settings-board-desc">绑定微信小程序，用生成小程序技能</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('advanced')}>
              <span className="settings-board-icon"><LineIcon name="chart" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">高级配置</span>
                <span className="settings-board-desc">模型名、麦克风、语音、版本更新</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
            {/* 第 5 张卡：我的记忆。
                为什么要单独立一张卡而不是塞进「高级配置」：
                这一屏是用户**唯一**能看见"这个助手到底懂不懂我"的地方，
                埋在二级折叠里等于把这个能力的存在感直接抹掉。
                ★ 卡上的条目数由 MemoryCenter 自己拉，入口卡保持零请求（弹窗一开就发 5 个 IPC 是浪费）。 */}
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('memory')}>
              <span className="settings-board-icon"><LineIcon name="book" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">我的记忆</span>
                <span className="settings-board-desc">豆芽记住了什么，可查看、可删除</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
            {/* 视频设计（0.21.22）：老板要把 key 从创作页收进设置。
                单独一张卡而不是塞进「高级配置」—— 高级配置的定位是「平时不用动」，
                而这里是用户第一次想用视频设计时**必然**要找的地方。 */}
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('videodesign')}>
              <span className="settings-board-icon"><LineIcon name="play" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">视频设计</span>
                <span className="settings-board-desc">通义万象的 key、额度、作品存在哪</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
            {/* 【0.21.10 老板第 2 条】顶栏「更多」下拉里的三项收进这里 ——
                顶栏只留设置 / 我的企业 / 名字，那些入口不能凭空消失，必须有落点。 */}
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('account')}>
              <span className="settings-board-icon"><LineIcon name="users" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">账号</span>
                <span className="settings-board-desc">当前是谁在用、思考过程、使用指南、退出登录</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
            {/* 第 8 张卡：外观（2026-11-08 · 主题二期）。
                `settings-board` 是两列栅格，原来 7 张卡最后一排是单卡；补上这张正好 4 排满格，
                而且**前 7 张的位置一个都没挪** —— 绿色主题下的观感与改造前一致。 */}
            <button type="button" className="settings-board-item" onClick={() => setSettingsPanel('theme')}>
              <span className="settings-board-icon"><LineIcon name="sparkle" size={20} /></span>
              <span className="settings-board-bd">
                <span className="settings-board-name">外观</span>
                <span className="settings-board-desc">绿色 / 白色 / 深色，点一下立刻换</span>
              </span>
              <span className="settings-board-arrow">›</span>
            </button>
          </div>
        )}

        {/* 二级：板块内容（同一个弹窗内切换，右上角「返回」回到入口卡；保存沿用底部单一「保存」按钮） */}
        {settingsPanel !== null && (
          <div className="settings-panel">
            <div className="settings-back" onClick={() => setSettingsPanel(null)}>‹ 返回</div>
            {/* 2026-10-18 第十六轮：二级页顶部标题 + 一句人话说明（老板：看不懂不会用） */}
            <div className="settings-panel-title">
              <span className="settings-panel-name">{(SETTINGS_PANEL_META[settingsPanel] || {}).name || ''}</span>
              {(SETTINGS_PANEL_META[settingsPanel] || {}).sub ? (
                <span className="settings-panel-sub">{(SETTINGS_PANEL_META[settingsPanel] || {}).sub}</span>
              ) : null}
            </div>

            {/* ===== 板块 0 · 账号（0.21.10）：原顶栏「更多」下拉的三项在这里安家 ===== */}
            {settingsPanel === 'account' && (
              <>
                <div className="settings-card">
                  <div className="settings-card-title">当前登录</div>
                  <div className="settings-account-row">
                    <span className="settings-account-name">{authUser ? (authUser.username || authUser.name || '') : '（未登录）'}</span>
                    {usage && usage.mine && typeof usage.mine.total === 'number' && (
                      <span className="usage-badge">已用 {fmtTokens(usage.mine.total)}</span>
                    )}
                  </div>
                  <div className="settings-account-hint">豆芽会用这个名字称呼你。</div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-title">显示思考过程</div>
                  <div className="settings-account-row">
                    <span className="settings-account-hint" style={{ marginRight: 10, flex: 1 }}>
                      开启后，豆芽回答前会先把推理过程摊开给你看（默认关闭，界面更干净）。
                    </span>
                    <button
                      type="button"
                      className={'env-btn' + (showThinking ? ' active' : '')}
                      onClick={() => {
                        const next = !showThinking;
                        setShowThinking(next);
                        localStorage.setItem('douya-show-thinking', next ? '1' : '0');
                      }}
                    >
                      {showThinking ? '已开启' : '已关闭'}
                    </button>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-title">其他</div>
                  <div className="settings-account-row">
                    <button type="button" className="env-btn" onClick={() => { setShowUsageGuide(true); }}>使用指南</button>
                    <button
                      type="button"
                      className="env-btn"
                      onClick={() => { setShowSettings(false); doLogout(); }}
                    >
                      退出登录
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* ===== 板块 1 · 联网模型：模型接入 + 联网检索 + 联网搜索开关 ===== */}
            {settingsPanel === 'model' && (
              <>
                {/* 模型接入 API */}
                <div className="settings-card">
                  <div className="settings-card-title"> 模型接入（API）</div>
                  <div className="env-switch">
                    <button
                      type="button"
                      className={'env-btn' + (detectEnv(cfg.baseURL) === 'intranet' ? ' active' : '')}
                      onClick={() => applyEnv('intranet')}
                    >
                      内网网关（填 Token）
                    </button>
                    <button
                      type="button"
                      className={'env-btn' + (detectEnv(cfg.baseURL) === 'public' ? ' active' : '')}
                      onClick={() => applyEnv('public')}
                    >
                      公网（填 sk- Key）
                    </button>
                  </div>
                  <p className="env-note">内网填网关 Token，公网填 DeepSeek 的 sk- Key；点一下即切换并自动保存。</p>
                  <div className="field-label">服务地址（默认已填好，不用改）</div>
                  <Input
                    value={cfg.baseURL}
                    onChange={(e) => setCfg({ ...cfg, baseURL: e.target.value })}
                    placeholder="http://192.168.80.99:10003/v1"
                  />
                  <div className="field-label">密钥（内网填 Token，公网填 sk- 开头的 Key）</div>
                  <Input.Password
                    value={cfg.apiKey}
                    onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
                    placeholder="如 sk-...（未填则无法对话）"
                  />
                  <div className="connector-actions">
                    <Button size="small" type="primary" ghost onClick={testLLM} disabled={llmTesting}>
                      {llmTesting ? '测试中…' : '测试 AI 连接'}
                    </Button>
                    {llmTestMsg && <span className="connector-msg">{llmTestMsg}</span>}
                  </div>
                </div>

                {/* 联网检索（真实搜索走 Tavily，provider 链 tavily-key → keyless → bocha） */}
                <div className="connector-card">
                  <div className="connector-head">
                    <span className="connector-name"> 联网检索</span>
                    <span className={'connector-status ' + (tavilyConfigured ? 'on' : 'off')}>
                      {tavilyConfigured ? '已配置' : '未配置'}
                    </span>
                  </div>
<div className="field-label">搜索服务密钥（选填：留空用共享免费池，一般不用填）</div>
                  <Input.Password
                    value={cfg.tavilyApiKey}
                    onChange={(e) => setCfg({ ...cfg, tavilyApiKey: e.target.value })}
                    placeholder={tavilyConfigured ? '已配置（留空则不变更）' : 'tvly-...（留空用共享免费池）'}
                    autoComplete="off"
                  />
                  <p className="hint">
                    不填也能用（共享池，可能限流）；填了走你自己的额度，免费 1000 次/月。Key 只存本机。
                  </p>
                </div>

                {/* 联网搜索开关（原「高级设置」迁来；沿用既有 enableSearch，不改逻辑）
                    ★ 2026-11-09 修「竞品分析默认不联网」的**第一现场**：
                      这里原来写着「当前内网模型不支持联网搜索，此开关暂不生效：即使勾选，
                      模型仍只能凭训练知识作答，不会真的上网」，还挂着一条 TODO 说
                      「待接入真实检索端点 /api/web-search 后…」。
                      但那个端点早就接好了（backend.js 的 /api/web-search，provider 链
                      tavily-key → keyless → bocha），竞品分析/企业识别/GEO 走的都是它。
                      ⇒ 产品在设置页亲口告诉用户"不会真的上网"，用户当然认为它不联网。
                      这条过期免责是本轮投诉**最直接**的来源，删掉并如实说明两套链路的分工。 */}
                <div className="settings-card">
                  <div className="settings-card-title"> 联网搜索</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={cfg.enableSearch}
                      onChange={(e) => setCfg({ ...cfg, enableSearch: e.target.checked })}
                    />
                    <span>对话时让模型尝试联网</span>
                  </label>
                  <p className="hint" style={{ marginBottom: 8, lineHeight: 1.6 }}>
                    这个开关只管「聊天对话」：勾上会让模型试着带上联网能力作答，
                    是否真联网取决于所连的模型服务，不保证生效。
                    {' '}
                    竞品分析、企业识别、GEO 这些功能「不受它影响」—— 它们走独立的真检索通道
                    （主进程直连搜索服务，返回的网页会标「联网实检 N 条」）。
                  </p>
                </div>
              </>
            )}

            {/* ===== 板块 1.5 · 视频设计（0.21.22 · 老板第 5 条：把 api 藏进设置）=====
                这一屏承接三件事：① key 的填写与回显（只回显掩码）；
                ② 额度与账本（全部标「估算」，我们没有控制台账单接口）；
                ③ 作品到底存在哪个目录。
                ★ 单价与总额度的编辑**留在视频设计页** —— 那一页改完金额立刻重算，
                  同一份参数在两处都能改，早晚会出现「两边显示不一致」的说不清状态。 */}
            {settingsPanel === 'videodesign' && (
              <>
                {wanxCfgErr ? (
                  <div className="settings-card">
                    <div className="settings-card-title">读不到配置</div>
                    <p className="hint" style={{ marginBottom: 0, color: '#b25000' }}>{wanxCfgErr}</p>
                  </div>
                ) : null}

                <div className="connector-card">
                  <div className="connector-head">
                    <span className="connector-name"> 通义万象 API Key</span>
                    <span className={'connector-status ' + (wanxHasKey ? 'on' : 'off')}>
                      {wanxHasKey ? '已配置' : '未配置'}
                    </span>
                  </div>
                  {wanxHasKey ? (
                    <p className="hint" style={{ marginTop: 0 }}>
                      当前：<code>{wanxSt.masked || ''}</code>
                      {wanxKeyFromLabel ? <span>（{wanxKeyFromLabel}）</span> : null}
                    </p>
                  ) : (
                    <p className="hint" style={{ marginTop: 0 }}>
                      还没有 Key。不填也能进「视频设计」页，只是生成时会提示先来这里配置。
                    </p>
                  )}
                  <div className="field-label">粘贴 Key（会覆盖旧的）</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input.Password
                      value={wanxKeyDraft}
                      onChange={(e) => setWanxKeyDraft(e.target.value)}
                      onPressEnter={saveWanxKey}
                      placeholder="sk-...（阿里云百炼控制台 → API-KEY）"
                      autoComplete="off"
                    />
                    <Button type="primary" onClick={saveWanxKey} loading={wanxKeyBusy} style={{ flex: '0 0 auto' }}>
                      保存 Key
                    </Button>
                  </div>
                  {wanxKeyMsg ? <p className="hint" style={{ marginBottom: 0 }}>{wanxKeyMsg}</p> : null}
                  <p className="hint" style={{ marginBottom: 0 }}>
                    Key 只写进这台电脑，界面只显示掩码；生成请求由主程序直接发往阿里云，网页层拿不到 Key。
                  </p>
                </div>

                {/* ===== 历史 Key 待认领（0.21.26-rc.6 · 账号隔离之后的迁移入口）=====
                    分账号之前，key 存在**没有账号这一维**的全局文件里。换了根之后
                    所有账号都是「未配置 key」，但那个旧文件里那枚 key 不一定属于
                    当前登录的人 —— 判据是「无法可靠判断归属时保留为待认领，不猜」。
                    所以这里只做**显式**复制：人不点，它就一直待在那儿。 */}
                {wanxLegacy ? (
                  <div className="settings-card">
                    <div className="settings-card-title"> 检测到历史 Key（无账号归属）</div>
                    <p className="hint" style={{ marginTop: 0 }}>
                      这台电脑上还有一份分账号之前存下的 Key：<code>{wanxLegacy.masked || ''}</code>
                    </p>
                    <p className="hint">
                      那会儿还没有「这条配置属于谁」这个概念，算不到任何账号头上。换账号的人也看得见，自动用就等于替你把别人的配置划给了当前登录的人。
                    </p>
                    <Button type="primary" onClick={importLegacyWanxKey} loading={wanxLegacyBusy}>
                      复制到当前账号
                    </Button>
                    <p className="hint" style={{ marginBottom: 0 }}>
                      是<strong>复制</strong>不是搬走：原件不会被删也不会被改，别的账号以后仍可各自认领。
                      只影响<strong>当前登录的这个账号</strong>的 Key 和额度。
                    </p>
                  </div>
                ) : null}
                {/* 结果提示放在卡片**外面**：导入成功后主进程不再挂 legacyKey，卡片会消失，
                    提示要是也长在卡片里，就变成「点完什么都没有、界面还少了一块」。 */}
                {wanxLegacyMsg ? (
                  <div className="settings-card">
                    <p className="hint" style={{ marginBottom: 0 }}>{wanxLegacyMsg}</p>
                  </div>
                ) : null}

                <div className="settings-card">
                  <div className="settings-card-title"> 额度（估算，不是账单）</div>
                  {wanxBudgetObj ? (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 8 }}>
                        <div>
                          <div className="field-label" style={{ margin: 0 }}>总额度</div>
                          <div style={{ fontSize: 18, fontWeight: 600 }}>¥{wanxMoney(wanxBudgetObj.totalBudget)}</div>
                        </div>
                        <div>
                          <div className="field-label" style={{ margin: 0 }}>已用（估算）</div>
                          <div style={{ fontSize: 18, fontWeight: 600 }}>¥{wanxMoney(wanxBudgetObj.spent)}</div>
                        </div>
                        <div>
                          <div className="field-label" style={{ margin: 0 }}>剩余</div>
                          <div style={{ fontSize: 18, fontWeight: 600 }}>¥{wanxMoney(wanxBudgetObj.remaining)}</div>
                        </div>
                      </div>
                      <p className="hint" style={{ marginBottom: 0 }}>
                        按「本地单价 × 成功生成量」估算，累计 {wanxBudgetObj.count || 0} 笔。
                        <strong>视频是按秒计价的</strong>（不是按条），5 秒和 30 秒差好几倍。
                      </p>
                    </>
                  ) : (
                    <p className="hint" style={{ marginBottom: 0 }}>还没有额度数据。</p>
                  )}
                  <p className="hint" style={{ marginBottom: 0 }}>
                    总额度和单价在「视频设计」页的「改单价」里调 —— 那边改完金额会立刻重算，这里就不再做第二份入口了。
                  </p>
                </div>

                <div className="settings-card">
                  <div className="settings-card-title"> 作品存放位置</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input
                      value={wanxMediaDirText}
                      readOnly
                      placeholder="（生成第一张后自动创建）"
                    />
                    <Button onClick={openWanxFolder} style={{ flex: '0 0 auto' }}>打开文件夹</Button>
                  </div>
                  {wanxDirMsg ? <p className="hint" style={{ marginBottom: 0 }}>{wanxDirMsg}</p> : null}
                  <p className="hint" style={{ marginBottom: 0 }}>
                    生成的视频/图片都落在这个目录，文件名带时间戳；同目录的 .index.json 记着每条的提示词和参考图。
                  </p>
                </div>

                <div className="settings-card">
                  <div className="settings-card-title"> 最近 10 笔（估算）</div>
                  {wanxLedgerRows.length === 0 ? (
                    <p className="hint" style={{ marginBottom: 0 }}>还没有记录。生成一次之后这里会有一行。</p>
                  ) : (
                    <div style={{ maxHeight: 220, overflow: 'auto' }}>
                      {wanxLedgerRows.map((it, i) => {
                        const o = it || {};
                        const ts = String(o.ts || '').replace('T', ' ').slice(0, 16);
                        return (
                          <div
                            key={(o.taskId || ts || 'row') + '-' + i}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '6px 0', borderBottom: '1px solid #f0f0f0', fontSize: 12,
                            }}
                          >
                            <span style={{ color: '#8c8c8c', flex: '0 0 96px' }}>{ts || '—'}</span>
                            <span style={{ flex: '0 0 60px' }}>{WANX_KIND_LABEL[o.kind] || o.kind || '—'}</span>
                            <span style={{ flex: 1, color: '#595959', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {o.prompt || ''}
                            </span>
                            <span style={{ flex: '0 0 auto', fontWeight: 600 }}>¥{wanxMoney(o.estimatedCost)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="hint" style={{ marginBottom: 0 }}>
                    账本是本机估算，对账以阿里云控制台账单为准。退款/差额行是负数，会自动抵掉。
                  </p>
                </div>
              </>
            )}

            {/* ===== 板块 2 · 商城：上游货源 + 上游货源 ===== */}
            {settingsPanel === 'shop' && (
              <>
                {/* 上游货源商城 上游货源 */}
                <div className="connector-card">
                  <div className="connector-head">
                    <span className="connector-name"> 上游货源商城（上游货源）</span>
                    <span className={'connector-status ' + (connShopConnected ? 'on' : 'off')}>
                      {connShopConnected ? '已连接' : '未连接'}
                    </span>
                  </div>
<div className="field-label">商城账号（supplier.example.com 登录账号）</div>
                  <Input
                    value={cfg.shopAccount}
                    onChange={(e) => setCfg({ ...cfg, shopAccount: e.target.value })}
                    placeholder="手机号 / 用户名"
                  />
                  <div className="field-label">商城 Token（可选，优先于账号密码）</div>
                  <Input.Password
                    value={cfg.shopApiKey}
                    onChange={(e) => setCfg({ ...cfg, shopApiKey: e.target.value })}
                    placeholder="留空则用账号密码自动登录"
                  />
                  <div className="field-label">商城密码（仅账号密码登录时用）</div>
                  <Input.Password
                    value={cfg.shopPassword}
                    onChange={(e) => setCfg({ ...cfg, shopPassword: e.target.value })}
                    placeholder="登录密码，仅保存在本机"
                  />
                  <div className="connector-actions">
                    <Button size="small" type="primary" ghost onClick={() => testConnector('shop-supplier-a')} disabled={connBusy}>
                      {connBusy ? '测试中…' : '测试连接'}
                    </Button>
                    {connShopConnected && (
                      <Button size="small" danger onClick={() => disconnectConnector('shop-supplier-a')}>
                        断开
                      </Button>
                    )}
                    {connMsgFor === 'shop-supplier-a' && connMsg && <span className="connector-msg">{connMsg}</span>}
                  </div>
                </div>

                {/* 上游货源商城（supplier.example.com）—— 独立 mmm* 配置，与 上游货源 的 shop* 严格分区 */}
                <div className="connector-card">
                  <div className="connector-head">
                    <span className="connector-name"> 上游货源商城（supplier.example.com）</span>
                    <span className={'connector-status ' + (connMmmConnected ? 'on' : 'off')}>
                      {connMmmConnected ? '已连接' : '未连接'}
                    </span>
                  </div>
<div className="field-label">商城账号（supplier.example.com 登录账号）</div>
                  <Input
                    value={cfg.mmmAccount}
                    onChange={(e) => setCfg({ ...cfg, mmmAccount: e.target.value })}
                    placeholder="上游货源登录账号"
                  />
                  <div className="field-label">商城密码（上游货源登录密码）</div>
                  <Input.Password
                    value={cfg.mmmPassword}
                    onChange={(e) => setCfg({ ...cfg, mmmPassword: e.target.value })}
                    placeholder="登录密码，仅保存在本机"
                  />
                  <div className="connector-actions">
                    <Button size="small" type="primary" ghost onClick={() => testConnector('shop-supplier-b')} disabled={connBusy}>
                      {connBusy ? '测试中…' : '测试连接'}
                    </Button>
                    {connMsgFor === 'shop-supplier-b' && connMsg && <span className="connector-msg">{connMsg}</span>}
                  </div>
                </div>
              </>
            )}

            {/* ===== 板块 3 · 小程序：微信 AppID/AppSecret + 豆芽后台 ===== */}
            {settingsPanel === 'miniprogram' && (
              <>
                {/* 微信小程序 */}
                <div className="settings-card">
                  <div className="settings-card-title"> 微信小程序</div>
                  <div className="field-label">微信 AppID</div>
                  <Input
                    value={cfg.wxAppId}
                    onChange={(e) => setCfg({ ...cfg, wxAppId: e.target.value })}
                    placeholder="小程序 AppID，如 wx1234567890abcdef"
                  />
                  <div className="field-label">微信 AppSecret</div>
                  <Input.Password
                    value={cfg.wxAppSecret}
                    onChange={(e) => setCfg({ ...cfg, wxAppSecret: e.target.value })}
                    placeholder="小程序 AppSecret，仅保存在本机"
                  />
                  <p className="hint">「生成小程序」「微信接口」两个技能要用。AppSecret 只存本机。</p>
                </div>

                {/* 豆芽后台（登录自动连接，只读状态 + 测试连接） */}
                <div className="connector-card">
                  <div className="connector-head">
                    <span className="connector-name"> 豆芽后台</span>
                    <span className={'connector-status ' + (connGeoConnected ? 'on' : 'off')}>
                      {connGeoConnected ? '已连接' : '未连接'}
                    </span>
                  </div>
<p className="hint">登录时已自动用你的账号连接，无需再填账号密码；token 仅在登录成功后本地缓存。</p>
                  <div className="connector-actions">
                    <Button size="small" type="primary" ghost onClick={() => testConnector('doudou-ai')} disabled={connBusy}>
                      {connBusy ? '测试中…' : '测试连接'}
                    </Button>
                    {connGeoConnected && (
                      <Button size="small" danger onClick={() => disconnectConnector('doudou-ai')}>
                        断开
                      </Button>
                    )}
                    {connMsgFor === 'doudou-ai' && connMsg && <span className="connector-msg">{connMsg}</span>}
                  </div>
                </div>
              </>
            )}

            {/* ===== 板块 4 · 高级配置：模型名 / 麦克风 / 语音（ASR·TTS）===== */}
            {settingsPanel === 'advanced' && (
              <>
                <div className="settings-card">
                  <div className="settings-card-title"> 通用</div>
                  <div className="field-label">模型名称（默认已填好，不用改）</div>
                  <Input
                    value={cfg.model}
                    onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
                    placeholder="deepseek-v4-pro"
                  />
                  <div className="field-label">麦克风设备</div>
                  <select
                    className="mic-select"
                    value={micDevice === null ? 'auto' : String(micDevice)}
                    onChange={(e) => onMicDeviceChange(e.target.value)}
                  >
                    <option value="auto">自动（推荐）</option>
                    {micDevices.map((d) => (
                      <option key={d.index} value={String(d.index)}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <div className="mic-test-row">
                    <Button size="small" onClick={testMic} disabled={micTesting}>
                      {micTesting ? '测试中…' : '测试麦克风'}
                    </Button>
                    <div className="mic-meter">
                      <div
                        className="mic-meter-fill"
                        style={{ width: Math.min(100, (micTestLevel / 32767) * 100) + '%' }}
                      />
                    </div>
                    <span className="mic-meter-val">{micTestLevel}</span>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-title"> 语音</div>
                  <div className="field-label">语音识别密钥（选填：留空用 Windows 本地识别）</div>
                  <Input.Password
                    value={cfg.asrApiKey}
                    onChange={(e) => setCfg({ ...cfg, asrApiKey: e.target.value })}
                    placeholder="留空则用 Windows 本地语音识别"
                  />
                  <div className="field-label">语音合成密钥（选填：留空则不语音播报）</div>
                  <Input.Password
                    value={cfg.ttsApiKey}
                    onChange={(e) => setCfg({ ...cfg, ttsApiKey: e.target.value })}
                    placeholder="留空则不启用语音播报"
                  />
                  <p className="hint">语音 Key 来自火山引擎（openspeech.bytedance.com），填你自己的，用完即走、不上传任何服务器。</p>
                </div>

                {/* 版本与更新：此前界面没有任何地方显示当前版本，用户无从判断是否最新 */}
                <VersionCard />
              </>
            )}

            {/* ===== 板块 5 · 我的记忆：四层档案 + 记录时间线 + 逐条删除 ===== */}
            {/* 保存语义：这一屏所有写操作（开关、删除）**即时生效**，不参与底部「保存」按钮。
                理由：它们都要经过 IPC 落盘，如果还要用户再点一次「保存」，就会出现
                "我明明删了但没点保存"这种说不清的状态 —— 记忆这种用户高度敏感的东西
                经不起第二次确认的歧义。 */}
            {settingsPanel === 'memory' && <MemoryCenter />}

            {/* ===== 板块 6 · 外观（2026-11-08 · 主题二期）=====
                保存语义与「我的记忆」一致：**即时生效，不参与底部「保存」按钮**。
                理由：配色是"点一下就想看到效果"的东西，再要求用户点一次保存，
                就会出现"我选了深色但它没变"的困惑。

                ★ 两个选项的样式**全部走内联 + `--c-*` token**，不新增 style.css 规则。
                  两个原因：① 本轮的改动域不含 style.css（那是别的工程师的文件）；
                  ② 内联 token 在白/深两套下都自动正确 —— 若复用 `.env-btn` 那套
                     （`background: rgba(255,255,255,.9)` 写死），深色主题下这两颗按钮
                     会是刺眼的白色方块。 */}
            {settingsPanel === 'theme' && (
              <>
                <div className="settings-card">
                  <div className="settings-card-title">配色</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '8px 0 6px' }}>
                    {THEME_ORDER.map((k) => {
                      const active = themeNow === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setAppTheme(k)}
                          style={{
                            flex: '1 1 88px',
                            minWidth: 88,
                            cursor: 'pointer',
                            padding: '11px 8px',
                            borderRadius: 10,
                            font: 'inherit',
                            fontSize: 13.5,
                            fontWeight: active ? 700 : 500,
                            border: '1px solid ' + (active ? 'var(--c-brand)' : 'var(--c-border-strong)'),
                            background: active ? 'var(--c-brand)' : 'var(--c-surface)',
                            color: active ? 'var(--c-on-brand)' : 'var(--c-text-2)',
                            transition: 'all .15s',
                          }}
                        >
                          {THEME_LABELS[k] || k}
                        </button>
                      );
                    })}
                  </div>
                  {/* 预览条：三块色 = 当前这套主题的「窗口底 / 卡片面 / 正文色」。
                      它同时是最好的自证 —— 用户不用切走就能看出这套配色长什么样。 */}
                  <div
                    aria-hidden="true"
                    style={{
                      display: 'flex', gap: 0, height: 34, borderRadius: 8, overflow: 'hidden',
                      border: '1px solid var(--c-border-strong)', margin: '4px 0 8px',
                    }}
                  >
                    <span style={{ flex: 1, background: 'var(--c-bg-app)' }} />
                    <span style={{ flex: 1, background: 'var(--c-surface)' }} />
                    <span style={{ flex: 1, background: 'var(--c-text)' }} />
                  </div>
                  <p className="hint" style={{ marginBottom: 0 }}>
                    点一下立刻生效，不用点底部的「保存」；下次打开还是这套。选择只记在这台电脑上，不同步到账号。
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* ========= 使用指南弹窗（常驻入口：标题栏「使用指南」） ========= */}
      {/* footer={null}：指南是只读内容，没有可「保存」的东西，不留空按钮。
          DouyaUsageGuide 刻意不接 onSelectModule —— 保持其「只讲怎么用、不放跳转卡」语义。 */}
      <Modal
        title="使用指南"
        open={showUsageGuide}
        onCancel={() => setShowUsageGuide(false)}
        footer={null}
        width={720}
      >
        <DouyaUsageGuide />
      </Modal>

      {/* ========= 授权引导（闸的钥匙）=========
          放在最后、与其它常驻弹窗同级：它自己决定要不要显示（查不到状态就不显示），
          App 不需要为它多一个 state —— 少一个能忘掉同步的状态变量，就少一类 bug。 */}
      <LicenseGuardHost />

      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-box"> 松开鼠标，把文件丢给我</div>
        </div>
      )}
    </div>
    </AntApp>
    </ConfigProvider>
  );
}
