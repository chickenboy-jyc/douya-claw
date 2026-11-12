// childOutput —— 子进程原始字节 → 文本的**唯一真源**。
//
// ── 为什么需要这个模块（老板原话：「agent乱码报错」）────────────────────────
// 中文 Windows 上，`cmd.exe` / `where.exe` / 系统自带的原生 exe 的默认控制台输出编码是
// **GBK（cp936）**。用户素材几乎都是中文名，于是这些工具报错时 stderr 里带的是**中文字节**：
//     实测（warehouse 本机，2026-02）：`cmd /c dir "C:\不存在的目录\中文文件.mp4"`
//         utf8 解 → "�ļ�����Ŀ¼��������﷨����ȷ��"   （20 个 U+FFFD）
//         gbk  解 → "文件名、目录名或卷标语法不正确。"  （0 个 U+FFFD）
// 一旦无条件按 utf-8 解，用户看到的就是一串 `�`，既看不懂错在哪，也不知道下一步怎么办。
// 这正是「agent乱码报错」的直接成因。
//
// ── 用法上的硬边界（改之前先读完，这条决定改对还是改坏）─────────────────────
//   · **stderr**、以及任何**要展示给人看**的错误文案 ⇒ 必须走 `decodeOutput()`。
//   · **stdout 且用于 `JSON.parse` / 结构化解析** ⇒ **必须保持严格 utf-8**，不许回退。
//     理由：JSON 规范只允许 utf-8。给 JSON 做 GBK 回退，会让本来正确的 JSON 被 GBK
//     解成乱码进而解析失败 —— 那是把一个"显示问题"换成"功能故障"。
//     这类读取点在代码里一律写成显式 `toString('utf8')` 并带注释说明，不要改成
//     `decodeOutput()`。
//
// ── 为什么是"两份都解、比 FFFD 数量"而不是"看 BOM / 猜"──────────────────
// 纯 ASCII 与合法 UTF-8 输入经 GBK 解码**不一定**产生 U+FFFD（经典的"涓枃"式 mojibake
// 就是零 FFFD），所以不能只看 GBK 一侧干净不干净。反过来看"谁更干净、平手时保留 UTF-8"
// 是本机实测下最稳的判据：
//     合法 UTF-8 中文 '中文出错' →  utf8: 0 个 FFFD / gbk: 0 个 FFFD  ⇒ 平手 ⇒ 取 utf8 ✔
//     GBK 中文 [D6 D0 CE C4]     →  utf8: 4 个 FFFD / gbk: 0 个 FFFD  ⇒ 取 gbk ✔
//
// ⚠️ 本文件必须**零依赖、纯函数**：`skills/` 下的技能会跨树 require 它
//    （`require('../../src/main/childOutput')`，与 `src/shared/pythonRuntime` 同一条通路）。
//    它同时被两处加载：app.asar 内的主进程副本、以及 `resources/src/main/childOutput.js`
//    （electron-builder.yml 的 extraResources 显式搬的那一份，见其中注释）。
//    所以在里面 require 别的主进程模块 = 打包后必然 Cannot find module。

// Node ≥ 12 全局就有 TextDecoder；更老的宿主（以及某些被裁剪过的运行时）
// 只有 `util.TextDecoder`。这里只做一次"把东西摆到该在的位置"，不动下面函数的判断逻辑。
if (typeof globalThis.TextDecoder !== 'function') {
  try {
    // eslint-disable-next-line global-require
    globalThis.TextDecoder = require('util').TextDecoder;
  } catch (_) {
    /* 注入不了也没关系：decodeOutput 内部 new TextDecoder 会抛，catch 里回落 UTF-8。 */
  }
}

// 将子进程原始字节解码为文本。
// 中文 Windows 上 cmd.exe / 系统命令行工具的默认输出编码是 GBK（cp936）；
// 若一律按 UTF-8 解会产生大量 U+FFFD 乱码，这正是用户截图里连续乱码字符的成因。
// 策略：GBK 与 UTF-8 各解一遍，比较 U+FFFD 数量，谁更干净用谁；
// 两者都干净（纯 ASCII / 合法 UTF-8 输入）时保留 UTF-8 —— 避免把本来就是 UTF-8 的输出误判成 GBK。
function decodeOutput(buf) {
  if (buf == null) return '';                 // 空输出
  if (typeof buf === 'string') return buf;    // 已是字符串（未走 buffer 编码）无需再解
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length === 0) return '';
  const utf8 = bytes.toString('utf8');
  const countFffd = (s) => { const R = String.fromCharCode(0xfffd); let n = 0, i = -1; while ((i = s.indexOf(R, i + 1)) !== -1) n++; return n; };
  let gbk;
  try {
    gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes);  // GBK 解码器不可用/抛错则回落 UTF-8
  } catch (_) {
    return utf8;
  }
  return countFffd(gbk) < countFffd(utf8) ? gbk : utf8;
}

module.exports = { decodeOutput };
