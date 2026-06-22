"""LLM-driven debias / fact-check agent over scraped headlines.

Two entry points:
  - :func:`analyze`   — a small, BOUNDED multi-step agent. It (1) clusters the
    latest headlines into the top distinct events, (2) for each event runs a
    debias / corroboration step that separates VERIFIED FACTS (>=2 independent
    outlets) from ATTRIBUTED CLAIMS / rhetoric and flags propaganda techniques,
    and (3) runs a deterministic self-critique pass that re-checks every
    "verified fact" actually has >=2 distinct sources (downgrading it to an
    attributed claim otherwise) and that no leader's promise is reported as
    fact. Each LLM step is capped (events, tokens, wall-clock) and degrades to
    the prior single-shot shape — and ultimately to ``method: "llm
    unavailable"`` — when the model is down.
  - :func:`factcheck` — adjudicate a single free-text claim against headlines.

Every model reply is required to be strict JSON. On any LLM failure both
functions degrade to a well-formed empty shape rather than raising.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import re
from typing import Any

from app import llm
from app.news.sources import Article

# Cap how many headlines we hand the model — keeps the prompt small + cheap and
# well under context limits. The newest N (already sorted newest-first upstream).
_MAX_HEADLINES = 120
_SUMMARY_TRUNC = 200

# ── agent bounds ──────────────────────────────────────────────────────────────
# The agent is deliberately small + bounded: never more than this many events
# get a dedicated debias pass, and the whole loop is wall-clock-capped so a slow
# reasoner can never wedge the refresher.
_MAX_EVENTS = 8
_MAX_REFINED_EVENTS = 5  # how many top events get a dedicated per-event pass
_EVENT_CTX_HEADLINES = 40  # headlines handed to a per-event refine step
_AGENT_BUDGET_S = 80.0  # total wall-clock for the whole multi-step loop
_STEP_TIMEOUT_S = 25.0  # per per-event LLM step
_VERIFIED_MIN_SOURCES = 2  # a verified fact needs >=2 distinct outlets

# Words that signal a statement is a promise / prediction / opinion rather than
# an established fact — used by the deterministic self-critique to refuse to
# leave a leader's promise sitting in verified_facts.
# Tightened to genuine promise/prediction markers: future-tense modals plus
# intent verbs in their "<verb> to" form. Deliberately NOT matching bare
# report verbs like claim/warn/deny (those routinely introduce CORROBORATED
# facts — "officials confirmed the strike, which Reuters claimed…") and not
# `plan\w*`/`vow\w*` which over-matched "plane"/"vowel". This errs toward
# leaving genuine facts as facts while still catching "will end soon", "vows
# to", "plans to".
_PROMISE_RE = re.compile(
    r"\b(will|would|shall|promis\w*|pledg\w*|vow(?:s|ed|ing)?|"
    r"plans? to|planning to|aims? to|hopes? to|expects? to|intends? to|"
    r"threatens? to|going to|soon|by (?:next|the end of))\b",
    re.IGNORECASE,
)

# ── system prompts ──────────────────────────────────────────────────────────

_CLUSTER_SYSTEM = """\
You are a rigorous, non-partisan news desk editor. You will be given a JSON \
list of recent headlines from many outlets across the political spectrum, each \
tagged with its source and known leaning. Cluster them into the most \
significant DISTINCT events (about 8 or fewer). Reason ONLY over the headlines \
and summaries provided — never invent facts, sources, quotes, or numbers.

For each event give a short neutral title and which sources covered it. Output \
STRICT JSON ONLY, no prose, no markdown fences, matching exactly:
{
  "events": [
    {
      "title": "<short neutral event title>",
      "sources": ["<source name>", ...],
      "neutral_summary": "<one-line de-spun summary>"
    }
  ]
}
"""

_REFINE_SYSTEM = """\
You are a rigorous, non-partisan news analyst and fact-checker examining ONE \
event. You are given the event title plus the headlines/summaries that mention \
it, each tagged with source + leaning. Reason ONLY over the provided text — \
never invent facts, sources, quotes, or numbers.

Hard rules for what counts as a FACT:
- A statement is a VERIFIED FACT only if at least TWO INDEPENDENT outlets \
report it as fact (wire services like Reuters/AP and outlets of differing \
leaning count as independent; two feeds of the same parent do not).
- A statement made BY someone — a politician, official, spokesperson, or state \
outlet — is an ATTRIBUTED CLAIM, never a fact, no matter how often repeated. A \
leader promising "the war will end soon" is rhetoric / an attributed claim. If \
such a promise or assertion recurs across headlines without being fulfilled or \
independently confirmed, record it under rhetoric_flags as a repeated \
unfulfilled assertion — NOT under verified_facts.
- When outlets disagree on a claim, mark its status "disputed".

