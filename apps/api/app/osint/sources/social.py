"""Username/email social enrichment — reddit history + avatar presence.

One function per source, all keyless. Never raises on upstream failure
(degrades to an empty result + ``note``). Sources:

  pullpush_reddit   — reddit submission search (api.pullpush.io, keyless mirror
                       of the retired pushshift API)
  libravatar_exists — federated-avatar presence check (seccdn.libravatar.org)
"""

from __future__ import annotations

import hashlib
from typing import Any

from app.osint.fetch import fetch_json, normalise_email, normalise_username
from app.upstream import get_client

_BOUND = 25


# ── Reddit submission history (pullpush.io) ─────────────────────────────────

async def pullpush_reddit(username: str) -> dict[str, Any]:
    u = normalise_username(username)
    if u is None:
        return {
            "username": username, "submissions": [], "subreddits": [],
            "count": 0, "note": "invalid username",
        }
    data = await fetch_json(
        f"https://api.pullpush.io/reddit/search/submission/?author={u}&size={_BOUND}",
        1800.0,
    )
    rows = (data or {}).get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not rows:
        return {"username": u, "submissions": [], "subreddits": [], "count": 0}
    submissions = [
        {
            "subreddit": str(row.get("subreddit", "")),
            "title": str(row.get("title", "")),
            "created": row.get("created_utc"),
        }
        for row in rows[:_BOUND]
        if isinstance(row, dict)
    ]
    subreddits = sorted({s["subreddit"] for s in submissions if s["subreddit"]})
    return {
        "username": u,
        "submissions": submissions,
        "subreddits": subreddits,
        "count": len(submissions),
    }


# ── Libravatar presence (federated Gravatar-alike) ──────────────────────────

async def _head_ok(url: str) -> bool:
    """Uncached GET returning True only on a bare HTTP 200 — else False.

    Libravatar's avatar endpoint returns an image, not JSON, so the shared
    ``fetch_json`` (which requires a JSON body) can't be reused. ``d=404``
    makes the upstream itself answer "not found" with a 404 rather than a
    generated default image, so status code alone tells us presence.
    """
    try:
        r = await get_client().get(url, follow_redirects=True)
    except Exception:  # noqa: BLE001 — network error → degrade
        return False
    return r.status_code == 200


async def libravatar_exists(email: str) -> dict[str, Any]:
    e = normalise_email(email)
    if e is None:
        return {"email": email, "has_avatar": False, "note": "invalid email"}
    h = hashlib.md5(e.encode()).hexdigest()  # noqa: S324 — Libravatar's required key, not security
    ok = await _head_ok(f"https://seccdn.libravatar.org/avatar/{h}?d=404&s=80")
    return {"email": e, "has_avatar": ok}
