import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Input, Modal, Select, Tag } from 'antd';
import Markdown from './Markdown.jsx';
import { chatOnce } from '../api.js';
import {
  DEV_KINDS,
  DEV_QUICK_ACTIONS,
  devKindMeta,
  loadProjects,
  sortProjects,
  addProject,
  updateProject,
  removeProject,
  touchProject,
  loadSessions,
  upsertSession,
  removeSession,
  sessionsOfProject,
  buildDevPrompt,
  buildDevMessages,
  parseAiFiles,
  parseMentionedFiles,
  pickFallbackFiles,
  resolveReadPaths,
  MAX_AUTO_READ_ROUNDS,
  MAX_AUTO_READ_FILES,
  summarizeOps,
  titleFromTask,
  newId,
} from '../services/devProject.js';

/**
 * 「开发工作台」——豆芽对话里的开发板块（写代码 / 改小程序 / 改网页）。
 *
 * 老板的需求与三条硬约束：
 *   1. 「给一个小程序 ID，就能在本地微信开发者工具写代码，我只管编译上传」
 *      → 登记本地项目目录 → 豆芽读目录树与指定文件 → 产出**完整文件** → 一键落盘 → 一键拉起开发者工具。
 *   2. 「不受记忆影响」→ 调 AI 时 **context 传 null**，一个字段的企业档案都不带（见 buildDevPrompt）。
 *   3. 「还能做别的一些开发和事情」→ 快捷动作覆盖解释/找 Bug/调接口/写脚本/SQL/正则/整体体检/提交说明。
 *
 * 安全：AI 输出当敌意输入。前端先做一次路径预校验（unsafe 标记 + 拒绝写入），
 * 主进程 devBridge 还有第二道闸（realpath 前缀 + 禁写 .git/.douya-backup），落盘前自动备份。
 * 非桌面环境（浏览器/jsdom 里没有 window.api）时，读写能力优雅降级为「不可用提示」，不白屏。
 */
/**
 * @param {object} props
 * @param {JSX.Element} [props.tabsSlot] 顶部那个「对话 / 工作」大号居中切换（由 App 传入，
 *   保证聊天页与本页的切换器是**同一个组件、同一个位置观感**）
 * @param {string} [props.focusProjectId] 外部（统一任务栏）要求定位到的项目 id
 * @param {string} [props.focusSessionId] 外部要求定位到的开发会话 id
 * @param {number} [props.focusNonce] 定位请求的序号：同一条任务点第二次也要生效
 *   —— 只比 id 的话，用户点 A → 在本页手动切到 B → 再点 A 时 props 没变、effect 不重跑，页面就不动了
 * @returns {JSX.Element}
 */
