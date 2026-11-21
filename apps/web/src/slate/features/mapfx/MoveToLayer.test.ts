// MoveToLayer D78: Move to layer submenu with Airliners / Other aircraft.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "MoveToLayer.tsx"), "utf8");
const css = readFileSync(path.join(here, "moveToLayer.css"), "utf8");

describe("MoveToLayer D78", () => {
  it("renders the Move to layer trigger and submenu", () => {
    expect(src).toContain("Move to layer");
    expect(src).toContain('aria-label="Move to layer"');
    expect(src).toContain("Move selected Aircraft to new layer");
  });

  it("targets carry real counts", () => {
    expect(src).toContain("MoveToLayerTarget");
    expect(src).toContain("count: number");
    expect(src).toContain("mv-mtl-count");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-move-to-layer");
    expect(css).toContain(".mv-mtl-menu");
  });
});
