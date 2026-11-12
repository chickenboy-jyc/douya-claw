import React from 'react';

/**
 * HistoryPanel —— 豆芽助手右栏「历史成果」（0.21.11 · 老板第 7 条重做）。
 *
 * 老板原话：「豆芽助手里面任务栏常在 不要隐藏掉，历史成果换个UI根据任务栏来 简单干净点 现在有点乱」。
 *
 * 改前（App.jsx 内联的一坨）：一条成果 = 名字 / 一整条绝对路径 / 三个等宽按钮，三层堆叠；
 * 「常用能力」还是图标 + 双行卡片。两条成果就把一屏占满，看着当然乱。
 * 改后（与 components/TaskCenter.jsx 同构）：
 *   圆点（类型色）+ 文件名（单行省略）+ 类型标签，点整行 = 打开，
 *   指针移上去才出现「定位 / 继续改」；绝对路径退到 title，鼠标停一下就能看到。
 *   分组顺序照任务栏：**主列表在最上**（历史成果），常用能力 / 关键任务沉在下面。
 *
 * 为什么从 App.jsx 抽出来：① 内联 JSX 无法单独渲染，等于这块 UI 永远只能靠肉眼验；
 *   ② 这一版把「点击行为 + 类型判定 + 行的层级」都收进一个纯展示组件，
 *   探针（scripts/smoke/entry-assistant-panel.jsx）可以对它做真实点击断言。
 *   组件**只负责画**：数据与动作全部由 App 传入，它不读 store、不读 localStorage。
 *
 * @param {object} props
 * @param {boolean} props.open                       是否显示右栏
 * @param {Array<{name:string,path:string}>} props.items  成果列表（已由调用方过滤过程脚本）
 * @param {Array<{id:string,name:string}>} props.tasks    关键任务（进行中的活动）
 * @param {()=>void} props.onClose
 * @param {(path:string)=>void} props.onOpen         打开文件
 * @param {(path:string)=>void} props.onLocate       在文件夹里定位
 * @param {(item:object)=>void} props.onContinueEdit 把成果加进对话继续改
 * @param {(moduleKey:string)=>void} props.onSelectModule 常用能力跳转
 */

/**
 * 成果文件的「类型」判定：按**扩展名**（文件自带的事实），不按目录名猜。
 * 配色沿用任务栏那套（绿 / 黄 / 紫 是老板点名过的三色），补两个：
 * 文档绿 #34c759 · 表格黄 #ffcc00 · 演示紫 #af52de · 图片橙 #ff9500 · 其它灰。
 */
const DELIV_KINDS = [
  { tone: 'doc', label: '文档', re: /\.(docx?|pdf|md|markdown|txt|rtf)$/i },
  { tone: 'sheet', label: '表格', re: /\.(xlsx?|csv|tsv)$/i },
  { tone: 'slide', label: '演示', re: /\.(pptx?|key)$/i },
  { tone: 'image', label: '图片', re: /\.(png|jpe?g|webp|gif|bmp|svg)$/i },
];

export function delivKind(d) {
  const s = String((d && (d.path || d.name)) || '');
  for (const k of DELIV_KINDS) {
    if (k.re.test(s)) return k;
  }
  return { tone: 'other', label: '文件' };
}

/** 常用能力四条。`desc` 只做辅助、不承载事实，所以允许极短。 */
export const RAIL_CAPS = [
  { key: 'intel', label: '竞品分析', desc: '同行动态' },
  { key: 'content', label: '内容创作', desc: '写文案' },
  // 【0.21.21 · 老板 2026-10-21】`activity` → `campaign`。
  // 「做活动方案」这个能力本身没删（老板拍板「保留做活动方案能力」），只是它的落点换了家：
  // 原来落在 ActivityHub（活动与档期页），那页已整块下线；现在落 `campaign`（营销专项），
  // 它才是「一句话出一套方案」的那一页。key 改掉之后这条不会再靠别名兜底到豆芽助手。
  { key: 'campaign', label: '做活动方案', desc: '一句话出一套' },
  { key: 'direction', label: '经营方案', desc: '现在最该做什么' },
];

export default function HistoryPanel({
  open,
  items,
  tasks,
  onClose,
  onOpen,
  onLocate,
  onContinueEdit,
  onSelectModule,
}) {
  if (!open) return null;
  const dels = Array.isArray(items) ? items : [];
  const jobs = Array.isArray(tasks) ? tasks : [];

  return (
    <aside className="right-panel hist-panel" data-hist-panel="1">
      <div className="right-panel-head">
        <span>历史成果</span>
        <button className="right-panel-close" onClick={onClose} title="收起">×</button>
      </div>

      <div className="hist-scroll">
        <div className="hist-group-title">
          历史成果
          {dels.length > 0 ? <span className="hist-group-n">{dels.length}</span> : null}
        </div>
        {dels.length === 0 ? (
          <div className="right-panel-empty">暂无成果，做完任务后这里会出现历史记录</div>
        ) : (
          dels.map((d, k) => {
            const kind = delivKind(d);
            return (
              <div
                key={(d.path || k) + k}
                className="hist-row"
                role="link"
                tabIndex={0}
                data-hist-row={kind.tone}
                title={d.path || d.name}
                onClick={() => onOpen(d.path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(d.path); }
                }}
              >
                <span className={'hist-dot hist-dot-' + kind.tone} aria-hidden="true" />
                <span className="hist-name">{d.name}</span>
                <span className={'hist-tag hist-tag-' + kind.tone}>{kind.label}</span>
                {/* 「打开」本来就是点整行，不再重复一个按钮。
                    stopPropagation：否则点「定位 / 继续改」会先触发整行的打开。 */}
                <span className="hist-actions">
                  <button
                    className="hist-btn"
                    title="在文件夹里定位"
                    onClick={(e) => { e.stopPropagation(); onLocate(d.path); }}
                  >
                    定位
                  </button>
                  <button
                    className="hist-btn"
                    title="把这条成果加进对话，接着改"
                    onClick={(e) => { e.stopPropagation(); onContinueEdit(d); }}
                  >
                    继续改
                  </button>
                </span>
              </div>
            );
          })
        )}

        <div className="hist-group-title">常用能力</div>
        {RAIL_CAPS.map((c) => (
          <div
            key={c.key}
            className="hist-row"
            role="link"
            tabIndex={0}
            data-hist-cap={c.key}
            onClick={() => onSelectModule(c.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectModule(c.key); }
            }}
          >
            <span className="hist-dot hist-dot-cap" aria-hidden="true" />
            <span className="hist-name">{c.label}</span>
            <span className="hist-hint">{c.desc}</span>
          </div>
        ))}

        <div className="hist-group-title">关键任务</div>
        {jobs.length === 0 ? (
          <div className="right-panel-empty">还没有进行中的活动。跟豆芽说一句要办的活动，这里就会出现。</div>
        ) : (
          jobs.map((t) => (
            <div
              key={t.id}
              className="hist-row"
              role="link"
              tabIndex={0}
              onClick={() => onSelectModule('campaign')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectModule('campaign'); }
              }}
            >
              <span className="hist-dot hist-dot-task" aria-hidden="true" />
              <span className="hist-name">{t.name}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
