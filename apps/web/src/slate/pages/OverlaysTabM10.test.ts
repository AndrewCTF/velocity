// M10: Overlays tab mounts the registry overlays catalog.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const maven = readFileSync(path.join(here, "MavenLayers.tsx"), "utf8");

describe("OverlaysTab M10", () => {
  it("overlays tab is the registry catalog", () => {
    expect(maven).toContain('"overlays"');
    expect(maven).toContain('tab === "overlays"');
    expect(maven).toContain("<OverlaysCatalog registry={registry} />");
  });
});
