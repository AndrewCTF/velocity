# Edge wave 7 — make verification fast enough to actually run

Part of the edge-deployability wave (`docs/edge-plan-2026-07-28.md`). This one
goes first because a two-minute serial test run taxes every change after it.

## The measurement

Same box (32 cores), same branch, same command shape, back to back.

```
$ /usr/bin/time -f "SERIAL_WALL=%e s" env OSINT_DISABLE_BACKGROUND=1 \
    apps/api/.venv/bin/pytest apps/api -q
2006 passed, 2 skipped in 118.93s (0:01:58)
SERIAL_WALL=124.39 s

$ /usr/bin/time -f "PARALLEL_WALL=%e s" env OSINT_DISABLE_BACKGROUND=1 \
    apps/api/.venv/bin/pytest apps/api -q -n auto --dist loadfile
2006 passed, 2 skipped in 30.07s
PARALLEL_WALL=31.74 s
```

| | serial | parallel | change |
|---|---|---|---|
| pytest-reported | 118.93 s | **30.07 s** | **-75 %** |
| wall clock | 124.39 s | **31.74 s** | **-74 %** |
| result | 2006 passed + 2 skipped | 2006 passed + 2 skipped | identical |

**4.0× faster, same result set.** The bare command is now parallel too — the
flags live in `addopts`, so `verify.sh`, CI and a plain `pytest apps/api -q` all
get it without changing a script:

```
$ env OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q
2006 passed, 2 skipped in 29.84s
```

## A correction to the recorded baseline

`CLAUDE.md` carried **1985 + 2 skipped**, measured 2026-07-27. The suite actually
reports **2006 + 2 skipped** on this branch — three commits landed after that
number was written (`bd6e65b`, `7d3ef54`, `3e3a6e1`). The floor for everything
after this is 2006, not 1985. Recorded rather than silently corrected, because a
baseline that drifts without anyone noticing is a baseline that stops catching
regressions.

## Why `--dist loadfile` and not `load`

`load` is faster and would be wrong here. There is exactly one project conftest
(`apps/api/tests/conftest.py`) and its isolation fixtures are clean — every
`_isolate_*` fixture is `tmp_path`-based and resets on `yield`
(`conftest.py:75-146`). Three other things are not:

| state | where | why it breaks under `load` |
|---|---|---|
| `ais_sidecar._stale_since`, `._restarts` | `test_ais_sidecar_reuse.py:137,157,167,198-199` | cleared with `.clear()`, not `monkeypatch` — not auto-reverted |
| `adsb_sidecar._proc`, `._reuse_pid` | `test_adsb_sidecar_supervise.py:163-167` | assigned directly, not `monkeypatch` |
| `_TEST_TILE_DIR` | `conftest.py:34` | one module-level `mkdtemp` shared by every test in the process, deliberately (`conftest.py:31-33`) so the tile tests can assert on a warm disk cache |

All three depend on tests from the same file running in declaration order in one
process. `--dist loadfile` guarantees exactly that: one file, one worker. So the
ordering guarantee the suite already relies on is preserved, and parallelism is
free.

What is **not** a risk, checked rather than assumed: there are no real port binds
and no real subprocess spawns in the suite. Every `create_subprocess_exec` in
`apps/api/tests` is behind `monkeypatch.setattr(..., fake_exec)`, and the only
fixed-port references are inside mocked contexts or behind the
`OSINT_LIVE_PROBE=1` skip. Workers cannot collide on `:8000` or `:8090-8093`.

**The follow-up, named so it is not mistaken for done:** fix those three globals
with autouse resets, then measure `--dist load` against `loadfile`. Correct under
`loadfile` first, measure, then loosen — not the other way round.

## Harness output is now gradable

`tools/perf/measure_ui.mjs` gained `--out <path>`, writing the same numbers as
JSON alongside the unchanged Markdown on stdout:

```json
{
  "profile": "all-toggles",
  "series": { "rendersPerSec": { "p05": …, "p50": …, "p95": …, "max": … }, … },
  "worstWindow": { "startSample": …, "frameMsMean": …, "frameMsMax": …, "fpsMin": … },
  "requests": { "perMin": …, "by": { … } },
  "pass": false
}
```

`worstWindow` is new and exists for a specific reason: samples land at ~1 Hz, and
a p50 that looks acceptable while one five-second stretch locks the interface is
exactly the experience being reported. The harness now reports the **worst**
five-sample window rather than the average of them.

The other three harnesses (`measure_api.py`, `measure_sidecars.sh`,
`measure_llm.py`) did **not** get `--out`, and that is a decision rather than an
omission: they emit Markdown that `tee` files perfectly well, and nothing grades
them by machine. `measure_ui.mjs` is the one whose numbers a success criterion
turns on.

## Files changed

- `apps/api/pyproject.toml` — `pytest-xdist>=3.8.0` in `dev`; `addopts = "-n auto --dist loadfile"` with the reasoning above as a comment.
- `tools/perf/measure_ui.mjs` — `--out`, the `worstWindow` helper.
- `CLAUDE.md` — baseline 1985 → 2006, wall time and the `-n0` escape recorded.
- `docs/decisions.md` — the displaced 1985 line filed under baseline history.
