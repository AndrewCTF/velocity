import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline.js';

// Timeline is now a thin wrapper around shell/TimeDock.tsx (the one real
// transport — see the comment at the top of Timeline.tsx for why). The
// functional transport behaviour (Play driving the clock, seek, day/time
// pickers driving loadAt) is covered by shell/TimeDock.test.tsx; this file
// only needs to prove the 2D console's bottom dock still renders — App2D.tsx
// mounts `<Timeline />` with no viewer at all.

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response),
}));

describe('Timeline (2D dock wrapper)', () => {
  it('renders TimeDock with no viewer, same as App2D mounts it', () => {
    render(<Timeline />);
    expect(screen.getByTitle('Play or pause (space)')).toBeInTheDocument();
    expect(screen.getByTitle('Return to live (L)')).toBeInTheDocument();
  });

  it('re-exports stepSpeed from shell/TimeDock for timeline/transport.test.ts', async () => {
    const mod = await import('./Timeline.js');
    expect(mod.stepSpeed(1, 1)).toBe(10);
  });
});
