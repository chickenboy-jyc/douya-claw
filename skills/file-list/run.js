// file-list: 列出目录中的文件（支持绝对路径直接浏览磁盘任意位置，相对路径则相对于工作区）
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace');

module.exports.run = async function (params) {
  const sub = (params.path || '').trim();
  const dir = sub ? (path.isAbsolute(sub) ? sub : path.resolve(WORKSPACE, sub)) : WORKSPACE;
  if (!fs.existsSync(dir)) return `目录不存在：${sub || '(工作区根目录)'}`;
  if (!fs.statSync(dir).isDirectory()) {
    const content = fs.readFileSync(dir, 'utf-8').slice(0, 3000);
    return `${sub}（非目录，读取内容）:\n\`\`\`\n${content}\n\`\`\``;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) return `目录为空：${sub || '(工作区根目录)'}`;
  const lines = entries.map((e) => {
    const prefix = e.isDirectory() ? '📁' : '📄';
    const full = path.join(dir, e.name);
    let size = '';
    try {
      const s = fs.statSync(full);
      if (s.isFile()) size = `  (${s.size} B)`;
    } catch {}
    return `${prefix} ${e.name}${size}`;
  });
  return `${sub || '工作区'} (${entries.length} 项):\n${lines.join('\n')}`;
};
