/**
 * ocpPlan.js —— 门诊运营教学（0.21.14 老板需求 2）的领域服务。
 *
 * 老板原话：
 *   「学习中心那个实操教学改成 门诊运营教学 教牙医和门诊的医生如何去运营自己的诊所，比如 如何获取客流量，
 *     采购的时候有哪些坑，如何跟用户解释定价，隔壁诊所价格比你更便宜怎么办，如何让老用户产生粘性，
 *     等等......要有专业的方案，不是每个诊所都一样的那种。」
 *
 * 落地口径（架构设计 §1.5 / §3.5，施工照做，不再选方案）：
 *   · 形态 = **一页方案**（不是聊天），固定四段 + 验收清单：
 *       现状判断 / 分步骤 / 可直接说的话 / 容易踩的坑 + 验收清单（≥4 条可勾选）
 *   · 「不是每个诊所都一样」靠 **5 维诊所画像**进提示词：规模（椅位数）/ 科室与主推项目 /
 *     区域 / 客单价带 / 主推服务。缺项在提示词里写「未填写」，页面上标「依据不完整」。
 *   · 5 个固定主题、顺序不许变：traffic → purchase → pricing → price_war → retention。
 *   · 画像落 `companyKnowledgeStore.profile.ocpProfile`（**新子对象，不是新 key**，零迁移）。
 *   · 缓存 `douya-ocp-cache`、勾选进度 `douya-ocp-progress` 各自按企业隔离（共享知识 S10）。
 *
 * ⚠️ P1（下一轮）接线：本轮的方案**只用模型自身知识**，不联网、不标来源。
 *    P1 接 `groundedSearch` 时，必须在正文顶部强制标注「未联网 · 模型推断」或实检条数
 *    （复用 services/groundedWebSearch.js 的 groundedSource 与 webSearchHonesty 的 candidateSourceNote），
 *    并且**不许**把模型推断谎称成联网所得（数据来源诚实红线）。
 *    那里只改 `generateOcpPlan` 取数一步，本文件其余纯函数与 UI 契约不变。
 *
 * 本文件无 React 依赖、无副作用注入，可在 node 里直接单测（见 scripts/smoke/unit-module-brief.mjs）。
 */

// ==================== 存储键（全部按企业隔离，S10） ====================

/** 企业知识主键：画像挂在 `[cid].profile.ocpProfile`（不新增 key）。 */
export const KNOWLEDGE_KEY = 'douya-company-knowledge';

/** 方案缓存：`{ [cid]: { [topic]: { text, generatedAt, basis } } }`。 */
export const OCP_CACHE_KEY = 'douya-ocp-cache';

/** 验收清单勾选进度：`{ [cid]: { [topic]: { checked: number[], done: boolean } } }`。 */
export const OCP_PROGRESS_KEY = 'douya-ocp-progress';

// ==================== 固定文案（共享知识 S5：错误态四句之一） ====================

/** 生成失败文案（固定，不得改写、不得与空态互换）。 */
export const OCP_ERROR_TEXT = '方案暂时生成不出来，请稍后再试';

/** 空态文案（固定四个字）。 */
export const OCP_EMPTY_TEXT = '暂无数据';

/** 画像缺项时页面上的标记（缺一维即显示）。 */
export const OCP_BASIS_INCOMPLETE_TEXT = '依据不完整';

/** 画像补全后的标记。 */
export const OCP_BASIS_COMPLETE_TEXT = '依据完整';

/** 缺项在提示词里的占位（不许编造数字）。 */
export const OCP_MISSING_TEXT = '未填写';

// ==================== 5 维诊所画像 ====================

/**
 * 画像的 5 个维度（顺序即表单顺序）。
 * 每条 string，缺 = ''（不设默认值、不猜 —— 铁律：硬从别的字段猜就是编数据）。
 */
