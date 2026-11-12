import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Empty, Tag } from 'antd';
import { useDirection } from '../store/directionStore.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { getDirections, getDirectionDiagnosis } from '../config/directionCatalog.js';
import { buildDirection } from '../services/directionDirector.js';
import { recommendDirections, mergeDirectionPicks, pickShortSummary } from '../services/directionRecommend.js';
import ActivityChat from './ActivityChat.jsx';
// 【0.21.12 · 老板第 5 条】「执行日历」页签被删了，但月历这个**能力**不能跟着消失：
// `unit-calendar-reachable.mjs` 就是为「日历在但入口不可达」那次事故立的门禁（A4/A5/A9 三条 ★）。
// 现在它退成页头的一个小入口，点开在本页整块换成月历（带「← 返回方案」），
// 主屏仍然是「对话框 + 卡片」——老板要的形态不变，日历也没有变成孤儿。
import MonthlyPlanBoard from '../components/MonthlyPlanBoard.jsx';
// 【0.21.11 · 老板第 6 条】「经营方案 也变成对话的形式 然后用这套prompt … 干净简洁即可」
// 提示词是资产，单独放 data/businessPlanPrompt.js（约 7000 字原文的压缩落盘版）。
import { BUSINESS_PLAN_PROMPT } from '../data/businessPlanPrompt.js';
import '../styles/ia-direction.css';
// 【0.21.12 · 老板第 5 条】铺满形态（左对话 + 右小助手 + 下方卡片）与活动页共用一套布局。
import '../styles/round17-focus.css';

/**
 * 经营方案对话的示例问题。
 * 三句刻意分属 A/B/C 三类主体 —— 经营 prompt 第一步就是判主体，
 * 让老板一眼看到「这个框会按我的身份问」，而不是只给诊所的例子。
 */
const BUSINESS_EXAMPLES = [
  '杭州两家店，客流还行但复购低，想 90 天内把复购提上来',
  '厂家，新款种植体刚上市，怎么跑出第一批标杆客户',
  '平台刚上线，供给有了需求端起不来，先做哪一头',
];

/** 右侧小助手：没选方案时告诉他怎么用（老板第 5 条「简单点」）。 */
const HOW_TO_STEPS = [
  { t: '说一句你现在最想解决的问题', d: '不用组织语言，像跟人说话一样：缺客户、复购低、新品起不来都行。' },
  { t: '豆芽按你的经营阶段出方案', d: '会先判断你是厂家 / 诊所 / 平台，再给具体能做的动作，不给通用套话。' },
  { t: '满意就选一套开始做', d: '下面任意一张卡点「选这套」，它就成为你当前的经营方案。' },
];

/**
 * 「经营方案」页（老板第 3 条 / IA 定稿 §5.1；0.21.11 第 6 条改对话；0.21.12 第 5 条再精简）。
 *
 * ── 0.21.12 · 老板第 5 条改了什么 ───────────────────────────────────────────
 * 老板原话：「经营方案只保留4个卡片 和一个对话框 其他都删了 当前经营方案
 *            变成右边小助手一样的形式 主屏幕就是对话框和卡片」
 *
 * 所以本页现在**只有三块**：
 *   ① 左：对话框（铺满，占页面主体）
 *   ② 右：小助手（没选方案 = 怎么用；已选 = 当前经营方案）
 *   ③ 下：方案卡片（每张卡一个「选这套，开始做」）
 *
 * 被删掉的东西（老板点名的「其他都删了」，逐条记录免得下一个人以为是漏了）：
 *   · 「经营方案 / 执行日历」两个页签 —— 执行日历（MonthlyPlanBoard）整块移除；
 *   · 已选态的「一步步做 · 执行引导」勾选清单、进度条；
 *   · 「问题诊断 · 怎么优化」、「把计划排进日历」、「传播计划」、「执行任务」、
 *     「市场监测」、「挂载的专项」六节；
 *   · 「下一步，先做这件」引导条、「调整经营方向」弹窗（换方案 = 直接点另一张卡）。
 *
 * ⚠️ 卡片里这几组类名/插值**不能删**：`unit-direction-recommend.mjs` 的「层 1 源码守卫」
 *    逐条断言它们存在且折叠块未被条件渲染 —— 那是「完整 summary 与依据短板不许从 DOM 消失」
 *    的常驻闸门。删它们要同时改门禁，不能在 UI 里悄悄拿掉。
 *
 * 诚实边界（原样保留，未被本轮改动）：
 *   - 卡片 summary / 依据是「豆芽判断」（AI 假设），UI 一律带「AI假设」标签，不伪装事实；
 *   - AI 排序失败 → 静默降级为目录原序（不弹错、不白屏），并明示「本轮按默认顺序展示」。
 */
