import { describe, it, expect } from 'vitest';
import { LayerRegistry } from '../registry/LayerRegistry.js';
import { registerDefaults } from '../registry/defaults.js';
import { MAP_LAYER_FOLDERS, HIDDEN_SOURCE_IDS, catalogLayerIds } from './layerCatalog.js';

// The catalog must stay in lock-step with the registry: every id it references must exist,
// and every registered layer must be either shown (in a folder row) or explicitly hidden —
// no orphaned layer silently vanishes from both Map layers AND Data sources.
describe('layerCatalog vs registry', () => {
  const reg = new LayerRegistry();
  registerDefaults(reg);
  const registered = new Set(reg.list().map((l) => l.id));
  const covered = new Set(catalogLayerIds());
  const hidden = new Set(HIDDEN_SOURCE_IDS);

  it('every catalog + hidden id is a real registered layer', () => {
    for (const id of [...covered, ...hidden]) expect(registered.has(id)).toBe(true);
  });

  it('covered and hidden sets are disjoint', () => {
    for (const id of covered) expect(hidden.has(id)).toBe(false);
  });

  it('every registered layer is either shown or hidden (nothing orphaned)', () => {
    const orphans = [...registered].filter((id) => !covered.has(id) && !hidden.has(id));
    expect(orphans).toEqual([]);
  });

  it('no duplicate layer id across folder rows', () => {
    const seen = new Set<string>();
    for (const f of MAP_LAYER_FOLDERS) for (const r of f.rows) for (const id of r.layerIds) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
