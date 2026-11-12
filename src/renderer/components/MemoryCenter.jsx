import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Modal, App as AntApp } from 'antd';

/**
 * 我的记忆（B 阶段 #251）—— 设置弹窗第 5 张入口卡的二级面板
 * ============================================================================
 * 这一屏存在的唯一理由：
 *
 *   A 阶段把「读取侧」做对了，B6 把「写入链路」接上了 —— 但用户**看不见任何东西**。
 *   一个记不住的助手和一个记得住的助手，在界面上长得一模一样，用户没法判断
 *   "它到底懂不懂我"。
 *   ⇒ 这一屏把四层档案 + 变更流水**摊开给用户看**，让它从"我相信它记得"
 *      变成"我能看见它记了什么、什么时候记的、凭什么记的"。
 *
 * ★ 四条设计纪律（每条都是为了不做成"看起来很聪明的空壳"）：
 *
 *   ① **只用真实 schema，不臆造字段**。
 *      落盘条目真实字段（见 memoryStore.normalizeEntry）：
 *        key / value / source / confidence / firstSeen / lastSeen /
 *        confirmedCount / status / supersedes / evidence[{quote, at, source}]
 *      设计稿里写的 `confirmed_count` / `last_seen` 是**下划线命名**，与真实
 *      落盘字段（驼峰）**不一致** —— 这里一律以**真实落盘为准**，
 *      否则读出来永远是 undefined、界面显示一堆空白（且不报错，最阴的一种）。
 *      `pendingConflicts` 这个字段**根本不存在** ⇒ 「待确认」由
 *      `status === 'pending_conflict'` 推导，「已确认」由
 *      `status === 'active' && confirmedCount >= 2` 推导，**不新增存储字段**。
 *
 *   ② **空状态必须说清"为什么空"**。三种"什么都没有"完全不同：
 *        未登录 → 提示去登录
 *        开关关了 → 提示去开启（并给一键入口）
 *        真的还没聊 → 说"多聊几句就有了"
 *      一律显示"暂无记忆"会把用户引到错误的排障方向。
 *
 *   ③ **删除 = 归档，不是抹掉**。按钮文案与二次确认都要说清：
 *      它不再参与对话，但流水里留痕（这是记忆作为"证据"与"随便存的东西"的区别）。
 *
 *   ④ **开关只关抽取，不关 Secret 门**。界面上要写明白：
 *      关掉只是"不再新增"，**不是**"忘掉已有的"，也**不影响**密码/密钥这类
 *      敏感信息本来就不会被记住这件事。
 * ============================================================================
 */

// 四层的中文名与说明。**顺序即叙事顺序**：我是谁 → 我在哪个组织 → 我怎么干活 → 我在做什么。
const LAYERS = [
  { id: 'identity', name: '我的身份', icon: '🙋', desc: '名字、城市、联络方式等关于你本人的稳定信息' },
  { id: 'orgs', name: '我的组织', icon: '🏢', desc: '你所在的公司、部门、职位' },
  { id: 'prefs', name: '我的工作方式', icon: '⚙️', desc: '你的偏好与习惯：称呼、语言、常用做法' },
  { id: 'projects', name: '我的项目', icon: '📁', desc: '你正在推进的事，以及它们的进展' },
];

// 来源权威度（与 memoryReconciler.SOURCE_AUTHORITY 同序）：
// 用户明说 > 系统认定 > 对话里推断。界面上要让用户能一眼看出"这条是怎么来的"。
const SOURCE_LABEL = {
  explicit_user: { text: '你亲口说的', cls: 'strong' },
  system: { text: '系统认定', cls: 'mid' },
  conversation: { text: '从对话推断', cls: 'weak' },
  imported: { text: '导入的', cls: 'mid' },
  inferred: { text: '模型推测', cls: 'weak' },
};

// 流水动作的中文说明。**删也必须留痕**，所以 SUPERSEDE 有两种语义，靠 detail.verdict 区分。
const OP_LABEL = {
  ADD: '记住',
  UPDATE: '更新',
  CONFIRM: '再次确认',
  SUPERSEDE: '取代',
  CONFLICT: '发现冲突',
  DECAY: '久未提及，淡出',
  EVICT: '超出上限，淘汰',
  REJECT: '拒绝采纳',
};

