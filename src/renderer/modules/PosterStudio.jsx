/**
 * PosterStudio —— 「海报」模式（视频设计页的第三态）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【这一页给谁用】
 *   口腔门诊的前台 / 老板，**完全不懂设计**。他们的真实需求是：
 *   明天要发一张「洗牙 9.9」的朋友圈图，手上没有设计师、没有 PS、没有 Canva。
 *   所以他们要的动线只有一条：**选模板 → 改几个字 → 换张图 → 一键导出**。
 *   任何一步多一个必填项，他们就会放弃。左栏三块（模板 / 文案 / 图片）就是按这条动线排的。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么预览也走 canvas，而不是 DOM 排版 + 导出另写一套】
 *   这是本仓最容易做出「预览好看、导出错位」的地方：
 *   DOM 用 CSS 排文字（换行靠浏览器、行高靠 line-height、字距靠 letter-spacing），
 *   canvas 用 `fillText` 排文字 —— 两套引擎的换行点几乎不可能一致。
 *   实测差异会出现在 3 个地方：① 中英混排的断行位置；② 行高取整（CSS 取整 vs
 *   fontSize*lineHeight 浮点）；③ 图片 cover 裁切的正负半像素。
 *   所以回退路径也只有一份排版真相：`drawPoster(ctx, doc, scale)`（默认走 `src/poster/`）。
 *     · 预览：`scale = 显示宽度 × devicePixelRatio / 画布宽度`
 *     · 导出：`scale = 2`（2160×2880）
 *   两边除了缩放比以外，一个像素的逻辑都不差。文字 wrap / 行高 / 字距 / 图片裁切
 *   全在同一个函数里，想「预览导出不一致」都做不到。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【拖动为什么同时听 pointer 与 mouse 两套事件】
 *   本仓已经踩过一次：自动化验收（jsdom / 脚本派发）发的是 `new MouseEvent('mousedown')`，
 *   而只在 `onPointerDown` 上接手势的组件在那种环境下**完全不动**，
 *   人会以为是"拖拽没做"。反过来只接 mouse 又在触屏 / 手写笔上失效。
 *   所以两套都接，并用 `gestureRef` 去重：一次物理按下会先后触发 pointerdown 和
 *   mousedown，第二次进来时 `gestureRef.current` 非空就直接 return，不会起两个手势。
 *   移动 / 抬起同理（window 上四组监听）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【渲染层绝不直连外网、绝不直接读盘】
 *   导入图片走 `window.api.invoke('file:readThumb', p, 1600)` 换 dataUrl；
 *   导出走 `poster:export`；项目读写走 `poster:saveProject / readProject / listProjects`。
 *   这些通道由主进程另一路实现，本文件**只按契约调用**，缺了就给一句
 *   「需要更新到新版」的提示 —— 不白屏、不抛错、不假装成功。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【本仓的反复失效模式：两形状对不上】（加字段 / 接通道前先扫一遍这张表）
 *   同一个 bug 在本仓已经出现过 5 次：一端按 shape A 读，另一端给的是 shape B。
 *   后果一律是**构建绿、lint 绿、单测全绿，功能是死的**，只有真点一下 / 打印才看得见。
 *
 *     ① `file:pick` 返回 `{ canceled, filePaths: string[] }`，
 *        早前这里读 `res.files`（那是 wanxPickMedia 的形状）⇒「导入图片」永远弹
 *        「没有选中图片」。本文件用 `pickPathsOf()` 同时认两种形状。
 *     ② `exported` 是对象数组而不是字符串数组 ⇒ 早前按字符串 join 出来全是
 *        `[object Object]`。
 *     ③ `artifactPaths` 有的通道给目录、有的给文件 ⇒ 按"都是文件"遍历时抛 EISDIR。
 *     ④ `CANVAS_PRESETS` 的字段叫 `key`，而 `rescaleDoc` 写的是 `next.ratioKey`
 *        ⇒ 每切一次尺寸 `ratioKey` 变 `undefined`，"其它比例会留白"的提示在 3:4 上
 *        也一直挂着、尺寸按钮永远没有选中态。现在改用 `ratioKeyOf(width, height)`
 *        从尺寸推导，`ratioKey` 是**派生值**、不再有第二个来源。
 *     ⑤ `poster:export` 的取消态是 `{ ok:false, canceled:true }`，**没有 `error` 字段**
 *        ⇒ 写成 `r.error.includes(...)` 会在用户点"取消"时抛 TypeError。
 *
 *   自查三条（都不花时间）：
 *     · 这个字段名，是**下游真给的**还是我**以为**它给的？去主进程 / 上游打出来看一眼。
 *     · 这个值是**派生**还是**独立来源**？能派生就别存（存两处必然有一天不同步）。
 *     · 写解析代码时，能不能**同时认两种形状**？能就认两种，成本一行。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【window.__posterTest 是产品能力，不是测试脚手架】
 *   豆芽 Agent 要能自己生成海报（"帮我做一张种植牙优惠的海报"），靠的就是这套钩子：
 *   套模板、改文案、挪图层、导入图片、直接导出到指定路径。
 *   所以它们必须**真的改 state、真的调 IPC**，不允许写成假动作。
 *   组件卸载时清掉，避免热更新后残留一个指向旧树的闭包。
 * ════════════════════════════════════════════════════════════════════════════
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, InputNumber, Modal, Segmented, Select, Slider } from 'antd';

import {
  POSTER_BASE,
  POSTER_TEMPLATES,
  cleanCompanyName,
  fillCompanyNameInLayers,
  findPlaceholderTexts,
  findTemplate,
  posterTemplateNames,
  templateToLayers,
} from './posterTemplates.js';
import { useCompany } from '../store/companyStore.jsx';
import { renderPosterExport, renderPosterSurface } from './posterRenderSwitch.js';
import { canvasToDataUrl } from '../../poster/index';
import '../styles/poster-studio.css';

const { TextArea } = Input;

/** 撤销栈深度。30 够覆盖「试了十几次都不满意」的场景，又不至于吃内存。 */
const HISTORY_DEPTH = 30;

/** 导出倍率。1080×1440 → 2160×2880，朋友圈 / 打印都够。 */
const EXPORT_SCALE = 2;

/**
 * 图片解码超时。超过就当作「这张图暂时画不出来」继续导出，
 * 而不是让用户对着转圈等 —— 一张图解码失败不该把整张海报卡死。
 */
const IMAGE_LOAD_TIMEOUT_MS = 4000;

/** 四档画布。默认 3:4（1080×1440），与产品规格一致。 */
const CANVAS_PRESETS = [
  { key: '3:4', label: '3:4', hint: '朋友圈竖图（默认）', width: 1080, height: 1440 },
  { key: '1:1', label: '1:1', hint: '方图 / 头像位', width: 1080, height: 1080 },
  { key: '9:16', label: '9:16', hint: '全屏竖版 / 视频号', width: 1080, height: 1920 },
  { key: '16:9', label: '16:9', hint: '横版 / 公众号头图', width: 1920, height: 1080 },
];

/** 字体栈：与本仓其它模块一致，中文优先落到系统字体上（不联网取字体）。 */
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

/** 图片滤镜的默认值（100 表示不改变，blur/grayscale 用 0 表示不改变）。 */
const DEFAULT_FILTERS = { brightness: 100, contrast: 100, saturate: 100, blur: 0, grayscale: 0 };

/** 滤镜滑块的声明式配置：左栏一次渲染五条，避免五段重复 JSX 各自漂移。 */
const FILTER_FIELDS = [
  { key: 'brightness', label: '亮度', min: 20, max: 180, step: 1, suffix: '%' },
  { key: 'contrast', label: '对比度', min: 20, max: 180, step: 1, suffix: '%' },
  { key: 'saturate', label: '饱和度', min: 0, max: 200, step: 1, suffix: '%' },
  { key: 'blur', label: '模糊', min: 0, max: 20, step: 0.5, suffix: 'px' },
  { key: 'grayscale', label: '黑白', min: 0, max: 100, step: 1, suffix: '%' },
];

/** 字重选项（模板里用到的都在里面，不给任意数值，避免出现浏览器合成字重）。 */
const WEIGHT_OPTIONS = [
  { value: 400, label: '常规 400' },
  { value: 500, label: '中等 500' },
  { value: 600, label: '半粗 600' },
  { value: 700, label: '加粗 700' },
  { value: 800, label: '特粗 800' },
  { value: 900, label: '极粗 900' },
];

/** 模块级自增，只用于拼 id；不碰 DOM，所以模块加载期是安全的。 */
let seq = 0;

/**
 * 生成一个图层 id。
 *
 * 用「类型 + 时间 + 自增」而不是 `Math.random()`：自增保证同一帧内连续新建
 * 也不会重号（撤销栈按 id 找图层，重号会让撤销改错层）。
 *
 * @param {string} type 图层类型
 * @returns {string}
 */
function makeId(type) {
  seq += 1;
  return String(type || 'layer') + '-' + Date.now().toString(36) + '-' + seq;
}

/** 数字兜底：非有限数一律回落，避免 NaN 把画布画成空白。 */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 透明度夹到 [0,1]。 */
function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * 从路径里取文件名（Windows 反斜杠与 POSIX 斜杠都认）。
 *
 * @param {string} p 绝对路径
 * @returns {string} 文件名；解析不出来时返回「图片」
 */
function baseNameOf(p) {
  const s = String(p == null ? '' : p);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '图片';
}

/**
 * 从文件路径里取所在目录（用于「打开文件夹」）。
 *
 * @param {string} p 绝对路径
 * @returns {string} 目录；没有分隔符时返回空串（调用方自己兜底）
 */
function dirNameOf(p) {
  const s = String(p == null ? '' : p);
  const m = s.match(/^(.*)[\\/][^\\/]*$/);
  return m ? m[1] : '';
}

/**
 * 默认文件名：`海报-<yyyyMMdd-HHmmss>.<ext>`。
 *
 * ★ 前缀与时间戳格式**必须与主进程 `posterStore.js` 逐字一致**
 *   （那边不传 filename 时用的就是 `'海报-' + stamp() + '.' + ext`，`stamp()` 是
 *   `yyyyMMdd-HHmmss` 本地时间）。两边各留一套命名，用户会遇到最莫名其妙的一类问题：
 *   界面上显示「海报-20261024-153012.png」、磁盘上却叫「poster-20261024-153012.png」，
 *   他去文件夹里按界面上的名字找，找不到。
 *
 * ★ 不用 ISO 串：Windows 文件名不允许 `:`，转义后反而不如「一眼看出哪天哪秒」。
 *
 * @param {'png'|'jpg'} ext 扩展名
 * @returns {string} 文件名（不含目录）
 */
function defaultFileName(ext) {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const stamp =
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return '海报-' + stamp + '.' + (ext === 'jpg' ? 'jpg' : 'png');
}

/** 深拷贝一份 doc（快照栈必须存副本，否则撤销时拿到的是同一个引用）。 */
function cloneDoc(doc) {
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch (e) {
    return doc;
  }
}

/**
 * 从画布宽高反推比例 key。
 *
 * ★ `ratioKey` 是**派生值**，不是独立来源 —— 它只由 width/height 决定。
 *   之前 `rescaleDoc` 写的是 `ratioKey: next.ratioKey`，而 `CANVAS_PRESETS` 的字段名是
 *   `key`（不是 `ratioKey`）⇒ 每切一次尺寸就把 `ratioKey` 写成 `undefined`，
 *   于是"其它比例会留白"的提示在 3:4 上也一直挂着、尺寸按钮也没有选中态。
 *   这类"字段名对不上"构建和 lint 都看不见，只有把 state 读出来才看得见。
 *
 * @param {number} width 宽
 * @param {number} height 高
 * @param {string} [fallback] 找不到预设时的兜底值
 * @returns {string} 比例 key（如 '3:4'）
 */
function ratioKeyOf(width, height, fallback) {
  const preset = CANVAS_PRESETS.find((p) => p.width === width && p.height === height);
  return preset ? preset.key : String(fallback || '3:4');
}

