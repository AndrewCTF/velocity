// D106: Find tab — location geocoder through /api/geocode (Nominatim).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.join(here, "SlateShell.tsx"), "utf8");
const geo = readFileSync(path.join(here, "../state/geoScope.ts"), "utf8");
const imagery = readFileSync(
  path.join(here, "../imagery/ImageryControl.tsx"),
  "utf8",
);

describe("FindGeocoder D106", () => {
  it("Find is panel 2 with the geocode scope", () => {
    expect(shell).toContain('id: "find"');
    expect(geo).toContain("setScope");
    expect(imagery).toContain("/api/geocode");
  });
});
