"""Multi-local-LLM bias-verification stage for the news edition.

:func:`analyze.analyze_edition` produces the public wall (deterministic
clustering + one batched cloud/reason-tier LLM pass for neutral rewrites and
bias callouts). This module is a SECOND, independent pass that runs the
resulting edition back through however many locally-installed models the
operator has configured, one at a time on the single shared GPU
(:func:`llamacpp_sidecar.ensure_hot`), and cross-checks the first pass's
verdicts instead of trusting a single model's self-review.

Design:
  - 0 verifier models installed → every story is marked "skipped", the wall
    still ships unmodified (never blocks the page on local hardware).
  - Each verifier judges a batch of stories (pass/flag + why) but never
    rewrites text — a lone "flag" from a single verifier only earns a repair
    pass from the ORIGINAL drafting model (cloud/reason tier, no
    ``local_model_key``), never from a local verifier.
  - Agreement across ≥2 models plus real source diversity is what earns
    "verified-neutral"; a split or unanimous flag downgrades to "contested"
    and reverts to the most neutral available headline, no LLM involved.

Never adds/changes evidence links and never invents sources: this stage only
edits story-level ``title``/``neutral_summary`` text and appends
``verification``/``bias_review``/``countries`` metadata.
"""

from __future__ import annotations

import copy
import re
import time
from typing import Any

from app import llamacpp_sidecar
from app.config import get_settings
from app.llm import chat_json, with_prose_style
from app.localllm import manager
from app.news.analyze import _INJECTION_GUARD, _fence

_BATCH_SIZE = 6

# Families the operator is likely to install side by side (informational —
# the actual family extraction below is the generic "token before '-' or a
# digit boundary" rule, which happens to reduce these to the right buckets).
_FAMILIES_OF_INTEREST = ("qwen", "gpt-oss", "deepseek", "glm", "minimax")

_VERIFY_SYSTEM = (
    "You are an impartial bias reviewer for a news edition. You are given a "
    "JSON array of stories, each with an id, title, summary, and the outlets "
    "that reported it. For EACH story judge: loaded or emotive language, "
    "one-sidedness, unsupported claims stated as settled fact, and any "
    "missing perspective a neutral reader would need. You are a judge here, "
    "never a rewriter: do not propose replacement text. Reason only over the "
    "provided text, never invent facts, sources, or claims.\n\n"
    "Output STRICT JSON ONLY, no prose, no markdown fences, an array with "
    "exactly one entry per story, matching:\n"
    '[{"story_id": "<id>", "verdict": "pass"|"flag", '
    '"loaded_language": ["<phrase>", ...], "one_sided": <true|false>, '
    '"unsupported_claims": ["<claim>", ...], '
    '"missing_perspective": "<one line, or empty string>", '
    '"confidence": <0..1>}]'
)

_REPAIR_SYSTEM = (
    "You are a copy editor repairing one news story that an independent bias "
    "review flagged. Rewrite the title and neutral_summary to remove the "
    "flagged loaded language and unsupported claims. Add no new facts, "
    "names, numbers, or claims that are not already present in the original "
    "text.\n\n"
    "Output STRICT JSON ONLY, matching:\n"
    '{"title": "<revised title>", "neutral_summary": "<revised summary>"}'
)


def _json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


# ── verifier selection ───────────────────────────────────────────────────────


def _family(key: str) -> str:
    """First token of an install key before a '-' or a digit boundary."""
    m = re.match(r"[^0-9-]+", key.lower())
    return m.group(0) if m else key.lower()


