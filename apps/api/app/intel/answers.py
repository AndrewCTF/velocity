"""Named questions with published thresholds, answered from owned history.

Why this module exists, in one comparison from docs/research-last30days-2026-07-29.md:

  - "Show HN: Is Hormuz open yet?" - a site that answers ONE question with ONE
    word, built in a few hours on a data source with a four-day lag, whose
    author said so in the first paragraph. 484 points, 209 comments (§3).
  - Our own r/geospatial post, "Multi-source live geospatial fusion on a Cesium
    globe, with GeoJSON/CSV/KML export for QGIS" - 2 points, no comments (§2).

The audience does not reward a capability. It rewards a decision. So an Answer
here is not a chart or a layer: it is a verdict, the rule that produced it, and
the age of the evidence underneath it.

Three fields are mandatory and the dataclass will not construct without them:

  verdict     what the answer IS, in one word an operator can act on
  threshold   the rule, in words, that turned the numbers into that word
  data_lag_s  how old the newest evidence is

`threshold` is mandatory because the first question the technical audience asked
of that 484-point site was "what's the threshold function?" - an unexplained
verdict is treated as no verdict. `data_lag_s` is mandatory because the same
author led with his four-day lag and was rewarded for it, while the largest
cluster of complaints on a 312-point launch was a map that failed silently (§5.1).

And "unknown" is a first-class verdict. A tool for people who check things has
to be able to say it does not know yet, with the reason attached, rather than
producing a confident number from three hours of history.
"""

from __future__ import annotations

import statistics
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from app import history
from app.routes.oceans import _CHOKEPOINTS

# Verdict vocabulary. Deliberately small: an operator can act on four words and
# cannot act on a percentile.
OPEN = "open"
REDUCED = "reduced"
CLOSED = "closed"
UNKNOWN = "unknown"

# Traffic below this share of the baseline reads as CLOSED, and below the
# reduced share as REDUCED. The closed threshold matches the reference
# implementation's published rule ("under 25% of the prior year's crossing")
# because it was argued in public and nobody disputed it; the reduced band is
# ours, to avoid a cliff between "fine" and "shut".
CLOSED_RATIO = 0.25
REDUCED_RATIO = 0.60

# A baseline needs at least this many complete prior days to mean anything.
# Below it we say so rather than dividing by a number we do not trust.
MIN_BASELINE_DAYS = 3
# Evidence older than this makes the answer stale regardless of its verdict.
MAX_ANSWER_LAG_S = 3 * 3600.0

DAY_S = 86_400.0


@dataclass(frozen=True)
class Answer:
    """One named question, answered.

    `inputs` carries the ids the verdict was computed from where that is small
    enough to be useful; it is the citation trail, so a reader can go and look at
    the same contacts rather than taking the number on trust.
    """

    id: str
    question: str
    verdict: str
    threshold: str
    as_of: float
    # Age of the newest evidence, in seconds. `None` means NO EVIDENCE WAS
    # OBSERVED - it never means "fresh". The distinction matters on the wire:
    # float("inf") does not survive JSON and arrives as null, so a consumer
    # reading null as zero would turn "we have nothing" into "perfectly
    # current", which is the exact inversion this whole design exists to
    # prevent. `stale` is always true when this is None, so a consumer that
    # checks staleness rather than arithmetic cannot get it wrong.
    data_lag_s: float | None
    confidence: str
    detail: str
    inputs: list[str] = field(default_factory=list)
    observed: float | None = None
    baseline: float | None = None

    @property
    def stale(self) -> bool:
        """True when the evidence is too old for the verdict to be trusted.

        Surfaced rather than silently downgrading the verdict: the caller sees
        both what we concluded and that the conclusion is ageing. No evidence at
        all counts as stale, never as fresh.
        """
        return self.data_lag_s is None or self.data_lag_s > MAX_ANSWER_LAG_S

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["stale"] = self.stale
        return d


def _unknown(qid: str, question: str, threshold: str, why: str) -> Answer:
    """The honest answer. Carries the reason, so "unknown" is informative."""
    return Answer(
        id=qid,
        question=question,
        verdict=UNKNOWN,
        threshold=threshold,
        as_of=time.time(),
        # Nothing was observed, so there is no evidence to be lagging. Reporting
        # 0 would read as "perfectly fresh", which is the opposite of the truth.
        data_lag_s=None,
        confidence="low",
        detail=why,
        inputs=[],
    )


def chokepoint_ids() -> list[str]:
    """Slugs for every chokepoint we can answer about."""
    return [_slug(name) for name, *_ in _CHOKEPOINTS]


def _slug(name: str) -> str:
    keep = [c.lower() if c.isalnum() else "-" for c in name]
    out = "".join(keep)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def _find_chokepoint(qid: str) -> tuple[str, float, float, float, float] | None:
    for name, lomin, lamin, lomax, lamax, _clon, _clat in _CHOKEPOINTS:
        if _slug(name) == qid or qid in _slug(name):
            return name, lomin, lamin, lomax, lamax
    return None


