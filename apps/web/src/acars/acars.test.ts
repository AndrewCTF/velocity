import { describe, it, expect } from 'vitest';
import { originOf } from './acars.js';

describe('originOf — inferred ACARS message origin', () => {
  it('treats crew free-text with real words as pilot', () => {
    expect(originOf({ label: 'RA', text: 'QUNDCULUA~1RLS VERIFICATION' })).toBe('pilot');
    expect(originOf({ label: '80', text: 'REQUEST PUSHBACK' })).toBe('pilot');
  });
  it('treats position / link / control frames as system', () => {
    expect(originOf({ label: 'H1', text: '902N176DZ0287280636150234256379806' })).toBe('system');
    expect(originOf({ label: '_d', text: '' })).toBe('system');
    expect(originOf({ label: 'Q0', text: 'X' })).toBe('system');
    expect(originOf({ label: '52', text: '2606287150454' })).toBe('system');
  });
  it('no free text → system', () => {
    expect(originOf({ label: null, text: null })).toBe('system');
  });
  it('coded numeric payload → system', () => {
    expect(originOf({ label: '4;', text: '131550' })).toBe('system');
  });
});
