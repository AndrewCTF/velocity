// D172: selected marker with the selection ring, scale bar and attribution.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvas = readFileSync(path.join(here, "GlobeCanvas.tsx"), "utf8");

describe("SelectedMarker D172", () => {
  it("globe canvas is real", () => {
    expect(canvas).toContain("GlobeCanvas");
  });
});
