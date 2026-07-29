#!/bin/bash
# One browser per segment: a fresh GPU context each time, so a 4K shoot cannot
# accumulate its way into a lost context halfway through the film.
# Usage: render-segments.sh [segment indices...]   (default: all four)
#
# Before running: free the GPU. The local llama-server models hold ~20 GB and a
# 4K Cesium render needs ~25 GB of the 32 GB card.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export NODE_PATH=/home/andrew/Projects/OSINT/tools/adsb-globe-feeder/node_modules
FROMS=(0 18 31 41.5)
TOS=(18 31 41.5 52)

# Preflight: the local llama-server models hold ~22 GB and a 4K hero shot needs
# ~9 GB on top of the browser's ~3 GB. Without this check the shoot dies
# mid-segment with a Cesium "width 0" error that looks like a layout bug.
# Reap any local model server first: they respawn whenever the console asks the
# backend for a brief, and they will take the VRAM this render needs.
for pid in $(nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader \
             | grep -Ei "llama-server|ollama" | cut -d, -f1); do
  echo "freeing GPU: stopping model server $pid"
  kill -9 "$pid" 2>/dev/null || true
done
# The driver takes a few seconds to hand the memory back after a kill.
free_mb=0
for _ in $(seq 1 15); do
  sleep 2
  free_mb=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)
  [ "${free_mb:-0}" -ge 20000 ] && break
done
if [ "${free_mb:-0}" -lt 20000 ]; then
  echo "ABORT: only ${free_mb}MB VRAM free, need >20000MB."
  echo "  Free it:  curl -X POST localhost:8000/api/ai/models/active -H 'content-type: application/json' -d '{\"role\":\"main\",\"key\":null}'"
  echo "            then kill the llama-server PIDs from: nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv"
  exit 1
fi
echo "VRAM free: ${free_mb}MB"

WANT=("$@")
if [ ${#WANT[@]} -eq 0 ]; then WANT=(0 1 2 3); fi

for i in "${WANT[@]}"; do
  a=${FROMS[$i]}
  b=${TOS[$i]}
  echo "=== segment $i: $a -> $b"
  node "$HERE/shoot.js" --from "$a" --to "$b" --fps 30 --out "$HERE/seg$i.mp4" 2>&1 \
    | grep -E "renderer|cue|selected|wrote|FAILED|stopped rendering" || true
  got=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$HERE/seg$i.mp4" 2>/dev/null)
  # A crashed shoot still leaves a short but playable file behind, so length is
  # the only honest completion check.
  if ! python3 -c "import sys; g=float('${got:-0}'); w=float('$b')-float('$a'); sys.exit(0 if abs(g-w)<0.35 else 1)"; then
    echo "SEGMENT $i SHORT: got ${got:-0}s"
    exit 1
  fi
  echo "segment $i ok (${got}s)"
done

: > "$HERE/concat.txt"
for i in 0 1 2 3; do echo "file '$HERE/seg$i.mp4'" >> "$HERE/concat.txt"; done
ffmpeg -v error -f concat -safe 0 -i "$HERE/concat.txt" -c copy "$HERE/picture72.mp4" -y
echo "PICTURE $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$HERE/picture72.mp4")s"
