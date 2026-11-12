import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, App as AntApp, Button, Checkbox, Empty, Input, Modal, Popconfirm,
  Select, Space, Switch, Tag, Tooltip, List,
} from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import '../styles/ia-asset.css';

/**
 * 定时任务（第三层能力）：让豆芽在指定时间无人值守地自己干活。
 *
 * 落点：作为「今天做什么」页里的一个 Tab（见 components/TodayOps.jsx，data-tab="automation"），
 * 不新增左侧导航卡（产品锁：导航 4 组 8 项）。
 *
 * 数据归主进程所有（userData/automations.json），本组件只经 IPC（window.api.automation*）读写：
 *   列表 / 新建 / 启停 / 删除 / 立即跑一次 / 执行台账。
 *
 * ★ 快照：主进程拿不到企业数据（企业信息在渲染层 localStorage），故新建任务时把当前企业信息一并写入
 *   任务的 context，保证「9 点没窗口时」豆芽仍知道巡哪家竞品。
 * ★ 诚实：需要用户确认的写操作（ssh-exec / deploy-static / deploy-node / db-query）在无人值守下
 *   会被后端跳过并如实标记 —— 新建时明确提醒用户「定时任务适合只读/检索类」。
 */

const FREQ_OPTIONS = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

const WEEKDAYS = [
  { value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' },
  { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({ value: i, label: String(i).padStart(2, '0') }));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({ value: i, label: String(i).padStart(2, '0') }));
const MONTHDAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1} 日` }));

/** 需要用户确认的写操作技能 —— 定时任务不适合调度（无人值守会被跳过）。 */
const CONFIRM_TOOLS = ['ssh-exec', 'deploy-static', 'deploy-node', 'db-query'];

const STATUS_META = {
  running: { color: 'processing', label: '执行中' },
  ran: { color: 'success', label: '已跑' },
  skipped: { color: 'warning', label: '已跳过' },
  missed: { color: 'default', label: '漏跑' },
  failed: { color: 'error', label: '失败' },
};

const REASON_LABEL = {
  app_not_running: '到点时应用没在运行（漏跑）',
  resident_disabled: '你关闭了「后台常驻」',
  user_quit: '上次退出应用时正跑到一半',
  concurrency_lock: '上一个定时任务还在跑',
  clock_rollback: '系统时钟往回跳了',
};

/** 把 schedule 结构体渲染成人类可读文案。 */
function scheduleLabel(s) {
  if (!s) return '（未设置）';
  const hh = String(s.hour).padStart(2, '0');
  const mm = String(s.minute).padStart(2, '0');
  const time = `${hh}:${mm}`;
  if (s.freq === 'weekly') {
    const days = (s.byDay && s.byDay.length ? s.byDay : [1])
      .map((d) => (WEEKDAYS.find((w) => w.value === d) || {}).label || d)
      .join('、');
    return `每周 ${days} ${time}`;
  }
  if (s.freq === 'monthly') return `每月 ${s.byMonthDay || 1} 日 ${time}`;
  return `每天 ${time}`;
}

function fmtTs(ts) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  try {
    return new Date(n).toLocaleString();
  } catch {
    return '—';
  }
}

function fmtDur(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '—';
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n / 60000)}min`;
}

