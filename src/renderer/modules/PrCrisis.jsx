import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Segmented, Tag, Tooltip } from 'antd';
import Markdown from '../components/Markdown.jsx';
import BrandIpManager, { buildMonitorTargets } from '../components/BrandIpManager.jsx';
import { useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { useCompanyKnowledge, listBrandIps, listBrandMainAliases, normalizeBrandIp } from '../store/companyKnowledgeStore.jsx';
import { genBrandIps } from '../services/genBrandIps.js';
import { buildAIContext } from '../services/contextBuilder.js';
import { chatOnce } from '../api.js';
import { startJob, useBackgroundJob } from '../store/backgroundJobs.js';
import { getCachedWebSearchHealth } from '../services/webSearchHealth.js';
import { buildCrisisScanPrompt, noWebDeclaration, crisisLlmLabel } from '../services/webSearchHonesty.js';

/** 本地后端地址（与 App.jsx / api.js 保持一致；允许验收脚本用 window.__DOUYA_BACKEND__ 覆盖） */
const BACKEND =
  (typeof window !== 'undefined' && window.__DOUYA_BACKEND__) || 'http://127.0.0.1:10119';

/**
 * 可扫描平台（与后端 backend.js 的 PLATFORM_SOURCES 一一对应）。
 * 注意：渲染进程无法直接 import 主进程常量，这里保持同一份口径。
 */
const PLATFORM_OPTIONS = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'tieba', label: '百度贴吧' },
  { value: 'weibo', label: '微博' },
  { value: 'weixin', label: '微信公众号' },
  { value: 'zhihu', label: '知乎' },
  { value: 'douyin', label: '抖音' },
];
/** 默认勾选：小红书 / 百度贴吧 / 微博 / 微信公众号 */
const DEFAULT_PLATFORMS = ['xiaohongshu', 'tieba', 'weibo', 'weixin'];

/** 词与词之间的间隔（ms）。后端按 brand 做 30s 节流，错峰避免连续请求被反爬/节流拦掉。 */
const WORD_GAP_MS = 420;

function labelOf(key) {
  const hit = PLATFORM_OPTIONS.find((o) => o.value === key);
  return hit ? hit.label : String(key || '');
}

/** 睡眠（用于多词扫描错峰）。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 归一化小写（用于去重比较）。 */
function asLower(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * 风险等级配色（主色调仍是绿，逐级 绿 → 黄 → 橙 → 红；未获取单独用中性灰，绝不当成安全）。
 */
const RISK_META = {
  safe: { label: '安全', rank: 0, color: 'var(--c-brand-dark)', bg: 'var(--c-brand-tint)', border: 'var(--c-brand-line)' },
  watch: { label: '关注', rank: 2, color: 'var(--c-warn)', bg: 'var(--c-warn-tint)', border: 'rgba(255, 214, 10, 0.5)' },
  warn: { label: '预警', rank: 3, color: 'var(--c-warn)', bg: 'var(--c-warn-tint)', border: 'rgba(255, 159, 10, 0.5)' },
  danger: { label: '高危', rank: 4, color: 'var(--c-danger)', bg: 'var(--c-danger-tint)', border: 'rgba(255, 69, 58, 0.45)' },
  aionly: { label: '仅 AI 结论', rank: 0, color: 'var(--c-warn)', bg: 'var(--c-warn-tint)', border: 'rgba(255, 214, 10, 0.42)' },
  unknown: { label: '本次未获取', rank: 0, color: 'var(--c-text-2)', bg: 'var(--c-surface-hover)', border: 'var(--c-border-strong)' },
};

/**
 * 计算单个监控对象的风险等级。
 * - status !== 'ok'（被节流/失败）一律 unknown：**没查到 ≠ 安全**，绝不显示成"未发现"。
 * - 其余按负面绝对条数与占比综合判定。
 */
function riskKeyOf(t) {
  if (!t) return 'unknown';
  if (t.status === 'limited') return 'unknown';      // 爬虫与 AI 都没拿到 → 不能判定
  if (t.status === 'partial') return 'aionly';       // 只有 AI 联网结论，条数统计不可用 → 也不判安全
  const neg = Number(t.negativeCount) || 0;
  const total = Number(t.total) || 0;
  if (neg <= 0) return 'safe';
  const ratio = total > 0 ? neg / total : 1;
  if (neg >= 6 || ratio >= 0.6) return 'danger';
  if (neg >= 3 || ratio >= 0.3) return 'warn';
  return 'watch';
}

function riskOf(t) {
  return RISK_META[riskKeyOf(t)];
}

/** 去重用 key：优先 url，其次 标题+摘要 归一化。 */
function dedupeKey(item) {
  const url = String((item && item.url) || '').trim();
  if (url) return `u:${url}`;
  const title = String((item && item.title) || '').replace(/\s+/g, '').toLowerCase();
  const summary = String((item && item.summary) || '').replace(/\s+/g, '').toLowerCase().slice(0, 60);
  return `t:${title}|${summary}`;
}

// ==================== 扫描进度（模块级，切走再切回不丢） ====================
const progressState = { key: '', done: 0, total: 0, word: '', phase: '' };
const progressListeners = new Set();

function emitProgress() {
  progressListeners.forEach((fn) => {
    try { fn(); } catch { /* 忽略单个监听器异常 */ }
  });
}

function setScanProgress(key, patch) {
  if (progressState.key !== key) {
    progressState.key = key;
    progressState.done = 0;
    progressState.total = 0;
    progressState.word = '';
    progressState.phase = '';
  }
  Object.assign(progressState, patch && typeof patch === 'object' ? patch : {});
  emitProgress();
}

function useScanProgress(key) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => { force((n) => n + 1); };
    progressListeners.add(fn);
    return () => { progressListeners.delete(fn); };
  }, []);
  if (progressState.key !== key) return { done: 0, total: 0, word: '', phase: '' };
  return {
    done: progressState.done,
    total: progressState.total,
    word: progressState.word,
    phase: progressState.phase,
  };
}

