import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REHOMED, KEPT, LEFT_PANELS, RIGHT_PANELS, describeHome,
  LEGACY_LEFT, LEGACY_RIGHT,
} from './panels.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// "Nothing must be missing" as an executable contract.
//
// The console rebuild collapses 18 left-rail panels and 9 right-rail tabs into
// four named left panels and three right ones. That is only safe if every old
// id has a recorded destination, so this fails naming any id dropped without
// one.
//
// It asserts against the FROZEN inventory in panels.ts, not against App.tsx.
// The first version read App.tsx live and passed happily right up until the
// migration deleted `rightTabs` from it, at which point the guard lost the very
// list it was guarding. A record of what must not be lost cannot live in the
// file that is being changed.

describe('panel re-homing', () => {
  const leftRail = [...LEGACY_LEFT];
  const rightRail = [...LEGACY_RIGHT];

  it('the frozen inventory never shrinks', () => {
    expect(leftRail.length).toBe(18);
    expect(rightRail.length).toBe(9);
  });

  it('gives every old left-rail panel a home', () => {
    const orphans = leftRail.filter((id) => !REHOMED[id] && !KEPT.has(id));
    expect(orphans, `left-rail panels with no recorded home: ${orphans.join(', ')}`).toEqual([]);
  });

  it('gives every old right-rail tab a home', () => {
    const orphans = rightRail.filter((id) => !REHOMED[id] && !KEPT.has(id));
    expect(orphans, `right-rail tabs with no recorded home: ${orphans.join(', ')}`).toEqual([]);
  });

  it('never records a redundancy without naming what replaces it', () => {
    for (const [id, home] of Object.entries(REHOMED)) {
      if (home.kind === 'redundant') {
        expect(home.with.length, `${id} is marked redundant with no replacement`).toBeGreaterThan(3);
      }
    }
  });

  it('describes every home in a sentence', () => {
    for (const id of Object.keys(REHOMED)) {
      expect(describeHome(id)).toContain(id);
    }
  });

  it('keeps the named left and right panels distinct', () => {
    const ids = [...LEFT_PANELS.map((p) => p.id), ...RIGHT_PANELS.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(LEFT_PANELS.map((p) => p.key)).toEqual(['1', '2', '3', '4']);
  });

  // A declared panel the shell cannot fill is a tab that does nothing, one
  // level up. `time` sat in this list unwired because the TimeDock already owns
  // playback and useTime holds no window a second surface could own; it was
  // removed rather than left as an intention. Every id here must be handed
  // content by App.tsx.
  it('declares no panel App.tsx does not fill', () => {
    const app = readFileSync(resolve(HERE, '..', 'App.tsx'), 'utf8');
    const block = app.slice(app.indexOf('rightPanels: Partial<'));
    for (const p of RIGHT_PANELS) {
      expect(block, `RIGHT_PANELS declares ${p.id} and App.tsx never fills it`).toMatch(
        new RegExp(`\\b${p.id}:\\s*<`),
      );
    }
    for (const p of LEFT_PANELS) {
      expect(app, `LEFT_PANELS declares ${p.id} and App.tsx never fills it`).toMatch(
        new RegExp(`\\b${p.id}:\\s*leftHomed`),
      );
    }
  });

  // Every legacy surface must reach a NAMED address. `More` exists so a rail
  // item added tomorrow cannot vanish, not as somewhere to leave work: it held
  // six surfaces, five of them a second copy of something already homed.
  it('parks nothing recorded under More', () => {
    const app = readFileSync(resolve(HERE, '..', 'App.tsx'), 'utf8');
    expect(app, 'App.tsx still builds a `pending` parking list').not.toMatch(/const pending\b/);
    expect(app).toContain('extraCount={leftHomed.rest.length}');
  });
});
