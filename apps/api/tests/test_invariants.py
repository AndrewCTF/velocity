"""Executable guards for operator-decided invariants (see CLAUDE.md, docs/decisions.md).

Prose invariants decay; these fail loud instead. A failure means a sacred
behavior regressed — fix the code, or revoke the decision deliberately by
changing BOTH the test and CLAUDE.md.
"""

from __future__ import annotations

import inspect
import os
import pathlib
import re

import pytest

APP = pathlib.Path(__file__).resolve().parents[1] / "app"


def test_upstream_burst_semaphore_is_8() -> None:
    # Decision (airplanes.live post-mortem): >8 concurrent /v2/point calls get
    # rate-limited with HTTP 200 + text/plain bodies. Do not raise this.
    src = (APP / "routes" / "adsb.py").read_text()
    assert re.search(r"_UPSTREAM_SEMAPHORE\s*=\s*asyncio\.Semaphore\(8\)", src), (
        "_UPSTREAM_SEMAPHORE must stay asyncio.Semaphore(8)"
    )


def test_internal_consumers_use_global_snapshot_not_route_handler() -> None:
    # Decision (jamming-layer 500 post-mortem): calling the adsb_global()
    # route handler in-process passes Query defaults into viewport_filter and
    # 500s. Internal consumers must call global_snapshot().
    offenders: list[str] = []
    for path in APP.rglob("*.py"):
        if path.parent.name == "routes" and path.name == "adsb.py":
            continue
        text = path.read_text()
        for match in re.finditer(r"adsb_global\s*\(", text):
            if match.start() > 0 and text[match.start() - 1] == "`":
                continue  # docstring mention (``adsb_global()``), not a call
            line = text[: match.start()].count("\n") + 1
            offenders.append(f"{path.relative_to(APP)}:{line}")
    assert not offenders, f"call global_snapshot(), not adsb_global(): {offenders}"


def test_celestrak_requests_tle_format() -> None:
    # Decision: CelesTrak OMM JSON omits TLE_LINE1/2, which the client SGP4
    # parser requires — FORMAT=json renders ZERO satellites.
    src = (APP / "routes" / "space.py").read_text()
    assert '"FORMAT": "tle"' in src


def test_sidecar_children_scrub_jemalloc_env() -> None:
    # Decision (2026-07-04 post-mortem): run-api.sh's LD_PRELOAD inherited into
    # headless Chrome kills the zygote -> sidecar serves 0 aircraft.
    for name in ("adsb_sidecar.py", "ais_sidecar.py"):
        src = (APP / name).read_text()
        assert "LD_PRELOAD" in src, f"{name} must scrub LD_PRELOAD from child env"


