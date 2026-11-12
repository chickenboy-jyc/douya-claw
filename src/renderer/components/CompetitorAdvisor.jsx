/**
 * CompetitorAdvisor —— 「就这份竞品对比问豆芽」的对话面板。
 *
 * 老板原话（2026-10-20 第 2 条）：
 *   「也没有可以问的地方，这里要加一个对话框，这个对话框可以自动看上面分析的内容…
 *     相当于你点一下分析然后 AI 会给你一些分析的数据，然后这个 prompt 会读取上面的数据
 *     并且给到你想问的答案内容。点一次就会一直保存着 可以折叠掉，
 *     相当于让用户看着那些竞品的分析 问问题，除非他再点一次，所以主视觉还是对话。」
 *
 * 三个设计决定（改之前先读，都是一次踩过才知道的）：
 *
 * ① **它必须能读到上面那份对比**，否则回答就成了行业常识问答（老板要的是"读上面的数据"）。
 *    注入靠 `data/competitorAdvisorPrompt.js::buildAdvisorMessages(view, meta, history, q)`，
 *    本组件只负责把 view/meta 递进去 —— prompt 正文是老板逐字写的，不在这一层改。
 *
 * ② **展开状态按企业写 localStorage**（`douya-comp-advisor-open:<companyId>`）。
 *    老板要"点一次就一直在"，但 A 企业展开着不代表切到 B 企业也该展开着，
 *    所以 key 必须带 companyId，而不是一个全局开关。
 *
 * ③ 对话历史**只活在组件 state**（不落库、不进 job.result）。原因：
 *    历史一旦持久化，就会出现"读到上一家公司/上一轮对比的对话"这种无法解释的状态，
 *    而清空条件（换企业 / 重新生成）又只能靠猜。宁可刷新后从零开始问。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input } from 'antd';
import Markdown from './Markdown.jsx';
import { chatOnce } from '../api.js';
import { buildAdvisorMessages } from '../data/competitorAdvisorPrompt.js';

/** 展开状态持久化 key 前缀；后缀是企业 id（见文件头 ②）。 */
const OPEN_KEY_PREFIX = 'douya-comp-advisor-open:';

/** chatOnce 返回 ok:false 但没带 error 时的兜底文案 —— 失败必须有话说，不许静默。 */
const FALLBACK_ERROR = '豆芽没有返回内容，请检查「设置」里的模型连接后重试';

/** 输入上限：对话是"问一句答一句"，不是写报告，超长只会把上下文预算吃掉。 */
const MAX_QUESTION = 500;

/**
 * @param {object} props
 * @param {object} props.view 结构化对比结果（parse/normalize 之后那份，和矩阵同源）
 * @param {string} [props.companyId] 企业 id（开合状态按企业隔离）
 * @param {string} [props.resetKey] 变化即清空历史（换企业 / 重新生成）
 * @param {object} props.meta { companyName, competitors, dims:[{key,label}], webLanded }
 * @param {() => object} props.buildContext 返回 buildAIContext 的产物；**故意传函数**：
 *        它只在用户真的提问时执行，构建失败会落到下面的 try/catch 变成一条错误气泡，
 *        而在渲染期算的话，一次异常就是整页白屏（CompetitorAnalysis 历史上栽过）。
 * @param {boolean} [props.compact=false] 内嵌在经营诊断里时的紧凑形态
 */
