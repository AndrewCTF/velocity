"""The ONE environment builder for every long-lived child the API spawns.

The sidecars used to start from ``{**os.environ, ...}``, so headless Chrome
browsing third-party sites, llama.cpp, vLLM and the MAVLink bridge all received
``API_KEY``, ``SUPABASE_JWT_SECRET``, ``BYOK_ENC_KEY`` and every provider key the
backend holds. None of them reads any of those; a renderer or sidecar compromise
exposed all of them (ASVS V13.3.2).

So a child now starts from an ALLOWLIST: what a process needs to find binaries,
locales, certificates, proxies and GPUs, plus the names and prefixes its own
code reads (each spawner passes those). Anything else is dropped by construction,
including run-api.sh's jemalloc ``LD_PRELOAD`` / ``MALLOC_CONF`` pair, which kills
Chrome's zygote fork at spawn (bisected 2026-07-04, see ``adsb_sidecar.start()``).

Keep additions narrow. Before adding a name, check the child actually reads it
(``process.env.`` in the tools/ index.js files, ``os.environ`` in the bridge).
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping

# Names every child may inherit: process basics, locale, TLS trust, proxies.
_BASE_NAMES = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LANGUAGE",
        "TZ",
        "TMPDIR",
        "XDG_RUNTIME_DIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "LD_LIBRARY_PATH",
    }
)
_BASE_PREFIXES = ("LC_",)

# GPU runtimes (llama.cpp's Vulkan/CUDA builds, vLLM's torch).
GPU_PREFIXES = ("CUDA_", "NVIDIA_", "VK_", "MESA_", "GGML_", "__GLX_", "__NV_")

# Headless Chrome under Playwright.
BROWSER_NAMES = frozenset({"NODE_PATH", "CHROME_PATH", "DISPLAY", "XAUTHORITY"})
BROWSER_PREFIXES = ("PLAYWRIGHT_",)


def child_env(
    extra: Mapping[str, str] | None = None,
    *,
    keep_names: Iterable[str] = (),
    keep_prefixes: Iterable[str] = (),
    source: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Allowlisted copy of ``source`` (default ``os.environ``) plus ``extra``.

    ``keep_names`` / ``keep_prefixes`` widen the allowlist for one child (its own
    tuning knobs); ``extra`` values are set last and always win.
    """
    src = os.environ if source is None else source
    names = _BASE_NAMES | frozenset(keep_names)
    prefixes = _BASE_PREFIXES + tuple(keep_prefixes)
    env = {k: v for k, v in src.items() if k in names or k.startswith(prefixes)}
    # Never forward the jemalloc pair, even if a caller listed it by prefix.
    env.pop("LD_PRELOAD", None)
    env.pop("MALLOC_CONF", None)
    if extra:
        env.update({k: str(v) for k, v in extra.items()})
    return env
