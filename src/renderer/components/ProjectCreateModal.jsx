import React, { useEffect, useState } from 'react';
import { Modal, Steps, Input, Button, Checkbox, App as AntApp, Tag } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { getProjectTemplates } from '../config/scenarioTemplates.js';
import { resolveCapabilityForType, capabilityLabel } from '../services/capabilityResolver.js';
import { buildProjectDraftSuggestion, generateProjectTasks } from '../services/projectAI.js';

const PRIORITY_LABEL = { low: '低', medium: '中', high: '高', urgent: '紧急' };

/**
 * 分步创建项目（阶段六「真实营销场景模板」）：
 * 第一步按 companyType 渲染场景模板卡片（厂家 4 / 门诊 4），可选「自定义项目」跳过模板；
 * 第二步展示「已为你建立 XX 项目」+ 项目目标 + 建议先做任务清单（可勾选/取消，不自动生成），
 *   填核心字段后一键创建：createProject + seedProjectTasks 一次性生成推荐任务。
 * 「AI 帮我填」→ buildProjectDraftSuggestion 预填可改，失败降级手填不阻塞。
 */
export default function ProjectCreateModal({ open, onClose, onCreated, presetKey }) {
  const { message } = AntApp.useApp();
  const { currentCompany, currentRole, createProject, seedProjectTasks } = useCompany();
  const { asset } = useMarketingAsset();
  const { getKnowledge } = useCompanyKnowledge();
  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';
  const isViewer = currentRole === 'viewer';
  const templates = getProjectTemplates(companyType);

  const [step, setStep] = useState(0);
  const [selectedTpl, setSelectedTpl] = useState(null);
  const [customMode, setCustomMode] = useState(false); // 自定义项目：不走模板任务
  const [checkedTasks, setCheckedTasks] = useState([]); // 勾选的任务标题
  const [draft, setDraft] = useState({
    name: '', description: '', period: '', audience: '', product: '',
  });
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPrefilled, setAiPrefilled] = useState(false); // 豆芽是否真的预填过（仅在实际跑过 AI 且成功后才置真，避免不实文案）
  // P0-5：AI 全部生成产出的任务清单（可勾选/删除微调，确认后随项目落库）
  const [aiTasks, setAiTasks] = useState([]);
  const [checkedAiTasks, setCheckedAiTasks] = useState([]);

  useEffect(() => {
    if (open) {
      setStep(0);
      setSelectedTpl(null);
      setCustomMode(false);
      setCheckedTasks([]);
      setAiTasks([]);
      setCheckedAiTasks([]);
      setDraft({ name: '', description: '', period: '', audience: '', product: '' });
      setAiPrefilled(false);
      // 首页「推荐项目」点进来 → 直接预选该模板并进入第二步
      if (presetKey) {
        const t = templates.find((x) => x.key === presetKey);
        if (t) {
          setSelectedTpl(t);
          setCheckedTasks(t.defaultTasks.map((d) => d.title));
          setDraft((prev) => ({ ...prev, name: t.label, description: t.goal || '' }));
          setStep(1);
        }
      }
    }
  }, [open, presetKey, templates]);

  function pickType(t) {
    setSelectedTpl(t);
    setCheckedTasks(t.defaultTasks.map((d) => d.title));
    setDraft((prev) => ({ ...prev, name: t.label, description: t.goal || t.desc || '' }));
    setCustomMode(false);
    setStep(1);
  }

  function pickCustom() {
    setSelectedTpl(null);
    setCustomMode(true);
    setCheckedTasks([]);
    setDraft((prev) => ({ ...prev, description: '' }));
    setStep(1);
  }

  /**
   * 新人不知道选哪个模板 → 进 Step1 并立即让豆芽按企业画像起草草稿 + 任务。
   * 用户显式点击 = 明确意图，不属静默消耗 token；复用 pickCustom 的进入语义，不改其现有行为。
   * onAiGenerateAll 读本次渲染闭包里的 selectedTpl → 未选模板时为「自定义」，符合预期。
   */
  function pickCoach() {
    pickCustom();
    if (!isViewer) onAiGenerateAll();
  }

  function setField(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function toggleTask(title) {
    setCheckedTasks((prev) => (prev.includes(title) ? prev.filter((x) => x !== title) : [...prev, title]));
  }

  async function onAiFill() {
    if (!currentCompany || aiBusy) return;
    setAiBusy(true);
    try {
      const d = await buildProjectDraftSuggestion({
        companyType,
        company: currentCompany,
        asset,
        knowledge: getKnowledge(currentCompany.id),
        projectType: selectedTpl || { key: '', label: '自定义项目', goalId: null },
      });
      if (d) {
        setDraft((prev) => ({
          ...prev,
          name: d.name || prev.name,
          description: d.description || d.goal || prev.description,
          audience: d.audience || prev.audience,
          product: d.product || prev.product,
          period: d.period || prev.period,
        }));
        setAiPrefilled(true);
        message.success('已用 AI 生成草稿，可继续修改');
      } else {
        message.info('AI 草稿生成失败，请手动填写');
      }
    } catch (e) {
      // 加固（非修既有静默 bug）：正常失败走上面 else 的可见提示；此处兜住「非 chatOnce 来源」的异常
      // （如 buildAIContext 抛错），避免只跑 finally、用户无任何提示。
      message.info('AI 暂时不可用，已切回手动填写（' + ((e && e.message) || '未知原因') + '）');
    } finally {
      setAiBusy(false);
    }
  }

  // P0-5：AI 全部生成 = 起草字段 + 生成任务清单（可勾选/删除微调，失败降级手动）
  async function onAiGenerateAll() {
    if (!currentCompany || aiBusy) return;
    setAiBusy(true);
    try {
      const pt = selectedTpl || { key: '', label: '自定义项目', goalId: null };
      const [d, tasks] = await Promise.all([
        buildProjectDraftSuggestion({
          companyType,
          company: currentCompany,
          asset,
          knowledge: getKnowledge(currentCompany.id),
          projectType: pt,
        }),
        (() => {
          // 先有草稿字段再生成任务，体验更连贯；草稿为空时直接用当前上下文
          const draftCtx = {
            company: currentCompany,
            asset,
            knowledge: getKnowledge(currentCompany.id),
            project: { name: draft.name, type: pt.key, goalId: pt.goalId },
            goalLabel: (selectedTpl && selectedTpl.goal) || draft.description || '',
          };
          return generateProjectTasks(draftCtx);
        })(),
      ]);
      if (d) {
        setDraft((prev) => ({
          ...prev,
          name: d.name || prev.name,
          description: d.description || d.goal || prev.description,
          audience: d.audience || prev.audience,
          product: d.product || prev.product,
          period: d.period || prev.period,
        }));
      }
      if (Array.isArray(tasks) && tasks.length) {
        setAiTasks(tasks);
        setCheckedAiTasks(tasks.map((t) => t.title));
        if (d) setAiPrefilled(true);
        message.success('AI 已生成草稿 + ' + tasks.length + ' 个任务，可微调后创建');
      } else if (d) {
        setAiPrefilled(true);
        message.success('AI 已生成草稿，可继续修改');
      } else {
        message.info('AI 生成失败，请手动填写');
      }
    } catch (e) {
      // 加固：兜住非 chatOnce 来源的异常，失败一律对用户可见，绝不静默。
      message.info('AI 暂时不可用，已切回手动填写（' + ((e && e.message) || '未知原因') + '）');
    } finally {
      setAiBusy(false);
    }
  }

  function toggleAiTask(title) {
    setCheckedAiTasks((prev) => (prev.includes(title) ? prev.filter((x) => x !== title) : [...prev, title]));
  }
  function removeAiTask(title) {
    setAiTasks((prev) => prev.filter((t) => t.title !== title));
    setCheckedAiTasks((prev) => prev.filter((x) => x !== title));
  }

  function submit() {
    const name = (draft.name || '').trim();
    if (!name) {
      message.warning('请填写项目名称');
      return;
    }
    const p = createProject(name, selectedTpl ? selectedTpl.goalId : null, {
      type: selectedTpl ? selectedTpl.key : '',
      description: draft.description,
      audience: draft.audience,
      product: draft.product,
      period: draft.period,
    });
    // P0-5：AI 全部生成产出的任务优先落库；否则回退模板勾选任务
    if (p && aiTasks.length && checkedAiTasks.length) {
      const tasks = aiTasks
        .filter((t) => checkedAiTasks.includes(t.title))
        .map((t) => ({
          title: t.title,
          taskType: t.taskType,
          description: t.description || '',
          priority: t.priority,
          capability: resolveCapabilityForType(t.taskType, companyType, selectedTpl ? selectedTpl.key : ''),
        }));
      seedProjectTasks(p.id, tasks);
      message.success('已建立「' + name + '」项目，生成 ' + tasks.length + ' 个 AI 任务');
    } else if (p && selectedTpl && checkedTasks.length) {
      const tasks = selectedTpl.defaultTasks
        .filter((d) => checkedTasks.includes(d.title))
        .map((d) => ({
          title: d.title,
          taskType: d.taskType,
          description: d.description || '',
          capability: resolveCapabilityForType(d.taskType, companyType, selectedTpl.key),
        }));
      seedProjectTasks(p.id, tasks);
      message.success('已建立「' + name + '」项目，生成 ' + tasks.length + ' 个推荐任务');
    } else {
      message.success('已建立「' + name + '」项目');
    }
    if (onCreated) onCreated(p);
    onClose();
  }

  const selectedTasks = selectedTpl ? selectedTpl.defaultTasks : [];

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={700} title="新建营销项目" destroyOnHidden>
      <Steps
        size="small"
        current={step}
        items={[{ title: '选择项目模板' }, { title: '确认项目与任务' }]}
        style={{ marginBottom: 16 }}
      />

      {step === 0 && (
        <div className="pc-type-grid">
          {templates.map((t) => (
            <button
              key={t.key}
              type="button"
              className="pc-type-card"
              onClick={() => pickType(t)}
            >
              <span className="pc-type-icon">{t.icon}</span>
              <span className="pc-type-name">{t.label}</span>
              <span className="pc-type-desc">{t.desc}</span>
              <span className="pc-type-tasks">含 {t.defaultTasks.length} 个推荐任务</span>
            </button>
          ))}
          <button type="button" className="pc-type-card pc-type-custom" onClick={pickCustom}>
            <span className="pc-type-icon">＋</span>
            <span className="pc-type-name">自定义项目</span>
            <span className="pc-type-desc">不从模板开始，手动建空项目</span>
          </button>
          {/* 新人不知道选哪个模板时的出口：进 Step1 并由豆芽按企业画像直接起草（用户点击触发） */}
          <button
            type="button"
            className="pc-type-card pc-type-custom"
            onClick={pickCoach}
            disabled={isViewer}
          >
            <span className="pc-type-icon">🪄</span>
            <span className="pc-type-name">让豆芽帮我建</span>
            <span className="pc-type-desc">不知道该选哪个？点这里，豆芽会按你的企业画像直接起草</span>
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="pc-form">
          {selectedTpl && (
            <div className="pc-tpl-banner">
              <div className="pc-tpl-banner-title">
                {selectedTpl.icon} 已为你建立「{selectedTpl.label}」项目
              </div>
              <div className="pc-tpl-banner-goal">项目目标：{draft.description || selectedTpl.goal}</div>
              <div className="pc-tpl-banner-hint">下面是建议先做的任务，勾选你需要的（不会自动执行，确认后才创建）</div>
            </div>
          )}

          {aiPrefilled && (
            <div className="pc-ai-hint" style={{ margin: '0 0 10px' }}>
              豆芽已按你的企业画像预填，逐项核对即可（每个字段都可以改）。
            </div>
          )}

          <div className="pc-ai-bar">
            <Button onClick={onAiFill} loading={aiBusy} disabled={isViewer}>✨ AI 帮我填</Button>
            <Button type="primary" ghost onClick={onAiGenerateAll} loading={aiBusy} disabled={isViewer}>🚀 AI 全部生成</Button>
            <span className="pc-ai-hint">全部生成 = 草稿 + 任务清单，可微调后创建；失败不阻塞</span>
          </div>

          <div className="form-grid">
            <div className="form-item">
              <div className="form-label">项目名称 *</div>
              <Input value={draft.name} onChange={(e) => setField('name', e.target.value)} placeholder="例如：9 月新品推广" />
            </div>
            <div className="form-item">
              <div className="form-label">项目目标</div>
              <Input value={draft.description} onChange={(e) => setField('description', e.target.value)} placeholder="例如：新品曝光 + 医生触达" />
            </div>
            <div className="form-item">
              <div className="form-label">时间周期</div>
              <Input value={draft.period} onChange={(e) => setField('period', e.target.value)} placeholder="例如：9月1日 - 9月30日" />
            </div>
            <div className="form-item">
              <div className="form-label">目标人群</div>
              <Input value={draft.audience} onChange={(e) => setField('audience', e.target.value)} placeholder="例如：民营口腔诊所 / 25-45 岁正畸人群" />
            </div>
            <div className="form-item">
              <div className="form-label">主要产品 / 项目</div>
              <Input value={draft.product} onChange={(e) => setField('product', e.target.value)} placeholder="例如：种植体 / 隐形矫正" />
            </div>
          </div>

          {aiTasks.length > 0 && (
            <div className="pc-tasks">
              <div className="pc-tasks-head">
                <span className="pc-tasks-title">AI 生成任务（{checkedAiTasks.length}/{aiTasks.length}）</span>
                <span className="pc-tasks-sub">可勾选 / 删除微调，创建后进入「待做」</span>
              </div>
              <div className="pc-task-list">
                {aiTasks.map((d) => {
                  const capId = resolveCapabilityForType(d.taskType, companyType, selectedTpl ? selectedTpl.key : '');
                  return (
                    <div key={d.title} className="pc-task-item pc-task-item-ai">
                      <Checkbox checked={checkedAiTasks.includes(d.title)} onChange={() => toggleAiTask(d.title)} />
                      <span className="pc-task-title">{d.title}</span>
                      <Tag color="green">{capabilityLabel(capId)}</Tag>
                      {d.priority && d.priority !== 'medium' && <Tag>{PRIORITY_LABEL[d.priority] || d.priority}</Tag>}
                      <button type="button" className="pc-task-del" onClick={() => removeAiTask(d.title)} title="删除此任务">✕</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectedTpl && aiTasks.length === 0 && (
            <div className="pc-tasks">
              <div className="pc-tasks-head">
                <span className="pc-tasks-title">建议先做（{checkedTasks.length}/{selectedTasks.length}）</span>
                <span className="pc-tasks-sub">可勾选，创建后进入「待做」</span>
              </div>
              <div className="pc-task-list">
                {selectedTasks.map((d) => {
                  const capId = resolveCapabilityForType(d.taskType, companyType, selectedTpl.key);
                  return (
                    <label key={d.title} className="pc-task-item">
                      <Checkbox checked={checkedTasks.includes(d.title)} onChange={() => toggleTask(d.title)} />
                      <span className="pc-task-title">{d.title}</span>
                      <Tag color="green">{capabilityLabel(capId)}</Tag>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="pc-footer">
        {step === 1 && <Button onClick={() => setStep(0)}>上一步</Button>}
        <div style={{ flex: 1 }} />
        {step === 1 && (
          <Button type="primary" disabled={isViewer || !(draft.name || '').trim()} onClick={submit}>
            {selectedTpl ? '创建项目并生成任务' : '创建项目'}
          </Button>
        )}
      </div>
    </Modal>
  );
}
