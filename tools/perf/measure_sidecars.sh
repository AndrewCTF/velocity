#!/usr/bin/env bash
# Measure what the browser sidecar tier actually costs.
#
# The failure this is built to catch is a LEAK, and a leak is invisible in one
# sample: commit 2ff71f9 measured "496 leaked Chrome renderers (459 AIS + 36
# ADS-B) holding tens of GB after ~1h40m". Use --soak for that; the default
# single pass is for before/after on the per-request costs.
#
#   bash tools/perf/measure_sidecars.sh              # one pass
#   bash tools/perf/measure_sidecars.sh --soak 1800  # sample every 60s for 30min
set -uo pipefail

SOAK=0
[ "${1:-}" = "--soak" ] && SOAK="${2:-1800}"

ADSB="http://127.0.0.1:8090"
AIS="http://127.0.0.1:8093"

chrome_procs() { pgrep -c -x chrome 2>/dev/null || echo 0; }
chrome_rss_mb() {
  # Sum RSS (kB) over every process whose comm is exactly "chrome".
  local total=0 pid rss
  for pid in $(pgrep -x chrome 2>/dev/null); do
    rss=$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
    total=$((total + ${rss:-0}))
  done
  echo $((total / 1024))
}
node_line() {
  ps -o pid=,rss=,pcpu=,etimes=,args= -C node 2>/dev/null \
    | grep -F "$1" | head -1 | awk '{printf "pid=%s rss=%dMB cpu=%s%% up=%ss", $1, $2/1024, $3, $4}'
}

probe() { # url label reps
  local url="$1" label="$2" reps="${3:-10}" i out
  local -a totals=() sizes=()
  for ((i = 0; i < reps; i++)); do
    out=$(curl -s -o /dev/null -H 'Accept-Encoding: gzip' \
          -w '%{time_total} %{size_download} %{http_code}' --max-time 20 "$url" 2>/dev/null) || out="0 0 000"
    totals+=("$(echo "$out" | cut -d' ' -f1)")
    sizes+=("$(echo "$out" | cut -d' ' -f2)")
    CODE=$(echo "$out" | cut -d' ' -f3)
  done
  local med_t med_s
  med_t=$(printf '%s\n' "${totals[@]}" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}')
  med_s=$(printf '%s\n' "${sizes[@]}" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}')
  printf '| %s | %s | %s ms | %s bytes |\n' "$label" "$CODE" \
    "$(awk -v t="$med_t" 'BEGIN{printf "%.1f", t*1000}')" "$med_s"
}

header() {
  echo "# measure_sidecars — $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "chrome procs: $(chrome_procs)   chrome RSS: $(chrome_rss_mb) MB"
  echo "adsb feeder:  $(node_line adsb-globe-feeder)"
  echo "ais  feeder:  $(node_line ais-myshiptracking-feeder)"
  echo
}

endpoints() {
  echo "| endpoint | code | p50 total | p50 size |"
  echo "|---|---|---|---|"
  probe "$ADSB/aircraft.json" "adsb :8090 /aircraft.json" 10
  probe "$ADSB/health"        "adsb :8090 /health"        10
  probe "$AIS/vessels.json"   "ais  :8093 /vessels.json"  6
  probe "$AIS/health"         "ais  :8093 /health"        10
  echo
  echo "### /health bodies"
  echo '```'
  curl -s --max-time 5 "$ADSB/health" | head -c 900; echo
  curl -s --max-time 5 "$AIS/health"  | head -c 900; echo
  echo '```'
}

if [ "$SOAK" -eq 0 ]; then
  header
  endpoints
  exit 0
fi

echo "# measure_sidecars --soak ${SOAK}s — started $(date '+%Y-%m-%d %H:%M:%S')"
echo
echo "| t+s | chrome procs | chrome RSS MB | adsb rss MB | ais rss MB |"
echo "|---|---|---|---|---|"
START=$(date +%s)
END=$((START + SOAK))
while [ "$(date +%s)" -lt "$END" ]; do
  T=$(( $(date +%s) - START ))
  A=$(ps -o rss= -C node 2>/dev/null | awk '{s+=$1} END{printf "%d", s/1024}')
  printf '| %s | %s | %s | %s | — |\n' "$T" "$(chrome_procs)" "$(chrome_rss_mb)" "${A:-0}"
  sleep 60
done
echo
header
endpoints
