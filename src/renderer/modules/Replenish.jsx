/**
 * Replenish —— 「AI 补货」一级页面（0.21.14 · 需求 3；0.21.15 · 需求 9 改成表格 + 多商品批补）。
 *
 * 【这一页解决什么】
 *   老板原话（需求 3）：「新增一个AI补货功能 单独开一个功能 … 用户可以在里面选择几个自己固定要买的商品
 *   （可以上传表格 也可以通过搜索自己选），假如没货会告知目前没货是否推荐同品类商品 …
 *   有货后会在豆芽claw这一个栏目上面加一个数字红点 提示他看。以及一些平常商品（看中性价比）
 *   … 我不需要看品牌 我只比价格 … 用户可以设定一个值比如他要牙线，然后最高价格不超过10块，
 *   勾选优先选择折扣商品。这个页面还会显示上游货源的一些活动banner」。
 *
 *   老板原话（需求 9）：「AI补货 要支持多商品补货 页面做的跟表格一样」。
 *
 *   所以是**两条路线**（页签）+ **一条提醒**（侧栏红点，由 `App.jsx` 算，本页只负责清水位）：
 *     ┌ 常买清单 ── 固定要买的东西，逐件盯商城有没有货；没货就给同品类替代
 *     └ 性价比补货 ── 平常买的东西，只比价格 + 最高单价 + 优先打折
 *
 * 【需求 9 把「常买清单」从卡片流改成表格，为什么】
 *   改前：一行商品 = 一个 `div.rp-row`，横向铺「名字 / 标签 / 价格 / 库存 / 两个按钮」。
 *        信息是齐的，但**列不对齐** —— 十行商品的「价格」各自停在不同水平线上，
 *        老板要对着比价、对着核数量，眼睛得一行一行扫。而且当时只能**一条一条**加入补货单
 *        （`togglePick` 一次只动一件），十件商品要点二十下。
 *   改后：`antd Table`，行 = 商品、列 = 关键信息，列宽固定 ⇒ 上下列是齐的；
 *        勾选框 + 表头全选 + 「统一补货量」⇒ 十件商品两次点击搞定；
 *        表底合计（条数 / 件数 / 金额）⇒ 「这次要花多少钱」不用自己算。
 *
 *   ⚠️ 本仓此前**没有任何一处** `<table>` 或 antd `Table` 的补货类实现可抄
 *   （`grep -rn "<table\\|from 'antd'" src/renderer/modules` 只有竞品分析与新媒体两处
 *   用了 `Table`），所以视觉语言直接沿用 antd 默认 + 本页既有的 `rp-` 前缀配色，
 *   不自己发明格子线、不覆盖 antd 全局变量（见 `styles/replenish.css`）。
 *
 * 【为什么是分页，不是虚拟滚动】（需求 9 · B3）
 *   数据源是「诊所每月固定要买的耗材」，现实量级是**几十行**（CSV 上传一张月度采购表），
 *   不是几千行；`antd Table` 自带分页零新增依赖，而虚拟滚动（`react-window`）要求每行
 *   高度可测 —— jsdom 没有布局，一旦上虚拟滚动，这页的表格在 `test:ui` 里将**无法断言**
 *   （量到的高度恒 0 ⇒ 渲染 0 行）。所以选分页，`pageSize = 20`，且 `hideOnSinglePage`
 *   （不足一页时分页器根本不出现，不给首屏添按钮）。
 *
 * 【分工：判断全在 `services/replenishModel.js`，本文件只做渲染与取数】
 *   折扣率、可不可比价、常买清单与商品的匹配、到货判定、CSV 解析、排序、
 *   数量输入的三态解析、批量设数量、行模型、合计、并发队列 —— 全部是那边的纯函数。
 *   这一页不自己算一遍，否则门禁红的时候没人知道该改哪边（本仓踩过「两处各写一份口径」的坑）。
 *
 * 【取数：两条互不相干的路，别混】
 *   ① 商品 → 主进程 IPC `mmm:searchProducts`（`window.api.invoke`）。
 *      渲染层**不能**直连商城：上游不返回任何跨域头（OPTIONS 与 POST 都没有），浏览器会拦（AC-3.6b）。
 *      所以本文件里连那个商城的域名都不出现（判据就是「`src/renderer/` 里 0 命中」）。
 *   ② banner → `scheduleFeed.loadSchedules()`，走注入的 `geoProxy`（`opts.fetchImpl`）。
 *      `geoProxy` 从 props 解构、**真的当 fetchImpl 用**：探针会给 `{ geoProxy: off }`，
 *      只收下不接线的话，jsdom 里会去真打本机 `api/geo-proxy`（后端那条超时是 120 秒）。
 *
 * 【三种「没有商品」必须分开说】（S5 共享约定 + AC-3.23）
 *   `暂无数据`           —— 查到了，0 条；
 *   `当前没货`           —— 查到了，`hasStock === false`；
 *   `商城暂时查不到商品（稍后再试）` —— 没查到（协议变了 / 被风控 / 断网）。
 *   把第三种说成第一种，等于把故障说成「没有商品」，用户会一直等一个不存在的货。
 *
 * 【库存只给布尔，不给数量】（AC-3.12b）
 *   上游 `hasStock` 是布尔，没有件数。所以本页任何地方都不显示「还剩几件」，
 *   也不拿「销量」字段当库存暗示 —— 拿不到就说「暂无数据」，不估、不编。
 *
 * 【批量任务为什么挂在 `store/backgroundJobs.js` 上】（需求 9 · A2）
 *   批量查同品类是**用户点一下就等**的操作，10 件商品 × 每次一个来回，切到别的模块去看
 *   一眼再回来，组件已经卸载、`useState` 里的结果就没了 —— 用户会以为白跑了。
 *   `startJob(key, taskFn)` 把任务与结果放在模块级单例 + localStorage，`useBackgroundJob(key)`
 *   订阅；组件卸载不影响任务继续跑，切回来结果还在。**只调公开接口，不改那个文件**
 *   （同期另一位工程师在改它）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input, InputNumber, Table, Tabs } from 'antd';
import { geoProxy as defaultGeoProxy } from '../api.js';
import { useCompany } from '../store/companyStore.jsx';
import { startJob, useBackgroundJob } from '../store/backgroundJobs.js';
import { loadSchedules, pickReplenishBanner } from '../services/scheduleFeed.js';
import {
  CART_GROUPS,
  applyBulkQty,
  buildCartModel,
  buildPresetPick,
  buildReplenishRows,
  buildSubItem,
  diffStock,
  filterValueProducts,
  formatDiscountRate,
  mapWithConcurrency,
  markReplenishSeen,
  matchSubToProduct,
  normalizeProduct,
  parseQtyInput,
  parseSubsCsv,
  presetQtyOf,
  readStockSnapshot,
  readSubs,
  summarizeReplenishOrder,
  withPresetQty,
  writeStockSnapshot,
  writeSubs,
} from '../services/replenishModel.js';
import '../styles/replenish.css';

/** 单次检索条数：与主进程 `mmm:searchProducts` 的默认 `pageSize` 一致（上限 50）。 */
const SEARCH_PAGE_SIZE = 20;
/** 自动刷新窗口：进页面查一轮，60 秒内不再自动查（AC-3.21；手动「刷新库存」不受此限）。 */
const AUTO_REFRESH_WINDOW_MS = 60000;
/** 表格每页行数（需求 9 · B3：分页，理由见文件头注释）。 */
const TABLE_PAGE_SIZE = 20;
/**
 * 批量查同品类的并发上限。
 *
 * 为什么是 3 而不是 10：本仓既有注释记着「并发 10 个不会更快，只会更快被上游频控拦」，
 * 所以**库存**那条路径仍然是严格串行（见 `refreshStock`）。但用户手动发起的批量查询
 * 串行跑 10 件就是 10 个来回，体验不可接受。3 是折中：比串行快数倍，又留出频控余量。
 * 单件失败**不影响**其它件（`mapWithConcurrency` 的部分成功语义）。
 */
const ALT_CONCURRENCY = 3;
/** 后台任务键前缀：`replenish-alt-<companyId>`（按企业隔离，切企业不串结果）。 */
const ALT_JOB_PREFIX = 'replenish-alt-';

