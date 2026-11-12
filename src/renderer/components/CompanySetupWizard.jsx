import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { geoProxy } from '../api.js';
import { buildRegionPatch } from '../services/companyRegion.js';
import {
  analyzeCompany,
  analysisToFullAsset,
  buildAssetCoverage,
  findCompanyEntities,
} from '../services/companyProfile.js';
// 【0.21.27 · 老板 2026-11-10「企业建档做成一键」】判身份 / 拆子品牌 / 合并去重三件事抽成纯函数，
// 好处是能在 node 里逐条断言（见 scripts/smoke/unit-oneclick-setup.mjs）——
// 写在组件里就只能"点一遍看看"，而"点一遍"看不出「两个只差大小写的子品牌被写进两条」。
import {
  ONECLICK_TYPE_LABELS,
  inferCompanyType,
  mergeBrandIps,
  parseSubBrands,
  summarizeOneClick,
} from '../services/oneClickSetup.js';
import CompanyEntityPicker from './CompanyEntityPicker.jsx';
// 本轮（0.21.16 · 老板第 2 条）新增样式：独立文件、统一 `csw-` 前缀，
// 视觉语言照 style.css 里首登用的 `.ob-*`（同圆角 / 同绿色强调 / 同卡片质感）。
import '../styles/setup-wizard.css';
// 【0.21.27】一键建档面板单独一个样式文件，理由写在该文件头部：
// 往 setup-wizard.css 里加带色规则会让 `unit-theme-cover-group-b` 的断言 E2 当场判红
// （它守的是「20 个受管文件批量换色时没多换/少换」，不接受任何新增色位）。
import '../styles/oneclick-setup.css';

/**
 * CompanySetupWizard —— **企业建档全屏分步引导**（老板第 2 条，最重要的一条）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 老板原话
 * ────────────────────────────────────────────────────────────────────────────
 * 「现在企业建档 能不能行啊？而且这个企业建档很重要 我建议是做成跟 iphone 刚刚激活时候
 *   那样子全屏的一步步引导用户去完成这个建档的，比如第一步选择你的信息 四个卡片
 *   你是诊所 经销商 厂家 平台  第二步 如果是诊所 就让他填写诊所的地址 主要接诊什么类目
 *   诊所的名字。」
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 落地口径（一条一条对着老板的话做）
 * ────────────────────────────────────────────────────────────────────────────
 *   · **全屏**：根节点 `data-csw="1"` 的几何是**内联样式** `position:fixed; inset:0`
 *     （jsdom 不跑 layout，但内联样式读得到 —— 所以在样式表里写 fixed 等于门禁量不到）。
 *     它**不是**弹窗：不用 antd Modal / Drawer / portal，DOM 里就是企业大脑模块的**直接子节点**
 *     （父级是 `[data-asset-root="1"]`），所以不会被侧栏 / 横幅挤在中间。
 *   · **一次只问一件事**：第 1 步只选身份（4 张卡），第 2 步只填身份对应的那几个字段，
 *     第 3 步只给结果与「还缺什么」。顶部有进度点，底部「上一步 / 下一步」。
 *   · **4 张身份卡顺序 = 老板给的顺序**：诊所 → 经销商 → 厂家 → 平台（见 SETUP_TYPE_ORDER）。
 *     卡片整块可点、选中态明显（`.csw-card.on`），并且**键盘可操作**（原生 button + 显式
 *     Enter/Space 处理：jsdom 不会把 keydown 自动变成 click，所以这里必须自己接）。
 *   · **第二步按第一步分叉**：SETUP_TYPES 里每种身份有自己的字段清单，
 *     不是「同一张表单换个标题」（渲染走 `def.fields`，断言按 `data-csw-field-key` 集合比）。
 *   · **公司名不能跳过**，其余字段一律有「跳过，稍后在企业大脑里补」的出口。
 *   · **必须真的建出档来**：老板说「现在是没办法建档的 有bug」——
 *     所以本组件走的是**已验证能落库的那条链路**（companyStore.createCompany / updateCompany
 *     + companyKnowledgeStore.updateProfile + marketingStore.updateAsset），
 *     并显式处理「切换企业会把刚写的资产冲掉」这个时序坑（见 pendingJob / armed 两段式）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么落库要绕两段式（pendingJob → armed）
 * ────────────────────────────────────────────────────────────────────────────
 * `createCompany()` 会把 currentCompanyId 切到新企业；`MarketingProvider` 有一个
 * `useEffect(..., [currentCompanyId])` 的「切企业 → 重新 loadAssetFor()」逻辑。
 * React 的 effect 是**子先父后**：本组件（子）在同一个 commit 里调 `updateAsset()`，
 * 紧接着父 Provider 的 effect 又会 `setAsset(loadAssetFor(newId))` 把刚写的补丁盖成空资产
 * —— 用户就会看到「建档成功」但库里什么都没有（这正是老板说的「没办法建档」的同族 bug）。
 * 所以：先 `setPendingJob`，等 `currentCompanyId` 与目标企业一致后**再置 armed**，
 * armed 的 effect 在**下一轮提交**才真正写库 —— 那时 Provider 的资产重置已经跑完了。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 红线（与全仓一致）
 * ────────────────────────────────────────────────────────────────────────────
 *   · **不编造**：本组件**不调 AI**、不生成任何经营范围 / 简介 / 卖点。
 *     用户填什么写什么，没拿到的字段一律留空并在第 3 步明确标「待补充」。
 *   · 未确认企业主体（同名消歧）不许建档：门禁在 `finalize()` 里，与 AssetPanel 同一口径。
 *   · 只写「有值」的键：空字符串 / 空数组不往库里面塞，避免把别处补好的资料冲成空。
 *
 * @param {object} props
 * @param {boolean} props.open 是否展开（false 时**不渲染任何节点**，不留空壳）
 * @param {() => void} [props.onClose] 关闭（「稍后再说」/ 完成后的「去企业大脑看看」）
 * @param {(info:{companyId:string,name:string,type:string})=>void} [props.onBuilt] 建档成功回调
 * @returns {JSX.Element|null}
 */