export default function DevWorkbench({ tabsSlot, focusProjectId, focusSessionId, focusNonce }) {
  const { message } = AntApp.useApp();

  /** 主进程能力（浏览器里不存在 → 降级为只读提示）。 */
  const api = typeof window !== 'undefined' && window.api ? window.api : null;
  const canFs = !!(api && typeof api.invoke === 'function');

  const [projects, setProjects] = useState(() => sortProjects(loadProjects()));
  const [activeId, setActiveId] = useState(() => {
    const l = sortProjects(loadProjects());
    return l.length ? l[0].id : '';
  });
  const [sessions, setSessions] = useState(() => loadSessions());
  const [sessionId, setSessionId] = useState('');
  const [tree, setTree] = useState(null);          // { entries, truncated }
  const [treeLoading, setTreeLoading] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [writeRes, setWriteRes] = useState({});    // { [msgId]: {written,failed,backupDir} }
  const [editing, setEditing] = useState(null);     // 正在编辑的项目
  const scrollRef = useRef(null);

  const project = useMemo(() => projects.find((p) => p.id === activeId) || null, [projects, activeId]);
  const projectSessions = useMemo(
    () => sessions.filter((s) => s.projectId === activeId),
    [sessions, activeId]
  );
  const session = useMemo(
    () => projectSessions.find((s) => s.id === sessionId) || null,
    [projectSessions, sessionId]
  );
  const messages = session ? session.messages : [];

  /** 切项目后自动选中它最近的一条会话（没有则留空 = 新会话）。 */
  useEffect(() => {
    const list = sessions.filter((s) => s.projectId === activeId);
    setSessionId(list.length ? list[0].id : '');
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 外部定位（2026-10-19 第十九轮 · 老板第 3 条）：统一任务栏点了某条开发任务之后，
   * App 会切到 wbTab='dev' 并把 projectId / sessionId 传下来，这里把它落成真实选中态。
   *
   * 三条边界（改这里必须守住）：
   *   1. **不动输入框**：只 setActiveId / setSessionId，绝不 setInput ——
   *      用户正在写的那句话不能因为「点了下任务栏」被清掉。
   *   2. 会话可能属于本机别的项目（任务栏是全局的）⇒ 先把 projects 列表重新读一遍再定位，
   *      否则 activeId 指向的项目在 projects 里找不到，主区会显示「还没有项目」的假空态。
   *   3. 必须排在上面那个 activeId effect **之后**（React 按声明顺序跑 effect）：
   *      上面那个会在切项目时把 sessionId 覆盖成该项目的第一条，这里再去改，顺序反了就被顶掉。
   */
  useEffect(() => {
    if (!focusSessionId) return;
    const list = loadSessions();
    setSessions(list);
    if (focusProjectId) {
      setProjects(sortProjects(loadProjects()));
      setActiveId(focusProjectId);
      touchProject(focusProjectId);
    }
    const hit = list.find((s) => s.id === focusSessionId);
    if (hit) setSessionId(hit.id);
    // focusNonce 进依赖：同一条任务点第二次也要重新定位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProjectId, focusSessionId, focusNonce]);

  /** 拉目录树（用户点名文件时，就在这棵树的条目里匹配）。 */
  const loadTree = useCallback(async (p) => {
    if (!canFs || !p || !p.root) { setTree(null); return; }
    setTreeLoading(true);
    try {
      const r = await api.invoke('dev:tree', p.root);
      if (r && r.ok) {
        setTree({ entries: r.entries || [], truncated: !!r.truncated });
      } else {
        setTree(null);
        setErr((r && r.error) || '读取目录失败');
      }
    } catch (e) {
      setTree(null);
      setErr((e && e.message) || '读取目录失败');
    }
    setTreeLoading(false);
  }, [api, canFs]);

  useEffect(() => { if (project) loadTree(project); }, [project && project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 滚到底。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  /** 新建会话。 */
  function newSession() {
    if (!project) return;
    setSessionId('');
    setErr('');
  }

  /** 确保有一个会话（首次发送时创建），返回会话 id。 */
  function ensureSession(firstText) {
    if (session) return session.id;
    const s = upsertSession({
      id: newId('devs'),
      projectId: project.id,
      title: titleFromTask(firstText),
      messages: [],
    });
    setSessions(loadSessions());
    setSessionId(s.id);
    return s.id;
  }

  /**
   * 追加一条消息进会话（按 id 取**当前最新**的会话）。
   *
   * 坑：不能用 render 时的 `session` 快照当基准 —— 一轮里要写两次（用户消息、AI 回复），
   * 两次都基于同一份旧快照就会互相覆盖，结果是「用户那句话根本没进对话」。
   */
  function pushMessage(sid, msg) {
    const id = sid || sessionId;
    if (!id) return null;
    const cur = loadSessions().find((s) => s.id === id) || null;
    if (!cur) return null;
    const saved = upsertSession({ ...cur, messages: cur.messages.concat([msg]) });
    setSessions(loadSessions());
    return saved;
  }

  /** 添加项目：选目录 → 向主进程读元信息（AppID / 类型）。 */
  async function pickAndAdd() {
    if (!canFs) { message.warning('当前环境不支持选择本地目录（需要在桌面版里用）'); return; }
    let r;
    try { r = await api.pickFolder(); } catch { message.error('打开文件夹选择失败'); return; }
    const paths = (r && r.filePaths) || [];
    if (!paths.length) return;
    const root = paths[0];
    let meta = null;
    try { meta = await api.invoke('dev:projectMeta', root); } catch { /* 忽略，按 other 处理 */ }
    const np = addProject({
      root,
      name: meta && meta.name ? meta.name : '',
      kind: meta && meta.ok ? meta.kind : 'other',
      appid: meta && meta.appid ? meta.appid : '',
    });
    setProjects(sortProjects(loadProjects()));
    if (np) {
      setActiveId(np.id);
      touchProject(np.id);
      setProjects(sortProjects(loadProjects()));
      message.success('已添加项目' + (np.appid ? `（AppID ${np.appid}）` : ''));
    }
  }

  async function removeProjectSafe(p) {
    Modal.confirm({
      title: '移除项目',
      content: `只从列表移除「${p.name}」，本地文件不会被删。确定？`,
      okText: '移除',
      cancelText: '取消',
      onOk() {
        removeProject(p.id);
        const next = sortProjects(loadProjects());
        setProjects(next);
        setSessions(loadSessions());
        setActiveId(next.length ? next[0].id : '');
      },
    });
  }

  /** 读取本次要带给 AI 的文件内容（rels 由「对话点名」决定）。 */
  async function collectFiles(p, rels) {
    const list = Array.isArray(rels) ? rels.filter(Boolean) : [];
    if (!canFs || list.length === 0) return { files: [], errors: [] };
    try {
      const r = await api.invoke('dev:readFiles', p.root, list);
      return { files: (r && r.files) || [], errors: (r && r.errors) || [] };
    } catch (e) {
      return { files: [], errors: [{ path: '', error: (e && e.message) || '读取失败' }] };
    }
  }

  /**
   * 发送：识别点名文件 → 读文件 → 拼 prompt → 调 AI（**不带企业档案**）→ 解析文件改动集。
   *
   * 2026-09-19（B 方案）加了「自动补读」回路：
   *   模型看到目录结构、但手上没有某个文件的正文时，用 ```read: 申请（协议见 devProject.DEV_READ_RULE），
   *   这里把它申请的路径**对齐到目录树里真实存在的文件**、自动读出来、再问一轮（≤ MAX_AUTO_READ_ROUNDS 轮）。
   *   目的：止住「反复让用户回一句『先看 xxx』」的体感 —— 缺文件它自己申请，系统自动给。
   *   申请不到时**绝不猜**：树里没有 / 同名多个说不清，一律如实记进 autoRead 交给界面显示。
   */
  async function send() {
    const task = input.trim();
    if (!task || busy) return;
    if (!project) { message.warning('先添加一个项目'); return; }

    // 先「识别」用户点名了哪些文件（这是识别结果，不依赖读文件成功）。
    const entries = tree && Array.isArray(tree.entries) ? tree.entries : [];
    const mentioned = parseMentionedFiles(task, entries);
    let wanted = mentioned;
    if (wanted.length === 0) {
      // 没点名任何文件 → 按项目类型分流兜底：web 项目带 index.html / 入口文件，小程序带 app.json…，
      // 只在目录树里真实存在的文件里命中，并受「数量上限 + 字节预算」双层约束（防一次带太多撑爆）。
      wanted = pickFallbackFiles(entries, project && project.kind, tree && tree.truncated);
    }

    const sid = ensureSession(task);
    // ctx：本次实际带入的文件名清单，挂到用户消息上，气泡下方会显示「本次带入：…」
    const userMsg = { id: newId('m'), role: 'user', content: task, at: Date.now(), ctx: wanted.slice() };
    pushMessage(sid, userMsg);
    setInput('');
    setBusy(true);
    setErr('');

    // ---- 自动补读回路的状态（跨轮累计）----
    let files = [];              // 当前手上一共带了哪些文件正文
    const filePaths = new Set(); // 已带上文件的路径：去重 + 防止把同一个文件申请两遍
    const readErrors = [];       // 读取失败的文件（首轮兜底 + 补读，都要如实显示）
    const opsByPath = new Map(); // 跨轮合并的改动集：同一文件以**最后一轮**为准
    const opOrder = [];          // 首次出现的顺序（保证界面里文件顺序稳定）
    const auto = { rounds: 0, paths: [], missing: [], ambiguous: [], overflow: 0, calls: 0 };
    let note = '';
    let scopeOut = '';
    let conflict = false;
    let failed = null;

    try {
      // 首轮的文件来自「用户点名 / 项目类型兜底」
      const first = await collectFiles(project, wanted);
      files = first.files.slice();
      for (const f of files) filePaths.add(f.path);
      readErrors.push(...first.errors);

      // 一轮 = 一次 LLM 调用；补读轮在首轮之后，故总调用数 ≤ 1 + MAX_AUTO_READ_ROUNDS
      for (let round = 0; round <= MAX_AUTO_READ_ROUNDS; round++) {
        // 补读轮：明确告诉它「你申请的文件已经读出来了 / 哪几个没找到」，
        // 并要求它这一轮给出**完整**的改动集（避免只补一个文件、把首轮的改动丢了）。
        const extraNote = [
          project.note || '',
          round > 0
            ? `（系统提示：这是自动补读的第 ${round} 轮。你在上一轮用 read 块申请的文件，`
              + '凡是目录树里真实存在的，系统已经读出来并放在上面的【文件内容】里了；'
              + '找不到的会另外告诉你。请**基于现在手上的完整信息，直接给出最终改动**，'
              + '并且把你上一轮已经给过的文件改动**一并重新完整输出一遍**，不要只给新增的那几个。）'
            : '',
        ].filter(Boolean).join('\n');

        const prompt = buildDevPrompt({
          project,
          tree: entries,
          files,
          task,
          extraNote,
        });
        // 历史记录取「刚落库的最新会话」，否则这次的任务进不了对话上下文
        const live = loadSessions().find((s) => s.id === sid) || null;
        // 关键：context 传 null —— 开发板块不吃企业记忆（老板的硬要求）。
        // 深度思考：开发任务是「读代码 → 定位 bug → 产出改动」，是最吃推理的场景，
        //   此前不传 reasoningEffort ⇒ 后端恒为 'none'（零思考出代码），质量明显偏低。
        //   现改为显式 high，并把 maxTokens 提到 16000：思考产出的 reasoning_content 会占预算，
        //   8000 在长文件改写时可能被 reasoning 挤空导致「AI 未返回内容」。
        //   代价是慢 6~8 倍（实测 0.8s → 5~7s），故超时同步放宽到 10 分钟兜底。
        const r = await chatOnce(buildDevMessages(live, prompt), null, {
          temperature: 0.2,
          reasoningEffort: 'high',
          maxTokens: 16000,
          timeoutMs: 600000,
        });
        auto.calls += 1;

        if (!r || r.ok !== true || !r.content) {
          failed = (r && r.error) || 'AI 未返回内容';
          break;
        }

        const parsed = parseAiFiles(r.content);
        note = parsed.note;
        scopeOut = parsed.scopeOut;
        conflict = parsed.conflict;
        for (const o of parsed.ops) {
          if (!opsByPath.has(o.path)) opOrder.push(o.path);
          opsByPath.set(o.path, o);
        }

        // 没有申请 → 干完了，收工
        if (!parsed.reads.length) break;
        if (round >= MAX_AUTO_READ_ROUNDS) { auto.overflow += parsed.reads.length; break; }

        const remain = MAX_AUTO_READ_FILES - auto.paths.length;
        if (remain <= 0) { auto.overflow += parsed.reads.length; break; }

        // 申请 → 对齐到目录树里真实存在的文件（**绝不返回不存在的路径**）
        const rs = resolveReadPaths(parsed.reads, entries, remain);
        auto.missing.push(...rs.missing);
        auto.ambiguous.push(...rs.ambiguous);
        auto.overflow += rs.overflow;

        const fresh = rs.paths.filter((p) => !filePaths.has(p));
        if (!fresh.length) break; // 申请不到任何新文件 → 停，别空转（missing/ambiguous 已记下）

        const more = await collectFiles(project, fresh);
        readErrors.push(...more.errors);
        let got = 0;
        for (const f of more.files) {
          if (filePaths.has(f.path)) continue;
          filePaths.add(f.path);
          files.push(f);
          auto.paths.push(f.path);
          got += 1;
        }
        // 轮数只在**真的读到东西**时才记 —— 否则界面会显示「读了 0 个文件（补读 1 轮）」这种自相矛盾的话
        if (!got) break; // 一个都没读回来（例如全被大小上限挡掉）→ 停，别空转
        auto.rounds += 1;
      }

      const ops = opOrder.map((p) => opsByPath.get(p));
      if (failed && ops.length === 0) {
        // 一轮都没成、也没有任何改动 ⇒ 只有错误可说
        pushMessage(sid, { id: newId('m'), role: 'assistant', content: '', at: Date.now(), error: failed });
        setErr(failed);
      } else {
        // 关键：**补读轮失败但首轮已经有改动时，不许把改动丢掉** ——
        // 首轮它是真干出东西了，只是我们又去问了一轮、那一轮没成。
        // 丢掉 = 静默吞掉已完成的工作（老板最烦这种）。改成「改动照给 + 如实说补读那轮没成」。
        const readWarn = readErrors.length
          ? `\n\n（提示：${readErrors.map((x) => x.path || '部分文件').join('、')} 读取失败，本次未带上）`
          : '';
        const failWarn = failed
          ? `\n\n（提醒：它还想再看几个文件，但那次请求没成（${failed}），`
            + '所以下面这份改动是在**没有**那几个文件的情况下给的，可能不全 —— 你可以直接回一句让它继续。）'
          : '';
        pushMessage(sid, {
          id: newId('m'),
          role: 'assistant',
          content: (note || (scopeOut ? '' : '（豆芽只返回了文件改动）')) + readWarn + failWarn,
          at: Date.now(),
          ops,
          // 范围外声明（```scope:out）原样带出，由界面渲染成醒目提示；
          // conflict=true 表示豆芽「既说不在本项目里、又给了文件改动」—— 自相矛盾，
          // 必须如实提示用户先确认，不许静默丢弃任何一边。
          scopeOut,
          scopeConflict: conflict,
          // 自动补读的如实交代：补了几轮 / 补了哪些 / 申请了但没找到 / 同名说不清 / 被上限挡掉几个。
          // 这些一律照实显示，宁可让用户看到「有 2 个没找到」，也不假装什么都没发生。
          autoRead: auto,
        });
        if (failed) setErr(failed);
      }
    } catch (e) {
      const m = (e && e.message) || '请求失败';
      pushMessage(sid, { id: newId('m'), role: 'assistant', content: '', at: Date.now(), error: m });
      setErr(m);
    }
    setBusy(false);
    setSessions(loadSessions());
  }

  /** 把一条 AI 回复里的文件改动写入本地项目（主进程会再校验 + 备份）。 */
  async function writeOps(msg) {
    if (!project || !canFs) { message.warning('当前环境不能写本地文件'); return; }
    const ops = (msg.ops || []).filter((o) => !o.unsafe);
    const blocked = (msg.ops || []).filter((o) => o.unsafe);
    if (ops.length === 0) { message.warning('没有可写入的合法文件改动'); return; }

    let r = null;
    try {
      r = await api.invoke('dev:write', project.root, ops.map((o) => ({ path: o.path, content: o.content })));
    } catch (e) {
      r = { ok: false, failed: [{ path: '', error: (e && e.message) || '写入失败' }] };
    }
    setWriteRes((prev) => ({ ...prev, [msg.id]: { ...r, blocked } }));
    if (r && r.ok) {
      message.success(`已写入 ${r.written.length} 个文件${r.backed.length ? `（备份 ${r.backed.length} 个）` : ''}`);
      loadTree(project);
    } else {
      message.error('写入失败：' + ((r && r.failed && r.failed[0] && r.failed[0].error) || '未知错误'));
    }
  }

  /** 打开项目文件夹（资源管理器）。 */
  async function openFolder() {
    if (!project) return;
    if (!canFs) { message.warning('当前环境不支持打开本地目录'); return; }
    const r = await api.invoke('dev:openFolder', project.root);
    if (!r || !r.ok) message.error((r && r.error) || '打开失败');
  }

  /** 用微信开发者工具打开项目。 */
  async function openDevTools() {
    if (!project) return;
    if (!canFs) { message.warning('当前环境不支持拉起开发者工具'); return; }
    const r = await api.invoke('dev:openDevTools', project.root);
    if (r && r.ok) message.success('已用微信开发者工具打开该项目，编译后手动上传即可');
    else message.warning(((r && r.error) || '拉起失败') + ((r && r.hint) ? '：' + r.hint : ''));
  }

  /** 快捷动作：把模板填进输入框（不直接发，留给用户改）。 */
  function applyQuick(a) {
    setInput((v) => (v ? v + '\n' + a.text : a.text));
  }

  return (
    <>
      <div className="sidebar dw-side">
        {/* 第十九轮（老板第 3 条）：原来这里挂着三个小页签（经营对话 / 开发工作台 / ⏰ 定时任务）。
            现在换成主列顶部那个「对话 / 工作」大号居中切换 —— 与聊天页**同一个组件、同一个位置**，
            所以左栏回归它本来的职责：项目列表 + 开发会话。 */}
        <div className="sidebar-header">
          <span className="sidebar-title">开发项目</span>
          <Button size="small" type="primary" ghost onClick={pickAndAdd}>+ 添加项目</Button>
        </div>
        <div className="dw-proj-list">
          {projects.length === 0 ? (
            <div className="session-empty">还没有项目，点「+ 添加项目」选一个小程序/网页目录</div>
          ) : (
            projects.map((p) => {
              const km = devKindMeta(p.kind);
              return (
                <div
                  key={p.id}
                  className={'dw-proj' + (p.id === activeId ? ' active' : '')}
                  onClick={() => { setActiveId(p.id); touchProject(p.id); setErr(''); }}
                  title={p.root}
                >
                  <span className="dw-proj-icon">{km.icon}</span>
                  <span className="dw-proj-body">
                    <span className="dw-proj-name">{p.name}</span>
                    <span className="dw-proj-meta">
                      {km.label}
                      {p.appid ? ' · ' + p.appid : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="dw-proj-del"
                    title="移除"
                    onClick={(e) => { e.stopPropagation(); removeProjectSafe(p); }}
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>

        {project && (
          <>
            <div className="sidebar-header dw-sess-head">
              <span className="sidebar-title">开发会话</span>
              <Button size="small" type="primary" ghost onClick={newSession}>+ 新建</Button>
            </div>
            <div className="session-list">
              {projectSessions.length === 0 ? (
                <div className="session-empty">还没有会话</div>
              ) : (
                projectSessions.map((s) => (
                  <div
                    key={s.id}
                    className={'session-item' + (s.id === sessionId ? ' active' : '')}
                    onClick={() => setSessionId(s.id)}
                    title={s.title}
                  >
                    <div className="session-name">{s.title}</div>
                    <button
                      type="button"
                      className="dw-sess-del"
                      title="删除会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSession(s.id);
                        setSessions(loadSessions());
                        if (s.id === sessionId) setSessionId('');
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        <div className="sidebar-foot">代码改动会先备份再落盘；本板块不读企业档案</div>
      </div>

      <div className="main dw-main">
        {/* 顶部「对话 / 工作」大号居中切换（App 传入）。
            放在主列第一行而不是侧栏里：两种模式下的切换器位置必须一致
            —— 聊天页它也在主区顶部居中。 */}
        {tabsSlot ? <div className="dw-scope-wrap">{tabsSlot}</div> : null}
        {!project ? (
          <div className="dw-empty">
            <div className="dw-empty-icon">🛠</div>
            <div className="dw-empty-title">开发工作台</div>
            <div className="dw-empty-sub">
              这里专门用来<b>写代码 / 改小程序 / 改网页</b>：登记一个本地项目目录，
              豆芽就能读目录结构和文件、按你说的改，改完直接写回本地 —— 你只要在微信开发者工具里编译、上传。<br />
              它<b>不受企业记忆影响</b>：不带任何企业档案，只按代码本身说话。
            </div>
            <Button type="primary" onClick={pickAndAdd}>+ 添加项目</Button>
            {!canFs && (
              <div className="dw-empty-note">当前环境不支持读写本地文件（需要在桌面版豆芽CLAW 里使用）。</div>
            )}
          </div>
        ) : (
          <>
            <div className="dw-head">
              <div className="dw-head-left">
                <div className="dw-head-title">
                  {devKindMeta(project.kind).icon} {project.name}
                </div>
                <div className="dw-head-sub" title={project.root}>{project.root}</div>
              </div>
              <div className="dw-head-right">
                <Button size="small" onClick={() => loadTree(project)} loading={treeLoading}>刷新结构</Button>
                <Button size="small" onClick={() => setEditing(project)}>设置</Button>
                <Button size="small" onClick={openFolder}>打开文件夹</Button>
                <Button size="small" type="primary" onClick={openDevTools}>微信开发者工具</Button>
              </div>
            </div>

            {tree && tree.truncated && (
              <div className="dw-note">目录较大，结构已截断显示；要看某个文件的内容，直接在对话里说它的文件名即可（例如「看下 app.json」）。</div>
            )}

            <div className="chat dw-chat" ref={scrollRef}>
              {messages.length === 0 && (
                <div className="dw-welcome">
                  <div className="dw-welcome-title">想让豆芽改什么？</div>
                  <div className="dw-quick">
                    {DEV_QUICK_ACTIONS.map((a) => (
                      <button type="button" key={a.key} className="dw-quick-chip" onClick={() => applyQuick(a)}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <div className="dw-welcome-hint">
                    比如「给商品详情页加个立即购买按钮」。豆芽给出完整代码，你确认后点「应用到项目」。
                  </div>
                </div>
              )}

              {messages.map((m) => (
                <div className={'dw-msg dw-msg-' + m.role} key={m.id}>
                  <div className="dw-msg-role">{m.role === 'user' ? '我' : '豆芽'}</div>
                  {m.error ? (
                    <div className="xm-error">这次没成：{m.error}</div>
                  ) : (
                    <div className="dw-msg-body">
                      <Markdown>{m.content || ''}</Markdown>
                    </div>
                  )}
                  {m.role === 'user' && Array.isArray(m.ctx) && m.ctx.length > 0 && (
                    <div className="dw-msg-ctx">本次带入：{m.ctx.join('、')}</div>
                  )}
                  {m.role === 'assistant' && m.scopeOut && (
                    <div className="dw-scope-out">
                      <div className="dw-scope-out-hd">这事不在当前打开的项目里</div>
                      <div className="dw-scope-out-bd">
                        <Markdown>{m.scopeOut}</Markdown>
                      </div>
                      {m.scopeConflict && Array.isArray(m.ops) && m.ops.length > 0 && (
                        <div className="dw-scope-out-warn">
                          豆芽这次话说得自相矛盾：它一边说这事不在本项目里，一边又给出了 {m.ops.length} 个文件的改动。
                          请先看清它到底动的是哪儿，再决定要不要应用下面的改动（不确认就别点）。
                        </div>
                      )}
                    </div>
                  )}
                  {m.role === 'assistant' && m.autoRead
                    && (m.autoRead.rounds > 0 || m.autoRead.missing.length > 0
                      || m.autoRead.ambiguous.length > 0 || m.autoRead.overflow > 0) && (
                    <div className="dw-autoread">
                      {m.autoRead.rounds > 0 && (
                        <div className="dw-autoread-ok">
                          它自己申请、系统自动读了 {m.autoRead.paths.length} 个文件（补读 {m.autoRead.rounds} 轮）：
                          {m.autoRead.paths.join('、')}
                        </div>
                      )}
                      {m.autoRead.missing.length > 0 && (
                        <div className="dw-autoread-miss">
                          它申请的文件在项目里找不到：{m.autoRead.missing.join('、')}——没找到的它不该猜，
                          请核对下文件名，或者你自己把路径说清楚。
                        </div>
                      )}
                      {m.autoRead.ambiguous.length > 0 && (
                        <div className="dw-autoread-miss">
                          这几个名字在项目里有多份、说不清指哪个：{m.autoRead.ambiguous.join('、')}——需要你把完整路径说清楚。
                        </div>
                      )}
                      {m.autoRead.overflow > 0 && (
                        <div className="dw-autoread-miss">
                          还有 {m.autoRead.overflow} 个申请超出一次能读的上限，本次没读。
                        </div>
                      )}
                    </div>
                  )}
                  {m.role === 'assistant' && m.ops && m.ops.length > 0 && (
                    <OpsCard
                      msg={m}
                      res={writeRes[m.id]}
                      canFs={canFs}
                      onWrite={() => writeOps(m)}
                      onCopy={() => {
                        const t = m.ops.map((o) => `=== ${o.path} ===\n${o.content}`).join('\n\n');
                        try { navigator.clipboard.writeText(t); message.success('已复制全部文件内容'); } catch { /* ignore */ }
                      }}
                    />
                  )}
                </div>
              ))}

              {busy && (
                <div className="dw-msg dw-msg-assistant">
                  <div className="dw-msg-role">豆芽</div>
                  <div className="dw-loading">
                    正在读代码、写改动…（缺文件时它会自己申请、系统自动读了再问一轮，可能要等一会儿）
                  </div>
                </div>
              )}
            </div>

            {err && !busy && <div className="xm-error dw-err">上次失败：{err}</div>}

            <div className="dw-composer">
              <Input.TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="说要改什么，比如：给 pages/goods/detail 加一个立即购买按钮；要看某文件就说「看下 app.json」"
                autoSize={{ minRows: 2, maxRows: 6 }}
                onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send(); } }}
              />
              <div className="dw-composer-foot">
                <span className="dw-composer-hint">
                  要改的文件直接说名字即可 · 不读企业档案 · Enter 发送，Shift+Enter 换行
                </span>
                <Button type="primary" onClick={send} loading={busy} disabled={!input.trim()}>
                  发送
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 项目设置 */}
      <Modal
        title="项目设置"
        open={!!editing}
        onCancel={() => setEditing(null)}
        okText="保存"
        cancelText="取消"
        onOk={() => {
          if (!editing) return;
          const saved = updateProject(editing.id, {
            name: editing.name,
            kind: editing.kind,
            appid: editing.appid,
            note: editing.note,
          });
          setProjects(sortProjects(loadProjects()));
          setEditing(null);
          if (saved) message.success('已保存');
        }}
      >
        {editing && (
          <div className="dw-form">
            <label className="dw-form-row">
              <span>名称</span>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="dw-form-row">
              <span>类型</span>
              <Select
                value={editing.kind}
                onChange={(v) => setEditing({ ...editing, kind: v })}
                options={DEV_KINDS.map((k) => ({ value: k.key, label: k.icon + ' ' + k.label }))}
                style={{ width: '100%' }}
              />
            </label>
            <label className="dw-form-row">
              <span>小程序 AppID</span>
              <Input
                value={editing.appid}
                placeholder="wx 开头；留空则按本地 project.config.json 为准"
                onChange={(e) => setEditing({ ...editing, appid: e.target.value })}
              />
            </label>
            <label className="dw-form-row">
              <span>给豆芽的长期要求</span>
              <Input.TextArea
                value={editing.note}
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder="例：不要用第三方 UI 库 / 注释用中文 / 别动 utils 目录"
                onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              />
            </label>
            <div className="dw-form-path">目录：{editing.root}</div>
          </div>
        )}
      </Modal>
    </>
  );
}

/** 文件改动卡片：列出 AI 要改的文件 + 内容预览 + 写入按钮 + 写入结果。 */
function OpsCard({ msg, res, canFs, onWrite, onCopy }) {
  const [openPath, setOpenPath] = useState('');
  const stat = summarizeOps(msg.ops);
  const unsafe = msg.ops.filter((o) => o.unsafe);
  const done = !!(res && res.ok);
  // 标题说人话：老板不关心「待写入 / 写入 / 删除」这三个工程词的区别，
  // 只关心「它要动几个文件」和「动完了没有」。未落盘前**不能**说「改好了」——那是撒谎。
  const detail = stat.del > 0 ? `（覆盖 ${stat.write} · 删除 ${stat.del}）` : '';
  return (
    <div className="dw-ops">
      <div className="dw-ops-hd">
        <span className="dw-ops-title">
          {done
            ? `已改好 ${stat.total} 个文件${detail}`
            : `这次要改 ${stat.total} 个文件${detail}`}
        </span>
        <span className="dw-ops-actions">
          <Button size="small" onClick={onCopy}>复制内容</Button>
          <Button size="small" type="primary" onClick={onWrite} disabled={!canFs || stat.unsafe === stat.total}>
            {done ? '再改一次' : '应用到项目'}
          </Button>
        </span>
      </div>

      {unsafe.length > 0 && (
        <div className="xm-error">
          拦截 {unsafe.length} 个越权路径（绝对路径 / .. / .git），不会写入：
          {unsafe.map((o) => o.path).join('、')}
        </div>
      )}

      <div className="dw-ops-list">
        {msg.ops.map((o) => (
          <div className="dw-op" key={o.path}>
            <button type="button" className="dw-op-head" onClick={() => setOpenPath(openPath === o.path ? '' : o.path)}>
              <span className={'dw-op-kind' + (o.kind === 'delete' ? ' del' : '')}>
                {o.kind === 'delete' ? '删除' : '写入'}
              </span>
              <span className="dw-op-path">{o.path}</span>
              <span className="dw-op-size">
                {o.unsafe ? <Tag color="red">已拦截</Tag> : Math.round((o.content || '').length / 1024 * 10) / 10 + 'KB'}
              </span>
            </button>
            {openPath === o.path && (
              <pre className="dw-op-body">{o.content || '（删除此文件）'}</pre>
            )}
          </div>
        ))}
      </div>

      {res && (
        <div className={res.ok ? 'dw-ops-result' : 'xm-error'}>
          {res.ok
            ? `${res.written.length} 个文件已写进项目` +
              (res.backed && res.backed.length ? `，改之前的旧文件已备份到 ${res.backupDir}` : '')
            : '没写成功：' + ((res.failed && res.failed[0] && res.failed[0].error) || '未知错误')}
        </div>
      )}
    </div>
  );
}
