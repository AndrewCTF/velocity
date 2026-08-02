import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The menu bar shipped as six buttons that set a `menu` state nothing read: no
// dropdown was ever rendered, so File / Edit / View / Collect / Window / Help
// highlighted on click and did nothing else. Chrome that looks like the most
// recognisable control in a window and is inert teaches the operator to
// distrust the rest of it.
//
// This pins the two things that made it inert: a menu with no rendered list,
// and an item with no command behind it.

const HERE = dirname(fileURLToPath(import.meta.url));
const bar = readFileSync(resolve(HERE, 'TitleBar.tsx'), 'utf8');

describe('title-bar menus', () => {
  it('renders a dropdown for the open menu', () => {
    expect(bar, 'the open menu must render a role="menu" list').toMatch(/role="menu"[\s\S]{0,400}MENU_ITEMS\[m\]/);
    expect(bar).toContain('role="menuitem"');
  });

  it('gives every menu a non-empty item list', () => {
    for (const m of ['File', 'Edit', 'View', 'Collect', 'Window', 'Help']) {
      const block = new RegExp(`\\b${m}: \\[([\\s\\S]*?)\\n  \\],`).exec(bar);
      const body = block?.[1] ?? '';
      expect(body, `${m} has no entry in MENU_ITEMS`).not.toBe('');
      const count = (body.match(/\blabel:/g) ?? []).length;
      expect(count, `${m} has no items`).toBeGreaterThan(0);
    }
  });

  it('gives every item a command to run', () => {
    const labels = (bar.match(/\blabel: '[^']+',?\n?\s*(hint|sep|on|disabled|run):/g) ?? []).length;
    const runs = (bar.match(/\brun: \(/g) ?? []).length;
    expect(runs, 'fewer run handlers than items').toBeGreaterThanOrEqual(
      (bar.match(/{\s*label: '/g) ?? []).length,
    );
    expect(labels).toBeGreaterThan(0);
  });

  it('closes on Escape and on a click outside', () => {
    expect(bar).toContain("window.addEventListener('pointerdown', onDown, true)");
    expect(bar).toMatch(/e\.key !== 'Escape'/);
  });

  it('opens the palette through a store, not a synthetic keystroke', () => {
    const omnibar = readFileSync(resolve(HERE, '..', 'command-bar', 'Omnibar.tsx'), 'utf8');
    expect(omnibar, 'Omnibar must read the shared palette store').toContain('usePalette');
    expect(bar).toContain('usePalette.getState().setOpen(true)');
  });

  // The centre of the bar used to be a hardcoded amber square, a fixed "Live
  // map" title and a green check reading "Saved" — on a console that saves
  // nothing and was often not showing the map. Fabricated state in the window
  // frame is the same defect this repo bans in the map itself.
  it('does not fabricate a saved state', () => {
    expect(bar, 'the bar must not claim a save state it does not have').not.toMatch(/>\s*Saved\s*</);
  });

  it('reads the document line from the stores that own it', () => {
    expect(bar, 'live / held must come from the clock').toContain('useTime((s) => s.playing)');
    expect(bar, 'the socket dot must come from the connection store').toContain(
      'useConnection((s) => s.ws)',
    );
    expect(bar, 'the title must fall through to the active app').toMatch(
      /documentTitle \?\? APP_META\[activeApp\]/,
    );
  });

  it('hosts the settings modal on the console route', () => {
    // AppRouter's TopBar returns null on `/`, so the console must host it.
    const app = readFileSync(resolve(HERE, '..', 'App.tsx'), 'utf8');
    expect(app).toContain('<SettingsModal');
    expect(app).toContain('onOpenSettings=');
  });
});
