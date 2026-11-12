import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tag, App as AntApp, Steps } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { planGoalCampaign } from '../services/goalGuide.js';
import { suggestedTasksForGoal } from '../services/suggestedTasks.js';
import { goalExecutability } from '../services/goalExecutability.js';

/** 分步 loading 文案：让用户看得见 AI 在干什么。 */
const STAGES = ['正在读取企业画像', '正在匹配打法', '正在编排任务', '完成'];

const PRIORITY_META = {
  high: { text: '高优先', color: 'var(--c-brand-dark)' },
  mid: { text: '中优先', color: 'var(--c-warn)' },
  low: { text: '低优先', color: 'var(--c-text-2)' },
};

/** antd 会给「两字中文」按钮自动插空格，统一走这里去掉，保持视觉一致。 */
const nb = (s) => String(s || '').replace(/\s+/g, '');

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 目标方案预览（营销目标卡片化 · AI 自动建项目）。
 *
 * 点选目标后不再弹 Markdown 引导，而是先让 AI 产出一套作战方案（战役名 / 为什么这么打 /
 * 周期 / KPI / 渠道 / 可勾选任务带 Day N 排期 / 今天就能做的速赢动作），
 * 用户点「就这么干」即一键落成项目 + 任务并跳转项目详情。
 *
 * @param {object} props
 * @param {string} props.goalId 目标 id
 * @param {string} props.goalLabel 目标名
 * @param {Function} [props.onBack] 返回目标列表
 * @param {Function} [props.onDone] 建好后回调（参数为新项目 id），用于跳转项目详情
 * @param {Function} [props.onStartGuide] 只要步骤引导（不建项目）时回调
 */