/** 空态：查到了但 0 条。**四个字**，不加句号、不加解释（S5 共享约定）。 */
const TEXT_EMPTY = '暂无数据';
/** 检索失败（协议变了 / 被风控）：这是**故障**，不是空态，不能说成「没有商品」。 */
const TEXT_SEARCH_FAIL = '商城暂时查不到商品，稍后再试';
/** 网络 / 超时：主进程已把异常归一化，这里同一句兜底（AC-3.24）。 */
const TEXT_NET_FAIL = '商城暂时没响应，稍后再试';

/**
 * 取商品：**唯一正确形态**。
 *
 * 调用的是主进程 IPC（`window.api.invoke('mmm:searchProducts', {keyword, pageSize})`），
 * 不是 `fetch`、不是 `window.douya.*`（preload 只暴露了通用的 `invoke`）。
 * 任何异常都折成 `{ok:false, error}`：这条通道断网 / 商城维护 / 登录过期都必须给界面一个
 * 可渲染的结果，绝不让 reject 冒到组件里变成白屏。
 *
 * @param {string} keyword 关键词（空串 ⇒ 直接返回，**不发请求**，AC-3.6）
 * @returns {Promise<{ok:boolean, items:Array, error:string, skipped?:boolean}>}
 */
async function invokeSearch(keyword) {
  const kw = String(keyword === null || keyword === undefined ? '' : keyword).trim();
  if (!kw) return { ok: false, items: [], error: '', skipped: true };
  const api = typeof window !== 'undefined' ? window.api : null;
  const invoke = api && typeof api.invoke === 'function' ? api.invoke : null;
  if (!invoke) {
    // 非 Electron 环境（jsdom 单测 / 探针没打桩）：当成「没查到」，不给空数组冒充「没有商品」
    return { ok: false, items: [], error: TEXT_NET_FAIL };
  }
  let raw;
  try {
    raw = await invoke('mmm:searchProducts', { keyword: kw, pageSize: SEARCH_PAGE_SIZE });
  } catch {
    return { ok: false, items: [], error: TEXT_NET_FAIL };
  }
  if (!raw || raw.ok !== true) {
    const msg = raw && (raw.error || raw.message);
    return { ok: false, items: [], error: String(msg || TEXT_NET_FAIL) };
  }
  const items = (Array.isArray(raw.products) ? raw.products : []).map(normalizeProduct).filter(Boolean);
  return { ok: true, items, error: '' };
}

/**
 * 从商品名里取「品类核心词」——「看看同品类」用它去检索（AC-3.13）。
 *
 * 规则是**纯字符级**的（不做语义相似，P1-3）：去掉带数字的片段（`50支/盒`、`10ml` 这类规格），
 * 再丢掉第一个词（商品名一般是「品牌 + 品类 + 规格」，品牌恰好在这个位置），剩下的当检索词。
 * 只剩一个词时不丢（「一次性手套」这种名字丢了就空了），最后截 12 字防止把整句塞进检索。
 *
 * 取不到就退回原名 —— 宁可多带一个品牌词，也不要拿空关键词去查（上游会返回空列表，
 * 用户看到的是「暂无数据」，而真相是「我们没查」）。
 *
 * @param {string} name 商品名
 * @returns {string} 检索用关键词
 */
export function coreKeywordOf(name) {
  const raw = String(name === null || name === undefined ? '' : name).trim();
  if (!raw) return '';
  const tokens = raw.split(/\s+/).filter(Boolean);
  const noSpec = tokens.filter((t) => !/\d/.test(t));
  const pool = noSpec.length ? noSpec : tokens;
  const core = (pool.length > 1 ? pool.slice(1) : pool).join(' ');
  const out = String(core || raw).slice(0, 12).trim();
  return out || raw;
}

/**
 * 库存状态的**唯一**文案出口（三分法：有货 / 当前没货 / 未知）。
 * @param {boolean|null} hasStock
 * @returns {string}
 */
function stockWord(hasStock) {
  if (hasStock === true) return '有货';
  if (hasStock === false) return '当前没货';
  return TEXT_EMPTY;
}

/**
 * 一行的价格文案（**永不出现件数**，AC-3.12b）。
 * @param {object|null} product 匹配到的商城商品
 * @param {object} sub 常买清单条目（可能带用户填的最高单价）
 * @returns {string}
 */
function priceText(product, sub) {
  const parts = [];
  const budget = sub && sub.maxPrice !== null && sub.maxPrice !== undefined ? Number(sub.maxPrice) : null;
  if (budget !== null && Number.isFinite(budget)) parts.push('想控制在 ¥' + budget);
  if (!product) return parts.concat(['没对上商城的货']).join(' · ');
  if (product.priceHidden === true || product.discountPrice === null || product.discountPrice === undefined) {
    return parts.concat(['价格待定']).join(' · ');
  }
  const cur = '现价 ¥' + product.discountPrice;
  const orig =
    product.price !== null && product.price !== undefined && Number(product.price) > Number(product.discountPrice)
      ? '（原价 ¥' + product.price + '）'
      : '';
  return parts.concat([cur + orig]).join(' · ');
}

/**
 * 金额展示：两位小数；`null` ⇒ `''`（由调用方决定写「—」还是「价格待定」）。
 * @param {number|null} n
 * @returns {string}
 */
function moneyText(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '';
  return Number(n).toFixed(2);
}

/**
 * AI 补货页。
 *
 * @param {object} props
 * @param {Function} [props.geoProxy] 取档期的注入点。生产由 `App.jsx` 传入它自己的
 *   `geoProxy`（与 `NewMediaWorkbench` 同一根测试缝）；未传时退回 `api.geoProxy`。
 *   探针传一个返回 `{ok:false}` 的空实现，避免在 jsdom 里真发本机请求（不传会挂 120s 超时）。
 * @returns {JSX.Element}
 */