export const OCP_PROFILE_FIELDS = [
  { key: 'scale', label: '规模（椅位 / 医生数）', placeholder: '如：3 台椅位 / 2 名医生' },
  { key: 'dept', label: '科室 · 主推项目', placeholder: '如：种植 · 儿牙' },
  { key: 'region', label: '区域（城市 / 商圈）', placeholder: '如：杭州 西湖区' },
  { key: 'priceBand', label: '客单价带', placeholder: '如：中端（单颗种植 5k-8k）' },
  { key: 'mainService', label: '主推服务', placeholder: '如：种植' },
];

/** 画像键名数组（basisOf / 归一化共用）。 */
export const OCP_PROFILE_KEYS = OCP_PROFILE_FIELDS.map((f) => f.key);

/**
 * 归一化画像：只保留 5 个已知维度，值一律转成去空字符串。
 * @param {object} raw 任意来源的画像对象
 * @returns {{scale:string, dept:string, region:string, priceBand:string, mainService:string}}
 */
export function normalizeOcpProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  OCP_PROFILE_KEYS.forEach((k) => {
    const v = src[k];
    out[k] = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  });
  return out;
}

/** 空画像（5 维全空）。 */
export function emptyOcpProfile() {
  return normalizeOcpProfile({});
}

/**
 * 5 维画像的「依据」判定。
 * @param {object} profile 画像
 * @returns {{total:number, filled:number, missing:string[], complete:boolean, label:string}}
 */
export function basisOf(profile) {
  const p = normalizeOcpProfile(profile);
  const missing = OCP_PROFILE_KEYS.filter((k) => !p[k]);
  const filled = OCP_PROFILE_KEYS.length - missing.length;
  const complete = missing.length === 0;
  return {
    total: OCP_PROFILE_KEYS.length,
    filled,
    missing,
    complete,
    label: complete ? OCP_BASIS_COMPLETE_TEXT : OCP_BASIS_INCOMPLETE_TEXT,
  };
}

/**
 * 合并画布补丁（只合已知维度，空串表示清空该维）。
 * @param {object} base 现有画像
 * @param {object} patch 待合并补丁
 * @returns {object} 合并后的 5 维画像
 */
export function mergeOcpProfile(base, patch) {
  const b = normalizeOcpProfile(base);
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = { ...b };
  OCP_PROFILE_KEYS.forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(p, k)) {
      const v = p[k];
      out[k] = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    }
  });
  return out;
}

// ==================== 5 个固定主题（顺序不许变，AC-2.2） ====================

/**
 * 主题列表。`id` 是锚点值（`data-ocp-topic`），`title` 是老板原话口径的标题，
 * `short` 是设计文档里的短名（仅供内部对照），`desc` 是卡片上的一句说明（用户可见，禁用技术词）。
 */
export const OCP_TOPICS = [
  {
    id: 'traffic',
    title: '怎么把客人引进来',
    short: '获客流量',
    desc: '让附近有需求的人先看见你、再走进来。',
    directive:
      '只讲获客流量：本地搜索、地图标注、老客转介绍、周边商户互换、社区筛查、线上内容。' +
      '按「投入人力 / 花费 / 见效周期」排优先顺序，每个动作写清谁来做、做几天、怎么判断有没有效果。',
  },
  {
    id: 'purchase',
    title: '采购有哪些坑',
    short: '采购避坑',
    desc: '耗材、设备、代加工，哪一步最容易多花钱。',
    directive:
      '只讲采购避坑：低价耗材的隐性成本、批次与效期、渠道来路、赠品与返点、以次充好、账期与压货。' +
      '每条都写清「怎么识别」「怎么规避」「已经踩了怎么处理」。',
  },
  {
    id: 'pricing',
    title: '怎么跟客人解释价格',
    short: '定价解释',
    desc: '把价格讲明白，客人自己就能做决定。',
    directive:
      '只讲怎么把价格解释清楚：把价钱拆成客人看得懂的部分、说清贵在哪里、给一个对比的参照、' +
      '讲清不做的后果、给分层选择。给出能直接照着说的句子，不要讲大道理。',
  },
  {
    id: 'price_war',
    title: '隔壁更便宜怎么办',
    short: '隔壁更便宜',
    desc: '不跟价也能把客人留下来。',
    directive:
      '只讲隔壁报价更低时的应对：先判断对方是真便宜还是缩了东西、把差别摊开对比、' +
      '把价值讲成客人听得懂的话、给不打折的替代做法（分期、套餐、加项、复诊保障）。',
  },
  {
    id: 'retention',
    title: '怎么让老客回头',
    short: '老客粘性',
    desc: '让来过一次的人，愿意再来第二次。',
    directive:
      '只讲老客回头：复诊与维护计划、跟进节奏、会员与储值、家庭成员联动、老带新的机制、离店后的联系。' +
      '每条写清什么时候做、由谁做、开口第一句怎么说。',
  },
];

