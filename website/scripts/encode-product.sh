#!/usr/bin/env bash
# Delivery encodes for the product recordings: 1920x1080, crf 30, plus a poster
# jpg per clip. Masters from shoot-product.cjs are crf 16 at 2560x1440 and stay
# out of the repo.
#   bash scripts/encode-product.sh <mastersDir> <assetsDir>
set -euo pipefail
IN="$1"; OUT="$2"
for f in "$IN"/*.mp4; do
  n=$(basename "$f" .mp4)
  case "$n" in hero-*|row-briefs|row-workflows) continue;; esac   # hero inserts live in the reel; two rows ship real stills instead
  ffmpeg -hide_banner -loglevel error -y -i "$f" -an -vf "scale=1920:1080:flags=lanczos" \
    -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -movflags +faststart "$OUT/$n.mp4"
  ffmpeg -hide_banner -loglevel error -y -ss 3 -i "$OUT/$n.mp4" -frames:v 1 -q:v 4 "$OUT/$n.jpg"
  ffmpeg -v error -i "$OUT/$n.mp4" -f null - || { echo "DECODE ERROR $n"; exit 1; }
  printf '%-16s %6.1f MB\n' "$n" "$(du -m "$OUT/$n.mp4" | cut -f1)"
done
