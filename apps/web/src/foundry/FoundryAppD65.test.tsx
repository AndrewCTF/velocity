// D65: "+ New" resource menu (dataset, transform, connection, binding, monitor).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "FoundryApp.tsx"), "utf8");
const css = readFileSync(path.join(here, "foundry.css"), "utf8");

describe("FoundryApp D65", () => {
  it("renders the + New trigger", () => {
    expect(src).toContain('data-testid="d65-new"');
    expect(src).toContain('aria-haspopup="menu"');
    expect(src).toContain("+ New");
  });

  it("the five create actions are wired to their views", () => {
    expect(src).toContain('label: "Dataset"');
    expect(src).toContain('label: "Transform"');
    expect(src).toContain('label: "Connection"');
    expect(src).toContain('label: "Binding"');
    expect(src).toContain('label: "Monitor"');
    expect(src).toContain('setView("datasets")');
    expect(src).toContain('setView("pipeline")');
    expect(src).toContain('setView("connections")');
    expect(src).toContain('setView("ontology")');
  });

  it("menu closes after a create action runs", () => {
    expect(src).toContain("setNewOpen(false)");
  });

  it("D65 styles are shipped", () => {
    expect(css).toContain(".foundry-new");
    expect(css).toContain(".foundry-new-menu");
  });
});
