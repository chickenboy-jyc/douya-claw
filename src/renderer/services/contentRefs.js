/**
 * 内容创作页「参考资料上传」的**纯逻辑层**：把「用户选中的文件」变成「真正带正文的 refs 文本」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这一层（这次修的是真缺陷，不是重构）
 * ────────────────────────────────────────────────────────────────────────────
 * 0.21.25 之前 `ContentOps.jsx` 的 `collectRefs()` 只拼**文件名**：
 *     `...files.map((f) => '【参考资料文件】' + f)`
 * 而卡片文案写着「上传文件或粘贴正文，生成时豆芽会参考这些内容」——
 * 用户传上去的正文一个字都没进 prompt。这是**假承诺**，老板点名要修。
 *
 * 修法受两条硬约束：
 *   ① 本机没有任何 docx / pdf / xlsx 解析库（package.json 里没有 mammoth / pdf-parse / xlsx），
 *      也不许为这件事装依赖 ⇒ **二进制文档的正文读不出来，这是真壁垒**。
 *   ② 只有 `window.api.readFileText(p, maxBytes)` 这一个读文本的通道（main 侧只读 utf-8）。
 * ⇒ 规则：**能读的真读，读不了的如实说，绝不假装**。每个文件都必须有一个可见状态，
 *    状态由本文件的 `planRefs()` 统一算出来 —— 界面显示的、和真正拼进 prompt 的，
 *    必须是**同一份计划**，否则又会变成「界面说读了、实际没读」。
 *
 * 本文件不碰 React、不碰 window、不发请求：只做纯函数变换，便于被门禁脚本直接跑。
 */

/** 单个文件最多带进 prompt 的字符数（超出截断，且必须写进状态里，不许静默）。 */
export const PER_FILE_CHAR_LIMIT = 20000;

/** 全部参考资料（所有文件正文 + 粘贴正文）合计上限（字符）。 */
export const TOTAL_CHAR_LIMIT = 60000;

/** 一次最多登记多少个文件（沿用原 UI 的 8 个上限，避免右栏被文件列表撑爆）。 */
export const MAX_FILE_ENTRIES = 8;

/**
 * 读文件时向 main 申请的字节上限。
 *
 * 为什么是 2MB：`src/main/main.js:213` 的 `file:readText` 默认上限就是 2MB，
 * 超过会直接返回 `{ok:false, error:'文件过大（…KB，超过 …KB 上限）'}`。
 * 这里显式传同一个值（而不是让 main 用默认值），是为了让「上限是多少」在渲染层可读、
 * 可注释、可改 —— 不要依赖别人文件里的默认值。
 * 注意：2MB 文本 ≫ 20000 字符的上限，所以真正决定喂给模型多少字的是 `PER_FILE_CHAR_LIMIT`，
 * 这个字节上限只决定「多大的文件我们压根不读」。
 */
export const READ_MAX_BYTES = 2 * 1024 * 1024;

/** 纯文本类扩展名：这些扩展名下的文件是真 utf-8 文本，`readFileText` 读出来就是正文。 */
export const TEXT_EXTS = [
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'html', 'htm', 'css', 'scss', 'less',
  'log', 'xml', 'yml', 'yaml', 'ini', 'conf', 'toml',
  'sql', 'sh', 'bash', 'bat', 'ps1', 'rst',
];

/**
 * 二进制文档扩展名：**不读**。
 *
 * 这不是偷懒：docx/xlsx/pptx 是 zip 包、doc/xls/ppt 是 OLE 复合文档、pdf 是压缩对象流，
 * 用 `buf.toString('utf8')` 读出来必然是乱码（还会把乱码当真正文塞给模型，比不读更糟）。
 * 本机没有解析器 ⇒ 标「未支持，请粘贴正文」，把选择权交回用户。
 */
export const BINARY_DOC_EXTS = ['docx', 'doc', 'pdf', 'xlsx', 'xls', 'pptx', 'ppt'];

/** 自增种子：同一批里多个同名文件也不能撞 id（不能只用文件名当 key）。 */
let entrySeed = 0;