Also detect:
- bias_flags: loaded/emotive language, one-sidedness, missing context, framing \
that favors one party — attribute each to the specific source and quote the \
evidence.
- propaganda_techniques: name them explicitly (e.g. "card stacking", \
"glittering generalities", "name-calling", "appeal to fear", "bandwagon", \
"whataboutism", "false balance", "manufactured consensus").

Output STRICT JSON ONLY, no prose, no markdown fences, matching exactly:
{
  "title": "<short event title>",
  "neutral_summary": "<de-spun summary>",
  "corroboration": {"source_count": <int>, "sources": ["<name>", ...]},
  "verified_facts": ["<fact corroborated by >=2 independent outlets>", ...],
  "attributed_claims": [
    {"who": "<speaker>", "claim": "<claim>",
     "status": "unverified|disputed|corroborated"}
  ],
  "bias_flags": [
    {"source": "<name>", "technique": "<name>", "evidence": "<quote>"}
  ],
  "propaganda_techniques": ["<name>", ...],
  "rhetoric_flags": [
    {"who": "<speaker>", "claim": "<claim>",
     "note": "e.g. repeated promise, not a fact"}
  ],
  "confidence": <0..1>
}
"""

# Single-shot fallback prompt — used when the agent's clustering step fails but
# the model is otherwise reachable. Equivalent to the engine's prior behavior.
_ANALYZE_SYSTEM = """\
You are a rigorous, non-partisan news analyst and fact-checker. You will be \
given a JSON list of recent news headlines from many outlets across the \
political spectrum, each tagged with its source and known leaning. Reason ONLY \
over the headlines and short summaries provided — never invent facts, sources, \
quotes, or numbers that are not present.

Hard rules for what counts as a FACT:
- A statement is a VERIFIED FACT only if at least TWO INDEPENDENT outlets \
report it as fact (wire services like Reuters/AP and outlets of differing \
leaning count as independent; two feeds of the same parent do not).
- A statement made BY someone — a politician, official, spokesperson, or \
state outlet — is an ATTRIBUTED CLAIM, never a fact, no matter how many times \
it is repeated. Example: a leader promising "the war will end soon" is rhetoric \
/ an attributed claim. If such a promise or assertion recurs across headlines \
without being fulfilled or independently confirmed, record it under \
rhetoric_flags as a repeated unfulfilled assertion — NOT under verified_facts.
- When outlets disagree on a claim, mark it "disputed".

Also detect, per event:
- bias_flags: loaded/emotive language, one-sidedness, missing context, framing \
that favors one party — attribute each to the specific source and quote the \
evidence.
- propaganda_techniques: name them explicitly (e.g. "card stacking", \
"glittering generalities", "name-calling", "appeal to fear", "bandwagon", \
"whataboutism", "false balance", "manufactured consensus").

Cluster the headlines into the most significant distinct events (about 8 or \
fewer). Write a neutral_summary for each in plain, de-spun language.

Output STRICT JSON ONLY, no prose, no markdown fences, matching exactly:
{
  "generated": "<iso8601 or null>",
  "events": [
    {
      "title": "<short event title>",
      "neutral_summary": "<de-spun summary>",
      "corroboration": {"source_count": <int>, "sources": ["<name>", ...]},
      "verified_facts": ["<fact corroborated by >=2 independent outlets>", ...],
      "attributed_claims": [
        {"who": "<speaker>", "claim": "<claim>",
         "status": "unverified|disputed|corroborated"}
      ],
      "bias_flags": [
        {"source": "<name>", "technique": "<name>", "evidence": "<quote>"}
      ],
      "propaganda_techniques": ["<name>", ...],
      "rhetoric_flags": [
        {"who": "<speaker>", "claim": "<claim>",
         "note": "e.g. repeated promise, not a fact"}
      ],
      "confidence": <0..1>
    }
  ],
  "method": "<one line describing how you judged this>"
}
"""

_FACTCHECK_SYSTEM = """\
You are a careful, non-partisan fact-checker. Adjudicate the single claim the \
user gives you. Use ONLY the provided context headlines plus widely-established \
public record — do NOT fabricate sources or specifics. A claim is "true" only \
when independently corroborated; a promise or prediction by an official (e.g. \
"the war will end soon") is inherently "unverified" rhetoric until it actually \
happens. Prefer "misleading" when a claim is technically defensible but framed \
to deceive, "disputed"/"unverified" when evidence is thin or conflicting.

