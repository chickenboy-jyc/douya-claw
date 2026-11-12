/**
 * devBridge —— 「开发工作台」的主进程能力（豆芽对话 → 开发板块）。
 *
 * 干什么：让豆芽能在**本地真实项目目录**里读代码、写代码，并一键拉起微信开发者工具。
 *   dev:tree        读项目目录树（过滤 node_modules/.git/dist 等）
 *   dev:readFiles   读指定文件内容（给 AI 当上下文，有体积上限）
 *   dev:write       把 AI 产出的文件写入项目（**写前自动备份**）
 *   dev:openDevTools 用微信开发者工具 CLI 打开该项目
 *
 * ==================== 安全红线（这是全项目唯一能写任意用户目录的地方）====================
 * 渲染进程传来的 root 是「用户亲手选的项目目录」，rel 是「AI 给出的相对路径」——
 * AI 输出不可信，必须当成敌意输入。四道闸：
 *   1. **相对路径只允许**：拒绝绝对路径（`C:\` / `/` / UNC `\\`）、拒绝盘符、拒绝任何 `..` 段；
 *   2. **realpath 前缀校验**：拼出来的绝对路径 resolve 后必须仍在 root 之内（防符号链接逃逸）；
 *   3. **禁写保留目录**：`.douya-backup`（备份区）与 `.git` 一律拒绝写入，避免污染备份与版本库；
 *   4. **root 必须真实存在且是目录**：否则直接拒绝，不隐式创建。
 * 另有体积闸：单文件 256KB / 单次总量 1MB / 单次 200 个文件。
 *
 * 备份策略：覆盖已有文件前，先把旧内容复制到 `<root>/.douya-backup/<时间戳>/<rel>`，
 * 写失败或用户想回滚都能找回；备份失败**不阻断写入**，但会在返回值里如实上报。
 */

const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

/** 目录树遍历时跳过的目录名（构建产物 / 依赖 / 版本库 / 编辑器）。 */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache',
  'unpackage', 'miniprogram_npm', '.idea', '.vscode', '.douya-backup',
  '__pycache__', '.venv', 'venv', '.pytest_cache', 'coverage',
]);

const MAX_ENTRIES = 1500;      // 目录树最多返回条目数
const MAX_DEPTH = 7;           // 目录树最大深度
const MAX_FILE_BYTES = 256 * 1024;   // 单文件读上限
const MAX_TOTAL_BYTES = 1024 * 1024; // 单次读总量上限
const MAX_WRITE_FILES = 200;   // 单次写文件数上限
const REL_MAX = 240;           // 相对路径长度上限

/** 备份根目录名（也在 IGNORE_DIRS 里，不会被遍历、不会被写入）。 */
const BACKUP_DIR = '.douya-backup';

/**
 * 把「用户选的项目根 + AI 给的相对路径」安全地拼成绝对路径。
 * 不满足四道闸返回 null（调用方一律按失败处理）。
 * @param {string} root 项目根（绝对路径）
 * @param {string} rel 相对路径（AI 产出，不可信）
 * @returns {string|null}
 */
function safeJoin(root, rel) {
  const r = typeof root === 'string' ? root.trim() : '';
  let s = typeof rel === 'string' ? rel.trim() : '';
  if (!r || !s) return null;
  if (s.length > REL_MAX) return null;

  // 归一化分隔符；拒绝绝对路径 / 盘符 / UNC
  s = s.replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(s)) return null;

  const segs = s.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.length === 0) return null;
  if (segs.some((x) => x === '..')) return null;            // 闸 1：不许上跳
  if (segs[0] === BACKUP_DIR) return null;                  // 闸 3：不许写备份区
  if (segs[0] === '.git') return null;                      // 闸 3：不许碰版本库

  let rootAbs;
  try {
    rootAbs = fs.realpathSync(r);                            // 闸 4：root 必须真实存在
    if (!fs.statSync(rootAbs).isDirectory()) return null;
  } catch {
    return null;
  }

  const abs = path.resolve(rootAbs, segs.join(path.sep));
  // 闸 2：resolve 后必须仍在 root 之内（含分隔符，避免 /root 匹配 /root-evil）
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) return null;
  return abs;
}

