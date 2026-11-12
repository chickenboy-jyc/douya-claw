import React, { useState } from 'react';
import { Button, Input } from 'antd';
import { findCompanyEntities } from '../services/companyProfile.js';
import { getCachedWebSearchHealth } from '../services/webSearchHealth.js';
import '../styles/company-entity.css';

/**
 * CompanyEntityPicker —— 「🔍 AI 识别 → 确认是哪一家企业 → 才建档」的主体确认器。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么**另起一个组件**，而不是给 WebCandidatePicker 加一个 kind
 * ────────────────────────────────────────────────────────────────────────────
 * WebCandidatePicker 长的是「名单类字段」的骨架：多选 checkbox + 名称 + 一句 note，
 * `onConfirm(names)` 交回一个**字符串数组**。而「同名企业主体」需要的语义有三条是它装不下的：
 *   1. **单选**（老板原话「要确定到底是哪个苗苗」）—— 多选确认在这里是错误语义，
 *      一旦允许多选，用户会一次勾两家，建档结果又是混的（回到原来的 bug）；
 *   2. **结构化区分信息**：全称 / 地区 / 行业 / 一句话简介 / 来源链接，缺一条用户就分不清；
 *      `{name, note}` 只有一个自由文本位，塞不下五个字段；
 *   3. **确认后可回退**（改选）＋ **未确证时显式降级为手填全称+地区** —— 这两条都是
 *      候选选择器之外的状态机，塞进通用组件会把 BrandIpManager / Onboarding 的现有用法一起搅动。
 *
 * 所以：**复用它的交互骨架与合规原则**（只取候选、绝不自己写库、候选不默认勾选、
 * 失败不静默成空、未确证不谎称联网），但**不复用它的 props 契约**。
 * WebCandidatePicker / webCandidates.js 一个字都没改 ⇒ 两个既有调用方零风险。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 职责边界（硬约束，与 WebCandidatePicker 同一条红线）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 本组件**不写任何库**，也不改企业名；只把用户「确认的候选」交回调用方（onConfirm）；
 *   · 候选**不默认选中**（默认选中＝绕过「必须用户主动表态」的合规要求）；
 *   · 三态诚实：idle / searching / done / failed，失败就报错并自动摆出降级手填口，
 *     **绝不让用户因为 AI 挂了而无法建档**（老板要能建档）。
 *
 * @param {object} props
 * @param {string} props.companyName 用户输入的企业名（检索主体，如「苗苗」）
 * @param {string} [props.industry]  行业（辅助检索）
 * @param {string} [props.confirmedName] 已确认的企业全称（用于回显）
 * @param {'pending'|'confirmed'|'manual'} props.state 确认状态（受控，由调用方持有）
 * @param {(cand:object)=>void} props.onConfirm 用户单选后点「就是这家」→ 交回所选候选
 * @param {(manual:{name:string, region:string})=>void} props.onManualConfirm 降级手填确认
 * @param {()=>void} props.onReset 「改选」→ 回到未确认态
 * @param {boolean} [props.disabled] 禁用（如未选企业）
 * @returns {JSX.Element}
 */

/** 联网探针（同步读缓存，不主动发请求）：未确证联网时所有文案一律降级为如实措辞。 */
function healthNote() {
  const h = getCachedWebSearchHealth();
  if (h && h.available === true) return '将联网检索同名 / 近似企业主体，候选需你确认后才建档。';
  return '将检索同名 / 近似企业主体（本机联网状态未确证），候选需你确认后才建档。';
}

