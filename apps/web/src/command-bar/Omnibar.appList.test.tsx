import { render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { Omnibar } from './Omnibar.js';
import { useAppView, APP_IDS, APP_META } from '../state/appView.js';
import { usePalette } from '../state/palette.js';
import { LayerRegistry } from '../registry/LayerRegistry.js';

// Every app but the active one renders icon-only in the switcher, and the
// onboarding tour names four of the fourteen. So the ten that carry what the
// README stakes the product on (Investigate, Reports, Foundry, Workflows,
// Country, Markets...) had no address a newcomer could read. The command bar
// is where you look for "what is in this thing"; it has to answer.
describe('Omnibar app directory', () => {
  beforeEach(() => {
    useAppView.getState().setApp('map');
    usePalette.getState().setOpen(true);
  });

  it('lists every app, with its one-line hint, on an empty query', () => {
    render(<Omnibar viewer={null} registry={new LayerRegistry()} />);
    for (const id of APP_IDS) {
      expect(screen.getByText(`Open ${APP_META[id].label}`)).toBeInTheDocument();
    }
    // The hint is what makes it a directory rather than a jump list.
    expect(screen.getAllByText(APP_META.foundry.hint).length).toBeGreaterThan(0);
  });
});
