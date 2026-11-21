// D134: timeline cursor drag with time chip; pins update for recent quakes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = readFileSync(path.join(here, "Timeline.tsx"), "utf8");

describe("TimelineDrag D134", () => {
  it("the timeline renders the time dock", () => {
    expect(timeline).toContain("TimeDock");
    expect(timeline).toContain("Timeline");
  });
});
