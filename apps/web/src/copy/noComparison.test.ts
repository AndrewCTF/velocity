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
    const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = body.split('\n').filter((l) => BRAND.test(l));
    expect(hits).toEqual([]);
  });
});
