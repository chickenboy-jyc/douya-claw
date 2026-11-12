import React, { useEffect, useState } from 'react';
import { App as AntApp, Button, Checkbox, Input, Select, Tag } from 'antd';
import { useCompany, COMPANY_TYPES } from '../store/companyStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { suggestKnowledgeUpdates, kindToListKey } from '../services/brainRefresh.js';
import { buildTimelineFacts, currentPeriod } from '../services/companyTimeline.js';
import { interpretTimeline, loadInsight, timelineFingerprint } from '../services/timelineInsight.js';
// 首登「企业体检」结论：独立 key `douya-company-checkup`（不进 facts/rules/memories）。
// 此处只做「看得见 + 可清除」——让老板确认它真的被隔离住了、且随时能回收。
import { loadCheckup, clearCheckup, checkupDate } from '../services/checkupBrief.js';
import { searchCompanyIntro } from '../services/groundedWebSearch.js';
import PlatformAccountMatrix from './PlatformAccountMatrix.jsx';
import { companyTypeIcon } from '../config/companyTypeConfig.js';
// 第十五轮统一版式页头（与其他四个重做页面同款）。
import PageBanner from './PageBanner.jsx';

/** 三类 AI 长期记忆（CompanyFact / CompanyRule / CompanyMemory）。Profile 由资产库管理。 */
const KIND_META = {
  facts: {
    label: '企业事实',
    hint: '成立时间、主营产品、公开资质等可验证事实',
    placeholder: '例如：成立于2015年，主营种植体与机扩',
  },
  rules: {
    label: '品牌规则',
    hint: '内容禁区 / 合规红线 / 品牌约束',
    placeholder: '例如：不得声称疗效/治愈率',
  },
  memories: {
    label: '长期记忆',
    hint: 'AI 长期要记住的偏好、历史策略、重要决策',
    placeholder: '例如：品牌偏好绿色极简风格，历史活动主推种植体',
  },
};
const KIND_ORDER = ['facts', 'rules', 'memories'];
const KIND_OPTIONS = KIND_ORDER.map((k) => ({ value: k, label: KIND_META[k].label }));

