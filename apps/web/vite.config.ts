import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import { buildCsp } from './csp';
import { bundledApiKeyError } from './buildGuard';

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

// Every production build carries a CSP (csp.ts says what each source is for).
// VELOCITY_DESKTOP=1 adds the Tauri loopback backend and IPC bridge. Build
// only: the dev server's HMR client needs inline script and eval.
const desktop = process.env['VELOCITY_DESKTOP'] === '1';

function cspPlugin(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: 'velocity-csp',
    apply: 'build',
    configResolved(config) {
      env = config.env as Record<string, string>;
    },
    transformIndexHtml: {
      // After vite-plugin-cesium has added its tags.
      order: 'post',
      handler(html: string): string {
        const content = buildCsp({
          desktop,
          apiUrl: env['VITE_API_URL'],
          supabaseUrl: env['VITE_SUPABASE_URL'],
        });
        const meta = `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
        // A meta CSP governs only what the parser meets AFTER it, so placement
        // is policy. It goes directly after vite-plugin-cesium's prebuilt
        // Cesium.js and before everything else: that bundle's Knockout copy
        // runs `(0, eval)("this")` at load, which would otherwise need
        // 'unsafe-eval' for the whole app. Cesium.js is a static same-origin
        // file; the app bundle, workers, and anything injected later are all
        // under the policy, and a later eval from Cesium is still refused.
        const cesiumTag = /<script src="[^"]*\/Cesium\.js"><\/script>/;
        if (cesiumTag.test(html)) return html.replace(cesiumTag, (tag) => `${tag}\n    ${meta}`);
        return html.replace(/<head>/, `<head>\n    ${meta}`);
      },
    },
  };
}

// Refuses a hosted build that would inline VITE_API_KEY (buildGuard.ts says
// why). configResolved sees config.env, which includes .env* files as well as
// the shell environment.
function bundledKeyGuardPlugin(): Plugin {
  return {
    name: 'velocity-no-bundled-api-key',
    apply: 'build',
    configResolved(config) {
      const err = bundledApiKeyError({
        env: config.env as Record<string, string | undefined>,
        desktop,
        isProduction: config.isProduction,
      });
      if (err) throw new Error(err);
    },
  };
}

export default defineConfig({
  plugins: [bundledKeyGuardPlugin(), react(), cesium(), cspPlugin()],
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
