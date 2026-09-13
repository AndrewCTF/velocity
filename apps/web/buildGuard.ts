// Build-time guards for the web bundle (vite.config.ts runs them).
//
// VITE_* variables are inlined into the JavaScript every visitor downloads, so
// a VITE_API_KEY in a hosted build publishes a non-expiring operator credential
// (ASVS V7.2.2). Browsers authenticate with Supabase sessions; the static key is
// for server-to-server callers (MCP, CI, scripts). Two builds may still carry
// it: the dev server (never shipped) and the desktop build (VELOCITY_DESKTOP=1),
// whose bundle stays on the operator's own machine and talks to a loopback API.

export interface BundledKeyCheck {
  /** Vite's resolved env: process env plus every loaded .env* file. */
  env: Record<string, string | undefined>;
  /** VELOCITY_DESKTOP=1. */
  desktop: boolean;
  /** config.isProduction: false only for the dev server. */
  isProduction: boolean;
}

/** Returns an error message when the build must fail, null when it may proceed. */
export function bundledApiKeyError(check: BundledKeyCheck): string | null {
  if (check.desktop || !check.isProduction) return null;
  const key = check.env['VITE_API_KEY'];
  if (!key || !key.trim()) return null;
  return (
    'VITE_API_KEY is set for a production web build. Vite inlines it into the ' +
    'public bundle, so anyone who loads the page can read the operator key. ' +
    'Unset VITE_API_KEY (check the shell and every apps/web/.env* file) and let ' +
    'browsers sign in with Supabase. The desktop build (VELOCITY_DESKTOP=1) and ' +
    '`vite` dev are the only places it is allowed.'
  );
}
