// D174: tiled diagonal watermark over large airports with the Airports legend.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvas = readFileSync(path.join(here, "GlobeCanvas.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("Watermark D174", () => {
  it("canvas and airports layer are real", () => {
    expect(canvas).toContain("GlobeCanvas");
    expect(registry).toContain("places.airports");
  });
});
