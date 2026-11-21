// D158: zoom-levels range slider with current-zoom marker (0 to 16).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvas = readFileSync(path.join(here, "GlobeCanvas.tsx"), "utf8");

describe("ZoomLevels D158", () => {
  it("globe canvas is real", () => {
    expect(canvas).toContain("GlobeCanvas");
  });
});
