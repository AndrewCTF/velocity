import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchRuntimeConfig } from './config.js';
import { apiFetch } from './http.js';

vi.mock('./http.js', () => ({ apiFetch: vi.fn() }));

const mocked = vi.mocked(apiFetch);
const ok = { ok: true, status: 200, json: async () => ({ buildId: 'x' }) } as Response;
const status = (s: number) => ({ ok: false, status: s } as Response);

afterEach(() => {
  vi.useRealTimers();
  mocked.mockReset();
});

describe('fetchRuntimeConfig', () => {
  it('bounds every attempt with an abort signal so a queued connection cannot hang the boot', async () => {
    mocked.mockResolvedValue(ok);
    await fetchRuntimeConfig();
    expect(mocked.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries past network failures and 5xx (the cold-boot window) until success', async () => {
    vi.useFakeTimers();
    mocked
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(status(500)) // Vite proxy answers 500 while accept is blocked
      .mockResolvedValueOnce(ok);
    const p = fetchRuntimeConfig();
    await vi.advanceTimersByTimeAsync(4100);
    await expect(p).resolves.toEqual({ buildId: 'x' });
    expect(mocked).toHaveBeenCalledTimes(3);
  });

  it('outlasts a cold boot longer than any fixed ceiling (30+ failing attempts)', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 30; i++) mocked.mockResolvedValueOnce(status(502));
    mocked.mockResolvedValueOnce(ok);
    const p = fetchRuntimeConfig();
    await vi.advanceTimersByTimeAsync(30 * 2000 + 100);
    await expect(p).resolves.toEqual({ buildId: 'x' });
  });

  it('fails fast on a 4xx, which no amount of waiting fixes', async () => {
    mocked.mockResolvedValue(status(404));
    await expect(fetchRuntimeConfig()).rejects.toThrow('Configuration unavailable (HTTP 404)');
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});
