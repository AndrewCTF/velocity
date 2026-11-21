// D121: series row menu — pin / add to timeline / add to label / open linked / replay / copy.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const obj = readFileSync(
  path.join(here, "features/object/SlateObject.tsx"),
  "utf8",
);

describe("SeriesMenu D121", () => {
  it("series rows carry their menu", () => {
    expect(obj).toContain('data-testid="d59-series-menu"');
    expect(obj).toContain("@Ground speed");
  });
});
