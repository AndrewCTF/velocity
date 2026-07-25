import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './AppRouter.js';
// Self-hosted fonts (no Google Fonts CDN). Weights mirror the prior css2 link:
// IBM Plex Mono 400/500/600 + Inter 400/500/600/700. These resolve from
// node_modules and Vite bundles the woff2 locally → zero external font fetch.
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { applyStoredTheme } from './state/theme.js';

// Apply the persisted light/dark theme to <html> before first paint.
applyStoredTheme();

// Last-resort error surfacing. The panel boundaries catch render errors inside
// the console, but a throw in the shell chrome or a store initializer used to
// leave a silent white page. This banner is plain DOM on purpose: it must work
// when React itself is down. One banner, first error wins; later errors are in
// the browser console.
function showFatalBanner(message: string): void {
  if (document.getElementById('fatal-error-banner')) return;
  // Only for the white-screen case: if the app tree is painted, the panel
  // boundaries and the browser console already carry the error, and a fatal
  // banner over a working console would cry wolf on every best-effort fetch
  // that rejects.
  const mount = document.getElementById('root');
  if (mount && mount.childElementCount > 0) return;
  const el = document.createElement('div');
  el.id = 'fatal-error-banner';
  el.setAttribute(
    'style',
    'position:fixed;top:0;left:0;right:0;z-index:99999;background:#3b0a0a;color:#fecaca;' +
      'font:12px/1.5 "IBM Plex Mono",monospace;padding:10px 14px;white-space:pre-wrap;' +
      'border-bottom:1px solid #7f1d1d;max-height:40vh;overflow:auto;',
  );
  el.textContent = `The console hit an unrecoverable error. Reload the page; if it repeats, the details below identify the fault.\n\n${message}`;
  document.body.appendChild(el);
}
window.addEventListener('error', (e) => {
  showFatalBanner(e.error instanceof Error ? (e.error.stack ?? e.error.message) : e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const r: unknown = e.reason;
  showFatalBanner(r instanceof Error ? (r.stack ?? r.message) : `Unhandled rejection: ${String(r)}`);
});

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary label="shell">
      <AppRouter />
    </ErrorBoundary>
  </React.StrictMode>,
);
