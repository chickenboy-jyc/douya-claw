import React from 'react';
import '../styles/ia-today.css';

/**
 * DouyaUsageGuide —— 「豆芽 AI 怎么用」使用说明（豆芽对话欢迎区）。
 *
 * 老板第 9 条定调（原话）：
 *   「经营对话里面为什么还是有三个今天做什么里面的按钮，点了就是跳转到别的地方？
 *     那我要这个对话干嘛？？这个对话就是告诉他们豆芽 AI 这个怎么用的。」
 *   → 因此本组件**刻意不含任何「点了就跳去别的板块」的功能入口卡**，
 *     只讲三件事：① 能问什么  ② 怎么让它干活  ③ 结果落在哪。
 *   （注：老板口语里的某个词是产品界面红线，用户可见处 0 出现，见 §8 命名约定。）
 *
 * 契约（包 D → team-lead，见 IA 定稿 §4.5 契约 1）：
 *   export default function DouyaUsageGuide({ onSelectModule, onPickSample })
 *   team-lead 在 App.jsx 用它替换 <DouyaLauncher />。
 *
 * `onSelectModule` 仅为**保持调用签名兼容**而保留（App.jsx 会传入 setActiveModule），
 * 本组件不据此渲染任何跳转入口 —— 这正是它存在的意义（对话页只讲怎么用）。
 *
 * ★ 2026-10-11 新增可选 `onPickSample`：把示例句从「只能看」变成「点一下就发」。
 *   起因（老板原话）：「这个软件给笨蛋用的，很笨很笨的，根本懒得看一些内容」——
 *   对这类人，「把示例句自己敲一遍」是有成本的，「点一下」没有；示例句本来就是给他们照抄的。
 *   ⚠️ 三条边界，改这个组件必须守住：
 *     1. 点了**不跳走**：只是在当前对话里发一句话，不离开本页 —— 仍符合老板第 9 条。
 *     2. 只有传了回调才渲染成按钮；**不传 = 完全退回原纯展示**（文案逐字节不变）。
 *        使用指南弹窗（App.jsx 常驻入口）走的就是不传那一路，观感与行为零变化。
 *     3. 未连上 AI / 正在生成时，App.jsx 也**不传** ⇒ 不出现「点了没反应」的死交互。
 *
 * @param {{ onSelectModule?: (moduleKey: string) => void, onPickSample?: (text: string) => void }} props
 * @returns {JSX.Element}
 */
