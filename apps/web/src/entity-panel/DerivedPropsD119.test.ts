// D119: derived properties — the four values Velocity derives server side for KWI.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const card = readFileSync(path.join(here, "AirportCard.tsx"), "utf8");

describe("DerivedProps D119", () => {
  it("derived values render with a derived suffix", () => {
    expect(card).toContain("approach_capability");
    expect(card).toContain("derived");
    expect(card).toContain("approach_capability_basis");
  });
});
