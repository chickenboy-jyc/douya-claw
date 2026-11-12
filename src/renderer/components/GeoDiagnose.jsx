import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Segmented, Tag } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import {
  diagnoseExposure,
  inferCompanyType,
  COMPANY_TYPE_LABEL,
} from '../services/geoExposure.js';

/**
 * GeoDiagnose —— GEO 曝光度「真诊断」视图。
 *
 * 2026-09-12 信息架构重排（包 B，老板第 7 条）归并处置：
 *   GEO 诊断展示**只保留在「经营诊断」**。本组件不再作为独立导航板块的展示出口，
 *   而是归并为经营诊断「GEO」维度卡片的**内嵌明细**（`<GeoDiagnose embedded initialResult={...} />`）。
 *   `App.jsx:1985` 的独立 `geo` 渲染由 team-lead 下线（连同 validModules 的 'geo'）。
 *
 * 向后兼容：不传 props 调用（如旧的 `<GeoDiagnose />`）行为不变。
 *
 * 直接消费三处已持久化上下文（不再要求用户重复填公司信息 / 重复触发 company-analyze）：
 *   - useCompany()        → currentCompany（企业主体）
 *   - useMarketingAsset() → asset（营销画像）
 *   - useCompanyKnowledge() → knowledge + brain（深度思考后落库的四类知识 + 公司画像中枢）
 * 三者一起喂给 diagnoseExposure，展示公司客户类型 + 曝光诊断（得分环 / 检查项 / 平台表现 / 优先事项）。
 * 绿色主题，复用全局 .module-page / .geo7-* 样式（与 NewMediaWorkbench 的诊断 UI 同源）。
 */

const CHECK_STATUS_ORDER = { fail: 0, warn: 1, unknown: 2, pass: 3 };
const SEVERITY_ORDER = { high: 0, mid: 1, low: 2 };

const CHECK_STATUS_META = {
  fail: { icon: '✕', label: '未通过', color: 'red' },
  warn: { icon: '!', label: '待优化', color: 'orange' },
  unknown: { icon: '?', label: '待核实', color: 'default' },
  pass: { icon: '✓', label: '已通过', color: 'green' },
};

const SEVERITY_META = {
  high: { label: '高', color: 'red' },
  mid: { label: '中', color: 'orange' },
  low: { label: '低', color: 'default' },
};

/** 检查项排序：未通过 → 待优化 → 待核实 → 已通过，同级按严重度降序。 */
function sortChecks(list) {
  return (list || []).slice().sort((a, b) => {
    const sa = CHECK_STATUS_ORDER[a.status] == null ? 9 : CHECK_STATUS_ORDER[a.status];
    const sb = CHECK_STATUS_ORDER[b.status] == null ? 9 : CHECK_STATUS_ORDER[b.status];
    if (sa !== sb) return sa - sb;
    const va = SEVERITY_ORDER[a.severity] == null ? 9 : SEVERITY_ORDER[a.severity];
    const vb = SEVERITY_ORDER[b.severity] == null ? 9 : SEVERITY_ORDER[b.severity];
    if (va !== vb) return va - vb;
    return String(a.name).localeCompare(String(b.name), 'zh-CN');
  });
}

/** 顶部得分环（内联 SVG，绿色渐变，不引图表库）。 */
function ScoreRing({ score = 0, grade = '' }) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const R = 42;
  const C = 2 * Math.PI * R;
  const dash = (C * s) / 100;
  return (
    <div className="geo7-ring">
      <svg viewBox="0 0 100 100" width="104" height="104" role="img" aria-label={'AI 搜索诊断得分 ' + s}>
        <defs>
          <linearGradient id="geo7Green" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#7bf1a8" />
            <stop offset="100%" stopColor="#30d158" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={R} fill="none" style={{ stroke: 'var(--c-border)' }} strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke="url(#geo7Green)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={dash + ' ' + (C - dash)}
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="47" textAnchor="middle" className="geo7-ring-num">{s}</text>
        <text x="50" y="64" textAnchor="middle" className="geo7-ring-unit">/ 100</text>
      </svg>
      {grade ? <div className="geo7-ring-grade">{grade}</div> : null}
    </div>
  );
}

/**
 * @param {object} props
 * @param {()=>void} [props.onBack] 返回回调（独立渲染时的返回按钮）
 * @param {boolean} [props.embedded=false] 内嵌模式：隐藏独立页头，供经营诊断维度卡片展开时内嵌
 * @param {object|null} [props.initialResult=null] 上层（经营诊断）已实抓到的 exposure 结果，传入即复用、不重复联网
 */
