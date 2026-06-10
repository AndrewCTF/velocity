import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

declare const process: { env: Record<string, string | undefined> };

// VITE_API_URL lets you target the API from either a Docker (`http://api:8000`)
// or local-dev (`http://localhost:8000`) backend. Default to the docker name
// since `docker compose up` is the documented happy path.
const apiTarget = process.env['VITE_API_URL'] ?? 'http://api:8000';
const wsTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react(), cesium()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/ws': { target: wsTarget, ws: true, changeOrigin: true },
      '/tiles': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
