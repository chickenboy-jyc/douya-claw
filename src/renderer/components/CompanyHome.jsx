import React from 'react';
import { Button } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { getTypeConfig } from '../config/companyTypeConfig.js';

const ROLE_LABEL = { admin: '管理员', operator: '运营', viewer: '查看' };

/**
 * 「我的企业」列表页（第二阶段）。
 * 展示当前工作空间下的所有企业：图标 / 名称 / 类型 / 角色 / 当前标记。
 * 点企业卡片 → 切换并进入工作台；底部「添加企业」→ 进入分步初始化流程。
 */
export default function CompanyHome({ onSelect, onAdd, onBack }) {
  const { workspaceCompanies, currentCompanyId, switchCompany, workspace, currentWorkspaceId } = useCompany();

  function enter(c) {
    switchCompany(c.id);
    if (onSelect) onSelect(c.id);
  }

  return (
    <div className="ch-overlay">
      <div className="ch-card">
        <div className="ch-head">
          <div>
            <div className="ch-title">我的企业</div>
            <div className="ch-sub">
              📦 {workspace && workspace.name}
              {currentWorkspaceId ? ' · 当前工作空间' : ''}
            </div>
          </div>
          {onBack && (
            <Button size="small" type="text" onClick={onBack}>返回工作台</Button>
          )}
        </div>

        {workspaceCompanies.length === 0 ? (
          <div className="ch-empty">
            <div className="ch-empty-icon">🏢</div>
            <div className="ch-empty-title">还没有企业</div>
            <div className="ch-empty-sub">创建你的第一家企业，开始营销运营</div>
            <Button type="primary" onClick={onAdd}>+ 添加企业</Button>
          </div>
        ) : (
          <div className="ch-grid">
            {workspaceCompanies.map((c) => {
              const cfg = getTypeConfig(c.type);
              const isCurrent = c.id === currentCompanyId;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={'ch-item' + (isCurrent ? ' current' : '')}
                  onClick={() => enter(c)}
                >
                  <span className="ch-item-icon">{cfg.icon}</span>
                  <span className="ch-item-body">
                    <span className="ch-item-name">
                      {c.name}
                      {isCurrent && <span className="ch-item-cur">当前</span>}
                    </span>
                    <span className="ch-item-meta">
                      {cfg.shortLabel || cfg.label} · {ROLE_LABEL[c.role] || '管理员'}
                    </span>
                  </span>
                  <span className="ch-item-go">→</span>
                </button>
              );
            })}
            <button type="button" className="ch-item ch-item-add" onClick={onAdd}>
              <span className="ch-item-icon">＋</span>
              <span className="ch-item-body">
                <span className="ch-item-name">添加企业</span>
                <span className="ch-item-meta">厂家 / 门诊 分步初始化</span>
              </span>
              <span className="ch-item-go">→</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
