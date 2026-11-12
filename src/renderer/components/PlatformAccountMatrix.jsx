import React, { useMemo, useState } from 'react';
import { Button, Space, Input, Modal, App as AntApp } from 'antd';
import { useCompany } from '../store/companyStore.jsx';
import { useCompanyKnowledge } from '../store/companyKnowledgeStore.jsx';
import { useMediaAccounts } from '../store/mediaAccountStore.jsx';
import { PLATFORM_ONBOARDING } from '../data/platformOnboardingCatalog.js';

/**
 * PlatformAccountMatrix —— 「平台账号矩阵」集中管理组件。
 *
 * 合并三路数据：
 *   1. brain 的 AI 账号建议（platformAccounts：建议建什么账号）
 *   2. 已填账号（mediaAccountStore：按 companyId + platformKey 隔离）
 *   3. 入驻指引（platformOnboardingCatalog：7 平台硬编码入驻步骤）
 *
 * 每平台三态（结构层保证，已填账号绝不重复提示「建议创建」）：
 *   - 已填：显示账号 + 主页 + 备注 + 绿色「已填写」标签，提供「编辑」「删除」。
 *   - 未填 + AI 建议（should=true）：显示「建议创建」+ 推荐理由 + 优先级，提供「填写账号」。
 *   - 未填 + 无建议（或 should=false）：仅显示「入驻指引」入口。
 *
 * 绿色主题（品牌绿），禁蓝色；AI 建议顶部带「行业经验推测」声明，不伪装成事实。
 */
const GREEN = 'var(--c-brand)';
const GREEN_DARK = 'var(--c-brand-dark)';
const GREEN_BG = 'var(--c-brand-tint)';
const FAINT = 'var(--c-text-3)';

/** 优先级 → 标签文案 + 配色（非蓝，绿/黄/灰）。 */
function priorityMeta(p) {
  if (p === 'high') return { label: '高优先级', color: GREEN_DARK, bg: 'var(--c-brand-tint)' };
  if (p === 'low') return { label: '低优先级', color: 'var(--c-text-3)', bg: 'var(--c-surface-hover)' };
  return { label: '中优先级', color: 'var(--c-warn)', bg: 'var(--c-warn-tint)' };
}

