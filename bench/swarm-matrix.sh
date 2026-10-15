#!/bin/sh
# The swarm benchmark matrix (milestone 7): per-writer vs shared at several writer counts.
#
#   bench/swarm-matrix.sh <results-dir> [runs] [think]
#   runs: space-separated mode[+shared-dht]:writers, default
#         "per-writer:10 per-writer:25 per-writer:50 shared:10 shared:50 shared:100 shared:200"
#
# Stores go to HS_BENCH_DIR (default ~/.cache/hs-bench, on disk). Runs are sequential; between
# runs any leftover worker is killed and the stores removed. A run is aborted (and logged as
# such) if available memory drops below HS_BENCH_MIN_MEM_MB (default 3000): per-writer mode
# uses ~300 MB per writer, so it is memory, not writer count, that ends it on one machine.
set -u
OUT=${1:?results dir}
RUNS=${2:-"per-writer:10 per-writer:25 per-writer:50 shared:10 shared:50 shared:100 shared:200"}
THINK=${3:-30}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export HS_BENCH_DIR=${HS_BENCH_DIR:-$HOME/.cache/hs-bench}
MIN_MEM_MB=${HS_BENCH_MIN_MEM_MB:-3000}
mkdir -p "$OUT"

cleanup() {
  pkill -9 -f "$ROOT/bench/swarm-worker.js" 2> /dev/null
  pkill -9 -f "$ROOT/bench/swarm.js" 2> /dev/null
  rm -rf "$HS_BENCH_DIR"
}

avail_mb() { awk '/MemAvailable/ { print int($2 / 1024) }' /proc/meminfo; }

for run in $RUNS; do
  spec=${run%%:*}
  n=${run##*:}
  mode=${spec%%+*}
  extra=
  case "$spec" in *+shared-dht*) extra=--shared-dht ;; esac
  name=$(echo "$spec" | tr '+' '_')
  procs=8
  dur=120
  [ "$n" -le 10 ] && procs=2 && dur=60
  [ "$n" -gt 10 ] && [ "$n" -le 25 ] && procs=4
  cleanup
  echo "== $spec $n writers $procs procs ${dur}s think ${THINK}s" | tee -a "$OUT/matrix.log"
  timeout $((dur + 900)) bare "$ROOT/bench/swarm.js" --writers "$n" --procs "$procs" --mode "$mode" \
    --duration "$dur" --think "$THINK" $extra > "$OUT/$name-$n.out" 2> "$OUT/$name-$n.err" &
  pid=$!
  low=0
  while kill -0 $pid 2> /dev/null; do
    if [ "$(avail_mb)" -lt "$MIN_MEM_MB" ]; then
      low=$(avail_mb)
      cleanup
      break
    fi
    sleep 2
  done
  wait $pid
  code=$?
  if [ "$low" != 0 ]; then
    echo "aborted: available memory fell to ${low} MB" | tee -a "$OUT/matrix.log"
  else
    echo "exit $code" | tee -a "$OUT/matrix.log"
  fi
  grep '^|' "$OUT/$name-$n.out" | tee -a "$OUT/matrix.log"
done
cleanup
echo DONE | tee -a "$OUT/matrix.log"
