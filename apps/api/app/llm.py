"""Unified LLM client — DeepSeek (OpenAI-compatible) primary, Ollama fallback.

The console's analytical tools (``deep_analyze``, the news debias / fact-check
engine) need a real reasoning model, not just whatever tiny model happens to be
installed locally. This module talks to DeepSeek's OpenAI-compatible
``/chat/completions`` and falls back to a local Ollama model when DeepSeek is
unreachable, so the box still works fully offline.

Model tiers — pick the cheapest model that fits the task:
  - ``"fast"``   → ``deepseek-chat``     : extraction, classification, short
                                           summaries, JSON shaping.
  - ``"reason"`` → ``deepseek-reasoner`` : multi-step judgement, fact-checking,
                                           bias / propaganda analysis.

Tier aliases are accepted so callers can speak in the familiar
small/medium/large vocabulary: ``haiku``/``sonnet`` → fast, ``opus`` → reason.

DeepSeek key + base URL resolution order (first hit wins):
  1. env ``DEEPSEEK_API_KEY`` / ``DEEPSEEK_BASE_URL`` (mapped onto Settings).
  2. the user's opencode config — ``~/.config/opencode/opencode.jsonc``
     ``provider.deepseek.options.{apiKey,baseURL}``.

No key anywhere → DeepSeek is skipped and we go straight to Ollama; both
unavailable → ``LlmResult.text is None`` and callers degrade gracefully.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import httpx

from app.config import Settings, get_settings

_log = logging.getLogger("app.llm")

# ── house prose style ─────────────────────────────────────────────────────────

# Appended to the system prompt of every model call whose prose is rendered
# verbatim in the dashboard (selection briefs, pattern-of-life, watch-officer
# read, country brief, news analysis). Operator decision 2026-07-15: dashboard
# copy is written in one voice, and a model left unconstrained drifts into em
# dashes and marketing register within a few sentences. Style only — it must
# never touch grounding, hedging, or the caveat rules each caller sets, so keep
# it additive and put it LAST in the system string.
PROSE_STYLE = (
    "STYLE (applies to the wording of every sentence you write, and never "
    "overrides the output format required above): write as a professional "
    "analyst in plain, direct sentences. Never use em dashes; use a period, "
    "comma, colon, semicolon, or parentheses instead. No marketing language, "
    "no hype, no filler, no rhetorical questions. Prefer the specific term "
    "over the vague one, and state uncertainty plainly rather than dressing "
    "it up."
)


def with_prose_style(system: str) -> str:
    """Append the house prose style to an analyst system prompt.

    Always appended LAST so the caller's own format contract (STRICT JSON,
    markdown section headings) is stated before the style rider and wins on
    any conflict. Style only: it must never touch grounding or hedging rules.
    """
    return f"{system.rstrip()}\n\n{PROSE_STYLE}"


# ── tiers ─────────────────────────────────────────────────────────────────────

# Map task tiers → concrete DeepSeek model ids. Resolved against Settings at
# call time so an operator can override the model names via env.
_TIER_ALIASES = {
    "fast": "fast",
    "cheap": "fast",
    "small": "fast",
    "haiku": "fast",
    "sonnet": "fast",
    "reason": "reason",
    "deep": "reason",
    "large": "reason",
    "opus": "reason",
    "think": "reason",
}


def _resolve_tier(tier: str) -> str:
    return _TIER_ALIASES.get((tier or "fast").lower(), "fast")


# Reasoning models ignore sampling params (temperature/top_p) and reject
# response_format. Detect them by id substring so we suppress those fields for
# any reasoner regardless of vendor (deepseek-reasoner, MiniMax-M3, DeepSeek-R1,
# OpenAI o1/o3, …). Adding a model id here is the one-line way to onboard a new
# reasoner endpoint via the OpenAI-compatible slot.
_REASONER_MARKERS = (
    "reasoner",
    "minimax-m3",
    "-r1",
    "deepseek-r",
    "o1",
    "o3",
    "thinking",
)


def _is_reasoner(model: str) -> bool:
    m = (model or "").lower()
    return any(marker in m for marker in _REASONER_MARKERS)


def deepseek_model_for(tier: str) -> str:
    s = get_settings()
    return s.deepseek_model_reason if _resolve_tier(tier) == "reason" else s.deepseek_model_fast


# ── opencode config key discovery ─────────────────────────────────────────────


def _strip_jsonc(text: str) -> str:
    """Strip ``//`` and ``/* */`` comments from JSONC, string-aware.

    A naive ``//`` strip corrupts URLs (``https://…``); this walks the text and
    only treats ``//`` / ``/*`` as comments when outside a JSON string. Trailing
    commas (legal in JSONC, not JSON) are removed afterwards.
    """
    out: list[str] = []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


@lru_cache(maxsize=1)
def _opencode_deepseek() -> tuple[str, str]:
    """``(apiKey, baseURL)`` from ``opencode.jsonc`` provider.deepseek, or ``("","")``."""
    path = os.path.expanduser(
        os.environ.get("OPENCODE_CONFIG") or "~/.config/opencode/opencode.jsonc"
    )
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.loads(_strip_jsonc(fh.read()))
        opt = data["provider"]["deepseek"]["options"]
        return str(opt.get("apiKey", "") or ""), str(opt.get("baseURL", "") or "")
    except Exception:  # noqa: BLE001 — config absent / malformed → no DeepSeek
        return "", ""


_DEEPSEEK_SOURCE_LOGGED = False


def deepseek_config() -> tuple[str | None, str]:
    """Resolve ``(api_key, base_url)``; ``api_key`` is ``None`` when unconfigured.

    The env ``DEEPSEEK_API_KEY`` is authoritative. The opencode home-dir fallback
    (``~/.config/opencode/opencode.jsonc``) is consulted ONLY when the operator
    explicitly opts in via ``DEEPSEEK_FROM_OPENCODE=1`` (issue #10): a backend
    service silently reading another tool's credential file is a shared-host /
    provenance hazard. The selected source is logged ONCE so an operator auditing
    "which key is this service using?" can see it."""
    global _DEEPSEEK_SOURCE_LOGGED
    s = get_settings()
    env_key = (s.deepseek_api_key or "").strip()
    file_key, file_base = ("", "")
    if not env_key and s.deepseek_from_opencode:
        file_key, file_base = _opencode_deepseek()
    key = (env_key or file_key or "").strip() or None
    base = (s.deepseek_base_url or file_base or "https://api.deepseek.com").strip()
    if not _DEEPSEEK_SOURCE_LOGGED and key:
        source = "env DEEPSEEK_API_KEY" if env_key else "opencode.jsonc (DEEPSEEK_FROM_OPENCODE)"
        logging.getLogger("app.llm").info("DeepSeek credential source: %s", source)
        _DEEPSEEK_SOURCE_LOGGED = True
    return key, base.rstrip("/")


def minimax_config() -> tuple[str | None, str, str]:
    """Resolve ``(api_key, base_url, model)`` for the MiniMax-M3 NVIDIA endpoint.

    ``api_key`` is ``None`` when neither MINIMAX_API_KEY nor NVIDIA_API_KEY is set.
    """
    s = get_settings()
    key = (s.minimax_api_key or s.nvidia_api_key or "").strip() or None
    base = (s.minimax_base_url or "https://integrate.api.nvidia.com/v1").strip()
    model = (s.minimax_model or "minimaxai/minimax-m3").strip()
    return key, base.rstrip("/"), model


# ── result type ───────────────────────────────────────────────────────────────


@dataclass
class LlmResult:
    text: str | None
    model: str | None = None
    backend: str | None = None  # "minimax" | "deepseek" | "ollama" | "llamacpp" | "vllm" | None
    error: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return bool(self.text)


# ── observability (Track D3) ──────────────────────────────────────────────────
# One row per chat() completion → public.llm_calls (model, tokens, latency, tool
# calls, the user who asked). Best-effort: it MUST NOT block or fail the LLM call.
#
# llm.chat() is a plain module-level coroutine with no request context, so the
# caller's identity is threaded in via a ContextVar that a request dependency /
# middleware sets with bind_user() (a future, separately-owned hook — keys.py's
# current_user is the natural place). When nothing has bound a user, the call is
# simply NOT logged: the backend has no service-role key here and RLS forbids a
# NULL-owner insert, so logging degrades silently and the chat() result is
# returned unchanged either way.

# (user_id, supabase_access_token) of the signed-in caller, or None.
_LLM_USER: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "llm_user", default=None
)


def bind_user(user_id: str | None, token: str | None) -> contextvars.Token[tuple[str, str] | None]:
    """Bind the calling user so chat() can attribute its observability rows.

    Returns the reset token (pass to :func:`reset_user`) so a request scope can
    restore the previous binding. A missing id/token clears the binding (anonymous
    / static-API-key callers are not logged). Never raises.
    """
    value = (user_id, token) if (user_id and token) else None
    return _LLM_USER.set(value)


def reset_user(token: contextvars.Token[tuple[str, str] | None]) -> None:
    """Restore the binding captured by :func:`bind_user`. Never raises."""
    try:
        _LLM_USER.reset(token)
    except (ValueError, LookupError):  # token from another context — ignore
        pass


def _usage_int(usage: dict[str, Any] | None, key: str) -> int:
    """Coerce one OpenAI-style usage field to a non-negative int (0 on absence)."""
    try:
        return max(0, int((usage or {}).get(key, 0) or 0))
    except (TypeError, ValueError):
        return 0


def call_row(
    res: LlmResult,
    *,
    user_id: str,
    tier: str,
    latency_ms: int,
    tool_calls: int,
    label: str,
) -> dict[str, Any]:
    """Shape one ``llm_calls`` row from a result. Pure (no I/O) so tests assert it.

    ``prompt``/``completion`` tokens come from the OpenAI-compatible ``usage``
    block; ``total`` falls back to their sum when the backend omits it (e.g.
    Ollama reports no usage → all zero). ``error`` is truncated.
    """
    usage = res.usage or {}
    prompt = _usage_int(usage, "prompt_tokens")
    completion = _usage_int(usage, "completion_tokens")
    total = _usage_int(usage, "total_tokens") or (prompt + completion)
    return {
        "user_id": user_id,
        "backend": res.backend,
        "model_id": res.model,
        "tier": (tier or "fast"),
        "ok": bool(res.ok),
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "latency_ms": max(0, int(latency_ms)),
        "tool_calls": max(0, int(tool_calls)),
        "label": (label or "")[:120],
        "error": (res.error or None) and str(res.error)[:500],
    }


def _llm_calls_url(s: Settings) -> str | None:
    return s.supabase_url.rstrip("/") + "/rest/v1/llm_calls" if s.supabase_url else None


async def _post_call_row(row: dict[str, Any], token: str) -> None:
    """Best-effort PostgREST insert of one observability row. Swallows everything.

    Uses the caller's OWN Supabase access token so RLS (auth.uid() = user_id)
    scopes the row to that user — the same BYOK pattern as keys.py. Any failure
    (Supabase unset, network, 4xx/5xx) is logged at debug and dropped: this is
    fire-and-forget telemetry and must never surface to the LLM caller.
    """
    try:
        s = get_settings()
        url = _llm_calls_url(s)
        if not url:
            return
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(6.0, connect=4.0),
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=0),
        ) as c:
            await c.post(
                url,
                json=row,
                headers={
                    "apikey": s.supabase_anon_key,
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
            )
    except Exception as exc:  # noqa: BLE001 — telemetry never breaks the call
        _log.debug("llm_calls insert failed (ignored): %s", exc)


def _record_call(
    res: LlmResult, *, tier: str, latency_ms: int, tool_calls: int, label: str
) -> None:
    """Fire-and-forget one observability row for a completed chat() call.

    Reads the bound user from the ContextVar; no user → no row (silent). Schedules
    the write on the running loop so it never blocks chat()'s return; if there is
    no running loop (rare — chat() is always awaited) it is dropped. NEVER raises.
    """
    try:
        bound = _LLM_USER.get()
        if not bound:
            return
        user_id, token = bound
        row = call_row(
            res,
            user_id=user_id,
            tier=tier,
            latency_ms=latency_ms,
            tool_calls=tool_calls,
            label=label,
        )
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(_post_call_row(row, token))
        # Keep a reference so the task isn't GC'd mid-flight, and absorb its result.
        _PENDING_LOGS.add(task)
        task.add_done_callback(_PENDING_LOGS.discard)
    except Exception as exc:  # noqa: BLE001 — observability must not break chat()
        _log.debug("llm observability skipped (ignored): %s", exc)


# Strong refs to in-flight log writes (asyncio only weakly refs tasks).
_PENDING_LOGS: set[asyncio.Task[None]] = set()


# ── http ──────────────────────────────────────────────────────────────────────


def _exc_error(prefix: str, exc: Exception) -> str:
    """``"<prefix>: <ClassName>: <str(exc)>"`` — self-explanatory even when the
    exception stringifies to empty (httpx timeout/connect errors commonly do:
    ``str(httpx.ReadTimeout())`` is ``""``, so a naive f-string logs
    ``"ollama call failed: "`` with no signal of WHAT failed). Always includes
    the exception class name; drops the trailing separator when there is no
    message to append.
    """
    detail = str(exc).strip()
    name = type(exc).__name__
    return f"{prefix}: {name}: {detail}" if detail else f"{prefix}: {name}"


_THINK_BLOCK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.IGNORECASE | re.DOTALL)
_THINK_OPEN_RE = re.compile(r"<think(?:ing)?>", re.IGNORECASE)


def _strip_thinking(text: str) -> str:
    """Strip ``<think>...</think>`` / ``<thinking>...</thinking>`` block(s) from
    model output.

    Reasoning models (Qwen3 family, DeepSeek-R1-style, GLM, …) are *supposed* to
    emit their chain-of-thought on a separate ``reasoning_content`` channel and
    leave ``message.content`` as just the answer, but some llama.cpp chat
    templates emit the whole thing — thinking included — INTO ``content``. Left
    unstripped, a short ``max_tokens`` budget makes the caller see either an
    empty string (thinking ate the whole budget) or a thinking-only string with
    no answer; both should be treated as "no real answer" by the caller. Strips
    ALL well-formed blocks (not just a leading one). A ``finish_reason="length"``
    completion can also cut off mid-thought BEFORE the closing tag is ever
    emitted — an unterminated ``<think>``/``<thinking>`` left after that pass is
    still all-preamble, so everything from it to the end is dropped too.
    """
    if not text:
        return text
    stripped = _THINK_BLOCK_RE.sub("", text)
    m = _THINK_OPEN_RE.search(stripped)
    if m:
        stripped = stripped[: m.start()]
    return stripped.strip()


def _content_or_think_error(body: dict[str, Any], *, backend: str) -> tuple[str | None, str | None]:
    """Extract ``choices[0].message.content`` from an OpenAI-style chat body,
    stripping a leading think block (see :func:`_strip_thinking`) before
    deciding whether it's empty.

    A short-``max_tokens`` request to a reasoning model commonly finishes with
    ``finish_reason == "length"`` and an empty (or thinking-only) message: the
    model spent its whole budget on the thinking preamble and never got to the
    answer. That case gets a DESCRIPTIVE error (so a caller/operator can tell
    "the model needs more budget" apart from "the backend is down") instead of
    the generic empty-content message the other backends use. Both branches
    still return ``text=None`` — the caller falls back exactly as before, only
    the error string is more informative when the root cause is diagnosable.
    """
    choice = (body.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    text = _strip_thinking(msg.get("content") or "")
    if text:
        return text, None
    if choice.get("finish_reason") == "length":
        return None, (
            f"{backend} model exhausted token budget on reasoning before answering "
            "(finish_reason=length, empty content after stripping thinking tokens) "
            "— raise max_tokens or use a non-reasoning model"
        )
    return None, f"{backend} returned empty content"


def _client(timeout: float) -> httpx.AsyncClient:
    # Fresh per call: low frequency, and avoids binding a pooled client to one
    # event loop (tests spin many). IPv4-pinned — remote DeepSeek publishes AAAA
    # and this host's IPv6 egress is broken (httpx would hang where curl falls
    # back). Same idiom as app.upstream.get_client.
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=8.0),
        transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1),
        headers={"User-Agent": "osint-console/0.1"},
    )


async def _deepseek_chat(
    messages: list[dict[str, str]],
    *,
    model: str,
    temperature: float,
    max_tokens: int,
    timeout_s: float,
    json_mode: bool,
) -> LlmResult:
    key, base = deepseek_config()
    if not key:
        return LlmResult(text=None, backend=None, error="deepseek key not configured")
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
    }
    # Reasoning models ignore sampling params and reject response_format;
    # only send them for non-reasoner (chat) models.
    if not _is_reasoner(model):
        payload["temperature"] = temperature
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
    try:
        async with _client(timeout_s) as c:
            r = await c.post(
                base + "/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {key}"},
            )
        if r.status_code != 200:
            return LlmResult(
                text=None,
                model=model,
                backend="deepseek",
                error=f"deepseek {r.status_code}: {r.text[:200]}",
            )
        body = r.json()
        msg = (body.get("choices") or [{}])[0].get("message") or {}
        text = (msg.get("content") or "").strip()
        return LlmResult(
            text=text or None,
            model=model,
            backend="deepseek",
            usage=body.get("usage") or {},
            error=None if text else "deepseek returned empty content",
        )
    except Exception as exc:  # noqa: BLE001
        return LlmResult(
            text=None,
            model=model,
            backend="deepseek",
            error=_exc_error("deepseek call failed", exc),
        )


async def _minimax_chat(
    messages: list[dict[str, str]],
    *,
    temperature: float,
    max_tokens: int,
    timeout_s: float,
) -> LlmResult:
    """MiniMax-M3 (reasoning) via NVIDIA's OpenAI-compatible /chat/completions.

    M3 is a reasoning model — it emits ``reasoning_content`` then the final
    ``content``; we return ``content`` (the answer) and let ``extract_json``
    parse JSON out of it. Reasoning consumes tokens, so we floor ``max_tokens``
    to give it room to actually finish.
    """
    key, base, model = minimax_config()
    if not key:
        return LlmResult(text=None, backend=None, error="minimax key not configured")
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max(max_tokens, 4096),
        "temperature": temperature,
        "top_p": 0.95,
        "stream": False,
    }
    try:
        async with _client(timeout_s) as c:
            r = await c.post(
                base + "/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            )
        if r.status_code != 200:
            return LlmResult(
                text=None,
                model=model,
                backend="minimax",
                error=f"minimax {r.status_code}: {r.text[:200]}",
            )
        body = r.json()
        msg = (body.get("choices") or [{}])[0].get("message") or {}
        text = (msg.get("content") or "").strip()
        return LlmResult(
            text=text or None,
            model=model,
            backend="minimax",
            usage=body.get("usage") or {},
            error=None if text else "minimax returned empty content",
        )
    except Exception as exc:  # noqa: BLE001
        return LlmResult(
            text=None, model=model, backend="minimax", error=_exc_error("minimax call failed", exc)
        )


async def _ollama_tags(host: str, timeout_s: float) -> list[str]:
    try:
        async with _client(timeout_s) as c:
            r = await c.get(host.rstrip("/") + "/api/tags")
        if r.status_code != 200:
            return []
        return [m.get("name", "") for m in (r.json().get("models") or []) if m.get("name")]
    except Exception:  # noqa: BLE001
        return []


_OLLAMA_SMALL_HINTS = ("a3b", "1b", "2b", "3b", "mini", "small", "phi", "gemma2:2b", "qwen2.5:3b")


def _pick_ollama(models: list[str], prefer: str) -> str | None:
    if prefer:
        for m in models:
            if m == prefer or m.startswith(prefer):
                return m
        return prefer  # let Ollama resolve / pull
    if not models:
        return None
    for hint in _OLLAMA_SMALL_HINTS:
        for m in models:
            if hint in m.lower():
                return m
    return models[0]


async def _ollama_chat(
    messages: list[dict[str, str]],
    *,
    prefer_model: str,
    temperature: float,
    timeout_s: float,
) -> LlmResult:
    s = get_settings()
    host = (os.environ.get("OLLAMA_HOST") or s.ollama_host).rstrip("/")
    models = await _ollama_tags(host, min(timeout_s, 8.0))
    chosen = _pick_ollama(models, prefer_model or os.environ.get("OLLAMA_MODEL") or s.ollama_model)
    if not chosen:
        return LlmResult(
            text=None,
            backend="ollama",
            error=f"ollama unreachable at {host} or no models installed",
        )
    try:
        async with _client(timeout_s) as c:
            r = await c.post(
                host + "/api/chat",
                json={
                    "model": chosen,
                    "stream": False,
                    "options": {"temperature": temperature},
                    "messages": messages,
                },
            )
        if r.status_code != 200:
            return LlmResult(
                text=None,
                model=chosen,
                backend="ollama",
                error=f"ollama {r.status_code}: {r.text[:200]}",
            )
        text = ((r.json().get("message") or {}).get("content") or "").strip()
        return LlmResult(text=text or None, model=chosen, backend="ollama")
    except Exception as exc:  # noqa: BLE001
        return LlmResult(
            text=None, model=chosen, backend="ollama", error=_exc_error("ollama call failed", exc)
        )


# ── local model manager engines (app.localllm) ──────────────────────────────
# llama.cpp (PRIMARY, all Unsloth GGUF tiers) and vLLM (opt-in, safetensors-only)
# rungs. Both talk OpenAI ``/v1/chat/completions`` to their own sidecar
# (``app.llamacpp_sidecar`` / ``app.vllm_sidecar``) over a per-boot bearer key
# that never leaves the backend process. Deferred imports throughout this
# section: the sidecar modules pull in ``app.localllm`` (huggingface_hub) and
# app.llm is imported almost everywhere, so keeping that coupling out of the
# top-level import graph matches this codebase's existing deferred-import
# convention (see main.py's lifespan for the same local-import style).


def local_engine() -> str:
    """Resolve the effective local engine — never ``"auto"``. ``"auto"``
    (the default) picks llama.cpp when its sidecar is enable-able (a binary
    resolves AND at least one model is installed), else Ollama. An explicit
    choice (``POST /api/ai/engine`` / ``LLM_LOCAL_ENGINE``) passes through
    unchanged even if that engine turns out to be unavailable — the caller
    opted in deliberately, so ``_try_local`` below is what falls back to
    Ollama on an actual call failure, not this resolver."""
    from app.localllm import state as engine_state  # noqa: PLC0415

    engine = engine_state.get_engine()
    if engine != "auto":
        return engine
    from app import llamacpp_sidecar  # noqa: PLC0415

    return "llamacpp" if llamacpp_sidecar.is_enabled() else "ollama"


def _installed_model_name(role: str) -> str | None:
    """The server-side model id for the installed model pinned to *role*
    ("main"/"selection"). llama-server's router mode (``--models-dir``) ids each
    model by its on-disk **directory name**, which the manager sets to the
    model *key* (``data/models/<key>/<file>.gguf``) — verified live against
    release b9964: ``GET /v1/models`` returns ``id == <key>``. So the key IS the
    server-side id; return it directly (only when the model is still installed)."""
    from app.localllm import manager as local_manager  # noqa: PLC0415

    active = local_manager.get_active().get(role)
    if not active:
        return None
    if any(m["key"] == active for m in local_manager.list_installed()):
        return active
    return None


async def _llamacpp_chat(
    messages: list[dict[str, str]],
    *,
    role: str,
    temperature: float,
    max_tokens: int,
    timeout_s: float,
    model_key: str | None = None,
) -> LlmResult:
    from app import llamacpp_sidecar  # noqa: PLC0415

    key = llamacpp_sidecar.api_key()
    if not key:
        return LlmResult(text=None, backend="llamacpp", error="llamacpp sidecar not running")
    if model_key is not None:
        # Multi-model ensemble targeting (A2): bypass role resolution entirely
        # and pin the payload model to this exact install key — same
        # installed-check `_installed_model_name` does, but keyed by the
        # caller's explicit choice instead of the active main/selection role.
        from app.localllm import manager as local_manager  # noqa: PLC0415

        if not any(m["key"] == model_key for m in local_manager.list_installed()):
            return LlmResult(
                text=None, backend="llamacpp", error=f"model {model_key!r} not installed"
            )
        model = model_key
    else:
        model = _installed_model_name(role)
    if not model:
        return LlmResult(text=None, backend="llamacpp", error=f"no active {role!r} model")
    host = get_settings().llamacpp_host.rstrip("/")
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
        # Disable Qwen3-family "thinking" so a small max_tokens budget isn't
        # spent entirely on a reasoning preamble (the diagnosed bug: 200 OK,
        # finish_reason="length", content=""). `chat_template_kwargs` is the
        # field name llama-server's own docs specify for this exact example —
        # https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
        # ("chat_template_kwargs: Allows sending additional parameters to the
        # json templating system. For example: {"enable_thinking": false}").
        # `reasoning_effort` covers gpt-oss/OpenAI-style harmony templates
        # instead; both are simply ignored by templates/engines that don't
        # recognize them, so sending both is safe across the whole catalog.
        "chat_template_kwargs": {"enable_thinking": False},
        "reasoning_effort": "low",
    }
    try:
        async with _client(timeout_s) as c:
            r = await c.post(
                host + "/v1/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {key}"},
            )
        if r.status_code != 200:
            return LlmResult(
                text=None,
                model=model,
                backend="llamacpp",
                error=f"llamacpp {r.status_code}: {r.text[:200]}",
            )
        body = r.json()
        text, error = _content_or_think_error(body, backend="llamacpp")
        return LlmResult(
            text=text,
            model=model,
            backend="llamacpp",
            usage=body.get("usage") or {},
            error=error,
        )
    except Exception as exc:  # noqa: BLE001
        return LlmResult(
            text=None,
            model=model,
            backend="llamacpp",
            error=_exc_error("llamacpp call failed", exc),
        )


async def _vllm_chat(
    messages: list[dict[str, str]],
    *,
    temperature: float,
    max_tokens: int,
    timeout_s: float,
) -> LlmResult:
    from app import vllm_sidecar  # noqa: PLC0415

    key = vllm_sidecar.api_key()
    if not key:
        return LlmResult(text=None, backend="vllm", error="vllm sidecar not running")
    model = vllm_sidecar.served_model_name()
    if not model:
        return LlmResult(text=None, backend="vllm", error="vllm has no served model")
    host = get_settings().vllm_host.rstrip("/")
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
        # Same no-think belt-and-suspenders as `_llamacpp_chat` — see the
        # comment there for the doc reference. vLLM's OpenAI-compatible server
        # also honors `chat_template_kwargs` (forwarded straight into the HF
        # chat template) and ignores unknown fields otherwise.
        "chat_template_kwargs": {"enable_thinking": False},
        "reasoning_effort": "low",
    }
    try:
        async with _client(timeout_s) as c:
            r = await c.post(
                host + "/v1/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {key}"},
            )
        if r.status_code != 200:
            return LlmResult(
                text=None,
                model=model,
                backend="vllm",
                error=f"vllm {r.status_code}: {r.text[:200]}",
            )
        body = r.json()
        text, error = _content_or_think_error(body, backend="vllm")
        return LlmResult(
            text=text,
            model=model,
            backend="vllm",
            usage=body.get("usage") or {},
            error=error,
        )
    except Exception as exc:  # noqa: BLE001
        return LlmResult(
            text=None, model=model, backend="vllm", error=_exc_error("vllm call failed", exc)
        )


# ── local-first preference (Part 4: dodge cloud rate limits on operator GPU) ────

# Runtime override flipped by POST /api/ai/local (the app-scoped toggle). None →
# fall back to Settings.llm_prefer_local. Process-global — ponytail: correct for the
# single-operator / desktop case this exists for; a multi-tenant deploy would thread
# a per-user header instead of a global.
_prefer_local_override: bool | None = None


def set_prefer_local(enabled: bool | None) -> None:
    """Runtime toggle for local-first inference (None → defer to Settings)."""
    global _prefer_local_override
    _prefer_local_override = enabled


def prefer_local() -> bool:
    if _prefer_local_override is not None:
        return _prefer_local_override
    return get_settings().llm_prefer_local


# Strict local-only mode (POST /api/ai/local `local_only`): same process-global
# override idiom as `prefer_local`. None → defer to Settings.llm_local_only.
_local_only_override: bool | None = None


def set_local_only(enabled: bool | None) -> None:
    """Runtime toggle for strict local-only inference (None → defer to Settings)."""
    global _local_only_override
    _local_only_override = enabled


def local_only() -> bool:
    if _local_only_override is not None:
        return _local_only_override
    return get_settings().llm_local_only


# Gotham-style selection-inference enable switch (POST /api/ai/local
# `selection_enabled`): same process-global override idiom as `prefer_local` /
# `local_only`. None → defer to Settings.llm_selection_enabled.
_selection_enabled_override: bool | None = None


def set_selection_enabled(enabled: bool | None) -> None:
    """Runtime toggle for the selection-inference brief (None → defer to Settings)."""
    global _selection_enabled_override
    _selection_enabled_override = enabled


def selection_enabled() -> bool:
    if _selection_enabled_override is not None:
        return _selection_enabled_override
    return get_settings().llm_selection_enabled


def _is_selection_tier(tier: str) -> bool:
    return (tier or "").strip().lower() == "selection"


def _ollama_model_for(tier: str, explicit: str) -> str:
    """Tier → configured local model id (reason vs fast). Empty → auto-pick."""
    if explicit:
        return explicit
    s = get_settings()
    if _resolve_tier(tier) == "reason":
        return s.ollama_model_reason or s.ollama_model
    return s.ollama_model_fast or s.ollama_model


async def local_status() -> dict[str, Any]:
    """Readiness for the local-inference toggle — GET/POST /api/ai/local.

    ``ollama_up`` + ``tool_capable`` is the hardware gate the frontend uses to
    enable/disable the switch (Ollama only serves a model if the box can run it).
    """
    s = get_settings()
    host = (os.environ.get("OLLAMA_HOST") or s.ollama_host).rstrip("/")
    models = await _ollama_tags(host, 4.0)
    tool_capable = any(
        any(
            h in m.lower()
            for h in ("qwen3", "qwen2.5", "llama3", "mistral", "coder", "a3b", "8b", "30b", "70b")
        )
        for m in models
    )
    from app.localllm import manager as local_manager  # noqa: PLC0415
    from app.localllm import state as engine_state  # noqa: PLC0415

    return {
        "enabled": prefer_local(),
        "local_only": local_only(),
        "ollama_host": host,
        "ollama_up": bool(models),
        "tool_capable": tool_capable,
        "models": models,
        "model_fast": s.ollama_model_fast or "(auto)",
        "model_reason": s.ollama_model_reason or s.ollama_model or "(auto)",
        # app.localllm engine + selection-inference fields (design doc "API
        # contract": GET/POST /api/ai/local gains engine/selection_model/
        # selection_enabled) — purely additive, existing fields unchanged.
        "engine": engine_state.get_engine(),
        "selection_model": local_manager.get_active().get("selection"),
        "selection_enabled": selection_enabled(),
    }


# ── public api ────────────────────────────────────────────────────────────────


async def chat(
    messages: list[dict[str, str]],
    *,
    tier: str = "fast",
    temperature: float = 0.2,
    max_tokens: int = 1024,
    timeout_s: float | None = None,
    json_mode: bool = False,
    ollama_model: str = "",
    fast: bool = False,
    label: str = "",
    tool_calls: int = 0,
    local_model_key: str | None = None,
) -> LlmResult:
    """Run a chat completion. DeepSeek first, Ollama fallback.

    Args:
        messages: OpenAI-style ``[{"role","content"}]``.
        tier: ``fast`` / ``reason`` (aliases: haiku/sonnet→fast, opus→reason).
        json_mode: ask the model for a JSON object (fast tier only).
        ollama_model: preferred local model when falling back.
        label: optional caller tag for observability (e.g. ``"agent.gather"``);
            does not affect the call.
        tool_calls: number of tool calls this turn carried, for observability.
        local_model_key: force this call onto a SPECIFIC installed llama.cpp
            model by install key (news-verification ensemble), bypassing
            tier/role resolution and the tier/prefer_local/cloud ladder
            entirely. Never falls back to a cloud backend — the caller
            handles degradation.

    Every completion (success or failure) is logged best-effort to
    ``public.llm_calls`` for the bound user (see :func:`bind_user`); logging never
    blocks or fails this call.
    """
    started = time.monotonic()
    res = await _run_chat(
        messages,
        tier=tier,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout_s=timeout_s,
        json_mode=json_mode,
        ollama_model=ollama_model,
        fast=fast,
        local_model_key=local_model_key,
    )
    _record_call(
        res,
        tier="fast" if fast else tier,
        latency_ms=round((time.monotonic() - started) * 1000),
        tool_calls=tool_calls,
        label=label,
    )
    return res


async def _run_chat(
    messages: list[dict[str, str]],
    *,
    tier: str,
    temperature: float,
    max_tokens: int,
    timeout_s: float | None,
    json_mode: bool,
    ollama_model: str,
    fast: bool,
    local_model_key: str | None = None,
) -> LlmResult:
    """The backend ladder (MiniMax → DeepSeek → Ollama). No observability here so
    :func:`chat` records exactly one row per public call."""
    # Multi-model ensemble targeting (A2): a specific install key short-circuits
    # the whole tier/prefer_local/cloud ladder — route straight to the llamacpp
    # rung with that key and return whatever it says, success or failure. Never
    # falls through to Ollama or a cloud backend: a verifier call that silently
    # landed on a DIFFERENT model (or the cloud) would corrupt the ensemble.
    if local_model_key is not None:
        engine = local_engine()
        if engine != "llamacpp":
            return LlmResult(
                text=None,
                backend=engine,
                error=(
                    "multi-model targeting requires the llamacpp engine "
                    f"(resolved engine is {engine!r})"
                ),
            )
        eff_timeout = timeout_s if timeout_s is not None else 90.0
        return await _llamacpp_chat(
            messages,
            role="main",
            temperature=temperature,
            max_tokens=max_tokens,
            timeout_s=min(eff_timeout, 300.0),
            model_key=local_model_key,
        )
    # `fast=True` forces the quick chat model (DeepSeek-chat / Ollama) and skips
    # the slow MiniMax-M3 reasoner entirely — used for the agent's tool-routing
    # turns, where many cheap round-trips matter more than deep reasoning. The
    # final synthesis turn runs WITHOUT fast so it gets M3.
    model = deepseek_model_for("fast" if fast else tier)
    # reasoner is slow; give it room to actually finish before the answer.
    if timeout_s is not None:
        eff_timeout = timeout_s
    elif fast:
        eff_timeout = 35.0
    else:
        eff_timeout = 180.0 if _resolve_tier(tier) == "reason" else 90.0

    # tier="selection" (Gotham-style entity-assessment brief) targets the
    # manager's "selection"-role model on the LOCAL engine — a separate,
    # faster pick than "main". When unconfigured (no active selection model)
    # it behaves exactly like "fast": `_resolve_tier`/`deepseek_model_for`
    # already alias the unknown "selection" tier to "fast" for the cloud
    # rungs above, and dropping to role="main" here makes the local rung match
    # too.
    selection_role = _is_selection_tier(tier)
    if selection_role:
        from app.localllm import manager as local_manager  # noqa: PLC0415

        selection_role = bool(local_manager.get_active().get("selection"))
    role = "selection" if selection_role else "main"

    async def _try_ollama() -> LlmResult:
        return await _ollama_chat(
            messages,
            prefer_model=_ollama_model_for(tier, ollama_model),
            temperature=temperature,
            timeout_s=min(eff_timeout, 300.0),
        )

    async def _try_local() -> LlmResult:
        """Route through the resolved local engine (never "auto" — see
        `local_engine()`); llamacpp/vllm fall back to Ollama on error so a
        cold/unhealthy sidecar still serves something local — `local_only()` /
        `prefer_local()` callers never leave the box regardless of which
        local engine ends up picked."""
        engine = local_engine()
        if engine == "llamacpp":
            res = await _llamacpp_chat(
                messages,
                role=role,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_s=min(eff_timeout, 300.0),
            )
            if res.ok:
                return res
            return await _try_ollama()
        if engine == "vllm":
            res = await _vllm_chat(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_s=min(eff_timeout, 300.0),
            )
            if res.ok:
                return res
            return await _try_ollama()
        return await _try_ollama()

    # Strict local-only (POST /api/ai/local `local_only`): use ONLY the local
    # engine, success or failure — never touch MiniMax/DeepSeek, even if a
    # cloud key is present in the environment. Implies trying local first
    # regardless of `prefer_local`, so it is checked ahead of that ladder.
    if local_only():
        return await _try_local()

    # Local-first (Part 4): when the operator opts in (POST /api/ai/local or
    # LLM_PREFER_LOCAL), run the on-GPU model AHEAD of the cloud backends to dodge
    # cloud rate limits. Falls through to the cloud ladder below if the local
    # engine is unreachable or returns empty.
    if prefer_local():
        loc = await _try_local()
        if loc.ok:
            return loc

    # MiniMax-M3 (reasoning) is the PRIMARY backend when configured. It reasons
    # before answering, so it needs a generous floor; DeepSeek/Ollama remain the
    # fallbacks below if it is unconfigured or fails. `fast` skips it.
    mm_key, _mm_base, _mm_model = minimax_config()
    if mm_key and not fast:
        # Cap MiniMax at 90 s so a hung M3 can't eat the WHOLE caller budget
        # before DeepSeek is even tried. Backends run sequentially, each with its
        # own timeout (DeepSeek below gets the full eff_timeout, not a remainder),
        # so worst-case wall time is the SUM — the calling route bounds the total
        # (e.g. news/* wrap in asyncio.wait_for < Cloudflare's 100 s edge limit).
        mm = await _minimax_chat(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout_s=min(eff_timeout, 90.0),
        )
        if mm.ok:
            return mm

    ds = await _deepseek_chat(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout_s=eff_timeout,
        json_mode=json_mode,
    )
    if ds.ok:
        return ds

    loc = await _try_local()
    if loc.ok:
        return loc
    # Surface the more informative error (DeepSeek's, if a key was present).
    primary = ds if ds.error and "not configured" not in ds.error else loc
    return LlmResult(text=None, model=primary.model, backend=primary.backend, error=primary.error)


async def complete(
    system: str,
    user: str,
    **kwargs: Any,
) -> LlmResult:
    """Convenience wrapper for a single system+user turn."""
    return await chat(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        **kwargs,
    )


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def extract_json(text: str) -> Any | None:
    """Best-effort parse of a JSON object/array from model output.

    Handles ```json fences, leading prose, and trailing commentary by locating
    the outermost ``{...}`` / ``[...]`` span.
    """
    if not text:
        return None
    candidate = text.strip()
    m = _JSON_FENCE.search(candidate)
    if m:
        candidate = m.group(1).strip()
    try:
        return json.loads(candidate)
    except Exception:  # noqa: BLE001
        pass
    # Fall back to the widest brace/bracket span.
    for open_c, close_c in (("{", "}"), ("[", "]")):
        start = candidate.find(open_c)
        end = candidate.rfind(close_c)
        if start != -1 and end > start:
            try:
                return json.loads(candidate[start : end + 1])
            except Exception:  # noqa: BLE001
                continue
    return None


async def chat_json(
    messages: list[dict[str, str]],
    *,
    tier: str = "fast",
    temperature: float = 0.1,
    max_tokens: int = 2048,
    timeout_s: float | None = None,
    ollama_model: str = "",
    fast: bool = False,
    label: str = "",
    tool_calls: int = 0,
    local_model_key: str | None = None,
) -> tuple[Any | None, LlmResult]:
    """Run ``chat`` and parse the reply as JSON. Returns ``(parsed_or_None, result)``.

    ``label``/``tool_calls`` are forwarded to ``chat`` for observability; the
    single underlying ``chat`` call logs exactly one ``llm_calls`` row.
    """
    res = await chat(
        messages,
        tier=tier,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout_s=timeout_s,
        json_mode=(fast or _resolve_tier(tier) == "fast"),
        ollama_model=ollama_model,
        fast=fast,
        label=label,
        tool_calls=tool_calls,
        local_model_key=local_model_key,
    )
    if not res.ok:
        return None, res
    return extract_json(res.text or ""), res


def status() -> dict[str, Any]:
    """What's configured — for /api/intel/sources, data_sources(), health."""
    s = get_settings()
    key, base = deepseek_config()
    mm_key, mm_base, mm_model = minimax_config()
    return {
        "primary": "minimax" if mm_key else ("deepseek" if key else "ollama"),
        "minimax": {
            "configured": bool(mm_key),
            "base_url": mm_base,
            "model": mm_model,
            "reasoning": True,
        },
        "deepseek": {
            "configured": bool(key),
            "base_url": base,
            "model_fast": s.deepseek_model_fast,
            "model_reason": s.deepseek_model_reason,
        },
        "ollama": {
            "host": os.environ.get("OLLAMA_HOST") or s.ollama_host,
            "model": s.ollama_model or "(auto)",
        },
    }
