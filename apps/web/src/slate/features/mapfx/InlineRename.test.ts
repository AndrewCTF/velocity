// InlineRename D75: inline layer rename into a focused text input.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "InlineRename.tsx"), "utf8");
const css = readFileSync(path.join(here, "inlineRename.css"), "utf8");

describe("InlineRename D75", () => {
  it("renders the focused rename input", () => {
    expect(src).toContain('aria-label={`Rename ${row.label}`');
    expect(src).toContain('data-testid="d75-rename"');
    expect(src).toContain("inputRef.current?.focus()");
    expect(src).toContain("inputRef.current?.select()");
  });

  it("commits on Enter and blur, cancels on Escape", () => {
    expect(src).toContain('e.key === "Enter"');
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain("onBlur");
  });

  it("persists the override and writes the registry title", () => {
    expect(src).toContain("localStorage");
    expect(src).toContain("registry.setTitle(first, v)");
    expect(src).toContain("renameFor");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-inline-rename");
  });
});
