import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname ?? '.'),
  plugins: [react()],
  // 相对路径：桌面端以 file:// 加载 index.html 时，绝对路径 /assets 会指向文件系统根
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true }
    }
  },
  build: { outDir: 'dist' }
});