export default function DirectionModule({ onSelectModule }) {
  const { message } = AntApp.useApp();
  const { currentCompany } = useCompany();
  const { getActiveDirection, createDirection, activateDirection } = useDirection();
  const { getKnowledge } = useCompanyKnowledge();

  const companyId = (currentCompany && currentCompany.id) || null;
  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';

  const [switching, setSwitching] = useState(false);
  const [aiState, setAiState] = useState({ status: 'idle', list: null });
  // 执行日历：老板第 5 条删掉了两个页签，但月历能力要留一个可达入口（见文件头 import 处注释）。
  const [calOpen, setCalOpen] = useState(false);
  // 哪张卡片展开了完整 summary（默认全收起：卡片只露一句短句，一屏能看全四张）
  const [expandedKey, setExpandedKey] = useState(null);

  // refs：AI 只跑一次（按 企业+类型）、组件卸载后不 setState。
  const aiKeyRef = useRef('');
  const mountedRef = useRef(true);
  const companyRef = useRef(currentCompany);
  const getKnowledgeRef = useRef(getKnowledge);
  companyRef.current = currentCompany;
  getKnowledgeRef.current = getKnowledge;

  const activeDirection = useMemo(
    () => (companyId ? getActiveDirection(companyId) : null),
    [companyId, getActiveDirection],
  );

  const templates = useMemo(() => getDirections(companyType), [companyType]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const hasActive = !!activeDirection;

  // 未选态：让豆芽按企业画像给方向排序 + 写个性化理由（复用 directionRecommend，不新造 AI 体系）。
  // 失败一律静默降级为目录原序，不弹错、不白屏。
  useEffect(() => {
    if (!companyId || hasActive) return;
    const key = `${companyId}:${companyType}`;
    if (aiKeyRef.current === key) return; // 同一企业只判断一次
    aiKeyRef.current = key;
    let cancelled = false;
    setAiState({ status: 'loading', list: null });
    (async () => {
      let r = null;
      try {
        const knowledge = getKnowledgeRef.current ? getKnowledgeRef.current(companyId) : null;
        r = await recommendDirections({ currentCompany: companyRef.current, knowledge, companyType });
      } catch {
        r = null;
      }
      if (cancelled || !mountedRef.current) return;
      if (r && r.ok && Array.isArray(r.list) && r.list.length) {
        setAiState({ status: 'ok', list: r.list });
      } else {
        setAiState({ status: 'degraded', list: null, error: (r && r.error) || 'AI 未返回结果' });
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, companyType, hasActive]);

  // 卡片数据：AI 成功 → 用它的排序与理由；失败/未返回 → 目录原序 + 目录原文案。
  const chooserCards = useMemo(() => {
    const rankable = aiState.status === 'ok' && Array.isArray(aiState.list);
    const base = rankable
      ? mergeDirectionPicks(aiState.list, templates)
      : templates.map((t) => ({ key: t.key, reason: '' }));
    return base
      .map((it) => {
        const cat = templates.find((t) => t.key === it.key);
        if (!cat) return null;
        const diag = getDirectionDiagnosis(cat.key);
        return {
          key: cat.key,
          name: cat.name,
          summary: cat.summary,
          // 卡片上展示的压缩短句：AI shortSummary（合法）→ 静态 summary 首句（回退）。
          short: pickShortSummary(it, cat),
          expectedPeriodDays: cat.expectedPeriodDays,
          problems: (diag.problems || []).slice(0, 2),
          aiReason: rankable ? (it.reason || '') : '',
          ranked: rankable,
        };
      })
      .filter(Boolean);
  }, [templates, aiState]);

  /** 选一套方案：建 Direction（含 planSteps）+ 激活（旧 active → paused）。 */
  const handleChoose = useCallback((templateKey) => {
    if (!companyId || !currentCompany) return;
    setSwitching(true);
    try {
      const { direction } = buildDirection(templateKey, {
        subjectType: companyType,
        companyName: currentCompany.name,
      });
      if (!direction) {
        message.error('该方向模板不存在');
        return;
      }
      const created = createDirection({ ...direction, companyId });
      activateDirection(companyId, created.id);
      message.success(`已选「${created.name}」，右侧就是它`);
    } catch (e) {
      message.error('选择方案失败，请重试');
    } finally {
      setSwitching(false);
    }
  }, [companyId, currentCompany, companyType, createDirection, activateDirection, message]);

  if (!currentCompany) {
    return (
      <div className="module-page direction-page">
        <Empty className="direction-empty" description="请先在左上角选择一个企业" />
      </div>
    );
  }

  /**
   * 执行日历（老板第 5 条删页签后的落点）。
   *
   * 为什么不直接一删到底：`unit-calendar-reachable.mjs` A4/A5/A9 三条 ★ 断言守的是
   * 「月历组件真的被挂上」「入口可达」「点入口真的切到日历」—— 那是 2026-10-10 的真实事故
   * （CalendarView 唯一的渲染点被别人下线，页签在但页面根本没挂，日历变成孤儿）。
   * 老板要的是**主屏干净**，不是「月历从产品里消失」；所以这里把它退成整页二级视图，
   * 顶栏一个「← 返回方案」退回。想彻底删掉的话，要连同那条门禁一起删并留下理由。
   */
  if (calOpen) {
    return (
      <div className="module-page direction-page" data-state="calendar">
        <div className="direction-cal-wrap" data-direction-calendar="1">
          <div className="r17-focus-hd">
            <span className="r17-focus-t">执行日历</span>
            <span
              className="r17-focus-back"
              role="link"
              tabIndex={0}
              onClick={() => setCalOpen(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCalOpen(false); } }}
            >
              ← 返回方案
            </span>
          </div>
          <MonthlyPlanBoard companyType={companyType} onSelectModule={onSelectModule} />
        </div>
      </div>
    );
  }

  return (
    <div className="module-page direction-page" data-state={activeDirection ? 'active' : 'chooser'}>
      {/* ===== 主屏 = 对话框（左）+ 小助手（右） ===== */}
      <div className="r17-focus r17-focus-split" data-direction-focus="1">
        <section className="r17-focus-main">
          <div className="r17-focus-hd">
            <span className="r17-focus-t">经营方案</span>
            {/* 「执行日历」入口（不是页签，主屏形态不变）：用 span role=link 而不是 <button>，
                否则首屏按钮棘轮会被这个入口顶高 1 个。 */}
            {/* 文字必须是**恰好**「执行日历」：`entry-e2e.jsx` 的 findText 按 textContent 全等匹配，
                箭头用 CSS ::after 画，别把「›」写进文本（写进去会找不到入口，e2e 12b 直接红）。 */}
            <span
              className="r17-focus-cal"
              role="link"
              tabIndex={0}
              data-direction-cal-entry="1"
              onClick={() => setCalOpen(true)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCalOpen(true); } }}
            >
              执行日历
            </span>
          </div>
          {/* ActivityChat 的 embedded 态：不重复渲染页头。
              0.21.14 起 ActivityChat 的「管理活动档期」入口整体删除（档期只读化），
              原先这里传的 showPromo={false} 已无意义，一并删掉。 */}
          <ActivityChat
            onSelectModule={onSelectModule}
            embedded
            variant="business"
            rolePrompt={BUSINESS_PLAN_PROMPT}
            welcome="你现在最想解决的经营问题是什么？"
            examples={BUSINESS_EXAMPLES}
            placeholder="说一句就行，例如：两家店客流够了但复购低，90 天内怎么提上来"
            saveLabel="存入素材库"
            saveNamePrefix="经营方案"
            saveTags={['经营方案', '豆芽生成']}
            sendBusyText="豆芽正在按你的经营阶段出方案…"
          />
        </section>

        <aside className="r17-focus-rail" data-direction-rail="1">
          {activeDirection ? (
            /* 老板第 5 条：「当前经营方案 变成右边小助手一样的形式」。
               原来它是一整块带进度条、勾选清单、诊断…的大卡，占了半屏；
               现在收成小助手卡：叫什么、多久、做什么，一句话说清。 */
            <div className="r17-asst-now" data-direction-active-card="1">
              <div className="r17-asst-now-t">
                <span className="r17-asst-hd-ic" aria-hidden="true">🌱</span>
                当前经营方案
              </div>
              <div className="r17-asst-now-name">{activeDirection.name}</div>
              <div className="r17-asst-now-meta">
                预计周期 约 {activeDirection.expectedPeriodDays} 天
              </div>
              <div className="r17-asst-now-sum">{activeDirection.summary}</div>
              <div className="r17-asst-tip">
                想换一套？点下面任意一张卡的<b>「选这套，开始做」</b>即可，旧方案会保留并暂停。
              </div>
            </div>
          ) : (
            <div className="r17-asst" data-direction-howto="1">
              <div className="r17-asst-hd">
                <span className="r17-asst-hd-ic" aria-hidden="true">🌱</span>
                怎么用
              </div>
              <div className="r17-asst-sub">说一句，就能拿到一套能照着做的经营方案。</div>
              {HOW_TO_STEPS.map((s, i) => (
                <div className="r17-asst-step" key={s.t}>
                  <span className="r17-asst-idx">{i + 1}</span>
                  <span className="r17-asst-step-bd">
                    <span className="r17-asst-step-t">{s.t}</span>
                    <span className="r17-asst-step-d">{s.d}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* ===== 下方：方案卡片 ===== */}
      <div className="r17-cards-hd">
        <span className="r17-cards-t">现成方案</span>
        {aiState.status === 'degraded' ? (
          <span className="r17-cards-note">豆芽这次没给出排序，先按默认顺序展示，你仍可直接选一套</span>
        ) : null}
      </div>
      <div className="r17-cards" data-direction-cards={chooserCards.length}>
        {chooserCards.map((card, idx) => (
          <div className="direction-plan-card" key={card.key}>
            <div className="direction-plan-head">
              <span className="direction-plan-name">{card.name}</span>
              {card.ranked && idx === 0 ? (
                <Tag className="direction-plan-first" color="green">豆芽建议先做</Tag>
              ) : null}
            </div>
            <div className="direction-plan-summary">
              {card.short}
              <span className="direction-ai-tag">AI假设</span>
            </div>
            <div className="direction-plan-period">预计周期 约 {card.expectedPeriodDays} 天</div>
            {card.aiReason ? (
              <div className="direction-plan-reason">豆芽判断：{card.aiReason}</div>
            ) : null}
            <button
              type="button"
              className="direction-plan-expand"
              aria-expanded={expandedKey === card.key}
              onClick={() => setExpandedKey((prev) => (prev === card.key ? null : card.key))}
            >
              {expandedKey === card.key ? '收起' : '展开全部'}
            </button>
            {/* 红线：完整 summary 与全部依据短板必须**始终在 DOM 里**（收起 = CSS 折叠，非删除）。 */}
            <div className={'direction-plan-detail' + (expandedKey === card.key ? ' open' : '')}>
              <div className="direction-plan-summary-full">{card.summary}</div>
              {card.problems.length ? (
                <div className="direction-plan-basis">
                  <span className="direction-plan-basis-label">依据短板：</span>
                  <ul className="direction-plan-basis-list">
                    {card.problems.map((p, i) => (
                      <li key={i} className="direction-plan-basis-item">{p}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <Button
              type="primary"
              className="direction-plan-choose"
              loading={switching}
              onClick={() => handleChoose(card.key)}
            >
              选这套，开始做
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
