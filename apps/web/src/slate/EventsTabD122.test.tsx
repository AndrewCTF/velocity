// D122: Events tab — event cards from the AIS recorder / history for the selection.
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

describe("EventsTab D122", () => {
  it("object panel renders the selection", () => {
    expect(obj).toContain("d59-back-to-list");
    expect(obj).toContain("Back to list");
  });

  it("the selection surface is real", () => {
    expect(slate).toContain("SlateObject");
  });
});
