import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ASVS V10.1.1: the session token and the static key go to the backend only.
// apiFetch accepted any URL, so a variable URL that turned out absolute (a
// photo_url, a feed endpoint) would have carried the Bearer to a third party.

vi.mock('./supabase.js', () => ({
  supabase: null,
  getAccessToken: () => 'tok',
  getAccessTokenAsync: async () => 'tok',
}));

async function load(apiUrl?: string): Promise<typeof import('./http.js')> {
  vi.resetModules();
  vi.stubEnv('VITE_API_KEY', 'static-key');
  if (apiUrl) vi.stubEnv('VITE_API_URL', apiUrl);
  return import('./http.js');
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
  const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
  return new Headers(init.headers);
}

describe('apiFetch attaches credentials only to the backend (ASVS V10.1.1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends both credentials on a relative backend path', async () => {
    const { apiFetch } = await load();
    await apiFetch('/api/health');
    const h = sentHeaders(fetchMock);
    expect(h.get('Authorization')).toBe('Bearer tok');
    expect(h.get('X-API-Key')).toBe('static-key');
  });

  it('sends them to the page origin spelled out absolutely', async () => {
    const { apiFetch } = await load();
    await apiFetch(`${window.location.origin}/api/health`);
    expect(sentHeaders(fetchMock).get('Authorization')).toBe('Bearer tok');
  });

  it('sends them to the configured backend base', async () => {
    const { apiFetch } = await load('https://api.example.test');
    await apiFetch('https://api.example.test/api/health');
    expect(sentHeaders(fetchMock).get('Authorization')).toBe('Bearer tok');
  });

  it('sends nothing to a third-party absolute URL', async () => {
    const { apiFetch } = await load('https://api.example.test');
    for (const url of [
      'https://third.example/photo.jpg',
      'https://api.example.test.evil.example/x',
    ]) {
      fetchMock.mockClear();
      await apiFetch(url, { headers: { Accept: 'image/*' } });
      const h = sentHeaders(fetchMock);
      expect(h.get('Authorization'), url).toBeNull();
      expect(h.get('X-API-Key'), url).toBeNull();
      expect(h.get('Accept'), url).toBe('image/*');
    }
  });

  it('treats a protocol-relative URL as another host when no base is set', async () => {
    const { apiFetch } = await load();
    await apiFetch('//third.example/x');
    expect(sentHeaders(fetchMock).get('Authorization')).toBeNull();
  });
});
