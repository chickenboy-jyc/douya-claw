import React, { useEffect, useState } from 'react';
import AssetPanel from '../components/AssetPanel.jsx';
import CompanyBrain from '../components/CompanyBrain.jsx';
import BrandIpManager from '../components/BrandIpManager.jsx';
import { useCompany } from '../store/companyStore.jsx';
import '../styles/ia-asset.css';
// 本轮（0.21.9）新增样式独立成文件：style.css 有 6697 行、16 个模块共用，
// 往里加一条就要担心撞名（见 lint-css-collisions）；独立文件按 import 顺序后加载、只影响本页。
import '../styles/round16-brain.css';

/**
 * 「企业大脑」（老板第 4 条：企业资产库 / 资产 / 企业大脑 / 子品牌合并，以企业大脑为核心）。
 *
 * 老板原话：「企业资产库 资产 企业大脑 子品牌 合并到一起 以企业大脑为核心 子品牌和资产都作为一个
 *           按钮放上去 然后 AI 长期记忆的改成横版 不要竖版」
 *
 * 落地口径：
 *   ① 页头就是「企业大脑」，一句话说清这里有什么（记忆 / 资产 / 子品牌）；
 *   ② **默认落在企业大脑**（不是资产表单）——「以企业大脑为核心」；
 *   ③ 资产 / 子品牌各做成一个**胶囊按钮**（老板："都作为一个按钮放上去"），一键可切，
 *      不再是侧栏里各自的一级入口（侧栏已由主理人合并为「企业大脑」一项）；
 *   ④ AI 长期记忆改横版（见 components/CompanyBrain.jsx + styles/round16-brain.css）。
 *
 * 为什么不用 antd Tabs 了（原来就是 3 个 Tab）：
 *   Tabs 的标签条自带下划线 + 灰底样式，跟老板要的「胶囊按钮」不是一回事；
 *   自己画三个按钮反而更省事，也顺手把"切回不丢状态"这件事显式写出来（见 visited）。
 *
 * @param {{initialTab?: 'brain'|'asset'|'brand'}} props initialTab 初始激活的分区（缺省 'brain'）
 */
const PANE_KEYS = ['brain', 'asset', 'brand'];

export default function CompanyProfile({ initialTab = 'brain' }) {
  const { currentCompany } = useCompany();
  const companyId = currentCompany ? currentCompany.id : null;
  const mainBrandName = currentCompany ? currentCompany.name : '';

  const [tab, setTab] = useState(PANE_KEYS.includes(initialTab) ? initialTab : 'brain');
  /**
   * 已经**挂载过**的分区。
   *
   * 这一条是为了保住改造前 `destroyInactiveTabPane={false}` 的行为：
   *   · 切走再切回，分区内部状态（表单草稿、滚动位置、已加载的数据）不能丢；
   *   · 但也不要一进页面就把三个分区全挂载 —— CompanyBrain / AssetPanel 挂载时会读存储、
   *     跑体检统计，全量挂载等于把首屏成本乘三。
   * 所以：只挂载"访问过的"，没访问过的用 display:none 藏住（React 不会卸载它）。
   */
  const [visited, setVisited] = useState(() => new Set([PANE_KEYS.includes(initialTab) ? initialTab : 'brain']));

  // 外部（引导卡跑完体检）要求切分区时跟随；仅当 initialTab 变化才同步，不干扰用户在页内的点击。
  useEffect(() => {
    const next = PANE_KEYS.includes(initialTab) ? initialTab : 'brain';
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }, [initialTab]);

  function pickTab(key) {
    if (!PANE_KEYS.includes(key)) return;
    setTab(key);
    setVisited((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }

  /**
   * 【0.21.16 · 老板第 2 条】企业建档 = 全屏分步引导。
   *
   * 入口放页头（老板是在「企业大脑」里说这件事的），点了之后：
   *   ① 先把分区切到「资产」（向导关掉后用户看到的就是资产面板，而不是空白的大脑页）；
   *   ② 再由 AssetPanel 挂出的 `CompanySetupWizard` 全屏接管。
   * 状态放在这里而不是 AssetPanel 内部：页头 CTA 与向导本体不在同一棵树里，
   * 需要一个共同真源 ⇒ 用**受控** props 传下去（AssetPanel 不传就是自管，App.jsx 的
   * 独立资产模块与 GoalGuide 里仍按老方式工作，一行没改）。
   */
  const [setupOpen, setSetupOpen] = useState(false);
  function openSetupWizard() {
    pickTab('asset');
    setSetupOpen(true);
  }

  /** 三个分区的节点。只在"访问过"时才真正渲染（见 visited 注释）。 */
  const panes = [
    // 【0.21.17 · 老板第 6 条】把页顶胶囊的切换能力传给企业大脑：
    // 「资产」「子品牌」在老板嘴里是"一键就应该到位"的两块，过去只能靠页面底部一句文字提示
    // 让人自己回页顶找按钮。现在大脑面板里直接给出两个按钮，点的就是同一个 pickTab
    // （与胶囊完全同一条路径 —— 不新开跳转、不改 URL、不重挂分区）。
    { key: 'brain', node: <CompanyBrain onJump={pickTab} /> },
    {
      key: 'asset',
      node: <AssetPanel wizardOpen={setupOpen} onWizardOpenChange={setSetupOpen} />,
    },
    { key: 'brand', node: <BrandIpManager companyId={companyId} mainBrandName={mainBrandName} /> },
  ];

  const TABS = [
    { key: 'brain', label: '企业大脑' },
    { key: 'asset', label: '资产' },
    { key: 'brand', label: '子品牌' },
  ];

  return (
    <div className="merged-tabs ia-asset-page cp-page" data-cp-module-root="1">
      <div className="ia-asset-head">
        {/* 【0.21.14 · 老板需求 4】「UI也是优化一下，可以有但有些不需要展示出来。干净一些。」
            副标题原来是一整句解释（「记忆 / 资产 / 子品牌都在这里，喂得越全，豆芽越像你的企业。」），
            换成一句短的 —— 标题与页签一个字不动（`data-cp-title` 与侧栏「企业大脑」是门禁锚点）。 */}
        <div>
          <h1 className="ia-asset-title" data-cp-title="1">企业大脑</h1>
          <p className="ia-asset-sub">记忆、资产、子品牌，一处看完。</p>
        </div>
        {/* 【0.21.16 · 老板第 2 条】建档主入口：全屏分步引导（老板说的「iphone 激活那样」）。
            老的长表单还在（资产分区 → 「高级：直接填全部字段」），这里只是把推荐路径提到页头。 */}
        <button
          type="button"
          className="cp-setup-cta"
          data-cp-setup-entry="1"
          onClick={openSetupWizard}
        >
          🧭 建档引导
        </button>
      </div>

      {/* 胶囊按钮组：选中项绿底白字，未选中白底 + 极浅描边（老板要的"圆润"取向）。 */}
      <div className="cp-tabs" role="tablist" aria-label="企业大脑分区">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-cp-tab={t.key}
            data-cp-tab-on={tab === t.key ? '1' : '0'}
            className={'cp-tab' + (tab === t.key ? ' on' : '')}
            onClick={() => pickTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {panes.map((p) => (visited.has(p.key) ? (
        <div
          key={p.key}
          className="cp-pane"
          data-cp-pane={p.key}
          // 用 display 而不是不渲染：这是"切回不丢状态"的实现方式（等价于 destroyInactiveTabPane={false}）。
          style={{ display: tab === p.key ? undefined : 'none' }}
        >
          {p.node}
        </div>
      ) : null))}
    </div>
  );
}
