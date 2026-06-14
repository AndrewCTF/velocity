import { describe, expect, it } from 'vitest';

import { imageryOverlayUrl } from './gibsUrl';

describe('imageryOverlayUrl', () => {
  it('builds a date-templated GIBS backend URL with Cesium z/x/y placeholders', () => {
    expect(
      imageryOverlayUrl('gibs', 'MODIS_Terra_CorrectedReflectance_TrueColor', '2026-06-10'),
    ).toBe(
      '/api/imagery/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/{z}/{x}/{y}?date=2026-06-10',
    );
  });

  it('builds a CDSE Sentinel layer URL', () => {
    expect(imageryOverlayUrl('cdse', 'S2_L2A_TRUECOLOR', '2026-06-14')).toBe(
      '/api/imagery/cdse/S2_L2A_TRUECOLOR/{z}/{x}/{y}?date=2026-06-14',
    );
  });
});
