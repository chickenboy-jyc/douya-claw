import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Divider,
  Empty,
  Input,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useCampaign, CAMPAIGN_STATUS, CAMPAIGN_TYPES } from '../store/campaignStore.jsx';
import { ACTIVITY_SUBJECTS, ACTIVITY_SUBJECT_LIST } from '../config/activitySubjects.js';
import { useCompany } from '../store/companyStore.jsx';
import { generateCampaignOptionsAI, GEN_SOURCE, GEN_SOURCE_LABEL } from '../services/campaignAI.js';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { rankCampaigns } from '../services/campaignPriority.js';
import { toSignal, tierToHealth, HEALTH_LEVEL } from '../services/campaignSignal.js';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

/** 状态标签配色（与生命周期一致，不自行发明语义）。 */
const STATUS_COLOR = {
  planning: 'blue',
  preparing: 'gold',
  ongoing: 'green',
  ended: 'default',
  reviewed: 'purple',
};

/** 健康度三档配色。 */
const HEALTH_COLOR = { handle: 'red', watch: 'orange', normal: 'green' };

/**
 * 「营销专项」主模块（设计文档 docs/营销战役-设计定稿.md v3 + docs/战役列表-设计定稿.md）。
 *
 * 定位（v3 §0 强卡）：不是活动策划页、不是 AI 项目管理工具。
 * 结构 = 为什么现在做 → 这个专项要改变什么 → 豆芽准备怎么做 → 豆芽正在推进 → 结果怎么样。
 *
 * 视图状态机：list（专项驾驶舱）/ generator（一句话新建）/ draft（草案确认，planning 态）/ edit（高级设置草案编辑器，planning 态）/ detail（五段式详情）。
 *
 * planning 语义（v3 §8 核心差异）：planning 是「老板还没确认」的真实停留态——
 * 一句话生成后 campaign 落库为 planning，老板在草案视图确认后才 planning→preparing。
 * 不是「换个 status 名字」，确认动作是显式的、可撤销的。
 *
 * 高级设置（P2-E）：是「草案编辑器」，不是第二套创建系统、不是第二个确认入口。
 *   planning → edit（只改数据，updateCampaign 不碰 status）→ 仍 planning → 老板确认 → preparing。
 *   编辑器不调 createCampaign、不碰 activityStore、不改 results/review/decisions。
 *
 * 跨模块回流（市场与声势 → 营销专项）：
 *   - initialActivityId（B·adjust）→ 定位已有专项卡片；
 *   - initialBrief（C·confirm_brief）→ 进生成器并预填；
 *   两者只在 mount 消费一次，消费后回调 onIntentConsumed 清空上层 intent。
 */
