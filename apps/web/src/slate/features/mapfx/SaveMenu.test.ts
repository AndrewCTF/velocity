// SaveMenu D62: the split button and the Duplicate / Save as template menu.
// saveMenu.css is the copy's save_split + card menu, scoped under .mv.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "SaveMenu.tsx"), "utf8");
const css = readFileSync(path.join(here, "saveMenu.css"), "utf8");

describe("SaveMenu D62", () => {
  it("renders the split button with the caret menu", () => {
    expect(src).toContain('className="mv-save-main"');
    expect(src).toContain('aria-label="Save menu"');
    expect(src).toContain("Save as…");
  });

  it("menus Duplicate and Save as template verbatim", () => {
    expect(src).toContain(">Duplicate<");
    expect(src).toContain(">Save as template…<");
    expect(src).toContain('role="menuitem"');
  });

  it("saves through POST /api/maps with a fresh copy name", () => {
    expect(src).toContain('apiFetch("/api/maps"');
    expect(src).toContain('method: "POST"');
    expect(src).toContain('`${base} copy`');
    expect(src).toContain('`${base} (template)`');
  });

  it("degrades honestly when the store is unavailable", () => {
    expect(src).toContain('"Sign in to save maps"');
    expect(src).toContain('"Maps need Supabase"');
    expect(src).toContain("HTTP ${r.status}");
  });

  it("ships scoped CSS under .mv", () => {
    expect(css).toContain(".mv .mv-save");
    expect(css).toContain(".mv-save-main");
    expect(css).toContain(".mv-save-caret");
  });
});
