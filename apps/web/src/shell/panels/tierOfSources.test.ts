import { describe, it, expect } from 'vitest';
import type { LayerDescriptor } from '@osint/shared';
import { LayerRegistry } from '../../registry/LayerRegistry.js';
import { defaultLayers } from '../../registry/defaults.js';
import { tierOfSources } from './SelectionPanel.js';

// A contact carries the SOURCE that saw it (`digitraffic`, `adsb`), never a
// layer id, so the dossier cannot look its tier up directly. This is the join,
// and the two things it must not do are assume a tier for a source it does not
// recognise, and round a fused contact UP to its strongest input.

function registry(): LayerRegistry {
  const r = new LayerRegistry();
  for (const l of defaultLayers as readonly LayerDescriptor[]) r.register(l);
  return r;
}

describe('tierOfSources', () => {
  it('resolves a live AIS contact to the sensor tier', () => {
    expect(tierOfSources(registry(), { source: 'digitraffic' })).toBe('sensor');
  });

  it('resolves a GDELT-sourced contact to the claim tier', () => {
    expect(tierOfSources(registry(), { source: 'gdelt' })).toBe('claim');
  });

  it('takes the WEAKEST tier when a contact names several sources', () => {
    // Rounding this up is exactly the laundering the tier exists to stop.
    expect(tierOfSources(registry(), { sources: ['digitraffic', 'gdelt'] })).toBe('claim');
  });

  it('yields nothing for a source it does not recognise', () => {
    expect(tierOfSources(registry(), { source: 'some-unknown-feed' })).toBeUndefined();
    expect(tierOfSources(registry(), {})).toBeUndefined();
  });

  it('ignores a non-string source rather than stringifying it', () => {
    expect(tierOfSources(registry(), { source: 42 })).toBeUndefined();
    expect(tierOfSources(registry(), { sources: [] })).toBeUndefined();
  });
});
