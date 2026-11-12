import React from 'react';
import { getTypeConfig } from '../config/companyTypeConfig.js';

// 导航入口（左侧 + 首页能力区块双入口）。
// 一级入口按「用户要办的事」分组，而不是按「后台由谁开发」平铺：
//   · 首页 / 豆芽 —— 两个 standalone 小岛，恒置顶
//   · 常用       —— 竞品分析 / 内容创作 / 媒体与报价
//   · 活动与档期  —— 做活动方案 / 上游货源档期
//   · 更多工具    —— 经营方案 / 企业资料 / 学习中心
// 入口 key / desc / icon 与旧版一一对应，仅调整**分组归属与显示名**，不改语义、不增删锚点。
//
// 【2026-09-12 老板反馈 #1 / #10】
//   · 恢复 `learn` 学习中心为一级入口（此前只在 ACTIVE_ALIAS 里被折叠到 today，
//     导致「学习中心哪去了」——模块一直在，就是没有入口）。
//   · `profile` 由「企业大脑」更名为「企业资料」（老板明确要求）。
//     该更名会波及按 label 文本定位导航卡的验收脚本，故每个导航卡额外输出
//     `data-module` 锚点，脚本应优先按锚点匹配、label 仅作兜底 —— 以后再改名不会再断测试。
//     【2026-10-12 验证过这条护栏真的生效】P2 一次性改了 4 个显示名
//     （内容与传播→内容创作 / 新媒体中心→媒体与报价 / 经营诊断→竞品分析 / 活动策划→做活动方案），
//     凡是早就按锚点定位的通道（ai-buttons / assistant-panel / newmedia-copy-context）零改动通过；
//     凡是仍按 label 定位的通道才会红 —— 本轮已把它们一并切到锚点。
//     ⚠️ 精确点说：能零改动通过的只有**纯按锚点定位**、且**没有把旧 label 写进断言**的那些通道。
//     按锚点定位但把「点击方式 === 'by-label'」当断言的（如 brand-assets）依然会红，
//     因为它验的其实不是「能不能进这个模块」，而是「模块名有没有被改」——
//     那类断言必须随改名一起更新为 'by-data-module'，不是放宽门禁，是让断言回到它本来的意图。
// 【2026-10-12 界面整顿 P2：导航收口】老板反馈「左侧菜单必须合并 / 不要按后台由谁开发来分组」，
// 本轮把一级入口按「用户要办的事」重排为：首页 / 豆芽 → 常用 → 活动与档期 → 更多工具。
//
// 三条**不可违反**的硬约束（改这一处之前请先读，否则会踩到全套测试门禁）：
//
//   ① **锚点一个都不能少**（`unit-role-diff-ui.mjs` S1 锁死「11 个模块」、
//      A2 锁死「每身份锚点集合 = 原始集合经 roles 过滤后的可见集合」）。
//      所以「合并入口」只能靠**改分组 + 改显示名**，不能把 content/newmedia
//      这类锚点从数组里删掉。它们仍是可深链、可被 AI 建议、可被测试点到的独立模块。
//      ⚠️ 唯一例外是**整板块下线**（老板明令删除的功能）：2026-10-21「活动与档期」
//      (`activity`) 就是这种情况 —— 锚点连同页面一起删，S1 的期望值同步 12 → 11。
//      判据很简单：删掉之后**这个页面还在不在**。还在 ⇒ 改分组；没了 ⇒ 减锚点。
//      ⚠️ 2026-10-14 起 `roles` 过滤是**有意行为**（老板定：侧栏按身份变）：
//      storeops 只给 clinic/doctor、dealerbuy 只给 dealer ⇒ 各身份锚点集合
//      **按设计不同**，A2 的期望值是「过滤后的可见集合」而不是原始全量。
//
//   ② **五种身份的导航顺序必须两两不同**（同一个测试的 A1 锁死 `distinct === 5`），
//      由 companyTypeConfig 的 moduleOrder 驱动。A1b 反空过已相应收敛到
//      「同一可见集合内的身份顺序两两不同」——roles 过滤本身就会让集合不同，
//      旧判据（五身份整体去重 > 1）会被过滤本身满足 ⇒ 失效。
//
//   ③ 每个卡片都输出 `data-module` 锚点（见下方渲染），测试脚本一律按锚点定位、label 仅兜底。
//
// 本轮相对旧版的**全部**差异（只动归属与显示名，不动任何模块内部）：
//   · 「内容与传播」(content) 更名 **内容创作**，容器内容改为「日常内容 | 生成文案」
//     —— 原「活动策划」页签移出（活动相关统一收拢到「活动与档期」），「生成文案」从新媒体中心并入。
//   · 「新媒体中心」(newmedia) 更名 **媒体与报价**，容器只剩「媒体投放（含媒体库真实报价）」
//     —— 原「生成文案」页签已并到「内容创作」，两处不再各有一份。
//   · 「活动策划」(activity) 更名 **做活动方案**，与「上游货源档期」(miaomiao) 同组，
//     组名即合并后的入口名 **活动与档期**（老板原话：「内部再区分做方案、看档期」）。
//   · 「经营诊断」(intel) 更名 **竞品分析**（该页本来就是竞品对比 / GEO / SEO 曝光，入口名对齐内容）。
//   · 低频入口「经营方案 / 企业资料 / 学习中心」收进 **更多工具**。
//   · 「企业资料」「豆芽对话」「学习中心」的显示名**故意保持不变**
//     —— 它们各自是老板此前明确点名要求的名字，且已有专门测试守住。
export const MODULE_GROUPS = [
  /**
   * 【2026-10-14 老板定稿：侧边栏就这 10 项，不再拆组】
   *
   * 改之前是 12 项、分5 组（首页 / 豆芽/ 常用[竞品·内容·媒体] / 活动与档期[做活动方案·
   * 上游货源档期] / 更多工具[经营方案·企业资产库·学习中心]）。老板的原话是
   * 「左边的内容怎么变多了」—— 分组标题 + 每项两行文字（标题+说明）把侧栏拉得很长。
   *
   * 这版的三处结构性调整：
   *   ① 全部**扁平**：不设分组标题（g.label 渲染成空串，见组件里条件渲染），
   *      「更多工具 / 企业资料 / 经营方案 / 学习中心」四项与其它入口平级。
   *   ② **豆芽对话 → 豆芽助手**（老板清单里的叫法；功能不变，只是显示名对齐）。
   *   ③ **上游货源档期(miaomiao) 从侧边栏移除**：老板清单里只有「活动与档期」一项。
   *      但**功能不删** —— 它仍是活动与档期页内的页签，也仍可被深链/跨模块跳转抵达
   *      （ACTIVE_ALIAS 保留映射，侧栏高亮到「活动与档期」父入口，用户知道自己在哪）。
   *      如需恢复侧栏入口，把下面 activity 分组的 modules 里加回 { key:'miaomiao' … } 即可。
   */
  /**
   * 【2026-10-19 第十九轮 · 老板第 1、9 条】
   * ① 删除「首页」入口：它和「豆芽助手」渲染的是同一个对话框（2026-10-18 第十六轮合并的），
   *    侧栏留两项等于让用户以为有两个首页 —— 老板原话「首页和豆芽助手重复了 删掉一个」。
   *    只删入口，不删能力：`home` 仍在 App.jsx 的 LEGACY_MODULE_ALIAS 里折叠到 workbench，
   *    老用户 localStorage 里存着的 'home' 打开后直接落到豆芽助手，不会白屏。
   * ② 侧栏顺序按老板第 9 条重排：豆芽助手 → 内容创作 → 竞品分析 → 活动与档期 →
   *    媒体与报价 → 学习中心 → 企业大脑 → 经营方案。
   *    `storeops` / `dealerbuy` 是身份专属入口（只对诊所/经销商出现），
   *    老板清单里没有它们，故紧跟在豆芽助手之后，不打断主顺序。
   */
  {
    key: 'douya',
    label: '',
    standalone: true,
    modules: [
      { key: 'workbench', icon: '🌱', label: '豆芽助手', desc: '对话 / 工作 / 定时任务' },
    ],
  },
  {
    key: 'storeops',
    label: '',
    standalone: false,
    /** 只对牙医 / 诊所可见（老板 2026-10-14 定：按身份差异化）。
     *  厂家 / 平台看到的是内容、媒体、活动这套，门店经营用不上，硬塞只是噪音。 */
    roles: ['clinic', 'doctor'],
    modules: [
      { key: 'storeops', icon: '🏪', label: '门店运营', desc: '补货 / 周边竞品 / 活动 / 病历' },
    ],
  },
  {
    key: 'dealerbuy',
    label: '',
    standalone: false,
    /** 只对经销商可见（老板 2026-10-14：经销商只要「批量买东西 + 看优惠的商品」）。 */
    roles: ['dealer'],
    modules: [
      { key: 'dealerbuy', icon: '🛒', label: '采购专区', desc: '批量采购 / 优惠专区' },
    ],
  },
  {
    /**
     * 【0.21.25 · 2026-11-02】新增「思维导图」。
     *
     * 老板原话：「里面还要有一个思维导图的功能 思维导图与AI的结合体 让AI可以编写思维导图
     * 或者根据目前的导图去扩散」—— 两个动词都真有落点，不是只做个画布：
     *   `AI 生成` = 从零编写一整棵；`AI 扩散` = 选中某个节点往外长（原话点名的那个）。
     * 另补两个同样高频的：`AI 换框架`（整体按 5W2H/7S/PDCA/SCQA 重构）与
     * `AI 润色`（只改文字不动结构）。
     *
     * 位置放在「内容创作」**正前面**，动线是「先理清结构 → 再写内容 → 再做视频」。
     * 导图是想清楚的工具，排在内容后面就变成「写完再整理」，动线反了。
     *
     * ⚠️ 模块总数 11 → 12，**三处必须同序同数**：
     *    ① 本文件 MODULE_GROUPS       ② companyTypeConfig.CANONICAL_MODULE_ORDER
     *    ③ scripts/smoke/unit-role-diff-ui.mjs 的 BOSS_ORDER + S1 + A1C（含断言名文案）
     *    漏改任何一处：S1 先红（模块总数不符），A1 再逐位报错。
     *
     * ⚠️ **必须 `standalone: false`**：S1b 与 A2b 都锁死「standalone 组唯一、且只含
     *    workbench」。标成 true 会让它插到豆芽助手**前面**，侧栏首项就不再是对话入口。
     * ⚠️ **不写 `roles`**：五种身份都用得上（厂家排招商策略、诊所排门店活动、经销商排
     *    备货节奏），写 roles 只会让 A1 的「可见集合」按身份分叉，多一处门禁摩擦而
     *    换不来任何界面收益。
     */
    key: 'mindmap',
    label: '',
    standalone: false,
    modules: [
      { key: 'mindmap', icon: '🗺️', label: '思维导图', desc: 'AI 生成 / 扩散 / 换框架' },
    ],
  },
  {
    key: 'content',
    label: '',
    standalone: false,
    modules: [
      { key: 'content', icon: '✍️', label: '内容创作', desc: '日常内容 / 精品文章' },
    ],
  },
  {
    /**
     * 【0.21.20 · 老板 2026-10-21】新增「视频设计」。
     *
     * 老板原话：「在里面增加一个板块 叫做视频设计 接入通义万象3.0」。
     * 位置放在「内容创作」**正后面**：动线是「先写内容 → 再做视频/配图」，
     * 而不是塞进「更多工具」当低频功能 —— 它是一个会天天用的生产工具。
     *
     * ⚠️ 加这一组会让模块总数 11 → 12（本轮之后随着「活动与档期」下线又回到 11），
     *    **三处必须同序同数**：
     *    ① 本文件 MODULE_GROUPS       ② companyTypeConfig.CANONICAL_MODULE_ORDER
     *    ③ scripts/smoke/unit-role-diff-ui.mjs 的 BOSS_ORDER + S1（origKeys.length）+ A1C 文案
     *    漏改任何一处：S1 先红（组数不符），A1 再逐位报错。
     */
    key: 'videodesign',
    label: '',
    standalone: false,
    modules: [
      { key: 'videodesign', icon: '🎬', label: '视频设计', desc: '通义万象 3.0 · 出视频 / 出图' },
    ],
  },
  {
    /**
     * 【0.21.26 · 老板 2026-11-09】新增「视频精剪」。
     *
     * 老板原话：「新做的 concat 一定也有问题 比如导入视频 视频与音频轨道 你可以参考
     * 剪映 对吧 以及导出 mp4 格式 核心功能都要有」。
     * 位置放在「视频设计」**正后面**：动线是「先让 AI 出素材 → 再把素材剪成成片」。
     *
     * ⚠️ 它和 `videodesign` 是**两个模块**，不许合并：
     *    · `videodesign` = 通义万象 3.0 **云端生成**视频/图片（一次一问答）；
     *    · `videostudio` = 本机 Concat 引擎的**多轨剪辑器**（导入/轨道/裁剪/字幕/导出 mp4）。
     *    语义、数据源、失败模式完全不同 —— 塞进同一页只会两边都做不好。
     *
     * ⚠️ 加这一组会让模块总数 12 → 13，**三处必须同序同数**：
     *    ① 本文件 MODULE_GROUPS       ② companyTypeConfig.CANONICAL_MODULE_ORDER
     *    ③ scripts/smoke/unit-role-diff-ui.mjs 的 BOSS_ORDER + S1（origKeys.length）+ A1C 文案
     *    漏改任何一处：S1 先红（模块数不符），A1 再逐位报错。
     */
    key: 'videostudio',
    label: '',
    standalone: false,
    modules: [
      { key: 'videostudio', icon: '✂️', label: '视频精剪', desc: '多轨剪辑 · 字幕 · 导出 mp4' },
    ],
  },
  {
    key: 'intel',
    label: '',
    standalone: false,
    modules: [
      { key: 'intel', icon: '📡', label: '竞品分析', desc: 'AI 挑竞品 / 对比 / GEO 曝光' },
    ],
  },
  /**
   * 【0.21.21 · 老板 2026-10-21】「活动与档期」卡片已删除（原 group key `schedule`，
   * module key `activity`，label「活动与档期」，desc「做方案 / 看档期」）。
   *
   * 老板原话：「这个功能删了 workbench里面这个也删了 技术部做了个一样的 整个活动与档期删除」。
   * 删的是**板块**，不是「做活动方案」的能力：
   *   · 能力留在 `campaign`（营销专项 = CampaignModule，一句话生成活动方案），
   *     以及经营方案 / 学习中心里内嵌的 ActivityChat；
   *   · 老存档 / 深链里的 `activity`、`huodong`、`miaomiao` 全部由
   *     App.jsx 的 LEGACY_MODULE_ALIAS 归位（→ workbench / campaign / workbench），
   *     不会落到不存在的分支上（那样主体区会整块白屏）。
   * ⚠️ 删这一组会让模块总数 12 → 11，**三处必须同序同数**：
   *    ① 本文件 MODULE_GROUPS       ② companyTypeConfig.CANONICAL_MODULE_ORDER
   *    ③ scripts/smoke/unit-role-diff-ui.mjs 的 BOSS_ORDER + S1（origKeys.length）+ A1C 文案
   *    漏改任何一处：S1 先红（组数不符），A1 再逐位报错。
   * ⚠️ 这里**刻意不留一个空壳分组**（`{ key:'schedule', modules: [] }`）：空组会照样被
   *    `orderModuleGroups` 计入、被渲染成一个空容器，S1 的组数也就不会真的减下来 ——
   *    等于把「已删除」伪装成「还在」。整组一起拿掉才是干净状态。
   */
  {
    key: 'newmedia',
    label: '',
    standalone: false,
    modules: [
      { key: 'newmedia', icon: '📣', label: '媒体与报价', desc: '媒体投放 / 媒体库报价' },
    ],
  },
  {
    key: 'learn',
    label: '',
    standalone: false,
    modules: [
      { key: 'learn', icon: '📚', label: '学习中心', desc: '行业资讯 / 课程 / 平台入驻' },
    ],
  },
  {
    key: 'profile',
    label: '',
    standalone: false,
    modules: [
      // 【2026-10-19 第十九轮 · 第 4 条】「企业资料 / 企业资产库」统一并入**企业大脑**，
      // 资产与子品牌降级为页内按钮（CompanyProfile.jsx），侧栏只留一个入口。
      { key: 'profile', icon: '🧠', label: '企业大脑', desc: '记忆 / 资产 / 子品牌' },
    ],
  },
  {
    key: 'more',
    label: '',
    standalone: false,
    modules: [
      { key: 'direction', icon: '🧭', label: '经营方案', desc: '我现在最该做什么' },
      /**
       * 【0.21.16 · 老板第 6 条】AI 补货从「采购线」挪到**经营方案下面**。
       *
       * 老板原话：「AI 补货放在经营方案下面。」
       * 上一版（0.21.14 需求 3）把它放在 `dealerbuy` 之后，理由是「补货属采购线」——
       * 那是**按功能分类**的排法；老板要的是**按使用场景**排：先看「我现在最该做什么」
       * （经营方案），看完方案自然接着就是「那该补什么货」。分类正确但动线反了。
       *
       * **故意不写 `roles`**：补货是「谁都要买耗材」的事，不做身份过滤（厂家买原料、
       * 经销商店里也进货）。少一处 roles 就少一处「五身份可见集合各不相同」的门禁摩擦，
       * 而 A1/A1b/A1c 的期望值本就是按 roles 过滤后的动态集合。
       *
       * ⚠️ 顺序改动必须同步 `scripts/smoke/unit-role-diff-ui.mjs` 的 `BOSS_ORDER`
       * （`replenish` 从第 4 位挪到**末位**）与 `A1C` 断言名里的「末=direction」→「末=replenish」，
       * 否则 A1c 先红、A1 再逐位报错。
       */
      { key: 'replenish', icon: '📦', label: 'AI 补货', desc: '常买清单 / 比价补货 / 到货提醒' },
    ],
  },
];

