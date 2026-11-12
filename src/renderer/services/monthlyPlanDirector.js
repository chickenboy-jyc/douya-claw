/**
 * monthlyPlanDirector —— 月度计划文本解析 + 紧迫度分类（纯函数，不 import React / store）。
 *
 * 提供给：
 *   - 面板（TodayOps）解析用户粘贴的带日期计划文本。
 *   - scripts/test-monthly-plan.mjs 做纯函数契约测试（node 直接跑）。
 */

/**
 * 计划节点类型（用户 2026-09-10 定调：支持月度/季度/年度/线下活动时间）。
 */
export const PLAN_NODE_TYPES = {
  monthly: '月度计划',
  quarterly: '季度计划',
  yearly: '年度计划',
  offline_activity: '线下活动',
};

/** 类型关键词 → 类型 key（顺序即优先级，命中即止）。 */
const TYPE_KEYWORDS = [
  { type: 'quarterly', keywords: ['季度', 'Q1', 'Q2', 'Q3', 'Q4'] },
  { type: 'yearly', keywords: ['年度', '全年', '年度计划', '一年'] },
  { type: 'offline_activity', keywords: ['线下', '展会', '沙龙', '义诊', '活动', '到店', '峰会', '论坛', '发布会'] },
];

/** 根据节点标题/描述文字识别计划类型（默认 monthly）。 */
export function classifyPlanType(text) {
  const t = String(text || '');
  for (const rule of TYPE_KEYWORDS) {
    if (rule.keywords.some((k) => t.includes(k))) return rule.type;
  }
  return 'monthly';
}

/**
 * 从用户输入文本提取带真实日期的节点。
 *
 * 支持的日期写法（缺年份默认 baseYear，不传则取当前年）：
 *   - 9/20            单日期（斜杠）
 *   - 9.20            单日期（点）
 *   - 9-20            单日期（横杠）
 *   - 9月20日 / 9月20号   中文日期
 *   - 9/20-9/22       区间（开始-结束，endDate）
 *   - 2026-09-20      带年份（ISO 短横）
 *
 * 返回 [{ date:'YYYY-MM-DD', endDate?, title, type?, note }]，title 取日期后跟的描述文字。
 */
export function parsePlan(text, { baseYear } = {}) {
  const year = Number.isFinite(baseYear) ? baseYear : new Date().getFullYear();
  if (!text || typeof text !== 'string') return [];

  const TOKEN_RE = /((\d{4})[-/.年])?(\d{1,2})[月/\-.](\d{1,2})(日|号)?/g;
  const RANGE_SEP_RE = /^\s*[-~～至—]\s*/;

  // 1) 收集所有日期 token
  const tokens = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const full = m[0];
    const yStr = m[2];
    const month = parseInt(m[3], 10);
    const day = parseInt(m[4], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue; // 跳过非法日期（如电话号）
    tokens.push({
      index: m.index,
      end: m.index + full.length,
      year: yStr ? parseInt(yStr, 10) : year,
      month,
      day,
    });
  }
  if (tokens.length === 0) return [];

  const fmt = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // 2) 合并区间（date 紧跟 range 分隔符再紧跟另一个 date）
  const items = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const after = text.slice(t.end);
    const sep = RANGE_SEP_RE.exec(after);
    if (sep && i + 1 < tokens.length) {
      const consumed = t.end + sep[0].length;
      if (tokens[i + 1].index === consumed) {
        items.push({ start: t, end: tokens[i + 1], index: t.index, endPos: tokens[i + 1].end });
        i++; // 跳过被吃掉的结束 token
        continue;
      }
    }
    items.push({ start: t, end: null, index: t.index, endPos: t.end });
  }

  // 3) 截取每个节点日期后的描述文字作为 title
  const nodes = [];
  for (let j = 0; j < items.length; j++) {
    const it = items[j];
    const nextIndex = j + 1 < items.length ? items[j + 1].index : text.length;
    const raw = text.slice(it.endPos, nextIndex);
    const title = raw
      .replace(/^[\s，,、:：;；\-–—~～至]+/, '')
      .replace(/[\s，,、:：;；\-–—~～至]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const node = { date: fmt(it.start.year, it.start.month, it.start.day), title };
    if (it.end) node.endDate = fmt(it.end.year, it.end.month, it.end.day);
    // 自动识别节点类型（季度/年度/线下活动/月度），供 UI 展示与分类
    node.type = classifyPlanType(title);
    nodes.push(node);
  }
  return nodes;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function diffDays(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
}

/**
 * 紧迫度分类（以节点 date 为基准，本地时区）：
 *   'past'  已过
 *   'near'  7 天内（含今天）
 *   'soon'  21 天内
 *   'far'   更远
 * now 可注入（默认 new Date()），便于测试。
 */
export function classifyNode(node, now = new Date()) {
  if (!node || !node.date) return 'far';
  const [y, mo, d] = node.date.split('-').map(Number);
  const target = new Date(y, mo - 1, d);
  if (isNaN(target.getTime())) return 'far';
  const diff = diffDays(target, now);
  if (diff < 0) return 'past';
  if (diff <= 7) return 'near';
  if (diff <= 21) return 'soon';
  return 'far';
}

export default { parsePlan, classifyNode, classifyPlanType, PLAN_NODE_TYPES };
