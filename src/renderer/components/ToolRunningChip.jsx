import React from 'react';
import '../styles/chat-ux.css';

/**
 * ToolRunningChip —— 豆芽工具步骤的「进行中」芯片。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 【为什么单独成组件（不是为了好看，是为了能被断言）】
 *   老板第 5 条 b 项（「对话框还是生成中」）的**真 bug 就在这块 UI 上**：
 *   工具步骤的 running 状态在失败/终止路径上没人收敛，于是「⏳ 进行中…」永远留着，
 *   会话还被持久化到磁盘 ⇒ 重启后仍然"在生成中"。收敛逻辑见
 *   `services/chatFailure.js` 的 `settleRunningTools`（那里写了完整机制）。
 *
 *   但这块 UI 原本内联在 `App.jsx` 的 `ToolGroup` 里，而 App.jsx 三千多行、
 *   依赖整棵树（store / window.api / 主题），jsdom 里挂不起来 ⇒ 「running 时有没有
 *   `data-pending="1"`」这件事**永远无法被自动断言**，只能靠人眼看。
 *   抽出来后：一条渲染断言就能给出正控（running ⇒ 有锚点），再配合收敛后的反控
 *   （终态 ⇒ 没锚点），「失败后界面不存在生成中」才不是一句空话。
 *
 * ⚠️ 只搬**渲染**，不搬 `humanStep`：`scripts/smoke/unit-user-facing-output.mjs` 的
 *    U3 系列是按「App.jsx 里存在 `function humanStep(` / `TOOL_HUMAN[raw] || '处理中'`」
 *    来判定的（防止英文工具名外露）。把人话翻译搬走会让那条既有门禁假红，
 *    所以本组件只接收**已经翻译好的人话字符串**。
 * ════════════════════════════════════════════════════════════════════════
 */

/**
 * @param {Object} props
 * @param {Array<string>} [props.steps] 已经翻译成人话的步骤名（1 个 = 单行，多个 = 并行清单）
 * @param {React.ReactNode} [props.children] 折叠的历史明细（由 ToolGroup 传入）
 * @returns {JSX.Element}
 */
export default function ToolRunningChip({ steps, children }) {
  const list = Array.isArray(steps) ? steps.filter((s) => !!s) : [];
  const names = list.length ? list : ['处理中'];
  return (
    <div className="msg-tool-group running" data-pending="1" data-tool-running={names.length}>
      {names.length === 1 ? (
        // 单条：外观与改动前完全一致（单行 chip + 「进行中…」）
        <div className="tool-group-current">
          <span className="tool-chip-icon" aria-hidden="true">⏳</span>
          <span className="tool-chip-name">{names[0]}</span>
          <span className="tool-chip-status">进行中…</span>
        </div>
      ) : (
        // 多条并行：逐条列出，避免「N 个在跑只显示 1 个」让用户误以为卡住
        <div className="tool-group-running-list">
          <span className="tool-group-running-head">同时进行 {names.length} 项</span>
          {names.map((n, k) => (
            <div className="tool-group-current" key={n + '#' + k}>
              <span className="tool-chip-icon" aria-hidden="true">⏳</span>
              <span className="tool-chip-name">{n}</span>
              <span className="tool-chip-status">进行中…</span>
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}
