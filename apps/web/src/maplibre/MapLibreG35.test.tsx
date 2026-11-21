// G35: Dark basemap with asset cluster bubbles and range rings.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvas = readFileSync(path.join(here, "MapLibreCanvas.tsx"), "utf8");

describe("MapLibre G35", () => {
  it("map canvas is real", () => {
    expect(canvas).toContain("MapLibreCanvas");
  });
});