export default function CampaignModule({ initialActivityId = null, initialBrief = null, onIntentConsumed = null, onSelectModule = null }) {
  const { message } = AntApp.useApp();
  const {
    listCampaigns,
    getCampaign,
    createCampaign,
    updateCampaign,
    confirmCampaign,
    deleteCampaign,
    startCampaign,
    endCampaign,
    upsertDecision,
    campaigns: allCampaigns,
  } = useCampaign();
  const { currentCompany } = useCompany();
  const { getKnowledge } = useCompanyKnowledge();
  const { listAssets } = useAssets();

  const companyId = (currentCompany && currentCompany.id) || null;
  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';

  const [view, setView] = useState('list');
  const [detailId, setDetailId] = useState(null);
  const [intentText, setIntentText] = useState('');
  // 多方案卡片（null=未生成；生成后渲染 3 套打法，点选其中一套进 draft）
  const [optionCards, setOptionCards] = useState(null);
  // planning 态草案的 campaign id（老板还没确认）
  const [draftId, setDraftId] = useState(null);
  // 高级设置编辑副本（planning 草稿的深拷贝，本地受控表单；保存前不动 store）
  const [editForm, setEditForm] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  // 一句话新建的生成态：genBusy=正在生成（禁用按钮 + 转圈）；genSource='ai'|'template'|null（来源标签，诚实标注）
  const [genBusy, setGenBusy] = useState(false);
  const [genSource, setGenSource] = useState(null);

  /**
   * 当前企业的专项列表。
   * 依赖里必须带 store 的 `campaigns`：listCampaigns 是 useCallback([])（身份恒定），
   * 只依赖 [companyId, listCampaigns] 会让这个 useMemo 只算一次 —— 新建 / 删除专项后列表不刷新，
   * 必须切模块再回来才看得到（2026-09-12 与活动列表同一个坑，一并修）。
   */
  const campaigns = useMemo(
    () => (companyId ? listCampaigns({ companyId }) : []),
    [companyId, listCampaigns, allCampaigns],
  );
  const detail = detailId ? getCampaign(detailId) : null;
  const draftCampaignObj = draftId ? getCampaign(draftId) : null;

  // 消费「市场与声势 → 营销专项」回流意图（mount 一次性）。
  const intentConsumedRef = useRef(false);
  useEffect(() => {
    if (intentConsumedRef.current) return;
    if (initialBrief && initialBrief.title) {
      setView('generator');
      setDraftId(null);
      setIntentText(initialBrief.title || '');
      intentConsumedRef.current = true;
      if (onIntentConsumed) onIntentConsumed();
    } else if (initialActivityId) {
      const c = getCampaign(initialActivityId);
      intentConsumedRef.current = true;
      setView('list');
      if (c) {
        setHighlightId(c.id);
      } else {
        message.info('对应专项已不存在，请在下方现有专项中查看。');
      }
      if (onIntentConsumed) onIntentConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialActivityId, initialBrief]);

  useEffect(() => {
    if (highlightId && view === 'list') {
      const el = document.getElementById('campaign-' + highlightId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightId, view, campaigns]);

  // —— 一句话新建：大模型优先产 3 套打法方案卡，AI 不可用则诚实降级本地关键词模板（多方案卡片式选择，不落库） ——
  // 组装给 buildAIContext 的上下文（企业 + 资产 + 企业长期知识），与 TodayOps.buildPlanCtx 同口径；
  // 任一层取数失败都不阻塞生成（降级为空对象，AI 仍可仅凭一句话给打法）。
  function buildCtxInput() {
    let asset = null;
    try {
      const list = companyId ? listAssets({ companyId }) : [];
      asset = (list && list[0]) || null;
    } catch {
      asset = null;
    }
    let knowledge = null;
    try {
      knowledge = companyId ? getKnowledge(companyId) : null;
    } catch {
      knowledge = null;
    }
    return { company: currentCompany || null, asset, knowledge };
  }

  async function handleGenerate() {
    if (genBusy) return;
    if (!companyId) {
      message.warning('请先在左上角选择一个企业，再新建专项');
      return;
    }
    if (!intentText.trim()) {
      message.warning('先告诉豆芽你想做成一件什么事');
      return;
    }
    setGenBusy(true);
    try {
      const res = await generateCampaignOptionsAI(intentText, buildCtxInput(), {
        subjectType: companyType,
        companyName: currentCompany ? currentCompany.name : '',
        source: initialBrief && initialBrief.source ? initialBrief.source : 'user',
        briefText: intentText,
      });
      // 永不死路：无论 AI 成败，generateCampaignOptionsAI 都返回 3 张可用的卡。
      setOptionCards(res.cards);
      setGenSource(res.source);
      if (!res.ok) {
        message.info('这次没接上大模型，已用本地模板给你 3 套打法（可重试）');
      }
    } catch {
      // generateCampaignOptionsAI 内部已全面兜底（永不抛），这里仅防御性兜底。
      message.error('生成方案失败，请重试');
    } finally {
      setGenBusy(false);
    }
  }

  // —— 选中某套打法：落库 planning 态（老板还没确认）→ 进 draft ——
  function handlePickOption(card) {
    if (!companyId || !card || !card.draft) return;
    const c = createCampaign({ ...card.draft, companyId, status: 'planning' });
    if (c) {
      setOptionCards(null);
      setDraftId(c.id);
      setView('draft');
    } else {
      message.error('生成草案失败');
    }
  }

  // —— 老板确认草案：planning → preparing ——
  function handleConfirmDraft() {
    if (!draftId) return;
    confirmCampaign(draftId);
    setDetailId(draftId);
    setDraftId(null);
    setIntentText('');
    setView('detail');
    message.success('已确认，豆芽开始推进这个专项');
  }

  // —— 重新描述：删除当前 planning 草案，回到生成器 ——
  function handleDiscardDraft() {
    if (draftId) deleteCampaign(draftId);
    setDraftId(null);
    setIntentText('');
    setView('generator');
  }

  // ================= 高级设置（草案编辑器，planning 态） =================
  // 核心语义：编辑器只改数据，不推进状态、不产生 Activity、不成为第二个确认入口。
  //   planning → 编辑 → 仍 planning → 老板在草案页确认 → preparing
  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
  function localUid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function splitLines(text) { return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean); }

  function startEdit(c) {
    if (!c) return;
    setDraftId(c.id);
    setEditForm(deepClone(c));
    setView('edit');
  }
  function patchEdit(patch) { setEditForm((p) => (p ? { ...p, ...patch } : p)); }
  function patchOutcome(key, val) { setEditForm((p) => (p ? { ...p, outcomes: { ...p.outcomes, [key]: val } } : p)); }
  function patchSubject(key) {
    setEditForm((p) => {
      if (!p) return p;
      const label = (ACTIVITY_SUBJECTS[key] && ACTIVITY_SUBJECTS[key].label) || '';
      const subjectLabel = currentCompany && currentCompany.name ? `${label} · ${currentCompany.name}` : label;
      return { ...p, subjectType: key, subjectLabel };
    });
  }
  function patchStage(i, patch) {
    setEditForm((p) => {
      if (!p) return p;
      const stages = p.stages.slice();
      stages[i] = { ...stages[i], ...patch };
      return { ...p, stages };
    });
  }
  function addStage() {
    setEditForm((p) => (p ? { ...p, stages: [...p.stages, { key: localUid(), name: '新阶段', startDate: '', endDate: '', milestones: [] }] } : p));
  }
  function removeStage(i) { setEditForm((p) => (p ? { ...p, stages: p.stages.filter((_, j) => j !== i) } : p)); }
  function patchAction(i, patch) {
    setEditForm((p) => {
      if (!p) return p;
      const actions = p.actions.slice();
      actions[i] = { ...actions[i], ...patch };
      return { ...p, actions };
    });
  }
  function addAction() {
    setEditForm((p) => (p ? { ...p, actions: [...p.actions, { id: localUid(), title: '', owner: 'douya', status: 'todo', why: '' }] } : p));
  }
  function removeAction(i) { setEditForm((p) => (p ? { ...p, actions: p.actions.filter((_, j) => j !== i) } : p)); }
  function patchBriefList(field, i, val) {
    setEditForm((p) => {
      if (!p) return p;
      const arr = p.brief[field].slice();
      arr[i] = val;
      return { ...p, brief: { ...p.brief, [field]: arr } };
    });
  }
  function addBriefItem(field) {
    setEditForm((p) => (p ? { ...p, brief: { ...p.brief, [field]: [...p.brief[field], ''] } } : p));
  }
  function removeBriefItem(field, i) {
    setEditForm((p) => (p ? { ...p, brief: { ...p.brief, [field]: p.brief[field].filter((_, j) => j !== i) } } : p));
  }

  function handleSaveEdit() {
    if (!draftId || !editForm) return;
    // 只更新可编辑字段：不碰 status（保持 planning）、results/review/decisions。
    updateCampaign(draftId, {
      name: editForm.name,
      type: editForm.type,
      subjectType: editForm.subjectType,
      subjectLabel: editForm.subjectLabel,
      startDate: editForm.startDate,
      endDate: editForm.endDate,
      outcomes: editForm.outcomes,
      stages: editForm.stages,
      actions: editForm.actions,
      brief: editForm.brief,
    });
    setEditForm(null);
    setView('draft');
    message.success('已保存，专项仍待你确认');
  }

  function handleCancelEdit() {
    setEditForm(null);
    setView('draft');
  }

  function handleStatusForward(c) {
    const map = {
      planning: { fn: confirmCampaign, label: '确认并开始筹备' },
      preparing: { fn: startCampaign, label: '开始进行' },
      ongoing: { fn: endCampaign, label: '结束专项' },
    };
    const a = map[c.status];
    if (a && a.fn(c.id)) message.success(`已${a.label}`);
  }

  function handleResolveDecision(c, d) {
    upsertDecision(c.id, { ...d, status: 'resolved' });
    message.success('已记录决策');
  }

  // ================= 专项驾驶舱派生数据（list 视图用，但必须**无条件**计算） =================
  // 这两个 useMemo 原先是放在 generator / draft / edit / detail 四个「提前 return」**之后**的：
  //    list 视图会执行到它们（渲染 N+2 个 hook），一旦切到非 list 视图，早退发生在它们之前 →
  //    同一组件两次渲染经过的 hook 数量不一致 → React #300「Rendered fewer hooks than expected」
  //    → ErrorBoundary 兜底 → **整页白屏**（2026-09-12 老板实测「今天做什么 → 活动策划」白屏根因）。
  //    修法：把整段（含纯计算）上移到第一个早退之前，让 hook 顺序在**所有分支**上一致。
  //    注意 pending/inFlight/reviewed 虽与 hook 无关，也一并前置，保持这段是一个自洽整体。
  const pending = campaigns.filter((c) => c.status === 'planning');
  const inFlight = campaigns.filter((c) => c.status !== 'planning' && c.status !== 'reviewed');
  const reviewed = campaigns.filter((c) => c.status === 'reviewed');

  // 接排序引擎：Campaign → 信号快照 → rankCampaigns → 三档
  const ranked = useMemo(() => rankCampaigns(inFlight.map(toSignal)), [inFlight]);
  const healthGroups = useMemo(() => {
    const g = { handle: [], watch: [], normal: [] };
    ranked.forEach((r) => {
      const h = tierToHealth(r.tier);
      const c = getCampaign(r.id);
      if (c) g[h].push({ campaign: c, ranked: r });
    });
    return g;
  }, [ranked, getCampaign]);

  const handleCount = healthGroups.handle.length;
  const watchCount = healthGroups.watch.length;

  // ================= 一句话新建（生成器） =================
  if (view === 'generator') {
    return (
      <div className="module-page">
        <div className="module-page-head">
          <h2 className="module-page-title">营销专项</h2>
</div>

        <Card className="campaign-gen">
          <TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            value={intentText}
            onChange={(e) => { setIntentText(e.target.value); setOptionCards(null); setGenSource(null); }}
            placeholder="下个月参加华南口腔展，帮我把这次营销做起来"
            onPressEnter={(e) => { e.preventDefault(); handleGenerate(); }}
          />
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Button type="primary" loading={genBusy} onClick={handleGenerate}>生成方案（多套可选）→</Button>
            <Button type="link" onClick={() => setView('list')}>返回专项列表</Button>
          </div>
        </Card>

        {optionCards && optionCards.length > 0 && (
          <div className="campaign-options">
            <div className="campaign-options-head" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>豆芽给你 3 套打法，挑一套最顺手的：</span>
              {genSource ? <Tag color={genSource === GEN_SOURCE.AI ? 'green' : 'default'}>{GEN_SOURCE_LABEL[genSource]}</Tag> : null}
            </div>
            <div className="campaign-options-list">
              {optionCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="campaign-option-card"
                  onClick={() => handlePickOption(card)}
                >
                  <div className="campaign-option-title">
                    <span className="campaign-option-name">{card.title}</span>
                    <Tag color="green">{CAMPAIGN_TYPES[card.type]}</Tag>
                  </div>
                  <div className="campaign-option-tagline">{card.tagline}</div>
                  <div className="campaign-option-reason"> {card.reason}</div>
                  <div className="campaign-option-cta">选这套，让豆芽细化 →</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ================= 草案确认（planning 态，老板还没确认） =================
  if (view === 'draft' && draftCampaignObj) {
    const d = draftCampaignObj;
    return (
      <div className="module-page">
        <div className="module-page-head">
          <h2 className="module-page-title">营销专项 · 草案待确认</h2>
</div>

        <Card className="campaign-draft">
          <Title level={5}>{d.name}</Title>
          <Space size={6} wrap>
            {d.subjectLabel ? <Tag color="green">{d.subjectLabel}</Tag> : null}
            <Tag color="blue">{CAMPAIGN_TYPES[d.type]}</Tag>
            <Tag color="blue">规划中（待你确认）</Tag>
          </Space>
          <Paragraph type="secondary" style={{ marginTop: 8 }}>{d.whyNow.conclusion}</Paragraph>

          <div style={{ marginTop: 8 }}>
            {d.brief.assumptions.map((a, i) => (
              <div key={i} style={{ margin: '4px 0' }}>
                <Tag color="orange">AI假设</Tag>
                <Text type="secondary">{a}</Text>
              </div>
            ))}
          </div>

          <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            确认前不会创建任何执行动作；你可以「高级设置编辑」调整草案，或「重新描述」换一句话让豆芽重新匹配。
          </Paragraph>

          <Space style={{ marginTop: 16 }} wrap>
            <Button type="primary" onClick={handleConfirmDraft}>确认，交给豆芽推进</Button>
            <Button onClick={() => startEdit(d)}>高级设置编辑</Button>
            <Button onClick={handleDiscardDraft}>重新描述</Button>
          </Space>
        </Card>
      </div>
    );
  }

  // ================= 高级设置（草案编辑器，planning 态） =================
  if (view === 'edit' && editForm) {
    const e = editForm;
    const typeOptions = Object.entries(CAMPAIGN_TYPES).map(([value, label]) => ({ value, label }));
    const subjectOptions = ACTIVITY_SUBJECT_LIST.map((s) => ({ value: s.key, label: s.label }));
    return (
      <div className="module-page">
        <div className="module-page-head">
          <h2 className="module-page-title">高级设置 · 编辑专项草案</h2>
</div>

        {/* ① 专项基本信息 */}
        <Card title="① 专项基本信息" className="campaign-block" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ display: 'inline-block', width: 96 }}>名称</Text>
            <Input value={e.name} onChange={(ev) => patchEdit({ name: ev.target.value })} style={{ maxWidth: 480 }} placeholder="专项名称" />
          </div>
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ display: 'inline-block', width: 96 }}>类型</Text>
            <Select value={e.type || undefined} options={typeOptions} style={{ width: 220 }} onChange={(v) => patchEdit({ type: v })} placeholder="选择类型" />
          </div>
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ display: 'inline-block', width: 96 }}>主体</Text>
            <Select value={e.subjectType} options={subjectOptions} style={{ width: 220 }} onChange={(v) => patchSubject(v)} />
          </div>
          <div>
            <Text strong style={{ display: 'inline-block', width: 96 }}>时间范围</Text>
            <Space>
              <Input type="date" value={e.startDate} onChange={(ev) => patchEdit({ startDate: ev.target.value })} style={{ width: 160 }} />
              <Text type="secondary">至</Text>
              <Input type="date" value={e.endDate} onChange={(ev) => patchEdit({ endDate: ev.target.value })} style={{ width: 160 }} />
            </Space>
          </div>
        </Card>

        {/* ② 这个专项要改变什么 */}
        <Card title="② 这个专项要改变什么" className="campaign-block" style={{ marginBottom: 12 }}>
          <Paragraph style={{ marginBottom: 4 }}><Text strong>业务结果</Text></Paragraph>
          <TextArea autoSize={{ minRows: 1, maxRows: 3 }} value={e.outcomes.businessOutcome} onChange={(ev) => patchOutcome('businessOutcome', ev.target.value)} style={{ marginBottom: 12 }} />
          <Paragraph style={{ marginBottom: 4 }}><Text strong>声势结果</Text></Paragraph>
          <TextArea autoSize={{ minRows: 1, maxRows: 3 }} value={e.outcomes.momentumOutcome} onChange={(ev) => patchOutcome('momentumOutcome', ev.target.value)} style={{ marginBottom: 12 }} />
          <Paragraph style={{ marginBottom: 4 }}><Text strong>传播计划</Text></Paragraph>
          <TextArea autoSize={{ minRows: 1, maxRows: 3 }} value={e.outcomes.deliveryPlan} onChange={(ev) => patchOutcome('deliveryPlan', ev.target.value)} />
        </Card>

        {/* ③ 豆芽准备怎么做（三阶段） */}
        <Card title="③ 豆芽准备怎么做（三阶段）" className="campaign-block" style={{ marginBottom: 12 }}>
          {e.stages.map((s, i) => (
            <div key={s.key || i} style={{ border: '1px solid var(--c-border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <Space style={{ marginBottom: 8 }} wrap>
                <Input value={s.name} onChange={(ev) => patchStage(i, { name: ev.target.value })} style={{ width: 220 }} placeholder="阶段名称" />
                <Input type="date" value={s.startDate} onChange={(ev) => patchStage(i, { startDate: ev.target.value })} style={{ width: 156 }} />
                <Input type="date" value={s.endDate} onChange={(ev) => patchStage(i, { endDate: ev.target.value })} style={{ width: 156 }} />
                <Button size="small" danger onClick={() => removeStage(i)}>删除</Button>
              </Space>
              <Paragraph type="secondary" style={{ marginBottom: 4 }}>关键节点（每行一个）</Paragraph>
              <TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={(s.milestones || []).join('\n')} onChange={(ev) => patchStage(i, { milestones: splitLines(ev.target.value) })} />
            </div>
          ))}
          <Button size="small" onClick={addStage}>＋ 添加阶段</Button>
        </Card>

        {/* ④ 推进动作（豆芽做 / 需要你决定） */}
        <Card title="④ 推进动作（豆芽做 / 需要你决定）" className="campaign-block" style={{ marginBottom: 12 }}>
          {e.actions.map((a, i) => (
            <div key={a.id || i} style={{ border: '1px solid var(--c-border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <Space style={{ marginBottom: 8 }} wrap>
                <Input value={a.title} onChange={(ev) => patchAction(i, { title: ev.target.value })} style={{ width: 260 }} placeholder="动作内容" />
                <Select value={a.owner} style={{ width: 140 }} onChange={(v) => patchAction(i, { owner: v })}
                  options={[{ value: 'douya', label: '豆芽做' }, { value: 'boss', label: '需要你决定' }]} />
                <Button size="small" danger onClick={() => removeAction(i)}>删除</Button>
              </Space>
              <Input value={a.why} onChange={(ev) => patchAction(i, { why: ev.target.value })} placeholder="为什么现在做（必填，无法解释因果的动作不落库）" />
            </div>
          ))}
          <Button size="small" onClick={addAction}>＋ 添加动作</Button>
        </Card>

        {/* ⑤ AI 假设与依据 */}
        <Card title="⑤ AI 假设与依据" className="campaign-block" style={{ marginBottom: 12 }}>
          <Paragraph style={{ marginBottom: 4 }}><Text strong>依据（evidence，已确认的事实线索）</Text></Paragraph>
          {e.brief.evidence.length === 0 ? (
            <Paragraph type="secondary">暂无依据</Paragraph>
          ) : e.brief.evidence.map((ev, i) => (
            <Space key={i} size={6} style={{ display: 'flex', marginBottom: 4 }}>
              <Input value={ev} onChange={(v) => patchBriefList('evidence', i, v.target.value)} style={{ width: 420 }} />
              <Button size="small" danger onClick={() => removeBriefItem('evidence', i)}>删除</Button>
            </Space>
          ))}
          <Button size="small" onClick={() => addBriefItem('evidence')}>＋ 添加依据</Button>

          <Divider />

          <Paragraph style={{ marginBottom: 4 }}>
            <Text strong>AI 假设</Text>
            <Text type="secondary">（可编辑，但始终是「假设」，不会自动变成事实）</Text>
          </Paragraph>
          {e.brief.assumptions.map((a, i) => (
            <Space key={i} size={6} style={{ display: 'flex', marginBottom: 4 }}>
              <Tag color="orange">AI假设</Tag>
              <Input value={a} onChange={(v) => patchBriefList('assumptions', i, v.target.value)} style={{ width: 400 }} />
              <Button size="small" danger onClick={() => removeBriefItem('assumptions', i)}>删除</Button>
            </Space>
          ))}
          <Button size="small" onClick={() => addBriefItem('assumptions')}>＋ 添加假设</Button>
        </Card>

        {/* ⑥ 保存 */}
        <Card className="campaign-block">
          <Space>
            <Button type="primary" onClick={handleSaveEdit}>保存（仍待你确认）</Button>
            <Button onClick={handleCancelEdit}>取消返回</Button>
          </Space>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            保存只更新这份专项草案，不改变状态、不产生新专项；确认动作仍在草案页完成。
          </Paragraph>
        </Card>
      </div>
    );
  }

  // ================= 五段式详情 =================
  if (view === 'detail' && detail) {
    const fwdLabel = detail.status === 'preparing' ? '开始进行' : detail.status === 'ongoing' ? '结束专项' : null;
    return (
      <div className="module-page">
        <div className="module-page-head">
          <Space wrap>
            <Button size="small" onClick={() => { setDetailId(null); setView('list'); }}>← 返回</Button>
            <h2 className="module-page-title" style={{ margin: 0 }}>{detail.name}</h2>
            <Tag color={STATUS_COLOR[detail.status]}>{CAMPAIGN_STATUS[detail.status]}</Tag>
          </Space>
</div>

        {/* ① 为什么现在做 */}
        <Card title="① 为什么现在做" className="campaign-block" style={{ marginBottom: 12 }}>
          {(detail.whyNow.facts || []).map((f, i) => (
            <Paragraph key={i} type="secondary" style={{ marginBottom: 4 }}>· {f}</Paragraph>
          ))}
          <Paragraph style={{ marginTop: 8 }}>
            <Text strong>豆芽判断：</Text>{detail.whyNow.conclusion}
          </Paragraph>
        </Card>

        {/* ② 这个专项要改变什么 */}
        <Card title="② 这个专项要改变什么" className="campaign-block" style={{ marginBottom: 12 }}>
          <Paragraph style={{ marginBottom: 4 }}><Text strong>业务结果：</Text>{detail.outcomes.businessOutcome}</Paragraph>
          <Paragraph style={{ marginBottom: 4 }}><Text strong>声势结果：</Text>{detail.outcomes.momentumOutcome}</Paragraph>
          <Paragraph style={{ marginBottom: 0 }}><Text strong>传播计划：</Text>{detail.outcomes.deliveryPlan}</Paragraph>
        </Card>

        {/* ③ 豆芽准备怎么做 */}
        <Card title="③ 豆芽准备怎么做" className="campaign-block" style={{ marginBottom: 12 }}>
          {detail.stages.map((s, i) => (
            <div key={s.key || i} style={{ marginBottom: 8 }}>
              <Text strong>{s.name}</Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>{s.startDate} – {s.endDate}</Text>
              <div style={{ marginLeft: 16 }}>
                {(s.milestones || []).map((m, j) => (
                  <Paragraph key={j} type="secondary" style={{ marginBottom: 2 }}>· {m}</Paragraph>
                ))}
              </div>
            </div>
          ))}
        </Card>

        {/* ④ 豆芽正在推进 */}
        <Card title="④ 豆芽正在推进" className="campaign-block" style={{ marginBottom: 12 }}>
          {(detail.actions || []).map((a) => (
            <div key={a.id} style={{ marginBottom: 8 }}>
              <Space size={6}>
                <Tag color={a.owner === 'boss' ? 'red' : 'green'}>{a.owner === 'boss' ? '需要你决定' : '豆芽'}</Tag>
                <Text>{a.title}</Text>
              </Space>
              {a.why ? <Paragraph type="secondary" style={{ margin: '2px 0 0 0', fontSize: 12 }}>为什么：{a.why}</Paragraph> : null}
            </div>
          ))}
          {(detail.decisions || []).map((d) => (
            <div key={d.id} style={{ marginBottom: 8 }}>
              <Space size={6}>
                <Tag color="red">需要你决定</Tag>
                <Text>{d.title}</Text>
                {d.status === 'pending' ? (
                  <Button size="small" onClick={() => handleResolveDecision(detail, d)}>确认</Button>
                ) : (
                  <Tag color="green">已确认</Tag>
                )}
              </Space>
            </div>
          ))}
          {fwdLabel ? <Button style={{ marginTop: 8 }} onClick={() => handleStatusForward(detail)}>{fwdLabel}</Button> : null}
        </Card>

        {/* ⑤ 专项结果 */}
        <Card title="⑤ 专项结果" className="campaign-block" style={{ marginBottom: 12 }}>
          <Paragraph style={{ marginBottom: 4 }}>
            <Text strong>执行进度：</Text>{detail.results.executionDone} / {detail.results.executionTotal} 项已完成
          </Paragraph>
          {/* 2026-10-14 打包前清扫：字段为空就整段不渲染，不印「暂无数据」 */}
          {detail.results.businessOutcome ? (
            <Paragraph style={{ marginBottom: 4 }}>
              <Text strong>业务结果：</Text>{detail.results.businessOutcome}
            </Paragraph>
          ) : null}
          {detail.results.momentumOutcome ? (
            <Paragraph style={{ marginBottom: 0 }}>
              <Text strong>声势结果：</Text>{detail.results.momentumOutcome}
            </Paragraph>
          ) : null}
        </Card>

        {detail.review ? (
          <Card title="复盘沉淀" className="campaign-block">
            <Text strong>学到什么：</Text>
            {(detail.review.learned || []).map((l, i) => <Paragraph key={i} type="secondary" style={{ marginBottom: 2 }}>· {l}</Paragraph>)}
            <Text strong>进入企业大脑：</Text>
            {(detail.review.intoBrain || []).map((b, i) => <Paragraph key={i} type="secondary" style={{ marginBottom: 0 }}>· {b}</Paragraph>)}
          </Card>
        ) : null}
      </div>
    );
  }

  // ================= 专项驾驶舱（list） =================
  // pending / inFlight / reviewed / ranked / healthGroups / handleCount / watchCount
  // 已在**第一个早退之前**无条件算好（见文件上方那段）。此处不要再重算 ——
  // 一旦把 hook 写回早退之后，#300（Rendered fewer hooks than expected）会立刻复发。

  return (
    <div className="module-page">
      <div className="module-page-head">
        <h2 className="module-page-title">营销专项</h2>
</div>

      <div className="xm-actions" style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={() => { setView('generator'); setDraftId(null); setIntentText(''); }}>＋ 新建专项</Button>
      </div>

      {!companyId ? (
        <Empty description="请先在左上角选择一个企业，再查看 / 新建专项" />
      ) : campaigns.length === 0 ? (
        <Empty description="还没有专项" style={{ marginTop: 40 }}>
          <Button type="primary" onClick={() => setView('generator')}>新建第一个专项</Button>
        </Empty>
      ) : (
        <>
          {/* 顶部经营判断：N 场进行中，其中 X 需处理、Y 需关注 */}
          <Card className="campaign-dashboard-summary" style={{ marginBottom: 16 }}>
            <Paragraph style={{ marginBottom: 0 }}>
              <Text strong>{inFlight.length} 场进行中</Text>
              {handleCount > 0 ? <Text>，其中 <Text strong style={{ color: 'var(--c-danger)' }}>{handleCount} 场需要你今天处理</Text></Text> : null}
              {watchCount > 0 ? <Text>，<Text strong style={{ color: 'var(--c-warn)' }}>{watchCount} 场需要关注</Text></Text> : null}
              {pending.length > 0 ? <Text>，另有 <Text strong>{pending.length} 场待你确认</Text></Text> : null}
              。
            </Paragraph>
          </Card>

          {/* 待你确认（planning 态，老板还没确认） */}
          {pending.length > 0 ? (
            <>
              <Title level={5} style={{ marginBottom: 8 }}>待你确认</Title>
              <div className="activity-grid">
                {pending.map((c) => (
                  <Card
                    key={c.id}
                    title={<Space size={6} wrap><Text strong>{c.name}</Text>{c.type ? <Tag color="blue">{CAMPAIGN_TYPES[c.type]}</Tag> : null}</Space>}
                    extra={<Tag color={STATUS_COLOR[c.status]}>{CAMPAIGN_STATUS[c.status]}</Tag>}
                  >
                    <Paragraph type="secondary" style={{ marginBottom: 8 }}>{c.whyNow.conclusion}</Paragraph>
                    <Space wrap size={[6, 6]}>
                      <Button size="small" type="primary" onClick={() => { setDraftId(c.id); setView('draft'); }}>查看并确认</Button>
                      <Button size="small" onClick={() => startEdit(c)}>编辑</Button>
                      <Button size="small" danger onClick={() => { deleteCampaign(c.id); message.success('已删除专项'); }}>删除</Button>
                    </Space>
                  </Card>
                ))}
              </div>
            </>
          ) : null}

          {/* 三档：需处理 → 需关注 → 正常推进 */}
          {(['handle', 'watch', 'normal']).map((h) => {
            const list = healthGroups[h];
            if (list.length === 0) return null;
            return (
              <React.Fragment key={h}>
                <Title level={5} style={{ margin: '20px 0 8px' }}>
                  {HEALTH_LEVEL[h]}
                  <Tag color={HEALTH_COLOR[h]} style={{ marginLeft: 8 }}>{list.length}</Tag>
                </Title>
                <div className="activity-grid">
                  {list.map(({ campaign: c, ranked: r }) => (
                    <Card
                      key={c.id}
                      id={'campaign-' + c.id}
                      className={c.id === highlightId ? 'activity-card activity-card-highlight' : 'activity-card'}
                      title={
                        <Space size={6} wrap>
                          <Text strong>{c.name}</Text>
                          {c.type ? <Tag color="blue">{CAMPAIGN_TYPES[c.type]}</Tag> : null}
                        </Space>
                      }
                      extra={<Tag color={STATUS_COLOR[c.status]}>{CAMPAIGN_STATUS[c.status]}</Tag>}
                    >
                      <Paragraph style={{ marginBottom: 8 }}>
                        <Text strong>豆芽判断：</Text>
                        <Text type="secondary">{r.explain.text}</Text>
                      </Paragraph>

                      {/* 需要你决定（事实） */}
                      {(r.pendingDecisions && r.pendingDecisions.length > 0) ? (
                        <div style={{ marginBottom: 8 }}>
                          {r.pendingDecisions.map((pd) => (
                            <div key={pd.key} style={{ marginBottom: 4 }}>
                              <Space size={6}>
                                <Tag color="red">需要你决定</Tag>
                                <Text>{pd.label}</Text>
                                <Button size="small" onClick={() => { setDetailId(c.id); setView('detail'); }}>确认 →</Button>
                              </Space>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {/* 豆芽正在推进（豆芽=判断/规划 + 动手执行） */}
                      {(c.actions || []).filter((a) => a.owner === 'douya' && a.status !== 'done').length > 0 ? (
                        <div style={{ marginBottom: 8 }}>
                          <Text type="secondary">豆芽正在推进：</Text>
                          {(c.actions || []).filter((a) => a.owner === 'douya' && a.status !== 'done').slice(0, 2).map((a) => (
                            <Paragraph key={a.id} type="secondary" style={{ margin: '2px 0 0 16px', fontSize: 12 }}>· {a.title}</Paragraph>
                          ))}
                        </div>
                      ) : null}

                      <Space wrap size={[6, 6]}>
                        <Button size="small" type="primary" onClick={() => { setDetailId(c.id); setView('detail'); }}>查看详情</Button>
                        {c.status === 'preparing' || c.status === 'ongoing' ? (
                          <Button size="small" onClick={() => handleStatusForward(c)}>{c.status === 'preparing' ? '开始进行' : '结束专项'}</Button>
                        ) : null}
                      </Space>
                    </Card>
                  ))}
                </div>
              </React.Fragment>
            );
          })}

          {/* 已复盘专项 */}
          {reviewed.length > 0 ? (
            <>
              <Title level={5} style={{ margin: '24px 0 8px' }}>已复盘专项</Title>
              <div className="activity-grid">
                {reviewed.map((c) => (
                  <Card
                    key={c.id}
                    title={<Space size={6} wrap><Text strong>{c.name}</Text>{c.type ? <Tag color="blue">{CAMPAIGN_TYPES[c.type]}</Tag> : null}</Space>}
                    extra={<Tag color={STATUS_COLOR[c.status]}>{CAMPAIGN_STATUS[c.status]}</Tag>}
                  >
                    <Paragraph type="secondary" style={{ marginBottom: 6 }}>
                      {(c.review && c.review.learned && c.review.learned[0]) ? `学到：${c.review.learned[0]}` : '暂无复盘结论'}
                    </Paragraph>
                    <Button size="small" onClick={() => { setDetailId(c.id); setView('detail'); }}>查看复盘</Button>
                  </Card>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
