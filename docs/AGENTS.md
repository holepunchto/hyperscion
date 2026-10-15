# Working in a team with hyperscion: the agent playbook

This is how an agent (or a human) works on a shared repo with `hs` alongside teammates who
work in parallel. It assumes a team set up with `scripts/team.sh`, which gives you:

- a worktree;
- an `hs` command;
- write access;
- an always-on **holder** that keeps everyone's landed work available.

## The model in five lines

- **main** is the shared history: numbered changesets `#n`, each with an author, a message
  and the files it touched.
- **Your worktree** is a private fork of main. Forking costs nothing, and nobody sees your work
  until you land it.
- **`hs land`** puts your changes on main. There are no locks and no merge queue: if a
  teammate changed the same file since your last sync, `land` rebases (3-way merge) and
  retries for you.
- **Lands are provisional for a moment, then settled, then final.** If two lands race, the
  order is decided when peers meet, and occasionally your land is undone. hs tells you loudly
  when that happens and keeps your changes, so you just land again. Once the hub has seen your
  land (usually within seconds) it is **settled** and can't be undone any more; it is
  **final** once it is also accepted by review (see below).
- **Holders** keep landed files available when their author is offline. The team's hub
  (`hs seed`, or a blind peer) is the one that's always on. Every running `hs watch` feed is a
  holder too: it announces itself and keeps a copy of everything landed, so while the hub is
  down, teammates still land and sync through each other's feeds. Only the hub survives your
  machine going away, though. Don't run `hs seed` in your own worktree.

## The loop

1. **Start watching once, in the background.** Read new lines whenever you want to know what
   teammates did; don't poll.

   ```sh
   hs watch --json >> .hs/feed.jsonl        # run in the background, keep it running
   tail -n 20 .hs/feed.jsonl                # what landed recently
   hs watch --stop                          # stop *your* feed (never pkill: it hits teammates)
   ```

   A feed resumes where it stopped, so restarting one never skips or repeats a changeset.
   If a feed can't reach anyone (the hub is down and no teammate's feed is running), it prints
   `{"type":"offline"}` (text: `!! watch: no peers reachable`), keeps retrying, and prints
   `{"type":"online"}` when peers are back. Silence in the feed means nothing landed.
   If the hub is down but teammates' feeds are up, you stay online and keep landing; the feed
   then prints `{"type":"hub","state":"stalled",...}` (text: `!! watch: hub not settling`)
   because lands stay provisional, and `{"type":"hub","state":"settling",...}` when it's back.

   Each line is `{"type":"changeset","seq":27,"author":"a3","files":[...],"message":"..."}`.
   A `{"type":"reorg",...}` line means a provisional land was replaced. If it was yours, see
   step 5. `{"type":"settled","seq":27,...}` lines say how far main is settled.

   To **wait** for a teammate instead of busy-looping, block until they land the file. A wait
   counts everything after the base you last synced to, so if it already landed it returns
   at once:

   ```sh
   hs watch --path /src/model.js --count 1 --timeout 600   # exit 0: it landed; exit 2: timed out
   hs sync                                                  # then bring it in
   ```

   `--count` counts changesets (with `--for-me`, review events). `--path` takes a file or a
   folder and can be repeated. If the wait returns at once with
   `watch: already on main before this wait`, the change landed after your last sync: `hs sync`
   brings it in. To wait only for lands that happen from now on, add `--new`.

2. **Bring teammates' work in** before building on it: `hs sync`. This pulls main, fetches
   what you need, rebases your work on top, updates your files and lists what came in
   (`incoming from teammates: #18 a4 /src/report.js :: ...`).
3. **Land small and often, tested.** Write messages for your teammates, because they read
   them in their feed. `--check` first brings main into your files, runs the command on
   main + your changes, and lands only if it passes. If main moves while it runs, it checks
   again:
   ```sh
   hs land -m "scheduler: Plan shape pinned in CONTRACTS.md" --check "npm test"
   ```
   Without `--check`, `land` still rebases onto teammates' work, but nobody has run the
   combination; it says so (`your land sits on these untested`).
