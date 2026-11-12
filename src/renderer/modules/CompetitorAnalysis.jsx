/**
 * CompetitorAnalysis —— 「经营诊断 · 竞品对比详情」视图。
 *
 * 2026-09-12 信息架构重排（包 B，老板第 7 条）定位调整：
 *   竞品对比 / GEO / SEO 曝光对比 的**唯一展示出口**是「经营诊断」。
 *   本组件不再作为独立板块语义存在 —— 导航别名 `competitor → intel` 保留，
 *   且主要作为经营诊断「竞品对比」维度卡片的**内嵌详情**被消费
 *   （`<CompetitorAnalysis embedded />`）。
 *
 * 向后兼容：`App.jsx:1977` 仍以 `<CompetitorAnalysis onSelectModule={...} />` 调用（无 embedded），
 * 行为与改造前完全一致。`embedded` 为**可选** prop，缺省 false。
 *
 * 数据来源分级（真实性铁律）：联网检索 / 行业经验假设 / 用户已填 —— 不把假设伪装成事实。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Input,
  Checkbox,
  Tag,
  Space,
  Collapse,
  Table,
  Segmented,
  Modal,
  Tooltip,
  Empty,
} from 'antd';
import Markdown from '../components/Markdown.jsx';
// 【2026-10-20 · 老板第 2 条】「就这份对比问豆芽」对话面板：它读的是本页那份 view，
// 所以必须由本页把 view + meta 递进去，而不是自己再去取一次数据（两会各自取会跑偏）。
import CompetitorAdvisor from '../components/CompetitorAdvisor.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useDirection } from '../store/directionStore.jsx';
import { buildCompetitorDirection } from '../services/directionDirector.js';
import { buildAIContext } from '../services/contextBuilder.js';
import { chatOnce, geoProxy } from '../api.js';
import {
  getCachedWebSearchHealth,
  checkWebSearchHealth,
  describeSource,
  describeSourceWithCount,
  SOURCE_KINDS,
} from '../services/webSearchHealth.js';
// T16：竞品对比改为**真检索**（fetchWebSearch + 注入实检资料），不再走静默忽略 enable_search 的 searchWeb。
// 【0.21.9 · M1】matchCoveredCompetitors：逐家判定「本次实检到底查到了哪几家」，
// 没查到的行由矩阵显式标「未检索，模型补全」—— 只改角标不改覆盖是新的假绿。
import { groundedHealth, searchCompetitorCompare, matchCoveredCompetitors } from '../services/groundedWebSearch.js';
import { startJob, useBackgroundJob } from '../store/backgroundJobs.js';
import { extractJSON } from '../services/projectAI.js';
import { isPlaceholderText } from '../services/companyProfile.js';
import { SOURCE_LEVELS, hasBrain, competitorReasons, competitorsToAsset } from '../config/companyBrain.js';
// 2026-09-21：自家品牌护栏 —— 母公司 + profile.brandIps（含别名）。
// 用途：矩阵行 / AI 推荐竞品里若混进自家子品牌（老板实测：上游货源），一律剔除并留痕。
import { collectSelfBrandNames, excludeSelfBrands, isSelfBrand, filterSelfBrandRows } from '../services/selfBrandGuard.js';
// 【2026-10-19 · 老板第 5 条】「AI 自动帮我挑好竞品，用户打钩就行」的候选构建器。
// 纯函数、只读三个真实来源（企业大脑 / 已登记 / 用户关键词），**绝不编造**竞品名；
// 候选为空时返回 emptyReason 引导补资料 —— 空是正确结果，不是缺陷。
import { buildCompetitorCandidates } from '../services/competitorSuggest.js';

// 对比维度（默认按企业类型勾选，可取消）
const DIMENSIONS = [
  { key: 'position', label: '品牌定位' },
  { key: 'product', label: '主推产品/项目' },
  { key: 'price', label: '价格带' },
  { key: 'channel', label: '渠道模式' },
  { key: 'content', label: '内容阵地' },
  { key: 'voice', label: '声量表现' },
  { key: 'selling', label: '核心卖点' },
  { key: 'audience', label: '目标客户' },
];

const DIMENSION_LABEL = {};
for (const d of DIMENSIONS) DIMENSION_LABEL[d.key] = d.label;

// 维度强弱 → 雷达分值（无数据为 0）
// 【0.21.9 · M3】这组数字**没有真实数据源**：模型给的是 strong/mid/weak 标签，这里把它换成 85/60/35，
// 人工填写的文字更是直接按中位 50 计入。用户看到「我们 60 / 竞品 85」会当成量化结论。
// 本轮处理方式：**保留但降级** —— 图上标「示意，非实测」，且不进入任何导出/汇报
// （toMarkdown 刻意不输出 scores，见那里的注释）。不删是因为看形状差异仍有价值。
const LEVEL_SCORE = { strong: 85, mid: 60, weak: 35, unknown: 0 };
const LEVEL_TEXT = { strong: '强', mid: '中', weak: '弱', unknown: '—' };
const IMPACT_TEXT = { high: '影响大', mid: '影响中', low: '影响小' };
const EFFORT_TEXT = { low: '投入低', mid: '投入中', high: '投入高' };
const CONF_TEXT = { verified: '人工', estimated: '估算', unknown: '未核实' };

// 雷达配色：我方固定品牌绿，其余用暖色/紫粉系（不使用黑/蓝）
const SERIES_COLORS = ['#30d158', '#ff9f0a', '#ff453a', '#bf5af2', '#e5b80b', '#ff375f'];

// 竞品来源标注（真实性铁律：不把行业经验假设伪装成联网事实）
// 注：SOURCE_LEVELS.WEB 的文案**不写死**「联网检索」—— 由 competitorSourceLabel 交给 describeSource
// 按运行时联网探针三态决定（确证联网才允许出现「联网检索」）。此表只覆盖非 web 来源。
const COMPETITOR_SOURCE_LABEL = {
  [SOURCE_LEVELS.INDUSTRY]: '行业经验假设 · 未联网核实',
  [SOURCE_LEVELS.USER]: '用户已填',
};
/** 竞品来源 → 展示文案；未知来源按最保守的「行业经验假设」标注。 */
function competitorSourceLabel(source) {
  // 诚实化：source==='web'（联网可查）的竞品实际由 searchWeb 产出，而内网网关不支持
  // enable_search —— 没联网时它其实是模型推断，不能标成「联网检索」。
  // 统一复用 describeSource（跟随探针三态，并在确证联网时带上 provider 与实检条数）：
  //   确证联网 → 「联网检索（provider 实检 N 条）」；已确证未联网 → 「未联网 · 模型推断」；
  //   未确认   → 「模型分析（联网状态未确认）」。绝不把模型推断伪装成联网事实。
  if (source === SOURCE_LEVELS.WEB) {
    return describeSourceWithCount(SOURCE_KINDS.WEB, getCachedWebSearchHealth());
  }
  return COMPETITOR_SOURCE_LABEL[source] || COMPETITOR_SOURCE_LABEL[SOURCE_LEVELS.INDUSTRY];
}
/** 竞品来源 → 标签配色（web 绿色=已核实，industry 橙色=需标注的假设）。 */
function competitorSourceColor(source) {
  return source === SOURCE_LEVELS.WEB ? 'green' : source === SOURCE_LEVELS.USER ? 'blue' : 'orange';
}

/** 人工填写数据持久化 key（按企业隔离）：{ [companyId]: { [竞品名]: { [维度key]: 文本 } } } */
const MANUAL_KEY = 'douya-competitor-manual';
/** 单元格填充弹窗一次最多补多少项，防止一次渲染过多 Input */
const MAX_FILL_TARGETS = 40;

