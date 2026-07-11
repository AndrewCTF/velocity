"""Unit tests for app.localllm.binary — resolution + managed install.

No real network: ``httpx.Client`` is replaced with an in-memory fake that
serves a hand-built tar.gz "release asset" so ``ensure_installed`` is
exercised end to end (digest verify, extraction, chmod) without touching the
network. Confirms the binary is never fetched merely by importing the module
or calling the read-only ``status()``/``find_binary()`` helpers.
"""

from __future__ import annotations

import hashlib
import io
import os
import tarfile
from pathlib import Path

import pytest

from app.config import Settings
from app.localllm import binary


def _settings(**kw) -> Settings:
    return Settings(cesium_ion_token="t", database_url="postgresql+asyncpg://x:x@localhost/x", **kw)


# ── find_binary / status — read-only, never download ────────────────────────


def test_find_binary_prefers_operator_override(tmp_path: Path) -> None:
    p = tmp_path / "llama-server"
    p.write_text("#!/bin/sh\necho fake\n")
    p.chmod(0o755)
    s = _settings(llamacpp_binary=str(p))
    assert binary.find_binary(s) == p


def test_find_binary_falls_back_to_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    p = tmp_path / "llama-server"
    p.write_text("x")
    p.chmod(0o755)
    monkeypatch.setattr(binary.shutil, "which", lambda name: str(p) if name == "llama-server" else None)
    s = _settings(llamacpp_binary="")
    assert binary.find_binary(s) == p


