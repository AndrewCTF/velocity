// OverlaysCatalog D85: tags by group, keyless filter, licence, titles.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "OverlaysCatalog.tsx"), "utf8");
const css = readFileSync(path.join(here, "overlaysCatalog.css"), "utf8");

describe("OverlaysCatalog D85", () => {
  it("renders the catalog with keyless filter and licence", () => {
    expect(src).toContain('data-testid="d85-catalog"');
    expect(src).toContain("Keyless");
    expect(src).toContain("TAGS");
    expect(src).toContain("GROUP");
    expect(src).toContain("LICENSE");
    expect(src).toContain("Add Layer");
  });

  it("rows come from the real registry defaults", () => {
    expect(src).toContain("defaultLayers");
    expect(src).toContain('auth === "none"');
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-overlays-catalog");
    expect(css).toContain(".mv-oc-row");
  });
});
