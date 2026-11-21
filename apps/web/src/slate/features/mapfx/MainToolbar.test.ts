// MainToolbar D66: icon + word toolbar, Draw pressed, Search Around and
// Delete disabled. Verbatim item order and separator positions from the copy.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "MainToolbar.tsx"), "utf8");
const css = readFileSync(path.join(here, "mainToolbar.css"), "utf8");

describe("MainToolbar D66", () => {
  it("renders the seven copy items in order", () => {
    const labels = ["Select", "Search Around", "Draw", "Capture", "Measure", "Annotate", "Delete"];
    for (const l of labels) expect(src).toContain(l);
    expect(src).toContain('aria-label="Main map toolbar"');
  });

  it("Draw starts pressed", () => {
    expect(src).toContain('useState<ItemId>(active ?? "draw")');
    expect(src).toContain('aria-pressed={current === it.id}');
  });

  it("Search Around and Delete are disabled with reasons", () => {
    expect(src).toContain('search-around');
    expect(src).toContain('disabled: true');
    expect(src).toContain("unavailable");
  });

  it("tools wire to the shared mapTools store", () => {
    expect(src).toContain('useMapTools.getState().setTool("measure")');
    expect(src).toContain('useMapTools.getState().setTool("annotate")');
    expect(src).toContain('useMapTools.getState().setTool("area")');
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-main-toolbar");
    expect(css).toContain(".mvmt-btn.is-active");
    expect(css).toContain(".mvmt-sep");
  });
});
