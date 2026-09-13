import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type AuthListener = (event: string, session: unknown) => void;

const createClient = vi.fn();
let listener: AuthListener | null = null;

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    createClient(...args);
    return {
      auth: {
        onAuthStateChange: (cb: AuthListener) => {
          listener = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
        getSession: async () => ({ data: { session: null } }),
        setSession: vi.fn(),
      },
    };
  },
}));

async function loadConfigured(): Promise<typeof import('./supabase.js')> {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
  return import('./supabase.js');
}

describe('supabase client (ASVS V10.1.2 / V10.2.1 / V7.6.2)', () => {
  beforeEach(() => {
    vi.resetModules();
    createClient.mockReset();
    listener = null;
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the PKCE flow and still exchanges the code from the URL', async () => {
    await loadConfigured();
    expect(createClient).toHaveBeenCalledTimes(1);
    const opts = createClient.mock.calls[0]?.[2] as { auth: Record<string, unknown> };
    expect(opts.auth.flowType).toBe('pkce');
    expect(opts.auth.detectSessionInUrl).toBe(true);
    expect(opts.auth.persistSession).toBe(true);
  });

  it('clears the legacy vel_tok / vel_refresh keys on load instead of adopting them', async () => {
    localStorage.setItem('vel_tok', 'stolen-access');
    localStorage.setItem('vel_refresh', 'stolen-refresh');
    const mod = await loadConfigured();
    expect(localStorage.getItem('vel_tok')).toBeNull();
    expect(localStorage.getItem('vel_refresh')).toBeNull();
    await mod.tokenReady;
    expect(mod.getAccessToken()).toBeNull();
  });

  it('clears the legacy keys again on SIGNED_OUT', async () => {
    await loadConfigured();
    localStorage.setItem('vel_tok', 'late-write');
    listener?.('SIGNED_OUT', null);
    expect(localStorage.getItem('vel_tok')).toBeNull();
  });

  it('never calls setSession: no session appears without a sign-in', async () => {
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).join(process.cwd(), 'src/transport/supabase.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\.setSession\(/);
  });

  it('keyless: no client, and tokenReady resolves at once', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const mod = await import('./supabase.js');
    expect(mod.supabase).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    await expect(mod.tokenReady).resolves.toBeUndefined();
  });
});
