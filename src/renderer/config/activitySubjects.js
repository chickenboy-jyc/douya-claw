/**
 * Activity 主体定义（Subject）—— Activity Engine 四层模型的第 1 层。
 *
 * 唯一事实源：docs/ACTIVITY-DIRECTOR-DESIGN.md §1（主体模型）、§8.5（跨主体禁止）。
 * 其余模块（UI / Prompt / service / store）只能从本文件读取主体枚举，禁止硬编码。
 *
 * 设计要点：
 * 1. 主体 ≠ 企业类型，但默认由企业类型推导（§1.3），推导逻辑集中在 resolveActivitySubject()。
 * 2. 每个主体有各自独立的「负面约束清单」（SUBJECT_NEGATIVE_RULES），无条件拼进每次 AI 调用。
 * 3. 医生身份（DoctorIdentity）是门诊企业下的轻量附属身份，不新建 Company（§1.4）。
 *
 * 本文件为纯常量 + 纯函数：不 import 任何框架、不读写 localStorage、不发网络请求。
 */

/**
 * 未识别主体时的兜底主体（对齐 companyStore.normalizeCompanyType 的兜底值 manufacturer）。
 * @type {string}
 */
export const DEFAULT_SUBJECT = 'manufacturer';

/**
 * ActivitySubject
 * @typedef {Object} ActivitySubject
 * @property {string} key                  // manufacturer / clinic / doctor / platform
 * @property {string} label                // 中文展示名
 * @property {string} icon                 // emoji
 * @property {string} desc                 // 一句话定位
 * @property {string} audience             // 典型活动对象
 * @property {string} constraint           // 典型资源约束（AI 需据此收窄方案）
 */

/**
 * 四种活动主体（§1.1）。key 顺序即 UI 展示顺序。
 * @type {Object<string, ActivitySubject>}
 */
export const ACTIVITY_SUBJECTS = {
  manufacturer: {
    key: 'manufacturer',
    label: '口腔厂家',
    icon: '🏭',
    desc: '器械 / 材料 / 设备 / 数字化口腔企业',
    audience: '医生、经销商、KOL、行业媒体',
    constraint: '有学术 / 产品内容，缺终端患者触点',
  },
  clinic: {
    key: 'clinic',
    label: '口腔门诊',
    icon: '🦷',
    desc: '连锁或单体口腔机构',
    audience: '患者、周边居民、老客',
    constraint: '有场地与医生，缺传播与内容能力',
  },
  doctor: {
    key: 'doctor',
    label: '口腔医生',
    icon: '👨‍⚕️',
    desc: '以个人身份办活动的执业医生',
    audience: '粉丝、患者、同行',
    constraint: '资源极少，一人身兼策划 / 主持 / 剪辑',
  },
  platform: {
    key: 'platform',
    label: '口腔平台',
    icon: '🌐',
    desc: '口腔 SaaS / 供应链 / 服务平台',
    audience: '商家（门诊 / 经销商）、合作伙伴',
    constraint: '有商家池与案例，缺线下执行经验',
  },
};

/**
 * 主体列表（Object.values 的稳定快照，供 UI 直接 map，避免每处都写 Object.values）。
 * @type {ActivitySubject[]}
 */
export const ACTIVITY_SUBJECT_LIST = [
  ACTIVITY_SUBJECTS.manufacturer,
  ACTIVITY_SUBJECTS.clinic,
  ACTIVITY_SUBJECTS.doctor,
  ACTIVITY_SUBJECTS.platform,
];

/**
 * 跨主体禁止项（验收红线的技术保障，§8.5）。
 *
 * 这段常量会被无条件拼入每一次活动 AI 调用的 Prompt，并在 UI 的 KPI 录入区做字段级校验。
 * 合并了设计文档 §8.5 与团队验收红线，二者冲突时以本清单为准（取并集）。
 *
 * @type {Object<string, string[]>}
 */
export const SUBJECT_NEGATIVE_RULES = {
  manufacturer: [
    '不得出现「患者到店」「患者成交量」「患者留资」等 C 端患者获客指标',
    '不得把经销商招商逻辑套用到医生教育活动上',
    '不得用「门诊到店」作为厂家活动的成功判据',
    '不得把朋友圈裂变、小红书种草等 C 端玩法当作厂家主力获客路径',
  ],
  clinic: [
    '不得默认「经销商招商」「渠道线索」「渠道政策」',
    '不得把行业学术会议规模套到门诊社区活动上',
    '不得用「行业曝光」冒充本地获客成果',
    '不得出现行业学术会议、学分、继续教育等厂家语境内容',
  ],
  doctor: [
    '不得使用企业招商模型（经销商 / 渠道 / 商家）',
    '不得默认有团队、场地、预算等机构资源（医生通常一人执行）',
    '不得承诺或暗示疗效',
    '不得出现「根治」「最好」「100% 有效」等绝对化医疗表述',
  ],
  platform: [
    '不得使用患者获客模型（到店 / 留资 / 成交）',
    '不得把 C 端用户增长指标用于商家侧活动',
    '不得用「患者」指代平台商家（活动对象是企业 / 商家，不是 C 端）',
  ],
};

