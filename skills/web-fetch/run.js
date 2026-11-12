// web-fetch：联网搜索 / 抓取网页正文。
// 两种用法：
//  1. query：联网搜索关键词，返回前几条结果的标题+摘要+链接（做网页/写文案前先搜参考）。
//  2. url：抓取指定网页，去掉 HTML 标签后返回可读正文。
//
// 健壮性：本站此前 3 处 fetch() 均无超时、无 signal —— 一个不响应的 URL 会让技能永久 pending，
// 进而把整个任务卡死（用户点「停止」也无效，因为模型请求的中断管不到这里的网络调用）。
// 现在每处 fetch 都：
//   · 带单次请求超时（默认 20s，可用 ctx.requestTimeoutMs 覆盖，见 requestTimeoutMs）；
//   · 透传 ctx.signal（来自 skills.js 的 AbortSignal，用户点「停止」时 abort）⇒ 可被即时取消。
module.exports.run = async (params, ctx) => {
  ctx = ctx || {};
  if (!ctx.allowNetwork) throw new Error('网络调用未开启');

  const query = String(params.query || '').trim();
  const url = String(params.url || '').trim();

  if (query) {
    return await search(query, ctx);
  }
  if (/^https?:\/\//i.test(url)) {
    return await fetchPage(url, ctx);
  }
  throw new Error('请提供 query（搜索关键词）或 url（要抓取的网页地址）');
};

// 单次 HTTP 请求超时（毫秒）。默认 20s：够慢站点响应，又不至于让任务永久挂住。
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 请求超时毫秒数：默认 20s；单测可通过 ctx.requestTimeoutMs 覆盖（不影响线上默认）。
function requestTimeoutMs(ctx) {
  const o = ctx && Number(ctx.requestTimeoutMs);
  return Number.isFinite(o) && o > 0 ? o : DEFAULT_REQUEST_TIMEOUT_MS;
}

// 组合「单次请求超时」+「上级叫停信号（ctx.signal）」为一个可传给 fetch 的 signal。
// 返回 { signal, timeoutSignal, parentSignal }，便于区分「超时」与「用户叫停」。
function makeRequestSignal(ctx, ms) {
  const timeoutSignal = AbortSignal.timeout(ms);
  const parentSignal = (ctx && ctx.signal) || null;
  let signal = timeoutSignal;
  if (parentSignal) {
    // node 20+ 支持 AbortSignal.any；退化情况下至少保证单次超时生效。
    signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  }
  return { signal, timeoutSignal, parentSignal };
}

// 可读的超时文案（模型/用户能看懂"多久没响应"）
function timeoutText(ctx) {
  const sec = requestTimeoutMs(ctx) / 1000;
  const shown = Number.isInteger(sec) ? String(sec) : String(Number(sec.toFixed(1)));
  return `错误：请求超时（${shown} 秒内未收到响应）`;
}

function stopText() {
  return '错误：任务已被用户停止。';
}

function hitTimeout(sig) {
  return !!(sig && sig.timeoutSignal && sig.timeoutSignal.aborted);
}

function hitAbort(sig) {
  return !!(sig && sig.parentSignal && sig.parentSignal.aborted);
}

// 去 HTML 标签 + 解实体，得到可读纯文本
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#0*(\d+);/g, (m, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ' '; }
    })
    .replace(/&#x0*([0-9a-f]+);/gi, (m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

async function search(query, ctx) {
  // DuckDuckGo 的 html 版（无 JS、无反爬重定向，适合后端抓取）
  const u = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const sig = makeRequestSignal(ctx, requestTimeoutMs(ctx));
  let html = '';
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: sig.signal });
    html = await res.text();
  } catch (e) {
    // 用户点了「停止」：不再兜底，直接如实结束。
    if (hitAbort(sig)) return stopText();
    // DuckDuckGo 失败（含超时）时退回 Bing —— 保留原有兜底逻辑。
    return await searchBing(query, ctx);
  }

  // 解析结果块：标题链接 .result__a，摘要 .result__snippet
  const items = [];
  const blockRe = /<div class="result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g;
  const matches = html.match(blockRe);
  if (matches) {
    for (const block of matches.slice(0, 6)) {
      const titleM = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const linkM = block.match(/class="result__a"[^>]*href="([^"]+)"/);
      const snipM = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      if (!titleM) continue;
      const title = stripHtml(titleM[1]);
      const link = linkM ? linkM[1] : '';
      const snippet = snipM ? stripHtml(snipM[1]) : '';
      if (title) items.push({ title, link, snippet });
    }
  }

  if (items.length === 0) {
    // 没解析到结果块，退回 Bing
    return await searchBing(query, ctx);
  }

  return '搜索「' + query + '」结果：\n' + items
    .map((it, i) => (i + 1) + '. ' + it.title + (it.snippet ? '\n   ' + it.snippet : '') + (it.link ? '\n   ' + it.link : ''))
    .join('\n') + '\n\n（如需更详细内容，可继续用「联网搜索」技能传 url 参数抓取上面某条链接的网页正文）';
}

async function searchBing(query, ctx) {
  const u = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
  const sig = makeRequestSignal(ctx, requestTimeoutMs(ctx));
  let html = '';
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: sig.signal });
    html = await res.text();
  } catch (e) {
    if (hitAbort(sig)) return stopText();
    if (hitTimeout(sig)) return timeoutText(ctx);
    return '搜索失败：' + e.message;
  }

  const items = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  const matches = html.match(blockRe);
  if (matches) {
    for (const block of matches.slice(0, 6)) {
      const titleM = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
      const linkM = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/);
      const snipM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (!titleM) continue;
      const title = stripHtml(titleM[1]);
      const link = linkM ? linkM[1] : '';
      const snippet = snipM ? stripHtml(snipM[1]) : '';
      if (title) items.push({ title, link, snippet });
    }
  }

  if (items.length === 0) {
    // 连 Bing 都没解析出来，返回纯文本前 1500 字兜底
    return '搜索「' + query + '」结果（原文）：\n' + stripHtml(html).slice(0, 1500);
  }

  return '搜索「' + query + '」结果：\n' + items
    .map((it, i) => (i + 1) + '. ' + it.title + (it.snippet ? '\n   ' + it.snippet : '') + (it.link ? '\n   ' + it.link : ''))
    .join('\n') + '\n\n（如需更详细内容，可继续用「联网搜索」技能传 url 参数抓取上面某条链接的网页正文）';
}

async function fetchPage(url, ctx) {
  const sig = makeRequestSignal(ctx, requestTimeoutMs(ctx));
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: sig.signal });
  } catch (e) {
    if (hitAbort(sig)) throw new Error(stopText());
    if (hitTimeout(sig)) throw new Error(timeoutText(ctx));
    throw new Error('错误：抓取网页失败：' + (e && e.message ? e.message : e));
  }
  const text = await res.text();
  const plain = stripHtml(text);
  // 截断，避免把整个大页面塞进聊天窗口
  return `状态 ${res.status}，正文 ${plain.length} 字符：\n\n${plain.slice(0, 4000)}`;
}

// 供单测复用的纯函数/常量
module.exports.stripHtml = stripHtml;
module.exports.makeRequestSignal = makeRequestSignal;
module.exports.requestTimeoutMs = requestTimeoutMs;
module.exports.DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