Output STRICT JSON ONLY matching exactly:
{
  "claim": "<the claim>",
  "verdict": "true|false|misleading|unverified",
  "reasoning": "<concise, evidence-based>",
  "supporting_sources": ["<source or headline>", ...],
  "confidence": <0..1>
}
"""


def _now_iso() -> str:
    return _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]{3,}")

# Common headline words that carry no clustering signal.
_STOPWORDS = frozenset(
    {
        "after", "again", "against", "amid", "among", "around", "before", "being",
        "could", "first", "from", "have", "into", "more", "most", "near", "over",
        "says", "said", "report", "reports", "than", "that", "their", "there",
        "these", "they", "this", "what", "when", "where", "which", "while", "with",
        "world", "news", "live", "video", "watch", "update", "updates", "latest",
        "would", "about", "will", "your", "year", "years", "week", "still", "back",
    }
)


def _significant_tokens(title: str) -> set[str]:
    return {
        t.lower()
        for t in _TOKEN_RE.findall(title)
        if t.lower() not in _STOPWORDS
    }


def cluster_titles(articles: list[Article], max_clusters: int = 8) -> list[list[Article]]:
    """Cheap offline clustering: group articles sharing significant tokens.

    A greedy single-link pass — each article joins the first existing cluster it
    shares >=2 significant tokens with, else seeds a new cluster. Clusters are
    returned largest-first (the biggest stories corroborate across outlets), and
    only the top ``max_clusters`` are kept.
    """
    clusters: list[dict[str, Any]] = []
    for art in articles:
        toks = _significant_tokens(art.title)
        if not toks:
            clusters.append({"toks": set(), "arts": [art]})
            continue
        placed = False
        for cl in clusters:
            if len(toks & cl["toks"]) >= 2:
                cl["arts"].append(art)
                cl["toks"] |= toks
                placed = True
                break
        if not placed:
            clusters.append({"toks": set(toks), "arts": [art]})

    clusters.sort(key=lambda c: len(c["arts"]), reverse=True)
    return [cl["arts"] for cl in clusters[:max_clusters]]


def _compact_headlines(articles: list[Article]) -> list[dict[str, str]]:
    """Compact {source, leaning, title, summary} payload for the model."""
    out: list[dict[str, str]] = []
    for art in articles[:_MAX_HEADLINES]:
        out.append(
            {
                "source": art.source,
                "leaning": art.leaning,
                "title": art.title,
                "summary": (art.summary or "")[:_SUMMARY_TRUNC],
            }
        )
    return out


def _degraded(error: str | None) -> dict[str, Any]:
    return {"events": [], "method": "llm unavailable", "error": error}


# ── deterministic self-critique / verification ──────────────────────────────


def _coerce_event(ev: Any) -> dict[str, Any]:
    """Coerce a raw model event into the panel's expected shape (never raises)."""
    if not isinstance(ev, dict):
        ev = {}
    title = str(ev.get("title") or "").strip()
    summary = str(ev.get("neutral_summary") or "").strip()

    corr = ev.get("corroboration")
    if not isinstance(corr, dict):
        corr = {}
    sources = corr.get("sources")
    if not isinstance(sources, list):
        sources = []
    sources = [str(s).strip() for s in sources if str(s).strip()]
    src_count = corr.get("source_count")
    if not isinstance(src_count, int):
        src_count = len(sources)

    def _list(key: str) -> list[Any]:
        v = ev.get(key)
        return v if isinstance(v, list) else []

    verified = [str(f).strip() for f in _list("verified_facts") if str(f).strip()]
    claims = [c for c in _list("attributed_claims") if isinstance(c, dict)]
    rhetoric = [r for r in _list("rhetoric_flags") if isinstance(r, dict)]
    bias = [b for b in _list("bias_flags") if isinstance(b, dict)]
    techniques = [str(p).strip() for p in _list("propaganda_techniques") if str(p).strip()]

    conf = ev.get("confidence")
    if not isinstance(conf, int | float):
        conf = 0.0

    return {
        "title": title,
        "neutral_summary": summary,
        "corroboration": {"source_count": src_count, "sources": sources},
        "verified_facts": verified,
        "attributed_claims": claims,
        "rhetoric_flags": rhetoric,
        "bias_flags": bias,
        "propaganda_techniques": techniques,
        "confidence": float(conf),
    }


