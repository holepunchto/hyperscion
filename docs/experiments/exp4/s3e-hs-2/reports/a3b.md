# a3b report (took over the scheduler from a3)

## 1. What I built

- a3 had already landed scheduler v1 + the pinned `Plan` shape (#10) before dying; I kept that shape unchanged.
- **#23**: capped mid-trip hovering at `MAX_HOVER_MINUTES = 15`. a4 and a5 had both flagged in NOTES that on day1, d4 hovered about 108 min, loaded, waiting for p02's window. A package with a window that late now gets its own trip. I also added tests: the hover cap, a short wait that is still allowed, real `model.loadDay` (frozen Day) output equal to raw, and reasons always drawn from `REASONS`. I added NOTES and CONTRACTS lines saying that a3b now owns the scheduler.
- **#24**: idle-gap insertion, following a2's #17 observation. A package can join any trip of a drone, or open a new trip in any idle gap (before the first trip, between trips, after the last), as long as no other trip moves. On day1 the total went from 125 km to 101 km and the last delivery is now about 02:08, still 18 delivered with p19 unassigned. Added a test and updated the CONTRACTS rule text.
- I left main at #27: `npm test` passes 68/68, and `node src/cli.js plan` works on day1 and on every edge fixture.

## 2. How I learned about teammates' work

- At first, `hs sync` and `hs doctor` both said "no peers found, using local state" / "offline: no peers", and main was at #1. I assumed I was starting from an empty project and wrote a whole scheduler from scratch, about 15 minutes of work. Shortly after, `hs sync` connected and brought in #2..#14, including a3's own scheduler (#10).
- The background `hs watch --json >> .hs/feed.jsonl`, started while there were no peers, printed `watch: no peers yet, waiting...` and never wrote a line, even after `sync` had found peers. I had to `hs watch --stop` and start it again. After the restart it backfilled correctly (54 lines).
- After that I mostly used:
  - the "incoming from teammates" list printed by `sync`/`land`;
  - NOTES.md, which was the richest channel because a2, a4 and a5 had left observations addressed to a3;
  - `hs watch --count N --timeout T` to block waiting for new lands.
- The blocking watch did replace polling. The JSON feed file was useful mainly for confirming settlement.

## 3. Moments where others' work changed what I did

- **#10 (a3)**: seeing a3's landed scheduler made me throw away my parallel rewrite and adopt a3's code. It was nearly identical in design, and its Plan shape was already integrated by a4/a5 (#11, #14).
- **#17 (a2) plus the a4/a5 NOTES lines (from #18/#19)**: these flagged the 108-minute hover on d4 and the idle gaps on d3/d1. They became my #23 and #24.
- **#12 (a2)**: a2's tests cross-check every scheduler trip against `geo.planTrip`. That gave me confidence that changing the timing logic would be validated independently. It still passed on #24 (see #26).
- **#25 (a4)**: a4 noted that revenue moves with scheduling. I left it as intended per the pinned formula; it was not my call.

## 4. Conflicts, rebases, flips

- **1 real conflict.** The first successful `hs sync` reported `CONFLICT /src/scheduler.js`: my offline-written scheduler against a3's #10, with `<<<<<<< ours` markers.
  - I ran `hs restore /src/scheduler.js`. It said `restored`, but the file still had my conflicted content, because restore rewrites from the *workspace* version, and sync had already committed my conflicted edit there.
  - The fix was `hs cat /src/scheduler.js > src/scheduler.js` then `hs commit`.
  - Afterwards `hs status` still showed `1 committed path(s) not landed / commit /src/scheduler.js`, even though `hs diff --stat` was empty because the content equalled main. The next land cleared it.
- **No flips/reorgs** (0 `reorg` lines in the feed).
- **Rebases:** #23 brought in 8 incoming changesets with no file overlap. Both lands with `--check` reported `#n final` right away.

## 5. Friction, bugs, confusing output

1. A fresh agent got `no peers found, using local state` / `up to date with main #1`, and `hs doctor` said `verdict offline: no peers`, while the holder actually had #14. "Up to date with main #1" is misleading: it should say "could not reach any peer; main may be ahead". It cost me a duplicate implementation.
2. The `hs watch --json` started with no peers stayed stuck at `watch: no peers yet, waiting...` and never connected, even after other commands found peers.
3. `hs restore <path>` does not discard a change that sync auto-committed, so a conflicted file stays conflicted. There is no obvious "take main's version" command (`hs restore --from main` would help).
4. `hs commit -m "..."` gives `hs: UNKNOWN_FLAG: m`. `land` takes `-m` but `commit` doesn't, which is inconsistent.
5. `hs status` lists `committed path(s) not landed` for a path whose net diff against main is empty.

## 6. Compared with git

- **git would have been better:**
  - Handover: with git, `git fetch` failing would have been an explicit error rather than a quiet "up to date with main #1". I would have seen a3's commit before writing anything.
  - Conflict resolution: `git checkout --theirs` / `git reset` are well-understood; hs's restore semantics around auto-commits tripped me.
- **hs was better:**
  - `land --check` combines rebase, test on the merged tree, and push in one step, and gives an immediate `final`. With 5 agents landing in parallel on a shared git branch I would have hit non-fast-forward pushes, done manual `pull --rebase`, and re-run tests by hand.
  - Per-file rebases plus the union merge on NOTES.md meant the busy shared files (NOTES, CONTRACTS) never conflicted.
  - `hs watch --count 1` for blocking waits is nicer than polling `git fetch`.
- **Overall:** for the steady-state loop hs is a bit better. For the takeover/startup moment it was worse.

## 7. Features wanted

- A loud warning, or a non-zero exit, when `sync` finds no peers (for example "main may be ahead; nothing fetched").
- A watcher that keeps retrying discovery.
- `hs restore --from main <path>` (or `hs sync --theirs <path>`) to take main's version.
- `-m` on `commit`.
- An `hs log --author a3` view for a takeover: what did the dead agent land and propose?

```json
{
  "agent": "a3b",
  "usefulness_vs_git": 3,
  "would_choose_hs_over_git_for_this": false,
  "lands_attempted": 2,
  "auto_rebases": 1,
  "real_conflicts": 1,
  "flips_seen": 0,
  "stalls_or_unavailable": 2,
  "used_watch_feed": true,
  "times_others_work_changed_my_plan": 3,
  "proposals_made": 0,
  "reviews_given": 0,
  "review_usefulness": 0,
  "output_clarity": 3,
  "knew_when_my_land_was_safe": 5,
  "confusing_messages": 4,
  "minutes_lost_to_hs": 20,
  "biggest_win": "land --check: rebase + test on merged tree + push + 'final' in one step; never had a broken main",
  "biggest_friction": "initial 'no peers found ... up to date with main #1' while the holder had #14, so I rewrote a3's already-landed scheduler and then had to untangle a conflict that restore would not discard",
  "most_wanted_feature": "sync/watch must fail loudly (and keep retrying) when no peer is reachable instead of reporting 'up to date'"
}
```
