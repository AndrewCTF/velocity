# Local-inference pool sweep, 2026-08-05

Engine `ollama`, declared slots 1 (from `OLLAMA_NUM_PARALLEL`). 12 documents per run, structured extraction, identical items at every width.

| width | wall s | docs/s | vs width 1 | p50 s | p95 s | parsed |
|---|---|---|---|---|---|---|
| 1 | 31.968 | 0.375 | 1.00x | 2.65 | 2.967 | 12/12 |
| 2 | 7.549 | 1.59 | 4.24x | 1.736 | 2.27 | 12/12 |
| 4 | 6.129 | 1.958 | 5.22x | 2.551 | 2.621 | 12/12 |
| 8 | 4.302 | 2.789 | 7.44x | 2.433 | 3.286 | 12/12 |

Median p50 across widths: 2.49 s.

Run with `apps/api/.venv/bin/python tools/perf/llm_pool_sweep.py --widths 1,2,4,8
--n 12 --write`. The harness pins the run to the local engine and restores the
toggle afterwards; the first run of it did not, and measured a cloud backend at a
concurrency limit that has nothing to do with this box.

## What it changed

The pool's Ollama width fell back to **1** when `OLLAMA_NUM_PARALLEL` is unset,
on the reasoning that an unset variable should not be assumed away. The sweep
says that reasoning was wrong: the declared slot count was 1 and width 8 still
finished the same 12 documents in 4.3 s against 32.0 s, a **7.4x** speedup with
zero failures and 12/12 parsed at every width. Ollama auto-sizes its own
parallelism, so the fallback is now 4, which is Ollama's documented default.

Two things worth reading off the table rather than assuming:

- The gain is not linear and never was. 1 → 2 buys 4.2x, and everything from
  there to 8 buys another 1.8x. The first slot is doing most of the work.
- p50 barely moves (2.65 s → 2.43 s) while p95 climbs (2.97 s → 3.29 s). That is
  what saturation looks like from the outside: individual documents do not get
  faster, more of them are simply in flight, and the tail is where the cost is
  paid. A width chosen past the knee trades p95 for throughput, which is the
  right trade for a batch job and the wrong one for anything interactive.

Not measured here: llama.cpp. The sidecar was not enable-able on this box during
the run (no installed GGUF), so `llamacpp_parallel` remains an unmeasured
default and this table says nothing about it.
