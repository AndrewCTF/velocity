import { describe, it, expect } from 'vitest';
import { validJobId } from './jobId.js';

describe('validJobId (ASVS V1.2.2)', () => {
  it('accepts the hex ids recon.py mints', () => {
    expect(validJobId('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
  });

  it('refuses anything that could walk the authed request to another path', () => {
    for (const bad of ['../../admin', 'abc/../x', 'A1B2C3D4', 'abc', 'a1b2c3%2f', '', null, 7]) {
      expect(validJobId(bad)).toBeNull();
    }
  });
});
