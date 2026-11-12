import React, { useEffect, useMemo, useState } from 'react';
import { Skeleton } from 'antd';
import { useMarketingGoal, useMarketingAsset } from '../store/marketingStore.jsx';
import { useCompany } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { recommendGoals } from '../services/goalGuide.js';
import { goalExecutability } from '../services/goalExecutability.js';
import { listGoalDemands, saveGoalDemand, removeGoalDemand } from '../services/goalDemand.js';

/** AI 推荐结果按企业 id 缓存（模块级，切换企业/重新挂载都不重复请求）。 */
const RECO_CACHE = new Map();

/**
 * 目标选择首屏：「一句人话 + 一个大按钮」。
 *
 * 改造（2026-10-11 第 3 层）：首屏原来是一堵**按钮墙** —— 5 个身份分组 Tab + 当前组 8 张目标卡
 * 一次性铺满（实测 13 个按钮）。老板的要求是「给笨蛋用」，于是首屏只留两件东西：
 *   · 一句人话：说清「为什么要先定目标 + 你不用想太细」；
 *   · 一个大按钮：直接把**豆芽替你先挑好的那一个目标**做成主入口，点一下进方案预览；
 *   · 一个次级入口「换一个目标」——点开才是原来的分组 Tab + 卡片区（收进展开态，不占首屏）。
 * 首屏按钮 13 → 2，由第 91 步 unit-firstscreen.mjs 的 GA 棘轮 + GE 判据锁住。
 *
 * 点卡片不直接跳「目标引导读 Markdown」，而是进 GoalPlanPreview —— AI 直接把项目 + 任务建好。
 * 卡片顺序：AI 推荐的排最前；分组顺序按企业类型（门诊 → 口腔诊所组，厂家 → 口腔厂家组，牙医 → 牙医个人组）。
 */
