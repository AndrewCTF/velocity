"""Guards for foundry/documents.py + POST /api/foundry/datasets/{id}/documents.

An operator's documents — an email export, a Word file, plain text — become
Foundry dataset rows the same way a table cursor pull does: one row per
document, appended as a new version, from which the ordinary binding
machinery carries it into the ontology. Nothing here needs a real LLM; the
``extract=1`` path is exercised only for "it never crashes the upload when
the model is unavailable", not for extraction quality.
"""

from __future__ import annotations

import io
import zipfile
from email.message import EmailMessage

import pytest
from fastapi.testclient import TestClient

from app.foundry import documents as D

_DOCX_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _make_docx(paragraphs: list[str]) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{_DOCX_NS}"><w:body>{body}</w:body></w:document>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", xml)
    return buf.getvalue()


def _make_eml(subject: str, body: str) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = "analyst@example.com"
    msg["To"] = "watch@example.com"
    msg.set_content(body)
    return bytes(msg.as_bytes())


@pytest.fixture
def dataset(client: TestClient) -> str:
    r = client.post("/api/foundry/datasets", json={"name": "docs_target"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ── extract_text() unit coverage ──────────────────────────────────────────────


def test_extract_docx_joins_paragraphs_with_newlines() -> None:
    data = _make_docx(["First paragraph.", "Second paragraph."])
    result = D.extract_text("report.docx", data)
    assert result["text"] == "First paragraph.\nSecond paragraph."
    assert result["title"] == "report"


def test_extract_eml_uses_subject_as_title() -> None:
    data = _make_eml("Flight anomaly", "Tail N101 diverted to KORD.")
    result = D.extract_text("case.eml", data)
    assert result["title"] == "Flight anomaly"
    assert "N101" in result["text"]


def test_extract_txt_is_raw() -> None:
    result = D.extract_text("notes.txt", b"plain notes here")
    assert result["text"] == "plain notes here"
    assert result["title"] == "notes"


def test_extract_unsupported_extension_is_a_typed_415() -> None:
    with pytest.raises(D.DocumentExtractError) as ei:
        D.extract_text("archive.zip", b"whatever")
    assert ei.value.status_code == 415
    assert "unsupported" in ei.value.detail


def test_document_row_id_is_stable_for_identical_content() -> None:
    row1 = D.document_row("a.txt", b"same bytes")
    row2 = D.document_row("a.txt", b"same bytes")
    assert row1["doc_id"] == row2["doc_id"]
    assert len(row1["doc_id"]) == 16
    assert row1["sha256"].startswith(row1["doc_id"])


# ── the route ──────────────────────────────────────────────────────────────────


def test_docx_upload_appends_a_row_and_a_version(client: TestClient, dataset: str) -> None:
    data = _make_docx(["Cargo manifest for MV EXAMPLE.", "Departs 04:00Z."])
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("manifest.docx", io.BytesIO(data), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["row_count"] == 1
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert len(rows) == 1
    assert rows[0]["filename"] == "manifest.docx"
    assert "Cargo manifest" in rows[0]["text"]
    assert len(rows[0]["doc_id"]) == 16


def test_eml_upload_extracts_subject_and_body(client: TestClient, dataset: str) -> None:
    data = _make_eml("Watch note", "Vessel loitering near the strait.")
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("note.eml", io.BytesIO(data), "message/rfc822")},
    )
    assert r.status_code == 200, r.text
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert rows[0]["title"] == "Watch note"
    assert "loitering" in rows[0]["text"]


def test_txt_upload(client: TestClient, dataset: str) -> None:
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("field.txt", io.BytesIO(b"raw field notes"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert rows[0]["text"] == "raw field notes"


def test_a_second_document_appends_rather_than_replaces(client: TestClient, dataset: str) -> None:
    client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("one.txt", io.BytesIO(b"one"), "text/plain")},
    )
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("two.txt", io.BytesIO(b"two"), "text/plain")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["row_count"] == 2
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert {row["filename"] for row in rows} == {"one.txt", "two.txt"}


def test_unknown_dataset_is_404(client: TestClient) -> None:
    r = client.post(
        "/api/foundry/datasets/ds_nope/documents",
        files={"file": ("x.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert r.status_code == 404


def test_unsupported_extension_is_415(client: TestClient, dataset: str) -> None:
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("archive.zip", io.BytesIO(b"whatever"), "application/zip")},
    )
    assert r.status_code == 415
    assert "unsupported" in r.json()["detail"]


def test_pdf_without_pypdf_installed_is_415_naming_pypdf(
    client: TestClient, dataset: str, monkeypatch
) -> None:
    """Same shim idiom as test_connections.py's sqlalchemy-absence guard: once
    pypdf is actually installed here, a test that merely imports it would pass
    while proving nothing, so `import` itself is made to fail."""
    import builtins

    real_import = builtins.__import__

    def _fake(name, *args, **kwargs):  # type: ignore[no-untyped-def]
        if name == "pypdf" or name.startswith("pypdf."):
            raise ModuleNotFoundError("No module named 'pypdf'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fake)
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("report.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")},
    )
    assert r.status_code == 415, r.text
    assert "pypdf" in r.json()["detail"]


def test_over_cap_upload_is_413(client: TestClient, dataset: str, monkeypatch) -> None:
    from app.foundry import store as foundry_store

    monkeypatch.setattr(foundry_store, "MAX_UPLOAD_BYTES", 16)
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("big.txt", io.BytesIO(b"x" * 200), "text/plain")},
    )
    assert r.status_code == 413
    assert "16" in r.json()["detail"]
    # Nothing landed: the row count is still zero.
    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert rows == []


