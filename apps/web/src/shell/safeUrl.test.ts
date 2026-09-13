import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeHttpUrl } from './safeUrl.js';

describe('safeHttpUrl (ASVS V1.2.2 / V3.2.1)', () => {
  it('keeps http, https and same-origin relative links', () => {
    expect(safeHttpUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHttpUrl('http://example.org')).toBe('http://example.org');
    expect(safeHttpUrl('/api/imagery/chip?lat=1')).toBe('/api/imagery/chip?lat=1');
    expect(safeHttpUrl('  https://example.org  ')).toBe('https://example.org');
  });

  it('drops script-capable and non-web schemes, however they are disguised', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.org/uuid',
    ]) {
      expect(safeHttpUrl(bad)).toBeUndefined();
    }
  });

  it('drops non-strings and blanks', () => {
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(safeHttpUrl(null)).toBeUndefined();
    expect(safeHttpUrl(42)).toBeUndefined();
    expect(safeHttpUrl('   ')).toBeUndefined();
  });

  it('guards the feed-derived link sinks the audit named', () => {
    const sinks: [string, string][] = [
      ['news/VelocityNewsPage.tsx', 'href={safeHttpUrl(a.link)}'],
      ['news/StoryView.tsx', 'href={safeHttpUrl(p.url)}'],
      ['evidence/EvidencePanel.tsx', 'href={safeHttpUrl(p.source_url)}'],
      ['osint/OsintEntityPanel.tsx', 'href={safeHttpUrl(entity.url)}'],
      ['country/AdvisoryCard.tsx', 'href={safeHttpUrl(item.link)}'],
      ['shell/Markdown.tsx', 'href={safeHttpUrl(href)}'],
      ['entity-panel/EntityPanel.tsx', 'src={safeHttpUrl(photo)}'],
    ];
    for (const [file, needle] of sinks) {
      expect(readFileSync(join(process.cwd(), 'src', file), 'utf8')).toContain(needle);
    }
  });
});
