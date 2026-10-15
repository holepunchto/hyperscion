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
[ -n "$SCENARIO" ] || { echo "usage: $0 <teamdir> <hs|git> <s1|s2|s3>"; exit 1; }
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
if [ "$ARM" = git ]; then
  "$ROOT/scripts/git-team.sh" "$DIR" 5 --skeleton "$DIR/skeleton" --extra "$EXTRA"
else
  "$ROOT/scripts/team.sh" "$DIR" 5 --skeleton "$DIR/skeleton" --extra "$EXTRA"
fi

printf '{ "arm": "%s", "scenario": "%s" }\n' "$ARM" "$SCENARIO" > "$DIR/run.json"
# the playbook is copied in: next to docs/AGENTS-git.md, Claude Code also loads
# docs/AGENTS.md (the hs playbook) as directory instructions, which leaks hs into the git arm
if [ "$ARM" = git ]; then PLAYBOOK=AGENTS-git.md; else PLAYBOOK=AGENTS.md; fi
cp "$ROOT/docs/$PLAYBOOK" "$DIR/playbook.md"
mkdir -p "$DIR/prompts" "$DIR/reports"
ROLES=$(node -p "Object.keys({...require('$HERE/roles.json'), ...require('$SC/scenario.json').roles}).join(' ')")
for a in $ROLES; do
  node "$HERE/prompt.js" "$a" "$DIR" > "$DIR/prompts/$a.md"
done
echo "prompts: $(ls "$DIR/prompts" | tr '\n' ' ')"
