// The copy's map plates (raw_plate + plate(kind="light"), builder lines
// 48-89): the Esri light gray canvas with its reference-label layer over it,
// tiles at the integer zoom round(zf) scaled by 2^(zf - zi) about the centre,
// exact web mercator. Keyless public Esri tiles, drawn as <img> (CSP img-src
// already allows https:); no fetch.
import { pyRound } from "./kit.js";
import { wpx } from "./data.js";

const URL_ = {
  lgray:
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/",
  lref: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/",
};

export function Plate({
  lon,
  lat,
  zf,
  W,
  H,
  top = 0,
  left = 0,
}: {
  lon: number;
  lat: number;
  zf: number;
  W: number;
  H: number;
  top?: number;
  left?: number;
}): JSX.Element {
  const zi = Math.min(Math.max(pyRound(zf), 0), 16);
  const k = 2 ** (zf - zi);
  const [cx, cy] = wpx(lon, lat, zi);
  const sw = W / k;
  const sh = H / k;
  const x0 = cx - sw / 2;
  const y0 = cy - sh / 2;
  const n = 2 ** zi;
  const tiles: Array<[number, number]> = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + sh) / 256); ty++)
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + sw) / 256); tx++)
      if (ty >= 0 && ty < n) tiles.push([tx, ty]);
  const layer = (kind: keyof typeof URL_): JSX.Element[] =>
    tiles.map(([tx, ty]) => (
      <img
        key={`${kind}${tx},${ty}`}
        alt=""
        draggable={false}
        src={`${URL_[kind]}${zi}/${ty}/${((tx % n) + n) % n}`}
        style={{
          left: (tx * 256 - x0) * k,
          top: (ty * 256 - y0) * k,
          width: 256 * k,
          height: 256 * k,
          maxWidth: "none",
        }}
      />
    ));
  return (
    <div
      style={{
        left,
        top,
        width: W,
        height: H,
        overflow: "hidden",
        background: "rgb(200,205,207)",
      }}
    >
      {layer("lgray")}
      {layer("lref")}
    </div>
  );
}
