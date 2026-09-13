// Shared email+password form for /login and /signup. One component, two modes,
// so the field layout / error styling never drifts between the two pages.
//
// Also home to the signed-in account controls Settings renders
// (`AccountSecurity`: change password, sign out other sessions, TOTP) and the
// TOTP code step both places share, so the auth forms keep one set of idioms.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Factor } from '@supabase/supabase-js';
import { createReauthClient, supabase } from '../transport/supabase.js';
import { InlineAlert } from '../shell/InlineAlert.js';
import { toast } from '../shell/toast.js';
import { useAuth } from './AuthContext.js';
import { needsStepUp, useMfaNeeded } from './mfa.js';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';

/** ASVS V6.2.1 floor. The server's own minimum (Supabase Auth → Email →
 *  Minimum password length) must be at least this; the input only saves a trip. */
export const PASSWORD_MIN = 8;
const PASSWORD_HINT = 'At least 8 characters. 15 or more is better; a passphrase works well.';

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

const INPUT =
  'w-full rounded-sm border border-line bg-bg-2 px-2 py-1.5 font-mono text-xs text-txt-0 outline-hidden focus:border-accent-line';
const PRIMARY =
  'w-full rounded-sm border border-accent-line bg-accent-dim py-1.5 font-mono text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50';
const SECONDARY =
  'rounded-sm border border-line px-2 py-1 font-mono text-[11px] text-txt-2 hover:border-accent-line hover:text-accent disabled:opacity-50';

// Live origin + Vite base ("/app/" in prod) → the URL Supabase emails point at.
// Must also be in the project's Auth → Redirect URLs allow-list.
function appUrl(path = ''): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${window.location.origin}${base.endsWith('/') ? base : base + '/'}${path}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

async function verifiedTotp(): Promise<Factor | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data.totp[0] ?? null;
}

async function verifyTotpCode(code: string): Promise<void> {
  if (!supabase) throw new Error('Auth is not configured.');
  const factor = await verifiedTotp();
  if (!factor) throw new Error('No authenticator is set up on this account.');
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) throw error;
  useMfaNeeded.getState().clear();
}

const WRONG_PASSWORD = 'The current password is not right.';

/** Proves the current password without touching this browser's session
 *  (ASVS V7.5.1). Signing in on the app's own client would mint a new session
 *  and orphan the old refresh token (V7.2.4), so the proof runs on a throwaway
 *  in-memory client and that session is revoked straight after. */
async function proveCurrentPassword(email: string | null, password: string): Promise<void> {
  if (!email) throw new Error('This account has no email address to check a password against.');
  if (!password) throw new Error('Enter your current password first.');
  const client = createReauthClient();
  if (!client) throw new Error('Auth is not configured.');
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(WRONG_PASSWORD);
  await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
}

function CurrentPasswordInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <>
      <label className="micro mb-1 block" htmlFor={id}>
        Current password
      </label>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mb-2 ${INPUT}`}
      />
    </>
  );
}

function CodeInput({
  id,
  value,
  onChange,
  label = 'Authenticator code',
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  label?: string;
}): JSX.Element {
  return (
    <>
      <label className="micro mb-1 block" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        className={`mb-4 ${INPUT} tracking-[0.3em]`}
      />
    </>
  );
}

/** The step-up challenge: a code from an already enrolled authenticator. */
export function TotpChallenge({
  onDone,
  onCancel,
  intro = 'Enter the 6-digit code from your authenticator app.',
}: {
  onDone: () => void;
  onCancel?: () => void;
  intro?: string;
}): JSX.Element {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyTotpCode(code);
      onDone();
    } catch (err) {
      setError(errText(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-3 font-mono text-[11px] leading-snug text-txt-2">{intro}</p>
      <CodeInput id="totp-code" value={code} onChange={setCode} />
      {error && (
        <InlineAlert tone="alert" className="mb-4 font-mono">
          {error}
        </InlineAlert>
      )}
      <button type="submit" disabled={busy || code.length !== 6} className={PRIMARY}>
        {busy ? '…' : 'Verify'}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel} className={`mt-2 w-full ${SECONDARY}`}>
          Cancel
        </button>
      )}
    </form>
  );
}

function SignOutOthersBox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="mb-4 flex items-center gap-2 font-mono text-[11px] text-txt-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Sign out my other sessions
    </label>
  );
}

export function AuthForm({ mode }: { mode: Mode }): JSX.Element {
  const nav = useNavigate();
  const copy = COPY[mode];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'mfa'>('form');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [resetLinkDead, setResetLinkDead] = useState(false);

  // PKCE: the recovery link carries a code only the browser that asked for it
  // can exchange. When no session came out of the exchange, say why up front
  // instead of letting the submit fail with "Auth session missing".
  useEffect(() => {
    if (mode !== 'reset' || !supabase) return;
    let live = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (live && !data.session) setResetLinkDead(true);
    });
    return () => {
      live = false;
    };
  }, [mode]);

  async function finishReset(): Promise<void> {
    if (!supabase) return;
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) throw err;
    if (signOutOthers) await supabase.auth.signOut({ scope: 'others' });
    setNotice('Password updated. Signing you in…');
    nav('/', { replace: true });
  }

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
        // Sends a recovery email; the link lands on /reset?code=…, which
        // detectSessionInUrl exchanges (PKCE) for a recovery session, where the
        // user sets a new password.
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: appUrl('reset'),
        });
        if (err) throw err;
        setNotice('If that email has an account, a reset link is on its way.');
      } else if (mode === 'reset') {
        // A recovery session is aal1. An account with an authenticator has to
        // step up before GoTrue will change its password.
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (needsStepUp(aal)) {
          setStep('mfa');
          return;
        }
        await finishReset();
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (needsStepUp(aal)) {
          setStep('mfa');
          return;
        }
        nav('/', { replace: true });
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const card = (children: ReactNode): JSX.Element => (
    <div className="fixed inset-0 grid place-items-center bg-bg-0 px-4">
      <div className="w-full max-w-[340px] rounded-md border border-line bg-bg-1 p-6">
        <div className="mb-1 font-mono text-base text-txt-0">
          {step === 'mfa' ? 'Two-factor check' : copy.title}
        </div>
        <div className="micro mb-5">Velocity</div>
        {children}
      </div>
    </div>
  );

  if (step === 'mfa') {
    return card(
      <>
        <TotpChallenge
          onDone={() => {
            if (mode === 'reset') {
              setStep('form');
              void finishReset().catch((err: unknown) => setError(errText(err)));
            } else {
              nav('/', { replace: true });
            }
          }}
          onCancel={() => {
            // Leave no half-signed-in aal1 session behind on a cancelled step-up.
            void supabase?.auth.signOut({ scope: 'local' });
            setStep('form');
          }}
        />
        {error && (
          <InlineAlert tone="alert" className="mt-4 font-mono">
            {error}
          </InlineAlert>
        )}
      </>,
    );
  }

  const newPassword = mode === 'signup' || mode === 'reset';

  return (
    <div className="fixed inset-0 grid place-items-center bg-bg-0 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-[340px] rounded-md border border-line bg-bg-1 p-6"
      >
        <div className="mb-1 font-mono text-base text-txt-0">{copy.title}</div>
        <div className="micro mb-5">Velocity</div>

        {mode === 'reset' && resetLinkDead && (
          <InlineAlert tone="warn" className="mb-4 font-mono">
            This reset link has no session here. Open it in the same browser you requested it
            from, or <Link to="/forgot" className="underline">ask for a new link</Link>.
          </InlineAlert>
        )}

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
              className={`mb-4 ${INPUT}`}
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
              autoComplete={newPassword ? 'new-password' : 'current-password'}
              required
              minLength={newPassword ? PASSWORD_MIN : undefined}
              aria-describedby={newPassword ? 'password-hint' : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${newPassword ? 'mb-1' : 'mb-5'} ${INPUT}`}
            />
            {newPassword && (
              <p id="password-hint" className="mb-4 font-mono text-[10px] text-txt-2">
                {PASSWORD_HINT}
              </p>
            )}
          </>
        )}

        {mode === 'reset' && <SignOutOthersBox checked={signOutOthers} onChange={setSignOutOthers} />}

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

        <button type="submit" disabled={busy} className={PRIMARY}>
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

// ── Settings → Account ─────────────────────────────────────────────────────

