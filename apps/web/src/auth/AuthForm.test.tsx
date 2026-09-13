import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Settings → Account re-authentication (ASVS V6.2.3, V7.2.4, V7.4.3, V7.5.1,
// V7.5.2). Every account-security change proves the current password first,
// and the proof must not leave a second live session behind: it runs on a
// throwaway client whose session is revoked straight away, never on the app's
// own client.

const { main, proof } = vi.hoisted(() => {
  const main = {
    auth: {
      signInWithPassword: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ data: {}, error: null })),
      reauthenticate: vi.fn(),
      mfa: {
        listFactors: vi.fn(),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: 'aal2', nextLevel: 'aal2' },
          error: null,
        })),
        enroll: vi.fn(async () => ({
          data: { id: 'new', totp: { qr_code: 'data:image/png;base64,', secret: 'S' } },
          error: null,
        })),
        unenroll: vi.fn(async () => ({ error: null })),
        challengeAndVerify: vi.fn(async () => ({ error: null })),
      },
    },
  };
  const proof = {
    auth: {
      signInWithPassword: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
    },
  };
  return { main, proof };
});

vi.mock('../transport/supabase.js', () => ({
  supabase: main,
  createReauthClient: () => proof,
}));
vi.mock('./AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@example.test' } }),
}));
vi.mock('../shell/toast.js', () => ({
  toast: { ok: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), dismiss: vi.fn() },
}));

import { AccountSecurity } from './AuthForm.js';

const VERIFIED = {
  id: 'f1',
  factor_type: 'totp',
  status: 'verified',
  friendly_name: 'Phone',
  created_at: '2026-09-01T00:00:00Z',
};

function factors(list: unknown[]): void {
  main.auth.mfa.listFactors.mockResolvedValue({
    data: { all: list, totp: list.filter((f) => (f as { status: string }).status === 'verified') },
    error: null,
  });
}

function passwordOk(ok: boolean): void {
  proof.auth.signInWithPassword.mockResolvedValue(
    ok ? { data: { session: {} }, error: null } : { data: {}, error: new Error('Invalid login credentials') },
  );
}

function type(label: string, value: string): void {
  fireEvent.change(document.getElementById(label)!, { target: { value } });
}

describe('account security re-authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factors([]);
    passwordOk(true);
  });
  afterEach(cleanup);

  it('changes the password with the current one, without minting a second app session', async () => {
    render(<AccountSecurity />);
    type('pw-current', 'old-password');
    type('pw-new', 'new-password-long');
    fireEvent.submit(document.getElementById('pw-new')!.closest('form')!);
    await waitFor(() => expect(main.auth.updateUser).toHaveBeenCalled());
    expect(proof.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@example.test',
      password: 'old-password',
    });
    expect(proof.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(main.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(main.auth.updateUser).toHaveBeenCalledWith({
      password: 'new-password-long',
      current_password: 'old-password',
    });
    expect(main.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('refuses the change when the current password is wrong', async () => {
    passwordOk(false);
    render(<AccountSecurity />);
    type('pw-current', 'nope');
    type('pw-new', 'new-password-long');
    fireEvent.submit(document.getElementById('pw-new')!.closest('form')!);
    await screen.findByText('The current password is not right.');
    expect(main.auth.updateUser).not.toHaveBeenCalled();
  });

  it('asks for the password before signing out other sessions', async () => {
    render(<AccountSecurity />);
    const button = screen.getByRole('button', { name: 'Sign out other sessions' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    type('sessions-current', 'old-password');
    fireEvent.click(button);
    await waitFor(() => expect(main.auth.signOut).toHaveBeenCalledWith({ scope: 'others' }));
    expect(proof.auth.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it('does not sign out other sessions on a wrong password', async () => {
    passwordOk(false);
    render(<AccountSecurity />);
    type('sessions-current', 'nope');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out other sessions' }));
    await waitFor(() => expect(proof.auth.signInWithPassword).toHaveBeenCalled());
    await waitFor(() => expect(main.auth.signOut).not.toHaveBeenCalled());
  });

  it('proves the password before enrolling an authenticator, then offers to end other sessions', async () => {
    render(<AccountSecurity />);
    const start = await screen.findByRole('button', { name: 'Set up an authenticator app' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    type('mfa-current', 'old-password');
    fireEvent.click(start);
    await waitFor(() => expect(main.auth.mfa.enroll).toHaveBeenCalled());
    expect(proof.auth.signInWithPassword).toHaveBeenCalledTimes(1);

    type('enrol-code', '123456');
    fireEvent.submit(document.getElementById('enrol-code')!.closest('form')!);
    await waitFor(() => expect(main.auth.signOut).toHaveBeenCalledWith({ scope: 'others' }));
  });

  it('does not enrol on a wrong password', async () => {
    passwordOk(false);
    render(<AccountSecurity />);
    const start = await screen.findByRole('button', { name: 'Set up an authenticator app' });
    type('mfa-current', 'nope');
    fireEvent.click(start);
    await screen.findAllByText('The current password is not right.');
    expect(main.auth.mfa.enroll).not.toHaveBeenCalled();
  });

  it('proves the password before removing an authenticator, then ends other sessions', async () => {
    factors([VERIFIED]);
    render(<AccountSecurity />);
    const remove = await screen.findByRole('button', { name: 'Remove' });
    type('mfa-current', 'old-password');
    fireEvent.click(remove);
    await waitFor(() => expect(main.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'f1' }));
    expect(proof.auth.signInWithPassword).toHaveBeenCalled();
    await waitFor(() => expect(main.auth.signOut).toHaveBeenCalledWith({ scope: 'others' }));
  });
});
