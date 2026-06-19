"""On-demand AOI imagery — set a location + before/after dates, get imagery.

Nothing is stored permanently. A caller names an area (bbox, or centre+radius)
and two dates; this returns a manifest of what imagery is available and, when
asked to *stage* it, downloads the selected scenes into a caller-owned scratch
dir (use ``tempfile.TemporaryDirectory`` / the ``scratch_aoi`` helper, which
deletes on exit). This module never writes under ``./data`` — that is the whole
point: the heavy bytes are computed on demand and discarded.

Two providers, best-resolution-first — honest about each one's reach:

1. **Maxar Open Data** (STAC, keyless) — VHR (~0.3–0.5 m) but ONLY where a
   disaster/conflict event has been activated. Event- and AOI-limited: most of
   the planet and most dates have NO Maxar Open Data coverage. Where it exists
   it is multi-view enough for crisp Stage-E 3D.
2. **Sentinel via CDSE** (``app.imagery.cdse``) — needs CDSE OAuth creds; free,
   global, any date, but 10 m (S2 optical / S1 SAR). Yields a 2.5D terrain /
   damage drape, not sharp 3D buildings. Always the fallback.

No "global/complete/full-coverage" claim is made for either source — Maxar is
event-gated and Sentinel is 10 m. The manifest reports exactly what each
provider returned for the requested AOI + dates.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
from pathlib import Path
from typing import Any

from app.imagery import cdse
from app.intel.geo import BBox, bbox_from_radius
from app.upstream import get_client

log = logging.getLogger(__name__)

MAXAR_ROOT = "https://maxar-opendata.s3.amazonaws.com/events/catalog.json"

# Bound the catalog crawl: Maxar Open Data is a static STAC on S3 with no search
# API, so finding coverage means walking event collections. We fan out with a
# small semaphore and cap how many events we read per index build, then cache
# the (event -> extent) index in memory with a TTL so only the FIRST query pays.
_CRAWL_SEMAPHORE = asyncio.Semaphore(16)
_MAX_EVENTS_SCANNED = 400
_INDEX_TTL_S = 6 * 3600.0
# Wall-clock budget for the one-time index crawl, so the first /api/imagery/aoi
# request can never hang behind hundreds of slow S3 fetches. On timeout we keep
# whatever completed and re-crawl sooner (short TTL) instead of caching a stale
# partial for 6 h.
_INDEX_BUILD_BUDGET_S = 25.0
_INDEX_PARTIAL_TTL_S = 600.0
# Overall budget for a single AOI's Maxar search (index + item descent). Past
# this the manifest falls back to Sentinel-only rather than blocking the caller.
_MAXAR_SEARCH_BUDGET_S = 30.0
_MAXAR_DEFAULT_WINDOW_DAYS = 30
_MAXAR_MAX_ITEMS = 24

# In-memory event index cache: list of (event_id, BBox, t_start, t_end, href).
_event_index: list[tuple[str, BBox, float, float, str]] | None = None
_index_at: float = 0.0
_index_ttl: float = _INDEX_TTL_S  # shrinks to _INDEX_PARTIAL_TTL_S on a timed-out crawl
_index_lock = asyncio.Lock()
_index_truncated = False


# ── date helpers ────────────────────────────────────────────────────────────


def _parse_date(s: str) -> dt.datetime:
    """YYYY-MM-DD (or full ISO) -> aware UTC datetime. Raises ValueError."""
    d = dt.datetime.fromisoformat(s)
    return d.replace(tzinfo=dt.UTC) if d.tzinfo is None else d.astimezone(dt.UTC)


def _to_epoch(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return _parse_date(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def aoi_bbox(
    *,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> BBox:
    """Resolve a centre+radius OR an explicit bbox into a BBox. bbox wins."""
    if bbox is not None:
        w, s, e, n = bbox
        return BBox(min(w, e), min(s, n), max(w, e), max(s, n))
    if lat is None or lon is None:
        raise ValueError("provide either bbox or lat+lon")
    radius_nm = (radius_km or 5.0) / 1.852
    return bbox_from_radius(lat, lon, radius_nm)


def _bbox_overlap(a: BBox, b: BBox) -> bool:
    return not (
        a.max_lon < b.min_lon
        or a.min_lon > b.max_lon
        or a.max_lat < b.min_lat
        or a.min_lat > b.max_lat
    )


# ── Maxar Open Data STAC crawl ──────────────────────────────────────────────


async def _get_json(url: str) -> dict[str, Any] | None:
    try:
        r = await get_client().get(url, timeout=20.0)
    except Exception:  # noqa: BLE001
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except Exception:  # noqa: BLE001
        return None


def _abs_href(parent_url: str, href: str) -> str:
    """Resolve a STAC child href relative to its parent document URL."""
    if href.startswith("http"):
        return href
    base = parent_url.rsplit("/", 1)[0]
    while href.startswith("../"):
        href = href[3:]
        base = base.rsplit("/", 1)[0]
    return f"{base}/{href.lstrip('./')}"


def _collection_extent(
    col: dict[str, Any],
) -> tuple[BBox, float, float] | None:
    """Pull (BBox, t_start, t_end) from a STAC Collection's extent block."""
    try:
        ext = col["extent"]
        bb = ext["spatial"]["bbox"][0]
        box = BBox(bb[0], bb[1], bb[2], bb[3])
        interval = ext["temporal"]["interval"][0]
        t0 = _to_epoch(interval[0]) or 0.0
        t1 = _to_epoch(interval[1]) or _to_epoch(
            dt.datetime.now(dt.UTC).isoformat()
        ) or 0.0
        return box, t0, t1
    except Exception:  # noqa: BLE001
        return None