export default function DouyaUsageGuide({ onSelectModule, onPickSample }) {
  // 保留签名兼容：明确「本组件不使用 onSelectModule 渲染跳转」，
  // 避免后续维护者误以为漏用了它而补上跳转卡（那就退回老板第 9 条的老毛病了）。
  void onSelectModule;

  // 可点模式：仅当调用方真给了回调。否则整块渲染与新增前等价。
  const canPick = typeof onPickSample === 'function';

  /** 「能问什么」四类典型诉求。`samples` = **可直接发送的原句**（不带引号）；
   *  展示时由「」包裹，可点模式下每句渲染成按钮。 */
  const CAN_ASK = [
    { icon: '🧭', title: '问经营问题', samples: ['这个月我该重点推什么？', '竞品为什么比我更出名？'] },
    { icon: '✍️', title: '让它出内容', samples: ['写一条春季种植体的朋友圈文案', '拟 5 个短视频选题'] },
    { icon: '📋', title: '让它排计划', samples: ['给我排一套 30 天的新品推广节奏', '把这次展会拆成待办'] },
    { icon: '🔧', title: '让它动文件 / 代码', samples: ['读一下这份文档再帮我总结', '改一下这个小程序页面的按钮'] },
  ];

  return (
    <div className="douya-usage">
      <div className="douya-usage-head">
        <div className="douya-usage-title">豆芽 AI 怎么用</div>
        <div className="douya-usage-sub">
          你负责拍板，豆芽负责把话变成事。不用去别的板块点来点去，在这里直接说一句话就行。
        </div>
      </div>

      {/* ① 三步上手 */}
      <ol className="douya-usage-steps">
        <li className="douya-usage-step">
          <span className="douya-usage-idx">1</span>
          <div className="douya-usage-body">
            <div className="douya-usage-t">把你要做的事说一句话</div>
            <div className="douya-usage-d">直接在下面输入框打字，或点 🎤 用语音。说完按发送，豆芽就开始干。</div>
          </div>
        </li>
        <li className="douya-usage-step">
          <span className="douya-usage-idx">2</span>
          <div className="douya-usage-body">
            <div className="douya-usage-t">说清三件事，豆芽就不会瞎猜</div>
            <div className="douya-usage-d">① 要做什么（动词 + 对象，如「写文案」而不是「优化一下」）</div>
            <div className="douya-usage-d">② 给谁看 / 图什么（人群、平台、目标）</div>
            <div className="douya-usage-d">③ 想要的产出长什么样（朋友圈一段话？一份对比表？）</div>
          </div>
        </li>
        <li className="douya-usage-step">
          <span className="douya-usage-idx">3</span>
          <div className="douya-usage-body">
            <div className="douya-usage-t">结果就地给你，不满意接着说</div>
            <div className="douya-usage-d">豆芽会直接把能用的稿子 / 清单 / 计划写出来。哪儿不对，直接说「再口语一点」「换个平台口吻」，它接着改。</div>
          </div>
        </li>
      </ol>

      {/* ② 能问什么 */}
      <div className="douya-usage-canask">
        <div className="douya-usage-sec-t">你可以这样使唤它</div>
        {/* 只有可点模式才出这一行；不点也能看，点了就直接发出去（不跳走）。 */}
        {canPick && (
          <div className="douya-usage-tap-hint">下面每句话都能点，点一下豆芽就开始干。</div>
        )}
        <div className="douya-usage-chips">
          {CAN_ASK.map((c) => (
            <div className="douya-usage-chip" key={c.title}>
              <span className="douya-usage-chip-ic">{c.icon}</span>
              <div className="douya-usage-chip-body">
                <div className="douya-usage-chip-t">{c.title}</div>
                {canPick ? (
                  <div className="douya-usage-chip-s douya-usage-picks">
                    {c.samples.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="douya-usage-pick"
                        onClick={() => onPickSample(s)}
                        title={'点一下就让豆芽做：' + s}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="douya-usage-chip-s">
                    {c.samples.map((s) => '「' + s + '」').join('')}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ③ 结果落在哪 */}
      <div className="douya-usage-where">
        <div className="douya-usage-where-item">
          <span className="douya-usage-where-ic">📦</span>
          <span className="douya-usage-where-tx">
            本次成果都留在右侧「📦 历史」里，随时能翻回来复制，不会丢。
          </span>
        </div>
        <div className="douya-usage-where-item">
          <span className="douya-usage-where-ic">🧠</span>
          <span className="douya-usage-where-tx">
            豆芽记住的东西会沉淀进「你的企业资产库」——档案越全，它答得越像你，越不用重复解释。
          </span>
        </div>
      </div>

      {/* ④ 遇到问题怎么办（老板：这句话就写进教程里，不做单独功能）。
          下面两个地址都符合「代码依据 + 磁盘核实」双证据，不是推断：
          · main.js:625 startBackend({ dataDir: app.getPath('userData') })；backend.js:474/506
            把 config.json 写在 dataDir，backend.js:1619/1620 写 deliverables.json / token-usage.json，
            main.js:374 写 sessions.json → Windows 下即 %APPDATA%\douya-claw\
            （磁盘核实：该目录内确有 config.json / sessions.json / deliverables.json / token-usage.json）
          · main.js:432 AGENT_WORKSPACE = os.homedir()/douya-claw-workspace
            （磁盘核实：%USERPROFILE%\douya-claw-workspace 存在，内含历年产出的 docx/pptx/html）
          措辞保持与上下文无关，对话页欢迎区与标题栏弹窗两处都读得通。
          刻意不写日志目录：磁盘无 logs 文件夹、代码无 app.getPath('logs')。 */}
      <div className="douya-usage-help">
        <div className="douya-usage-sec-t">遇到问题怎么办</div>
        <div className="douya-usage-help-d">
          用着不对劲、或想加个新东西，把下面这些本机文件 / 数据的地址发给开发者，就能直接在本地帮你改，不用你来回复述。
        </div>
        <div className="douya-usage-help-list">
          <div className="douya-usage-help-item">
            <span className="douya-usage-help-k">数据与配置文件夹</span>
            <code className="douya-usage-help-v">%APPDATA%\douya-claw</code>
            <span className="douya-usage-help-n">
              config 设置 · sessions 对话 · deliverables 成果 · token-usage 用量
            </span>
          </div>
          <div className="douya-usage-help-item">
            <span className="douya-usage-help-k">生成的成果文件</span>
            <code className="douya-usage-help-v">%USERPROFILE%\douya-claw-workspace</code>
            <span className="douya-usage-help-n">豆芽写出的文稿 / 表格 / 网页都保存在这里</span>
          </div>
        </div>
        <div className="douya-usage-help-tip">
          在文件资源管理器地址栏粘贴上面这段，回车即可打开对应文件夹。
        </div>
      </div>

      <div className="douya-usage-foot">
        豆芽给的是建议，拍板的是你。涉及疗效、数据、案例的说法，它会标出来让你核 —— 编造的它不写。
      </div>
    </div>
  );
}
