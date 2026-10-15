#!/bin/sh
# The swarm benchmark matrix (milestone 7): per-writer vs shared at 10/50/100/200 writers.
#
#   bench/swarm-matrix.sh <results-dir> [sizes] [think]     default sizes: "10 50 100 200"
#
# Stores go to HS_BENCH_DIR (default ~/.cache/hs-bench, on disk: per-writer stores at 200
# writers do not fit a tmpfs /tmp). Runs are sequential; between runs any leftover worker is
# killed and the stores removed, so one run can never contend with or fill the disk for the next.
set -u
OUT=${1:?results dir}
SIZES=${2:-"10 50 100 200"}
THINK=${3:-30}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export HS_BENCH_DIR=${HS_BENCH_DIR:-$HOME/.cache/hs-bench}
mkdir -p "$OUT"

cleanup() {
  pkill -9 -f "$ROOT/bench/swarm-worker.js" 2> /dev/null
  rm -rf "$HS_BENCH_DIR"
}

for n in $SIZES; do
  procs=8
  dur=120
  [ "$n" -le 10 ] && procs=2 && dur=60
  for mode in per-writer shared; do
    cleanup
    echo "== $mode $n writers $procs procs ${dur}s think ${THINK}s" | tee -a "$OUT/matrix.log"
    timeout $((dur + 900)) bare "$ROOT/bench/swarm.js" --writers "$n" --procs "$procs" --mode "$mode" \
      --duration "$dur" --think "$THINK" > "$OUT/$mode-$n.out" 2> "$OUT/$mode-$n.err"
    echo "exit $?" | tee -a "$OUT/matrix.log"
    grep '^|' "$OUT/$mode-$n.out" | tee -a "$OUT/matrix.log"
  done
done
cleanup
echo DONE | tee -a "$OUT/matrix.log"