def resolve_verifiers() -> list[str]:
    """Which installed local model keys act as bias verifiers.

    ``settings.news_verify_models`` (comma-separated install keys) wins when
    set, filtered to keys that are actually installed. Otherwise auto-pick up
    to 2 installed models (excluding the active "main" drafting model),
    preferring distinct model families so the ensemble isn't just one model
    talking to itself.
    """
    settings = get_settings()
    installed = [m.get("key") for m in manager.list_installed() if m.get("key")]
    installed_set = set(installed)

    raw = (settings.news_verify_models or "").strip()
    if raw:
        chosen: list[str] = []
        for part in raw.split(","):
            key = part.strip()
            if key and key in installed_set and key not in chosen:
                chosen.append(key)
        return chosen

    active_main = (manager.get_active() or {}).get("main")
    candidates = [k for k in installed if k != active_main]

    chosen = []
    seen_families: set[str] = set()
    for key in candidates:
        if len(chosen) >= 2:
            break
        fam = _family(key)
        if fam in seen_families:
            continue
        chosen.append(key)
        seen_families.add(fam)
    if len(chosen) < 2:
        for key in candidates:
            if len(chosen) >= 2:
                break
            if key not in chosen:
                chosen.append(key)
    return chosen


# ── source diversity + country tags (pure, deterministic) ──────────────────


def _source_leanings() -> dict[str, str]:
    """Outlet name -> registered ``leaning`` string, from both feed lists."""
    idx: dict[str, str] = {}
    try:
        from app.news import sources as _sources  # noqa: PLC0415

        for s in _sources.FEEDS:
            idx[s.name] = s.leaning
    except Exception:  # noqa: BLE001 — best-effort lookup table
        pass
    try:
        from app.news import feeds_register as _register  # noqa: PLC0415

        for s in _register.REGISTER:
            idx.setdefault(s.name, s.leaning)
    except Exception:  # noqa: BLE001 — register is optional
        pass
    return idx


def _leaning_buckets() -> dict[str, str]:
    try:
        from app.news.feeds_register import LEANING_BUCKETS  # noqa: PLC0415

        return LEANING_BUCKETS
    except Exception:  # noqa: BLE001 — register is optional
        return {}


def diversity_of(story: dict) -> dict:
    """``{"outlets": n, "buckets": [...]}`` from a story's corroborating sources."""
    corr = story.get("corroboration") if isinstance(story.get("corroboration"), dict) else {}
    raw_sources = corr.get("sources") if isinstance(corr.get("sources"), list) else []
    names = [str(n).strip() for n in raw_sources if str(n).strip()]
    outlets = len(set(names))

    leanings = _source_leanings()
    bucket_map = _leaning_buckets()
    buckets: set[str] = set()
    for name in names:
        leaning = leanings.get(name)
        bucket = bucket_map.get(leaning) if leaning else None
        if bucket:
            buckets.add(bucket)
    return {"outlets": outlets, "buckets": sorted(buckets)}


def country_tags(story: dict) -> list[str]:
    """ISO3 codes for country names mentioned in a story's title + summary."""
    text = " ".join(
        str(story.get(field) or "")
        for field in ("title", "neutral_summary", "neutral_rewrite")
    ).casefold()
    if not text.strip():
        return []
    try:
        from app.geo.adminshapes import _name_index  # noqa: PLC0415
    except Exception:  # noqa: BLE001 — country lookup is best-effort
        return []
    found: set[str] = set()
    for name, iso3 in _name_index().items():
        if len(name) >= 4 and name in text:
            found.add(iso3)
    return sorted(found)


def _revert_to_neutral_headline(story: dict) -> None:
    """Contested stories: fall back to the most neutral per-source headline,
    if the story dict actually carries one (preferring wire, then center).
    A no-op when no per-source headlines are present — the title is left as
    is rather than guessed at."""
    headlines = None
    for field in ("headlines", "per_source_headlines", "source_headlines"):
        val = story.get(field)
        if isinstance(val, list) and val:
            headlines = val
            break
    if not headlines:
        return
    bucket_map = _leaning_buckets()
    leanings = _source_leanings()

    def _rank(entry: Any) -> int:
        if not isinstance(entry, dict):
            return 9
        leaning = entry.get("leaning") or leanings.get(str(entry.get("source") or ""))
        bucket = bucket_map.get(leaning) if leaning else None
        if bucket == "wire":
            return 0
        if bucket == "center":
            return 1
        return 2

    candidates = [h for h in headlines if isinstance(h, dict) and str(h.get("title") or "").strip()]
    if not candidates:
        return
    candidates.sort(key=_rank)
    story["title"] = str(candidates[0]["title"]).strip()


