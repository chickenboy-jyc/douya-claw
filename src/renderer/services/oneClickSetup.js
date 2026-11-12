import { normalizeBrandIp } from '../store/companyKnowledgeModel.js';

/**
 * oneClickSetup —— 「企业建档做成一键」的**纯逻辑**（老板 2026-11-10）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 老板原话
 * ────────────────────────────────────────────────────────────────────────────
 * 「企业建档这一步有点麻烦 能不能做成一键的 输入一下公司名称 子品牌 建档一键全部搞定」
 *
 * 改造前要建一次档，得按顺序点五处：
 *   页头「🧭 建档引导」→ 挑一张身份卡 → 填公司名 → 「🔍 AI 识别」→ 在候选里挑一家 → 「完成建档」，
 *   子品牌还得再去「子品牌」分区点「搜索」+「⚡ 一键建档」。老板要的是**两个输入框 + 一个按钮**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么把这三件事拆到这里（而不是继续写在 .jsx 里）
 * ────────────────────────────────────────────────────────────────────────────
 *   ① 判类型、拆子品牌、合并去重全是**纯算术/纯规则**，能在 node 里逐条断言；
 *      写在组件里就只能靠"点一遍看看"，而"点一遍"看不出「两个只差大小写的子品牌被写进两条」。
 *   ② 本仓的病是「同一口径写两份，各自漂移」：子品牌去重原本只有 BrandIpManager 内部一份
 *      （`buildMany`），一键建档再写一份 ⇒ 两边迟早不一致。这里做成唯一真源，
 *      BrandIpManager 后续可改为调用它（本次不动它，避免顺手改坏已验证的路径）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 红线
 * ────────────────────────────────────────────────────────────────────────────
 *   · **不编造**：类型只能从名字里的关键词**推**出来，推不出就 `confident=false` 并在界面上
 *     明说「没认出来，先按 X 建，可以点一下改」——绝不假装认出来了。
 *     子品牌只来自用户输入（或他自己点的「AI 帮我找」，那一步在 BrandIpManager 里，未确认不落库）。
 *   · **幂等**：同一批名字重复写不会产生第二条（大小写不敏感，与 store 的归一化同口径）。
 *   · **有上限**：一次最多写 20 个（防止把一整段文章粘进输入框，几百条脏数据进库）。
 */

/** 身份顺序（与建档向导第 1 步的 4 张卡同序：诊所 → 经销商 → 厂家 → 平台）。 */
export const ONECLICK_TYPES = ['clinic', 'dealer', 'manufacturer', 'platform'];

/** 身份的中文名（界面用；与 SETUP_TYPES 的 label 必须一致，由门禁比对）。 */
export const ONECLICK_TYPE_LABELS = {
  clinic: '诊所',
  dealer: '经销商',
  manufacturer: '厂家',
  platform: '平台',
};

/**
 * 类型推断规则表。
 *
 * ⚠️ 顺序 = 优先级，**先匹配先生效**。为什么 platform 排最前：
 *    「口腔平台」「耗材供应链商城」这类名字里同时含「口腔」（诊所学）与「平台」（平台学），
 *    而用户自己的定位是平台 —— 把更具体的那一类放前面，才不会被泛词抢走。
 *    实测反例：「康健苗苗口腔平台」若按 clinic 优先会判成诊所（错）。
 *
 * 每条词的来源都是行业里真会出现在**注册名**里的字，不是随便凑的：
 *   · 诊所类：口腔 / 牙科 / 齿科 / 门诊 / 诊所 / 医院（这六个词几乎只出现在机构名里）
 *   · 经销类：贸易 / 商贸 / 销售 / 经销 / 代理 / 供应链 / 器械（拿货分销的注册名）
 *   · 厂家类：集团 / 制造 / 实业 / 科技 / 生物 / 工厂 / 生产（生产方注册名）
 *   · 平台类：平台 / 商城 / 电商 / 集采 / 服务商 / 云平台 / 云计算 …（服务商注册名）
 *
 * ⚠️ 两个字以上的词才收（`云`、`易`、`新` 这种单字到处都有，会把不相干的名字全判成平台）；
 *    `种植` / `正畸` 也刻意**不收**进诊所类 —— 「正畸材料有限公司」是厂家，不是诊所。
 *    宁可认不出（`confident=false`，界面上明说并让人一键改），也不能认错。
 */
