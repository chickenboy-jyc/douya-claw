import React, { useState, useMemo, useCallback } from 'react';
import { Steps, Button, Card, Spin, App as AntApp, Tag, Empty } from 'antd';
import { routeForGoal } from '../store/goalCatalog.js';
import { useCompany } from '../store/companyStore.jsx';
import { useMarketingGoal, useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useAssets } from '../store/assetStore.jsx';
import { buildAIContext } from '../services/contextBuilder.js';
import { generateStepContent } from '../services/goalGuide.js';
import Markdown from './Markdown.jsx';
// Markdown → 纯文本的唯一真源（复制出口必须先剥标记，剪贴板不经过渲染器）。
import { mdToPlain } from '../utils/mdToPlain.js';
import AssetPanel from './AssetPanel.jsx';

/**
 * 目标引导面板（P0-2）：点选目标后进入，按 GOAL_ROUTES[goalId].steps 一步步引导。
 * - 左侧 Steps 导航（可点跳转）
 * - 右侧当前步：asset 步内嵌建档面板；其余步「AI 帮我做这一步」生成可直接落地的执行内容
 * - 上一步 / 下一步 / 跳过引导（直接进落地模块）；引导可随时退出
 */
export default function GoalGuide({ goalId, onExit, onSelectModule }) {
  const { currentCompany, currentProject, currentRole, currentWorkspaceRole, workspace, createProject, addTasksToProject } = useCompany();
  const { addAsset } = useAssets();
  const { asset, hasAsset } = useMarketingAsset();
  const { getKnowledge } = useCompanyKnowledge();
  const { goal } = useMarketingGoal();
  const { message } = AntApp.useApp();

  const route = useMemo(() => routeForGoal(goalId), [goalId]);
  const steps = route.steps || [];
  const goalLabel = goal && goal.goalId === goalId ? goal.label : '';

  const [cur, setCur] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [done, setDone] = useState({});

  const ctx = useMemo(
    () =>
      buildAIContext({
        workspace,
        company: currentCompany,
        asset,
        knowledge: getKnowledge ? getKnowledge(currentCompany && currentCompany.id) : undefined,
        project: currentProject,
        role: currentRole,
        workspaceRole: currentWorkspaceRole,
        goalLabel,
      }),
    [workspace, currentCompany, asset, getKnowledge, currentProject, currentRole, currentWorkspaceRole, goalLabel],
  );

  const step = steps[cur];
  const isAssetStep = step && step.module === 'asset';
  const assetDone = isAssetStep && hasAsset;
  const stepDone = assetDone || (step && done[step.key]) || false;

  const runStep = useCallback(async () => {
    if (!step || isAssetStep) return;
    setLoading(true);
    setResult('');
    const res = await generateStepContent(step, ctx, { goalLabel });
    setLoading(false);
    if (res.ok && res.content) {
      setResult(res.content);
      setDone((d) => ({ ...d, [step.key]: true }));
    } else {
      message.error(res.error || '生成失败');
    }
  }, [step, isAssetStep, ctx, goalLabel, message]);

  const goPrev = () => {
    if (cur > 0) {
      setCur(cur - 1);
      setResult('');
    }
  };
  const goNext = () => {
    if (cur < steps.length - 1) {
      setCur(cur + 1);
      setResult('');
    } else {
      // 最后一步：进入落地模块
      if (onExit) onExit(route.module || (step && step.module));
    }
  };

  /**
   * 复制当前这一步的 AI 产出。
   *
   * 【0.21.25 报障「生的文章 不要有 ## ** 这种没有意义的符号」】
   * 这一屏的产出于 `:221` 是用 `<Markdown>` 渲染的，但剪贴板不经过渲染器 ——
   * 原来直接 `writeText(result)`，粘出去就是 `## 结论` `**重点**` 原样可见。
   * 本文件是第 9 处出口（team-lead 要求「8 处出口不许漏」的复查中新查出的一处）。
   */
  const copyResult = () => {
    if (!result) return;
    navigator.clipboard && navigator.clipboard.writeText(mdToPlain(result)).then(
      () => message.success('已复制'),
      () => message.warning('复制失败，请手动选择'),
    );
  };

  /** 把当前这一步的 AI 产出存成项目资产，后续 AI 调用能读到（不再只是看一眼 Markdown）。 */
  const saveAsAsset = () => {
    if (!result) return;
    const cid = currentCompany && currentCompany.id;
    if (!cid) {
      message.warning('请先在左上角选择企业');
      return;
    }
    addAsset({
      companyId: cid,
      projectId: currentProject ? currentProject.id : null,
      type: 'document',
      name: `${goalLabel || goalId} · ${step ? step.title : 'AI 产出'}`,
      content: result,
      tags: ['目标引导', goalLabel || goalId].filter(Boolean),
    });
    message.success('已存为项目资产');
  };

  /** 把当前这一步转成可执行任务；没有当前项目时先按目标建一个。 */
  const toTask = () => {
    if (!result) return;
    if (!currentCompany) {
      message.warning('请先在左上角选择企业');
      return;
    }
    let pid = currentProject && currentProject.id;
    if (!pid) {
      const p = createProject(`${goalLabel || '营销'}执行项目`, goalId, {});
      if (!p) {
        message.error('建项目失败，请重试');
        return;
      }
      pid = p.id;
    }
    addTasksToProject(pid, [
      {
        title: step ? step.title : goalLabel || 'AI 产出',
        description: result,
        outputFormat: '按本步 AI 产出交付',
        priority: 'medium',
      },
    ]);
    message.success('已转成项目任务');
  };

  return (
    <div className="goal-guide">
      <div className="goal-guide-head">
        <div>
          <h2 className="goal-guide-title">🧭 目标引导：{goalLabel || goalId}</h2>
          <p className="goal-guide-sub">跟着步骤走，每一步都能让 AI 帮你产出可直接用的内容；随时可跳过。</p>
        </div>
        <Button onClick={() => onExit && onExit(route.module || (steps[0] && steps[0].module))}>
          跳过引导，直接开始
        </Button>
      </div>

      <div className="goal-guide-body">
        <div className="goal-guide-steps">
          <Steps
            direction="vertical"
            current={cur}
            onChange={(i) => {
              setCur(i);
              setResult('');
            }}
            items={steps.map((s, i) => ({
              title: s.title,
              description: s.hint || '',
              status: done[s.key] || (s.module === 'asset' && hasAsset) ? 'finish' : undefined,
            }))}
          />
        </div>

        <div className="goal-guide-content">
          {!step && <Empty description="该目标暂未配置引导步骤" />}

          {step && isAssetStep && (
            <div className="goal-guide-asset">
              {hasAsset ? (
                <Tag color="green" style={{ marginBottom: 12 }}>✅ 企业资产已建档，可继续下一步</Tag>
              ) : (
                <Tag color="orange" style={{ marginBottom: 12 }}>⚠️ 请先完善企业资产，下游步骤会自动带出</Tag>
              )}
              <AssetPanel />
            </div>
          )}

          {step && !isAssetStep && (
            <Card
              title={`第 ${cur + 1} 步：${step.title}`}
              extra={<Tag>{step.module}</Tag>}
              className="goal-guide-card"
            >
              {step.hint && <p className="goal-guide-hint">{step.hint}</p>}

              <div className="goal-guide-actions">
                <Button type="primary" loading={loading} onClick={runStep}>
                  ✨ AI 帮我做这一步
                </Button>
                {step.module && (
                  <Button
                    onClick={() => onSelectModule && onSelectModule(step.module)}
                  >
                    去「{step.module}」模块细改
                  </Button>
                )}
              </div>

              <Spin spinning={loading}>
                {result ? (
                  <div className="goal-guide-result">
                    <div className="goal-guide-result-bar">
                      <span>AI 产出</span>
                      <span className="goal-guide-result-actions">
                        <Button size="small" type="link" onClick={copyResult}>
                          复制
                        </Button>
                        <Button size="small" type="link" onClick={saveAsAsset}>
                          存为项目资产
                        </Button>
                        <Button size="small" type="link" onClick={toTask}>
                          转成任务
                        </Button>
                      </span>
                    </div>
                    <Markdown>{result}</Markdown>
                  </div>
                ) : (
                  !loading && <p className="goal-guide-tip">点「AI 帮我做这一步」生成可直接落地的执行内容。</p>
                )}
              </Spin>
            </Card>
          )}

          <div className="goal-guide-foot">
            <Button onClick={goPrev} disabled={cur === 0}>
              上一步
            </Button>
            {cur < steps.length - 1 ? (
              <Button type="primary" onClick={goNext}>
                下一步
              </Button>
            ) : (
              <Button type="primary" onClick={goNext}>
                完成引导
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