/** 时间显示：今天/昨天用相对说法，更早给日期。避免一屏横着 8 个 2026-10-05 15:33:21。 */
function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diffDays === 0) return '今天 ' + hm;
  if (diffDays === 1) return '昨天 ' + hm;
  if (diffDays > 1 && diffDays < 7) return diffDays + ' 天前 ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

/** 一条记忆的"成熟度"：待确认 / 已确认（≥2 次） / 普通。**不新增字段，只做推导**。 */
function maturityOf(e) {
  if (!e) return { text: '', cls: '' };
  if (e.status === 'pending_conflict') return { text: '待确认', cls: 'pending' };
  if (e.status === 'active' && Number(e.confirmedCount) >= 2) {
    return { text: '已确认 ' + e.confirmedCount + ' 次', cls: 'confirmed' };
  }
  return { text: '', cls: '' };
}

/** 条目主值的展示安全化：value 允许不是字符串（normalizeEntry 不限死），一律先转成可渲染文本。 */
function valueText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function MemoryCenter() {
  const { message, modal } = AntApp.useApp();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);          // memory:read 的原样返回
  const [ledger, setLedger] = useState([]);        // memory:ledger 的 rows
  const [enabled, setEnabled] = useState(true);    // 开关
  const [switching, setSwitching] = useState(false);
  const [activeLayer, setActiveLayer] = useState('identity');
  const [showLedger, setShowLedger] = useState(false);
  const [busyKey, setBusyKey] = useState('');      // 正在归档的条目（防连点）

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const api = (typeof window !== 'undefined' && window.api) || {};
      // 三个调用**互相独立**：任何一个失败都不该让整屏白掉。
      // 用 allSettled 而不是 all —— all 会在第一个 reject 时整体失败，
      // 于是"流水读失败"会让"四层档案"也显示不出来（明明前者更重要）。
      const [rRes, lRes, sRes] = await Promise.allSettled([
        api.memoryRead ? api.memoryRead() : Promise.resolve(null),
        api.memoryLedger ? api.memoryLedger({ limit: 60 }) : Promise.resolve(null),
        api.memoryGetSettings ? api.memoryGetSettings() : Promise.resolve(null),
      ]);
      const r = rRes.status === 'fulfilled' ? rRes.value : null;
      const l = lRes.status === 'fulfilled' ? lRes.value : null;
      const s = sRes.status === 'fulfilled' ? sRes.value : null;
      setData(r || { ok: false, error: 'ipc_unavailable', layers: {}, total: 0, owner: '' });
      setLedger((l && Array.isArray(l.rows)) ? l.rows : []);
      setEnabled(!s || s.enabled !== false);
    } catch (e) {
      setData({ ok: false, error: (e && e.message) || 'unknown', layers: {}, total: 0, owner: '' });
      setLedger([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const layers = (data && data.layers) || {};
  const owner = (data && data.owner) || '';
  const total = Number((data && data.total) || 0);
  const notLoggedIn = !owner;

  /** 每层可见条目：`archived` 的**不展示**（用户删过的东西不该再冒出来）。 */
  const byLayer = useMemo(() => {
    const out = {};
    for (const L of LAYERS) {
      const arr = Array.isArray(layers[L.id]) ? layers[L.id] : [];
      out[L.id] = arr.filter((e) => e && e.status !== 'archived');
      // 顺手按 lastSeen 倒序：最近被提到的排前面，用户第一眼看到的是"它最近懂我的那部分"。
      out[L.id].sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
    }
    return out;
  }, [layers]);

  const visibleTotal = LAYERS.reduce((n, L) => n + byLayer[L.id].length, 0);

  const toggleEnabled = async (next) => {
    setSwitching(true);
    try {
      const api = (typeof window !== 'undefined' && window.api) || {};
      if (!api.memorySetSettings) throw new Error('当前版本不支持该设置');
      const r = await api.memorySetSettings({ enabled: next });
      setEnabled(!r || r.enabled !== false);
      message.success(next ? '已开启：之后的对话会被记下来' : '已关闭：不再新增记忆（已有的不会被删除）');
    } catch (e) {
      message.error('设置失败：' + ((e && e.message) || '未知错误'));
      // 失败时回读真实值，绝不凭乐观假设改 UI（否则界面与磁盘不一致，用户下次打开才发现）
      try {
        const api = (typeof window !== 'undefined' && window.api) || {};
        const s = await api.memoryGetSettings();
        setEnabled(!s || s.enabled !== false);
      } catch { /* 回读也失败：保持原值，至少不假装成功 */ }
    } finally {
      setSwitching(false);
    }
  };

  const archiveOne = (layerId, entry) => {
    const L = LAYERS.find((x) => x.id === layerId) || { name: layerId };
    modal.confirm({
      title: '不再记住这条？',
      content: (
        <div style={{ lineHeight: 1.7 }}>
          <div><b>{entry.key}</b>：{valueText(entry.value)}</div>
          <div style={{ color: 'var(--c-text-2)', fontSize: 12, marginTop: 6 }}>
            它属于「{L.name}」。删掉后不会再出现在对话里，但这条操作会记进变更流水
            （记忆要能解释"我为什么曾经记过它"，所以不做物理抹除）。
          </div>
        </div>
      ),
      okText: '不再记住',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBusyKey(layerId + '|' + entry.key);
        try {
          const api = (typeof window !== 'undefined' && window.api) || {};
          if (!api.memoryArchive) throw new Error('当前版本不支持删除');
          const r = await api.memoryArchive({ layer: layerId, key: entry.key });
          if (!r || r.ok !== true) throw new Error((r && r.error) || '删除失败');
          message.success('已不再记住这条');
          await load();
        } catch (e) {
          message.error('删除失败：' + ((e && e.message) || '未知错误'));
        } finally {
          setBusyKey('');
        }
      },
    });
  };

  // ---------------------------------------------------------------- 渲染

  const renderEntry = (layerId, e, idx) => {
    const src = SOURCE_LABEL[e.source] || (e.source ? { text: e.source, cls: 'mid' } : null);
    const mat = maturityOf(e);
    const busy = busyKey === layerId + '|' + e.key;
    return (
      <div className="mem-entry" key={layerId + '|' + e.key + '|' + idx}>
        <div className="mem-entry-main">
          <div className="mem-entry-key">{e.key}</div>
          <div className="mem-entry-val">{valueText(e.value)}</div>
        </div>
        <div className="mem-entry-side">
          {mat.text && <span className={'mem-chip ' + mat.cls}>{mat.text}</span>}
          {src && <span className={'mem-chip src-' + src.cls}>{src.text}</span>}
          <span className="mem-entry-time">{fmtTime(e.lastSeen)}</span>
          <button
            type="button"
            className="mem-del"
            disabled={busy}
            title="不再记住这条"
            onClick={() => archiveOne(layerId, e)}
          >
            {busy ? '…' : '×'}
          </button>
        </div>
      </div>
    );
  };

  const renderEmpty = () => {
    if (notLoggedIn) {
      return (
        <div className="mem-empty">
          <div className="mem-empty-title">还没有登录</div>
          <div className="mem-empty-desc">登录之后豆芽才会开始认识你。记忆跟着账号走，不会串到别人身上。</div>
        </div>
      );
    }
    if (!enabled) {
      return (
        <div className="mem-empty">
          <div className="mem-empty-title">「生成对话记忆」当前是关闭的</div>
          <div className="mem-empty-desc">关着的时候，豆芽只把这轮对话当作一次性问答，不会留下来。</div>
          <Button size="small" type="primary" ghost onClick={() => toggleEnabled(true)} disabled={switching}>
            现在开启
          </Button>
        </div>
      );
    }
    if (!visibleTotal) {
      return (
        <div className="mem-empty">
          <div className="mem-empty-title">还没有记住任何东西</div>
          <div className="mem-empty-desc">
            这很正常 —— 刚装好时档案是空的。多聊几次，尤其是自然地说出自己的
            <b>名字、所在公司、职位、习惯</b>，这里就会开始长东西。
          </div>
        </div>
      );
    }
    return (
      <div className="mem-empty">
        <div className="mem-empty-title">「{LAYERS.find((l) => l.id === activeLayer)?.name}」还没有内容</div>
        <div className="mem-empty-desc">其他几层里有内容，切上去看看。</div>
      </div>
    );
  };

  return (
    <div className="memory-center">
      {/* ===== 顶部：状态 + 开关 ===== */}
      <div className="mem-head">
        <div className="mem-head-left">
          <div className="mem-head-title">它现在记得你 {visibleTotal} 条</div>
          <div className="mem-head-sub">
            {notLoggedIn
              ? '未登录 · 记忆跟着账号走'
              : (enabled ? '正在记录 · 关掉只是不再新增，已有的不会被删除' : '已暂停记录 · 已有的仍然会用于对话')}
          </div>
        </div>
        <label className={'mem-switch' + (enabled ? ' on' : '')}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={switching}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          <span className="mem-switch-track"><span className="mem-switch-knob" /></span>
          <span className="mem-switch-text">{enabled ? '开启' : '关闭'}</span>
        </label>
      </div>

      {/* 开关语义说明：这是最容易被误解的一处，写清楚，省一轮客服。 */}
      <p className="mem-note">
        关闭只影响「要不要从对话里抽取新记忆」，<b>不会</b>删除已记下的内容，也<b>不会</b>影响
        密码、密钥这类敏感信息的拦截 —— 那种信息从来就不会被记下来。
      </p>

      {loading ? (
        <div className="mem-loading">读取中…</div>
      ) : (
        <>
          {data && data.ok === false && !notLoggedIn && (
            <div className="mem-error">记忆档案读取异常：{data.error || '未知原因'}</div>
          )}

          {/* ===== 四层分组 ===== */}
          <div className="mem-tabs">
            {LAYERS.map((L) => (
              <button
                key={L.id}
                type="button"
                className={'mem-tab' + (activeLayer === L.id ? ' active' : '')}
                onClick={() => setActiveLayer(L.id)}
                title={L.desc}
              >
                <span className="mem-tab-name">{L.name}</span>
                <span className="mem-tab-count">{byLayer[L.id].length}</span>
              </button>
            ))}
          </div>

          <div className="mem-layer-desc">
            {LAYERS.find((l) => l.id === activeLayer)?.desc}
          </div>

          <div className="mem-list">
            {byLayer[activeLayer].length === 0
              ? renderEmpty()
              : byLayer[activeLayer].map((e, i) => renderEntry(activeLayer, e, i))}
          </div>

          {/* ===== 变更流水（折叠）===== */}
          <div className="mem-ledger-head" onClick={() => setShowLedger((v) => !v)}>
            <span>记忆记录时间线（{ledger.length} 条）</span>
            <span className="mem-ledger-arrow">{showLedger ? '收起' : '展开'}</span>
          </div>
          {showLedger && (
            <div className="mem-ledger">
              {ledger.length === 0 && (
                <div className="mem-ledger-empty">还没有任何变更记录。</div>
              )}
              {ledger.slice().reverse().map((r, i) => {
                const op = OP_LABEL[r.op] || r.op || '变更';
                const isArchive = r.op === 'SUPERSEDE' && r.detail && r.detail.verdict === 'ARCHIVE';
                return (
                  <div className="mem-ledger-row" key={i}>
                    <span className="mem-ledger-time">{fmtTime(r.ts)}</span>
                    <span className={'mem-ledger-op' + (isArchive ? ' archive' : '')}>
                      {isArchive ? '你删除了' : op}
                    </span>
                    <span className="mem-ledger-key">{r.key || '-'}</span>
                    <span className="mem-ledger-layer">
                      {(LAYERS.find((l) => l.id === r.layer) || {}).name || r.layer || ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mem-foot">
            <Button size="small" onClick={load} disabled={loading}>刷新</Button>
          </div>
        </>
      )}
    </div>
  );
}

export default MemoryCenter;
