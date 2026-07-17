// Keyless /ws/alerts policy: try the upgrade ONCE. An open-mode backend
// accepts it (chip goes live); an enforcing backend rejects it before open —
// then we stay closed with no reconnect loop (the old always-skip showed a
// permanent "LINK down" pill on every open-mode box).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { AlertSubscriber } from './AlertSubscriber.js';
import { useConnection } from '../state/stores.js';

vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({ session: null, loading: false }),
}));
vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(() => Promise.resolve()),
  hasStaticApiKey: () => false,
  withWsKey: (u: string) => u,
}));

class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  close(): void {}
}

function inst(i: number): FakeWS {
  const w = FakeWS.instances[i];
  if (!w) throw new Error(`no FakeWS instance ${i}`);
  return w;
}

describe('AlertSubscriber keyless probe', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWS);
    useConnection.setState({ ws: 'connecting' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('attempts the upgrade once and adopts it if the backend accepts', () => {
    render(<AlertSubscriber />);
    expect(FakeWS.instances.length).toBe(1);
    act(() => inst(0).onopen?.());
    expect(useConnection.getState().ws).toBe('open');
  });

  it('stays closed with no retry loop when rejected before open', () => {
    render(<AlertSubscriber />);
    expect(FakeWS.instances.length).toBe(1);
    act(() => inst(0).onclose?.());
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWS.instances.length).toBe(1); // no reconnect
    expect(useConnection.getState().ws).toBe('closed');
  });

  it('reconnects after a drop only if the socket had opened', () => {
    render(<AlertSubscriber />);
    act(() => inst(0).onopen?.());
    act(() => inst(0).onclose?.());
    act(() => vi.advanceTimersByTime(2_000));
    expect(FakeWS.instances.length).toBe(2);
  });
});
