import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'antd';
import { useCompany, COMPANY_TYPE_KEYS } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCampaign } from '../store/campaignStore.jsx';
import { useDirection } from '../store/directionStore.jsx';
import { COMPANY_TYPE_CONFIG, getTypeConfig } from '../config/companyTypeConfig.js';
import douyaMascot from '../assets/douya/douya-mascot.webp';
import { getDirections } from '../config/directionCatalog.js';
import { buildDirection } from '../services/directionDirector.js';
import { recommendDirections, mergeDirectionPicks } from '../services/directionRecommend.js';
import { runCompanyCheckup } from '../services/companyCheckup.js';
import { runDeepThink, deepThinkOnce } from '../services/deepThink.js';
import { recommendGoals } from '../services/goalGuide.js';
import { setCompanyGoal, GOAL_CATEGORIES, PLAN_PERIODS, classifyGoalCategory } from '../services/companyGoal.js';
import { GOAL_GROUPS } from '../store/goalCatalog.js';
import { chatOnce } from '../api.js';
import { validateManualCompanyInfo, judgeIdentityGate } from '../services/companyIdentity.js';
import { fetchWebCandidates } from '../services/webCandidates.js';
// T16：首登企业识别改为**真检索**（fetchWebSearch + 注入实检资料），不再走静默忽略 enable_search 的 searchWeb。
import { judgeBrandAttribution, searchCompanyIntro } from '../services/groundedWebSearch.js';
import { getCachedWebSearchHealth } from '../services/webSearchHealth.js';
import { isWebConfirmed, onboardingSearchKey, searchingText, candidateSourceLabel, candidateListHeading, candidateHintText, candidatePickerNote, webFindButtonText } from '../services/webSearchHonesty.js';
import BrandIpManager from './BrandIpManager.jsx';
import WebCandidatePicker from './WebCandidatePicker.jsx';

/**
 * Step1 企业类型卡片：顺序取自 COMPANY_TYPE_KEYS（与 normalizeCompanyType 四值白名单同源），
 * 展示内容取自 COMPANY_TYPE_CONFIG。filter(Boolean) 兜底 —— config 万一缺档，只少一张卡，
 * 不会出现「key 与标签不符」的幽灵卡片。
 */
const TYPE_CARDS = COMPANY_TYPE_KEYS.map((k) => COMPANY_TYPE_CONFIG[k]).filter(Boolean);

const ROLES = [
  { key: 'admin', icon: '👑', label: '管理员', desc: '管理企业、成员与全部功能' },
  { key: 'operator', icon: '📣', label: '运营', desc: '日常营销运营、执行任务' },
  { key: 'viewer', icon: '👀', label: '查看', desc: '只读查看，不下发操作' },
];

// Step3「你现在最想推动什么」8 个卡片选项（存 label 字符串到 topPriority）
const TOPICS = [
  { key: 'newproduct', label: '新产品上市' },
  { key: 'expo', label: '展会·学术会议' },
  { key: 'acquire', label: '获客' },
  { key: 'brand', label: '品牌曝光' },
  { key: 'channel', label: '渠道拓展' },
  { key: 'content', label: '内容增长' },
  { key: 'pr', label: '舆情处理' },
  { key: 'other', label: '其他' },
];

const BRAIN_STEPS = [
  { key: 'profile', label: '企业资料' },
  { key: 'asset', label: '企业画像' },
  { key: 'brand', label: '品牌信息' },
  { key: 'memory', label: 'AI 营销记忆' },
];

/**
 * 体检报告里「豆芽了解到的」每条的信息来源标签。
 * 键与 companyCheckup.CHECKUP_FROM_VALUES（user/web/ai）同源 —— 让用户一眼分清
 * 哪句是他自己填的、哪句是联网查到的、哪句只是豆芽的推断，不至于把 AI 假设当事实。
 *
 * 注：web 项**不写死**「来自联网检索」—— 它跟随联网探针（webSearchHealth）：
 * 未确证联网时照实写「未联网 / 联网状态未确认」，绝不把模型推断伪装成联网产物。
 */
const CHECKUP_FROM_LABEL = {
  user: '来自你的填写',
  ai: '豆芽推断',
};

/** 「来自联网检索」只在探针**确证联网可用**时出现；否则给保守文案（数据来源诚实红线）。 */
function checkupWebFromLabel() {
  const h = getCachedWebSearchHealth();
  if (h && h.available === true) return '来自联网检索';
  if (h && h.available === false) return '来自未联网的模型推断';
  return '来自模型分析（联网状态未确认）';
}

const STEP_TITLES = {
  0: '欢迎',
  1: '选择企业类型',
  2: '选择你的角色',
  3: '填写企业基本资料',
  4: '初始化企业营销大脑',
  5: '品牌归属（母公司 / 品牌）',
  6: '补充企业知识',
  7: '立企业目标',
  8: '计划周期 · 重要日期',
  9: '选择经营方向',
};

/**
 * 首登新增步骤 5「品牌归属」（老板第 2 条）。
 *
 * 老板原话：「输入厂家不代表是厂家下面的品牌啊，有可能是要你看品牌呢？」
 * —— 用户填的「康健苗苗」可能是母公司，也可能是它旗下的某个品牌（如「上游货源」）。
 * 若不问清，后面的经营诊断 / 舆情监控会对错监控对象。故显式让用户表态：
 *   母公司   → 邀请登记旗下子品牌（复用 BrandIpManager 矩阵，可跳过）
 *   某一个品牌 → 记录「关注的品牌」+ 其所属母公司
 * 并可选联网候选（老板第 10 条）：候选一律标注「来自联网检索，需你确认」，
 * **用户未勾选确认前绝不写入 brandIps**（合规红线）。
 */
const BRAND_ATTRIBUTION = {
  company: {
    key: 'company',
    label: '母公司 / 公司主体',
    desc: '我填的是整家公司（多个品牌都归它）。可为它登记旗下的子品牌 / 产品线 IP。',
  },
  brand: {
    key: 'brand',
    label: '其中某一个品牌',
    desc: '我关注的是这家公司旗下的某一个品牌，请对准这个品牌做诊断与监控。',
  },
};

/** Step6「补充企业知识」字段：让豆芽更懂企业（写 marketingStore asset，并同步进企业知识库 facts）。 */
const KNOWLEDGE_FIELDS = [
  { key: 'competitors', label: '竞品', type: 'tags', hint: '豆芽据此做竞品声量对比和差异化', placeholder: '例如：A 品牌、B 品牌（逗号分隔）' },
  { key: 'coreSellingPoints', label: '核心卖点', type: 'tags', hint: '豆芽据此帮你写文案、定传播重点', placeholder: '例如：种植体、数字化正畸（逗号分隔）' },
  { key: 'targetCustomers', label: '目标客户', type: 'tags', hint: '豆芽据此匹配媒体与人群投放', placeholder: '例如：口腔诊所、民营医院（逗号分隔）' },
  { key: 'brandTone', label: '品牌调性', type: 'text', hint: '豆芽据此统一所有文案的语气与风格', placeholder: '例如：专业、可信、温暖' },
  { key: 'contentTaboos', label: '内容禁忌', type: 'textarea', hint: '豆芽据此避开合规红线，不写不该写的', placeholder: '例如：不得声称疗效/治愈率（每行一条）' },
];

/** 目标类别卡片（方向盘三选 + 自定义），顺序与 GOAL_CATEGORIES 一致。 */
const GOAL_CATEGORY_CARDS = Object.values(GOAL_CATEGORIES);

/** goalId → 可读 label（供「豆芽帮你定目标」展示）。 */
const GOAL_LABEL_BY_ID = {};
GOAL_GROUPS.forEach((g) => g.goals.forEach((it) => { GOAL_LABEL_BY_ID[it.id] = it.label; }));

/**
 * 首次登录 → 企业初始化（第二阶段核心）。
 * 分步：类型 → 角色 → 基本资料 → 初始化营销大脑（company-analyze，可跳过）→ 完成 + 选营销目标
 * → 自动创建项目 + 建议任务 → 进入工作台。
 * 聊天式（无弹窗），绿色主题，Apple 极简。角色归属 CompanyMember（写在 Membership 上）。
 * onDone：完成后由 App 切到工作台视图（本组件不再控制路由）。
 */
