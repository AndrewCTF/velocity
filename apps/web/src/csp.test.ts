import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCsp } from '../csp';

// vitest runs with cwd = apps/web.
const tauri = JSON.parse(
  readFileSync(join(process.cwd(), '../desktop/src-tauri/tauri.conf.json'), 'utf8'),
) as { app: { security: { csp: string | null } } };

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name as string, values];
    }),
  );
}

describe('content security policy', () => {
  it('the Tauri shell carries the same policy as the desktop web build', () => {
    expect(tauri.app.security.csp).toBe(buildCsp({ desktop: true }));
  });

  it('allows no inline script and no eval', () => {
    for (const policy of [buildCsp(), buildCsp({ desktop: true })]) {
      const script = directives(policy).get('script-src') ?? [];
      expect(script).not.toContain("'unsafe-inline'");
      expect(script).not.toContain("'unsafe-eval'");
      expect(directives(policy).get('object-src')).toEqual(["'none'"]);
    }
  });

  it("base-uri is 'none' and no page declares a <base> (ASVS V3.4.3)", () => {
    for (const policy of [buildCsp(), buildCsp({ desktop: true })]) {
      expect(directives(policy).get('base-uri')).toEqual(["'none'"]);
    }
    expect(readFileSync(join(process.cwd(), 'index.html'), 'utf8')).not.toMatch(/<base[\s>]/i);
  });

  it('names keyed imagery origins exactly and never allows any https: origin', () => {
    // Keyless boxes never contact these; an operator who supplies an ion or
    // Google key (GlobeCanvas.tsx) must not be silently broken by the policy.
    const connect = directives(buildCsp({ desktop: true })).get('connect-src') ?? [];
    expect(connect.filter((o) => /cesium\.com|googleapis\.com/.test(o)).sort()).toEqual([
      'https://api.cesium.com',
      'https://assets.ion.cesium.com',
      'https://tile.googleapis.com',
    ]);
    expect(connect).not.toContain('https:');
  });

  it('hosted build adds a cross-origin API and Supabase only when configured', () => {
    const hosted = directives(buildCsp()).get('connect-src') ?? [];
    expect(hosted).not.toContain('http://127.0.0.1:8000');
    const configured =
      directives(
        buildCsp({ apiUrl: 'https://api.example.org/', supabaseUrl: 'https://abc.supabase.co' }),
      ).get('connect-src') ?? [];
    expect(configured).toEqual(
      expect.arrayContaining(['https://api.example.org', 'wss://api.example.org', 'https://abc.supabase.co']),
    );
  });
});
