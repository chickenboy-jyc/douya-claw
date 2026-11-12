import React, { useMemo, useState } from 'react';
import { useBackgroundJobs } from '../store/backgroundJobs.js';
import { describeFailure } from '../services/chatFailure.js';

/**
 * BackgroundJobsBar —— 全局「豆芽正在后台做」指示条（右下角悬浮胶囊）。
 *
 * 解决的用户诉求：
 *   「经营诊断无法后台开始跑，好像所有那种 AI 的都无法后台跑」
 *   → 生成任务本身早就能跨模块继续跑（store/backgroundJobs.js），但用户**看不见**，
 *     以为点了没反应/切走就没了。本组件把后台任务暴露出来：谁在跑、跑完了没、点一下跳回去看。
 *
 * 行为：
 *   - 正在跑（busy）：常驻显示，列出任务名 + 耗时秒数。
 *   - 刚跑完（5 分钟内且未被「知道了」）：显示「已完成 / 失败」，可点开或忽略。
 *   - 点击条目 → onSelectModule(module) 跳到对应模块查看结果。
 *   - 无任务 / 全部已忽略 → 整块不渲染（不占位、不打扰）。
 *
 * 红线：只做「状态可见 + 跳转」，不在这里读写任何业务数据。
 */

/** job key 前缀 → 人话名称 + 目标模块（与各模块 startJob 的 key 约定一致）。 */
const JOB_META = [
  { prefix: 'diagnosis-', label: '经营诊断', module: 'intel' },
  // 竞品对比的独立模块已下线，其唯一展示出口归并进「经营诊断」内嵌矩阵
  // （老板反馈 #7）。任务条点击必须改指 intel，否则会跳到不存在的模块、内容区空白。
  { prefix: 'competitor-', label: '竞品对比分析', module: 'intel' },
  { prefix: 'crisis-', label: '舆情危机扫描', module: 'crisis' },
  { prefix: 'wenan-', label: '文案生成', module: 'xinmeiti' },
  // 以下四类是本轮（0.21.15）新接入后台任务的功能。不登记的话会落到兜底
  // { label:'豆芽任务', module:'' } —— 用户切页后看到「豆芽任务」且点了不跳（死点击）。
  // 注意顺序无关但**必须写全**：metaOf 用 indexOf(prefix)===0 取首个前缀命中，
  // 所以 activity-chat 的两个变体要分别精确到 plan / learn，不能用 'activity-chat-' 泛匹配。
  // 【0.21.21 · 老板 2026-10-21】`activity-chat-plan-` 的落点从 `activity` 改成 `campaign`。
  // 「活动与档期」整板块下线后 `activity` 已不是一个存在的模块；虽然 App.jsx 的
  // LEGACY_MODULE_ALIAS 会把它兜到 workbench（不会白屏），但那是**兜底**不是**正确落点**——
  // 用户点「做活动方案」应该看到活动方案页，而不是被丢回豆芽助手。
  // `campaign`（营销专项）就是「一句话出一套活动方案」那一页，正是这个任务产出的地方。
  // 这与上面 30-31 行竞品对比「必须改指 intel，否则跳到不存在的模块」是同一条规则。
  { prefix: 'activity-chat-plan-', label: '做活动方案', module: 'campaign' },
  { prefix: 'activity-chat-learn-', label: '学习中心提问', module: 'learn' },
  { prefix: 'content-chat-', label: '内容创作', module: 'content' },
  { prefix: 'replenish-alt-', label: '查同品类替代', module: 'replenish' },
  // 【0.21.25 用户报障】视频设计（出图 / 出视频）接入 backgroundJobs 后必须登记在这里。
  // 不登记就会落到下面的兜底 `{ label:'豆芽任务', module:'' }` ⇒ 用户切页后看到
  // 「豆芽任务」且点了**不跳**（死点击）；而这一次修的恰恰是"切走再回来结果丢了"，
  // 点不回去等于修了一半。落点 `videodesign` 就是产出这些图/视频的那一页本身。
  { prefix: 'videodesign-', label: '出图 / 出视频', module: 'videodesign' },
];

/** 完成态在指示条上保留的时长（毫秒）。超时后自动隐藏，避免翻出历史残留。 */
const DONE_TTL = 5 * 60 * 1000;