/**
 * 隐藏模块 → 归属的一级导航。
 * 跨模块跳转（如经营诊断「去发文」→ media）落到未在导航里的模块时，
 * 侧边栏仍能高亮到最近的父入口，用户知道自己在哪。
 */
const ACTIVE_ALIAS = {
  // 【2026-10-19 第十九轮】「首页」入口已删：老存档里的 `home` 一律高亮到「豆芽助手」，
  // 不会再出现「侧栏一个都不亮」的迷路感。
  home: 'workbench',
  media: 'newmedia',
  xinmeiti: 'newmedia',
  // GEO / 竞品对比的**唯一展示出口**已归并到「经营诊断」（老板反馈 #7：
  // 「经营诊断里面放 竞品对比 GEO SEO曝光对比，别的地方不要放了」）。
  // geo 原先折叠到 newmedia（旧的新媒体 GEO 诊断），那一处展示已下线 →
  // 必须改折叠到 intel，否则深链跳到经营诊断时侧边栏仍高亮「新媒体中心」，属于误导。
  geo: 'intel',
  competitor: 'intel',
  crisis: 'intel',
  huodong: 'content',
  daily: 'content',
  // 【0.21.21 · 老板 2026-10-21】原来这两行都折叠到 `activity`（「活动与档期」卡）。
  // 那张卡已整块删除 ⇒ 必须改到新家，否则用户在「营销专项」/「项目详情」页会看到
  // **侧栏一个都不亮**（迷路感），而这正是本表存在的意义（见上方注释）。
  // 新家选 `direction`（经营方案）而不是 `workbench`，理由是动线而不是分类：
  // 这两个页面都是「经营方案 → 目标 → 项目」这条链的下一层
  // （GoalPlanPreview 的「开始执行」落 `project`，DirectionModule 里点目标进 `campaign`），
  // 高亮「我现在最该做什么」= 用户能立刻知道自己在哪一层。
  campaign: 'direction',
  project: 'direction',
  // learn 不再折叠到 today —— 它已是独立一级入口（老板反馈 #1）。
  // 保留这一行会让学习中心页侧边栏高亮到「今天做什么」，属于误导。
  brain: 'profile',
  asset: 'profile',
};

