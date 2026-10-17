import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
  const phone =
    /if \(isMobile\)\s+return \([\s\S]*?\n {4}\);/.exec(bar)?.[0] ?? "";

  it("floats a Menu button, a search pill and the marking on the map", () => {
    expect(phone, "TitleBar has no isMobile branch").toBeTruthy();
    expect(phone).toContain("data-primary-nav");
    expect(phone).toContain('aria-label="Menu"');
    // 44px round controls, sized in console.css (`.pround`), never a rem class:
    // the root font is 13px, so `h-11` is 36px and misses.
    expect(phone).toContain('className="pround"');
    expect(phone).toContain('className="psearch"');
    expect(phone).toContain('showSheet("find")');
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
    expect(menu, "the menu is a sheet like every phone surface").toContain(
      "<BottomSheet",
    );
    // A menu hint names a key; a phone has none.
    expect(menu).not.toContain("it.hint");
  });

  it("carries the desktop's marking pill and the same clock state words", () => {
    expect(bar.match(/\{pill\}/g)?.length).toBe(2);
    expect(phone).toContain('replaying ? "replay" : playing ? "live" : "held"');
  });
});

describe("phone sheets", () => {
  it("every phone surface is a BottomSheet: the console, the 2D shell, Menu and Alerts", () => {
    for (const f of ["Console.tsx", "ConsoleShell.tsx", "TitleBar.tsx"])
      expect(read(f), f).toContain("<BottomSheet");
    expect(read("../alerts/AlertsPanel.tsx")).toContain("<BottomSheet");
    // The full-screen chooser this replaced is gone, not left beside it.
    expect(existsSync(resolve(HERE, "MobileSheets.tsx"))).toBe(false);
  });

  it("wraps every sheet's content in the error boundary", () => {
    expect(read("BottomSheet.tsx")).toMatch(
      /<ErrorBoundary label=\{label\}>\{children\}<\/ErrorBoundary>/,
    );
  });
});

describe("phone styles", () => {
  it("sizes the tab bar's buttons to at least 44px", () => {
    expect(css).toMatch(/\.ptabs button \{[^}]*min-width: 44px/);
    expect(css).toMatch(/\.ptabs button \{[^}]*height: 58px/);
    expect(css).toMatch(/\.pround \{[^}]*width: 44px;[^}]*height: 44px/);
  });

  it("lets touches through the floating top edge, between its controls", () => {
    expect(css).toMatch(/\.pfloat \{[^}]*pointer-events: none/);
    expect(css).toMatch(
      /\.pfloat :is\(button, a, \.csl2-clas\) \{\s*pointer-events: auto/,
    );
  });

  it("ports the mockup's touch rule, under the same query as the phone layout", () => {
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 767px\) \{/);
    expect(css).toContain("min-height: var(--g-row-2)");
    // Chart marks are `.absolute`; a blanket button rule makes them 26px slabs.
    expect(css).toContain(":not(.absolute)");
  });

  it("unpins the dock inside its sheet and wraps its rows", () => {
    expect(css).toMatch(/\.psheet \.csl2-dock \{[^}]*max-height: none/);
    expect(css).toMatch(
      /\.psheet \.csl2-dock > div > \.items-center \{[^}]*flex-wrap: wrap/,
    );
  });
});
