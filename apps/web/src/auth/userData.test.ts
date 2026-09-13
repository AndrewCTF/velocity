import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clearUserData, DEVICE_PREF_KEYS, USER_DATA_KEYS } from './userData.js';
import { useCaptures } from '../state/captures.js';
import { useTaskingQuestions } from '../state/taskingQuestions.js';
import { useInbox } from '../state/inbox.js';
import { useAnnotations } from '../annotations/annotationStore.js';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('sign-out clears investigation data (ASVS V14.3.1)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('empties the stores and their storage, and keeps device preferences', () => {
    useCaptures.getState().pin({ source: 'test', srcId: '1', lat: 1, lon: 2 } as never);
    useTaskingQuestions.getState().add({ label: 'q', lat: 1, lon: 2, hours: 6 });
    useInbox.getState().markRead('a1');
    useAnnotations.getState().add({ kind: 'point', coords: [[1, 2]] } as never);
    for (const k of USER_DATA_KEYS) localStorage.setItem(k, '["x"]');
    localStorage.setItem('velocity.theme', 'daylight');
    localStorage.setItem('csl.rightW', '420');

    clearUserData();

    for (const k of USER_DATA_KEYS) expect(localStorage.getItem(k)).toBeNull();
    expect(useCaptures.getState().captures).toEqual([]);
    expect(useTaskingQuestions.getState().questions).toEqual([]);
    expect(useInbox.getState().read.size).toBe(0);
    expect(useAnnotations.getState().annotations).toEqual([]);
    expect(localStorage.getItem('velocity.theme')).toBe('daylight');
    expect(localStorage.getItem('csl.rightW')).toBe('420');
  });

  it('every storage key the app writes is classified as user data or a device preference', () => {
    const src = join(process.cwd(), 'src');
    const known = new Set<string>([...USER_DATA_KEYS, ...DEVICE_PREF_KEYS, 'osint.probe',
      // WebSocket subprotocol name (transport/http.ts), not a storage key.
      'velocity.v1']);
    const found = new Set<string>();
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/['"`]((?:velocity|osint|csl)\.[A-Za-z0-9._-]+)['"`]/g)) {
        found.add(m[1] as string);
      }
    }
    const unclassified = [...found].filter((k) => !known.has(k));
    expect(unclassified).toEqual([]);
    expect(found.size).toBeGreaterThan(10);
  });

  it('AuthProvider runs it on SIGNED_OUT', () => {
    const ctx = readFileSync(join(process.cwd(), 'src/auth/AuthContext.tsx'), 'utf8');
    expect(ctx).toMatch(/event === 'SIGNED_OUT'\) \{\s*clearUserData\(\)/);
  });
});
