#!/bin/sh
# Two-worktree end-to-end run of the hs CLI.
#
#   scripts/e2e.sh [workdir] [--encrypt]
#
# Uses the public DHT unless HS_BOOTSTRAP=host:port points at a private one
# (see scripts/testnet.js). A seeds as a mirror, B sparse-clones, gets added as a
# writer, lands with --online, and A syncs B's change after B has gone offline.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${1:-$(mktemp -d)}
ENCRYPT=$2

# the npm `bare` shim does not forward signals, so resolve the real binary
BARE=$(cd "$ROOT" && node -p "require('bare-runtime')()")
hs() { "$BARE" "$ROOT/bin.mjs" "$@"; }

rm -rf "$WORK/a" "$WORK/b" && mkdir -p "$WORK/a"
cd "$WORK/a"
hs init $ENCRYPT > "$WORK/init.out"
cat "$WORK/init.out"
INVITE=$(grep '^repo' "$WORK/init.out" | awk '{print $2}')

mkdir -p docs src && echo "# docs" > docs/index.md
for i in 1 2 3; do echo "src $i" > "src/$i.js"; done
hs land -m "initial import"

seed() {
  cd "$WORK/a"
  "$BARE" "$ROOT/bin.mjs" seed --mirror > "$WORK/seed-a.out" 2>&1 &
  SEED=$!
  sleep 2
}
unseed() { sleep 2; kill -INT $SEED; wait $SEED || true; cat "$WORK/seed-a.out"; }

seed
cd "$WORK" && hs clone "$INVITE" b --sparse src
echo "--- b materialized:"; (cd "$WORK/b" && find . -path ./.hs -prune -o -type f -print | sort)
WRITER=$(cd "$WORK/b" && hs info | grep '^writer' | awk '{print $2}')
unseed

cd "$WORK/a" && hs add-writer "$WRITER"

seed
cd "$WORK/b" && hs pull && hs info | grep '^writer'
echo "src 2 changed by b" > src/2.js
hs land --online -m "b edits"
unseed

cd "$WORK/a" && hs log && hs sync
echo "--- a/src/2.js:"; cat src/2.js
test "$(cat src/2.js)" = "src 2 changed by b" && echo "E2E OK"