/**
 * DoctorIdentity —— 门诊企业下的轻量附属身份（§1.4）。
 *
 * 数据结构（不新建 Company，不动 companyStore 的 company 结构）：
 *
 * ```
 * Company (clinic)
 *   └── DoctorIdentity { id, companyId, name, title, affiliation, note }
 * ```
 *
 * - 存储：localStorage['douya-doctor-identities']，由 activityStore 读写。
 * - 活动落库：subjectType='doctor' + subjectIdentityId=<DoctorIdentity.id>（主体为机构时为空）
 *   + subjectLabel（展示用，如「李医生（医生个人 · 杭州XX口腔）」）。
 * - 数据隔离不变：活动仍按 companyId 隔离，靠 subjectType 区分，不破坏现有 store 契约。
 * - 切换主体必须清空 goalKey / templateKey / directions / reverseGoal / funnel / campaign / outputs
 *   并二次确认（目标不跨主体共享，否则 KPI 串味）。
 *
 * @typedef {Object} DoctorIdentity
 * @property {string} id            // 本地唯一 id
 * @property {string} companyId     // 所属企业（clinic）
 * @property {string} name          // 李医生
 * @property {string} title         // 主任医师
 * @property {string} affiliation   // 杭州XX口腔（对外展示的挂靠机构）
 * @property {string} [note]        // 备注
 */

/**
 * DoctorIdentity 的 localStorage key（与 §16.2 的 douya- 前缀约定一致）。
 * activityStore 应 import 此常量，避免两处写死字符串。
 * @type {string}
 */
export const DOCTOR_IDENTITY_STORAGE_KEY = 'douya-doctor-identities';

/**
 * 活动落库用的自定义目标 key（§1.3：自定义目标走 goalKey='custom'，文本落 goalCustomText）。
 * @type {string}
 */
export const CUSTOM_GOAL_KEY = 'custom';

/**
 * 取主体的负面约束数组（未知主体返回空数组，不抛错）。
 * @param {string} subjectType 主体 key
 * @returns {string[]} 负面约束清单
 */
export function getSubjectNegativeRules(subjectType) {
  return SUBJECT_NEGATIVE_RULES[subjectType] || [];
}

/**
 * 把某个主体的负面约束拼成可直接注入 Prompt 的文本块。
 * @param {string} subjectType 主体 key
 * @returns {string} 形如「- xxx\n- yyy」；无约束时返回空字符串
 */
export function buildSubjectNegativeText(subjectType) {
  const rules = getSubjectNegativeRules(subjectType);
  if (rules.length === 0) return '';
  return rules.map((line) => `- ${line}`).join('\n');
}

/**
 * 把 DoctorIdentity 渲染成展示标签（§1.4 的 subjectLabel 口径）。
 * @param {DoctorIdentity|null|undefined} identity 医生身份
 * @returns {string} 如「李医生（主任医师 · 杭州XX口腔）」；无身份时返回空字符串
 */
export function buildDoctorIdentityLabel(identity) {
  if (!identity || typeof identity !== 'object') return '';
  const name = String(identity.name || '').trim();
  if (!name) return '';
  const parts = [String(identity.title || '').trim(), String(identity.affiliation || '').trim()]
    .filter(Boolean);
  if (parts.length === 0) return name;
  return `${name}（${parts.join(' · ')}）`;
}

/**
 * Company.type → 可选主体的静态映射（§1.3）。
 * 值语义：第一项为默认选中项，数组为全部候选项。
 * @type {Object<string, string[]>}
 */
export const SUBJECT_OPTIONS_OF_COMPANY_TYPE = {
  manufacturer: ['manufacturer'],
  clinic: ['clinic', 'doctor'],
  doctor: ['doctor', 'clinic'],
  platform: ['platform'],
};

