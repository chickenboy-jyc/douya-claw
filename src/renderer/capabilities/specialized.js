/**
 * capabilities/specialized.js —— 厂家 / 门诊专属能力（已开通，真实 AI 执行）。
 *
 * 背景：这 9 个能力此前标记为 building（建设中），任务执行到它们会被拦截，用户在营销目标
 * 与项目模板里看到大量「未开通」。本次全部开通：
 *   - 执行链路真实：优先调自建后端文案接口（/api/wenan/generate），
 *     不可用/不适配时降级到内网通用 LLM 补全（chatOnce）——两条都是真实 AI 调用，绝不伪造结果。
 *   - 每个能力带「行业专属 Prompt 框架」，让输出是可直接交付的方案，而不是空话。
 *
 * 厂家：product 产品营销 / kol 医生KOL / channel 渠道招商 / academic 学术教育 / exhibition 展会活动
 * 门诊：patient_acquisition 患者获客 / doctor_ip 医生IP / private_domain 私域运营 / local_marketing 同城营销
 */

import { makeCapability, chatGenerate, extractText, geoProxy } from './base.js';

// ---- 通用：后端文案接口优先，通用 LLM 兜底 ----

function buildExtra(task, ctx, instruction) {
  const parts = [];
  if (task && task.description) parts.push('任务要求：' + task.description);
  if (task && task.requirements) parts.push('补充要求：' + task.requirements);
  if (ctx && ctx.companyContext) parts.push(ctx.companyContext);
  parts.push('【交付框架】\n' + (instruction || ''));
  return parts.filter(Boolean).join('\n\n');
}

/**
 * 混合执行：先试自建后端文案接口，失败/空结果再走通用 LLM 补全。
 * @returns {Promise<{ok, content, aiInput, aiProcess}>}
 */
async function hybridExecute(task, ctx, { name, prompt, style = 'marketing' }) {
  const topic = (task && task.title) || name;
  const extra = buildExtra(task, ctx, prompt);
  try {
    const r = await geoProxy('/api/wenan/generate', 'POST', {
      type: 'custom',
      style,
      topic,
      extra,
      online: false,
      personas: [],
      platforms: [],
    });
    const content = extractText(r);
    if (r && r.ok && content && content.length > 80) {
      return {
        ok: true,
        content,
        aiInput: `POST /api/wenan/generate { type:'custom', style:'${style}', topic:'${topic}', extra }`,
        aiProcess: `已调用自建后端文案接口（/api/wenan/generate），按「${name}」交付框架生成。`,
      };
    }
  } catch {
    /* 降级通用补全 */
  }
  return chatGenerate(task, ctx, prompt);
}

// ---- 厂家专属 Prompt 框架 ----

const PRODUCT_PROMPT =
  '请作为口腔医疗器械 / 耗材产品营销专家完成该任务，输出可直接交付的产品营销包（Markdown）：\n' +
  '1. 核心卖点：3-5 条，每条写清「卖点 → 给客户的临床/经营价值 → 可验证的证据或话术」；\n' +
  '2. 目标客户画像：门诊老板 / 采购 / 临床医生 / 经销商，各自的决策点、痛点与 objections；\n' +
  '3. 上市传播节奏：预热 → 上市 → 放量三阶段，每阶段写渠道、内容形式、关键动作；\n' +
  '4. 竞品对比话术：我方 vs 竞品，只对比上下文里已有的信息；\n' +
  '5. 一页纸产品简介（可直接发给客户）。\n' +
  '硬约束：参数、价格、认证、临床数据若上下文未提供，一律写「待补充」，严禁编造。';

const KOL_PROMPT =
  '请作为口腔行业医生 / KOL 合作专家完成该任务，输出可直接执行的 KOL 合作方案（Markdown）：\n' +
  '1. 适配的医生 / KOL 画像：职称、城市、粉丝量级、内容风格、合作动机；\n' +
  '2. 筛选方法：去哪些渠道找、怎么识别数据造假、重点看哪些指标（完播/互动质量/粉丝画像）；\n' +
  '3. 合作模式与预算档位：科普投稿、直播、病例共创、学术背书、分销带货，各自适配场景与流程；\n' +
  '4. 合作 Brief 模板：内容要求、合规红线、交付物清单、验收标准；\n' +
  '5. 效果评估与复盘口径（曝光/互动/留资/转化）。\n' +
  '硬约束：不得编造具体医生姓名、粉丝数、报价；报价给市场常见区间并标注「待核实」。';

