"""Principal roles + least-privilege fallback (Gotham-substrate ACL)."""

from __future__ import annotations

import pytest

from app import security
from app.keys import UserCtx
from app.security import Principal


def _async_return(val: object):  # type: ignore[no-untyped-def]
    async def _f(*a: object, **k: object) -> object:
        return val
    return _f


class _Req:
    headers: dict = {}


def test_has_role_admin_is_superset() -> None:
    analyst = Principal("u", "t", roles=("analyst",))
    assert analyst.has_role("analyst")
    assert not analyst.has_role("auditor")
    admin = Principal("u", "t", roles=("admin",))
    assert admin.has_role("auditor")  # admin implies every role
    assert admin.has_role("analyst")


async def test_current_principal_least_privilege(monkeypatch: pytest.MonkeyPatch) -> None:
    # Profile store returns nothing → principal must NOT be elevated.
    monkeypatch.setattr(security, "_fetch_profile", _async_return({}))
    p = await security.current_principal(_Req(), UserCtx("u1", "tok"))  # type: ignore[arg-type]
    assert p.user_id == "u1"
    assert p.clearance == 0
    assert p.roles == ("analyst",)
    assert p.compartments == ()


async def test_current_principal_reads_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        security,
        "_fetch_profile",
        _async_return({"email": "a@b.c", "clearance": 3, "compartments": ["FVEY"], "roles": ["analyst", "auditor"]}),
    )
    p = await security.current_principal(_Req(), UserCtx("u1", "tok"))  # type: ignore[arg-type]
    assert p.clearance == 3
    assert p.has_role("auditor")
    assert p.compartments == ("FVEY",)
    assert p.email == "a@b.c"
