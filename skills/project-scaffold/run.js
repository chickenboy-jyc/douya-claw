// project-scaffold: 一次生成多文件项目，解决"写多文件费轮次"问题
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE || path.join(os.homedir(), 'douya-claw-workspace'));

module.exports.run = async function (params) {
  const raw = params.files || '[]';
  let files;
  try {
    files = JSON.parse(raw);
  } catch (e) {
    return '错误：files 参数不是合法 JSON，请传 [{"path":"...","content":"..."}] 数组';
  }
  if (!Array.isArray(files) || files.length === 0) {
    return '错误：files 不能为空，请传 [{"path":"...","content":"..."}] 数组';
  }

  const created = [];
  for (const f of files) {
    const p = String((f && f.path) || '').replace(/^[\\/]+/, '');
    if (!p) continue;
    // path.resolve 规范化分隔符，避免 startsWith 因正/反斜杠不一致而误判
    const full = path.resolve(WORKSPACE, p);
    if (full !== WORKSPACE && !full.startsWith(WORKSPACE + path.sep)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String((f && f.content) || ''), 'utf-8');
    created.push(full);
  }

  return '已生成 ' + created.length + ' 个文件：\n' + created.join('\n');
};
