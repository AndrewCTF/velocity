"""GET /api/status — PUBLIC live status + honest coverage.

Measured counts from the running snapshot (aircraft in the live feed, refresh
age) plus per-feed green/degraded health. Public (no auth) so it can back a
trust/status page. Deliberately states coverage limits rather than implying
total coverage.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections import deque
from typing import Any

from fastapi import APIRouter

from app.config import get_settings
from app.routes import adsb as adsb_routes

router = APIRouter(tags=["status"])

# Steady-state floor the aircraft union should hold (see CLAUDE.md guardrail).
_AIRCRAFT_FLOOR = 8000


def _feed(name: str, ok: bool | None, detail: str, **extra: Any) -> dict[str, Any]:
    """One feed row. ``ok=None`` is the THIRD state and is not a synonym for green.

    "Never attempted" used to render as green here, because two feeds were
    hardcoded ``True`` and four more read a key being CONFIGURED as proof it
    worked. A feed nobody has called yet is unknown, and saying so is the same
    honesty rule the note at the bottom of this route already states about
    coverage.
    """
    state = "unknown" if ok is None else ("green" if ok else "degraded")
    return {"name": name, "status": state, "detail": detail, **extra}


def _measured(host: str) -> tuple[bool | None, str]:
    """(state, detail) for `host` from the upstream health registry.

    Returns ``(None, ...)`` when the host has not been called this process —
    which is a real answer, not a failure and not a pass.
    """
    try:
        from app import upstream  # noqa: PLC0415

        for row in upstream.source_health():
            if row["host"] != host:
                continue
            if row["state"] == "ok":
                age = row.get("success_age_s")
                return True, f"last fetch OK{f' {age:.0f}s ago' if age is not None else ''}"
            if row["state"] == "failing":
                return False, f"last attempt failed: {row.get('last_error') or 'unknown'}"
            return None, "no fetch attempted yet"
    except Exception:  # noqa: BLE001 — status must never 500
        return None, "health registry unavailable"
    return None, "no fetch attempted yet"


def _extra(payload: dict[str, Any]) -> dict[str, Any]:
    """Health payload minus the keys :func:`_feed` owns.

    A sidecar's own /health speaks its own vocabulary — the browser tier answers
    `{"ok": true, ...}` — and splatting that straight into `_feed(name, ok, ...)`
    raised "got multiple values for argument 'ok'" and 500'd this route.
    """
    return {k: v for k, v in payload.items() if k not in ("name", "ok", "status", "detail")}


@router.get("/api/status")
async def status() -> dict[str, Any]:
    s = get_settings()
    from app import ais_firehose, ais_keyless, marinetraffic  # noqa: PLC0415

    # Counts only — never `global_snapshot()`. This route is public, anonymous
    # and polled by status pages, and calling the snapshot helper for a number
    # took _SNAPSHOT_LOCK (held by the 1 Hz refresher across its merge), copied
    # the snapshot dict, and on a cold process could kick a fan-out from an
    # anonymous request. Measured p50 12.5 ms -> 10.1 ms. The multi-second tail
    # is loop-wide, not this route's, and is unchanged — see
    # adsb_routes.snapshot_count().
    try:
        aircraft = adsb_routes.snapshot_count()
    except Exception:  # noqa: BLE001 — status must never 500
        aircraft = 0
    age = adsb_routes.snapshot_age_s()

    # Live vessels in the unified store: latest fix per MMSI across ALL AIS
    # sources (Digitraffic, Kystverket/Kystdatahuset, AISStream) accumulated
    # within the store retention window. Northern Europe only without an AISStream
    # key; global AIS needs one.
    vessels = 0
    parked = 0
    try:
        from app.correlate.store import store  # noqa: PLC0415
        from app.routes import maritime  # noqa: PLC0415

        vessels = store.count("vessel")
        parked = maritime.parked_count()
    except Exception:  # noqa: BLE001 — never let vessels break status
        vessels = 0

    ais_stats = ais_keyless.stats()
    keyless_ais_on = bool(
        ais_firehose.stats().get("enabled")
        or ais_stats.get("kystdatahuset_enabled")
        or ais_stats.get("digitraffic_mqtt_enabled")
        # The two GLOBAL keyless sources count too — without them this read
        # "no keyless AIS" while ~46k of the ~56k vessels came from exactly here.
        or ais_stats.get("shipxplorer_enabled")
        or ais_stats.get("myshiptracking_sidecar_enabled")
    )
    # Non-zero while the MyShipTracking feeder's browser has lost the site: the
    # poller then refuses its replayed union, so its ~22k global MMSIs drop out
    # BY DESIGN. Surface it — a third of the vessel layer going missing is not a
    # green feed, and the count alone can't show it (the rest of the union hides
    # the hole).
    mst_stale_s = int(ais_stats.get("myshiptracking_stale_s") or 0)
    # Enabled but landing nothing — the site is blocking its browser, or it is
    # still warming its first sweep. The union stays honest either way (the other
    # sources carry it), so this annotates the detail rather than reddening the
    # feed. Naming a source that is contributing zero would be the same overclaim
    # this feed used to make when it called a global union "Northern Europe only".
    mst_dry = bool(ais_stats.get("myshiptracking_sidecar_enabled")) and not int(
        ais_stats.get("myshiptracking_vessels") or 0
    )

    sar_state, sar_detail = _measured("catalogue.dataspace.copernicus.eu")
    firms_state, firms_detail = _measured("firms.modaps.eosdis.nasa.gov")

    feeds = [
        _feed(
            "ADS-B aircraft (OpenSky + airplanes.live grid)",
            aircraft >= _AIRCRAFT_FLOOR,
            f"{aircraft} aircraft in the live snapshot"
            + (f", refreshed {age}s ago" if age is not None else ""),
            count=aircraft,
            age_s=age,
        ),
        _feed(
            "AIS vessels — keyless",
            keyless_ais_on and vessels > 0 and not mst_stale_s,
            f"{vessels} vessels ({parked} parked, long-retained) · worldwide, "
            "MMSI-deduped across ShipXplorer"
            + ("" if mst_dry else " and MyShipTracking")
            + " plus the Norway and Baltic regional feeds"
            + (
                f" · MyShipTracking is replaying a {mst_stale_s}s-old scrape and is "
                "held out of the union until it recovers"
                if mst_stale_s
                else " · MyShipTracking is not reporting"
                if mst_dry
                else ""
            ),
            count=vessels,
        ),
        _feed(
            "AIS vessels — AISStream (global firehose)",
            bool(s.aisstream_key),
            "GLOBAL coverage — live."
            if s.aisstream_key
            else "Dormant: set AISSTREAM_KEY (free at aisstream.io) for worldwide AIS. "
            "No keyless global feed exists from a server — this is the firehose.",
        ),
        _feed(
            "AIS vessels — MarineTraffic (global, paid)",
            bool(s.marinetraffic_key) and marinetraffic.stats().get("last_error") is None,
            (
                f"{marinetraffic.stats().get('vessels', 0)} vessels"
                + (
                    f" · err: {marinetraffic.stats().get('last_error')}"
                    if marinetraffic.stats().get("last_error") else ""
                )
            )
            if s.marinetraffic_key
            else "Dormant: set MARINETRAFFIC_KEY (paid) to enable. May be IP-restricted.",
        ),
        _feed(
            "GPS/GNSS jamming (derived)",
            aircraft > 0,
            "Inference from ADS-B NACp/NIC degradation — not a direct RF/SIGINT cut.",
        ),
        # Was hardcoded `True` with the detail "Keyless, always on." The 2026-08-20
        # sweep is what made that indefensible: keyless does not mean reachable,
        # and nothing here had ever checked. Now measured.
        _feed(
            "USGS earthquakes",
            *_measured("earthquake.usgs.gov"),
        ),
        # Also previously hardcoded `True`. The coverage caveat is still true and
        # still worth stating; whether the provider answered is now measured
        # rather than asserted.
        _feed(
            "Sentinel-1 SAR dark-vessel",
            sar_state,
            "Curated chokepoint AOIs only (e.g. Strait of Hormuz); ~6 h revisit · "
            + sar_detail,
        ),
        # `bool(firms_map_key)` answered "is a key set", never "does it work".
        # A revoked or rate-limited key read green here indefinitely.
        _feed(
            "NASA FIRMS fires",
            firms_state if s.firms_map_key else False,
            ("Key configured · " + firms_detail)
            if s.firms_map_key
            else "Needs MAP_KEY (degrades off).",
        ),
        _feed(
            "AISStream global AIS",
            bool(s.aisstream_key),
            "BYOK, on-demand." if s.aisstream_key else "BYOK — bring a key to enable.",
        ),
    ]

    # Egress tiers. Both are off by default and both are the kind of thing that
    # fails silently — a tunnel that dropped or a browser tier that died still
    # leaves every route answering, just from the wrong address or not at all.
    # `proxy_stats()` existed since the pool landed and was never surfaced.
    if s.warp_enabled or s.upstream_proxies or s.browser_fetch_enabled:
        from app import browser_fetch, upstream, warp  # noqa: PLC0415

        if s.warp_enabled:
            w = await warp.health()
            fallback = "kill switch on" if s.warp_kill_switch else "direct fallback"
            feeds.append(
                _feed(
                    "Cloudflare WARP egress",
                    bool(w.get("tunnelled")),
                    f"Exit {w.get('exit_ip')} · {fallback}."
                    if w.get("tunnelled")
                    else f"Tunnel down ({w.get('error') or 'not serving'}).",
                    **_extra(w),
                )
            )
        if s.browser_fetch_enabled:
            b = await browser_fetch.health()
            feeds.append(
                _feed(
                    "Browser fetch tier",
                    bool(b.get("serving")),
                    f"Real Chrome on :{s.browser_fetch_port}, {b.get('contexts', 0)} live contexts."
                    if b.get("serving")
                    else "Sidecar not answering.",
                    **_extra(b),
                )
            )
        stats = upstream.proxy_stats()
        if stats:
            feeds.append(
                _feed(
                    "Outbound proxy pool",
                    any(p.get("available") for p in stats),
                    f"{len(stats)} configured.",
                    proxies=stats,
                )
            )

    overall = "operational" if aircraft >= _AIRCRAFT_FLOOR else ("degraded" if aircraft else "down")
    return {
        "status": overall,
        "generated_at": int(time.time()),
        "build_id": s.build_id,
        "aircraft_count": aircraft,
        "aircraft_age_s": age,
        "aircraft_floor": _AIRCRAFT_FLOOR,
        "vessel_count": vessels,
        "parked_count": parked,
        "feeds": feeds,
        "note": (
            "Live counts from the running snapshot. Coverage is uneven by design — "
            "absence of a signal in a thin-coverage region is not evidence of absence. "
            "See /api/intel/sources (authenticated) for per-feed detail."
        ),
    }


# ── /api/status/perf ─────────────────────────────────────────────────────────
#
# The 2026-07-27 baseline could not report event-loop lag because nothing
# measured it, so the single most diagnostic number for "the backend blows up
# when I enable all toggles" was missing from the evidence. This endpoint is
# that number plus the counters that explain it, and it is what the perf
# harnesses poll.
#
# It must stay CHEAP — it is sampled once a second during a measurement run, so
# it may not walk the snapshot or the vessel store the way /api/status does.

_LAG_SAMPLES: deque[float] = deque(maxlen=120)
_LAG_TASK: asyncio.Task[None] | None = None
_LAG_TICK_S = 0.5


async def _lag_probe_forever() -> None:
    """Sleep a known interval and record the overshoot.

    A task that asks for 0.5 s and gets 0.9 s spent 400 ms waiting behind
    something that would not yield. That overshoot IS the lag every request on
    this loop is also paying.
    """
    loop = asyncio.get_running_loop()
    while True:
        t0 = loop.time()
        await asyncio.sleep(_LAG_TICK_S)
        _LAG_SAMPLES.append(max(0.0, (loop.time() - t0 - _LAG_TICK_S) * 1000.0))


def start_lag_probe() -> None:
    global _LAG_TASK
    if _LAG_TASK is None or _LAG_TASK.done():
        _LAG_TASK = asyncio.create_task(_lag_probe_forever())


async def stop_lag_probe() -> None:
    global _LAG_TASK
    t = _LAG_TASK
    _LAG_TASK = None
    if t and not t.done():
        t.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await t


def _pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return round(s[min(len(s) - 1, max(0, round((p / 100.0) * (len(s) - 1))))], 2)


@router.get("/api/status/perf")
async def status_perf() -> dict[str, Any]:
    """Event-loop lag, payload freshness and container sizes. Keyless, cheap."""
    lag = list(_LAG_SAMPLES)
    out: dict[str, Any] = {
        "generated_at": int(time.time()),
        "loop_lag_ms_p50": _pct(lag, 50),
        "loop_lag_ms_p95": _pct(lag, 95),
        "loop_lag_ms_max": round(max(lag), 2) if lag else None,
        "loop_lag_samples": len(lag),
        "loop_lag_window_s": round(len(lag) * _LAG_TICK_S, 1),
    }
    # ADS-B world blob — size and age come from module state, no snapshot walk.
    try:
        out["adsb"] = {
            "blob_bytes": len(adsb_routes._HOT_BLOB) if adsb_routes._HOT_BLOB else 0,
            "etag": adsb_routes._HOT_ETAG[:12] or None,
            "age_s": round(adsb_routes.snapshot_age_s(), 2),
            "ws_subscribers": len(adsb_routes._WS_SUBSCRIBERS),
            "feed_slices": len(adsb_routes._FEED_SLICES),
            "cycle_ms": adsb_routes.cycle_timings(),
            # The two tiers that are not a plain document fetch, so their shape
            # is worth stating: how much of the world FR24 saw, and what the
            # anonymous OpenSky budget has left after the gap filler spent on
            # our worst-covered cells.
            "fr24": dict(adsb_routes._FR24_STATS),
            "opensky_gaps": dict(adsb_routes._OPENSKY_GAP_STATS),
        }
    except Exception:  # noqa: BLE001 — diagnostics must never 500
        out["adsb"] = {"error": "unavailable"}
    try:
        from app.routes import maritime as maritime_routes  # noqa: PLC0415

        out["vessels"] = maritime_routes.vessel_blob_state()
        out["vessels"]["parked_cached"] = maritime_routes.parked_count()
    except Exception:  # noqa: BLE001
        out["vessels"] = {"error": "unavailable"}
    try:
        from app.upstream import cache as upstream_cache  # noqa: PLC0415

        out["feed_cache"] = {
            "entries": len(upstream_cache._data),
            "max_entries": upstream_cache._MAX_CACHE_ENTRIES
            if hasattr(upstream_cache, "_MAX_CACHE_ENTRIES")
            else None,
        }
    except Exception:  # noqa: BLE001
        out["feed_cache"] = {"error": "unavailable"}
    try:
        from app import ais_sidecar  # noqa: PLC0415

        out["ais_supervision"] = ais_sidecar.supervision_state()
    except Exception:  # noqa: BLE001
        out["ais_supervision"] = {"error": "unavailable"}
    return out


@router.get("/api/status/provenance")
async def status_provenance() -> dict[str, Any]:
    """Who is actually seeing the sky right now, and how much they agree.

    Every competitor in this category renders whatever its upstream asserts and
    says nothing about where it came from (docs/research-last30days-2026-07-29.md
    §1.1). The single highest-engagement story in the category is fabricated
    ADS-B rendered as real on a live map, and the community's own detection
    method is cross-source corroboration. This endpoint is that method, exposed:

      - per tier: how many contacts it saw, and how many ONLY it saw,
      - overall: the share of contacts with two or more independent observers.

    Exclusive counts are the interesting column. A tier contributing thousands of
    contacts nobody else can see is either genuinely unique coverage (oceanic
    breadth) or an unverifiable claim, and knowing which of your tiers is in that
    position is the difference between honest breadth and inherited noise.

    Diagnostics: never 500, and never triggers a fan-out of its own - it reads
    the snapshot the refresher already built.
    """
    out: dict[str, Any] = {"as_of": time.time()}
    try:
        snap = await adsb_routes.global_snapshot()
        feats = snap.get("features") or []
        per_tier: dict[str, dict[str, int]] = {}
        corroborated = 0
        counted = 0
        unknown = 0
        for f in feats:
            props = f.get("properties") or {}
            srcs = props.get("sources")
            if not isinstance(srcs, list) or not srcs:
                unknown += 1
                continue
            counted += 1
            if len(srcs) >= 2:
                corroborated += 1
            for s in srcs:
                row = per_tier.setdefault(str(s), {"contacts": 0, "exclusive": 0})
                row["contacts"] += 1
                if len(srcs) == 1:
                    row["exclusive"] += 1
        out["aircraft"] = {
            "total": len(feats),
            # Contacts whose observer set we know. A contact carried forward from
            # an earlier cycle has no set for THIS cycle, and calling that
            # "single source" would be a guess.
            "attributed": counted,
            "unattributed": unknown,
            "corroborated": corroborated,
            "corroborated_pct": round(100.0 * corroborated / counted, 1) if counted else None,
            "tiers": per_tier,
            "confidence_rule": adsb_routes.CONFIDENCE_RULE,
        }
    except Exception:  # noqa: BLE001 — diagnostics must never 500
        out["aircraft"] = {"error": "unavailable"}
    return out


# ── /api/status/sources ──────────────────────────────────────────────────────

# Upstream calls that do NOT go through the shared client, and so cannot appear
# in the registry below. Naming them is the point: a health page that lists only
# what it can see, without saying what it cannot, is the same overclaim in a new
# place. The localhost sidecar probes (adsb_sidecar, ais_sidecar, browser_fetch,
# llamacpp/vllm/mavlink, ai_models) are deliberately omitted — they are covered
# by the sidecar entries in /api/status and are not external sources.
#
# routes/adsb.py:1140 is first because it matters most: it is the SYNC client
# behind the ADS-B feed path, the highest-value feed on the platform, and
# _fetch_one_feed_sync swallows every failure into an empty aircraft list.
# → guarded by tests/test_feed_honesty.py
_UNMEASURED: list[tuple[str, str]] = [
    ("routes/adsb.py:1140",
     "sync ADS-B feed client (thread-bound; the async client cannot be used there)"),
    ("adsb_fr24.py:199", "FR24 tier"),
    ("adsb_opensky_gaps.py:243", "OpenSky gap filler"),
    ("correlate/runner.py:215", "correlation runner"),
    ("imagery/vhr.py:42", "VHR imagery provider"),
    ("llm.py:402", "hosted LLM"),
    ("llm.py:536", "hosted LLM (streaming)"),
    ("localllm/binary.py:149", "local model binary download"),
    ("mcp_server.py:221", "MCP self-call"),
    ("mcp_server.py:248", "MCP self-call"),
    ("mcp_server.py:303", "MCP self-call"),
    ("mcp_server.py:331", "MCP self-call"),
    ("mcp_server.py:350", "MCP self-call"),
    ("keys.py:187", "API-key validation probe"),
    ("auth.py:131", "Supabase JWKS fetch"),
    ("warp.py:127", "WARP tunnel health"),
    ("workflows/control.py:70", "operator-configured outbound actuation"),
]


@router.get("/api/status/sources")
async def status_sources() -> dict[str, Any]:
    """Measured per-upstream health: who answered, who failed, and how long ago.

    Every other health surface on this platform is an ASSERTION. /api/status
    hardcoded two feeds green and inferred four more from a key being present in
    the config rather than from a fetch that worked; /api/health is the constant
    ``{"status": "ok"}``. Before this endpoint the process recorded last_success
    for zero of its ~100 upstreams.

    This is the measurement instead. Rows come from app.upstream's registry,
    written on every request through the shared client, so a host appears here
    because it was actually called - not because someone listed it.

    Read `unmeasured` as part of the answer, not a footnote: those upstreams
    build their own httpx client and are invisible here.

    Diagnostics contract, same as its siblings: never 500, never triggers a
    fan-out of its own.
    """
    out: dict[str, Any] = {"as_of": time.time()}
    try:
        from app import upstream  # noqa: PLC0415

        rows = upstream.source_health()
        out["sources"] = rows
        out["counts"] = {
            "total": len(rows),
            "ok": sum(1 for r in rows if r["state"] == "ok"),
            "failing": sum(1 for r in rows if r["state"] == "failing"),
            "unknown": sum(1 for r in rows if r["state"] == "unknown"),
        }
    except Exception:  # noqa: BLE001 — diagnostics must never 500
        out["sources"] = []
        out["counts"] = {"error": "unavailable"}
    out["unmeasured"] = [{"where": w, "what": d} for w, d in _UNMEASURED]
    out["note"] = (
        "One row per upstream HOST, recorded at the shared client. A row is one "
        "logical request: redirect hops, the transport's single retry and the "
        "WARP tunnel-to-direct fallback collapse into one, so a WARP fallback "
        "reads here as a clean success. Latency for streamed responses is "
        "headers-only. State is measured, never inferred from configuration: "
        "'unknown' means never attempted this process and is not a synonym for "
        "healthy."
    )
    return out


# Capabilities that need configuration, and the EXACT setting names the code
# reads. Generated against Settings at request time rather than written out in
# prose, because the failure this exists to prevent is documentation drifting
# away from the code.
#
# That drift is not hypothetical. The largest cluster of complaints on the
# highest-scoring launch in this category was a map that rendered blank because
# a key was missing and nothing said so, and a commenter had to work out that
# the README named OPENSKY_USERNAME / OPENSKY_PASSWORD while the code read
# OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET. The reply was "the perils of vibe
# coding". See docs/research-last30days-2026-07-29.md §5.1 and §5.2.
#
# (capability, [setting names], what you lose without it)
_OPTIONAL_CAPABILITIES: list[tuple[str, list[str], str]] = [
    (
        "OpenSky authenticated breadth",
        ["opensky_client_id", "opensky_client_secret"],
        "Anonymous access still works on a small daily credit budget; with "
        "credentials the budget is larger, so the global aircraft floor is "
        "easier to hold.",
    ),
    (
        "AISStream global firehose",
        ["aisstream_key"],
        "Keyless regional AIS still runs; the global firehose adds open-ocean "
        "vessels the regional feeds cannot see.",
    ),
    (
        "NASA FIRMS fires",
        ["firms_map_key"],
        "The fire layer degrades gracefully without a key.",
    ),
    (
        "Sentinel / CDSE imagery",
        ["cdse_client_id", "cdse_client_secret"],
        "On-demand satellite imagery and SAR dark-vessel sweeps are unavailable.",
    ),
    (
        "Cesium Ion terrain and imagery",
        ["cesium_ion_token"],
        "The globe falls back to the keyless Carto basemap.",
    ),
]


@router.get("/api/status/doctor")
async def status_doctor() -> dict[str, Any]:
    """What is configured, what is missing, and the exact line that fixes it.

    A blank layer is indistinguishable from a broken product unless something
    says which one it is. This endpoint is that something: for every optional
    capability it reports whether the settings the CODE reads are populated, what
    you lose without them, and the literal `KEY=value` line to add.

    Setting names come from the Settings model itself, so this cannot describe an
    environment variable the application does not actually read. It reports only
    whether a value is present - never the value - so it is safe to paste into an
    issue.
    """
    settings = get_settings()
    fields = set(type(settings).model_fields)
    problems: list[dict[str, Any]] = []
    configured: list[str] = []

    for cap, names, consequence in _OPTIONAL_CAPABILITIES:
        missing: list[str] = []
        unknown: list[str] = []
        for n in names:
            if n not in fields:
                # A capability naming a setting that no longer exists is itself a
                # defect: this list has drifted from the code.
                unknown.append(n)
                continue
            if not getattr(settings, n, None):
                missing.append(n)
        if unknown:
            problems.append(
                {
                    "capability": cap,
                    "state": "misconfigured-check",
                    "detail": (
                        "This check names settings the application does not read: "
                        + ", ".join(unknown)
                        + ". The check is wrong, not your configuration."
                    ),
                    "fix": None,
                }
            )
        elif missing:
            problems.append(
                {
                    "capability": cap,
                    "state": "not-configured",
                    "detail": consequence,
                    "fix": " ".join(f"{n.upper()}=..." for n in missing),
                }
            )
        else:
            configured.append(cap)

    return {
        "as_of": time.time(),
        # Keyless by design: nothing here is required to run the console, so an
        # empty `problems` list and a long one are both healthy states. Saying so
        # explicitly stops a list of "not configured" reading as a list of faults.
        "required_missing": 0,
        "optional_not_configured": len(problems),
        "configured": sorted(configured),
        "problems": problems,
        "note": (
            "Every capability listed here is optional. The console runs keyless; "
            "these only widen coverage."
        ),
    }