/**
 * 取路径/文件名的最后一段。
 *
 * @param {string} p 绝对路径或文件名
 * @returns {string} 最后一段；空输入返回空串
 */
export function baseNameOf(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  const parts = s.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last || s;
}

/**
 * 取小写扩展名（不带点）。没有扩展名、或文件名以点开头（如 `.env`）时返回空串。
 *
 * @param {string} name 文件名（可含路径）
 * @returns {string} 小写扩展名
 */
export function extOf(name) {
  const base = baseNameOf(name);
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

/**
 * 按扩展名给文件分类。
 *
 * @param {string} name 文件名（可含路径）
 * @returns {'text'|'binary'|'unknown'} text=能读正文；binary=本机无解析器；unknown=试读
 */
export function classifyFile(name) {
  const ext = extOf(name);
  if (TEXT_EXTS.indexOf(ext) >= 0) return 'text';
  if (BINARY_DOC_EXTS.indexOf(ext) >= 0) return 'binary';
  return 'unknown';
}

/**
 * 造一条「参考资料文件」条目。
 *
 * 初始状态 `pending`（读取中）：`pickRefFiles()` 会先把它塞进 state 让界面立刻有反馈，
 * 再逐个读盘、用 `applyReadResult()` 换成终态。**永远不要**在没有终态时把它当已读。
 *
 * @param {{name?:string, path?:string}} spec 文件名与（可选）绝对路径
 * @returns {{id:string, name:string, path:string, kind:string, status:string, content:string, chars:number, error:string}}
 */
export function makeRefEntry(spec) {
  const s = spec || {};
  const name = String(s.name || baseNameOf(s.path) || '未命名文件');
  entrySeed += 1;
  return {
    id: 'ref-' + entrySeed + '-' + name,
    name,
    path: String(s.path || ''),
    kind: classifyFile(name),
    status: 'pending',
    content: '',
    chars: 0,
    error: '',
  };
}

/**
 * 把 `window.api.readFileText()` 的回包落到条目上。
 *
 * 契约（见 `src/main/preload.js:32` / `src/main/main.js:213`）：
 *   `{ok:true, content, size, name}` | `{ok:false, error}`
 * 失败原因**原样保留**（「文件过大（3072KB，超过 2048KB 上限）」这种话要能显出来），
 * 不要归并成一句「读取失败」—— 用户得知道是"太大"还是"坏了"。
 *
 * @param {Object} entry `makeRefEntry()` 产出的条目
 * @param {{ok?:boolean, content?:string, error?:string}|null} res 读文件回包
 * @returns {Object} 新条目（不原地改）
 */
export function applyReadResult(entry, res) {
  const base = entry || makeRefEntry({});
  if (!res || res.ok !== true) {
    const err = String((res && res.error) || '未知原因');
    return { ...base, status: 'failed', content: '', chars: 0, error: err };
  }
  const content = String(res.content == null ? '' : res.content);
  return { ...base, status: 'ok', content, chars: content.length, error: '' };
}

/**
 * 生成显示用的 header（括号注释放**括号里**，保持「【参考资料文件 X】」这个既有形状）。
 *
 * @param {string} name 文件名
 * @param {string} [note] 括号里的说明
 * @returns {string} header 文本
 */
function refHeader(name, note) {
  return note ? '【参考资料文件 ' + name + '（' + note + '）】' : '【参考资料文件 ' + name + '】';
}

/**
 * 统一的截断说明句（截断必须留痕，绝不静默）。
 *
 * @param {number} kept 实际保留字数
 * @param {number} total 原文字数
 * @returns {string} 说明句
 */
function truncationNote(kept, total) {
  return '（正文已截断：保留前 ' + kept + ' 字，原文 ' + total + ' 字）';
}

/**
 * 算出「这一批参考资料到底会给模型什么」——**界面和 prompt 的唯一真源**。
 *
 * 返回的 `items` 与入参 `entries` **下标一一对应**（界面直接按 `items[i]` 取状态），
 * `block` 就是 `collectRefs()` 的返回值，会被 `contentChat.js` 拼进 prompt。
 *
 * 记账规则：只有**正文**字符计入 `TOTAL_CHAR_LIMIT`，header / 截断说明句不计
 * （它们是几十个字符的固定开销，把它们算进预算会让「上限 60000 字」这句话变得没法解释）。
 *
 * @param {Array<Object>} entries `makeRefEntry()`/`applyReadResult()` 产出的条目数组
 * @param {string} [pastedText] 用户粘贴的正文
 * @returns {{block:string, items:Array<{key:string,name:string,tone:string,text:string}>, totalChars:number}}
 */
export function planRefs(entries, pastedText) {
  const list = Array.isArray(entries) ? entries : [];
  const blocks = [];
  const items = [];
  let remaining = TOTAL_CHAR_LIMIT;
  let totalChars = 0;

  list.forEach((rawEntry) => {
    const entry = rawEntry || {};
    const name = String(entry.name || '未命名文件');
    const content = String(entry.content || '');
    const chars = content.length;
    const key = String(entry.id || name);
    const status = String(entry.status || 'pending');

    // —— 读不出正文的三类：如实标，不假装读过 ——
    if (status === 'unsupported') {
      blocks.push(refHeader(name, '正文未读取：本机没有该格式的解析器，请把正文粘贴到下方输入框'));
      items.push({ key, name, tone: 'warn', text: '未支持：本机无该格式解析器，请粘贴正文' });
      return;
    }
    if (status === 'failed') {
      const err = String(entry.error || '未知原因');
      blocks.push(refHeader(name, '正文未读取：' + err));
      items.push({ key, name, tone: 'bad', text: '读取失败：' + err });
      return;
    }
    if (status === 'name-only') {
      blocks.push(refHeader(name, '未读取：当前环境读不到磁盘文件，仅登记文件名'));
      items.push({ key, name, tone: 'muted', text: '仅登记文件名（当前环境读不到磁盘）' });
      return;
    }
    if (status !== 'ok') {
      blocks.push(refHeader(name, '正文未读取：文件仍在读取中'));
      items.push({ key, name, tone: 'muted', text: '读取中…' });
      return;
    }

    // —— status === 'ok'：正文到手了 ——
    if (!content.trim()) {
      blocks.push(refHeader(name, '正文为空：文件里没有可读文本'));
      items.push({ key, name, tone: 'warn', text: '正文为空（0 字）' });
      return;
    }

    // 先卡单文件上限，再卡合计预算：两个上限都可能是"截断"的真因。
    const perFileKept = Math.min(chars, PER_FILE_CHAR_LIMIT);
    const kept = Math.min(perFileKept, remaining);
    if (kept <= 0) {
      blocks.push(refHeader(name, '正文未纳入：参考资料合计已达 ' + TOTAL_CHAR_LIMIT + ' 字上限'));
      items.push({ key, name, tone: 'warn', text: '未纳入：合计已达 ' + TOTAL_CHAR_LIMIT + ' 字上限' });
      return;
    }

    remaining -= kept;
    totalChars += kept;
    let block = refHeader(name) + '\n' + content.slice(0, kept);
    if (kept < chars) block += '\n' + truncationNote(kept, chars);
    blocks.push(block);
    items.push({
      key,
      name,
      tone: kept < chars ? 'warn' : 'ok',
      text: kept < chars
        ? '已读取 ' + chars + ' 字，已截断至 ' + kept + ' 字（原文 ' + chars + ' 字）'
        : '已读取 ' + chars + ' 字',
    });
  });

  // —— 粘贴正文：与文件正文共用同一个预算 ——
  const pasted = String(pastedText == null ? '' : pastedText).trim();
  if (pasted) {
    const kept = Math.min(pasted.length, remaining);
    if (kept <= 0) {
      blocks.push('【参考资料粘贴（正文未纳入：参考资料合计已达 ' + TOTAL_CHAR_LIMIT + ' 字上限）】');
    } else {
      remaining -= kept;
      totalChars += kept;
      let block = '【参考资料粘贴】\n' + pasted.slice(0, kept);
      if (kept < pasted.length) block += '\n' + truncationNote(kept, pasted.length);
      blocks.push(block);
    }
  }

  return { block: blocks.join('\n'), items, totalChars };
}
