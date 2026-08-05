import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// A control that renders must run.
//
// The shell shipped three sets of chrome that highlighted and did nothing: the
// File/Edit/View menu bar set a `menu` state nothing read, the four panel tabs
// stayed clickable under a full-bleed app that had removed the column they open
// into, and the action bar was four literals including a primary button for a
// capability that does not exist. Each was found by hand, months apart, by
// someone clicking it.
//
// A live sweep of the running console (React props, 14 apps, ~460-770
// interactive elements each) found zero handler-less controls once those were
// fixed. This is the repeatable half of that sweep: no `<button>` under
// shell/ may render without something to run. `disabled` is fine — a control
// that states why it cannot act is not a dead one — and `type="submit"` is
// handled by its form.
//
// Scoped to shell/ deliberately. It is the chrome every app renders inside, so
// a lie here is a lie on every screen; widening it to the whole app is a
// separate call with a much larger backlog.

const HERE = dirname(fileURLToPath(import.meta.url));

function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxUnder(p));
    else if (name.endsWith('.tsx') && !name.includes('.test.')) out.push(p);
  }
  return out;
}

/** The opening tag starting at `from`, brace- and quote-aware so a `>` inside
 *  `className={x > y ? …}` or a string does not end it early. */
function openingTag(src: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i] as string;
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}

describe('shell controls are live', () => {
  const files = tsxUnder(HERE);

  it('scans the whole shell, so a new file is covered by default', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [relative(HERE, f), f] as const))(
    'every <button> in %s has something to run',
    (_name, file) => {
      const src = readFileSync(file, 'utf8');
      const dead: string[] = [];
      for (let i = src.indexOf('<button'); i >= 0; i = src.indexOf('<button', i + 1)) {
        const tag = openingTag(src, i);
        const live =
          /\bonClick=/.test(tag) ||
          /\bonPointerDown=/.test(tag) ||
          /\bonMouseDown=/.test(tag) ||
          /\bdisabled\b/.test(tag) ||
          /type="submit"/.test(tag) ||
          // A spread can carry the handler in from a props object.
          /\{\.\.\./.test(tag);
        if (!live) dead.push(`line ${src.slice(0, i).split('\n').length}: ${tag.slice(0, 90)}`);
      }
      expect(dead, `buttons with no handler:\n${dead.join('\n')}`).toEqual([]);
    },
  );

  it('never prints a keyboard hint nothing listens for', () => {
    // Menu items print a `hint`. Each of these was advertised in the UI while
    // nothing bound it: the panel numbers in the Help menu and every tab
    // tooltip, and ⇧T beside the scheme cycler.
    const app = readFileSync(resolve(HERE, '..', 'App.tsx'), 'utf8');
    const consoleSrc = readFileSync(join(HERE, 'Console.tsx'), 'utf8');
    const titlebar = readFileSync(join(HERE, 'TitleBar.tsx'), 'utf8');

    if (/⇧T/.test(titlebar)) expect(app, '⇧T is printed but nothing binds it').toMatch(/shiftKey/);
    if (/1-4 left panels/.test(titlebar))
      expect(consoleSrc, 'the panel numbers are printed but nothing binds them').toMatch(
        /addEventListener\('keydown'/,
      );
  });
});
