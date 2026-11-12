import React, { useEffect, useRef, useState } from 'react';
import { Modal, Tabs, Input, Select, Button, Popconfirm, Empty } from 'antd';
import { useCompany, COMPANY_TYPE_KEYS } from '../store/companyStore.jsx';
import { companyTypeIcon, companyTypeLabel } from '../config/companyTypeConfig.js';

const ROLE_LABEL = { admin: '管理员', operator: '运营', viewer: '查看' };
const ROLE_OPTIONS = [
  { value: 'admin', label: '管理员 · 增删改查 + 成员管理' },
  { value: 'operator', label: '运营 · 执行任务、产出' },
  { value: 'viewer', label: '查看 · 只读' },
];
/**
 * 企业设置「类型」下拉。
 * ⚠️ 值集合由 `COMPANY_TYPE_KEYS`（归一化白名单 · 5 值含 doctor/dealer）派生 —— 旧实现硬编码 4 值（缺 dealer），
 *    导致经销商企业在设置里保存后 `type` 被 normalizeCompanyType 回写成 manufacturer（静默数据损坏）。
 * ⚠️ 展示文案**唯一来源 = config（`companyTypeIcon` / `companyTypeLabel`）**，本文件不自定义中文名。
 *    全仓类型中文名的唯一真源 = `config/companyTypeConfig.js` 的 label（doctor 口腔医生 / platform 口腔平台）；
 *    若出现第二处硬编码，就会出现「同一类型两个名字」的分裂。
 */
const TYPE_OPTIONS = COMPANY_TYPE_KEYS.map((value) => ({
  value,
  label: `${companyTypeIcon(value)} ${companyTypeLabel(value)}`,
}));

/**
 * 企业设置面板：企业信息（名称/类型/我的角色）+ 成员管理（CompanyMember，本地先行）+ 删除企业。
 * viewer 只读（不可改信息/成员，不可删除企业）。
 * 聊天式弹窗，绿色 Apple 极简。
 */
