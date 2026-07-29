# Resource budget — before / after, 2026-07-29

Every number here was produced by the harnesses that already exist
(`tools/perf/measure_sidecars.sh`, `measure_api.py`, `nvidia-smi -q -d PIDS`) on
this box: 32 cores, 121 GB RAM, RTX 5090 (32 607 MiB).

The "before" column is `docs/perf-baseline-2026-07-27.md` and the corrected
Phase-1 table in `docs/perf-results-2026-07-27.md`. Where a comparison is not
like-for-like, it says so in the row rather than in a footnote.

---

## 1. VRAM — the headline, and the misattribution behind it

The operator's report was "it uses about twenty five GB of vRAM". The number was
real. The subsystem it was recorded against was not.

`docs/perf-baseline-2026-07-27.md` put "23.3 GB of the 5090's VRAM" in the
section about the browser sidecars. Nobody had run `nvidia-smi -q -d PIDS`.
Per process, with both feeder tiers warm and the backend at 18 158 aircraft /
33 340 vessels:

```
| PID     Type  Process                                   GPU Memory |
|  8426     G   /usr/bin/gnome-shell                          324MiB |
| 15933     G   .../discord/app-1.0.150/Discord               173MiB |
| 20790     G   .../usr/lib/firefox/firefox                   290MiB |
|  …desktop applications only…                                       |
```

**25 Chromium scraper processes, 4 770 MB RSS, one renderer at 433 % CPU — and
0 MiB of VRAM between them.** The card total was 1 228 MiB, all of it desktop
software. The planned `--disable-gpu` change to the four feeders was therefore
dropped: it had no effect to buy.

Running the app instead showed where it was:

| holder | VRAM | what it is |
|---|---|---|
| `ollama` runner | 21 440 MiB | `qwen3-coder:30b-a3b-q4_K_M`, `size_vram` 22 027 810 944 B |
| `llama-server` | 2 969 MiB | `Llama-3.2-3B-Instruct-Q4_K_M` |
| `llama-server` | 3 197 MiB | `gemma-3-4b-it-Q4_K_M` |
| **total** | **27 606 MiB of 28 822** | **96 % is the model stack** |

### What changed

