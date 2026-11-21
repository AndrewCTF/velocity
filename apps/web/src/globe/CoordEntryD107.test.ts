// D107: Go to coordinates — parse lat,lon and place it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const coord = readFileSync(path.join(here, "CoordEntry.tsx"), "utf8");

describe("CoordEntry D107", () => {
  it("parses lat,lon coordinates", () => {
    expect(coord).toContain("parseLatLon");
    expect(coord).toContain('"lat,lon"');
    expect(coord).toContain("onPlace: (lat: number, lon: number");
  });

  it("accepts place names and map centre", () => {
    expect(coord).toContain("place");
    expect(coord).toContain("map centre");
  });
});
