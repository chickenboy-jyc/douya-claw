import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Tabs, Progress, Tag, Button, Empty, Modal, Select, Input, Popconfirm, App as AntApp } from 'antd';
import Markdown from './Markdown.jsx';
// Markdown → 纯文本的唯一真源（项目资产预览切片前先剥标记）。
import { mdToPlain } from '../utils/mdToPlain.js';
import ProjectAssistant from './ProjectAssistant.jsx';
import TaskDetailModal from './TaskDetailModal.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useAssets, ASSET_TYPES } from '../store/assetStore.jsx';
import { useMarketingGoal, useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { getProjectType } from '../config/projectTypes.js';
import { resolveCapabilityForType, capabilityLabel, taskTypeLabel } from '../services/capabilityResolver.js';
import { getCapability } from '../capabilities/registry.js';
import { executeTask, createTaskAssetSaver, STAGES, formatMs } from '../services/taskExecutor.js';
import { genProjectGuidance } from '../services/projectGuide.js';

const STATUS_META = {
  todo: { label: '待做', cls: 'todo' },
  doing: { label: '进行中', cls: 'doing' },
  review: { label: '待审核', cls: 'review' },
  done: { label: '已完成', cls: 'done' },
};

const PROJECT_STATUS_LABEL = { draft: '草稿', active: '进行中', paused: '已暂停', completed: '已完成', archived: '已归档' };
const PROJECT_STATUS_OPTIONS = Object.keys(PROJECT_STATUS_LABEL).map((k) => ({ value: k, label: PROJECT_STATUS_LABEL[k] }));

/**
 * 项目详情工作台（P0-3 + P1-1）：
 * 概览（目标/周期/状态/KPI/预算）+ 进度（n/m + 进度条）+ 今日任务（待处理/进行中/待审核）
 * + 项目资产（listAssets({companyId,projectId}) 按 type 分组）+ AI 助手 Tab。
 */
export default function ProjectDetail({ onSelectModule, onRunTask, onBack }) {
  const { message } = AntApp.useApp();
  const {
    currentCompany, currentProject, companyProjects, switchProject,
    projectTasks, updateTask, updateTaskStatus, completeTaskByAI, updateProject,
    workspace, currentRole, currentWorkspaceRole,
  } = useCompany();
  const { listAssets, addAsset, updateAsset } = useAssets();
  const { goal } = useMarketingGoal();
  const { asset } = useMarketingAsset();
  const { getKnowledge } = useCompanyKnowledge();

  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';
  const isViewer = currentRole === 'viewer';
  const typeMeta = getProjectType(companyType, currentProject && currentProject.type);
  const projectOptions = companyProjects.map((p) => ({ value: p.id, label: p.name }));

  const saveTaskAsset = useMemo(
    () => createTaskAssetSaver({ addAsset, updateAsset, listAssets }),
    [addAsset, updateAsset, listAssets],
  );

  // 当前项目资料（type=material，注入 AI 上下文）
  const projectMaterials = useMemo(() => {
    if (!currentCompany || !currentProject) return [];
    return listAssets({ companyId: currentCompany.id, projectId: currentProject.id }).filter((a) => a.type === 'material');
  }, [currentCompany, currentProject, listAssets]);

  function assetTypeFor(task) {
    const cap = getCapability(resolveCapabilityForType(task.taskType || task.capability, companyType, currentProject && currentProject.type));
    return (cap && cap.assetType) || 'document';
  }

  const [tab, setTab] = useState('overview');
  const [assistantVisited, setAssistantVisited] = useState(false);
  const [aiBusyId, setAiBusyId] = useState(null);
  const [resultTask, setResultTask] = useState(null); // 展示 aiOutput 的任务
  // AI 执行流水线（可观测）：{ runId, taskId, taskTitle, phase:'running'|'done'|'failed', stages[], startedAt, error, result }
  const [exec, setExec] = useState(null);
  const [fullDoc, setFullDoc] = useState(null); // 结果卡「查看完整内容」{ title, content }
  const abortRef = useRef(null);
  const [tick, setTick] = useState(0); // 200ms 心跳，驱动「实时累计耗时」
  const [editTask, setEditTask] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [taskDetail, setTaskDetail] = useState(null); // Task 详情弹窗
  const [editProject, setEditProject] = useState(null); // 编辑项目弹窗
  const [editProjectDraft, setEditProjectDraft] = useState({});
  // 项目资料
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [materialDraft, setMaterialDraft] = useState({ name: '', category: 'product', content: '', link: '' });
  // AI 统筹建议（概览页）
  const [guidance, setGuidance] = useState({ busy: false, result: null, error: '' });

  function changeTab(k) {
    setTab(k);
    if (k === 'assistant') setAssistantVisited(true);
  }

  const execPhase = exec ? exec.phase : '';
  // 执行中心跳：让「进行中」阶段的耗时实时走动（200ms 一跳，足够顺滑又不烧 CPU）
  useEffect(() => {
    if (execPhase !== 'running') return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [execPhase]);

  const stats = useMemo(() => {
    const s = { todo: 0, doing: 0, review: 0, done: 0 };
    projectTasks.forEach((t) => {
      if (s[t.status] != null) s[t.status] += 1;
    });
    return s;
  }, [projectTasks]);

  const total = projectTasks.length;
  const percent = total ? Math.round((stats.done / total) * 100) : 0;

  // AI 统筹：读项目 + 任务 + 企业画像，产出「下一步该干嘛」的统筹建议
  async function runGuidance() {
    if (guidance.busy) return;
    setGuidance((g) => ({ ...g, busy: true, error: '' }));
    try {
      const r = await genProjectGuidance({
        currentCompany,
        project: currentProject,
        asset,
        knowledge: getKnowledge(currentCompany ? currentCompany.id : ''),
        tasks: projectTasks,
        goalLabel: goal && goal.label ? goal.label : '',
        companyType,
        role: currentRole || 'admin',
      });
      if (r) {
        setGuidance((g) => ({ ...g, busy: false, result: r }));
      } else {
        setGuidance((g) => ({ ...g, busy: false, error: 'AI 统筹失败，请稍后重试' }));
      }
    } catch (e) {
      setGuidance((g) => ({ ...g, busy: false, error: 'AI 统筹失败：' + (e && e.message) }));
    }
  }

  const projectAssets = useMemo(() => {
    if (!currentProject || !currentCompany) return [];
    return listAssets({ companyId: currentCompany.id, projectId: currentProject.id });
  }, [currentCompany, currentProject, listAssets]);

  const assetsByType = useMemo(() => {
    const m = {};
    for (const a of projectAssets) {
      (m[a.type] = m[a.type] || []).push(a);
    }
    return m;
  }, [projectAssets]);

  function groupTasks(status) {
    return projectTasks.filter((t) => t.status === status);
  }

  /** 取企业画像里最有信息量的 1-2 条，用于结果卡「读了哪些上下文」。 */
  function knowledgeHighlights() {
    const k = getKnowledge(currentCompany && currentCompany.id) || {};
    const p = k.profile || {};
    const out = [];
    if (p.brandPositioning) out.push('品牌定位：' + p.brandPositioning);
    if (p.products) out.push('主营产品：' + p.products);
    if (out.length < 2 && Array.isArray(p.targetCustomers) && p.targetCustomers.length) {
      out.push('目标人群：' + p.targetCustomers.slice(0, 3).join('、'));
    }
    if (out.length < 2 && Array.isArray(k.facts) && k.facts.length) out.push('已知事实：' + k.facts[0]);
    return out.slice(0, 2);
  }

  function freshStages() {
    return STAGES.map((s) => ({ key: s.key, label: s.label, status: 'pending', elapsedMs: 0, detail: '', startedAt: 0 }));
  }

  async function runTaskWithAI(t) {
    if (!t || aiBusyId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setAiBusyId(t.id);
    setExec({
      runId: '',
      taskId: t.id,
      taskTitle: t.title,
      phase: 'running',
      stages: freshStages(),
      startedAt: Date.now(),
      error: '',
      result: null,
      highlights: knowledgeHighlights(),
    });
    try {
      const res = await executeTask(t, {
        company: currentCompany,
        project: currentProject,
        workspace,
        asset,
        knowledge: getKnowledge(currentCompany && currentCompany.id),
        goalLabel: (goal && goal.label) || '',
        role: currentRole || 'admin',
        workspaceRole: currentWorkspaceRole || 'admin',
        projectMaterials,
        updateTaskStatus,
        completeTaskByAI,
        saveAsset: (assetType, task, content, scope) => saveTaskAsset(assetType, task, content, scope),
        signal: controller.signal,
        onProgress: (ev) => {
          setExec((prev) => {
            if (!prev || prev.taskId !== t.id) return prev;
            const stages = prev.stages.slice();
            const i = ev.index - 1;
            if (i >= 0 && i < stages.length) {
              stages[i] = {
                ...stages[i],
                status: ev.status,
                elapsedMs: ev.elapsedMs,
                detail: ev.detail || stages[i].detail,
                startedAt: ev.status === 'running' ? Date.now() : stages[i].startedAt,
              };
            }
            return { ...prev, runId: ev.runId || prev.runId, stages };
          });
        },
      });
      if (res.cancelled) {
        setExec((prev) => (prev ? { ...prev, phase: 'cancelled', error: res.error || '已取消执行' } : prev));
        message.info('已取消执行，AI 已产生的内容不会保存');
        return;
      }
      if (res.ok) {
        setExec((prev) => (prev ? {
          ...prev,
          phase: 'done',
          runId: res.runId || prev.runId,
          stages: Array.isArray(res.stages) && res.stages.length ? res.stages.map((s, i) => ({ ...s, startedAt: (prev.stages[i] && prev.stages[i].startedAt) || 0 })) : prev.stages,
          result: {
            content: res.content || '',
            assetId: res.assetId || null,
            summary: res.summary || {},
            capabilityName: (res.summary && res.summary.capabilityName) || '',
          },
        } : prev));
        message.success('AI 已完成，进入待审核' + (res.assetId ? '，并已生成项目资产' : ''));
      } else if (res.building) {
        setExec((prev) => (prev ? {
          ...prev,
          phase: 'failed',
          runId: res.runId || prev.runId,
          error: res.error || '该能力正在建设中',
          stages: Array.isArray(res.stages) && res.stages.length
            ? res.stages.map((s, i) => ({ ...s, startedAt: (prev.stages[i] && prev.stages[i].startedAt) || 0 }))
            : prev.stages,
        } : prev));
        message.info(res.error || '该能力正在建设中');
      } else {
        setExec((prev) => (prev ? {
          ...prev,
          phase: 'failed',
          runId: res.runId || prev.runId,
          error: res.error || 'AI 执行失败',
          stages: Array.isArray(res.stages) && res.stages.length
            ? res.stages.map((s, i) => ({ ...s, startedAt: (prev.stages[i] && prev.stages[i].startedAt) || 0 }))
            : prev.stages,
        } : prev));
        message.error(res.error || 'AI 执行失败');
      }
    } finally {
      abortRef.current = null;
      setAiBusyId(null);
    }
  }

  function cancelExec() {
    if (abortRef.current) abortRef.current.abort();
  }

  function closeExec() {
    setExec(null);
  }

  /** 结果卡「下载」：把 AI 产出存成 .md 文件（Blob 下载，Electron 渲染进程可用）。 */
  function downloadContent(name, content) {
    try {
      const blob = new Blob([String(content || '')], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (String(name || 'AI 产出').replace(/[\\/:*?"<>|]/g, '_') + '.md');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      message.error('下载失败，可先用「查看完整内容」复制');
    }
  }

  // ---------- AI 执行流水线：阶段时间轴 + 结果卡 ----------
  function execTitle() {
    if (exec.phase === 'running') return 'AI 执行中';
    if (exec.phase === 'done') return '这次 AI 替你做了什么';
    if (exec.phase === 'cancelled') return '已取消执行';
    return 'AI 执行失败';
  }

  function stageDot(status) {
    if (status === 'running') return <span className="ex-dot running" />;
    if (status === 'done') return <span className="ex-dot done">✓</span>;
    if (status === 'failed') return <span className="ex-dot failed">✕</span>;
    if (status === 'cancelled') return <span className="ex-dot cancelled">–</span>;
    if (status === 'skipped') return <span className="ex-dot skipped">·</span>;
    return <span className="ex-dot pending" />;
  }

  function stageElapsed(s) {
    if (!s) return '';
    if (s.status === 'running' && s.startedAt) return formatMs(Date.now() - s.startedAt);
    if (s.elapsedMs) return formatMs(s.elapsedMs);
    return s.status === 'pending' ? '' : '0ms';
  }

  function renderResultCard() {
    const r = exec.result || {};
    const sum = r.summary || {};
    const timed = exec.stages.filter((s) => (s.elapsedMs || 0) > 0);
    const slowest = timed.reduce((m, s) => (!m || (s.elapsedMs || 0) > (m.elapsedMs || 0) ? s : m), null);
    const maxMs = Math.max(1, slowest ? slowest.elapsedMs : 1);
    const ctxItems = [
      ['企业', (currentCompany && currentCompany.name) || '—'],
      ['项目', (currentProject && currentProject.name) || '—'],
      ['任务', exec.taskTitle || '—'],
      ['用到能力', sum.capabilityName || r.capabilityName || '—'],
    ];
    return (
      <div className="exec-card">
        <div className="exec-card-title">这次 AI 替你做了什么</div>

        <div className="exec-card-block">
          <div className="exec-card-k">读了这些上下文</div>
          <div className="exec-ctx">
            {ctxItems.map(([k, v]) => (
              <span className="exec-ctx-item" key={k}>{k}：<b>{v}</b></span>
            ))}
          </div>
          {(exec.highlights || []).length > 0 && (
            <div className="exec-ctx-extra">
              {(exec.highlights || []).map((h, i) => <div key={i}>· {h}</div>)}
            </div>
          )}
        </div>

        <div className="exec-card-block">
          <div className="exec-card-k">
            各阶段耗时{slowest ? `（最慢：${slowest.label} ${formatMs(slowest.elapsedMs)}）` : ''}
          </div>
          <div className="exec-bars">
            {exec.stages.map((s) => (
              <div className="exec-bar-row" key={s.key}>
                <span className="exec-bar-label">{s.label}</span>
                <span className="exec-bar-track">
                  <span
                    className={'exec-bar-fill' + (slowest && slowest.key === s.key ? ' slowest' : '')}
                    style={{ width: Math.max(2, Math.round(((s.elapsedMs || 0) / maxMs) * 100)) + '%' }}
                  />
                </span>
                <span className="exec-bar-ms">{s.elapsedMs ? formatMs(s.elapsedMs) : '—'}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="exec-card-block exec-card-stats">
          <div className="exec-stat"><span className="exec-stat-v">{sum.charCount || 0}</span><span className="exec-stat-k">字</span></div>
          <div className="exec-stat"><span className="exec-stat-v">{sum.lines || 0}</span><span className="exec-stat-k">段</span></div>
          <div className="exec-stat"><span className="exec-stat-v">{formatMs(sum.totalMs || (Date.now() - exec.startedAt))}</span><span className="exec-stat-k">总耗时</span></div>
        </div>

        <div className="exec-card-block">
          <div className="exec-card-k">存成了哪个资产</div>
          {sum.assetName ? (
            <div className="exec-asset">
              <span
                className="exec-asset-name"
                onClick={() => { changeTab('assets'); setExec(null); }}
                title="点击跳到「项目产出」"
              >
                {sum.assetName}
              </span>
              <Tag color="green">{ASSET_TYPES[sum.assetType] || sum.assetType}</Tag>
            </div>
          ) : (
            <div className="exec-asset empty">本次没有生成资产（该能力不落资产，可在任务卡片点「保存资产」）</div>
          )}
        </div>
      </div>
    );
  }

  function renderExecBody() {
    const totalElapsed = Date.now() - exec.startedAt;
    const doneCount = exec.stages.filter((s) => s.status === 'done').length;
    const runIdTail = exec.runId ? String(exec.runId).slice(-6) : '——';
    const failedStage = exec.stages.find((s) => s.status === 'failed');
    return (
      <div className="exec-panel">
        <div className="exec-panel-head">
          <span className="exec-run">执行号 #{runIdTail}</span>
          <span className="exec-count">{doneCount}/{exec.stages.length}</span>
          <span className="exec-total">{formatMs(totalElapsed)}</span>
        </div>

        <div className="exec-timeline">
          {exec.stages.map((s, i) => (
            <div className={'exec-step ' + (s.status || 'pending')} key={s.key}>
              <div className="exec-step-dot">{stageDot(s.status)}</div>
              <div className="exec-step-main">
                <span className="exec-step-idx">{i + 1}.</span>
                <span className="exec-step-label">{s.label}</span>
                {s.detail ? <span className="exec-step-detail">{s.detail}</span> : null}
              </div>
              <div className="exec-step-ms">{stageElapsed(s)}</div>
            </div>
          ))}
        </div>

        {exec.phase === 'running' && (
          <div className="exec-hint">AI 正在跑（最长 120 秒自动超时），可随时「取消执行」。</div>
        )}

        {exec.phase === 'done' ? renderResultCard() : null}

        {(exec.phase === 'failed' || exec.phase === 'cancelled') && (
          <div className="exec-fail">
            <div className="exec-fail-where">
              {failedStage ? `失败在「${failedStage.label}」` : '已取消'}
            </div>
            <div className="exec-fail-msg">{exec.error || '未知错误'}</div>
          </div>
        )}
      </div>
    );
  }

  function renderExecFooter() {
    if (!exec) return null;
    const assetName = (exec.result && exec.result.summary && exec.result.summary.assetName) || exec.taskTitle || 'AI 产出';
    const content = (exec.result && exec.result.content) || '';
    if (exec.phase === 'running') {
      return [
        <Popconfirm
          key="cancel"
          title="取消这次 AI 执行？"
          description="取消后 AI 已产生的内容不会保存，任务会回到「待做」。"
          okText="确定取消"
          cancelText="继续等"
          okButtonProps={{ danger: true }}
          onConfirm={cancelExec}
        >
          <Button danger>取消执行</Button>
        </Popconfirm>,
      ];
    }
    if (exec.phase === 'failed' || exec.phase === 'cancelled') {
      return [
        <Button
          key="retry"
          type="primary"
          onClick={() => {
            const t = projectTasks.find((x) => x.id === exec.taskId);
            setExec(null);
            if (t) runTaskWithAI(t);
          }}
        >
          重试
        </Button>,
        <Button key="close" onClick={closeExec}>关闭</Button>,
      ];
    }
    return [
      <Button key="view" type="primary" onClick={() => setFullDoc({ title: assetName, content })}>查看完整内容</Button>,
      <Button key="assets" onClick={() => { changeTab('assets'); setExec(null); }}>在项目产出中查看</Button>,
      <Button key="dl" onClick={() => downloadContent(assetName, content)}>下载 .md</Button>,
      <Button key="close" onClick={closeExec}>关闭</Button>,
    ];
  }

  function advanceTask(t, status) {
    const ok = updateTaskStatus(t.id, status);
    if (!ok) message.warning('状态流转不允许：' + (STATUS_META[t.status] || {}).label + ' → ' + (STATUS_META[status] || {}).label);
  }

  function saveAsAsset(t) {
    if (!t || !t.aiOutput || !currentCompany) return;
    saveTaskAsset(assetTypeFor(t), t, t.aiOutput, {
      companyId: currentCompany.id,
      projectId: currentProject ? currentProject.id : null,
    });
    message.success('已保存为项目资产');
  }

  function openEditTask(t) {
    setEditTask(t);
    setEditContent(t.aiOutput || '');
  }

  function commitEdit() {
    if (!editTask) return;
    updateTask(editTask.id, { aiOutput: editContent });
    message.success('已保存修改');
    setEditTask(null);
    setEditContent('');
  }

  // ---- 编辑项目 ----
  function openEditProject() {
    if (!currentProject) return;
    setEditProjectDraft({
      name: currentProject.name,
      description: currentProject.description || '',
      period: currentProject.period || '',
      audience: currentProject.audience || '',
      product: currentProject.product || '',
      status: currentProject.status || 'active',
    });
    setEditProject(true);
  }
  function commitEditProject() {
    if (!currentProject) return;
    updateProject(currentProject.id, {
      name: (editProjectDraft.name || '').trim() || currentProject.name,
      description: editProjectDraft.description,
      period: editProjectDraft.period,
      audience: editProjectDraft.audience,
      product: editProjectDraft.product,
      status: editProjectDraft.status,
    });
    message.success('已保存项目信息');
    setEditProject(false);
  }

  // ---- 项目资料 ----
  const TEXT_EXT = /\.(txt|md|markdown|csv|json|html|htm|xml)$/i;
  function addMaterial() {
    if (!currentCompany || !currentProject) return;
    const name = (materialDraft.name || '').trim();
    if (!name) {
      message.warning('请填写资料名称');
      return;
    }
    addAsset({
      type: 'material',
      companyId: currentCompany.id,
      projectId: currentProject.id,
      name,
      content: materialDraft.content || '',
      metadata: {
        category: materialDraft.category || 'product',
        source: 'manual',
        link: materialDraft.link || '',
      },
    });
    message.success('已添加项目资料' + (materialDraft.content ? '（含正文，将进入 AI 上下文）' : ''));
    setMaterialDraft({ name: '', category: 'product', content: '', link: '' });
    setShowAddMaterial(false);
  }
  function uploadMaterial(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || !currentCompany || !currentProject) return;
    const isText = TEXT_EXT.test(file.name || '');
    const finish = (content) => {
      addAsset({
        type: 'material',
        companyId: currentCompany.id,
        projectId: currentProject.id,
        name: file.name,
        mimeType: file.type || '',
        content: content || '',
        metadata: { category: isText ? 'file' : 'file', size: file.size, source: 'upload' },
      });
      message.success(isText ? '已读取文本正文并记录资料' : '已记录文件资料（正文暂未解析，可改「添加资料」粘贴全文）');
      e.target.value = '';
    };
    if (isText) {
      const reader = new FileReader();
      reader.onload = () => finish(String(reader.result || ''));
      reader.onerror = () => finish('');
      reader.readAsText(file);
    } else {
      finish('');
    }
  }

  const MATERIAL_CATEGORY = { product: '产品资料', article: '历史文章', image: '图片', pdf: 'PDF', word: 'Word', file: '其他文件' };

  function renderTaskActions(t) {
    const busy = aiBusyId === t.id;
    const btns = [];
    btns.push(<Button key="detail" size="small" type="text" onClick={() => setTaskDetail(t)}>详情</Button>);
    if (t.status === 'todo') {
      btns.push(<Button key="start" size="small" type="text" onClick={() => advanceTask(t, 'doing')}>开始</Button>);
      if (!isViewer) btns.push(<Button key="ai" size="small" type="link" loading={busy} onClick={() => runTaskWithAI(t)}>使用AI完成</Button>);
    } else if (t.status === 'doing') {
      if (!isViewer) btns.push(<Button key="ai" size="small" type="link" loading={busy} onClick={() => runTaskWithAI(t)}>使用AI完成</Button>);
      btns.push(<Button key="review" size="small" type="text" onClick={() => advanceTask(t, 'review')}>提交审核</Button>);
      btns.push(<Button key="back" size="small" type="text" onClick={() => advanceTask(t, 'todo')}>返回待办</Button>);
    } else if (t.status === 'review') {
      if (t.aiOutput) btns.push(<Button key="view" size="small" type="text" onClick={() => setResultTask(t)}>查看结果</Button>);
      if (!isViewer) {
        btns.push(<Button key="pass" size="small" type="link" onClick={() => advanceTask(t, 'done')}>通过</Button>);
        btns.push(<Button key="reject" size="small" type="text" onClick={() => advanceTask(t, 'doing')}>打回</Button>);
        btns.push(<Button key="regen" size="small" type="link" loading={busy} onClick={() => runTaskWithAI(t)}>重新生成</Button>);
      }
      if (t.aiOutput) {
        if (!isViewer) btns.push(<Button key="edit" size="small" type="text" onClick={() => openEditTask(t)}>修改</Button>);
        btns.push(<Button key="save" size="small" type="text" onClick={() => saveAsAsset(t)}>保存资产</Button>);
      }
    } else if (t.status === 'done') {
      if (t.aiOutput) btns.push(<Button key="view" size="small" type="text" onClick={() => setResultTask(t)}>查看结果</Button>);
      btns.push(<Button key="reopen" size="small" type="text" onClick={() => advanceTask(t, 'todo')}>重开</Button>);
    }
    return btns;
  }

  function renderTaskList(status) {
    const list = groupTasks(status);
    if (list.length === 0) {
      return <div className="pd-empty">{STATUS_META[status].label}暂无任务</div>;
    }
    return list.map((t) => {
      const cap = resolveCapabilityForType(t.taskType || t.capability, companyType, currentProject && currentProject.type);
      return (
        <div key={t.id} className="pd-task">
          <div className="pd-task-body">
            <div className="pd-task-title">{t.title}</div>
            <div className="pd-task-meta">
              {t.taskType && <Tag>{taskTypeLabel(t.taskType)}</Tag>}
              <Tag color="green">{capabilityLabel(cap)}</Tag>
              {t.priority && <span className="pd-task-prio">{t.priority}</span>}
            </div>
          </div>
          <div className="pd-task-actions">{renderTaskActions(t)}</div>
        </div>
      );
    });
  }

  const overview = (
    <div className="pd-overview">
      <div className="pd-hero">
        <div className="pd-hero-left">
          <div className="pd-proj-name">{currentProject ? currentProject.name : '暂无项目'}</div>
          <div className="pd-proj-tags">
            {typeMeta && <Tag color="green">{typeMeta.icon} {typeMeta.label}</Tag>}
            <Tag>{PROJECT_STATUS_LABEL[currentProject && currentProject.status] || '进行中'}</Tag>
          </div>
          {(currentProject && currentProject.description) && (
            <div className="pd-proj-desc">{currentProject.description}</div>
          )}
        </div>
        <div className="pd-hero-progress">
          {total > 0 ? (
            <>
              <div className="pd-progress-num">{stats.done}<span className="pd-progress-total">/{total}</span></div>
              <Progress percent={percent} showInfo={false} strokeColor="var(--c-brand)" size="small" style={{ margin: '6px 0' }} />
              <div className="pd-progress-label">已完成 {stats.done} · 待做 {stats.todo} · 进行中 {stats.doing} · 待审核 {stats.review}</div>
            </>
          ) : (
            <>
              <div className="pd-progress-num">0<span className="pd-progress-total">/0</span></div>
              <div className="pd-progress-label">暂无任务 · 先为项目拆解任务</div>
            </>
          )}
        </div>
      </div>

      <div className="pd-fields">
        {[['营销目标', (goal && goal.label) || (currentProject && currentProject.goalId) || '未绑定'],
          ['项目周期', (currentProject && currentProject.period) || '未设置'],
          ['目标人群', (currentProject && currentProject.audience) || '未设置'],
          ['核心产品', (currentProject && currentProject.product) || '未设置'],
          ['预算', (currentProject && currentProject.budget) || '未设置'],
          ['KPI', (currentProject && currentProject.kpi) || '未设置'],
        ].map(([k, v]) => (
          <div className="pd-field" key={k}>
            <span className="pd-field-k">{k}</span>
            <span className="pd-field-v">{v}</span>
          </div>
        ))}
      </div>

      {currentProject && (currentProject.channels || []).length > 0 && (
        <div className="pd-channels">
          <span className="pd-field-k">传播渠道：</span>
          {(currentProject.channels || []).map((c, i) => <Tag key={i}>{c}</Tag>)}
        </div>
      )}

      {/* AI 统筹建议：读项目 + 任务 + 企业画像，告诉用户卡在哪、下一步该干嘛 */}
      <div className="pd-guidance">
        <div className="pd-guidance-head">
          <span className="pd-guidance-title">🧭 AI 统筹建议</span>
          <Button size="small" type="primary" ghost loading={guidance.busy} onClick={runGuidance}>
            {guidance.result ? '重新生成' : '生成统筹建议'}
          </Button>
        </div>
        {guidance.error && <div className="pd-guidance-error">⚠️ {guidance.error}</div>}
        {!guidance.result && !guidance.busy && !guidance.error && (
          <div className="pd-guidance-empty">
            点「生成统筹建议」，AI 会读项目、任务清单与企业画像，告诉你现在卡在哪、下一步最该做哪几件事。
          </div>
        )}
        {guidance.busy && <div className="pd-guidance-loading">AI 正在统筹项目…</div>}
        {guidance.result && (
          <div className="pd-guidance-result">
            {guidance.result.summary && <div className="pd-guidance-summary">{guidance.result.summary}</div>}
            {guidance.result.progressRead && <div className="pd-guidance-progress">{guidance.result.progressRead}</div>}
            {guidance.result.nextActions.length > 0 && (
              <div className="pd-guidance-actions">
                <div className="pd-guidance-subtitle">下一步建议</div>
                {guidance.result.nextActions.map((a, i) => (
                  <div className="pd-guidance-action" key={i}>
                    <span className={'pd-guidance-prio pd-prio-' + a.priority}>
                      {a.priority === 'high' ? '高' : a.priority === 'low' ? '低' : '中'}
                    </span>
                    <span className="pd-guidance-action-body">
                      <span className="pd-guidance-action-title">{a.title}</span>
                      {a.why && <span className="pd-guidance-action-why">—— {a.why}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {guidance.result.risks.length > 0 && (
              <div className="pd-guidance-risks">
                <div className="pd-guidance-subtitle">风险 / 待补信息</div>
                {guidance.result.risks.map((r, i) => (
                  <div className="pd-guidance-risk" key={i}>
                    <span className="pd-guidance-risk-title">⚠️ {r.title}</span>
                    {r.why && <span className="pd-guidance-risk-why">—— {r.why}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 建议先做：首个待做任务的快捷开始入口 */}
      {groupTasks('todo').length > 0 && (
        <div className="pd-first-task">
          <div className="pd-first-task-head">👉 建议先做</div>
          <div className="pd-first-task-body">
            <div className="pd-first-task-info">
              <span className="pd-first-task-title">{groupTasks('todo')[0].title}</span>
              <span className="pd-first-task-hint">
                {capabilityLabel(resolveCapabilityForType(groupTasks('todo')[0].taskType || groupTasks('todo')[0].capability, companyType, currentProject && currentProject.type))}
              </span>
            </div>
            <div className="pd-first-task-actions">
              <Button size="small" type="text" onClick={() => setTaskDetail(groupTasks('todo')[0])}>查看详情</Button>
              <Button size="small" onClick={() => advanceTask(groupTasks('todo')[0], 'doing')}>开始</Button>
              {!isViewer && (
                <Button size="small" type="primary" loading={aiBusyId === groupTasks('todo')[0].id} onClick={() => runTaskWithAI(groupTasks('todo')[0])}>
                  使用AI完成
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const tasksTab = (
    <div className="pd-tasks">
      {[['todo', '待做'], ['doing', '进行中'], ['review', '待审核'], ['done', '已完成']].map(([status, label]) => (
        <div className="pd-task-col" key={status}>
          <div className="pd-task-col-head">
            <span>{label}</span>
            <span className="pd-task-col-count">{stats[status]}</span>
          </div>
          {renderTaskList(status)}
        </div>
      ))}
    </div>
  );

  const assetsTab = (
    <div className="pd-assets">
      {projectAssets.length === 0 ? (
        <Empty description="暂无项目资产，完成任务后可「保存为项目资产」" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        Object.keys(assetsByType).map((type) => (
          <div className="pd-asset-group" key={type}>
            <div className="pd-asset-group-head">{ASSET_TYPES[type] || type} <span className="pd-task-col-count">{assetsByType[type].length}</span></div>
            <div className="pd-asset-list">
              {assetsByType[type].map((a) => (
                <div className="pd-asset" key={a.id}>
                  <div className="pd-asset-name">{a.name}</div>
                  {a.content && <div className="pd-asset-preview">{mdToPlain(String(a.content)).slice(0, 160)}</div>}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );

  const materialsTab = (
    <div className="pd-materials">
      <div className="pd-materials-head">
        <span className="pd-field-k">项目资料（产品资料 / PDF / 图片 / 历史文章）</span>
        <div className="pd-materials-actions">
          {!isViewer && <Button size="small" onClick={() => setShowAddMaterial(true)}>+ 添加资料</Button>}
          {!isViewer && (
            <label className="ant-btn ant-btn-default ant-btn-sm">
              上传文件
              <input type="file" style={{ display: 'none' }} onChange={uploadMaterial} />
            </label>
          )}
        </div>
      </div>
      {projectMaterials.length === 0 ? (
        <Empty description="暂无项目资料，可添加产品或上传文件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="pd-material-list">
          {projectMaterials.map((m) => (
            <div className="pd-material" key={m.id}>
              <div className="pd-material-icon">📎</div>
              <div className="pd-material-body">
                <div className="pd-material-name">{m.name}</div>
                <div className="pd-material-meta">
                  {m.metadata && m.metadata.category && <Tag>{MATERIAL_CATEGORY[m.metadata.category] || m.metadata.category}</Tag>}
                  {m.content && <span className="pd-material-link">{String(m.content).slice(0, 80)}</span>}
                  {m.metadata && m.metadata.size != null && <span className="pd-material-size">{(m.metadata.size / 1024).toFixed(1)} KB</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="pd">
      <div className="pd-head">
        <div className="pd-head-left">
          {/* 【0.21.21 · 老板 2026-10-21】返回目标从 `activity` 改成 `direction`。
              「活动与档期」整板块下线后 `activity` 已不是模块；项目详情是
              「经营方案 → 目标 → 项目」这条链的第三层，返回上一层的正确落点是经营方案。
              ⚠️ 不能用别名兜底（会落到豆芽助手）：那看起来像「点了返回却回了首页」。 */}
          <Button size="small" type="text" onClick={() => (onBack ? onBack() : onSelectModule('direction'))}>← 返回</Button>
          <Select
            size="small"
            value={currentProject && currentProject.id}
            onChange={(v) => switchProject(v)}
            options={projectOptions}
            style={{ width: 220 }}
            placeholder="选择项目"
          />
        </div>
        <div className="pd-head-right">
          {!isViewer && <Button size="small" onClick={openEditProject}>编辑项目</Button>}
          {!isViewer && <Button size="small" onClick={() => onSelectModule('goal')}>🎯 选目标</Button>}
          {/* 【0.21.21】「活动策划」按钮落点从 `activity` 改成 `campaign`：
              按钮文案说的就是「做活动方案」，而它现在住在营销专项（CampaignModule）。 */}
          <Button size="small" type="primary" ghost onClick={() => onSelectModule('campaign')}>活动策划</Button>
        </div>
      </div>

      <Tabs
        activeKey={tab}
        onChange={changeTab}
        items={[
          { key: 'overview', label: '概览', children: tab === 'overview' ? overview : null },
          { key: 'tasks', label: '任务', children: tab === 'tasks' ? tasksTab : null },
          { key: 'materials', label: '项目资料', children: tab === 'materials' ? materialsTab : null },
          { key: 'assets', label: '项目产出', children: tab === 'assets' ? assetsTab : null },
          { key: 'assistant', label: 'AI 助手', children: assistantVisited ? <ProjectAssistant onSelectModule={onSelectModule} onRunTask={onRunTask} /> : null },
        ]}
      />

      <Modal
        open={resultTask != null}
        onCancel={() => setResultTask(null)}
        footer={resultTask && resultTask.aiOutput ? [
          <Button key="save" type="primary" onClick={() => { saveAsAsset(resultTask); setResultTask(null); }}>保存为项目资产</Button>,
          <Button key="close" onClick={() => setResultTask(null)}>关闭</Button>,
        ] : null}
        title={resultTask ? '任务结果：' + resultTask.title : ''}
        width={720}
      >
        {resultTask && resultTask.aiOutput ? (
          <div className="pd-result"><Markdown>{resultTask.aiOutput}</Markdown></div>
        ) : (
          <div className="pd-empty">该任务暂无 AI 输出</div>
        )}
      </Modal>

      {/* ✏️ 修改 AI 输出 */}
      <Modal
        open={editTask != null}
        onCancel={() => { setEditTask(null); setEditContent(''); }}
        onOk={commitEdit}
        okText="保存修改"
        cancelText="取消"
        title={editTask ? '修改结果：' + editTask.title : ''}
        width={720}
      >
        <Input.TextArea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          rows={16}
          placeholder="编辑 AI 生成的内容"
        />
      </Modal>

      {/* AI 执行流水线：8 步阶段时间轴 + 结束后「这次 AI 替你做了什么」结果卡 */}
      <Modal
        open={exec != null}
        onCancel={closeExec}
        footer={renderExecFooter()}
        maskClosable={!(exec && exec.phase === 'running')}
        closable={!(exec && exec.phase === 'running')}
        title={exec ? execTitle() : ''}
        width={640}
      >
        {exec ? renderExecBody() : null}
      </Modal>

      {/* 结果卡「查看完整内容」 */}
      <Modal
        open={fullDoc != null}
        onCancel={() => setFullDoc(null)}
        footer={[
          <Button key="dl" onClick={() => fullDoc && downloadContent(fullDoc.title, fullDoc.content)}>下载 .md</Button>,
          <Button key="close" type="primary" onClick={() => setFullDoc(null)}>关闭</Button>,
        ]}
        title={fullDoc ? fullDoc.title : ''}
        width={720}
      >
        {fullDoc ? <div className="pd-result"><Markdown>{fullDoc.content}</Markdown></div> : null}
      </Modal>

      {/* Task 详情 */}
      <TaskDetailModal open={taskDetail != null} task={taskDetail} onClose={() => setTaskDetail(null)} />

      {/* 编辑项目 */}
      <Modal
        open={editProject}
        onCancel={() => setEditProject(false)}
        onOk={commitEditProject}
        okText="保存"
        cancelText="取消"
        title="编辑项目"
        width={560}
      >
        <div className="form-grid">
          <div className="form-item">
            <div className="form-label">项目名称 *</div>
            <Input value={editProjectDraft.name || ''} onChange={(e) => setEditProjectDraft((p) => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="form-item">
            <div className="form-label">项目目标</div>
            <Input value={editProjectDraft.description || ''} onChange={(e) => setEditProjectDraft((p) => ({ ...p, description: e.target.value }))} />
          </div>
          <div className="form-item">
            <div className="form-label">时间周期</div>
            <Input value={editProjectDraft.period || ''} onChange={(e) => setEditProjectDraft((p) => ({ ...p, period: e.target.value }))} />
          </div>
          <div className="form-item">
            <div className="form-label">目标人群</div>
            <Input value={editProjectDraft.audience || ''} onChange={(e) => setEditProjectDraft((p) => ({ ...p, audience: e.target.value }))} />
          </div>
          <div className="form-item">
            <div className="form-label">主要产品 / 项目</div>
            <Input value={editProjectDraft.product || ''} onChange={(e) => setEditProjectDraft((p) => ({ ...p, product: e.target.value }))} />
          </div>
          <div className="form-item">
            <div className="form-label">项目状态</div>
            <Select
              value={editProjectDraft.status || 'active'}
              onChange={(v) => setEditProjectDraft((p) => ({ ...p, status: v }))}
              options={PROJECT_STATUS_OPTIONS}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </Modal>

      {/* 添加项目资料 */}
      <Modal
        open={showAddMaterial}
        onCancel={() => setShowAddMaterial(false)}
        onOk={addMaterial}
        okText="添加"
        cancelText="取消"
        title="添加项目资料"
        width={480}
      >
        <div className="form-grid">
          <div className="form-item">
            <div className="form-label">资料名称 *</div>
            <Input value={materialDraft.name} onChange={(e) => setMaterialDraft((p) => ({ ...p, name: e.target.value }))} placeholder="例如：种植体产品手册" />
          </div>
          <div className="form-item">
            <div className="form-label">资料分类</div>
            <Select
              value={materialDraft.category}
              onChange={(v) => setMaterialDraft((p) => ({ ...p, category: v }))}
              options={Object.keys(MATERIAL_CATEGORY).map((k) => ({ value: k, label: MATERIAL_CATEGORY[k] }))}
              style={{ width: '100%' }}
            />
          </div>
          <div className="form-item" style={{ gridColumn: '1 / -1' }}>
            <div className="form-label">正文（粘贴产品资料 / 历史文章全文，将进入 AI 上下文）</div>
            <Input.TextArea
              value={materialDraft.content}
              onChange={(e) => setMaterialDraft((p) => ({ ...p, content: e.target.value }))}
              rows={8}
              placeholder="粘贴资料正文，AI 生成时即可引用这些内容"
            />
          </div>
          <div className="form-item">
            <div className="form-label">链接 / 备注（可选）</div>
            <Input value={materialDraft.link} onChange={(e) => setMaterialDraft((p) => ({ ...p, link: e.target.value }))} placeholder="例如：https://... 或来源说明" />
          </div>
        </div>
      </Modal>
    </div>
  );
}