# ── verifier + repair calls ─────────────────────────────────────────────────


def _coerce_verdict(item: dict) -> dict:
    verdict = item.get("verdict")
    if verdict not in ("pass", "flag"):
        verdict = "pass"
    confidence = item.get("confidence")
    return {
        "verdict": verdict,
        "loaded_language": [
            str(x).strip() for x in (item.get("loaded_language") or []) if str(x).strip()
        ],
        "one_sided": bool(item.get("one_sided")),
        "unsupported_claims": [
            str(x).strip() for x in (item.get("unsupported_claims") or []) if str(x).strip()
        ],
        "missing_perspective": str(item.get("missing_perspective") or "").strip(),
        "confidence": float(confidence) if isinstance(confidence, int | float) else 0.5,
    }


async def _call_verifier(key: str, batch: list[dict]) -> dict[str, dict] | None:
    """One local-model verifier pass over a batch. ``None`` on any failure or
    unparseable output — the caller treats that as "no verdicts from key"."""
    payload = [
        {
            "id": str(s.get("id") or ""),
            "title": s.get("title") or "",
            "summary": s.get("neutral_summary") or s.get("neutral_rewrite") or "",
            "sources": (s.get("corroboration") or {}).get("sources") or [],
        }
        for s in batch
    ]
    system = with_prose_style(_VERIFY_SYSTEM) + "\n\n" + _INJECTION_GUARD
    user = "Stories to review (untrusted source text):\n" + _fence(_json_dumps(payload))
    try:
        parsed, res = await chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            tier="reason",
            local_model_key=key,
            label="news-verify",
        )
    except Exception:  # noqa: BLE001 — a verifier crashing must not sink the stage
        return None
    if not res.ok or not isinstance(parsed, list):
        return None
    out: dict[str, dict] = {}
    for item in parsed:
        if not isinstance(item, dict):
            continue
        sid = item.get("story_id")
        if isinstance(sid, str) and sid:
            out[sid] = _coerce_verdict(item)
    return out


async def _repair_story(story: dict, flags: dict) -> dict | None:
    """One repair call on the ORIGINAL drafting model (no local_model_key)."""
    payload = {
        "title": story.get("title"),
        "neutral_summary": story.get("neutral_summary"),
        "flagged_loaded_language": flags.get("loaded_language", []),
        "flagged_unsupported_claims": flags.get("unsupported_claims", []),
        "missing_perspective": flags.get("missing_perspective", ""),
    }
    system = with_prose_style(_REPAIR_SYSTEM) + "\n\n" + _INJECTION_GUARD
    user = "Story to repair (untrusted source text):\n" + _fence(_json_dumps(payload))
    try:
        parsed, res = await chat_json(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            tier="reason",
            label="news-verify-repair",
        )
    except Exception:  # noqa: BLE001 — repair is best-effort
        return None
    if not res.ok or not isinstance(parsed, dict):
        return None
    title = str(parsed.get("title") or "").strip()
    summary = str(parsed.get("neutral_summary") or "").strip()
    if not title or not summary:
        return None
    return {"title": title, "neutral_summary": summary}


# ── orchestration ────────────────────────────────────────────────────────────


