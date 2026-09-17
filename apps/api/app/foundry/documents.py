"""Text extraction for Foundry document ingestion.

The other half of "an operator's internal data becomes a Foundry dataset
without copying a whole table every cycle" (``connections.py``): a document —
an email export, a Word file, plain text — becomes ONE row in a dataset, with
its text pulled out so it is searchable/bindable exactly like any other
Foundry data. Pure stdlib for the always-available formats (``email``,
``zipfile``, ``xml.etree``); ``.pdf`` needs the optional ``pypdf`` extra,
import-guarded the same way ``connections.py`` guards ``sqlalchemy`` — absent,
the route answers 415 naming the install rather than 500ing or blocking boot.

Deliberately thin: this module extracts text, nothing more. Ontology minting
(the ``extract=1`` LLM pass) lives in the route
(``routes/foundry.py::upload_document``), which reuses
``routes/extract.py``'s ``_run_llm``/``_normalise`` rather than this module
reimplementing the LLM call.
"""

from __future__ import annotations

import email
import email.policy
import hashlib
import re
import time
import zipfile
from io import BytesIO
from typing import Any
from xml.etree import ElementTree as ET

# Formats handled without an optional extra.
_STDLIB_EXTS = {"eml", "docx", "txt", "md"}
_ALL_EXTS = _STDLIB_EXTS | {"pdf"}

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t]+")
_ENTITY_MAP = (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"))

_DOCX_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class DocumentExtractError(Exception):
    """Raised for extraction failures the route layer maps to an HTTP status —
    415 for "this deployment cannot read that format", 422 for "this file
    does not look like what its extension claims"."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _strip_html(html: str) -> str:
    """A blunt tag-stripper for the .eml html-only fallback — no external HTML
    parser dependency for what is, at most, a handful of stray messages."""
    text = _HTML_TAG_RE.sub(" ", html)
    for ent, repl in _ENTITY_MAP:
        text = text.replace(ent, repl)
    lines = [_WS_RE.sub(" ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def _title_from_filename(filename: str) -> str:
    stem = filename.rsplit("/", 1)[-1]
    if "." in stem:
        stem = stem.rsplit(".", 1)[0]
    return stem or filename


def _extract_eml(data: bytes) -> tuple[str, str]:
    msg = email.message_from_bytes(data, policy=email.policy.default)
    title = str(msg.get("subject") or "").strip()
    plain = msg.get_body(preferencelist=("plain",))
    if plain is not None:
        return title, str(plain.get_content())
    html = msg.get_body(preferencelist=("html",))
    if html is not None:
        return title, _strip_html(str(html.get_content()))
    return title, ""


def _extract_docx(data: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(data)) as z:
            xml_bytes = z.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise DocumentExtractError(422, f"not a readable .docx: {exc}") from exc
    try:
        root = ET.fromstring(xml_bytes)  # noqa: S314 - our own zip member, not user XML from the wire
    except ET.ParseError as exc:
        raise DocumentExtractError(422, f"not a readable .docx: {exc}") from exc
    paragraphs: list[str] = []
    for p in root.iter(f"{_DOCX_NS}p"):
        line = "".join(t.text or "" for t in p.iter(f"{_DOCX_NS}t")).strip()
        if line:
            paragraphs.append(line)
    return "\n".join(paragraphs)


def _extract_pdf(data: bytes) -> tuple[str, int]:
    try:
        import pypdf  # noqa: PLC0415 - optional dependency, guarded like sqlalchemy
    except Exception as exc:  # noqa: BLE001 - a broken install is also unavailable
        raise DocumentExtractError(
            415, "extracting a .pdf needs the optional pypdf extra: pip install pypdf"
        ) from exc
    try:
        reader = pypdf.PdfReader(BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:  # noqa: BLE001 - a corrupt PDF is a 422, not a 500
        raise DocumentExtractError(422, f"not a readable .pdf: {exc}") from exc
    return "\n".join(pages), len(pages)


def extract_text(filename: str, data: bytes) -> dict[str, Any]:
    """``{title, text, pages}`` for one of eml/docx/txt/md/pdf, by extension.

    An unrecognised extension is a 415 naming the supported set, same shape as
    the pypdf-absent case — both are "this deployment cannot read that kind of
    file right now", not a caller mistake worth a 422.
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in _ALL_EXTS:
        raise DocumentExtractError(
            415,
            f"unsupported document type: .{ext or 'unknown'} "
            f"(supported: {', '.join(sorted('.' + e for e in _ALL_EXTS))})",
        )
    title = _title_from_filename(filename)
    if ext == "eml":
        subject, text = _extract_eml(data)
        return {"title": subject or title, "text": text, "pages": 1}
    if ext == "docx":
        return {"title": title, "text": _extract_docx(data), "pages": 1}
    if ext == "pdf":
        text, pages = _extract_pdf(data)
        return {"title": title, "text": text, "pages": max(pages, 1)}
    # txt / md
    return {"title": title, "text": data.decode("utf-8", errors="replace"), "pages": 1}


def pdf_available() -> bool:
    """True when the optional ``pypdf`` extra is importable — same guarded
    probe idiom as ``connections.availability()``, exposed here so the
    connector catalog route (``routes/foundry.py``) can report it without
    reaching into this module's private extraction internals."""
    try:
        import pypdf  # noqa: PLC0415,F401
    except Exception:  # noqa: BLE001 - a broken install is also unavailable
        return False
    return True


def document_row(filename: str, data: bytes) -> dict[str, Any]:
    """One document as a Foundry dataset row: ``{doc_id, filename, sha256,
    title, text, pages, extracted_at}``. ``doc_id`` is the first 16 hex chars
    of the content hash, so re-uploading the identical file is a stable id, not
    a fresh random one every time."""
    extracted = extract_text(filename, data)
    sha = hashlib.sha256(data).hexdigest()
    return {
        "doc_id": sha[:16],
        "filename": filename,
        "sha256": sha,
        "title": extracted["title"],
        "text": extracted["text"],
        "pages": extracted["pages"],
        "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
