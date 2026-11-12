/**
 * PageBanner —— 页面顶部横幅（第十四轮 2026-10-14 新增）
 *
 * 老板给的效果图（docs/ref/06-hero-banner.jpg，活动与档期页）实测规格：
 *   尺寸      ≈ 920 × 90px（1x截图，实机按 2x 折算）
 *   圆角      ≈ 14px
 *   描边/阴影  **都没有** —— 只有一层极淡的白边
 *   底色      纵向渐变：上 #EBF9F8（浅薄荷）→ 下 #D6F4EC（浅青）
 *   左插画    ≈ 72px 日历图形，外面一圈更大的浅色圆形光晕（同色系再浅一档）
 *   主标题    ≈ 26px 800 字重，深墨绿（不是纯黑）
 *   副标题    ≈ 15px 常规，灰绿
 *   右侧标语  手写体、绿色、带下划线装饰，垂直居中、略微上斜
 *
 * 之前的页头只是「一行标题文字」，没有底、没有插画、没有标语 ⇒
 * 页面顶部空一块、且完全没有品牌感。这是四个页面通用的顶部形象位。
 *
 * 用法：
 *   <PageBanner ic="calendar" title="活动与档期"
 *               sub="策划品牌活动，安排档期资源，让每一次营销都有回响。"
 *               slogan="好的活动，让品牌更有记忆点" />
 */
import React from 'react';
import LineIcon from './LineIcon.jsx';

/** 每页一套文案。sub 说清「这是什么 + 进来干什么」，slogan 是给老板看的那句人话。 */
export const PAGE_BANNERS = {
  home: {
    ic: 'home',
    title: '康健苗苗',
    sub: '你今天有什么想推进的？说一声，我按企业大脑给你答案。',
    slogan: '把每一次经营，都变成可复制的动作',
  },
  content: {
    ic: 'pen',
    title: '内容创作',
    sub: '一句话说清要写什么，豆芽按企业大脑出稿，写完直接复制就能发。',
    slogan: '好内容，是替品牌把话说清楚',
  },
  activity: {
    ic: 'calendar',
    title: '活动与档期',
    sub: '策划品牌活动，安排档期资源，让每一次营销都有回响。',
    slogan: '好的活动，让品牌更有记忆点',
  },
  intel: {
    ic: 'radar',
    title: '竞品分析',
    sub: '盯住主要竞品的动态与优势，找到你能抓住的机会点。',
    slogan: '看清对手，才知道往哪走',
  },
  assistant: {
    ic: 'chat',
    title: '豆芽助手',
    sub: '基于企业知识库与行业数据，为你提供专业的业务支持。',
    slogan: '问一句，就能开始干',
  },
};

/**
 * right 插槽：竞品页页头右上角有「重新分析」按钮（真实功能，不能丢），
 * 用插槽塞进横幅右侧，而不是把横幅和按钮拆成两块。
 */
export default function PageBanner({ ic = 'calendar', title, sub, slogan, compact = false, right = null }) {
  return (
    <div className={'page-banner' + (compact ? ' compact' : '')}>
      {/* 左侧插画：图形 + 一圈同色系浅光晕（基准图上是日历外面那圈更浅的圆） */}
      <div className="page-banner-ic" aria-hidden="true">
        <span className="page-banner-ic-halo" />
        <LineIcon name={ic} size={38} variant="plain" />
      </div>

      <div className="page-banner-txt">
        <h2 className="page-banner-title">{title}</h2>
        {sub ? <div className="page-banner-sub">{sub}</div> : null}
      </div>

      {right ? <div className="page-banner-right">{right}</div> : null}

      {/* 右侧手写体标语（基准图里是斜体绿字 + 下划线装饰） */}
      {slogan && !right ? (
        <div className="page-banner-slogan" aria-hidden="true">
          <span className="page-banner-slogan-t">{slogan}</span>
          <svg className="page-banner-slogan-line" viewBox="0 0 120 10" preserveAspectRatio="none">
            <path d="M2 7 C 30 2, 90 2, 118 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </div>
      ) : null}
    </div>
  );
}