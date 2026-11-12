import React, { useEffect, useMemo, useState } from 'react';
import {
  FEEDBACK_TYPE_OPTIONS,
  readHistory,
  clearHistory,
  submitFeedback,
} from '../services/support.js';

/**
 * SupportAssistant —— 客服助手悬浮面板（P0）。
 *
 * 形态：右下角一个**纯 CSS 悬浮层**（照 BackgroundJobsBar 范式，**不新开 BrowserWindow**）。
 * 点开是「提交反馈」面板：类型（4 选 1 必填）+ 标题（选填）+ 描述（必填）+ 联系方式（选填）。
 * 提交成功给出明确成功反馈，并在本地**永久保留**自己提交过的记录（可查看、可清空；只增不减）。
 *
 * 边界（P0 明确不做）：实时双向聊天、截图上传、客服回复推送 —— 均留 P1。
 *
 * 红线：本组件只做「收集 + 提交 + 展示本地历史」，不读写任何业务数据；
 *       网络出口全在 services/support.js → api.supportSubmit → 主进程（渲染层不直连外网）。
 *
 * 样式：绿色主题 + Apple/macOS 极简风（见 style.css 的 .support-* 段，沿用现有 CSS 变量）。
 */
/**
 * 受控/非受控两用（0.21.11）。
 *
 * 老板第 8 条：「账号和设置客服反馈 放顶部吧…右边的客服反馈可以删掉了」。
 * 于是本组件从「右下角常驻胶囊」改成「顶栏按钮 + 面板」：
 *   · open / onOpenChange 传了就按受控处理（App 顶栏「反馈」按钮控制）；
 *   · 不传则保持老行为（组件内部自管开关 + 渲染浮动胶囊），
 *     这样任何单独引用本组件的地方、以及老的视觉验收脚本都不会因为缺 props 而白屏。
 *   · hideFab：只要面板、不要右下角那个胶囊（App 里就是这么用的）。
 *
 * @param {object} props
 * @param {boolean} [props.open] 受控开关
 * @param {(next:boolean)=>void} [props.onOpenChange] 受控回调
 * @param {boolean} [props.hideFab] 隐藏右下角浮动按钮
 */
export default function SupportAssistant({ open: openProp, onOpenChange, hideFab = false } = {}) {
  const controlled = typeof openProp === 'boolean';
  const [openState, setOpenState] = useState(false);
  const open = controlled ? openProp : openState;
  const setOpen = (next) => {
    const v = typeof next === 'function' ? next(open) : next;
    if (!controlled) setOpenState(v);
    if (typeof onOpenChange === 'function') onOpenChange(v);
  };
  const [type, setType] = useState(FEEDBACK_TYPE_OPTIONS[0] ? FEEDBACK_TYPE_OPTIONS[0].value : 'bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // { ok:boolean, message:string } | null
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  // 打开面板时才读历史（避免无谓渲染）
  useEffect(() => {
    if (open) setHistory(readHistory());
  }, [open]);

  const typeLabel = useMemo(() => {
    const hit = FEEDBACK_TYPE_OPTIONS.find((o) => o.value === type);
    return hit ? hit.label : '';
  }, [type]);

  async function onSubmit(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (submitting) return;
    if (!type) {
      setResult({ ok: false, message: '请选择反馈类型' });
      return;
    }
    if (!description.trim()) {
      setResult({ ok: false, message: '请填写问题描述' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const r = await submitFeedback({ type, title, description, contact });
      if (r && r.ok) {
        setResult({ ok: true, message: r.message || '反馈提交成功！' });
        setTitle('');
        setDescription('');
        setContact('');
        setHistory(readHistory());
      } else {
        setResult({ ok: false, message: (r && r.error) || '提交失败，请稍后重试' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  function onClearHistory() {
    clearHistory();
    setHistory([]);
  }

  return (
    <>
      {hideFab ? null : (
        <button
          type="button"
          className={'support-fab' + (open ? ' open' : '')}
          title="客服反馈 · 留言 / 提建议（反馈直达豆芽团队）"
          aria-label="客服反馈"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="support-fab-glyph">{open ? '×' : '💬'}</span>
          <span className="support-fab-text">{open ? '收起' : '客服反馈'}</span>
        </button>
      )}

      {open ? (
        <div className="support-panel" role="dialog" aria-label="客服助手">
          <div className="support-hd">
            <span className="support-title">客服助手</span>
            <span className="support-sub">留言 / 反馈会直接送到豆芽团队</span>
            <button type="button" className="support-close" title="关闭" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>

          <form className="support-form" onSubmit={(e) => onSubmit(e)}>
            <div className="support-label">类型</div>
            <div className="support-types">
              {FEEDBACK_TYPE_OPTIONS.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  className={'support-type' + (type === o.value ? ' active' : '')}
                  title={o.desc}
                  onClick={() => setType(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <label className="support-label" htmlFor="support-title-input">
              标题（选填）
            </label>
            <input
              id="support-title-input"
              className="support-input"
              type="text"
              value={title}
              maxLength={120}
              placeholder="一句话概括"
              onChange={(e) => setTitle(e.target.value)}
            />

            <label className="support-label" htmlFor="support-desc-input">
              描述 <span className="support-req">必填</span>
            </label>
            <textarea
              id="support-desc-input"
              className="support-textarea"
              value={description}
              rows={5}
              placeholder="遇到了什么问题？希望能怎么改进？"
              onChange={(e) => setDescription(e.target.value)}
            />

            <label className="support-label" htmlFor="support-contact-input">
              联系方式（选填）
            </label>
            <input
              id="support-contact-input"
              className="support-input"
              type="text"
              value={contact}
              maxLength={120}
              placeholder="手机号 / 微信 / 邮箱"
              onChange={(e) => setContact(e.target.value)}
            />

            {result ? (
              <div className={'support-result' + (result.ok ? ' ok' : ' bad')} role="status">
                {result.message}
              </div>
            ) : null}

            <button type="submit" className="support-submit" disabled={submitting}>
              {submitting ? '提交中…' : '提交反馈'}
            </button>
            <div className="support-hint">当前类型：{typeLabel} · 内容上限 2MB</div>
          </form>

          <div className="support-history">
            <div className="support-history-hd">
              <span>我提交过的（永久保留）</span>
              {history.length > 0 ? (
                <button type="button" className="support-link" onClick={onClearHistory}>
                  清空
                </button>
              ) : null}
            </div>
            {history.length === 0 ? (
              <div className="support-empty">还没有提交记录</div>
            ) : (
              history.map((h, i) => (
                <div className="support-hitem" key={String(h.at || 0) + '-' + i}>
                  <span className="support-hbadge">{typeText(h.type)}</span>
                  <span className="support-hmain">{h.title || h.description || '（无标题）'}</span>
                  <span className="support-htime">{fmtTime(h.at)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 类型值 → 界面文案（取不到就原样回显）。 */
function typeText(value) {
  const hit = FEEDBACK_TYPE_OPTIONS.find((o) => o.value === value);
  return hit ? hit.label : String(value || '');
}

/** 时间戳 → 「M/D HH:mm」。 */
function fmtTime(at) {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
