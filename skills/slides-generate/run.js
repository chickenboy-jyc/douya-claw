// slides-generate —— 生成「单文件网页演示文稿」（HTML PPT）。
//
// 为什么做这个（2026-10-10 结论，改动前先读）：
//   旧的 ppt-generate（python + python-pptx）是**一份写死的固定模板**，能力天花板已被实测量化：
//     · 形状类型唯一 {'sp':20}（全是文本框）、图片 0、图表 0、每页形状数恒为 5、版式只有 1 种；
//     · 接口层只收 {title, slides:[{title,bullets[]}]} ⇒ 模型**没有参数能表达版面**；
//     · pptx 是 zip+OOXML 二进制包 ⇒ 生成完**无法渲染、无法截图**，文字一长就溢出而它看不见
//       （正好违反「完成状态由证据决定」）。
//   网页版一次解决上面全部：有版面（CSS）、能截图自检（browser-verify 直接开 file:// 或公网 URL）、
//   能发布成链接（deploy-static）。⇒ 故设为**默认演示文稿产出方式**，pptx 仅留给"明确要 .pptx 文件"。
//
// 产出契约（别改，上游按它登记成果卡）：
//   · 返回文本必须含 **绝对路径**，形如「已生成网页演示文稿：C:\...\xxx.html」；
//     backend.js 的 PRODUCER_SKILLS + extractPaths 靠它把文件登记进成果卡。
//   · ⚠️ 路径里**不能有空格**：extractPaths 的正则遇到空白即截断 ⇒ 文件名统一把空白换成下划线。
//   · 生成物是**单文件**（CSS/JS 全内联）⇒ 双击即看，不需要服务器、不需要联网。
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');

// 单次生成的容量上限：防止模型一次塞进几千条把文件撑爆（也顺带兜住模板渲染耗时）。
const MAX_SLIDES = 60;
const MAX_BULLETS_PER_SLIDE = 12;
const MAX_TEXT_LEN = 400;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clip(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n) : t;
}

