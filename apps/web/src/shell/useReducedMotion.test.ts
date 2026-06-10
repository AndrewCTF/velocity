import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useReducedMotion } from './useReducedMotion.js';

interface FakeMql {
  matches: boolean;
  listeners: Set<(e: MediaQueryListEvent) => void>;
  addEventListener: (t: string, fn: (e: MediaQueryListEvent) => void) => void;
  removeEventListener: (t: string, fn: (e: MediaQueryListEvent) => void) => void;
}

let fakeMql: FakeMql;

beforeEach(() => {
  fakeMql = {
    matches: false,
    listeners: new Set(),
    addEventListener: (_t, fn) => fakeMql.listeners.add(fn),
    removeEventListener: (_t, fn) => fakeMql.listeners.delete(fn),
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(() => fakeMql as unknown as MediaQueryList);
});

describe('useReducedMotion', () => {
  it('returns initial query state', () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('reacts to media query changes', () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => {
      fakeMql.matches = true;
      for (const fn of fakeMql.listeners) fn({ matches: true } as MediaQueryListEvent);
    });
    expect(result.current).toBe(true);
  });
});
