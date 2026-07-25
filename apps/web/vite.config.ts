import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

declare const process: { env: Record<string, string | undefined> };

// VITE_API_URL lets you target the API from either a Docker (`http://api:8000`,
// set explicitly in docker-compose.yml) or a local backend. Default to
// localhost so a bare `pnpm dev` against `uvicorn app.main:app` works with
// zero configuration — the old `api:8000` default only resolved inside the
// compose network and broke every request outside it.
// Pin 127.0.0.1, not `localhost`: in some containers (GitHub Codespaces) the
// dev proxy's Node process resolves `localhost` to IPv6 `::1` first, but uvicorn
// binds IPv4 only → ECONNREFUSED, surfacing in the browser as a bare
// "NetworkError" on /api/config. Same trap the Tauri path pins around.
const apiTarget = process.env['VITE_API_URL'] ?? 'http://127.0.0.1:8000';
const wsTarget = apiTarget.replace(/^http/, 'ws');

// Hardened local/desktop profile: VELOCITY_DESKTOP=1 injects a strict CSP that
// locks the WebView to same-origin + the local backend, so nothing can phone
// home. NOT applied to the normal (hosted) build — index.html is shared, and a
// hosted deploy talks to a same-origin API + cross-origin Supabase that this
// CSP would otherwise block. Tauri (Phase 1) sets the same CSP at the shell.
const hardened = process.env['VELOCITY_DESKTOP'] === '1';
const CSP = [
  "default-src 'self'",
  // local backend + Cesium's data:/blob: wasm decoders (NOT external — these are
  // in-bundle). Without data:/blob: here, Cesium's WASM (draco/ktx2) fetch is
  // CSP-blocked → its texture-decode workers die → blank/untextured globe.
  "connect-src 'self' http://127.0.0.1:8000 ws://127.0.0.1:8000 http://localhost:8000 ws://localhost:8000 data: blob:",
  "img-src 'self' data: blob: http://localhost:8081 http://127.0.0.1:8081", // tiles same-origin + local tileserver-gl rasterizer (dark vector)
  "style-src 'self' 'unsafe-inline'", // Cesium widgets inject inline styles
  "font-src 'self'",
  "worker-src 'self' blob:", // Cesium + splat viewer web workers
  // blob: needed: Cesium workers importScripts() a blob: child script.
  "script-src 'self' 'wasm-unsafe-eval' blob:",
].join('; ');

function cspPlugin() {
  return {
    name: 'velocity-local-csp',
    transformIndexHtml(html: string): string {
      if (!hardened) return html;
      return html.replace(
        '</head>',
        `    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), cesium(), cspPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Static assets that never need HMR (~6.2k files: pre-rendered dark tiles
    // + self-hosted fonts). Keeping them out of the watch set matters on this
    // host: fs.inotify.max_user_watches is a shared per-user budget, and when
    // the editor + a second dev server + agent sessions stack up, vite's share
    // tips it over ENOSPC and the dev server dies. `dev:poll` in package.json
    // is the committed fallback when the budget is exhausted by OTHER
    // processes; the durable host fix is raising the sysctl.
    watch: {
      ignored: ['**/public/darktiles/**', '**/public/fonts/**', '**/dist/**'],
    },
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      // ws: true with lifecycle wiring. The bare proxy never tore down the
      // UPSTREAM leg when a browser WS reconnected (the /ws/adsb 8-50s churn) —
      // http-proxy left it half-open, so the backend socket rotted in CLOSE-WAIT
      // (measured 1396 stranded + 1570 fds after 15h → the dev-side fd leak).
      // Bind the upstream request's lifetime to the client socket: when the
      // browser side closes or errors, destroy the upstream so the backend's
      // receive loop sees the FIN and frees the fd.
      '/ws': {
        target: wsTarget,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq, _req, socket) => {
            const kill = (): void => {
              proxyReq.destroy();
            };
            socket.on('close', kill);
            socket.on('error', kill);
          });
          proxy.on('error', (_err, _req, target) => {
            (target as { destroy?: () => void })?.destroy?.();
          });
        },
      },
      '/tiles': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    // 'hidden' still emits the .map files for local symbolication but omits
    // the sourceMappingURL comment, so browsers never download the ~20 MB of
    // maps alongside the bundle.
    sourcemap: 'hidden',
  },
});
