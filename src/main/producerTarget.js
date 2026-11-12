/**
 * 产出类技能的「这次调用会写到哪个文件」解析器
 * ============================================================================
 * 这个文件只回答一个问题：**模型这一次调技能，会在工作区的哪个路径上留下文件？**
 * 它不判定"该不该做"（那是 `intentGate.planAuthGate` 的事），也不判定"内容对不对"
 * （那是 `contentClaimGuard` 的事）—— 它只负责把「技能名 + 入参」翻译成一个路径。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要单独一个文件（2026-11-11 夜）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① **口径不统一，一刀切必错**。15 个产出技能里 11 个是 Python 实现，
 *      路径字段各不相同（`path` / `filename` / `output` / `basedir` / `files[].path`），
 *      而且 `zip-pack` 的 `path` 是**输入**不是输出。原来授权门只读 `params.path`，
 *      除 file-write 外**全部解析成空串** ⇒ 存在性恒判 false ⇒ "覆盖已有文件"这条旁路
 *      对 14 个技能永久失效（方向：多拦，不会静默放行）。
 *
 *   ② **必须能被门禁直接调用**。原来这段逻辑写在 `startBackend()` 的闭包里，
 *      单元测试够不着 ⇒ 只能退化成"断言源码里有这个字样"，而那种断言有个已知的坑：
 *      **把一行注释留在文件里，断言照样绿**（本轮就实测到了：删掉 `fileWriteTargetExists`
 *      后，旧断言靠我写的注释里的函数名继续通过）。抽成模块后，门禁可以真的建个文件、
 *      真的看 `exists` 是不是 true。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 失败方向（这一位决定"多问一句"还是"事故复发"，必须写死）
 * ═══════════════════════════════════════════════════════════════════════════
 *   推不出 ⇒ `{ target:'', exists:false, known:false }`。
 *   `exists:false` 在授权门里等于「当作新建」⇒ **仍受门管**（fail-closed）。
 *   代价：用户没明确派活时可能多问一句（派活时 `isDeliveryAuthorized` 先放行，不会问）。
 *   反过来「推不出就当作已存在」的后果是**静默放行** —— 正是 0.21.31 的形态（docx 绕门）。
 *   ⇒ 一律 fail-closed。`known` 只用于审计，不参与判定。
 *
 * ⚠️ 下列缺省名规则是**对技能实现的复刻**，不是它导出的接口（Python 侧无从调用）。
 *   复刻会漂移，所以 `unit-auth-gate.mjs` 的 P 组会读各技能源码，断言这些缺省表达式
 *   **逐字仍在源码里**；技能改了命名而这里没跟着改 ⇒ 转红，强制有人来看一眼。
 *   漂移方向：复刻不准 ⇒ 多为"多问一句"（fail-closed 侧），不会静默放行。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 工作区根。与 `skills/file-write/run.js` 及 `skills/*` 各处的声明**逐字一致**。 */
function workspaceRoot() {
  return process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');
}

/**
 * 解析一次技能调用的落点。
 *
 * @param {string} skillName
 * @param {object} [params] 该次调用入参
 * @returns {{target:string, exists:boolean, known:boolean, rule:string}}
 *   - `target` 绝对路径（推不出时为空串）
 *   - `exists` 该路径上**是否已有一个文件**（目录不算 —— 见下方 ③）
 *   - `known`  路径是否可靠推出（仅审计用，不参与授权判定）
 *   - `rule`   命中了哪条规则（审计用；门禁也用它断言"走的不是兜底分支"）
 */
