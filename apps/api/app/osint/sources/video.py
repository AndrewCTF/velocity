"""Video provenance — YouTube, keyless (*OSINT Techniques* 11th ed. ch. 30).

Two questions the book asks of any video URL an investigation turns up, both
answerable without a key or an API quota:

  * **Who posted it, when, and is it still up?** ``/oembed`` returns the title,
    the channel and its url for a live public video, and a 400 for one that has
    been removed, set private, or never existed.
  * **Did it exist?** The thumbnail CDN keeps serving after the watch page is
    gone. A 200 from ``img.youtube.com`` beside a 400 from ``/oembed`` is the
    book's own signal for "this was a real upload that has since been taken
    down" — which is a stronger finding than either check alone, and is exactly
    the case where the archived thumbnail is the only surviving evidence.

The thumbnail url is returned whether or not the video is live, because it is
the input to the reverse-image pivots (``pivots.py``, kind ``video``) that come
next in the same chapter.

Never raises; an unreachable upstream degrades to ``checked: False``.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import quote

from app.upstream import get_client

# 11 chars of base64url is YouTube's id. Accepted bare, or pulled out of any of
# the url shapes the platform hands people (watch, youtu.be, shorts, embed).
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_URL_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^&]*&)*v=|shorts/|embed/|v/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})"
)
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
# The placeholder YouTube serves for a missing thumbnail is a fixed ~1 KB grey
# JPEG returned with a 404; a real thumbnail is a 200 and much larger. Both are
# checked so a CDN that starts 200-ing the placeholder cannot read as "exists".
_PLACEHOLDER_MAX_BYTES = 2048


def youtube_id(target: str) -> str | None:
    """The 11-char video id out of a bare id or any YouTube url shape."""
    t = (target or "").strip()
    if _ID_RE.match(t):
        return t
    m = _URL_ID_RE.search(t)
    return m.group(1) if m else None


async def _thumbnail(vid: str) -> tuple[bool, str]:
    """(exists, url) for the highest-quality thumbnail that actually serves."""
    for name in ("maxresdefault", "hqdefault"):
        url = f"https://img.youtube.com/vi/{vid}/{name}.jpg"
        try:
            r = await get_client().get(url, headers={"User-Agent": _UA},
                                       follow_redirects=True)
        except Exception:  # noqa: BLE001 — network error → try the next size
            continue
        if r.status_code == 200 and len(r.content) > _PLACEHOLDER_MAX_BYTES:
            return True, url
    return False, f"https://img.youtube.com/vi/{vid}/hqdefault.jpg"


async def _oembed(vid: str) -> tuple[int, dict[str, Any] | None]:
    watch = quote(f"https://www.youtube.com/watch?v={vid}", safe="")
    try:
        r = await get_client().get(
            f"https://www.youtube.com/oembed?url={watch}&format=json",
            headers={"User-Agent": _UA}, follow_redirects=True,
        )
    except Exception:  # noqa: BLE001 — network error → degrade
        return 0, None
    if r.status_code != 200:
        return r.status_code, None
    try:
        body = r.json()
    except Exception:  # noqa: BLE001 — non-JSON body
        return r.status_code, None
    return 200, body if isinstance(body, dict) else None


async def youtube_video(target: str) -> dict[str, Any]:
    """Is this video live, who posted it, and did it ever exist."""
    vid = youtube_id(target)
    if vid is None:
        return {"target": target, "checked": False, "found": False,
                "note": "not a YouTube video id or url"}

    (status, meta), (thumb_exists, thumb_url) = await asyncio.gather(
        _oembed(vid), _thumbnail(vid)
    )
    if status == 0 and not thumb_exists:
        return {"video_id": vid, "checked": False, "found": False,
                "note": "youtube unreachable"}

    live = meta is not None
    out: dict[str, Any] = {
        "video_id": vid,
        "checked": True,
        "found": live,
        "watch_url": f"https://www.youtube.com/watch?v={vid}",
        "thumbnail_url": thumb_url,
        "thumbnail_exists": thumb_exists,
    }
    if live and meta is not None:
        out.update({
            "title": meta.get("title"),
            "channel": meta.get("author_name"),
            "channel_url": meta.get("author_url"),
            "provider": meta.get("provider_name"),
        })
    else:
        # The distinction the chapter is actually after: a video that is gone
        # but whose thumbnail still serves DID exist, and the thumbnail may be
        # the only image of it left. Say which of the two this is.
        out["status"] = (
            "removed or private, but the thumbnail still serves"
            if thumb_exists else "no such video, or never public"
        )
    return out
