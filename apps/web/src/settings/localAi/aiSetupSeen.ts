import { isMobileDevice } from "../../shell/device.js";

// First-run local-AI setup wizard gate. Mirrors the onboarding tour's
// hasOnboarded/markOnboarded idiom (src/onboarding/Onboarding.tsx) — a
// dedicated localStorage key or true so a fresh browser sees the wizard once
// and it never comes back uninvited, but Settings can always re-open it.
const SEEN_KEY = "velocity.aiSetupSeen";

export function hasSeenAiSetup(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // no storage → don't nag
  }
}

/** The wizard configures the SERVER: it reads the server's GPU and offers a
 *  model download to the server's disk. A phone or tablet reaching a
 *  self-hosted box has nothing to decide in it (measured 2026-10-17: a Pixel 7
 *  first visit was shown a 22 GB download for a card the phone cannot see), so a
 *  touch device never offers it. Settings can still open it on purpose. */
export function shouldOfferAiSetup(): boolean {
  return !isMobileDevice() && !hasSeenAiSetup();
}

export function markAiSetupSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
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
