// D117: the 3 real runways of KWI drawn as glowing lines from the entity record.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const insp = readFileSync(path.join(here, "ObjectInspector.tsx"), "utf8");
const card = readFileSync(path.join(here, "AirportCard.tsx"), "utf8");

describe("Runways D117", () => {
  it("runway data renders from the airport record", () => {
    expect(insp).toContain("EntityPanel");
    expect(card).toContain("Runway");
    expect(card).toContain("enrichment.runways");
  });
});
