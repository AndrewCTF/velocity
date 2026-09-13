import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleTimer, idleMinutesFrom, DEFAULT_IDLE_MINUTES, localActivityStore, LAST_ACTIVITY_KEY } from './idle.js';

const MIN = 60_000;

describe('idle sign-out timer (ASVS V7.3.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(minutes = 30) {
    const onWarn = vi.fn();
    const onResume = vi.fn();
    const onIdle = vi.fn();
    const timer = createIdleTimer({ timeoutMs: () => minutes * MIN, onWarn, onResume, onIdle });
    return { timer, onWarn, onResume, onIdle };
  }

  it('warns a minute before, then signs out at the timeout', () => {
    const { onWarn, onIdle } = make(30);
    vi.advanceTimersByTime(29 * MIN - 1);
    expect(onWarn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onWarn).toHaveBeenCalledWith(MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('input pushes the deadline back', () => {
    const { timer, onIdle } = make(30);
    vi.advanceTimersByTime(20 * MIN);
    timer.activity();
    vi.advanceTimersByTime(20 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('input after the warning withdraws it and restarts the full window', () => {
    const { timer, onWarn, onResume, onIdle } = make(30);
    vi.advanceTimersByTime(29 * MIN + 30_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    timer.activity();
    expect(onResume).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('fires once, and nothing after stop()', () => {
    const { timer, onIdle } = make(1);
    vi.advanceTimersByTime(MIN);
    timer.activity();
    vi.advanceTimersByTime(10 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);

    const b = make(1);
    b.timer.stop();
    vi.advanceTimersByTime(10 * MIN);
    expect(b.onIdle).not.toHaveBeenCalled();
    expect(b.onWarn).not.toHaveBeenCalled();
  });

  it('reads the timeout from runtime config when sane, else 30 minutes', () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(30);
    expect(idleMinutesFrom(null)).toBe(30);
    expect(idleMinutesFrom({ sessionIdleTimeoutMin: 15 })).toBe(15);
    expect(idleMinutesFrom({ sessionIdleTimeoutMin: 0 })).toBe(30);
    expect(idleMinutesFrom({ sessionIdleTimeoutMin: '15' })).toBe(30);
  });
});

// A closed tab stops the in-page timer but keeps the refresh token, so the
// session used to resume after any idle stretch. The last input time now
// outlives the tab and is checked when the timer starts.
describe('idle sign-out across a closed tab (ASVS V7.3.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(minutes = 30) {
    const onIdle = vi.fn();
    const timer = createIdleTimer({
      timeoutMs: () => minutes * MIN,
      onWarn: vi.fn(),
      onResume: vi.fn(),
      onIdle,
      lastActivity: localActivityStore(),
    });
    return { timer, onIdle };
  }

  it('signs out at start when the last input is older than the timeout', () => {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - 31 * MIN));
    const { onIdle } = make(30);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('keeps a recent session and resumes the countdown from now', () => {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - 5 * MIN));
    const { onIdle } = make(30);
    expect(onIdle).not.toHaveBeenCalled();
    expect(Number(localStorage.getItem(LAST_ACTIVITY_KEY))).toBe(Date.now());
  });

  it('records input so the next load sees it', () => {
    const { timer } = make(30);
    vi.advanceTimersByTime(10 * MIN);
    timer.activity();
    expect(Number(localStorage.getItem(LAST_ACTIVITY_KEY))).toBe(Date.now());
  });

  it('treats no record as fresh, and clear() forgets it', () => {
    const { onIdle } = make(30);
    expect(onIdle).not.toHaveBeenCalled();
    localActivityStore().clear();
    expect(localStorage.getItem(LAST_ACTIVITY_KEY)).toBeNull();
  });
});