async def _index_event(parent_url: str, href: str) -> tuple[str, BBox, float, float, str] | None:
    url = _abs_href(parent_url, href)
    async with _CRAWL_SEMAPHORE:
        col = await _get_json(url)
    if not col:
        return None
    ext = _collection_extent(col)
    if ext is None:
        return None
    box, t0, t1 = ext
    return (col.get("id") or href, box, t0, t1, url)


async def _load_event_index() -> list[tuple[str, BBox, float, float, str]]:
    """Crawl the Maxar Open Data root catalog into an (event -> extent) index,
    cached in memory for _INDEX_TTL_S. Bounded + concurrency-capped."""
    global _event_index, _index_at, _index_ttl, _index_truncated
    import time

    if _event_index is not None and (time.time() - _index_at) < _index_ttl:
        return _event_index
    async with _index_lock:
        if _event_index is not None and (time.time() - _index_at) < _index_ttl:
            return _event_index
        root = await _get_json(MAXAR_ROOT)
        if not root:
            log.info("ondemand: Maxar Open Data root catalog unreachable")
            _event_index = []
            _index_at = time.time()
            _index_ttl = _INDEX_PARTIAL_TTL_S  # retry sooner — likely transient
            return _event_index
        children = [
            lk.get("href")
            for lk in root.get("links", [])
            if lk.get("rel") == "child" and lk.get("href")
        ]
        _index_truncated = len(children) > _MAX_EVENTS_SCANNED
        if _index_truncated:
            log.warning(
                "ondemand: Maxar catalog has %d events; scanning first %d only",
                len(children),
                _MAX_EVENTS_SCANNED,
            )
        children = children[:_MAX_EVENTS_SCANNED]
        # Time-boxed crawl: keep whatever finished within the budget, cancel the
        # rest. A partial index is cached only briefly so we re-crawl soon.
        tasks = [asyncio.ensure_future(_index_event(MAXAR_ROOT, h)) for h in children]
        done, pending = await asyncio.wait(tasks, timeout=_INDEX_BUILD_BUDGET_S)
        for t in pending:
            t.cancel()
        idx: list[tuple[str, BBox, float, float, str]] = []
        for t in done:
            try:
                r = t.result()
            except Exception:  # noqa: BLE001
                continue
            if isinstance(r, tuple):
                idx.append(r)
        _event_index = idx
        _index_at = time.time()
        _index_ttl = _INDEX_PARTIAL_TTL_S if pending else _INDEX_TTL_S
        log.info(
            "ondemand: Maxar event index built (%d events%s)",
            len(idx),
            ", partial" if pending else "",
        )
        return idx