CHOKEPOINT_THRESHOLD = (
    f"Distinct vessels seen in the strait over the last 24 hours, against the "
    f"median of the previous complete days we have recorded. Under "
    f"{int(CLOSED_RATIO * 100)}% of that median reads as closed, under "
    f"{int(REDUCED_RATIO * 100)}% as reduced, otherwise open. Needs at least "
    f"{MIN_BASELINE_DAYS} prior days of our own recording before it will answer."
)


async def chokepoint_answer(qid: str, now: float | None = None) -> Answer:
    """Is this strait moving traffic?

    Counts DISTINCT vessels rather than position reports. A ship anchored in the
    strait for six hours produces hundreds of rows and one transit; counting rows
    would make congestion look like healthy traffic, which is precisely backwards
    for the question being asked.

    The baseline is our own recorded history, not a published figure, so it
    describes what THIS deployment can actually see. That makes it honest about
    coverage: a deployment whose AIS feed only reaches part of the strait gets a
    baseline from that same partial view, and the ratio still means something.
    """
    t_now = time.time() if now is None else now
    found = _find_chokepoint(qid)
    if not found:
        return _unknown(
            qid,
            f"Is {qid} open?",
            CHOKEPOINT_THRESHOLD,
            "No chokepoint with that name. See /api/answers for the list.",
        )
    name, lomin, lamin, lomax, lamax = found
    question = f"Is {name} open?"

    # Look back far enough for a baseline plus today. Retention clamps this.
    lookback_days = MIN_BASELINE_DAYS + 8
    t_from = t_now - lookback_days * DAY_S
    try:
        buckets = await history.distinct_ids_per_bucket(
            "vessel", (lomin, lamin, lomax, lamax), t_from, t_now, DAY_S
        )
    except Exception:  # noqa: BLE001 — an answer must degrade, never 500
        return _unknown(qid, question, CHOKEPOINT_THRESHOLD, "History store unavailable.")

    if not buckets:
        return _unknown(
            qid,
            question,
            CHOKEPOINT_THRESHOLD,
            "No recorded vessel history in this strait yet. Leave the console "
            "recording and this answers itself.",
        )

    # Buckets are anchored at t_from, so the LAST bucket is the rolling 24 hours
    # ending now, and the ones before it are complete days.
    counts = {int((b - t_from) // DAY_S): n for b, n in buckets}
    last_idx = max(counts)
    observed = counts.get(last_idx, 0)
    prior = [counts.get(i, 0) for i in range(last_idx)]
    # Drop leading zero days: those are days before recording started, not quiet
    # days in the strait, and averaging them in would depress the baseline and
    # make an ordinary day look busy.
    while prior and prior[0] == 0:
        prior.pop(0)

    if len(prior) < MIN_BASELINE_DAYS:
        return _unknown(
            qid,
            question,
            CHOKEPOINT_THRESHOLD,
            f"Only {len(prior)} complete day(s) of recorded history here; "
            f"{MIN_BASELINE_DAYS} are needed before a baseline means anything.",
        )

    baseline = statistics.median(prior)
    if baseline <= 0:
        return _unknown(
            qid, question, CHOKEPOINT_THRESHOLD, "Baseline traffic is zero; nothing to compare."
        )

    ratio = observed / baseline
    if ratio < CLOSED_RATIO:
        verdict = CLOSED
    elif ratio < REDUCED_RATIO:
        verdict = REDUCED
    else:
        verdict = OPEN

    # More recorded days make the baseline more trustworthy. This is the only
    # thing we actually know about our own certainty, so it is the only thing the
    # confidence reflects.
    confidence = "high" if len(prior) >= 7 else "medium"
    lag = max(0.0, t_now - (t_from + last_idx * DAY_S))

    return Answer(
        id=qid,
        question=question,
        verdict=verdict,
        threshold=CHOKEPOINT_THRESHOLD,
        as_of=t_now,
        # The newest evidence is as old as the newest position in the bucket. We
        # bucket by day, so the honest statement is the age of the bucket window
        # rather than a precision we do not have.
        data_lag_s=min(lag, DAY_S),
        confidence=confidence,
        detail=(
            f"{observed} distinct vessels in the last 24 hours against a median of "
            f"{baseline:.0f} across {len(prior)} recorded days ({ratio * 100:.0f}%)."
        ),
        observed=float(observed),
        baseline=float(baseline),
    )


async def all_answers(now: float | None = None) -> list[dict[str, Any]]:
    """Every registered answer. Order is stable so the dashboard does not jump."""
    out: list[dict[str, Any]] = []
    for qid in chokepoint_ids():
        out.append((await chokepoint_answer(qid, now)).to_dict())
    return out
