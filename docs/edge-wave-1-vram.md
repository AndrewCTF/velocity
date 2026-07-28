# Edge wave 1 — where the VRAM actually was

The plan for this wave was "take the GPU away from the browser scrapers". The
first step was to attribute the 23.3 GB the 2026-07-27 baseline recorded, because
it had never been split per process. **The attribution killed the plan**, and the
real cause turned out to be somewhere nobody had looked.

Recording the dead hypothesis first, because the wave existed to test it.

## The hypothesis, and why it was reasonable

`docs/perf-baseline-2026-07-27.md` says the browser tier "burns 4-15 CPU cores
continuously and holds ~8.9 GB of RAM (plus 23.3 GB of the 5090's VRAM, per
`nvidia-smi` during the run) to deliver two JSON files."

And no feeder passes `--disable-gpu` — verified across all four
(`tools/adsb-globe-feeder/index.js:112-147`,
`tools/ais-myshiptracking-feeder/index.js:128-158`, and the two minimal ones).
Modern headless Chrome is real Chrome. Four rendered map tabs nobody looks at,
no GPU-off flag, 23.3 GB unaccounted: the inference was obvious.

It was also wrong.

## The measurement

Backend booted with `bash scripts/run-api.sh`, both sidecars warm
(`:8090` `total: 18907` across three sources, `:8093` `total: 23359`,
`/api/status` `operational` at 18 158 aircraft / 33 340 vessels).

```
$ pgrep -c -x chrome
25
$ ps -o rss= -C chrome | awk '{s+=$1} END {print s/1024}'
4770.33          # MB, and one renderer at 433% CPU

$ nvidia-smi --query-gpu=memory.used --format=csv,noheader
1228 MiB
```

Per-process, every graphics context on the card:

```
|  PID    Type  Process name                        GPU Memory |
|  8426     G   /usr/bin/gnome-shell                    324MiB |
|  8820     G   /bin/warp-taskbar                        17MiB |
|  8938     G   /usr/bin/Xwayland                         8MiB |
| 13419   C+G   /usr/bin/gnome-control-center            30MiB |
| 15933     G   ...discord/app-1.0.150/Discord          173MiB |
| 20790     G   .../usr/lib/firefox/firefox             290MiB |
| 23177   C+G   /usr/bin/resources                       36MiB |
| 74027   C+G   /usr/bin/ptyxis                          68MiB |
|103883     G   ...bin/firmware-updater                  63MiB |
```

**Twenty-five Chromium processes holding 4.8 GB of RAM and burning 433 % on one
renderer, and not one of them appears on the GPU at all.** The whole card is
desktop applications. `--disable-gpu` on the feeders would have bought exactly
nothing, and shipping it would have been a change with a story and no effect.

## Where the 23 GB actually is

Running the app itself and re-reading the card:

```
| 128838     C   /usr/local/bin/ollama                 21440MiB |
| 129853   C+G   .../llama-b9964/llama-server           2969MiB |
| 129915   C+G   .../llama-b9964/llama-server           3197MiB |
```

**27 606 MiB of 28 822 — 96 % of the VRAM — is the local model stack.**

| holder | VRAM | what |
|---|---|---|
| `ollama` runner | 21 440 MiB | `qwen3-coder:30b-a3b-q4_K_M`, `size_vram` 22 027 810 944 B, on ollama's own keep-alive |
| `llama-server` | 2 969 MiB | `data/models/64a1fac552dc/Llama-3.2-3B-Instruct-Q4_K_M.gguf` |
| `llama-server` | 3 197 MiB | `data/models/db6d01f62d0f/gemma-3-4b-it-Q4_K_M.gguf` |
| chrome sidecars | **0 MiB** | 25 processes, 4.8 GB RSS |

The operator's report — "it uses about twenty five GB of vRAM" — is correct in
magnitude and was attributed to the wrong subsystem by everyone, including the
baseline document that first recorded the number.

## The defect: "configured off" did not mean "not resident"

The two `llama-server` processes are children of PID 127207, which is ours:

```
127207  data/bin/llama-b9964/llama-server --models-dir data/models --models-max 2
        --host 127.0.0.1 --port 8094 --flash-attn auto -ngl -1 ...
```

That is the router `app/llamacpp_sidecar.start()` spawns in the lifespan
(`main.py:248`). `--models-max 2` with `-ngl -1` means *keep two models resident,
all layers on the GPU*, and llama.cpp fills the slots from the models directory
on its own.

Meanwhile every switch said the feature was off:

