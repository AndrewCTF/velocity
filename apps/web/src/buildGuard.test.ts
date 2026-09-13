import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledApiKeyError } from '../buildGuard';

describe('bundled VITE_API_KEY guard (ASVS V7.2.2)', () => {
  it('fails a hosted production build that carries the key', () => {
    const err = bundledApiKeyError({
      env: { VITE_API_KEY: 'op-secret' },
      desktop: false,
      isProduction: true,
    });
    expect(err).toMatch(/VITE_API_KEY/);
    expect(err).not.toContain('op-secret');
  });

  it('lets the desktop build and the dev server keep the key', () => {
    const env = { VITE_API_KEY: 'op-secret' };
    expect(bundledApiKeyError({ env, desktop: true, isProduction: true })).toBeNull();
    expect(bundledApiKeyError({ env, desktop: false, isProduction: false })).toBeNull();
  });

  it('passes a production build with no key, or a blank one', () => {
    expect(bundledApiKeyError({ env: {}, desktop: false, isProduction: true })).toBeNull();
    expect(
      bundledApiKeyError({ env: { VITE_API_KEY: '  ' }, desktop: false, isProduction: true }),
    ).toBeNull();
  });

  it('is wired into vite.config.ts as a build plugin', () => {
    const cfg = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/plugins: \[bundledKeyGuardPlugin\(\)/);
    expect(cfg).toMatch(/bundledApiKeyError\(\{\s*env: config\.env/);
  });
});