export default function GeoDiagnose({ onBack, embedded = false, initialResult = null }) {
  const { currentCompany } = useCompany();
  const { asset } = useMarketingAsset();
  const { getKnowledge, getBrain } = useCompanyKnowledge();
  const companyId = currentCompany ? currentCompany.id : '';

  // 归并模式：经营诊断已经实抓过一次，这里直接复用，不再重复烧一次联网 AI。
  const seed = initialResult && initialResult.ok === true ? initialResult : null;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(seed);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); // all | fail | unknown | pass
  const [openId, setOpenId] = useState(''); // 当前展开的检查项 id

  const busyRef = useRef(false);
  const run = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await diagnoseExposure({
        company: currentCompany,
        asset,
        knowledge: getKnowledge(companyId),
        brain: getBrain(companyId),
      });
      if (r && r.ok) {
        setResult(r);
        setFilter('all');
        setOpenId('');
      } else {
        setError((r && r.error) || '诊断失败，请稍后再试');
      }
    } catch (e) {
      setError('诊断失败：' + (e && e.message ? e.message : String(e)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [currentCompany, asset, companyId, getKnowledge, getBrain]);

  // 进入模块即自动诊断一次（切换企业后也重新诊断）；用 ref 防 React 重渲染时重复触发。
  const lastCompanyRef = useRef(null);
  useEffect(() => {
    if (!companyId) {
      if (embedded) return; // 内嵌模式：无企业态由上层（经营诊断）统一提示，不在这里刷空态文案
      setResult(null);
      setError('请先在「企业设置」选择或创建企业，再运行 AI 搜索诊断。');
      return;
    }
    if (seed) {
      // 归并模式：直接把经营诊断已实抓到的结果当作本组件结果，不再发起第二次联网诊断。
      lastCompanyRef.current = companyId;
      return;
    }
    if (lastCompanyRef.current === companyId) return;
    lastCompanyRef.current = companyId;
    run();
  }, [companyId, run, seed, embedded]);

  const companyType = inferCompanyType(asset, currentCompany);
  const typeLabel = COMPANY_TYPE_LABEL[companyType] || COMPANY_TYPE_LABEL.unknown;

  const sortedChecks = useMemo(() => sortChecks(result ? result.checks : []), [result]);
  const filteredChecks = useMemo(() => {
    if (filter === 'all') return sortedChecks;
    if (filter === 'fail') return sortedChecks.filter((c) => c.status === 'fail' || c.status === 'warn');
    if (filter === 'unknown') return sortedChecks.filter((c) => c.status === 'unknown');
    return sortedChecks.filter((c) => c.status === 'pass');
  }, [sortedChecks, filter]);

  return (
    <div className={embedded ? 'module-page geo-page ia-embed' : 'module-page geo-page'}>
      {embedded ? (
        <div className="ia-embed-hd">
          <span className="ia-embed-title"> AI 搜索明细</span>
          <span className="ia-embed-note">经营诊断 · GEO 的唯一展示出口</span>
        </div>
      ) : (
        <div className="module-page-head">
          <div className="module-page-title"> AI 搜索真诊断</div>
</div>
      )}

      <div className="hd-dash-card">
        <div className="hd-dash-hd">
          AI 搜索诊断
          <div className="hd-header-actions" style={{ display: 'inline-flex', gap: 8 }}>
            {onBack ? <Button size="small" onClick={onBack}>← 返回</Button> : null}
            <Button size="small" type="primary" ghost onClick={run} loading={busy}>
              {result ? '重新诊断' : '开始诊断'}
            </Button>
          </div>
        </div>
        <div className="hd-dash-bd">
          <div className="geo7-meta" style={{ marginTop: 0, marginBottom: 10 }}>
            <span className="field-label" style={{ margin: 0 }}>当前企业客户类型：</span>
            <Tag color={companyType === 'b2b' ? 'green' : companyType === 'b2c' ? 'cyan' : 'default'}>
              {typeLabel}
            </Tag>
            {currentCompany && currentCompany.name ? <Tag>{currentCompany.name}</Tag> : null}
          </div>

          {!result && !busy && !error && (
            <div className="hd-dash-empty">
              看 AI 眼里你的品牌够不够显眼、缺什么内容。证据不足的一律标「待核实」，不编造。
            </div>
          )}
          {busy && !result && <div className="xm-note">⏳ 正在实抓并诊断…</div>}
          {error && <div className="xm-error"> {error}</div>}

          {result && (
            <div className="geo7">
              {/* 顶部：得分环 + 结论 + 覆盖率 */}
              <div className="geo7-top">
                <ScoreRing score={result.overallScore} grade={result.grade} />
                <div className="geo7-top-main">
                  {/* 2026-10-14 打包前清扫：verdict 为空时不印「暂无结论」 */}
                  {result.verdict ? <div className="geo7-verdict">{result.verdict}</div> : null}
                  <div className="geo7-meta">
                    <Tag color="green">{result.source}</Tag>
                    <span className="geo7-coverage">
                      已核实 {result.coverage ? result.coverage.checked : 0} 项 · 待核实 {result.coverage ? result.coverage.unknown : 0} 项
                    </span>
                  </div>
                  <div className="geo7-tip">「待核实」= 没抓到证据，不做判定，绝不假装通过。</div>
                </div>
              </div>

              {/* 中部：诊断检查项 */}
              <div className="geo7-block-hd">
                <span>诊断检查项</span>
                <Segmented
                  size="small"
                  value={filter}
                  onChange={(v) => setFilter(v)}
                  options={[
                    { label: '全部', value: 'all' },
                    { label: '未通过', value: 'fail' },
                    { label: '待核实', value: 'unknown' },
                    { label: '已通过', value: 'pass' },
                  ]}
                />
              </div>
              {filteredChecks.length === 0 ? (
                <div className="hd-dash-empty">该筛选条件下没有检查项。</div>
              ) : (
                <div className="geo7-checks">
                  {filteredChecks.map((c) => {
                    const st = CHECK_STATUS_META[c.status] || CHECK_STATUS_META.unknown;
                    const sv = SEVERITY_META[c.severity] || SEVERITY_META.low;
                    const open = openId === c.id;
                    const toggle = () => setOpenId(open ? '' : c.id);
                    return (
                      <div className={'geo7-check geo7-st-' + c.status + (open ? ' open' : '')} key={c.id}>
                        <div
                          className="geo7-check-hd"
                          onClick={toggle}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggle();
                            }
                          }}
                        >
                          <span className={'geo7-ic geo7-ic-' + c.status}>{st.icon}</span>
                          <span className="geo7-check-name">{c.name}</span>
                          <Tag color={st.color} style={{ marginInline: 4 }}>{st.label}</Tag>
                          <Tag>{c.dimension}</Tag>
                          <Tag color={sv.color}>{sv.label}优先</Tag>
                          <span className="geo7-arrow">{open ? '收起' : '展开'}</span>
                        </div>
                        {open && (
                          <div className="geo7-check-bd">
                            <div className="geo7-line"><b>依据：</b>{c.evidence || '未获取到证据'}</div>
                            {c.why ? <div className="geo7-line"><b>为什么重要：</b>{c.why}</div> : null}
                            {c.fix && c.fix.action ? (
                              <div className="geo7-fix">
                                <div className="geo7-line"><b>修复动作：</b>{c.fix.action}</div>
                                {c.fix.steps && c.fix.steps.length > 0 ? (
                                  <ol className="geo7-steps">
                                    {c.fix.steps.map((s, i) => <li key={i}>{s}</li>)}
                                  </ol>
                                ) : null}
                                {c.fix.expect ? <div className="geo7-line"><b>预期效果：</b>{c.fix.expect}</div> : null}
                                {c.fix.effort ? <div className="geo7-line"><b>投入：</b>{c.fix.effort}</div> : null}
                              </div>
                            ) : (
                              <div className="geo7-line muted">该项当前无需修复动作。</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 平台得分：横向条（纯 CSS，不引图表库） */}
              {result.platformScores && result.platformScores.length > 0 ? (
                <div className="geo7-block">
                  <div className="geo7-block-hd"><span>平台表现</span></div>
                  <div className="geo7-bars">
                    {result.platformScores.map((p, i) => (
                      <div className="geo7-bar" key={p.platform + i}>
                        <div className="geo7-bar-name">{p.platform}</div>
                        <div className="geo7-bar-track">
                          <div className="geo7-bar-fill" style={{ width: Math.max(0, Math.min(100, p.score || 0)) + '%' }} />
                        </div>
                        <div className="geo7-bar-val">{p.score}</div>
                        {p.note ? <div className="geo7-bar-note">{p.note}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* 底部：优先做这几件事 */}
              {result.priorities && result.priorities.length > 0 ? (
                <div className="geo7-block">
                  <div className="geo7-block-hd"><span>优先做这几件事</span></div>
                  <div className="geo7-pri">
                    {result.priorities.slice(0, 3).map((p, i) => (
                      <div className="geo7-pri-card" key={i}>
                        <div className="geo7-pri-idx">{i + 1}</div>
                        <div className="geo7-pri-title">{p.title}</div>
                        {p.why ? <div className="geo7-pri-why">为什么：{p.why}</div> : null}
                        {p.expect ? <div className="geo7-pri-exp">预期：{p.expect}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
