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

import json
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import httpx

from app.config import get_settings

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


def deepseek_config() -> tuple[str | None, str]:
    """Resolve ``(api_key, base_url)``; ``api_key`` is ``None`` when unconfigured."""
    s = get_settings()
    file_key, file_base = _opencode_deepseek()
    key = (s.deepseek_api_key or file_key or "").strip() or None
    base = (s.deepseek_base_url or file_base or "https://api.deepseek.com").strip()
    return key, base.rstrip("/")


# ── result type ───────────────────────────────────────────────────────────────


@dataclass
class LlmResult:
    text: str | None
    model: str | None = None
    backend: str | None = None  # "deepseek" | "ollama" | None
    error: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return bool(self.text)


# ── http ──────────────────────────────────────────────────────────────────────


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
    # deepseek-reasoner ignores sampling params and rejects response_format;
    # only send them for the chat model.
    if "reasoner" not in model:
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
            text=None, model=model, backend="deepseek", error=f"deepseek call failed: {exc}"
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
            text=None, model=chosen, backend="ollama", error=f"ollama call failed: {exc}"
        )


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
) -> LlmResult:
    """Run a chat completion. DeepSeek first, Ollama fallback.

    Args:
        messages: OpenAI-style ``[{"role","content"}]``.
        tier: ``fast`` / ``reason`` (aliases: haiku/sonnet→fast, opus→reason).
        json_mode: ask the model for a JSON object (fast tier only).
        ollama_model: preferred local model when falling back.
    """
    model = deepseek_model_for(tier)
    # reasoner is slow; give it room to actually finish before the answer.
    if timeout_s is not None:
        eff_timeout = timeout_s
    else:
        eff_timeout = 180.0 if _resolve_tier(tier) == "reason" else 90.0

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

    ol = await _ollama_chat(
        messages,
        prefer_model=ollama_model,
        temperature=temperature,
        timeout_s=min(eff_timeout, 300.0),
    )
    if ol.ok:
        return ol
    # Surface the more informative error (DeepSeek's, if a key was present).
    primary = ds if ds.error and "not configured" not in ds.error else ol
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
) -> tuple[Any | None, LlmResult]:
    """Run ``chat`` and parse the reply as JSON. Returns ``(parsed_or_None, result)``."""
    res = await chat(
        messages,
        tier=tier,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout_s=timeout_s,
        json_mode=(_resolve_tier(tier) == "fast"),
        ollama_model=ollama_model,
    )
    if not res.ok:
        return None, res
    return extract_json(res.text or ""), res


def status() -> dict[str, Any]:
    """What's configured — for /api/intel/sources, data_sources(), health."""
    s = get_settings()
    key, base = deepseek_config()
    return {
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
