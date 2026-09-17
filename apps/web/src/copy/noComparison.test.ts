// Guard: user-facing copy states what the product does and measures, never
// what it resembles. Reddit (2026-09) put it plainly: comparing this project to
// Palantir "immediately kills your credibility". Decision 2026-09-17: the
// comparison is gone from README, website, onboarding and dashboard strings.
// Code COMMENTS may still cite docs/palantir-reference-2026-07.md (comments
// are not copy, apps/web/CLAUDE.md); JSX text, string literals and Markdown
// prose may not.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SRC, '..', '..', '..');
const BRAND = /palantir|gotham/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

// Strip // and /* */ comments so only code (strings, JSX text) is inspected.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// Remove every `open … close` span from `text`; a dangling open runs to the end.
function stripBlocks(text: string, open: string, close: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const a = text.indexOf(open, i);
    if (a < 0) return out + text.slice(i);
    out += text.slice(i, a);
    const b = text.indexOf(close, a + open.length);
    if (b < 0) return out;
    i = b + close.length;
  }
}

describe('no brand comparison in user-facing copy', () => {
  it('apps/web source strings and JSX text never name Palantir or Gotham', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes('/theme/blueprint')) continue; // the Blueprint ramp is a data source, named once
      const code = stripComments(readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (BRAND.test(line)) hits.push(`${file.replace(SRC + '/', '')}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('README prose never compares the product to Palantir or Gotham', () => {
    const md = readFileSync(join(REPO, 'README.md'), 'utf8');
    const hits = md.split('\n').filter((l) => BRAND.test(l));
    expect(hits).toEqual([]);
  });

  it('the website copy never compares the product to Palantir or Gotham', () => {
    const html = readFileSync(join(REPO, 'website', 'index.html'), 'utf8');
    // Drop comment blocks with a scanner, not a regex (CodeQL flags regex
    // comment stripping as sanitization); this guard only reads the result.
    const body = stripBlocks(stripBlocks(html, '<!--', '-->'), '/*', '*/');
    const hits = body.split('\n').filter((l) => BRAND.test(l));
    expect(hits).toEqual([]);
  });
});
