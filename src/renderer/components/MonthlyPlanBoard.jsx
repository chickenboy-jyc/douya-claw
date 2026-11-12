/**
 * MonthlyPlanBoard —— 「豆芽排好的带日期方案」+ 月历（CalendarView）。
 *
 * 为什么有这个文件（不是重复造轮子，是把断了的一条链路接回去）：
 *   2026-10-10 老板第 6/7 条改造把落地页「今天做什么」(TodayOps) 换成了对话式「活动策划」
 *   (ActivityChat)，TodayOps 从此**不再被 App 挂载**。而月历（CalendarView）此前**唯一**的
 *   渲染点就在 TodayOps 里 ⇒ 整条「铺排 → 月历 → 改期」链路**不可达**：
 *     · App.jsx 仍会把首登第 8 步选的方向写进 `douya-onboard-direction`，**写下去没人消费**；
 *     · 用户再也看不到「豆芽给你排好的这个月」，也改不了期。
 *   本组件把「自动铺排 + 月历」收进「经营方案」页（见 DirectionModule 的页签），
 *   **不新加一级导航** —— 守住 unit-role-diff-ui 的导航锁（4 组 9 模块、data-module 锚点不增删）。
 *
 * 复用的既有零件（一行逻辑都不重写）：
 *   · store/monthlyPlanStore —— 持久化、按企业隔离、「是否已自动铺过」标记
 *   · services/planToCalendar —— 模板/AI 节点摊平、幂等合并、按 id 去重（纯函数）
 *   · components/CalendarView —— 月历 UI（自带 inline style，不依赖任何 CSS）
 *   · services/opsPlan.generateMonthlyPlan —— AI 路径
 *   · style.css 里已有的 today-* 类（全局样式，无需 import 新 CSS 文件）
 *
 * 与原 TodayOps 的行为对齐（照抄，不擅自改口径）：
 *   · 自动铺排只在「该企业从未被自动铺过 + 没有任何节点」时触发一次，标记持久化 ⇒
 *     用户把节点删光后**不会**被自动铺回来（老板要求：删了就是删了）。
 *   · 诚信红线：AI 失败降级模板时**必须可见**（角标 + 文案），不许用同一句「豆芽已铺」冒充 AI 产出。
 *   · viewer 只读：日历照常可看，四个写回调一律短路、不落库。
 *
 * Props：
 *   companyType    主体类型（缺省取当前企业 type，再兜底 manufacturer）
 *   onSelectModule 跨模块跳转（保留给后续入口用；当前不主动跳）
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Tag } from 'antd';
import CalendarView from './CalendarView.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingGoal, useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useMonthlyPlan } from '../store/monthlyPlanStore.jsx';
import {
  flattenAllDirections,
  flattenDirectionToNodes,
  mergeNodes,
  missingDirections,
  daysToNodes,
  hasAiNodes,
  replaceAiNodes,
} from '../services/planToCalendar.js';
import { generateMonthlyPlan } from '../services/opsPlan.js';

/**
 * 首登第 8 步选择的经营方向（由 App 在首登完成时写入；本组件消费后清空）。
 * ⚠️ 与 TodayOps.jsx / App.jsx 各自独立声明同一字符串常量 —— 这是本仓既有约定
 *   （见 App.jsx 该常量附近的注释），字符串必须保持一致。
 */
const ONBOARD_DIRECTION_KEY = 'douya-onboard-direction';

