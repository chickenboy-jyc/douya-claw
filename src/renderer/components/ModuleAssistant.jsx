/**
 * ModuleAssistant —— 右侧「豆芽」面板（原「本页智能助手」）。
 *
 * 定位升级（0.8.0）：**不是本页事实的朗读器，而是豆芽以企业运营负责人口吻的对话式引导。**
 *   豆芽先说判断 → 再讲为什么是现在 → 最后给可点击的动作（跳模块），让老板明白「豆芽为什么要我这么做」。
 *   老板可以就本页继续追问，多轮对话保留在面板内。
 *
 * 关键口径：
 *  - 面板本身不留存任何内容（无自己的 localStorage、无跨模块会话）。切模块由 App 传 key 重挂载，
 *    对话随之重置 —— 这是「不做跨模块残留」的既定红线。
 *  - 用户点「记到企业大脑」后，内容落到「企业档案（memories + 时间轴）」，面板只给一行反馈。
 *  - **首屏的静态开场白不得带 `.pa-interpretation` 类**：那个类只属于「AI 真的回复了」的正文，
 *    否则验收脚本会读开场白当结果，断言空过（本项目红线：测试不许说谎）。
 *
 * 数据来源：面板按 moduleKey 自己复算页面事实（services/moduleBrief.buildBrief），
 *   不由各模块组件 publish —— 避免 Tabs 薄壳下多子组件并发发布的竞态。
 * 「本页事实」在 UI 上降级为可折叠的「依据」，仍然完整存在于 DOM（事实不丢，只是不抢主角）。
 *
 * 组件对外签名（冻结）：
 *   <ModuleAssistant moduleKey moduleLabel companyType company companyId onSelectModule />
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'antd';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useCampaign } from '../store/campaignStore.jsx';
import { useDirection } from '../store/directionStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { useMonthlyPlan } from '../store/monthlyPlanStore.jsx';
import { buildAIContext } from '../services/contextBuilder.js';
import douyaLogo from '../assets/douya/douya-logo.webp';
import { guideTurn, MODULE_LABELS, computePlanGuidance, planGuidanceText, getPlanFocus, clearPlanFocus } from '../services/moduleAssistant.js';
import { derivePlanSteps } from '../services/directionDirector.js';
import { buildBrief } from '../services/moduleBrief.js';

/** 本地当天日期 YYYY-MM-DD（用于生成记忆条目名）。 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function ModuleAssistant({ moduleKey, moduleLabel, companyType, onSelectModule, companyId, company }) {
  const { getKnowledge, recordConclusion, map: knowledgeMap } = useCompanyKnowledge();
  // 面板事实来自这几个 store 的持久化数据。**必须订阅它们**：
  // buildBrief 直接读 localStorage，而同文档内 localStorage.setItem 不会触发 React 重渲染，
  // 不订阅就会出现「日历已从 3 项变成 5 项、面板还显示 3 项」这种事实陈旧（割裂）。
  // 这四个值都是 store 的 state（引用稳定直到真正变化），可安全作 useMemo 依赖，不会死循环。
  const { campaigns } = useCampaign();
  const { directions, getActiveDirection } = useDirection();
  const { assets } = useAssets();
  const { plans } = useMonthlyPlan();

  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 对话流：{ role: 'douya' | 'user', text, actions, ai }
  //   ai=true 表示这条是**模型真的回了**（只有这种才给 .pa-interpretation 类）。
  const [messages, setMessages] = useState([]);
  const [ask, setAsk] = useState('');
  const [saved, setSaved] = useState(false);
  const [recordNote, setRecordNote] = useState('');
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const chatRef = useRef(null);

  const label = moduleLabel || MODULE_LABELS[moduleKey] || '工作台';
  // 面板按 moduleKey 自己复算本页事实（读 store/localStorage，无竞态）。
  // 依赖里带上各数据源：任一处变化（改日历 / 建专项 / 换方向 / 加资产 / 写档案）都会重算。
  const facts = useMemo(
    () => buildBrief(moduleKey, { companyId, companyType }).facts,
    [moduleKey, companyId, companyType, campaigns, directions, assets, plans, knowledgeMap],
  );

  // ---- T19：经营方案引导（老板第一优先）----
  // 面板**自己**从 direction store 读当前企业的 active direction 并算「第 N 步 / 共 M 步 + 下一步」，
  // 不新增 prop、不改冻结签名、不由 DirectionModule publish。
  // 好处：老板在任何模块切过来都能看到方案指引，不只是从方案页跳过来时才有。
  // 无 active direction（或该企业无方案）→ planText 为 null → 面板与此前行为完全一致。
  const activeDirection = useMemo(
    () => (companyId ? getActiveDirection(companyId) : null),
    [companyId, getActiveDirection, directions],
  );
  // 阶段清单唯一事实源仍是 directionDirector.derivePlanSteps：planSteps 为空（历史数据）时兜底派生。
  const panelPlanSteps = useMemo(() => {
    if (!activeDirection) return [];
    if (Array.isArray(activeDirection.planSteps) && activeDirection.planSteps.length) return activeDirection.planSteps;
    if (Array.isArray(activeDirection.actions) && activeDirection.actions.length) return derivePlanSteps(activeDirection.actions);
    return [];
  }, [activeDirection, directions]);
  const planGuidance = useMemo(
    () => computePlanGuidance(activeDirection, { steps: panelPlanSteps }),
    [activeDirection, panelPlanSteps],
  );
  const planText = planGuidance.hasPlan ? planGuidanceText(planGuidance) : null;

  // 「本次从哪一步跳过来」：挂载时 peek 一次并立即消费（清空内存级标记），
  // 避免后续普通导航复用旧高亮。用于在指引块顶部提示「你从【第 N 步 · 动作名】过来」。
  const [planFocus] = useState(() => getPlanFocus());
  useEffect(() => {
    clearPlanFocus();
  }, []);
  const planOrigin = useMemo(() => {
    if (!planFocus || !planGuidance.hasPlan) return null;
    if (planFocus.directionId && planGuidance.directionId && planFocus.directionId !== planGuidance.directionId) return null;
    const hit = planGuidance.actions.find((a) => a.id && a.id === planFocus.actionId);
    return { ordinal: hit ? hit.ordinal : null, title: planFocus.actionTitle || '' };
  }, [planFocus, planGuidance]);

  const aiReplies = messages.filter((m) => m.role === 'douya' && m.ai);
  const lastReply = aiReplies.length ? aiReplies[aiReplies.length - 1] : null;

  // 新消息进来后滚到底（对话式面板的基本体感）。
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  /**
   * 跑一轮：组装上下文 → 调 guideTurn → 追加豆芽回复。
   * @param {string} question 老板的追问；空串 = 「我现在该做什么」的开场引导。
   */
  async function runTurn(question) {
    if (busy) return;
    const q = question == null ? '' : String(question).trim();
    setBusy(true);
    setError('');
    setRecordNote('');
    // 本轮的对话历史 = 目前已有的（追问时先把老板那句挂上去，让界面立刻有反馈）
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    if (q) setMessages((prev) => [...prev, { role: 'user', text: q, actions: [], ai: false }]);
    try {
      // 每次重算一次，防同模块内事实变陈旧（成本极低）。
      const fresh = buildBrief(moduleKey, { companyId, companyType });
      let context = null;
      try {
        context = buildAIContext({ company: company || undefined, knowledge: getKnowledge(companyId) });
      } catch {
        context = undefined;
      }
      const r = await guideTurn({
        moduleKey,
        moduleLabel: label,
        focalFacts: fresh.facts,
        topics: fresh.topics,
        context,
        company: company || undefined,
        history,
        question: q,
      });
      if (!r || r.ok !== true) {
        setError((r && r.error) || '豆芽没接上，请重试');
        return;
      }
      setMessages((prev) => [...prev, { role: 'douya', text: r.reply, actions: r.actions || [], ai: true }]);
    } catch (e) {
      setError((e && e.message) || '豆芽没接上，请重试');
    } finally {
      setBusy(false);
    }
  }

  /** 发送追问。 */
  function handleAsk() {
    const q = ask.trim();
    if (!q || busy) return;
    setAsk('');
    runTurn(q);
  }

  /** 记到企业大脑：把豆芽这一轮的判断与建议写入企业记忆（memories + 时间轴）。 */
  function handleRecord() {
    if (saved || !lastReply || !lastReply.text) return;
    if (!companyId) {
      setRecordNote('尚未选择企业，无法记入');
      return;
    }
    if (typeof recordConclusion !== 'function') {
      setRecordNote('记录功能不可用');
      return;
    }
    try {
      recordConclusion(companyId, {
        label: '本页解读',
        name: `${label}·${todayStr()}`,
        content: lastReply.text,
      });
      setSaved(true);
      setRecordNote('已记入企业大脑');
    } catch (e) {
      setRecordNote('记录失败：' + ((e && e.message) || '未知错误'));
    }
  }

  /** 下一步引导跳转。 */
  function handleStep(step) {
    if (step && step.module && typeof onSelectModule === 'function') onSelectModule(step.module);
  }

  if (collapsed) {
    return (
      <aside className="page-assistant collapsed">
        <button className="pa-collapse" onClick={() => setCollapsed(false)} title="展开豆芽" aria-label="展开豆芽">‹</button>
        <div className="pa-collapsed-label">豆芽</div>
      </aside>
    );
  }

  return (
    <aside className="page-assistant">
      <div className="pa-head">
        <div className="pa-head-title">
          <span className="pa-title">豆芽</span>
          <span className="pa-badge" title={label}>{label}</span>
        </div>
        <button className="pa-collapse" onClick={() => setCollapsed(true)} title="收起" aria-label="收起">›</button>
      </div>

      <div className="pa-body" ref={chatRef}>
        {/* T19：方案引导块（老板第一优先）。仅当有 active direction 且有引导动作时渲染；
            无方案的企业 → 不渲染，面板行为与既有一致。**静态文案，不带 .pa-interpretation**
            （那个类只属于「AI 真的回了」的正文，见文件头红线）。 */}
        {planText ? (
          <div
            className="pa-plan-guide"
            style={{ margin: '0 0 10px', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--c-brand-tint)', background: 'var(--c-brand-wash)' }}
          >
            <div className="pa-plan-guide-head" style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-brand-dark)' }}>
              {planText.header}
            </div>
            {planOrigin ? (
              <div className="pa-plan-guide-origin" style={{ marginTop: 6, fontSize: 12, color: 'var(--c-warn)' }}>
                你从「{planOrigin.ordinal ? `第 ${planOrigin.ordinal} 步 · ` : ''}{planOrigin.title}」过来
              </div>
            ) : null}
            {planText.next ? (
              <div className="pa-plan-guide-next" style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5 }}>
                <span className="pa-plan-guide-k" style={{ display: 'inline-block', marginRight: 6, padding: '0 6px', borderRadius: 6, background: 'var(--c-brand)', color: 'var(--c-on-brand)', fontSize: 12 }}>
                  下一步
                </span>
                <span className="pa-plan-guide-v">{planText.next}</span>
              </div>
            ) : null}
            {planText.nextNext ? (
              <div className="pa-plan-guide-next2" style={{ marginTop: 4, fontSize: 12, color: 'var(--c-text-2)' }}>
                {planText.nextNext}
              </div>
            ) : null}
            {planText.done ? (
              <div className="pa-plan-guide-done" style={{ marginTop: 6, fontSize: 13, color: 'var(--c-brand-dark)' }}>
                {planText.done}
              </div>
            ) : null}
          </div>
        ) : null}
        {messages.length === 0 ? (
          <div className="pa-intro">
            <img className="pa-avatar" src={douyaLogo} alt="" aria-hidden="true" draggable="false" />
            <div className="pa-intro-text">
              我是豆芽。你不用先看数据 —— 我先告诉你这一页现在最该做什么、为什么是现在做，你再来判断。
            </div>
          </div>
        ) : (
          <div className="pa-thread">
            {messages.map((m, i) => (
              <div className={`pa-bubble ${m.role === 'user' ? 'pa-bubble-user' : 'pa-bubble-douya'}`} key={i}>
                {m.role === 'douya' ? <img className="pa-avatar" src={douyaLogo} alt="" aria-hidden="true" draggable="false" /> : null}
                <div className="pa-bubble-body">
                  {m.role === 'douya' && m.ai ? (
                    <div className="pa-interpretation">{m.text}</div>
                  ) : (
                    <div className="pa-bubble-text">{m.text}</div>
                  )}
                  {Array.isArray(m.actions) && m.actions.length > 0 ? (
                    <div className="pa-next">
                      {m.actions.map((s, j) => (
                        <button className="pa-step" key={(s.module || '') + j} onClick={() => handleStep(s)}>
                          <span className="pa-step-label">{s.label}</span>
                          {s.why ? <span className="pa-step-why">{s.why}</span> : null}
                          {MODULE_LABELS[s.module] ? <span className="pa-step-target">前往 · {MODULE_LABELS[s.module]} ›</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="pa-bubble pa-bubble-douya">
                <img className="pa-avatar" src={douyaLogo} alt="" aria-hidden="true" draggable="false" />
                <div className="pa-bubble-body">
                  <div className="pa-bubble-text pa-bubble-thinking">豆芽正在看这一页…</div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {error ? <div className="pa-error">{error}</div> : null}

        {/* 开场引导（还没聊过时是主按钮；聊过之后只作为「重新判断一次」） */}
        <Button
          type="primary"
          block
          className="pa-interpret-btn"
          loading={busy}
          onClick={() => runTurn('')}
        >
          {messages.length === 0 ? '豆芽，我现在该做什么？' : '让豆芽重新判断一次'}
        </Button>

        {/* 追问：多轮对话入口 */}
        <div className="pa-ask">
          <input
            className="pa-ask-input"
            value={ask}
            placeholder="追问豆芽：为什么要先做这个？"
            disabled={busy}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAsk(); }}
          />
          <button
            className="pa-ask-send"
            onClick={handleAsk}
            disabled={busy || !ask.trim()}
            title="发送追问"
            aria-label="发送追问"
          >
            发送
          </button>
        </div>

        {lastReply ? (
          <>
            <Button block className="pa-record-btn" disabled={saved} onClick={handleRecord}>
              {saved ? '已记入企业大脑' : '记到企业大脑'}
            </Button>
            {recordNote ? <div className="pa-record-note">{recordNote}</div> : null}
          </>
        ) : null}

        {/* 依据：本页事实降级到这里（默认收起，事实不丢） */}
        <div className={`pa-evidence${evidenceOpen ? ' open' : ''}`}>
          <button className="pa-evidence-toggle" onClick={() => setEvidenceOpen((v) => !v)}>
            依据 · 本页 {facts.length} 条事实 {evidenceOpen ? '▾' : '▸'}
          </button>
          <div className="pa-evidence-body">
            {facts.length === 0 ? (
              <div className="pa-empty">当前页暂无可读信息</div>
            ) : (
              <div className="pa-facts">
                {facts.map((f, i) => (
                  <div className="pa-fact" key={(f.label || '') + i}>
                    <span className="pa-fact-k">{f.label || '—'}</span>
                    <span className="pa-fact-v">{f.value || '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="pa-foot">豆芽的判断基于本页事实与企业档案；对话不留存，点「记到企业大脑」才会记入企业档案。</div>
    </aside>
  );
}
