/**
 * scheduleFeed.js —— 官方档期（上游货源活动档期）在客户端的**唯一读取口径**。
 * 0.21.14 · 需求 1「档期只读化 + 红点」的底座（T01 共享底座）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【为什么要有这个文件】
 *   0.21.13 及以前，客户端的「档期」是**本地可写**的：`promoCalendar.savePromoRecords` +
 *   `PromoCalendarPanel` 让用户在客户端自己录活动档期。老板 0.21.14 原话是
 *   「在workbench后台要加入一个上传banner，他跟现有的上游货源活动档期是一致的」——
 *   即**档期由后台一处维护，客户端只读**。
 *   ⇒ 客户端不再有任何写入口（S9：`modules/` 与 `components/` 下禁止再 import `savePromoRecords`），
 *     数据源换成服务器的 `GET /api/meimiaomiao/schedules`。
 *
 * 【为什么走 geoProxy 而不是渲染进程裸 fetch】（架构设计 §10.1 P1）
 *   `api.example.com` 实测**会回显** `access-control-allow-origin: app://douya` + `allow-credentials: true`，
 *   裸 fetch 技术上成立 —— 但选 `geoProxy` 是工程取舍：token 注入 / 租户头 / 401 中文映射一处实现，
 *   且不依赖 `main.js:582` 那种**静默失效**的 `onBeforeSendHeaders` 隐式钩子。
 *   `fetchImpl` 参数留作**可逆点**（想换裸 fetch 只改调用方一行），不是为了当备选方案。
 *
 * 【归一化的红线】
 *   · 标题**原文透传**，不改写（沿用 `promoCalendar.js` 的红线 3：不替用户改写他自己写的活动名）。
 *   · 日期非法 ⇒ `''`（**不猜**）。`startDate`/`endDate` 任一非法 ⇒ `_state = 'invalid'`。
 *   · `quota` 非数字 / 缺失 ⇒ `0`（0 表示「未配置 / 不限」，不是「0 个名额」）。
 *   · `status` 后端原样透传，**不翻译**（`open`/`closed` 是后端语义，前端翻译会造出第二套真源）。
 *   · `createdAt` 非法 / 缺失 ⇒ `''` 且**不参与红点计数**（不知道就不报，不骗人）。
 *
 * 【banner 的唯一形态】（S12 / §1.7.1 约束②）
 *   `https://api.example.com/api/meimiaomiao/banner-public?file=<bannerFile>` —— 0.21.18 起走
 *   `/banner-public`（**公开只读**出口，`<img src>` 带不上 Bearer token，见 BANNER_BASE 注释的实测）。
 *   **参数必须放 query**（路径形态 `.../banner/<file>.png` 线上被 nginx 按静态文件拦掉，见 BANNER_BASE 注释）。
 *   **不得**用 `/attachment/`：那条路由无条件 `Content-Disposition: attachment`，
 *   `<img>` 拿不到图（G9 已把它列为禁区：不许改成 inline）。
 *
 * 【导入顺序注意】本文件**不 import 任何组件**，只依赖 `api.js` 的 `geoProxy`。
 * 组件间不互相 import（S8），红点刷新靠 window 事件。
 */

import { geoProxy } from '../api.js';

