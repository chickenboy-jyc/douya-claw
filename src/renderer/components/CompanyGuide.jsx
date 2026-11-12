import React from 'react';
import { Tag, Button } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingGoal, useMarketingAsset } from '../store/marketingStore.jsx';

/**
 * 切换企业引导（P0-3）：轻提示横幅，不强制弹窗。
 * 企业切换后检测「未建档 / 未选目标 / 未建项目」三类缺口，逐条给出「去完成」入口；
 * 全部完成或用户主动关闭后消失。复用现有建档（资产库）/ 目标 / 项目模块，不重复造轮子。
 */
export default function CompanyGuide({ onClose, onNavigate }) {
  const { currentCompany, currentProject } = useCompany();
  const { goal } = useMarketingGoal();
  const { hasAsset } = useMarketingAsset();

  if (!currentCompany) return null;

  const steps = [
    {
      key: 'asset',
      label: '完善企业资产',
      done: !!hasAsset,
      module: 'asset',
      hint: '建档后下游自动带出企业画像',
    },
    {
      key: 'goal',
      label: '选择营销目标',
      done: !!goal,
      module: 'goal',
      hint: '系统会生成一套落地工作流',
    },
    {
      key: 'project',
      label: '建立项目',
      done: !!currentProject,
      module: 'project',
      hint: '把目标拆成可执行任务',
    },
  ];

  const pending = steps.filter((s) => !s.done);
  if (pending.length === 0) return null;

  return (
    <div className="company-guide">
      <div className="company-guide-head">
        <span className="company-guide-icon">🧭</span>
        <span className="company-guide-title">
          已切换到「{currentCompany.name}」，还有 {pending.length} 步待完成：
        </span>
      </div>
      <div className="company-guide-steps">
        {steps.map((s) => (
          <div key={s.key} className={'company-guide-step' + (s.done ? ' done' : '')}>
            <span className="company-guide-dot">{s.done ? '✓' : ''}</span>
            <span className="company-guide-label">{s.label}</span>
            {!s.done && (
              <Button
                size="small"
                type="primary"
                ghost
                onClick={() => onNavigate && onNavigate(s.module)}
              >
                去完成
              </Button>
            )}
            {s.done && <Tag color="green" style={{ marginInlineStart: 4 }}>已完成</Tag>}
          </div>
        ))}
      </div>
      <button type="button" className="company-guide-close" onClick={onClose} title="关闭引导">
        ✕
      </button>
    </div>
  );
}
