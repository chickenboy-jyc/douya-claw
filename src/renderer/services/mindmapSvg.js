/**
 * mindmapSvg —— 把布局结果拼成一段**完整可独立打开**的 SVG 字符串（纯函数，零 DOM）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 【为什么预览和导出共用这一个函数】
 *   预览用 `dangerouslySetInnerHTML` 塞进页面，导出走 `new Image()` + blob。
 *   两套代码画同一张图，必然会漂：预览看着居中、导出偏一格，或者预览有描边、导出没有。
 *   所以 **只有这一份拼装逻辑**，两者只是 viewport 不同。
 *
 * 【为什么必须带 xmlns】
 *   预览里塞进已有 SVG 文档时 xmlns 可有可无；但导出是把字符串包成 blob
 *   `<image src="blob:...">`，缺 xmlns 的 SVG 会被当成"未知 XML"静默不渲染 ——
 *   表现是"导出的图是空白"，且控制台一声不响。这是最容易漏、也最难查的一条。
 *
 * 【配色为什么全是绿色系、且必须挡住纯黑和蓝】
 *   老板明确要绿色主调、不要黑色主调不要蓝色主调（与 `posterTemplates.js` 同一口径）。
 *   纯黑正文（含 #1d1d1f）印出来发脏，蓝色 hue(200-260) 与主色打架。
 *   色板集中在这一个常量里，单测会逐个算 hue —— 谁再往色板里塞蓝色，门禁直接红。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { MM_LAYOUT } from './mindmapLayout.js';

/** 深度 0-4 各一套。深度 >4 一律用最后一套（层次再深，颜色也分不出来了）。 */
export const MM_PALETTE = Object.freeze([
  { fill: '#1f7a4d', stroke: '#1f7a4d', text: '#ffffff' },
  { fill: '#E8F7EF', stroke: '#2FAF6B', text: '#123328' },
  { fill: '#F0FAF5', stroke: '#B9E3CE', text: '#2C5343' },
  { fill: '#FFFFFF', stroke: '#D8ECE2', text: '#3d5c4e' },
  { fill: '#FFFFFF', stroke: '#E3F1E9', text: '#3d5c4e' },
]);

/**
 * **只有预览**在深色主题下用的色板。导出永远用上面那套浅色品牌色板。
 *
 * 为什么不把 `MM_PALETTE` 改成读 CSS 变量：这个文件的产物有两条完全不同的去向 ——
 *   ① 预览：`dangerouslySetInnerHTML` 塞进页面（跟界面主题走才对）；
 *   ② 导出：包成 blob → `<img>` → canvas → PNG（这是要发客户的**交付物**，
 *      必须保持浅底品牌绿，变深等于换了一份稿子）。
 * 而 `<svg>` 的属性里写 `var(--c-*)` 在导出管线（Image 解码）里拿不到文档作用域，
 * 会直接变成透明/黑色。所以只能由调用方在**预览**那条路径上显式传 `theme: 'dark'`，
 * 色值在这里落成字面量。两套色板互不影响：`MM_PALETTE` 仍是导出的唯一真源。
 */
export const MM_PALETTE_DARK = Object.freeze([
  { fill: '#3cc47c', stroke: '#3cc47c', text: '#10241a' },
  { fill: '#1b2a22', stroke: '#3cc47c', text: '#ecf1ee' },
  { fill: '#1f2a25', stroke: '#2c4a39', text: '#d7e6de' },
  { fill: '#232725', stroke: '#2c4a39', text: '#c2d1c9' },
  { fill: '#232725', stroke: '#243029', text: '#c2d1c9' },
]);

/** 画布底色。浅绿白，比纯白柔和，导出的图贴在文档里不炸眼。 */
const MM_CANVAS_BG = '#f6faf7';

/** 深色预览的画布底（同 theme-tokens 的 `--c-bg-window` 深色值）。 */
const MM_CANVAS_BG_DARK = '#171a18';

/** 用单引号写字体名：XML 属性用双引号包，内部单引号不需要转义。 */
const FONT_FAMILY = "-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif";

/**
 * XML 转义。`&` 必须第一个换，否则后面换出来的 `&lt;` 会被二次转义成 `&amp;lt;`。
 * 节点文字完全来自用户输入/AI 产物，这里面混进 `<script>` 不是"会不会"的问题。
 */
