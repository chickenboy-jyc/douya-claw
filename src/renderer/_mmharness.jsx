/**
 * 真实浏览器 harness（临时文件，跑完即删）
 *
 * 目的：在**真 Chromium** 里挂载 MindMap，用真实 pointer/mouse 事件序列拖拽。
 * 这是唯一能证明"框能拖动"的环境 —— jsdom 少了 pointerdown，也没有真实 SVG 命中。
 *
 * 只做三件事：stub window.api、预置一张 A-B-C 的导图、挂载组件。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

// ── 1. stub window.api（MindMap 的 AI / 存档通道，本实验不用，但要防它炸）──
window.api = window.api || {
  invoke: async () => ({ ok: true }),
  on: () => () => {},
};

// ── 2. 预置导图：老板原话那张图 A-B-C ──
const DOC = {
  version: 3,
  rootId: 'r',
  nodes: [
    { id: 'r', parentId: null, order: 0, text: '主拼图' },
    { id: 'a', parentId: 'r', order: 0, text: 'A' },
    { id: 'b', parentId: 'r', order: 1, text: 'B' },
    { id: 'c', parentId: 'r', order: 2, text: 'C' },
    { id: 'a1', parentId: 'a', order: 0, text: 'A1' },
  ],
};
try {
  localStorage.setItem('douya-mindmap-doc', JSON.stringify(DOC));
  localStorage.setItem('douya-mindmap-ui', JSON.stringify({ zen: false }));
  localStorage.setItem('douya-current-company', JSON.stringify({ id: 'c-harness', name: '测试门诊' }));
} catch (e) {
  console.error('[harness] localStorage 写入失败', e);
}

// ── 3. 等 mount 后开始，并暴露读数钩子给 Playwright ──
(async () => {
  const [{ default: MindMap }, { default: CompanyProvider }] = await Promise.all([
    import('./modules/MindMap.jsx'),
    import('./store/companyStore.jsx'),
  ]);
  const root = createRoot(document.getElementById('root'));
  root.render(
    React.createElement(CompanyProvider, null, React.createElement(MindMap)),
  );

  /** 给 Playwright 读：节点矩形 + 存档快照。 */
  window.__mmRead = () => {
    const canvas = document.querySelector('[data-mm-canvas]');
    if (!canvas) return { ok: false, why: 'no canvas' };
    const cr = canvas.getBoundingClientRect();
    const nodes = [];
    canvas.querySelectorAll('[data-node-id]').forEach((g) => {
      const r = g.getBoundingClientRect();
      nodes.push({
        id: g.getAttribute('data-node-id'),
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
        text: (g.textContent || '').trim(),
      });
    });
    let doc = null;
    try {
      doc = JSON.parse(localStorage.getItem('douya-mindmap-doc') || 'null');
    } catch (e) { doc = 'PARSE_FAIL'; }
    const noticeEl = document.querySelector('.mm-notice, [data-mm-notice], .mm-error');
    return {
      ok: true,
      canvas: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
      nodes,
      doc: doc && doc.nodes ? doc.nodes.map((n) => n.id + '<' + n.parentId + '#' + n.order) : doc,
      notice: noticeEl ? (noticeEl.textContent || '').trim() : '',
      hint: document.querySelectorAll('[data-mm-drop-hint]').length,
    };
  };
  /** 给 Playwright 读：SVG 里某个节点的实际命中元素（证明 e.target 会落在 rect 上）。 */
  window.__mmHitTest = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return { tag: null, nodeId: null };
    const g = el.closest && el.closest('[data-node-id]');
    return { tag: el.tagName, nodeId: g ? g.getAttribute('data-node-id') : null };
  };
  window.__mmReady = true;
})();
