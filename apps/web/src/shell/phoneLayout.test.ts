import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The phone layout's structural decisions, as text guards in the style of
// TitleBar.menus.test.ts (TitleBar pulls in the globe, too heavy to render).
// Behaviour is in Console.phone.test.tsx; pixels are graded by
//   node tools/perf/ui_clip_sweep.mjs --device "Pixel 7" --first-visit --grade
// Measured 2026-10-17 on a Pixel 7 before any of this: the map had 23% of the
// screen, 77 elements ran past the right edge, 270 of ~317 visible controls were
// under 24px, and a first visit hit two modal dialogs.

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(resolve(HERE, f), "utf8");
const bar = read("TitleBar.tsx");
const css = read("console.css");

describe("title bar on a phone", () => {
  it("folds into one Menu button inside a nav, 44px in px", () => {
    // The root font is 13px, so a rem class (`h-11`) is 36px and misses.
    const phone = /if \(isMobile\)\s+return \([\s\S]*?\n {4}\);/.exec(bar)?.[0];
    expect(phone, "TitleBar has no isMobile branch").toBeTruthy();
    expect(phone).toContain("data-primary-nav");
    expect(phone).toContain('aria-label="Menu"');
    expect(phone).toContain("h-[44px] w-[44px]");
    expect(
      phone,
      "the phone bar still renders the desktop menu bar",
    ).not.toContain("MENUS.map");
  });

  it("keeps every menu, the apps and the 2D map in the one sheet", () => {
    const menu = /function PhoneMenu\([\s\S]*?\n}\n/.exec(bar)?.[0] ?? "";
    expect(menu).toContain('to="/2d"');
    expect(menu).toContain("MENUS.map");
    expect(menu).toContain("MENU_ITEMS[m]");
    expect(menu).toContain("APP_GROUPS");
    expect(menu, "the menu sheet must use the shared Modal").toContain(
      "<Modal",
    );
    // A menu hint names a key; a phone has none.
    expect(menu).not.toContain("it.hint");
  });

  it("is the same document line and marking pill the desktop bar has", () => {
    expect(bar.match(/\{docLine\}/g)?.length).toBe(2);
    expect(bar.match(/\{pill\}/g)?.length).toBe(2);
  });
});

describe("one mobile chooser", () => {
  it("is shared by the console and the 2D map, and written once", () => {
    expect(read("Console.tsx")).toContain("MobileSheets");
    expect(read("ConsoleShell.tsx")).toContain("MobileSheets");
    // The chooser's backdrop and the sheet's Close live in one file.
    expect(read("ConsoleShell.tsx")).not.toContain('aria-label="Close menu"');
    expect(read("Console.tsx")).not.toContain('aria-label="Close menu"');
    expect(read("MobileSheets.tsx")).toContain('aria-label="Close menu"');
  });

  it("wraps every sheet's content in the error boundary", () => {
    expect(read("MobileSheets.tsx")).toMatch(
      /<ErrorBoundary label=\{active\.label\}>/,
    );
  });
});

describe("phone styles", () => {
  it("sizes the nav bar's buttons to 44px", () => {
    expect(css).toMatch(/\.csl2-nav button \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.csl2-nav button \{[^}]*min-width: 44px/);
  });

  it("ports the mockup's touch rule, under the same query as the phone layout", () => {
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 767px\) \{/);
    expect(css).toContain("min-height: var(--g-row-2)");
    // Chart marks are `.absolute`; a blanket button rule makes them 26px slabs.
    expect(css).toContain(":not(.absolute)");
  });

  it("takes the dock out of the layout until asked, and wraps its rows", () => {
    expect(css).toMatch(/\.csl2\[data-phone\] \.csl2-dock \{\s*display: none;/);
    expect(css).toContain('.csl2-dock[data-sheet="open"]');
    expect(css).toMatch(/> \.items-center \{[^}]*flex-wrap: wrap/);
  });
});
