// RouteArcs D87: great-circle arcs + LINKS layer from live OpenFlights data.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "RouteArcs.tsx"), "utf8");

describe("RouteArcs D87", () => {
  it("great-circle arcs sample the real helper", () => {
    expect(src).toContain("destinationPoint");
    expect(src).toContain("arcPoints");
    expect(src).toContain("R_KM");
  });

  it("destinations come from the live endpoints", () => {
    expect(src).toContain("apiFetch(`/api/aviation/routes`)");
    expect(src).toContain("/api/aviation/airports/openflights");
    expect(src).toContain("apiFetch(`/api/entity/airport:");
    expect(src).toContain("r.src === iata");
  });

  it("arcs live in one LINKS data source", () => {
    expect(src).toContain('"LINKS"');
    expect(src).toContain("CustomDataSource");
    expect(src).toContain("PolylineGlowMaterialProperty");
  });
});
