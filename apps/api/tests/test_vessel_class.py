"""Hull-class characterisation from low-resolution geometry.

The operator's ask was "how do they know what warship it is, and can we do that
without high-resolution data". These tests pin BOTH halves of the answer: the
geometry really does discriminate hull class, and the module must never express
certainty it has not earned.
"""

from __future__ import annotations

from app.intel.vessel_class import characterise


def _top(**kw) -> str:
    return characterise(**kw)["candidates"][0]["cls"]


# ── it discriminates, on real published hull dimensions ──────────────────────


def test_a_destroyer_reads_as_a_combatant_not_a_freighter() -> None:
    """Arleigh Burke: 155 x 20 m. A coastal freighter can be 155 m too — the
    length/beam ratio (7.8 vs ~6) is what separates them, which is exactly the
    feature a 20 m/px chip can still measure."""
    r = characterise(155, 20, ais_matched=False, sog_kn=28)
    assert r["candidates"][0]["cls"] == "frigate / destroyer"
    # NOT "high": at 20 m/px a 20 m beam is a single pixel, so the L/B that half
    # the score rests on is under-resolved and the module caps itself. The useful
    # part -- it ranks a combatant first, not a freighter -- still holds.
    assert r["confidence"] == "medium"
    assert r["beamResolved"] is False


def test_a_carrier_is_not_confused_with_a_tanker_despite_similar_length() -> None:
    """Nimitz 333 x 77 against a VLCC 333 x 60 — same length, and the beam plus
    the very low L/B is the whole signal."""
    assert _top(length_m=333, width_m=77, ais_matched=False) == "aircraft carrier / LHA"


def test_a_trawler_reads_as_fishing_not_as_a_warship() -> None:
    assert _top(length_m=38, width_m=8, ais_matched=False, sog_kn=4) == "fishing vessel"


def test_a_container_ship_reads_as_merchant() -> None:
    assert _top(length_m=294, width_m=32, ais_matched=True, sog_kn=18) in {
        "general cargo / container",
        "bulk carrier",
    }


# ── it refuses to overclaim ──────────────────────────────────────────────────


def test_an_ambiguous_hull_reports_low_confidence_rather_than_picking() -> None:
    """A 333 x 60 hull fits a tanker AND a big container ship — L/B 5.6 for
    both. The right output is a close ranking and low confidence, not a winner."""
    r = characterise(333, 60, ais_matched=True)
    assert r["confidence"] in {"low", "none"}
    assert r["margin"] < 0.15


def test_it_never_returns_a_single_answer() -> None:
    r = characterise(155, 20)
    assert len(r["candidates"]) > 1, "a ranked set, never one verdict"


def test_every_candidate_carries_its_evidence() -> None:
    """An analyst has to be able to disagree with the REASONING, not just the
    conclusion — that is the citation contract in palantir-reference §11.23."""
    for c in characterise(155, 20)["candidates"]:
        assert c["why"], c
        assert any("L/B" in w for w in c["why"])


def test_the_resolution_ceiling_is_carried_in_the_payload() -> None:
    """A consumer must not be able to render this as an identification."""
    r = characterise(155, 20, gsd_m=20.0)
    assert "never a specific ship" in r["limits"]
    assert r["lengthUncertaintyM"] == 40.0  # +-1 px each end at 20 m/px


def test_uncertainty_scales_with_the_source_resolution() -> None:
    coarse = characterise(155, 20, gsd_m=20.0)["lengthUncertaintyM"]
    fine = characterise(155, 20, gsd_m=0.3)["lengthUncertaintyM"]
    assert fine < coarse, "a 0.3 m/px Wayback chip must claim tighter bounds"


# ── behavioural fusion nudges, never decides ─────────────────────────────────


def test_ais_presence_weakens_a_naval_reading_without_forbidding_it() -> None:
    """Warships do run AIS. Carrying it must lower the naval score, not zero it."""
    dark = characterise(155, 20, ais_matched=False)["candidates"][0]["score"]
    lit = next(
        c["score"]
        for c in characterise(155, 20, ais_matched=True)["candidates"]
        if c["cls"] == "frigate / destroyer"
    )
    assert 0 < lit < dark


def test_speed_above_merchant_service_speed_supports_a_naval_reading() -> None:
    slow = next(
        c["score"]
        for c in characterise(155, 20, sog_kn=0)["candidates"]
        if c["cls"] == "frigate / destroyer"
    )
    fast = next(
        c["score"]
        for c in characterise(155, 20, sog_kn=30)["candidates"]
        if c["cls"] == "frigate / destroyer"
    )
    assert fast > slow


def test_a_degenerate_detection_does_not_crash_or_claim_anything() -> None:
    r = characterise(0, 0)
    assert r["confidence"] in {"none", "low"}
    assert r["lengthBeamRatio"] is None


# ── the resolution floor ─────────────────────────────────────────────────────


def test_a_two_pixel_blob_is_quantised_not_measured() -> None:
    """Observed live on the Hormuz AOI: at 20 m/px nearly every small contact
    came back as exactly 40 x 20 m, and the L/B of 2.0 that produces is an
    artefact of the pixel grid, not a hull form. The module scored those
    "medium" for tug/offshore supply, which the geometry cannot support."""
    r = characterise(40, 20, gsd_m=20.0)
    assert r["resolved"] is False
    assert r["confidence"] in {"none", "low"}
    assert any("quantised" in w for w in r["candidates"][0]["why"])


def test_the_same_hull_at_a_finer_gsd_is_resolved() -> None:
    """A 40 x 20 m hull in a 0.3 m/px keyless Wayback chip is 133 px long — the
    same object, genuinely measured."""
    r = characterise(40, 20, gsd_m=0.3)
    assert r["resolved"] is True
    assert r["pixelsLong"] > 100


def test_a_large_hull_at_coarse_gsd_is_still_resolved() -> None:
    """155 m at 20 m/px is ~8 px long — coarse, but a real measurement."""
    r = characterise(155, 20, gsd_m=20.0)
    assert r["resolved"] is True
