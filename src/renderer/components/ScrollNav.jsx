import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../styles/chat-ux.css';

/**
 * ScrollNav —— 对话区的「回到最上面 / 回到最新」悬浮控件（老板第 4 条）。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 老板原话（逐字）：
 *   「现在豆芽助手 还有其他的对话框都加一个 点击到最顶部 点击到最新对话，
 *     这样就不用上滑下滑了。」
 *
 * 为什么做成**一个**组件而不是每页各写一遍：
 *   「当前在不在底部」这件事有 4 个坑，散着写必然改歪其中一两处：
 *     ① 阈值：`scrollTop === scrollHeight - clientHeight` 这种严格相等几乎永远不成立
 *        （滚动是小数像素），必须给容差；
 *     ② 内容比容器短时**不该出现任何按钮**（否则点了没反应，用户以为坏了）；
 *     ③ 新消息到达时**不许**把正在看历史的用户拽到底部 —— 这是聊天软件的常识，
 *        也是老板那句"不用上滑下滑"的隐含前提；正确做法是在「回到最新」上挂未读角标；
 *     ④ 卸载时监听器 / 观察器必须一起摘掉，否则切页会泄漏。
 *   见 `computeScrollState` 的边界说明。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 【jsdom 的现实（如实写在这里，别指望自动测试能替）】
 *   jsdom 里 `scrollHeight` / `clientHeight` / `scrollTop` 恒为 0、`getBoundingClientRect()`
 *   恒为 0，**没有任何布局**。所以：
 *     · 「点了真的会滚」这一层**没有**被自动验证（真浏览器行为）；
 *     · 能验的是两件：`computeScrollState` 的判定逻辑（纯函数，含全部边界），
 *       以及组件结构（锚点在不在、角标显不显示、disabled 状态跟不跟着变）。
 *   为了让后两件在 jsdom 里可测，指标一律通过 `readMetrics(el)` 现读，
 *   测试里用 `Object.defineProperty` 把 scrollHeight/clientHeight/scrollTop 打在元素实例上
 *   即可驱动 —— 不引入任何"测试专用 prop"，生产路径与测试路径是同一份代码。
 * ════════════════════════════════════════════════════════════════════════
 */

/** 默认阈值：距顶部 ≤ 12px 算「在顶部」，距底部 ≤ 24px 算「在底部」。 */
export const SCROLL_TOP_THRESHOLD = 12;
export const SCROLL_BOTTOM_THRESHOLD = 24;

/**
 * 「当前滚动位置」的判定 —— **纯函数**，全部边界都在这里，不依赖任何 DOM。
 *
 * 边界口径（每一条都有单测，见 entry-interact 的 caseScrollNav）：
 *   · 正好在顶部（scrollTop=0）               → atTop=true
 *   · 差 1px 到顶（scrollTop=1，阈值 12）      → atTop=true（阈值内）
 *   · 差 1px 到底（在 maxScroll 上方 1px）      → atBottom=true（阈值内）
 *   · 内容比容器短（scrollHeight < clientHeight）→ scrollable=false（**不显示按钮**），
 *                                               且 atTop/atBottom 同时为 true
 *   · 容器高度 0（还没布局 / 折叠中）           → 不崩，scrollable=false
 *   · 任何字段是 NaN / undefined / 负数         → 按 0 处理，不抛错
 *
 * @param {Object} [m]
 * @param {number} [m.scrollTop] 当前滚动位置（px）
 * @param {number} [m.scrollHeight] 内容总高（px）
 * @param {number} [m.clientHeight] 可视高度（px）
 * @param {number} [m.topThreshold] 顶部容差
 * @param {number} [m.bottomThreshold] 底部容差
 * @returns {{atTop:boolean, atBottom:boolean, scrollable:boolean, maxScroll:number, distanceFromBottom:number}}
 */