function producerTarget(skillName, params) {
  const name = String(skillName == null ? '' : skillName);
  const prm = (params && typeof params === 'object') ? params : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const raw = (v) => (v == null ? '' : String(v).trim());

  const unknown = (rule) => ({ target: '', exists: false, known: false, rule });

  let rel = '';
  let rule = '';
  switch (name) {
    case 'file-write':
      rel = str(prm.path);
      rule = 'params.path';
      break;
    case 'docx-generate':
      rel = str(prm.filename) || (raw(prm.title) + '.docx');
      rule = str(prm.filename) ? 'params.filename' : 'title+docx';
      break;
    case 'pdf-generate':
      rel = str(prm.filename) || (raw(prm.title) + '.pdf');
      rule = str(prm.filename) ? 'params.filename' : 'title+pdf';
      break;
    case 'ppt-generate':
      rel = str(prm.filename) || (raw(prm.title) + '.pptx');
      rule = str(prm.filename) ? 'params.filename' : 'title+pptx';
      break;
    case 'excel-generate':
      // 源码：`filename = (params.get("filename") or "").strip() or (title + ".xlsx")`
      //       且 `title = (params.get("title") or "Sheet1").strip()`
      rel = str(prm.filename) || ((raw(prm.title) || 'Sheet1') + '.xlsx');
      rule = str(prm.filename) ? 'params.filename' : 'title+ xlsx (title 缺省 Sheet1)';
      break;
    case 'slides-generate':
      // 源码走 `safeName` 净化（空白→下划线、去分隔符）再强制 `.html`。
      // ★ 这里**不复刻净化**：净化差异只会让 exists 判成 false（多问一句），不会反向。
      rel = str(prm.filename) || (raw(prm.title) + '.html');
      rule = str(prm.filename) ? 'params.filename' : 'title+html (未复刻 safeName)';
      break;
    case 'chart-generate':
      rel = str(prm.output) || 'chart.png';
      rule = str(prm.output) ? 'params.output' : 'default chart.png';
      break;
    case 'gif-make':
      rel = str(prm.output) || 'animation.gif';
      rule = str(prm.output) ? 'params.output' : 'default animation.gif';
      break;
    case 'video-make':
      rel = str(prm.output) || 'video.mp4';
      rule = str(prm.output) ? 'params.output' : 'default video.mp4';
      break;
    case 'image-edit': {
      const o = str(prm.output);
      if (o) { rel = o; rule = 'params.output'; break; }
      // 缺省 = 输入文件名 + "-edited" + 原扩展名（run.py :101-106）
      // ⚠️ 源码里扩展名还受 params.format 影响（`out_ext = ("." + save_fmt) if save_fmt else 原扩展名`），
      //   这里**不复刻**：传了 format 时会算错扩展名 ⇒ exists 判成 false ⇒ 多问一句。
      //   方向是 fail-closed（多拦不会静默放行），所以接受这个偏差而不去猜 save_fmt 的默认值。
      const inp = str(prm.path);
      if (!inp) return unknown('output 与 path 都缺，推不出');
      const ext = path.extname(inp);
      rel = inp.slice(0, inp.length - ext.length) + '-edited' + ext;
      rule = 'input+-edited+ext';
      break;
    }
    // ═══ 以下 6 个**刻意不复刻**（承认推不出，而不是猜一个）═══
    //   image-compress   output 是**目录**；缺省 = 输入所在目录 ⇒ 永远"已存在"。
    //                    若照它判，本门对它 100% 失效 ⇒ 宁可承认推不出。
    //   media-edit       output 由 input/inputs 派生，且可能是目录。
    //   concat-video     output 缺省取自 `plan.export.output`（JSON 子结构）。
    //   zip-pack         output 缺省 = 输入 + ".zip"；`path` 是**输入**。
    //   miniprogram-scaffold  basedir 是**目录**，缺省 "miniprogram"。
    //   project-scaffold files[].path 在 JSON 数组里，可多个文件。
    default:
      return unknown(rule || '未登记形态 / 多文件 / 目录，推不出');
  }

  if (!rel) return unknown(rule + '（解析为空）');
  let full = '';
  try {
    full = path.isAbsolute(rel) ? rel : path.resolve(workspaceRoot(), rel);
  } catch {
    return unknown(rule + '（path.resolve 抛错）');
  }
  if (!full) return unknown(rule + '（绝对化为空）');

  let exists = false;
  try {
    // ★ ③ 只认**文件**：目录算"已存在"会让 miniprogram-scaffold / image-compress 这类
    //   永久走 `overwrite-existing` 旁路 ⇒ 等于对它们没有门。判不了就当不存在（fail-closed）。
    exists = fs.existsSync(full) && !fs.statSync(full).isDirectory();
  } catch {
    exists = false;
  }
  return { target: full, exists, known: true, rule };
}

module.exports = {
  workspaceRoot,
  producerTarget,
};
