// file-write: 在工作区内创建/覆盖文件
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');

module.exports.run = async function (params) {
  if (!params.path) return '错误：请提供目标文件路径';
  if (params.content == null) return '错误：请提供要写入的内容';
  const full = path.resolve(WORKSPACE, params.path);
  if (!full.startsWith(WORKSPACE)) return '错误：不允许写到工作区外的路径';
  // 确保父目录存在
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // mode=append：追加写入。
  // ★ 为什么需要它：上游输出有 token 上限，一份大文件（例如整页 HTML）可能长到"生成到一半被截断"
  // ⇒ 参数变成半截 JSON、这一次调用根本发不出去。此时唯一真实可走的替代路径就是**分多次写**：
  // 第 1 次覆盖，之后每次 append 一段。没有这个出口，"换方案"就只是一句空话。
  const mode = String(params.mode || 'overwrite').toLowerCase();
  const append = mode === 'append';
  if (append) fs.appendFileSync(full, String(params.content), 'utf-8');
  else fs.writeFileSync(full, String(params.content), 'utf-8');
  const size = Buffer.byteLength(String(params.content), 'utf-8');
  return `已${append ? '追加写入' : '写入'} ${params.path}（本次 ${size} 字节）`;
};