export function escapeXml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 导出用的 viewport：画布 = 左留白 + 内容 + 右留白，不平移不缩放（除 zoom 外）。
 *
 * ⚠️ 这里原本写的是 `width = b.w`、`panX = 0`，**导出会裁掉右/下各 48px**（真缺陷，已修）：
 * `layoutDoc` 把内容平移到 `[pad, pad+内容宽]` 起，所以 `bbox.x` **就是内容最左坐标**（= pad），
 * 不是 0。而 `width = b.w` 等于假设内容从 0 开始 ⇒ 内容占 `[48, 48+w]`、画布只有 `[0, w]`，
 * 右边正好少 pad 那一截。预览路径看不出来（`viewportForSize` 有 `- b.x * z` 把 pad 抵掉了），
 * 所以只会在真导出时暴露 —— 正是本仓最怕的「预览好看、导出错位」。
 *
 * 为什么是 `b.x + b.w + b.x`（而不是 `panX: -b.x`）：后者把 pad 抵掉 = 内容贴死画布边缘，
 * 导出图四周零留白，贴进文档/群里很难看。pad 本来就是为留白设计的，留着它。
 * 两侧留白量都取 `b.x` / `b.y` —— layout 保证左右、上下各留一个 pad。
 */
export function fitViewport(layout, zoom = 1) {
  const b = (layout && layout.bbox) || { x: 0, y: 0, w: 0, h: 0 };
  return {
    width: Math.max(1, Math.ceil(b.x + b.w + b.x)),
    height: Math.max(1, Math.ceil(b.y + b.h + b.y)),
    panX: 0,
    panY: 0,
    zoom: clamp(Number(zoom) || 1, 0.2, 2.5),
  };
}

/**
 * 屏幕上的 viewport：按容器尺寸自动缩放并居中。
 * zoom 钳在 [0.2, 2.5] —— 再小字就看不清了（不如让用户拖动），再大就只剩一个节点。
 */
export function viewportForSize(layout, containerW, containerH) {
  const b = (layout && layout.bbox) || { x: 0, y: 0, w: 0, h: 0 };
  const cw = Math.max(1, Number(containerW) || 0);
  const ch = Math.max(1, Number(containerH) || 0);
  const pad = 24;
  const zoom = clamp(Math.min((cw - pad * 2) / Math.max(1, b.w), (ch - pad * 2) / Math.max(1, b.h)), 0.2, 2.5);
  // 先把 zoom 本身取到 2 位小数，再算 pan —— 否则 pan 是按未取整的 zoom 算的，
  // 两处精度不一致，内容会偏离容器中心零点几个像素（居中就不成立了）。
  const z = r2(zoom);
  return {
    width: cw,
    height: ch,
    panX: r2((cw - b.w * z) / 2 - b.x * z),
    panY: r2((ch - b.h * z) / 2 - b.y * z),
    zoom: z,
  };
}

function paletteOf(depth, palette = MM_PALETTE) {
  return palette[Math.min(palette.length - 1, Math.max(0, Number(depth) || 0))];
}

/**
 * 拼装 SVG。
 *
 * @param {object} args
 * @param {object} args.doc      用来读 note（showNote 时才用）
 * @param {object} args.layout   `layoutDoc` 的返回
 * @param {object} [args.viewport] 缺省 = fitViewport(layout, 1)（导出路径）
 * @param {string|null} [args.selectedId]
 * @param {boolean} [args.showNote]
 * @param {'light'|'dark'|string} [args.theme] 只影响**预览**配色；
 *        缺省/非 'dark' 一律走浅色品牌色板（= 导出那份交付物）
 * @returns {{markup:string,width:number,height:number}}
 */
