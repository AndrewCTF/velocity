import { describe, it, expect, beforeEach, vi } from 'vitest';

// apiFetch is mocked at the module boundary (same convention as
// osint/CountriesPanel.test.tsx). backendUrl passes through.
vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
  backendUrl: (u: string) => u,
}));

import { apiFetch } from '../transport/http.js';
import { useEvidence } from './evidenceStore.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function evObj(sha: string, method = 'url'): unknown {
  return { id: `evidence:${sha}`, kind: 'evidence', props: { kind: 'evidence', sha256: sha, capture_method: method, size_bytes: 3, media_type: 'text/html' } };
}

beforeEach(() => {
  mockedFetch.mockReset();
  useEvidence.setState({ items: [], loading: false, error: null, busy: false });
});

describe('evidenceStore', () => {
  it('load populates items', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse([evObj('aa'), evObj('bb')]));
    await useEvidence.getState().load();
    expect(useEvidence.getState().items.map((i) => i.props.sha256)).toEqual(['aa', 'bb']);
    expect(useEvidence.getState().error).toBeNull();
  });

  it('captureUrl inserts the new object at the front', async () => {
    useEvidence.setState({ items: [evObj('old') as never] });
    mockedFetch.mockResolvedValueOnce(jsonResponse(evObj('new')));
    const obj = await useEvidence.getState().captureUrl('https://x.test');
    expect(obj).not.toBeNull();
    expect(useEvidence.getState().items[0]!.props.sha256).toBe('new');
    expect(useEvidence.getState().items).toHaveLength(2);
  });

  it('re-capturing the same bytes dedups by id (no duplicate row)', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(evObj('same')));
    await useEvidence.getState().captureUrl('https://x.test');
    await useEvidence.getState().captureUrl('https://y.test'); // same bytes → same id
    expect(useEvidence.getState().items).toHaveLength(1);
  });

  it('upload sends FormData without a JSON content-type', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(evObj('file1', 'file_upload')));
    const f = new File(['hi'], 'a.txt', { type: 'text/plain' });
    await useEvidence.getState().upload(f, 'ctx');
    const [, init] = mockedFetch.mock.calls[0]!;
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    // must NOT hand-set content-type — the browser sets the multipart boundary
    expect((init as RequestInit).headers).toBeUndefined();
  });

  it('captureUrl surfaces a failure and returns null', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ detail: 'bad' }, 422));
    const obj = await useEvidence.getState().captureUrl('not-a-url');
    expect(obj).toBeNull();
    expect(useEvidence.getState().error).toContain('422');
  });

  it('verify returns the ok flag', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ ok: true, sha256: 'aa' }));
    expect(await useEvidence.getState().verify('aa')).toBe(true);
    mockedFetch.mockResolvedValueOnce(jsonResponse({ ok: false, sha256: 'bb' }));
    expect(await useEvidence.getState().verify('bb')).toBe(false);
  });
});
