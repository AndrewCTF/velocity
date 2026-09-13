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

## Phase 6 — the AI label reaches the panels

`case_export.py` has enforced an AI-DRAFTED marker on the evidentiary path since
the locker shipped. None of the three panels rendering model output carried one:
the entity panel's AI assessment, the watch officer's elaborated brief, the
country brief. The document is read once by someone who knows it is a draft; the
panel is read all day by someone triaging.

One `<AiLabel />` sharing the export's exact wording, with
`test_ai_label_parity.py` failing if the two copies drift. `IntelPanel` is
deliberately excluded and the test pins that too — its narrative comes from
`intel/incidents.py`, whose header says "Nothing is invented", and a label that
appears on deterministic text is a label people stop seeing. The separator moved
from an em dash to " · " on both sides, because the string is dashboard copy now
and `apps/web/CLAUDE.md` holds dashboard copy to no em dashes.

## Phase 14 — a replay window becomes a citable artifact

The flagship. `POST /api/evidence/capture/replay-window` freezes what changed
inside a box between two moments of the owned archive: SHA-256 over canonical
JSON, attachable to a case, re-verifiable by someone who does not trust us. The
diff is computed server-side and the request model has no field for one — a
notary for whatever the caller typed is not evidence.

Proved live against a 44.5M-row archive (North Sea, 45N-60N, one hour):

    /api/history/diff  ->  arrived 45, departed 66, stayed 979
    capture            ->  sha256 ac3ae6a7f504…
                           "Replay window: 45 arrived, 66 departed, 979 stayed"
                           truncated: {arrived: false, departed: false, stayed: false}
    verify             ->  {"ok": true}

**That live run caught a defect in the first version of this code**, which is the
argument for running it. The exhibit said `stayed: 500` where 979 did: counts
were measured with `len()` over `window_diff`'s id arrays, which are capped at
`limit`, while the diff's own `counts` stay honest. An exhibit that silently
truncates is worse than no exhibit — it is wrong in a way that looks precise.
Counts now come off the diff, the capture asks for the route ceiling rather than
the 500 default, and a per-lane `truncated` map records whether the stored list
is shorter than the count it reports.

`routeCoverage.test.ts` is what required the new route to have a UI address at
all; the control lives in the evidence panel. The map gesture the plan wants —
draw a box, pick two moments, see arrived/departed on the globe — is still to
come.

## Still open

Eighteen of the plan's twenty-six phases. The largest are the container that
cannot run its own sidecars (Phase 8), archive contiguity (Phase 11), photo
geolocation's missing surface (Phase 19), and Phase 14's map gesture.
