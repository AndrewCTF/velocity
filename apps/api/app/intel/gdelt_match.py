"""Word-boundary country-name matcher for GDELT actor-field text.

GDELT's CAMEO actor strings (``actor1``/``actor2`` on a ``conflict_events``
feature) are free text, not a controlled country vocabulary. The prior
heuristic (``country_profile.country_security()``, before this module
existed) tested plain substring containment (``name in actor``), which
false-positives on any word that merely CONTAINS the country name as a
substring — most commonly a demonym: "ethiopia" is a substring of
"ethiopian", so a story that only mentioned an "Ethiopian" person (a St.
Paul, Minnesota crime story naming an Ethiopian-American suspect) got
mis-attributed to Ethiopia's country brief and instability score.

Requiring a ``\\b...\\b`` word boundary around the normalized country name
kills that whole class of false positive. It is still a text heuristic, not
verified geo-attribution — a country name can legitimately appear as a whole
word inside an unrelated sentence ("Nigeria Police" arresting someone in an
unrelated matter) — so callers keep surfacing this as a reporting-intensity
caveat, never as ground truth.
"""

from __future__ import annotations

import re


def norm(s: str | None) -> str:
    """Casefold + strip — the shared normalization both the actor text and
    the country name go through before matching."""
    return str(s or "").strip().casefold()


def actor_matches_country(actor: str | None, country_name: str | None) -> bool:
    """True when ``country_name`` appears in ``actor`` as a whole word or
    phrase (word-boundary match on both ends), never as a substring of a
    longer word — "ethiopia" does not match inside "ethiopian". Both sides
    are normalized first; empty/missing input on either side is never a
    match."""
    name_n = norm(country_name)
    actor_n = norm(actor)
    if not name_n or not actor_n:
        return False
    return re.search(rf"\b{re.escape(name_n)}\b", actor_n) is not None
