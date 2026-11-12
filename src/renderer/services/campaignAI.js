/**
 * campaignAI —— 「营销专项 · 一句话新建」的大模型编排层。
 *
 * 背景：campaignDirector.js 的 buildCampaignOptionCards 只做「本地关键词规则」匹配，
 * 从不接模型（见该文件模块头：「不接真实 AI，第一版用关键词规则 + 结构化骨架」）。
 * 本文件把「一句话 → 3 套打法方案卡」升级为**真接大模型**，同时把本地规则保留为
 * **诚实降级**：AI 不可用 / 返回格式不合规时，回退到关键词模板，绝不给用户死路。
 *
 * 依赖方向（单向，无环）：
 *   campaignAI → campaignDirector（复用 recognizeCampaignIntent / draftCampaign /
 *   buildCampaignOptionCards）、projectAI（复用 extractJSON）、contextBuilder（buildAIContext）、
 *   campaignStore（CAMPAIGN_TYPES 类型白名单）。
 *   campaignAI 不反向依赖任何模块 / 组件；本文件是纯编排，不碰 DOM、不写盘。
 *
 * ── 诚实红线（实现自检点）────────────────────────────────────────────
 * 【红线 1｜永不假装】AI 成功 → source='ai'，结论措辞写「由大模型给出」；
 *   降级 → source='template'，沿用「关键词匹配」措辞。二者以 UI 标签明示，不混淆。
 * 【红线 2｜不信模型自律】返回体逐项重校验（见 validatePlays），任一不满足即整次判 AI 失败，
 *   绝不「半接」：不接受 2 张卡、不接受白名单外的类型、不接受空标题 / 空理由。
 * 【红线 3｜事实不编造】whyNow.facts 恒为「暂无数据…」，不因接了模型就伪造外部事实。
 * 【红线 4｜假设带标签】brief.assumptions 追加来源说明，明示「本条由大模型起草，未经核实」。
 * 【红线 5｜禁止假装 AI 的措辞】不得出现把「豆芽」与「识别」连写的假装理解类称呼
 *   （见 unit-campaign-naming.mjs 红线，本文件同样受该源码级守卫约束）。
 * ──────────────────────────────────────────────────────────────────
 */

import { chatOnce } from '../api.js';
import { buildAIContext } from './contextBuilder.js';
import { CAMPAIGN_TYPES } from '../store/campaignStore.jsx';
import {
  recognizeCampaignIntent,
  draftCampaign,
  buildCampaignOptionCards,
} from './campaignDirector.js';
import { extractJSON } from './projectAI.js';

/** 生成来源（诚实标注，渲染到 UI 标签）。 */
export const GEN_SOURCE = { AI: 'ai', TEMPLATE: 'template' };

/** 来源中文标签（UI 展示，集中一处，避免组件里散写、口径不一）。 */
export const GEN_SOURCE_LABEL = { ai: 'AI 生成', template: '模板生成' };

/** 专项类型白名单（模型返回的 type 必须在此内，否则整次判 AI 失败）。 */
const TYPE_WHITELIST = Object.keys(CAMPAIGN_TYPES);

/** 事实缺失时的诚实占位（红线 3：接了模型也不编造外部事实）。 */
const NO_FACT = '暂无数据（豆芽尚未采集到可确认的外部事实，不编造）';

/** 默认温度（多方案需要一点发散，但不宜过高导致跑题）。 */
const DEFAULT_TEMPERATURE = 0.6;

/** 恰好要几套打法（方案卡数量，与 buildCampaignOptionCards 的 3 套对齐）。 */
const PLAY_COUNT = 3;

/**
 * 组装「一句话 → 3 套打法」的结构化 Prompt。
 * 只输出字段契约 + 枚举约束，不塞进任何需要模型编造的数据。
 * @param {string} text 用户一句话
 * @returns {Array<{role:string,content:string}>}
 */