export default function CompanyEntityPicker({
  companyName = '',
  industry = '',
  confirmedName = '',
  state = 'pending',
  onConfirm,
  onManualConfirm,
  onReset,
  disabled = false,
}) {
  const [searchState, setSearchState] = useState('idle'); // idle | searching | done | failed
  const [cands, setCands] = useState([]);
  const [picked, setPicked] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ name: '', region: '' });
  const [manualErr, setManualErr] = useState('');

  const searching = searchState === 'searching';
  const needConfirm = state !== 'confirmed' && state !== 'manual';

  /** 检索候选：只 setState，不写库、不改企业名。 */
  async function runSearch() {
    if (searching) return;
    if (!String(companyName || '').trim()) {
      setErr('请先填写公司名称，豆芽才能去检索同名企业。');
      setSearchState('failed');
      return;
    }
    setSearchState('searching');
    setErr('');
    setNote('');
    setCands([]);
    setPicked(''); // 候选绝不默认选中

    let res = null;
    try {
      res = await findCompanyEntities({ companyName, industry });
    } catch (e) {
      res = { ok: false, error: '检索异常：' + ((e && e.message) || String(e)), candidates: [] };
    }

    if (!res || res.ok !== true) {
      setSearchState('failed');
      setErr((res && res.error) || '在线检索暂不可用');
      setManualOpen(true); // 失败即摆出降级口，不让人卡死
      return;
    }
    setCands(res.candidates || []);
    setPicked('');
    setNote(res.note || '');
    setSourceNote(res.source || '');
    setSearchState('done');
    if (!(res.candidates || []).length) {
      setManualOpen(true);
      setErr('没检索到明确的企业主体，可直接手动填写全称。');
    }
  }

  /** 单选：同一个 name 再点一次不取消（单选语义，必须给一个明确选择）。 */
  function pick(name) {
    setPicked(name);
    setErr('');
  }

  /** 确认「就是这家」→ 交给调用方。 */
  function confirm() {
    const cand = cands.find((c) => c.name === picked);
    if (!cand) {
      setErr('请先选中一家企业（单选）。');
      return;
    }
    if (typeof onConfirm === 'function') onConfirm(cand);
    setErr('');
  }

  /** 降级手填确认。 */
  function submitManual() {
    const name = String(manual.name || '').trim();
    if (name.length < 2) {
      setManualErr('请填写企业全称（至少 2 个字）。');
      return;
    }
    setManualErr('');
    if (typeof onManualConfirm === 'function') onManualConfirm({ name, region: String(manual.region || '').trim() });
  }

  return (
    <div className="cep-wrap" data-cep="1" data-cep-state={state}>
      <div className="cep-actions">
        <Button
          size="small"
          className="cep-search-btn"
          data-cep-search="1"
          loading={searching}
          disabled={disabled || searching || !String(companyName || '').trim()}
          onClick={runSearch}
        >
          🔍 AI 识别（先确认是哪一家）
        </Button>
        <span className="cep-hint" data-cep-hint="1">{healthNote()}</span>
      </div>

      {/* 已确认 / 已手填：显式回显 + 可回退（改选） */}
      {!needConfirm && (
        <div className="cep-confirmed" data-cep-confirmed="1">
          <span>
            已确认企业主体：<b>{confirmedName || (manual.name || '').trim() || '(未命名)'}</b>
            {state === 'manual' ? '（手动填写 · 未联网确证）' : '（联网检索候选 · 用户已确认）'}
          </span>
          <button type="button" className="cep-reselect" data-cep-reselect="1" onClick={() => {
            setSearchState('idle');
            setCands([]);
            setPicked('');
            setErr('');
            setNote('');
            if (typeof onReset === 'function') onReset();
          }}>
            改选
          </button>
        </div>
      )}

      {searching && <div className="cep-note" data-cep-searching="1">⏳ 正在检索同名 / 近似企业主体…</div>}

      {/* 候选项：单选 + 五项区分信息 */}
      {searchState === 'done' && cands.length > 0 && (
        <div className="cep-cands" data-cep-cands="1">
          <div className="cep-cand-head">
            检索到 {cands.length} 家企业主体，请选中你要建档的那一家
            {sourceNote ? <span className="cep-src-badge" data-cep-source="1">{sourceNote}</span> : null}
          </div>
          {cands.map((c) => (
            <label
              className={'cep-cand' + (picked === c.name ? ' active' : '')}
              key={c.name}
              data-cep-cand="1"
              data-cep-cand-name={c.name}
              data-cep-cand-verified={c.verified ? '1' : '0'}
            >
              <input
                type="radio"
                name="cep-entity"
                checked={picked === c.name}
                onChange={() => pick(c.name)}
              />
              <span className="cep-body">
                <span className="cep-name" data-cep-cand-fullname="1">{c.name}</span>
                <span className="cep-meta">
                  <span>{c.region || '地区未确证'}</span>
                  <span>{c.industry || '行业未确证'}</span>
                </span>
                <span className="cep-brief">{c.brief || '暂无简介（资料未覆盖）'}</span>
                {c.verified ? (
                  <span className="cep-src" data-cep-cand-src="1">
                    来源：
                    <a
                      href={c.sourceUrl}
                      onClick={(e) => {
                        e.preventDefault();
                        if (window.api && typeof window.api.openExternal === 'function') {
                          window.api.openExternal(c.sourceUrl);
                        }
                      }}
                    >
                      {c.sourceNote.replace(/^来源：/, '')}
                    </a>
                  </span>
                ) : (
                  <span className="cep-src cep-src-warn" data-cep-cand-unverified="1">来源未确证（无网页出处，请自行核对全称）</span>
                )}
              </span>
            </label>
          ))}
          {note ? <div className="cep-note" data-cep-note="1">{note}</div> : null}
          <div className="cep-actions" style={{ marginTop: 8 }}>
            <Button
              size="small"
              type="primary"
              data-cep-confirm="1"
              disabled={!picked}
              onClick={confirm}
            >
              就是这家，开始建档
            </Button>
            <Button size="small" data-cep-manual-toggle="1" onClick={() => setManualOpen((v) => !v)}>
              {manualOpen ? '收起手动填写' : '都不是？手动填全称'}
            </Button>
          </div>
        </div>
      )}

      {err ? <div className="cep-err" data-cep-error="1">⚠️ {err}</div> : null}

      {/* 降级路径：AI / 联网不可用（或检索不到）时手填全称 + 地区，**照样能建档** */}
      {manualOpen && needConfirm && (
        <div className="cep-manual" data-cep-manual="1">
          <div className="cep-manual-title">
            手动填写企业主体（AI / 联网不可用时也能建档）
          </div>
          <div className="cep-manual-note" data-cep-manual-unverified="1">
            未联网确证：这里填的信息不会标成「联网检索结果」，建档后会如实标注为「手动填写 · 未确证」。
          </div>
          <div className="cep-manual-row">
            <Input
              size="small"
              value={manual.name}
              data-cep-manual-name="1"
              placeholder="企业工商全称，如：苗苗（杭州）口腔医疗集团有限公司"
              onChange={(e) => setManual((p) => ({ ...p, name: e.target.value }))}
            />
            <Input
              size="small"
              value={manual.region}
              data-cep-manual-region="1"
              placeholder="所在地区，如：杭州"
              onChange={(e) => setManual((p) => ({ ...p, region: e.target.value }))}
            />
            <Button size="small" type="primary" data-cep-manual-submit="1" onClick={submitManual}>
              用这家建档
            </Button>
          </div>
          {manualErr ? <div className="cep-err" data-cep-manual-error="1">⚠️ {manualErr}</div> : null}
        </div>
      )}

      {needConfirm && !manualOpen && (
        <div className="cep-note" data-cep-gate="1">
          未确认企业主体前不会建档：先点「🔍 AI 识别」并选中一家，或改成手动填写。
        </div>
      )}
    </div>
  );
}