/** 主题 id 顺序（写死，供门禁与渲染双向核对）。 */
export const OCP_TOPIC_IDS = OCP_TOPICS.map((t) => t.id);

/**
 * 按 id 取主题。
 * @param {string} topicId
 * @returns {object|null}
 */
export function findOcpTopic(topicId) {
  const id = String(topicId || '').trim();
  return OCP_TOPICS.find((t) => t.id === id) || null;
}

// ==================== localStorage 小工具（node 单测可注入桩） ====================

/** 读一个 JSON 键；任何异常/非法内容都退回 fallback（脏数据不许炸页面）。 */
function readJSON(key, fallback) {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 写一个 JSON 键；写失败静默（配额满等情况不打断用户操作）。 */
function writeJSON(key, value) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ==================== 画像读写（写 profile.ocpProfile，不新增 key） ====================

/**
 * 读某企业的 5 维诊所画像。
 *
 * @param {string} companyId 企业 id（缺省 → 空画像）
 * @param {{getKnowledge?:Function}} [opts] 组件里传 `useCompanyKnowledge().getKnowledge`，
 *        保证读到的是 store 的**内存态**（比 localStorage 新）；不传则直接读 localStorage。
 * @returns {{scale:string, dept:string, region:string, priceBand:string, mainService:string}}
 */
export function loadOcpProfile(companyId, opts = {}) {
  const cid = String(companyId || '').trim();
  if (!cid) return emptyOcpProfile();
  if (typeof opts.getKnowledge === 'function') {
    try {
      const k = opts.getKnowledge(cid);
      return normalizeOcpProfile(k && k.profile ? k.profile.ocpProfile : null);
    } catch {
      return emptyOcpProfile();
    }
  }
  const map = readJSON(KNOWLEDGE_KEY, {});
  const entry = map && typeof map === 'object' ? map[cid] : null;
  return normalizeOcpProfile(entry && entry.profile ? entry.profile.ocpProfile : null);
}

/**
 * 保存 5 维诊所画像（浅合并进 `profile.ocpProfile`）。
 *
 * 共享知识 S10：企业 id 缺省时**不写库**，返回 `{ ok:false }` —— 杜绝串企业。
 *
 * @param {string} companyId 企业 id
 * @param {object} patch 待写入的维度（只合 5 个已知键）
 * @param {{getKnowledge?:Function, updateProfile?:Function}} [opts]
 *        组件里传 store 的 `updateProfile`（走 Provider → 统一持久化）；不传则直接写 localStorage。
 * @returns {{ok:boolean, profile:object}}
 */
export function saveOcpProfile(companyId, patch, opts = {}) {
  const cid = String(companyId || '').trim();
  if (!cid) return { ok: false, profile: emptyOcpProfile() };
  const next = mergeOcpProfile(loadOcpProfile(cid, opts), patch);
  if (typeof opts.updateProfile === 'function') {
    try {
      opts.updateProfile(cid, { ocpProfile: next });
      return { ok: true, profile: next };
    } catch {
      return { ok: false, profile: next };
    }
  }
  const map = readJSON(KNOWLEDGE_KEY, {});
  const entry = map && typeof map === 'object' && map[cid] && typeof map[cid] === 'object' ? map[cid] : {};
  const profile = entry.profile && typeof entry.profile === 'object' ? entry.profile : {};
  map[cid] = { ...entry, profile: { ...profile, ocpProfile: next } };
  return { ok: writeJSON(KNOWLEDGE_KEY, map), profile: next };
}

/** 预填建议：只给「用户还没填过」的维度用，绝不覆盖用户输入（设计 §1.5 预填映射）。 */
export function suggestOcpProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  return normalizeOcpProfile({
    region: String(p.city || p.region || '').trim(),
    dept: Array.isArray(p.coreProjects) ? p.coreProjects.join(' · ') : String(p.coreProjects || '').trim(),
    mainService: Array.isArray(p.keyProjects) ? p.keyProjects.join(' · ') : String(p.keyProjects || '').trim(),
  });
}

