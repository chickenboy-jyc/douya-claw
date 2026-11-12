/**
 * CalendarView —— 真正的月历网格（周一开头），把带日期的方案节点铺在日历上直接改。
 *
 * 老板定调：不要「用户粘贴一段带日期的文字」，而要「方案自动铺到日历、用户直接在日历上改」。
 * 本组件只做「展示 + 编辑交互」，自己不管数据来源：
 *   - 数据由父层传入（nodes），增删改通过回调交回父层（onAddNode / onUpdateNode / onDeleteNode）。
 *   - 组件自身不 import store，方便被任意页面接入。
 *
 * 视觉：绿色主题 + Apple/macOS 极简（圆角 / 浅阴影 / 系统字体 / 克制配色），
 *       全部用 inline style，不引入新依赖，也不改动共享 style.css。
 *
 * Props：
 *   nodes        Array<Node>  { id, date:'YYYY-MM-DD', endDate?, title, type, note }
 *   onUpdateNode (id, patch) => void
 *   onDeleteNode (id) => void
 *   onAddNode    (node) => void
 *   month        'YYYY-MM'（受控；缺省用组件内部月份）
 *   onMonthChange(next) => void（可选）
 */

import React, { useMemo, useState } from 'react';
import { Button, Input, Modal, Select } from 'antd';
import { PLAN_NODE_TYPES, classifyNode, classifyPlanType } from '../services/monthlyPlanDirector.js';

/** 周一开头的星期表头。 */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 节点类型下拉项（来自唯一事实源 PLAN_NODE_TYPES）。 */
const TYPE_OPTIONS = Object.keys(PLAN_NODE_TYPES).map((key) => ({
  value: key,
  label: PLAN_NODE_TYPES[key],
}));

/** 紧迫度视觉映射（Apple 系统色：红 / 橙 / 绿 / 灰）。 */
const URGENCY = {
  near: { label: '临近', color: 'var(--c-danger)', bg: 'var(--c-danger-tint)' },
  soon: { label: '即将', color: 'var(--c-warn)', bg: 'var(--c-warn-tint)' },
  far: { label: '计划中', color: 'var(--c-success)', bg: 'var(--c-brand-tint)' },
  past: { label: '已过', color: 'var(--c-text-3)', bg: 'var(--c-surface-hover)' },
};

/** 数字补零到两位。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地 Date → 'YYYY-MM-DD'。 */
function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 今天的 'YYYY-MM-DD'。 */
function todayISO() {
  return toISO(new Date());
}

