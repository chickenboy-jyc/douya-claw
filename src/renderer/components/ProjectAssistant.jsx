import React, { useEffect, useRef, useState } from 'react';
import { Input, Button, Spin, Modal, Tag, App as AntApp } from 'antd';
import Markdown from './Markdown.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset, useMarketingGoal } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { askProjectAssistant, generateProjectTasks } from '../services/projectAI.js';
import { taskTypeLabel } from '../services/capabilityResolver.js';

const PRIORITY_LABEL = { low: '低', medium: '中', high: '高', urgent: '紧急' };
const PRIORITY_COLOR = { low: 'default', medium: 'blue', high: 'orange', urgent: 'red' };

/**
 * Project 上下文 AI 助手（P1-1）：
 * 基于当前项目上下文问答；支持「生成任务清单」→ 用户确认后 addTasksToProject 批量落库。
 * 项目详情 Tab 与导航入口复用同一组件。
 */
export default function ProjectAssistant({ onSelectModule, onRunTask }) {
  const { message } = AntApp.useApp();
  const { currentCompany, currentProject, addTasksToProject } = useCompany();
  const { asset } = useMarketingAsset();
  const { goal } = useMarketingGoal();
  const { getKnowledge } = useCompanyKnowledge();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState(null);
  const [taskHint, setTaskHint] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    setMessages([]);
  }, [currentProject && currentProject.id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  function baseOpts() {
    return {
      company: currentCompany,
      project: currentProject,
      asset,
      knowledge: getKnowledge(currentCompany && currentCompany.id),
      goalLabel: (goal && goal.label) || '',
    };
  }

  async function ask() {
    const q = (input || '').trim();
    if (!q || busy) return;
    const userMsg = { role: 'user', content: q };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setBusy(true);
    try {
      const res = await askProjectAssistant(q, baseOpts());
      setMessages((prev) => [...prev, { role: 'assistant', content: res.ok ? res.content : '（助手调用失败：' + (res.error || '未知错误') + '）' }]);
    } finally {
      setBusy(false);
    }
  }

  async function generateTasks() {
    if (!currentProject || taskBusy) return;
    setTaskBusy(true);
    try {
      const list = await generateProjectTasks({ ...baseOpts(), hint: taskHint });
      if (list && list.length) {
        setTaskDrafts(list.map((t, i) => ({ key: i, ...t })));
      } else {
        message.info('未生成任务清单，请稍后再试');
      }
    } finally {
      setTaskBusy(false);
      setTaskHint('');
    }
  }

  function commitTasks() {
    if (!taskDrafts || !taskDrafts.length || !currentProject) return;
    const items = taskDrafts.map((t) => ({
      title: t.title,
      taskType: t.taskType,
      description: t.description,
      priority: t.priority,
    }));
    addTasksToProject(currentProject.id, items);
    message.success('已创建 ' + items.length + ' 个任务');
    setTaskDrafts(null);
  }

  function editDraft(i, field, value) {
    setTaskDrafts((prev) => prev.map((t) => (t.key === i ? { ...t, [field]: value } : t)));
  }

  return (
    <div className="pa-wrap">
      <div className="pa-log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="pa-chat-empty">
            我是项目 AI 助手，可基于当前项目回答你的问题。
            <br />
            也可以点下方「生成任务清单」，我帮你把项目拆成可执行任务。
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={'pa-msg ' + m.role}>
            {m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : <span>{m.content}</span>}
          </div>
        ))}
        {busy && (
          <div className="pa-msg assistant">
            <Spin size="small" /> 正在思考…
          </div>
        )}
      </div>

      <div className="pa-inputbar">
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); ask(); } }}
          placeholder="问项目相关的问题… Enter 发送 / Shift+Enter 换行"
          autoSize={{ minRows: 1, maxRows: 4 }}
        />
        <Button type="primary" onClick={ask} disabled={busy || !(input || '').trim()}>发送</Button>
      </div>

      <div className="pa-gen-bar">
        <Input
          size="small"
          value={taskHint}
          onChange={(e) => setTaskHint(e.target.value)}
          placeholder="补充要求（可选），例如：聚焦获客、7 天节奏"
          style={{ flex: 1 }}
        />
        <Button size="small" onClick={generateTasks} loading={taskBusy} disabled={!currentProject}>
          生成任务清单
        </Button>
      </div>

      <Modal
        open={taskDrafts != null}
        onCancel={() => setTaskDrafts(null)}
        onOk={commitTasks}
        okText="批量创建"
        cancelText="取消"
        okButtonProps={{ disabled: !(taskDrafts && taskDrafts.length) }}
        title="确认任务清单"
        width={640}
      >
        <div className="pa-drafts">
          {(taskDrafts || []).map((t) => (
            <div className="pa-draft" key={t.key}>
              <div className="pa-draft-head">
                <Input
                  value={t.title}
                  onChange={(e) => editDraft(t.key, 'title', e.target.value)}
                  placeholder="任务标题"
                />
                <Tag color={PRIORITY_COLOR[t.priority] || 'default'}>{PRIORITY_LABEL[t.priority] || '中'}</Tag>
                <span className="pa-draft-type">{taskTypeLabel(t.taskType)}</span>
              </div>
              <Input.TextArea
                value={t.description}
                onChange={(e) => editDraft(t.key, 'description', e.target.value)}
                rows={2}
                placeholder="任务描述"
              />
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
