"""Resolve an organisation across four authorities at once, keylessly.

The sanctions join answers "is this hull designated". The question straight after
it is always "and who owns it", and that answer is not in any one place. It is
split across a registry (who is this legal entity, and where), filings (what has
it been compelled to disclose), procurement (who pays it), and the designation
lists themselves. Each of those is free and keyless. None of them is joined to
the others, which is the product people buy.

Four sources, all verified live 2026-08-05, all without a key:

* **GLEIF** (`api.gleif.org`) — the LEI register. Legal name, jurisdiction,
  legal address, registration status. Probing "SOVCOMFLOT" returns 2 records,
  both LAPSED, which is itself the finding.
* **SEC EDGAR full-text** (`efts.sec.gov`) — every filing mentioning the name,
  with form type and date. Needs a real ``User-Agent`` per SEC policy and
  nothing else.
* **USAspending** (`api.usaspending.gov`) — US federal awards by recipient.
  POST, keyless. Probing "Lockheed Martin" returns awards down to the contract
  number.
* **The designation lists** already loaded by `intel/sanctions.py`.

The rule the whole module is built around: **every source reports whether it
answered.** A resolution that silently drops EDGAR and returns "no filings" is
worse than one that returns nothing, because the first is a claim and the second
is an absence. `reached` and `failed` are part of the response, always.

Nothing here is scored, ranked or summarised by a model. It returns what four
registries said, attributed, and lets the analyst do the joining that needs
judgement.
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.intel import sanctions as sx
from app.upstream import cache, get_client

GLEIF_URL = "https://api.gleif.org/api/v1/lei-records"
EDGAR_URL = "https://efts.sec.gov/LATEST/search-index"
USASPENDING_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/"

# SEC's access policy asks for a real identifier on every request. This is not
# an attempt to look like a browser; it is the string SEC asks callers to send.
_SEC_UA = "velocity-osint (open-source OSINT console) ops@velocity.local"

_TTL_S = 3600
_TIMEOUT = 30.0


async def gleif(name: str, limit: int = 10) -> list[dict[str, Any]]:
    """LEI records whose legal name matches. Empty list is a real answer."""
    r = await get_client().get(
        GLEIF_URL,
        params={"filter[entity.legalName]": name, "page[size]": min(limit, 50)},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    out: list[dict[str, Any]] = []
    for rec in (r.json().get("data") or [])[:limit]:
        a = rec.get("attributes") or {}
        e = a.get("entity") or {}
        addr = e.get("legalAddress") or {}
        out.append(
            {
                "lei": a.get("lei"),
                "legal_name": (e.get("legalName") or {}).get("name"),
                "jurisdiction": e.get("jurisdiction"),
                "country": addr.get("country"),
                "city": addr.get("city"),
                "status": e.get("status"),
                # A LAPSED registration is a finding in its own right: the entity
                # stopped renewing, which often follows a designation.
                "registration_status": (a.get("registration") or {}).get("status"),
                "last_update": (a.get("registration") or {}).get("lastUpdateDate"),
                "source": "GLEIF",
            }
        )
    return out


async def edgar(name: str, limit: int = 10) -> list[dict[str, Any]]:
    """SEC filings whose full text mentions the name."""
    r = await get_client().get(
        EDGAR_URL,
        params={"q": f'"{name}"'},
        headers={"User-Agent": _SEC_UA},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    hits = ((r.json().get("hits") or {}).get("hits")) or []
    out: list[dict[str, Any]] = []
    for h in hits[:limit]:
        s = h.get("_source") or {}
        names = s.get("display_names") or []
        out.append(
            {
                "filed": s.get("file_date"),
                "forms": s.get("root_forms") or s.get("file_type"),
                "filer": names[0] if names else None,
                "adsh": s.get("adsh"),
                "source": "SEC EDGAR",
            }
        )
    return out


async def usaspending(name: str, limit: int = 10) -> list[dict[str, Any]]:
    """US federal awards mentioning the name, largest first."""
    body = {
        "filters": {
            "keywords": [name],
            "award_type_codes": ["A", "B", "C", "D"],
        },
        "fields": ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date"],
        "limit": min(limit, 100),
        "sort": "Award Amount",
        "order": "desc",
    }
    r = await get_client().post(USASPENDING_URL, json=body, timeout=_TIMEOUT)
    r.raise_for_status()
    out: list[dict[str, Any]] = []
    for row in (r.json().get("results") or [])[:limit]:
        out.append(
            {
                "award_id": row.get("Award ID"),
                "recipient": row.get("Recipient Name"),
                "amount_usd": row.get("Award Amount"),
                "agency": row.get("Awarding Agency"),
                "start": row.get("Start Date"),
                "source": "USAspending",
            }
        )
    return out


async def _sanctions(name: str) -> dict[str, Any] | None:
    idx = await sx.get_index()
    # Substring, not exact. OFAC lists "SOVCOMFLOT PJSC" and an operator types
    # "Sovcomflot"; an exact fold answers "not designated", which is wrong and
    # confident. `search_names` is deliberately separate from the hull matcher,
    # where a substring join would light up half the list.
    hits = sx.search_names(idx, name, limit=8)
    if not hits:
        return None
    return {
        "lists": sorted({d.list_name for d in hits}),
        "programs": sorted({p for d in hits for p in d.programs}),
        "entries": [d.as_dict() for d in hits[:5]],
        "matched_on": "name",
        "confidence": "probable",
    }


async def _resolve(name: str, limit: int) -> dict[str, Any]:
    tasks = {
        "GLEIF": gleif(name, limit),
        "SEC EDGAR": edgar(name, limit),
        "USAspending": usaspending(name, limit),
        "sanctions": _sanctions(name),
    }
    settled = await asyncio.gather(*tasks.values(), return_exceptions=True)
    got: dict[str, Any] = {}
    reached: list[str] = []
    failed: dict[str, str] = {}
    for key, value in zip(tasks, settled, strict=True):
        if isinstance(value, BaseException):
            failed[key] = str(value)[:200]
            continue
        reached.append(key)
        got[key] = value
    return {
        "query": name,
        "lei": got.get("GLEIF") or [],
        "filings": got.get("SEC EDGAR") or [],
        "awards": got.get("USAspending") or [],
        "sanctions": got.get("sanctions"),
        # Always present. An empty result from a source that answered and an
        # empty result from a source that did not are different facts, and every
        # consumer of this has to be able to tell them apart.
        "reached": reached,
        "failed": failed,
        "note": (
            "Four registries, joined on the name only. A name is not an identifier: "
            "treat every row as a candidate until an LEI, a CIK or a hull number agrees."
        ),
    }


async def resolve(name: str, limit: int = 10) -> dict[str, Any]:
    key = f"org:resolve:{name.lower()}:{limit}"
    return await cache.get_or_fetch(key, _TTL_S, lambda: _resolve(name, limit))
