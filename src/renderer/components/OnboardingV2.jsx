import React, { useState } from 'react';
import { Button, Input } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { FIRST_RUN_TYPE_KEYS, getTypeConfig } from '../config/companyTypeConfig.js';
import { buildRegionPatch } from '../services/companyRegion.js';
import { testLLM } from '../services/llmTest.js';
import { isPublicDeepSeek } from '../services/aiReadiness.js';

/**
 * 首登改造（onboarding-v2）· 屏 2–4 的新流程组件。
 *
 * 屏 1「登录」沿用 App.jsx 的全屏 login-overlay（本组件不涉及）。
 * 本组件只负责登录之后的三个相位状态机：
 *   phase 'ai'      屏 2 · 连上 AI   （baseURL/apiKey/model + 实测连接；可「先跳过」）
 *   phase 'identity' 屏 3 · 选身份   （固定 4 张卡，单选，须主动点选）
 *   phase 'name'    屏 4 · 填名字    （clinic → 名字 + 地区必填；其余 → 仅公司名称）
 *
 * 设计约束（对应团队任务书 C1/C2/C3/C4）：
 *   · 卡片列表用 companyTypeConfig.FIRST_RUN_TYPE_KEYS（4 值，不含 doctor），**不复用** COMPANY_TYPE_KEYS；
 *   · 地区写 company.profile.region（镜像 city），**只经 updateProfile**，绝不走 updateCompany；
 *   · 屏 2 实测通过后回调 onLLMChange({baseURL,apiKey,model}) → App 执行 setCfg + 落库，needKey 立即变假；
 *   · 「先跳过」写 localStorage['douya-ai-pending']='1'（仅记账，不写企业数据、不进记忆）。
 *
 * 完成时：onDone({ guide:false, companyId })，与 App.handleOnboardDone 契约一致（该函数零改动）。
 *
 * 注：本组件**不改**旧 Onboarding.jsx（1561 行，回滚资产 + 源码级断言依赖）。
 */

/** 「AI 待连」本地记账标记（见 PRD Q3：仅记账，不写企业数据、不进记忆）。 */
export const AI_PENDING_KEY = 'douya-ai-pending';

/** 名称 / 地区长度上限（PRD §2 屏 4：trim 非空 + 长度 ≤ 40）。 */
const NAME_MAX = 40;
const REGION_MAX = 40;

/** baseURL 归一化：补 http:// 协议前缀（照搬 App.jsx:748-762 的既有逻辑）。 */
function normalizeBaseURL(raw) {
  const t = String(raw == null ? '' : raw).trim() || 'http://192.168.80.99:10003/v1';
  return /^https?:\/\//i.test(t) ? t : 'http://' + t;
}

/** 模型名归一化：公网判定走 SSOT `services/aiReadiness.isPublicDeepSeek`（本文件不自持正则）。 */
function normalizeModel(model, baseURL) {
  const isPublic = isPublicDeepSeek(baseURL);
  const raw = String(model == null ? '' : model);
  // 0.21.10 口径：内网 deepseek-v4-pro-wb ≡ 公网 deepseek-flash（内网网关背后就是 V4.1-Flash，
  // 名字仍叫 pro-wb，**不许**改成 deepseek-v4-flash-wb —— 网关不认那个名字）。
  // 只做两件事：① 空值 / 旧别名 deepseek-chat 填本环境默认；② 把「对面环境的同族名」换算回本环境。
  // **不**覆盖显式写下的 deepseek-v4-pro（公网真 pro）—— 老配置的默认值迁移由主进程 config 的
  // modelMigrated 标记一次性完成（那里只改一次，用户之后显式改回 pro 不会再被覆盖）。
  if (!raw || raw === 'deepseek-chat') return isPublic ? 'deepseek-flash' : 'deepseek-v4-pro-wb';
  if (isPublic) {
    if (raw === 'deepseek-v4-pro-wb' || raw === 'deepseek-v4-flash-wb') return 'deepseek-flash';
    return raw;
  }
  if (raw === 'deepseek-flash' || raw === 'deepseek-v4-flash-wb') return 'deepseek-v4-pro-wb';
  if (raw === 'deepseek-v4-pro') return 'deepseek-v4-pro-wb';
  return raw;
}

/** 首登「选身份」卡面：4 张，取自独立常量 FIRST_RUN_TYPE_KEYS（不含 doctor）。 */
const FIRST_RUN_CARDS = FIRST_RUN_TYPE_KEYS.map((k) => getTypeConfig(k)).filter(Boolean);

/**
 * 首登 4 屏流程（屏 2–4）。
 * @param {object} props
 * @param {{baseURL?:string, apiKey?:string, model?:string}} [props.llmDefaults] App 传入的当前模型配置（已归一化）
 * @param {(patch:{baseURL:string,apiKey:string,model:string}) => void} [props.onLLMChange] 实测通过后回写全局配置
 * @param {(result:{guide:false, companyId:string}) => void} [props.onDone] 完成回调（交给 App 切工作台）
 */
