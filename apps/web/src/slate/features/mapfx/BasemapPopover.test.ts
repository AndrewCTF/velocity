// BasemapPopover D72: Map | Satellite tabs, thumbnails, description, checkmark on active.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "BasemapPopover.tsx"), "utf8");
const css = readFileSync(path.join(here, "basemapPopover.css"), "utf8");

describe("BasemapPopover D72", () => {
  it("renders the Map | Satellite picker dialog", () => {
    expect(src).toContain('aria-label="Basemap picker"');
    expect(src).toContain('role="tablist"');
    expect(src).toContain(">Map<");
    expect(src).toContain(">Satellite<");
    expect(src).toContain('data-testid="d72-basemap"');
  });

  it("options come from the real registry with checkmark on active", () => {
    expect(src).toContain("BASEMAP_OPTIONS");
    expect(src).toContain("b.value === mode");
    expect(src).toContain("checkmark");
    expect(src).toContain("b.title");
  });

  it("selecting an option sets the imagery mode", () => {
    expect(src).toContain("setMode(b.value)");
    expect(src).toContain("useImagery");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-bp-menu");
    expect(css).toContain(".mv-bp-thumb");
  });
});
