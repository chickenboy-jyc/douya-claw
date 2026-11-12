import React, { useState } from 'react';
import { Select, Modal, Input } from 'antd';
import { useCompany, COMPANY_TYPE_KEYS } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { runDeepThink, deepThinkOnce } from '../services/deepThink.js';
import { companyTypeIcon, companyTypeLabel } from '../config/companyTypeConfig.js';
import CompanySettings from './CompanySettings.jsx';

const ADD_KEY = '__add_company__';
const WS_ADD_KEY = '__add_workspace__';

/**
 * 「添加企业」弹窗的类型选项。
 * 🔴 由 `COMPANY_TYPE_KEYS`（白名单 · 5 值）派生，展示文案唯一来源 = config（`companyTypeLabel`）。
 *    旧实现硬编码 4 值（**缺 dealer**）⇒ 无法从本入口创建经销商企业；且文案写死、绕过 SSOT。
 *    此处是「添加/编辑企业」，必须覆盖全部 5 值（含 doctor —— 与首登 4 张卡刻意不同，那里不出现医生卡）。
 */
const ADD_TYPE_OPTIONS = COMPANY_TYPE_KEYS.map((value) => ({
  key: value,
  icon: companyTypeIcon(value),
  label: companyTypeLabel(value),
}));

/**
 * 顶栏「当前工作空间 + 当前企业」切换器 + 添加企业/工作空间弹窗 + 管理企业入口。
 * - 工作空间下拉列出所有工作空间，底部「➕ 新建工作空间」。
 * - 企业下拉列出当前工作空间下的企业，底部「➕ 添加企业」。
 * - 右侧齿轮打开「企业设置」（企业信息/成员/工作空间/删除）。
 */
export default function CompanySwitcher() {
  const {
    workspaceCompanies,
    currentCompany,
    currentCompanyId,
    switchCompany,
    createCompany,
    workspaces,
    currentWorkspaceId,
    workspace,
    switchWorkspace,
    createWorkspace,
  } = useCompany();
  const { getKnowledge, setBrain } = useCompanyKnowledge();
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState('manufacturer');
  const [showWsAdd, setShowWsAdd] = useState(false);
  const [wsName, setWsName] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  function onChange(v) {
    if (v === ADD_KEY) {
      setAddName('');
      setAddType('manufacturer');
      setShowAdd(true);
      return;
    }
    switchCompany(v);
  }

  function onWsChange(v) {
    if (v === WS_ADD_KEY) {
      setWsName('');
      setShowWsAdd(true);
      return;
    }
    switchWorkspace(v);
  }

  function submitAdd() {
    const n = (addName || '').trim();
    if (!n) return;
    const company = createCompany(n, addType);
    setShowAdd(false);

    // 添加企业后台深度思考：新企业尚无营销资产，asset 传空对象兜底（deepThink 内部回退用 company.name + industry 缺省）。
    // 异步、可跳过，出错静默降级；deepThinkOnce 防同企业重复触发。
    const cid = company && company.id;
    if (cid) {
      deepThinkOnce(cid, () => runDeepThink({ company, asset: {}, knowledge: getKnowledge(cid) }))
        .then((brain) => {
          if (brain) setBrain(cid, brain);
        })
        .catch((e) => console.warn('[deepThink] 添加企业深度思考失败，已静默降级', e));
    }
  }

  function submitWsAdd() {
    const n = (wsName || '').trim();
    if (!n) return;
    createWorkspace(n);
    setShowWsAdd(false);
  }

  const wsOptions = workspaces.map((w) => ({
    value: w.id,
    label: `📦 ${w.name}${w.id === currentWorkspaceId ? '　⭐' : ''}`,
  }));
  wsOptions.push({ value: WS_ADD_KEY, label: '➕ 新建工作空间' });

  const options = workspaceCompanies.map((c) => ({
    value: c.id,
    label: `${companyTypeIcon(c.type)} ${c.name}${c.id === currentCompanyId ? '　⭐' : ''}`,
  }));
  options.push({ value: ADD_KEY, label: '➕ 添加企业' });

  return (
    <>
      <Select
        size="small"
        value={currentWorkspaceId}
        onChange={onWsChange}
        options={wsOptions}
        style={{ minWidth: 128, marginRight: 6 }}
        popupMatchSelectWidth={false}
        aria-label="切换工作空间"
        title={`当前工作空间：${workspace && workspace.name}`}
      />
      <Select
        size="small"
        value={currentCompanyId}
        onChange={onChange}
        options={options}
        style={{ minWidth: 150, marginRight: 6 }}
        popupMatchSelectWidth={false}
        aria-label="切换企业"
        title="当前企业"
      />
      <button
        type="button"
        className="switcher-gear"
        onClick={() => setShowSettings(true)}
        title="企业设置"
        aria-label="企业设置"
      >
        ⚙️
      </button>
      <Modal
        open={showAdd}
        onCancel={() => setShowAdd(false)}
        onOk={submitAdd}
        okText="创建"
        cancelText="取消"
        okButtonProps={{ disabled: !(addName || '').trim() }}
        title="添加企业"
        width={420}
      >
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--c-text-2)' }}>企业类型</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          {ADD_TYPE_OPTIONS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setAddType(t.key)}
              style={{
                flex: '1 1 100px',
                minWidth: 96,
                padding: '10px 12px',
                borderRadius: 12,
                border: addType === t.key ? '1.5px solid var(--c-brand)' : '1px solid var(--c-border)',
                background: addType === t.key ? 'var(--c-brand-tint)' : 'var(--c-surface)',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--c-text)',
                textAlign: 'center',
              }}
            >
              <span style={{ fontSize: 16, marginRight: 4 }}>{t.icon}</span>{t.label}
            </button>
          ))}
        </div>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--c-text-2)' }}>企业名称</div>
        <Input
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          placeholder="例如：康健苗苗集团"
          autoFocus
          onPressEnter={submitAdd}
        />
      </Modal>
      <Modal
        open={showWsAdd}
        onCancel={() => setShowWsAdd(false)}
        onOk={submitWsAdd}
        okText="创建"
        cancelText="取消"
        okButtonProps={{ disabled: !(wsName || '').trim() }}
        title="新建工作空间"
        width={420}
      >
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--c-text-2)' }}>工作空间名称</div>
        <Input
          value={wsName}
          onChange={(e) => setWsName(e.target.value)}
          placeholder="例如：康健苗苗代运营 / 汉斯夫团队"
          autoFocus
          onPressEnter={submitWsAdd}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--c-text-3)' }}>一个工作空间可容纳多家企业，用于团队/代运营场景隔离。</div>
      </Modal>
      <CompanySettings open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}
