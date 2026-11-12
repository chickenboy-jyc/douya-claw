// 工具 schema 派生 —— 主窗（src/renderer/App.jsx）与桌宠（src/renderer-pet/App.jsx）**共用这一份真源**。
//
// 为什么必须共用：这两处此前各写一份，2026-09-16 修好了主窗的 `required: []`，
// **桌宠那份被漏掉**，于是桌宠窗口里"模型永远不知道哪个参数必填"的病一直留着。
// 两份实现 = 迟早漂移 ⇒ 派生逻辑只留一份。
//
// 关于"参数类型"的一个重要取舍（别改错）：
//   参数在 JSON Schema 里**仍然是 string**，不改成 boolean/number/array。
//   原因：各技能 run.js 对参数的容错程度并不一致 —— 有的会强转（browser-verify 的 normalizeParams
//   就明确写了"类型全部强转"），有的直接用 `=== 'true'` 这类**严格字符串比较**。
//   如果这里把 type 改成 boolean，模型就会按 boolean 发值，而执行侧仍按 string 收
//   ⇒ 制造出一类全新的"格式对不上"故障（正是我们要消灭的那类问题）。
//   所以：类型形状用**文字**告诉模型（`（true / false）`），执行侧契约一个字不动。
//   这既能拿到"模型按对格式填值"的好处，又不会拦死任何本来能成功的调用。

/**
 * 参数形状提示（纯文字，写进 description）。
 * 只覆盖**已经核对过执行侧实现**的少数几个；不确定的一律不写，避免给模型错误暗示。
 * @param {string} name 参数名
 * @returns {string} '' 表示不给提示
 */
export function paramShapeNote(name) {
  const n = String(name || '');
  // 毫秒类：manifest 里统一以 _ms 结尾
  if (/_ms$/.test(n)) return '数字（毫秒）';
  // browser-verify 的 screenshot：run.js 的 normalizeParams 会强转布尔 ⇒ 安全
  if (n === 'screenshot') return 'true / false';
  // browser-verify 的 actions：run.js 的 normalizeParams 接受 JSON 字符串或数组 ⇒ 安全
  if (n === 'actions') return 'JSON 数组字符串';
  // file-write 的 mode：本项目自定义，收 'overwrite' | 'append'
  if (n === 'mode') return 'overwrite 或 append';
  return '';
}

/**
 * 单个参数的 description：标签 +（形状提示）+（用法示例）
 * manifest 里可选字段：label / hint / example
 */
export function paramDescription(p) {
  const label = (p && (p.label || p.name || p.key)) || '';
  const shape = paramShapeNote(p && (p.name || p.key));
  const parts = [label];
  if (shape) parts.push('（' + shape + '）');
  if (p && p.hint) parts.push('（' + p.hint + '）');
  return parts.filter(Boolean).join('');
}

/**
 * 由技能 manifest 派生一个 OpenAI function 的 `parameters`。
 * ★ 三个要点：
 *   ① `required` 只做**透传**（真源是 manifest 的 params[].required），不在渲染层自行发明；
 *   ② `additionalProperties: false` —— 明确"没有别的参数了"，减少模型自造字段。
 *      已用真网关探测过：带上它请求仍 200、工具调用照常成型（不会让调用 400）；
 *   ③ 每个属性都要有 type（JSON Schema 规范要求），这里统一 string（见文件头取舍说明）。
 */
export function buildToolParameters(skill) {
  const ps = (skill && skill.params) || [];
  const properties = {};
  for (const p of ps) {
    const key = p && (p.name || p.key);
    if (!key) continue;
    properties[key] = { type: 'string', description: paramDescription(p) };
  }
  return {
    type: 'object',
    properties,
    // 真源唯一：manifest 的 params[].required。这里只过滤透传，不自行发明必填项。
    required: ps.filter((p) => p && p.required === true).map((p) => p.name || p.key).filter(Boolean),
    // 不许模型塞 schema 里没声明的字段（少一类"参数名写错但没人发现"的隐性故障）
    additionalProperties: false,
  };
}

/**
 * 由技能清单派生完整工具表。
 * @param {Array} skills 来自后端 /api/skills 的清单（每项含 id/description/params）
 */
export function buildToolsFrom(skills) {
  if (!Array.isArray(skills) || !skills.length) return [];
  return skills.map((s) => ({
    type: 'function',
    function: {
      name: s.id,
      description: s.description || s.name,
      parameters: buildToolParameters(s),
    },
  }));
}
