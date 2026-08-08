"""Inbound push — ``POST /api/ingest/{dataset_id}`` (the one write from outside).

Every other way data enters this platform is a pull the platform initiated: a
poller, a socket it dialled, a broker it subscribed to, an operator uploading a
file. Nothing could push. That is the whole Gotham "message queue / webhook"
connector category, and it is also the cheapest way to reach the ones this repo
will never carry a client for: a Kafka topic, an MQTT broker, a syslog tail, a
Zapier step and a shell script with `curl` all become the same ten lines on the
sender's side once a URL exists.

It is deliberately not a new ingest path. A pushed body goes through the SAME
``append_version`` + ``auto_sync_dataset`` pair an upload does, so a row lands in
the ontology through whatever binding the operator already configured, obeys the
same row and byte caps, and shows up in the same version history.

**This is the trust boundary.** The route does not use ``current_user_or_local``
— a sender has no session — so a per-dataset bearer token is the entire gate:

  * the token is generated server-side and only its sha256 is stored, so a copy
    of ``foundry.db`` is not a copy of the credential;
  * it is compared with ``secrets.compare_digest``;
  * it is never logged and never appears in any dataset response after the one
    that mints it;
  * a dataset without a token, and a dataset id that does not exist, answer with
    the identical 404, so this cannot be used to discover dataset ids;
  * the body is size-capped BEFORE it is parsed.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from app.config import get_settings
from app.foundry import binding as binding_mod
from app.foundry.store import MAX_UPLOAD_BYTES, FoundryError, FoundryStore
from app.keys import UserCtx

router = APIRouter(tags=["ingest"])
log = logging.getLogger("app.routes.ingest")

# The token authenticates the SENDER, not a user, so the ontology write is
# attributed to the shared local identity — the same one a keyless boot uses.
_LOCAL_CTX = UserCtx(user_id="local", token="")

# Same wording for "no such dataset" and "that dataset has no push endpoint".
_NO_ENDPOINT = "no ingest endpoint for this dataset"


async def _read_capped(request: Request) -> bytes:
    """The body, refused at the cap rather than after it.

    A Content-Length check alone is not enough (it is absent under chunked
    transfer encoding and it is the sender's claim either way), so the stream is
    also totalled as it arrives and abandoned the moment it goes over.
    """
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413, detail=f"body too large: cap is {MAX_UPLOAD_BYTES} bytes"
        )
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"body too large: cap is {MAX_UPLOAD_BYTES} bytes",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/api/ingest/{dataset_id}")
async def push_rows(
    dataset_id: str,
    request: Request,
    x_ingest_token: str | None = Header(None),
) -> dict[str, Any]:
    """Append one object, or an array of objects, to a dataset.

    Arm the endpoint first with ``POST /api/foundry/datasets/{id}/ingest-token``
    and send the token it returns as ``X-Ingest-Token``.
    """
    settings = get_settings()
    store = FoundryStore(settings)

    verdict = await store.ingest_token_matches(dataset_id, x_ingest_token or "")
    if verdict is None:
        raise HTTPException(status_code=404, detail=_NO_ENDPOINT)
    if not verdict:
        # No dataset id, no token prefix, nothing an attacker can grep a log for.
        log.warning("rejected an ingest push with a bad token")
        raise HTTPException(status_code=401, detail="invalid ingest token")

    raw = await _read_capped(request)
    try:
        body = json.loads(raw or b"null")
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"body is not JSON: {exc}") from exc

    if isinstance(body, dict):
        rows = [body]
    elif isinstance(body, list):
        rows = body
    else:
        raise HTTPException(
            status_code=422, detail="body must be an object or an array of objects"
        )
    if any(not isinstance(r, dict) for r in rows):
        raise HTTPException(
            status_code=422, detail="body must be an object or an array of objects"
        )

    try:
        result = await store.append_version(dataset_id, rows)
    except FoundryError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    # The token authenticates the SENDER, not a user, so the ontology write is
    # attributed to the shared local identity — the same one a keyless boot uses.
    result["auto_sync"] = await binding_mod.auto_sync_dataset(store, dataset_id, _LOCAL_CTX)
    result["rows_added"] = len(rows)
    return result
