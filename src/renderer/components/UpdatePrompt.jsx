import React, { useEffect, useState } from 'react';

// 左上角更新提示卡片（非模态，不打断操作）：
//   available   —— 显示「立即更新 / 稍后」
//   downloading —— 显示进度条
//   ready       —— 显示「正在自动重启更新」（2.5s 后主进程自动 quitAndInstall 原地替换）
//   error       —— 🔴 显示失败原因 + 「手动下载」出口（**绝不能**渲染成 null！）
//   none        —— 不渲染（无更新）
//
// 🔴 error 分支是 2026-09-22 补的，原因是实测踩到的缺陷：
//   下载失败时主进程把状态降级成 none ⇒ 这里 `return null` 把卡片收掉 ⇒
//   用户点「立即更新」后看到的唯一变化就是「卡片消失了」，没有任何文字解释。
//   老版本安装包（缺 app-update.yml，downloadUpdate 必抛 ENOENT）现场表现即此。
//   失败必须留在原地说明原因，并直接给出唯一可行的出路：手动下载。
const FALLBACK_MANUAL_URL = 'https://api.example.com/download/';

export default function UpdatePrompt() {
  const [state, setState] = useState(null); // { phase, version, percent, transferred, total, message, manualUrl }
  // 已点「立即更新」、正在等主进程回第一个状态。作用：点击后**立刻**有反馈，
  // 避免「点了没反应」的错觉（下载真正开始前有一段取 blockmap 的空档期）。
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // 监听主进程推送；组件随应用常驻，不反注册（与既有 voice:result 监听同策略）。
    let gotPush = false;
    if (window.api && typeof window.api.onUpdateState === 'function') {
      window.api.onUpdateState((s) => { gotPush = true; setPending(false); setState(s); });
    }
    // 关键补拉：启动瞬间的首次更新检查发生在**主窗口创建之前**，那次推送必然丢失
    // （窗口还不存在，主进程无处可发）。只订阅不补拉 ⇒ 正常网速下「有新版本」卡片永远不出现，
    // 用户也就永远点不到「立即更新」。所以挂载时主动拉一次最近状态。
    // 用 gotPush 守卫：若订阅后已有更新的推送到达，就不能被这次（可能更旧的）补拉结果覆盖回去。
    if (window.api && typeof window.api.getUpdateState === 'function') {
      window.api.getUpdateState()
        .then((s) => { if (s && !gotPush) setState(s); })
        .catch(() => { /* 补拉失败不影响推送路径 */ });
    }
  }, []);

  // 统一出口：照常驱动主进程，但**顺手兜住** promise —— 主进程若因意外 reject，
  // 也不能让 pending 永远卡住（卡住 = 按钮变灰、用户又看到「没反应」）。
  const act = (action) => {
    if (!window.api || typeof window.api.updateAction !== 'function') return;
    if (action === 'download') setPending(true);
    const p = window.api.updateAction(action);
    if (p && typeof p.catch === 'function') p.catch(() => setPending(false));
  };

  const openManual = (url) => {
    const u = url || FALLBACK_MANUAL_URL;
    if (window.api && typeof window.api.openExternal === 'function') window.api.openExternal(u);
  };

  if (!state || state.phase === 'none') return null;

  const card = {
    position: 'fixed',
    top: 16,
    left: 16,
    zIndex: 99999,
    width: 300,
    background: 'var(--c-surface)',
    borderRadius: 12,
    boxShadow: '0 6px 24px var(--c-shadow-color-strong)',
    padding: '14px 16px',
    fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
    color: 'var(--c-brand)',
    boxSizing: 'border-box',
  };
  const titleStyle = { fontSize: 14, fontWeight: 600, color: 'var(--c-text)', marginBottom: 4 };
  const descStyle = { fontSize: 12, color: 'var(--c-text-2)', marginBottom: 10, lineHeight: 1.5 };
  // 失败态文案：显式指定颜色，否则会继承卡片基色（绿），看起来不像"出错"。
  const errStyle = { fontSize: 12, color: 'var(--c-danger)', marginBottom: 6, lineHeight: 1.5 };
  const detailStyle = { fontSize: 12, color: 'var(--c-text-2)', marginBottom: 10, lineHeight: 1.5 };
  const btnRow = { display: 'flex', gap: 8 };
  const primaryBtn = {
    flex: 1,
    padding: '7px 0',
    border: 'none',
    borderRadius: 8,
    background: 'var(--c-brand)',
    color: 'var(--c-on-brand)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  };
  const ghostBtn = {
    flex: 1,
    padding: '7px 0',
    border: '1px solid var(--c-border)',
    borderRadius: 8,
    background: 'var(--c-surface)',
    color: 'var(--c-text-2)',
    fontSize: 13,
    cursor: 'pointer',
  };
  const barWrap = { height: 6, background: 'var(--c-surface-2)', borderRadius: 3, overflow: 'hidden', marginBottom: 6 };
  const barFill = { height: '100%', background: 'var(--c-brand)', transition: 'width 0.2s ease' };

  if (state.phase === 'available') {
    return (
      <div style={card}>
        <div style={titleStyle}>🌱 有新版本 v{state.version}</div>
        <div style={descStyle}>{pending ? '正在连接更新服务器…' : '点击立即更新，将自动下载并替换。'}</div>
        <div style={btnRow}>
          <button
            style={pending ? { ...primaryBtn, opacity: 0.55, cursor: 'default' } : primaryBtn}
            disabled={pending}
            onClick={() => act('download')}
          >立即更新</button>
          <button style={ghostBtn} onClick={() => act('later')}>稍后</button>
        </div>
      </div>
    );
  }

  // 🔴 失败态：必须留在原地说明原因 + 给唯一出路（手动下载）。
  //    渲染成 null 就是「点了立即更新没反应」这个缺陷本身，不许回退。
  if (state.phase === 'error') {
    return (
      <div style={card}>
        <div style={titleStyle}>⚠️ 自动更新未完成</div>
        <div style={errStyle}>{state.message || '更新下载失败，请稍后重试。'}</div>
        <div style={detailStyle}>可点「手动下载」到官网获取最新版安装包。</div>
        <div style={btnRow}>
          <button style={primaryBtn} onClick={() => openManual(state.manualUrl)}>手动下载</button>
          <button style={ghostBtn} onClick={() => act('dismiss')}>关闭</button>
        </div>
      </div>
    );
  }

  if (state.phase === 'downloading') {
    const pct = typeof state.percent === 'number' ? Math.max(0, Math.min(100, state.percent)) : 0;
    return (
      <div style={card}>
        <div style={titleStyle}>🌱 正在下载 v{state.version}</div>
        <div style={barWrap}><div style={{ ...barFill, width: pct + '%' }} /></div>
        <div style={descStyle}>{pct.toFixed(0)}%</div>
      </div>
    );
  }

  if (state.phase === 'ready') {
    return (
      <div style={card}>
        <div style={titleStyle}>🌱 更新已就绪</div>
        <div style={descStyle}>正在自动重启以完成更新…</div>
      </div>
    );
  }

  return null;
}
