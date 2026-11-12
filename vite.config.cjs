const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');
const path = require('path');

/**
 * 真实浏览器验收专用：当环境变量 MOCK_PORT 存在时，往 index.html 注入
 * window.__DOUYA_BACKEND__，把渲染层的后台地址指向 mock 后端。
 *
 * 为什么需要：渲染层默认连 Electron 主进程本地服务 127.0.0.1:10119。
 * 如果本机正开着豆芽CLAW 桌面应用，10119 已被它占用，mock 后端起不来，
 * 验收脚本会**悄悄对着真实后端跑**（token 无效 → 401 → 停在登录页），
 * 于是"无白屏"变成假通过。注入覆盖后，mock 可以挂到任意空闲端口，
 * 且能保证验收对象确实是 mock。
 *
 * 生产构建不设置 MOCK_PORT，此插件不生效。
 */
function mockBackendOverride() {
  const port = process.env.MOCK_PORT;
  if (!port) return { name: 'mock-backend-override-noop' };
  const snippet = `<script>window.__DOUYA_BACKEND__='http://127.0.0.1:${port}';</script>`;
  return {
    name: 'mock-backend-override',
    transformIndexHtml(html) {
      return html.replace('<head>', '<head>' + snippet);
    },
  };
}

module.exports = defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), mockBackendOverride()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
  },
});