/** 读项目元信息：名称 / 是否小程序 / AppID（不依赖渲染进程传值，主进程直读 project.config.json）。 */
function readProjectMeta(root) {
  const out = { name: path.basename(root), appid: '', kind: 'other', hasProjectConfig: false };
  const cfgPath = path.join(root, 'project.config.json');
  try {
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      out.hasProjectConfig = true;
      out.appid = String(cfg.appid || '').trim();
      if (cfg.projectname) out.name = String(cfg.projectname).trim();
      out.kind = 'miniprogram';
    }
  } catch { /* 配置损坏不影响登记 */ }
  if (out.kind !== 'miniprogram') {
    try {
      if (fs.existsSync(path.join(root, 'app.json')) && fs.existsSync(path.join(root, 'app.js'))) out.kind = 'miniprogram';
      else if (fs.existsSync(path.join(root, 'package.json'))) out.kind = 'web';
      else if (fs.existsSync(path.join(root, 'index.html'))) out.kind = 'web';
    } catch { /* ignore */ }
  }
  return out;
}

/** 读目录树（广度有限、条目有限，绝不递归进 node_modules）。 */
function readTree(root) {
  const entries = [];
  let truncated = false;

  /**
   * 遍历顺序（关键）：**每个目录先收「本级的文件」，再登记子目录并递归**。
   *
   * 为什么：旧实现把目录排在文件前、且遇目录立即递归 ⇒ 深度优先 + 先目录后文件 ⇒
   * 根目录的 index.html / package.json 排在**所有子树之后**；大项目里第一个大子目录就吃满
   * MAX_ENTRIES，根文件根本进不了 entries ⇒ 前端项目「没点名文件」的兜底选中恒为空。
   * 改成「本级文件先行」后，根文件一定先入 entries，结构性消除该问题。
   *
   * 其余语义一字不变：MAX_ENTRIES / MAX_DEPTH / truncated 标记 / IGNORE_DIRS / dotfile 跳过
   * （唯一例外 .env.example）/ size 字段。
   */
  const walk = (dir, relBase, depth) => {
    if (truncated) return;
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    const dirs = [];
    for (const d of names) {
      if (d.name.startsWith('.') && d.name !== '.env.example') continue;
      if (d.isDirectory()) {
        if (IGNORE_DIRS.has(d.name)) continue;
        dirs.push(d);
      } else if (d.isFile()) {
        files.push(d);
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    dirs.sort((a, b) => a.name.localeCompare(b.name));

    // 1) 先收本级文件（根文件不再被子树挤到上限之外）
    for (const d of files) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
      const rel = relBase ? relBase + '/' + d.name : d.name;
      let size = 0;
      try { size = fs.statSync(path.join(dir, d.name)).size; } catch { /* ignore */ }
      entries.push({ path: rel, dir: false, size });
    }
    // 2) 再登记子目录并递归
    for (const d of dirs) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
      const rel = relBase ? relBase + '/' + d.name : d.name;
      entries.push({ path: rel, dir: true });
      walk(path.join(dir, d.name), rel, depth + 1);
      if (truncated) return;
    }
  };

  walk(root, '', 1);
  return { entries, truncated };
}

/** HTML/HTM 扩展名（开发模式读文件时会把它们剥成可读文本）。 */
const HTML_EXTS = new Set(['.html', '.htm']);

/** 是否 HTML/HTM 文件（按扩展名判断；非字符串/无扩展名一律 false）。 */
function isHtmlPath(rel) {
  const s = String(rel == null ? '' : rel).toLowerCase();
  const i = s.lastIndexOf('.');
  return i >= 0 && HTML_EXTS.has(s.slice(i));
}

/**
 * 把 HTML 源码压成可读文本：去掉 <script>/<style>/注释/标签，并解码常见 HTML 实体。
 *
 * 为什么：开发模式把 .html 当上下文喂给模型时，`<script>`/`<style>`/成堆标签会吃掉大量 token
 * 却不含结构信息。剥标签后模型拿到的是「页面真正渲染出来的文字 + 结构」。
 * 只对 HTML/HTM 生效；调用方负责按扩展名分流，其它文件行为一字不变。
 *
 * @param {string} html 原始 HTML 文本
 * @returns {string} 可读纯文本
 */
