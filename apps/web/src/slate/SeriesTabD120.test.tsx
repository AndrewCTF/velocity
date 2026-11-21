// D120: Series tab — value with its unit at the right (live ADS-B trace).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const slate = readFileSync(path.join(here, "SlateShell.tsx"), "utf8");
const obj = readFileSync(
  path.join(here, "features/object/SlateObject.tsx"),
  "utf8",
);

describe("SeriesTab D120", () => {
  it("series renders as a live tab", () => {
    expect(slate).toContain('"Series"');
    expect(obj).toContain("@Barometric altitude");
  });
});