export default function Replenish({ geoProxy }) {
  const { currentCompany } = useCompany();
  const cid = currentCompany && currentCompany.id ? String(currentCompany.id) : '';
  // 注入优先；没注入就用真实实现（生产路径）。两者都是稳定引用，不会把 effect 拖进重渲染循环。
  const fetchImpl = typeof geoProxy === 'function' ? geoProxy : defaultGeoProxy;

  const [tab, setTab] = useState('subs');

  /**
   * 当前在哪一页（老板要的「第一页选商品 → 第二页补货清单」）。
   *
   * 为什么用两个互斥的**页**而不是「在同一页里往下加一块」：
   *   改前「本次补货单」是塞在表格底部的一个区块，用户的路径是
   *   「勾一件 → 眼睛往下找一眼清单 → 再往上找下一件」，10 件商品要来回扫 20 次。
   *   老板说的是「第二页是补货的商品页面（类似于购物车）」——
   *   购物车的语义就是**独立的、可以停下来说"就这些"的一屏**。
   *
   * ⚠️ 页面切换**不卸载任何状态**：`selected` / `qtyDraft` / `oneOff` 全部挂在 `Replenish` 上，
   *   所以「从第二页回第一页」不会丢已选（老板原话「不要切一下就没有了」的同款要求）。
   */
  const [step, setStep] = useState('pick');

  // ── banner（上游货源活动，后台在 api.example.com 配置）──────────────────────────
  const [banner, setBanner] = useState(null);
  const [bannerReady, setBannerReady] = useState(false);

  // ── 常买清单（表格）──────────────────────────────────────────────────────
  const [subs, setSubs] = useState([]);
  const [sheetMsg, setSheetMsg] = useState('');
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState({ state: 'idle', items: [], error: '' });
  /** `{ [subKey]: ShopProduct }` —— 本轮对上的商城商品（快照只存布尔与时间，见模型注释） */
  const [stock, setStock] = useState({});
  const [stockState, setStockState] = useState('idle');
  const [stockMsg, setStockMsg] = useState('');
  /** `{ [subKey]: number }` —— 用户改过的「建议补货量」。**只存合法值**（`parseQtyInput` 放行的） */
  const [qtyDraft, setQtyDraft] = useState({});
  /** `{ [subKey]: string }` —— 该行数量输入的拒绝原因（非空即渲染红框 + 一句人话） */
  const [qtyErr, setQtyErr] = useState({});
  /** 已勾选（= 本次补货单里的**常买**商品键）。表格勾选框与行内「加入清单」共用这一份真源。 */
  const [selected, setSelected] = useState([]);
  /**
   * **一次性补货**的商品（不在常买清单里，只是这次顺手要买）。
   *
   * 老板要的分组依据就是它：`selected` 里的 → 常买组（置顶），这里的 → 一次性组（置后）。
   * 存的是归一化后的 `ShopProduct`，**不落 localStorage** —— 「一次性」的语义就是
   * 「这次买，下次不要」，存下来反而会变成第二个常买清单，和老板的心智模型冲突。
   */
  const [oneOff, setOneOff] = useState([]);
  /** 已展开「同品类」面板的行键 */
  const [altExpanded, setAltExpanded] = useState([]);
  /** `{ [subKey]: { state, items, error } }` —— 由后台任务结果回灌（见下方 effect） */
  const [altByKey, setAltByKey] = useState({});
  /** 正在查同品类的行键（`startJob` 期间没有 per-key 进度，自己记一份用于显示「正在找…」） */
  const [altPending, setAltPending] = useState([]);
  /** 「统一补货量」输入框的值（`null` = 用户清空） */
  const [bulkQty, setBulkQty] = useState(null);
  const [bulkMsg, setBulkMsg] = useState('');
  const [bulkErr, setBulkErr] = useState(false);

  // ── 性价比补货 ──────────────────────────────────────────────────────────
  const [valueKeyword, setValueKeyword] = useState('');
  const [maxPrice, setMaxPrice] = useState(null);
  const [preferDiscount, setPreferDiscount] = useState(false);
  const [valuePool, setValuePool] = useState([]);
  const [valueState, setValueState] = useState('idle');
  const [valueMsg, setValueMsg] = useState('');

  // 用 ref 持一份最新的清单：异步回调（上传表格、刷新库存、批量查同品类）拿到的是
  // **点击那一刻**的清单，而不是闭包里那份可能已经过期的快照。
  const subsRef = useRef(subs);
  useEffect(() => {
    subsRef.current = subs;
  }, [subs]);
  const lastAutoRefreshRef = useRef(0);

  // 批量查同品类的后台任务（按企业分键）。组件卸载后任务继续跑，切回来结果还在。
  const altJobKey = ALT_JOB_PREFIX + (cid || 'none');
  const altJob = useBackgroundJob(altJobKey);

  // ── banner 取数（只读档期，永久不写库）──────────────────────────────────
  useEffect(() => {
    let alive = true;
    loadSchedules({ fetchImpl })
      .then((res) => {
        if (!alive) return;
        setBanner(pickReplenishBanner(res && res.ok === true ? res.items : []));
        setBannerReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setBanner(null);
        setBannerReady(true);
      });
    return () => {
      alive = false;
    };
  }, [fetchImpl]);

  /**
   * 对当前清单查一轮库存。
   *
   * 逐件顺序查（不是并发）：主进程一次只接受一个关键词，且上游有频控；
   * 并发 10 个请求不会更快，只会更快被拦。**「批量」在这里不是指并发**——
   * 用户点一次「刷新库存」就已经把整张表全部查完，不用点十次（需求 9 · A2 的前半句）。
   * 真正需要并发的是用户手动发起的「批量查同品类」（见 `runAltBatch`），那里用 `ALT_CONCURRENCY`。
   *
   * 落库顺序有讲究：**先写快照 → 再推已读水位**。反过来的话，这一轮刚判出来的「到货」
   * 会因为水位已经是「现在」而被吞掉（用户正看着这一屏，红点不该再亮，但记录要留下）。
   *
   * @param {Array} [listArg] 要查的清单（缺省用 ref 里的最新清单）
   * @param {{force?:boolean}} [opts] `force` = 手动点「刷新库存」，不受 60 秒窗口限制
   */
  const refreshStock = useCallback(
    async (listArg, opts) => {
      const list = Array.isArray(listArg) ? listArg : subsRef.current;
      const force = !!(opts && opts.force === true);
      if (!list.length) {
        setStockState('idle');
        setStockMsg('');
        return;
      }
      const now = Date.now();
      if (!force && now - lastAutoRefreshRef.current < AUTO_REFRESH_WINDOW_MS) return;
      lastAutoRefreshRef.current = now;
      setStockState('loading');
      setStockMsg('');

      const found = {};
      const entries = [];
      let okCount = 0;
      let failMsg = '';
      for (const s of list) {
        // 顺序查是刻意的（见上方注释）：并发只会更快被上游频控拦掉
        const r = await invokeSearch(s.name);
        if (r.ok !== true) {
          failMsg = r.error || TEXT_SEARCH_FAIL;
          continue;
        }
        okCount += 1;
        const hit = r.items.length ? matchSubToProduct(s, r.items) : null;
        if (!hit) continue;
        found[s.key] = hit;
        entries.push({ key: s.key, hasStock: hit.hasStock });
      }
      setStock(found);

      if (!okCount) {
        // 一件都没查到 = 故障态，不是「都没货」。绝不能把 hasStock 全写成 false。
        setStockState('fail');
        setStockMsg(failMsg || TEXT_SEARCH_FAIL);
        return;
      }
      try {
        const prev = readStockSnapshot(cid);
        const diff = diffStock(prev, entries, now);
        writeStockSnapshot(cid, diff.next);
        markReplenishSeen(cid);
      } catch {
        // 存储不可用（隐私模式 / 配额满）不影响本屏读数：界面照常显示，只是红点不落库
      }
      setStockState('ok');
      setStockMsg(failMsg);
    },
    [cid],
  );

  // 进页面：读清单 → 有清单就查一轮（查不到就空态，不编数据）
  useEffect(() => {
    const list = readSubs(cid);
    subsRef.current = list;
    setSubs(list);
    setStock({});
    setSelected([]);
    setOneOff([]);
    setQtyDraft({});
    setQtyErr({});
    setAltByKey({});
    setAltExpanded([]);
    setAltPending([]);
    setBulkQty(null);
    setBulkMsg('');
    setBulkErr(false);
    setSearch({ state: 'idle', items: [], error: '' });
    // 切企业 ⇒ 回到第一页（第二页里是上一家企业的商品，留在那儿会让人以为新企业也要补这些）
    setStep('pick');
    if (list.length) refreshStock(list);
    else setStockState('idle');
  }, [cid, refreshStock]);

  /**
   * 后台任务结果 → 表格里的同品类面板。
   *
   * 只在 `result` **引用变化**时合并（`startJob` 结束才换对象），所以不会在每次
   * `emit()` 引起的重渲染里反复 setState（那会变成自激循环）。
   * 合并而不是替换：连查两批（先单行、再全选）时，前一批的结果不该消失。
   *
   * ⚠️ **这个 effect 必须排在上面那个「进页面就清空」的 effect 之后。**
   *   React 按声明顺序执行 effect：先声明「回灌」再声明「清空」，重挂载时就会
   *   「回灌 → 立刻被清空」，`altByKey` 恒为 `{}` —— 表现是**切回来以后同品类结果全丢**，
   *   而且没有任何报错（面板只是又变成「正在找同品类…」，看起来像"没查过"）。
   *   本条是被 `entry-interact` 的「批量结果跨挂载保留」用例抓出来的真 bug（按错误顺序排时
   *   实测：重挂载后点开已查成的行，仍会重新发一次检索）。**不要把这两块对调。**
   */
  useEffect(() => {
    const r = altJob && altJob.result && typeof altJob.result === 'object' ? altJob.result : null;
    if (!r || !r.byKey || typeof r.byKey !== 'object') return;
    setAltByKey((prev) => ({ ...prev, ...r.byKey }));
  }, [altJob.result]);

  /**
   * 搜索（AC-3.6 / AC-3.7）：关键词为空**不发请求**；结果每行可「加入常买」，
   * 同一个商品再加一次不会变两行（按 `key` 去重）。
   */
  const doSearch = useCallback(async () => {
    const kw = String(keyword === null || keyword === undefined ? '' : keyword).trim();
    if (!kw) {
      setSearch({ state: 'idle', items: [], error: '' });
      return;
    }
    setSearch({ state: 'loading', items: [], error: '' });
    const r = await invokeSearch(kw);
    if (r.ok !== true) {
      setSearch({ state: 'fail', items: [], error: r.error || TEXT_SEARCH_FAIL });
      return;
    }
    setSearch({ state: 'ok', items: r.items, error: '' });
  }, [keyword]);

  /** 把一个商品加进常买清单（按 `key` 去重；写库失败要说出来，不许装作存上了）。 */
  const addSub = useCallback(
    (product) => {
      if (!product) return;
      const item = buildSubItem({ name: product.name, spec: '', brand: '', maxPrice: null, qty: 1 });
      if (!item) return;
      const list = subsRef.current;
      if (list.some((x) => x.key === item.key)) {
        setSheetMsg('「' + item.name + '」已经在常买清单里了');
        return;
      }
      const next = list.concat([item]);
      subsRef.current = next;
      setSubs(next);
      const saved = writeSubs(cid, next);
      setSheetMsg(saved ? '已加入常买清单' : '这台电脑的浏览器存储不可用，本次只在本页有效');
    },
    [cid],
  );

  /** 上传常买清单表格（AC-3.9 ~ AC-3.11）：只收 `.csv`，扩展名先拦，再解析内容。 */
  const pickCsv = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.pickFiles !== 'function' || typeof api.readFileText !== 'function') {
      setSheetMsg('这台电脑打不开文件选择框，先按商品名搜一下也一样能加');
      return;
    }
    let paths = [];
    try {
      const r = await api.pickFiles();
      if (!r || r.canceled === true) return;
      paths = Array.isArray(r.filePaths) ? r.filePaths : [];
    } catch {
      setSheetMsg('文件选择框打开失败，请再试一次');
      return;
    }
    const file = String(paths[0] || '');
    if (!file) return;
    // ⚠️ 只收 .csv：主进程读文件是 `buf.toString('utf8')`，xlsx 是 ZIP 二进制，读出来是乱码
    if (!/\.csv$/i.test(file)) {
      setSheetMsg('请先把表格另存为 CSV 再上传');
      return;
    }
    let text = '';
    try {
      const r2 = await api.readFileText(file);
      if (!r2 || r2.ok !== true) {
        setSheetMsg((r2 && r2.error) || '这个文件读不出来');
        return;
      }
      text = String(r2.content || '');
    } catch {
      setSheetMsg('这个文件读不出来');
      return;
    }
    const parsed = parseSubsCsv(text);
    if (!parsed.ok) {
      setSheetMsg(parsed.error || '这份表格读不出来');
      return;
    }
    const list = subsRef.current.slice();
    const seen = new Set(list.map((x) => x.key));
    let added = 0;
    let skipped = Number(parsed.skipped) || 0;
    for (const it of parsed.items) {
      if (seen.has(it.key)) {
        skipped += 1;
        continue;
      }
      seen.add(it.key);
      list.push(it);
      added += 1;
    }
    subsRef.current = list;
    setSubs(list);
    const saved = writeSubs(cid, list);
    const tail = skipped ? '，跳过 ' + skipped + ' 行（空行或重复）' : '';
    setSheetMsg('从表格里加了 ' + added + ' 行' + tail + (saved ? '' : '（浏览器存储不可用，本次只在本页有效）'));
  }, [cid]);

  // ── 行模型（表格唯一的取数口径，全在 service 里算）───────────────────────
  const rows = useMemo(() => buildReplenishRows(subs, stock, qtyDraft), [subs, stock, qtyDraft]);

  /** `{ [subKey]: SubItem }` —— 「预设」那一列要拿清单条目本身（预设存在 `sub.qty` 里）。 */
  const subsByKey = useMemo(() => {
    const map = {};
    subs.forEach((s) => {
      map[String(s.key)] = s;
    });
    return map;
  }, [subs]);

  /**
   * 改一个常买商品的**预设数量**（老板的「设定好数量」，设一次以后每次都按它补）。
   *
   * 落库走既有的 `writeSubs`（同一个 key、同一套企业隔离），**不新开存储**：
   * 预设就是清单条目的 `qty`，CSV 那一列的字面名本来就是「每次补货数量」。
   *
   * 非法输入（空 / 0 / 非数字）**不写库、不改清单**，只把原因说一句 ——
   * 上一份合法值还在，界面不会跳成 0。判断在 `withPresetQty` 里，这里不重写一遍。
   */
  const savePreset = useCallback(
    (row, raw) => {
      if (!row) return;
      const r = withPresetQty(subsRef.current, row.key, raw === null || raw === undefined ? '' : raw);
      if (!r.ok) {
        setSheetMsg('预设数量：' + r.error);
        return;
      }
      if (!r.changed) {
        setSheetMsg('');
        return;
      }
      subsRef.current = r.next;
      setSubs(r.next);
      const saved = writeSubs(cid, r.next);
      setSheetMsg(
        saved
          ? '已把「' + row.name + '」的预设数量设为 ' + r.value + ' 件，以后「按预设一键补货」就按这个数'
          : '这台电脑的浏览器存储不可用，本次只在本页有效',
      );
    },
    [cid],
  );

  /** 把一个商城商品加进**一次性**补货清单（不进常买，买完就完）。同一件加两次只留一条。 */
  const addOneOff = useCallback((product) => {
    if (!product) return;
    const key = String(product.key === null || product.key === undefined ? '' : product.key);
    if (!key) return;
    setOneOff((prev) => (prev.some((p) => String(p.key) === key) ? prev : prev.concat([product])));
    setSheetMsg('已放进补货清单（一次性）：「' + product.name + '」');
  }, []);

  /**
   * **一键按预设补货**（老板那句「每次要补货的时候只要点一下就行了」）。
   *
   * 一次点击做三件事：挑中全部常买 → 套上各自预设数量 → 直接进第二页。
   * **不弹二次确认**：老板明确说过「设定好数量点击确定他自动就给你加好了」，
   * 再问一次就是把他抱怨的那个"两遍"换个地方重演。
   *
   * 空清单时说一句人话并留在第一页，不要把人送进一个空购物车。
   */
  const applyPresetAll = useCallback(() => {
    const r = buildPresetPick(subsRef.current);
    if (!r.count) {
      setSheetMsg('常买清单还是空的，先在第一页加几个商品');
      setStep('pick');
      return;
    }
    setSelected(r.keys);
    // 预设数量**覆盖**草稿：这是"按预设补"，不是"按上次改的补"
    setQtyDraft((prev) => ({ ...prev, ...r.qtyMap }));
    setQtyErr({});
    setBulkMsg('');
    setBulkErr(false);
    setStep('cart');
    setSheetMsg('已按预设把 ' + r.count + ' 件常买放进补货清单');
  }, []);

  /** 从补货清单里取出一条（常买 ⇒ 取消勾选；一次性 ⇒ 直接移出）。 */
  const removeFromCart = useCallback((row) => {
    if (!row) return;
    const key = String(row.key);
    if (row.isOneOff === true) {
      setOneOff((prev) => prev.filter((p) => String(p.key) !== key));
    } else {
      setSelected((prev) => prev.filter((k) => k !== key));
    }
    // 数量草稿一起清掉：否则下次再加进来会带着上一次改过的数量，用户以为预设变了
    setQtyDraft((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setQtyErr((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /** 清空整张补货清单（常买勾选 + 一次性）。 */
  const clearCart = useCallback(() => {
    setSelected([]);
    setOneOff([]);
    setQtyDraft({});
    setQtyErr({});
  }, []);

  /** 单行改数量：非法输入**不写入**（上一份合法值还在），只把原因记到该行。 */
  const setRowQty = useCallback((row, raw) => {
    if (!row) return;
    const key = String(row.key);
    const parsed = parseQtyInput(raw);
    if (!parsed.ok) {
      setQtyErr((prev) => ({ ...prev, [key]: parsed.error }));
      return;
    }
    setQtyErr((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setQtyDraft((prev) => ({ ...prev, [key]: parsed.value }));
  }, []);

  /** 勾选 / 取消勾选一行（表格勾选框与行内「加入清单」按钮共用）。 */
  const togglePick = useCallback((row) => {
    if (!row) return;
    const key = String(row.key);
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : prev.concat([key])));
  }, []);

  /**
   * 批量查同品类（需求 9 · A2）：勾选 N 件 → 一次点击 → 并发 `ALT_CONCURRENCY` 路跑完。
   *
   * 落点是 `startJob`（后台任务），所以**切页签 / 切模块都不丢**。
   * 部分成功：`byKey` 里每件各自是 `ok` / `fail`，一件失败不影响其它件的结果落地。
   *
   * 注意 `finally` 式的清理：`altPending` 在这批跑完后一定要摘掉，否则那一行会永远
   * 显示「正在找同品类…」——这是最容易被漏掉、且只出现在失败路径上的状态残留。
   *
   * @param {Array<string>} keys 要查的行键
   */
  const runAltBatch = useCallback(
    async (keys) => {
      const list = (Array.isArray(keys) ? keys : [])
        .map((k) => String(k === null || k === undefined ? '' : k))
        .filter(Boolean);
      if (!list.length) {
        setBulkErr(true);
        setBulkMsg('先勾选要查的商品');
        return;
      }
      if (altJob && altJob.busy === true) {
        setBulkErr(false);
        setBulkMsg('上一批还在查，等它跑完');
        return;
      }
      const nameMap = {};
      subsRef.current.forEach((s) => {
        nameMap[String(s.key)] = String(s.name);
      });
      setAltPending((prev) => Array.from(new Set(prev.concat(list))));
      // 批量查完要让用户**看得到**结果：把这一批的行一起展开。
      // 只落 `byKey` 不展开的话，界面唯一的变化就是工具条上的一句话，用户会以为没查。
      setAltExpanded((prev) => Array.from(new Set(prev.concat(list))));
      setBulkErr(false);
      setBulkMsg('正在查 ' + list.length + ' 件的同品类…');

      let res = null;
      try {
        res = await startJob(altJobKey, async () => {
          const run = await mapWithConcurrency(list, ALT_CONCURRENCY, async (key) => {
            const r = await invokeSearch(coreKeywordOf(nameMap[key] || ''));
            return { key, r };
          });
          const byKey = {};
          let okCount = 0;
          let failCount = 0;
          let firstErr = '';
          run.results.forEach((cell, i) => {
            const key = list[i];
            const value = cell && cell.ok === true ? cell.value : null;
            const r = value ? value.r : null;
            if (r && r.ok === true) {
              byKey[key] = { state: 'ok', items: r.items.filter((p) => p.hasStock === true), error: '' };
              okCount += 1;
              return;
            }
            const msg = (r && r.error) || (cell && cell.error) || TEXT_SEARCH_FAIL;
            if (!firstErr) firstErr = msg;
            byKey[key] = { state: 'fail', items: [], error: msg };
            failCount += 1;
          });
          return {
            // 只要有一件查成就算「成功」（其余件各自带 fail 标注）——全失败才整体报错
            ok: okCount > 0,
            error: okCount > 0 ? '' : firstErr || TEXT_SEARCH_FAIL,
            result: { at: Date.now(), byKey, okCount, failCount, keys: list },
            note: '查完 ' + list.length + ' 件：成功 ' + okCount + ' / 失败 ' + failCount,
          };
        });
      } finally {
        // 无论成功、失败、抛错，都要把「正在找…」摘掉
        setAltPending((prev) => prev.filter((k) => !list.includes(k)));
      }

      const done = res && res.result && typeof res.result === 'object' ? res.result : null;
      if (!done) {
        setBulkErr(true);
        setBulkMsg('这一批没查成，稍后再试');
        return;
      }
      const okCount = Number(done.okCount) || 0;
      const failCount = Number(done.failCount) || 0;
      const tail = failCount ? '，' + failCount + ' 件没查成' : '';
      setBulkErr(failCount > 0 && okCount === 0);
      setBulkMsg('查完 ' + list.length + ' 件：' + okCount + ' 件出了结果' + tail);
    },
    [altJob, altJobKey],
  );

  /** 「看看同品类」（AC-3.13）：展开该行并（若还没查过）发起一次单件查询。 */
  const showAlt = useCallback(
    (row) => {
      if (!row) return;
      const key = String(row.key);
      setAltExpanded((prev) => (prev.includes(key) ? prev : prev.concat([key])));
      const known = altByKey[key];
      if (known && known.state === 'ok') return;
      if (altPending.includes(key)) return;
      runAltBatch([key]);
    },
    [altByKey, altPending, runAltBatch],
  );

  /** 「批量设数量」：把勾选的每一行都设成同一个值（全改或全不改，见 `applyBulkQty`）。 */
  const applyBulkToSelected = useCallback(() => {
    const r = applyBulkQty(selected, bulkQty, qtyDraft);
    if (!r.ok) {
      setBulkErr(true);
      setBulkMsg(r.error);
      return;
    }
    setQtyDraft(r.next);
    setQtyErr({});
    setBulkErr(false);
    const value = r.next[r.keys[0]];
    setBulkMsg('已把 ' + r.changed + ' 件的补货量设成 ' + value + ' 件');
  }, [selected, bulkQty, qtyDraft]);

  /** 性价比路线检索（AC-3.16）：同样走主进程通路，关键词为空不发请求。 */
  const runValue = useCallback(async () => {
    const kw = String(valueKeyword === null || valueKeyword === undefined ? '' : valueKeyword).trim();
    if (!kw) {
      setValuePool([]);
      setValueState('idle');
      setValueMsg('');
      return;
    }
    setValueState('loading');
    setValueMsg('');
    const r = await invokeSearch(kw);
    if (r.ok !== true) {
      setValuePool([]);
      setValueState('fail');
      setValueMsg(r.error || TEXT_SEARCH_FAIL);
      return;
    }
    setValuePool(r.items);
    setValueState('ok');
  }, [valueKeyword]);

  // 预算与「优先打折」都在**渲染时**过滤，改了输入立刻见效，不用再点一次检索
  const valueShown = useMemo(
    () => filterValueProducts(valuePool, { maxPrice, preferDiscount }),
    [valuePool, maxPrice, preferDiscount],
  );

  // ── 第二页：补货清单（分组 + 行模型 + 合计，全由 service 算）──────────────
  //
  // `buildCartModel` 是**唯一**决定「常买在前、一次性在后」的地方。
  // 这里不再自己 filter / concat 一遍：分组顺序如果在这一层也写一份，
  // 就成了两份实现，改一处必然漏一处（本仓踩过的老坑）。
  const cart = useMemo(
    () => buildCartModel(selected, subs, stock, qtyDraft, oneOff),
    [selected, subs, stock, qtyDraft, oneOff],
  );
  const tableSum = useMemo(
    () => summarizeReplenishOrder(rows.map((r) => ({ key: r.key, need: r.need, price: r.price }))),
    [rows],
  );
  /**
   * **只算已勾选那几行**的合计（表底「已勾选 N 条 / M 件 / ¥X」）。
   *
   * 为什么不能直接拿 `cart.summary` 顶替：第一页的勾选与第二页的清单**不是同一个集合**
   * —— 第二页还含一次性商品，且第一页允许"勾了但还没看第二页"。
   * 两个数必须各算各的，否则「已勾选 3 条」旁边会印着 13 条的金额。
   */
  const orderSum = useMemo(() => {
    const pickSet = new Set(selected.map((k) => String(k)));
    return summarizeReplenishOrder(
      rows.filter((r) => pickSet.has(String(r.key))).map((r) => ({ key: r.key, need: r.need, price: r.price })),
    );
  }, [rows, selected]);

  /**
   * 「看看同品类」的面板（挂在被展开的那一行下面）。
   * 面板内的按钮属于**第二级列表**，不算这一行的两个操作位（AC-3.25b 第 3 条）。
   */
  const renderAltPanel = useCallback(
    (row) => {
      const key = String(row.key);
      const a = altByKey[key] || { state: 'idle', items: [], error: '' };
      const loading = a.state === 'loading' || a.state === 'idle' || altPending.includes(key);
      return (
        <div className="rp-alt" data-rp-alt-panel={key}>
          {loading ? <span className="rp-muted">正在找同品类…</span> : null}
          {a.state === 'fail' ? <span className="rp-fail">{a.error || TEXT_SEARCH_FAIL}</span> : null}
          {a.state === 'ok' && a.items.length === 0 ? <span className="rp-muted">{TEXT_EMPTY}</span> : null}
          {a.state === 'ok'
            ? a.items.map((p) => (
                <div className="rp-alt-row" key={p.key}>
                  <span className="rp-name">{p.name}</span>
                  <span className="rp-price">{p.discountPrice === null ? '价格待定' : '现价 ¥' + p.discountPrice}</span>
                  <Button size="small" data-rp-once-alt={p.key} onClick={() => addOneOff(p)}>
                    加入清单
                  </Button>
                  <Button size="small" data-rp-add-alt={p.productId || p.key} onClick={() => addSub(p)}>
                    也加进常买
                  </Button>
                </div>
              ))
            : null}
        </div>
      );
    },
    [addOneOff, addSub, altByKey, altPending],
  );

  // ── 表格列（行 = 商品，列 = 关键信息）─────────────────────────────────────
  const columns = useMemo(
    () => [
      {
        title: '商品名',
        dataIndex: 'name',
        key: 'name',
        width: 240,
        render: (_v, row) => (
          <span className="rp-cell-name">
            <span className="rp-name" title={row.name}>
              {row.name}
            </span>
            {row.brand ? <span className="rp-tag">{row.brand}</span> : null}
          </span>
        ),
      },
      {
        title: '规格',
        dataIndex: 'spec',
        key: 'spec',
        width: 120,
        render: (v) => (v ? <span className="rp-tag">{v}</span> : <span className="rp-muted">—</span>),
      },
      {
        title: '当前库存',
        key: 'stock',
        width: 110,
        render: (_v, row) =>
          row.hasStock === false ? (
            <span className="rp-oos" data-rp-oos="1">
              当前没货
            </span>
          ) : (
            <span className="rp-stock">{stockWord(row.hasStock)}</span>
          ),
      },
      {
        title: '建议补货量',
        key: 'need',
        width: 150,
        render: (_v, row) => (
          <span className="rp-cell-qty">
            <InputNumber
              size="small"
              precision={0}
              className="rp-qty"
              data-rp-qty={row.key}
              value={row.need}
              status={qtyErr[row.key] ? 'error' : undefined}
              onChange={(v) => setRowQty(row, v)}
            />
            {qtyErr[row.key] ? (
              <span className="rp-qty-err" data-rp-qty-err={row.key}>
                {qtyErr[row.key]}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        // 老板原话「既然是常买的东西为什么要加入清单 不应该是设定好数量点击确定他自动就给你加好了吗」
        // ⇒ 常买商品要有自己的**预设数量**：设一次，以后「按预设一键补货」直接按它补。
        // ⚠️ 这里写的是 `data-rp-preset`（**不是** `data-rp-qty`）：
        //   前者是"存下来、下次还用"的预设，后者是"这一次补多少"的临时值。
        //   两者混用会让「改预设」悄悄改掉「这一次」，用户无法只调一次而不动长期配置。
        title: '预设',
        key: 'preset',
        width: 110,
        render: (_v, row) => {
          const sub = subsByKey[row.key];
          return (
            <span className="rp-cell-qty">
              <InputNumber
                size="small"
                precision={0}
                className="rp-preset"
                data-rp-preset={row.key}
                value={sub ? presetQtyOf(sub) : 1}
                onChange={(v) => savePreset(row, v)}
              />
            </span>
          );
        },
      },
      {
        title: '单价',
        key: 'price',
        width: 110,
        render: (_v, row) =>
          row.price === null ? (
            <span className="rp-muted">价格待定</span>
          ) : (
            <span className="rp-price" data-rp-price={row.key}>
              ¥{row.price}
            </span>
          ),
      },
      {
        title: '小计',
        key: 'amount',
        width: 110,
        render: (_v, row) =>
          row.amount === null ? (
            <span className="rp-muted">—</span>
          ) : (
            <span className="rp-price" data-rp-amount={row.key}>
              ¥{moneyText(row.amount)}
            </span>
          ),
      },
      {
        title: '操作',
        key: 'op',
        width: 190,
        render: (_v, row) => (
          <span className="rp-row-act">
            {/* 每行最多 2 个操作（1 主 1 次）：行内按钮多起来就是按钮墙（AC-3.25b） */}
            {row.hasStock === false ? (
              <Button size="small" data-rp-alt={row.key} onClick={() => showAlt(row)}>
                看看同品类
              </Button>
            ) : null}
            <Button
              size="small"
              type={selected.includes(row.key) ? 'default' : 'primary'}
              data-rp-pick={row.key}
              onClick={() => togglePick(row)}
            >
              {selected.includes(row.key) ? '取出' : '加入清单'}
            </Button>
          </span>
        ),
      },
    ],
    [qtyErr, savePreset, selected, setRowQty, showAlt, subsByKey, togglePick],
  );

  const rowSelection = useMemo(
    () => ({
      selectedRowKeys: selected,
      // 翻页后已勾选的行不该被丢掉（分页 + 全选是这套批量补货的主路径）
      preserveSelectedRowKeys: true,
      columnWidth: 40,
      onChange: (keys) => setSelected((Array.isArray(keys) ? keys : []).map((k) => String(k))),
    }),
    [selected],
  );

  const expandable = useMemo(
    () => ({
      // `showExpandColumn: false` ⇒ 不注入展开图标列。
      // 为什么必须关掉：展开图标每行都是一个 `<button>`，加上「看看同品类」+「加入清单」
      // 就是每行 3 个按钮 —— 直接违反 AC-3.25b「每行 ≤ 2 个操作」。
      // 展开动作改由「看看同品类」按钮驱动（`expandedRowKeys` 受控）。
      showExpandColumn: false,
      expandedRowKeys: altExpanded,
      onExpandedRowsChange: (keys) => setAltExpanded((Array.isArray(keys) ? keys : []).map((k) => String(k))),
      expandedRowRender: (row) => renderAltPanel(row),
    }),
    [altExpanded, renderAltPanel],
  );

  const pagination = useMemo(
    () => ({
      pageSize: TABLE_PAGE_SIZE,
      hideOnSinglePage: true,
      showSizeChanger: false,
      size: 'small',
      showTotal: (total) => '共 ' + total + ' 条',
    }),
    [],
  );

  /** 表格底部合计（条数 + 件数 + 金额 + 已勾选）。老板要的「底部要有合计」。 */
  const tableFooter = useCallback(
    () => (
      <div className="rp-sum" data-rp-sum="1">
        <span
          data-rp-sum-count={tableSum.count}
          data-rp-sum-qty={tableSum.totalQty}
          data-rp-sum-amount={moneyText(tableSum.totalAmount)}
        >
          合计：共 {tableSum.count} 条（{tableSum.totalQty} 件），按现价约 ¥{moneyText(tableSum.totalAmount)}
          {tableSum.unpriced > 0 ? '（另有 ' + tableSum.unpriced + ' 条价格待定，未计入金额）' : ''}
        </span>
        {/*
          「已勾选」与上面的「合计」是**两个不同的数**（勾选是子集）。
          `data-rp-sum-picked / -pick-qty / -pick-amount` 三个锚点专供断言用：
          有人若把 `orderSum` 直接改成 `tableSum`（省事但错），
          「一件不勾」时这里会显示 10 条而不是 0 条 ⇒ 断言当场红。
        */}
        <span
          className="rp-sum-pick"
          data-rp-sum-picked={orderSum.count}
          data-rp-pick-qty={orderSum.totalQty}
          data-rp-pick-amount={moneyText(orderSum.totalAmount)}
        >
          已勾选 {orderSum.count} 条 / {orderSum.totalQty} 件 / ¥{moneyText(orderSum.totalAmount)}
        </span>
      </div>
    ),
    [orderSum.count, orderSum.totalQty, orderSum.totalAmount, tableSum.count, tableSum.totalQty, tableSum.totalAmount, tableSum.unpriced],
  );

  // ── 批量工具条（只在有清单时渲染：空态一个按钮都不许多，首屏按钮数要稳定在 4）──
  const bulkBar =
    subs.length > 0 ? (
      <div className="rp-bulk" data-rp-bulk="1">
        <span className="rp-bulk-lb">统一补货量</span>
        <InputNumber
          size="small"
          precision={0}
          className="rp-bulk-qty"
          data-rp-bulk-qty="1"
          value={bulkQty}
          status={bulkErr ? 'error' : undefined}
          placeholder="比如 2"
          onChange={(v) => {
            // 这里只把 antd 的「清空」落成 `null`，**不判合法性** ——
            // 「0 / 负数 / 非数字该怎么拒」是业务口径，只许存在 `parseQtyInput` 一处。
            setBulkQty(v === null || v === undefined ? null : Number(v));
            setBulkErr(false);
            setBulkMsg('');
          }}
        />
        <Button size="small" data-rp-bulk-apply="1" onClick={applyBulkToSelected}>
          批量设数量
        </Button>
        <Button size="small" data-rp-bulk-alt="1" loading={altJob && altJob.busy === true} onClick={() => runAltBatch(selected)}>
          批量查同品类
        </Button>
        <span className="rp-muted" data-rp-selected-count={selected.length}>
          已勾选 {selected.length} 件
        </span>
        {bulkMsg ? (
          <span className={bulkErr ? 'rp-fail-inline' : 'rp-msg-inline'} data-rp-bulk-msg="1">
            {bulkMsg}
          </span>
        ) : null}
      </div>
    ) : null;

  // ── 第二页：补货清单（购物车）─────────────────────────────────────────
  //
  // 分组渲染的**顺序由 `CART_GROUPS` 决定**，不在这里手写两块 JSX 的先后：
  // 老板说的是「常买的始终置顶，一次性补货的排在常卖下面」——这是一条语义，
  // 只能有一个真源，否则改一处漏一处。
  //
  // 两块**始终都渲染**（哪怕某组是空的），理由：
  //   ① 空组也告诉用户「这类现在还没有」，比整块消失更容易理解；
  //   ② 分组顺序因此是**DOM 事实**（`[data-rp-cart-group]` 的先后恒定），
  //      断言可以直接量，不会因为"这次恰好没有一次性"而变成空过。
  const renderCartGroup = (group, title, hint, groupRows) => (
    <div className="rp-cart-group" data-rp-cart-group={group} data-rp-cart-group-count={groupRows.length}>
      <div className="rp-cart-group-hd">
        <span className="rp-cart-group-t">{title}</span>
        <span className="rp-muted">{hint}</span>
        <span className="rp-tag">{groupRows.length} 条</span>
      </div>
      {groupRows.length === 0 ? (
        <div className="rp-muted" data-rp-cart-group-empty={group}>
          {group === CART_GROUPS[0] ? '这次还没挑常买的。点上面的「按预设一键补货」，或回第一页勾几个。' : '这次没有临时加的东西。'}
        </div>
      ) : (
        groupRows.map((row) => (
          <div className="rp-cart-row" key={row.key} data-rp-cart-row={row.key} data-rp-cart-row-group={row.group}>
            <span className="rp-name" title={row.name}>
              {row.name}
            </span>
            {row.isOneOff ? (
              <span className="rp-tag">一次性</span>
            ) : (
              // 预设是"存下来、下次还用"的那个数；右边的输入框是"这一次补多少"
              <span className="rp-tag" data-rp-cart-preset={row.key}>
                预设 {row.preset}
              </span>
            )}
            <span className="rp-cell-qty">
              <span className="rp-muted">这次</span>
              <InputNumber
                size="small"
                precision={0}
                className="rp-qty"
                data-rp-cart-qty={row.key}
                value={row.need}
                status={qtyErr[row.key] ? 'error' : undefined}
                onChange={(v) => setRowQty(row, v)}
              />
              {qtyErr[row.key] ? (
                <span className="rp-qty-err" data-rp-cart-qty-err={row.key}>
                  {qtyErr[row.key]}
                </span>
              ) : null}
            </span>
            <span className="rp-price" data-rp-cart-price={row.key}>
              {row.price === null ? '价格待定' : '¥' + row.price}
            </span>
            <span className="rp-price" data-rp-cart-amount={row.key}>
              {row.amount === null ? '—' : '¥' + moneyText(row.amount)}
            </span>
            <Button size="small" data-rp-cart-remove={row.key} onClick={() => removeFromCart(row)}>
              取出
            </Button>
          </div>
        ))
      )}
    </div>
  );

  const cartPane = (
    <div className="rp-pane rp-cart" data-rp-pane="cart" data-rp-cart="1">
      <div className="rp-bar">
        <Button size="small" data-rp-cart-back="1" onClick={() => setStep('pick')}>
          ← 回第一页选商品
        </Button>
        <span className="rp-muted" data-rp-cart-count={cart.counts.total}>
          共 {cart.counts.total} 条（常买 {cart.counts.recurring} / 一次性 {cart.counts.oneoff}）
        </span>
      </div>

      {cart.counts.total === 0 ? (
        <div className="rp-empty" data-rp-cart-empty="1">
          补货清单还是空的 —— 回第一页勾几个，或者点上面的「按预设一键补货」。
        </div>
      ) : null}

      {renderCartGroup(
        CART_GROUPS[0],
        '常买 · 每次点一下就好',
        '按预设数量自动补，不用一件件加',
        cart.recurring,
      )}
      {renderCartGroup(CART_GROUPS[1], '一次性补货 · 这次临时加的', '买完就完，不会进常买', cart.oneoff)}

      {cart.counts.total > 0 ? (
        <div className="rp-cart-sum" data-rp-cart-sum="1">
          <span
            data-rp-cart-sum-count={cart.counts.total}
            data-rp-cart-sum-qty={cart.summary.totalQty}
            data-rp-cart-sum-amount={moneyText(cart.summary.totalAmount)}
          >
            合计：{cart.counts.total} 条（{cart.summary.totalQty} 件），按现价约 ¥{moneyText(cart.summary.totalAmount)}
            {cart.summary.unpriced > 0 ? '（另有 ' + cart.summary.unpriced + ' 条价格待定，未计入金额）' : ''}
          </span>
          <Button size="small" data-rp-cart-clear="1" onClick={clearCart}>
            清空清单
          </Button>
        </div>
      ) : null}
    </div>
  );

  // ── banner 块（无进行中档期 / 没配图 ⇒ 写「暂无数据」，不占位造图）──────────
  const bannerBlock = (
    <div className="rp-banner" data-rp-banner>
      {banner && banner.bannerSrc ? (
        <>
          <img className="rp-banner-img" src={banner.bannerSrc} alt="上游货源活动图" />
          <div className="rp-banner-txt">
            <span className="rp-banner-t">{banner.title || TEXT_EMPTY}</span>
            <span className="rp-banner-d">
              {banner.startDate} ~ {banner.endDate}
            </span>
          </div>
        </>
      ) : (
        <div className="rp-banner-txt">
          <span className="rp-banner-t">上游货源活动</span>
          <span className="rp-banner-d">{bannerReady ? TEXT_EMPTY : '正在看活动…'}</span>
        </div>
      )}
    </div>
  );

  // ── 页签 1：常买清单（表格）─────────────────────────────────────────────
  const subsPane = (
    <div className="rp-pane" data-rp-pane="subs">
      <div className="rp-bar">
        <Input
          className="rp-kw"
          data-rp-search="1"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={doSearch}
          placeholder="搜商品名，比如 牙线、一次性手套"
        />
        <Button data-rp-search-go="1" type="primary" loading={search.state === 'loading'} onClick={doSearch}>
          搜一下
        </Button>
        <Button data-rp-upload="1" onClick={pickCsv}>
          上传表格
        </Button>
        <Button
          data-rp-refresh="1"
          loading={stockState === 'loading'}
          onClick={() => refreshStock(subsRef.current, { force: true })}
        >
          刷新库存
        </Button>
      </div>

      <div className="rp-guide" data-rp-guide="1">
        <span>
          <b>两页</b>：① 这一页挑商品 → ② 下一屏看补货清单（常买在上、一次性在下，带单价和合计）。
        </span>
        <span>
          <b>常买的怎么补</b>：在「预设」那一列设好每次要几件 —— 以后点一下步骤条上的
          「按预设一键补货」，全部按预设数量直接进清单，不用一件件加。
        </span>
        <span>
          <b>怎么加商品</b>：搜商品名 → 「加入常买」长期盯着，「加入清单」只买这次。
          <br />
          CSV 列名：商品名称 / 规格 / 品牌 / 最高单价 / 数量（即预设数量）。
        </span>
        <span>
          <b>去哪看</b>：清单里哪件到货了，左边「AI 补货」会冒出数字，点进来就是这一页。
        </span>
      </div>

      {sheetMsg ? (
        <div className="rp-msg" data-rp-sheet-msg="1">
          {sheetMsg}
        </div>
      ) : null}

      {/*
        还没搜过的时候要说清楚「这一页怎么用」，而且**必须诚实**：
        商城接口要关键词才返回商品（空关键词实测 `products: []`、`totalCount: 0`），
        所以第一页**不是**一个"全店商品网格"。写成"全部商品"就是骗人 ——
        用户会一直往下滚，以为还有货没加载出来。
      */}
      {search.state === 'idle' ? (
        <div className="rp-muted" data-rp-search-hint="1">
          加新商品：在上面输入名字搜一下（商城只支持按名字搜，没有「全部商品」列表）；
          已经在常买里的，直接从下面的清单勾选就行。
        </div>
      ) : null}

      {search.state === 'fail' ? (
        <div className="rp-fail" data-rp-search-fail="1">
          {search.error || TEXT_SEARCH_FAIL}
        </div>
      ) : null}
      {search.state === 'ok' && search.items.length === 0 ? (
        <div className="rp-empty" data-rp-search-empty="1">
          {TEXT_EMPTY}
        </div>
      ) : null}
      {search.state === 'ok' && search.items.length > 0 ? (
        <div className="rp-block" data-rp-results="1">
          <div className="rp-block-hd">搜到的商品 · {search.items.length} 件</div>
          {search.items.map((p) => (
            <div className="rp-srow" key={p.key} data-rp-result={p.key}>
              <span className="rp-name">{p.name}</span>
              <span className="rp-price">{priceText(p, null)}</span>
              <span className="rp-stock">{stockWord(p.hasStock)}</span>
              {/* 两个出口，对应两种意图：
                  「加入清单」= 这次买（一次性组，不落库）；「加入常买」= 以后一直盯着（进目录） */}
              <Button size="small" data-rp-once={p.key} onClick={() => addOneOff(p)}>
                加入清单
              </Button>
              <Button size="small" data-rp-add={p.productId || p.key} onClick={() => addSub(p)}>
                加入常买
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {subs.length === 0 ? (
        <div className="rp-empty" data-rp-empty="1">
          {TEXT_EMPTY}
        </div>
      ) : (
        <div className="rp-block rp-table-block" data-rp-list="1">
          <div className="rp-block-hd">
            常买清单 · {subs.length} 件
            {stockState === 'loading' ? ' · 正在对商城库存…' : ''}
          </div>
          {stockState === 'fail' ? (
            <div className="rp-fail" data-rp-stock-fail="1">
              {stockMsg || TEXT_SEARCH_FAIL}
            </div>
          ) : null}
          {stockState === 'ok' && stockMsg ? (
            <div className="rp-msg" data-rp-stock-partial="1">
              {stockMsg}
            </div>
          ) : null}

          {bulkBar}

          {/* 表格容器：`scroll={{x}}` 让窄屏横向滚动而不是把每列挤成一个字（需求 9 · B4） */}
          <div className="rp-table" data-rp-table="1">
            <Table
              size="small"
              rowKey="key"
              columns={columns}
              dataSource={rows}
              rowSelection={rowSelection}
              expandable={expandable}
              pagination={pagination}
              scroll={{ x: 1140 }}
              footer={tableFooter}
              locale={{ emptyText: TEXT_EMPTY }}
              onRow={(row) => ({
                'data-rp-row': row.key,
                className: row.hasStock === false ? 'rp-row-oos' : '',
              })}
            />
          </div>
        </div>
      )}
    </div>
  );

  // ── 页签 2：性价比补货 ─────────────────────────────────────────────────
  const valuePane = (
    <div className="rp-pane" data-rp-pane="value">
      <div className="rp-bar">
        <Input
          className="rp-kw"
          data-rp-value-keyword="1"
          value={valueKeyword}
          onChange={(e) => setValueKeyword(e.target.value)}
          onPressEnter={runValue}
          placeholder="要买什么，比如 一次性手套"
        />
        <InputNumber
          data-rp-maxprice="1"
          min={0}
          value={maxPrice}
          onChange={(v) => {
            // 这里只做一件事：把 antd 的「清空」（`null`）落成 `null`，其余**原样透传**。
            // ⚠️ 故意**不在这里**判 `> 0`：`0` / 负数该不该算「没设上限」是**业务口径**，
            //   口径只许存在一处 —— `replenishModel.sortValueProducts` 里那行归一。
            //   两处各写一遍就是「改口径只改一处」的老坑：哪天口径变了（比如 `0` 改成
            //   「只看 0 元商品」），UI 这层会先把它吃成 `null`，而 service 改对了也没用。
            //   UI 的职责是**传值**，不是**解释值**。
            setMaxPrice(v === null || v === undefined ? null : Number(v));
          }}
          placeholder="最高单价"
          addonBefore="≤ ¥"
        />
        <Checkbox
          data-rp-prefer-discount="1"
          checked={preferDiscount}
          onChange={(e) => setPreferDiscount(e.target.checked === true)}
        >
          优先选打折的
        </Checkbox>
      </div>

      <div className="rp-guide" data-rp-value-guide="1">
        <span>只比价格，不看品牌；设一个最高单价，超过的都剔掉。</span>
        <span>勾上「优先选打折的」，折扣大的排在前面（折扣率按原价与现价自己算，不信商城标的「是不是打折」）。</span>
      </div>

      {valueState === 'fail' ? (
        <div className="rp-fail" data-rp-value-fail="1">
          {valueMsg || TEXT_SEARCH_FAIL}
        </div>
      ) : null}
      {valueState === 'ok' && valueShown.length === 0 ? (
        <div className="rp-empty" data-rp-value-empty="1">
          {TEXT_EMPTY}
        </div>
      ) : null}
      {valueShown.length > 0 ? (
        <div className="rp-block" data-rp-value-list="1">
          <div className="rp-block-hd">{valueShown.length} 件在预算内</div>
          {valueShown.map((p, i) => (
            <div className="rp-vrow" key={p.key} data-rp-value-row={p.key}>
              <span className="rp-rank">{i + 1}</span>
              <span className="rp-name">{p.name}</span>
              <span className="rp-price">现价 ¥{p.discountPrice}</span>
              {p.discountRate !== null && p.discountRate > 0 ? (
                <span className="rp-tag">便宜 {formatDiscountRate(p.discountRate)}</span>
              ) : null}
              <Button size="small" data-rp-once-value={p.key} onClick={() => addOneOff(p)}>
                加入清单
              </Button>
              <Button size="small" onClick={() => addSub(p)}>
                加入常买
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {valueState === 'ok' && valuePool.length > valueShown.length ? (
        <div className="rp-muted" data-rp-value-cut="1">
          另有 {valuePool.length - valueShown.length} 件超出预算或价格没公开，没有列出来。
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="module-page rp-page" data-rp-root="1" data-rp-step={step}>
      <div className="module-page-head">
        <h2 className="module-page-title">📦 AI 补货</h2>
        <p className="module-page-sub">
          跟商品管理一样：第一页挑商品，第二页看补货清单。常买的设好数量，以后一键就能补。
        </p>
      </div>

      {bannerBlock}

      {/*
        两步导航（老板要的「第一页选商品 / 第二页补货清单」）。
        ⚠️ 这里**不卸载**下面两屏的状态：`selected` / `qtyDraft` / `oneOff` 全在 `Replenish` 上，
          所以来回切不会丢已选 —— 断言 `data-rp-cart-count` 与勾选数在切两次后必须不变。
        ⚠️ 「按预设一键补货」放在**步骤条上**，不埋进第二页：老板的路径是
          「打开补货 → 点一下 → 看完清单去下单」，那一下必须在第一眼就能点到。
      */}
      <div className="rp-steps" data-rp-steps="1">
        <span
          className={'rp-step' + (step === 'pick' ? ' rp-step-on' : '')}
          role="link"
          tabIndex={0}
          data-rp-step-btn="pick"
          data-rp-step-active={step === 'pick' ? '1' : '0'}
          onClick={() => setStep('pick')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setStep('pick');
          }}
        >
          ① 选商品
        </span>
        <span
          className={'rp-step' + (step === 'cart' ? ' rp-step-on' : '')}
          role="link"
          tabIndex={0}
          data-rp-step-btn="cart"
          data-rp-step-active={step === 'cart' ? '1' : '0'}
          onClick={() => setStep('cart')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setStep('cart');
          }}
        >
          ② 补货清单
          <b className="rp-step-n" data-rp-step-count={cart.counts.total}>
            {cart.counts.total}
          </b>
        </span>
        {/*
          「按预设一键补货」只在**有常买清单时**出现。
          为什么要藏：清单是空的时候，这个按钮唯一能做的事就是弹一句「常买清单还是空的」——
          一个只会说"你还没加东西"的按钮不值得占首屏一个位置（首屏按钮预算是硬账，
          见 `scripts/smoke/unit-firstscreen.mjs` 的 `replenish` 棘轮格）。
          有清单时它必须**第一眼就在**：老板的路径是「打开补货 → 点一下 → 看清单去下单」。
        */}
        {subs.length > 0 ? (
          <Button type="primary" size="small" data-rp-preset-all-bar="1" onClick={applyPresetAll}>
            按预设一键补货
          </Button>
        ) : (
          <span className="rp-muted" data-rp-preset-all-hint="1">
            还没有常买清单 —— 先在下面搜商品加几个，之后这里会多一个「按预设一键补货」
          </span>
        )}
      </div>

      {step === 'cart' ? (
        cartPane
      ) : (
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k)}
          items={[
            { key: 'subs', label: <span data-rp-tab="subs">常买清单</span>, children: subsPane },
            // forceRender：性价比那屏的控件（最高单价 / 优先打折）在 DOM 里常驻，
            // 切页签不重建、也不丢用户已经设好的预算。它里面没有任何 <button>，首屏按钮数不受影响。
            {
              key: 'value',
              label: <span data-rp-tab="value">性价比补货</span>,
              forceRender: true,
              children: valuePane,
            },
          ]}
        />
      )}
    </div>
  );
}