const CHANNEL_PROMPT =
  '请作为口腔耗材 / 设备渠道招商专家完成该任务，输出可落地的招商方案（Markdown）：\n' +
  '1. 目标经销商画像：区域、现有代理品牌、覆盖门诊数量、团队规模、合作动机；\n' +
  '2. 招商政策设计：价格体系、返利机制、区域保护、首批进货、市场支持；\n' +
  '3. 触达路径与话术：展会名录、行业协会、老客户转介、线上投放，各写首次接触话术；\n' +
  '4. 招商会 / 一对一沟通流程 + 关键提问清单（判断经销商成色）；\n' +
  '5. 经销商跟进 SOP 与激活动作（首单、首月、季度复盘）。\n' +
  '硬约束：具体价格、返点、进货额若未提供，用占位符并标注「需确认」，严禁编造数字。';

const ACADEMIC_PROMPT =
  '请作为口腔医学教育与学术传播专家完成该任务，输出学术教育方案（Markdown）：\n' +
  '1. 培训对象分层：临床医生 / 护士 / 咨询师，各自的学习目标与课程主题；\n' +
  '2. 课程大纲：模块 + 课时 + 知识点 + 实操安排；\n' +
  '3. 讲师与学术背书策略（院内 / 学会 / 专家共识）；\n' +
  '4. 学术传播内容矩阵：病例分享、操作视频、文献解读、直播答疑；\n' +
  '5. 合规要点（医疗器械与医疗广告合规：不做疗效承诺、不越适应症）；\n' +
  '6. 转化路径：学术影响 → 产品认可 → 采购/处方。';

const EXHIBITION_PROMPT =
  '请作为口腔展会 / 峰会运营专家完成该任务，输出展会全案（Markdown）：\n' +
  '1. 展前：目标设定（留资数/意向数/签约数）、展位与动线设计、引流物料、邀约名单与邀约话术、预热传播；\n' +
  '2. 展中：接待 SOP、演示脚本、互动玩法、留资方式、每日复盘会；\n' +
  '3. 展后：线索分级、48 小时跟进话术、转化节奏、复盘指标；\n' +
  '4. 预算表：展位/搭建/物料/人员/差旅/传播，给低/标准/高三档；\n' +
  '5. 风险预案：人流不足、设备故障、竞品干扰、临展变更。';

// ---- 门诊专属 Prompt 框架 ----

const PATIENT_PROMPT =
  '请作为口腔门诊获客增长专家完成该任务，输出获客方案（Markdown）：\n' +
  '1. 获客渠道矩阵：美团/大众点评、抖音本地生活、小红书、私域转介绍、异业合作、社区地推，各写成本量级与适配项目；\n' +
  '2. 项目与人群匹配：种植 / 正畸 / 儿牙 / 洁牙 / 修复，各自的主推人群、钩子与转化难点；\n' +
  '3. 内容选题库：20 条，含平台、标题、内容要点；\n' +
  '4. 转化路径：曝光 → 咨询 → 到店 → 成交，每步写关键动作与话术；\n' +
  '5. 月度预算分配与 ROI 测算口径；\n' +
  '6. 到店承接：前台话术、咨询师流程、回访 SOP。\n' +
  '硬约束：涉及获客成本、转化率等数字，若无可核实来源，按测算口径给区间并标注「测算，待验证」。';

const DOCTOR_IP_PROMPT =
  '请作为医生个人 IP 打造专家完成该任务，输出医生 IP 方案（Markdown）：\n' +
  '1. 人设定位：专业标签 + 性格标签 + 差异化记忆点（一句话人设）；\n' +
  '2. 内容栏目规划：科普 / 病例 / 答疑 / 幕后 / 观点，各栏目更新频率与示例标题；\n' +
  '3. 首月 30 条内容选题清单（平台 + 标题 + 一句话要点）；\n' +
  '4. 涨粉路径：冷启动 → 放量 → 变现；\n' +
  '5. 拍摄与呈现规范：口播脚本结构、时长、封面、字幕、发布节奏；\n' +
  '6. 合规红线：不做疗效承诺、不泄露患者隐私、不做诱导；\n' +
  '7. 阶段性 KPI（0-1 月 / 2-3 月 / 4-6 月）。';

