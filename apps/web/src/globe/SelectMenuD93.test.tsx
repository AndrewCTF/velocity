// D93: toolbar Select dropdown — 1-4 keycaps printed and live, layers from the registry.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(
  path.join(here, "../slate/SlateShell.tsx"),
  "utf8",
);
const titlebar = readFileSync(
  path.join(here, "../shell/TitleBar.tsx"),
  "utf8",
);
const defaults = readFileSync(
  path.join(here, "../registry/defaults.ts"),
  "utf8",
);

describe("D93 Select dropdown", () => {
  it("keys 1-4 select the left panels (Support > Keyboard shortcuts list)", () => {
    expect(shell).toContain("LEFT_PANELS[Number(e.key) - 1]");
    expect(shell).toContain('id: "layers"');
    expect(shell).toContain('id: "find"');
  });

  it("Support > Keyboard shortcuts prints the 1-4 keycaps", () => {
    expect(titlebar).toContain("Keyboard shortcuts");
    expect(titlebar).toContain("1-4 left panels");
  });

  it("the named layers come from the registry (Airports)", () => {
    expect(defaults).toContain("places.airports");
    expect(defaults).toContain("Airports");
    // The Places stack is the rail's filter family + drag-select subject.
    expect(shell).toContain("Place");
  });
});
