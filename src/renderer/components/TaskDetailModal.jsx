import React, { useMemo, useState } from 'react';
import { Modal, Button, Input, Select, Tag, App as AntApp } from 'antd';
import Markdown from './Markdown.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { useMarketingGoal, useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { resolveCapabilityForType, capabilityLabel, taskTypeLabel } from '../services/capabilityResolver.js';
import { getCapability } from '../capabilities/registry.js';
import { executeTask, createTaskAssetSaver } from '../services/taskExecutor.js';

const STATUS_META = {
  todo: { label: '待做', cls: 'todo' },
  doing: { label: '进行中', cls: 'doing' },
  review: { label: '待审核', cls: 'review' },
  done: { label: '已完成', cls: 'done' },
};
const PRIORITY_LABEL = { low: '低', medium: '中', high: '高', urgent: '紧急' };

/**
 * Task 详情弹窗（阶段五「项目工作台」）。
 * 展示项目 / 任务名称 / 说明 / 负责人 / 截止 / 状态 / 优先级 + AI 输出，
 * 提供「AI 辅助完成 → review → 通过/修改/重新生成/保存资产/完成」审核动作（不自动 done）。
 */
export default function TaskDetailModal({ open, task, onClose }) {
  const { message } = AntApp.useApp();
  const {
    currentCompany, currentProject, workspace, currentRole, currentWorkspaceRole,
    companyMembers, updateTask, updateTaskStatus, completeTaskByAI,
  } = useCompany();
  const { addAsset, updateAsset, listAssets } = useAssets();
  const { goal } = useMarketingGoal();
  const { asset } = useMarketingAsset();
  const { getKnowledge } = useCompanyKnowledge();

  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';
  const isViewer = currentRole === 'viewer';

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  const saveTaskAsset = useMemo(
    () => createTaskAssetSaver({ addAsset, updateAsset, listAssets }),
    [addAsset, updateAsset, listAssets],
  );

  function assetTypeFor(t) {
    const cap = getCapability(resolveCapabilityForType(t.taskType || t.capability, companyType, currentProject && currentProject.type));
    return (cap && cap.assetType) || 'document';
  }

  const cap = resolveCapabilityForType(task && (task.taskType || task.capability), companyType, currentProject && currentProject.type);

  async function runAI() {
    if (!task || busy) return;
    setBusy(true);
    setStage(null);
    try {
      const res = await executeTask(task, {
        company: currentCompany,
        project: currentProject,
        workspace,
        asset,
        knowledge: getKnowledge(currentCompany && currentCompany.id),
        goalLabel: (goal && goal.label) || '',
        role: currentRole || 'admin',
        workspaceRole: currentWorkspaceRole || 'admin',
        updateTaskStatus,
        completeTaskByAI,
        saveAsset: (assetType, t, content, scope) => saveTaskAsset(assetType, t, content, scope),
        onStage: setStage,
      });
      if (res.ok) {
        message.success('AI 已完成，进入待审核' + (res.assetId ? '，并已生成项目资产' : ''));
      } else if (res.building) {
        message.info(res.error || '该能力正在建设中');
      } else {
        message.error(res.error || 'AI 执行失败');
      }
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  function advance(status) {
    if (!task) return;
    const ok = updateTaskStatus(task.id, status);
    if (!ok) message.warning('状态流转不允许');
  }

  function saveAsAsset() {
    if (!task || !task.aiOutput || !currentCompany) return;
    saveTaskAsset(assetTypeFor(task), task, task.aiOutput, {
      companyId: currentCompany.id,
      projectId: currentProject ? currentProject.id : null,
    });
    message.success('已保存为项目资产');
  }

  function startEdit() {
    if (!task) return;
    setEditContent(task.aiOutput || '');
    setEditing(true);
  }
  function commitEdit() {
    if (!task) return;
    updateTask(task.id, { aiOutput: editContent });
    message.success('已保存修改');
    setEditing(false);
  }

  function setMeta(key, value) {
    if (!task) return;
    updateTask(task.id, { [key]: value });
  }

  if (!task) return null;

  const st = STATUS_META[task.status] || STATUS_META.todo;
  const assigneeOptions = companyMembers.map((m) => ({ value: m.name, label: m.name }));

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      title={null}
      destroyOnHidden
    >
      <div className="td">
        <div className="td-head">
          <div className="td-title">{task.title}</div>
          <div className="td-tags">
            <Tag color="green">{capabilityLabel(cap)}</Tag>
            {task.taskType && <Tag>{taskTypeLabel(task.taskType)}</Tag>}
            <Tag color={st.cls === 'review' ? 'orange' : st.cls === 'done' ? 'green' : st.cls === 'doing' ? 'blue' : 'default'}>{st.label}</Tag>
            {task.priority && <Tag>{PRIORITY_LABEL[task.priority] || task.priority}</Tag>}
          </div>
        </div>

        <div className="td-meta">
          <div className="td-meta-row">
            <span className="td-meta-k">项目</span>
            <span className="td-meta-v">{currentProject ? currentProject.name : '—'}</span>
          </div>
          <div className="td-meta-row">
            <span className="td-meta-k">负责人</span>
            {isViewer ? (
              <span className="td-meta-v">{task.assigneeId || '未指定'}</span>
            ) : (
              <Select
                size="small"
                value={task.assigneeId || undefined}
                onChange={(v) => setMeta('assigneeId', v)}
                options={assigneeOptions}
                placeholder="选择或输入负责人"
                style={{ width: 200 }}
                allowClear
                showSearch
                optionFilterProp="label"
              />
            )}
          </div>
          <div className="td-meta-row">
            <span className="td-meta-k">截止</span>
            {isViewer ? (
              <span className="td-meta-v">{task.dueAt || '未设置'}</span>
            ) : (
              <Input
                size="small"
                value={task.dueAt || ''}
                onChange={(e) => setMeta('dueAt', e.target.value)}
                placeholder="例如：9月5日"
                style={{ width: 200 }}
              />
            )}
          </div>
          <div className="td-meta-row">
            <span className="td-meta-k">优先级</span>
            {isViewer ? (
              <span className="td-meta-v">{PRIORITY_LABEL[task.priority] || '中'}</span>
            ) : (
              <Select
                size="small"
                value={task.priority || 'medium'}
                onChange={(v) => setMeta('priority', v)}
                options={Object.keys(PRIORITY_LABEL).map((k) => ({ value: k, label: PRIORITY_LABEL[k] }))}
                style={{ width: 120 }}
              />
            )}
          </div>
        </div>

        {task.description && <div className="td-desc">{task.description}</div>}

        {task.aiOutput && !editing && (
          <div className="td-result">
            <div className="td-result-head">AI 输出结果</div>
            <div className="td-result-body"><Markdown>{task.aiOutput}</Markdown></div>
          </div>
        )}
        {editing && (
          <div className="td-edit">
            <Input.TextArea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={14}
              placeholder="编辑 AI 生成的内容"
            />
          </div>
        )}

        <div className="td-actions">
          {task.status === 'todo' && (
            <>
              <Button size="small" onClick={() => advance('doing')}>开始</Button>
              {!isViewer && <Button size="small" type="primary" loading={busy} onClick={runAI}>AI 辅助完成</Button>}
            </>
          )}
          {task.status === 'doing' && (
            <>
              {!isViewer && <Button size="small" type="primary" loading={busy} onClick={runAI}>AI 辅助完成</Button>}
              <Button size="small" onClick={() => advance('review')}>提交审核</Button>
            </>
          )}
          {task.status === 'review' && (
            <>
              {!isViewer && <Button size="small" type="primary" onClick={() => advance('done')}>通过</Button>}
              {!isViewer && <Button size="small" onClick={() => advance('doing')}>打回</Button>}
              {!isViewer && <Button size="small" loading={busy} onClick={runAI}>重新生成</Button>}
              {task.aiOutput && !isViewer && <Button size="small" onClick={startEdit}>修改</Button>}
              {task.aiOutput && <Button size="small" onClick={saveAsAsset}>保存为项目资产</Button>}
            </>
          )}
          {task.status === 'done' && (
            <>
              {task.aiOutput && !editing && <Button size="small" onClick={startEdit}>查看 / 修改</Button>}
              {task.aiOutput && <Button size="small" onClick={saveAsAsset}>保存为项目资产</Button>}
              <Button size="small" onClick={() => advance('todo')}>重开</Button>
            </>
          )}
          {editing && (
            <>
              <Button size="small" type="primary" onClick={commitEdit}>保存修改</Button>
              <Button size="small" onClick={() => setEditing(false)}>取消</Button>
            </>
          )}
          <div style={{ flex: 1 }} />
          <Button size="small" type="text" onClick={onClose}>关闭</Button>
        </div>

        {/* AI 执行真实阶段提示 */}
        {busy && (
          <div className="exec-stage" style={{ marginTop: 12 }}>
            <div className="exec-stage-item active">{stage || '准备中…'}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
