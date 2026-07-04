import * as Cesium from 'cesium';
import { useCaptures, type Capture } from '../state/captures.js';
import { colorFor, detCounts } from '../ground/detectionOverlay.js';

// Renders the captures store (globe/CaptureLayer). Client-store-backed, mounted
// once by GlobeCanvas. OPTIMISED: a single CustomDataSource with UPSERT-BY-ID
// (never removeAll+add), SVG billboards (never dots), and STATIC positions
// (ConstantPositionProperty set once at create → no per-frame mirror; the scene
// idles under requestRenderMode between store edits). Selection works via the
// entity id; EntityPanel renders a CaptureCard for kind==='capture'.
//
// Count is low (auto-pin is dedup'd per source, capped at 200). If it ever needs
// thousands, swap the CustomDataSource for a batched PrimitiveEntityLayer — the
// same upsert-by-id shape used for aircraft.

// Dominant colour of a capture: person = red, else the top vehicle class colour.
function captureColor(c: Capture): string {
  if (c.dets.some((d) => d.cls === 'person')) return '#ef4444';
  const top = detCounts(c.dets)[0];
  return top ? colorFor(top[0]) : '#9ca3af';
}

// Reticle glyph (corner brackets + centre dot), tinted by content. SVG data URI
// so it rasterises crisply at any zoom, cached per colour.
const iconCache = new Map<string, string>();
function iconFor(color: string): string {
  let uri = iconCache.get(color);
  if (!uri) {
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='30' height='30' viewBox='0 0 30 30'>` +
      `<rect x='6' y='6' width='18' height='18' fill='${color}' fill-opacity='0.14'/>` +
      `<path d='M3 8V3H8 M22 3H27V8 M27 22V27H22 M8 27H3V22' fill='none' stroke='${color}' stroke-width='2' stroke-linecap='round'/>` +
      `<circle cx='15' cy='15' r='2.6' fill='${color}'/></svg>`;
    uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    iconCache.set(color, uri);
  }
  return uri;
}

function labelText(c: Capture): string {
  const counts = detCounts(c.dets);
  return counts.length ? counts.map(([cls, n]) => `${n} ${cls}`).join(' · ') : c.label.slice(0, 20);
}

function bagFor(c: Capture, summary: string): Cesium.PropertyBag {
  return new Cesium.PropertyBag({
    kind: 'capture',
    source: c.source,
    cam_id: c.camId ?? '',
    photo_url: c.photoUrl ?? '',
    label: c.label,
    n: c.dets.length,
    summary,
    captured_at: c.capturedAt,
    dets_json: JSON.stringify(c.dets),
    lat: c.lat,
    lon: c.lon,
  });
}

export function installCaptures(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__captures');
  void viewer.dataSources.add(ds);

  const sync = (): void => {
    if (viewer.isDestroyed()) return;
    const list = useCaptures.getState().captures;
    const seen = new Set<string>();

    for (const c of list) {
      seen.add(c.id);
      const color = captureColor(c);
      const img = iconFor(color);
      const txt = labelText(c);
      let e = ds.entities.getById(c.id);
      if (!e) {
        e = ds.entities.add({
          id: c.id,
          position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat), // static → no per-frame mirror
          billboard: {
            image: img,
            scale: 1,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            // depth-tested: the globe occludes a capture on the far hemisphere.
          },
          label: {
            text: txt,
            font: '600 11px "IBM Plex Mono", monospace',
            fillColor: Cesium.Color.fromCssColorString(color),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.78),
            backgroundPadding: new Cesium.Cartesian2(6, 3),
            pixelOffset: new Cesium.Cartesian2(0, -18),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2_000_000),
          },
        });
      } else {
        // upsert-in-place: content (dets) changed on re-detect; position is static.
        if (e.billboard) e.billboard.image = new Cesium.ConstantProperty(img);
        if (e.label) {
          e.label.text = new Cesium.ConstantProperty(txt);
          e.label.fillColor = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString(color));
        }
      }
      e.properties = bagFor(c, txt);
    }

    // prune entities whose capture was removed
    for (const e of [...ds.entities.values]) {
      if (!seen.has(e.id)) ds.entities.remove(e);
    }
    viewer.scene.requestRender();
  };

  sync();
  const unsub = useCaptures.subscribe(sync);

  return () => {
    unsub();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* already gone */
    }
  };
}
