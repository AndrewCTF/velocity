// Shared email+password form for /login and /signup. One component, two modes,
// so the field layout / error styling never drifts between the two pages.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../transport/supabase.js';
import { InlineAlert } from '../shell/InlineAlert.js';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';

const COPY: Record<Mode, { title: string; cta: string; alt: string; altTo: string; altLabel: string }> = {
  login: {
    title: 'Sign in',
    cta: 'Sign in',
    alt: 'No account?',
    altTo: '/signup',
    altLabel: 'Create one',
  },
  signup: {
    title: 'Create account',
    cta: 'Create account',
    alt: 'Already have an account?',
    altTo: '/login',
    altLabel: 'Sign in',
  },
  forgot: {
    title: 'Reset password',
    cta: 'Send reset link',
    alt: 'Remembered it?',
    altTo: '/login',
    altLabel: 'Sign in',
  },
  reset: {
    title: 'Set a new password',
    cta: 'Update password',
    alt: 'Back to',
    altTo: '/login',
    altLabel: 'Sign in',
  },
};

// Live origin + Vite base ("/app/" in prod) → the URL Supabase emails point at.
// Must also be in the project's Auth → Redirect URLs allow-list.
function appUrl(path = ''): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${window.location.origin}${base.endsWith('/') ? base : base + '/'}${path}`;
}

export function AuthForm({ mode }: { mode: Mode }): JSX.Element {
  const nav = useNavigate();
  const copy = COPY[mode];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!supabase) {
      setError('Auth is not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signup') {
        // emailRedirectTo: where the confirmation link returns. Without it
        // Supabase falls back to its Auth "Site URL" (defaults to localhost:3000).
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: appUrl() },
        });
        if (err) throw err;
        // When email confirmation is ON (hosted default), signUp returns a
        // user but NO session — the user must click the email link first.
        // When it's OFF, a session is returned and we're logged in.
        if (data.session) {
          nav('/', { replace: true });
        } else {
          setNotice('Account created. Check your email to confirm, then sign in.');
        }
      } else if (mode === 'forgot') {
        // Sends a recovery email; the link lands on /reset with a recovery
        // session in the URL (detectSessionInUrl picks it up), where the user
        // sets a new password.
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: appUrl('reset'),
        });
        if (err) throw err;
        setNotice('If that email has an account, a reset link is on its way.');
      } else if (mode === 'reset') {
        // The recovery session is already established from the email link.
        const { error: err } = await supabase.auth.updateUser({ password });
        if (err) throw err;
        setNotice('Password updated. Signing you in…');
        nav('/', { replace: true });
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        nav('/', { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 grid place-items-center bg-bg-0 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-[340px] rounded-md border border-line bg-bg-1 p-6"
      >
        <div className="mb-1 font-mono text-base text-txt-0">{copy.title}</div>
        <div className="micro mb-5">Velocity</div>

        {mode !== 'reset' && (
          <>
            <label className="micro mb-1 block" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mb-4 w-full rounded-sm border border-line bg-bg-2 px-2 py-1.5 font-mono text-xs text-txt-0 outline-none focus:border-accent-line"
            />
          </>
        )}

        {mode !== 'forgot' && (
          <>
            <div className="mb-1 flex items-center justify-between">
              <label className="micro" htmlFor="password">
                {mode === 'reset' ? 'New password' : 'Password'}
              </label>
              {mode === 'login' && (
                <Link to="/forgot" className="micro text-accent hover:underline">
                  Forgot?
                </Link>
              )}
            </div>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mb-5 w-full rounded-sm border border-line bg-bg-2 px-2 py-1.5 font-mono text-xs text-txt-0 outline-none focus:border-accent-line"
            />
          </>
        )}

        {error && (
          <InlineAlert tone="alert" className="mb-4 font-mono">
            {error}
          </InlineAlert>
        )}
        {notice && (
          <InlineAlert tone="info" className="mb-4 font-mono">
            {notice}
          </InlineAlert>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-sm border border-accent-line bg-accent-dim py-1.5 font-mono text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? '…' : copy.cta}
        </button>

        <div className="mt-4 text-center font-mono text-[11px] text-txt-2">
          {copy.alt}{' '}
          <Link to={copy.altTo} className="text-accent hover:underline">
            {copy.altLabel}
          </Link>
        </div>
      </form>
    </div>
  );
}