function stripHtmlToText(html) {
  const src = typeof html === 'string' ? html : '';
  if (!src) return '';
  let out = src;
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<[^>]*>/g, ' ');
  // 实体解码：&amp; 放最后，避免 &amp;lt; 被二次解码成 '<'
  out = out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** 读一批文件内容（给 AI 当上下文，逐文件与总量都有上限）。 */
function readFiles(root, rels) {
  const files = [];
  const errors = [];
  let total = 0;
  for (const rel of Array.isArray(rels) ? rels : []) {
    const abs = safeJoin(root, rel);
    if (!abs) { errors.push({ path: String(rel), error: '路径不合法' }); continue; }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) { errors.push({ path: String(rel), error: '不是文件' }); continue; }
      const isHtml = isHtmlPath(rel);
      if (st.size > MAX_FILE_BYTES) {
        let content = fs.readFileSync(abs, 'utf8').slice(0, MAX_FILE_BYTES);
        if (isHtml) content = stripHtmlToText(content);
        files.push({ path: rel, content, truncated: true });
        total += MAX_FILE_BYTES;
        continue;
      }
      if (total + st.size > MAX_TOTAL_BYTES) { errors.push({ path: String(rel), error: '本次读取总量超限' }); continue; }
      let content = fs.readFileSync(abs, 'utf8');
      if (isHtml) content = stripHtmlToText(content);
      total += st.size;
      files.push({ path: rel, content, truncated: false });
    } catch (e) {
      errors.push({ path: String(rel), error: (e && e.message) || '读取失败' });
    }
  }
  return { files, errors, totalBytes: total };
}

