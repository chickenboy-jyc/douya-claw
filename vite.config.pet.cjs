const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');
const path = require('path');

module.exports = defineConfig({
  root: 'src/renderer-pet',
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer-pet'),
    emptyOutDir: false,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});