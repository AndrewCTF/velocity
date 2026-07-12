"""Guards for case → report export (roadmap P2).

Acceptance: the exported report contains ZERO claims lacking a provenance
footnote, and any AI-drafted text carries its label through to the output.
Runs keyless + offline (evidence dir isolated per test by conftest).
"""

from __future__ import annotations

import asyncio
import json

from fastapi.testclient import TestClient

from app.intel import case_export as ce
from app.intel import evidence as ev
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx

_CTX = UserCtx("local", "")


async def _seed_case() -> str:
    """A situation with one linked entity (2 sourced assertions) + one evidence."""
    reg = get_registry(_CTX)
    sit_id = "situation:case_export_test"
    await reg.upsert(
        Object(id=sit_id, props={"kind": "situation", "name": "Test Case", "severity": "high"})
    )
    # Linked entity with two sourced claims (distinct provenance).
    await reg.assert_props("vessel:111", {"flag": "LR"}, source="feed:ais")
    await reg.assert_props("vessel:111", {"name": "GHOST"}, source="analyst", confidence=0.7)
    from app.intel.ontology import Link

    await reg.link(Link(src=sit_id, dst="vessel:111", rel="contains"))
    # Attached evidence.
    e = await ev.capture_bytes(
        _CTX, data=b"exhibit bytes", media_type="text/plain",
        capture_method=ev.METHOD_FILE, filename="ex.txt",
    )
    await ev.attach_to_situation(_CTX, e.props["sha256"], sit_id)
    return sit_id


def test_build_bundle_structure() -> None:
    async def run() -> None:
        sit_id = await _seed_case()
        bundle = await ce.build_bundle(_CTX, sit_id)
        assert bundle["situation"]["id"] == sit_id
        ids = [c["object"]["id"] for c in bundle["children"]]
        assert "vessel:111" in ids
        assert any(i.startswith("evidence:") for i in ids)
        # The linked vessel carries its sourced assertions.
        vessel = next(c for c in bundle["children"] if c["object"]["id"] == "vessel:111")
        srcs = {a["source"] for a in vessel["assertions"]}
        assert {"feed:ais", "analyst"} <= srcs
        # Evidence manifest present + verifies (both stat and full re-hash).
        assert bundle["evidence_manifest"]["count"] == 1
        assert bundle["evidence_manifest"]["items"][0]["blob_present"] is True
        assert bundle["evidence_manifest"]["items"][0]["blob_verified"] is True

    asyncio.run(run())


def test_export_flags_tampered_exhibit_as_altered() -> None:
    """A present-but-tampered blob must NOT be certified 'verified' in the report.
    The manifest re-hashes (blob_verified), and render_html shows ALTERED — the
    stat-only blob_present is never sufficient to vouch for an exhibit."""

    async def run() -> None:
        sit_id = await _seed_case()
        sha = (await ce.build_bundle(_CTX, sit_id))["evidence_manifest"]["items"][0][
            "sha256"
        ]
        # Overwrite the stored blob under its hash-named path with other bytes.
        ev.blob_path(ev.get_settings(), sha).write_bytes(b"TAMPERED")

        bundle = await ce.build_bundle(_CTX, sit_id)
        item = bundle["evidence_manifest"]["items"][0]
        assert item["blob_present"] is True  # the file is still there…
        assert item["blob_verified"] is False  # …but its bytes no longer hash

        htmlout = ce.render_html(bundle)
        assert "ALTERED" in htmlout
        assert "(verified)" not in htmlout  # must not certify the tampered exhibit

    asyncio.run(run())


def test_build_bundle_rejects_non_situation() -> None:
    async def run() -> None:
        try:
            await ce.build_bundle(_CTX, "vessel:999")
        except ce.CaseExportError:
            return
        raise AssertionError("expected CaseExportError for a non-situation")

    asyncio.run(run())


def test_html_every_claim_has_provenance() -> None:
    async def run() -> None:
        sit_id = await _seed_case()
        bundle = await ce.build_bundle(_CTX, sit_id)
        htmlout = ce.render_html(bundle)
        # Each non-evidence entity claim appears as a footnoted row; evidence
        # provenance is shown as hashed exhibits (checked below), not claims.
        for c in bundle["children"]:
            if c["object"]["id"].startswith("evidence:"):
                continue
            for a in c["assertions"]:
                assert f"asserted by {a['source']}" in htmlout
        # The evidence hash is present.
        sha = bundle["evidence_manifest"]["items"][0]["sha256"]
        assert sha in htmlout
        # No AI label when no narrative supplied.
        assert ce.AI_LABEL not in htmlout

    asyncio.run(run())


def test_html_narrative_is_labeled() -> None:
    async def run() -> None:
        sit_id = await _seed_case()
        bundle = await ce.build_bundle(_CTX, sit_id)
        htmlout = ce.render_html(bundle, narrative="The vessel likely conducted an STS.")
        assert ce.AI_LABEL in htmlout
        assert "conducted an STS" in htmlout

    asyncio.run(run())


def test_pptx_renders_bytes() -> None:
    async def run() -> None:
        sit_id = await _seed_case()
        bundle = await ce.build_bundle(_CTX, sit_id)
        out = ce.render_pptx(bundle, narrative="draft")
        assert out is not None and out[:2] == b"PK"  # zip/pptx magic

    asyncio.run(run())


# ── route surface ─────────────────────────────────────────────────────────────


def _seed_case_via_client(client: TestClient) -> str:
    sit = client.post("/api/situations", json={"name": "RC", "severity": "med"}).json()
    sid = sit["id"]
    # link an entity + assert a claim on it
    client.post("/api/ontology/promote", json={"id": "vessel:222", "props": {"flag": "PA"}, "trigger": "flag"})
    client.post(f"/api/situations/{sid}/link", json={"dst": "vessel:222", "rel": "contains"})
    ev_obj = client.post(
        "/api/evidence/upload",
        files={"file": ("a.txt", b"routed exhibit", "text/plain")},
        data={"situation_id": sid},
    ).json()
    assert ev_obj["props"]["sha256"]
    return sid


def test_export_route_json_html_pptx(client: TestClient) -> None:
    sid = _seed_case_via_client(client)

    rj = client.post(f"/api/situations/{sid}/export", json={"fmt": "json"})
    assert rj.status_code == 200, rj.text
    bundle = json.loads(rj.content)
    assert bundle["situation"]["id"] == sid
    assert bundle["evidence_manifest"]["count"] == 1

    rh = client.post(f"/api/situations/{sid}/export", json={"fmt": "html"})
    assert rh.status_code == 200
    assert rh.headers["content-type"].startswith("text/html")
    assert b"Case report" in rh.content

    rp = client.post(f"/api/situations/{sid}/export", json={"fmt": "pptx"})
    assert rp.status_code == 200
    assert rp.content[:2] == b"PK"


def test_export_route_404_non_situation(client: TestClient) -> None:
    assert client.post(
        "/api/situations/vessel:404/export", json={"fmt": "json"}
    ).status_code == 404
