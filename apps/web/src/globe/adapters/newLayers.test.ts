import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { baseStyle, tfrPolygonStyle, warningStyle } from './styles.js';
import { baseLabelText, tfrLabelText, warningLabelText } from './labelStyle.js';
import { defaultLayers } from '../../registry/defaults.js';

// W5 places/airspace enrichment wave: three new layers on the existing
// PollGeoJsonAdapter — airspace.tfr (polygon), places.bases (icon by
// branch), maritime.warnings (icon, mine variant). Mirrors the style of
// eventStyle.test.ts (pure-function assertions on the style/label helpers)
// and invariants.test.ts (source-scan guards for dispatch wiring that would
// otherwise need a full Cesium Viewer to exercise).

const ADAPTER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'PollGeoJsonAdapter.ts'),
  'utf8',
);
const COMPOSITOR_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'LayerCompositor.ts'),
  'utf8',
);

describe('tfrPolygonStyle', () => {
  it('returns a translucent fill + a solid-hue outline for every reason category', () => {
    const cases: Array<[string, string]> = [
      ['SECURITY/VIP', '#ef4444'],
      ['HAZARDS', '#f59e0b'],
      ['AIR SHOWS', '#38bdf8'],
      ['SPORTS', '#38bdf8'],
      ['SPACE OPERATIONS', '#a78bfa'],
      ['UAS PUBLIC GATHERING', '#2dd4bf'],
      ['SOMETHING ELSE ENTIRELY', '#8b98a8'],
    ];
    for (const [type, hex] of cases) {
      const s = tfrPolygonStyle({ type });
      expect(s.fillColor).toBe(hex);
      expect(s.outlineColor).toBe(hex);
      // Fill must be translucent (never opaque — the polygon would obscure
      // the terrain/other layers underneath) but still visible.
      expect(s.alpha).toBeGreaterThan(0);
      expect(s.alpha).toBeLessThan(1);
    }
  });

  it('falls back to gray, never guessing a reason, when type is missing', () => {
    expect(tfrPolygonStyle({}).fillColor).toBe('#8b98a8');
  });
});

describe('tfrLabelText', () => {
  it('prefers facility, falls back to notam_id', () => {
    expect(tfrLabelText({ facility: 'ZDC', notam_id: '6/4909' })).toBe('ZDC');
    expect(tfrLabelText({ facility: null, notam_id: '6/4909' })).toBe('6/4909');
    expect(tfrLabelText({})).toBeNull();
  });
});

describe('baseStyle', () => {
  it('emits a billboard icon (data-URI SVG, never a bare point) per branch', () => {
    const air = baseStyle({ branch: 'air' });
    const naval = baseStyle({ branch: 'naval' });
    const army = baseStyle({ branch: 'army' });
    for (const s of [air, naval, army]) {
      expect(s.imageUri).toMatch(/^data:image\/svg\+xml/);
    }
    // Three branches -> three visually distinct icons.
    expect(new Set([air.imageUri, naval.imageUri, army.imageUri]).size).toBe(3);
  });

  it('falls back to the air glyph for an unrecognized branch rather than dropping the icon', () => {
    const unknown = baseStyle({ branch: 'space-force' });
    const air = baseStyle({ branch: 'air' });
    expect(unknown.imageUri).toBe(air.imageUri);
  });
});

describe('baseLabelText', () => {
  it('labels by name', () => {
    expect(baseLabelText({ name: 'RAF Lakenheath' })).toBe('RAF Lakenheath');
    expect(baseLabelText({})).toBeNull();
  });
});

describe('warningStyle', () => {
  it('emits a billboard icon, and the mine variant is visually distinct', () => {
    const std = warningStyle({ mine: false });
    const mine = warningStyle({ mine: true });
    expect(std.imageUri).toMatch(/^data:image\/svg\+xml/);
    expect(mine.imageUri).toMatch(/^data:image\/svg\+xml/);
    expect(std.imageUri).not.toBe(mine.imageUri);
  });
});

describe('warningLabelText', () => {
  it('formats NAVAREA + msgNumber', () => {
    expect(warningLabelText({ navArea: 4, msgNumber: 123 })).toBe('NAVAREA 4 #123');
    expect(warningLabelText({})).toBeNull();
  });
});

describe('registry: airspace.tfr / places.bases / maritime.warnings descriptors', () => {
  const byId = new Map(defaultLayers.map((l) => [l.id, l]));

  it('airspace.tfr points at the B2 TFR route, off by default', () => {
    const d = byId.get('airspace.tfr');
    expect(d).toBeDefined();
    expect(d?.endpoint).toBe('/api/airspace/tfr');
    expect(d?.kind).toBe('geojson');
    expect(d?.visibleByDefault).toBe(false);
    expect(d?.refresh.ttlSec).toBe(600);
  });

  it('places.bases points at the B1 bases route with a bbox limit, off by default', () => {
    const d = byId.get('places.bases');
    expect(d).toBeDefined();
    expect(d?.endpoint).toBe('/api/places/bases?limit=2000');
    expect(d?.kind).toBe('geojson');
    expect(d?.visibleByDefault).toBe(false);
    expect(d?.refresh.ttlSec).toBe(86400);
  });

  it('maritime.warnings points at the B2 NGA warnings route, off by default', () => {
    const d = byId.get('maritime.warnings');
    expect(d).toBeDefined();
    expect(d?.endpoint).toBe('/api/maritime/warnings');
    expect(d?.kind).toBe('geojson');
    expect(d?.visibleByDefault).toBe(false);
    expect(d?.refresh.ttlSec).toBe(900);
  });
});

describe('StyleKind dispatch reaches the new cases', () => {
  it('the polygon path is widened to accept tfr alongside jamming', () => {
    expect(ADAPTER_SRC).toMatch(
      /this\.props\.styleKind === 'jamming' \|\| this\.props\.styleKind === 'tfr'/,
    );
  });

  it('StyleKind union includes tfr, base, warning', () => {
    expect(ADAPTER_SRC).toMatch(/\|\s*'tfr'/);
    expect(ADAPTER_SRC).toMatch(/\|\s*'base'/);
    expect(ADAPTER_SRC).toMatch(/\|\s*'warning'/);
  });

  it('applyStyle has dispatch cases for base and warning billboards', () => {
    expect(ADAPTER_SRC).toMatch(/case 'base': \{/);
    expect(ADAPTER_SRC).toMatch(/case 'warning': \{/);
  });

  it('LayerCompositor maps the three new layer ids to their StyleKind', () => {
    expect(COMPOSITOR_SRC).toMatch(/d\.id === 'airspace\.tfr'\s*\n?\s*\?\s*'tfr'/);
    expect(COMPOSITOR_SRC).toMatch(/d\.id === 'places\.bases'\s*\n?\s*\?\s*'base'/);
    expect(COMPOSITOR_SRC).toMatch(/d\.id === 'maritime\.warnings'\s*\n?\s*\?\s*'warning'/);
  });

  it('places.bases participates in the bbox/LOD gate alongside airports/ports', () => {
    expect(COMPOSITOR_SRC).toMatch(/d\.id === 'places\.bases'/);
  });
});