/** 官方档期接口路径（相对 geoProxy 的后端路径）。 */
export const SCHEDULE_PATH = '/api/meimiaomiao/schedules';
/**
 * banner 唯一地址前缀（S12：客户端不许硬编码任何图片地址，只许拼这个前缀）
 *
 * ⚠️ 走 **query 参数**而不是路径参数，原因是**线上 nginx 会拦图片扩展名**（2026-10-20 实测）：
 * ```
 * GET /api/meimiaomiao/banner/a.png  → 404  Content-Type: text/html   162B   ← nginx 回的
 * GET /api/meimiaomiao/banner?file=a.png → 404  application/json        22B   ← 后端回的（路由通了，只是文件不存在）
 * GET /api/meimiaomiao/banner/a      → 404  application/json        22B   ← 无扩展名也能到后端
 * ```
 * 即 nginx 有一条「图片扩展名 ⇒ 按静态文件取」的 location 正则，而 `/banner/` 这条路由
 * **没有** `^~` 放行的更长前缀（对比 `/attachment/` 有，所以它能到后端）。
 * ⇒ 路径形态 `.../banner/<file>.png` 在线上**永远到不了后端**，`<img>` 全是空白，且不报错。
 *
 * ⇒ 改成无扩展名的 `/banner` + `?file=`，绕开扩展名正则。
 * **不要改回路径形态**，除非先确认 nginx 加了 `location ^~ /api/meimiaomiao/banner/`。
 *
 * ── 0.21.18 · 修 Bug A：路由从 `/banner` 换成 `/banner-public` ─────────────────
 * 【病因（2026-10-21 线上实测，不是推断）】
 *   `<img src>` 的请求由渲染内核自己发出，**带不上** `Authorization: Bearer <token>`；
 *   而 `/banner` 与模块内其它接口同口径要求登录，于是：
 *     · 无 token → `HTTP 401 {"detail":"未登录或登录已过期"}`（40 字节 JSON，不是图片）
 *     · 带真实 session token → `HTTP 200 image/jpeg 412132 字节`，`Content-Disposition: inline`
 *   ⇒ 图和路由都是好的，**唯一致命点是鉴权要求的传输方式与 `<img>` 能提供的传输方式不兼容**。
 *   客户端这一侧除了换地址没有第二种解法（没有任何办法给 `<img>` 加自定义头），
 *   所以服务端补了一条**公开只读**出口 `/banner-public`（同样只认图片扩展名、
 *   同样 realpath + dirname 防穿越、同样 isfile 才 200），原 `/banner` 的鉴权保持不变。
 *
 * 【为什么这个改动是安全的（不是"把鉴权关掉"）】
 *   · 这条出口只吐「上传目录内、扩展名属于 BANNER_EXT 的图片」，不列目录、不返回任何业务字段；
 *   · 文件名白名单是 `[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)`，`..` / `/` / `\` 全部进不来；
 *   · `/banner`（要登录）仍在，运营后台预览走它，行为零变化。
 *
 * 【部署依赖 —— 这条必须写在代码里，否则下一个人会以为是客户端写错了】
 *   客户端先改、后端后部署的时间窗里，banner 会 404（而不是 401），页面上仍然是一个
 *   `onError` 撤掉的破图 —— 不会崩、不会显示错图。两端都上线后才有图。
 */
export const BANNER_BASE = 'https://api.example.com/api/meimiaomiao/banner-public?file=';

/**
 * 把服务端的 `banner_url` 归一成**裸文件名** `bannerFile`。
 *
 * 服务端出参是 snake_case `banner_url`，形态可能是下面几种，本函数全部吃：
 *   · `''` / `null` / `undefined`                              → `''`
 *   · `/api/meimiaomiao/banner/a1b2c3.png`（路径形态，旧）      → `'a1b2c3.png'`
 *   · `/api/meimiaomiao/banner?file=a1b2c3.png`（query 形态，现用）→ `'a1b2c3.png'`
 *   · `https://api.example.com/api/meimiaomiao/banner?file=x.png`  → `'x.png'`
 *   · `a1b2c3.png`（已经是裸名）                                → `'a1b2c3.png'`
 *
 * **必须同时支持 query 与 path 两种形态**：旧路径形态已在线上被 nginx 拦（见 {@link BANNER_BASE}），
 * 但服务端 `banner_url` 字段里存的到底是哪种、以及它哪天切换，客户端都不能假设 ——
 * 只认一种就会在切换当天**静默**把文件名解析成 `'banner'`（路径最后一段），
 * 拼出 `.../banner?file=banner`，404 得毫无线索。
 *
 * **取尾部段**而不是原样透传：早期那种「客户端自己拼好的完整地址」口径已在 0.21.14 废止，
 * 现在**全仓存量为 0**（连注释里也不许出现那个字面名 —— 那条硬约束按「出现即算」执行，
 * 与 AC-3.6c 对「市场价字段名」的处理同一条纪律：改注释也算改，不许留一个「已经废止」的
 * 同名标记给下一个人当模板抄）。内部只存裸名，地址拼装统一走 {@link bannerSrcOf}，
 * 这样哪天地址形态变了只改一处，T02（活动页）与 T04（补货页）不会各错一半。
 *
 * @param {*} v 服务端 `banner_url` / 或已是裸文件名
 * @returns {string} 裸文件名，取不到则 `''`
 */
