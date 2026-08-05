"""A bounded worker pool over the local model, so batch work runs wide.

Every model call in this codebase is one-shot and serial to its caller: a route
awaits `llm.complete()` and nothing else in that request happens until it comes
back. That is correct for a selection brief and useless for the thing the
platform actually needs to do, which is push hundreds of raw documents through a
model to turn them into structured facts. Done serially, a few hundred NOTAMs is
an hour.

llama-server is already a concurrent server. It is launched with `--parallel N`
(`llamacpp_parallel`, default 2), which allocates N KV-cache slots and decodes N
sequences at once. Sending N+1 requests does not make it faster; it makes them
queue inside the server where this process cannot see the queue, cancel it or
report it. So the pool's width is the SERVER's width, read from the same place
the server got it, and the queue lives here where it can be measured.

Nothing about this is speculative concurrency: `slots()` returns what the sidecar
was actually started with, `map_prompts` never runs more than that at once, and
`stats()` reports what was measured rather than what was configured.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from app import llm
from app.config import get_settings

#: Hard ceiling on a single batch. Not a tuning knob — a guard against a caller
#: handing the pool an unbounded list and pinning the GPU for an hour.
MAX_BATCH = 512


def slots() -> int:
    """Concurrent decode slots the local engine can actually serve.

    Engine-aware on purpose. For llama.cpp this is the value the sidecar was
    launched with (`llamacpp_sidecar.py` passes the same setting to
    `--parallel`), so the pool and the server agree by construction. Ollama's
    width is `OLLAMA_NUM_PARALLEL` inside a process this one did not start, so
    it is read from the environment and falls back to 1 rather than guessing: a
    pool wider than the server just moves the queue somewhere it cannot be
    measured, which is the whole thing this module exists to avoid.

    `LLM_POOL_WIDTH` overrides both, for a cloud tier or a hand-tuned box.
    """
    s = get_settings()
    override = os.environ.get("LLM_POOL_WIDTH", "").strip()
    if override.isdigit() and int(override) > 0:
        return int(override)
    try:
        engine = llm.local_engine()
    except Exception:  # noqa: BLE001 — resolver touches optional subsystems
        engine = "llamacpp"
    if engine == "ollama":
        n = os.environ.get("OLLAMA_NUM_PARALLEL", "").strip()
        if n.isdigit() and int(n) > 0:
            return int(n)
        # Ollama auto-sizes its own parallelism when the variable is unset, so
        # an unset variable does not mean serial. This started at 1 and the
        # sweep proved that wrong: at width 8 the same 12 documents finished in
        # 4.3 s against 32.0 s at width 1, a measured 7.4x, on a server whose
        # declared slot count was 1 (docs/perf-results-llm-pool-2026-08-05.md).
        # 4 is Ollama's own documented default and is what the pool assumes.
        return 4
    return max(1, int(s.llamacpp_parallel or 1))


def describe() -> dict[str, Any]:
    """What the pool would do right now, for the batch route and the harness."""
    try:
        engine = llm.local_engine()
    except Exception:  # noqa: BLE001
        engine = "unknown"
    return {
        "engine": engine,
        "slots": slots(),
        "max_batch": MAX_BATCH,
        "width_source": (
            "LLM_POOL_WIDTH"
            if os.environ.get("LLM_POOL_WIDTH", "").strip().isdigit()
            else ("OLLAMA_NUM_PARALLEL" if engine == "ollama" else "llamacpp_parallel")
        ),
    }


@dataclass
class BatchStats:
    """What a batch actually did. Measured, not configured."""

    submitted: int = 0
    completed: int = 0
    failed: int = 0
    slots: int = 0
    wall_s: float = 0.0
    latencies_s: list[float] = field(default_factory=list)

    @property
    def throughput_per_s(self) -> float:
        return (self.completed / self.wall_s) if self.wall_s > 0 else 0.0

    def _pct(self, q: float) -> float:
        if not self.latencies_s:
            return 0.0
        xs = sorted(self.latencies_s)
        i = min(len(xs) - 1, int(round(q * (len(xs) - 1))))
        return xs[i]

    def as_dict(self) -> dict[str, Any]:
        return {
            "submitted": self.submitted,
            "completed": self.completed,
            "failed": self.failed,
            "slots": self.slots,
            "wall_s": round(self.wall_s, 3),
            "throughput_per_s": round(self.throughput_per_s, 3),
            "p50_s": round(self._pct(0.5), 3),
            "p95_s": round(self._pct(0.95), 3),
            "max_s": round(max(self.latencies_s), 3) if self.latencies_s else 0.0,
        }


async def map_bounded[T](
    items: Sequence[T],
    work: Callable[[T], Awaitable[Any]],
    *,
    width: int | None = None,
) -> tuple[list[Any], BatchStats]:
    """Run `work` over `items`, at most `width` at a time, order preserved.

    A failed item resolves to ``None`` in its slot rather than taking the batch
    down: a batch of 300 documents where 2 time out has produced 298 answers,
    and throwing them away to raise is the wrong trade every time.
    """
    if len(items) > MAX_BATCH:
        raise ValueError(f"batch of {len(items)} exceeds MAX_BATCH={MAX_BATCH}")
    n = width if width and width > 0 else slots()
    sem = asyncio.Semaphore(n)
    stats = BatchStats(submitted=len(items), slots=n)
    out: list[Any] = [None] * len(items)
    lock = asyncio.Lock()

    async def run(i: int, item: T) -> None:
        async with sem:
            t0 = time.monotonic()
            try:
                out[i] = await work(item)
                ok = True
            except Exception:  # noqa: BLE001 — one bad item must not kill the batch
                out[i] = None
                ok = False
            dt = time.monotonic() - t0
            async with lock:
                stats.latencies_s.append(dt)
                if ok:
                    stats.completed += 1
                else:
                    stats.failed += 1

    t0 = time.monotonic()
    await asyncio.gather(*(run(i, it) for i, it in enumerate(items)))
    stats.wall_s = time.monotonic() - t0
    return out, stats


async def map_prompts(
    system: str,
    users: Sequence[str],
    *,
    width: int | None = None,
    json_mode: bool = False,
    max_tokens: int = 512,
    temperature: float = 0.1,
    tier: str = "fast",
    label: str = "pool",
    timeout_s: float | None = 120.0,
) -> tuple[list[str | None], BatchStats]:
    """One shared system prompt, many user messages, run `width` at a time.

    The shared prefix is the reason this shape is worth having rather than a
    generic gather: llama-server's prefix cache (`--cache-reuse`) keeps the
    system prompt's KV across slots, so a batch of N documents against one
    instruction pays for that instruction roughly once.
    """

    async def one(u: str) -> str | None:
        r = await llm.complete(
            system,
            u,
            tier=tier,
            json_mode=json_mode,
            max_tokens=max_tokens,
            temperature=temperature,
            label=label,
            timeout_s=timeout_s,
        )
        text = getattr(r, "text", None)
        return text if text else None

    return await map_bounded(list(users), one, width=width)


async def map_structured(
    system: str,
    users: Sequence[str],
    **kwargs: Any,
) -> tuple[list[Any], BatchStats]:
    """`map_prompts` in JSON mode, parsed. An item that does not parse is None.

    Deliberately not "retry until it parses". A model that will not produce the
    schema for a document is reporting something about the document, and burning
    three more decodes to hide that is how a batch job quietly becomes a
    fabrication engine.
    """
    kwargs.setdefault("json_mode", True)
    texts, stats = await map_prompts(system, users, **kwargs)
    parsed = [llm.extract_json(t) if t else None for t in texts]
    # A response that came back but did not parse is a failure of the batch's
    # purpose even though the call succeeded, so the count says so.
    for t, p in zip(texts, parsed, strict=True):
        if t and p is None:
            stats.completed -= 1
            stats.failed += 1
    return parsed, stats