/** 'YYYY-MM' → { year, monthIndex }（非法输入回退到今天所在月）。 */
function parseMonth(month) {
  if (typeof month === 'string' && /^\d{4}-\d{1,2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    if (m >= 1 && m <= 12) return { year: y, monthIndex: m - 1 };
  }
  const now = new Date();
  return { year: now.getFullYear(), monthIndex: now.getMonth() };
}

/** { year, monthIndex } → 'YYYY-MM'。 */
function monthKey(year, monthIndex) {
  return `${year}-${pad2(monthIndex + 1)}`;
}

/** 生成当月月历网格（6 行 × 7 列 = 42 格）的日期数组，周一开头，含前后补位。 */
function buildCells(year, monthIndex) {
  const firstDay = new Date(year, monthIndex, 1);
  const lead = (firstDay.getDay() + 6) % 7; // 周一=0 ... 周日=6
  const start = new Date(year, monthIndex, 1 - lead);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return cells;
}

/** 生成用户新增节点的唯一 id（用户手加，不要求幂等）。 */
function genNodeId() {
  return `cal-u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 组件内所有样式（inline，自包含，绿色主题）。 */
const S = {
  wrap: {
    background: 'var(--c-surface)',
    border: '1px solid var(--c-border)',
    borderRadius: 16,
    padding: '16px 18px 18px',
    boxShadow: '0 1px 3px var(--c-shadow-color)',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif",
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  title: { fontSize: 18, fontWeight: 700, color: 'var(--c-text)', letterSpacing: 0.2 },
  sub: { fontSize: 12.5, color: 'var(--c-text-2)', marginTop: 4 },
  headRight: { display: 'flex', gap: 6, alignItems: 'center' },
  empty: {
    fontSize: 12.5,
    color: 'var(--c-success)',
    background: 'var(--c-brand-tint)',
    border: '1px solid var(--c-brand-line)',
    borderRadius: 10,
    padding: '8px 12px',
    marginBottom: 12,
    lineHeight: 1.6,
  },
  weekRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: 6,
    marginBottom: 6,
  },
  weekCell: { fontSize: 12, fontWeight: 600, color: 'var(--c-text-3)', textAlign: 'center', padding: '2px 0' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 },
  cell: {
    minHeight: 96,
    borderRadius: 10,
    padding: '6px 6px 8px',
    background: 'var(--c-surface-2)',
    border: '1px solid var(--c-border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  cellOut: { opacity: 0.4, background: 'transparent' },
  cellToday: { border: '1.5px solid var(--c-brand)', background: 'var(--c-brand-tint)' },
  cellHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 16 },
  dayNum: { fontSize: 12, fontWeight: 600, color: 'var(--c-text-2)' },
  dayNumOut: { color: 'var(--c-text-3)' },
  dayNumToday: {
    color: 'var(--c-on-brand)',
    background: 'var(--c-brand)',
    borderRadius: '50%',
    width: 20,
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11.5,
  },
  addBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--c-text-3)',
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
    padding: '0 2px',
  },
  nodeList: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  node: {
    textAlign: 'left',
    width: '100%',
    border: '1px solid var(--c-border)',
    borderRadius: 8,
    padding: '4px 6px',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    font: 'inherit',
  },
  nodeTitle: {
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.35,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },
  nodeMeta: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' },
  typeBadge: {
    fontSize: 10,
    color: 'var(--c-success)',
    background: 'var(--c-brand-tint)',
    borderRadius: 6,
    padding: '1px 6px',
  },
  urgBadge: { fontSize: 10, fontWeight: 600 },
  nodeRange: { fontSize: 10, color: 'var(--c-text-3)' },
  field: { marginBottom: 12 },
  label: { fontSize: 12.5, color: 'var(--c-text-2)', marginBottom: 4, display: 'block' },
  dateInput: {
    width: '100%',
    padding: '7px 10px',
    fontSize: 13,
    border: '1px solid var(--c-border-strong)',
    borderRadius: 10,
    background: 'var(--c-surface)',
    color: 'var(--c-text)',
    colorScheme: 'light',
  },
};

/**
 * 月历视图组件。
 * @param {Object} props 见文件头 Props 说明。
 */
export default function CalendarView({ nodes, onUpdateNode, onDeleteNode, onAddNode, month, onMonthChange }) {
  const list = Array.isArray(nodes) ? nodes.filter((n) => n && n.date) : [];

  const initial = parseMonth(month);
  const [internalMonth, setInternalMonth] = useState(() => monthKey(initial.year, initial.monthIndex));
  const activeMonth = month || internalMonth;
  const { year, monthIndex } = parseMonth(activeMonth);

  // 编辑弹窗状态：{ mode:'edit'|'add', id, date, endDate, title, note, type }
  const [editor, setEditor] = useState(null);

  const today = todayISO();

  // 按日期分组，便于落入格子
  const byDate = useMemo(() => {
    const map = {};
    for (const n of list) {
      if (!map[n.date]) map[n.date] = [];
      map[n.date].push(n);
    }
    return map;
  }, [list]);

  const cells = useMemo(() => buildCells(year, monthIndex), [year, monthIndex]);

  /** 切换月份（受控时通知父层；同时更新内部兜底，兼容非受控）。 */
  function goMonth(next) {
    setInternalMonth(next);
    if (onMonthChange) onMonthChange(next);
  }

  function shiftMonth(delta) {
    const d = new Date(year, monthIndex + delta, 1);
    goMonth(monthKey(d.getFullYear(), d.getMonth()));
  }

  function goToday() {
    const now = new Date();
    goMonth(monthKey(now.getFullYear(), now.getMonth()));
  }

  /** 打开「修改」弹窗。 */
  function openEdit(node) {
    setEditor({
      mode: 'edit',
      id: node.id,
      date: node.date || today,
      endDate: node.endDate || '',
      title: node.title || '',
      note: node.note || '',
      type: node.type || classifyPlanType(node.title),
    });
  }

  /** 打开「加一条」弹窗（预填被点击格子的日期）。 */
  function openAdd(dateISO) {
    setEditor({
      mode: 'add',
      id: null,
      date: dateISO,
      endDate: '',
      title: '',
      note: '',
      type: 'monthly',
    });
  }

  function closeEditor() {
    setEditor(null);
  }

  /** 保存编辑 / 新增。 */
  function saveEditor() {
    if (!editor || !(editor.title || '').trim()) return;
    const payload = {
      date: editor.date || today,
      endDate: editor.endDate || '',
      title: editor.title.trim(),
      note: (editor.note || '').trim(),
      type: editor.type || 'monthly',
    };
    if (editor.mode === 'edit') {
      if (onUpdateNode) onUpdateNode(editor.id, payload);
    } else if (onAddNode) {
      onAddNode({ id: genNodeId(), ...payload });
    }
    closeEditor();
  }

  /** 删除当前编辑中的节点。 */
  function deleteEditor() {
    if (!editor) return;
    if (editor.mode === 'edit' && onDeleteNode) onDeleteNode(editor.id);
    closeEditor();
  }

  /** 渲染单个节点（含类型徽标 + 紧迫度，点击进入编辑）。 */
  function renderNode(n) {
    const urg = classifyNode(n, new Date());
    const uc = URGENCY[urg] || URGENCY.far;
    const typeKey = n.type || classifyPlanType(n.title);
    const typeLabel = PLAN_NODE_TYPES[typeKey] || PLAN_NODE_TYPES.monthly;
    const isPast = urg === 'past';
    return (
      <button
        key={n.id}
        type="button"
        onClick={() => openEdit(n)}
        title={n.note || ''}
        style={{
          ...S.node,
          background: uc.bg,
          borderLeft: `3px solid ${uc.color}`,
          opacity: isPast ? 0.55 : 1,
        }}
      >
        <span style={{ ...S.nodeTitle, color: isPast ? 'var(--c-text-3)' : 'var(--c-text)' }}>
          {n.title || '（未命名节点）'}
        </span>
        <span style={S.nodeMeta}>
          <span style={S.typeBadge}>{typeLabel}</span>
          <span style={{ ...S.urgBadge, color: uc.color }}>{uc.label}</span>
        </span>
        {n.endDate && <span style={S.nodeRange}>至 {n.endDate}</span>}
      </button>
    );
  }

  const isEditing = !!(editor && editor.mode === 'edit');

  return (
    <div style={S.wrap}>
      {/* 头部：月份 + 切换 */}
      <div style={S.head}>
        <div>
          <div style={S.title}>
            {year} 年 {monthIndex + 1} 月
          </div>
          <div style={S.sub}>方案已铺进日历，直接点节点就能改（改期 / 改名 / 删 / 加）</div>
        </div>
        <div style={S.headRight}>
          <Button size="small" onClick={() => shiftMonth(-1)}>
            ‹ 上月
          </Button>
          <Button size="small" onClick={goToday}>
            回到本月
          </Button>
          <Button size="small" onClick={() => shiftMonth(1)}>
            下月 ›
          </Button>
        </div>
      </div>

      {/* 空数据引导（不显示任何假占位节点） */}
      {list.length === 0 && (
        <div style={S.empty}>这个月还没有安排，让豆芽给你一套方案；也可以点任意格子的「＋」自己加一条。</div>
      )}

      {/* 星期表头（周一开头） */}
      <div style={S.weekRow}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={S.weekCell}>
            {w}
          </div>
        ))}
      </div>

      {/* 月历网格 */}
      <div style={S.grid}>
        {cells.map((d, i) => {
          const key = toISO(d);
          const inMonth = d.getMonth() === monthIndex;
          const isToday = key === today;
          const dayNodes = byDate[key] ? byDate[key].slice() : [];
          dayNodes.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
          return (
            <div
              key={`${key}-${i}`}
              style={{ ...S.cell, ...(inMonth ? {} : S.cellOut), ...(isToday ? S.cellToday : {}) }}
            >
              <div style={S.cellHead}>
                <span style={{ ...S.dayNum, ...(inMonth ? {} : S.dayNumOut), ...(isToday ? S.dayNumToday : {}) }}>
                  {d.getDate()}
                </span>
                {inMonth && (
                  <button type="button" style={S.addBtn} title="加一条" onClick={() => openAdd(key)}>
                    ＋
                  </button>
                )}
              </div>
              <div style={S.nodeList}>{dayNodes.map(renderNode)}</div>
            </div>
          );
        })}
      </div>

      {/* 编辑 / 新增弹窗 */}
      <Modal
        open={!!editor}
        title={isEditing ? '修改安排' : '加一条安排'}
        onCancel={closeEditor}
        width={460}
        footer={
          isEditing
            ? [
                <Button key="del" danger onClick={deleteEditor}>
                  删除
                </Button>,
                <Button key="cancel" onClick={closeEditor}>
                  取消
                </Button>,
                <Button key="ok" type="primary" onClick={saveEditor} disabled={!(editor && (editor.title || '').trim())}>
                  保存
                </Button>,
              ]
            : undefined
        }
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !(editor && (editor.title || '').trim()) }}
        onOk={saveEditor}
      >
        {editor && (
          <div>
            <div style={S.field}>
              <span style={S.label}>日期</span>
              <input
                type="date"
                style={S.dateInput}
                value={editor.date || ''}
                onChange={(e) => setEditor({ ...editor, date: e.target.value })}
              />
            </div>
            <div style={S.field}>
              <span style={S.label}>结束日期（可选，用于跨天活动）</span>
              <input
                type="date"
                style={S.dateInput}
                value={editor.endDate || ''}
                onChange={(e) => setEditor({ ...editor, endDate: e.target.value })}
              />
            </div>
            <div style={S.field}>
              <span style={S.label}>标题</span>
              <Input
                value={editor.title}
                placeholder="例如：上海口腔展 展台活动"
                onChange={(e) => setEditor({ ...editor, title: e.target.value })}
              />
            </div>
            <div style={S.field}>
              <span style={S.label}>类型</span>
              <Select
                style={{ width: '100%' }}
                value={editor.type || 'monthly'}
                options={TYPE_OPTIONS}
                onChange={(v) => setEditor({ ...editor, type: v })}
              />
            </div>
            <div style={S.field}>
              <span style={S.label}>说明</span>
              <Input.TextArea
                value={editor.note}
                rows={3}
                placeholder="这条为什么安排在这个时间点"
                onChange={(e) => setEditor({ ...editor, note: e.target.value })}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