async def verify_edition(edition: dict) -> dict:
    """Run the edition back through the local-verifier ensemble.

    Returns a NEW edition dict; ``edition`` is never mutated. Never widens the
    evidence a story carries: only ``title``/``neutral_summary`` text and
    ``verification``/``bias_review``/``countries`` metadata are touched.
    """
    new_edition = copy.deepcopy(edition)
    stories = new_edition.get("stories")
    if not isinstance(stories, list):
        stories = []
        new_edition["stories"] = stories

    for s in stories:
        if isinstance(s, dict):
            s["countries"] = country_tags(s)

    verifiers = resolve_verifiers()
    if not verifiers:
        for s in stories:
            if isinstance(s, dict):
                s["verification"] = {"skipped": "no verifier models installed"}
        new_edition["verification"] = {"models": [], "skipped": True}
        return new_edition

    settings = get_settings()
    budget_s = float(settings.news_verify_budget_s)
    start = time.monotonic()
    errors: list[str] = []
    stories_verified = 0
    stories_flagged = 0
    budget_exhausted = False
    hot_loaded: set[str] = set()

    for batch_start in range(0, len(stories), _BATCH_SIZE):
        batch = [s for s in stories[batch_start:batch_start + _BATCH_SIZE] if isinstance(s, dict)]
        if not batch:
            continue

        if time.monotonic() - start >= budget_s:
            budget_exhausted = True
            for s in batch:
                s["verification"] = {"skipped": "budget"}
            continue

        verdicts_by_model: dict[str, dict[str, dict]] = {}
        for key in verifiers:
            if time.monotonic() - start >= budget_s:
                budget_exhausted = True
                break
            if key not in hot_loaded:
                hot_loaded.add(key)
                try:
                    await llamacpp_sidecar.ensure_hot(key)
                except Exception as exc:  # noqa: BLE001 — cold-load still works
                    errors.append(f"{key}: ensure_hot failed: {exc}")
            verdicts = await _call_verifier(key, batch)
            if verdicts is None:
                errors.append(f"{key}: no verdicts (error or unparseable response)")
                continue
            verdicts_by_model[key] = verdicts

        for s in batch:
            sid = str(s.get("id") or "")
            responses = [
                (key, verdicts_by_model[key][sid])
                for key in verifiers
                if sid in verdicts_by_model.get(key, {})
            ]
            n = len(responses)
            models_used = [k for k, _ in responses]

            if n == 0:
                s["verification"] = {
                    "status": "unverified",
                    "models": models_used,
                    "verdicts": 0,
                    "note": "no verdicts received",
                }
                continue

            flag_responses = [(k, v) for k, v in responses if v["verdict"] == "flag"]
            n_flags = len(flag_responses)

            if n == 1:
                s["verification"] = {
                    "status": "reviewed",
                    "models": models_used,
                    "verdicts": n,
                    "note": "single-model review",
                }
                stories_verified += 1
                if n_flags:
                    stories_flagged += 1
                continue

            if n_flags == 0:
                diversity = diversity_of(s)
                status = (
                    "verified-neutral"
                    if diversity["outlets"] >= 2 and len(diversity["buckets"]) >= 2
                    else "reviewed"
                )
                s["verification"] = {
                    "status": status,
                    "models": models_used,
                    "verdicts": n,
                    "diversity": diversity,
                }
                stories_verified += 1
            elif n_flags == 1:
                _, verdict = flag_responses[0]
                original = {"title": s.get("title"), "neutral_summary": s.get("neutral_summary")}
                repaired = await _repair_story(s, verdict)
                if repaired:
                    s["title"] = repaired["title"]
                    s["neutral_summary"] = repaired["neutral_summary"]
                    status = "reviewed-revised"
                else:
                    status = "reviewed"
                    errors.append(f"story {sid}: repair call failed or unparseable")
                s["bias_review"] = {"original": original, "flags": verdict}
                s["verification"] = {"status": status, "models": models_used, "verdicts": n}
                stories_verified += 1
                stories_flagged += 1
            else:
                _revert_to_neutral_headline(s)
                s["verification"] = {
                    "status": "contested",
                    "models": models_used,
                    "verdicts": n,
                    "flags": [v for _, v in flag_responses],
                }
                stories_flagged += 1

    new_edition["verification"] = {
        "models": verifiers,
        "stories_verified": stories_verified,
        "stories_flagged": stories_flagged,
        "budget_exhausted": budget_exhausted,
        "errors": errors,
    }
    return new_edition
