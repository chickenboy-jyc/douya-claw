/**
 * MarketMomentum —— 「竞品分析」主视图（0.21.13 精简版：一次联网问答 → 精简结论）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 老板原话（2026-10-20，本轮唯一依据，逐字）
 * ────────────────────────────────────────────────────────────────────────────
 *   「竞品分析还是又臭又长，没有数据就不要显示了啊，为什么竞品分析还要去企业大脑里面补全，
 *    我觉得竞品分析直接用联网大模型 分几个问题 跑一个对话出来 就行了。简单点，不用太复杂，
 *    把大模型能搜到的都分析一下，最后精简一下不就好了吗，然后这一块UI有问题。」
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 本轮做了什么（与上一条原话的对应关系）
 * ────────────────────────────────────────────────────────────────────────────
 *   ① 「分几个问题 跑一个对话出来」⇒ 页面只剩一条主流程：输入关键词（可空）→ 点「分析」→
 *      豆芽按 4 个问题**串行**各检索一次，**逐题落 DOM**（用户看着一条条出结果，不是等 60 秒白屏）：
 *        Q1 你的同行到底有谁？        → 3~5 家，每家一句定位
 *        Q2 他们各自卖什么、什么价位？ → 每家主打 + 价格带（没查到的字段整行不渲染）
 *        Q3 他们最近在做什么？        → 每家最多 1 条近期动作
 *        Q4 我们的空子在哪？          → 2~3 条能马上做的机会
 *   ② 「没有数据就不要显示」⇒ 结果区**只渲染有值的字段**：某家某字段空 ⇒ 那行少一块，
 *      整家都空 ⇒ 这家不渲染。全页**禁止**出现「—」「暂无」「未检索」「模型补全」「待核验」
 *      这类占位话术（由 `cleanValue()` 在数据进 DOM 之前就拦掉，不是靠 CSS 隐藏）。
 *   ③ 「为什么还要去企业大脑里面补全」⇒ 引导去补资料的按钮与「先补数据才能分析」的门槛
 *      **全部删除**：现在不填任何资料、不登记任何竞品，点「分析」就能出结论。
 *   ④ 「又臭又长」⇒ 旧页面的 6 组示例数据（DEMO_COMPETITORS / DEMO_COMPARE_ROWS /
 *      DEMO_TIMELINE / DEMO_INSIGHT / DEMO_OPPORTUNITIES / DEMO_RECO，含假市场份额 8.7%）、
 *      11 维诊断长列表、GEO 补救引导流、跨模块跳转按钮，一律删除。
 *      示例常量是**直接删掉**，不是改成"看起来像真的"。
 *   ⑤ 「UI 有问题」⇒ 旧页面把 CompetitorAnalysis 在同一个页面渲染了**两次**
 *      （`data-embed="competitor-matrix"` 与 `data-intel-sec="compare"`），用户看到两份竞品对比。
 *      本轮把 CompetitorAnalysis 从本页**整个移出**：一页只有一份结论，且不再是长滚动。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 0.21.15 补齐（老板第 3 条：「竞品分析是不是还没做好？」）
 * ────────────────────────────────────────────────────────────────────────────
 * 上一轮把「总体客观评价 + 问豆芽面板」做在了 `modules/CompetitorAnalysis.jsx` 上，
 * 而导航「竞品分析」渲染的其实是**本文件**（App.jsx:3568）⇒ 功能做对了、落点错了，
 * 老板一个都没看到。本轮把同一套东西补到本文件，并修掉「4 条里 1 条是空的」：
 *   ⑥ 四个答案**之后**多一个「📊 总体客观评价」：市场格局 / 我方位置 / 最大短板 /
 *      三条优先动作（做什么 + 为什么 + 怎么衡量）。生成方式见 `askVerdict` 的注释
 *      （在**同一次分析里多问一题**，把四题答案当唯一事实喂进去）。
 *      归一化判据与 CompetitorAnalysis 的 normVerdict 一致：空对象 / 字段全空 /
 *      优先级缺字段 ⇒ null ⇒ 页面显示一句「本轮没有生成总体评价（依据不足）」，**不留空框**。
 *   ⑦ 「💬 就这份对比问豆芽」挂在本页结论下方：默认收起、点一次一直在（按企业记 localStorage）、
 *      可折叠。它读的是 `buildAdvisorViewFromMomentum()` 压出来的 view
 *      —— 四题答案（含「本轮没拿到」的题）连同信源一起进上下文。
 *   ⑧ 「4 条里 1 条是空的」的两个真实位置：
 *      · `state:'none'`（检索与模型都没回来）—— 原来只印一句「这一题没查到，不编。」；
 *      · `state:'idle'`（还没问）—— 原来**只有标题、没有任何正文**，就是一个空框。
 *      现在两者都给一句**能照做的显式说明**，任何一张答案卡都不会再只有标题。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 0.21.26 追加（老板第 3 次投诉：「竞品分析又有很多内容搜不到的」）
 * ────────────────────────────────────────────────────────────────────────────
 *   ⑨ Q2 / Q3 从「一条 query 摊 3 家」改成**逐家检索**（`def.perCompany` + `askPerCompany`）：
 *      旧实现只把 `names.slice(0, 3)` 拼进检索词，prompt 却把 5 家全交给模型，
 *      又要求「查不到就不要返回这一家」⇒ 第 4/5 家从来没被查过，只能被模型整行删掉。
 *      现在每家一条 query、一条只问这一家的 prompt（资料按家隔离 = 结构保证），
 *      并发上限 3（`PER_COMPANY_CONCURRENCY`），单家失败只记进 missing、不中断整轮。
 *   ⑩ 角标从「联网实检 N 条」（**条数**）扩成「本轮实检覆盖 X 家 / 共 Y 家」（**家数**），
 *      口径照搬死代码 `CompetitorAnalysis.jsx` 的 `searchCoverage`（那套挂在没人挂载的页面上）。
 *      没查到的家**不塞空行**（老板：「没有数据就不要显示」），但角标必须如实点名。
 *   ⑪ `services/competitorPerCompany.js` 是这一套的取数内核（纯函数 + 可注入 searchFn），
 *      门禁 `scripts/smoke/unit-competitor-coverage.mjs` 用假的 groundedSearch 跑真组件。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 诚实红线（改这个文件前必读）
 * ────────────────────────────────────────────────────────────────────────────
 *   · 查不到就写「没查到」，**绝不**用示例值 / 编造数字填充；模型说"暂无"也当没查到（不渲染）；
 *   · 来源角标如实：真拿到检索结果才写「联网实检 N 条」；检索失败退回模型作答时写
 *     「未联网 · 模型答」；两者都没有就整页报一句失败，不给一屏空卡；
 *   · 自家品牌（含旗下 IP）不许被当成同行 —— 复用 selfBrandGuard，与其它模块同一份判据。
 *
 * 结构契约（门禁锚点，改这里要同步改测试，别反过来为了测试塞假数据）
 *   · 首屏 `<button>` 只能有 1 个（`scripts/smoke/unit-firstscreen.mjs` 的 intel 棘轮 = 1）：
 *     就是那个「分析」。其余可点元素一律 role="link"。
 *   · `[data-cq-q="q1".."q4"]` 四题各一份，不允许重复渲染整块结论。
 *   · 全挂时必须有 `.xm-error`（产品契约：网络全挂要亮红条，不许装作成功）。
 *   · 落盘缓存 key：`douya-comp-qa-<companyId>`（浏览器自测脚本据此预置成功态）。
 */