def test_find_binary_none_when_nothing_available(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(binary.shutil, "which", lambda name: None)
    s = _settings(llamacpp_binary="")
    assert binary.find_binary(s, models_root=tmp_path / "models") is None


def test_status_never_touches_network(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # No httpx patch at all — if status() tried a real network call this
    # test would hang/fail in a sandboxed environment.
    monkeypatch.setattr(binary.shutil, "which", lambda name: None)
    s = _settings(llamacpp_binary="")
    installed, version = binary.status(s, models_root=tmp_path / "models")
    assert installed is False
    assert version is None


# ── ensure_installed — managed download, fully mocked network ───────────────


def _build_fake_release_tarball(tag: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        top = f"llama-{tag}"

        def add(name: str, content: bytes) -> None:
            data = io.BytesIO(content)
            info = tarfile.TarInfo(name=f"{top}/{name}")
            info.size = len(content)
            tf.addfile(info, data)

        add("llama-server", b"#!/bin/sh\necho fake-llama-server\n")
        add("libggml-base.so", b"fake-shared-lib")
        add("LICENSE", b"MIT")
    return buf.getvalue()


class _FakeResponse:
    def __init__(self, json_body=None, content: bytes = b""):
        self._json = json_body
        self._content = content

    def raise_for_status(self) -> None:
        pass

    def json(self):
        return self._json

    def iter_bytes(self):
        yield self._content

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeClient:
    def __init__(self, asset_name: str, tarball: bytes, digest: str | None):
        self._asset_name = asset_name
        self._tarball = tarball
        self._digest = digest

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, headers=None):
        assert "releases/tags/" in url
        asset = {"name": self._asset_name, "browser_download_url": "https://example.invalid/asset"}
        if self._digest:
            asset["digest"] = f"sha256:{self._digest}"
        return _FakeResponse(json_body={"assets": [asset]})

    def stream(self, method, url):
        assert method == "GET"
        return _FakeResponse(content=self._tarball)


def test_ensure_installed_downloads_verifies_and_extracts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tag = "b9964"
    tarball = _build_fake_release_tarball(tag)
    digest = hashlib.sha256(tarball).hexdigest()
    asset_name = f"llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz"

    monkeypatch.setattr(binary.shutil, "which", lambda name: None)
    monkeypatch.setattr(
        binary.httpx, "Client", lambda timeout=30.0: _FakeClient(asset_name, tarball, digest)
    )

    models_root = tmp_path / "models"
    models_root.mkdir()
    s = _settings(llamacpp_binary="", llamacpp_release=tag)

    server_bin = binary.ensure_installed(models_root, s)
    assert server_bin.name == "llama-server"
    assert server_bin.is_file()
    assert os.access(server_bin, os.X_OK)
    assert (server_bin.parent / "libggml-base.so").is_file()

    # bin dir lives beside (not inside) the models root.
    assert server_bin.parent.parent == models_root.parent / "bin"


def test_ensure_installed_rejects_bad_digest(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tag = "b9964"
    tarball = _build_fake_release_tarball(tag)
    asset_name = f"llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz"

    monkeypatch.setattr(binary.shutil, "which", lambda name: None)
    monkeypatch.setattr(
        binary.httpx,
        "Client",
        lambda timeout=30.0: _FakeClient(asset_name, tarball, "0" * 64),  # wrong digest
    )

    models_root = tmp_path / "models"
    models_root.mkdir()
    s = _settings(llamacpp_binary="", llamacpp_release=tag)

    with pytest.raises(RuntimeError, match="sha256 mismatch"):
        binary.ensure_installed(models_root, s)


def test_ensure_installed_idempotent_no_second_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    tag = "b9964"
    tarball = _build_fake_release_tarball(tag)
    digest = hashlib.sha256(tarball).hexdigest()
    asset_name = f"llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz"

    monkeypatch.setattr(binary.shutil, "which", lambda name: None)
    calls = {"n": 0}

    def _client_factory(timeout=30.0):
        calls["n"] += 1
        return _FakeClient(asset_name, tarball, digest)

    monkeypatch.setattr(binary.httpx, "Client", _client_factory)

    models_root = tmp_path / "models"
    models_root.mkdir()
    s = _settings(llamacpp_binary="", llamacpp_release=tag)

    binary.ensure_installed(models_root, s)
    assert calls["n"] == 1
    binary.ensure_installed(models_root, s)  # second call — must not re-download
    assert calls["n"] == 1


def test_ensure_installed_rejects_traversal_and_symlink_members(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``_safe_extract_member``'s zip-slip/path-traversal guard, exercised
    end-to-end through ``ensure_installed``: a member named like
    ``llama-<tag>/../evil.so`` must never land outside ``dest_dir``, and a
    symlink member must never be materialized on disk at all."""
    tag = "b9964"
    top = f"llama-{tag}"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        def add(name: str, content: bytes) -> None:
            data = io.BytesIO(content)
            info = tarfile.TarInfo(name=f"{top}/{name}")
            info.size = len(content)
            tf.addfile(info, data)

        add("llama-server", b"#!/bin/sh\necho fake-llama-server\n")

        # Path-traversal ("zip-slip") member: escapes the flattened dest_dir.
        evil_content = b"evil-payload"
        evil_info = tarfile.TarInfo(name=f"{top}/../evil.so")
        evil_info.size = len(evil_content)
        tf.addfile(evil_info, io.BytesIO(evil_content))

        # Symlink member pointing outside the extraction root entirely.
        link_info = tarfile.TarInfo(name=f"{top}/evil-link")
        link_info.type = tarfile.SYMTYPE
        link_info.linkname = "/etc/passwd"
        tf.addfile(link_info)
    tarball = buf.getvalue()
    digest = hashlib.sha256(tarball).hexdigest()
    asset_name = f"llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz"

    monkeypatch.setattr(binary.shutil, "which", lambda name: None)
    monkeypatch.setattr(
        binary.httpx, "Client", lambda timeout=30.0: _FakeClient(asset_name, tarball, digest)
    )

    models_root = tmp_path / "models"
    models_root.mkdir()
    s = _settings(llamacpp_binary="", llamacpp_release=tag)

    server_bin = binary.ensure_installed(models_root, s)
    assert server_bin.is_file()  # the legitimate member still extracts fine
    dest_dir = server_bin.parent

    # The traversal member must not exist ANYWHERE outside dest_dir.
    assert not (dest_dir.parent / "evil.so").exists()
    assert not (models_root.parent / "evil.so").exists()
    # Nor inside dest_dir under any flattened name.
    assert not any(p.name == "evil.so" for p in dest_dir.rglob("*"))
    # The symlink member must never have been materialized.
    assert not (dest_dir / "evil-link").exists()
    assert not (dest_dir / "evil-link").is_symlink()


def test_ensure_installed_missing_asset_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(binary.shutil, "which", lambda name: None)

    class _EmptyClient(_FakeClient):
        def get(self, url, headers=None):
            return _FakeResponse(json_body={"assets": []})

    monkeypatch.setattr(binary.httpx, "Client", lambda timeout=30.0: _EmptyClient("x", b"", None))

    models_root = tmp_path / "models"
    models_root.mkdir()
    s = _settings(llamacpp_binary="", llamacpp_release="b9964")

    with pytest.raises(RuntimeError, match="no asset"):
        binary.ensure_installed(models_root, s)
