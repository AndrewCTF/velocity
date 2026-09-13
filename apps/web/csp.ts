// Content-Security-Policy for every production build of the web app.
//
// vite.config.ts injects it right AFTER <script src=Cesium.js>: a meta CSP
// governs only what follows it, and Cesium.js's bundled Knockout runs
// (0,eval)("this") at load, which would otherwise need 'unsafe-eval' app-wide.
// The desktop variant is also the `app.security.csp` in
// apps/desktop/src-tauri/tauri.conf.json; csp.test.ts holds the two equal.
//
// Every origin below was traced to a load in apps/web/src. Keep it that way:
// add an origin next to the code that loads it, not "just in case".
//
// Not expressible in a <meta> policy (browsers ignore them there):
// frame-ancestors, report-uri/report-to, sandbox. frame-ancestors has to be a
// response header from whatever serves index.html.

// Browser-direct basemaps offered by the basemap picker
// (globe/GlobeCanvas.tsx THIRD_PARTY_BASEMAPS). Cesium fetches imagery as
// blobs, so these are connect-src as well as img-src.
const BASEMAP_HOSTS = [
  'https://server.arcgisonline.com',
  'https://a.tile.opentopomap.org',
  'https://basemap.nationalmap.gov',
  'https://tiles.maps.eox.at',
];

// Optional keyed imagery: GlobeCanvas.tsx sets Cesium.Ion.defaultAccessToken and
// createGooglePhotorealistic3DTileset() when the operator supplies those keys.
// Keyless boxes never contact them; a keyed box must not be broken by the CSP.
const KEYED_IMAGERY = [
  'https://api.cesium.com',
  'https://assets.ion.cesium.com',
  'https://tile.googleapis.com',
];

// Traffic simulator road graph (sim/TrafficController.ts).
const OVERPASS = 'https://overpass-api.de';

export interface CspOptions {
  /** VELOCITY_DESKTOP=1: the Tauri shell, which talks to 127.0.0.1:8000. */
  desktop?: boolean;
  /** VITE_API_URL, when the API is not same-origin (transport/http.ts). */
  apiUrl?: string | undefined;
  /** VITE_SUPABASE_URL (transport/supabase.ts). Auth REST only, no realtime. */
  supabaseUrl?: string | undefined;
}

function origin(url: string | undefined): string | null {
  if (!url || !url.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

export function buildCsp(opts: CspOptions = {}): string {
  const connect = ["'self'", 'data:', 'blob:', ...BASEMAP_HOSTS, ...KEYED_IMAGERY, OVERPASS];
  const api = origin(opts.apiUrl);
  if (api) connect.push(api, api.replace(/^http/, 'ws'));
  const supabase = origin(opts.supabaseUrl);
  if (supabase) connect.push(supabase);
  if (opts.desktop) {
    // transport/http.ts pins the desktop backend to IPv4 loopback; ipc: is
    // Tauri's own bridge.
    connect.push('http://127.0.0.1:8000', 'ws://127.0.0.1:8000', 'ipc:', 'http://ipc.localhost');
  }

  return [
    "default-src 'self'",
    // blob: for Cesium workers that importScripts() a blob: child; wasm for
    // Cesium's draco/ktx2 decoders and Spark's splat sorter. No inline script
    // and no eval: the built index.html has neither.
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    // Cesium, MapLibre and React set inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    // Photos come from wherever the backend found them: Planespotters,
    // Wikimedia, news publishers, ground-recon thumbnails.
    "img-src 'self' data: blob: https:",
    // Native <video>/<audio> sources: LiveATC mounts and Safari's native HLS
    // playback. hls.js (Chrome/Firefox) fetches playlists and segments over XHR,
    // which is connect-src, so a third-party camera hls_url is refused there
    // until it is proxied through the backend like /api/cams/{id}/snapshot.
    "media-src 'self' blob: https:",
    `connect-src ${connect.join(' ')}`,
    // MapLibre, hls.js, cesium-martini and Spark all start blob: workers.
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