export function computeScrollState(m) {
  const o = m || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const topThreshold = Number.isFinite(Number(o.topThreshold))
    ? Math.max(0, Number(o.topThreshold)) : SCROLL_TOP_THRESHOLD;
  const bottomThreshold = Number.isFinite(Number(o.bottomThreshold))
    ? Math.max(0, Number(o.bottomThreshold)) : SCROLL_BOTTOM_THRESHOLD;

  const scrollTop = num(o.scrollTop);
  const scrollHeight = num(o.scrollHeight);
  const clientHeight = num(o.clientHeight);

  // maxScroll 可能为负（内容比容器短）⇒ 夹到 0，这样 atBottom 的判据不会出现负数比较。
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  // 「能不能滚」= 真的有余量。1px 容差：亚像素高度差不算可滚，否则会出现
  // "按钮出来了但点了只动半像素"的观感。
  const scrollable = maxScroll > 1;
  const distanceFromBottom = Math.max(0, maxScroll - scrollTop);

  return {
    atTop: scrollTop <= topThreshold,
    atBottom: distanceFromBottom <= bottomThreshold,
    scrollable,
    maxScroll,
    distanceFromBottom,
  };
}

/**
 * 从元素上现读滚动指标。
 * 单独抽出来是为了让"读"这一件事只有一份实现（测试也打这个口径）。
 * @param {HTMLElement|null} el 滚动容器
 * @returns {{scrollTop:number, scrollHeight:number, clientHeight:number}}
 */
export function readMetrics(el) {
  if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  return {
    scrollTop: Number(el.scrollTop) || 0,
    scrollHeight: Number(el.scrollHeight) || 0,
    clientHeight: Number(el.clientHeight) || 0,
  };
}

/** 两个判定结果是否等价（避免每次 scroll 事件都 setState 造成无谓重渲染）。 */
function sameState(a, b) {
  return !!a && !!b
    && a.atTop === b.atTop
    && a.atBottom === b.atBottom
    && a.scrollable === b.scrollable
    && a.maxScroll === b.maxScroll;
}

/**
 * 滚到指定位置。jsdom 里 `scrollTo` 可能是空实现，所以两条都走：
 * ① 优先调用元素自己的 scrollTo（真浏览器会真的平滑滚）；
 * ② 无论成功与否都把 scrollTop 直接赋一次（jsdom / 老内核兜底）。
 * @param {HTMLElement|null} el 滚动容器
 * @param {number} top 目标位置
 * @returns {void}
 */
function scrollTo(el, top) {
  if (!el) return;
  try {
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' });
  } catch {
    /* 老内核不支持 options 对象：忽略，走下面的直接赋值 */
  }
  try { el.scrollTop = top; } catch { /* 只读容器：忽略 */ }
}

/** 贴到底部（只在"用户本来就在底部"时调用）。 */
function pinToBottom(el) {
  if (!el) return;
  scrollTo(el, Number(el.scrollHeight) || 0);
}

/**
 * @param {Object} props
 * @param {React.MutableRefObject<HTMLElement|null>} props.scrollerRef 滚动容器的 ref
 * @param {number} [props.count] 内容版本号（一般传「消息条数」）—— 未读条数的计量单位
 * @param {number} [props.revision] 更细的版本号（流式时同一消息正文在变长）；变化即"内容变了"
 * @param {number} [props.topThreshold] 顶部容差
 * @param {number} [props.bottomThreshold] 底部容差
 * @param {string} [props.topLabel] 「回到最上面」的无障碍名
 * @param {string} [props.latestLabel] 「回到最新」的无障碍名
 * @param {string} [props.className] 追加类名（各页定位微调用）
 * @returns {JSX.Element|null} 不可滚动时返回 null（**一个按钮都不渲染**）
 */