import PageBanner from '../components/PageBanner.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Tag } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { chatOnce } from '../api.js';
import { groundedSearch, buildCompetitorPeersQuery, competitorQueryGap } from '../services/groundedWebSearch.js';
// 「逐家检索」的取数内核（KI-009 第三次投诉：5 家只查前 3 家）。纯函数 + 可注入 searchFn，
// 单测在 `scripts/smoke/unit-competitor-coverage.mjs` 里用假 groundedSearch 跑。
import {
  searchEachCompany,
  mergeCompanyItems,
  coverageBadge,
  coverageHint,
} from '../services/competitorPerCompany.js';
import { extractJSON } from '../services/projectAI.js';
// Markdown → 纯文本的唯一真源（toPlainLine 内部转调它，不再自己维护一份正则）。
import { mdToPlain } from '../utils/mdToPlain.js';
import { collectSelfBrandNames, isSelfBrand } from '../services/selfBrandGuard.js';
import { buildCompetitorCandidates } from '../services/competitorSuggest.js';
// 「我是谁」那一段自我介绍 —— 抽到 services 里才测得了（KI-009 缺口 G2，见该文件头注释）。
import { buildSelfBrief } from '../services/competitorBrief.js';
import CompetitorAdvisor from '../components/CompetitorAdvisor.jsx';
import { buildAdvisorViewFromMomentum, MOMENTUM_DIMS } from '../data/competitorAdvisorPrompt.js';
import '../styles/ia-diagnosis.css';

/** 答案缓存的 localStorage 前缀（按企业隔离；刷新/切模块回来还在，不用重跑 60 秒）。 */
const CACHE_PREFIX = 'douya-comp-qa-';

/** 每题最多渲染几条（老板要「精简」，不是要一份长名单）。 */
const MAX_ROWS = { q1: 5, q2: 5, q3: 5, q4: 3 };

/**
 * 「没数据」话术的精确命中集。
 * 模型很爱在查不到时写「暂无数据 / 未查到 / 无公开信息」，这些**全部当空值**，
 * 因为老板的原话是「没有数据就不要显示」——把它渲染出来就等于没执行这条。
 */
const NO_DATA_EXACT = /^(暂无|暂无数据|暂无公开信息|未查到|未检索|未获取|未获取到|未知|不详|没有|无|无数据|无信息|无公开信息|待补|待核验|模型补全|n\/a|na|none|null|nil|-|--|—|\/)$/i;
/** 「没数据」话术的前缀命中集（`无` / `没有` 只做精确匹配，避免把「无锡口腔」这种真名误杀）。 */
const NO_DATA_HEAD = /^(暂无|未查到|未检索|未获取|未知|不详|待核验|模型补全|无数据|无公开|没有数据)/i;
/** 纯标点/空白也算没数据。 */
const PUNCT_RE = /[\s，。、；：,.;:（）()【】\[\]《》"'!！?？\-—~/|]/g;

/**
 * 把任意模型输出规整成「可渲染的值」；规整成空字符串 ⇒ 调用方**不渲染这一块**。
 *
 * @param {unknown} v 原始值
 * @returns {string} 可渲染文本；空字符串代表"没数据"
 */
function cleanValue(v) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (NO_DATA_EXACT.test(t)) return '';
  if (NO_DATA_HEAD.test(t)) return '';
  if (t.replace(PUNCT_RE, '').length < 2) return '';
  return t;
}

/**
 * 纯文本降级：模型没给合法 JSON 时，把原文压成一句短的（仍然不编造、不补占位）。
 *
 * 【0.21.25】内部改为复用 `mdToPlain()`，不再自己写一份 15 行正则 ——
 * 本仓此前**没有**「markdown → 纯文本」的正经函数，这是全仓唯一一份单点实现
 * （只服务检索摘要）。现在统一到 `utils/mdToPlain.js`，两处口径不会再漂移。
 * 本函数额外负责的是「压成**一行**并截断到 180 字」，那部分保留在这里。
 * @param {string} content 模型原文
 * @returns {string} 一行纯文本；无有效内容时返回 ''
 */
function toPlainLine(content) {
  let t = mdToPlain(String(content || ''))
    .replace(/^[>\s]*📌.*$/gm, ' ')     // 老式来源横幅
    .replace(/\s+/g, ' ')
    .trim();
  // 模型给了"整段 JSON 但解析失败"时，别把花括号丢给用户看。
  if (/^[{[]/.test(t)) return '';
  if (NO_DATA_EXACT.test(t) || NO_DATA_HEAD.test(t)) return '';
  if (t.length > 180) t = t.slice(0, 180).trim() + '…';
  return t;
}

/**
 * 从模型返回的对象里抠出数组（兼容多种键名与一层包装）。
 * @param {unknown} data extractJSON 的产出
 * @param {string[]} keys 候选键名
 * @returns {Array} 找不到就返回空数组
 */
function pickArray(data, keys) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  for (const wrap of ['data', 'result', 'answer', 'output']) {
    const v = data[wrap];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of keys) {
        if (Array.isArray(v[k])) return v[k];
      }
    }
  }
  return [];
}

/** 数组元素 → 对象（模型有时返回字符串数组）。 */
function asObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  const s = cleanValue(v);
  return s ? { name: s } : null;
}

/**
 * 四题的解析器：**只保留有值的字段**，其余一律丢弃（不塞空字符串占位）。
 * 每家的最后一关都是 `filter(Boolean)` + 空行剔除，所以「整家都查不到 ⇒ 这家不渲染」是结构保证。
 */
const PARSERS = {
  /**
   * Q1：同行名单（名字必填；定位可选）
   *
   * 「剔自家品牌 + 同名归一化去重」不在这里另写一套 —— 直接复用 competitorSuggest 的
   * `buildCompetitorCandidates({ webResults })`：联网检索到的同行名从此是**第四类真实来源**
   * （和 企业大脑 / 资产库 / 关键词 同级，有 `scripts/smoke/unit-0219-competitor.mjs` 守着）。
   * 那边还负责「同分时保留检索顺序」，所以模型给的相关度排序不会被打乱。
   *
   * ★ KI-009 缺口 G1（2026-10-30 实测）：**必须把 `asset` 也传进去**。
   *   `buildCompetitorCandidates` 的 score = 来源基础分 + `scoreAgainstAsset(asset, …)` + 顺序微调。
   *   漏传 asset 时 `scoreAgainstAsset` 恒返回 0 ⇒ 只剩 0.001 级的 `orderBonus`：
   *   实测不传 asset = 58.003 / 58.002 / 58.001（榜单几乎全是"检索顺序"，赛道完全不参与排序）；
   *   传 asset     = 66.003 / 66.002 / 58.001（跨行业那家被赛道权重按到 58）。差 8.002。
   *   `asset` 来自组件内 `useMarketingAsset()`，由 `askOne` 传给本工厂函数的第二个参数。
   *
   * @param {string[]} selfBrands 自家品牌 / 旗下 IP（来自 collectSelfBrandNames）
   * @param {object} asset 营销资产（读 industry / products / targetCustomers / profile）
   */
  q1(selfBrands, asset) {
    return (data) => {
      const picked = pickArray(data, ['competitors', 'peers', 'rivals', 'list'])
        .map((raw) => {
          const o = asObj(raw);
          if (!o) return null;
          const name = cleanValue(o.name || o.company || o.brand);
          if (!name) return null;
          const position = cleanValue(o.position || o.desc || o.oneLine || o.note || o.why);
          return { name, position };
        })
        .filter(Boolean);
      if (!picked.length) return [];
      const posByName = new Map(picked.map((it) => [it.name, it.position]));
      const { candidates } = buildCompetitorCandidates({
        asset,
        webResults: picked.map((it) => ({ name: it.name, reason: it.position })),
        selfBrands,
      });
      return candidates
        .slice(0, MAX_ROWS.q1)
        // 定位只显示**模型真给过的原话**：`buildCompetitorCandidates` 兜底的「联网检索到的同行」
        // 是它给面板用的默认理由，不是这家的定位，别当定位印出去。
        .map((c) => ({ name: c.name, position: posByName.get(c.name) || '' }));
    };
  },
  /** Q2：主打 + 价格带（两样都空 ⇒ 这家不渲染） */
  q2(selfBrands) {
    return (data) => pickArray(data, ['products', 'offerings', 'items', 'list'])
      .map((raw) => {
        const o = asObj(raw);
        if (!o) return null;
        const name = cleanValue(o.name || o.company || o.brand);
        const product = cleanValue(o.product || o.offering || o.main || o.item);
        const price = cleanValue(o.price || o.priceRange || o.priceBand);
        if (!product && !price) return null;            // 整行没内容 ⇒ 不渲染
        if (name && isSelfBrand(name, selfBrands)) return null;
        return { name, product, price };
      })
      .filter(Boolean)
      .slice(0, MAX_ROWS.q2);
  },
  /** Q3：近期动作（每家最多 1 条；动作为空 ⇒ 这家不渲染） */
  q3(selfBrands) {
    return (data) => pickArray(data, ['moves', 'actions', 'news', 'list'])
      .map((raw) => {
        const o = asObj(raw);
        if (!o) return null;
        const name = cleanValue(o.name || o.company || o.brand);
        const move = cleanValue(o.move || o.action || o.news || o.text || o.detail);
        if (!move) return null;
        if (name && isSelfBrand(name, selfBrands)) return null;
        return { name, move };
      })
      .filter(Boolean)
      .slice(0, MAX_ROWS.q3);
  },
  /** Q4：机会点（标题与动作至少要有一个） */
  q4() {
    return (data) => pickArray(data, ['opportunities', 'chances', 'gaps', 'list'])
      .map((raw) => {
        const o = asObj(raw);
        if (!o) return null;
        const title = cleanValue(o.title || o.point || o.name || o.gap);
        const action = cleanValue(o.action || o.how || o.todo || o.text || o.detail);
        if (!title && !action) return null;
        return { title, action };
      })
      .filter(Boolean)
      .slice(0, MAX_ROWS.q4);
  },
};