def _self_critique_event(ev: dict[str, Any]) -> dict[str, Any]:
    """Deterministic verification pass over one coerced event.

    Enforces the engine's two non-negotiable rules without another LLM round:
      1. A "verified fact" must rest on >=2 distinct corroborating sources.
         When the event's corroboration carries fewer than two distinct
         outlets, every "verified fact" is downgraded to an unverified
         attributed claim (who="unattributed") — we cannot prove independence.
      2. A leader's promise / prediction / opinion is never a verified fact.
         Any verified-fact string that reads as a promise ("...will end soon",
         "pledges", "vows", "plans to") is moved to rhetoric_flags.
    """
    corr = ev.get("corroboration") or {}
    sources = corr.get("sources") if isinstance(corr.get("sources"), list) else []
    distinct = len({str(s).strip().lower() for s in sources if str(s).strip()})
    # source_count the model asserted; trust the larger of asserted vs distinct
    # names it listed, but a numeric claim with no listed names cannot promote a
    # fact past the >=2 gate on its own — require at least the asserted count.
    asserted = corr.get("source_count")
    asserted = asserted if isinstance(asserted, int) else 0
    corroborating = max(distinct, asserted)

    verified_in = list(ev.get("verified_facts") or [])
    kept_facts: list[str] = []
    downgraded_claims: list[dict[str, Any]] = []
    new_rhetoric: list[dict[str, Any]] = []

    for fact in verified_in:
        text = str(fact).strip()
        if not text:
            continue
        if _PROMISE_RE.search(text):
            # Rule 2 — a promise / prediction is rhetoric, not a fact.
            new_rhetoric.append(
                {
                    "who": "asserted",
                    "claim": text,
                    "note": "promise / prediction — not an established fact",
                }
            )
            continue
        if corroborating < _VERIFIED_MIN_SOURCES:
            # Rule 1 — not enough independent corroboration to call it a fact.
            downgraded_claims.append(
                {
                    "who": "unattributed",
                    "claim": text,
                    "status": "unverified",
                }
            )
            continue
        kept_facts.append(text)

    ev["verified_facts"] = kept_facts
    if downgraded_claims:
        ev["attributed_claims"] = list(ev.get("attributed_claims") or []) + downgraded_claims
    if new_rhetoric:
        ev["rhetoric_flags"] = list(ev.get("rhetoric_flags") or []) + new_rhetoric

    # The corroboration source_count should reflect the distinct outlets we can
    # actually name when we have them; keep the model's number otherwise.
    if distinct:
        ev["corroboration"] = {"source_count": corroborating, "sources": list(sources)}
    return ev


def _finalize(
    events: list[dict[str, Any]],
    articles: list[Article],
    *,
    method: str,
    steps: int,
    backend: str | None,
) -> dict[str, Any]:
    """Coerce + self-critique every event and attach run metadata."""
    out_events = [_self_critique_event(_coerce_event(ev)) for ev in events][:_MAX_EVENTS]
    return {
        "generated": _now_iso(),
        "events": out_events,
        "method": method,
        "agent_steps": steps,
        "backend": backend,
        "source_count": len({a.source for a in articles}),
        "article_count": len(articles),
    }


# ── agent steps ──────────────────────────────────────────────────────────────


async def _cluster_events(
    payload: list[dict[str, str]],
) -> tuple[list[dict[str, Any]], llm.LlmResult]:
    """Step 1 — ask the model to cluster headlines into distinct events."""
    user = (
        "Headlines (JSON):\n"
        + _json_dumps(payload)
        + "\n\nReturn the strict JSON {\"events\": [...]} described in the system prompt."
    )
    parsed, res = await llm.chat_json(
        [
            {"role": "system", "content": _CLUSTER_SYSTEM},
            {"role": "user", "content": user},
        ],
        tier="reason",
        temperature=0.1,
        max_tokens=2048,
    )
    events: list[dict[str, Any]] = []
    if isinstance(parsed, dict) and isinstance(parsed.get("events"), list):
        events = [e for e in parsed["events"] if isinstance(e, dict)]
    return events, res


