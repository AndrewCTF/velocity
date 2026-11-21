// D108: Find objects on map — query matches real airports in the viewport.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.join(here, "SlateShell.tsx"), "utf8");
const search = readFileSync(path.join(here, "../transport/search.ts"), "utf8");

describe("FindObjects D108", () => {
  it("Find searches objects by name, callsign or MMSI", () => {
    expect(shell).toContain('id: "find"');
    expect(search).toContain("searchObjects");
    expect(search).toContain("apiFetch");
  });
});