export default function ScrollNav({
  scrollerRef,
  count = 0,
  revision,
  topThreshold = SCROLL_TOP_THRESHOLD,
  bottomThreshold = SCROLL_BOTTOM_THRESHOLD,
  topLabel = '回到最上面',
  latestLabel = '回到最新',
  className = '',
}) {
  const [state, setState] = useState(() => computeScrollState({ topThreshold, bottomThreshold }));
  const latestCount = Number(count) || 0;
  const rev = revision === undefined ? latestCount : (Number(revision) || 0);
  /** 已被"看到"的内容条数 —— 只在底部时推进，用来算未读。 */
  const seenRef = useRef(latestCount);
  const countRef = useRef(latestCount);
  countRef.current = latestCount;
  const initedRef = useRef(false);

  /** 现读一次并落地（判据不变就不 setState）。到底部时顺便把"已看"推进。 */
  const measure = useCallback(() => {
    const el = scrollerRef && scrollerRef.current;
    const next = computeScrollState({ ...readMetrics(el), topThreshold, bottomThreshold });
    if (next.atBottom) seenRef.current = countRef.current;
    setState((prev) => (sameState(prev, next) ? prev : next));
    return next;
  }, [scrollerRef, topThreshold, bottomThreshold]);

  // 监听：scroll（被动）+ 窗口尺寸 + 内容变化（MutationObserver）。
  // 为什么还要 MutationObserver：流式输出时**容器本身不滚**（内容在长高），
  // 不观察的话「回到最新」会一直停在旧判定上。
  useEffect(() => {
    const el = scrollerRef && scrollerRef.current;
    if (!el || typeof el.addEventListener !== 'function') return undefined;
    const onScroll = () => { measure(); };
    el.addEventListener('scroll', onScroll, { passive: true });
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onScroll);
    }
    let mo = null;
    const MO = typeof window !== 'undefined' ? window.MutationObserver : null;
    if (typeof MO === 'function') {
      mo = new MO(() => { measure(); });
      mo.observe(el, { childList: true, subtree: true, characterData: true });
    }
    // 首次布局完成后补一次（挂载那一刻往往还没有布局）
    const t = setTimeout(() => { measure(); }, 0);
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('resize', onScroll);
      }
      if (mo) mo.disconnect();
      clearTimeout(t);
    };
  }, [scrollerRef, measure]);

  // 内容变了（新消息 / 流式长高）：
  //   在底部 → 继续贴着底部（不打断阅读，因为本来就在看最新）；
  //   不在底部 → **一动不动**，只把未读数交给角标。
  useEffect(() => {
    const el = scrollerRef && scrollerRef.current;
    if (!initedRef.current) {
      initedRef.current = true;
      seenRef.current = countRef.current;
      measure();
      return;
    }
    const now = computeScrollState({ ...readMetrics(el), topThreshold, bottomThreshold });
    if (now.atBottom) {
      pinToBottom(el);
      seenRef.current = countRef.current;
    }
    measure();
  }, [rev, scrollerRef, measure, topThreshold, bottomThreshold]);

  const el = scrollerRef && scrollerRef.current;

  const scrollToTop = () => {
    scrollTo(el, 0);
    measure();
  };

  const scrollToLatest = () => {
    pinToBottom(el);
    seenRef.current = countRef.current;
    measure();
  };

  // 不可滚动（含内容比容器短、容器高 0、jsdom 没布局）：**不渲染任何按钮**。
  if (!state.scrollable) return null;

  // 未读 = 没看到的增量。在底部时永远是 0（看见了就不算未读）。
  const unread = state.atBottom ? 0 : Math.max(0, latestCount - seenRef.current);

  return (
    <div className={'dsnav-wrap ' + className} data-scrollnav-root="1">
      <div className="dsnav" role="group" aria-label="对话滚动导航">
        <button
          type="button"
          className="dsnav-btn"
          data-scrollnav="top"
          data-scrollnav-off={state.atTop ? '1' : '0'}
          aria-label={topLabel}
          title={topLabel}
          disabled={state.atTop}
          onClick={scrollToTop}
        >
          <span className="dsnav-ic" aria-hidden="true">↑</span>
          <span className="dsnav-tx">最上面</span>
        </button>
        <button
          type="button"
          className={'dsnav-btn' + (unread > 0 ? ' has-unread' : '')}
          data-scrollnav="latest"
          data-scrollnav-off={state.atBottom ? '1' : '0'}
          data-scrollnav-unread={unread > 0 ? String(unread) : undefined}
          aria-label={unread > 0 ? `${latestLabel}（${unread} 条新消息）` : latestLabel}
          title={unread > 0 ? `${latestLabel}（${unread} 条新消息）` : latestLabel}
          disabled={state.atBottom}
          onClick={scrollToLatest}
        >
          <span className="dsnav-ic" aria-hidden="true">↓</span>
          <span className="dsnav-tx">最新</span>
          {unread > 0 ? (
            <span className="dsnav-badge" data-scrollnav-badge="1" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