/** 四题的问法（问题文案 = 产品口径，别随手指改：老板点名就是这四个问题）。 */
const QUESTIONS = [
  {
    key: 'q1',
    title: '你的同行到底有谁？',
    running: '正在联网找同行…',
    build: (ctx) => (
      `【竞品问答 Q1】\n${ctx}\n`
      + '请只依据你能检索到的公开资料，找出 3~5 个真正跟我抢同一批客户的同行（竞品），每家给一句定位（是谁、做什么、什么档次）。\n'
      + '只返回一个 JSON 对象，不要解释、不要 markdown 围栏：\n'
      + '{"competitors":[{"name":"同行公司/品牌名","position":"一句话定位"}]}\n'
      + '硬约束：只写真实存在、检索得到的公司；查不到就少写甚至写空数组 []，'
      + '**严禁编造公司名，严禁编造数字**；不要把我自己写进来。'
    ),
    searchQuery: (base) => `${base} 同行 竞争对手 主要品牌`,
    parseKey: 'q1',
  },
  {
    key: 'q2',
    title: '他们各自卖什么、什么价位？',
    running: '正在逐家联网查他们的产品和价位…',
    /**
     * ★ 逐家检索（`perCompany`）—— 见 `services/competitorPerCompany.js` 文件头。
     * `build()` 只在**逐家拿不到任何结论**时兜底用（Q1 没给出名单 / 5 家检索全挂），
     * 正常路径一律走 `companyBuild()`：一次只问一家，资料只属于这一家。
     */
    perCompany: true,
    build: (ctx, names) => (
      `【竞品问答 Q2】\n${ctx}\n`
      + (names.length ? `要查的同行：${names.join('、')}。\n` : '先按我的行业找出 3~5 个主要同行。\n')
      + '请逐家说明：主打产品/服务是什么、大致什么价位。\n'
      + '只返回一个 JSON 对象：\n'
      + '{"products":[{"name":"同行名","product":"主打产品/服务","price":"价格带，例如 5000-9000 元/颗"}]}\n'
      + '硬约束：查不到的字段就写空字符串 ""，**绝对不要编造价格**；'
      + '某一家的产品和价位都查不到，就不要返回这一家。'
    ),
    /** 逐家 prompt：**只出现这一家**的名字（资料归属靠这一条结构保证，见文件头）。 */
    companyBuild: (ctx, name) => (
      `【竞品问答 Q2】\n${ctx}\n`
      + `这一题只查这一个同行：${name}。\n`
      + `请说明 ${name} 的主打产品/服务是什么、大致什么价位。\n`
      + '只返回一个 JSON 对象：\n'
      + `{"products":[{"name":"${name}","product":"主打产品/服务","price":"价格带，例如 5000-9000 元/颗"}]}\n`
      + '硬约束：查不到的字段就写空字符串 ""，**绝对不要编造价格**；'
      + `${name} 的产品和价位都查不到，就把 products 写成空数组 []。`
    ),
    searchQuery: (base, names) => [base, names.join(' '), '产品 价格 报价'].filter(Boolean).join(' '),
    parseKey: 'q2',
  },
  {
    key: 'q3',
    title: '他们最近在做什么？',
    running: '正在逐家联网翻他们的近期动作…',
    perCompany: true,
    build: (ctx, names) => (
      `【竞品问答 Q3】\n${ctx}\n`
      + (names.length ? `要查的同行：${names.join('、')}。\n` : '先按我的行业找出 3~5 个主要同行。\n')
      + '请给每家最多 1 条最近的公开动作（新品 / 活动 / 合作 / 降价 / 开店都算），一句话说清做了什么。\n'
      + '只返回一个 JSON 对象：\n'
      + '{"moves":[{"name":"同行名","move":"一句话说清动作（知道时间就带上）"}]}\n'
      + '硬约束：只写检索得到的真实动作；查不到就不要返回这一家，**不要编造事件与日期**。'
    ),
    companyBuild: (ctx, name) => (
      `【竞品问答 Q3】\n${ctx}\n`
      + `这一题只查这一个同行：${name}。\n`
      + `请给 ${name} 最多 1 条最近的公开动作（新品 / 活动 / 合作 / 降价 / 开店都算），一句话说清做了什么。\n`
      + '只返回一个 JSON 对象：\n'
      + `{"moves":[{"name":"${name}","move":"一句话说清动作（知道时间就带上）"}]}\n`
      + '硬约束：只写检索得到的真实动作；查不到就把 moves 写成空数组 []，**不要编造事件与日期**。'
    ),
    searchQuery: (base, names) => [base, names.join(' '), '最新动态 新品 活动 2026'].filter(Boolean).join(' '),
    parseKey: 'q3',
  },
  {
    key: 'q4',
    title: '我们的空子在哪？',
    running: '正在总结我们能钻的空子…',
    build: (ctx, names) => (
      `【竞品问答 Q4】\n${ctx}\n`
      + (names.length ? `上面这些同行：${names.join('、')}。\n` : '')
      + '结合他们的产品、价位和近期动作，指出 2~3 个我们能马上动手的机会点。\n'
      + '只返回一个 JSON 对象：\n'
      + '{"opportunities":[{"title":"机会点短语","action":"具体怎么做（一句话）"}]}\n'
      + '硬约束：每条都要能落成一个动作；只写有依据的，宁可只给 2 条，**不要凑数写套话**。'
    ),
    // Q4 是**跨家综合**，仍然一条 query；但名单不再截断到 3 家 —— 截断会让
    //  prompt 里的「上面这些同行（5 家）」与实际检索到的 3 家对不上，和 Q2/Q3 是同一个病。
    searchQuery: (base, names) => [base, names.join(' '), '差异化 机会 空白市场'].filter(Boolean).join(' '),
    parseKey: 'q4',
  },
];

/** 单题的初始态（idle 时不渲染任何结论 —— 老板要的"没有数据就不要显示"）。 */
function idleAnswer() {
  return { state: 'idle', items: [], plain: '', source: '', grounded: false, results: 0 };
}

/**
 * 把模型给的「总体客观评价」规整成渲染要的形状；缺字段 / 空对象一律退化成 null。
 *
 * 为什么空对象也要退化成 null（判据**与 CompetitorAnalysis.jsx 的 normVerdict 逐条一致**，
 * 那边归 team-lead 管，本轮没有抽公共函数，改任何一边都要先看另一边）：
 *   UI 要用 `verdict === null` 区分两件事 ——「这一轮根本没生成评价」（要明说）与
 *   「生成了但某一格空」（只空那一格）。允许 `{}` 混进来，页面就会渲染成一张全空的评价卡，
 *   老板看到的还是一块没内容的版式 —— 正是这次点名的毛病。
 *
 * priorities 三个字段（做什么 / 为什么 / 怎么衡量）**全非空**才算一条：
 * 缺 why 的建议不知道为什么做，缺 measure 的没法验收，都属于"看起来有内容"的假条目。
 *
 * @param {unknown} v 模型返回的 verdict
 * @returns {null | {marketView:string, ourPosition:string, biggestGap:string,
 *                   priorities:Array<{action:string,why:string,measure:string}>, confidenceNote:string}}
 */
