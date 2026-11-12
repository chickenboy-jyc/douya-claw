/**
 * ReviewGroup —— 「豆芽自查 / 复检」多轮结果的**折叠汇总条**（2026-11-03）。
 *
 * 【为什么要有这个组件】
 *   老板原话：「中间豆芽怎么想怎么复查 根本不重要建议折叠掉，用户看的信息始终排在最新」。
 *   改前：每一轮 `selfcheck` 事件都落一条 `role='review'` 消息，各自平铺渲染成一张
 *   `.review-card`（`missing` 列表全量展开）。一次任务的对话物理顺序是
 *   `[用户] → [豆芽正文] → [自查×4] → [复检×1]` —— **用户滚到底看到的是最后一张自查卡，
 *   而不是结论**。同一份文件里工具历史早就有 `<details>` 折叠（`App.jsx` 的 ToolGroup），
 *   自查卡却是全展开的，同一界面两种待遇。
 *   改后：连续 review 消息由 `App.jsx` 的 `groupToolCalls` 聚合成一组，这里渲染成
 *   **一条默认收起的 `<details>`**：summary 一行说清结果（几轮 / 还差几项 / 复检有无意见），
 *   明细要点开才看。用户滚到底看到的是结论块，不是第 4 张自查卡。
 *
 * 【为什么单独成组件（不是为了好看，是为了能被断言）】
 *   与 `ToolRunningChip.jsx` 同一个理由：内联在 `App.jsx`（4800+ 行、依赖整棵树）里时，
 *   jsdom / SSR 都挂不起来 ⇒「是不是真的渲染成了 `<details>`」「summary 里的轮数对不对」
 *   永远只能靠人眼。抽出来后 `scripts/smoke/unit-chat-verdict.mjs` 能直接渲染断言。
 *
 * ⚠️ 三条不能碰的红线：
 *   ① **绝不用 `<button>`**：`unit-firstscreen.mjs` 按 `querySelectorAll('button').length`
 *      做首屏按钮棘轮，新增按钮会红。折叠用原生 `<details>/<summary>`。
 *   ② 每一轮明细节点必须保留 `data-review-phase={phase}`：既有排查脚本与新测试都按它定位。
 *   ③ 根节点必须带 `data-review-group="1"` 与 `data-review-rounds={轮数}`。
 *   ④ **`missing` 的元素一律过 `reviewMissingText()` 再插出去**，绝不许 `{x}` 直插。
 *      后端两条 phase 的元素类型不一致（字符串 / `{id,outcome,why,gaps}` 对象），
 *      直插对象 ⇒ React error #31 ⇒ renderer 整棵挂掉 ⇒ 重开应用首屏白屏（2026-11-03 事故）。
 */
import React from 'react';
import LineIcon from './LineIcon.jsx';

/**
 * 汇总条上那一行话（纯函数，便于阅读与将来单测）。
 *
 * 只有 continue 轮次：`复查 3 轮 · 还差 2 项`（取**最后一轮**的 missing 数；0 项写「已补齐」）。
 * 有 audit：末尾追加 ` · 复检通过` / ` · 复检有意见`。
 * 一轮都没有：`复查`。
 * 逐轮罗列不是 summary 的职责 —— 那是展开后的明细。
 *
 * @param {Array<Object>} rounds role='review' 的消息数组（按时间顺序）
 * @returns {string}
 */
export function reviewSummaryText(rounds) {
  const list = Array.isArray(rounds) ? rounds.filter(Boolean) : [];
  const cont = list.filter((r) => r.phase !== 'audit');
  const audits = list.filter((r) => r.phase === 'audit');

  let text = '复查';
  if (cont.length > 0) {
    const last = cont[cont.length - 1];
    const missing = Array.isArray(last.missing) ? last.missing.length : 0;
    text = '复查 ' + cont.length + ' 轮 · ' + (missing > 0 ? '还差 ' + missing + ' 项' : '已补齐');
  }
  if (audits.length > 0) {
    const la = audits[audits.length - 1];
    text += la.pass ? ' · 复检通过' : ' · 复检有意见';
  }
  return text;
}