const PRIVATE_DOMAIN_PROMPT =
  '请作为口腔门诊私域运营专家完成该任务，输出私域运营方案（Markdown）：\n' +
  '1. 私域资产结构：企微 / 社群 / 公众号 / 小程序各自分工与承接关系；\n' +
  '2. 加微路径与话术：到店、线上咨询、术后回访、活动，各场景话术；\n' +
  '3. 社群运营 SOP：欢迎语、日常内容节奏、活动玩法、沉睡唤醒；\n' +
  '4. 复购与转介绍机制：洁牙年卡、家庭卡、老带新权益设计；\n' +
  '5. 月度内容日历（结合节日与项目节点）；\n' +
  '6. 数据指标（加微率、活跃率、到店转化率、转介绍率）与对应提升动作。';

const LOCAL_MARKETING_PROMPT =
  '请作为本地生活 / 同城营销专家（口腔门诊）完成该任务，输出同城营销方案（Markdown）：\n' +
  '1. 平台布局：大众点评/美团、抖音本地生活、高德地图、小红书同城、社区地推，各写核心打法；\n' +
  '2. 门店线上基建：头图、团单设计、评价管理、问答、POI 信息；\n' +
  '3. 团单与价格钩子：引流款 / 利润款 / 升单款三档设计；\n' +
  '4. 评价与口碑运营：好评引导话术、差评处理 SOP；\n' +
  '5. 同城投放策略：预算分配、定向、素材与出价；\n' +
  '6. 到店承接与核销转化（避免「买了不来、来了不升单」）。';

// ---- 厂家能力 ----

export const productCapability = makeCapability({
  id: 'product',
  name: '产品营销',
  description: '新品推广 / 卖点提炼 / 上市传播 / 竞品对比话术。',
  supportedCompanyTypes: ['manufacturer'],
  taskTypes: ['product'],
  status: 'ready',
  assetType: 'product_material',
  buildPrompt: () => PRODUCT_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '产品营销', prompt: PRODUCT_PROMPT }),
});

export const kolCapability = makeCapability({
  id: 'kol',
  name: '医生KOL',
  description: '医生 / KOL 筛选、合作模式、Brief 与效果评估。',
  supportedCompanyTypes: ['manufacturer'],
  taskTypes: ['kol'],
  status: 'ready',
  assetType: 'doctor_material',
  buildPrompt: () => KOL_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '医生KOL', prompt: KOL_PROMPT }),
});

export const channelCapability = makeCapability({
  id: 'channel',
  name: '渠道招商',
  description: '经销商画像 / 招商政策 / 触达话术 / 跟进 SOP。',
  supportedCompanyTypes: ['manufacturer'],
  taskTypes: ['channel'],
  status: 'ready',
  assetType: 'document',
  buildPrompt: () => CHANNEL_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '渠道招商', prompt: CHANNEL_PROMPT }),
});

export const academicCapability = makeCapability({
  id: 'academic',
  name: '学术教育',
  description: '课程设计 / 学术传播矩阵 / 合规要点 / 转化路径。',
  supportedCompanyTypes: ['manufacturer'],
  taskTypes: ['academic'],
  status: 'ready',
  assetType: 'document',
  buildPrompt: () => ACADEMIC_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '学术教育', prompt: ACADEMIC_PROMPT }),
});

export const exhibitionCapability = makeCapability({
  id: 'exhibition',
  name: '展会活动',
  description: '展前 / 展中 / 展后全案、预算三档、风险预案。',
  supportedCompanyTypes: ['manufacturer'],
  taskTypes: ['exhibition'],
  status: 'ready',
  assetType: 'event_material',
  buildPrompt: () => EXHIBITION_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '展会活动', prompt: EXHIBITION_PROMPT }),
});

// ---- 门诊能力 ----

export const patientAcquisitionCapability = makeCapability({
  id: 'patient_acquisition',
  name: '患者获客',
  description: '渠道矩阵 / 选题库 / 转化路径 / 预算与 ROI 口径。',
  supportedCompanyTypes: ['clinic'],
  taskTypes: ['patient_acquisition'],
  status: 'ready',
  assetType: 'document',
  buildPrompt: () => PATIENT_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '患者获客', prompt: PATIENT_PROMPT }),
});