/** 「没数据」话术前缀：命中即视为该单元格无数据，不渲染成结论 */
const NO_DATA_RE = /^(未获取到|暂未查到|暂无法查到|未查到|暂无|无公开信息|尚未查到|暂未获取|需人工补充|未知|n\/a)/i;
/** 纯标点/空白也算没数据 */
const PUNCT_RE = /[，。；、,.;\s:：（）()\-—《》"'!！?？\[\]【】|/]/g;

// 按企业类型给不同的默认对比维度：厂家看「产品/价格/渠道」，门诊/平台看「流量/声量/内容」
function defaultDimsForType(type) {
  // 四主体：门诊/医生看「流量声量内容」，厂家看「产品价格渠道」，平台看「渠道生态」
  if (type === 'clinic' || type === 'doctor') return ['position', 'content', 'voice', 'audience'];
  if (type === 'platform') return ['position', 'channel', 'content', 'voice', 'audience'];
  return ['position', 'product', 'price', 'channel', 'selling'];
}

function asList(v) {
  return Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

function asText(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * 判断一段文本是否等于「没数据」。
 * 复用 companyProfile 的 isPlaceholderText，但要求同时命中明确的「查不到」话术，
 * 避免其「建议 / 请提供」规则把正常的竞品描述误判成占位内容。
 * @param {unknown} value 待判定值
 * @returns {boolean} true 表示无数据
 */
function isNoData(value) {
  const t = asText(value);
  if (!t) return true;
  if (NO_DATA_RE.test(t)) return true;
  if (/暂未查到|未查到|暂无公开|无公开信息|尚未查到|暂未获取|信息缺失|无法确定|无法核实|无法获取|未能获取/.test(t) && isPlaceholderText(t)) {
    return true;
  }
  if (t.replace(PUNCT_RE, '').length < 2) return true;
  return false;
}

function normLevel(v) {
  const s = asText(v).toLowerCase();
  if (['strong', '强', '高', '优势', '领先', 'a'].includes(s)) return 'strong';
  if (['mid', 'medium', '中', 'b'].includes(s)) return 'mid';
  if (['weak', '弱', '低', '劣势', 'c'].includes(s)) return 'weak';
  return 'unknown';
}

function normConfidence(v) {
  const s = asText(v).toLowerCase();
  if (['verified', '人工', '实抓', 'high', '确认', '已核实'].includes(s)) return 'verified';
  if (['estimated', '估算', 'medium', 'mid', '联网估算'].includes(s)) return 'estimated';
  return 'unknown';
}

/** 强弱标签配色：对我方做反转（我方「强」= 好事 = 绿） */
function levelColor(level, isUs) {
  if (level === 'strong') return isUs ? 'green' : 'red';
  if (level === 'mid') return 'orange';
  if (level === 'weak') return isUs ? 'red' : 'green';
  return 'default';
}

function impactColor(impact) {
  if (impact === 'high') return '#ff453a';
  if (impact === 'mid') return '#ff9f0a';
  return '#8e8e93';
}

function emptyRow(name, dims, isUs) {
  const cells = {};
  for (const dk of dims) {
    cells[dk] = { text: '', level: 'unknown', evidence: '', confidence: 'unknown' };
  }
  return { name, isUs: !!isUs, level: 'unknown', cells, gaps: [], threats: [] };
}

// ==================== 人工数据持久化（localStorage，按企业隔离） ====================
function loadManualMap() {
  try {
    const raw = localStorage.getItem(MANUAL_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

function normalizeManual(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const k of Object.keys(v)) {
    const entry = v[k];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const clean = {};
    for (const dk of Object.keys(entry)) {
      const t = asText(entry[dk]);
      if (t) clean[dk] = t;
    }
    if (Object.keys(clean).length) out[k] = clean;
  }
  return out;
}

function readManual(companyId) {
  const map = loadManualMap();
  return normalizeManual(companyId ? map[companyId] : null);
}

function writeManual(companyId, manual) {
  try {
    const map = loadManualMap();
    if (companyId) map[companyId] = manual;
    localStorage.setItem(MANUAL_KEY, JSON.stringify(map));
  } catch {
    /* 忽略写失败 */
  }
}

// ==================== 结构化结果归一化 ====================
/**
 * 把 AI 给的「总体客观评价」规整成渲染要的形状，缺字段 / 畸形一律退化成 null。
 *
 * 为什么空对象也要退化成 null：UI 要用 `verdict === null` 区分两件事 ——
 *   「这一轮根本没生成总体评价」（要说出来）vs「生成了但某个字段空」（只空那一格）。
 * 若允许 `{}` 混进来，页面会渲染成一张全空的评价卡，老板看到的还是一块没内容的版式。
 *
 * @param {unknown} v AI 返回的 verdict
 * @returns {null | {marketView:string, ourPosition:string, biggestGap:string,
 *                   priorities:Array<{action:string,why:string,measure:string}>, confidenceNote:string}}
 */
function normVerdict(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const marketView = asText(v.marketView);
  const ourPosition = asText(v.ourPosition);
  const biggestGap = asText(v.biggestGap);
  const confidenceNote = asText(v.confidenceNote);
  // priorities 三个字段全非空才算一条：缺 why / measure 的建议没法执行，也说不清怎么验收。
  const priorities = (Array.isArray(v.priorities) ? v.priorities : [])
    .map((p) => ({
      action: asText(p && p.action),
      why: asText(p && p.why),
      measure: asText(p && p.measure),
    }))
    .filter((p) => p.action && p.why && p.measure)
    .slice(0, 3);
  if (!marketView && !ourPosition && !biggestGap && !confidenceNote && priorities.length === 0) return null;
  return { marketView, ourPosition, biggestGap, priorities, confidenceNote };
}

/**
 * 把 AI 返回的任意形态规整成前端渲染所需的结构化对象。
 * @param {unknown} parsed extractJSON 的产出
 * @param {string[]} targets 本次对比的竞品名单
 * @param {string[]} dims 本次勾选的维度
 * @param {string} myName 我方企业名
 * @returns {object|null} 规整后的结果；无法解析时返回 null
 */
function normalizeResult(parsed, targets, dims, myName) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const rows = [];
  const seen = new Set();
  const rawRows = Array.isArray(parsed.rows) ? parsed.rows : [];
  for (const rr of rawRows) {
    if (!rr || typeof rr !== 'object') continue;
    const name = asText(rr.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const isUs = rr.isUs === true || (!!myName && name === myName);
    const rawCells = rr.cells && typeof rr.cells === 'object' ? rr.cells : {};
    const cells = {};
    for (const dk of dims) {
      const rc = rawCells[dk];
      const text = rc && typeof rc === 'object' ? asText(rc.text) : asText(rc);
      const ok = !isNoData(text);
      cells[dk] = {
        text: ok ? text : '',
        level: ok ? normLevel(rc && rc.level) : 'unknown',
        evidence: asText(rc && rc.evidence),
        confidence: ok ? normConfidence(rc && rc.confidence) : 'unknown',
      };
    }
    rows.push({
      name,
      isUs,
      level: normLevel(rr.level),
      cells,
      gaps: asList(rr.gaps),
      threats: asList(rr.threats),
    });
  }

  // 补齐：本次勾选的竞品即使 AI 漏了也要占一行（全空 = 诚实展示「未获取到」）
  for (const t of targets) {
    if (!seen.has(t)) {
      rows.push(emptyRow(t, dims, false));
      seen.add(t);
    }
  }
  // 我方行必须有，且排第一
  if (myName && !seen.has(myName)) {
    rows.unshift(emptyRow(myName, dims, true));
    seen.add(myName);
  }
  rows.sort((a, b) => (b.isUs ? 1 : 0) - (a.isUs ? 1 : 0));
  if (rows.length === 0) return null;

  // 雷达分值：优先用 AI 给的 scores，缺失时按 level 推导；任何无数据维度一律 0
  const scores = {};
  const rawScores = Array.isArray(parsed.scores) ? parsed.scores : [];
  for (const s of rawScores) {
    if (!s || typeof s !== 'object') continue;
    const n = asText(s.name);
    if (!n) continue;
    const ra = s.axes && typeof s.axes === 'object' ? s.axes : {};
    const axes = {};
    for (const dk of dims) {
      const v = Number(ra[dk]);
      axes[dk] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
    }
    scores[n] = axes;
  }
  for (const r of rows) {
    if (!scores[r.name]) scores[r.name] = {};
    for (const dk of dims) {
      const c = r.cells[dk];
      if (!c || !c.text) {
        scores[r.name][dk] = 0;
      } else if (scores[r.name][dk] == null) {
        scores[r.name][dk] = LEVEL_SCORE[c.level] || 0;
      }
    }
  }

  // 【2026-10-20 · 老板第 2 条】「现在啥也没有就4条 其中1条还是空的」——
  // 那一轮模型的输出里有 title 但 detail 为空的条目，旧代码只兜了 title，
  // 于是卡片渲染成「只有标题、下面一片空白」。这里把 detail 也纳入判据：
  // **写不出说明的结论不算结论**，宁可不显示。
  // 注意 detail 不套 isNoData：像「暂无价格数据，但官网显示…」这种以"暂无"开头、
  // 后面才是真正信息的句子是有效内容，用「查不到」话术去筛会把它误删。
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : [])
    .map((f) => ({
      title: asText(f && f.title),
      detail: asText(f && f.detail),
      impact: ['high', 'mid', 'low'].includes(asText(f && f.impact).toLowerCase())
        ? asText(f && f.impact).toLowerCase()
        : 'mid',
      evidence: asText(f && f.evidence),
    }))
    .filter((f) => f.title && f.detail && !isNoData(f.title));

  const opportunities = (Array.isArray(parsed.opportunities) ? parsed.opportunities : [])
    .map((o) => ({
      title: asText(o && o.title),
      action: asText(o && o.action),
      expected: asText(o && o.expected),
      effort: ['low', 'mid', 'high'].includes(asText(o && o.effort).toLowerCase())
        ? asText(o && o.effort).toLowerCase()
        : 'mid',
      basis: asText(o && o.basis),
    }))
    .filter((o) => o.title && !isNoData(o.title));

  const sources = (Array.isArray(parsed.sources) ? parsed.sources : [])
    .map((s) => ({
      title: asText(s && s.title),
      url: asText(s && s.url),
      platform: asText(s && s.platform),
    }))
    .filter((s) => s.title || s.url);

  const rawCov = parsed.coverage && typeof parsed.coverage === 'object' ? parsed.coverage : {};
  const coverage = {
    known: asList(rawCov.known),
    unknown: asList(rawCov.unknown),
  };

  const summary = isNoData(parsed.summary) ? '' : asText(parsed.summary);

  return {
    version: 2,
    summary,
    dims: dims.slice(),
    rows,
    scores,
    findings,
    opportunities,
    coverage,
    sources,
    // 总体客观评价：缺字段 / 空对象一律 null（见 normVerdict 的为什么），
    // 旧版本的落盘结果没有这个字段也走同一条路径 ⇒ 只表现为"没有评价卡"，不会抛错。
    verdict: normVerdict(parsed.verdict),
    generatedAt: Date.now(),
  };
}

/**
 * 把人工填写数据合并进结构化结果（人工数据优先级最高，标 verified）。
 * @param {object} data normalizeResult 的产出
 * @param {object} manual { [name]: { [dim]: text } }
 * @returns {object} 合并后的新对象（不修改入参）
 */
function mergeManual(data, manual) {
  if (!data) return null;
  // 数组/对象字段兜底（2026-09-21 真浏览器实测到的白屏）：
  //   结构化结果来自**持久化**的 job.result，可能是旧版本写的、或字段被裁掉的部分结果。
  //   下方多个渲染分支直接读 `view.findings.length` / `view.sources.length` 这类字段，
  //   缺一个就抛 TypeError 把**整页**打成白屏（老板报的「竞品对比不能用」就是这么来的）。
  //   在产出 `view` 的唯一入口处补齐，让「旧结果」只表现为内容少，而不是页面打不开。
  const norm = {
    ...data,
    dims: Array.isArray(data.dims) ? data.dims : [],
    rows: Array.isArray(data.rows) ? data.rows : [],
    findings: Array.isArray(data.findings) ? data.findings : [],
    opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
    scores: data.scores && typeof data.scores === 'object' ? data.scores : {},
    // verdict 同理：旧结果里没有这个字段 ⇒ null；有但被裁坏（字符串/数组/空对象）⇒ 也是 null。
    // 评价卡与「问豆芽」面板都读它，读到一个畸形对象会让整块渲染抛错。
    verdict: normVerdict(data.verdict),
  };
  if (!manual || Object.keys(manual).length === 0) return norm;
  const rows = norm.rows.map((r) => {
    const m = manual[r.name];
    if (!m) return r;
    const cells = { ...r.cells };
    let changed = false;
    for (const dk of norm.dims) {
      const v = asText(m[dk]);
      if (!v) continue;
      const prev = cells[dk] || {};
      cells[dk] = {
        text: v,
        level: prev.level && prev.level !== 'unknown' ? prev.level : 'mid',
        evidence: '人工填写',
        confidence: 'verified',
      };
      changed = true;
    }
    if (!changed) return r;
    return { ...r, cells };
  });

  const scores = {};
  for (const r of rows) {
    const prevAxes = norm.scores[r.name] || {};
    const axes = { ...prevAxes };
    for (const dk of norm.dims) {
      const c = r.cells[dk];
      if (c && c.confidence === 'verified' && (axes[dk] == null || axes[dk] === 0)) {
        // 人工数据是文本，无法打分；雷达按中位 50 计入，避免整轴塌陷
        axes[dk] = 50;
      }
    }
    scores[r.name] = axes;
  }

  return { ...norm, rows, scores };
}

/** 统计每个维度「有数据的企业数」，用于「只看有数据的」过滤 */
function countByDim(data) {
  const m = {};
  for (const dk of data.dims) {
    let n = 0;
    for (const r of data.rows) {
      const c = r.cells[dk];
      if (c && c.text) n += 1;
    }
    m[dk] = n;
  }
  return m;
}

/** 计算数据完整度：known / unknown 均为 { name, dim } 列表 */
function computeCoverage(data) {
  const known = [];
  const unknown = [];
  for (const r of data.rows) {
    for (const dk of data.dims) {
      const c = r.cells[dk];
      if (c && c.text) known.push({ name: r.name, dim: dk });
      else unknown.push({ name: r.name, dim: dk });
    }
  }
  const total = known.length + unknown.length;
  const percent = total === 0 ? 0 : Math.round((known.length / total) * 100);
  return { known, unknown, percent };
}

/** 结构化结果 → Markdown（保存资产 / 跨模块联动摘要 / 解析失败时的兜底展示） */
function toMarkdown(data, source) {
  // 入口兜底（2026-09-21）：本函数有两个调用方，其中 `resultText()` 传的是**未归一化**的
  // 持久化 job.result（可能是旧版本写的、缺 findings/sources 等字段）。这里缺一个数组就会抛
  // TypeError 打断「保存资产 / 联动摘要」。与 mergeManual 同一套默认值，两处都兜住。
  if (!data || typeof data !== 'object') return '';
  data = {
    ...data,
    dims: Array.isArray(data.dims) ? data.dims : [],
    rows: Array.isArray(data.rows) ? data.rows : [],
    findings: Array.isArray(data.findings) ? data.findings : [],
    opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
    // 与 mergeManual 同一套默认值；verdict 这里不参与导出（toMarkdown 不写它），
    // 只保证旧结果读进来时形状一致 —— 谁将来要在导出里加评价，直接从规范对象取。
    verdict: normVerdict(data.verdict),
  };
  const lines = [];
  lines.push('# 竞品对比分析');
  if (source) lines.push('> 📌 数据来源：' + source);
  // 【0.21.9 · M3 硬约束】这里**刻意不输出** data.scores（雷达分值）。
  // 原因：那是 85/60/35 的标签换算值 + 50 的中位占位，没有真实数据源；
  // 一旦写进 Markdown，它就会经 saveAsset → 企业资产 / deliverables.json / 汇报摘要流出去，
  // 被当成量化结论。导出只带矩阵里的事实（text / evidence / 完整度）。
  // ⚠️ 后人若要加回分数，先给它一个真实数据源（实测指标），否则等于新的假绿。
  if (data.summary) {
    lines.push('');
    lines.push(data.summary);
  }

  const dims = data.dims.filter((dk) => DIMENSION_LABEL[dk]);
  const filled = dims.filter((dk) => data.rows.some((r) => r.cells[dk] && r.cells[dk].text));
  if (filled.length) {
    lines.push('');
    lines.push('## 一、维度对比矩阵');
    lines.push('| 维度 | ' + data.rows.map((r) => r.name).join(' | ') + ' |');
    lines.push('| --- | ' + data.rows.map(() => '---').join(' | ') + ' |');
    for (const dk of filled) {
      const cells = data.rows.map((r) => {
        const c = r.cells[dk];
        if (!c || !c.text) return '—'; // 0.21.11 第 2 条：导出也别印一串「未获取到」，空格子用「—」
        const tag = LEVEL_TEXT[c.level] && c.level !== 'unknown' ? '【' + LEVEL_TEXT[c.level] + '】' : '';
        return tag + c.text.replace(/\|/g, '/');
      });
      lines.push('| ' + DIMENSION_LABEL[dk] + ' | ' + cells.join(' | ') + ' |');
    }
  }

  if (data.findings.length) {
    lines.push('');
    lines.push('## 二、关键发现');
    for (const f of data.findings) {
      lines.push('- **' + f.title + '**［' + (IMPACT_TEXT[f.impact] || '影响中') + '］：' + f.detail);
      if (f.evidence) lines.push('  - 依据：' + f.evidence);
    }
  }

  if (data.opportunities.length) {
    lines.push('');
    lines.push('## 三、机会点');
    for (const o of data.opportunities) {
      lines.push('- **' + o.title + '**：' + [o.action, o.expected ? '预期：' + o.expected : '', o.basis ? '依据：' + o.basis : ''].filter(Boolean).join('　'));
      lines.push('  - 投入：' + (EFFORT_TEXT[o.effort] || '投入中'));
    }
  }

  const cov = computeCoverage(data);
  lines.push('');
  lines.push('## 四、数据完整度');
  lines.push('已获取 ' + cov.known.length + ' 项，待补充 ' + cov.unknown.length + ' 项（完整度 ' + cov.percent + '%）。');
  if (cov.unknown.length) {
    lines.push('待补充：' + cov.unknown.slice(0, 30).map((u) => u.name + '·' + DIMENSION_LABEL[u.dim]).join('、'));
  }

  if (data.sources.length) {
    lines.push('');
    lines.push('## 五、参考来源');
    for (const s of data.sources) {
      lines.push('- ' + (s.url ? '[' + (s.title || s.url) + '](' + s.url + ')' : s.title) + (s.platform ? ' · ' + s.platform : ''));
    }
  }
  return lines.join('\n');
}

// ==================== 手写内联 SVG 雷达图（不引入任何图表依赖） ====================
/**
 * 能力雷达图。
 * @param {{dims: string[], series: Array<{name:string,color:string,values:number[],isUs:boolean}>}} props
 */
function RadarChart({ dims, series }) {
  const n = dims.length;
  if (n < 3) {
    return (
      <div className="comp-radar-empty">
        可用于对比的维度不足 3 个（当前 {n} 个有数据），无法绘制雷达图。请补充数据或勾选更多维度后重新生成。
      </div>
    );
  }
  const W = 360;
  const H = 320;
  const cx = 180;
  const cy = 160;
  const R = 100;

  const angleOf = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pointAt = (i, v) => {
    const ratio = Math.max(0, Math.min(100, Number(v) || 0)) / 100;
    const r = ratio * R;
    return [cx + r * Math.cos(angleOf(i)), cy + r * Math.sin(angleOf(i))];
  };
  const ringPoints = (ratio) => {
    const arr = [];
    for (let i = 0; i < n; i += 1) {
      arr.push(pointAt(i, ratio * 100).join(','));
    }
    return arr.join(' ');
  };

  return (
    <div className="comp-radar">
      <svg width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label="竞品能力雷达图">
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <polygon
            key={'ring-' + ratio}
            points={ringPoints(ratio)}
            fill="none"
            style={{ stroke: 'var(--c-border)' }}
            strokeWidth="1"
          />
        ))}
        {dims.map((dk, i) => {
          const [x, y] = pointAt(i, 100);
          return <line key={'axis-' + dk} x1={cx} y1={cy} x2={x} y2={y} style={{ stroke: 'var(--c-border)' }} strokeWidth="1" />;
        })}
        {dims.map((dk, i) => {
          const [x, y] = pointAt(i, 100 + 20);
          const cos = Math.cos(angleOf(i));
          const anchor = cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle';
          return (
            <text
              key={'label-' + dk}
              x={x}
              y={y + 4}
              textAnchor={anchor}
              fontSize="11.5"
              style={{ fill: 'var(--c-text-2)' }}
            >
              {DIMENSION_LABEL[dk] || dk}
            </text>
          );
        })}
        {series.map((s) => {
          const pts = s.values.map((v, i) => pointAt(i, v).join(',')).join(' ');
          return (
            <g key={'series-' + s.name}>
              <polygon points={pts} fill={s.color} fillOpacity="0.12" stroke={s.color} strokeWidth={s.isUs ? 2.4 : 1.6} />
              {s.values.map((v, i) => {
                const [x, y] = pointAt(i, v);
                return <circle key={'dot-' + s.name + '-' + i} cx={x} cy={y} r={s.isUs ? 3.2 : 2.4} fill={s.color} />;
              })}
            </g>
          );
        })}
        <text x={cx} y={cy - R - 10} textAnchor="middle" fontSize="10.5" style={{ fill: 'var(--c-text-3)' }}>
          100
        </text>
      </svg>
      <div className="comp-radar-legend">
        {series.map((s) => (
          <span className="comp-radar-legend-item" key={'lg-' + s.name}>
            <span className="comp-radar-dot" style={{ background: s.color }} />
            {s.name}
            {s.isUs ? '（我方）' : ''}
          </span>
        ))}
      </div>
      {/* 文案卡在 70 字以内：unit-say-limit 的 G1 对**单个 JSX 文本节点**设了 70 字上限，
          第一版写了 73 字（"- 73 字"），门禁当场红。把换算细节留给 tooltip，正文只留结论。 */}
      <div className="comp-radar-note" data-radar-illustrative="1" title="强/中/弱 → 85/60/35；人工填写按 50 计；无数据按 0 计">
        <b>示意，非实测</b>：标签换算分值，人工填写按中位计。<b>不是量化结论</b>，不随导出/汇报外发。
      </div>
    </div>
  );
}

/**
 * 对比矩阵里的单个单元格。
 * @param {{row:object, dimKey:string, onFill:Function}} props
 */
function MatrixCell({ row, dimKey, onFill }) {
  const c = row.cells[dimKey];
  if (!c || !c.text) {
    // 【0.21.11 · 老板第 2 条】原话：「竞品分析里面还是一大堆未获取到」。
    // 旧版每个空格子都印一行「—　未获取到」，一屏几十个，读起来像系统在反复解释自己查不到什么。
    // 现在格子里只留一个「—」（hover 才说明原因），「补」入口原地保留（能力没减）。
    // 空了多少格由矩阵表头那句汇总一次性说清（见下方 ① 的 comp-matrix-cov 行）。
    return (
      <div className="comp-cell comp-cell-empty" title="这一格还没数据，点「补」可以手动录入">
        <span className="comp-nodata" aria-label="暂无数据">—</span>
        <Button
          type="link"
          size="small"
          className="comp-fill-btn"
          onClick={() => onFill([{ name: row.name, dim: dimKey }])}
        >
          补
        </Button>
      </div>
    );
  }
  const body = (
    <span className="comp-cell-text">{c.text}</span>
  );
  return (
    <div className="comp-cell">
      {c.level !== 'unknown' && (
        <Tag color={levelColor(c.level, row.isUs)} className="comp-level">
          {LEVEL_TEXT[c.level]}
        </Tag>
      )}
      {c.evidence ? <Tooltip title={'依据：' + c.evidence}>{body}</Tooltip> : body}
      {c.confidence === 'verified' && <span className="comp-conf">人工</span>}
      {c.confidence === 'estimated' && <span className="comp-conf comp-conf-est">估算</span>}
      <Button
        type="link"
        size="small"
        className="comp-fill-btn"
        onClick={() => onFill([{ name: row.name, dim: dimKey }])}
      >
        补
      </Button>
    </div>
  );
}

// ==================== 豆芽建议方案（纯前端，复用 AI 已产出的「关键发现 + 机会点」，不额外调模型） ====================
/** 根据机会点/发现文本推断建议的生成动作（三选一），不依赖 AI。 */
function classifyPlanAction(text) {
  const t = String(text || '');
  if (/活动|沙龙|研讨|会|展|义诊|节|大赛|直播|公开课|培训|招募|招商/.test(t)) return '活动策划';
  if (/防守|应对|反驳|信任|口碑|危机|质疑|辟谣|正名|洗白|背书|控评/.test(t)) return '防守内容';
  return '营销文案';
}

/** 把 AI 已产出的 findings + opportunities 组织成 2~3 张可点选方案卡片。 */
function buildDouyaPlans(findings, opportunities) {
  const opps = Array.isArray(opportunities) ? opportunities : [];
  if (opps.length === 0) return [];
  const finds = Array.isArray(findings) ? findings : [];
  return opps.slice(0, 3).map((o, i) => {
    // 选一条与机会点最相关（标题/依据有文字重叠）的关键发现作为理由支撑，否则取第一条
    let related = null;
    if (finds.length) {
      const hay = String(o.title || '') + ' ' + String(o.basis || '');
      related = finds.find((f) => f && f.title && hay.includes(f.title.slice(0, 4))) || finds[0];
    }
    const reasonParts = [];
    if (related && related.title) {
      reasonParts.push('关键发现：「' + related.title + (related.detail ? '」——' + related.detail : '」'));
    }
    if (o.basis) reasonParts.push('机会依据：' + o.basis);
    const reason = reasonParts.filter(Boolean).join('。') || (o.action || o.title);
    const action = classifyPlanAction((o.title || '') + ' ' + (o.action || '') + ' ' + (o.basis || ''));
    return {
      id: 'plan-' + i,
      title: o.title || ('方案 ' + (i + 1)),
      reason,
      action,
    };
  });
}

/** 方案动作 → 目标模块 + 跨模块联动 localStorage key（复用现有「据此生成活动/文案」机制）。 */
const PLAN_ROUTE = {
  活动策划: { module: 'huodong', key: 'douya-competitor-to-activity', goal: '基于竞品对比结论（关键发现/机会点），策划差异化活动方案' },
  营销文案: { module: 'xinmeiti', key: 'douya-competitor-to-wenan', goal: '基于竞品对比结论（关键发现/机会点），策划差异化营销文案' },
  防守内容: { module: 'xinmeiti', key: 'douya-competitor-to-wenan', goal: '基于竞品对比结论（关键发现/机会点），策划防守型内容（回应竞品打法、强化我方信任）' },
};

/**
 * @param {object} props
 * @param {(target:string)=>void} [props.onSelectModule] 跨模块跳转（保持既有调用兼容）
 * @param {boolean} [props.embedded=false] 内嵌模式：隐藏独立页头，供经营诊断维度卡片展开时内嵌
 */
export default function CompetitorAnalysis({ onSelectModule, embedded = false }) {
  const { asset, hasAsset, updateField } = useMarketingAsset();
  const { currentCompany, currentProject } = useCompany();
  const { addAsset } = useAssets();
  const { getKnowledge, getBrain } = useCompanyKnowledge();
  const { createDirection, activateDirection } = useDirection();

  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';
  const companyId = currentCompany ? currentCompany.id : '';

  // 自家品牌护栏（2026-09-21）：本企业自有品牌 / 旗下 IP（母公司 + profile.brandIps + 别名）。
  // 必须定义在最前面 —— 竞品名单、AI 推荐竞品、对比矩阵三处都要用它（selfBrands 上移到最前）。
  const selfBrands = useMemo(
    () => collectSelfBrandNames({ company: currentCompany, asset, knowledge: getKnowledge(companyId) }),
    [currentCompany, asset, getKnowledge, companyId],
  );

  // 深度思考 brain：竞品推荐就位的数据源（只读，不自动覆盖用户已填竞品）
  const brain = useMemo(() => getBrain(companyId), [getBrain, companyId]);
  const brainValid = useMemo(() => hasBrain(brain), [brain]);
  // 2026-09-21：AI 推荐竞品也必须过自家品牌护栏 —— 这里点「一键采用全部」会把名字写进
  // asset.competitors，一旦子品牌（上游货源）混进来就会直接变成对比矩阵的一行。
  const aiRecommendationsRaw = useMemo(() => (brainValid ? brain.competitors : []), [brainValid, brain]);
  const aiRecoSelfFilter = useMemo(() => {
    const kept = [];
    const dropped = [];
    for (const c of aiRecommendationsRaw) {
      const nm = c && c.name ? String(c.name) : "";
      if (nm && isSelfBrand(nm, selfBrands)) dropped.push(nm);
      else kept.push(c);
    }
    return { kept, dropped };
  }, [aiRecommendationsRaw, selfBrands]);
  const aiRecommendations = aiRecoSelfFilter.kept;
  const aiRecoDropped = aiRecoSelfFilter.dropped;
  const aiReasons = useMemo(() => competitorReasons(brain), [brain]);
  const [newName, setNewName] = useState('');
  const [dims, setDims] = useState(() => defaultDimsForType(companyType));
  const [selected, setSelected] = useState(null); // null = 全部竞品
  const [savedName, setSavedName] = useState('');
  const [manual, setManual] = useState({}); // { [竞品名]: { [维度key]: 人工填写的硬数据 } }
  const [dimFilter, setDimFilter] = useState('filled'); // filled = 只看有数据的
  const [fillOpen, setFillOpen] = useState(false);
  const [fillTargets, setFillTargets] = useState([]);
  const [fillDraft, setFillDraft] = useState({});
  const [aiPicked, setAiPicked] = useState([]); // AI 推荐竞品中已勾选的名字（逐个勾选后采用）
  // —— 老板第 5 条「AI 挑好 → 人打钩 → 才落库」的候选面板状态 ——
  // pickOpen：折叠状态记忆到 localStorage（老板要它常驻，但页面本来就长，允许收起）。
  const [pickOpen, setPickOpen] = useState(() => {
    try { return localStorage.getItem('douya-comp-pick-open') !== '0'; } catch { return true; }
  });
  const [pickChecked, setPickChecked] = useState(() => new Set()); // 已勾选的候选 id（归一化名）
  // 「按企业资产库重挑」：输入没变时 useMemo 不会重算，用 nonce 强制走一遍并重置勾选。
  const [pickNonce, setPickNonce] = useState(0);

  const jobKey = `competitor-${currentCompany ? currentCompany.id : 'x'}`;
  const job = useBackgroundJob(jobKey);
  const busy = !!(jobKey && job.busy);
  const result = jobKey ? job.result : '';
  const error = jobKey ? job.error : '';
  const [formError, setFormError] = useState('');
  const shownError = error || formError;

  // 2026-09-21：竞品名单本体也要过护栏 —— asset.competitors 里可能**早就**被污染
  //（上游 deepThink 竞品发现曾把子品牌当候选，用户一键采用后写进来）。
  // 不过滤的话，generate() 的 targets 会带着自家品牌去对比，等于把错误又生产一遍。
  const competitorsRaw = useMemo(() => asList(asset.competitors), [asset]);
  const competitorsFilter = useMemo(
    () => excludeSelfBrands(competitorsRaw, selfBrands),
    [competitorsRaw, selfBrands],
  );
  const competitors = competitorsFilter.kept;
  const assetSelfDropped = competitorsFilter.dropped.map((d) => d.name);

  /**
   * 【老板第 5 条】AI 候选（常驻面板的数据源）。
   *
   * 与旧实现的**本质区别**：旧实现只在「名单为空」时把 brain.competitors 自动**写库**，
   * 于是名单一旦有错（老板库里就有），页面永远不再给候选 —— 这就是「AI 不会自动帮我挑」。
   * 现在无论名单是否为空都算候选（常驻面板可见），但**只勾选、不写库**，写库必须点确认。
   *
   * keyword 取「手动添加」输入框里正在敲的内容：用户敲了词，就该在候选里看到它，
   * 而不是敲完点添加才发现它被当成竞品了（这条也让「用户输入的关键词」这一来源有真实出口）。
   */
  const pick = useMemo(
    () => buildCompetitorCandidates({
      asset, brain, keyword: newName, selfBrands,
    }),
    // pickNonce 只用于「重新挑」时强制重算，本身不参与计算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asset, brain, newName, selfBrands, pickNonce],
  );
  const pickCandidates = pick.candidates;
  const pickEmptyReason = pick.emptyReason;

  const myName = String(asset.companyName || '').trim();
  const myProfile = String(asset.profile || '').trim();
  const myProducts = String(asset.products || '').trim();
  const mySelling = asList(asset.coreSellingPoints).join('、');
  const myAudience = asList(asset.targetCustomers).join('、');
  const myIndustry = String(asset.industry || '').trim();

  // 结构化结果（老的字符串结果自动降级为 Markdown 渲染）
  const structured = useMemo(
    () => (result && typeof result === 'object' && !Array.isArray(result) ? result : null),
    [result],
  );
  // 人工数据实时叠加，补完立刻反映到表格/雷达/完整度，无需重新生成
  const merged = useMemo(() => (structured ? mergeManual(structured, manual) : null), [structured, manual]);
  const selfRowFilter = useMemo(() => filterSelfBrandRows(merged, selfBrands), [merged, selfBrands]);
  const view = selfRowFilter.view;
  const droppedSelfRows = selfRowFilter.dropped;

  /**
   * 【2026-10-20 · 老板第 2 条 · 渲染期兜底】关键发现显示前再滤一次「有标题没说明」的条目。
   *
   * 为什么解析期（normalizeResult:363）已经滤过，这里还要再滤一遍：
   *   解析期只作用于**这一轮新生成**的结果，而 `job.result` 是**落盘持久化**的
   *   （backgroundJobs.js:persist → localStorage `douya-background-jobs`）。
   *   老板报的那份"4 条里 1 条是空的"报告是**升级前**生成的，它躺在 localStorage 里，
   *   打开页面时走的是恢复路径、**不经过** normalizeResult ⇒ 只在解析期过滤，
   *   老板升级后重新打开那份旧报告，空条目还在，会当场认为"你说修了其实没修"。
   *
   * 判据与解析期一致（title 和 detail 都非空），但**不复用 isNoData 滤 title**：
   * 解析期那样做是为了把"暂无数据"这类话术挡在新结果之外；旧结果里已有的内容
   * 只要标题有实义就不该被一句「暂无」误删（宁可少滤，不可错删）。
   */
  const shownFindings = useMemo(() => {
    if (!view || !Array.isArray(view.findings)) return [];
    return view.findings.filter((f) => asText(f && f.title) && asText(f && f.detail));
  }, [view]);

  const cov = useMemo(() => (view ? computeCoverage(view) : { known: [], unknown: [], percent: 0 }), [view]);
  const dimCount = useMemo(() => (view ? countByDim(view) : {}), [view]);
  const visibleDims = useMemo(() => {
    if (!view) return [];
    const base = view.dims.filter((dk) => DIMENSION_LABEL[dk]);
    if (dimFilter === 'all') return base;
    return base.filter((dk) => (dimCount[dk] || 0) > 0);
  }, [view, dimFilter, dimCount]);

  const radarSeries = useMemo(() => {
    if (!view || visibleDims.length === 0) return [];
    const rows = view.rows.slice().sort((a, b) => (b.isUs ? 1 : 0) - (a.isUs ? 1 : 0)).slice(0, 6);
    // 绿色（下标 0）留给我方，竞品只用其余配色
    const others = SERIES_COLORS.slice(1);
    let ci = 0;
    return rows.map((r) => ({
      name: r.name,
      isUs: !!r.isUs,
      color: r.isUs ? '#30d158' : (others[ci++ % others.length] || '#ff9f0a'),
      values: visibleDims.map((dk) => {
        const s = view.scores[r.name] || {};
        const v = Number(s[dk]);
        return Number.isFinite(v) ? v : 0;
      }),
    }));
  }, [view, visibleDims]);

  // 豆芽建议方案：把 AI 已产出的「关键发现 + 机会点」组织成可点选卡片（不额外调模型）
  // 用 shownFindings 而不是 view.findings：空说明的条目不该变成一张方案卡（与渲染同源）。
  const douyaPlans = useMemo(
    () => (view ? buildDouyaPlans(shownFindings, view.opportunities) : []),
    [view, shownFindings],
  );

  /**
   * 【2026-10-20 · 老板第 2 条】「问豆芽」面板的注入元信息。
   *
   * 这份 meta 决定了面板"能看见什么"：竞品名单取**矩阵里真实渲染出来的那几家**
   * （不是 asset.competitors —— 名单可能刚改过、这一轮根本没跑它们），
   * 维度取**这份结果自己的 view.dims**（不是当前勾选），否则问「价格带」时
   * prompt 里可能根本没有价格带这一列。webLanded 用本轮实检结论，
   * 让模型知道能不能说"这是查到的"。
   */
  const advisorMeta = useMemo(() => {
    if (!view) return { companyName: myName, competitors: [], dims: [], webLanded: false };
    const sc = view.searchCoverage;
    const webLanded = !!(sc && typeof sc === 'object' && sc.grounded === true)
      || /联网检索/.test(String(view.source || ''));
    const names = (Array.isArray(view.rows) ? view.rows : [])
      .filter((r) => r && !r.isUs)
      .map((r) => String(r.name || '').trim())
      .filter(Boolean);
    const dimKeys = Array.isArray(view.dims) && view.dims.length ? view.dims : dims;
    return {
      companyName: myName,
      competitors: names,
      dims: DIMENSIONS.filter((d) => dimKeys.includes(d.key)),
      webLanded,
    };
  }, [view, myName, dims]);

  /**
   * 「问豆芽」的 AI 上下文：与本文件 generate() 用的是**同一个来源**（buildAIContext），
   * 不另造一套 —— 两套口径会让"报告里说 A、对话里说 B"。
   *
   * 为什么传成函数而不是先算好：它只在用户真的按下发送时才需要；更重要的是
   * 构建失败必须落在面板的错误气泡里，而不是在渲染期抛出去把整页打成白屏。
   */
  function buildAdvisorCtx() {
    return buildAIContext({
      company: currentCompany,
      asset,
      knowledge: getKnowledge(companyId),
      project: currentProject,
    });
  }

  // 切换企业类型时，重置为对应类型的默认对比维度
  useEffect(() => {
    setDims(defaultDimsForType(companyType));
  }, [companyType]);

  // 切换企业时，读回该企业的人工填写数据
  useEffect(() => {
    setManual(readManual(companyId));
    setAiPicked([]);
  }, [companyId]);

  // 人工数据变化即持久化（独立于 asset，避免触碰 marketingStore 的字段白名单）
  useEffect(() => {
    if (companyId) writeManual(companyId, manual);
  }, [companyId, manual]);

  // 【2026-10-10 老板第 4 条 → 2026-10-19 老板第 5 条改写】
  //   旧行为：名单为空时，进页面**自动把 brain.competitors 写进 asset.competitors**。
  //   问题（老板原话「首先 AI 不会自动帮我挑好竞品」）：
  //     ① 只在名单为空时触发 —— 名单一旦有错（老板库里就是错的），就再也不会给出候选；
  //     ② 写库没有人工确认 —— 用户连"AI 挑了哪几家"都没看见，表就已经被填了。
  //   新行为：**只预勾选、不写库**（M5.4）。落库唯一入口是面板上的「确认，用这些对比」。
  //   ref 保留：每次挂载只自动勾一次，之后用户取消勾选不会被再次覆盖。
  const autoAdoptRef = useRef(false);
  useEffect(() => {
    if (autoAdoptRef.current) return;
    if (pickCandidates.length === 0) return;
    autoAdoptRef.current = true;
    setPickChecked(new Set(pickCandidates.map((c) => c.id)));
  }, [pickCandidates]);

  // 【2026-10-10 老板第 4 条 · 其二】「全部让 AI 完成」：
  //   名单已被上面自动挑好后，这里**直接替用户跑一次对比**，打开经营诊断就能看到详细对比，
  //   不用再自己点「生成对比报告」。老板原话：「最重要的是竞品对比，还要自己输入竞品 —— 全部让 AI 完成。」
  //   安全边界：仅 embedded（经营诊断内嵌）时生效 —— 独立页保持「用户点按钮才跑」的老行为；
  //             已有历史结果(view) 或正在跑(busy) 时不动；每次挂载最多自动跑一次。
  const autoGenRef = useRef(false);
  useEffect(() => {
    if (!embedded) return;
    if (autoGenRef.current) return;
    if (busy || view) return;
    if (competitors.length === 0 || dims.length === 0) return;
    autoGenRef.current = true;
    generate().catch(() => { /* startJob 内部已兜住；这里保证不冒泡成未捕获异常 */ });
  }, [embedded, busy, view, competitors, dims]);

  function toggleDim(key) {
    setDims((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function setManualValue(competitor, dimKey, value) {
    setManual((prev) => {
      const next = { ...prev };
      const entry = { ...(next[competitor] || {}) };
      const v = String(value || '');
      if (v.trim()) entry[dimKey] = v;
      else delete entry[dimKey];
      if (Object.keys(entry).length) next[competitor] = entry;
      else delete next[competitor];
      return next;
    });
  }

  function addCompetitor() {
    const name = newName.trim();
    if (!name) return;
    // 2026-09-21：自家品牌 / 旗下 IP 不能当竞品 —— 明说理由而不是默默接受。
    // （老板原话：「上游货源是康健苗苗下面的 上面都说了 还会把上游货源做成竞品」。）
    if (isSelfBrand(name, selfBrands)) {
      setFormError('「' + name + '」属于本企业自有品牌 / 旗下 IP，不能作为竞品。'
        + '如果你指的是同名的其它公司，请在名称里加上区分词（如所在城市）。');
      return;
    }
    const next = competitors.includes(name) ? competitors : [...competitors, name];
    updateField('competitors', next);
    setNewName('');
  }

  function removeCompetitor(name) {
    updateField('competitors', competitors.filter((c) => c !== name));
    if (selected === name) setSelected(null);
  }

  function toggleSelect(name) {
    setSelected((prev) => (prev === name ? null : name));
  }

  // —— AI 推荐竞品空态：逐个勾选 ——
  function toggleAiPick(name) {
    setAiPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  // 一键采用全部推荐竞品（把竞品名写入 asset.competitors，不覆盖已填——仅在空态出现）
  function adoptAllAi() {
    // 2026-09-21 双保险：即使 brain.competitors 里混进了自家品牌，也不许写进竞品名单。
    const names = competitorsToAsset(brain).filter((n) => n && !isSelfBrand(n, selfBrands));
    if (names.length === 0) return;
    updateField('competitors', names);
  }

  // 采用已勾选的推荐竞品
  // ⚠️ 2026-10-19（老板第 5 条 5.4）：本函数与 adoptAllAi / toggleAiPick 是**老路径**，
  //   保留是为了不打断既有测试与回滚；页面上已不再提供「自动写库」入口 ——
  //   写库唯一入口是候选面板的「确认，用这些对比」，也就是老板要的「人打钩才落库」。
  function adoptSelectedAi() {
    const names = aiPicked.filter((n) => n && !isSelfBrand(n, selfBrands));
    if (names.length === 0) return;
    updateField('competitors', names);
  }

  // —— 老板第 5 条：候选面板的交互 ——
  function togglePickOpen(next) {
    const v = typeof next === 'boolean' ? next : !pickOpen;
    setPickOpen(v);
    try { localStorage.setItem('douya-comp-pick-open', v ? '1' : '0'); } catch { /* 忽略写失败 */ }
  }

  function togglePick(id) {
    setPickChecked((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }

  function pickAll(checkAll) {
    setPickChecked(checkAll ? new Set(pickCandidates.map((c) => c.id)) : new Set());
  }

  /** 「按企业资产库重挑」：nonce+1 强制重算，并把勾选恢复成默认（全勾）。 */
  function repick() {
    setPickNonce((n) => n + 1);
    setPickChecked(new Set(pickCandidates.map((c) => c.id)));
  }

  /**
   * 「确认，用这些对比」—— **唯一**把候选写进 asset.competitors 的入口。
   *
   * 先把勾选的名字交给 generate() 作为本次对比的 targets：updateField 是异步落 store 的，
   * 若只依赖 state 更新，generate 里读到的还是旧名单（会拿着旧竞品去跑）——
   * 这正是"用户勾了 5 家，实际只对比了 3 家"这类不可复现问题的来源。
   */
  function confirmPick() {
    const names = pickCandidates.filter((c) => pickChecked.has(c.id)).map((c) => c.name);
    if (names.length === 0) {
      setFormError('请至少勾选一个竞品，再点「确认，用这些对比」。');
      return;
    }
    setFormError('');
    updateField('competitors', names);
    setSelected(null);
    generate(names).catch(() => { /* startJob 内部已兜住，这里只保证不冒泡成未捕获异常 */ });
  }

  function openFill(targets) {
    const list = (targets || []).slice(0, MAX_FILL_TARGETS);
    if (list.length === 0) return;
    setFillTargets(list);
    const draft = {};
    for (const t of list) {
      draft[t.name + '||' + t.dim] = ((manual[t.name] || {})[t.dim]) || '';
    }
    setFillDraft(draft);
    setFillOpen(true);
  }

  function saveFill() {
    setManual((prev) => {
      const next = { ...prev };
      for (const t of fillTargets) {
        const key = t.name + '||' + t.dim;
        const v = String(fillDraft[key] || '').trim();
        const entry = { ...(next[t.name] || {}) };
        if (v) entry[t.dim] = v;
        else delete entry[t.dim];
        if (Object.keys(entry).length) next[t.name] = entry;
        else delete next[t.name];
      }
      return next;
    });
    setFillOpen(false);
  }

  function buildPrompt(targets, monitor) {
    const dimText = dims.map((k) => DIMENSION_LABEL[k]).join(' / ');
    const dimKeys = dims.join(', ');
    const lines = [];
    lines.push('【我方企业】');
    lines.push('- 名称：' + (myName || '（未填写）'));
    if (myIndustry) lines.push('- 行业：' + myIndustry);
    if (myProfile) lines.push('- 定位：' + myProfile);
    if (myProducts) lines.push('- 主推产品/项目：' + myProducts);
    if (mySelling) lines.push('- 核心卖点：' + mySelling);
    if (myAudience) lines.push('- 目标客户：' + myAudience);
    lines.push('');
    lines.push('【对比竞品】（共 ' + targets.length + ' 家）：' + targets.join('、'));
    lines.push('');
    lines.push('【对比维度】' + dimText + '（维度 key：' + dimKeys + '）');
    lines.push('');
    lines.push('请作为口腔行业竞争情报分析师，联网检索竞品公开信息。只返回一个 JSON 对象，不要输出任何解释、不要 markdown 代码围栏。JSON 必须严格符合以下 schema：');
    lines.push('{');
    lines.push('  "summary": "一句话总览（不超过 60 字；没有实质结论就写空字符串）",');
    lines.push('  "rows": [{');
    lines.push('    "name": "企业名（我方写「' + (myName || '我方') + '」）",');
    lines.push('    "isUs": true,');
    lines.push('    "level": "strong|mid|weak|unknown",');
    lines.push('    "cells": { "position": { "text": "事实描述，40 字内", "level": "strong|mid|weak|unknown", "evidence": "平台名或链接，没有就写空字符串", "confidence": "estimated|unknown" } },');
    lines.push('    "gaps": ["我方相对该竞品的差距"],');
    lines.push('    "threats": ["该竞品对我们的威胁"]');
    lines.push('  }],');
    lines.push('  "scores": [{ "name": "企业名", "axes": { "position": 0 } }],');
    lines.push('  "findings": [{ "title": "结论", "detail": "说明", "impact": "high|mid|low", "evidence": "平台名或链接" }],');
    lines.push('  "opportunities": [{ "title": "机会点", "action": "具体动作", "expected": "预期效果", "effort": "low|mid|high", "basis": "依据" }],');
    lines.push('  "coverage": { "known": ["企业名｜维度名"], "unknown": ["企业名｜维度名"] },');
    lines.push('  "sources": [{ "title": "标题", "url": "https://...", "platform": "平台名" }],');
    lines.push('  "verdict": {');
    lines.push('    "marketView": "市场格局：这个细分市场现在是什么局面，谁在用什么打法（60 字内，只写有依据的）",');
    lines.push('    "ourPosition": "我方位置：我方真正值钱的差异是什么（60 字内）",');
    lines.push('    "biggestGap": "最大短板：最影响客户选择的那一个差距（60 字内）",');
    lines.push('    "priorities": [{ "action": "最该先做的一件事", "why": "为什么是它", "measure": "怎么衡量做到没" }],');
    lines.push('    "confidenceNote": "本轮证据强度：实检到 N 家 / 其余为模型推断"');
    lines.push('  }');
    lines.push('}');
    lines.push('');
    lines.push('数据可信度硬约束（违反即视为无效输出）：');
    lines.push('1. cells 的 key 只能是这些维度 key：' + dimKeys + '，不要多写也不要少写；');
    lines.push('2. 每个 cell 能核实到就写 text（写事实，不写评价，40 字内）；核实不到就把 text 写成空字符串 ""、confidence 写 "unknown"。严禁编造任何数字，严禁写「暂无数据」以外的推测性占位；');
    lines.push('3. level 表示该维度上这家企业的相对强弱：strong / mid / weak；无数据写 unknown；');
    lines.push('4. evidence 必须带平台名或 URL，没有就写空字符串；findings 里没有 evidence 的结论不要写，宁可少写；');
    lines.push('5. scores.axes 用 0-100 的整数给各维度打分，无数据维度写 0；');
    // 【0.21.9 · M2】原来这一条写的是「findings 至少 3 条、opportunities 至少 3 条」，
    // 与上一条「没有 evidence 的结论不要写，宁可少写」**直接冲突**。
    // 两句冲突时模型必然服从"至少 3 条" ⇒ 每次关键发现/机会点都刚好整齐 3 条且高度通用。
    // 【2026-10-20 · 老板第 2 条】原第 6 条只写「有几条写几条，0 条也允许」——
    // 为了防凑数，结果模型真的只写了 4 条，其中 1 条 detail 还空着。老板原话：
    // 「现在啥也没有就4条 其中1条还是空的，这个对比没有任何价值」。
    // 现在改成「按维度覆盖来定量」：给出可执行区间 + 逐条字段完整性要求，
    // 同时把「不许为凑数写通用套话」原样留着 —— 防编造是底线，不能为了让内容变多而删。
    lines.push('6. findings **覆盖到几个维度就写几条，通常 6-8 条**（每个勾选的维度至少给一条有依据的结论）；'
      + '每一条的 title 和 detail 都必须非空，写不出 detail 的不要写进来。'
      + 'opportunities 同样有几条写几条。一条依据都没有就写空数组 []（0 条是允许且正确的结果）。'
      + '严禁为了凑数量而写通用套话：宁可少一条，也不要写一句放之四海皆准的空话。');
    lines.push('7. coverage.unknown 必须诚实列出所有没拿到的「企业 × 维度」，不得隐瞒；');
    lines.push('8. rows 必须包含我方一行，isUs 写 true，name 写「' + (myName || '我方') + '」；其余每行对应一个竞品。');
    // 【2026-10-20 · 老板第 2 条】verdict 的两条硬约束。
    // 为什么必须写「不许出现新数字」：这一块是**结论区**，模型在这里最容易"顺手补一个市场份额"，
    // 而它上面的矩阵是有出处的、它没有 —— 一混，整页的可信度就没了。
    lines.push('9. verdict 是**总体客观评价**，每个字段只能基于同一次输出里的 rows / findings 事实：'
      + '不许出现 rows / findings 之外的新事实、新数字（不得写市场份额、销量、评分这类没有出处的数）。'
      + '拿不出依据时 verdict 整段写 null（不是空对象 {}，也不是空字符串）—— null 表示「本轮没生成」，页面要靠它区分。');
    lines.push('10. verdict.priorities **恰好 3 条**，按优先级从高到低排序；每条 action / why / measure 三个字段都必须非空'
      + '（measure 要能被验证，例如「官网 3 个产品页补齐价格与适用范围」，而不是「提升品牌力」）。'
      + 'verdict 里的 marketView / ourPosition / biggestGap 各 60 字内。');
    if (monitor && monitor.length) {
      lines.push('');
      lines.push('【后端实抓·竞品真实动态】（搜索引擎抓取到的真实链接/摘要，供你分析时引用，严禁虚构其他数字）：');
      for (const c of monitor) {
        const items = Array.isArray(c && c.items) ? c.items : [];
        lines.push('- ' + ((c && c.name) || '竞品') + '（实抓 ' + items.length + ' 条）：');
        for (const it of items.slice(0, 5)) {
          const t = String((it && it.title) || '').trim();
          const u = String((it && it.url) || '').trim();
          const s = String((it && it.snippet) || '').trim();
          lines.push('  · ' + (t || '（无标题）') + (u ? ' | ' + u : ''));
          if (s) lines.push('    摘要：' + s);
        }
      }
    }
    const manualLines = [];
    for (const c of targets) {
      const entry = manual[c] || {};
      const filled = [];
      for (const k of dims) {
        const v = String((entry[k] || '')).trim();
        if (v) filled.push(DIMENSION_LABEL[k] + '：' + v);
      }
      if (filled.length) manualLines.push('- ' + c + '：' + filled.join('；'));
    }
    if (manualLines.length) {
      lines.push('');
      lines.push('【人工填写数据】（用户手动录入的真实硬数据，可信度最高，写报告时直接引用并标注「【人工】」）：');
      for (const m of manualLines) lines.push(m);
      lines.push('- 人工数据与联网估算冲突时，以人工数据为准，并注明来源为【人工】。');
    }
    return lines.join('\n');
  }

  async function generate(targetsOverride) {
    // targetsOverride：候选面板「确认」时传进来的本次名单。
    // 必须支持它 —— updateField 是异步的，只读 state 会拿到上一轮名单（见 confirmPick 注释）。
    const targets = Array.isArray(targetsOverride) && targetsOverride.length
      ? targetsOverride
      : (selected ? [selected] : competitors);
    if (targets.length === 0) {
      setFormError('请先添加至少一个竞品');
      return;
    }
    if (dims.length === 0) {
      setFormError('请至少勾选一个对比维度');
      return;
    }
    setFormError('');
    setSavedName('');
    // 后台任务：生成期间切换模块不丢
    await startJob(`competitor-${currentCompany ? currentCompany.id : 'x'}`, async () => {
      // 1) 后端实抓竞品动态（有据可查的链接+标题+摘要）
      let monitor = null;
      try {
        const m = await geoProxy('/api/competitor/monitor', 'POST', { competitors: targets });
        if (m && m.ok === true && Array.isArray(m.competitors)) monitor = m.competitors;
      } catch { /* 忽略，降级为纯 AI 检索 */ }

      // 2) 把实抓数据 + 人工填写数据注入 prompt，让 AI 基于真实数据产出结构化结果
      const prompt = buildPrompt(targets, monitor);
      const ctx = buildAIContext({ company: currentCompany, asset, knowledge: getKnowledge(currentCompany && currentCompany.id), project: currentProject });
      // T16：改走**真检索**（searchCompetitorCompare = fetchWebSearch 实检 → 注入资料 → 模型基于实检作答）。
      // 显式传 companyName/competitors 让封装构造精炼检索词，避免长 prompt 被截断成 200 字检索词。
      let r = await searchCompetitorCompare(
        { question: prompt, companyName: myName, competitors: targets, context: ctx },
        { temperature: 0.3 },
      );
      // 数据来源诚实化：由**本次真检索的直接证据**（r.results/r.ok）决定来源文案，
      // 不再沿用旧的「内网网关探针」猜法。有实检结果 → 「联网检索（X 实检 N 条）」；0 条 → 不冒充「联网」。
      let source;
      if (r && r.ok === true && r.content) {
        const n = Array.isArray(r.results) ? r.results.length : 0;
        source = monitor
          ? describeSourceWithCount(SOURCE_KINDS.SCAN_WEB, groundedHealth(r), n)
          : describeSourceWithCount(SOURCE_KINDS.WEB, groundedHealth(r), n);
      } else {
        // 检索失败 / 0 条 → 退回内网模型作答，来源照实标「未联网」（绝不静默冒充「联网检索」）。
        const rr = await chatOnce([{ role: 'user', content: prompt }], ctx, { temperature: 0.3 });
        r = { ok: !!(rr && rr.ok === true && rr.content), content: (rr && rr.content) || '', error: (rr && rr.error) || '' };
        const webHealth = getCachedWebSearchHealth();
        if (!webHealth) { checkWebSearchHealth().catch(() => {}); }
        source = monitor
          ? describeSource(SOURCE_KINDS.SCAN_INTERNAL, webHealth)
          : describeSource(SOURCE_KINDS.INTERNAL, webHealth);
      }
      if (!r || r.ok !== true || !r.content) {
        return {
          ok: false,
          content: '',
          result: null,
          source,
          error: (r && r.error) || '对比分析失败，请检查 AI 连接后重试',
        };
      }

      const parsed = extractJSON(r.content);
      const data = normalizeResult(parsed, targets, dims, myName);
      if (!data) {
        // 兜底：AI 没返回可解析的 JSON，退回老的 Markdown 展示，不影响使用
        const banner = '> 📌 数据来源：' + source + '。本次未返回可解析的结构化结果，已按原文展示。\n\n';
        return { ok: true, content: banner + r.content, result: null, source, error: '' };
      }

      // 人工数据优先级最高：合并进结果再落库
      const merged = mergeManual(data, manual);
      merged.source = source;
      // 【0.21.9 · M1】逐家覆盖：本次实检到底查到了哪几家。
      // 落进 result 里（随 job 持久化），矩阵每行据此显示「未检索，模型补全」灰标。
      // 离线兜底分支没有 results ⇒ 全部算未覆盖，这是**如实**的：那一轮确实没查。
      const searchCoverage = matchCoveredCompetitors(
        Array.isArray(r && r.results) ? r.results : [],
        targets,
      );
      merged.searchCoverage = {
        covered: searchCoverage.covered,
        uncovered: searchCoverage.uncovered,
        total: targets.length,
        // 供 UI 一句话说清覆盖比例（角标数字是"结果条数"、不是"查过的竞品数"，别再混用）。
        grounded: !!(r && r.ok === true && Array.isArray(r.results) && r.results.length > 0),
      };
      const banner = '> 📌 数据来源：' + source + '。空格子（—）是还没拿到数据的，可在页面点「补」手动录入。\n\n';
      // ⚠️ 【M3 提醒 · 谁加产出前先读这段】返回两个字段，两者的可信度**不一样**：
      //   · content —— 走 toMarkdown()，里面**刻意不输出 data.scores**（雷达图那套 85/60/35
      //     是「示意，非实测」，见 LEVEL_SCORE 上方的注释）。三条出口 saveAsset / gotoActivity /
      //     gotoWenan 全走这个字段，所以导出的东西是干净的。
      //   · result  —— 是**原始 merged 对象**，里面 `scores` **还在**。
      //     现在没有任何出口读 `result.scores`，所以「示意分值不出现在任何产出里」成立；
      //     但将来谁要加「汇报摘要 / 导出 JSON / 一键发群」，直接读 `result` 就会把示意分值漏出去，
      //     而 toMarkdown 里的警告**拦不住**（警告写在另一个函数里）。
      //   ⇒ 新出口请一律读 `content`；确实要用 result 的，先在里面剔掉 scores。
      return { ok: true, content: banner + toMarkdown(merged, source), result: merged, source, error: '' };
    });
  }

  function resultText() {
    if (!result) return '';
    if (typeof result === 'string') return result;
    return toMarkdown(result, result.source || '');
  }

  function saveAsset() {
    const text = resultText();
    if (!text) return;
    if (!currentCompany) {
      setFormError('当前无企业上下文，无法保存');
      return;
    }
    const name = `竞品对比分析 · ${myName || '当前企业'}`;
    addAsset({
      type: 'document',
      companyId: currentCompany.id,
      projectId: currentProject ? currentProject.id : null,
      name,
      content: text,
      tags: ['竞品对比', ...competitors],
    });
    setSavedName(name);
  }

  function gotoActivity() {
    const text = resultText();
    if (!text) return;
    // localStorage 写入保留（向后兼容 + 落地兜底；读端见 ActivityPlanning 挂载消费）。
    try {
      localStorage.setItem('douya-competitor-to-activity', JSON.stringify({
        companyName: myName,
        competitors,
        goal: '基于竞品对比结论（差异点/机会点），制定差异化活动策划与营销文案',
        summary: text,
        generatedAt: Date.now(),
      }));
    } catch {
      /* 忽略写失败 */
    }
    // 改走正式回流通道：传对象 { module, intent }，由 App.handleSelectModule 转成 routeIntent，
    // 目标模块 ActivityPlanning 经 initialBrief 消费（否则上下文全丢，见 D1 死链路修复）。
    if (onSelectModule) {
      const who = competitors.length ? competitors.join('、') : (myName || '竞品');
      onSelectModule({
        module: 'huodong',
        intent: {
          kind: 'confirm_brief',
          briefTitle: `基于竞品对比（${who}）策划差异化活动方案`,
          briefReason: String(text || '').slice(0, 300),
          source: 'competitor',
          sourceChangeId: null,
        },
      });
    }
  }

  function gotoWenan() {
    const text = resultText();
    if (!text) return;
    try {
      localStorage.setItem('douya-competitor-to-wenan', JSON.stringify({
        companyName: myName,
        competitors,
        goal: '基于竞品对比结论（差异点/机会点），策划差异化营销文案',
        summary: text,
        generatedAt: Date.now(),
      }));
    } catch { /* 忽略写失败 */ }
    if (onSelectModule) onSelectModule('xinmeiti');
  }

  // 让豆芽执行某张方案卡片：复用现有跨模块联动（localStorage 传 brief + 跳转）
  function executePlan(plan) {
    const route = PLAN_ROUTE[plan.action] || PLAN_ROUTE['营销文案'];
    try {
      localStorage.setItem(route.key, JSON.stringify({
        companyName: myName,
        competitors,
        goal: route.goal,
        summary: '【豆芽建议方案】' + plan.title + '\n\n' + plan.reason,
        generatedAt: Date.now(),
      }));
    } catch { /* 忽略写失败 */ }
    if (!onSelectModule) return;
    if (route.module === 'huodong') {
      // 活动策划：走正式回流通道（与 gotoActivity 一致），把竞品上下文带进活动策划页。
      const who = competitors.length ? competitors.join('、') : (myName || '竞品');
      onSelectModule({
        module: 'huodong',
        intent: {
          kind: 'confirm_brief',
          briefTitle: `基于竞品对比（${who}）策划差异化活动方案`,
          briefReason: ('【豆芽建议方案】' + plan.title + '\n\n' + plan.reason).slice(0, 300),
          source: 'competitor',
          sourceChangeId: null,
        },
      });
    } else {
      // 营销文案 / 防守内容：维持原字符串跳转（xinmeiti 挂载读 localStorage 的活链，不动）。
      onSelectModule(route.module);
    }
  }

  // 🎯 据此生成经营方案（阶段D：竞品声量 → 经营方案闭环）
  // 把竞品「关键发现(差异化/差距) + 机会点」落库为 Direction（findings→problems，opportunities→optimization），
  // 复用 directionDirector.buildCompetitorDirection，纯规则选方向 key，不额外调模型。
  function generateDirectionFromCompetitor() {
    if (!view || !currentCompany) return;
    // 与渲染同源：空说明的条目不该被当成"问题"落库成经营方向（旧结果里可能有）。
    if (shownFindings.length === 0 && view.opportunities.length === 0) return;
    const { direction } = buildCompetitorDirection(shownFindings, view.opportunities, {
      subjectType: companyType,
      companyName: myName || (currentCompany && currentCompany.name) || '',
    });
    if (!direction) return;
    const created = createDirection({ ...direction, companyId: currentCompany.id });
    activateDirection(currentCompany.id, created.id);
    if (onSelectModule) onSelectModule('direction');
  }

  // 【0.21.9 · M1】哪些竞品行本次**没被实检覆盖**（逐行标「未检索，模型补全」）。
  // 数据来自 generate() 写入 result 的 searchCoverage，是按"名字是否真出现在实检结果里"判的。
  const uncoveredRows = useMemo(() => {
    const sc = view && view.searchCoverage;
    if (!sc || !Array.isArray(sc.uncovered) || sc.uncovered.length === 0) return new Set();
    return new Set(sc.uncovered.map((n) => String(n)));
  }, [view]);

  const matrixColumns = useMemo(() => {
    const cols = [
      {
        title: '企业',
        dataIndex: 'name',
        key: 'name',
        fixed: 'left',
        width: 148,
        render: (name, row) => (
          <div className="comp-row-name">
            <span className={row.isUs ? 'comp-name-us' : 'comp-name'}>{name}</span>
            {row.isUs && <Tag color="green" className="comp-us-tag">我方</Tag>}
            {/* 【0.21.9 · M1】这一行本次**没被检索到** ⇒ 内容是模型补全的，必须逐行标出来。
                只改全表角标是没用的：角标只有一个，用户看不出是哪一行没查。 */}
            {!row.isUs && uncoveredRows.has(String(name)) && (
              <Tag data-row-unsearched="1" style={{ margin: '2px 0 0', fontSize: 11, color: '#8e8e93', borderColor: '#d9d9d9' }}>
                未检索，模型补全
              </Tag>
            )}
          </div>
        ),
      },
    ];
    for (const dk of visibleDims) {
      cols.push({
        title: DIMENSION_LABEL[dk],
        key: dk,
        dataIndex: dk,
        width: 210,
        render: (_, row) => <MatrixCell row={row} dimKey={dk} onFill={openFill} />,
      });
    }
    return cols;
    // uncoveredRows 进依赖：M1 的「未检索」灰标由它决定，漏了会出现"该标没标"的静默错。
  }, [visibleDims, uncoveredRows]);

  const dimsChanged =
    !!view && (view.dims.length !== dims.length || view.dims.some((dk) => !dims.includes(dk)));

  // 【2026-10-12 P0】「旧结果 vs 当前名单」脱钩检测。
  // 起因（老板实测）：首页竞品区恒空（读错字段层级，已在 HomeConsole 单独修），用户因此
  // 以为「没有竞品名单」，而本页渲染的是**持久化**的上一次 job.result ⇒ 看到的是旧结论却不自知。
  // 判据刻意**只用「名单里有、结果里没有」**（missingInView），不用反向集合：
  //   · normalizeResult 保证本次 targets 每家都会占一行（L274 补齐）⇒ 名单没动过时必然为空；
  //   · AI 自行多返回的行不会造成误报 —— 若拿「结果里多出来的行」判过期，
  //     干净名单也会被提示成过期，那是噪声，不是诚实。
  const unrunCompetitors = useMemo(() => {
    if (!view || competitors.length === 0) return [];
    const inView = new Set(
      (Array.isArray(view.rows) ? view.rows : [])
        .filter((r) => r && !r.isUs)
        .map((r) => String(r.name || '').trim())
        .filter(Boolean),
    );
    return competitors.filter((c) => !inView.has(String(c).trim()));
  }, [view, competitors]);

  function renderFooter() {
    if (!onSelectModule) return null;
    return (
      <div className="xm-result-foot">
        <Space wrap>
          <Button type="primary" ghost onClick={gotoActivity}>🎯 据此生成活动策划 →</Button>
          <Button type="primary" ghost onClick={gotoWenan}>✍️ 据此生成营销文案 →</Button>
        </Space>
      </div>
    );
  }

  return (
    <div className={embedded ? 'module-page ia-embed' : 'module-page'}>
      {embedded ? (
        <div className="ia-embed-hd">
          <span className="ia-embed-title">⚔️ 竞品对比</span>
          <span className="ia-embed-note">豆芽自动挑好同行竞品，下面是详细对比</span>
        </div>
      ) : (
        <div className="module-page-head">
          <h2 className="module-page-title">⚔️ 竞品对比分析</h2>
          <p className="module-page-sub">豆芽自动挑好同行竞品，按定位 / 产品 / 价格 / 渠道 / 内容 / 声量做多维度对比，给出机会点。竞品可手动增删。</p>
        </div>
      )}

      <div className="xm-form">
        {!hasAsset && (
          <div className="xm-note" style={{ background: 'rgba(255,214,10,0.12)', borderColor: 'rgba(255,214,10,0.5)', color: '#8a6d00' }}>
            尚未建档，我方企业信息为空。建议先到「🗂 资产库」一键建档，对比报告才会带出「我方」画像。
            {onSelectModule && (
              <div style={{ marginTop: 8 }}>
                <Button size="small" type="primary" ghost onClick={() => onSelectModule('asset')}>去资产库建档 →</Button>
              </div>
            )}
          </div>
        )}

        {/* ============================================================
            【老板第 5 条 · 5.2】AI 已按企业资产库挑好竞品 —— **常驻**面板。
            老板原话：「我要做成自动帮我挑好竞品 然后用户点打钩就行了 按照企业资产库来」。
            为什么必须常驻（而不是只在空态出现）：旧实现只在名单为空时给推荐，
            老板库里本来就有错误名单 ⇒ 推荐永远不出现 ⇒ 「AI 不会自动帮我挑」。
            写库只由「确认，用这些对比」触发（5.4），面板本身只做勾选。
            ============================================================ */}
        <div
          className="comp-pick"
          data-comp-pick="1"
          data-comp-pick-view={pickOpen ? 'open' : 'closed'}
          style={{
            margin: '2px 0 14px',
            padding: 12,
            border: '1px solid rgba(48,209,88,0.30)',
            borderRadius: 12,
            background: 'rgba(48,209,88,0.05)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>AI 已按你的企业资产库挑好竞品</div>
              <div style={{ fontSize: 12, color: 'var(--text-faint, #8e8e93)', marginTop: 2 }}>
                勾选你要对比的，确认后只用勾选的做对比
              </div>
            </div>
            <Space size={6} wrap>
              <Button size="small" onClick={() => pickAll(true)}>全选</Button>
              <Button size="small" onClick={() => pickAll(false)}>全不选</Button>
              <Button size="small" ghost onClick={repick}>按企业资产库重挑</Button>
              <Button size="small" type="text" data-comp-pick-toggle="1" onClick={() => togglePickOpen()}>
                {pickOpen ? '收起' : '展开'}
              </Button>
            </Space>
          </div>

          {/* AI 曾推荐的自家品牌：无论面板展开与否都按实说明（历史锚点 data-ai-reco-self-brand 保留）。 */}
          {aiRecoDropped.length > 0 ? (
            <div data-ai-reco-self-brand="1" style={{ fontSize: 12, color: 'var(--text-faint, #8e8e93)', marginTop: 8 }}>
              （AI 曾推荐 {aiRecoDropped.join('、')}，但它们属于本企业自有品牌 / 旗下 IP，已过滤）
            </div>
          ) : null}

          {pickOpen ? (
            pickCandidates.length > 0 ? (
              <>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pickCandidates.map((c) => {
                    const on = pickChecked.has(c.id);
                    return (
                      <div
                        key={c.id}
                        data-comp-cand="1"
                        data-comp-cand-source={c.source}
                        data-comp-cand-state={on ? 'on' : 'off'}
                        data-comp-cand-verified={c.verified ? '1' : '0'}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '6px 8px',
                          background: '#fff',
                          borderRadius: 8,
                        }}
                      >
                        <Checkbox checked={on} onChange={() => togglePick(c.id)} style={{ marginTop: 2 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</span>
                            <Tag color="green" style={{ margin: 0, fontSize: 11 }}>{c.sourceLabel}</Tag>
                            {c.verified ? null : (
                              <Tag style={{ margin: 0, fontSize: 11, color: '#8e8e93', borderColor: '#d9d9d9' }}>待核验</Tag>
                            )}
                          </div>
                          <div
                            title={c.reason}
                            style={{
                              fontSize: 12,
                              color: 'var(--text-faint, #8e8e93)',
                              marginTop: 2,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {c.reason}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Button
                    type="primary"
                    data-comp-pick-confirm="1"
                    loading={busy}
                    onClick={confirmPick}
                  >
                    确认，用这些对比（{pickCandidates.filter((c) => pickChecked.has(c.id)).length}）
                  </Button>
                  <span style={{ fontSize: 12, color: 'var(--text-faint, #8e8e93)' }}>
                    确认后才写入竞品名单，并且只对勾选的做对比。
                  </span>
                </div>
              </>
            ) : (
              <div
                data-comp-pick-empty="1"
                style={{
                  marginTop: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'rgba(255,214,10,0.12)',
                  border: '1px solid rgba(255,214,10,0.45)',
                }}
              >
                <div style={{ fontSize: 13, color: '#8a6d00', lineHeight: 1.7 }}>{pickEmptyReason}</div>
                {/* 【0.21.13 删除】这里原来有一个「去企业大脑补全资料 →」按钮（data-comp-pick-gobrain）。
                    老板原话：「为什么竞品分析还要去企业大脑里面补全」。竞品分析已经改成
                    「联网大模型分题问答」，用户不需要先去别处补资料才能得到结论，
                    所以这个导流按钮**直接删掉**，连同「先补数据再分析」的门槛一起取消。
                    pickEmptyReason 保留：它是"候选为什么是空"的如实说明，不是拦路条件。 */}
              </div>
            )
          ) : null}
        </div>

        <div className="xm-field">
          <label className="field-label">竞品名单</label>
          {/* 2026-09-21：名单里若早有自家品牌（上游污染的残留），按实说明 + 给一键清掉的出口，
              而不是默默无视 —— 「悄悄忽略」和「当成竞品」一样让人不放心。 */}
          {assetSelfDropped.length > 0 && (
            <div className="comp-hint" data-asset-self-brand="1">
              注意：名单里有 {assetSelfDropped.length} 个是本企业自有品牌 / 旗下 IP（
              {assetSelfDropped.join('、')}），已自动忽略、不参与对比。
              <Button size="small" type="link" onClick={() => updateField('competitors', competitors)}>
                从名单里清掉
              </Button>
            </div>
          )}
          {competitors.length === 0 ? (
            <div className="xm-empty" style={{ padding: '6px 0' }} data-comp-list-empty="1">
              名单还是空的。勾选上方候选后点「确认，用这些对比」，豆芽就只用勾选的做对比；也可直接在下面手动添加。
            </div>
          ) : (
            <Space wrap size={[6, 6]} style={{ marginBottom: 8 }}>
              {competitors.map((c) => (
                <Tag
                  key={c}
                  closable
                  onClose={(e) => { e.preventDefault(); removeCompetitor(c); }}
                  color={selected === c ? 'green' : 'default'}
                  style={{ cursor: 'pointer', fontSize: 13 }}
                  onClick={() => toggleSelect(c)}
                >
                  {selected === c ? '✓ ' : ''}{c}
                </Tag>
              ))}
            </Space>
          )}
          <div className="xm-row" style={{ marginTop: 4 }}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onPressEnter={addCompetitor}
              placeholder="手动添加竞品（可选），如：励齿商城 / 松佰商城 / E看牙"
            />
            <Button onClick={addCompetitor} style={{ flexShrink: 0 }}>添加</Button>
          </div>
          {competitors.length > 1 && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6 }}>
              点选某个竞品可单家对比；不选则默认全量对比（{competitors.length} 家）。
            </div>
          )}
        </div>

        {/* 【2026-10-10 第 4 条】「简单明了」：对比维度 / 手动补数据 收进高级设置。
            独立页默认展开（与改造前一致）；内嵌在经营诊断时默认折叠，页面只剩「竞品名单 + 结果」。 */}
        <Collapse
          ghost
          size="small"
          className="comp-adv"
          defaultActiveKey={embedded ? [] : ['adv']}
          items={[{
            key: 'adv',
            label: '⚙️ 对比维度 / 手动补数据（豆芽已按行业自动配好，通常不用动）',
            children: (
              <div className="comp-adv-bd">
        <div className="xm-field">
          <label className="field-label">对比维度</label>
          <div className="xm-switches">
            {DIMENSIONS.map((d) => (
              <Checkbox
                key={d.key}
                checked={dims.includes(d.key)}
                onChange={() => toggleDim(d.key)}
              >
                {d.label}
              </Checkbox>
            ))}
          </div>
        </div>

        <div className="xm-field" style={{ marginTop: 14 }}>
          <label className="field-label">手动补充数据（可选）</label>
          <Collapse
            ghost
            size="small"
            items={[
              {
                key: 'manual',
                label: '📝 填写 AI 抓不到的硬数据（按「维度 × 竞品」批量录入，自动保存）',
                children: competitors.length === 0 ? (
                  <div className="xm-empty" style={{ padding: '6px 0' }}>先在上方添加竞品，再按维度补数据。</div>
                ) : (
                  <div className="comp-manual">
                    {competitors.map((c) => (
                      <div className="comp-manual-block" key={c}>
                        <div className="comp-manual-name">{c}</div>
                        <div className="comp-manual-grid">
                          {dims.map((dk) => (
                            <div className="comp-manual-item" key={dk}>
                              <label className="comp-manual-label">{DIMENSION_LABEL[dk]}</label>
                              <Input
                                size="small"
                                value={(manual[c] && manual[c][dk]) || ''}
                                onChange={(e) => setManualValue(c, dk, e.target.value)}
                                placeholder={DIMENSION_LABEL[dk] + '，如价格带 / 门店数 / 粉丝数'}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </div>
              </div>
            ),
          }]}
        />

        {/* 生成按钮留在折叠区外：内嵌时也必须能看见 / 重试（自动跑失败时靠它兜底） */}
        <div className="xm-actions" style={{ marginTop: 14 }}>
          {/* 包一层 () => generate()：generate(targetsOverride) 带 1 个必填参数，
              直接挂 onClick 会把合成事件当 targetsOverride 传进去。今天靠函数体第一行的
              `Array.isArray(...) && .length` 类型守卫落回默认分支、行为侥幸正确 ——
              但「侥幸正确」不该留在调用点上，而且 scan-handler-arity 硬判会红。
              这里显式写「我没打算传参」，而不是给门禁开「函数体有守卫就豁免」的口子。 */}
          <Button type="primary" onClick={() => generate()} disabled={busy} loading={busy}>
            {busy ? '生成中（可切换页面，回来结果仍在）' : '生成对比报告'}
          </Button>
          {result && (
            <Button onClick={saveAsset} disabled={busy || !currentCompany}>
              {savedName ? '已保存 ✓' : '存入产出并同步到企业大脑'}
            </Button>
          )}
        </div>
        {shownError && <div className="xm-error">⚠️ {shownError}</div>}
      </div>

      {result && !view && (
        <div className="xm-result">
          <div className="xm-result-head">对比分析报告</div>
          <div className="xm-result-body"><Markdown>{String(result)}</Markdown></div>
          {renderFooter()}
        </div>
      )}

      {view && (
        <div className="xm-result">
          <div className="xm-result-head">对比分析报告（结构化）</div>
          <div className="xm-result-body comp-result">
            {/* 旧结果诚实提示（2026-09-21 老板实测：「啥也搜不到」）。
                两个数据源不同步：矩阵来自持久化的 job.result，竞品名单来自 asset.competitors。
                名单被清空后旧矩阵仍会渲染 —— 不说清楚，老板会以为这就是「现在的结论」。 */}
            {competitors.length === 0 && (
              <div className="comp-hint" data-stale-report="1">
                ⚠️ 当前竞品名单是空的：下面是<b>上一次</b>生成的结果，不是按现在的名单跑的。
                要拿到新结论，请先在上方「竞品名单」里添加竞品，再点「生成对比分析」。
              </div>
            )}
            {unrunCompetitors.length > 0 && (
              <div className="comp-hint" data-stale-report="unrun">
                ⚠️ 名单里有 {unrunCompetitors.length} 家是<b>上一次生成之后</b>才加的（{unrunCompetitors.join('、')}），
                下面的结果里没有它们。要拿到完整对比，请点「生成对比分析」重跑。
              </div>
            )}
            {droppedSelfRows.length > 0 && (
              <div className="comp-hint" data-self-brand-dropped={droppedSelfRows.length}>
                已剔除 {droppedSelfRows.length} 个本企业自有品牌 / 旗下 IP（{droppedSelfRows.join('、')}）—— 它们不是外部竞品。
              </div>
            )}
            {dimsChanged && (
              <div className="comp-hint">对比维度已变更，重新生成后新维度才会出现在矩阵里。</div>
            )}

            {view.summary ? <div className="comp-summary">{view.summary}</div> : null}

            {/* 【0.21.9 · M1】检索**覆盖**（按家算，不是按结果条数算）。
                旧角标只有一个「实检 N 条」，N 是检索结果条数 —— 勾 6 家只查了 2 家时它看起来照样"很充分"。
                这里把覆盖按家数摊开，并在 matrix 里逐行标未覆盖的行（见 matrixColumns 的 name 列）。 */}
            {view.searchCoverage && view.searchCoverage.total > 0 ? (
              <div
                className="comp-hint"
                data-search-coverage={`${view.searchCoverage.covered.length}/${view.searchCoverage.total}`}
              >
                {view.searchCoverage.grounded
                  ? `本轮实检覆盖 ${view.searchCoverage.covered.length} 家 / 共 ${view.searchCoverage.total} 家`
                    + (view.searchCoverage.uncovered.length
                      ? `：${view.searchCoverage.uncovered.join('、')} 未检索到，这些行由模型按同行补全（已在行名旁标注）。`
                      : '，全部竞品都有实检依据。')
                  : `本轮没拿到实检结果（未联网 / 检索失败），${view.searchCoverage.total} 家全部由模型补全 —— 请把结论当假设看。`}
              </div>
            ) : null}

            {/* 【2026-10-20 · 老板第 2 条】总体客观评价 + 「问豆芽」入口。
                老板原话：「你要有一个总体的客观评价啊 现在啥也没有就4条…而且也没有可以问的地方」。
                为什么放在矩阵**上面**：老板要的是"先看结论，再往下核对明细"，
                评价放在一屏底部的矩阵之后等于没有。 */}
            <div className={embedded ? 'comp-block comp-verdict-compact' : 'comp-block'}>
              <div className="comp-block-head">
                <span className="comp-block-title">📊 总体客观评价</span>
              </div>
              {view.verdict ? (
                <>
                  <div className="comp-verdict-grid">
                    <div className="comp-verdict-item">
                      <span className="comp-verdict-label">市场格局</span>
                      <span className="comp-verdict-text">{view.verdict.marketView || '本轮没拿到'}</span>
                    </div>
                    <div className="comp-verdict-item">
                      <span className="comp-verdict-label">我方位置</span>
                      <span className="comp-verdict-text">{view.verdict.ourPosition || '本轮没拿到'}</span>
                    </div>
                    <div className="comp-verdict-item">
                      <span className="comp-verdict-label">最大短板</span>
                      <span className="comp-verdict-text">{view.verdict.biggestGap || '本轮没拿到'}</span>
                    </div>
                    <div className="comp-verdict-item">
                      <span className="comp-verdict-label">证据强度说明</span>
                      <span className="comp-verdict-text comp-verdict-note">
                        {view.verdict.confidenceNote || '本轮没拿到'}
                      </span>
                    </div>
                  </div>
                  {view.verdict.priorities.length > 0 && (
                    <div className="comp-verdict-prior">
                      <div className="comp-verdict-prior-head">优先动作（按优先级排序）</div>
                      {view.verdict.priorities.map((p, i) => (
                        <div className="comp-verdict-prior-item" key={'verdict-prior-' + i}>
                          <span className="comp-verdict-prior-no">{i + 1}</span>
                          <div className="comp-verdict-prior-body">
                            <div className="comp-verdict-prior-action">{p.action}</div>
                            <div className="comp-verdict-prior-why">为什么：{p.why}</div>
                            <div className="comp-verdict-prior-measure">怎么衡量：{p.measure}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="comp-verdict-empty" data-comp-verdict-empty="1">
                  本轮没有生成总体评价（AI 未返回可核实依据）。补几个竞品维度后重新生成会更完整。
                </div>
              )}
              <CompetitorAdvisor
                view={view}
                companyId={companyId}
                resetKey={companyId + ':' + String(view.generatedAt || 0)}
                meta={advisorMeta}
                buildContext={buildAdvisorCtx}
                compact={embedded}
              />
            </div>

            {/* ① 维度对比矩阵 */}
            <div className="comp-block">
              <div className="comp-block-head">
                <span className="comp-block-title">① 维度对比矩阵</span>
                {/* 【0.21.11 · 老板第 2 条】「删减」+「一大堆未获取到」：
                    原来的 ③「数据完整度」整块（已知/待补 chip 墙 + 「AI 明确标注未获取到：…」
                    一大串名字 + 进度条）在这里压成一句 —— 完整度和「去补充」入口都还在，
                    但那面墙没了。chip 墙与那行名单直接删掉（补录入口在矩阵每个空格子里）。 */}
                <span className="comp-matrix-cov" data-matrix-cov={cov.percent}>
                  完整度 {cov.percent}%
                  {cov.unknown.length > 0 ? ` · ${cov.unknown.length} 项待补` : ' · 已齐'}
                </span>
                <Segmented
                  size="small"
                  value={dimFilter}
                  onChange={(v) => setDimFilter(v)}
                  options={[
                    { label: '全部维度', value: 'all' },
                    { label: '只看有数据的', value: 'filled' },
                  ]}
                />
                <Button
                  size="small"
                  type="primary"
                  ghost
                  disabled={cov.unknown.length === 0}
                  onClick={() => openFill(cov.unknown)}
                >
                  去补充这些数据 →
                </Button>
              </div>
              {visibleDims.length === 0 ? (
                <Empty
                  className="comp-empty"
                  description="所有维度都没拿到数据。可点「补」手动录入，或补充竞品信息后重新生成。"
                />
              ) : (
                <Table
                  className="comp-matrix"
                  columns={matrixColumns}
                  dataSource={view.rows}
                  rowKey="name"
                  size="small"
                  bordered
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  rowClassName={(r) => (r.isUs ? 'comp-row-us' : '')}
                />
              )}
            </div>

            {/* ② 能力雷达 */}
            <div className="comp-block">
              <div className="comp-block-head">
                <span className="comp-block-title">② 能力雷达</span>
                <span className="comp-block-sub">绿色为我方</span>
              </div>
              {visibleDims.length < 3 ? (
                <div className="comp-radar-empty">有数据的维度不足 3 个，暂不绘制雷达图。</div>
              ) : (
                <RadarChart dims={visibleDims} series={radarSeries} />
              )}
            </div>

            {/* ③ 数据完整度 —— 【0.21.11 · 老板第 2 条】整块已并入 ① 的表头（见 comp-matrix-cov）。
                删掉的内容：已知/待补 chip 墙、「AI 明确标注未获取到：a、b、c…」名单、进度条。
                为什么可以删而不丢能力：补录入口仍在矩阵每个空格子里的「补」，
                「去补充这些数据 →」按钮也搬到了 ① 表头；完整度数字同样保留。
                老板原话：「还是一大堆未获取到 … 太多没有用的内容 你删减一下」。 */}

            {/* ③ 关键发现 + 机会点（来源链接置于上方；原编号 ④，0.21.11 第 2 条删掉旧的 ③ 完整度后顺延） */}
            <div className="comp-block">
              <div className="comp-block-head">
                <span className="comp-block-title">③ 关键发现与机会点</span>
              </div>
              {view.sources.length > 0 && (
                <div className="comp-sources">
                  {view.sources.slice(0, 12).map((s, i) => (
                    <span className="comp-source" key={'src-' + i}>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>
                      ) : (
                        <span>{s.title}</span>
                      )}
                      {s.platform ? <span className="comp-source-plat">· {s.platform}</span> : null}
                    </span>
                  ))}
                </div>
              )}
              {shownFindings.length > 0 && (
                <div className="comp-find-list">
                  {shownFindings.map((f, i) => (
                    <div className="comp-find-card" key={'f-' + i} style={{ borderLeftColor: impactColor(f.impact) }}>
                      <div className="comp-find-title">
                        {f.title}
                        <span className="comp-find-impact" style={{ color: impactColor(f.impact) }}>
                          {IMPACT_TEXT[f.impact] || '影响中'}
                        </span>
                      </div>
                      {f.detail ? <div className="comp-find-detail">{f.detail}</div> : null}
                      {f.evidence ? <div className="comp-find-evi">依据：{f.evidence}</div> : null}
                    </div>
                  ))}
                </div>
              )}
              {/* 【0.21.9 · M2】0 条必须**显式说明**，不能留空白。
                  空白会被用户当成"加载失败/页面坏了"，而 0 条恰恰是诚实的结果：
                  这一轮确实没有可核实的依据，宁可不写（prompt 第 4 条）也不凑数（第 6 条已删硬性条数）。 */}
              {shownFindings.length === 0 && (
                <div className="comp-hint" data-findings-empty="1">
                  本轮未取得可核实的发现 —— 没拿到实检依据的结论豆芽不写。补充竞品数据后重新生成会更完整。
                </div>
              )}
              {view.opportunities.length > 0 && (
                <div className="comp-opp-list">
                  {view.opportunities.map((o, i) => (
                    <div className="comp-opp-card" key={'o-' + i}>
                      <div className="comp-opp-title">
                        💡 {o.title}
                        <Tag color="green" className="comp-opp-tag">{EFFORT_TEXT[o.effort] || '投入中'}</Tag>
                      </div>
                      {o.action ? <div className="comp-opp-line">动作：{o.action}</div> : null}
                      {o.expected ? <div className="comp-opp-line">预期：{o.expected}</div> : null}
                      {o.basis ? <div className="comp-opp-line comp-opp-basis">依据：{o.basis}</div> : null}
                    </div>
                  ))}
                </div>
              )}
              {view.opportunities.length === 0 && (
                <div className="comp-hint" data-opps-empty="1">
                  本轮未取得可执行的机会点（0 条是允许的结果，不凑数）。
                </div>
              )}
            </div>

            {/* ⑤ 豆芽建议方案：点选方案卡片 → 带着 brief 跳转对应模块执行 */}
            {douyaPlans.length > 0 && (
              <div className="comp-block comp-douya-block">
                <div className="comp-block-head">
                  <span className="comp-block-title">⑤ 豆芽建议方案</span>
                  <span className="comp-block-sub">点「让豆芽执行」→ 带着方案 brief 跳转对应模块</span>
                </div>
                <div className="comp-plan-grid">
                  {douyaPlans.map((p) => (
                    <div className="comp-plan-card" key={p.id}>
                      <div className="comp-plan-head">
                        <span className="comp-plan-title">{p.title}</span>
                        <Tag color="green" className="comp-plan-action">{p.action}</Tag>
                      </div>
                      <div className="comp-plan-reason">{p.reason}</div>
                      <Button
                        type="primary"
                        className="comp-plan-exec"
                        block
                        onClick={() => executePlan(p)}
                      >
                        让豆芽执行 →
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  className="comp-direction-btn"
                  onClick={generateDirectionFromCompetitor}
                >
                  🎯 据此生成经营方案（把差异化 + 机会升级成一条经营方向，含问题诊断 / 怎么优化 / 多久达标）
                </Button>
              </div>
            )}
          </div>
          {renderFooter()}
        </div>
      )}

      <Modal
        title="补充竞品数据"
        open={fillOpen}
        onCancel={() => setFillOpen(false)}
        onOk={saveFill}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <div className="comp-fill">
          <div className="comp-fill-hint">填写后立刻生效（覆盖 AI 结果，标记为「人工」），并按企业自动保存。</div>
          {fillTargets.map((t) => (
            <div className="comp-fill-item" key={t.name + '||' + t.dim}>
              <label className="comp-fill-label">
                {t.name} · {DIMENSION_LABEL[t.dim] || t.dim}
              </label>
              <Input
                size="small"
                value={fillDraft[t.name + '||' + t.dim] || ''}
                onChange={(e) => setFillDraft((prev) => ({ ...prev, [t.name + '||' + t.dim]: e.target.value }))}
                placeholder={'如：' + (DIMENSION_LABEL[t.dim] || t.dim) + ' 的具体数值 / 事实'}
              />
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