/** outcome 的中文说法。用户看不懂 `unverified` 这种内部状态码。 */
const OUTCOME_CN = { fail: '未通过', unverified: '未验证' };

/**
 * 把一个值安全地当成「一段人话」——拿不到有意义文字时返回空串，由调用方兜底。
 *
 * 刻意只放行 string / number / bigint：`{}`、`[]`、`true` 这些一旦被 `String()`，
 * 产物就是 `[object Object]` 这类噪音，宁可不显示也不要印出来。
 *
 * @param {*} v 任意值
 * @returns {string} 可读文字；空白字符串、对象、数组、布尔、Symbol 一律返回 ''
 */
function reviewSafeText(v) {
  if (typeof v === 'string') return v.trim() ? v : '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  return '';
}

/**
 * 把 `missing` 数组里的**一个元素**变成一段用户能读懂的文字（纯函数，无 React 依赖）。
 *
 * 【为什么必须有这个函数 —— 2026-11-03 崩溃事故】
 *   后端两条 phase 发的 `missing` **元素类型不一致**：
 *     · `phase:'continue'`（`agentReview.js`）⇒ **字符串数组**，如 `'补跑一次构建确认没报错'`；
 *     · `phase:'runtime-continue'`（`backend.js` 的 objectiveGaps）⇒ **对象数组**，
 *       形状 `{id, outcome, why, gaps}`。
 *   而渲染层原来直接 `{x}` 插给 React ⇒ 遇到对象时 React 抛
 *   `Minified React error #31: object with keys {id, outcome, why, gaps}` ⇒ **整个 renderer 挂掉**。
 *   review 消息会持久化进会话存档，所以重开应用首屏重放旧消息 ⇒ **一打开就白屏**（不是跑到那步才崩）。
 *
 *   修在渲染层而不是改后端数据形状，理由是：① `gaps` 是有用信息，改成字符串就丢了；
 *   ② 用户机器上已经躺着一批坏存档，渲染期归一是「存量自愈」，不依赖存档迁移。
 *
 * 归一规则：
 *   · string / number ⇒ 原样字符串化（老 `phase:'continue'` 路径逐字不变）
 *   · 对象 ⇒ `未验证 · 页面只返回 200`：outcome 中文映射 + ` · ` + 主体（主体取 why，
 *     空则取 id，再空则取 `未核对 N 项` / `（原因未说明）`）；outcome 缺失时只输出主体
 *   · 其它（null / undefined / 数组 / 布尔 / Symbol）⇒ `（空）`
 *
 * **绝不返回对象，绝不把 `gaps` 整个插出去** —— 这条是本次事故的唯一硬红线。
 *
 * @param {*} x `missing` 数组里的单个元素
 * @returns {string} 一定是字符串
 */
export function reviewMissingText(x) {
  const t = typeof x;
  // 老路径（phase:'continue' 的字符串数组）必须逐字不变，连首尾空格也不动。
  if (t === 'string') return x;
  if (t === 'number' || t === 'bigint') return String(x);

  if (t === 'object' && x !== null && !Array.isArray(x)) {
    const outcome = reviewSafeText(x.outcome).trim();
    const head = outcome ? (OUTCOME_CN[outcome] || outcome) : '';
    let subject = reviewSafeText(x.why) || reviewSafeText(x.id);
    if (!subject) {
      // why/id 都没有时，至少把「未核对几项」这个事实说出来，但不把 gaps 内容铺开。
      const gaps = Array.isArray(x.gaps) ? x.gaps.length : 0;
      subject = gaps > 0 ? '未核对 ' + gaps + ' 项' : '（原因未说明）';
    }
    return head ? head + ' · ' + subject : subject;
  }

  return '（空）';
}

