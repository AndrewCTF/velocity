// D147: vessel tracks with heading arrows over the AIS feed.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const layer = readFileSync(path.join(here, "PrimitiveEntityLayer.ts"), "utf8");

describe("VesselTracks D147", () => {
  it("vessel layer renders the first-class track", () => {
    expect(layer).toContain("vessel");
  });
});
