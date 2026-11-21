// D128: map settings popover — colour scheme, corroborated toggle, render quality, basemap.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modal = readFileSync(path.join(here, "SettingsModal.tsx"), "utf8");
const shell = readFileSync(path.join(here, "../slate/SlateShell.tsx"), "utf8");

describe("MapSettings D128", () => {
  it("settings cover scheme and map quality", () => {
    expect(modal).toContain("Colour scheme");
    expect(modal).toContain("MAP_QUALITIES");
    expect(modal).toContain("MapQualityPreset");
  });

  it("the shell opens settings from the gear", () => {
    expect(shell).toContain("openSettings");
  });
});
