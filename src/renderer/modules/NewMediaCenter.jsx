import React from 'react';
import MediaPublish from './MediaPublish.jsx';
import '../styles/ia-today.css';
// 【0.21.9 · 老板第 8 条】媒体与报价"无法下滑"的修复 + 卡片排版。
// 滚动修在 .nmc-wrap 自己身上（本页没有 antd Tabs，没有任何一层在滚 —— 根因写在 CSS 注释里）。
import '../styles/round16-media.css';

/**
 * 媒体与报价（原「新媒体中心」，2026-10-12 界面整顿 P2 更名并瘦身）。
 *
 * 本轮变化：
 *   · 显示名「新媒体中心」→ **媒体与报价**（留给用户的到底是「买哪个媒体位、多少钱」，
 *     名字对齐这件事；页面内的媒体库 `data/mediaResources.js` 本身就是外购报价表）。
 *   · 原两个页签「✍️ 生成文案 | 📣 媒体投放」中的**「生成文案」已并入「内容创作」**
 *     （ContentOps），与本页不再重叠 —— 老板要消掉的正是「同一个生成文案两处各有一份」。
 *   · 本页因此只剩「媒体投放」一件事，**故意不再套一层只有一个页签的 Tabs**
 *     （单页签 tab 是纯装饰）。外层的 `merged-tabs nmc-wrap` 类保留：
 *     它是既有验收通道（plan-exec-nav-verify 用 `.merged-tabs.nmc-wrap` 定位本页）的锚点，
 *     也承载本页的版心样式，不能顺手删。
 *
 * 被移走的 NewMediaWorkbench（生成文案 / 账号矩阵 / 数据看板）本身一个字未改，
 * 现在挂在 ContentOps 的「生成文案」页签上；`xinmeiti`（旧 key「新媒体」）在 App.jsx 里
 * 仍直连该组件，深链不受影响。
 */
export default function NewMediaCenter({ geoProxy }) {
  return (
    <div className="merged-tabs nmc-wrap">
      {/* 【2026-10-12 P2】统一页头（复用 module-page-head）。
          名字从「新媒体中心」改成「媒体与报价」，因为留给用户的其实就是
          「买哪个媒体位、多少钱」这一件事 —— 页头这句话就是这句话的字面化。 */}
      <div className="module-page-head">
        <h2 className="module-page-title">📣 媒体与报价</h2>
        <p className="module-page-sub">买哪个媒体位、多少钱，一次看清；选定后直接安排投放。</p>
      </div>
      <MediaPublish geoProxy={geoProxy} />
    </div>
  );
}
