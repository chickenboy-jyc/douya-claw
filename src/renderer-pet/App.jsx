import React, { useState, useRef, useEffect } from 'react';
import Markdown from './components/Markdown.jsx';
import { buildToolsFrom } from '../shared/toolSchema.js';
// 0.8.0：桌宠形象换成豆芽AI 新素材（透明底 webp）。
// petLogo 用于标题栏/收起态（方形容器），petMascot 用于展开态欢迎页（竖版人物）。
import petLogo from './assets/douya-pet-logo.webp';
import petMascot from './assets/douya-pet-mascot.webp';

const BACKEND = 'http://127.0.0.1:10119';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('agent-settings') || '{}'); } catch { return {}; }
}

function packMessages(messages) {
  return messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content }));
}

export default function App() {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [showThinking, setShowThinking] = useState(() => {
    const v = localStorage.getItem('douya-pet-show-thinking');
    return v === null ? true : v !== '0';
  });
  const [phase, setPhase] = useState({ phase: '', label: '', progress: 0 });
  const [wfClarify, setWfClarify] = useState(null);
  const [wfPlanAck, setWfPlanAck] = useState(null);
  const [clarifyInput, setClarifyInput] = useState('');
  const [clarifySel, setClarifySel] = useState([]);
  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    const v = localStorage.getItem('douya-pet-voice');
    return v === '1';
  });

  const saved = loadSettings();
  // 归一化 baseURL：补全 http:// 协议前缀（用户手填地址常漏协议，导致后端 fetch 报 "Failed to parse URL"）。
  const _rawBaseURL = (saved.baseURL || '').trim() || 'http://192.168.80.99:10003/v1';
  const savedBaseURL = /^https?:\/\//i.test(_rawBaseURL) ? _rawBaseURL : 'http://' + _rawBaseURL;
  const isPublicDeepSeek = /api\.deepseek\.com/.test(savedBaseURL);
  // 模型名归一化（0.21.10 口径：内网 pro-wb ≡ 公网 flash，两边**名不同、物相同**）：
  //   ① 空值 / 旧别名 deepseek-chat → 本环境默认（内网 deepseek-v4-pro-wb，公网 deepseek-flash）；
  //   ② 跨环境把「对面环境的同族名」换算回本环境 —— 内网名拿到公网不认、公网名拿到内网也不认，
  //      必须换（两者背后都是 V4.1-Flash，互换不掉档）；
  //   ③ 内网网关只认 deepseek-v4-pro-wb，**不许**写成 deepseek-v4-flash-wb（那名字不存在）；
  //   ④ **不**覆盖显式写下的 deepseek-v4-pro（公网真 pro）：老配置的默认值迁移由主进程 config
  //      的 modelMigrated 标记一次性完成，用户之后显式改回 pro 不会再被覆盖。
  const _rawModel = saved.model || '';
  let savedModel = _rawModel;
  if (!_rawModel || _rawModel === 'deepseek-chat') savedModel = isPublicDeepSeek ? 'deepseek-flash' : 'deepseek-v4-pro-wb';
  else if (isPublicDeepSeek && (_rawModel === 'deepseek-v4-pro-wb' || _rawModel === 'deepseek-v4-flash-wb')) savedModel = 'deepseek-flash';
  else if (!isPublicDeepSeek && (_rawModel === 'deepseek-flash' || _rawModel === 'deepseek-v4-flash-wb')) savedModel = 'deepseek-v4-pro-wb';
  else if (!isPublicDeepSeek && _rawModel === 'deepseek-v4-pro') savedModel = 'deepseek-v4-pro-wb';
  const [cfg] = useState({
    baseURL: savedBaseURL,
    apiKey: saved.apiKey || '',
    model: savedModel || (isPublicDeepSeek ? 'deepseek-flash' : 'deepseek-v4-pro-wb'),
    enableSearch: saved.enableSearch ?? true,
  });
  const [skills, setSkills] = useState([]);
  const [expertId] = useState('shopping');

  const chatRef = useRef(null);
  const sendRef = useRef(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/skills`).then(r => r.json()).then(setSkills).catch(() => {});
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo(0, chatRef.current.scrollHeight);
  }, [messages, thinking]);

  useEffect(() => {
    if (!window.api || !window.api.on) return;
    const onResult = (r) => {
      setListening(false);
      setVoiceProcessing(false);
      if (r && r.error) {
        setMessages(prev => [...prev, { role: 'system', content: '语音识别失败：' + r.error }]);
      } else if (r && r.text) {
        setTimeout(() => sendRef.current && sendRef.current(r.text), 120);
      }
    };
    const onError = (msg) => {
      setListening(false);
      setVoiceProcessing(false);
      setMessages(prev => [...prev, { role: 'system', content: '语音识别失败：' + msg }]);
    };
    const onLevel = (lvl) => setVoiceLevel(lvl);
    const onCancelled = () => { setListening(false); setVoiceProcessing(false); setVoiceLevel(0); };
    window.api.on('voice:result', onResult);
    window.api.on('voice:error', onError);
    window.api.on('voice:level', onLevel);
    window.api.on('voice:cancelled', onCancelled);
    return () => {};
  }, []);

  async function startListening() {
    if (!window.api || !window.api.invoke) return;
    try {
      setListening(true);
      setVoiceLevel(0);
      setVoiceProcessing(false);
      const res = await window.api.invoke('voice:start', null);
      if (!res || !res.started) {
        setListening(false);
        setMessages(prev => [...prev, { role: 'system', content: '无法启动录音' }]);
      }
    } catch {
      setListening(false);
    }
  }

  async function toggleVoice() {
    if (busy && !listening) return;
    if (listening) {
      setListening(false);
      setVoiceProcessing(true);
      try { await window.api.invoke('voice:stop'); } catch {}
      return;
    }
    startListening();
  }

  function buildTools() {
    // 桌宠不渲染「确认操作」弹窗（本文件不处理 type:'confirm' 事件），因此必须排除需要用户确认的技能
    // （ssh-exec / deploy-static / deploy-node 等）。否则模型一旦调用它们，后端会 waitConfirm 挂满 300 秒，
    // 最后静默返回「用户取消了该操作」，用户只会觉得卡住且不知道为什么。
    // requiresConfirm 由后端 GET /api/skills 下发（单一真源），前端不另立一份危险名单以免漂移。
    // schema 派生统一走 src/shared/toolSchema.js：与主窗共用一份真源，防止两处再次漂移。
    return buildToolsFrom(skills.filter((s) => !s.requiresConfirm));
  }

  async function send(voiceText) {
    // 澄清回复
    if (wfClarify) {
      const ans = (voiceText || '').trim() || buildClarifyAnswer();
      if (!ans) return;
      setMessages(prev => [...prev, { role: 'user', content: ans }]);
      setClarifyInput('');
      setClarifySel([]);
      postClarify(ans);
      return;
    }
    // 计划确认回复
    if (wfPlanAck) {
      const ans = (voiceText || '').trim() || 'OK';
      if (!ans) return;
      setMessages(prev => [...prev, { role: 'user', content: ans }]);
      postPlanAck(ans);
      return;
    }

    const text = (voiceText || '').trim();
    if (!text || busy) return;
    if (!cfg.apiKey) {
      setMessages(prev => [...prev, { role: 'system', content: '请先在主窗口设置中配置 API Key' }]);
      return;
    }

    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setBusy(true);
    setThinking(true);
    setPhase({ phase: '', label: '', progress: 0 });
    setWfClarify(null);
    setWfPlanAck(null);
    setClarifyInput('');
    setClarifySel([]);

    // 展开对话区
    if (!expanded) setExpanded(true);

    let acc = '', accReasoning = '';
    const asstMsg = { role: 'assistant', content: '', reasoning: '' };
    setMessages(prev => [...prev, asstMsg]);

    function writeAssistant(content, reasoning) {
      setMessages(prev => {
        const msgs = prev.slice();
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant') { idx = i; break; } }
        if (idx < 0) return prev;
        msgs[idx] = { ...msgs[idx], content, reasoning: reasoning !== undefined ? reasoning : msgs[idx].reasoning || '' };
        return msgs;
      });
    }

    try {
      const res = await fetch(`${BACKEND}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...packMessages(messages), { role: 'user', content: text }], baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model, enableSearch: cfg.enableSearch, expert: expertId, tools: buildTools() }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const raw = t.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const j = JSON.parse(raw);
            if (j.__tool__) {
              setMessages(prev => [...prev, { role: 'tool', tool: j.__tool__, label: j.label || j.__tool__, silent: !!j.silent, status: 'running' }]);
              continue;
            }
            if (j.__tool_result__) {
              const tr = j.__tool_result__;
              setMessages(prev => prev.map(m => m.role === 'tool' && m.tool === tr.name && m.status === 'running' ? { ...m, status: 'done', result: String(tr.result).slice(0, 400) } : m));
              continue;
            }
            if (j.type === 'phase') { setPhase({ phase: j.phase, label: j.label || '', progress: j.progress || 0 }); continue; }
            if (j.type === 'clarify') {
              const qs = Array.isArray(j.questions) ? j.questions : [];
              setWfClarify({ id: j.id, questions: qs, context: j.context || '' });
              setClarifySel(qs.map(() => ''));
              setClarifyInput('');
              continue;
            }
            if (j.type === 'clarify_result') { setWfClarify(null); setClarifyInput(''); continue; }
            if (j.type === 'plan_ack') {
              setWfPlanAck({ id: j.id, understanding: j.understanding || '', steps: Array.isArray(j.steps) ? j.steps : [], ask: j.ask || '可以开始吗？' });
              continue;
            }
            if (j.type === 'plan_ack_result') { setWfPlanAck(null); continue; }
            if (j.type === 'deliverables') {
              const items = Array.isArray(j.items) ? j.items : [];
              setMessages(prev => [...prev, { role: 'deliverable', items, workspace: j.workspace || '' }]);
              continue;
            }
            if (j.type === 'step') {
              setMessages(prev => [...prev, { role: 'step', n: j.n || 0, total: j.total || 0, label: j.label || '' }]);
              continue;
            }
            if (j.type === 'reasoning' && j.text) {
              accReasoning += j.text;
              writeAssistant(acc, accReasoning);
              continue;
            }
            if (j.error) { acc += '\n⚠️ ' + j.error; writeAssistant(acc, accReasoning); continue; }
            const reasoning = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.reasoning_content) || '';
            if (reasoning) { accReasoning += reasoning; writeAssistant(acc, accReasoning); }
            const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
            if (delta) { acc += delta; writeAssistant(acc, accReasoning); }
          } catch { /* partial */ }
        }
      }
      if (!acc && !accReasoning) writeAssistant('(模型未返回内容)');
      // 语音回复：开启语音开关后，用 TTS 念出菇菇的回复
      if (voiceEnabled && acc.trim()) playTts(acc.trim());
    } catch (e) {
      writeAssistant('⚠️ 请求失败：' + e.message);
    } finally {
      setBusy(false);
      setThinking(false);
    }
  }
  sendRef.current = send;

  // 判断助手这句话是否在「等用户回答」：只有问句才自动重开麦克风；
  // 收尾句（如「已帮你加购」「好的」）不开麦，对话就此结束，避免无限录音。
  function needsReply(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/[？?]$/.test(t)) return true; // 以问号结尾
    if (/吗\s*$|呢\s*$|多少\s*$|哪个\s*$|什么\s*$/.test(t)) return true; // 疑问语气词结尾（可能漏问号）
    return false;
  }

  async function playTts(text) {
    if (!window.api || !window.api.invoke) return;
    setSpeaking(true);
    try {
      const r = await window.api.invoke('tts:speak', text);
      if (r && r.ok && r.data) {
        const audio = new Audio('data:audio/mp3;base64,' + r.data);
        audio.onended = () => {
          setSpeaking(false);
          // 朗读结束后，仅在「等用户回答」时自动开麦（主进程会在 5 秒无声音时自动关闭）
          if (needsReply(text)) startListening();
        };
        audio.onerror = () => setSpeaking(false);
        await audio.play().catch(e => { console.error('[tts] play error', e); setSpeaking(false); });
      } else {
        console.warn('[tts] no audio data returned', r);
        setSpeaking(false);
      }
    } catch (e) {
      console.error('[tts] error', e);
      setSpeaking(false);
    }
  }

  function buildClarifyAnswer() {
    const qs = (wfClarify && wfClarify.questions) || [];
    let ans = '';
    qs.forEach((qq, i) => {
      const qText = typeof qq === 'string' ? qq : qq.q || '';
      const sel = clarifySel[i] || '';
      ans += '• ' + qText + '\n  → ' + (sel || '(未选)') + '\n';
    });
    if (clarifyInput.trim()) ans += '补充：' + clarifyInput.trim() + '\n';
    return ans.trim();
  }
  async function postClarify(content) {
    const id = wfClarify && wfClarify.id;
    if (!id) return;
    try { await fetch(`${BACKEND}/api/clarify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answer: content || '' }) }); } catch {}
    setWfClarify(null);
    setClarifyInput('');
    setClarifySel([]);
  }
  async function postPlanAck(content) {
    const id = wfPlanAck && wfPlanAck.id;
    if (!id) return;
    try { await fetch(`${BACKEND}/api/plan-ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ack: content || '' }) }); } catch {}
    setWfPlanAck(null);
  }

  // 收起时清空消息（下次语音对话重新开始）
  function collapse() {
    setExpanded(false);
    setMessages([]);
    setWfClarify(null);
    setWfPlanAck(null);
    setPhase({ phase: '', label: '', progress: 0 });
    if (window.api && window.api.invoke) window.api.invoke('pet:collapse');
  }

  // 展开
  function expand() {
    setExpanded(true);
    if (window.api && window.api.invoke) window.api.invoke('pet:expand');
  }

  // 收起状态
  if (!expanded) {
    return (
      <div className="pet-collapsed">
        <button className="pet-close pet-close-floating" onClick={() => window.api && window.api.invoke('pet:close')} title="关闭桌宠">×</button>
        <div className={'pet-icon' + (speaking ? ' speaking' : '') + (listening ? ' listening' : '') + (busy && !speaking && !listening ? ' busy' : '') + (!busy && !speaking && !listening ? ' idle' : '')} onClick={expand}>
          <img src={petLogo} className="pet-img-collapsed" alt="豆芽CLAW" draggable="false" />
          {busy && <span className="pet-dot" />}
        </div>
        {busy && <div className="pet-status">工作中…</div>}
        <button className="pet-mic-btn" onClick={async () => { expand(); await new Promise(r => setTimeout(r, 200)); toggleVoice(); }} title="语音说话">
          🎤
        </button>
      </div>
    );
  }

  // 展开状态
  return (
    <div className={'pet-expanded' + (speaking ? ' speaking' : '')}>
      {/* 顶栏：可拖拽，X 按钮放到 titlebar-actions 第一位，不和 — 重叠 */}
      <div className="pet-titlebar">
        <img src={petLogo} className="pet-img-titlebar" alt="" draggable="false" />
        <span className="pet-title">豆芽CLAW</span>
        <div className="pet-titlebar-actions">
          <button className="pet-close pet-close-in-titlebar" onClick={() => window.api && window.api.invoke('pet:close')} title="关闭桌宠">×</button>
          <button className={'pet-voice-toggle' + (voiceEnabled ? ' on' : '')} onClick={() => { const n = !voiceEnabled; setVoiceEnabled(n); localStorage.setItem('douya-pet-voice', n ? '1' : '0'); }} title="语音回复开关">{voiceEnabled ? '🔊' : '🔇'}</button>
          <button className="pet-think-toggle" onClick={() => { const n = !showThinking; setShowThinking(n); localStorage.setItem('douya-pet-show-thinking', n ? '1' : '0'); }}>🧠{showThinking ? '隐藏' : '显示'}</button>
          <button className="pet-collapse-btn" onClick={collapse}>—</button>
        </div>
      </div>

      {/* 对话区 */}
      <div className="pet-chat" ref={chatRef}>
        {messages.length === 0 && (
          <div className="pet-welcome">
            <img src={petMascot} className="pet-img-welcome" alt="" draggable="false" />
            <div>对我说话，或点 🎤 用语音</div>
          </div>
        )}
        {messages.map((m, i) => (
          <React.Fragment key={i}>
            {m.role === 'user' && (
              <div className="pet-msg pet-msg-user">
                <div className="pet-bubble">{m.content}</div>
              </div>
            )}
            {m.role === 'assistant' && (
              <div className="pet-msg pet-msg-asst">
                {m.content && (
                  <div className="pet-bubble">
                    <Markdown>{m.content}</Markdown>
                  </div>
                )}
                {m.reasoning && showThinking && (
                  <details className="pet-reasoning">
                    <summary>🧠 思考过程</summary>
                    <pre>{m.reasoning}</pre>
                  </details>
                )}
              </div>
            )}
            {m.role === 'system' && (
              <div className="pet-system">{m.content}</div>
            )}
          </React.Fragment>
        ))}

        {/* 澄清内联 */}
        {wfClarify && (
          <div className="pet-clarify">
            <div className="pet-clarify-head">🤔 确认几件事</div>
            {(wfClarify.questions || []).map((qq, i) => {
              if (typeof qq === 'string') return <div key={i} className="pet-clarify-q">{i + 1}. {qq}</div>;
              const opts = Array.isArray(qq.options) ? qq.options : [];
              return (
                <div key={i} className="pet-clarify-q">
                  <div>{i + 1}. {qq.q}</div>
                  <div className="pet-clarify-opts">
                    {opts.map((o, k) => (
                      <button key={k} className={'pet-opt-chip' + (clarifySel[i] === o ? ' sel' : '')} onClick={() => { const n = clarifySel.slice(); n[i] = o; setClarifySel(n); }}>{o}</button>
                    ))}
                  </div>
                </div>
              );
            })}
            <input className="pet-clarify-input" value={clarifyInput} onChange={e => setClarifyInput(e.target.value)} placeholder="补充说明…" />
            <div className="pet-clarify-actions">
              <button onClick={() => postClarify(buildClarifyAnswer())}>确认</button>
              <button onClick={() => postClarify('')}>跳过</button>
            </div>
          </div>
        )}

        {/* 计划确认 */}
        {wfPlanAck && (
          <div className="pet-plan-ack">
            <div className="pet-plan-ack-head">📋 执行计划</div>
            {wfPlanAck.understanding && <div className="pet-plan-ack-understanding">🧭 {wfPlanAck.understanding}</div>}
            <ol>{wfPlanAck.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            <div>{wfPlanAck.ask}</div>
            <button onClick={() => postPlanAck('OK')}>确认开始</button>
          </div>
        )}
      </div>

      {/* 底部输入栏 */}
      <div className="pet-inputbar">
        <button className={'pet-mic-btn' + (listening ? ' active' : '')} onClick={toggleVoice} disabled={busy && !listening}>
          {listening ? '🎙️' : '🎤'}
        </button>
        <input
          value=""
          readOnly
          placeholder={listening ? '正在听…说完自动识别' : busy ? '生成中…' : '语音输入或点击🎤'}
          className="pet-text-input"
          onKeyDown={() => {}} // 不处理键盘，纯语音入口
        />
      </div>
    </div>
  );
}