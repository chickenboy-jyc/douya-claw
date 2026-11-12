import React, { useState } from 'react';
import { Button } from 'antd';

/**
 * TaskCenter —— 统一任务栏（2026-10-19 第十九轮 · 老板第 3 条）。
 *
 * 老板原话：「经营对话 开发工作台 定时任务全部合并成一起 直接从颜色区分
 *   对话是绿色的 开发是黄色的 一个任务栏 做成现在市面上大模型的那种」。
 *
 * 本组件**只负责画**，不读任何数据、不碰 localStorage —— 数据由 App 组装好传进来，
 * 这样「三类任务怎么排序、怎么算当前选中」这些有判断的地方都留在 App 一处，
 * 组件可以单独渲染做视觉验收（也避免一个组件里又读 store 又读 localStorage 的隐性耦合）。
 *
 * 三类任务的视觉约定（老板点名）：
 *   · 对话（经营对话会话）  圆点 绿 #34c759   data-task-kind="chat"
 *   · 开发（DevWorkbench 的 dev session）圆点 黄 #ffcc00   data-task-kind="dev"
 *   · 定时（automation）    圆点 紫 #af52de   data-task-kind="auto"
 *
 * @param {object} props
 * @param {boolean} props.open            是否展开（收起时不渲染；App 用 sessionsOpen 控制）
 * @param {Array<{key:string,kind:'chat'|'dev',title:string,time:string}>} props.items 混排任务（已按 updatedAt 倒序）
 * @param {string} props.currentKey       当前选中的任务 key（没有则空串）
 * @param {Array<{id:string,name:string,time:string,enabled:boolean}>} props.autoItems 定时任务条目
 * @param {boolean} props.autoAvailable   window.api.automationList 是否存在（浏览器里没有）
 * @param {(item:object)=>void} props.onPick        点一条任务
 * @param {()=>void} props.onGoAutomation           点「定时任务」这一行入口
 * @param {()=>void} props.onNewChat                新建对话
 * @param {(item:object)=>void} [props.onDeleteTask] 删一条对话 / 开发任务（不传则不出删除入口）
 * @param {(id:string)=>void} [props.onDeleteAuto]   删一条定时任务（不传则不出删除入口）
 * @returns {JSX.Element}
 *
 * ⚠️ 0.21.11 · 老板第 7 条：「豆芽助手里面任务栏常在 不要隐藏掉」。
 *   ⇒ 头部那个 `×`（收起任务栏）**已删除**，`onCollapse` 也一并从 props 里去掉 ——
 *   只留一个 prop 不渲染等于留了个没人按的开关，下一个人会以为"收起坏了"。
 *   现在收起这件事整条链都不存在：App 侧没有入口能把 open 置 false，
 *   本组件也不会自己收起。`open` 仍保留（默认 true 由 App 传），供将来真要收起的场景复用。
 *
 * ⚠️ 0.21.11 · 追加：「任务栏是可以删除的」。
 *   注意这话和上一条**不矛盾**：不能关的是**整条栏**，要能删的是**栏里的某一条任务**。
 *   改前这两件事都做不到 —— 对话会话只有"新建"没有"删除"（App 里 `sessions.items`
 *   只增不减），开发会话得绕到开发工作台里删。任务越攒越多，任务栏就废了。
 *   现在每条悬停时右侧浮出 `×`，点了**原地**换成一行确认（不弹 Modal）：
 *     · 用行内确认而不是直接删：删对话 = 连聊天记录一起没了，误点一下损失不可逆；
 *     · 用行内确认而不是 Modal：任务栏宽 264px，弹窗会盖住正是他要对比的那几条；
 *     · 确认条里带上标题，避免"我到底在删哪条"。
 *   定时任务子项走 `props.onDeleteAuto`（主进程 automation:remove，删的是真排期）。
 *   「定时任务」这一行**只是入口**，不是数据，所以不给删除入口。
 */
