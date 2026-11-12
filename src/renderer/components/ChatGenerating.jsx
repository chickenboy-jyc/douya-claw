import React, { useEffect, useRef, useState } from 'react';
import '../styles/chat-ux.css';

/**
 * ChatGenerating —— 「豆芽正在生成」的**显眼**运行态气泡（老板第 5 条 c 项）。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 老板原话：「对话框的生成中不明显 改的显眼点。」
 *
 * 改前：生成中只有两处痕迹 —— 输入框 placeholder 变成「生成中…」（用户视线在看对话区，
 *       根本扫不到），以及一行灰色小字。所以老板"不知道它到底在不在做"。
 *
 * 改后（本组件）：
 *   · 对话区底部出现一个**带三点跳动动效**的气泡（typing indicator），位置就在最新一条下面；
 *   · 文案是**文字**「生成中」，不靠颜色 —— 色弱用户同样能读到（这是硬要求，不是客气话）；
 *   · 显示**已经等了多久**（「已等 12 秒」）—— 老板最痛的是"不知道还要等多久"，
 *     给出已等时长，用户至少能自己判断要不要继续等；
 *   · `data-chat-generating="1"` + `data-pending="1"` 两个锚点，供门禁断言正控/反控；
 *   · 尊重 `prefers-reduced-motion`（CSS 媒体查询里把动效关掉，文字与耗时照常显示）。
 *
 * ⚠️ 动效本身**不可自动验证**（jsdom 不做动画、不跑 CSS）。能验的是：锚点在不在、
 *    文案里有没有「生成中」、有没有「已等 N 秒」。动画是否真的在动只能人眼/真浏览器看。
 * ════════════════════════════════════════════════════════════════════════
 */

/**
 * 毫秒 → 「12 秒」/「1 分 05 秒」。纯函数，单独可测。
 * @param {number} ms 已等待毫秒数
 * @returns {string} 人话时长（永不为空）
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  return `${m} 分 ${String(total % 60).padStart(2, '0')} 秒`;
}

/**
 * @param {Object} props
 * @param {string} [props.text] 主文案；**必须含「生成中」三个字**（默认已含）
 * @param {number} [props.since] 开始时间戳（毫秒）。不传则用挂载时刻
 * @param {string} [props.className] 追加类名
 * @returns {JSX.Element}
 */
export default function ChatGenerating({
  text = '生成中，豆芽正在想…',
  since,
  className = '',
}) {
  const startRef = useRef(
    typeof since === 'number' && since > 0 ? since : Date.now(),
  );
  const [now, setNow] = useState(() => Date.now());

  // 每秒推进一次，让「已等 N 秒」自己往上走。卸载必须清掉，否则切页后计时器还在跑。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // since 变了（同一组件被复用于下一次生成）时重置起点，别把上一轮的时长带过来。
  useEffect(() => {
    if (typeof since === 'number' && since > 0) {
      startRef.current = since;
      setNow(Date.now());
    }
  }, [since]);

  const elapsedMs = Math.max(0, now - startRef.current);
  const elapsed = formatElapsed(elapsedMs);

  return (
    <div
      className={'chat-gen ' + className}
      data-chat-generating="1"
      data-pending="1"
      data-chat-gen-elapsed={elapsed}
      role="status"
      aria-live="polite"
      aria-label={`生成中，已等 ${elapsed}`}
    >
      <span className="chat-gen-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="chat-gen-text">{text}</span>
      <span className="chat-gen-elapsed" data-chat-gen-elapsed-text="1">
        已等 {elapsed}
      </span>
    </div>
  );
}