function buildMessages(text) {
  return [
    {
      role: 'user',
      content: [
        '用户用一句话描述了他想做成的营销的事：' + text,
        '请给出 3 套「不同打法」的营销专项方案，只返回一个 JSON 对象（不要任何解释、不要 markdown 围栏）：',
        '{ "plays": [ { "type": "专项类型", "title": "打法名", "reason": "为什么推荐这套打法" } ] }',
        'type 必须从以下枚举中选择最贴切的一个：' + TYPE_WHITELIST.join('、') + '。',
        '要求：plays 恰好 3 条；3 条 type 尽量不同、覆盖不同侧重点；title 6-10 字、有辨识度；'
          + 'reason 为一句话（30-50 字），说清适用场景与收益。',
        '禁止编造医疗疗效、数据、案例、专家评价；信息不足时给出通用但具体的打法理由即可。',
      ].join('\n'),
    },
  ];
}

/**
 * 逐项重校验模型返回（红线 2：不信模型自律）。
 * 通过返回 [{ type, title, reason }, ...]（恰 3 条，按序）；任一不满足返回 null（整次判 AI 失败）。
 * @param {*} parsed extractJSON 的结果
 * @returns {Array<{type:string,title:string,reason:string}>|null}
 */
export function validatePlays(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.plays)) return null;
  if (parsed.plays.length < PLAY_COUNT) return null; // 必须给满 3 套，少一套即判失败
  const picked = parsed.plays.slice(0, PLAY_COUNT);
  const out = [];
  for (const it of picked) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
    const type = typeof it.type === 'string' ? it.type.trim() : '';
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    const reason = typeof it.reason === 'string' ? it.reason.trim() : '';
    if (!TYPE_WHITELIST.includes(type)) return null; // 白名单外的类型一律判失败
    if (!title || !reason) return null; // 标题 / 理由必须为非空字符串
    out.push({ type, title, reason });
  }
  return out;
}

/**
 * 由 AI 校验后的 3 条打法 → 3 张完整方案卡（每张 = 一套打法 + 对应 type 的完整 Campaign 草案）。
 * 复用 draftCampaign 生成五段式骨架、复用 recognizeCampaignIntent 取主体 / 名称 / 目标提示；
 * 仅覆盖 type、名称、whyNow 结论措辞（标「由大模型给出」来源），并追加来源假设。
 *
 * @param {Array<{type:string,title:string,reason:string}>} plays 已通过 validatePlays 的 3 条打法
 * @param {string} text 用户一句话
 * @param {Object} opts { subjectType, companyName, source, sourceChangeId, briefText }
 * @returns {Array<{id:string,play:string,title:string,tagline:string,reason:string,type:string,draft:Object}>}
 */
export function buildCardsFromPlays(plays, text, opts = {}) {
  const base = recognizeCampaignIntent(text, opts);
  // 去掉 base 名称里的旧类型标签后缀，换成 AI 给的打法名（与 buildCampaignOptionCards 同法）。
  const baseCore = String(base.name || '').replace(new RegExp(' · ' + base.typeLabel + '$'), '');

  return plays.map((p, i) => {
    const typeLabel = CAMPAIGN_TYPES[p.type];
    const rec = {
      ...base,
      type: p.type,
      typeLabel,
      name: `${baseCore} · ${p.title}`,
    };
    const draft = draftCampaign(rec, {
      source: opts.source || 'user',
      sourceChangeId: opts.sourceChangeId || null,
      briefText: opts.briefText || text,
    });

    // 诚实标注：本条结论由大模型给出（区别于关键词规则的「关键词匹配」措辞）。
    // 措辞不带「豆芽」主语 —— 结论会在 CampaignModule 三处渲染，其中详情页前面已带
    // 「豆芽判断：」前缀，故这里不带主语，三处读起来都通顺；且绝不含「识别」。
    draft.whyNow = {
      ...draft.whyNow,
      facts: [NO_FACT],
      conclusion:
        `按你这句描述，由大模型给出了「${typeLabel}」专项打法建议`
        + `${base.goalHint ? `，核心目标指向「${base.goalHint}」` : ''}。`
        + `\n\n打法选择：${p.title}——${p.reason}`,
    };

    // 红线 4：AI 假设显式标注来源（这是模型生成，不是关键词规则，也不构成已确认结论）。
    draft.brief = {
      ...draft.brief,
      assumptions: [
        ...draft.brief.assumptions,
        '本条草案由大模型根据你的描述起草（AI假设，未经核实，不构成已确认结论）',
      ],
    };

    return {
      id: 'option-ai-' + i,
      play: 'ai-' + (i + 1),
      title: p.title,
      tagline: p.reason,
      reason: p.reason,
      type: p.type,
      draft,
    };
  });
}

