// First-run local-AI setup wizard gate. Mirrors the onboarding tour's
// hasOnboarded/markOnboarded idiom (src/onboarding/Onboarding.tsx) — a
// dedicated localStorage key or true so a fresh browser sees the wizard once
// and it never comes back uninvited, but Settings can always re-open it.
const SEEN_KEY = 'velocity.aiSetupSeen';

export function hasSeenAiSetup(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // no storage → don't nag
  }
}

export function markAiSetupSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode — fine, it just shows again next load */
  }
}

/** Clear the flag so the wizard can be re-run (wired to a Settings link). */
export function resetAiSetupSeen(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* ignore */
  }
}