function Subhead({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mono mb-1.5 mt-3 text-[11px] text-txt-1">{children}</div>;
}

/** Change password (ASVS V6.2.2/V6.2.3/V7.5.1), sign out other sessions
 *  (V7.4.3/V7.5.2) and TOTP (V6.3.3). Render only when Supabase is configured
 *  and someone is signed in; SettingsModal gates it. */
export function AccountSecurity(): JSX.Element | null {
  const { user } = useAuth();
  if (!supabase || !user) return null;
  const email = user.email ?? null;
  return (
    <div>
      <ChangePassword email={email} />
      <OtherSessions email={email} />
      <TwoFactor email={email} />
    </div>
  );
}

function ChangePassword({ email }: { email: string | null }): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [code, setCode] = useState('');
  const [nonce, setNonce] = useState('');
  const [needNonce, setNeedNonce] = useState(false);
  const [hasTotp, setHasTotp] = useState(false);
  const [others, setOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void verifiedTotp()
      .then((f) => live && setHasTotp(Boolean(f)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!needNonce) {
        if (email) {
          // Proves the current password on a throwaway client, so this
          // session stays the only one this browser holds. An account with an
          // authenticator also gives a fresh code.
          await proveCurrentPassword(email, current);
          if (hasTotp) await verifyTotpCode(code);
        } else {
          // No email to check a password against: the emailed nonce is the proof.
          const { error: err } = await supabase.auth.reauthenticate();
          if (err) throw err;
          setNeedNonce(true);
          setNotice('A confirmation code is on its way. Enter it below to finish.');
          return;
        }
      }
      // current_password lets GoTrue check the old password itself (ASVS
      // V6.2.3) when the project enables "require current password"; a server
      // without that setting ignores the field. The check above is the
      // browser half.
      const { error: err } = await supabase.auth.updateUser(
        needNonce ? { password: next, nonce } : { password: next, current_password: current },
      );
      if (err) {
        // Secure password change is on in the Supabase project: GoTrue wants
        // the reauthentication nonce as well.
        if (!needNonce && (errCode(err) === 'reauthentication_needed' || errCode(err) === 'reauth_nonce_missing')) {
          const { error: rerr } = await supabase.auth.reauthenticate();
          if (rerr) throw rerr;
          setNeedNonce(true);
          setNotice('A confirmation code is on its way. Enter it below to finish.');
          return;
        }
        throw err;
      }
      if (others) await supabase.auth.signOut({ scope: 'others' });
      setCurrent('');
      setNext('');
      setCode('');
      setNonce('');
      setNeedNonce(false);
      setNotice(others ? 'Password changed. Your other sessions are signed out.' : 'Password changed.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Subhead>Change password</Subhead>
      {email && !needNonce && (
        <>
          <label className="micro mb-1 block" htmlFor="pw-current">
            Current password
          </label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={`mb-3 ${INPUT}`}
          />
        </>
      )}
      <label className="micro mb-1 block" htmlFor="pw-new">
        New password
      </label>
      <input
        id="pw-new"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN}
        aria-describedby="pw-new-hint"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className={`mb-1 ${INPUT}`}
      />
      <p id="pw-new-hint" className="mb-3 font-mono text-[10px] text-txt-2">
        {PASSWORD_HINT}
      </p>
      {hasTotp && !needNonce && <CodeInput id="pw-totp" value={code} onChange={setCode} />}
      {needNonce && (
        <>
          <label className="micro mb-1 block" htmlFor="pw-nonce">
            Confirmation code from your email
          </label>
          <input
            id="pw-nonce"
            autoComplete="one-time-code"
            required
            value={nonce}
            onChange={(e) => setNonce(e.target.value.trim())}
            className={`mb-3 ${INPUT}`}
          />
        </>
      )}
      <SignOutOthersBox checked={others} onChange={setOthers} />
      {error && (
        <InlineAlert tone="alert" className="mb-3 font-mono">
          {error}
        </InlineAlert>
      )}
      {notice && (
        <InlineAlert tone="info" className="mb-3 font-mono">
          {notice}
        </InlineAlert>
      )}
      <button type="submit" disabled={busy} className={PRIMARY}>
        {busy ? '…' : needNonce ? 'Confirm and change password' : 'Change password'}
      </button>
    </form>
  );
}

function OtherSessions({ email }: { email: string | null }): JSX.Element {
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Subhead>Sessions</Subhead>
      <p className="mb-2 font-mono text-[10px] leading-snug text-txt-2">
        Ends every sign-in except this one: other browsers, other devices, a machine you forgot
        to sign out of.
      </p>
      <CurrentPasswordInput id="sessions-current" value={current} onChange={setCurrent} />
      <button
        type="button"
        disabled={busy || !current}
        className={SECONDARY}
        onClick={() => {
          if (!supabase) return;
          const client = supabase;
          setBusy(true);
          setError(null);
          void proveCurrentPassword(email, current)
            .then(async () => {
              const { error: err } = await client.auth.signOut({ scope: 'others' });
              if (err) toast.error(`Could not sign out other sessions: ${err.message}`);
              else {
                setCurrent('');
                toast.ok('Other sessions signed out.');
              }
            })
            .catch((err: unknown) => setError(errText(err)))
            .finally(() => setBusy(false));
        }}
      >
        Sign out other sessions
      </button>
      {error && (
        <InlineAlert tone="alert" className="mt-2 font-mono">
          {error}
        </InlineAlert>
      )}
    </div>
  );
}

interface Enrolment {
  factorId: string;
  qr: string;
  secret: string;
}

