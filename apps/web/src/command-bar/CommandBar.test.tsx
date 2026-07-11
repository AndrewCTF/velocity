import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommandBar } from './CommandBar.js';
import { useImagery } from '../state/stores.js';

describe('CommandBar basemap picker', () => {
  beforeEach(() => {
    useImagery.getState().setMode('2d-dark');
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

  it('lists the six third-party basemap modes alongside the two keyless stacks', () => {
    render(<CommandBar viewer={null} ionToken="" />);
    const picker = screen.getByTestId('basemap-picker');
    const values = Array.from(picker.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual([
      '2d-dark',
      '3d-sat',
      'esri-imagery',
      'esri-topo',
      'esri-dark',
      'opentopo',
      'usgs-imagery',
      'eox-s2',
    ]);
  });
});
