import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What the backend last said about itself. The "Google 3D" basemap reads it.
const server = vi.hoisted(() => ({ google3dKeyless: false }));
vi.mock('../transport/config.js', async (original) => ({
  ...(await original<typeof import('../transport/config.js')>()),
  latestRuntimeConfig: () => ({
    cesiumIonToken: '',
    googleApiKey: '',
    features: { enableGoogle3D: false, google3dKeyless: server.google3dKeyless },
    classification: 'UNCLAS',
    buildId: 'test',
  }),
}));

import { CommandBar } from './CommandBar.js';
import { useImagery } from '../state/stores.js';

describe('CommandBar basemap picker', () => {
  beforeEach(() => {
    useImagery.getState().setMode('2d-dark');
    server.google3dKeyless = false;
  });

  it('offers Google 3D only where the server has it switched on', () => {
    const option = (): HTMLOptionElement =>
      screen.getByRole('option', { name: 'Google 3D' }) as HTMLOptionElement;

    const off = render(<CommandBar viewer={null} ionToken="" />);
    expect(option().disabled).toBe(true);
    expect(option().title).toMatch(/GOOGLE_3D_KEYLESS/); // says how to turn it on
    off.unmount();

    server.google3dKeyless = true;
    render(<CommandBar viewer={null} ionToken="" />);
    expect(option().disabled).toBe(false);
    fireEvent.change(screen.getByTestId('basemap-picker'), { target: { value: 'google-3d' } });
    expect(useImagery.getState().mode).toBe('google-3d');
  });

  it('is usable WITHOUT an ion token — 3d-sat runs on the keyless stack', () => {
    render(<CommandBar viewer={null} ionToken="" />);
    const picker = screen.getByTestId('basemap-picker');
    expect(picker).not.toBeDisabled();
    fireEvent.change(picker, { target: { value: '3d-sat' } });
    expect(useImagery.getState().mode).toBe('3d-sat');
    fireEvent.change(picker, { target: { value: '2d-dark' } });
    expect(useImagery.getState().mode).toBe('2d-dark');
  });

  it('lists the six third-party basemap modes alongside the four keyless stacks', () => {
    render(<CommandBar viewer={null} ionToken="" />);
    const picker = screen.getByTestId('basemap-picker');
    const values = Array.from(picker.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual([
      '2d-dark',
      '3d-sat',
      'google-3d',
      'apple-sat',
      'esri-imagery',
      'esri-topo',
      'esri-dark',
      'opentopo',
      'usgs-imagery',
      'eox-s2',
    ]);
  });
});
