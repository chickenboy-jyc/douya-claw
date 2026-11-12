import React from 'react';
import { useMarketingGoal, useMarketingAsset } from '../store/marketingStore.jsx';

/**
 * 当前目标的可视化步骤条：按 GOAL_ROUTES 渲染步骤，可跳转模块，
 * 每步带资产上下文提示；缺口目标（module=null）渲染缺口提示而非死链。
 */
export default function WorkflowSteps({ onSelectModule, activeModule }) {
  const { goal, route, clearGoal } = useMarketingGoal();
  const { hasAsset } = useMarketingAsset();

  if (!goal) return null;

  const steps = (route && route.steps) || [];

  function switchGoal() {
    clearGoal();
    if (onSelectModule) onSelectModule('goal');
  }

  return (
    <div className="wf-bar">
      <div className="wf-bar-head">
        <span className="wf-bar-icon">{goal.icon}</span>
        <span className="wf-bar-goal">当前目标：{goal.label}</span>
        <span className={'wf-asset-state' + (hasAsset ? ' ok' : '')}>
          {hasAsset ? '✅ 已建档' : '⚠️ 未建档'}
        </span>
        <button type="button" className="wf-switch" onClick={switchGoal} title="重新选择营销目标">
          切换目标
        </button>
      </div>

      {steps.length > 0 ? (
        <div className="wf-step-list">
          {steps.map((s, i) => {
            const active = activeModule === s.module;
            const isAssetStep = s.module === 'asset';
            return (
              <button
                key={s.key}
                type="button"
                className={
                  'wf-step' +
                  (active ? ' active' : '') +
                  (isAssetStep && !hasAsset ? ' todo' : '')
                }
                onClick={() => onSelectModule && onSelectModule(s.module)}
              >
                <span className="wf-step-idx">{i + 1}</span>
                <span className="wf-step-body">
                  <span className="wf-step-title">{s.title}</span>
                  {s.hint && <span className="wf-step-hint">{s.hint}</span>}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="wf-gap">
          <span className="wf-gap-icon">🚧</span>
          <span className="wf-gap-text">{route.gap || '该目标暂未配置工作流。'}</span>
        </div>
      )}
    </div>
  );
}