/** 新建一个空文档。 */
function createDefaultDoc() {
  return {
    width: POSTER_BASE.width,
    height: POSTER_BASE.height,
    ratioKey: '3:4',
    background: '#f6fbf8',
    templateName: '',
    layers: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 绘制层（预览与导出**共用**的唯一一份排版实现）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 滤镜对象 → canvas `ctx.filter` 字符串。
 *
 * @param {object} filters 五个字段（缺省按不改变处理）
 * @returns {string} 形如 `brightness(110%) contrast(95%) blur(2px)`
 */
export function filterCss(filters) {
  const f = filters || {};
  const parts = [];
  parts.push('brightness(' + num(f.brightness, 100) + '%)');
  parts.push('contrast(' + num(f.contrast, 100) + '%)');
  parts.push('saturate(' + num(f.saturate, 100) + '%)');
  const blur = num(f.blur, 0);
  if (blur > 0) parts.push('blur(' + blur + 'px)');
  const gray = num(f.grayscale, 0);
  if (gray > 0) parts.push('grayscale(' + Math.min(100, gray) + '%)');
  return parts.join(' ');
}

/**
 * 圆角矩形路径（自己用 arcTo 画，不依赖 `ctx.roundRect` —— 低版本内核没有）。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文
 * @param {number} x 左上 x
 * @param {number} y 左上 y
 * @param {number} w 宽
 * @param {number} h 高
 * @param {number} r 圆角半径（会被夹到 w/2、h/2）
 */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(num(r, 0), Math.min(w, h) / 2));
  const right = x + w;
  const bottom = y + h;
  ctx.beginPath();
  if (radius <= 0) {
    ctx.moveTo(x, y);
    ctx.lineTo(right, y);
    ctx.lineTo(right, bottom);
    ctx.lineTo(x, bottom);
    ctx.closePath();
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(right - radius, y);
  ctx.arcTo(right, y, right, y + radius, radius);
  ctx.lineTo(right, bottom - radius);
  ctx.arcTo(right, bottom, right - radius, bottom, radius);
  ctx.lineTo(x + radius, bottom);
  ctx.arcTo(x, bottom, x, bottom - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

/**
 * 量一段文字的宽度。
 *
 * ★ canvas 的 `measureText` **不含** `letterSpacing`（`ctx.letterSpacing` 只在绘制时生效），
 *   所以这里手工把字距补上，否则「加了字距的标题」会在 wrap 时算窄、右边溢出。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文（font 必须已设置好）
 * @param {string} text 文本
 * @param {number} spacing 字距（px）
 * @returns {number} 宽度
 */
function measureText(ctx, text, spacing) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const count = Array.from(s).length;
  let width = 0;
  // ★ 口径必须固定，否则原生路径和逐字兜底路径会**断在不同位置**。
  //   实测出处：**本仓自带的 Electron 31.7.7 / Chromium 126.0.6478.234** 里跑
  //   `scripts/tmp-probe/poster/ls-chromium.html`（同一个页面在 Edge 156 上读数完全一致）：
  //   `letterSpacing='2px'` 时 measureText(14 个字) = 598.0234 = 字形宽 570.0234 + 2×14。
  //   即 **ctx.measureText 已经把字距算进去了**（每个字之后都加，含最后一个）。
  //   本函数的约定是"纯字形宽 + 手工补 spacing×(n-1)"，所以测量期间必须把字距临时归零；
  //   不归零就会**多算 spacing×(n-1)**（7 个字 2px 字距多算 12px），
  //   换行提前断、右对齐整体右移，而预览和导出会一起错，构建/单测都看不出来。
  let prevSpacing = null;
  let needRestore = false;
  try {
    if ('letterSpacing' in ctx) {
      prevSpacing = ctx.letterSpacing;
      ctx.letterSpacing = '0px';
      needRestore = true;
    }
  } catch (e) {
    needRestore = false;
  }
  try {
    const m = ctx.measureText ? ctx.measureText(s) : null;
    width = m && Number.isFinite(m.width) ? m.width : 0;
  } catch (e) {
    width = 0;
  } finally {
    if (needRestore) {
      try {
        ctx.letterSpacing = prevSpacing;
      } catch (e) {
        /* 老内核没有这个属性，无需恢复 */
      }
    }
  }
  if (spacing) width += spacing * Math.max(0, count - 1);
  return width;
}

/**
 * 把文本切成「换行单元」：英文/数字连写算一个词，中文按单字，`\n` 是硬换行。
 *
 * 为什么要分词而不是逐字：英文单词被拆成单字换行会变成 `de-ntal` 这种，
 * 门诊的海报上出现一次就够丢人了。
 *
 * @param {string} text 原文
 * @returns {Array<{t: string, br: boolean}>} 单元列表
 */
function tokenizeText(text) {
  const tokens = [];
  let buf = '';
  const isWordChar = /[A-Za-z0-9@#&%.,:;!?'"()\-_/+=~^*$]/;
  for (const ch of Array.from(String(text == null ? '' : text))) {
    if (ch === '\n') {
      if (buf) {
        tokens.push({ t: buf, br: false });
        buf = '';
      }
      tokens.push({ t: '', br: true });
      continue;
    }
    if (isWordChar.test(ch)) {
      buf += ch;
      continue;
    }
    if (buf) {
      tokens.push({ t: buf, br: false });
      buf = '';
    }
    tokens.push({ t: ch, br: false });
  }
  if (buf) tokens.push({ t: buf, br: false });
  return tokens;
}

/** 给一行末尾加省略号（必要时把最后一个字挤掉）。 */
function ellipsizeLine(ctx, line, maxWidth, spacing) {
  const ell = '…';
  let text = String(line == null ? '' : line);
  if (measureText(ctx, text + ell, spacing) <= maxWidth) return text + ell;
  const chars = Array.from(text);
  while (chars.length > 0) {
    chars.pop();
    text = chars.join('');
    if (measureText(ctx, text + ell, spacing) <= maxWidth) return text + ell;
  }
  return ell;
}

/**
 * 按图层宽度自动换行。**预览与导出共用这一个函数**，所以两边断行绝对一致。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文（font 已设置）
 * @param {string} text 原文（支持 `\n` 硬换行）
 * @param {number} maxWidth 图层宽度
 * @param {{letterSpacing?: number, maxLines?: number}} [options] 选项
 * @returns {string[]} 行数组（至少一行）
 */
export function wrapText(ctx, text, maxWidth, options) {
  const limit = num(maxWidth, 320) > 0 ? num(maxWidth, 320) : 320;
  const spacing = num(options && options.letterSpacing, 0);
  const maxLines = num(options && options.maxLines, 0);
  const lines = [];
  let cur = '';

  const pushLine = () => {
    lines.push(cur);
    cur = '';
  };

  for (const tok of tokenizeText(text)) {
    if (tok.br) {
      pushLine();
      continue;
    }
    if (!cur) {
      if (measureText(ctx, tok.t, spacing) <= limit) {
        cur = tok.t;
        continue;
      }
      // 单个 token 比整行还宽 ⇒ 只能逐字硬切（长英文单词 / 长链接会走到这里）
      let chunk = '';
      for (const ch of Array.from(tok.t)) {
        if (chunk && measureText(ctx, chunk + ch, spacing) > limit) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      cur = chunk;
      continue;
    }
    if (measureText(ctx, cur + tok.t, spacing) <= limit) {
      cur += tok.t;
      continue;
    }
    pushLine();
    if (measureText(ctx, tok.t, spacing) > limit) {
      let chunk = '';
      for (const ch of Array.from(tok.t)) {
        if (chunk && measureText(ctx, chunk + ch, spacing) > limit) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      cur = chunk;
    } else {
      cur = tok.t;
    }
  }
  pushLine();

  const cleaned = lines.length ? lines : [''];
  if (maxLines > 0 && cleaned.length > maxLines) {
    const kept = cleaned.slice(0, maxLines);
    kept[maxLines - 1] = ellipsizeLine(ctx, kept[maxLines - 1], limit, spacing);
    return kept;
  }
  return cleaned;
}

/**
 * 画一行带字距的文字（`ctx.letterSpacing` 不可用时的兜底实现）。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文
 * @param {string} text 文本
 * @param {number} anchorX 对齐基准 x
 * @param {number} y 顶部 y
 * @param {number} spacing 字距
 * @param {string} align 对齐方式
 */
function spacedLineLayout(ctx, text, anchorX, spacing, align) {
  const chars = Array.from(String(text == null ? '' : text));
  const widths = chars.map((ch) => {
    try {
      const m = ctx.measureText ? ctx.measureText(ch) : null;
      return m && Number.isFinite(m.width) ? m.width : 0;
    } catch (e) {
      return 0;
    }
  });
  const glyphSum = widths.reduce((a, b) => a + b, 0);
  // inkWidth：墨迹宽度（最后一个字之后没有字距）
  const inkWidth = glyphSum + spacing * Math.max(0, chars.length - 1);
  // advance：**原生 ctx.letterSpacing 的推进量口径**。Electron 31 / Chromium 126 实测
  //   measureText(N 个字) = Σ字形宽 + spacing×N —— 尾随那个字距也算进去了。
  //   对齐必须用 advance（不是 inkWidth）：用 inkWidth 居中会往右偏 spacing/2，
  //   右对齐会往右偏 spacing。漏掉的这半格/一格是**真量出来的**，不是推的：
  //   修前把 inkWidth 当对齐宽度，48px 字 2px 字距下墨迹包围盒
  //   left dxMinX=0 / center **+1** / right **+2**（正数=兜底比原生往右）。
  //   改完后同页面重跑：left 0 / center 0 / right 0，逐像素 diffPixels=0。
  const advance = glyphSum + spacing * chars.length;
  let startX = anchorX;
  if (align === 'center') startX = anchorX - advance / 2;
  else if (align === 'right') startX = anchorX - advance;
  const xs = [];
  let cursor = startX;
  for (let i = 0; i < chars.length; i += 1) {
    xs.push(cursor);
    cursor += widths[i] + spacing;
  }
  // endX = 最后一个字的右边缘（墨迹终点），和 advance 差一个尾随字距，两个量都要能对账
  return { chars, widths, xs, startX, endX: startX + inkWidth, inkWidth, advance };
}

/**
 * 画一行带字距的文字（`ctx.letterSpacing` 不可用时的兜底实现）。
 *
 * ★ 布局计算全部在 `spacedLineLayout()` 里，这里只负责画。
 *   抽出去的理由：兜底路径在 Chromium 126（本仓 Electron 31）上**永远不会自然触发**
 *   —— `ctx.letterSpacing` 从 Chrome 99 起就原生支持。没被执行过的分支等于没写，
 *   所以要能强制触发、并且要能和原生路径对账。对账需要"每个字的 x 在哪"，
 *   而原生路径只发一次 fillText（逐字 x 观测不到）⇒ 唯一的可比量是**整行推进量**，
 *   由 `spacedLineLayout().advance / endX` 提供。
 *
 * 【怎么在本机把真 Electron 起起来】（踩过一次，记下来省下一个人两小时）
 *   直接 `electron.exe <script>` 报 `ERR_FAILED (-2)` 或立刻 SIGTERM **不是
 *   "这台机器开不了 Electron"**，而是启动姿势不对。必须：
 *     · 清掉 `ELECTRON_RUN_AS_NODE`（=1 时 Electron 退化成纯 node，根本不建 BrowserWindow）
 *     · 清掉 `http_proxy/https_proxy/HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（本机系统代理会拦 127.0.0.1）
 *     · 清掉 `NODE_OPTIONS`（宿主注入的 --require 会让主进程提前炸）
 *     · 带 `--no-sandbox`、独立 `--user-data-dir=<临时目录>`（否则和正开着的豆芽抢单实例锁）
 *     · 带 `--no-proxy-server --proxy-bypass-list=*`
 *   照这一套，本仓 `node_modules/electron`（31.7.7 / Chromium 126）能正常起窗口——
 *   `scripts/verify/poster-in-douya-gui.mjs` 与 `scripts/tmp-probe/poster/ls-electron.mjs`
 *   都是这么起的。要真内核证据优先用 Electron 31，别拿系统浏览器替代。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文
 * @param {string} text 文本
 * @param {number} anchorX 对齐基准 x
 * @param {number} y 顶部 y
 * @param {number} spacing 字距
 * @param {string} align 对齐方式
 */
function drawSpacedLine(ctx, text, anchorX, y, spacing, align) {
  const layout = spacedLineLayout(ctx, text, anchorX, spacing, align);
  // 逐字绘制时 textAlign 必须回到 left，否则每个字自己会被二次对齐
  ctx.textAlign = 'left';
  for (let i = 0; i < layout.chars.length; i += 1) {
    ctx.fillText(layout.chars[i], layout.xs[i], y);
  }
}

/**
 * 字距兜底开关（**只给测试用**）。
 *
 * 为什么要它：`ctx.letterSpacing` 从 Chrome 99 起原生支持，本仓 Electron 31 对应
 * Chromium 126 ⇒ 逐字绘制那条兜底在真机上**永远不会自然执行**。没执行过的分支等于没写。
 * 这个开关让它能被强制走一遍，与原生路径对账（`scripts/tmp-probe/poster/ls-real.html`
 * 在 Electron 31.7.7 里跑真模块：3 对齐 × 2 scale × 2 forExport = 12 组位图逐像素相减，
 * diffPixels 全 0）。
 *
 * 为什么用 window 全局而不是塞进 `drawPoster` 的 `opts`：`opts` 只允许有一个分叉点
 * （见 drawPoster 的注释）。多一个键就多一个"以后有人顺手在这里分叉排版"的入口。
 */
function forceLetterSpacingFallback() {
  try {
    return typeof window !== 'undefined' && window.__POSTER_FORCE_LS_FALLBACK === true;
  } catch (e) {
    return false;
  }
}

/**
 * 画文字图层（自动换行 + 行高 + 字距 + 三种对齐）。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文
 * @param {object} layer 文字图层
 */
function drawTextLayer(ctx, layer) {
  const fontSize = Math.max(6, num(layer.fontSize, 32));
  const weight = num(layer.weight, 600);
  const lineHeight = Math.max(0.8, num(layer.lineHeight, 1.4));
  const spacing = num(layer.letterSpacing, 0);
  const align = layer.align === 'center' ? 'center' : layer.align === 'right' ? 'right' : 'left';
  const width = Math.max(8, num(layer.w, 200));
  const x = num(layer.x, 0);
  const y = num(layer.y, 0);

  ctx.font = String(weight) + ' ' + fontSize + 'px ' + FONT_STACK;
  ctx.textBaseline = 'top';
  ctx.fillStyle = layer.color || '#123328';
  ctx.textAlign = align;

  // Chromium 99+ 支持 ctx.letterSpacing；不支持就退回逐字绘制。
  // forced：测试开关，强制走兜底（见 forceLetterSpacingFallback 的注释）。
  const forced = forceLetterSpacingFallback();
  let nativeSpacing = false;
  try {
    if (!forced && 'letterSpacing' in ctx) {
      ctx.letterSpacing = String(spacing) + 'px';
      nativeSpacing = true;
    }
  } catch (e) {
    nativeSpacing = false;
  }

  const anchorX = align === 'left' ? x : align === 'center' ? x + width / 2 : x + width;
  const lines = wrapText(ctx, layer.text, width, { letterSpacing: spacing, maxLines: num(layer.maxLines, 0) });
  const step = fontSize * lineHeight;

  for (let i = 0; i < lines.length; i += 1) {
    const lineY = y + i * step;
    if (spacing && !nativeSpacing) {
      drawSpacedLine(ctx, lines[i], anchorX, lineY, spacing, align);
    } else {
      ctx.fillText(lines[i], anchorX, lineY);
    }
  }
}

/**
 * 画形状图层（圆角矩形 / 圆形都用它，radius 给到 w/2 就是圆的）。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文
 * @param {object} layer 形状图层
 */
function drawShapeLayer(ctx, layer) {
  ctx.fillStyle = layer.fill || '#1f7a4d';
  roundRectPath(ctx, num(layer.x, 0), num(layer.y, 0), num(layer.w, 0), num(layer.h, 0), num(layer.radius, 0));
  ctx.fill();
}

/**
 * 画「空图占位符」：虚线轮廓 + 中心说明文字。
 *
 * 【只在预览画，导出绝不画】
 *   占位符是给「还没放图」的人看的提示。它一旦被写进导出图，用户拿到的就是一张
 *   带虚线框和「放医生照片」五个字的海报 —— 那是废图。所以这个函数**只能**在
 *   `opts.forExport !== true` 时被调用（调用点在 drawImageLayer 里）。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文
 * @param {object} layer 图片图层（空 src）
 */
function drawPlaceholder(ctx, layer) {
  const x = num(layer.x, 0);
  const y = num(layer.y, 0);
  const w = Math.max(1, num(layer.w, 1));
  const h = Math.max(1, num(layer.h, 1));
  const radius = num(layer.radius, 0);
  const label = String(layer.placeholderLabel || '放图片');
  const short = Math.min(w, h);
  const fontSize = Math.max(10, Math.min(80, Math.round(short * 0.11)));

  ctx.save();
  try {
    ctx.fillStyle = 'rgba(31, 122, 77, 0.06)';
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.fill();
    ctx.strokeStyle = 'rgba(31, 122, 77, 0.55)';
    ctx.lineWidth = Math.max(1, Math.round(short * 0.012));
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([Math.max(4, short * 0.05), Math.max(3, short * 0.035)]);
    roundRectPath(ctx, x, y, w, h, radius);
    if (typeof ctx.stroke === 'function') ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(31, 122, 77, 0.85)';
    ctx.font = '600 ' + fontSize + 'px ' + FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
  } finally {
    ctx.restore();
  }
}

/**
 * 画图片图层（cover / contain + 圆角裁切 + 滤镜）。
 *
 * 【图片还没解码完时故意什么都不画】
 *   如果先画一个占位灰块，导出时那一块会被写进 PNG —— 用户拿到一张带灰块的海报。
 *   宁可空着（下一秒 onload 会触发重绘）。
 *
 * 【空 src + placeholder 图层：只有预览画虚线占位，导出什么都不画】
 *   这是 `opts.forExport` 唯一被允许影响的绘制行为，边界见 drawPoster 的注释。
 *
 * @param {CanvasRenderingContext2D} ctx 上下文
 * @param {object} layer 图片图层
 * @param {{forExport?: boolean}} opts 绘制选项
 */
function drawImageLayer(ctx, layer, opts) {
  const box = {
    x: num(layer.x, 0),
    y: num(layer.y, 0),
    w: Math.max(1, num(layer.w, 1)),
    h: Math.max(1, num(layer.h, 1)),
  };
  const radius = num(layer.radius, 0);

  // 空 src：预览画占位提示，导出**一个像素都不画**（否则虚线框会被写进用户的海报）
  if (typeof layer.src !== 'string' || !layer.src) {
    const forExport = !!(opts && opts.forExport);
    if (layer.placeholder && !forExport) drawPlaceholder(ctx, layer);
    return;
  }

  ctx.save();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, radius);
  ctx.clip();

  const img = peekImage(layer.src);
  if (img) {
    const iw = num(img.naturalWidth, 0) || num(img.width, 0);
    const ih = num(img.naturalHeight, 0) || num(img.height, 0);
    if (iw > 0 && ih > 0) {
      try {
        ctx.filter = filterCss(layer.filters);
      } catch (e) {
        /* 老内核不支持 filter，退化成原图（不阻断绘制） */
      }
      const fit = layer.fit === 'contain' ? 'contain' : 'cover';
      const factor = fit === 'cover' ? Math.max(box.w / iw, box.h / ih) : Math.min(box.w / iw, box.h / ih);
      const dw = iw * factor;
      const dh = ih * factor;
      const dx = box.x + (box.w - dw) / 2;
      const dy = box.y + (box.h - dh) / 2;
      try {
        ctx.drawImage(img, dx, dy, dw, dh);
      } catch (e) {
        /* 图片坏掉不该让整张海报画不出来 */
      }
      try {
        ctx.filter = 'none';
      } catch (e) {
        /* ignore */
      }
    }
  }
  ctx.restore();
}

/**
 * 把整份文档画到任意 2D 上下文里。**回退路径的排版真相**（默认路径是 `src/poster/`，
 * 由 `posterRenderSwitch.js` 选；下面这条 `opts` 边界对新引擎同样成立）。
 *
 * ★★★ `opts` 的边界（改动前先读这一段）★★★
 *   `opts` 里**只允许有一个键**：`forExport`。它**只**决定一件事 ——
 *   空 `src` 的占位图层（模板里的「放医生照片」虚线框）画不画。
 *     · 预览：`forExport: false` ⇒ 画虚线占位，用户知道这里要放图
 *     · 导出：`forExport: true`  ⇒ 不画，否则虚线框和提示文字会被写进成品
 *
 *   **禁止**用它分叉任何排版计算（换行 / 行高 / 字距 / 对齐 / 图片裁切 / 坐标）。
 *   这个函数之所以能保证「预览和导出逐像素一致」，唯一原因就是两边跑的是同一段代码、
 *   只差 scale。一旦有人往 opts 里加第二个分叉点 —— 哪怕只是"导出时字号小 0.5" ——
 *   「预览好看、导出错位」这个口子就重新打开了，而那类 bug 在构建、lint、单测里
 *   全都看不见，只能等用户拿到图才发现。
 *   确需新增分叉的，先说明为什么不能放进图层字段（图层字段两边都读，是安全的位置）。
 *
 * @param {CanvasRenderingContext2D} ctx 目标上下文（画布尺寸需自行按 scale 开好）
 * @param {object} doc 文档 state
 * @param {number} scale 缩放比（预览 = 显示宽×dpr/画布宽；导出 = 2）
 * @param {{forExport?: boolean}} [opts] 只允许 `forExport` 一个键，见上
 * @returns {boolean} 是否真的画了（ctx 不可用时返回 false）
 */
export function drawPoster(ctx, doc, scale, opts) {
  if (!ctx || !doc || !Array.isArray(doc.layers)) return false;
  const width = Math.max(1, Math.round(num(doc.width, POSTER_BASE.width)));
  const height = Math.max(1, Math.round(num(doc.height, POSTER_BASE.height)));
  const factor = num(scale, 1) > 0 ? num(scale, 1) : 1;
  ctx.save();
  try {
    if (typeof ctx.setTransform === 'function') ctx.setTransform(factor, 0, 0, factor, 0, 0);
    if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = doc.background || '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const ordered = doc.layers.slice().sort((a, b) => num(a.z, 0) - num(b.z, 0));
    for (const layer of ordered) {
      if (!layer || layer.hidden) continue;
      const alpha = clamp01(layer.opacity, 1);
      if (alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      try {
        if (layer.type === 'shape') drawShapeLayer(ctx, layer);
        else if (layer.type === 'image') drawImageLayer(ctx, layer, opts);
        else drawTextLayer(ctx, layer);
      } finally {
        ctx.restore();
      }
    }
  } finally {
    ctx.restore();
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 图片解码缓存（预览重绘与导出都要用）
// ─────────────────────────────────────────────────────────────────────────────

/** src → HTMLImageElement（已解码成功才会放进来）。 */
const imageCache = new Map();
/** src → Promise，防止同一张图并发解码多次。 */
const imagePending = new Map();

/** 同步取一张已经解码好的图（没解码好返回 null）。**导出**给 posterRenderSwitch.js：
 *  新引擎同步 resolveImage 只能读这一份缓存（两份的话预览看得见图、导出时不见）。 */
export function peekImage(src) {
  return imageCache.get(String(src)) || null;
}

/**
 * 确保一张图解码完成。超时 / 失败都 resolve(null)，**绝不 reject**
 * —— 一张图坏了不该让导出整体失败。
 *
 * @param {string} src dataUrl
 * @returns {Promise<HTMLImageElement|null>}
 */
function ensureImage(src) {
  const key = String(src == null ? '' : src);
  if (!key) return Promise.resolve(null);
  if (imageCache.has(key)) return Promise.resolve(imageCache.get(key));
  if (imagePending.has(key)) return imagePending.get(key);
  if (typeof window === 'undefined' || typeof window.Image !== 'function') return Promise.resolve(null);

  const task = new Promise((resolve) => {
    let done = false;
    const finish = (img) => {
      if (done) return;
      done = true;
      imagePending.delete(key);
      if (img) imageCache.set(key, img);
      resolve(img || null);
    };
    let img = null;
    try {
      img = new window.Image();
    } catch (e) {
      finish(null);
      return;
    }
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    try {
      img.src = key;
    } catch (e) {
      finish(null);
      return;
    }
    // 解码超时兜底（jsdom / 坏图 / 超大图）
    setTimeout(() => finish(null), IMAGE_LOAD_TIMEOUT_MS);
  });
  imagePending.set(key, task);
  return task;
}

/** 建一个离屏 canvas（渲染层唯一允许的"文件"来源是 dataUrl，不碰磁盘）。**导出**给
 *  `posterRenderSwitch.js` 的回退路径用 —— 同一个函数、同一套行为。 */
export function createCanvasEl(width, height) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * 把一个模板图层补齐成完整图层模型（模板里可以省字段，但 state 里不行）。
 *
 * @param {object} src 模板 / 外部来源图层
 * @param {number} index 序号（用来兜底 z）
 * @param {(type: string) => string} idFactory id 生成器
 * @returns {object} 完整图层
 */
function normalizeLayer(src, index, idFactory) {
  const type = src && src.type === 'image' ? 'image' : src && src.type === 'shape' ? 'shape' : 'text';
  const out = {
    id: src && src.id ? String(src.id) : idFactory(type),
    type,
    name: src && src.name ? String(src.name) : type === 'text' ? '文字' : type === 'shape' ? '形状' : '图片',
    x: Math.round(num(src && src.x, 0)),
    y: Math.round(num(src && src.y, 0)),
    w: Math.max(8, Math.round(num(src && src.w, 200))),
    h: Math.max(8, Math.round(num(src && src.h, 100))),
    opacity: clamp01(src && src.opacity, 1),
    z: num(src && src.z, index + 1),
    hidden: !!(src && src.hidden),
  };
  if (type === 'text') {
    out.text = String((src && src.text) == null ? '' : src.text);
    out.fontSize = Math.max(6, Math.round(num(src && src.fontSize, 32)));
    out.color = (src && src.color) || '#123328';
    out.weight = num(src && src.weight, 600);
    out.align = src && src.align === 'center' ? 'center' : src && src.align === 'right' ? 'right' : 'left';
    out.lineHeight = Math.max(0.8, num(src && src.lineHeight, 1.4));
    out.letterSpacing = num(src && src.letterSpacing, 0);
    out.maxLines = num(src && src.maxLines, 0);
  } else if (type === 'image') {
    out.src = String((src && src.src) || '');
    out.fit = src && src.fit === 'contain' ? 'contain' : 'cover';
    out.radius = Math.max(0, Math.round(num(src && src.radius, 0)));
    out.filters = Object.assign({}, DEFAULT_FILTERS, (src && src.filters) || {});
    // 占位标记必须活着穿过 normalizeLayer：套模板走的就是这条路，
    // 丢了它模板里的「放医生照片」虚线框既不显示、也没法被 importFromPath 填充。
    out.placeholder = !!(src && src.placeholder);
    out.placeholderLabel = String((src && src.placeholderLabel) || '放图片');
  } else {
    out.fill = (src && src.fill) || '#1f7a4d';
    out.radius = Math.max(0, Math.round(num(src && src.radius, 0)));
  }
  return out;
}

/** 把一份文档补齐（保存项目读回来时可能缺字段）。 */
function normalizeDoc(src) {
  const doc = src && typeof src === 'object' ? src : {};
  const width = num(doc.width, POSTER_BASE.width) > 0 ? Math.round(num(doc.width, POSTER_BASE.width)) : POSTER_BASE.width;
  const height = num(doc.height, POSTER_BASE.height) > 0 ? Math.round(num(doc.height, POSTER_BASE.height)) : POSTER_BASE.height;
  const layers = Array.isArray(doc.layers) ? doc.layers.map((l, i) => normalizeLayer(l, i, makeId)) : [];
  return {
    width,
    height,
    ratioKey: ratioKeyOf(width, height, doc.ratioKey),
    background: doc.background || '#f6fbf8',
    templateName: doc.templateName ? String(doc.templateName) : '',
    layers,
  };
}

/**
 * 按新画布尺寸等比重算所有图层（**不清空、不重排**）。
 *
 * @param {object} doc 旧文档
 * @param {{width:number, height:number, ratioKey:string}} next 新尺寸
 * @returns {object} 新文档
 */
function rescaleDoc(doc, next) {
  const sx = num(next.width, doc.width) / Math.max(1, doc.width);
  const sy = num(next.height, doc.height) / Math.max(1, doc.height);
  const fontScale = Math.max(0.4, Math.min(sx, sy));
  const layers = (doc.layers || []).map((l) => {
    const out = Object.assign({}, l, {
      x: Math.round(num(l.x, 0) * sx),
      y: Math.round(num(l.y, 0) * sy),
      w: Math.max(8, Math.round(num(l.w, 8) * sx)),
      h: Math.max(8, Math.round(num(l.h, 8) * sy)),
    });
    if (l.type === 'text') out.fontSize = Math.max(14, Math.round(num(l.fontSize, 32) * fontScale));
    if (l.type === 'image' || l.type === 'shape') out.radius = Math.round(num(l.radius, 0) * Math.min(sx, sy));
    return out;
  });
  const nextW = Math.round(next.width);
  const nextH = Math.round(next.height);
  return Object.assign({}, doc, {
    width: nextW,
    height: nextH,
    // 按**尺寸**推导，不读 next.ratioKey：调用方传的是 CANVAS_PRESETS 项（字段名是 key）
    ratioKey: ratioKeyOf(nextW, nextH, next.ratioKey || next.key || doc.ratioKey),
    layers,
  });
}

/**
 * 把 `file:pick` 的返回值归一成 `[{path, name}]`。
 *
 * ★ 主进程 `main.js:161` 的 `file:pick` 返回的是 **`{ canceled, filePaths: string[] }`**
 *   （不是 `files: [{path}]`）。早期版本这里读的是 `res.files`，于是「导入图片」按钮
 *   永远拿不到路径、永远弹「没有选中图片」—— 一个形状猜错就整条链路废掉。
 *   两种形状都认，是因为别处（wanxPickMedia）给的是对象数组，混用时不再出事。
 *
 * @param {any} res IPC 返回值
 * @returns {Array<{path: string, name: string}>}
 */
function pickPathsOf(res) {
  if (!res || res.canceled === true) return [];
  const out = [];
  if (Array.isArray(res.filePaths)) {
    for (const p of res.filePaths) {
      if (typeof p === 'string' && p) out.push({ path: p, name: baseNameOf(p) });
    }
  }
  if (Array.isArray(res.files)) {
    for (const f of res.files) {
      if (!f) continue;
      const p = typeof f === 'string' ? f : f.path;
      if (typeof p === 'string' && p) out.push({ path: p, name: f.name || baseNameOf(p) });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 占位拦截：企业名自动填充 + 导出前守门
// ─────────────────────────────────────────────────────────────────────────────
//
// 【要修的缺陷是什么】
//   模板里的文案是硬编码原型：`XX 口腔`（4 处）、`400-000-0000`（6 处）、
//   `XX 路 88 号`、`X 号线`、`X 站`。用户真实动线是「选模板 → 改几个字 → 导出」，
//   漏改一处，导出的就是废图 —— 图上门诊名印着「XX 口腔」、电话印着 400-000-0000。
//   这类废图**不报错**，用户往往发完朋友圈才被顾客指出来。
//
// 【为什么只做「填充 + 拦截」两层，不做「全都自动填」】
//   企业资料的唯一来源是 `useCompany().currentCompany`，而它**只有**
//   `id / name / type / role / workspaceId / createdAt`（companyStore.jsx 的
//   normalizeCompany / createCompany）—— **没有电话、没有地址**。
//   所以：
//     · **公司名**能真填 ⇒ `applyTemplate()` 时用 `currentCompany.name` 替换「XX 口腔」；
//     · **电话 / 地址 / 地铁站**没有数据源 ⇒ 不猜、不编，改为在导出前**显式拦住**用户，
//       点名是哪几个文字层、原文是什么，由用户决定「去修改」还是「仍要导出」。
//   这条规则是老板定的：外部硬限制导致的简化是合法降级，无阻碍地丢一张空壳是不合格。
//
// 【三条导出路径全部拦】（漏一条等于没修）
//   ① 右栏「导出图片」/ ② 右栏「另存为…」—— 都走 `handleExport()`，命中占位时先弹确认；
//   ③ `window.__posterTest.exportTo()`（豆芽 Agent 用的自动化出口）—— 走 `exportTo()`，
//      命中占位时 **throw** 一个带 `code:'PLACEHOLDER_PENDING'` + `placeholders` 的错误，
//      Agent 拿到结构化读数才能决定"改文案"还是显式强导（`{allowPlaceholders:true}`），
//      而不是静默收到一张废图。

/**
 * 读当前企业名（拿不到就空串）。
 *
 * 为什么不直接 `useCompany().currentCompany.name`：
 *   `useCompany()` 在没有 `<CompanyProvider>` 的子树里会 **throw**
 *   （companyStore.jsx：“useCompany 必须在 <CompanyProvider> 子树内使用”）。
 *   生产路径上 PosterStudio 一定在 Provider 里（renderer/index.jsx 的根树），
 *   但 jsdom 单测 / 独立挂载没有 Provider。为了这种情形白屏不值得
 *   ⇒ 吃掉这个异常、兜成空串，走「没有真名 ⇒ 不填充 ⇒ 交给导出前拦截」那条路。
 *
 * ⚠️ `useCompany()` 本身是**无条件调用**的（hook 顺序不变），只是把它的异常兜住；
 *    绝不能写成 `if (有 Provider) useCompany()` —— 那是条件调用 hook，会让 React 崩。
 *
 * @returns {string} 可印刷的企业名；空串 = 没有可用的真名（不填充）
 */
function useCompanyDisplayName() {
  try {
    const ctx = useCompany();
    const company = ctx && ctx.currentCompany ? ctx.currentCompany : null;
    return cleanCompanyName(company && company.name);
  } catch (err) {
    // 没有 Provider（单测 / 独立挂载）：没有真名可用，走拦截路径，不白屏。
    return '';
  }
}

/**
 * 命中列表 → 给人看的一段话。弹窗与常驻提示共用同一套措辞，
 * 免得两处说法不一致（用户在两个地方看到两种描述会以为不是一个问题）。
 *
 * @param {Array<{layerName:string, text:string}>} hits `findPlaceholderTexts()` 的返回值
 * @returns {string} 每行一条：「1. 「门店地址」：XX 口腔 · XX 路 88 号…」
 */
function describePlaceholderHits(hits) {
  const list = Array.isArray(hits) ? hits : [];
  return list
    .map((hit, i) => (i + 1) + '. 「' + hit.layerName + '」：'
      + String(hit.text == null ? '' : hit.text).replace(/\n/g, ' / '))
    .join('\n');
}

/**
 * 造一个带结构化字段的「还有占位没改」错误（给自动化出口用）。
 *
 * 为什么要在 Error 上挂字段：`window.__posterTest.exportTo()` 的调用方是 Agent / 脚本，
 * 它需要**机器可读**的读数（哪几层、原文是什么）才能自己决定下一步。
 * 只回一句中文错误消息，Agent 只能重试或放弃 —— 而重试会得到同一张废图。
 *
 * @param {Array<{layerId:string, layerName:string, text:string, matched:string[]}>} hits 命中列表
 * @returns {Error & {code:string, placeholders:Array<object>}}
 */
function makePlaceholderError(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const names = list.map((hit) => hit.layerName).join('、');
  const err = new Error('导出已拦下：还有 ' + list.length + ' 处模板占位没改（' + names + '）。'
    + '改完再导出，或显式传 { allowPlaceholders: true } 强制导出。');
  err.code = 'PLACEHOLDER_PENDING';
  err.placeholders = list;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 海报编辑器。
 *
 * @param {{mediaDir?: string}} props
 *   `mediaDir`：作品目录（视频设计页已经拿到的那一份），只用于在导出区
 *   告诉用户「默认存到 <目录>/posters/」。真正落盘由主进程决定。
 */
export default function PosterStudio({ mediaDir }) {
  // ── 文档 / 历史 ───────────────────────────────────────────────────────────
  const [doc, setDoc] = useState(() => createDefaultDoc());
  const docRef = useRef(doc);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  // 历史栈放在 ref 里（快照不能触发重渲染），用版本号驱动按钮的 disabled。
  const [histVersion, setHistVersion] = useState(0);

  // ── 交互态 ───────────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState('');
  const [notice, setNotice] = useState(null); // { type:'info'|'warning'|'error'|'success', text:string }
  const [busy, setBusy] = useState(''); // 非空时表示正在做某件事（导出/导入…）
  const [exportInfo, setExportInfo] = useState(null); // { path, bytes, sha1, ext }
  const [fmt, setFmt] = useState('png');
  const [projects, setProjects] = useState([]);
  const [projectName, setProjectName] = useState('');
  const [stageSize, setStageSize] = useState({ w: 560, h: 747 });
  const [imgVersion, setImgVersion] = useState(0); // 图片解码完成后 +1，触发重绘
  const [canvasBroken, setCanvasBroken] = useState(false);

  const stageWrapRef = useRef(null);
  const canvasRef = useRef(null);
  const gestureRef = useRef(null);
  /** 右栏图层列表容器（「去修改」时把问题层滚进视野用）。 */
  const layerListRef = useRef(null);
  /** 左栏「文字内容」输入框（「去修改」时把焦点落到要改的那一行）。 */
  const textAreaRef = useRef(null);

  /**
   * 当前企业名。**只用于填充企业名占位**，不参与排版。
   * 空串 = 没有可用的真名（没有 Provider / 企业还没起名）⇒ 不填充，交给导出前拦截。
   */
  const companyName = useCompanyDisplayName();

  /**
   * 当前文档里仍然含模板占位的文字层。
   *
   * 这是一条**活的**读数：图层一改就重算，所以右栏那条黄色提示会随着用户改字实时消失
   * —— 用户不用点导出才知道改没改完。导出前的拦截也复用同一份判定（同一个纯函数），
   * 不允许出现「提示说没了、导出又拦」这种两套判据不一致的情况。
   */
  const placeholderHits = useMemo(() => findPlaceholderTexts(doc.layers), [doc.layers]);

  /** 当前选中的图层（找不到就返回 null，UI 一律判空）。 */
  const selected = useMemo(() => doc.layers.find((l) => l.id === selectedId) || null, [doc.layers, selectedId]);

  // ── IPC 封装 ─────────────────────────────────────────────────────────────
  /**
   * 调主进程 IPC。通道缺失时返回一个**带标记的 reject**，调用方统一转成
   * 「需要更新到新版」的提示。
   *
   * @param {string} channel 通道名
   * @param {...any} args 参数
   * @returns {Promise<any>}
   */
  const invoke = useCallback((channel, ...args) => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.invoke !== 'function') {
      const err = new Error('需要更新到新版');
      err.code = 'NO_IPC';
      return Promise.reject(err);
    }
    try {
      return Promise.resolve(api.invoke(channel, ...args));
    } catch (e) {
      return Promise.reject(e);
    }
  }, []);

  /**
   * 统一把 IPC 异常翻成一句人话。
   *
   * @param {any} e 异常
   * @param {string} fallback 兜底文案
   * @returns {string}
   */
  const explain = useCallback((e, fallback) => {
    if (e && e.code === 'NO_IPC') return '需要更新到新版：这一版还没有「海报」的导出通道，升级后再试。';
    const msg = e && e.message ? String(e.message) : '';
    return msg || fallback;
  }, []);

  // ── 提交 / 历史 ───────────────────────────────────────────────────────────
  /**
   * 应用一次 state 变更。**任何会改变画面的操作都必须走这里**（这样才自动进撤销栈）。
   *
   * `options.history === false` 只给「拖拽过程中的实时位移」用：
   * 手势开始时已把快照压栈，过程中的每一帧不应各自压一条。
   *
   * @param {object|Function} updater 新文档，或 (prev) => 新文档
   * @param {{history?: boolean}} [options] 选项
   * @returns {object} 应用后的文档
   */
  const commit = useCallback((updater, options) => {
    const prev = docRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (!next || next === prev) return prev;
    if (!options || options.history !== false) {
      undoRef.current = undoRef.current.concat([prev]).slice(-HISTORY_DEPTH);
      redoRef.current = [];
      setHistVersion((v) => v + 1);
    }
    docRef.current = next;
    setDoc(next);
    return next;
  }, []);

  /** 撤销。返回是否真的撤销了一步。 */
  const undo = useCallback(() => {
    const stack = undoRef.current;
    if (!stack.length) return false;
    const prev = stack[stack.length - 1];
    undoRef.current = stack.slice(0, -1);
    redoRef.current = redoRef.current.concat([docRef.current]).slice(-HISTORY_DEPTH);
    docRef.current = prev;
    setDoc(prev);
    setHistVersion((v) => v + 1);
    return true;
  }, []);

  /** 重做。返回是否真的重做了一步。 */
  const redo = useCallback(() => {
    const stack = redoRef.current;
    if (!stack.length) return false;
    const next = stack[stack.length - 1];
    redoRef.current = stack.slice(0, -1);
    undoRef.current = undoRef.current.concat([docRef.current]).slice(-HISTORY_DEPTH);
    docRef.current = next;
    setDoc(next);
    setHistVersion((v) => v + 1);
    return true;
  }, []);

  // ── 图层操作 ─────────────────────────────────────────────────────────────
  /**
   * 改一个图层。
   *
   * @param {string} id 图层 id
   * @param {object} patch 要合并的字段
   * @param {{history?: boolean}} [options] 选项
   */
  const patchLayer = useCallback(
    (id, patch, options) => {
      const key = String(id == null ? '' : id);
      if (!key || !patch) return;
      commit((prev) => {
        let hit = false;
        const layers = prev.layers.map((l) => {
          if (l.id !== key) return l;
          hit = true;
          return Object.assign({}, l, patch);
        });
        return hit ? Object.assign({}, prev, { layers }) : prev;
      }, options);
    },
    [commit]
  );

  /** 删除图层。删空也允许（画布会显示「先挑一个模板」的提示，不会剩一张莫名其妙的空白）。 */
  const removeLayer = useCallback(
    (id) => {
      const key = String(id == null ? '' : id);
      commit((prev) => {
        const layers = prev.layers.filter((l) => l.id !== key);
        if (layers.length === prev.layers.length) return prev;
        return Object.assign({}, prev, { layers: layers.map((l, i) => Object.assign({}, l, { z: i + 1 })) });
      });
      if (selectedId === key) setSelectedId('');
    },
    [commit, selectedId]
  );

  /**
   * 图层上下移（z 轴重排）。
   *
   * @param {string} id 图层 id
   * @param {number} delta +1 往前（更靠上），-1 往后
   */
  const moveLayerZ = useCallback(
    (id, delta) => {
      const key = String(id == null ? '' : id);
      commit((prev) => {
        const ordered = prev.layers.slice().sort((a, b) => num(a.z, 0) - num(b.z, 0));
        const index = ordered.findIndex((l) => l.id === key);
        const target = index + (delta > 0 ? 1 : -1);
        if (index < 0 || target < 0 || target >= ordered.length) return prev;
        const swapped = ordered.slice();
        const tmp = swapped[index];
        swapped[index] = swapped[target];
        swapped[target] = tmp;
        return Object.assign({}, prev, { layers: swapped.map((l, i) => Object.assign({}, l, { z: i + 1 })) });
      });
    },
    [commit]
  );

  /** 显隐切换。 */
  const toggleHidden = useCallback(
    (id) => {
      const layer = docRef.current.layers.find((l) => l.id === id);
      if (!layer) return;
      patchLayer(id, { hidden: !layer.hidden });
    },
    [patchLayer]
  );

  // ── 模板 ─────────────────────────────────────────────────────────────────
  /**
   * 一键套用模板。套用后所有字段仍可改（模板不是锁死的）。
   *
   * 【企业名在这里填，不在模板文件里填】
   *   `POSTER_TEMPLATES` 里的 `XX 口腔` 是**原型**：模板文件不写死任何真实企业名，
   *   也不把 store 逻辑塞进去（那会让模板数据依赖 React 上下文）。
   *   填充发生在"套用"这一瞬间：拿当前企业名把「XX 口腔」整段换掉，
   *   剩下填不动的（电话 / 地址 / 地铁站）由导出前拦截点名。
   *
   *   ⚠️ 换企业后已套用的海报不会自动跟着改名（图层是用户的东西，不能偷偷改）。
   *      想看新名字，再点一次同一套模板即可。
   *
   * @param {string} name 模板名
   * @returns {boolean} 是否套用成功
   */
  const applyTemplate = useCallback(
    (name) => {
      const tpl = findTemplate(name);
      if (!tpl) {
        setNotice({ type: 'warning', text: '没有这套模板：' + String(name || '（空）') });
        return false;
      }
      const prev = docRef.current;
      // ① 模板 → 图层（坐标按当前画布缩放）
      // ② 企业名填充（没有真名时 fillCompanyNameInLayers 原样返回，一个字符都不动）
      // ③ normalizeLayer 补默认字段
      const layers = fillCompanyNameInLayers(
        templateToLayers(tpl.name, { width: prev.width, height: prev.height }, makeId),
        companyName
      ).map((l, i) => normalizeLayer(l, i, makeId));
      // 模板里图片层带的是空 src，不需要预解码
      commit(Object.assign({}, prev, { background: tpl.palette.bg, templateName: tpl.name, layers }));
      setSelectedId(layers.length ? layers[0].id : '');
      // 填了名字就说一声；没填（没有企业资料）也如实说，不要让用户以为已经填好了
      if (companyName) {
        setNotice({ type: 'info', text: '已套用「' + tpl.name + '」，企业名自动填成了「' + companyName + '」，其余文字改完再导出。' });
      } else {
        setNotice({
          type: 'warning',
          text: '已套用「' + tpl.name + '」。还没拿到企业名（企业资料里没填名字），模板里的「XX 口腔」要自己改。',
        });
      }
      return true;
    },
    [commit, companyName]
  );

  // ── 画布尺寸 ─────────────────────────────────────────────────────────────
  /**
   * 切画布尺寸：按比例重算所有图层坐标（不清空）。
   *
   * @param {object} preset CANVAS_PRESETS 里的一项
   */
  const applyCanvasSize = useCallback(
    (preset) => {
      if (!preset) return;
      commit((prev) => {
        if (prev.width === preset.width && prev.height === preset.height) return prev;
        return rescaleDoc(prev, preset);
      });
    },
    [commit]
  );

  // ── 预览：尺寸测量 + 绘制 ────────────────────────────────────────────────
  /** 按容器可用空间等比算出画布显示尺寸（jsdom 没有布局，走兜底值 560 宽）。 */
  const measureStage = useCallback(() => {
    const el = stageWrapRef.current;
    const fallbackWidth = 560;
    let cw = el && el.clientWidth ? el.clientWidth : 0;
    let ch = el && el.clientHeight ? el.clientHeight : 0;
    if (cw <= 0) cw = fallbackWidth;
    if (ch <= 0) ch = Math.max(320, Math.round(fallbackWidth * (docRef.current.height / docRef.current.width)));
    const ratio = Math.max(1, docRef.current.width) / Math.max(1, docRef.current.height);
    let w = cw;
    let h = w / ratio;
    if (h > ch) {
      h = ch;
      w = h * ratio;
    }
    const nextW = Math.max(1, Math.round(w));
    const nextH = Math.max(1, Math.round(h));
    setStageSize((prev) => (prev.w === nextW && prev.h === nextH ? prev : { w: nextW, h: nextH }));
  }, []);

  useEffect(() => {
    measureStage();
    const el = stageWrapRef.current;
    let observer = null;
    if (el && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => measureStage());
      observer.observe(el);
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', measureStage);
    return () => {
      if (observer) observer.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', measureStage);
    };
  }, [measureStage]);

  // 画布尺寸变了重新 fit 一次
  useEffect(() => {
    measureStage();
  }, [doc.width, doc.height, measureStage]);

  /** 重绘预览。走开关模块（默认新引擎；回退到 legacy 时与导出共用 drawPoster）。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setCanvasBroken(true);
      return;
    }
    setCanvasBroken(false);
    const dpr = Math.max(1, Math.min(3, num(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 1)));
    const cssW = Math.max(1, Math.round(stageSize.w));
    const cssH = Math.max(1, Math.round(stageSize.h));
    const backingW = Math.round(cssW * dpr);
    const backingH = Math.round(cssH * dpr);
    if (canvas.width !== backingW) canvas.width = backingW;
    if (canvas.height !== backingH) canvas.height = backingH;
    // forExport: false —— 预览要看见「放医生照片」那类占位虚线框
    renderPosterSurface(ctx, doc, backingW / Math.max(1, doc.width), { forExport: false });
    // imgVersion：图片解码完成后重绘（图片是异步的，不进 state 无法触发）
  }, [doc, stageSize.w, stageSize.h, imgVersion]);

  // 图片懒解码：图层里出现新 src 时后台解码，完成后 bump imgVersion 重绘
  useEffect(() => {
    const pending = doc.layers.filter((l) => l.type === 'image' && l.src && !peekImage(l.src));
    if (!pending.length) return;
    let alive = true;
    Promise.all(pending.map((l) => ensureImage(l.src)))
      .then(() => {
        if (alive) setImgVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [doc.layers]);

  // ── 拖拽 / 缩放 ─────────────────────────────────────────────────────────
  /** 屏幕坐标 → 画布内坐标。 */
  const pointOf = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas || !e) return null;
    const cx = Number(e.clientX);
    const cy = Number(e.clientY);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    let rect = null;
    try {
      rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    } catch (err) {
      rect = null;
    }
    const left = rect && Number.isFinite(rect.left) && rect.width ? rect.left : 0;
    const top = rect && Number.isFinite(rect.top) && rect.height ? rect.top : 0;
    return { x: cx - left, y: cy - top };
  }, []);

  /** 当前显示比例（屏幕 px / 画布 px）。 */
  const displayScale = stageSize.w / Math.max(1, doc.width);

  /**
   * 开始一次手势（移动或缩放）。
   *
   * ⚠️ 一次物理按下会先来 pointerdown、再来 mousedown；`gestureRef.current` 非空时
   * 直接返回，保证只起一个手势（否则位移会乘 2）。
   *
   * @param {Event} e 事件
   * @param {object} layer 目标图层
   * @param {'move'|'resize'} gesture 手势类型
   */
  const beginGesture = useCallback(
    (e, layer, gesture) => {
      if (!layer || gestureRef.current) return;
      const point = pointOf(e);
      if (!point) return;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      setSelectedId(layer.id);
      gestureRef.current = {
        id: layer.id,
        gesture,
        scale: displayScale > 0 ? displayScale : 1,
        startX: point.x,
        startY: point.y,
        origin: {
          x: num(layer.x, 0),
          y: num(layer.y, 0),
          w: num(layer.w, 100),
          h: num(layer.h, 100),
          fontSize: num(layer.fontSize, 32),
        },
        snapshot: docRef.current,
        changed: false,
      };
    },
    [displayScale, pointOf]
  );

  // window 级监听：pointer + mouse 两套（见文件头的「为什么两套都接」）
  useEffect(() => {
    const onMove = (e) => {
      const g = gestureRef.current;
      if (!g) return;
      const point = pointOf(e);
      if (!point) return;
      const dx = (point.x - g.startX) / g.scale;
      const dy = (point.y - g.startY) / g.scale;
      if (!g.changed && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      g.changed = true;
      const next = docRef.current.layers.map((l) => {
        if (l.id !== g.id) return l;
        if (g.gesture === 'move') {
          return Object.assign({}, l, { x: Math.round(g.origin.x + dx), y: Math.round(g.origin.y + dy) });
        }
        const w = Math.max(24, Math.round(g.origin.w + dx));
        const h = Math.max(24, Math.round(g.origin.h + dy));
        const out = Object.assign({}, l, { w, h });
        // 文字图层缩放时字号跟着走，否则框变大了字还是原来那么大
        if (l.type === 'text') {
          const factor = w / Math.max(1, g.origin.w);
          out.fontSize = Math.max(8, Math.round(g.origin.fontSize * factor));
        }
        return out;
      });
      const nextDoc = Object.assign({}, docRef.current, { layers: next });
      docRef.current = nextDoc;
      setDoc(nextDoc);
    };

    const onUp = () => {
      const g = gestureRef.current;
      if (!g) return;
      gestureRef.current = null;
      if (!g.changed) return;
      if (g.snapshot && g.snapshot !== docRef.current) {
        undoRef.current = undoRef.current.concat([g.snapshot]).slice(-HISTORY_DEPTH);
        redoRef.current = [];
        setHistVersion((v) => v + 1);
      }
    };

    if (typeof window === 'undefined') return undefined;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pointOf]);

  /** 画布上按一下：命中哪个图层就选哪个（从最上层往下找）。 */
  const onStageDown = useCallback(
    (e) => {
      const point = pointOf(e);
      if (!point) return;
      const scale = displayScale > 0 ? displayScale : 1;
      const cx = point.x / scale;
      const cy = point.y / scale;
      const ordered = docRef.current.layers.slice().sort((a, b) => num(b.z, 0) - num(a.z, 0));
      for (const layer of ordered) {
        if (layer.hidden) continue;
        const x = num(layer.x, 0);
        const y = num(layer.y, 0);
        const w = num(layer.w, 0);
        const h = num(layer.h, 0);
        if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
          setSelectedId(layer.id);
          beginGesture(e, layer, 'move');
          return;
        }
      }
      setSelectedId('');
    },
    [beginGesture, displayScale, pointOf]
  );

  // ── 键盘：Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y ─────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : '';
      // 输入框里让浏览器自己处理撤销，否则用户改了半行字一点撤销整张海报都回退了
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const key = String(e.key || '').toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [redo, undo]);

  // ── 导入图片 ─────────────────────────────────────────────────────────────
  /**
   * 从本机路径导入一张图片，**真的**加一个 image 图层。
   *
   * 走 `file:readThumb`（本仓既有通道）换成 dataUrl —— 渲染层不碰磁盘。
   *
   * @param {string} p 图片绝对路径
   * @returns {Promise<string>} 新图层 id
   */
  const importFromPath = useCallback(
    async (p, targetLayerId) => {
      const path = String(p == null ? '' : p).trim();
      if (!path) throw new Error('没有给出图片路径');
      const res = await invoke('file:readThumb', path, 1600);
      const dataUrl = res && res.ok && res.dataUrl ? String(res.dataUrl) : '';
      if (!dataUrl) {
        throw new Error((res && res.error) || '读不到这张图（可能不是图片，或文件已被移走）');
      }
      ensureImage(dataUrl)
        .then(() => setImgVersion((v) => v + 1))
        .catch(() => {});

      // 指定了目标层 ⇒ 填进那一层：**只换 src 与图层名**，
      // 位置 / 尺寸 / 圆角 / 占位标记原样保留（模板摆好的版不能被一张图打乱）。
      const targetKey = String(targetLayerId == null ? '' : targetLayerId).trim();
      if (targetKey) {
        const hit = docRef.current.layers.find((l) => l.id === targetKey);
        if (!hit) throw new Error('要填入的图层不存在：' + targetKey);
        if (hit.type !== 'image') throw new Error('要填入的图层不是图片层：' + targetKey);
        patchLayer(targetKey, { src: dataUrl, name: baseNameOf(path) });
        setSelectedId(targetKey);
        setNotice(null);
        return targetKey;
      }

      const prev = docRef.current;
      const w = Math.max(120, Math.round(prev.width * 0.72));
      const h = Math.max(120, Math.round(w * 0.75));
      const layer = normalizeLayer(
        {
          type: 'image',
          name: baseNameOf(path),
          x: Math.round((prev.width - w) / 2),
          y: Math.round(prev.height * 0.16),
          w,
          h,
          opacity: 1,
          z: prev.layers.length + 1,
          src: dataUrl,
          fit: 'cover',
          radius: 16,
          filters: Object.assign({}, DEFAULT_FILTERS),
        },
        0,
        makeId
      );
      ensureImage(dataUrl)
        .then(() => setImgVersion((v) => v + 1))
        .catch(() => {});
      commit((d) => Object.assign({}, d, { layers: d.layers.concat([layer]) }));
      setSelectedId(layer.id);
      setNotice(null);
      return layer.id;
    },
    [commit, invoke, patchLayer]
  );

  /** 按钮版导入：先弹系统文件框（`file:pick`），再走 importFromPath。 */
  const pickAndImport = useCallback(async () => {
    setBusy('import');
    try {
      const res = await invoke('file:pick', { title: '选一张图片' });
      const picked = pickPathsOf(res);
      if (!picked.length) {
        if (res && res.canceled !== true) {
          setNotice({ type: 'warning', text: '没有选中图片（也可以在「导入图片」里直接给一个路径）。' });
        }
        return;
      }
      await importFromPath(picked[0].path);
    } catch (e) {
      setNotice({ type: 'error', text: explain(e, '导入图片失败') });
    } finally {
      setBusy('');
    }
  }, [explain, importFromPath, invoke]);

  /**
   * 替换选中的那张图（保持位置 / 尺寸 / 圆角 / 滤镜不变，只换 src）。
   *
   * 【为什么必须有这个按钮，而不是「删掉再导入」】
   *   删了再导入会得到一个新图层：位置回到画面中间、圆角滤镜全丢。
   *   用户想干的事是「这张照片不好看，换一张」，不是「重新摆一次版」。
   *
   * @param {string} layerId 目标图片图层 id
   */
  const replaceImageOf = useCallback(
    async (layerId) => {
      const key = String(layerId == null ? '' : layerId);
      if (!key) return;
      setBusy('replace');
      try {
        const res = await invoke('file:pick', { title: '换一张图片' });
        const picked = pickPathsOf(res);
        if (!picked.length) return;
        const read = await invoke('file:readThumb', picked[0].path, 1600);
        const dataUrl = read && read.ok && read.dataUrl ? String(read.dataUrl) : '';
        if (!dataUrl) throw new Error((read && read.error) || '读不到这张图（可能不是图片，或文件已被移走）');
        ensureImage(dataUrl)
          .then(() => setImgVersion((v) => v + 1))
          .catch(() => {});
        patchLayer(key, { src: dataUrl, name: picked[0].name || baseNameOf(picked[0].path) });
        setNotice({ type: 'success', text: '图片已替换（位置和圆角都保留了）' });
      } catch (e) {
        setNotice({ type: 'error', text: explain(e, '替换图片失败') });
      } finally {
        setBusy('');
      }
    },
    [explain, invoke, patchLayer]
  );

  // ── 导出 ────────────────────────────────────────────────────────────────
  /**
   * 把某个图层"推到用户眼前"：选中它 + 把图层列表那一行滚进视野 + 焦点落到文字输入框。
   *
   * 「去修改」按钮必须**真的**把用户带到那一层：只关掉弹窗不改选中态，用户会盯着
   * 一张没变化的海报找"到底哪要改"，那和没拦一样。所以这里做三件事，且每件都判空
   * （jsdom 里 `scrollIntoView` / `focus` 可能不存在，不许因此抛错）。
   *
   * @param {string} layerId 目标图层 id
   */
  const revealLayer = useCallback((layerId) => {
    const key = String(layerId == null ? '' : layerId);
    if (!key) return;
    setSelectedId(key);
    if (typeof window === 'undefined') return;
    // 等一帧：选中态要先渲染出去，「文字内容」框里才有这一层的文本可聚焦
    window.setTimeout(() => {
      const box = layerListRef.current;
      let row = null;
      if (box && typeof box.querySelector === 'function') {
        // id 里只有 [a-z0-9-]（makeId 的形状），直接拼属性选择器是安全的
        row = box.querySelector('[data-ps-layer-id="' + key + '"]');
      }
      if (row && typeof row.scrollIntoView === 'function') {
        try {
          row.scrollIntoView({ block: 'center' });
        } catch (err) {
          // 老引擎不认 options 对象：退回无参调用即可，不值得为它中断整条动线
          try { row.scrollIntoView(); } catch (err2) { /* 滚不动就算了，选中态已经给了 */ }
        }
      }
      const area = textAreaRef.current;
      if (area && typeof area.focus === 'function') {
        try { area.focus(); } catch (err) { /* 同上：聚焦失败不影响"已选中"这件事 */ }
      }
    }, 0);
  }, []);

  /**
   * 生成导出用的 dataUrl（离屏 canvas，**2 倍图**）。
   *
   * @param {object} source 文档（默认当前文档）
   * @param {string} format 'png' | 'jpg'
   * @returns {Promise<{dataUrl:string, ext:string, filename:string}>}
   */
  const buildExportDataUrl = useCallback(async (source, format) => {
    const target = source || docRef.current;
    // 先把图解码完，否则导出的图是空的（预览里的 onload 重绘救不了离屏 canvas）
    const images = (target.layers || []).filter((l) => l.type === 'image' && l.src);
    if (images.length) {
      await Promise.all(images.map((l) => ensureImage(l.src).catch(() => null)));
    }
    // forExport: true —— 占位虚线框绝不进成品图；画布不可用 / 有层没画出来由开关模块抛错
    const canvas = renderPosterExport(target, EXPORT_SCALE);
    const ext = format === 'jpg' ? 'jpg' : 'png';
    // canvasToDataUrl 拦 "data:,"（超画布面积上限时 toDataURL 只回这 6 字符）；文案转用户话术
    let dataUrl;
    try { dataUrl = canvasToDataUrl(canvas, ext === 'jpg' ? 'jpeg' : 'png'); } catch {
      // 这条 catch 眼下只兜"面积超限"：尺寸为 0 / 非 data:image/ 两种会被 renderPosterExport 先抛。
      // 等 S 卡把三种原因分开报之前，别把它当成全量兜底。
      throw new Error('导出失败：这张图太大，设备没能画出来（调小画布尺寸再试）');
    }
    return { dataUrl, ext, filename: defaultFileName(ext) };
  }, []);

  /**
   * 导出到本机。
   *
   * 两种落点：
   *   · `savePath` 为空串（UI 上的「导出」）⇒ 主进程自己用作品目录的 posters/
   *   · 完全不带 `savePath` 字段（UI 上的「另存为…」）⇒ 主进程弹系统保存框
   *
   * 【占位守门放在这一层，不放 UI 层】
   *   这里是**所有**导出路径的唯一漏斗（两个按钮 + 豆芽 Agent 的 `__posterTest.exportTo`）。
   *   把判定放在这里，才不存在"从另一条路导出去就没人拦"的漏口。
   *   - 命中 ≥1 处占位且没有显式放行 ⇒ **throw**（带 `code:'PLACEHOLDER_PENDING'` 与
   *     `placeholders` 读数），不落盘、不产生任何字节；
   *   - UI 的「仍要导出」会带 `{ allowPlaceholders: true }` 再调一次 —— 那是用户
   *     **明确点过确认**之后的放行，不是绕过。
   *
   * @param {string} [savePath] 目标文件绝对路径
   * @param {'png'|'jpg'} [format] 格式
   * @param {{allowPlaceholders?: boolean}} [options] 导出选项
   *   `allowPlaceholders:true` = 用户已确认「知道有占位、仍要导出」
   * @returns {Promise<{ok:boolean, path:string, bytes:number, sha1:string}>}
   */
  const exportTo = useCallback(
    async (savePath, format, options) => {
      const allowPlaceholders = !!(options && options.allowPlaceholders === true);
      if (!allowPlaceholders) {
        const hits = findPlaceholderTexts(docRef.current.layers);
        if (hits.length > 0) throw makePlaceholderError(hits);
      }
      const built = await buildExportDataUrl(docRef.current, format || fmt);
      const payload = { dataUrl: built.dataUrl, ext: built.ext, filename: built.filename };
      if (typeof savePath === 'string') payload.savePath = savePath;
      const res = await invoke('poster:export', payload);
      // 取消态：主进程回的是 { ok:false, canceled:true }，**没有 error 字段**。
      // 所以这里绝不能写 `res.error.includes(...)`（取消时 TypeError），
      // 也绝不能把它当失败 —— 用户主动点了取消，不该看到一条红字说"导出失败"。
      if (!res || res.ok !== true) {
        if (res && res.canceled === true) {
          const cancelErr = new Error('已取消导出');
          cancelErr.code = 'CANCELED';
          throw cancelErr;
        }
        throw new Error((res && res.error) || '导出失败：主进程没有返回成功');
      }
      // path / bytes / sha1 **一律透传主进程的真实返回值**，不在渲染层编。
      // 尤其 path：主进程可能因为「声明的 ext 与字节不符」把扩展名按实际字节换掉，
      // 渲染层自己拼一个"我以为的路径"就会跟磁盘上的真文件对不上。
      const info = {
        path: String(res.path || ''),
        bytes: num(res.bytes, 0),
        sha1: String(res.sha1 || ''),
        ext: built.ext,
        // warning：真实落盘扩展名与声明不符时主进程会给。这不是失败，但**必须显示**
        // —— 说明渲染层的 canvas 导出格式与扩展名没对上，是用户能感知的真问题。
        warning: res.warning ? String(res.warning) : '',
      };
      setExportInfo(info);
      return { ok: true, path: info.path, bytes: info.bytes, sha1: info.sha1 };
    },
    [buildExportDataUrl, fmt, invoke]
  );

  /**
   * 按钮版导出。
   *
   * 两条分支的差别**只在有没有 savePath**（主进程就是这么判的）：
   *   · 「导出图片」：显式给出 `<作品目录>/posters/海报-<时间戳>.<ext>` ⇒ 主进程直接写、
   *     **不弹任何文件对话框**（有 savePath 就是覆盖语义、父目录自动建）。这才是「一键导出」
   *     的字面含义：小白点一下就完事，不用先在一个文件对话框里做决定。
   *   · 「另存为…」：完全不带 savePath 键 ⇒ 主进程弹系统保存框，用户自己挑位置。
   *
   * ⚠️ 作品目录拿不到（旧版主进程 / status 还没回来）时，默认导出退化成「不带 savePath」，
   *   也就是让主进程弹框 —— 宁可多一步点选，也不要静默写到一个猜出来的路径里。
   *
   * 【占位拦截在这一层怎么表现】
   *   命中 0 处 ⇒ 直接导（行为与改动前完全一致，多功能都不多一步）。
   *   命中 ≥1 处 ⇒ **不导**，先弹确认：列出具体是哪几个文字层、原文是什么。
   *     · 「去修改」⇒ 关掉弹窗，把第一个问题层选中 / 滚进视野 / 聚焦到文字输入框；
   *     · 「仍要导出」⇒ 用户明确确认后才带 `allowPlaceholders` 放行。
   *   这里用的是"拦住 + 给出原文"，不是"可能存在占位符"那种含糊提示 ——
   *   含糊提示等于把判断责任推回给不懂设计的门诊前台。
   *
   * @param {boolean} saveAs true = 另存为（弹系统保存框）
   */
  const handleExport = useCallback(
    async (saveAs) => {
      // ① 守门：先判占位（用与右栏提示完全相同的那一个纯函数，不另起一套判据）
      const hits = findPlaceholderTexts(docRef.current.layers);
      if (hits.length > 0) {
        const first = hits[0];
        let proceed = false;
        try {
          proceed = await new Promise((resolve) => {
            Modal.confirm({
              title: '这 ' + hits.length + ' 处还是模板占位，导出后图上会印出来',
              content: (
                <div className="ps-placeholder-confirm">
                  <p>
                    模板里的电话 / 地址没有企业资料可填，必须你手动改：
                  </p>
                  <pre className="ps-placeholder-list">{describePlaceholderHits(hits)}</pre>
                  <p>
                    点「去修改」会直接跳到第一个问题层（「{first.layerName}」）；确认要带着这些字导出，点「仍要导出」。
                  </p>
                </div>
              ),
              okText: '仍要导出',
              cancelText: '去修改',
              // 「去修改」是**推荐动作**，所以把它做成取消键（antd 的 cancel 键默认不是主色），
              // 并把键盘焦点默认放在取消键上：误按回车不会产出一张废图。
              okButtonProps: { danger: true },
              autoFocusButton: 'cancel',
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });
        } catch (err) {
          // 弹窗本身出问题（极少见）⇒ 当作"没确认"处理：不导出比导出废图安全
          proceed = false;
        }
        if (!proceed) {
          revealLayer(first.layerId);
          setNotice({
            type: 'warning',
            text: '还有 ' + hits.length + ' 处模板占位没改，已跳到「' + first.layerName + '」。改完再导出。',
          });
          return;
        }
        // 用户明确确认：带着占位导出。提示留一条，避免他以为"已经改好了"
        setNotice({ type: 'warning', text: '按你的确认，带着 ' + hits.length + ' 处占位导出了。' });
      }

      // ② 真导出（这里才是改动前就有的那条路径）
      setBusy(saveAs ? 'saveAs' : 'export');
      try {
        // 三态判据（主进程 posterStore.registerIpc，commit 13681a6 定稿）：
        //   savePath 非空          → 直接写该路径，不弹窗（无人值守自动化走这条）
        //   savePath 键在但为空串  → 自动命名落 <作品目录>/posters/，**不弹窗**，重名追加 -2
        //   完全没有 savePath 键    → 弹系统保存框
        //
        // 「导出」必须走中间那一档：点一下就完事，什么都不问；连点两次得到两张图
        // （dedupe 在 writeDataUrl 里），而不是静默覆盖前一张。
        //
        // ⚠️ 不要为了"少一次弹窗"改成显式绝对路径：那会绕过 dedupe，同一秒导出两次
        //   会覆盖，且把主进程的命名规则抄一份到渲染层（两份必然漂移）。
        const target = saveAs ? undefined : '';
        // 上面已经问过用户了（或者本来就没有占位）⇒ 这一层放行，不再二次弹窗
        const result = await exportTo(target, undefined, { allowPlaceholders: true });
        setNotice({ type: 'success', text: '已导出：' + (result.path || '（主进程没有回路径）') });
      } catch (e) {
        // 用户点了对话框里的「取消」不是错误，是正常操作
        if (e && e.code === 'CANCELED') {
          setNotice({ type: 'info', text: '已取消导出，海报还在，随时可以再导出。' });
          return;
        }
        // 兜底：万一走到这里还带着占位错误（例如导出过程中图层被改回来了）
        if (e && e.code === 'PLACEHOLDER_PENDING') {
          const rest = Array.isArray(e.placeholders) ? e.placeholders : [];
          if (rest.length) revealLayer(rest[0].layerId);
          setNotice({ type: 'warning', text: String(e.message || '还有模板占位没改，已拦下。') });
          return;
        }
        setNotice({ type: 'error', text: explain(e, '导出失败') });
      } finally {
        setBusy('');
      }
    },
    [explain, exportTo, revealLayer]
  );

  /** 打开导出文件所在目录（目录优先，取不到就交给系统按文件处理）。 */
  const openFolderOf = useCallback(
    async (p) => {
      const target = dirNameOf(p) || String(p || '');
      if (!target) return;
      try {
        const res = await invoke('file:openPath', target);
        if (res && res.ok === false) setNotice({ type: 'warning', text: (res && res.error) || '打不开这个目录' });
      } catch (e) {
        setNotice({ type: 'error', text: explain(e, '打不开这个目录') });
      }
    },
    [explain, invoke]
  );

  // ── 项目保存 / 打开 ──────────────────────────────────────────────────────
  /** 保存当前海报项目（json 落盘，主进程决定路径）。 */
  const saveProject = useCallback(async () => {
    const name = String(projectName || docRef.current.templateName || '未命名海报').trim() || '未命名海报';
    setBusy('saveProject');
    try {
      const json = JSON.stringify({ version: 1, doc: docRef.current });
      const res = await invoke('poster:saveProject', { json, name });
      if (!res || res.ok !== true) throw new Error((res && res.error) || '保存失败');
      setNotice({ type: 'success', text: '项目已保存：' + String(res.path || '') });
    } catch (e) {
      setNotice({ type: 'error', text: explain(e, '保存项目失败') });
    } finally {
      setBusy('');
    }
  }, [explain, invoke, projectName]);

  /** 读历史项目列表。 */
  const refreshProjects = useCallback(async () => {
    try {
      const res = await invoke('poster:listProjects');
      if (!res || res.ok !== true) throw new Error((res && res.error) || '取不到项目列表');
      const items = Array.isArray(res.items) ? res.items : [];
      setProjects(items);
      if (!items.length) setNotice({ type: 'info', text: '还没有保存过海报项目。' });
    } catch (e) {
      setProjects([]);
      setNotice({ type: 'error', text: explain(e, '取不到项目列表') });
    }
  }, [explain, invoke]);

  /** 打开一个已保存的项目。 */
  const openProject = useCallback(
    async (path) => {
      const target = String(path || '').trim();
      if (!target) return;
      setBusy('openProject');
      try {
        const res = await invoke('poster:readProject', target);
        if (!res || res.ok !== true) throw new Error((res && res.error) || '读取失败');
        const parsed = typeof res.json === 'string' ? JSON.parse(res.json) : res.json;
        const loaded = normalizeDoc(parsed && parsed.doc ? parsed.doc : parsed);
        commit(loaded);
        setSelectedId(loaded.layers.length ? loaded.layers[0].id : '');
        setExportInfo(null);
        setNotice({ type: 'success', text: '已打开：' + baseNameOf(target) });
      } catch (e) {
        setNotice({ type: 'error', text: explain(e, '打开项目失败') });
      } finally {
        setBusy('');
      }
    },
    [commit, explain, invoke]
  );

  // ── 自动化钩子（产品能力：让豆芽 Agent 自己生成海报）────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    /**
     * 挂到 window 上的自动化接口。
     * 每条都必须**真的生效**：真的改 state、真的调 IPC。
     */
    const hooks = {
      ready: true,
      templates: () => posterTemplateNames(),
      applyTemplate: (name) => applyTemplate(name),
      setText: (id, text) => {
        const key = String(id == null ? '' : id);
        const layer = docRef.current.layers.find((l) => l.id === key);
        if (!layer || layer.type !== 'text') return false;
        patchLayer(key, { text: String(text == null ? '' : text) });
        return true;
      },
      moveLayer: (id, dx, dy) => {
        const key = String(id == null ? '' : id);
        const layer = docRef.current.layers.find((l) => l.id === key);
        if (!layer) return false;
        patchLayer(key, {
          x: Math.round(num(layer.x, 0) + num(dx, 0)),
          y: Math.round(num(layer.y, 0) + num(dy, 0)),
        });
        return true;
      },
      importFromPath: (p, targetLayerId) => importFromPath(p, targetLayerId),
      // 空图占位层（模板里「放医生照片」那种）。Agent 要能问"这张模板还有几处要放图"。
      placeholderLayers: () =>
        docRef.current.layers
          .filter((l) => l.type === 'image' && l.placeholder && !l.src)
          .map((l) => ({ id: l.id, name: l.name, label: l.placeholderLabel })),
      // 占位层总数（含已填图的），便于 Agent 判断"还差几张"
      placeholderSlots: () =>
        docRef.current.layers
          .filter((l) => l.type === 'image' && l.placeholder)
          .map((l) => ({ id: l.id, name: l.name, filled: !!l.src })),
      exportTo: (p, options) => exportTo(p, fmt, options),
      // 占位读数：Agent 在导出前先问一句「还有几处要改」，比导出被拦下再回头改更省一轮。
      // 与右栏提示、导出拦截用的是**同一个纯函数**，不存在两套判据。
      placeholderTexts: () => findPlaceholderTexts(docRef.current.layers),
      // 当前用来填充企业名的那个名字（空串 = 没有可用真名）。
      // Agent 据此判断"XX 口腔 该不该自动变成真名"，而不是自己猜一份。
      companyName: () => companyName,
      getState: () => cloneDoc(docRef.current),
      // 下列不属于最小契约，但 Agent 做"改颜色/改字号/查选择"时会用到，一并给真的
      selectLayer: (id) => {
        const key = String(id == null ? '' : id);
        const hit = docRef.current.layers.some((l) => l.id === key);
        if (hit) setSelectedId(key);
        return hit;
      },
      updateLayer: (id, patch) => {
        const key = String(id == null ? '' : id);
        const layer = docRef.current.layers.find((l) => l.id === key);
        if (!layer || !patch || typeof patch !== 'object') return false;
        patchLayer(key, patch);
        return true;
      },
      undo: () => undo(),
      redo: () => redo(),
      setCanvasSize: (ratioKey) => {
        const preset = CANVAS_PRESETS.find((p) => p.key === ratioKey);
        if (!preset) return false;
        applyCanvasSize(preset);
        return true;
      },
    };
    window.__posterTest = hooks;
    return () => {
      try {
        delete window.__posterTest;
      } catch (e) {
        window.__posterTest = undefined;
      }
    };
  }, [applyCanvasSize, applyTemplate, companyName, exportTo, fmt, importFromPath, patchLayer, redo, undo]);

  // ── 渲染辅助 ─────────────────────────────────────────────────────────────
  /** 素材目录文案：告诉用户海报默认存哪儿（分隔符跟随作品目录，Windows 反斜杠 / macOS 正斜杠）。 */
  const mediaDirText = String(mediaDir || '').trim();
  const postersDirText = mediaDirText
    ? mediaDirText.replace(/[\\/]+$/, '') + (mediaDirText.indexOf('\\') >= 0 ? '\\posters' : '/posters')
    : '（作品目录）/posters';

  /** 图层列表按「上层在前」展示（与视觉层叠一致）。 */
  const listLayers = useMemo(() => doc.layers.slice().sort((a, b) => num(b.z, 0) - num(a.z, 0)), [doc.layers]);

  /** 选中框的屏幕坐标（DOM overlay，只负责显示与接手势，不参与排版）。 */
  const selectionBox = useMemo(() => {
    if (!selected) return null;
    return {
      left: Math.round(num(selected.x, 0) * displayScale),
      top: Math.round(num(selected.y, 0) * displayScale),
      width: Math.max(2, Math.round(num(selected.w, 0) * displayScale)),
      height: Math.max(2, Math.round(num(selected.h, 0) * displayScale)),
    };
  }, [displayScale, selected]);

  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  // histVersion 只是用来让上面两行在栈变化后重新求值
  void histVersion;

  const selText = selected && selected.type === 'text' ? selected : null;
  const selImage = selected && selected.type === 'image' ? selected : null;

  return (
    <div className="ps-root">
      {/* ── 左栏 ─────────────────────────────────────────────────────── */}
      <aside className="ps-col ps-col-left">
        <section className="ps-block">
          <h3 className="ps-block-title">模板</h3>
          <p className="ps-block-hint">挑一个最像的，套用之后每个字都能改</p>
          <div className="ps-tpl-grid">
            {POSTER_TEMPLATES.map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                className={'ps-tpl' + (doc.templateName === tpl.name ? ' ps-tpl-active' : '')}
                onClick={() => applyTemplate(tpl.name)}
                title={tpl.desc}
              >
                <span className="ps-tpl-swatch" aria-hidden="true">
                  {tpl.decor.map((color, i) => (
                    <i key={i} style={{ background: color }} />
                  ))}
                </span>
                <span className="ps-tpl-name">{tpl.name}</span>
                <span className="ps-tpl-desc">{tpl.desc}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="ps-block">
          <h3 className="ps-block-title">文案</h3>
          {selText ? (
            <div className="ps-fields">
              <label className="ps-field">
                <span className="ps-field-label">文字内容</span>
                <TextArea
                  ref={textAreaRef}
                  value={selText.text}
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  onChange={(e) => patchLayer(selText.id, { text: e.target.value })}
                  placeholder="写你想让患者看到的话"
                />
              </label>
              <div className="ps-field-row">
                <label className="ps-field ps-field-half">
                  <span className="ps-field-label">字号</span>
                  <InputNumber
                    min={10}
                    max={240}
                    value={selText.fontSize}
                    onChange={(v) => patchLayer(selText.id, { fontSize: Math.round(num(v, selText.fontSize)) })}
                  />
                </label>
                <label className="ps-field ps-field-half">
                  <span className="ps-field-label">字重</span>
                  <Select
                    value={selText.weight}
                    options={WEIGHT_OPTIONS}
                    onChange={(v) => patchLayer(selText.id, { weight: num(v, 600) })}
                  />
                </label>
              </div>
              <label className="ps-field">
                <span className="ps-field-label">对齐</span>
                <Segmented
                  block
                  value={selText.align}
                  onChange={(v) => patchLayer(selText.id, { align: v })}
                  options={[
                    { label: '左', value: 'left' },
                    { label: '中', value: 'center' },
                    { label: '右', value: 'right' },
                  ]}
                />
              </label>
              <div className="ps-field-row">
                <label className="ps-field ps-field-half">
                  <span className="ps-field-label">行高</span>
                  <InputNumber
                    min={0.9}
                    max={3}
                    step={0.05}
                    value={selText.lineHeight}
                    onChange={(v) => patchLayer(selText.id, { lineHeight: num(v, 1.4) })}
                  />
                </label>
                <label className="ps-field ps-field-half">
                  <span className="ps-field-label">字距</span>
                  <InputNumber
                    min={-4}
                    max={40}
                    step={1}
                    value={selText.letterSpacing}
                    onChange={(v) => patchLayer(selText.id, { letterSpacing: num(v, 0) })}
                  />
                </label>
              </div>
              <label className="ps-field">
                <span className="ps-field-label">颜色</span>
                <input
                  className="ps-color"
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(String(selText.color || '')) ? selText.color : '#123328'}
                  onChange={(e) => patchLayer(selText.id, { color: e.target.value })}
                />
              </label>
            </div>
          ) : (
            <p className="ps-block-hint">先在画布或右栏点一个文字图层，这里就能改字。</p>
          )}
        </section>

        <section className="ps-block">
          <h3 className="ps-block-title">图片</h3>
          <Button block onClick={pickAndImport} loading={busy === 'import'}>
            导入图片
          </Button>
          {selImage ? (
            <div className="ps-fields">
              <label className="ps-field">
                <span className="ps-field-label">填充方式</span>
                <Segmented
                  block
                  value={selImage.fit}
                  onChange={(v) => patchLayer(selImage.id, { fit: v })}
                  options={[
                    { label: '铺满裁切', value: 'cover' },
                    { label: '完整放入', value: 'contain' },
                  ]}
                />
              </label>
              <label className="ps-field">
                <span className="ps-field-label">圆角 {num(selImage.radius, 0)}px</span>
                <Slider
                  min={0}
                  max={Math.max(24, Math.round(Math.min(num(selImage.w, 100), num(selImage.h, 100)) / 2))}
                  value={num(selImage.radius, 0)}
                  onChange={(v) => patchLayer(selImage.id, { radius: Math.round(num(v, 0)) })}
                />
              </label>
              <label className="ps-field">
                <span className="ps-field-label">透明度 {Math.round(clamp01(selImage.opacity, 1) * 100)}%</span>
                <Slider
                  min={5}
                  max={100}
                  value={Math.round(clamp01(selImage.opacity, 1) * 100)}
                  onChange={(v) => patchLayer(selImage.id, { opacity: clamp01(num(v, 100) / 100, 1) })}
                />
              </label>
              {FILTER_FIELDS.map((f) => (
                <label key={f.key} className="ps-field">
                  <span className="ps-field-label">
                    {f.label} {num(selImage.filters && selImage.filters[f.key], DEFAULT_FILTERS[f.key])}
                    {f.suffix}
                  </span>
                  <Slider
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={num(selImage.filters && selImage.filters[f.key], DEFAULT_FILTERS[f.key])}
                    onChange={(v) =>
                      patchLayer(selImage.id, {
                        filters: Object.assign({}, DEFAULT_FILTERS, selImage.filters || {}, { [f.key]: num(v, DEFAULT_FILTERS[f.key]) }),
                      })
                    }
                  />
                </label>
              ))}
              <div className="ps-field-row">
                <Button size="small" loading={busy === 'replace'} onClick={() => replaceImageOf(selImage.id)}>
                  换一张图
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    patchLayer(selImage.id, {
                      filters: Object.assign({}, DEFAULT_FILTERS),
                    })
                  }
                >
                  滤镜复位
                </Button>
                <Button size="small" danger onClick={() => removeLayer(selImage.id)}>
                  删除图片
                </Button>
              </div>
            </div>
          ) : (
            <p className="ps-block-hint">导入后点中图片，可调填充方式 / 圆角 / 透明度 / 滤镜。</p>
          )}
        </section>

        <section className="ps-block">
          <h3 className="ps-block-title">画布尺寸</h3>
          <div className="ps-size-grid">
            {CANVAS_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={'ps-size' + (doc.ratioKey === preset.key ? ' ps-size-active' : '')}
                onClick={() => applyCanvasSize(preset)}
                title={preset.hint}
              >
                <span className="ps-size-label">{preset.label}</span>
                <span className="ps-size-hint">
                  {preset.width}×{preset.height}
                </span>
              </button>
            ))}
          </div>
          <p className="ps-block-hint">切换尺寸会按比例重排，已改的文案不会丢。</p>
          {/* 如实告知：模板坐标是按 3:4 画的，换比例只做等比缩放 ⇒ 个别模板会留白。
              不做的选择：给 6 套模板各补多套断点坐标（成本远超收益，且用户九成只用 3:4）。
              但"会留白"这件事必须说出来，不能让用户导出后才发现。 */}
          {doc.ratioKey !== '3:4' ? (
            <p className="ps-block-note" data-ps-ratio-note>
              其它比例按 3:4 等比缩放，个别模板会有留白。
            </p>
          ) : null}
        </section>
      </aside>

      {/* ── 中栏：画布 ────────────────────────────────────────────────── */}
      <main className="ps-col ps-col-center">
        <div className="ps-stage-head">
          <span className="ps-stage-title">
            {doc.templateName ? doc.templateName : '空白画布'}
            <span className="ps-stage-size">
              {' '}
              · {doc.width}×{doc.height}
            </span>
          </span>
          <span className="ps-stage-tail">导出为 {doc.width * EXPORT_SCALE}×{doc.height * EXPORT_SCALE}</span>
        </div>

        <div className="ps-stage-wrap" ref={stageWrapRef}>
          <div className="ps-stage" style={{ width: stageSize.w + 'px', height: stageSize.h + 'px' }}>
            <canvas
              ref={canvasRef}
              className="ps-canvas"
              style={{ width: stageSize.w + 'px', height: stageSize.h + 'px' }}
              onPointerDown={onStageDown}
              onMouseDown={onStageDown}
            />
            {selectionBox ? (
              <div
                className="ps-sel"
                style={{
                  left: selectionBox.left + 'px',
                  top: selectionBox.top + 'px',
                  width: selectionBox.width + 'px',
                  height: selectionBox.height + 'px',
                }}
                onPointerDown={(e) => beginGesture(e, selected, 'move')}
                onMouseDown={(e) => beginGesture(e, selected, 'move')}
              >
                <span
                  className="ps-handle"
                  role="presentation"
                  onPointerDown={(e) => beginGesture(e, selected, 'resize')}
                  onMouseDown={(e) => beginGesture(e, selected, 'resize')}
                />
              </div>
            ) : null}
            {!doc.layers.length ? (
              <div className="ps-stage-empty">
                <strong>先从左栏挑一个模板</strong>
                <span>套用后直接改字，改完点右栏「导出」</span>
              </div>
            ) : null}
            {canvasBroken ? (
              <div className="ps-stage-empty">
                <strong>这台设备画不出预览</strong>
                <span>仍然可以尝试导出；如果导出也失败，请更新到新版</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="ps-stage-foot">
          拖动图层移动，右下角方块缩放；改完记得导出。
          {notice ? (
            <Alert
              className="ps-notice"
              type={notice.type === 'success' ? 'success' : notice.type === 'info' ? 'info' : notice.type === 'warning' ? 'warning' : 'error'}
              showIcon
              message={notice.text}
            />
          ) : null}
        </div>
      </main>

      {/* ── 右栏：图层 + 导出 ─────────────────────────────────────────── */}
      <aside className="ps-col ps-col-right">
        <section className="ps-block">
          <div className="ps-block-head">
            <h3 className="ps-block-title">图层</h3>
            <span className="ps-block-tools">
              <Button size="small" disabled={!canUndo} onClick={undo}>
                撤销
              </Button>
              <Button size="small" disabled={!canRedo} onClick={redo}>
                重做
              </Button>
            </span>
          </div>
          {listLayers.length ? (
            <ul className="ps-layers" ref={layerListRef}>
              {listLayers.map((layer) => {
                // 这一层是否还含模板占位 —— 在图层列表里直接标出来，
                // 用户不用翻每一个图层去找"到底哪几处没改"
                const pending = placeholderHits.some((hit) => hit.layerId === layer.id);
                return (
                <li
                  key={layer.id}
                  data-ps-layer-id={layer.id}
                  className={'ps-layer' + (layer.id === selectedId ? ' ps-layer-active' : '')}
                  onClick={() => setSelectedId(layer.id)}
                >
                  <span className="ps-layer-name" title={layer.name}>
                    {layer.type === 'text' ? '字' : layer.type === 'image' ? '图' : '形'} · {layer.name}
                    {/* 占位标记：红字「待改」。inline style 而不新增 CSS 类，
                        因为本轮只允许改两个文件（CSS 不在其中）。 */}
                    {pending ? (
                      <em style={{ color: 'var(--c-danger)', fontStyle: 'normal', marginLeft: 6, fontSize: 11 }}>待改</em>
                    ) : null}
                  </span>
                  <span className="ps-layer-acts">
                    <button type="button" title="上移" onClick={(e) => { e.stopPropagation(); moveLayerZ(layer.id, 1); }}>
                      ↑
                    </button>
                    <button type="button" title="下移" onClick={(e) => { e.stopPropagation(); moveLayerZ(layer.id, -1); }}>
                      ↓
                    </button>
                    <button type="button" title={layer.hidden ? '显示' : '隐藏'} onClick={(e) => { e.stopPropagation(); toggleHidden(layer.id); }}>
                      {layer.hidden ? '隐' : '显'}
                    </button>
                    <button type="button" title="删除" onClick={(e) => { e.stopPropagation(); removeLayer(layer.id); }}>
                      ×
                    </button>
                  </span>
                </li>
                );
              })}
            </ul>
          ) : (
            <p className="ps-block-hint">还没有图层。套用模板后会出现在这里。</p>
          )}
        </section>

        <section className="ps-block">
          <h3 className="ps-block-title">导出</h3>
          <Segmented
            block
            value={fmt}
            onChange={(v) => setFmt(v)}
            options={[
              { label: 'PNG', value: 'png' },
              { label: 'JPG', value: 'jpg' },
            ]}
          />
          <p className="ps-block-hint">默认存到 {postersDirText}</p>
          {/* ── 常驻的占位提示（不是只有点了导出才说话）─────────────────────────
              这条读数随图层实时变化：用户改掉一处，这里就少一条、改完就整块消失。
              为什么要常驻：只靠导出时的弹窗，用户要"导出 → 被拦 → 回头找"来回好几趟；
              在这里直接列出「哪一层、原文是什么」，还能点进去改，一趟就够了。
              用 data-ps-placeholder-warn 标记，便于自动化验收直接读这块读数。 */}
          {placeholderHits.length ? (
            <div data-ps-placeholder-warn={placeholderHits.length} style={{ marginBottom: 10 }}>
              <Alert
                type="warning"
                showIcon
                message={'还有 ' + placeholderHits.length + ' 处模板占位没改，导出后图上会印出来'}
                description={
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {placeholderHits.map((hit) => (
                      <li key={hit.layerId || hit.layerName} style={{ marginBottom: 4 }}>
                        <button
                          type="button"
                          data-ps-placeholder-jump={hit.layerId}
                          onClick={() => revealLayer(hit.layerId)}
                          style={{
                            border: 'none',
                            background: 'none',
                            padding: 0,
                            color: 'var(--c-brand-dark)',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                          }}
                        >
                          「{hit.layerName}」
                        </button>
                        <span style={{ color: 'var(--c-warn)', wordBreak: 'break-all' }}>
                          {String(hit.text == null ? '' : hit.text).replace(/\n/g, ' / ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                }
              />
            </div>
          ) : null}
          <div className="ps-export-acts">
            <Button type="primary" block loading={busy === 'export'} onClick={() => handleExport(false)}>
              导出图片
            </Button>
            <Button block loading={busy === 'saveAs'} onClick={() => handleExport(true)}>
              另存为…
            </Button>
          </div>
          {exportInfo ? (
            <div className="ps-export-done">
              <div className="ps-export-path" title={exportInfo.path}>
                {exportInfo.path || '（主进程没有回路径）'}
              </div>
              <div className="ps-export-meta">
                {exportInfo.bytes ? Math.max(1, Math.round(exportInfo.bytes / 1024)) + ' KB' : ''}
                {exportInfo.sha1 ? ' · ' + exportInfo.sha1.slice(0, 8) : ''}
              </div>
              {/* 主进程回 warning 时**必须**显示：这不是失败，但说明声明的格式与真实
                  字节不符（扩展名已被主进程按字节纠正）。藏起来的话，用户会遇到
                  「我明明导出 PNG 怎么是 JPG」而界面上毫无解释。 */}
              {exportInfo.warning ? <div className="ps-export-warn">{exportInfo.warning}</div> : null}
              <div className="ps-field-row">
                <Button size="small" onClick={() => openFolderOf(exportInfo.path)}>
                  打开文件夹
                </Button>
                <Button size="small" onClick={() => setExportInfo(null)}>
                  继续修改
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="ps-block">
          <h3 className="ps-block-title">项目</h3>
          <Input
            placeholder="项目名（默认用模板名）"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
          />
          <div className="ps-export-acts">
            <Button block loading={busy === 'saveProject'} onClick={saveProject}>
              保存项目
            </Button>
            <Button block onClick={refreshProjects}>
              找已保存的
            </Button>
          </div>
          {projects.length ? (
            <ul className="ps-projects">
              {projects.map((item) => (
                <li key={item.path || item.name}>
                  <button type="button" onClick={() => openProject(item.path)} title={item.path}>
                    {item.name || baseNameOf(item.path)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </aside>
    </div>
  );
}