/**
 * @param {Object} props
 * @param {Array<Object>} props.rounds 连续的 role='review' 消息（每轮：{phase, round, missing, pass, summary}）
 * @returns {JSX.Element}
 */
export default function ReviewGroup({ rounds }) {
  const list = Array.isArray(rounds) ? rounds.filter(Boolean) : [];
  const cont = list.filter((r) => r.phase !== 'audit');
  const audits = list.filter((r) => r.phase === 'audit');
  // 图标沿用旧自查卡的语言：复检 = 对勾，自查 = 放大镜（装饰性，语义由文字承担）
  const iconName = audits.length > 0 && cont.length === 0 ? 'check' : 'search';

  return (
    <div className="msg review" data-review-group="1" data-review-rounds={list.length}>
      <div className="msg-asst-col">
        <details className="review-card review-group">
          <summary className="review-hd">
            <LineIcon name={iconName} size={14} />
            <span className="review-hd-text">{reviewSummaryText(list)}</span>
          </summary>
          <ul className="review-rounds">
            {cont.map((r, k) => {
              const missing = Array.isArray(r.missing) ? r.missing : [];
              return (
                <li className="review-round" key={'c' + k} data-review-phase={r.phase}>
                  <div className="review-round-hd">
                    第 {r.round || (k + 1)} 轮 · {missing.length > 0 ? '还差 ' + missing.length + ' 项' : '已补齐'}
                  </div>
                  {missing.length > 0 && (
                    <ul className="review-round-list">
                      {/* ★ 2026-11-03 崩溃修复：必须过 reviewMissingText 归一。
                          原来这里直接 `{x}`，元素是对象时 React 抛 #31 ⇒ 首屏白屏。
                          改数据糊过去不行（会丢 gaps），所以修在渲染期，老存档也能自愈。 */}
                      {missing.map((x, i) => <li key={i}>{reviewMissingText(x)}</li>)}
                    </ul>
                  )}
                </li>
              );
            })}
            {audits.map((r, k) => (
              <li className="review-round" key={'a' + k} data-review-phase="audit">
                <div className="review-round-hd">
                  {r.pass ? '复检通过' : '复检未通过'}：{r.summary}
                </div>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

/**
 * GateReport —— 「有几步没执行」的折叠条（2026-11-03）。
 *
 * 改前这段是**拼进 assistant 正文**的一段话，标题写死「【无人值守提示】」，
 * 而触发它的是意图闸门拦下工具调用、与 unattended 开关毫无关系 —— 普通聊天里也印；
 * 因为拼在正文流里，前端拿不到边界，既不能折叠也不能去重，循环每轮再追加一次，
 * 用户在一次对话里看到 7 段一模一样的字。
 *
 * 现在：独立事件 → 这条折叠条。一行说清「有 N 步没执行」，点开才看明细。
 *
 * ⚠️ 两条红线：
 *   ① 绝不用 `<button>`（首屏按钮棘轮），折叠用原生 details；
 *   ② `data-gate-report={total}` 是新门禁的定位锚点，别删。
 *
 * 【total 与 blocked 的区别 —— 这里最容易说假话】
 *   total   = 去重后的**条目数**（有几件事没做）
 *   blocked = 被拦**次数**之和（同一件事反复被拦会大于 total）
 *   实测：同一条 ssh 命令被 confirm 闸门连拦 5 次 ⇒ total=1、blocked=5。
 *   若 summary 用 blocked 当「几步没做」，用户会以为有 5 件事没做（假信息）。
 *   所以只有 blocked > total 时才补一句「被拦了 N 次」—— 既不说假话，
 *   也不让「反复被拦」这个事实消失。
 *
 * @param {Object} props
 * @param {number} props.total 有几件事没做（去重后）
 * @param {number} [props.blocked] 一共被拦了几次（可大于 total）
 * @param {Array<Object>} [props.items] [{gate, skill, target, count}]
 * @returns {JSX.Element}
 */
export function GateReport({ total, blocked, items }) {
  const n = Number(total) || 0;
  const list = Array.isArray(items) ? items : [];
  const hit = Number(blocked) || 0;
  return (
    <details className="gate-report" data-gate-report={n} data-gate-blocked={hit}>
      <summary>
        有 {n} 步没执行（需要你在场才能做）{hit > n ? ' · 被拦了 ' + hit + ' 次' : ''}
      </summary>
      <ul className="gate-report-list">
        {list.map((g, k) => (
          <li key={k}>{g.gate}{g.skill ? '：' + g.skill : ''}{g.count > 1 ? ' ×' + g.count : ''}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 把一条 gate_report 消息并进消息列表：**同会话只留一条**（替换最后一条），不追加。
 *
 * 【为什么需要它】后端 emitGateReport 按内容签名去重，但内容**变了**（又拦了新东西、
 * 或同一件事的 count 递增）就会再发一次。若前端老老实实 append，用户在长任务里
 * 会看到好几条「有 N 步没执行」叠在一起 —— 和修前的 7 段重复是同一个病。
 * 闸门清单表达的是「**当前**有哪些事没做」，它是**状态**不是**事件流水**，
 * 所以合并语义是「后来者覆盖」，不是「逐条累加」。
 *
 * 位置：替换**最后一条** gate_report，保持它原来的位置（用户滚到那里看到的是
 * 结束时的最新清单，而不是一份过期的中间态）。
 *
 * @param {Array<Object>} messages 原消息列表
 * @param {Object} next 新的 gate_report 消息 {role:'gate_report', total, blocked, items}
 * @returns {Array<Object>} 新列表（不修改入参）
 */
export function mergeGateReport(messages, next) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'gate_report') {
      list[i] = next;
      return list;
    }
  }
  list.push(next);
  return list;
}

/**
 * PendingActions —— 「这几步等你点头」的折叠条（2026-11-09 新增）。
 *
 * 与 GateReport 的**分工必须保住**，混了就是说假话：
 *   · GateReport      有 N 步**没执行**（系统挡下来了）—— 这是**损失**
 *   · PendingActions  有 N 步**你点头就能做**（已记账，还没动手）—— 这是**待办**
 * 无人值守跑完一轮，用户回来最需要知道的恰恰是后者："我睡觉这段时间，有什么在等我。"
 * 只说前者的话，用户不知道自己是"少做了几件事"还是"有几件事可以做"。
 *
 * 红线与 GateReport 一致：不用 `<button>`（首屏按钮棘轮），折叠用原生 details；
 * `data-pending-actions={n}` 是门禁定位锚点，别删。
 *
 * @param {Object} props
 * @param {number} props.total 有几件事等你点头
 * @param {Array<Object>} [props.items] [{id, summary, tool, reversible}]
 * @returns {JSX.Element}
 */
export function PendingActions({ total, items }) {
  const n = Number(total) || 0;
  const list = Array.isArray(items) ? items : [];
  // 「可回滚」与「不可回滚」必须分开数：混成一句会让用户以为删库也能一键撤回。
  const risky = list.filter((x) => x && x.reversible === false).length;
  return (
    <details className="gate-report pending-actions" data-pending-actions={n} data-pending-risky={risky}>
      <summary>
        有 {n} 步等你点头就能做{risky ? '（其中 ' + risky + ' 步不可回滚）' : ''}
      </summary>
      <ul className="gate-report-list">
        {list.map((x, k) => (
          <li key={(x && x.id) || k}>
            {x && x.summary ? x.summary : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 把一条 pending_actions 并进消息列表：**同会话只留一条**（后来者覆盖）。
 *
 * 为什么不能复用 mergeGateReport：那个函数只找 role==='gate_report'，
 * 传进来 role='pending_actions' 会走到 `list.push` 分支 ⇒ 长任务里叠出好几条
 * 「有 N 步等你点头」，正是当年 gate_report 那 7 段重复的同一个病。
 *
 * @param {Array<Object>} messages 原消息列表
 * @param {Object} next 新的 pending_actions 消息
 * @returns {Array<Object>} 新列表（不修改入参）
 */
export function mergePendingActions(messages, next) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'pending_actions') {
      list[i] = next;
      return list;
    }
  }
  list.push(next);
  return list;
}

/**
 * ChatVerdict —— 对话末尾的**收尾结论块**（2026-11-03）。
 *
 * 老板原话：「最后没完成啥也不知道」「用户看的信息也要简短明了，直接说结论就行了」。
 * 改前终态信息只挂在「最后一组工具」的一枚小芯片上（`TERMINAL_CHIP`），而那组工具
 * 常常在上百行之前 ⇒ 对话滚到底没有任何一句"这事到底做完了没有"。
 *
 * 这里说的是一句人话：只用 COMPLETE/PARTIAL/BLOCKED/BLOCKED_WITH_DIAGNOSIS 四档
 * + 后端给的中文 label 兜底，**绝不出现工具名、英文字段名、内部状态码**。
 *
 * ★ 2026-02-16 加第四档时的两条纪律（都不许省）：
 *   ① `st === 'BLOCKED_WITH_DIAGNOSIS'` 必须排在 `st === 'BLOCKED'` **之前**判断。
 *      这不是"相等判断无所谓"—— 这里是一条 if/else 链，顺序即语义；排在后面就永远进不去
 *      （第四档会被 BLOCKED 那支吃掉，用户看到的是"需要你提供点东西"，而它其实已经定位好了）。
 *   ② 枚举名**不许**流进 DOM 文本：它只出现在 `data-chat-verdict` 属性与 className 里
 *      （`unit-chat-verdict.mjs` 的 D8 断言：正文里不许出现 ≥3 个连续英文字母）。
 *      芯片文案与正文一律中文。
 *
 * @param {Object} props
 * @param {string} [props.state] 后端状态机判决 COMPLETE / PARTIAL / BLOCKED / BLOCKED_WITH_DIAGNOSIS（可能为空）
 * @param {number|null} [props.unresolved] 后端账本口径的未闭环步数（可能为 null）
 * @param {string} [props.label] 后端给的中文终态标签（兜底用）
 * @returns {JSX.Element}
 */
export function ChatVerdict({ state, unresolved, label }) {
  // 第四档与 BLOCKED 的芯片文案**必须不同**：同文案等于在 UI 上把"定位到可复现"抹平成"我不行了"，
  // 而这两件事对用户的含义天差地别（后者要用户去查，前者用户照着跑一遍就行）。
  const TERMINAL_CHIP = {
    COMPLETE: '完成',
    PARTIAL: '未完成',
    BLOCKED: '需你介入',
    BLOCKED_WITH_DIAGNOSIS: '卡住但有诊断',
  };
  const st = String(state || '').toUpperCase();
  let txt = '';
  if (st === 'COMPLETE') {
    txt = '按你的要求做完了';
  } else if (st === 'PARTIAL') {
    const n = (typeof unresolved === 'number' && unresolved > 0) ? unresolved : 0;
    txt = '做了一部分，没全做完' + (n > 0 ? '（' + n + ' 步没成）' : '');
  } else if (st === 'BLOCKED_WITH_DIAGNOSIS') {
    // ⚠️ 必须在 BLOCKED 之前（见上面纪律①）。
    txt = '卡住了，但问题已经定位到能复现 —— 复现步骤和只差什么我写在上面';
  } else if (st === 'BLOCKED') {
    txt = '卡住了，需要你提供点东西才能继续';
  } else {
    txt = label || '结束了';
  }

  return (
    <div className="chat-verdict" data-chat-verdict={state || 'unknown'}>
      <span className={'tg-terminal tg-terminal-' + st.toLowerCase()}>
        {TERMINAL_CHIP[st] || '已结束'}
      </span>
      <span className="chat-verdict-txt">{txt}</span>
    </div>
  );
}