| | before | after |
|---|---|---|
| llama.cpp router at boot | spawned unconditionally, `--models-max 2 -ngl -1` | **not spawned** unless something wants local inference |
| VRAM held by that router | 6 166 MiB | **0 MiB** |
| ollama residency after one call | 5 min (ollama's default) | **60 s** (`OLLAMA_KEEP_ALIVE`), `0` in `lite` |
| VRAM on a `lite` boot | — | **~246 MiB** above an idle desktop |

Proven live, three ways:

```
killing the API      28 822 -> 22 640 MiB     (exactly the router's 6 182)
rebooting with the fix   :8094 unbound, 1 156 MiB, no llama/ollama/chrome on the card
lite boot                1 305 MiB total against a 1 059 MiB idle desktop
```

`keep_alive` proven through our own code path rather than ollama's API:

```
llm._ollama_chat(...) -> backend ollama, qwen3-coder:30b-a3b-q4_K_M
/api/ps  expires_at 19:39:46   (call was 19:38:46)
```

A 60-second window where the default would have been five minutes.

### The honest remainder

`keep_alive` bounds **one** call. It does not stop a loop that calls
repeatedly: the watch-officer brief loop kept re-arming it (`expires_at`
advanced to 19:40:59) while `/api/ai/local` reported `enabled: false`. That is
the same "configured off, still resident" shape as the router, one layer up, and
it is what `AI_BACKGROUND_ENABLED=0` in the `lite` profile exists for. On `full`
the loop still runs and still holds the model — by request, not by accident.

---

## 2. Sidecar CPU and RSS

The feeders read `g.planesOrdered`, tar1090's *parsed* store, and never a pixel.
An A/B on one source, same box, same 4-minute window:

| | CPU | RSS | `/health` total over 28 cycles |
|---|---|---|---|
| drawing (control) | **179.8 %** | 1 907 MB | 11 008 → 11 338 |
| layers hidden | **29.2 %** | 1 904 MB | 11 029 → 11 333 |

**84 % less CPU, and the store tracks the control to within 0.04 %.**

`OLMap.setTarget(null)` was tried first and **rejected**: it cuts the same CPU
but freezes the store, because a CDP capture shows tar1090 fetching
`/re-api/?binCraft&zstd&box=<s>,<n>,<w>,<e>` from the map's view extent, and
detaching removes the size that extent derives from. It froze at exactly 14 209
across 28 cycles while `/health` reported `rev: 28`, `age_s: 1` — healthy-looking
and dead. Hiding layers leaves the view, size and extent intact.

### Whole tier, both feeds live (`measure_api.py`, 90 s @ 2 s)

| Metric | 2026-07-27 baseline | 2026-07-27 after | **2026-07-29** |
|---|---|---|---|
| `cpu%:chrome` p50 | 393.6 % | 828.8 % | **113.2 %** |
| `cpu%:chrome` max | 1 522.6 % | — | **199.3 %** |
| `rss_mb:chrome` p50 | 8 881 MB | 4 050 MB | **4 426 MB** |
| chrome processes | 53 | 22 | 25 |
| `rss_mb:api` | 578 MB | 2 283 MB | **620 MB** |
| aircraft carried | 11 770 | 16 859 | 13 369 |

**The load is not equal and the comparison must not pretend otherwise.** This
run carried 13 369 aircraft against 16 859. Per unit of data:
**49 %/k before against 8.5 %/k after — a 5.8× improvement**, not the 7.3× the
headline row implies. Stated because a before/after taken at different loads is
the exact error this repo already retracted once (`docs/decisions.md`, 2026-07-27).

`rss_mb:api` falling from 2 283 MB to 620 MB is real but also not like-for-like:
the 2 283 MB reading was a long-lived process after many measurement cycles and
was flagged "unexplained" at the time. 620 MB against the original 578 MB
baseline is the fairer read — roughly flat.

### Per-request sidecar cost (`measure_sidecars.sh`)

| endpoint | 2026-07-27 baseline | 2026-07-29 |
|---|---|---|
| `:8090/aircraft.json` p50 | 8.2 ms | **0.3 ms** |
| `:8090/health` p50 | 1.3 ms | **0.2 ms** |
| `:8093/vessels.json` p50 | 5.2 ms | **1.2 ms** |
| `:8093/health` p50 | 0.3 ms | **0.2 ms** |

---

## 3. The `lite` profile — the actual edge budget

Measured under the agreed edge target, emulated with a cgroup:

```
systemd-run --user --scope -p CPUQuota=400% -p MemoryMax=8G \
  env OSINT_PROFILE=lite HISTORY_ROOTS=/tmp/osint-roots/disk-a,/tmp/osint-roots/disk-b \
  bash scripts/run-api.sh
```

| Metric | budget | measured | |
|---|---|---|---|
| API RSS | < 1 500 MB | **528.6 MB** p50 | ✅ |
| API CPU (idle-ish) | < 60 % of one core | **10.0 %** p50 (max 71.9) | ✅ |
| VRAM held | < 1 000 MiB | **~246 MiB** | ✅ |
| Chromium processes | 0 | **0** | ✅ |
| process count | — | **1** | |
| aircraft | ≥ 8 000 floor | **11 770** | ✅ |
| vessels | — | **34 086** | |
| loop lag p50 | — | 96 ms | |
| `/api/status` | operational | **operational** | ✅ |

Aircraft breadth here is OpenSky alone, with no browser tier at all — which is
the documented breadth source, so `lite` degrades coverage rather than losing it.

---

## What this does NOT claim

- **Sidecar RSS is essentially unchanged** (4 050 → 4 426 MB at a different
  load). The render fix cut CPU, not memory. Chromium's floor for three
  contexts is what it is; the answer for a small box is `lite`, which does not
  run them at all.
- **`full` still holds a model.** `AI_BACKGROUND_ENABLED` defaults on there, so
  the watch-officer loop still pulls whatever the local ladder resolves to.
- **The 5.8× CPU figure is per unit of data**, not a raw before/after.

## Reproducing

```bash
bash scripts/run-api.sh                       # or with OSINT_PROFILE=lite
bash tools/perf/measure_sidecars.sh
python3 tools/perf/measure_api.py --seconds 90 --interval 2.0
nvidia-smi -q -d PIDS
```