export const TYPE_RULES = [
  {
    type: 'platform',
    words: ['平台', 'saas', '商城', '电商', '集采', '服务商', '云平台', '云计算', '云医', '云诊'],
  },
  {
    type: 'clinic',
    words: ['口腔', '牙科', '齿科', '门诊', '诊所', '医院'],
  },
  {
    type: 'dealer',
    words: ['贸易', '商贸', '销售', '经销', '代理', '供应链', '器械'],
  },
  {
    type: 'manufacturer',
    words: ['集团', '制造', '实业', '科技', '生物', '工厂', '生产'],
  },
];

/**
 * 从公司名推断身份。
 *
 * @param {string} name 公司 / 诊所名（可为空）
 * @param {string} [fallback] 认不出来时用哪个（默认 'manufacturer'）
 * @returns {{type:string, label:string, confident:boolean, hit:string, why:string}}
 *   `confident=false` ⇒ 界面必须明说"没认出来、先按这个建、可以改"，不许装认出来了。
 */
export function inferCompanyType(name, fallback) {
  const text = String(name == null ? '' : name).trim();
  const fb = ONECLICK_TYPES.includes(fallback) ? fallback : 'manufacturer';
  if (!text) {
    return {
      type: fb,
      label: ONECLICK_TYPE_LABELS[fb],
      confident: false,
      hit: '',
      why: '还没填公司名，先按' + ONECLICK_TYPE_LABELS[fb] + '建，填完会重新判断',
    };
  }
  const lower = text.toLowerCase();
  for (const rule of TYPE_RULES) {
    for (const w of rule.words) {
      if (!w) continue;
      if (lower.includes(String(w).toLowerCase())) {
        return {
          type: rule.type,
          label: ONECLICK_TYPE_LABELS[rule.type],
          confident: true,
          hit: w,
          why: '名字里有「' + w + '」⇒ 判为' + ONECLICK_TYPE_LABELS[rule.type],
        };
      }
    }
  }
  return {
    type: fb,
    label: ONECLICK_TYPE_LABELS[fb],
    confident: false,
    hit: '',
    why: '名字里没有能判断身份的词，先按' + ONECLICK_TYPE_LABELS[fb] + '建，可以点一下改',
  };
}

/** 一次最多写多少个子品牌（防粘一篇文章进输入框）。 */
export const MAX_SUB_BRANDS = 20;

/** 单个子品牌名最长多少字（超过的整条丢弃并报出来，不做截断 —— 截断会造出一个不存在的名字）。 */
export const MAX_SUB_BRAND_LEN = 24;

/**
 * 把输入框里的一行文字拆成子品牌名列表。
 *
 * 分隔符：顿号 / 中英文逗号 / 分号 / 竖线 / 斜杠 / 换行 / 空格 —— 用户怎么写都行，
 * 这是"一键"的前提：不该要求他按某种格式输入。
 *
 * 三条硬规则（都是**静默出错**的类型，界面上看不出来，所以在这里做掉）：
 *   ① 排除主品牌自己（大小写不敏感）—— 否则「康健苗苗」会被登记成自己的子品牌；
 *      判定两条：完全相同，或**被主品牌名包含且自身 ≥3 字**（「康健苗苗」⊂「康健苗苗集团」）。
 *      为什么不只判完全相同：老板真会写成「公司名：康健苗苗集团 / 子品牌：康健苗苗、舒雅星系」，
 *      只判完全相同会让「康健苗苗」进库变成自己的子品牌（下游会把自有品牌当竞品分析）。
 *      为什么不判 2 字：2 字名（如「苗苗」「康健」）很可能是真的独立子品牌，宁可留着让人删。
 *   ② 去重（大小写不敏感）—— 否则「舒雅星系、舒雅星系」会写进两条；
 *   ③ 超长（> MAX_SUB_BRAND_LEN）整条丢弃并放进 `dropped`，不做截断。
 *
 * @param {string} text 用户输入
 * @param {string} [mainName] 主品牌名（会被排除）
 * @param {{max?:number}} [opts]
 * @returns {{names:string[], dup:string[], dropped:string[], truncated:boolean, total:number}}
 *   `total` = 拆分后（去空）的原始条数，用来自证"我数得出来"（对照组的分子）。
 */