def _headlines_for_event(
    event: dict[str, Any], articles: list[Article]
) -> list[dict[str, str]]:
    """Pick the headlines most relevant to one event (by source + token overlap)."""
    title = str(event.get("title") or "")
    summary = str(event.get("neutral_summary") or "")
    want_tokens = _significant_tokens(f"{title} {summary}")
    want_sources = {str(s).strip().lower() for s in (event.get("sources") or []) if str(s).strip()}

    scored: list[tuple[int, Article]] = []
    for art in articles:
        toks = _significant_tokens(art.title)
        score = len(toks & want_tokens)
        if art.source.lower() in want_sources:
            score += 2
        if score > 0:
            scored.append((score, art))
    scored.sort(key=lambda t: t[0], reverse=True)
    picked = [a for _, a in scored[:_EVENT_CTX_HEADLINES]]
    if not picked:  # nothing matched — fall back to the freshest few
        picked = articles[:_EVENT_CTX_HEADLINES]
    return _compact_headlines(picked)


async def _refine_event(
    event: dict[str, Any], articles: list[Article]
) -> dict[str, Any] | None:
    """Step 2 — debias + corroborate one event against its headlines."""
    ctx = _headlines_for_event(event, articles)
    user = (
        f"Event: {event.get('title') or '(untitled)'}\n\n"
        "Headlines mentioning this event (JSON):\n"
        + _json_dumps(ctx)
        + "\n\nReturn the strict JSON event object described in the system prompt."
    )
    try:
        parsed, res = await asyncio.wait_for(
            llm.chat_json(
                [
                    {"role": "system", "content": _REFINE_SYSTEM},
                    {"role": "user", "content": user},
                ],
                tier="reason",
                temperature=0.1,
                max_tokens=2048,
            ),
            timeout=_STEP_TIMEOUT_S,
        )
    except Exception:  # noqa: BLE001 — a slow (TimeoutError) or failed event must not sink the run
        return None
    if not res.ok or not isinstance(parsed, dict):
        return None
    # The model may answer with a bare event object or wrap it in {"events":[...]}.
    if isinstance(parsed.get("events"), list) and parsed["events"]:
        first = parsed["events"][0]
        if isinstance(first, dict):
            parsed = first
    # Carry the desk-editor title/sources forward when the refine step omitted them.
    parsed.setdefault("title", event.get("title"))
    if "corroboration" not in parsed and event.get("sources"):
        srcs = [str(s) for s in event["sources"]]
        parsed["corroboration"] = {"source_count": len(set(srcs)), "sources": srcs}
    return parsed


# ── public api ────────────────────────────────────────────────────────────────


async def _single_shot(
    payload: list[dict[str, str]], articles: list[Article]
) -> dict[str, Any] | None:
    """Fallback — the engine's prior one-call behavior. Returns None on failure."""
    user = (
        "Headlines (JSON):\n"
        + _json_dumps(payload)
        + "\n\nReturn the strict JSON object described in the system prompt."
    )
    parsed, res = await llm.chat_json(
        [
            {"role": "system", "content": _ANALYZE_SYSTEM},
            {"role": "user", "content": user},
        ],
        tier="reason",
        temperature=0.1,
        max_tokens=4096,
    )
    if not res.ok or not isinstance(parsed, dict):
        return None
    events = parsed.get("events")
    if not isinstance(events, list):
        events = []
    return _finalize(
        events,
        articles,
        method="reason-tier single-shot debias (agent clustering unavailable)",
        steps=1,
        backend=res.backend,
    )


