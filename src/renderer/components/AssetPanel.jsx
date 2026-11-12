import React, { useEffect, useState, useMemo } from 'react';
import { Button, Input, Tag, Empty } from 'antd';
import { geoProxy } from '../api.js';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompany, COMPANY_TYPE_KEYS } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useAssets, ASSET_TYPES } from '../store/assetStore.jsx';
import { companyTypeIcon, companyTypeLabel } from '../config/companyTypeConfig.js';
import { readCompanyRegion, buildRegionPatch } from '../services/companyRegion.js';
// Markdown → 纯文本的唯一真源（卡片预览切片前先剥标记，别把 `## ` 露给用户看）。
import { mdToPlain } from '../utils/mdToPlain.js';
import { analyzeCompany, analysisToFullAsset, buildAssetCoverage, findCompanyEntities } from '../services/companyProfile.js';
import WebCandidatePicker from './WebCandidatePicker.jsx';
import CompanyEntityPicker from './CompanyEntityPicker.jsx';
// 0.21.16（老板第 2 条）：企业建档改成**全屏分步引导**。
// 老的长表单**不删**（老板可能还想用），整块收进 `<details data-asset-advanced>`（「高级：直接填全部字段」）。
import CompanySetupWizard from './CompanySetupWizard.jsx';
// 本轮（0.21.14 需求 4）新样式的独立文件：只定义 `.asset-more*`，不往 6697 行的 style.css 里加规则。
import '../styles/asset-slim.css';

// 行业 / 目标人群：快速选择卡片（点击即填，输入框仍可自定义）
const INDUSTRY_QUICK = ['口腔医疗', '口腔器械', '口腔耗材', '医疗器械', '齿科连锁', '口腔保健', '医药健康', '医美'];
const AUDIENCE_QUICK = ['矫正人群', '种植需求人群', '儿童家长', '都市白领', '中老年人群', '诊所医生', '经销商渠道'];

/**
 * 【0.21.14 · 老板需求 4】「企业资产 企业大脑里面有一堆罗里吧嗦的东西 UI也是优化一下，
 * 可以有但有些不需要展示出来。干净一些。」
 *
 * 口径：首屏只露 **8 个字段**（下面是白名单，顺序固定），其余全部收进 `<details data-asset-more>`：
 *   companyName, industry, profile, products, coreSellingPoints, targetCustomers, competitors, brandTone
 *
 * ⚠️ **只折叠、不删数据**：折叠态下保存其它字段，隐藏字段的内容仍原样留在
 *    `localStorage['douya-marketing-assets'][cid]`（它们本来就是同一份 store 的字段，
 *    这里只是不渲染输入框，取数/写入逻辑一个字没改）。
 */
const VISIBLE_FIELD_KEYS = [
  'companyName',
  'industry',
  'profile',
  'products',
  'coreSellingPoints',
  'targetCustomers',
  'competitors',
  'brandTone',
];

/**
 * 数组字段：用可换行 TextArea 编辑，string↔string[] 自动转换。
 * web 标记 = 该字段启用「联网找候选」（kind 对应 services/webCandidates.js 的 WEB_CANDIDATE_KINDS）。
 * 只给**外部可检索的公开事实/实体**字段开启：
 *   competitors 竞品 / expertResources 医生专家 / successCases 成功案例 /
 *   coreSellingPoints 核心卖点 / customerPains 客户痛点 / targetCustomers 目标客户。
 * 明确不开启（企业内部规则，检索不出可信结果，硬加只会产生噪声）：
 *   contentTaboos 内容禁区 / complianceWords 合规词库 / brandFacts 品牌事实库。
 *
 * `more: true` = 收进 `data-asset-more` 折叠区（低频字段），false/缺省 = 首屏可见。
 */
const ARRAY_FIELDS = [
  { key: 'coreSellingPoints', label: '核心卖点', web: 'selling' },
  { key: 'targetCustomers', label: '目标客户', web: 'audience' },
  { key: 'competitors', label: '竞品', web: 'competitor' },
  { key: 'brandFacts', label: '品牌事实库', more: true },
  { key: 'expertResources', label: '医生专家资源', web: 'expert', more: true },
  { key: 'successCases', label: '成功案例', web: 'case', more: true },
  { key: 'customerPains', label: '客户痛点', web: 'pain', more: true },
  { key: 'contentTaboos', label: '内容禁区', more: true },
  { key: 'complianceWords', label: '合规词库', more: true },
];

const STRING_FIELDS = [
  { key: 'profile', label: '企业画像', rows: 3 },
  { key: 'products', label: '主要产品', rows: 3 },
  { key: 'brandTone', label: '品牌调性', rows: 2 },
  { key: 'marketingStrategy', label: '营销策略', rows: 3, more: true },
];

/**
 * 企业营销资产库：建档表单（5 最小字段）+「🔍 AI 识别（同名企业消歧）」+「🚀 一键完整建档」/「手动刷新」按钮 +
 * 13 字段查看/编辑。
 *
 * 建档口径（0.21.14 需求 4 起）：
 *   · 「一键完整建档」直接调 services/companyProfile（analyzeCompany + analysisToFullAsset）再用
 *     `updateAsset(patch)` **合并**落库 —— 因为它需要「只写有值的键 + 算已补齐/缺失清单」，
 *     而 store 的 `buildAsset` 是「全量覆盖 + 只返回 ok/degraded」（会把人工补的竞品/案例清空）。
 *   · store 的 `buildAsset` / `refreshAsset` 公开契约一个字未改；「手动刷新画像」仍走 `refreshAsset`。
 *
 * 0.21.16（老板第 2 条「做成跟 iphone 激活那样全屏一步步引导」）：
 *   · **推荐入口**改成「🧭 一步一步建档」，展开 `CompanySetupWizard`（全屏分步，见该组件头注释）；
 *   · 老的长表单**一个字段都没删**，整块收进 `details[data-asset-advanced]`（默认收起，
 *     但不做条件渲染 ⇒ 里面的节点仍在 DOM 里，老用例与老用户的路径都不受影响）；
 *   · 向导关闭后刷新一次口径不变（它写的就是同一份 store / localStorage）。
 *
 * @param {{wizardOpen?: boolean, onWizardOpenChange?: (open:boolean)=>void}} props
 *        `wizardOpen` 传入布尔值即为**受控**（企业大脑页从页头 CTA 打开用它）；
 *        不传则组件内部自管（App.jsx 的独立资产模块 / GoalGuide 里就是这样用的）。
 */
