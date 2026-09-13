// MFA state, decided from what supabase-js reports (ASVS V6.3.3).
//
// The backend's require_operator demands an `aal2` token in multi-user mode and
// answers 403 with a message naming MFA. apiFetch reports that here once, and
// MfaBanner routes the user by `mfaStep`: someone who already has a TOTP factor
// but holds an aal1 session needs the code challenge, not a second enrolment.
import { create } from 'zustand';
import type { SupabaseClient } from '@supabase/supabase-js';

export type MfaStep = 'ok' | 'verify' | 'enrol';

export interface AalLike {
  currentLevel: string | null;
  nextLevel: string | null;
}

export interface FactorLike {
  factor_type: string;
  status: string;
}

/** `verify`: a verified factor exists and this session has not stepped up.
 *  `enrol`: no verified TOTP factor. `ok`: the session is already aal2. */
export function mfaStep(aal: AalLike | null, factors: readonly FactorLike[]): MfaStep {
  if (aal?.currentLevel === 'aal2') return 'ok';
  if (aal?.nextLevel === 'aal2') return 'verify';
  const hasTotp = factors.some((f) => f.factor_type === 'totp' && f.status === 'verified');
  return hasTotp ? 'verify' : 'enrol';
}

/** True when the login step-up challenge must run before entering the console. */
export function needsStepUp(aal: AalLike | null): boolean {
  return aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2';
}

/** A 403 whose body names MFA / aal2. Other 403s (tier gates, CSRF) are not ours. */
export function isMfaRequired(status: number, body: string): boolean {
  if (status !== 403) return false;
  return /\bmfa\b|multi-factor|two-factor|\baal2\b|authenticator/i.test(body);
}

export async function readMfaStep(client: SupabaseClient): Promise<MfaStep> {
  const [{ data: aal }, { data: factors }] = await Promise.all([
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
    client.auth.mfa.listFactors(),
  ]);
  return mfaStep(aal, factors?.all ?? []);
}

interface MfaNeededState {
  needed: boolean;
  /** The backend's own sentence, shown under the banner title. */
  detail: string | null;
  report: (detail: string) => void;
  clear: () => void;
}

export const useMfaNeeded = create<MfaNeededState>((set, get) => ({
  needed: false,
  detail: null,
  // Set once: the globe polls, and every poll would otherwise re-render.
  report: (detail) => {
    if (!get().needed) set({ needed: true, detail });
  },
  clear: () => set({ needed: false, detail: null }),
}));

/** Pull a human sentence out of a FastAPI-style `{"detail": "..."}` body. */
export function mfaDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200);
}