export function parseSubBrands(text, mainName, opts) {
  const raw = String(text == null ? '' : text);
  const main = String(mainName == null ? '' : mainName).trim().toLowerCase();
  const cap = Number(opts && opts.max) > 0 ? Math.floor(Number(opts.max)) : MAX_SUB_BRANDS;

  const parts = raw
    .split(/[、,，;；|｜/\\\r\n\t ]+/)
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  const names = [];
  const dup = [];
  const dropped = [];
  const seen = new Set();

  for (const p of parts) {
    const key = p.toLowerCase();
    if (p.length > MAX_SUB_BRAND_LEN) {
      dropped.push(p);
      continue;
    }
    if (main && (key === main || (p.length >= 3 && main.includes(key)))) {
      dup.push(p); // 与主品牌同名 / 是主品牌名的一部分 ⇒ 不是自己的子品牌（静默跳过，界面上报"重复"）
      continue;
    }
    if (seen.has(key)) {
      dup.push(p);
      continue;
    }
    seen.add(key);
    names.push(p);
  }

  const truncated = names.length > cap;
  return {
    names: truncated ? names.slice(0, cap) : names,
    dup,
    dropped,
    truncated,
    total: parts.length,
  };
}

/**
 * 把一批子品牌名合并进已有列表（幂等）。
 *
 * 与 `BrandIpManager.buildMany` 同口径：小写去重、复用 `normalizeBrandIp` 归一化、来源标注照传。
 * 区别只有一个：这里**返回新列表**，写库由调用方做（纯函数才能在 node 里断言）。
 *
 * @param {Array} existing 已登记列表（可为空）
 * @param {string[]} names 要新增的名字
 * @param {string} [note] 来源标注
 * @returns {{list:Array, added:number, skipped:string[]}}
 */
export function mergeBrandIps(existing, names, note) {
  const list = (Array.isArray(existing) ? existing : []).map((x) => normalizeBrandIp(x)).filter((x) => x.name);
  const seen = new Set(list.map((x) => String(x.name || '').trim().toLowerCase()).filter(Boolean));
  const added = [];
  const skipped = [];
  (Array.isArray(names) ? names : []).forEach((rawName) => {
    const nm = String(rawName == null ? '' : rawName).trim();
    if (!nm) return;
    const key = nm.toLowerCase();
    if (seen.has(key)) {
      skipped.push(nm);
      return;
    }
    seen.add(key);
    const ip = normalizeBrandIp({ name: nm, aliases: [], note: String(note || ''), enabled: true });
    list.push(ip);
    added.push(ip);
  });
  return { list, added: added.length, skipped };
}

/**
 * 一键建档完成后的**成绩单**（一行说清"建了什么、哪些没拿到"）。
 *
 * 为什么要有它：一键把三个动作（建企业 / 补画像 / 建子品牌）合成一次点击后，
 * 用户看不到中间过程 —— 只说"完成"等于让他自己回库里去查。这里如实列成三句。
 *
 * @param {object} r
 * @param {string} r.companyName 企业名
 * @param {string} r.typeLabel 身份中文名
 * @param {boolean} r.reused true = 更新了现有企业（不是新建）
 * @param {boolean} r.profileOk 画像是否真的拿到了（AI/联网都挂了 ⇒ false，如实说）
 * @param {number} r.brandsAdded 本次新增子品牌数
 * @param {number} r.brandsTotal 建档后子品牌总数
 * @param {number} [r.coverageFilled] 画像已补齐项数
 * @param {number} [r.coverageTotal] 画像总项数
 * @returns {string}
 */
export function summarizeOneClick(r) {
  const o = r && typeof r === 'object' ? r : {};
  const name = String(o.companyName || '').trim() || '（未命名企业）';
  const label = String(o.typeLabel || '').trim();
  const lines = [];
  lines.push('✅ ' + name + (label ? '（' + label + '）' : '') + (o.reused ? ' 已就地建档' : ' 已建档'));
  lines.push(
    o.profileOk
      ? '🧠 画像已按检索结果补齐' +
          (Number(o.coverageTotal) > 0 ? '：' + Number(o.coverageFilled || 0) + '/' + Number(o.coverageTotal) + ' 项' : '')
      : '⚠️ 画像没拿到（AI / 联网不可用），已只按你填的资料建档，回企业大脑可重试',
  );
  const added = Number(o.brandsAdded || 0);
  const total = Number(o.brandsTotal || 0);
  if (total > 0) {
    lines.push(
      added > 0
        ? '🏷️ 子品牌新增 ' + added + ' 个，现在共 ' + total + ' 个'
        : '🏷️ 子品牌没有新增（填的名字都已登记过），共 ' + total + ' 个',
    );
  } else {
    lines.push('🏷️ 这次没填子品牌 —— 之后在「子品牌」里点「⚡ 一键建档」可以自动找');
  }
  return lines.join('\n');
}