// ==================== 提示词拼装（AC-2.4 / 2.5 / 2.6） ====================

/**
 * 拼装一页方案的提示词。
 *
 * 契约（架构设计 §3.5，逐字照做）：诊所事实六行 + 本次主题 + 四段固定结构 + 验收清单。
 * 缺项一律写「未填写」，**不得编造数字 / 案例 / 竞品名**。
 *
 * @param {object} args
 * @param {object} args.profile 5 维画像
 * @param {string|object} args.topic 主题 id 或主题对象
 * @param {string} [args.companyName] 企业 / 诊所名称
 * @returns {string} 提示词
 */
export function buildOcpPrompt({ profile, topic, companyName } = {}) {
  const p = normalizeOcpProfile(profile);
  const t = typeof topic === 'string' ? findOcpTopic(topic) : topic;
  const topicTitle = (t && t.title) || OCP_MISSING_TEXT;
  const directive = (t && t.directive) || '';
  const name = String(companyName || '').trim() || OCP_MISSING_TEXT;

  const lines = [
    '你是口腔门诊运营顾问，只依据下面的诊所事实出方案，不得使用通用套话。',
    '',
    '【诊所事实】',
    `- 诊所名称：${name}`,
    `- 规模（椅位/医生数）：${p.scale || OCP_MISSING_TEXT}`,
    `- 科室/主推项目：${p.dept || OCP_MISSING_TEXT}`,
    `- 区域（城市/商圈）：${p.region || OCP_MISSING_TEXT}`,
    `- 客单价带：${p.priceBand || OCP_MISSING_TEXT}`,
    `- 主推服务：${p.mainService || OCP_MISSING_TEXT}`,
    '',
    `【本次主题】${topicTitle}`,
    directive,
    '',
    '【输出要求】',
    '1. 只输出 Markdown，用二级标题分成四段，顺序固定：',
    '   ## 现状判断   ## 分步骤   ## 可直接说的话   ## 容易踩的坑',
    '2. 每段下面用 `- ` 列表；「分步骤」每条以数字开头并给出可验收的完成标志。',
    '3. 最后追加一段：',
    '   ## 验收清单',
    '   - [ ] …（至少 4 条，每条都能今天做完并自检）',
    '4. 禁止出现任何技术术语（端口/接口/字段/参数/配置/进程/证书/代理）。',
    '5. 缺失的诊所事实一律写「未填写」，不得编造数字、案例、竞品名。',
    '6. 与本诊所规模/区域/客单价带不匹配的通用打法不要写。',
  ];
  return lines.join('\n');
}

// ==================== 方案解析 ====================

/**
 * 段标题 → 段类型映射。
 * 顺序敏感：「容易踩的坑」先于「清单」判定之外的其他规则，故把最具特征的词放前面。
 */
const SECTION_KIND_RULES = [
  { kind: 'judge', test: /现状|判断|诊断|情况/ },
  { kind: 'steps', test: /分步骤|步骤|动作|怎么做|执行/ },
  // 「可直接说的话」里没有「说话」两个字连在一起（是「说的话」），故两种写法都要覆盖。
  { kind: 'script', test: /说的话|说话|话术|开口|沟通|说法|对答|怎么讲|措辞/ },
  { kind: 'pitfalls', test: /坑|风险|误区|注意|别做/ },
  { kind: 'checklist', test: /验收|自检|清单/ },
];