/**
 * 解析本次活动的「候选主体 + 默认选中项」（§1.3，UI 不写 if，全部由本函数返回）。
 *
 * 自动预选规则：
 * | company.type  | 默认主体       | 可选主体                                              |
 * |---------------|----------------|-------------------------------------------------------|
 * | manufacturer  | manufacturer   | 仅 manufacturer（第一版厂家不开放医生身份）            |
 * | clinic        | clinic         | clinic + doctor（每个 DoctorIdentity 一个独立候选项）  |
 * | doctor        | doctor         | doctor + clinic（affiliatedClinicName 非空时才出门诊） |
 * | platform      | platform       | 仅 platform                                            |
 * | 未知 / 空      | manufacturer   | 全部四主体（交给用户手选）                              |
 *
 * @param {Object|null|undefined} company 当前企业对象（companyStore 的 company）
 * @param {Object} [opts] 选项
 * @param {string} [opts.subjectType] 用户手动选择的主体 key（override）
 * @param {string} [opts.subjectIdentityId] 用户手动选择的医生身份 id（override）
 * @param {DoctorIdentity[]} [opts.doctorIdentities] 该企业下的医生身份列表
 * @returns {{
 *   subjectType: string,
 *   subjectIdentityId: string|null,
 *   subjectLabel: string,
 *   candidates: Array<{key:string, identityId:string|null, label:string, desc:string, source:string}>,
 *   locked: boolean,
 *   reason: string,
 *   overrideIgnored: boolean,
 *   overrideReason: string
 * }} 解析结果
 */
export function resolveActivitySubject(company, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const identities = Array.isArray(options.doctorIdentities) ? options.doctorIdentities : [];
  const companyType = company && typeof company === 'object' ? String(company.type || '') : '';
  const companyId = company && typeof company === 'object' ? String(company.id || '') : '';

  /** @type {Array<{key:string, identityId:string|null, label:string, desc:string, source:string}>} */
  let candidates = [];
  let reason = '';

  if (!companyType) {
    // 未选择企业：不猜测主体，全部列出由用户手选，默认兜底 manufacturer。
    candidates = ACTIVITY_SUBJECT_LIST.map((s) => ({
      key: s.key,
      identityId: null,
      label: s.label,
      desc: s.desc,
      source: 'catalog',
    }));
    reason = '未识别企业类型，已列出全部主体供手动选择';
  } else if (companyType === 'clinic') {
    candidates.push({
      key: 'clinic',
      identityId: null,
      label: String(company.name || ACTIVITY_SUBJECTS.clinic.label),
      desc: '以门诊机构为主体办活动，可动用场地 / 团队 / 患者池',
      source: 'company',
    });
    identities
      .filter((it) => it && typeof it === 'object')
      .filter((it) => !companyId || !it.companyId || String(it.companyId) === companyId)
      .forEach((it) => {
        candidates.push({
          key: 'doctor',
          identityId: String(it.id || ''),
          label: buildDoctorIdentityLabel(it) || '未命名医生',
          desc: `以 ${String(it.name || '该医生').trim()} 个人身份办活动，不默认占用机构资源`,
          source: 'identity',
        });
      });
    reason = candidates.length > 1
      ? '门诊企业默认按机构办活动；已挂靠医生可作为「口腔医生」主体单独办活动'
      : '门诊企业默认按机构办活动';
  } else if (companyType === 'doctor') {
    const selfName = String(company.doctorName || company.ownerName || company.name || '').trim();
    candidates.push({
      key: 'doctor',
      identityId: null,
      label: selfName || ACTIVITY_SUBJECTS.doctor.label,
      desc: '以医生个人身份办活动，默认一人执行',
      source: 'company',
    });
    const affiliated = String(company.affiliatedClinicName || '').trim();
    if (affiliated) {
      candidates.push({
        key: 'clinic',
        identityId: null,
        label: affiliated,
        desc: `以挂靠机构（${affiliated}）为主体办活动`,
        source: 'company',
      });
    }
    reason = affiliated
      ? '医生个人工作空间默认按个人办活动；已填写挂靠机构，可切换为机构主体'
      : '医生个人工作空间默认按个人办活动';
  } else if (companyType === 'platform') {
    candidates.push({
      key: 'platform',
      identityId: null,
      label: String(company.name || ACTIVITY_SUBJECTS.platform.label),
      desc: '以平台型企业为主体，活动对象是入驻 / 目标商家',
      source: 'company',
    });
    reason = '平台型企业仅支持「口腔平台」主体';
  } else {
    // 兜底：未知 type 与 manufacturer 同样处理（第一版厂家不开放医生身份）。
    candidates.push({
      key: 'manufacturer',
      identityId: null,
      label: String(company.name || ACTIVITY_SUBJECTS.manufacturer.label),
      desc: '以厂家企业为主体，活动对象是医生 / 经销商 / KOL',
      source: 'company',
    });
    reason = companyType === 'manufacturer'
      ? '厂家企业仅支持「口腔厂家」主体'
      : `企业类型「${companyType}」未识别，已按厂家主体兜底`;
  }

  const fallback = candidates[0] || { key: DEFAULT_SUBJECT, identityId: null, label: ACTIVITY_SUBJECTS[DEFAULT_SUBJECT].label };
  let selected = fallback;
  let overrideIgnored = false;
  let overrideReason = '';

  const wantKey = String(options.subjectType || '').trim();
  const wantIdentityId = String(options.subjectIdentityId || '').trim();
  if (wantKey) {
    const hit = candidates.find((c) => (
      c.key === wantKey && (wantIdentityId ? c.identityId === wantIdentityId : true)
    ));
    if (hit) {
      selected = hit;
    } else {
      overrideIgnored = true;
      overrideReason = ACTIVITY_SUBJECTS[wantKey]
        ? `当前企业类型不允许以「${ACTIVITY_SUBJECTS[wantKey].label}」为主体，已回退为默认主体`
        : `未知主体「${wantKey}」，已回退为默认主体`;
    }
  }

  return {
    subjectType: selected.key,
    subjectIdentityId: selected.identityId || null,
    subjectLabel: selected.label,
    candidates,
    locked: candidates.length <= 1,
    reason: overrideIgnored ? `${selected.key === fallback.key ? reason : reason}｜${overrideReason}` : reason,
    overrideIgnored,
    overrideReason,
  };
}