function metaOf(key) {
  const k = String(key || '');
  const hit = JOB_META.find((m) => k.indexOf(m.prefix) === 0);
  return hit || { label: '豆芽任务', module: '' };
}

/** 毫秒 → 「12 秒」/「1 分 05 秒」。 */
function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/**
 * @param {Object} props
 * @param {Function} [props.onSelectModule] 点击条目时跳转模块
 * @param {number} [props.now] 可注入的当前时间戳（便于测试）
 */
export default function BackgroundJobsBar({ onSelectModule, now }) {
  const jobs = useBackgroundJobs();
  // 「知道了」记录：{ [key]: at } —— at 与 job.at 一致才算已忽略，任务重跑后自动重新出现
  const [dismissed, setDismissed] = useState({});
  // 心拍：每 5 秒触发一次重渲染，让「已跑 N 秒」与 DONE_TTL 过期能自己刷新。
  // 注意 tick 只当触发器用，时间值一律现取 Date.now()。
  const [, setTick] = useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  const t = typeof now === 'number' ? now : Date.now();

  const { running, done } = useMemo(() => {
    const list = Array.isArray(jobs) ? jobs : [];
    const running = list.filter((j) => j && j.busy);
    const done = list.filter(
      (j) =>
        j &&
        !j.busy &&
        j.at &&
        (j.result !== null && j.result !== undefined ? true : !!j.error) &&
        !(dismissed[j.key] === j.at),
    );
    return { running, done };
  }, [jobs, dismissed]);

  // 完成态只保留最近的、且未超时的（超时的不再打扰）
  const doneVisible = done.filter((j) => t - j.at <= DONE_TTL).slice(0, 3);

  if (running.length === 0 && doneVisible.length === 0) return null;

  function open(moduleKey) {
    if (moduleKey && typeof onSelectModule === 'function') onSelectModule(moduleKey);
  }

  return (
    <div className="bgjobs" role="status" aria-live="polite">
      {running.length > 0 ? (
        <div className="bgjobs-group">
          <div className="bgjobs-hd">
            <span className="bgjobs-dot" />
            <span className="bgjobs-title">豆芽正在后台做 {running.length} 件</span>
            <span className="bgjobs-hint">可以切页面，做完会告诉你</span>
          </div>
          {running.map((j) => {
            const meta = metaOf(j.key);
            return (
              <div
                className="bgjobs-item"
                key={j.key}
                onClick={() => open(meta.module)}
                title={meta.module ? '去看看' : ''}
                style={meta.module ? undefined : { cursor: 'default' }}
              >
                <span className="bgjobs-name">{meta.label}</span>
                <span className="bgjobs-time">已跑 {fmtAgo(t - (j.at || t))}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {doneVisible.length > 0 ? (
        <div className="bgjobs-group bgjobs-group-done">
          {doneVisible.map((j) => {
            const meta = metaOf(j.key);
            const ok = !j.error;
            /**
             * 【第二十二轮 · 老板第 5 条 a】失败那一行也要说清**是哪一类**。
             * 改前只有「失败了」三个字 + job.error 原文塞在别处 —— 用户分不出"该等"还是该改配置。
             * 类别来自统一归类（超时 / 连不上 / 鉴权 / 服务端 / 你已取消 / 没拿到内容），
             * 与三个对话区用的是同一份判定，不会出现"任务条说超时、气泡说网络错"。
             */
            const fail = ok ? null : describeFailure({
              note: j.note,
              timedOut: j.timedOut,
              message: j.error,
            });
            return (
              <div
                className="bgjobs-item bgjobs-item-done"
                key={j.key}
                data-bgjobs-state={ok ? 'done' : 'fail'}
                data-chat-failure={fail ? fail.kind : undefined}
                title={fail ? fail.text : ''}
              >
                <span className={'bgjobs-badge' + (ok ? ' ok' : ' bad')}>{ok ? '✓' : '!'}</span>
                <span className="bgjobs-name">
                  {meta.label}
                  {ok ? ' 做完了' : ` 失败了 · ${fail.headline}`}
                </span>
                {meta.module ? (
                  <button type="button" className="bgjobs-link" onClick={() => open(meta.module)}>
                    去看
                  </button>
                ) : null}
                <button
                  type="button"
                  className="bgjobs-close"
                  title="知道了"
                  onClick={() => setDismissed((d) => ({ ...d, [j.key]: j.at }))}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
