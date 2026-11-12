import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Popconfirm, Switch, Tag, Tooltip } from 'antd';
import { useCompanyKnowledge, listBrandIps, listBrandMainAliases, normalizeBrandIp } from '../store/companyKnowledgeStore.jsx';
import { getCachedWebSearchHealth } from '../services/webSearchHealth.js';
import { candidateSourceNote } from '../services/webSearchHonesty.js';
import { fetchWebCandidates } from '../services/webCandidates.js';
import WebCandidatePicker from './WebCandidatePicker.jsx';
// 首屏三块（搜索框 / 结果区 / 更多设置）的样式独立成文件，不往 6697 行的 style.css 里加规则。
import '../styles/bip.css';

/**
 * 旗下 IP / 子品牌（品牌矩阵）——0.21.14 老板需求 4 重写首屏。
 *
 * 老板原话：
 *   「企业大脑 现在你选择一个企业他下面有很多子品牌，把这些子品牌也要做AI建档，这一块要做的简单，
 *     把现有的推翻，比如你的母品牌叫康健苗苗，点击搜索,ai自动把他旗下的所有子品牌比如上游货源展示出来，
 *     在上游货源旁边有一个建档按钮 点击上游货源就自动建好档了。」
 *
 * 落地口径（架构设计 §1.6 / §3.4，已定案）：
 *   · 首屏只有三块：**母品牌输入** `[data-bip-main-input]` → **搜索** `[data-bip-search]`
 *     → **结果区** `[data-bip-results]`（每行一个「建档」按钮 `[data-bip-build]`）。
 *   · 检索**复用**既有的 `fetchWebCandidates({ kind: 'brand', companyName })`（底层 groundedSearch 真检索），
 *     **不新写检索、不新写提示词、不新写解析器**。
 *   · 落库走 `setBrandIps` → `localStorage['douya-company-knowledge'][cid].profile.brandIps`
 *     （**不新增 localStorage key、不用后端表、不碰 memoryStore** ——
 *     profile.brandIps 已被 companyContext / 首登 Step5 / 本组件三处读，换存储三处同时失真）。
 *   · 合规红线：候选**永不自动落库**，只有用户点「建档」才写；搜完不点 → 库里一条不多。
 *   · 幂等：小写 name 去重；已建档的行显示「已建档」+ disabled，重复点仍只有 1 条。
 *   · 原来那一堆「品牌归属 / 编辑别名 / 手动添加 / 已登记列表 / 联网勾选」**全部保留**，
 *     但收进 `<details data-bip-more>`：首屏不可见，功能一个没删（老板要「干净一些」，不是「删掉」）。
 *
 * 用法：`<BrandIpManager companyId={id} mainBrandName="康健苗苗" />`
 * 首登 Step5 通过 `enableWebSearch={false}` 关掉内置的联网勾选入口，避免同一步出现两个重复按钮。
 *
 * @param {{companyId:string, mainBrandName?:string, disabled?:boolean, enableWebSearch?:boolean,
 *          webCandidateFn?:Function}} props
 *        `webCandidateFn` 仅测试注入（默认 fetchWebCandidates），生产不传。
 */

/** 主品牌固定 id，便于结果里区分「母公司」与「旗下 IP」。 */
export const MAIN_BRAND_ID = '__main__';

/**
 * 把用户输入的别名文本切成数组（支持中英文逗号、顿号、分号、空格/换行）。
 * @param {string} text
 * @returns {string[]} 去重去空后的别名数组
 */
export function parseAliasInput(text) {
  return String(text || '')
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter((v, i, arr) => !!v && arr.indexOf(v) === i);
}

/**
 * 构造本轮要扫描的监控对象列表：主品牌（固定、必选）+ 所有启用中的旗下 IP。
 * @param {string} mainName 母公司名称
 * @param {string[]} mainAliases 主品牌别名
 * @param {Array<object>} ips listBrandIps 的产出
 * @returns {Array<{id:string, name:string, aliases:string[], note:string, kind:'main'|'ip'}>}
 */