@pytest.mark.skipif(
    not os.environ.get("OSINT_LIVE_PROBE"),
    reason="live probe: set OSINT_LIVE_PROBE=1 with the backend on :8000",
)
def test_global_snapshot_floor_live() -> None:
    # Decision: the global snapshot must carry >=8000 aircraft in steady state
    # (~13k normal). A drop to hundreds is a feed regression, not noise.
    import httpx

    headers = {}
    if os.environ.get("OSINT_PROBE_KEY"):
        headers["X-API-Key"] = os.environ["OSINT_PROBE_KEY"]
    resp = httpx.get(
        "http://127.0.0.1:8000/api/adsb/global",
        params={"limit": 20000},
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    count = len(resp.json().get("features", []))
    assert count >= 8000, f"snapshot regression: {count} aircraft (< 8000 floor)"


# ── news bias-verification ensemble (Track A7) ──────────────────────────────


def test_news_verifier_calls_pin_local_model() -> None:
    # Decision (verify.py module docstring): a lone "flag" only earns a repair
    # pass from the ORIGINAL drafting model (cloud/reason tier), never from a
    # local verifier — so the verifier chat_json call must pin local_model_key,
    # and the repair call must NOT (letting it fall through to the normal
    # tier/prefer_local/cloud ladder).
    from app.news import verify

    verifier_src = inspect.getsource(verify._call_verifier)
    assert "local_model_key=key" in verifier_src, (
        "_call_verifier must pin local_model_key=key on its chat_json call"
    )

    repair_src = inspect.getsource(verify._repair_story)
    assert "local_model_key=" not in repair_src, (
        "_repair_story must not pin local_model_key= — it runs on the drafting model"
    )


def test_llm_local_model_key_never_falls_back_to_cloud() -> None:
    # Decision (llm.chat docstring): local_model_key targets one specific
    # installed llama.cpp model by key (the news-verification ensemble) and
    # must never silently land on Ollama or a cloud backend — a verifier
    # response from the WRONG model would corrupt the ensemble's agreement
    # count. Assert the branch's source contains no path to any other backend.
    from app import llm

    src = inspect.getsource(llm._run_chat)
    start = src.index("if local_model_key is not None:")
    end = src.index("# `fast=True`", start)
    branch = src[start:end]
    for forbidden in ("_deepseek_chat(", "_minimax_chat(", "_ollama_chat(", "_try_ollama("):
        assert forbidden not in branch, (
            f"local_model_key branch in _run_chat must never reach {forbidden}"
        )


def test_feeds_register_floor() -> None:
    # Decision (feeds_register.py module docstring): the expanded categorized
    # register is the corroboration-diversity substrate the debias engine
    # reasons over. A regression here silently shrinks source diversity.
    from app.news import feeds_register

    assert len(feeds_register.REGISTER) >= 100, (
        f"feeds_register.REGISTER shrank to {len(feeds_register.REGISTER)} (< 100 floor)"
    )
    allowed_buckets = {"left", "center", "right", "state", "wire"}
    assert set(feeds_register.LEANING_BUCKETS.values()) <= allowed_buckets, (
        "LEANING_BUCKETS must only bucket into left/center/right/state/wire"
    )
    missing = sorted(
        {s.leaning for s in feeds_register.REGISTER} - set(feeds_register.LEANING_BUCKETS)
    )
    assert not missing, f"REGISTER leaning(s) with no LEANING_BUCKETS entry: {missing}"


def _routes_news_source() -> str:
    from app.routes import news as news_routes

    return inspect.getsource(news_routes)


_NEWS_ROUTES_SRC = _routes_news_source()


@pytest.mark.skipif(
    "verify_edition" not in _NEWS_ROUTES_SRC or "append_snapshot" not in _NEWS_ROUTES_SRC,
    reason=(
        "armed-pending: routes/news.py doesn't reference verify_edition/"
        "append_snapshot yet (lands with the verify+persist wiring task)"
    ),
)
def test_news_refresher_persists_after_verify() -> None:
    # Once wired, refresh_once() must run the edition back through the local
    # bias-verifier ensemble BEFORE persisting the snapshot to history — a
    # persisted-then-verified order would let a later "contested" revision
    # silently diverge from what was written to history.
    assert _NEWS_ROUTES_SRC.index("verify_edition") < _NEWS_ROUTES_SRC.index("append_snapshot"), (
        "refresh_once() must call verify_edition() before append_snapshot()"
    )


# ── Country Instability Index (CII, Phase C) ────────────────────────────────


def test_cii_weights_sum_to_one() -> None:
    # Decision (instability.py module docstring): COMPONENT_WEIGHTS is the
    # weight table BEFORE any per-country renormalization for missing
    # sources — it must sum to exactly 1.0 or every score is silently
    # mis-scaled even in the all-sources-present case.
    from app.intel.instability import COMPONENT_WEIGHTS

    total = sum(COMPONENT_WEIGHTS.values())
    assert total == pytest.approx(1.0), f"CII COMPONENT_WEIGHTS sum to {total}, not 1.0"


def test_instability_never_imports_a_route_handler() -> None:
    # Decision: instability.py may only reuse the LIFTED module-level
    # callables (load_ioda/load_gdacs/load_quakes/advisories_summary/
    # displacement_summary/market_stress/conflict_events/ucdp_events), never
    # a route's HTTP handler in-process (the adsb_global() 500 post-mortem
    # this repo already learned from once).
    src = (APP / "intel" / "instability.py").read_text()
    forbidden_handlers = [
        "ioda_outages",
        "gdacs(",
        "quakes(",
        "advisories(",
        "displacement(",
    ]
    offenders = [name for name in forbidden_handlers if re.search(rf"\b{re.escape(name)}", src)]
    assert not offenders, f"instability.py must not reference route handlers: {offenders}"


def test_instability_score_all_components_carry_inputs() -> None:
    # Every component dict in a score_all() run must carry an `inputs` key
    # (the short evidence list — counts/labels, never a full payload) so a
    # caller can show its work instead of a bare number.
    import asyncio

    from app.intel import instability

    async def _fc(*_a, **_k):
        return {
            "type": "FeatureCollection",
            "features": [{"properties": {"iso3": "TST"}} for _ in range(3)],
        }

    async def _news(*_a, **_k):
        return {
            "payload": {
                "stories": [
                    {"countries": ["TST"], "verification": {"status": "reviewed"}}
                ]
            }
        }

    async def _advisories(*_a, **_k):
        return {"TST": 3}

    async def _displacement(*_a, **_k):
        return {"TST": 5000}

    async def _ioda(*_a, **_k):
        return {"items": [{"entity": {"type": "country", "code": "ZZ"}}], "unavailable": False}

    async def _stress(*_a, **_k):
        return {"score": 20.0, "degraded": False}

    import pytest as _pytest

    mp = _pytest.MonkeyPatch()
    try:
        mp.setattr(instability, "conflict_events", _fc)
        mp.setattr(instability, "ucdp_events", _fc)
        mp.setattr(instability, "news_latest", _news)
        mp.setattr(instability, "advisories_summary", _advisories)
        mp.setattr(instability, "displacement_summary", _displacement)
        mp.setattr(instability, "load_ioda", _ioda)
        mp.setattr(instability, "load_gdacs", _fc)
        mp.setattr(instability, "load_quakes", _fc)
        mp.setattr(instability, "market_stress", _stress)
        rows = asyncio.run(instability.score_all())
    finally:
        mp.undo()

    assert rows, "expected at least one scored country in this canned run"
    for row in rows:
        for component in row["components"]:
            assert "inputs" in component and component["inputs"], (
                f"component {component.get('key')} missing non-empty inputs"
            )


def test_verify_stage_is_background_only() -> None:
    # The local-model verifier ensemble is a background-refresher stage, not a
    # request-path dependency — a route calling verify_edition() directly would
    # put an on-GPU multi-model pass in the request's critical path.
    routes_dir = APP / "routes"
    offenders: list[str] = []
    for path in routes_dir.glob("*.py"):
        if path.name == "news.py":
            continue
        text = path.read_text()
        if "verify_edition" in text:
            offenders.append(path.name)
    assert not offenders, f"only routes/news.py may reference verify_edition: {offenders}"


def test_unmatched_api_path_returns_json_404_not_spa() -> None:
    # Decision: the SPA static-file fallback (main.py _SPAStaticFiles) is
    # mounted LAST at "/" so client routes like /2d or /studio 404 into
    # index.html. That same catch-all once silently 200'd an unwired or
    # typo'd /api/* route with the HTML shell instead of a JSON 404 -- it
    # masked the instability router never being include_router'd. An
    # unmatched /api/ (or /ws/) path must re-raise as a real 404; a
    # non-api client route must still fall back to index.html 200.
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        api_resp = client.get("/api/definitely-not-a-route")
        assert api_resp.status_code == 404, (
            f"unmatched /api/* path must 404, got {api_resp.status_code}"
        )
        assert "application/json" in api_resp.headers.get("content-type", ""), (
            "unmatched /api/* path must return JSON, not the SPA HTML shell"
        )

        # A stray HTTP GET to a /ws/* path must also 404, not the SPA shell —
        # exercises the startswith("/ws/") half of the fallback guard directly.
        ws_resp = client.get("/ws/definitely-not-a-route")
        assert ws_resp.status_code == 404, (
            f"unmatched /ws/* path must 404, got {ws_resp.status_code}"
        )
        assert "text/html" not in ws_resp.headers.get("content-type", ""), (
            "unmatched /ws/* path must not return the SPA HTML shell"
        )

        root_resp = client.get("/")
        assert root_resp.status_code == 200
        assert "text/html" in root_resp.headers.get("content-type", "")

        client_route_resp = client.get("/client/route")
        assert client_route_resp.status_code == 200, (
            "a non-api client route must still SPA-fallback to index.html"
        )
        assert "text/html" in client_route_resp.headers.get("content-type", "")


def test_unmatched_ws_upgrade_is_denied_not_500() -> None:
    # Decision: a genuine WebSocket-upgrade request to an unmatched /ws/* path
    # falls through to the same SPA static-file mount as the plain-GET case
    # above, but in websocket scope, not http scope. Starlette's StaticFiles
    # asserts scope["type"] == "http" and raises an uncaught AssertionError
    # for anything else, which surfaced as a bare HTTP 500 to a real client.
    # _SPAStaticFiles must intercept websocket scope before StaticFiles ever
    # sees it and deny the handshake cleanly. TestClient advertises the
    # Websocket Denial Response extension, so a clean denial here raises
    # WebSocketDenialResponse (a 404), never an AssertionError/500 and never
    # a silent accept.
    from fastapi.testclient import TestClient
    from starlette.testclient import WebSocketDenialResponse

    from app.main import create_app

    # A fresh app instance, not the module-level singleton the sibling test
    # above uses — its MCP streamable-HTTP session manager can only run()
    # once per instance, and that test already spends the singleton's one
    # lifespan cycle.
    with TestClient(create_app()) as client:
        with pytest.raises(WebSocketDenialResponse) as exc_info:
            with client.websocket_connect("/ws/definitely-not-a-route"):
                pass

    assert exc_info.value.status_code == 404, (
        f"unmatched /ws/* upgrade must be denied with 404, got {exc_info.value.status_code}"
    )