function normVerdict(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const marketView = cleanValue(v.marketView);
  const ourPosition = cleanValue(v.ourPosition);
  const biggestGap = cleanValue(v.biggestGap);
  const confidenceNote = cleanValue(v.confidenceNote);
  const priorities = (Array.isArray(v.priorities) ? v.priorities : [])
    .map((p) => {
      const one = p && typeof p === 'object' ? p : { action: String(p == null ? '' : p) };
      return {
        action: cleanValue(one.action),
        why: cleanValue(one.why),
        measure: cleanValue(one.measure),
      };
    })
    .filter((p) => p.action && p.why && p.measure)
    .slice(0, 3);
  if (!marketView && !ourPosition && !biggestGap && !confidenceNote && priorities.length === 0) return null;
  return { marketView, ourPosition, biggestGap, priorities, confidenceNote };
}

/**
 * 把这一轮四份答案压成给模型的「事实清单」（总体评价的输入）。
 *
 * 两条硬规矩：
 *   ① 没拿到的题**必须写出来**（「本轮没拿到」），不能省略 —— 省略等于让模型以为没问过，
 *      它会用行业常识把那块补满，那就变成编造了；
 *   ② 每段尾巴带上这题的信源，模型写 confidenceNote 时只能据此说"哪几条是联网查到的"。
 *
 * @param {object} live 本轮四题的答案对象（q1~q4）
 * @returns {string} 可直接嵌进 prompt 的事实清单
 */
function digestAnswers(live) {
  const blocks = [];
  for (const def of QUESTIONS) {
    const a = (live && live[def.key]) || idleAnswer();
    const items = Array.isArray(a.items) ? a.items : [];
    const lines = [];
    if (def.key === 'q4') {
      items.forEach((it) => {
        const title = cleanValue(it && it.title);
        const action = cleanValue(it && it.action);
        if (!title && !action) return;
        lines.push('- ' + [title, action].filter(Boolean).join('：'));
      });
    } else if (def.key === 'q2') {
      items.forEach((it) => {
        const name = cleanValue(it && it.name) || '（未点名）';
        const product = cleanValue(it && it.product);
        const price = cleanValue(it && it.price);
        if (!product && !price) return;
        lines.push('- ' + name + '：'
          + [product ? '主打 ' + product : '', price ? '价位 ' + price : ''].filter(Boolean).join('；'));
      });
    } else if (def.key === 'q3') {
      items.forEach((it) => {
        const name = cleanValue(it && it.name) || '（未点名）';
        const move = cleanValue(it && it.move);
        if (!move) return;
        lines.push('- ' + name + '：' + move);
      });
    } else {
      items.forEach((it) => {
        const name = cleanValue(it && it.name);
        const position = cleanValue(it && it.position);
        if (!name && !position) return;
        lines.push('- ' + [name, position].filter(Boolean).join('：'));
      });
    }
    if (!lines.length && a.state === 'text') {
      const plain = cleanValue(a.plain);
      if (plain) lines.push('- ' + plain);
    }
    blocks.push(
      def.title + '\n'
      + (lines.length ? lines.join('\n') : '- 本轮没拿到（检索和模型都没有回来）')
      + '\n（这一题的信源：' + (a.source || '无') + '）',
    );
  }
  return blocks.join('\n\n');
}

/**
 * 第 5 步：把四份答案汇总成「总体客观评价」。
 *
 * **为什么选「在同一次分析里多问一题」而不是二次调用**：
 *   · 四份答案此刻就在内存里（`live`），把它们当唯一事实喂进去，模型没有编造的空间；
 *   · 不需要再联网 —— 再检索引擎只会带回**新事实**，那就超出"基于上面这次分析"的范围了，
 *     而老板要的正是"看着上面的分析给评价"；
 *   · 复用本文件已有的 `extractJSON` + 归一化套路，没有新基础设施。
 *
 * 温度 0.2（与四题一致）：这一步要的是收敛的结论，不是发散。
 *
 * @param {string} ctx 企业自我介绍（与四题同一份）
 * @param {object} live 本轮四题答案
 * @returns {Promise<null|object>} 归一化后的 verdict；拿不到/不合格一律 null
 */
async function askVerdict(ctx, live) {
  const prompt = `【竞品问答 汇总】\n${ctx}\n\n`
    + '下面是我这一轮按四个问题问出来的全部检索结果，**这就是你唯一可用的事实**：\n\n'
    + digestAnswers(live) + '\n\n'
    + '请基于上面这些事实，给这份竞品分析写一段「总体客观评价」。\n'
    + '只返回一个 JSON 对象，不要解释、不要 markdown 围栏：\n'
    + '{"verdict":{"marketView":"这几家在同一条赛道上怎么排布、各自靠什么抢客户",'
    + '"ourPosition":"相对他们，我们的位置和差异在哪",'
    + '"biggestGap":"最可能让我们丢单的一条短板",'
    + '"priorities":[{"action":"做什么","why":"为什么先做它","measure":"怎么衡量做成了"}],'
    + '"confidenceNote":"这份评价的依据强度：哪几条是上面查到的、哪几条是推断"}}\n'
    + '硬约束：\n'
    + '1. 上面事实里**没出现过**的公司名、数字、价格、份额、销量、评分，一律不许写；'
    + '拿不出依据的字段就写空字符串 ""。\n'
    + '2. priorities 恰好 3 条，每条 action/why/measure 三项都必须有具体内容，'
    + '且必须是上面这些事实能支撑的动作，不许写"提升品牌""加强营销"这类套话。\n'
    + '3. 如果上面的事实不足以支撑任何一条评价，就整体返回 {"verdict":null} —— 不许硬凑。\n'
    + '4. 不要复述名单，要结论。';

  let r = null;
  try {
    r = await chatOnce([{ role: 'user', content: prompt }], null, { temperature: 0.2 });
  } catch (e) {
    return null;
  }
  if (!r || r.ok !== true || !String(r.content || '').trim()) return null;
  const parsed = extractJSON(r.content);
  if (!parsed || typeof parsed !== 'object') return null;
  // 模型有时会跳过外层包装直接给 {marketView,...}，两种都认。
  return normVerdict(parsed.verdict === undefined ? parsed : parsed.verdict);
}

/** 相对时间（纯展示）。 */
function fmtRanAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 说明：`buildSelfBrief`（拼「我是谁」那一段）已于 KI-009 缺口 G2 抽到
// `services/competitorBrief.js` —— 埋在 JSX 里的局部函数 node 测不了，而「品牌矩阵有没有进
// prompt」正是这一轮必须断言的东西。逻辑与输出格式未变，只是多一条品牌矩阵（见该文件注释）。