export function bannerFileOf(v) {
  const raw = v === null || v === undefined ? '' : String(v).trim();
  if (!raw) return '';

  /** 从一段「可能带路径」的字符串里取最后一段文件名；空 / 以 `/` 结尾 ⇒ `''`。 */
  const tailOf = (s) => {
    const t = String(s).trim();
    if (!t || t.endsWith('/')) return '';
    const parts = t.split('/').filter((x) => x !== '');
    const tail = parts.length ? parts[parts.length - 1] : '';
    return tail && tail !== '.' && tail !== '..' ? tail : '';
  };

  const hashAt = raw.indexOf('#');
  const noHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const qAt = noHash.indexOf('?');
  const pathPart = qAt === -1 ? noHash : noHash.slice(0, qAt);
  const queryPart = qAt === -1 ? '' : noHash.slice(qAt + 1);

  // ① 有 `?file=` ⇒ 以它为准（与 BANNER_BASE 的服务端契约一致）。
  // 手写解析而不是 URLSearchParams：`?file=a%20b.png` 那种转义保持原样，不做 decode，
  // 保证「存什么取什么，字符串完全相等」——decode 一次就可能与本地存的裸名对不上。
  for (const pair of queryPart.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) !== 'file') continue;
    const val = pair.slice(eq + 1);
    // `?file=` 空值 ⇒ 确实没有图，返回 '' （**不要**退化去取路径尾段，那会把 `banner` 当文件名）
    return val ? tailOf(val) : '';
  }

  // ② 没有 `file=` 参数 ⇒ 只可能是「路径形态」，取路径尾段。
  // 但**必须**区分「尾段是文件名」和「尾段是路由名」：
  //   `/api/meimiaomiao/banner/a.png?t=1`  → 尾段 `a.png`，带扩展名 ⇒ 是文件名
  //   `/api/meimiaomiao/banner?x=1`        → 尾段 `banner`，无扩展名 ⇒ 是路由名，判 ''
  // 用「含 `.`」当判据：上游文件名是「随机 hex + 扩展名」，必有扩展名；
  // 而路由名（`banner` / `attachment`）不含 `.`。猜错时的代价不对称 ——
  // 判成文件名会拼出一个必然 404 的地址（且错得很安静），判成空只是这一条不出图。
  const tail = tailOf(pathPart);
  if (!tail) return '';
  return tail.includes('.') ? tail : '';
}

/**
 * 由裸文件名拼出**可直接给 `<img src>` 的完整地址**（S12 唯一拼装点）。
 *
 * 空文件名 ⇒ `''`（**绝不**拼成 `'.../banner/'` / `'.../banner?file='` 这种残缺地址——
 * 那会变成一个必然 404 的请求，而且错得很安静）。
 * T02 / T04 都必须调本函数，不要各自 `BANNER_BASE + file`。
 *
 * ⚠️ **不做 `encodeURIComponent`**：上游文件名白名单是 `[A-Za-z0-9._-]`（随机 hex + 扩展名），
 * 这些字符在 query 值里本来就合法。加 encode 会产出 `%`，让「存什么取什么、字符串完全相等」
 * 的断言变复杂，却挡不住任何真实攻击面（真正的攻击面在白名单校验那一侧）。
 *
 * @param {*} bannerFile 裸文件名（或任意服务端原值，内部会先过 {@link bannerFileOf}）
 * @returns {string} 完整 https 地址，或 `''`
 */
export function bannerSrcOf(bannerFile) {
  const file = bannerFileOf(bannerFile);
  return file ? BANNER_BASE + file : '';
}
/** 档期红点已读水位（S7）：`{ [companyId]: maxCreatedAt }`。 */
export const SEEN_KEY = 'douya-schedule-seen';

/**
 * 严格 ISO 日期（`YYYY-MM-DD`）校验：既查形状，也查是不是真实存在的日期
 * （`2026-02-30` 形状合法但不存在 ⇒ 判非法，不猜）。
 * @param {*} s 待校验值
 * @returns {boolean}
 */
