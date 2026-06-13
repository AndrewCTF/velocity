"""LLM-driven debias / fact-check over scraped headlines.

Two entry points:
  - :func:`analyze`   — cluster the latest headlines into the top events and,
    for each, separate verified facts (>=2 independent outlets) from attributed
    claims / rhetoric, flag bias + propaganda techniques.
  - :func:`factcheck` — adjudicate a single free-text claim against headlines.

Every model reply is required to be strict JSON. On any LLM failure both
functions degrade to a well-formed empty shape rather than raising.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any

from app import llm
from app.news.sources import Article

# Cap how many headlines we hand the model — keeps the prompt small + cheap and
# well under context limits. The newest N (already sorted newest-first upstream).
_MAX_HEADLINES = 120
_SUMMARY_TRUNC = 200

# ── system prompts ──────────────────────────────────────────────────────────

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


async def analyze(articles: list[Article]) -> dict[str, Any]:
    """Debias + fact-check the latest headlines into a structured event bundle.

    On LLM failure, returns ``{"events": [], "method": "llm unavailable",
    "error": ...}`` rather than raising.
    """
    if not articles:
        return {"generated": _now_iso(), "events": [], "method": "no articles"}

    # Cheap offline clustering bounds + orders what we hand the model; we still
    # pass the flat compact list (the model re-clusters with its own judgement,
    # but ordering by cluster size puts the biggest stories first within the cap).
    clusters = cluster_titles(articles, max_clusters=8)
    ordered: list[Article] = []
    seen_links: set[str] = set()
    for cl in clusters:
        for art in cl:
            key = art.link or f"{art.source}:{art.title}"
            if key not in seen_links:
                seen_links.add(key)
                ordered.append(art)
    # Append any leftover articles not captured by a cluster (keeps breadth).
    for art in articles:
        key = art.link or f"{art.source}:{art.title}"
        if key not in seen_links:
            seen_links.add(key)
            ordered.append(art)

    payload = _compact_headlines(ordered)
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
        return _degraded(res.error or "model returned non-JSON")

    parsed.setdefault("generated", _now_iso())
    events = parsed.get("events")
    if not isinstance(events, list):
        parsed["events"] = []
    parsed.setdefault("method", "reason-tier cross-source debias + fact-check")
    parsed["source_count"] = len({a.source for a in articles})
    parsed["article_count"] = len(articles)
    return parsed


async def factcheck(claim: str, context_headlines: list[str] | None = None) -> dict[str, Any]:
    """Adjudicate a single free-text claim. Degrades on LLM failure."""
    claim = (claim or "").strip()
    if not claim:
        return {
            "claim": "",
            "verdict": "unverified",
            "reasoning": "empty claim",
            "supporting_sources": [],
            "confidence": 0.0,
        }

    ctx = ""
    if context_headlines:
        joined = "\n".join(f"- {h}" for h in context_headlines[:_MAX_HEADLINES])
        ctx = f"\n\nContext headlines:\n{joined}"
    user = f"Claim: {claim}{ctx}\n\nReturn the strict JSON verdict object."

    parsed, res = await llm.chat_json(
        [
            {"role": "system", "content": _FACTCHECK_SYSTEM},
            {"role": "user", "content": user},
        ],
        tier="reason",
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