export default function GoalPlanPreview({ goalId, goalLabel, onBack, onDone, onStartGuide }) {
  const { currentCompany, currentRole, currentProject, createProject, addTasksToProject, seedProjectTasks, switchProject } = useCompany();
  const { asset } = useMarketingAsset();
  const { getKnowledge } = useCompanyKnowledge();
  const { message } = AntApp.useApp();

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const [checked, setChecked] = useState([]);

  const companyId = currentCompany ? String(currentCompany.id) : '';
  // 企业类型：驱动「该身份 × 该目标」的建议任务（companyTypeConfig.suggestedTasks）。
  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';

  // 兜底层：即使有人绕过目标选择页（深链 / 陈旧 state）落到这里，未开通的目标也必须被挡住 ——
  // 不调 AI 生成方案、不渲染方案/任务、不允许建项目。判据与 GoalSelector 同源（goalExecutability）。
  const ex = goalExecutability(goalId);

  const run = useCallback(async () => {
    setBusy(true);
    setErr('');
    setPlan(null);
    setChecked([]);
    setStage(0);
    const timers = [
      setTimeout(() => setStage(1), 1200),
      setTimeout(() => setStage(2), 2800),
    ];
    try {
      const res = await planGoalCampaign({
        currentCompany,
        asset,
        knowledge: getKnowledge ? getKnowledge(companyId) : undefined,
        project: currentProject,
        goalId,
        goalLabel,
        companyType: (currentCompany && currentCompany.type) || 'manufacturer',
        role: currentRole,
      });
      timers.forEach((t) => clearTimeout(t));
      setStage(3);
      if (!res || !Array.isArray(res.tasks)) {
        setErr('AI 这次没给出方案，点「重新生成」再试一次。');
        return;
      }
      setPlan(res);
      setChecked(res.tasks.map((_, i) => i));
    } catch (e) {
      timers.forEach((t) => clearTimeout(t));
      setStage(3);
      setErr('生成失败：' + ((e && e.message) || '请稍后重试'));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId, goalLabel, companyId, currentRole]);

  useEffect(() => {
    // 兜底层·副作用：早退语句必须在 run() 之前 —— 未开通的目标绝不触发 AI 生成。
    if (!ex.executable) return;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId, ex.executable]);

  const toggle = (i, on) => {
    setChecked((prev) => (on ? (prev.includes(i) ? prev : prev.concat(i)) : prev.filter((x) => x !== i)));
  };
  const toggleAll = () => {
    if (!plan) return;
    const all = plan.tasks.length;
    setChecked(checked.length === all ? [] : plan.tasks.map((_, i) => i));
  };

  const doConfirm = () => {
    // 兜底层·建项目：未开通的目标绝不允许创建执行项目（早退在 createProject( 之前）。
    if (!ex.executable) { message.warning('该目标暂未开通，无法创建执行项目'); return; }
    if (!plan) return;
    if (!currentCompany) {
      message.warning('请先在左上角选择/创建企业');
      return;
    }
    const name = plan.campaignName || `${goalLabel || '营销'}作战计划`;
    const p = createProject(name, goalId, { description: plan.why || '' });
    if (!p) {
      message.error('建项目失败，请重试');
      return;
    }
    const items = plan.tasks
      .filter((_, i) => checked.includes(i))
      .map((t) => ({
        title: t.title,
        description: t.description,
        outputFormat: t.outputFormat,
        priority: t.priority === 'high' ? 'high' : t.priority === 'low' ? 'low' : 'medium',
        dueAt: String(Date.now() + Number(t.dayOffset || 0) * 86400000),
      }));
    if (items.length) addTasksToProject(p.id, items);
    // 【死配置修复】把「该身份 × 该经营目标」在 companyTypeConfig.suggestedTasks 里写死的建议任务
    // 一并落库（此前该配置零消费）。幂等：按标题去重（对同一 projectId 重复调用不重复建）；
    // 未知身份 / 未知 goalId 安全返回 []（不 seed 比 seed 错的好）。
    const curated = suggestedTasksForGoal(companyType, goalId, items.map((it) => it.title));
    if (curated.length) seedProjectTasks(p.id, curated);
    switchProject(p.id);
    message.success(`已建好项目「${name}」，${items.length + curated.length} 个任务已排好期`);
    if (onDone) onDone(p.id);
  };

  const selectedCount = useMemo(() => (plan ? plan.tasks.filter((_, i) => checked.includes(i)).length : 0), [plan, checked]);

  // 兜底层·渲染：未开通的目标只渲染解释面板 —— 绝不渲染「就这么干」按钮、绝不渲染任务列表。
  if (ex.executable === false) {
    return (
      <div className="gpp">
        <div className="gpp-gap">
          <span className="gpp-gap-icon">🚧</span>
          <div className="gpp-gap-body">
            <div className="gpp-gap-title">该目标暂未开通</div>
            <div className="gpp-gap-goal">🎯 {goalLabel || goalId}</div>
            <div className="gpp-gap-text">{ex.gap}</div>
            <div className="gpp-gap-honest">
              为了不给你一份看起来能用、其实跑不下去的计划，这里不会生成方案，也不会创建项目和任务。
            </div>
            <div className="gpp-gap-actions">
              <Button onClick={() => onBack && onBack()}>{nb('← 返回目标')}</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gpp">
      <div className="gpp-head">
        <div className="gpp-head-left">
          <span className="gpp-goal-pill">🎯 {goalLabel || goalId}</span>
          <h2 className="gpp-title">{plan ? plan.campaignName : 'AI 正在为你编排作战方案'}</h2>
          <p className="gpp-sub">
            {plan ? '确认无误就点「就这么干」，项目和执行任务会一次性建好。' : '不用填表，AI 读完企业画像直接给方案。'}
          </p>
        </div>
        <Button onClick={() => onBack && onBack()}>{nb('← 返回目标')}</Button>
      </div>

      <div className="gpp-body">
        {busy && (
          <div className="gpp-loading">
            <Steps
              direction="vertical"
              size="small"
              current={stage}
              items={STAGES.map((s) => ({ title: s }))}
            />
            <div className="gpp-loading-tip">{STAGES[Math.min(stage, STAGES.length - 1)]}…</div>
          </div>
        )}

        {!busy && err && (
          <div className="gpp-error">
            <span className="gpp-error-icon">⚠️</span>
            <div className="gpp-error-body">
              <div className="gpp-error-text">{err}</div>
              <div className="gpp-error-actions">
                <Button type="primary" onClick={run}>
                  {nb('🔄 重新生成')}
                </Button>
                <Button onClick={() => onBack && onBack()}>{nb('← 返回目标')}</Button>
              </div>
            </div>
          </div>
        )}

        {!busy && plan && (
          <div className="gpp-plan">
            <div className="gpp-why">
              <span className="gpp-why-label">为什么这么打</span>
              <span className="gpp-why-text">{plan.why || '待补充：企业画像信息不足，先按通用打法执行。'}</span>
            </div>

            <div className="gpp-meta">
              <span className="gpp-meta-item">
                周期 <b>{plan.durationDays}</b> 天
              </span>
              <span className="gpp-meta-item">
                任务 <b>{plan.tasks.length}</b> 条
              </span>
              {plan.channels.length > 0 && (
                <span className="gpp-meta-channels">
                  {plan.channels.map((c) => (
                    <Tag key={c} className="gpp-channel">
                      {c}
                    </Tag>
                  ))}
                </span>
              )}
            </div>

            {plan.kpi.length > 0 && (
              <div className="gpp-block">
                <div className="gpp-block-title">📈 这次要盯的指标</div>
                <div className="gpp-kpi">
                  {plan.kpi.map((k, i) => (
                    <div className="gpp-kpi-item" key={i}>
                      <div className="gpp-kpi-head">
                        <span className="gpp-kpi-name">{k.name}</span>
                        <span className="gpp-kpi-target">{k.target}</span>
                      </div>
                      <div className="gpp-kpi-how">{k.howToMeasure}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="gpp-block">
              <div className="gpp-block-head">
                <div className="gpp-block-title">🧩 执行任务（Day N 排期）</div>
                <Button type="link" size="small" onClick={toggleAll}>
                  {checked.length === plan.tasks.length ? nb('全部取消') : nb('全部选中')}
                </Button>
              </div>
              <div className="gpp-task-list">
                {plan.tasks.map((t, i) => {
                  const on = checked.includes(i);
                  const meta = PRIORITY_META[t.priority] || PRIORITY_META.mid;
                  const due = Date.now() + Number(t.dayOffset || 0) * 86400000;
                  return (
                    <div className={'gpp-task' + (on ? ' on' : '')} key={i} onClick={() => toggle(i, !on)}>
                      <span className={'gpp-task-check' + (on ? ' on' : '')}>{on ? '✓' : ''}</span>
                      <span className="gpp-task-day">
                        Day {t.dayOffset}
                        <em>{fmtDate(due)}</em>
                      </span>
                      <span className="gpp-task-body">
                        <span className="gpp-task-title">{t.title}</span>
                        {t.description && <span className="gpp-task-desc">{t.description}</span>}
                        <span className="gpp-task-meta">
                          {t.outputFormat && <Tag className="gpp-task-out">产出：{t.outputFormat}</Tag>}
                          <span className="gpp-task-pri" style={{ color: meta.color }}>
                            {meta.text}
                          </span>
                          {t.why && <span className="gpp-task-why">{t.why}</span>}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {plan.quickWin && (
              <div className="gpp-quick">
                <div className="gpp-quick-label">⚡ 今天就能做的速赢动作</div>
                <div className="gpp-quick-text">{plan.quickWin}</div>
              </div>
            )}

            <div className="gpp-foot">
              <span className="gpp-foot-count">已选 {selectedCount} / {plan.tasks.length} 条任务</span>
              {onStartGuide && (
                <Button type="link" onClick={() => onStartGuide(goalId)}>
                  {nb('只要步骤引导，不要建项目')}
                </Button>
              )}
              <Button onClick={run}>{nb('🔄 重新生成')}</Button>
              <Button type="primary" disabled={selectedCount === 0} onClick={doConfirm}>
                {nb('✅ 就这么干')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