4. **Learn from teammates' changes:**
   - `hs show 27` — the changeset's message plus a unified diff of every file;
     `hs show 27 --path src/geo.js` for just that file.
   - `hs log -n 10` — recent changesets with their files; `--oneline` for one line each.
     `hs log src/geo.js` is the history of one file. If your feed knows main is further
     ahead, `log` and `status` say so.
   - `hs cat /src/geo.js` — the latest landed version of a file, without touching your worktree.
5. **When you see `!! your last land was undone by a concurrent land`** (or a `reorg` naming
   your land), run `hs sync && hs land`. Your changes were kept.

## Ship, Show or Ask

Every change is one of three kinds. Pick deliberately; it's how teammates learn what you need
from them.

|          | when                                                                                      | how                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ship** | your own files, routine changes                                                           | `hs land -m "..."`                                                                                                                               |
| **Show** | someone else's files, or a change worth a second look; land now, review after             | `hs land` (the **default** when you touch files another teammate owns in `/.hsowners`; they're asked automatically), or `hs land --reviewers a3` |
| **Ask**  | interfaces and contracts others build on, anything risky, and paths `/.hsreview` protects | `hs propose -m "..." --reviewers a3` then wait for approval, then `hs land`                                                                      |

**Don't fix a teammate's module silently.** If their code doesn't fit yours:

- **Small fix:** land it. It becomes a Show, and they're told.
- **Interface or contract change:** propose it (Ask), so the owner decides. Three people fixing
  the same thing in parallel was the main waste in our last run.

**Reviewing.**

- `hs status` lists what's waiting for you.
- `hs watch --for-me --count 1 --timeout 600` blocks until something involves you: a review
  request, a review of your work, or an approval.
- `hs show P5` or `hs show 27` shows the change with a diff.
- Answer with `hs review P5 approve`, `hs review P5 changes -m "src/x.js:42 ..."` or
  `hs review #27 comment -m "..."`.

**Rules.**

- Approvals only count from people other than the author.
- An approval is pinned to the exact content it saw. Running `hs propose` again after
  changes makes a new revision, and approvals start over.
- `hs proposals` lists open proposals. Once a proposal is approved, its author lands it with
  `hs land`.

## Provisional, settled, final

| state           | means                                                              | what can still happen                               |
| --------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| **provisional** | on main, but the hub hasn't acked it yet                           | a concurrent land can undo it (you'll be told)      |
| **settled**     | the hub (every indexer) has seen it; its place in history is fixed | nothing reorders it; a Show may still get "changes" |
| **final**       | settled, and accepted by review                                    | nothing                                             |

What "accepted by review" means depends on the kind of change:

- **Ship:** final as soon as it settles.
- **Show:** final once it settles **and** a requested reviewer approved, with no outstanding
  "changes" from any of them.
- **Ask:** the proposal was approved before it landed, so it's final as soon as it settles.

How to use it:

- `hs land` waits up to 10 s for the hub and ends with `#27 final`,
  `#27 settled; not final until review from a4`, or, if the hub is slow or down,
  `#27 provisional: waiting for hub to ack (it settles on its own)`. All of these exit `0`.
- `hs land --wait-final [--timeout 60]` keeps waiting until the land is final, review
  included, and exits `2` if it isn't by the timeout. Use it when the next step depends on it.
- You don't need to wait before carrying on. Keep working; build on a teammate's land once
  it's settled if you want to be sure it won't move.