/**
 * 一句话 → 3 套不同打法的完整草案（优先大模型，失败诚实降级到关键词模板）。
 *
 * 返回值契约（永远返回可用的 3 张卡，永不死路）：
 *   { ok:boolean, source:'ai'|'template', cards:Array, error:string }
 *   - 成功：ok=true, source='ai', cards=AI 卡 ×3, error=''
 *   - 失败：ok=false, source='template', cards=关键词模板卡 ×3, error=可读原因
 *   AI 任一环节失败（无 chatFn / 抛错 / 无内容 / JSON 不合法 / 重校验不过）都走 template 降级。
 *
 * @param {string} text 用户一句话
 * @param {object} [ctxInput] 传给 buildAIContext 的上下文入参
 *   （{ company, asset, knowledge, project, goalLabel, activitySubject, brain } 等，缺省 {}）
 * @param {object} [opts] { subjectType, companyName, source, sourceChangeId, briefText,
 *                          chatFn, temperature }
 *   - chatFn(messages, ctx, opts)：可注入的补全函数（默认 chatOnce），单测注入假 AI，不真联网
 * @returns {Promise<{ok:boolean, source:'ai'|'template', cards:Array, error:string}>}
 */
export async function generateCampaignOptionsAI(text, ctxInput = {}, opts = {}) {
  const t = String(text || '').trim();

  // 降级用的模板入参（与 AI 成功路径共用同一套主体 / 来源参数，保证两条路径卡片结构一致）。
  const templateOpts = {
    subjectType: opts.subjectType,
    companyName: opts.companyName,
    source: opts.source || 'user',
    sourceChangeId: opts.sourceChangeId || null,
    briefText: opts.briefText || t,
  };
  const templateCards = buildCampaignOptionCards(t, templateOpts);

  // 空输入：不调模型，直接返回模板卡 + 可读提示（module 层已先拦截，这里是第二道防线）。
  if (!t) {
    return {
      ok: false,
      source: GEN_SOURCE.TEMPLATE,
      cards: templateCards,
      error: '请先描述你想做成的一件什么事',
    };
  }

  const chatFn = typeof opts.chatFn === 'function' ? opts.chatFn : chatOnce;
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : DEFAULT_TEMPERATURE;

  let res;
  try {
    const ctx = buildAIContext(ctxInput || {});
    res = await chatFn(buildMessages(t), ctx, { temperature });
  } catch (e) {
    return {
      ok: false,
      source: GEN_SOURCE.TEMPLATE,
      cards: templateCards,
      error: (e && e.message) || 'AI 调用异常',
    };
  }

  if (!res || res.ok !== true || !res.content) {
    return {
      ok: false,
      source: GEN_SOURCE.TEMPLATE,
      cards: templateCards,
      error: (res && res.error) || 'AI 未返回可用内容',
    };
  }

  const plays = validatePlays(extractJSON(res.content));
  if (!plays) {
    return {
      ok: false,
      source: GEN_SOURCE.TEMPLATE,
      cards: templateCards,
      error: 'AI 返回格式不符合要求，已回退到本地模板',
    };
  }

  return {
    ok: true,
    source: GEN_SOURCE.AI,
    cards: buildCardsFromPlays(plays, t, templateOpts),
    error: '',
  };
}

export default {
  GEN_SOURCE,
  GEN_SOURCE_LABEL,
  validatePlays,
  buildCardsFromPlays,
  generateCampaignOptionsAI,
};