/**
 * 4 张身份卡的**展示顺序**（老板逐字给的顺序：诊所 → 经销商 → 厂家 → 平台）。
 * ⚠️ 刻意**不用** companyTypeConfig.FIRST_RUN_TYPE_KEYS（那份是首登顺序 厂家/诊所/经销商/平台）：
 *    首登与这里入口不同、老板这次的顺序要求也不同，复用会让两处互相牵制。
 */
export const SETUP_TYPE_ORDER = ['clinic', 'dealer', 'manufacturer', 'platform'];

/**
 * 每种身份的**第二步字段清单**（这一步就是「分支」本身）。
 *
 * 字段项约定：
 *   · key      —— 表单内部 key，同时是 DOM 锚点 `data-csw-field-key`
 *   · label    —— 字段名（老板只给了诊所的三项，其余三种按业务合理性设计）
 *   · kind     —— 'text'（antd Input）| 'tags'（多选标签）
 *   · profile  —— 落到 companyKnowledgeStore.profile 的哪个键（沿用 onboardingFields 的历史口径）
 *   · asset    —— （可选）同时镜像进 marketingStore 的哪个键
 *   · region   —— （可选）true = 这是「地区」类字段，必须经 buildRegionPatch 写规范 key + 镜像 key
 *
 * 为什么 region 单列：`companyStore.updateCompany` 只保留 7 个白名单字段，
 * `region` 写进去会被**静默丢弃**（见 services/companyRegion.js 的落库红线 E1）。
 */
export const SETUP_TYPES = {
  clinic: {
    key: 'clinic',
    label: '诊所',
    icon: '🦷',
    companyType: 'clinic',
    cardDesc: '口腔医院 / 连锁 / 单体门诊，或医生个人接诊',
    title: '先说说你的诊所',
    nameLabel: '诊所名字',
    namePlaceholder: '例如：康健苗苗口腔门诊',
    fields: [
      { key: 'address', label: '诊所地址', kind: 'text', profile: 'address', placeholder: '例如：杭州市西湖区文三路 100 号' },
      {
        key: 'categories',
        label: '主要接诊类目',
        kind: 'tags',
        profile: 'coreProjects',
        // 老板原话「主要接诊什么类目」——给常见六类做多选，点一下即可，不用手打。
        options: ['种植', '正畸', '修复', '儿牙', '牙周', '综合'],
        hint: '可多选；不确定就跳过，之后在企业大脑里补',
      },
    ],
  },
  dealer: {
    key: 'dealer',
    label: '经销商',
    icon: '🚚',
    companyType: 'dealer',
    cardDesc: '拿厂家的货做区域分销 / 二批，要拓店、走量、管渠道',
    title: '先说说你的公司',
    nameLabel: '公司名',
    namePlaceholder: '例如：杭州某某医疗器械有限公司',
    fields: [
      { key: 'region', label: '所在地区', kind: 'text', region: true, profile: 'region', placeholder: '例如：浙江 / 华东' },
      { key: 'categories', label: '主营品类', kind: 'text', profile: 'products', asset: 'products', placeholder: '例如：种植体、正畸耗材、机扩设备' },
      { key: 'coverage', label: '覆盖区域', kind: 'text', profile: 'market', placeholder: '例如：浙江、江苏、上海' },
    ],
  },
  manufacturer: {
    key: 'manufacturer',
    label: '厂家',
    icon: '🏭',
    companyType: 'manufacturer',
    cardDesc: '生产或总代口腔设备 / 材料 / 器械 / 种植体 / 正畸',
    title: '先说说你的公司',
    nameLabel: '公司名',
    namePlaceholder: '例如：康健苗苗集团',
    fields: [
      { key: 'region', label: '所在地区', kind: 'text', region: true, profile: 'region', placeholder: '例如：浙江 / 华东' },
      { key: 'productLines', label: '主营产品线', kind: 'text', profile: 'products', asset: 'products', placeholder: '例如：种植体、机扩马达、K 锉' },
      { key: 'recruitRegion', label: '招商区域', kind: 'text', profile: 'market', placeholder: '例如：华东、华南（要招代理的区域）' },
    ],
  },
  platform: {
    key: 'platform',
    label: '平台',
    icon: '🌐',
    companyType: 'platform',
    cardDesc: '口腔 SaaS / 供应链集采 / 诊所服务商 / 行业媒体会展',
    title: '先说说你的平台',
    nameLabel: '公司名',
    namePlaceholder: '例如：康健苗苗口腔平台',
    fields: [
      { key: 'platformType', label: '平台类型', kind: 'text', profile: 'platformType', placeholder: '例如：口腔 SaaS / 耗材供应链' },
      { key: 'coverage', label: '覆盖范围', kind: 'text', profile: 'coverCities', placeholder: '例如：华东 12 城 / 全国' },
    ],
  },
};

/** 步骤总数（1 选身份 / 2 填信息 / 3 完成）——进度点数量与文案共用同一个常量，不允许两处各写一遍。 */
export const SETUP_STEP_COUNT = 3;

const STEP_TITLES = {
  1: '你现在是？',
  2: '',
  3: '建档完成',
};

/**
 * 把一步的表单值整理成「知识库 profile 补丁」。
 * 只写有值的键（空串 / 空数组不写），避免把别处补好的资料冲成空。
 *
 * @param {object} def SETUP_TYPES 里的身份定义
 * @param {object} form 当前表单值
 * @param {object|null} entity 已确认的企业主体候选
 * @param {'confirmed'|'manual'|'pending'} entityState 主体确认状态
 * @param {string} at ISO 时间戳
 * @returns {object} profile 补丁
 */
