import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Console } from './Console.js';

// Guards for two controls that rendered and did nothing.
//
// 1. The four named tabs stayed clickable while a full-bleed app (Foundry, AI,
//    Workflows, City, Country, Markets) had removed the panel column, so every
//    tab took the selected state and showed nothing. Measured live before the
//    fix: `document.querySelectorAll('aside.csl2-panel').length === 0` with the
//    Find tab reading aria-selected="true".
// 2. The Help menu advertised "1-4 left panels" and every tab's tooltip named
//    its number key, and nothing was listening for a keystroke.

const panels = {
  layers: <div>layers-body</div>,
  find: <div>find-body</div>,
  histogram: <div>histogram-body</div>,
  info: <div>info-body</div>,
};

describe('Console left panels', () => {
  it('a number key selects the panel its tooltip names', () => {
    render(<Console map={<div>map</div>} leftPanels={panels} rightPanels={{}} />);
    expect(screen.getByText('layers-body')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '2' });
    expect(screen.getByText('find-body')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '4' });
    expect(screen.getByText('info-body')).toBeInTheDocument();
  });

  it('a number key typed into a field is left alone', () => {
    render(
      <Console
        map={<div>map</div>}
        leftPanels={{ ...panels, layers: <input aria-label="q" /> }}
        rightPanels={{}}
      />,
    );
    const input = screen.getByLabelText('q');
    fireEvent.keyDown(input, { key: '3' });
    expect(screen.queryByText('histogram-body')).not.toBeInTheDocument();
  });

  it('asking for a panel in full bleed reports it, so the caller can restore the map', () => {
    const onPanelWhileBleed = vi.fn();
    render(
      <Console
        map={<div>map</div>}
        leftPanels={panels}
        rightPanels={{}}
        bleed
        onPanelWhileBleed={onPanelWhileBleed}
      />,
    );
    // The column really is gone — this is the state the tabs were lying about.
    expect(screen.queryByLabelText('Left panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Find/ }));
    expect(onPanelWhileBleed).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: '3' });
    expect(onPanelWhileBleed).toHaveBeenCalledTimes(2);
  });

  it('no tab claims the selected state while full bleed has the body', () => {
    render(<Console map={<div>map</div>} leftPanels={panels} rightPanels={{}} bleed />);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('aria-selected', 'false');
    }
  });
});