/** 生成成功后必须出现的四个核心段（缺一个就按「半截方案」处理，不渲染）。 */
const REQUIRED_KINDS = ['judge', 'steps', 'script', 'pitfalls'];

/**
 * 判断段标题属于哪一类。
 * @param {string} title 标题原文
 * @returns {string} judge / steps / script / pitfalls / checklist / other
 */
export function sectionKindOf(title) {
  const s = String(title || '');
  for (const rule of SECTION_KIND_RULES) {
    if (rule.test.test(s)) return rule.kind;
  }
  return 'other';
}

/** 去掉标题里的序号与装饰（「## 一、现状判断」→「现状判断」）。 */
function cleanTitle(raw) {
  return String(raw || '')
    .replace(/^\s*[一二三四五六七八九十]+[、.]\s*/, '')
    .replace(/^\s*\d+[.、)）]\s*/, '')
    .replace(/[*_`]/g, '')
    .trim();
}

/** 把一行正文规整成一条列表项；不是列表项（空行 / 代码围栏 / 寒暄）则返回空串。 */
function cleanItem(line) {
  const s = String(line || '').trim();
  if (!s) return '';
  if (/^```/.test(s)) return '';
  if (/^---+$/.test(s)) return '';
  return s
    .replace(/^[-*•·]\s*/, '')
    .replace(/^\[\s?\]\s*/, '')
    .replace(/^\[[xX]\]\s*/, '')
    .replace(/^\d+[.、)）]\s*/, '')
    .replace(/^（\d+）\s*/, '')
    .replace(/^\(\d+\)\s*/, '')
    .trim();
}

/**
 * 把模型返回的 Markdown 解析成结构化段（便于 `data-ocp-section` / `data-ocp-kind` 断言）。
 *
 * @param {string} markdown 模型原文
 * @returns {Array<{kind:string, title:string, items:string[]}>} 段数组（顺序 = 原文顺序）
 */
export function parseOcpSections(markdown) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n');
  const sections = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.items.length > 0 || cur.title)) sections.push(cur);
    cur = null;
  };
  text.split('\n').forEach((raw) => {
    const heading = /^\s{0,3}(#{1,6})\s*(.+?)\s*$/.exec(String(raw || ''));
    if (heading) {
      flush();
      const title = cleanTitle(heading[2]);
      cur = { kind: sectionKindOf(title), title, items: [] };
      return;
    }
    if (!cur) return; // 第一个标题之前的寒暄丢掉，不进正文
    const item = cleanItem(raw);
    if (item) cur.items.push(item);
  });
  flush();
  return sections;
}

/**
 * 取出验收清单条目（用户可勾选的那几条）。
 * @param {Array<{kind:string, items:string[]}>} sections parseOcpSections 的产出
 * @returns {string[]}
 */
export function checklistOf(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const out = [];
  list.forEach((s) => {
    if (s && s.kind === 'checklist') (s.items || []).forEach((it) => out.push(it));
  });
  return out;
}

/**
 * 方案是否「完整可渲染」：至少 4 段，且四段核心类型齐全。
 * 为什么这么严：老板要的是**专业方案**，半截方案（只有两段）比明确失败更糟 —— 用户会照着做。
 * @param {Array<{kind:string}>} sections
 * @returns {boolean}
 */
export function isCompletePlan(sections) {
  const list = Array.isArray(sections) ? sections : [];
  if (list.length < 4) return false;
  const kinds = new Set(list.map((s) => s && s.kind).filter(Boolean));
  return REQUIRED_KINDS.every((k) => kinds.has(k));
}

// ==================== 缓存（douya-ocp-cache，按企业隔离） ====================

/** 读整张缓存表（脏数据退回空表）。 */
export function readOcpCache() {
  return readJSON(OCP_CACHE_KEY, {});
}

/**
 * 读某企业某主题的缓存方案。
 * @param {string} companyId
 * @param {string} topicId
 * @returns {{text:string, generatedAt:number, basis:object}|null}
 */
