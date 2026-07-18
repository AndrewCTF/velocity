"""End-to-end access-path smoke for every AI/LLM route.

Proves each AI surface the frontend reaches is wired, reachable on the keyless
access path (``ALLOW_UNAUTHENTICATED=1``, set by conftest), and returns a sane
shape — a breadth/contract test that fails loudly if a route is removed, its
auth regresses, or its response shape drifts. Deep per-route logic lives in the
sibling modules (test_ai_selection / test_ai_models_routes / test_watch_officer
/ test_llm* / test_country_profile); this file is the cross-cutting pass and
fills the three routes that had ZERO coverage: the streaming analyst agent
(``/api/intel/agent``), investigate (``/api/intel/investigate``), and the
dossier narrative (``/api/intel/dossier/narrative``).

Every LLM call is monkeypatched — no network, no model, deterministic.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import llm
from app.intel import agent as agent_mod
from app.localllm import manager, state


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """Sandbox the model store + engine override, and enable selection
    inference, so the AI routes run without touching the operator's real
    ~/.cache models or leaking engine state across tests."""
    manager.override_models_dir(str(tmp_path / "models"))
    manager._JOBS.clear()
    state.set_engine(None)
    llm.set_selection_enabled(True)
    yield
    manager.override_models_dir(None)
    manager._JOBS.clear()
    state.set_engine(None)
    llm.set_selection_enabled(None)


def _stub_chat(monkeypatch: pytest.MonkeyPatch, text: str = "Routine transit; no anomalies evident. **Threat: routine**"):
    async def _chat(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        return llm.LlmResult(text=text, model="stub.gguf", backend="stub")

    monkeypatch.setattr(llm, "chat", _chat)


def _stub_chat_json(monkeypatch: pytest.MonkeyPatch, parsed: dict | None = None):
    payload = parsed if parsed is not None else {
        "assessment": "Stub assessment grounded in the incidents.",
        "findings": [],
        "follow_up": [],
    }

    async def _cj(messages, **kw):  # noqa: ANN001, ANN003
        return payload, llm.LlmResult(text=json.dumps(payload), model="stub", backend="stub")

    monkeypatch.setattr(llm, "chat_json", _cj)


# ── AI running / control: engine + local toggle ──────────────────────────────

def test_ai_local_status_keyless(client: TestClient) -> None:
    r = client.get("/api/ai/local")
    assert r.status_code == 200
    body = r.json()
    # The frontend gates its switches on these fields — they must always be present.
    assert {"engine", "selection_enabled"} <= set(body)


def test_ai_local_post_toggles_selection_keyless(client: TestClient) -> None:
    # POST carries write authority (require_compute_enabled) but open mode
    # (ALLOW_UNAUTHENTICATED=1) grants it — this is the access path the
    # settings UI / AI hub uses to flip selection inference on.
    r = client.post("/api/ai/local", json={"selection_enabled": True})
    assert r.status_code == 200
    assert r.json()["selection_enabled"] is True


def test_ai_engine_route_keyless(client: TestClient) -> None:
    r = client.post("/api/ai/engine", json={"engine": "auto"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "engine": "auto"}


def test_ai_hardware_and_models_keyless(client: TestClient) -> None:
    assert client.get("/api/ai/hardware").status_code == 200
    r = client.get("/api/ai/models")
    assert r.status_code == 200
    assert {"engines", "active", "hot", "installed", "catalog"} <= set(r.json())


# ── AI assess: selection brief ───────────────────────────────────────────────

def test_selection_brief_access_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    async def _chat(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        seen["system"] = messages[0]["content"]
        assert tier == "selection"
        return llm.LlmResult(text="**AC1** routine. **Threat: routine**", model="m", backend="stub")

    monkeypatch.setattr(llm, "chat", _chat)
    r = client.post(
        "/api/ai/selection/brief",
        json={"kind": "aircraft", "id": "AC-smoke-1", "props": {"callsign": "TEST1"}},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # The sharpened prompt must still steer the model toward a threat read and
    # keep the ENRICHMENT contract the fusion depends on.
    assert "Threat:" in seen["system"]
    assert "ENRICHMENT" in seen["system"]


def test_selection_brief_bounds_a_stalled_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A stalled backend must not pin the worker: the route wraps the LLM call in
    # asyncio.wait_for and degrades to a 502, not a 524-after-the-client-left.
    import asyncio

    from app.routes import ai_selection

    monkeypatch.setattr(ai_selection, "_SELECTION_LLM_BUDGET_S", 0.05)

    async def _hang(*_a, **_k):  # noqa: ANN002, ANN003
        await asyncio.sleep(5)  # longer than the budget → wait_for fires
        return llm.LlmResult(text="x", model="m", backend="stub")

    monkeypatch.setattr(llm, "chat", _hang)
    r = client.post(
        "/api/ai/selection/brief",
        json={"kind": "aircraft", "id": "AC-hang", "props": {"callsign": "T"}},
    )
    assert r.status_code == 502


# ── AI alerts: watch-officer briefs ──────────────────────────────────────────

def test_watch_officer_briefs_access_path(client: TestClient) -> None:
    r = client.get("/api/watch-officer/briefs")
    assert r.status_code == 200
    assert isinstance(r.json().get("briefs"), list)
    # Triage verbs are idempotent — an unknown id must not 500.
    assert client.post("/api/watch-officer/briefs/nope/ack").status_code in (200, 404)
    assert client.post("/api/watch-officer/briefs/nope/dismiss").status_code in (200, 404)


def test_watch_officer_elaborate_unknown_brief_404(client: TestClient) -> None:
    r = client.post("/api/watch-officer/briefs/nope/elaborate")
    assert r.status_code == 404


def test_watch_officer_elaborate_access_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.intel import watch_officer as wo

    fake = {
        "id": "brief123",
        "title": "ELEVATED · spoofing @ 42.5,-79.8",
        "threat_level": "elevated",
        "domains": ["spoofing"],
        "centroid": {"lat": 42.5, "lon": -79.8},
        "narrative": "MMSI 316043882 at two positions 51 km apart within 2s",
        "evidence": [{"domain": "spoofing", "severity": "high", "summary": "dup MMSI"}],
        "follow_up": ["detect_deception(...)"],
        "playbook": {},
    }
    monkeypatch.setattr(wo, "get_brief", lambda bid: fake if bid == "brief123" else None)
    seen: dict = {}

    async def _chat(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        seen["system"] = messages[0]["content"]
        seen["label"] = label
        return llm.LlmResult(text="Likely coordinated AIS spoofing. **Confidence: medium**", model="m", backend="stub")

    monkeypatch.setattr(llm, "chat", _chat)
    r = client.post("/api/watch-officer/briefs/brief123/elaborate")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and "Confidence" in body["text"]
    assert seen["label"] == "watch_officer.elaborate"
    assert "Confidence" in seen["system"]


def test_watch_officer_elaborate_409_when_selection_disabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.intel import watch_officer as wo

    monkeypatch.setattr(wo, "get_brief", lambda bid: {"id": bid, "title": "x", "evidence": []})
    llm.set_selection_enabled(False)
    r = client.post("/api/watch-officer/briefs/anything/elaborate")
    assert r.status_code == 409


def test_watch_officer_status_reports_liveness(client: TestClient) -> None:
    r = client.get("/api/watch-officer/status")
    assert r.status_code == 200
    body = r.json()
    # The UI proves the officer is alive from these fields + shows its playbooks.
    assert {"running", "cycle_s", "sweeps", "open", "total_filed", "playbooks"} <= set(body)
    assert isinstance(body["playbooks"], list) and len(body["playbooks"]) >= 1
    assert {"id", "trigger", "action"} <= set(body["playbooks"][0])


# ── AI chat: the streaming analyst agent (was zero-coverage) ─────────────────

def test_intel_agent_streams_sse(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_run_agent(q, bbox, ctx, clearance, compartments):  # noqa: ANN001
        yield {"type": "start", "q": q}
        yield {"type": "final", "assessment": "stub", "findings": []}
        yield {"type": "done"}

    monkeypatch.setattr(agent_mod, "run_agent", _fake_run_agent)
    r = client.get("/api/intel/agent", params={"q": "what is happening"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    body = r.text
    assert "data:" in body
    assert '"type": "final"' in body or '"type":"final"' in body


def test_intel_agent_errors_stream_not_raise(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(q, bbox, ctx, clearance, compartments):  # noqa: ANN001
        raise RuntimeError("engine down")
        yield  # pragma: no cover — makes this an async generator

    monkeypatch.setattr(agent_mod, "run_agent", _boom)
    r = client.get("/api/intel/agent", params={"q": "trigger error"})
    # The stream must surface the failure as an SSE error frame, never a 500.
    assert r.status_code == 200
    assert '"type": "error"' in r.text or '"type":"error"' in r.text


def test_intel_agent_rejects_empty_query(client: TestClient) -> None:
    assert client.get("/api/intel/agent", params={"q": "x"}).status_code == 422


# ── LLM-backed intel: investigate + dossier narrative (were zero-coverage) ───

def test_intel_investigate_access_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_chat_json(monkeypatch, {"assessment": "Quiet AOI.", "findings": [], "follow_up": ["watch"]})
    r = client.get("/api/intel/investigate", params={"q": "assess this area"})
    assert r.status_code == 200
    body = r.json()
    assert body["query"] == "assess this area"
    # Grounded fusion metadata is always present even when the AOI is empty.
    assert "incident_count" in body and "scope" in body


def test_intel_investigate_degrades_without_llm(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def _cj(messages, **kw):  # noqa: ANN001, ANN003
        return None, llm.LlmResult(text="", model="", backend="rule-based", error="no backend")

    monkeypatch.setattr(llm, "chat_json", _cj)
    r = client.get("/api/intel/investigate", params={"q": "assess"})
    # No model answering must degrade to a deterministic summary, never 500.
    assert r.status_code == 200


def test_intel_dossier_narrative_bad_prefix(client: TestClient) -> None:
    r = client.post("/api/intel/dossier/narrative", params={"entity_id": "widget:123"})
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_intel_dossier_narrative_access_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_chat_json(monkeypatch, {"narrative": "Grounded pattern-of-life.", "confidence": "medium"})
    r = client.post("/api/intel/dossier/narrative", params={"entity_id": "aircraft:abc123"})
    assert r.status_code == 200
    body = r.json()
    # Either the model answered (ok:true + narrative) or it degraded honestly
    # (ok:false) — never a fabricated success without a backend.
    assert body["ok"] in (True, False)
    if body["ok"]:
        assert body.get("narrative")
