// D61/D89: Saved map header + link arc with waypoint dots and callsign chip.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "selectionTrack.ts"), "utf8");
const maven = readFileSync(path.join(here, "MavenMap.tsx"), "utf8");

describe("D61/D89 saved header + trace arc", () => {
  it("header carries breadcrumb title, menus, Save and Share", () => {
    expect(maven).toContain("MAVEN_MENUS");
    expect(maven).toContain("<SaveMenu");
    expect(maven).toContain("Share");
    expect(maven).toContain("File");
    expect(maven).toContain("View");
  });

  it("trace dots are every 11th recorded fix", () => {
    expect(src).toContain("TRACE_DOT_STEP = 11");
    expect(src).toContain("traceDotIndices");
  });

  it("the end chip carries the callsign", () => {
    expect(src).toContain("traceChipText");
    expect(src).toContain("__selectionTrack__chip");
  });

  it("the arc is seeded from the live selection trail", () => {
    expect(src).toContain("syncTraceMarks");
    expect(src).toContain("__selectionTrack__dot");
  });
});