def test_the_audit_row_for_a_document_upload_carries_no_file_contents(
    client: TestClient, dataset: str, monkeypatch
) -> None:
    from app import audit as audit_mod

    rows: list[dict] = []

    async def _rec(ctx, action, resource_type, resource_id="", **kw):  # type: ignore[no-untyped-def]
        rows.append({"action": action, "resource_id": resource_id, **kw})
        return True

    monkeypatch.setattr(audit_mod, "audit", _rec)
    secret_text = "CLASSIFIED-PAYLOAD-MARKER"
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={"file": ("secret.txt", io.BytesIO(secret_text.encode()), "text/plain")},
    )
    assert r.status_code == 200, r.text
    import time

    deadline = time.monotonic() + 3
    while not rows and time.monotonic() < deadline:
        time.sleep(0.01)
    assert rows, "no audit row for the document upload"
    assert secret_text not in repr(rows)


def test_extract_query_param_never_fails_the_upload_when_the_model_is_unavailable(
    client: TestClient, dataset: str
) -> None:
    """Best-effort: no LLM is configured in the test environment, so
    ``_run_llm`` raises, and that must show up as `extracted.error`, not a
    failed upload — the document itself is already saved by that point."""
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents?extract=1",
        files={"file": ("brief.txt", io.BytesIO(b"Some analyst text about a vessel."), "text/plain")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["row_count"] == 1
    assert "extracted" in body
    if "error" not in body["extracted"]:
        # If a local model IS reachable in this environment, the shape is
        # still checked rather than skipped outright.
        assert "entities" in body["extracted"]


def test_document_extraction_runs_off_the_event_loop(
    client: TestClient, dataset: str, monkeypatch
) -> None:
    """W6-2 regression: the sha256 + docx/pdf parse of an upload can take
    seconds, and it used to run inline on the event loop the 1 s ADS-B tick
    and the /ws/adsb push share. The route hands it to a worker thread —
    record the thread id from inside a spy on ``document_row`` and prove it
    is not the thread the loop runs on. Also: the offload must not change
    what lands — the row matches a direct ``document_row`` call field for
    field."""
    import threading

    from app.routes import foundry as F

    # The loop's OWN thread, captured from inside the route (an inline
    # call of document_row would run here; a to_thread'ed call does not).
    # read_capped is awaited first, on the loop thread, in every variant.
    loop_threads: set[int] = set()
    real = D.document_row
    real_read_capped = F.read_capped

    async def read_capped_spy(file, cap: int):  # type: ignore[no-untyped-def]
        loop_threads.add(threading.get_ident())
        return await real_read_capped(file, cap)

    monkeypatch.setattr(F, "read_capped", read_capped_spy)
    seen: list[int] = []

    def spy(filename: str, data: bytes):
        seen.append(threading.get_ident())
        return real(filename, data)

    monkeypatch.setattr(D, "document_row", spy)

    data = _make_docx(["Off the loop."])
    expected = real("offloop.docx", data)
    r = client.post(
        f"/api/foundry/datasets/{dataset}/documents",
        files={
            "file": (
                "offloop.docx",
                io.BytesIO(data),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert r.status_code == 200, r.text
    assert len(seen) == 1, "the route must call document_row exactly once"
    assert loop_threads, "read_capped spy did not run"
    assert seen[0] not in loop_threads, (
        "document extraction ran ON the event loop — it must be "
        "to_thread'd, like routes/evidence.py's blob re-hash"
    )

    rows = client.get(f"/api/foundry/datasets/{dataset}/rows").json()["rows"]
    assert len(rows) == 1, rows
    row = rows[0]
    for key in ("doc_id", "filename", "sha256", "title", "text", "pages"):
        assert row[key] == expected[key], key
