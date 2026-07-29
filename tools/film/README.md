# Launch film pipeline

`launch-4k.mp4` / `launch-1080.mp4` in `website/assets/` are rendered by this,
not edited by hand. Everything is a pure function of film time, so a re-render
is byte-identical apart from live traffic.

    bash tools/film/render-segments.sh          # all four segments -> picture72.mp4
    bash tools/film/render-segments.sh 2 3      # just those segments

- `director.js` — injected into the running console. Camera cuts, the cinema
  stack, and every overlay transform, all keyed off `t`.
- `shoot.js` — steps the director frame by frame at 3840x2160 on the GPU and
  pipes PNGs straight into ffmpeg. Never real-time capture: no dropped frames.
- `render-segments.sh` — one browser per segment (a fresh GPU context), then
  concatenates. Verifies each segment's duration, because a crashed shoot still
  leaves a short, playable file behind.

## The thing that will bite you: VRAM

A 4K shoot needs ~25 GB of the 32 GB card. The local LLM stack (`llama-server`
via the model manager, plus the `ollama` service) holds 20-28 GB whenever a
model is warm, and the backend re-warms on demand — so the shoot dies partway
with a Cesium `DeveloperError: Expected width to be greater than 0`, which
reads like a layout bug and is not one.

`render-segments.sh` reaps model servers and aborts if under 20 GB is free.
If `ollama` reloads mid-render (its own service, on demand):

    ollama stop <model>                       # see: ollama ps
    chmod -x data/bin/llama-b9964/llama-server   # blocks respawn; restore after

Requires the API on :8000 and Vite on :5173. AI routes are stubbed inside the
shoot so loading the console cannot trigger a model load.

Music: “Rising Dawn” by Ethereal88, CC BY 4.0 — credit required wherever the
film ships with audio. `score52.m4a` is 2.5s-54.5s of the source: the opening
2.5s sits at -34 dB, which is under the title card, not under the cuts. A
midtempo alternative was tried and rejected on listening.

## Pacing

20 shots in 52s, ~2.4s average. An earlier 72s cut ran ~9s per shot and read as
a product tour, not a launch film: the reference cuts every 2-3s. Shot bounds
live in `CUT` in director.js, headline timings in `LOWER`; both are film-time
keyed, so retiming is editing two tables and re-rendering.
