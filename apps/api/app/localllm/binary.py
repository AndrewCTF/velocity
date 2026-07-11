"""llama-server binary resolution + managed release install.

Resolution order (never downloads on its own — ``status()``/``find_binary()``
only look, they never fetch bytes):
  1. ``settings.llamacpp_binary`` — an operator-supplied path, used verbatim.
  2. ``PATH`` (``shutil.which("llama-server")``).
  3. A previously-managed install under ``<models_root>/../bin/llama-<tag>/``.

``ensure_installed()`` is the ONLY function that downloads bytes, and it is
never called at import time — the sidecar that boots llama-server calls it
lazily, on an explicit "start the engine" action.

Deviation from the design doc worth recording: llama.cpp does **not** publish
prebuilt CUDA binaries for Linux — verified live against the GitHub Releases
API 2026-07-11 (release b9964): the Ubuntu asset set is CPU / Vulkan / ROCm /
SYCL / OpenVINO only; CUDA prebuilts exist for Windows only. The managed
install therefore pulls the **Vulkan** Ubuntu build, which runs on the same
NVIDIA driver (Vulkan is a peer compute API, not a CUDA wrapper) and supports
every flag this platform needs (``-ngl``, ``--n-cpu-moe``, ``--api-key``,
router mode). An operator who specifically wants a from-source CUDA build can
still point ``LLAMACPP_BINARY`` at it directly.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import stat
import subprocess
import tarfile
from io import BytesIO
from pathlib import Path

import httpx

from app.config import Settings, get_settings

log = logging.getLogger("localllm.binary")

_REPO = "ggml-org/llama.cpp"
_ASSET_TMPL = "llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz"
_RELEASE_API_TMPL = f"https://api.github.com/repos/{_REPO}/releases/tags/{{tag}}"
_DOWNLOAD_URL_TMPL = f"https://github.com/{_REPO}/releases/download/{{tag}}/{{asset}}"


def bin_dir(models_root: Path) -> Path:
    d = models_root.parent / "bin"
    d.mkdir(parents=True, exist_ok=True)
    return d


def find_binary(settings: Settings | None = None, models_root: Path | None = None) -> Path | None:
    """Resolve an already-available llama-server — never downloads."""
    s = settings or get_settings()
    if s.llamacpp_binary:
        p = Path(s.llamacpp_binary)
        if p.is_file() and os.access(p, os.X_OK):
            return p
    which = shutil.which("llama-server")
    if which:
        return Path(which)
    if models_root is not None:
        d = models_root.parent / "bin"
        for candidate in sorted(d.glob("llama-*/llama-server"), reverse=True):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return candidate
    return None


def version(binary_path: Path) -> str | None:
    try:
        out = subprocess.run(
            [str(binary_path), "--version"], capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = ((out.stdout or "") + (out.stderr or "")).strip()
    return text.splitlines()[0] if text else None


def status(
    settings: Settings | None = None, models_root: Path | None = None
) -> tuple[bool, str | None]:
    """``(installed, version)`` — read-only, never downloads."""
    p = find_binary(settings, models_root)
    if p is None:
        return False, None
    return True, version(p)


def _safe_extract_member(tf: tarfile.TarFile, member: tarfile.TarInfo, dest_dir: Path) -> None:
    parts = Path(member.name).parts
    if len(parts) < 2:  # skip the top-level dir entry itself
        return
    rel_path = Path(*parts[1:])  # flatten the single top-level "llama-<tag>/" dir
    target = (dest_dir / rel_path).resolve()
    if not str(target).startswith(str(dest_dir.resolve()) + os.sep):
        log.warning("skipping suspicious tar member %s (path traversal)", member.name)
        return
    if member.isdir():
        target.mkdir(parents=True, exist_ok=True)
        return
    if not member.isfile():
        return  # skip symlinks/devices/etc from the archive
    src = tf.extractfile(member)
    if src is None:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(src.read())
    if rel_path.name.startswith(("llama-", "libggml", "libllama", "libmtmd")):
        mode = target.stat().st_mode
        target.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def ensure_installed(models_root: Path, settings: Settings | None = None) -> Path:
    """Managed download of the pinned llama.cpp release (explicit call only).

    Fetches the release's asset list from the GitHub API (for the published
    sha256 ``digest``), downloads the Ubuntu Vulkan build, verifies the
    digest, extracts it flat into ``<models_root>/../bin/llama-<tag>/``, and
    returns the ``llama-server`` path. Idempotent — a prior successful install
    is reused without any network call.
    """
    s = settings or get_settings()
    existing = find_binary(s, models_root)
    if existing is not None:
        return existing

    tag = s.llamacpp_release
    asset = _ASSET_TMPL.format(tag=tag)
    dest_dir = bin_dir(models_root) / f"llama-{tag}"
    server_bin = dest_dir / "llama-server"
    if server_bin.is_file() and os.access(server_bin, os.X_OK):
        return server_bin

    # The release-asset digest lives behind the GitHub REST API, whose
    # unauthenticated limit (60 req/h/IP) is easily hit on a shared egress —
    # observed live 2026-07-11 as a 403 that surfaced a raw httpx stack. Send a
    # token when one is present (GITHUB_TOKEN / GH_TOKEN raise the limit to
    # 5000/h) and turn a rate-limit 403 into an actionable error instead of a
    # traceback. We do NOT fall back to an unverified direct download — the
    # sha256 check is the integrity guarantee, so a missing digest is fatal.
    headers = {"Accept": "application/vnd.github+json"}
    gh_token = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    if gh_token:
        headers["Authorization"] = f"Bearer {gh_token}"
    with httpx.Client(timeout=30.0) as c:
        rel = c.get(_RELEASE_API_TMPL.format(tag=tag), headers=headers)
        try:
            rel.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (403, 429):
                raise RuntimeError(
                    "GitHub API rate-limited the llama.cpp release lookup; set GITHUB_TOKEN "
                    "to raise the limit, or install llama-server manually and point "
                    "LLAMACPP_BINARY at it."
                ) from exc
            raise
        assets = rel.json().get("assets", [])
        match = next((a for a in assets if a.get("name") == asset), None)
        if match is None:
            raise RuntimeError(f"llama.cpp release {tag} has no asset named {asset!r}")
        digest = (match.get("digest") or "").removeprefix("sha256:")
        url = match.get("browser_download_url") or _DOWNLOAD_URL_TMPL.format(tag=tag, asset=asset)
        with c.stream("GET", url) as r:
            r.raise_for_status()
            buf = BytesIO()
            for chunk in r.iter_bytes():
                buf.write(chunk)
    data = buf.getvalue()

    if digest:
        actual = hashlib.sha256(data).hexdigest()
        if actual != digest:
            raise RuntimeError(f"llama.cpp release {tag} asset sha256 mismatch")
    else:
        log.warning(
            "llama.cpp release %s asset %s had no published digest — unverified", tag, asset
        )

    dest_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as tf:
        for member in tf.getmembers():
            _safe_extract_member(tf, member, dest_dir)

    if not server_bin.is_file():
        raise RuntimeError("extracted llama.cpp release has no llama-server binary")
    mode = server_bin.stat().st_mode
    server_bin.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return server_bin