def _iso(epoch: float) -> str:
    return dt.datetime.fromtimestamp(epoch, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _event_acquisitions(
    event_url: str, aoi: BBox, t_from: float, t_to: float
) -> list[dict[str, Any]]:
    """One matching event -> its per-acquisition collections that overlap the
    AOI + date window. Filters at the COLLECTION level (each acquisition carries
    its own spatial+temporal extent), so this is dozens of concurrent fetches,
    NOT thousands of per-tile item fetches — the difference between ~2 s and a
    timeout on a dense VHR event. Item/asset descent happens later, only when
    staging."""
    col = await _get_json(event_url)
    if not col:
        return []
    child_urls = [
        _abs_href(event_url, lk["href"])
        for lk in col.get("links", [])
        if lk.get("rel") == "child" and lk.get("href")
    ]

    async def _one(url: str) -> dict[str, Any] | None:
        async with _CRAWL_SEMAPHORE:
            doc = await _get_json(url)
        if not doc:
            return None
        ext = _collection_extent(doc)
        if ext is None:
            return None
        box, e0, e1 = ext
        if not _bbox_overlap(box, aoi) or e1 < t_from or e0 > t_to:
            return None
        return {
            "id": doc.get("id"),
            "datetime": _iso(e0),
            "epoch": e0,
            "bbox": [round(v, 5) for v in (box.min_lon, box.min_lat, box.max_lon, box.max_lat)],
            "collection": url,
        }

    results = await asyncio.gather(*[_one(u) for u in child_urls])
    return [r for r in results if r]


async def _acquisition_items(
    collection_url: str, aoi: BBox, cap: int
) -> list[dict[str, Any]]:
    """Descend ONE acquisition collection into the item tiles overlapping the
    AOI (with asset hrefs). Only called when staging — never on the search path."""
    col = await _get_json(collection_url)
    if not col:
        return []
    item_urls = [
        _abs_href(collection_url, lk["href"])
        for lk in col.get("links", [])
        if lk.get("rel") == "item" and lk.get("href")
    ]

    async def _one(url: str) -> dict[str, Any] | None:
        async with _CRAWL_SEMAPHORE:
            doc = await _get_json(url)
        return _item_if_match(doc or {}, url, aoi, -1e18, 1e18)  # date already filtered

    out: list[dict[str, Any]] = []
    for fut in asyncio.as_completed([_one(u) for u in item_urls]):
        it = await fut
        if it:
            out.append(it)
            if len(out) >= cap:
                break
    return out


def _item_if_match(
    item: dict[str, Any], url: str, aoi: BBox, t_from: float, t_to: float
) -> dict[str, Any] | None:
    bb = item.get("bbox")
    props = item.get("properties") or {}
    when = _to_epoch(props.get("datetime"))
    if not bb or when is None:
        return None
    box = BBox(bb[0], bb[1], bb[2], bb[3])
    if not _bbox_overlap(box, aoi) or not (t_from <= when <= t_to):
        return None
    assets = {
        name: a.get("href")
        for name, a in (item.get("assets") or {}).items()
        if a.get("href")
    }
    return {
        "id": item.get("id"),
        "datetime": props.get("datetime"),
        "epoch": when,
        "bbox": [round(v, 5) for v in bb],
        "assets": assets,
        "self": url,
    }


async def maxar_search(
    aoi: BBox, target: str, window_days: int = _MAXAR_DEFAULT_WINDOW_DAYS
) -> list[dict[str, Any]]:
    """VHR ACQUISITIONS overlapping *aoi* within ±window_days of *target* date,
    nearest-in-time first. Each result is one Maxar acquisition (id, datetime,
    bbox, collection URL — the URL `stage_aoi` descends for COG tiles). [] when
    no Maxar Open Data event covers the AOI/date."""
    t = _to_epoch(target)
    if t is None:
        return []
    t_from, t_to = t - window_days * 86400, t + window_days * 86400
    idx = await _load_event_index()
    matches = [
        href
        for (_eid, box, e0, e1, href) in idx
        if _bbox_overlap(box, aoi) and not (e1 < t_from or e0 > t_to)
    ]
    if not matches:
        return []
    per_event = await asyncio.gather(
        *[_event_acquisitions(href, aoi, t_from, t_to) for href in matches]
    )
    acqs = [a for evt in per_event for a in evt]
    acqs.sort(key=lambda a: abs(a["epoch"] - t))
    return acqs[:_MAXAR_MAX_ITEMS]


# ── unified search (what's available) ───────────────────────────────────────


def _sentinel_layers() -> list[str]:
    """Sentinel layers usable for building AOIs (optical + SAR), if CDSE is up."""
    if not cdse.available():
        return []
    return ["S2_L2A_TRUECOLOR", "S1_GRD_VV"]


async def search_aoi(
    aoi: BBox,
    before: str,
    after: str,
    window_days: int = _MAXAR_DEFAULT_WINDOW_DAYS,
    commercial: bool = False,
) -> dict[str, Any]:
    """Manifest of imagery available for the AOI at the before + after dates.

    Cheap: queries provider catalogs only, downloads nothing. Maxar may fan out
    on first call (index build) then is cached. Honest per-provider reach.

    Maxar Open Data is CC BY-NC 4.0 (non-commercial), so when *commercial* is
    True it is skipped entirely and only Sentinel (Copernicus, commercial-OK)
    is offered.
    """
    maxar_timed_out = False
    maxar_before: list[dict[str, Any]] = []
    maxar_after: list[dict[str, Any]] = []
    if not commercial:
        try:
            maxar_before, maxar_after = await asyncio.wait_for(
                asyncio.gather(
                    maxar_search(aoi, before, window_days),
                    maxar_search(aoi, after, window_days),
                ),
                timeout=_MAXAR_SEARCH_BUDGET_S,
            )
        except TimeoutError:
            maxar_timed_out = True
            log.info(
                "ondemand: Maxar search exceeded %.0fs — Sentinel-only manifest",
                _MAXAR_SEARCH_BUDGET_S,
            )
    sent = _sentinel_layers()
    return {
        "aoi": aoi.as_dict(),
        "before": before,
        "after": after,
        "commercial": commercial,
        "maxar": {
            "note": (
                "disabled — CC BY-NC, not licensed for commercial use"
                if commercial
                else "VHR ~0.3-0.5 m; event-gated — empty where no event covers the AOI"
            ),
            "index_truncated": _index_truncated,
            "timed_out": maxar_timed_out,
            "before_items": maxar_before,
            "after_items": maxar_after,
        },
        "sentinel": {
            "note": "10 m, global, any date; 2.5D drape not crisp 3D",
            "available": bool(sent),
            "layers": sent,
        },
        "best_source": (
            "maxar"
            if (maxar_before and maxar_after)
            else ("sentinel" if sent else "none")
        ),
    }


# ── staging (download to a caller-owned scratch dir) ────────────────────────


def _write_bytes(dest: Path, data: bytes) -> int:
    """Sync mkdir+write — run via executor so async callers never block on disk."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return len(data)


async def _download(url: str, dest: Path) -> int:
    """Fetch a URL into *dest*. Returns bytes written (0 on failure)."""
    try:
        r = await get_client().get(url, timeout=120.0)
    except Exception:  # noqa: BLE001
        return 0
    if r.status_code != 200 or not r.content:
        return 0
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _write_bytes, dest, r.content)


def _sentinel_size(aoi: BBox, max_px: int = 2048) -> tuple[int, int]:
    span_lon = max(1e-4, aoi.max_lon - aoi.min_lon)
    span_lat = max(1e-4, aoi.max_lat - aoi.min_lat)
    if span_lon >= span_lat:
        w = max_px
        h = max(64, int(max_px * span_lat / span_lon))
    else:
        h = max_px
        w = max(64, int(max_px * span_lon / span_lat))
    return w, h


async def _stage_sentinel(aoi: BBox, date: str, tag: str, dest: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    w, h = _sentinel_size(aoi)
    bbox3857 = cdse.lonlat_bbox_3857(aoi.min_lon, aoi.min_lat, aoi.max_lon, aoi.max_lat)
    for layer_id in _sentinel_layers():
        meta = cdse.layer(layer_id)
        img = await cdse.fetch_image(layer_id, bbox3857, w, h, date)
        if not img:
            continue
        fp = dest / f"sentinel_{tag}_{layer_id}.{meta['ext']}"
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _write_bytes, fp, img)
        out.append({"provider": "sentinel", "layer": layer_id, "date": date,
                    "path": str(fp), "bytes": len(img)})
    return out


async def _stage_maxar(
    acqs: list[dict[str, Any]], aoi: BBox, tag: str, dest: Path, max_scenes: int
) -> list[dict[str, Any]]:
    """Descend the matched acquisitions into AOI-overlapping COG tiles and
    download up to *max_scenes* of them (the `visual` asset) into *dest*."""
    out: list[dict[str, Any]] = []
    for acq in acqs:
        if len(out) >= max_scenes:
            break
        items = await _acquisition_items(acq["collection"], aoi, max_scenes - len(out))
        for it in items:
            href = it["assets"].get("visual") or next(iter(it["assets"].values()), None)
            if not href:
                continue
            ext = href.rsplit(".", 1)[-1].split("?")[0][:4] or "tif"
            fp = dest / f"maxar_{tag}_{it['id']}.{ext}"
            n = await _download(href, fp)
            if n:
                out.append({"provider": "maxar", "id": it["id"],
                            "datetime": acq["datetime"], "path": str(fp), "bytes": n})
            if len(out) >= max_scenes:
                break
    return out


async def stage_aoi(
    aoi: BBox,
    before: str,
    after: str,
    dest: str | Path,
    *,
    source: str = "auto",
    max_maxar_scenes: int = 4,
    window_days: int = _MAXAR_DEFAULT_WINDOW_DAYS,
    commercial: bool = False,
) -> dict[str, Any]:
    """Download before+after imagery into *dest* (caller owns + deletes it).

    source: "maxar" | "sentinel" | "auto" (Maxar where it covers the AOI for
    BOTH dates, else Sentinel). When *commercial* is True, Maxar (CC BY-NC) is
    never used regardless of source. Returns a manifest of staged files.
    """
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    manifest = await search_aoi(aoi, before, after, window_days, commercial=commercial)
    mb = manifest["maxar"]["before_items"]
    ma = manifest["maxar"]["after_items"]
    use = "sentinel" if commercial else source
    if use == "auto":
        use = "maxar" if (mb and ma) else "sentinel"

    staged: list[dict[str, Any]] = []
    if use == "maxar":
        staged += await _stage_maxar(mb, aoi, "before", dest, max_maxar_scenes)
        staged += await _stage_maxar(ma, aoi, "after", dest, max_maxar_scenes)
    if use == "sentinel" or (use == "maxar" and not staged):
        # Sentinel fallback if Maxar yielded nothing downloadable.
        use = "sentinel"
        staged += await _stage_sentinel(aoi, before, "before", dest)
        staged += await _stage_sentinel(aoi, after, "after", dest)

    return {
        "aoi": aoi.as_dict(),
        "before": before,
        "after": after,
        "source": use,
        "dest": str(dest),
        "files": staged,
        "total_bytes": sum(f["bytes"] for f in staged),
    }


@contextlib.asynccontextmanager
async def scratch_aoi(
    aoi: BBox, before: str, after: str, *, source: str = "auto", **kw: Any
):
    """Stage AOI imagery into a TEMP dir, yield the manifest, delete on exit.

    The "compute on demand, store temporary, never perm" primitive for the
    Stage-E pipeline::

        async with scratch_aoi(aoi, "2025-03-01", "2025-04-01") as m:
            run_reconstruction(m["files"])      # temp dir alive here
        # temp dir + all imagery deleted here
    """
    import tempfile

    tmp = tempfile.mkdtemp(prefix="aoi-imagery-")
    try:
        yield await stage_aoi(aoi, before, after, tmp, source=source, **kw)
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)


# ── tiny CLI: set time + location directly from the shell ───────────────────


def _main() -> None:
    import argparse
    import json

    ap = argparse.ArgumentParser(
        description="On-demand AOI imagery: set before/after dates + location."
    )
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--radius-km", type=float, default=5.0)
    ap.add_argument("--bbox", help="w,s,e,n in degrees (overrides lat/lon)")
    ap.add_argument("--before", required=True, help="YYYY-MM-DD")
    ap.add_argument("--after", required=True, help="YYYY-MM-DD")
    ap.add_argument("--stage", metavar="DIR", help="download into DIR (else search only)")
    ap.add_argument("--source", default="auto", choices=["auto", "maxar", "sentinel"])
    args = ap.parse_args()

    bbox = None
    if args.bbox:
        w, s, e, n = (float(v) for v in args.bbox.split(","))
        bbox = (w, s, e, n)
    aoi = aoi_bbox(lat=args.lat, lon=args.lon, radius_km=args.radius_km, bbox=bbox)

    async def run() -> dict[str, Any]:
        if args.stage:
            return await stage_aoi(aoi, args.before, args.after, args.stage, source=args.source)
        return await search_aoi(aoi, args.before, args.after)

    print(json.dumps(asyncio.run(run()), indent=2))


if __name__ == "__main__":
    _main()