/**
 * 按身份配置的 moduleOrder 重排导航（**配置驱动**，不在组件里写 5 个 if）。
 *
 * 【2026-10 老板批准：五种身份界面差异化】此前 MODULE_GROUPS 是硬编码常量，
 * companyType 这个 prop 传进来了却**从头到尾没被引用** ⇒ 五个身份的导航一模一样。
 * 现由 companyTypeConfig.COMPANY_TYPE_CONFIG[*].moduleOrder 驱动顺序差异。
 *
 * 规则（硬约束：**一个 data-module 锚点都不能少**，只调序、不增删）：
 *   1. 只重排、不新增 / 不删除任何模块或分组；
 *   2. 命中 moduleOrder 的模块排前（按 moduleOrder 顺序），未命中的保持原相对顺序追加（稳定排序）；
 *   3. 分组顺序按「组内最靠前的命中模块」排序；standalone 组（豆芽对话）恒定置顶（独立的小岛）；
 *   4. moduleOrder 缺失 / 为空 / 全不命中 ⇒ 原样返回（安全兜底，保持原顺序）。
 *
 * @param {Array} groups 原始分组（MODULE_GROUPS）
 * @param {string[]} moduleOrder 该身份的一级模块优先顺序（可为空 / 未配）
 * @returns {Array} 重排后的分组（结构与 key 不变，仅顺序变）
 */
