# Working with hs (hyperscion)

You share this repo with teammates who work in parallel. Use `hs` for all source
control; never use git.

## Start

- `hs sync` brings main into your files and lists open tasks and who leads them.
- Keep a feed running in the background and read it instead of polling:
  `hs watch --json >> .hs/feed.jsonl &`, then `tail -n 20 .hs/feed.jsonl`.
  Stop only your own feed with `hs watch --stop` (never pkill).

## Decide who builds what before you build

- `hs task` lists the tasks and who leads each.
- `hs task start <task>`: exit 0 and "you lead" means build it. Exit 2 means a teammate
  leads: don't build it too. Help or review instead.
- `hs task start <task> --if-free` starts it only if nobody leads it, and steps away at once
  otherwise.
- Work nobody filed: `hs task start --new "<title>"`.
- "nobody heard you start it" means you are offline: start it again once you're back,
  before building.
- `hs task stop <task>` when you step away from it.

## Land small and tested

- `hs land -m "<what and why>" --check "npm test"` rebases and retries for you.
- Untracked files your `.gitignore` or `.hsignore` match never land (`hs status --ignored`).
- If the land finishes the task you lead, add `--done`.
- A land is provisional, then settled, then final. `hs wait-final` waits for final and
  says whether the hub is reachable. If it isn't, keep working: your land settles by
  itself later.

## Wait for a teammate instead of polling

- `hs watch --path /src/model.js --count 1 --timeout 600 --sync`
  (exit 0: it landed and is in your files; exit 2: timed out).

## Review

- `hs review` shows what waits on you.
- `hs review approve 12 -m "<what you checked>"`, or `hs review changes 12 -m "..."` to
  submit feedback suggesting changes. Name changesets by their number (12): shells read a
  word starting with # as a comment, so `#12` would vanish.
- Ask before landing something risky: `hs review ask -m "..." -r <handle>`, then `hs land`
  once it's approved.

## When hs says your land was undone

- `hs sync` restores it and lands it again.
- If it conflicts with a teammate's land that did the same work, keep theirs:
  `hs restore <paths>`.

## Look around

- `hs status`, `hs diff`, `hs log`, `hs show 12`, `hs task`, `hs doctor`.
- The full playbook: `hs agents --full`.