export function buildSvg({ doc, layout, viewport, selectedId = null, showNote = false, theme = '' } = {}) {
  // 深色预览：换色板与画布底；其它一切（布局、留白、字号）不变。
  const dark = theme === 'dark';
  const palette = dark ? MM_PALETTE_DARK : MM_PALETTE;
  const canvasBg = dark ? MM_CANVAS_BG_DARK : MM_CANVAS_BG;
  const noteFill = dark ? '#9ba8a1' : '#5b7a6b';
  const lay = layout && Array.isArray(layout.nodes) ? layout : { nodes: [], edges: [], bbox: { x: 0, y: 0, w: 0, h: 0 } };
  // 逐字段兜底，**不是**整体兜底：只要调用方给了 viewport 对象，就一律用它的
  // panX/panY/zoom —— 缺 width/height 时只把画布尺寸按 bbox 补上。
  // 早先写成「viewport.width 不是正数就整个丢弃、改用 fitViewport」，后果是
  // UI 传 {zoom,panX,panY}（漏了 width/height）时平移量被静默吃掉，
  // 表现是"拖了不动、点了不跑"，而构建和单测都不会红 —— 这种静默降级不许留。
  const fit0 = fitViewport(lay, 1); // 只算一次：两个分支各算一遍迟早算出两份默认值
  const vp = viewport && typeof viewport === 'object' ? { ...fit0, ...viewport } : fit0;

  /**
   * 尺寸兜底：非有限正数（undefined / null / NaN / 0 / 负数 / 字符串垃圾）一律回落到
   * `fit0` 算出的默认尺寸。
   *
   * 两个坑都在这一个函数里：
   *   ① `{...defaults, ...viewport}` 对**显式 undefined/null 是覆盖不是跳过** —— 展开运算符
   *      不认识"这个字段没值"这回事，默认值被当场吃掉。所以不能靠 merge 兜底，必须在这里判。
   *   ② **不能**回落到 1。`Number(v) || 1` 对上面所有垃圾值都给出 1，于是产出 1×1 画布 ——
   *      导出是一张空白 PNG，不报错、不抛异常、构建和多数单测都不红，用户只会以为
   *      "导出功能坏了"。这是最难排查的一种静默降级：错的不是数值，是整张图没了。
   */
  const dimOf = (v, fallback) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.round(n));
    const f = Number(fallback);
    return Number.isFinite(f) && f > 0 ? Math.max(1, Math.round(f)) : 1;
  };
  const width = dimOf(vp.width, fit0.width);
  const height = dimOf(vp.height, fit0.height);
  const zoom = Number.isFinite(Number(vp.zoom)) && Number(vp.zoom) > 0 ? Number(vp.zoom) : 1;
  // pan 的兜底语义与尺寸不同：0 是**合法**的平移量，所以这里不能"回落"，只能把垃圾归零。
  const panX = Number(vp.panX) || 0;
  const panY = Number(vp.panY) || 0;

  const noteById = new Map();
  if (doc && Array.isArray(doc.nodes)) {
    for (const n of doc.nodes) if (n && n.id) noteById.set(n.id, String(n.note || ''));
  }

  const out = [];
  out.push(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height
      + '" viewBox="0 0 ' + width + ' ' + height + '" font-family="' + FONT_FAMILY + '">',
  );
  out.push('<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="' + canvasBg + '"/>');
  out.push('<g transform="translate(' + r2(panX) + ',' + r2(panY) + ') scale(' + r2(zoom) + ')">');

  const byId = new Map();
  for (const n of lay.nodes || []) byId.set(n.id, n);
  for (const e of lay.edges || []) {
    const child = byId.get(e.toId);
    const p = paletteOf(child ? child.depth : 1, palette);
    out.push(
      '<path d="' + escapeXml(e.path) + '" fill="none" stroke="' + p.stroke
        + '" stroke-width="' + (child && child.depth <= 1 ? 2 : 1.6) + '" stroke-linecap="round"/>',
    );
  }

  const lineH = MM_LAYOUT.lineH;
  const padY = MM_LAYOUT.nodePadY;
  for (const n of lay.nodes || []) {
    const p = paletteOf(n.depth, palette);
    const isSel = selectedId != null && n.id === selectedId;
    out.push('<g data-node-id="' + escapeXml(n.id) + '">');
    if (isSel) {
      // 外发光用"第二层描边"做：SVG 没有 box-shadow，滤镜在部分导出管线里不被支持
      out.push(
        '<rect x="' + r2(n.x) + '" y="' + r2(n.y) + '" width="' + r2(n.w) + '" height="' + r2(n.h)
          + '" rx="10" fill="none" stroke="' + p.stroke + '" stroke-width="6" opacity="0.35"/>',
      );
    }
    out.push(
      '<rect x="' + r2(n.x) + '" y="' + r2(n.y) + '" width="' + r2(n.w) + '" height="' + r2(n.h)
        + '" rx="10" fill="' + p.fill + '" stroke="' + p.stroke + '" stroke-width="' + (isSel ? 2.6 : 1.4) + '"/>',
    );

    const lines = Array.isArray(n.lines) && n.lines.length ? n.lines : [''];
    const fs = Number(n.depth) === 0 ? MM_LAYOUT.rootFontSize : MM_LAYOUT.fontSize;
    const cx = r2(n.x + n.w / 2);
    // 首行基线手算：字号的上沿大概在 0.78 个行高处，靠这个让 1 行文字在框里视觉居中
    let baseline = r2(n.y + padY + lineH * 0.78);
    out.push(
      '<text x="' + cx + '" y="' + baseline + '" text-anchor="middle" font-size="' + fs
        + '" font-weight="' + MM_LAYOUT.fontW + '" fill="' + p.text + '">',
    );
    lines.forEach((ln, i) => {
      const dy = i === 0 ? 0 : lineH;
      out.push('<tspan x="' + cx + '" dy="' + dy + '">' + escapeXml(ln) + '</tspan>');
    });
    out.push('</text>');

    const note = noteById.get(n.id) || '';
    if (showNote && note) {
      const short = note.length > 24 ? note.slice(0, 24) + '…' : note;
      out.push(
        '<text x="' + cx + '" y="' + r2(n.y + n.h + 14) + '" text-anchor="middle" font-size="11" fill="' + noteFill + '">'
          + escapeXml(short) + '</text>',
      );
    }
    out.push('</g>');
  }

  out.push('</g>');
  out.push('</svg>');
  return { markup: out.join(''), width, height };
}
