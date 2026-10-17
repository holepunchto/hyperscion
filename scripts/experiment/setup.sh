#!/bin/sh
# Set up one experiment run: the team for an arm and scenario, plus rendered prompts.
#
#   scripts/experiment/setup.sh <teamdir> <hs|git> <s1|s2|s3>
#
# Then: start the agents with <teamdir>/prompts/*.md, `date -Iseconds > <teamdir>/started.txt`,
# and run the scenario's schedule with `node scripts/experiment/inject.js <teamdir>`.
# Afterwards: inject.js --stop (hs: stops the hub), analyze.js, outcomes.js.
set -e

DIR=$1
ARM=$2
SCENARIO=$3
[ -n "$SCENARIO" ] || { echo "usage: $0 <teamdir> <hs|hs-min|hs-plain|git> <scenario>"; exit 1; }
# hs arms of the q0 experiment: the surface agents get (pm and people keep the full one)
case "$ARM" in
  hs) SURFACE= ;;
  hs-min) SURFACE=minimal ;;
  hs-plain) SURFACE=plain ;;
  git) ;;
  *) echo "unknown arm $ARM"; exit 1 ;;
esac
export AGENT_SURFACE=$SURFACE
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SC="$HERE/scenarios/$SCENARIO"
[ -f "$SC/scenario.json" ] || { echo "no scenario $SCENARIO"; exit 1; }
[ ! -e "$DIR" ] || { echo "$DIR exists"; exit 1; }
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd)

# the skeleton: the shared one plus the scenario's overlay
mkdir -p "$DIR/skeleton"
cp -r "$HERE/skeleton/." "$DIR/skeleton/"
if [ -d "$SC/skeleton" ]; then cp -r "$SC/skeleton/." "$DIR/skeleton/"; fi

EXTRA=$(node -p "require('$SC/scenario.json').extra.join(' ')")
N=$(node -p "require('$SC/scenario.json').agents || 5")
LOCAL_DHT=$(node -p "!!require('$SC/scenario.json').localDht")

# quick scenarios run hs on a local DHT testnet: no public-DHT latency, same code paths
if [ "$ARM" != git ] && [ "$LOCAL_DHT" = true ]; then
  BARE=$(cd "$ROOT" && node -p "require('bare-runtime')()")
  "$BARE" "$ROOT/scripts/testnet.js" > "$DIR/testnet.out" 2>&1 &
  echo $! > "$DIR/testnet.pid"
  tries=0
  until [ -s "$DIR/testnet.out" ]; do
    tries=$((tries + 1))
    [ $tries -gt 50 ] && { echo "testnet did not start"; exit 1; }
    sleep 0.2
  done
  export HS_BOOTSTRAP=$(head -1 "$DIR/testnet.out")
fi

if [ "$ARM" = git ]; then
  "$ROOT/scripts/git-team.sh" "$DIR" "$N" --skeleton "$DIR/skeleton" --extra "$EXTRA"
else
  "$ROOT/scripts/team.sh" "$DIR" "$N" --skeleton "$DIR/skeleton" --extra "$EXTRA"
fi

# people in the loop (docs/CLAIMS.md, phase 2): only the owner can mark a writer human, and it
# has to be on main before anyone creates an item that needs a person's approval
HUMANS=$(node -p "(require('$SC/scenario.json').humans || []).join(' ')")
if [ "$ARM" != git ]; then
  for h in $HUMANS; do
    KEY=$(cd "$DIR/agents/$h" && "$DIR/bin/hs-$h" info | awk '/^writer/{print $2}')
    (cd "$DIR/owner" && "$DIR/bin/hs-owner" add-writer "$KEY" --as "$h" --human) | tail -1
  done
fi

printf '{ "arm": "%s", "scenario": "%s", "bootstrap": "%s" }\n' "$ARM" "$SCENARIO" "${HS_BOOTSTRAP:-}" > "$DIR/run.json"
# the playbook is copied in: next to docs/AGENTS-git.md, Claude Code also loads
# docs/AGENTS.md (the hs playbook) as directory instructions, which leaks hs into the git arm
case "$ARM" in
  git) PLAYBOOK=AGENTS-git.md ;;
  hs-min) PLAYBOOK=AGENTS-min.md ;;
  hs-plain) PLAYBOOK=AGENTS-plain.md ;;
  *) PLAYBOOK=AGENTS.md ;;
esac
cp "$ROOT/docs/$PLAYBOOK" "$DIR/playbook.md"
mkdir -p "$DIR/prompts" "$DIR/reports"
ROLES="$(i=1; while [ $i -le "$N" ]; do printf 'a%s ' $i; i=$((i + 1)); done)$(node -p "Object.keys(require('$SC/scenario.json').roles).filter((r) => !/^a[0-9]+$/.test(r)).join(' ')")"
for a in $ROLES; do
  node "$HERE/prompt.js" "$a" "$DIR" > "$DIR/prompts/$a.md"
done
echo "prompts: $(ls "$DIR/prompts" | tr '\n' ' ')"
