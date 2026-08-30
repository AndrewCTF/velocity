# The honesty wave — measured before and after (2026-08-30)

Phases 1-4, 16 and 20 of `Answer God's Eye View`. Ground truth for Phase 1 is in
`docs/phase1-ground-truth-2026-08-30.md`; this file records what the fixes
changed, with the commands and their output, so no claim here rests on memory.

Branch `osint-book-intel-2026-08`. Baseline 2559 -> **2578 passed + 2 skipped**.
`bash scripts/verify.sh` ALL GREEN; `bash scripts/verify.sh --live` ALL GREEN
against a backend running this code.

## The four claims the code made and did not keep

| # | Claim in the code | Reality before | Now |
|---|---|---|---|
| 1 | `ai_selection.py`: "a bracket form we can verify against the real ids below" | No verification below. `llm.is_grounded` had zero callers repo-wide | Called. A brief citing an id that was not in the evidence is withheld, naming the id |
| 2 | `timeline.py` docstring: `gaps` is "a placeholder" | Served as `[0] * bins` unconditionally — an absent measurement indistinguishable from a measured zero | `null` + `gaps_status: "unmeasured"` |
| 3 | "An unaudited action must not silently succeed" | True, but `/api/audit` 503'd without Supabase while governed actions wrote to a local DB no route could read | Keyless deployments read their own log |
| 4 | README: "every contact carries which independent sources reported it" | 94% of contacts carried no `sources` at all | 100% attributed |

## Provenance, the numbers

The sidecar-only fast path (`ADSB_SIDECAR_ONLY=1`, the default on a box with a
healthy tar1090 sidecar) returned before `_stamp_sources` ever ran.

Before — `curl -s localhost:8000/api/status/provenance`:

    total 8562 | attributed 539 | unattributed 8023 | corroborated 14 | 2.6%
    tiers: opensky 539 (525 exclusive), feeds 14 (0 exclusive)

and directly off the snapshot: 8,588 features, 507 with `sources` (all
`['opensky']`), 8,081 tagged `source=adsb` carrying none.

After:

    total 8273 | attributed 8273 | unattributed 0 | corroborated 0 | 0.0%
    tiers: feeds 8273 (8273 exclusive)

and off the snapshot, 8,286 of 8,286 with `sources`, `source_count` all 1, and
`confidence` populated for the first time on this deployment: **8,031 medium,
255 low**, per the published rule (one source + a fix under two minutes is
medium; one source + an older fix is low).

`corroborated_pct` is still 0.0. That is now a true sentence rather than a hole:
this box runs one ADS-B tier, so nothing is corroborated, and the endpoint says
so. The fix deliberately does not manufacture agreement out of a single
observer — `test_adsb_sidecar_provenance.py` pins that every contact reads
`source_count == 1` rather than being talked up.

An operator who wants real corroboration turns off `ADSB_SIDECAR_ONLY` and takes
the multi-tier union; the number will then move, and it will mean something.

## Live gate, after

    bash scripts/verify.sh --live
    aircraft: 8981 -> 9011 features; 85% of 8981 common ids refreshed seen_pos_s over 8s
    adsb: OK
    vessels: 34421 (20000 parked)
    :8090 alive
    :8093 alive
    verify: ALL GREEN

## Every guard was proved to bite

A guard that has never failed is not a guard. Each was run against the code as
it stood before its fix:

| Guard | Reverted target | Result |
|---|---|---|
| `test_readme_claims.py` | each of the four numbers drifted in turn | 1 failed, 2 passed — each time the right one |
| `test_selection_grounding.py` | `unknown_citations` neutered to `[]` | 2 failed (both withhold cases), 6 passed |
| `test_audit_keyless.py` | route restored from `HEAD` | 4 failed |
| `test_adsb_sidecar_provenance.py` | `adsb.py` restored from `HEAD` | 2 failed |

And after the provenance change, the union's own invariants were re-run
together — `test_adsb_no_reverse`, `test_adsb_cached_age`, `test_adsb_hot_blob`,
`test_adsb_viewport_stable`, `test_invariants`, `test_provenance` — 58 passed,
1 skipped (the opt-in live probe).

## Still open

Twenty of the plan's twenty-six phases. The largest are the container that
cannot run its own sidecars (Phase 8), archive contiguity (Phase 11), the
replay window as a citable artifact (Phase 14, the flagship), and photo
geolocation's missing surface (Phase 19).