- `hs status` shows `last land: #27 final` (or what it's waiting for) and lists
  `your lands not final yet`. `hs log` tags every changeset `[final]`, `[settled]` or
  `[provisional]`.
- `hs watch --for-me` prints `@ #27 settled; not final until review from a4` and later
  `@ #27 final` for your own lands.
- Waiting on review is a conversation, not an error: answer the "changes" (land a fix, which
  is a new Show) or ping the reviewer in `NOTES.md`.

## Shared files

Append-only coordination files like `NOTES.md` are listed in `/.hsattributes` with
`merge=union`, so concurrent appends never conflict. Add lines; don't rewrite others' lines.

For code files, real conflicts are rare, since lands are per file. When one happens,
`hs land` stops and says `real conflicts in <file>`. Fix the `<<<<<<<` markers, then land
again.

## What the messages mean

| you see                                                                    | meaning                                                             | do                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `landed #n` / `pushed: a holder has the changes` / `#n final`              | done                                                                | carry on                                                                                                    |
| `#n settled; not final until review from a4`                               | its place is fixed; the Show review is still open                   | carry on; answer any "changes"                                                                              |
| `#n provisional: waiting for hub to ack`                                   | the hub (indexer) is slow, offline or behind                        | carry on; it settles on its own. If it persists, tell the team owner (`hs doctor`)                          |
| `!! no peers online: landed locally only`                                  | nobody to push to                                                   | `hs push` when a holder is up                                                                               |
| `!! hub not settling` (feed or `status`)                                   | the hub is down or behind; lands still reach teammates via feeds    | keep working; they settle when it's back. If it persists, tell the team owner                               |
| `!! no peers reachable: showing local main #n`                             | `sync` reached nobody: your files are as of what this machine has   | keep working; `hs sync` again shortly                                                                       |
| `main moved: /X (#18 a4) changed ...` then `rebasing ... (this is normal)` | a teammate landed the same file first; hs merges and retries        | nothing (if it ends in `landed #n`, you're done)                                                            |
| `incoming from teammates (n): ...`                                         | what your sync or land brought into your files, oldest first        | skim; `hs show <n>` for details                                                                             |
| `!! not landed: check failed (exit n) on main #m + your changes`           | your `--check` failed on the merged tree                            | your files now include main: fix, then `hs land --check ...` again                                          |
| `real conflicts in X (#n author)`                                          | overlapping edits that couldn't be merged                           | fix markers in X (talk to that author if unsure), `hs land`                                                 |
| `!! your last land was undone ...`                                         | lost a race                                                         | `hs sync && hs land`                                                                                        |
| `stale  path (behind main ...)` in `status`                                | main has a newer version that couldn't be fetched                   | `hs sync` once a holder is online. Stale files are never landed, so you can't revert a teammate by accident |
| `modified (stale base)`                                                    | you edited a stale file                                             | `hs sync`, or `hs restore <path>` to drop your edit                                                         |
| `changed on main but also edited here, left as is`                         | hs won't overwrite your edits                                       | keep yours: `hs commit && hs sync`; take main's: `hs restore <path>`                                        |
| `could not be fetched ... no online peer holds it`                         | the holder is down, or the author left before a holder got it       | tell the team owner; `hs doctor` shows what's reachable                                                     |
| `push timed out: no holder has your changes yet`                           | your land is only on your machine                                   | `hs push` when a holder is up                                                                               |
| `showing to a4 (owner of /src/pricing.js)`                                 | you changed a teammate's files; this is a Show                      | nothing; they'll review after it lands                                                                      |
| `!! not landed: needs review: ...`                                         | Ask needed: unapproved proposal or a path protected by `/.hsreview` | `hs propose --reviewers ...`, wait for approval (`hs watch --for-me --count 1`), `hs land`                  |
| `stale-review`                                                             | the proposal changed after you looked                               | `hs show P5` again, then review again                                                                       |
| `another hs process is using this worktree`                                | e.g. `hs seed` running here                                         | stop it; seeds belong on the hub                                                                            |

Exit codes: `0` means done; `2` means done, but read the `!!` lines; `1` means not done: an
error, or a land that didn't happen (`!! not landed: ...` says why, where your changes are
and what to do next).

## Good to know

- `land` commits your working copy first, even if the land is then rejected. `hs diff` shows
  exactly what `land` will send, as a patch (`--stat` for just the paths).
- Every command that needs peers goes online by itself; `--offline` opts out. The old
  `land -o` still works but isn't needed.
- Online commands (`sync`, `fetch`, `land`) spend about 2–3 s finding peers. Local commands
  (`status`, `show`, `log`, `cat` of fetched files) take milliseconds.
- `hs status` shows your uncommitted edits, what's committed but not landed, and stale files.
- `hs doctor` checks peers, whether a holder serves everything you need, the state of your
  last land, how far main is settled, and what each indexer has seen.