export function orderModuleGroups(groups, moduleOrder) {
  const src = Array.isArray(groups) ? groups : [];
  if (!Array.isArray(moduleOrder) || moduleOrder.length === 0) return src;
  const rank = new Map();
  moduleOrder.forEach((k, i) => {
    if (typeof k === 'string' && !rank.has(k)) rank.set(k, i);
  });
  if (rank.size === 0) return src;
  const rankOf = (key) => (rank.has(key) ? rank.get(key) : Number.MAX_SAFE_INTEGER);

  // ① 组内模块按 rank 稳定排序，并记录该组的「最小命中 rank」作为组排序依据
  const prepared = src.map((g) => {
    const mods = Array.isArray(g.modules) ? g.modules : [];
    const withRank = mods.map((m, i) => ({ m, i, r: rankOf(m.key) }));
    withRank.sort((a, b) => a.r - b.r || a.i - b.i);
    const ordered = withRank.map((x) => x.m);
    const rank = withRank.length ? withRank[0].r : Number.MAX_SAFE_INTEGER;
    return { group: g, ordered, rank };
  });

  // ② standalone 组置顶（保持其相对顺序）；其余组按组 rank 稳定排序
  const standalone = prepared
    .filter((x) => x.group.standalone)
    .map((x) => Object.assign({}, x.group, { modules: x.ordered }));
  const rest = prepared
    .filter((x) => !x.group.standalone)
    .map((x, i) => ({ x, i }))
    .sort((a, b) => a.x.rank - b.x.rank || a.i - b.i)
    .map((y) => Object.assign({}, y.x.group, { modules: y.x.ordered }));

  return standalone.concat(rest);
}

