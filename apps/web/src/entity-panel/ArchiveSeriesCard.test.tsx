import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Trace } from './ArchiveSeriesCard.js';

// The one rule worth pinning: a gap in the archive is drawn as a gap.
// Bridging it with a straight segment would assert a position between two fixes
// that nobody observed, which is the same class of invention the no-synthesis
// motion guardrail exists to prevent.

function pathOf(el: HTMLElement): string {
  return el.querySelector('path')?.getAttribute('d') ?? '';
}

describe('Trace', () => {
  it('breaks the line across a missing sample instead of interpolating', () => {
    const { container } = render(<Trace values={[10, null, 30]} />);
    const d = pathOf(container);
    // Two move commands: the pen lifts at the gap and starts a new segment.
    expect((d.match(/M/g) ?? []).length).toBe(2);
  });

  it('draws one continuous segment when there are no gaps', () => {
    const { container } = render(<Trace values={[10, 20, 30]} />);
    const d = pathOf(container);
    expect((d.match(/M/g) ?? []).length).toBe(1);
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });

  it('renders nothing rather than a misleading flat line for one sample', () => {
    const { container } = render(<Trace values={[10, null, null]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('survives an all-null series', () => {
    const { container } = render(<Trace values={[null, null]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('handles a flat series without dividing by zero', () => {
    const { container } = render(<Trace values={[5, 5, 5]} />);
    expect(pathOf(container)).not.toContain('NaN');
  });
});