export default function CompetitorAdvisor({
  view,
  companyId = '',
  resetKey = '',
  meta,
  buildContext,
  compact = false,
}) {
  const openKey = OPEN_KEY_PREFIX + (companyId || 'no-company');

  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(openKey) === '1'; } catch { return false; }
  });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const listRef = useRef(null);
  const idRef = useRef(0);
  // 「这一轮回答还属于当前会话吗」的令牌：换企业 / 重新生成时 +1，
  // 迟到的旧回答回来对不上令牌就丢弃 —— 否则会往新会话里塞上一轮的答案。
  const turnRef = useRef(0);

  // 切企业时把开合状态换成该企业自己记住的那个值（老板要"一直在"，但不是跨企业串台）。
  useEffect(() => {
    try { setOpen(localStorage.getItem(openKey) === '1'); } catch { setOpen(false); }
  }, [openKey]);

  // 换企业 / 重新生成对比 ⇒ 上一轮的对话上下文已经不成立，必须清空。
  const prevResetRef = useRef(resetKey);
  useEffect(() => {
    if (prevResetRef.current === resetKey) return;
    prevResetRef.current = resetKey;
    turnRef.current += 1;
    setMessages([]);
    setInput('');
    setSending(false);
  }, [resetKey]);

  // 新消息进来就滚到底：老板要的"主视觉是对话"，回答必须自己跟上来。
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, messages, sending]);

  const competitors = useMemo(
    () => (meta && Array.isArray(meta.competitors) ? meta.competitors : []),
    [meta],
  );

  /**
   * 空态的示例问题：**点一下只填入输入框、不自动发送** ——
   * 自动发会让用户以为自己问过了，而实际问的是我们写的句子。
   * 第二条要拿真实竞品名（问"客户为什么选 X 不选我们"才具体），没有竞品就不出现。
   */
  const examples = useMemo(() => {
    const list = ['我们最该补的短板是哪个'];
    if (competitors.length) list.push('客户为什么会选 ' + competitors[0] + ' 不选我们');
    list.push('下个月先做哪件事性价比最高');
    return list;
  }, [competitors]);

  function toggleOpen() {
    // 先算、再落盘、最后 setState：把副作用留在 updater 外面（updater 在并发模式下会被重放，
    // 里面写 localStorage 等于把"几次写"交给 React 的调度决定）。
    const next = !open;
    try { localStorage.setItem(openKey, next ? '1' : '0'); } catch { /* 写失败只是记不住，不影响本次展开 */ }
    setOpen(next);
  }

  /** 已经发生过的问答（错误气泡不重发给模型：它会把"连不上"当成对话内容继续编）。 */
  function historyForModel() {
    return messages
      .filter((m) => !m.failed && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  function pushMessage(msg) {
    idRef.current += 1;
    // ⚠️ id 必须在这里**先取出来**，不能写在 setMessages 的 updater 里：
    //    updater 是延迟执行的，同一批里连着 push 两条（用户气泡 + 紧随其后的错误气泡）时，
    //    两个 updater 都会读到已经自增过的同一个 ref 值 ⇒ 两条消息拿到同一个 key
    //    ⇒ React 报 "two children with the same key" 并可能复用错 DOM 节点。
    //    （这是本轮 jsdom 实测抓到的，不是理论风险。）
    const id = 'comp-advisor-' + idRef.current;
    setMessages((prev) => [...prev, { ...msg, id }]);
  }

  async function send() {
    const q = String(input || '').trim();
    if (!q || sending) return;
    const myTurn = turnRef.current;
    const history = historyForModel();
    setInput('');
    setSending(true);
    pushMessage({ role: 'user', content: q });
    try {
      const msgs = buildAdvisorMessages(view, meta || {}, history, q);
      const r = await chatOnce(msgs, buildContext ? buildContext() : {}, { temperature: 0.4 });
      if (myTurn !== turnRef.current) return;
      if (r && r.ok === true && String(r.content || '').trim()) {
        pushMessage({ role: 'assistant', content: String(r.content) });
      } else {
        pushMessage({ role: 'assistant', failed: true, content: '⚠️ ' + ((r && r.error) || FALLBACK_ERROR) });
      }
    } catch (e) {
      if (myTurn !== turnRef.current) return;
      // 失败必须看得见：静默消失 = 用户以为豆芽没听见，会一直重问。
      pushMessage({ role: 'assistant', failed: true, content: '⚠️ ' + ((e && e.message) || FALLBACK_ERROR) });
    } finally {
      if (myTurn === turnRef.current) setSending(false);
    }
  }

  /**
   * 回车发送 / Shift+Enter 换行。
   * 挂到 TextArea 时用**内联箭头**（`onPressEnter={(e) => sendByKey(e)}`）：
   * `scan-handler-arity` 把 `onPressEnter={具名函数}` 且该函数带必填参数判成缺陷
   * （它挡的是"把合成事件误当业务参数"那类真 bug）。本处确实要读 shiftKey，
   * 所以按 App.jsx:3468 的既有写法内联，而不是给判据开豁免。
   */
  function sendByKey(e) {
    if (e && e.shiftKey) return; // Shift+Enter 换行（默认行为，不拦）
    if (e && e.preventDefault) e.preventDefault();
    send();
  }

  return (
    <div
      className={compact ? 'comp-advisor comp-advisor-compact' : 'comp-advisor'}
      data-comp-advisor={open ? 'open' : 'closed'}
    >
      {/* 【0.21.19 · 老板第 3 条】「就这个对比问豆芽 按钮也太小了 大一些明显一些」。
          原来这行是 `size="small"`（24px 高）+ `ghost`（透明底 + 绿字绿边）+
          `justify-content: flex-end`（贴在本块最右边），三个因素叠加起来，
          它在结论区下面看起来就像一句附属说明，而不像一个"可以点进去问"的入口。
          现在改成：
            · `size="large"`（antd 大号：40px 高）**再**由 `.comp-advisor-toggle-btn`
              抬到 min-height 46px / 16px 字 / 700 字重 —— 比本页主按钮「分析」更大；
            · 去掉 `ghost` ⇒ 走实心 primary（本项目 = `#30d158` 绿底白字，见 style.css:1041），
              **不引入蓝/黑**，与全站绿色主色一致；
            · 两种状态都是实心绿：收起时是"进对话"的入口，展开时是"收起对话"，
              同一个按钮位置不变（老板要的是"点一次一直在，可以折叠掉"）。
          ⚠️ 三条不许动的：文案逐字不变；`data-comp-advisor-toggle="1"` 锚点保留
          （scripts/smoke/entry-interact.jsx:1943/2204 靠它点击开合）；
          `onClick={toggleOpen}` 与按企业记 localStorage 的行为一行未改。 */}
      <div className="comp-advisor-toggle">
        <Button
          size="large"
          type="primary"
          className="comp-advisor-toggle-btn"
          data-comp-advisor-toggle="1"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          {open ? '收起对话' : '💬 就这份对比问豆芽'}
        </Button>
      </div>

      {open ? (
        <div className="comp-advisor-panel" data-comp-advisor-panel="1">
          <div className="comp-advisor-hint">豆芽只能看到上面这份对比的数据；数据里没有的它会直说</div>

          <div className="comp-advisor-msgs" ref={listRef} data-comp-advisor-msgs="1">
            {messages.length === 0 ? (
              <div className="comp-advisor-empty">
                <div className="comp-advisor-empty-t">挑一个问，或自己写：</div>
                <div className="comp-advisor-ex">
                  {examples.map((q) => (
                    <Button
                      key={q}
                      size="small"
                      className="comp-advisor-ex-btn"
                      onClick={() => setInput(q)}
                    >
                      {q}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    'comp-advisor-msg '
                    + (m.role === 'user' ? 'comp-advisor-msg-user' : 'comp-advisor-msg-ai')
                    + (m.failed ? ' comp-advisor-msg-err' : '')
                  }
                >
                  {m.role === 'assistant' && !m.failed
                    ? <Markdown>{m.content}</Markdown>
                    : <span className="comp-advisor-msg-text">{m.content}</span>}
                </div>
              ))
            )}
            {sending ? <div className="comp-advisor-loading">豆芽正在读这份对比…</div> : null}
          </div>

          <div className="comp-advisor-foot">
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => sendByKey(e)}
              placeholder="问点具体的，比如「我们价格带比它们高还是低」"
              autoSize={{ minRows: 1, maxRows: 4 }}
              maxLength={MAX_QUESTION}
              disabled={sending}
            />
            <Button
              type="primary"
              className="comp-advisor-send"
              loading={sending}
              disabled={sending || !String(input || '').trim()}
              onClick={send}
            >
              发送
            </Button>
          </div>
          <div className="comp-advisor-tip">Enter 发送 · Shift+Enter 换行</div>
        </div>
      ) : null}
    </div>
  );
}
