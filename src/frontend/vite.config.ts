import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 局域网摄像头（getUserMedia）要求安全上下文（https 或 localhost）。
// 仓库根 .certs/ 存在本地生成的 CA + 服务器证书时自动启用 HTTPS；
// 证书缺失（如队友未生成）回退 http，不影响本地开发。
const here = path.dirname(fileURLToPath(import.meta.url));
const certFile = path.join(here, '../../.certs/server.crt');
const keyFile = path.join(here, '../../.certs/server.key');
const hasCerts = fs.existsSync(certFile) && fs.existsSync(keyFile);
if (!hasCerts) {
  console.warn('[vite] 未找到 .certs/ 证书，以 http 启动（局域网摄像头手势将不可用）。');
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    https: hasCerts
      ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
      : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      // 后端静态产物（上传图/视频/预览帧/目标裁剪图）经同源路径访问
      '/uploads': 'http://127.0.0.1:8000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
