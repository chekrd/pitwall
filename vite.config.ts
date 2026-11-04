import type { IncomingMessage } from 'node:http';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const server = process.env.PITWALL_API ?? 'http://127.0.0.1:7420';

// The board admits only its own host and origin. A page served here passes as the board; any other keeps its origin,
// so the board turns it away as it would without the proxy.
const asBoard: ProxyOptions = {
  target: server,
  changeOrigin: true,
  configure(proxy) {
    const rewrite = (out: { setHeader(name: string, value: string): void }, req: IncomingMessage) => {
      if (req.headers.origin === `http://${req.headers.host}`) out.setHeader('origin', new URL(server).origin);
    };
    proxy.on('proxyReq', rewrite);
    proxy.on('proxyReqWs', rewrite);
  },
};

export default defineConfig({
  root: 'web',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // Animation names stay global, so a module can use the keyframes that tokens.css shares.
  css: { transformer: 'lightningcss', lightningcss: { cssModules: { animation: false } } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext', cssMinify: 'lightningcss' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': asBoard,
      '/ws': { ...asBoard, ws: true },
    },
  },
});