export default function Automations() {
  const { message } = AntApp.useApp();
  const { currentCompany, account } = useCompany();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsFor, setRunsFor] = useState(''); // '' = 全部
  const [busyId, setBusyId] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null); // null=新建；否则为正在编辑的 item
  const [form, setForm] = useState(() => defaultForm());

  const api = typeof window !== 'undefined' ? window.api : null;
  const ipcReady = !!(api && typeof api.automationList === 'function');

  function defaultForm() {
    return {
      name: '',
      prompt: '',
      freq: 'daily',
      hour: 9,
      minute: 0,
      byDay: [1, 2, 3, 4, 5],
      byMonthDay: 1,
      enabled: true,
    };
  }

  /** 从当前企业/账号快照出 context（主进程拿不到企业数据，必须前端写死进任务）。 */
  const snapshotContext = useCallback(() => ({
    username: (account && (account.username || account.name)) || '',
    companyId: (currentCompany && currentCompany.id) || '',
    companyName: (currentCompany && currentCompany.name) || '',
    brand: (currentCompany && currentCompany.name) || '',
  }), [account, currentCompany]);

  const refresh = useCallback(async () => {
    if (!ipcReady) return;
    setLoading(true);
    try {
      const list = await api.automationList();
      setItems(Array.isArray(list) ? list : []);
    } catch (e) {
      message.error('读取定时任务失败：' + ((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  }, [api, ipcReady, message]);

  const refreshRuns = useCallback(async (automationId) => {
    if (!ipcReady) return;
    setRunsLoading(true);
    try {
      const list = await api.automationRuns(automationId ? { automationId, limit: 100 } : { limit: 100 });
      setRuns(Array.isArray(list) ? list : []);
    } catch (e) {
      message.error('读取执行台账失败：' + ((e && e.message) || e));
    } finally {
      setRunsLoading(false);
    }
  }, [api, ipcReady, message]);

  useEffect(() => { refresh(); refreshRuns(''); }, [refresh, refreshRuns]);

  function openCreate() {
    setEditing(null);
    setForm(defaultForm());
    setEditorOpen(true);
  }

  function openEdit(item) {
    setEditing(item);
    setForm({
      name: item.name || '',
      prompt: item.prompt || '',
      freq: (item.schedule && item.schedule.freq) || 'daily',
      hour: (item.schedule && item.schedule.hour) != null ? item.schedule.hour : 9,
      minute: (item.schedule && item.schedule.minute) != null ? item.schedule.minute : 0,
      byDay: (item.schedule && item.schedule.byDay && item.schedule.byDay.length) ? item.schedule.byDay : [1, 2, 3, 4, 5],
      byMonthDay: (item.schedule && item.schedule.byMonthDay) || 1,
      enabled: item.enabled !== false,
    });
    setEditorOpen(true);
  }

  async function submit() {
    const name = String(form.name || '').trim();
    const prompt = String(form.prompt || '').trim();
    if (!name) { message.warning('请填写任务名称'); return; }
    if (!prompt) { message.warning('请填写要执行的指令'); return; }
    const schedule = {
      freq: form.freq,
      hour: Number(form.hour),
      minute: Number(form.minute),
      byDay: form.freq === 'weekly' ? (form.byDay && form.byDay.length ? form.byDay : [1]) : [],
      byMonthDay: Number(form.byMonthDay) || 1,
    };
    try {
      if (editing) {
        await api.automationUpdate(editing.id, { name, prompt, schedule, enabled: form.enabled, context: snapshotContext() });
        message.success('已保存修改');
      } else {
        await api.automationCreate({ name, prompt, schedule, enabled: form.enabled, context: snapshotContext(), limits: { maxTurnsPerRun: 12 } });
        message.success('已新建定时任务');
      }
      setEditorOpen(false);
      await refresh();
    } catch (e) {
      message.error('保存失败：' + ((e && e.message) || e));
    }
  }

  async function toggleEnabled(item, next) {
    try {
      await api.automationUpdate(item.id, { enabled: next });
      await refresh();
    } catch (e) {
      message.error('操作失败：' + ((e && e.message) || e));
    }
  }

  async function remove(item) {
    try {
      await api.automationRemove(item.id);
      message.success('已删除');
      await refresh();
      await refreshRuns(runsFor);
    } catch (e) {
      message.error('删除失败：' + ((e && e.message) || e));
    }
  }

  async function runNow(item) {
    setBusyId(item.id);
    try {
      const run = await api.automationRunNow(item.id);
      const st = run && run.status;
      if (st === 'ran') {
        const n = (run.artifacts || []).length;
        if (n > 0) message.success(`跑完了，产出 ${n} 个文件`);
        else message.warning('跑完了，但这次没有产出文件');
      } else if (st === 'skipped') {
        message.warning('已跳过：' + (REASON_LABEL[run.reason] || run.reason || ''));
      } else if (st === 'failed') {
        message.error('执行失败：' + (run.reason || ''));
      } else {
        message.info('已触发');
      }
      await refresh();
      await refreshRuns(runsFor);
    } catch (e) {
      message.error('执行失败：' + ((e && e.message) || e));
    } finally {
      setBusyId('');
    }
  }

  const filteredRuns = useMemo(() => runs, [runs]);

  if (!ipcReady) {
    return (
      <div className="ia-asset-page">
        <Alert type="warning" showIcon message="定时任务不可用" description="当前环境未暴露定时任务接口（window.api.automation*），请在豆芽客户端内使用。" />
      </div>
    );
  }

  return (
    <div className="ia-asset-page" style={{ padding: '4px 2px' }}>
      <div className="ia-asset-head">
        <h1 className="ia-asset-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>定时任务</span>
          <Button type="primary" onClick={openCreate}>+ 新建定时任务</Button>
        </h1>
        <p className="ia-asset-sub">
          让豆芽到点自己干活：每天跑诊断、每周巡检竞品。关窗也照跑，跑完弹通知给你。
        </p>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ margin: '8px 0 12px' }}
        message="定时任务适合「只读 / 检索类」任务"
        description={
          <span>
            巡检、查台账、出报告都可以。需要你确认的写操作（
            {CONFIRM_TOOLS.map((t) => <Tag key={t}>{t}</Tag>)}
            ）在无人值守下会被跳过并如实标记为失败，不会偷偷执行。
          </span>
        }
      />

      <List
        loading={loading}
        dataSource={items}
        locale={{ emptyText: <Empty description="还没有定时任务，点右上角「新建定时任务」开始" /> }}
        renderItem={(item) => (
          <List.Item
            key={item.id}
            actions={[
              <Button key="run" size="small" loading={busyId === item.id} onClick={() => runNow(item)}>立即跑一次</Button>,
              <Button key="edit" size="small" onClick={() => openEdit(item)}>编辑</Button>,
              <Tooltip key="runs" title="只看这个任务的台账">
                <Button size="small" onClick={() => { setRunsFor(item.id); refreshRuns(item.id); }}>台账</Button>
              </Tooltip>,
              <Popconfirm key="del" title="删除这个定时任务？" onConfirm={() => remove(item)} okText="删除" cancelText="取消">
                <Button size="small" danger>删除</Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={
                <Space>
                  <span>{item.name}</span>
                  <Tag color={item.enabled ? 'green' : 'default'}>{item.enabled ? '已启用' : '已停用'}</Tag>
                  <Tag color="blue">{scheduleLabel(item.schedule)}</Tag>
                </Space>
              }
              description={
                <div>
                  <div style={{ color: 'var(--c-text-3)', marginBottom: 2 }}>{String(item.prompt || '').slice(0, 120)}{String(item.prompt || '').length > 120 ? '…' : ''}</div>
                  <Space size="large" wrap>
                    <span>下次运行：{fmtTs(item.nextRunAt)}</span>
                    <span>上次运行：{fmtTs(item.lastRunAt)}</span>
                    {item.context && item.context.companyName ? <span>企业：{item.context.companyName}</span> : null}
                    <Switch
                      size="small"
                      checked={item.enabled !== false}
                      onChange={(v) => toggleEnabled(item, v)}
                      checkedChildren="启用"
                      unCheckedChildren="停用"
                    />
                  </Space>
                </div>
              }
            />
          </List.Item>
        )}
      />

      <div className="ia-asset-head" style={{ marginTop: 18 }}>
        <h2 className="ia-asset-title" style={{ fontSize: 16 }}>执行台账</h2>
        <p className="ia-asset-sub">
          「跑完但没产出文件」会如实记成「已跑（无产出）」，不会说成「已完成」。漏跑 / 跳过 / 失败都带原因。
        </p>
      </div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Select
          size="small"
          style={{ width: 220 }}
          value={runsFor || ''}
          onChange={(v) => { setRunsFor(v); refreshRuns(v); }}
          options={[{ value: '', label: '全部任务' }, ...items.map((it) => ({ value: it.id, label: it.name }))]}
        />
        <Button size="small" onClick={() => refreshRuns(runsFor)} loading={runsLoading}>刷新</Button>
      </Space>

      <List
        size="small"
        loading={runsLoading}
        dataSource={filteredRuns}
        locale={{ emptyText: <Empty description="暂无执行记录" /> }}
        renderItem={(run) => {
          const meta = STATUS_META[run.status] || { color: 'default', label: run.status };
          const noOutput = run.status === 'ran' && (!run.artifacts || run.artifacts.length === 0);
          const itemName = (items.find((x) => x.id === run.automationId) || {}).name || run.automationId;
          return (
            <List.Item key={run.runId}>
              <Space wrap size="small">
                <Tag color={meta.color}>{meta.label}</Tag>
                <span style={{ color: 'var(--c-text-3)' }}>计划 {fmtTs(run.scheduledAt)}</span>
                <span>{itemName}</span>
                {run.catchUpOf ? <Tag color="orange">补跑</Tag> : null}
                {run.status === 'skipped' || run.status === 'missed' || run.status === 'failed' ? (
                  <span style={{ color: 'var(--c-danger)' }}>{REASON_LABEL[run.reason] || run.reason || '—'}</span>
                ) : null}
                {noOutput ? <span style={{ color: 'var(--c-warn)' }}>跑完了但没产出文件</span> : null}
                {run.artifacts && run.artifacts.length > 0 ? <span>产出 {run.artifacts.length} 个</span> : null}
                <span style={{ color: 'var(--c-text-3)' }}>耗时 {fmtDur(run.durationMs)}</span>
              </Space>
            </List.Item>
          );
        }}
      />

      <Modal
        open={editorOpen}
        title={editing ? '编辑定时任务' : '新建定时任务'}
        onCancel={() => setEditorOpen(false)}
        onOk={submit}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
        width={640}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <div style={{ marginBottom: 4 }}>任务名称</div>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="例如：每周一经营诊断"
              maxLength={60}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>触发频率</div>
            <Space wrap>
              <Select
                style={{ width: 120 }}
                value={form.freq}
                onChange={(v) => setForm((f) => ({ ...f, freq: v }))}
                options={FREQ_OPTIONS}
              />
              {form.freq === 'weekly' ? (
                <Checkbox.Group
                  options={WEEKDAYS}
                  value={form.byDay}
                  onChange={(v) => setForm((f) => ({ ...f, byDay: v }))}
                />
              ) : null}
              {form.freq === 'monthly' ? (
                <Select
                  style={{ width: 120 }}
                  value={form.byMonthDay}
                  onChange={(v) => setForm((f) => ({ ...f, byMonthDay: v }))}
                  options={MONTHDAY_OPTIONS}
                />
              ) : null}
              <Select
                style={{ width: 90 }}
                value={form.hour}
                onChange={(v) => setForm((f) => ({ ...f, hour: v }))}
                options={HOUR_OPTIONS}
              />
              <span>:</span>
              <Select
                style={{ width: 90 }}
                value={form.minute}
                onChange={(v) => setForm((f) => ({ ...f, minute: v }))}
                options={MINUTE_OPTIONS}
              />
            </Space>
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>要执行的指令（无人值守时豆芽按此干活）</div>
            <Input.TextArea
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
              rows={5}
              placeholder="例如：请做一次 11 维经营体检，并把诊断要点整理成一份 markdown 报告。"
            />
          </div>
          <div>
            <Space>
              <span>创建后立即启用</span>
              <Switch checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
            </Space>
          </div>
          <Alert
            type="warning"
            showIcon
            message="任务会带上当前企业快照"
            description={`企业：${(currentCompany && currentCompany.name) || '（未选择）'}　账号：${(account && (account.username || account.name)) || '（未登录）'}。定时任务在无窗口时执行，靠这份快照才知道「巡哪家」——切换企业后再建任务即可。`}
          />
        </Space>
      </Modal>
    </div>
  );
}
