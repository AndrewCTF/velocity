"""Context-optimising response shaper for the MCP tool layer.

Every ``/api/intel/*`` route already returns *compact* JSON (counts, grids,
capped samples). But "compact" is still tuned for a power-user reading one
endpoint — an agent sweeping the planet across a dozen tool calls wants a far
cheaper **digest** by default, and the *full* bundle only when it decides to
drill in. This module gives every heavy MCP tool two variants off one payload:

- ``short`` (the default) — a token-frugal digest of the SAME payload: scalars
  and small dicts kept verbatim, long arrays capped to the top few items with a
  companion ``<field>_total`` so the agent still knows the true size, verbose
  strings (narratives) truncated. Orientation and broad sweeps cost a few
  hundred tokens.
- ``long`` — the full route payload, untouched. The comprehensive, agent-ready
  view for when a specific incident/area is worth the context.

The transform is a pure function (no I/O) so it is trivially testable and can
never fail a tool call: it only ever *removes* detail from an already-valid
payload. Error envelopes (``{"error": ...}``) pass through untouched — they are
tiny and load-bearing.
"""

from __future__ import annotations

from typing import Any

SHORT = "short"
LONG = "long"
VALID_DETAIL = (SHORT, LONG)

# Defaults tuned so a short digest of the heaviest payloads (a global brief, a
# full area bundle) lands in the low hundreds of tokens.
_LIST_CAP = 5
_STR_CAP = 240
_MAX_DEPTH = 6


def normalize_detail(detail: str | None) -> str:
    """Coerce agent-supplied ``detail`` to a valid mode (default ``short``)."""
    d = (detail or SHORT).strip().lower()
    return d if d in VALID_DETAIL else SHORT


def shape(
    payload: Any,
    detail: str | None = SHORT,
    *,
    list_cap: int = _LIST_CAP,
    str_cap: int = _STR_CAP,
) -> Any:
    """Return ``payload`` for ``long``; a context-frugal digest for ``short``.

    Only ``dict`` payloads are digested (every intel route returns an object).
    Anything else, and any error envelope, is returned unchanged.
    """
    mode = normalize_detail(detail)
    if mode == LONG or not isinstance(payload, dict):
        return payload
    if "error" in payload:  # structured backend error — never shrink it
        return payload

    truncated: list[str] = []
    out = _shorten_dict(payload, list_cap, str_cap, depth=0, path="", dropped=truncated)
    # A no-op when nothing was trimmed (already-small payload) — return it
    # unchanged rather than tagging it, so short is a faithful passthrough for
    # the many tools that already fit. Only annotate when detail was dropped.
    if truncated:
        out["truncated"] = True
        out["hint"] = (
            "Digest only — some arrays/strings were trimmed (see `*_total` "
            "counts). Re-call with detail='long' for the full bundle."
        )
    return out


def _shorten(
    value: Any, list_cap: int, str_cap: int, depth: int, path: str, dropped: list[str]
) -> Any:
    if depth >= _MAX_DEPTH:
        return value
    if isinstance(value, dict):
        return _shorten_dict(value, list_cap, str_cap, depth, path, dropped)
    if isinstance(value, list):
        return _shorten_list(value, list_cap, str_cap, depth, path, dropped)
    if isinstance(value, str) and len(value) > str_cap:
        dropped.append(path)
        return value[: str_cap - 1] + "…"
    return value


def _shorten_dict(
    d: dict[str, Any], list_cap: int, str_cap: int, depth: int, path: str, dropped: list[str]
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in d.items():
        child = f"{path}.{k}" if path else str(k)
        if isinstance(v, list) and len(v) > list_cap:
            out[k] = [
                _shorten(x, list_cap, str_cap, depth + 1, child, dropped) for x in v[:list_cap]
            ]
            # Honest full-set size sits beside the capped sample so the agent
            # knows how much it is NOT seeing (skip if the key already exists).
            count_key = f"{k}_total"
            if count_key not in d:
                out[count_key] = len(v)
            dropped.append(child)
        else:
            out[k] = _shorten(v, list_cap, str_cap, depth + 1, child, dropped)
    return out


def _shorten_list(
    lst: list[Any], list_cap: int, str_cap: int, depth: int, path: str, dropped: list[str]
) -> list[Any]:
    # A bare list at this position (list-of-lists); cap and digest each kept item.
    kept = [_shorten(x, list_cap, str_cap, depth + 1, path, dropped) for x in lst[:list_cap]]
    if len(lst) > list_cap:
        dropped.append(path)
    return kept
