"""Characterise a detected vessel from geometry, radar return and AIS behaviour.

The operator's ask: *"in Palantir I saw they run AI inference on satellite
imagery and then they know what warship it is. How can we do that without
high-resolution data?"*

The honest answer, stated once and then built to: **at 10-20 m per pixel you
cannot read a hull number, and no model will give you one.** A 150 m frigate is
about eight pixels long in a Sentinel-1 GRD chip. What those eight pixels DO
carry is length, beam, orientation and radar cross-section, and those are
genuinely discriminating — hull form is the most constrained thing about a ship.
Fusing them with AIS presence and behaviour is what Palantir's own demo actually
narrates (docs/palantir-reference-2026-07.md §6, S12: *"Ship detection models
identify an alarming buildup of fishing vessels… an activity model detects that
many of those ships are tied together"*). Detection, geometry, behaviour, fusion
— never pixel-level recognition.

So this module returns a RANKED list of candidate classes, each with a score and
the evidence that produced it, and it is designed to be unable to express false
certainty:

* it never returns one answer, it returns an ordered set;
* every candidate carries the reasons, so an analyst can disagree with the
  reasoning rather than just the conclusion;
* when the geometry does not discriminate, the top candidates come back with
  close scores and ``confidence`` reads ``low`` — which is the correct output,
  not a failure.

No model weights, no torch, no network. Pure geometry and priors, which is what
makes it run in the API process on an edge box where a GPU model cannot.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# ── hull priors ───────────────────────────────────────────────────────────────
#
# length/beam envelopes from published dimensions for each class. The
# length-to-beam RATIO is the load-bearing feature: warships are slender (L/B
# 7-10) because they are built for speed, merchants are full-bodied (L/B 5-7)
# because they are built for volume. That single ratio separates a 150 m frigate
# from a 150 m coastal freighter, which raw length alone cannot.


@dataclass(frozen=True)
class _Prior:
    name: str
    len_min: float
    len_max: float
    beam_min: float
    beam_max: float
    lb_min: float  # length/beam ratio
    lb_max: float
    note: str


_PRIORS: tuple[_Prior, ...] = (
    _Prior("small craft / skiff", 3, 20, 1, 6, 2.5, 6.0, "under 20 m"),
    _Prior("fishing vessel", 15, 75, 4, 14, 3.0, 7.0, "trawler envelope"),
    _Prior("tug / offshore supply", 20, 90, 7, 20, 3.0, 6.0, "beamy for its length"),
    _Prior("patrol boat / corvette", 40, 105, 6, 15, 6.5, 10.5, "slender, naval L/B"),
    _Prior("coastal freighter", 60, 140, 10, 22, 5.0, 7.5, "full-bodied merchant"),
    _Prior("frigate / destroyer", 105, 175, 12, 22, 7.0, 10.0, "slender, naval L/B"),
    _Prior("cruiser / large combatant", 170, 250, 18, 30, 7.5, 10.5, "slender, naval L/B"),
    _Prior("general cargo / container", 120, 400, 18, 62, 5.5, 8.0, "merchant envelope"),
    _Prior("bulk carrier", 150, 300, 22, 50, 5.0, 7.0, "full-bodied merchant"),
    _Prior("tanker", 150, 380, 25, 70, 5.0, 7.0, "full-bodied merchant"),
    _Prior("aircraft carrier / LHA", 230, 340, 35, 80, 3.5, 7.0, "very wide flight deck"),
)

# A contact only earns a naval reading if it is BOTH in a naval L/B band and not
# on AIS. Warships routinely run dark; merchants that run dark are the anomaly
# worth flagging, not evidence of being a warship.
_NAVAL = {"patrol boat / corvette", "frigate / destroyer", "cruiser / large combatant"}


def _band_score(value: float, lo: float, hi: float) -> float:
    """1.0 inside the band, decaying outside it rather than snapping to 0.

    A hard in/out test would make a 176 m destroyer (band 105-175) score zero on
    the class it obviously is. Measurement error at 20 m/px is ±1 pixel, which is
    ±20 m of length — bands have to be soft or the whole thing is brittle.
    """
    if lo <= value <= hi:
        return 1.0
    span = max(hi - lo, 1.0)
    dist = (lo - value) if value < lo else (value - hi)
    # Half a band-width away scores ~0.37; a full band-width away ~0.14.
    return float(max(0.0, 2.718 ** (-2.0 * dist / span)))


def characterise(
    length_m: float,
    width_m: float,
    *,
    rcs: float | None = None,
    ais_matched: bool = False,
    sog_kn: float | None = None,
    gsd_m: float = 20.0,
    top_n: int = 3,
) -> dict[str, Any]:
    """Rank candidate vessel classes for one detection.

    ``gsd_m`` is the ground sample distance the detection came from, and it is
    what turns this from a guess into a bounded one: the length uncertainty is
    roughly ±1 pixel, so a 20 m/px chip cannot distinguish a 140 m hull from a
    160 m one and the output says so.
    """
    length_m = max(float(length_m), 0.0)
    width_m = max(float(width_m), 0.0)
    if length_m <= 0.0 or width_m <= 0.0:
        # A degenerate blob (single pixel, failed shape fit) carries no geometry,
        # so it must claim nothing rather than score whatever the smallest prior
        # happens to be.
        return {
            "candidates": [],
            "confidence": "none",
            "margin": 0.0,
            "lengthBeamRatio": None,
            "lengthUncertaintyM": round(2.0 * gsd_m, 1),
            "limits": "no usable geometry in this detection",
        }
    lb = length_m / width_m if width_m > 0 else 0.0
    # ±1 px on each end of the major axis.
    len_err = 2.0 * gsd_m

    scored: list[dict[str, Any]] = []
    for p in _PRIORS:
        s_len = _band_score(length_m, p.len_min, p.len_max)
        s_beam = _band_score(width_m, p.beam_min, p.beam_max)
        s_lb = _band_score(lb, p.lb_min, p.lb_max) if lb > 0 else 0.5
        # Length is the best-measured quantity, beam the worst (a few pixels
        # across), so weight accordingly. L/B carries the hull-form signal.
        score = 0.40 * s_len + 0.20 * s_beam + 0.40 * s_lb
        why: list[str] = [
            f"length {length_m:.0f} m ±{len_err:.0f} vs {p.len_min:.0f}-{p.len_max:.0f} m",
            f"beam {width_m:.0f} m vs {p.beam_min:.0f}-{p.beam_max:.0f} m",
            f"L/B {lb:.1f} vs {p.lb_min:.1f}-{p.lb_max:.1f} ({p.note})",
        ]
        if p.name in _NAVAL:
            if ais_matched:
                # A MILD penalty, deliberately. Most warships transmit AIS in
                # peacetime, so a harsh one made the module unable to name a
                # combatant that was doing nothing unusual — at 0.45 a 155x20 m
                # destroyer on AIS fell out of the ranking entirely. Being dark is
                # a hint, being lit is barely evidence at all.
                score *= 0.80
                why.append("carries AIS — mild evidence against, warships often do")
            else:
                score *= 1.15
                why.append("no AIS match, consistent with a naval contact")
        if rcs is not None and length_m > 0:
            # RCS per metre of hull separates metal from small/soft returns. This
            # is a WEAK feature — incidence angle and sea state move it as much as
            # the hull does — so it nudges, never decides.
            per_m = rcs / max(length_m, 1.0)
            if per_m < 0.15 and p.name in {"small craft / skiff", "fishing vessel"}:
                score *= 1.10
                why.append(f"low radar return per metre ({per_m:.2f}), small/soft hull")
            elif per_m > 0.6 and p.name in _NAVAL | {"tanker", "bulk carrier"}:
                score *= 1.08
                why.append(f"strong radar return per metre ({per_m:.2f}), large metal hull")
        if sog_kn is not None:
            if sog_kn > 22 and p.name in _NAVAL:
                score *= 1.20
                why.append(f"{sog_kn:.0f} kn exceeds merchant service speed")
            elif sog_kn < 1 and p.name in _NAVAL:
                score *= 0.85
                why.append(f"{sog_kn:.0f} kn — stopped, less consistent with a patrol")
        scored.append({"cls": p.name, "score": round(float(score), 4), "why": why})

    scored.sort(key=lambda d: d["score"], reverse=True)
    top = scored[:top_n]
    best = top[0]["score"] if top else 0.0
    runner = top[1]["score"] if len(top) > 1 else 0.0
    margin = best - runner

    # Confidence is about SEPARATION, not about the top score. Two classes at
    # 0.9 each is an ambiguous answer however high the numbers look.
    if best < 0.35:
        confidence = "none"
    elif margin < 0.05:
        confidence = "low"
    elif margin < 0.15:
        confidence = "medium"
    else:
        confidence = "high"

    # Resolution floor. A blob only two pixels long has not been MEASURED, it has
    # been QUANTISED: at 20 m/px every small contact comes back as 40x20 m
    # whatever it really is, and the L/B of 2.0 that produces is an artefact of
    # the grid, not a hull form. Observed live on the Hormuz AOI, where most
    # detections were exactly 40x20 m and scored "medium" for tug/offshore
    # supply — which the geometry cannot support.
    px_long = length_m / max(gsd_m, 1e-6)
    px_short = width_m / max(gsd_m, 1e-6)
    # Two DIFFERENT effects, and conflating them was wrong: requiring 2 px on the
    # short axis would mark every real warship unresolved, because a destroyer's
    # 20 m beam IS one pixel at 20 m/px.
    unresolved = px_long < 3.0
    beam_unreliable = px_short < 1.5
    if unresolved:
        confidence = "none" if px_long < 2.0 else "low"
        for c in top:
            c["why"].append(
                f"detection is {px_long:.1f}x{px_short:.1f} px — the extent is "
                "quantised by the pixel grid, so hull form is not measured here"
            )
    elif beam_unreliable and confidence == "high":
        # Length is measured, beam is a single pixel, so the L/B that half the
        # score rests on is soft. Rank it, but do not call it high confidence.
        confidence = "medium"
        for c in top:
            c["why"].append(
                f"beam is {px_short:.1f} px — L/B is under-resolved, confidence capped"
            )

    return {
        "candidates": top,
        "confidence": confidence,
        "margin": round(float(margin), 4),
        "lengthBeamRatio": round(lb, 2) if lb else None,
        "lengthUncertaintyM": round(len_err, 1),
        "pixelsLong": round(px_long, 1),
        "resolved": not unresolved,
        "beamResolved": not beam_unreliable,
        # The ceiling, carried in the payload so a consumer cannot render this as
        # an identification.
        "limits": (
            f"geometry-based characterisation from a ~{gsd_m:.0f} m/px detection; "
            "hull class only, never a specific ship, never a hull number"
        ),
    }