export default function OnboardingV2({ llmDefaults, onLLMChange, onDone }) {
  const { createCompany } = useCompany();
  const { updateProfile } = useCompanyKnowledge();

  const initial = llmDefaults && typeof llmDefaults === 'object' ? llmDefaults : {};

  // ---- 屏 2「连上 AI」状态 ----
  const [phase, setPhase] = useState('ai');
  const [aiBaseURL, setAiBaseURL] = useState(() => normalizeBaseURL(initial.baseURL));
  const [aiApiKey, setAiApiKey] = useState(() => String(initial.apiKey || ''));
  const [aiModel, setAiModel] = useState(() =>
    normalizeModel(initial.model, normalizeBaseURL(initial.baseURL)),
  );
  const [aiOk, setAiOk] = useState(false); // 仅「实测 ok === true」才置真
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState(''); // 成功绿色文案
  const [aiErr, setAiErr] = useState(''); // 失败红色文案

  // ---- 屏 3「选身份」状态 ----
  const [touchedIdentity, setTouchedIdentity] = useState(false);
  const [type, setType] = useState('manufacturer'); // 默认高亮 manufacturer，但须主动点选才可下一步

  // ---- 屏 4「填名字」状态 ----
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [nameBlur, setNameBlur] = useState(false);
  const [regionBlur, setRegionBlur] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const stepIndex = phase === 'ai' ? 0 : phase === 'identity' ? 1 : 2;
  const needRegion = type === 'clinic';

  const trimmedName = name.trim();
  const trimmedRegion = region.trim();
  const nameOk = trimmedName.length > 0 && trimmedName.length <= NAME_MAX;
  const regionOk = trimmedRegion.length > 0 && trimmedRegion.length <= REGION_MAX;
  const namePhaseOk = nameOk && (!needRegion || regionOk);

  /** 改动任一 AI 字段即作废上一次「实测通过」（避免「改了配置却仍显示已连上」）。 */
  function resetAiResult() {
    setAiOk(false);
    setAiMsg('');
    setAiErr('');
  }

  /** 屏 2：实测模型连接。真打接口（services/llmTest.js），用真实 latencyMs/reply 反馈。 */
  async function testConnect() {
    if (aiBusy) return;
    const baseURL = normalizeBaseURL(aiBaseURL);
    const model = normalizeModel(aiModel, baseURL);
    const apiKey = aiApiKey.trim();
    setAiBaseURL(baseURL);
    setAiModel(model);
    setAiBusy(true);
    setAiMsg('');
    setAiErr('');
    let r = null;
    try {
      r = await testLLM({ baseURL, apiKey, model });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '连接失败' };
    }
    setAiBusy(false);
    if (r && r.ok) {
      setAiOk(true);
      setAiMsg(`✓ 模型连接成功（${r.latencyMs}ms）· 返回「${r.reply}」`);
      // 回写全局配置：App.applyLLMPatch → setCfg + saveSettings → needKey 立即变假（C3）
      if (onLLMChange) onLLMChange({ baseURL, apiKey, model });
      try { localStorage.removeItem(AI_PENDING_KEY); } catch { /* 隐私模式等异常忽略 */ }
    } else {
      setAiOk(false);
      setAiErr('✗ ' + ((r && r.error) || '连接失败'));
    }
  }

  /** 屏 2：先跳过，稍后连。记账标记后放行（不写企业数据、不进记忆）。 */
  function skipAi() {
    try { localStorage.setItem(AI_PENDING_KEY, '1'); } catch { /* 忽略 */ }
    setPhase('identity');
  }

  /** 屏 3：选中一张身份卡（务必记为「主动点选」，作为下一步闸门）。 */
  function pickType(key) {
    setType(key);
    setTouchedIdentity(true);
  }

  /** 屏 4：完成建档。clinic 额外把地区写入 profile.region（镜像 city），其余类型不写 region。 */
  function finish() {
    if (!namePhaseOk || busy) return;
    setBusy(true);
    setErr('');
    let created = null;
    try {
      created = createCompany(trimmedName, type, 'admin');
    } catch (e) {
      created = null;
    }
    const cid = created && created.id ? created.id : '';
    if (!cid) {
      setErr('创建失败，请重试');
      setBusy(false);
      return;
    }
    if (type === 'clinic') {
      updateProfile(cid, buildRegionPatch(region, type));
    }
    if (onDone) onDone({ guide: false, companyId: cid });
  }

  return (
    <div className="ob-overlay">
      <div className="ob-card ob-card-lg">
        {/* 进度点：屏 2 / 屏 3 / 屏 4（屏 1 登录在 App 的 login-overlay 里） */}
        <div className="ob-steps">
          {[2, 3, 4].map((n, i) => (
            <div key={n} className={'ob-stepdot' + (i <= stepIndex ? ' active' : '')}>
              <span className="ob-stepdot-n">{n}</span>
            </div>
          ))}
        </div>

        {/* ============ 屏 2 · 连上 AI ============ */}
        {phase === 'ai' && (
          <>
            <div className="ob-head">
              <div className="ob-title">欢迎来到豆芽</div>
              <div className="ob-sub">
                先让豆芽连上 AI，它才能替你干活。填好 API 地址与 Key，点「测试连接」验证一下。
              </div>
            </div>
            <div className="ob-fields">
              <div className="ob-field">
                <label className="ob-field-label">API 地址</label>
                <Input
                  value={aiBaseURL}
                  onChange={(e) => { setAiBaseURL(e.target.value); resetAiResult(); }}
                  placeholder="http://192.168.80.99:10003/v1"
                />
              </div>
              <div className="ob-field">
                <label className="ob-field-label">API Key</label>
                <Input.Password
                  value={aiApiKey}
                  onChange={(e) => { setAiApiKey(e.target.value); resetAiResult(); }}
                  placeholder="内网网关填 Token / 公网填 sk- Key"
                />
              </div>
              <div className="ob-field">
                <label className="ob-field-label">模型名</label>
                <Input
                  value={aiModel}
                  onChange={(e) => { setAiModel(e.target.value); resetAiResult(); }}
                  placeholder="deepseek-v4-pro"
                />
              </div>
            </div>
            {aiMsg && <div className="ob-identity-ok">{aiMsg}</div>}
            {aiErr && <div className="login-err">{aiErr}</div>}
            <div className="ob-foot">
              <Button
                type="primary"
                block
                onClick={testConnect}
                loading={aiBusy}
                disabled={aiBusy || (!aiApiKey.trim() && isPublicDeepSeek(aiBaseURL))}
              >
                {aiBusy ? '测试中…' : '测试连接'}
              </Button>
            </div>
            <div className="ob-foot ob-foot-row">
              <Button type="primary" block disabled={!aiOk} onClick={() => setPhase('identity')}>
                下一步
              </Button>
            </div>
            <div className="ob-skip" onClick={skipAi}>先跳过，稍后连</div>
          </>
        )}

        {/* ============ 屏 3 · 选身份 ============ */}
        {phase === 'identity' && (
          <>
            <div className="ob-head">
              <div className="ob-title">你是哪一种？</div>
              <div className="ob-sub">
                选一张最像你的身份卡，豆芽会据此给你匹配模板、目标和建议任务。
              </div>
            </div>
            <div className="ob-types">
              {FIRST_RUN_CARDS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={'ob-type' + (type === t.key ? ' active' : '')}
                  onClick={() => pickType(t.key)}
                >
                  <span className="ob-type-icon">{t.icon}</span>
                  <span className="ob-type-body">
                    <span className="ob-type-label">{t.cardLabel || t.shortLabel || t.label}</span>
                    <span className="ob-type-desc">{t.cardDesc || t.desc}</span>
                  </span>
                </button>
              ))}
            </div>
            {!touchedIdentity && <div className="ob-hint">点一下上面的卡片，选中你的身份</div>}
            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setPhase('ai')}>上一步</Button>
              <Button type="primary" block disabled={!touchedIdentity} onClick={() => setPhase('name')}>
                下一步
              </Button>
            </div>
          </>
        )}

        {/* ============ 屏 4 · 填名字（clinic 额外填地区） ============ */}
        {phase === 'name' && (
          <>
            <div className="ob-head">
              <div className="ob-title">{needRegion ? '你的门诊 / 名字是？' : '你的公司叫什么？'}</div>
              <div className="ob-sub">
                {needRegion
                  ? '填写门诊（或医生）名称与所在地区，豆芽后面按地区帮你做同城获客。'
                  : '填一个名称就行，其余资料之后可以在「企业资产库」里慢慢补。'}
              </div>
            </div>
            <div className="ob-fields">
              <div className="ob-field">
                <label className="ob-field-label">{needRegion ? '门诊 / 医生名称（必填）' : '公司名称（必填）'}</label>
                <Input
                  value={name}
                  maxLength={NAME_MAX}
                  onChange={(e) => { setName(e.target.value); setErr(''); }}
                  onBlur={() => setNameBlur(true)}
                  placeholder={getTypeConfig(type).namePlaceholder || '例如：康健苗苗'}
                />
                {nameBlur && !nameOk && <div className="login-err">名称不能为空（最多 {NAME_MAX} 字）</div>}
              </div>
              {needRegion && (
                <div className="ob-field">
                  <label className="ob-field-label">所在地区（必填）</label>
                  <Input
                    value={region}
                    maxLength={REGION_MAX}
                    onChange={(e) => { setRegion(e.target.value); setErr(''); }}
                    onBlur={() => setRegionBlur(true)}
                    placeholder="例如：杭州"
                  />
                  {regionBlur && !regionOk && <div className="login-err">地区不能为空（最多 {REGION_MAX} 字）</div>}
                </div>
              )}
            </div>
            {err && <div className="login-err">{err}</div>}
            <div className="ob-foot ob-foot-row">
              <Button type="text" onClick={() => setPhase('identity')} disabled={busy}>上一步</Button>
              <Button type="primary" block onClick={finish} disabled={!namePhaseOk || busy} loading={busy}>
                完成，进入工作台
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