export default function CompanySettings({ open, onClose }) {
  const {
    currentCompany,
    currentCompanyId,
    currentRole,
    companies,
    companyMembers,
    updateCompany,
    updateCompanyRole,
    removeCompany,
    switchCompany,
    addMember,
    updateMemberRole,
    removeMember,
    workspaces,
    currentWorkspaceId,
    workspace,
    switchWorkspace,
    createWorkspace,
    renameWorkspace,
    removeWorkspace,
  } = useCompany();

  const [name, setName] = useState('');
  const [type, setType] = useState('manufacturer');
  const [role, setRole] = useState('admin');

  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('operator');

  const [newWsName, setNewWsName] = useState('');
  const [renameWsId, setRenameWsId] = useState(null);
  const [renameWsName, setRenameWsName] = useState('');
  const fileRef = useRef(null);

  // 打开时同步当前企业快照到本地 state
  useEffect(() => {
    if (open && currentCompany) {
      setName(currentCompany.name || '');
      setType(currentCompany.type || 'manufacturer');
      setRole(currentCompany.role || 'admin');
      setNewMemberName('');
      setNewMemberRole('operator');
      setNewWsName('');
      setRenameWsId(null);
    }
  }, [open, currentCompany]);

  const isViewer = currentRole === 'viewer';
  const isLastCompany = companies.length <= 1;

  function saveInfo() {
    const n = (name || '').trim();
    if (!n || !currentCompany) return;
    updateCompany(currentCompany.id, { name: n, type, role });
  }

  function submitAddMember() {
    const n = (newMemberName || '').trim();
    if (!n) return;
    addMember(n, newMemberRole);
    setNewMemberName('');
  }

  function submitAddWs() {
    const n = (newWsName || '').trim();
    if (!n) return;
    createWorkspace(n);
    setNewWsName('');
  }

  function submitRenameWs() {
    const n = (renameWsName || '').trim();
    if (!n || !renameWsId) return;
    renameWorkspace(renameWsId, n);
    setRenameWsId(null);
  }

  function confirmDelete() {
    if (!currentCompany) return;
    removeCompany(currentCompany.id);
    onClose();
  }

  // ---- 数据备份 / 恢复（P2 云同步前端落地）----
  function exportData() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('douya-')) {
        data[key] = localStorage.getItem(key);
      }
    }
    const payload = { app: 'douya-claw', exportedAt: new Date().toISOString(), version: 1, data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'douya-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const data = parsed.data || parsed;
        let count = 0;
        Object.keys(data).forEach((key) => {
          if (!key.startsWith('douya-')) return;
          localStorage.setItem(key, typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]));
          count += 1;
        });
        if (count === 0) { alert('未识别到 douya- 前缀的数据，导入失败'); return; }
        window.location.reload();
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="企业设置"
      width={560}
    >
      {!currentCompany ? (
        <Empty description="尚未选择企业" />
      ) : (
        <Tabs
          defaultActiveKey="info"
          items={[
            {
              key: 'workspace',
              label: '工作空间',
              children: (
                <div className="form-grid" style={{ paddingTop: 4 }}>
                  <div className="today-addtask">
                    <Input
                      size="small"
                      value={newWsName}
                      onChange={(e) => setNewWsName(e.target.value)}
                      placeholder="新工作空间名称"
                      onPressEnter={submitAddWs}
                    />
                    <Button size="small" type="primary" onClick={submitAddWs} disabled={!(newWsName || '').trim()}>
                      新建
                    </Button>
                  </div>
                  <div className="member-list">
                    {workspaces.map((w) => (
                      <div key={w.id} className="member-item">
                        <span className="member-avatar">📦</span>
                        {renameWsId === w.id ? (
                          <>
                            <Input
                              size="small"
                              value={renameWsName}
                              onChange={(e) => setRenameWsName(e.target.value)}
                              onPressEnter={submitRenameWs}
                              style={{ flex: 1 }}
                              autoFocus
                            />
                            <Button size="small" type="primary" onClick={submitRenameWs}>保存</Button>
                            <Button size="small" type="text" onClick={() => setRenameWsId(null)}>取消</Button>
                          </>
                        ) : (
                          <>
                            <span className="member-name">
                              {w.name}
                              {w.id === currentWorkspaceId && <span className="cur" style={{ marginLeft: 6 }}>当前</span>}
                            </span>
                            {w.id !== currentWorkspaceId && (
                              <Button size="small" type="text" onClick={() => switchWorkspace(w.id)}>切换</Button>
                            )}
                            <Button
                              size="small"
                              type="text"
                              onClick={() => { setRenameWsId(w.id); setRenameWsName(w.name); }}
                            >
                              重命名
                            </Button>
                            {workspaces.length > 1 && (
                              <Popconfirm
                                title="删除该工作空间及其下所有企业/项目/任务？"
                                okText="删除"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                                onConfirm={() => removeWorkspace(w.id)}
                              >
                                <Button size="small" type="text" danger>删除</Button>
                              </Popconfirm>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="member-tip">工作空间用于团队/代运营隔离，每个空间下可挂多家企业（本地先行，后端 Workspace 属后续阶段）。</div>
                </div>
              ),
            },
            {
              key: 'info',
              label: '企业信息',
              children: (
                <div className="form-grid" style={{ paddingTop: 4 }}>
                  <div className="form-item">
                    <div className="form-label">企业名称</div>
                    <Input
                      value={name}
                      disabled={isViewer}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="企业名称"
                    />
                  </div>
                  <div className="form-item">
                    <div className="form-label">企业类型</div>
                    <Select
                      value={type}
                      disabled={isViewer}
                      onChange={setType}
                      options={TYPE_OPTIONS}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="form-item">
                    <div className="form-label">我的角色（当前账号在此企业的权限）</div>
                    <Select
                      value={role}
                      disabled={isViewer}
                      onChange={setRole}
                      options={ROLE_OPTIONS}
                      style={{ width: '100%' }}
                    />
                  </div>
                  {!isViewer && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                      <Button type="primary" onClick={saveInfo} disabled={!(name || '').trim()}>
                        保存
                      </Button>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'members',
              label: `成员 (${companyMembers.length})`,
              children: (
                <div className="form-grid" style={{ paddingTop: 4 }}>
                  {!isViewer && (
                    <div className="today-addtask">
                      <Input
                        size="small"
                        value={newMemberName}
                        onChange={(e) => setNewMemberName(e.target.value)}
                        placeholder="成员姓名"
                        onPressEnter={submitAddMember}
                      />
                      <Select
                        size="small"
                        value={newMemberRole}
                        onChange={setNewMemberRole}
                        options={[
                          { value: 'admin', label: '管理员' },
                          { value: 'operator', label: '运营' },
                          { value: 'viewer', label: '查看' },
                        ]}
                        style={{ width: 100, flexShrink: 0 }}
                      />
                      <Button size="small" type="primary" onClick={submitAddMember} disabled={!(newMemberName || '').trim()}>
                        添加
                      </Button>
                    </div>
                  )}
                  {companyMembers.length === 0 ? (
                    <div className="today-empty">暂无成员，添加后可分配角色协作</div>
                  ) : (
                    <div className="member-list">
                      {companyMembers.map((m) => (
                        <div key={m.id} className="member-item">
                          <span className="member-avatar">{m.name.slice(0, 1)}</span>
                          <span className="member-name">{m.name}</span>
                          {isViewer ? (
                            <span className="member-role-pill">{ROLE_LABEL[m.role] || m.role}</span>
                          ) : (
                            <Select
                              size="small"
                              value={m.role}
                              onChange={(v) => updateMemberRole(m.id, v)}
                              options={[
                                { value: 'admin', label: '管理员' },
                                { value: 'operator', label: '运营' },
                                { value: 'viewer', label: '查看' },
                              ]}
                              style={{ width: 96, flexShrink: 0 }}
                            />
                          )}
                          {!isViewer && (
                            <Popconfirm title="移除该成员？" okText="移除" cancelText="取消" onConfirm={() => removeMember(m.id)}>
                              <Button size="small" type="text" danger>移除</Button>
                            </Popconfirm>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="member-tip">成员数据暂存本机（本地先行），后端 RBAC 与多账号鉴权属后续阶段。</div>
                </div>
              ),
            },
            {
              key: 'danger',
              label: '删除',
              children: (
                <div className="form-grid" style={{ paddingTop: 4 }}>
                  <div className="danger-box">
                    <div className="danger-title">删除「{currentCompany.name}」</div>
                    <div className="danger-desc">将同时删除该企业下的所有项目、任务与成员，此操作不可撤销。</div>
                    <Popconfirm
                      title="确定删除该企业及其全部数据？"
                      okText="确认删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={confirmDelete}
                      disabled={isViewer || isLastCompany}
                    >
                      <Button danger disabled={isViewer || isLastCompany}>
                        删除企业
                      </Button>
                    </Popconfirm>
                    {isLastCompany && <div className="danger-hint">至少保留一家企业，无法删除最后一家</div>}
                    {isViewer && <div className="danger-hint">viewer 角色无删除权限</div>}
                  </div>
                </div>
              ),
            },
            {
              key: 'data',
              label: '数据',
              children: (
                <div className="form-grid" style={{ paddingTop: 4 }}>
                  <div className="danger-box" style={{ borderColor: 'var(--c-border)' }}>
                    <div className="danger-title">数据备份与恢复</div>
                    <div className="danger-desc">
                      把本机所有数据导出成一个 JSON 文件，换机或迁移用。导入会覆盖现有数据，先导出备份。
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <Button type="primary" ghost onClick={exportData}>导出备份</Button>
                      <Button onClick={() => fileRef.current && fileRef.current.click()}>导入备份</Button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={onImportFile}
                      />
                    </div>
                  </div>
                  <div className="member-tip">导入后自动刷新应用生效。自动云同步（对接后端 /api/companies 等）属后续阶段。</div>
                </div>
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}
