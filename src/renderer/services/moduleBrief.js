/**
 * moduleBrief —— 「本页智能助手」面板的页面事实层（纯函数，只读，无 React）。
 *
 * 设计口径（团队定稿）：
 *   面板按 moduleKey「自己复算」本页可读信息，而不是让各模块组件去 publish ——
 *   原因：内容与传播 / 新媒体中心 / 企业大脑 是 antd Tabs 薄壳（自身零 state），其子页
 *   在 destroyInactiveTabPane={false} 下会同时挂载，多个子组件向同一 moduleKey 发布会产生
 *   「谁后跑谁赢」的竞态。改为面板侧按 moduleKey 读 store/localStorage 复算后，6 个模块组件
 *   一行都不用改，且没有竞态。
 *
 * 性质：纯函数 + 只读边界。不 import React，不写 localStorage，不发网络，不编造数据。
 *   - 无 companyId / 无数据 / 真·未知 moduleKey → { facts: [], topics: [] }（绝不返回 undefined）。
 *   - 隐藏但可达的模块（media/competitor/crisis/huodong/daily/project/learn/goal/geo/xinmeiti，跨模块
 *     跳转到达、不在左侧导航里）复用父导航模块的事实（MODULE_BRIEF_ALIAS），与 ModuleNav.ACTIVE_ALIAS
 *     语义一致——保证助手在「跨模块跳转到达的页面」上不会空白。campaign/brain/asset 有专属分支，优先命中。
 *   - 所有数字均来自真实持久化数据；经营诊断结果若未持久化则如实跳过（MarketMomentum 的
 *     result 只在组件 state 里，故本文件不报「诊断弱项数」，避免硬凑）。
 *
 * 复用的纯函数（与 TodayOps 驾驶舱同一套算法，保证口径一致）：
 *   loadPlanNodes(planBrief) / rankCampaigns(campaignPriority) / toSignal + tierToHealth(campaignSignal)
 *   loadGoals(companyGoal) / loadTimeline(companyTimeline)
 */

import { loadPlanNodes } from './planBrief.js';
import { rankCampaigns } from './campaignPriority.js';
import { toSignal, tierToHealth } from './campaignSignal.js';
import { loadGoals } from './companyGoal.js';
import { loadTimeline } from './companyTimeline.js';

// ---- 只读边界用的存储 key（各自归属的 store 见注释；此处只读，不写）----
const CAMPAIGNS_KEY = 'douya-campaigns';           // campaignStore.CAMPAIGNS_KEY（数组）
const DIRECTIONS_KEY = 'douya-directions';         // directionStore.DIRECTIONS_KEY（数组）
const ASSETS_KEY = 'douya-assets';                 // assetStore.ASSETS_KEY（数组）
const KNOWLEDGE_KEY = 'douya-company-knowledge';   // companyKnowledgeStore.KNOWLEDGE_KEY（{ [cid]: {...} }）

function asStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/** 读取 localStorage JSON（容错：非浏览器 / 被禁用 / 解析失败一律回退）。 */
function readJSON(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readArray(key) {
  const v = readJSON(key, []);
  return Array.isArray(v) ? v : [];
}

/** Date → 'YYYY-MM-DD'（本地时区）。 */
function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 该企业下的营销专项（原始对象足够，toSignal/rankCampaigns 对缺字段有兜底）。 */
function readCampaigns(companyId) {
  const cid = asStr(companyId);
  if (!cid) return [];
  return readArray(CAMPAIGNS_KEY).filter((c) => c && typeof c === 'object' && asStr(c.companyId) === cid);
}

/** 该企业下的经营方向。 */
function readDirections(companyId) {
  const cid = asStr(companyId);
  if (!cid) return [];
  return readArray(DIRECTIONS_KEY).filter((d) => d && typeof d === 'object' && asStr(d.companyId) === cid);
}

/** 该企业下的资产。 */
function readAssets(companyId) {
  const cid = asStr(companyId);
  if (!cid) return [];
  return readArray(ASSETS_KEY).filter((a) => a && typeof a === 'object' && asStr(a.companyId) === cid);
}

/** 该企业的四类知识（facts/rules/memories，与 normalizeKnowledge 同口径：字符串化去空）。 */
function readKnowledge(companyId) {
  const cid = asStr(companyId);
  const empty = { facts: [], rules: [], memories: [] };
  if (!cid) return empty;
  const map = readJSON(KNOWLEDGE_KEY, {});
  const k = map && typeof map === 'object' && !Array.isArray(map) ? map[cid] : null;
  if (!k || typeof k !== 'object') return empty;
  const list = (v) => (Array.isArray(v) ? v.map((x) => asStr(x)).filter(Boolean) : []);
  return { facts: list(k.facts), rules: list(k.rules), memories: list(k.memories) };
}

/** 专项统计：进行中 / 待确认 / 需处理（健康度三档，与 TodayOps 同一算法）。 */
function campaignStats(campaigns) {
  const inFlight = campaigns.filter((c) => c.status === 'preparing' || c.status === 'ongoing');
  const pending = campaigns.filter((c) => c.status === 'planning');
  const ranked = rankCampaigns(inFlight.map(toSignal));
  const byHealth = { handle: 0, watch: 0, normal: 0 };
  ranked.forEach((r) => { byHealth[tierToHealth(r.tier)] += 1; });
  return { total: campaigns.length, inFlight: inFlight.length, pending: pending.length, handle: byHealth.handle, watch: byHealth.watch, normal: byHealth.normal };
}

/** 日历统计：已排项数 + 今天及以后的最近一项。 */
function planStats(companyId) {
  const nodes = loadPlanNodes(companyId);
  const todayIso = toISODate(new Date());
  const next = nodes.find((n) => n.date >= todayIso) || null;
  return { total: nodes.length, next };
}

/**
 * 隐藏模块 → 归属的父导航模块（复用父模块的事实）。
 * 这些 key 不在左侧导航里，但通过跨模块跳转可达（如经营诊断「去发文」→ media、
 * 点进 → competitor / crisis / huodong / daily）。右侧助手在这些页面上必须仍有内容——
 * 否则恰好在「模块割裂、跨模块跳转到达」的页面上失效。语义与 ModuleNav.ACTIVE_ALIAS 一致。
 * 注意：只映射「隐藏但可达」的 key；campaign / brain / asset / learn 已有专属分支，不放入本表（专属优先）。
 */
const MODULE_BRIEF_ALIAS = {
  media: 'newmedia',
  xinmeiti: 'newmedia',
  // GEO 的唯一展示出口是「经营诊断」（2026-09-12 信息架构重排 · 老板第 7 条），
  // 原先折到 newmedia 会让助手在 GEO 页报新媒体的事实，故改指 intel。
  geo: 'intel',
  competitor: 'intel',
  crisis: 'intel',
  huodong: 'content',
  daily: 'content',
  project: 'activity',
  // learn 已是一级导航（第 8 项），不再是「隐藏但可达」的 key，故不在此折叠 ——
  // 它有自己的 factsFor 分支（学习进度 + 企业档案），见下方 case 'learn'。
  goal: 'activity',
};

/**
 * 一次算好本页复算所需的全部共享统计（只读 store/localStorage，只算一次）。
 * 兜底复用父模块事实时不重算，避免重复读 localStorage。
 */
function computeCtx(companyId) {
  const campaigns = readCampaigns(companyId);
  const directions = readDirections(companyId);
  const assets = readAssets(companyId);
  const knowledge = readKnowledge(companyId);
  const goals = loadGoals(companyId);
  const timeline = loadTimeline(companyId);
  const cs = campaignStats(campaigns);
  const ps = planStats(companyId);
  const activeDir = directions.find((d) => d.status === 'active') || null;

  // 「无数据」= 该企业所有相关集合均为空 → 面板显示空态（不硬凑 0 计数）。
  const hasAnyData =
    cs.total > 0 || directions.length > 0 || assets.length > 0 || ps.total > 0 ||
    goals.length > 0 || timeline.length > 0 ||
    knowledge.facts.length > 0 || knowledge.rules.length > 0 || knowledge.memories.length > 0;

  return { cid: asStr(companyId), campaigns, directions, assets, knowledge, goals, timeline, cs, ps, activeDir, hasAnyData };
}

/**
 * 按 moduleKey 组装「页面事实」与「话题关键词」。
 * 未知 key 返回 null（交由 buildBrief 走「隐藏模块 → 父模块」兜底；不在此处返回空数组）。
 * @returns {{facts:Array<{label:string,value:string}>, topics:string[]}|null}
 */
function factsFor(moduleKey, ctx) {
  const { cid, directions, assets, knowledge, goals, timeline, cs, ps, activeDir } = ctx;
  const f = (label, value) => ({ label, value });

  switch (moduleKey) {
    case 'activity':
      {
        const facts = [
          f('进行中专项', `${cs.inFlight} 个`),
          f('待你确认', `${cs.pending} 个`),
          f('需处理', `${cs.handle} 个`),
          f('日历已排', `${ps.total} 项`),
        ];
        if (ps.next) facts.push(f('下一项', `${ps.next.date} ${ps.next.title}`));
        return { facts, topics: ['专项推进', '待决策事项', '日历排期'] };
      }

    case 'miaomiao':
      {
        // 「上游货源档期」是 iframe 内嵌 api.example.com 的活动日历页：档期数据在远端、本地读不到，
        // 故「本页事实」只能报本地真实持久化数据。复用「今天做什么」的口径（专项 / 日历），
        // 保证一级导航页的右侧助手不空白（与 project/goal 折到 today 同一思路），不编造远端数字。
        const facts = [
          f('进行中专项', `${cs.inFlight} 个`),
          f('待你确认', `${cs.pending} 个`),
          f('需处理', `${cs.handle} 个`),
          f('日历已排', `${ps.total} 项`),
        ];
        if (ps.next) facts.push(f('下一项', `${ps.next.date} ${ps.next.title}`));
        return { facts, topics: ['活动档期', '报名参加', '活动日历'] };
      }

    case 'direction':
      return {
        facts: [
          f('当前方向', activeDir ? `《${asStr(activeDir.name) || '未命名'}》` : '尚未设定'),
          f('经营方向', `${directions.length} 个`),
          f('进行中专项', `${cs.inFlight} 个`),
          f('日历已排', `${ps.total} 项`),
        ],
        topics: ['经营方向', '专项落地', '执行节奏'],
      };

    case 'campaign':
      {
        const facts = [
          f('全部专项', `${cs.total} 个`),
          f('进行中', `${cs.inFlight} 个`),
          f('待你确认', `${cs.pending} 个`),
          f('需处理', `${cs.handle} 个`),
          f('需关注', `${cs.watch} 个`),
        ];
        if (activeDir) facts.push(f('当前方向', `《${asStr(activeDir.name) || '未命名'}》`));
        return { facts, topics: ['专项优先级', '决策阻塞', '执行进度'] };
      }

    case 'intel':
      return {
        facts: [
          f('进行中专项', `${cs.inFlight} 个`),
          f('需处理', `${cs.handle} 个`),
          f('需关注', `${cs.watch} 个`),
          f('日历已排', `${ps.total} 项`),
          f('企业记忆', `${knowledge.memories.length} 条`),
        ],
        topics: ['经营诊断', '专项健康度', '数据事实'],
      };

    case 'content':
      return {
        facts: [
          f('企业档案', `${knowledge.facts.length} 条事实`),
          f('内容规则', `${knowledge.rules.length} 条`),
          f('已有资产', `${assets.length} 个`),
          f('日历已排', `${ps.total} 项`),
        ],
        topics: ['内容生产', '传播计划', '企业规则'],
      };

    case 'newmedia':
      return {
        facts: [
          f('已有资产', `${assets.length} 个`),
          f('内容规则', `${knowledge.rules.length} 条`),
          f('进行中专项', `${cs.inFlight} 个`),
          f('日历已排', `${ps.total} 项`),
        ],
        topics: ['新媒体运营', '内容资产', '传播节奏'],
      };

    case 'profile':
    case 'brain':
      return {
        facts: [
          f('企业档案', `${knowledge.facts.length} 条事实`),
          f('品牌规则', `${knowledge.rules.length} 条`),
          f('长期记忆', `${knowledge.memories.length} 条`),
          f('企业目标', goals.length > 0 ? '已设定' : '未设定'),
          f('档案时间轴', `${timeline.length} 条`),
        ],
        topics: ['企业档案', '品牌规则', '长期记忆'],
      };

    case 'asset':
      {
        const facts = [
          f('资产总数', `${assets.length} 个`),
          f('企业档案', `${knowledge.facts.length} 条事实`),
          f('进行中专项', `${cs.inFlight} 个`),
          f('日历已排', `${ps.total} 项`),
        ];
        const latest = assets
          .slice()
          .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0] || null;
        if (latest) facts.push(f('最近一条', asStr(latest.name) || '未命名资产'));
        return { facts, topics: ['资产沉淀', '内容复用', '素材整理'] };
      }

    case 'learn':
      {
        // 学习中心：只报真实持久化数据，两处来源都是本企业自己的 ——
        //   1) 实操 checklist 勾选进度：LearningStation 写入的 douya-tutorial-progress，
        //      key 形如 `${companyId}:${tutId}`，故按本企业前缀过滤（不串企业）。
        //   2) 企业档案条数：学习页的「AI 解读」会带上企业背景，条数即它真实的输入规模。
        // 不报「课程总数」这类与本企业无关的静态目录数字（属硬凑）。
        const tp = readJSON('douya-tutorial-progress', {});
        const prefix = `${cid}:`;
        let doneTut = 0;
        let doingTut = 0;
        for (const [k, v] of Object.entries(tp && typeof tp === 'object' ? tp : {})) {
          if (!k.startsWith(prefix)) continue;
          const checked = Array.isArray(v && v.checked) ? v.checked : [];
          if (v && v.done) doneTut += 1;
          else if (checked.length > 0) doingTut += 1;
        }
        return {
          facts: [
            f('实操已完成', `${doneTut} 个`),
            f('实操进行中', `${doingTut} 个`),
            f('企业档案', `${knowledge.facts.length} 条事实`),
          ],
          // 页签文案真源：0.21.14 老板需求 2 把「实操教学」改成「门诊运营教学」。
          // ⚠️ 只改这里（页签名）；上面 facts 里的「实操已完成 / 实操进行中」**不动** ——
          //    它们说的是「学习任务完成了几个」，语义仍然准确（设计 §6 G5 拆解）。
          topics: ['门诊运营教学', '行业资讯', 'AI 解读'],
        };
      }

    default:
      // 未知 moduleKey → null（不在此处返回空，交由 buildBrief 兜底到父模块）。
      return null;
  }
}

