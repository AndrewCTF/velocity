// Auth session context. Subscribes once to supabase.auth and exposes the
// current session/user to the tree. `loading` is true until the first
// getSession() resolves so guards/UI don't flash "signed out" on reload.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { clearLegacyTokens, supabase } from '../transport/supabase.js';
import { clearUserData } from './userData.js';
import { useIdleSignOut } from './useIdleSignOut.js';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** 'local' (default) ends this browser's session; 'others' ends every other one. */
  signOut: (scope?: 'local' | 'others') => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      // Auth disabled (env not configured) — resolve to signed-out, not stuck.
      setLoading(false);
      return;
    }
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    // onAuthStateChange fires on sign-in, sign-out, and token refresh — this
    // is what keeps every consumer in sync after a login from another tab.
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setLoading(false);
      // Every way a session ends lands here: the chip, the idle timer, an
      // expired refresh token, a sign-out in another tab. Clear the user's
      // investigation data with it (auth/userData.ts).
      if (event === 'SIGNED_OUT') {
        clearUserData();
        clearLegacyTokens();
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useIdleSignOut(Boolean(session));

  const value: AuthState = {
    session,
    user: session?.user ?? null,
    loading,
    signOut: async (scope = 'local') => {
      await supabase?.auth.signOut({ scope });
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within <AuthProvider>');
  return v;
}
