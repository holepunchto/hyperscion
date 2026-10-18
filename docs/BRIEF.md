# Working with hs (hyperscion)

You share this repo with teammates who work in parallel. Use `hs` for all source
control; never use git.

## Start

- `hs sync` brings main into your files and lists open work items and who leads them.
- Keep a feed running in the background and read it instead of polling:
  `hs watch --json >> .hs/feed.jsonl &`, then `tail -n 20 .hs/feed.jsonl`.
  Stop only your own feed with `hs watch --stop` (never pkill).

## Decide who builds what before you build

- `hs claim <item>`: exit 0 and "you lead" means build it. Exit 2 means a teammate
  leads: don't build it too. Help or review instead.
- `hs claim <item> --if-free` claims it only if nobody leads it, and withdraws at once
  otherwise.
- Work nobody filed: `hs claim --new "<title>"`.
- "nobody heard this claim" means you are offline: claim again once you're back,
  before building.

## Land small and tested

- `hs land -m "<what and why>" --check "npm test"` rebases and retries for you.
- If the land finishes the item you lead, add `--done`.
- A land is provisional, then settled, then final. `hs wait-final` waits for final and
  says whether the hub is reachable. If it isn't, keep working: your land settles by
  itself later.

## Wait for a teammate instead of polling

- `hs watch --path /src/model.js --count 1 --timeout 600 --sync`
  (exit 0: it landed and is in your files; exit 2: timed out).

## Review

- `hs review 12 approve -m "<what you checked>"`. Name changesets by their number (12):
  shells read a word starting with # as a comment, so `#12` would vanish.

## When hs says your land was undone

- `hs sync` restores it and lands it again.
- If it conflicts with a teammate's land that did the same work, keep theirs:
  `hs restore <paths>`.

## Look around

- `hs status`, `hs diff`, `hs log`, `hs show 12`, `hs claims`, `hs doctor`.
- The full playbook: `hs agents --full`.