export default function TaskCenter({
  open,
  items,
  currentKey,
  autoItems,
  autoAvailable,
  onPick,
  onGoAutomation,
  onNewChat,
  onDeleteTask,
  onDeleteAuto,
}) {
  // 哪一条正处于「确认删除」态（存 key，不存 index —— 列表会因 updatedAt 重排，index 会指错行）
  const [confirmKey, setConfirmKey] = useState('');
  if (!open) return null;
  const list = Array.isArray(items) ? items : [];
  const autos = Array.isArray(autoItems) ? autoItems : [];
  const canDelTask = typeof onDeleteTask === 'function';
  const canDelAuto = typeof onDeleteAuto === 'function';

  /** 行内确认条：删除 / 算了。两个都是真按钮，键盘也能用。 */
  function renderConfirm(key, title, onYes) {
    return (
      <div className="tc-confirm" data-tc-confirm={key} key={'confirm:' + key}>
        <span className="tc-confirm-t" title={title}>
          删掉「{title || '未命名任务'}」？
        </span>
        <button
          type="button"
          className="tc-confirm-yes"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmKey('');
            onYes();
          }}
        >
          删除
        </button>
        <button
          type="button"
          className="tc-confirm-no"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmKey('');
          }}
        >
          算了
        </button>
      </div>
    );
  }

  return (
    <aside className="sidebar sidebar-drawer task-center open" data-task-center="1">
      <div className="sidebar-header">
        <span className="sidebar-title">任务</span>
        <Button size="small" type="primary" ghost onClick={onNewChat}>
          + 新建
        </Button>
      </div>

      <div className="session-list tc-list">
        {list.length === 0 ? (
          <div className="session-empty">还没有任务，说一句话就开始了</div>
        ) : (
          list.map((it) => {
            if (confirmKey === it.key && canDelTask) {
              return renderConfirm(it.key, it.title, () => onDeleteTask(it));
            }
            return (
              <div
                key={it.key}
                className={'session-item tc-item' + (it.key === currentKey ? ' active' : '')}
                data-task-kind={it.kind}
                data-task-key={it.key}
                onClick={() => (typeof onPick === 'function' ? onPick(it) : undefined)}
                title={it.title}
              >
                <span
                  className={'tc-dot tc-dot-' + (it.kind === 'dev' ? 'dev' : it.kind === 'auto' ? 'auto' : 'chat')}
                  aria-hidden="true"
                />
                <span className="tc-body">
                  <span className="session-name tc-name">{it.title || '未命名任务'}</span>
                  {it.time ? <span className="session-time tc-time">{it.time}</span> : null}
                </span>
                {canDelTask ? (
                  <button
                    type="button"
                    className="tc-del"
                    title="删除这条任务"
                    aria-label="删除这条任务"
                    onClick={(e) => {
                      // 不加这句，点 × 会冒泡到行上 ⇒ 先把这条任务打开、再问要不要删它
                      e.stopPropagation();
                      setConfirmKey(it.key);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            );
          })
        )}

        {/* ---- 定时任务：单独一组置底（老板：定时任务也进同一个栏）---- */}
        <div className="tc-group-title">定时任务</div>
        <div
          className={'session-item tc-item' + (currentKey === 'auto:entry' ? ' active' : '')}
          data-task-kind="auto"
          onClick={() => (typeof onGoAutomation === 'function' ? onGoAutomation() : undefined)}
          title="定时任务：让豆芽到点自己干活"
        >
          <span className="tc-dot tc-dot-auto" aria-hidden="true" />
          <span className="tc-body">
            <span className="session-name tc-name">定时任务</span>
            <span className="session-time tc-time">
              {autoAvailable
                ? (autos.length ? `${autos.length} 个已排期` : '还没有排期，点进去建一个')
                : '在客户端里可用'}
            </span>
          </span>
        </div>
        {autoAvailable && autos.map((a) => {
          const key = 'auto:' + a.id;
          if (confirmKey === key && canDelAuto) {
            return renderConfirm(key, a.name, () => onDeleteAuto(a.id));
          }
          return (
            <div
              key={key}
              className="session-item tc-item tc-item-sub"
              data-task-kind="auto"
              data-task-key={key}
              onClick={() => (typeof onGoAutomation === 'function' ? onGoAutomation() : undefined)}
              title={a.name}
            >
              <span className="tc-dot tc-dot-auto" aria-hidden="true" />
              <span className="tc-body">
                <span className="session-name tc-name">{a.name}</span>
                {a.time ? <span className="session-time tc-time">{a.time}</span> : null}
              </span>
              {canDelAuto ? (
                <button
                  type="button"
                  className="tc-del"
                  title="删除这个定时任务"
                  aria-label="删除这个定时任务"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmKey(key);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">绿=对话 · 黄=开发 · 紫=定时</div>
    </aside>
  );
}
