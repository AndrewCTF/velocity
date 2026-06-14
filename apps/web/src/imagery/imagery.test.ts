import { describe, expect, it } from 'vitest';

import { gibsOverlayUrl } from './gibsUrl';

describe('gibsOverlayUrl', () => {
  it('builds a date-templated backend URL with Cesium z/x/y placeholders', () => {
    expect(
      gibsOverlayUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-06-10'),
    ).toBe(
      '/api/imagery/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/{z}/{x}/{y}?date=2026-06-10',
    );
  });
});