/** proposal.kind（fact/rule/memory）→ 中文名 + 列表 key。 */
const PROPOSAL_KIND = {
  fact: { label: '企业事实', listKey: 'facts' },
  rule: { label: '品牌规则', listKey: 'rules' },
  memory: { label: '长期记忆', listKey: 'memories' },
};
const ACTION_META = {
  add: { label: '新增', color: 'green' },
  update: { label: '更新', color: 'orange' },
  remove: { label: '删除', color: 'red' },
};
const CONFIDENCE_META = {
  high: { label: '高置信', color: 'green' },
  mid: { label: '中置信', color: 'gold' },
  low: { label: '低置信', color: 'default' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 企业营销大脑（四类知识里的 Fact/Rule/Memory 三类）。
 * 读写 companyKnowledgeStore（四类知识，按企业隔离），随企业走、注入统一 AI 上下文。
 * Profile（品牌定位/行业/产品等）由资产库管理；本页聚焦 AI 长期记忆三类。viewer 只读。
 *
 * 新增「🤖 AI 一键更新」：读取最近产出 + 现有知识，让 AI 提炼可沉淀的增量，
 * 用户勾选后一键写入，解决「企业大脑永远不更新、只能手动一条条加」的问题。
 *
 * 0.21.17（老板第 6 条「企业大脑里面 AI 长期记忆 折叠起来，然后顺序换一下，
 * 资产和子品牌做的更加傻瓜式 一键式一点」）：
 *   ① 「AI 长期记忆」由平铺改成 `<details>` 默认收起（DOM 里节点一个不少，只是不占版面）；
 *   ② 主列顺序改为「AI 面板 → AI 工具 → 动作结果 → AI 长期记忆」，
 *      把原来挂在右栏的三个一键动作搬到主列、紧跟 AI 面板（老板一进来"看一眼 + 点一下"在同一条视线上）；
 *      右栏只留「企业资料体检」这一眼快照 + 折叠的三块低频卡；
 *   ③ AI 面板的 chips 行补两个"一键直达"按钮（资产 / 子品牌），
 *      把「企业画像在资产里改、旗下品牌在子品牌里改」从一句文字提示变成可点的入口。
 *
 * @param {{onJump?: (tab:'brain'|'asset'|'brand') => void}} props
 *        `onJump` 由 `modules/CompanyProfile.jsx` 传入（就是页顶三个胶囊的 pickTab）。
 *        不传时本组件行为与改造前完全一致（底部那两个直达按钮不渲染）。
 */
export default function CompanyBrain({ onJump } = {}) {
  const { message } = AntApp.useApp();
  const { currentCompany, currentRole } = useCompany();
  const { listAssets } = useAssets();
  const { asset } = useMarketingAsset();
  const { getKnowledge, addFact, addRule, addMemory, removeFromList } = useCompanyKnowledge();
  const isViewer = currentRole === 'viewer';
  const cid = currentCompany && currentCompany.id;

  const [newKind, setNewKind] = useState('facts');
  const [newText, setNewText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  // AI 一键更新
  const [brainOpen, setBrainOpen] = useState(false);
  const [brainPhase, setBrainPhase] = useState(''); // '' | 'read' | 'refine'
  const [brainData, setBrainData] = useState(null); // { summary, proposals, gaps }
  const [checked, setChecked] = useState(() => new Set());
  const [applying, setApplying] = useState(false);

  // 让豆芽重新了解企业（联网检索 + 结论回写企业知识库）
  const [relearnOpen, setRelearnOpen] = useState(false);
  const [relearnPhase, setRelearnPhase] = useState(''); // '' | 'searching' | 'done' | 'failed'
  const [relearnSummary, setRelearnSummary] = useState('');

  // 时间轴「本月 vs 上月」AI 解读（阶段一补完）：事实与解读分开，解读按月缓存 + 数据指纹判新鲜。
  const [tlInsight, setTlInsight] = useState(null); // { period, fp, text } | null
  const [tlInsightLoading, setTlInsightLoading] = useState(false);
  const [tlInsightErr, setTlInsightErr] = useState('');

  const k = getKnowledge(cid);
  const lists = { facts: k.facts, rules: k.rules, memories: k.memories };

  // 体检结论（设计系统 v3 右栏同款）：完整度 / 记忆条目 / 知识画像全部实时真数据，不写死百分比
  const checkupStats = (() => {
    const a = asset || {};
    const fields = [
      a.companyName, a.industry, a.products, a.profile,
      (a.coreSellingPoints || []).length ? 1 : '',
      (a.targetCustomers || []).length ? 1 : '',
      a.marketingStrategy,
    ];
    const filled = fields.filter((f) => f && String(f).trim()).length;
    const pct = Math.round((filled / fields.length) * 100);
    const memTotal = (lists.facts || []).length + (lists.rules || []).length + (lists.memories || []).length;
    const p = (k.profile) || {};
    const profileCount = [p.brandPositioning, p.competitors, p.brandTone]
      .filter((v) => (Array.isArray(v) ? v.length : v && String(v).trim())).length;
    return { pct, memTotal, profileCount, level: pct >= 80 ? '良好' : pct >= 50 ? '一般' : '待完善' };
  })();
  // AI 面板「调性」chip：取 knowledge profile 里的品牌定位/调性（没有就不显示，不编）
  const brainTone = (k.profile && (k.profile.brandPositioning || k.profile.brandTone)) || '';

  // 首登体检结论（独立 key，按企业隔离）。clearCheckup 是纯函数直写 localStorage，
  // 不会触发本组件重渲染，故用本地 state 承接 + 清除后显式置空。
  const [checkup, setCheckup] = useState(() => loadCheckup(cid));
  useEffect(() => { setCheckup(loadCheckup(cid)); }, [cid]);

  function removeCheckup() {
    if (!cid) return;
    clearCheckup(cid);
    setCheckup(null);
    message.success('已清除体检结论，后续 AI 上下文不再带上它');
  }

  function addItem() {
    const v = (newText || '').trim();
    if (!v || !cid) return;
    if (newKind === 'facts') addFact(cid, v);
    else if (newKind === 'rules') addRule(cid, v);
    else addMemory(cid, v);
    setNewText('');
  }

  // 上传本地文件：读文本后按当前类别批量注入（每行一条）
  async function uploadFiles() {
    if (!cid) return;
    if (!window.api || !window.api.pickFiles || !window.api.readFileText) {
      setUploadMsg('当前环境不支持文件上传');
      return;
    }
    let r;
    try {
      r = await window.api.pickFiles();
    } catch {
      setUploadMsg('打开文件选择失败');
      return;
    }
    const paths = (r && r.filePaths) || [];
    if (!paths.length) return;
    setUploading(true);
    setUploadMsg('');
    let added = 0;
    let skipped = 0;
    for (const p of paths) {
      const fr = await window.api.readFileText(p, 2 * 1024 * 1024);
      if (!fr || !fr.ok) {
        skipped++;
        continue;
      }
      const text = String(fr.content || '').trim();
      if (!text) { skipped++; continue; }
      // 按行/按段落拆分，过滤空行，每条截断到 500 字
      const lines = text
        .split(/\r?\n+/)
        .map((s) => s.trim())
        .filter((s) => s && !/^[#>*\-—=]+$/.test(s))
        .map((s) => s.replace(/^[-*•·]+\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 200);
      for (const line of lines) {
        const v = line.length > 500 ? line.slice(0, 500) + '…' : line;
        if (newKind === 'facts') addFact(cid, v);
        else if (newKind === 'rules') addRule(cid, v);
        else addMemory(cid, v);
        added++;
      }
    }
    setUploading(false);
    setUploadMsg(added > 0 ? `✅ 已从 ${paths.length - skipped} 个文件导入 ${added} 条${KIND_META[newKind].label}` : `⚠️ 未导入任何内容（${skipped} 个文件无法读取或为空）`);
  }

  function removeItem(kind, item) {
    if (!cid) return;
    removeFromList(cid, kind, item);
  }

  // ---------- AI 一键更新 ----------
  async function runBrainRefresh() {
    if (!cid) return;
    setBrainOpen(true);
    setBrainData(null);
    setChecked(new Set());
    setBrainPhase('read');
    // 最近的产出 = AI 建议的证据来源（走 listAssets，按 updatedAt 倒序）
    const recentAssets = (listAssets({ companyId: cid }) || []).slice(0, 30);
    await sleep(600); // 让「读取中」这一阶段可见
    setBrainPhase('refine');
    const res = await suggestKnowledgeUpdates({
      companyId: cid,
      company: currentCompany,
      knowledge: k,
      asset,
      recentAssets,
      competitors: (k.profile && k.profile.competitors) || [],
    });
    setBrainPhase('');
    if (!res || !Array.isArray(res.proposals) || res.proposals.length === 0) {
      setBrainData({ summary: (res && res.summary) || '最近还没有足够可沉淀的产出，先去跑个任务或上传资料吧。', proposals: [], gaps: (res && res.gaps) || [] });
      return;
    }
    setBrainData(res);
    // 默认勾选 high / mid，低置信留给用户自己判断
    setChecked(new Set(res.proposals.map((p, i) => (p.confidence === 'low' ? -1 : i)).filter((i) => i >= 0)));
  }

  function toggleCheck(i) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function selectAll(flag) {
    const all = (brainData && brainData.proposals ? brainData.proposals : []).map((_, i) => i);
    setChecked(flag ? new Set(all) : new Set());
  }

  async function applyProposals() {
    if (!cid || !brainData) return;
    const list = (brainData.proposals || []).filter((_, i) => checked.has(i));
    if (list.length === 0) {
      message.warning('还没有勾选任何条目');
      return;
    }
    setApplying(true);
    let ok = 0;
    let bad = 0;
    for (const p of list) {
      try {
        const listKey = (PROPOSAL_KIND[p.kind] && PROPOSAL_KIND[p.kind].listKey) || kindToListKey(p.kind);
        if (p.action === 'add') {
          if (listKey === 'facts') addFact(cid, p.value);
          else if (listKey === 'rules') addRule(cid, p.value);
          else addMemory(cid, p.value);
        } else if (p.action === 'remove') {
          removeFromList(cid, listKey, p.value);
        } else {
          // update：store 没有 updateFact，用「先加新值 → 再删旧值」组合实现，
          // 两步都按值去重，重复执行结果一致（幂等）。
          if (listKey === 'facts') addFact(cid, p.value);
          else if (listKey === 'rules') addRule(cid, p.value);
          else addMemory(cid, p.value);
          removeFromList(cid, listKey, p.oldValue);
        }
        ok += 1;
      } catch {
        bad += 1;
      }
    }
    setApplying(false);
    setBrainData(null);
    setChecked(new Set());
    if (bad === 0) message.success(`已写入企业大脑 ${ok} 条`);
    else message.warning(`已写入 ${ok} 条，${bad} 条失败`);
  }

  // ---------- 让豆芽重新了解企业 ----------
  // 复用 Onboarding Step4 的「联网搜索企业」能力（searchWeb 走 enable_search），
  // 结合已填档案 + 补充知识，重新联网了解企业，并把结论写进企业知识库（facts + 长期记忆）。
  async function runRelearn() {
    if (!cid) return;
    setRelearnOpen(true);
    setRelearnPhase('searching');
    setRelearnSummary('');

    const companyName = (currentCompany && currentCompany.name) || (asset && asset.companyName) || '';
    const kk = getKnowledge(cid);
    const profile = (kk && kk.profile) || {};
    const competitors = (Array.isArray(profile.competitors) ? profile.competitors : []).join('、');
    const selling = (Array.isArray(profile.coreSellingPoints) ? profile.coreSellingPoints : []).join('、');
    const customers = (Array.isArray(profile.targetCustomers) ? profile.targetCustomers : []).join('、');
    const tone = profile.brandPositioning || profile.brandTone || '';
    const facts = (Array.isArray(kk.facts) ? kk.facts : []).join('；');

    const r = await searchCompanyIntro({
      companyName,
      question:
        '请依据检索到的公开资料，说明口腔行业相关企业「' + companyName + '」，并结合已知信息重新了解这家企业。' +
        (competitors ? '已知竞品：' + competitors + '；' : '') +
        (selling ? '已知核心卖点：' + selling + '；' : '') +
        (customers ? '已知目标客户：' + customers + '；' : '') +
        (tone ? '已知品牌调性：' + tone + '；' : '') +
        (facts ? '已知企业事实：' + facts + '；' : '') +
        '请用 3-6 句话说明：这是一家什么公司、主营产品/服务、目标客户、核心卖点、在行业中的定位与差异化。' +
        '只依据上述资料；若公开信息很少，请诚实说明「公开信息较少」，不要编造。',
    });
    const w = r && r.ok && r.text ? String(r.text).trim() : '';
    if (w) {
      setRelearnPhase('done');
      setRelearnSummary(w);
      // 结论按句拆成企业事实（facts），避免一条过长；同时记一条长期记忆
      const sentences = w
        .split(/(?<=[。；！？!?])/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6);
      sentences.forEach((s) => addFact(cid, s));
      const dateStr = new Date().toLocaleDateString('zh-CN');
      addMemory(cid, '豆芽已于 ' + dateStr + ' 重新联网了解企业：' + (w.length > 120 ? w.slice(0, 120) + '…' : w));
    } else {
      setRelearnPhase('failed');
      setRelearnSummary((r && r.error) || '在线检索暂不可用，豆芽将基于现有档案继续了解你的企业。');
    }
  }

  function countByKind(kind) {
    return (brainData && brainData.proposals ? brainData.proposals : []).filter((p) => p.kind === kind);
  }

  function renderProposal(p, idx) {
    const realIdx = (brainData.proposals || []).indexOf(p);
    const i = idx >= 0 ? idx : realIdx;
    const km = PROPOSAL_KIND[p.kind] || PROPOSAL_KIND.fact;
    const am = ACTION_META[p.action] || ACTION_META.add;
    const cm = CONFIDENCE_META[p.confidence] || CONFIDENCE_META.mid;
    return (
      <div className={'brain-proposal' + (checked.has(i) ? ' checked' : '')} key={p.kind + '-' + i}>
        <Checkbox checked={checked.has(i)} onChange={() => toggleCheck(i)} />
        <div className="brain-proposal-body">
          <div className="brain-proposal-line">
            <Tag color="green">{km.label}</Tag>
            <Tag color={am.color}>{am.label}</Tag>
            <Tag color={cm.color}>{cm.label}</Tag>
          </div>
          <div className="brain-proposal-value">
            {p.action === 'update' ? (
              <span>
                <span className="brain-old">{p.oldValue}</span>
                <span className="brain-arrow"> → </span>
                <span className="brain-new">{p.value}</span>
              </span>
            ) : (
              <span className={p.action === 'remove' ? 'brain-old' : 'brain-new'}>{p.value}</span>
            )}
          </div>
          <div className="brain-proposal-why">为什么：{p.reason || '—'}</div>
          <div className="brain-proposal-evidence">依据：{p.evidence}</div>
        </div>
      </div>
    );
  }

  function renderRefreshPanel() {
    const proposals = (brainData && brainData.proposals) || [];
    return (
      <div className="brain-refresh">
        {brainPhase ? (
          <div className="brain-loading">
            <div className="brain-loading-step">
              <span className={brainPhase === 'read' ? 'on' : 'done'}>{brainPhase === 'read' ? '●' : '✓'}</span>
              正在读取最近的产出（活动方案 / 竞品报告 / 文案 / 舆情…）
            </div>
            <div className="brain-loading-step">
              <span className={brainPhase === 'refine' ? 'on' : ''}>{brainPhase === 'refine' ? '●' : '○'}</span>
              正在提炼可沉淀的事实 / 规则 / 记忆
            </div>
          </div>
        ) : null}

        {!brainPhase && brainData ? (
          <>
            <div className="brain-refresh-summary">{brainData.summary || '（AI 没有给出总结）'}</div>
            {proposals.length === 0 ? (
              <div className="today-empty">暂无可写入的建议：最近产出不足以提炼出有据可查的新事实。</div>
            ) : (
              ['fact', 'rule', 'memory'].map((kind) => {
                const group = countByKind(kind);
                if (group.length === 0) return null;
                return (
                  <div className="brain-group" key={kind}>
                    <div className="brain-group-head">
                      {PROPOSAL_KIND[kind].label}
                      <span className="brain-group-count">{group.length}</span>
                    </div>
                    {group.map((p) => renderProposal(p, proposals.indexOf(p)))}
                  </div>
                );
              })
            )}
            {Array.isArray(brainData.gaps) && brainData.gaps.length > 0 && (
              <div className="brain-gaps">
                <div className="brain-gaps-head">企业画像还缺（补齐后 AI 输出会更准）</div>
                {brainData.gaps.map((g, i) => <div className="brain-gap" key={i}>· {g}</div>)}
              </div>
            )}
            <div className="brain-refresh-foot">
              <span className="brain-refresh-count">已选 {checked.size} / {proposals.length} 条</span>
              <Button size="small" onClick={() => selectAll(false)}>全不选</Button>
              <Button size="small" onClick={() => selectAll(true)}>全选</Button>
              <Button
                size="small"
                type="primary"
                loading={applying}
                onClick={applyProposals}
                disabled={proposals.length === 0}
              >
                确认写入（{checked.size} 条）
              </Button>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  function renderList(kind) {
    const meta = KIND_META[kind];
    const list = lists[kind] || [];
    if (list.length === 0) {
      return <div className="today-empty">{meta.hint}</div>;
    }
    return (
      <div className="brain-list">
        {list.map((item, i) => (
          <div key={kind + '-' + i} className="brain-item">
            <span className="brain-dot">{kind === 'rules' ? '⛔' : '•'}</span>
            <span className="brain-text">{item}</span>
            {!isViewer && (
              <button type="button" className="brain-del" onClick={() => removeItem(kind, item)} title="删除">✕</button>
            )}
          </div>
        ))}
      </div>
    );
  }

  // 把「本月 vs 上月」的事实文本按行渲染成可读列表（不用 <pre> 贴机器文本）。
  function renderTimelineFacts(facts) {
    const lines = String(facts || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.map((l, i) => {
      if (l.startsWith('·')) {
        return <div className="tl-facts-sec" key={i}>{l.replace(/^·\s*/, '')}</div>;
      }
      return <div className="tl-facts-item" key={i}>{l.replace(/^-\s*/, '')}</div>;
    });
  }

  // 让豆芽解读「本月 vs 上月」的变化（只基于事实，不编数字；无数据不调 AI、不写缓存）。
  async function runTimelineInsight() {
    if (tlInsightLoading) return;
    setTlInsightErr('');
    setTlInsightLoading(true);
    try {
      const entries = (k && k.timeline) || [];
      const r = await interpretTimeline({ companyId: cid, entries, knowledge: k });
      if (r && r.ok && r.insight) {
        setTlInsight({ period: r.period, fp: timelineFingerprint(entries, r.period), text: r.insight });
      } else {
        setTlInsightErr((r && r.error) || '解读失败，请重试');
      }
    } catch (e) {
      setTlInsightErr('解读失败：' + (e && e.message ? e.message : e));
    } finally {
      setTlInsightLoading(false);
    }
  }

  // 阶段一：企业档案时间段追踪 —— AI 解读「本月 vs 上月」的变化 + 事实对比 + 近期各月记录。
  function renderTimeline() {
    const tl = k.timeline || [];
    if (tl.length === 0) {
      return (
        <div className="today-empty">
          还没有记录。跑一次「经营诊断」，豆芽就会按月记下企业做了什么。
        </div>
      );
    }

    const period = currentPeriod();
    const facts = buildTimelineFacts(tl);
    const fp = timelineFingerprint(tl, period);
    const cached = loadInsight(cid, period);
    const fromState = tlInsight && tlInsight.period === period && tlInsight.fp === fp ? tlInsight.text : '';
    const fromCache = cached && cached.fingerprint === fp ? cached.insight : '';
    const insightText = fromState || fromCache || '';

    const recent = tl.slice(0, 4);
    return (
      <div className="tl-wrap">
        <div className="tl-insight">
          <div className="tl-insight-hd">
            <span className="tl-insight-title">豆芽怎么看这个月的变化</span>
            <span className="tl-insight-badge">AI 解读</span>
          </div>
          {tlInsightLoading ? (
            <div className="tl-insight-body tl-insight-muted">豆芽正在读这个月的变化…</div>
          ) : insightText ? (
            <>
              <div className="tl-insight-body">{insightText}</div>
              {!isViewer && (
                <button type="button" className="tl-insight-btn tl-insight-btn-ghost" onClick={runTimelineInsight}>
                  重新解读
                </button>
              )}
            </>
          ) : (
            <div className="tl-insight-empty">
              <span className="tl-insight-muted">
                {tlInsightErr
                  ? tlInsightErr
                  : isViewer
                    ? '（查看者模式）暂无人解读这个月的变化。'
                    : '还没有解读。点下面按钮，让豆芽看看这个月的变化说明了什么。'}
              </span>
              {!isViewer && (
                <button type="button" className="tl-insight-btn" onClick={runTimelineInsight}>
                  ✨ 让豆芽解读
                </button>
              )}
            </div>
          )}
        </div>

        {facts && (
          <div className="tl-facts">
            <div className="tl-facts-title">本月 vs 上月（事实）</div>
            <div className="tl-facts-body">{renderTimelineFacts(facts)}</div>
          </div>
        )}

        <div className="tl-periods">
          {recent.map((e) => {
            const mkeys = Object.keys(e.metrics || {});
            return (
              <div className="tl-period" key={e.period}>
                <div className="tl-period-hd">
                  <span className="tl-period-label">{e.period}</span>
                  <span className="tl-period-sub">关键指标 · 做了什么</span>
                </div>
                <div className="tl-metrics">
                  {mkeys.length === 0 ? (
                    <span className="tl-empty-mini">暂无指标记录</span>
                  ) : (
                    mkeys.map((mk) => {
                      const m = e.metrics[mk];
                      return (
                        <span className="tl-metric" key={mk}>
                          {m.label}：{m.display != null ? m.display : '—'}
                          {m.note ? <span className="tl-metric-note">（{m.note}）</span> : null}
                        </span>
                      );
                    })
                  )}
                </div>
                {(e.events || []).length > 0 && (
                  <div className="tl-events">
                    {(e.events || []).map((ev, i) => (
                      <div className="tl-event" key={i}>· {ev.label}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="brain r15-page">
      {/* 第十五轮统一版式：PageBanner + 双栏（主列：AI 操作与三类知识；右栏：体检/时间轴/平台账号） */}
      <PageBanner
        ic="sparkle"
        title="企业大脑"
        sub="AI 对企业的认知、记忆与工具，全部收敛到一个页面。"
        slogan="你的企业，它都记得"
      />

      {/* 【0.21.12 · 老板第 4 条】「企业大脑也没改」。
          上一轮只把三张低频卡收进了折叠，其余一字未动 —— 而老板看到的是
          「上面还挂着一条『第 15 轮统一版式：双栏 1fr + 300px…』的说明条」
          （那是写给开发看的版式备注，用户读不懂，纯粹是噪音）+ 主列两张卡（AI 面板 / 记一条）
          各自独立，一屏还是被切成好几块。本轮：
            ① 版式说明条整条删掉；
            ② 「记一条进大脑」并进 AI 面板卡（同一个动作，不该占两张卡）；
            ③ 右栏「体检结论」与折叠里的「企业体检结论」重名且语义不同 → 分别改名并分工。
          能力一个没删，只删了一条内部备注、合并了一张重复性质的卡。 */}

      <div className="r15-cols">
        <div className="r15-main">

      {/* 2026-10-16 设计系统 v3 同款「AI 面板」卡：AI 当前对企业认知的一句话概览 + 关键 chips。
          全部取真数据：企业名 / 身份（companyStore 枚举）/ 调性（knowledge profile）；
          三类记忆条数实时统计——没有的项不显示，不编造。 */}
      <div className="r15-card" data-brain-panel="1">
        <div className="r15-card-t">AI 面板<span className="r15-tag">已连接 DeepSeek</span></div>
        <div className="brain-panel-msg">
          <span className="brain-panel-avatar" aria-hidden="true">🌱</span>
          <div className="brain-panel-bubble">
            我已了解「{(currentCompany && currentCompany.name) || (asset && asset.companyName) || '这家企业'}」：
            {(lists.facts || []).length} 条经营事实 · {(lists.rules || []).length} 条偏好设定 · {(lists.memories || []).length} 条待办提醒已记入大脑。
            需要我更新哪部分认知？
          </div>
        </div>
        <div className="brain-panel-chips">
          <span className="r15-tag">品牌：{(currentCompany && currentCompany.name) || (asset && asset.companyName) || '未命名企业'}</span>
          <span className="r15-tag">身份：{COMPANY_TYPES[(currentCompany && currentCompany.type) || ''] || '未设置'}</span>
          {brainTone ? <span className="r15-tag">调性：{brainTone}</span> : null}
        </div>

        {/* 【0.21.17 · 老板第 6 条】「资产和子品牌做的更加傻瓜式 一键式一点」。
            这两块的编辑入口过去只写在页面最底部一句文字里（「企业画像在「资产」里改，
            旗下品牌在「子品牌」里改」）—— 用户得自己回页顶找胶囊。现在是两个按钮：
            点一下直接切到对应分区，不用记位置、不用滚回去。
            onJump 由 CompanyProfile 传入；没传（单测直接挂载本组件）时不渲染，行为不变。 */}
        {typeof onJump === 'function' && (
          <div className="brain-jump" data-brain-jump-bar="1">
            <span className="brain-jump-label">去改：</span>
            <button
              type="button"
              className="brain-jump-btn"
              data-brain-jump="asset"
              onClick={() => onJump('asset')}
            >
              📁 企业画像 / 资产
            </button>
            <button
              type="button"
              className="brain-jump-btn"
              data-brain-jump="brand"
              onClick={() => onJump('brand')}
            >
              🏷 旗下子品牌
            </button>
          </div>
        )}

        {/* 【0.21.12 · 老板第 4 条】「记一条进大脑」并进本卡：同一个动作不该占一整张卡。
            分隔线 + 一行输入，视觉上仍是"跟豆芽说一句"的延伸。 */}
        {!isViewer && (
          <div className="brain-inline-add" data-brain-inline-add="1">
            <div className="brain-inline-add-t">记一条给我</div>
            <div className="brain-add">
              <Select
                size="small"
                value={newKind}
                onChange={setNewKind}
                options={KIND_OPTIONS}
                style={{ width: 118, flexShrink: 0 }}
              />
              <Input
                size="small"
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder={KIND_META[newKind].placeholder}
                onPressEnter={addItem}
              />
              <Button size="small" type="primary" onClick={addItem} disabled={!(newText || '').trim()}>
                添加
              </Button>
            </div>
            {uploadMsg && (
              <div className={uploadMsg.startsWith('✅') ? 'xm-note' : 'xm-error'} style={{ marginTop: 6 }}>
                {uploadMsg}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 【0.21.17 · 老板第 6 条】「顺序换一下」。
          「AI 工具」原来平铺在右栏最上面（重新了解企业 / AI 一键更新 / 上传导入资料），
          而主列第一张卡说的正是"豆芽对你的企业了解到什么程度"——老板真正要做的动作，
          就是紧接着"那我让它再了解一遍 / 更新一下"。两处隔着一整列，视线要跳。
          搬到主列、紧跟 AI 面板：看一眼 → 点一下，在同一条竖线上。
          取数与回调一个字没改（仍是 runRelearn / runBrainRefresh / uploadFiles）。 */}
      {!isViewer && (
        <div className="r15-card" data-brain-tools="1">
          <div className="r15-card-t">AI 工具<span className="r15-tag">一键</span></div>
          <div className="brain-tools">
            {/* 2026-10-16 设计系统 v3 同款三态：主按钮（绿）/ 白底绿边 / 白底灰边 */}
            <Button type="primary" onClick={runRelearn} loading={relearnPhase === 'searching'} block>
              🔍 重新了解企业
            </Button>
            <Button onClick={runBrainRefresh} loading={!!brainPhase} block className="brain-tool-outline">
              🤖 AI 一键更新
            </Button>
            <Button onClick={uploadFiles} loading={uploading} block title="从本地文件批量导入（txt/md/csv 等，每行一条）">
              📤 上传导入资料
            </Button>
          </div>
        </div>
      )}

      {relearnOpen && (
        <div className="r15-card" data-brain-relearn="1">
          <div className="r15-card-t">让豆芽重新了解企业</div>
          <div className="brain-refresh">
            {relearnPhase === 'searching' && (
              <div className="brain-loading">
                <div className="brain-loading-step">
                  <span className="on">●</span>
                  正在联网搜索「{currentCompany && currentCompany.name}」的公开信息，并对照你已填的档案与补充的知识…
                </div>
              </div>
            )}
            {relearnPhase === 'done' && (
              <>
                <div className="brain-refresh-summary">{relearnSummary}</div>
                <div className="brain-hint">
                  豆芽已把上面的结论按句写进「企业事实」，并记入长期记忆，后续对话与任务都会带上这些认识，越来越懂你的企业。
                </div>
              </>
            )}
            {relearnPhase === 'failed' && (
              <div className="today-empty">{relearnSummary}</div>
            )}
          </div>
        </div>
      )}

      {brainOpen && (
        <div className="r15-card" data-brain-refresh="1">
          <div className="r15-card-t">AI 更新建议</div>
          {renderRefreshPanel()}
        </div>
      )}

      {/* 【0.21.9 · 老板第 4 条】「AI 长期记忆的改成横版 不要竖版」。
          取数逻辑一字未改：仍是 lists[kind] + renderList(kind)。
          横版由 styles/round16-brain.css 的 .brain-cols（固定三列 / 窄屏 auto-fit 换行）
          + .brain-col（每类一张小卡）实现 —— 之所以不在 JSX 里写死布局：
          原来 ≤900px 会被 style.css 的媒体查询压成单列，那正是"竖版"的来源。

          【0.21.17 · 老板第 6 条】「AI 长期记忆 折叠起来」。
          这一块是**台账**（AI 记住了什么），不是老板每天要操作的东西；平铺在最后仍然
          占掉半屏。改成 `<details>`：默认收起成一行（标题 + 三类条数 + 展开提示），
          点一下才铺开横版三列。
          ⚠️ 刻意用**原生 details + 不条件渲染**：收起时三列节点仍在 DOM 里
          （`[data-brain-memory-col]` / `[data-brain-memory-count]` 锚点照样取得到），
          门禁与老用例不需要"先展开再取数"；数据也一条没删，只是不再抢版面。 */}
      <details className="r15-card brain-mem" data-brain-memory="1">
        <summary className="brain-mem-sum" data-brain-memory-sum="1">
          <span className="brain-mem-sum-title">AI 长期记忆</span>
          <span className="brain-mem-sum-tags">
            <span className="r15-tag">企业事实 {(lists.facts || []).length}</span>
            <span className="r15-tag">品牌规则 {(lists.rules || []).length}</span>
            <span className="r15-tag">长期记忆 {(lists.memories || []).length}</span>
          </span>
          <span className="brain-mem-sum-hint" aria-hidden="true" />
        </summary>
        <div className="brain-cols">
        {KIND_ORDER.map((kind) => (
          <div className="brain-col" key={kind} data-brain-memory-col={kind}>
            <div className="brain-col-head">
              <span className="brain-col-title">{KIND_META[kind].label}</span>
              <span className="brain-col-count" data-brain-memory-count={kind}>{(lists[kind] || []).length}</span>
            </div>
            {renderList(kind)}
          </div>
        ))}
        </div>
      </details>
      </div>{/* ===== 主列结束 · 右栏开始 ===== */}

      <aside className="r15-rail">
        {/* 【0.21.17 · 老板第 6 条】右栏重新排过：
            ① 「AI 工具」整张卡搬到主列（理由见上面那张卡的注释）；
            ② 「企业资料体检」从折叠里提出来平铺在右栏第一张 —— 它是**一眼快照**
               （完整度 / 记忆条目 / 画像项数），本来就不该跟"低频详情"一起塞进折叠；
            ③ 折叠里只剩真正的低频三块：首登 AI 体检结论 · 时间轴 · 平台账号。
            取数口径一个没改（checkupStats 仍是实时真数据），只是换位置。 */}

        {/* 2026-10-16 设计系统 v3 右栏同款「体检结论」卡：真实口径实时计算。
            【0.21.12 · 老板第 4 条】改名「企业资料体检」——它算的是**资料填了几项**，
            和折叠里那张「首登 AI 体检结论」（AI 判的短板与整改建议）是两件事，
            原来两张都叫「体检结论」，摆在一起像重复。 */}
        <div className="r15-card" data-brain-checkup-stats="1">
          <div className="r15-card-t">
            企业资料体检
            <span className="r15-tag">{checkupStats.level}</span>
          </div>
          <div className="cb-ck-stats">
            <div className="cb-ck-check">
              <svg viewBox="0 0 24 24" fill="none" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
              <span>企业资料完整度 {checkupStats.pct}%</span>
            </div>
            <div className="cb-ck-check">
              <svg viewBox="0 0 24 24" fill="none" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
              <span>记忆条目 {checkupStats.memTotal} 条</span>
            </div>
            <div className="cb-ck-check">
              <svg viewBox="0 0 24 24" fill="none" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
              <span>知识画像 {checkupStats.profileCount} 项已配置</span>
            </div>
          </div>
        </div>

        {/* 【0.21.14 · 老板需求 4】「企业大脑里面有一堆罗里吧嗦的东西 UI也是优化一下，
            可以有但有些不需要展示出来。干净一些。」
            低频三张（首登体检结论 / 时间轴 / 平台账号）继续收在这个折叠里 ——
            能力一个没删、取数逻辑一行没改，只是从「平铺」变「折叠」。 */}
        <details className="cb-more" data-brain-more="1">
          <summary>更多：首登体检结论 · 时间轴 · 平台账号</summary>


        {checkup && (
          <div className="r15-card">
            <div className="r15-card-t">🩺 首登 AI 体检结论</div>
            <div className="cb-ck-hd">
              <span className="cb-ck-badge">AI 假设 · 非既成事实</span>
              {checkupDate(checkup) ? <span className="cb-ck-date">体检于 {checkupDate(checkup)}</span> : null}
              {!isViewer && (
                <button type="button" className="cb-ck-clear" onClick={removeCheckup} title="清除后不再注入 AI 上下文">
                  清除
                </button>
              )}
            </div>
            {checkup.summary ? (
              <div className="cb-ck-summary">最该先解决的一件事：{checkup.summary}</div>
            ) : null}
            {checkup.gaps.length > 0 && (
              <div className="cb-ck-sec">
                <div className="cb-ck-sec-title">发现的短板（{checkup.gaps.length}）</div>
                {checkup.gaps.map((g, i) => (
                  <div className="cb-ck-gap" key={i}>
                    <span className="cb-ck-gap-title">{g.title}</span>
                    <span className="cb-ck-gap-why">依据：{g.why}</span>
                  </div>
                ))}
              </div>
            )}
            {checkup.fixes.length > 0 && (
              <div className="cb-ck-sec">
                <div className="cb-ck-sec-title">建议先整改（{checkup.fixes.length}）</div>
                {checkup.fixes.map((f, i) => (
                  <div className="cb-ck-fix" key={i}>
                    <span className="cb-ck-fix-gap">{f.gap}</span>
                    <span className="cb-ck-fix-act">{f.action}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="cb-ck-note">
              它以「AI 假设」的名义注入 AI 上下文，<b>不会写进企业事实</b>；与你填的资料冲突时以资料为准。
            </div>
          </div>
        )}

        <div className="r15-card">
          <div className="r15-card-t">🕐 时间轴</div>
          {renderTimeline()}
        </div>

        <div className="r15-card">
          <div className="r15-card-t">📱 平台账号</div>
          <PlatformAccountMatrix />
        </div>
        </details>
      </aside>{/* r15-rail */}
    </div>{/* r15-cols */}

      <div className="brain-hint" style={{ marginTop: 14 }}>
        豆芽每次都会带上这些信息，不会搞错企业。
        {typeof onJump === 'function'
          ? '企业画像和旗下品牌，用上面「去改」的两个按钮一键直达。'
          : '企业画像在「资产」里改，旗下品牌在「子品牌」里改。'}
      </div>
    </div>
  );
}
