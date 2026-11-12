import React from 'react';

/**
 * ScopeSwitch —— 顶部「对话 / 工作」大号居中切换（2026-10-19 第十九轮 · 老板第 3 条）。
 *
 * 老板原话：「就保留 对话/工作 放大 放中间点击切换 就行了」。
 * 在此之前这里是**三个小页签**（经营对话 / 开发工作台 / ⏰ 定时任务）挂在侧栏顶部，
 * 每个都只有 12px、还带一行说明文字 —— 主视线里全是开关，不像「大模型那种」。
 *
 * 设计约束（改这里必须守住）：
 *   1. 只有两项：对话 = 经营对话（wbTab 'chat'），工作 = 开发工作台（wbTab 'dev'）。
 *      定时任务不再是页签，入口收进统一任务栏底部那一组（点进去仍是 wbTab 'automation'）。
 *   2. `data-scope-tab="chat"` / `data-scope-tab="work"` 锚点必须保留 ——
 *      验收脚本按它定位（第十九轮之前它挂在 chatScope 的两个小页签上，现在挂到这个大切换上）。
 *   3. 定时任务页（wbTab 'automation'）里两项都不高亮：它不属于这两者之一，
 *      硬点亮一个会骗用户「我现在在对话里」。
 *
 * @param {{ tab?: string, onChange?: (next: 'chat'|'dev') => void }} props
 *   tab = 当前 wbTab（'chat' | 'dev' | 'automation'），onChange 收到 'chat' | 'dev'
 * @returns {JSX.Element}
 */
export default function ScopeSwitch({ tab, onChange }) {
  // wbTab → 本控件的高亮项：dev → work；chat → chat；automation / 其它 → 都不亮
  const on = tab === 'dev' ? 'work' : tab === 'chat' ? 'chat' : '';
  const pick = (v) => {
    if (typeof onChange !== 'function') return;
    onChange(v === 'work' ? 'dev' : 'chat');
  };

  return (
    <div className="scope-switch" role="tablist" aria-label="对话或工作">
      <button
        type="button"
        role="tab"
        aria-selected={on === 'chat'}
        className={'scope-switch-btn' + (on === 'chat' ? ' on' : '')}
        data-scope-tab="chat"
        onClick={() => pick('chat')}
      >
        对话
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={on === 'work'}
        className={'scope-switch-btn' + (on === 'work' ? ' on' : '')}
        data-scope-tab="work"
        onClick={() => pick('work')}
      >
        工作
      </button>
    </div>
  );
}
