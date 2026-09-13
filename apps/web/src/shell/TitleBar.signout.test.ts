import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ASVS V7.4.4: on the main console the only way to end a session is the
// title-bar account chip. It showed a user icon and the email, so nothing on
// screen said that clicking it signs you out. Source-text guard in the style of
// TitleBar.menus.test.ts (TitleBar pulls in the globe, too heavy to render).

const HERE = dirname(fileURLToPath(import.meta.url));
const bar = readFileSync(resolve(HERE, 'TitleBar.tsx'), 'utf8');

describe('title-bar sign-out control', () => {
  it('says Sign out, visibly and to assistive tech', () => {
    const chip = /function SignInChip\(\)[\s\S]*?\n}\n/.exec(bar)?.[0] ?? '';
    expect(chip).toContain('signOut()');
    const button = /<button[\s\S]*?<\/button>/.exec(chip.slice(chip.indexOf('signOut()') - 200))?.[0] ?? '';
    expect(button, 'the button carries no visible Sign out text').toMatch(/>\s*Sign out\s*</);
    expect(button).toMatch(/aria-label=\{`Sign out /);
  });
});