export default function GoalSelector({ onSelectModule, onStartGuide, onPreviewGoal, companyType = 'manufacturer' }) {
  const { goals: rawGoals, goal } = useMarketingGoal();
  const { currentCompany, currentRole } = useCompany();
  const { asset } = useMarketingAsset();
  const { getKnowledge } = useCompanyKnowledge();

  const companyId = currentCompany ? String(currentCompany.id) : '';
  const [reco, setReco] = useState(() => (companyId && RECO_CACHE.has(companyId) ? RECO_CACHE.get(companyId) : []));
  const [recoBusy, setRecoBusy] = useState(false);
  const [gap, setGap] = useState('');
  // 点中一个**尚未开通**的目标时，用它取代卡片区，当场解释「缺什么、为什么暂时做不了」。
  // 形如 { goalId, label, gap }；为空表示没在展示「未开通」面板。
  const [blocked, setBlocked] = useState(null);
  // 已保存的需求（当前企业）：保存/删除后即时刷新。
  const [demands, setDemands] = useState([]);
  // 保存成功后的用户可见反馈。
  const [savedTip, setSavedTip] = useState('');
  // 首屏默认只给「一个大按钮」；点「换一个目标」才展开原来的 Tab + 卡片区。
  const [showAll, setShowAll] = useState(false);

  // AI 推荐：按企业缓存；失败静默降级（卡片照常可点，只是没有推荐标记）
  useEffect(() => {
    let alive = true;
    if (!companyId) {
      setReco([]);
      setRecoBusy(false);
      return () => {
        alive = false;
      };
    }
    if (RECO_CACHE.has(companyId)) {
      setReco(RECO_CACHE.get(companyId));
      setRecoBusy(false);
      return () => {
        alive = false;
      };
    }
    setRecoBusy(true);
    (async () => {
      try {
        const list = await recommendGoals({
          currentCompany,
          asset,
          knowledge: getKnowledge ? getKnowledge(companyId) : undefined,
          companyType,
          role: currentRole,
        });
        if (!alive) return;
        RECO_CACHE.set(companyId, Array.isArray(list) ? list : []);
        setReco(RECO_CACHE.get(companyId));
      } catch {
        if (alive) setReco([]);
      } finally {
        if (alive) setRecoBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // 已保存需求列表：随企业 / 是否展示未开通面板刷新（listGoalDemands 自带容错，脏数据不抛）。
  useEffect(() => {
    setDemands(listGoalDemands(companyId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, blocked]);

  // 五身份各自把「自己的目标组」排最前（可见差异）：厂家→factory / 门诊→clinic /
  // 医生(doctor 与旧别名 dentist)→dentist / 经销商→dealer / 平台→platform。
  const goals = useMemo(() => {
    // 五主体各自归位。⚠️ 未知/空类型仍回落 'factory' 是**刻意**的（与 normalizeCompanyType 同策略，历史行为不变）。
    // dentist 是 doctor 的旧别名，兼容保留。
    const preferred =
      companyType === 'clinic' ? 'clinic' :
      companyType === 'dentist' || companyType === 'doctor' ? 'dentist' :
      companyType === 'dealer' ? 'dealer' :
      companyType === 'platform' ? 'platform' :
      'factory';
    return (rawGoals || []).slice().sort((a, b) => {
      const ra = a.id === preferred ? 0 : 1;
      const rb = b.id === preferred ? 0 : 1;
      return ra - rb;
    });
  }, [rawGoals, companyType]);

  const [activeGroup, setActiveGroup] = useState(goals.length ? goals[0].id : 'clinic');
  const group = goals.find((g) => g.id === activeGroup) || goals[0];

  const recoRank = useMemo(() => {
    const m = new Map();
    (reco || []).forEach((r, i) => m.set(r.goalId, i));
    return m;
  }, [reco]);
  const recoMap = useMemo(() => {
    const m = new Map();
    (reco || []).forEach((r) => m.set(r.goalId, r));
    return m;
  }, [reco]);

  // 当前分组内：AI 推荐的排最前（按推荐顺序），其余保持原序
  const items = useMemo(() => {
    if (!group) return [];
    return group.goals.slice().sort((a, b) => {
      const ra = recoRank.has(a.id) ? recoRank.get(a.id) : 999;
      const rb = recoRank.has(b.id) ? recoRank.get(b.id) : 999;
      return ra - rb;
    });
  }, [group, recoRank]);

  /**
   * 首屏那**一个**目标：已选目标 > AI 推荐首位 > 当前分组第一个。
   * 三级回落的顺序是有意的 —— 已经定过目标的人回来先看到「继续做」，
   * 没定过的先看豆芽替他挑的，AI 不可用时也永远有一个能点的按钮（绝不留空屏）。
   */
  const hero = useMemo(() => {
    if (goal && goal.goalId) {
      const cur = items.find((it) => it.id === goal.goalId);
      if (cur) return cur;
    }
    const rec = items.find((it) => recoMap.has(it.id));
    return rec || items[0] || null;
  }, [items, recoMap, goal]);
  const heroReco = hero ? recoMap.get(hero.id) : undefined;
  const heroActive = !!(goal && hero && goal.goalId === hero.id);
  const goalTotal = useMemo(
    () => (goals || []).reduce((n, g) => n + ((g && g.goals) ? g.goals.length : 0), 0),
    [goals],
  );

  function pick(item) {
    // 未开通的目标：点击时当场解释并阻止进入方案生成 / 建项目，绝不调用 onPreviewGoal。
    const ex = goalExecutability(item.id);
    if (!ex.executable) {
      setGap('');
      setBlocked({ goalId: item.id, label: item.label, gap: ex.gap });
      return;
    }
    setBlocked(null);
    setGap('');
    if (onPreviewGoal) {
      onPreviewGoal(item.id, item.label);
      return;
    }
    // 兼容旧链路：没有预览能力时退回「选完进模块 / 进引导」
    if (onStartGuide) {
      onStartGuide(item.id);
      return;
    }
    // 【0.21.21 · 老板 2026-10-21】兜底落点从 `activity` 改成 `campaign`。
    // 这条分支只在「没有预览能力、也没有引导能力」时才走到（App 两样都传，实际走不到），
    // 但语义必须对：选完目标要去的是「做活动方案」，那一页现在是营销专项（CampaignModule）。
    // 写 `activity` 会靠别名落到豆芽助手 —— 一条永远不会被触发、却写错了的跳转，
    // 比没有更糟：以后谁把 onPreviewGoal/onStartGuide 拿掉，就会静默变成「选完目标回首页」。
    if (onSelectModule) onSelectModule('campaign');
  }

  const gapText = gap || (goal && !goal.module && goal.gap ? goal.gap : '');

  return (
    <div className="goal-selector">
      <div className="goal-selector-head">
        <h2 className="goal-selector-title">🎯 先定一个目标</h2>
        <p className="goal-selector-sub">目标定了，豆芽才知道该给你建哪些项目和任务。不用想太细，说个大方向就行，剩下的它来排。</p>
      </div>

      {blocked ? (
        <div className="goal-blocked">
          <div className="goal-blocked-head">
            <span className="goal-blocked-icon">🚧</span>
            <div className="goal-blocked-body">
              <div className="goal-blocked-title">该目标暂未开通</div>
              <div className="goal-blocked-goal">{blocked.label}</div>
              <div className="goal-blocked-text">{blocked.gap}</div>
              <div className="goal-blocked-honest">
                为了不给你一份看起来能用、其实跑不下去的计划，我们不会为它生成方案，也不会创建项目和任务。
              </div>
            </div>
          </div>
          <div className="goal-blocked-actions">
            <button
              type="button"
              className="goal-blocked-btn primary"
              onClick={() => {
                const list = saveGoalDemand({ companyId, goalId: blocked.goalId, label: blocked.label, gap: blocked.gap });
                setDemands(list);
                setSavedTip('已记下这个需求，之后随时可以回来继续。');
              }}
            >
              记下这个需求
            </button>
            <button
              type="button"
              className="goal-blocked-btn"
              onClick={() => {
                setBlocked(null);
                setSavedTip('');
              }}
            >
              返回选择其他目标
            </button>
          </div>
          {savedTip && <div className="goal-blocked-tip">{savedTip}</div>}
          {demands.length > 0 && (
            <div className="goal-demands">
              <div className="goal-demands-title">已记下的需求</div>
              {demands.map((d) => (
                <div className="goal-demand-item" key={d.goalId}>
                  <span className="goal-demand-label">{d.label || d.goalId}</span>
                  <button
                    type="button"
                    className="goal-demand-remove"
                    onClick={() => {
                      const list = removeGoalDemand(companyId, d.goalId);
                      setDemands(list);
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : !showAll ? (
        <div className="goal-hero">
          <p className="goal-hero-hint">还没主意？先按这个来：</p>
          {hero && (
            <button
              type="button"
              className="goal-hero-btn"
              data-goal-id={hero.id}
              onClick={() => pick(hero)}
              title={heroReco && heroReco.reason ? `AI 推荐：${heroReco.reason}` : hero.desc}
            >
              <span className="goal-hero-icon">{group ? group.icon : '🎯'}</span>
              <span className="goal-hero-label">{heroActive ? `继续做「${hero.label}」` : `帮我做「${hero.label}」`}</span>
              <span className="goal-hero-desc">{heroReco && heroReco.reason ? heroReco.reason : hero.desc}</span>
              {heroReco && <span className="goal-hero-tag">🔥 AI 推荐</span>}
            </button>
          )}
          <button type="button" className="goal-hero-more" onClick={() => setShowAll(true)}>
            换一个目标（{group ? group.label : '全部'} · 共 {goalTotal} 个）
          </button>
          <p className="goal-hero-note">点一下，项目和任务就建好了，不用你自己排。</p>
        </div>
      ) : (
        <>
          <div className="goal-tabs">
            {goals.map((g) => (
              <button
                key={g.id}
                type="button"
                className={'goal-tab' + (g.id === activeGroup ? ' active' : '')}
                onClick={() => setActiveGroup(g.id)}
              >
                <span className="goal-tab-icon">{g.icon}</span>
                {g.label}
              </button>
            ))}
          </div>

          {recoBusy && reco.length === 0 && (
            <div className="goal-cards">
              {[0, 1, 2, 3].map((i) => (
                <div className="goal-card goal-card-skeleton" key={i}>
                  <Skeleton active paragraph={{ rows: 1 }} title={{ width: '60%' }} />
                </div>
              ))}
            </div>
          )}

          {group && !(recoBusy && reco.length === 0) && (
            <div className="goal-cards">
              {items.map((item) => {
                const isActive = goal && goal.goalId === item.id;
                const r = recoMap.get(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={'goal-card' + (isActive ? ' active' : '') + (r ? ' recommended' : '')}
                    onClick={() => pick(item)}
                    title={r && r.reason ? `AI 推荐：${r.reason}` : item.desc}
                  >
                    {r && (
                      <span className="goal-card-badges">
                        <span className="goal-card-badge">🔥 AI 推荐</span>
                        <span className={'goal-card-fit fit-' + (r.fit === '高' ? 'high' : r.fit === '中' ? 'mid' : 'low')}>
                          匹配度 {r.fit}
                        </span>
                      </span>
                    )}
                    <span className="goal-card-label">{item.label}</span>
                    <span className="goal-card-desc">{r && r.reason ? r.reason : item.desc}</span>
                    {isActive && <span className="goal-card-current">当前目标</span>}
                  </button>
                );
              })}
            </div>
          )}

          <button type="button" className="goal-hero-more" onClick={() => setShowAll(false)}>
            收起，回到那一个目标
          </button>
        </>
      )}

      {gapText && (
        <div className="goal-gap">
          <span className="goal-gap-icon">🚧</span>
          <div className="goal-gap-body">
            <div className="goal-gap-title">该目标暂未开通</div>
            <div className="goal-gap-text">{gapText}</div>
          </div>
        </div>
      )}
    </div>
  );
}
