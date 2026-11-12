/**
 * LineIcon —— 2026-10-13 第五轮「去脏乱」的统一图标语言。
 *
 * 缘起（老板原话：「为什么我发你的图片看起来那么干净，我们的首页那么脏乱」）：
 * 参考图全站用「彩色圆角方块 + 白色线性图标」，我们四处用 emoji —— emoji 各平台
 * 渲染不一、色彩风格杂，一排下来显脏。这里收拢一套内联 SVG 线性图标 + 固定四色
 * （绿 green / 青 teal / 紫 purple / 橙 orange），首页、活动页共用。
 *
 * 规矩：
 *  · 只放装饰性图标，不带任何业务语义（语义由旁边的文字承担）；
 *  · 颜色跟着 tone 走，不一个图标一个颜色；
 *  · 新增图标就往上加，别在调用处散着写 SVG。
 */
import React from 'react';

const ICONS = {
  pen: { tone: 'green', d: <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></> },
  calendar: { tone: 'teal', d: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></> },
  search: { tone: 'purple', d: <><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></> },
  clock: { tone: 'orange', d: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></> },
  yen: { tone: 'orange', d: <><path d="M7 7l5 6 5-6M12 13v6M9.5 14h5" /></> },
  chart: { tone: 'green', d: <><path d="M3 21V9M9 21V4M15 21v-8M21 21v-13" /></> },
  rocket: { tone: 'orange', d: <><path d="M5 13c-1.5 1.5-2 5-2 5s3.5-.5 5-2" /><path d="M9 15l-3-3a12 12 0 0 1 8-8l3 3a12 12 0 0 1-8 8z" /><circle cx="14.5" cy="9.5" r="1.5" /></> },
  users: { tone: 'teal', d: <><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></> },
  heart: { tone: 'purple', d: <><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8z" /></> },
  gift: { tone: 'orange', d: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /><path d="M12 8c-1.5 0-4-.5-4-3s2.5-1.5 4 3zm0 0c1.5 0 4-.5 4-3s-2.5-1.5-4 3z" /></> },
  folder: { tone: 'teal', d: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></> },
  doc: { tone: 'green', d: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></> },
  palette: { tone: 'purple', d: <><circle cx="12" cy="12" r="9" /><circle cx="8.5" cy="10" r="1" fill="currentColor" /><circle cx="12" cy="7.5" r="1" fill="currentColor" /><circle cx="15.5" cy="10" r="1" fill="currentColor" /><path d="M12 21a3 3 0 0 1 0-6h1.5a2.5 2.5 0 0 0 0-5" /></> },
  package: { tone: 'orange', d: <><path d="M21 8l-9-5-9 5v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></> },
  // 【2026-10-14 第七轮】补导航与模块页需要的图标：全部中性灰（tone 只作占位，
  // CSS 里四色已统一收敛成 rgba(0,0,0,0.05) 底 + #1d1d1f 线 —— 见 ia-dashboard.css）。
  home: { tone: 'green', d: <><path d="M3 10.5L12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></> },
  chat: { tone: 'green', d: <><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.9 8.9 0 0 1-3.8-.8L3 21l1.8-5.2A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" /></> },
  radar: { tone: 'green', d: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l6.5-4" /><path d="M12 3v2M21 12h-2M12 21v-2M3 12h2" /></> },
  megaphone: { tone: 'green', d: <><path d="M3 11l14-6v14L3 13z" /><path d="M3 11v2a3 3 0 0 0 3 3h1l1 4 2-4" /><path d="M7 12h12v3a3 3 0 0 1-3 3h-4" /></> },
  compass: { tone: 'green', d: <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></> },
  building: { tone: 'green', d: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /><path d="M11 21v-3h2v3" /></> },
  book: { tone: 'green', d: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20" /></> },
  sparkle: { tone: 'green', d: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z" /></> },
  tag: { tone: 'green', d: <><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" /></> },
  globe: { tone: 'green', d: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" /></> },
  lantern: { tone: 'green', d: <><path d="M9 3h6l-1 3H10z" /><rect x="6" y="6" width="12" height="12" rx="5" /><path d="M9 21h6M12 18v3" /></> },
  play: { tone: 'green', d: <><circle cx="12" cy="12" r="9" /><path d="M10 8.5l6 3.5-6 3.5z" /></> },
  check: { tone: 'green', d: <><path d="M20 6L9 17l-5-5" /></> },
  // 0.21.10：输入框上传附件按钮用（原来那处只有 emoji，各平台渲染不一致、显脏）。
  upload: { tone: 'green', d: <><path d="M12 16V4" /><path d="M7.5 8.5L12 4l4.5 4.5" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></> },
  arrow: { tone: 'green', d: <><path d="M5 12h14M13 6l6 6-6 6" /></> },
};

const TONE_CLASS = {
  green: 'li-green',
  teal: 'li-teal',
  purple: 'li-purple',
  orange: 'li-orange',
};

/**
 * 线性图标。name 见 ICONS；不认识的 name 回落 pen。
 *
 * variant 两种（第十二轮 2026-10-14 新增，为对齐基准图 docs/ref/01-home.jpg）：
 *   'tile'（默认）—— 浅色圆角底 + 同色系深色图形，用在功能卡/列表行
 *                    （基准图「常用操作」四卡就是这种：浅绿底 + 深绿图形）
 *   'plain'        —— **无底色**方块 + 直接实心/描边图形，用在左侧导航
 *                    （基准图侧栏：未选中是深灰描边、选中是实心绿且整行浅绿底）
 * 之前只有 tile 一种，导航也在用，于是侧栏一列五个彩色块，与基准图差很远。
 */
export default function LineIcon({ name, size = 22, variant = 'tile' }) {
  const ic = ICONS[name] || ICONS.pen;
  const plain = variant === 'plain';
  return (
    <span
      className={(plain ? 'line-ic line-ic-plain ' : 'line-ic ') + (TONE_CLASS[ic.tone] || 'li-green')}
      style={{ width: size + 8, height: size + 8 }}
    >
      <svg
        viewBox="0 0 24 24"
        fill={plain ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        width={size}
        height={size}
      >
        {ic.d}
      </svg>
    </span>
  );
}
