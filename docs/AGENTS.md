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
- **`hs land -o`** puts your changes on main. There are no locks and no merge queue: if a
  teammate changed the same file since your last sync, `land` rebases (3-way merge) and
  retries for you.
- **Lands are provisional for a moment, then settled, then final.** If two lands race, the
  order is decided when peers meet, and occasionally your land is undone. hs tells you loudly
  when that happens and keeps your changes, so you just land again. Once the hub has seen your
  land (usually within seconds) it is **settled** and can't be undone any more; it is
  **final** once it is also accepted by review (see below).
- **The holder** (a hub running `hs seed --mirror`, or a blind peer) keeps every landed file
  available when its author is offline. Every team needs one. Don't run `hs seed` in your own
  worktree.

## The loop

1. **Start watching once, in the background.** Read new lines whenever you want to know what
   teammates did; don't poll.

   ```sh
   hs watch --json >> .hs/feed.jsonl        # run in the background, keep it running
   tail -n 20 .hs/feed.jsonl                # what landed recently
   hs watch --stop                          # stop *your* feed (never pkill: it hits teammates)
   ```

   A feed resumes where it stopped, so restarting one never skips or repeats a changeset.

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

2. **Bring teammates' work in** before building on it: `hs sync`. This pulls main, fetches
   what you need, rebases your work on top, updates your files and lists what came in
   (`incoming from teammates: #18 a4 /src/report.js :: ...`).
3. **Land small and often.** Write messages for your teammates, because they read them in
   their feed:
   ```sh
   hs land -o -m "scheduler: Plan shape pinned in CONTRACTS.md; plan(day) handles windows"
   ```
4. **Learn from teammates' changes:**
   - `hs show 27` — the changeset's message plus a unified diff of every file.
   - `hs log -f -n 10` — recent changesets with their files. `hs log -f src/geo.js` is the
     history of one file.
   - `hs cat /src/geo.js` — the latest landed version of a file, without touching your worktree.
5. **When you see `!! your last land was undone by a concurrent land`** (or a `reorg` naming
   your land), run `hs sync && hs land -o`. Your changes were kept.

## Ship, Show or Ask

Every change is one of three kinds. Pick deliberately; it's how teammates learn what you need
from them.

|          | when                                                                                      | how                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ship** | your own files, routine changes                                                           | `hs land -o -m "..."`                                                                                                                                         |
| **Show** | someone else's files, or a change worth a second look; land now, review after             | `hs land -o` (the **default** when you touch files another teammate owns in `/.hsowners`; they're asked automatically), or `hs land -o --show --reviewers a3` |
| **Ask**  | interfaces and contracts others build on, anything risky, and paths `/.hsreview` protects | `hs propose -o -m "..." --reviewers a3` then wait for approval, then `hs land -o`                                                                             |

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
- An approval is pinned to the exact content it saw. Running `hs propose -o` again after
  changes makes a new revision, and approvals start over.
- `hs proposals` lists open proposals. Once a proposal is approved, its author lands it with
  `hs land -o`.

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

- `hs land -o --wait-final` waits (default 60 s, `--timeout <s>`) and prints `#27 final`, or
  `#27 settled; not final until review from a4`. It exits `2` with
  `!! #27 not settled after 60s: waiting for hub to ack` if the hub is down.
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
`hs land -o` stops and says `real conflicts in <file>`. Fix the `<<<<<<<` markers, then land
again.

## What the messages mean

| you see                                                                    | meaning                                                             | do                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `landed #n (provisional ...)` / `pushed: a holder has the changes`         | done; it settles once the hub acks                                  | carry on (`--wait-final` if you need it final)                                                              |
| `#n settled; not final until review from a4`                               | its place is fixed; the Show review is still open                   | carry on; answer any "changes"                                                                              |
| `!! #n not settled after 60s: waiting for hub to ack`                      | the hub (indexer) is offline or behind                              | carry on; tell the team owner if it persists (`hs doctor`)                                                  |
| `main moved: /X (#18 a4) changed ...` then `rebasing ... (this is normal)` | a teammate landed the same file first; hs merges and retries        | nothing (if it ends in `landed #n`, you're done)                                                            |
| `incoming from teammates (n): ...`                                         | what your sync or land brought into your files                      | skim; `hs show <n>` for details                                                                             |
| `real conflicts in X (#n author)`                                          | overlapping edits that couldn't be merged                           | fix markers in X (talk to that author if unsure), `hs land -o`                                              |
| `!! your last land was undone ...`                                         | lost a race                                                         | `hs sync && hs land -o`                                                                                     |
| `stale  path (behind main ...)` in `status`                                | main has a newer version that couldn't be fetched                   | `hs pull` once a holder is online. Stale files are never landed, so you can't revert a teammate by accident |
| `modified (stale base)`                                                    | you edited a stale file                                             | `hs pull && hs sync`, or `hs restore <path>` to drop your edit                                              |
| `changed on main but also edited here, left as is`                         | hs won't overwrite your edits                                       | keep yours: `hs commit && hs sync`; take main's: `hs restore <path>`                                        |
| `could not be fetched ... no online peer holds it`                         | the holder is down, or the author left before a holder got it       | tell the team owner; `hs doctor` shows what's reachable                                                     |
| `push timed out: no holder has your changes yet`                           | your land is only on your machine                                   | `hs push` when a holder is up                                                                               |
| `showing to a4 (owner of /src/pricing.js)`                                 | you changed a teammate's files; this is a Show                      | nothing; they'll review after it lands                                                                      |
| `not landed, needs review: ...`                                            | Ask needed: unapproved proposal or a path protected by `/.hsreview` | `hs propose -o --reviewers ...`, wait for approval (`hs watch --for-me --count 1`), `hs land -o`            |
| `stale-review`                                                             | the proposal changed after you looked                               | `hs show P5` again, then review again                                                                       |
| `another hs process is using this worktree`                                | e.g. `hs seed` running here                                         | stop it; seeds belong on the hub                                                                            |

Exit codes: `0` means done; `2` means done, but read the `!!` lines; `1` means error.

## Good to know

- `land` commits your working copy first, even if the land is then rejected. `hs diff` shows
  exactly what `land` will send.
- Online commands (`sync`, `pull`, `land -o`) spend about 2–3 s finding peers. Local commands
  (`status`, `show`, `log`, `cat` of fetched files) take milliseconds.
- `hs status` shows your uncommitted edits, what's committed but not landed, and stale files.
- `hs doctor` checks peers, whether a holder serves everything you need, the state of your
  last land, how far main is settled, and what each indexer has seen.