/**
 * 生成给 AI 看的「活动主体」语境文本（§1.4）。
 *
 * @param {string|Object} subject 主体 key，或活动上的主体快照对象
 * @param {string} [subject.subjectType] 主体 key（快照对象形态）
 * @param {string} [subject.subjectIdentityId] 医生身份 id
 * @param {string} [subject.subjectLabel] 展示名，如「李医生（主任医师 · 杭州XX口腔）」
 * @param {string} [subject.identityName] 医生姓名
 * @param {string} [subject.identityTitle] 医生职称
 * @param {string} [subject.affiliation] 挂靠机构名
 * @param {string} [subject.companyName] 企业名称（机构 / 厂家 / 平台主体时的企业名）
 * @param {string} [subject.note] 补充说明
 * @returns {string} 多行 Prompt 文本块
 */
export function buildActivitySubjectContext(subject) {
  const raw = typeof subject === 'string' ? { subjectType: subject } : (subject || {});
  const subjectType = String(raw.subjectType || DEFAULT_SUBJECT);
  const meta = ACTIVITY_SUBJECTS[subjectType] || ACTIVITY_SUBJECTS[DEFAULT_SUBJECT];

  const identityName = String(raw.identityName || '').trim();
  const identityTitle = String(raw.identityTitle || '').trim();
  const affiliation = String(raw.affiliation || '').trim();
  const companyName = String(raw.companyName || raw.subjectLabel || '').trim();
  const displayName = identityName || (subjectType === 'doctor' ? companyName : '');

  const lines = [];
  if (subjectType === 'doctor') {
    // §1.4 口径：本次活动的组织者是「医生个人」：李医生（主任医师，挂靠机构：杭州XX口腔）。
    const profile = [identityTitle, affiliation ? `挂靠机构：${affiliation}` : ''].filter(Boolean).join('，');
    lines.push(profile
      ? `【活动主体】本次活动的组织者是「${meta.label}」：${displayName || meta.label}（${profile}）。`
      : `【活动主体】本次活动的组织者是「${meta.label}」${displayName ? `：${displayName}` : ''}`);
  } else {
    lines.push(companyName
      ? `【活动主体】本次活动的组织者是「${meta.label}」：${companyName}`
      : `【活动主体】本次活动的组织者是「${meta.label}」`);
  }

  lines.push(`主体说明：${meta.desc}｜活动对象：${meta.audience}｜资源约束：${meta.constraint}`);

  const negative = buildSubjectNegativeText(subjectType);
  if (negative) {
    lines.push('负面约束（无条件生效，违反即判不合格）：');
    lines.push(negative);
  }

  // §1.4：医生主体不得默认占用挂靠机构资源，这是防止方案「飘」的关键约束。
  if (subjectType === 'doctor' && affiliation) {
    lines.push(`注意：不得把挂靠机构（${affiliation}）的场地、预算、团队、患者池默认算作本次活动资源，` +
      '除非用户明确说明由机构支持。');
  }

  const note = String(raw.note || '').trim();
  if (note) lines.push(`补充约束：${note}`);

  return lines.join('\n');
}
