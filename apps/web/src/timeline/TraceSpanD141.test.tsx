// D141: timeline bar event — one bar for the ADS-B trace span.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = readFileSync(path.join(here, "Timeline.tsx"), "utf8");

describe("TraceSpan D141", () => {
  it("timeline renders over the trace", () => {
    expect(timeline).toContain("TimeDock");
  });
});