export default function Onboarding({ onDone }) {
  const { createCompany, currentCompany, updateCompany } = useCompany();
  const { updateProfile, getKnowledge, setBrain, addFact, addRule, setBrandIps } = useCompanyKnowledge();
  const { buildAsset, asset, updateField } = useMarketingAsset();
  const { createCampaign } = useCampaign();
  const { createDirection, attachCampaign } = useDirection();

  // 营销资产 state 在 buildAsset 之后异步更新，深思考用 ref 取「已产出」的最新资产值
  const assetRef = useRef(asset);
  useEffect(() => {
    assetRef.current = asset;
  }, [asset]);

  // Step3 创建企业后回填 companyId（createCompany 返回值，供后续步骤落库/自动搭建用，避免依赖 currentCompany 时序）
  const companyIdRef = useRef(null);

  // 联网探针（同步读缓存，不主动发请求）：未确证联网时，过程 UI / 候选来源一律去掉「联网」字样（数据来源诚实红线）。
  const webHealth = getCachedWebSearchHealth();

  const [step, setStep] = useState(0);
  const [type, setType] = useState('manufacturer');
  const [role, setRole] = useState('admin');
  const [name, setName] = useState('');
  const [fields, setFields] = useState({});
  const [err, setErr] = useState('');
  const [topPriority, setTopPriority] = useState(null); // Step3「你现在最想推动什么」
  const [choosingKey, setChoosingKey] = useState(null); // Step9 正在搭建的方向 key

  // Step9：豆芽按「企业目标 + 画像」给方向排优先级并写个性化理由（数据层 directionRecommend.js）
  const [dirAi, setDirAi] = useState(null); // null=未判断 | {ok:true,list} | {ok:false,error}
  const [dirBusy, setDirBusy] = useState(false);
  const dirAiRef = useRef(null); // 单飞 + 去重：记住「已为哪个目标跑过」，目标变了才重跑

  // Step7 立企业目标（方向盘）状态
  const [goalCategory, setGoalCategory] = useState('customer'); // sales/customer/brand/custom
  const [goalStatement, setGoalStatement] = useState('');
  const [goalSource, setGoalSource] = useState('user'); // user 填已有 / ai 豆芽定制
  const [goalBusy, setGoalBusy] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState([]); // 豆芽定制的目标建议

  // Step8 计划周期状态（整套方案由「今天做什么」自动铺进日历，此处不再收集日期）
  const [planPeriod, setPlanPeriod] = useState('quarterly'); // yearly/quarterly/monthly

  // Step6 补充企业知识（竞品/卖点/客户/调性/禁忌，写 marketingStore asset 的补充字段）
  const [knowFields, setKnowFields] = useState({});
  function setKnowField(key, value) {
    setKnowFields((prev) => ({ ...prev, [key]: value }));
  }

  // Step5（新）品牌归属（老板第 2、10 条）
  const [brandType, setBrandType] = useState('company'); // company（母公司）| brand（某一个品牌）
  const [brandFocus, setBrandFocus] = useState('');      // 选「某一个品牌」时，具体关注的品牌名
  const [brandParent, setBrandParent] = useState('');    // 该品牌所属母公司（选填）
  const [brandCandState, setBrandCandState] = useState('idle'); // idle | searching | done | failed
  const [brandCands, setBrandCands] = useState([]);      // 联网候选子品牌名（未确认，不写库）
  const [brandPicked, setBrandPicked] = useState(() => new Set());
  const [brandMsg, setBrandMsg] = useState('');
  const [brandErr, setBrandErr] = useState('');
  // 2026-09-14 老板拍板 B 项：品牌归属必填，但给一个出口 ——「我不确定」时由豆芽联网判断。
  const [brandAiState, setBrandAiState] = useState('idle'); // idle | asking | failed

  // Step4 状态
  const [brainStarted, setBrainStarted] = useState(false);
  const [brainState, setBrainState] = useState('idle'); // idle | running | done | degraded
  const [brainStepIdx, setBrainStepIdx] = useState(-1);
  const [brainNote, setBrainNote] = useState('');

  // 联网搜索企业：用户填完公司名后，让豆芽先联网了解企业公开信息（结果可见，非后台静默）
  const [webState, setWebState] = useState('idle'); // idle | searching | done | failed
  const [webSummary, setWebSummary] = useState('');
  const [brainInsights, setBrainInsights] = useState(null); // deepThink 产出提炼摘要，展示「豆芽了解到什么」

  // Step4 企业识别确认（2026-09-12 修「认错公司」）：
  // 联网检索会认错 —— ① 名字相近（想做「康健苗苗」却查到同名的另一家）；② 刚注册/没曝光的公司查不到。
  // 旧实现把检索结果当事实直接展示，用户既不能否认、也没地方补，一旦认错，
  // 后面的「体检 → 短板 → 方向 → 方案」全建在错误的公司上。
  //   identityState: pending（还没表态）| confirmed（就是这家）| manual（不对，我自己填）
  const [identityState, setIdentityState] = useState('pending');
  const [manualName, setManualName] = useState('');   // 手填企业全称（可顺手纠正认错的名字）
  const [manualDesc, setManualDesc] = useState('');   // 手填业务描述（必填，决定能不能继续）
  const [manualJudge, setManualJudge] = useState(''); // 豆芽对手填内容的复述/判断（AI，失败即降级为空）
  const [manualJudgeState, setManualJudgeState] = useState('idle'); // idle | running | done | failed
  const [showCompanyPicker, setShowCompanyPicker] = useState(false); // 同名/相似企业候选面板开关
  const [pickedCompanyName, setPickedCompanyName] = useState('');    // 从同名/相似候选里选定的企业主体（来源：联网检索）

  // Step4 企业体检：分析完之后，豆芽把「了解了什么 / 短板在哪 / 先整改什么」讲清楚。
  // 第 8 步选运营方案时会引用这里发现的短板，形成「分析 → 不足 → 整改 → 方案」的完整链。
  const [checkupState, setCheckupState] = useState('idle'); // idle | running | done | failed
  const [checkup, setCheckup] = useState(null);
  const [checkupErr, setCheckupErr] = useState('');

  const cfg = getTypeConfig(type);
  const fieldDefs = cfg.onboardingFields || [];

  /** 组装体检入参（用户填写资料 + 联网结果），供首次自动跑与「重新体检」复用。 */
  function buildCheckupPayload(webText) {
    const cid = companyIdRef.current;
    const clean = {};
    for (const f of fieldDefs) {
      const v = fields[f.key];
      if (v != null && String(v).trim() !== '') clean[f.key] = String(v).trim();
    }
    const companyName = (name || '').trim();
    return {
      currentCompany: cid
        ? { ...(currentCompany || {}), id: cid, name: companyName }
        : (currentCompany || { name: companyName }),
      asset: assetRef.current || {},
      knowledge: getKnowledge(cid),
      role,
      companyName,
      companyType: type,
      companyTypeLabel: cfg.label,
      fields: clean,
      topPriority: topPriority || '',
      webSummary: webText || '',
    };
  }

  /**
   * 跑一次企业体检。失败一律静默降级为可读失败态 + 重试入口 —— 不弹错、不白屏、不假装成功。
   * 注意：绝不阻塞「继续」按钮，报告就绪后自行出现。
   */
  async function runCheckup(webText) {
    setCheckupState('running');
    setCheckupErr('');
    setCheckup(null);
    let r = null;
    try {
      r = await runCompanyCheckup(buildCheckupPayload(webText));
    } catch (e) {
      r = { ok: false, error: (e && e.message) || 'AI 调用失败' };
    }
    if (r && r.ok && r.checkup) {
      setCheckup(r.checkup);
      setCheckupState('done');
    } else {
      setCheckupErr((r && r.error) || 'AI 未返回结果');
      setCheckupState('failed');
    }
  }

  /**
   * 手填内容 → 让豆芽复述一遍「我据此理解到你是什么企业」。
   * 这是「填写后判断是否正确」的落地：用户一眼就能看出豆芽有没有理解偏。
   * 纯增量：AI 不响应一律静默降级（留空 + 提示），**绝不因为 AI 不响而不让用户继续**。
   */
  async function runManualJudge() {
    const v = String(manualDesc || '').trim();
    if (!validateManualCompanyInfo(v).ok) return;
    setManualJudgeState('running');
    setManualJudge('');
    let r = null;
    try {
      r = await chatOnce([
        {
          role: 'user',
          content:
            `用户在做企业建档。联网检索没有认对这家公司，以下是用户自己填写的企业说明：\n「${v}」\n\n` +
            '只做一件事：用 1-2 句话复述你据此理解到的「这是什么企业、主要做什么、卖给谁」，' +
            '并另起一行用「不确定：」列出其中还不能确定的地方。' +
            '不要编造用户没说的信息，不要给建议，不要客套。',
        },
      ], null, { temperature: 0.2, reasoningEffort: 'none', timeoutMs: 25000 });
    } catch {
      r = null;
    }
    const content = r && r.ok && r.content ? String(r.content).trim() : '';
    if (content) {
      setManualJudge(content);
      setManualJudgeState('done');
    } else {
      setManualJudge('');
      setManualJudgeState('failed');
    }
  }

  // Step4 识别门禁：有联网结果必须先表态（确认 / 自己填），查不到则不强制手填。
  const hasWebResult = webState === 'done' && !!webSummary;
  const identityGate = judgeIdentityGate({
    hasWebResult,
    identity: identityState,
    manualText: manualDesc,
  });
  const manualCheck = validateManualCompanyInfo(manualDesc);

  /**
   * Step4「继续」：按识别门禁放行；选了自己填 → 顺手纠正企业名 + 把自述落进企业知识库，
   * 让后面的体检 / 方向 / 方案真正建立在「用户说的公司」上，而不是检索错的那家。
   */
  function goNextFromBrain() {
    if (!identityGate.canContinue) {
      setErr(identityGate.reason);
      return;
    }
    setErr('');
    const cid = companyIdRef.current || (currentCompany && currentCompany.id);
    // 用户从「同名 / 相似企业候选」里选定了一家 → 视为已确认（门禁对 confirmed 无条件放行），
    // 但要把企业名真正纠正过来，并如实标注这是「联网检索候选确认」，不能标成手填。
    if (identityState === 'confirmed' && pickedCompanyName && cid) {
      const picked = String(pickedCompanyName).trim();
      if (picked && picked !== String(name || '').trim()) {
        setName(picked);
        if (updateCompany) updateCompany(cid, { name: picked });
      }
      addFact(cid, `企业主体名称（用户从联网检索的同名候选列表中确认）：${picked}`);
      // 用户若先手填过描述、又从候选里选定，两件事都落库，各自标注来源（不丢信息）。
      if (manualCheck.ok) addFact(cid, `企业自述（用户手填，未联网核实）：${manualCheck.value}`);
      setStep(5);
      return;
    }
    if (identityState === 'manual' && manualCheck.ok && cid) {
      const n = String(manualName || '').trim();
      if (n && n !== String(name || '').trim()) {
        setName(n);
        if (updateCompany) updateCompany(cid, { name: n });
      }
      addFact(cid, `企业自述（用户手填，未联网核实）：${manualCheck.value}`);
    }
    setStep(5);
  }

  /**
   * 同名 / 相似企业候选：用户勾选并点「确认添加选中」后回调（候选未确认前组件绝不写库）。
   * 语义 = 用户已确认这次要做的公司 → identityState='confirmed'（门禁无条件放行）。
   * 同时把选定名记下来，供 goNextFromBrain 纠正企业名并如实标注来源（联网检索候选确认）。
   * 不写 manualDesc（避免把内部文案灌进用户可见的「业务描述」框、也不误标来源）。
   */
  function onConfirmCompanyCandidate(names) {
    const chosen = String((names && names[0]) || '').trim();
    if (!chosen) return;
    setPickedCompanyName(chosen);
    setManualName(chosen);        // 兜底：用户之后若切回手填，名字已就位
    setIdentityState('confirmed'); // 语义：用户已确认要做的公司 → 门禁无条件放行
    setShowCompanyPicker(false);
  }

  // Step9「3 个经营方向」（基于企业类型，方向模板）
  const directions = useMemo(() => getDirections(type), [type]);

  // Step9：让豆芽按企业目标 + 画像判断「这几个方向现在最该先做哪个」，并为每个写理由。
  // 失败一律静默降级为目录原序（不弹错、不白屏）——方向 key 与落库路径完全不受影响。
  async function runDirectionAI() {
    setDirBusy(true);
    let r = null;
    try {
      r = await recommendDirections({
        currentCompany,
        asset: assetRef.current || {},
        knowledge: getKnowledge(companyIdRef.current),
        companyType: type,
        role,
        goalLabel: goalStatement,
        // 把第 4 步体检发现的短板交给方向判断 —— 让「分析 → 不足 → 方案」接得上，
        // 而不是分析完就丢掉、方案跟短板毫无关系。
        gaps: checkup && Array.isArray(checkup.gaps) ? checkup.gaps : [],
      });
    } catch {
      r = null;
    }
    setDirAi(r && r.ok && Array.isArray(r.list) && r.list.length ? r : { ok: false, error: (r && r.error) || 'AI 未返回结果' });
    setDirBusy(false);
  }

  // 进入 Step9 自动判断一次；只有「AI 失败」时才允许用按钮手动重试（成功后不重复打 AI）。
  useEffect(() => {
    if (step !== 9) return;
    const key = goalStatement || '';
    if (dirAiRef.current === key) return;   // 同一目标只跑一次（返回上一步改目标会重跑）
    dirAiRef.current = key;
    runDirectionAI();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, goalStatement]);

  // 卡片数据：AI 成功 → 用它的排序与理由；失败/未返回 → 目录原序 + 目录原文案。
  // mergeDirectionPicks 保证「方向一个都不少」，故 AI 排过序也不会让用户漏看方向。
  const dirCards = useMemo(() => {
    const base = dirAi && dirAi.ok
      ? mergeDirectionPicks(dirAi.list, directions)
      : directions.map((d) => ({ key: d.key, reason: '', fit: '中', fitLabel: '中' }));
    return base
      .map((it) => {
        const cat = directions.find((d) => d.key === it.key);
        return cat ? { ...cat, aiReason: it.reason || '', aiRanked: !!(dirAi && dirAi.ok) } : null;
      })
      .filter(Boolean);
  }, [directions, dirAi]);

  const dirAiOk = !!(dirAi && dirAi.ok && dirCards.some((c) => c.aiReason));

  function setField(key, value) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  // Step3 → 创建企业（含默认项目 + 当前账号 CompanyMember），拿到 companyId 后进 Step4
  function nextFromProfile() {
    const n = (name || '').trim();
    if (!n) {
      setErr('请填写企业名称');
      return;
    }
    setErr('');
    const c = createCompany(n, type, role);
    if (c && c.id) companyIdRef.current = c.id;
    setStep(4);
  }

  // Step7 让豆芽帮你定目标：复用 recommendGoals（AI 从 21 目标挑 3-5 个，带 reason + fit）
  async function aiSuggestGoal() {
    if (goalBusy) return;
    setGoalBusy(true);
    setAiSuggestions([]);
    const list = await recommendGoals({
      currentCompany,
      asset: assetRef.current || {},
      knowledge: getKnowledge(companyIdRef.current),
      companyType: type,
      role,
    });
    setAiSuggestions(
      (list || []).map((s) => ({
        ...s,
        label: GOAL_LABEL_BY_ID[s.goalId] || s.goalId,
        category: classifyGoalCategory(GOAL_LABEL_BY_ID[s.goalId] || ''),
      })),
    );
    setGoalBusy(false);
  }

  // 点选豆芽建议的目标 → 填入陈述，标记 ai 来源
  function pickAiSuggestion(s) {
    setGoalStatement(s.label);
    setGoalCategory(s.category || 'custom');
    setGoalSource('ai');
    setAiSuggestions([]);
  }

  // ---- Step5（新）品牌归属：读 / 写子品牌矩阵，联网候选只做「候选」，确认前不写库 ----

  /** 读当前企业已登记的旗下 IP / 子品牌（已归一化）。 */
  function currentBrandIps() {
    const cid = companyIdRef.current;
    if (!cid) return [];
    const k = getKnowledge(cid);
    return k && k.profile && Array.isArray(k.profile.brandIps) ? k.profile.brandIps : [];
  }

  /**
   * 联网检索「母公司名」可能的旗下子品牌 / 产品线 IP —— 结果一律当**候选**，不写库。
   * 合规红线：不得编造企业信息；检索不到就给空态 + 提示，绝不塞虚假品牌名。
   *
   * 2026-09-14 统一实现：改走通用 service `fetchWebCandidates`（= 联网大模型 + extractJSON 结构化解析，
   * 失败再回退「每行一个名称」的行解析），与「你的企业资产库 → 子品牌矩阵 / 资产页 6 字段」同源，
   * 不再在此处维护一套朴素的纯行切分。service 内部自己 try/catch，不会向外抛；
   * 返回值区分「检索失败」({ok:false}) 与「确实没检索到」({ok:true, candidates:[]})，前端据此给诚实文案。
   */
  async function runBrandCandidateSearch() {
    if (brandCandState === 'searching') return;
    setBrandCandState('searching');
    setBrandMsg('');
    setBrandErr('');
    const companyName = (name || '').trim();
    const existing = currentBrandIps().map((ip) => ip && ip.name).filter(Boolean);
    const res = await fetchWebCandidates({ kind: 'brand', companyName, existing });
    if (!res || res.ok === false) {
      setBrandCandState('failed');
      setBrandErr((res && res.error) || (isWebConfirmed(webHealth)
        ? '联网检索暂不可用，可稍后在「你的企业资产库 → 子品牌矩阵」手动补充。'
        : '候选检索暂不可用（未确证联网），可稍后在「你的企业资产库 → 子品牌矩阵」手动补充。'));
      return;
    }
    const names = (res.candidates || []).map((c) => c.name).filter(Boolean);
    setBrandCands(names);
    setBrandPicked(new Set());
    setBrandCandState('done');
    if (names.length === 0) setBrandErr(res.error || '没检索到明确的子品牌名称，可手动添加。');
  }

  /** 勾选 / 取消勾选一个联网候选品牌。 */
  function toggleBrandCand(nm) {
    setBrandPicked((prev) => {
      const next = new Set(prev);
      if (next.has(nm)) next.delete(nm);
      else next.add(nm);
      return next;
    });
  }

  /**
   * 把**用户勾选确认**的候选写入子品牌矩阵。
   * 关键：只有走到这里（用户主动点了「确认添加选中」）才 setBrandIps；
   * 候选本身在此之前从不落库（老板第 10 条 + 合规红线）。
   */
  function confirmBrandCandidates() {
    const cid = companyIdRef.current;
    if (!cid) {
      setBrandErr('企业尚未创建，无法保存。');
      return;
    }
    const picked = brandCands.filter((nm) => brandPicked.has(nm));
    if (picked.length === 0) {
      setBrandErr('请先勾选要添加的候选品牌。');
      return;
    }
    const existing = currentBrandIps();
    const next = existing.concat(
      picked.map((nm) => ({ name: nm, note: `来源：${candidateSourceLabel(webHealth)}（已由用户确认）` })),
    );
    setBrandIps(cid, next);
    setBrandMsg(`已添加 ${picked.length} 个候选品牌（来源：${candidateSourceLabel(webHealth)} · 已确认），可在「子品牌矩阵」继续编辑。`);
    setBrandErr('');
    setBrandCands((prev) => prev.filter((nm) => !brandPicked.has(nm)));
    setBrandPicked(new Set());
  }

  /**
   * Step5「继续」：落库品牌归属（母公司 / 某一个品牌），并作为带来源标注的企业事实，
   * 让后续经营诊断对准正确的监控对象，然后进入「补充企业知识」。
   */
  function confirmBrandAttribution() {
    const cid = companyIdRef.current;
    if (!cid) {
      setErr('企业尚未创建，请返回上一步重试');
      return;
    }
    if (brandType === 'brand' && !String(brandFocus || '').trim()) {
      setErr('请填写你关注的品牌名称，或改选「母公司 / 公司主体」');
      return;
    }
    setErr('');
    const parent = String(brandParent || '').trim();
    const focus = String(brandFocus || '').trim();
    updateProfile(cid, {
      brandType,
      brandParent: brandType === 'brand' ? parent : '',
    });
    if (brandType === 'brand') {
      addFact(cid, `品牌归属（用户填写）：当前关注的是品牌「${focus}」${parent ? `，所属母公司「${parent}」` : ''}。`);
    } else {
      addFact(cid, '品牌归属（用户填写）：当前企业按「母公司 / 公司主体」处理。');
    }
    setStep(6);
  }

  /** 一键全选 / 清空联网候选（老板 2026-09-14 拍板 D 项：批量勾选、一次确认）。 */
  function toggleAllBrandCands() {
    setBrandPicked((prev) => (prev.size === brandCands.length ? new Set() : new Set(brandCands)));
  }

  /**
   * 「我不确定」→ 让豆芽联网判断本企业该按「母公司 / 公司主体」还是「旗下某一个品牌」处理。
   *
   * 2026-09-14 老板拍板 B 项：品牌归属**必填**（选错会盯错诊断对象），
   * 所以这里不再留「什么都不写就跳过」的路径 —— 但用户确实可能不知道自己是哪种，
   * 于是把原来的「跳过」出口改成「交给豆芽联网判断」。
   *
   * 合规红线：联网判断结果一律作为「AI 推断，请核对」写进企业事实，绝不冒充用户填写或实测；
   * 判断不出来时**不放行**，留在本步让用户手动选。
   */
  async function aiFillBrandAttribution() {
    if (brandAiState === 'asking') return;
    const cid = companyIdRef.current;
    if (!cid) {
      setErr('企业尚未创建，请返回上一步重试');
      return;
    }
    setErr('');
    setBrandErr('');
    setBrandMsg('');
    setBrandAiState('asking');

    const companyName = (name || '').trim() || '这家企业';
    const descBits = Object.entries(fields || {})
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([k, v]) => `${k}：${String(v).trim()}`)
      .slice(0, 8)
      .join('；');

    let r = null;
    try {
      // T16：改走真检索（judgeBrandAttribution = fetchWebSearch 实检 → 注入资料 → 模型判 JSON）。
      // 检索失败 / 0 条 / 模型没给合法 JSON → r.ok=false，下面按「没判断出来」诚实处理，绝不静默降级成纯模型推断。
      r = await judgeBrandAttribution({ companyName, descBits });
    } catch {
      r = null;
    }
    const j = r && r.ok && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : null;

    if (!j) {
      setBrandAiState('failed');
      // 来源诚实：r.source 由本次检索直接证据生成（失败 = 「未联网 · 模型推断」），不谎称「联网判断」。
      setBrandErr('豆芽这次没能判断出归属，请手动选一个（选错也没关系，之后可在「你的企业资产库 → 子品牌矩阵」修改）。');
      return;
    }

    const t = String(j.brandType || '').trim().toLowerCase() === 'brand' ? 'brand' : 'company';
    const focus = String(j.brandFocus || '').trim();
    const parent = String(j.brandParent || '').trim();
    const reason = String(j.reason || '').trim();

    if (t === 'brand' && !focus) {
      setBrandAiState('failed');
      setBrandErr('豆芽判断这属于某个品牌，但没能给出品牌名，请手动填写。');
      return;
    }

    // 回填到表单，让用户看得见豆芽判断成了什么（不静默写库）。
    setBrandType(t);
    if (t === 'brand') {
      setBrandFocus(focus);
      if (parent) setBrandParent(parent);
    }

    updateProfile(cid, { brandType: t, brandParent: t === 'brand' ? parent : '' });
    // T16：判据改用**本次检索的直接证据**（r.grounded：真拿到公开资料才为 true），
    // 比探针缓存更准，也不谎称「联网判断」。
    const webJudge = !!(r && r.grounded);
    const judgeWord = webJudge ? '联网判断' : '模型判断（未确证联网）';
    addFact(
      cid,
      t === 'brand'
        ? `品牌归属（AI 推断，请核对）：${judgeWord}当前关注的是品牌「${focus}」${parent ? `，所属母公司「${parent}」` : ''}。${reason ? `判断依据：${reason}` : ''}`
        : `品牌归属（AI 推断，请核对）：${judgeWord}当前企业按「母公司 / 公司主体」处理。${reason ? `判断依据：${reason}` : ''}`,
    );
    setBrandAiState('idle');
    setBrandMsg(`豆芽已${webJudge ? '联网判断' : '推断'}并记下（标注为「AI 推断」），你可随时在「你的企业资产库 → 子品牌矩阵」修改。`);
    setStep(6);
  }

  // Step6 补充企业知识：把补充字段写回营销资产（asset），并作为企业事实（facts）落库，让豆芽越来越懂企业
  function confirmKnowledge() {
    const cid = companyIdRef.current;
    for (const f of KNOWLEDGE_FIELDS) {
      const raw = String(knowFields[f.key] || '').trim();
      if (!raw) continue;
      let value = raw;
      if (f.type === 'tags') {
        value = raw.split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean);
      } else if (f.type === 'textarea') {
        value = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      }
      updateField(f.key, value);
      if (cid) {
        const text = Array.isArray(value) ? value.join('、') : value;
        if (text) {
          // 内容禁忌属「品牌规则」；竞品/卖点/客户/调性属「企业事实」
          if (f.key === 'contentTaboos') addRule(cid, f.label + '：' + text);
          else addFact(cid, f.label + '：' + text);
        }
      }
    }
    setErr('');
    setStep(7);
  }

  // Step7 确认目标 → 落库企业目标（方向盘）→ 进 Step8
  function confirmGoal() {
    const stmt = (goalStatement || '').trim();
    if (!stmt) {
      setErr('请先填写你的企业目标，或点「让豆芽帮你定」');
      return;
    }
    setErr('');
    if (companyIdRef.current) {
      setCompanyGoal(companyIdRef.current, {
        statement: stmt,
        category: goalCategory,
        source: goalSource,
        period: planPeriod,
      });
    }
    setStep(8);
  }

  // Step8 确认计划周期 → 进 Step9（整套方案由「今天做什么」自动铺进日历，此处不再收集日期）
  function confirmPlanAndDates() {
    setErr('');
    setStep(9);
  }

  // Step9 选经营方向 → 自动搭建完整链路（Direction + 主 Campaign）
  function chooseDirection(dirKey) {
    if (!companyIdRef.current) {
      setErr('企业尚未创建，请返回上一步重试');
      return;
    }
    if (choosingKey) return; // 防重复点击
    setChoosingKey(dirKey);
    const r = buildDirection(dirKey, { subjectType: type, companyName: name, source: 'onboarding' });
    if (!r.direction) {
      setChoosingKey(null);
      return;
    }
    const direction = createDirection({ ...r.direction, companyId: companyIdRef.current });
    if (r.campaign) {
      const c = createCampaign({ ...r.campaign, companyId: companyIdRef.current, status: 'planning' });
      if (c && c.id) attachCampaign(direction.id, c.id);
    }
    if (onDone) onDone({ guide: false, directionId: direction.id, directionKey: dirKey, companyId: companyIdRef.current });
  }

  // Step4 初始化营销大脑：企业资料落库 + 调 company-analyze 生成画像（失败降级，可跳过）
  useEffect(() => {
    if (step !== 4 || brainStarted) return;
    setBrainStarted(true);
    setBrainState('running');
    setBrainStepIdx(0);

    const cid = currentCompany && currentCompany.id;
    const clean = {};
    for (const f of fieldDefs) {
      const v = fields[f.key];
      if (v != null && String(v).trim() !== '') clean[f.key] = String(v).trim();
    }
    if (cid) updateProfile(cid, clean);

    const industry = clean.industry || clean.clinicType || '';
    const brandDesc = clean.summary || clean.brandPositioning || '';
    const products = clean.products || clean.coreProjects || '';
    const audience = clean.targetCustomers || '';

    const t1 = setTimeout(() => setBrainStepIdx(1), 420);
    const t2 = setTimeout(() => setBrainStepIdx(2), 880);

    (async () => {
      // 联网搜索企业：让豆芽在用户填完公司名后，先联网了解企业公开信息（结果展示在识别卡）。
      // 与 buildAsset 并行，避免慢搜索阻塞画像进度。
      setWebState('searching');
      const webPromise = (async () => {
        try {
          // T16：改走真检索（searchCompanyIntro = fetchWebSearch 实检 → 注入资料 → 模型概括）。
          // 检索失败 / 0 条 / 模型无返回 → ok=false → w='' → setWebState('failed')，诚实报「没查到」，绝不谎称检索到。
          const r = await searchCompanyIntro({
            companyName: (name || '').trim(),
            industry,
            question:
              '请依据检索到的公开资料，说明口腔行业相关企业「' + (name || '').trim() + '」' +
              (fields.intro ? '（补充：' + String(fields.intro).trim() + '）' : '') +
              '。用 3-5 句话说明：这是一家什么公司、主营业务/产品、目标客户、在行业里的定位。' +
              '只依据上述资料作答；若公开信息很少，请诚实说明「公开信息较少」，不要编造。',
          });
          const w = r && r.ok && r.text ? String(r.text).trim() : '';
          setWebState(w ? 'done' : 'failed');
          return w;
        } catch (e) {
          setWebState('failed');
          return '';
        }
      })();

      let ok = false;
      try {
        const r = await buildAsset({
          companyName: (name || '').trim(),
          industry,
          brandDesc,
          products,
          audience,
        });
        ok = !!(r && r.ok);
      } catch (e) {
        ok = false;
      }

      const ws = await webPromise;
      setWebSummary(ws);

      // 分析完 → 企业体检（全方位理解 + 短板 + 整改）。
      // 刻意不 await：不拖住「继续」按钮，报告就绪后自行出现；失败降级为可读失败态 + 重试。
      runCheckup(ws);

      setBrainStepIdx(3);
      setBrainState(ok ? 'done' : 'degraded');
      setBrainNote(
        ok
          ? '营销大脑已就绪，AI 将基于企业画像深度思考。'
          : 'AI 分析暂不可用，已保留你手动填写的资料，可稍后在「资产库」补充完善。',
      );

      // 首次建档后台深度思考：产出 brain 供后续 GEO / 竞品 / 账号矩阵 / 活动策划复用。
      // 后台异步、可跳过，出错静默降级，不阻断建档流程；deepThinkOnce 防同企业重复触发。
      if (ok && cid) {
        const company = currentCompany;
        const knowledge = getKnowledge(cid);
        setTimeout(() => {
          deepThinkOnce(cid, () => runDeepThink({ company, asset: assetRef.current || {}, knowledge }))
            .then((brain) => {
              if (brain) {
                setBrain(cid, brain);
                // 把 AI 深度思考结果提炼成可读摘要，展示在识别卡（让用户看到「豆芽了解了什么」）
                const ins = [];
                if (brain.competitors && brain.competitors.length) ins.push('识别到 ' + brain.competitors.length + ' 个竞品候选，待核实（来源见竞品页）');
                if (brain.operatingInsights && brain.operatingInsights.length) ins.push(brain.operatingInsights.length + ' 条运营洞察');
                if (brain.platformAccounts && brain.platformAccounts.length) ins.push(brain.platformAccounts.length + ' 个建议平台账号');
                setBrainInsights(ins.length ? ins : null);
              }
            })
            .catch((e) => console.warn('[deepThink] 建档深度思考失败，已静默降级', e));
        }, 0);
      }
    })();

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [step, brainStarted]);

  function skipToWorkbench() {
    // 不选方向：语义 = 铺全部方向，故不带 directionKey，仅带上企业 id 供下游记录。
    if (onDone) onDone({ guide: false, companyId: companyIdRef.current });
  }

  const headTitle = STEP_TITLES[step] || '';

  return (
    <div className="ob-overlay">
      <div className="ob-card ob-card-lg">
        {/* 欢迎页（首屏，独立不显示步骤点） */}
        {step === 0 && (
          <div className="ob-welcome">
            <img className="ob-welcome-icon" src={douyaMascot} alt="" draggable="false" />
            <div className="ob-title">欢迎来到豆芽</div>
            <div className="ob-sub">先告诉我你的企业现在是什么情况。我会帮你整理企业信息、找到当前经营重点，并告诉你接下来应该做什么。</div>
            <div className="ob-foot">
              <Button type="primary" block onClick={() => setStep(1)}>快速开始</Button>
              <Button type="text" block onClick={() => onDone && onDone({ guide: false })}>我先看看</Button>
            </div>
          </div>
        )}

        {/* 步骤指示（欢迎页后显示） */}
        {step > 0 && (
        <div className="ob-steps">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => (
            <div key={s} className={'ob-stepdot' + (s <= step ? ' active' : '')}>
              <span className="ob-stepdot-n">{s}</span>
            </div>
          ))}
        </div>
        )}
        {step > 0 && (
        <div className="ob-head">
          <div className="ob-title">{headTitle}</div>
          <div className="ob-sub">
            {step === 1 && '先选择你的企业类型，配置将自动适配'}
            {step === 2 && '角色决定你在这家企业能做什么（归属于企业成员）'}
            {step === 3 && '填写基础资料，AI 将据此构建企业画像'}
            {step === 4 && (webHealth && webHealth.available === true
              ? '正在联网搜索并构建营销大脑，让豆芽先了解你的企业'
              : '正在识别企业公开信息、构建营销大脑，让豆芽先了解你的企业')}
            {step === 5 && '你刚填的是母公司，还是它旗下的某一个品牌？这决定豆芽对准谁做诊断与监控'}
            {step === 6 && '告诉豆芽你的竞品、卖点、目标客户与品牌调性，让它越来越懂你'}
            {step === 7 && '今年你最想让企业发生什么变化？这是整个经营的方向盘'}
            {step === 8 && '选一个时间尺度，豆芽会把整套经营方案直接铺进日历'}
            {step === 9 && '按你的企业类型，豆芽给你几个经营方向，选一个开始；也可以不选，让豆芽直接给一整套'}
          </div>
        </div>
        )}

        {/* Step1 企业类型 */}
        {step === 1 && (
          <>
            <div className="ob-types">
              {TYPE_CARDS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={'ob-type' + (type === t.key ? ' active' : '')}
                  onClick={() => setType(t.key)}
                >
                  <span className="ob-type-icon">{t.icon}</span>
                  <span className="ob-type-body">
                    <span className="ob-type-label">{t.label}</span>
                    <span className="ob-type-desc">{t.desc}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="ob-foot">
              <Button type="primary" block onClick={() => setStep(2)}>下一步</Button>
            </div>
          </>
        )}

        {/* Step2 角色 */}
        {step === 2 && (
          <>
            <div className="ob-roles">
              {ROLES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={'ob-role' + (role === r.key ? ' active' : '')}
                  onClick={() => setRole(r.key)}
                >
                  <span className="ob-role-icon">{r.icon}</span>
                  <span className="ob-role-body">
                    <span className="ob-role-label">{r.label}</span>
                    <span className="ob-role-desc">{r.desc}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(1)}>上一步</Button>
              <Button type="primary" block onClick={() => setStep(3)}>下一步</Button>
            </div>
          </>
        )}

        {/* Step3 基本资料 */}
        {step === 3 && (
          <>
            <div className="ob-label">企业名称 *</div>
            <input
              className="login-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === 'clinic' ? '例如：康健苗苗口腔门诊' : '例如：康健苗苗集团'}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') nextFromProfile(); }}
            />
            {err && <div className="login-err">{err}</div>}

            <div className="ob-label">基本资料（选填，可稍后完善）</div>
            <div className="ob-fields">
              {fieldDefs.map((f) => (
                <div className="ob-field" key={f.key}>
                  <span className="ob-field-label">{f.label}</span>
                  {f.type === 'textarea' ? (
                    <textarea
                      className="login-input ob-textarea"
                      value={fields[f.key] || ''}
                      onChange={(e) => setField(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      rows={2}
                    />
                  ) : (
                    <input
                      className="login-input"
                      value={fields[f.key] || ''}
                      onChange={(e) => setField(f.key, e.target.value)}
                      placeholder={f.placeholder}
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="ob-label">一句话介绍你的企业 / 产品</div>
            <textarea
              className="login-input ob-textarea"
              value={fields.intro || ''}
              onChange={(e) => setField('intro', e.target.value)}
              placeholder="例如：我们是一家做AI医学影像辅助诊断的医疗科技公司，主要服务三甲医院。"
              rows={3}
            />

            <div className="ob-label">你现在最想推动什么？</div>
            <div className="ob-topics">
              {TOPICS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={'ob-topic' + (topPriority === t.label ? ' active' : '')}
                  onClick={() => setTopPriority(t.label)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(2)}>上一步</Button>
              <Button type="primary" block onClick={nextFromProfile}>创建企业</Button>
            </div>
          </>
        )}

        {/* Step4 初始化营销大脑 */}
        {step === 4 && (
          <>
            <div className="ob-brains">
              {BRAIN_STEPS.map((b, i) => {
                const done = i <= brainStepIdx;
                return (
                  <div key={b.key} className={'ob-brain' + (done ? ' done' : '')}>
                    <span className="ob-brain-dot">{done ? '✓' : '·'}</span>
                    <span className="ob-brain-label">{b.label}</span>
                  </div>
                );
              })}
            </div>
            {brainNote && <div className="ob-brain-note">{brainNote}</div>}
            {(brainState === 'done' || brainState === 'degraded') && (
              <div className="ob-recog">
                <div className="ob-recog-title">豆芽认识你的企业</div>
                <div className="ob-recog-row"><span className="ob-recog-k">企业</span><span className="ob-recog-v">{name || '—'}</span></div>
                <div className="ob-recog-row"><span className="ob-recog-k">类型</span><span className="ob-recog-v">{cfg.label}</span></div>
                <div className="ob-recog-row"><span className="ob-recog-k">一句话 / 核心产品</span><span className="ob-recog-v">{fields.intro || fields.summary || fields.products || fields.coreProjects || '—'}</span></div>
                <div className="ob-recog-row"><span className="ob-recog-k">当前重点</span><span className="ob-recog-v">{topPriority || '暂未选择'}</span></div>
                <div className="ob-recog-row"><span className="ob-recog-k">已有资产</span><span className="ob-recog-v">产品资料 · 企业介绍</span></div>
                {webState === 'searching' && (
                  <div className="ob-recog-row"><span className="ob-recog-k">{onboardingSearchKey(webHealth)}</span><span className="ob-recog-v">{searchingText(webHealth, name)}</span></div>
                )}
                {webState === 'done' && webSummary && (
                  <div className="ob-recog-row">
                    <span className="ob-recog-k">豆芽了解到</span>
                    <span className="ob-recog-v">{webSummary}</span>
                  </div>
                )}
                {webState === 'failed' && (
                  <div className="ob-recog-row"><span className="ob-recog-k">{onboardingSearchKey(webHealth)}</span><span className="ob-recog-v">公开信息较少，豆芽将基于你填写的资料继续。</span></div>
                )}
                {brainInsights && brainInsights.length > 0 && (
                  <div className="ob-recog-row"><span className="ob-recog-k">深度分析</span><span className="ob-recog-v">{brainInsights.join(' · ')}</span></div>
                )}
                <div className="ob-recog-judge">下一步建议：围绕当前重点建立一次完整的营销专项。</div>
              </div>
            )}

            {/* 识别确认：联网检索会认错 —— 名字相近 / 刚注册查不到。这里必须让用户能表态、能自己填 */}
            {(webState === 'done' || webState === 'failed') && (
              <div className="ob-identity">
                {hasWebResult ? (
                  <div className="ob-identity-q">
                    上面检索到的，是你要做的这家公司吗？
                    <span className="ob-identity-sub">{onboardingSearchKey(webHealth)}容易认错（同名 / 名字相近 / 子公司），请确认一下 —— 认错了后面的体检和方案都会建错公司。</span>
                  </div>
                ) : (
                  <div className="ob-identity-q">
                    公开信息太少，豆芽没认准这家公司。
                    <span className="ob-identity-sub">刚注册、个体诊所或没做过公开曝光的公司经常查不到。你可以自己填一句，也可以直接继续（后续在企业大脑里随时补）。</span>
                  </div>
                )}
                <div className="ob-identity-btns">
                  {hasWebResult && (
                    <button
                      type="button"
                      className={'ob-identity-btn' + (identityState === 'confirmed' ? ' active' : '')}
                      onClick={() => { setPickedCompanyName(''); setIdentityState('confirmed'); }}
                    >
                      对，就是这家
                    </button>
                  )}
                  <button
                    type="button"
                    className={'ob-identity-btn' + (identityState === 'manual' ? ' active' : '')}
                    onClick={() => { setPickedCompanyName(''); setIdentityState('manual'); }}
                  >
                    不对，我自己填
                  </button>
                </div>
                {/* 同名 / 相似企业主体候选：从真联网检索里挑那家真正要做的公司（候选未确认前绝不写库） */}
                <button
                  type="button"
                  className="ob-identity-btn"
                  style={{ marginTop: 10 }}
                  onClick={() => setShowCompanyPicker((v) => !v)}
                >
                  {showCompanyPicker ? '收起同名企业检索' : '咦，是不是有同名企业？'}
                </button>
                {showCompanyPicker && (
                  <div style={{ marginTop: 10 }}>
                    <WebCandidatePicker
                      label="同名 / 相似企业"
                      kind="company"
                      companyName={name || ''}
                      industry={cfg.label || ''}
                      existing={[]}
                      onConfirm={onConfirmCompanyCandidate}
                    />
                  </div>
                )}
                {identityState === 'confirmed' && (
                  <div className="ob-identity-ok">
                    已确认：{name || '本企业'}。豆芽会以这家公司的信息继续。
                    {pickedCompanyName && (
                      <div>已按你的选择锁定企业主体：<strong>{pickedCompanyName}</strong>（来源：联网检索候选）</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {identityState === 'manual' && (
              <div className="ob-manual">
                <div className="ob-label">企业全称（识别错了就顺手改过来）</div>
                <input
                  className="login-input"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder={`例如：${name || '杭州某某口腔门诊有限公司'}`}
                />
                <div className="ob-label">一句话说清：你是做什么的、卖给谁</div>
                <textarea
                  className="ob-textarea"
                  rows={3}
                  value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  onBlur={() => { if (manualCheck.ok) runManualJudge(); }}
                  placeholder="例如：杭州口腔门诊，做种植和正畸，客户是周边 45 岁以上缺牙患者"
                />
                {!manualCheck.ok && manualDesc.trim() !== '' && (
                  <div className="ob-manual-err">{manualCheck.reason}</div>
                )}
                <div className="ob-manual-row">
                  <button
                    type="button"
                    className="ob-identity-btn"
                    disabled={!manualCheck.ok || manualJudgeState === 'running'}
                    onClick={runManualJudge}
                  >
                    {manualJudgeState === 'running' ? '豆芽正在读…' : '让豆芽复述确认'}
                  </button>
                  {manualCheck.ok && <span className="ob-manual-ok">已够用，可以继续</span>}
                </div>
                {manualJudgeState === 'done' && manualJudge && (
                  <div className="ob-manual-judge">
                    <span className="ob-manual-judge-k">豆芽理解为</span>
                    {manualJudge}
                    <span className="ob-manual-judge-tip">不对就改上面的描述再让它读一次。</span>
                  </div>
                )}
                {manualJudgeState === 'failed' && (
                  <div className="ob-manual-judge-tip">豆芽这次没能复述（AI 未返回），不影响继续 —— 你填的内容会原样建进企业档案。</div>
                )}
              </div>
            )}

            {/* 企业体检：分析完之后，回答「豆芽到底了解了什么、短板在哪、先整改什么」 */}
            {checkupState === 'running' && (
              <div className="ob-ck-loading">
                <span className="ob-ck-spin" />
                豆芽正在通读你的企业资料，给你出一份体检…
              </div>
            )}
            {checkupState === 'failed' && (
              <div className="ob-ck-failed">
                <span className="ob-ck-failed-txt">豆芽这次没能给出体检结果（{checkupErr || 'AI 未返回结果'}），你的资料已保留。</span>
                <button type="button" className="ob-ck-retry" onClick={() => runCheckup(webSummary)}>重新体检</button>
              </div>
            )}
            {checkupState === 'done' && checkup && (
              <div className="ob-checkup">
                <div className="ob-ck-head">
                  <span className="ob-ck-title">豆芽对你的企业体检</span>
                  <span className="ob-ck-tag">AI假设 · 非既成事实</span>
                </div>
                {checkup.summary && (
                  <div className="ob-ck-summary">最该先解决的一件事：{checkup.summary}</div>
                )}

                {checkup.understood.length > 0 && (
                  <div className="ob-ck-sec">
                    <div className="ob-ck-sec-title">豆芽了解到的（{checkup.understood.length} 项）</div>
                    {checkup.understood.map((u) => (
                      <div className="ob-ck-row" key={u.label}>
                        <span className="ob-ck-k">{u.label}</span>
                        <span className="ob-ck-v">{u.value}</span>
                        <span className={'ob-ck-from ob-ck-from-' + u.from}>
                          {u.from === 'web' ? checkupWebFromLabel() : (CHECKUP_FROM_LABEL[u.from] || CHECKUP_FROM_LABEL.ai)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {checkup.gaps.length > 0 && (
                  <div className="ob-ck-sec">
                    <div className="ob-ck-sec-title">发现的短板（{checkup.gaps.length} 项）</div>
                    {checkup.gaps.map((g) => (
                      <div className="ob-ck-gap" key={g.title}>
                        <span className="ob-ck-gap-title">{g.title}</span>
                        <span className="ob-ck-gap-why">依据：{g.why}</span>
                      </div>
                    ))}
                  </div>
                )}

                {checkup.fixes.length > 0 && (
                  <div className="ob-ck-sec">
                    <div className="ob-ck-sec-title">建议先整改</div>
                    {checkup.fixes.map((f, i) => (
                      <div className="ob-ck-fix" key={f.gap + '#' + i}>
                        <span className="ob-ck-fix-gap">{f.gap}</span>
                        <span className="ob-ck-fix-act">{f.action}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="ob-ck-foot">豆芽会基于这些短板，在选方案那一步告诉你每个方案怎么补。</div>
              </div>
            )}

            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(3)}>上一步</Button>
              <Button type="primary" block disabled={!identityGate.canContinue} onClick={goNextFromBrain}>继续</Button>
            </div>
            {!identityGate.canContinue && identityGate.reason && (
              <div className="ob-manual-err">{identityGate.reason}</div>
            )}
            <div className="ob-skip" onClick={skipToWorkbench}>跳过初始化，直接进入工作台</div>
          </>
        )}

        {/* Step5（新）品牌归属：母公司 / 某一个品牌（老板第 2、10 条） */}
        {step === 5 && (
          <>
            <div className="ob-brand">
              <div className="ob-brand-q">
                你刚填的「<span className="ob-brand-q-name">{name || '这家企业'}</span>」是<span className="ob-brand-q-name">母公司</span>，还是它旗下的<span className="ob-brand-q-name">某一个品牌</span>？
              </div>
              <div className="ob-brand-sub">
                这不只是叫法问题：填的是母公司，豆芽就按整家公司做诊断；填的是旗下某个品牌（例如「康健苗苗」旗下的「上游货源」），豆芽就对准这个品牌做诊断与监控。选错会盯错对象。
              </div>

              <div className="ob-brand-choices">
                {Object.values(BRAND_ATTRIBUTION).map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    className={'ob-brand-choice' + (brandType === b.key ? ' active' : '')}
                    onClick={() => setBrandType(b.key)}
                  >
                    <span className="ob-brand-choice-label">{b.label}</span>
                    <span className="ob-brand-choice-desc">{b.desc}</span>
                  </button>
                ))}
              </div>

              {brandType === 'company' ? (
                <div className="ob-brand-panel">
                  <div className="ob-brand-panel-title">旗下子品牌 / 产品线 IP（可留空，后面随时补）</div>
                  <div className="ob-brand-sub" style={{ marginBottom: 8 }}>
                    你填的是母公司，可把旗下每个品牌都登记起来，以后 AI 会分别盯着它们的口碑。也可以跳过，稍后在「你的企业资产库 → 子品牌矩阵」维护。
                  </div>
                  {/* enableWebSearch={false}：本步下方已自带同款「🔍 联网找候选子品牌」，
                      关掉 BrandIpManager 内置入口避免重复（且该入口被 onboarding-identity.mjs 场景C 断言依赖）。 */}
                  <BrandIpManager companyId={companyIdRef.current} mainBrandName={name || ''} enableWebSearch={false} />

                  <div className="ob-brand-actions" style={{ marginTop: 10 }}>
                    <Button
                      size="small"
                      className="ob-brand-search-btn"
                      loading={brandCandState === 'searching'}
                      onClick={runBrandCandidateSearch}
                    >
                      {webFindButtonText(webHealth, '子品牌')}
                    </Button>
                    <span className="ob-brand-hint">{candidateHintText(webHealth)}</span>
                  </div>

                  {brandCandState === 'done' && brandCands.length > 0 && (
                    <div className="ob-brand-cands">
                      <div className="ob-brand-cand-head">
                        {candidateListHeading(webHealth)}子品牌
                        <span className="ob-brand-cand-src">{candidatePickerNote(webHealth)}</span>
                        <button type="button" className="ob-brand-cand-all" onClick={toggleAllBrandCands}>
                          {brandPicked.size === brandCands.length ? '清空' : '全选'}
                        </button>
                      </div>
                      {brandCands.map((nm) => (
                        <label className="ob-brand-cand" key={nm}>
                          <input type="checkbox" checked={brandPicked.has(nm)} onChange={() => toggleBrandCand(nm)} />
                          <span>{nm}</span>
                        </label>
                      ))}
                      <div className="ob-brand-actions" style={{ marginTop: 6 }}>
                        <Button size="small" type="primary" disabled={brandPicked.size === 0} onClick={confirmBrandCandidates}>
                          确认添加选中（{brandPicked.size}）
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="ob-brand-panel">
                  <div className="ob-brand-panel-title">你关注的品牌 & 所属母公司</div>
                  <div className="ob-brand-field">
                    <span className="ob-brand-field-label">你关注的品牌是哪一个？*</span>
                    <input
                      className="login-input"
                      value={brandFocus}
                      onChange={(e) => setBrandFocus(e.target.value)}
                      placeholder="例如：上游货源"
                    />
                  </div>
                  <div className="ob-brand-field">
                    <span className="ob-brand-field-label">它所属的母公司（选填）</span>
                    <input
                      className="login-input"
                      value={brandParent}
                      onChange={(e) => setBrandParent(e.target.value)}
                      placeholder="例如：康健苗苗"
                    />
                  </div>
                </div>
              )}

              {brandMsg ? <div className="ob-brand-msg">{brandMsg}</div> : null}
              {brandErr ? <div className="ob-brand-err">⚠️ {brandErr}</div> : null}
            </div>

            {err && <div className="login-err">{err}</div>}
            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(4)}>上一步</Button>
              <Button type="primary" block onClick={confirmBrandAttribution}>下一步</Button>
            </div>
            <div className="ob-skip" onClick={aiFillBrandAttribution}>
              {brandAiState === 'asking'
                ? (isWebConfirmed(webHealth) ? '豆芽正在联网判断这家是母公司还是品牌…' : '豆芽正在判断这家是母公司还是品牌（未确证联网）…')
                : (isWebConfirmed(webHealth) ? '我不确定，让豆芽联网帮我判断' : '我不确定，让豆芽帮我判断')}
            </div>
          </>
        )}

        {/* Step6 补充企业知识（让豆芽更懂企业） */}
        {step === 6 && (
          <>
            <div className="ob-label">补充企业知识（选填，让豆芽越来越懂你）</div>
            <div className="ob-hint" style={{ marginTop: 0 }}>
              这些内容会让豆芽更懂你的企业——竞品怎么做声量对比、卖点怎么写文案、目标客户怎么投媒体、调性怎么统一语气、禁忌怎么避雷。可在「你的企业资产库 → 企业大脑」补充。
            </div>
            <div className="ob-fields">
              {KNOWLEDGE_FIELDS.map((f) => (
                <div className="ob-field" key={f.key}>
                  <span className="ob-field-label">{f.label}</span>
                  {f.type === 'textarea' ? (
                    <textarea
                      className="login-input ob-textarea"
                      value={knowFields[f.key] || ''}
                      onChange={(e) => setKnowField(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      rows={2}
                    />
                  ) : (
                    <input
                      className="login-input"
                      value={knowFields[f.key] || ''}
                      onChange={(e) => setKnowField(f.key, e.target.value)}
                      placeholder={f.placeholder}
                    />
                  )}
                  <div className="ob-hint">为什么豆芽需要：{f.hint}</div>
                </div>
              ))}
            </div>
            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(5)}>上一步</Button>
              <Button type="primary" block onClick={confirmKnowledge}>下一步</Button>
            </div>
            <div className="ob-skip" onClick={() => setStep(7)}>先跳过，稍后在「你的企业资产库 → 企业大脑」补充</div>
          </>
        )}

        {/* Step7 立企业目标（方向盘） */}
        {step === 7 && (
          <>
            <div className="ob-label">今年你最想让企业发生什么变化？</div>
            <div className="ob-goal-cats">
              {GOAL_CATEGORY_CARDS.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className={'ob-goal-cat' + (goalCategory === g.key ? ' active' : '')}
                  onClick={() => { setGoalCategory(g.key); setGoalSource('user'); }}
                >
                  <span className="ob-goal-cat-label">{g.label}</span>
                  <span className="ob-goal-cat-desc">{g.desc}</span>
                </button>
              ))}
            </div>

            <div className="ob-label">具体目标（一句话，可量化更好）</div>
            <textarea
              className="login-input ob-textarea"
              value={goalStatement}
              onChange={(e) => { setGoalStatement(e.target.value); setGoalSource('user'); }}
              placeholder={GOAL_CATEGORIES[goalCategory].question}
              rows={2}
            />

            <Button size="small" type="text" onClick={aiSuggestGoal} loading={goalBusy}>
              让豆芽帮你定目标
            </Button>

            {aiSuggestions.length > 0 && (
              <div className="ob-goal-suggest">
                <div className="ob-goal-suggest-tip">豆芽结合你的企业画像，建议优先考虑：</div>
                {aiSuggestions.map((s) => (
                  <button key={s.goalId} type="button" className="ob-goal-suggest-item" onClick={() => pickAiSuggestion(s)}>
                    <span className="ob-goal-suggest-label">{s.label}</span>
                    <span className="ob-goal-suggest-reason">{s.reason}</span>
                  </button>
                ))}
              </div>
            )}

            {err && <div className="login-err">{err}</div>}
            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(6)}>上一步</Button>
              <Button type="primary" block onClick={confirmGoal}>下一步</Button>
            </div>
          </>
        )}

        {/* Step8 计划周期 + 重要日期（活动日历） */}
        {step === 8 && (
          <>
            <div className="ob-label">你希望豆芽按什么时间尺度帮你规划？</div>
            <div className="ob-periods">
              {Object.values(PLAN_PERIODS).map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={'ob-period' + (planPeriod === p.key ? ' active' : '')}
                  onClick={() => setPlanPeriod(p.key)}
                >
                  <span className="ob-period-label">{p.label}</span>
                  <span className="ob-period-q">{p.question}</span>
                </button>
              ))}
            </div>

            <div className="ob-label">重要日期（展会、发布会、大促）不用你操心</div>
            <div className="ob-hint" style={{ marginTop: 0 }}>
              豆芽会按上面的时间尺度先生成一整套经营方案，直接铺进日历；到时候你在日历上增删调整就行。
            </div>

            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(7)}>上一步</Button>
              <Button type="primary" block onClick={confirmPlanAndDates}>下一步</Button>
            </div>
          </>
        )}

        {/* Step9 选经营方向（豆芽给 3 个方案 → 选一个 → 自动搭建） */}
        {step === 9 && (
          <>
            <div className="ob-done">
              <div className="ob-done-title">豆芽给你 {directions.length} 套运营方案，每套对应一个经营方向</div>
              <div className="ob-done-sub">
                {dirAiOk
                  ? `豆芽已按你的目标${goalStatement ? `「${goalStatement}」` : ''}${checkup && checkup.gaps.length ? '和体检发现的短板' : ''}判断了优先级，第一个最该先做（AI假设）。选一个，豆芽会把整条经营链路搭起来；也可以不选，先让豆芽给一整套方案，你自己在日历上改。`
                  : '选一个方案，豆芽会把整条经营链路搭起来（目标 → 专项 → 传播 → 执行 → 监测）；也可以不选，先让豆芽给一整套方案，你自己在日历上改。'}
              </div>
            </div>
            {dirBusy && <div className="ob-dir-loading">豆芽正在按你的目标判断优先级…</div>}
            {!dirBusy && !dirAiOk && dirAi && dirAi.ok === false && (
              <div className="ob-dir-degraded">
                <span>豆芽这次没能给出判断，先按原顺序展示。</span>
                <button type="button" className="ob-dir-retry" onClick={runDirectionAI}>让豆芽重新判断</button>
              </div>
            )}
            {dirAiOk && (
              <div className="ob-dir-ranked">
                <span className="ob-dir-ai-tag">AI假设</span>
                <span>下面是豆芽按你的目标排的优先顺序，可自己改选。</span>
                <button type="button" className="ob-dir-retry" onClick={runDirectionAI}>重新判断</button>
              </div>
            )}
            {checkup && checkup.gaps.length > 0 && (
              <div className="ob-dir-gaps">
                <div className="ob-dir-gaps-title">豆芽记得你这几个短板（体检结论）</div>
                <div className="ob-dir-gaps-list">
                  {checkup.gaps.map((g) => (
                    <span className="ob-dir-gap" key={g.title}>{g.title}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="ob-directions">
              {dirCards.map((d, idx) => (
                <button
                  key={d.key}
                  type="button"
                  className={'ob-direction' + (choosingKey === d.key ? ' choosing' : '')}
                  onClick={() => chooseDirection(d.key)}
                  disabled={!!choosingKey}
                >
                  <span className="ob-direction-head">
                    <span className="ob-direction-name">
                      {d.name}
                      {d.aiRanked && idx === 0 && d.aiReason ? <span className="ob-dir-first">豆芽建议先做</span> : null}
                    </span>
                    <span className="ob-direction-period">约 {d.expectedPeriodDays} 天</span>
                  </span>
                  <span className={'ob-direction-summary' + (d.aiReason ? ' ob-direction-ai' : '')}>
                    {d.aiReason || d.summary}
                  </span>
                  <span className="ob-direction-go">{choosingKey === d.key ? '搭建中…' : '确认这个方案 →'}</span>
                </button>
              ))}
            </div>
            {err && <div className="login-err">{err}</div>}
            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setStep(8)}>上一步</Button>
              <Button
                type="primary"
                block
                onClick={() =>
                  onDone &&
                  onDone({
                    guide: true,
                    brief: fields.intro || fields.summary || topPriority || name || '',
                    // 「让豆芽开始规划」出口：不带 directionKey，语义 = 铺全部方向。
                    companyId: companyIdRef.current,
                  })
                }
              >让豆芽开始规划（一句话描述）</Button>
              <Button type="text" onClick={skipToWorkbench}>不选了，让豆芽直接给一整套方案</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
