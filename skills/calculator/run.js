// 计算器技能：仅做受限算术求值，不暴露通用 eval。
// 注意：这是本地用户的自有脚本，安全边界由调用方（本应用）保证。
const ALLOWED = /^[0-9+\-*/().\s]+$/;

module.exports.run = async (params) => {
  const expr = String(params.expr || '');
  if (!ALLOWED.test(expr)) {
    throw new Error('只允许数字与 + - * / ( ) . 运算符');
  }
  // 用 Function 在受限作用域求值；禁用对全局对象的访问
  const value = Function('"use strict"; return (' + expr + ');')();
  return `${expr} = ${value}`;
};
