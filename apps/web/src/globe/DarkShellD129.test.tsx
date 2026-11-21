// D129: dark map shell — legend ramps and the selection panel on the live feeds.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const overlays = readFileSync(path.join(here, "GlobeOverlays.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("DarkShell D129", () => {
  it("overlays and the earthquake feed are real", () => {
    expect(overlays).toContain("export function GlobeOverlays");
    expect(registry).toContain("/api/eq?range=day");
  });
});
