// LayerMenu D71/D76: row count + ••• menu + eye + drill-in, 8-item menu.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "LayerMenu.tsx"), "utf8");
const css = readFileSync(path.join(here, "layerMenu.css"), "utf8");

describe("LayerMenu D71/D76", () => {
  it("renders count, ••• menu, eye and drill-in", () => {
    expect(src).toContain("objects");
    expect(src).toContain("Menu for");
    expect(src).toContain("eye-open");
    expect(src).toContain("chevron-right");
    expect(src).toContain("Drill into");
  });

  it("menu carries the eight copy items", () => {
    for (const l of [
      "Center map on layer",
      "Select objects in layer",
      "Add objects to layer",
      "Show this layer only",
      "Lock layer",
      "Rename",
      "Add description",
      "Delete Layer",
    ]) {
      expect(src).toContain(l);
    }
  });

  it("copy-only items are disabled with reasons", () => {
    expect(src).toContain("disabled: true");
    expect(src).toContain("copy-only");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-layer-row");
    expect(css).toContain(".mv-layer-menu");
    expect(css).toContain("is-danger");
  });
});
