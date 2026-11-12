// 最简单的 JS 技能：导出 async run(params, ctx)
module.exports.run = async (params) => {
  const name = (params.name || 'world').toString().trim();
  return `Hello, ${name}! 这是来自本地技能插件的回应。`;
};
