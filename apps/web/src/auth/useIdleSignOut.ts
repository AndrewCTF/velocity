// Signs a Supabase session out after a stretch with no input (ASVS V7.3.1).
// Called once, from AuthProvider. Inert when auth is not configured or nobody
// is signed in, so keyless local use never sees it.
//
// The timeout is `sessionIdleTimeoutMin` from /api/config when the backend
// sends one, otherwise DEFAULT_IDLE_MINUTES. A minute before it fires a toast
// says so; any input withdraws it.
import { useEffect } from 'react';
import { createIdleTimer, idleMinutesFrom } from './idle.js';
import { isSupabaseConfigured, supabase } from '../transport/supabase.js';
import { latestRuntimeConfig } from '../transport/config.js';
import { toast } from '../shell/toast.js';

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

export function useIdleSignOut(signedIn: boolean): void {
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !signedIn) return;
    const client = supabase;
    let warningId: number | null = null;
    const minutes = (): number => idleMinutesFrom(latestRuntimeConfig());

    const timer = createIdleTimer({
      timeoutMs: () => minutes() * 60_000,
      onWarn: (msLeft) => {
        warningId = toast.warn(
          `No activity for a while. Signing out in ${Math.round(msLeft / 1000)} seconds unless you move the mouse or press a key.`,
          msLeft,
        );
      },
      onResume: () => {
        if (warningId !== null) toast.dismiss(warningId);
        warningId = null;
      },
      onIdle: () => {
        if (warningId !== null) toast.dismiss(warningId);
        warningId = null;
        // 'local' revokes this session's refresh token on the server as well as
        // dropping it here; other devices stay signed in. AuthProvider's
        // SIGNED_OUT handler clears the user's investigation data.
        void client.auth.signOut({ scope: 'local' }).finally(() => {
          toast.info(`Signed out after ${minutes()} minutes without activity.`, 10_000);
        });
      },
    });

    const onInput = (): void => timer.activity();
    for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { passive: true });
    return () => {
      timer.stop();
      for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput);
      if (warningId !== null) toast.dismiss(warningId);
    };
  }, [signedIn]);
}