export function loadOcpPlan(companyId, topicId) {
  const cid = String(companyId || '').trim();
  const tid = String(topicId || '').trim();
  if (!cid || !tid) return null;
  const map = readOcpCache();
  const entry = map[cid] && typeof map[cid] === 'object' ? map[cid][tid] : null;
  if (!entry || typeof entry !== 'object') return null;
  const text = typeof entry.text === 'string' ? entry.text : '';
  if (!text.trim()) return null;
  return {
    text,
    generatedAt: Number(entry.generatedAt) || 0,
    basis: entry.basis && typeof entry.basis === 'object' ? entry.basis : basisOf({}),
  };
}

/**
 * 写某企业某主题的缓存方案。
 * 共享知识 S10：企业 id 缺省时**不写库**。
 * @param {string} companyId
 * @param {string} topicId
 * @param {{text:string, basis?:object}} payload
 * @returns {boolean} 是否写入成功
 */
export function saveOcpPlan(companyId, topicId, payload) {
  const cid = String(companyId || '').trim();
  const tid = String(topicId || '').trim();
  if (!cid || !tid) return false;
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  if (!text.trim()) return false;
  const map = readOcpCache();
  const bucket = map[cid] && typeof map[cid] === 'object' ? map[cid] : {};
  bucket[tid] = {
    text,
    generatedAt: Date.now(),
    basis: payload && payload.basis && typeof payload.basis === 'object' ? payload.basis : basisOf({}),
  };
  map[cid] = bucket;
  return writeJSON(OCP_CACHE_KEY, map);
}

/**
 * 清掉某企业某主题的缓存（「重新生成」用）。
 * @param {string} companyId
 * @param {string} topicId
 */
export function clearOcpPlan(companyId, topicId) {
  const cid = String(companyId || '').trim();
  const tid = String(topicId || '').trim();
  if (!cid || !tid) return false;
  const map = readOcpCache();
  if (!map[cid] || typeof map[cid] !== 'object') return false;
  delete map[cid][tid];
  return writeJSON(OCP_CACHE_KEY, map);
}

// ==================== 进度（douya-ocp-progress，按企业隔离） ====================

/** 读整张进度表（脏数据退回空表）。 */
export function readOcpProgress() {
  return readJSON(OCP_PROGRESS_KEY, {});
}

/**
 * 读某企业某主题的勾选进度。
 * @param {string} companyId
 * @param {string} topicId
 * @returns {{checked:number[], done:boolean}}
 */
export function loadOcpProgress(companyId, topicId) {
  const cid = String(companyId || '').trim();
  const tid = String(topicId || '').trim();
  if (!cid || !tid) return { checked: [], done: false };
  const map = readOcpProgress();
  const entry = map[cid] && typeof map[cid] === 'object' ? map[cid][tid] : null;
  const checked = entry && Array.isArray(entry.checked) ? entry.checked.filter((i) => Number.isInteger(i) && i >= 0) : [];
  return { checked, done: checked.length > 0 && !!entry && entry.done === true };
}

/**
 * 切换某一条验收项（勾上 / 取消），并回写。
 * @param {string} companyId
 * @param {string} topicId
 * @param {number} index 第几条（0 起）
 * @param {number} total 本次清单总条数（用于判定 done）
 * @returns {{checked:number[], done:boolean}}
 */
export function toggleOcpProgress(companyId, topicId, index, total) {
  const cid = String(companyId || '').trim();
  const tid = String(topicId || '').trim();
  const cur = loadOcpProgress(cid, tid);
  if (!cid || !tid) return cur;
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) return cur;
  const has = cur.checked.includes(idx);
  const checked = has ? cur.checked.filter((i) => i !== idx) : cur.checked.concat([idx]).sort((a, b) => a - b);
  const totalN = Number.isInteger(Number(total)) ? Number(total) : 0;
  const done = totalN > 0 && checked.length >= totalN;
  const map = readOcpProgress();
  const bucket = map[cid] && typeof map[cid] === 'object' ? map[cid] : {};
  bucket[tid] = { checked, done };
  map[cid] = bucket;
  writeJSON(OCP_PROGRESS_KEY, map);
  return { checked, done };
}

