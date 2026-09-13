import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from './escapeHtml.js';

describe('escapeHtml (ASVS V1.2.1)', () => {
  it('escapes all five characters, so attribute context is safe too', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
    );
  });

  it('stringifies non-strings and treats nullish as empty', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('BriefPanel builds its HTML with it and no longer interpolates status raw', () => {
    const src = readFileSync(join(process.cwd(), 'src/reports/BriefPanel.tsx'), 'utf8');
    expect(src).toContain("import { escapeHtml } from '../shell/escapeHtml.js'");
    expect(src).not.toMatch(/replace\(\/\[&<>\]\/g/);
    expect(src).not.toContain('">${f.status}</td>');
    expect(src).toContain('${esc(f.status)}');
  });
});
