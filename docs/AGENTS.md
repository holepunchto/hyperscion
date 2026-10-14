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
- **Lands are provisional for a moment.** If two lands race, the order is settled when peers
  meet, and occasionally your land is undone. hs tells you loudly when that happens and keeps
  your changes, so you just land again.
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
   step 5.

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

## Shared files

Append-only coordination files like `NOTES.md` are listed in `/.hsattributes` with
`merge=union`, so concurrent appends never conflict. Add lines; don't rewrite others' lines.

For code files, real conflicts are rare, since lands are per file. When one happens,
`hs land -o` stops and says `real conflicts in <file>`. Fix the `<<<<<<<` markers, then land
again.

## What the messages mean

| you see                                                                    | meaning                                                       | do                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `landed #n (provisional ...)` / `pushed: a holder has the changes`         | done                                                          | carry on                                                                                                    |
| `main moved: /X (#18 a4) changed ...` then `rebasing ... (this is normal)` | a teammate landed the same file first; hs merges and retries  | nothing (if it ends in `landed #n`, you're done)                                                            |
| `incoming from teammates (n): ...`                                         | what your sync or land brought into your files                | skim; `hs show <n>` for details                                                                             |
| `real conflicts in X (#n author)`                                          | overlapping edits that couldn't be merged                     | fix markers in X (talk to that author if unsure), `hs land -o`                                              |
| `!! your last land was undone ...`                                         | lost a race                                                   | `hs sync && hs land -o`                                                                                     |
| `stale  path (behind main ...)` in `status`                                | main has a newer version that couldn't be fetched             | `hs pull` once a holder is online. Stale files are never landed, so you can't revert a teammate by accident |
| `modified (stale base)`                                                    | you edited a stale file                                       | `hs pull && hs sync`, or `hs restore <path>` to drop your edit                                              |
| `changed on main but also edited here, left as is`                         | hs won't overwrite your edits                                 | keep yours: `hs commit && hs sync`; take main's: `hs restore <path>`                                        |
| `could not be fetched ... no online peer holds it`                         | the holder is down, or the author left before a holder got it | tell the team owner; `hs doctor` shows what's reachable                                                     |
| `push timed out: no holder has your changes yet`                           | your land is only on your machine                             | `hs push` when a holder is up                                                                               |
| `another hs process is using this worktree`                                | e.g. `hs seed` running here                                   | stop it; seeds belong on the hub                                                                            |

Exit codes: `0` means done; `2` means done, but read the `!!` lines; `1` means error.

## Good to know

- `land` commits your working copy first, even if the land is then rejected. `hs diff` shows
  exactly what `land` will send.
- Online commands (`sync`, `pull`, `land -o`) spend about 2–3 s finding peers. Local commands
  (`status`, `show`, `log`, `cat` of fetched files) take milliseconds.
- `hs status` shows your uncommitted edits, what's committed but not landed, and stale files.
- `hs doctor` checks peers, whether a holder serves everything you need, and the state of your
  last land.