// ==================== 生成（调用可注入，单测不联网） ====================

/**
 * 生成一份主题方案。
 *
 * 流程：先看缓存（命中直接返回，不重复调模型）→ 拼提示词 → 调一次模型 → 解析 → 完整性校验 → 写缓存。
 * 任何一步失败都返回 `{ ok:false, error: OCP_ERROR_TEXT, text: '' }` ——
 * **绝不返回半截方案**（`text` 恒为空串，页面据此渲染错误态而不是残缺正文）。
 *
 * @param {object} args
 * @param {string} args.companyId 企业 id（缓存 / 隔离键）
 * @param {string} [args.companyName] 诊所名称
 * @param {object} args.profile 5 维画像
 * @param {string|object} args.topic 主题 id 或对象
 * @param {Function} args.chatFn 补全实现（调用方注入，默认 chatOnce；单测注入假模型）
 * @param {object} [args.context] 附加上下文（透传给模型）
 * @param {boolean} [args.force] true = 忽略缓存重新生成
 * @returns {Promise<{ok:boolean, text:string, sections:Array, checklist:string[], basis:object,
 *                    cached:boolean, error:string, generatedAt:number}>}
 */
export async function generateOcpPlan({
  companyId,
  companyName,
  profile,
  topic,
  chatFn,
  context = null,
  force = false,
} = {}) {
  const t = typeof topic === 'string' ? findOcpTopic(topic) : topic;
  const p = normalizeOcpProfile(profile);
  const basis = basisOf(p);
  const fail = { ok: false, text: '', sections: [], checklist: [], basis, cached: false, error: OCP_ERROR_TEXT, generatedAt: 0 };
  if (!t) return fail;

  if (!force) {
    const cached = loadOcpPlan(companyId, t.id);
    if (cached) {
      const sections = parseOcpSections(cached.text);
      return {
        ok: true,
        text: cached.text,
        sections,
        checklist: checklistOf(sections),
        basis: cached.basis || basis,
        cached: true,
        error: '',
        generatedAt: cached.generatedAt,
      };
    }
  }

  const prompt = buildOcpPrompt({ profile: p, topic: t, companyName });
  let res = null;
  try {
    const fn = typeof chatFn === 'function' ? chatFn : null;
    if (!fn) return fail;
    res = await fn([{ role: 'user', content: prompt }], context, {
      temperature: 0.4,
      maxTokens: 4000,
    });
  } catch {
    res = null;
  }

  const text = res && res.ok !== false && typeof res.content === 'string' ? res.content : '';
  const sections = parseOcpSections(text);
  if (!text.trim() || !isCompletePlan(sections)) return fail;

  const checklist = checklistOf(sections);
  saveOcpPlan(companyId, t.id, { text, basis });
  return {
    ok: true,
    text,
    sections,
    checklist,
    basis,
    cached: false,
    error: '',
    generatedAt: Date.now(),
  };
}

export default {
  OCP_TOPICS,
  OCP_TOPIC_IDS,
  OCP_PROFILE_FIELDS,
  OCP_PROFILE_KEYS,
  OCP_CACHE_KEY,
  OCP_PROGRESS_KEY,
  OCP_ERROR_TEXT,
  OCP_EMPTY_TEXT,
  OCP_MISSING_TEXT,
  findOcpTopic,
  normalizeOcpProfile,
  emptyOcpProfile,
  basisOf,
  mergeOcpProfile,
  loadOcpProfile,
  saveOcpProfile,
  suggestOcpProfile,
  buildOcpPrompt,
  parseOcpSections,
  sectionKindOf,
  checklistOf,
  isCompletePlan,
  loadOcpPlan,
  saveOcpPlan,
  clearOcpPlan,
  loadOcpProgress,
  toggleOcpProgress,
  generateOcpPlan,
};
