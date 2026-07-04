import * as Cesium from 'cesium';

// 45° hatch fill for controlled areas. Cesium has no diagonal-stripe material
// (StripeMaterialProperty is only horizontal/vertical, two-colour), so we render a
// small tileable canvas of diagonal lines in the faction colour over a transparent
// ground and hand it to an ImageMaterialProperty. Cached by colour+density so a map
// of many zones in the same faction shares one GPU texture.

const _cache = new Map<string, Cesium.ImageMaterialProperty>();

/** Build (or reuse) a 45° diagonal-hatch material in `cssColor`. `dense` doubles the
 *  stripe frequency — used for CONTESTED zones so they read as busier at a glance. */
export function hatchMaterial(cssColor: string, dense = false): Cesium.ImageMaterialProperty {
  const key = `${cssColor}|${dense ? 'd' : 'n'}`;
  const cached = _cache.get(key);
  if (cached) return cached;

  const size = 12;
  const canvas = makeHatchCanvas(cssColor, dense, size);
  const mat = new Cesium.ImageMaterialProperty({
    image: canvas,
    // Repeat so the tile stays a fixed pixel size regardless of zone extent.
    repeat: new Cesium.Cartesian2(dense ? 240 : 160, dense ? 240 : 160),
    transparent: true,
  });
  _cache.set(key, mat);
  return mat;
}

/** The raw canvas — separated so it is unit-testable without a Cesium viewer. */
export function makeHatchCanvas(cssColor: string, dense: boolean, size = 12): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = cssColor;
  ctx.lineWidth = dense ? 1.4 : 1.8;
  ctx.globalAlpha = 0.85;
  // Two diagonals (main + wrap) so the 45° pattern tiles seamlessly across edges.
  const step = dense ? size / 2 : size;
  for (let off = -size; off < size * 2; off += step) {
    ctx.beginPath();
    ctx.moveTo(off, 0);
    ctx.lineTo(off + size, size);
    ctx.stroke();
  }
  return canvas;
}
