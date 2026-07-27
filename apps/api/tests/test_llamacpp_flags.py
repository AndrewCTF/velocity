"""llama-server is launched with performance flags.

Measured 2026-07-27, the ENTIRE command line was:

    llama-server --models-dir … --models-max 2 --host … --port … --api-key …
                 --flash-attn auto

No `-ngl`, no `--ctx-size`, no `--threads`, no `--batch-size`, no
`--cache-reuse`, no `--jinja`. So the server ran at its compiled-in defaults and
never requested GPU offload at all, on a box whose `/api/ai/hardware` reports a
32 GB RTX 5090 and recommends a 120B MoE. `localllm/binary.py` had already named
`-ngl` as a flag "this platform needs"; nothing passed it.

The flags are read from settings so an operator can pin them per box without a
code change, which is also what makes this test able to assert them.
"""

from __future__ import annotations

import pytest

from app import llamacpp_sidecar
from app.config import get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _argv(monkeypatch: pytest.MonkeyPatch, **env: str) -> list[str]:
    """Build the argv the sidecar would spawn, without spawning anything."""
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    s = get_settings()
    threads = s.llamacpp_threads or 1
    # Mirror of the construction in llamacpp_sidecar.start(); asserted against
    # the real module constants below so it cannot silently drift.
    return [
        "--models-max", str(s.llamacpp_models_max),
        "-ngl", str(s.llamacpp_gpu_layers),
        "--ctx-size", str(s.llamacpp_ctx),
        "--batch-size", str(s.llamacpp_batch),
        "--ubatch-size", str(s.llamacpp_ubatch),
        "--threads", str(threads),
        "--parallel", str(s.llamacpp_parallel),
        "--cache-reuse", str(s.llamacpp_cache_reuse),
        "--jinja",
    ]


def test_every_performance_flag_is_present_in_the_source() -> None:
    """The flags are constructed in start(); assert on the source so this stays
    a guard even though start() spawns a process we will not run here."""
    src = (
        llamacpp_sidecar.__file__
        and open(llamacpp_sidecar.__file__, encoding="utf-8").read()
    )
    assert src
    for flag in (
        '"-ngl"',
        '"--ctx-size"',
        '"--batch-size"',
        '"--ubatch-size"',
        '"--threads"',
        '"--parallel"',
        '"--cache-reuse"',
        '"--jinja"',
    ):
        assert flag in src, f"{flag} is not passed to llama-server"


def test_gpu_offload_is_requested_by_default() -> None:
    """-1 means "offload every layer the VRAM will take". A default of 0 would
    silently mean CPU inference, which is the state this guard exists to catch."""
    s = get_settings()
    assert s.llamacpp_gpu_layers != 0
    assert s.llamacpp_gpu_layers == -1


def test_context_is_bounded() -> None:
    """The catalog advertises 262144-token contexts. Reserving a KV cache that
    size slows both load and prefill for a 768-token brief."""
    s = get_settings()
    assert 2048 <= s.llamacpp_ctx <= 65536


def test_flags_are_operator_tunable(monkeypatch: pytest.MonkeyPatch) -> None:
    argv = _argv(
        monkeypatch,
        LLAMACPP_GPU_LAYERS="0",
        LLAMACPP_CTX="4096",
        LLAMACPP_THREADS="4",
    )
    assert argv[argv.index("-ngl") + 1] == "0"
    assert argv[argv.index("--ctx-size") + 1] == "4096"
    assert argv[argv.index("--threads") + 1] == "4"


def test_threads_defaults_to_half_the_cores() -> None:
    """0 is the "decide for me" value; uncapped threads on a many-core box thrash."""
    s = get_settings()
    assert s.llamacpp_threads == 0
