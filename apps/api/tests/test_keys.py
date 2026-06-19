"""BYOK key store: crypto, masking, catalog, and route wiring (hermetic)."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app import keys as byok
from app.config import Settings
from app.keys import UserCtx, current_user


def _settings_with_key() -> Settings:
    return Settings(byok_enc_key=Fernet.generate_key().decode())


def test_encrypt_decrypt_roundtrip() -> None:
    s = _settings_with_key()
    ct = byok.encrypt_value("super-secret-key-123", s)
    assert ct != "super-secret-key-123"
    assert byok.decrypt_value(ct, s) == "super-secret-key-123"


def test_decrypt_garbage_returns_none() -> None:
    s = _settings_with_key()
    assert byok.decrypt_value("not-a-valid-token", s) is None


def test_decrypt_with_wrong_key_returns_none() -> None:
    a = _settings_with_key()
    b = _settings_with_key()
    ct = byok.encrypt_value("abc", a)
    assert byok.decrypt_value(ct, b) is None


def test_mask() -> None:
    assert byok.mask("abcd1234") == "1234"
    assert byok.mask("xy") == "••"


def test_provider_catalog() -> None:
    assert "firms" in byok.PROVIDERS
    assert byok.PROVIDERS["firms"].wired is True
    assert "cesium_ion" in byok.PROVIDERS


@pytest.mark.anyio
async def test_resolve_user_key_no_token() -> None:
    assert await byok.resolve_user_key("", "firms") is None


def test_keys_requires_auth(client: TestClient) -> None:
    # Auth is disabled in test settings, but BYOK still needs a real user token.
    assert client.get("/api/keys").status_code == 401


def test_keys_crud_with_fake_user(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = lambda: UserCtx("u1", "tok")

    async def fake_list(ctx: UserCtx, s=None):  # type: ignore[no-untyped-def]
        return [{"provider": "firms", "hint": "9abc", "updated_at": "2026-06-19T00:00:00Z"}]

    async def fake_put(ctx: UserCtx, provider, value, s=None):  # type: ignore[no-untyped-def]
        return {"provider": provider, "hint": byok.mask(value), "updated_at": "now"}

    async def fake_del(ctx: UserCtx, provider, s=None):  # type: ignore[no-untyped-def]
        return None

    monkeypatch.setattr(byok, "list_keys", fake_list)
    monkeypatch.setattr(byok, "put_key", fake_put)
    monkeypatch.setattr(byok, "delete_key", fake_del)

    r = client.get("/api/keys")
    assert r.status_code == 200
    body = r.json()
    assert any(p["id"] == "firms" for p in body["providers"])
    assert body["keys"][0]["provider"] == "firms"

    r = client.put("/api/keys/firms", json={"value": "MYFIRMSKEY"})
    assert r.status_code == 200
    assert r.json()["hint"] == "SKEY"

    r = client.put("/api/keys/bogus", json={"value": "x"})
    assert r.status_code == 400

    r = client.delete("/api/keys/firms")
    assert r.status_code == 204

    client.app.dependency_overrides.pop(current_user, None)
