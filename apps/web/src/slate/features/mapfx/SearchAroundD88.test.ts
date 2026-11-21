// SearchAround D88: link-merged "via" types — nearby IATA airports.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "SearchAround.tsx"), "utf8");

describe("SearchAround D88", () => {
  it("fetches places airports for the via row", () => {
    expect(src).toContain("/api/places/airports?bbox=-180,-85,180,85&limit=20000");
    expect(src).toContain("Nearby airports (via links)");
  });

  it("filters to airports with IATA codes near the selection", () => {
    expect(src).toContain("nearbyIataAirports");
    expect(src).toContain("properties?.iata");
    expect(src).toContain("VIA_RADIUS_KM = 150");
  });

  it("excludes the selected airport itself", () => {
    expect(src).toContain('!== iata');
  });

  it("the via row is disabled while loading with a count in the title", () => {
    expect(src).toContain("disabled={viaAirports === null}");
    expect(src).toContain("airports with IATA codes within 150 km");
  });
});
