"""The ontology's declared shape — what kinds carry, and what a relation means
read from either end.

``intel/ontology.py`` owns the typed models; this module owns the *schema over*
them. Two tables:

  ``REL_TYPES``  — every relation verb with BOTH of its names. Gotham states a
                   link twice ("A employs B" / "B employed by A") because a
                   graph is read from whichever node you are standing on, and
                   until now this repo only had the forward name, so an edge
                   traversed backwards rendered as a verb pointing the wrong
                   way. Each entry also names the object kinds the endpoints
                   are expected to be, which is what makes a mis-wired edge
                   visible.
  ``PROP_TYPES`` — the properties a kind is known to carry, and their type.
                   Seeded ONLY from props this repo demonstrably writes (the
                   ADS-B and AIS feature builders, ``intel/promotion.py``,
                   ``intel/evidence.py``); a kind with nothing verified gets no
                   entry rather than an invented one.

**Everything here warns, nothing rejects.** ``ontology.py`` records the operator
decision that the registry must be able to hold an edge an analyst or an agent
invents, and ``routes/extract.py`` mints links whose ``rel`` comes out of a
language model. A validator that raised would revoke that decision and start
dropping data. ``validate_object`` / ``validate_link`` return a list of English
sentences; the caller decides whether anyone reads them.

Import direction is one-way: ``ontology.py`` imports THIS module (for
``KNOWN_RELS``), so nothing here may import from ``ontology.py``. That is why
kinds are typed ``str`` and not ``ObjectKind``.
"""

from __future__ import annotations

from typing import Any, Literal, NamedTuple

# Property value types. Deliberately coarse: this drives a facet picker and a
# binding form, not a serializer.
PropType = Literal["str", "num", "bool", "ts", "geo", "id"]


class RelType(NamedTuple):
    """One relation verb, named from both ends.

    ``forward`` reads ``src -> dst``; ``inverse`` reads ``dst -> src``. An empty
    ``src``/``dst`` means "any kind" — used where the verb genuinely spans the
    graph (``same_as``, ``mentions``) rather than where nobody checked.
    """

    forward: str
    inverse: str
    src: frozenset[str] = frozenset()
    dst: frozenset[str] = frozenset()


def _r(
    forward: str,
    inverse: str,
    src: tuple[str, ...] = (),
    dst: tuple[str, ...] = (),
) -> RelType:
    return RelType(forward, inverse, frozenset(src), frozenset(dst))


# ── relations ─────────────────────────────────────────────────────────────────
# The union of the vocabulary ontology.py documented and the verbs the code
# actually mints. Those two had drifted: thirteen relations in live use
# (`mentions` from routes/extract.py, `resolves_to` / `registered_by` /
# `has_subdomain` / `secured_by` / `indicates_threat` / `announces` /
# `runs_service` / `abuse_contact` / `has_email` / `has_account` /
# `registrant_email` from routes/osint.py, `evidence` from intel/evidence.py)
# were absent from the frozenset that claimed to list them.

REL_TYPES: dict[str, RelType] = {
    # Analyst / action write-back (intel/actions.py, intel/promotion.py).
    "flagged": _r("flagged", "flag on"),
    "evidence_of": _r("evidence of", "supported by", dst=("incident",)),
    "promoted_to": _r("promoted to", "promoted from", dst=("incident",)),
    "nominated": _r("nominated", "nomination of"),
    "watched_by": _r("watched by", "watches"),
    "operates": _r("operates", "operated by", ("org", "person"), ("aircraft", "vessel")),
    "correlated": _r("correlated with", "correlated with"),
    "member_of": _r("member of", "has member", ("sim",), ("sim",)),
    # Situation composition (routes/situations.py). Both directions are stored
    # as separate rels here for history; the labels agree with each other.
    "contains": _r("contains", "part of"),
    "part_of": _r("part of", "contains"),
    "evidence": _r("evidence", "evidence for", dst=("evidence",)),
    # Digital OSINT (app/osint, routes/osint.py).
    "archived_url": _r("archived as", "archive of", ("domain", "url"), ("url",)),
    "contacted": _r("contacted", "contacted by", dst=("ip",)),
    "peers_with": _r("peers with", "peers with", ("asn",), ("asn",)),
    "tor_exit": _r("flagged Tor exit", "Tor exit flag on", ("ip",), ("threat",)),
    "listed_by": _r("listed by", "lists", dst=("threat",)),
    "distributes": _r("distributes", "distributed by", ("url",), ("file",)),
    "sends_to": _r("sends to", "received from", ("wallet",), ("tx",)),
    "receives_from": _r("receives from", "sent to", ("wallet",), ("tx",)),
    "officer_of": _r("officer of", "has officer", ("person",), ("org",)),
    "sanctioned_as": _r("sanctioned as", "sanction on", ("org", "person"), ("threat",)),
    "same_as": _r("same as", "same as"),
    "posted_by": _r("posted by", "posted", dst=("username",)),
    "resolves_to": _r("resolves to", "resolved from", ("domain",), ("ip",)),
    "registered_by": _r("registered by", "registrant of", ("domain",), ("org",)),
    "registrant_email": _r(
        "registrant email", "registrant email for", ("domain",), ("email",)
    ),
    "has_subdomain": _r("has subdomain", "subdomain of", ("domain",), ("domain",)),
    "secured_by": _r("secured by", "secures", ("domain",), ("cert",)),
    "indicates_threat": _r("indicates threat to", "flagged by", ("threat",)),
    "announces": _r("announces", "announced by", ("asn",), ("ip",)),
    "runs_service": _r("runs service", "run by", ("ip",), ("service",)),
    "abuse_contact": _r("abuse contact", "abuse contact for", ("ip",), ("email",)),
    "has_email": _r("has email", "email of", ("person",), ("email",)),
    "has_account": _r("has account", "account of", ("person",), ("username",)),
    # Document extraction (routes/extract.py). The model may invent others.
    "mentions": _r("mentions", "mentioned in"),
    # Country-OSINT catalog (app/osint/country_catalog.py).
    "has_resource": _r("has resource", "resource for", ("country",), ("resource",)),
    "hosted_at": _r("hosted at", "hosts", ("resource",), ("domain",)),
}