// 文件名安全化：去掉 Windows 非法字符 + **所有空白**（路径含空格会被上游正则截断）。
function safeName(s, fallback) {
  const t = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[_]{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .trim();
  return t || fallback;
}

// slides 参数兼容三种写法：JSON 字符串 / 数组 / 换行分隔的纯文本。
// ★ 关键取舍：以 `{` / `[` 开头 = 明确想传 JSON。此时若解析失败**必须报错，绝不兜底成纯文本**
//   —— 否则 `'{不是数组'` 会被当成"一页标题"生成出来，还回报「已生成」，
//   用户拿到一份只有乱码标题的演示（门禁 D2 就是钉这条）。
function parseSlides(raw) {
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return null;
  const jsonLike = /^[[{]/.test(s);
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr;
    // 容错：模型有时给 {"slides":[...]} 而不是裸数组
    if (arr && Array.isArray(arr.slides)) return arr.slides;
    return null;
  } catch {
    if (jsonLike) return null; // 坏 JSON ⇒ 交给调用方报错（不许兜底）
    // 兜底：按空行分页、按行分点（模型偶尔给纯文本）
    return s.split(/\n\s*\n+/).map((block) => {
      const lines = block.split(/\n+/).map((x) => x.replace(/^\s*[-*·•\d.、)]+\s*/, '').trim()).filter(Boolean);
      if (!lines.length) return null;
      return { title: lines[0], bullets: lines.slice(1) };
    }).filter(Boolean);
  }
}

// ══════════ 版面白名单：这是「每次做出来都一样」的根治点（2026-11-03）══════════
// 【要治的病，老板原话】
//   「做网页 每次的网页都是一模一样 只要做网页就是单一模板，就算是完全不一样的内容
//     也会用同一个模板，PPT也是 完全不考虑适不适合。」
//
// 【根因不是模型不动脑，是产品只造了一个模具】
//   改造前本技能只渲染「标题 + 一列项目符号」（slideHtml 里唯一的 body 就是 <ul class="bl">），
//   接口层也没有任何能表达版面的参数；所谓「变化」只有 .v1~.v4 —— 那是**字号缩放**，不是版面。
//   于是不同主题的演示必然只有文字不同、版式完全一致。再聪明的模型也只是往同一个模子里灌内容。
//
// 【为什么是这几个，而不是给一堆模板让用户挑】
//   每个版面必须对应一种**内容结构**（并列 / 数字 / 对比 / 流程 / 引言 / 图文 / 章节），
//   这样「选版面」这件事就能由内容本身决定，而不靠模型瞎猜或审美偏好。
//   这也是它能被机器验证的前提：同一份文稿里版面全都相同 ⇒ 一定是没按内容选。
const LAYOUTS = ['bullets', 'cards', 'stats', 'compare', 'quote', 'steps', 'image', 'section'];

// 把 [{title,text}] / {a,b} / ["a","b"] 统一成 [{title,text}]
function normalizePairs(raw, max) {
  let arr = raw;
  if (arr == null) return [];
  if (typeof arr === 'string') arr = arr.split(/\n+/);
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((x) => {
    if (x == null) return null;
    if (typeof x === 'string') return { title: clip(x, MAX_TEXT_LEN), text: '' };
    if (typeof x !== 'object') return { title: clip(String(x), MAX_TEXT_LEN), text: '' };
    const t = x.title != null ? x.title : (x.label != null ? x.label : (x.left != null ? x.left : (x.name != null ? x.name : '')));
    const d = x.text != null ? x.text : (x.desc != null ? x.desc : (x.detail != null ? x.detail : (x.body != null ? x.body : '')));
    const o = { title: clip(t, 120), text: clip(d, MAX_TEXT_LEN) };
    // 对比版式的右栏：刻意保留空串（左栏有、右栏没有，本身就是"缺失"这个信息）
    if (x.right != null) o.right = clip(x.right, MAX_TEXT_LEN);
    return o;
  }).filter(Boolean).slice(0, max);
}

// 把一页的内容归一化成 { title, bullets: string[], layout, ... }
function normalizeSlide(s) {
  if (s == null) return null;
  if (typeof s === 'string') {
    const lines = s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return null;
    return { title: clip(lines[0], 80), bullets: lines.slice(1, 1 + MAX_BULLETS_PER_SLIDE).map((b) => clip(b, MAX_TEXT_LEN)), layout: 'bullets' };
  }
  const title = clip(s.title != null ? s.title : (s.heading || s.name || ''), 80);
  const rawLayout = String(s.layout || s.type || '').toLowerCase();
  const layout = LAYOUTS.includes(rawLayout) ? rawLayout : 'bullets';
  let bullets = s.bullets != null ? s.bullets : (s.points != null ? s.points : (s.content != null ? s.content : []));
  if (typeof bullets === 'string') bullets = bullets.split(/\n+/);
  if (!Array.isArray(bullets)) bullets = [];
  const out = bullets
    .map((b) => {
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (typeof b === 'object') return b.text != null ? String(b.text) : (b.title != null ? String(b.title) : '');
      return String(b);
    })
    .map((b) => clip(b, MAX_TEXT_LEN))
    .filter(Boolean)
    .slice(0, MAX_BULLETS_PER_SLIDE);

  // 结构化字段：只有对应版面才会用到，但**一律归一化**（不按 layout 裁剪）。
  // 为什么：模型经常同时给 bullets 和 items，或给了 items 却忘了改 layout。
  // 按 layout 裁剪会让"它明明给了内容却渲染成空页"，而不裁剪只是多算一次纯函数。
  const out2 = { title, bullets: out, layout };
  const items = normalizePairs(s.items != null ? s.items : (s.cards != null ? s.cards : s.steps), 6);
  if (items.length) out2.items = items;
  const stats = normalizePairs(s.stats != null ? s.stats : s.numbers, 4);
  if (stats.length) out2.stats = stats;
  const cmp = normalizePairs(s.compare != null ? s.compare : s.columns, 4);
  if (cmp.length) out2.compare = cmp;
  if (s.quote != null) out2.quote = clip(s.quote, MAX_TEXT_LEN);
  if (s.by != null) out2.by = clip(s.by, 80);
  // 对比版式的两栏表头：缺省时渲染端用「现状 / 目标」，但模型能自己命名就别替它编
  if (s.leftLabel != null) out2.leftLabel = clip(s.leftLabel, 30);
  if (s.rightLabel != null) out2.rightLabel = clip(s.rightLabel, 30);
  if (s.image != null) out2.image = clip(s.image, 2000); // 允许 data URI / 相对路径 / 绝对路径
  if (s.caption != null) out2.caption = clip(s.caption, MAX_TEXT_LEN);
  if (s.note != null) out2.note = clip(s.note, MAX_TEXT_LEN);
  if (s.brand != null) out2.brand = clip(s.brand, 60);

  // 「空页」判据必须把结构化内容也算上：只按 title+bullets 判，会让
  // 「stats 有 4 个数字但没有 bullets」的页被静默丢弃 —— 用户看到的少一页，且毫无提示。
  const hasStructured = !!(out2.items || out2.stats || out2.compare || out2.quote || out2.image);
  if (!title && !out.length && !hasStructured) return null;
  return out2;
}

// 每种版面的「最小可用条件」。缺字段时**必须回落到 bullets**，不许渲染空白页。
// 为什么不是直接渲染空容器：用户拿到一页只有标题的白板，会认为"它又偷懒了"，
// 而真相是模型少给了一个字段 —— 这两种情况对用户必须可区分，所以回落 + 在返回文本里如实计数。
const LAYOUT_REQUIRES = {
  cards: (s) => !!(s.items && s.items.length),
  stats: (s) => !!(s.stats && s.stats.length),
  compare: (s) => !!(s.compare && s.compare.length),
  quote: (s) => !!s.quote,
  steps: (s) => !!(s.items && s.items.length),
  // ★ image 的可用性必须按**归一后**的地址判，不能只看"有没有给 image 字段"：
  //   给了 http 外链 ⇒ imgSrc 会返回空 ⇒ 渲染出空 figure ⇒ 用户看到一页只有标题的白板。
  //   这种"看起来成功了"的空页最难查，所以判据要和渲染用同一个函数。
  image: (s) => !!imgSrc(s.image),
  section: () => true,
};

/** 解析这一页实际用哪个版面（含回落），返回 { layout, fellBack } */
function resolveLayout(s) {
  const want = s.layout && LAYOUTS.includes(s.layout) ? s.layout : 'bullets';
  const need = LAYOUT_REQUIRES[want];
  if (!need || need(s)) return { layout: want, fellBack: false };
  // 回落到最能表达"还剩什么"的那个：有 bullets 就列表，什么都没有就章节页
  return { layout: s.bullets && s.bullets.length ? 'bullets' : 'section', fellBack: true };
}

function slideHtml(s, isCover) {
  if (isCover) {
    const sub = s.subtitle ? '<p class="cover-sub">' + esc(s.subtitle) + '</p>' : '';
    const meta = s.meta ? '<p class="cover-meta">' + esc(s.meta) + '</p>' : '';
    return '<section class="slide active cover" data-page="1">' +
      '<div class="cover-mark"></div>' +
      '<h1 class="cover-title">' + esc(s.title) + '</h1>' + sub + meta +
      '<p class="cover-hint">按 → 翻页　·　F 全屏</p>' +
      '</section>';
  }
  const rl = resolveLayout(s);
  const body = layoutBody(s, rl.layout);
  return '<section class="slide ly-' + rl.layout + '" data-page="' + s.page + '" data-layout="' + rl.layout + '">' +
    '<h2 class="t">' + esc(s.title) + '</h2>' +
    '<div class="slide-body">' + body + '</div>' +
    '<div class="slide-foot"><span class="brand">' + esc(s.brand || '') + '</span></div>' +
    '</section>';
}

// 图片地址归一：**单文件纪律不允许外链**（原来 B12/B13 就在守这条：双击即看，不需要联网）。
// 外链图片不是"降级"而是"打不开"—— 用户拿到一份联网才显示图的演示，离线就全是破图。
function imgSrc(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  if (/^data:image\//i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return '';        // 外链：拒绝，调用方回落
  if (/^[a-zA-Z]:[\\/]/.test(v)) return 'file:///' + v.replace(/\\/g, '/'); // Windows 绝对路径
  if (v.startsWith('/')) return 'file://' + v;   // POSIX 绝对路径
  return v;                                       // 相对路径（与 HTML 同目录）
}

/** 按版面生成 .slide-body 内部 HTML。返回空串时调用方已保证回落。 */
function layoutBody(s, layout) {
  if (layout === 'cards') {
    return '<div class="lcards">' + s.items.map((it) =>
      '<div class="lcard"><h3>' + esc(it.title) + '</h3>' + (it.text ? '<p>' + esc(it.text) + '</p>' : '') + '</div>'
    ).join('') + '</div>';
  }
  if (layout === 'stats') {
    return '<div class="lstats">' + s.stats.map((st) =>
      '<div class="lstat"><b>' + esc(st.title) + '</b><span>' + esc(st.text) + '</span></div>'
    ).join('') + '</div>';
  }
  if (layout === 'compare') {
    // 对比必须**真的分左右两栏**，不能是"A：x / B：y"的字符串拼接 —— 后者版式上和列表没区别。
    const rows = s.compare.map((c) =>
      '<div class="lrow"><span class="lk">' + esc(c.title) + '</span>' +
      '<span class="lv">' + esc(c.text) + '</span>' +
      '<span class="lv">' + esc(c.right != null ? c.right : '') + '</span></div>'
    ).join('');
    return '<div class="lcmp"><div class="lrow lhead"><span class="lk"></span>' +
      '<span class="lv">' + esc(s.leftLabel || '现状') + '</span>' +
      '<span class="lv">' + esc(s.rightLabel || '目标') + '</span></div>' + rows + '</div>';
  }
  if (layout === 'quote') {
    return '<blockquote class="lquote"><p>' + esc(s.quote) + '</p>' +
      (s.by ? '<cite>— ' + esc(s.by) + '</cite>' : '') + '</blockquote>';
  }
  if (layout === 'steps') {
    return '<ol class="lsteps">' + s.items.map((it) =>
      '<li><b>' + esc(it.title) + '</b>' + (it.text ? '<p>' + esc(it.text) + '</p>' : '') + '</li>'
    ).join('') + '</ol>';
  }
  if (layout === 'image') {
    const src = imgSrc(s.image);
    if (!src) return ''; // 外链/空：交给 resolveLayout 的回落逻辑（这里已被 require 拦下，双保险）
    return '<figure class="limg"><img src="' + esc(src) + '" alt="' + esc(s.caption || '') + '">' +
      (s.caption ? '<figcaption>' + esc(s.caption) + '</figcaption>' : '') + '</figure>';
  }
  if (layout === 'section') {
    // 章节过渡页：只有一句主张。用 bullets 反而会把"过渡"变成"又一页列表"。
    return s.bullets && s.bullets.length
      ? '<p class="lsec">' + esc(s.bullets[0]) + '</p>'
      : '';
  }
  // bullets（默认，也是所有版面的回落目标）
  const items = s.bullets.map((b) => '<li>' + esc(b) + '</li>').join('');
  return items ? '<ul class="bl">' + items + '</ul>' : '';
}

function buildHtml(o) {
  const slidesHtml = o.pages.map((p, i) => slideHtml(p, i === 0)).join('\n    ');
  const total = o.pages.length;
  return '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>' + esc(o.title) + '</title>\n' +
'<style>\n' + o.css + '\n</style>\n' +
'</head>\n' +
'<body>\n' +
'  <div id="stage">\n    ' + slidesHtml + '\n  </div>\n' +
'  <div id="hud">\n' +
'    <span id="pager">1 / ' + total + '</span>\n' +
'    <button id="fs" type="button" title="全屏（F）">全屏</button>\n' +
'  </div>\n' +
'  <script>\n' + o.js + '\n</script>\n' +
'</body>\n' +
'</html>\n';
}

// —— 运行时代码：刻意写成 ES5 + 字符串拼接，**不使用反引号**。
// 原因：整段是内嵌在一个 JS 模板字符串里的，若这里也用反引号/ `${` 会提前结束外层模板。
const RUNTIME_JS = [
  '(function () {',
  '  var slides = [].slice.call(document.querySelectorAll(".slide"));',
  '  if (!slides.length) return;',
  '  var pager = document.getElementById("pager");',
  '  var idx = 0;',
  '',
  // ⚠️ 关键：非当前页是 display:none，此时 scrollHeight/clientHeight 恒为 0 ⇒ **测不出溢出**。
  //    必须先临时加 .measure（保留布局、只是看不见）再量，否则「自动降字号」形同虚设。
  '  function fitOne(s) {',
  '    var body = s.querySelector(".slide-body");',
  '    if (!body) return;',
  '    var needMeasure = !s.classList.contains("active");',
  '    if (needMeasure) s.classList.add("measure");',
  '    body.className = "slide-body";',
  '    var g = 0;',
  '    while (body.scrollHeight > body.clientHeight + 2 && g < 4) { g++; body.classList.add("v" + g); }',
  '    if (needMeasure) s.classList.remove("measure");',
  '  }',
  '',
  '  function fit() { for (var i = 0; i < slides.length; i++) fitOne(slides[i]); }',
  '',
  '  function show(n) {',
  '    if (n < 0) n = 0;',
  '    if (n > slides.length - 1) n = slides.length - 1;',
  '    for (var i = 0; i < slides.length; i++) slides[i].classList.toggle("active", i === n);',
  '    idx = n;',
  '    if (pager) pager.textContent = (idx + 1) + " / " + slides.length;',
  '    try { history.replaceState(null, "", "#" + (idx + 1)); } catch (e) {}',
  '  }',
  '',
  '  function rescale() {',
  '    var s = Math.min(window.innerWidth / 1280, window.innerHeight / 720);',
  '    document.documentElement.style.setProperty("--s", String(s));',
  '  }',
  '',
  '  function toggleFs() {',
  '    if (document.fullscreenElement) document.exitFullscreen();',
  '    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();',
  '  }',
  '',
  '  document.addEventListener("keydown", function (e) {',
  '    var k = e.key;',
  '    if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " " || k === "Enter") { e.preventDefault(); show(idx + 1); }',
  '    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") { e.preventDefault(); show(idx - 1); }',
  '    else if (k === "Home") { e.preventDefault(); show(0); }',
  '    else if (k === "End") { e.preventDefault(); show(slides.length - 1); }',
  '    else if (k === "f" || k === "F") { toggleFs(); }',
  '  });',
  '',
  '  document.addEventListener("click", function (e) {',
  '    if (e.target && e.target.closest && e.target.closest("#hud")) return;',
  '    show(idx + (e.clientX > window.innerWidth / 2 ? 1 : -1));',
  '  });',
  '',
  '  var fsBtn = document.getElementById("fs");',
  '  if (fsBtn) fsBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleFs(); });',
  '',
  '  window.addEventListener("resize", rescale);',
  '',
  '  // 支持 #3 直达第 3 页 —— 便于自动化截图逐页验收',
  '  var m = /^#(\\d+)$/.exec(location.hash || "");',
  '  var start = m ? (parseInt(m[1], 10) - 1) : 0;',
  '  rescale();',
  '  show(isNaN(start) ? 0 : start);',
  '  fit();',
  '  window.addEventListener("load", function () { rescale(); fit(); });',
  '})();',
].join('\n');

// —— 样式：白底 + 绿色主题 + 苹果风（圆角 / 浅阴影 / 系统字体），对齐本产品 UI 语言。
// 深色主题只换变量，不改结构。
const CSS_BASE = [
  ':root{--s:1;--bg:#f4f8f5;--card:#ffffff;--ink:#16241c;--ink2:#4a5f53;--line:#e2ece6;',
  '--brand:#16a34a;--brand2:#0f8a3d;--accent:#dcfce7;--shadow:0 10px 34px rgba(16,48,32,.10)}',
  '.dark{--bg:#0f1512;--card:#17211b;--ink:#eaf5ee;--ink2:#9db4a7;--line:#26362d;',
  '--brand:#3ddc84;--brand2:#22c55e;--accent:#14301f;--shadow:0 10px 34px rgba(0,0,0,.45)}',
  '*{box-sizing:border-box}',
  'html,body{height:100%;margin:0}',
  'body{background:var(--bg);color:var(--ink);overflow:hidden;',
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
  '-webkit-font-smoothing:antialiased}',
  '#stage{position:absolute;left:50%;top:50%;width:1280px;height:720px;',
  'transform-origin:center center;transform:translate(-50%,-50%) scale(var(--s))}',
  '.slide{position:absolute;inset:0;display:none;flex-direction:column;',
  'padding:64px 76px;background:var(--card);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}',
  '.slide.active{display:flex}',
  // 测量用：可见性隐藏但**保留布局**，供 fit() 在非当前页上量真实内容高度（否则恒为 0 ⇒ 测不出溢出）
  '.slide.measure{display:flex;visibility:hidden}',
  '.slide .t{margin:0 0 26px;font-size:40px;line-height:1.2;letter-spacing:-.4px;color:var(--ink);',
  'padding-left:18px;border-left:7px solid var(--brand);font-weight:700}',
  '.slide-body{flex:1;min-height:0;overflow:hidden}',
  '.bl{margin:0;padding:0;list-style:none}',
  '.bl li{position:relative;padding:14px 0 14px 34px;font-size:26px;line-height:1.5;color:var(--ink2);',
  'border-bottom:1px solid var(--line)}',
  '.bl li:last-child{border-bottom:0}',
  '.bl li:before{content:"";position:absolute;left:6px;top:26px;width:11px;height:11px;border-radius:50%;',
  'background:var(--brand);box-shadow:0 0 0 4px var(--accent)}',
  '.slide-body.v1 .bl li{font-size:23px;padding-top:11px;padding-bottom:11px}',
  '.slide-body.v1 .bl li:before{top:22px}',
  '.slide-body.v2 .bl li{font-size:20px;padding-top:9px;padding-bottom:9px}',
  '.slide-body.v2 .bl li:before{top:19px}',
  '.slide-body.v3 .bl li{font-size:18px;padding-top:7px;padding-bottom:7px}',
  '.slide-body.v3 .bl li:before{top:17px}',
  '.slide-body.v4 .bl li{font-size:16px;padding-top:6px;padding-bottom:6px;line-height:1.45}',
  '.slide-body.v4 .bl li:before{top:14px;width:9px;height:9px}',
  '.slide-foot{display:flex;justify-content:flex-end;margin-top:14px}',
  '.brand{font-size:15px;color:var(--ink2);opacity:.75}',
  '.cover{justify-content:center;align-items:flex-start;background:var(--card)}',
  '.cover-mark{width:88px;height:8px;border-radius:8px;background:var(--brand);margin-bottom:34px}',
  '.cover-title{margin:0 0 18px;font-size:62px;line-height:1.16;letter-spacing:-1px;font-weight:800;color:var(--ink)}',
  '.cover-sub{margin:0 0 10px;font-size:26px;line-height:1.5;color:var(--ink2)}',
  '.cover-meta{margin:0;font-size:18px;color:var(--ink2);opacity:.85}',
  '.cover-hint{position:absolute;left:76px;bottom:56px;margin:0;font-size:16px;color:var(--ink2);opacity:.7}',
  '#hud{position:fixed;right:22px;bottom:18px;display:flex;gap:12px;align-items:center;',
  'font-size:15px;color:var(--ink2);z-index:9}',
  '#fs{border:1px solid var(--line);background:var(--card);color:var(--ink2);border-radius:10px;',
  'padding:6px 14px;font-size:14px;cursor:pointer;font-family:inherit}',
  '#fs:hover{color:var(--brand);border-color:var(--brand)}',
  '@media print{html,body{overflow:visible;height:auto;background:#fff}',
  '#stage{position:static;transform:none;width:auto;height:auto}',
  '.slide{position:static;display:flex !important;page-break-after:always;box-shadow:none;border-radius:0}',
  '#hud{display:none}}',
].join('');

const CSS_DARK_EXTRA = ''; // 深色只换变量，无需额外规则（保留常量以便日后扩展）

// ══════════ 版面样式（2026-11-03 新增）══════════
// 【为什么必须单独一段，而不是塞进 CSS_BASE】
//   上面 CSS_BASE 里的 .v1~.v4 只改字号，四个"版本"的版面**完全一样**。
//   老板说的"每次都一模一样"就是这个：字小一点不算换了版式。
//   这里是结构级差异（分栏 / 网格 / 大数字 / 引言 / 时间线 / 图文），彼此不可互换。
//
// 纪律：全部沿用 CSS_BASE 定义的变量（--ink / --ink2 / --line / --brand / --card），
//   这样换 palette 或 dark 时新版面自动跟着变 —— 否则会出现"深色主题下某一块还是白底"。
const CSS_LAYOUT = [
  // —— cards：并列要点。2~3 列自适应（4 张以上自动换行，不强行挤成一排）——
  '.lcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;height:100%;align-content:center}',
  '.lcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 22px;',
  'border-top:4px solid var(--brand);display:flex;flex-direction:column;gap:10px}',
  '.lcard h3{margin:0;font-size:23px;line-height:1.35;color:var(--ink);font-weight:700}',
  '.lcard p{margin:0;font-size:17px;line-height:1.6;color:var(--ink2)}',
  // —— stats：大数字。数字是主角，标签是配角，字号差 3 倍以上才有"读一眼就懂"的效果 ——
  '.lstats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px;height:100%;align-content:center}',
  '.lstat{display:flex;flex-direction:column;gap:8px;align-items:flex-start;',
  'padding:22px 24px;background:var(--card);border-radius:14px;border-left:5px solid var(--brand)}',
  '.lstat b{font-size:56px;line-height:1.05;font-weight:800;color:var(--brand);letter-spacing:-2px}',
  '.lstat span{font-size:17px;line-height:1.5;color:var(--ink2)}',
  // —— compare：真两栏。列宽用 1fr 1fr 保证左右等宽，否则长文本一侧会把另一侧挤扁 ——
  '.lcmp{display:flex;flex-direction:column;height:100%;justify-content:center;gap:2px}',
  '.lcmp .lrow{display:grid;grid-template-columns:1.1fr 1.6fr 1.6fr;gap:14px;align-items:start;',
  'padding:13px 16px;border-bottom:1px solid var(--line);font-size:18px;line-height:1.5}',
  '.lcmp .lrow:last-child{border-bottom:0}',
  '.lcmp .lhead{font-size:15px;font-weight:700;color:var(--brand);letter-spacing:.5px;',
  'border-bottom:2px solid var(--brand);padding-bottom:10px}',
  '.lcmp .lk{color:var(--ink);font-weight:600}',
  '.lcmp .lv{color:var(--ink2)}',
  // —— quote：引言居中，字号必须显著大于正文，否则读起来像一段普通段落 ——
  '.lquote{display:flex;flex-direction:column;justify-content:center;height:100%;margin:0;',
  'padding:0 40px;border-left:0;text-align:left}',
  '.lquote p{margin:0 0 22px;font-size:34px;line-height:1.45;color:var(--ink);font-weight:600;letter-spacing:-.3px}',
  '.lquote cite{font-size:19px;color:var(--ink2);font-style:normal;opacity:.9}',
  // —— steps：编号流程。用计数器画大号序号，不依赖 <ol> 默认样式（各浏览器差异大）——
  '.lsteps{list-style:none;margin:0;padding:0;counter-reset:st;',
  'display:flex;flex-direction:column;gap:14px;height:100%;justify-content:center}',
  '.lsteps li{counter-increment:st;position:relative;padding-left:66px;min-height:44px}',
  '.lsteps li:before{content:counter(st);position:absolute;left:0;top:0;width:44px;height:44px;',
  'border-radius:50%;background:var(--brand);color:var(--card);display:flex;align-items:center;',
  'justify-content:center;font-size:20px;font-weight:800}',
  '.lsteps li b{display:block;font-size:22px;color:var(--ink);font-weight:700;line-height:1.4}',
  '.lsteps li p{margin:5px 0 0;font-size:17px;line-height:1.55;color:var(--ink2)}',
  // —— image：图文。max-height 锁 100% 防止竖图把页撑破（撑破后 fitOne 也救不回来）——
  '.limg{margin:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}',
  '.limg img{max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;',
  'box-shadow:0 6px 26px rgba(0,0,0,.18)}',
  '.limg figcaption{font-size:16px;color:var(--ink2);opacity:.9}',
  // —— section：章节过渡页。隐藏普通标题位，让那一句主张独占视线 ——
  '.slide.ly-section{justify-content:center}',
  '.slide.ly-section .t{font-size:20px;border-left:0;padding-left:0;color:var(--brand);',
  'letter-spacing:3px;text-transform:uppercase;margin-bottom:18px}',
  '.slide.ly-section .slide-body{flex:0 0 auto}',
  '.lsec{margin:0;font-size:52px;line-height:1.25;font-weight:800;color:var(--ink);letter-spacing:-1.2px}',
].join('');


async function run(params = {}) {
  const title = clip(params.title, 120);
  if (!title) return '错误：请提供演示文稿标题（title）';
  const raw = params.slides;
  if (raw == null || raw === '') return '错误：请提供每页内容（slides，JSON 数组 [{title,bullets:[...]}]）';
  let arr = parseSlides(raw);
  if (!arr || !arr.length) {
    return '错误：slides 不是合法 JSON 数组。请传形如 [{"title":"本页标题","bullets":["要点1","要点2"]}] 的 JSON 数组。';
  }
  if (arr.length > MAX_SLIDES) arr = arr.slice(0, MAX_SLIDES);

  const covers = arr.map(normalizeSlide).filter(Boolean);
  if (!covers.length) return '错误：slides 里没有任何有效内容页（每项至少要有 title 或 bullets）。';

  // ★ 这里原来写的是 `{ title: s.title, bullets: s.bullets, page: i + 2 }` —— 只挑了这两个字段。
  //   后果：normalizeSlide 里明明归一化了 layout / items / stats / compare / quote，到这里**全被丢掉**，
  //   渲染端永远看不到版面信息 ⇒ 默认恒为 bullets。这就是「接口层没有参数能表达版面」的真身，
  //   它藏在这一行而不是 manifest，所以从接口文档上完全看不出来。
  const pages = [{
    cover: true,
    title,
    subtitle: clip(params.subtitle, 160),
    meta: clip(params.meta, 120),
  }].concat(covers.map((s, i) => Object.assign({}, s, { page: i + 2 })));

  const dark = String(params.theme || '').toLowerCase() === 'dark';
  const html = buildHtml({
    title,
    pages,
    css: CSS_BASE + CSS_LAYOUT + CSS_DARK_EXTRA,
    js: RUNTIME_JS,
  }).replace('<body>', '<body' + (dark ? ' class="dark"' : '') + '>');

  // 输出路径：默认按标题命名；文件名里的空白统一换成下划线（上游正则遇空白会截断路径）。
  // ★ 越界输入（如 filename="../evil.html"）由 safeName 净化掉分隔符 ⇒ **写点始终落在工作区内**（安全），
  //   但净化是"静默改名"，用户会找不到文件 ⇒ 必须**显式告知**改成了什么。
  const explicit = params.filename != null && String(params.filename).trim() !== '';
  const rawName = explicit ? String(params.filename).trim() : title;
  const base = safeName(rawName, '演示文稿');
  const fileName = safeName(base, '演示文稿').replace(/\.html?$/i, '') + '.html';
  // ⚠️ 越界判定必须用 path.relative，**不能用 startsWith 比字符串**（实测踩到的真 bug）：
  //    Windows 上 path.resolve 会把正斜杠归一成反斜杠；若 AGENT_WORKSPACE 本身是正斜杠形式
  //    （测试/显式配置里很常见，如 "C:/Users/x/workspace"），`full.startsWith(WORKSPACE)` 恒为 false
  //    ⇒ **合法写入被全部拒绝**，报「不允许写到工作区外的路径」，看着像安全检查其实是坏的。
  const wsRoot = path.resolve(WORKSPACE);
  const full = path.resolve(wsRoot, fileName);
  const relToWs = path.relative(wsRoot, full);
  if (relToWs.startsWith('..') || path.isAbsolute(relToWs)) return '错误：不允许写到工作区外的路径';
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, html, 'utf-8');

  const renamed = explicit && safeName(rawName, '') !== rawName;
  const bytes = Buffer.byteLength(html, 'utf-8');
  const contentPages = pages.length - 1;

  // ★ 版面单一性自检（2026-11-03）—— 如实说出来，但**不阻断生成**。
  // 【为什么是"说出来"而不是"自动改版面"】
  //   自动改等于替模型猜内容结构；猜错了用户拿到一份自以为漂亮、实际对不上的演示，比单调更糟。
  //   而完全不提就是改造前的病：用户拿到"每次都一样"的东西，系统一个字都不说，
  //   于是问题永远只在用户嘴里、永远进不了下一轮的输入。
  // 【为什么必须在这返回文本里，而不是只写 trace】
  //   模型的下一轮动作由它看到的工具返回值决定。写在 trace 里没人读，写在这里它才会自己回头重排。
  const layStats = {};
  const fellBacks = [];
  for (const s of covers) {
    const r = resolveLayout(s);
    layStats[r.layout] = (layStats[r.layout] || 0) + 1;
    if (r.fellBack) fellBacks.push(s.title || '(无标题页)');
  }
  const layoutKinds = Object.keys(layStats);
  let advice = '';
  if (covers.length >= 3 && layoutKinds.length === 1) {
    advice += '\n⚠️ 这份 ' + covers.length + ' 页内容**全都用了「' + layoutKinds[0] + '」一种版面**，'
      + '看起来会像同一个模板。如果有并列模块就改 cards、有具体数字就改 stats、'
      + '有前后对照就改 compare、有先后顺序就改 steps —— 重出一份版式会完全不同。';
  } else if (covers.length >= 3 && layoutKinds.length === 2 && layStats[layoutKinds[0]] >= covers.length - 1) {
    advice += '\n（提示：' + covers.length + ' 页里 ' + layStats[layoutKinds[0]] + ' 页用了同一种版面，'
      + '版面种类偏少，读者会觉得每页长得一样。）';
  }
  if (fellBacks.length) {
    advice += '\n注：' + fellBacks.length + ' 页指定了 layout 但缺对应字段，已回落成列表 —— '
      + fellBacks.slice(0, 3).join('、') + (fellBacks.length > 3 ? ' 等' : '') + '。把字段补齐就能用上该版面。';
  }

  return '已生成网页演示文稿：' + full + '（封面 + ' + contentPages + ' 页内容，共 ' + pages.length + ' 页，' +
    (bytes / 1024).toFixed(1) + ' KB，版面：' + layoutKinds.join(' / ') + '）。' +
    '双击用浏览器打开即可演示：按 → 或点右半边翻页、F 全屏；也可用 URL 末尾加 #3 直达第 3 页。' +
    (dark ? '（深色主题）' : '') +
    (renamed ? '注：你给的文件名含空格或不能用的字符，已自动改成「' + fileName + '」。' : '') +
    advice;
}

module.exports = { run, parseSlides, normalizeSlide, safeName, buildHtml, MAX_SLIDES, LAYOUTS, resolveLayout };
