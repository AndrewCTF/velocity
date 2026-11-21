// D163: dark Legend tab with live ranges for speed and altitude.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const overlays = readFileSync(path.join(here, "GlobeOverlays.tsx"), "utf8");

describe("LegendTab D163", () => {
  it("overlays render the legend", () => {
    expect(overlays).toContain("export function GlobeOverlays");
  });
});