export default function MarketMomentum({ onSelectModule }) {
  const { currentCompany } = useCompany();
  const { asset } = useMarketingAsset();
  const { getKnowledge } = useCompanyKnowledge();

  const companyId = currentCompany ? currentCompany.id : '';
  const cacheKey = companyId ? CACHE_PREFIX + companyId : '';

  const [kw, setKw] = useState('');
  /** 本次提问实际用到的关键词（缓存里也存，让用户知道这份结论是基于什么问出来的）。 */
  const [kwUsed, setKwUsed] = useState('');
  const [answers, setAnswers] = useState(null);
  const [sourceNote, setSourceNote] = useState('');
  // 【2026-11-09】「有结论但一条实检都没拿到」的页面级警示。
  // 与 error 分开：error 是「什么都没有」，这里是「有东西、但那东西没联网」。
  // 混用会让「模型凭记忆答完」被渲染成成功 —— 正是「不精准」投诉的来源。
  const [searchWarn, setSearchWarn] = useState('');
  const [ranAt, setRanAt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** 总体客观评价（归一化后的 verdict；null = 本轮没生成，页面要明说而不是留空框）。 */
  const [verdict, setVerdict] = useState(null);
  /**
   * 本轮「按家」覆盖率：`{ total, covered[], missing[], modelFilled }`。
   * 数字是**家数**，不是结果条数 —— 旧的「联网实检 N 条」只说条数，
   * 勾 5 家只查了 3 家时它看起来照样"很充分"（0.21.9 就为这个改过一次，但改在死代码上）。
   */
  const [coverage, setCoverage] = useState(null);
  /** 'idle' | 'running' | 'done' —— 只用来区分"还没汇总"和"正在汇总"，不参与数据。 */
  const [verdictPhase, setVerdictPhase] = useState('idle');

  // 自家品牌护栏（母公司 + profile.brandIps + 别名）：同行名单里混进自家子品牌时剔掉。
  const selfBrands = useMemo(
    () => collectSelfBrandNames({ company: currentCompany, asset, knowledge: getKnowledge(companyId) }),
    [currentCompany, asset, getKnowledge, companyId],
  );

  // 切换企业：清空当前结论，再读回这家企业上次的结论（有就显示，没有就空着）。
  useEffect(() => {
    setAnswers(null);
    setSourceNote('');
    setRanAt(0);
    setError('');
    setKwUsed('');
    setVerdict(null);
    setVerdictPhase('idle');
    setCoverage(null);
    if (!cacheKey) return;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.answers && typeof parsed.answers === 'object') {
        setAnswers(parsed.answers);
        setSourceNote(String(parsed.sourceNote || ''));
        setRanAt(Number(parsed.ranAt) || 0);
        setKwUsed(String(parsed.kw || ''));
        // 旧缓存（0.21.14 及以前）没有 verdict 字段 ⇒ 读回 null ⇒ 页面显示「依据不足」那句，
        // 而不是渲染一张空评价卡。
        setVerdict(normVerdict(parsed.verdict));
        setVerdictPhase('done');
        // 旧缓存没有 coverage 字段 ⇒ null ⇒ 不印角标（宁可不说，也不猜一个读数）。
        setCoverage(parsed.coverage && typeof parsed.coverage === 'object' ? parsed.coverage : null);
      }
    } catch {
      /* 缓存坏了就当没缓存，不弹错 */
    }
  }, [cacheKey]);

  /**
   * 问一题：先真检索（grounded），检索不到再退回纯模型作答，两条都挂了才是「没查到」。
   *
   * 为什么保留「退回纯模型」：老板要的是「把大模型能搜到的都分析一下」，检索端点挂掉时
   * 模型自身的常识仍然是可用的分析；但来源必须如实标「未联网 · 模型答」，不许冒充联网。
   *
   * @param {object} def QUESTIONS 里的一题
   * @param {string} ctx 企业自我介绍（拼进 prompt）
   * @param {string[]} names Q1 得到的同行名单（Q1 自己传空数组）
   * @param {string} base 检索词基底（关键词/企业名 + 行业）
   * @returns {Promise<object>} 答案对象 { state, items, plain, source, grounded, results }
   */
  const askOne = useCallback(async (def, ctx, names, base) => {
    const question = def.build(ctx, names);
    const query = def.searchQuery(base, names);
    const parse = PARSERS[def.parseKey](selfBrands, asset);

    let hit = null;
    try {
      hit = await groundedSearch(question, { query, count: 6, temperature: 0.2 });
    } catch (e) {
      hit = null;
    }

    // ① 真检索 + 实检资料作答
    if (hit && hit.ok === true && hit.content) {
      const items = parse(hit.data);
      const grounded = hit.grounded === true;
      const results = Array.isArray(hit.results) ? hit.results.length : 0;
      const source = grounded ? `联网实检 ${results} 条` : '模型答（这次没拿到检索结果）';
      if (items.length) {
        return { state: 'ok', items, plain: '', source, grounded, results };
      }
      const plain = toPlainLine(hit.content);
      if (plain) return { state: 'text', items: [], plain, source, grounded, results };
      return { state: 'none', items: [], plain: '', source, grounded, results };
    }

    // ② 退回纯模型（明确标「未联网」）
    let model = null;
    try {
      model = await chatOnce([{ role: 'user', content: question }], null, { temperature: 0.2 });
    } catch (e) {
      model = null;
    }
    if (model && model.ok === true && typeof model.content === 'string' && model.content.trim()) {
      const items = parse(extractJSON(model.content));
      if (items.length) {
        return { state: 'ok', items, plain: '', source: '未联网 · 模型答', grounded: false, results: 0 };
      }
      const plain = toPlainLine(model.content);
      if (plain) return { state: 'text', items: [], plain, source: '未联网 · 模型答', grounded: false, results: 0 };
    }

    // ③ 检索和模型都没回来 ⇒ 如实说没查到（不填任何东西）
    return { state: 'none', items: [], plain: '', source: '', grounded: false, results: 0 };
  }, [selfBrands, asset]);

  /**
   * 逐家问一题（Q2 / Q3 专用）：**每家一条独立检索 + 一条独立 prompt**。
   *
   * ──────────────────────────────────────────────────────────────────────────
   * 为什么 Q2/Q3 不能沿用 `askOne`（老板第三次投诉的直接来源）
   * ──────────────────────────────────────────────────────────────────────────
   * 旧实现这两题各发**一条** query，且只把 `names.slice(0, 3)` 拼进去，
   * 而 prompt 把 5 家全交给模型、又要求「查不到就不要返回这一家」
   * ⇒ 第 4/5 家从来没有被检索过，模型只能把它们删掉。老板看到的就是「很多内容搜不到」。
   *
   * 现在每家各发一条 query（`buildPerCompanyQuery`，只带这家名 + 行业约束，不带我方企业名），
   * prompt 里也只出现这一家（`def.companyBuild`）⇒ **资料按家隔离是结构保证**，
   * 不是让模型从一锅混起来的 15 条里自己认领（那种归属不可证伪）。
   *
   * 失败隔离：某一家抛错 / 0 条 ⇒ 只把这家记进 `coverage.missing`，整轮继续。
   * 只有**一条实检资料都没拿到**时，才退回「未联网 · 模型答」的老兜底（明确标未联网）。
   *
   * @param {object} def QUESTIONS 里的一题（带 perCompany 的三件套）
   * @param {string} ctx 企业自我介绍
   * @param {string[]} names Q1 得到的同行名单（空数组时走 askOne 的老路径）
   * @returns {Promise<object>} 答案对象（比 askOne 多一个 `coverage`）
   */
  const askPerCompany = useCallback(async (def, ctx, names) => {
    const parse = PARSERS[def.parseKey](selfBrands, asset);
    const industry = String((asset && asset.industry) || '').trim();
    const keyword = kw.trim();

    const outcome = await searchEachCompany({
      names,
      kind: def.parseKey === 'q3' ? 'moves' : 'product',
      industry,
      keyword,
      questionOf: (name) => def.companyBuild(ctx, name),
      parse,
      // 注入点：单测换成假的 groundedSearch（不真联网、不花钱），产品里就是真检索。
      searchFn: groundedSearch,
    });

    const items = mergeCompanyItems(outcome.rows, (it) => it && it.name, MAX_ROWS[def.parseKey]);
    const coverage = {
      total: outcome.total,
      covered: outcome.covered,
      missing: outcome.missing,
      modelFilled: false,
    };
    // `grounded` 的口径：**真的有属于这几家的实检资料**（`results` 只累计命中家数的条数）。
    const grounded = outcome.results > 0;

    if (items.length) {
      const source = (outcome.fetched > 0 ? `联网实检 ${outcome.results} 条` : '模型答（这次没拿到检索结果）')
        + coverageHint(coverage);
      return { state: 'ok', items, plain: '', source, grounded, results: outcome.results, coverage };
    }

    // 一条实检资料都没有 ⇒ 才退回纯模型（与旧行为一致，来源如实标「未联网」）。
    // 判据用 `fetched`（拉回来的**全部**条数）而不是 `results`（命中这几家的条数）：
    // 只要端点真的返回过网页，就不该假装"没联网"再用模型常识重答一遍。
    // 有资料但都没结论 ⇒ 保持「没查到」，不拿模型常识去补（那正是老板点名要停的事）。
    if (outcome.fetched > 0) {
      return { state: 'none', items: [], plain: '', source: '联网实检 0 条有结论', grounded: false, results: 0, coverage };
    }
    const question = def.build(ctx, names);
    let model = null;
    try {
      model = await chatOnce([{ role: 'user', content: question }], null, { temperature: 0.2 });
    } catch (e) {
      model = null;
    }
    if (model && model.ok === true && typeof model.content === 'string' && model.content.trim()) {
      const modelItems = parse(extractJSON(model.content));
      if (modelItems.length) {
        return {
          state: 'ok',
          items: modelItems,
          plain: '',
          source: '未联网 · 模型答',
          grounded: false,
          results: 0,
          coverage: { ...coverage, modelFilled: true },
        };
      }
      const plain = toPlainLine(model.content);
      if (plain) {
        return {
          state: 'text',
          items: [],
          plain,
          source: '未联网 · 模型答',
          grounded: false,
          results: 0,
          coverage: { ...coverage, modelFilled: true },
        };
      }
    }
    return { state: 'none', items: [], plain: '', source: '', grounded: false, results: 0, coverage };
  }, [selfBrands, asset, kw]);

  /** 主流程：四题串行，逐题落 DOM。 */
  const run = useCallback(async () => {
    if (busyRef.current) return;
    if (!companyId) {
      setError('请先在「企业设置」里选择或创建企业，再来分析竞品。');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');

    const keyword = kw.trim();
    setKwUsed(keyword);
    // 「我是谁」：企业名 / 行业 / 定位 / 主营 / 关键词 + **品牌矩阵**（第 6 条）。
    // 最后那条是 KI-009 缺口 G2 的修法：模型不知道「汉斯夫是我的」，就会把它写进同行 ——
    // 候选列表剔除管不到这个，因为它是从**检索结果正文**里自由点名的。
    const ctx = buildSelfBrief({ asset, company: currentCompany, keyword, selfBrands });
    const baseName = String((asset && asset.companyName) || (currentCompany && currentCompany.name) || '').trim();
    const industry = String((asset && asset.industry) || '').trim();
    // 检索词基底 = 主体（关键词/企业名）+ 赛道约束（行业 → 主营 → 目标客户，逐级兜底）。
    // KI-009：行业不再以「填了关键词」为前提 —— 留空时也必须带上，否则 Q1 捞回来的同行跟赛道无关。
    // 【2026-11-09 第四次投诉】KI-009 只修了"行业有值"的情形；默认路径（画像没填行业 + 关键词留空）
    // 仍会拼出空串，Q1 检索词退化成"同行 竞争对手 主要品牌"。现在往下再兜两档（主营/目标客户），
    // 全空时由 competitorQueryGap() 明确告诉 UI"没有赛道约束"，提示用户补一句 —— 不发泛 query 装查过。
    // ⚠️ 必须以**显式调用** buildCompetitorPeersQuery 的形态留下（unit-competitor-query.mjs 的 W1
    //   扫的就是这个调用点）：改了纯函数却没人用 = 修复没生效，那正是 KI-009 当初的样子。
    const base = buildCompetitorPeersQuery({
      keyword,
      companyName: baseName,
      industry,
      products: String((asset && asset.products) || '').trim(),
      targetCustomers: String((asset && asset.targetCustomers) || '').trim(),
    });
    const queryGap = competitorQueryGap({ query: base });

    // ★ 2026-11-09：一个赛道约束都没有时**不发那条泛 query**。
    //   旧行为：base 空 → Q1 检索词退化成「同行 竞争对手 主要品牌」→ 真检索捞回一堆泛行业文章
    //   → 模型按这些文章给同行 → 用户体感「竞品分析不精准」。病在检索条件，不在模型。
    //   现在如实拦住并告诉用户缺什么（补一句行业/主营，或填个关键词），比给一份无关结论有用。
    if (queryGap.needHint) {
      setError(queryGap.hint);
      setAnswers(null);
      setSourceNote('');
      setSearchWarn('');
      setBusy(false);
      busyRef.current = false;
      return;
    }
    setSearchWarn('');

    // 先把四题都铺成「排队中」，Q1 立刻转「查询中」——用户看得见进度。
    const live = {
      q1: { ...idleAnswer(), state: 'running' },
      q2: idleAnswer(),
      q3: idleAnswer(),
      q4: idleAnswer(),
    };
    setAnswers({ ...live });
    setRanAt(0);
    setSourceNote('');
    setVerdict(null);
    setVerdictPhase('idle');
    setCoverage(null);

    let totalResults = 0;
    let names = [];
    /** 本轮真正拿到实检结果的同行（跨 Q2/Q3 取并集；角标按**家数**算，不按条数）。 */
    const coveredSet = new Set();
    let modelFilled = false;
    /** 本轮汇总出来的总体评价（写缓存用；四题全空时保持 null）。 */
    let verdictOut = null;
    /** 本轮按家覆盖率（角标要显示的那份；写缓存，刷新后读数不丢）。 */
    let coverageOut = null;

    try {
      for (let i = 0; i < QUESTIONS.length; i += 1) {
        const def = QUESTIONS[i];
        if (i > 0) {
          live[def.key] = { ...idleAnswer(), state: 'running' };
          setAnswers({ ...live });
        }
        let ans;
        try {
          // Q2/Q3 = 逐家（名单为空时回落到老的"一条 query 问全行业"路径）；
          // Q1/Q4 = 单条（Q1 就是在找名单，Q4 是跨家综合）。
          ans = (def.perCompany && names.length)
            ? await askPerCompany(def, ctx, names)
            : await askOne(def, ctx, names, base || baseName || industry);
        } catch (e) {
          // 单题异常只影响这一题（不整体失败）
          ans = { state: 'none', items: [], plain: '', source: '', grounded: false, results: 0 };
        }
        live[def.key] = ans;
        setAnswers({ ...live });
        // 只统计**真的变成结论**的检索条数：检索回来了但这题压根没产出结论时，
        // 那些资料没有出现在屏幕上，就不该被算进「联网实检 N 条」的账上。
        if (ans.state === 'ok' || ans.state === 'text') {
          totalResults += ans.results || 0;
        }
        if (ans.coverage) {
          (ans.coverage.covered || []).forEach((n) => coveredSet.add(n));
          if (ans.coverage.modelFilled) modelFilled = true;
        }
        if (def.key === 'q1' && ans.items && ans.items.length) {
          names = ans.items.map((it) => it.name).filter(Boolean);
          // 名单是 Q1 出来之后才有的 ⇒ 覆盖率的分母此刻才知道；先落一个"0 家"的底，
          // 让 Q2 一开跑角标就有分母，而不是最后才突然出现。
          coverageOut = {
            total: names.length,
            covered: [],
            missing: names.slice(),
            modelFilled: false,
          };
          setCoverage(coverageOut);
        }
        if (coverageOut) {
          // 每跑完一题就把并集刷进角标：用户能看着「1/5 → 3/5」往上走。
          coverageOut = {
            total: names.length,
            covered: names.filter((n) => coveredSet.has(n)),
            missing: names.filter((n) => !coveredSet.has(n)),
            modelFilled,
          };
          setCoverage(coverageOut);
        }
      }

      // 第 5 步：把四份答案汇总成「总体客观评价」（为什么是"同一次分析里多问一题"见 askVerdict）。
      // 四题全空时**不问** —— 没有事实可以汇总，问了只能得到一段编造。
      const anyContentNow = ['q1', 'q2', 'q3', 'q4'].some((k) => {
        const a = live[k];
        return !!a && (a.state === 'ok' || a.state === 'text');
      });
      if (anyContentNow) {
        setVerdictPhase('running');
        try {
          verdictOut = await askVerdict(ctx, live);
        } catch (e) {
          // 汇总失败不牵连四份答案：答案是真的，评价缺席就如实说"没生成"。
          verdictOut = null;
        }
        setVerdict(verdictOut);
      }
    } finally {
      const finishedAt = Date.now();
      setRanAt(finishedAt);
      setVerdictPhase('done');

      // 四题全空 ⇒ 整页一句失败（产品契约：不许装作成功）
      const anyContent = ['q1', 'q2', 'q3', 'q4'].some((k) => {
        const a = live[k];
        return !!a && (a.state === 'ok' || a.state === 'text');
      });
      // 来源角标只描述**真的渲染在屏幕上的结论**：
      //   · 一条结论都没有 ⇒ 角标留空（别亮「联网实检 N 条」给用户一个没兑现的承诺）；
      //   · 有结论但检索没参与 ⇒ 「未联网 · 模型答」。
      // 这条是浏览器反控实测抓出来的：四题全 none 时角标曾照样印「联网实检 8 条」。
      const note = !anyContent
        ? ''
        : (totalResults > 0 ? `联网实检 ${totalResults} 条` : '未联网 · 模型答');
      setSourceNote(note);
      // ★ 有结论但**没一条实检**：这不是成功，是降级。必须在页面上说出来 ——
      //   只靠右上角一枚橙色小 Tag，用户读不出来「这四题的答案其实没上网」。
      setSearchWarn(anyContent && totalResults === 0
        ? '这一轮的结论是模型凭已有知识给的，没有真的联网检索（可能网络或检索服务不通）。'
          + '要更准就点右上角「重新分析」再试一次；反复这样请检查设置里的联网检索密钥。'
        : '');
      if (!anyContent) {
        setError('这一轮没查到任何结论：联网和模型都没有回来。点「分析」再试一次。');
      }

      try {
        if (cacheKey) {
          localStorage.setItem(cacheKey, JSON.stringify({
            answers: live,
            verdict: verdictOut,
            sourceNote: note,
            ranAt: finishedAt,
            kw: keyword,
            coverage: coverageOut,
          }));
        }
      } catch {
        /* 缓存写失败不影响本次展示 */
      }
      busyRef.current = false;
      setBusy(false);
    }
  }, [askOne, askPerCompany, asset, cacheKey, companyId, currentCompany, kw, selfBrands]);

  /**
   * 渲染前的最后一道「没有数据就不要显示」：
   * 把所有字段再过一遍 `cleanValue`（缓存里的旧数据、模型写的「暂无」都在这里被清掉），
   * 然后把**整行没内容**的条目剔掉。state 也跟着降级：本来 ok 但一行都剩不下 ⇒ 如实变「没查到」。
   */
  const list = useMemo(() => QUESTIONS.map((def) => {
    const raw = (answers && answers[def.key]) || idleAnswer();
    const items = Array.isArray(raw.items)
      ? raw.items.map((it) => normalizeRow(def.key, it, selfBrands)).filter(Boolean)
      : [];
    let state = raw.state || 'idle';
    if (state === 'ok' && items.length === 0) state = 'none';
    if (state === 'text' && !cleanValue(raw.plain)) state = 'none';
    return { def, state, items, plain: cleanValue(raw.plain), source: String(raw.source || '') };
  }), [answers, selfBrands]);

  const hasAny = list.some(({ state }) => state === 'ok' || state === 'text');

  /**
   * 角标文案（按**家数**说覆盖率，不是按结果条数）。
   * 为什么单列一段而不是塞进 `sourceNote`：`sourceNote` 那个 Tag 的语义是"这次联网成不成"，
   * 把「5 家里只有 2 家查到」混进同一个 Tag，就又是一次"看起来很充分"。
   */
  const coverageText = useMemo(() => coverageBadge(coverage || {}), [coverage]);
  const coverageFrac = coverage && Number(coverage.total) > 0
    ? `${(coverage.covered || []).length}/${coverage.total}`
    : '';

  /**
   * 「问豆芽」读的那份 view：把四题答案（含 `state:'none'` 的题）压成
   * buildAdvisorContext 认得的形状。适配逻辑在 data/competitorAdvisorPrompt.js，
   * 本文件只负责把**这一轮屏幕上的东西**递过去 —— 两边数据源一旦分叉，
   * 就会出现"报告里说 A、对话里说 B"。
   */
  const advisorView = useMemo(() => {
    const survey = list.map(({ def, state, items, plain, source }) => {
      const raw = (answers && answers[def.key]) || idleAnswer();
      return {
        key: def.key,
        title: def.title,
        state,
        items,
        plain,
        source,
        grounded: raw.grounded === true,
        results: Number(raw.results) || 0,
      };
    });
    return buildAdvisorViewFromMomentum(survey, verdict, { generatedAt: ranAt });
  }, [list, answers, verdict, ranAt]);

  /** 面板 meta：我方名字 / 同行名单 / 维度 / 有没有拿到联网实检（老板会问"这是联网查的吗"）。 */
  const advisorMeta = useMemo(() => {
    const q1 = list.find(({ def }) => def.key === 'q1');
    const competitors = (q1 ? q1.items : []).map((it) => it.name).filter(Boolean);
    const webLanded = ['q1', 'q2', 'q3', 'q4'].some((k) => !!answers && !!answers[k] && answers[k].grounded === true);
    return {
      companyName: String((asset && asset.companyName) || (currentCompany && currentCompany.name) || ''),
      competitors,
      dims: MOMENTUM_DIMS,
      webLanded,
    };
  }, [list, answers, asset, currentCompany]);

  // 评价区只在"有东西可评价"时出现：
  //   · `busy` 期间不铺（否则四题还没跑完就先亮一句"依据不足"，是误导）；
  //   · 汇总这一步例外 —— 那正是要告诉用户"正在把四条汇成一份评价"。
  const showVerdict = (hasAny || !!verdict) && (!busy || verdictPhase === 'running');
  // 「问豆芽」只在分析跑完之后出现（跑的过程中上下文还在变，问出来的答案必然过期）。
  const showAdvisor = hasAny && !busy;

  return (
    <div className="module-page ca-page cq-page">
      <PageBanner
        ic="radar"
        title="竞品分析"
        sub="输入关键词，豆芽联网分 4 个问题问一遍同行，只给结论。"
        right={(
          <div className="ca-head-side">
            {sourceNote ? <Tag color={sourceNote.indexOf('未联网') === 0 ? 'orange' : 'green'}>{sourceNote}</Tag> : null}
            {/* 按家覆盖率（0.21.26 · 老板第三次「很多内容搜不到的」）：
                条数看不出"5 家只查了 3 家"，家数看得出来。没有名单（total=0）就不印。 */}
            {coverageText ? (
              <span className="ca-cov" data-cq-coverage={coverageFrac}>{coverageText}</span>
            ) : null}
            {ranAt ? <span className="ca-ran-at">上次分析：{fmtRanAt(ranAt)}</span> : null}
            <span
              className="ca-relink"
              role="link"
              tabIndex={0}
              onClick={() => { if (!busy) run(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!busy) run(); } }}
            >
              重新分析
            </span>
          </div>
        )}
      />

      {!companyId && (
        <div className="xm-note" style={{ marginBottom: 12 }}>
          请先在「企业设置」选择或创建企业，再来看竞品分析。
        </div>
      )}

      <div className="ca-search">
        <Input
          className="ca-search-input"
          placeholder="想重点看谁？填个关键词（可以留空）"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          // 刻意不加 allowClear：antd 的清除图标会渲染成一个空白 <button>，
          // 把本页首屏按钮数顶到 2（硬门禁 unit-firstscreen 的 intel 棘轮 = 1）。
          onPressEnter={() => { if (!busy) run(); }}
        />
        <Button type="primary" onClick={run} loading={busy}>
          分析
        </Button>
      </div>
      <div className="ca-search-hint">
        {kwUsed
          ? `这份结论是按「${kwUsed}」问的；换词再点一次「分析」就是新的一份。`
          : '关键词可以留空：留空就按你企业的行业找同行。不用先补资料，也不用先登记竞品。'}
      </div>

      {error ? <div className="xm-error" style={{ marginBottom: 12 }}>{error}</div> : null}
      {/* 【2026-11-09】有结论但没联网：说清这是降级结果，别让用户当成"查过了"。
          用 data-cq-noweb 做锚点，门禁可断言这条真的会渲染。 */}
      {searchWarn ? (
        <div className="cq-noweb" data-cq-noweb="1" style={{ marginBottom: 12 }}>
          {searchWarn}
        </div>
      ) : null}

      <div className="cq-list" data-cq-count={list.length}>
        {list.map(({ def, state, items, plain, source }, idx) => (
          <section
            className={'cq-q cq-q-' + state}
            key={def.key}
            data-cq-q={def.key}
            data-cq-state={state}
          >
            <div className="cq-q-hd">
              <span className="cq-q-no">Q{idx + 1}</span>
              <span className="cq-q-title">{def.title}</span>
              <span className="cq-q-state">
                {state === 'running' ? def.running
                  : state === 'ok' ? `${items.length} 条`
                    : state === 'text' ? '已答'
                      : state === 'none' ? '没查到'
                        : '还没问'}
              </span>
            </div>

            {state === 'ok' ? <QBody qkey={def.key} items={items} /> : null}
            {state === 'text' ? <div className="cq-plain">{plain}</div> : null}
            {/* 「4 条里 1 条是空的」的两个真实位置（见文件头 ⑧）：
                · none  —— 检索与模型都没回来：说清是什么情况 + 下一步能做什么；
                · idle  —— 还没问：原来**一个字的正文都没有**（只剩标题的空框），现在给一句能照做的。 */}
            {state === 'none' ? (
              <div className="cq-none" data-cq-gap={def.key}>
                这一题没查到，不编。可以换个关键词，再点一次「分析」。
              </div>
            ) : null}
            {state === 'idle' ? (
              <div className="cq-none" data-cq-idle={def.key}>
                还没问。点上面的「分析」，豆芽会把这一题也问一遍。
              </div>
            ) : null}
            {source && (state === 'ok' || state === 'text') ? (
              <div className="cq-src">来源：{source}</div>
            ) : null}
          </section>
        ))}
      </div>

      {/* ===== 📊 总体客观评价（老板第 3 条：不能只有 4 条答案，要有一句总体判断）=====
          三条纪律：
            · 只基于上面四份答案汇总（askVerdict 的输入就是它们），不引入新的外部数字；
            · verdict 为 null 时**不留空框**，明说「依据不足」并给下一步；
            · 结论未出（busy）时不铺，只有"正在汇总"那一刻例外。 */}
      {showVerdict ? (
        <section
          className="cq-q cq-q-ok comp-block comp-verdict-block"
          data-cq-verdict={verdict ? 'ok' : (verdictPhase === 'running' ? 'running' : 'none')}
        >
          <div className="comp-block-head">
            <span className="comp-block-title">📊 总体客观评价</span>
            <span className="comp-block-sub">
              {verdictPhase === 'running' ? '正在把上面四条汇成一份评价…' : '基于上面四条结论汇总，没有引入外部新数据'}
            </span>
          </div>

          {verdict ? (
            <>
              <div className="comp-verdict-grid">
                <div className="comp-verdict-item">
                  <span className="comp-verdict-label">市场格局</span>
                  <span className="comp-verdict-text">{verdict.marketView || '这条本轮没拿到'}</span>
                </div>
                <div className="comp-verdict-item">
                  <span className="comp-verdict-label">我方位置</span>
                  <span className="comp-verdict-text">{verdict.ourPosition || '这条本轮没拿到'}</span>
                </div>
                <div className="comp-verdict-item">
                  <span className="comp-verdict-label">最大短板</span>
                  <span className="comp-verdict-text">{verdict.biggestGap || '这条本轮没拿到'}</span>
                </div>
                <div className="comp-verdict-item">
                  <span className="comp-verdict-label">证据强度说明</span>
                  <span className="comp-verdict-text comp-verdict-note">
                    {verdict.confidenceNote || '这条本轮没拿到'}
                  </span>
                </div>
              </div>
              {verdict.priorities.length > 0 ? (
                <div className="comp-verdict-prior">
                  <div className="comp-verdict-prior-head">优先动作（按优先级排序）</div>
                  {verdict.priorities.map((p, i) => (
                    <div className="comp-verdict-prior-item" key={'cq-verdict-prior-' + i}>
                      <span className="comp-verdict-prior-no">{i + 1}</span>
                      <div className="comp-verdict-prior-body">
                        <div className="comp-verdict-prior-action">{p.action}</div>
                        <div className="comp-verdict-prior-why">为什么：{p.why}</div>
                        <div className="comp-verdict-prior-measure">怎么衡量：{p.measure}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : verdictPhase === 'running' ? (
            <div className="comp-verdict-empty">正在汇总，马上出来…</div>
          ) : (
            <div className="comp-verdict-empty" data-cq-verdict-empty="1">
              本轮没有生成总体评价（依据不足）。上面能查到的都列在上面了，换个关键词再点一次「分析」可能会补上。
            </div>
          )}
        </section>
      ) : null}

      {/* ===== 💬 就这份对比问豆芽 =====
          老板原话：「也没有可以问的地方…这个对话框可以自动看上面分析的内容…
                    点一次就会一直保存着 可以折叠掉」。
          默认收起 / 按企业记开合 / 可折叠 的行为都在组件里（见 CompetitorAdvisor.jsx 文件头）。
          它读的是上面这份 `advisorView`（四题答案 + 信源），不是行业常识。 */}
      {showAdvisor ? (
        <div className="comp-verdict-block comp-advisor-block" data-cq-advisor="1">
          <CompetitorAdvisor
            view={advisorView}
            companyId={companyId}
            resetKey={companyId + ':' + String(ranAt || 0)}
            meta={advisorMeta}
          />
        </div>
      ) : null}

      {!hasAny && !busy ? (
        <div className="cq-empty">
          点上面的「分析」，豆芽会把这 4 个问题挨个问一遍，查到什么说什么，没查到的就空着。
        </div>
      ) : null}
    </div>
  );
}

/**
 * 渲染层的行级清洗（**与取数层的 PARSERS 是两道独立关卡**，不是重复）。
 *
 * 为什么渲染层还要再洗一遍：答案会被写进 localStorage 缓存、下次直接从缓存渲染；
 * 缓存可能来自旧版本、也可能被手改。只要"没数据就不显示"只做在取数层，
 * 一份脏缓存就能把「暂无」「—」重新印回页面上 —— 那是老板这次点名要清掉的东西。
 * ⇒ 判定放在**要进 DOM 的那一步**：这一层过了才允许渲染。
 *
 * @param {string} qkey 题号 q1~q4
 * @param {object} it 一条原始结果
 * @param {string[]} selfBrands 自家品牌 / 旗下 IP（渲染层再挡一次，缓存里的脏数据也挡得住）
 * @returns {object|null} 清洗后的行；整行没内容返回 null（调用方剔掉）
 */
function normalizeRow(qkey, it, selfBrands) {
  if (!it || typeof it !== 'object') return null;
  const isMine = (n) => !!(n && Array.isArray(selfBrands) && isSelfBrand(n, selfBrands));
  if (qkey === 'q4') {
    const title = cleanValue(it.title);
    const action = cleanValue(it.action);
    if (!title && !action) return null;
    return { title, action };
  }
  const name = cleanValue(it.name);
  // 自家品牌 / 旗下 IP 不是同行：即便它出现在缓存里（旧数据、手改、上游污染）也不渲染。
  if (isMine(name)) return null;
  if (qkey === 'q2') {
    const product = cleanValue(it.product);
    const price = cleanValue(it.price);
    // 主打与价位都没查到 ⇒ 这家在 Q2 就是没有数据，整行不渲染（名字本身不算答案）
    if (!product && !price) return null;
    return { name, product, price };
  }
  if (qkey === 'q3') {
    const move = cleanValue(it.move);
    if (!move) return null;
    return { name, move };
  }
  const position = cleanValue(it.position);
  if (!name && !position) return null;
  return { name, position };
}

/** 每题的结果体：只渲染有值的字段，一条都不占位。 */
function QBody({ qkey, items }) {
  if (!items || items.length === 0) return null;
  if (qkey === 'q4') {
    return (
      <ol className="cq-opp">
        {items.map((it, i) => (
          <li className="cq-opp-item" key={i} data-cq-row={i}>
            {it.title ? <div className="cq-opp-t">{it.title}</div> : null}
            {it.action ? <div className="cq-opp-a">{it.action}</div> : null}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="cq-rows">
      {items.map((it, i) => (
        <div className="cq-row" key={(it.name || '') + i} data-cq-row={i}>
          {it.name ? <span className="cq-row-name">{it.name}</span> : null}
          {it.position ? <span className="cq-row-txt">{it.position}</span> : null}
          {qkey === 'q2' && it.product ? <span className="cq-row-txt">{it.product}</span> : null}
          {qkey === 'q2' && it.price ? <span className="cq-row-price">{it.price}</span> : null}
          {qkey === 'q3' && it.move ? <span className="cq-row-txt">{it.move}</span> : null}
        </div>
      ))}
    </div>
  );
}
