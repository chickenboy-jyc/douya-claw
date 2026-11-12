import React, { useEffect, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { useMarketingAsset, useMarketingGoal } from '../store/marketingStore.jsx';
import { isAiReady, readSettingsAi } from '../services/aiReadiness.js';

/**
 * FeedTheBuddyCard —— 「把豆芽喂饱」引导卡。
 *
 * 为什么存在：首登流程从 10 屏砍到 4 屏，被后置的 7 屏（基础资料 / 品牌归属 / 竞品调性 / 年度目标 /
 * 经营方向）不能丢 —— 本卡承接这批能力，挂在工作台首页顶部，引导用户在工作台里补齐。
 *
 * 三个动作（对齐架构设计 §T04）：
 *   ① 补全企业资料 → 打开企业大脑的「资产」分区（`onOpenProfile('asset')`，缺省回落 `onSelectModule('profile')`）；
 *   ② 跑一次企业体检 → `onRunCheckup()`（**用户主动点 = 重跑**，由 App 注入的不带 guard 入口承担），
 *      跑完**直接落在「企业大脑」Tab**（`onOpenProfile('brain')`）—— 体检结论 🩺 就在那里，**一跳即见**；
 *   ③ 定目标 / 选方案 → `onSelectModule('goal')`。
 *
 * 不再打扰（任一成立即隐藏）：
 *   · 用户点过本卡「×」→ 按企业记忆在 localStorage `douya-feed-dismissed`（本组件自读自写，不新增 store）；
 *   · 当前企业「已建档 **且** 已绑定目标」→ 说明已喂饱，无需再提醒。
 *
 * AI 未就绪（判据统一在 `services/aiReadiness.js`，与主进程 backend.js 同源 —— **不是**「有没有填 Key」，
 * 内网网关零配置登录即用也算就绪）：
 *   · 「跑体检」这类需要 AI 的按钮 disabled + hover 说明；**纯跳转按钮仍可用**（不拦路）。
 *
 * 数据来源全为既有 store：营销资产 / 营销目标（marketingStore）+ 本组件自读 localStorage。
 * 不新增任何存储 key（dismiss key 属 UI 偏好，不属企业数据）。
 */

/** 按企业记忆「已喂饱、不再打扰」的 localStorage key（值为 { [companyId]: true } 的对象）。 */
export const FEED_DISMISS_KEY = 'douya-feed-dismissed';

/** 安全读 JSON（localStorage 缺失 / 脏数据一律回落）。 */
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 读「本企业是否已被用户手动关闭引导卡」。 */
function isDismissed(companyId) {
  if (!companyId) return false;
  const map = loadJSON(FEED_DISMISS_KEY, {});
  return !!(map && typeof map === 'object' && !Array.isArray(map) && map[companyId]);
}

/** 记忆「本企业引导卡已关闭」。写失败静默（仅 UI 偏好，不值得打断）。 */
function markDismissed(companyId) {
  if (!companyId) return;
  try {
    const map = loadJSON(FEED_DISMISS_KEY, {});
    const next = map && typeof map === 'object' && !Array.isArray(map) ? { ...map } : {};
    next[companyId] = true;
    localStorage.setItem(FEED_DISMISS_KEY, JSON.stringify(next));
  } catch {
    /* 忽略写失败 */
  }
}

/** 自读 AI 是否就绪（与 App 同源判据 services/aiReadiness.js：内网网关零配置登录即用也算就绪）。 */
function readAiReady() {
  return isAiReady(readSettingsAi());
}

/**
 * 「把豆芽喂饱」引导卡。
 * @param {{companyId?:string|null, companyName?:string, onSelectModule?:(m:string)=>void, onRunCheckup?:()=>Promise<{ok:boolean,error?:string}>, onOpenProfile?:(tab:'asset'|'brain'|'brand')=>void}} props
 */
export default function FeedTheBuddyCard({ companyId, companyName = '', onSelectModule, onRunCheckup, onOpenProfile }) {
  const { hasAsset } = useMarketingAsset();
  const { goal } = useMarketingGoal();

  const [dismissed, setDismissed] = useState(() => isDismissed(companyId));
  const [aiReady, setAiReady] = useState(() => readAiReady());
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');

  // 切换企业 / 重新挂载时，重读「本企业是否已关闭」与「AI 是否就绪」。
  useEffect(() => {
    setDismissed(isDismissed(companyId));
    setAiReady(readAiReady());
    setStatus('');
  }, [companyId]);

  const fed = !!hasAsset && !!goal; // 已建档 + 已绑目标 ⇒ 已喂饱，不再打扰
  if (!companyId || dismissed || fed) return null;

  function close() {
    markDismissed(companyId);
    setDismissed(true);
  }

  function go(moduleKey) {
    if (onSelectModule) onSelectModule(moduleKey);
  }

  /** 打开企业资产库并指定 Tab（App 未注入 onOpenProfile 时回落为普通跳 profile）。 */
  function openProfile(tabKey) {
    if (typeof onOpenProfile === 'function') onOpenProfile(tabKey);
    else go('profile');
  }

  async function runCheckup() {
    if (!aiReady || running) return;
    setRunning(true);
    setStatus('⏳ 豆芽正在通读企业资料做体检…');
    let r = { ok: false, error: '' };
    try {
      if (typeof onRunCheckup === 'function') r = (await onRunCheckup()) || r;
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '体检失败' };
    }
    setRunning(false);
    setStatus(r.ok ? '✅ 体检完成，已跳到「企业大脑」看结论' : `⚠️ 本次体检未完成${r.error ? '：' + r.error : ''}，可稍后重试`);
    // 成功才跳转：直接落在「企业大脑」Tab（体检结论就在那里），失败留在本卡显原因，不假装成功。
    if (r.ok) openProfile('brain');
  }

  return (
    <div className="feed-buddy">
      <div className="feed-buddy-main">
        <div className="feed-buddy-head">
          <span className="feed-buddy-title">🌱 把豆芽喂饱，它才更懂你</span>
          <button type="button" className="feed-buddy-close" onClick={close} title="不再提示（按企业记住）" aria-label="不再提示">
            ✕
          </button>
        </div>
        <div className="feed-buddy-sub">
          {companyName ? `「${companyName}」还差几口：` : '还差几口：'}
          基础资料 · 品牌归属 · 竞品调性 · 年度目标 · 经营方向 —— 填一次，GEO / 新媒体 / 活动 / 经营诊断 全流程自动带出。
        </div>
        <div className="feed-buddy-actions">
          <Button size="small" onClick={() => openProfile('asset')}>① 补全企业资料</Button>
          <Tooltip title={aiReady ? '' : '先在「设置」里连上 AI，体检才能跑'}>
            <span className="feed-buddy-ai-btn">
              <Button size="small" type="primary" disabled={!aiReady} loading={running} onClick={runCheckup}>
                ② 跑一次企业体检
              </Button>
            </span>
          </Tooltip>
          <Button size="small" onClick={() => go('goal')}>③ 定目标 / 选方案</Button>
        </div>
        {status ? (
          <div className={status.startsWith('✅') ? 'feed-buddy-note' : 'feed-buddy-warn'}>{status}</div>
        ) : null}
      </div>
    </div>
  );
}
