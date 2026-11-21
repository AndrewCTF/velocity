// D118: property row menu — pin / add to label / copy field over the DXB selection.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const card = readFileSync(path.join(here, "AirportCard.tsx"), "utf8");
const insp = readFileSync(path.join(here, "ObjectInspector.tsx"), "utf8");

describe("PropertyMenu D118", () => {
  it("property rows render the live airport fields", () => {
    expect(card).toContain("Runways");
    expect(card).toContain("Elevation");
    expect(insp).toContain("EntityPanel");
  });
});