/**
 * P0-4 公关危机：品牌矩阵（主品牌 + 旗下 IP）逐个定向搜负面。
 *
 * 数据源 = LLM 联网检索（主，质量最高）+ 本地百度爬虫（辅，提供可点开的原始条目证据），两者并行。
 * 关键约束：
 *  - 后端 /api/crisis/scan-local 只接受单个 brand 字符串且按 brand 做 30s 节流，
 *    因此多词扫描在渲染进程侧**串行 + 错峰**发起，词间间隔 WORD_GAP_MS。
 *  - 某个词被节流或失败 → 明确标记「本次未能获取」，绝不伪装成「未发现负面」。
 */
export default function PrCrisis({ geoProxy, onSelectModule }) {
  const { asset, hasAsset } = useMarketingAsset();
  const { currentCompany, currentProject } = useCompany();
  const { addAsset } = useAssets();
  const { getKnowledge, setBrandIps } = useCompanyKnowledge();

  const companyId = currentCompany ? currentCompany.id : '';
  const parentName = String((asset && asset.companyName) || (currentCompany && currentCompany.name) || '').trim();

  // 联网探针（同步读缓存，不发起请求）：未确证联网时，舆情结论区绝不出现「联网检索」，
  // 并强制展示诚实声明 —— 避免把「模型凭记忆推断」当成「已经扫过网、确认无负面」（红线，见 webSearchHonesty.js）。
  const webHealth = getCachedWebSearchHealth();

  const [platforms, setPlatforms] = useState(DEFAULT_PLATFORMS);
  const [formError, setFormError] = useState('');
  const [savedName, setSavedName] = useState('');
  const [view, setView] = useState('ip'); // 'ip' | 'platform'

  // AI 生成旗下 IP 候选
  const [aiIps, setAiIps] = useState([]);
  const [aiIpsBusy, setAiIpsBusy] = useState(false);
  const [aiIpsChecked, setAiIpsChecked] = useState(() => new Set());

  const knowledge = useMemo(
    () => (companyId ? getKnowledge(companyId) : null),
    [companyId, getKnowledge],
  );
  const ips = useMemo(() => listBrandIps(knowledge), [knowledge]);
  const mainAliases = useMemo(() => listBrandMainAliases(knowledge), [knowledge]);

  /** 本轮将要扫描的监控对象（主品牌 + 启用中的 IP）。 */
  const monitorTargets = useMemo(
    () => buildMonitorTargets(parentName, mainAliases, ips),
    [parentName, mainAliases, ips],
  );

  // 后台任务：整轮扫描走全局 store，切换模块不丢
  const jobKey = `crisis-${companyId || 'x'}`;
  const job = useBackgroundJob(jobKey);
  const busy = !!(jobKey && job.busy);
  const res = jobKey && job.result && typeof job.result === 'object' ? job.result : null;
  const progress = useScanProgress(jobKey);
  const durationSec = res && typeof res.durationSec === 'number' ? res.durationSec : null;
  const scanNote = jobKey ? (job.note || '') : '';
  const jobError = jobKey ? (job.error || '') : '';
  const shownError = formError || (busy ? '' : jobError);

  const resultTargets = res && Array.isArray(res.targets) ? res.targets : [];
  const platformKeys = res && Array.isArray(res.platformKeys) ? res.platformKeys : [];
  const totalItems = resultTargets.reduce((s, t) => s + (Number(t.total) || 0), 0);
  const totalNeg = resultTargets.reduce((s, t) => s + (Number(t.negativeCount) || 0), 0);
  const limitedTargets = resultTargets.filter((t) => t.status !== 'ok');

  // 存入项目产出 + 同步企业大脑（addAsset 内部自动调 syncAssetConclusionToKnowledge 回流）
  function saveCrisisReport() {
    if (resultTargets.length === 0 || !currentCompany) {
      setFormError('当前无扫描结果或企业上下文，无法保存');
      return;
    }
    const rows = resultTargets.map((t) => {
      const meta = riskOf(t);
      const stat = t.status === 'ok'
        ? `命中 ${t.total} 条 · 疑似负面 ${t.negativeCount} 条`
        : `数据未完整获取（${t.limitedReason || '本地爬虫受限'}）`;
      const ai = t.llmText
        ? `${[`**【${crisisLlmLabel(webHealth)}】**`, noWebDeclaration(webHealth)].filter(Boolean).join('\n\n')}\n\n${t.llmText}`
        : (t.llmError ? `AI 结论获取失败：${t.llmError}` : '未返回 AI 结论');
      return `## ${t.name}（${t.kind === 'main' ? '主品牌' : '旗下 IP'}）\n风险等级：${meta.label}\n${stat}\n\n${ai}`;
    }).join('\n\n---\n\n');
    const header = `# 品牌矩阵舆情扫描报告 · ${parentName || '当前企业'}\n\n监控对象 ${resultTargets.length} 个 · 平台 ${platformKeys.length || platforms.length} 个 · 命中 ${totalItems} 条 · 疑似负面 ${totalNeg} 条\n\n---\n\n`;
    const name = `舆情扫描报告 · ${parentName || '当前企业'}`;
    addAsset({
      type: 'crisis_report',
      companyId: currentCompany.id,
      projectId: currentProject ? currentProject.id : null,
      name,
      content: header + rows,
      tags: ['舆情', '品牌监控', '危机'],
    });
    setSavedName(name);
    setFormError('');
  }

  /** 已有监控对象名称（主品牌 + 已登记 IP + 别名），供 AI 去重，避免重复生成。 */
  const existingNames = useMemo(() => {
    const s = new Set();
    if (parentName) s.add(parentName);
    ips.forEach((ip) => {
      if (ip.name) s.add(ip.name);
      (ip.aliases || []).forEach((a) => s.add(a));
    });
    return Array.from(s);
  }, [parentName, ips]);

  /** AI 根据企业画像生成旗下 IP / 子品牌候选。 */
  async function runAIIps() {
    if (!currentCompany) {
      setFormError('请先选择 / 建档企业，再让 AI 生成旗下 IP');
      return;
    }
    setFormError('');
    setAiIpsBusy(true);
    try {
      const list = await genBrandIps({
        currentCompany,
        asset,
        knowledge: getKnowledge(companyId),
        existingNames,
        companyType: currentCompany ? currentCompany.type : 'manufacturer',
      });
      setAiIps(list);
      setAiIpsChecked(new Set(list.map((x) => x.name)));
      if (!list.length) {
        setFormError('AI 未能从当前企业画像推导出新的子品牌候选。请补充「产品 / 服务、品牌定位」后再试，或手动添加。');
      }
    } catch {
      setAiIps([]);
      setFormError('AI 生成旗下 IP 失败，请手动添加');
    } finally {
      setAiIpsBusy(false);
    }
  }

  function toggleAiIp(name) {
    setAiIpsChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** 把勾选的候选登记进企业知识库（brandIps），与已登记的合并去重。 */
  function registerSelectedIps() {
    if (!currentCompany) return;
    const picked = aiIps.filter((x) => aiIpsChecked.has(x.name));
    if (!picked.length) {
      setFormError('请先勾选要登记的 IP');
      return;
    }
    const existByName = new Set(ips.map((ip) => asLower(ip.name)));
    const next = ips.slice();
    picked.forEach((x) => {
      if (existByName.has(asLower(x.name))) return; // 已存在，跳过
      next.push(normalizeBrandIp({
        id: '',
        name: x.name,
        aliases: x.aliases || [],
        note: x.note ? `${x.note}${x.reason ? `（${x.reason}）` : ''}` : (x.reason || ''),
        enabled: true,
        createdAt: Date.now(),
      }));
    });
    setBrandIps(companyId, next);
    setAiIps([]);
    setAiIpsChecked(new Set());
    setFormError('');
  }

  /** 风险最高的 IP（unknown 不参与「最高风险」评选，避免把"没查到"当风险冠军）。 */
  const topRisk = useMemo(() => {
    let best = null;
    resultTargets.forEach((t) => {
      const meta = riskOf(t);
      if (meta.rank <= 0) return;
      if (!best || meta.rank > riskOf(best).rank) best = t;
    });
    return best;
  }, [resultTargets]);

  /** 按平台视角：把各 IP 的条目摊平后按平台归并。 */
  const byPlatform = useMemo(() => {
    const rows = platformKeys.length ? platformKeys : [];
    return rows.map((key) => {
      const list = [];
      resultTargets.forEach((t) => {
        (t.platforms || []).forEach((p) => {
          if (p.platform === key) (p.items || []).forEach((it) => list.push(it));
        });
      });
      const blockedAll = resultTargets.length > 0 && resultTargets.every(
        (t) => (t.platforms || []).some((p) => p.platform === key && p.blocked),
      );
      return {
        platform: key,
        label: labelOf(key),
        items: list,
        total: list.length,
        negativeCount: list.filter((x) => x && x.negative).length,
        blocked: blockedAll,
      };
    });
  }, [resultTargets, platformKeys]);

  /**
   * 扫描单个监控对象：爬虫 + LLM 并行。
   * @param {{id:string,name:string,aliases:string[],note:string,kind:string}} t 监控对象
   * @param {string[]} selected 平台 key 列表
   * @param {Map<string, object>} seen 全局去重表（跨词复用）
   * @returns {Promise<object>} 该对象的结果块
   */
  async function scanOneTarget(t, selected, seen) {
    const aliasText = t.aliases && t.aliases.length ? `（也叫：${t.aliases.join('、')}）` : '';
    const noteText = t.note ? `（${t.note}）` : '';
    const kindText = t.kind === 'main' ? '主品牌 / 公司主体' : '旗下 IP / 子品牌';

    // (a) 本地百度爬虫：只支持单个 brand，故一词一次请求
    const crawlPromise = (async () => {
      try {
        const r = await fetch(`${BACKEND}/api/crisis/scan-local`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand: t.name, platforms: selected, maxPer: 5 }),
        });
        const j = await r.json().catch(() => null);
        if (!j) return { ok: false, throttled: false, error: '本地爬虫无响应', results: [] };
        if (j.ok !== true) {
          return { ok: false, throttled: false, error: String(j.error || '本地爬虫失败'), results: [] };
        }
        if (j.throttled === true) {
          return {
            ok: false,
            throttled: true,
            error: String(j.error || '触发百度反爬节流，本次未获取'),
            results: [],
          };
        }
        return { ok: true, throttled: false, error: '', results: Array.isArray(j.results) ? j.results : [] };
      } catch (e) {
        return { ok: false, throttled: false, error: (e && e.message) || String(e), results: [] };
      }
    })();

    // (b) LLM 联网检索：每个 IP 单独一条 prompt，避免把几个品牌混在一起问
    const llmPromise = (async () => {
      const platText = selected.map(labelOf).join('、');
      // 提示词里保留「请联网检索」指令（删掉会让模型彻底不再尝试），并追加「能力诚实兜底」——
      // 模型若无法真正联网，必须明说「本轮无法联网检索」，禁止用「本次未检索到明显负面」搪塞。
      const q = buildCrisisScanPrompt({
        name: t.name,
        parentName: parentName || t.name,
        kindText,
        aliasText,
        noteText,
        platText,
      });

      try {
        const r = await chatOnce(
          [{ role: 'user', content: q }],
          buildAIContext({ company: currentCompany, asset, knowledge: getKnowledge(companyId) }),
          { enableSearch: true, temperature: 0.3, reasoningEffort: 'none' },
        );
        return {
          ok: !!(r && r.ok && r.content),
          text: (r && r.content) || '',
          error: r && r.ok ? '' : ((r && r.error) || '未返回结果'),
        };
      } catch (e) {
        return { ok: false, text: '', error: (e && e.message) || String(e) };
      }
    })();

    const [crawl, llm] = await Promise.all([crawlPromise, llmPromise]);

    // 合并爬虫条目：补 word 字段（命中了哪个监控词），并做全局去重
    const items = [];
    (crawl.results || []).forEach((c) => {
      const list = Array.isArray(c && c.items) ? c.items : [];
      list.forEach((raw) => {
        const key = dedupeKey(raw);
        if (seen.has(key)) {
          const prev = seen.get(key);
          if (prev && Array.isArray(prev.alsoWords) && !prev.alsoWords.includes(t.name)) {
            prev.alsoWords.push(t.name);
          }
          return; // 不同词命中同一条内容 → 只保留首次，避免重复计数
        }
        const item = {
          ...raw,
          word: t.name,
          wordId: t.id,
          platform: c.platform || '',
          platformLabel: labelOf(c.platform),
          alsoWords: [],
        };
        seen.set(key, item);
        items.push(item);
      });
    });

    const crawlMap = {};
    (crawl.results || []).forEach((c) => {
      if (c && c.platform) crawlMap[c.platform] = c;
    });

    const platRows = selected.map((key) => {
      const c = crawlMap[key] || null;
      const rows = items.filter((it) => it.platform === key);
      const blocked = !!((c && c.blocked) || (!c && !crawl.ok));
      return {
        platform: key,
        label: labelOf(key),
        blocked,
        total: c && typeof c.total === 'number' ? c.total : rows.length,
        negativeCount: rows.filter((x) => x && x.negative).length,
        items: rows,
      };
    });

    const blockedCount = platRows.filter((p) => p.blocked).length;
    const allBlocked = platRows.length > 0 && blockedCount === platRows.length;
    const crawlBad = !crawl.ok || allBlocked;
    // ok      = 爬虫拿到数据，条数可信
    // partial = 爬虫没拿到，但 AI 联网检索有结论（只可定性，不可计数）
    // limited = 两者都没有 → 明确「本次未能获取」，绝不显示成"未发现"
    const status = crawlBad ? (llm.ok ? 'partial' : 'limited') : 'ok';
    let limitedReason = '';
    if (crawlBad) {
      limitedReason = crawl.throttled
        ? `触发百度反爬节流：${crawl.error || '请稍后重试'}`
        : (crawl.error || (allBlocked ? '全部平台爬虫受限（百度反爬）' : '本地爬虫未返回结果'));
    }

    return {
      id: t.id,
      name: t.name,
      aliases: t.aliases || [],
      note: t.note || '',
      kind: t.kind,
      status,
      limitedReason,
      blockedCount,
      platforms: platRows,
      items,
      total: items.length,
      negativeCount: items.filter((x) => x && x.negative).length,
      llmOk: !!llm.ok,
      llmText: llm.text || '',
      llmError: llm.error || '',
    };
  }

  async function scan() {
    const targets = monitorTargets.slice();
    if (!targets.length) {
      setFormError('至少需要一个监控对象：请先到「🗂 资产库」建档带出主品牌，或先「+ 添加 IP」。');
      return;
    }
    if (!platforms.length) {
      setFormError('请至少选择一个扫描平台');
      return;
    }
    setFormError('');

    const selected = platforms.slice();
    const seen = new Map();

    await startJob(jobKey, async () => {
      const t0 = Date.now();
      const out = [];

      // 串行 + 错峰：后端按 brand 做 30s 节流，并发会被自己的节流拦掉
      for (let i = 0; i < targets.length; i += 1) {
        const t = targets[i];
        setScanProgress(jobKey, { done: i, total: targets.length, word: t.name, phase: '正在扫描' });
        const one = await scanOneTarget(t, selected, seen);
        out.push(one);
        setScanProgress(jobKey, { done: i + 1, total: targets.length, word: t.name, phase: '已完成' });
        if (i < targets.length - 1) await sleep(WORD_GAP_MS);
      }
      setScanProgress(jobKey, { phase: '全部完成' });

      const neg = out.reduce((s, p) => s + (p.negativeCount || 0), 0);
      const limited = out.filter((p) => p.status !== 'ok').length;
      const elapsed = (Date.now() - t0) / 1000;
      const noteParts = [`${out.length} 个监控对象 × ${selected.length} 个平台`];
      noteParts.push(neg > 0 ? `捕获 ${neg} 条疑似负面` : '未捕获到明显负面');
      if (limited > 0) noteParts.push(`${limited} 个对象数据不完整（受限）`);

      return {
        ok: true,
        result: {
          parentName,
          platformKeys: selected,
          targets: out,
          durationSec: elapsed,
        },
        note: noteParts.join(' · '),
      };
    });
  }

  /** 单个原始条目渲染（平台视角与 IP 视角共用）。 */
  function renderItem(it, j, showWord) {
    return (
      <div className="crisis-capture-item" key={`${it.title || j}-${j}`}>
        <div className="crisis-capture-top">
          <span className="crisis-capture-source">{it.platformLabel || labelOf(it.platform)}</span>
          {showWord && it.word ? <Tag className="crisis-word-tag">{it.word}</Tag> : null}
          {it.negative ? <span className="crisis-tag-neg">负面</span> : <span className="crisis-tag-neu">中性</span>}
          {Array.isArray(it.alsoWords) && it.alsoWords.length ? (
            <span className="crisis-also">同时命中：{it.alsoWords.join('、')}</span>
          ) : null}
        </div>
        <div className="crisis-capture-title">{it.title || '(无标题)'}</div>
        {it.summary ? <div className="crisis-capture-summary">{it.summary}</div> : null}
        {it.url ? (
          <a className="crisis-capture-link" href={it.url} target="_blank" rel="noreferrer">查看原文</a>
        ) : (
          <span className="crisis-capture-link muted">原文链接不可用</span>
        )}
      </div>
    );
  }

  function renderItemsCollapse(list, label) {
    if (!Array.isArray(list) || !list.length) return null;
    return (
      <Collapse
        style={{ marginTop: 8 }}
        items={[{
          key: 'raw',
          label,
          children: <div className="crisis-capture-list">{list.map((it, j) => renderItem(it, j, true))}</div>,
        }]}
      />
    );
  }

  return (
    <div className="module-page">
      <div className="module-page-head">
        <h2 className="module-page-title">🚨 舆情监控</h2>
        <p className="module-page-sub">
          盯着网上有没有人说你坏话。主品牌和旗下品牌分开看。
        </p>
      </div>

      <div className="xm-form">
        {!hasAsset && (
          <div className="xm-note" style={{ background: 'var(--c-warn-tint)', borderColor: 'rgba(255,214,10,0.5)', color: 'var(--c-warn)' }}>
            尚未建档。建议先到「🗂 资产库」一键建档，主品牌会自动带出；也可直接在下方添加旗下 IP。
            {onSelectModule && (
              <div style={{ marginTop: 8 }}>
                <Button size="small" type="primary" ghost onClick={() => onSelectModule('asset')}>去资产库建档 →</Button>
              </div>
            )}
          </div>
        )}

        {/* ---------- 监控对象（主品牌 + 旗下 IP） ---------- */}
        <div className="xm-field">
          <label className="field-label">监控对象</label>
          <div className="crisis-monitor-box">
            <BrandIpManager companyId={companyId} mainBrandName={parentName} />
          </div>

          {/* AI 生成旗下 IP 候选 */}
          <div className="crisis-aiips" style={{ marginTop: 10 }}>
            {aiIps.length === 0 ? (
              <Button size="small" onClick={runAIIps} disabled={aiIpsBusy || busy} loading={aiIpsBusy}>
                ✨ AI 帮我生成旗下 IP
              </Button>
            ) : (
              <div className="crisis-aiips-panel">
                <div className="crisis-aiips-head">
                  <span>AI 推断了 {aiIps.length} 个可能的子品牌 / 产品线，勾选后一键登记：</span>
                </div>
                <div className="crisis-aiips-list">
                  {aiIps.map((x) => (
                    <label className={`crisis-aiips-item${aiIpsChecked.has(x.name) ? ' checked' : ''}`} key={x.name}>
                      <input
                        type="checkbox"
                        checked={aiIpsChecked.has(x.name)}
                        onChange={() => toggleAiIp(x.name)}
                      />
                      <span className="crisis-aiips-name">{x.name}</span>
                      {(x.aliases || []).map((a) => <Tag key={a} className="bip-alias-tag">{a}</Tag>)}
                      {x.note ? <span className="crisis-aiips-note">{x.note}</span> : null}
                      {x.reason ? <span className="crisis-aiips-reason">为什么：{x.reason}</span> : null}
                    </label>
                  ))}
                </div>
                <div className="crisis-aiips-foot">
                  <Button size="small" type="primary" onClick={registerSelectedIps} disabled={busy}>
                    一键登记选中
                  </Button>
                  <Button size="small" onClick={() => { setAiIps([]); setAiIpsChecked(new Set()); }}>
                    取消
                  </Button>
                  <span className="crisis-aiips-hint">已登记的会按名称自动去重，不会重复添加。</span>
                </div>
              </div>
            )}
          </div>

          {monitorTargets.length > 0 && (
            <div className="crisis-monitor-summary">
              本轮将扫描
              {' '}
              <b>{monitorTargets.length}</b>
              {' '}
              个监控对象：
              {monitorTargets.map((t) => (
                <Tag key={t.id} color={t.kind === 'main' ? 'success' : 'default'} className="crisis-monitor-tag">
                  {t.kind === 'main' ? `${t.name}（主品牌）` : t.name}
                </Tag>
              ))}
            </div>
          )}
        </div>

        <div className="xm-field">
          <label className="field-label">扫描平台</label>
          <Checkbox.Group
            options={PLATFORM_OPTIONS}
            value={platforms}
            onChange={(vals) => setPlatforms(vals)}
          />
        </div>

        <div className="xm-actions">
          <Button type="primary" onClick={scan} disabled={busy} loading={busy}>
            {busy ? '扫描中（可切换页面，回来结果仍在）' : '开始扫描'}
          </Button>
          {busy && progress.total > 0 && (
            <span className="crisis-progress">
              正在扫描 {Math.min(progress.done + 1, progress.total)}/{progress.total}：{progress.word}
            </span>
          )}
        </div>
        {shownError && <div className="xm-error">⚠️ {shownError}</div>}
      </div>

      {resultTargets.length > 0 && (
        <div className="xm-result">
          <div className="xm-result-head crisis-result-head">
            <span>
              品牌矩阵扫描结果
              {parentName ? ` · ${parentName}` : ''}
              {typeof durationSec === 'number' ? ` · 耗时 ${durationSec.toFixed(1)} 秒` : ''}
              {scanNote ? ` · ${scanNote}` : ''}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button size="small" onClick={saveCrisisReport} disabled={busy || !currentCompany}>
                {savedName ? '已保存 ✓' : '存入产出并同步'}
              </Button>
              <Segmented
                size="small"
                value={view}
                onChange={(v) => setView(v)}
                options={[{ label: '按 IP 看', value: 'ip' }, { label: '按平台看', value: 'platform' }]}
              />
            </div>
          </div>

          {/* ---------- 顶部总览 ---------- */}
          <div className="crisis-overview">
            <div className="crisis-ov-item">
              <span className="crisis-ov-num">{resultTargets.length}</span>
              <span className="crisis-ov-label">监控对象</span>
            </div>
            <div className="crisis-ov-item">
              <span className="crisis-ov-num">{platformKeys.length || platforms.length}</span>
              <span className="crisis-ov-label">平台</span>
            </div>
            <div className="crisis-ov-item">
              <span className="crisis-ov-num">{totalItems}</span>
              <span className="crisis-ov-label">命中条目</span>
            </div>
            <div className="crisis-ov-item">
              <span className="crisis-ov-num" style={{ color: totalNeg > 0 ? 'var(--c-danger)' : 'var(--c-brand-dark)' }}>{totalNeg}</span>
              <span className="crisis-ov-label">疑似负面</span>
            </div>
            <div className="crisis-ov-item crisis-ov-risk">
              <span className="crisis-ov-label">风险最高</span>
              {topRisk ? (
                <span className="crisis-ov-highlight" style={{ color: riskOf(topRisk).color }}>
                  {topRisk.name} · {riskOf(topRisk).label}
                </span>
              ) : (
                <span className="crisis-ov-label">
                  {limitedTargets.length ? '暂不可判定（含未获取项）' : '无'}
                </span>
              )}
            </div>
          </div>

          {limitedTargets.length > 0 && (
            <div className="crisis-limited-banner">
              ⚠️ 有 {limitedTargets.length} 个监控对象本次未拿到完整数据（{limitedTargets.map((t) => t.name).join('、')}），
              结果里标记为「本次未获取 / 仅 AI 结论」，不代表它们安全。
            </div>
          )}

          {/* ---------- 视角一：按 IP 看 ---------- */}
          {view === 'ip' && (
            <div className="crisis-ip-list">
              {resultTargets.map((t, i) => {
                const rk = riskKeyOf(t);
                const meta = RISK_META[rk];
                const failed = t.status === 'limited';
                const partial = t.status === 'partial';
                const noData = failed || partial;
                return (
                  <div
                    className="crisis-ip-card"
                    key={t.id || i}
                    style={{ background: meta.bg, borderColor: meta.border }}
                  >
                    <div className="crisis-ip-head">
                      <span className="crisis-ip-name">{t.name}</span>
                      {t.kind === 'main' ? (
                        <Tag className="bip-kind-tag" color="success">主品牌</Tag>
                      ) : (
                        <Tag className="bip-kind-tag">旗下 IP</Tag>
                      )}
                      <Tooltip title={noData ? '本次未拿到可计数的爬虫数据，不判定为安全' : `风险等级：${meta.label}`}>
                        <span className="crisis-risk-badge" style={{ color: meta.color, borderColor: meta.border }}>
                          {meta.label}
                        </span>
                      </Tooltip>
                      {(t.aliases || []).map((a) => (
                        <Tag key={a} className="bip-alias-tag">{a}</Tag>
                      ))}
                    </div>

                    <div className="crisis-ip-meta">
                      {noData ? (
                        <span className="crisis-ip-meta-na">爬虫数据未获取，命中/负面条数不可用</span>
                      ) : (
                        <span>命中 {t.total} 条 · 疑似负面 {t.negativeCount} 条</span>
                      )}
                      <span>
                        平台可用 {t.platforms.length - (t.blockedCount || 0)}/{t.platforms.length}
                      </span>
                      {t.note ? <span className="crisis-ip-note">{t.note}</span> : null}
                    </div>

                    {failed ? (
                      <div className="crisis-ip-limited">
                        ⚠️ 本次未能获取：{t.limitedReason || '本地爬虫受限'}
                        <div className="crisis-ip-limited-sub">
                          这不代表「未发现负面」。请稍后重试该对象，或减少同时扫描的平台数以降低反爬概率。
                        </div>
                      </div>
                    ) : null}

                    {partial ? (
                      <div className="crisis-ip-limited crisis-ip-partial">
                        ⚠️ 本地爬虫未获取（{t.limitedReason || '本地爬虫受限'}），以下仅为 {crisisLlmLabel(webHealth)}，条数统计不可用。
                        <div className="crisis-ip-limited-sub">
                          结论可作定性参考，但不能用「0 条负面」当作安全依据。
                        </div>
                      </div>
                    ) : null}

                    {t.llmText ? (
                      <div className="xm-result-body crisis-ip-llm">
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'var(--c-text-2)',
                            marginBottom: 4,
                          }}
                        >
                          {crisisLlmLabel(webHealth)}
                        </div>
                        {noWebDeclaration(webHealth) ? (
                          <div
                            style={{
                              margin: '0 0 8px',
                              padding: '6px 10px',
                              background: 'var(--c-danger-tint)',
                              border: '1px solid rgba(255,69,58,0.35)',
                              borderRadius: 6,
                              color: 'var(--c-danger)',
                              fontSize: 12,
                              lineHeight: 1.5,
                            }}
                          >
                            ⚠️ {noWebDeclaration(webHealth)}
                          </div>
                        ) : null}
                        <Markdown>{t.llmText}</Markdown>
                      </div>
                    ) : (
                      <div className="xm-note">
                        {t.llmError ? `AI 结论获取失败：${t.llmError}` : '未返回 AI 结论。'}
                      </div>
                    )}

                    {!noData && t.blockedCount > 0 && (
                      <div className="xm-note">
                        有 {t.blockedCount} 个平台爬虫受限（百度反爬），该对象的数据可能不完整。
                      </div>
                    )}

                    {renderItemsCollapse(t.items, `原始条目（${t.total} 条，其中 ${t.negativeCount} 条疑似负面）`)}
                  </div>
                );
              })}
            </div>
          )}

          {/* ---------- 视角二：按平台看 ---------- */}
          {view === 'platform' && (
            <div className="crisis-platform-list">
              {byPlatform.map((p, i) => {
                const hasItems = p.items.length > 0;
                const statusText = p.blocked
                  ? '爬虫受限（百度反爬）'
                  : (p.negativeCount > 0 ? `⚠️ ${p.negativeCount} 条疑似负面` : '✅ 未发现明显负面');
                return (
                  <div className="crisis-platform" key={(p.platform || i) + i}>
                    <div className="crisis-platform-head">
                      <span className="crisis-platform-name">{p.label} · {statusText}</span>
                    </div>
                    {hasItems ? (
                      <div className="crisis-capture-list">
                        {p.items.map((it, j) => renderItem(it, j, true))}
                      </div>
                    ) : (
                      <div className="xm-note">{p.blocked ? '该平台本次爬虫受限，请以各 IP 的 AI 结论为准。' : '该平台未捕获到条目。'}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {resultTargets.length === 0 && durationSec != null && !busy && (
        <div className="xm-empty">{scanNote || '本次扫描未捕获到负面内容。'}</div>
      )}

      {resultTargets.length === 0 && !busy && !jobError && !formError && (
        <Alert
          className="crisis-guide"
          type="success"
          showIcon
          message="建议先把旗下品牌登记完整"
          description="只搜母公司会漏掉旗下品牌的舆情。把每个子品牌都登记进来，就能分开看谁在挨骂。"
        />
      )}
    </div>
  );
}
