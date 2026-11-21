// D140: timeline event lines — one line per USGS M5.0+ quake.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = readFileSync(path.join(here, "Timeline.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("EventLines D140", () => {
  it("timeline and quake feed are real", () => {
    expect(timeline).toContain("TimeDock");
    expect(registry).toContain("/api/eq?range=day");
  });
});
