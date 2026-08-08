// Guards for the briefing deck.
//
// A deck is only useful if it advances without the mouse, so the keyboard is
// the contract: arrows, space, Home/End, Esc. The clamping matters too — a
// presenter holding the right arrow at the last slide must not fall off the end
// into a blank screen mid-brief.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SlidesDeck, type Slide } from './SlidesDeck.js';

const SLIDES: Slide[] = [
  { title: 'One', body: <p>first</p> },
  { title: 'Two', body: <p>second</p> },
  { title: 'Three', body: <p>third</p> },
];

function open(slides: Slide[] = SLIDES): { onClose: () => void } {
  const onClose = vi.fn();
  render(<SlidesDeck slides={slides} classification="Unclassified" onClose={onClose} />);
  return { onClose };
}

/** The counter in the chrome, e.g. "2 / 3". The print-only copy of every slide
 *  is in the DOM too, so asserting on slide titles would match twice. */
function position(): string {
  return screen.getByText(/^\d+ \/ \d+$/).textContent ?? '';
}

describe('SlidesDeck', () => {
  it('opens on the first slide', () => {
    open();
    expect(position()).toBe('1 / 3');
  });

  it('advances and goes back with the arrow keys', () => {
    open();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(position()).toBe('2 / 3');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(position()).toBe('1 / 3');
  });

  it('advances with space, the key a presenter remote sends', () => {
    open();
    fireEvent.keyDown(window, { key: ' ' });
    expect(position()).toBe('2 / 3');
  });

  it('does not run off either end', () => {
    open();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(position()).toBe('1 / 3');
    for (let i = 0; i < 10; i++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(position()).toBe('3 / 3');
  });

  it('jumps to the ends with Home and End', () => {
    open();
    fireEvent.keyDown(window, { key: 'End' });
    expect(position()).toBe('3 / 3');
    fireEvent.keyDown(window, { key: 'Home' });
    expect(position()).toBe('1 / 3');
  });

  it('closes on Escape', () => {
    const { onClose } = open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves other keys to the rest of the app', () => {
    const { onClose } = open();
    fireEvent.keyDown(window, { key: 'a' });
    expect(position()).toBe('1 / 3');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders every slide for print, not only the current one', () => {
    const { container } = render(
      <SlidesDeck slides={SLIDES} classification="Unclassified" onClose={() => undefined} />,
    );
    // A PDF containing only whichever slide happened to be on screen would be
    // the bug, so the print stack carries one page per slide regardless of
    // where the presenter is.
    expect(container.querySelectorAll('.slides-print-all .slides-page')).toHaveLength(
      SLIDES.length,
    );
    for (const s of SLIDES) expect(screen.getAllByText(s.title).length).toBeGreaterThan(0);
    // The on-screen slide is the extra copy of exactly one title.
    expect(screen.getAllByText('One')).toHaveLength(2);
    expect(screen.getAllByText('Three')).toHaveLength(1);
  });

  it('renders nothing when there are no slides', () => {
    const { container } = render(
      <SlidesDeck slides={[]} classification="Unclassified" onClose={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