export default function PlatformAccountMatrix({ onBack }) {
  const { message, modal } = AntApp.useApp();
  const { currentCompany } = useCompany();
  const { getBrain } = useCompanyKnowledge();
  const { saveAccount, removeAccount, getAccount } = useMediaAccounts();

  const companyId = currentCompany?.id || '';

  // brain 已由 getBrain 归一化；仅保留 should !== false 的建议，按 platformKey 建索引
  const brain = useMemo(() => getBrain(companyId), [getBrain, companyId]);
  const suggestionMap = useMemo(() => {
    const m = {};
    (brain.platformAccounts || []).forEach((s) => {
      if (s && s.platformKey && s.should !== false) m[s.platformKey] = s;
    });
    return m;
  }, [brain]);
  const hasSuggestions = useMemo(() => Object.keys(suggestionMap).length > 0, [suggestionMap]);

  // 入驻指引展开状态：{ [platformKey]: boolean }
  const [openGuides, setOpenGuides] = useState({});
  function toggleGuide(key) {
    setOpenGuides((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // 填写 / 编辑表单
  const [formOpen, setFormOpen] = useState(false);
  const [formPlatform, setFormPlatform] = useState(null);
  const [form, setForm] = useState({ account: '', homepage: '', note: '' });

  function openForm(platform) {
    const saved = getAccount(companyId, platform.id);
    setFormPlatform(platform);
    setForm({
      account: saved?.account || '',
      homepage: saved?.homepage || '',
      note: saved?.note || '',
    });
    setFormOpen(true);
  }

  function submitForm() {
    if (!formPlatform) return;
    if (!companyId) {
      message.warning('当前无企业上下文，无法保存');
      return;
    }
    if (!form.account.trim() && !form.homepage.trim()) {
      message.warning('请至少填写账号或主页链接');
      return;
    }
    saveAccount(companyId, formPlatform.id, {
      account: form.account.trim(),
      homepage: form.homepage.trim(),
      note: form.note.trim(),
    });
    message.success(`已保存「${formPlatform.name}」账号`);
    setFormOpen(false);
  }

  function confirmRemove(platform) {
    modal.confirm({
      title: `删除「${platform.name}」账号？`,
      content: '删除后该平台将恢复为「未填写」状态。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        removeAccount(companyId, platform.id);
        message.info(`已删除「${platform.name}」账号`);
      },
    });
  }

  /** 入驻指引展开块（entryType + summary + steps + 官方入口）。 */
  function renderGuide(platform) {
    const open = !!openGuides[platform.id];
    return (
      <div>
        <Button size="small" onClick={() => toggleGuide(platform.id)}>
          {open ? '收起入驻指引' : '📖 入驻指引'}
        </Button>
        {open ? (
          <div
            style={{
              marginTop: 10,
              padding: '10px 12px',
              background: GREEN_BG,
              borderRadius: 10,
              fontSize: 12.5,
              lineHeight: 1.7,
              color: 'var(--c-text)',
            }}
          >
            <div style={{ color: GREEN_DARK, fontWeight: 700, marginBottom: 4 }}>{platform.entryType}</div>
            {platform.summary ? <div style={{ color: FAINT, marginBottom: 6 }}>{platform.summary}</div> : null}
            {(platform.steps || []).map((s, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <span style={{ color: GREEN_DARK, fontWeight: 700 }}>
                  {i + 1}. {s.title}
                </span>
                <div style={{ color: 'var(--c-text-2)' }}>{s.detail}</div>
              </div>
            ))}
            {platform.officialUrl ? (
              <a href={platform.officialUrl} target="_blank" rel="noreferrer" style={{ color: GREEN_DARK }}>
                打开官方入驻页 →
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderCard(platform) {
    const account = getAccount(companyId, platform.id);
    const suggestion = suggestionMap[platform.id];

    // —— 态一：已填 ——
    if (account) {
      return (
        <div
          className="plan-card"
          key={platform.id}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>{platform.icon}</span>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--c-text)' }}>{platform.name}</span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: GREEN_DARK,
                background: 'var(--c-brand-tint)',
                padding: '1px 8px',
                borderRadius: 8,
              }}
            >
              已填写
            </span>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--c-text)' }}>{account.account || '—'}</div>
          {account.homepage ? (
            <div style={{ fontSize: 12.5, wordBreak: 'break-all' }}>
              <a href={account.homepage} target="_blank" rel="noreferrer" style={{ color: GREEN_DARK }}>
                {account.homepage}
              </a>
            </div>
          ) : null}
          {account.note ? <div style={{ fontSize: 12.5, color: FAINT }}>备注：{account.note}</div> : null}
          <Space size={8} style={{ marginTop: 4 }}>
            <Button size="small" onClick={() => openForm(platform)}>
              编辑
            </Button>
            <Button size="small" danger onClick={() => confirmRemove(platform)}>
              删除
            </Button>
          </Space>
        </div>
      );
    }

    // —— 态二：未填 + AI 建议 ——
    if (suggestion) {
      const pri = priorityMeta(suggestion.priority);
      return (
        <div
          className="plan-card"
          key={platform.id}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--c-brand-line)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>{platform.icon}</span>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--c-text)' }}>{platform.name}</span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: GREEN_DARK,
                background: GREEN_BG,
                padding: '1px 8px',
                borderRadius: 8,
              }}
            >
              建议创建
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: pri.color,
                background: pri.bg,
                padding: '1px 8px',
                borderRadius: 8,
              }}
            >
              {pri.label}
            </span>
          </div>
          {suggestion.why ? (
            <div style={{ fontSize: 12.5, color: 'var(--c-text)', lineHeight: 1.6 }}>{suggestion.why}</div>
          ) : null}
          <Space size={8} style={{ marginTop: 4 }} wrap>
            <Button size="small" type="primary" onClick={() => openForm(platform)}>
              填写账号
            </Button>
            {renderGuide(platform)}
          </Space>
        </div>
      );
    }

    // —— 态三：未填 + 无建议 ——
    return (
      <div
        className="plan-card"
        key={platform.id}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 20, lineHeight: 1 }}>{platform.icon}</span>
          <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--c-text)' }}>{platform.name}</span>
        </div>
        {renderGuide(platform)}
      </div>
    );
  }

  return (
    <div className="module-page">
      <div className="module-page-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {onBack ? (
            <Button size="small" onClick={onBack}>
              ← 返回
            </Button>
          ) : null}
          <h2 className="module-page-title" style={{ margin: 0 }}>
            📱 平台账号
          </h2>
        </div>
        <p className="module-page-sub">
          管 7 个平台的账号。填过的就不再提醒你了。
        </p>
      </div>

      {!companyId ? (
        <div className="xm-note">尚未选择企业，请先创建 / 切换企业后再管理账号。</div>
      ) : null}

      {hasSuggestions ? (
        <div className="xm-note" style={{ marginBottom: 14 }}>
          账号建议为 AI 行业经验推测，需运营确认后执行。
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 12,
        }}
      >
        {PLATFORM_ONBOARDING.map((p) => renderCard(p))}
      </div>

      {/* 填写 / 编辑账号 */}
      <Modal
        title={formPlatform ? `${formPlatform.icon} ${formPlatform.name} · ${getAccount(companyId, formPlatform.id) ? '编辑账号' : '填写账号'}` : '填写账号'}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        onOk={submitForm}
        okText="保存"
        cancelText="取消"
        width={440}
      >
        <div className="xm-form" style={{ maxWidth: '100%', padding: 0, border: 'none', boxShadow: 'none' }}>
          <div className="xm-field">
            <div className="field-label">账号 / 昵称 *</div>
            <Input
              value={form.account}
              onChange={(e) => setForm((f) => ({ ...f, account: e.target.value }))}
              placeholder="如：XX口腔医院官方号"
              autoFocus
            />
          </div>
          <div className="xm-field">
            <div className="field-label">主页链接</div>
            <Input
              value={form.homepage}
              onChange={(e) => setForm((f) => ({ ...f, homepage: e.target.value }))}
              placeholder="https://…"
            />
          </div>
          <div className="xm-field">
            <div className="field-label">备注</div>
            <Input.TextArea
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              rows={2}
              placeholder="如：已认证 / 待补行业资质 / 归属运营 A"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
