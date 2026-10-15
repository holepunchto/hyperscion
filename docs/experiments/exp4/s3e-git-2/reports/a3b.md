# a3b report (git arm), took over the scheduler from a3

## 1. What I built

- Took over `src/scheduler.js` and `test/scheduler.test.js` from a3. a3 had already landed a good greedy
  insertion scheduler (a0c9400) and pinned the Plan shape (c4e58db). I kept the shape unchanged.
- 8c1810d: **idle-gap filling.** A drone's trips all stay open to insertion as long as they still fit before
  the drone's next trip, and a new trip can be opened in any idle gap, for example while a later launch is
  delayed for a window. Before, only the last trip was open. This fixed a5's busy-day note: 2 fewer
  unassigned packages.
- Also in 8c1810d: wired in a2's `geo.improveRoute` as a final 2-opt pass. Its result is re-checked by the
  scheduler's own simulation before it is accepted. I removed the haversine shim, now that geo has landed.
  `unassigned` is now listed in day-file order, and CONTRACTS.md is updated to match.
- Added 8 tests: gap filling, range limits on batching, a window missed because the drone is busy, no
  drones, `unassigned` order, `loadDay` input equal to raw input, invariants on all edge fixtures, and a
  seeded random test (40 days) checking every invariant.
- Notes: the takeover line (2b90425) and the report double-rounding bug for a4 (27c62d0). a4 fixed it in
  7dbdf96.
- End state: main 7dbdf96 + 136ab2f, 68 tests passing (0 todo/skip). `node src/cli.js plan
  fixtures/day1.json` delivers 18 of 19 packages; p19 is "too heavy for every drone".

## 2. How I learned about teammates' work

- `git fetch -q && git log --oneline --stat HEAD..origin/main` was my main view: about 10 times. After that I
  used `git diff <old> <new> -- NOTES.md | grep '^+'` to read only the new NOTES lines, which was the most
  useful single command.
- I read files at HEAD after pulling (`cat CONTRACTS.md`, `NOTES.md`, `src/scheduler.js`, `src/geo.js`,
  `src/report.js`).
- I used the bounded fetch loop from the playbook 4 times: once while origin was down, three times waiting
  for teammates. Polling took about 12 minutes of wall time, but little of my attention. When idle there is
  no way to know if anyone will push again, so the final wait was a pure timeout.

## 3. Moments where teammates' pushed work changed what I did

- **The biggest one was negative.** At start, origin was unreachable (`fatal: '.../origin.git' does not
  appear to be a git repository`). My clone only had the skeleton (b82fb1c), so I concluded "nothing of
  a3's landed". I wrote a complete scheduler, tests and a Plan contract, and committed it. When origin came
  back, `git log HEAD..origin/main` showed a3's a0c9400 and c4e58db, plus a5's integration test (269b1ab)
  already built against a3's shape. I threw my work away (`git branch mine-backup; git reset --hard
  origin/main`) and adopted a3's. About 10 minutes were wasted. I nearly also pushed a conflicting second
  Plan contract.
- ecea67f plus a2's NOTES line: a2 offered `improveRoute` and said the shim could go. I wired it in and
  removed the shim (8c1810d).
- 263af89 plus a5's NOTES line: the busy-day fixture showed s1 idle from 19.67 to 45.99. That led to the
  gap-filling change in 8c1810d. a5 then pinned `minDelivered=7` (681e53e).
- a904117 (a4's report): from the CLI output I found the end-time double rounding and noted it (27c62d0).
  a2 noted the same bug in parallel (7388833), which was duplicate work. a5 added a todo test (f9b078c), and
  a4 fixed it (7dbdf96).
- 98df682: a2 made geo accept my normalized `{dest}` packages in response to my note. I already passed
  `{destination}` wrappers, so I needed no change.

## 4. Conflicts, rejected pushes, rebases

- 3 pushes to main, 0 rejected.
- 3 pulls rebased my commit onto new teammate commits (over 4fdf565, over cedc8c1, and over 7388833/bcd0eeb).
  All were clean. NOTES.md union merge meant concurrent appends never conflicted.
- 0 real conflicts. My own files were not touched by anyone else.

## 5. Friction and confusing output

- The origin outage message `fatal: '<path>/origin.git' does not appear to be a git repository ... Please
  make sure you have the correct access rights and the repository exists.` is generic. More importantly, git
  happily lets you keep working on a stale view with no hint about how stale it is. `git status -sb`
  printed `## main...origin/main` (looks "up to date") while origin actually had 12 newer commits. This was
  the costly confusion.
- `git pull -q` hides whether it rebased, so I could not tell from my own output whether my commit had
  moved.
- There is no feed: "has anyone answered me?" requires fetching plus diffing NOTES.md by hand.
- Duplicate effort (a2 and I reporting the same bug within a minute) is invisible until after both pushes.

## 6. Compared with an ideal tool

- **Takeover:** an ideal tool would show the handover state explicitly: what a3 landed, what a3 had
  in-flight or unpushed, and which messages addressed a3. With git I had to infer all of that, and during
  the outage I inferred wrong. It should also say "your view is N minutes old, origin unreachable" instead
  of showing a status that looks up to date.
- **Feed:** a push-based feed of commits and NOTES lines filtered by "mentions me or touches my files"
  would replace the fetch loops.
- **Duplicate detection:** when someone is already writing about the same bug or file, show "a2 is
  working on this".
- **Contract changes:** CONTRACTS.md sections should be tied to their owners with notification on change,
  rather than relying on people reading diffs.

## 7. Features wanted

- A staleness indicator ("last successful fetch: 2 min ago; origin unreachable").
- `git log` filtered to "NOTES lines mentioning me since my last read".
- A blocking `wait-for` (path or mention) with server push instead of sleep loops.
- A presence/claim marker: "a2 is editing report.js / investigating X".
- A handover view for a departed teammate: their landed commits, unpushed work (lost here), and open asks.

## 8. JSON

```json
{
  "agent": "a3b",
  "usefulness_vs_git": 3,
  "would_choose_hs_over_git_for_this": false,
  "lands_attempted": 3,
  "auto_rebases": 3,
  "real_conflicts": 0,
  "flips_seen": 0,
  "stalls_or_unavailable": 1,
  "used_watch_feed": false,
  "times_others_work_changed_my_plan": 5,
  "proposals_made": 0,
  "reviews_given": 0,
  "review_usefulness": 0,
  "output_clarity": 3,
  "knew_when_my_land_was_safe": 4,
  "confusing_messages": 2,
  "minutes_lost_to_hs": 14,
  "biggest_win": "NOTES.md union merge + pull.rebase: 3 rebases, 0 conflicts, and NOTES diffs worked as a usable message board (a2/a4/a5 acted on my notes within minutes)",
  "biggest_friction": "origin outage at takeover: my clone showed only the skeleton and status looked up to date, so I rebuilt a scheduler a3 had already landed (~10 min wasted, nearly pushed a competing Plan contract)",
  "most_wanted_feature": "staleness/handover view: 'origin unreachable, view N min old' plus what the departed teammate landed, left in flight, and was asked"
}
```
