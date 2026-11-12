import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import UpdatePrompt from './components/UpdatePrompt.jsx';
import { CompanyProvider } from './store/companyStore.jsx';
import { MarketingProvider } from './store/marketingStore.jsx';
import { AssetProvider } from './store/assetStore.jsx';
import { CompanyKnowledgeProvider } from './store/companyKnowledgeStore.jsx';
import { DailyOpsProvider } from './store/dailyOpsStore.jsx';
import { MediaAccountProvider } from './store/mediaAccountStore.jsx';
import { ActivityProvider } from './store/activityStore.jsx';
import { CampaignProvider } from './store/campaignStore.jsx';
import { DirectionProvider } from './store/directionStore.jsx';
import { MonthlyPlanProvider } from './store/monthlyPlanStore.jsx';
import KnowledgeProvider from './store/knowledgeStore.jsx';
import './style.css';
/* 四期工程 · 第 1 期地基（2026-11-03）：全站主题 token 层。
   只定义 `--c-*` 语义变量（绿 / 白 / 深三套），**不含任何组件样式规则**，
   所以放哪都不会跟既有 CSS 抢选择器。位置选在 style.css 之后、
   round14/round15 之前：token 层先就位，后续页面 CSS 才谈得上引用它。
   本轮不改造任何页面 —— 见文件头「本轮范围」。 */
import './styles/theme-tokens.css';
/* ⚠️ 副作用 import，一行都不能省：它在 React 渲染任何东西之前读 `douya-theme`
   并写 `<html data-theme="…">`。放到组件里做会让刷新**闪一下**绿主题。 */
import './store/themeStore.js';
/**
 * 第十四/十五轮的品牌样式（品牌色面 token / 区块绿标 / 顶部横幅 PageBanner /
 * 助手能力胶囊）。**单独成文件**是有意的：此前这些规则全部堆在 style.css 末尾，
 * 而一次 `git stash` 冲突把 style.css 回退到旧版本 ⇒ 末尾 append 的样式整段归零，
 * 而组件与各页引用还留着 ⇒ 页面出现一堆无样式的裸元素、布局塌掉。
 * 独立文件后，style.css 再被覆盖也影响不到这里。
 * 加载位置：紧跟 style.css 之后、各模块 css 之前（同优先级下靠后者覆盖）。
 */
import './styles/round14.css';
/* 第十五轮统一版式（内容创作/媒体投放/活动与档期/学习中心/企业大脑五页共用骨架：
   宽容器 + 双栏自适应 + 统一卡片/标题/按钮）。放在 round14 之后，靠后者覆盖。 */
import './styles/round15.css';
/* 第十九轮（2026-10-19）：豆芽助手页 Apple 观感（圆角/极浅边框/阴影/系统字体栈/行高 1.7）
   + 统一任务栏（对话绿/开发黄/定时紫）+ 顶部「对话 / 工作」大号居中切换。
   同样独立成文件、放在最后引入 —— 理由与 round14/round15 一致：不动 6697 行的 style.css。 */
import './styles/round16.css';
/* 0.21.11 · 老板第 7 条：豆芽助手右栏「历史成果」按任务栏的行语言重做（一行一条 + 类型圆点 +
   悬停才出现的次要动作）。同样独立成文件、放在最后 —— 理由同上，不动 6697 行的 style.css。 */
import './styles/round16-history.css';
/* 代码块高亮配色（2026-11-08 · 主题二期）。
   ⚠️ 这条 import **保持 github-dark 不变**，是刻意的：
     · 绿主题 = 现状 —— 今天代码块就是深底，换掉它等于改现状（本轮红线）。
     · 深色主题本来就要深底。
     · 只有**白色主题**需要浅底，那部分由 `styles/theme-tokens.css` 第 ⑤ 节
       用 `html[data-theme="light"] .hljs-*` 覆盖（值全部取自 `--c-*` token）。
   为什么不改成按主题动态插拔 github.css / github-dark.css：那要在运行时管理 <link>，
   而 github.css 里的 `#6f42c1`(紫) / `#005cc5`(蓝) 都是老板禁用的色系，换上去还得再盖一遍。
   详见 theme-tokens.css 第 ⑤ 节的头注释。 */
import 'highlight.js/styles/github-dark.css';

// 捕获一切未处理错误（含事件回调/异步/模块加载），落到 console.error 便于排障
window.addEventListener('error', (e) => {
  console.error('[window.onerror]', e && e.message, e && e.filename, e && e.lineno, ':', e && e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[window.unhandledrejection]', e && e.reason && (e.reason.stack || e.reason.message || e.reason));
});

// 根级错误边界：渲染崩溃时不再白屏，而是把真实错误打到屏幕上 + console.error
class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // 落到 console.error，便于在开发者工具中定位渲染崩溃栈
    console.error('[RootErrorBoundary] render crash:', error && error.message, error && error.stack, info && info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: 'var(--c-text)', background: 'var(--c-surface)', minHeight: '100vh' }}>
          <h2 style={{ margin: '0 0 12px', color: 'var(--c-danger)' }}>渲染出错了（白屏原因）</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--c-surface-2)', border: '1px solid var(--c-border)', borderRadius: 8, padding: 16, fontSize: 13, lineHeight: 1.6 }}>
            {this.state.error && this.state.error.stack ? this.state.error.stack : String(this.state.error)}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); }}
            style={{ marginTop: 16, padding: '8px 16px', borderRadius: 6, border: 'none', background: 'var(--c-brand)', color: 'var(--c-on-brand)', cursor: 'pointer' }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <RootErrorBoundary>
    <CompanyProvider>
      <MonthlyPlanProvider>
        <MarketingProvider>
          <AssetProvider>
            <DailyOpsProvider>
              <MediaAccountProvider>
                <CompanyKnowledgeProvider>
                  <KnowledgeProvider>
                    <ActivityProvider>
                      <CampaignProvider>
                        <DirectionProvider>
                          <App />
                          <UpdatePrompt />
                        </DirectionProvider>
                      </CampaignProvider>
                    </ActivityProvider>
                  </KnowledgeProvider>
                </CompanyKnowledgeProvider>
              </MediaAccountProvider>
            </DailyOpsProvider>
          </AssetProvider>
        </MarketingProvider>
      </MonthlyPlanProvider>
    </CompanyProvider>
  </RootErrorBoundary>
);
