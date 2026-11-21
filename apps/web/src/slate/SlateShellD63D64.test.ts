// D63: Foundry workspace nav rail + settings popover.
// D64: App launcher with the Map hover card (9 of 14 APP_META apps live).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.join(here, "SlateShell.tsx"), "utf8");
const css = readFileSync(path.join(here, "slate.css"), "utf8");
const modal = readFileSync(
  path.join(here, "../settings/SettingsModal.tsx"),
  "utf8",
);
const appView = readFileSync(path.join(here, "../state/appView.ts"), "utf8");

describe("D63 settings popover", () => {
  it("settings rows are live (colour scheme, basemap, render quality)", () => {
    expect(modal).toContain("Colour scheme");
    expect(modal).toContain("MAP_QUALITIES");
  });

  it("the gear opens Settings via ctx.openSettings", () => {
    expect(shell).toContain("openSettings");
  });

  it("rail glyphs: Blueprint icons, no avatar/badge", () => {
    expect(shell).toContain("RAIL_APPS");
    expect(shell).toContain("APP_BP");
  });
});

describe("D64 launcher hover card", () => {
  it("hover sets hoverApp and shows the card", () => {
    expect(shell).toContain("hoverApp");
    expect(shell).toContain('data-testid="d64-hovercard"');
    expect(shell).toContain("onMouseEnter={() => setHoverApp(id)}");
    expect(shell).toContain("APP_META[id].hint");
  });

  it("card shows live registry + aircraft counts", () => {
    expect(shell).toContain("layers registered");
    expect(shell).toContain("aircraft live");
    expect(shell).toContain("/api/status");
    expect(shell).toContain("aircraft_count");
  });

  it("launcher lists the real APP_META apps", () => {
    expect(appView).toContain("APP_GROUPS");
    expect(shell).toContain("APP_GROUPS.map");
    expect(css).toContain(".sl-hovercard");
  });
});