export function isISODate(s) {
  const v = String(s === null || s === undefined ? '' : s).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(5, 7));
  const d = Number(v.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 把任意时间输入归一成 `YYYY-MM-DD`（本地时区）。
 * 非法输入返回 `''` —— 调用方必须自己决定「没有今天」时怎么办，本函数不替它编一个日期。
 * @param {Date|string|number} [now] 缺省 = 现在
 * @returns {string}
 */
export function todayISO(now) {
  const d = now === undefined || now === null ? new Date() : now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 两个 `YYYY-MM-DD` 之间的整天差（`to - from`）。任一非法返回 `null`（不是 0，0 是「同一天」）。
 * @param {string} from
 * @param {string} to
 * @returns {number|null}
 */
export function diffDays(from, to) {
  if (!isISODate(from) || !isISODate(to)) return null;
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86400000);
}

/**
 * 归一化字符串字段：`null`/`undefined` → `''`，其余 `String().trim()` 后**原样保留内容**。
 * @param {*} v
 * @returns {string}
 */
function asText(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * 归一化数字字段：非法 / 缺失 → `0`（`quota` 的 0 表示「未配置 / 不限」）。
 * @param {*} v
 * @returns {number}
 */
function asCount(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 归一化「可缺省的计数」：**缺失 / 非法 → `null`，合法的 0 → `0`**。
 *
 * 为什么不能复用 {@link asCount}：`quota` 的 0 有明确语义（未配置 / 不限），
 * 而 `signedCount`（已报人数）的 0 是**一个真实读数**（一个人都没报）。
 * 两者混用一个函数，界面上就会出现「已报 0 人」去冒充「后台没给这个字段」——
 * 前者是事实，后者是**不知道**。不知道就必须显示"未提供"，不许编一个 0 出来。
 *
 * @param {*} v
 * @returns {number|null}
 */
function asCountOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * 归一化「活动介绍图片」数组 → 可直接给 `<img src>` 的完整地址数组。
 *
 * ⚠️ 红线：**后端没给图片就返回空数组**，绝不补占位图 —— 调用方见到 `length === 0`
 * 必须整块不渲染。历史教训：给空图片位留一个灰框，用户会以为"图片加载失败"，
 * 而其实是后台根本没配（两种完全不同的故障，长得很像）。
 *
 * 每个元素过 {@link bannerSrcOf}：图片走同一条 `/banner?file=` 路由（服务端只白名单
 * `[A-Za-z0-9._-]`），所以解析不出裸文件名的那一条直接丢掉，不拼半截地址。
 *
 * @param {*} v 服务端 `intro_images` / `images`（数组 / 单个字符串 / JSON 字符串）
 * @returns {string[]}
 */
function asImageSrcList(v) {
  let list = v;
  if (typeof list === 'string') {
    const s = list.trim();
    if (!s) return [];
    // 有些后端把数组序列化成 JSON 字符串存进同一列 —— 能解析就用解析结果，解析不了当单个值
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        list = Array.isArray(parsed) ? parsed : [s];
      } catch {
        list = [s];
      }
    } else {
      list = s.split(',').map((x) => x.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    const src = bannerSrcOf(it);
    if (src) out.push(src);
  }
  return out;
}

/**
 * 归一化一条官方档期 → `ScheduleItem`（契约见架构设计 §3.1）。
 * @param {object} raw 后端单条记录（字段可能缺失，本函数容错）
 * @returns {object} ScheduleItem（含派生的 `_state`）
 */
export function normalizeSchedule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  // 服务端出参 `banner_url`（snake_case）→ 归一成裸文件名 `bannerFile` → 再由 bannerSrcOf 拼完整地址。
  // 兼容 `banner_file` / 已是裸名的 `bannerFile` 两种历史写法，但**不接受**「客户端自己拼好的
  // 完整地址」那种废止口径（它的字面名全仓不许出现，见 bannerFileOf 上方的说明）。
  const bannerRaw = r.banner_url !== undefined
    ? r.banner_url
    : r.banner_file !== undefined
      ? r.banner_file
      : r.bannerFile;
  const bannerFile = bannerFileOf(bannerRaw);
  /**
   * 活动介绍图片：服务端可能叫 `intro_images` / `images` / `introImages`，三者都吃。
   * 取第一个**存在**的键（用 `!== undefined` 而不是 `||`：`''` 也是"后台明确没配"的有效回答，
   * 不能被下一条键的值顶掉）。
   */
  const imagesRaw = r.intro_images !== undefined
    ? r.intro_images
    : r.images !== undefined
      ? r.images
      : r.introImages;
  const item = {
    id: asText(r.id),
    // 标题原文透传：不改写、不截断（红线 3）
    title: asText(r.title),
    theme: asText(r.theme),
    startDate: isISODate(r.start_date) ? asText(r.start_date) : isISODate(r.startDate) ? asText(r.startDate) : '',
    endDate: isISODate(r.end_date) ? asText(r.end_date) : isISODate(r.endDate) ? asText(r.endDate) : '',
    signupStart: isISODate(r.signup_start) ? asText(r.signup_start) : isISODate(r.signupStart) ? asText(r.signupStart) : '',
    signupDeadline: isISODate(r.signup_deadline) ? asText(r.signup_deadline) : isISODate(r.signupDeadline) ? asText(r.signupDeadline) : '',
    quota: asCount(r.quota),
    rules: asText(r.rules),
    /** 报名方式说明（后台运营写的，纯文本；没配 ⇒ `''`，界面显示「后台未填写报名方式」）。 */
    signupMethod: asText(
      r.signup_method !== undefined
        ? r.signup_method
        : r.signupMethod !== undefined
          ? r.signupMethod
          : r.how_to_signup,
    ),
    /** 活动介绍图片（完整地址数组；没配 ⇒ `[]`，界面整块不渲染）。 */
    introImages: asImageSrcList(imagesRaw),
    /**
     * 已报人数。`null` = 后台没给这个字段（**不等于 0**），界面必须显示「未提供」。
     * 三种历史字段名都吃：`signed_count` / `signup_count` / `signed`。
     */
    signedCount: (() => {
      const v = r.signed_count !== undefined
        ? r.signed_count
        : r.signup_count !== undefined
          ? r.signup_count
          : r.signed;
      return asCountOrNull(v);
    })(),
    // 后端 'open'/'closed' 原样透传，不翻译（翻译会造出第二套真源）
    status: asText(r.status),
    /**
     * 演示数据标记。客户端**自己造的**演示活动带 `_demo: true`；
     * 后端若在出参里显式给 `demo: true` 也认（这样以后后端接管演示数据不用改前端）。
     * 界面必须据此打「演示数据」角标 —— 演示数据不许与真实活动长得一样。
     */
    isDemo: r._demo === true || r.demo === true,
    bannerFile,
    bannerSrc: bannerSrcOf(bannerFile),
    // 红点计数依赖：非法 / 缺失 → ''（不参与计数）
    createdAt: asText(r.created_at !== undefined ? r.created_at : r.createdAt),
    updatedAt: asText(r.updated_at !== undefined ? r.updated_at : r.updatedAt),
    _state: 'invalid',
  };
  item._state = deriveScheduleState(item, undefined);
  return item;
}

/**
 * 派生档期状态（**唯一口径**，复用 `promoCalendar.promoStatus` 的天数语义，但日期源换成官方字段）。
 *   · `startDate`/`endDate` 任一非法            → `invalid`
 *   · `today > endDate`                        → `ended`（「近期活动安排」要过滤掉它，AC-1.5）
 *   · `today < startDate`                      → `upcoming`
 *   · 其余（含首尾当天）                        → `ongoing`
 * @param {object} item 归一化后的 ScheduleItem
 * @param {Date|string|number} [now] 缺省 = 现在
 * @returns {'ongoing'|'upcoming'|'ended'|'invalid'}
 */
export function deriveScheduleState(item, now) {
  const it = item || {};
  if (!isISODate(it.startDate) || !isISODate(it.endDate)) return 'invalid';
  if (diffDays(it.startDate, it.endDate) < 0) return 'invalid'; // 起止颠倒：同样不猜
  const today = todayISO(now === undefined ? new Date() : now);
  if (!today) return 'invalid';
  if (diffDays(today, it.endDate) < 0) return 'ended';
  if (diffDays(today, it.startDate) > 0) return 'upcoming';
  return 'ongoing';
}

/**
 * 从上游响应里尽力找出「档期数组」（形状未公开，按候选键逐个试；找不到就给空数组，不猜）。
 * @param {object} res geoProxy 返回值
 * @returns {Array}
 */
export function extractScheduleList(res) {
  if (!res || typeof res !== 'object') return [];
  const data = res.data;
  const candidates = [
    res.schedules,
    res.items,
    res.list,
    res.records,
    res.rows,
    data && data.schedules,
    data && data.items,
    data && data.list,
    data && data.records,
    data && data.rows,
    data,
    res.result && res.result.list,
    res.result,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * 读取官方档期（**只读**，永不写库）。
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 取数实现，默认 `geoProxy`（可注入用于单测打桩 / 换裸 fetch）
 * @param {string} [opts.from] 起始日期 `YYYY-MM-DD`，缺省 = 今天
 * @param {string} [opts.to] 结束日期，缺省 = 今天 + 90 天
 * @param {Date|string|number} [opts.now] 注入「今天」（单测用）
 * @returns {Promise<{ok:boolean, items:Array, error?:string, raw?:object}>}
 *   失败时 `items` 恒为 `[]` —— 调用方拿不到数据就显示「暂无数据」，**不许编示例**。
 */
export async function loadSchedules(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : geoProxy;
  const today = todayISO(o.now === undefined ? new Date() : o.now) || todayISO(new Date());
  const from = isISODate(o.from) ? o.from : today;
  const to = isISODate(o.to) ? o.to : todayISO(new Date(new Date(from + 'T00:00:00').getTime() + 90 * 86400000));
  try {
    const res = await fetchImpl(SCHEDULE_PATH, 'GET', { from, to });
    if (!res || res.ok === false) {
      return { ok: false, items: [], error: (res && res.error) || '官方档期读取失败' };
    }
    const items = extractScheduleList(res)
      .map(normalizeSchedule)
      // 没有标题的档期不渲染（空行没有意义，也不能拿它凑数）
      .filter((x) => x && x.title);
    return { ok: true, items, raw: res };
  } catch (e) {
    return { ok: false, items: [], error: (e && e.message) || '官方档期读取失败' };
  }
}

/**
 * 「近期活动安排」口径：**过滤掉已结束的**（AC-1.5），保留 ongoing / upcoming，invalid 也保留
 * （日期缺失的档期要显式露出来，让用户看见「这条没配好」，而不是悄悄藏掉）。
 * @param {Array} items ScheduleItem[]
 * @returns {Array}
 */
export function filterVisibleSchedules(items) {
  return (Array.isArray(items) ? items : []).filter((x) => x && x._state !== 'ended');
}

/**
 * 只保留**当前进行中**的档期（AI 补货页 banner 用，Q4：无进行中则整块不渲染）。
 * @param {Array} items ScheduleItem[]
 * @param {Date|string|number} [now]
 * @returns {Array}
 */
export function filterOngoingSchedules(items, now) {
  return (Array.isArray(items) ? items : []).filter(
    (x) => x && deriveScheduleState(x, now) === 'ongoing',
  );
}

/**
 * 补货页 banner 取哪一条（Q4b）：**按 `startDate` 升序取第 1 张**，其余不铺。
 * 无进行中档期 / 都配了图但没有 bannerFile ⇒ 返回 `null`（调用方整块不渲染，不占位、不写「暂无数据」）。
 *
 * 0.21.17：实现改为对 {@link pickActiveBanner} 的**转发**（限定 `states: ['ongoing']`），
 * 保留这个导出是因为 `modules/Replenish.jsx` 在用（不许改名/删）。
 * 转发而不是复制一份逻辑：banner 选序只能有**一套**规则，两套必然在某天分叉
 * （本仓已经因"两套日期口径"吃过一次亏）。
 *
 * @param {Array} items ScheduleItem[]
 * @param {Date|string|number} [now]
 * @returns {object|null}
 */
export function pickReplenishBanner(items, now) {
  return pickActiveBanner(items, now, { states: ['ongoing'] });
}

/** 默认的 banner 选序：先「进行中」、再「即将开始」；同一档内按 `startDate` 升序。 */
export const ACTIVE_BANNER_STATES = ['ongoing', 'upcoming'];

/**
 * 「用户现在最该看到的那张 banner」—— 活动与档期页用（补货页是它的 ongoing-only 特例）。
 *
 * 选序（**唯一口径**，两页共用）：
 *   ① 先按 `states` 的顺序分档（默认 ongoing → upcoming）；
 *   ② 同一档内按 `startDate` 升序取第 1 条（"最先开始的那场"就是当下最该看到的）；
 *   ③ 只考虑**配了图**的条目（`bannerSrc` 非空）——没图的不能当 banner。
 * 一条都没有 ⇒ `null`（调用方**整块不渲染**，不占位、不写「暂无数据」）。
 *
 * 为什么 upcoming 也要能当 banner（与补货页的差异）：活动与档期页是"看档期"的主页面，
 * 用户提前看到"下周要开始的活动"是有意义的信息；补货页是"现在要备货"，只有进行中的
 * 活动图才有用，所以那里限定 `['ongoing']`。
 *
 * @param {Array} items ScheduleItem[]
 * @param {Date|string|number} [now] 注入「今天」（单测用）
 * @param {{states?: string[]}} [opts] `states` 覆盖优先级顺序（缺省见 {@link ACTIVE_BANNER_STATES}）
 * @returns {object|null}
 */
export function pickActiveBanner(items, now, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const states = Array.isArray(o.states) && o.states.length ? o.states : ACTIVE_BANNER_STATES;
  const withImg = (Array.isArray(items) ? items : []).filter((x) => x && x.bannerSrc);
  if (!withImg.length) return null;
  for (const st of states) {
    const hit = withImg
      .filter((x) => deriveScheduleState(x, now) === st)
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
    if (hit.length) return hit[0];
  }
  return null;
}

/**
 * 报名入口「能不能点」——**唯一口径**，界面不许自己另写一套判断。
 *
 * 四种拦截原因，各有各的人话（不能合并成一句"不能报名"，用户需要知道该找谁）：
 *   · 活动已结束（`_state === 'ended'`）                      → 「活动已结束」
 *   · 后台关了报名（`status === 'closed'`）                    → 「后台已关闭报名」
 *   · 名额已满（`quota > 0` 且 `signedCount` 已知且 `>= quota`）→ 「名额已满」
 *   · 过了报名截止日（`signupDeadline` 合法且 `today > deadline`）→ 「报名已截止」
 *
 * ⚠️ `quota === 0` 表示**未配置 / 不限**，永远不算"满"。把 0 当满会让所有没配名额的
 *    活动都报不了名 —— 这是本仓最容易写错、又最不容易被发现的一处。
 * ⚠️ `signedCount === null`（后台没给）时**不判满**：不知道就不拦，宁可让用户点进去
 *    被后台拒，也不要凭"没数据"就说人家满了。
 *
 * @param {object} item ScheduleItem
 * @param {Date|string|number} [now]
 * @returns {{allowed: boolean, reason: string}}
 */
export function deriveSignupState(item, now) {
  const it = item && typeof item === 'object' ? item : {};
  if (deriveScheduleState(it, now) === 'ended') return { allowed: false, reason: '活动已结束' };
  if (it.status === 'closed') return { allowed: false, reason: '后台已关闭报名' };
  const quota = asCount(it.quota);
  const signed = it.signedCount === undefined ? null : asCountOrNull(it.signedCount);
  if (quota > 0 && signed !== null && signed >= quota) {
    return { allowed: false, reason: '名额已满（' + signed + ' / ' + quota + '）' };
  }
  if (isISODate(it.signupDeadline)) {
    const today = todayISO(now === undefined ? new Date() : now);
    if (today && diffDays(today, it.signupDeadline) < 0) {
      return { allowed: false, reason: '报名已截止（截止 ' + it.signupDeadline + '）' };
    }
  }
  return { allowed: true, reason: '' };
}

/**
 * 名额的人话文案（`quota === 0` ⇒ 「不限」，**绝不显示成「0 个名额」**）。
 * @param {object} item ScheduleItem
 * @returns {string}
 */
export function quotaLabelOf(item) {
  const q = asCount(item && item.quota);
  return q > 0 ? q + ' 个名额' : '名额不限';
}

/**
 * 报名情况的人话文案（名额 / 已报 / 是否已满）。
 *
 * `signedCount === null` ⇒ 「已报人数未提供」——**不显示 0**：0 是"一个人都没报"，
 * null 是"后台没给这个字段"，两者在运营眼里是完全不同的事实。
 *
 * @param {object} item ScheduleItem
 * @returns {{quota: string, signed: string, full: boolean, status: string}}
 */
export function signupSummaryOf(item) {
  const it = item && typeof item === 'object' ? item : {};
  const quota = asCount(it.quota);
  const signed = it.signedCount === undefined ? null : asCountOrNull(it.signedCount);
  const full = quota > 0 && signed !== null && signed >= quota;
  return {
    quota: quotaLabelOf(it),
    signed: signed === null ? '已报人数未提供' : '已报 ' + signed + ' 人',
    full,
    status: it.status === 'closed' ? '报名已关闭' : it.status === 'open' ? '报名中' : (it.status || '状态未提供'),
  };
}

/**
 * 读已读水位表（`{ [companyId]: maxCreatedAt }`）。`localStorage` 不可用 / 内容坏掉 ⇒ `{}`。
 * @returns {object}
 */
export function readSeenMap() {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/**
 * 写已读水位（**企业隔离**，S10）。企业 id 缺失时**不写库**并返回 `false`。
 * @param {string} companyId
 * @param {string} createdAt 新的水位（本批最大 `createdAt`）
 * @returns {boolean} 是否写入
 */
export function writeSeen(companyId, createdAt) {
  const cid = asText(companyId);
  const mark = asText(createdAt);
  if (!cid || !mark) return false;
  try {
    const map = readSeenMap();
    const prev = asText(map[cid]);
    // 水位只升不降：既有的更大就保留（防止一次「读到的旧数据」把水位往回拉，制造重复红点）
    if (prev && prev >= mark) return false;
    map[cid] = mark;
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/**
 * 数「有未读新档期」的条数（S7 语义：**不是**活动总数、不是「没报名」）。
 *
 * 计数规则：`createdAt` 存在且 > 该企业水位。`createdAt` 缺失的档期**不计数**（不知道就不报）。
 *
 * @param {Array} items ScheduleItem[]
 * @param {string} companyId 当前企业
 * @returns {number}
 */
export function countUnreadSchedules(items, companyId) {
  const cid = asText(companyId);
  if (!cid) return 0;
  const seen = asText(readSeenMap()[cid]);
  return (Array.isArray(items) ? items : []).filter((x) => {
    if (!x) return false;
    // 【0.21.14 · AC-1.5 同源】已结束的档期不计数。
    //   否则运营补录一条历史档期（createdAt 很新、日期已过）会在栏目上挂一个
    //   **永远消不掉的红点** —— 用户点进去看不到任何"新安排"，只能怀疑坏了。
    //   红点的语义是「有新档期可看」，看得见的前提是它还没结束。
    if (x._state === 'ended') return false;
    const c = asText(x.createdAt);
    if (!c) return false;
    return seen ? c > seen : true;
  }).length;
}

/**
 * 把「本批档期」标记为已读（进入「活动与档期」后调用）：水位写成这批的最大 `createdAt`。
 * 写成功后派发 `douya:navdots-refresh`（S8：任何影响红点的写入后**必须**派发，App.jsx 是唯一监听者）。
 *
 * @param {string} companyId 当前企业
 * @param {Array} items 本次读到（并已展示）的档期
 * @returns {boolean} 是否真的写入了新水位
 */
export function markScheduleSeen(companyId, items) {
  const list = Array.isArray(items) ? items : [];
  let maxCreatedAt = '';
  for (const x of list) {
    const c = asText(x && x.createdAt);
    if (c && c > maxCreatedAt) maxCreatedAt = c;
  }
  if (!maxCreatedAt) return false;
  const wrote = writeSeen(companyId, maxCreatedAt);
  if (wrote) dispatchNavDotsRefresh();
  return wrote;
}

/**
 * 通知「红点该重算了」（S8）。组件之间不互相 import，只发 window 事件。
 * @param {string} [reason] 触发原因（仅调试用，不影响行为）
 */
export function dispatchNavDotsRefresh(reason) {
  try {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('douya:navdots-refresh', { detail: { reason: reason || '' } }));
  } catch {
    /* 非浏览器环境（单测）静默：红点刷新是增强，不是正确性前提 */
  }
}
