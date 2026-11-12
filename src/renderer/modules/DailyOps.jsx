import React, { useMemo, useState } from 'react';
import {
  Tabs,
  Card,
  Tag,
  Button,
  Input,
  Select,
  Segmented,
  Space,
  Collapse,
  Empty,
  Typography,
  App as AntApp,
} from 'antd';
import Markdown from '../components/Markdown.jsx';
// Markdown → 纯文本的唯一真源（复制到剪贴板 / 卡片预览切片都走它）。
import { mdToPlain } from '../utils/mdToPlain.js';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset, useMarketingGoal } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import {
  useDailyTasks,
  useCommunities,
  DAILY_TASK_TYPES,
  DAILY_TASK_STATUS,
} from '../store/dailyOpsStore.jsx';
import {
  momentsTypesFor,
  communityTypesFor,
  dailyTemplateFor,
  companyTypeLabel,
  CHANNELS,
  LAYOUT_PLATFORMS,
} from '../data/dailyOpsCatalog.js';
import {
  genMomentsCopy,
  genCommunityCopy,
  genCommunityEvent,
  genContentLayout,
} from '../services/dailyOps.js';

const { Text } = Typography;

// 通用浅色卡片样式（绿色主题 + Apple 极简，复用内联样式）
const CARD = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 12,
  padding: 16,
};
const GREEN = 'var(--c-brand)';
const GREEN_DARK = 'var(--c-brand-dark)';
const GREEN_BG = 'var(--c-brand-tint)';
const FAINT = 'var(--c-text-3)';

function todayLabel() {
  return new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}

function channelInfo(key) {
  const c = CHANNELS.find((x) => x.key === key);
  return c || { key, label: key || '其他', icon: '📌' };
}

function copyTextFallback(text, onDone) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (onDone) onDone();
  } catch {
    /* 交给调用方兜底提示 */
  }
}

