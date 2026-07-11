"""The curated Unsloth GGUF catalog — 7 tiers, one top pick each, plus a
runner-up. Pure data, verified live against huggingface.co/unsloth by the
2026-07-11 research pass (research-model-catalog.md); quant sizes are the
figures actually published there, not fabricated — a tier only lists the
quants that research verified, so some tiers carry one quant, others two.

Repo ids are always ``unsloth/...`` — the org the download route restricts
custom repos to as well (``manager.REPO_ID_PATTERN``), so a user-typed custom
repo and a catalog pick go through the exact same validation + download path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Ascending "size" order — used to pick "largest tier that fits" for presets.
TIER_ORDER: tuple[str, ...] = ("8b", "30b", "70b", "120b", "200b", "300b", "700b")


@dataclass(frozen=True)
class Quant:
    q: str
    size_gb: float


@dataclass(frozen=True)
class RunnerUp:
    repo_id: str
    label: str
    # Best-effort per each family's published docs (not re-verified live like
    # the quant sizes above) — see CatalogEntry.is_reasoning for what this
    # flag is/isn't used for.
    is_reasoning: bool = False


@dataclass(frozen=True)
class CatalogEntry:
    tier: str
    label: str
    repo_id: str
    params: str
    active_params: str
    ctx: int
    license: str
    recommended_quant: str
    quants: tuple[Quant, ...]
    runner_up: RunnerUp | None = None
    # True when the model emits a thinking/reasoning preamble before its
    # answer (Qwen3-family "thinking" mode, gpt-oss's harmony reasoning_effort,
    # GLM/DeepSeek-R1-style reasoners, …). Best-effort from each family's
    # published docs, not independently verified live the way quant sizes are.
    # Correctness of local inference does NOT depend on this flag being
    # perfectly accurate — app.llm's `_llamacpp_chat`/`_vllm_chat` send
    # `chat_template_kwargs.enable_thinking: false` + `reasoning_effort: low`
    # and strip any `<think>` block regardless of which model is active; this
    # flag only informs `selection_default_repo_id()` below (and any future
    # UI hint) so a reasoning model isn't picked as the selection-brief
    # default when a non-reasoning alternative is available.
    is_reasoning: bool = False

    def quant(self, q: str) -> Quant | None:
        for entry in self.quants:
            if entry.q == q:
                return entry
        return None

    @property
    def recommended(self) -> Quant:
        rec = self.quant(self.recommended_quant)
        if rec is None:  # defensive — every entry below carries its recommended quant
            raise ValueError(
                f"{self.repo_id}: recommended_quant {self.recommended_quant!r} not in quants"
            )
        return rec


CATALOG: tuple[CatalogEntry, ...] = (
    CatalogEntry(
        tier="8b",
        label="8B — fast / everyday",
        repo_id="unsloth/Qwen3.5-9B-GGUF",
        params="9B dense",
        active_params="9B",
        ctx=262_144,
        license="Apache-2.0",
        recommended_quant="UD-Q4_K_XL",
        quants=(Quant("UD-Q4_K_XL", 5.97), Quant("Q8_0", 9.5)),
        # Qwen3 family ships a thinking mode (on by default absent
        # `chat_template_kwargs.enable_thinking: false`).
        is_reasoning=True,
        # Verified 2026-07-11 (IBM/Granite 4.1 docs): dense, non-reasoning —
        # "no extended thinking chains, no chain-of-thought toggles" —
        # explicitly designed for predictable latency/token usage instead.
        runner_up=RunnerUp("unsloth/granite-4.1-8b-GGUF", "Granite 4.1 8B", is_reasoning=False),
    ),
    CatalogEntry(
        tier="30b",
        label="30B — MoE balanced",
        repo_id="unsloth/Qwen3.6-35B-A3B-GGUF",
        params="35B/A3B MoE",
        active_params="3B active (35B total)",
        ctx=262_144,
        license="Apache-2.0",
        recommended_quant="UD-Q4_K_XL",
        quants=(Quant("UD-Q4_K_XL", 22.4),),
        is_reasoning=True,  # Qwen3 family — see 8b tier note above.
        # gpt-oss ships a harmony-format `reasoning_effort` reasoning channel.
        runner_up=RunnerUp("unsloth/gpt-oss-20b-GGUF", "gpt-oss 20B", is_reasoning=True),
    ),
    CatalogEntry(
        tier="70b",
        label="70B — MoE hybrid",
        repo_id="unsloth/Qwen3-Next-80B-A3B-Instruct-GGUF",
        params="80B/A3B MoE",
        active_params="3B active (80B total)",
        ctx=262_144,
        license="Apache-2.0",
        recommended_quant="UD-Q4_K_XL",
        quants=(Quant("UD-Q4_K_XL", 46.1),),
        # Qwen3-Next ships separate -Instruct and -Thinking checkpoints; this
        # is the -Instruct one (non-reasoning by default).
        is_reasoning=False,
        runner_up=None,  # Nemotron-70B excluded: non-permissive license (research flag)
    ),
    CatalogEntry(
        tier="120b",
        label="120B — MoE hybrid",
        repo_id="unsloth/gpt-oss-120b-GGUF",
        params="117B/A5.1B MoE",
        active_params="5.1B active (117B total)",
        ctx=131_072,
        license="Apache-2.0",
        recommended_quant="MXFP4",
        quants=(Quant("MXFP4", 63.0),),
        is_reasoning=True,  # gpt-oss — see 30b tier note above.
        runner_up=RunnerUp(
            "unsloth/Qwen3.5-122B-A10B-GGUF", "Qwen3.5 122B A10B", is_reasoning=True
        ),
    ),
    CatalogEntry(
        tier="200b",
        label="200B — MoE hybrid, deep RAM offload",
        repo_id="unsloth/MiniMax-M2.7-GGUF",
        params="229B/A10B MoE",
        active_params="10B active (229B total)",
        ctx=205_000,
        license="Modified MIT (branding clause)",
        recommended_quant="UD-Q3_K_XL",
        quants=(Quant("UD-Q3_K_XL", 102.0),),
        is_reasoning=True,  # MiniMax M-series are reasoning models.
        # Explicit -Instruct checkpoint (Qwen3's non-thinking variant).
        runner_up=RunnerUp(
            "unsloth/Qwen3-235B-A22B-Instruct-2507-GGUF", "Qwen3 235B A22B", is_reasoning=False
        ),
    ),
    CatalogEntry(
        tier="300b",
        label="300B — MoE, biggest full-RAM hybrid",
        repo_id="unsloth/DeepSeek-V4-Flash-GGUF",
        params="284B/A13B MoE",
        active_params="13B active (284B total)",
        ctx=1_000_000,
        license="MIT",
        recommended_quant="UD-Q2_K_XL",
        quants=(Quant("UD-Q2_K_XL", 96.8), Quant("Q4", 155.0)),
        is_reasoning=True,  # DeepSeek's V-series now default to thinking mode.
        runner_up=RunnerUp("unsloth/GLM-4.7-GGUF", "GLM-4.7 (358B/32B)", is_reasoning=True),
    ),
    CatalogEntry(
        tier="700b",
        label="700B — frontier, extreme RAM",
        repo_id="unsloth/GLM-5.2-GGUF",
        params="754B/A40B MoE",
        active_params="40B active (754B total)",
        ctx=1_000_000,
        is_reasoning=True,  # GLM chat models default to thinking mode.
        license="MIT",
        recommended_quant="UD-IQ2_M",
        quants=(Quant("UD-IQ2_M", 239.0),),
        runner_up=RunnerUp("unsloth/Kimi-K2.6-GGUF", "Kimi K2.6 (1T/32B)"),
    ),
)

BY_TIER: dict[str, CatalogEntry] = {e.tier: e for e in CATALOG}
BY_REPO_ID: dict[str, CatalogEntry] = {e.repo_id.lower(): e for e in CATALOG}

# Selection-inference default: the fast 8B pick at its recommended quant
# (design doc: "Selection-inference default recommendation: the 8B pick").
SELECTION_DEFAULT_TIER = "8b"


def tier_for_repo_id(repo_id: str) -> str | None:
    """Catalog tier for a repo id, or None for a custom (non-catalog) repo."""
    entry = BY_REPO_ID.get(repo_id.lower())
    return entry.tier if entry else None


def selection_default_repo_id() -> str:
    """The repo id to recommend for the "selection" role — the fast, cheap
    entity-brief model (2-4 sentences, small ``max_tokens``; see
    ``app.routes.ai_selection``).

    ``SELECTION_DEFAULT_TIER``'s top pick (Qwen3.5-9B) is a reasoning model:
    its thinking preamble eats into the brief's already-small token budget
    before it reaches the answer (the bug ``app.llm``'s
    ``chat_template_kwargs``/think-strip fixes work around, not eliminate —
    disabling thinking isn't guaranteed to be honored by every template
    revision). A NON-reasoning model pays no such tax, so prefer the tier's
    runner-up when it is verified non-reasoning (granite-4.1-8b: IBM's own
    docs describe it as having no chain-of-thought toggle at all). The
    tier's top pick (Qwen3.5-9B) remains the "main"-role recommendation —
    this only changes what's suggested for the selection role.
    """
    entry = BY_TIER[SELECTION_DEFAULT_TIER]
    runner_up = entry.runner_up
    if entry.is_reasoning and runner_up is not None and not runner_up.is_reasoning:
        return runner_up.repo_id
    return entry.repo_id


# ── hardware-fit helper ──────────────────────────────────────────────────────
# A quant "fits now" if this box's combined VRAM+RAM budget can hold it. VRAM
# gets a 2GB headroom (OS/desktop compositor); RAM offload for MoE experts is
# generously available (0.85) since only ACTIVE experts need to be hot, not
# the whole tensor set — mirrors the "combined memory" reasoning in
# research-serving-security.md's preset-logic section.
_VRAM_HEADROOM_GB = 2.0
_RAM_OFFLOAD_FACTOR = 0.85


def usable_vram_gb(vram_mb: int | None) -> float:
    if not vram_mb:
        return 0.0
    return max(0.0, vram_mb / 1024.0 - _VRAM_HEADROOM_GB)


def combined_capacity_gb(vram_mb: int | None, ram_mb: int) -> float:
    return usable_vram_gb(vram_mb) + (ram_mb / 1024.0) * _RAM_OFFLOAD_FACTOR


def fits_now(size_gb: float, vram_mb: int | None, ram_mb: int) -> bool:
    """True if this box's VRAM+RAM budget can hold a quant of this size."""
    return size_gb <= combined_capacity_gb(vram_mb, ram_mb)


def _quant_payload(entry: CatalogEntry, vram_mb: int | None, ram_mb: int) -> list[dict[str, Any]]:
    return [
        {"q": q.q, "size_gb": q.size_gb, "fits_now": fits_now(q.size_gb, vram_mb, ram_mb)}
        for q in entry.quants
    ]


def catalog_payload(vram_mb: int | None, ram_mb: int) -> list[dict[str, Any]]:
    """The ``GET /api/ai/models`` ``catalog`` array — smallest tier first."""
    out = []
    for tier in TIER_ORDER:
        entry = BY_TIER[tier]
        out.append(
            {
                "tier": entry.tier,
                "label": entry.label,
                "repo_id": entry.repo_id,
                "params": entry.params,
                "active_params": entry.active_params,
                "ctx": entry.ctx,
                "license": entry.license,
                "recommended_quant": entry.recommended_quant,
                "quants": _quant_payload(entry, vram_mb, ram_mb),
                "is_reasoning": entry.is_reasoning,
                "runner_up": (
                    {
                        "repo_id": entry.runner_up.repo_id,
                        "label": entry.runner_up.label,
                        "is_reasoning": entry.runner_up.is_reasoning,
                    }
                    if entry.runner_up
                    else None
                ),
            }
        )
    return out
