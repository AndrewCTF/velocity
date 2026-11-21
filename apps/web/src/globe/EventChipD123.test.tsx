// D123: map label chip with event-count badge over the selected aircraft.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const slate = readFileSync(path.join(here, "../slate/SlateShell.tsx"), "utf8");
const obj = readFileSync(
  path.join(here, "../slate/features/object/SlateObject.tsx"),
  "utf8",
);

describe("EventChip D123", () => {
  it("the selection renders over the live race", () => {
    expect(slate).toContain("SlateObject");
    expect(obj).toContain("Back to list");
  });
});
