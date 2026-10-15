#!/bin/sh
# Bootstrap a hyperscion team: a hub worktree that stays online as the holder
# (`hs seed --admit`) and N agent worktrees that are writers.
#
#   scripts/team.sh <dir> <n> [--skeleton <dir>] [--extra "pm a3b"] [--encrypt] [--blind-peer <key>]
#
# --extra clones more writers by handle (a change-request "pm", a stand-in agent) next to a1..aN.
# Fault injection (scripts/experiment/inject.js): while <dir>/faults/<handle>.offline exists,
# that handle's wrapper points hs at a dead DHT; <dir>/faults/<handle>.dead makes it refuse to run.
#
# Creates:
#   <dir>/hub              hub worktree (seeding; do not run other hs commands in it)
#   <dir>/agents/a1..aN    agent worktrees, writable
#   <dir>/bin/hs-aN        per-agent hs wrapper (sets USER/HS_AGENT, traces to <dir>/trace.jsonl)
#   <dir>/hub-seed.pid     stop the hub with: kill -INT $(cat <dir>/hub-seed.pid)
# Uses the public DHT unless HS_BOOTSTRAP=host:port is set.
set -e

DIR=$1
N=$2
shift 2 || { echo "usage: $0 <dir> <n> [--skeleton dir] [--extra handles] [--encrypt] [--blind-peer key]"; exit 1; }
SKELETON=
EXTRA=
ENCRYPT=
BLIND=
while [ $# -gt 0 ]; do
  case "$1" in
    --skeleton) SKELETON=$2; shift 2 ;;
    --extra) EXTRA=$2; shift 2 ;;
    --encrypt) ENCRYPT=--encrypt; shift ;;
    --blind-peer) BLIND=$2; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

if [ -n "$SKELETON" ]; then SKELETON=$(cd "$SKELETON" && pwd); fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BARE=$(cd "$ROOT" && node -p "require('bare-runtime')()")
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd)
mkdir -p "$DIR/hub" "$DIR/agents" "$DIR/bin" "$DIR/admit" "$DIR/faults"

wrapper() {
  cat > "$DIR/bin/hs-$1" <<EOF
#!/bin/sh
# hs for $1; every call is traced to $DIR/trace.jsonl
export USER=$1 HS_AGENT=$1 HS_TRACE=$DIR/trace.jsonl
if [ -f $DIR/faults/$1.dead ]; then echo "hs: this machine is gone" >&2; exit 1; fi
if [ -f $DIR/faults/$1.offline ]; then export HS_BOOTSTRAP=127.0.0.1:9; fi
exec $BARE $ROOT/bin.mjs "\$@"
EOF
  chmod +x "$DIR/bin/hs-$1"
}

wrapper hub
HUB="$DIR/bin/hs-hub"

echo "== hub"
cd "$DIR/hub"
if [ -n "$SKELETON" ]; then cp -r "$SKELETON"/. "$DIR/hub/"; fi
if [ ! -f .hsattributes ]; then printf 'NOTES.md merge=union\n' > .hsattributes; fi
"$HUB" init $ENCRYPT > "$DIR/init.out"
INVITE=$(grep '^repo' "$DIR/init.out" | awk '{print $2}')
if [ -n "$BLIND" ]; then "$HUB" blind-peer "$BLIND" > /dev/null; fi
"$HUB" land --offline -m "project skeleton" > /dev/null
echo "repo invite: $INVITE"

"$BARE" "$ROOT/bin.mjs" seed --admit "$DIR/admit" > "$DIR/hub-seed.log" 2>&1 &
echo $! > "$DIR/hub-seed.pid"
sleep 2

HANDLES=
i=1
while [ $i -le "$N" ]; do HANDLES="$HANDLES a$i"; i=$((i + 1)); done
HANDLES="$HANDLES $EXTRA"

for a in $HANDLES; do
  wrapper $a
  echo "== $a"
  cd "$DIR/agents"
  # not `| head`: a closed pipe can kill clone before it writes the admit key
  "$DIR/bin/hs-$a" clone "$INVITE" $a --as $a --admit "$DIR/admit" > "$DIR/clone-$a.log" 2>&1
  head -1 "$DIR/clone-$a.log"
  [ -f "$DIR/admit/$a.key" ] || [ -f "$DIR/admit/admitted/$a.key" ] || { echo "$a: no admit key written, see $DIR/clone-$a.log"; exit 1; }
  if [ -n "$BLIND" ]; then (cd "$DIR/agents/$a" && "$DIR/bin/hs-$a" blind-peer "$BLIND" > /dev/null); fi
done

echo "== waiting for the hub to admit writers"
tries=0
while [ "$(ls "$DIR/admit" | grep -vc '^admitted$')" != "0" ]; do
  tries=$((tries + 1))
  [ $tries -gt 60 ] && { echo "hub did not admit writers, see $DIR/hub-seed.log"; exit 1; }
  sleep 1
done

for a in $HANDLES; do
  cd "$DIR/agents/$a"
  tries=0
  until "$DIR/bin/hs-$a" fetch > /dev/null 2>&1 && "$DIR/bin/hs-$a" info | grep -q '(writable)'; do
    tries=$((tries + 1))
    [ $tries -gt 10 ] && { echo "$a did not become writable"; exit 1; }
    sleep 2
  done
  echo "$a writable"
done

echo
echo "team ready in $DIR"
echo "  hub (holder): pid $(cat "$DIR/hub-seed.pid"), log $DIR/hub-seed.log"
echo "  agents:       $DIR/agents/a1..a$N with wrappers $DIR/bin/hs-aN"
echo "  stop hub:     kill -INT \$(cat $DIR/hub-seed.pid)"