export function buildSetupProfilePatch(def, form, entity, entityState, at) {
  const d = def && typeof def === 'object' ? def : null;
  const f = form && typeof form === 'object' ? form : {};
  const patch = {};
  if (!d) return patch;

  const fields = Array.isArray(d.fields) ? d.fields : [];
  let hasRegionField = false;
  for (const fd of fields) {
    if (!fd || !fd.key) continue;
    const raw = f[fd.key];
    if (fd.region) {
      const v = String(raw == null ? '' : raw).trim();
      if (v) {
        Object.assign(patch, buildRegionPatch(v, d.companyType));
        hasRegionField = true;
      }
      continue;
    }
    if (fd.kind === 'tags') {
      const list = (Array.isArray(raw) ? raw : []).map((x) => String(x || '').trim()).filter(Boolean);
      if (list.length && fd.profile) patch[fd.profile] = list;
      continue;
    }
    const str = String(raw == null ? '' : raw).trim();
    if (str && fd.profile) patch[fd.profile] = str;
  }

  // 该身份没有「地区」字段（例如诊所只问地址）时，也不丢消歧确认阶段拿到的地区。
  if (!hasRegionField) {
    const entRegion = String((entity && entity.region) || '').trim();
    if (entRegion) Object.assign(patch, buildRegionPatch(entRegion, d.companyType));
  }

  // 建档记录（诚实口径）：这一步是「用户手填」，没有任何 AI 生成内容。
  patch.setup = {
    wizard: true,
    at: String(at || ''),
    type: String(d.companyType || ''),
    entityConfirmed: entityState === 'confirmed' ? 'confirmed' : entityState === 'manual' ? 'manual' : 'pending',
    entityName: String((entity && entity.name) || ''),
    entityRegion: String((entity && entity.region) || ''),
    entityVerified: !!(entity && entity.verified),
  };
  return patch;
}

/**
 * 把一步的表单值整理成「营销资产补丁」。
 * 只写 companyName + （用户真填了的）products + meta；其余 13 项一律留空 ⇒ 第 3 步显式标「待补充」。
 *
 * @param {object} def 身份定义
 * @param {string} companyName 已确认的企业名 / 公司名
 * @param {object} form 表单值
 * @param {object|null} entity 已确认主体
 * @param {'confirmed'|'manual'|'pending'} entityState 主体状态
 * @param {string} at ISO 时间戳
 * @returns {object} 资产补丁
 */
export function buildSetupAssetPatch(def, companyName, form, entity, entityState, at) {
  const d = def && typeof def === 'object' ? def : null;
  const f = form && typeof form === 'object' ? form : {};
  const name = String(companyName || '').trim();
  const patch = {};
  if (name) patch.companyName = name;

  // 用户真填了「主营品类 / 主营产品线」就镜像进 asset.products。
  // ⚠️ 必须镜像：marketingStore 落库后 `syncAssetToKnowledge` 会用 asset 的
  //    products/industry/profile 等白名单字段**覆盖** knowledge.profile 的同名键，
  //    只写 profile 不写 asset ⇒ 刚填的产品线会被下一拍冲成空串（静默丢数据）。
  const fields = d && Array.isArray(d.fields) ? d.fields : [];
  for (const fd of fields) {
    if (!fd || !fd.asset) continue;
    const v = String(f[fd.key] == null ? '' : f[fd.key]).trim();
    if (v) patch[fd.asset] = v;
  }

  patch.meta = {
    builtAt: String(at || ''),
    analyzedAt: null,
    // 如实标降级：这一步没有 AI 参与，所有字段都是用户手填。
    degraded: true,
    source: 'manual',
    setupWizard: true,
    entityConfirmed: entityState === 'confirmed' ? 'confirmed' : entityState === 'manual' ? 'manual' : 'pending',
    entityName: String((entity && entity.name) || name),
    entityRegion: String((entity && entity.region) || ''),
    entityVerified: !!(entity && entity.verified),
  };
  return patch;
}