export default function DailyOps({ onSelectModule }) {
  const { message } = AntApp.useApp();
  const { currentCompany, currentProject, companyProjects } = useCompany();
  const { asset } = useMarketingAsset();
  const { goal } = useMarketingGoal();
  const { getKnowledge } = useCompanyKnowledge();
  const { addAsset } = useAssets();
  const {
    addDailyTask,
    updateDailyTask,
    removeDailyTask,
    setDailyTaskStatus,
    listDailyTasks,
  } = useDailyTasks();
  const { addCommunity, removeCommunity, listCommunities } = useCommunities();

  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';
  const knowledge = getKnowledge(currentCompany && currentCompany.id);
  const goalLabel = goal ? goal.label : '';
  const companyId = currentCompany ? currentCompany.id : '';

  // 关联项目（朋友圈/社群/排版共用一个选择器，默认不关联）
  const [projectId, setProjectId] = useState(null);

  // 复制工具
  // 【0.21.25 报障「生的文章 不要有 ## ** 这种没有意义的符号」】剪贴板不经过渲染器，
  // 原来复制出去的是模型吐的原始 Markdown（`## 最终文章` `**重点**` 原样可见）。
  // 本页三个复制入口（朋友圈文案 :823 / 群内容 7 字段 :1111 / 排版正文 :1340）
  // 全部走这一个函数，所以在出口处剥一次标记即可，不动任何一个调用点。
  function copyText(text) {
    const t = mdToPlain(String(text || ''));
    if (!t) {
      message.warning('没有可复制的内容');
      return;
    }
    const done = () => message.success('已复制到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(t)
        .then(done)
        .catch(() => {
          copyTextFallback(t, done);
        });
    } else {
      copyTextFallback(t, done);
    }
  }

  // 组装 AI 生成所需的统一上下文参数
  function ctxParams() {
    const project = projectId
      ? companyProjects.find((p) => p.id === projectId) || null
      : null;
    return {
      company: currentCompany,
      asset,
      knowledge,
      project,
      goalLabel,
    };
  }

  function saveAssetCommon(type, name, content, tags) {
    if (!currentCompany) {
      message.warning('当前无企业上下文，无法保存');
      return;
    }
    addAsset({
      type,
      companyId: currentCompany.id,
      projectId: projectId || null,
      name,
      content,
      tags,
    });
    message.success('已保存为项目资产');
  }

  // ===================== Tab 1：今日运营 =====================
  const [taskTitle, setTaskTitle] = useState('');
  const [taskType, setTaskType] = useState('moments');
  const [taskChannel, setTaskChannel] = useState('moments');
  const [taskScheduledAt, setTaskScheduledAt] = useState('');
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editingTaskTitle, setEditingTaskTitle] = useState('');

  const companyTasks = useMemo(
    () => listDailyTasks({ companyId }),
    [listDailyTasks, companyId],
  );

  const taskStats = useMemo(() => {
    const s = { moments: 0, community: 0, social_post: 0, review: 0 };
    companyTasks.forEach((t) => {
      if (t.status === 'review') s.review += 1;
      if (Object.prototype.hasOwnProperty.call(s, t.type)) s[t.type] += 1;
    });
    return s;
  }, [companyTasks]);

  function createTask() {
    if (!currentCompany) {
      message.warning('当前无企业上下文');
      return;
    }
    if (!taskTitle.trim()) {
      message.warning('请填写任务标题');
      return;
    }
    addDailyTask({
      companyId: currentCompany.id,
      projectId: projectId || null,
      type: taskType,
      title: taskTitle.trim(),
      channel: taskChannel,
      scheduledAt: taskScheduledAt,
      status: 'todo',
    });
    setTaskTitle('');
    setTaskScheduledAt('');
    message.success('已新建今日任务');
  }

  function commitTaskTitle(id) {
    if (!editingTaskTitle.trim()) {
      message.warning('标题不能为空');
      return;
    }
    updateDailyTask(id, { title: editingTaskTitle.trim() });
    setEditingTaskId(null);
    setEditingTaskTitle('');
  }

  const typeOptions = Object.keys(DAILY_TASK_TYPES).map((k) => ({
    value: k,
    label: DAILY_TASK_TYPES[k],
  }));

  // ===================== Tab 2：朋友圈 =====================
  const momentsTypes = momentsTypesFor(companyType);
  const [momentsType, setMomentsType] = useState(
    momentsTypes.length ? momentsTypes[0].key : '',
  );
  const [momentsRequirement, setMomentsRequirement] = useState('');
  const [momentsBusy, setMomentsBusy] = useState(false);
  const [momentsResult, setMomentsResult] = useState(null);
  const [momentsVersion, setMomentsVersion] = useState('default');

  const momentsTypeLabel = useMemo(() => {
    const t = momentsTypes.find((x) => x.key === momentsType);
    return t ? t.label : '朋友圈';
  }, [momentsTypes, momentsType]);

  function currentMomentsContent() {
    if (!momentsResult) return '';
    if (momentsVersion === 'default') return momentsResult.content || '';
    const idx = Number(momentsVersion);
    const v = momentsResult.versions && momentsResult.versions[idx];
    return v ? v.content : '';
  }

  const versionOptions = useMemo(() => {
    if (!momentsResult || !momentsResult.versions || !momentsResult.versions.length) {
      return [];
    }
    return [
      { label: '默认', value: 'default' },
      ...momentsResult.versions.map((v, i) => ({
        label: v.style || '版本' + (i + 1),
        value: String(i),
      })),
    ];
  }, [momentsResult]);

  async function runGenMoments() {
    if (!momentsType) {
      message.warning('请先选择内容类型');
      return;
    }
    setMomentsBusy(true);
    setMomentsResult(null);
    setMomentsVersion('default');
    try {
      const r = await genMomentsCopy({
        ...ctxParams(),
        typeLabel: momentsTypeLabel,
        requirement: momentsRequirement,
      });
      if (!r) {
        message.error('朋友圈文案生成失败，请检查 AI 连接');
        return;
      }
      setMomentsResult(r);
    } finally {
      setMomentsBusy(false);
    }
  }

  function saveMoments() {
    if (!momentsResult) return;
    saveAssetCommon(
      'copy',
      `朋友圈文案 · ${momentsTypeLabel}`,
      currentMomentsContent(),
      ['朋友圈', '日常内容'],
    );
  }

  // ===================== Tab 3：社群 =====================
  const communityTypes = communityTypesFor(companyType);
  const [ncName, setNcName] = useState('');
  const [ncType, setNcType] = useState('');
  const [ncAudience, setNcAudience] = useState('');
  const [ncPositioning, setNcPositioning] = useState('');
  const [ncNotes, setNcNotes] = useState('');
  const [selectedCommunityId, setSelectedCommunityId] = useState(null);
  const [communityMode, setCommunityMode] = useState('copy');

  // 文案生成（每日运营）
  const [commRequirement, setCommRequirement] = useState('');
  const [commBusy, setCommBusy] = useState(false);
  const [commResult, setCommResult] = useState(null);
  // 社群活动
  const [eventName, setEventName] = useState('');
  const [eventTime, setEventTime] = useState('');
  const [eventBusy, setEventBusy] = useState(false);
  const [eventResult, setEventResult] = useState(null);

  const companyCommunities = useMemo(
    () => listCommunities({ companyId }),
    [listCommunities, companyId],
  );
  const selectedCommunity = useMemo(
    () => companyCommunities.find((c) => c.id === selectedCommunityId) || null,
    [companyCommunities, selectedCommunityId],
  );

  function createCommunity() {
    if (!currentCompany) {
      message.warning('当前无企业上下文');
      return;
    }
    if (!ncName.trim()) {
      message.warning('请填写社群名称');
      return;
    }
    addCommunity({
      companyId: currentCompany.id,
      name: ncName.trim(),
      type: ncType,
      audience: ncAudience,
      positioning: ncPositioning,
      notes: ncNotes,
    });
    setNcName('');
    setNcType('');
    setNcAudience('');
    setNcPositioning('');
    setNcNotes('');
    message.success('已新建社群');
  }

  function onPickCommunityType(key) {
    setNcType(key);
    const t = communityTypes.find((x) => x.key === key);
    if (t) {
      setNcAudience(t.audience || '');
      setNcPositioning(t.positioning || '');
    }
  }

  async function runGenCommunity() {
    if (!selectedCommunity) {
      message.warning('请先选择或新建社群');
      return;
    }
    setCommBusy(true);
    setCommResult(null);
    try {
      const r = await genCommunityCopy({
        ...ctxParams(),
        community: selectedCommunity,
        requirement: commRequirement,
      });
      if (!r) {
        message.error('社群文案生成失败，请检查 AI 连接');
        return;
      }
      setCommResult(r);
    } finally {
      setCommBusy(false);
    }
  }

  async function runGenEvent() {
    if (!selectedCommunity) {
      message.warning('请先选择或新建社群');
      return;
    }
    if (!eventName.trim()) {
      message.warning('请填写活动名称');
      return;
    }
    setEventBusy(true);
    setEventResult(null);
    try {
      const r = await genCommunityEvent({
        ...ctxParams(),
        community: selectedCommunity,
        eventName,
        eventTime,
      });
      if (!r) {
        message.error('社群活动文案生成失败，请检查 AI 连接');
        return;
      }
      setEventResult(r);
    } finally {
      setEventBusy(false);
    }
  }

  function saveCommunityCopy() {
    if (!commResult || !selectedCommunity) return;
    const r = commResult;
    const content = [
      r.topic && '【今日主题】\n' + r.topic,
      r.announcement && '【群公告】\n' + r.announcement,
      r.opening && '【开场】\n' + r.opening,
      r.mainContent && '【主内容】\n' + r.mainContent,
      r.question && '【互动提问】\n' + r.question,
      r.interaction && '【互动引导】\n' + r.interaction,
      r.closing && '【收尾】\n' + r.closing,
    ]
      .filter(Boolean)
      .join('\n\n');
    saveAssetCommon('community_copy', `社群文案 · ${selectedCommunity.name}`, content, [
      '社群',
      '日常内容',
    ]);
  }

  function saveCommunityEvent() {
    if (!eventResult || !selectedCommunity) return;
    const r = eventResult;
    const content = [
      '【活动前】',
      r.before.poster && '- 预热海报：' + r.before.poster,
      r.before.announcement && '- 群公告：' + r.before.announcement,
      r.before.invite && '- 私聊邀请：' + r.before.invite,
      r.before.moments && '- 朋友圈预热：' + r.before.moments,
      '',
      '【活动当天】',
      r.during.opening && '- 开场：' + r.during.opening,
      r.during.guest && '- 嘉宾介绍：' + r.during.guest,
      r.during.questions && r.during.questions.length
        ? '- 互动问题：' + r.during.questions.join(' / ')
        : null,
      r.during.welfare && '- 抽奖/福利：' + r.during.welfare,
      '',
      '【活动结束】',
      r.after.thanks && '- 感谢：' + r.after.thanks,
      r.after.summary && '- 总结：' + r.after.summary,
      r.after.followup && '- 私聊跟进：' + r.after.followup,
      r.after.spread && '- 二次传播：' + r.after.spread,
    ]
      .filter(Boolean)
      .join('\n');
    saveAssetCommon(
      'event_plan',
      `社群活动 · ${eventName || selectedCommunity.name}`,
      content,
      ['社群活动', '日常内容'],
    );
  }

  // ===================== Tab 4：内容排版 =====================
  const [layoutRaw, setLayoutRaw] = useState('');
  const [layoutPlatform, setLayoutPlatform] = useState('wechat');
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutResult, setLayoutResult] = useState(null);

  async function runGenLayout() {
    if (!layoutRaw.trim()) {
      message.warning('请先粘贴需要排版的内容');
      return;
    }
    setLayoutBusy(true);
    setLayoutResult(null);
    try {
      const platformLabel =
        LAYOUT_PLATFORMS.find((p) => p.key === layoutPlatform)?.label || '微信公众号';
      const r = await genContentLayout({
        ...ctxParams(),
        rawContent: layoutRaw,
        platformLabel,
      });
      if (!r) {
        message.error('排版生成失败，请检查 AI 连接');
        return;
      }
      setLayoutResult(r);
    } finally {
      setLayoutBusy(false);
    }
  }

  function saveLayout() {
    if (!layoutResult) return;
    const platformLabel =
      LAYOUT_PLATFORMS.find((p) => p.key === layoutPlatform)?.label || '微信公众号';
    saveAssetCommon('article', `排版文章 · ${platformLabel}`, layoutResult.structured || '', [
      '内容排版',
      '日常内容',
    ]);
  }

  const projectOptions = companyProjects.map((p) => ({ value: p.id, label: p.name }));

  // ===================== 渲染 =====================
  const tabItems = [
    // ---------- Tab 1 今日运营 ----------
    {
      key: 'today',
      label: '今天做什么',
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 24 }}>📅</div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text)' }}>
                {currentCompany ? currentCompany.name : '未选择企业'}
              </div>
              <div style={{ fontSize: 12, color: FAINT }}>
                {companyTypeLabel(companyType)} · {todayLabel()}
              </div>
            </div>
            <Tag color="green" style={{ borderRadius: 999, padding: '2px 12px' }}>
              {companyTypeLabel(companyType)}
            </Tag>
          </div>

          {/* 周期模板（参考节奏） */}
          <div style={{ ...CARD }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', marginBottom: 10 }}>
              ⏰ 今日内容节奏（参考）
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dailyTemplateFor(companyType).map((t, i) => {
                const ci = channelInfo(t.type);
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      background: GREEN_BG,
                      borderRadius: 10,
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: GREEN_DARK, minWidth: 44 }}>
                      {t.slot}
                    </span>
                    <span style={{ fontSize: 16 }}>{ci.icon}</span>
                    <span style={{ fontSize: 13, color: 'var(--c-text)' }}>{t.label}</span>
                    <span style={{ fontSize: 12, color: FAINT }}>{t.hint}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 8 }}>
              * 以上为参考节奏，非固定最佳时间，请结合门店/行业实际情况自行判断。
            </div>
          </div>

          {/* 今日任务看板 */}
          <div style={{ ...CARD }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', marginBottom: 10 }}>
              📋 今日任务看板
            </div>
            <Space wrap size={[8, 8]}>
              {[
                { key: 'moments', label: '朋友圈', unit: '条' },
                { key: 'community', label: '社群', unit: '个' },
                { key: 'social_post', label: '小红书', unit: '篇' },
              ].map((s) => {
                const ci = channelInfo(s.key);
                return (
                  <Tag
                    key={s.key}
                    style={{ fontSize: 13, padding: '4px 12px', borderRadius: 8 }}
                  >
                    {ci.icon} {s.label} {taskStats[s.key]} {s.unit}
                  </Tag>
                );
              })}
              <Tag color="orange" style={{ fontSize: 13, padding: '4px 12px', borderRadius: 8 }}>
                ✅ 待审核 {taskStats.review} 条
              </Tag>
            </Space>

            {companyTasks.length === 0 ? (
              <Empty
                description="今日还没有内容任务，点下方「新建任务」添加"
                style={{ margin: '18px 0' }}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {companyTasks.map((t) => {
                  const ci = channelInfo(t.channel || t.type);
                  const statusColor = {
                    todo: 'default',
                    doing: 'blue',
                    review: 'orange',
                    done: 'green',
                    skipped: 'default',
                  }[t.status] || 'default';
                  return (
                    <div
                      key={t.id}
                      style={{
                        border: '1px solid var(--c-border)',
                        borderRadius: 10,
                        padding: '10px 12px',
                        background: 'var(--c-surface)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 15 }}>{ci.icon}</span>
                        {editingTaskId === t.id ? (
                          <Input
                            size="small"
                            value={editingTaskTitle}
                            onChange={(e) => setEditingTaskTitle(e.target.value)}
                            onPressEnter={() => commitTaskTitle(t.id)}
                            style={{ flex: 1, minWidth: 160 }}
                          />
                        ) : (
                          <span style={{ flex: 1, minWidth: 160, fontSize: 13.5, color: 'var(--c-text)', fontWeight: 600 }}>
                            {t.title}
                          </span>
                        )}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t.channel ? ci.label : ''}
                        </Text>
                        {t.scheduledAt && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {t.scheduledAt}
                          </Text>
                        )}
                        <Tag color={statusColor} style={{ borderRadius: 6 }}>
                          {DAILY_TASK_STATUS[t.status] || t.status}
                        </Tag>
                      </div>
                      <Space size={4} style={{ marginTop: 6 }} wrap>
                        {editingTaskId === t.id ? (
                          <>
                            <Button size="small" type="link" onClick={() => commitTaskTitle(t.id)}>
                              保存
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              onClick={() => {
                                setEditingTaskId(null);
                                setEditingTaskTitle('');
                              }}
                            >
                              取消
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="small"
                              type="link"
                              onClick={() => setDailyTaskStatus(t.id, 'done')}
                            >
                              完成
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              onClick={() => setDailyTaskStatus(t.id, 'skipped')}
                            >
                              推迟
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              onClick={() => setDailyTaskStatus(t.id, 'todo')}
                            >
                              忽略
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              onClick={() => {
                                setEditingTaskId(t.id);
                                setEditingTaskTitle(t.title);
                              }}
                            >
                              修改
                            </Button>
                            <Button
                              size="small"
                              type="text"
                              danger
                              onClick={() => removeDailyTask(t.id)}
                            >
                              删除
                            </Button>
                          </>
                        )}
                      </Space>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 新建任务 */}
            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px dashed var(--c-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }}>+ 新建任务</div>
              <Input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                onPressEnter={createTask}
                placeholder="任务标题，如：发一条种植科普朋友圈"
              />
              <Space wrap>
                <Select
                  value={taskType}
                  onChange={setTaskType}
                  options={typeOptions}
                  style={{ minWidth: 130 }}
                />
                <Select
                  value={taskChannel}
                  onChange={setTaskChannel}
                  options={CHANNELS.map((c) => ({ value: c.key, label: c.icon + ' ' + c.label }))}
                  style={{ minWidth: 130 }}
                />
                <Input
                  value={taskScheduledAt}
                  onChange={(e) => setTaskScheduledAt(e.target.value)}
                  placeholder="时间，如 09:00 / 今天上午"
                  style={{ minWidth: 160 }}
                />
                <Button type="primary" onClick={createTask}>
                  添加任务
                </Button>
              </Space>
            </div>
          </div>
        </div>
      ),
    },

    // ---------- Tab 2 朋友圈 ----------
    {
      key: 'moments',
      label: '朋友圈',
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ ...CARD }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', marginBottom: 10 }}>
              ① 选择内容类型
            </div>
            <Space wrap size={[8, 8]}>
              {momentsTypes.map((t) => (
                <Tag
                  key={t.key}
                  onClick={() => setMomentsType(t.key)}
                  style={{
                    cursor: 'pointer',
                    fontSize: 13,
                    padding: '4px 12px',
                    borderRadius: 8,
                    borderColor: momentsType === t.key ? GREEN : undefined,
                    background: momentsType === t.key ? GREEN_BG : undefined,
                    color: momentsType === t.key ? GREEN_DARK : undefined,
                    fontWeight: momentsType === t.key ? 600 : undefined,
                  }}
                >
                  {t.label}
                </Tag>
              ))}
            </Space>
            <div style={{ fontSize: 12, color: FAINT, marginTop: 8 }}>
              {momentsTypes.find((t) => t.key === momentsType)?.hint || ''}
            </div>

            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', margin: '14px 0 8px' }}>
              ② 补充需求（可留空）
            </div>
            <Input.TextArea
              value={momentsRequirement}
              onChange={(e) => setMomentsRequirement(e.target.value)}
              rows={2}
              placeholder="如：今天想发一条种植相关朋友圈"
            />

            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', margin: '14px 0 8px' }}>
              ③ 关联项目（可留空）
            </div>
            <Select
              value={projectId}
              onChange={(v) => setProjectId(v || null)}
              allowClear
              placeholder="不关联项目"
              options={projectOptions}
              style={{ minWidth: 220 }}
            />

            <div style={{ marginTop: 14 }}>
              <Button type="primary" onClick={runGenMoments} loading={momentsBusy}>
                {momentsBusy ? '生成中…' : '生成朋友圈文案'}
              </Button>
            </div>
          </div>

          {momentsResult && (
            <div style={{ ...CARD }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)' }}>生成结果</span>
                <Space size={8} style={{ marginLeft: 'auto' }}>
                  <Button size="small" onClick={() => copyText(currentMomentsContent())}>
                    复制
                  </Button>
                  <Button size="small" onClick={runGenMoments} loading={momentsBusy}>
                    重新生成
                  </Button>
                  <Button size="small" type="primary" ghost onClick={saveMoments}>
                    保存
                  </Button>
                </Space>
              </div>

              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {momentsResult.suggestTime && (
                  <div
                    style={{
                      padding: '8px 12px',
                      background: GREEN_BG,
                      borderRadius: 10,
                      fontSize: 13,
                      color: GREEN_DARK,
                    }}
                  >
                    ⏰ 建议发布时间：<b>{momentsResult.suggestTime}</b>
                  </div>
                )}
                {momentsResult.timeNote && (
                  <div style={{ fontSize: 12, color: FAINT }}>💡 {momentsResult.timeNote}</div>
                )}

                {momentsResult.imageSuggestions &&
                  momentsResult.imageSuggestions.length > 0 && (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)', marginBottom: 6 }}>
                        🖼️ 配图建议
                      </div>
                      <Space wrap size={[8, 8]}>
                        {momentsResult.imageSuggestions.map((s, i) => (
                          <Tag key={i} style={{ fontSize: 12.5, borderRadius: 6 }}>
                            {s}
                          </Tag>
                        ))}
                      </Space>
                    </div>
                  )}

                {versionOptions.length > 0 && (
                  <Segmented
                    options={versionOptions}
                    value={momentsVersion}
                    onChange={setMomentsVersion}
                  />
                )}

                {/* 朋友圈预览卡片 */}
                <div
                  className="daily-moments-card"
                  style={{
                    maxWidth: 440,
                    background: 'var(--c-surface)',
                    border: '1px solid var(--c-border)',
                    borderRadius: 12,
                    padding: 14,
                    boxShadow: '0 1px 4px var(--c-shadow-color)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: '50%',
                        background: GREEN,
                        color: 'var(--c-on-brand)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 18,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {(asset.companyName || (currentCompany && currentCompany.name) || '企').charAt(0)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--c-text)' }}>
                        {asset.companyName || (currentCompany && currentCompany.name) || '我的企业'}
                      </div>
                      <div style={{ fontSize: 11, color: FAINT }}>
                        {momentsResult.suggestTime ? '建议 ' + momentsResult.suggestTime + ' 发布' : '刚刚'}
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.7,
                      whiteSpace: 'pre-wrap',
                      color: 'var(--c-text)',
                    }}
                  >
                    {mdToPlain(currentMomentsContent()) || '（文案为空）'}
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      height: 120,
                      border: '1px dashed var(--c-border-strong)',
                      borderRadius: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--c-text-3)',
                      fontSize: 12,
                      background: 'var(--c-surface-2)',
                    }}
                  >
                    [图片]
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      display: 'flex',
                      gap: 18,
                      color: 'var(--c-text-3)',
                      fontSize: 12,
                    }}
                  >
                    <span>❤️ 赞</span>
                    <span>💬 评论</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ),
    },

    // ---------- Tab 3 社群 ----------
    {
      key: 'community',
      label: '社群',
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 社群列表 + 新建 */}
          <div style={{ ...CARD }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', marginBottom: 10 }}>
              💬 我的社群
            </div>
            {companyCommunities.length === 0 ? (
              <Empty
                description="还没有社群，在下方新建一个"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                style={{ margin: '12px 0' }}
              />
            ) : (
              <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
                {companyCommunities.map((c) => (
                  <Tag
                    key={c.id}
                    onClick={() => setSelectedCommunityId(c.id)}
                    style={{
                      cursor: 'pointer',
                      fontSize: 13,
                      padding: '4px 12px',
                      borderRadius: 8,
                      borderColor: selectedCommunityId === c.id ? GREEN : undefined,
                      background: selectedCommunityId === c.id ? GREEN_BG : undefined,
                      color: selectedCommunityId === c.id ? GREEN_DARK : undefined,
                      fontWeight: selectedCommunityId === c.id ? 600 : undefined,
                    }}
                  >
                    {c.name}
                  </Tag>
                ))}
              </Space>
            )}

            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'new',
                  label: '+ 新建社群',
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <Input
                        value={ncName}
                        onChange={(e) => setNcName(e.target.value)}
                        placeholder="社群名称，如：种植患者群"
                      />
                      <Select
                        value={ncType || undefined}
                        onChange={onPickCommunityType}
                        placeholder="社群类型"
                        options={communityTypes.map((t) => ({
                          value: t.key,
                          label: t.label + '（' + t.audience + '）',
                        }))}
                        style={{ minWidth: 220 }}
                      />
                      <Input
                        value={ncAudience}
                        onChange={(e) => setNcAudience(e.target.value)}
                        placeholder="目标人群"
                      />
                      <Input
                        value={ncPositioning}
                        onChange={(e) => setNcPositioning(e.target.value)}
                        placeholder="社群定位"
                      />
                      <Input
                        value={ncNotes}
                        onChange={(e) => setNcNotes(e.target.value)}
                        placeholder="备注（可留空）"
                      />
                      <div>
                        <Button type="primary" onClick={createCommunity}>
                          创建社群
                        </Button>
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </div>

          {selectedCommunity ? (
            <div style={{ ...CARD }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)' }}>
                  {selectedCommunity.name}
                </span>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {selectedCommunity.audience}
                </Text>
                <Button
                  size="small"
                  type="text"
                  danger
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    removeCommunity(selectedCommunity.id);
                    setSelectedCommunityId(null);
                  }}
                >
                  删除社群
                </Button>
              </div>

              <div style={{ margin: '12px 0' }}>
                <Segmented
                  options={[
                    { label: '每日内容', value: 'copy' },
                    { label: '社群活动', value: 'event' },
                  ]}
                  value={communityMode}
                  onChange={setCommunityMode}
                />
              </div>

              {communityMode === 'copy' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Input.TextArea
                    value={commRequirement}
                    onChange={(e) => setCommRequirement(e.target.value)}
                    rows={2}
                    placeholder="今日群内容需求（可留空），如：聊种植术后护理"
                  />
                  <div>
                    <Button type="primary" onClick={runGenCommunity} loading={commBusy}>
                      {commBusy ? '生成中…' : '生成今日群内容内容'}
                    </Button>
                  </div>

                  {commResult && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text)' }}>
                          群内容内容
                        </span>
                        <Space size={8} style={{ marginLeft: 'auto' }}>
                          <Button
                            size="small"
                            onClick={() =>
                              copyText(
                                [
                                  commResult.topic && '【今日主题】' + commResult.topic,
                                  commResult.announcement && '【群公告】' + commResult.announcement,
                                  commResult.opening && '【开场】' + commResult.opening,
                                  commResult.mainContent && '【主内容】' + commResult.mainContent,
                                  commResult.question && '【互动提问】' + commResult.question,
                                  commResult.interaction && '【互动引导】' + commResult.interaction,
                                  commResult.closing && '【收尾】' + commResult.closing,
                                ]
                                  .filter(Boolean)
                                  .join('\n\n'),
                              )
                            }
                          >
                            复制全部
                          </Button>
                          <Button size="small" type="primary" ghost onClick={saveCommunityCopy}>
                            保存
                          </Button>
                        </Space>
                      </div>
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {[
                          ['今日主题', commResult.topic],
                          ['群公告', commResult.announcement],
                          ['开场', commResult.opening],
                          ['主内容', commResult.mainContent],
                          ['互动提问', commResult.question],
                          ['互动引导', commResult.interaction],
                          ['收尾', commResult.closing],
                        ]
                          .filter(([, v]) => v)
                          .map(([label, v]) => (
                            <div
                              key={label}
                              style={{
                                border: '1px solid var(--c-border)',
                                borderRadius: 10,
                                padding: '10px 12px',
                                background: 'var(--c-surface-2)',
                              }}
                            >
                              <div style={{ fontSize: 12, color: GREEN_DARK, fontWeight: 700, marginBottom: 4 }}>
                                {label}
                              </div>
                              <div style={{ fontSize: 13.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: 'var(--c-text)' }}>
                                {mdToPlain(v)}
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Space wrap>
                    <Input
                      value={eventName}
                      onChange={(e) => setEventName(e.target.value)}
                      placeholder="活动名称，如：种植科普分享会"
                      style={{ minWidth: 200 }}
                    />
                    <Input
                      value={eventTime}
                      onChange={(e) => setEventTime(e.target.value)}
                      placeholder="活动时间，如：本周六晚 8 点"
                      style={{ minWidth: 180 }}
                    />
                    <Button type="primary" onClick={runGenEvent} loading={eventBusy}>
                      {eventBusy ? '生成中…' : '生成活动全流程文案'}
                    </Button>
                  </Space>

                  {eventResult && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text)' }}>
                          活动文案（三阶段）
                        </span>
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          style={{ marginLeft: 'auto' }}
                          onClick={saveCommunityEvent}
                        >
                          保存
                        </Button>
                      </div>
                      {[
                        ['活动前', eventResult.before, [
                          ['预热海报', 'poster'],
                          ['群公告', 'announcement'],
                          ['私聊邀请', 'invite'],
                          ['朋友圈预热', 'moments'],
                        ]],
                        ['活动当天', eventResult.during, [
                          ['开场', 'opening'],
                          ['嘉宾介绍', 'guest'],
                          ['抽奖/福利', 'welfare'],
                        ]],
                        ['活动结束', eventResult.after, [
                          ['感谢', 'thanks'],
                          ['总结', 'summary'],
                          ['私聊跟进', 'followup'],
                          ['二次传播', 'spread'],
                        ]],
                      ].map(([stage, obj, fields]) => (
                        <div key={stage} style={{ marginTop: 10 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: GREEN_DARK,
                              background: GREEN_BG,
                              padding: '6px 12px',
                              borderRadius: 8,
                            }}
                          >
                            {stage}
                          </div>
                          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {fields
                              .filter(([, k]) => obj[k])
                              .map(([label, k]) => (
                                <div
                                  key={label}
                                  style={{
                                    border: '1px solid var(--c-border)',
                                    borderRadius: 10,
                                    padding: '8px 12px',
                                    background: 'var(--c-surface-2)',
                                  }}
                                >
                                  <div style={{ fontSize: 12, color: FAINT, marginBottom: 2 }}>
                                    {label}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 13,
                                      lineHeight: 1.7,
                                      whiteSpace: 'pre-wrap',
                                      color: 'var(--c-text)',
                                    }}
                                  >
                                    {mdToPlain(obj[k])}
                                  </div>
                                </div>
                              ))}
                            {obj.questions && obj.questions.length > 0 && (
                              <div
                                style={{
                                  border: '1px solid var(--c-border)',
                                  borderRadius: 10,
                                  padding: '8px 12px',
                                  background: 'var(--c-surface-2)',
                                }}
                              >
                                <div style={{ fontSize: 12, color: FAINT, marginBottom: 2 }}>
                                  互动问题
                                </div>
                                {obj.questions.map((q, i) => (
                                  <div key={i} style={{ fontSize: 13, lineHeight: 1.7 }}>
                                    · {q}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <Empty description="选择或新建一个社群后开始生成" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </div>
      ),
    },

    // ---------- Tab 4 内容排版 ----------
    {
      key: 'layout',
      label: '内容排版',
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ ...CARD }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', marginBottom: 10 }}>
              📝 粘贴内容，一键结构化排版
            </div>
            <Input.TextArea
              value={layoutRaw}
              onChange={(e) => setLayoutRaw(e.target.value)}
              rows={6}
              placeholder="粘贴要排版的长文内容…"
            />
            <Space wrap style={{ marginTop: 10 }}>
              <Select
                value={layoutPlatform}
                onChange={setLayoutPlatform}
                options={LAYOUT_PLATFORMS.map((p) => ({ value: p.key, label: p.label }))}
                style={{ minWidth: 160 }}
              />
              <Select
                value={projectId}
                onChange={(v) => setProjectId(v || null)}
                allowClear
                placeholder="不关联项目"
                options={projectOptions}
                style={{ minWidth: 160 }}
              />
              <Button type="primary" onClick={runGenLayout} loading={layoutBusy}>
                {layoutBusy ? '排版中…' : '生成排版'}
              </Button>
            </Space>
          </div>

          {layoutResult && (
            <div style={{ ...CARD }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)' }}>排版结果</span>
                <Space size={8} style={{ marginLeft: 'auto' }}>
                  <Button
                    size="small"
                    onClick={() => copyText(layoutResult.structured || '')}
                  >
                    复制正文
                  </Button>
                  <Button size="small" type="primary" ghost onClick={saveLayout}>
                    保存
                  </Button>
                </Space>
              </div>

              {layoutResult.platformNote && (
                <div
                  style={{
                    marginTop: 10,
                    padding: '8px 12px',
                    background: GREEN_BG,
                    borderRadius: 10,
                    fontSize: 12.5,
                    color: GREEN_DARK,
                  }}
                >
                  💡 {layoutResult.platformNote}
                </div>
              )}

              {layoutResult.title && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: FAINT, marginBottom: 2 }}>标题</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text)' }}>
                    {layoutResult.title}
                  </div>
                </div>
              )}

              {layoutResult.outline && layoutResult.outline.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: FAINT, marginBottom: 6 }}>大纲</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {layoutResult.outline.map((o, i) => (
                      <div key={i} style={{ fontSize: 13, color: 'var(--c-text)' }}>
                        {i + 1}. {o}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {layoutResult.boldPoints && layoutResult.boldPoints.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: FAINT, marginBottom: 6 }}>重点加粗</div>
                  <Space wrap size={[8, 8]}>
                    {layoutResult.boldPoints.map((b, i) => (
                      <Tag key={i} color="green" style={{ fontSize: 12.5, borderRadius: 6 }}>
                        {b}
                      </Tag>
                    ))}
                  </Space>
                </div>
              )}

              {layoutResult.structured && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: FAINT, marginBottom: 6 }}>结构化正文</div>
                  <div
                    style={{
                      border: '1px solid var(--c-border)',
                      borderRadius: 10,
                      padding: '12px 14px',
                      background: 'var(--c-surface-2)',
                      fontSize: 13.5,
                      lineHeight: 1.7,
                    }}
                  >
                    <Markdown>{layoutResult.structured}</Markdown>
                  </div>
                </div>
              )}

              {layoutResult.imageSlots && layoutResult.imageSlots.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: FAINT, marginBottom: 6 }}>配图位置</div>
                  {layoutResult.imageSlots.map((s, i) => (
                    <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--c-text)' }}>
                      <b>{s.position}</b>：{s.suggestion}
                    </div>
                  ))}
                </div>
              )}

              {layoutResult.cta && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: FAINT, marginBottom: 2 }}>文末 CTA</div>
                  <div style={{ fontSize: 13.5, color: 'var(--c-text)' }}>{layoutResult.cta}</div>
                </div>
              )}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="module-page">
      <div className="module-page-head">
        <h2 className="module-page-title">📅 日常内容</h2>
        <p className="module-page-sub">
          每天打开就知道「今天发什么、群里说什么、内容怎么排版」。AI 生成 → 人审核 → 人复制发布，不做自动发布。
        </p>
      </div>

      <Tabs
        defaultActiveKey="today"
        items={tabItems}
        style={{ marginTop: 4 }}
        tabBarStyle={{ borderBottom: '1px solid var(--c-border)' }}
      />
    </div>
  );
}