export default function AssetPanel({ wizardOpen: wizardOpenProp, onWizardOpenChange } = {}) {
  const { asset, hasAsset, status, error, refreshAsset, updateField, updateAsset, resetAsset } =
    useMarketingAsset();
  const { currentCompany, currentCompanyId, currentRole, currentProject, updateCompany } = useCompany();
  const { getKnowledge, updateProfile } = useCompanyKnowledge();
  const { listAssets, addAsset, removeAsset } = useAssets();

  /**
   * 建档向导的开关：受控 / 非受控两种用法（见组件头注释的 props 说明）。
   * 受控的原因：企业大脑页的「建档」CTA 在页头，向导本体挂在资产分区里 —— 需要一个共同的真源。
   */
  const wizardControlled = typeof wizardOpenProp === 'boolean';
  const [wizardOpenLocal, setWizardOpenLocal] = useState(false);
  const wizardOpen = wizardControlled ? wizardOpenProp : wizardOpenLocal;
  const setWizardOpen = (next) => {
    if (!wizardControlled) setWizardOpenLocal(next);
    if (typeof onWizardOpenChange === 'function') onWizardOpenChange(next);
  };

  const [form, setForm] = useState({
    companyName: asset.companyName || '',
    industry: asset.industry || '',
    brandDesc: asset.profile || '',
    products: asset.products || '',
    audience: (asset.targetCustomers || []).join('、'),
  });
  const [msg, setMsg] = useState('');
  const [uploading, setUploading] = useState(false);

  /**
   * 【0.21.14 · 需求 4-A】同名企业消歧的确认状态（受控，唯一真源在本组件）。
   *   pending   —— 还没确认是哪一家企业（**此状态下绝不建档**）
   *   confirmed —— 用户从「AI 识别」的候选里单选确认了某一家（联网检索候选）
   *   manual    —— AI / 联网不可用（或候选都不对），用户手填全称+地区（未联网确证）
   */
  const [entityState, setEntityState] = useState('pending');
  const [entityPick, setEntityPick] = useState(null); // { name, region, industry, brief, sourceUrl, verified, ... }
  const [busy, setBusy] = useState(false);            // 一键建档进行中（本地态，不污染 store 的 status）
  const [coverage, setCoverage] = useState(null);     // 「已补齐 N 项 / 缺 M 项」清单

  /**
   * 【0.21.17 · 老板第 6 条】「资产…做的更加傻瓜式 一键式一点」。
   * 一键入口的两个本地态（与「高级」里的老按钮**互不干扰**，各自有各自的消息位）：
   *   quickPhase —— '' | 'recognize'（在认企业主体）| 'build'（在联网补画像）
   *   quickMsg / quickCov —— 一键入口自己的结果提示与清单（老按钮的 msg/coverage 保持原样）
   */
  const [quickPhase, setQuickPhase] = useState('');
  const [quickMsg, setQuickMsg] = useState('');
  const [quickCov, setQuickCov] = useState(null);

  /**
   * 「高级：直接填全部字段」折叠区的展开态。
   * 受控是为了让「一键补齐」在**认不出唯一主体**时能把这块自动展开，
   * 把候选/手填口直接摆到用户眼前（不猜、也不让人翻半天找个入口）。
   * 收起时节点仍在 DOM 里（details 的既有行为），所以老用例与老路径不受影响。
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);

  /**
   * 「更多资料」折叠区是否展开。
   * 默认 false（首屏干净）；**用受控 open + 条件渲染**而不是「一直渲染只靠 CSS 藏起来」——
   * 这样收起时隐藏字段与项目文件卡**不在 DOM 里**（首屏 `[data-asset-file-card]` 必为 0），
   * 同时数据一条不丢（它们仍在 store / localStorage 里，展开即回来）。
   */
  const [moreOpen, setMoreOpen] = useState(false);

  // 「企业档案」编辑草稿（名称 / 类型 / 地区）。名称与类型属 companyStore 记录字段，
  // 地区属 companyKnowledgeStore.profile（region 不在 companyStore 的 7 字段白名单内）。
  const [profileDraft, setProfileDraft] = useState({ name: '', type: 'manufacturer', region: '' });
  const [profileMsg, setProfileMsg] = useState('');

  const isViewer = currentRole === 'viewer';

  /**
   * 建档的落点企业 id（与 companyStore 的「有效当前企业」同源）。
   * 【0.21.14 · 需求 4-B1 孤儿建档 bug 的修法】此前建档不校验它：
   * 首登/切空间时序里 currentCompanyId 可能还是 null，marketingStore 的效果函数会把资产
   * 写进 `localStorage['douya-marketing-assets']` 的 **"null" 键**，而知识库回流
   * `syncAssetToKnowledge(null, …)` 直接 return ⇒ 用户看到「✅ 建档成功」，但下游任何模块
   * 都读不到这份资产（等于没建档）。修法：建档前必须先有企业，没有就明确告知而不是静默写孤儿键。
   */
  const buildCompanyId = String(currentCompanyId || (currentCompany && currentCompany.id) || '');

  /**
   * 【0.21.14 · 需求 4-B2「没办法建档」bug 的修法】
   * ① 建档表单的「公司名称」过去只在 useState 初始化时从 `asset` 取一次 —— 资产为空时恒为 ''，
   *    于是「企业大脑里明明选中了『苗苗』（上面企业档案卡就写着苗苗），点 AI 深度建档却只弹
   *    ⚠️ 请填写公司名称」，一个请求都不发。用户视角就是「没办法建档」。
   * 修法：表单名称为空时用当前企业名回填（行业同理，从企业知识库的画像里取）。
   * 只在为空时回填 ⇒ 不会覆盖用户已经手打的内容。
   */
  useEffect(() => {
    const seedName = String((currentCompany && currentCompany.name) || '').trim();
    if (!seedName) return;
    const k = currentCompany ? getKnowledge(currentCompany.id) : null;
    const seedIndustry = String((k && k.profile && k.profile.industry) || '').trim();
    setForm((prev) => {
      const nameEmpty = !String(prev.companyName || '').trim();
      const industryEmpty = !String(prev.industry || '').trim();
      if (!nameEmpty && !(industryEmpty && seedIndustry)) return prev;
      return {
        ...prev,
        companyName: nameEmpty ? seedName : prev.companyName,
        industry: industryEmpty ? seedIndustry : prev.industry,
      };
    });
  }, [currentCompany, currentCompanyId, getKnowledge]);

  // 换企业 → 主体确认状态必须清零（否则会把 A 企业确认的主体带进 B 企业建档）。
  // 一键入口的三块提示同理：留着上一家企业的"已补齐 8 项"就是谎报。
  useEffect(() => {
    setEntityState('pending');
    setEntityPick(null);
    setCoverage(null);
    setMsg('');
    setQuickPhase('');
    setQuickMsg('');
    setQuickCov(null);
  }, [buildCompanyId]);

  // 当前企业切换 / 企业档案变化时，把落库值同步进草稿（避免草稿残留上一家企业）。
  useEffect(() => {
    if (!currentCompany) {
      setProfileDraft({ name: '', type: 'manufacturer', region: '' });
      return;
    }
    const k = getKnowledge(currentCompany.id);
    setProfileDraft({
      name: currentCompany.name || '',
      type: currentCompany.type || 'manufacturer',
      region: readCompanyRegion(k && k.profile),
    });
    setProfileMsg('');
  }, [currentCompanyId, currentCompany, getKnowledge]);

  /**
   * 保存企业档案。
   * ⚠️ 分流（T03-1 关键）：名称 / 类型走 `updateCompany`（两字段在 companyStore 白名单内）；
   *    **地区必须走 `updateProfile`** —— `region` 不在 companyStore 的 `normalizeCompany` 7 字段白名单里，
   *    若走 `updateCompany` 会被**静默丢弃**（编辑后丢，回归 E1）。镜像键随类型（clinic/doctor→city，其余→regions）
   *    由 `buildRegionPatch` 统一决定。
   */
  function saveCompanyProfile() {
    if (!currentCompany || isViewer) return;
    const name = (profileDraft.name || '').trim();
    if (!name) {
      setProfileMsg('⚠️ 企业名称不能为空');
      return;
    }
    const type = COMPANY_TYPE_KEYS.includes(profileDraft.type) ? profileDraft.type : 'manufacturer';
    updateCompany(currentCompany.id, { name, type });
    updateProfile(currentCompany.id, buildRegionPatch(profileDraft.region, type));
    setProfileMsg('✅ 企业档案已保存');
  }

  const analyzing = status === 'analyzing';

  // 当前企业的项目资产（卡片展示）
  const myAssets = useMemo(
    () => (currentCompany ? listAssets({ companyId: currentCompany.id }) : []),
    [listAssets, currentCompany],
  );

  // 「联网找候选」的检索上下文：企业名 + 行业（优先用资产库，回落到建档表单 / 当前企业）
  const pickerCompanyName = String(
    asset.companyName || (currentCompany && currentCompany.name) || form.companyName || '',
  ).trim();
  const pickerIndustry = String(asset.industry || form.industry || '').trim();

  /**
   * 把用户**确认**的联网候选**合并**进既有数组字段。
   * 合规要求：只由用户点「确认添加选中」触发（WebCandidatePicker 回调），绝不自动落库；
   * 合并而非覆盖 —— 保留用户已手打的内容，并按名称（大小写不敏感）去重。
   * @param {string} key 字段名（ARRAY_FIELDS 里的 key）
   * @param {string} label 字段中文名（用于提示文案）
   * @param {string[]} names 用户确认的候选名称
   */
  function confirmWebCandidates(key, label, names) {
    const cur = Array.isArray(asset[key]) ? asset[key].slice() : [];
    const seen = new Set(cur.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
    const merged = cur.slice();
    (Array.isArray(names) ? names : []).forEach((nm) => {
      const n = String(nm || '').trim();
      if (!n) return;
      const k = n.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      merged.push(n);
    });
    updateField(key, merged);
    const added = merged.length - cur.length;
    setMsg(added > 0 ? `✅ 已把 ${added} 条联网候选合并进「${label}」` : `⚠️ 这些候选已在「${label}」中，未重复添加`);
  }

  // 上传本地文件为项目资产：读文本后按文件名/内容存入（material 类型）
  async function uploadAssetFiles() {
    if (!currentCompany) {
      setMsg('⚠️ 请先选择/创建企业');
      return;
    }
    if (!window.api || !window.api.pickFiles || !window.api.readFileText) {
      setMsg('⚠️ 当前环境不支持文件上传');
      return;
    }
    let r;
    try {
      r = await window.api.pickFiles();
    } catch {
      setMsg('⚠️ 打开文件选择失败');
      return;
    }
    const paths = (r && r.filePaths) || [];
    if (!paths.length) return;
    setUploading(true);
    let added = 0;
    let skipped = 0;
    for (const p of paths) {
      const fr = await window.api.readFileText(p, 2 * 1024 * 1024);
      const name = (fr && fr.name) || p.split(/[\\/]/).pop() || '未命名';
      if (!fr || !fr.ok) {
        // 二进制/超大文件：仍登记为素材（保留路径），不读文本
        addAsset({
          type: 'material',
          companyId: currentCompany.id,
          projectId: currentProject ? currentProject.id : null,
          name,
          filePath: p,
          content: null,
          tags: ['上传素材'],
        });
        added++;
        continue;
      }
      const text = String(fr.content || '').trim();
      addAsset({
        type: 'material',
        companyId: currentCompany.id,
        projectId: currentProject ? currentProject.id : null,
        name,
        filePath: p,
        content: text ? text.slice(0, 20000) : null,
        tags: ['上传素材'],
      });
      added++;
    }
    setUploading(false);
    setMsg(added > 0 ? `✅ 已上传 ${added} 份文件为项目资产` : `⚠️ 未上传任何文件`);
  }

  function setFormField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // 目标人群多选：点击卡片切换（顿号拼接，回写 audience 字符串）
  function toggleAudience(o) {
    setForm((prev) => {
      const list = (prev.audience || '').split(/[、，,;\s]+/).filter(Boolean);
      const idx = list.indexOf(o);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(o);
      return { ...prev, audience: list.join('、') };
    });
  }

  /**
   * 用户从「AI 识别」的候选里单选确认了一家企业主体。
   * 只做三件事：① 记下确认的候选；② 把「全称 / 行业」回填进建档表单（消歧的价值就在这里 ——
   * 后续检索和下游画像用的是全称而不是「苗苗」两个字）；③ 地区写进企业档案。
   * **不写营销资产**（未确认前不落库的镜像面：确认了主体也还没有建档）。
   * @param {object} cand 选中候选
   */
  function onEntityConfirm(cand) {
    if (!cand || !cand.name) return;
    setEntityPick(cand);
    setEntityState('confirmed');
    setForm((prev) => ({
      ...prev,
      companyName: String(cand.name).trim(),
      industry: String(cand.industry || prev.industry || '').trim(),
    }));
    persistRegion(cand.region);
    setMsg(
      cand.verified
        ? `✅ 已确认企业主体：${cand.name}（来源 ${cand.sourceNote.replace(/^来源：/, '')}）→ 现在可以一键建档`
        : `✅ 已确认企业主体：${cand.name}（来源未确证，请核对全称）→ 现在可以一键建档`,
    );
  }

  /**
   * 降级路径：AI / 联网不可用时，用户手填全称（+ 地区）确认主体。
   * 必须放行 —— 老板要能建档，不能因为 AI 挂了就卡死；但建档记录必须如实标「未确证」。
   * @param {{name:string, region:string}} manual 手填内容
   */
  function onEntityManualConfirm(manual) {
    const name = String((manual && manual.name) || '').trim();
    if (!name) return;
    const cand = {
      name,
      region: String((manual && manual.region) || '').trim(),
      industry: '',
      brief: '',
      sourceUrl: '',
      sourceTitle: '',
      verified: false,
      sourceNote: '来源未确证（手动填写）',
      manual: true,
    };
    setEntityPick(cand);
    setEntityState('manual');
    setForm((prev) => ({ ...prev, companyName: name }));
    persistRegion(cand.region);
    setMsg(`✅ 已按手动填写的全称建档主体：${name}（未联网确证）→ 现在可以一键建档`);
  }

  /** 改选：回到未确认态（确认错了能退回，不会带着错的主体建档）。 */
  function onEntityReset() {
    setEntityState('pending');
    setEntityPick(null);
    setMsg('');
  }

  /**
   * 把确认到的地区写进企业档案（地区不在 companyStore 的 7 字段白名单里，必须走 companyKnowledge.profile）。
   * 只在用户确认过主体、且确实有地区时写；失败静默（不因为地区写失败挡住建档）。
   * @param {string} region 地区
   */
  function persistRegion(region) {
    const r = String(region || '').trim();
    if (!r || !buildCompanyId) return;
    const type = (currentCompany && currentCompany.type) || 'manufacturer';
    try {
      updateProfile(buildCompanyId, buildRegionPatch(r, type));
    } catch {
      /* 地区写失败不影响建档主流程 */
    }
  }

  /**
   * 【0.21.14 · 需求 4-C】一键全量建档。
   *
   * 老板原话：「确认完毕后才会建档，建档一键全部建掉，尽可能的完整」。
   * 因此这里做的是「一次点击 → 能拿到的 13 项画像全建掉 → 给出已补齐/缺失清单」，
   * 而不是让用户再填七八个表单。
   *
   * 与既有 `buildAsset`（marketingStore）的关系与取舍：
   *   · `buildAsset` 会把 `analysisToAsset` 的**全部 13 个键**合并进 store，空值会覆盖用户
   *     已经确认过的竞品/专家/案例（重新建档＝人工补的东西被抹掉），且它只返回 ok/degraded；
   *   · 本函数改用 `analysisToFullAsset`（只产出有值的键）+ `updateAsset(patch)`（合并语义），
   *     **可以反复点，越点越全，不会把已有内容冲掉**，并能算出缺失清单。
   *   · 不改 marketingStore 的公开契约（`buildAsset` / `refreshAsset` 一个字没动，
   *     「手动刷新画像」按钮仍然走 refreshAsset）。
   *
   * 失败绝不留死锁：任何异常都兜成「部分成功 + 原因」，保证 busy 一定复位、按钮一定能再点。
   */
  /**
   * 建档流水线的「干活」部分（不含前置校验与按钮态）。
   *
   * 【0.21.17 · 老板第 6 条】抽出来的原因：现在有**两个入口**（老的「🚀 一键完整建档」
   * 和新的「⚡ 一键补齐」）。取数、合并语义、清单口径只能有一份 —— 各写一遍迟早漂移
   * （一边改了合并策略、另一边还在覆盖用户手填的竞品）。两条入口现在都走这里。
   *
   * @param {object|null} pick 已确认的企业主体候选（可为空：空时 analysisToFullAsset 用输入名）
   * @param {'confirmed'|'manual'|'auto'} state 主体是"怎么确认的"（auto = 本次一键里自动认出）
   * @param {string} [nameOverride] 覆盖企业名（一键认主体后名字变了，但 `form` 的 setState 还没刷到闭包里）
   * @returns {Promise<{ok:boolean, msg:string, coverage:object|null, profile:boolean, source:string}>}
   */
  async function runBuildPipeline(pick, state, nameOverride) {
    const companyName = String(nameOverride || form.companyName || '').trim();
    if (!companyName) {
      return { ok: false, msg: '⚠️ 请填写公司名称', coverage: null, profile: false, source: '' };
    }

    const input = {
      companyName,
      industry: form.industry,
      brandDesc: form.brandDesc,
      products: form.products,
      audience: form.audience,
    };

    let ares;
    try {
      ares = await analyzeCompany(geoProxy, input);
    } catch (e) {
      ares = {
        ok: false, profile: null, error: '建档异常：' + ((e && e.message) || String(e)),
        degraded: true, grounded: false, source: '', provider: '', results: [], sources: [],
      };
    }

    const profile = ares && ares.ok && ares.profile ? ares.profile : null;
    const patch = analysisToFullAsset(profile, input, pick);
    const now = new Date().toISOString();
    patch.meta = {
      builtAt: now,
      analyzedAt: profile ? now : null,
      degraded: !profile,
      source: profile ? 'ai' : 'manual',
      // 「主体是怎么确认的」如实入档：AI 检索候选确认 / 手动填写未确证 / 一键里自动认出（auto）。
      entityConfirmed: state,
      entityName: String((pick && pick.name) || companyName),
      entityRegion: String((pick && pick.region) || ''),
      entityVerified: !!(pick && pick.verified),
      grounded: !!(ares && ares.grounded),
      sourceLabel: String((ares && ares.source) || ''),
    };

    // 合并语义：只写有值的键，不清空用户已确认/手填的其它字段。
    updateAsset(patch);

    // 清单按「合并后的完整资产」算，而不是按补丁算（否则永远显示缺一堆）。
    const merged = { ...asset, ...patch, meta: { ...((asset && asset.meta) || {}), ...patch.meta } };
    const cov = buildAssetCoverage(merged);
    setCoverage(cov);

    const head = profile
      ? '✅ 一键建档完成'
      : '⚠️ AI / 联网都不可用，已用手填信息建档（如实标为「未确证」）';
    const why = !profile && ares && ares.error ? `原因：${ares.error}。` : '';
    const src = ares && ares.source ? `来源：${ares.source}。` : '';
    return {
      ok: true,
      msg: `${head}${why}${src}${cov.text}`,
      coverage: cov,
      profile: !!profile,
      source: (ares && ares.source) || '',
    };
  }

  async function doBuild() {
    if (busy) return;
    if (!buildCompanyId) {
      setMsg('⚠️ 请先在「企业档案」里选择或创建一家企业 —— 建档要落到具体企业上，否则下游读不到');
      return;
    }
    const companyName = String(form.companyName || '').trim();
    if (!companyName) {
      setMsg('⚠️ 请填写公司名称');
      return;
    }
    if (entityState === 'pending') {
      setMsg('⚠️ 请先点「🔍 AI 识别」并确认到底是哪一家企业（或手动填写全称）—— 未确认不会建档');
      return;
    }

    setBusy(true);
    setMsg('');
    setCoverage(null);
    const r = await runBuildPipeline(entityPick, entityState);
    setMsg(r.msg);
    setBusy(false);
  }

  /**
   * 【0.21.17 · 老板第 6 条】「资产…做的更加傻瓜式 一键式一点」—— **一键补齐企业资产**。
   *
   * 改造前要建一次档，得按顺序点四处：填公司名 → 「🔍 AI 识别」→ 在候选里挑一家 →
   * 「🚀 一键完整建档」。老板的原话是「点一下就把事办了」，所以这里把整条链收进一个按钮：
   *
   *   ① **认主体**：调 `findCompanyEntities`（就是「🔍 AI 识别」用的**同一个**检索服务，
   *      没有新造接口、没有新提示词）；
   *      —— 只在**唯一确定**时才自动采用：候选只有一家，或只有一家"有网页出处"（verified）。
   *         两家都像 → **绝不猜**（随机挑一家就是老板最恨的"建错档"），
   *         自动展开「高级」把候选摆到眼前，一句话说清下一步点哪儿。
   *   ② **联网补画像**：`analyzeCompany` → `analysisToFullAsset` → `updateAsset(合并)`，
   *      所以可以反复点，越点越全，不会把手工补的竞品/案例冲掉。
   *   ③ **出清单**：`buildAssetCoverage` 的「已补齐 N / 缺 M」，与原按钮同一份口径。
   *
   * 合规：自动认出的主体在 `meta.entityConfirmed` 里如实写 `'auto'`，
   * 不伪装成"用户已确认"；未确证时不写库（走 ① 的分支直接 return）。
   */
  async function quickBuild() {
    if (busy) return;
    if (!buildCompanyId) {
      setQuickMsg('⚠️ 请先选择或创建一家企业 —— 建档要落到具体企业上，否则下游读不到');
      return;
    }
    const companyName = String(
      form.companyName || (currentCompany && currentCompany.name) || '',
    ).trim();
    if (!companyName) {
      setQuickMsg('⚠️ 请填写公司名称');
      return;
    }

    setBusy(true);
    setQuickMsg('');
    setQuickCov(null);
    setCoverage(null);
    setMsg('');

    let pick = entityPick;
    let state = entityState;
    let nameForBuild = companyName;

    if (state === 'pending') {
      setQuickPhase('recognize');
      let res = null;
      try {
        res = await findCompanyEntities({ companyName, industry: form.industry });
      } catch (e) {
        res = { ok: false, error: '检索异常：' + ((e && e.message) || String(e)), candidates: [] };
      }
      const cands = res && res.ok && Array.isArray(res.candidates) ? res.candidates : [];
      const verifiedOnly = cands.filter((c) => c && c.verified);
      const auto = verifiedOnly.length === 1 ? verifiedOnly[0] : (cands.length === 1 ? cands[0] : null);

      if (!auto) {
        setQuickPhase('');
        setBusy(false);
        // 不猜：把「高级」展开，候选/手填口就在眼前。
        setAdvancedOpen(true);
        setQuickMsg(
          cands.length > 1
            ? `⚠️ 搜到 ${cands.length} 家同名企业，豆芽不替你猜 —— 请在下面「🔍 AI 识别」里选一家，再点一次这个按钮。`
            : `⚠️ 没能认出明确的企业主体${res && res.error ? '（' + res.error + '）' : ''}。可在下面手动填全称，或直接用「🚀 一键完整建档」。`,
        );
        return;
      }

      pick = auto;
      state = 'auto';
      nameForBuild = String(auto.name || companyName).trim();
      setEntityPick(auto);
      setEntityState('confirmed'); // 让门禁 / 回显同步跟上（否则「一键完整建档」仍是灰的）
      setForm((prev) => ({
        ...prev,
        companyName: nameForBuild,
        industry: String(auto.industry || prev.industry || '').trim(),
      }));
      persistRegion(auto.region);
    }

    setQuickPhase('build');
    const r = await runBuildPipeline(pick, state, nameForBuild);
    setQuickPhase('');
    setQuickCov(r.coverage);
    setQuickMsg(r.msg);
    setBusy(false);
  }

  async function doRefresh() {
    setMsg('');
    const r = await refreshAsset();
    setMsg(r.ok ? '✅ 画像已刷新' : '⚠️ ' + (r.error || '刷新失败'));
  }

  /**
   * 渲染营销资产里的**一个**字段（文本字段 → TextArea；数组字段 → 联网找候选 + TextArea）。
   *
   * 抽成一个函数的目的：首屏 8 项与折叠区 6+1 项用的是**同一套**控件与写入口径，
   * 两处各写一遍迟早漂移（一边加了联网入口、一边没加）。取数写入仍走 `updateField`，一条没改。
   *
   * @param {string} key 字段名（STRING_FIELDS / ARRAY_FIELDS 里的 key）
   * @param {boolean} withAnchor true = 打上 `data-asset-field` 锚点（只有首屏那 8 个打）
   * @returns {React.ReactNode}
   */
  function renderAssetField(key, withAnchor) {
    const anchor = withAnchor ? { 'data-asset-field': key } : {};
    const strDef = STRING_FIELDS.find((f) => f.key === key);
    if (strDef) {
      return (
        <div className="xm-field" key={key}>
          <label className="field-label">{strDef.label}</label>
          <Input.TextArea
            value={asset[key] || ''}
            {...anchor}
            onChange={(e) => updateField(key, e.target.value)}
            rows={strDef.rows || 2}
          />
        </div>
      );
    }
    const arrDef = ARRAY_FIELDS.find((f) => f.key === key);
    if (!arrDef) return null;
    return (
      <div className="xm-field" key={key}>
        <label className="field-label">{arrDef.label}（每行一条）</label>
        {arrDef.web ? (
          <WebCandidatePicker
            label={arrDef.label}
            kind={arrDef.web}
            companyName={pickerCompanyName}
            industry={pickerIndustry}
            existing={Array.isArray(asset[key]) ? asset[key] : []}
            disabled={!pickerCompanyName}
            onConfirm={(names) => confirmWebCandidates(key, arrDef.label, names)}
          />
        ) : null}
        <Input.TextArea
          value={(asset[key] || []).join('\n')}
          {...anchor}
          onChange={(e) => updateField(key, e.target.value)}
          rows={2}
          placeholder="每行一条，可自由编辑"
        />
      </div>
    );
  }

  return (
    <div className="asset-panel" data-asset-root="1">
      <div className="asset-panel-head">
        <div>
          <h2 className="asset-panel-title">🗂 企业档案与物料资产</h2>
          <p className="asset-panel-sub">
            「你的企业资产库」的第一个分区：企业档案 + 物料文件。填一次，后面各处都不用再填。
          </p>
        </div>
        <div className="asset-panel-status">
          {hasAsset ? (
            <Tag color={status === 'degraded' ? 'orange' : 'green'}>
              {status === 'degraded' ? '已建档（AI 降级）' : '已建档'}
            </Tag>
          ) : (
            <Tag>未建档</Tag>
          )}
        </div>
      </div>

      {/* 【0.21.17 · 老板第 6 条】「资产…做的更加傻瓜式 一键式一点」—— 一键入口。
          一个按钮做完「认企业主体 → 联网补齐画像 → 出缺口清单」三件事，
          不用先填表、不用先点识别、不用在候选里挑（唯一的自动采用，不唯一的绝不猜）。
          下面「高级：直接填全部字段」里的老按钮与老表单**一个都没删**，只是让位。 */}
      <div className="asset-quick" data-asset-quick="1">
        <div className="asset-quick-body">
          <div className="asset-quick-title">⚡ 一键补齐企业资产</div>
          <div className="asset-quick-sub">
            {hasAsset
              ? '已建档。再点一次会重新联网核对并补齐缺口，不会清掉你手动补过的内容。'
              : '不用逐项填：豆芽先认出这是哪一家企业，再联网把能拿到的画像一次补齐，最后告诉你还缺什么。'}
          </div>
          {quickPhase ? (
            <div className="asset-quick-steps" data-asset-quick-steps="1">
              <span className={'asset-quick-step' + (quickPhase === 'recognize' ? ' on' : ' done')}>
                {quickPhase === 'recognize' ? '●' : '✓'} ① 认出企业主体（同名不猜）
              </span>
              <span className={'asset-quick-step' + (quickPhase === 'build' ? ' on' : '')}>
                {quickPhase === 'build' ? '●' : '○'} ② 联网补齐画像
              </span>
            </div>
          ) : null}
          {quickMsg && (
            <div
              className={quickMsg.startsWith('✅') ? 'xm-note' : 'xm-error'}
              data-asset-quick-msg="1"
              style={{ marginTop: 6 }}
            >
              {quickMsg}
            </div>
          )}
          {quickCov && (
            <div
              className="xm-note"
              data-asset-quick-coverage="1"
              data-asset-quick-filled={quickCov.filledCount}
              data-asset-quick-missing={quickCov.missingCount}
              style={{ marginTop: 6 }}
            >
              📋 已补齐 {quickCov.filledCount}/{quickCov.total} 项
              {quickCov.missingCount > 0
                ? `；还缺 ${quickCov.missingCount} 项：${quickCov.missing.map((f) => f.label).join('、')}（可再点一次，或到「高级」里手动补）`
                : '；没有缺失项'}
            </div>
          )}
        </div>
        <Button
          type="primary"
          data-asset-quick-build="1"
          loading={busy}
          disabled={isViewer || busy || !buildCompanyId}
          onClick={quickBuild}
          title={isViewer ? '查看角色只读，不能建档' : '一次做完：认出企业主体 → 联网补齐画像 → 出缺口清单'}
        >
          ⚡ 一键补齐
        </Button>
      </div>

      {/* 【0.21.16 · 老板第 2 条】推荐入口：全屏分步引导（iPhone 激活式，一次只问一件事）。
          老的长表单没有删，收在下面的「高级：直接填全部字段」里（老板可能还想用）。
          向导每次都从第 1 步开始（选身份 4 张卡），不会带上一次的半截草稿。 */}
      <div className="asset-wizard-entry" data-asset-wizard-entry="1">
        <div className="asset-wizard-entry-body">
          <div className="asset-wizard-entry-title">🧭 一步一步建档</div>
          <div className="asset-wizard-entry-sub">
            {hasAsset
              ? '已建档。想给另一家企业建档（或重走一遍），从这里开始：先选身份，再填最少的三两项。'
              : '不确定该填什么？从这一步开始：先选身份（诊所 / 经销商 / 厂家 / 平台），再一屏填一项，走完就建好了。'}
          </div>
        </div>
        <Button type="primary" data-asset-wizard-open="1" onClick={() => setWizardOpen(true)}>
          开始建档引导
        </Button>
      </div>

      {/* 企业档案（T03-1）：名称 / 类型 / 地区的唯一编辑入口。
          🔴 这里是 `doctor` 身份的唯一分流入口 —— 首登 4 张身份卡不含医生，用户选了「诊所 · 医生」后
          只能在这里把类型改成医生个人，否则医生身份永久不可达。类型选项取白名单 5 值（COMPANY_TYPE_KEYS）。 */}
      {currentCompany && (
        <div className="asset-form">
          <div className="asset-form-title">企业档案（名称 · 类型 · 地区）</div>
          <div className="xm-field">
            <label className="field-label">企业 / 品牌名称 *</label>
            <Input
              value={profileDraft.name}
              disabled={isViewer}
              onChange={(e) => setProfileDraft((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="企业或品牌名称"
            />
          </div>
          <div className="xm-field">
            <label className="field-label">企业类型</label>
            <div className="choice-row">
              {COMPANY_TYPE_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={isViewer}
                  className={'choice-chip' + (profileDraft.type === k ? ' active' : '')}
                  onClick={() => setProfileDraft((prev) => ({ ...prev, type: k }))}
                >
                  {companyTypeIcon(k)} {companyTypeLabel(k)}
                </button>
              ))}
            </div>
          </div>
          <div className="xm-field">
            <label className="field-label">所在地区</label>
            <Input
              value={profileDraft.region}
              disabled={isViewer}
              onChange={(e) => setProfileDraft((prev) => ({ ...prev, region: e.target.value }))}
              placeholder="门诊 / 医生填城市（如：杭州）；厂家 / 经销商 / 平台填区域（如：华东）"
            />
          </div>
          {isViewer ? (
            <div className="xm-note">查看角色只读，不能修改企业档案。</div>
          ) : (
            <div className="xm-actions">
              <Button type="primary" onClick={saveCompanyProfile} disabled={!(profileDraft.name || '').trim()}>
                保存企业档案
              </Button>
            </div>
          )}
          {profileMsg && (
            <div className={profileMsg.startsWith('✅') ? 'xm-note' : 'xm-error'}>{profileMsg}</div>
          )}
        </div>
      )}

      {/* 【0.21.16 · 老板第 2 条】老的长表单：**一个字段都没删**，只是收进折叠。
          ⚠️ 刻意**不用受控 open**：收起时里面的节点仍在 DOM 里，
          所以老用例（caseEntityDisambiguation / caseAssetSlim 按 data-asset-* 锚点取值与点击）
          与老用户的路径都不受影响 —— 这是「入口搬了家」，不是「功能没了」。

          🔴 但**全屏向导打开时整块让位**（`!wizardOpen` 才渲染），这不是省性能，是修一个真实缺陷：
          老表单里有一个 `CompanyEntityPicker`（`data-cep-search="1"`），向导第 2 步里也有一个 ——
          同一语义锚点在同一页出现两次时，**任何**按它做选择的代码/测试都会随机命中其中一个，
          而老表单那个在资产为空时自己是 `disabled`，命中了就等于点了个寂寞。
          （2026-10-20 实测：本仓的建档用例第一版全红在这，报错看着像产品 bug，其实是锚点撞了。）
          全屏接管期间老表单本来就被盖住、不可达，所以让它整块让位没有体验损失；
          关掉向导立刻回来（下面 ⑧ 类断言钉住"让位是临时的"）。
          ⚠️ 它自己的草稿状态（`form` / `entityState` / `entityPick`）都在 **AssetPanel** 这一层，
             不在这个子树里 ⇒ 让位不会丢失任何已填内容；只有 picker 内部的候选列表会重来一遍（可接受）。 */}
      {!wizardOpen && (
      <details className="asset-advanced" data-asset-advanced="1" open={advancedOpen}>
        {/* 展开/收起自己接管（与 .asset-more / .bip-more 同一套写法）：
            受控 open 才能让「⚡ 一键补齐」在认不出唯一主体时把这块自动摊开。
            ⚠️ 收起时里面的节点**仍在 DOM 里**（details 的固有行为），
            所以老用例（company-setup-wizard 读 details 里的 [data-asset-field]）
            与老用户路径都不受影响 —— 这是"入口还在原地、只是默认不展开"。 */}
        <summary
          className="asset-advanced-summary"
          data-asset-advanced-summary="1"
          onClick={(e) => {
            e.preventDefault();
            setAdvancedOpen((v) => !v);
          }}
        >
          高级：直接填全部字段（老方式，不走向导）
        </summary>

      {/* 建档表单（最小 5 字段） */}
      <div className="asset-form">
        <div className="asset-form-title">① 企业基础信息（建档）</div>
        <div className="xm-field">
          <label className="field-label">公司名称 *</label>
          <Input
            value={form.companyName}
            data-asset-field="companyName"
            onChange={(e) => setFormField('companyName', e.target.value)}
            placeholder="如：杭州某口腔医疗连锁"
          />
        </div>

        {/* 【0.21.14 · 需求 4-A】同名企业消歧：输入「苗苗」会出现很多苗苗企业，
            必须先由用户确认到底是哪一家 —— 未确认前**不会建档**（门禁在 doBuild 里）。
            候选来自真实检索（fetchWebSearch → 注入原文 → 模型抽结构化主体），
            每条带 全称 / 地区 / 行业 / 一句话简介 / 来源链接；AI 不可用时显式降级为手填全称+地区。 */}
        <CompanyEntityPicker
          companyName={form.companyName}
          industry={form.industry}
          confirmedName={entityPick ? entityPick.name : ''}
          state={entityState}
          onConfirm={onEntityConfirm}
          onManualConfirm={onEntityManualConfirm}
          onReset={onEntityReset}
          disabled={isViewer}
        />

        <div className="xm-field">
          <label className="field-label">所属行业</label>
          <div className="choice-row">
            {INDUSTRY_QUICK.map((o) => (
              <button
                key={o}
                type="button"
                className={'choice-chip' + (form.industry === o ? ' active' : '')}
                onClick={() => setFormField('industry', o)}
              >
                {o}
              </button>
            ))}
          </div>
          <Input
            value={form.industry}
            data-asset-field="industry"
            onChange={(e) => setFormField('industry', e.target.value)}
            placeholder="如：口腔医疗（点击上方快速选择，或手动输入）"
          />
        </div>
        <div className="xm-field">
          <label className="field-label">品牌简介 / 一句话介绍</label>
          <Input.TextArea
            value={form.brandDesc}
            onChange={(e) => setFormField('brandDesc', e.target.value)}
            rows={2}
            placeholder="一句话介绍你的品牌/公司（不填也行，AI 会去公开资料里找）"
          />
        </div>
        <div className="xm-field">
          <label className="field-label">核心产品 / 服务</label>
          <Input.TextArea
            value={form.products}
            onChange={(e) => setFormField('products', e.target.value)}
            rows={2}
            placeholder="主要卖什么 / 提供什么服务（不填也行，AI 会去公开资料里找）"
          />
        </div>
        <div className="xm-field">
          <label className="field-label">目标人群</label>
          <div className="choice-row">
            {AUDIENCE_QUICK.map((o) => {
              const selected = (form.audience || '').split(/[、，,;\s]+/).filter(Boolean).includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  className={'choice-chip' + (selected ? ' active' : '')}
                  onClick={() => toggleAudience(o)}
                >
                  {o}
                </button>
              );
            })}
          </div>
          <Input
            value={form.audience}
            onChange={(e) => setFormField('audience', e.target.value)}
            placeholder="如：25-45 岁都市白领、有牙齿矫正需求人群（点击上方快速选择，可多选）"
          />
        </div>
        <div className="xm-actions">
          <Button type="primary" onClick={doBuild} loading={busy} disabled={busy || entityState === 'pending'}>
            🚀 一键完整建档
          </Button>
          {entityState === 'pending' ? (
            <span className="xm-note" data-asset-build-gate="1">
              先点上面的「🔍 AI 识别」确认是哪一家企业（或改手动填写），确认后才建档。
            </span>
          ) : null}
          {hasAsset && (
            <Button onClick={doRefresh} loading={analyzing} disabled={analyzing || busy}>
              手动刷新画像
            </Button>
          )}
          {hasAsset && (
            <Button
              danger
              onClick={() => {
                if (confirm('确定清空企业营销资产吗？此操作不可撤销。')) {
                  resetAsset();
                  setForm({
                    companyName: '',
                    industry: '',
                    brandDesc: '',
                    products: '',
                    audience: '',
                  });
                  setEntityState('pending');
                  setEntityPick(null);
                  setCoverage(null);
                  setMsg('');
                }
              }}
            >
              清空资产
            </Button>
          )}
        </div>
        {busy && <div className="xm-note">⏳ 正在联网深度分析并一次性补齐画像，约 20-30 秒…</div>}
        {msg && <div className={msg.startsWith('✅') ? 'xm-note' : 'xm-error'} data-asset-build-msg="1">{msg}</div>}
        {/* 【需求 4-C】显式的「已补齐 / 缺失」清单：不允许只报一句「成功」就完事。 */}
        {coverage && (
          <div
            className="xm-note"
            data-asset-coverage="1"
            data-asset-coverage-filled={coverage.filledCount}
            data-asset-coverage-missing={coverage.missingCount}
          >
            📋 建档清单：已补齐 {coverage.filledCount}/{coverage.total} 项
            {coverage.filledCount > 0 ? `（${coverage.filled.map((f) => f.label).join('、')}）` : ''}
            {coverage.missingCount > 0
              ? `；还缺 ${coverage.missingCount} 项：${coverage.missing.map((f) => f.label).join('、')}（可手动补，或稍后点「手动刷新画像」再试）`
              : '；没有缺失项'}
          </div>
        )}
        {error && status !== 'analyzing' && !msg && <div className="xm-error">⚠️ {error}</div>}
      </div>
      </details>
      )}

      {!hasAsset && (
        <div className="asset-empty">
          {/* 0.21.17 收口：本条受 `unit-say-limit` 门禁约束（单文本节点 ≤70，按 `t.length` 计，
              emoji 算 2 字）。原句 87 字超限，砍到 44 字。
              「拿不到的会列成缺失清单」不再写在这里 —— 建档后由 `[data-asset-coverage]`
              自己讲「已补齐 N/13 … 还缺 M 项」，空态里重复一遍是冗余。 */}
          尚未建档。先「🔍 AI 识别」确认是哪一家企业，再「🚀 一键完整建档」自动补齐画像。
        </div>
      )}

      {/* ② 首屏只露 8 个字段（老板：「有些不需要展示出来。干净一些」）。
          公司名称与所属行业在上面的 ① 里（同一份数据，不重复渲染两遍）。
          **渲染顺序严格按白名单**（companyName → industry → profile → products →
          coreSellingPoints → targetCustomers → competitors → brandTone）：
          所以这里是「按 VISIBLE_FIELD_KEYS 逐项派发」，而不是「先排所有文本字段、再排所有数组字段」——
          后者会把 brandTone 排到 competitors 前面，页面上看是小事，门禁上就是「顺序不对」。 */}
      {hasAsset && (
        <div className="asset-form" data-asset-main="1">
          <div className="asset-form-title">② 营销资产（常用 8 项，改完即存）</div>
          {VISIBLE_FIELD_KEYS
            // companyName / industry 已由 ① 的两个输入框承载（带同一套 data-asset-field 锚点）
            .filter((k) => k !== 'companyName' && k !== 'industry')
            .map((k) => renderAssetField(k, true))}
        </div>
      )}

      {/* ③ 更多资料：低频字段 + 建档记录 + 项目资产文件，全部收进折叠（**只折叠不删**）。
          收起时这些节点不在 DOM 里（受控 open + 条件渲染），数据仍在
          localStorage['douya-marketing-assets'][cid]，展开即原样回来。 */}
      <details className="asset-more" data-asset-more="1" open={moreOpen}>
        <summary
          className="asset-more-summary"
          onClick={(e) => {
            e.preventDefault();
            setMoreOpen((v) => !v);
          }}
        >
          更多资料：不常用字段 · 建档记录 · 项目资产文件（{myAssets.length} 份）
        </summary>

        {moreOpen ? (
          <div className="asset-more-body" data-asset-more-body="1">
            {hasAsset ? (
              <div className="asset-form">
                <div className="asset-form-title">③ 不常用字段（改完即存，不影响上面的常用项）</div>
                {STRING_FIELDS.filter((f) => f.more).map((f) => renderAssetField(f.key, false))}
                {ARRAY_FIELDS.filter((f) => f.more).map((f) => renderAssetField(f.key, false))}
                <div className="xm-note" data-asset-meta="1">
                  建档情况：
                  {asset.meta && asset.meta.builtAt ? '已建档' : '未建档'}
                  {asset.meta && asset.meta.source === 'ai' ? ' · 豆芽联网整理' : ' · 手动填写'}
                  {asset.meta && asset.meta.degraded ? ' · AI 降级' : ''}
                  {asset.meta && asset.meta.analyzedAt ? ` · 最近更新 ${fmtAssetTime(asset.meta.analyzedAt)}` : ''}
                </div>
              </div>
            ) : null}

            {/* 项目资产文件（卡片 + 上传）——首屏不再占位，收进这里 */}
            <div className="asset-form">
              <div className="asset-form-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>项目资产文件（{myAssets.length} 份）</span>
                <Button size="small" type="primary" onClick={uploadAssetFiles} loading={uploading}>
                  📤 上传文件
                </Button>
              </div>
              {myAssets.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={<span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>暂无数据</span>}
                />
              ) : (
                <div className="asset-cards">
                  {myAssets.map((a) => (
                    <div className="asset-card" key={a.id} data-asset-file-card="1">
                      <div className="asset-card-type">{ASSET_TYPES[a.type] || a.type || '其他'}</div>
                      <div className="asset-card-name" title={a.name}>{a.name}</div>
                      <div className="asset-card-meta">
                        <span>{a.tags && a.tags.length ? a.tags.join(' · ') : '未分类'}</span>
                        <span>{fmtAssetTime(a.createdAt)}</span>
                      </div>
                      {a.filePath ? (
                        <div className="asset-card-path" title={a.filePath}>{a.filePath}</div>
                      ) : a.content ? (
                        // 先剥 Markdown 再切片：否则前 80 个字就是 `## 最终文章`，
                        // 用户报的「不要有 ## ** 这种没有意义的符号」在这里最刺眼。
                        <div className="asset-card-preview">{(() => { const p = mdToPlain(String(a.content)); return p.slice(0, 80) + (p.length > 80 ? '…' : ''); })()}</div>
                      ) : null}
                      <div className="asset-card-actions">
                        {a.filePath && <a className="asset-card-open" onClick={() => window.api && window.api.openPath && window.api.openPath(a.filePath)}>打开</a>}
                        <button className="asset-card-del" onClick={() => removeAsset(a.id)}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </details>

      {/* 【0.21.16 · 老板第 2 条】全屏分步建档向导。
          挂在本模块根节点（`.asset-panel[data-asset-root="1"]`）的**直接子节点**上 ——
          不用 antd Modal / Drawer / portal，所以它不是弹窗，不会被侧栏或横幅挤在中间；
          几何由组件内联样式 `position:fixed; inset:0` 负责（详见该组件头注释）。
          `open === false` 时组件返回 null ⇒ 平时 DOM 里没有这个节点，不占位、不抢焦点。 */}
      <CompanySetupWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onBuilt={() => {
          // 建档成功：面板头部「已建档」Tag / ② 资产区会自动跟着 store 变，这里只清掉临时提示。
          setMsg('');
        }}
      />
    </div>
  );
}

function fmtAssetTime(t) {
  if (!t) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