/**
 * 红点文案归一（S7 口径，与 `replenishModel.formatDot` 同语义）：
 *   `<= 0` / 非数字 ⇒ `''`（**不渲染**，绝不用 0 占位）；`> 99` ⇒ `'99+'`。
 *
 * 为什么这里自己实现一份而不 import `replenishModel`：
 *   S8 规定「组件之间不互相 import」，`ModuleNav` 是纯展示组件，不该依赖业务模型；
 *   这 4 行是纯格式换算，逻辑收敛在同一个判据上，不构成第二套真源
 *   （真源是「数从哪来」＝`App.jsx`，不是「怎么显示」）。
 *
 * @param {*} n 红点数字（缺省视为 0）
 * @returns {string} 可渲染文本，空串表示不渲染
 */
function dotText(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return v > 99 ? '99+' : String(Math.floor(v));
}

/**
 * 左侧一级导航。
 *
 * @param {object} props
 * @param {string} props.activeModule 当前模块 key
 * @param {(key:string)=>void} props.onSelect 点击回调
 * @param {string} props.companyType 身份（'manufacturer' | 'dealer' | 'clinic' | 'doctor' | 'platform'）
 * @param {Object<string, number>} [props.navDots] 各级入口的红点数（**受控 prop**，由 App.jsx 计算）
 *   `{ activity: 3, replenish: 1 }`；缺失 / 0 的 key 不渲染红点。
 *   红点是**唯一真源在 App.jsx**（S8）：本组件只负责显示，不自己算、不自己读 localStorage。
 */