function TwoFactor({ email }: { email: string | null }): JSX.Element {
  const [factors, setFactors] = useState<Factor[]>([]);
  // Adding or removing an authenticator proves the current password first
  // (ASVS V7.5.1): GoTrue lets an aal1 session enrol a first factor, so a
  // hijacked single-factor session could otherwise lock the owner out.
  const [current, setCurrent] = useState('');
  // After a change, other sessions end by default (ASVS V7.4.3).
  const [others, setOthers] = useState(true);
  const [stepUp, setStepUp] = useState(false);
  const [enrol, setEnrol] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    if (!supabase) return;
    const [{ data: list }, { data: aal }] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    setFactors(list?.all.filter((f) => f.factor_type === 'totp') ?? []);
    setStepUp(needsStepUp(aal));
  }

  useEffect(() => {
    void refresh().catch((err: unknown) => setError(errText(err)));
  }, []);

  const verified = factors.filter((f) => f.status === 'verified');

  async function startEnrol(): Promise<void> {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      await proveCurrentPassword(email, current);
      setCurrent('');
      // An abandoned enrolment leaves an unverified factor that blocks a new one.
      for (const f of factors.filter((x) => x.status !== 'verified')) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: err } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
      });
      if (err) throw err;
      // qr_code is already a data:image/svg+xml URI (auth-js prefixes it).
      setEnrol({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      setCode('');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrol(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!supabase || !enrol) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrol.factorId,
        code,
      });
      if (err) throw err;
      setEnrol(null);
      useMfaNeeded.getState().clear();
      await endOtherSessions();
      toast.ok(
        others
          ? 'Authenticator added. Sign-ins now ask for a code, and your other sessions are signed out.'
          : 'Authenticator added. Sign-ins now ask for a code.',
      );
      await refresh();
    } catch (err) {
      setError(errText(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function endOtherSessions(): Promise<void> {
    if (!supabase || !others) return;
    const { error: err } = await supabase.auth.signOut({ scope: 'others' });
    if (err) toast.error(`Could not sign out other sessions: ${err.message}`);
  }

  async function remove(f: Factor): Promise<void> {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      await proveCurrentPassword(email, current);
      setCurrent('');
      const { error: err } = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (err) throw err;
      await endOtherSessions();
      toast.ok(others ? 'Authenticator removed. Your other sessions are signed out.' : 'Authenticator removed.');
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Subhead>Two-factor authentication</Subhead>
      {stepUp && (
        <div className="mb-3">
          <TotpChallenge
            intro="This session signed in with a password only. Enter a code to unlock operator actions."
            onDone={() => {
              toast.ok('Code accepted.');
              void refresh();
            }}
          />
        </div>
      )}
      {verified.length === 0 && !enrol && (
        <p className="mb-2 font-mono text-[10px] leading-snug text-txt-2">
          Off. Operator actions on a multi-user deployment need an authenticator app code at
          sign-in.
        </p>
      )}
      {!enrol && (
        <>
          <CurrentPasswordInput id="mfa-current" value={current} onChange={setCurrent} />
          <SignOutOthersBox checked={others} onChange={setOthers} />
        </>
      )}
      {verified.map((f) => (
        <div key={f.id} className="mb-1.5 flex items-center justify-between gap-2">
          <span className="mono truncate text-[11px] text-txt-1">
            {f.friendly_name || 'Authenticator'} · added {f.created_at.slice(0, 10)}
          </span>
          <button
            type="button"
            disabled={busy || !current}
            className={SECONDARY}
            onClick={() => void remove(f)}
          >
            Remove
          </button>
        </div>
      ))}
      {enrol ? (
        <form onSubmit={confirmEnrol}>
          <p className="mb-2 font-mono text-[10px] leading-snug text-txt-2">
            Scan this with an authenticator app, then enter the code it shows.
          </p>
          <img
            src={enrol.qr}
            alt="QR code to add this account to an authenticator app"
            className="mb-2 h-40 w-40 rounded-sm bg-white p-1.5"
          />
          <p className="mb-3 break-all font-mono text-[10px] text-txt-2">
            Can't scan? Enter this key: <span className="select-all text-txt-1">{enrol.secret}</span>
          </p>
          <CodeInput id="enrol-code" value={code} onChange={setCode} />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || code.length !== 6} className={PRIMARY}>
              {busy ? '…' : 'Confirm'}
            </button>
            <button type="button" className={SECONDARY} onClick={() => setEnrol(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        verified.length === 0 && (
          <button
            type="button"
            disabled={busy || !current}
            className={SECONDARY}
            onClick={() => void startEnrol()}
          >
            Set up an authenticator app
          </button>
        )
      )}
      {error && (
        <InlineAlert tone="alert" className="mt-2 font-mono">
          {error}
        </InlineAlert>
      )}
    </div>
  );
}
