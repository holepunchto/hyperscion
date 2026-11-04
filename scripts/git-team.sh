#!/bin/sh
# The git control arm for experiments: a bare origin on the local filesystem (an always-up
# GitHub without the UI) and N agent clones, laid out like scripts/team.sh.
#
#   scripts/git-team.sh <dir> <n> [--skeleton <dir>] [--extra "pm a3b"]
#
# Creates:
#   <dir>/origin.git       bare origin; its reflog records every push to main
#   <dir>/agents/a1..aN    agent clones (plus --extra handles)
#   <dir>/bin/git-aN       per-agent git wrapper (sets the author, traces to <dir>/trace.jsonl)
# Fault injection (scripts/experiment/inject.js): renaming origin.git takes origin down for
# everyone; while <dir>/faults/<handle>.offline exists that handle's origin URL is dead;
# <dir>/faults/<handle>.dead makes the wrapper refuse to run.
set -e

DIR=$1
N=$2
shift 2 || { echo "usage: $0 <dir> <n> [--skeleton dir] [--extra handles]"; exit 1; }
SKELETON=
EXTRA=
while [ $# -gt 0 ]; do
  case "$1" in
    --skeleton) SKELETON=$2; shift 2 ;;
    --extra) EXTRA=$2; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

if [ -n "$SKELETON" ]; then SKELETON=$(cd "$SKELETON" && pwd); fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd)
mkdir -p "$DIR/agents" "$DIR/bin" "$DIR/faults"

wrapper() {
  cat > "$DIR/bin/git-$1" <<EOF
#!/bin/sh
# git for $1; every call is traced to $DIR/trace.jsonl
export HS_AGENT=$1 HS_TRACE=$DIR/trace.jsonl
export GIT_AUTHOR_NAME=$1 GIT_AUTHOR_EMAIL=$1@skyhop.test GIT_COMMITTER_NAME=$1 GIT_COMMITTER_EMAIL=$1@skyhop.test
export GIT_EDITOR=true GIT_PAGER=cat GIT_TERMINAL_PROMPT=0
if [ -f $DIR/faults/$1.dead ]; then echo "git: this machine is gone" >&2; exit 1; fi
if [ -f $DIR/faults/$1.offline ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.$DIR/unreachable.git.insteadOf GIT_CONFIG_VALUE_0=$DIR/origin.git
fi
exec $NODE $ROOT/scripts/experiment/git-trace.js "\$@"
EOF
  chmod +x "$DIR/bin/git-$1"
}

echo "== origin"
git init -q --bare -b main "$DIR/origin.git"
git -C "$DIR/origin.git" config core.logAllRefUpdates always

SEED=$DIR/.skeleton
git clone -q "$DIR/origin.git" "$SEED" 2> /dev/null
cd "$SEED"
if [ -n "$SKELETON" ]; then cp -r "$SKELETON"/. .; fi
# hs-only files; git gets the same union merge for NOTES.md through .gitattributes
rm -f .hsowners .hsattributes .hsreview
printf 'NOTES.md merge=union\n' > .gitattributes
git add -A
git -c user.name=hub -c user.email=hub@skyhop.test commit -q -m "project skeleton"
git push -q origin main
cd "$DIR" && rm -rf "$SEED"

HANDLES=
i=1
while [ $i -le "$N" ]; do HANDLES="$HANDLES a$i"; i=$((i + 1)); done
HANDLES="$HANDLES $EXTRA"

for a in $HANDLES; do
  wrapper $a
  git clone -q "$DIR/origin.git" "$DIR/agents/$a"
  # the best reasonable setup: rebase on pull, autostash, readable conflicts
  git -C "$DIR/agents/$a" config pull.rebase true
  git -C "$DIR/agents/$a" config rebase.autoStash true
  git -C "$DIR/agents/$a" config merge.conflictStyle zdiff3
  git -C "$DIR/agents/$a" config user.name $a
  git -C "$DIR/agents/$a" config user.email $a@skyhop.test
  echo "$a cloned"
done

echo
echo "team ready in $DIR"
echo "  origin: $DIR/origin.git"
echo "  agents: $DIR/agents/a1..a$N with wrappers $DIR/bin/git-aN"
