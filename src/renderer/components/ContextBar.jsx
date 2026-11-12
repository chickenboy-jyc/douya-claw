import React from 'react';
import { useCompany } from '../store/companyStore.jsx';
import { companyTypeIcon } from '../config/companyTypeConfig.js';

/**
 * 对话区顶部上下文条：把「企业 → 项目 → 任务」的 AI 上下文对用户可见。
 *
 * 【0.21.9 修正 · 老板第 1 条「首页删掉」的后遗症】
 * 改前：整条只有**一个** `onGoToday`，4 个点击全部落到「活动与档期」。于是文案说
 * 「回到首页」、行为跳活动页；点「当前企业」也会被踹到活动页 —— 文案和行为两头都不对。
 *
 * 现在按「这一格在说谁」拆成四个入口，谁的地盘谁去：
 *   🏠        → 豆芽助手（welcome）：老板删掉首页后，对话就是落点。
 *   企业       → 企业大脑（profile）：老板第 4 条已把它统一成「企业大脑」。
 *   项目       → 豆芽助手（welcome）：**待产品定** —— 首页没了之后没有「选项目」的落点，
 *                这里刻意不自己发明一个项目选择页（多一个无出处的页面比少一个更糟）。
 *   任务       → **不换模块**，展开左侧任务栏（TaskCenter 的 open）：用户此刻要的是
 *                「挑一个任务」，不是「换个页面」。
 *
 * ⚠️ 不要再退回「一个 onGoToday 管全部」：那正是文案与行为漂开的成因。
 */
export default function ContextBar({ onGoHome, onGoCompany, onGoProject, onOpenTasks }) {
  const { currentCompany, currentProject, currentTask, currentRole, setCurrentTask } = useCompany();
  const companyType = (currentCompany && currentCompany.type) || 'manufacturer';
  const goHome = typeof onGoHome === 'function' ? onGoHome : () => {};
  const goCompany = typeof onGoCompany === 'function' ? onGoCompany : goHome;
  const goProject = typeof onGoProject === 'function' ? onGoProject : goHome;
  const openTasks = typeof onOpenTasks === 'function' ? onOpenTasks : () => {};

  return (
    <div className="ctxbar">
      <button className="ctxbar-crumb" onClick={goHome} title="回到豆芽助手">
        <span className="ctxbar-ico">🏠</span>
      </button>
      <span className="ctxbar-sep">/</span>
      <button className="ctxbar-crumb" onClick={goCompany} title="当前企业（进入企业大脑）">
        <span className="ctxbar-ico">{companyTypeIcon(companyType)}</span>
        <span className="ctxbar-txt">{currentCompany ? currentCompany.name : '未选择企业'}</span>
        <span className="ctxbar-role">{currentRole === 'admin' ? '管理员' : currentRole === 'operator' ? '运营' : '查看'}</span>
      </button>
      <span className="ctxbar-sep">/</span>
      <button className="ctxbar-crumb" onClick={goProject} title="当前项目">
        <span className="ctxbar-ico">📁</span>
        <span className="ctxbar-txt">{currentProject ? currentProject.name : '未选择项目'}</span>
      </button>
      <span className="ctxbar-sep">/</span>
      <button className="ctxbar-crumb task" onClick={openTasks} title="当前任务（AI 将围绕此任务执行；点击在左侧任务栏选一个）">
        <span className="ctxbar-ico">🎯</span>
        <span className={'ctxbar-txt' + (currentTask ? '' : ' empty')}>{currentTask ? currentTask.title : '未选择任务（在左侧任务栏选一个）'}</span>
      </button>
      {currentTask && (
        <button className="ctxbar-clear" onClick={() => setCurrentTask(null)} title="清除当前任务">✕</button>
      )}
    </div>
  );
}