export default function CompanySetupWizard({ open = false, onClose, onBuilt }) {
  const { currentCompany, currentCompanyId, createCompany, updateCompany } = useCompany();
  const { updateProfile, getBrandIps, setBrandIps } = useCompanyKnowledge();
  const { asset, updateAsset } = useMarketingAsset();

  const [step, setStep] = useState(1);
  const [typeKey, setTypeKey] = useState('');
  const [form, setForm] = useState({});
  const [err, setErr] = useState('');
  /** 同名消歧状态（受控，唯一真源在本组件；pending 时绝不建档）。 */
  const [entityState, setEntityState] = useState('pending');
  const [entityPick, setEntityPick] = useState(null);
  /** 待落库任务（两段式的第一段，见文件头注释）。 */
  const [pendingJob, setPendingJob] = useState(null);
  const [armed, setArmed] = useState(false);
  const [built, setBuilt] = useState(null);
  const [busy, setBusy] = useState(false);

  /**
   * 【0.21.27 · 老板 2026-11-10「企业建档做成一键」】
   * 「输入一下公司名称 子品牌 建档一键全部搞定」—— 一个输入框 + 一个按钮，不再点五处。
   *
   * 这五个本地态只服务这一块，**不复用**向导自己的 form/typeKey：
   *   老的分步路径一行没改（4 张卡 → 字段 → 完成），这条是并排的第二条入口。
   *   为什么不把老路径删掉：老路径的下游字段更多（地址 / 接诊类目 / 招商区域），
   *   有人就是愿意多填几个字段换更准的画像 —— 一键是"少点几下"，不该以砍功能为代价。
   */
  const [quickName, setQuickName] = useState('');
  const [quickSubs, setQuickSubs] = useState('');
  /** 用户手动改过的身份（'' = 跟随推断）。改过就不再被推断覆盖。 */
  const [quickType, setQuickType] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickPhase, setQuickPhase] = useState('');
  const [quickMsg, setQuickMsg] = useState('');
  const [quickReport, setQuickReport] = useState('');

  /** 最新回调引用：避免 effect 依赖随父组件 re-render 抖动。 */
  const onBuiltRef = useRef(onBuilt);
  useEffect(() => {
    onBuiltRef.current = onBuilt;
  }, [onBuilt]);

  // 每次「打开」都从第 1 步重新开始（不复用上一次的半截草稿，避免把 A 企业填的内容带进 B）。
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setTypeKey('');
    setForm({});
    setErr('');
    setEntityState('pending');
    setEntityPick(null);
    setPendingJob(null);
    setArmed(false);
    setBuilt(null);
    setBusy(false);
    setQuickName('');
    setQuickSubs('');
    setQuickType('');
    setQuickBusy(false);
    setQuickPhase('');
    setQuickMsg('');
    setQuickReport('');
  }, [open]);

  const def = typeKey && SETUP_TYPES[typeKey] ? SETUP_TYPES[typeKey] : null;
  const companyName = String(form.name || '').trim();

  /** 目标企业 id（与 companyStore 的「有效当前企业」同源）。 */
  const currentId = String(currentCompanyId || (currentCompany && currentCompany.id) || '');

  /**
   * 真正落库（两段式的第二段）。
   * 只做三件事：写知识库 profile（地址 / 地区 / 类目）、写营销资产（企业名 + 产品线 + 建档记录）、
   * 推进到第 3 步。任何一项失败都不静默 —— 但这里都是同步 setState，不会抛。
   */
  const applyBuild = useCallback(
    (job) => {
      if (!job || !job.cid) return;
      updateProfile(job.cid, job.payload.profile);
      updateAsset(job.payload.asset);

      /**
       * 【0.21.27】子品牌也在这里写，理由与「两段式」同源：
       * `createCompany()` 切企业之后，companyKnowledge Provider 也会重载该企业的 profile；
       * 在同一拍写 brandIps，会被随后的重载盖成空列表（用户看到"子品牌 0 个"）。
       * 所以写入点必须晚于切企业那一拍 —— 而这里是整个流程里**最晚**的那一拍。
       *
       * 幂等由 `mergeBrandIps` 保证：已登记的同名（大小写不敏感）跳过，重复点一键不会重复登记。
       */
      let brandsAdded = 0;
      let brandsTotal = 0;
      if (job.brands && Array.isArray(job.brands.names) && job.brands.names.length) {
        const cur = getBrandIps(job.cid);
        const merged = mergeBrandIps(cur, job.brands.names, job.brands.note);
        brandsAdded = merged.added;
        brandsTotal = merged.list.length;
        if (merged.added > 0) setBrandIps(job.cid, merged.list);
      } else {
        brandsTotal = getBrandIps(job.cid).length;
      }

      setBuilt({ companyId: job.cid, name: job.name, type: job.type, reused: !!job.reused });
      // 一键路径才出成绩单；老的分步路径仍然是第 3 步那块 coverage（口径不变）。
      setQuickReport(
        job.quick
          ? summarizeOneClick({
              companyName: job.name,
              typeLabel: ONECLICK_TYPE_LABELS[job.type] || job.type,
              reused: !!job.reused,
              profileOk: !!job.quick.profileOk,
              brandsAdded,
              brandsTotal,
              coverageFilled: job.quick.filled,
              coverageTotal: job.quick.total,
            })
          : '',
      );
      setBusy(false);
      setQuickBusy(false);
      setQuickPhase('');
      setStep(3);
      if (typeof onBuiltRef.current === 'function') {
        onBuiltRef.current({ companyId: job.cid, name: job.name, type: job.type });
      }
    },
    [updateProfile, updateAsset, getBrandIps, setBrandIps],
  );

  // 第一段：目标企业就位后才 arm（切企业那一拍的资产重置已经发生在这个 commit 里）。
  useEffect(() => {
    if (!pendingJob) return;
    if (!currentId) return;
    if (currentId !== pendingJob.cid) return;
    setArmed(true);
  }, [pendingJob, currentId]);

  // 第二段：armed 之后写库。这里刻意不在同一拍做，见文件头「两段式」注释。
  useEffect(() => {
    if (!armed || !pendingJob) return;
    applyBuild(pendingJob);
    setArmed(false);
    setPendingJob(null);
  }, [armed, pendingJob, applyBuild]);

  /** 第 3 步的「已补齐 / 还缺」清单：按**合并后的真实资产**现算（不是按补丁算，否则永远缺一堆）。 */
  const coverage = useMemo(() => (step === 3 ? buildAssetCoverage(asset) : null), [step, asset]);

  /** 选身份（点卡片 / 键盘 Enter·Space 都走这里）。 */
  function selectType(key) {
    if (!SETUP_TYPES[key]) return;
    setTypeKey(key);
    setErr('');
    // 换身份 ⇒ 字段全换；同名消歧的确认也要重来（确认的主体是给上一套字段用的）。
    setForm({});
    setEntityState('pending');
    setEntityPick(null);
  }

  /**
   * 卡片的键盘操作。
   * 原生 <button> 在真浏览器里按 Enter/Space 会自动派发 click，但 jsdom **不会**，
   * 而且老板要求「键盘可操作」 —— 所以显式再接一层，两处都成立。
   */
  function onCardKeyDown(e, key) {
    if (!e) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      selectType(key);
    }
  }

  /** 标签多选。 */
  function toggleTag(fieldKey, option) {
    setForm((prev) => {
      const cur = Array.isArray(prev[fieldKey]) ? prev[fieldKey].slice() : [];
      const i = cur.indexOf(option);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(option);
      return { ...prev, [fieldKey]: cur };
    });
  }

  /** 消歧：用户从候选里单选确认。只回填企业名，不写库。 */
  function onEntityConfirm(cand) {
    if (!cand || !cand.name) return;
    setEntityPick(cand);
    setEntityState('confirmed');
    setForm((prev) => ({ ...prev, name: String(cand.name).trim() }));
    setErr('');
  }

  /** 消歧降级：AI / 联网不可用时手填全称（照样能建档，但如实标「未确证」）。 */
  function onEntityManualConfirm(manual) {
    const nm = String((manual && manual.name) || '').trim();
    if (!nm) return;
    setEntityPick({
      name: nm,
      region: String((manual && manual.region) || '').trim(),
      industry: '',
      brief: '',
      sourceUrl: '',
      sourceTitle: '',
      verified: false,
      sourceNote: '来源未确证（手动填写）',
      manual: true,
    });
    setEntityState('manual');
    setForm((prev) => ({ ...prev, name: nm }));
    setErr('');
  }

  /** 消歧「改选」：回到未确认态。 */
  function onEntityReset() {
    setEntityState('pending');
    setEntityPick(null);
  }

  /**
   * 建档（第 2 步的终点）。
   *
   * @param {boolean} skipRest true = 用户点了「跳过，稍后在企业大脑里补」：
   *        只落公司名 + 主体确认，其余字段一个不写（并在第 3 步如实列为待补充）。
   */
  function finalize(skipRest) {
    if (busy) return;
    if (!def) {
      setErr('请先选一个身份：诊所 / 经销商 / 厂家 / 平台');
      return;
    }
    if (!companyName) {
      // 公司名不能跳过：没有名字建不了档（老板原话「诊所的名字」是必填项）。
      setErr(`请先填写${def.nameLabel} —— 没有名字建不了档`);
      return;
    }
    if (entityState === 'pending') {
      setErr('请先点「🔍 AI 识别」确认到底是哪一家企业（或用下面的手动填写全称）—— 未确认主体不会建档');
      return;
    }

    setBusy(true);
    setErr('');

    const now = new Date().toISOString();
    const values = skipRest ? { name: form.name } : form;
    const profile = buildSetupProfilePatch(def, values, entityPick, entityState, now);
    const assetPatch = buildSetupAssetPatch(def, companyName, values, entityPick, entityState, now);

    /**
     * 落点企业（两种情形刻意分开，注释写在断言旁边）：
     *   ① 当前已有企业、且它**还没有任何建档资产** ⇒ 就地改名 + 改类型（复用）。
     *      场景：首登/引导里已经建了「苗苗」，现在在企业大脑里正式建档，不该多出一家重复企业。
     *   ② 其它情况（没有企业，或当前企业已经建过档）⇒ **新建**一家。
     *      绝不能拿已建档的企业去覆盖 —— 那等于把别人的档案改烂。
     */
    const existingHasAsset = !!(asset && String(asset.companyName || '').trim());
    let cid = currentId;
    let reused = false;
    if (currentId && !existingHasAsset) {
      reused = true;
      updateCompany(currentId, { name: companyName, type: def.companyType });
    } else {
      const created = createCompany(companyName, def.companyType, 'admin');
      cid = String((created && created.id) || currentId || '');
    }

    if (!cid) {
      setBusy(false);
      setErr('⚠️ 没能拿到企业 id（落点为空），建档没有归属，请刷新后重试');
      return;
    }

    setPendingJob({
      cid,
      name: companyName,
      type: def.companyType,
      reused,
      payload: { profile, asset: assetPatch },
    });
  }

  /**
   * 【0.21.27 · 老板 2026-11-10「企业建档一键」】
   * 一次点击走完这条路：认主体 → 联网补画像 → 建企业 / 就地改名 → 写子品牌 → 出成绩单。
   *
   * 与老的分步路径的关系：
   *   · 落库**只走同一条** `pendingJob` 两段式（见文件头），代码路径不复制；
   *   · 区别只在"谁做了决定"：分步路径由用户在 4 张卡里选身份，这里由名字关键词**推**，
   *     推不出就 `confident=false`，界面上明说"没认出来、先按这个建、可以点一下改"，
   *     **不假装认出来了**（老板最恨的失败形态是"它自己编了一个"）。
   *
   * 为什么同名企业不做成"必须选完才建档"：
   *   老路径的门禁是「未确认主体不建档」，因为它**在候选里替用户挑了一家**才是错。
   *   这里候选有歧义时用的是**用户自己输入的名字**（他没挑，我们也没挑），
   *   所以照建，但 `meta.entityConfirmed` 如实写 `'manual'`（未确证）——
   *   与 AssetPanel 手动填全称那条降级路径完全同一口径。
   */
  async function doQuickBuild() {
    if (quickBusy || busy) return;
    const typedName = String(quickName || '').trim();
    if (!typedName) {
      setQuickMsg('⚠️ 先填一下公司名称 —— 一行就够，其余豆芽自己补');
      return;
    }
    const inferred = inferCompanyType(typedName, (currentCompany && currentCompany.type) || '');
    const type = quickType && SETUP_TYPES[quickType] ? quickType : inferred.type;
    const qdef = SETUP_TYPES[type];
    if (!qdef) {
      setQuickMsg('⚠️ 身份判断失败，请点下面的身份卡手动选一个');
      return;
    }

    setQuickBusy(true);
    setQuickMsg('');
    setQuickReport('');
    setErr('');
    setQuickPhase('recognize');

    // ① 认主体：只有"唯一确定"才自动采用（与 AssetPanel.quickBuild 同一取舍，不猜）。
    let pick = null;
    let state = 'manual';
    let candCount = 0;
    try {
      const res = await findCompanyEntities({ companyName: typedName });
      const cands = res && res.ok && Array.isArray(res.candidates) ? res.candidates : [];
      candCount = cands.length;
      const verifiedOnly = cands.filter((c) => c && c.verified);
      const auto = verifiedOnly.length === 1 ? verifiedOnly[0] : (cands.length === 1 ? cands[0] : null);
      if (auto) {
        pick = auto;
        state = 'auto';
      }
    } catch {
      /* 检索失败不挡建档：按用户自己填的名字建，并如实标 manual（未确证） */
    }
    const finalName = String((pick && pick.name) || typedName).trim();
    if (pick && pick.region) {
      // 地区写失败的静默口径与 AssetPanel.persistRegion 一致（不因地区挡建档）。
      try {
        updateProfile(
          String(currentCompanyId || (currentCompany && currentCompany.id) || ''),
          buildRegionPatch(pick.region, qdef.companyType),
        );
      } catch {
        /* 忽略 */
      }
    }

    // ② 联网补画像（与「🚀 一键完整建档」同一个 analyzeCompany + analysisToFullAsset）
    setQuickPhase('build');
    let ares = null;
    try {
      const input = { companyName: finalName, industry: String((pick && pick.industry) || '') };
      ares = await analyzeCompany(geoProxy, input);
    } catch (e) {
      ares = {
        ok: false,
        profile: null,
        error: '建档异常：' + ((e && e.message) || String(e)),
        degraded: true,
        grounded: false,
        source: '',
      };
    }
    const profile = ares && ares.ok && ares.profile ? ares.profile : null;
    const now = new Date().toISOString();
    const assetPatch = analysisToFullAsset(
      profile,
      { companyName: finalName, industry: String((pick && pick.industry) || '') },
      pick,
    );
    assetPatch.meta = {
      builtAt: now,
      analyzedAt: profile ? now : null,
      degraded: !profile,
      source: profile ? 'ai' : 'manual',
      entityConfirmed: state,
      entityName: finalName,
      entityRegion: String((pick && pick.region) || ''),
      entityVerified: !!(pick && pick.verified),
      grounded: !!(ares && ares.grounded),
      sourceLabel: String((ares && ares.source) || ''),
      // 如实标记"这条档是一键建的"：下游排查时能分清哪些是人一步步填的。
      oneClick: true,
    };
    // profile 侧复用老 builder（地区 / 建档记录口径与分步路径完全一致，不新造一份）。
    const profPatch = buildSetupProfilePatch(qdef, { name: finalName }, pick, state, now);

    // ③ 子品牌：只来自用户输入（他不填就一个不写，绝不自己编名字）
    const sub = parseSubBrands(quickSubs, finalName);

    // ④ 落点企业（复用 / 新建的取舍与 finalize 同一口径）
    const existingHasAsset = !!(asset && String(asset.companyName || '').trim());
    let cid = currentId;
    let reused = false;
    if (currentId && !existingHasAsset) {
      reused = true;
      updateCompany(currentId, { name: finalName, type: qdef.companyType });
    } else {
      const created = createCompany(finalName, qdef.companyType, 'admin');
      cid = String((created && created.id) || currentId || '');
    }
    if (!cid) {
      setQuickBusy(false);
      setQuickPhase('');
      setQuickMsg('⚠️ 没能拿到企业 id（落点为空），建档没有归属，请刷新后重试');
      return;
    }

    const cov = buildAssetCoverage({ ...(asset || {}), ...assetPatch });

    setPendingJob({
      cid,
      name: finalName,
      type: qdef.companyType,
      reused,
      payload: { profile: profPatch, asset: assetPatch },
      brands: { names: sub.names, note: '一键建档（手填）' },
      quick: { profileOk: !!profile, filled: cov.filledCount, total: cov.total },
    });

    // 有歧义就**说清楚**：档已经建了（用你填的名字），但要精确到某一家得再认一次。
    if (candCount > 1 && state !== 'auto') {
      setQuickMsg(
        `搜到 ${candCount} 家同名企业，豆芽不替你猜 —— 先按你填的全称建了档（标为未确证）；` +
          '要精确到某一家，回企业大脑点「🔍 AI 识别」确认后再点一次一键建档。',
      );
    } else if (sub.truncated) {
      setQuickMsg(`子品牌一次最多建 20 个，这次先写了前 20 个（你一共填了 ${sub.names.length} 个以上）。`);
    } else if (sub.dropped.length) {
      setQuickMsg(`有 ${sub.dropped.length} 个子品牌名超过 24 字，已跳过（不做截断，免得造出一个不存在的名字）。`);
    }
  }

  function next() {
    if (step === 1) {
      if (!typeKey) {
        setErr('请先选一个身份：诊所 / 经销商 / 厂家 / 平台');
        return;
      }
      setErr('');
      setStep(2);
      return;
    }
    if (step === 2) finalize(false);
  }

  function back() {
    if (step !== 2) return;
    setErr('');
    setStep(1);
  }

  /** 「再建一个」：从第 1 步重来（已经建好的档不动）。 */
  function restart() {
    setStep(1);
    setTypeKey('');
    setForm({});
    setErr('');
    setEntityState('pending');
    setEntityPick(null);
    setBuilt(null);
    setBusy(false);
  }

  if (!open) return null;

  const headTitle = step === 2 && def ? def.title : STEP_TITLES[step];

  return (
    /**
     * ⚠️ 全屏几何必须写在 **内联样式**上：
     *   · 测试跑在 jsdom 里，样式表被 esbuild 的 `'.css': 'empty'` 吞掉，
     *     `getComputedStyle` 量不到 `position` —— 只有内联样式读得到；
     *   · 生产上空 `.csw-*` 样式表仍负责观感（背景 / 圆角 / 间距），两者不冲突。
     */
    <div
      className="csw-root"
      data-csw="1"
      data-csw-step={String(step)}
      data-csw-type={typeKey || ''}
      data-csw-fullscreen="1"
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 9000 }}
      role="region"
      aria-label="企业建档引导"
    >
      <div className="csw-sheet">
        <div className="csw-topbar">
          <span className="csw-brand">豆芽 · 企业建档</span>
          <button
            type="button"
            className="csw-quiet"
            data-csw-close="1"
            onClick={() => (typeof onClose === 'function' ? onClose() : null)}
          >
            稍后再说
          </button>
        </div>

        {/* 进度：一次只问一件事，走到哪一步看得见。 */}
        <div className="csw-steps" data-csw-steps="1">
          {Array.from({ length: SETUP_STEP_COUNT }).map((_, i) => {
            const n = i + 1;
            return (
              <span
                key={n}
                className={'csw-stepdot' + (n <= step ? ' on' : '')}
                data-csw-stepdot={String(n)}
                data-csw-stepdot-on={n <= step ? '1' : '0'}
              >
                {n}
              </span>
            );
          })}
        </div>

        <div className="csw-head">
          <div className="csw-title" data-csw-title="1">{headTitle}</div>
          <div className="csw-sub">
            {step === 1 && '先选一个身份，后面的字段会跟着变。整块卡片都可以点。'}
            {step === 2 && (def ? `只填最基本的几项，其余可以稍后在企业大脑里补。` : '')}
            {step === 3 && '企业已经建好了，填进去的信息已经存进库里，刷新也还在。'}
          </div>
        </div>

        {/* ============ 第 1 步（上半）：⚡ 一键建档（老板 2026-11-10 的第 4 条）============
            「输入一下公司名称 子品牌 建档一键全部搞定」——
            两个输入框 + 一个按钮，走完 认主体 → 补画像 → 建企业 → 写子品牌。
            它的位置刻意在 4 张卡**上面**：先给最省事的路径，愿意多填的人往下走。 */}
        {step === 1 && (
          <div className="csq-quick" data-csw-quick="1">
            <div className="csq-hd">
              <span className="csq-title">⚡ 一键建档</span>
              <span className="csq-tag">最快</span>
            </div>
            <div className="csq-sub">填公司名，有子品牌就一行写下来 —— 其余的豆芽自己做完。</div>
            <Input
              value={quickName}
              data-csw-quick-name="1"
              placeholder="公司 / 诊所全称，例如：康健苗苗集团"
              onChange={(e) => setQuickName(e.target.value)}
              onPressEnter={doQuickBuild}
              disabled={quickBusy}
            />
            <Input
              value={quickSubs}
              data-csw-quick-subs="1"
              placeholder="子品牌，多个用顿号或逗号隔开，例如：舒雅星系、上游货源（可留空）"
              onChange={(e) => setQuickSubs(e.target.value)}
              onPressEnter={doQuickBuild}
              disabled={quickBusy}
            />

            {/* 身份：推断出来的，但**摆出来给人改** —— 一键不等于偷偷替用户决定。
                没认出来时这里会写"没认出"，并允许点一下换。 */}
            {(() => {
              const inf = inferCompanyType(quickName, (currentCompany && currentCompany.type) || '');
              const active = quickType || inf.type;
              return (
                <div className="csq-types" data-csw-quick-type-row="1" data-csw-quick-type-active={active}>
                  <span className="csq-types-label">{inf.confident ? '身份：' : '没认出身份，先按：'}</span>
                  {SETUP_TYPE_ORDER.map((k) => {
                    const on = active === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        className={'csw-quick-chip' + (on ? ' on' : '')}
                        data-csw-quick-type={k}
                        data-csw-quick-type-on={on ? '1' : '0'}
                        aria-pressed={on}
                        onClick={() => setQuickType(k)}
                        disabled={quickBusy}
                      >
                        {SETUP_TYPES[k].icon} {SETUP_TYPES[k].label}
                      </button>
                    );
                  })}
                  <span className="csq-why" data-csw-quick-type-why="1">{inf.why}</span>
                </div>
              );
            })()}

            <div className="csq-act">
              <Button
                type="primary"
                size="large"
                data-csw-quick-go="1"
                onClick={doQuickBuild}
                loading={quickBusy}
                disabled={quickBusy}
              >
                ⚡ 一键建档
              </Button>
              {quickPhase === 'recognize' && (
                <span className="csq-phase" data-csw-quick-phase="recognize">正在确认是哪一家企业…</span>
              )}
              {quickPhase === 'build' && (
                <span className="csq-phase" data-csw-quick-phase="build">正在联网补画像、写子品牌…</span>
              )}
            </div>
            {quickMsg ? <div className="csq-msg" data-csw-quick-msg="1">⚠️ {quickMsg}</div> : null}
            <div className="csq-or">或者往下走：自己选身份、多填几项，画像会更准（不强求）。</div>
          </div>
        )}

        {/* ================= 第 1 步：4 张身份卡（顺序 = 老板给的顺序） ================= */}
        {step === 1 && (
          <div className="csw-cards" data-csw-cards="1">
            {SETUP_TYPE_ORDER.map((key) => {
              const t = SETUP_TYPES[key];
              if (!t) return null;
              const on = typeKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={'csw-card' + (on ? ' on' : '')}
                  data-csw-card={key}
                  data-csw-card-on={on ? '1' : '0'}
                  aria-pressed={on}
                  onClick={() => selectType(key)}
                  onKeyDown={(e) => onCardKeyDown(e, key)}
                >
                  <span className="csw-card-icon">{t.icon}</span>
                  <span className="csw-card-label" data-csw-card-label="1">{t.label}</span>
                  <span className="csw-card-desc">{t.cardDesc}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* ================= 第 2 步：按身份分叉的字段 ================= */}
        {step === 2 && def && (
          <div className="csw-form" data-csw-form={def.key}>
            {/* 公司 / 诊所名字 + 同名消歧（老板第 4 条：输入「苗苗」先确认是哪一家，才允许建档） */}
            <div className="csw-field" data-csw-field-key="name" data-csw-field-required="1">
              <label className="csw-field-label">{def.nameLabel} *</label>
              <Input
                value={form.name || ''}
                data-csw-field-input="name"
                placeholder={def.namePlaceholder}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, name: e.target.value }));
                  // 名字一改，之前确认的主体就作废了（否则会用旧主体给新名字建档）。
                  setEntityState('pending');
                  setEntityPick(null);
                }}
              />
              <div className="csw-field-hint">这一项不能跳过 —— 没有名字建不了档。</div>
              <CompanyEntityPicker
                companyName={form.name || ''}
                industry=""
                confirmedName={entityPick ? entityPick.name : ''}
                state={entityState}
                onConfirm={onEntityConfirm}
                onManualConfirm={onEntityManualConfirm}
                onReset={onEntityReset}
                disabled={false}
              />
            </div>

            {/* 其余字段：由 def.fields 驱动（这是「分支」本体，不是同一张表单换标题） */}
            {def.fields.map((f) => (
              <div className="csw-field" key={f.key} data-csw-field-key={f.key}>
                <label className="csw-field-label">{f.label}</label>
                {f.kind === 'tags' ? (
                  <div className="csw-tags">
                    {(f.options || []).map((o) => {
                      const on = Array.isArray(form[f.key]) && form[f.key].includes(o);
                      return (
                        <button
                          key={o}
                          type="button"
                          className={'csw-tag' + (on ? ' on' : '')}
                          data-csw-tag={o}
                          data-csw-tag-on={on ? '1' : '0'}
                          aria-pressed={on}
                          onClick={() => toggleTag(f.key, o)}
                        >
                          {o}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <Input
                    value={form[f.key] || ''}
                    data-csw-field-input={f.key}
                    placeholder={f.placeholder || ''}
                    onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  />
                )}
                {f.hint ? <div className="csw-field-hint">{f.hint}</div> : null}
              </div>
            ))}

            {/* 跳过出口：公司名不能跳，其余都可以稍后在企业大脑里补。 */}
            <button
              type="button"
              className="csw-skip"
              data-csw-skip="1"
              onClick={() => finalize(true)}
            >
              跳过，稍后在企业大脑里补
            </button>
          </div>
        )}

        {/* ================= 第 3 步：结果 + 还缺什么（不许只报一句「成功」） ================= */}
        {step === 3 && built && (
          <div className="csw-done" data-csw-done="1">
            <div className="csw-done-icon">✅</div>
            <div className="csw-done-title" data-csw-done-name={built.name}>
              {built.name} 建档完成
            </div>
            <div className="csw-done-sub">
              类型：{SETUP_TYPES[built.type] ? SETUP_TYPES[built.type].label : built.type}
              {built.reused ? ' · 已更新到现有企业' : ' · 已新建企业'}
              ；企业列表里已经能看到了。
            </div>
            {quickReport ? (
              // 一键路径的成绩单：三行说清 建了什么 / 画像有没有拿到 / 子品牌建了几个。
              // 老的分步路径 quickReport 为空，走的仍是下面那块 coverage（口径一行没改）。
              <div className="csq-report" data-csw-quick-report="1" data-csw-quick-report-lines={String(quickReport.split('\n').length)}>
                {quickReport.split('\n').map((line, i) => (
                  <div className="csq-report-line" key={i}>{line}</div>
                ))}
              </div>
            ) : null}
            {coverage && (
              <div
                className="csw-coverage"
                data-csw-coverage="1"
                data-csw-coverage-filled={coverage.filledCount}
                data-csw-coverage-missing={coverage.missingCount}
              >
                📋 建档清单：已补齐 {coverage.filledCount}/{coverage.total} 项
                {coverage.missingCount > 0
                  ? `；还缺 ${coverage.missingCount} 项待补充：${coverage.missing.map((m) => m.label).join('、')}`
                  : '；没有缺失项'}
                <div className="csw-coverage-note">
                  待补充的意思是「还没拿到」，不是「豆芽替你编了一个」。回企业大脑点「🚀 一键完整建档」再补。
                </div>
              </div>
            )}
          </div>
        )}

        {err ? <div className="csw-err" data-csw-error="1">⚠️ {err}</div> : null}
        {busy && <div className="csw-note" data-csw-busy="1">⏳ 正在把信息写进企业档案…</div>}

        {/* ================= 底部：上一步 / 下一步 ================= */}
        <div className="csw-foot">
          {step === 1 && (
            <>
              <Button type="primary" size="large" data-csw-next="1" onClick={next}>
                下一步
              </Button>
              <Button
                type="text"
                size="large"
                data-csw-cancel="1"
                onClick={() => (typeof onClose === 'function' ? onClose() : null)}
              >
                取消
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button size="large" data-csw-back="1" onClick={back} disabled={busy}>
                上一步
              </Button>
              <Button type="primary" size="large" data-csw-next="1" onClick={next} loading={busy} disabled={busy}>
                完成建档
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button type="primary" size="large" data-csw-finish="1" onClick={() => (typeof onClose === 'function' ? onClose() : null)}>
                去企业大脑看看
              </Button>
              <Button size="large" data-csw-again="1" onClick={restart}>
                再建一个
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
