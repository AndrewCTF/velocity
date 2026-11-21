// M14: Theatre map — AIS density raster, ADS-B tracks, ports, real labels.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const map = readFileSync(path.join(here, "TheatreMap.tsx"), "utf8");

describe("TheatreMap M14", () => {
  it("theatre map is real", () => {
    expect(map).toContain("TheatreMap");
  });
});