async def analyze(articles: list[Article]) -> dict[str, Any]:
    """Debias + fact-check the latest headlines via a bounded multi-step agent.

    Loop: (1) cluster headlines into events, (2) per-event debias + corroborate,
    (3) deterministic self-critique that re-checks every verified fact has >=2
    distinct sources and never leaves a promise as a fact. Falls back to the
    prior single-shot call when clustering fails, and to ``{"events": [],
    "method": "llm unavailable", ...}`` when the model is unreachable.
    """
    if not articles:
        return {"generated": _now_iso(), "events": [], "method": "no articles"}

    # Cheap offline clustering bounds + orders what we hand the model.
    clusters = cluster_titles(articles, max_clusters=_MAX_EVENTS)
    ordered: list[Article] = []
    seen_links: set[str] = set()
    for cl in clusters:
        for art in cl:
            key = art.link or f"{art.source}:{art.title}"
            if key not in seen_links:
                seen_links.add(key)
                ordered.append(art)
    for art in articles:  # keep breadth — append anything no cluster captured
        key = art.link or f"{art.source}:{art.title}"
        if key not in seen_links:
            seen_links.add(key)
            ordered.append(art)

    payload = _compact_headlines(ordered)

    loop = asyncio.get_event_loop()
    deadline = loop.time() + _AGENT_BUDGET_S

    # ── Step 1: cluster into events ────────────────────────────────────────
    candidate_events, res = await _cluster_events(payload)
    if not res.ok:
        return _degraded(res.error or "model returned non-JSON")
    if not candidate_events:
        # Model reachable but gave no usable clustering — fall back to one shot.
        try:
            single = await asyncio.wait_for(_single_shot(payload, articles), timeout=70.0)
        except TimeoutError:
            single = None
        return single if single is not None else _degraded(res.error or "no events")

    # ── Step 2: per-event debias + corroborate (bounded, time-boxed) ───────
    refined: list[dict[str, Any]] = []
    steps = 1
    backend = res.backend
    for ev in candidate_events[:_MAX_REFINED_EVENTS]:
        if loop.time() >= deadline:
            break
        out = await _refine_event(ev, articles)
        steps += 1
        if out is not None:
            refined.append(out)
        else:
            # Keep the desk-editor stub so the event still surfaces.
            refined.append(ev)
    # Any events beyond the refine cap pass through as cluster stubs.
    for ev in candidate_events[_MAX_REFINED_EVENTS:_MAX_EVENTS]:
        refined.append(ev)

    # ── Step 3: deterministic self-critique (in _finalize) ─────────────────
    method = (
        f"agent: cluster -> {min(len(candidate_events), _MAX_REFINED_EVENTS)} per-event "
        "debias -> self-critique (verified facts need >=2 distinct sources)"
    )
    return _finalize(refined, articles, method=method, steps=steps, backend=backend)


async def factcheck(
    claim: str,
    context_headlines: list[str] | None = None,
    *,
    fast: bool = False,
    as_of: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> dict[str, Any]:
    """Adjudicate a single free-text claim. Degrades on LLM failure.

    ``fast=True`` routes to the cheap ``"fast"`` tier (``deepseek-chat``) for a
    quick first-look verdict — the reasoner tier (default) is slow (~tens of
    seconds) for an interactive operator. Same prompt + same strict-JSON
    coercion either way; only the model id differs.

    ``as_of`` — optional ISO-8601 / human timestamp string; when given, prepended
    to the user prompt so the model scopes its reasoning to that time.
    ``bbox`` — optional ``(west, south, east, north)`` bounding box; when given,
    prepended so the model scopes its geographic reasoning.
    """
    claim = (claim or "").strip()
    if not claim:
        return {
            "claim": "",
            "verdict": "unverified",
            "reasoning": "empty claim",
            "supporting_sources": [],
            "confidence": 0.0,
        }

    scope_lines: list[str] = []
    if as_of:
        scope_lines.append(f"As of: {as_of}")
    if bbox is not None:
        scope_lines.append(f"Geographic scope: bbox={bbox}")
    scope_prefix = ("\n".join(scope_lines) + "\n\n") if scope_lines else ""

    ctx = ""
    if context_headlines:
        joined = "\n".join(f"- {h}" for h in context_headlines[:_MAX_HEADLINES])
        ctx = f"\n\nContext headlines:\n{joined}"
    user = f"{scope_prefix}Claim: {claim}{ctx}\n\nReturn the strict JSON verdict object."

    parsed, res = await llm.chat_json(
        [
            {"role": "system", "content": _FACTCHECK_SYSTEM},
            {"role": "user", "content": user},
        ],
        tier="fast" if fast else "reason",
        temperature=0.1,
        max_tokens=1024,
    )
    if not res.ok or not isinstance(parsed, dict):
        return {
            "claim": claim,
            "verdict": "unverified",
            "reasoning": "llm unavailable",
            "supporting_sources": [],
            "confidence": 0.0,
            "error": res.error or "model returned non-JSON",
        }

    parsed.setdefault("claim", claim)
    if parsed.get("verdict") not in {"true", "false", "misleading", "unverified"}:
        parsed["verdict"] = "unverified"
    parsed.setdefault("reasoning", "")
    if not isinstance(parsed.get("supporting_sources"), list):
        parsed["supporting_sources"] = []
    if not isinstance(parsed.get("confidence"), int | float):
        parsed["confidence"] = 0.0
    return parsed


def _json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
