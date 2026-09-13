import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Vite inlines VITE_* shell variables into the browser bundle. A compose file
// setting VITE_API_URL to a service name sends the browser to `api:8000`
// instead of through nginx (vite.config.ts says why; API_PROXY_TARGET is the
// server-side proxy target).
describe('compose never hands the browser an internal API URL', () => {
  for (const f of ['docker-compose.yml', 'docker-compose.prod.yml']) {
    it(f, () => {
      const text = readFileSync(join(__dirname, '../../..', f), 'utf8');
      expect(text).not.toMatch(/^\s*-?\s*VITE_API_URL\s*[:=]/m);
    });
  }
});
