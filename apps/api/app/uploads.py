"""Byte-capped reads of multipart uploads (one loop, shared by every upload route).

Stops as soon as the running total passes the cap, so a multi-GB body is never
buffered into memory or copied to disk before the size check. ``cap <= 0``
disables the cap. Residual: Starlette spools the multipart body to a temp file
before the handler runs, so this bounds what lands in memory and under ``data/``,
not ingress itself (that belongs to the front proxy's body limit).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, UploadFile

_CHUNK = 1024 * 1024


def _too_big(cap: int) -> HTTPException:
    return HTTPException(status_code=413, detail=f"upload exceeds the {cap:,}-byte cap")


async def read_capped(file: UploadFile, cap: int) -> bytes:
    parts: list[bytes] = []
    total = 0
    while chunk := await file.read(_CHUNK):
        total += len(chunk)
        if cap > 0 and total > cap:
            raise _too_big(cap)
        parts.append(chunk)
    return b"".join(parts)


async def write_capped(file: UploadFile, dest: Path, cap: int, used: int = 0) -> int:
    """Stream ``file`` to ``dest``; ``used`` bytes already count against ``cap``
    (a multi-file job shares one budget). Returns the new running total. On 413
    the partial ``dest`` is removed; the caller owns cleanup of anything else."""
    total = used
    try:
        with dest.open("wb") as out:  # noqa: ASYNC230 — chunked local write of an upload
            while chunk := await file.read(_CHUNK):
                total += len(chunk)
                if cap > 0 and total > cap:
                    raise _too_big(cap)
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)  # noqa: ASYNC240 — local temp cleanup
        raise
    return total