export function buildMonitorTargets(mainName, mainAliases, ips) {
  const out = [];
  const seen = [];
  const push = (t) => {
    const key = String(t.name || '').trim();
    if (!key || seen.includes(key)) return;
    seen.push(key);
    out.push(t);
  };

  push({
    id: MAIN_BRAND_ID,
    name: String(mainName || '').trim(),
    aliases: Array.isArray(mainAliases) ? mainAliases.slice() : [],
    note: '母品牌 / 公司主体',
    kind: 'main',
  });

  (Array.isArray(ips) ? ips : [])
    .filter((ip) => ip && ip.enabled !== false)
    .forEach((ip) => {
      push({
        id: ip.id,
        name: ip.name,
        aliases: Array.isArray(ip.aliases) ? ip.aliases.slice() : [],
        note: ip.note || '',
        kind: 'ip',
      });
    });

  return out;
}

const EMPTY_FORM = { name: '', aliases: '', note: '' };

export default function BrandIpManager({
  companyId,
  mainBrandName = '',
  disabled = false,
  enableWebSearch = true,
  webCandidateFn = fetchWebCandidates,
}) {
  const { getKnowledge, setBrandIps, getBrandMainAliases, setBrandMainAliases, updateProfile } = useCompanyKnowledge();

  const knowledge = useMemo(
    () => (companyId ? getKnowledge(companyId) : null),
    [companyId, getKnowledge],
  );
  const ips = useMemo(() => listBrandIps(knowledge), [knowledge]);
  const mainAliases = useMemo(() => listBrandMainAliases(knowledge), [knowledge]);

  // IP 新增/编辑弹窗
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  // 主品牌别名编辑弹窗
  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasText, setAliasText] = useState('');

  const mainName = String(mainBrandName || (knowledge && knowledge.profile ? knowledge.profile.companyName : '') || '').trim();
  const industry = String((knowledge && knowledge.profile ? knowledge.profile.industry : '') || '').trim();

  // ---- 首屏三块的 state：母品牌名 / 搜索态 / 候选结果 ----
  const [mainInput, setMainInput] = useState(mainName);
  useEffect(() => {
    setMainInput(mainName);
    // 换企业（或主品牌改名）时，上一条「已一键建档 N 个」的成绩单必须作废。
    setQuickMsg('');
  }, [mainName, companyId]);

  /** 'idle' 未搜索 | 'searching' 检索中 | 'done' 有候选 | 'empty' 没找到（含检索失败） */
  const [searchState, setSearchState] = useState('idle');
  /** 候选列表 [{name, note}]；**只是组件 state，永不自动落库** */
  const [candidates, setCandidates] = useState([]);

  /** 更多设置（品牌归属 / 别名 / 手动添加 / 已登记列表）是否展开。首屏默认收起。 */
  const [moreOpen, setMoreOpen] = useState(false);

  /**
   * 【0.21.17 · 老板第 6 条】「子品牌做的更加傻瓜式 一键式一点」。
   * 「⚡ 一键建档」= 搜一次 + 把搜到的**全部**未建档子品牌一次写入（一次用户点击 = 一次明确同意）。
   * 三个本地态只服务这一个按钮，不复用 searchState（那个是"搜索"按钮的状态机）。
   */
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickPhase, setQuickPhase] = useState(''); // '' | 'search' | 'build'
  const [quickMsg, setQuickMsg] = useState('');

  // ---- 品牌归属（母公司 / 旗下某个品牌）----
  // 老板砍掉首登 7 屏后，原「首登 Step5 品牌归属」的 UI 入口随之消失（数据能力仍在
  // companyKnowledgeStore.profile.brandType / brandParent）。此处补回最小编辑入口，
  // 复用 updateProfile，**不新增任何存储 key**。
  const [brandType, setBrandType] = useState('company'); // 'company'（母公司）| 'brand'（某个品牌）
  const [brandParent, setBrandParent] = useState(''); // 该品牌所属母公司（brandType==='brand' 时有效）
  useEffect(() => {
    const p = (knowledge && knowledge.profile) || {};
    setBrandType(p.brandType === 'brand' ? 'brand' : 'company');
    setBrandParent(String(p.brandParent || ''));
  }, [knowledge, companyId]);

  /** 选择归属类型；归属母公司时清空 brandParent（与旧 Onboarding Step5 的写入口径一致）。 */
  function chooseBrandType(v) {
    if (!companyId || disabled) return;
    setBrandType(v);
    updateProfile(companyId, {
      brandType: v,
      brandParent: v === 'brand' ? String(brandParent || '').trim() : '',
    });
  }

  /** 保存「所属母公司」文本（失焦 / 回车触发，避免每次击键写库）。 */
  function saveBrandParent() {
    if (!companyId || disabled || brandType !== 'brand') return;
    updateProfile(companyId, { brandType: 'brand', brandParent: String(brandParent || '').trim() });
  }

  /** 已登记名称（主品牌 + 别名 + 各 IP），用于判定「已建档」。 */
  const existingNames = useMemo(
    () => [mainName, ...mainAliases, ...ips.map((ip) => ip.name)].filter(Boolean),
    [mainName, mainAliases, ips],
  );

  /** 小写名称集合：判定候选行是否已建档（大小写不敏感，与 setBrandIps 的去重口径一致）。 */
  const existingKeySet = useMemo(
    () => new Set(existingNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean)),
    [existingNames],
  );

  /**
   * 检索「母品牌旗下有哪些子品牌」——**只取候选，不写库**。
   *
   * 从 doSearch 里抽出来的原因（0.21.17）：现在有「搜索」和「⚡ 一键建档」两个入口，
   * 取数口径（去重 / 排除母品牌自己 / 保留已建档行）必须只有一份。
   *
   * @param {string} name 母品牌名
   * @returns {Promise<{ok:boolean, error:string, candidates:Array<{name:string, note:string}>}>}
   */
  async function fetchCandidateNames(name) {
    let res = null;
    try {
      res = await webCandidateFn({ kind: 'brand', companyName: name });
    } catch {
      res = null;
    }
    const list = res && res.ok ? (Array.isArray(res.candidates) ? res.candidates : []) : [];
    // 母品牌自己不算「旗下子品牌」，其余原样保留（含已建档的，好让它们显示「已建档」）。
    const nameKey = String(name || '').toLowerCase();
    const cleaned = [];
    const seen = new Set();
    list.forEach((c) => {
      const nm = String((c && c.name) || '').trim();
      if (!nm) return;
      const k = nm.toLowerCase();
      if (k === nameKey || seen.has(k)) return;
      seen.add(k);
      cleaned.push({ name: nm, note: String((c && c.note) || '').trim() });
    });
    return {
      ok: !!(res && res.ok),
      error: String((res && res.error) || ''),
      candidates: cleaned,
    };
  }

  /**
   * 点「搜索」：让 AI 把母品牌旗下的子品牌列出来。
   *
   * 只调 `fetchCandidates`——**入参只有 companyName / kind 两个键**，
   * 底层就是 groundedSearch 真检索。返回的候选**只进组件 state**，绝不落库。
   * 失败与「真的没有」用同一个诚实错误态（共享知识 S5 第四句），**不编造任何名称**。
   */
  async function doSearch() {
    if (disabled || searchState === 'searching') return;
    const name = String(mainInput || mainName || '').trim();
    if (!name) {
      setCandidates([]);
      setSearchState('empty');
      return;
    }
    setSearchState('searching');
    setCandidates([]);
    setQuickMsg('');
    const r = await fetchCandidateNames(name);
    setCandidates(r.candidates);
    setSearchState(r.candidates.length > 0 ? 'done' : 'empty');
  }

  /**
   * 把一批子品牌写进品牌矩阵（批量版 buildOne）。
   *
   * 硬约束不变：只有用户真的按了「建档」或「⚡ 一键建档」才走到这里 —— 候选在此之前从不落库。
   * 幂等：同名（大小写不敏感）直接跳过；重复点「一键建档」不会重复登记。
   * 来源标注跟随联网探针（candidateSourceNote），绝不把模型候选谎称成「联网检索所得」。
   *
   * @param {string[]} names 要建档的子品牌名
   * @returns {number} 实际新增条数（0 = 全已存在）
   */
  function buildMany(names) {
    if (!companyId || disabled) return 0;
    const wanted = (Array.isArray(names) ? names : [])
      .map((n) => String(n || '').trim())
      .filter(Boolean);
    if (wanted.length === 0) return 0;
    const note = candidateSourceNote(getCachedWebSearchHealth(), true);
    const list = ips.slice();
    const seen = new Set(list.map((x) => String(x.name || '').trim().toLowerCase()).filter(Boolean));
    let added = 0;
    wanted.forEach((nm) => {
      const key = nm.toLowerCase();
      if (seen.has(key)) return; // 已存在 → 什么都不写（幂等）
      seen.add(key);
      list.push(
        normalizeBrandIp({
          name: nm,
          aliases: [],
          note,
          enabled: true,
          createdAt: Date.now(),
        }),
      );
      added += 1;
    });
    if (added > 0) setBrandIps(companyId, list);
    return added;
  }

  /**
   * 点某一行的「建档」：把**这一个**子品牌写进品牌矩阵。
   *
   * 硬约束：只有走到这里（用户真的按了「建档」）才 setBrandIps —— 候选在此之前从不落库。
   * 实现直接复用 buildMany（单元素批量），保证两条路径的规范化与去重口径完全一致。
   *
   * @param {string} name 子品牌名称（候选原文，不改写）
   */
  function buildOne(name) {
    buildMany([name]);
  }

  /**
   * 【0.21.17 · 老板第 6 条】「子品牌做的更加傻瓜式 一键式一点」—— **一键建档**。
   *
   * 改造前：点「搜索」→ 等到候选出来 → 一个一个点子品牌旁边的「建档」（五个品牌点五次）。
   * 现在一个按钮做完：**搜一次 → 把搜到的全部未建档子品牌一次写入**。
   *
   * 合规口径（与单条建档完全相同，一条没松）：
   *   · 这次点击本身就是用户的明确同意（不点永不落库，搜完不点 → 库里一条不多）；
   *   · 写入走同一个 `buildMany`（normalizeBrandIp + 小写去重 + 来源标注），幂等；
   *   · 搜索失败 / 真的没有 → 如实报错，**不编造任何名称**。
   */
  async function quickBuildAll() {
    if (disabled || !companyId || quickBusy) return;
    const name = String(mainInput || mainName || '').trim();
    if (!name) {
      setQuickMsg('⚠️ 先填一下母品牌名称');
      return;
    }
    setQuickBusy(true);
    setQuickMsg('');
    setQuickPhase('search');
    setSearchState('searching');
    setCandidates([]);

    const r = await fetchCandidateNames(name);
    setCandidates(r.candidates);
    setSearchState(r.candidates.length > 0 ? 'done' : 'empty');

    setQuickPhase('build');
    const added = buildMany(r.candidates.map((c) => c.name));
    setQuickPhase('');
    setQuickBusy(false);

    if (added > 0) {
      setQuickMsg(`✅ 已一键建档 ${added} 个子品牌（要改名 / 停用 / 删除，在下面「更多设置」里）`);
    } else if (r.candidates.length > 0) {
      setQuickMsg('这些子品牌都已建档，本次没有新增');
    } else {
      setQuickMsg(r.error ? `⚠️ ${r.error}` : '⚠️ 没搜到旗下子品牌，可以手动添加');
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setOpen(true);
  }

  function openEdit(ip) {
    setEditing(ip);
    setForm({
      name: ip.name || '',
      aliases: (ip.aliases || []).join('、'),
      note: ip.note || '',
    });
    setFormError('');
    setOpen(true);
  }

  function closeModal() {
    setOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError('');
  }

  function saveIp() {
    const name = String(form.name || '').trim();
    if (!name) {
      setFormError('请填写 IP / 子品牌名称');
      return;
    }
    const next = normalizeBrandIp({
      id: editing ? editing.id : '',
      name,
      aliases: parseAliasInput(form.aliases),
      note: String(form.note || '').trim(),
      enabled: editing ? editing.enabled !== false : true,
      createdAt: editing ? editing.createdAt : Date.now(),
    });

    const list = ips.slice();
    if (editing) {
      const idx = list.findIndex((x) => x.id === editing.id);
      if (idx >= 0) list[idx] = next;
      else list.push(next);
    } else {
      list.push(next);
    }
    setBrandIps(companyId, list);
    closeModal();
  }

  function removeIp(ip) {
    setBrandIps(companyId, ips.filter((x) => x.id !== ip.id));
  }

  function toggleIp(ip, checked) {
    setBrandIps(companyId, ips.map((x) => (x.id === ip.id ? { ...x, enabled: checked } : x)));
  }

  function openAlias() {
    setAliasText(mainAliases.join('、'));
    setAliasOpen(true);
  }

  function saveAlias() {
    setBrandMainAliases(companyId, parseAliasInput(aliasText));
    setAliasOpen(false);
  }

  /**
   * 把用户**勾选确认**的联网候选子品牌写入品牌矩阵（更多设置里的旧入口，能力保留）。
   *
   * 硬约束：只有走到这里（用户点了「确认添加选中」）才 setBrandIps；
   * 候选本身在此之前从不落库（合规红线 + onboarding-identity.mjs 场景C 负向断言依赖）。
   * 写入统一走 normalizeBrandIp 规范化，保证 id / enabled / createdAt 规格一致；
   * 已登记的同名候选（大小写不敏感）在这里再做一次去重，杜绝重复。
   * @param {string[]} names 用户确认的名称数组
   */
  function confirmWebCandidates(names) {
    if (!companyId) return;
    // 来源标注跟随联网探针：未确证联网时写「未联网 · 模型推断 / 模型分析（联网状态未确认）」，
    // 绝不把「用户确认过的模型候选」谎称成「联网检索所得」（数据来源诚实红线）。
    const note = candidateSourceNote(getCachedWebSearchHealth(), true);
    const list = ips.slice();
    const seen = new Set(list.map((x) => String(x.name || '').trim().toLowerCase()).filter(Boolean));
    (Array.isArray(names) ? names : []).forEach((nm) => {
      const name = String(nm || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push(
        normalizeBrandIp({
          name,
          note,
          enabled: true,
          createdAt: Date.now(),
        }),
      );
    });
    setBrandIps(companyId, list);
  }

  return (
    <div className="bip-wrap">
      {/* ==================== 首屏第 1 块：母品牌 ==================== */}
      <div className="bip-search-box">
        <div className="bip-search-hd">
          <span className="bip-search-title">母品牌</span>
          <span className="bip-search-hint" data-bip-main-label="1">
            现在按「{mainInput || mainName || '未填写'}」找它旗下的子品牌
          </span>
        </div>
        <div className="bip-search-row">
          <Input
            size="small"
            value={mainInput}
            disabled={disabled || !companyId}
            placeholder="填入母品牌名称，例如：康健苗苗"
            maxLength={60}
            data-bip-main-input="1"
            onChange={(e) => {
              setMainInput(e.target.value);
              // 母品牌名改了，上一轮的候选就过期了 —— 清掉，避免误点建档建到错的主体上。
              setSearchState('idle');
              setCandidates([]);
              // 「⚡ 一键建档」的结果提示同理：留着就是上一家的成绩，会骗人。
              setQuickMsg('');
            }}
            onPressEnter={doSearch}
          />
          {/* ==================== 首屏第 2 块：搜索 ==================== */}
          <Button
            size="small"
            type="primary"
            loading={searchState === 'searching'}
            disabled={disabled || !companyId || !String(mainInput || '').trim()}
            data-bip-search="1"
            onClick={doSearch}
          >
            搜索
          </Button>
          {/* 【0.21.17 · 老板第 6 条】「子品牌…傻瓜式 一键式一点」：
              一个按钮 = 搜一次 + 把搜到的全部未建档子品牌一次写入（不用一个一个点「建档」）。
              只在允许联网的场合出现（首登 Step5 传 enableWebSearch={false}，
              那一步自己要控制节奏，不在这里叠一个重复入口）。 */}
          {enableWebSearch ? (
            <Button
              size="small"
              loading={quickBusy}
              disabled={disabled || !companyId || !String(mainInput || '').trim()}
              data-bip-quick-build="1"
              onClick={quickBuildAll}
              title="一次做完：搜出旗下子品牌 → 全部登记进品牌矩阵（只写没建档的，可反复点）"
            >
              ⚡ 一键建档
            </Button>
          ) : null}
        </div>
        {quickPhase ? (
          <div className="bip-quick-steps" data-bip-quick-steps="1">
            <span className={'bip-quick-step' + (quickPhase === 'search' ? ' on' : ' done')}>
              {quickPhase === 'search' ? '●' : '✓'} ① 搜旗下子品牌
            </span>
            <span className={'bip-quick-step' + (quickPhase === 'build' ? ' on' : '')}>
              {quickPhase === 'build' ? '●' : '○'} ② 全部登记
            </span>
          </div>
        ) : null}
        {quickMsg ? (
          <div
            className={'bip-quick-msg' + (quickMsg.startsWith('✅') ? ' ok' : '')}
            data-bip-quick-msg="1"
          >
            {quickMsg}
          </div>
        ) : null}
      </div>

      {/* ==================== 首屏第 3 块：候选结果（每行一个「建档」） ==================== */}
      <div className="bip-results" data-bip-results="1">
        {searchState === 'idle' ? (
          <div className="bip-results-hint" data-bip-results-hint="1">
            点「搜索」，豆芽会去查「{mainInput || mainName || '这个母品牌'}」旗下有哪些子品牌。
          </div>
        ) : null}

        {searchState === 'searching' ? (
          <div className="bip-results-hint" data-bip-results-busy="1">正在找旗下的子品牌…</div>
        ) : null}

        {searchState === 'empty' ? (
          <div className="bip-results-empty" data-bip-results-empty="1">
            <span>没有找到子品牌，可以手动添加</span>
            <Button size="small" type="link" data-bip-open-more="1" onClick={() => setMoreOpen(true)}>
              去手动添加
            </Button>
          </div>
        ) : null}

        {searchState === 'done' && candidates.length > 0 ? (
          <div className="bip-cands">
            {candidates.map((c) => {
              const built = existingKeySet.has(c.name.toLowerCase());
              return (
                <div className="bip-cand" key={c.name} data-bip-cand="1">
                  <div className="bip-cand-info">
                    <span className="bip-cand-name" data-bip-cand-name="1">{c.name}</span>
                    {c.note ? <span className="bip-cand-note">{c.note}</span> : null}
                  </div>
                  <Button
                    size="small"
                    type={built ? 'default' : 'primary'}
                    disabled={built || disabled || !companyId}
                    data-bip-build={c.name}
                    onClick={() => buildOne(c.name)}
                  >
                    {built ? '已建档' : '建档'}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="bip-results-foot">
          已建档 {ips.length} 个
          <span className="bip-results-dot">·</span>
          建档只会在你点「建档」之后发生
        </div>
      </div>

      {/* ==================== 更多设置（首屏收起，能力全保留） ==================== */}
      <details className="bip-more" data-bip-more="1" open={moreOpen}>
        <summary
          className="bip-more-summary"
          onClick={(e) => {
            // 自己接管展开/收起：受控 `open` + 条件渲染，保证收起时这些入口**不在 DOM 里**
            // （首屏干净是老板的原话，也便于门禁直接断言「首屏没有这些锚点」）。
            e.preventDefault();
            setMoreOpen((v) => !v);
          }}
        >
          更多设置：品牌归属 · 主品牌别名 · 手动添加 · 旗下 IP / 子品牌（已登记 {ips.length} 个）
        </summary>

        {moreOpen ? (
          <div className="bip-more-body" data-bip-more-body="1">
            {/* ---------- 品牌归属（母公司 / 旗下某个品牌） ---------- */}
            <div className="bip-owner" data-bip-owner="1">
              <div className="bip-owner-label">品牌归属</div>
              <div className="bip-owner-choices">
                <button
                  type="button"
                  className={'bip-owner-choice' + (brandType === 'company' ? ' active' : '')}
                  disabled={disabled || !companyId}
                  onClick={() => chooseBrandType('company')}
                >
                  母公司 / 公司主体
                </button>
                <button
                  type="button"
                  className={'bip-owner-choice' + (brandType === 'brand' ? ' active' : '')}
                  disabled={disabled || !companyId}
                  onClick={() => chooseBrandType('brand')}
                >
                  旗下某个品牌
                </button>
              </div>
              {brandType === 'brand' ? (
                <div className="bip-owner-parent">
                  <Input
                    size="small"
                    value={brandParent}
                    disabled={disabled || !companyId}
                    onChange={(e) => setBrandParent(e.target.value)}
                    onBlur={saveBrandParent}
                    onPressEnter={saveBrandParent}
                    placeholder="所属母公司 / 集团名称（选填）"
                    maxLength={60}
                  />
                </div>
              ) : null}
              <div className="bip-help">你是公司主体，还是旗下某个品牌？这决定诊断盯谁。</div>
            </div>

            {/* ---------- 主品牌行 + 编辑别名 ---------- */}
            <div className="bip-row bip-row-main">
              <div className="bip-main-left">
                <Tag color="success" className="bip-kind-tag">主品牌</Tag>
                <span className="bip-name">{mainName || '（未设置，请先到资产库建档）'}</span>
                {mainAliases.map((a) => (
                  <Tag key={a} className="bip-alias-tag">{a}</Tag>
                ))}
              </div>
              <div className="bip-main-right">
                <Tooltip title="母公司名称是本轮扫描的固定监控对象，默认必选">
                  <Switch size="small" checked disabled={disabled} />
                </Tooltip>
                <Button
                  size="small"
                  type="text"
                  className="bip-link-btn"
                  disabled={disabled}
                  data-bip-alias="1"
                  onClick={openAlias}
                >
                  编辑别名
                </Button>
              </div>
            </div>

            {/* ---------- 旗下 IP / 子品牌（已登记列表） ---------- */}
            <div className="bip-sub-head">
              <span className="bip-sub-title">旗下 IP / 子品牌</span>
              <span className="bip-sub-count">已登记 {ips.length} 个</span>
            </div>

            {ips.length === 0 ? (
              <div className="bip-empty">
                <span className="bip-empty-text">还没登记旗下品牌。母公司口碑好，不代表它们没问题。</span>
                <Button size="small" type="primary" disabled={disabled} onClick={openCreate}>
                  + 添加第一个 IP
                </Button>
              </div>
            ) : (
              <div className="bip-list">
                {ips.map((ip) => (
                  <div className={`bip-row${ip.enabled === false ? ' bip-row-off' : ''}`} key={ip.id}>
                    <div className="bip-info">
                      <div className="bip-info-top">
                        <span className="bip-name">{ip.name}</span>
                        {(ip.aliases || []).map((a) => (
                          <Tag key={a} className="bip-alias-tag">{a}</Tag>
                        ))}
                      </div>
                      {ip.note ? <div className="bip-note">{ip.note}</div> : null}
                    </div>
                    <div className="bip-ops">
                      <Tooltip title={ip.enabled === false ? '已停用，不会参与扫描' : '参与本轮扫描'}>
                        <Switch size="small" checked={ip.enabled !== false} disabled={disabled} onChange={(c) => toggleIp(ip, c)} />
                      </Tooltip>
                      <Button size="small" type="text" className="bip-link-btn" disabled={disabled} onClick={() => openEdit(ip)}>
                        编辑
                      </Button>
                      <Popconfirm
                        title="删除这个 IP？"
                        description="删除后本轮扫描将不再监控它（可重新添加）。"
                        okText="确认删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => removeIp(ip)}
                      >
                        <Button size="small" type="text" danger disabled={disabled}>删除</Button>
                      </Popconfirm>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="bip-foot">
              <Button size="small" type="primary" ghost disabled={disabled} data-bip-add-manual="1" onClick={openCreate}>
                + 添加 IP
              </Button>
              <span className="bip-hint">把你旗下的每个品牌、产品线 IP 都登记起来，AI 会分别盯着它们的口碑。含子公司、关联公司、曾用名。</span>
            </div>

            {/* ---------- 联网勾选候选（旧入口，能力保留；候选不写库，勾选确认才落库） ---------- */}
            {enableWebSearch && !disabled ? (
              <div className="bip-web">
                <WebCandidatePicker
                  label="旗下 IP / 子品牌"
                  buttonText="🔍 联网找候选子品牌"
                  kind="brand"
                  companyName={mainName}
                  industry={industry}
                  existing={existingNames}
                  disabled={!mainName}
                  onConfirm={confirmWebCandidates}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </details>

      {/* ---------- IP 新增/编辑弹窗 ---------- */}
      <Modal
        title={editing ? '编辑旗下 IP' : '添加旗下 IP / 子品牌'}
        open={open}
        onCancel={closeModal}
        onOk={saveIp}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        maskClosable={false}
      >
        <div className="bip-modal">
          <div className="bip-field">
            <label className="bip-label">名称 *</label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如：上游货源"
              maxLength={40}
            />
            <div className="bip-help">含子公司、关联公司、曾用名 —— 登记进来，AI 才不会把它们当成同行。</div>
          </div>
          <div className="bip-field">
            <label className="bip-label">别名 / 其他叫法</label>
            <Input
              value={form.aliases}
              onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))}
              placeholder="用逗号或空格分隔，如：上游货源口腔 supplier-b"
              maxLength={200}
            />
            <div className="bip-help">同名实体很常见，填全别名能帮 AI 排除无关干扰。</div>
          </div>
          <div className="bip-field">
            <label className="bip-label">备注</label>
            <Input.TextArea
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="如：口腔 B2B 电商平台 supplier.example.com"
              rows={2}
              maxLength={200}
            />
          </div>
          {formError ? <div className="bip-error">⚠️ {formError}</div> : null}
        </div>
      </Modal>

      {/* ---------- 主品牌别名弹窗 ---------- */}
      <Modal
        title="主品牌别名"
        open={aliasOpen}
        onCancel={() => setAliasOpen(false)}
        onOk={saveAlias}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        maskClosable={false}
      >
        <div className="bip-modal">
          <div className="bip-field">
            <label className="bip-label">别名 / 其他叫法</label>
            <Input
              value={aliasText}
              onChange={(e) => setAliasText(e.target.value)}
              placeholder="用逗号或空格分隔，如：康健 HMD Dentech"
              maxLength={200}
            />
            <div className="bip-help">别名只用于帮助 AI 识别与去重，扫描时仍以主品牌名称为主关键词。</div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
