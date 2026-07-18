"""Standing watchlists + geofence alerting — the evaluator (Track C3).

``routes/alert_rules.py`` is CRUD-only; its own docstring calls the matching loop
"the next increment". This module IS that increment: a background evaluator that,
on a cadence, reads the warm in-process picture everything else already shares
(``adsb.global_snapshot()`` — NEVER the ``adsb_global()`` route handler, which
500s on its unresolved ``Query(...)`` defaults — plus ``incidents.brief()``),
tests each enabled ``alert_rules`` row's geofence, and fires **persistent,
acknowledgeable** ``Alert`` objects into the ontology (``kind='alert'``, state
open → ack → closed) through the ontology registry. It also caches a
``RiskIndicator`` onto the triggering entity's ontology object so a later
traversal / EntityPanel read sees *why* it tripped.

Design rules (mirroring the deterministic-fusion discipline of ``incidents.py``):

- **Geofence is enter/exit, not level.** A rule fires on the TRANSITION into its
  AOI (and emits a paired exit), not once per tick while a contact sits inside —
  otherwise a loitering aircraft would spam an alert every cadence. Prior
  membership is held per (rule, entity) in memory, so the first tick that sees a
  contact already inside is an enter, and the tick after it leaves is an exit.
- **Read, don't fetch.** The evaluator consumes the SAME warm snapshot + brief the
  globe and MCP share; it adds no steady-state upstream load.
- **RLS needs the caller's token.** ``alert_rules`` / ``objects`` / ``links`` are
  per-user RLS tables read with the user's own Supabase token (``keys._headers``).
  A background loop has no request, so there is no token to forge — and there is
  no service-role key in ``Settings`` (adding one is out of scope and a security
  decision). So the evaluator runs over an explicit registry of ACTIVE SESSIONS
  (``register_session(ctx)`` / ``unregister_session``) that an authed transport
  (e.g. the ``/ws/alerts`` socket) supplies. With zero sessions the loop no-ops
  cheaply — which is also exactly the graceful behaviour when Supabase is unset
  (no session is ever registered, nothing is read, nothing crashes).
- **Reuse ``/ws/alerts``.** A fired alert is also published onto the existing
  ``correlate.bus`` (``bus.publish``), which the live ``/ws/alerts`` socket already
  broadcasts — so the browser gets the push over the transport that exists, with
  NO new socket. The ontology object is the durable, acknowledgeable record; the
  bus push is the live notification.

Everything degrades gracefully: a per-session evaluation that raises (store
unavailable / unconfigured) is isolated so one bad session can't stall the loop,
and the module imports with no side effects so boot never depends on a live DB.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.config import Settings, get_settings
from app.correlate.bus import bus
from app.correlate.types import Alert
from app.intel import incidents
from app.intel.geo import NM_TO_KM, feature_lonlat, haversine_km
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx, _client, _headers

log = logging.getLogger("velocity.watch")

# How often the evaluator sweeps every active session's rules against the warm
# snapshot. Watchlist alerting is a "did something cross a line" question, not a
# motion-smoothness one, so a relaxed cadence is plenty and keeps the per-user
# PostgREST reads (one rules fetch + N upserts) light. Kept well above the ADS-B
# 1-2 s cadence on purpose — this is not on the render path.
_EVAL_CYCLE_S = 15.0

# Map an ``alert_rules`` kind (routes/alert_rules.py KINDS) to how we detect a
# matching signal in the warm picture. ``signal`` kinds come from the per-feature
# aircraft snapshot; ``incident`` is satisfied by an overlapping incident from the
# brief (which already fuses dark-vessel / quake / etc.). Keeping the mapping here
# (not scattered) keeps the evaluator honest about WHICH live source backs a kind.
_KIND_SOURCES: dict[str, str] = {
    "military_air": "aircraft",
    "military_vessel": "vessel",  # warship (ITU type 35/55) on the warm AIS snapshot
    "jamming": "aircraft",  # GNSS-degraded aircraft = the jamming proxy on the snapshot
    "incident": "incident",
    "dark_vessel": "incident",  # surfaced via the brief's dark-vessel domain
    "quake": "incident",
    "fire": "incident",
    # Phase-2 behavioral kinds computed from the position-history store.
    "ais_gap": "history",
    "rendezvous": "history",
    "loiter": "history",
}

# Severity word → the 1..5 scale alert_rules.min_severity uses, so a rule's
# numeric threshold can gate a brief's worded threat level.
_SEV_RANK: dict[str, int] = {"info": 1, "low": 1, "medium": 3, "high": 4, "critical": 5}


# ── active-session registry ────────────────────────────────────────────────────
# A background loop has no per-request token; an authed transport hands us one.


_SESSIONS: dict[str, UserCtx] = {}


def register_session(ctx: UserCtx) -> None:
    """Make ``ctx`` (a signed-in user's id+token) visible to the evaluator.

    Idempotent on ``user_id`` — re-registering refreshes the stored token (tokens
    rotate). Call this from an authed entry point (e.g. on ``/ws/alerts`` connect);
    pair with :func:`unregister_session` on disconnect.
    """
    _SESSIONS[ctx.user_id] = ctx


def unregister_session(user_id: str) -> None:
    """Drop a user's session so the evaluator stops reading their rules."""
    _SESSIONS.pop(user_id, None)


def active_sessions() -> list[UserCtx]:
    return list(_SESSIONS.values())


# ── per-(rule, entity) membership state ─────────────────────────────────────────
# Held in memory so we fire on the geofence TRANSITION, not every tick.


@dataclass
class _WatchState:
    # (rule_id, entity_id) → currently-inside? — the prior membership we diff.
    inside: dict[tuple[str, str], bool] = field(default_factory=dict)


_STATE = _WatchState()


def reset_state() -> None:
    """Clear membership memory (test isolation / a fresh evaluator)."""
    _STATE.inside.clear()


# ── pure helpers (no I/O — unit-tested directly) ────────────────────────────────


def _radius_km(radius_nm: float) -> float:
    return float(radius_nm) * NM_TO_KM


def within_geofence(rule: dict[str, Any], lon: float, lat: float) -> bool:
    """True if (lon, lat) is inside the rule's AOI circle.

    ``haversine_km`` is **lon-first** (geo.py) — passing lat-first would mirror the
    AOI across the diagonal, so the order here is load-bearing.
    """
    return haversine_km(rule["lon"], rule["lat"], lon, lat) <= _radius_km(
        rule.get("radius_nm", 50)
    )


def _meets_severity(rule: dict[str, Any], severity_rank: int) -> bool:
    return severity_rank >= int(rule.get("min_severity", 1) or 1)


@dataclass
class _Candidate:
    """One thing a rule could trip on: a located signal with a kind + severity."""

    entity_id: str
    kind: str  # an alert_rules KIND (military_air|jamming|incident|...)
    lon: float
    lat: float
    severity_rank: int
    summary: str
    ref: dict[str, Any] = field(default_factory=dict)


def candidates_from_snapshot(features: list[dict[str, Any]]) -> list[_Candidate]:
    """Per-aircraft signals (military air + GNSS-degraded 'jamming' proxy).

    Mirrors ``geo.aircraft_category`` / ``analytics._gnss_degraded`` so the kinds
    line up with what the operator sees on the globe. Vessel/quake/fire kinds are
    delivered via the incident path (the brief already fuses them).
    """
    from app.intel.analytics import _gnss_degraded  # noqa: PLC0415
    from app.intel.geo import aircraft_category  # noqa: PLC0415

    out: list[_Candidate] = []
    for f in features:
        ll = feature_lonlat(f)
        if ll is None:
            continue
        p = f.get("properties") or {}
        icao = p.get("icao24")
        ident = p.get("callsign") or icao or "?"
        eid = f"aircraft:{icao}" if icao else f"aircraft:{ident}"
        cat = aircraft_category(p)
        if cat == "military" or p.get("source") == "adsb_mil":
            out.append(
                _Candidate(eid, "military_air", ll[0], ll[1], 3,
                           f"military contact {ident}", {"icao24": icao})
            )
        if _gnss_degraded(p):
            out.append(
                _Candidate(eid, "jamming", ll[0], ll[1], 3,
                           f"{ident} GNSS-degraded (possible jamming)", {"icao24": icao})
            )
    return out


def candidates_from_vessels(features: list[dict[str, Any]]) -> list[_Candidate]:
    """Military-vessel signals from the warm AIS snapshot.

    A warship (ITU ship-type 35 / 55 → ``geo.vessel_category == 'military'``) inside
    a rule's AOI is a ``military_vessel`` detection — the surface-fleet analogue of
    the aircraft ``military_air`` kind. Read from the SAME warm vessel snapshot the
    maritime layer serves (``maritime.vessel_snapshot``), so it adds no upstream
    load. Non-military ships produce nothing here (dark/loiter/rendezvous vessel
    signals ride the brief + history paths).
    """
    from app.intel.geo import vessel_category  # noqa: PLC0415

    out: list[_Candidate] = []
    for f in features:
        ll = feature_lonlat(f)
        if ll is None:
            continue
        p = f.get("properties") or {}
        if vessel_category(p.get("shipType")) != "military":
            continue
        mmsi = p.get("mmsi") or f.get("id")
        ident = p.get("name") or mmsi or "?"
        eid = f"vessel:{mmsi}" if mmsi else f"vessel:{ident}"
        out.append(
            _Candidate(eid, "military_vessel", ll[0], ll[1], 3,
                       f"military vessel {ident}", {"mmsi": mmsi})
        )
    return out


def candidates_from_brief(brief_result: dict[str, Any]) -> list[_Candidate]:
    """Incident-class signals from the fused brief.

    Each incident becomes a candidate at its centroid; its threat level sets the
    severity rank. ``incident`` matches any incident; ``dark_vessel``/``quake``/
    ``fire`` match an incident whose ``domains`` carry that signal class, so a
    kind-scoped rule only fires on a relevant incident.
    """
    out: list[_Candidate] = []
    for inc in brief_result.get("incidents") or []:
        c = inc.get("centroid") or {}
        lon, lat = c.get("lon"), c.get("lat")
        if lon is None or lat is None:
            continue
        rank = _SEV_RANK.get(str(inc.get("threat_level")), 3)
        iid = f"incident:{inc.get('id')}" if inc.get("id") else f"incident:{uuid.uuid4().hex[:10]}"
        domains = set(inc.get("domains") or [])
        narrative = inc.get("narrative") or "incident"
        # The generic 'incident' kind always matches.
        out.append(_Candidate(iid, "incident", float(lon), float(lat), rank, narrative,
                              {"domains": sorted(domains)}))
        # Domain-scoped kinds: only when that domain is present in the incident.
        if "dark-vessel" in domains:
            out.append(_Candidate(iid, "dark_vessel", float(lon), float(lat), rank,
                                  narrative, {"domains": sorted(domains)}))
        if "quake" in domains:
            out.append(_Candidate(iid, "quake", float(lon), float(lat), rank,
                                  narrative, {"domains": sorted(domains)}))
        if "event" in domains:
            # FIRMS/EONET-style geocoded events ride the 'event' domain; surface
            # them to a 'fire' watch (the brief doesn't separate fire vs event).
            out.append(_Candidate(iid, "fire", float(lon), float(lat), rank,
                                  narrative, {"domains": sorted(domains)}))
    return out


def candidates_from_tracks(
    tracks: list[dict[str, Any]],
    now: float,
    *,
    gap_seconds: float = 1800.0,
    rendezvous_nm: float = 0.5,
    loiter_radius_nm: float = 0.5,
    loiter_dwell_s: float = 1800.0,
) -> list[_Candidate]:
    """Behavioral candidates from the position-history store (Phase 2).

    Global (AOI-agnostic) — ``evaluate_rules`` scopes each to a rule's AOI via
    ``within_geofence``, exactly like the snapshot / brief candidates. Covers
    ``ais_gap`` (transponder went dark), ``rendezvous`` (two vessels close), and
    ``loiter`` (a vessel holding station). The detection math lives in
    ``intel/detectors.py`` (unit-tested); this only adapts hits to ``_Candidate``.
    """
    from app.intel import detectors  # noqa: PLC0415

    out: list[_Candidate] = []
    for h in detectors.ais_gap(tracks, now=now, gap_seconds=gap_seconds):
        mins = int(h["age_s"] // 60)
        out.append(_Candidate(str(h["id"]), "ais_gap", h["lon"], h["lat"], 3,
                              f"{h['id']} AIS-dark {mins} min", {"age_s": h["age_s"]}))

    last_pos = {
        str(t.get("id")): (t["points"][-1][0], t["points"][-1][1])
        for t in tracks if t.get("points")
    }
    for h in detectors.proximity(tracks, max_nm=rendezvous_nm):
        pos = last_pos.get(str(h["a"]))
        if pos is None:
            continue
        out.append(_Candidate(str(h["a"]), "rendezvous", pos[0], pos[1], 3,
                              f"rendezvous {h['a']} <-> {h['b']} ({h['nm']} nm)",
                              {"partner": h["b"], "nm": h["nm"]}))

    for t in tracks:
        hit = detectors.loiter(t, radius_nm=loiter_radius_nm,
                               dwell_seconds=loiter_dwell_s, now=now)
        if hit:
            out.append(_Candidate(str(hit["id"]), "loiter", hit["lon"], hit["lat"], 2,
                                  f"{hit['id']} loitering", {"dwell_s": hit["dwell_s"]}))
    return out


def alert_object(
    rule: dict[str, Any], cand: _Candidate, transition: str, ts: str
) -> Object:
    """Shape the persistent, acknowledgeable Alert ontology object.

    ``kind='alert'`` (an analyst-created node, so it falls into the ontology's
    catch-all ``object`` kind — but we tag the semantic kind in props so a query
    can filter ``props.kind == 'alert'``). ``state`` is the acknowledgement
    lifecycle: a freshly-fired alert is ``open``; an analyst later moves it to
    ``ack`` / ``closed`` (via a future action — the field is here so the record is
    acknowledgeable from birth). The id is deterministic-ish per firing so repeated
    enters within one membership episode upsert the SAME row rather than spawning
    duplicates.
    """
    alert_id = f"alert:{rule.get('id')}:{cand.entity_id}:{transition}"
    return Object(
        id=alert_id,
        kind="object",
        props={
            "kind": "alert",
            "state": "open",
            "rule_id": rule.get("id"),
            "rule_label": rule.get("label"),
            "transition": transition,  # 'enter' | 'exit'
            "watch_kind": cand.kind,
            "entity_id": cand.entity_id,
            "severity": cand.severity_rank,
            "lon": round(cand.lon, 4),
            "lat": round(cand.lat, 4),
            "message": _alert_message(rule, cand, transition),
            "fired_at": ts,
        },
    )


def risk_indicator(rule: dict[str, Any], cand: _Candidate, ts: str) -> dict[str, Any]:
    """The RiskIndicator cached onto the triggering entity's object props.

    A compact 'why this entity is hot' badge — the watch that tripped, its kind,
    the severity, and when. Cached on the entity (not just the alert) so the
    EntityPanel / a traversal sees the risk without joining back through links.
    """
    return {
        "rule_id": rule.get("id"),
        "rule_label": rule.get("label"),
        "kind": cand.kind,
        "severity": cand.severity_rank,
        "reason": _alert_message(rule, cand, "enter"),
        "at": ts,
    }


def _alert_message(rule: dict[str, Any], cand: _Candidate, transition: str) -> str:
    verb = "entered" if transition == "enter" else "left"
    label = rule.get("label") or "watch area"
    return f"{cand.summary} {verb} {label}"


def _severity_word(rank: int) -> str:
    """Map a 1..5 severity rank to the worded scale the alert UI groups by."""
    return next(
        (w for w, r in (("critical", 5), ("high", 4), ("medium", 3), ("low", 1))
         if rank >= r),
        "low",
    )


def _to_bus_alert(rule: dict[str, Any], cand: _Candidate, transition: str) -> Alert:
    """Adapt a firing to the ``correlate.types.Alert`` the /ws/alerts bus pushes."""
    return Alert(
        id=uuid.uuid4().hex[:12],
        rule_id=f"watch:{rule.get('id')}",
        severity=_severity_word(cand.severity_rank),  # type: ignore[arg-type]
        t=time.time(),
        lon=cand.lon,
        lat=cand.lat,
        confidence=0.9,
        message=_alert_message(rule, cand, transition),
        contributing=[cand.entity_id],
    )


# ── core evaluation (pure given the snapshot + brief + rules) ───────────────────


def evaluate_rules(
    rules: list[dict[str, Any]], candidates: list[_Candidate]
) -> list[tuple[dict[str, Any], _Candidate, str]]:
    """Diff geofence membership and return the (rule, candidate, transition) firings.

    Pure + synchronous: takes already-fetched rules + already-gathered candidates,
    mutates ``_STATE.inside`` to remember membership, and returns ENTER firings (a
    contact that was outside/unseen is now inside the AOI, kind-matched, meeting the
    severity floor) and EXIT firings (a previously-inside contact has left). This is
    where the no-spam transition logic lives, isolated for hermetic tests.
    """
    firings: list[tuple[dict[str, Any], _Candidate, str]] = []
    # Only consider enabled rules; an empty/None kinds list means "any kind".
    active = [r for r in rules if r.get("enabled", True)]
    # Track which (rule, entity) pairs we observed this sweep so a contact that
    # simply vanished from the feed doesn't get a phantom exit (only an in-feed
    # crossing out of the circle counts).
    for r in active:
        rid = r.get("id")
        want = set(r.get("kinds") or [])  # empty → match any kind
        for cand in candidates:
            if want and cand.kind not in want:
                continue
            key = (str(rid), cand.entity_id)
            was_inside = _STATE.inside.get(key, False)
            now_inside = within_geofence(r, cand.lon, cand.lat)
            if now_inside and not was_inside:
                _STATE.inside[key] = True
                if _meets_severity(r, cand.severity_rank):
                    firings.append((r, cand, "enter"))
            elif was_inside and not now_inside:
                # Drop the key rather than store False: get(key, False) already
                # treats an absent key as "outside", so this is equivalent state but
                # bounds _STATE.inside to entities CURRENTLY inside a geofence — a
                # False entry per distinct entity that ever transited grows forever.
                _STATE.inside.pop(key, None)
                firings.append((r, cand, "exit"))
    return firings


# ── LEVEL view: what is inside the AOIs RIGHT NOW (consistent across reloads) ────
# The /ws/alerts stream is EDGE-triggered — it pushes a contact CROSSING into an
# AOI, once. The "Standing detections" panel asks a LEVEL question instead: what is
# present in my watch areas now? Answering it off the edge stream made the panel
# flaky (it looked alive only right after a contact crossed in, or after a fresh
# tab replayed the recent-edge backfill, then went quiet while contacts simply sat
# inside). This recomputes the full qualifying-inside set from scratch each call —
# no membership state, no edge dependency — so a contact sitting in an AOI shows on
# EVERY poll. Same kind-scope + severity-floor matching as evaluate_rules, so edge
# and level never disagree about WHAT matches.


# The shared candidate set from the most recent sweep, cached so a level read
# (``/api/alerts/standing``) reuses the picture the sweep already gathered instead
# of re-fetching the snapshot/brief/vessels per request.
_LAST_CANDIDATES: list[_Candidate] = []
_CANDIDATES_TS: float = 0.0


def current_candidates() -> list[_Candidate]:
    return list(_LAST_CANDIDATES)


def candidates_as_of() -> int:
    return int(_CANDIDATES_TS)


def standing_detections(
    rules: list[dict[str, Any]], candidates: list[_Candidate]
) -> list[dict[str, Any]]:
    """Every qualifying contact currently inside an enabled rule's AOI (level)."""
    out: list[dict[str, Any]] = []
    for r in rules:
        if not r.get("enabled", True):
            continue
        want = set(r.get("kinds") or [])  # empty → match any kind
        for cand in candidates:
            if want and cand.kind not in want:
                continue
            if not _meets_severity(r, cand.severity_rank):
                continue
            if not within_geofence(r, cand.lon, cand.lat):
                continue
            out.append({
                "rule_id": r.get("id"),
                "rule_label": r.get("label"),
                "kind": cand.kind,
                "entity_id": cand.entity_id,
                "severity": cand.severity_rank,
                "severity_word": _severity_word(cand.severity_rank),
                "summary": cand.summary,
                "lon": round(cand.lon, 4),
                "lat": round(cand.lat, 4),
            })
    return out


# ── persistence (per-session, RLS-scoped) ───────────────────────────────────────


async def _list_enabled_rules(ctx: UserCtx, s: Settings) -> list[dict[str, Any]]:
    """Fetch a user's enabled alert_rules exactly as routes/alert_rules.py does.

    On a keyless boot (``supabase_url`` unset — the same predicate
    ``routes/alert_rules.py::_use_local`` uses) rules live in the local SQLite
    store (``intel/alert_rules_local.py``) instead of Supabase PostgREST, so a
    self-hosted operator's watch rule is reachable with no cloud project.
    Never raises: a bad/unavailable store degrades to ``[]`` so one flaky
    session can't stall the sweep.
    """
    if not s.supabase_url:
        from app.intel import alert_rules_local  # noqa: PLC0415

        try:
            return await alert_rules_local.list_rules(
                ctx.user_id, enabled_only=True, settings=s
            )
        except Exception:  # noqa: BLE001
            return []
    url = s.supabase_url.rstrip("/") + "/rest/v1/alert_rules"
    try:
        async with _client() as c:
            r = await c.get(
                url,
                params={
                    "user_id": f"eq.{ctx.user_id}",
                    "enabled": "eq.true",
                    "select": "*",
                },
                headers=_headers(ctx, s),
            )
        if r.status_code != 200:
            return []
        rows = r.json()
        return rows if isinstance(rows, list) else []
    except Exception:  # noqa: BLE001 — a flaky store must not kill the loop
        return []


async def _persist_firing(
    reg: Any, rule: dict[str, Any], cand: _Candidate, transition: str
) -> None:
    """Upsert the Alert object and (on enter) cache the RiskIndicator on the entity.

    Best-effort: a store error for one firing is logged and swallowed so the rest
    of the sweep still lands.
    """
    ts = _now_iso()
    try:
        await reg.upsert(alert_object(rule, cand, transition, ts))
        if transition == "enter":
            # Mint/refresh the triggering entity as a durable object (Move 1),
            # stamping the WATCH RULE as the provenance source. assert_props MERGES
            # (no read + wholesale upsert) and records an evidenced assertion, so
            # the trail shows the geofence that tripped rather than a generic
            # "analyst" write — a rule minted this, not a person.
            await reg.assert_props(
                cand.entity_id,
                {
                    "risk_indicator": risk_indicator(rule, cand, ts),
                    "lon": round(cand.lon, 4),
                    "lat": round(cand.lat, 4),
                },
                source=f"rule:watchbox:{rule.get('id')}",
                confidence=1.0,
                observed_at=ts,
            )
    except Exception as exc:  # noqa: BLE001
        log.debug("watch: persist firing failed (%s): %s", cand.entity_id, exc)


async def evaluate_session(
    ctx: UserCtx,
    s: Settings,
    candidates: list[_Candidate],
) -> int:
    """Evaluate one user's enabled rules against the shared candidates.

    Returns the number of firings persisted (for tests / metrics). Isolated so a
    single user's store failure never propagates to the loop.
    """
    rules = await _list_enabled_rules(ctx, s)
    if not rules:
        return 0
    firings = evaluate_rules(rules, candidates)
    if not firings:
        return 0
    reg = get_registry(ctx, s)
    fired = 0
    for rule, cand, transition in firings:
        await _persist_firing(reg, rule, cand, transition)
        await _maybe_cue(reg, rule, cand, transition)
        await _deliver_sinks(rule, cand, transition)
        # Reuse the EXISTING /ws/alerts transport: publish onto the bus the live
        # socket already broadcasts. Enters and exits both notify.
        try:
            bus.publish(_to_bus_alert(rule, cand, transition))
        except Exception:  # noqa: BLE001
            pass
        fired += 1
    return fired


async def _deliver_sinks(
    rule: dict[str, Any], cand: _Candidate, transition: str
) -> None:
    """Push a firing to the rule's configured out-of-band sink — a Discord
    webhook or a generic ``webhook`` URL (``routes/alert_rules.py`` CHANNELS) —
    and log the attempt, so "did my alert reach my phone" is answerable with no
    browser attached to the evaluator (W3, docs/decisions.md 2026-07-11).

    Reuses ``workflows/control.py``'s IPv4-pinned, never-raising HTTP
    primitive (``send``) rather than the Workflows-block-only ``dispatch``
    wrapper — there is no preview/dry-run or per-run dispatch budget concept
    here, just "deliver this notification the operator asked for." A bad or
    unreachable sink is isolated (logged, not raised) so it can never stall the
    sweep, mirroring ``_persist_firing`` / ``_maybe_cue``.
    """
    channel = rule.get("channel")
    url = str(rule.get("sink_url") or "").strip()
    if channel not in ("discord", "webhook") or not url:
        return

    from app.intel import alert_rules_local  # noqa: PLC0415
    from app.workflows import control  # noqa: PLC0415

    ts = _now_iso()
    message = _alert_message(rule, cand, transition)
    rule_id = str(rule.get("id"))

    try:
        control.check_url(url)
    except Exception as exc:  # noqa: BLE001 — bad sink config, log + stop
        await alert_rules_local.record_delivery(
            rule_id=rule_id, entity_id=cand.entity_id, transition=transition,
            channel=channel, target=url, ok=False, status=None,
            error=str(exc), message=message,
        )
        return

    if channel == "discord":
        # Discord's incoming-webhook contract: a plain {"content": <text>} post.
        body: dict[str, Any] = {"content": f"[{rule.get('label') or 'watch'}] {message}"}
    else:
        obj = alert_object(rule, cand, transition, ts)
        body = {"type": "watch.alert", **obj.props}

    try:
        res = await control.send(
            "POST", url, headers={"content-type": "application/json"},
            json_body=body, timeout_s=10.0,
        )
        ok = res.error is None and (res.status is not None and res.status < 400)
        await alert_rules_local.record_delivery(
            rule_id=rule_id, entity_id=cand.entity_id, transition=transition,
            channel=channel, target=url, ok=ok, status=res.status,
            error=res.error, message=message,
        )
    except Exception as exc:  # noqa: BLE001 — never let a sink failure stall the sweep
        log.debug("watch: sink delivery failed (%s): %s", cand.entity_id, exc)
        await alert_rules_local.record_delivery(
            rule_id=rule_id, entity_id=cand.entity_id, transition=transition,
            channel=channel, target=url, ok=False, status=None,
            error=str(exc), message=message,
        )


async def _maybe_cue(
    reg: Any, rule: dict[str, Any], cand: _Candidate, transition: str
) -> None:
    """Tip-and-cue: a dark-zone ENTER triggers an open-source SAR look, and the
    result is attached to the alert object (``props.cue``). Best-effort — a cue
    failure (e.g. missing CDSE creds) is recorded as a status, never raised."""
    from app.intel import cue  # noqa: PLC0415

    if transition != "enter" or cand.kind not in cue.CUE_KINDS:
        return
    try:
        result = await cue.run(cand.lon, cand.lat)
        obj = alert_object(rule, cand, transition, _now_iso())
        obj.props["cue"] = result
        await reg.upsert(obj)
    except Exception as exc:  # noqa: BLE001
        log.debug("watch: cue failed (%s): %s", cand.entity_id, exc)


async def evaluate_all() -> int:
    """One full sweep across every active session. Returns total firings.

    Gathers the warm snapshot + brief ONCE and shares the candidate set across all
    sessions (the picture is global; only the rules are per-user), so N sessions
    cost one snapshot + one brief, not N.
    """
    sessions = active_sessions()
    s = get_settings()
    if not sessions:
        if s.supabase_url:
            return 0  # no browser registered a token → nothing to read, no work
        # Keyless boot: there is no WS session and no Supabase token to forge,
        # but a locally-stored rule (intel/alert_rules_local.py) still deserves
        # to fire with no browser open (W3, docs/decisions.md 2026-07-11).
        # Cheaply probe the local store first so the zero-rule case (the vast
        # majority of ticks on a fresh install) stays a single fast SQLite read
        # and never touches a snapshot/brief — same cost as the old no-op.
        local_rules = await _list_enabled_rules(UserCtx("local", ""), s)
        if not local_rules:
            return 0
        sessions = [UserCtx("local", "")]

    from app.routes.adsb import global_snapshot  # noqa: PLC0415

    try:
        fc = await global_snapshot()
        features = list(fc.get("features") or [])
    except Exception:  # noqa: BLE001
        features = []
    try:
        brief_result = await incidents.brief()
    except Exception:  # noqa: BLE001
        brief_result = {"incidents": []}

    candidates = candidates_from_snapshot(features) + candidates_from_brief(brief_result)

    # Military surface vessels from the warm AIS snapshot (read, don't fetch — the
    # maritime layer already keeps this store hot). Wrapped so an AIS hiccup never
    # stalls the sweep.
    try:
        from app.routes import maritime  # noqa: PLC0415

        vfeats = list(maritime.vessel_snapshot().get("features") or [])
        candidates += candidates_from_vessels(vfeats)
    except Exception:  # noqa: BLE001
        pass

    # Phase 2: behavioral candidates from the position-history store (ais_gap /
    # rendezvous / loiter). Wrapped so a history hiccup never stalls the sweep.
    from app import history  # noqa: PLC0415

    try:
        now = time.time()
        tr = await history.query_tracks(
            "vessel", None, now - 6 * 3600, now + 1, limit_ids=3000, max_points_per_id=200
        )
        candidates += candidates_from_tracks(tr.get("tracks") or [], now)
    except Exception:  # noqa: BLE001
        pass

    # Cache the assembled picture so a level read (/api/alerts/standing) reuses it.
    global _LAST_CANDIDATES, _CANDIDATES_TS
    _LAST_CANDIDATES = candidates
    _CANDIDATES_TS = time.time()

    total = 0
    for ctx in sessions:
        try:
            total += await evaluate_session(ctx, s, candidates)
        except Exception as exc:  # noqa: BLE001 — isolate one bad session
            log.debug("watch: session %s failed: %s", ctx.user_id, exc)
    return total


# ── background task lifecycle (mirrors adsb.start_snapshot / stop_snapshot) ──────


_TASK: asyncio.Task[None] | None = None
_STARTED = False


async def _run_forever() -> None:
    while True:
        try:
            await evaluate_all()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            log.debug("watch: sweep error: %s", exc)
        await asyncio.sleep(_EVAL_CYCLE_S)


async def start() -> None:
    """Start the geofence evaluator loop (idempotent).

    Mirrors ``adsb.start_snapshot()``: safe to call once from the app lifespan.
    With no registered sessions it idles cheaply, so starting it at boot is free
    even before any user connects (and is a no-op for coverage when Supabase is
    unset, since no session is ever registered).
    """
    global _TASK, _STARTED
    if _STARTED:
        return
    _STARTED = True
    _TASK = asyncio.create_task(_run_forever())


async def stop() -> None:
    """Cancel the evaluator loop and clear state (clean shutdown / test isolation)."""
    global _TASK, _STARTED
    _STARTED = False
    if _TASK is not None:
        _TASK.cancel()
        try:
            await _TASK
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _TASK = None
    _SESSIONS.clear()
    reset_state()


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