/** 读「首登选的方向」——只认当前企业的，companyId 不匹配视为没有。 */
function readOnboardDirection(companyId) {
  try {
    const raw = localStorage.getItem(ONBOARD_DIRECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.companyId !== companyId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 消费后清空，避免下次进入被重复使用。 */
function clearOnboardDirection() {
  try {
    localStorage.removeItem(ONBOARD_DIRECTION_KEY);
  } catch {
    /* 隐私模式异常静默 */
  }
}

/** 今天（本地时区）'YYYY-MM-DD'。 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当前月 'YYYY-MM'。 */
function currentMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

export default function MonthlyPlanBoard({ companyType, onSelectModule }) {
  const { message } = AntApp.useApp();
  const { currentCompany, currentRole } = useCompany();
  const { asset } = useMarketingAsset();
  const { goal } = useMarketingGoal();
  const { getKnowledge } = useCompanyKnowledge();
  const { getPlan, saveNodes, addNode, updateNode, removeNode, hasAutoPlanned, markAutoPlanned } = useMonthlyPlan();

  const companyId = currentCompany && currentCompany.id;
  const type = companyType || (currentCompany && currentCompany.type) || 'manufacturer';
  const isViewer = currentRole === 'viewer';

  // 「让豆芽给一套方案」按钮的 busy 态（AI 生成 + 落库期间禁用并显示 loading）。
  const [planSetBusy, setPlanSetBusy] = useState(false);
  // 本次「一套方案」的来源：'ai'（真走 AI）/ 'template'（AI 不可用、本地模板铺排）/ null（未生成）。
  // 诚信红线：降级必须可见 —— 用户要能区分这是 AI 产出还是模板兜底。
  const [planSource, setPlanSource] = useState(null);
  // 自动铺排的单飞 guard：防 StrictMode / 重复 effect 触发两次 AI 请求。换企业时可再次触发。
  const autoPlanRef = useRef(null);
  // 当前展示月份（'YYYY-MM'），受控传给 CalendarView。
  const [calMonth, setCalMonth] = useState(currentMonth);

  // 带日期的月度节点（持久化在 monthlyPlanStore，按日期升序）
  const parsedNodes = useMemo(() => {
    if (!companyId) return [];
    return getPlan(companyId)
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [companyId, getPlan]);

  // 还没铺到日历上的经营方向（用于「把另外 N 个方向也铺上」的增量动作）
  const missDirs = useMemo(() => missingDirections(type, parsedNodes), [type, parsedNodes]);

  // 跨月摘要：让用户一眼知道「一共铺了多少项、跨几个月」，避免只看到当前月就以为只给了几条。
  const planMonthSummary = useMemo(() => {
    if (!parsedNodes.length) return '';
    const months = [...new Set(parsedNodes.map((n) => (n.date || '').slice(0, 7)))].filter(Boolean).sort();
    if (months.length <= 1) return `共 ${parsedNodes.length} 项`;
    const label = months.map((m) => `${Number(m.slice(5, 7))}月`).join(' / ');
    return `共 ${parsedNodes.length} 项 · 跨 ${label}（点月份切换查看）`;
  }, [parsedNodes]);

  function buildPlanCtx() {
    return {
      company: currentCompany,
      asset,
      knowledge: getKnowledge(companyId),
      goalLabel: (goal && goal.label) || '',
    };
  }

  /**
   * 让豆芽给一套方案：优先走 opsPlan 的 AI 生成（结合当前企业），失败降级到本地模板。
   * 两条分支写库方式**不同**（照抄 TodayOps，原因见下）：
   *   AI 成功 → replaceAiNodes：AI 节点 id 恒为 cal-ai-{day}-{index}，两次生成同日会撞 id，
   *     若用 mergeNodes 会被当成「已存在、保护旧内容」而跳过 ⇒ 按钮点了却什么都不变（哑点击）。
   *   AI 失败降级模板 → mergeNodes：保持幂等合并，不动用户已有节点。
   */
  async function givePlanSet() {
    if (!companyId) {
      message.info('请先选择企业，豆芽才能给你排方案');
      return;
    }
    if (planSetBusy) return;
    setPlanSetBusy(true);
    try {
      let incoming = [];
      let usedAI = false;
      try {
        const res = await generateMonthlyPlan(buildPlanCtx());
        if (res && res.days && res.days.length) {
          incoming = daysToNodes(res.days, { startDate: todayStr() });
          usedAI = true;
        }
      } catch {
        incoming = []; // AI 失败：静默降级到模板，不弹 error、不白屏
      }
      if (!incoming.length) {
        // 兜底：模板路径（纯函数，不调 AI / 网络），保持用户可见结果不变
        incoming = flattenAllDirections(type, { startDate: todayStr() });
      }
      if (!incoming.length) {
        message.info('暂时没有可用的方案模板');
        return;
      }
      const merged = usedAI ? replaceAiNodes(parsedNodes, incoming) : mergeNodes(parsedNodes, incoming);
      saveNodes(companyId, merged);
      setPlanSource(usedAI ? 'ai' : 'template');
      if (usedAI) {
        message.success(`豆芽已把一套方案铺进日历（共 ${incoming.length} 个节点），可直接在日历上改`);
      } else {
        message.warning(`AI 暂不可用，已用默认方案模板铺进日历（共 ${incoming.length} 个节点），可在日历上改`);
      }
    } finally {
      setPlanSetBusy(false);
    }
  }

  // 把还没铺过的方向一键追加到日历（只追加缺失方向，不覆盖用户已改的节点 —— mergeNodes 按 id 幂等）
  function addMissingDirections() {
    if (!companyId || !missDirs.length) return;
    const incoming = missDirs.flatMap((d) => flattenDirectionToNodes(d.key, { startDate: todayStr(), companyType: type }));
    if (!incoming.length) {
      message.info('暂时没有可追加的方向');
      return;
    }
    saveNodes(companyId, mergeNodes(parsedNodes, incoming));
    message.success(`已把另外 ${missDirs.length} 个方向铺进日历，旧内容保持你改过的样子`);
  }

  /** 日历「＋」新增节点：CalendarView 已生成唯一 id，此处再兜底补一个。 */
  function addCalendarNode(node) {
    if (!companyId) return;
    const base = node && typeof node === 'object' ? node : {};
    const id = base.id || `cal-manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    addNode(companyId, { ...base, id });
  }

  /**
   * 录入后自动给一套方案（老板要的「录完就有一套」）。
   * 仅在该企业「从未被自动铺过 + 当前没有任何节点」时触发一次；标记持久化到 store（跨 remount / 重启有效），
   * 因此用户把节点删光之后不会再被自动铺回来（尊重用户的删除）。
   * 铺排范围（降级时）：首登第 8 步明确选了方向 → 只铺该方向；否则铺全部方向。
   */
  useEffect(() => {
    if (isViewer) return;                              // viewer 只读：不往 store 写数据
    if (!companyId) return;
    if (hasAutoPlanned(companyId)) return;             // 处理过就不再碰（含用户删光的情况）
    if (parsedNodes.length > 0) {                      // 已有节点（用户改过 / 手动加过）→ 视为已处理
      markAutoPlanned(companyId);
      return;
    }
    if (autoPlanRef.current === companyId) return;     // 单飞：同一企业只自动铺一次，防重复请求 AI
    autoPlanRef.current = companyId;
    let cancelled = false;
    (async () => {
      const pending = readOnboardDirection(companyId);
      let incoming = [];
      let usedAI = false;
      try {
        const res = await generateMonthlyPlan(buildPlanCtx());
        if (res && res.days && res.days.length) {
          incoming = daysToNodes(res.days, { startDate: todayStr() });
          usedAI = true;
        }
      } catch {
        incoming = [];
      }
      if (!incoming.length) {
        incoming = pending && pending.directionKey
          ? flattenDirectionToNodes(pending.directionKey, { startDate: todayStr(), companyType: type })
          : flattenAllDirections(type, { startDate: todayStr() });
      }
      if (cancelled) return;                           // 已卸载 / 企业已切换：绝不写库、绝不 markAutoPlanned
      if (!incoming.length) return;                    // 取不到方案：不标记，下次进入可重试
      saveNodes(companyId, mergeNodes([], incoming));
      markAutoPlanned(companyId);
      clearOnboardDirection();
      setPlanSource(usedAI ? 'ai' : 'template');
      if (!usedAI) {
        // 降级可见：不冒称「豆芽已铺」，如实说明用了默认模板。
        message.info('AI 暂不可用，已先把默认方案模板铺进日历，可在日历上改');
      }
    })();
    return () => { cancelled = true; };
  }, [isViewer, companyId, type, saveNodes, hasAutoPlanned, markAutoPlanned, parsedNodes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!companyId) {
    return (
      <div className="today-empty" data-board="monthly-plan">
        先在上方选择企业，豆芽才能给你排这个月的方案。
      </div>
    );
  }

  return (
    <div data-board="monthly-plan">
      <div className="today-suggest-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="today-panel-title">🗓 豆芽给你排好的方案</span>
        <span className="today-panel-sub">带真实日期 · 直接点日历上的节点就能改期 / 改名 / 删 / 加</span>
        {planMonthSummary && <span className="today-panel-sub">{planMonthSummary}</span>}
        {/* 诚信角标：本次「一套方案」是 AI 产出还是模板降级，持久可见（不只靠一次性 toast）。 */}
        {planSource === 'template' && <Tag color="orange">模板铺排（AI 暂不可用）</Tag>}
        {planSource === 'ai' && <Tag color="green">豆芽 AI 生成</Tag>}
        {/* AI 方案（cal-ai-*）不在方向白名单里，会被 directionsInNodes 当成「一个方向都没铺」，
            导致日历上明明有 AI 方案却跳出「把另外 N 个方向也铺上」，点一下就把模板混进来。
            故加 !hasAiNodes 抑制该按钮。 */}
        {!isViewer && missDirs.length > 0 && parsedNodes.length > 0 && !hasAiNodes(parsedNodes) && (
          <Button size="small" type="primary" ghost onClick={addMissingDirections}>
            把另外 {missDirs.length} 个方向也铺上
          </Button>
        )}
        {!isViewer && (
          <Button size="small" type="primary" ghost onClick={givePlanSet} loading={planSetBusy}>
            {parsedNodes.length ? '让豆芽重新给一套方案' : '让豆芽给一套方案'}
          </Button>
        )}
      </div>

      {/* 月历：一套方案已铺进日历，直接点节点就能改。
          viewer 只读：日历照常渲染可看，但四个写回调均被 isViewer 短路、不落库。 */}
      <CalendarView
        nodes={parsedNodes}
        month={calMonth}
        onMonthChange={setCalMonth}
        onUpdateNode={(id, patch) => { if (!isViewer) updateNode(companyId, id, patch); }}
        onDeleteNode={(id) => { if (!isViewer) removeNode(companyId, id); }}
        onAddNode={(node) => { if (!isViewer) addCalendarNode(node); }}
      />

      {parsedNodes.length === 0 && (
        <div className="today-empty" style={{ marginTop: 8 }}>
          这个月还没有排好的方案。点上面的「让豆芽给一套方案」，它会按你的经营方向排一整套带日期的安排。
        </div>
      )}
    </div>
  );
}