# ── properties ────────────────────────────────────────────────────────────────
# Each block is copied from the code that writes it, cited so the next editor
# can check rather than trust.

PROP_TYPES: dict[str, dict[str, PropType]] = {
    # routes/adsb.py::_features props dict. The EntityPanel promotes exactly
    # these (`snap.properties`) into the ontology.
    "aircraft": {
        "icao24": "id",
        "callsign": "str",
        "registration": "str",
        "type": "str",
        "category": "str",
        "on_ground": "bool",
        "velocity_ms": "num",
        "track_deg": "num",
        "baro_alt_m": "num",
        "geo_alt_m": "num",
        "squawk": "str",
        "emergency": "str",
        "nac_p": "num",
        "nic": "num",
        "sil": "num",
        "nac_v": "num",
        "seen_pos_s": "num",
        "seen_at": "ts",
        "source": "str",
    },
    # routes/ais.py::_normalise out dict.
    "vessel": {
        "mmsi": "id",
        "name": "str",
        "lat": "num",
        "lon": "num",
        "sog": "num",
        "cog": "num",
        "heading": "num",
        "shipType": "str",
        "msgType": "str",
        "t": "ts",
    },
    # intel/promotion.py::promote_incident assert_props.
    "incident": {
        "threat_level": "str",
        "score": "num",
        "domains": "str",
        "narrative": "str",
        "centroid": "geo",
    },
    # intel/evidence.py capture props.
    "evidence": {
        "sha256": "id",
        "captured_at": "ts",
        "captured_by": "str",
        "capture_method": "str",
        "filename": "str",
        "final_url": "str",
        "hash_algorithm": "str",
        "blob_present": "bool",
    },
}


# ── validation (warnings only) ────────────────────────────────────────────────


def validate_object(kind: str, props: dict[str, Any]) -> list[str]:
    """Sentences describing how ``props`` departs from what ``kind`` declares.

    An undeclared kind, or an undeclared property on a declared kind, is not a
    warning: kinds accrete faster than this table does, and a false warning on
    every OSINT mint would train everyone to ignore the field. Only a property
    whose declared type the value contradicts is worth saying out loud.
    """
    declared = PROP_TYPES.get(kind)
    if not declared:
        return []
    out: list[str] = []
    for name, value in props.items():
        want = declared.get(name)
        if want is None or value is None:
            continue
        if not _matches(want, value):
            out.append(
                f"{kind}.{name} is declared {want} but got "
                f"{type(value).__name__} ({value!r:.40})"
            )
    return out


def validate_link(rel: str, src_kind: str, dst_kind: str) -> list[str]:
    """Sentences describing how a link departs from its declared relation.

    An unknown ``rel`` warns once (it is probably a typo, or a model-invented
    verb worth promoting into ``REL_TYPES``) but the link is still writable.
    """
    rt = REL_TYPES.get(rel)
    if rt is None:
        return [f"{rel!r} is not a declared relation"]
    out: list[str] = []
    if rt.src and src_kind not in rt.src:
        out.append(
            f"{rel!r} expects a source of {_join(rt.src)} but got {src_kind!r}"
        )
    if rt.dst and dst_kind not in rt.dst:
        out.append(
            f"{rel!r} expects a target of {_join(rt.dst)} but got {dst_kind!r}"
        )
    return out


def label_for(rel: str, *, reverse: bool = False) -> str:
    """The human label for ``rel``, read forwards or from the target's end.

    Falls back to the raw verb with underscores opened up, so an invented
    relation still renders as words rather than as `snake_case`.
    """
    rt = REL_TYPES.get(rel)
    if rt is None:
        return rel.replace("_", " ")
    return rt.inverse if reverse else rt.forward


def schema_payload() -> dict[str, Any]:
    """The whole declared schema, shaped for ``GET /api/ontology/schema``."""
    return {
        "relations": {
            rel: {
                "forward": rt.forward,
                "inverse": rt.inverse,
                "src_kinds": sorted(rt.src),
                "dst_kinds": sorted(rt.dst),
            }
            for rel, rt in sorted(REL_TYPES.items())
        },
        "kinds": {
            kind: dict(sorted(props.items()))
            for kind, props in sorted(PROP_TYPES.items())
        },
    }


_NUMERIC = (int, float)


def _matches(want: PropType, value: Any) -> bool:
    # bool is an int subclass, so it has to be excluded from the numeric check
    # or every True would pass as a number.
    if want == "bool":
        return isinstance(value, bool)
    if want in ("num", "ts"):
        return isinstance(value, _NUMERIC) and not isinstance(value, bool)
    if want in ("str", "id"):
        # ids arrive as ints from AIS (mmsi) and as strings from ADS-B (icao24).
        return isinstance(value, (str, int)) and not isinstance(value, bool)
    if want == "geo":
        return isinstance(value, (list, tuple, dict))
    return True


def _join(kinds: frozenset[str]) -> str:
    return " or ".join(sorted(kinds))