```
/api/ai/local     enabled: false   selection_enabled: false   selection_model: null
.manager_state.json   {"active": {"main": null, "selection": null}, "hot": []}
```

The gate is `is_enabled()` (`llamacpp_sidecar.py:89`), and it asked three
questions — is the engine `auto`/`llamacpp`, does a binary resolve, is any model
installed — and never the fourth: **does anyone actually want local inference.**
So on any box where a model had ever been downloaded, every boot committed
6.2 GB of VRAM to a disabled feature.

## The fix

`is_enabled()` gains a fourth clause, `_wanted()`: the operator switch is on
(`llm.prefer_local()` or `llm.selection_enabled()`), **or** a model has been
given a role (`manager.get_active()`), **or** one is pinned hot
(`manager.get_hot()`). `app.llm` is imported lazily inside it — it is a large
module and this runs during lifespan, where an import cycle is a boot failure.

Because the router no longer comes up at boot, three routes now start it on
demand, all idempotent:

- `POST /api/ai/local` (`routes/ai.py`) — turning local inference on
- `POST /api/ai/models/active` (`routes/ai_models.py`) — giving a model a role
- `POST /api/ai/models/hot` (`routes/ai_models.py`) — pinning one resident

## Proven live

Killing the API dropped the card by exactly the router's share:

```
before kill   28 822 MiB
after kill    22 640 MiB      (= -6 182, the two llama-server children)
```

Rebooting with the fix, both feeders running, ADS-B at 19 050 aircraft:

```
$ ss -ltn | grep 8094   →  not bound          # the router never spawned
$ nvidia-smi --query-gpu=memory.used --format=csv,noheader
1156 MiB
$ nvidia-smi | grep -E "llama|ollama|chrome"
(no matches)
```

**VRAM held by Velocity: 6 166 MiB → 0 MiB.** The remaining 1 156 MiB is
gnome-shell, Firefox, Discord and the terminal.

### Two honest qualifications

1. **The ollama 21 440 MiB is not claimed as fixed by this change.** `ollama
   serve` is a system service; its runner started during our boot window and its
   model carries an `expires_at` (its own keep-alive), so it released the memory
   on its own. What this change does establish is that a default boot no longer
   *triggers* it: after the fix, with the router gated off, no ollama runner
   appeared at all. Whether some code path still calls ollama when local
   inference is off is the next thing to attribute, and it is not attributed yet.
2. **This is a VRAM "after", not a CPU one.** During the after-run the AIS tier
   was serving `{"total":0,"cells_ok":0,"cells_total":0}` — MyShipTracking was
   refusing us. A CPU comparison taken with one tier dead is exactly the mistake
   `docs/decisions.md` (2026-07-27) records and retracts, so no CPU claim is made
   here. VRAM is unaffected by which feeds are live, and both readings had the
   ADS-B tier at ~19 000 aircraft.

## What is still true and unfixed

**Chrome RSS is 4 457 MB across 24 processes, and CPU still peaks over 400 % on a
single renderer.** That is the operator's RAM/CPU complaint and this wave does not
touch it. The structural idea from the plan — stop rendering three world maps to
read three JavaScript arrays — is unchanged and still worth doing:
`readFn` (`index.js:77-99`) reads `g.planesOrdered`, tar1090's *parsed* store, so
the raster and composite work is pure waste. The AIS feeder already shows the
pattern (`ais-myshiptracking-feeder/index.js:173-180`: `goto` once for cookies,
then `page.evaluate(fetch)` against the site's own JSON). Carried forward.

## Guards

`tests/test_llamacpp_sidecar.py` — four new tests, and one pair deliberately
replaced. The old `test_is_enabled_true_engine_auto_with_binary_and_model` and
its `llamacpp` sibling asserted that a binary plus an installed model was
sufficient; that was the contract, and the contract was the bug. They now opt in
via `_want()`, and the new tests pin the actual rule:

- `test_is_enabled_false_when_nothing_wants_local_inference`
- `test_is_enabled_true_when_a_model_is_given_a_role`
- `test_is_enabled_true_when_a_model_is_pinned_hot`
- `test_is_enabled_true_when_selection_inference_is_on`

`2010 passed, 2 skipped` (from 2006), ruff clean.

## The lesson worth keeping

The wave's own first step — "attribute before changing anything" — is the only
reason a plausible, well-argued, entirely ineffective change did not ship. The
baseline recorded a real number next to the wrong subsystem, and every document
downstream repeated the attribution. `nvidia-smi -q -d PIDS` would have taken
thirty seconds at any point in the last two days.
