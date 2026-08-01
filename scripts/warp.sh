#!/usr/bin/env bash
# Cloudflare WARP as a LOCAL SOCKS5 egress — keyless, no login, no system routing.
#
# WHY: several upstreams gate on the caller's IP rather than a key (adsb.lol
# 451, airplanes.live/adsb.fi 403 from a datacenter address, OpenSky's anonymous
# credit budget). `warp-cli mode proxy` makes the daemon publish a SOCKS5 proxy
# on 127.0.0.1 whose exit is a Cloudflare consumer address. Only traffic sent to
# that port is tunnelled: the host's own routing and DNS are untouched, nothing
# needs root, and the consumer free tier registers anonymously — no account, no
# sign-in, no key.
#
# MEASURE BEFORE WIRING. From a residential egress WARP wins nothing (measured
# 2026-08-01, see docs/decisions.md) and can lose — OpenSky was unreachable
# through it. It is worth having where the backend runs on a datacenter IP.
#
#   scripts/warp.sh install   # one-time, needs root (apt repo + package)
#   scripts/warp.sh up        # register if needed, proxy mode, connect
#   scripts/warp.sh status    # daemon state + port + both exit addresses
#   scripts/warp.sh down      # disconnect (the daemon keeps running)
#   scripts/warp.sh dns       # OPTIONAL: point the HOST resolver at 1.1.1.1
set -euo pipefail

PORT="${WARP_PROXY_PORT:-40000}"

die() { echo "warp.sh: $*" >&2; exit 1; }

need_cli() {
  command -v warp-cli >/dev/null 2>&1 ||
    die "warp-cli not installed — run: scripts/warp.sh install"
}

case "${1:-status}" in
install)
  # Root step, and the only one. The backend never sudo's; app/warp.py just
  # logs this command when the binary is missing.
  [ "$(id -u)" -eq 0 ] || die "run as root: sudo scripts/warp.sh install"
  curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg |
    gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" \
    >/etc/apt/sources.list.d/cloudflare-client.list
  apt-get update && apt-get install -y cloudflare-warp
  ;;

up)
  need_cli
  # Consumer free tier: `registration new` mints an anonymous device identity.
  # No email, no login, no key. Only run it when there isn't one already.
  if ! warp-cli registration show >/dev/null 2>&1; then
    echo "registering (free tier, anonymous)…"
    warp-cli --accept-tos registration new
  fi
  warp-cli --accept-tos mode proxy
  warp-cli --accept-tos proxy port "$PORT"
  warp-cli --accept-tos connect
  # Wait for the port rather than sleeping blind; the daemon validates the SOCKS
  # config after `connect` returns Success and binds a moment later.
  for _ in $(seq 1 30); do
    if timeout 1 bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
      echo "SOCKS5 listening on 127.0.0.1:$PORT"
      exec "$0" status
    fi
    sleep 1
  done
  die "port $PORT never came up — check: warp-cli status"
  ;;

down)
  need_cli
  warp-cli --accept-tos disconnect
  ;;

dns)
  # OPTIONAL and NOT called by the backend. Traffic through the SOCKS proxy
  # already resolves at the WARP exit (Cloudflare's own resolver); this only
  # changes what the HOST resolves for everything else.
  [ "$(id -u)" -eq 0 ] || die "run as root: sudo scripts/warp.sh dns"
  resolvectl dns "$(resolvectl status | awk '/Link [0-9]+ \(/{gsub(/[()]/,"",$3); print $3; exit}')" 1.1.1.1 1.0.0.1
  resolvectl status | head -20
  ;;

status)
  need_cli
  warp-cli status || true
  echo -n "port $PORT: "
  timeout 1 bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null && echo "listening" || echo "closed"
  echo -n "direct exit : "
  curl -4 -s --max-time 8 https://1.1.1.1/cdn-cgi/trace | awk -F= '/^ip=/{print $2}' || echo "?"
  echo -n "warp exit   : "
  curl -s --max-time 12 --socks5-hostname "127.0.0.1:$PORT" https://1.1.1.1/cdn-cgi/trace |
    awk -F= '/^ip=|^warp=/{printf "%s ", $0}' || echo "?"
  echo
  ;;

*)
  die "usage: warp.sh {install|up|down|status|dns}"
  ;;
esac