export default function ModuleNav({ activeModule, onSelect, companyType, navDots }) {
  const activeKey = ACTIVE_ALIAS[activeModule] || activeModule;
  const dots = navDots && typeof navDots === 'object' ? navDots : {};
  // ① 身份过滤：分组声明了 roles 就只对该身份可见（老板 2026-10-14「侧栏按身份变」）。
  //    门店运营只给 clinic / doctor —— 厂家与平台做的是内容/媒体/活动这套，
  //    门店库存、周边 3 公里竞品、电子病历对它们没有意义，硬塞只是噪音。
  //    未声明 roles 的分组对所有身份可见（保持原有行为）。
  const roleGroups = MODULE_GROUPS.filter(
    (g) => !Array.isArray(g.roles) || g.roles.length === 0 || g.roles.includes(companyType)
  );
  // 按身份调序：公司类型 → moduleOrder（未配身份 getTypeConfig 兜底 manufacturer → 结构不变）
  const groups = orderModuleGroups(roleGroups, getTypeConfig(companyType).moduleOrder);
  return (
    <div className="module-nav">
      {groups.map((g) => (
        <div
          className={'module-nav-block' + (g.standalone ? ' standalone' : '')}
          key={g.key}
        >
          {/* 2026-10-14：老板定稿「不设分组标题」。label 为空时不渲染该行，
              否则扁平结构里会多出 9 个空标题行，侧栏反而更长。 */}
          {g.label ? <div className="module-nav-group">{g.label}</div> : null}
          {g.modules.map((m) => {
            const dot = dotText(dots[m.key]);
            return (
              <button
                type="button"
                key={m.key}
                data-module={m.key}
                className={'module-card' + (activeKey === m.key ? ' active' : '')}
                onClick={() => onSelect(m.key)}
              >
                <span className="module-card-icon">{m.icon}</span>
                <span className="module-card-text">
                  <span className="module-card-label">{m.label}</span>
                  {/* 【0.21.10 老板第 2 条】副标题删掉，只保留主标题。
                      老板原话：「左边区域的副标题删掉 只保留主标题即可」。
                      ⚠️ 上面每个模块的 desc 字段**保留不删** —— 它们是回滚资产，
                         也是「这个模块是干什么的」的唯一书面定义，删了以后想恢复要重写文案。 */}
                </span>
                {/* 【0.21.14 · 红点】S1/S7 口径：0 不渲染、>99 显示 99+。
                    锚点 `data-nav-dot="<moduleKey>"` 供门禁按锚点断言，不靠 class 或文本。
                    `data-nav-dot-value` 放原始数字，验收可以核「3 条未读」而不是只看到有红点。 */}
                {dot ? (
                  <span className="module-card-dot" data-nav-dot={m.key} data-nav-dot-value={Number(dots[m.key])}>
                    {dot}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
