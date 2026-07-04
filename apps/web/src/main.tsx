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
import { applyStoredTheme } from './state/theme.js';

// Apply the persisted light/dark theme to <html> before first paint.
applyStoredTheme();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