export const doctorIpCapability = makeCapability({
  id: 'doctor_ip',
  name: '医生IP',
  description: '人设定位 / 内容栏目 / 30 条选题 / 涨粉与合规。',
  supportedCompanyTypes: ['clinic'],
  taskTypes: ['doctor_ip'],
  status: 'ready',
  assetType: 'doctor_material',
  buildPrompt: () => DOCTOR_IP_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '医生IP', prompt: DOCTOR_IP_PROMPT }),
});

export const privateDomainCapability = makeCapability({
  id: 'private_domain',
  name: '私域运营',
  description: '企微 / 社群 SOP / 复购转介绍 / 内容日历与指标。',
  supportedCompanyTypes: ['clinic'],
  taskTypes: ['private_domain'],
  status: 'ready',
  assetType: 'document',
  buildPrompt: () => PRIVATE_DOMAIN_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '私域运营', prompt: PRIVATE_DOMAIN_PROMPT }),
});

export const localMarketingCapability = makeCapability({
  id: 'local_marketing',
  name: '同城营销',
  description: '本地生活平台 / 门店线上基建 / 团单设计 / 口碑运营。',
  supportedCompanyTypes: ['clinic'],
  taskTypes: ['local_marketing'],
  status: 'ready',
  assetType: 'document',
  buildPrompt: () => LOCAL_MARKETING_PROMPT,
  execute: (task, ctx) => hybridExecute(task, ctx, { name: '同城营销', prompt: LOCAL_MARKETING_PROMPT }),
});

// ---- 共用能力：竞品对比分析 ----

const COMPETITOR_PROMPT =
  '请作为口腔行业竞争情报分析师完成该任务，输出「我方 vs 竞品」对比分析报告（Markdown）：\n' +
  '1. 对比总览表：按维度逐行对比（品牌定位 / 主推产品或项目 / 价格带 / 渠道模式 / 内容阵地 / 声量表现 / 核心卖点 / 目标客户）；\n' +
  '2. 逐家竞品画像：定位、主要打法、强项、弱点、可打的点；\n' +
  '3. 我方差距与机会点：至少 3 条可执行建议，每条写「依据 → 动作 → 预期效果」；\n' +
  '4. 差异化定位建议：一句话差异化 + 支撑理由；\n' +
  '5. 持续监测建议：跟踪哪些指标、从哪些平台、什么频率。\n' +
  '硬约束：竞品的价格、销量、份额、门店数等数字，若上下文未提供，一律写「未获取到，需人工补充或联网核实」，严禁编造。';

export const competitorCapability = makeCapability({
  id: 'competitor',
  name: '竞品对比',
  description: '竞品名单对比 / 差异定位 / 机会点 / 监测建议。',
  supportedCompanyTypes: ['manufacturer', 'clinic'],
  taskTypes: ['competitor'],
  status: 'ready',
  assetType: 'document',
  buildPrompt: () => COMPETITOR_PROMPT,
  execute: (task, ctx) => chatGenerate(task, ctx, COMPETITOR_PROMPT),
});

export const SPECIALIZED_CAPABILITIES = [
  // 共用
  competitorCapability,
  // 厂家
  productCapability,
  kolCapability,
  channelCapability,
  academicCapability,
  exhibitionCapability,
  // 门诊
  patientAcquisitionCapability,
  doctorIpCapability,
  privateDomainCapability,
  localMarketingCapability,
];

export const SPECIALIZED_PROMPTS = {
  competitor: COMPETITOR_PROMPT,
  product: PRODUCT_PROMPT,
  kol: KOL_PROMPT,
  channel: CHANNEL_PROMPT,
  academic: ACADEMIC_PROMPT,
  exhibition: EXHIBITION_PROMPT,
  patient_acquisition: PATIENT_PROMPT,
  doctor_ip: DOCTOR_IP_PROMPT,
  private_domain: PRIVATE_DOMAIN_PROMPT,
  local_marketing: LOCAL_MARKETING_PROMPT,
};

export default SPECIALIZED_CAPABILITIES;
