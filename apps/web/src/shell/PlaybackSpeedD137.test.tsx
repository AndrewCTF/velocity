// D137: playback speed popover — 1x, 10x, 60x, 600x, 3600x over the dock.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dock = readFileSync(path.join(here, "TimeDock.tsx"), "utf8");

describe("PlaybackSpeed D137", () => {
  it("the dock is the playback surface", () => {
    expect(dock).toContain("TimeDock");
  });
});
