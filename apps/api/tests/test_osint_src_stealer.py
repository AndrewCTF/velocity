"""Unit tests for `app/osint/sources/stealer.py` — no live network.

Payloads are trimmed copies of what cavalier.hudsonrock.com actually returned
on 2026-08-29, including the two things that make this connector easy to get
wrong: a clean target is a real answer (not a failure), and every response
carries live credentials that must never come out the other side.
"""

from __future__ import annotations

from app.osint.sources import stealer as S

# Trimmed from the real response for test@gmail.com. top_passwords/top_logins
# are kept HERE on purpose — they are what the connector has to drop.
_INFECTED = {
    "message": "This email address is associated with a computer that was infected",
    "stealers": [
        {
            "total_corporate_services": 8,
            "total_user_services": 370,
            "date_compromised": "2026-08-27T19:02:40.000Z",
            "stealer_family": "Lumma",
            "computer_name": "DESKTOP-U1NSLMA (Dell)",
            "operating_system": "Windows 10 Pro 22H2 (Build 19045)",
            "malware_path": "C:\\Users\\x\\AppData\\Local\\Temp\\a.exe",
            "antiviruses": ["Windows Defender"],
            "ip": "157.50.***.**",
            "top_passwords": ["hunter2", "correcthorse"],
            "top_logins": ["victim@example.com"],
        },
        {
            "date_compromised": "2026-01-02T00:00:00.000Z",
            "stealer_family": "RedLine",
            "computer_name": "LAPTOP-2",
            "operating_system": "Windows 11",
            "antiviruses": [],
            "top_passwords": ["s3cret"],
        },
    ],
    "total_corporate_services": 8,
    "total_user_services": 370,
}

_CLEAN = {
    "message": "This email address is not associated with a computer infected by an info-stealer.",
    "stealers": [],
    "total_corporate_services": 0,
    "total_user_services": 0,
}

_DOMAIN = {
    "total": 6486,
    "totalStealers": 36241892,
    "employees": 0,
    "users": 6460,
    "third_parties": 26,
    "data": {
        "all_urls": [
            {"url": "https://edition.cnn.com/account/register", "type": "User", "occurrence": 2447},
            {"url": "https://cnn.com/login", "type": "Employee", "occurrence": 3},
            {"type": "User", "occurrence": 1},  # no url: skipped, not crashed
        ]
    },
    "last_employee_compromised": "1970-01-01T00:00:00.000Z",
    "last_user_compromised": "2026-08-26T20:39:30.000Z",
}


def _fake(payload):  # type: ignore[no-untyped-def]
    async def f(url, ttl, **kw):  # type: ignore[no-untyped-def]
        return payload
    return f


# ── the rule the whole module exists to enforce ────────────────────────────


async def test_credentials_never_leave_the_connector(monkeypatch) -> None:
    monkeypatch.setattr(S, "fetch_json", _fake(_INFECTED))
    out = await S.hudsonrock_email("test@gmail.com")
    blob = repr(out)
    assert "hunter2" not in blob
    assert "correcthorse" not in blob
    assert "s3cret" not in blob
    assert "victim@example.com" not in blob
    assert "top_passwords" not in blob
    assert "top_logins" not in blob


# ── email ──────────────────────────────────────────────────────────────────


async def test_email_infected_shape(monkeypatch) -> None:
    monkeypatch.setattr(S, "fetch_json", _fake(_INFECTED))
    out = await S.hudsonrock_email("Test@Gmail.com")
    assert out["indicator"] == "test@gmail.com"      # normalised
    assert out["checked"] is True
    assert out["infected"] is True
    assert out["computer_count"] == 2
    assert out["stealer_families"] == ["Lumma", "RedLine"]
    assert out["corporate_services"] == 8
    assert out["computers"][0]["computer_name"] == "DESKTOP-U1NSLMA (Dell)"
    assert out["computers"][0]["antiviruses"] == ["Windows Defender"]
    # An absent field is absent, not an invented empty string.
    assert "ip" not in out["computers"][1]


async def test_email_clean_is_a_finding_not_a_failure(monkeypatch) -> None:
    monkeypatch.setattr(S, "fetch_json", _fake(_CLEAN))
    out = await S.hudsonrock_email("nobody@example.com")
    assert out["checked"] is True
    assert out["infected"] is False
    assert out["computer_count"] == 0
    assert "note" not in out


async def test_email_upstream_down(monkeypatch) -> None:
    monkeypatch.setattr(S, "fetch_json", _fake(None))
    out = await S.hudsonrock_email("a@b.com")
    assert out["checked"] is False and out["infected"] is False
    assert out["note"]


async def test_email_invalid_target_never_fetches(monkeypatch) -> None:
    async def boom(*a: object, **k: object) -> None:
        raise AssertionError("must validate before fetching")

    monkeypatch.setattr(S, "fetch_json", boom)
    out = await S.hudsonrock_email("not-an-email")
    assert out["checked"] is False and "note" in out


# ── username ───────────────────────────────────────────────────────────────


async def test_username_shape(monkeypatch) -> None:
    monkeypatch.setattr(S, "fetch_json", _fake(_INFECTED))
    out = await S.hudsonrock_username("TestUser")
    assert out["indicator"] == "testuser"
    assert out["infected"] is True and out["computer_count"] == 2


async def test_username_invalid(monkeypatch) -> None:
    out = await S.hudsonrock_username("has.a.dot")
    assert out["checked"] is False and "note" in out


# ── domain ─────────────────────────────────────────────────────────────────


async def test_domain_shape(monkeypatch) -> None:
    monkeypatch.setattr(S, "fetch_json", _fake(_DOMAIN))
    out = await S.hudsonrock_domain("CNN.com")
    assert out["indicator"] == "cnn.com"
    assert out["checked"] is True
    assert out["total"] == 6486
    assert out["users"] == 6460 and out["third_parties"] == 26
    assert [u["url"] for u in out["urls"]] == [
        "https://edition.cnn.com/account/register",
        "https://cnn.com/login",
    ]


async def test_domain_drops_the_epoch_zero_never_sentinel(monkeypatch) -> None:
    # The upstream says 1970-01-01 for "no employee was ever compromised".
    # Rendering that claims a breach that did not happen.
    monkeypatch.setattr(S, "fetch_json", _fake(_DOMAIN))
    out = await S.hudsonrock_domain("cnn.com")
    assert out["last_employee_compromised"] == ""
    assert out["last_user_compromised"] == "2026-08-26T20:39:30.000Z"


async def test_domain_upstream_down(monkeypatch) -> None:
    monkeypatch.setattr(S, "fetch_json", _fake({"unexpected": True}))
    out = await S.hudsonrock_domain("cnn.com")
    assert out["checked"] is False and out["total"] == 0 and out["note"]


async def test_bounds_hold(monkeypatch) -> None:
    monkeypatch.setattr(
        S, "fetch_json",
        _fake({"stealers": [{"computer_name": f"PC{i}"} for i in range(50)]}),
    )
    out = await S.hudsonrock_email("a@b.com")
    assert len(out["computers"]) == S._MAX_COMPUTERS
    # The count stays honest even though the list is truncated.
    assert out["computer_count"] == 50