/**
 * 为当前模块复算「页面事实」与「AI 话题关键词」。
 *
 * 解析顺序（先专属、后兜底）：
 *   1. 无 companyId → 空；
 *   2. 该企业无任何数据 → 空；
 *   3. 专属分支（today/direction/campaign/intel/content/newmedia/profile/brain/asset/learn）命中即用；
 *   4. 隐藏但可达的 key（media/competitor/crisis/huodong/daily/project/goal/geo/xinmeiti）
 *      复用父导航模块的事实（与 ModuleNav.ACTIVE_ALIAS 语义一致）；
 *   5. 其余真·未知 key → 空。
 * 注意：campaign/brain/asset 有专属分支，必须优先于兜底（不被降级）。
 *
 * @param {string} moduleKey 模块 key
 * @param {{companyId?: string|number, companyType?: string}} [opts]
 * @returns {{facts: Array<{label:string, value:string}>, topics: string[]}}
 *   无 companyId / 无数据 / 未知 moduleKey → { facts: [], topics: [] }
 */
export function buildBrief(moduleKey, { companyId } = {}) {
  const cid = asStr(companyId);
  if (!cid) return { facts: [], topics: [] };
  try {
    const key = asStr(moduleKey);
    const ctx = computeCtx(cid);
    if (!ctx.hasAnyData) return { facts: [], topics: [] };

    const own = factsFor(key, ctx);
    if (own) return own;

    const parent = MODULE_BRIEF_ALIAS[key];
    if (parent) {
      const fb = factsFor(parent, ctx);
      if (fb) return fb;
    }
    return { facts: [], topics: [] };
  } catch {
    return { facts: [], topics: [] };
  }
}

export default { buildBrief };
