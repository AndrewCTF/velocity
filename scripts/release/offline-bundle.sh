#!/usr/bin/env bash
# Build an offline (air-gapped) install bundle for one published release.
#
#   bash scripts/release/offline-bundle.sh v1.2.0 [outdir]
#
# Pulls the two pinned images docker-compose.prod.yml runs
# (ghcr.io/andrewctf/velocity-api and velocity-web at that tag) plus the
# digest-pinned nginx and timescale images the file names, `docker save`s them
# into one tar, and packs it with the prod compose file, the nginx config, the
# env template and a sha256 manifest. On the disconnected box:
#
#   tar -xzf velocity-offline-v1.2.0.tgz && cd velocity-offline-v1.2.0
#   docker load -i images.tar
#   cp .env.example .env   # set VELOCITY_VERSION, TIMESCALE_PASSWORD, keys
#   docker compose -f docker-compose.prod.yml up -d
#
# Nothing here is signed by this script: the ghcr images carry SBOM + build
# provenance attestations from .github/workflows/publish.yml, and the manifest
# lets the receiver check the tar was not altered in transit.
set -euo pipefail
VERSION=${1:?usage: $0 vX.Y.Z [outdir]}
OUT=${2:-dist}
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
NAME="velocity-offline-$VERSION"
STAGE="$OUT/$NAME"
rm -rf "$STAGE" && mkdir -p "$STAGE"

# Every image the prod compose file names, with the release tag substituted.
mapfile -t IMAGES < <(
  VELOCITY_VERSION="$VERSION" TIMESCALE_PASSWORD=placeholder \
    docker compose -f "$HERE/docker-compose.prod.yml" config --images | sort -u
)
[ "${#IMAGES[@]}" -gt 0 ] || { echo "no images resolved from docker-compose.prod.yml" >&2; exit 1; }
# nginx is built from infra/docker/nginx.Dockerfile (no registry copy), so
# build it here; everything with a registry path is pulled at its pinned tag.
VELOCITY_VERSION="$VERSION" TIMESCALE_PASSWORD=placeholder \
  docker compose -f "$HERE/docker-compose.prod.yml" build nginx
for img in "${IMAGES[@]}"; do
  case "$img" in */*) echo "pulling $img"; docker pull "$img" ;; *) echo "local build: $img" ;; esac
done
docker save -o "$STAGE/images.tar" "${IMAGES[@]}"

cp "$HERE/docker-compose.prod.yml" "$HERE/.env.example" "$STAGE/"
mkdir -p "$STAGE/infra/nginx" && cp "$HERE"/infra/nginx/*.conf "$STAGE/infra/nginx/"
printf '%s\n' "${IMAGES[@]}" > "$STAGE/images.txt"
( cd "$STAGE" && sha256sum images.tar docker-compose.prod.yml .env.example images.txt infra/nginx/*.conf > SHA256SUMS )
tar -C "$OUT" -czf "$OUT/$NAME.tgz" "$NAME"
rm -rf "$STAGE"
ls -l "$OUT/$NAME.tgz"
