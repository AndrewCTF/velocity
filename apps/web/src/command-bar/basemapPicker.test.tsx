// Owner-F3 test (docs/places-airspace-plan.md §6): selecting a basemap mode
// updates useImagery, and each third-party mode's provider URL builder
// returns the expected tile template. Axis order is asserted explicitly
// because it differs by host (Esri/USGS = {z}/{y}/{x}; OpenTopo/EOX =
// {z}/{x}/{y}) and a swapped order is a silent-broken-tiles bug, not a
// crash.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';

// GlobeCanvas.tsx pulls in @macrostrat/cesium-martini for terrain, whose
// worker-factory constructor calls URL.createObjectURL — unimplemented in
// jsdom and unrelated to what this file tests (the basemap URL templates).
// Stub it so importing GlobeCanvas.tsx for THIRD_PARTY_BASEMAPS doesn't blow
// up under vitest; nothing in this test exercises terrain.
vi.mock('@macrostrat/cesium-martini', () => ({ MapboxTerrainProvider: class {} }));

import { CommandBar } from './CommandBar.js';
import { useImagery } from '../state/stores.js';
import { THIRD_PARTY_BASEMAPS } from '../globe/GlobeCanvas.js';

describe('basemap picker — store wiring', () => {
  beforeEach(() => {
    useImagery.getState().setMode('2d-dark');
  });

  it('selecting a mode updates useImagery', () => {
    render(<CommandBar viewer={null} ionToken="" />);
    const picker = screen.getByTestId('basemap-picker');
    expect(useImagery.getState().mode).toBe('2d-dark');

    fireEvent.change(picker, { target: { value: 'eox-s2' } });
    expect(useImagery.getState().mode).toBe('eox-s2');

    fireEvent.change(picker, { target: { value: 'esri-topo' } });
    expect(useImagery.getState().mode).toBe('esri-topo');
  });

  it('defaults to 2d-dark', () => {
    render(<CommandBar viewer={null} ionToken="" />);
    expect((screen.getByTestId('basemap-picker') as HTMLSelectElement).value).toBe('2d-dark');
  });
});

describe('third-party basemap provider URL templates', () => {
  it('Esri World Imagery uses {z}/{y}/{x} order', () => {
    expect(THIRD_PARTY_BASEMAPS['esri-imagery'].url).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    );
    expect(THIRD_PARTY_BASEMAPS['esri-imagery'].maximumLevel).toBe(19);
  });

  it('Esri World Topo uses {z}/{y}/{x} order', () => {
    expect(THIRD_PARTY_BASEMAPS['esri-topo'].url).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    );
  });

  it('Esri Dark Gray Canvas uses {z}/{y}/{x} order', () => {
    expect(THIRD_PARTY_BASEMAPS['esri-dark'].url).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    );
  });

  it('OpenTopoMap uses {z}/{x}/{y} order (differs from Esri)', () => {
    expect(THIRD_PARTY_BASEMAPS['opentopo'].url).toBe(
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    );
    expect(THIRD_PARTY_BASEMAPS['opentopo'].maximumLevel).toBe(17);
  });

  it('USGS Imagery Only uses {z}/{y}/{x} order', () => {
    expect(THIRD_PARTY_BASEMAPS['usgs-imagery'].url).toBe(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    );
    expect(THIRD_PARTY_BASEMAPS['usgs-imagery'].maximumLevel).toBe(16);
  });

  it('EOX s2cloudless uses {z}/{x}/{y} order (differs from Esri/USGS)', () => {
    expect(THIRD_PARTY_BASEMAPS['eox-s2'].url).toBe(
      'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
    );
    expect(THIRD_PARTY_BASEMAPS['eox-s2'].maximumLevel).toBe(14);
  });

  it('every mode carries a non-empty attribution credit', () => {
    for (const def of Object.values(THIRD_PARTY_BASEMAPS)) {
      expect(def.credit.length).toBeGreaterThan(0);
    }
  });
});
