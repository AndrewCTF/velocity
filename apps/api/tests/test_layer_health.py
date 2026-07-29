"""Guards: nothing fails silently, and the fix advice cannot drift from the code.

The largest single cluster of complaints on the highest-scoring launch in this
category was not a missing feature. It was a map that rendered blank because a
key was missing and nothing said so:

    "There's no data when I tried it on a windows 11 PC ... No planes etc. No
     helpful output in the command window."          - u/rustyhancock
    "Yeah this doesn't work on Mac either. This is just broken and
     nonfunctioning."                                - u/DetroitThrow

and the author's own diagnosis, "it's silently failing to fetch the streams".
A commenter separately had to work out that the README named
OPENSKY_USERNAME/OPENSKY_PASSWORD while the code read
OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET; the reply was "the perils of vibe
coding". See docs/research-last30days-2026-07-29.md §5.1 and §5.2.

So the doctor endpoint is generated from the Settings model rather than written
in prose, and this module pins that property.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import get_settings
from app.routes.status import _OPTIONAL_CAPABILITIES


def test_every_capability_names_settings_the_code_actually_reads() -> None:
    """The anti-drift guard. If a setting is renamed and this list is not, the
    endpoint would hand the operator a fix line that does nothing."""
    fields = set(type(get_settings()).model_fields)
    for cap, names, _consequence in _OPTIONAL_CAPABILITIES:
        assert names, f"{cap} names no settings"
        for n in names:
            assert n in fields, f"{cap} names {n!r}, which Settings does not define"


def test_every_capability_says_what_is_lost_without_it() -> None:
    """"Not configured" on its own is not information. The operator needs to know
    whether to care."""
    for cap, _names, consequence in _OPTIONAL_CAPABILITIES:
        assert len(consequence) > 30, f"{cap} does not explain the consequence"
        # Copy rule: operator-visible text carries no em dashes (CLAUDE.md).
        assert "—" not in consequence


def test_doctor_reports_state_and_a_fix_without_leaking_values(client: TestClient) -> None:
    r = client.get("/api/status/doctor")
    assert r.status_code == 200
    body = r.json()

    assert body["required_missing"] == 0, "nothing here may be required; the console is keyless"
    assert isinstance(body["problems"], list)
    assert isinstance(body["configured"], list)

    settings = get_settings()
    for p in body["problems"]:
        assert p["capability"]
        assert p["state"] in {"not-configured", "misconfigured-check"}
        assert p["detail"]
        if p["state"] == "not-configured":
            # The fix must be the literal line to add, in the case an env file uses.
            assert p["fix"] and "=" in p["fix"]
            assert p["fix"] == p["fix"].upper().replace("...", "...")
        # No secret may appear anywhere in the payload, set or unset.
        for name in type(settings).model_fields:
            val = getattr(settings, name, None)
            if isinstance(val, str) and len(val) >= 8:
                assert val not in r.text, f"doctor leaked the value of {name}"


def test_a_capability_never_appears_as_both_configured_and_a_problem(
    client: TestClient,
) -> None:
    body = client.get("/api/status/doctor").json()
    problems = {p["capability"] for p in body["problems"]}
    assert problems.isdisjoint(set(body["configured"]))
    assert len(problems) + len(body["configured"]) == len(_OPTIONAL_CAPABILITIES)
