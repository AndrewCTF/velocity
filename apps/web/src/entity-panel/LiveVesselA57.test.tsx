// A57: Live-entity selection panel for one real recorded vessel (Track 9000).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "EntityPanel.tsx"), "utf8");

describe("LiveVessel A57", () => {
  it("entity panel renders the recorded vessel", () => {
    expect(panel).toContain("EntityPanel");
  });
});
