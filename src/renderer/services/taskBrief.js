/**
 * services/taskBrief.js —— 「让豆芽做」的单一事实源（brief 组装 + 一次性自动开跑通道）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这个模块（老板 2026-09「第二优先」）
 * ────────────────────────────────────────────────────────────────────────────
 * 老板原话：点「让豆芽做」后「看不到豆芽到底做了什么」，要求：
 *   点了「让豆芽做」→ **带任务跳到对话页** → 豆芽**当场生成** → **当场看到结果**。
 * 而不是像现在这样：跑完扔进「待审核」，要自己点开找。
 *
 * 本模块把这条链路的**可测逻辑**从 App.jsx（React 组件，难单测）里抽出来：
 *   · buildTaskBrief(task)      —— 「复制给豆芽的那段话」只有这一份定义（避免两处漂移）；
 *   · CONVERSATION_MODULE / isConversationModule —— 哪个模块才是「对话页」（可对话）；
 *   · createAutoRunGate()       —— **一次性**认领守卫（StrictMode 双跑 / 切模块重挂载都不重复发）；
 *   · consumeAutoRun(...)       —— 一次性消费者编排（对话页→自动发送→收尾；非对话页→只预填）；
 *   · finalizeAutoRunTask(...)  —— 收尾：**任务回写（→ review）+ 资产落库**两样产出都不丢。
 *
 * 红线：
 *   ① 自动开跑**只发一次**（guard 认领即置位）；
 *   ② 目标模块不是对话页 → **回退为只预填、不自动发送**（不许强行发到不支持的模块）；
 *   ③ 任务回写与资产落库**必须仍发生**（finalizeAutoRunTask 里显式两步，缺一不可）。
 */

/** 「对话页」= 豆芽对话（workbench）。只有它能自动开跑。 */
export const CONVERSATION_MODULE = 'workbench';

/** 判定某模块是否可对话（可自动开跑）。 */
export function isConversationModule(mod) {
  return mod === CONVERSATION_MODULE;
}

/**
 * 组装「让豆芽做」的任务 brief（= 老板说的「把上面那段话复制给豆芽」）。
 *
 * 字段逐一取自任务对象；**缺字段时不产生空标签行**（否则模型会收到「【任务目标】」这种空壳）。
 *
 * @param {object} task 任务对象（可含 title / description / goal / requirements / outputFormat）
 * @returns {string}
 */
export function buildTaskBrief(task) {
  const t = task || {};
  const title = String(t.title == null ? '' : t.title).trim();
  const lines = [];
  if (t.description) lines.push('【任务描述】' + t.description);
  if (t.goal) lines.push('【任务目标】' + t.goal);
  if (t.requirements) lines.push('【任务要求】' + t.requirements);
  if (t.outputFormat) lines.push('【输出格式】' + t.outputFormat);
  return lines.length
    ? '执行任务「' + title + '」：\n' + lines.join('\n') + '\n请开始。'
    : '执行任务「' + title + '」。';
}

/**
 * 创建一个「一次性认领」守卫。
 *
 * 用途：自动开跑必须只发一次 —— React **StrictMode 下 effect 会跑两次**，
 * 切换模块/重挂载也可能让 effect 再跑。守卫第一次 claim() 返回 true，之后一律 false。
 *
 * @returns {{claim: () => boolean, isClaimed: () => boolean, reset: () => void}}
 */
export function createAutoRunGate() {
  let claimed = false;
  return {
    /** 尝试认领：首次 true，之后 false。 */
    claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    /** 是否已被认领过。 */
    isClaimed() {
      return claimed;
    },
    /** 重置（仅供测试/复用）。 */
    reset() {
      claimed = false;
    },
  };
}

/**
 * 一次性消费「自动开跑」交接单。
 *
 * 语义：
 *   · pending 为空            → { action:'none' }；
 *   · module 不是对话页        → **回退**：只调用 prefill（预填输入框），**不**调用 send/finalize；
 *   · module 是对话页          → 认领成功才 send(brief)，随后 finalize(内容)；重复消费直接 none。
 *
 * @param {object} p
 * @param {{brief:string, gate?:object, onDone?:Function}} p.pending 交接单（gate 由发起方 createAutoRunGate() 提供）
 * @param {string} p.module 目标模块（effectiveModule）
 * @param {(brief:string)=>Promise<string>|string} [p.send]    自动发送（返回最终文本，供 finalize）
 * @param {(brief:string)=>void} [p.prefill]                   仅预填（回退路径用）
 * @param {(content:string)=>void} [p.finalize]                收尾（任务回写 + 资产落库）
 * @returns {Promise<{action:'none'|'prefill'|'send', sent:boolean}>}
 */
export async function consumeAutoRun({ pending, module, send, prefill, finalize } = {}) {
  if (!pending || !pending.brief) return { action: 'none', sent: false };
  const gate = pending.gate && typeof pending.gate.claim === 'function' ? pending.gate : createAutoRunGate();

  // 非对话模块 → 回退为只预填（保持既有行为），绝不强行自动发送
  if (!isConversationModule(module)) {
    if (gate.claim()) {
      if (typeof prefill === 'function') prefill(pending.brief);
      return { action: 'prefill', sent: false };
    }
    return { action: 'none', sent: false };
  }

  // 已被认领（StrictMode 二次 effect / 重挂载）→ 不重复发送
  if (!gate.claim()) return { action: 'none', sent: false };

  let content = '';
  if (typeof send === 'function') {
    content = await send(pending.brief);
  }
  if (typeof finalize === 'function') {
    finalize(content);
  }
  return { action: 'send', sent: true };
}

/**
 * 自动开跑收尾：**任务回写（→ review）+ 资产落库**，两样产出都不丢。
 *
 * 说明：旧链路跑的是 executeTask（第 7/8 阶段做这两件事）。改成「跳到对话页跑」后，
 * 由本函数在对话产出结果后补做这两步，等价保留产出（completeTaskByAI 会置 status='review'）。
 *
 * @param {object} p
 * @param {object} p.task 任务对象
 * @param {string} p.content AI 在对话页产出的最终文本
 * @param {Function} [p.completeTaskByAI] 任务回写（companyStore 的 completeTaskByAI）
 * @param {Function} [p.saveAsset] 资产落库器（createTaskAssetSaver 的产物）
 * @param {string} [p.assetType] 能力对应的资产 type
 * @param {string} [p.companyId]
 * @param {string} [p.projectId]
 * @param {string} [p.aiInput] brief，作为任务 aiInput 留档
 * @returns {{wroteBack:boolean, assetId:string|null}}
 */
export function finalizeAutoRunTask({
  task,
  content,
  completeTaskByAI,
  saveAsset,
  assetType,
  companyId,
  projectId,
  aiInput,
} = {}) {
  const out = { wroteBack: false, assetId: null };
  const text = String(content == null ? '' : content).trim();
  if (!task || !text) return out;

  // 1) 任务回写（→ 待审核 review）
  if (typeof completeTaskByAI === 'function') {
    completeTaskByAI(task.id, {
      aiInput: aiInput || '',
      aiProcess: '（由豆芽对话页执行，结果见对话）',
      aiOutput: text,
    });
    out.wroteBack = true;
  }

  // 2) 资产落库（按 capability.assetType，taskId 去重）
  if (typeof saveAsset === 'function' && assetType && companyId) {
    out.assetId = saveAsset(assetType, task, text, { companyId, projectId: projectId || null });
  }

  return out;
}

export default {
  CONVERSATION_MODULE,
  isConversationModule,
  buildTaskBrief,
  createAutoRunGate,
  consumeAutoRun,
  finalizeAutoRunTask,
};
