import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isMfaRequired, mfaDetail, mfaStep, needsStepUp, useMfaNeeded } from './mfa.js';

vi.mock('../transport/supabase.js', () => ({
  getAccessToken: () => 'jwt',
  getAccessTokenAsync: async () => 'jwt',
  supabase: null,
}));

describe('MFA state (ASVS V6.3.3)', () => {
  it('routes an aal1 session with a factor to the code step, not enrolment', () => {
    expect(mfaStep({ currentLevel: 'aal1', nextLevel: 'aal2' }, [])).toBe('verify');
    expect(
      mfaStep({ currentLevel: 'aal1', nextLevel: 'aal1' }, [{ factor_type: 'totp', status: 'verified' }]),
    ).toBe('verify');
    expect(
      mfaStep({ currentLevel: 'aal1', nextLevel: 'aal1' }, [{ factor_type: 'totp', status: 'unverified' }]),
    ).toBe('enrol');
    expect(mfaStep({ currentLevel: 'aal2', nextLevel: 'aal2' }, [])).toBe('ok');
  });

  it('asks for the login step-up only when nextLevel is above currentLevel', () => {
    expect(needsStepUp({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe(true);
    expect(needsStepUp({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe(false);
    expect(needsStepUp({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe(false);
    expect(needsStepUp(null)).toBe(false);
  });

  it('recognises the backend 403 that names MFA, and only that one', () => {
    expect(isMfaRequired(403, '{"detail":"Operator actions require MFA enrolment (aal2)."}')).toBe(true);
    expect(isMfaRequired(403, '{"detail":"Enrol an authenticator to continue"}')).toBe(true);
    expect(isMfaRequired(403, '{"detail":"operator role required"}')).toBe(false);
    expect(isMfaRequired(401, '{"detail":"MFA required"}')).toBe(false);
    expect(mfaDetail('{"detail":"MFA required"}')).toBe('MFA required');
    expect(mfaDetail('plain body')).toBe('plain body');
  });
});

describe('apiFetch reports an MFA 403 once', () => {
  beforeEach(() => {
    useMfaNeeded.getState().clear();
  });

  it('flags the store from a cloned body and leaves the response readable', async () => {
    const body = JSON.stringify({ detail: 'This action requires MFA (aal2). Enrol in Settings.' });
    const fetchMock = vi.fn(async () => new Response(body, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../transport/http.js');

    const res = await apiFetch('/api/operator/thing');
    expect(await res.text()).toBe(body);
    await vi.waitFor(() => expect(useMfaNeeded.getState().needed).toBe(true));
    expect(useMfaNeeded.getState().detail).toMatch(/requires MFA/);

    fetchMock.mockImplementation(async () => new Response('{"detail":"forbidden"}', { status: 403 }));
    useMfaNeeded.getState().clear();
    await apiFetch('/api/other');
    await new Promise((r) => setTimeout(r, 0));
    expect(useMfaNeeded.getState().needed).toBe(false);
    vi.unstubAllGlobals();
  });
});