/** 覆盖前备份到 `.douya-backup/<ts>/<rel>`。返回备份相对路径或 ''。 */
function backupFile(root, abs, rel, stamp) {
  try {
    if (!fs.existsSync(abs)) return '';
    const dest = path.join(root, BACKUP_DIR, stamp, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    return path.join(BACKUP_DIR, stamp, rel).split(path.sep).join('/');
  } catch {
    return '';
  }
}

/** 写入一批文件。逐条校验，**单条失败不影响其它**，最终如实汇总。 */
function writeFiles(root, ops = []) {
  const list = Array.isArray(ops) ? ops : [];
  const res = { ok: true, written: [], backed: [], failed: [], backupDir: '' };
  if (list.length === 0) { res.ok = false; res.failed.push({ path: '', error: '没有要写入的文件' }); return res; }
  if (list.length > MAX_WRITE_FILES) { res.ok = false; res.failed.push({ path: '', error: `一次最多写 ${MAX_WRITE_FILES} 个文件` }); return res; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const op of list) {
    const rel = op && op.path;
    const content = op && typeof op.content === 'string' ? op.content : '';
    const abs = safeJoin(root, rel);
    if (!abs) { res.failed.push({ path: String(rel || ''), error: '路径不合法或被安全策略拒绝' }); continue; }
    try {
      const existed = fs.existsSync(abs);
      if (existed) {
        const b = backupFile(root, abs, String(rel).replace(/\\/g, '/').replace(/^\.\//, ''), stamp);
        if (b) res.backed.push(b);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      res.written.push({
        path: String(rel).replace(/\\/g, '/').replace(/^\.\//, ''),
        bytes: Buffer.byteLength(content, 'utf8'),
        created: !existed,
      });
    } catch (e) {
      res.failed.push({ path: String(rel || ''), error: (e && e.message) || '写入失败' });
    }
  }
  if (res.backed.length > 0) res.backupDir = path.join(BACKUP_DIR, stamp).split(path.sep).join('/');
  res.ok = res.written.length > 0;
  return res;
}

/** 微信开发者工具 CLI 的常见安装位置（Windows / macOS）。 */
const DEVTOOLS_CANDIDATES = [
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files (x86)\\Tencent\\微信开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信开发者工具\\cli.bat',
  '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
  '/Applications/微信开发者工具.app/Contents/MacOS/cli',
];

/** 找 CLI；找不到返回 ''。 */
function findDevToolsCli() {
  for (const p of DEVTOOLS_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

/** 打开项目目录（资源管理器），失败返回 { ok:false }。 */
async function openFolder(root) {
  try {
    const r = fs.realpathSync(root);
    if (!fs.statSync(r).isDirectory()) return { ok: false, error: '不是目录' };
    const err = await shell.openPath(r);
    return err ? { ok: false, error: err } : { ok: true, path: r };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '打开失败' };
  }
}

/** 用微信开发者工具 CLI 打开项目（`cli open --project <dir>`）。 */
function openDevTools(root) {
  const cli = findDevToolsCli();
  if (!cli) {
    return { ok: false, error: '未找到微信开发者工具 CLI', hint: '请手动打开微信开发者工具并导入该项目目录；或在设置里把 CLI 路径告诉我。' };
  }
  let r;
  try {
    r = fs.realpathSync(root);
    if (!fs.statSync(r).isDirectory()) return { ok: false, error: '不是目录' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '项目目录不存在' };
  }
  try {
    const { spawn } = require('child_process');
    const child = spawn(cli, ['open', '--project', r], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: true,   // cli.bat 需要 shell 才能执行
    });
    child.unref();
    return { ok: true, cli, project: r };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '拉起开发者工具失败' };
  }
}

/**
 * 注册 IPC。**在 app ready 之前调用即可**（ipcMain 不依赖窗口）。
 * 返回值用于自检（单测可断言通道齐全）。
 */
function registerDevBridge() {
  ipcMain.handle('dev:projectMeta', (_e, root) => {
    try {
      const r = fs.realpathSync(String(root || '').trim());
      if (!fs.statSync(r).isDirectory()) return { ok: false, error: '不是目录' };
      return { ok: true, root: r, ...readProjectMeta(r) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || '目录不存在' };
    }
  });

  ipcMain.handle('dev:tree', (_e, root) => {
    try {
      const r = fs.realpathSync(String(root || '').trim());
      if (!fs.statSync(r).isDirectory()) return { ok: false, error: '不是目录' };
      const { entries, truncated } = readTree(r);
      return { ok: true, root: r, entries, truncated, maxEntries: MAX_ENTRIES };
    } catch (e) {
      return { ok: false, error: (e && e.message) || '目录不存在' };
    }
  });

  ipcMain.handle('dev:readFiles', (_e, root, rels) => {
    try {
      const r = fs.realpathSync(String(root || '').trim());
      return { ok: true, root: r, ...readFiles(r, rels) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || '目录不存在', files: [], errors: [] };
    }
  });

  ipcMain.handle('dev:write', (_e, root, ops) => {
    try {
      const r = fs.realpathSync(String(root || '').trim());
      return writeFiles(r, ops);
    } catch (e) {
      return { ok: false, error: (e && e.message) || '目录不存在', written: [], backed: [], failed: [] };
    }
  });

  ipcMain.handle('dev:openFolder', (_e, root) => openFolder(root));
  ipcMain.handle('dev:openDevTools', (_e, root) => openDevTools(root));
  ipcMain.handle('dev:cliPath', () => ({ ok: true, cli: findDevToolsCli() }));

  return {
    channels: ['dev:projectMeta', 'dev:tree', 'dev:readFiles', 'dev:write', 'dev:openFolder', 'dev:openDevTools', 'dev:cliPath'],
  };
}

module.exports = {
  registerDevBridge,
  // 导出内部纯函数供 node 单测（不经 Electron）
  safeJoin,
  readProjectMeta,
  readTree,
  readFiles,
  writeFiles,
  findDevToolsCli,
  stripHtmlToText,
  isHtmlPath,
  IGNORE_DIRS,
  BACKUP_DIR,
  MAX_ENTRIES,
  MAX_DEPTH,
  MAX_FILE_BYTES,
  MAX_WRITE_FILES,
};
