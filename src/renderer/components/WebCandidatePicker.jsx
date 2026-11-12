import React, { useState } from 'react';
import { Button } from 'antd';
import { fetchWebCandidates } from '../services/webCandidates.js';
import { getCachedWebSearchHealth } from '../services/webSearchHealth.js';
import {
  candidateSourceLabel,
  candidatePickerNote,
  candidateListHeading,
  candidateHintText,
  searchingCandidateText,
  candidateFetchFailText,
  webFindButtonText,
} from '../services/webSearchHonesty.js';
import '../styles/ia-asset.css';

/**
 * WebCandidatePicker —— 通用「联网找候选」选择器。
 *
 * 把首登「品牌归属」跑通的那套「联网找候选 → 勾选 → 确认落库」抽象成一个可复用组件，
 * 供「你的企业资产库」里所有**外部可检索名单字段**使用（竞品 / 医生专家 / 成功案例 /
 * 核心卖点 / 客户痛点 / 目标客户），也供子品牌矩阵复用（kind='brand'）。
 *
 * 职责边界（硬约束）：
 *   · 只负责「联网取候选」与「候选勾选」的**界面状态**，绝不自己写库；
 *   · 只有用户点「确认添加选中」时才回调 onConfirm(names)，由调用方决定怎么落库；
 *   · 候选**不默认全选**（默认全选会绕开「必须用户主动确认」的合规要求），批量只能靠「全选」按钮；
 *   · 三态诚实：idle / searching / done / failed，失败就报错，不静默成空。
 *
 * 用法：
 *   <WebCandidatePicker
 *     label="竞品"
 *     kind="competitor"
 *     companyName="杭州康健苗苗医疗器械有限公司"
 *     industry="口腔医疗"
 *     existing={asset.competitors}
 *     onConfirm={(names) => { ... }}   // names: string[]
 *   />
 *
 * @param {object} props
 * @param {string} [props.label]        字段中文名（用于文案），如「竞品」
 * @param {string} [props.buttonText]   检索按钮文案，默认跟随联网探针（确证联网 → `🔍 联网找候选${label}`；否则 `🔍 找候选${label}（未确证联网）`）
 * @param {string} props.kind          候选类型，见 services/webCandidates.js 的 WEB_CANDIDATE_KINDS
 * @param {string} [props.companyName] 检索主体企业名
 * @param {string} [props.industry]    行业（辅助检索）
 * @param {Array<string>} [props.existing] 已登记内容（会被过滤 / 去重）
 * @param {string} [props.extraHint]   额外检索提示
 * @param {string} [props.sourceNote]  候选来源角标文案
 * @param {(names:string[])=>void} props.onConfirm 用户确认后回调，接收勾选的名称数组
 * @param {boolean} [props.disabled]   禁用（如企业未建档）
 * @returns {JSX.Element}
 */
export default function WebCandidatePicker({
  label = '',
  buttonText = '',
  kind = 'competitor',
  companyName = '',
  industry = '',
  existing = [],
  extraHint = '',
  sourceNote = '',
  onConfirm,
  disabled = false,
}) {
  // 联网探针（同步读缓存，不主动发请求）：未确证联网时，所有「联网」相关文案一律降级为如实措辞。
  const health = getCachedWebSearchHealth();
  const srcNote = sourceNote || candidatePickerNote(health);
  const [state, setState] = useState('idle'); // idle | searching | done | failed
  const [cands, setCands] = useState([]);     // [{ name, note }]
  const [picked, setPicked] = useState(() => new Set());
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const searching = state === 'searching';
  const searchText = buttonText || webFindButtonText(health, label);

  /** 联网检索候选；只 setState，不写库。 */
  async function runSearch() {
    if (searching) return;
    setState('searching');
    setErr('');
    setMsg('');
    setCands([]);
    setPicked(new Set());

    const res = await fetchWebCandidates({ kind, companyName, industry, existing, extraHint });

    if (!res || res.ok !== true) {
      setState('failed');
      setErr((res && res.error) || candidateFetchFailText(health));
      return;
    }
    setCands(res.candidates || []);
    setPicked(new Set()); // 候选绝不默认全选
    setState('done');
    setErr(res.candidates && res.candidates.length ? '' : (res.error || '没检索到明确的候选，可手动添加。'));
  }

  /** 勾选 / 取消勾选一个候选。 */
  function toggle(name) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** 一键全选 / 清空（批量只能走这里，不默认全选）。 */
  function toggleAll() {
    setPicked((prev) => (prev.size === cands.length ? new Set() : new Set(cands.map((c) => c.name))));
  }

  /** 用户点「确认添加选中」→ 把勾选结果交给调用方落库，然后移出候选区。 */
  function confirm() {
    const names = cands.filter((c) => picked.has(c.name)).map((c) => c.name);
    if (!names.length) {
      setErr('请先勾选要添加的候选。');
      return;
    }
    if (typeof onConfirm === 'function') onConfirm(names);
    setCands((prev) => prev.filter((c) => !picked.has(c.name)));
    setPicked(new Set());
    setErr('');
    setMsg(`已确认添加 ${names.length} 条${label ? `到「${label}」` : ''}（来源：${candidateSourceLabel(health)} · 已确认）。`);
  }

  return (
    <div className="wcp-wrap">
      <div className="wcp-actions">
        <Button
          size="small"
          className="wcp-search-btn"
          loading={searching}
          disabled={disabled || searching}
          onClick={runSearch}
        >
          {searchText}
        </Button>
        <span className="wcp-hint">{candidateHintText(health)}</span>
      </div>

      {searching && <div className="wcp-note">{searchingCandidateText(health)}</div>}

      {state === 'failed' && <div className="wcp-err">⚠️ {err || candidateFetchFailText(health)}</div>}

      {state === 'done' && cands.length > 0 && (
        <div className="wcp-cands">
          <div className="wcp-cand-head">
            {candidateListHeading(health)}
            {label ? `（${label}）` : ''}
            <span className="wcp-cand-src">{srcNote}</span>
            <button type="button" className="wcp-cand-all" onClick={toggleAll}>
              {picked.size === cands.length ? '清空' : '全选'}
            </button>
          </div>
          {cands.map((c) => (
            <label className="wcp-cand" key={c.name}>
              <input type="checkbox" checked={picked.has(c.name)} onChange={() => toggle(c.name)} />
              <span className="wcp-cand-name">{c.name}</span>
              {c.note ? <span className="wcp-cand-note">{c.note}</span> : null}
            </label>
          ))}
          <div className="wcp-actions" style={{ marginTop: 6 }}>
            <Button size="small" type="primary" disabled={picked.size === 0} onClick={confirm}>
              确认添加选中（{picked.size}）
            </Button>
          </div>
        </div>
      )}

      {state === 'done' && cands.length === 0 && (
        <div className="wcp-note">{err || '没检索到明确的候选，可手动添加。'}</div>
      )}

      {msg && <div className="wcp-msg">{msg}</div>}
    </div>
  );
}
